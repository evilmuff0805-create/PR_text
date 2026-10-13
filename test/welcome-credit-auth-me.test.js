import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';

process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-key';

const { default: authRouter } = await import('../src/routes/auth.js');
const { supabase, supabaseAdmin } = await import('../src/lib/supabase.js');
const { welcomeCreditStore } = await import('../src/services/welcome-credits.js');
const { creditLedgerStore } = await import('../src/services/credit-ledger.js');

async function withAuthRoute(t, { mode = 'identity', claimError = null, emailConfirmed = true } = {}) {
  const previousMode = process.env.WELCOME_CREDIT_MODE;
  process.env.WELCOME_CREDIT_MODE = mode;
  t.after(() => {
    if (previousMode === undefined) delete process.env.WELCOME_CREDIT_MODE;
    else process.env.WELCOME_CREDIT_MODE = previousMode;
  });

  const claims = [];
  t.mock.method(supabase.auth, 'getUser', async () => ({
    data: { user: {
      id: 'b5050d14-25a5-4f4d-a512-cb4e331d5f19',
      email: 'verified@example.test',
      email_confirmed_at: emailConfirmed ? '2026-10-13T00:00:00Z' : null,
      identities: [{ provider: 'email', provider_id: 'email-id' }],
    } },
    error: null,
  }));
  t.mock.method(supabase.auth, 'signOut', async () => ({ error: null }));
  t.mock.method(supabaseAdmin, 'from', (table) => {
    const builder = {
      select() { return this; },
      eq() { return this; },
      order() { return this; },
      limit() { return this; },
      async maybeSingle() {
        return { data: table === 'profiles' ? { credits: 3, plan: 'free' } : null, error: null };
      },
      then(resolve, reject) { return Promise.resolve({ data: [], error: null }).then(resolve, reject); },
    };
    return builder;
  });
  t.mock.method(creditLedgerStore, 'expireForUser', async () => ({ discrepancy: false, credits_remaining: 3 }));
  t.mock.method(welcomeCreditStore, 'claimIdentity', async (user) => {
    claims.push(user.id);
    if (claimError) throw claimError;
    return { status: 'granted', credits: 13 };
  });

  const app = express();
  app.use('/api/auth', authRouter);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.close(); await once(server, 'close'); });
  const request = (path, options = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/auth${path}`, {
    ...options,
    headers: { Authorization: 'Bearer fixture-token', ...options.headers },
  });
  return { claims, request };
}

test('/me auto-claims once and returns the updated balance in identity mode', async (t) => {
  const route = await withAuthRoute(t);
  const response = await route.request('/me');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).credits, 13);
  assert.deepEqual(route.claims, ['b5050d14-25a5-4f4d-a512-cb4e331d5f19']);
});

test('/me keeps login available and preserves the current balance if the free grant fails', async (t) => {
  const route = await withAuthRoute(t, { claimError: Object.assign(new Error('offline'), { code: 'ECONNRESET' }) });
  const response = await route.request('/me');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).credits, 3);
});

test('unconfirmed accounts retain login but do not receive an automatic welcome grant', async (t) => {
  const route = await withAuthRoute(t, { emailConfirmed: false });
  const response = await route.request('/me');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).credits, 3);
  assert.deepEqual(route.claims, []);
});

test('identity auto-claim does not run on unrelated authenticated endpoints', async (t) => {
  const identityRoute = await withAuthRoute(t);
  const logout = await identityRoute.request('/logout', { method: 'POST' });
  assert.equal(logout.status, 200);
  assert.deepEqual(identityRoute.claims, []);
});

test('identity auto-claim is disabled in explicitly guarded mode', async (t) => {
  const route = await withAuthRoute(t, { mode: 'guarded' });
  const response = await route.request('/me');
  assert.equal(response.status, 200);
  assert.deepEqual(route.claims, []);
});

test('an invalid mode keeps authentication available and does not auto-claim', async (t) => {
  const route = await withAuthRoute(t, { mode: 'invalid' });
  const response = await route.request('/me');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).credits, 3);
  assert.deepEqual(route.claims, []);
});
