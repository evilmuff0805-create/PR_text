import assert from 'node:assert/strict';
import test from 'node:test';
import { processSegmentsWithTiming } from '../src/services/postprocess.js';

const koreanSegments = [
  { start: 0, end: 1, text: '오늘 날씨가 조아요' },
  { start: 1, end: 2, text: '그래서 나갓어' },
];

test('corrects Korean segments when diarization language is unknown', async () => {
  const result = await processSegmentsWithTiming(koreanSegments, 'unknown', async (text) => text);

  assert.equal(result.timings.eligible, true);
  assert.equal(result.timings.languageDecision, 'inferred_from_hangul_segments');
  assert.deepEqual(result.segments, koreanSegments);
});

test('does not correct unknown English or explicitly detected English segments', async () => {
  const correct = async () => { throw new Error('correction must not run'); };
  const unknownEnglish = await processSegmentsWithTiming(
    [{ start: 0, end: 1, text: 'This is an English subtitle' }],
    'unknown',
    correct
  );
  const detectedEnglish = await processSegmentsWithTiming(koreanSegments, 'english', correct);

  assert.equal(unknownEnglish.timings.eligible, false);
  assert.equal(detectedEnglish.timings.eligible, false);
});

test('records actual model, fallback, usage, and cost from a correction response', async () => {
  const usage = { promptTokens: 100, cachedTokens: 0, completionTokens: 50, totalTokens: 150 };
  const result = await processSegmentsWithTiming(koreanSegments, 'korean', async (text) => ({
    text,
    model: 'gpt-5.6-luna',
    requestedModel: 'gpt-5.6-luna',
    fallbackUsed: false,
    usage,
    estimatedCostUsd: 0.0004,
  }));

  assert.equal(result.timings.model, 'gpt-5.6-luna');
  assert.equal(result.timings.fallbackCount, 0);
  assert.deepEqual(result.timings.usage, usage);
  assert.equal(result.timings.estimatedCostUsd, 0.0004);
});
