import 'dotenv/config';
import { performance } from 'perf_hooks';

const MODELS = ['gpt-4o', 'gpt-5.6-luna'];
const PLAN_REVENUE_KRW_PER_MINUTE = {
  basic: 49,
  pro: 43,
  creator: 34.9,
};

const GOLDEN_CASES = [
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

function normalizeLines(text) {
  return String(text).replace(/\r\n/g, '\n').trim().split('\n').map(line => line.trim());
}

function evaluateOutput(output, expected) {
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

function summarizeResults(results) {
  const successful = results.filter(result => result.outcome === 'success');
  const totalDurationMs = successful.reduce((total, result) => total + result.durationMs, 0);
  const totalCostUsd = successful.reduce((total, result) => total + (result.estimatedCostUsd || 0), 0);
  const expectedLineMatches = successful.reduce((total, result) => total + result.quality.expectedLineMatches, 0);
  const expectedLineTotal = successful.reduce((total, result) => total + result.quality.expectedLineTotal, 0);

  return {
    calls: results.length,
    successfulCalls: successful.length,
    totalDurationMs,
    averageDurationMs: successful.length ? Math.round(totalDurationMs / successful.length) : null,
    totalCostUsd,
    lineCountPassRate: successful.length
      ? successful.filter(result => result.quality.lineCountPassed).length / successful.length
      : null,
    exactExpectedLineRate: expectedLineTotal ? expectedLineMatches / expectedLineTotal : null,
  };
}

function marginScenario(totalCostUsd) {
  const usdKrw = numberFromEnv('USD_KRW');
  const audioMinutes = numberFromEnv('BENCHMARK_AUDIO_MINUTES');
  if (!usdKrw || !audioMinutes) return null;

  const correctionCostKrw = totalCostUsd * usdKrw;
  const base = {
    audioMinutes,
    correctionCostKrw,
    correctionCostKrwPerMinute: correctionCostKrw / audioMinutes,
  };
  return Object.fromEntries(Object.entries(PLAN_REVENUE_KRW_PER_MINUTE).map(([plan, revenuePerMinuteKrw]) => {
    const revenueKrw = audioMinutes * revenuePerMinuteKrw;
    return [plan, {
      ...base,
      revenuePerMinuteKrw,
      revenueKrw,
      marginBeforeOtherCostsKrw: revenueKrw - correctionCostKrw,
      marginBeforeOtherCostsRate: (revenueKrw - correctionCostKrw) / revenueKrw,
    }];
  }));
}

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is required to run this comparison.');
  process.exit(1);
}

const { correctTextWithUsage } = await import('../src/services/gpt.js');
const report = { generatedAt: new Date().toISOString(), models: {} };

for (const model of MODELS) {
  const results = [];
  for (const sample of GOLDEN_CASES) {
    const startedAt = performance.now();
    try {
      const result = await correctTextWithUsage(sample.input, 'ko', { model });
      results.push({
        name: sample.name,
        outcome: 'success',
        durationMs: Math.round(performance.now() - startedAt),
        output: result.text,
        expected: sample.expected,
        usage: result.usage,
        estimatedCostUsd: result.estimatedCostUsd,
        quality: evaluateOutput(result.text, sample.expected),
      });
    } catch (error) {
      results.push({
        name: sample.name,
        outcome: 'error',
        durationMs: Math.round(performance.now() - startedAt),
        message: error.message,
      });
    }
  }

  const summary = summarizeResults(results);
  report.models[model] = {
    summary,
    marginScenario: marginScenario(summary.totalCostUsd),
    results,
  };
}

console.log(JSON.stringify(report, null, 2));
