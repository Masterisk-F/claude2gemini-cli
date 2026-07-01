/**
 * Claude messages → Antigravity Trajectory Step[] converter
 *
 * Builds a sequence of `CortexStepUserInput` steps — one step per past
 * turn — where each step's `userResponse` carries the entire turn
 * (user message + assistant text + tool calls and their results)
 * serialised as plain text.
 *
 * No `CortexStepPlannerResponse` and no `CortexStepMcpTool` are emitted.
 * The LS's planner response `signature` is server-issued and cannot be
 * forged from the Claude API side, so injecting a plannerResponse with
 * an empty `signature` causes the LS to mis-handle the next turn (it
 * keeps the old plannerResponse but fails to generate a new one). By
 * encoding everything as text inside a userInput, we sidestep the
 * signature problem entirely.
 *
 * The trajectory is fed to `startCascade` via `baseTrajectoryIdentifier`
 * — pre-allocating the cascadeId so that the trajectory's `cascadeId`
 * and `StartCascadeRequest.cascadeId` match (this is required to keep
 * the LS's view of the trajectory consistent with the cascade).
 *
 * Trade-off: the past assistant's tool calls lose their structured form
 * (id, name, args) and become inline text. The LS planner therefore
 * cannot replay those tool calls — but it does receive enough textual
 * context to make sense of the conversation and respond to the new
 * user message appropriately.
 */

import { createHash } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

import {
  Step,
} from 'antigravity-client/dist/src/gen/exa/gemini_coder/proto/trajectory_pb.js';
import {
  CortexStepUserInput,
  CortexStepType,
  CortexStepStatus,
} from 'antigravity-client/dist/src/gen/exa/cortex_pb/cortex_pb.js';
import {
  TextOrScopeItem,
  ImageData,
  PathScopeItem,
  ContextScopeItem,
} from 'antigravity-client/dist/src/gen/exa/codeium_common_pb/codeium_common_pb.js';
import { ChatClientRequestStreamClientType } from 'antigravity-client/dist/src/gen/exa/chat_client_server_pb/chat_client_server_pb.js';

import type {
  ClaudeMessage,
  ClaudeContentBlock,
  ClaudeTextBlock,
  ClaudeToolUseBlock,
  ClaudeToolResultBlock,
  ClaudeImageBlock,
  ClaudeDocumentBlock,
} from '../types.js';

const DONE = CortexStepStatus.DONE;
const CLIENT_TYPE_IDE = ChatClientRequestStreamClientType.IDE;

export interface ExtractedTurn {
  userMessage: ClaudeMessage;
  assistantMessages: ClaudeMessage[];
}

export interface CurrentUserPayload {
  text: string;
  images: { base64Data: string; mimeType: string }[];
  documents: { data: string; mediaType: string; index: number; absolutePath: string }[];
}

function findLastIndex<T>(arr: T[], pred: (x: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return i;
  }
  return -1;
}

function isTextBlock(b: ClaudeContentBlock): b is ClaudeTextBlock {
  return b.type === 'text';
}

function isImageBlock(b: ClaudeContentBlock): b is ClaudeImageBlock {
  return b.type === 'image';
}

function isDocumentBlock(b: ClaudeContentBlock): b is ClaudeDocumentBlock {
  return b.type === 'document';
}

function isToolUseBlock(b: ClaudeContentBlock): b is ClaudeToolUseBlock {
  return b.type === 'tool_use' || b.type === 'server_tool_use';
}

function isToolResultBlock(b: ClaudeContentBlock): b is ClaudeToolResultBlock {
  return b.type === 'tool_result';
}

function extractTextFromContent(content: string | ClaudeContentBlock[]): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const b of content) {
    if (isTextBlock(b) && b.text) parts.push(b.text);
  }
  return parts.join('\n');
}

/**
 * Render a `tool_result` block's content as plain text. Anthropic
 * allows `content` to be either a string (the common case for
 * short tool outputs) or an array of content blocks (used when the
 * tool result is large or multi-modal). We flatten to plain text
 * here so it can be embedded in the user instruction string.
 */
