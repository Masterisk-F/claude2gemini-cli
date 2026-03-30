import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildProxyHome } from './env-setup.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

interface Account {
  id: string;
  label: string;
  credentials: any;
}

class AccountPool {
  private accounts: Account[] = [];
  private currentIndex = 0;
  private initialized = false;

  async initialize() {
    if (this.initialized) return;

    if (fs.existsSync(ACCOUNTS_FILE)) {
      try {
        const content = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
        this.accounts = JSON.parse(content);
        console.log(`[AccountPool] Loaded ${this.accounts.length} account(s) from accounts.json`);
      } catch (e) {
        console.error('[AccountPool] Failed to load accounts.json:', e);
        this.accounts = [];
      }
    } else {
      console.log('[AccountPool] accounts.json not found. Falling back to default ~/.gemini account.');
    }

    // 各アカウントの仮想HOMEを事前構築
    for (const account of this.accounts) {
      const proxyHome = buildProxyHome(account.id, account.credentials);
      console.log(`[AccountPool] Initialized virtual HOME for account "${account.label}" (${account.id}): ${proxyHome}`);
    }

    this.initialized = true;
  }

  nextAccount(): string | undefined {
    if (this.accounts.length === 0) {
      return undefined; // フォールバック用
    }

    const account = this.accounts[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.accounts.length;

    console.log(`[AccountPool] Assigned account: ${account.label} (${account.id})`);
    return account.id;
  }

  getAccountIds(): string[] {
    return this.accounts.map(a => a.id);
  }

  getAccountHome(accountId: string): string {
    const username = os.userInfo().username;
    return path.join(os.tmpdir(), `claude2gemini-env-${username}-${accountId}`);
  }

  getAccountCount(): number {
    return this.accounts.length;
  }
}

export const accountPool = new AccountPool();
