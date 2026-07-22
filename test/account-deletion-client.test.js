import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  authReturnPathFromSearch,
  safeAuthReturnPath,
} from '../client/src/utils/auth-navigation.js';

test('allows only approved application pages as OAuth return paths', () => {
  assert.equal(safeAuthReturnPath('/settings'), '/settings');
  assert.equal(safeAuthReturnPath('/caption-ideas'), '/caption-ideas');
  assert.equal(safeAuthReturnPath('https://attacker.example'), '/');
  assert.equal(authReturnPathFromSearch('?next=%2Fsettings'), '/settings');
  assert.equal(authReturnPathFromSearch('?next=%2Fcaption-ideas'), '/caption-ideas');
  assert.equal(authReturnPathFromSearch('?next=%2F%2Fattacker.example'), '/');
});

test('renders paid-credit blockers and explicit free-credit consent', async () => {
  const [settings, authContext, authRoutes, middleware, server] = await Promise.all([
    readFile(new URL('../client/src/pages/SettingsPage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../client/src/contexts/AuthContext.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/auth.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/middleware/auth.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.js', import.meta.url), 'utf8'),
  ]);

  assert.match(settings, /잔여 무료 크레딧/);
  assert.match(settings, /재가입 시 무료 10분 미지급/);
  assert.match(settings, /결제 내역 확인/);
  assert.match(settings, /Google로 다시 인증/);
  assert.match(authContext, /loginWithGoogle = \(returnPath = '\/'\)/);
  assert.match(
    authContext,
    /const returnPath = authReturnPathFromSearch\(window\.location\.search\);[\s\S]*window\.history\.replaceState[\s\S]*navigate\(returnPath/,
  );
  assert.match(authRoutes, /safeOAuthReturnPath/);
  assert.match(authRoutes, /queryParams = \{ prompt: 'select_account' \}/);
  assert.match(middleware, /ACCOUNT_DELETED/);
  assert.match(server, /app\.use\('\/api\/account', accountDeletionLimiter, generalLimiter, accountRouter\)/);
});
