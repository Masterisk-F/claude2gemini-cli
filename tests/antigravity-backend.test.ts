import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AntigravityBackend, GeminiApiError } from '../server/gemini-backend.js';
import { CortexStepType } from 'antigravity-client/dist/src/gen/exa/cortex_pb/cortex_pb.js';

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

// Hoist the shared mock state so tests can introspect it directly.
const mockState = vi.hoisted(() => {
  return {
    sharedState: { status: 1 /* IDLE */, trajectory: { steps: [] } },
    cascadeSeq: 0,
    /** Optional override: when set, waitForTurnComplete rejects with this error. */
    timeoutError: null as Error | null,
    /** Optional override: when set, MockCascade.getHistory() rejects with this error. */
    getHistoryError: null as Error | null,
  };
});

vi.mock('antigravity-client', () => {
  // Shared mutable state across all MockCascade instances — production code
  // wraps the cascade via `new Cascade(...)` in #wrapCascade, so each
  // request creates two MockCascade objects (one from lsClient.startCascade,
  // one from #wrapCascade) and we want them to look like the same cascade
  // from the test's perspective.
  const sharedState = mockState.sharedState;

  class MockCascade {
    cascadeId: string;
    run = vi.fn();
    sendMessage = vi.fn().mockResolvedValue({});
    getHistory = vi.fn().mockImplementation(() => {
      if (mockState.getHistoryError) return Promise.reject(mockState.getHistoryError);
      return Promise.resolve({ trajectory: { steps: [] } });
    });
    dispose = vi.fn();
    cancel = vi.fn().mockResolvedValue(undefined);
    cancelAndWait = vi.fn().mockResolvedValue(undefined);
    removeAllListeners = vi.fn();
    listen = vi.fn();
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
    state: any = sharedState;
    constructor(cascadeId: string) {
      this.cascadeId = cascadeId;
    }
    waitForTurnComplete(opts?: { timeoutMs?: number }): Promise<void> {
      if (mockState.timeoutError) {
        return Promise.reject(mockState.timeoutError);
      }
      return Promise.resolve();
    }
  }

  function newCascade(): MockCascade {
    return new MockCascade(`cascade-mock-${++mockState.cascadeSeq}`);
  }

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
    startCascade: vi.fn().mockImplementation(async () => newCascade()),
    getCascade: vi.fn().mockImplementation((id: string) => new MockCascade(id)),
    dispose: vi.fn(),
    resolveModelId: vi.fn().mockResolvedValue(42),
    lsClient: {
      startCascade: vi.fn().mockImplementation(async (req: any) => {
        const c = newCascade();
        // If the caller supplied a baseTrajectoryIdentifier, accept the
        // pre-allocated cascadeId and seed the trajectory with the
        // embedded steps — this mirrors how the production LS applies
        // the trajectory in `startCascade`.
        if (req?.baseTrajectoryIdentifier?.identifier?.case === 'trajectory') {
          const traj = req.baseTrajectoryIdentifier.identifier.value;
          c.cascadeId = req.cascadeId || c.cascadeId;
          sharedState.trajectory = traj;
          sharedState.trajectory.steps = [...(traj.steps ?? [])];
        } else {
          sharedState.trajectory.steps = [];
        }
        return { cascadeId: c.cascadeId };
      }),
      sendUserCascadeMessage: vi.fn().mockImplementation(async () => {
        // Simulate the LS adding a user input step (for the just-sent
        // message) and a planner response step (for the LS's answer).
        sharedState.trajectory.steps.push(
          {
            status: 3, // DONE
            step: { case: 'userInput', value: { userResponse: '' } },
            requestedInteraction: null,
          },
          makePlannerStep('Hello! I am an AI assistant.'),
        );
      }),
      createCustomizationFile: vi.fn().mockResolvedValue({
        filePath: '/tmp/claude2gemini-mcp-proxy.mcp.json',
      }),
      refreshMcpServers: vi.fn().mockResolvedValue({}),
      deleteCascadeTrajectory: vi.fn().mockResolvedValue({}),
      getCascadeTrajectoryGeneratorMetadata: vi.fn().mockResolvedValue(mockUsageResponse),
    },
  };

  return {
    AntigravityClient: {
      launch: vi.fn().mockResolvedValue(mockClient),
    },
    Cascade: MockCascade,
    readAuthStatus: vi.fn().mockReturnValue({ apiKey: 'test-api-key' }),
    T: {
      Text: (val: string) => ({ chunk: { case: 'text', value: val } }),
    },
  };
});

