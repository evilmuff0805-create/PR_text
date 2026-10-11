import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OUTREACH_DEFAULTS, normalizeOutreachEmail, validateOutreachContact, validateOutreachCampaign,
  validateOutreachTemplate, validateOutreachSchedule, renderOutreachTemplate, parseOutreachCsv,
  readOutreachConfig, hashUnsubscribeToken, newUnsubscribeToken, outreachFooter,
} from '../src/services/outreach-validation.js';

const now = Date.parse('2026-10-11T00:00:00Z');
const id = '59e90b11-1d77-40a8-a1e6-3138529ff242';
const contact = (changes = {}) => ({
  channelName: '예시 제작 채널', email: 'review@example.com', publicEmailSource: 'https://example.com/contact',
  country: 'KR', subscriberCount: 120000, channelCheckedAt: '2026-10-10T12:00:00Z', ...changes,
});

test('email normalization accepts one mailbox and rejects header and recipient injection', () => {
  assert.equal(normalizeOutreachEmail(' Review+Edit@Example.COM '), 'review+edit@example.com');
  for (const email of ['one@example.com,two@example.com', 'Name <one@example.com>', 'one@example.com\r\nBcc:x@example.com',
    'a..b@example.com', '.a@example.com', 'a@-example.com', 'a@example.com\u2028Bcc:x', ['a@example.com']]) {
    assert.throws(() => normalizeOutreachEmail(email));
  }
});

test('public business email registration never implies consent', () => {
  const saved = validateOutreachContact(contact(), { now });
  assert.equal(saved.consentStatus, 'unknown');
  assert.equal(saved.consentGrantedAt, null);
  assert.equal(saved.metadataSource, 'manual');
  assert.equal(saved.koreaVerified, true);
});

test('explicit consent requires a separate descriptive record and timestamp', () => {
  for (const changes of [
    { consentStatus: 'granted' },
    { consentStatus: 'granted', consentEvidence: 'https://example.com/contact', consentGrantedAt: '2026-10-10T00:00:00Z' },
    { consentStatus: 'granted', consentEvidence: '담당자의 명시적 홍보 수신 동의 회신 확인' },
  ]) assert.throws(() => validateOutreachContact(contact(changes), { now }));
  assert.equal(validateOutreachContact(contact({ consentStatus: 'granted', consentEvidence: '담당자의 명시적 홍보 수신 동의 회신 확인', consentGrantedAt: '2026-10-10T00:00:00Z' }), { now }).consentStatus, 'granted');
});

test('country confirmation cannot override an explicit foreign country', () => {
  assert.equal(validateOutreachContact(contact({ country: 'US', koreaVerified: true, koreaEvidence: '관리자 확인 자료' }), { now }).koreaVerified, false);
  assert.throws(() => validateOutreachContact(contact({ country: '', koreaVerified: true }), { now }));
  assert.equal(validateOutreachContact(contact({ country: '', koreaVerified: true, koreaEvidence: '공식 소개 페이지에서 한국 기반 제작사 확인' }), { now }).koreaVerified, true);
});

test('server rejects invalid scalar types, header controls and unexpected options', () => {
  for (const changes of [
    { koreaVerified: 'true' }, { subscriberCount: '120000' }, { subscriberCount: NaN }, { subscriberCount: -1 },
    { channelName: '채널\nBcc:other' }, { channelName: '채널\u202e다른값' }, { email: null },
    { country: ['KR'] }, { metadataSource: 'scraped' }, { headers: { Bcc: 'other@example.com' } },
  ]) assert.throws(() => validateOutreachContact(contact(changes), { now }));
  assert.equal(validateOutreachContact(contact({ subscriberCount: null }), { now }).subscriberCount, null);
});

