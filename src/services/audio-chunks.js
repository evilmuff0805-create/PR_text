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

  for (const { chunk, response } of chunkResults) {
    for (const segment of response.segments ?? []) {
      const start = Number(segment.start) + chunk.inputStart;
      const end = Number(segment.end) + chunk.inputStart;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

      // The following chunk owns a segment that crosses a planned boundary.
      if (end <= chunk.ownedStart + EPSILON_SECONDS) continue;
      if (end > chunk.ownedEnd + EPSILON_SECONDS) continue;

      merged.push({ ...segment, start, end });
    }
  }

  return merged.sort((left, right) => left.start - right.start || left.end - right.end);
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
