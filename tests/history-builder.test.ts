import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  groupTurns,
  buildHistorySteps,
  extractCurrentUserPayload,
  deterministicDocPath,
  serializeTurn,
  buildToolNameLookup,
} from '../server/converters/history-builder.js';
import { CortexStepType, CortexStepStatus } from 'antigravity-client/dist/src/gen/exa/cortex_pb/cortex_pb.js';
import type { ClaudeMessage } from '../server/types.js';

const DONE = CortexStepStatus.DONE;

describe('history-builder: deterministicDocPath', () => {
  it('returns identical path for identical (data, mediaType)', () => {
    const a = deterministicDocPath('AAAA', 'application/pdf', '/tmp/ws');
    const b = deterministicDocPath('AAAA', 'application/pdf', '/tmp/ws');
    expect(a).toBe(b);
  });

  it('differs when content differs', () => {
    const a = deterministicDocPath('AAAA', 'application/pdf', '/tmp/ws');
    const b = deterministicDocPath('BBBB', 'application/pdf', '/tmp/ws');
    expect(a).not.toBe(b);
  });

  it('differs when mediaType differs', () => {
    const a = deterministicDocPath('AAAA', 'application/pdf', '/tmp/ws');
    const b = deterministicDocPath('AAAA', 'text/plain', '/tmp/ws');
    expect(a).not.toBe(b);
  });

  it('includes a documents subdirectory and the right extension', () => {
    const p = deterministicDocPath('XYZ', 'image/png', '/tmp/ws');
    expect(p).toContain('/tmp/ws/documents/');
    expect(p.endsWith('.png')).toBe(true);
  });
});

describe('history-builder: groupTurns', () => {
  it('treats the last user message as the current instruction', () => {
    const msgs: ClaudeMessage[] = [
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'Q2' },
    ];
    const { pastTurns, currentUserMessage } = groupTurns(msgs);
    expect(pastTurns).toHaveLength(1);
    expect(pastTurns[0].userMessage.content).toBe('Q1');
    expect(pastTurns[0].assistantMessages).toHaveLength(1);
    expect(currentUserMessage.content).toBe('Q2');
  });

  it('groups consecutive assistant messages into the same turn', () => {
    const msgs: ClaudeMessage[] = [
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
      { role: 'user', content: 'Q2' },
    ];
    const { pastTurns } = groupTurns(msgs);
    expect(pastTurns).toHaveLength(1);
    expect(pastTurns[0].assistantMessages).toHaveLength(2);
  });

  it('throws on empty messages', () => {
    expect(() => groupTurns([])).toThrow();
  });

  it('throws when there is no user message', () => {
    expect(() => groupTurns([{ role: 'assistant', content: 'A' }])).toThrow();
  });

  it('handles multiple past turns', () => {
    const msgs: ClaudeMessage[] = [
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'Q2' },
      { role: 'assistant', content: 'A2' },
      { role: 'user', content: 'Q3' },
    ];
    const { pastTurns, currentUserMessage } = groupTurns(msgs);
    expect(pastTurns).toHaveLength(2);
    expect(pastTurns[0].userMessage.content).toBe('Q1');
    expect(pastTurns[1].userMessage.content).toBe('Q2');
    expect(currentUserMessage.content).toBe('Q3');
  });
});

describe('history-builder: serializeTurn', () => {
  it('renders a plain text turn as [User]/[Assistant]', () => {
    const msgs: ClaudeMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'next' },
    ];
    const { pastTurns } = groupTurns(msgs);
    expect(serializeTurn(pastTurns[0])).toBe('[User]: Hello\n[Assistant]: Hi there');
  });

  it('encodes a tool_use round-trip with the result from the NEXT turn', () => {
    const msgs: ClaudeMessage[] = [
      { role: 'user', content: 'Q' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { cmd: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file1\nfile2' }] },
      { role: 'assistant', content: 'I see file1 and file2' },
      { role: 'user', content: 'next' },
    ];
    const { pastTurns } = groupTurns(msgs);
    const out = serializeTurn(pastTurns[0], pastTurns[1]);
    expect(out).toBe(
      "[User]: Q\n" +
      "[Assistant called tool 'Bash' with id call_1]: {\"cmd\":\"ls\"}\n" +
      "[Tool 'Bash' returned]: file1\nfile2",
    );
  });

  it('encodes a tool_use without a matching result as "result not yet available"', () => {
    const msgs: ClaudeMessage[] = [
      { role: 'user', content: 'Q' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'orphan', name: 'Read', input: {} }] },
      { role: 'user', content: 'next' },
    ];
    const { pastTurns } = groupTurns(msgs);
    const out = serializeTurn(pastTurns[0], pastTurns[1]);
    expect(out).toBe(
      "[User]: Q\n" +
      "[Assistant called tool 'Read' with id orphan]: {}\n" +
      "[Tool 'Read' result not yet available]",
    );
  });

  it('encodes a tool error result with the [Tool errored] prefix', () => {
    const msgs: ClaudeMessage[] = [
      { role: 'user', content: 'Q' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_x', name: 'Bash', input: { cmd: 'false' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_x', content: 'err msg', is_error: true }] },
      { role: 'assistant', content: 'failed' },
      { role: 'user', content: 'next' },
    ];
    const { pastTurns } = groupTurns(msgs);
    const out = serializeTurn(pastTurns[0], pastTurns[1]);
    expect(out).toContain("[Tool errored]: err msg");
  });

  it('omits the [Assistant] line when the assistant produced no text or tool_use', () => {
    const msgs: ClaudeMessage[] = [
      { role: 'user', content: 'Q' },
      { role: 'assistant', content: [] },
      { role: 'user', content: 'next' },
    ];
    const { pastTurns } = groupTurns(msgs);
    const out = serializeTurn(pastTurns[0], pastTurns[1]);
    expect(out).toBe('[User]: Q');
  });
});

