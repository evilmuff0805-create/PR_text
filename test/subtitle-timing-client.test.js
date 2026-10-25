import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { transformWithEsbuild } from 'vite';
import * as review from '../client/src/utils/subtitle-review.js';
import * as drafts from '../client/src/utils/result-drafts.js';
import * as ideas from '../client/src/utils/caption-ideas.js';
import { formatSegmentTime } from '../client/src/utils/format-segment-time.js';
import { buildSubtitleCues, generateASS, generateSRT } from '../src/services/subtitle.js';

const storage = () => { const values = new Map(); return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key), values }; };
const candidateSegment = () => ({ start: 2, end: 2.2, text: '합성 안내', audioStartFloor: 1.8, timingSource: 'word',
  sourceWords: [{ start: 2, end: 2.2, word: '합성 안내' }], wordAlignedCues: [[2, 2.2, '합성 안내']], subtitleReview: {
    version: 1, issues: [{ code: 'audio_recheck_word_timing' }], timingStatus: 'unverified',
    timingCandidate: { sourceStart: 2, sourceEnd: 2.2, start: 2.4, end: 2.7, matchingText: '합성 안내', status: 'unverified', windowCount: 3, startSpread: .6, endSpread: .5 },
  } });
const withNeighbours = (source = candidateSegment()) => [source, { start: 3.1, end: 4, text: '다음 합성 안내' }];

test('time candidates require exact current text and source range and retain only bounded numeric evidence', () => {
  const source = candidateSegment(), before = structuredClone(source);
  assert.deepEqual(review.getSubtitleTimingCandidate(source), source.subtitleReview.timingCandidate);
  for (const changed of [{ text: '다른 안내' }, { start: 2.001 }, { end: 2.201 }]) {
    assert.equal(review.getSubtitleTimingCandidate({ ...source, ...changed }), undefined);
  }
  for (const changed of [{ start: -1 }, { start: NaN }, { end: 2.3 }, { sourceStart: -1 }, { sourceEnd: 2 }, { matchingText: '' }, { status: 'confirmed' }]) {
    const value = { ...source.subtitleReview, timingCandidate: { ...source.subtitleReview.timingCandidate, ...changed } };
    assert.equal(review.normalizeSubtitleReview(value, source.text).timingCandidate, undefined);
  }
  const normalized = review.normalizeSubtitleReview({ ...source.subtitleReview, arbitrary: 'ignored', timingCandidate: {
    ...source.subtitleReview.timingCandidate, windowCount: 100, startSpread: -1, endSpread: Infinity, arbitrary: 'ignored',
  } }, source.text);
  assert.deepEqual(normalized.timingCandidate, { sourceStart: 2, sourceEnd: 2.2, start: 2.4, end: 2.7, matchingText: source.text, status: 'unverified' });
  const issues = ['audio_boundary_estimate_updated', 'audio_boundary_candidate', 'audio_boundary_inconclusive'].map((code) => ({ code, sourceStart: 2, sourceEnd: 2.2, cueStart: 2.4, cueEnd: 2.7 }));
  const withBoundaryIssues = { ...source, subtitleReview: { ...source.subtitleReview, issues } };
  assert.deepEqual(review.normalizeSubtitleReview(withBoundaryIssues.subtitleReview, source.text).issues, issues);
  assert.deepEqual(review.confirmSubtitleTiming(withBoundaryIssues, 2.4, 2.7).subtitleReview.issues, issues);
  for (const issue of issues) {
    assert.match(review.subtitleReviewIssueLabel(issue), /발화 싱크 미확인/);
    assert.doesNotMatch(review.subtitleReviewIssueLabel(issue), /확인됨|확정/);
  }
  assert.deepEqual(source, before);
});

test('manual time parsing accepts milliseconds and clock notation without coercing invalid input', () => {
  for (const [input, expected] of [['0', 0], ['338.125', 338.125], [' 338.1 ', 338.1], ['00:05:38.125', 338.125], ['01:00:00.001', 3600.001], ['100:00:00.000', 360000]]) {
    assert.equal(review.parseSubtitleTimeInput(input), expected, input);
  }
  for (const input of ['', ' ', '-1', '+1', 'NaN', 'Infinity', '0x10', '1e3', '1.2345', '1.', '.1', '00:60:00.000', '00:00:60.000', '5:38.125', '00:01:02.1234', '9'.repeat(400), null, 2]) {
    assert.ok(Number.isNaN(review.parseSubtitleTimeInput(input)), String(input));
  }
  assert.equal(review.formatSubtitleTimeInput(338.125), '338.125');
  assert.equal(review.formatSubtitleTimeInput(10.0044, { isStart: true }), '10.005');
  assert.equal(review.formatSubtitleTimeInput(10.0044), '10.004');
  assert.equal(review.formatSubtitleTimeInput(NaN), '');
});

