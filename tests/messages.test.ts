import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyError } from '../server/routes/messages.js';
import { antigravityBackend, GeminiApiError } from '../server/gemini-backend.js';
import { sessionStore } from '../server/session-store.js';
import express from 'express';
import request from 'supertest';
import { messagesRouter } from '../server/routes/messages.js';

vi.mock('../server/gemini-backend.js', () => {
  return {
    GeminiApiError: class extends Error {
        constructor(message: string, public status?: number) {
            super(message);
        }
    },
    antigravityBackend: {
      initialize: vi.fn().mockResolvedValue(undefined),
      createMessageStream: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      cancelSession: vi.fn().mockResolvedValue(undefined),
    }
  };
});

vi.mock('../server/session-store.js', () => ({
  sessionStore: {
    resolveToolCall: vi.fn(),
    addPendingToolCall: vi.fn(),
    deleteSession: vi.fn(),
  }
}));

const app = express();
app.use(express.json());
app.use('/', messagesRouter);

describe('messages route error handling', () => {
  describe('classifyError', () => {
    it('classifies QUOTA_EXHAUSTED as overloaded_error', () => {
      const result = classifyError(new Error('QUOTA_EXHAUSTED'));
      expect(result.statusCode).toBe(500);
      expect(result.errorType).toBe('overloaded_error');
    });

    it('classifies status 429 as overloaded_error', () => {
      const error: any = new Error('Test 429 error');
      error.status = 429;
      const result = classifyError(error);
      expect(result.statusCode).toBe(500);
      expect(result.errorType).toBe('overloaded_error');
    });

    it('classifies generic error as api_error 500', () => {
      const result = classifyError(new Error('Unknown generic error'));
      expect(result.statusCode).toBe(500);
      expect(result.errorType).toBe('api_error');
    });

    it('maps ConnectRPC ResourceExhausted (code=8) to 429 overloaded_error', () => {
      const error: any = new Error('[resource_exhausted] quota exceeded');
      error.code = 8;
      const result = classifyError(error);
      expect(result.statusCode).toBe(429);
      expect(result.errorType).toBe('overloaded_error');
    });

    it('maps ConnectRPC Unauthenticated (code=16) to 401 authentication_error', () => {
      const error: any = new Error('[unauthenticated] auth required');
      error.code = 16;
      const result = classifyError(error);
      expect(result.statusCode).toBe(401);
      expect(result.errorType).toBe('authentication_error');
    });

    it('maps ConnectRPC Unavailable (code=14) to 503 api_error', () => {
      const error: any = new Error('[unavailable] service unavailable');
      error.code = 14;
      const result = classifyError(error);
      expect(result.statusCode).toBe(503);
      expect(result.errorType).toBe('api_error');
    });

    it('maps ConnectRPC DeadlineExceeded (code=4) to 504 api_error', () => {
      const error: any = new Error('[deadline_exceeded] timeout');
      error.code = 4;
      const result = classifyError(error);
      expect(result.statusCode).toBe(504);
      expect(result.errorType).toBe('api_error');
    });

    it('maps ConnectRPC PermissionDenied (code=7) to 403 authentication_error', () => {
      const error: any = new Error('[permission_denied] denied');
      error.code = 7;
      const result = classifyError(error);
      expect(result.statusCode).toBe(403);
      expect(result.errorType).toBe('authentication_error');
    });
  });
});