describe('history-builder: buildHistorySteps', () => {
  it('produces ONE UserInput per past turn whose userResponse carries the serialized turn', () => {
    const msgs: ClaudeMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'Next' },
    ];
    const { pastTurns } = groupTurns(msgs);
    const steps = buildHistorySteps(pastTurns, '/tmp/ws');
    // New architecture: one CortexStepUserInput per past turn (no
    // CortexStepPlannerResponse, since its server-issued signature
    // cannot be forged from the client side).
    expect(steps).toHaveLength(1);
    expect(steps[0].type).toBe(CortexStepType.USER_INPUT);
    expect(steps[0].status).toBe(DONE);
    expect(steps[0].step?.case).toBe('userInput');
    const u = steps[0].step?.value as any;
    expect(u.userResponse).toBe('[User]: Hello\n[Assistant]: Hi there');
    expect(u.query).toBe('[User]: Hello\n[Assistant]: Hi there');
    expect(u.items).toHaveLength(1);
    expect(u.items[0].chunk.case).toBe('text');
    expect(u.items[0].chunk.value).toBe('[User]: Hello\n[Assistant]: Hi there');
  });

  it('encodes a tool_use turn in userResponse text and produces exactly one step', () => {
    const msgs: ClaudeMessage[] = [
      { role: 'user', content: 'Q' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { cmd: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file1\nfile2' }] },
      { role: 'assistant', content: 'I see file1 and file2' },
      { role: 'user', content: 'next' },
    ];
    const { pastTurns } = groupTurns(msgs);
    const steps = buildHistorySteps(pastTurns, '/tmp/ws');
    // Two past turns → two UserInput steps. The tool round-trip lives
    // in the userResponse text of the first turn (tool_use is in turn 1,
    // tool_result is delivered in turn 2's userMessage).
    expect(steps).toHaveLength(2);
    const types = steps.map(s => s.type);
    expect(types).toEqual([CortexStepType.USER_INPUT, CortexStepType.USER_INPUT]);
    const u1 = steps[0].step?.value as any;
    expect(u1.userResponse).toBe(
      "[User]: Q\n" +
      "[Assistant called tool 'Bash' with id call_1]: {\"cmd\":\"ls\"}\n" +
      "[Tool 'Bash' returned]: file1\nfile2",
    );
    const u2 = steps[1].step?.value as any;
    // Turn 2 carries the tool_result (in userMessage) and the final
    // assistant text.
    expect(u2.userResponse).toBe(
      "[User]:\n" +
      "[Assistant]: I see file1 and file2",
    );
  });

  it('returns an empty array when there are no past turns', () => {
    const msgs: ClaudeMessage[] = [
      { role: 'user', content: 'only' },
    ];
    const { pastTurns } = groupTurns(msgs);
    const steps = buildHistorySteps(pastTurns, '/tmp/ws');
    expect(steps).toEqual([]);
  });

  it('emits one step per past turn even when the assistant produced empty content', () => {
    const msgs: ClaudeMessage[] = [
      { role: 'user', content: 'Q' },
      { role: 'assistant', content: [] },
      { role: 'user', content: 'next' },
    ];
    const { pastTurns } = groupTurns(msgs);
    const steps = buildHistorySteps(pastTurns, '/tmp/ws');
    expect(steps).toHaveLength(1);
    expect(steps[0].type).toBe(CortexStepType.USER_INPUT);
    const u = steps[0].step?.value as any;
    expect(u.userResponse).toBe('[User]: Q');
  });

  it('records image attachment markers in userResponse text (not the protobuf images field)', () => {
    const msgs: ClaudeMessage[] = [
      { role: 'user', content: [
        { type: 'text', text: 'see this' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ]},
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'next' },
    ];
    const { pastTurns } = groupTurns(msgs);
    const steps = buildHistorySteps(pastTurns, '/tmp/ws');
    expect(steps).toHaveLength(1);
    const u = steps[0].step?.value as any;
    // Past images are surfaced as a text marker, not as a structured
    // ImageData payload — the LS has no way to render the raw base64.
    expect(u.images).toHaveLength(0);
    expect(u.userResponse).toBe(
      '[User]: see this\n' +
      '[User attached image: image/png]\n' +
      '[Assistant]: ok',
    );
  });
});

