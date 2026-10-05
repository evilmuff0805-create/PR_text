import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';

process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-key';

const { default: authRouter, safeOAuthReturnPath } = await import('../src/routes/auth.js');
const { supabase } = await import('../src/lib/supabase.js');

test('server OAuth defaults to the subtitle workspace while rejecting arbitrary destinations', () => {
  for (const value of [undefined, null, '', '/', '/auth/reset', 'https://attacker.example', '//attacker.example', ['/settings']]) {
    assert.equal(safeOAuthReturnPath(value), '/transcribe');
  }
  for (const value of ['/transcribe', '/settings', '/caption-ideas']) {
    assert.equal(safeOAuthReturnPath(value), value);
  }
});

test('Google OAuth callbacks use the workspace default and preserve explicit account reauthentication', async (t) => {
  const calls = [];
  t.mock.method(supabase.auth, 'signInWithOAuth', async (options) => {
    calls.push(options);
    return { data: { url: 'https://accounts.google.com/test-login' }, error: null };
  });
  const app = express();
  app.use('/api/auth', authRouter);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    for (const [search, expected] of [
      ['', '/transcribe'],
      ['?next=%2Ftranscribe', '/transcribe'],
      ['?next=%2Fsettings', '/settings'],
      ['?next=%2Fcaption-ideas', '/caption-ideas'],
      ['?next=https%3A%2F%2Fattacker.example', '/transcribe'],
    ]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/google${search}`, { redirect: 'manual' });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), 'https://accounts.google.com/test-login');

      const request = calls.at(-1);
      const callback = new URL(request.options.redirectTo);
      assert.equal(request.provider, 'google');
      assert.equal(callback.pathname, '/auth/callback');
      assert.equal(callback.searchParams.get('next'), expected);
      assert.equal(request.options.skipBrowserRedirect, true);
      assert.equal(request.options.queryParams?.prompt, expected === '/settings' ? 'select_account' : undefined);
    }
  } finally {
    server.close();
    await once(server, 'close');
  }
});
