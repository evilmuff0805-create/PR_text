import { completeProviderWordSpans } from './provider-word-spans.js';
import { withSubtitleReviewIssue } from './subtitle-review.js';
import { normalizeLanguage } from './language.js';

const EPSILON_SECONDS = 0.001;

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function chooseBoundary({ start, durationSeconds, silenceEnds, targetSeconds, boundaryWindowSeconds }) {
  const target = Math.min(start + targetSeconds, durationSeconds);
  if (target === durationSeconds) return durationSeconds;

  const candidates = silenceEnds
    .filter(end => end > start + 30 && end >= target - boundaryWindowSeconds && end <= target + boundaryWindowSeconds);

  if (candidates.length === 0) return target;
  return candidates.reduce((closest, end) => (
    Math.abs(end - target) < Math.abs(closest - target) ? end : closest
  ));
}

export function buildAudioChunkPlan({
  durationSeconds,
  silenceEnds = [],
  targetSeconds = 180,
  boundaryWindowSeconds = 45,
  overlapSeconds = 5,
}) {
  const duration = positiveNumber(durationSeconds, 0);
  if (duration === 0) return [];

  const target = positiveNumber(targetSeconds, 180);
  const window = positiveNumber(boundaryWindowSeconds, 45);
  const overlap = positiveNumber(overlapSeconds, 5);
  const normalizedSilenceEnds = silenceEnds
    .map(Number)
    .filter(end => Number.isFinite(end) && end > 0 && end < duration)
    .sort((a, b) => a - b);

  const chunks = [];
  let ownedStart = 0;
  while (ownedStart < duration - EPSILON_SECONDS) {
    const ownedEnd = chooseBoundary({
      start: ownedStart,
      durationSeconds: duration,
      silenceEnds: normalizedSilenceEnds,
      targetSeconds: target,
      boundaryWindowSeconds: window,
    });

    chunks.push({
      index: chunks.length,
      ownedStart,
      ownedEnd,
      inputStart: Math.max(0, ownedStart - overlap),
      inputEnd: Math.min(duration, ownedEnd + overlap),
    });
    ownedStart = ownedEnd;
  }

  return chunks;
}

export function mergeChunkSegments(chunkResults) {
  const merged = [];
  const origins = new WeakMap();
  const koreanSegments = new WeakSet();
  const append = (segment, chunk, korean) => {
    merged.push(segment); origins.set(segment, chunk);
    if (korean) koreanSegments.add(segment);
  };

  for (const { chunk, response } of chunkResults) {
    const language = normalizeLanguage(response.language);
    for (const segment of response.segments ?? []) {
      const start = Number(segment.start) + chunk.inputStart;
      const end = Number(segment.end) + chunk.inputStart;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

      // Korean segments can straddle an ownership edge. Keeping the entire
      // following segment repeats its context prefix; export then clips the
      // previous dialogue to a few frames. Partition only complete, unique
      // word/text spans, assigning a boundary-crossing word by its end once.
      const crossesStart = start < chunk.ownedStart - EPSILON_SECONDS;
      const crossesEnd = end > chunk.ownedEnd + EPSILON_SECONDS;
      const korean = ['ko', 'unknown'].includes(language)
        && (segment.speaker === undefined || segment.speaker === null || segment.speaker === '')
        && /[가-힣]/u.test(String(segment.text ?? ''));
      if ((crossesStart || crossesEnd) && korean) {
        const complete = completeProviderWordSpans(segment, response.words);
        if (complete) {
          const owned = complete.words.map((word, index) => ({ word, index }))
            .filter(({ word }) => word.end + chunk.inputStart > chunk.ownedStart + EPSILON_SECONDS
              && word.end + chunk.inputStart <= chunk.ownedEnd + EPSILON_SECONDS);
          if (!owned.length) continue;
          const first = owned[0].index;
          const last = owned.at(-1).index;
          const sourceWords = complete.words.slice(first, last + 1).map((word) => ({
            ...word, start: word.start + chunk.inputStart, end: word.end + chunk.inputStart,
          }));
          append({
            ...segment,
            start: sourceWords[0].start,
            end: sourceWords.at(-1).end,
            text: segment.text.slice(complete.cuts[first], complete.cuts[last + 1]).trim(),
            sourceWords,
            subtitleReview: {
              version: 1,
              issues: [{ code: 'chunk_boundary_replanned', chunkIndex: chunk.index,
                sourceStart: start, sourceEnd: end, ownedStart: chunk.ownedStart, ownedEnd: chunk.ownedEnd }],
              timingStatus: 'unverified',
            },
          }, chunk, korean);
          continue;
        }
      }

      // Preserve the established fallback when complete words are unavailable.
      if (end <= chunk.ownedStart + EPSILON_SECONDS) continue;
      if (end > chunk.ownedEnd + EPSILON_SECONDS) continue;

      const sourceWords = (Array.isArray(response.words) ? response.words : [])
        .filter((word) => {
          if (!word || typeof word !== 'object') return false;
          // Validate provider numbers before offsetting: Number(null), false,
          // or an empty string would otherwise become a fabricated zero time.
          const wordStart = word.start;
          const wordEnd = word.end;
          return typeof wordStart === 'number' && typeof wordEnd === 'number'
            && Number.isFinite(wordStart) && Number.isFinite(wordEnd)
            && wordEnd > wordStart
            && wordStart >= Number(segment.start)
            && wordEnd <= Number(segment.end);
        })
        .map((word) => ({
          ...word,
          start: Number(word.start) + chunk.inputStart,
          end: Number(word.end) + chunk.inputStart,
        }));
      append({ ...segment, start, end, sourceWords,
        ...(crossesStart && korean ? {
          subtitleReview: { version: 1, issues: [{ code: 'chunk_boundary_unverified' }], timingStatus: 'unverified' },
        } : {}),
      }, chunk, korean);
    }
  }

  const sorted = merged.sort((left, right) => left.start - right.start || left.end - right.end);
  const uncertain = new Set();
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (origins.get(previous) !== origins.get(current) && previous.end > current.start + 1e-9
      && koreanSegments.has(previous) && koreanSegments.has(current)) {
      uncertain.add(index - 1); uncertain.add(index);
    }
  }
  return sorted.map((segment, index) => uncertain.has(index)
    ? withSubtitleReviewIssue(segment, { code: 'chunk_boundary_unverified', reason: 'conflicting_word_estimates' }, { timingStatus: 'unverified' })
    : segment);
}

export async function mapWithConcurrency(items, concurrency, worker) {
  const limit = Math.max(1, Math.min(Math.floor(concurrency), items.length));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: limit }, runWorker));
  return results;
}
