import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { indexNowHost, indexNowKey, indexNowKeyPath, indexNowPayload, publicPages } from '../client/src/public-pages.js';
import { startIndexNowSubmission, submitPublicPagesToIndexNow } from '../src/services/indexnow.js';

test('the key satisfies the IndexNow key format', () => {
  // 스펙 밖의 키는 403으로 거절된다.
  assert.match(indexNowKey, /^[a-zA-Z0-9-]{8,128}$/);
});

test('the build writes a key file whose contents equal its own filename', async () => {
  // 파일명과 내용이 다르면 검색엔진이 소유 확인에 실패한다. 빌드가 키 상수 하나에서
  // 파일명과 내용을 모두 만들기 때문에 어긋날 수 없다는 것을 여기서 잠근다.
  const build = await readFile(new URL('../scripts/prerender-public-pages.js', import.meta.url), 'utf8');

  assert.match(build, /writeFile\(resolve\(distRoot, `\$\{indexNowKey\}\.txt`\), indexNowKey, 'utf8'\)/);
  assert.equal(indexNowKeyPath, `/${indexNowKey}.txt`);
});

test('the submitted URL list is derived from the public page list', () => {
  // 공개 페이지가 추가되면 사이트맵과 함께 자동으로 따라온다.
  const payload = indexNowPayload();

  assert.deepEqual(payload.urlList, publicPages.map((page) => page.canonicalUrl));
  assert.ok(payload.urlList.length > 0);
});

test('host, key location, and every URL share one origin', () => {
  // host와 keyLocation이 URL들과 어긋나면 IndexNow는 422로 거절한다.
  const payload = indexNowPayload();

  assert.equal(payload.key, indexNowKey);
  assert.equal(payload.host, indexNowHost);
  assert.equal(payload.keyLocation, `https://${indexNowHost}${indexNowKeyPath}`);
  for (const url of payload.urlList) assert.equal(new URL(url).host, indexNowHost);
});

test('the submitted URLs never include a private route', () => {
  const urls = indexNowPayload().urlList;

  for (const path of ['/transcribe', '/result', '/usage', '/settings', '/redownload', '/payment/success']) {
    assert.ok(!urls.some((url) => new URL(url).pathname === path), `${path} must not be submitted`);
  }
});

test('submission stays off unless the environment opts in', (t) => {
  const original = process.env.INDEXNOW_ENABLED;
  t.after(() => { if (original === undefined) delete process.env.INDEXNOW_ENABLED; else process.env.INDEXNOW_ENABLED = original; });

  delete process.env.INDEXNOW_ENABLED;
  assert.equal(startIndexNowSubmission(), null);
  process.env.INDEXNOW_ENABLED = 'false';
  assert.equal(startIndexNowSubmission(), null);

  process.env.INDEXNOW_ENABLED = 'true';
  const timer = startIndexNowSubmission();
  assert.notEqual(timer, null);
  clearTimeout(timer);
});

test('a failing endpoint is logged instead of thrown', async () => {
  // 서버 기동 중에 호출되므로 예외가 밖으로 나가면 안 된다.
  const rejected = await submitPublicPagesToIndexNow(async () => { throw new Error('network down'); });
  assert.deepEqual(rejected, { ok: false, error: 'network down' });

  const refused = await submitPublicPagesToIndexNow(async () => ({ status: 403 }));
  assert.deepEqual(refused, { ok: false, status: 403 });
});

test('both success codes the protocol defines are accepted', async () => {
  // 202는 키 검증 대기 중이라는 뜻이며 실패가 아니다.
  for (const status of [200, 202]) {
    const result = await submitPublicPagesToIndexNow(async () => ({ status }));
    assert.deepEqual(result, { ok: true, status });
  }
});

test('the request follows the protocol shape', async () => {
  let seen = null;
  await submitPublicPagesToIndexNow(async (url, options) => { seen = { url, options }; return { status: 200 }; });

  assert.equal(seen.url, 'https://api.indexnow.org/indexnow');
  assert.equal(seen.options.method, 'POST');
  assert.equal(seen.options.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(seen.options.body), indexNowPayload());
});
