import { performance } from 'perf_hooks';
import { isKoreanLanguage, normalizeLanguage, UNKNOWN_LANGUAGE } from './language.js';
import { normalizeTokenUsage } from './correction-pricing.js';
import { mergeSubtitleReviews } from './subtitle-review.js';

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

const MAX_REPEAT_UNIT_CHARS = 32;

function repeatAt(characters, start, limit, boundaries) {
  let best = null;
  for (let width = 1; width <= MAX_REPEAT_UNIT_CHARS && start + width * 2 <= limit; width += 1) {
    let position = start + width;
    let matchedEnd = null;
    while (position + width <= limit) {
      let matches = true;
      for (let offset = 0; offset < width; offset += 1) {
        if (characters[start + offset] !== characters[position + offset]) {
          matches = false;
          break;
        }
      }
      if (!matches) break;
      position += width;
      if (!boundaries || boundaries.has(position)) matchedEnd = position;
    }
    if (matchedEnd !== null && (!best || matchedEnd > best.end)) {
      best = { start, end: matchedEnd, unit: characters.slice(start, start + width).join(''), count: (matchedEnd - start) / width };
      if (best.end === limit) break;
    }
  }
  return best;
}

function repeatedSpeech(text) {
  const characters = [];
  const words = (String(text ?? '').normalize('NFC').match(/[\p{L}\p{N}]+/gu) ?? []).map((value) => {
    const start = characters.length;
    for (const character of value) characters.push(character);
    return { value, start, end: characters.length };
  });
  const boundaries = new Set(words.map(({ end }) => end));
  const spans = [];
  for (let index = 0; index < words.length;) {
    const word = words[index];
    // Whole repeated words/phrases may be joined or spaced. Their last edge
    // must remain a word edge: a following corrected word's prefix is no copy.
    const repeated = repeatAt(characters, word.start, characters.length, boundaries);
    if (repeated) {
      spans.push(repeated);
      while (index < words.length && words[index].start < repeated.end) index += 1;
      continue;
    }
    // Retain protection for repetition inside a word, such as quoted laughter.
    for (let position = word.start; position < word.end;) {
      const internal = repeatAt(characters, position, word.end);
      if (internal) spans.push(internal);
      position = internal ? internal.end : position + 1;
    }
    index += 1;
  }
  return { characters, words, spans };
}

function repeatContext(speech, units) {
  const anchors = new Map();
  const counts = new Map();
  let spanIndex = 0;
  for (let index = 0; index < speech.words.length; index += 1) {
    const word = speech.words[index];
    while (spanIndex < speech.spans.length && speech.spans[spanIndex].end <= word.start) spanIndex += 1;
    const nextSpan = speech.spans[spanIndex];
    if (nextSpan && word.end > nextSpan.start) continue;
    const positions = anchors.get(word.value) ?? [];
    positions.push(spanIndex);
    anchors.set(word.value, positions);

    // Count additional complete occurrences outside the protected runs. Scan
    // at most 32 characters per word start, rather than rescanning per unit.
    let unit = '';
    for (let following = index; following < speech.words.length; following += 1) {
      const last = speech.words[following];
      if (last.end - word.start > MAX_REPEAT_UNIT_CHARS || (nextSpan && last.end > nextSpan.start)) break;
      unit += last.value;
      if (units.has(unit)) counts.set(unit, (counts.get(unit) ?? 0) + 1);
    }
  }
  return { anchors, counts };
}

function changesRepeatedSpeech(original, corrected) {
  const source = repeatedSpeech(original);
  const candidate = repeatedSpeech(corrected);
  if (source.spans.length !== candidate.spans.length) return true;
  if (source.spans.length === 0) return false;
  let sourceEnd = 0;
  let candidateEnd = 0;
  for (let index = 0; index < source.spans.length; index += 1) {
    const before = source.spans[index];
    const after = candidate.spans[index];
    if (before.unit !== after.unit || before.count !== after.count
      || (before.start === sourceEnd) !== (after.start === candidateEnd)) return true;
    sourceEnd = before.end;
    candidateEnd = after.end;
  }
  if ((sourceEnd === source.characters.length) !== (candidateEnd === candidate.characters.length)) return true;

  const units = new Set(source.spans.map(({ unit }) => unit));
  const before = repeatContext(source, units);
  const after = repeatContext(candidate, units);
  for (const unit of units) {
    if ((before.counts.get(unit) ?? 0) !== (after.counts.get(unit) ?? 0)) return true;
  }
  // Unchanged words establish which side of each repetition they belong to.
  // A repeated run cannot move across those anchors while keeping its count.
  for (const [word, positions] of before.anchors) {
    const following = after.anchors.get(word);
    if (following?.length === positions.length
      && positions.some((position, index) => position !== following[index])) return true;
  }
  return false;
}

