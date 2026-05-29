import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AntigravityBackend, GeminiApiError } from '../server/gemini-backend.js';

function makePlannerStep(text: string): any {
  return {
    status: 4, // COMPLETED
    step: {
      case: 'plannerResponse',
      value: { response: text, thinking: '' },
    },
    requestedInteraction: null,
  };
}

vi.mock('antigravity-client', () => {
  class MockCascade {
    cascadeId = 'cascade-test-1';
    run = vi.fn();
    sendMessage = vi.fn().mockResolvedValue({});
    getHistory = vi.fn().mockResolvedValue({ trajectory: { steps: [] } });
    dispose = vi.fn();
    on = vi.fn().mockReturnThis();
    off = vi.fn().mockReturnThis();
    emit = vi.fn();
    /** Simulates LS adding a plannerResponse step after a message round-trip. */
    waitForTurnComplete = vi.fn().mockImplementation(async () => {
      this.state.trajectory.steps.push(makePlannerStep('Hello! I am an AI assistant.'));
      this.state.status = 4; // IDLE
    });
    state: any = {
      status: 1, // RUNNING
      trajectory: { steps: [] },
    };
  }

  const cascadeInstance = new MockCascade();
  const mockClient = {
    startCascade: vi.fn().mockResolvedValue(cascadeInstance),
    getCascade: vi.fn().mockReturnValue(cascadeInstance),
    dispose: vi.fn(),
    resolveModelId: vi.fn().mockResolvedValue(42),
    lsClient: {
      sendUserCascadeMessage: vi.fn().mockResolvedValue({}),
    },
  };

  return {
    AntigravityClient: {
      launch: vi.fn().mockResolvedValue(mockClient),
    },
    readAuthStatus: vi.fn().mockReturnValue({ apiKey: 'test-api-key' }),
    T: {
      Text: (val: string) => ({ chunk: { case: 'text', value: val } }),
    },
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
