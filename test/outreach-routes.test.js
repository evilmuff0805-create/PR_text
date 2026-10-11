import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';

process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-key';
const { createOutreachAdminMiddleware } = await import('../src/middleware/outreach-admin.js');
const { createOutreachRouter, outreachSecurityHeaders, createOutreachErrorHandler } = await import('../src/routes/outreach.js');
const { newUnsubscribeToken, hashUnsubscribeToken } = await import('../src/services/outreach-validation.js');
const { safeOAuthReturnPath } = await import('../src/routes/auth.js');
const id = '2897f080-ff22-4ff2-9e6b-b8dd84c2c069';
const otherId = 'ac19a099-1535-40bd-b97e-a3d9ea23ff0c';
const now = Date.parse('2026-10-11T00:00:00Z');
const ready = () => ({ OUTREACH_ADMIN_USER_IDS: id, OUTREACH_SENDING_ENABLED: 'true', OUTREACH_SMTP_PASSWORD: 'synthetic-password', APP_URL: 'https://example.com' });

function fixture({ env = ready(), user = { id }, authError, changes = {} } = {}) {
  const calls = [];
  const auth = { getUser: async token => { calls.push(['getUser', token]); return { data: { user }, error: authError }; } };
  const store = {
    status: async () => { calls.push(['status']); return { admin: true, databaseReady: true, sendingEnabled: false }; },
    listContacts: async options => { calls.push(['listContacts', options]); return { contacts: [], total: 0, ...options }; },
    getContact: async () => ({ channelName: '예시 채널', email: 'review@example.com', publicEmailSource: 'https://example.com/contact', metadataSource: 'manual' }),
    saveContacts: async contacts => { calls.push(['saveContacts', contacts]); return contacts.map(contact => ({ id, ...contact })); },
    listCampaigns: async options => ({ campaigns: [], total: 0, ...options }),
    createCampaign: async campaign => { calls.push(['createCampaign', campaign]); return { id, ...campaign }; },
    campaignDetails: async () => ({ campaign: { id }, messages: [], totalMessages: 0 }),
    previewCampaign: async () => { calls.push(['preview']); return { previewRevision: 2, eligibleCount: 1, excluded: [], samples: [] }; },
    queueCampaign: async (campaignId, options) => { calls.push(['queue', campaignId, options]); return { campaign: { id: campaignId, status: 'queued' }, alreadyQueued: false }; },
    setCampaignState: async (campaignId, action) => { calls.push([action]); return { id: campaignId, status: action === 'start' ? 'running' : 'paused' }; },
    queueTest: async content => { calls.push(['test', content]); return { id, email: 'codemeet@naver.com', status: 'pending' }; },
    getMessage: async () => ({ id, email: 'codemeet@naver.com', status: 'pending' }),
    unsubscribe: async hash => { calls.push(['unsubscribe', hash]); return true; },
    ...changes,
  };
  const router = createOutreachRouter({
    store, env: () => env, now: () => now,
    adminMiddleware: createOutreachAdminMiddleware({ auth, env: () => env }),
    discover: async query => { calls.push(['discover', query]); return { channels: [], nextPageToken: null, minSubscribers: 100000 }; },
    logger: { warn: (...args) => calls.push(['log', ...args]) },
  });
  const app = express();
  app.use('/api/outreach', outreachSecurityHeaders, express.json({ limit: '1mb' }), router);
  app.use('/api/outreach', createOutreachErrorHandler({ logger: { warn: (...args) => calls.push(['log', ...args]) } }));
  return { app, calls };
}

