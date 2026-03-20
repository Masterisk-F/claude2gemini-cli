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

app.listen(PORT, () => {
  console.log(`Claude2Gemini proxy listening on port ${PORT}`);
});
