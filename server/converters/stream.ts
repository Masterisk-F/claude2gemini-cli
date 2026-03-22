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
  geminiStream: AsyncGenerator<{ type: string; value?: any }>,
  res: Response,
  model: string,
  toolState: any,
  sessionId: string,
  sessionStore: any,
  allowedToolNames: string[]
): Promise<void> {
  const messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  let blockIndex = 0;

  // message_start を送信
  sendMessageStart(res, messageId, model);
  sendSSE(res, 'ping', { type: 'ping' });

  // ツール実行待ちを判定するための Promise
  let isToolTurnReached = false;
  let turnPromiseResolve: () => void;
  const turnPromise = new Promise<void>((resolve) => {
    turnPromiseResolve = resolve;
  });
  toolState.resolveToolTurn = () => {
    isToolTurnReached = true;
    turnPromiseResolve();
  };

  const sessionData = sessionStore.getOrCreateSession(sessionId);
  let nextPromise = sessionData.pendingNext || geminiStream.next();
  sessionData.pendingNext = undefined;

  let textBlockStarted = false;
  let hasProducedAnyBlock = false;
  let stopReason: string = 'end_turn';

  try {
    while (true) {
      if (isToolTurnReached) {
        sessionData.pendingNext = nextPromise;
        break;
      }

      const result = await Promise.race([nextPromise, turnPromise.then(() => 'TURN_ENDED')]);

      if (result === 'TURN_ENDED') {
        sessionData.pendingNext = nextPromise;
        break;
      }

      const iter = result as IteratorResult<any>;
      if (iter.done) {
        sessionStore.deleteSession(sessionId);
        break;
      }

      const chunk = iter.value;

      if (chunk.type === 'content' && chunk.value) {
        if (!textBlockStarted) {
          sendContentBlockStart(res, blockIndex);
          textBlockStarted = true;
          hasProducedAnyBlock = true;
        }
        sendTextDelta(res, blockIndex, chunk.value as string);
      } else if (chunk.type === 'tool_call_request') {
        const callInfo = chunk.value;
        const callId = callInfo.callId;
        const name = callInfo.name;

        if (!allowedToolNames.includes(name)) {
          // 組み込みツールはクライアントに返さず、内部の処理を続行させる
          nextPromise = geminiStream.next();
          continue;
        }

        toolState.expectedClientTools++;

        if (textBlockStarted) {
          sendContentBlockStop(res, blockIndex);
          blockIndex++;
          textBlockStarted = false;
        }

        let q = toolState.callIds.get(name);
        if (!q) {
          q = [];
          toolState.callIds.set(name, q);
        }
        q.push(callId);

        let parsedArgs: Record<string, unknown> = {};
        if (typeof callInfo.args === 'string') {
          try {
            parsedArgs = JSON.parse(callInfo.args);
          } catch (e) {}
        } else if (callInfo.args && typeof callInfo.args === 'object') {
          parsedArgs = callInfo.args;
        }

        // SSE tool_use events
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
            partial_json: JSON.stringify(parsedArgs),
          },
        });

        sendContentBlockStop(res, blockIndex);
        blockIndex++;
        hasProducedAnyBlock = true;
        stopReason = 'tool_use';
      }

      nextPromise = geminiStream.next();
    }

    if (textBlockStarted) {
      sendContentBlockStop(res, blockIndex);
    } else if (!hasProducedAnyBlock) {
      sendContentBlockStart(res, blockIndex);
      sendContentBlockStop(res, blockIndex);
    }

    // メッセージ完了 (ツール使用時も stop_reason: 'tool_use' として常に送信する)
    sendSSE(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 0 },
    });
    sendSSE(res, 'message_stop', { type: 'message_stop' });
    res.end();
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[Stream Error]', errorMsg);
    
    sessionStore.deleteSession(sessionId);

    // 429 エラーを判別
    const isRateLimit = 
      errorMsg.includes('429') || 
      errorMsg.includes('QUOTA_EXHAUSTED') || 
      errorMsg.includes('RESOURCE_EXHAUSTED') ||
      (error as any)?.status === 429 ||
      (error as any)?.name === 'TerminalQuotaError';

    const errorType = isRateLimit ? 'overloaded_error' : 'api_error';
    const clientMessage = isRateLimit ? 'Gemini API quota exhausted or rate limit exceeded.' : 'Internal server error';

    if (!res.writableEnded) {
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
}