describe('AntigravityBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset shared state between tests
    mockState.sharedState.status = 1;
    mockState.sharedState.trajectory.steps = [];
    mockState.cascadeSeq = 0;
    mockState.timeoutError = null;
    mockState.getHistoryError = null;
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

    const stream = backend.createMessageStream('req-1', {
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

  // --- Stateful sessionStore architecture ---

  it('should start a fresh Cascade on the first request (no past session)', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    const startSpy = vi.spyOn((backend as any).client.lsClient, 'startCascade');
    const sendSpy = vi.spyOn((backend as any).client.lsClient, 'sendUserCascadeMessage');
    const getSpy = vi.spyOn((backend as any).client, 'getCascade');

    const stream = backend.createMessageStream('req-fresh', {
      model: 'Gemini_3.5_Flash_High',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    for await (const _ of stream) { /* drain */ }

    // No existing session → startCascade is called.
    expect(startSpy).toHaveBeenCalledTimes(1);
    // getCascade is NOT called because there was no session to re-attach to.
    expect(getSpy).not.toHaveBeenCalled();
    // The new Cascade's startCascadeRequest has no baseTrajectoryIdentifier
    // (history injection is no longer used).
    const startReq = startSpy.mock.calls[0][0] as any;
    expect(startReq.baseTrajectoryIdentifier).toBeUndefined();
    // Current message is delivered via sendUserCascadeMessage
    expect(sendSpy).toHaveBeenCalledTimes(1);
    // Cascade is kept alive in the session store (no delete)
    expect((backend as any).sessionStore.size).toBe(1);
  });

  it('should include system prompt header on the first turn of a fresh cascade', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    const sendSpy = vi.spyOn((backend as any).client.lsClient, 'sendUserCascadeMessage');

    for await (const _ of backend.createMessageStream('req-first-sys', {
      model: 'Gemini_3.5_Flash_High',
      messages: [{ role: 'user', content: 'Hello' }],
      system: 'You are a test assistant.',
    })) { /* drain */ }

    const firstCall = sendSpy.mock.calls[0]?.[0] as any;
    const firstText = firstCall?.items?.[0]?.chunk?.value ?? '';
    expect(firstText).toContain('=== SYSTEM PROMPT ===');
    expect(firstText).toContain('You are a test assistant.');
    expect(firstText).toContain('=== USER INSTRUCTION ===');
  });

  it('should OMIT system prompt header on re-attach (turn 2+)', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    const sendSpy = vi.spyOn((backend as any).client.lsClient, 'sendUserCascadeMessage');

    const messages1 = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'Tell me a joke.' },
    ];
    // First turn: system prompt IS included.
    for await (const _ of backend.createMessageStream('req-turn1-sys', {
      model: 'Gemini_3.5_Flash_High',
      messages: messages1,
      system: 'You are a test assistant.',
    })) { /* drain */ }
    const firstText = (sendSpy.mock.calls[0]?.[0] as any)?.items?.[0]?.chunk?.value ?? '';
    expect(firstText).toContain('=== SYSTEM PROMPT ===');

    // Second turn in the same session: re-attach. System prompt is
    // suppressed — the model already has it from turn 1's userInput
    // step, which lives in the LS-side trajectory.
    const messages2 = [
      ...messages1,
      { role: 'assistant', content: 'Why did the chicken cross the road?' },
      { role: 'user', content: 'Another one.' },
    ];
    for await (const _ of backend.createMessageStream('req-turn2-sys', {
      model: 'Gemini_3.5_Flash_High',
      messages: messages2,
      system: 'You are a test assistant.',
    })) { /* drain */ }
    const secondText = (sendSpy.mock.calls[1]?.[0] as any)?.items?.[0]?.chunk?.value ?? '';
    expect(secondText).not.toContain('=== SYSTEM PROMPT ===');
    expect(secondText).not.toContain('You are a test assistant.');
    expect(secondText).toContain('=== USER INSTRUCTION ===');
    expect(secondText).toContain('Another one.');
  });

  it('should re-attach to the same Cascade on a subsequent request in the same session', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    const startSpy = vi.spyOn((backend as any).client.lsClient, 'startCascade');
    const getSpy = vi.spyOn((backend as any).client, 'getCascade');
    const sendSpy = vi.spyOn((backend as any).client.lsClient, 'sendUserCascadeMessage');

    const messages1 = [
      { role: 'user', content: 'What is 1+1?' },
      { role: 'assistant', content: 'It is 2.' },
      { role: 'user', content: 'And what is 2+2?' },
    ];
    // First turn: starts a new Cascade.
    for await (const _ of backend.createMessageStream('req-turn1', { model: 'Gemini_3.5_Flash_High', messages: messages1 })) { /* drain */ }
    expect(startSpy).toHaveBeenCalledTimes(1);
    // sessionStore is keyed by cascadeId (we re-derive it from the
    // first request's startCascade mock).
    const firstCascadeId = (backend as any).sessionStore.keys().next().value;
    // We store the Cascade wrapper directly in sessionStore — we do
    // NOT need to call client.getCascade on re-attach (calling it
    // would open a duplicate streamAgentStateUpdates subscription
    // and the LS would reject it with "subscription closed by
    // repeat id").
    expect(getSpy).not.toHaveBeenCalled();

    // Second turn in the same session: must re-attach.
    const messages2 = [
      ...messages1,
      { role: 'assistant', content: 'It is 4.' },
      { role: 'user', content: 'And what is 3+3?' },
    ];
    for await (const _ of backend.createMessageStream('req-turn2', { model: 'Gemini_3.5_Flash_High', messages: messages2 })) { /* drain */ }

    // startCascade is still called only once (no new Cascade for the same session)
    expect(startSpy).toHaveBeenCalledTimes(1);
    // We reused the stored wrapper — getCascade was not called.
    expect(getSpy).not.toHaveBeenCalled();
    // The second message was delivered to the same Cascade
    expect(sendSpy).toHaveBeenCalledTimes(2);
    // The session store still holds the same Cascade
    expect((backend as any).sessionStore.size).toBe(1);
    expect((backend as any).sessionStore.keys().next().value).toBe(firstCascadeId);
  });

  it('should start a new Cascade for a different first user message (different session)', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    const startSpy = vi.spyOn((backend as any).client.lsClient, 'startCascade');

    const stream1 = backend.createMessageStream('req-A', {
      model: 'Gemini_3.5_Flash_High',
      messages: [{ role: 'user', content: 'Session A opener' }, { role: 'assistant', content: 'A' }, { role: 'user', content: 'continue' }],
    });
    for await (const _ of stream1) { /* drain */ }
    const cascadeA = Array.from((backend as any).sessionStore.keys()).at(-1);

    const stream2 = backend.createMessageStream('req-B', {
      model: 'Gemini_3.5_Flash_High',
      messages: [{ role: 'user', content: 'Session B opener' }, { role: 'assistant', content: 'B' }, { role: 'user', content: 'continue' }],
    });
    for await (const _ of stream2) { /* drain */ }
    const cascadeB = Array.from((backend as any).sessionStore.keys()).at(-1);

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(cascadeA).not.toBe(cascadeB);
    expect((backend as any).sessionStore.size).toBe(2);
  });

  it('should keep the Cascade alive across successful requests (no deleteCascadeTrajectory per-request)', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    const deleteSpy = vi.spyOn((backend as any).client.lsClient, 'deleteCascadeTrajectory');
    const sendSpy = vi.spyOn((backend as any).client.lsClient, 'sendUserCascadeMessage');

    const stream = backend.createMessageStream('req-dispose', {
      model: 'Gemini_3.5_Flash_High',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    for await (const _ of stream) { /* drain */ }

    expect(sendSpy).toHaveBeenCalled();
    // The Cascade is kept alive in the session store — the LS retains
    // the trajectory so the next turn in the same session can re-attach.
    expect(deleteSpy).not.toHaveBeenCalled();
    expect((backend as any).sessionStore.size).toBe(1);
  });

  it('should delete the Cascade and remove from session store on startCascade error', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    vi.spyOn((backend as any).client.lsClient, 'startCascade')
      .mockRejectedValueOnce(new Error('LS: startCascade rejected'));

    const stream = backend.createMessageStream('req-start-fail', {
      model: 'Gemini_3.5_Flash_High',
      messages: [{ role: 'user', content: 'unique-opener-for-start-fail-test' }],
    });

    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    const errEvent = events.find((e: any) => e.type === 'error');
    expect(errEvent).toBeDefined();
    expect(errEvent.message).toContain('startCascade rejected');
    // No session was registered because the startCascade call failed.
    expect((backend as any).sessionStore.size).toBe(0);
  });

  it('should return only the current turn\'s plannerResponse text (no bleed from prior turns)', async () => {
    // Regression: previously collectTextFromSteps(cascade, 0) was used,
    // which concatenated EVERY plannerResponse in the trajectory.
    // Result: from turn 2 onward, the user saw the entire prior
    // conversation echoed at the start of every new reply.
    const backend = new AntigravityBackend();
    await backend.initialize();

    // The mock's sendUserCascadeMessage appends a plannerResponse step
    // with the hard-coded text "Hello! I am an AI assistant." (27 chars).
    // After 2 turns the trajectory contains 2 such steps, so a buggy
    // implementation would return a 54-char concatenated string, while
    // the fix returns exactly 27 chars each turn.
    const MOCK_RESPONSE = 'Hello! I am an AI assistant.';

    const messages1 = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first reply' },
      { role: 'user', content: 'second question' },
    ];
    const events1: any[] = [];
    for await (const ev of backend.createMessageStream('req-bleed-1', {
      model: 'Gemini_3.5_Flash_High',
      messages: messages1,
    })) events1.push(ev);
    const streamEvent1 = events1.find((e: any) => e.type === 'stream_event');
    expect(streamEvent1).toBeDefined();
    expect(streamEvent1.event.value).toBe(MOCK_RESPONSE);

    const messages2 = [
      ...messages1,
      { role: 'assistant', content: 'second reply' },
      { role: 'user', content: 'third question' },
    ];
    const events2: any[] = [];
    for await (const ev of backend.createMessageStream('req-bleed-2', {
      model: 'Gemini_3.5_Flash_High',
      messages: messages2,
    })) events2.push(ev);
    const streamEvent2 = events2.find((e: any) => e.type === 'stream_event');
    expect(streamEvent2).toBeDefined();
    // The critical assertion: turn 2's stream_event is NOT the
    // concatenation of turn 1 + turn 2 responses.
    expect(streamEvent2.event.value).toBe(MOCK_RESPONSE);
    expect(streamEvent2.event.value.length).toBe(MOCK_RESPONSE.length);
  });

  it('should drop a stale session (getHistory throws) and start a fresh Cascade', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    const startSpy = vi.spyOn((backend as any).client.lsClient, 'startCascade');

    // First turn: starts a new Cascade.
    for await (const _ of backend.createMessageStream('req-1', {
      model: 'Gemini_3.5_Flash_High',
      messages: [{ role: 'user', content: 'Stale session opener' }, { role: 'assistant', content: 'A' }, { role: 'user', content: 'continue' }],
    })) { /* drain */ }
    expect(startSpy).toHaveBeenCalledTimes(1);

    // Simulate the cascade having been deleted on the LS side (e.g.
    // LS restart, TTL expiry, or manual delete). #findParentCascadeByPrefix
    // calls cascade.getHistory() to verify liveness; we set
    // getHistoryError so the entry is dropped and a fresh Cascade
    // is started.
    mockState.getHistoryError = new Error('cascade not found');

    try {
      // Second turn in the same session: re-attach fails, start new.
      for await (const _ of backend.createMessageStream('req-2', {
        model: 'Gemini_3.5_Flash_High',
        messages: [{ role: 'user', content: 'Stale session opener' }, { role: 'assistant', content: 'A' }, { role: 'user', content: 'continue' }, { role: 'assistant', content: 'B' }, { role: 'user', content: 'new' }],
      })) { /* drain */ }
    } finally {
      mockState.getHistoryError = null;
    }

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect((backend as any).sessionStore.size).toBe(1);
  });

  it('should grow the stored pastTurns after each successful turn (prefix matching)', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    const startSpy = vi.spyOn((backend as any).client.lsClient, 'startCascade');

    // First turn: empty pastTurns, one current user message.
    for await (const _ of backend.createMessageStream('req-grow-1', {
      model: 'Gemini_3.5_Flash_High',
      messages: [
        { role: 'user', content: 'A1' },
        { role: 'assistant', content: 'A1-reply' },
        { role: 'user', content: 'A2' },
      ],
    })) { /* drain */ }
    expect(startSpy).toHaveBeenCalledTimes(1);
    const firstCascadeId = (backend as any).sessionStore.keys().next().value;
    // After this turn, pastTurns stored should be the prior conversation
    // history (the messages BEFORE the final user message) — i.e. one
    // turn: { A1, A1-reply }.
    const entry1 = (backend as any).sessionStore.get(firstCascadeId);
    expect(entry1.pastTurns.length).toBe(1);
    expect(entry1.pastTurns[0].userMessage.content).toBe('A1');
    expect(entry1.pastTurns[0].assistantMessages[0].content).toBe('A1-reply');

    // Second turn: pastTurns now contains the previous conversation
    // (A1, A1-reply, A2, A2-reply). The first user message changes
    // only in the FINAL turn — we extend the prefix.
    for await (const _ of backend.createMessageStream('req-grow-2', {
      model: 'Gemini_3.5_Flash_High',
      messages: [
        { role: 'user', content: 'A1' },
        { role: 'assistant', content: 'A1-reply' },
        { role: 'user', content: 'A2' },
        { role: 'assistant', content: 'A2-reply' },
        { role: 'user', content: 'A3' },
      ],
    })) { /* drain */ }
    // No new Cascade started — the prefix matched.
    expect(startSpy).toHaveBeenCalledTimes(1);
    // pastTurns should have grown to 2 turns.
    const entry2 = (backend as any).sessionStore.get(firstCascadeId);
    expect(entry2.pastTurns.length).toBe(2);
    expect(entry2.pastTurns[0].userMessage.content).toBe('A1');
    expect(entry2.pastTurns[1].userMessage.content).toBe('A2');
  });

  it('should NOT keep inflight cascades across requests', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    for (const reqId of ['a', 'b', 'c']) {
      const stream = backend.createMessageStream(reqId, {
        model: 'Gemini_3.5_Flash_High',
        messages: [{ role: 'user', content: 'Hello' }],
      });
      for await (const _ of stream) { /* drain */ }
    }

    expect((backend as any).inflightCascades.size).toBe(0);
  });

  it('should clear pending MCP tool calls at request boundaries', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    // Simulate a stale pending call from a previous (abandoned) request
    (backend.mcpHub as any).pending.set('stale', {
      callId: 'stale',
      name: 'Bash',
      args: {},
      resolve: vi.fn(),
      reject: vi.fn(),
      timer: setTimeout(() => {}, 1000),
    });
    expect(backend.mcpHub.hasPendingCalls()).toBe(true);

    const stream = backend.createMessageStream('req-clear', {
      model: 'Gemini_3.5_Flash_High',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    for await (const _ of stream) { /* drain */ }

    // Boundary clear should have removed the stale call
    expect(backend.mcpHub.hasPendingCalls()).toBe(false);
  });

  // --- Error / Usage / Cancel ---

  it('should yield error message when cascade emits error event', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    // Override sendUserCascadeMessage to fire the error event during processing
    const origSend = (backend as any).client.lsClient.sendUserCascadeMessage;
    (backend as any).client.lsClient.sendUserCascadeMessage = vi.fn().mockImplementation(async () => {
      // Get the in-flight cascade and emit an error on it
      const c = (backend as any).inflightCascades.get('req-cascade-error');
      if (c) c.emitEvent('error', Object.assign(new Error('LS stream connection lost'), { code: 14 }));
    });

    const stream = backend.createMessageStream('req-cascade-error', {
      model: 'Gemini_3.5_Flash_High',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    const errEvent = events.find((e: any) => e.type === 'error');
    expect(errEvent).toBeDefined();
    expect(errEvent.message).toContain('LS stream connection lost');
    expect(errEvent.status).toBe(503);

    (backend as any).client.lsClient.sendUserCascadeMessage = origSend;
  });

  it('should yield error when trajectory contains errorMessage step', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    const origSend = (backend as any).client.lsClient.sendUserCascadeMessage;
    (backend as any).client.lsClient.sendUserCascadeMessage = vi.fn().mockImplementation(async () => {
      // Simulate the LS adding the user input step (matching production
      // ordering so startStepCount lines up) and then the errorMessage.
      mockState.sharedState.trajectory.steps.push(
        {
          status: 3, // DONE
          step: { case: 'userInput', value: { userResponse: '' } },
          requestedInteraction: null,
        },
        {
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
        },
      );
    });

    const stream = backend.createMessageStream('req-error-step', {
      model: 'Gemini_3.5_Flash_High',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    const errEvent = events.find((e: any) => e.type === 'error');
    expect(errEvent).toBeDefined();
    expect(errEvent.message).toContain('Gemini API quota exhausted');
    expect(errEvent.status).toBe(500);

    (backend as any).client.lsClient.sendUserCascadeMessage = origSend;
  });

  it('should yield 504 error on waitForTurnComplete timeout', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    // Set the shared mock flag so every MockCascade's waitForTurnComplete
    // rejects with a timeout error. The sharedState mechanism means
    // #wrapCascade's `new Cascade(...)` returns an instance that honors it.
    mockState.timeoutError = new Error('waitForTurnComplete: timeout after 120000ms');

    const stream = backend.createMessageStream('req-timeout', {
      model: 'Gemini_3.5_Flash_High',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    const errEvent = events.find((e: any) => e.type === 'error');
    expect(errEvent).toBeDefined();
    expect(errEvent.message).toContain('timeout period');
    expect(errEvent.status).toBe(504);

    mockState.timeoutError = null;
  });

  it('should return usage metadata from getCascadeTrajectoryGeneratorMetadata on turn_end', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    const stream = backend.createMessageStream('req-usage', {
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
    expect(turnEnd.usage.cache_creation_input_tokens).toBeUndefined();
    expect(turnEnd.usage.context_window_estimated_tokens).toBe(25000);
  });

  it('should cancel the in-flight cascade when cancelSession is called', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    // Use a deferred so we can unblock the hanging sendUserCascadeMessage
    // after the cancel assertion runs.
    let resolveSend: () => void = () => {};
    let sendPromise: Promise<void> | null = null;
    (backend as any).client.lsClient.sendUserCascadeMessage = vi.fn().mockImplementation(async () => {
      sendPromise = new Promise<void>((r) => { resolveSend = r; });
      await sendPromise;
      // Simulate the LS adding a planner response after the deferred resolves
      mockState.sharedState.trajectory.steps.push(
        { status: 3, step: { case: 'userInput', value: { userResponse: '' } }, requestedInteraction: null },
        makePlannerStep('late'),
      );
    });

    const stream = backend.createMessageStream('req-cancel', {
      model: 'Gemini_3.5_Flash_High',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    // Drive the async generator forward until the cascade registers as
    // inflight, then verify cancelSession routes to it.
    const iter = stream[Symbol.asyncIterator]();
    const firstNext = iter.next(); // start the body, do not await yet

    // Poll for the cascade to appear in the inflight map
    let inflight: any = undefined;
    for (let i = 0; i < 50 && !inflight; i++) {
      await new Promise((r) => setTimeout(r, 10));
      inflight = (backend as any).inflightCascades.get('req-cancel');
    }
    expect(inflight).toBeDefined();

    const cancelSpy = vi.spyOn(inflight, 'cancel');
    await backend.cancelSession('req-cancel');
    expect(cancelSpy).toHaveBeenCalled();

    // Unblock the hanging send so the body can run the finally block.
    resolveSend();
    await firstNext.catch(() => { /* ignore */ });
  });
});
