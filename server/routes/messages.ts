/**
 * POST /v1/messages ルーター
 *
 * Claude Messages API 互換のエンドポイント。
 * リクエストを受け取り、Gemini SDK 経由で応答を生成し、
 * Claude API 形式で返す。
 */

import { Router, type Request, type Response } from 'express';
import type { ClaudeRequest } from '../types.js';
import { convertMessagesToPrompt, extractSystemPrompt, mapModelName } from '../converters/request.js';
import { buildClaudeResponse } from '../converters/response.js';
import { setupSSEHeaders, streamGeminiToClaudeSSE } from '../converters/stream.js';
import { sendPromptAndCollect, sendPromptStream, GeminiApiError } from '../gemini-backend.js';
import { sessionStore } from '../session-store.js';

/**
 * Gemini API エラーを Claude API 形式のエラーに分類する。
 * GeminiApiError の HTTP ステータスから適切な Claude エラータイプを決定する。
 */
export function classifyError(error: unknown): { statusCode: number; errorType: string; clientMessage: string } {
  const errorMsg = error instanceof Error ? error.message : String(error);

  if (error instanceof GeminiApiError && error.status) {
    const status = error.status;
    if (status === 429) {
      return { statusCode: 429, errorType: 'rate_limit_error', clientMessage: `Gemini API rate limit: ${errorMsg}` };
    }
    if (status === 400) {
      return { statusCode: 400, errorType: 'invalid_request_error', clientMessage: `Gemini API bad request: ${errorMsg}` };
    }
    if (status === 401 || status === 403) {
      return { statusCode: 401, errorType: 'authentication_error', clientMessage: `Gemini API auth error: ${errorMsg}` };
    }
    if (status === 404) {
      return { statusCode: 404, errorType: 'not_found_error', clientMessage: `Gemini API not found: ${errorMsg}` };
    }
    return { statusCode: status >= 500 ? 500 : status, errorType: 'api_error', clientMessage: `Gemini API error: ${errorMsg}` };
  }

  // 文字列マッチによるフォールバック（GeminiApiError 以外の例外用）
  const isRateLimit =
    errorMsg.includes('QUOTA_EXHAUSTED') ||
    errorMsg.includes('RESOURCE_EXHAUSTED') ||
    (error as any)?.status === 429 ||
    (error as any)?.name === 'TerminalQuotaError';

  if (isRateLimit) {
    return { statusCode: 429, errorType: 'rate_limit_error', clientMessage: `Gemini API quota exhausted or rate limit exceeded.` };
  }

  return { statusCode: 500, errorType: 'api_error', clientMessage: `Internal server error: ${errorMsg}` };
}
export const messagesRouter = Router();

/**
 * Claude の tool_result.content を文字列に正規化する。
 * content はテキスト文字列、コンテンツブロック配列、または undefined の場合がある。
 */
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

