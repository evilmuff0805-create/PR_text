import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { transformWithEsbuild } from 'vite';
import { createOutreachApi } from '../client/src/utils/outreach-api.js';
import * as outreachCsv from '../client/src/utils/outreach-csv.js';
import * as feedback from '../client/src/utils/outreach-feedback.js';

const source = await readFile(new URL('../client/src/pages/OutreachPage.jsx', import.meta.url), 'utf8');
const { code } = await transformWithEsbuild(source, 'OutreachPage.jsx', { jsx: 'automatic', format: 'cjs' });
const campaignId = '10000000-0000-4000-8000-000000000001';
const contactId = '10000000-0000-4000-8000-000000000002';
const testMessageId = '10000000-0000-4000-8000-000000000003';
const status = {
  admin: true, databaseReady: true, discoveryConfigured: true, sendingEnabled: true,
  smtpConfigured: true, publicUrlConfigured: true, limitsConfigured: true, dailyLimit: 25,
  intervalSeconds: 60, minIntervalSeconds: 60, maxImportRows: 200,
  defaults: { subject: '(광고) {{channelName}} 편집팀께', body: '{{channelName}} 담당자님께 예시 서비스를 소개드립니다.' },
};
const campaign = { id: campaignId, name: '예시 캠페인', status: 'draft', subject: status.defaults.subject, body: status.defaults.body, contactIds: [contactId], createdAt: '2026-10-01T01:00:00Z' };

