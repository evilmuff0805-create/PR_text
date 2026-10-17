import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { once } from 'node:events';
import express from 'express';

process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-key';
const { createTranscriptionBatchesRouter } = await import('../src/routes/transcription-batches.js');

async function fixture(t) {
  const id = randomUUID(), itemId = randomUUID(), owner = randomUUID();
  const batch = { id, items: [{ id: itemId, status: 'ready' }], status: 'ready' };
  const calls = [];
  let uploadCalls = 0, latest = 'latest saved edit', createError;
  const service = {
    list: async user => { calls.push(['list', user]); return { batches: [batch], admissionsEnabled: true }; },
    get: async (key, user) => { calls.push(['get', key, user]); return key === id ? batch : null; },
    create: async params => { calls.push(['create', params]); if (createError) throw createError; return { batch, existing: false }; },
    upload: async params => { calls.push(['upload', params]); return batch; },
    start: async params => { calls.push(['start', params]); return { ...batch, status: 'queued' }; },
    retry: async params => { calls.push(['retry', params]); throw Object.assign(new Error('완료한 파일은 재시도할 수 없습니다.'), { code: 'TB409' }); },
    cancel: async (...params) => { calls.push(['cancel', ...params]); return { ...batch, status: 'cancelled' }; },
    archiveItems: async (key, user) => { calls.push(['archive', key, user]); return key === id ? [{ label: '인물', status: 'completed', segments: [{ start: 12.345, end: 12.678, text: latest }] }] : null; },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/transcribe/batches', createTranscriptionBatchesRouter({ service,
    authenticate: (req, res, next) => { if (req.get('Authorization') !== 'Bearer synthetic') return res.status(401).json({ error: '로그인 필요' }); req.user = { id: owner }; next(); },
    upload: (req, res, next) => { uploadCalls++; req.file = { buffer: Buffer.from('audio'), originalname: 'person.wav', mimetype: 'audio/wav' }; next(); },
  }));
  app.use((error, req, res, next) => res.status(500).json({ error: 'unexpected fixture error' }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/transcribe/batches`;
  const request = (path = '', options = {}) => fetch(base + path, { ...options, headers: { Authorization: 'Bearer synthetic', 'Content-Type': 'application/json', ...options.headers }, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
  return { id, itemId, owner, calls, request, uploadCalls: () => uploadCalls, setLatest: value => { latest = value; }, setCreateError: value => { createError = value; } };
}

test('batch routes use the authenticated owner and preserve staged/start separation', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('', { headers: { Authorization: '' } })).status, 401);
  assert.equal(f.calls.length, 0);
  const files = [{ clientId: randomUUID(), filename: 'person.wav', label: '인물' }];
  const created = await f.request('', { method: 'POST', body: { batchKey: randomUUID(), language: 'ko', files, userId: randomUUID() } });
  assert.equal(created.status, 201);
  assert.equal(f.calls[0][1].userId, f.owner);
  assert.deepEqual(f.calls[0][1].files, files);
  assert.equal(f.calls.some(([name]) => name === 'start'), false);
  const uploaded = await f.request(`/${f.id}/items/${f.itemId}/audio`, { method: 'POST' });
  assert.equal(uploaded.status, 202);
  assert.equal((await uploaded.json()).batch.status, 'ready');
  assert.equal(f.calls.some(([name]) => name === 'start'), false);
  const key = randomUUID();
  const started = await f.request(`/${f.id}/start`, { method: 'POST', body: { requestId: key, expectedCredits: 3 } });
  assert.equal(started.status, 202);
  assert.deepEqual(f.calls.find(([name]) => name === 'start')[1], { userId: f.owner, batchId: f.id, requestId: key, expectedCredits: 3 });
});

test('invalid IDs and foreign upload targets are rejected before parsing audio', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/invalid')).status, 400);
  assert.equal((await f.request(`/${randomUUID()}/items/${f.itemId}/audio`, { method: 'POST' })).status, 404);
  assert.equal((await f.request(`/${f.id}/items/${randomUUID()}/audio`, { method: 'POST' })).status, 404);
  assert.equal(f.uploadCalls(), 0);
  for (const expectedCredits of [0, -1, true, '3', 1.5]) {
    assert.equal((await f.request(`/${f.id}/start`, { method: 'POST', body: { requestId: randomUUID(), expectedCredits } })).status, 400);
  }
  assert.equal(f.calls.some(([name]) => name === 'start'), false);
  const retry = await f.request(`/${f.id}/items/${f.itemId}/retry`, { method: 'POST', body: { requestId: randomUUID() } });
  assert.equal(retry.status, 409);
  assert.equal((await retry.json()).code, 'TB409');
});

test('archive routes export latest owner edits and never call transcription mutations', async t => {
  const f = await fixture(t);
  for (const text of ['latest saved edit', 'newer saved edit']) {
    f.setLatest(text);
    const response = await f.request(`/${f.id}/archive`, { method: 'POST', body: { allowPartial: false } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'application/zip');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Completed-Files'), '1');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.readUInt32LE(0), 0x04034b50);
    assert.ok(bytes.includes(Buffer.from(text)));
    assert.ok(bytes.includes(Buffer.from('00:00:12,345 --> 00:00:12,678')));
  }
  assert.ok(f.calls.every(([name, key, user]) => name === 'archive' && key === f.id && user === f.owner));
  assert.equal((await f.request(`/${randomUUID()}/archive`, { method: 'POST', body: {} })).status, 404);
  assert.equal((await f.request(`/${f.id}/archive`, { method: 'POST', body: { allowPartial: 'true' } })).status, 400);
});

test('batch availability responses preserve safe retry codes without leaking internal errors', async t => {
  const f = await fixture(t);
  f.setCreateError(Object.assign(new Error('사람별 묶음 변환을 준비 중입니다.'), { status: 503, code: 'BATCH_ADMISSIONS_DISABLED' }));
  const response = await f.request('', { method: 'POST', body: {} });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'BATCH_ADMISSIONS_DISABLED');
  f.setCreateError(Object.assign(new Error('private connection details'), { status: 503 }));
  const unavailable = await f.request('', { method: 'POST', body: {} });
  assert.equal(unavailable.status, 503);
  const data = await unavailable.json();
  assert.equal(data.code, 'BATCH_UNAVAILABLE');
  assert.ok(!data.error.includes('private connection details'));
});
