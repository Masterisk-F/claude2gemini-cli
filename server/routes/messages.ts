import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { accountPool } from '../account-pool.js';
import { sessionStore } from '../session-store.js';
import { streamGeminiToClaudeSSE, setupSSEHeaders } from '../converters/stream.js';
import { childManager } from '../child-manager.js';
import { extractSystemPrompt, convertMessagesToPrompt } from '../converters/request.js';
import { GeminiApiError } from '../gemini-backend.js';
import type { ClaudeMessage, ClaudeToolUseBlock } from '../types.js';
import type { ChildMessage, ParentMessage } from '../ipc-protocol.js';

export const messagesRouter = Router();

function normalizeToolResultContent(content: unknown): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block: any) => {
        if (typeof block === 'string') return block;
        if (block?.type === 'text' && typeof block.text === 'string') return block.text;
        return JSON.stringify(block);
      })
      .join('\n');
  }
  return JSON.stringify(content);
}

function buildClaudeResponse({
  text,
  model,
  toolCalls,
}: {
  text: string;
  model: string;
  toolCalls: ClaudeToolUseBlock[];
}) {
  const content: any[] = [];
  if (text || toolCalls.length === 0) {
    content.push({ type: 'text', text });
  }

  for (const call of toolCalls) {
    content.push(call);
  }

  const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';

  return {
    id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    model: model,
    content: content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
  };
}

export function classifyError(error: unknown): { statusCode: number; errorType: string; clientMessage: string } {
  const errorMsg = error instanceof Error ? error.message : String(error);

  if (error instanceof GeminiApiError) {
    const status = error.status || 500;
    if (status === 400) return { statusCode: 400, errorType: 'invalid_request_error', clientMessage: `Gemini API error: ${errorMsg}` };
    if (status === 401 || status === 403) return { statusCode: 401, errorType: 'authentication_error', clientMessage: `Gemini API auth error: ${errorMsg}` };
    if (status === 404) return { statusCode: 404, errorType: 'not_found_error', clientMessage: `Gemini API error: ${errorMsg}` };
    if (status === 429) return { statusCode: 500, errorType: 'overloaded_error', clientMessage: `Gemini API error: ${errorMsg}` };
    return { statusCode: status >= 500 ? 500 : status, errorType: 'api_error', clientMessage: `Gemini API error: ${errorMsg}` };
  }

  const isRateLimit =
    errorMsg.includes('QUOTA_EXHAUSTED') ||
    errorMsg.includes('RESOURCE_EXHAUSTED') ||
    (error as any)?.status === 429 ||
    (error as any)?.name === 'TerminalQuotaError';

  if (isRateLimit) {
    return { statusCode: 500, errorType: 'overloaded_error', clientMessage: `Gemini API quota exhausted or rate limit exceeded.` };
  }

  return { statusCode: 500, errorType: 'api_error', clientMessage: `Internal server error: ${errorMsg}` };
}

function mapModelName(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes('opus')) {
    return 'gemini-3.1-pro-preview';
  }
  if (lower.includes('sonnet')) {
    return 'gemini-3-flash-preview';
  }
  if (lower.includes('haiku')) {
    return 'gemini-2.5-flash-lite';
  }
  if (!lower.includes('gemini')) {
    return 'gemini-3-flash-preview';
  }
  return model;
}

// === NEW getSessionStream buffer logic ===
async function* getSessionStream(accountId: string, sessionId: string): AsyncGenerator<ChildMessage> {
  let resolveNext: ((msg: ChildMessage) => void) | null = null;
  const buffer: ChildMessage[] = [];

  const cleanup = childManager.onMessage(accountId, (msg) => {
    if (('sessionId' in msg && msg.sessionId === sessionId) || (msg.type === 'fatal_error')) {
      if (resolveNext) {
        resolveNext(msg);
        resolveNext = null;
      } else {
        buffer.push(msg);
      }
    }
  });

  try {
    while (true) {
      let msg: ChildMessage;
      if (buffer.length > 0) {
        msg = buffer.shift()!;
      } else {
        msg = await new Promise<ChildMessage>((resolve) => {
          resolveNext = resolve;
        });
      }
      yield msg;

      if (msg.type === 'turn_end' || msg.type === 'error' || msg.type === 'fatal_error') {
        break;
      }
    }
  } finally {
    cleanup();
  }
}

