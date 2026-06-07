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
      { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] },
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
      { role: 'assistant', content: [{ type: 'text', text: 'Why did the chicken cross the road?' }] },
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

  it('should inject BUILT-IN TOOLS disclaimer on the first turn of a fresh cascade', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    const sendSpy = vi.spyOn((backend as any).client.lsClient, 'sendUserCascadeMessage');

    for await (const _ of backend.createMessageStream('req-builtin-1', {
      model: 'Gemini_3.5_Flash_High',
      messages: [{ role: 'user', content: 'Hello' }],
      system: 'You are a test assistant.',
    })) { /* drain */ }

    const firstText = (sendSpy.mock.calls[0]?.[0] as any)?.items?.[0]?.chunk?.value ?? '';
    // Disclaimer present
    expect(firstText).toContain('=== BUILT-IN TOOLS (DISABLED) ===');
    expect(firstText).toContain('=================================');
    // Sample tool names from each layer are all listed
    expect(firstText).toContain('runCommand');
    expect(firstText).toContain('searchWeb');
    expect(firstText).toContain('antigravityBrowser');
    expect(firstText).toContain('viewCodeItem');
    expect(firstText).toContain('code');
    expect(firstText).toContain('intent');
    expect(firstText).toContain('grep');
    expect(firstText).toContain('viewFile');
    expect(firstText).toContain('notifyUser');
    expect(firstText).toContain('taskBoundary');
    // MCP directive present
    expect(firstText).toContain('mcp__claude2gemini-mcp-proxy');
    expect(firstText).toContain('_Bash');
    expect(firstText).toContain('_Read');
    // Ordering: SYSTEM PROMPT < BUILT-IN TOOLS < USER INSTRUCTION
    const sysIdx = firstText.indexOf('=== SYSTEM PROMPT ===');
    const builtinIdx = firstText.indexOf('=== BUILT-IN TOOLS (DISABLED) ===');
    const userIdx = firstText.indexOf('=== USER INSTRUCTION ===');
    expect(sysIdx).toBeGreaterThanOrEqual(0);
    expect(builtinIdx).toBeGreaterThan(sysIdx);
    expect(userIdx).toBeGreaterThan(builtinIdx);
  });

  it('should OMIT BUILT-IN TOOLS disclaimer on re-attach (turn 2+)', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    const sendSpy = vi.spyOn((backend as any).client.lsClient, 'sendUserCascadeMessage');

    const messages1 = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] },
      { role: 'user', content: 'Tell me a joke.' },
    ];
    for await (const _ of backend.createMessageStream('req-bt-1', {
      model: 'Gemini_3.5_Flash_High',
      messages: messages1,
      system: 'You are a test assistant.',
    })) { /* drain */ }
    const firstText = (sendSpy.mock.calls[0]?.[0] as any)?.items?.[0]?.chunk?.value ?? '';
    expect(firstText).toContain('=== BUILT-IN TOOLS (DISABLED) ===');

    // Second turn: re-attach → disclaimer omitted
    const messages2 = [
      ...messages1,
      { role: 'assistant', content: [{ type: 'text', text: 'Why did the chicken cross the road?' }] },
      { role: 'user', content: 'Another one.' },
    ];
    for await (const _ of backend.createMessageStream('req-bt-2', {
      model: 'Gemini_3.5_Flash_High',
      messages: messages2,
      system: 'You are a test assistant.',
    })) { /* drain */ }
    const secondText = (sendSpy.mock.calls[1]?.[0] as any)?.items?.[0]?.chunk?.value ?? '';
    expect(secondText).not.toContain('=== BUILT-IN TOOLS (DISABLED) ===');
    expect(secondText).not.toContain('runCommand');
    // USER INSTRUCTION still present
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
      { role: 'assistant', content: [{ type: 'text', text: 'It is 2.' }] },
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
      { role: 'assistant', content: [{ type: 'text', text: 'It is 4.' }] },
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
      messages: [
        { role: 'user', content: 'Stale session opener' },
        { role: 'assistant', content: [{ type: 'text', text: 'A' }] },
        { role: 'user', content: 'continue' },
      ],
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
        messages: [
          { role: 'user', content: 'Stale session opener' },
          { role: 'assistant', content: [{ type: 'text', text: 'A' }] },
          { role: 'user', content: 'continue' },
          { role: 'assistant', content: [{ type: 'text', text: 'B' }] },
          { role: 'user', content: 'new' },
        ],
      })) { /* drain */ }
    } finally {
      mockState.getHistoryError = null;
    }

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect((backend as any).sessionStore.size).toBe(1);
  });

  it('should store pastTurns (groupTurns result) after each successful turn', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    const startSpy = vi.spyOn((backend as any).client.lsClient, 'startCascade');

    // First turn: empty pastTurns, one current user message.
    for await (const _ of backend.createMessageStream('req-grow-1', {
      model: 'Gemini_3.5_Flash_High',
      messages: [
        { role: 'user', content: 'A1' },
        { role: 'assistant', content: [{ type: 'text', text: 'A1-reply' }] },
        { role: 'user', content: 'A2' },
      ],
    })) { /* drain */ }
    expect(startSpy).toHaveBeenCalledTimes(1);
    const firstCascadeId = (backend as any).sessionStore.keys().next().value;
    // `pastTurns` here is the `groupTurns` result for the 1st
    // request: one turn (the just-completed A1 → A1-reply).
    // The currentUserMessage (A2) is stripped by groupTurns and
    // not yet in the stored pastTurns. Re-attach matching requires
    // the next request's `pastTurns` to be exactly one turn
    // longer, which it will be after the 2nd turn.
    const entry1 = (backend as any).sessionStore.get(firstCascadeId);
    expect(entry1.pastTurns.length).toBe(1);
    expect(entry1.pastTurns[0].userMessage.content).toBe('A1');
    expect(entry1.pastTurns[0].assistantMessages[0].content[0].text).toBe('A1-reply');

    // Second turn: pastTurns grows to 2 turns (A1 + A2) and the
    // new Cascade re-attaches (no second startCascade call).
    for await (const _ of backend.createMessageStream('req-grow-2', {
      model: 'Gemini_3.5_Flash_High',
      messages: [
        { role: 'user', content: 'A1' },
        { role: 'assistant', content: [{ type: 'text', text: 'A1-reply' }] },
        { role: 'user', content: 'A2' },
        { role: 'assistant', content: [{ type: 'text', text: 'A2-reply' }] },
        { role: 'user', content: 'A3' },
      ],
    })) { /* drain */ }
    // No new Cascade started — the prefix (length - 1) matched.
    expect(startSpy).toHaveBeenCalledTimes(1);
    // pastTurns grew to 2 turns.
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

  it('should yield text from plannerResponse BEFORE tool_call when turn is "tool_call" (text + tool calls in same turn)', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    // Simulate the LS pushing a response that contains BOTH text
    // ("Let me check the file.") AND a tool call (Read). The
    // trajectory ends with a pending mcpTool — the plannerResponse
    // is NOT the last step. McpHub has a pending call so
    // waitForTurnOrToolCall returns 'tool_call'. We must still
    // yield the text BEFORE the tool_use events so Claude Code
    // sees both in the same assistant message.
    (backend as any).client.lsClient.sendUserCascadeMessage = vi.fn().mockImplementation(async () => {
      mockState.sharedState.trajectory.steps.push(
        {
          status: 3, // DONE
          step: { case: 'userInput', value: { userResponse: '' } },
          requestedInteraction: null,
        },
        {
          status: 3, // DONE
          step: {
            case: 'plannerResponse',
            value: {
              response: 'Let me check the file.',
              toolCalls: [{ name: 'Read', arguments: '{}' }],
            },
          },
          requestedInteraction: null,
        },
        {
          status: 0, // PENDING (no result yet)
          step: {
            case: 'mcpTool',
            value: {
              toolCall: { name: 'Read' },
              result: { value: '' },
            },
          },
          requestedInteraction: null,
        },
      );
    });

    // Prevent clearPendingCalls from clearing our pre-populated test call.
    vi.spyOn(backend.mcpHub, 'clearPendingCalls').mockImplementation(() => {});

    // Pre-populate mcpHub with a pending call matching the tool call.
    (backend.mcpHub as any).pending.set('test-call-text-and-tool', {
      callId: 'test-call-text-and-tool',
      name: 'Read',
      args: { file_path: '/tmp/test' },
      resolve: vi.fn(),
      reject: vi.fn(),
      timer: setTimeout(() => {}, 1000),
    });

    const events: any[] = [];
    for await (const event of backend.createMessageStream('req-text-and-tool', {
      model: 'Gemini_3.5_Flash_High',
      messages: [{ role: 'user', content: 'Hello' }],
    })) {
      events.push(event);
    }

    // The text from the plannerResponse should be yielded as a stream_event
    const textEvent = events.find(
      (e) => e.type === 'stream_event' && e.event?.type === 'content',
    );
    expect(textEvent).toBeDefined();
    expect(textEvent.event.value).toContain('Let me check the file.');

    // The tool_call should also be yielded
    const toolCallEvent = events.find((e) => e.type === 'tool_call');
    expect(toolCallEvent).toBeDefined();
    expect(toolCallEvent.name).toBe('Read');

    // CRITICAL: text must come BEFORE tool_call in the event stream
    // so Claude Code shows them in the correct order in the same
    // assistant message.
    const textIdx = events.indexOf(textEvent);
    const toolIdx = events.indexOf(toolCallEvent);
    expect(textIdx).toBeGreaterThanOrEqual(0);
    expect(toolIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeLessThan(toolIdx);

    // And the message ends with tool_use stop reason
    const turnEnd = events.find((e) => e.type === 'turn_end');
    expect(turnEnd).toBeDefined();
    expect(turnEnd.stopReason).toBe('tool_use');
  });

  // --- Regression: session-isolation on same turn[0] content ---
  //
  // Bug: a stale Cascade in the sessionStore whose `pastTurns[0]`
  // happened to match a new session's first turn was being re-
  // attached via the "longest prefix" match. Result: two unrelated
  // sessions shared a Cascade, and the model saw stale tool
  // definitions / trajectory state from a previous conversation.
  //
  // Fix: re-attach requires the stored cascade's `pastTurns` to
  // EQUAL the new request's `pastTurns` exactly (not just be a
  // prefix), and on ties the most-recently-used cascade wins.

  it('should store pastTurns (groupTurns result) after a successful 1st turn', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    // 1st turn: single user message, no prior history.
    for await (const _ of backend.createMessageStream('req-grow-1', {
      model: 'Gemini_3.5_Flash_High',
      messages: [{ role: 'user', content: 'A1' }],
    })) { /* drain */ }

    const firstCascadeId = (backend as any).sessionStore.keys().next().value;
    const entry1 = (backend as any).sessionStore.get(firstCascadeId);
    // `pastTurns` here is the `groupTurns` result for the 1st
    // request: empty (the only user message is the live
    // currentUserMessage, which groupTurns strips).
    // The next request's `pastTurns` will be longer by one turn,
    // so #findParentCascadeByPrefix's "length - 1" check matches.
    expect(entry1.pastTurns.length).toBe(0);
  });

  it('should not re-attach to a stale Cascade when a new session has the same turn[0] content', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();

    // The mock's sendUserCascadeMessage appends a plannerResponse
    // step with the hard-coded text "Hello! I am an AI assistant."
    const MOCK_REPLY = 'Hello! I am an AI assistant.';

    // Inject a stale Cascade directly into the sessionStore. Its
    // pastTurns[0] is *exactly* the state a freshly-completed 1st
    // turn would produce (same userMessage content, same assistant
    // planner text). Its lastUsed is 10s in the past so it loses
    // the tie-breaker against the brand-new Cascade.
    const staleCascadeId = 'stale-cascade-injected';
    const staleCascade = {
      cascadeId: staleCascadeId,
      state: { status: 1, trajectory: { steps: [] } },
      getHistory: vi.fn().mockResolvedValue({}),
      listen: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      sendMessage: vi.fn(),
      cancel: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      cancelAndWait: vi.fn().mockResolvedValue(undefined),
      removeAllListeners: vi.fn(),
    };
    (backend as any).sessionStore.set(staleCascadeId, {
      cascade: staleCascade,
      pastTurns: [{
        userMessage: { role: 'user', content: 'shared first message' },
        assistantMessages: [{ role: 'assistant', content: [{ type: 'text', text: MOCK_REPLY }] }],
      }],
      sessionId: 'stale-session-hash',
      lastUsed: Date.now() - 10_000,
    });

    const startSpy = vi.spyOn((backend as any).client.lsClient, 'startCascade');
    const sendSpy = vi.spyOn((backend as any).client.lsClient, 'sendUserCascadeMessage');

    // 1st turn of the NEW session: starts a brand-new Cascade.
    for await (const _ of backend.createMessageStream('req-new-1', {
      model: 'Gemini_3.5_Flash_High',
      messages: [{ role: 'user', content: 'shared first message' }],
    })) { /* drain */ }

    // 2nd turn of the NEW session: turn[0] is identical (by content)
    // to the stale Cascade's pastTurns[0]. With the buggy
    // longest-prefix logic, the stale Cascade would win because
    // its stored pastTurns[0] matched the new request's pastTurns[0]
    // (and was longer than the new Cascade's empty pastTurns).
    //
    // With the fix: the new Cascade's entry.pastTurns was grown to
    // [turn_1] after the 1st turn, so its length matches the new
    // request's pastTurns length, AND on tie the most-recently-used
    // (new) Cascade wins.
    //
    // Note: assistant content is given as a content-block array
    // (matching Claude Code's actual wire format AND
    // #collectAssistantMessages' output) so strict equality in
    // #messagesEqual succeeds on the assistant turn.
    for await (const _ of backend.createMessageStream('req-new-2', {
      model: 'Gemini_3.5_Flash_High',
      messages: [
        { role: 'user', content: 'shared first message' },
        { role: 'assistant', content: [{ type: 'text', text: MOCK_REPLY }] },
        { role: 'user', content: 'continue' },
      ],
    })) { /* drain */ }

    // Only ONE new Cascade was started (the 1st turn). The 2nd
    // turn re-attached to it; it did NOT spawn a 2nd Cascade.
    expect(startSpy).toHaveBeenCalledTimes(1);
    // Two sendUserCascadeMessage calls: one per turn, both to the
    // new Cascade (not the stale one).
    expect(sendSpy).toHaveBeenCalledTimes(2);

    // The new Cascade's entry.pastTurns grew to 1 turn (the
    // groupTurns result of the 2nd request, with the final
    // currentUserMessage stripped).
    const newCascadeIds = (backend as any).sessionStore.keys()
      .filter((k: string) => k !== staleCascadeId)
      .toArray();
    expect(newCascadeIds.length).toBe(1);
    const newCascadeId = newCascadeIds[0];
    const newEntry = (backend as any).sessionStore.get(newCascadeId);
    expect(newEntry.pastTurns.length).toBe(1);
    expect(newEntry.pastTurns[0].userMessage.content).toBe('shared first message');

    // The stale Cascade's entry is untouched (still 1 turn, still
    // 10s in the past). It was NOT re-attached.
    const staleEntry = (backend as any).sessionStore.get(staleCascadeId);
    expect(staleEntry.pastTurns.length).toBe(1);
    expect(staleEntry.lastUsed).toBeLessThan(Date.now() - 5_000);
  });
});

