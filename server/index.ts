import { setupProxyEnv } from './env-setup.js';
setupProxyEnv(); // 他のモジュールが読み込まれる前に環境変数を上書き

import express from 'express';
import { messagesRouter } from './routes/messages.js';

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
server.on('listening', () => {
  console.log(`Claude2Gemini proxy listening on port ${PORT}`);
});
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Error] Port ${PORT} is already in use. Is another proxy instance running?`);
  } else {
    console.error(`[Error] Failed to start proxy:`, err.message);
  }
  process.exit(1);
});
