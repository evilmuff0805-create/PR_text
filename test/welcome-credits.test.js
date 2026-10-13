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
  assert.equal(getWelcomeCreditMode({ WELCOME_CREDIT_MODE: 'typo' }), 'disabled');
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
  assert.match(terms, /동일 로그인 계정 기준으로 최초 1회 자동/);
  assert.match(privacy, /IP·계정 HMAC 식별값/);
  assert.match(authModal, /이메일 인증 후 로그인하면 동일 로그인 계정에 무료 10분이 1회 자동 지급됩니다/);
  assert.match(authRoutes, /welcomeCreditStore\.claimIdentity\(req\.user\)/);
  assert.match(authRoutes, /getWelcomeCreditMode\(\) === 'identity'/);
  assert.doesNotMatch(middleware, /claimIdentity\(/);
});
