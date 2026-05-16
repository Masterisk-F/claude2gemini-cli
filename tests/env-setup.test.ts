import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildProxyHome } from '../server/env-setup.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('buildProxyHome', () => {
  const accountId = 'test-account-' + Math.random().toString(36).substring(7);
  let proxyHome: string;

  beforeEach(() => {
    // Determine the path that buildProxyHome will use
    const username = os.userInfo().username || 'default';
    proxyHome = path.join(os.tmpdir(), `claude2gemini-env-${username}-${accountId}`);

    // Cleanup if exists
    if (fs.existsSync(proxyHome)) {
      fs.rmSync(proxyHome, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(proxyHome)) {
      fs.rmSync(proxyHome, { recursive: true, force: true });
    }
  });

  it('should create the proxyHome directory if it does not exist', () => {
    const returnedPath = buildProxyHome(accountId);
    expect(returnedPath).toBe(proxyHome);
    expect(fs.existsSync(proxyHome)).toBe(true);
    expect(fs.existsSync(path.join(proxyHome, '.gemini'))).toBe(true);
  });

  it('should clean up orphaned temp files in tmp/ directory on startup', () => {
    // 1. Create a dummy tmp directory and files as if it were a previous crashed session
    const tmpDir = path.join(proxyHome, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'orphan.txt'), 'leaked content');

    const subDir = path.join(tmpDir, 'subdir');
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(subDir, 'leaked.jpg'), 'image data');

    expect(fs.existsSync(path.join(tmpDir, 'orphan.txt'))).toBe(true);
    expect(fs.existsSync(path.join(subDir, 'leaked.jpg'))).toBe(true);

    // 2. Call buildProxyHome
    buildProxyHome(accountId);

    // 3. Verify tmp directory is gone (or at least empty)
    // According to our implementation: fs.rmSync(tmpDir, { recursive: true, force: true });
    expect(fs.existsSync(tmpDir)).toBe(false);
  });

  it('should handle non-existent tmp directory gracefully', () => {
    // 1. Ensure tmp directory does not exist
    const tmpDir = path.join(proxyHome, 'tmp');
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // 2. Call buildProxyHome
    expect(() => buildProxyHome(accountId)).not.toThrow();

    // 3. Verify it still created the basic structure
    expect(fs.existsSync(path.join(proxyHome, '.gemini'))).toBe(true);
  });
});
