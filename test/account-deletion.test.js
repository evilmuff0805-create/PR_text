import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';

process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-key';

const {
  AccountDeletionError,
  hashAccountIdentity,
  isRecentLogin,
  removeAccountAudio,
  toAccountDeletionPreview,
  verifyAccountDeletionIdentity,
} = await import('../src/services/account-deletion.js');
const { createAccountRouter } = await import('../src/routes/account.js');

const NOW = Date.parse('2026-07-16T03:00:00.000Z');
const USER = {
  id: '715ed5db-f090-4b8c-a067-640ecee36aa0',
  email: 'user@example.com',
  canChangePassword: true,
  lastSignInAt: '2026-07-16T02:55:00.000Z',
  token: 'access-token',
};

const FREE_PREVIEW = {
  credits: 10,
  active_job_count: 0,
  pending_order_count: 0,
  open_paid_order_count: 0,
  unresolved_refund_count: 0,
  can_delete: true,
  credit_disposition: 'free_forfeit',
  blocker_reason: null,
};

function auth(req, res, next) {
  req.user = USER;
  next();
}

async function request(router, body) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('hashes account identifiers without retaining the raw user id', () => {
  const hash = hashAccountIdentity(USER.id);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash.includes(USER.id), false);
  assert.equal(hashAccountIdentity(USER.id), hash);
});

test('allows only free-credit forfeiture and blocks ambiguous paid balances', () => {
  const free = toAccountDeletionPreview(FREE_PREVIEW, USER, NOW);
  assert.equal(free.canDelete, true);
  assert.equal(free.creditDisposition, 'free_forfeit');
  assert.equal(free.credits, 10);

  const paid = toAccountDeletionPreview({
    ...FREE_PREVIEW,
    can_delete: false,
    open_paid_order_count: 1,
    credit_disposition: 'review_required',
    blocker_reason: 'paid_credit_review',
  }, USER, NOW);
  assert.equal(paid.canDelete, false);
  assert.match(paid.blockerMessage, /환불 가능 여부/);
});

test('requires a recent Google sign-in instead of a password', () => {
  assert.equal(isRecentLogin('2026-07-16T02:55:00.000Z', NOW), true);
  assert.equal(isRecentLogin('2026-07-16T02:30:00.000Z', NOW), false);

  const preview = toAccountDeletionPreview(FREE_PREVIEW, {
    ...USER,
    canChangePassword: false,
    lastSignInAt: '2026-07-16T02:30:00.000Z',
  }, NOW);
  assert.equal(preview.confirmationMethod, 'google');
  assert.equal(preview.requiresRecentLogin, true);
});

test('verifies the current password against the same authenticated user', async () => {
  const calls = [];
  const authClient = {
    auth: {
      async signInWithPassword(credentials) {
        calls.push(credentials);
        return { data: { user: { id: USER.id } }, error: null };
      },
      async signOut(options) {
        calls.push(options);
        return { error: null };
      },
    },
  };

  await verifyAccountDeletionIdentity({
    user: USER,
    confirmationEmail: ' USER@example.com ',
    currentPassword: 'current-password',
    authClient,
    now: NOW,
  });
  assert.deepEqual(calls, [
    { email: USER.email, password: 'current-password' },
    { scope: 'local' },
  ]);
});

test('rejects a stale Google session and a mismatched confirmation email', async () => {
  await assert.rejects(
    verifyAccountDeletionIdentity({
      user: {
        ...USER,
        canChangePassword: false,
        lastSignInAt: '2026-07-16T02:30:00.000Z',
      },
      confirmationEmail: USER.email,
      now: NOW,
    }),
    (error) => error instanceof AccountDeletionError
      && error.code === 'RECENT_LOGIN_REQUIRED'
      && error.status === 403,
  );

  await assert.rejects(
    verifyAccountDeletionIdentity({
      user: USER,
      confirmationEmail: 'other@example.com',
      currentPassword: 'current-password',
      now: NOW,
    }),
    (error) => error.code === 'EMAIL_CONFIRMATION_MISMATCH',
  );
});

test('removes every page of temporary account audio', async () => {
  const removed = [];
  let listCalls = 0;
  const storage = {
    from(bucket) {
      assert.equal(bucket, 'transcription-jobs');
      return {
        async list(prefix) {
          assert.equal(prefix, USER.id);
          listCalls += 1;
          return listCalls === 1
            ? { data: [{ id: 'object-1', name: 'audio.mp3' }], error: null }
            : { data: [], error: null };
        },
        async remove(paths) {
          removed.push(...paths);
          return { error: null };
        },
      };
    },
  };

  await removeAccountAudio(storage, USER.id);
  assert.deepEqual(removed, [`${USER.id}/audio.mp3`]);
});

test('deletes in the safe order after reauthentication', async () => {
  const calls = [];
  const store = {
    async preview() { calls.push('preview'); return FREE_PREVIEW; },
    async begin() {
      calls.push('begin');
      return { deletion_id: 'deletion-1', credits_forfeited: 10 };
    },
    async complete() { calls.push('complete'); },
    async fail() { calls.push('fail'); },
  };
  const storage = {
    from() {
      return {
        async list() { calls.push('storage'); return { data: [], error: null }; },
      };
    },
  };
  const authAdmin = {
    async signOut(token, scope) {
      calls.push(`signout:${token}:${scope}`);
      return { error: null };
    },
    async deleteUser(userId) {
      calls.push(`delete:${userId}`);
      return { error: null };
    },
  };
  const passwordClient = () => ({
    auth: {
      async signInWithPassword() {
        calls.push('reauth');
        return { data: { user: { id: USER.id } }, error: null };
      },
      async signOut(options) {
        calls.push(`reauth-signout:${options.scope}`);
        return { error: null };
      },
    },
  });
  const router = createAccountRouter({
    auth,
    store,
    storage,
    authAdmin,
    passwordClient,
    now: () => NOW,
  });

  const response = await request(router, {
    confirmationEmail: USER.email,
    currentPassword: 'current-password',
  });

  assert.equal(response.status, 200);
  assert.equal(response.data.success, true);
  assert.deepEqual(calls, [
    'preview',
    'reauth',
    'reauth-signout:local',
    'storage',
    'begin',
    'signout:access-token:global',
    `delete:${USER.id}`,
    'complete',
  ]);
});

test('does not mutate account data when payment review blocks deletion', async () => {
  let beginCalls = 0;
  const router = createAccountRouter({
    auth,
    store: {
      async preview() {
        return {
          ...FREE_PREVIEW,
          can_delete: false,
          open_paid_order_count: 1,
          credit_disposition: 'review_required',
          blocker_reason: 'paid_credit_review',
        };
      },
      async begin() { beginCalls += 1; },
    },
    now: () => NOW,
  });

  const response = await request(router, {
    confirmationEmail: USER.email,
    currentPassword: 'current-password',
  });
  assert.equal(response.status, 409);
  assert.equal(response.data.code, 'paid_credit_review');
  assert.equal(beginCalls, 0);
});
