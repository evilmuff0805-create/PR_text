import assert from 'node:assert/strict';
import test from 'node:test';
import { createOutreachMailer, outreachSmtpOptions } from '../src/services/outreach-mail.js';
import {
  OUTREACH_DEFAULTS, OutreachError, hashUnsubscribeToken, newUnsubscribeToken, renderOutreachTemplate,
} from '../src/services/outreach-validation.js';

process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-key';
const { createOutreachWorker } = await import('../src/services/outreach-worker.js');
const { createOutreachStore, outreachContactResponse, outreachCampaignResponse, outreachMessageResponse } = await import('../src/services/outreach-store.js');
const ready = () => ({ APP_URL: 'https://example.com', OUTREACH_SENDING_ENABLED: 'true', OUTREACH_SMTP_PASSWORD: 'synthetic-test-password' });
const messageId = '12982d70-6348-44ac-a716-04d796ce3ae2';
const message = () => ({ id: messageId, email: 'recipient@example.com', subject: '(광고) 예시 안내', body: '예시 제작 서비스 소개입니다.', lease_expires_at: new Date(121000).toISOString() });
const unsubscribe = () => `https://example.com/api/outreach/unsubscribe?token=${newUnsubscribeToken()}`;

test('Naver transport fixes account/host and requires authenticated TLS on supported ports', () => {
  const options = outreachSmtpOptions(ready());
  assert.equal(options.host, 'smtp.naver.com'); assert.equal(options.port, 587);
  assert.equal(options.auth.user, 'codemeet@naver.com');
  assert.equal(options.secure, false); assert.equal(options.requireTLS, true);
  assert.equal(options.tls.rejectUnauthorized, true); assert.equal(options.debug, false);
  assert.equal(options.maxRecipients, 1); assert.equal(options.disableUrlAccess, true);
  const implicit = outreachSmtpOptions({ ...ready(), OUTREACH_SMTP_PORT: '465' });
  assert.equal(implicit.secure, true); assert.equal(implicit.tls.rejectUnauthorized, true);
  assert.throws(() => outreachSmtpOptions({ ...ready(), OUTREACH_SMTP_PORT: '25' }));
});

test('mailer sends only fixed sender and recipient envelope fields, with bilingual unsubscribe footer', async () => {
  let captured, options, closed = 0;
  const mailer = createOutreachMailer({ env: ready, createTransport: value => {
    options = value;
    return { sendMail: async mail => { captured = mail; return { accepted: [mail.to] }; }, close: () => closed++ };
  } });
  await mailer.send({ ...message(), unsubscribeUrl: unsubscribe(), messageId: `<outreach-${messageId}@pr-text.com>`, bcc: 'ignored@example.com', attachments: [{ path: '/private' }] });
  assert.equal(options.port, 587);
  assert.equal(captured.from.address, 'codemeet@naver.com'); assert.equal(captured.replyTo, 'codemeet@naver.com');
  assert.deepEqual(captured.envelope, { from: 'codemeet@naver.com', to: ['recipient@example.com'] });
  assert.equal(captured.bcc, undefined); assert.equal(captured.attachments, undefined);
  assert.match(captured.text, /010-4901-1421/); assert.match(captured.text, /To stop receiving promotional emails/);
  assert.match(captured.headers['List-Unsubscribe'], /^<https:/); assert.ok(closed > 0);
});

test('rendered long channel names and bodies use rendered limits instead of authoring limits', async () => {
  let calls = 0;
  const mailer = createOutreachMailer({ env: ready, createTransport: () => ({ sendMail: async () => { calls++; return {}; } }) });
  const content = renderOutreachTemplate(OUTREACH_DEFAULTS, '가'.repeat(200));
  await mailer.send({ email: 'recipient@example.com', ...content, body: '본문'.repeat(6500), unsubscribeUrl: unsubscribe(), messageId: `<outreach-${messageId}@pr-text.com>` });
  assert.equal(calls, 1);
});

test('disabled or invalid mail inputs never instantiate a transport', async () => {
  let calls = 0;
  const factory = () => { calls++; throw new Error('transport must not be created'); };
  await assert.rejects(() => createOutreachMailer({ env: () => ({ ...ready(), OUTREACH_SENDING_ENABLED: 'false' }), createTransport: factory }).send(message()));
  const mailer = createOutreachMailer({ env: ready, createTransport: factory });
  for (const changes of [{ email: 'a@example.com,b@example.com' }, { subject: '안내\r\nBcc:x@example.com' },
    { body: '본문\u0000' }, { unsubscribeUrl: `https://attacker.example/api/outreach/unsubscribe?token=${newUnsubscribeToken()}` },
    { unsubscribeUrl: `https://user:pass@example.com/api/outreach/unsubscribe?token=${newUnsubscribeToken()}` },
    { unsubscribeUrl: `${unsubscribe()}&extra=value` }, { unsubscribeUrl: `${unsubscribe()}&token=${newUnsubscribeToken()}` },
    { messageId: '<bad>\r\nBcc:x@example.com' }]) {
    await assert.rejects(() => mailer.send({ ...message(), unsubscribeUrl: unsubscribe(), messageId: `<outreach-${messageId}@pr-text.com>`, ...changes }));
  }
  assert.equal(calls, 0);
});

