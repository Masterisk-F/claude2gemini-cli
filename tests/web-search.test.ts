import { describe, it, expect, vi, beforeAll } from 'vitest';
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

    it('handles web_search non-streaming with mapped results', async () => {
        vi.spyOn(accountPool, 'nextAccount').mockReturnValue('test-account');
        const mockEvents = new EventEmitter();
        const claudeMappedResult = [
            { type: 'web_search_result', url: 'http://example.com', title: 'Example', encrypted_content: '...', page_age: 'April 12, 2026' }
        ];

        vi.spyOn(childManager, 'sendRequest').mockImplementation(async (accountId, msg) => {
            const pMsg = msg as ParentMessage;
            if (pMsg.type === 'request') {
                setTimeout(() => {
                    mockEvents.emit('message', { type: 'server_tool_call', sessionId: pMsg.sessionId, callId: 'srvtoolu_abc123', name: 'web_search', args: { query: 'test' } } as ChildMessage);
                    setTimeout(() => {
                        mockEvents.emit('message', { type: 'server_tool_result', sessionId: pMsg.sessionId, callId: 'srvtoolu_abc123', result: claudeMappedResult } as ChildMessage);
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
                tools: [{ name: 'web_search', description: 'desc', type: 'web_search_20260209' }]
            });

        expect(res.status).toBe(200);
        expect(res.body.content).toBeDefined();

        const content = res.body.content;
        expect(content[0].type).toBe('server_tool_use');
        expect(content[0].name).toBe('web_search');
        expect(content[1].type).toBe('web_search_tool_result');
        expect(content[1].content).toEqual(claudeMappedResult);
        expect(content[2].type).toBe('text');
        expect(content[2].text).toBe('result is found it');

        // 問題1: usage.server_tool_use.web_search_requests が含まれること
        expect(res.body.usage).toBeDefined();
        expect(res.body.usage.server_tool_use).toBeDefined();
        expect(res.body.usage.server_tool_use.web_search_requests).toBe(1);

        // 問題2(A案): テキストブロックに citations が付与されること
        expect(content[2].citations).toBeDefined();
        expect(content[2].citations.length).toBe(1);
        expect(content[2].citations[0].type).toBe('web_search_result_location');
        expect(content[2].citations[0].url).toBe('http://example.com');
        expect(content[2].citations[0].title).toBe('Example');
    });

    it('handles web_search streaming', async () => {
        vi.spyOn(accountPool, 'nextAccount').mockReturnValue('test-account');
        const mockEvents = new EventEmitter();
        const claudeMappedResult = [
            { type: 'web_search_result', url: 'http://example.com', title: 'Example', encrypted_content: '...', page_age: 'April 12, 2026' }
        ];

        vi.spyOn(childManager, 'sendRequest').mockImplementation(async (accountId, msg) => {
            const pMsg = msg as ParentMessage;
            if (pMsg.type === 'request') {
                setTimeout(() => {
                    mockEvents.emit('message', { type: 'server_tool_call', sessionId: pMsg.sessionId, callId: 'srvtoolu_xyz789', name: 'web_search', args: { query: 'test' } } as ChildMessage);
                    setTimeout(() => {
                        mockEvents.emit('message', { type: 'server_tool_result', sessionId: pMsg.sessionId, callId: 'srvtoolu_xyz789', result: claudeMappedResult } as ChildMessage);
                        setTimeout(() => {
                            mockEvents.emit('message', { type: 'stream_event', sessionId: pMsg.sessionId, event: { type: 'content', value: 'done' } } as ChildMessage);
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
                tools: [{ name: 'web_search', type: 'web_search_20260209' }],
                stream: true
            });

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('text/event-stream');

        const lines = res.text.split('\n').filter((l: string) => l.startsWith('data: '));
        const events = lines.map((line: string) => JSON.parse(line.replace('data: ', '')));

        const toolUseStart = events.find((e: any) => e.type === 'content_block_start' && e.content_block?.type === 'server_tool_use');
        expect(toolUseStart).toBeDefined();
        expect(toolUseStart.content_block.name).toBe('web_search');

        const toolResultStart = events.find((e: any) => e.type === 'content_block_start' && e.content_block?.type === 'web_search_tool_result');
        expect(toolResultStart).toBeDefined();
        expect(toolResultStart.content_block.content).toEqual(claudeMappedResult);

        const messageDelta = events.find((e: any) => e.type === 'message_delta');
        expect(messageDelta).toBeDefined();
        expect(messageDelta.delta.stop_reason).toBe('end_turn');

        // 問題1: message_delta の usage に server_tool_use が含まれること
        expect(messageDelta.usage.server_tool_use).toBeDefined();
        expect(messageDelta.usage.server_tool_use.web_search_requests).toBe(1);

        // 問題2(A案): テキストブロックの content_block_start に citations が含まれること
        const textBlockStart = events.find((e: any) => e.type === 'content_block_start' && e.content_block?.type === 'text');
        expect(textBlockStart).toBeDefined();
        expect(textBlockStart.content_block.citations).toBeDefined();
        expect(textBlockStart.content_block.citations.length).toBe(1);
        expect(textBlockStart.content_block.citations[0].type).toBe('web_search_result_location');
        expect(textBlockStart.content_block.citations[0].url).toBe('http://example.com');
    });

    it('問題3: non-streaming - server_tool_use の ID が srvtoolu_ プレフィックスを持つ場合にそのまま保持される', async () => {
        // child-worker が生成した srvtoolu_ プレフィックス付き ID を
        // 親プロセスがそのままレスポンスに含めることを検証する
        vi.spyOn(accountPool, 'nextAccount').mockReturnValue('test-account');
        const mockEvents = new EventEmitter();
        const srvtoolId = 'srvtoolu_abc12345678901234567890';
        const claudeMappedResult = [
            { type: 'web_search_result', url: 'http://example.com', title: 'Example', encrypted_content: '...', page_age: 'April 12, 2026' }
        ];

        vi.spyOn(childManager, 'sendRequest').mockImplementation(async (accountId, msg) => {
            const pMsg = msg as ParentMessage;
            if (pMsg.type === 'request') {
                setTimeout(() => {
                    mockEvents.emit('message', { type: 'server_tool_call', sessionId: pMsg.sessionId, callId: srvtoolId, name: 'web_search', args: { query: 'test' } } as ChildMessage);
                    setTimeout(() => {
                        mockEvents.emit('message', { type: 'server_tool_result', sessionId: pMsg.sessionId, callId: srvtoolId, result: claudeMappedResult } as ChildMessage);
                        setTimeout(() => {
                            mockEvents.emit('message', { type: 'stream_event', sessionId: pMsg.sessionId, event: { type: 'content', value: 'result' } } as ChildMessage);
                            mockEvents.emit('message', { type: 'turn_end', sessionId: pMsg.sessionId, stopReason: 'end_turn', usage: { input_tokens: 5, output_tokens: 10 } } as ChildMessage);
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
                tools: [{ name: 'web_search', description: 'desc', type: 'web_search_20260209' }]
            });

        expect(res.status).toBe(200);
        const content = res.body.content;

        // 問題3: srvtoolu_ プレフィックスが保持されていること
        expect(content[0].type).toBe('server_tool_use');
        expect(content[0].id).toBe(srvtoolId);
        expect(content[0].id.startsWith('srvtoolu_')).toBe(true);

        // tool_use_id も同じIDを参照していること
        expect(content[1].type).toBe('web_search_tool_result');
        expect(content[1].tool_use_id).toBe(srvtoolId);
    });

    it('accumulates citations from multiple web_search results in non-streaming mode', async () => {
        vi.spyOn(accountPool, 'nextAccount').mockReturnValue('test-account');
        const mockEvents = new EventEmitter();
        
        const result1 = [
            { type: 'web_search_result', url: 'http://source1.com', title: 'Source 1', encrypted_content: 'source1-b64', page_age: 'Today' }
        ];
        const result2 = [
            { type: 'web_search_result', url: 'http://source2.com', title: 'Source 2', encrypted_content: 'source2-b64', page_age: 'Today' }
        ];

        vi.spyOn(childManager, 'sendRequest').mockImplementation(async (accountId, msg) => {
            const pMsg = msg as ParentMessage;
            if (pMsg.type === 'request') {
                setTimeout(() => {
                    // First search
                    mockEvents.emit('message', { type: 'server_tool_call', sessionId: pMsg.sessionId, callId: 'srvtoolu_1', name: 'web_search', args: { query: 'q1' } } as ChildMessage);
                    setTimeout(() => {
                        mockEvents.emit('message', { type: 'server_tool_result', sessionId: pMsg.sessionId, callId: 'srvtoolu_1', result: result1 } as ChildMessage);
                        
                        setTimeout(() => {
                            // Second search
                            mockEvents.emit('message', { type: 'server_tool_call', sessionId: pMsg.sessionId, callId: 'srvtoolu_2', name: 'web_search', args: { query: 'q2' } } as ChildMessage);
                            setTimeout(() => {
                                mockEvents.emit('message', { type: 'server_tool_result', sessionId: pMsg.sessionId, callId: 'srvtoolu_2', result: result2 } as ChildMessage);
                                
                                setTimeout(() => {
                                    mockEvents.emit('message', { type: 'stream_event', sessionId: pMsg.sessionId, event: { type: 'content', value: 'Search completed.' } } as ChildMessage);
                                    mockEvents.emit('message', { type: 'turn_end', sessionId: pMsg.sessionId, stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } } as ChildMessage);
                                }, 10);
                            }, 10);
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
                messages: [{ role: 'user', content: 'search twice' }],
                tools: [{ name: 'web_search', description: 'desc', type: 'web_search_20260209' }]
            });

        expect(res.status).toBe(200);
        const content = res.body.content;

        // Verify content blocks
        expect(content[0].type).toBe('server_tool_use');
        expect(content[1].type).toBe('web_search_tool_result');
        expect(content[2].type).toBe('server_tool_use');
        expect(content[3].type).toBe('web_search_tool_result');
        expect(content[4].type).toBe('text');

        // Verify citations are accumulated
        expect(content[4].citations).toBeDefined();
        expect(content[4].citations.length).toBe(2);
        expect(content[4].citations[0].url).toBe('http://source1.com');
        expect(content[4].citations[1].url).toBe('http://source2.com');
        
        // Verify field name mapping
        expect(content[4].citations[0].encrypted_index).toBe('source1-b64');
        expect(content[4].citations[1].encrypted_index).toBe('source2-b64');

        // Verify usage counter
        expect(res.body.usage.server_tool_use.web_search_requests).toBe(2);
    });
});
