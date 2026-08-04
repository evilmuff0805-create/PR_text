import { performance } from 'perf_hooks';
import { processSegmentsWithTiming } from './postprocess.js';
import { removeCaptionPeriods } from './caption-text.js';

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

export async function processTranscriptionSegments(segments, language, correct) {
  const filteredSegments = filterSilentSegments(segments);
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

  return {
    segments: processedSegments.map((segment) => ({
      ...segment,
      text: removeCaptionPeriods(removeCommas(segment.text)),
    })),
    correctionTimings,
    correctionMs: performance.now() - correctionStartedAt,
  };
}

export function joinSegmentText(segments) {
  return segments.map((segment) => segment.text).join('\n');
}