// POST /v1/messages
messagesRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  const body = req.body;

  try {
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'messages are required' } });
      return;
    }
    if (!body.model || typeof body.model !== 'string') {
      res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'model is required' } });
      return;
    }

    let isResuming = false;
    let accountId: string | undefined = undefined;
    let sessionId: string | undefined = undefined;

    const lastMessage = body.messages[body.messages.length - 1];
    if (lastMessage.role === 'user' && Array.isArray(lastMessage.content)) {
      const toolResults = lastMessage.content.filter((b: any) => b.type === 'tool_result') as any[];

      if (toolResults.length > 0) {
        console.log(`[ToolResult] ${toolResults.length} tool_result(s) received`);

        for (const tr of toolResults) {
          const resultContent = normalizeToolResultContent(tr.content);
          const resolvedSessionId = sessionStore.resolveToolCall(tr.tool_use_id);

          if (resolvedSessionId) {
            sessionId = resolvedSessionId;
            const sessionData = sessionStore.getSession(sessionId);
            if (sessionData && sessionData.accountId) {
              accountId = sessionData.accountId;
              await childManager.sendRequest(accountId, {
                type: 'tool_result',
                sessionId,
                toolCallId: tr.tool_use_id,
                result: resultContent
              });
              isResuming = true;
            }
          } else {
            console.warn(`[ToolResult] FAILED to resolve ${tr.tool_use_id} - falling back to stateless`);
          }
        }

        if (isResuming && accountId && sessionId) {
          await childManager.sendRequest(accountId, {
            type: 'resume_stream',
            sessionId
          });
        }
      }
    }

    if (!sessionId) {
      sessionId = `session_${Date.now()}_${randomUUID().slice(0, 6)}`;
    }

    if (!accountId) {
      accountId = accountPool.nextAccount();
      if (accountId) {
        const sessionData = sessionStore.getOrCreateSession(sessionId);
        sessionData.accountId = accountId;
        console.log(`[Session] Assigned account ${accountId} for session ${sessionId}`);
      }
    }

    if (!accountId) {
      throw new Error("No accounts available in pool");
    }

    if (!isResuming) {
      const promptRequest: ParentMessage = {
        type: 'request',
        id: `req-${Date.now()}`,
        sessionId,
        system: extractSystemPrompt(body.system),
        messages: body.messages,
        model: mapModelName(body.model),
        tools: body.tools
      };
      await childManager.sendRequest(accountId, promptRequest);
    }

    const stream = getSessionStream(accountId, sessionId);
    const allowedToolNames = body.tools?.map((t: any) => t.name) || [];

    if (body.stream) {
      setupSSEHeaders(res);
      await streamGeminiToClaudeSSE(stream, res, body.model, sessionId, sessionStore, allowedToolNames);

    } else {
      let fullText = '';
      const toolCalls: ClaudeToolUseBlock[] = [];

      for await (const msg of stream) {
        if (msg.type === 'stream_event') {
          if (msg.event.type === 'content' && msg.event.value) {
            fullText += msg.event.value;
          }
        } else if (msg.type === 'tool_call') {
          if (allowedToolNames.includes(msg.name)) {
            sessionStore.addPendingToolCall(sessionId, msg.callId);
            toolCalls.push({
              type: 'tool_use',
              id: msg.callId,
              name: msg.name,
              input: msg.args
            });
          }
        } else if (msg.type === 'error' || msg.type === 'fatal_error') {
          throw new GeminiApiError(msg.message, 'status' in msg ? msg.status : undefined);
        } else if (msg.type === 'turn_end') {
          break;
        }
      }

      const claudeResponse = buildClaudeResponse({
        text: fullText,
        model: body.model,
        toolCalls,
      });

      res.json(claudeResponse);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[API Error]`, errorMsg);

    const { statusCode, errorType, clientMessage } = classifyError(error);
    res.status(statusCode).json({
      type: 'error',
      error: {
        type: errorType,
        message: clientMessage,
      },
    });
  }
});
