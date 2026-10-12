import assert from 'node:assert/strict';
import test from 'node:test';

const {
  getWelcomeCreditConfig,
  verifyWelcomeTurnstile,
  WELCOME_TURNSTILE_ACTION,
} = await import('../src/services/turnstile.js');

const CONFIG = {
  ready: true,
  siteKey: 'public-site-key',
  secretKey: 'private-secret-key',
  hostname: 'pr-text.com',
};
const NOW = Date.parse('2026-10-12T01:00:00.000Z');

function response(overrides = {}) {
  return {
    success: true,
    hostname: 'pr-text.com',
    action: WELCOME_TURNSTILE_ACTION,
    cdata: 'challenge-nonce',
    challenge_ts: new Date(NOW - 30_000).toISOString(),
    ...overrides,
  };
}

test('welcome grant configuration fails closed until proxy trust and all validation keys are ready', () => {
  const complete = {
    APP_URL: 'https://pr-text.com/',
    WELCOME_CREDIT_TRUSTED_PROXY_IP: 'true',
    WELCOME_CREDIT_SECURITY_HMAC_KEY: 'dedicated-key',
    TURNSTILE_SITE_KEY: 'site-key',
    TURNSTILE_SECRET_KEY: 'secret-key',
  };
  assert.deepEqual(getWelcomeCreditConfig(complete), {
    ready: true,
    siteKey: 'site-key',
    secretKey: 'secret-key',
    hostname: 'pr-text.com',
  });
  for (const key of Object.keys(complete)) {
    const missing = { ...complete };
    delete missing[key];
    assert.equal(getWelcomeCreditConfig(missing).ready, false, `${key} must be required`);
  }
});

test('sends Turnstile token to Siteverify and accepts only fresh user-bound results', async () => {
  const calls = [];
  const valid = await verifyWelcomeTurnstile({
    token: 'opaque-token',
    nonce: 'challenge-nonce',
    config: CONFIG,
    now: NOW,
    fetchImpl: async (url, options) => {
      calls.push({ url, options, fields: new URLSearchParams(options.body) });
      return { ok: true, json: async () => response() };
    },
  });

  assert.equal(valid, true);
  assert.equal(calls[0].url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].fields.get('secret'), CONFIG.secretKey);
  assert.equal(calls[0].fields.get('response'), 'opaque-token');
});

test('rejects wrong hostname, action, challenge binding, and stale/future tokens', async () => {
  for (const result of [
    response({ hostname: 'attacker.example' }),
    response({ action: 'signup' }),
    response({ cdata: 'another-user-nonce' }),
    response({ challenge_ts: new Date(NOW - 6 * 60_000).toISOString() }),
    response({ challenge_ts: new Date(NOW + 31_000).toISOString() }),
    response({ success: false }),
  ]) {
    const valid = await verifyWelcomeTurnstile({
      token: 'opaque-token', nonce: 'challenge-nonce', config: CONFIG, now: NOW,
      fetchImpl: async () => ({ ok: true, json: async () => result }),
    });
    assert.equal(valid, false);
  }
});

test('rejects oversized or missing tokens without contacting Siteverify', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  assert.equal(await verifyWelcomeTurnstile({ token: '', nonce: 'n', config: CONFIG, fetchImpl }), false);
  assert.equal(await verifyWelcomeTurnstile({ token: 'x'.repeat(2049), nonce: 'n', config: CONFIG, fetchImpl }), false);
  assert.equal(called, false);
});

test('does not treat unavailable Siteverify as a failed user challenge', async () => {
  await assert.rejects(
    verifyWelcomeTurnstile({
      token: 'opaque-token', nonce: 'challenge-nonce', config: CONFIG,
      fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
    }),
    /연결하지 못했습니다/,
  );
});
