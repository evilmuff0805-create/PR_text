import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { transformWithEsbuild } from 'vite';
import * as review from '../client/src/utils/subtitle-review.js';
import * as drafts from '../client/src/utils/result-drafts.js';
import * as ideas from '../client/src/utils/caption-ideas.js';
import { formatSegmentTime } from '../client/src/utils/format-segment-time.js';
import { generateASS, generateSRT } from '../src/services/subtitle.js';

const plain = (value) => JSON.parse(JSON.stringify(value));
const storage = () => { const values = new Map(); return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key), values }; };
const candidateSegment = () => ({ start: 2, end: 2.2, text: '합성 원문', timingSource: 'word', wordAlignedCues: [[2, 2.2, '합성 원문']], subtitleReview: {
  version: 1, issues: [{ code: 'correction_guard_rejected', reason: 'numeric_change' }], originalText: '합성 원문', candidateText: '검토할 합성 후보', textStatus: 'candidate', timingStatus: 'unverified',
} });

test('review reasons are bounded observations, preserve diagnostic evidence, and never assert a confirmed model result', () => {
  const source = candidateSegment(), before = structuredClone(source);
  assert.deepEqual(review.getSubtitleReviewIssues(source).map(({ code }) => code), ['correction_guard_rejected', 'short_cue', 'high_reading_speed']);
  assert.match(review.subtitleReviewIssueLabel(source.subtitleReview.issues[0]), /숫자·단위/);
  for (const code of ['chunk_boundary_replanned', 'chunk_boundary_unverified', 'audio_recheck_word_timing', 'audio_recheck_inconclusive', 'audio_recheck_failed']) assert.notEqual(review.subtitleReviewIssueLabel({ code }), '원본 확인이 필요한 구간');
  const normalized = review.normalizeSubtitleReview({ version: 1, issues: [{ code: 'overlap_trim', durationSeconds: NaN, trimmedSeconds: -1, cueStart: 2, wordCount: 3, stage: 'export', shortResponse: true }], candidateText: '다른 후보', textStatus: 'confirmed', timingStatus: 'verified' }, source.text);
  assert.deepEqual(normalized.issues, [{ code: 'overlap_trim', cueStart: 2, wordCount: 3, stage: 'export', shortResponse: true }]);
  assert.equal(normalized.textStatus, 'candidate'); assert.equal(normalized.timingStatus, 'unverified');
  assert.equal(review.normalizeSubtitleReview({ version: 2, issues: [] }), undefined);
  assert.deepEqual(source, before);
});

test('explicit candidate editing accepts long compact rows but enforces existing text limits and retains exact source timing', () => {
  const source = candidateSegment(), before = structuredClone(source);
  const long = '긴 합성 문구를 확인합니다 '.repeat(20);
  assert.equal(review.validateSubtitleCandidate([source], 0, long), null);
  assert.equal(review.validateSubtitleCandidate([source], 0, '가'.repeat(10_000)), null);
  for (const text of ['', ' ', '한 줄\n다른 줄', 'a\u0000b', '가'.repeat(10_001)]) assert.ok(review.validateSubtitleCandidate([source], 0, text));
  assert.ok(review.validateSubtitleCandidate([{ ...source, text: 'a'.repeat(999_999) }, source], 1, '두자'));
  const confirmed = review.confirmSubtitleCandidate(source, long);
  assert.equal(confirmed.start, source.start); assert.equal(confirmed.end, source.end);
  assert.equal(confirmed.wordAlignedCues, source.wordAlignedCues);
  assert.equal(confirmed.subtitleReview.textStatus, 'confirmed'); assert.equal(confirmed.subtitleReview.timingStatus, 'unverified');
  const manual = review.editSubtitleText(confirmed, '다시 수동 편집');
  assert.equal(manual.subtitleReview.textStatus, 'candidate'); assert.equal(manual.subtitleReview.timingStatus, 'unverified');
  assert.equal(manual.subtitleReview.originalText, source.text);
  assert.deepEqual(source, before);
});

