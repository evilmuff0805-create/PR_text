import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';

process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-key';

const { createWelcomeCreditRouter } = await import('../src/routes/welcome-credit.js');

const HASHES = { ipHash: 'a'.repeat(64), accountHash: 'b'.repeat(64) };
const READY_CONFIG = {
  ready: true,
  siteKey: 'site-key',
  secretKey: 'secret-key',
  hostname: 'pr-text.com',
};

async function withRoute(t, {
  eligibility = { user_id: 'user-1', granted_at: null },
  prepared = { eligible: true, challenge_required: false, challenge_nonce: null, retry_at: null, reason: 'ready' },
  claimed = { status: 'granted', credits: 10, retry_at: null },
  ipLimit = { status: 'ready', retry_at: null },
  ipClaimed = { status: 'granted', credits: 10, retry_at: null },
  config = READY_CONFIG,
  verified = true,
  emailConfirmed = true,
  trustProxy = false,
  mode = 'guarded',
} = {}) {
  const calls = [];
  const store = {
    async getEligibility(userId) { calls.push(['eligibility', userId]); return eligibility; },
    async getCredits(userId) { calls.push(['credits', userId]); return 42; },
    async prepareClaim(userId, hashes) { calls.push(['prepare', userId, hashes]); return prepared; },
    async claim(user, args) { calls.push(['claim', user, args]); return claimed; },
    async getIpLimit(ipHash) { calls.push(['ip-limit', ipHash]); return ipLimit; },
    async claimIp(user, ipHash) { calls.push(['claim-ip', user, ipHash]); return ipClaimed; },
  };
  const app = express();
  app.set('trust proxy', trustProxy);
  app.use(express.json());
  app.use('/api/auth/welcome-credit', createWelcomeCreditRouter({
    auth(req, res, next) {
      req.user = {
        id: 'user-1',
        emailConfirmed,
        welcomeIdentityHashes: ['c'.repeat(64)],
      };
      next();
    },
    store,
    configProvider: () => config,
    abuseHashes: (ip, userId) => {
      calls.push(['hashes', ip, userId]);
      return HASHES;
    },
    ipHashProvider: () => ({ ipHash: HASHES.ipHash, source: 'x-real-ip' }),
    verifyChallenge: async (input) => {
      calls.push(['verify', input]);
      return verified;
    },
    modeProvider: () => mode,
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });
  return {
    calls,
    request: (path = '', options = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/auth/welcome-credit${path}`, options),
  };
}

test('hides existing and already-paid accounts before checking feature configuration', async (t) => {
  const old = await withRoute(t, { eligibility: null, config: { ready: false } });
  const oldResponse = await old.request();
  assert.equal(oldResponse.status, 200);
  assert.deepEqual(await oldResponse.json(), { status: 'not_eligible' });
  assert.equal(old.calls.some(([name]) => name === 'prepare'), false);

  const granted = await withRoute(t, {
    eligibility: { user_id: 'user-1', granted_at: '2026-10-01T00:00:00Z' },
    config: { ready: false },
  });
  assert.deepEqual(await (await granted.request()).json(), { status: 'not_eligible' });
});

test('identity mode remains available without IP or Turnstile configuration and retries atomically', async (t) => {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use('/api/auth/welcome-credit', createWelcomeCreditRouter({
    auth(req, res, next) { req.user = { id: 'user-1', emailConfirmed: true, welcomeIdentityHashes: ['c'.repeat(64)] }; next(); },
    store: {
      async getEligibility() { return { user_id: 'user-1', granted_at: null }; },
      async claimIdentity(user) { calls.push(user.id); return { status: 'granted', credits: 18 }; },
    },
    configProvider: () => ({ ready: false }),
    modeProvider: () => 'identity',
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.close(); await once(server, 'close'); });

  const base = `http://127.0.0.1:${server.address().port}/api/auth/welcome-credit`;
  const status = await fetch(base);
  assert.deepEqual(await status.json(), { status: 'eligible' });
  const claim = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.deepEqual(await claim.json(), { status: 'granted', credits: 18 });
  assert.deepEqual(calls, ['user-1']);
});

test('an invalid mode disables only the welcome-credit endpoint', async (t) => {
  const route = await withRoute(t, { mode: 'disabled', config: { ready: false } });
  const response = await route.request();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'WELCOME_CREDIT_UNAVAILABLE');
  assert.equal(route.calls.some(([name]) => ['prepare', 'claim'].includes(name)), false);
});

test('returns the current balance when a successful claim is retried after a lost response', async (t) => {
  const route = await withRoute(t, {
    eligibility: { user_id: 'user-1', granted_at: '2026-10-12T00:00:00Z' },
    config: { ready: false },
  });
  const response = await route.request('', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'granted', credits: 42, alreadyGranted: true });
  assert.equal(route.calls.some(([name]) => name === 'prepare'), false);
});

