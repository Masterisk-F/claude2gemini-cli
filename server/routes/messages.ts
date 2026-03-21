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
import { sendPromptAndCollect, sendPromptStream } from '../gemini-backend.js';
import { sessionStore } from '../session-store.js';

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
    let sessionId: string | undefined = undefined;
    const lastMessage = body.messages[body.messages.length - 1];
    
    if (lastMessage.role === 'user' && Array.isArray(lastMessage.content)) {
      const toolResults = lastMessage.content.filter(
        (b) => b.type === 'tool_result'
      ) as Extract<typeof lastMessage.content[number], { type: 'tool_result' }>[];
      
      if (toolResults.length > 0) {
        console.log(`[ToolResult] ${toolResults.length} tool_result(s) received: ${toolResults.map(tr => tr.tool_use_id).join(', ')}`);
        
        for (const tr of toolResults) {
          // Claude の tool_result.content はブロック配列の場合がある → テキストに正規化
          const resultContent = normalizeToolResultContent(tr.content);
          console.log(`[ToolResult] Resolving ${tr.tool_use_id}, content length: ${resultContent.length}`);
          const resolvedSessionId = sessionStore.resolveToolCall(tr.tool_use_id, resultContent);
          if (resolvedSessionId) {
            sessionId = resolvedSessionId;
          } else {
            console.warn(`[ToolResult] FAILED to resolve ${tr.tool_use_id} - not found in sessionStore`);
          }
        }
        
        if (!sessionId) {
          res.status(400).json({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'Invalid tool_use_id or session expired',
            },
          });
          return;
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

      const claudeResponse = buildClaudeResponse({
        text: result.text,
        model: body.model,
        toolCalls: result.toolCalls,
      });
      res.json(claudeResponse);
    }
  } catch (error) {
    console.error('[Error]', error instanceof Error ? error.message : error);
    if (!res.headersSent) {
      res.status(500).json({
        type: 'error',
        error: {
          type: 'api_error',
          message: error instanceof Error ? error.message : 'Internal server error',
        },
      });
    } else if (!res.writableEnded) {
      // ストリーミング中のエラーは SSE イベントとして送信
      const errorPayload = JSON.stringify({
        type: 'error',
        error: {
          type: 'api_error',
          message: error instanceof Error ? error.message : 'Internal server error',
        },
      });
      res.write(`event: error\ndata: ${errorPayload}\n\n`);
      res.end();
    }
  }
});

