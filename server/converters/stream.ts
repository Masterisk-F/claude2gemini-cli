/**
 * Gemini ストリームイベント → Claude SSE イベント変換
 *
 * Gemini SDK の sendStream() が生成する ServerGeminiStreamEvent を、
 * Claude Messages API の SSE (Server-Sent Events) 形式に変換する。
 */

import { randomUUID } from 'node:crypto';
import type { Response } from 'express';

/**
 * SSE レスポンスヘッダを設定する
 */
export function setupSSEHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

/**
 * SSE イベントを送信する
 */
function sendSSE(res: Response, eventType: string, data: unknown): void {
  res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * message_start イベントを送信する
 */
function sendMessageStart(res: Response, messageId: string, model: string): void {
  sendSSE(res, 'message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    },
  });
}

/**
 * content_block_start (text) イベントを送信する
 */
function sendContentBlockStart(res: Response, index: number): void {
  sendSSE(res, 'content_block_start', {
    type: 'content_block_start',
    index,
    content_block: {
      type: 'text',
      text: '',
    },
  });
}

/**
 * content_block_delta (text_delta) イベントを送信する
 */
function sendTextDelta(res: Response, index: number, text: string): void {
  sendSSE(res, 'content_block_delta', {
    type: 'content_block_delta',
    index,
    delta: {
      type: 'text_delta',
      text,
    },
  });
}

/**
 * content_block_stop イベントを送信する
 */
function sendContentBlockStop(res: Response, index: number): void {
  sendSSE(res, 'content_block_stop', {
    type: 'content_block_stop',
    index,
  });
}

/**
 * message_delta + message_stop イベントを送信してストリームを完了する
 */
function sendMessageEnd(res: Response, outputTokens: number): void {
  sendSSE(res, 'message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: 'end_turn',
      stop_sequence: null,
    },
    usage: {
      output_tokens: outputTokens,
    },
  });

  sendSSE(res, 'message_stop', {
    type: 'message_stop',
  });
}

/**
 * Gemini の sendStream() ストリームを Claude SSE イベントに変換して送信する
 */
export async function streamGeminiToClaudeSSE(
  geminiStream: AsyncGenerator<{ type: string; value?: unknown }>,
  res: Response,
  model: string,
): Promise<void> {
  const messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  let blockStarted = false;
  const blockIndex = 0;

  // message_start を送信
  sendMessageStart(res, messageId, model);

  // ping を送信
  sendSSE(res, 'ping', { type: 'ping' });

  for await (const chunk of geminiStream) {
    if (chunk.type === 'content' && chunk.value) {
      // 最初のコンテンツでブロック開始
      if (!blockStarted) {
        sendContentBlockStart(res, blockIndex);
        blockStarted = true;
      }
      sendTextDelta(res, blockIndex, chunk.value as string);
    }
  }

  // ブロックが開始されていた場合は閉じる
  if (blockStarted) {
    sendContentBlockStop(res, blockIndex);
  } else {
    // テキストが一切なかった場合でも空のブロックを送信
    sendContentBlockStart(res, blockIndex);
    sendContentBlockStop(res, blockIndex);
  }

  // メッセージ完了
  sendMessageEnd(res, 0);
  res.end();
}
