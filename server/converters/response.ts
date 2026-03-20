/**
 * Gemini レスポンス → Claude API レスポンス変換（非ストリーミング）
 *
 * Gemini SDK の sendStream() 出力を蓄積し、
 * Claude Messages API 形式のレスポンスオブジェクトに変換する。
 */

import { randomUUID } from 'node:crypto';
import type { ClaudeResponse } from '../types.js';

/**
 * 蓄積したテキストから Claude API レスポンスを構築する
 */
export function buildClaudeResponse(
  text: string,
  model: string,
): ClaudeResponse {
  return {
    id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'text',
        text,
      },
    ],
    model,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
  };
}
