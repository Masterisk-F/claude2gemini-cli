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
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ClaudeToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ClaudeContentBlock[];
}

export type ClaudeContentBlock = ClaudeTextBlock | ClaudeToolUseBlock | ClaudeToolResultBlock;

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string | ClaudeContentBlock[];
}

export interface ClaudeToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
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

export interface ClaudeContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block: { type: 'text'; text: '' } | { type: 'tool_use'; id: string; name: string; input: Record<string, never> };
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
