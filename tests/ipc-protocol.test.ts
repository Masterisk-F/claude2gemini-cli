import { test, expect } from 'vitest';
import { serializeIPCMessage, parseIPCMessage, type ParentMessage, type ChildMessage } from '../server/ipc-protocol.js';

test('IPC Protocol: serialize and parse ParentMessage', () => {
    const msg: ParentMessage = {
        type: 'request',
        id: 'req-1',
        sessionId: 'sess-1',
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
    };

    const serialized = serializeIPCMessage(msg);
    expect(serialized.endsWith('\n')).toBe(true);

    const parsed = parseIPCMessage<ParentMessage>(serialized);
    expect(parsed).toEqual(msg);
});

test('IPC Protocol: serialize and parse ChildMessage', () => {
    const msg: ChildMessage = {
        type: 'stream_event',
        sessionId: 'sess-1',
        event: { type: 'content', value: 'Hi' }
    };

    const serialized = serializeIPCMessage(msg);
    const parsed = parseIPCMessage<ChildMessage>(serialized);
    expect(parsed).toEqual(msg);
});

test('IPC Protocol: turn_end message', () => {
    const msg: ChildMessage = {
        type: 'turn_end',
        sessionId: 'sess-1',
        stopReason: 'end_turn'
    };

    const serialized = serializeIPCMessage(msg);
    const parsed = parseIPCMessage<ChildMessage>(serialized);
    expect(parsed).toEqual(msg);
});