test('manual timing rejects invalid, overlapping, below-floor and beyond-duration ranges', () => {
  const segments = [{ start: 0, end: 1.9, text: '앞 안내' }, candidateSegment(), { start: 3.1, end: 4, text: '뒤 안내' }];
  assert.equal(review.validateSubtitleTiming(segments, 1, 1.9, 3.1, { durationSeconds: 10 }), null);
  for (const [start, end] of [[NaN, 2.7], [-1, 2.7], [2.5, 2.5], [2.7, 2.5], [1.899, 2.7], [2.4, 3.101]]) {
    assert.ok(review.validateSubtitleTiming(segments, 1, start, end, { durationSeconds: 10 }));
  }
  assert.match(review.validateSubtitleTiming([candidateSegment()], 0, 1.799, 2.7), /하한/);
  assert.match(review.validateSubtitleTiming([candidateSegment()], 0, 2.4, 10.001, { durationSeconds: 10 }), /재생 길이/);
});

test('explicit time confirmation preserves the first range and floor, invalidates word evidence and survives later text edits', () => {
  const source = candidateSegment(), before = structuredClone(source);
  const confirmed = review.confirmSubtitleTiming(source, 2.4, 2.7);
  assert.deepEqual([confirmed.start, confirmed.end, confirmed.text, confirmed.audioStartFloor, confirmed.timingSource], [2.4, 2.7, source.text, 1.8, 'manual']);
  assert.equal(confirmed.sourceWords, undefined); assert.equal(confirmed.wordAlignedCues, undefined);
  assert.equal(confirmed.subtitleReview.timingCandidate, undefined);
  assert.deepEqual(confirmed.subtitleReview.originalTiming, { start: 2, end: 2.2 });
  assert.equal(review.getSubtitleTimingConfirmation(confirmed).status, 'confirmed');
  const twice = review.confirmSubtitleTiming(confirmed, 2.5, 2.8);
  assert.deepEqual(twice.subtitleReview.originalTiming, { start: 2, end: 2.2 });
  assert.deepEqual([twice.subtitleReview.timingConfirmation.sourceStart, twice.subtitleReview.timingConfirmation.sourceEnd], [2, 2.2]);
  for (const changed of [{ start: 2.501 }, { text: '수동으로 고친 안내' }, { subtitleReview: { ...twice.subtitleReview, originalTiming: { start: 1, end: 2.2 } } }]) {
    assert.equal(review.getSubtitleTimingConfirmation({ ...twice, ...changed }), undefined);
  }
  const textEdited = review.editSubtitleText(twice, '수동으로 고친 안내');
  assert.equal(textEdited.subtitleReview.timingConfirmation, undefined);
  assert.deepEqual([textEdited.start, textEdited.end, textEdited.timingSource], [2.5, 2.8, 'manual']);
  assert.deepEqual(textEdited.subtitleReview.originalTiming, { start: 2, end: 2.2 });
  assert.notEqual(review.subtitleEditSignature([source]), review.subtitleEditSignature([{ ...source, start: 2.001 }]));
  assert.deepEqual(source, before);
});

