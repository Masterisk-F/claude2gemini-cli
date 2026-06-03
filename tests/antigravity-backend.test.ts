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
    cancel = vi.fn().mockResolvedValue(undefined);
    cancelAndWait = vi.fn().mockResolvedValue(undefined);
    on = vi.fn((event: string, handler: Function) => {
      if (!this._handlers.has(event)) this._handlers.set(event, []);
      this._handlers.get(event)!.push(handler);
      return this;
    });
    off = vi.fn((event: string, handler: Function) => {
      const h = this._handlers.get(event);
      if (h) { const i = h.indexOf(handler); if (i >= 0) h.splice(i, 1); }
      return this;
    });
    emit = vi.fn();
    /** Fire a stored event handler (for testing async error events) */
    emitEvent(event: string, ...args: any[]) {
      (this._handlers.get(event) || []).forEach((h: Function) => h(...args));
    }
    private _handlers: Map<string, Function[]> = new Map();
    waitForTurnComplete = vi.fn().mockResolvedValue(undefined);
    waitForTurnOrToolCall = vi.fn().mockResolvedValue('idle');
    state: any = {
      status: 2, // RUNNING (= CascadeRunStatus.RUNNING)
      trajectory: { steps: [] },
    };
  }

  const cascadeInstance = new MockCascade();

  const setCascadeIdle = vi.fn(() => {
    cascadeInstance.state.status = 1; // IDLE (= CascadeRunStatus.IDLE)
    cascadeInstance.state.trajectory.steps.push(makePlannerStep('Hello! I am an AI assistant.'));
  });

  const mockUsageResponse = {
    generatorMetadata: [
      {
        metadata: {
          case: 'chatModel',
          value: {
            usage: {
              inputTokens: 42,
              outputTokens: 128,
              cacheReadTokens: 8,
              cacheWriteTokens: 0,
            },
            chatStartMetadata: {
              contextWindowMetadata: {
                estimatedTokensUsed: 25000,
              },
            },
          },
        },
      },
    ],
  };

  const mockClient = {
    startCascade: vi.fn().mockResolvedValue(cascadeInstance),
    getCascade: vi.fn().mockReturnValue(cascadeInstance),
    dispose: vi.fn(),
    resolveModelId: vi.fn().mockResolvedValue(42),
    lsClient: {
      sendUserCascadeMessage: vi.fn().mockImplementation(async () => {
        setCascadeIdle();
      }),
      createCustomizationFile: vi.fn().mockResolvedValue({
        filePath: '/tmp/claude2gemini-mcp-proxy.mcp.json',
      }),
      refreshMcpServers: vi.fn().mockResolvedValue({}),
      revertToCascadeStep: vi.fn().mockResolvedValue({}),
      deleteCascadeTrajectory: vi.fn().mockResolvedValue({}),
      getCascadeTrajectoryGeneratorMetadata: vi.fn().mockResolvedValue(mockUsageResponse),
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize successfully', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();
    expect(backend).toBeDefined();
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

  it('should handle GeminiApiError', () => {
    const err = new GeminiApiError('test error', 500);
    expect(err.message).toBe('test error');
    expect(err.status).toBe(500);
    expect(err.name).toBe('GeminiApiError');
  });

  // --- 新しい機能のテストケース ---

  it('should merge conversation history when starting a session with past messages', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    const mockCascade = await (backend as any).client.startCascade();
    mockCascade.state.trajectory.steps = [];

    const sendSpy = vi.spyOn((backend as any).client.lsClient, 'sendUserCascadeMessage');

    const stream = backend.createMessageStream('session-past-history', {
      model: 'Gemini_3.5_Flash_High',
      messages: [
        { role: 'user', content: 'What is 1+1?' },
        { role: 'assistant', content: 'It is 2.' },
        { role: 'user', content: 'And what is 2+2?' }
      ],
    });

    for await (const _ of stream) {}

    expect(sendSpy).toHaveBeenCalled();
    const lastCallReq = sendSpy.mock.calls[0][0] as any;
    const sentText = lastCallReq.items[0].chunk.value;

    expect(sentText).toContain('=== CONVERSATION HISTORY ===');
    expect(sentText).toContain('User: What is 1+1?');
    expect(sentText).toContain('Assistant: It is 2.');
    expect(sentText).toContain('=== USER INSTRUCTION ===\nAnd what is 2+2?');
  });

  it('should revert cascade when history mismatch is detected (rewind)', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    const mockCascade = await (backend as any).client.startCascade();
    mockCascade.state.trajectory.steps = [
      {
        step: {
          case: 'userInput',
          value: { userResponse: 'What is 1+1?' }
        }
      },
      makePlannerStep('It is 2.'),
      {
        step: {
          case: 'userInput',
          value: { userResponse: 'And what is 2+2?' }
        }
      },
      makePlannerStep('It is 4.')
    ];

    const revertSpy = vi.spyOn((backend as any).client.lsClient, 'revertToCascadeStep');

    // Add a mock pending call to verify it gets cleared
    backend.mcpHub.pending.set('mock_call_123', {
      callId: 'mock_call_123',
      name: 'some_tool',
      args: {},
      resolve: vi.fn(),
      reject: vi.fn(),
      timer: setTimeout(() => {}, 10000),
    });
    expect(backend.mcpHub.hasPendingCalls()).toBe(true);

    const stream = backend.createMessageStream('session-rewind', {
      model: 'Gemini_3.5_Flash_High',
      messages: [
        { role: 'user', content: 'What is 1+1?' },
        { role: 'assistant', content: 'It is 2.' },
        { role: 'user', content: 'And what is 3+3?' }
      ],
    });

    for await (const _ of stream) {}

    expect(revertSpy).toHaveBeenCalled();
    const lastCallReq = revertSpy.mock.calls[0][0] as any;
    expect(lastCallReq.stepIndex).toBe(1); // Q2 の直前である A1（ステップ 1）まで巻き戻す
    expect(backend.mcpHub.hasPendingCalls()).toBe(false); // Pending call should be cleared
  });

  it('should fallback to plain text message when tool result is received but cascade is not waiting for tool', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    const mockCascade = await (backend as any).client.startCascade();
    mockCascade.state.trajectory.steps = [];

    const sendSpy = vi.spyOn((backend as any).client.lsClient, 'sendUserCascadeMessage');

    const stream = backend.createMessageStream('session-tool-fallback', {
      model: 'Gemini_3.5_Flash_High',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_abc123',
              content: 'Mocked tool output success',
              is_error: false
            }
          ]
        }
      ],
    });

    for await (const _ of stream) {}

    expect(sendSpy).toHaveBeenCalled();
    const lastCallReq = sendSpy.mock.calls[0][0] as any;
    const sentText = lastCallReq.items[0].chunk.value;

    expect(sentText).toContain('=== TOOL RESULT ===');
    expect(sentText).toContain('Tool Use ID: call_abc123');
    expect(sentText).toContain('Mocked tool output success');
  });

  it('should handle multiple simultaneous tool results', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    const mockCascade = await (backend as any).client.startCascade();
    mockCascade.state.trajectory.steps = [];

    // Register two pending calls
    backend.mcpHub.pending.set('call_1', {
      callId: 'call_1',
      name: 'tool_1',
      args: {},
      resolve: vi.fn(),
      reject: vi.fn(),
      timer: setTimeout(() => {}, 10000),
    });
    backend.mcpHub.pending.set('call_2', {
      callId: 'call_2',
      name: 'tool_2',
      args: {},
      resolve: vi.fn(),
      reject: vi.fn(),
      timer: setTimeout(() => {}, 10000),
    });

    const stream = backend.createMessageStream('session-multi-tool', {
      model: 'Gemini_3.5_Flash_High',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: 'Result 1' },
            { type: 'tool_result', tool_use_id: 'call_2', content: 'Result 2' }
          ]
        }
      ],
    });

    for await (const _ of stream) {}

    expect(backend.mcpHub.pending.has('call_1')).toBe(false);
    expect(backend.mcpHub.pending.has('call_2')).toBe(false);
  });

  it('should handle multiple tool result fallbacks', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    const mockCascade = await (backend as any).client.startCascade();
    mockCascade.state.trajectory.steps = [];

    const sendSpy = vi.spyOn((backend as any).client.lsClient, 'sendUserCascadeMessage');

    const stream = backend.createMessageStream('session-multi-fallback', {
      model: 'Gemini_3.5_Flash_High',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'fallback_1', content: 'FB 1' },
            { type: 'tool_result', tool_use_id: 'fallback_2', content: 'FB 2' }
          ]
        }
      ],
    });

    for await (const _ of stream) {}

    expect(sendSpy).toHaveBeenCalled();
    const lastCallReq = sendSpy.mock.calls[0][0] as any;
    const sentText = lastCallReq.items[0].chunk.value;

    expect(sentText).toContain('=== TOOL RESULT ===');
    expect(sentText).toContain('Tool Use ID: fallback_1');
    expect(sentText).toContain('FB 1');
    expect(sentText).toContain('Tool Use ID: fallback_2');
    expect(sentText).toContain('FB 2');
  });

  it('should yield error message when cascade emits error event', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    const mockCascade = await (backend as any).client.startCascade();
    mockCascade.state.trajectory.steps = [];

    // Override sendUserCascadeMessage to fire the error event during processing
    const origSend = (backend as any).client.lsClient.sendUserCascadeMessage;
    (backend as any).client.lsClient.sendUserCascadeMessage = vi.fn().mockImplementation(async () => {
      mockCascade.emitEvent('error', Object.assign(new Error('LS stream connection lost'), { code: 14 }));
    });

    const stream = backend.createMessageStream('session-cascade-error', {
      model: 'Gemini_3.5_Flash_High',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.length).toBe(1);
    expect(events[0].type).toBe('error');
    expect(events[0].message).toContain('LS stream connection lost');
    expect(events[0].status).toBe(503);

    // Restore
    (backend as any).client.lsClient.sendUserCascadeMessage = origSend;
  });

  it('should yield error when trajectory contains errorMessage step', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    const mockCascade = await (backend as any).client.startCascade();
    mockCascade.state.trajectory.steps = [];

    // Override sendUserCascadeMessage to populate an errorMessage step
    const origSend = (backend as any).client.lsClient.sendUserCascadeMessage;
    (backend as any).client.lsClient.sendUserCascadeMessage = vi.fn().mockImplementation(async () => {
      mockCascade.state.trajectory.steps.push({
        status: 11, // error
        step: {
          case: 'errorMessage',
          value: {
            error: {
              userErrorMessage: 'Gemini API quota exhausted. Please wait and try again.',
              shortError: 'QuotaExhausted',
              fullError: 'API returned: RESOURCE_EXHAUSTED',
              isBenign: false,
              errorCode: 8,
            },
          },
        },
        requestedInteraction: null,
      });
    });

    const stream = backend.createMessageStream('session-error-step', {
      model: 'Gemini_3.5_Flash_High',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.length).toBe(1);
    expect(events[0].type).toBe('error');
    expect(events[0].message).toContain('Gemini API quota exhausted');
    expect(events[0].status).toBe(500);

    // Restore
    (backend as any).client.lsClient.sendUserCascadeMessage = origSend;
  });

  it('should yield 504 error on waitForTurnComplete timeout', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    const mockCascade = await (backend as any).client.startCascade();
    mockCascade.state.trajectory.steps = [];

    // Use one-time rejection so the mock auto-restores after this test
    mockCascade.waitForTurnComplete.mockRejectedValueOnce(new Error('waitForTurnComplete: timeout after 120000ms'));

    const stream = backend.createMessageStream('session-timeout', {
      model: 'Gemini_3.5_Flash_High',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.length).toBe(1);
    expect(events[0].type).toBe('error');
    expect(events[0].message).toContain('timeout period');
    expect(events[0].status).toBe(504);
  });

  it('should return usage metadata from getCascadeTrajectoryGeneratorMetadata on turn_end', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    const stream = backend.createMessageStream('session-usage-test', {
      model: 'Gemini_3.5_Flash_High',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    const turnEnd = events.find((e: any) => e.type === 'turn_end');
    expect(turnEnd).toBeDefined();
    expect(turnEnd.usage).toBeDefined();
    expect(turnEnd.usage.input_tokens).toBe(42);
    expect(turnEnd.usage.output_tokens).toBe(128);
    expect(turnEnd.usage.cache_read_input_tokens).toBe(8);
    expect(turnEnd.usage.cache_creation_input_tokens).toBeUndefined(); // 0 → undefined
    expect(turnEnd.usage.context_window_estimated_tokens).toBe(25000);
  });

  it('should call cascade.cancel when cancelSession is called', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    const stream = backend.createMessageStream('session-cancel-test', {
      model: 'Gemini_3.5_Flash_High',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    for await (const _ of stream) {}

    const mockCascade = (backend as any).cascades.get('session-cancel-test');
    expect(mockCascade).toBeDefined();

    const cancelSpy = vi.spyOn(mockCascade, 'cancel');
    await backend.cancelSession('session-cancel-test');
    expect(cancelSpy).toHaveBeenCalled();
  });
});