test('metadata-only confirmation survives owned drafts and refuses a changed metadata base from another tab', async () => {
  const source = candidateSegment(); source.subtitleReview.candidateText = source.text;
  const confirmed = review.confirmSubtitleCandidate(source, source.text), store = storage();
  drafts.writeResultDraft(store, 'owner', 101, { segments: [confirmed], fullTextDraft: source.text, baseText: source.text, baseSignature: review.subtitleEditSignature([source]) });
  assert.equal(drafts.readResultDraft(store, 'owner', 101, [source]).segments[0].subtitleReview.textStatus, 'confirmed');
  assert.equal(drafts.readResultDraft(store, 'other', 101, [source]), null);
  assert.equal(drafts.readResultDraft(store, 'owner', 102, [source]), null);
  assert.equal(drafts.readResultDraft(store, 'owner', 101, [{ ...source, start: 2.001 }]), null);
  const changed = { ...source, subtitleReview: { ...source.subtitleReview, issues: [{ code: 'audio_recheck_failed' }] } };
  assert.equal(drafts.readResultDraft(store, 'owner', 101, [changed]), null);
  const saves = [], options = { items: [{ status: 'completed', transcriptionLogId: 101 }], storage: store, ownerId: 'owner', fetchLog: async () => ({ segments: [source] }), saveLog: async (id, segments) => saves.push({ id, segments }) };
  await assert.rejects(drafts.flushStoredBatchDrafts({ ...options, saveLog: async () => { throw new Error('synthetic save failure'); } }), /synthetic/);
  assert.equal(JSON.parse(store.getItem(drafts.resultDraftKey('owner', 101))).baseSignature, review.subtitleEditSignature([source]));
  await drafts.flushStoredBatchDrafts(options);
  assert.equal(saves.length, 1); assert.equal(saves[0].segments[0].subtitleReview.textStatus, 'confirmed');
  assert.equal(JSON.parse(store.getItem(drafts.resultDraftKey('owner', 101))).baseSignature, review.subtitleEditSignature([confirmed]));
});

test('legacy drafts do not inherit a confirmed flag for different manual text, and remembered proposals match only exact local context', () => {
  const source = review.confirmSubtitleCandidate(candidateSegment(), '확인한 합성 문구'), store = storage();
  drafts.writeResultDraft(store, 'owner', 101, { segments: [{ start: source.start, end: source.end, text: '과거 수동 편집' }], baseText: source.text });
  assert.equal(drafts.readResultDraft(store, 'owner', 101, [source]).segments[0].subtitleReview.textStatus, 'candidate');
  const segments = [{ start: 0, end: 1, text: '앞 문맥' }, candidateSegment(), { start: 3, end: 4, text: '뒤 문맥' }];
  const memory = review.rememberSubtitleCandidate([], segments, 1, '기억한 합성 후보');
  assert.equal(review.findRememberedSubtitle(memory, segments, 1).candidateText, '기억한 합성 후보');
  assert.equal(review.findRememberedSubtitle(memory, [{ ...segments[0], text: '다른 문맥' }, ...segments.slice(1)], 1), undefined);
  assert.equal(segments[1].text, '합성 원문');
  assert.deepEqual(review.normalizeReviewMemory(null), []);
});

test('explicitly confirmed or manually changed compact text never exports the stale original word-aligned text', () => {
  const source = candidateSegment();
  for (const changed of [review.confirmSubtitleCandidate(source, '직접 확인한 새 안내 문장'), review.editSubtitleText(source, '수동으로 고친 새 안내 문장')]) {
    const srt = generateSRT([changed], null, { holdShortGaps: false });
    const ass = generateASS([changed], { holdShortGaps: false });
    assert.ok(srt.includes(changed.text)); assert.ok(ass.includes(changed.text));
    assert.equal(srt.includes(source.text), false); assert.equal(ass.includes(source.text), false);
    assert.equal(changed.subtitleReview.timingStatus, 'unverified');
    assert.deepEqual([changed.start, changed.end], [source.start, source.end]);
  }
});

