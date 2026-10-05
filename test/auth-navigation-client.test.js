import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { transformWithEsbuild } from 'vite';

import * as authNavigation from '../client/src/utils/auth-navigation.js';
import * as passwordRecovery from '../client/src/utils/password-recovery.js';

const source = await readFile(new URL('../client/src/contexts/AuthContext.jsx', import.meta.url), 'utf8');
const { code } = await transformWithEsbuild(source, 'AuthContext.jsx', {
  jsx: 'automatic',
  format: 'cjs',
});

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

// Execute the provider's actual auth methods/effects without needing a browser.
function authHarness({ path = '/transcribe', search = '', hash = '', savedToken = null, fetchImpl } = {}) {
  const effects = [];
  const navigations = [];
  const requests = [];
  const localStorage = storage(savedToken ? { token: savedToken } : {});
  const sessionStorage = storage();
  const location = { pathname: path, search, hash, href: `${path}${search}${hash}` };
  const mockReact = {
    createContext: () => ({ Provider: 'auth-provider' }),
    useCallback: (callback) => callback,
    useContext: () => null,
    useEffect: (effect) => effects.push(effect),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  };
  const module = { exports: {} };
  const dependencies = {
    react: mockReact,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }) },
    'react-router-dom': { useNavigate: () => (path, options) => navigations.push({ path, options }) },
    '../utils/auth-navigation.js': authNavigation,
    '../utils/password-recovery.js': passwordRecovery,
  };

  runInNewContext(code, {
    module,
    exports: module.exports,
    require: (name) => {
      assert.ok(name in dependencies, `unexpected dependency: ${name}`);
      return dependencies[name];
    },
    localStorage,
    sessionStorage,
    URLSearchParams,
    window: {
      location,
      history: {
        state: null,
        replaceState: (_state, _title, url) => { location.href = url; location.hash = ''; },
      },
      addEventListener() {},
      removeEventListener() {},
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return fetchImpl ? fetchImpl(url, options) : response({});
    },
  });

  const provider = module.exports.AuthProvider({ children: null, initialLoading: false });
  return { auth: provider.props.value, effects, navigations, requests, localStorage, sessionStorage, location };
}

function response(data, ok = true) {
  return { ok, json: async () => data };
}

const profile = { id: 'user-1', email: 'user@example.com', credits: 10, plan: 'free' };

function successfulLogin(url) {
  return response(url === '/api/auth/login' ? { token: 'test-token' } : profile);
}

test('missing, landing and unsafe auth destinations default to the subtitle workspace', () => {
  for (const value of [undefined, null, '', '/', '/intro', '/auth/reset', 'https://attacker.example', '//attacker.example']) {
    assert.equal(authNavigation.safeAuthReturnPath(value), '/transcribe');
  }
  assert.equal(authNavigation.authReturnPathFromSearch(''), '/transcribe');
  assert.equal(authNavigation.authReturnPathFromSearch('?next=%2Ftranscribe'), '/transcribe');
  assert.equal(authNavigation.authReturnPathFromSearch('?next=https%3A%2F%2Fattacker.example'), '/transcribe');
});

test('successful email login opens the subtitle workspace after loading the user profile', async () => {
  const harness = authHarness({ path: '/', fetchImpl: successfulLogin });
  await harness.auth.login('user@example.com', 'test-password');

  assert.deepEqual(harness.requests.map(({ url }) => url), ['/api/auth/login', '/api/auth/me']);
  assert.equal(harness.localStorage.getItem('token'), 'test-token');
  assert.equal(harness.navigations.length, 1);
  assert.equal(harness.navigations[0].path, '/transcribe');
  assert.equal(harness.navigations[0].options.replace, true);
});

test('email login preserves approved explicit return destinations', async () => {
  for (const returnPath of ['/settings', '/caption-ideas']) {
    const harness = authHarness({ fetchImpl: successfulLogin });
    await harness.auth.login('user@example.com', 'test-password', returnPath);
    assert.equal(harness.navigations[0].path, returnPath);
  }
});

test('failed credentials or profile loading never navigate or establish a new session', async () => {
  for (const failingEndpoint of ['/api/auth/login', '/api/auth/me']) {
    const harness = authHarness({
      fetchImpl: (url) => url === failingEndpoint
        ? response({ error: 'authentication failed' }, false)
        : successfulLogin(url),
    });
    await assert.rejects(harness.auth.login('user@example.com', 'test-password'), /authentication failed/);
    assert.equal(harness.navigations.length, 0);
    assert.equal(harness.localStorage.getItem('token'), null);
  }
});

test('Google login sends the workspace default and preserves approved explicit destinations', () => {
  for (const [returnPath, expected] of [
    [undefined, '/transcribe'],
    ['/settings', '/settings'],
    ['/caption-ideas', '/caption-ideas'],
    ['https://attacker.example', '/transcribe'],
  ]) {
    const harness = authHarness();
    harness.auth.loginWithGoogle(returnPath);
    assert.equal(harness.location.href, `/api/auth/google?next=${encodeURIComponent(expected)}`);
  }
});

test('successful OAuth callbacks open the workspace or approved explicit page and clear URL tokens', async () => {
  for (const [search, expected] of [['', '/transcribe'], ['?next=%2Fsettings', '/settings'], ['?next=%2Fcaption-ideas', '/caption-ideas']]) {
    const harness = authHarness({ path: '/auth/callback', search, hash: '#access_token=oauth-token', fetchImpl: () => response(profile) });
    harness.effects[0]();
    await new Promise(setImmediate);

    assert.equal(harness.navigations.length, 1);
    assert.equal(harness.navigations[0].path, expected);
    assert.equal(harness.navigations[0].options.replace, true);
    assert.equal(harness.location.hash, '');
  }
});

test('password recovery remains on its dedicated page and keeps tokens outside the login session', async () => {
  const harness = authHarness({
    path: '/auth/reset',
    hash: '#access_token=recovery-token&refresh_token=recovery-refresh&type=recovery',
    savedToken: 'old-session',
  });
  harness.effects[0]();
  await new Promise(setImmediate);

  assert.equal(harness.navigations.length, 0);
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.localStorage.getItem('token'), null);
  assert.deepEqual(passwordRecovery.loadPasswordRecoverySession(harness.sessionStorage), {
    accessToken: 'recovery-token', refreshToken: 'recovery-refresh',
  });
});

test('restoring an existing session does not redirect away from the current project', async () => {
  const harness = authHarness({ path: '/result', savedToken: 'existing-session', fetchImpl: () => response(profile) });
  harness.effects[0]();
  await new Promise(setImmediate);

  assert.deepEqual(harness.requests.map(({ url }) => url), ['/api/auth/me']);
  assert.equal(harness.navigations.length, 0);
});
