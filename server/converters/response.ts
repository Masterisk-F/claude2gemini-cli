/**
 * Gemini レスポンス → Claude API レスポンス変換（非ストリーミング）
 *
 * Gemini SDK の sendStream() 出力を蓄積し、
 * Claude Messages API 形式のレスポンスオブジェクトに変換する。
 */

import { randomUUID } from 'node:crypto';
import type { ClaudeContentBlock, ClaudeResponse, ClaudeStopReason, ClaudeToolUseBlock } from '../types.js';

export interface BuildResponseOptions {
  text: string;
  model: string;
  toolCalls?: ClaudeToolUseBlock[];
}

/**
 * 蓄積したテキストとツール呼び出しから Claude API レスポンスを構築する
 */
export function buildClaudeResponse(options: BuildResponseOptions): ClaudeResponse {
  const content: ClaudeContentBlock[] = [];

  if (options.text) {
    content.push({
      type: 'text',
      text: options.text,
    });
  }

  let stopReason: ClaudeStopReason = 'end_turn';

  if (options.toolCalls && options.toolCalls.length > 0) {
    content.push(...options.toolCalls);
    stopReason = 'tool_use';
  }

  return {
    id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    content,
    model: options.model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
  };
}
