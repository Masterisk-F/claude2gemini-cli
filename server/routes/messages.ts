/**
 * POST /v1/messages ルーター
 *
 * Claude Messages API 互換のエンドポイント。
 * リクエストを受け取り、Gemini SDK 経由で応答を生成し、
 * Claude API 形式で返す。
 */

import { Router, type Request, type Response } from 'express';
import type { ClaudeRequest } from '../types.js';
import { convertMessagesToPrompt, extractSystemPrompt } from '../converters/request.js';
import { buildClaudeResponse } from '../converters/response.js';
import { setupSSEHeaders, streamGeminiToClaudeSSE } from '../converters/stream.js';
import { sendPromptAndCollect, sendPromptStream } from '../gemini-backend.js';
import { sessionStore } from '../session-store.js';

export const messagesRouter = Router();

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

    // tool_result のチェック（セッション再開用）
    let sessionId: string | undefined = undefined;
    const lastMessage = body.messages[body.messages.length - 1];
    
    if (lastMessage.role === 'user' && Array.isArray(lastMessage.content)) {
      const toolResults = lastMessage.content.filter(
        (b) => b.type === 'tool_result'
      ) as Extract<typeof lastMessage.content[number], { type: 'tool_result' }>[];
      
      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          const resolvedSessionId = sessionStore.resolveToolCall(tr.tool_use_id, tr.content);
          if (resolvedSessionId) {
            sessionId = resolvedSessionId;
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

    if (body.stream) {
      // ストリーミングモード: SSE で返す
      setupSSEHeaders(res);

      const { stream, toolState, sessionId: newSessionId } = sendPromptStream(prompt, {
        sessionId,
        instructions: systemPrompt,
        model: body.model,
        tools: body.tools,
      });

      await streamGeminiToClaudeSSE(stream, res, body.model, toolState, newSessionId, sessionStore);
    } else {
      // 非ストリーミングモード
      const result = await sendPromptAndCollect(prompt, {
        sessionId,
        instructions: systemPrompt,
        model: body.model,
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
    console.error('Error processing request:', error);
    // ストリーミング中のエラーは SSE として送れないが、ヘッダ未送信時は JSON で返す
    if (!res.headersSent) {
      res.status(500).json({
        type: 'error',
        error: {
          type: 'api_error',
          message: error instanceof Error ? error.message : 'Internal server error',
        },
      });
    } else {
      res.end();
    }
  }
});

