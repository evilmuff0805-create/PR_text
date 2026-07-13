import 'dotenv/config';
import { performance } from 'perf_hooks';
import { fileURLToPath } from 'url';
import { resolve } from 'path';

export const MODELS = ['gpt-4o', 'gpt-5.6-luna'];

const PLAN_REVENUE_KRW_PER_MINUTE = {
  basic: 49,
  pro: 43,
  creator: 34.9,
};

export const GOLDEN_CASES = [
  {
    name: '맞춤법 교정',
    input: '오늘 날씨가 너무 조아서 밖에 나갓어',
    expected: '오늘 날씨가 너무 좋아서 밖에 나갔어',
  },
  {
    name: '구어체 보존',
    input: '아니 그니까 나는 갠찬은데 너는 어땟어',
    expected: '아니 그니까 나는 괜찮은데 너는 어땠어',
  },
  {
    name: '반복어 보존',
    input: '아 진짜 너무 웃겨가지고 ㅋㅋㅋ 그랬거든요',
    expected: '아 진짜 너무 웃겨가지고 ㅋㅋㅋ 그랬거든요',
  },
  {
    name: '띄어쓰기 교정',
    input: '그거 내가 햇던 말인데 진짜 몰라서 그런거야',
    expected: '그거 내가 했던 말인데 진짜 몰라서 그런 거야',
  },
  {
    name: '사투리 보존',
    input: '그라모 내가 먼저 갈게예',
    expected: '그라모 내가 먼저 갈게예',
  },
];

function numberFromEnv(name) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function positiveIntegerFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isInteger(value) && value > 0 ? Math.min(value, 5) : fallback;
}

function normalizeLines(text) {
  return String(text).replace(/\r\n/g, '\n').trim().split('\n').map((line) => line.trim());
}

export function evaluateOutput(output, expected) {
  const outputLines = normalizeLines(output);
  const expectedLines = normalizeLines(expected);
  const matchingLines = outputLines.filter((line, index) => line === expectedLines[index]).length;

  return {
    lineCountPassed: outputLines.length === expectedLines.length,
    expectedLineMatches: matchingLines,
    expectedLineTotal: expectedLines.length,
    exactMatch: outputLines.join('\n') === expectedLines.join('\n'),
  };
}

export function summarizeReplayQuality(originalSegments, processedSegments) {
  const originalLines = originalSegments.map((segment) => String(segment.text || '').trim());
  const processedLines = processedSegments.map((segment) => String(segment.text || '').trim());
  const comparedLineCount = Math.min(originalLines.length, processedLines.length);
  let changedLineCount = 0;

  for (let index = 0; index < comparedLineCount; index++) {
    if (originalLines[index] !== processedLines[index]) changedLineCount += 1;
  }

  return {
    lineCountPassed: originalLines.length === processedLines.length,
    originalLineCount: originalLines.length,
    processedLineCount: processedLines.length,
    changedLineCount,
    changedLineRate: comparedLineCount ? changedLineCount / comparedLineCount : 0,
  };
}

export function marginScenario(correctionCostUsd, durationSeconds, usdKrw) {
  if (!Number.isFinite(correctionCostUsd) || correctionCostUsd < 0) return null;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  if (!Number.isFinite(usdKrw) || usdKrw <= 0) return null;

  const audioMinutes = durationSeconds / 60;
  const correctionCostKrw = correctionCostUsd * usdKrw;
  return Object.fromEntries(Object.entries(PLAN_REVENUE_KRW_PER_MINUTE).map(([plan, revenuePerMinuteKrw]) => {
    const revenueKrw = audioMinutes * revenuePerMinuteKrw;
    return [plan, {
      audioMinutes,
      correctionCostKrw,
      correctionCostKrwPerMinute: correctionCostKrw / audioMinutes,
      revenuePerMinuteKrw,
      revenueKrw,
      marginBeforeOtherCostsKrw: revenueKrw - correctionCostKrw,
      marginBeforeOtherCostsRate: (revenueKrw - correctionCostKrw) / revenueKrw,
    }];
  }));
}

