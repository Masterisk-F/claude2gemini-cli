import express from 'express';
import { messagesRouter } from './routes/messages.js';
import { accountPool } from './account-pool.js';
import { childManager } from './child-manager.js';

const app = express();
const PORT = parseInt(process.env.PORT || '8080', 10);

app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));

// Claude API 互換エンドポイント
app.use('/v1/messages', messagesRouter);

// ヘルスチェック
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const server = app.listen(PORT);
server.on('listening', async () => {
  await accountPool.initialize();
  const count = accountPool.getAccountCount();
  console.log(`Claude2Gemini proxy listening on port ${PORT}`);
  if (count > 0) {
    console.log(`[AccountPool] ${count} accounts are ready for round-robin.`);
  } else {
    console.log(`[AccountPool] Using default ~/.gemini account.`);
  }

  // 子プロセス起動
  const accounts = accountPool.getAccountIds();
  if (accounts.length > 0) {
    await childManager.spawnAll(accounts);
  } else {
    await childManager.spawnAll(['default']);
  }
});
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Error] Port ${PORT} is already in use. Is another proxy instance running?`);
  } else {
    console.error(`[Error] Failed to start proxy:`, err.message);
  }
  childManager.killAll();
  process.exit(1);
});

// 終了シグナルハンドラ: 子プロセスを確実に終了させる
process.on('SIGINT', () => {
  console.log('\n[Shutdown] Received SIGINT, killing child processes...');
  childManager.killAll();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[Shutdown] Received SIGTERM, killing child processes...');
  childManager.killAll();
  process.exit(0);
});
