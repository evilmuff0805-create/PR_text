import assert from 'node:assert/strict';
import test from 'node:test';
import { createOutreachApi } from '../client/src/utils/outreach-api.js';
import { contactEligibility, isIsoTimestamp, previewOutreachCsv } from '../client/src/utils/outreach-csv.js';
import { outreachFeedback } from '../client/src/utils/outreach-feedback.js';

const header = 'channelName,email,publicEmailSource';
const row = '예시 채널,editor@example.test,https://example.test/contact';
const now = Date.parse('2026-10-11T01:00:00Z');
const readyContact = {
  channelName: '예시 채널', country: 'KR', subscriberCount: 100000,
  channelCheckedAt: '2026-10-10T01:00:00Z', consentStatus: 'granted',
  consentEvidence: '홍보 메일 수신에 동의한다는 신청 기록을 확인했습니다.',
  consentGrantedAt: '2026-10-01T01:00:00Z',
};

test('CSV preview preserves quoted commas, quotes, multiline evidence and UTF-8 BOM', () => {
  const csv = '\uFEFFchannelName,email,publicEmailSource,consentEvidence\r\n"예시, 채널",editor@example.test,https://example.test/contact,"확인된 회신\r\n""광고 수신에 동의합니다"""\r\n';
  const result = previewOutreachCsv(csv);
  assert.equal(result.errorCount, 0);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].line, 2);
  assert.equal(result.rows[0].contact.channelName, '예시, 채널');
  assert.equal(result.rows[0].contact.consentEvidence, '확인된 회신\n"광고 수신에 동의합니다"');
});

test('CSV preview requires exact known headers and matching field counts', () => {
  assert.throws(() => previewOutreachCsv('channelName,email\n예시,editor@example.test'), /필수/);
  assert.throws(() => previewOutreachCsv(`${header},email\n${row},extra@example.test`), /중복/);
  assert.throws(() => previewOutreachCsv(`${header},__proto__\n${row},value`), /열 이름/);
  assert.match(previewOutreachCsv(`${header}\n${row},extra`).rows[0].errors.join(), /열 개수/);
});

test('CSV duplicate emails are detected case-insensitively before import', () => {
  const result = previewOutreachCsv(`${header}\n${row}\n다른 예시,EDITOR@example.test,https://example.test/other`);
  assert.equal(result.errorCount, 1);
  assert.match(result.rows[1].errors.join(), /중복/);
});

test('CSV import limits count contacts and UTF-8 bytes rather than Korean character count', () => {
  const rows = Array.from({ length: 200 }, (_, index) => `예시 ${index},editor${index}@example.test,https://example.test/contact`);
  assert.equal(previewOutreachCsv(`${header}\n${rows.join('\n')}`).rows.length, 200);
  assert.throws(() => previewOutreachCsv(`${header}\n${rows.join('\n')}\n${row}`), /200행/);
  assert.throws(() => previewOutreachCsv(`${header}\n${'가'.repeat(171000)}`), /512,000바이트/);
});

test('CSV rejects malformed or unclosed quotes including whitespace after a closing quote', () => {
  assert.throws(() => previewOutreachCsv(`${header}\n"예시 채널,editor@example.test,https://example.test`), /따옴표/);
  assert.throws(() => previewOutreachCsv(`${header}\n"예시" ,editor@example.test,https://example.test`), /따옴표 뒤/);
  assert.throws(() => previewOutreachCsv(`${header}\n예"시,editor@example.test,https://example.test`), /따옴표/);
});

test('CSV accepts storage without consent, but rejects granted consent missing evidence or time', () => {
  assert.equal(previewOutreachCsv(`${header}\n${row}`).errorCount, 0);
  const result = previewOutreachCsv(`${header},consentStatus,consentEvidence,consentGrantedAt\n${row},granted,,`);
  assert.equal(result.errorCount, 1);
  assert.match(result.rows[0].errors.join(), /동의/);
  assert.equal(contactEligibility({ ...readyContact, consentStatus: 'unknown' }, now), '수신 동의 미확인 또는 철회');
  assert.equal(contactEligibility({ ...readyContact, consentStatus: 'revoked' }, now), '수신 동의 미확인 또는 철회');
});

test('dates reject impossible calendar dates and accept explicit ISO offsets', () => {
  assert.equal(isIsoTimestamp('2026-02-30T01:00:00Z'), false);
  assert.equal(isIsoTimestamp('2024-02-29T01:00:00.123Z'), true);
  assert.equal(isIsoTimestamp('2026-10-10T10:00:00+09:00'), true);
  assert.equal(isIsoTimestamp('2026-10-10 01:00:00'), false);
});

