/**
 * Claude メッセージ → Gemini プロンプト変換
 *
 * Claude の messages 配列からテキストコンテンツを抽出し、
 * Gemini SDK に渡すプロンプト文字列に変換する。
 */

import type { ClaudeMessage, ClaudeContentBlock } from '../types.js';

export interface InlineDataPart {
  inlineData: {
    mimeType: string;
    data: string; // base64
  };
}

export interface ConvertedPrompt {
  prompt: string;
  inlineDataParts: InlineDataPart[];
}

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
  if (lower.includes('haiku')) {
    return 'gemini-3.1-flash-lite-preview';
  }
  if (!lower.includes('gemini')) {
    return 'gemini-3-flash-preview';
  }
  return model;
}

/**
 * ClaudeMessage の content を構造化テキストに変換する。
 * tool_use と tool_result ブロックも含めることで、会話履歴の文脈を保持する。
 */
async function formatContentForPrompt(content: string | ClaudeContentBlock[], inlineDataParts: InlineDataPart[]): Promise<string> {
  if (typeof content === 'string') {
    return content;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push(block.text);
    } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      parts.push(`[Tool Call: ${block.name}(${JSON.stringify(block.input)})]`);
    } else if (block.type === 'tool_result') {
      const resultText = typeof block.content === 'string'
        ? block.content
        : block.content.map((b: ClaudeContentBlock) => b.type === 'text' ? b.text : JSON.stringify(b)).join('\n');
      parts.push(`[Tool Result ${block.tool_use_id}: ${resultText}]`);
    } else if (block.type === 'web_search_tool_result') {
      const wb = block;
      const resultText = typeof wb.content === 'string'
        ? wb.content
        : Array.isArray(wb.content)
          ? wb.content.map((b: any) => b.type === 'text' ? b.text : JSON.stringify(b)).join('\n')
          : '';
      parts.push(`[Tool Result ${wb.tool_use_id}: ${resultText}]`);
    } else if (block.type === 'image') {
      try {
        const mediaType = block.source.media_type;
        const base64Data = block.source.data;
        if (mediaType && base64Data) {
          inlineDataParts.push({ inlineData: { mimeType: mediaType, data: base64Data } });
          parts.push(`[Attached: ${mediaType}]`);
        }
      } catch (err) {
        console.error(`[Converter] Error processing image block:`, err);
        parts.push('[Error: Failed to process attached file]');
      }
    } else if (block.type === 'document') {
      try {
        const mediaType = block.source.media_type;
        const base64Data = block.source.data;
        if (mediaType && base64Data) {
          inlineDataParts.push({ inlineData: { mimeType: mediaType, data: base64Data } });
          parts.push(`[Attached: ${mediaType}]`);
        }
      } catch (err) {
        console.error(`[Converter] Error processing document block:`, err);
        parts.push('[Error: Failed to process attached file]');
      }
    }
  }
  return parts.join('\n');
}

/**
 * Claude messages 配列を Gemini のプロンプト文字列に変換する。
 * 単一の user メッセージの場合はテキストをそのまま返す。
 * 複数メッセージ（マルチターン）の場合はロール付きの会話テキストにまとめる。
 */
export async function convertMessagesToPrompt(messages: ClaudeMessage[]): Promise<ConvertedPrompt> {
  if (messages.length === 0) {
    throw new Error('messages に user ロールのメッセージが含まれていません');
  }

  const inlineDataParts: InlineDataPart[] = [];

  // 単一メッセージの場合はシンプルにテキストのみ返す
  if (messages.length === 1 && messages[0].role === 'user') {
    const prompt = await formatContentForPrompt(messages[0].content, inlineDataParts);
    return { prompt, inlineDataParts };
  }

  // マルチターン: ロール付きの会話テキストに変換
  const parts: string[] = [];
  for (const msg of messages) {
    const roleLabel = msg.role === 'user' ? 'User' : 'Assistant';
    const text = await formatContentForPrompt(msg.content, inlineDataParts);
    if (text) {
      parts.push(`${roleLabel}: ${text}`);
    }
  }
  return { prompt: parts.join('\n\n'), inlineDataParts };
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