test('time-only and time-then-text drafts restore manual ranges while stale source bindings and legacy time edits fail', () => {
  const source = candidateSegment(), confirmed = review.confirmSubtitleTiming(source, 2.4, 2.7), store = storage();
  const write = (segment, extras = {}) => drafts.writeResultDraft(store, 'owner', 101, { segments: [segment], baseText: source.text, baseSignature: review.subtitleEditSignature([source]), ...extras });
  for (const segment of [confirmed, review.editSubtitleText(confirmed, '다시 편집한 안내')]) {
    write(segment);
    const restored = drafts.readResultDraft(store, 'owner', 101, [source]).segments[0];
    assert.deepEqual(restored, segment);
    assert.equal(drafts.readResultDraft(store, 'other', 101, [source]), null);
    assert.equal(drafts.readResultDraft(store, 'owner', 102, [source]), null);
    assert.equal(drafts.readResultDraft(store, 'owner', 101, [{ ...source, start: 2.001 }]), null);
  }
  for (const segment of [
    { ...confirmed, timingSource: 'word' },
    { ...confirmed, start: 2.401 },
    { ...confirmed, subtitleReview: { ...confirmed.subtitleReview, originalTiming: { start: 1.9, end: 2.2 } } },
    { ...confirmed, subtitleReview: { ...confirmed.subtitleReview, timingConfirmation: { ...confirmed.subtitleReview.timingConfirmation, matchingText: '다른 안내' } } },
    { ...review.confirmSubtitleTiming({ ...source, audioStartFloor: undefined }, 1.7, 2.7), audioStartFloor: undefined },
  ]) { write(segment); assert.equal(drafts.readResultDraft(store, 'owner', 101, [source]), null); }
  const legacySignature = JSON.stringify([{ text: source.text, subtitleReview: review.normalizeSubtitleReview(source.subtitleReview, source.text) }]);
  write({ ...source, text: '이전 형식의 문구 초안' }, { baseSignature: legacySignature });
  assert.equal(drafts.readResultDraft(store, 'owner', 101, [source]).segments[0].text, '이전 형식의 문구 초안');
  write(confirmed, { baseSignature: legacySignature });
  assert.equal(drafts.readResultDraft(store, 'owner', 101, [source]), null);
  write(confirmed, { baseSignature: undefined });
  assert.equal(drafts.readResultDraft(store, 'owner', 101, [source]), null);
});

test('time edits enter exact-anchor single caches and batch ZIP flushing with their chosen ranges', async () => {
  const source = candidateSegment(), confirmed = review.confirmSubtitleTiming(source, 2.4, 2.7), store = storage();
  const initial = { ownerId: 'owner', transcriptionLogId: 101, segments: [source], text: source.text };
  store.setItem(drafts.lastResultKey('owner'), JSON.stringify(initial));
  const saved = drafts.cacheSavedResult(store, 'owner', 101, initial, [confirmed], drafts.resultSnapshotSignature(initial));
  assert.deepEqual(saved.segments, [confirmed]);
  assert.deepEqual(drafts.resolveSavedResult(store, 'owner', initial).segments, [confirmed]);
  assert.equal(drafts.resolveSavedResult(store, 'owner', initial, true), initial);
  assert.equal(drafts.cacheSavedResult(store, 'owner', 101, initial, [{ ...confirmed, start: 2.401 }], drafts.resultSnapshotSignature(saved)), null);
  const twice = review.editSubtitleText(review.confirmSubtitleTiming(confirmed, 2.5, 2.8), '시간 조정 뒤 편집 문구');
  assert.deepEqual(drafts.cacheSavedResult(store, 'owner', 101, saved, [twice], drafts.resultSnapshotSignature(saved)).segments, [twice]);
  drafts.writeResultDraft(store, 'owner', 101, { segments: [confirmed], fullTextDraft: confirmed.text, baseSignature: review.subtitleEditSignature([source]) });
  const calls = []; let server = [source];
  const options = { items: [{ status: 'completed', transcriptionLogId: 101 }], storage: store, ownerId: 'owner', fetchLog: async () => ({ segments: server }), saveLog: async (id, segments) => { calls.push({ id, segments }); server = segments; } };
  await drafts.flushStoredBatchDrafts(options); await drafts.flushStoredBatchDrafts(options);
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].segments, [confirmed]);
});

test('manual range exports stay inside the selected speech range and keep ordinary single display hold separate', () => {
  const source = { start: 2, end: 4, text: '이번 합성 안내를 차근차근 살펴보고 다음 작업의 순서를 함께 확인합니다', timingSource: 'word',
    wordAlignedCues: [[2.1, 2.8, '이번 합성 안내를 차근차근 살펴보고'], [2.9, 3.8, '다음 작업의 순서를 함께 확인합니다']] };
  const manual = review.confirmSubtitleTiming(source, 2.5, 4.4), next = { start: 5.2, end: 6, text: '다음 안내' };
  const speech = buildSubtitleCues([manual, next], { holdShortGaps: false });
  assert.equal(speech[0].start, 2.5);
  assert.equal(speech.at(-2).end, 4.4);
  assert.ok(speech.filter(({ text }) => text !== next.text).every(({ start, end, text }) => start >= 2.5 && end <= 4.4 && text.length <= 28));
  const held = buildSubtitleCues([manual, next]);
  assert.equal(held.at(-2).end, 5.2);
  assert.match(generateSRT([manual, next], null, { holdShortGaps: false }), /00:00:02,500 -->/);
  assert.match(generateASS([manual, next], { holdShortGaps: false }), /Dialogue: 0,0:00:02\.50,/);
});

