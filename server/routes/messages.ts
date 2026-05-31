import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { sessionStore } from '../session-store.js';
import { streamGeminiToClaudeSSE, setupSSEHeaders } from '../converters/stream.js';
import { mapModelName } from '../converters/request.js';
import { antigravityBackend, GeminiApiError } from '../gemini-backend.js';

export const messagesRouter = Router();

/**
 * Claude Response Builder
 */
function buildClaudeResponse({
  contentBlocks,
  model,
  usage,
}: {
  contentBlocks: any[];
  model: string;
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; context_window_estimated_tokens?: number };
}) {
  if (contentBlocks.length === 0) {
    throw new Error('Gemini API returned an empty response');
  }

  const hasClientToolUse = contentBlocks.some(b => b.type === 'tool_use');
  const stopReason = hasClientToolUse ? 'tool_use' : 'end_turn';

  const usageField: any = {
    input_tokens: usage?.input_tokens || 0,
    output_tokens: usage?.output_tokens || 0,
  };
  if (usage?.cache_read_input_tokens !== undefined) {
    usageField.cache_read_input_tokens = usage.cache_read_input_tokens;
  }
  if (usage?.cache_creation_input_tokens !== undefined) {
    usageField.cache_creation_input_tokens = usage.cache_creation_input_tokens;
  }
  if (usage?.context_window_estimated_tokens !== undefined) {
    usageField.context_window_estimated_tokens = usage.context_window_estimated_tokens;
  }

  return {
    id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    model: model,
    content: contentBlocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: usageField,
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

// POST /v1/messages
messagesRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  const body = req.body;

  console.log(`[API] Received messages request. Model: ${body.model}, Stream: ${body.stream}`);
  if (body.messages && Array.isArray(body.messages)) {
    console.log(`[API] Messages chain:`, body.messages.map((m: any, idx: number) => `[${idx}] ${m.role} (len=${typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length})`));
    const lastMsg = body.messages[body.messages.length - 1];
    if (lastMsg) {
      console.log(`[API] Last message content snippet:`, typeof lastMsg.content === 'string' ? lastMsg.content.slice(0, 200) : JSON.stringify(lastMsg.content).slice(0, 200));
    }
  }

  try {
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'messages are required' } });
      return;
    }
    if (!body.model || typeof body.model !== 'string') {
      res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'model is required' } });
      return;
    }

    let sessionId = req.headers['x-session-id'] as string;
    if (!sessionId) {
      // Try to resolve from last message tool_result
      const lastMessage = body.messages[body.messages.length - 1];
      if (lastMessage.role === 'user' && Array.isArray(lastMessage.content)) {
        const toolResult = lastMessage.content.find((b: any) => b.type === 'tool_result');
        if (toolResult) {
          sessionId = sessionStore.resolveToolCall(toolResult.tool_use_id) || '';
        }
      }
    }

    if (!sessionId) {
      sessionId = `session_${Date.now()}_${randomUUID().slice(0, 6)}`;
    }

    const resolvedModel = mapModelName(body.model);
    const stream = antigravityBackend.createMessageStream(sessionId, {
      model: resolvedModel,
      messages: body.messages,
      system: body.system,
      tools: body.tools,
    });

    const allowedToolNames = body.tools?.map((t: any) => t.name) || [];

    if (body.stream) {
      setupSSEHeaders(res);
      await streamGeminiToClaudeSSE(stream, res, body.model, sessionId, sessionStore, allowedToolNames);
    } else {
      const contentBlocks: any[] = [];
      let currentText = '';
      let turnEndUsage: any;

      const flushText = () => {
        if (currentText) {
          contentBlocks.push({ type: 'text', text: currentText });
          currentText = '';
        }
      };

      for await (const msg of stream) {
        if (msg.type === 'stream_event') {
          if (msg.event.type === 'content' && msg.event.value) {
            currentText += msg.event.value;
          }
        } else if (msg.type === 'tool_call') {
          if (allowedToolNames.includes(msg.name)) {
            flushText();
            sessionStore.addPendingToolCall(sessionId, msg.callId);
            contentBlocks.push({
              type: 'tool_use',
              id: msg.callId,
              name: msg.name,
              input: msg.args
            });
          }
        } else if (msg.type === 'error' || msg.type === 'fatal_error') {
          throw new GeminiApiError(msg.message, 'status' in msg ? msg.status : undefined);
        } else if (msg.type === 'turn_end') {
          flushText();
          turnEndUsage = msg.usage;
          break;
        }
      }

      const claudeResponse = buildClaudeResponse({
        contentBlocks,
        model: body.model,
        usage: turnEndUsage,
      });

      res.json(claudeResponse);
    }
  } catch (error) {
    if (res.headersSent) {
      console.error(`[API Error after headers]`, error instanceof Error ? error.message : String(error));
      return;
    }

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
