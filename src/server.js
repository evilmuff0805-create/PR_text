import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import authRouter from './routes/auth.js';
import accountRouter from './routes/account.js';
import paymentRouter, { paymentWebhookRouter } from './routes/payment.js';
import transcribeRouter from './routes/transcribe.js';
import transcriptionJobsRouter from './routes/transcription-jobs.js';
import downloadRouter from './routes/download.js';
import translateRouter from './routes/translate.js';
import captionIdeasRouter from './routes/caption-ideas.js';
import { requestObservability, apiErrorHandler } from './middleware/observability.js';
import { startDiarizationJobWorker } from './services/diarization-jobs.js';
import { startCaptionIdeaMaintenance } from './services/caption-idea-store.js';
import { startPaymentOrderMaintenance } from './services/payment-orders.js';
import { validateTossKeyPair } from './services/toss-payments.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = join(__dirname, '../dist');

const REQUIRED_ENV = [
  'OPENAI_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'TOSS_SECRET_KEY',
  'TOSS_CLIENT_KEY',
];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length > 0) {
  console.error(`[ENV] 필수 환경변수 누락: ${missingEnv.join(', ')}`);
  process.exit(1);
}

try {
  const { environment } = validateTossKeyPair({
    clientKey: process.env.TOSS_CLIENT_KEY,
    secretKey: process.env.TOSS_SECRET_KEY,
  });
  console.log(`[ENV] Toss Payments mode: ${environment}`);
} catch (error) {
  console.error(`[ENV] ${error.message}`);
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // Railway 등 리버스 프록시 환경에서 X-Forwarded-For 신뢰
const PORT = process.env.PORT || 3000;
app.use(requestObservability);

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  ...(process.env.APP_URL ? [process.env.APP_URL] : []),
];
app.use(cors({
  origin: (origin, cb) => {
    // 서버 to 서버, curl 등 origin 없는 요청 허용
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin not allowed — ${origin}`));
  },
  credentials: true,
}));
app.use(express.json({ limit: '50mb' }));

// Rate limit 공통 응답
const rateLimitHandler = (req, res) => {
  console.warn('[api.rate_limit]', JSON.stringify({
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl.split('?')[0],
  }));
  res.status(429).json({
    error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
    requestId: req.requestId,
  });
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

// 자막 아이디어 생성: IP당 분당 5회. 상태 조회에는 적용하지 않는다.
const captionIdeasLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  handler: rateLimitHandler,
});

// /api/auth/reset-password: IP당 분당 3회
const resetPasswordLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  handler: rateLimitHandler,
});

// 비밀번호 변경 실패: IP당 15분에 5회
const passwordChangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  handler: rateLimitHandler,
});

// 회원 탈퇴 본인 확인 실패: IP당 15분에 5회
const accountDeletionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  handler: rateLimitHandler,
});

// /api/download: IP당 분당 20회
const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  handler: rateLimitHandler,
});

// 토스 결제 상태 웹훅: 인증 대신 토스 API 재조회로 진위를 검증한다.
const paymentWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  handler: rateLimitHandler,
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.floor(process.uptime()),
    commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
  });
});

app.use('/api/auth/reset-password', resetPasswordLimiter);
app.use('/api/auth/recovery-password', passwordChangeLimiter);
app.use('/api/auth/password', passwordChangeLimiter);
app.use('/api/auth', generalLimiter, authRouter);
app.use('/api/account', accountDeletionLimiter, generalLimiter, accountRouter);
app.use('/api/payment/webhook', paymentWebhookLimiter, paymentWebhookRouter);
app.use('/api/payment', generalLimiter, paymentRouter);
app.use('/api/transcribe/jobs', generalLimiter, transcriptionJobsRouter);
app.use('/api/transcribe', transcribeLimiter, transcribeRouter);
app.use('/api/download', downloadLimiter, downloadRouter);
app.use('/api/translate', translateLimiter, translateRouter);
app.post('/api/caption-ideas', captionIdeasLimiter);
app.use('/api/caption-ideas', generalLimiter, captionIdeasRouter);
app.use(apiErrorHandler);

// Unknown API paths must not fall through to the SPA HTML fallback.
app.use('/api', (req, res) => {
  res.status(404).json({
    error: '요청한 API를 찾을 수 없습니다.',
    requestId: req.requestId,
  });
});

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
  startDiarizationJobWorker();
  startCaptionIdeaMaintenance();
  startPaymentOrderMaintenance();
});
