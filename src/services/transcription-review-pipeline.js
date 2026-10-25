import { normalizeLanguage } from './language.js';
import { recheckCompressedTranscriptionSegments } from './transcription-review.js';
import { recheckTranscriptionBoundaries } from './transcription-boundaries.js';

/** Share a single additional-audio budget; display holds remain export-only. */
export async function reviewTranscriptionTiming(result, {
  durationSeconds, signal, transcribeRange, recheckCompressed = true, recheckBoundaries = true,
  boundaryReviewIndices, boundaryReviewWindows,
} = {}) {
  if (normalizeLanguage(result?.language) !== 'ko' || !Array.isArray(result?.segments)
    || typeof transcribeRange !== 'function') return result;
  signal?.throwIfAborted();
  let reviewed = result;
  let budget = { requests: 0, seconds: 0 };
  if (recheckCompressed) {
    const compressed = await recheckCompressedTranscriptionSegments(reviewed.segments, {
      durationSeconds, signal, transcribeRange: range => transcribeRange(range, { allowVocabulary: true }),
    });
    // Per-row measurements can repeat a window. Failed attempts still count.
    const windows = [...new Map(compressed.measurements.map(item => [`${item.start}:${item.end}`, item])).values()];
    budget = { requests: windows.length, seconds: windows.reduce((sum, item) => sum + item.end - item.start, 0) };
    reviewed = { ...reviewed, segments: compressed.segments,
      timings: { ...reviewed.timings, reviewMeasurements: compressed.measurements } };
  }
  if (recheckBoundaries) {
    const boundaries = await recheckTranscriptionBoundaries(reviewed.segments, {
      language: reviewed.language, durationSeconds, signal, budget, transcribeRange,
      indices: boundaryReviewIndices, reviewWindows: boundaryReviewWindows,
      applyConsistentEstimates: true,
    });
    reviewed = { ...reviewed, segments: boundaries.segments, timings: { ...reviewed.timings,
      boundaryReviewMeasurements: boundaries.measurements,
      boundaryReviewBudget: boundaries.budget, boundaryReviewScope: boundaries.scope } };
  }
  signal?.throwIfAborted();
  return reviewed;
}
