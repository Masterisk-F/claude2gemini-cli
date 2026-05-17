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

  it('should not delete tmp directory if it exists (removed tmp cleanup)', () => {
    // 1. Create a dummy tmp directory
    const tmpDir = path.join(proxyHome, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'orphan.txt'), 'content');

    expect(fs.existsSync(path.join(tmpDir, 'orphan.txt'))).toBe(true);

    // 2. Call buildProxyHome
    buildProxyHome(accountId);

    // 3. Verify tmp directory is NOT gone
    expect(fs.existsSync(tmpDir)).toBe(true);
  });
});