function extractToolResultContent(content: string | ClaudeContentBlock[]): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const b of content) {
    if (isTextBlock(b) && b.text) {
      parts.push(b.text);
    } else {
      parts.push(JSON.stringify(b));
    }
  }
  return parts.join('\n');
}

/**
 * Build a lookup map of `tool_use_id` → tool name from an assistant
 * message's `tool_use` blocks. Used by `extractCurrentUserPayload`
 * to render a user-following `tool_result` block with a human-
 * readable tool name like `[Tool 'Bash' returned]: …`. If the
 * caller has no prior assistant message (e.g. the very first user
 * turn), an empty map is returned and tool_result rendering falls
 * back to the generic label `tool`.
 */
export function buildToolNameLookup(
  prevAssistant: ClaudeMessage | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!prevAssistant || typeof prevAssistant.content === 'string') return map;
  for (const b of prevAssistant.content) {
    if (isToolUseBlock(b)) {
      map.set(b.id, b.name);
    }
  }
  return map;
}

/**
 * Compute a deterministic, content-addressed path for a base64 document.
 * Same (data, mediaType) always yields the same path, so writes are idempotent
 * and the file may be referenced across requests without re-uploading.
 */
export function deterministicDocPath(
  data: string,
  mediaType: string,
  workspaceDir: string,
): string {
  const hash = createHash('sha256').update(data).update('\0').update(mediaType).digest('hex');
  const ext = mediaType.split('/')[1] || 'bin';
  return join(workspaceDir, 'documents', `doc_${hash.slice(0, 16)}.${ext}`);
}

async function writeDocumentIfAbsent(absPath: string, data: string): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true });
  try {
    await access(absPath);
  } catch {
    const buffer = Buffer.from(data, 'base64');
    await writeFile(absPath, buffer);
  }
}

/**
 * Render the textual representation of a single past turn. Used by
 * `serializeTurn` and exposed as a top-level export so tests can verify
 * the exact text without instantiating protobuf messages.
 *
 * `nextTurn` is the turn immediately after `turn`; it is consulted only
 * for tool_result blocks (which Claude delivers in the following user
 * message).
 */
export function serializeTurn(turn: ExtractedTurn, nextTurn?: ExtractedTurn): string {
  const lines: string[] = [];

  // --- USER side ---
  lines.push(renderUserMessage(turn.userMessage));

  // --- ASSISTANT side (text + tool_use) ---
  const toolCalls: { id: string; name: string; args: unknown }[] = [];
  for (const msg of turn.assistantMessages) {
    if (msg.role !== 'assistant') continue;
    if (typeof msg.content === 'string') {
      if (msg.content) lines.push(`[Assistant]: ${msg.content}`);
      continue;
    }
    for (const b of msg.content) {
      if (isTextBlock(b) && b.text) {
        lines.push(`[Assistant]: ${b.text}`);
      } else if (isToolUseBlock(b)) {
        toolCalls.push({ id: b.id, name: b.name, args: b.input ?? {} });
      }
    }
  }

  // --- TOOL round-trips ---
  for (const call of toolCalls) {
    lines.push(
      `[Assistant called tool '${call.name}' with id ${call.id}]: ${JSON.stringify(call.args)}`,
    );
    const resultBlock = findToolResult(turn, nextTurn, call.id);
    if (resultBlock) {
      const resultText = stringFromToolResult(resultBlock.content);
      const prefix = resultBlock.is_error ? '[Tool errored]' : `[Tool '${call.name}' returned]`;
      lines.push(`${prefix}: ${resultText}`);
    } else {
      lines.push(`[Tool '${call.name}' result not yet available]`);
    }
  }

  return lines.join('\n');
}

