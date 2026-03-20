/**
 * Gemini CLI SDK ラッパー
 *
 * GeminiCliAgent のインスタンス管理と、
 * プロンプト送信・レスポンス収集の機能を提供する。
 */

import { GeminiCliAgent } from '@google/gemini-cli-sdk';

let agentInstance: GeminiCliAgent | null = null;

export interface GeminiBackendOptions {
  instructions?: string;
  model?: string;
  cwd?: string;
}

/**
 * GeminiCliAgent のシングルトンインスタンスを取得する。
 * instructions が変わった場合は再生成する。
 */
function getAgent(options: GeminiBackendOptions): GeminiCliAgent {
  // 毎回新しい agent を作成（system prompt が変わる可能性があるため）
  agentInstance = new GeminiCliAgent({
    instructions: options.instructions || 'You are a helpful assistant.',
    model: options.model,
    cwd: options.cwd || process.cwd(),
  });
  return agentInstance;
}

/**
 * Gemini にプロンプトを送信し、全テキストを蓄積して返す（非ストリーミング）
 */
export async function sendPromptAndCollect(
  prompt: string,
  options: GeminiBackendOptions = {},
): Promise<string> {
  const agent = getAgent(options);
  const session = agent.session();
  const stream = session.sendStream(prompt);

  let fullText = '';
  for await (const chunk of stream) {
    // ServerGeminiContentEvent の value は string 型
    if (chunk.type === 'content' && chunk.value) {
      fullText += chunk.value;
    }
  }

  return fullText;
}
