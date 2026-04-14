const SENTENCE_END = /[다요죠까!?]$/;
const CONJUNCTIVE = /[면고서며]$|지만$|는데$|니까$|므로$|거나$|든지$/;
const POSTPOSITION = /[은는이가을를에도로]$/;

function cleanText(text) {
  return text.trim().replace(/\./g, '');
}

function findCutAt(text, maxLen) {
  for (let i = maxLen; i >= 1; i--) {
    if (SENTENCE_END.test(text[i])) return i + 1;
  }
  for (let i = maxLen; i >= 1; i--) {
    if (text[i] === ' ' && CONJUNCTIVE.test(text.slice(0, i).trimEnd())) return i;
  }
  for (let i = maxLen; i >= 1; i--) {
    if (text[i] === ' ' && POSTPOSITION.test(text.slice(0, i).trimEnd())) return i;
  }
  for (let i = maxLen; i >= 1; i--) {
    if (text[i] === ' ') return i;
  }
  return maxLen;
}

function splitSegment(segment, maxLen = 35, depth = 0) {
  const text = depth === 0 ? cleanText(segment.text) : segment.text;
  if (!text || text.length <= maxLen || depth > 10) {
    return [{ start: segment.start, end: segment.end, text: text || '' }];
  }
  const cutAt = findCutAt(text, maxLen);
  if (cutAt <= 0 || cutAt >= text.length) {
    return [{ start: segment.start, end: segment.end, text }];
  }
  const frontText = text.slice(0, cutAt).trimEnd();
  const backText = text.slice(cutAt).trimStart();
  if (!frontText || !backText) {
    return [{ start: segment.start, end: segment.end, text }];
  }
  const total = frontText.length + backText.length;
  const duration = segment.end - segment.start;
  const midTime = segment.start + duration * (frontText.length / total);
  const front = { start: segment.start, end: midTime, text: frontText };
  const back = { start: midTime, end: segment.end, text: backText };
  return [
    ...splitSegment(front, maxLen, depth + 1),
    ...splitSegment(back, maxLen, depth + 1),
  ];
}

function formatSRT(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + ',' + String(ms).padStart(3, '0');
}

function formatASS(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.round((seconds % 1) * 100);
  return String(h) + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
}

export function generateSRT(segments) {
  if (!segments || segments.length === 0) return '';
  const split = segments.flatMap((seg) => splitSegment(seg));
  return split.map((seg, i) =>
    `${i + 1}\n${formatSRT(seg.start)} --> ${formatSRT(seg.end)}\n${seg.text}`
  ).join('\n\n');
}

export function generateTXT(segments) {
  if (!segments || segments.length === 0) return '';
  return segments.map((seg) => cleanText(seg.text)).join(' ');
}

/**
 * ASS 자막 생성 (스타일 옵션 지원)
 * @param {Array} segments
 * @param {Object} options
 * @param {string} options.position - 'top' | 'middle' | 'bottom' (기본: 'bottom')
 * @param {string} options.fontFamily - 폰트명 (기본: 'Pretendard')
 * @param {string} options.fontColor - HEX 색상 '#RRGGBB' (기본: '#FFFFFF')
 * @param {number} options.fontSize - 폰트 크기 (기본: 20)
 */
export function generateASS(segments, options = {}) {
  if (!segments || segments.length === 0) return '';

  const {
    position = 'bottom',
    fontFamily = 'Pretendard',
    fontColor = '#FFFFFF',
    fontSize = 20,
  } = options;

  // ASS Alignment: 하단(2), 중간(5), 상단(8)
  const alignmentMap = { top: 8, middle: 5, bottom: 2 };
  const alignment = alignmentMap[position] || 2;

  // HEX '#RRGGBB' → ASS '&H00BBGGRR' 변환
  function hexToASS(hex) {
    const clean = hex.replace('#', '');
    const r = clean.substring(0, 2);
    const g = clean.substring(2, 4);
    const b = clean.substring(4, 6);
    return `&H00${b.toUpperCase()}${g.toUpperCase()}${r.toUpperCase()}`;
  }

  const primaryColour = hexToASS(fontColor);

  const scriptInfo = [
    '[Script Info]',
    'Title: 프리뷰 자막 머신',
    'ScriptType: v4.00+',
    'Collisions: Normal',
    'PlayDepth: 0',
    '',
  ].join('\n');

  const styles = [
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${fontFamily},${fontSize},${primaryColour},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,${alignment},10,10,10,1`,
    '',
  ].join('\n');

  const split = segments.flatMap((seg) => splitSegment(seg));

  const events = [
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...split.map((seg) =>
      `Dialogue: 0,${formatASS(seg.start)},${formatASS(seg.end)},Default,,0,0,0,,${seg.text}`
    ),
  ].join('\n');

  return scriptInfo + styles + events;
}