test('acknowledged single caches supersede only their exact source anchor and never another owner, log or newer cache', () => {
  const store = storage(), initial = { ownerId: 'owner', transcriptionLogId: 101, segments: [candidateSegment()] };
  const savedSegments = [review.confirmSubtitleCandidate(initial.segments[0], '성공 저장한 합성 문구')];
  store.setItem(drafts.lastResultKey('owner'), JSON.stringify(initial));
  const saved = drafts.cacheSavedResult(store, 'owner', 101, initial, savedSegments, drafts.resultSnapshotSignature(initial));
  assert.equal(saved.text, '성공 저장한 합성 문구');
  assert.equal(drafts.resolveSavedResult(store, 'owner', initial).segments[0].subtitleReview.textStatus, 'confirmed');
  assert.equal(drafts.resolveSavedResult(store, 'owner', initial, true), initial);
  assert.equal(drafts.resolveSavedResult(store, 'other', initial), null);
  assert.equal(drafts.cacheSavedResult(store, 'owner', 102, initial, savedSegments, drafts.resultSnapshotSignature(saved)), null);
  const newer = { ...initial, segments: [{ ...initial.segments[0], text: '다른 창의 최신 서버 문구' }] };
  store.setItem(drafts.lastResultKey('owner'), JSON.stringify(newer));
  assert.equal(drafts.cacheSavedResult(store, 'owner', 101, initial, savedSegments, drafts.resultSnapshotSignature(saved)), null);
  assert.deepEqual(JSON.parse(store.getItem(drafts.lastResultKey('owner'))), newer);
  const quota = { getItem: (key) => store.getItem(key), setItem() { throw new Error('synthetic quota'); } };
  assert.equal(drafts.cacheSavedResult(quota, 'owner', 101, newer, newer.segments, drafts.resultSnapshotSignature(newer)), null);
});

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
  return { settle, nodes, text, requests, store, result, urls, revoked, mediaByUrl, navigations, editorKeys,
    byId: (id) => nodes().find((node) => node.props.id === id),
    button: (label) => nodes().find((node) => node.type === 'button' && (text(node) === label || (label === 'SRT' && text(node).includes('SRT')))),
    mainText: () => nodes().find((node) => node.type === 'textarea' && node.props['aria-label'] === '자막 구간 1'),
    async segmentsMode() { nodes().find((node) => node.props.id === 'editor-tab-segments').props.onClick(); await settle(); },
    flush: async () => { await flush(); await settle(); },
    async autosave() { for (const [id, entry] of [...timers]) if (entry.kind === 'timeout' && entry.ms === 1500) { timers.delete(id); await entry.fn(); } await settle(); },
    tickIntervals() { for (const entry of [...timers.values()]) if (entry.kind === 'interval') entry.fn(); },
    async setAuth(id) { auth = { user: { id }, token: 'synthetic-token' }; dirty = true; await settle(); },
    unmount() { for (const node of nodes()) if (node.type === 'audio') node.props.ref.current = null; [...editorHooks, ...wrapperHooks].forEach((hook) => hook?.cleanup?.()); },
  };
}

test('actual non-override single save survives reload without resultState, the old alive resultState, and menu return', async () => {
  const store = storage(), source = candidateSegment(), page = await fixture({ segments: [source], store, single: true });
  await page.segmentsMode(); page.button('이 문구 적용·확인').props.onClick(); await page.settle(); await page.flush();
  assert.equal(page.requests.filter(({ method }) => method === 'PUT').length, 1);
  const cached = JSON.parse(store.getItem(drafts.lastResultKey('owner')));
  assert.equal(cached.segments[0].text, source.subtitleReview.candidateText); assert.equal(cached.segments[0].subtitleReview.textStatus, 'confirmed');
  assert.equal(page.navigations.at(-1)[1].replace, true); assert.equal(page.navigations.at(-1)[1].state.text, source.subtitleReview.candidateText);
  page.unmount();
  for (const incoming of [false, true, true]) {
    const reopened = await fixture({ segments: [source], store, single: true, incoming });
    assert.equal(reopened.byId('full-transcript').props.value, source.subtitleReview.candidateText); await reopened.segmentsMode();
    assert.equal(reopened.mainText().props.value, source.subtitleReview.candidateText);
    assert.ok(reopened.nodes().some((node) => reopened.text(node).includes('문구 확인됨 · 발화 싱크 미확인')));
    await reopened.autosave(); assert.equal(reopened.requests.length, 0); reopened.unmount();
  }
  const freshServer = await fixture({ segments: [source], store, single: true, serverVerified: true }); await freshServer.segmentsMode();
  assert.equal(freshServer.mainText().props.value, source.text);
  assert.equal(freshServer.nodes().some((node) => node.type === 'p' && freshServer.text(node) === '문구 확인됨 · 발화 싱크 미확인'), false);
  assert.equal(freshServer.requests.length, 0);
});

