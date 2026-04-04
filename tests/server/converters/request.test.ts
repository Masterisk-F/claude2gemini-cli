import { describe, it, expect } from 'vitest';
import { mapModelName, convertMessagesToPrompt, extractSystemPrompt } from '../../../server/converters/request.js';
import type { ClaudeMessage } from '../../../server/types.js';

describe('request converter', () => {
  describe('mapModelName', () => {
    it('should map opus models to gemini-3.1-pro-preview', () => {
      expect(mapModelName('claude-3-opus-20240229')).toBe('gemini-3.1-pro-preview');
    });

    it('should map sonnet models to gemini-3-flash-preview', () => {
      expect(mapModelName('claude-3-5-sonnet-20240620')).toBe('gemini-3-flash-preview');
    });

    it('should map haiku models to gemini-2.5-flash-lite', () => {
      expect(mapModelName('claude-3-haiku-20240307')).toBe('gemini-2.5-flash-lite');
    });

    it('should default to gemini-3-flash-preview for unknown non-gemini models', () => {
      expect(mapModelName('gpt-4')).toBe('gemini-3-flash-preview');
    });

    it('should keep gemini models as is', () => {
      expect(mapModelName('gemini-1.5-pro')).toBe('gemini-1.5-pro');
    });
  });

  describe('extractSystemPrompt', () => {
    it('should handle string system prompt', () => {
      expect(extractSystemPrompt('You are a helpful assistant.')).toBe('You are a helpful assistant.');
    });

    it('should handle array of blocks', () => {
      const system = [
        { type: 'text', text: 'Line 1' },
        'Line 2',
        { type: 'text', text: 'Line 3' }
      ];
      expect(extractSystemPrompt(system)).toBe('Line 1\nLine 2\nLine 3');
    });

    it('should return undefined for empty system', () => {
      expect(extractSystemPrompt(undefined)).toBeUndefined();
    });
  });

  describe('convertMessagesToPrompt', () => {
    it('should convert single user message to raw text', () => {
      const messages: ClaudeMessage[] = [
        { role: 'user', content: 'Hello' }
      ];
      expect(convertMessagesToPrompt(messages)).toBe('Hello');
    });

    it('should convert multi-turn messages with role labels', () => {
      const messages: ClaudeMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' }
      ];
      const expected = 'User: Hello\n\nAssistant: Hi there!\n\nUser: How are you?';
      expect(convertMessagesToPrompt(messages)).toBe(expected);
    });

    it('should handle complex content with tool use and results', () => {
      const messages: ClaudeMessage[] = [
        { role: 'user', content: 'What is the weather?' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { location: 'Tokyo' } }
          ]
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: 'Sunny, 25C' }
          ]
        }
      ];
      const result = convertMessagesToPrompt(messages);
      expect(result).toContain('User: What is the weather?');
      expect(result).toContain('Assistant: Let me check.');
      expect(result).toContain('[Tool Call: get_weather({"location":"Tokyo"})]');
      expect(result).toContain('[Tool Result (call_1): Sunny, 25C]');
    });
  });
});
