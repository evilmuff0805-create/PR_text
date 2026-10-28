import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';

process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-key';

const { default: authRouter } = await import('../src/routes/auth.js');
const { default: downloadRouter } = await import('../src/routes/download.js');
const { supabase, supabaseAdmin } = await import('../src/lib/supabase.js');
const { creditLedgerStore } = await import('../src/services/credit-ledger.js');

const owner = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const dialogue = [
  { start: 3, end: 3.25, text: '앞쪽 안내', timingSource: 'word' },
  { start: 3.9, end: 4.25, text: '뒤쪽 안내', timingSource: 'word' },
];

async function fixture(t, { mapping = null, mappingError = null, mappingThrows = false, logOwner = owner } = {}) {
  const queries = [], warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  t.mock.method(supabase.auth, 'getUser', async () => ({ data: { user: { id: owner, email: 'fixture@example.test' } }, error: null }));
  t.mock.method(creditLedgerStore, 'expireForUser', async () => ({ discrepancy: false, credits_remaining: 100 }));
  t.mock.method(supabaseAdmin, 'from', table => {
    assert.ok(['profiles', 'transcription_logs', 'transcription_operations'].includes(table));
    const query = { table, filters: [] }; queries.push(query);
    return {
      select(columns) { query.columns = columns; return this; },
      eq(column, value) { query.filters.push([column, value]); return this; },
      async single() {
        assert.equal(table, 'transcription_logs');
        const found = query.filters.some(([key, value]) => key === 'id' && String(value) === '23')
          && query.filters.some(([key, value]) => key === 'user_id' && value === logOwner);
        return { data: found ? { id: 23, filename: 'fixture.wav', user_id: logOwner,
          segments: [{ start: 0, end: 1, text: '원본 안내' }], edited_segments: structuredClone(dialogue) } : null, error: null };
      },
      async maybeSingle() {
        if (table === 'profiles') return { data: { credits: 100, plan: 'free' }, error: null };
        assert.equal(table, 'transcription_operations');
        if (mappingThrows) throw new Error('synthetic metadata failure');
        return { data: mapping, error: mappingError };
      },
    };
  });
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/download', downloadRouter);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { const closed = once(server, 'close'); server.close(); await closed; });
  const request = (path, options = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    ...options, headers: { Authorization: 'Bearer synthetic-token', 'Content-Type': 'application/json', ...options.headers },
  });
  const download = body => request('/api/download', { method: 'POST', body: JSON.stringify(body) });
  return { request, download, queries, warnings };
}

test('ordinary authenticated SRT and ASS fill short gaps without changing supplied speech times', async t => {
  const route = await fixture(t), before = structuredClone(dialogue);
  for (const format of ['srt', 'ass']) {
    const response = await route.download({ segments: dialogue, format });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, format === 'srt' ? /00:00:03,000 --> 00:00:03,900/ : /0:00:03\.00,0:00:03\.90/);
    assert.match(text, format === 'srt' ? /00:00:03,900 --> 00:00:04,250/ : /0:00:03\.90,0:00:04\.25/);
  }
  assert.deepEqual(dialogue, before);
});

test('SRT downloads with no recognized dialogue return a clear error instead of an empty file', async t => {
  const route = await fixture(t);
  for (const segments of [[], [{ start: 0, end: 1, text: ' ' }], [{ start: 2, end: 2, text: '길이 없는 구간' }]]) {
    const response = await route.download({ segments, format: 'srt' });
    assert.equal(response.status, 422);
    assert.match((await response.json()).error, /인식된 대사가 없어 SRT를 만들 수 없습니다/);
  }
});

test('owned batch history retains exact speech ends through individual SRT and ASS downloads', async t => {
  const route = await fixture(t, { mapping: { batch_id: '10000000-0000-4000-8000-000000000009' } });
  const response = await route.request('/api/auth/transcription/23');
  assert.equal(response.status, 200);
  const log = await response.json();
  assert.equal(log.holdShortGaps, false);
  assert.deepEqual(log.segments, dialogue);
  assert.equal(log.hasEdits, true);
  assert.equal('batch_id' in log, false);
  const lookup = route.queries.find(query => query.table === 'transcription_operations');
  assert.equal(lookup.columns, 'batch_id');
  assert.deepEqual(lookup.filters, [['user_id', owner], ['transcription_log_id', 23]]);
  for (const format of ['srt', 'ass']) {
    const download = await route.download({ segments: log.segments, format, holdShortGaps: log.holdShortGaps });
    assert.equal(download.status, 200);
    assert.match(await download.text(), format === 'srt' ? /00:00:03,000 --> 00:00:03,250/ : /0:00:03\.00,0:00:03\.25/);
  }
});

test('legacy and mapped single-file history opt into short-gap holding on redownload', async t => {
  for (const mapping of [null, { batch_id: null }]) {
    await t.test(mapping ? 'mapped single' : 'legacy log', async t => {
      const route = await fixture(t, { mapping });
      const log = await (await route.request('/api/auth/transcription/23')).json();
      assert.equal(log.holdShortGaps, true);
      const response = await route.download({ segments: log.segments, format: 'srt', holdShortGaps: log.holdShortGaps });
      assert.match(await response.text(), /00:00:03,000 --> 00:00:03,900/);
    });
  }
});

test('uncertain history mapping preserves speech ends while saved edits remain available', async t => {
  for (const failure of [{ mappingError: { code: 'PGRST116', message: 'synthetic private detail' } }, { mappingThrows: true }]) {
    await t.test(failure.mappingThrows ? 'thrown lookup' : 'returned error', async t => {
      const route = await fixture(t, failure);
      const response = await route.request('/api/auth/transcription/23');
      assert.equal(response.status, 200);
      const log = await response.json();
      assert.equal(log.holdShortGaps, false);
      assert.deepEqual(log.segments, dialogue);
      assert.deepEqual(route.warnings, ['[transcription.timing_policy] lookup_failed']);
    });
  }
});

test('foreign and unauthenticated history cannot resolve a timing policy', async t => {
  const route = await fixture(t, { logOwner: other });
  assert.equal((await route.request('/api/auth/transcription/23')).status, 404);
  assert.equal(route.queries.some(query => query.table === 'transcription_operations'), false);
  assert.equal((await route.request('/api/auth/transcription/23', { headers: { Authorization: '' } })).status, 401);
});

test('download timing flag accepts only booleans and never coerces false-like values', async t => {
  const route = await fixture(t);
  for (const holdShortGaps of ['false', 'true', 0, 1, null, {}, []]) {
    const response = await route.download({ segments: dialogue, format: 'srt', holdShortGaps });
    assert.equal(response.status, 400);
  }
  for (const holdShortGaps of [true, false]) {
    assert.equal((await route.download({ segments: dialogue, format: 'srt', holdShortGaps })).status, 200);
  }
  // A nested ASS setting cannot bypass the validated top-level presentation flag.
  const response = await route.download({ segments: dialogue, format: 'ass', assOptions: { holdShortGaps: false } });
  assert.match(await response.text(), /0:00:03\.00,0:00:03\.90/);
});

test('TXT exports stay independent of display duration policy', async t => {
  const route = await fixture(t);
  const held = await route.download({ segments: dialogue, format: 'txt', holdShortGaps: true });
  const exact = await route.download({ segments: dialogue, format: 'txt', holdShortGaps: false });
  assert.equal(await held.text(), '앞쪽 안내 뒤쪽 안내');
  assert.equal(await exact.text(), '앞쪽 안내 뒤쪽 안내');
});
