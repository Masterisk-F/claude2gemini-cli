/**
 * Antigravity Backend Implementation
 *
 * Manages the lifecycle of the Antigravity Language Server (LS)
 * and provides a bridge between Claude API requests and Antigravity Cascades.
 *
 * Stateful session continuation:
 *   The LS holds trajectory state per Cascade. The proxy keeps a
 *   `sessionStore` (sessionId → cascadeId) and re-attaches to the
 *   same Cascade on every request in the same Claude Code session.
 *   The first user message in the request is used as the session
 *   anchor; we hash it (SHA-256) to derive a stable sessionId.
 *
 *   The production LS does NOT honor `baseTrajectoryIdentifier.trajectory`
 *   with structured steps (the trajectory is discarded, observed
 *   symptom: `total_steps` remains at 1 and the planner produces an
 *   empty response). The session-continuation architecture sidesteps
 *   this by keeping the Cascade alive across requests.
 *
 *   On Cascade error / disposal / LRU eviction, the trajectory is
 *   deleted via `deleteCascadeTrajectory` so the LS does not leak
 *   state for sessions that no longer exist.
 */

import { randomUUID } from 'node:crypto';
import { AntigravityClient, readAuthStatus } from 'antigravity-client';
import {
  TextOrScopeItem, ModelOrAlias, Metadata, ImageData, ContextScopeItem, PathScopeItem,
} from 'antigravity-client/dist/src/gen/exa/codeium_common_pb/codeium_common_pb.js';
import {
  CascadeConfig, CascadePlannerConfig, CascadeConversationalPlannerConfig,
  CascadeToolConfig,
  RunCommandToolConfig, SearchWebToolConfig, MemoryToolConfig, McpToolConfig,
  MqueryToolConfig, FindToolConfig, GenerateImageToolConfig, TrajectorySearchToolConfig,
  AntigravityBrowserToolConfig, BrowserSubagentToolConfig, InvokeSubagentToolConfig,
  NotebookEditToolConfig, AskQuestionToolConfig, ReadKnowledgeBaseItemToolConfig,
  WorkspaceAPIToolConfig, SuggestedResponseConfig,
  CortexStepPlannerResponse, CortexTrajectorySource,
} from 'antigravity-client/dist/src/gen/exa/cortex_pb/cortex_pb.js';
import {
  SendUserCascadeMessageRequest,
  RefreshMcpServersRequest,
  DeleteCascadeTrajectoryRequest,
  GetCascadeTrajectoryGeneratorMetadataRequest,
} from 'antigravity-client/dist/src/gen/exa/language_server_pb/language_server_pb.js';
import { Cascade } from 'antigravity-client';
import { Launcher } from 'antigravity-client/dist/src/server/launcher.js';
import type { ApprovalRequest } from 'antigravity-client/dist/src/types.js';
import type { ConnectError } from '@connectrpc/connect';
import { McpHub } from './mcp-hub.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { extractSystemPrompt } from './converters/request.js';
import {
  extractCurrentUserPayload,
  groupTurns,
  type ExtractedTurn,
} from './converters/history-builder.js';
import type { ClaudeMessage, ClaudeContentBlock, ClaudeToolDefinition, BridgeMessage } from './types.js';
import { createHash } from 'node:crypto';

export class GeminiApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'GeminiApiError';
  }
}

/**
 * Deterministically serialize a Claude message's `content` to a
 * string. Used for hashing pastTurns in `#computeSessionId`. The
 * output is canonical: same content → same string, regardless of
 * object identity or property order in source-block content arrays.
 */
function serializeMessageContent(content: string | ClaudeContentBlock[]): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    parts.push(JSON.stringify(b));
  }
  return parts.join('|');
}

function serializeTurn(turn: ExtractedTurn): string {
  const userPart = `${turn.userMessage.role}:${serializeMessageContent(turn.userMessage.content)}`;
  const assistantParts = turn.assistantMessages
    .map((m) => `${m.role}:${serializeMessageContent(m.content)}`);
  return [userPart, ...assistantParts].join('|');
}

export class AntigravityBackend {
  private client: (AntigravityClient & { launcher?: Launcher }) | null = null;
  /** In-flight Cascade per requestId (used by cancelSession). */
  private inflightCascades = new Map<string, Cascade>();
  /**
   * Session store: maps a `cascadeId` to the metadata of the Cascade
   * that owns the conversation's trajectory on the LS side.
   *
   * The metadata includes the `pastTurns` (everything in `messages`
   * except the final user message) that was current when the Cascade
   * was last used. We use this to identify the parent Cascade for a
   * new request via **prefix matching**: for each incoming request,
   * find the stored Cascade whose `pastTurns` is a prefix of the new
   * request's `pastTurns` with the longest match. The longest-prefix
   * Cascade is the most recent turn of the same Claude Code session.
   *
   * The `sessionId` (SHA-256 of `pastTurns`) is included in the
   * metadata for logging and is exposed in DEBUG_TRAJECTORY output.
   *
   * Capped at MAX_SESSIONS to prevent unbounded memory growth. LRU
   * eviction: the entry with the oldest `lastUsed` timestamp is
   * removed and its Cascade trajectory is deleted on the LS side.
   */
  private sessionStore = new Map<string, {
    cascade: Cascade;
    pastTurns: ExtractedTurn[];
    sessionId: string;
    lastUsed: number;
  }>();
  private static readonly MAX_SESSIONS = 32;
  /**
   * Temp directory under /tmp that serves as the LS's workspace and
   * the proxy's intermediate file store (extracted documents, scratch
   * files, `.mcp.json`). Using /tmp keeps Claude Code from auto-
   * discovering the proxy as an MCP server, and sandboxes the LS
   * away from the user's project tree. Project files are reached
   * via MCP tools (read_file, Bash, etc.) routed back to Claude
   * Code, not via the LS's workspace API.
   */
  private workspaceDir: string | null = null;
  /** Singleton: all tools disabled */
  private static disabledToolConfig: CascadeToolConfig | null = null;
  /** MCP proxy hub (tool registry) */
  public readonly mcpHub: McpHub = new McpHub();
  private lastRegisteredToolsHash = '';
  /** Error captured from cascade's 'error' event (if any) */
  #cascadeError: Error | null = null;