test('direct single restore keeps its editor key and segment mode after save and restores current text without erasing invalid drafts', async () => {
  const source = candidateSegment(), store = storage();
  store.setItem(drafts.lastResultKey('owner'), JSON.stringify({ ownerId: 'owner', transcriptionLogId: 101, segments: [source], text: source.text }));
  const page = await fixture({ segments: [source], store, wrapper: true }); await page.segmentsMode();
  page.button('이 문구 적용·확인').props.onClick(); await page.settle(); await page.autosave();
  assert.equal(page.requests.filter(({ method }) => method === 'PUT').length, 1);
  assert.deepEqual([...new Set(page.editorKeys)], ['owner:101']);
  assert.ok(page.byId('editor-panel-segments'));
  assert.ok(page.nodes().some((node) => node.type === 'span' && page.text(node).includes('저장됨 · 재다운로드 반영')));
  page.mainText().props.onChange({ target: { value: '구간에서 바꾼 합성 문구' } }); await page.settle(); await page.autosave();
  assert.equal(JSON.parse(store.getItem(drafts.resultDraftKey('owner', 101))).fullTextDraft, '구간에서 바꾼 합성 문구'); page.unmount();
  const reopened = await fixture({ store, wrapper: true });
  assert.equal(reopened.byId('full-transcript').props.value, '구간에서 바꾼 합성 문구'); reopened.unmount();
  const valid = JSON.parse(store.getItem(drafts.resultDraftKey('owner', 101)));
  store.setItem(drafts.resultDraftKey('owner', 101), JSON.stringify({ ...valid, fullTextDraft: '과거의 정상 행수 초안' }));
  const staleDisplay = await fixture({ store, wrapper: true });
  assert.equal(staleDisplay.byId('full-transcript').props.value, '구간에서 바꾼 합성 문구'); staleDisplay.unmount();
  store.setItem(drafts.resultDraftKey('owner', 101), JSON.stringify({ ...valid, fullTextDraft: '보존할 첫 줄\n보존할 추가 줄' }));
  const invalid = await fixture({ store, wrapper: true });
  assert.equal(invalid.byId('full-transcript').props.value, '보존할 첫 줄\n보존할 추가 줄');
  await invalid.segmentsMode(); invalid.byId('editor-tab-text').props.onClick(); await invalid.settle(); await invalid.autosave();
  assert.equal(invalid.byId('full-transcript').props.value, '보존할 첫 줄\n보존할 추가 줄');
  assert.equal(invalid.requests.length, 0);
});

test('cache quota failure cannot turn an acknowledged server save into repeated or failed PUTs', async () => {
  const values = new Map();
  const store = { values, getItem: (key) => values.get(key) ?? null, setItem(key, value) { if (key.startsWith('lastResult:') && JSON.parse(value).savedEditCache) throw new Error('synthetic quota'); values.set(key, value); } };
  const page = await fixture({ store, single: true }); await page.segmentsMode();
  page.button('이 문구 적용·확인').props.onClick(); await page.settle(); await page.flush(); await page.flush(); await page.autosave();
  assert.equal(page.requests.filter(({ method }) => method === 'PUT').length, 1);
  assert.ok(page.nodes().some((node) => node.type === 'span' && page.text(node).includes('저장됨 · 재다운로드 반영')));
  assert.equal(page.navigations.length, 0);
});

test('actual common editor keeps candidates detached until explicit apply and preserves unreviewed single and batch downloads', async () => {
  for (const holdShortGaps of [true, false]) {
    const input = candidateSegment(), before = structuredClone(input), page = await fixture({ segments: [input], holdShortGaps });
    await page.segmentsMode(); await page.autosave();
    assert.equal(page.mainText().props.value, before.text);
    const candidate = '사용자가 확인할 새로운 합성 후보';
    page.byId('review-candidate-0').props.onChange({ target: { value: candidate } }); await page.settle(); await page.autosave();
    assert.equal(page.requests.filter(({ method }) => method === 'PUT').length, 0);
    assert.equal([...page.store.values.values()].join('').includes(candidate), false);
    await page.button('SRT').props.onClick(); await page.settle();
    const download = page.requests.find(({ url }) => url === '/api/download');
    assert.deepEqual(download.body.segments, [before]); assert.equal(download.body.holdShortGaps, holdShortGaps);
    const apply = page.button('이 문구 적용·확인').props.onClick; apply(); apply(); await page.settle(); await page.flush();
    const saved = page.requests.find(({ method }) => method === 'PUT').body.segments[0];
    assert.equal(saved.text, candidate); assert.equal(saved.subtitleReview.textStatus, 'confirmed'); assert.equal(saved.subtitleReview.timingStatus, 'unverified');
    assert.deepEqual([saved.start, saved.end, saved.wordAlignedCues], [before.start, before.end, before.wordAlignedCues]);
    page.mainText().props.onChange({ target: { value: '다시 수동 변경' } }); await page.settle(); await page.flush();
    assert.equal(page.requests.filter(({ method }) => method === 'PUT').at(-1).body.segments[0].subtitleReview.textStatus, 'candidate');
    assert.deepEqual(input, before);
  }
});