test('fails only the free-credit endpoint when trusted IP or Turnstile configuration is unavailable', async (t) => {
  const route = await withRoute(t, { config: { ready: false } });
  const response = await route.request();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'WELCOME_CREDIT_UNAVAILABLE');
  assert.equal(route.calls.some(([name]) => name === 'prepare'), false);
});

test('uses Express req.ip and ignores forwarded-IP when no proxy is trusted', async (t) => {
  const route = await withRoute(t);
  const response = await route.request('', { headers: { 'x-forwarded-for': '203.0.113.99' } });
  assert.equal(response.status, 200);
  const hashesCall = route.calls.find(([name]) => name === 'hashes');
  assert.equal(hashesCall[1], '127.0.0.1');
});

test('IP mode reads the 24-hour quota without requiring Turnstile', async (t) => {
  const retryAt = '2026-10-14T12:00:00.000Z';
  const route = await withRoute(t, {
    mode: 'ip',
    config: { ready: false },
    ipLimit: { status: 'ip_limit', retry_at: retryAt },
  });
  const response = await route.request();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ip_limit', retryAt });
  assert.deepEqual(route.calls.find(([name]) => name === 'ip-limit'), ['ip-limit', HASHES.ipHash]);
  assert.equal(route.calls.some(([name]) => ['prepare', 'verify'].includes(name)), false);
});

test('IP mode claim uses the shared IP hash path and does not invoke CAPTCHA', async (t) => {
  const route = await withRoute(t, { mode: 'ip', config: { ready: false } });
  const response = await route.request('', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'granted', credits: 10 });
  assert.equal(route.calls.some(([name]) => name === 'claim-ip'), true);
  assert.equal(route.calls.some(([name]) => ['prepare', 'claim', 'verify'].includes(name)), false);
});

test('IP mode POST returns the rolling retry time when quota has been consumed', async (t) => {
  const retryAt = '2026-10-14T12:00:00.000Z';
  const route = await withRoute(t, {
    mode: 'ip', ipClaimed: { status: 'ip_limit', retry_at: retryAt },
  });
  const response = await route.request('', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { status: 'ip_limit', retryAt });
});

test('fails closed when proxy trust has not been confirmed, even if X-Forwarded-For is supplied', async (t) => {
  const route = await withRoute(t, { config: { ready: false }, trustProxy: 1 });
  const response = await route.request('', { headers: { 'x-forwarded-for': '203.0.113.99' } });
  assert.equal(response.status, 503);
  assert.equal(route.calls.some(([name]) => name === 'hashes'), false);
});

test('requires server-confirmed email before checking or claiming credits', async (t) => {
  const route = await withRoute(t, { emailConfirmed: false });
  const response = await route.request();
  assert.equal(response.status, 403);
  assert.equal((await response.json()).status, 'email_unconfirmed');
  assert.equal(route.calls.length, 0);
});

test('shows an eligible first claim without rendering a challenge', async (t) => {
  const route = await withRoute(t);
  const response = await route.request();
  assert.deepEqual(await response.json(), { status: 'eligible' });
});

