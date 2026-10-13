import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-key';

const {
  createWelcomeCreditStore,
  getWelcomeCreditMode,
  getWelcomeIdentityHashes,
  hashWelcomeIdentity,
} = await import('../src/services/welcome-credits.js');

const USER = {
  id: '715ed5db-f090-4b8c-a067-640ecee36aa0',
  email: 'User@Example.com',
  identities: [
    { provider: 'email', provider_id: 'local-user-id' },
    { provider: 'google', provider_id: 'google-account-123' },
  ],
};

test('creates stable non-reversible markers for email and Google identities', () => {
  const hashes = getWelcomeIdentityHashes(USER, 'dedicated-test-secret');
  assert.equal(hashes.length, 2);
  assert.equal(new Set(hashes).size, 2);
  for (const hash of hashes) {
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(hash.includes('example.com'), false);
    assert.equal(hash.includes('google-account-123'), false);
  }

  assert.deepEqual(
    getWelcomeIdentityHashes({ ...USER, email: ' user@example.com ' }, 'dedicated-test-secret'),
    hashes,
  );
  assert.notEqual(
    hashWelcomeIdentity('email', 'user@example.com', 'secret-a'),
    hashWelcomeIdentity('email', 'user@example.com', 'secret-b'),
  );
});

test('calls only service-role RPCs to create profiles and retain claims', async () => {
  const calls = [];
  const database = {
    async rpc(name, params) {
      calls.push([name, params]);
      if (name === 'ensure_welcome_credit_profile') {
        return {
          data: [{ credits: 0, plan: 'free', welcome_credit_granted: false }],
          error: null,
        };
      }
      if (name === 'claim_welcome_credit_identity') {
        return { data: [{ status: 'granted', credits: 10 }], error: null };
      }
      return { data: 2, error: null };
    },
  };
  const store = createWelcomeCreditStore(database);
  const identityHashes = ['a'.repeat(64), 'b'.repeat(64)];

  const profile = await store.ensureProfile(USER, identityHashes);
  const recorded = await store.recordClaims(identityHashes);
  const claimed = await store.claimIdentity({ ...USER, emailConfirmed: true }, identityHashes);

  assert.equal(profile.credits, 0);
  assert.equal(profile.welcome_credit_granted, false);
  assert.equal(recorded, 2);
  assert.deepEqual(claimed, { status: 'granted', credits: 10 });
  assert.deepEqual(calls, [
    ['ensure_welcome_credit_profile', {
      p_user_id: USER.id,
      p_email: USER.email,
      p_identity_hashes: identityHashes,
    }],
    ['register_welcome_credit_claims', { p_identity_hashes: identityHashes }],
    ['claim_welcome_credit_identity', {
      p_user_id: USER.id,
      p_identity_hashes: identityHashes,
      p_email_confirmed: true,
    }],
  ]);
});

test('identity is the safe default and guarded mode requires an explicit setting', () => {
  assert.equal(getWelcomeCreditMode({}), 'identity');
  assert.equal(getWelcomeCreditMode({ WELCOME_CREDIT_MODE: 'identity' }), 'identity');
  assert.equal(getWelcomeCreditMode({ WELCOME_CREDIT_MODE: 'guarded' }), 'guarded');
  assert.equal(getWelcomeCreditMode({ WELCOME_CREDIT_MODE: 'ip' }), 'ip');
  assert.equal(getWelcomeCreditMode({ WELCOME_CREDIT_MODE: 'typo' }), 'disabled');
});

test('IP mode and status call only the service-role RPCs with HMAC values', async (t) => {
  const previousKey = process.env.WELCOME_CREDIT_SECURITY_HMAC_KEY;
  process.env.WELCOME_CREDIT_SECURITY_HMAC_KEY = 'dedicated-hmac-key-at-least-32-bytes-long';
  t.after(() => {
    if (previousKey === undefined) delete process.env.WELCOME_CREDIT_SECURITY_HMAC_KEY;
    else process.env.WELCOME_CREDIT_SECURITY_HMAC_KEY = previousKey;
  });
  const calls = [];
  const database = {
    async rpc(name, params) {
      calls.push([name, params]);
      if (name === 'get_welcome_credit_ip_status') {
        return { data: [{ status: 'ready', retry_at: null }], error: null };
      }
      return { data: [{ status: 'granted', credits: 10, retry_at: null }], error: null };
    },
  };
  const store = createWelcomeCreditStore(database);
  const ipHash = 'a'.repeat(64);
  assert.deepEqual(await store.getIpLimit(ipHash), { status: 'ready', retry_at: null });
  assert.deepEqual(await store.claimIp({ ...USER, emailConfirmed: true }, ipHash, ['b'.repeat(64)]), {
    status: 'granted', credits: 10, retry_at: null,
  });
  assert.deepEqual(calls[0], ['get_welcome_credit_ip_status', { p_ip_hash: ipHash }]);
  assert.deepEqual({ ...calls[1][1], p_account_hash: 'hash' }, {
    p_user_id: USER.id,
    p_identity_hashes: ['b'.repeat(64)],
    p_email_confirmed: true,
    p_ip_hash: ipHash,
    p_account_hash: 'hash',
  });
  assert.match(calls[1][1].p_account_hash, /^[0-9a-f]{64}$/);
});

test('removes both direct 10-credit profile creation paths', async () => {
  const [middleware, authRoutes, settings, terms, privacy, authModal] = await Promise.all([
    readFile(new URL('../src/middleware/auth.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/auth.js', import.meta.url), 'utf8'),
    readFile(new URL('../client/src/pages/SettingsPage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../client/src/pages/TermsPage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../client/src/pages/PrivacyPage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../client/src/components/AuthModal.jsx', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(middleware, /credits:\s*10/);
  assert.doesNotMatch(authRoutes, /credits:\s*10/);
  assert.match(middleware, /welcomeCreditStore\.ensureProfile/);
  assert.match(authRoutes, /welcomeCreditStore\.ensureProfile/);
  assert.match(settings, /아직 지급되지 않은 무료 10분 자격도 종료됩니다/);
  assert.match(terms, /같은 네트워크의 추가 무료 지급은 24시간 제한될 수/);
  assert.match(privacy, /IP·계정 HMAC 식별값/);
  assert.match(authModal, /같은 네트워크의 추가 무료 지급은 24시간 제한될 수 있으며/);
  assert.match(authRoutes, /welcomeCreditStore\.claimIdentity\(req\.user\)/);
  assert.match(authRoutes, /welcomeMode === 'identity'/);
  assert.match(authRoutes, /welcomeMode === 'ip'/);
  assert.doesNotMatch(middleware, /claimIdentity\(/);
});