export function validateReplaySegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('비교할 전사 세그먼트가 없습니다. BENCHMARK_TRANSCRIPTION_LOG_ID를 확인해주세요.');
  }

  const normalized = segments.map((segment) => ({
    start: Number(segment?.start) || 0,
    end: Number(segment?.end) || 0,
    text: String(segment?.text || '').trim(),
  })).filter((segment) => segment.text);

  if (normalized.length === 0) {
    throw new Error('비교할 텍스트 세그먼트가 없습니다.');
  }
  return normalized;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function sumUsage(results) {
  return results.reduce((total, result) => {
    const usage = result.usage;
    if (!usage) return total;
    return {
      promptTokens: total.promptTokens + (usage.promptTokens || 0),
      cachedTokens: total.cachedTokens + (usage.cachedTokens || 0),
      completionTokens: total.completionTokens + (usage.completionTokens || 0),
      totalTokens: total.totalTokens + (usage.totalTokens || 0),
    };
  }, { promptTokens: 0, cachedTokens: 0, completionTokens: 0, totalTokens: 0 });
}

function summarizeRuns(results) {
  const successful = results.filter((result) => result.outcome === 'success');
  const durations = successful.map((result) => result.durationMs);
  const costs = successful.map((result) => result.estimatedCostUsd).filter(Number.isFinite);
  const actualModels = [...new Set(successful.flatMap((result) => result.actualModels || []).filter(Boolean))];

  return {
    runs: results.length,
    successfulRuns: successful.length,
    averageDurationMs: durations.length ? Math.round(durations.reduce((total, value) => total + value, 0) / durations.length) : null,
    medianDurationMs: durations.length ? Math.round(median(durations)) : null,
    averageEstimatedCostUsd: costs.length ? costs.reduce((total, value) => total + value, 0) / costs.length : null,
    averageUsage: successful.length ? Object.fromEntries(
      Object.entries(sumUsage(successful)).map(([name, value]) => [name, value / successful.length])
    ) : null,
    actualModels,
    fallbackRuns: successful.filter((result) => result.fallbackCount > 0).length,
  };
}

async function loadReplaySource(logId) {
  const { supabaseAdmin } = await import('../src/lib/supabase.js');
  const { data, error } = await supabaseAdmin
    .from('transcription_logs')
    .select('id, duration_seconds, language, segments')
    .eq('id', logId)
    .maybeSingle();

  if (error) throw new Error(`전사 이력 조회 실패: ${error.message}`);
  if (!data) throw new Error(`전사 이력 #${logId}을 찾지 못했습니다.`);

  return {
    logId: data.id,
    durationSeconds: Number(data.duration_seconds),
    language: data.language,
    segments: validateReplaySegments(data.segments),
  };
}

async function runGoldenCase(model, correctTextWithUsage) {
  const input = GOLDEN_CASES.map((sample) => sample.input).join('\n');
  const expected = GOLDEN_CASES.map((sample) => sample.expected).join('\n');
  const startedAt = performance.now();

  try {
    const result = await correctTextWithUsage(input, 'ko', { model });
    return {
      outcome: 'success',
      durationMs: Math.round(performance.now() - startedAt),
      estimatedCostUsd: result.estimatedCostUsd,
      usage: result.usage,
      actualModels: [result.model],
      fallbackCount: result.fallbackUsed ? 1 : 0,
      quality: evaluateOutput(result.text, expected),
      cases: GOLDEN_CASES.map((sample, index) => ({
        name: sample.name,
        exactMatch: normalizeLines(result.text)[index] === sample.expected,
      })),
    };
  } catch (error) {
    return {
      outcome: 'error',
      durationMs: Math.round(performance.now() - startedAt),
      message: error.message,
    };
  }
}

