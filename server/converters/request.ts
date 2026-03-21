/**
 * Claude メッセージ → Gemini プロンプト変換
 *
 * Claude の messages 配列からテキストコンテンツを抽出し、
 * Gemini SDK に渡すプロンプト文字列に変換する。
 */

import type { ClaudeMessage, ClaudeContentBlock } from '../types.js';

/**
 * Claude モデル名を Gemini モデル名に変換する。
 * Claude Code は処理の途中で軽量モデル（haiku 等）を裏で呼び出すため、
 * そのままのモデル名を Gemini API に渡すと ModelNotFoundError になる。
 */
export function mapModelName(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes('sonnet') || lower.includes('opus')) {
    return 'gemini-3.1-pro-preview';
  }
  if (lower.includes('haiku') || !lower.includes('gemini')) {
    return 'gemini-2.5-flash';
  }
  return model;
}

/**
 * ClaudeMessage の content からテキスト部分を抽出する
 */
function extractTextFromContent(content: string | ClaudeContentBlock[]): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

/**
 * Claude messages 配列から最後のユーザーメッセージのテキストを抽出する。
 * Gemini SDK の sendStream() は単一のプロンプト文字列を受け取るため、
 * 最後の user メッセージのみを使用する。
 *
 * マルチターン対応はフェーズ6で実装する。
 */
export function convertMessagesToPrompt(messages: ClaudeMessage[]): string {
  // 最後の user メッセージを取得
  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMessage) {
    throw new Error('messages に user ロールのメッセージが含まれていません');
  }

  return extractTextFromContent(lastUserMessage.content);
}

/**
 * Claude の system パラメータを抽出する
 */
export function extractSystemPrompt(system?: any): string | undefined {
  if (!system) return undefined;
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block?.type === 'text' && typeof block.text === 'string') return block.text;
        return JSON.stringify(block);
      })
      .join('\n');
  }
  return String(system);
}
