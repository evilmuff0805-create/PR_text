import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { transformWithEsbuild } from 'vite';
import * as review from '../client/src/utils/subtitle-review.js';
import * as drafts from '../client/src/utils/result-drafts.js';
import * as ideas from '../client/src/utils/caption-ideas.js';
import { formatSegmentTime } from '../client/src/utils/format-segment-time.js';
import { getLocalStartCueMinimum, normalizeLocalStartEvidence } from '../src/services/local-start-evidence.js';
import { annotateLocalStartEvidence } from '../src/services/local-audio-start.js';

const plain = (value) => JSON.parse(JSON.stringify(value));
const storage = () => { const values = new Map(); return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key), values }; };
const candidateSegment = () => ({ start: 1, end: 4, text: '첫 합성 안내 다음 합성 구간', timingSource: 'speech_window', audioStartFloor: 0.5,
  fixedCuePlan: { version: 1, binding: { start: 1, end: 4, text: '첫 합성 안내 다음 합성 구간' },
    cues: [[1, 1.5, '첫 합성 안내'], [3, 4, '다음 합성 구간']],
    original: { start: 1, end: 4, text: '첫 합성 안네 다음 합성 구간', cues: [[1, 1.5, '첫 합성 안네'], [3, 4, '다음 합성 구간']] } },
  subtitleReview: { version: 1, issues: [{ code: 'cue_window_correction_applied' }], correctionStatus: 'cue_applied',
    correctionBinding: { start: 1, end: 4, text: '첫 합성 안내 다음 합성 구간' },
    localStart: { version: 1, status: 'automatic', binding: { start: 1, end: 4, text: '첫 합성 안내 다음 합성 구간' },
      cues: [[1, 1.5, '첫 합성 안내', 1.2], [3, 4, '다음 합성 구간', 3.4]], sampleRate: 48_000, channels: 2, method: 'native_wav' } } });
const unavailableSegment = (reason) => { const segment = candidateSegment(); segment.subtitleReview.localStart = {
  version: 1, status: 'unavailable', binding: { text: segment.text, start: segment.start, end: segment.end }, cues: [], reason,
}; return segment; };
const suspiciousSegment = (audioStatus = 'signal_present') => ({ start: 6, end: 6.2, text: '별도 합성 안내',
  subtitleReview: { version: 1, issues: [], localExclusion: { version: 1, status: 'review', reason: 'suspicious_silence',
    binding: { start: 6, end: 6.2, text: '별도 합성 안내' }, audioStatus } } });

