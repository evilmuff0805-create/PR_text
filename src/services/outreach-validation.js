import { createHash, randomBytes } from 'node:crypto';

export const OUTREACH_SENDER = Object.freeze({
  name: '코드밋', email: 'codemeet@naver.com', phone: '010-4901-1421',
  address: '경기도 김포시 김포한강9로12번길 50(구래동)',
});
export const OUTREACH_DEFAULTS = Object.freeze({
  subject: '(광고) {{channelName}} 편집팀께 — 자막에 쓰던 시간을 돌려드립니다',
  body: '{{channelName}} 편집팀 담당자님, 안녕하세요.\n자막 작업에 드는 시간을 줄여주는 프리뷰 자막 머신(PR-text)을 소개드립니다.\n\n음성·영상 파일을 올리면 자막을 자동으로 만들고, 내용을 다듬어 프리미어 프로에서 사용할 SRT 파일로 내려받을 수 있습니다.\n\n커피 한 잔 값으로, 자막에 쓰던 시간을 더 좋은 편집에 써보세요.\n100분 5,900원부터 이용하실 수 있습니다.\n\n30초 소개 영상과 사용법: https://pr-text.com/\n\n바쁜 작업 중에 읽어주셔서 감사합니다.\n코드밋 드림',
});
export const MAX_IMPORT_ROWS = 200;
export const MAX_CAMPAIGN_CONTACTS = 200;
export const MIN_SUBSCRIBERS = 100_000;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CATEGORIES = new Set(['web_entertainment', 'actor', 'general']);
const HEADER_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const BODY_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const CONTACT_FIELDS = new Set([
  'channelId', 'channelName', 'channelUrl', 'category', 'country', 'subscriberCount',
  'email', 'publicEmailSource', 'consentStatus', 'consentEvidence', 'consentGrantedAt',
  'koreaVerified', 'koreaEvidence', 'channelCheckedAt', 'metadataSource',
]);

export class OutreachError extends Error {
  constructor(message, status = 400, code = 'OUTREACH_INVALID_INPUT', extras = {}) {
    super(message);
    this.name = 'OutreachError';
    this.status = status;
    this.code = code;
    this.extras = extras;
  }
}

function invalid(field, message = '입력값을 확인해주세요.') {
  return new OutreachError(message, 400, 'OUTREACH_INVALID_INPUT', { field });
}

export function requireUuid(value, field = 'id') {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw invalid(field);
  return value.toLowerCase();
}

function plain(value, field, { required = false, max = 2000, multiline = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw invalid(field);
    return '';
  }
  if (typeof value !== 'string' || (multiline ? BODY_CONTROLS : HEADER_CONTROLS).test(value)) throw invalid(field);
  const result = value.replace(/\r\n?/g, '\n').trim();
  if (result.length > max || (required && !result)) throw invalid(field);
  return result;
}

export function normalizeOutreachEmail(value) {
  const email = plain(value, 'email', { required: true, max: 254 });
  const parts = email.split('@');
  if (parts.length !== 2 || parts[0].length > 64
    || !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(parts[0])
    || parts[0].startsWith('.') || parts[0].endsWith('.') || parts[0].includes('..')
    || !/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(parts[1])) {
    throw invalid('email', '받는 사람은 하나의 이메일 주소로 입력해주세요.');
  }
  return email.toLowerCase();
}

function isoTime(value, field, now, required = false, maxFutureMs = 300_000) {
  if ((value === undefined || value === null || value === '') && !required) return null;
  if (typeof value !== 'string') throw invalid(field);
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!parts) throw invalid(field);
  const [, year, month, day, hour, minute, second, , zone, zoneHour, zoneMinute] = parts;
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1
    || Number(day) > new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate()
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || (zone !== 'Z' && (Number(zoneHour) > 14 || Number(zoneMinute) > 59 || (Number(zoneHour) === 14 && Number(zoneMinute) !== 0)))) throw invalid(field);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || millis < Date.UTC(2000, 0, 1) || millis > now + maxFutureMs) throw invalid(field);
  return new Date(millis).toISOString();
}

