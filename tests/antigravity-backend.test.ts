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

/**
 * Delay helper for yielding to the event loop so poll loops can progress.
 */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10));
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
    // waitForTurnComplete is no longer used by the new code, but kept for compat
    waitForTurnComplete = vi.fn().mockResolvedValue(undefined);
    state: any = {
      status: 2, // RUNNING (= CascadeRunStatus.RUNNING)
      trajectory: { steps: [] },
    };
  }

  const cascadeInstance = new MockCascade();

  // Helper: after sendUserCascadeMessage is called, transition to IDLE
  // and add a plannerResponse step so collectTextFromSteps works.
  const setCascadeIdle = vi.fn(() => {
    cascadeInstance.state.status = 1; // IDLE (= CascadeRunStatus.IDLE)
    cascadeInstance.state.trajectory.steps.push(makePlannerStep('Hello! I am an AI assistant.'));
  });

  const mockClient = {
    startCascade: vi.fn().mockResolvedValue(cascadeInstance),
    getCascade: vi.fn().mockReturnValue(cascadeInstance),
    dispose: vi.fn(),
    resolveModelId: vi.fn().mockResolvedValue(42),
    lsClient: {
      sendUserCascadeMessage: vi.fn().mockImplementation(async () => {
        // Simulate LS processing: cascade becomes idle after receiving message
        setCascadeIdle();
      }),
      createCustomizationFile: vi.fn().mockResolvedValue({
        filePath: '/tmp/claude2gemini-mcp-proxy.mcp.json',
      }),
      refreshMcpServers: vi.fn().mockResolvedValue({}),
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
    // McpHub should have started
    expect(backend.mcpHub.port).toBeGreaterThan(0);
  });

  it('should stream text response via createMessageStream', async () => {
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

    const turnEnd = events.find((e: any) => e.type === 'turn_end');
    expect(turnEnd).toBeDefined();
    expect(turnEnd.stopReason).toBe('end_turn');
  });

  it('should handle GeminApiError', () => {
    const err = new GeminiApiError('test error', 500);
    expect(err.message).toBe('test error');
    expect(err.status).toBe(500);
    expect(err.name).toBe('GeminiApiError');
  });
});
