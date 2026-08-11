export const DEFAULT_SPEAKER_COLORS = [
  '#FFFFFF', // 0: 흰색
  '#39FF14', // 1: 형광 그린
  '#FFE600', // 2: 노란색
  '#00F5FF', // 3: 형광 시안
  '#FF6B35', // 4: 주황색
  '#FF4BCB', // 5: 마젠타
];

export const SUBTITLE_MAX_CHARS = 28;

// ASS 기준 해상도. Fontsize와 여백은 이 좌표계의 픽셀로 해석된다.
export const ASS_PLAY_RES_X = 1920;
export const ASS_PLAY_RES_Y = 1080;
export const ASS_DEFAULT_FONT_SIZE = 48;

// 방송·유튜브 자막의 통상 하한. 이보다 짧으면 읽기 전에 사라진다.
export const MIN_CUE_SECONDS = 0.8;

const SENTENCE_END = /[다요죠까]$/;
const SENTENCE_PUNCTUATION = /[!?]$/;
const CONJUNCTIVE = /[면고서며]$|지만$|는데$|니까$|므로$|거나$|든지$/;
const POSTPOSITION = /[은는이가을를에도로]$/;

// 문장 끝 마침표만 지운다. 숫자와 영문 사이의 마침표는 의미가 있으므로 남긴다.
// (예: "3.5초"가 "35초"로, "www.naver.com"이 "wwwnavercom"으로 뭉개지던 문제)
const DECORATIVE_PERIOD = /\.(?![0-9A-Za-z])|(?<![0-9A-Za-z])\./g;

function cleanText(text) {
  return text.trim().replace(DECORATIVE_PERIOD, '');
}

// ASS는 중괄호를 스타일 오버라이드로, 줄바꿈을 라인 구분자로 해석한다.
// 자막 본문에 그대로 들어가면 Dialogue 라인이 깨지므로 무해한 형태로 바꾼다.
function escapeASSText(text) {
  return String(text ?? '')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/\r\n?|\n/g, '\\N');
}

function findCutAt(text, maxLen) {
  for (let cutAt = maxLen; cutAt >= 1; cutAt--) {
    const character = text[cutAt - 1];
    const nextCharacter = text[cutAt];
    if (SENTENCE_PUNCTUATION.test(character)) return cutAt;
    if (SENTENCE_END.test(character) && (!nextCharacter || /\s/.test(nextCharacter))) return cutAt;
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
    let midTime = start + (end - start) * (frontText.length / total);

    // 글자 수 비례로만 나누면 "네!"처럼 짧은 앞부분이 수백 ms짜리 자막이 된다.
    // 남은 시간이 두 조각을 모두 채울 만큼 있을 때만 최소 표시 시간을 확보한다.
    if (end - start >= MIN_CUE_SECONDS * 2) {
      midTime = Math.min(Math.max(midTime, start + MIN_CUE_SECONDS), end - MIN_CUE_SECONDS);
    }

    split.push({ start, end: midTime, text: frontText, speaker: spk });
    start = midTime;
    text = backText;
  }

  split.push({ start, end, text: text || '', speaker: spk });
  return split;
}

// 자막 큐가 겹치면 편집 프로그램에서 트랙이 어긋난다. 특히 다화자 동시 발화에서
// 겹친 구간이 그대로 나온다. 시간순으로 정렬한 뒤 겹침을 잘라내고,
// 뒤에 빈 시간이 있으면 너무 짧은 큐를 최소 표시 시간까지 늘린다.
function normalizeCueTimeline(cues) {
  const sorted = [...cues]
    .map((cue) => ({ ...cue, end: Math.max(cue.end, cue.start) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  for (let index = 0; index < sorted.length; index += 1) {
    const cue = sorted[index];
    const next = sorted[index + 1];
    if (!next) break;

    if (cue.end > next.start) cue.end = next.start;
    if (cue.end - cue.start < MIN_CUE_SECONDS) {
      cue.end = Math.min(cue.start + MIN_CUE_SECONDS, next.start);
    }
  }

  return sorted;
}

function buildCues(segments) {
  return normalizeCueTimeline(segments.flatMap((segment) => splitSegment(segment)))
    .filter((cue) => cue.text.trim() !== '');
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
  const split = buildCues(segments);
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
    fontSize = ASS_DEFAULT_FONT_SIZE,
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
    `Style: ${name},${fontFamily},${fontSize},${hexToASS(color)},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,1,${alignment},60,60,50,1`;

  // PlayResX/Y가 없으면 libass·VSFilter가 384x288을 가정해서 1080p 영상에서 글자가
  // 약 3.75배로 확대된다. 기준 해상도를 명시해 Fontsize를 1080p 픽셀로 해석하게 한다.
  const scriptInfo = [
    '[Script Info]',
    'Title: 프리뷰 자막 머신',
    'ScriptType: v4.00+',
    'Collisions: Normal',
    `PlayResX: ${ASS_PLAY_RES_X}`,
    `PlayResY: ${ASS_PLAY_RES_Y}`,
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 0',
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

  const split = buildCues(segments);

  const events = [
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...split.map((seg) => {
      const styleName = speakerColors && seg.speaker !== undefined
        ? `Speaker${seg.speaker}`
        : 'Default';
      return `Dialogue: 0,${formatASS(seg.start)},${formatASS(seg.end)},${styleName},,0,0,0,,${escapeASSText(seg.text)}`;
    }),
  ].join('\n');

  return scriptInfo + styles + events;
}