// Actual ResultEditor harness: compile JSX and execute hooks, event handlers,
// owned session storage, autosave and download with isolated synthetic HTTP.
let compiled;
async function fixture({ segments = [candidateSegment()], store = storage(), owner = 'owner', logId = 101, holdShortGaps = true, single = false, incoming = true, serverVerified = false, wrapper = false, language = 'ko', diarize = false, saveError = null } = {}) {
  compiled ||= (await transformWithEsbuild(await readFile(new URL('../client/src/pages/ResultPage.jsx', import.meta.url), 'utf8'), 'ResultPage.jsx', { loader: 'jsx', format: 'cjs', jsx: 'automatic' })).code;
  const editorHooks = [], wrapperHooks = [], effects = [], timers = new Map(), requests = [], urls = [], revoked = [], mediaByUrl = new Map(), navigations = [], editorKeys = [];
  let hooks = editorHooks, cursor = 0, dirty = true, tree, nextTimer = 0, nextUrl = 0, flush, routeState = null, editorKey;
  let auth = { user: { id: owner }, token: 'synthetic-token' };
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    memo: (fn) => fn,
    useState(initial) { const n = cursor++; if (!(n in hooks)) hooks[n] = { value: typeof initial === 'function' ? initial() : initial }; return [hooks[n].value, (next) => { const value = typeof next === 'function' ? next(hooks[n].value) : next; if (!Object.is(value, hooks[n].value)) { hooks[n].value = value; dirty = true; } }]; },
    useRef(initial) { const n = cursor++; return hooks[n] ||= { current: initial }; },
    useMemo(fn, deps) { const n = cursor++; if (!same(hooks[n]?.deps, deps)) hooks[n] = { value: fn(), deps }; return hooks[n].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const n = cursor++, target = hooks; if (!same(target[n]?.deps, deps)) { const old = target[n]; target[n] = { deps }; effects.push(() => { old?.cleanup?.(); target[n].cleanup = fn(); }); } },
  };
  const element = (type, props, key) => ({ type, props: props || {}, key });
  const deps = { react, 'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' },
    'react-router-dom': { useLocation: () => ({ state: routeState, pathname: '/result' }), useNavigate: () => (...args) => { navigations.push(args); if (wrapper && args[1]?.replace) { routeState = args[1].state; dirty = true; } } },
    '../contexts/AuthContext.jsx': { useAuth: () => auth }, '../utils/result-drafts.js': drafts,
    '../utils/caption-ideas.js': ideas, '../utils/subtitle-review.js': review, '../utils/format-segment-time.js': { formatSegmentTime } };
  const timer = (kind, fn, ms) => { const id = ++nextTimer; timers.set(id, { kind, fn, ms }); return id; };
  const documentNodes = new Map(), documentEvents = [];
  const module = { exports: {} };
  runInNewContext(compiled, { module, exports: module.exports, require: (name) => { assert.ok(deps[name], name); return deps[name]; }, sessionStorage: store,
    AbortController, Blob, File, crypto: { randomUUID: () => 'synthetic-request' },
    window: { setInterval: (fn, ms) => timer('interval', fn, ms), clearInterval: (id) => timers.delete(id), requestAnimationFrame: (fn) => timer('frame', fn, 0) },
    setTimeout: (fn, ms) => timer('timeout', fn, ms), clearTimeout: (id) => timers.delete(id),
    URL: { createObjectURL: (value) => { const url = `blob:synthetic-${++nextUrl}`; urls.push({ url, value }); return url; }, revokeObjectURL: (url) => revoked.push(url) },
    document: { body: { appendChild() {} }, createElement: () => ({ click() {}, remove() {} }),
      getElementById(id) {
        if (!documentNodes.has(id)) documentNodes.set(id, { open: false,
          focus: () => documentEvents.push('focus:' + id), scrollIntoView: () => documentEvents.push('scroll:' + id),
          querySelector: () => ({ focus: () => documentEvents.push('focus:' + id) }) });
        return documentNodes.get(id);
      } },
    alert() {}, fetch: async (url, options = {}) => {
      const row = { url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined }; requests.push(row);
      if (url === '/api/download') return new Response('synthetic download');
      if (/^\/api\/auth\/transcription\/\d+\/segments$/.test(url) && row.method === 'PUT') return saveError ? Response.json({ error: saveError }, { status: 400 }) : Response.json({ ok: true });
      throw new Error(`Unexpected synthetic request: ${url}`);
    } });
  function media(url) {
    if (!mediaByUrl.has(url)) mediaByUrl.set(url, { duration: 10, currentTime: 0, paused: true, plays: 0, pauses: 0,
      play() { this.plays++; this.paused = false; return this.pendingPlay || Promise.resolve(); }, pause() { this.pauses++; this.paused = true; }, removeAttribute() {}, load() {} });
    return mediaByUrl.get(url);
  }
  const expand = (node) => {
    if (Array.isArray(node)) return node.map(expand);
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') return expand(node.type(node.props));
    if (node.type === 'audio') node.props.ref.current = media(node.props.src);
    return { ...node, props: { ...node.props, children: expand(node.props.children) } };
  };
  const result = { segments, text: segments.map(({ text }) => text).join('\n'), transcriptionLogId: logId, ownerId: owner, holdShortGaps, language, diarize };
  const settle = async () => { for (let i = 0; i < 60; i++) {
    if (dirty) {
      dirty = false; cursor = 0;
      if (wrapper) {
        hooks = wrapperHooks; const outer = module.exports.default();
        if (editorKey !== undefined && editorKey !== outer.key) { editorHooks.forEach((hook) => hook?.cleanup?.()); editorHooks.length = 0; }
        editorKey = outer.key; editorKeys.push(editorKey); hooks = editorHooks; cursor = 0; tree = expand(outer);
      } else {
        hooks = editorHooks; tree = expand(module.exports.ResultEditor({ ...(single ? { resultState: incoming ? result : null, serverVerified } : { resultOverride: result }), onRegisterFlush: (fn) => { if (fn) flush = fn; } }));
      }
    }
    effects.splice(0).forEach((fn) => fn()); await new Promise(setImmediate); if (!dirty && !effects.length) return;
  } throw new Error('fixture did not settle'); };
  const nodes = (node = tree, output = []) => { if (Array.isArray(node)) node.forEach((x) => nodes(x ?? null, output)); else if (node && typeof node === 'object') { output.push(node); nodes(node.props.children ?? null, output); } return output; };
  const text = (node) => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props.children) : node ?? '';
  await settle();
  return { settle, nodes, text, requests, store, result, urls, revoked, mediaByUrl, navigations, editorKeys, documentNodes, documentEvents,
    byId: (id) => nodes().find((node) => node.props.id === id),
    button: (label) => nodes().find((node) => node.type === 'button' && (text(node) === label || (label === 'SRT' && text(node).includes('SRT')))),
    mainText: () => nodes().find((node) => node.type === 'textarea' && node.props['aria-label'] === '자막 구간 1'),
    async segmentsMode() { nodes().find((node) => node.props.id === 'editor-tab-segments').props.onClick(); await settle(); },
    flush: async () => { await flush(); await settle(); },
    async autosave() { for (const [id, entry] of [...timers]) if (entry.kind === 'timeout' && entry.ms === 1500) { timers.delete(id); await entry.fn(); } await settle(); },
    async frames() { for (const [id, entry] of [...timers]) if (entry.kind === 'frame') { timers.delete(id); await entry.fn(); } await settle(); },
    tickIntervals() { for (const entry of [...timers.values()]) if (entry.kind === 'interval') entry.fn(); },
    async setAuth(id) { auth = { user: { id }, token: 'synthetic-token' }; dirty = true; await settle(); },
    unmount() { for (const node of nodes()) if (node.type === 'audio') node.props.ref.current = null; [...editorHooks, ...wrapperHooks].forEach((hook) => hook?.cleanup?.()); },
  };
}

