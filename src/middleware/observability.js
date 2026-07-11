import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';

function apiPath(req) {
  return req.originalUrl.split('?')[0];
}

function logRequest(level, payload) {
  console[level]('[api.request]', JSON.stringify(payload));
}

export function requestObservability(req, res, next) {
  const requestId = randomUUID();
  const startedAt = performance.now();

  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  res.on('finish', () => {
    const path = apiPath(req);
    if (!path.startsWith('/api/') || path === '/api/health') return;

    const payload = {
      requestId,
      method: req.method,
      path,
      status: res.statusCode,
      durationMs: Math.round(performance.now() - startedAt),
    };

    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'log';
    logRequest(level, payload);
  });

  next();
}

export function apiErrorHandler(err, req, res, next) {
  if (!apiPath(req).startsWith('/api/')) return next(err);
  if (res.headersSent) return next(err);

  const isCorsError = err.message?.startsWith('CORS:');
  const isInvalidJson = err.type === 'entity.parse.failed';
  const status = isCorsError ? 403 : isInvalidJson ? 400 : 500;
  const error = isCorsError
    ? '허용되지 않은 요청 출처입니다.'
    : isInvalidJson
      ? '요청 형식이 올바르지 않습니다.'
      : '서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.';

  console.error('[api.error]', JSON.stringify({
    requestId: req.requestId,
    method: req.method,
    path: apiPath(req),
    status,
    name: err.name,
    message: err.message,
  }));

  res.status(status).json({ error, requestId: req.requestId });
}