// 수치의 구분 기호와 통상 단위를 함께 보존한다. 숫자와 단위 사이의
// 띄어쓰기는 허용하되, 이 규칙으로 한글 수사나 모든 의미를 판별하지 않는다.
const NUMERIC_UNIT = '(?:[A-Za-zµμ°]+[²³]?|[%％‰℃℉㎏㎎㎜㎝㎞㎡㎥]'
  + '|마이크로그램|킬로그램|밀리그램|킬로미터|센티미터|밀리미터|밀리리터|퍼센트'
  + '|킬로|그램|리터|미터|시간|개월|달러|위안|유로|파운드|마리'
  + '|초|분|시|일|주|월|달|년|원|엔|명|개|번|회|건|대|장|권|잔|병|포|세|살|도|배|점|톤|평)';
const NUMERIC_UNIT_SUFFIX = new RegExp(
  `^\\s*((?:[십백천만억조]\\s*)*${NUMERIC_UNIT}(?:\\s*[/·]\\s*${NUMERIC_UNIT})*|(?:[십백천만억조]\\s*)+)`,
  'u',
);

function numericExpressions(text) {
  const normalized = String(text ?? '').normalize('NFC');
  const expressions = [];
  const numbers = /(?:[+\-−±∓＋－]\s*)?(?:\p{N}+(?:\s*[.,:/~–—-]\s*\p{N}+)*|[.,]\s*\p{N}+)/gu;
  for (const match of normalized.matchAll(numbers)) {
    const number = match[0].replace(/\s+/g, '');
    const suffix = normalized.slice(match.index + match[0].length);
    const unit = suffix.match(NUMERIC_UNIT_SUFFIX)?.[1].replace(/\s+/g, '') ?? '';
    expressions.push(`${number}\0${unit}`);
  }
  return expressions;
}

function changesNumericExpressions(original, corrected) {
  const source = numericExpressions(original);
  const candidate = numericExpressions(corrected);
  return source.length !== candidate.length || source.some((value, index) => value !== candidate[index]);
}

export function evaluateSpokenTextCorrection(original, corrected) {
  const candidate = corrected.trim();
  const sourceCharacters = speechCharacters(original);
  const candidateCharacters = speechCharacters(candidate);
  // 공백 결과 및 원문에서 글자만 빼거나 더한 교정은 대사 삭제/추가의 명확한
  // 근거다. 해당 줄만 원문으로 되돌리고 다른 줄의 맞춤법 교정은 유지한다.
  const reject = (reason) => ({ text: original, accepted: false, reason });
  if (!candidate || (sourceCharacters.length > 0 && candidateCharacters.length === 0)) return reject('empty');
  if (changesNumericExpressions(original, candidate)) return reject('numeric_change');
  if (candidateCharacters.length < sourceCharacters.length
    && isSubsequence(candidateCharacters, sourceCharacters)) return reject('speech_deletion');
  if (sourceCharacters.length > 0 && candidateCharacters.length > sourceCharacters.length
    && isSubsequence(sourceCharacters, candidateCharacters)) return reject('speech_insertion');
  if (sourceCharacters.length === candidateCharacters.length
    && sourceCharacters.every((character, index) => character === candidateCharacters[index])) return { text: candidate, accepted: true };
  // 다른 부분의 맞춤법도 함께 바뀌어도 반복 대사를 줄이거나 늘리지 않는다.
  if (changesRepeatedSpeech(original, candidate)) return reject('repetition_change');
  return { text: candidate, accepted: true };
}

async function correctChunk(chunk, correct, { includeReviews = false, ...context } = {}) {
  const allText = chunk.map(segment => segment.text).join('\n');

  try {
    const corrected = await correct(allText, 'ko', context);
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
      segments: chunk.map((segment, index) => {
        const decision = evaluateSpokenTextCorrection(segment.text, lines[index]);
        if (!includeReviews || decision.accepted) return { ...segment, text: decision.text };
        return {
          ...segment,
          text: decision.text,
          subtitleReview: mergeSubtitleReviews(segment.subtitleReview, {
            version: 1,
            issues: [{ code: 'correction_guard_rejected', reason: decision.reason }],
            originalText: segment.text,
            candidateText: lines[index].trim(),
            textStatus: 'candidate',
            timingStatus: 'unverified',
          }),
        };
      }),
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
  const usage = chunks.map(chunk => chunk.usage).filter(Boolean).map(normalizeTokenUsage);
  if (usage.length === 0) return undefined;

  return usage.reduce((total, value) => ({
    promptTokens: total.promptTokens + (value.promptTokens || 0),
    cachedTokens: total.cachedTokens + (value.cachedTokens || 0),
    cacheWriteTokens: total.cacheWriteTokens + (value.cacheWriteTokens || 0),
    completionTokens: total.completionTokens + (value.completionTokens || 0),
    totalTokens: total.totalTokens + (value.totalTokens || 0),
  }), { promptTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, completionTokens: 0, totalTokens: 0 });
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

export async function processSegmentsWithTiming(segments, detectedLang, correct, { includeReviews = false } = {}) {
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
      contextBefore: segments.slice(Math.max(0, index - 3), index).map((segment) => segment.text),
      contextAfter: segments.slice(index + CHUNK_SIZE, index + CHUNK_SIZE + 3).map((segment) => segment.text),
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
      const result = await correctChunk(chunk.segments, corrector, {
        includeReviews, contextBefore: chunk.contextBefore, contextAfter: chunk.contextAfter,
      });
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
