import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { messagesRouter } from '../../../server/routes/messages.js';
import { accountPool } from '../../../server/account-pool.js';
import { childManager } from '../../../server/child-manager.js';

// Mock dependencies
vi.mock('../../../server/account-pool.js', () => ({
  accountPool: {
    nextAccount: vi.fn(),
    getAccountCount: vi.fn(),
    initialize: vi.fn(),
  }
}));

vi.mock('../../../server/child-manager.js', () => ({
  childManager: {
    sendRequest: vi.fn(),
    onMessage: vi.fn(() => vi.fn()),
    onChildExit: vi.fn(() => vi.fn()),
  }
}));

const app = express();
app.use(express.json());
app.use('/v1/messages', messagesRouter);

describe('messages router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 400 if messages are missing', async () => {
    const response = await request(app)
      .post('/v1/messages')
      .send({ model: 'claude-3-sonnet' });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('messages are required');
  });

  it('should return 400 if model is missing', async () => {
    const response = await request(app)
      .post('/v1/messages')
      .send({ messages: [{ role: 'user', content: 'Hello' }] });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('model is required');
  });

  it('should handle a successful non-streaming request', async () => {
    vi.mocked(accountPool.nextAccount).mockReturnValue('test-account');

    let capturedHandler: any;
    vi.mocked(childManager.onMessage).mockImplementation((accountId, handler) => {
      capturedHandler = handler;
      return vi.fn();
    });

    vi.mocked(childManager.sendRequest).mockImplementation(async (accountId, msg) => {
      const sessionId = (msg as any).sessionId;
      if (capturedHandler) {
        // Send messages using a slight delay to ensure the router is ready
        setTimeout(() => {
          capturedHandler({
            type: 'stream_event',
            sessionId,
            event: { type: 'content', value: 'Hello from Gemini!' }
          });
          capturedHandler({
            type: 'turn_end',
            sessionId,
            stopReason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 }
          });
        }, 100);
      }
    });

    const response = await request(app)
      .post('/v1/messages')
      .send({
        model: 'claude-3-sonnet',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false
      });

    expect(response.status).toBe(200);
    expect(response.body.type).toBe('message');
    expect(response.body.content[0].text).toBe('Hello from Gemini!');
    expect(response.body.usage.output_tokens).toBe(5);
  });

  it('should handle errors from child process', async () => {
    vi.mocked(accountPool.nextAccount).mockReturnValue('test-account');

    let capturedHandler: any;
    vi.mocked(childManager.onMessage).mockImplementation((accountId, handler) => {
      capturedHandler = handler;
      return vi.fn();
    });

    vi.mocked(childManager.sendRequest).mockImplementation(async (accountId, msg) => {
      const sessionId = (msg as any).sessionId;
      if (capturedHandler) {
        setTimeout(() => {
          capturedHandler({
            type: 'error',
            sessionId,
            message: 'Something went wrong',
            status: 500
          });
        }, 100);
      }
    });

    const response = await request(app)
      .post('/v1/messages')
      .send({
        model: 'claude-3-sonnet',
        messages: [{ role: 'user', content: 'Hi' }]
      });

    expect(response.status).toBe(500);
    expect(response.body.error.message).toContain('Gemini API error: Something went wrong');
  });
});
