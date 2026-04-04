import { describe, it, expect, vi } from 'vitest';
import { classifyError } from '../server/routes/messages.js';
import { childManager } from '../server/child-manager.js';
import { sessionStore } from '../server/session-store.js';

vi.mock('../server/child-manager.js', () => ({
  childManager: {
    sendRequest: vi.fn(),
    onMessage: vi.fn(),
    onChildExit: vi.fn(),
  }
}));

describe('messages route error handling', () => {
  describe('classifyError', () => {
    it('classifies QUOTA_EXHAUSTED as overloaded_error', () => {
      const result = classifyError(new Error('QUOTA_EXHAUSTED'));
      expect(result.statusCode).toBe(500);
      expect(result.errorType).toBe('overloaded_error');
    });

    it('classifies RESOURCE_EXHAUSTED as overloaded_error', () => {
      const result = classifyError(new Error('RESOURCE_EXHAUSTED'));
      expect(result.statusCode).toBe(500);
      expect(result.errorType).toBe('overloaded_error');
    });

    it('classifies status 429 as overloaded_error', () => {
      const error: any = new Error('Test 429 error');
      error.status = 429;
      const result = classifyError(error);
      expect(result.statusCode).toBe(500);
      expect(result.errorType).toBe('overloaded_error');
    });

    it('classifies TerminalQuotaError as overloaded_error', () => {
      const error: any = new Error('Terminal quota exceeded');
      error.name = 'TerminalQuotaError';
      const result = classifyError(error);
      expect(result.statusCode).toBe(500);
      expect(result.errorType).toBe('overloaded_error');
    });

    it('classifies generic error as api_error 500', () => {
      const result = classifyError(new Error('Unknown generic error'));
      expect(result.statusCode).toBe(500);
      expect(result.errorType).toBe('api_error');
    });
  });
});