export function validateOutreachSchedule(value, { now = Date.now() } = {}) {
  const schedule = isoTime(value, 'scheduledAt', now, false, 90 * 86_400_000);
  if (schedule && Date.parse(schedule) <= now) throw invalid('scheduledAt', '예약 시각은 현재보다 뒤여야 합니다.');
  return schedule;
}

function webUrl(value, field, required = false) {
  const text = plain(value, field, { required, max: 1500 });
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { throw invalid(field); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw invalid(field);
  return url.toString();
}

export function validateOutreachContact(input, { now = Date.now(), existing } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('contact');
  for (const key of Object.keys(input)) if (!CONTACT_FIELDS.has(key)) throw invalid(key);
  if (existing?.channelName === null && existing.metadataSource === 'youtube_api' && existing.metadataExpiredAt
    && ['unknown', 'revoked'].includes(input.consentStatus)
    && Object.keys(input).every(key => ['consentStatus', 'consentEvidence', 'consentGrantedAt'].includes(key))) {
    const preserved = Object.fromEntries([...CONTACT_FIELDS].map(key => [key, existing[key]]));
    return {
      ...preserved, consentStatus: input.consentStatus,
      consentEvidence: input.consentEvidence === undefined ? existing.consentEvidence : plain(input.consentEvidence, 'consentEvidence', { multiline: true }),
      consentGrantedAt: input.consentGrantedAt === undefined ? existing.consentGrantedAt : isoTime(input.consentGrantedAt, 'consentGrantedAt', now, false, 0),
    };
  }
  const value = { ...(existing || {}), ...input };
  const channelName = plain(value.channelName, 'channelName', { required: true, max: 200 });
  const channelId = plain(value.channelId, 'channelId', { max: 24 });
  if (channelId && !/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) throw invalid('channelId');
  const category = value.category ?? 'general';
  if (!CATEGORIES.has(category)) throw invalid('category');
  const country = plain(value.country, 'country', { max: 2 }).toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) throw invalid('country');
  const subscriberCount = value.subscriberCount ?? null;
  if (subscriberCount !== null && (!Number.isSafeInteger(subscriberCount) || subscriberCount < 0)) throw invalid('subscriberCount');
  const metadataSource = value.metadataSource ?? 'manual';
  if (!['manual', 'youtube_api'].includes(metadataSource)
    || (existing?.metadataSource === 'youtube_api' && metadataSource !== 'youtube_api')) throw invalid('metadataSource', 'API에서 가져온 채널 정보의 출처는 임의로 변경할 수 없습니다.');
  if (value.koreaVerified !== undefined && typeof value.koreaVerified !== 'boolean') throw invalid('koreaVerified');
  const koreaEvidence = plain(value.koreaEvidence, 'koreaEvidence');
  const koreaVerified = country === 'KR' || (!country && value.koreaVerified === true);
  if (!country && koreaVerified && !koreaEvidence) throw invalid('koreaEvidence', '한국 기반 채널 확인 근거를 입력해주세요.');
  const consentStatus = value.consentStatus ?? 'unknown';
  if (!['unknown', 'granted', 'revoked'].includes(consentStatus)) throw invalid('consentStatus');
  const publicEmailSource = webUrl(value.publicEmailSource, 'publicEmailSource', true);
  const consentEvidence = plain(value.consentEvidence, 'consentEvidence', { multiline: true });
  if (consentStatus === 'granted' && (consentEvidence.length < 10 || consentEvidence === publicEmailSource
    || /^https?:\/\/\S+$/i.test(consentEvidence))) {
    throw invalid('consentEvidence', '공개 주소 출처와 별도로 명시적인 홍보 메일 수신동의 근거를 입력해주세요.');
  }
  const email = normalizeOutreachEmail(value.email);
  if (existing && email !== existing.email) throw invalid('email', '이메일 변경은 새 연락처로 등록해주세요. 기존 동의·수신거부 기록은 유지됩니다.');
  return {
    channelId: channelId || null, channelName, channelUrl: webUrl(value.channelUrl, 'channelUrl'), category, country,
    subscriberCount, email, publicEmailSource,
    consentStatus, consentEvidence, consentGrantedAt: isoTime(value.consentGrantedAt, 'consentGrantedAt', now, consentStatus === 'granted', 0),
    koreaVerified, koreaEvidence, channelCheckedAt: isoTime(value.channelCheckedAt, 'channelCheckedAt', now, metadataSource === 'youtube_api'), metadataSource,
  };
}