test('contact selection requires 100,000 subscribers, current metadata and confirmed Korean eligibility', () => {
  assert.equal(contactEligibility(readyContact, now), null);
  assert.match(contactEligibility({ ...readyContact, subscriberCount: 99999 }, now), /10만/);
  assert.match(contactEligibility({ ...readyContact, subscriberCount: null }, now), /10만/);
  assert.match(contactEligibility({ ...readyContact, country: 'US', koreaVerified: true }, now), /한국 외/);
  assert.match(contactEligibility({ ...readyContact, country: '' }, now), /한국 채널/);
  assert.equal(contactEligibility({ ...readyContact, country: '', koreaVerified: true, koreaEvidence: '공식 채널 소개에서 한국 기반 확인' }, now), null);
  assert.match(contactEligibility({ ...readyContact, channelCheckedAt: '2026-09-10T01:00:00Z' }, now), /30일/);
  assert.match(contactEligibility({ ...readyContact, channelCheckedAt: null }, now), /30일/);
  assert.match(contactEligibility({ ...readyContact, consentGrantedAt: '2026-10-12T01:00:00Z' }, now), /일시/);
});

test('API client uses the latest existing auth token and sends raw CSV only to the outreach endpoint', async () => {
  const calls = [];
  let token = 'first-test-token';
  const request = createOutreachApi(() => token, { fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json({ importedCount: 1 }); } });
  await request('/status');
  token = 'second-test-token';
  const csv = `${header}\r\n${row}\r\n`;
  await request('/contacts/import', { method: 'POST', body: { csv } });
  assert.equal(calls[0].url, '/api/outreach/status');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer first-test-token');
  assert.equal(calls[1].url, '/api/outreach/contacts/import');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer second-test-token');
  assert.equal(calls[1].options.cache, 'no-store');
  assert.deepEqual(JSON.parse(calls[1].options.body), { csv });
});

test('API client refuses requests without login or with external destinations', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return Response.json({}); };
  await assert.rejects(createOutreachApi(() => null, { fetchImpl })('/status'), (error) => error.status === 401);
  const request = createOutreachApi(() => 'test-token', { fetchImpl });
  await assert.rejects(request('https://example.test/status'), /올바르지/);
  await assert.rejects(request('//example.test/status'), /올바르지/);
  assert.equal(calls, 0);
});

test('API client preserves permission and CSV row errors for safe UI handling', async () => {
  const permission = createOutreachApi(() => 'test-token', { fetchImpl: async () => Response.json({ error: '관리자 권한이 필요합니다.' }, { status: 403 }) });
  await assert.rejects(permission('/status'), (error) => error.status === 403 && /관리자/.test(error.message));
  const invalidCsv = createOutreachApi(() => 'test-token', { fetchImpl: async () => Response.json({ error: 'CSV 입력값 확인', code: 'OUTREACH_CSV_INVALID', rowErrors: [{ row: 3, field: 'email' }] }, { status: 400 }) });
  await assert.rejects(invalidCsv('/contacts/import', { method: 'POST', body: { csv: 'synthetic' } }), (error) => {
    assert.deepEqual(error.rowErrors, [{ row: 3, field: 'email' }]);
    return error.status === 400 && error.code === 'OUTREACH_CSV_INVALID';
  });
});

test('API client handles non-JSON and network failures without exposing raw server content', async () => {
  const invalidResponse = createOutreachApi(() => 'test-token', { fetchImpl: async () => new Response('<html>internal details</html>', { status: 502 }) });
  await assert.rejects(invalidResponse('/status'), (error) => error.status === 502 && !error.message.includes('internal details'));
  const networkFailure = createOutreachApi(() => 'test-token', { fetchImpl: async () => { throw new Error('transport details'); } });
  await assert.rejects(networkFailure('/status'), (error) => /새로고침/.test(error.message) && !error.message.includes('transport details'));
  const aborted = createOutreachApi(() => 'test-token', { fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); } });
  await assert.rejects(aborted('/status'), (error) => error.name === 'AbortError');
});

test('delivery reasons explain consent, limits and uncertain results without suggesting automatic resend', () => {
  assert.match(outreachFeedback('recently_contacted').message, /최근 30일.*발송 상태/);
  assert.match(outreachFeedback('send_limit').message, /대기 중.*기다려/);
  assert.match(outreachFeedback('unsubscribed').message, /수신거부.*제외/);
  assert.match(outreachFeedback('SMTP_AUTH_UNCERTAIN').message, /인증.*전송 여부/);
  assert.match(outreachFeedback('WORKER_LOST_DURING_SEND').message, /결과 확인.*수신 여부/);
  assert.equal(outreachFeedback('SMTP_SEND_UNCERTAIN').supportCode, null);
  assert.match(outreachFeedback('SMTP_FUTURE_FAILURE').message, /메일 서버 처리 확인/);
  assert.equal(outreachFeedback('FUTURE_REASON_1').supportCode, 'FUTURE_REASON_1');
  assert.equal(outreachFeedback('SMTP_<script>private details</script>').supportCode, null);
  assert.equal(outreachFeedback(null).supportCode, null);
});