test('client normalizes shared start evidence and includes status-only choices in save signatures', () => {
  const segment = candidateSegment(), before = structuredClone(segment);
  const normalized = review.normalizeSubtitleReview(segment.subtitleReview, segment.text);
  assert.deepEqual(normalized.localStart, normalizeLocalStartEvidence(segment.subtitleReview.localStart));
  const restored = review.setLocalStartEvidenceStatus(segment, 'restored');
  assert.notEqual(review.subtitleEditSignature([segment]), review.subtitleEditSignature([restored]));
  assert.deepEqual([restored.start, restored.end, restored.text, restored.audioStartFloor, restored.fixedCuePlan],
    [segment.start, segment.end, segment.text, segment.audioStartFloor, segment.fixedCuePlan]);
  assert.equal(restored.subtitleReview.timingConfirmation, undefined);
  assert.equal(review.getBoundLocalStartEvidence(restored).status, 'restored');
  assert.equal(getLocalStartCueMinimum(restored, { start: 3, end: 4, text: '다음 합성 구간' }), undefined);
  assert.equal(getLocalStartCueMinimum(review.setLocalStartEvidenceStatus(restored, 'automatic'), { start: 3, end: 4, text: '다음 합성 구간' }), 3.4);
  for (const changed of [{ text: '다른 문구' }, { start: 1.001 }, { end: 4.001 }, { speaker: 0 }]) {
    assert.equal(review.getBoundLocalStartEvidence({ ...segment, ...changed }), undefined);
  }
  const invalid = { ...segment.subtitleReview, localStart: { ...segment.subtitleReview.localStart, cues: [[1, 1.5, '첫 합성 안내', 1.5]] } };
  assert.equal(review.normalizeSubtitleReview(invalid, segment.text).localStart, undefined);
  assert.deepEqual(segment, before);
});

test('real content/range changes and correction restoration invalidate evidence while unchanged confirmations retain it', () => {
  const segment = candidateSegment(), original = structuredClone(segment);
  for (const changed of [review.editSubtitleText(segment, '수동 합성 문구'), review.confirmSubtitleCandidate(segment, '직접 확인한 합성 문구'),
    review.confirmSubtitleTiming(segment, 1.1, 4), review.restoreFixedCuePlan(segment)]) {
    assert.equal(changed.subtitleReview.localStart, undefined);
    assert.equal(changed.audioStartFloor, segment.audioStartFloor);
    assert.equal(review.getBoundLocalStartEvidence(changed), undefined);
  }
  for (const unchanged of [review.editSubtitleText(segment, segment.text), review.confirmSubtitleCandidate(segment, segment.text),
    review.confirmSubtitleTiming(segment, segment.start, segment.end)]) {
    assert.deepEqual(review.getBoundLocalStartEvidence(unchanged), segment.subtitleReview.localStart);
  }
  assert.equal(review.validateSubtitleTiming([segment], 0, 1, 4), null);
  assert.match(review.validateSubtitleTiming([segment], 0, 0.499, 4), /하한/);
  assert.deepEqual(segment, original);
});