describe('AntigravityBackend.decideInteraction', () => {
  it('allows MCP-type interactions (the only allowed type)', () => {
    expect(
      AntigravityBackend.decideInteraction({
        type: 'mcp',
        description: 'MCP Tool Interaction',
      }),
    ).toBe('allow');
  });

  it.each([
    ['Permission Needed: mcp on claude2gemini-mcp-proxy/Bash'],
    ['Permission Needed: mcp on claude2gemini-mcp-proxy/Read'],
    ['Permission Needed: mcp on claude2gemini-mcp-proxy/Edit'],
    ['Permission Needed: mcp on claude2gemini-mcp-proxy/Write'],
    ['Permission Needed: mcp on claude2gemini-mcp-proxy/Glob'],
    ['Permission Needed: mcp on claude2gemini-mcp-proxy/Grep'],
  ])(
    'allows MCP permission requests via description pattern: %s',
    (description) => {
      // The LS dispatches MCP tool calls through the generic
      // `permission` interactionCase, so type is "other" — the
      // description is the only reliable signal.
      expect(
        AntigravityBackend.decideInteraction({ type: 'other', description }),
      ).toBe('allow');
    },
  );

  it.each<[string, string]>([
    ['run_command', 'Run Command: bash -c "echo hi"'],
    ['file_permission', 'File Access: /tmp/foo'],
    ['file_permission', 'Permission Needed: read_file on /tmp/foo'],
    ['open_browser_url', 'Open Browser: https://example.com'],
    ['browser_action', 'Browser Action: clickBrowserPixel'],
    ['send_command_input', 'Send Command Input'],
    ['other', 'Unknown Interaction: someFutureType'],
    // Built-in permission (NOT MCP) routed through 'other':
    ['other', 'Permission Needed: read_file on /tmp/foo'],
  ])('denies non-MCP interaction type=%s', (type, description) => {
    expect(AntigravityBackend.decideInteraction({ type, description })).toBe('deny');
  });

  it('denies when description is missing or empty (fail-closed)', () => {
    expect(AntigravityBackend.decideInteraction({ type: 'mcp' })).toBe('allow');
    // type 'mcp' alone is enough, but anything else without
    // description must be denied.
    expect(AntigravityBackend.decideInteraction({ type: 'other' })).toBe('deny');
    expect(AntigravityBackend.decideInteraction({ type: 'other', description: '' })).toBe('deny');
  });

  it('denies unknown / future interaction types (fail-closed)', () => {
    expect(
      AntigravityBackend.decideInteraction({ type: 'some_future_tool' }),
    ).toBe('deny');
    expect(
      AntigravityBackend.decideInteraction({ type: '' }),
    ).toBe('deny');
    // Type system guards this, but ensure runtime safety regardless.
    expect(
      AntigravityBackend.decideInteraction({
        type: undefined as unknown as string,
      }),
    ).toBe('deny');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Perspective 3: tool_result delivery (Claude → hub → LS) and
// session isolation. The mcpHub is a singleton (one EventEmitter per
// process), so concurrent backends / requests share the same `pending`
// map. These tests pin down the current semantics so future refactors
// don't silently break them.
// ─────────────────────────────────────────────────────────────────────────

describe('Tool result delivery + session isolation', () => {
  it('resolves the correct pending call by callId without disturbing siblings', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();
    const hub = backend.mcpHub;

    // Synthesize three in-flight calls.
    const fakeEntries = ['call_alpha', 'call_beta', 'call_gamma'].map((id) => ({
      callId: id,
      name: 'Bash',
      args: { command: id },
      resolve: vi.fn(),
      reject: vi.fn(),
      timer: setTimeout(() => {}, 60_000),
    }));
    for (const e of fakeEntries) (hub as any).pending.set(e.callId, e);
    expect(hub.getPendingCalls()).toHaveLength(3);

    // Resolve only the middle one.
    await hub.resolveCall('call_beta', { content: [{ type: 'text', text: 'beta-resolved' }] });

    // call_beta is gone; alpha and gamma remain.
    expect(hub.hasPendingCalls()).toBe(true);
    const remaining = hub.getPendingCalls().map((c: any) => c.callId);
    expect(remaining).toContain('call_alpha');
    expect(remaining).toContain('call_gamma');
    expect(remaining).not.toContain('call_beta');

    // Only call_beta's resolve was called.
    expect(fakeEntries[0]!.resolve).not.toHaveBeenCalled();
    expect(fakeEntries[1]!.resolve).toHaveBeenCalledWith({ content: [{ type: 'text', text: 'beta-resolved' }] });
    expect(fakeEntries[2]!.resolve).not.toHaveBeenCalled();

    // Cleanup.
    for (const e of fakeEntries) clearTimeout(e.timer);
    hub.clearPendingCalls('test cleanup');
  });

  it('clearPendingCalls is GLOBAL — it rejects every pending call regardless of session', async () => {
    // Snapshot the current behavior: clearPendingCalls is a singleton-wide
    // sweep. If a future change makes it session-scoped, this test will
    // need to be updated and the bug fix documented.
    const backend = new AntigravityBackend();
    await backend.initialize();
    const hub = backend.mcpHub;

    const a = { callId: 'A', name: 'Bash', args: {}, resolve: vi.fn(), reject: vi.fn(), timer: setTimeout(() => {}, 60_000) };
    const b = { callId: 'B', name: 'Bash', args: {}, resolve: vi.fn(), reject: vi.fn(), timer: setTimeout(() => {}, 60_000) };
    (hub as any).pending.set(a.callId, a);
    (hub as any).pending.set(b.callId, b);

    hub.clearPendingCalls('boundary clear');

    expect(a.reject).toHaveBeenCalledWith(new Error('boundary clear'));
    expect(b.reject).toHaveBeenCalledWith(new Error('boundary clear'));
    expect(hub.hasPendingCalls()).toBe(false);
  });

  it('generates distinct callIds for concurrent /call requests (no collisions)', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();
    const hub = backend.mcpHub;

    const N = 25;
    for (let i = 0; i < N; i++) {
      const entry = {
        callId: '',
        name: 'Bash',
        args: { i },
        resolve: vi.fn(),
        reject: vi.fn(),
        timer: setTimeout(() => {}, 60_000),
      };
      // Mirror McpHub's callId generation: 'call_' + 16 hex chars.
      entry.callId = 'call_' + Math.random().toString(16).slice(2, 18).padEnd(16, '0');
      (hub as any).pending.set(entry.callId, entry);
    }

    const ids = hub.getPendingCalls().map((c: any) => c.callId);
    expect(new Set(ids).size).toBe(N);

    // Cleanup.
    for (const e of (hub as any).pending.values()) clearTimeout(e.timer);
    hub.clearPendingCalls('test cleanup');
  });

  it('setTools called by one request does not corrupt in-flight calls from another', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();
    const hub = backend.mcpHub;

    // Session A sets v1 of a tool, then triggers a /call whose args are
    // cleansed against v1.
    hub.setTools([{
      name: 'tool',
      description: 'v1',
      input_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
    }]);
    const v1Call: any = {
      callId: 'in-flight-1',
      name: 'tool',
      args: {},
      resolve: vi.fn(),
      reject: vi.fn(),
      timer: setTimeout(() => {}, 60_000),
    };
    // Manually call the same code path the hub uses for cleansing.
    const original = (hub as any).originalSchemas.get('tool');
    v1Call.args = (await import('../server/mcp-hub.js')).cleanAndFixArguments(
      { x: 'kept', junk: 'drop' },
      original,
    );
    expect(v1Call.args).toEqual({ x: 'kept' });

    // Session B replaces the tool definition mid-flight. The hub clears
    // originalSchemas on every setTools — so session A's already-cleansed
    // args are NOT re-cleansed, but any NEW call would be against v2.
    hub.setTools([{
      name: 'tool',
      description: 'v2',
      input_schema: { type: 'object', properties: { y: { type: 'integer' } }, required: ['y'] },
    }]);
    expect(v1Call.args).toEqual({ x: 'kept' }); // untouched

    // A new call against v2 sees the new schema.
    const v2Args = (await import('../server/mcp-hub.js')).cleanAndFixArguments(
      { y: '7', x: 'stale' },
      (hub as any).originalSchemas.get('tool'),
    );
    expect(v2Args).toEqual({ y: 7 });

    // Cleanup.
    clearTimeout(v1Call.timer);
  });

  it('cleanAndFixArguments strips properties not in the schema — this is why missing required fields must be validated upstream', async () => {
    const { cleanAndFixArguments } = await import('../server/mcp-hub.js');
    const schema = {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    };
    // LS sends NO arguments at all.
    const args = cleanAndFixArguments({}, schema);
    // The hub deliberately leaves missing required fields as undefined
    // rather than synthesizing empty strings (per the comment in
    // cleanAndFixArguments). This test pins down that decision so any
    // future "fill with empty string" regression is caught.
    expect(args.command).toBeUndefined();
    expect(args).toEqual({});
  });

  it('end-to-end: hub /call → resolveCall returns the result that LS sees', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();
    const hub = backend.mcpHub;

    hub.setTools([{
      name: 'Bash',
      description: 'run',
      input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    }]);

    // Start a /call against the in-process hub, capture the pending call,
    // then resolve it with a synthetic tool_result and assert the
    // promise resolves with that exact content.
    const pending = new Promise<{ callId: string }>((resolve) => {
      hub.once('pending_call', (e: any) => resolve({ callId: e.callId }));
    });
    const callPromise = (async () => {
      const res = await fetch(`http://127.0.0.1:${hub.port}/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Bash', arguments: { command: 'ls' } }),
      });
      return { status: res.status, json: await res.json() };
    })();

    const { callId } = await pending;
    await hub.resolveCall(callId, {
      content: [{ type: 'text', text: 'file1\nfile2\n' }],
      isError: false,
    });
    const res = await callPromise;
    expect(res.status).toBe(200);
    expect(res.json.result.content[0].text).toBe('file1\nfile2\n');
  });

  it('end-to-end: tool_result isError:true → hub returns { content: [], isError: true } to the LS', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();
    const hub = backend.mcpHub;

    const pending = new Promise<string>((resolve) => {
      hub.once('pending_call', (e: any) => resolve(e.callId));
    });
    const callPromise = (async () => {
      const res = await fetch(`http://127.0.0.1:${hub.port}/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Bash', arguments: { command: 'false' } }),
      });
      return { status: res.status, json: await res.json() };
    })();

    const callId = await pending;
    // The HTTP /resolve endpoint is what Claude Code's tool_result
    // reaches (via routes/messages.ts). The isError flag is honored
    // only on this path — the programmatic resolveCall() API has no
    // isError parameter, so callers must use HTTP for the error case.
    await fetch(`http://127.0.0.1:${hub.port}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId, isError: true }),
    });
    const res = await callPromise;
    expect(res.status).toBe(200);
    expect(res.json.result).toEqual({ content: [], isError: true });
  });

  it('tool_use_id from a Claude tool_result resolves the matching hub callId (format match: call_<hex>)', async () => {
    const backend = new AntigravityBackend();
    await backend.initialize();
    const hub = backend.mcpHub;

    const pending = new Promise<string>((resolve) => {
      hub.once('pending_call', (e: any) => resolve(e.callId));
    });
    const callPromise = (async () => {
      const res = await fetch(`http://127.0.0.1:${hub.port}/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Bash', arguments: { command: 'ls' } }),
      });
      return res.json();
    })();

    const callId = await pending;
    // The hub uses call_<16 hex chars>; the SSE tool_use id is the same
    // string. The Claude tool_result.tool_use_id MUST match exactly to
    // be routed to this call.
    expect(callId).toMatch(/^call_[0-9a-f]{16}$/);

    // Simulate what routes/messages.ts does: it receives
    // { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: '...' }] }
    // and calls resolveCall(callId, result).
    await hub.resolveCall(callId, { content: [{ type: 'text', text: 'matched' }] });
    const result = await callPromise;
    expect(result.result.content[0].text).toBe('matched');
  });
});
