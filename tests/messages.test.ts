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
});