let compiled;
async function fixture({ segments = withNeighbours(), store = storage(), owner = 'owner', logId = 101, holdShortGaps = true, single = false, incoming = true, serverVerified = false, diarize = false } = {}) {
  compiled ||= (await transformWithEsbuild(await readFile(new URL('../client/src/pages/ResultPage.jsx', import.meta.url), 'utf8'), 'ResultPage.jsx', { loader: 'jsx', format: 'cjs', jsx: 'automatic' })).code;
  const hooks = [], effects = [], timers = new Map(), requests = [], urls = [], revoked = [], mediaByUrl = new Map(), navigations = [];
  let cursor = 0, dirty = true, tree, nextTimer = 0, nextUrl = 0, flush;
  let auth = { user: { id: owner }, token: 'synthetic-token' };
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    memo: (fn) => fn,
    useState(initial) { const n = cursor++; if (!(n in hooks)) hooks[n] = { value: typeof initial === 'function' ? initial() : initial }; return [hooks[n].value, (next) => { const value = typeof next === 'function' ? next(hooks[n].value) : next; if (!Object.is(value, hooks[n].value)) { hooks[n].value = value; dirty = true; } }]; },
    useRef(initial) { const n = cursor++; return hooks[n] ||= { current: initial }; },
    useMemo(fn, deps) { const n = cursor++; if (!same(hooks[n]?.deps, deps)) hooks[n] = { value: fn(), deps }; return hooks[n].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const n = cursor++; if (!same(hooks[n]?.deps, deps)) { const old = hooks[n]; hooks[n] = { deps }; effects.push(() => { old?.cleanup?.(); hooks[n].cleanup = fn(); }); } },
  };
  const element = (type, props, key) => ({ type, props: props || {}, key });
  const deps = { react, 'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' },
    'react-router-dom': { useLocation: () => ({ pathname: '/result' }), useNavigate: () => (...args) => navigations.push(args) },
    '../contexts/AuthContext.jsx': { useAuth: () => auth }, '../utils/result-drafts.js': drafts,
    '../utils/caption-ideas.js': ideas, '../utils/subtitle-review.js': review, '../utils/format-segment-time.js': { formatSegmentTime } };
  const timer = (kind, fn, ms) => { const id = ++nextTimer; timers.set(id, { kind, fn, ms }); return id; };
  const module = { exports: {} };
  runInNewContext(compiled, { module, exports: module.exports, require: (name) => { assert.ok(deps[name], name); return deps[name]; }, sessionStorage: store,
    AbortController, Blob, File, crypto: { randomUUID: () => 'synthetic-request' },
    window: { setInterval: (fn, ms) => timer('interval', fn, ms), clearInterval: (id) => timers.delete(id), requestAnimationFrame: (fn) => timer('frame', fn, 0) },
    setTimeout: (fn, ms) => timer('timeout', fn, ms), clearTimeout: (id) => timers.delete(id),
    URL: { createObjectURL: (value) => { const url = `blob:synthetic-${++nextUrl}`; urls.push({ url, value }); return url; }, revokeObjectURL: (url) => revoked.push(url) },
    document: { body: { appendChild() {} }, createElement: () => ({ click() {}, remove() {} }) },
    alert() {}, fetch: async (url, options = {}) => {
      const row = { url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined }; requests.push(row);
      if (url === '/api/download') return new Response('synthetic download');
      if (/^\/api\/auth\/transcription\/\d+\/segments$/.test(url) && row.method === 'PUT') return Response.json({ ok: true });
      throw new Error(`Unexpected synthetic request: ${url}`);
    } });
  const media = (url) => { if (!mediaByUrl.has(url)) mediaByUrl.set(url, { duration: 10, currentTime: 0, paused: true, plays: 0, pauses: 0,
    play() { this.plays++; this.paused = false; return Promise.resolve(); }, pause() { this.pauses++; this.paused = true; }, removeAttribute() {}, load() {} }); return mediaByUrl.get(url); };
  const expand = (node) => {
    if (Array.isArray(node)) return node.map(expand);
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') return expand(node.type(node.props));
    if (node.type === 'audio') node.props.ref.current = media(node.props.src);
    return { ...node, props: { ...node.props, children: expand(node.props.children) } };
  };
  const result = { segments, text: segments.map(({ text }) => text).join('\n'), transcriptionLogId: logId, ownerId: owner, holdShortGaps, diarize };
  const settle = async () => { for (let i = 0; i < 60; i++) {
    if (dirty) { dirty = false; cursor = 0; tree = expand(module.exports.ResultEditor({ ...(single ? { resultState: incoming ? result : null, serverVerified } : { resultOverride: result }), onRegisterFlush: (fn) => { if (fn) flush = fn; } })); }
    effects.splice(0).forEach((fn) => fn()); await new Promise(setImmediate); if (!dirty && !effects.length) return;
  } throw new Error('fixture did not settle'); };
  const nodes = (node = tree, output = []) => { if (Array.isArray(node)) node.forEach((x) => nodes(x ?? null, output)); else if (node && typeof node === 'object') { output.push(node); nodes(node.props.children ?? null, output); } return output; };
  const text = (node) => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props.children) : node ?? '';
  const byId = (id) => nodes().find((node) => node.props.id === id);
  const button = (label) => nodes().find((node) => node.type === 'button' && (text(node) === label || (label === 'SRT' && text(node).includes('SRT'))));
  await settle();
  return { settle, nodes, text, requests, store, result, urls, revoked, mediaByUrl, navigations, byId, button,
    mainText: () => nodes().find((node) => node.type === 'textarea' && node.props['aria-label'] === '자막 구간 1'),
    async segmentsMode() { byId('editor-tab-segments').props.onClick(); await settle(); },
    flush: async () => { await flush(); await settle(); },
    async autosave() { for (const [id, entry] of [...timers]) if (entry.kind === 'timeout' && entry.ms === 1500) { timers.delete(id); await entry.fn(); } await settle(); },
    async connectAudio(duration = 10) {
      byId('review-source-audio').props.onChange({ target: { files: [new File(['synthetic local bytes'], 'synthetic.wav')], value: '' } }); await settle();
      const audio = nodes().find((node) => node.type === 'audio'), player = mediaByUrl.get(audio.props.src); player.duration = duration;
      audio.props.onLoadedMetadata({ currentTarget: player }); await settle(); return player;
    },
    async inputTimes(start, end) {
      byId('review-start-0').props.onChange({ target: { value: start } }); byId('review-end-0').props.onChange({ target: { value: end } }); await settle();
    },
    async setAuth(id) { auth = { user: { id }, token: 'synthetic-token' }; dirty = true; await settle(); },
    unmount() { for (const node of nodes()) if (node.type === 'audio') node.props.ref.current = null; hooks.forEach((hook) => hook?.cleanup?.()); },
  };
}

