import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyError } from '../server/routes/messages.js';
import { antigravityBackend, GeminiApiError } from '../server/gemini-backend.js';
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

  describe('request ID generation', () => {
    it('generates a fresh requestId prefixed with req_ for every request', async () => {
      async function* mockStream() {
        yield { type: 'turn_end', usage: { input_tokens: 5, output_tokens: 3 } };
      }
      (antigravityBackend.createMessageStream as any).mockReturnValue(mockStream());

      const payload = {
        model: 'claude-3-opus-20240229',
        messages: [{ role: 'user', content: 'Just a simple message' }],
      };

      await request(app).post('/').send(payload);

      const callArgs = (antigravityBackend.createMessageStream as any).mock.calls[0];
      expect(callArgs[0]).toMatch(/^req_/);
    });

    it('does NOT honor x-session-id header (stateless — every request is independent)', async () => {
      async function* mockStream() {
        yield { type: 'turn_end', usage: { input_tokens: 5, output_tokens: 3 } };
      }
      (antigravityBackend.createMessageStream as any).mockReturnValue(mockStream());

      const payload = {
        model: 'claude-3-opus-20240229',
        messages: [{ role: 'user', content: 'Hi' }],
      };

      await request(app)
        .post('/')
        .set('x-session-id', 'explicit-session-id')
        .send(payload);

      const callArgs = (antigravityBackend.createMessageStream as any).mock.calls[0];
      // x-session-id is ignored: a fresh req_ id is always generated.
      expect(callArgs[0]).toMatch(/^req_/);
      expect(callArgs[0]).not.toBe('explicit-session-id');
    });

    it('generates a unique requestId per call (no cross-request state)', async () => {
      async function* mockStream() {
        yield { type: 'turn_end', usage: { input_tokens: 5, output_tokens: 3 } };
      }
      (antigravityBackend.createMessageStream as any).mockReturnValue(mockStream());

      const payload = {
        model: 'claude-3-opus-20240229',
        messages: [{ role: 'user', content: 'Hi' }],
      };

      await request(app).post('/').send(payload);
      await request(app).post('/').send(payload);

      const id1 = (antigravityBackend.createMessageStream as any).mock.calls[0][0];
      const id2 = (antigravityBackend.createMessageStream as any).mock.calls[1][0];
      expect(id1).toMatch(/^req_/);
      expect(id2).toMatch(/^req_/);
      expect(id1).not.toBe(id2);
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