test('API data has an explicit check date and cannot be relabelled as manual', () => {
  assert.throws(() => validateOutreachContact(contact({ metadataSource: 'youtube_api', channelCheckedAt: null }), { now }));
  const manual = validateOutreachContact(contact(), { now });
  const api = validateOutreachContact({ metadataSource: 'youtube_api' }, { existing: manual, now });
  assert.equal(api.metadataSource, 'youtube_api');
  assert.throws(() => validateOutreachContact({ metadataSource: 'manual' }, { existing: api, now }));
  assert.throws(() => validateOutreachContact({ email: 'replacement@example.com' }, { existing: api, now }));
});

test('expired API contact can withdraw consent without inventing channel metadata', () => {
  const existing = { ...validateOutreachContact(contact({ metadataSource: 'youtube_api' }), { now }), channelName: null, channelId: null, channelUrl: '', country: '', subscriberCount: null, koreaVerified: false, koreaEvidence: '', channelCheckedAt: null, metadataExpiredAt: '2026-10-11T00:00:00Z' };
  const revoked = validateOutreachContact({ consentStatus: 'revoked' }, { existing, now });
  assert.equal(revoked.channelName, null);
  assert.equal(revoked.channelCheckedAt, null);
  assert.equal(revoked.consentStatus, 'revoked');
  assert.throws(() => validateOutreachContact({ consentStatus: 'granted' }, { existing, now }));
});

test('calendar checks reject impossible dates, 24h rollover and invalid timezones', () => {
  for (const value of ['2026-09-31T00:00:00Z', '2026-02-29T00:00:00Z', '2026-10-10T24:00:00Z',
    '2026-10-10T00:60:00Z', '2026-10-10T00:00:60Z', '2026-10-10T00:00:00+14:01',
    '2026-10-10T00:00:00+15:00', '2026-10-10', true, 123]) {
    for (const field of ['consentGrantedAt', 'channelCheckedAt']) assert.throws(() => validateOutreachContact(contact({ [field]: value }), { now }));
  }
  assert.equal(validateOutreachContact(contact({ channelCheckedAt: '2024-02-29T12:00:00+09:00' }), { now }).channelCheckedAt, '2024-02-29T03:00:00.000Z');
  assert.throws(() => validateOutreachContact(contact({ consentGrantedAt: '2026-10-11T00:04:00Z' }), { now }));
});

test('reservation uses the same strict calendar and bounded future window', () => {
  assert.equal(validateOutreachSchedule(undefined, { now }), null);
  assert.equal(validateOutreachSchedule('2026-10-12T12:00:00+09:00', { now }), '2026-10-12T03:00:00.000Z');
  for (const value of ['2026-11-31T00:00:00Z', '2026-10-11T00:00:00Z', '2027-02-01T00:00:00Z', false]) assert.throws(() => validateOutreachSchedule(value, { now }));
});

test('campaigns bound recipients and render only the supported literal placeholder', () => {
  const c = validateOutreachCampaign({ name: '예시 캠페인', subject: '{{channelName}} 안내', body: '{{channelName}}님, {{channelName}} 소개입니다.', contactIds: [id] });
  assert.equal(c.subject, '(광고) {{channelName}} 안내');
  assert.equal(renderOutreachTemplate(c, '예시 $& 채널').body, '예시 $& 채널님, 예시 $& 채널 소개입니다.');
  for (const changes of [{ contactIds: [id, id] }, { contactIds: [] }, { subject: '안내\r\nBcc:other@example.com' }, { body: '{{email}}' }, { body: '본문\u0000' }]) assert.throws(() => validateOutreachCampaign({ ...c, ...changes }));
});

test('rendered limits differ from authoring limits while controls stay forbidden', () => {
  const longName = '가'.repeat(200);
  const rendered = renderOutreachTemplate(OUTREACH_DEFAULTS, longName);
  assert.ok(rendered.subject.length > 180);
  assert.doesNotThrow(() => validateOutreachTemplate(rendered, { rendered: true }));
  assert.throws(() => validateOutreachTemplate(rendered));
  assert.throws(() => validateOutreachTemplate({ subject: '(광고) 안내', body: '본문\u000b새값' }, { rendered: true }));
  assert.match(outreachFooter('https://example.com/stop'), /수신거부 \/ Unsubscribe/);
  assert.match(outreachFooter('https://example.com/stop'), /To stop receiving promotional emails/);
});