describe('history-builder: extractCurrentUserPayload', () => {
  let workspaceDir: string;
  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'c2g-history-'));
  });

  it('returns plain text when content is a string', async () => {
    const out = await extractCurrentUserPayload(
      { role: 'user', content: 'plain' }, workspaceDir,
    );
    expect(out.text).toBe('plain');
    expect(out.images).toHaveLength(0);
    expect(out.documents).toHaveLength(0);
  });

  it('collects images and text independently', async () => {
    const out = await extractCurrentUserPayload({
      role: 'user',
      content: [
        { type: 'text', text: 'caption' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } },
      ],
    }, workspaceDir);
    expect(out.text).toBe('caption');
    expect(out.images).toHaveLength(1);
    expect(out.images[0].base64Data).toBe('BBBB');
  });

  it('writes document to deterministic path and is idempotent', async () => {
    const doc = { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf', data: 'DOCDATA' } };
    const msg: ClaudeMessage = { role: 'user', content: [doc] };

    const out1 = await extractCurrentUserPayload(msg, workspaceDir);
    expect(out1.documents).toHaveLength(1);
    const filePath1 = out1.documents[0].absolutePath;
    const expected = deterministicDocPath('DOCDATA', 'application/pdf', workspaceDir);
    expect(filePath1).toBe(expected);

    const s1 = await stat(filePath1);
    const bytes1 = (await readFile(filePath1)).byteLength;

    // Calling again should be idempotent (no throw, file untouched)
    const out2 = await extractCurrentUserPayload(msg, workspaceDir);
    expect(out2.documents[0].absolutePath).toBe(filePath1);
    const s2 = await stat(filePath1);
    const bytes2 = (await readFile(filePath1)).byteLength;
    expect(s2.mtimeMs).toBe(s1.mtimeMs);
    expect(bytes2).toBe(bytes1);

    // Clean up
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('appends a file-path reference marker to the text', async () => {
    const out = await extractCurrentUserPayload({
      role: 'user',
      content: [
        { type: 'text', text: 'see pdf' },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'XYZ' } },
      ],
    }, workspaceDir);
    expect(out.text).toContain('see pdf');
    expect(out.text).toContain('[User attached file:');
    expect(out.documents).toHaveLength(1);
    expect(out.text).toContain(out.documents[0].absolutePath);

    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('renders tool_result blocks as [Tool <name> returned]: <result>', async () => {
    // Caller supplies a lookup from the previous assistant message so
    // the tool name can be resolved. Without it, the rendering falls
    // back to the generic label "tool" (covered in the next test).
    const toolNameById = new Map([['call_abc', 'Bash']]);
    const out = await extractCurrentUserPayload({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_abc', content: 'total 4\nREADME.md\n' },
      ],
    }, workspaceDir, toolNameById);
    expect(out.text).toBe(
      "[Tool 'Bash' returned]:\ntotal 4\nREADME.md\n",
    );
  });

  it('renders tool_result with is_error=true using the error header', async () => {
    const toolNameById = new Map([['call_err', 'Read']]);
    const out = await extractCurrentUserPayload({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_err', content: 'EACCES: permission denied', is_error: true },
      ],
    }, workspaceDir, toolNameById);
    expect(out.text).toBe(
      "[Tool 'Read' returned error]:\nEACCES: permission denied",
    );
  });

  it('falls back to label "tool" when tool_use_id is not in the lookup', async () => {
    // An orphan tool_result (no matching tool_use in the previous
    // assistant message) is still rendered, but with a generic label
    // so the result text is never silently dropped.
    const out = await extractCurrentUserPayload({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'unknown_id', content: 'orphan result' },
      ],
    }, workspaceDir);
    expect(out.text).toBe(
      "[Tool 'tool' returned]:\norphan result",
    );
  });

  it('renders tool_result whose content is an array of blocks', async () => {
    // Anthropic allows tool_result.content to be an array of content
    // blocks. Flatten the text blocks; non-text blocks are
    // JSON-stringified so we never lose information.
    const toolNameById = new Map([['call_arr', 'Bash']]);
    const out = await extractCurrentUserPayload({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_arr',
          content: [
            { type: 'text', text: 'line 1' },
            { type: 'text', text: 'line 2' },
          ],
        },
      ],
    }, workspaceDir, toolNameById);
    expect(out.text).toBe(
      "[Tool 'Bash' returned]:\nline 1\nline 2",
    );
  });
});

describe('history-builder: buildToolNameLookup', () => {
  it('returns an empty map for an undefined assistant message', () => {
    const map = buildToolNameLookup(undefined);
    expect(map.size).toBe(0);
  });

  it('returns an empty map for a string-content assistant message', () => {
    const map = buildToolNameLookup({ role: 'assistant', content: 'plain' });
    expect(map.size).toBe(0);
  });

  it('collects every tool_use id → name pair', () => {
    const map = buildToolNameLookup({
      role: 'assistant',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', id: 'call_2', name: 'Read', input: { file_path: '/x' } },
      ],
    });
    expect(map.size).toBe(2);
    expect(map.get('call_1')).toBe('Bash');
    expect(map.get('call_2')).toBe('Read');
  });
});
