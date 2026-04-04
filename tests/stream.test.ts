import { describe, it, expect, vi } from 'vitest';
import { streamGeminiToClaudeSSE } from '../server/converters/stream.js';
import { GeminiApiError } from '../server/gemini-backend.js';

describe('streamGeminiToClaudeSSE error handling', () => {
  it('emits error event and stops gracefully when stream throws', async () => {
    const mockRes = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      writableEnded: false,
      headersSent: false,
    } as any;

    const mockSessionStore = { addPendingToolCall: vi.fn() } as any;

    async function* errorGenerator() {
      yield { type: 'stream_event', event: { type: 'content', value: 'Hello' } };
      throw new Error('Stream interrupted midway');
    }

    await streamGeminiToClaudeSSE(errorGenerator(), mockRes, 'test-model', 'sess_1', mockSessionStore, []);

    // 最初のブロックが開始されたことを確認
    expect(mockRes.write).toHaveBeenCalledWith(expect.stringContaining('event: content_block_start'));

    // エラーイベントが出力されたことを確認
    expect(mockRes.write).toHaveBeenCalledWith(expect.stringContaining('event: error'));

    // APIエラーとして分類されていれば、メッセージが含まれるはず
    expect(mockRes.write).toHaveBeenCalledWith(expect.stringContaining('Stream interrupted midway'));

    // 最終的に message_stop が送信されて end() されることを確認
    expect(mockRes.write).toHaveBeenCalledWith(expect.stringContaining('event: message_stop'));
    expect(mockRes.end).toHaveBeenCalled();
  });

  it('throws GeminiApiError if stream yields fatal_error', async () => {
    const mockRes = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      writableEnded: false,
      headersSent: false,
    } as any;

    const mockSessionStore = { addPendingToolCall: vi.fn() } as any;

    async function* errorGenerator() {
      yield { type: 'fatal_error', message: 'Child process died', status: 500 };
    }

    await streamGeminiToClaudeSSE(errorGenerator(), mockRes, 'test-model', 'sess_1', mockSessionStore, []);

    // fatal_error の場合、GeminiApiErrorがthrowされ、catchブロックでエラーイベントが出力される
    expect(mockRes.write).toHaveBeenCalledWith(expect.stringContaining('event: error'));
    expect(mockRes.write).toHaveBeenCalledWith(expect.stringContaining('Child process died'));
    expect(mockRes.end).toHaveBeenCalled();
  });
});
