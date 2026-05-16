import { describe, it, expect } from 'vitest';
import { convertMessagesToPrompt } from '../server/converters/request.js';
import type { ClaudeMessage } from '../server/types.js';

describe('convertMessagesToPrompt', () => {
  it('correctly interpolates tool result and processes multimodal blocks', async () => {
    const messages: ClaudeMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-123', content: 'result text' }
        ]
      }
    ];
    const tempFiles: string[] = [];
    const prompt = await convertMessagesToPrompt(messages, '/tmp/proxyHome', 'sess-1', tempFiles);

    expect(prompt).toContain('[Tool Result tool-123: result text]');
  });
});
