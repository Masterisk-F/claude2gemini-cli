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
  if (lower.includes('opus')) {
    return 'gemini-3.1-pro-preview';
  }
  if (lower.includes('sonnet')) {
    return 'gemini-3-flash-preview';
  }
  if (!lower.includes('gemini')) {
    // 'haiku' comes here
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
 * ClaudeMessage の content を構造化テキストに変換する。
 * tool_use と tool_result ブロックも含めることで、会話履歴の文脈を保持する。
 */
function formatContentForPrompt(content: string | ClaudeContentBlock[]): string {
  if (typeof content === 'string') {
    return content;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push(block.text);
    } else if (block.type === 'tool_use') {
      parts.push(`[Tool Call: ${block.name}(${JSON.stringify(block.input)})]`);
    } else if (block.type === 'tool_result') {
      const resultText = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? block.content.map((b: any) => b.type === 'text' ? b.text : JSON.stringify(b)).join('\n')
          : '';
      parts.push(`[Tool Result (${block.tool_use_id}): ${resultText}]`);
    }
  }
  return parts.join('\n');
}

/**
 * Claude messages 配列を Gemini のプロンプト文字列に変換する。
 * 単一の user メッセージの場合はテキストをそのまま返す。
 * 複数メッセージ（マルチターン）の場合はロール付きの会話テキストにまとめる。
 */
export function convertMessagesToPrompt(messages: ClaudeMessage[]): string {
  if (messages.length === 0) {
    throw new Error('messages に user ロールのメッセージが含まれていません');
  }

  // 単一メッセージの場合はシンプルにテキストのみ返す
  if (messages.length === 1 && messages[0].role === 'user') {
    return extractTextFromContent(messages[0].content);
  }

  // マルチターン: ロール付きの会話テキストに変換
  const parts: string[] = [];
  for (const msg of messages) {
    const roleLabel = msg.role === 'user' ? 'User' : 'Assistant';
    const text = formatContentForPrompt(msg.content);
    if (text) {
      parts.push(`${roleLabel}: ${text}`);
    }
  }
  return parts.join('\n\n');
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
