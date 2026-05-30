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
} from 'antigravity-client/dist/src/gen/exa/language_server_pb/language_server_pb.js';
import { McpHub } from './mcp-hub.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
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

    // Write .mcp.json to workspace root BEFORE LS launches so it
    // discovers the proxy on startup (avoids LS internal caching issues)
    await this.#writeMcpConfigToWorkspace();

    console.log('[Backend] Launching Antigravity Language Server...');
    try {
      this.client = await AntigravityClient.launch({
        workspacePath: process.cwd(),
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
      const workspaceMcpPath = join(process.cwd(), '.mcp.json');
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
      const isToolResult =
        lastUserMessage.role === 'user' &&
        Array.isArray(lastUserMessage.content) &&
        lastUserMessage.content.some((b: any) => b.type === 'tool_result');

      // ── Tool result continuation ──────────────────────────────
      if (isToolResult) {
        const toolResultBlock = (lastUserMessage.content as any[]).find(
          (b: any) => b.type === 'tool_result',
        );
        if (toolResultBlock) {
          const { tool_use_id, content, is_error } = toolResultBlock;
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
          yield { type: 'turn_end', sessionId, stopReason: 'tool_use' };
          return;
        }

        // idle — collect text from new steps only
        const collected = this.collectTextFromSteps(cascade, turnStartCount);
        if (collected) {
          yield { type: 'stream_event', sessionId, event: { type: 'content', value: collected } };
        }
        yield { type: 'turn_end', sessionId, stopReason: 'end_turn' };
        return;
      }

      // ── New message (user text, possibly with tools) ──────────
      let userText = typeof lastUserMessage.content === 'string'
        ? lastUserMessage.content
        : lastUserMessage.content.map((b: any) => b.text || '').filter(Boolean).join('\n');

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

      const text = extraContexts.length > 0
        ? `=== SYSTEM CONTEXT ===\n${extraContexts.join('\n')}\n======================\n\n=== USER INSTRUCTION ===\n${userText}`
        : userText;

      console.log(`[Backend] Sending message (MCP proxy enabled), text_length=${text.length}, model=${request.model}`);

      const startStepCount = cascade.state?.trajectory?.steps?.length ?? 0;

      await this.sendMessage(cascade, text, request.model, apiKey);
      const turn = await this.waitForTurnOrToolCall(cascade);

      if (turn === 'tool_call') {
        for (const call of this.mcpHub.getPendingCalls()) {
          yield { type: 'tool_call', sessionId, callId: call.callId, name: call.name, args: call.args };
        }
        yield { type: 'turn_end', sessionId, stopReason: 'tool_use' };
        return;
      }

      // idle — collect text
      const collected = this.collectTextFromSteps(cascade, startStepCount);
      if (collected) {
        yield { type: 'stream_event', sessionId, event: { type: 'content', value: collected } };
      }
      yield { type: 'turn_end', sessionId, stopReason: 'end_turn' };
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
  }
}

export const antigravityBackend = new AntigravityBackend();
