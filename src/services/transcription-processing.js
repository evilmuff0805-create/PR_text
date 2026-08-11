import { performance } from 'perf_hooks';
import { processSegmentsWithTiming } from './postprocess.js';

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
  const filteredSegments = mergeShortSegments(filterSilentSegments(segments));
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
