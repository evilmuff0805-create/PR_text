import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import {
  CAPTION_IDEA_MODES,
  CaptionIdeaError,
  generateCaptionIdeas,
} from '../services/caption-ideas.js';
import {
  completeCaptionIdeaRequest,
  findCompletedCaptionIdeaRequest,
  getCaptionIdeaStatus,
  listCaptionIdeaHistory,
} from '../services/caption-idea-store.js';

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function featureEnabled(req, res, next) {
  if (process.env.CAPTION_IDEAS_ENABLED === 'false') {
    return res.status(503).json({ error: '자막 아이디어 기능을 잠시 점검 중입니다.' });
  }
  next();
}

function ideaResponse({ requestId, ideas, status, creditsCharged, alreadyCompleted }) {
  return {
    requestId,
    ideas,
    creditsRemaining: status.credits,
    remainingUses: status.remainingUses,
    creditsCharged,
    alreadyCompleted,
  };
}

function hasRecoverableIdeas(request) {
  const expiresAt = Date.parse(request?.ideas_expires_at || '');
  return Boolean(request?.ideas) && Number.isFinite(expiresAt) && expiresAt > Date.now();
}

router.get('/status', featureEnabled, authMiddleware, async (req, res) => {
  try {
    const status = await getCaptionIdeaStatus(req.user.id, req.user.credits);
    return res.json(status);
  } catch (error) {
    console.error('[caption_ideas.status_failed]', JSON.stringify({
      requestId: req.requestId,
      userId: req.user.id,
      message: error.message,
    }));
    return res.status(503).json({ error: '자막 아이디어 사용 정보를 확인하지 못했습니다.' });
  }
});

router.get('/history', featureEnabled, authMiddleware, async (req, res) => {
  const page = Number(req.query.page || 1);
  const limit = Number(req.query.limit || 20);

  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    return res.status(400).json({ error: '조회 범위가 올바르지 않습니다.' });
  }

  try {
    const history = await listCaptionIdeaHistory(req.user.id, { page, limit });
    return res.json({
      ...history,
      page,
      limit,
      retentionDays: 90,
    });
  } catch (error) {
    console.error('[caption_ideas.history_failed]', JSON.stringify({
      requestId: req.requestId,
      userId: req.user.id,
      message: error.message,
    }));
    return res.status(503).json({ error: '자막 아이디어 내역을 확인하지 못했습니다.' });
  }
});

router.post('/', featureEnabled, authMiddleware, async (req, res) => {
  const requestId = typeof req.body?.requestId === 'string' ? req.body.requestId.trim() : '';
  const mode = typeof req.body?.mode === 'string' ? req.body.mode.trim() : '';
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';

  if (!UUID_PATTERN.test(requestId)) {
    return res.status(400).json({ error: '요청 식별값이 올바르지 않습니다.' });
  }
  if (!CAPTION_IDEA_MODES[mode]) {
    return res.status(400).json({ error: '자막 유형을 선택해주세요.' });
  }
  if (!text || Array.from(text).length > 500 || /[\u0000\u000b\u000c\u007f]/.test(text)) {
    return res.status(400).json({ error: '장면 또는 대사를 500자 이내로 입력해주세요.' });
  }

  try {
    const existing = await findCompletedCaptionIdeaRequest(requestId, req.user.id);
    if (hasRecoverableIdeas(existing)) {
      const status = await getCaptionIdeaStatus(req.user.id);
      return res.json(ideaResponse({
        requestId,
        ideas: existing.ideas,
        status,
        creditsCharged: existing.credits_charged,
        alreadyCompleted: true,
      }));
    }
    if (existing) {
      return res.status(409).json({
        error: '이 요청의 복구 가능 시간이 지났습니다. 다시 생성해주세요.',
        code: 'REQUEST_EXPIRED',
      });
    }

    const before = await getCaptionIdeaStatus(req.user.id, req.user.credits);
    if (before.remainingUses === 0 && before.credits < 1) {
      return res.status(402).json({
        error: '변환 가능 시간이 부족합니다.',
        creditsHave: before.credits,
        creditsNeeded: 1,
        remainingUses: 0,
      });
    }

    const generation = await generateCaptionIdeas(text, mode);
    const result = await completeCaptionIdeaRequest({
      requestId,
      userId: req.user.id,
      mode,
      generation,
    });
    const status = {
      credits: Number(result.credits),
      remainingUses: Number(result.remaining_uses),
    };

    console.log('[caption_ideas.timing]', JSON.stringify({
      requestId: req.requestId,
      ideaRequestId: requestId,
      outcome: result.already_completed ? 'idempotent_replay' : 'success',
      mode,
      model: generation.model,
      attempts: generation.attempts,
      durationMs: generation.durationMs,
      promptTokens: generation.usage.promptTokens,
      cachedTokens: generation.usage.cachedTokens,
      completionTokens: generation.usage.completionTokens,
      estimatedCostUsd: generation.estimatedCostUsd,
      creditsCharged: Number(result.credits_charged),
      remainingUses: status.remainingUses,
    }));

    return res.json(ideaResponse({
      requestId,
      ideas: result.ideas,
      status,
      creditsCharged: Number(result.credits_charged),
      alreadyCompleted: Boolean(result.already_completed),
    }));
  } catch (error) {
    const knownError = error instanceof CaptionIdeaError;
    const status = knownError
      ? error.status
      : error.code === 'CI002'
        ? 402
        : ['CI004', 'CI005'].includes(error.code)
          ? 409
          : 503;
    const message = knownError
      ? error.message
      : error.code === 'CI002'
        ? '변환 가능 시간이 부족합니다.'
        : error.code === 'CI004'
          ? '이 요청의 복구 가능 시간이 지났습니다. 다시 생성해주세요.'
          : error.code === 'CI005'
            ? '이미 사용된 요청입니다. 다시 생성해주세요.'
            : '자막 아이디어를 만들지 못했습니다. 잠시 후 다시 시도해주세요.';

    console[status >= 500 ? 'error' : 'warn']('[caption_ideas.failed]', JSON.stringify({
      requestId: req.requestId,
      ideaRequestId: requestId,
      userId: req.user.id,
      code: error.code || error.name || 'unknown',
      status,
    }));
    return res.status(status).json({ error: message, code: error.code, requestId: req.requestId });
  }
});

export default router;
