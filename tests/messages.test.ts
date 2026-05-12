import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyError } from '../server/routes/messages.js';
import { childManager } from '../server/child-manager.js';
import { sessionStore } from '../server/session-store.js';

vi.mock('../server/child-manager.js', () => ({
  childManager: {
    sendRequest: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    onChildExit: vi.fn(() => () => {}),
  }
}));

describe('messages route error handling', () => {
  describe('classifyError', () => {
    it('classifies QUOTA_EXHAUSTED as overloaded_error', () => {
      const result = classifyError(new Error('QUOTA_EXHAUSTED'));
      expect(result.statusCode).toBe(500);
      expect(result.errorType).toBe('overloaded_error');
    });

    it('classifies RESOURCE_EXHAUSTED as overloaded_error', () => {
      const result = classifyError(new Error('RESOURCE_EXHAUSTED'));
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

    it('classifies TerminalQuotaError as overloaded_error', () => {
      const error: any = new Error('Terminal quota exceeded');
      error.name = 'TerminalQuotaError';
      const result = classifyError(error);
      expect(result.statusCode).toBe(500);
      expect(result.errorType).toBe('overloaded_error');
    });

    it('classifies generic error as api_error 500', () => {
      const result = classifyError(new Error('Unknown generic error'));
      expect(result.statusCode).toBe(500);
      expect(result.errorType).toBe('api_error');
    });
  });
});
import express from 'express';
import request from 'supertest';
import { messagesRouter } from '../server/routes/messages.js';
import { accountPool } from '../server/account-pool.js';

vi.mock('../server/account-pool.js', () => ({
  accountPool: {
    nextAccount: vi.fn(() => 'test-account-1'),
  }
}));

vi.mock('../server/session-store.js', () => ({
  sessionStore: {
    resolveToolCall: vi.fn(),
    getSession: vi.fn(),
    getOrCreateSession: vi.fn(() => ({ accountId: 'test-account-1' })),
    addPendingToolCall: vi.fn(),
  }
}));

const app = express();
app.use(express.json());
app.use('/', messagesRouter);

describe('POST /', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appends text blocks as a separate property in the tool_result object', async () => {
    // Mock resolveToolCall to return a mock session ID
    (sessionStore.resolveToolCall as any).mockReturnValue('mock-session-id');
    (sessionStore.getSession as any).mockReturnValue({ accountId: 'test-account-1' });

    let onMessageCallback: any = null;
    (childManager.onMessage as any).mockImplementation((accId: string, cb: any) => {
      onMessageCallback = cb;
      return () => {}; // cleanup fn
    });

    const payload = {
      model: 'claude-3-opus-20240229',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_123',
              content: 'Original tool result'
            },
            {
              type: 'text',
              text: 'User additional instruction'
            }
          ]
        }
      ]
    };

    const promise = request(app)
      .post('/')
      .send(payload)
      .expect(200);

    // Provide content so buildClaudeResponse doesn't throw
    setTimeout(() => {
      if (onMessageCallback) {
        onMessageCallback({ type: 'stream_event', sessionId: 'mock-session-id', event: { type: 'content', value: 'Hello' } });
        onMessageCallback({ type: 'turn_end', sessionId: 'mock-session-id' });
      }
    }, 50);

    await promise;

    expect(childManager.sendRequest).toHaveBeenCalledWith(
      'test-account-1',
      expect.objectContaining({
        type: 'tool_result',
        toolCallId: 'tool_123',
        result: JSON.stringify({
          result: 'Original tool result',
          user_additional_input: 'User additional instruction'
        })
      })
    );
  });
});
