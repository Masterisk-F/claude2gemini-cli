import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { convertMessagesToPrompt } from '../server/converters/request.js';
import type { ClaudeMessage } from '../server/types.js';
import { promises as fsPromises } from 'node:fs';

describe('convertMessagesToPrompt', () => {
  const proxyHome = '/tmp/proxyHomeTest';
  const sessionId = 'sess-123';

  beforeEach(async () => {
    await fsPromises.mkdir(proxyHome, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await fsPromises.rm(proxyHome, { recursive: true, force: true });
    } catch (e) {
      // ignore
    }
  });

  it('correctly interpolates tool result', async () => {
    const messages: ClaudeMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-123', content: 'result text' }
        ]
      }
    ];
    const tempFiles: string[] = [];
    const prompt = await convertMessagesToPrompt(messages, proxyHome, sessionId, tempFiles);

    expect(prompt).toContain('[Tool Result tool-123: result text]');
  });

  it('processes image block correctly, creating a file and injecting read_file instruction', async () => {
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
    const tempFiles: string[] = [];
    const prompt = await convertMessagesToPrompt(messages, proxyHome, sessionId, tempFiles);

    expect(tempFiles).toHaveLength(1);
    const filePath = tempFiles[0];
    expect(filePath).toMatch(/\.jpg$/);
    expect(filePath).toContain(sessionId);

    // File should exist and contain the decoded data
    const fileContent = await fsPromises.readFile(filePath, 'utf-8');
    expect(fileContent).toBe('test');

    expect(prompt).toContain(`[Attached File: The user attached a file. Please read it using the read_file tool from the absolute path: ${filePath}]`);
  });

  it('processes document block correctly with correct extension', async () => {
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
    const tempFiles: string[] = [];
    const prompt = await convertMessagesToPrompt(messages, proxyHome, sessionId, tempFiles);

    expect(tempFiles).toHaveLength(1);
    expect(tempFiles[0]).toMatch(/\.pdf$/);
  });

  it('pushes an error message to the prompt if file writing fails', async () => {
    // Mock fsPromises.writeFile to throw an error
    vi.spyOn(fsPromises, 'writeFile').mockRejectedValue(new Error('Simulated write error'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const messages: ClaudeMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'bW9jaw=='
            }
          }
        ]
      }
    ];
    const tempFiles: string[] = [];
    const prompt = await convertMessagesToPrompt(messages, proxyHome, sessionId, tempFiles);

    expect(tempFiles).toHaveLength(0); // Should not have added any file
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(prompt).toContain('[Error: Failed to process attached file]');
  });
});