  async initialize(): Promise<void> {
    if (this.client) return;

    // Start the MCP Hub first so we know the port before LS starts
    try {
      await this.mcpHub.start();
      console.log(`[Backend] McpHub started on port ${this.mcpHub.port}`);
    } catch (error) {
      console.error('[Backend] Failed to start McpHub:', error);
    }

    if (!this.workspaceDir) {
      this.workspaceDir = join(tmpdir(), `claude2gemini_workspace_${process.pid}_${Date.now()}`);
      await mkdir(this.workspaceDir, { recursive: true });
    }

    // Write .mcp.json to the LS's workspaceDir (under /tmp) BEFORE
    // LS launches so the LS discovers the proxy on startup. The file
    // lives under /tmp and is therefore not auto-discovered by
    // Claude Code, which only scans the user's project cwd.
    await this.#writeMcpConfigToWorkspace();

    console.log('[Backend] Launching Antigravity Language Server...');
    try {
      this.client = await AntigravityClient.launch({
        workspacePath: this.workspaceDir!,
        verbose: process.env.VERBOSE === 'true',
      });
      console.log('[Backend] Antigravity LS launched successfully.');
    } catch (error) {
      console.error('[Backend] Failed to launch Antigravity LS:', error);
      throw error;
    }

    // Refresh MCP servers to ensure proxy is recognized
    await this.#refreshMcpProxyOnLS();
  }

  /**
   * Write .mcp.json to the LS's workspaceDir (under /tmp) BEFORE LS
   * starts so the LS discovers the proxy on initialization. Because
   * workspaceDir is under /tmp, Claude Code (which only scans the
   * user's project cwd) does not auto-discover the proxy. After LS
   * is up, we also write to gemini_dir and call refreshMcpServers
   * (see #refreshMcpProxyOnLS).
   */
  async #writeMcpConfigToWorkspace(): Promise<void> {
    const mcpConfig = {
      mcpServers: {
        'claude2gemini-mcp-proxy': {
          command: process.execPath,
          args: [
            new URL('./mcp-proxy.mjs', import.meta.url).pathname,
            '--hub-port',
            String(this.mcpHub.port),
          ],
        }
      }
    };
    const serialized = JSON.stringify(mcpConfig, null, 2);

