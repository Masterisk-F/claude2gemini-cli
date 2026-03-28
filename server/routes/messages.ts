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
import { accountPool } from '../account-pool.js';

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

    // セッションに紐付くアカウントIDを取得または新規割り当て
    let accountId: string | undefined = undefined;
    if (sessionId) {
      const existingSession = sessionStore.getSession(sessionId);
      if (existingSession && existingSession.accountId) {
        accountId = existingSession.accountId;
        console.log(`[Session] Reusing account ${accountId} for session ${sessionId}`);
      }
    }

    if (!accountId) {
      accountId = accountPool.nextAccount(); // undefined の場合はフォールバック
      if (accountId) {
        console.log(`[Session] Assigned account ${accountId} for ${sessionId ? 'existing session ' + sessionId : 'new session'}`);
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
        accountId,
        instructions: systemPrompt,
        model: mappedModel,
        tools: body.tools,
      });
      sessionId = newSessionId; // sessionId を outer scope に反映

      // セッションにアカウントIDを保存
      if (accountId) {
        const sessionData = sessionStore.getOrCreateSession(newSessionId);
        sessionData.accountId = accountId;
      }

      const allowedToolNames = body.tools?.map((t) => t.name) || [];
      await streamGeminiToClaudeSSE(stream, res, body.model, toolState, newSessionId, sessionStore, allowedToolNames);
    } else {
      // 非ストリーミングモード
      const result = await sendPromptAndCollect(prompt, {
        sessionId,
        accountId,
        instructions: systemPrompt,
        model: mappedModel,
        tools: body.tools,
      });
      sessionId = result.sessionId; // sessionId を outer scope に反映

      // セッションにアカウントIDを保存
      if (accountId) {
        const sessionData = sessionStore.getOrCreateSession(result.sessionId);
        sessionData.accountId = accountId;
      }

      const claudeResponse = buildClaudeResponse({
        text: result.text,
        model: body.model,
        toolCalls: result.toolCalls,
      });
      res.json(claudeResponse);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[Error]', errorMsg);
    
    // エラー発生時はセッションを強制的に破棄する (残留した壊れたストリームの再利用を防ぐため)
    if (sessionId) {
      sessionStore.deleteSession(sessionId);
      console.log(`[Error] Session ${sessionId} deleted due to error.`);
    }

    // 429 エラー (クォータ超過等) を判別
    const isRateLimit = 
      errorMsg.includes('QUOTA_EXHAUSTED') || 
      errorMsg.includes('RESOURCE_EXHAUSTED') ||
      (error as any)?.status === 429 ||
      (error as any)?.name === 'TerminalQuotaError';

    const statusCode = isRateLimit ? 429 : 500;
    const errorType = isRateLimit ? 'rate_limit_error' : 'api_error';
    const clientMessage = isRateLimit ? 'Gemini API quota exhausted or rate limit exceeded.' : 'Internal server error';

    if (!res.headersSent) {
      res.status(statusCode).json({
        type: 'error',
        error: {
          type: errorType,
          message: clientMessage,
        },
      });
    } else if (!res.writableEnded) {
      // ストリーミング中のエラーは SSE イベントとして送信
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

