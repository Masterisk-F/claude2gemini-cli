/**
 * Claude API メッセージ型定義
 *
 * Claude Messages API のリクエスト/レスポンス形式を定義する。
 * 全型を網羅するのではなく、プロキシに必要な最小限の型のみ定義。
 */

// --- リクエスト型 ---

export interface ClaudeTextBlock {
  type: 'text';
  text: string;
}

export interface ClaudeToolUseBlock {
  type: 'tool_use' | 'server_tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ClaudeToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ClaudeContentBlock[];
}

export interface ClaudeWebSearchToolResultBlock {
  type: 'web_search_tool_result';
  tool_use_id: string;
  content: any;
}

export interface ClaudeImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export interface ClaudeDocumentBlock {
  type: 'document';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export type ClaudeContentBlock = ClaudeTextBlock | ClaudeToolUseBlock | ClaudeToolResultBlock | ClaudeWebSearchToolResultBlock | ClaudeImageBlock | ClaudeDocumentBlock;

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string | ClaudeContentBlock[];
}

export interface ClaudeToolDefinition {
  type?: string;
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface ClaudeRequest {
  model: string;
  messages: ClaudeMessage[];
  max_tokens: number;
  stream?: boolean;
  system?: string;
  tools?: ClaudeToolDefinition[];
  stop_sequences?: string[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
}

// --- レスポンス型 ---

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** web_search ツール使用時にのみ付与されるサーバーツール使用量 */
  server_tool_use?: {
    web_search_requests: number;
  };
}

export type ClaudeStopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';

export interface ClaudeResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: ClaudeContentBlock[];
  model: string;
  stop_reason: ClaudeStopReason | null;
  stop_sequence: string | null;
  usage: ClaudeUsage;
}

// --- SSE イベント型 ---

export interface ClaudeMessageStartEvent {
  type: 'message_start';
  message: Omit<ClaudeResponse, 'stop_reason' | 'stop_sequence'> & {
    stop_reason: null;
    stop_sequence: null;
  };
}

/** Citations: テキストブロックに付与される web_search 引用情報 */
export interface ClaudeWebSearchCitation {
  type: 'web_search_result_location';
  url: string;
  title: string;
  /** encrypted_content (IPC 内部) を変換したもの。実装上は URL の Base64 エンコード値 */
  encrypted_index: string;
  cited_text: string;
}

export interface ClaudeContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block:
    | { type: 'text'; text: ''; citations?: ClaudeWebSearchCitation[] }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, never> }
    /** PR #24 追加: server-side tool (web_search など) の開始ブロック */
    | { type: 'server_tool_use'; id: string; name: string; input: Record<string, never> }
    /** PR #24 追加: web_search の結果ブロック */
    | { type: 'web_search_tool_result'; tool_use_id: string; content: any };
}

export interface ClaudeContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string };
}

export interface ClaudeContentBlockStopEvent {
  type: 'content_block_stop';
  index: number;
}

export interface ClaudeMessageDeltaEvent {
  type: 'message_delta';
  delta: {
    stop_reason: ClaudeStopReason;
    stop_sequence: string | null;
  };
  usage: {
    output_tokens: number;
  };
}

export interface ClaudeMessageStopEvent {
  type: 'message_stop';
}

export interface ClaudePingEvent {
  type: 'ping';
}

export type ClaudeSSEEvent =
  | ClaudeMessageStartEvent
  | ClaudeContentBlockStartEvent
  | ClaudeContentBlockDeltaEvent
  | ClaudeContentBlockStopEvent
  | ClaudeMessageDeltaEvent
  | ClaudeMessageStopEvent
  | ClaudePingEvent;