    try {
      const mcpPath = join(this.workspaceDir!, '.mcp.json');
      await writeFile(mcpPath, serialized, 'utf-8');
      console.log(`[Backend] MCP spec written to ${mcpPath}`);
    } catch (error) {
      console.warn('[Backend] Failed to write .mcp.json:', error);
    }
  }

  /**
   * After LS is running, write mcp_config.json to gemini_dir and call
   * refreshMcpServers so the LS discovers the proxy subprocess.
   */
  async #refreshMcpProxyOnLS(): Promise<void> {
    if (!this.client) return;

    const workspaceId = this.client.launcher?.workspaceId;
    if (workspaceId) {
      const geminiDir = join(tmpdir(), `gemini_${workspaceId}`);
      const configDir = join(geminiDir, 'config');
      const mcpConfigPath = join(configDir, 'mcp_config.json');
      try {
        await mkdir(configDir, { recursive: true });
        const mcpConfig = {
          mcpServers: {
            'claude2gemini-mcp-proxy': {
              command: process.execPath,
              args: [
                new URL('./mcp-proxy.mjs', import.meta.url).pathname,
                '--hub-port',
                String(this.mcpHub.port),
              ],
            }
          }
        };
        await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), 'utf-8');
      } catch { /* best-effort */ }
    }

    try {
      await this.client.lsClient.refreshMcpServers(
        new RefreshMcpServersRequest({ shallow: false, serverName: 'claude2gemini-mcp-proxy' }),
      );
      console.log('[Backend] MCP proxy registered with LS (refreshMcpServers OK)');
    } catch (error: unknown) {
      console.warn('[Backend] refreshMcpServers failed:', error);
    }
  }

  /**
   * Build a CascadeToolConfig that disables every built-in Antigravity tool
   * EXCEPT MCP, which is needed for the proxy-based tool execution flow.
   */
  private static createToolConfig(): CascadeToolConfig {
    if (AntigravityBackend.disabledToolConfig) {
      return AntigravityBackend.disabledToolConfig;
    }
    AntigravityBackend.disabledToolConfig = new CascadeToolConfig({
      // Tools with forceDisable
      runCommand:  new RunCommandToolConfig({ forceDisable: true }),
      searchWeb:   new SearchWebToolConfig({ forceDisable: true }),
      memory:      new MemoryToolConfig({ forceDisable: true }),
      // MCP is ENABLED for our proxy-based tool delegation
      mcp:         new McpToolConfig({ forceDisable: false, maxOutputBytes: 1_000_000 }),
      mquery:      new MqueryToolConfig({ forceDisable: true }),
      find:        new FindToolConfig({ forceDisable: true }),
      generateImage: new GenerateImageToolConfig({ forceDisable: true }),
      trajectorySearch: new TrajectorySearchToolConfig({ forceDisable: true }),
      suggestedResponse: new SuggestedResponseConfig({ forceDisable: true }),
      // Note: Several LS built-in tools (code, intent, grep, viewFile,
      // listDir, viewCodeItem, knowledgeBaseSearch, commandStatus,
      // codeSearch, internalSearch, notifyUser, finish) lack a
      // `forceDisable` field in their *ToolConfig messages — they
      // expose only fine-grained tunables (e.g. `disableExtensions` on
      // CodeToolConfig). The LS will fall back to internal defaults for
      // these, so they remain reachable. The pragmatic mitigation is to
      // keep MCP registered with high-quality tool descriptions that make
      // the LLM prefer the MCP variant over the built-in one.
      // Tools controlled via enabled/readOnly
      antigravityBrowser: new AntigravityBrowserToolConfig({ enabled: false }),
      browserSubagent:    new BrowserSubagentToolConfig({ disableScreenshot: true }),
      invokeSubagent:     new InvokeSubagentToolConfig({ enabled: false }),
      notebookEdit:       new NotebookEditToolConfig({ enabled: false }),
      askQuestion:        new AskQuestionToolConfig({ enabled: false }),
      readKnowledgeBaseItem: new ReadKnowledgeBaseItemToolConfig({ enabled: false }),
      workspaceApi:       new WorkspaceAPIToolConfig({ readOnly: true }),
      // Global flag for simple research tools
      disableSimpleResearchTools: true,
    });
    return AntigravityBackend.disabledToolConfig;
  }

  /**
   * Send a message via sendUserCascadeMessage with our selective tool config.
   */
  private async sendMessage(
    cascade: Cascade,
    text: string,
    modelName: string,
    apiKey: string,
    images: { base64Data: string; mimeType: string }[] = [],
    documents: { absolutePath: string; mediaType: string }[] = [],
  ): Promise<void> {
    const toolConfig = AntigravityBackend.createToolConfig();

    const metadata = new Metadata({
      apiKey,
      ideName: 'vscode',
      ideVersion: '1.107.0',
      extensionName: 'antigravity',
      extensionVersion: '0.2.0',
    });

    const modelId = await this.client!.resolveModelId(modelName || '');

    const items: TextOrScopeItem[] = [
      new TextOrScopeItem({
        chunk: { case: 'text', value: text },
      }),
    ];

    // Reference documents via PathScopeItem (files are already written by
    // extractCurrentUserPayload to deterministic paths in workspaceDir).
    for (const doc of documents) {
      items.push(new TextOrScopeItem({
        chunk: {
          case: 'item',
          value: new ContextScopeItem({
            scopeItem: {
              case: 'file',
              value: new PathScopeItem({
                absolutePathMigrateMeToUri: doc.absolutePath,
                absoluteUri: `file://${doc.absolutePath}`,
              }),
            },
          }),
        },
      }));
    }

    const req = new SendUserCascadeMessageRequest({
      cascadeId: cascade.cascadeId,
      metadata,
      items,
      images: images.map(img => new ImageData({
        base64Data: img.base64Data,
        mimeType: img.mimeType,
      })),
      cascadeConfig: new CascadeConfig({
        plannerConfig: new CascadePlannerConfig({
          toolConfig,
          plannerTypeConfig: {
            case: 'conversational',
            value: new CascadeConversationalPlannerConfig({
              plannerMode: 1, // DEFAULT
            }),
          },
          requestedModel: new ModelOrAlias({
            choice: { case: 'model', value: modelId },
          }),
        }),
      }),
      blocking: false,
      clientType: 1, // IDE
    });

    await this.client!.lsClient.sendUserCascadeMessage(req);
  }

  /**
   * Start a fresh Cascade on the LS. The Cascade is OWNED by the LS —
   * the trajectory state is kept server-side and we re-attach on
   * subsequent requests in the same session via `lsClient.getCascade`
   * + `sendUserCascadeMessage`.
   *
   * The proxy does NOT inject history (the production LS does not
   * honor `baseTrajectoryIdentifier.trajectory` with a single
   * `CortexStepUserInput` per past turn — observed symptom: the
   * trajectory is discarded and `total_steps` remains at 1, producing
   * an empty planner response).
   *
   * Throws on LS errors (no fallback) — the caller's catch yields an
   * error BridgeMessage to the Claude client.
   */
  async #startCascade(): Promise<Cascade> {
    if (!this.client) throw new Error('Antigravity client not initialized');

    const apiKey = process.env.ANTIGRAVITY_API_KEY || readAuthStatus()?.apiKey || '';
    const metadata = new Metadata({
      apiKey,
      ideName: 'vscode',
      ideVersion: '1.107.0',
      extensionName: 'antigravity',
      extensionVersion: '0.2.0',
    });

    // The LS was launched in workspaceDir (a /tmp directory; see
    // initialize()), so it knows about this workspace. We do NOT
    // pass workspaceUris to startCascade — the client library's
    // own startCascade doesn't either, and the LS rejects unknown
    // workspace URIs with "workspace infos is nil". The Cascade
    // inherits the LS's workspace (its launch dir).
    const { cascadeId } = await this.client.lsClient.startCascade({
      metadata,
      source: CortexTrajectorySource.CASCADE_CLIENT,
    });
    return this.#wrapCascade(cascadeId, apiKey);
  }

  #wrapCascade(cascadeId: string, apiKey: string): Cascade {
    const cascade = new Cascade(
      cascadeId,
      this.client!.lsClient,
      apiKey,
      (n: string | number) => this.client!.resolveModelId(n),
    );
    cascade.listen();
    this.#wireCascadeEvents(cascade);
    return cascade;
  }

  /**
   * Derive a session identifier from the request's `pastTurns`
   * (everything in `messages` except the final user message). The
   * input string is therefore the entire conversation history up
   * to the current turn — a "longer" input than just the first
   * user message, which makes collisions across sessions
   * astronomically unlikely.
   *
   * The sessionId is a fingerprint of the conversation state and
   * changes every turn (because pastTurns grows each turn). It is
   * used for logging and is exposed in the per-request
   * `Sending message` log line; cascade lookup uses
   * `#findParentCascadeByPrefix` (prefix matching on pastTurns) so
   * we can still re-attach to the most recent Cascade of the same
   * session despite the sessionId changing.
   *
   * SHA-256 yields 64 hex characters. The serialization is a
   * deterministic JSON-like string of role + content for each
   * pastTurn message.
   */
  #computeSessionId(pastTurns: ExtractedTurn[]): string {
    const serialized = pastTurns.map(serializeTurn).join('\n---\n');
    if (!serialized) {
      // Empty pastTurns (first turn) — still derive a stable per-
      // request value so we can include it in logs.
      return createHash('sha256').update('empty', 'utf8').digest('hex');
    }
    return createHash('sha256').update(serialized, 'utf8').digest('hex');
  }

  /**
   * Deep-compare two ExtractedTurns. Used by prefix matching to
   * determine whether a stored Cascade's pastTurns is a prefix of
   * the new request's pastTurns.
   *
   * Comparison covers: the user message of each turn, and ALL
   * assistant messages (text + tool calls) of each turn. Any
   * divergence — even in tool-call IDs or arguments — invalidates
   * the prefix match.
   */
  #turnsEqual(a: ExtractedTurn, b: ExtractedTurn): boolean {
    if (!this.#messagesEqual(a.userMessage, b.userMessage)) return false;
    if (a.assistantMessages.length !== b.assistantMessages.length) return false;
    for (let i = 0; i < a.assistantMessages.length; i++) {
      if (!this.#messagesEqual(a.assistantMessages[i]!, b.assistantMessages[i]!)) {
        return false;
      }
    }
    return true;
  }

  #messagesEqual(a: ClaudeMessage, b: ClaudeMessage): boolean {
    if (a.role !== b.role) return false;
    if (typeof a.content !== typeof b.content) return false;
    if (typeof a.content === 'string' && typeof b.content === 'string') {
      return a.content === b.content;
    }
    if (Array.isArray(a.content) && Array.isArray(b.content)) {
      if (a.content.length !== b.content.length) return false;
      for (let i = 0; i < a.content.length; i++) {
        const ai = a.content[i] as { type: string };
        const bi = b.content[i] as { type: string };
        if (ai.type !== bi.type) return false;
        // For text/image/document blocks we compare the relevant
        // fields. tool_use / tool_result blocks include IDs and
        // JSON payloads that should also match exactly across
        // re-sent requests.
        const aj = JSON.stringify(ai);
        const bj = JSON.stringify(bi);
        if (aj !== bj) return false;
      }
      return true;
    }
    return false;
  }

  /**
   * Find the Cascade in the session store whose `pastTurns` is a
   * prefix of the new request's `pastTurns` with the longest match.
   *
   * The longest-prefix Cascade is the most recent turn of the same
   * Claude Code session — re-attaching to it lets the new turn
   * continue the trajectory on the LS side without any history
   * injection.
   *
   * Returns `{ cascade, entry }` on a hit, or `null` on a miss. The
   * `entry` is the stored metadata so the caller can update
   * `lastUsed` and re-store the new pastTurns after a successful
   * turn.
   */
  async #findParentCascadeByPrefix(pastTurns: ExtractedTurn[]): Promise<{
    cascade: Cascade;
    cascadeId: string;
    entry: { pastTurns: ExtractedTurn[]; sessionId: string; lastUsed: number };
  } | null> {
    // Guard: a request with empty pastTurns is always the FIRST
    // turn of a new (or unrelated) session. We must NOT re-attach
    // to an existing cascade in this case — otherwise unrelated
    // sessions that happen to start with no past history (e.g. the
    // Claude Code SessionStart hook followed by a real session,
    // or two completely separate requests with single user
    // messages) would collide and share a Cascade. The Cascade
    // would then receive a follow-up message with a different
    // system prompt / model and produce incoherent output. Real
    // multi-turn conversation still re-attaches correctly: by the
    // 2nd turn, pastTurns has 1+ turns, so this guard does not
    // apply.
    if (pastTurns.length === 0) return null;
    let best: {
      cascade: Cascade;
      cascadeId: string;
      entry: { pastTurns: ExtractedTurn[]; sessionId: string; lastUsed: number };
    } | null = null;

    for (const [cascadeId, entry] of this.sessionStore.entries()) {
      if (entry.pastTurns.length > pastTurns.length) continue;
      let isPrefix = true;
      for (let i = 0; i < entry.pastTurns.length; i++) {
        if (!this.#turnsEqual(entry.pastTurns[i]!, pastTurns[i]!)) {
          isPrefix = false;
          break;
        }
      }
      if (!isPrefix) continue;
      if (!best || entry.pastTurns.length > best.entry.pastTurns.length) {
        // REUSE the stored Cascade wrapper. We must NOT call
        // client.getCascade() here because that would create a new
        // wrapper and call listen() — listen() opens a
        // streamAgentStateUpdates subscription with
        // subscriberId=cascadeId, and the LS rejects a second
        // subscription with the same ID ("subscription closed by
        // repeat id"), which would tear down the live subscription
        // and the cascade would lose all event updates.
        //
        // The stored wrapper already has an active listen()
        // subscription from the previous turn. We just need to
        // re-verify liveness and re-wire our event handlers.
        const cascade = entry.cascade;

        // Verify the cascade is still alive on the LS side. Calling
        // getHistory() loads the trajectory into the local state
        // and throws if the cascade was deleted/expired (e.g. LS
        // restart, manual delete, TTL expiry).
        try {
          await cascade.getHistory();
        } catch {
          // Cascade is gone on the LS side — drop the stale entry
          // and continue searching for a longer match.
          this.sessionStore.delete(cascadeId);
          this.#deleteCascadeTrajectoryBestEffort(cascadeId);
          continue;
        }
        // Re-wire our event handlers. #wireCascadeEvents
        // internally removes any previous listeners it registered
        // on this wrapper, so calling it on re-attach is safe and
        // idempotent.
        this.#wireCascadeEvents(cascade);
        best = { cascade, cascadeId, entry };
      }
    }
    return best;
  }

  #deleteCascadeTrajectoryBestEffort(cascadeId: string): void {
    if (!this.client) return;
    try {
      this.client.lsClient.deleteCascadeTrajectory(
        new DeleteCascadeTrajectoryRequest({ cascadeId }),
      ).catch(() => { /* best-effort */ });
    } catch { /* best-effort */ }
  }

  /**
   * Register a freshly-started Cascade in the session store. LRU
   * eviction: when the store is full, the entry with the oldest
   * `lastUsed` timestamp is removed and its Cascade trajectory is
   * deleted on the LS side.
   */
  #registerSession(cascade: Cascade, pastTurns: ExtractedTurn[], sessionId: string): void {
    if (this.sessionStore.size >= AntigravityBackend.MAX_SESSIONS) {
      let oldestKey: string | undefined;
      let oldestTime = Infinity;
      for (const [key, entry] of this.sessionStore.entries()) {
        if (entry.lastUsed < oldestTime) {
          oldestTime = entry.lastUsed;
          oldestKey = key;
        }
      }
      if (oldestKey !== undefined) {
        const evicted = this.sessionStore.get(oldestKey);
        this.sessionStore.delete(oldestKey);
        this.#deleteCascadeTrajectoryBestEffort(oldestKey);
        // Dispose the evicted wrapper's stream subscription so the LS
        // is not left with a dangling subscription for the evicted
        // cascadeId.
        if (evicted) {
          try { evicted.cascade.dispose(); }
          catch { /* best-effort */ }
        }
      }
    }
    this.sessionStore.set(cascade.cascadeId, { cascade, pastTurns, sessionId, lastUsed: Date.now() });
  }

  /**
   * Update the stored pastTurns and lastUsed for a Cascade after a
   * successful turn. This grows the prefix so the NEXT request
   * (which extends pastTurns by one more turn) will match this
   * Cascade.
   */
  #updateSessionProgress(cascadeId: string, pastTurns: ExtractedTurn[], sessionId: string): void {
    const entry = this.sessionStore.get(cascadeId);
    if (!entry) return;
    entry.pastTurns = pastTurns;
    entry.sessionId = sessionId;
    entry.lastUsed = Date.now();
  }

  /**
   * Re-attach a Cascade to the LS event listeners. The LS-side
   * trajectory is preserved across requests, but the in-process
   * Cascade wrapper is fresh — we must re-call `cascade.listen()` and
   * re-wire our event handlers so subsequent turn events flow back to
   * the client.
   */
  #reattachCascadeListeners(cascade: Cascade): void {
    try {
      cascade.listen();
      this.#wireCascadeEvents(cascade);
    } catch {
      throw new Error('cascade.listen() failed');
    }
  }

  #wireCascadeEvents(cascade: Cascade): void {
    // Idempotent: remove any previously-wired listeners we attached
    // to this wrapper before adding fresh ones. This is important
    // for re-attach across requests — without off(), repeated
    // re-attaches would accumulate duplicate listeners and fire
    // each event multiple times.
    const prev = (cascade as any).__backendWiredListeners as
      | { interaction?: (...args: any[]) => void; error?: (...args: any[]) => void }
      | undefined;
    if (prev?.interaction) cascade.off('interaction', prev.interaction);
    if (prev?.error) cascade.off('error', prev.error);

    const onInteraction = (event: ApprovalRequest) => {
      if (event.needsApproval) {
        console.log(`[Backend] Auto-approving cascade interaction: index=${event.stepIndex}, cmd=${event.commandLine || 'none'}`);
        event.approve('once').catch((err: unknown) => {
          console.error('[Backend] Auto-approve failed:', err);
        });
      }
    };
    const onError = (err: unknown) => {
      console.error('[Backend] Cascade error event:', err);
      this.#cascadeError = err instanceof Error ? err : new Error(String(err));
    };
    cascade.on('interaction', onInteraction);
    cascade.on('error', onError);
    (cascade as any).__backendWiredListeners = { interaction: onInteraction, error: onError };
  }

  /**
   * Dispose of a Cascade: cancel any in-flight turn, delete the
   * trajectory server-side, and stop the cascade's internal listen stream.
   * Errors during disposal are best-effort and never throw.
   */
  async #disposeCascade(cascade: Cascade): Promise<void> {
    // Attach a no-op error handler FIRST so that if the LS streams a stale
    // "agent state ... not found" error after we cancel / dispose, the
    // unhandled 'error' event does not crash the Node process. The real
    // error listener registered in #wireCascadeEvents is the one that
    // surfaces errors to the client; once disposal begins, swallowing any
    // trailing error is the correct behaviour.
    cascade.on('error', () => { /* swallow post-dispose errors */ });

    try {
      const status = cascade.state?.status ?? 0;
      if (status >= 2 /* RUNNING/CANCELING/BUSY */) {
        try { await cascade.cancelAndWait({ timeoutMs: 5_000 }); }
        catch (err) {
          console.warn(`[Backend] cancelAndWait during dispose failed (cascadeId=${cascade.cascadeId}):`, err);
        }
      }
    } catch (e) {
      console.warn('[Backend] dispose status check failed:', e);
    }

    // Delete the trajectory server-side so the cascade does not linger.
    // The LS keeps no cross-request state with this approach.
    if (this.client) {
      try {
        await this.client.lsClient.deleteCascadeTrajectory(
          new DeleteCascadeTrajectoryRequest({ cascadeId: cascade.cascadeId }),
        );
      } catch (err) {
        console.warn(`[Backend] deleteCascadeTrajectory failed for ${cascade.cascadeId} during dispose (non-fatal):`, err);
      }
    }

    // Stop the cascade's internal listen stream and drop its listeners.
    try {
      cascade.dispose();
    } catch (err) {
      console.warn(`[Backend] cascade.dispose failed for ${cascade.cascadeId} (non-fatal):`, err);
    }
  }

  /**
   * Fetch token usage statistics from the LS after a turn completes.
   * Best-effort: returns undefined if the RPC fails or no metadata is available.
   */
  async #fetchUsage(cascade: Cascade): Promise<{
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    context_window_estimated_tokens?: number;
  } | undefined> {
    if (!this.client) return undefined;
    try {
      const resp = await this.client.lsClient.getCascadeTrajectoryGeneratorMetadata(
        new GetCascadeTrajectoryGeneratorMetadataRequest({
          cascadeId: cascade.cascadeId,
        }),
      );
      const metas = resp.generatorMetadata;
      if (!metas || metas.length === 0) return undefined;
      // Use the last generator metadata entry (latest turn)
      const last = metas[metas.length - 1];
      // chatModel is inside a "metadata" oneof: { case: "chatModel", value: ChatModelMetadata }
      const chatModel = last.metadata?.case === 'chatModel' ? last.metadata.value : undefined;
      if (!chatModel?.usage) return undefined;
      const usage = chatModel.usage;
      const result: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
        context_window_estimated_tokens?: number;
      } = {
        input_tokens: Number(usage.inputTokens),
        output_tokens: Number(usage.outputTokens),
      };
      if (Number(usage.cacheReadTokens) > 0) {
        result.cache_read_input_tokens = Number(usage.cacheReadTokens);
      }
      if (Number(usage.cacheWriteTokens) > 0) {
        result.cache_creation_input_tokens = Number(usage.cacheWriteTokens);
      }
      // Also prefer context_window_estimated_tokens from ChatStartMetadata if available
      const ctxMeta = chatModel.chatStartMetadata?.contextWindowMetadata;
      if (ctxMeta?.estimatedTokensUsed !== undefined &&
          ctxMeta.estimatedTokensUsed !== null) {
        result.context_window_estimated_tokens = Number(ctxMeta.estimatedTokensUsed);
      }
      return result;
    } catch (e) {
      console.warn('[Backend] Failed to fetch usage metadata (non-fatal):', e);
      return undefined;
    }
  }

  /**
   * Collect text from the cascade's trajectory steps that were added after
   * `startStepCount`.
   */
  private collectTextFromSteps(cascade: Cascade, startStepCount: number): string {
    const steps = cascade.state?.trajectory?.steps ?? [];
    const parts: string[] = [];
    for (let i = startStepCount; i < steps.length; i++) {
      const step = steps[i];
      if (!step) continue;
      if (step.step?.case !== 'plannerResponse') continue;
      const planner = step.step.value as CortexStepPlannerResponse;
      const response = planner.modifiedResponse || planner.response || '';
      if (response) parts.push(response);
    }
    return parts.join('');
  }

  /**
   * Map a cascade error to an appropriate HTTP status code.
   * ConnectRPC errors carry a numeric `code` property (gRPC status codes).
   */
  #classifyConnectErrorCode(err: unknown): number {
    const code = typeof (err as ConnectError)?.code === 'number' ? (err as ConnectError).code : 0;
    // ConnectRPC / gRPC status codes
    if (code === 8 /* ResourceExhausted */) return 429;
    if (code === 4 /* DeadlineExceeded */) return 504;
    if (code === 14 /* Unavailable */) return 503;
    if (code === 13 /* Internal */) return 500;
    if (code === 7 /* PermissionDenied */) return 403;
    if (code === 16 /* Unauthenticated */) return 401;
    if (code === 3 /* InvalidArgument */) return 400;
    if (code === 5 /* NotFound */) return 404;
    if (code === 1 /* Canceled */) return 499;
    return 500;
  }

  /**
   * Scan the cascade's trajectory for errorMessage steps added after
   * `startStepCount`. Returns a user-facing error string, or null.
   */
  #findErrorStep(cascade: Cascade, startStepCount: number): string | null {
    const steps = cascade.state?.trajectory?.steps ?? [];
    for (let i = startStepCount; i < steps.length; i++) {
      const step = steps[i];
      if (!step) continue;
      // Check errorMessage step type
      if (step.step?.case === 'errorMessage') {
        const errMsg = step.step.value;
        const details = errMsg.error;
        return details?.userErrorMessage || details?.shortError || details?.fullError || 'Unknown Antigravity LS error';
      }
      // Check step status === error
      if (step.status === 11 /* StepStatus.ERROR */) {
        return `Step ${i} failed with status: error`;
      }
    }
    return null;
  }

  /**
   * Wait for the next turn to complete OR a tool call to arrive, whichever
   * happens first. Uses the Cascade's event-driven waitForTurnComplete()
   * raced against an McpHub event notification.
   * Throws on timeout so the caller can handle it with an appropriate error code.
   */
  private async waitForTurnOrToolCall(
    cascade: Cascade,
    timeoutMs = 120_000,
  ): Promise<'idle' | 'tool_call'> {
    // If a tool call is already pending, return immediately
    if (this.mcpHub.hasPendingCalls()) return 'tool_call';

    return new Promise<'idle' | 'tool_call'>((resolve, reject) => {
      let settled = false;

      // Listen for McpHub tool call events
      const onPending = () => {
        if (!settled) { settled = true; cleanup(); resolve('tool_call'); }
      };
      this.mcpHub.on('pending_call', onPending);

      // Use the cascade's event-driven idle waiter
      cascade.waitForTurnComplete({ timeoutMs })
        .then(() => {
          if (!settled) { settled = true; cleanup(); resolve('idle'); }
        })
        .catch((err: Error) => {
          if (!settled) { settled = true; cleanup();
            // Timeout → propagate to outer handler with 504
            if (err.message?.includes('timeout')) {
              reject(err);
            } else {
              resolve('idle');
            }
          }
        });

      const cleanup = () => {
        this.mcpHub.off('pending_call', onPending);
      };
    });
  }

  /**
   * Creates an asynchronous stream of bridge messages for a given request.
   *
   * Stateful session continuation: the request's first user message
   * identifies the Claude Code session. If we have an existing Cascade
   * for this session, we re-attach to it and call `sendUserCascadeMessage`
   * to append the new turn. Otherwise we start a fresh Cascade, register
   * it in the sessionStore, and proceed.
   *
   * On success, the Cascade is kept alive in the sessionStore so the
   * next turn in the same session re-attaches. On error / cascade
   * failure, the Cascade is removed from the store and its trajectory
   * deleted on the LS side.
   */
  async *createMessageStream(
    requestId: string,
    request: {
      model: string;
      messages: ClaudeMessage[];
      system?: string;
      tools?: ClaudeToolDefinition[];
    }
  ): AsyncGenerator<BridgeMessage> {
    if (!this.client) await this.initialize();

    const { messages, tools } = request;

    if (messages.length === 0) {
      throw new Error('No messages provided');
    }
    const { pastTurns, currentUserMessage } = groupTurns(messages);

    this.mcpHub.clearPendingCalls(`New request ${requestId} — clearing stale calls`);

    let cascade: Cascade | null = null;
    let sessionId: string | null = null;
    let matchedCascadeId: string | null = null;
    let createdNewCascade = false;
    let keepAliveOnSuccess = false;
    try {
      if (tools && tools.length > 0) {
        this.mcpHub.setTools(tools);
        const toolsHash = JSON.stringify(tools);
        if (this.lastRegisteredToolsHash !== toolsHash) {
          this.lastRegisteredToolsHash = toolsHash;
          await this.#refreshMcpProxyOnLS();
        }
      }

      // Extract text + multimodal payloads from the current user message
      // BEFORE starting a cascade — cheap CPU work first, LS I/O second.
      const { text: userText, images, documents } = await extractCurrentUserPayload(
        currentUserMessage, this.workspaceDir!,
      );
      const apiKey = process.env.ANTIGRAVITY_API_KEY || readAuthStatus()?.apiKey || '';
      const systemPrompt = extractSystemPrompt(request.system);
      let text = '';
      if (systemPrompt) {
        text += `=== SYSTEM PROMPT ===\n${systemPrompt}\n=====================\n\n`;
      }
      text += `=== USER INSTRUCTION ===\n${userText}`;

      // Compute the sessionId (fingerprint) from the entire pastTurns.
      // The sessionId is per-turn unique (pastTurns grows each turn) and
      // is used only for logging. Cascade lookup uses prefix matching on
      // the pastTurns via #findParentCascadeByPrefix — we re-attach to
      // the Cascade with the longest pastTurns prefix, which is the most
      // recent turn of the same Claude Code session.
      sessionId = this.#computeSessionId(pastTurns);
      const parent = await this.#findParentCascadeByPrefix(pastTurns);
      if (parent) {
        cascade = parent.cascade;
        matchedCascadeId = parent.cascadeId;
      } else {
        cascade = await this.#startCascade();
        this.#registerSession(cascade, pastTurns, sessionId);
        matchedCascadeId = cascade.cascadeId;
        createdNewCascade = true;
      }
      this.inflightCascades.set(requestId, cascade);

      await this.sendMessage(
        cascade,
        text,
        request.model,
        apiKey,
        images,
        documents.map(d => ({ absolutePath: d.absolutePath, mediaType: d.mediaType })),
      );

      console.log(`[Backend] Sending message (requestId=${requestId}, sessionId=${sessionId.slice(0, 8)}…, session_new=${createdNewCascade}, past_turns=${pastTurns.length}, text_length=${text.length}, model=${request.model})`);

      const turn = await this.waitForTurnOrToolCall(cascade);

      // DEBUG: dump trajectory state for diagnosing empty responses.
      // Gated on DEBUG_TRAJECTORY so production logs stay clean.
      if (process.env.DEBUG_TRAJECTORY === 'true') {
        const dbgSteps = cascade.state?.trajectory?.steps ?? [];
        console.log(`[Backend] DEBUG cascade state: cascadeId=${cascade.cascadeId}, status=${cascade.state?.status}, total_steps=${dbgSteps.length}`);
        for (let i = 0; i < dbgSteps.length; i++) {
          const s = dbgSteps[i];
          const typeName = s?.type ?? 'NONE';
          const statusName = s?.status ?? 'NONE';
          const stepCase = s?.step?.case ?? 'NONE';
          let extra = '';
          if (s?.step?.case === 'plannerResponse') {
            const p: any = s.step.value;
            extra = ` response_len=${(p?.response || '').length}, tool_calls=${(p?.toolCalls || []).length}, sig="${(p?.signature || '').slice(0, 20)}"`;
          } else if (s?.step?.case === 'userInput') {
            const u: any = s.step.value;
            extra = ` query_len=${(u?.query || '').length}, items=${(u?.items || []).length}`;
          } else if (s?.step?.case === 'mcpTool') {
            const m: any = s.step.value;
            extra = ` name=${m?.toolCall?.name || 'NONE'}, hasResult=${!!m?.result?.value}`;
          } else if (s?.step?.case === 'errorMessage') {
            const e: any = s.step.value;
            extra = ` error="${(e?.error?.shortError || e?.error?.userErrorMessage || '').slice(0, 200)}"`;
          }
          console.log(`[Backend] DEBUG step[${i}]: type=${typeName}, status=${statusName}, case=${stepCase}${extra}`);
        }
      }

      if (this.#cascadeError) {
        const err = this.#cascadeError;
        this.#cascadeError = null;
        const status = this.#classifyConnectErrorCode(err);
        yield { type: 'error', sessionId: requestId, message: `Antigravity LS error: ${err.message}`, status };
        return;
      }

      if (turn === 'tool_call') {
        const allowedToolNames = request.tools?.map((t) => t.name) || [];
        for (const call of this.mcpHub.getPendingCalls()) {
          if (allowedToolNames.length > 0 && !allowedToolNames.includes(call.name)) {
            console.log(`[Backend] Rejecting disallowed tool call: ${call.name} (${call.callId})`);
            this.mcpHub.resolveCall(call.callId, {
              content: [{ type: 'text', text: `Error: Tool ${call.name} is not allowed or available in this context.` }],
              isError: true,
            }).catch(() => {});
            continue;
          }
          yield { type: 'tool_call', sessionId: requestId, callId: call.callId, name: call.name, args: call.args };
        }
        const usage1 = await this.#fetchUsage(cascade);
        // Tool calls signal a successful end-of-turn — keep the
        // cascade alive in the session store so the tool_result
        // turn can re-attach. Advance the stored pastTurns so the
        // NEXT request (which appends the tool_result + new
        // assistant response) finds this cascade via prefix match.
        //
        // IMPORTANT: This MUST run BEFORE yielding turn_end. The
        // stream consumer (stream.ts) breaks out of the for-await
        // loop on turn_end, so any code after that yield never
        // runs. The finally block then handles keep/dispose based
        // on keepAliveOnSuccess — if we never set the flag, the
        // cascade gets disposed and the next turn starts from
        // scratch, losing the trajectory and forcing the model to
        // re-run the same diagnostic tools.
        this.#updateSessionProgress(matchedCascadeId!, pastTurns, sessionId!);
        keepAliveOnSuccess = true;
        yield { type: 'turn_end', sessionId: requestId, stopReason: 'tool_use', usage: usage1 };
        return;
      }

      // The Cascade is a single trajectory over the whole session.
      // We always start collecting from index 0 (the LS has the
      // full history; we just want the most recent planner response).
      const collected = this.collectTextFromSteps(cascade, 0);

      const errorMsg = this.#findErrorStep(cascade, 0);
      if (errorMsg) {
        yield { type: 'error', sessionId: requestId, message: errorMsg, status: 500 };
        return;
      }

      if (collected) {
        yield { type: 'stream_event', sessionId: requestId, event: { type: 'content', value: collected } };
      }
      const usage1 = await this.#fetchUsage(cascade);
      // IMPORTANT: Advance the stored pastTurns and set
      // keepAliveOnSuccess BEFORE yielding turn_end. The stream
      // consumer (stream.ts) breaks out of the for-await loop on
      // turn_end, so any code after this yield never runs. The
      // finally block then handles keep/dispose based on
      // keepAliveOnSuccess.
      this.#updateSessionProgress(matchedCascadeId!, pastTurns, sessionId!);
      keepAliveOnSuccess = true;
      yield { type: 'turn_end', sessionId: requestId, stopReason: 'end_turn', usage: usage1 };
    } catch (error) {
      console.error('[Backend] Stream error:', error);

      const errorMsg = error instanceof Error ? error.message : String(error);
      if (errorMsg.includes('timeout')) {
        yield {
          type: 'error',
          sessionId: requestId,
          message: `Antigravity LS did not respond within the timeout period.`,
          status: 504,
        };
        return;
      }

      const status = this.#classifyConnectErrorCode(error);
      yield { type: 'error', sessionId: requestId, message: errorMsg, status };
    } finally {
      // On success, keep the Cascade alive in the session store so the
      // next turn in the same session re-attaches. On error (or when
      // we returned early without setting keepAliveOnSuccess), drop
      // the Cascade from the store and delete its trajectory.
      if (cascade && matchedCascadeId) {
        const stillMapped = this.sessionStore.has(matchedCascadeId);
        if (keepAliveOnSuccess && stillMapped) {
          // Keep the cascade alive — no disposal.
        } else {
          if (stillMapped) this.sessionStore.delete(matchedCascadeId);
          await this.#disposeCascade(cascade).catch((e) =>
            console.warn(`[Backend] dispose failed for requestId=${requestId}:`, e),
          );
        }
      }
      this.inflightCascades.delete(requestId);
      this.mcpHub.clearPendingCalls(`Request ${requestId} completed`);
    }
  }

  async cancelSession(requestId: string): Promise<void> {
    const cascade = this.inflightCascades.get(requestId);
    if (cascade) {
      console.log(`[Backend] Cancelling cascade for request ${requestId} (cascadeId=${cascade.cascadeId})`);
      try {
        await cascade.cancel();
      } catch (err) {
        console.warn(`[Backend] Failed to cancel cascade for request ${requestId}:`, err);
      }
    }
    this.mcpHub.clearPendingCalls('Session cancelled');
  }

  async shutdown(): Promise<void> {
    // Cancel any in-flight cascades
    for (const [requestId, cascade] of this.inflightCascades.entries()) {
      try { await cascade.cancel(); }
      catch (err) { console.warn(`[Backend] Failed to cancel inflight cascade ${requestId} during shutdown:`, err); }
    }
    this.inflightCascades.clear();

    // Delete all session-store cascades' trajectories. We don't need
    // to cancelAndWait — the LS process is about to die, so deleting
    // the trajectories is best-effort cleanup.
    if (this.client) {
      for (const [cascadeId, entry] of this.sessionStore.entries()) {
        try {
          await this.client.lsClient.deleteCascadeTrajectory(
            new DeleteCascadeTrajectoryRequest({ cascadeId }),
          );
        } catch (err) {
          console.warn(`[Backend] Failed to delete cascade ${cascadeId} for session ${entry.sessionId} during shutdown:`, err);
        }
      }
    }
    this.sessionStore.clear();

    try {
      await this.mcpHub.stop();
    } catch (e) {
      console.error('[Backend] McpHub shutdown error:', e);
    }
    if (this.client) {
      console.log('[Backend] Shutting down Antigravity LS...');
      try {
        this.client.dispose();
        if (this.client.launcher) {
          await this.client.launcher.stop();
        }
      } catch (e) {
        console.error('[Backend] Shutdown error:', e);
      }
      this.client = null;
    }

    if (this.workspaceDir) {
      try {
        await rm(this.workspaceDir, { recursive: true, force: true });
      } catch (e) {
        console.error('[Backend] Failed to remove temp workspace dir:', e);
      }
      this.workspaceDir = null;
    }
  }
}

export const antigravityBackend = new AntigravityBackend();
