import assert from 'node:assert/strict';
import test from 'node:test';

import {
  changePasswordWithRecoverySession,
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

function createRecoveryAuthClient({
  claims = {
    sub: 'user-1',
    amr: [{ method: 'recovery', timestamp: 123 }],
  },
  claimsError = null,
  sessionError = null,
  sessionUser = {
    id: 'user-1',
    app_metadata: { providers: ['email'] },
  },
  updateError = null,
  signOutError = null,
} = {}) {
  const calls = [];
  return {
    calls,
    client: {
      auth: {
        async getClaims(accessToken) {
          calls.push({ method: 'getClaims', accessToken });
          return claimsError
            ? { data: null, error: claimsError }
            : { data: { claims }, error: null };
        },
        async setSession(session) {
          calls.push({ method: 'setSession', session });
          return sessionError
            ? { data: null, error: sessionError }
            : { data: { session: { access_token: 'verified-token' }, user: sessionUser }, error: null };
        },
        async updateUser(attributes) {
          calls.push({ method: 'updateUser', attributes });
          return { data: { user: sessionUser }, error: updateError };
        },
        async signOut(options) {
          calls.push({ method: 'signOut', options });
          return { error: signOutError };
        },
      },
    },
  };
}

const recoveryRequest = {
  accessToken: 'recovery-access-token',
  refreshToken: 'recovery-refresh-token',
  newPassword: 'new-password',
};

test('accepts only a signed recovery authentication method', async () => {
  const { client, calls } = createRecoveryAuthClient({
    claims: { sub: 'user-1', amr: [{ method: 'password', timestamp: 123 }] },
  });

  await assert.rejects(
    changePasswordWithRecoverySession({ ...recoveryRequest, authClient: client }),
    (error) => error.code === 'RECOVERY_SESSION_INVALID' && error.status === 401,
  );
  assert.deepEqual(calls.map((call) => call.method), ['getClaims']);
});

test('rejects a recovery session whose verified user does not match the token subject', async () => {
  const { client, calls } = createRecoveryAuthClient({
    sessionUser: { id: 'different-user', app_metadata: { providers: ['email'] } },
  });

  await assert.rejects(
    changePasswordWithRecoverySession({ ...recoveryRequest, authClient: client }),
    (error) => error.code === 'RECOVERY_SESSION_INVALID',
  );
  assert.deepEqual(calls.map((call) => call.method), ['getClaims', 'setSession']);
});

test('does not add a password to a Google-only recovery identity', async () => {
  const { client, calls } = createRecoveryAuthClient({
    sessionUser: { id: 'user-1', app_metadata: { providers: ['google'] } },
  });

  await assert.rejects(
    changePasswordWithRecoverySession({ ...recoveryRequest, authClient: client }),
    (error) => error.code === 'PASSWORD_IDENTITY_UNAVAILABLE',
  );
  assert.deepEqual(calls.map((call) => call.method), ['getClaims', 'setSession']);
});

test('updates through the verified recovery session and signs out globally', async () => {
  const { client, calls } = createRecoveryAuthClient();

  const result = await changePasswordWithRecoverySession({
    ...recoveryRequest,
    authClient: client,
  });

  assert.equal(result.userId, 'user-1');
  assert.equal(result.sessionCleanupError, null);
  assert.deepEqual(calls, [
    { method: 'getClaims', accessToken: recoveryRequest.accessToken },
    {
      method: 'setSession',
      session: {
        access_token: recoveryRequest.accessToken,
        refresh_token: recoveryRequest.refreshToken,
      },
    },
    { method: 'updateUser', attributes: { password: recoveryRequest.newPassword } },
    { method: 'signOut', options: { scope: 'global' } },
  ]);
});

test('does not expose provider details when recovery password update fails', async () => {
  const { client, calls } = createRecoveryAuthClient({
    updateError: { code: 'provider_internal_error', message: 'sensitive provider detail' },
  });

  await assert.rejects(
    changePasswordWithRecoverySession({ ...recoveryRequest, authClient: client }),
    (error) => error.code === 'PASSWORD_UPDATE_REJECTED'
      && !error.message.includes('sensitive provider detail'),
  );
  assert.deepEqual(calls.map((call) => call.method), ['getClaims', 'setSession', 'updateUser']);
});