// Execute the page's real hooks and event handlers against an isolated HTTP mock.
function pageHarness({ initialUser = { id: 'admin-fixture' }, contacts = [], statusOverride = {}, respond } = {}) {
  const hooks = [];
  const pendingEffects = [];
  const requests = [];
  const timers = new Map();
  const document = { hidden: false };
  let timerNumber = 0;
  let cursor = 0, dirty = true, tree, user = initialUser, requestNumber = 0;
  const same = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[index].value, (next) => {
        const value = typeof next === 'function' ? next(hooks[index].value) : next;
        if (!Object.is(value, hooks[index].value)) { hooks[index].value = value; dirty = true; }
      }];
    },
    useRef(initial) { const index = cursor++; return (hooks[index] ||= { current: initial }); },
    useMemo(callback, deps) {
      const index = cursor++;
      if (!same(hooks[index]?.deps, deps)) hooks[index] = { value: callback(), deps };
      return hooks[index].value;
    },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
    useEffect(callback, deps) {
      const index = cursor++;
      if (!same(hooks[index]?.deps, deps)) {
        const previous = hooks[index];
        hooks[index] = { deps };
        pendingEffects.push(() => { previous?.cleanup?.(); hooks[index].cleanup = callback(); });
      }
    },
  };
  const getToken = () => user ? 'fixture-token' : null;
  const fetchImpl = async (url, options) => {
    const request = { url, method: options.method, body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(request);
    const custom = await respond?.(request);
    if (custom) return custom;
    if (url === '/api/outreach/status') return Response.json({ ...status, ...statusOverride });
    if (url.startsWith('/api/outreach/contacts?')) return Response.json({ contacts, total: contacts.length, page: 1, limit: 50 });
    if (url.startsWith('/api/outreach/campaigns?')) return Response.json({ campaigns: [campaign], total: 1, page: 1, limit: 50 });
    if (url === `/api/outreach/campaigns/${campaignId}`) return Response.json({ campaign, messages: [], totalMessages: 0 });
    if (url.endsWith('/preview')) return Response.json({ previewRevision: 1, eligibleCount: 1, excluded: [], subject: campaign.subject, body: campaign.body, samples: [{ contactId, channelName: '예시 채널', to: 'editor@example.test', subject: '(광고) 예시 채널 편집팀께', body: '<script>synthetic text</script>' }] });
    if (url.endsWith('/queue')) return Response.json({ campaign: { ...campaign, status: 'queued' } }, { status: 202 });
    if (url === '/api/outreach/test-send') return Response.json({ message: { id: testMessageId, email: 'codemeet@naver.com', status: 'pending' } }, { status: 202 });
    if (url === `/api/outreach/messages/${testMessageId}`) return Response.json({ message: { id: testMessageId, email: 'codemeet@naver.com', status: 'pending' } });
    if (url === `/api/outreach/contacts/${contactId}`) return Response.json({ contact: { id: contactId, ...request.body } });
    throw new Error(`Unexpected fixture endpoint: ${url}`);
  };
  const element = (type, props) => ({ type, props: props || {} });
  const dependencies = {
    react,
    'react/jsx-runtime': { jsx: element, jsxs: element },
    '../components/AuthModal.jsx': (props) => props.isOpen ? element('auth-modal', props) : null,
    '../contexts/AuthContext.jsx': { useAuth: () => ({ user, getToken }) },
    '../utils/outreach-api.js': { createOutreachApi: (get) => createOutreachApi(get, { fetchImpl }) },
    '../utils/outreach-csv.js': outreachCsv,
    '../utils/outreach-feedback.js': feedback,
  };
  const module = { exports: {} };
  runInNewContext(code, {
    module, exports: module.exports, require: (name) => { assert.ok(name in dependencies, name); return dependencies[name]; },
    AbortController, TextEncoder, TextDecoder, Date, Map, Set, Symbol,
    crypto: { randomUUID: () => `20000000-0000-4000-8000-${String(++requestNumber).padStart(12, '0')}` },
    document, setInterval: (callback) => { const id = ++timerNumber; timers.set(id, callback); return id; }, clearInterval: (id) => timers.delete(id),
  });
  const expand = (node) => {
    if (Array.isArray(node)) return node.map(expand);
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') return expand(node.type(node.props));
    return { ...node, props: { ...node.props, children: expand(node.props.children) } };
  };
  const nodes = (node = tree, result = []) => {
    if (Array.isArray(node)) node.forEach((child) => nodes(child ?? null, result));
    else if (node && typeof node === 'object') { result.push(node); nodes(node.props.children ?? null, result); }
    return result;
  };
  const text = (node) => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props.children) : node == null || typeof node === 'boolean' ? '' : String(node);
  const render = () => { cursor = 0; dirty = false; tree = expand(module.exports.default()); };
  const settle = async () => {
    for (let turn = 0; turn < 30; turn += 1) {
      if (dirty) render();
      pendingEffects.splice(0).forEach((effect) => effect());
      await new Promise(setImmediate);
      if (!dirty && !pendingEffects.length) return;
    }
    throw new Error('Page fixture did not settle');
  };
  const button = (label) => { const match = nodes().find((node) => node.type === 'button' && text(node) === label); assert.ok(match, `Missing button: ${label}`); return match; };
  const field = (label) => {
    const wrapper = nodes().find((node) => node.type === 'label' && Array.isArray(node.props.children) && text(node.props.children[0]) === label);
    assert.ok(wrapper, `Missing field: ${label}`);
    return nodes(wrapper).find((node) => ['input', 'select', 'textarea'].includes(node.type));
  };
  return { requests, settle, button, field, nodes, text: () => text(tree), setUser: (next) => { user = next; dirty = true; }, setHidden: (hidden) => { document.hidden = hidden; }, tick: async () => { [...timers.values()].forEach((callback) => callback()); await settle(); } };
}

test('logged-out and non-admin visitors never load contacts or campaigns', async () => {
  const loggedOut = pageHarness({ initialUser: null });
  await loggedOut.settle();
  assert.equal(loggedOut.requests.length, 0);
  loggedOut.button('로그인').props.onClick();
  await loggedOut.settle();
  assert.equal(loggedOut.nodes().find(({ type }) => type === 'auth-modal').props.returnPath, '/admin/outreach');
  const denied = pageHarness({ respond: ({ url }) => url.endsWith('/status') ? Response.json({ error: '권한 없음' }, { status: 403 }) : undefined });
  await denied.settle();
  assert.match(denied.text(), /관리자 권한/);
  assert.deepEqual(denied.requests.map(({ url }) => url), ['/api/outreach/status']);
});

