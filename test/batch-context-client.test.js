import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { transformWithEsbuild } from 'vite';
import * as batchUtils from '../client/src/utils/batch-transcription.js';
import * as drafts from '../client/src/utils/result-drafts.js';
import * as uploadValidation from '../client/src/utils/upload-validation.js';
import * as captionIdeas from '../client/src/utils/caption-ideas.js';
import { formatSegmentTime } from '../client/src/utils/format-segment-time.js';

const id = (value) => `10000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const ownerId = id(1), batchId = id(2);
const plain = (value) => JSON.parse(JSON.stringify(value));
const storage = () => { const values = new Map(); return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) }; };
const compiled = new Map();
async function sourceCode(file) {
  if (!compiled.has(file)) compiled.set(file, (await transformWithEsbuild(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'), file, { loader: 'jsx', format: 'cjs', jsx: 'automatic' })).code);
  return compiled.get(file);
}

async function hookFixture({ file = 'client/src/contexts/BatchTranscriptionContext.jsx', exportName = 'BatchTranscriptionProvider', dependencies = {}, props = {}, fetchImpl, localStorage = storage(), sessionStorage = storage() } = {}) {
  const hooks = [], effects = [], timers = new Map(); let cursor = 0, dirty = true, tree, timerId = 0, counter = 100;
  let auth = { user: { id: ownerId, credits: 100 }, token: 'synthetic-token', getToken: () => 'synthetic-token', updateCredits: () => {} };
  const equal = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const react = {
    createContext: () => ({ Provider: 'Provider' }), memo: (component) => component,
    useState(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }; return [hooks[index].value, (next) => { const value = typeof next === 'function' ? next(hooks[index].value) : next; if (!Object.is(value, hooks[index].value)) { hooks[index].value = value; dirty = true; } }]; },
    useRef(initial) { const index = cursor++; return (hooks[index] ||= { current: initial }); },
    useMemo(callback, deps) { const index = cursor++; if (!equal(hooks[index]?.deps, deps)) hooks[index] = { value: callback(), deps }; return hooks[index].value; },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
    useEffect(callback, deps) { const index = cursor++; if (!equal(hooks[index]?.deps, deps)) { const previous = hooks[index]; hooks[index] = { deps }; effects.push(() => { previous?.cleanup?.(); hooks[index].cleanup = callback(); }); } },
  };
  const element = (type, props) => ({ type, props: props || {} });
  const deps = { react, 'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' }, './AuthContext.jsx': { useAuth: () => auth }, '../contexts/AuthContext.jsx': { useAuth: () => auth },
    'react-router-dom': { useLocation: () => ({ search: '', state: null }), useNavigate: () => () => {} },
    '../utils/batch-transcription.js': { ...batchUtils, createBatchApi: (options) => batchUtils.createBatchApi({ ...options, fetchImpl }) },
    '../utils/result-drafts.js': drafts, '../utils/upload-validation.js': uploadValidation, '../utils/wav-optimization.js': { optimizeLargeWavForUpload: async (file) => ({ file }) },
    '../utils/caption-ideas.js': captionIdeas, '../utils/format-segment-time.js': { formatSegmentTime }, ...dependencies };
  const module = { exports: {} };
  const anchors = [];
  const document = { hidden: false, addEventListener() {}, removeEventListener() {}, body: { appendChild() {} }, createElement: () => ({ click() { anchors.push(this.download); }, remove() {} }) };
  const addTimer = (callback) => { const timer = ++timerId; timers.set(timer, callback); return timer; };
  runInNewContext(await sourceCode(file), { module, exports: module.exports, require: (name) => { assert.ok(name in deps, name); return deps[name]; },
    localStorage, sessionStorage, FormData, Blob, File, AbortController, URLSearchParams, URL: { createObjectURL: () => 'blob:synthetic', revokeObjectURL() {} },
    crypto: { randomUUID: () => id(counter++) }, document, window: { setInterval: addTimer, clearInterval: (timer) => timers.delete(timer) },
    setTimeout: addTimer, clearTimeout: (timer) => timers.delete(timer), fetch: fetchImpl });
  const expand = (node) => Array.isArray(node) ? node.map(expand) : node && typeof node === 'object' ? typeof node.type === 'function' ? expand(node.type(node.props)) : { ...node, props: { ...node.props, children: expand(node.props.children) } } : node;
  const render = () => { cursor = 0; dirty = false; tree = expand(module.exports[exportName](props)); };
  const settle = async () => { for (let turn = 0; turn < 50; turn++) { if (dirty) render(); effects.splice(0).forEach((effect) => effect()); await new Promise(setImmediate); if (!dirty && !effects.length) return; } throw new Error('Hooks did not settle'); };
  const nodes = (node = tree, result = []) => { if (Array.isArray(node)) node.forEach((child) => nodes(child ?? null, result)); else if (node && typeof node === 'object') { result.push(node); nodes(node.props.children ?? null, result); } return result; };
  await settle();
  return { settle, nodes, get state() { return tree.props.value; }, anchors, localStorage, sessionStorage, setAuth: async (next) => { auth = next; dirty = true; await settle(); } };
}

function batchServer({ admitted = true, initial = null, respond } = {}) {
  let current = initial; const requests = []; let operation = 200;
  const snapshot = () => plain(current);
  const recalculate = () => { const ready = current.items.filter((item) => item.status === 'ready'); current.totalCredits = ready.reduce((sum, item) => sum + item.creditsNeeded, 0); current.canStart = ready.length > 0 && !current.items.some((item) => ['awaiting_upload', 'queued', 'running', 'finalizing'].includes(item.status)); };
  const fetchImpl = async (url, options) => {
    const request = { url, method: options.method, body: options.body instanceof FormData ? options.body : options.body ? JSON.parse(options.body) : undefined, headers: options.headers }; requests.push(request);
    const custom = await respond?.(request, current); if (custom) return custom;
    if (url === '/api/transcribe/batches' && request.method === 'GET') return Response.json({ batches: current ? [snapshot()] : [], admissionsEnabled: admitted });
    if (url === '/api/transcribe/batches' && request.method === 'POST') {
      if (!current) current = { id: batchId, batchKey: request.body.batchKey, language: request.body.language, status: 'uploading', canStart: false, totalCredits: 0, items: request.body.files.map((file, index) => ({ ...file, id: id(index + 10), order: index, status: 'awaiting_upload', operationId: id(operation++), attemptIndex: 0 })) };
      return Response.json({ batch: snapshot() }, { status: 201 });
    }
    if (url === `/api/transcribe/batches/${batchId}` && request.method === 'GET') return Response.json({ batch: snapshot() });
    if (url.endsWith('/audio')) { const item = current.items.find((row) => url.includes(`/items/${row.id}/`)); item.status = 'ready'; item.durationSeconds = 10; item.creditsNeeded = 1; current.status = 'ready'; recalculate(); return Response.json({ batch: snapshot() }); }
    if (url.endsWith('/start')) { for (const item of current.items) if (item.status === 'ready') item.status = 'queued'; current.status = 'queued'; recalculate(); return Response.json({ batch: snapshot() }, { status: 202 }); }
    if (url.endsWith('/retry')) { const item = current.items.find((row) => url.includes(`/items/${row.id}/`)); item.status = 'awaiting_upload'; item.operationId = id(operation++); item.attemptIndex++; current.status = 'uploading'; recalculate(); return Response.json({ batch: snapshot() }); }
    if (url.endsWith('/archive')) return new Response(new Uint8Array([80, 75]), { headers: { 'content-type': 'application/zip' } });
    throw new Error(`Unexpected synthetic endpoint ${url}`);
  };
  return { fetchImpl, requests, get current() { return current; }, fail() { current.status = 'failed'; current.items.forEach((item) => { if (item.status !== 'completed') item.status = 'failed'; }); recalculate(); }, complete() { current.status = 'completed'; current.items.forEach((item) => { item.status = 'completed'; item.transcriptionLogId = null; }); recalculate(); } };
}

test('batch admission preserves the single flow on a missing API and prevents new uploads when disabled', async () => {
  for (const response of [() => Response.json({ error: 'old server' }, { status: 404 }), undefined]) {
    const server = batchServer({ admitted: false, respond: response });
    const page = await hookFixture({ fetchImpl: server.fetchImpl });
    page.state.addFiles([new File(['synthetic'], 'voice.wav')]); await page.settle();
    assert.equal(page.state.rows.length, 0);
    await page.state.stageFiles(); await page.settle();
    assert.equal(server.requests.some(({ method }) => method === 'POST'), false);
    assert.ok(page.state.error);
    const home = await hookFixture({ file: 'client/src/pages/HomePage.jsx', exportName: 'default', fetchImpl: server.fetchImpl, dependencies: {
      '../contexts/TranscriptionContext.jsx': { useTranscription: () => ({ status: 'idle', progress: '', isBusy: false, clearError() {} }) },
      '../contexts/BatchTranscriptionContext.jsx': { useBatchTranscription: () => page.state },
      '../components/BatchTranscriptionPanel.jsx': { default: () => null }, '../components/AuthModal.jsx': { default: () => null },
    } });
    assert.ok(home.nodes().some(({ type, props }) => type === 'input' && props.type === 'file'));
    assert.ok(home.nodes().some(({ type, props }) => type === 'h1' && props.children === '새 자막 만들기'));
  }
});

test('five files preserve explicit order and labels, stage sequentially, and never start without a second click', async () => {
  const server = batchServer(), page = await hookFixture({ fetchImpl: server.fetchImpl });
  page.state.addFiles(Array.from({ length: 5 }, (_, index) => new File([`synthetic ${index}`], `voice-${index}.wav`))); await page.settle();
  page.state.addFiles([new File(['extra'], 'extra.wav')]); await page.settle(); assert.equal(page.state.rows.length, 5);
  const first = page.state.rows[0].clientId; page.state.changeLabel(first, '진행자'); page.state.moveRow(first, 1); await page.settle();
  const submit = page.state.stageFiles; const running = submit(); submit(); await running; await page.settle();
  const creations = server.requests.filter(({ url, method }) => url === '/api/transcribe/batches' && method === 'POST');
  assert.equal(creations.length, 1); assert.equal(creations[0].body.files[1].label, '진행자');
  assert.equal(server.requests.filter(({ url }) => url.endsWith('/audio')).length, 5);
  assert.equal(server.requests.some(({ url }) => url.endsWith('/start') || url === '/api/transcribe'), false);
  assert.equal(page.state.batch.totalCredits, 5);
  await page.state.start(); await page.settle();
  const start = server.requests.find(({ url }) => url.endsWith('/start'));
  assert.equal(start.body.expectedCredits, 5); assert.ok(batchUtils.isBatchId(start.body.requestId));
  assert.equal(start.headers.Authorization, 'Bearer synthetic-token');
});

test('confirmed failed attempts get fresh retry and start keys, while uncertain start reuses its key without automatic replay', async () => {
  let failStart = true;
  const server = batchServer({ respond: ({ url }) => { if (url.endsWith('/start') && failStart) { failStart = false; throw new Error('synthetic response loss'); } } });
  const page = await hookFixture({ fetchImpl: server.fetchImpl }); page.state.addFiles([new File(['synthetic'], 'voice.wav')]); await page.settle(); await page.state.stageFiles(); await page.settle();
  await page.state.start(); await page.settle(); assert.equal(server.requests.filter(({ url }) => url.endsWith('/start')).length, 1);
  await page.state.start(); await page.settle();
  const starts = server.requests.filter(({ url }) => url.endsWith('/start')); assert.equal(starts[0].body.requestId, starts[1].body.requestId);
  for (let attempt = 0; attempt < 2; attempt++) { server.fail(); await page.state.refresh(); await page.settle(); await page.state.retryItem(page.state.batch.items[0].id); await page.settle(); await page.state.start(); await page.settle(); }
  const retries = server.requests.filter(({ url }) => url.endsWith('/retry'));
  assert.equal(retries.length, 2); assert.notEqual(retries[0].body.requestId, retries[1].body.requestId);
  const allStarts = server.requests.filter(({ url }) => url.endsWith('/start'));
  assert.notEqual(allStarts[1].body.requestId, allStarts[2].body.requestId); assert.notEqual(allStarts[2].body.requestId, allStarts[3].body.requestId);
});

test('accepted refresh restores only metadata, needs reselected missing files and clears private records on permission failure', async () => {
  let denied = false;
  const server = batchServer({ respond: ({ url }) => denied && url === `/api/transcribe/batches/${batchId}` ? Response.json({ error: 'login required' }, { status: 401 }) : undefined });
  const shared = storage(), page = await hookFixture({ fetchImpl: server.fetchImpl, localStorage: shared });
  page.state.addFiles([new File(['synthetic'], 'voice.wav')]); await page.settle(); await page.state.stageFiles(); await page.settle();
  server.current.items[0].status = 'awaiting_upload'; server.current.canStart = false;
  const restored = await hookFixture({ fetchImpl: server.fetchImpl, localStorage: shared });
  assert.equal(restored.state.batch.id, batchId); assert.equal(restored.state.hasFile(restored.state.rows[0].clientId), false);
  const before = server.requests.filter(({ url }) => url.endsWith('/audio')).length;
  await restored.state.stageFiles(); await restored.settle(); assert.equal(server.requests.filter(({ url }) => url.endsWith('/audio')).length, before);
  restored.state.selectReplacement(restored.state.rows[0].clientId, new File(['synthetic'], 'voice.wav')); await restored.settle(); await restored.state.stageFiles(); await restored.settle();
  assert.equal(server.requests.filter(({ url }) => url.endsWith('/audio')).length, before + 1);
  denied = true; await restored.state.refresh(); await restored.settle();
  assert.equal(restored.state.batch, null); assert.equal(restored.state.batches.length, 0); assert.equal(restored.state.rows.length, 0);
});

test('ZIP retry never stages audio, starts a job or charges, and a failed mounted editor flush blocks the archive', async () => {
  let failZip = true;
  let savedSegments = [{ start: 1, end: 2, text: '원문' }];
  const server = batchServer({ respond: ({ url, method, body }) => {
    if (url === '/api/auth/transcription/20' && method === 'GET') return Response.json({ segments: savedSegments });
    if (url === '/api/auth/transcription/20/segments' && method === 'PUT') { savedSegments = body.segments; return Response.json({ saved: 1 }); }
    if (url.endsWith('/archive') && failZip) return Response.json({ error: 'synthetic ZIP failure' }, { status: 500 });
    return undefined;
  } });
  const page = await hookFixture({ fetchImpl: server.fetchImpl }); page.state.addFiles([new File(['synthetic'], 'voice.wav')]); await page.settle(); await page.state.stageFiles(); await page.settle(); server.complete(); await page.state.refresh(); await page.settle();
  server.current.items[0].transcriptionLogId = 20;
  drafts.writeResultDraft(page.sessionStorage, ownerId, 20, { baseText: '원문', segments: [{ start: 1, end: 2, text: '최신 편집' }], fullTextDraft: '최신 편집' });
  const mutations = server.requests.filter(({ method }) => method === 'POST').length;
  page.state.registerEditor(id(90), async () => { throw new Error('save failed'); });
  await page.state.downloadZip(); await page.settle(); assert.equal(server.requests.some(({ url }) => url.endsWith('/archive')), false);
  page.state.registerEditor(id(90), null); await page.state.downloadZip(); await page.settle(); failZip = false; await page.state.downloadZip(); await page.settle();
  const added = server.requests.filter(({ method }) => method === 'POST').slice(mutations);
  assert.equal(added.length, 2); assert.equal(added.every(({ url }) => url.endsWith('/archive')), true);
  assert.deepEqual(added[1].body, { allowPartial: false }); assert.equal(page.anchors.length, 1);
  assert.equal(server.requests.filter(({ method }) => method === 'PUT').length, 1);
  assert.equal(savedSegments[0].text, '최신 편집');
});

test('actual result editor flush serializes the latest text, preserves timing and blocks mismatched drafts', async () => {
  const requests = []; let flush, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const segments = [{ start: 1.001, end: 2.25, text: '첫 문장', timingSource: 'word' }];
  const page = await hookFixture({ file: 'client/src/pages/ResultPage.jsx', exportName: 'ResultEditor', props: { resultOverride: { text: '첫 문장', segments, transcriptionLogId: 20 }, onRegisterFlush: (callback) => { if (callback) flush = callback; } },
    fetchImpl: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); if (requests.length === 1) await gate; return Response.json({ saved: 1 }); } });
  const input = () => page.nodes().find(({ props }) => props.id === 'full-transcript');
  input().props.onChange({ target: { value: '첫 수정' } }); await page.settle(); const saving = flush(); await page.settle();
  input().props.onChange({ target: { value: '최신 수정' } }); await page.settle(); release(); await saving; await page.settle();
  assert.equal(requests.length, 2); assert.deepEqual(requests[1].body.segments, [{ ...segments[0], text: '최신 수정' }]);
  input().props.onChange({ target: { value: '최신 수정\n여분 줄' } }); await page.settle();
  await assert.rejects(flush(), /줄 수/); assert.equal(requests.length, 2);
  const saved = JSON.parse(page.sessionStorage.getItem(drafts.resultDraftKey(ownerId, 20)));
  assert.equal(saved.fullTextDraft, '최신 수정\n여분 줄');
});

test('legacy single results verify record ownership and use saved edits, while foreign or denied state stays hidden', async () => {
  const old = { transcriptionLogId: 20, text: '이전 화면 문장', segments: [{ start: 1, end: 2, text: '이전 화면 문장' }] };
  const requests = [];
  const verified = await hookFixture({ file: 'client/src/pages/ResultPage.jsx', exportName: 'default', dependencies: { 'react-router-dom': { useLocation: () => ({ state: old }), useNavigate: () => () => {} } },
    fetchImpl: async (url, options) => { requests.push({ url, method: options.method || 'GET' }); return Response.json({ segments: [{ start: 1, end: 2, text: '서버 최신 편집' }] }); } });
  assert.equal(verified.nodes().find(({ props }) => props.id === 'full-transcript').props.value, '서버 최신 편집');
  assert.deepEqual(requests, [{ url: '/api/auth/transcription/20', method: 'GET' }]);
  assert.equal(JSON.parse(verified.sessionStorage.getItem(drafts.lastResultKey(ownerId))).ownerId, ownerId);
  for (const state of [old, { ...old, ownerId: id(99) }]) {
    const hidden = await hookFixture({ file: 'client/src/pages/ResultPage.jsx', exportName: 'default', dependencies: { 'react-router-dom': { useLocation: () => ({ state }), useNavigate: () => () => {} } }, fetchImpl: async () => Response.json({ error: 'forbidden' }, { status: 403 }) });
    assert.equal(hidden.nodes().some(({ props }) => props.id === 'full-transcript'), false);
    assert.equal(hidden.sessionStorage.getItem(drafts.lastResultKey(ownerId)), null);
  }
});

test('corrected edits clear a prior ZIP error only after a successful track switch or return flush', async () => {
  let invalid = true, clears = 0;
  const transitions = [], navigations = [];
  const items = [0, 1].map((order) => ({ id: id(20 + order), order, label: `인물 ${order + 1}`, status: 'completed', transcriptionLogId: 101 + order }));
  let params = new URLSearchParams({ batch: batchId, track: items[0].id });
  const state = { batch: { id: batchId, items }, busy: '', error: '편집한 줄 수가 자막 수와 다릅니다.', notice: '',
    api: async () => ({ segments: [{ start: 1, end: 2, text: '합성 문장' }] }), registerEditor() {},
    clearError() { clears++; state.error = ''; },
  };
  const page = await hookFixture({ file: 'client/src/pages/BatchResultPage.jsx', exportName: 'default', dependencies: {
    'react-router-dom': { useSearchParams: () => [params, (next) => { transitions.push(next); params = new URLSearchParams(next); }], useNavigate: () => (path) => navigations.push(path), Link: 'a' },
    '../contexts/BatchTranscriptionContext.jsx': { useBatchTranscription: () => state },
    '../components/BatchTranscriptionPanel.jsx': { BatchImportNotice: () => null },
    './ResultPage.jsx': { ResultEditor: ({ onRegisterFlush }) => { onRegisterFlush(async () => { if (invalid) throw new Error('편집한 줄 수가 자막 수와 다릅니다.'); }); return null; } },
  } });
  const otherTrack = () => page.nodes().find(({ type, props }) => type === 'button' && props['aria-pressed'] === false);
  await otherTrack().props.onClick(); await page.settle();
  assert.equal(clears, 0); assert.equal(transitions.length, 0); assert.ok(state.error);
  invalid = false;
  await otherTrack().props.onClick(); await page.settle();
  assert.equal(clears, 1); assert.equal(transitions.length, 1); assert.equal(state.error, '');
  assert.equal(page.nodes().some(({ props }) => props.role === 'alert'), false);
  state.error = '과거 ZIP 오류';
  await page.nodes().find(({ type, props }) => type === 'button' && props.children === '묶음 상태로 돌아가기').props.onClick(); await page.settle();
  assert.equal(clears, 2); assert.equal(state.error, '');
  assert.deepEqual(navigations, [`/transcribe?mode=batch&batch=${batchId}`]);
});