function renderUserMessage(msg: ClaudeMessage): string {
  if (typeof msg.content === 'string') {
    return msg.content ? `[User]: ${msg.content}` : '[User]:';
  }
  const parts: string[] = [];
  const attachments: string[] = [];
  for (const b of msg.content) {
    if (isTextBlock(b) && b.text) {
      parts.push(b.text);
    } else if (isImageBlock(b)) {
      const mt = b.source?.media_type ?? 'image';
      attachments.push(`[User attached image: ${mt}]`);
    } else if (isDocumentBlock(b)) {
      // The deterministic path is computed by extractCurrentUserPayload
      // for the CURRENT user message. For past turns we don't have the
      // raw bytes here, so we surface a generic marker. (In practice
      // document blocks are rare in past turns of a Claude Code session
      // because Claude Code streams files as local reads, not as
      // base64-attached documents in `messages`.)
      attachments.push(`[User attached document]`);
    }
    // tool_result blocks are not rendered as user text — they are
    // paired with the tool_use above and rendered as "[Tool returned]".
  }
  const userLine = parts.length > 0 ? `[User]: ${parts.join('\n')}` : '[User]:';
  return attachments.length > 0 ? `${userLine}\n${attachments.join('\n')}` : userLine;
}

function findToolResult(
  turn: ExtractedTurn,
  nextTurn: ExtractedTurn | undefined,
  callId: string,
): ClaudeToolResultBlock | undefined {
  // Look in the current turn's userMessage first (Claude API allows
  // tool_result blocks to be interleaved with the original user
  // message), then in the next turn's userMessage (the typical
  // delivery location), and finally in any user-role content within
  // the current turn's assistantMessages.
  if (typeof turn.userMessage.content !== 'string') {
    for (const b of turn.userMessage.content) {
      if (isToolResultBlock(b) && b.tool_use_id === callId) return b;
    }
  }
  if (nextTurn && typeof nextTurn.userMessage.content !== 'string') {
    for (const b of nextTurn.userMessage.content) {
      if (isToolResultBlock(b) && b.tool_use_id === callId) return b;
    }
  }
  for (const msg of turn.assistantMessages) {
    if (msg.role !== 'user' || typeof msg.content === 'string') continue;
    for (const b of msg.content) {
      if (isToolResultBlock(b) && b.tool_use_id === callId) return b;
    }
  }
  return undefined;
}

function stringFromToolResult(content: string | ClaudeContentBlock[]): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const b of content) {
    if (isTextBlock(b) && b.text) parts.push(b.text);
  }
  return parts.join('\n');
}

/**
 * Convert a single past turn into ONE `CortexStepUserInput` step whose
 * `userResponse` text is the full turn (user + assistant + tools) in a
 * human-readable form. The LS planner reads this as a single user
 * message that contains the conversation context up to and including
 * this turn.
 */
export function turnToSteps(
  turn: ExtractedTurn,
  _workspaceDir: string,
  nextTurn?: ExtractedTurn,
): Step[] {
  const text = serializeTurn(turn, nextTurn);
  const step = new CortexStepUserInput({
    items: [new TextOrScopeItem({ chunk: { case: 'text', value: text } })],
    userResponse: text,
    query: text,
    images: [],
    isQueuedMessage: false,
    clientType: CLIENT_TYPE_IDE,
  });
  return [new Step({
    type: CortexStepType.USER_INPUT,
    status: DONE,
    step: { case: 'userInput', value: step },
  })];
}

export function buildHistorySteps(pastTurns: ExtractedTurn[], workspaceDir: string): Step[] {
  const out: Step[] = [];
  for (let i = 0; i < pastTurns.length; i++) {
    const turn = pastTurns[i]!;
    const nextTurn = i + 1 < pastTurns.length ? pastTurns[i + 1] : undefined;
    out.push(...turnToSteps(turn, workspaceDir, nextTurn));
  }
  return out;
}

