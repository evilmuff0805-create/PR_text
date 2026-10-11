export const OUTREACH_CSV_COLUMNS = [
  'channelName', 'email', 'publicEmailSource', 'channelId', 'channelUrl', 'category',
  'country', 'subscriberCount', 'channelCheckedAt', 'koreaVerified', 'koreaEvidence',
  'consentStatus', 'consentEvidence', 'consentGrantedAt', 'metadataSource',
];

export const OUTREACH_CATEGORIES = [
  { value: 'web_entertainment', label: '웹예능' },
  { value: 'actor', label: '배우 개인 채널' },
  { value: 'general', label: '기타 한국 채널' },
];

export function isIsoTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value || '');
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day] = match.map(Number);
  return month >= 1 && month <= 12 && day >= 1
    && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function contactEligibility(contact, now = Date.now()) {
  if (contact.consentStatus !== 'granted') return '수신 동의 미확인 또는 철회';
  if (!contact.consentEvidence || !isIsoTimestamp(contact.consentGrantedAt)
    || Date.parse(contact.consentGrantedAt) > now) return '수신 동의 근거·일시 확인 필요';
  const country = (contact.country || '').toUpperCase();
  if (country && country !== 'KR') return '한국 외 국가로 등록됨';
  if (country !== 'KR' && (!contact.koreaVerified || !contact.koreaEvidence)) return '한국 채널 확인 필요';
  if (!Number.isSafeInteger(contact.subscriberCount) || contact.subscriberCount < 100000) return '구독자 10만 명 이상 확인 필요';
  const checkedAt = Date.parse(contact.channelCheckedAt);
  if (!isIsoTimestamp(contact.channelCheckedAt) || checkedAt > now || now - checkedAt > 30 * 86400000) return '채널 정보 30일 이내 확인 필요';
  return null;
}

export function previewOutreachCsv(csv, { maxRows = 200 } = {}) {
  if (typeof csv !== 'string' || csv.length > 512000 || new TextEncoder().encode(csv).byteLength > 512000) throw new Error('CSV는 512,000바이트 이하의 텍스트 파일로 선택해 주세요.');
  const input = csv.replace(/^\uFEFF/, '');
  const records = [];
  let fields = [], value = '', quoted = false, closed = false, line = 1, startLine = 1;
  const finishField = () => { fields.push(value.trim()); value = ''; closed = false; };
  const finishRow = () => {
    finishField();
    if (fields.some(Boolean)) records.push({ line: startLine, values: fields });
    fields = [];
    if (records.length > maxRows + 1) throw new Error(`CSV는 한 번에 ${maxRows}행까지 등록할 수 있습니다.`);
  };
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') { value += '"'; index += 1; }
        else { quoted = false; closed = true; }
      } else if (char === '\r' || char === '\n') {
        if (char === '\r' && input[index + 1] === '\n') index += 1;
        value += '\n'; line += 1;
      } else value += char;
    } else if (char === ',') finishField();
    else if (char === '\r' || char === '\n') {
      finishRow();
      if (char === '\r' && input[index + 1] === '\n') index += 1;
      line += 1; startLine = line;
    } else if (char === '"' && !value && !closed) quoted = true;
    else if (closed) throw new Error(`${line}행: 따옴표 뒤에는 쉼표나 줄바꿈이 필요합니다.`);
    else if (char === '"') throw new Error(`${line}행: 따옴표 형식을 확인해 주세요.`);
    else if (!closed) value += char;
  }
  if (quoted) throw new Error(`${startLine}행: 닫히지 않은 따옴표가 있습니다.`);
  finishRow();
  if (records.length < 2) throw new Error('CSV에 헤더와 한 개 이상의 연락처가 필요합니다.');
  const headers = records.shift().values;
  if (new Set(headers).size !== headers.length) throw new Error('CSV 헤더에 중복된 열이 있습니다.');
  const unsupported = headers.filter((header) => !OUTREACH_CSV_COLUMNS.includes(header));
  if (unsupported.length) throw new Error('CSV 헤더를 제공된 열 이름과 맞춰 주세요.');
  if (['channelName', 'email', 'publicEmailSource'].some((header) => !headers.includes(header))) {
    throw new Error('필수 CSV 열: channelName, email, publicEmailSource');
  }
  const seen = new Set();
  const rows = records.map(({ line: rowLine, values }) => {
    const contact = Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
    const errors = [];
    if (values.length !== headers.length) errors.push('열 개수 불일치');
    if (!contact.channelName) errors.push('채널명 누락');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) errors.push('이메일 형식 확인');
    if (!contact.publicEmailSource) errors.push('공개 이메일 출처 누락');
    const email = contact.email.toLowerCase();
    if (seen.has(email)) errors.push('CSV 안의 이메일 중복');
    seen.add(email);
    if (contact.category && !OUTREACH_CATEGORIES.some(({ value: category }) => category === contact.category)) errors.push('카테고리 확인');
    if (contact.metadataSource && !['manual', 'youtube_api'].includes(contact.metadataSource)) errors.push('채널 정보 출처 확인');
    if (contact.country && !/^[A-Za-z]{2}$/.test(contact.country)) errors.push('국가 코드 확인');
    if (contact.subscriberCount && (!/^\d+$/.test(contact.subscriberCount) || !Number.isSafeInteger(Number(contact.subscriberCount)))) errors.push('구독자 수 확인');
    if (contact.koreaVerified && !['true', 'false'].includes(contact.koreaVerified)) errors.push('koreaVerified는 true 또는 false');
    if (contact.koreaVerified === 'true' && !contact.country && !contact.koreaEvidence) errors.push('한국 채널 확인 근거 누락');
    if (contact.channelCheckedAt && !isIsoTimestamp(contact.channelCheckedAt)) errors.push('채널 확인일 ISO 형식 확인');
    if (contact.consentStatus && !['unknown', 'granted', 'revoked'].includes(contact.consentStatus)) errors.push('수신 동의 상태 확인');
    if (contact.consentStatus === 'granted' && (!contact.consentEvidence || !isIsoTimestamp(contact.consentGrantedAt) || Date.parse(contact.consentGrantedAt) > Date.now())) errors.push('명시적 수신 동의 근거·일시 확인');
    return { line: rowLine, contact, errors };
  });
  return { headers, rows, errorCount: rows.filter(({ errors }) => errors.length).length };
}
