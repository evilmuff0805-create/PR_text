export const CAPTION_IDEA_MODES = [
  { id: 'entertainment', label: '예능' },
  { id: 'situation', label: '상황' },
  { id: 'emphasis', label: '강조' },
  { id: 'emotion', label: '감성' },
];

// 서버가 받는 장면 입력 상한과 같다.
export const SCENE_TEXT_MAX_CHARS = 500;

// 앞뒤 대사를 몇 줄까지 문맥으로 붙일지. 너무 넓으면 초점이 흐려진다.
const CONTEXT_LINES = 2;

export function createRequestId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (value) => {
    const random = Math.floor(Math.random() * 16);
    const nibble = value === 'x' ? random : (random & 0x3) | 0x8;
    return nibble.toString(16);
  });
}

/**
 * 선택한 구간을 중심으로 장면 설명을 만든다.
 * 앞뒤 대사를 문맥으로 붙이되, 어느 줄이 초점인지 표시해서 모델이 헷갈리지 않게 한다.
 * 500자를 넘으면 초점 줄을 지키면서 바깥쪽 문맥부터 덜어낸다.
 */
export function buildSceneText(segments, focusIndex, contextLines = CONTEXT_LINES) {
  if (!Array.isArray(segments) || segments.length === 0) return '';
  if (!Number.isInteger(focusIndex) || focusIndex < 0 || focusIndex >= segments.length) return '';

  const focusText = String(segments[focusIndex]?.text ?? '').trim();
  if (!focusText) return '';

  let before = contextLines;
  let after = contextLines;

  const compose = () => {
    const lines = [];
    for (let index = Math.max(0, focusIndex - before); index <= Math.min(segments.length - 1, focusIndex + after); index += 1) {
      const text = String(segments[index]?.text ?? '').trim();
      if (!text) continue;
      lines.push(index === focusIndex ? `> ${text}` : text);
    }
    return lines.join('\n');
  };

  let scene = compose();
  // 초점 줄만 남을 때까지 바깥쪽 문맥을 한 줄씩 줄인다.
  while (Array.from(scene).length > SCENE_TEXT_MAX_CHARS && (before > 0 || after > 0)) {
    if (after >= before) after -= 1;
    else before -= 1;
    scene = compose();
  }

  return Array.from(scene).slice(0, SCENE_TEXT_MAX_CHARS).join('');
}