test('start choices survive owned drafts, acknowledged caches and batch flush while unsigned or newer evidence bases cannot revive them', async () => {
  const segment = candidateSegment(), restored = review.setLocalStartEvidenceStatus(segment, 'restored'), store = storage();
  const initial = { ownerId: 'owner', transcriptionLogId: 101, segments: [segment], text: segment.text };
  store.setItem(drafts.lastResultKey('owner'), JSON.stringify(initial));
  drafts.writeResultDraft(store, 'owner', 101, { segments: [restored], baseSignature: review.subtitleEditSignature([segment]), fullTextDraft: segment.text });
  assert.equal(drafts.readResultDraft(store, 'owner', 101, [segment]).segments[0].subtitleReview.localStart.status, 'restored');
  assert.equal(drafts.readResultDraft(store, 'other', 101, [segment]), null);
  assert.equal(drafts.readResultDraft(store, 'owner', 102, [segment]), null);
  const newer = candidateSegment(); newer.subtitleReview.localStart.cues[1][3] = 3.5;
  assert.equal(drafts.readResultDraft(store, 'owner', 101, [newer]), null);
  const saved = drafts.cacheSavedResult(store, 'owner', 101, initial, [restored], drafts.resultSnapshotSignature(initial));
  assert.equal(drafts.resolveSavedResult(store, 'owner', initial).segments[0].subtitleReview.localStart.status, 'restored');
  assert.equal(drafts.resolveSavedResult(store, 'owner', initial, true), initial);
  assert.equal(drafts.cacheSavedResult(store, 'owner', 101, initial, [segment], drafts.resultSnapshotSignature(initial)), null);
  const calls = []; let server = [segment];
  const options = { items: [{ status: 'completed', transcriptionLogId: 101 }], storage: store, ownerId: 'owner',
    fetchLog: async () => ({ segments: server }), saveLog: async (id, segments) => { calls.push({ id, segments }); server = segments; } };
  await assert.rejects(drafts.flushStoredBatchDrafts({ ...options, saveLog: async () => { throw new Error('synthetic failure'); } }), /synthetic failure/);
  await drafts.flushStoredBatchDrafts(options); await drafts.flushStoredBatchDrafts(options);
  assert.equal(calls.length, 1); assert.equal(calls[0].segments[0].subtitleReview.localStart.status, 'restored');
  assert.deepEqual(calls[0].segments[0].fixedCuePlan, segment.fixedCuePlan);
  for (const old of [{ baseSignature: undefined, baseText: segment.text }, { baseSignature: JSON.stringify([{ text: segment.text, subtitleReview: { version: 1, issues: [] } }]) }]) {
    drafts.writeResultDraft(store, 'owner', 101, { segments: [restored], ...old });
    assert.equal(drafts.readResultDraft(store, 'owner', 101, [segment]), null);
  }
  assert.equal(saved.segments[0].start, segment.start);
});

test('actual editor lists a standalone suspect and opens its own review without treating signal as verified speech', async () => {
  const segment = suspiciousSegment(), page = await fixture({ segments: [segment] });
  assert.ok(page.byId('review-row-link-0'));
  assert.match(page.text(page.nodes()), /음향 신호 있음 · 발화·문구 일치 미확인/);
  page.byId('review-row-link-0').props.onClick(); await page.settle(); await page.frames();
  assert.equal(page.documentNodes.get('review-details-0').open, true);
  assert.ok(page.documentEvents.includes('scroll:subtitle-segment-0'));
  assert.ok(page.documentEvents.includes('focus:review-details-0'));
  assert.equal(page.byId('editor-tab-segments').props['aria-selected'], true);
  assert.equal(page.requests.length, 0);
  assert.equal(page.text(page.byId('review-exclusion-action-0')), '이 구간 제외');
  page.byId('review-exclusion-action-0').props.onClick(); await page.settle(); await page.flush();
  const saved = page.requests.find(({ method }) => method === 'PUT').body.segments[0];
  assert.equal(saved.text, segment.text); assert.equal(saved.start, segment.start); assert.equal(saved.end, segment.end);
  assert.equal(saved.subtitleReview.localExclusion.status, 'user');
});