async function serverFor(fixture, run) {
  const server = fixture.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const request = async (path, { auth = true, body, method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/outreach${path}`, {
      method, headers: { ...(auth ? { Authorization: 'Bearer synthetic-token' } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, data: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null };
  };
  try { await run(request); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('OAuth permits only the exact new admin return path alongside existing destinations', () => {
  for (const path of ['/transcribe', '/settings', '/caption-ideas', '/admin/outreach']) assert.equal(safeOAuthReturnPath(path), path);
  for (const path of ['/admin', '/outreach', '/admin/outreach?next=https://evil.example', '//evil.example', 'https://evil.example']) assert.equal(safeOAuthReturnPath(path), '/transcribe');
});

test('anonymous requests never reach contact storage or channel discovery', async () => {
  const f = fixture();
  await serverFor(f, async request => {
    for (const path of ['/status', '/contacts', '/campaigns']) assert.equal((await request(path, { auth: false })).status, 401);
    assert.equal((await request('/discover', { auth: false, body: { query: '예시' } })).status, 401);
  });
  assert.equal(f.calls.length, 0);
});

test('user metadata and email claims cannot replace the environment UUID allowlist', async () => {
  const f = fixture({ user: { id: otherId, email: 'codemeet@naver.com', user_metadata: { admin: true } } });
  await serverFor(f, async request => assert.equal((await request('/status')).status, 403));
  assert.deepEqual(f.calls.map(call => call[0]), ['getUser']);
});

test('every authorized request revalidates getUser without credit/profile mutations', async () => {
  const f = fixture();
  await serverFor(f, async request => {
    assert.equal((await request('/status')).status, 200);
    assert.equal((await request('/contacts')).status, 200);
  });
  assert.equal(f.calls.filter(call => call[0] === 'getUser').length, 2);
});

test('authentication outage is retryable 503 and still returns private response headers', async () => {
  const f = fixture({ user: null, authError: { status: 503, message: 'private error' } });
  await serverFor(f, async request => {
    const response = await request('/status');
    assert.equal(response.status, 503); assert.match(response.headers.get('cache-control'), /no-store/);
    assert.match(response.headers.get('x-robots-tag'), /noindex/); assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.text.includes('private error'), false);
  });
});

test('registration validates the whole batch before writing and leaves public addresses unconsented', async () => {
  const f = fixture();
  await serverFor(f, async request => {
    const invalid = await request('/contacts/import', { body: { csv: 'channelName,email,publicEmailSource\n예시,a@example.com,https://example.com/contact\n잘못된행,not-mail,https://example.com/contact' } });
    assert.equal(invalid.status, 400); assert.equal(f.calls.some(call => call[0] === 'saveContacts'), false);
    const saved = await request('/contacts', { body: { channelName: '예시 채널', email: 'Review@Example.COM', publicEmailSource: 'https://example.com/contact' } });
    assert.equal(saved.status, 201); assert.equal(saved.data.contact.consentStatus, 'unknown');
    assert.equal(saved.data.contact.email, 'review@example.com');
  });
});

test('invalid pagination and impossible reservation dates never reach persistence', async () => {
  const f = fixture();
  await serverFor(f, async request => {
    for (const path of ['/contacts?page=0', '/contacts?limit=201', '/contacts?q[]=x']) assert.equal((await request(path)).status, 400);
    const response = await request(`/campaigns/${id}/queue`, { body: { requestId: otherId, previewRevision: 2, scheduledAt: '2026-11-31T12:00:00Z' } });
    assert.equal(response.status, 400);
  });
  assert.equal(f.calls.some(call => call[0] === 'queue'), false);
});

test('disabled SMTP still allows preview and unscheduled snapshot queue but blocks start/reservation/test', async () => {
  const f = fixture({ env: { OUTREACH_ADMIN_USER_IDS: id } });
  await serverFor(f, async request => {
    assert.equal((await request(`/campaigns/${id}/preview`, { body: {} })).status, 200);
    assert.equal((await request(`/campaigns/${id}/queue`, { body: { requestId: otherId, previewRevision: 2 } })).status, 202);
    assert.equal((await request(`/campaigns/${id}/start`, { body: {} })).status, 409);
    assert.equal((await request(`/campaigns/${id}/queue`, { body: { requestId: otherId, previewRevision: 2, scheduledAt: '2026-10-12T00:00:00Z' } })).status, 409);
    assert.equal((await request('/test-send', { body: { subject: '안내', body: '본문' } })).status, 409);
    assert.equal((await request(`/campaigns/${id}/pause`, { body: {} })).status, 200);
  });
  assert.equal(f.calls.filter(call => call[0] === 'queue').length, 1);
  assert.equal(f.calls.some(call => ['start', 'test'].includes(call[0])), false);
});

test('test send persists a fixed self recipient and reports queued, never delivered', async () => {
  const f = fixture();
  await serverFor(f, async request => {
    const bad = await request('/test-send', { body: { to: 'attacker@example.com', subject: '예시', body: '본문' } });
    assert.equal(bad.status, 400); assert.equal(f.calls.some(call => call[0] === 'test'), false);
    const response = await request('/test-send', { body: { subject: '{{channelName}} 안내', body: '{{channelName}} 예시 본문입니다.' } });
    assert.equal(response.status, 202); assert.equal(response.data.message.email, 'codemeet@naver.com');
    assert.equal(response.data.message.status, 'pending'); assert.match(response.data.notice, /대기열/);
    const content = f.calls.find(call => call[0] === 'test')[1];
    assert.match(content.subject, /^\(광고\)/); assert.equal(content.subject.includes('{{'), false);
  });
});

test('scanner GET cannot unsubscribe and uses an asset-free confirmation page', async () => {
  const f = fixture(), token = newUnsubscribeToken();
  await serverFor(f, async request => {
    const response = await request(`/unsubscribe?token=${token}`, { auth: false });
    assert.equal(response.status, 200); assert.match(response.text, /method="post"/);
    assert.equal(response.text.includes('<script'), false); assert.equal(response.text.includes('src='), false);
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer'); assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(f.calls.some(call => call[0] === 'unsubscribe'), false);
    assert.equal((await request('/unsubscribe?token[]=bad', { auth: false })).status, 400);
  });
});

test('public unsubscribe POST stores a hash, is repeatable and never authenticates', async () => {
  const f = fixture(), token = newUnsubscribeToken();
  await serverFor(f, async request => {
    for (let i = 0; i < 2; i++) assert.equal((await request('/unsubscribe', { auth: false, body: { token } })).status, 200);
    assert.equal((await request('/unsubscribe', { auth: false, body: 'token=' + token, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 200);
  });
  assert.equal(f.calls.some(call => call[0] === 'getUser'), false);
  for (const call of f.calls) { assert.equal(call[1], hashUnsubscribeToken(token)); assert.notEqual(call[1], token); }
});

test('malformed JSON and oversized public forms never log submitted private fragments', async () => {
  const f = fixture();
  const sentinel = 'private-sentinel@example.com';
  await serverFor(f, async request => {
    const badJson = await request('/contacts', { body: `{"email":"${sentinel}","password":broken}` });
    assert.equal(badJson.status, 400); assert.equal(badJson.data.code, 'OUTREACH_INVALID_BODY');
    assert.equal(badJson.text.includes(sentinel), false); assert.match(badJson.headers.get('cache-control'), /no-store/);
    const tooLarge = await request('/unsubscribe', { auth: false, body: `token=${sentinel}${'x'.repeat(3000)}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(tooLarge.status, 413);
  });
  const logs = JSON.stringify(f.calls.filter(call => call[0] === 'log'));
  assert.equal(logs.includes(sentinel), false); assert.equal(logs.includes('password'), false);
  assert.equal(f.calls.some(call => call[0] === 'getUser'), false);
});
