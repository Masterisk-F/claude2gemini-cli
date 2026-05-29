/**
 * Antigravity Backend Implementation
 *
 * Manages the lifecycle of the Antigravity Language Server (LS)
 * and provides a bridge between Claude API requests and Antigravity Cascades.
 *
 * NOTE: All Antigravity built-in tools are disabled when sending messages,
 * since this project delegates tool execution to its own MCP mechanism.
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
import { SendUserCascadeMessageRequest } from 'antigravity-client/dist/src/gen/exa/language_server_pb/language_server_pb.js';
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

  async initialize(): Promise<void> {
    if (this.client) return;

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
  }

  /**
   * Build a CascadeToolConfig that explicitly disables every tool Antigravity LS
   * knows about. Tools that lack a `forceDisable` field are simply omitted from
   * the config (the LS falls back to its internal defaults, which we cannot
   * control from the client side).
   */
  private static createDisabledToolConfig(): CascadeToolConfig {
    if (AntigravityBackend.disabledToolConfig) {
      return AntigravityBackend.disabledToolConfig;
    }
    AntigravityBackend.disabledToolConfig = new CascadeToolConfig({
      // Tools with forceDisable
      runCommand:  new RunCommandToolConfig({ forceDisable: true }),
      searchWeb:   new SearchWebToolConfig({ forceDisable: true }),
      memory:      new MemoryToolConfig({ forceDisable: true }),
      mcp:         new McpToolConfig({ forceDisable: true }),
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
   * Send a message directly via sendUserCascadeMessage with all tools disabled,
   * bypassing Cascade.sendMessage() which has no toolConfig injection point.
   *
   * After calling this, wait for the cascade to finish with
   * `cascade.waitForTurnComplete()` and collect text from `cascade.state`.
   */
  private async sendMessageWithDisabledTools(
    cascade: any,
    text: string,
    modelName: string,
    apiKey: string,
  ): Promise<void> {
    const toolConfig = AntigravityBackend.createDisabledToolConfig();

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
   * Creates an asynchronous stream of bridge messages for a given session.
   *
   * Unlike cascade.run(), this sends the message via sendUserCascadeMessage
   * directly so we can inject a CascadeToolConfig that disables all built-in
   * Antigravity tools. Text is collected from cascade.state after the turn
   * completes.
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

    const { messages } = request;
    const lastMessage = messages[messages.length - 1];

    let cascade = this.cascades.get(sessionId);

    if (!cascade) {
      cascade = await this.client!.startCascade();
      this.cascades.set(sessionId, cascade);
      console.log(`[Backend] New cascade created: ${cascade.cascadeId}`);
    }

    // Resolve API key for Metadata (same logic as antigravity-client internals)
    const apiKey = process.env.ANTIGRAVITY_API_KEY || readAuthStatus()?.apiKey || '';

    try {
      const isToolResult =
        lastMessage.role === 'user' &&
        Array.isArray(lastMessage.content) &&
        lastMessage.content.some((b: any) => b.type === 'tool_result');

      let text: string;
      if (isToolResult) {
        text = (lastMessage.content as any[])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n');
        if (!text.trim()) {
          // Pure tool_result – nothing to send
          yield { type: 'stream_event', sessionId, event: { type: 'content', value: '' } };
          return;
        }
      } else {
        text = typeof lastMessage.content === 'string'
          ? lastMessage.content
          : lastMessage.content.map((b: any) => b.text || '').filter(Boolean).join('\n');
      }

      console.log(`[Backend] Sending message with all tools disabled, text_length=${text.length}, model=${request.model}`);

      const startStepCount = cascade.state?.trajectory?.steps?.length ?? 0;

      // Send via sendUserCascadeMessage with toolConfig that disables everything
      await this.sendMessageWithDisabledTools(cascade, text, request.model, apiKey);

      // Wait for the turn to complete
      await cascade.waitForTurnComplete({ timeoutMs: 120000 });
      console.log(`[Backend] Cascade turn complete`);

      // Collect text from new steps since startStepCount
      const collected = this.collectTextFromSteps(cascade, startStepCount);
      if (collected) {
        yield { type: 'stream_event', sessionId, event: { type: 'content', value: collected } };
      }

      // Check for interactions – with all tools disabled, none should appear,
      // but we handle the runCommand case just in case
      const trajectory = cascade.state?.trajectory;
      if (trajectory?.steps) {
        for (const step of trajectory.steps) {
          if (step.requestedInteraction?.interaction?.case === 'runCommand') {
            const val = step.requestedInteraction.interaction.value as any;
            const stepIndex = trajectory.steps.indexOf(step);
            yield {
              type: 'tool_call',
              sessionId,
              callId: `step_call_${stepIndex}`,
              name: 'run_command',
              args: { command: val.proposedCommandLine || val.commandLine || '' },
            };
          }
        }
      }

      yield {
        type: 'turn_end',
        sessionId,
        stopReason: 'end_turn',
      };
    } catch (error) {
      console.error('[Backend] Stream error:', error);
      yield { type: 'error', sessionId, message: String(error) };
    }
  }

  async shutdown(): Promise<void> {
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