test('actual editor distinguishes exact zero, signal, unavailable and not-checked audio without confirming words', async () => {
  for (const [status, label] of [['exact_zero', '모든 원채널의 디지털 0 확인'], ['signal_present', '음향 신호 있음'],
    ['unavailable', '오디오 검증 결과 없음'], ['not_checked', '오디오 미검증']]) {
    const page = await fixture({ segments: [suspiciousSegment(status)] }); await page.segmentsMode();
    assert.match(page.text(page.nodes()), new RegExp(label));
    assert.doesNotMatch(page.text(page.nodes()), /음성 없음|싱크 확정|문구 확인됨/);
    assert.equal(page.text(page.byId('review-exclusion-action-0')), '이 구간 제외');
  }
});

test('actual compact row presents cue-specific starts and metadata-only restore is saved, reloaded and downloaded', async () => {
  const segment = candidateSegment(), store = storage(), page = await fixture({ segments: [segment], store, single: true });
  await page.segmentsMode();
  assert.match(page.text(page.nodes()), /SRT에는 인식된 대사만 포함되며, 현재 큐와 일치하는 검증된 시작 하한을 반영합니다\. 글자 크기는 편집 프로그램에 따라 달라질 수 있습니다\./);
  assert.doesNotMatch(page.text(page.nodes()), /첫 대사의 타임코드와 원문을 유지합니다/);
  const detail = page.text(page.byId('review-local-start-0'));
  assert.match(detail, /보정 전 시작 00:01\.000 → 최종 큐 일치 시 시작 00:01\.200/);
  assert.match(detail, /보정 전 시작 00:03\.000 → 최종 큐 일치 시 시작 00:03\.400/);
  assert.match(detail, /이웃 자막 편집으로 최종 큐가 달라지면 적용하지 않/);
  assert.doesNotMatch(detail, /음소 정답|시간 수동 확인/);
  assert.equal(page.byId('review-start-0').props.value, '1.000');
  assert.equal(page.byId('review-end-0').props.value, '4.000');
  page.byId('review-local-start-action-0').props.onClick(); await page.settle(); await page.autosave(); await page.flush();
  assert.match(page.text(page.nodes()), /SRT에는 인식된 대사만 포함되며 첫 대사의 타임코드와 원문을 유지합니다\. 글자 크기는 편집 프로그램에 따라 달라질 수 있습니다\./);
  assert.doesNotMatch(page.text(page.nodes()), /현재 큐와 일치하는 검증된 시작 하한을 반영합니다/);
  const saved = page.requests.find(({ method }) => method === 'PUT').body.segments[0];
  assert.equal(saved.subtitleReview.localStart.status, 'restored');
  assert.equal(saved.subtitleReview.timingConfirmation, undefined);
  assert.deepEqual([saved.start, saved.end, saved.fixedCuePlan], [segment.start, segment.end, segment.fixedCuePlan]);
  page.unmount();
  const reloaded = await fixture({ segments: [segment], store, single: true, incoming: false }); await reloaded.segmentsMode();
  assert.match(reloaded.text(reloaded.byId('review-local-start-0')), /원래 시작 사용/);
  assert.match(reloaded.text(reloaded.byId('review-local-start-0')), /보정 전 시작 00:03\.000 → 최종 큐 일치 시 시작 00:03\.000/);
  reloaded.button('SRT').props.onClick(); await reloaded.settle();
  assert.equal(reloaded.requests.find(({ url }) => url === '/api/download').body.segments[0].subtitleReview.localStart.status, 'restored');
  reloaded.byId('review-local-start-action-0').props.onClick(); await reloaded.settle(); await reloaded.flush();
  assert.match(reloaded.text(reloaded.nodes()), /현재 큐와 일치하는 검증된 시작 하한을 반영합니다/);
  assert.equal(reloaded.requests.findLast(({ method }) => method === 'PUT').body.segments[0].subtitleReview.localStart.status, 'automatic');
});

