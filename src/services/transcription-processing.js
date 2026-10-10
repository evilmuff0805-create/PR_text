import { performance } from 'perf_hooks';
import { processSegmentsWithTiming } from './postprocess.js';
import { normalizeLanguage } from './language.js';
import { alignKoreanSegmentWithWordTimings } from './korean-word-timing.js';
import { isKoreanDependentPredicateTail } from './korean-subtitle.js';

// Provider hallucination loops are uniform, low-confidence repeats from one decode window.
// These thresholds intentionally leave ordinary or weakly evidenced repetition untouched.
const WHISPER_REPEAT_MIN_COUNT = 4;
const WHISPER_REPEAT_MIN_DURATION_SECONDS = 4;
const WHISPER_REPEAT_MAX_DURATION_SPREAD_SECONDS = 0.2;
const WHISPER_REPEAT_MAX_TIMESTAMP_GAP_SECONDS = 0.08;
const WHISPER_REPEAT_MAX_AVG_LOGPROB = -0.5;
const WHISPER_REPEAT_MIN_COMPRESSION_RATIO = 1.5;

function normalizeRepeatedText(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function countLettersAndNumbers(text) {
  return Array.from(text.replace(/[^\p{L}\p{N}]/gu, '')).length;
}

function hasSpeakerLabel(segment) {
  return segment.speaker !== undefined && segment.speaker !== null && segment.speaker !== '';
}

function numericValue(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampsAreContiguous(segments) {
  return segments.every((segment, index) => {
    const start = numericValue(segment.start);
    const end = numericValue(segment.end);
    if (start === null || end === null || end <= start) return false;
    if (index === 0) return true;

    const previousEnd = numericValue(segments[index - 1].end);
    return previousEnd !== null
      && Math.abs(start - previousEnd) <= WHISPER_REPEAT_MAX_TIMESTAMP_GAP_SECONDS;
  });
}

function isWhisperRepetitionLoop(segments, normalizedText) {
  if (segments.length < WHISPER_REPEAT_MIN_COUNT) return false;
  if (countLettersAndNumbers(normalizedText) < 4) return false;
  if (segments.some(hasSpeakerLabel) || !timestampsAreContiguous(segments)) return false;

  const seeks = segments.map((segment) => numericValue(segment.seek));
  if (seeks.some((seek) => seek === null) || new Set(seeks).size !== 1) return false;

  const durations = segments.map((segment) => Number(segment.end) - Number(segment.start));
  const durationSpread = Math.max(...durations) - Math.min(...durations);
  const runDuration = Number(segments.at(-1).end) - Number(segments[0].start);
  if (durationSpread > WHISPER_REPEAT_MAX_DURATION_SPREAD_SECONDS
    || runDuration < WHISPER_REPEAT_MIN_DURATION_SECONDS) {
    return false;
  }

  return segments.every((segment) => {
    const avgLogprob = numericValue(segment.avg_logprob);
    const compressionRatio = numericValue(segment.compression_ratio);
    return avgLogprob !== null
      && avgLogprob <= WHISPER_REPEAT_MAX_AVG_LOGPROB
      && compressionRatio !== null
      && compressionRatio >= WHISPER_REPEAT_MIN_COMPRESSION_RATIO;
  });
}

function isNextWindowEcho(before, loop, after) {
  if (!before || !after || hasSpeakerLabel(before) || hasSpeakerLabel(after)) return false;
  if (normalizeRepeatedText(before.text) !== normalizeRepeatedText(after.text)) return false;

  const previousSeek = numericValue(before.seek);
  const loopSeek = numericValue(loop[0].seek);
  const echoSeek = numericValue(after.seek);
  const loopEnd = numericValue(loop.at(-1).end);
  const echoStart = numericValue(after.start);
  const echoLogprob = numericValue(after.avg_logprob);

  return previousSeek !== null
    && previousSeek === loopSeek
    && echoSeek !== null
    && echoSeek !== loopSeek
    && loopEnd !== null
    && echoStart !== null
    && Math.abs(echoStart - loopEnd) <= WHISPER_REPEAT_MAX_TIMESTAMP_GAP_SECONDS
    && echoLogprob !== null
    && echoLogprob <= WHISPER_REPEAT_MAX_AVG_LOGPROB;
}

export function filterWhisperRepetitionLoops(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return [];

  const filtered = [];
  let index = 0;

  while (index < segments.length) {
    const normalizedText = normalizeRepeatedText(segments[index].text);
    let runEnd = index + 1;
    while (runEnd < segments.length
      && normalizeRepeatedText(segments[runEnd].text) === normalizedText) {
      runEnd += 1;
    }

    const run = segments.slice(index, runEnd);
    if (normalizedText && isWhisperRepetitionLoop(run, normalizedText)) {
      const before = filtered.at(-1);
      if (isNextWindowEcho(before, run, segments[runEnd])) runEnd += 1;
      index = runEnd;
      continue;
    }

    filtered.push(...run);
    index = runEnd;
  }

  return filtered;
}

export function filterSilentSegments(segments) {
  return segments.filter((segment) => {
    const text = (segment.text || '').trim();
    if (!text) return false;

    const silencePattern = /^(\.\.\.|…|\.+|\s+|\(.*무음.*\)|\[.*무음.*\]|\(.*음악.*\)|\[.*음악.*\]|\(.*박수.*\)|\[.*박수.*\])$/i;
    if (silencePattern.test(text)) return false;

    return !/^[\s.,!?;:'"()\[\]{}…\-_]+$/.test(text);
  });
}

export function removeCommas(text) {
  return text.replace(/,/g, '').replace(/，/g, '');
}

// "네." "응." 같은 한두 글자 세그먼트가 독립 자막이 되면 화면에서 깜빡인다.
// 뒤 세그먼트와 합쳐 하나의 자막으로 만든다. 타임코드는 앞의 시작과 뒤의 끝을 쓴다.
export const MIN_SEGMENT_CHARS = 5;
const MAX_MERGE_GAP_SECONDS = 0.3;

function canMergeAdjacentSegments(left, right, preserveWordTimings) {
  if (left.speaker !== right.speaker) return false;
  // Keep timed ordinary responses separate. Merging here would discard words
  // and make a brief response cover the silence before the following source.
  if (preserveWordTimings && !hasSpeakerLabel(left) && [left, right].some((segment) => (
    Array.isArray(segment.sourceWords) && segment.sourceWords.length > 0
  ))) return false;

  const leftStart = numericValue(left.start);
  const leftEnd = numericValue(left.end);
  const rightStart = numericValue(right.start);
  const rightEnd = numericValue(right.end);
  const gap = rightStart === null || leftEnd === null ? null : rightStart - leftEnd;
  // 다화자 자막은 발화가 끝나면 사라져야 한다. 화자가 같더라도 공급자가
  // 표시한 무음은 합치지 않고, 부동소수점 오차 범위의 연속 발화만 합친다.
  const maxGap = hasSpeakerLabel(left) ? 0 : MAX_MERGE_GAP_SECONDS;
  return leftStart !== null && leftEnd !== null && leftEnd >= leftStart
    && rightStart !== null && rightEnd !== null && rightEnd >= rightStart
    && gap !== null && gap >= 0 && gap <= maxGap + 1e-9;
}

export function mergeShortSegments(segments, minChars = MIN_SEGMENT_CHARS, { preserveWordTimings = false } = {}) {
  if (!Array.isArray(segments) || segments.length === 0) return [];

  const merged = [];
  let pending = null;

  for (const segment of segments) {
    const text = (segment.text || '').trim();

    if (pending) {
      // 다화자는 무음 없이 이어지는 같은 화자의 발화만 합친다.
      // 일반 전사의 기존 짧은 간격 병합은 유지한다.
      if (canMergeAdjacentSegments(pending, segment, preserveWordTimings)) {
        merged.push({
          ...segment,
          start: pending.start,
          end: segment.end,
          text: `${pending.text} ${text}`.trim(),
        });
        pending = null;
        continue;
      }
      merged.push(pending);
      pending = null;
    }

    // 마지막 세그먼트는 뒤에 붙일 곳이 없으므로 그대로 둔다.
    if (Array.from(text).length < minChars && segment !== segments[segments.length - 1]) {
      pending = { ...segment, text };
      continue;
    }

    merged.push({ ...segment, text });
  }

  if (pending) merged.push(pending);
  return merged;
}

function normalizedEnglishToken(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function refineEnglishSegment(segment) {
  const tokens = String(segment.text ?? '').trim().match(/\S+/g) ?? [];
  const words = segment.sourceWords;
  if (tokens.length === 0 || tokens.some((token) => token.length > 28)
    || !Array.isArray(words) || words.length !== tokens.length) return [segment];

  const sourceStart = numericValue(segment.start);
  const sourceEnd = numericValue(segment.end);
  let previousEnd = -Infinity;
  const valid = sourceStart !== null && sourceEnd !== null && sourceEnd > sourceStart
    && words.every((word, index) => {
      if (!word || typeof word !== 'object') return false;
      const start = numericValue(word.start);
      const end = numericValue(word.end);
      const tokenMatches = normalizedEnglishToken(tokens[index])
        && normalizedEnglishToken(tokens[index]) === normalizedEnglishToken(word.word);
      const ordered = start !== null && end !== null && end > start
        && start >= sourceStart - 1e-9 && end <= sourceEnd + 1e-9
        && start >= previousEnd - 1e-9 && end >= previousEnd - 1e-9;
      previousEnd = end ?? previousEnd;
      return tokenMatches && ordered;
    });
  if (!valid) return [segment];

  const timedTokens = words.map((word, index) => ({
    text: tokens[index], start: Number(word.start), end: Number(word.end),
  }));
  const refined = [];
  let cue = null;
  for (const token of timedTokens) {
    const pauseBefore = cue && token.start - cue.end > MAX_MERGE_GAP_SECONDS + 1e-9;
    const nextText = cue ? `${cue.text} ${token.text}` : token.text;
    if (cue && (pauseBefore || nextText.length > 28)) {
      refined.push(cue);
      cue = null;
    }
    if (cue) {
      cue.text = `${cue.text} ${token.text}`;
      cue.end = token.end;
    } else {
      cue = { start: token.start, end: token.end, text: token.text };
      if (segment.speaker !== undefined) cue.speaker = segment.speaker;
    }
  }
  if (cue) refined.push(cue);
  return refined;
}

export function refineEnglishSegmentsWithWordTimings(segments) {
  return segments.flatMap(refineEnglishSegment);
}

export function refineKoreanSegmentsWithWordTimings(segments) {
  // Download/edit payloads accept at most 5,000 source rows. Keep exact cue
  // times in a compact source row when word/pause splitting exceeds that cap.
  const maxFlatCues = 5_000;
  const refined = [];
  const compact = [];
  let compactTextLength = segments.reduce((total, segment) => total + String(segment.text ?? '').length, 0);
  let needsCompact = false;
  const appendFlat = (cues, wordTimed = false) => {
    if (needsCompact) return;
    if (refined.length + cues.length > maxFlatCues) {
      needsCompact = true;
      refined.length = 0;
      return;
    }
    refined.push(...(wordTimed ? cues.map((cue) => ({ ...cue, timingSource: 'word' })) : cues));
  };
  for (let index = 0; index < segments.length; index += 1) {
    const source = segments[index];
    if (hasSpeakerLabel(source)) {
      appendFlat([source]);
      compact.push(source);
      continue;
    }

    const aligned = alignKoreanSegmentWithWordTimings(source);
    let cues = aligned.segments;
    let sourceText = source.text;
    const next = segments[index + 1];
    // Repair a provider-separated dependent predicate only when BOTH sources
    // have complete, matching word timings and speech itself is adjacent.
    // Each source participates in at most one such join; no timing is invented.
    if (aligned.aligned && next && !hasSpeakerLabel(next)
      && isKoreanDependentPredicateTail(source.text, next.text)) {
      const following = alignKoreanSegmentWithWordTimings(next);
      const gap = following.aligned
        ? following.segments[0].start - cues.at(-1).end : Infinity;
      const joinedText = `${String(source.text).trim()} ${String(next.text).trim()}`;
      const addedChars = joinedText.length - String(source.text).length - String(next.text).length;
      // A compact row must also fit the existing 10,000-character edit limit.
      if (gap >= 0 && gap <= MAX_MERGE_GAP_SECONDS + 1e-9 && joinedText.length <= 10_000
        && compactTextLength + addedChars <= 1_000_000) {
        const joined = alignKoreanSegmentWithWordTimings({
          ...source,
          end: Math.max(Number(source.end), Number(next.end)),
          text: joinedText,
          sourceWords: [...source.sourceWords, ...next.sourceWords],
        });
        if (joined.aligned) {
          cues = joined.segments;
          sourceText = joinedText;
          compactTextLength += addedChars;
          index += 1;
        }
      }
    }
    appendFlat(cues, aligned.aligned);
    compact.push(aligned.aligned ? {
      start: cues[0].start,
      end: cues.at(-1).end,
      text: sourceText,
      timingSource: 'word',
      // Lossless tuples avoid repeating JSON keys for every cue in long jobs.
      wordAlignedCues: cues.map(({ start, end, text }) => [start, end, text]),
    } : source);
  }
  return needsCompact ? compact : refined;
}

export async function processTranscriptionSegments(segments, language, { correct } = {}) {
  // 교정 전에 합친다. GPT가 잘린 조각이 아니라 온전한 문장을 보게 된다.
  const repetitionFilteredSegments = filterWhisperRepetitionLoops(segments);
  if (repetitionFilteredSegments.length !== segments.length) {
    console.warn(
      `[transcribe] Whisper 반복 환각 세그먼트 ${segments.length - repetitionFilteredSegments.length}개 제거`,
    );
  }
  const nonSilentSegments = filterSilentSegments(repetitionFilteredSegments);
  // 영어는 단어 타임코드가 있는 원래 세그먼트를 기준으로 나눈다. 짧은 문장을
  // 합치면 무음까지 하나의 자막으로 늘어날 수 있으므로 이 단계에서는 병합하지 않는다.
  const filteredSegments = normalizeLanguage(language) === 'en'
    ? refineEnglishSegmentsWithWordTimings(nonSilentSegments)
    : mergeShortSegments(nonSilentSegments, MIN_SEGMENT_CHARS, {
      preserveWordTimings: ['ko', 'unknown'].includes(normalizeLanguage(language)),
    });
  const correctionStartedAt = performance.now();
  let processedSegments;
  let correctionTimings;

  try {
    const correctionResult = await processSegmentsWithTiming(filteredSegments, language, correct);
    processedSegments = correctionResult.segments;
    correctionTimings = correctionResult.timings;
  } catch (error) {
    console.error('[gpt]', error.message);
    processedSegments = filteredSegments;
  }

  // Korean spelling/spacing correction retains sourceWords. Validate against
  // the final text before using them; changed speech falls back to source time.
  const timedSegments = normalizeLanguage(language) === 'ko'
    || correctionTimings?.languageDecision === 'inferred_from_hangul_segments'
    ? refineKoreanSegmentsWithWordTimings(processedSegments) : processedSegments;

  return {
    segments: timedSegments.map(({ sourceWords: ignoredSourceWords, ...segment }) => ({
      ...segment,
      text: normalizeLanguage(language) === 'en' ? segment.text : removeCommas(segment.text),
    })),
    correctionTimings,
    correctionMs: performance.now() - correctionStartedAt,
  };
}

export function joinSegmentText(segments) {
  return segments.map((segment) => segment.text).join('\n');
}
