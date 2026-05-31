import { describe, it, expect } from 'vitest';
import { mapModelName, extractSystemPrompt } from '../server/converters/request.js';

describe('mapModelName', () => {
  it('passes through formal model names', () => {
    expect(mapModelName('Gemini_3.1_Pro_High')).toBe('Gemini_3.1_Pro_High');
    expect(mapModelName('Claude_Opus_4.6_Thinking')).toBe('Claude_Opus_4.6_Thinking');
  });

  it('maps claude-opus aliases', () => {
    expect(mapModelName('claude-opus')).toBe('Claude_Opus_4.6_Thinking');
    expect(mapModelName('claude-3-opus-20240229')).toBe('Claude_Opus_4.6_Thinking');
  });

  it('maps claude-sonnet aliases', () => {
    expect(mapModelName('claude-sonnet')).toBe('Claude_Sonnet_4.6_Thinking');
    expect(mapModelName('claude-3-5-sonnet-20240620')).toBe('Claude_Sonnet_4.6_Thinking');
  });

  it('maps claude-haiku aliases', () => {
    expect(mapModelName('claude-haiku')).toBe('Gemini_3.1_Flash_Lite');
    expect(mapModelName('claude-3-5-haiku-20241022')).toBe('Gemini_3.1_Flash_Lite');
  });

  it('maps gemini aliases', () => {
    expect(mapModelName('gemini-pro')).toBe('Gemini_3.1_Pro_High');
    expect(mapModelName('gemini-pro-low')).toBe('Gemini_3.1_Pro_Low');
    expect(mapModelName('gemini-flash')).toBe('Gemini_3.5_Flash_High');
    expect(mapModelName('gemini-flash-medium')).toBe('Gemini_3.5_Flash_Medium');
    expect(mapModelName('gemini-flash-lite')).toBe('Gemini_3.1_Flash_Lite');
  });

  it('handles aliases without gemini prefix', () => {
    expect(mapModelName('pro')).toBe('Gemini_3.1_Pro_High');
    expect(mapModelName('flash')).toBe('Gemini_3.5_Flash_High');
    expect(mapModelName('flash-lite')).toBe('Gemini_3.1_Flash_Lite');
  });

  it('falls back to default for unknown models', () => {
    expect(mapModelName('unknown-model')).toBe('Gemini_3.5_Flash_High');
  });
});

describe('extractSystemPrompt', () => {
  it('handles string input', () => {
    expect(extractSystemPrompt('test prompt')).toBe('test prompt');
  });

  it('handles array input', () => {
    const input = [
      { type: 'text', text: 'part 1' },
      'part 2'
    ];
    expect(extractSystemPrompt(input)).toBe('part 1\npart 2');
  });

  it('handles empty input', () => {
    expect(extractSystemPrompt(undefined)).toBeUndefined();
    expect(extractSystemPrompt(null)).toBeUndefined();
  });
});
