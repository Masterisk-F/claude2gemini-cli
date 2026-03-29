/**
 * Parent / Child 間のプロセス間通信 (IPC) プロトコル定義
 *
 * UNIXソケット経由での NDJSON (Newline Delimited JSON) 通信に使用される
 * メッセージの型を定義する。
 */

import type { ClaudeMessage, ClaudeToolDefinition } from './types.js';

/**
 * Parent から Child へ送信されるメッセージ
 */
export type ParentMessage =
    | {
        type: 'request';
        id: string; // リクエストID
        sessionId: string; // セッションID
        system?: string; // システムプロンプト (optional)
        messages: ClaudeMessage[]; // 会話履歴
        model: string; // 使用するモデル名
        tools?: ClaudeToolDefinition[]; // 利用可能なツール (optional)
    }
    | {
        type: 'tool_result';
        sessionId: string;
        toolCallId: string; // 解決するツールの呼び出しID
        result: string; // ツールの実行結果 (JSON文字列またはプレーンテキスト)
    }
    | {
        type: 'resume_stream';
        sessionId: string;
    };

/**
 * Child から Parent へ送信されるメッセージ
 */
export type ChildMessage =
    | {
        type: 'ready';
    }
    | {
        type: 'stream_event';
        sessionId: string;
        event: {
            type: string;
            value?: any;
        }; // ServerGeminiStreamEvent のシリアライズ表現
    }
    | {
        type: 'tool_call';
        sessionId: string;
        callId: string;
        name: string;
        args: Record<string, unknown>;
    }
    | {
        type: 'turn_end';
        sessionId: string;
        stopReason: string; // ClaudeStopReason ('end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence')
        usage?: {
            input_tokens: number;
            output_tokens: number;
        };
    }
    | {
        type: 'error';
        sessionId: string;
        message: string;
        status?: number;
    }
    | {
        type: 'fatal_error';
        message: string;
    };

/**
 * NDJSON 形式でのメッセージのシリアライズ・デシリアライズ用ヘルパー
 */
export function serializeIPCMessage(msg: ParentMessage | ChildMessage): string {
    return JSON.stringify(msg) + '\n';
}

export function parseIPCMessage<T extends ParentMessage | ChildMessage>(line: string): T {
    return JSON.parse(line) as T;
}
