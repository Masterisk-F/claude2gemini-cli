/**
 * Gemini CLI SDK ラッパー
 *
 * GeminiCliAgent のインスタンス管理と、
 * プロンプト送信・レスポンス収集の機能を提供する。
 */

import { GeminiCliAgent } from '@google/gemini-cli-sdk';
import type { GeminiCliSession } from '@google/gemini-cli-sdk';

export interface GeminiBackendOptions {
  instructions?: string;
  model?: string;
  cwd?: string;
}

/**
 * GeminiCliAgent を作成する
 */
function createAgent(options: GeminiBackendOptions): GeminiCliAgent {
  return new GeminiCliAgent({
    instructions: options.instructions || 'You are a helpful assistant.',
    model: options.model,
    cwd: options.cwd || process.cwd(),
  });
}

/**
 * Gemini にプロンプトを送信し、ストリームを直接返す（ストリーミング用）
 */
export function sendPromptStream(
  prompt: string,
  options: GeminiBackendOptions = {},
): { stream: ReturnType<GeminiCliSession['sendStream']> } {
  const agent = createAgent(options);
  const session = agent.session();
  const stream = session.sendStream(prompt);
  return { stream };
}

/**
 * Gemini にプロンプトを送信し、全テキストを蓄積して返す（非ストリーミング）
 */
export async function sendPromptAndCollect(
  prompt: string,
  options: GeminiBackendOptions = {},
): Promise<string> {
  const { stream } = sendPromptStream(prompt, options);

  let fullText = '';
  for await (const chunk of stream) {
    // ServerGeminiContentEvent の value は string 型
    if (chunk.type === 'content' && chunk.value) {
      fullText += chunk.value;
    }
  }

  return fullText;
}

