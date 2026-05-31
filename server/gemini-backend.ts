/**
 * Antigravity Backend Implementation
 *
 * Manages the lifecycle of the Antigravity Language Server (LS)
 * and provides a bridge between Claude API requests and Antigravity Cascades.
 */

import { AntigravityClient, readAuthStatus } from 'antigravity-client';
import {
  TextOrScopeItem, ModelOrAlias, Metadata,
} from 'antigravity-client/dist/src/gen/exa/codeium_common_pb/codeium_common_pb.js';
import {
  CascadeConfig, CascadePlannerConfig, CascadeConversationalPlannerConfig,
  CascadeToolConfig,
  RunCommandToolConfig, SearchWebToolConfig, MemoryToolConfig, McpToolConfig,
  MqueryToolConfig, FindToolConfig, GenerateImageToolConfig, TrajectorySearchToolConfig,
  AntigravityBrowserToolConfig, BrowserSubagentToolConfig, InvokeSubagentToolConfig,
  NotebookEditToolConfig, AskQuestionToolConfig, ReadKnowledgeBaseItemToolConfig,
  WorkspaceAPIToolConfig, SuggestedResponseConfig,
} from 'antigravity-client/dist/src/gen/exa/cortex_pb/cortex_pb.js';
import {
  SendUserCascadeMessageRequest,
  RefreshMcpServersRequest,
  RevertToCascadeStepRequest,
  GetCascadeTrajectoryGeneratorMetadataRequest,
} from 'antigravity-client/dist/src/gen/exa/language_server_pb/language_server_pb.js';
import { McpHub } from './mcp-hub.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { extractSystemPrompt } from './converters/request.js';
import type { ClaudeMessage, ClaudeToolDefinition, BridgeMessage } from './types.js';

export class GeminiApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'GeminiApiError';
  }
}

export class AntigravityBackend {
  private client: (AntigravityClient & { launcher?: any }) | null = null;
  private cascades = new Map<string, any>(); // sessionId -> Cascade
  private workspaceDir: string | null = null;
  /** Singleton: all tools disabled */
  private static disabledToolConfig: CascadeToolConfig | null = null;
  /** MCP proxy hub (tool registry) */
  public readonly mcpHub: McpHub = new McpHub();
  private lastRegisteredToolsHash = '';

  async initialize(): Promise<void> {
    if (this.client) return;

    // Start the MCP Hub first so we know the port before LS starts
    try {
      await this.mcpHub.start();
      console.log(`[Backend] McpHub started on port ${this.mcpHub.port}`);
    } catch (error) {
      console.error('[Backend] Failed to start McpHub:', error);
    }

    if (!this.workspaceDir) {
      this.workspaceDir = join(tmpdir(), `claude2gemini_workspace_${process.pid}_${Date.now()}`);
      await mkdir(this.workspaceDir, { recursive: true });
    }

    // Write .mcp.json to workspace root BEFORE LS launches so it
    // discovers the proxy on startup (avoids LS internal caching issues)
    await this.#writeMcpConfigToWorkspace();

    console.log('[Backend] Launching Antigravity Language Server...');
    try {
      this.client = await AntigravityClient.launch({
        workspacePath: this.workspaceDir!,
        verbose: process.env.VERBOSE === 'true',
      });
      console.log('[Backend] Antigravity LS launched successfully.');
    } catch (error) {
      console.error('[Backend] Failed to launch Antigravity LS:', error);
      throw error;
    }

    // Refresh MCP servers to ensure proxy is recognized
    await this.#refreshMcpProxyOnLS();
  }