test('actual common editor keeps time candidates detached until a local-source-backed explicit confirmation', async () => {
  for (const single of [true, false]) {
    const segments = withNeighbours(), before = structuredClone(segments), page = await fixture({ segments, single, holdShortGaps: single });
    await page.segmentsMode();
    assert.equal(page.button('이 시간 적용·확인').props.disabled, true);
    page.button('시간 후보 불러오기').props.onClick(); await page.settle(); await page.autosave();
    assert.equal(page.byId('review-start-0').props.value, '2.400'); assert.equal(page.byId('review-end-0').props.value, '2.700');
    assert.equal(page.requests.length, 0);
    page.button('이 시간 적용·확인').props.onClick(); await page.settle(); assert.equal(page.requests.length, 0);
    await page.button('SRT').props.onClick(); await page.settle();
    assert.deepEqual(page.requests.at(-1).body.segments, before);
    assert.equal(page.nodes().some((node) => node.type === 'p' && page.text(node).includes('1초 이내면 다음 자막까지 표시')), single);
    const player = await page.connectAudio();
    await page.button('입력 범위 앞뒤 듣기').props.onClick(); assert.equal(player.currentTime, 1.9);
    assert.equal(page.requests.filter(({ method }) => method === 'PUT').length, 0);
    const apply = page.button('이 시간 적용·확인').props.onClick; apply(); apply(); await page.settle(); await page.flush();
    const saved = page.requests.find(({ method }) => method === 'PUT').body.segments;
    assert.deepEqual([saved[0].start, saved[0].end, saved[0].text, saved[0].timingSource], [2.4, 2.7, before[0].text, 'manual']);
    assert.equal(saved[0].sourceWords, undefined); assert.equal(saved[0].wordAlignedCues, undefined);
    assert.deepEqual(saved[1], before[1]); assert.equal(player.paused, true);
    assert.ok(page.nodes().some((node) => node.type === 'p' && page.text(node).includes('시간 수동 확인')));
    await page.button('SRT').props.onClick(); await page.settle();
    assert.deepEqual(page.requests.at(-1).body.segments, saved); assert.equal(page.requests.at(-1).body.holdShortGaps, single);
    if (single) {
      assert.deepEqual(JSON.parse(page.store.getItem(drafts.lastResultKey('owner'))).segments, saved);
      page.unmount();
      for (const incoming of [true, false]) {
        const reopened = await fixture({ segments, store: page.store, single: true, incoming }); await reopened.segmentsMode();
        assert.equal(reopened.byId('review-start-0').props.value, '2.400'); assert.equal(reopened.byId('review-end-0').props.value, '2.700');
        await reopened.autosave(); assert.equal(reopened.requests.length, 0); reopened.unmount();
      }
    } else {
      page.unmount(); const reopened = await fixture({ segments: saved, store: page.store, holdShortGaps: false }); await reopened.segmentsMode();
      assert.equal(reopened.byId('review-start-0').props.value, '2.400'); await reopened.autosave(); assert.equal(reopened.requests.length, 0); reopened.unmount();
    }
    assert.deepEqual(segments, before);
  }
});

