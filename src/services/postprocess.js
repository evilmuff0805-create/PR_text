import { performance } from 'perf_hooks';
import { isKoreanLanguage, normalizeLanguage, UNKNOWN_LANGUAGE } from './language.js';

const CHUNK_SIZE = 30;
const DEFAULT_CONCURRENCY = 4;

function getCorrectionConcurrency() {
  const configured = Number.parseInt(process.env.GPT_CORRECTION_CONCURRENCY ?? '', 10);
  if (!Number.isFinite(configured)) return DEFAULT_CONCURRENCY;
  return Math.min(Math.max(configured, 1), 4);
}

function speechCharacters(text) {
  return Array.from(String(text ?? '').normalize('NFC').replace(/[^\p{L}\p{N}]/gu, ''));
}

function isSubsequence(shorter, longer) {
  let index = 0;
  for (const character of longer) {
    if (character === shorter[index]) index += 1;
  }
  return index === shorter.length;
}

function changesRepeatedSpeech(sourceCharacters, candidateCharacters) {
  const source = sourceCharacters.join('');
  const candidate = candidateCharacters.join('');
  const units = new Set();
  for (const text of [source, candidate]) {
    for (const match of text.matchAll(/([\p{L}\p{N}]{1,32}?)\1+/gu)) units.add(match[1]);
  }
  return [...units].some((unit) => source.split(unit).length !== candidate.split(unit).length);
}

function preserveSpokenText(original, corrected) {
  const candidate = corrected.trim();
  const sourceCharacters = speechCharacters(original);
  const candidateCharacters = speechCharacters(candidate);
  // 공백 결과 및 원문에서 글자만 빼거나 더한 교정은 대사 삭제/추가의 명확한
  // 근거다. 해당 줄만 원문으로 되돌리고 다른 줄의 맞춤법 교정은 유지한다.
  if (!candidate || (sourceCharacters.length > 0 && candidateCharacters.length === 0)) return original;
  if (candidateCharacters.length < sourceCharacters.length
    && isSubsequence(candidateCharacters, sourceCharacters)) return original;
  if (sourceCharacters.length > 0 && candidateCharacters.length > sourceCharacters.length
    && isSubsequence(sourceCharacters, candidateCharacters)) return original;
  // 다른 부분의 맞춤법도 함께 바뀌어도 반복 대사를 줄이거나 늘리지 않는다.
  if (changesRepeatedSpeech(sourceCharacters, candidateCharacters)) return original;
  return candidate;
}

async function correctChunk(chunk, correct) {
  const allText = chunk.map(segment => segment.text).join('\n');

  try {
    const corrected = await correct(allText, 'ko');
    const processed = typeof corrected === 'string' ? corrected : corrected.text;
    if (typeof processed !== 'string') throw new Error('GPT 교정 결과 형식이 올바르지 않습니다.');

    const lines = processed.split('\n');
    if (lines.length !== chunk.length) {
      console.warn(`[gpt chunk] 줄 수 불일치: 원본 ${chunk.length}줄, GPT ${lines.length}줄 -> 원본 유지`);
      return {
        segments: chunk,
        outcome: 'line_count_mismatch',
        model: corrected.model,
        requestedModel: corrected.requestedModel,
        fallbackUsed: corrected.fallbackUsed === true,
        usage: corrected.usage,
        estimatedCostUsd: corrected.estimatedCostUsd,
      };
    }

    return {
      segments: chunk.map((segment, index) => ({
        ...segment,
        text: preserveSpokenText(segment.text, lines[index]),
      })),
      outcome: 'success',
      model: corrected.model,
      requestedModel: corrected.requestedModel,
      fallbackUsed: corrected.fallbackUsed === true,
      usage: corrected.usage,
      estimatedCostUsd: corrected.estimatedCostUsd,
    };
  } catch (err) {
    console.error('[gpt chunk]', err.message);
    return { segments: chunk, outcome: 'fallback' };
  }
}

function summarizeUsage(chunks) {
  const usage = chunks.map(chunk => chunk.usage).filter(Boolean);
  if (usage.length === 0) return undefined;

  return usage.reduce((total, value) => ({
    promptTokens: total.promptTokens + (value.promptTokens || 0),
    cachedTokens: total.cachedTokens + (value.cachedTokens || 0),
    completionTokens: total.completionTokens + (value.completionTokens || 0),
    totalTokens: total.totalTokens + (value.totalTokens || 0),
  }), { promptTokens: 0, cachedTokens: 0, completionTokens: 0, totalTokens: 0 });
}

function summarizeEstimatedCost(chunks) {
  const costs = chunks.map(chunk => chunk.estimatedCostUsd).filter(Number.isFinite);
  if (costs.length === 0) return undefined;
  return costs.reduce((total, value) => total + value, 0);
}

function summarizeActualModel(chunks) {
  const models = [...new Set(chunks.map(chunk => chunk.model).filter(Boolean))];
  if (models.length === 0) return undefined;
  return models.length === 1 ? models[0] : models;
}

function hasMostlyKoreanText(segments) {
  const text = segments.map(segment => segment.text || '').join('');
  const hangulCount = (text.match(/[가-힣]/g) || []).length;
  const letterCount = (text.match(/[A-Za-z가-힣]/g) || []).length;
  return hangulCount >= 4 && hangulCount / Math.max(letterCount, 1) >= 0.5;
}

export async function processSegmentsWithTiming(segments, detectedLang, correct) {
  const startedAt = performance.now();
  const language = normalizeLanguage(detectedLang);
  const detectedKorean = isKoreanLanguage(language);
  const inferredKorean = language === UNKNOWN_LANGUAGE && hasMostlyKoreanText(segments);
  const shouldCorrectKorean = detectedKorean || inferredKorean;

  if (!shouldCorrectKorean) {
    return {
      segments,
      timings: {
        eligible: false,
        languageDecision: language || 'unknown',
        wallMs: performance.now() - startedAt,
        chunkCount: 0,
        batchCount: 0,
        chunks: [],
      },
    };
  }

  const gpt = correct ? null : await import('./gpt.js');
  const corrector = correct ?? gpt.correctTextWithUsage;
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
      languageDecision: detectedKorean ? 'detected_korean' : 'inferred_from_hangul_segments',
      model: summarizeActualModel(chunkTimings) ?? model,
      requestedModel: model,
      fallbackCount: chunkTimings.filter(chunk => chunk.fallbackUsed).length,
      usage: summarizeUsage(chunkTimings),
      estimatedCostUsd: summarizeEstimatedCost(chunkTimings),
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