  /**
   * Write .mcp.json to the workspace root BEFORE LS starts, so the LS
   * discovers the proxy on initialization. Also writes to gemini_dir
   * after LS is up as a fallback.
   */
  async #writeMcpConfigToWorkspace(): Promise<void> {
    try {
      const workspaceMcpPath = join(this.workspaceDir!, '.mcp.json');
      const mcpConfig = {
        mcpServers: {
          'claude2gemini-mcp-proxy': {
            command: process.execPath,
            args: [
              new URL('./mcp-proxy.mjs', import.meta.url).pathname,
              '--hub-port',
              String(this.mcpHub.port),
            ],
          }
        }
      };
      await writeFile(workspaceMcpPath, JSON.stringify(mcpConfig, null, 2), 'utf-8');
      console.log(`[Backend] MCP spec written to ${workspaceMcpPath}`);
    } catch (error) {
      console.warn('[Backend] Failed to write workspace .mcp.json:', error);
    }
  }

  /**
   * After LS is running, write mcp_config.json to gemini_dir and call
   * refreshMcpServers so the LS discovers the proxy subprocess.
   */
  async #refreshMcpProxyOnLS(): Promise<void> {
    if (!this.client) return;

    const workspaceId = this.client.launcher?.workspaceId;
    if (workspaceId) {
      const geminiDir = join(tmpdir(), `gemini_${workspaceId}`);
      const configDir = join(geminiDir, 'config');
      const mcpConfigPath = join(configDir, 'mcp_config.json');
      try {
        await mkdir(configDir, { recursive: true });
        const mcpConfig = {
          mcpServers: {
            'claude2gemini-mcp-proxy': {
              command: process.execPath,
              args: [
                new URL('./mcp-proxy.mjs', import.meta.url).pathname,
                '--hub-port',
                String(this.mcpHub.port),
              ],
            }
          }
        };
        await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), 'utf-8');
      } catch { /* best-effort */ }
    }

    try {
      await this.client.lsClient.refreshMcpServers(
        new RefreshMcpServersRequest({ shallow: false, serverName: 'claude2gemini-mcp-proxy' }),
      );
      console.log('[Backend] MCP proxy registered with LS (refreshMcpServers OK)');
    } catch (error: any) {
      console.warn('[Backend] refreshMcpServers failed:', error);
    }
  }

  /**
   * Build a CascadeToolConfig that disables every built-in Antigravity tool
   * EXCEPT MCP, which is needed for the proxy-based tool execution flow.
   */
  private static createToolConfig(): CascadeToolConfig {
    if (AntigravityBackend.disabledToolConfig) {
      return AntigravityBackend.disabledToolConfig;
    }
    AntigravityBackend.disabledToolConfig = new CascadeToolConfig({
      // Tools with forceDisable
      runCommand:  new RunCommandToolConfig({ forceDisable: true }),
      searchWeb:   new SearchWebToolConfig({ forceDisable: true }),
      memory:      new MemoryToolConfig({ forceDisable: true }),
      // MCP is ENABLED for our proxy-based tool delegation
      mcp:         new McpToolConfig({ forceDisable: false, maxOutputBytes: 1_000_000 }),
      mquery:      new MqueryToolConfig({ forceDisable: true }),
      find:        new FindToolConfig({ forceDisable: true }),
      generateImage: new GenerateImageToolConfig({ forceDisable: true }),
      trajectorySearch: new TrajectorySearchToolConfig({ forceDisable: true }),
      suggestedResponse: new SuggestedResponseConfig({ forceDisable: true }),
      // Tools controlled via enabled/readOnly
      antigravityBrowser: new AntigravityBrowserToolConfig({ enabled: false }),
      browserSubagent:    new BrowserSubagentToolConfig({ disableScreenshot: true }),
      invokeSubagent:     new InvokeSubagentToolConfig({ enabled: false }),
      notebookEdit:       new NotebookEditToolConfig({ enabled: false }),
      askQuestion:        new AskQuestionToolConfig({ enabled: false }),
      readKnowledgeBaseItem: new ReadKnowledgeBaseItemToolConfig({ enabled: false }),
      workspaceApi:       new WorkspaceAPIToolConfig({ readOnly: true }),
      // Global flag for simple research tools
      disableSimpleResearchTools: true,
    });
    return AntigravityBackend.disabledToolConfig;
  }

  /**
   * Send a message via sendUserCascadeMessage with our selective tool config.
   */
  private async sendMessage(
    cascade: any,
    text: string,
    modelName: string,
    apiKey: string,
  ): Promise<void> {
    const toolConfig = AntigravityBackend.createToolConfig();

    const metadata = new Metadata({
      apiKey,
      ideName: 'vscode',
      ideVersion: '1.107.0',
      extensionName: 'antigravity',
      extensionVersion: '0.2.0',
    });

    const modelId = await this.client!.resolveModelId(modelName || '');

    const req = new SendUserCascadeMessageRequest({
      cascadeId: cascade.cascadeId,
      metadata,
      items: [
        new TextOrScopeItem({
          chunk: { case: 'text', value: text },
        }),
      ],
      cascadeConfig: new CascadeConfig({
        plannerConfig: new CascadePlannerConfig({
          toolConfig,
          plannerTypeConfig: {
            case: 'conversational',
            value: new CascadeConversationalPlannerConfig({
              plannerMode: 1, // DEFAULT
            }),
          },
          requestedModel: new ModelOrAlias({
            choice: { case: 'model', value: modelId },
          }),
        }),
      }),
      blocking: false,
      clientType: 1, // IDE
    });

    await this.client!.lsClient.sendUserCascadeMessage(req);
  }

  /**
   * Fetch token usage statistics from the LS after a turn completes.
   * Best-effort: returns undefined if the RPC fails or no metadata is available.
   */
  async #fetchUsage(cascade: any): Promise<{
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    context_window_estimated_tokens?: number;
  } | undefined> {
    if (!this.client) return undefined;
    try {
      const resp = await this.client.lsClient.getCascadeTrajectoryGeneratorMetadata(
        new GetCascadeTrajectoryGeneratorMetadataRequest({
          cascadeId: cascade.cascadeId,
        }),
      );
      const metas = resp.generatorMetadata;
      if (!metas || metas.length === 0) return undefined;
      // Use the last generator metadata entry (latest turn)
      const last = metas[metas.length - 1];
      // chatModel is inside a "metadata" oneof: { case: "chatModel", value: ChatModelMetadata }
      const chatModel = last.metadata?.case === 'chatModel' ? last.metadata.value : undefined;
      if (!chatModel?.usage) return undefined;
      const usage = chatModel.usage;
      const result: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
        context_window_estimated_tokens?: number;
      } = {
        input_tokens: Number(usage.inputTokens),
        output_tokens: Number(usage.outputTokens),
      };
      if (Number(usage.cacheReadTokens) > 0) {
        result.cache_read_input_tokens = Number(usage.cacheReadTokens);
      }
      if (Number(usage.cacheWriteTokens) > 0) {
        result.cache_creation_input_tokens = Number(usage.cacheWriteTokens);
      }
      // Also prefer context_window_estimated_tokens from ChatStartMetadata if available
      const ctxMeta = chatModel.chatStartMetadata?.contextWindowMetadata;
      if (ctxMeta?.estimatedTokensUsed !== undefined &&
          ctxMeta.estimatedTokensUsed !== null) {
        result.context_window_estimated_tokens = Number(ctxMeta.estimatedTokensUsed);
      }
      return result;
    } catch (e) {
      console.warn('[Backend] Failed to fetch usage metadata (non-fatal):', e);
      return undefined;
    }
  }

  /**
   * Collect text from the cascade's trajectory steps that were added after
   * `startStepCount`.
   */
  private collectTextFromSteps(cascade: any, startStepCount: number): string {
    const steps = cascade.state?.trajectory?.steps ?? [];
    const parts: string[] = [];
    for (let i = startStepCount; i < steps.length; i++) {
      const step = steps[i];
      if (!step) continue;
      if (step.step?.case !== 'plannerResponse') continue;
      const planner = step.step.value as any;
      const response = planner.modifiedResponse || planner.response || '';
      if (response) parts.push(response);
    }
    return parts.join('');
  }

  /**
   * Wait for the next turn to complete OR a tool call to arrive, whichever
   * happens first. Uses the Cascade's event-driven waitForTurnComplete()
   * raced against an McpHub event notification.
   */
  private async waitForTurnOrToolCall(
    cascade: any,
    timeoutMs = 120_000,
  ): Promise<'idle' | 'tool_call'> {
    // If a tool call is already pending, return immediately
    if (this.mcpHub.hasPendingCalls()) return 'tool_call';

    return new Promise<'idle' | 'tool_call'>((resolve) => {
      let settled = false;

      // Listen for McpHub tool call events
      const onPending = () => {
        if (!settled) { settled = true; cleanup(); resolve('tool_call'); }
      };
      this.mcpHub.on('pending_call', onPending);

      // Use the cascade's event-driven idle waiter
      cascade.waitForTurnComplete({ timeoutMs })
        .then(() => {
          if (!settled) { settled = true; cleanup(); resolve('idle'); }
        })
        .catch(() => {
          if (!settled) { settled = true; cleanup(); resolve('idle'); }
        });

      const cleanup = () => {
        this.mcpHub.off('pending_call', onPending);
      };
    });
  }

  /**
   * Creates an asynchronous stream of bridge messages for a given session.
   *
   * Tools from the request are registered with McpHub so the LS can discover
   * them via the MCP proxy. Tool calls from the LS are forwarded to the
   * external client as tool_use bridge messages — execution happens in the
   * client, and results come back in a subsequent request.
   */
  async *createMessageStream(
    sessionId: string,
    request: {
      model: string;
      messages: ClaudeMessage[];
      system?: any;
      tools?: ClaudeToolDefinition[];
    }
  ): AsyncGenerator<BridgeMessage> {
    if (!this.client) await this.initialize();

    const { messages, tools } = request;
    
    // Find the last user message in the messages chain
    let lastUserMsgIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserMsgIdx = i;
        break;
      }
    }
    const lastUserMessage = lastUserMsgIdx !== -1 ? messages[lastUserMsgIdx] : null;
    if (!lastUserMessage) {
      throw new Error('No user message found in request');
    }

    let cascade = this.cascades.get(sessionId);

    if (!cascade) {
      cascade = await this.client!.startCascade();
      this.cascades.set(sessionId, cascade);
      console.log(`[Backend] New cascade created: ${cascade.cascadeId}`);

      // Auto-approve any interactive prompts from the LS (permissions, commands)
      cascade.on('interaction', (event: any) => {
        if (event.needsApproval) {
          console.log(`[Backend] Auto-approving cascade interaction: index=${event.stepIndex}, cmd=${event.commandLine || 'none'}`);
          event.approve('once').catch((err: any) => {
            console.error('[Backend] Auto-approve failed:', err);
          });
        }
      });
    }

    // Register tools from the request with McpHub (for MCP tools/list)
    if (tools && tools.length > 0) {
      this.mcpHub.setTools(tools);
      const toolsHash = JSON.stringify(tools);
      if (this.lastRegisteredToolsHash !== toolsHash) {
        this.lastRegisteredToolsHash = toolsHash;
        // Refresh MCP servers so LS re-reads the tool list and writes JSON definitions
        await this.#refreshMcpProxyOnLS();
      }
    }

    // Resolve API key for Metadata
    const apiKey = process.env.ANTIGRAVITY_API_KEY || readAuthStatus()?.apiKey || '';

    try {
      // 1. Build client turns (excluding the current last message and tool results messages)
      interface ClientTurn {
        userText: string;
        assistantText: string;
      }
      const clientTurns: ClientTurn[] = [];
      let currentUserText = '';
      for (let i = 0; i < messages.length - 1; i++) {
        const msg = messages[i];
        if (msg.role === 'user') {
          const content = msg.content;
          const isToolResult = Array.isArray(content) && content.every((b: any) => b.type === 'tool_result');
          if (!isToolResult) {
            currentUserText = typeof content === 'string'
              ? content
              : content.map((b: any) => b.text || '').filter(Boolean).join('\n');
          }
        } else if (msg.role === 'assistant' && currentUserText) {
          const assistantText = typeof msg.content === 'string'
            ? msg.content
            : msg.content.map((b: any) => b.text || '').filter(Boolean).join('\n');
          clientTurns.push({
            userText: currentUserText,
            assistantText: assistantText,
          });
          currentUserText = '';
        }
      }

      // Helper function to extract user input text from step
      const getUserInputText = (step: any): string => {
        if (step?.step?.case === 'userInput') {
          const value = step.step.value;
          if (value.userResponse) return value.userResponse;
          if (Array.isArray(value.items)) {
            return value.items
              .map((item: any) => item.chunk?.case === 'text' ? item.chunk.value : '')
              .filter(Boolean)
              .join('\n');
          }
        }
        return '';
      };

      // 2. Build cascade user turns
      const cascadeUserTurns: { stepIndex: number; text: string }[] = [];
      const steps = cascade.state?.trajectory?.steps ?? [];
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (step?.step?.case === 'userInput') {
          const text = getUserInputText(step);
          cascadeUserTurns.push({ stepIndex: i, text });
        }
      }

      // 3. Detect first mismatch index
      let mismatchIdx = -1;
      const compareLen = Math.min(cascadeUserTurns.length, clientTurns.length);
      for (let i = 0; i < compareLen; i++) {
        const cascadeText = cascadeUserTurns[i].text;
        const clientText = clientTurns[i].userText;
        const normalizedCascade = cascadeText.replace(/\s+/g, '');
        const normalizedClient = clientText.replace(/\s+/g, '');
        if (!normalizedCascade.includes(normalizedClient) && !normalizedClient.includes(normalizedCascade)) {
          mismatchIdx = i;
          break;
        }
      }
      if (mismatchIdx === -1 && cascadeUserTurns.length > clientTurns.length) {
        mismatchIdx = clientTurns.length;
      }

      // 4. Revert or re-create cascade if mismatch is detected
      if (mismatchIdx !== -1) {
        const metadata = new Metadata({
          apiKey,
          ideName: 'vscode',
          ideVersion: '1.107.0',
          extensionName: 'antigravity',
          extensionVersion: '0.2.0',
        });

        if (mismatchIdx === 0) {
          console.log(`[Backend] History mismatch at turn 0. Re-creating cascade.`);
          this.cascades.delete(sessionId);
          cascade = await this.client!.startCascade();
          this.cascades.set(sessionId, cascade);
          cascade.on('interaction', (event: any) => {
            if (event.needsApproval) {
              console.log(`[Backend] Auto-approving cascade interaction: index=${event.stepIndex}, cmd=${event.commandLine || 'none'}`);
              event.approve('once').catch((err: any) => {
                console.error('[Backend] Auto-approve failed:', err);
              });
            }
          });
          cascadeUserTurns.splice(0);
        } else {
          const revertStepIndex = cascadeUserTurns[mismatchIdx].stepIndex - 1;
          console.log(`[Backend] History mismatch at turn ${mismatchIdx}. Reverting cascade to step ${revertStepIndex}.`);
          const req = new RevertToCascadeStepRequest({
            cascadeId: cascade.cascadeId,
            stepIndex: revertStepIndex,
            metadata,
          });
          await this.client!.lsClient.revertToCascadeStep(req);
          cascadeUserTurns.splice(mismatchIdx);
        }

        // Clear any pending MCP tool calls as they are no longer valid after a rewind
        this.mcpHub.clearPendingCalls('Cascade history mismatch (rewind) cancelled this tool call');
      }

      // 5. Construct conversation history prefix for missing turns
      let historyPrefix = '';
      const startFeedIdx = mismatchIdx !== -1 ? mismatchIdx : cascadeUserTurns.length;
      if (startFeedIdx < clientTurns.length) {
        historyPrefix += '=== CONVERSATION HISTORY ===\n';
        for (let i = startFeedIdx; i < clientTurns.length; i++) {
          historyPrefix += `User: ${clientTurns[i].userText}\n\nAssistant: ${clientTurns[i].assistantText}\n\n`;
        }
        historyPrefix += '============================\n\n';
      }

      const systemPrompt = extractSystemPrompt(request.system);

      // 6. Check if current message is a tool result and check for waiting state
      const isToolResult =
        lastUserMessage.role === 'user' &&
        Array.isArray(lastUserMessage.content) &&
        lastUserMessage.content.some((b: any) => b.type === 'tool_result');

      const toolResultBlocks = isToolResult
        ? (lastUserMessage.content as any[]).filter((b: any) => b.type === 'tool_result')
        : [];

      const isWaitingForThisTool = toolResultBlocks.some((b) =>
        this.mcpHub.getPendingCalls().some((c) => c.callId === b.tool_use_id)
      );

      // ── Tool result continuation ──────────────────────────────
      if (isToolResult && isWaitingForThisTool) {
        for (const block of toolResultBlocks) {
          const { tool_use_id, content, is_error } = block;
          const mcpResult = {
            content: [{
              type: 'text',
              text: typeof content === 'string' ? content : JSON.stringify(content),
            }],
            isError: !!is_error,
          };
          try {
            await this.mcpHub.resolveCall(tool_use_id, mcpResult);
          } catch {
            // callId not in hub — first message in a new cascade, proceed
          }
        }

        // Wait for the cascade to generate the next response (tool result processed).
        const turnStartCount = cascade.state?.trajectory?.steps?.length ?? 0;
        const turn = await this.waitForTurnOrToolCall(cascade);
        if (turn === 'tool_call') {
          for (const call of this.mcpHub.getPendingCalls()) {
            yield { type: 'tool_call', sessionId, callId: call.callId, name: call.name, args: call.args };
          }
          const usage1 = await this.#fetchUsage(cascade);
          yield { type: 'turn_end', sessionId, stopReason: 'tool_use', usage: usage1 };
          return;
        }

        // idle — collect text from new steps only
        const collected = this.collectTextFromSteps(cascade, turnStartCount);
        if (collected) {
          yield { type: 'stream_event', sessionId, event: { type: 'content', value: collected } };
        }
        const usage1 = await this.#fetchUsage(cascade);
        yield { type: 'turn_end', sessionId, stopReason: 'end_turn', usage: usage1 };
        return;
      }

      // ── New message (user text, possibly with tools or tool fallback) ──────────
      let userText = '';
      if (isToolResult && !isWaitingForThisTool && toolResultBlocks.length > 0) {
        // Fallback: tool result received but cascade is not waiting for it
        userText = toolResultBlocks.map(b => {
          const { tool_use_id, content, is_error } = b;
          const contentText = typeof content === 'string' ? content : JSON.stringify(content);
          return `=== TOOL RESULT ===\nTool Use ID: ${tool_use_id}\nIs Error: ${!!is_error}\nResult:\n${contentText}\n===================`;
        }).join('\n\n');
      } else {
        userText = typeof lastUserMessage.content === 'string'
          ? lastUserMessage.content
          : lastUserMessage.content.map((b: any) => b.text || '').filter(Boolean).join('\n');
      }

      // Append any subsequent system or non-assistant messages as context
      const extraContexts: string[] = [];
      for (let i = lastUserMsgIdx + 1; i < messages.length; i++) {
        const msg = messages[i];
        if ((msg.role as string) === 'system' || msg.role === 'user') {
          const contentText = typeof msg.content === 'string'
            ? msg.content
            : msg.content.map((b: any) => b.text || '').filter(Boolean).join('\n');
          if (contentText) {
            extraContexts.push(contentText);
          }
        }
      }

      let text = '';
      if (systemPrompt) {
        text += `=== SYSTEM PROMPT ===\n${systemPrompt}\n=====================\n\n`;
      }
      if (historyPrefix) {
        text += historyPrefix;
      }
      if (extraContexts.length > 0) {
        text += `=== SYSTEM CONTEXT ===\n${extraContexts.join('\n')}\n======================\n\n`;
      }
      text += `=== USER INSTRUCTION ===\n${userText}`;

      console.log(`[Backend] Sending message (MCP proxy enabled), text_length=${text.length}, model=${request.model}`);

      const startStepCount = cascade.state?.trajectory?.steps?.length ?? 0;

      await this.sendMessage(cascade, text, request.model, apiKey);
      const turn = await this.waitForTurnOrToolCall(cascade);

      if (turn === 'tool_call') {
        for (const call of this.mcpHub.getPendingCalls()) {
          yield { type: 'tool_call', sessionId, callId: call.callId, name: call.name, args: call.args };
        }
        const usage2 = await this.#fetchUsage(cascade);
        yield { type: 'turn_end', sessionId, stopReason: 'tool_use', usage: usage2 };
        return;
      }

      // idle — collect text
      const collected = this.collectTextFromSteps(cascade, startStepCount);
      if (collected) {
        yield { type: 'stream_event', sessionId, event: { type: 'content', value: collected } };
      }
      const usage2 = await this.#fetchUsage(cascade);
      yield { type: 'turn_end', sessionId, stopReason: 'end_turn', usage: usage2 };
    } catch (error) {
      console.error('[Backend] Stream error:', error);
      yield { type: 'error', sessionId, message: String(error) };
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.mcpHub.stop();
    } catch (e) {
      console.error('[Backend] McpHub shutdown error:', e);
    }
    if (this.client) {
      console.log('[Backend] Shutting down Antigravity LS...');
      try {
        this.client.dispose();
        if (this.client.launcher) {
          await this.client.launcher.stop();
        }
      } catch (e) {
        console.error('[Backend] Shutdown error:', e);
      }
      this.client = null;
    }

    if (this.workspaceDir) {
      try {
        await rm(this.workspaceDir, { recursive: true, force: true });
      } catch (e) {
        console.error('[Backend] Failed to remove temp workspace dir:', e);
      }
      this.workspaceDir = null;
    }
  }
}

export const antigravityBackend = new AntigravityBackend();