describe('POST /', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns successful response for a simple message', async () => {
    async function* mockStream() {
      yield { type: 'stream_event', event: { type: 'content', value: 'Hello' } };
      yield { type: 'turn_end', usage: { input_tokens: 10, output_tokens: 5, context_window_estimated_tokens: 30000 } };
    }
    (antigravityBackend.createMessageStream as any).mockReturnValue(mockStream());

    const payload = {
      model: 'claude-3-opus-20240229',
      messages: [{ role: 'user', content: 'Hi' }]
    };

    const res = await request(app)
      .post('/')
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.content[0].text).toBe('Hello');
    expect(res.body.usage.input_tokens).toBe(10);
    expect(res.body.usage.output_tokens).toBe(5);
    expect(res.body.usage.context_window_estimated_tokens).toBe(30000);
  });

  describe('session ID resolution', () => {
    it('resolves session ID from tool_result when last message is user', async () => {
      const resolveSpy = vi.spyOn(sessionStore, 'resolveToolCall').mockReturnValue('resolved-session-123');

      async function* mockStream() {
        yield { type: 'turn_end', usage: { input_tokens: 5, output_tokens: 3 } };
      }
      (antigravityBackend.createMessageStream as any).mockReturnValue(mockStream());

      const payload = {
        model: 'claude-3-opus-20240229',
        messages: [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-abc', name: 'Bash', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-abc', content: 'done' }] },
        ],
      };

      await request(app).post('/').send(payload);

      expect(resolveSpy).toHaveBeenCalledWith('tool-abc');
      expect(antigravityBackend.createMessageStream).toHaveBeenCalledWith(
        'resolved-session-123',
        expect.any(Object)
      );
    });

    it('resolves session ID from tool_result even when Claude Code appends a system message at the end', async () => {
      const resolveSpy = vi.spyOn(sessionStore, 'resolveToolCall').mockReturnValue('resolved-session-456');

      async function* mockStream() {
        yield { type: 'turn_end', usage: { input_tokens: 5, output_tokens: 3 } };
      }
      (antigravityBackend.createMessageStream as any).mockReturnValue(mockStream());

      // Simulates the bug scenario: Claude Code appends a system message after the user tool_result
      const payload = {
        model: 'claude-3-opus-20240229',
        messages: [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-xyz', name: 'Bash', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-xyz', content: 'done' }] },
          { role: 'system', content: 'The task tools haven\'t been used recently...' },
        ],
      };

      await request(app).post('/').send(payload);

      // Must find the tool_result in the user message, skipping the trailing system message
      expect(resolveSpy).toHaveBeenCalledWith('tool-xyz');
      expect(antigravityBackend.createMessageStream).toHaveBeenCalledWith(
        'resolved-session-456',
        expect.any(Object)
      );
    });

    it('generates a new session ID when no tool_result is found in any message', async () => {
      async function* mockStream() {
        yield { type: 'turn_end', usage: { input_tokens: 5, output_tokens: 3 } };
      }
      (antigravityBackend.createMessageStream as any).mockReturnValue(mockStream());

      const payload = {
        model: 'claude-3-opus-20240229',
        messages: [
          { role: 'user', content: 'Just a simple message' },
          { role: 'system', content: 'Some system prompt context' },
        ],
      };

      await request(app).post('/').send(payload);

      // Should create a new session with session_ prefix
      const callArgs = (antigravityBackend.createMessageStream as any).mock.calls[0];
      expect(callArgs[0]).toMatch(/^session_/);
    });

    it('uses x-session-id header when provided, skipping tool_result resolution', async () => {
      const resolveSpy = vi.spyOn(sessionStore, 'resolveToolCall');

      async function* mockStream() {
        yield { type: 'turn_end', usage: { input_tokens: 5, output_tokens: 3 } };
      }
      (antigravityBackend.createMessageStream as any).mockReturnValue(mockStream());

      const payload = {
        model: 'claude-3-opus-20240229',
        messages: [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-ignored', name: 'Bash', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-ignored', content: 'done' }] },
        ],
      };

      await request(app)
        .post('/')
        .set('x-session-id', 'explicit-session-id')
        .send(payload);

      expect(resolveSpy).not.toHaveBeenCalled();
      expect(antigravityBackend.createMessageStream).toHaveBeenCalledWith(
        'explicit-session-id',
        expect.any(Object)
      );
    });
  });

  it('calls cancelSession when client disconnects early', async () => {
    async function* mockStream() {
      yield { type: 'stream_event', event: { type: 'content', value: 'Hello' } };
      // Wait indefinitely to simulate ongoing stream
      await new Promise<void>(() => {});
      yield { type: 'turn_end', usage: { input_tokens: 10, output_tokens: 5 } };
    }

    const cancelSpy = vi.spyOn(antigravityBackend, 'cancelSession').mockResolvedValue(undefined);
    (antigravityBackend.createMessageStream as any).mockReturnValue(mockStream());

    const reqObj = request(app)
      .post('/')
      .send({
        model: 'claude-3-opus-20240229',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true
      });

    // Wait a brief moment to let request connect, then abort
    setTimeout(() => {
      reqObj.abort();
    }, 50);

    try {
      await reqObj;
    } catch (e) {
      // Expected to throw due to abort
    }

    // Allow time for the close event listener and async cancelSession to be invoked
    await new Promise((r) => setTimeout(r, 50));

    expect(cancelSpy).toHaveBeenCalled();
  });
});
