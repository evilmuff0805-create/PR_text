import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  loadPasswordRecoverySession,
  parsePasswordRecoveryHash,
  savePasswordRecoverySession,
} from '../client/src/utils/password-recovery.js';

test('parses recovery tokens only on dedicated recovery routes', () => {
  const hash = '#access_token=access-1&refresh_token=refresh-1&type=recovery';

  assert.deepEqual(parsePasswordRecoveryHash(hash, '/auth/reset'), {
    kind: 'session',
    session: { accessToken: 'access-1', refreshToken: 'refresh-1' },
  });
  assert.deepEqual(parsePasswordRecoveryHash(hash, '/reset-password'), {
    kind: 'session',
    session: { accessToken: 'access-1', refreshToken: 'refresh-1' },
  });
  assert.deepEqual(parsePasswordRecoveryHash(hash, '/auth/callback'), {
    kind: 'not-recovery',
  });
});

test('rejects expired links and normal login hashes on the recovery route', () => {
  assert.deepEqual(
    parsePasswordRecoveryHash('#error=access_denied&error_code=otp_expired', '/auth/reset'),
    { kind: 'error', message: '재설정 링크가 만료되었거나 이미 사용되었습니다.' },
  );
  assert.deepEqual(
    parsePasswordRecoveryHash('#access_token=access-1&refresh_token=refresh-1&type=signup', '/auth/reset'),
    { kind: 'error', message: '비밀번호 재설정 링크가 유효하지 않습니다.' },
  );
});

test('keeps recovery tokens in temporary session storage', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const session = { accessToken: 'access-1', refreshToken: 'refresh-1' };

  savePasswordRecoverySession(storage, session);
  assert.deepEqual(loadPasswordRecoverySession(storage), session);

  values.set('passwordRecoverySession', '{bad json');
  assert.equal(loadPasswordRecoverySession(storage), null);
  assert.equal(values.has('passwordRecoverySession'), false);
});

test('routes and limits the recovery completion endpoint', async () => {
  const [app, authModal, authContext, resetPage, authRoutes, server] = await Promise.all([
    readFile(new URL('../client/src/App.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../client/src/components/AuthModal.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../client/src/contexts/AuthContext.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../client/src/pages/PasswordResetPage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/auth.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.js', import.meta.url), 'utf8'),
  ]);

  assert.match(app, /path="\/auth\/reset" element=\{<PasswordResetPage \/>\}/);
  assert.match(authContext, /savePasswordRecoverySession\(sessionStorage, recovery\.session\)/);
  assert.match(authContext, /addEventListener\('hashchange', applyPasswordRecoveryHash\)/);
  assert.match(authModal, /Google 비밀번호는 PR_text에서 변경되지 않습니다/);
  assert.match(resetPage, /Google 비밀번호에는 영향을 주지 않습니다/);
  assert.match(authRoutes, /router\.put\('\/recovery-password'/);
  assert.match(authRoutes, /changePasswordWithRecoverySession/);
  assert.match(server, /app\.use\('\/api\/auth\/recovery-password', passwordChangeLimiter\)/);
});
