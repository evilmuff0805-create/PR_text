import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-key';

const {
  createWelcomeCreditStore,
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
          data: [{ credits: 10, plan: 'free', welcome_credit_granted: true }],
          error: null,
        };
      }
      return { data: 2, error: null };
    },
  };
  const store = createWelcomeCreditStore(database);
  const identityHashes = ['a'.repeat(64), 'b'.repeat(64)];

  const profile = await store.ensureProfile(USER, identityHashes);
  const recorded = await store.recordClaims(identityHashes);

  assert.equal(profile.credits, 10);
  assert.equal(profile.welcome_credit_granted, true);
  assert.equal(recorded, 2);
  assert.deepEqual(calls, [
    ['ensure_welcome_credit_profile', {
      p_user_id: USER.id,
      p_email: USER.email,
      p_identity_hashes: identityHashes,
    }],
    ['register_welcome_credit_claims', { p_identity_hashes: identityHashes }],
  ]);
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
  assert.match(settings, /신규 가입 무료 10분은 다시 지급되지 않습니다/);
  assert.match(terms, /동일 로그인 계정에 최초 1회만 지급/);
  assert.match(privacy, /서버 HMAC 식별값/);
  assert.match(authModal, /신규 무료 10분은 동일 로그인 계정에 최초 1회만 지급/);
});
