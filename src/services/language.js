// Whisper는 같은 언어를 'ko'로도 'korean'으로도 돌려준다. 그대로 저장하면
// 한 언어가 여러 값으로 쌓이고, 교정 분기가 이 값을 보므로 실제 동작에도 영향이 있다.
const LANGUAGE_ALIASES = new Map([
  ['ko', 'ko'], ['kor', 'ko'], ['korean', 'ko'], ['한국어', 'ko'],
  ['en', 'en'], ['eng', 'en'], ['english', 'en'],
  ['ja', 'ja'], ['jpn', 'ja'], ['japanese', 'ja'],
  ['zh', 'zh'], ['chi', 'zh'], ['zho', 'zh'], ['chinese', 'zh'],
]);

export const UNKNOWN_LANGUAGE = 'unknown';

/**
 * 저장·비교에 쓰는 표준 언어 코드로 바꾼다.
 * 아는 언어가 아니면 원문을 소문자로 남긴다. 새 언어가 들어와도 정보를 잃지 않는다.
 */
export function normalizeLanguage(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return UNKNOWN_LANGUAGE;
  return LANGUAGE_ALIASES.get(raw) || raw;
}

export function isKoreanLanguage(value) {
  return normalizeLanguage(value) === 'ko';
}