test('actual editor rejects stale candidate handlers and mismatched draft application without replacing user input', async () => {
  const page = await fixture(); await page.segmentsMode();
  const staleApply = page.button('이 문구 적용·확인').props.onClick;
  page.byId('review-candidate-0').props.onChange({ target: { value: '방금 입력한 후보' } }); staleApply(); await page.settle();
  assert.equal(page.mainText().props.value, '합성 원문');
  const apply = page.button('이 문구 적용·확인').props.onClick;
  page.mainText().props.onChange({ target: { value: '변경한 기준 문구' } }); apply(); await page.settle();
  assert.equal(page.mainText().props.value, '변경한 기준 문구');
  page.mainText().props.onChange({ target: { value: '합성 원문' } }); await page.settle(); staleApply(); await page.settle();
  assert.equal(page.mainText().props.value, '합성 원문');
  const oldAccountApply = page.button('이 문구 적용·확인').props.onClick;
  await page.setAuth('another-owner'); await page.setAuth('owner'); oldAccountApply(); await page.settle();
  assert.equal(page.mainText().props.value, '합성 원문');
  page.byId('editor-tab-text').props.onClick(); await page.settle();
  page.byId('full-transcript').props.onChange({ target: { value: '첫 줄\n여분 줄' } }); await page.settle(); await page.segmentsMode();
  assert.equal(page.button('이 문구 적용·확인').props.disabled, true);
  page.button('이 문구 적용·확인').props.onClick(); await page.settle();
  await assert.rejects(page.flush(), /줄 수/);
  assert.equal(page.requests.filter(({ method }) => method === 'PUT').length, 0);
});

test('actual editor persists metadata-only confirmation and remembers proposals only after an explicit file-scoped opt-in', async () => {
  const input = candidateSegment(); delete input.subtitleReview.candidateText; delete input.subtitleReview.textStatus;
  const page = await fixture({ segments: [input] }); await page.segmentsMode();
  assert.equal(page.nodes().find((node) => node.type === 'input' && node.props.type === 'checkbox').props.checked, false);
  assert.equal(page.button('이 문구 적용·확인').props.disabled, true);
  page.button('현재 문구만 확인').props.onClick(); await page.settle(); await page.flush();
  assert.equal(page.requests.length, 1); assert.equal(page.requests[0].body.segments[0].text, input.text);
  assert.equal(page.requests[0].body.segments[0].subtitleReview.textStatus, 'confirmed');
  page.byId('review-candidate-0').props.onChange({ target: { value: '기억할 후보' } }); await page.settle();
  page.nodes().find((node) => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); await page.settle();
  page.button('이 문구 적용·확인').props.onClick(); await page.settle(); await page.flush();
  const saved = page.requests.at(-1).body.segments;
  const restored = await fixture({ segments: saved, store: page.store }); await restored.segmentsMode();
  assert.ok(restored.nodes().some((node) => restored.text(node).includes('기억한 후보 1개')));
  const other = await fixture({ segments: saved, store: page.store, owner: 'another-owner', logId: 102 }); await other.segmentsMode();
  assert.equal(other.nodes().some((node) => other.text(node).includes('기억한 후보 1개')), false);
  restored.button('이 파일의 후보 기억 지우기').props.onClick(); await restored.settle();
  assert.equal(restored.requests.length, 0);
  assert.deepEqual(JSON.parse(page.store.getItem(drafts.resultDraftKey('owner', 101))).reviewMemory, []);
});

test('local source audio never uploads, stops the selected range, and revokes the source on replacement and owner change', async () => {
  const page = await fixture(); await page.segmentsMode();
  assert.equal(page.button('앞뒤 포함 듣기').props.disabled, true);
  const event = { target: { files: [new File(['synthetic local bytes'], 'synthetic.wav')], value: 'selected' } };
  page.byId('review-source-audio').props.onChange(event); await page.settle(); assert.equal(event.target.value, '');
  let audioNode = page.nodes().find((node) => node.type === 'audio'), media = page.mediaByUrl.get(audioNode.props.src), firstUrl = audioNode.props.src;
  assert.equal(audioNode.props.autoPlay, undefined); assert.equal(audioNode.props.controls, true);
  audioNode.props.onLoadedMetadata({ currentTarget: media }); await page.settle();
  assert.equal(page.button('앞뒤 포함 듣기').props.disabled, false);
  await page.button('앞뒤 포함 듣기').props.onClick();
  assert.equal(media.currentTime, 1.5); assert.equal(media.plays, 1);
  media.currentTime = 2.7; page.tickIntervals(); assert.equal(media.paused, true);
  const oldMetadata = audioNode.props.onLoadedMetadata;
  page.byId('review-source-audio').props.onChange({ target: { files: [new File(['other'], 'other.wav')], value: '' } }); await page.settle();
  assert.ok(page.revoked.includes(firstUrl)); oldMetadata({ currentTarget: media }); await page.settle();
  assert.equal(page.button('앞뒤 포함 듣기').props.disabled, true);
  audioNode = page.nodes().find((node) => node.type === 'audio'); const secondUrl = audioNode.props.src;
  media = page.mediaByUrl.get(secondUrl); audioNode.props.onLoadedMetadata({ currentTarget: media }); await page.settle();
  await page.button('앞뒤 포함 듣기').props.onClick(); await page.setAuth('another-owner');
  assert.ok(page.revoked.includes(secondUrl)); assert.equal(media.paused, true);
  assert.equal(page.nodes().some((node) => node.type === 'audio'), false);
  assert.equal(page.requests.length, 0);
});