messagesRouter.post('/', async (req: Request, res: Response) => {
  let sessionId: string | undefined = undefined;
  try {
    const body = req.body as ClaudeRequest;
    console.log(`\n[POST /v1/messages] model=${body.model}, stream=${body.stream}, messagesCount=${body.messages?.length}, systemLen=${JSON.stringify(body.system)?.length}`);
    console.log(`[Payload Size] approx ${JSON.stringify(body).length} bytes`);

    // 最小限のバリデーション
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'messages is required',
        },
      });
      return;
    }

    if (!body.max_tokens || typeof body.max_tokens !== 'number') {
      res.status(400).json({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'max_tokens is required',
        },
      });
      return;
    }

    if (!body.model || typeof body.model !== 'string') {
      res.status(400).json({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'model is required',
        },
      });
      return;
    }

    // tool_result のチェック（セッション再開用）
    const lastMessage = body.messages[body.messages.length - 1];
    
    if (lastMessage.role === 'user' && Array.isArray(lastMessage.content)) {
      const toolResults = lastMessage.content.filter(
        (b) => b.type === 'tool_result'
      ) as Extract<typeof lastMessage.content[number], { type: 'tool_result' }>[];
      
      if (toolResults.length > 0) {
        console.log(`[ToolResult] ${toolResults.length} tool_result(s) received: ${toolResults.map(tr => tr.tool_use_id).join(', ')}`);
        
        let resolvedCount = 0;
        for (const tr of toolResults) {
          // Claude の tool_result.content はブロック配列の場合がある → テキストに正規化
          const resultContent = normalizeToolResultContent(tr.content);
          console.log(`[ToolResult] Resolving ${tr.tool_use_id}, content length: ${resultContent.length}`);
          const resolvedSessionId = sessionStore.resolveToolCall(tr.tool_use_id, resultContent);
          if (resolvedSessionId) {
            sessionId = resolvedSessionId;
            resolvedCount++;
          } else {
            console.warn(`[ToolResult] FAILED to resolve ${tr.tool_use_id} - not found in sessionStore`);
          }
        }
        
        if (resolvedCount === 0) {
          console.warn(`[ToolResult] All tool results failed to resolve. Falling back to stateless request.`);
          // sessionId は undefined のままとなり、以降で convertMessagesToPrompt() によりフルプロンプトが生成される
        } else if (resolvedCount < toolResults.length) {
          // 一部だけ解決できた場合（通常は発生しにくいが）
          console.warn(`[ToolResult] Partially resolved tool results.`);
        }
      }
    }

    // Claude メッセージ → Gemini プロンプト変換 (tool_result 返却時は空文字でよい)
    const prompt = sessionId ? '' : convertMessagesToPrompt(body.messages);
    const systemPrompt = extractSystemPrompt(body.system);
    const mappedModel = mapModelName(body.model);
    console.log(`[Model Mapping] ${body.model} -> ${mappedModel}`);

    if (body.stream) {
      // ストリーミングモード: SSE で返す
      setupSSEHeaders(res);

      const { stream, toolState, sessionId: newSessionId } = await sendPromptStream(prompt, {
        sessionId,
        instructions: systemPrompt,
        model: mappedModel,
        tools: body.tools,
      });
      sessionId = newSessionId; // sessionId を outer scope に反映

      const allowedToolNames = body.tools?.map((t) => t.name) || [];
      await streamGeminiToClaudeSSE(stream, res, body.model, toolState, newSessionId, sessionStore, allowedToolNames);
    } else {
      // 非ストリーミングモード
      const result = await sendPromptAndCollect(prompt, {
        sessionId,
        instructions: systemPrompt,
        model: mappedModel,
        tools: body.tools,
      });
      sessionId = result.sessionId; // sessionId を outer scope に反映

      const claudeResponse = buildClaudeResponse({
        text: result.text,
        model: body.model,
        toolCalls: result.toolCalls,
      });

      // Gemini が何も生成せずに終了した場合はエラーとして扱う
      if (claudeResponse.content.length === 0) {
        console.warn('[Warning] Gemini returned empty response, treating as error');
        if (sessionId) {
          sessionStore.deleteSession(sessionId);
        }
        res.status(500).json({
          type: 'error',
          error: {
            type: 'api_error',
            message: 'Gemini API returned an empty response',
          },
        });
        return;
      }

      res.json(claudeResponse);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[Error]', errorMsg);
    
    if (sessionId) {
      sessionStore.deleteSession(sessionId);
      console.log(`[Error] Session ${sessionId} deleted due to error.`);
    }

    const { statusCode, errorType, clientMessage } = classifyError(error);

    if (!res.headersSent) {
      res.status(statusCode).json({
        type: 'error',
        error: {
          type: errorType,
          message: clientMessage,
        },
      });
    } else if (!res.writableEnded) {
      const errorPayload = JSON.stringify({
        type: 'error',
        error: {
          type: errorType,
          message: clientMessage,
        },
      });
      res.write(`event: error\ndata: ${errorPayload}\n\n`);
      res.end();
    }
  }
});