test('abort closes an active SMTP transport and returns an uncertain result to the worker', async () => {
  const controller = new AbortController();
  let closeCount = 0, notify;
  const entered = new Promise(resolve => { notify = resolve; });
  const mailer = createOutreachMailer({ env: ready, createTransport: () => ({ sendMail: () => { notify(); return new Promise(() => {}); }, close: () => closeCount++ }) });
  const sending = mailer.send({ ...message(), unsubscribeUrl: unsubscribe(), messageId: `<outreach-${messageId}@pr-text.com>`, signal: controller.signal });
  await entered; controller.abort();
  await assert.rejects(() => sending, error => error.code === 'OUTREACH_SEND_ABORTED');
  assert.ok(closeCount > 0);
});

function fixture({ settings = ready(), overrides = {}, mail } = {}) {
  const events = [], logs = [];
  let available = true, current = message();
  const store = {
    expireApiMetadata: async () => events.push(['expire']), recoverDispatch: async () => events.push(['recover']),
    claim: async (token, config) => { events.push(['claim', token, config]); if (!available) return null; available = false; return current; },
    begin: async (id, token, hash, config) => { events.push(['begin', id, token, hash, config]); return { ...current, status: 'sending' }; },
    releaseClaim: async (...args) => { events.push(['release', ...args]); },
    finish: async (...args) => { events.push(['finish', ...args]); return true; },
    ...overrides,
  };
  const mailer = { send: mail || (async value => { events.push(['send', value]); return { accepted: [value.email], rejected: [] }; }) };
  const worker = createOutreachWorker({ store, mailer, env: () => settings, logger: { warn: (...args) => logs.push(args) }, now: () => 1000, pollMs: 60_000 });
  return { worker, store, events, logs, settings };
}
async function run(f) { f.worker.start(); try { await f.worker.tick(); } finally { await f.worker.stop(); } }

test('SMTP off still maintains API retention and recovery without consuming a claim', async () => {
  const f = fixture({ settings: { ...ready(), OUTREACH_SENDING_ENABLED: 'false' } });
  await run(f);
  assert.deepEqual(f.events.map(event => event[0]), ['expire', 'recover']);
});

test('missing migration fails closed and logs only one non-sensitive code', async () => {
  const f = fixture({ overrides: { expireApiMetadata: async () => { throw new OutreachError('not ready', 503, 'OUTREACH_DATABASE_NOT_READY'); } } });
  f.worker.start(); await f.worker.tick(); await f.worker.tick(); await f.worker.stop();
  assert.equal(f.logs.length, 1); assert.equal(f.events.length, 0);
  assert.equal(JSON.stringify(f.logs).includes('synthetic-test-password'), false);
});

test('worker persists sending before SMTP and stores only the unsubscribe hash', async () => {
  const f = fixture(); await run(f);
  assert.deepEqual(f.events.map(event => event[0]), ['expire', 'recover', 'claim', 'begin', 'send', 'finish']);
  const begin = f.events.find(event => event[0] === 'begin');
  const sent = f.events.find(event => event[0] === 'send')[1];
  const raw = new URL(sent.unsubscribeUrl).searchParams.get('token');
  assert.equal(begin[3], hashUnsubscribeToken(raw)); assert.notEqual(begin[3], raw);
  assert.equal(f.events.at(-1)[3], 'sent');
});

test('a final consent/recipient rejection never reaches SMTP', async () => {
  const f = fixture({ overrides: { begin: async () => null } }); await run(f);
  assert.equal(f.events.some(event => event[0] === 'send'), false);
  assert.equal(f.events.some(event => event[0] === 'finish'), false);
});

test('missing, expired and delayed begin leases never reach SMTP', async () => {
  for (const lease_expires_at of [undefined, 'invalid', new Date(999).toISOString(), new Date(60999).toISOString()]) {
    const f = fixture({ overrides: { begin: async () => ({ ...message(), lease_expires_at }) } });
    await run(f);
    assert.equal(f.events.some(event => event[0] === 'send'), false);
    const finish = f.events.find(event => event[0] === 'finish');
    assert.equal(finish[3], 'uncertain'); assert.equal(finish[4], 'SMTP_LEASE_UNCERTAIN');
  }
});

