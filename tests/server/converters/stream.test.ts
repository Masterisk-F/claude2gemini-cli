import { describe, it, expect, vi } from 'vitest';
import { streamGeminiToClaudeSSE, setupSSEHeaders } from '../../../server/converters/stream.js';
import type { Response } from 'express';

describe('stream converter', () => {
  describe('setupSSEHeaders', () => {
    it('should set SSE headers', () => {
      const res = {
        setHeader: vi.fn(),
        flushHeaders: vi.fn(),
      } as unknown as Response;

      setupSSEHeaders(res);
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
      expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
      expect(res.flushHeaders).toHaveBeenCalled();
    });
  });

  describe('streamGeminiToClaudeSSE', () => {
    it('should correctly stream text content', async () => {
      const mockRes = {
        setHeader: vi.fn(),
        flushHeaders: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        writableEnded: false,
      } as unknown as Response;

      // Mock Child process stream
      async function* mockChildStream() {
        yield { type: 'stream_event', event: { type: 'content', value: 'Hello' } };
        yield { type: 'stream_event', event: { type: 'content', value: ' world!' } };
        yield { type: 'turn_end', stopReason: 'end_turn', usage: { output_tokens: 10 } };
      }

      const mockSessionStore = {
        addPendingToolCall: vi.fn(),
      } as any;

      await streamGeminiToClaudeSSE(mockChildStream(), mockRes, 'test-model', 'sess-1', mockSessionStore, []);

      // Verify SSE events were sent
      const writes = (mockRes.write as any).mock.calls.map((call: [string]) => call[0]);
      expect(writes.some((w: string) => w.includes('message_start'))).toBe(true);
      expect(writes.some((w: string) => w.includes('content_block_start'))).toBe(true);
      expect(writes.some((w: string) => w.includes('text_delta') && w.includes('Hello'))).toBe(true);
      expect(writes.some((w: string) => w.includes('text_delta') && w.includes(' world!'))).toBe(true);
      expect(writes.some((w: string) => w.includes('message_delta') && w.includes('end_turn'))).toBe(true);
      expect(writes.some((w: string) => w.includes('message_stop'))).toBe(true);
      expect(mockRes.end).toHaveBeenCalled();
    });

    it('should correctly stream tool calls', async () => {
      const mockRes = {
        setHeader: vi.fn(),
        flushHeaders: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        writableEnded: false,
      } as unknown as Response;

      // Mock Child process stream with tool call
      async function* mockChildStream() {
        yield { type: 'tool_call', callId: 'call_1', name: 'get_weather', args: { location: 'Tokyo' } };
        yield { type: 'turn_end', stopReason: 'tool_use', usage: { output_tokens: 5 } };
      }

      const mockSessionStore = {
        addPendingToolCall: vi.fn(),
      } as any;

      await streamGeminiToClaudeSSE(mockChildStream(), mockRes, 'test-model', 'sess-1', mockSessionStore, ['get_weather']);

      // Verify tool call SSE events
      const writes = (mockRes.write as any).mock.calls.map((call: [string]) => call[0]);
      expect(writes.some((w: string) => w.includes('tool_use') && w.includes('get_weather'))).toBe(true);
      expect(writes.some((w: string) => w.includes('input_json_delta') && w.includes('Tokyo'))).toBe(true);
      expect(mockSessionStore.addPendingToolCall).toHaveBeenCalledWith('sess-1', 'call_1');
    });

    it('should handle errors in the child stream', async () => {
        const mockRes = {
          setHeader: vi.fn(),
          flushHeaders: vi.fn(),
          write: vi.fn(),
          end: vi.fn(),
          writableEnded: false,
        } as unknown as Response;

        // Mock child stream with error
        async function* mockChildStream() {
          yield { type: 'error', message: 'API failure', status: 500 };
        }

        const mockSessionStore = {
          addPendingToolCall: vi.fn(),
        } as any;

        await streamGeminiToClaudeSSE(mockChildStream(), mockRes, 'test-model', 'sess-1', mockSessionStore, []);

        const writes = (mockRes.write as any).mock.calls.map((call: [string]) => call[0]);
        expect(writes.some((w: string) => w.includes('event: error') && w.includes('API failure'))).toBe(true);
        expect(mockRes.end).toHaveBeenCalled();
      });
  });
});