test('returns only the user-bound nonce and public site key for repeat accounts', async (t) => {
  const nonce = '39b79cf3-0b75-43de-ae1f-91f7a55a7271';
  const route = await withRoute(t, {
    prepared: { eligible: true, challenge_required: true, challenge_nonce: nonce, retry_at: null, reason: 'ready' },
  });
  const result = await (await route.request()).json();
  assert.deepEqual(result, {
    status: 'challenge_required',
    challenge: { siteKey: 'site-key', nonce, action: 'welcome_credit' },
  });
  assert.equal(JSON.stringify(result).includes(HASHES.ipHash), false);
  assert.equal(JSON.stringify(result).includes(HASHES.accountHash), false);
});

test('validates Turnstile before the atomic claim and returns the updated balance', async (t) => {
  const nonce = '39b79cf3-0b75-43de-ae1f-91f7a55a7271';
  const route = await withRoute(t, {
    prepared: { eligible: true, challenge_required: true, challenge_nonce: nonce, retry_at: null, reason: 'ready' },
  });
  const response = await route.request('', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeNonce: nonce, turnstileToken: 'opaque-token' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'granted', credits: 10 });
  const claim = route.calls.find(([name]) => name === 'claim');
  assert.equal(claim[2].challengeNonce, nonce);
  assert.equal(claim[2].turnstileValid, true);
});

test('denies empty, mismatched, and invalid challenges before granting', async (t) => {
  const nonce = '39b79cf3-0b75-43de-ae1f-91f7a55a7271';
  const route = await withRoute(t, {
    prepared: { eligible: true, challenge_required: true, challenge_nonce: nonce, retry_at: null, reason: 'ready' },
    verified: false,
  });
  const missing = await route.request('', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(missing.status, 428);

  const mismatch = await route.request('', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeNonce: 'another-user', turnstileToken: 'opaque-token' }),
  });
  assert.equal(mismatch.status, 428);

  const invalid = await route.request('', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeNonce: nonce, turnstileToken: 'opaque-token' }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(route.calls.some(([name]) => name === 'claim'), false);
});

test('enforces the rolling limit and returns a retry time even after a valid challenge', async (t) => {
  const retryAt = '2026-10-13T01:00:00.000Z';
  const route = await withRoute(t, {
    prepared: { eligible: true, challenge_required: true, challenge_nonce: '39b79cf3-0b75-43de-ae1f-91f7a55a7271', retry_at: retryAt, reason: 'ip_limit' },
  });
  const response = await route.request('', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { status: 'ip_limit', retryAt });
  assert.equal(route.calls.some(([name]) => name === 'verify'), false);
});

test('requests a challenge if a second account appears between page load and claim', async (t) => {
  const nonce = '39b79cf3-0b75-43de-ae1f-91f7a55a7271';
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use('/api/auth/welcome-credit', createWelcomeCreditRouter({
    auth(req, res, next) { req.user = { id: 'user-1', emailConfirmed: true, welcomeIdentityHashes: ['c'.repeat(64)] }; next(); },
    store: {
      async getEligibility() { return { user_id: 'user-1', granted_at: null }; },
      async prepareClaim() { calls.push('prepare'); return { eligible: true, challenge_required: true, challenge_nonce: nonce, reason: 'ready' }; },
      async claim() { return { status: 'challenge_required' }; },
    },
    configProvider: () => READY_CONFIG,
    abuseHashes: () => HASHES,
    verifyChallenge: async () => true,
    modeProvider: () => 'guarded',
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.close(); await once(server, 'close'); });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/welcome-credit`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeNonce: nonce, turnstileToken: 'token' }),
  });
  assert.equal(response.status, 428);
  assert.deepEqual(await response.json(), {
    status: 'challenge_required',
    challenge: { siteKey: 'site-key', nonce, action: 'welcome_credit' },
  });
  assert.equal(calls.length, 2);
});
