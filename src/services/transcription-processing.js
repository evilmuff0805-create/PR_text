import { performance } from 'perf_hooks';
import { processSegmentsWithTiming } from './postprocess.js';

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

export function mergeShortSegments(segments, minChars = MIN_SEGMENT_CHARS) {
  if (!Array.isArray(segments) || segments.length === 0) return [];

  const merged = [];
  let pending = null;

  for (const segment of segments) {
    const text = (segment.text || '').trim();

    if (pending) {
      // 화자가 다르면 합치지 않는다. 말이 섞여 누가 한 말인지 알 수 없게 된다.
      if (pending.speaker === segment.speaker) {
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

export async function processTranscriptionSegments(segments, language) {
  // 교정 전에 합친다. GPT가 잘린 조각이 아니라 온전한 문장을 보게 된다.
  const repetitionFilteredSegments = filterWhisperRepetitionLoops(segments);
  if (repetitionFilteredSegments.length !== segments.length) {
    console.warn(
      `[transcribe] Whisper 반복 환각 세그먼트 ${segments.length - repetitionFilteredSegments.length}개 제거`,
    );
  }
  const filteredSegments = mergeShortSegments(filterSilentSegments(repetitionFilteredSegments));
  const correctionStartedAt = performance.now();
  let processedSegments;
  let correctionTimings;

  try {
    const correctionResult = await processSegmentsWithTiming(filteredSegments, language);
    processedSegments = correctionResult.segments;
    correctionTimings = correctionResult.timings;
  } catch (error) {
    console.error('[gpt]', error.message);
    processedSegments = filteredSegments;
  }

  return {
    segments: processedSegments.map((segment) => ({
      ...segment,
      text: removeCommas(segment.text),
    })),
    correctionTimings,
    correctionMs: performance.now() - correctionStartedAt,
  };
}

export function joinSegmentText(segments) {
  return segments.map((segment) => segment.text).join('\n');
}