export function validateOutreachTemplate({ subject, body } = {}, { rendered = false } = {}) {
  subject = plain(subject, 'subject', { required: true, max: rendered ? 400 : 180 });
  body = plain(body, 'body', { required: true, max: rendered ? 30_000 : 12_000, multiline: true });
  if (!rendered) for (const [field, value] of [['subject', subject], ['body', body]]) {
    if (/\{\{|\}\}/.test(value.replaceAll('{{channelName}}', ''))) throw invalid(field, '지원하는 템플릿은 {{channelName}}뿐입니다.');
  }
  if (!subject.startsWith('(광고)')) subject = `(광고) ${subject}`;
  if (subject.length > (rendered ? 400 : 180)) throw invalid('subject');
  return { subject, body };
}

export function validateOutreachCampaign(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('campaign');
  const name = plain(input.name, 'name', { required: true, max: 120 });
  const template = validateOutreachTemplate(input);
  if (!Array.isArray(input.contactIds) || input.contactIds.length < 1 || input.contactIds.length > MAX_CAMPAIGN_CONTACTS) throw invalid('contactIds');
  const contactIds = input.contactIds.map(id => requireUuid(id, 'contactIds'));
  if (new Set(contactIds).size !== contactIds.length) throw invalid('contactIds');
  return { name, ...template, contactIds };
}

export function renderOutreachTemplate(template, channelName) {
  const name = plain(channelName, 'channelName', { required: true, max: 200 });
  const rendered = {
    subject: template.subject.replaceAll('{{channelName}}', () => name),
    body: template.body.replaceAll('{{channelName}}', () => name),
  };
  if (rendered.subject.length > 400 || rendered.body.length > 30_000 || HEADER_CONTROLS.test(rendered.subject) || BODY_CONTROLS.test(rendered.body)) throw invalid('template');
  return rendered;
}

export function outreachFooter(unsubscribeUrl) {
  return `\n\n---\n발신: ${OUTREACH_SENDER.name} (${OUTREACH_SENDER.email})\n연락처: ${OUTREACH_SENDER.phone}\n주소: ${OUTREACH_SENDER.address}\n수신거부 / Unsubscribe: ${unsubscribeUrl}\n수신거부 링크에서 확인 버튼을 누르면 이후 홍보 메일을 보내지 않습니다.\nTo stop receiving promotional emails, open the link and confirm.`;
}

export function readOutreachConfig(env = process.env) {
  const boundedInt = (raw, fallback, minimum, maximum) => {
    if (raw === undefined || raw === '') return fallback;
    if (!/^\d+$/.test(raw)) return null;
    const number = Number(raw);
    return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : null;
  };
  const dailyLimit = boundedInt(env.OUTREACH_DAILY_LIMIT, 25, 1, 100);
  const intervalSeconds = boundedInt(env.OUTREACH_SEND_INTERVAL_SECONDS, 60, 60, 86_400);
  const port = boundedInt(env.OUTREACH_SMTP_PORT, 587, 465, 587);
  const smtpPort = [465, 587].includes(port) ? port : null;
  let publicUrl = null;
  try {
    const url = new URL(env.APP_URL);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) publicUrl = url.origin;
  } catch { /* A public HTTPS origin is required for mail links. */ }
  return {
    sendingEnabled: env.OUTREACH_SENDING_ENABLED === 'true',
    smtpConfigured: typeof env.OUTREACH_SMTP_PASSWORD === 'string' && Boolean(env.OUTREACH_SMTP_PASSWORD.trim()) && smtpPort !== null,
    discoveryConfigured: typeof env.YOUTUBE_API_KEY === 'string' && Boolean(env.YOUTUBE_API_KEY.trim()),
    publicUrlConfigured: publicUrl !== null, publicUrl, smtpPort, dailyLimit, intervalSeconds,
    limitsConfigured: dailyLimit !== null && intervalSeconds !== null,
  };
}