test('actual editor preserves unsaved manual ranges through reload and time-then-text/full-text edits', async () => {
  for (const textMode of [false, true]) {
    const segments = withNeighbours(), page = await fixture({ segments, single: true }); await page.segmentsMode(); await page.connectAudio();
    await page.inputTimes('00:00:02.450', '00:00:02.850'); page.button('이 시간 적용·확인').props.onClick(); await page.settle();
    if (textMode) { page.byId('editor-tab-text').props.onClick(); await page.settle(); page.byId('full-transcript').props.onChange({ target: { value: `수동으로 바꾼 안내\n${segments[1].text}` } }); }
    else page.mainText().props.onChange({ target: { value: '수동으로 바꾼 안내' } });
    await page.settle(); page.unmount();
    const restored = await fixture({ segments, single: true, store: page.store }); await restored.segmentsMode();
    assert.equal(restored.byId('review-start-0').props.value, '2.450'); assert.equal(restored.byId('review-end-0').props.value, '2.850');
    assert.equal(restored.mainText().props.value, '수동으로 바꾼 안내');
    assert.equal(restored.nodes().some((node) => node.type === 'p' && restored.text(node).includes('시간 수동 확인')), false);
    await restored.flush(); const saved = restored.requests.find(({ method }) => method === 'PUT').body.segments[0];
    assert.deepEqual([saved.start, saved.end, saved.timingSource], [2.45, 2.85, 'manual']);
    assert.equal(saved.subtitleReview.timingConfirmation, undefined); assert.equal(saved.wordAlignedCues, undefined);
    restored.unmount();
  }
});

test('actual editor blocks invalid ranges, stale callbacks, changed owners and mismatched full-text application', async () => {
  const page = await fixture(); await page.segmentsMode();
  await page.connectAudio(NaN); assert.equal(page.button('이 시간 적용·확인').props.disabled, true);
  await page.connectAudio();
  for (const [start, end] of [['NaN', '2.7'], ['-1', '2.7'], ['2.5', '2.5'], ['1.799', '2.7'], ['2.4', '3.101'], ['2.4', '10.001']]) {
    await page.inputTimes(start, end); page.button('이 시간 적용·확인').props.onClick(); await page.settle(); await page.autosave();
    assert.equal(page.requests.length, 0); assert.equal(page.byId('review-start-0').props.value, start);
    assert.ok(page.nodes().some((node) => node.props.role === 'alert'));
  }
  await page.inputTimes('2.4', '2.7'); const oldInputApply = page.button('이 시간 적용·확인').props.onClick;
  page.byId('review-start-0').props.onChange({ target: { value: '2.5' } }); oldInputApply(); await page.settle();
  const oldTextApply = page.button('이 시간 적용·확인').props.onClick;
  page.mainText().props.onChange({ target: { value: '수동 변경 안내' } }); oldTextApply(); await page.settle();
  assert.equal(page.byId('review-start-0').props.value, '2.000');
  await page.inputTimes('2.4', '2.7'); const oldOwnerApply = page.button('이 시간 적용·확인').props.onClick;
  await page.setAuth('other'); await page.setAuth('owner'); await page.connectAudio(); oldOwnerApply(); await page.settle();
  assert.equal(page.nodes().some((node) => node.type === 'p' && page.text(node).includes('시간 수동 확인')), false);
  page.byId('editor-tab-text').props.onClick(); await page.settle();
  const invalidDraft = '보존할 첫 줄\n다음 줄\n추가 줄'; page.byId('full-transcript').props.onChange({ target: { value: invalidDraft } }); await page.settle(); await page.segmentsMode();
  assert.equal(page.button('이 시간 적용·확인').props.disabled, true); page.button('이 시간 적용·확인').props.onClick(); await page.settle();
  await assert.rejects(page.flush(), /줄 수/);
  assert.equal(JSON.parse(page.store.getItem(drafts.resultDraftKey('owner', 101))).fullTextDraft, invalidDraft);
  assert.equal(page.requests.length, 0); page.unmount();
});

