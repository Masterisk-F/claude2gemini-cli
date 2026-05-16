/**
 * Claude メッセージ → Gemini プロンプト変換
 *
 * Claude の messages 配列からテキストコンテンツを抽出し、
 * Gemini SDK に渡すプロンプト文字列に変換する。
 */

import type { ClaudeMessage, ClaudeContentBlock } from '../types.js';
import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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
async function formatContentForPrompt(content: string | ClaudeContentBlock[], proxyHome: string, sessionId: string, tempFiles: string[]): Promise<string> {
  if (typeof content === 'string') {
    return content;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push(block.text);
    } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      parts.push(`[Tool Call: ${block.name}(${JSON.stringify(block.input)})]`);
    } else if (block.type === 'tool_result' || block.type === 'web_search_tool_result') {
      const resultText = typeof (block as any).content === 'string'
        ? (block as any).content
        : Array.isArray((block as any).content)
          ? (block as any).content.map((b: any) => b.type === 'text' ? b.text : JSON.stringify(b)).join('\n')
          : '';
      parts.push(`[Tool Result ${(block as any).tool_use_id}: ${resultText}]`);
    } else if (block.type === 'image' || block.type === 'document') {
      try {
        const tempDir = path.join(proxyHome, 'tmp');
        await fsPromises.mkdir(tempDir, { recursive: true });

        const mediaType = (block as any).source.media_type || '';
        let ext = '';
        if (mediaType === 'image/jpeg') ext = '.jpg';
        else if (mediaType === 'image/png') ext = '.png';
        else if (mediaType === 'image/webp') ext = '.webp';
        else if (mediaType === 'image/gif') ext = '.gif';
        else if (mediaType === 'application/pdf') ext = '.pdf';
        else ext = '.bin'; // default fallback

        const fileName = `${sessionId}-${randomUUID()}${ext}`;
        const filePath = path.join(tempDir, fileName);

        const base64Data = (block as any).source.data;
        await fsPromises.writeFile(filePath, Buffer.from(base64Data, 'base64'));
        tempFiles.push(filePath);

        parts.push(`[Attached File: The user attached a file. Please read it using the read_file tool from the absolute path: ${filePath}]`);
      } catch (err) {
        console.error('[Converter] Error processing image/document block:', err);
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
export async function convertMessagesToPrompt(messages: ClaudeMessage[], proxyHome: string, sessionId: string, tempFiles: string[]): Promise<string> {
  if (messages.length === 0) {
    throw new Error('messages に user ロールのメッセージが含まれていません');
  }

  // 単一メッセージの場合はシンプルにテキストのみ返す
  if (messages.length === 1 && messages[0].role === 'user') {
    return await formatContentForPrompt(messages[0].content, proxyHome, sessionId, tempFiles);
  }

  // マルチターン: ロール付きの会話テキストに変換
  const parts: string[] = [];
  for (const msg of messages) {
    const roleLabel = msg.role === 'user' ? 'User' : 'Assistant';
    const text = await formatContentForPrompt(msg.content, proxyHome, sessionId, tempFiles);
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