test('actual automatic-start actions reject stale rows, owners and mismatched full-text input immediately', async () => {
  for (const change of ['text', 'owner', 'line-count']) {
    const page = await fixture({ segments: [candidateSegment()] }); await page.segmentsMode();
    const captured = page.byId('review-local-start-action-0').props.onClick;
    if (change === 'text') page.mainText().props.onChange({ target: { value: '직접 바꾼 합성 문구' } });
    if (change === 'owner') await page.setAuth('other');
    if (change === 'line-count') {
      page.byId('editor-tab-text').props.onClick(); await page.settle();
      page.byId('full-transcript').props.onChange({ target: { value: '첫 줄\n추가 줄' } });
    }
    captured(); await page.settle();
    if (change === 'text') { await page.flush(); assert.equal(page.requests.find(({ method }) => method === 'PUT').body.segments[0].subtitleReview.localStart, undefined); }
    if (change === 'line-count') { await page.segmentsMode(); assert.equal(page.byId('review-local-start-action-0').props.disabled, true); }
    assert.equal(page.requests.some(({ method, body }) => method === 'PUT' && body.segments.some((segment) => segment.subtitleReview?.localStart?.status === 'restored')), false);
  }
});

test('actual source-backed unchanged range confirmation retains start evidence while a real time edit invalidates it', async () => {
  for (const changedRange of [false, true]) {
    const segment = candidateSegment(), page = await fixture({ segments: [segment] }); await page.segmentsMode();
    page.byId('review-source-audio').props.onChange({ target: { files: [new File(['synthetic audio'], 'synthetic.wav', { type: 'audio/wav' })], value: 'synthetic' } });
    await page.settle();
    const playerNode = page.nodes().find((node) => node.type === 'audio'), player = page.mediaByUrl.get(playerNode.props.src);
    playerNode.props.onLoadedMetadata({ currentTarget: player }); await page.settle();
    if (changedRange) {
      page.byId('review-start-0').props.onChange({ target: { value: '1.100' } }); await page.settle();
    }
    page.button('이 시간 적용·확인').props.onClick(); await page.settle(); await page.flush();
    const saved = page.requests.find(({ method }) => method === 'PUT').body.segments[0];
    assert.equal(saved.timingSource, 'manual'); assert.equal(saved.audioStartFloor, segment.audioStartFloor);
    if (changedRange) {
      assert.equal(saved.start, 1.1); assert.equal(saved.subtitleReview.localStart, undefined); assert.equal(saved.fixedCuePlan, undefined);
    } else {
      assert.deepEqual(saved.subtitleReview.localStart, segment.subtitleReview.localStart);
      assert.deepEqual(saved.fixedCuePlan, segment.fixedCuePlan);
    }
    assert.equal(page.requests.some(({ method }) => method !== 'PUT'), false);
  }
});

test('actual editor hides stale start bindings and speaker-labelled evidence rather than suggesting an active correction', async () => {
  for (const change of [{ text: '현재의 다른 합성 문구' }, { start: 1.001 }, { end: 4.001 }, { speaker: 0 }]) {
    const segment = { ...candidateSegment(), ...change }, page = await fixture({ segments: [segment] }); await page.segmentsMode();
    assert.equal(page.byId('review-local-start-0'), undefined);
    assert.equal(page.byId('review-local-start-action-0'), undefined);
    assert.equal(page.byId('review-row-link-0'), undefined);
    assert.equal(page.mainText().props.value, segment.text);
  }
});

test('actual unsupported and limited analysis retain content and provide a reason with no misleading restoration action', async () => {
  for (const [reason, label] of [['unsupported_audio', '지원되지 않는 오디오 형식'], ['analysis_limit', '오디오 분석 한도'],
    ['decode_failed', '오디오 해석 실패'], ['origin_unverified', '오디오 시간 원점 미검증'],
    ['partial_verification_unavailable', '일부 내부 큐의 오디오 검증 미완료'], ['future_reason', '오디오 검증 불가']]) {
    const segment = unavailableSegment(reason), page = await fixture({ segments: [segment] }); await page.segmentsMode();
    assert.match(page.text(page.byId('review-local-start-0')), new RegExp(label));
    assert.match(page.text(page.byId('review-local-start-0')), /기존 자막을 유지/);
    assert.match(page.text(page.nodes()), /첫 대사의 타임코드와 원문을 유지합니다/);
    assert.equal(page.byId('review-local-start-action-0'), undefined);
    assert.equal(page.byId('review-row-link-0'), undefined);
    assert.equal(page.mainText().props.value, segment.text);
    page.button('SRT').props.onClick(); await page.settle();
    assert.equal(page.requests.find(({ url }) => url === '/api/download').body.segments[0].subtitleReview.localStart.reason, reason);
  }
});