test('expired API contact is refreshed by PATCH while preserving its email and consent', async () => {
  const expired = { id: contactId, channelId: null, channelName: null, channelUrl: null, category: 'actor', country: null, subscriberCount: null, channelCheckedAt: null, metadataSource: 'youtube_api', metadataExpiredAt: '2026-09-01T01:00:00Z', email: 'editor@example.test', publicEmailSource: 'https://example.test/contact', consentStatus: 'granted', consentEvidence: '홍보 메일 수신에 동의한다는 회신 기록입니다.', consentGrantedAt: '2026-09-01T01:00:00Z' };
  const channel = { channelId: 'UC1234567890123456789012', channelName: '재확인 예시 채널', channelUrl: 'https://www.youtube.com/channel/UC1234567890123456789012', category: 'actor', country: 'KR', koreaVerified: true, subscriberCount: 120000, checkedAt: '2026-10-10T01:00:00Z' };
  const page = pageHarness({ contacts: [expired], respond: ({ url }) => url.endsWith('/discover') ? Response.json({ channels: [channel] }) : undefined });
  await page.settle();
  page.button('수정').props.onClick(); await page.settle();
  page.field('채널명 또는 키워드').props.onChange({ target: { value: '예시' } }); await page.settle();
  const searchForm = page.nodes().find(({ type, props }) => type === 'form' && props.className === 'outreach-search');
  searchForm.props.onSubmit({ preventDefault() {} }); await page.settle();
  page.button('이 연락처의 채널로 확인').props.onClick(); await page.settle();
  const saveForm = page.nodes().find(({ type, props }) => type === 'form' && page.nodes({ type, props }).some((node) => node.type === 'button' && node.props.type === 'submit' && node.props.children === '연락처 수정 저장'));
  assert.ok(saveForm);
  saveForm.props.onSubmit({ preventDefault() {} }); await page.settle();
  const update = page.requests.find(({ method }) => method === 'PATCH');
  assert.equal(update.url, `/api/outreach/contacts/${contactId}`);
  assert.equal(update.body.email, expired.email);
  assert.equal(update.body.consentStatus, 'granted');
  assert.equal(update.body.consentEvidence, expired.consentEvidence);
  assert.equal(update.body.channelId, channel.channelId);
  assert.equal(update.body.channelName, channel.channelName);
  assert.equal(Date.parse(update.body.channelCheckedAt), Date.parse(channel.checkedAt));
  assert.equal(update.body.metadataSource, 'youtube_api');
  assert.equal('metadataExpiredAt' in update.body, false);
});

test('unconfigured mail remains previewable and cannot queue an actual test delivery', async () => {
  const page = pageHarness({ statusOverride: { smtpConfigured: false, sendingEnabled: false } });
  await page.settle();
  page.field('저장한 캠페인').props.onChange({ target: { value: campaignId } }); await page.settle();
  await page.button('문안·발송 대상 미리보기').props.onClick(); await page.settle();
  assert.equal(page.button('본인에게 테스트 메일 보내기 (codemeet@naver.com)').props.disabled, true);
  assert.match(page.text(), /<script>synthetic text<\/script>/);
  assert.ok(!page.nodes().some(({ type }) => type === 'script'));
  assert.ok(!page.nodes().some(({ props }) => props.dangerouslySetInnerHTML));
  assert.equal(page.requests.some(({ url }) => url.endsWith('/test-send')), false);
});

