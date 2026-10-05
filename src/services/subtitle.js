export const DEFAULT_SPEAKER_COLORS = [
  '#FFFFFF', // 0: 흰색
  '#39FF14', // 1: 형광 그린
  '#FFE600', // 2: 노란색
  '#00F5FF', // 3: 형광 시안
  '#FF6B35', // 4: 주황색
  '#FF4BCB', // 5: 마젠타
];

export const SUBTITLE_MAX_CHARS = 28;
export const SRT_START_MARKER_TEXT = '0~2초 자막 시작 구간입니다!';

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

// 다화자 자막은 어절 단위로 절의 끝을 먼저 찾는다. 마지막 한 글자만 보면
// 인용형 "-라고"를 "-고"로, "어디서"를 "-서"로 잘못 판단한다.
// 형태소 분석 대신 확실한 복합 어미를 우선하며, 종속된 구문은 뒤 말과 붙인다.
const KOREAN_CLAUSE_END = /(?:지만|는데|던데|더니|으니까|니까|므로|거나|든지|다면|으면|으며|면서|아서|어서|여서|해서|아도|어도|해도)$/;
const KOREAN_SENTENCE_END = /(?:습니다|습니까|어요|아요|해요|예요|이에요|세요|네요|데요|군요|지요|잖아요|거든요|더라고요|더라|죠|까요|이다|했다|한다|된다|있다|없다|겠다|였다|란다)$/;
const KOREAN_QUOTED_END = /(?:라고|다고|냐고|자고)$/;
const KOREAN_DEPENDENT_WORD = /^(?:누구|누가|누굴|누구를|누구에게|언제|어디|어디서|어디로|어떻게|왜|무엇|무엇을|뭐|뭘|무슨|어떤|어느|몇|얼마나)$/;
const KOREAN_LINKING_WORD = /^(?:그리고|그러고|그래서|그러면|그러므로|그러니까|하지만|그런데|그렇지만|또는|혹은|그래도|그럼|대해서|위해서|비해서|따라서)$/;
const KOREAN_ADNOMINAL_END = /(?:하는|되는|있는|없는|했던|됐던|있던|없던|로운|다운|적인|한|된)$/;

// 문장 끝 마침표만 지운다. 숫자와 영문 사이의 마침표는 의미가 있으므로 남긴다.
// (예: "3.5초"가 "35초"로, "www.naver.com"이 "wwwnavercom"으로 뭉개지던 문제)
const DECORATIVE_PERIOD = /\.(?![0-9A-Za-z])|(?<![0-9A-Za-z])\./g;

function cleanText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(DECORATIVE_PERIOD, '');
}

// ASS는 중괄호를 스타일 오버라이드로 해석한다. 줄바꿈은 두 줄 자막을
// 만들 수 있으므로 cleanText 이후에도 방어적으로 한 칸으로 바꾼다.
function escapeASSText(text) {
  return String(text ?? '')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/\r\n?|\n/g, ' ');
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

function findKoreanSpeakerCutAt(text, maxLen) {
  const boundaries = [];
  for (let cutAt = 1; cutAt <= maxLen; cutAt += 1) {
    if (text[cutAt] !== ' ') continue;
    const word = text.slice(0, cutAt).match(/\S+$/)?.[0] ?? '';
    boundaries.push({ cutAt, word });
  }

  const latest = (predicate) => boundaries.findLast(({ word }) => predicate(word))?.cutAt;
  const dependent = (word) => KOREAN_QUOTED_END.test(word)
    || KOREAN_DEPENDENT_WORD.test(word) || KOREAN_LINKING_WORD.test(word)
    || KOREAN_ADNOMINAL_END.test(word);

  return latest((word) => SENTENCE_PUNCTUATION.test(word))
    ?? latest((word) => !dependent(word) && KOREAN_SENTENCE_END.test(word))
    ?? latest((word) => !dependent(word)
      && (KOREAN_CLAUSE_END.test(word) || CONJUNCTIVE.test(word)))
    ?? latest((word) => !dependent(word) && POSTPOSITION.test(word))
    ?? latest((word) => !dependent(word))
    // 28자 안에 완결 가능한 구문이 없으면 어절은 보존하되 길이 제한을 지킨다.
    ?? boundaries.at(-1)?.cutAt
    ?? maxLen;
}

function splitSegment(segment, maxLen = SUBTITLE_MAX_CHARS) {
  let text = cleanText(segment.text);
  const spk = segment.speaker;
  let start = segment.start;
  const end = segment.end;
  const split = [];
  const splitKoreanSpeakerText = spk !== undefined && spk !== null && spk !== ''
    && /[가-힣]/.test(text);

  while (text.length > maxLen) {
    const cutAt = splitKoreanSpeakerText
      ? findKoreanSpeakerCutAt(text, maxLen)
      : findCutAt(text, maxLen);
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
// 겹친 구간이 그대로 나온다. 시간순으로 정렬한 뒤 겹침만 잘라낸다.
// 실제 발화 뒤의 빈 시간까지 자막 표시를 연장하지 않는다.
function normalizeCueTimeline(cues) {
  const sorted = [...cues]
    .map((cue) => ({ ...cue, end: Math.max(cue.end, cue.start) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  for (let index = 0; index < sorted.length; index += 1) {
    const cue = sorted[index];
    const next = sorted[index + 1];
    if (!next) break;

    if (cue.end > next.start) cue.end = next.start;
  }

  return sorted.filter((cue) => cue.end > cue.start);
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
  // Keep the marker outside dialogue normalization: trimming overlaps would erase
  // either the two-second marker or speech at the start of the original audio.
  const marker = `1\n${formatSRT(0)} --> ${formatSRT(2)}\n<font size="48"><b>${SRT_START_MARKER_TEXT}</b></font>`;
  const split = buildCues(segments ?? []);
  const dialogue = split.map((seg, i) => {
    let line = seg.text;
    if (speakerColors && seg.speaker !== undefined) {
      const color = speakerColors[String(seg.speaker)] ?? '#FFFFFF';
      line = `<font color="${color}">${line}</font>`;
    }
    return `${i + 2}\n${formatSRT(seg.start)} --> ${formatSRT(seg.end)}\n${line}`;
  });
  return [marker, ...dialogue].join('\n\n');
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
    // 자동 줄바꿈을 금지한다. 모든 Dialogue 텍스트는 앞 단계에서 28자 이하로 분할된다.
    'WrapStyle: 2',
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
