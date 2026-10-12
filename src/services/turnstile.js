const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const WELCOME_TURNSTILE_ACTION = 'welcome_credit';
export const TURNSTILE_TOKEN_MAX_AGE_MS = 5 * 60 * 1000;

export function getWelcomeCreditConfig(env = process.env) {
  let hostname = null;
  try {
    hostname = new URL(env.APP_URL || '').hostname.toLowerCase();
  } catch {
    // A missing or invalid app URL must not weaken challenge validation.
  }

  const ready = env.WELCOME_CREDIT_TRUSTED_PROXY_IP === 'true'
    && Boolean(env.WELCOME_CREDIT_SECURITY_HMAC_KEY)
    && Boolean(env.TURNSTILE_SITE_KEY)
    && Boolean(env.TURNSTILE_SECRET_KEY)
    && Boolean(hostname);

  return {
    ready,
    siteKey: ready ? env.TURNSTILE_SITE_KEY : null,
    secretKey: ready ? env.TURNSTILE_SECRET_KEY : null,
    hostname,
  };
}

export async function verifyWelcomeTurnstile({
  token,
  nonce,
  config = getWelcomeCreditConfig(),
  fetchImpl = fetch,
  now = Date.now(),
}) {
  if (!config.ready) throw new Error('무료 체험 확인 설정이 완료되지 않았습니다.');
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048 || !nonce) return false;

  const body = new URLSearchParams({
    secret: config.secretKey,
    response: token,
  });

  const response = await fetchImpl(SITEVERIFY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error('무료 체험 확인 서버에 연결하지 못했습니다.');

  const result = await response.json();
  if (result?.success !== true) return false;
  if (String(result.hostname || '').toLowerCase() !== config.hostname) return false;
  if (result.action !== WELCOME_TURNSTILE_ACTION || result.cdata !== nonce) return false;

  const challengeTime = Date.parse(result.challenge_ts || '');
  const age = now - challengeTime;
  return Number.isFinite(challengeTime)
    && age >= -30_000
    && age <= TURNSTILE_TOKEN_MAX_AGE_MS;
}
