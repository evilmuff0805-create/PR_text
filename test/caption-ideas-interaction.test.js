import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { transformWithEsbuild } from 'vite';
import * as captionIdeas from '../client/src/utils/caption-ideas.js';
import * as drafts from '../client/src/utils/result-drafts.js';
import { formatSegmentTime } from '../client/src/utils/format-segment-time.js';

const owner = 'synthetic-owner';
const ideas = ['앞말을 살린 제안', '장면에 맞는 제안', '조건을 지킨 제안'];
const ok = (values = ideas) => Response.json({ ideas: values, creditsRemaining: 5, remainingUses: 4 });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const storage = () => { const values = new Map(); return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; };
const codeCache = new Map();
async function code(file) {
  if (!codeCache.has(file)) codeCache.set(file, (await transformWithEsbuild(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'), file, { loader: 'jsx', format: 'cjs', jsx: 'automatic' })).code);
  return codeCache.get(file);
}

// 실제 JSX를 렌더하고 실제 이벤트 핸들러를 호출한다. 모든 통신·저장은 합성 객체다.
async function fixture({ editor = false, result, respond } = {}) {
  const hooks = [], effects = [], requests = [], copied = [], credits = [], navigations = [];
  let cursor = 0, dirty = true, tree, timerId = 0;
  let auth = { user: { id: owner, credits: 5 }, token: 'synthetic-token', getToken: () => 'synthetic-token', updateCredits: (value) => credits.push({ owner: auth.user?.id, value }) };
  let props = editor ? { resultOverride: result } : {};
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    memo: (component) => component,
    useState(initial) { const index = cursor++; hooks[index] ||= { value: typeof initial === 'function' ? initial() : initial }; return [hooks[index].value, (next) => { const value = typeof next === 'function' ? next(hooks[index].value) : next; if (!Object.is(value, hooks[index].value)) { hooks[index].value = value; dirty = true; } }]; },
    useRef(initial) { const index = cursor++; return hooks[index] ||= { current: initial }; },
    useMemo(callback, deps) { const index = cursor++; if (!same(hooks[index]?.deps, deps)) hooks[index] = { value: callback(), deps }; return hooks[index].value; },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
    useEffect(callback, deps) { const index = cursor++; if (!same(hooks[index]?.deps, deps)) { const previous = hooks[index]; hooks[index] = { deps }; effects.push(() => { previous?.cleanup?.(); hooks[index].cleanup = callback(); }); } },
  };
  const element = (type, props) => ({ type, props: props || {} });
  const dependencies = {
    react, 'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' },
    'react-router-dom': { useLocation: () => ({ state: null, search: '' }), useNavigate: () => (path) => navigations.push(path) },
    '../contexts/AuthContext.jsx': { useAuth: () => auth },
    '../components/AuthModal.jsx': { default: () => null }, '../components/CaptionIdeaHistory.jsx': { default: () => null },
    '../utils/use-dialog-accessibility.js': { useDialogAccessibility() {} },
    '../utils/caption-ideas.js': captionIdeas, '../utils/result-drafts.js': drafts, '../utils/format-segment-time.js': { formatSegmentTime },
  };
  const fetch = async (url, options = {}) => {
    const request = { url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null };
    requests.push(request);
    if (url === '/api/caption-ideas/status') return Response.json({ credits: 5, remainingUses: 5 });
    const response = await respond?.(request);
    if (response) return response;
    if (url === '/api/download') return new Response('synthetic subtitle');
    throw new Error(`Unmocked synthetic endpoint: ${url}`);
  };
  const module = { exports: {} }, timers = new Map(), anchors = [];
  const addTimer = (callback) => { timers.set(++timerId, callback); return timerId; };
  const document = { getElementById: () => null, body: { appendChild() {} }, createElement: () => ({ click() { anchors.push(this.download); }, remove() {} }) };
  runInNewContext(await code(editor ? 'client/src/pages/ResultPage.jsx' : 'client/src/pages/CaptionIdeasPage.jsx'), {
    module, exports: module.exports, require: (name) => { assert.ok(name in dependencies, name); return dependencies[name]; },
    sessionStorage: storage(), fetch, document,
    navigator: { clipboard: { writeText: async (value) => { copied.push(value); } } },
    URL: { createObjectURL: () => 'blob:synthetic', revokeObjectURL() {} },
    window: { setTimeout: addTimer, clearTimeout: (id) => timers.delete(id), requestAnimationFrame: addTimer },
    setTimeout: addTimer, clearTimeout: (id) => timers.delete(id), AbortController,
  });
  const expand = (node) => Array.isArray(node) ? node.map(expand) : node && typeof node === 'object'
    ? typeof node.type === 'function' ? expand(node.type(node.props)) : { ...node, props: { ...node.props, children: expand(node.props.children) } } : node;
  const render = () => { cursor = 0; dirty = false; tree = expand(module.exports[editor ? 'ResultEditor' : 'default'](props)); };
  const settle = async () => { for (let turn = 0; turn < 50; turn++) { if (dirty) render(); effects.splice(0).forEach((effect) => effect()); await new Promise(setImmediate); if (!dirty && !effects.length) return; } throw new Error('Synthetic hooks failed to settle'); };
  const nodes = (node = tree, result = []) => { if (Array.isArray(node)) node.forEach((value) => nodes(value ?? null, result)); else if (node && typeof node === 'object') { result.push(node); nodes(node.props.children ?? null, result); } return result; };
  const text = (node) => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
  const button = (label) => { const found = nodes().find((node) => node.type === 'button' && text(node) === label); assert.ok(found, label); return found; };
  await settle();
  return { settle, nodes, text, button, requests, copied, credits, anchors, navigations,
    hasText: (value) => nodes().some((node) => text(node).includes(value)),
    setAuth: async (id) => { auth = { ...auth, user: id ? { id, credits: 5 } : null }; dirty = true; await settle(); },
    setProps: async (next) => { props = { ...props, ...next }; dirty = true; await settle(); },
    input: (value) => nodes().find((node) => node.props.id === 'caption-ideas-text').props.onChange({ target: { value } }),
    run: () => nodes().find((node) => node.type === 'button' && (node.props.className?.includes('caption-ideas-generate') || node.props.className?.includes('segment-idea-panel__run'))),
  };
}

const source = () => {
  const segments = Array.from({ length: 5 }, (_, index) => ({ start: index === 1 ? 0 : index, end: index + 0.8, text: `합성 ${index + 1}번째 대사`, timingSource: 'word', wordAlignedCues: [[index, index + 0.8, `합성 ${index + 1}번째 대사`]] }));
  return { ownerId: owner, transcriptionLogId: 101, language: 'ko', diarize: false, segments, text: segments.map(({ text }) => text).join('\n') };
};
async function openEditor(page, index = 2) {
  page.button('구간별 편집').props.onClick(); await page.settle();
  page.nodes().filter((node) => node.type === 'button' && page.text(node) === '자막 아이디어')[index].props.onClick(); await page.settle();
}
function copyButton(page, idea) {
  const row = page.nodes().find((node) => node.type === 'li' && page.text(node).includes(idea));
  return page.nodes(row).find((node) => node.type === 'button');
}

test('standalone keeps legacy payload, protects duplicate clicks and preserves successful ideas on uncertain retry', async () => {
  const held = deferred(); let call = 0;
  const page = await fixture({ respond: ({ url }) => {
    assert.equal(url, '/api/caption-ideas'); call++;
    if (call === 1) return held.promise;
    if (call === 2) throw new Error('synthetic response loss');
    return ok(['다시 확인한 제안', '기록을 살린 제안', '같은 요청의 제안']);
  } });
  assert.equal(page.nodes().find((node) => node.props.role === 'radio' && node.props['aria-checked']).props.children, '예능');
  page.input('😀'.repeat(500)); await page.settle();
  assert.equal(page.nodes().find((node) => node.props.id === 'caption-ideas-text').props.value, '😀'.repeat(500));
  assert.equal(page.nodes().find((node) => node.props.id === 'caption-ideas-text').props.maxLength, 1000);
  page.input('가'.repeat(501)); await page.settle();
  assert.equal(page.nodes().find((node) => node.props.id === 'caption-ideas-text').props.value, '😀'.repeat(500));
  page.input('합성 장면 설명'); await page.settle();
  const run = page.run().props.onClick; run(); run(); await page.settle();
  assert.equal(page.requests.filter(({ method }) => method === 'POST').length, 1);
  held.resolve(ok()); await page.settle();
  const first = page.requests.find(({ method }) => method === 'POST').body;
  assert.deepEqual(Object.keys(first).sort(), ['mode', 'requestId', 'text']);
  assert.equal(first.mode, 'entertainment'); assert.equal(first.text, '합성 장면 설명');
  await copyButton(page, ideas[0]).props.onClick(); await page.settle(); assert.deepEqual(page.copied, [ideas[0]]);
  page.run().props.onClick(); await page.settle();
  assert.ok(page.hasText(ideas[0])); assert.ok(page.hasText('완료된 요청을 확인합니다'));
  page.run().props.onClick(); await page.settle();
  const posts = page.requests.filter(({ method }) => method === 'POST');
  assert.notEqual(posts[0].body.requestId, posts[1].body.requestId);
  assert.equal(posts[1].body.requestId, posts[2].body.requestId);
  assert.ok(page.hasText('다시 확인한 제안'));
});

test('standalone isolates late A-to-B-to-A input generations and account changes', async () => {
  const held = deferred(), page = await fixture({ respond: () => held.promise });
  page.input('첫 입력'); await page.settle(); page.run().props.onClick(); await page.settle();
  page.input('다른 입력'); await page.settle(); page.input('첫 입력'); await page.settle();
  const previousCredits = page.credits.length;
  held.resolve(ok()); await page.settle();
  assert.equal(page.hasText(ideas[0]), false); assert.equal(page.credits.length, previousCredits);
  const pending = deferred(), account = await fixture({ respond: () => pending.promise });
  account.input('사용자별 합성 자료'); await account.settle(); account.run().props.onClick(); await account.settle();
  await account.setAuth('another-owner'); const creditsAfterSwitch = account.credits.length;
  pending.resolve(ok()); await account.settle();
  assert.equal(account.hasText(ideas[0]), false); assert.equal(account.credits.length, creditsAfterSwitch);
});

test('context generation and exact copying leave single and batch transcription export data unchanged', async () => {
  for (const holdShortGaps of [true, false]) {
    const result = source(); result.holdShortGaps = holdShortGaps;
    const before = structuredClone(result), page = await fixture({ editor: true, result, respond: ({ url }) => url.endsWith('/context') ? ok() : undefined });
    await openEditor(page); const details = page.nodes().find((node) => node.type === 'details'); assert.equal(details.props.open, undefined);
    const run = page.run().props.onClick; const first = run(); run(); await first; await page.settle();
    const posts = page.requests.filter(({ url }) => url.endsWith('/context'));
    assert.equal(posts.length, 1); assert.equal(posts[0].body.mode, 'situation'); assert.equal(posts[0].body.text, before.segments[2].text);
    assert.deepEqual(posts[0].body.context, { before: before.segments.slice(0, 2).map(({ text }) => text), after: before.segments.slice(3).map(({ text }) => text) });
    assert.equal(Object.hasOwn(posts[0].body, 'start'), false);
    await copyButton(page, ideas[1]).props.onClick(); await page.settle(); assert.deepEqual(page.copied, [ideas[1]]);
    const download = page.nodes().find((node) => node.type === 'button' && page.text(node).includes('SRT'));
    await download.props.onClick(); await page.settle();
    const output = page.requests.find(({ url }) => url === '/api/download');
    assert.deepEqual(output.body.segments, before.segments); assert.equal(output.body.holdShortGaps, holdShortGaps);
    assert.deepEqual(result, before); assert.equal(page.requests.some(({ method }) => method === 'PUT'), false);
    assert.equal(page.requests.some(({ url }) => url === '/api/caption-ideas'), false);
  }
});

test('context 404 never falls back, preserves UUID and old ideas, and expired requests get a new UUID', async () => {
  let call = 0;
  const page = await fixture({ editor: true, result: source(), respond: ({ url }) => {
    assert.equal(url, '/api/caption-ideas/context'); call++;
    if (call === 1 || call === 3) return ok();
    if (call === 2) return Response.json({}, { status: 404 });
    return Response.json({ code: 'REQUEST_EXPIRED', error: '만료된 합성 요청' }, { status: 409 });
  } });
  await openEditor(page); await page.run().props.onClick(); await page.settle();
  await page.run().props.onClick(); await page.settle();
  assert.ok(page.hasText(ideas[0])); assert.ok(page.hasText('업데이트 후 다시 시도'));
  await page.run().props.onClick(); await page.settle();
  let posts = page.requests.filter(({ method }) => method === 'POST');
  assert.notEqual(posts[0].body.requestId, posts[1].body.requestId); assert.equal(posts[1].body.requestId, posts[2].body.requestId);
  await page.run().props.onClick(); await page.settle(); await page.run().props.onClick(); await page.settle();
  posts = page.requests.filter(({ method }) => method === 'POST'); assert.notEqual(posts[3].body.requestId, posts[4].body.requestId);
  assert.equal(posts.some(({ url }) => url === '/api/caption-ideas'), false);
});

test('late context responses cannot cross focus, mode, edited source or owner boundaries', async () => {
  for (const change of ['focus', 'mode', 'text', 'owner']) {
    const pending = deferred(), page = await fixture({ editor: true, result: source(), respond: () => pending.promise });
    await openEditor(page); page.run().props.onClick(); await page.settle();
    if (change === 'focus') {
      page.nodes().filter((node) => node.type === 'button' && page.text(node) === '자막 아이디어')[1].props.onClick(); await page.settle();
    } else if (change === 'mode') {
      page.button('감성').props.onClick(); await page.settle(); page.button('상황').props.onClick(); await page.settle();
    } else if (change === 'text') {
      page.nodes().find((node) => node.props['aria-label'] === '자막 구간 3').props.onChange({ target: { value: '새로 편집한 합성 대사' } });
    } else await page.setAuth('different-owner');
    pending.resolve(ok()); await page.settle();
    assert.equal(page.hasText(ideas[0]), false, change);
    assert.equal(page.requests.filter(({ method }) => method === 'POST').length, 1, change);
  }
});

test('a 501-plus focus requires explicit substring selection without changing the transcript', async () => {
  const result = source(), chosen = '조건은 그대로 유지해요'; result.segments[0].text = '가'.repeat(250) + chosen + '나'.repeat(250); result.text = result.segments.map(({ text }) => text).join('\n');
  const before = structuredClone(result), page = await fixture({ editor: true, result, respond: () => ok() });
  await openEditor(page, 0);
  assert.equal(page.run().props.disabled, true);
  await page.run().props.onClick(); await page.settle(); assert.equal(page.requests.length, 0);
  const selection = page.nodes().find((node) => node.type === 'textarea' && node.props.readOnly);
  assert.equal(selection.props.value, before.segments[0].text);
  const start = selection.props.value.indexOf(chosen);
  selection.props.onSelect({ currentTarget: { value: selection.props.value, selectionStart: start, selectionEnd: start + chosen.length } }); await page.settle();
  assert.equal(page.run().props.disabled, false); await page.run().props.onClick(); await page.settle();
  assert.equal(page.requests[0].body.text, chosen); assert.deepEqual(result, before);
  assert.equal(page.nodes().find((node) => node.props['aria-label'] === '자막 구간 1').props.value, before.segments[0].text);
});

test('malformed successful replies preserve retry identity and never replace prior valid ideas', async () => {
  let call = 0;
  const page = await fixture({ editor: true, result: source(), respond: () => ++call === 1 ? ok() : Response.json({ ideas: ['불완전한 합성 응답'] }) });
  await openEditor(page); await page.run().props.onClick(); await page.settle();
  await page.run().props.onClick(); await page.settle(); await page.run().props.onClick(); await page.settle();
  assert.ok(page.hasText(ideas[0])); assert.equal(page.hasText('불완전한 합성 응답'), false);
  const posts = page.requests.filter(({ method }) => method === 'POST');
  assert.equal(posts[1].body.requestId, posts[2].body.requestId);
});


test('reselecting the identical long-focus substring preserves an unresolved request UUID', async () => {
  const result = source(), chosen = '다시 선택해도 같은 부분';
  result.segments[0].text = '가'.repeat(250) + chosen + '나'.repeat(250);
  result.text = result.segments.map(({ text }) => text).join('\n');
  const held = deferred(); let calls = 0;
  const page = await fixture({ editor: true, result, respond: () => ++calls === 1 ? held.promise : ok() });
  await openEditor(page, 0);
  const select = () => {
    const field = page.nodes().find((node) => node.type === 'textarea' && node.props.readOnly);
    const start = field.props.value.indexOf(chosen);
    field.props.onSelect({ currentTarget: { value: field.props.value, selectionStart: start, selectionEnd: start + chosen.length } });
  };
  select(); await page.settle(); page.run().props.onClick(); await page.settle();
  select(); await page.settle();
  held.reject(new Error('synthetic lost reply')); await page.settle();
  assert.ok(page.hasText('완료된 요청을 확인합니다'));
  select(); await page.settle(); await page.run().props.onClick(); await page.settle();
  const posts = page.requests.filter(({ method }) => method === 'POST');
  assert.equal(posts.length, 2); assert.equal(posts[0].body.requestId, posts[1].body.requestId);
  assert.equal(posts[1].body.text, chosen); assert.ok(page.hasText(ideas[0]));
});
