import { performance } from 'perf_hooks';

const CHUNK_SIZE = 30;
const DEFAULT_CONCURRENCY = 4;

function getCorrectionConcurrency() {
  const configured = Number.parseInt(process.env.GPT_CORRECTION_CONCURRENCY ?? '', 10);
  if (!Number.isFinite(configured)) return DEFAULT_CONCURRENCY;
  return Math.min(Math.max(configured, 1), 4);
}

async function correctChunk(chunk, correct) {
  const allText = chunk.map(segment => segment.text).join('\n');

  try {
    const processed = await correct(allText, 'ko');
    const lines = processed.split('\n');
    if (lines.length !== chunk.length) {
      console.warn(`[gpt chunk] 줄 수 불일치: 원본 ${chunk.length}줄, GPT ${lines.length}줄 -> 원본 유지`);
      return { segments: chunk, outcome: 'line_count_mismatch' };
    }

    return {
      segments: chunk.map((segment, index) => ({
        ...segment,
        text: (lines[index] || segment.text).trim(),
      })),
      outcome: 'success',
    };
  } catch (err) {
    console.error('[gpt chunk]', err.message);
    return { segments: chunk, outcome: 'fallback' };
  }
}

export async function processSegmentsWithTiming(segments, detectedLang, correct) {
  const startedAt = performance.now();
  const language = (detectedLang || '').toLowerCase();
  const shouldCorrectKorean = language.includes('korean') || language === 'ko' || language === 'kor';

  if (!shouldCorrectKorean) {
    return {
      segments,
      timings: {
        eligible: false,
        wallMs: performance.now() - startedAt,
        chunkCount: 0,
        batchCount: 0,
        chunks: [],
      },
    };
  }

  const gpt = correct ? null : await import('./gpt.js');
  const corrector = correct ?? gpt.correctText;
  const model = correct ? 'custom' : gpt.getCorrectionModel();

  const chunks = [];
  for (let index = 0; index < segments.length; index += CHUNK_SIZE) {
    chunks.push({
      index: chunks.length,
      segments: segments.slice(index, index + CHUNK_SIZE),
    });
  }

  const corrected = [];
  const concurrency = getCorrectionConcurrency();
  const batchTimings = [];
  const chunkTimings = [];
  for (let index = 0; index < chunks.length; index += concurrency) {
    const batch = chunks.slice(index, index + concurrency);
    const batchStartedAt = performance.now();
    const batchResults = await Promise.all(batch.map(async (chunk) => {
      const chunkStartedAt = performance.now();
      const result = await correctChunk(chunk.segments, corrector);
      return {
        index: chunk.index,
        segmentCount: chunk.segments.length,
        durationMs: performance.now() - chunkStartedAt,
        ...result,
      };
    }));
    const batchDurationMs = performance.now() - batchStartedAt;
    corrected.push(...batchResults.flatMap(result => result.segments));
    chunkTimings.push(...batchResults.map(({ segments: ignored, ...result }) => result));
    batchTimings.push({
      index: batchTimings.length,
      chunkIndexes: batchResults.map(result => result.index),
      durationMs: batchDurationMs,
    });
  }

  return {
    segments: corrected,
    timings: {
      eligible: true,
      model,
      wallMs: performance.now() - startedAt,
      chunkCount: chunks.length,
      batchCount: batchTimings.length,
      concurrency,
      batches: batchTimings,
      chunks: chunkTimings,
    },
  };
}

export async function processSegments(segments, detectedLang, correct) {
  const result = await processSegmentsWithTiming(segments, detectedLang, correct);
  return result.segments;
}
