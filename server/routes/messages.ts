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
import { sendPromptAndCollect } from '../gemini-backend.js';

export const messagesRouter = Router();

messagesRouter.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body as ClaudeRequest;

    // 最小限のバリデーション
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'messages は必須です',
        },
      });
      return;
    }

    if (!body.max_tokens || typeof body.max_tokens !== 'number') {
      res.status(400).json({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'max_tokens は必須です',
        },
      });
      return;
    }

    // Claude メッセージ → Gemini プロンプト変換
    const prompt = convertMessagesToPrompt(body.messages);
    const systemPrompt = extractSystemPrompt(body.system);

    // ストリーミングモードは後のフェーズで対応
    if (body.stream) {
      res.status(501).json({
        type: 'error',
        error: {
          type: 'api_error',
          message: 'ストリーミングはまだ実装されていません',
        },
      });
      return;
    }

    // Gemini に送信してレスポンスを収集
    const responseText = await sendPromptAndCollect(prompt, {
      instructions: systemPrompt,
      model: body.model,
    });

    // Claude API 形式でレスポンスを返す
    const claudeResponse = buildClaudeResponse(responseText, body.model);
    res.json(claudeResponse);
  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).json({
      type: 'error',
      error: {
        type: 'api_error',
        message: error instanceof Error ? error.message : 'Internal server error',
      },
    });
  }
});
