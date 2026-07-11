const CHUNK_SIZE = 30;
const DEFAULT_CONCURRENCY = 2;

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
      return chunk;
    }

    return chunk.map((segment, index) => ({
      ...segment,
      text: (lines[index] || segment.text).trim(),
    }));
  } catch (err) {
    console.error('[gpt chunk]', err.message);
    return chunk;
  }
}

export async function processSegments(segments, detectedLang, correct) {
  const language = (detectedLang || '').toLowerCase();
  const shouldCorrectKorean = language.includes('korean') || language === 'ko' || language === 'kor';

  if (!shouldCorrectKorean) return segments;

  const corrector = correct ?? (await import('./gpt.js')).correctText;

  const chunks = [];
  for (let index = 0; index < segments.length; index += CHUNK_SIZE) {
    chunks.push(segments.slice(index, index + CHUNK_SIZE));
  }

  const corrected = [];
  const concurrency = getCorrectionConcurrency();
  for (let index = 0; index < chunks.length; index += concurrency) {
    const batch = chunks.slice(index, index + concurrency);
    const batchResults = await Promise.all(batch.map(chunk => correctChunk(chunk, corrector)));
    corrected.push(...batchResults.flat());
  }

  return corrected;
}
