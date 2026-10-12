import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { getWelcomeAbuseHashes } from '../services/welcome-ip.js';
import { verifyWelcomeTurnstile, getWelcomeCreditConfig } from '../services/turnstile.js';
import { welcomeCreditStore } from '../services/welcome-credits.js';

const ERROR_UNAVAILABLE = '무료 체험 지급을 지금 확인할 수 없습니다. 잠시 후 다시 시도해주세요.';

function retryAtValue(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function challengePayload(prepared, config) {
  return {
    status: 'challenge_required',
    challenge: {
      siteKey: config.siteKey,
      nonce: prepared.challenge_nonce,
      action: 'welcome_credit',
    },
  };
}

function isEligibleReason(reason) {
  return reason === 'ready' || reason === 'ip_limit';
}

export function createWelcomeCreditRouter({
  auth = authMiddleware,
  store = welcomeCreditStore,
  configProvider = getWelcomeCreditConfig,
  verifyChallenge = verifyWelcomeTurnstile,
  abuseHashes = getWelcomeAbuseHashes,
} = {}) {
  const router = Router();

  async function prepare(req, config) {
    const hashes = abuseHashes(req.ip, req.user.id);
    const result = await store.prepareClaim(req.user.id, hashes);
    return { hashes, result, config };
  }

  function unavailable(req, error) {
    console.error('[welcome_credit.unavailable]', JSON.stringify({
      requestId: req.requestId,
      userId: req.user.id,
      code: error?.code || 'WELCOME_CREDIT_UNAVAILABLE',
    }));
    return {
      error: ERROR_UNAVAILABLE,
      code: 'WELCOME_CREDIT_UNAVAILABLE',
      retryable: true,
    };
  }

  router.get('/', auth, async (req, res) => {
    if (!req.user.emailConfirmed) {
      return res.status(403).json({ status: 'email_unconfirmed', error: '이메일 인증을 완료한 뒤 무료 시간을 받을 수 있습니다.' });
    }

    try {
      const eligibility = await store.getEligibility(req.user.id);
      if (!eligibility || eligibility.granted_at) return res.json({ status: 'not_eligible' });
    } catch (error) {
      return res.status(503).json(unavailable(req, error));
    }

    const config = configProvider();
    if (!config.ready) return res.status(503).json(unavailable(req));

    try {
      const { result } = await prepare(req, config);
      if (result.reason === 'not_eligible') return res.json({ status: 'not_eligible' });
      if (result.reason === 'already_granted') return res.json({ status: 'granted' });
      if (!isEligibleReason(result.reason)) return res.status(503).json(unavailable(req));
      if (result.reason === 'ip_limit') {
        return res.json({ status: 'ip_limit', retryAt: retryAtValue(result.retry_at) });
      }
      if (result.challenge_required) return res.json(challengePayload(result, config));
      return res.json({ status: 'eligible' });
    } catch (error) {
      return res.status(503).json(unavailable(req, error));
    }
  });

  router.post('/', auth, async (req, res) => {
    if (!req.user.emailConfirmed) {
      return res.status(403).json({ status: 'email_unconfirmed', error: '이메일 인증을 완료한 뒤 무료 시간을 받을 수 있습니다.' });
    }

    try {
      const eligibility = await store.getEligibility(req.user.id);
      if (!eligibility) return res.status(409).json({ status: 'not_eligible' });
      if (eligibility.granted_at) {
        return res.json({ status: 'granted', credits: await store.getCredits(req.user.id), alreadyGranted: true });
      }
    } catch (error) {
      return res.status(503).json(unavailable(req, error));
    }

    const config = configProvider();
    if (!config.ready) return res.status(503).json(unavailable(req));

    try {
      const { hashes, result: prepared } = await prepare(req, config);
      if (prepared.reason === 'not_eligible') return res.status(409).json({ status: 'not_eligible' });
      if (prepared.reason === 'already_granted') return res.json({ status: 'granted', alreadyGranted: true });
      if (!isEligibleReason(prepared.reason)) return res.status(503).json(unavailable(req));
      if (prepared.reason === 'ip_limit') {
        return res.status(429).json({ status: 'ip_limit', retryAt: retryAtValue(prepared.retry_at) });
      }

      let challengeNonce = null;
      let turnstileValid = false;
      if (prepared.challenge_required) {
        challengeNonce = String(prepared.challenge_nonce || '');
        if (!challengeNonce || req.body?.challengeNonce !== challengeNonce || !req.body?.turnstileToken) {
          return res.status(428).json(challengePayload(prepared, config));
        }

        turnstileValid = await verifyChallenge({
          token: req.body.turnstileToken,
          nonce: challengeNonce,
          config,
        });
        if (!turnstileValid) {
          return res.status(400).json({ status: 'challenge_invalid', error: '추가 확인을 완료한 뒤 다시 시도해주세요.' });
        }
      }

      const claimed = await store.claim(req.user, {
        ...hashes,
        challengeNonce,
        turnstileValid,
      });

      if (claimed.status === 'granted') {
        return res.json({ status: 'granted', credits: claimed.credits });
      }
      if (claimed.status === 'already_granted') {
        return res.json({ status: 'granted', credits: claimed.credits, alreadyGranted: true });
      }
      if (claimed.status === 'ip_limit') {
        return res.status(429).json({ status: 'ip_limit', retryAt: retryAtValue(claimed.retry_at) });
      }
      if (claimed.status === 'challenge_required') {
        const fresh = await store.prepareClaim(req.user.id, hashes);
        if (fresh.challenge_required && fresh.challenge_nonce) {
          return res.status(428).json(challengePayload(fresh, config));
        }
        return res.status(503).json(unavailable(req));
      }
      if (['not_eligible', 'identity_claimed'].includes(claimed.status)) {
        return res.status(409).json({ status: 'not_eligible' });
      }
      if (claimed.status === 'attempt_required') {
        return res.status(409).json({ status: 'retry_required', error: '무료 시간 확인을 다시 시작해주세요.' });
      }

      return res.status(503).json(unavailable(req));
    } catch (error) {
      return res.status(503).json(unavailable(req, error));
    }
  });

  return router;
}

export default createWelcomeCreditRouter();