test('late play resolution and real ref detachment cannot keep a previous local file playing', async () => {
  const page = await fixture(); await page.segmentsMode();
  page.byId('review-source-audio').props.onChange({ target: { files: [new File(['synthetic'], 'local.wav')], value: '' } }); await page.settle();
  const audio = page.nodes().find((node) => node.type === 'audio'), media = page.mediaByUrl.get(audio.props.src);
  audio.props.onLoadedMetadata({ currentTarget: media }); await page.settle();
  let resolve; media.pendingPlay = new Promise((yes) => { resolve = yes; });
  const pending = page.button('앞뒤 포함 듣기').props.onClick();
  page.unmount(); assert.equal(media.paused, true); assert.ok(page.revoked.includes(audio.props.src));
  resolve(); await pending; assert.equal(media.paused, true); assert.equal(page.requests.length, 0);
});

function localReviewSegment(status = 'review', { start = 0, end = start + 0.2, text = '검토할 합성 반복 문장', groupId = 'repeat_1' } = {}) {
  return { start, end, text, subtitleReview: { version: 1, issues: [], localExclusion: {
    version: 1, status, reason: status === 'automatic' ? 'exact_zero_with_provider_risk' : 'distributed_repetition',
    binding: { text, start, end }, groupId, occurrences: 3,
    audioStatus: status === 'automatic' ? 'exact_zero' : 'signal_present',
  } } };
}

test('local exclusions require an exact current text/range binding and cannot affect speaker-labelled speech', () => {
  const source = localReviewSegment('automatic'), before = structuredClone(source);
  assert.equal(review.isLocallyExcluded(source), true);
  assert.equal(review.getBoundLocalExclusion(source).binding.start, 0);
  for (const changed of [{ ...source, text: `${source.text} 변경` }, { ...source, start: 0.001 }, { ...source, end: 0.201 }, { ...source, speaker: 0 }]) {
    assert.equal(review.getBoundLocalExclusion(changed), undefined);
    assert.equal(review.isLocallyExcluded(changed), false);
  }
  for (const changed of [
    { ...source.subtitleReview.localExclusion, status: 'verified' },
    { ...source.subtitleReview.localExclusion, reason: 'untrusted_reason' },
    { ...source.subtitleReview.localExclusion, binding: { text: ' ', start: 0, end: 1 } },
    { ...source.subtitleReview.localExclusion, binding: { text: source.text, start: null, end: 1 } },
    { ...source.subtitleReview.localExclusion, binding: { text: source.text, start: 0, end: 0 } },
  ]) assert.equal(review.normalizeLocalExclusion(changed), undefined);
  assert.deepEqual(source, before);
});

test('exclude, edit, exclude again and restore retain the first text/time snapshot without deleting a row', () => {
  const source = localReviewSegment(), before = structuredClone(source);
  const excluded = review.setSubtitleExclusion(source, true);
  assert.equal(review.isLocallyExcluded(excluded), true);
  assert.notEqual(review.subtitleEditSignature([source]), review.subtitleEditSignature([excluded]));
  const edited = review.editSubtitleText(excluded, '사용자가 고친 합성 문장');
  assert.equal(review.isLocallyExcluded(edited), false);
  assert.equal(edited.subtitleReview.localExclusion.status, 'user');
  const timed = review.confirmSubtitleTiming(edited, 0.01, 0.19);
  const reexcluded = review.setSubtitleExclusion(timed, true);
  assert.equal(review.isLocallyExcluded(reexcluded), true);
  assert.equal(reexcluded.subtitleReview.originalText, source.text);
  assert.deepEqual(reexcluded.subtitleReview.originalTiming, { start: source.start, end: source.end });
  assert.deepEqual(reexcluded.subtitleReview.localExclusion.binding, { text: edited.text, start: 0.01, end: 0.19 });
  const restored = review.setSubtitleExclusion(reexcluded, false);
  assert.equal(review.isLocallyExcluded(restored), false);
  assert.equal(restored.subtitleReview.localExclusion.status, 'restored');
  assert.deepEqual([restored.text, restored.start, restored.end], [edited.text, 0.01, 0.19]);
  assert.deepEqual(source, before);
});