async function runReplay(model, source, correctTextWithUsage, processSegmentsWithTiming) {
  const startedAt = performance.now();
  try {
    const result = await processSegmentsWithTiming(
      source.segments,
      source.language || 'korean',
      (text, language) => correctTextWithUsage(text, language, { model })
    );
    const chunks = result.timings.chunks || [];
    const successful = chunks.length > 0 && chunks.every((chunk) => chunk.outcome === 'success');
    return {
      outcome: successful ? 'success' : 'error',
      durationMs: Math.round(performance.now() - startedAt),
      estimatedCostUsd: result.timings.estimatedCostUsd,
      usage: result.timings.usage,
      actualModels: chunks.map((chunk) => chunk.model),
      fallbackCount: result.timings.fallbackCount || 0,
      processing: {
        chunkCount: result.timings.chunkCount,
        batchCount: result.timings.batchCount,
        concurrency: result.timings.concurrency,
        wallMs: Math.round(result.timings.wallMs),
      },
      sourceTextIntegrity: summarizeReplayQuality(source.segments, result.segments),
      chunkOutcomes: chunks.map((chunk) => ({
        index: chunk.index,
        outcome: chunk.outcome,
        durationMs: Math.round(chunk.durationMs),
        segmentCount: chunk.segmentCount,
      })),
    };
  } catch (error) {
    return {
      outcome: 'error',
      durationMs: Math.round(performance.now() - startedAt),
      message: error.message,
    };
  }
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required to run this comparison.');
  }

  const { correctTextWithUsage } = await import('../src/services/gpt.js');
  const { processSegmentsWithTiming } = await import('../src/services/postprocess.js');
  const rounds = positiveIntegerFromEnv('BENCHMARK_RUNS', 1);
  const logId = numberFromEnv('BENCHMARK_TRANSCRIPTION_LOG_ID');
  const source = logId ? await loadReplaySource(logId) : null;
  const usdKrw = numberFromEnv('USD_KRW');
  const report = {
    generatedAt: new Date().toISOString(),
    methodology: {
      golden: 'Known Korean spelling and spacing cases measure exact expected output and line preservation.',
      replay: source
        ? 'Existing production transcript segments are replayed without printing their text. Replay measures cost, latency, fallback, and line preservation; it is not a ground-truth accuracy score.'
        : 'Set BENCHMARK_TRANSCRIPTION_LOG_ID to replay an existing production transcript for cost, latency, and margin measurement.',
      rounds,
      usdKrw,
    },
    source: source && {
      type: 'transcription_log_replay',
      logId: source.logId,
      durationSeconds: source.durationSeconds,
      segmentCount: source.segments.length,
    },
    models: {},
  };

  for (const model of MODELS) {
    const goldenRuns = [];
    const replayRuns = [];
    for (let index = 0; index < rounds; index++) {
      goldenRuns.push(await runGoldenCase(model, correctTextWithUsage));
      if (source) replayRuns.push(await runReplay(model, source, correctTextWithUsage, processSegmentsWithTiming));
    }

    const golden = summarizeRuns(goldenRuns);
    const replay = source ? summarizeRuns(replayRuns) : null;
    const successfulGolden = goldenRuns.filter((run) => run.outcome === 'success');
    const expectedLineMatches = successfulGolden.reduce((total, run) => total + run.quality.expectedLineMatches, 0);
    const expectedLineTotal = successfulGolden.reduce((total, run) => total + run.quality.expectedLineTotal, 0);
    report.models[model] = {
      golden: {
        ...golden,
        exactExpectedLineRate: expectedLineTotal ? expectedLineMatches / expectedLineTotal : null,
        exactMatchRuns: successfulGolden.filter((run) => run.quality.exactMatch).length,
        details: goldenRuns,
      },
      replay: replay && {
        ...replay,
        marginScenario: marginScenario(replay.averageEstimatedCostUsd, source.durationSeconds, usdKrw),
        details: replayRuns,
      },
    };
  }

  console.log(JSON.stringify(report, null, 2));
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

