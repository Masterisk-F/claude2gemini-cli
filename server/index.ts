import express from 'express';
import { messagesRouter } from './routes/messages.js';
import { antigravityBackend } from './gemini-backend.js';

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

async function startServer() {
  try {
    await antigravityBackend.initialize();
  } catch (err) {
    console.error(`[Error] Failed to initialize Antigravity backend:`, err);
    process.exit(1);
  }

  const server = app.listen(PORT, () => {
    console.log(`Claude2Gemini proxy (Antigravity mode) listening on port ${PORT}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Error] Port ${PORT} is already in use. Is another proxy instance running?`);
    } else {
      console.error(`[Error] Failed to start proxy:`, err.message);
    }
    process.exit(1);
  });
}

startServer();

// 終了シグナルハンドラ
process.on('SIGINT', async () => {
  console.log('\n[Shutdown] Received SIGINT, shutting down...');
  await antigravityBackend.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[Shutdown] Received SIGTERM, shutting down...');
  await antigravityBackend.shutdown();
  process.exit(0);
});