test('metadata-only exclusions survive single caches and batch draft flushing with ownership and current metadata guards', async () => {
  const source = localReviewSegment(), excluded = review.setSubtitleExclusion(source, true), store = storage();
  const initial = { ownerId: 'owner', transcriptionLogId: 101, segments: [source], text: source.text };
  store.setItem(drafts.lastResultKey('owner'), JSON.stringify(initial));
  const saved = drafts.cacheSavedResult(store, 'owner', 101, initial, [excluded], drafts.resultSnapshotSignature(initial));
  assert.equal(review.isLocallyExcluded(drafts.resolveSavedResult(store, 'owner', initial).segments[0]), true);
  drafts.writeResultDraft(store, 'owner', 101, { segments: [excluded], baseSignature: review.subtitleEditSignature([source]), fullTextDraft: source.text });
  const reloaded = drafts.readResultDraft(store, 'owner', 101, [source]);
  assert.equal(review.isLocallyExcluded(reloaded.segments[0]), true);
  assert.equal(drafts.readResultDraft(store, 'another-owner', 101, [source]), null);
  assert.equal(drafts.readResultDraft(store, 'owner', 102, [source]), null);
  assert.equal(drafts.readResultDraft(store, 'owner', 101, [review.setSubtitleExclusion(source, false)]), null);
  const batchSaves = [];
  await drafts.flushStoredBatchDrafts({ items: [{ status: 'completed', transcriptionLogId: 101 }], storage: store, ownerId: 'owner',
    fetchLog: async () => ({ segments: [source] }), saveLog: async (id, segments) => batchSaves.push({ id, segments }) });
  assert.equal(batchSaves.length, 1);
  assert.deepEqual(batchSaves[0].segments, [excluded]);
  assert.equal(review.subtitleEditSignature(saved.segments), review.subtitleEditSignature(batchSaves[0].segments));
  const legacy = { segments: [{ ...source, subtitleReview: { version: 1, issues: [] } }], baseText: source.text };
  drafts.writeResultDraft(store, 'owner', 101, legacy);
  assert.equal(drafts.readResultDraft(store, 'owner', 101, [excluded]), null);
});

test('repetition groups stay included until explicit per-row exclusion and count only currently bound decisions', async () => {
  const input = [localReviewSegment(), localReviewSegment('review', { start: 2 }), localReviewSegment('automatic', { start: 4 })];
  const before = structuredClone(input), page = await fixture({ segments: input });
  assert.ok(page.nodes().some((node) => node.type === 'summary' && page.text(node).includes('반복·제외 검토 · 1개 묶음 · 제외 1개')));
  assert.ok(page.nodes().some((node) => node.type === 'p' && page.text(node).includes('무음 근거 자동 제외 1개 · 사용자 제외 0개 · 복원 0개 · 미확정 검토 2개')));
  assert.ok(page.nodes().some((node) => node.type === 'p' && page.text(node).includes('#1 00:00.000 - 00:00.200')));
  page.button('구간별에서 검토').props.onClick(); await page.settle();
  assert.equal(page.mainText().props.value, input[0].text);
  assert.equal(page.text(page.byId('review-exclusion-action-0')), '이 구간 제외');
  assert.equal(page.text(page.byId('review-exclusion-action-2')), '이 구간 복원');
  page.byId('review-exclusion-action-0').props.onClick(); await page.settle();
  const staleExcluded = page.byId('review-exclusion-action-0').props.onClick;
  page.mainText().props.onChange({ target: { value: '수정한 현재 합성 문구' } }); await page.settle();
  staleExcluded(); await page.settle();
  assert.equal(page.text(page.byId('review-exclusion-action-0')), '이 구간 제외');
  assert.ok(page.nodes().some((node) => node.type === 'p' && page.text(node).includes('문구·시간 변경으로 이전 제외는 적용하지 않음')));
  assert.ok(page.nodes().some((node) => node.type === 'p' && page.text(node).includes('무음 근거 자동 제외 1개 · 사용자 제외 0개 · 복원 0개 · 미확정 검토 1개')));
  assert.deepEqual(input, before);
});

