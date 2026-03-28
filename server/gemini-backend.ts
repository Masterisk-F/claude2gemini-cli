/**
 * Gemini API からのエラーを表すカスタムエラークラス。
 * SDK がストリームイベントとして返すエラーをキャプチャし、
 * HTTP ステータスコード情報を保持する。
 */
export class GeminiApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'GeminiApiError';
  }
}
