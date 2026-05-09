import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { messagesRouter } from '../server/routes/messages.js';
import { accountPool } from '../server/account-pool.js';
import { childManager } from '../server/child-manager.js';
import { EventEmitter } from 'node:events';
import type { ChildMessage, ParentMessage } from '../server/ipc-protocol.js';

describe('Token Usage Reporting', () => {
    let app: express.Application;

    beforeAll(() => {
        app = express();
        app.use(express.json());
        app.use('/v1/messages', messagesRouter);
    });

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('reports input and output tokens in non-streaming response', async () => {
        vi.spyOn(accountPool, 'nextAccount').mockReturnValue('test-account');
        const mockEvents = new EventEmitter();

        vi.spyOn(childManager, 'sendRequest').mockImplementation(async (accountId, msg) => {
            const pMsg = msg as ParentMessage;
            if (pMsg.type === 'request') {
                setTimeout(() => {
                    mockEvents.emit('message', { type: 'stream_event', sessionId: pMsg.sessionId, event: { type: 'content', value: 'hello' } } as ChildMessage);
                    mockEvents.emit('message', {
                        type: 'turn_end',
                        sessionId: pMsg.sessionId,
                        stopReason: 'end_turn',
                        usage: { input_tokens: 123, output_tokens: 45, cache_read_tokens: 67 }
                    } as ChildMessage);
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
                model: 'claude-3-sonnet-20240229',
                messages: [{ role: 'user', content: 'hi' }],
                stream: false
            });

        expect(res.status).toBe(200);
        expect(res.body.usage.input_tokens).toBe(123);
        expect(res.body.usage.output_tokens).toBe(45);
        expect(res.body.usage.cache_read_tokens).toBe(67);
    });

    it('reports input and output tokens in streaming response (message_delta)', async () => {
        vi.spyOn(accountPool, 'nextAccount').mockReturnValue('test-account');
        const mockEvents = new EventEmitter();

        vi.spyOn(childManager, 'sendRequest').mockImplementation(async (accountId, msg) => {
            const pMsg = msg as ParentMessage;
            if (pMsg.type === 'request') {
                setTimeout(() => {
                    // Send model_info first (newly added event)
                    mockEvents.emit('message', {
                        type: 'stream_event',
                        sessionId: pMsg.sessionId,
                        event: { type: 'model_info', value: JSON.stringify({ estimated_input_tokens: 100 }) }
                    } as ChildMessage);

                    setTimeout(() => {
                        mockEvents.emit('message', { type: 'stream_event', sessionId: pMsg.sessionId, event: { type: 'content', value: 'hello' } } as ChildMessage);
                        mockEvents.emit('message', {
                            type: 'turn_end',
                            sessionId: pMsg.sessionId,
                            stopReason: 'end_turn',
                            usage: { input_tokens: 123, output_tokens: 45, cache_read_tokens: 67 }
                        } as ChildMessage);
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
                model: 'claude-3-sonnet-20240229',
                messages: [{ role: 'user', content: 'hi' }],
                stream: true
            });

        expect(res.status).toBe(200);

        const lines = res.text.split('\n').filter((l: string) => l.startsWith('data: '));
        const events = lines.map((line: string) => JSON.parse(line.replace('data: ', '')));

        // Check message_start has estimated tokens
        const messageStart = events.find((e: any) => e.type === 'message_start');
        expect(messageStart).toBeDefined();
        expect(messageStart.message.usage.input_tokens).toBe(100);

        // Check message_delta has final tokens
        const messageDelta = events.find((e: any) => e.type === 'message_delta');
        expect(messageDelta).toBeDefined();
        expect(messageDelta.usage.input_tokens).toBe(123);
        expect(messageDelta.usage.output_tokens).toBe(45);
        expect(messageDelta.usage.cache_read_tokens).toBe(67);
    });
});
