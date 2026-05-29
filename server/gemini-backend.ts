/**
 * Antigravity Backend Implementation
 *
 * Manages the lifecycle of the Antigravity Language Server (LS)
 * and provides a bridge between Claude API requests and Antigravity Cascades.
 */

import { AntigravityClient } from 'antigravity-client';
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
   * Creates an asynchronous stream of bridge messages for a given session.
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
    let cascadeIsNew = false;

    if (!cascade) {
      cascade = await this.client!.startCascade();
      this.cascades.set(sessionId, cascade);
      cascadeIsNew = true;
      console.log(`[Backend] New cascade created: ${cascade.cascadeId}`);
    }

    try {
      // Check if this is a tool_result continuation
      const isToolResult =
        lastMessage.role === 'user' &&
        Array.isArray(lastMessage.content) &&
        lastMessage.content.some((b: any) => b.type === 'tool_result');

      if (isToolResult) {
        // Collect all tool results and send them as a new message
        // Antigravity handles tool results automatically via the reactive stream
        // so we just send the next user message
        const textBlocks = (lastMessage.content as any[])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n');

        if (textBlocks.trim()) {
          const result = await cascade.run(textBlocks, { model: request.model, timeoutMs: 120000 });
          console.log(`[Backend] Cascade run complete: text_length=${result.text.length}, steps=${result.newSteps.length}`);
          if (result.text) {
            yield { type: 'stream_event', sessionId, event: { type: 'content', value: result.text } };
          }
        } else {
          // Pure tool_result - just resume the cascade
          yield { type: 'stream_event', sessionId, event: { type: 'content', value: '' } };
        }
      } else {
        // New message
        const text = typeof lastMessage.content === 'string'
          ? lastMessage.content
          : lastMessage.content.map((b: any) => b.text || '').filter(Boolean).join('\n');

        console.log(`[Backend] Sending message, text_length=${text.length}, model=${request.model}`);

        const result = await cascade.run(text, { model: request.model, timeoutMs: 120000 });
        console.log(`[Backend] Cascade run complete: text_length=${result.text.length}, steps=${result.newSteps.length}`);

        if (result.text) {
          yield { type: 'stream_event', sessionId, event: { type: 'content', value: result.text } };
        }
      }

      // Check for interactions (tool calls from Antigravity to the user)
      const trajectory = cascade.state?.trajectory;
      if (trajectory?.steps) {
        for (const step of trajectory.steps) {
          if (step.requestedInteraction?.interaction?.case) {
            const interaction = step.requestedInteraction.interaction;
            const caseType = interaction.case;
            const stepIndex = trajectory.steps.indexOf(step);

            if (caseType === 'runCommand') {
              const val = interaction.value as any;
              yield {
                type: 'tool_call',
                sessionId,
                callId: `step_call_${stepIndex}`,
                name: 'run_command',
                args: { command: val.proposedCommandLine || val.commandLine || '' }
              };
            }
          }
        }
      }

      // Yield usage info
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