test('actual editor hides mismatched candidates and all manual time controls for diarized or mixed speaker results', async () => {
  for (const changes of [{ text: '다른 현재 안내' }, { start: 2.001 }, { end: 2.201 }]) {
    const page = await fixture({ segments: withNeighbours({ ...candidateSegment(), ...changes }) }); await page.segmentsMode();
    assert.equal(page.button('시간 후보 불러오기'), undefined); assert.ok(page.byId('review-start-0')); page.unmount();
  }
  for (const options of [{ diarize: true }, { segments: [{ ...candidateSegment(), speaker: 0 }] }, { segments: [...withNeighbours(), { start: 5, end: 6, text: '화자 안내', speaker: 1 }] }]) {
    const page = await fixture(options); await page.segmentsMode();
    assert.equal(page.byId('review-start-0'), undefined); assert.equal(page.button('이 시간 적용·확인'), undefined);
    assert.equal(page.requests.length, 0); page.unmount();
  }
});

test('full-text input invalidates captured time handlers immediately before the next render', async () => {
  for (const mismatch of [false, true]) {
    const page = await fixture(); await page.segmentsMode(); await page.connectAudio(); await page.inputTimes('2.4', '2.7');
    const captured = page.button('이 시간 적용·확인').props.onClick;
    page.byId('editor-tab-text').props.onClick(); await page.settle();
    const draft = mismatch ? '보존할 첫 줄\n다음 줄\n추가 줄' : '전체 편집에서 방금 바꾼 안내\n다음 합성 안내';
    page.byId('full-transcript').props.onChange({ target: { value: draft } }); captured(); await page.settle();
    assert.equal(page.byId('full-transcript').props.value, draft);
    const stored = JSON.parse(page.store.getItem(drafts.resultDraftKey('owner', 101)));
    assert.deepEqual([stored.segments[0].start, stored.segments[0].end], [2, 2.2]);
    assert.equal(stored.segments[0].subtitleReview.timingConfirmation, undefined);
    assert.equal(page.requests.length, 0); page.unmount();
  }
});

test('candidate and current default starts round up to milliseconds before explicit confirmation and export', async () => {
  for (const loadCandidate of [false, true]) {
    const text = '밀리초 합성 안내';
    const source = { start: loadCandidate ? 10 : 10.0044, end: 10.2, text, subtitleReview: {
      version: 1, issues: [], timingCandidate: { sourceStart: 10, sourceEnd: 10.2, start: 10.0044, end: 10.6004, matchingText: text, status: 'unverified' },
    } };
    const page = await fixture({ segments: [source], single: true }); await page.segmentsMode(); await page.connectAudio(20);
    if (loadCandidate) { page.button('시간 후보 불러오기').props.onClick(); await page.settle(); }
    assert.equal(page.byId('review-start-0').props.value, '10.005');
    page.button('이 시간 적용·확인').props.onClick(); await page.settle(); await page.flush();
    const saved = page.requests.find(({ method }) => method === 'PUT').body.segments[0];
    assert.equal(saved.start, 10.005); assert.ok(saved.start >= 10.0044);
    assert.equal(saved.end, loadCandidate ? 10.6 : 10.2);
    assert.match(generateSRT([saved], null, { holdShortGaps: false }), /00:00:10,005 -->/);
    page.unmount();
  }
});
