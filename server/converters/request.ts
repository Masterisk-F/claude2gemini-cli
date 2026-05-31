/**
 * Claude メッセージ → Gemini プロンプト変換ユーティリティ
 */

/**
 * Claude モデル名を Antigravity LS のモデル名に変換する。
 * 正式なモデル名（アンダースコアを含む）が指定された場合はそのまま返し、
 * それ以外はエイリアスとしてマッピングを行う。
 */
export function mapModelName(model: string): string {
  const lower = model.toLowerCase();

  // 正式なモデル名が指定された場合はそのまま返す
  // (Antigravity LS の内部モデル名形式: Gemini_... または Claude_...)
  if (model.includes('_')) {
    return model;
  }

  // Claude エイリアス
  if (lower.includes('opus')) {
    return 'Claude_Opus_4.6_Thinking';
  }
  if (lower.includes('sonnet')) {
    return 'Claude_Sonnet_4.6_Thinking';
  }
  if (lower.includes('haiku')) {
    return 'Gemini_3.1_Flash_Lite';
  }

  // Gemini エイリアス
  if (lower.includes('gemini')) {
    if (lower.includes('pro')) {
      if (lower.includes('low')) return 'Gemini_3.1_Pro_Low';
      return 'Gemini_3.1_Pro_High';
    }
    if (lower.includes('flash')) {
      if (lower.includes('lite')) return 'Gemini_3.1_Flash_Lite';
      if (lower.includes('low')) return 'Gemini_3.5_Flash_Low';
      if (lower.includes('medium')) return 'Gemini_3.5_Flash_Medium';
      return 'Gemini_3.5_Flash_High';
    }
  }

  // 簡易エイリアス
  if (lower === 'pro') return 'Gemini_3.1_Pro_High';
  if (lower === 'flash') return 'Gemini_3.5_Flash_High';
  if (lower === 'flash-lite') return 'Gemini_3.1_Flash_Lite';

  // デフォルト
  return 'Gemini_3.5_Flash_High';
}

/**
 * Claude の system パラメータを抽出・正規化する
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
