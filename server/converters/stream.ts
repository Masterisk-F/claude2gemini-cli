/**
 * Gemini ストリームイベント → Claude SSE イベント変換
 *
 * Gemini SDK の sendStream() が生成する ServerGeminiStreamEvent を、
 * Claude Messages API の SSE (Server-Sent Events) 形式に変換する。
 */

import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { GeminiApiError } from '../gemini-backend.js';
import { classifyError } from '../routes/messages.js';

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
 * Child プロセスからのストリーム (ChildMessage) を Claude SSE イベントに変換して送信する
 */
export async function streamGeminiToClaudeSSE(
  childStream: AsyncGenerator<any>,
  res: Response,
  model: string,
  sessionId: string,
  sessionStore: typeof import('../session-store.js').sessionStore,
  allowedToolNames: string[]
): Promise<void> {
  const messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  let blockIndex = 0;

  sendMessageStart(res, messageId, model);
  sendSSE(res, 'ping', { type: 'ping' });

  let textBlockStarted = false;
  let hasProducedAnyBlock = false;

  try {
    for await (const msg of childStream) {
      if (msg.type === 'stream_event') {
        const chunk = msg.event;
        if (chunk.type === 'content' && chunk.value) {
          if (!textBlockStarted) {
            sendContentBlockStart(res, blockIndex);
            textBlockStarted = true;
            hasProducedAnyBlock = true;
          }
          sendTextDelta(res, blockIndex, chunk.value);
        }
      } else if (msg.type === 'tool_call') {
        const callId = msg.callId;
        const name = msg.name;

        if (!allowedToolNames.includes(name)) {
          continue;
        }

        // Parent 側のセッションストアに toolCallId -> sessionId のマッピングを登録
        sessionStore.addPendingToolCall(sessionId, callId);

        if (textBlockStarted) {
          sendContentBlockStop(res, blockIndex);
          blockIndex++;
          textBlockStarted = false;
        }

        sendSSE(res, 'content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: {
            type: 'tool_use',
            id: callId,
            name: name,
            input: {},
          },
        });

        sendSSE(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify(msg.args),
          },
        });

        sendContentBlockStop(res, blockIndex);
        blockIndex++;
        hasProducedAnyBlock = true;
      } else if (msg.type === 'turn_end') {
        if (textBlockStarted) {
          sendContentBlockStop(res, blockIndex);
          blockIndex++;
          textBlockStarted = false;
        }

        sendSSE(res, 'message_delta', {
          type: 'message_delta',
          delta: {
            stop_reason: msg.stopReason,
            stop_sequence: null,
          },
          usage: {
            output_tokens: msg.usage?.output_tokens || 0,
          },
        });

        break; // 完全終了
      } else if (msg.type === 'error' || msg.type === 'fatal_error') {
        if (textBlockStarted) {
          sendContentBlockStop(res, blockIndex);
          textBlockStarted = false;
        }
        throw new GeminiApiError(msg.message, msg.status);
      }
    }

    if (!hasProducedAnyBlock) {
      throw new GeminiApiError('Gemini API returned an empty response', 500);
    }

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[Stream Error]', errorMsg);

    const { errorType, clientMessage } = classifyError(error);

    if (!res.writableEnded) {
      const errorPayload = JSON.stringify({
        type: 'error',
        error: {
          type: errorType,
          message: clientMessage,
        },
      });
      res.write(`event: error\ndata: ${errorPayload}\n\n`);
    }
  } finally {
    if (!res.writableEnded) {
      sendSSE(res, 'message_stop', { type: 'message_stop' });
      res.end();
    }
  }
}
