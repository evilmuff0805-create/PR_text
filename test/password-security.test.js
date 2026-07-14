import assert from 'node:assert/strict';
import test from 'node:test';

import {
  changePasswordWithCurrentPassword,
  MIN_PASSWORD_LENGTH,
  PasswordChangeError,
  userHasPasswordIdentity,
  validateNewPassword,
} from '../src/services/password-security.js';

function createAuthClient({
  signInError = null,
  signedInUserId = 'user-1',
  updateError = null,
  signOutError = null,
} = {}) {
  const calls = [];
  return {
    calls,
    client: {
      auth: {
        async signInWithPassword(credentials) {
          calls.push({ method: 'signInWithPassword', credentials });
          if (signInError) return { data: { session: null, user: null }, error: signInError };
          return {
            data: {
              session: { access_token: 'fresh-access-token' },
              user: { id: signedInUserId },
            },
            error: null,
          };
        },
        async updateUser(attributes) {
          calls.push({ method: 'updateUser', attributes });
          return { data: { user: { id: signedInUserId } }, error: updateError };
        },
        async signOut(options) {
          calls.push({ method: 'signOut', options });
          return { error: signOutError };
        },
      },
    },
  };
}

const validRequest = {
  email: 'user@example.com',
  userId: 'user-1',
  currentPassword: 'old-password',
  newPassword: 'new-password',
};

test('requires at least eight characters for new passwords', () => {
  assert.equal(MIN_PASSWORD_LENGTH, 8);
  assert.match(validateNewPassword('1234567'), /8자 이상/);
  assert.equal(validateNewPassword('12345678'), null);
});

test('shows password controls only to accounts with an email identity', () => {
  assert.equal(userHasPasswordIdentity({ app_metadata: { providers: ['email'] } }), true);
  assert.equal(userHasPasswordIdentity({ app_metadata: { providers: ['google', 'email'] } }), true);
  assert.equal(userHasPasswordIdentity({ app_metadata: { providers: ['google'] } }), false);
  assert.equal(userHasPasswordIdentity({}), true);
});

test('rejects a missing current password before contacting Supabase', async () => {
  const { client, calls } = createAuthClient();

  await assert.rejects(
    changePasswordWithCurrentPassword({ ...validRequest, authClient: client, currentPassword: '' }),
    (error) => error instanceof PasswordChangeError
      && error.code === 'CURRENT_PASSWORD_REQUIRED'
      && error.status === 400,
  );
  assert.equal(calls.length, 0);
});

test('rejects reuse of the current password before contacting Supabase', async () => {
  const { client, calls } = createAuthClient();

  await assert.rejects(
    changePasswordWithCurrentPassword({
      ...validRequest,
      authClient: client,
      newPassword: validRequest.currentPassword,
    }),
    (error) => error.code === 'PASSWORD_UNCHANGED',
  );
  assert.equal(calls.length, 0);
});

test('rejects an incorrect current password without attempting an update', async () => {
  const { client, calls } = createAuthClient({ signInError: { code: 'invalid_credentials' } });

  await assert.rejects(
    changePasswordWithCurrentPassword({ ...validRequest, authClient: client }),
    (error) => error.code === 'CURRENT_PASSWORD_INVALID' && error.status === 401,
  );
  assert.deepEqual(calls.map((call) => call.method), ['signInWithPassword']);
});

test('rejects a reauthenticated identity that does not match the bearer token user', async () => {
  const { client, calls } = createAuthClient({ signedInUserId: 'different-user' });

  await assert.rejects(
    changePasswordWithCurrentPassword({ ...validRequest, authClient: client }),
    (error) => error.code === 'CURRENT_PASSWORD_INVALID',
  );
  assert.deepEqual(calls.map((call) => call.method), ['signInWithPassword']);
});

test('updates through the verified user session and requests cleanup of other sessions', async () => {
  const { client, calls } = createAuthClient();

  const result = await changePasswordWithCurrentPassword({ ...validRequest, authClient: client });

  assert.equal(result.accessToken, 'fresh-access-token');
  assert.equal(result.sessionCleanupError, null);
  assert.deepEqual(calls, [
    {
      method: 'signInWithPassword',
      credentials: { email: validRequest.email, password: validRequest.currentPassword },
    },
    {
      method: 'updateUser',
      attributes: {
        password: validRequest.newPassword,
        current_password: validRequest.currentPassword,
      },
    },
    { method: 'signOut', options: { scope: 'others' } },
  ]);
});

test('returns a safe error when Supabase rejects the password update', async () => {
  const { client, calls } = createAuthClient({
    updateError: { code: 'provider_internal_error', message: 'sensitive provider detail' },
  });

  await assert.rejects(
    changePasswordWithCurrentPassword({ ...validRequest, authClient: client }),
    (error) => error.code === 'PASSWORD_UPDATE_REJECTED'
      && !error.message.includes('sensitive provider detail'),
  );
  assert.deepEqual(calls.map((call) => call.method), ['signInWithPassword', 'updateUser']);
});
