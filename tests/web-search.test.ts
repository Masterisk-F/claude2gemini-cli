import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { messagesRouter } from '../server/routes/messages.js';
import { childManager } from '../server/child-manager.js';
import { accountPool } from '../server/account-pool.js';
import type { ChildMessage, ParentMessage } from '../server/ipc-protocol.js';
import { EventEmitter } from 'node:events';

describe('Web Search E2E', () => {
    let app: express.Application;

    beforeAll(() => {
        app = express();
        app.use(express.json());
        app.use('/v1/messages', messagesRouter);
    });

    it('handles web_search non-streaming', async () => {
        vi.spyOn(accountPool, 'nextAccount').mockReturnValue('test-account');
        const mockEvents = new EventEmitter();
        vi.spyOn(childManager, 'sendRequest').mockImplementation(async (accountId, msg) => {
            const pMsg = msg as ParentMessage;
            if (pMsg.type === 'request') {
                setTimeout(() => {
                    mockEvents.emit('message', { type: 'server_tool_call', sessionId: pMsg.sessionId, callId: 'call_1', name: 'web_search', args: { query: 'test' } } as ChildMessage);
                    setTimeout(() => {
                        mockEvents.emit('message', { type: 'server_tool_result', sessionId: pMsg.sessionId, callId: 'call_1', result: { sources: [], llmContent: 'found it' } } as ChildMessage);
                        setTimeout(() => {
                            mockEvents.emit('message', { type: 'stream_event', sessionId: pMsg.sessionId, event: { type: 'content', value: 'result is found it' } } as ChildMessage);
                            mockEvents.emit('message', { type: 'turn_end', sessionId: pMsg.sessionId, stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } } as ChildMessage);
                        }, 10);
                    }, 10);
                }, 10);
            }
        });

        vi.spyOn(childManager, 'onMessage').mockImplementation((accountId, cb) => {
            mockEvents.on('message', cb);
            return () => mockEvents.off('message', cb);
        });

        const res = await request(app)
            .post('/v1/messages')
            .send({
                model: 'claude-3-opus-20240229',
                messages: [{ role: 'user', content: 'search' }],
                tools: [{ name: 'web_search', description: 'desc', type: 'web_search_20260209', input_schema: {} }]
            });

        expect(res.status).toBe(200);
        expect(res.body.content).toBeDefined();

        const content = res.body.content;
        expect(content[0].type).toBe('server_tool_use');
        expect(content[0].name).toBe('web_search');
        expect(content[1].type).toBe('web_search_tool_result');
        expect(content[2].type).toBe('text');
        expect(content[2].text).toBe('result is found it');
    });
});
