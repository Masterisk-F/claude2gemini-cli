import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AntigravityBackend, GeminiApiError } from '../server/gemini-backend.js';

vi.mock('antigravity-client', () => {
  class MockCascade {
    cascadeId = 'cascade-test-1';
    run = vi.fn().mockResolvedValue({
      text: 'Hello! I am an AI assistant.',
      newSteps: [],
      finalStatus: 'idle',
      timedOut: false,
    });
    sendMessage = vi.fn().mockResolvedValue({});
    getHistory = vi.fn().mockResolvedValue({ trajectory: { steps: [] } });
    dispose = vi.fn();
    on = vi.fn().mockReturnThis();
    off = vi.fn().mockReturnThis();
    state = { status: 1, trajectory: null };
  }

  const mockClient = {
    startCascade: vi.fn().mockResolvedValue(new MockCascade()),
    getCascade: vi.fn().mockReturnValue(new MockCascade()),
    dispose: vi.fn(),
  };

  class MockLauncher {
    httpsPort = 12345;
    csrfToken = 'test-token';
    stop = vi.fn().mockResolvedValue(undefined);
  }

  return {
    AntigravityClient: {
      launch: vi.fn().mockResolvedValue(mockClient),
    },
    T: {
      Text: (val: string) => ({ chunk: { case: 'text', value: val } }),
    }
  };
});

describe('AntigravityBackend', () => {
  it('should initialize successfully', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();
    expect(backend).toBeDefined();
  });

  it('should stream text response via cascade.run()', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    const stream = backend.createMessageStream('session-1', {
      model: 'Gemini_3.5_Flash_High',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    const streamEvent = events.find((e: any) => e.type === 'stream_event');
    expect(streamEvent).toBeDefined();
    expect(streamEvent.event.value).toContain('AI assistant');
  });

  it('should handle GeminApiError', () => {
    const err = new GeminiApiError('test error', 500);
    expect(err.message).toBe('test error');
    expect(err.status).toBe(500);
    expect(err.name).toBe('GeminiApiError');
  });
});
