import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import { indexNowKey, indexNowKeyPath, publicPages } from '../client/src/public-pages.js';
import { addStaticSiteRoutes } from '../src/static-site.js';

const privatePaths = ['/transcribe', '/caption-ideas', '/result', '/payment/success', '/payment/fail', '/usage', '/redownload', '/settings', '/auth/callback', '/auth/reset', '/reset-password'];

async function startStaticTestServer(t) {
  const distPath = await mkdtemp(join(tmpdir(), 'pr-text-static-'));
  t.after(() => rm(distPath, { recursive: true, force: true }));
  await mkdir(join(distPath, 'public-pages'));
  await writeFile(join(distPath, 'index.html'), '<!doctype html><title>home</title><main>home</main>');
  await writeFile(join(distPath, 'spa.html'), '<!doctype html><title>app</title><div id="root"></div>');
  await Promise.all(publicPages.filter((page) => page.path !== '/').map((page) => writeFile(join(distPath, 'public-pages', `${page.path.slice(1)}.html`), `<!doctype html><title>${page.path}</title><main>${page.path}</main>`)));
  await writeFile(join(distPath, 'asset.js'), 'asset');
  await writeFile(join(distPath, `${indexNowKey}.txt`), indexNowKey);
  const app = express(); addStaticSiteRoutes(app, distPath);
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('serves every public document for GET and HEAD and preserves intro query strings', async (t) => {
  const origin = await startStaticTestServer(t);
  for (const page of publicPages) {
    const [getResponse, headResponse] = await Promise.all([fetch(`${origin}${page.path}`), fetch(`${origin}${page.path}`, { method: 'HEAD' })]);
    assert.equal(getResponse.status, 200, page.path);
    assert.equal(headResponse.status, 200, `${page.path} HEAD`);
    assert.equal(headResponse.headers.get('content-type'), 'text/html; charset=utf-8');
  }
  const intro = await fetch(`${origin}/intro?source=test`, { redirect: 'manual' });
  assert.equal(intro.status, 301); assert.equal(intro.headers.get('location'), '/?source=test');
});

test('serves the IndexNow key file so search engines can verify ownership', async (t) => {
  // 정적 라우터는 .html만 막는다. 키 파일이 404가 되면 IndexNow 제출이 403으로 거절된다.
  const origin = await startStaticTestServer(t);
  const response = await fetch(`${origin}${indexNowKeyPath}`);

  assert.equal(response.status, 200);
  assert.equal((await response.text()).trim(), indexNowKey);
});

test('serves every private SPA route with noindex and never exposes generated HTML paths', async (t) => {
  const origin = await startStaticTestServer(t);
  for (const path of privatePaths) {
    const [getResponse, headResponse] = await Promise.all([fetch(`${origin}${path}`), fetch(`${origin}${path}`, { method: 'HEAD' })]);
    assert.equal(getResponse.status, 200, path); assert.equal(headResponse.status, 200, `${path} HEAD`);
    assert.equal(getResponse.headers.get('x-robots-tag'), 'noindex, nofollow');
  }
  for (const path of ['/guide/', '/Guide', '/public-pages', '/public-pages/', '/public-pages/guide.html', '/public-pages%2Fguide.html', '/public-pages%5Cguide.html', '/%73pa.html', '/spa%2Ehtml', '/index.html', '/index%2Ehtml', '/INDEX.HTML', '/missing.js', '/does-not-exist']) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 404, path);
  }
});

test('serves the OAuth callback shell so the browser can consume Supabase tokens', async (t) => {
  const origin = await startStaticTestServer(t);
  const response = await fetch(`${origin}/auth/callback?next=%2Fsettings`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(await response.text(), /<div id="root"><\/div>/);
});