test('actual large unavailable results expose reason counts without a long list of unactionable row links', async () => {
  const segments = Array.from({ length: 400 }, (_, index) => {
    const start = index * 5, end = start + 4, text = `합성 안내 ${index}`;
    return { start, end, text, subtitleReview: { version: 1, issues: [], localStart: { version: 1, status: 'unavailable',
      binding: { start, end, text }, cues: [], reason: index < 300 ? 'analysis_limit' : 'unsupported_audio' } } };
  });
  const page = await fixture({ segments });
  const text = page.text(page.nodes());
  assert.match(text, /시작 하한 미검증 400개 행/);
  assert.match(text, /300개 행 · 오디오 분석 한도/);
  assert.match(text, /100개 행 · 지원되지 않는 오디오 형식/);
  assert.match(text, /분석한 오디오 창 수가 아닌 자막 행 수/);
  assert.equal(page.nodes().filter((node) => /^review-row-link-/.test(node.props.id || '')).length, 0);
  await page.segmentsMode();
  assert.ok(page.byId('review-local-start-399'));
  assert.equal(page.mainText().props.value, segments[0].text);
});

test('backend-produced verified and unavailable row evidence reaches actual ResultEditor without changing source timing', async () => {
  for (const verified of [true, false]) {
    const segment = candidateSegment(); delete segment.subtitleReview.localStart;
    const annotated = await annotateLocalStartEvidence([segment], { buffer: Buffer.from('synthetic audio'), originalname: 'synthetic.wav', language: 'ko',
      analyzeAudio: async (_buffer, { ranges }) => ({ measurements: ranges.map(({ start, end }) => verified
        ? { start, end, status: 'verified', minimumStart: start + 0.1, sampleRate: 48_000, channels: 2, method: 'native_wav' }
        : { start, end, status: 'unavailable', reason: 'analysis_limit' }), windowAudits: [] }) });
    const produced = annotated.segments[0];
    assert.deepEqual([produced.start, produced.end, produced.fixedCuePlan], [segment.start, segment.end, segment.fixedCuePlan]);
    assert.equal(produced.subtitleReview.localStart.status, verified ? 'automatic' : 'unavailable');
    const page = await fixture({ segments: annotated.segments }); await page.segmentsMode();
    assert.match(page.text(page.byId('review-local-start-0')), verified ? /최종 큐 일치 시 적용/ : /오디오 분석 한도/);
    assert.equal(Boolean(page.byId('review-local-start-action-0')), verified);
    page.button('SRT').props.onClick(); await page.settle();
    assert.deepEqual(page.requests.find(({ url }) => url === '/api/download').body.segments[0].subtitleReview.localStart, produced.subtitleReview.localStart);
  }
});

test('actual correction and polish restoration invalidate only the old start evidence and keep original cue restoration intact', async () => {
  const segment = candidateSegment(), page = await fixture({ segments: [segment] }); await page.segmentsMode();
  page.byId('review-correction-restore-0').props.onClick(); await page.settle(); await page.flush();
  const saved = page.requests.find(({ method }) => method === 'PUT').body.segments[0];
  assert.equal(saved.subtitleReview.localStart, undefined);
  assert.equal(saved.text, segment.fixedCuePlan.original.text);
  assert.deepEqual(saved.fixedCuePlan.cues, segment.fixedCuePlan.original.cues);
  assert.equal(saved.subtitleReview.correctionStatus, 'restored');
  const plainRow = candidateSegment(); delete plainRow.fixedCuePlan; delete plainRow.subtitleReview.correctionBinding; delete plainRow.subtitleReview.correctionStatus;
  plainRow.timingSource = 'word'; plainRow.grammarPolish = { status: 'applied', originalText: '다듬기 전 합성 문구', originalTimingSource: 'word' };
  const polish = await fixture({ segments: [plainRow] });
  polish.button('다듬기 전 문장으로 복원').props.onClick(); await polish.settle(); await polish.flush();
  const restored = polish.requests.find(({ method }) => method === 'PUT').body.segments[0];
  assert.equal(restored.subtitleReview.localStart, undefined); assert.equal(restored.text, plainRow.grammarPolish.originalText);
  assert.equal(restored.audioStartFloor, plainRow.audioStartFloor);
});