test('turning sending off after claiming releases only the unstarted claim', async () => {
  const f = fixture();
  f.store.claim = async () => { f.settings.OUTREACH_SENDING_ENABLED = 'false'; return message(); };
  await run(f);
  assert.equal(f.events.filter(event => event[0] === 'release').length, 1);
  assert.equal(f.events.some(event => ['begin', 'send'].includes(event[0])), false);
});

test('SMTP rejection becomes uncertain without automatic resend or private error logging', async () => {
  let sendCount = 0;
  const f = fixture({ mail: async () => { sendCount++; throw Object.assign(new Error('private recipient@example.com password=secret'), { code: 'EAUTH' }); } });
  f.worker.start(); await f.worker.tick(); await f.worker.tick(); await f.worker.stop();
  assert.equal(sendCount, 1);
  assert.equal(f.events.find(event => event[0] === 'finish')[3], 'uncertain');
  assert.equal(f.events.find(event => event[0] === 'finish')[4], 'SMTP_AUTH_UNCERTAIN');
  assert.equal(JSON.stringify(f.logs).includes('recipient@example.com'), false);
  assert.equal(JSON.stringify(f.logs).includes('password='), false);
});

test('accepted SMTP with DB result loss never invokes SMTP a second time', async () => {
  const statuses = []; let sendCount = 0;
  const f = fixture({ mail: async value => { sendCount++; return { accepted: [value.email] }; }, overrides: {
    finish: async (id, token, status) => { statuses.push(status); if (status === 'sent') throw new Error('DB offline'); return true; },
  } });
  f.worker.start(); await f.worker.tick(); await f.worker.tick(); await f.worker.stop();
  assert.equal(sendCount, 1); assert.deepEqual(statuses, ['sent', 'uncertain']);
});

test('unconfirmed SMTP acceptance is not reported as sent', async () => {
  const f = fixture({ mail: async () => ({ accepted: [], rejected: [] }) }); await run(f);
  assert.equal(f.events.find(event => event[0] === 'finish')[3], 'uncertain');
});

test('worker ticks do not overlap while SMTP is in flight', async () => {
  let resolveSend, sendCount = 0, entered;
  const sending = new Promise(resolve => { entered = resolve; });
  const f = fixture({ mail: value => { sendCount++; entered(); return new Promise(resolve => { resolveSend = () => resolve({ accepted: [value.email] }); }); } });
  f.worker.start(); await sending;
  const a = f.worker.tick(), b = f.worker.tick();
  assert.equal(a, b); assert.equal(sendCount, 1);
  resolveSend(); await a; await f.worker.stop();
});

test('shutdown aborts an in-flight SMTP attempt and leaves uncertainty instead of retrying', async () => {
  let entered;
  const sending = new Promise(resolve => { entered = resolve; });
  const f = fixture({ mail: ({ signal }) => { entered(); return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('closed')), { once: true })); } });
  f.worker.start(); await sending; await f.worker.stop();
  assert.equal(f.events.find(event => event[0] === 'finish')[3], 'uncertain');
});

test('status distinguishes missing migration from unexpected DB failure without secrets', async () => {
  const missing = createOutreachStore({ env: ready, admin: { rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'internal schema detail' } }) } });
  const status = await missing.status();
  assert.equal(status.databaseReady, false); assert.match(status.databaseMessage, /마이그레이션/);
  assert.equal(status.limitsConfigured, true); assert.equal(status.quotaTimezone, 'Asia/Seoul');
  assert.equal(JSON.stringify(status).includes('synthetic-test-password'), false);
  const unavailable = createOutreachStore({ admin: { rpc: async () => ({ error: { code: '08006', message: 'private database host' } }) } });
  await assert.rejects(() => unavailable.status(), error => error.status === 503 && error.code === 'OUTREACH_DATABASE_UNAVAILABLE');
});

test('public response mapping never includes lease, token hashes, SMTP receipts or actor secrets', () => {
  const raw = { id: messageId, email: 'recipient@example.com', subscriber_count: null, worker_token: 'secret-worker', unsubscribe_token_hash: 'secret-hash', smtp_message_id: 'private-smtp', subject: 'private snapshot' };
  for (const mapped of [outreachContactResponse(raw), outreachCampaignResponse(raw), outreachMessageResponse(raw)]) {
    const text = JSON.stringify(mapped);
    assert.equal(text.includes('secret-worker'), false); assert.equal(text.includes('secret-hash'), false); assert.equal(text.includes('private-smtp'), false);
  }
  assert.equal(outreachMessageResponse(raw).subject, undefined);
});