test('all excluded rows keep their text, save and reload while every empty export handler stays blocked until restore', async () => {
  const source = localReviewSegment(), store = storage(), page = await fixture({ segments: [source], store, single: true });
  const oldSrt = page.button('SRT').props.onClick;
  const exports = () => page.nodes().filter((node) => node.type === 'button' && String(node.props.className || '').includes('export-option'));
  exports().find((node) => page.text(node).includes('ASS')).props.onClick(); await page.settle();
  const oldAss = page.button('ASS 자막 다운로드').props.onClick;
  await page.segmentsMode(); page.byId('review-exclusion-action-0').props.onClick(); await page.settle();
  assert.equal(page.mainText().props.value, source.text);
  assert.equal(page.byId('full-transcript'), undefined);
  assert.ok(exports().every((node) => node.props.disabled));
  assert.equal(page.button('ASS 자막 다운로드').props.disabled, true);
  assert.ok(page.nodes().some((node) => node.type === 'p' && page.text(node).includes('남은 자막 없음')));
  await oldSrt(); await oldAss();
  for (const node of exports()) await node.props.onClick();
  await page.settle();
  assert.equal(page.requests.filter(({ url }) => url === '/api/download').length, 0);
  await page.flush();
  const saved = page.requests.find(({ method }) => method === 'PUT').body.segments;
  assert.equal(saved.length, 1); assert.deepEqual([saved[0].text, saved[0].start, saved[0].end], [source.text, source.start, source.end]);
  assert.equal(review.isLocallyExcluded(saved[0]), true);
  page.unmount();
  const restoredPage = await fixture({ segments: [source], store, single: true, incoming: false });
  await restoredPage.segmentsMode();
  assert.equal(restoredPage.text(restoredPage.byId('review-exclusion-action-0')), '이 구간 복원');
  restoredPage.byId('review-exclusion-action-0').props.onClick(); await restoredPage.settle(); await restoredPage.flush();
  assert.equal(restoredPage.mainText().props.value, source.text);
  assert.equal(restoredPage.button('SRT').props.disabled, false);
  await restoredPage.button('SRT').props.onClick();
  const downloaded = restoredPage.requests.find(({ url }) => url === '/api/download').body.segments;
  assert.equal(downloaded[0].subtitleReview.localExclusion.status, 'restored');
  assert.equal(review.isLocallyExcluded(downloaded[0]), false);
});

test('single and shared batch editors download the same metadata mask and permit explicit English-only manual selection', async () => {
  for (const single of [true, false]) {
    const source = [{ start: 0, end: 0.2, text: 'Synthetic English phrase' }, { start: 1, end: 2, text: 'Keep this phrase' }];
    const page = await fixture({ segments: source, single, holdShortGaps: single, language: 'en' });
    await page.segmentsMode(); page.byId('review-exclusion-action-0').props.onClick(); await page.settle(); await page.flush();
    await page.button('SRT').props.onClick();
    const download = page.requests.find(({ url }) => url === '/api/download').body;
    assert.equal(download.holdShortGaps, single);
    assert.equal(download.segments.length, 2);
    assert.deepEqual(download.segments, page.requests.find(({ method }) => method === 'PUT').body.segments);
    assert.equal(download.segments[0].subtitleReview.localExclusion.reason, 'user_selection');
    assert.equal(review.isLocallyExcluded(download.segments[0]), true);
    assert.equal(download.segments[1].text, source[1].text);
  }
  for (const options of [{ diarize: true }, { segments: [{ ...localReviewSegment(), speaker: 0 }] }]) {
    const page = await fixture(options); await page.segmentsMode();
    assert.equal(page.byId('review-exclusion-action-0'), undefined);
    assert.equal(page.nodes().some((node) => node.type === 'summary' && page.text(node).includes('반복·제외 검토')), false);
  }
});

test('metadata exclusion actions reject mismatched full-text drafts and show a linked-row save conflict without discarding text', async () => {
  const message = '제외 충돌: 연결된 자막 1, 2행을 함께 선택해 주세요.';
  const page = await fixture({ segments: [localReviewSegment()], saveError: message });
  await page.segmentsMode(); const stale = page.byId('review-exclusion-action-0').props.onClick;
  page.byId('editor-tab-text').props.onClick(); await page.settle();
  page.byId('full-transcript').props.onChange({ target: { value: '보존할 첫 줄\n보존할 추가 줄' } }); await page.settle(); await page.segmentsMode();
  assert.equal(page.byId('review-exclusion-action-0').props.disabled, true);
  stale(); await page.settle(); assert.equal(page.text(page.byId('review-exclusion-action-0')), '이 구간 제외');
  page.mainText().props.onChange({ target: { value: '현재 합성 문구' } }); await page.settle();
  page.byId('review-exclusion-action-0').props.onClick(); await page.settle();
  await assert.rejects(page.flush(), /제외 충돌/);
  await page.settle();
  assert.ok(page.nodes().some((node) => node.props.role === 'alert' && page.text(node) === message));
  assert.equal(page.mainText().props.value, '현재 합성 문구');
});
