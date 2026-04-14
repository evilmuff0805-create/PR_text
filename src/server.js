import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import authRouter from './routes/auth.js';
import paymentRouter from './routes/payment.js';
import transcribeRouter from './routes/transcribe.js';
import downloadRouter from './routes/download.js';
import translateRouter from './routes/translate.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = join(__dirname, '../dist');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Rate limit 공통 응답
const rateLimitHandler = (req, res) => {
  res.status(429).json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' });
};

// 일반 API: IP당 분당 30회
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  handler: rateLimitHandler,
});

// /api/transcribe: IP당 분당 5회
const transcribeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  handler: rateLimitHandler,
});

// /api/translate: IP당 분당 10회
const translateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  handler: rateLimitHandler,
});

// /api/auth/reset-password: IP당 분당 3회
const resetPasswordLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  handler: rateLimitHandler,
});

// /api/download: IP당 분당 20회
const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  handler: rateLimitHandler,
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/auth/reset-password', resetPasswordLimiter);
app.use('/api/auth', generalLimiter, authRouter);
app.use('/api/payment', generalLimiter, paymentRouter);
app.use('/api/transcribe', transcribeLimiter, transcribeRouter);
app.use('/api/download', downloadLimiter, downloadRouter);
app.use('/api/translate', translateLimiter, translateRouter);

// Static files (production)
if (existsSync(distPath)) {
  app.use(express.static(distPath));

  // SPA fallback
  app.get('*', (req, res) => {
    res.sendFile(join(distPath, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