export function assertOutreachCanSend(config) {
  if (!config.sendingEnabled) throw new OutreachError('서버의 홍보 메일 발송 설정이 꺼져 있습니다.', 409, 'OUTREACH_SENDING_DISABLED');
  if (!config.smtpConfigured || !config.publicUrlConfigured || !config.limitsConfigured) {
    throw new OutreachError('SMTP·공개 HTTPS 주소·발송 한도 설정을 확인해주세요.', 503, 'OUTREACH_NOT_CONFIGURED');
  }
}

export function newUnsubscribeToken() { return randomBytes(32).toString('base64url'); }
export function hashUnsubscribeToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalid('token', '수신거부 링크가 올바르지 않습니다.');
  return createHash('sha256').update(token).digest('hex');
}

export function parseOutreachCsv(csv, { now = Date.now() } = {}) {
  if (typeof csv !== 'string' || Buffer.byteLength(csv, 'utf8') > 512_000) throw invalid('csv');
  csv = csv.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', quoted = false, closed = false;
  for (let index = 0; index <= csv.length; index++) {
    const char = csv[index];
    if (quoted) {
      if (char === '"' && csv[index + 1] === '"') { field += '"'; index++; }
      else if (char === '"') { quoted = false; closed = true; }
      else if (char === undefined) throw invalid('csv', 'CSV 따옴표가 닫히지 않았습니다.');
      else field += char;
    } else if (char === '"') {
      if (field || closed) throw invalid('csv');
      quoted = true;
    } else if (char === ',' || char === '\n' || char === '\r' || char === undefined) {
      row.push(field); field = ''; closed = false;
      if (char !== ',') {
        if (row.some(value => value.trim())) rows.push(row);
        row = [];
        if (char === '\r' && csv[index + 1] === '\n') index++;
        if (rows.length > MAX_IMPORT_ROWS + 1) throw invalid('csv', `한 번에 최대 ${MAX_IMPORT_ROWS}개 연락처만 등록할 수 있습니다.`);
      }
    } else {
      if (closed) throw invalid('csv');
      field += char;
    }
  }
  if (rows.length < 2) throw invalid('csv', 'CSV 헤더와 연락처를 입력해주세요.');
  const headers = rows.shift().map(value => value.trim());
  if (new Set(headers).size !== headers.length || headers.some(header => !CONTACT_FIELDS.has(header))
    || ['channelName', 'email', 'publicEmailSource'].some(header => !headers.includes(header))) throw invalid('csv', 'CSV 열 이름을 확인해주세요.');
  const errors = [], contacts = [], emails = new Set();
  rows.forEach((values, index) => {
    try {
      if (values.length !== headers.length) throw invalid('csv');
      const input = Object.fromEntries(headers.map((header, i) => [header, values[i].trim()]));
      if (input.subscriberCount === '') input.subscriberCount = null;
      else if (input.subscriberCount !== undefined) {
        if (!/^\d+$/.test(input.subscriberCount)) throw invalid('subscriberCount');
        input.subscriberCount = Number(input.subscriberCount);
      }
      if (input.koreaVerified !== undefined) {
        if (!['true', 'false', ''].includes(input.koreaVerified)) throw invalid('koreaVerified');
        input.koreaVerified = input.koreaVerified === 'true';
      }
      if (!input.category) input.category = 'general';
      if (!input.consentStatus) input.consentStatus = 'unknown';
      if (!input.metadataSource) input.metadataSource = 'manual';
      const contact = validateOutreachContact(input, { now });
      if (emails.has(contact.email)) throw invalid('email');
      emails.add(contact.email); contacts.push(contact);
    } catch (error) { errors.push({ row: index + 2, field: error.extras?.field || 'csv' }); }
  });
  if (errors.length) throw new OutreachError('CSV 입력값을 확인해주세요. 연락처는 등록되지 않았습니다.', 400, 'OUTREACH_CSV_INVALID', { rowErrors: errors });
  return contacts;
}
