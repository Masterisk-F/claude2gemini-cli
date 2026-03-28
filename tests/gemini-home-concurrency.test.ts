import test from 'node:test';
import assert from 'node:assert';
import { sendPromptAndCollect } from '../server/gemini-backend.js';
import { accountPool } from '../server/account-pool.js';
import { GeminiCliAgent } from '@google/gemini-cli-sdk';

test('Concurrent requests should not cross-contaminate GEMINI_CLI_HOME', async () => {
  const ORIGINAL_HOME = process.env.GEMINI_CLI_HOME || 'ORIGINAL_HOME';
  process.env.GEMINI_CLI_HOME = ORIGINAL_HOME;

  // モック
  const originalGetAccountHome = accountPool.getAccountHome.bind(accountPool);
  accountPool.getAccountHome = (id: string) => `/mock/home/claude2gemini-${id}`;

  // initialize() の間に意図的に非同期の遅延を差し込む
  const realAgentSession = GeminiCliAgent.prototype.session;
  let didMock = false;
  
  GeminiCliAgent.prototype.session = function() {
      const s = realAgentSession.call(this);
      const realInit = s.initialize;
      s.initialize = async function() {
         // initialize が呼ばれたら、プロセス環境変数が書き換わった直後。
         // ここでわざとイベントループを回して、並行タスクに処理を譲る
         await new Promise(r => setTimeout(r, 50));
         return realInit.call(this);
      };
      return s;
  };
  didMock = true;

  let leakedValue: string | undefined = undefined;

  const concurrentReader = (async () => {
    // 100ms 間、5ms 間隔でポーリングして process.env の変化を監視
    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 5));
        const currentEnv = process.env.GEMINI_CLI_HOME;
        // ORIGINAL_HOME 以外に変化していたら、それは並行リクエストによる汚染（漏洩）
        if (currentEnv !== ORIGINAL_HOME) {
            leakedValue = currentEnv;
            break; // 最初に見つけた異常値で終了
        }
    }
  })();

  const API_PROMISE = sendPromptAndCollect('Hello, this is a test', {
      accountId: 'account-A',
      model: 'gemini-1.5-flash',
  }).catch(() => {}); // エラーは無視（認証情報がないため）
    
  // SDKの初期化処理を待つ。同期的に終了しないよう遅延させてあるため、
  // concurrentReader が漏洩値をキャッチする。
  await Promise.race([API_PROMISE, new Promise(r => setTimeout(r, 150))]);
  await concurrentReader;

  // 後始末
  process.env.GEMINI_CLI_HOME = ORIGINAL_HOME;
  accountPool.getAccountHome = originalGetAccountHome;
  if (didMock) {
      GeminiCliAgent.prototype.session = realAgentSession;
  }

  assert.equal(leakedValue, undefined, `バグ検知: GEMINI_CLI_HOME が漏洩しました (${leakedValue})`);
});