/**
 * Extract the text + multimodal payloads from the current user message.
 * Documents are written to deterministic paths in the workspace (idempotent)
 * and their paths are surfaced as `[User attached file: ...]` markers in
 * the text — the LS can then read them via the workspace.
 *
 * `tool_result` blocks (the user's reply to a tool call from the
 * previous assistant turn) are rendered as
 *   `[Tool '<name>' returned]:\n<result text>`
 * (or `[Tool '<name>' returned error]:\n<result text>` when
 * `is_error` is true). The `<name>` is resolved from
 * `toolNameById`, which the caller is expected to populate from the
 * previous assistant message's `tool_use` blocks. Without the map we
 * fall back to the generic label `tool` so the result is never
 * silently dropped.
 *
 * Without this handling, a turn whose payload is only a tool result
 * would be sent to the LS as an essentially-empty user message,
 * producing very short or incoherent model responses.
 */
export async function extractCurrentUserPayload(
  currentMessage: ClaudeMessage,
  workspaceDir: string,
  toolNameById: Map<string, string> = new Map(),
): Promise<CurrentUserPayload> {
  const images: { base64Data: string; mimeType: string }[] = [];
  const documents: { data: string; mediaType: string; index: number; absolutePath: string }[] = [];
  const textParts: string[] = [];

  if (typeof currentMessage.content === 'string') {
    if (currentMessage.content) textParts.push(currentMessage.content);
    return { text: textParts.join('\n'), images, documents };
  }

  let docIdx = 0;
  for (const b of currentMessage.content) {
    if (isTextBlock(b)) {
      if (b.text) textParts.push(b.text);
    } else if (isImageBlock(b)) {
      if (b.source?.data && b.source?.media_type) {
        images.push({ base64Data: b.source.data, mimeType: b.source.media_type });
      }
    } else if (isDocumentBlock(b)) {
      if (b.source?.data && b.source?.media_type) {
        const absPath = deterministicDocPath(b.source.data, b.source.media_type, workspaceDir);
        await writeDocumentIfAbsent(absPath, b.source.data);
        documents.push({ data: b.source.data, mediaType: b.source.media_type, index: docIdx++, absolutePath: absPath });
        textParts.push(`[User attached file: ${absPath}]`);
      }
    } else if (isToolResultBlock(b)) {
      const toolName = toolNameById.get(b.tool_use_id) ?? 'tool';
      const resultText = extractToolResultContent(b.content);
      const header = b.is_error
        ? `[Tool '${toolName}' returned error]:\n`
        : `[Tool '${toolName}' returned]:\n`;
      textParts.push(header + resultText);
    }
  }

  return { text: textParts.join('\n'), images, documents };
}

/**
 * Decompose `messages` into a sequence of past turns and the final user
 * instruction. A turn is `user → assistant(0+ round-trips of tool_use/tool_result)`.
 *
 * The very last user-role message is treated as the live user instruction and
 * is NOT included in `pastTurns`.
 */
export function groupTurns(messages: ClaudeMessage[]): {
  pastTurns: ExtractedTurn[];
  currentUserMessage: ClaudeMessage;
} {
  if (messages.length === 0) {
    throw new Error('groupTurns: messages must not be empty');
  }
  const lastUserIdx = findLastIndex(messages, (m) => m.role === 'user');
  if (lastUserIdx === -1) {
    throw new Error('groupTurns: no user message found in messages');
  }

  const currentUserMessage = messages[lastUserIdx];
  const pastMessages = messages.slice(0, lastUserIdx);

  const turns: ExtractedTurn[] = [];
  let currentTurn: ExtractedTurn | null = null;

  for (const msg of pastMessages) {
    if (msg.role === 'user') {
      if (currentTurn) turns.push(currentTurn);
      currentTurn = { userMessage: msg, assistantMessages: [] };
    } else if (msg.role === 'assistant') {
      if (!currentTurn) continue;
      currentTurn.assistantMessages.push(msg);
    }
  }
  if (currentTurn) turns.push(currentTurn);

  return { pastTurns: turns, currentUserMessage };
}
