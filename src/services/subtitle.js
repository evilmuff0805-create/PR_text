export const DEFAULT_SPEAKER_COLORS = [
  '#FFFFFF', // 0: 흰색
  '#39FF14', // 1: 형광 그린
  '#FFE600', // 2: 노란색
  '#00F5FF', // 3: 형광 시안
  '#FF6B35', // 4: 주황색
  '#FF4BCB', // 5: 마젠타
];

export const SUBTITLE_MAX_CHARS = 28;

const SENTENCE_END = /[다요죠까!?]$/;
const CONJUNCTIVE = /[면고서며]$|지만$|는데$|니까$|므로$|거나$|든지$/;
const POSTPOSITION = /[은는이가을를에도로]$/;

function cleanText(text) {
  return text.trim().replace(/\./g, '');
}

function findCutAt(text, maxLen) {
  for (let cutAt = maxLen; cutAt >= 1; cutAt--) {
    if (SENTENCE_END.test(text[cutAt - 1])) return cutAt;
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

function splitSegment(segment, maxLen = SUBTITLE_MAX_CHARS) {
  let text = cleanText(segment.text);
  const spk = segment.speaker;
  let start = segment.start;
  const end = segment.end;
  const split = [];

  while (text.length > maxLen) {
    const cutAt = findCutAt(text, maxLen);
    const frontText = text.slice(0, cutAt).trimEnd();
    const backText = text.slice(cutAt).trimStart();
    if (!frontText || !backText) break;

    const total = frontText.length + backText.length;
    const midTime = start + (end - start) * (frontText.length / total);
    split.push({ start, end: midTime, text: frontText, speaker: spk });
    start = midTime;
    text = backText;
  }

  split.push({ start, end, text: text || '', speaker: spk });
  return split;
}

function formatSRT(seconds) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + ',' + String(ms).padStart(3, '0');
}

function formatASS(seconds) {
  const totalCs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(totalCs / 360_000);
  const m = Math.floor((totalCs % 360_000) / 6000);
  const s = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;
  return String(h) + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
}

export function generateSRT(segments, speakerColors = null) {
  if (!segments || segments.length === 0) return '';
  const split = segments.flatMap((seg) => splitSegment(seg));
  return split.map((seg, i) => {
    let line = seg.text;
    if (speakerColors && seg.speaker !== undefined) {
      const color = speakerColors[String(seg.speaker)] ?? '#FFFFFF';
      line = `<font color="${color}">${line}</font>`;
    }
    return `${i + 1}\n${formatSRT(seg.start)} --> ${formatSRT(seg.end)}\n${line}`;
  }).join('\n\n');
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
export function generateASS(segments, options = {}, speakerColors = null) {
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
  const styleFormat = 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding';
  const makeStyleLine = (name, color) =>
    `Style: ${name},${fontFamily},${fontSize},${hexToASS(color)},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,${alignment},10,10,10,1`;

  const scriptInfo = [
    '[Script Info]',
    'Title: 프리뷰 자막 머신',
    'ScriptType: v4.00+',
    'Collisions: Normal',
    'PlayDepth: 0',
    '',
  ].join('\n');

  const speakerStyleLines = speakerColors
    ? Object.entries(speakerColors).map(([idx, hex]) => makeStyleLine(`Speaker${idx}`, hex))
    : [];

  const styles = [
    '[V4+ Styles]',
    styleFormat,
    makeStyleLine('Default', fontColor),
    ...speakerStyleLines,
    '',
  ].join('\n');

  const split = segments.flatMap((seg) => splitSegment(seg));

  const events = [
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...split.map((seg) => {
      const styleName = speakerColors && seg.speaker !== undefined
        ? `Speaker${seg.speaker}`
        : 'Default';
      return `Dialogue: 0,${formatASS(seg.start)},${formatASS(seg.end)},${styleName},,0,0,0,,${seg.text}`;
    }),
  ].join('\n');

  return scriptInfo + styles + events;
}