test('CSV parses quoted commas and multiline evidence without coercing consent', () => {
  const csv = '\uFEFFchannelName,email,publicEmailSource,subscriberCount,country,consentStatus,consentEvidence,consentGrantedAt\r\n"예시, 제작",review@example.com,https://example.com/contact,120000,KR,granted,"담당자 명시 동의 회신\n자료 확인",2026-10-10T00:00:00Z';
  const contacts = parseOutreachCsv(csv, { now });
  assert.equal(contacts[0].channelName, '예시, 제작');
  assert.equal(contacts[0].consentStatus, 'granted');
  assert.match(contacts[0].consentEvidence, /\n/);
});

test('CSV is all-or-nothing with safe row errors, normalized duplicates and 200 row cap', () => {
  const header = 'channelName,email,publicEmailSource\n';
  const good = i => `예시${i},review${i}@example.com,https://example.com/contact`;
  assert.equal(parseOutreachCsv(header + Array.from({ length: 200 }, (_, i) => good(i)).join('\n'), { now }).length, 200);
  assert.throws(() => parseOutreachCsv(header + Array.from({ length: 201 }, (_, i) => good(i)).join('\n'), { now }));
  assert.throws(() => parseOutreachCsv(header + '첫행,a@example.com,https://example.com/contact\n둘째,A@example.com,https://example.com/contact', { now }), error => error.code === 'OUTREACH_CSV_INVALID' && error.extras.rowErrors[0].row === 3 && !JSON.stringify(error.extras).includes('example.com'));
  for (const csv of [header + '"닫히지않음', header + '"채널"잘못된값,a@example.com,https://example.com', 'channelName,email,__proto__\na,a@example.com,x', 'x'.repeat(512001)]) assert.throws(() => parseOutreachCsv(csv, { now }));
});

test('configuration fails closed with a fixed public HTTPS origin and strict limits', () => {
  assert.equal(readOutreachConfig({}).sendingEnabled, false);
  const config = readOutreachConfig({ APP_URL: 'https://example.com', OUTREACH_SMTP_PASSWORD: 'test-secret' });
  assert.equal(config.smtpPort, 587); assert.equal(config.dailyLimit, 25); assert.equal(config.intervalSeconds, 60);
  for (const values of [{ OUTREACH_DAILY_LIMIT: '0' }, { OUTREACH_DAILY_LIMIT: '101' }, { OUTREACH_SEND_INTERVAL_SECONDS: '59' }, { OUTREACH_SEND_INTERVAL_SECONDS: 'NaN' }]) assert.equal(readOutreachConfig(values).limitsConfigured, false);
  for (const APP_URL of ['http://example.com', 'https://user:pass@example.com', 'https://localhost', 'https://example.com/?token=x']) assert.equal(readOutreachConfig({ APP_URL }).publicUrlConfigured, false);
  assert.equal(readOutreachConfig({ OUTREACH_SMTP_PASSWORD: 'test', OUTREACH_SMTP_PORT: '25' }).smtpConfigured, false);
});

test('unsubscribe token has 256 random bits, bounded grammar and a separate stored hash', () => {
  const one = newUnsubscribeToken(), two = newUnsubscribeToken();
  assert.equal(one.length, 43); assert.notEqual(one, two);
  assert.equal(hashUnsubscribeToken(one).length, 64);
  assert.notEqual(hashUnsubscribeToken(one), one);
  for (const value of ['', 'a'.repeat(42), 'a'.repeat(44), '../secret', ['a'.repeat(43)]]) assert.throws(() => hashUnsubscribeToken(value));
});