test('ambiguous queue retries reuse the UUID and never implicitly start delivery', async () => {
  let attempts = 0;
  const page = pageHarness({ respond: ({ url }) => { if (url.endsWith('/queue') && ++attempts === 1) throw new Error('fixture response lost'); return undefined; } });
  await page.settle();
  page.field('저장한 캠페인').props.onChange({ target: { value: campaignId } }); await page.settle();
  await page.button('문안·발송 대상 미리보기').props.onClick(); await page.settle();
  await page.button('발송 대기열에 저장').props.onClick(); await page.settle();
  await page.button('발송 대기열에 저장').props.onClick(); await page.settle();
  const queues = page.requests.filter(({ url }) => url.endsWith('/queue'));
  assert.equal(queues.length, 2);
  assert.equal(queues[0].body.requestId, queues[1].body.requestId);
  assert.equal(queues[0].body.previewRevision, 1);
  assert.equal('scheduledAt' in queues[0].body, false);
  assert.equal(page.requests.some(({ url }) => url.endsWith('/start')), false);
});

test('self-test polls only while visible, shows final outcomes and stops polling after completion', async () => {
  for (const [finalStatus, label] of [['sent', '메일 서버 접수'], ['failed', '실패'], ['uncertain', '전송 확인 필요']]) {
    let resultStatus = 'pending';
    const page = pageHarness({ respond: ({ url }) => url === `/api/outreach/messages/${testMessageId}` ? Response.json({ message: { id: testMessageId, email: 'codemeet@naver.com', status: resultStatus, errorCode: resultStatus === 'uncertain' ? 'SMTP_AUTH_UNCERTAIN' : null } }) : undefined });
    await page.settle();
    page.field('저장한 캠페인').props.onChange({ target: { value: campaignId } }); await page.settle();
    await page.button('문안·발송 대상 미리보기').props.onClick(); await page.settle();
    await page.button('본인에게 테스트 메일 보내기 (codemeet@naver.com)').props.onClick(); await page.settle();
    const testRequest = page.requests.find(({ url }) => url.endsWith('/test-send'));
    assert.deepEqual(testRequest.body, { subject: campaign.subject, body: campaign.body });
    const messageRequests = () => page.requests.filter(({ url }) => url.includes('/messages/')).length;
    const initial = messageRequests();
    assert.equal(initial, 1);
    page.setHidden(true); await page.tick();
    assert.equal(messageRequests(), initial);
    resultStatus = finalStatus; page.setHidden(false); await page.tick();
    assert.equal(messageRequests(), initial + 1);
    assert.match(page.text(), new RegExp(label));
    assert.match(page.text(), /실제 수신을 보장하지 않습니다/);
    if (finalStatus === 'uncertain') assert.match(page.text(), /메일 서버 인증을 확인/);
    await page.tick();
    assert.equal(messageRequests(), initial + 1);
  }
});

test('excluded recipients and mail errors show Korean actions with optional support codes only for unknown reasons', async () => {
  const page = pageHarness({ respond: ({ url }) => {
    if (url === `/api/outreach/campaigns/${campaignId}`) return Response.json({ campaign, messages: [{ id: 'message-fixture', channelName: '예시 채널', email: 'editor@example.test', status: 'skipped', errorCode: 'channel_check_expired' }] });
    if (url.endsWith('/preview')) return Response.json({ previewRevision: 1, eligibleCount: 0, samples: [], excluded: [{ contactId, reason: 'consent_required' }, { contactId: 'unknown-fixture', reason: 'FUTURE_REASON_1' }], subject: campaign.subject, body: campaign.body });
    return undefined;
  } });
  await page.settle();
  page.field('저장한 캠페인').props.onChange({ target: { value: campaignId } }); await page.settle();
  await page.button('문안·발송 대상 미리보기').props.onClick(); await page.settle();
  assert.match(page.text(), /수신 동의 확인 필요/);
  assert.match(page.text(), /채널 정보 재확인 필요/);
  assert.match(page.text(), /처리 결과 확인이 필요/);
  assert.doesNotMatch(page.text(), /consent_required|channel_check_expired/);
  assert.ok(page.nodes().some(({ type, props }) => type === 'details' && page.nodes({ type, props }).some((node) => node.type === 'code' && node.props.children === 'FUTURE_REASON_1')));
});
