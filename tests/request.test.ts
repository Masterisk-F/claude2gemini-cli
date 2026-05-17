import { describe, it, expect } from 'vitest';
import { convertMessagesToPrompt } from '../server/converters/request.js';
import type { ClaudeMessage } from '../server/types.js';

describe('convertMessagesToPrompt', () => {
  it('correctly interpolates tool result', async () => {
    const messages: ClaudeMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-123', content: 'result text' }
        ]
      }
    ];
    // Cast to any to bypass current type signature before we fix the implementation
    const { prompt, inlineDataParts } = await (convertMessagesToPrompt(messages, '', '', []) as Promise<any>);

    expect(prompt).toContain('[Tool Result tool-123: result text]');
    expect(inlineDataParts).toEqual([]);
  });

  it('processes image block correctly, collecting it into inlineDataParts', async () => {
    const messages: ClaudeMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: 'dGVzdA==' // 'test' in base64
            }
          }
        ]
      }
    ];
    const { prompt, inlineDataParts } = await (convertMessagesToPrompt(messages, '', '', []) as Promise<any>);

    expect(inlineDataParts).toHaveLength(1);
    expect(inlineDataParts[0]).toEqual({
      inlineData: {
        mimeType: 'image/jpeg',
        data: 'dGVzdA=='
      }
    });

    expect(prompt).toContain('[Attached: image/jpeg]');
  });

  it('processes document block correctly', async () => {
    const messages: ClaudeMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: 'UERG' // 'PDF'
            }
          }
        ]
      }
    ];
    const { prompt, inlineDataParts } = await (convertMessagesToPrompt(messages, '', '', []) as Promise<any>);

    expect(inlineDataParts).toHaveLength(1);
    expect(inlineDataParts[0]).toEqual({
      inlineData: {
        mimeType: 'application/pdf',
        data: 'UERG'
      }
    });
    expect(prompt).toContain('[Attached: application/pdf]');
  });
});