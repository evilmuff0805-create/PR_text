import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateCorrectionCostUsd, normalizeTokenUsage } from '../src/services/correction-pricing.js';

test('normalizes raw OpenAI token usage including cached input', () => {
  const usage = normalizeTokenUsage({
    prompt_tokens: 1_000,
    completion_tokens: 500,
    total_tokens: 1_500,
    prompt_tokens_details: { cached_tokens: 200 },
  });

  assert.deepEqual(usage, {
    promptTokens: 1_000,
    cachedTokens: 200,
    cacheWriteTokens: 0,
    completionTokens: 500,
    totalTokens: 1_500,
  });
});

test('estimates GPT-4o and GPT-5.6 Luna correction costs', () => {
  const usage = {
    promptTokens: 1_000,
    cachedTokens: 200,
    completionTokens: 500,
    totalTokens: 1_500,
  };

  assert.equal(estimateCorrectionCostUsd('gpt-4o', usage), 0.00725);
  assert.equal(estimateCorrectionCostUsd('gpt-5.6-luna', usage), 0.000764);
  assert.equal(estimateCorrectionCostUsd('gpt-6-luna', usage), 0.000332);
  assert.equal(estimateCorrectionCostUsd('unknown-model', usage), null);
});

test('cache reads, writes, and uncached input are disjoint and normalizing twice is stable', () => {
  const raw = { prompt_tokens: 1_000, completion_tokens: 500, total_tokens: 1_500,
    prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 },
    completion_tokens_details: { reasoning_tokens: 400 } };
  const original = structuredClone(raw);
  const usage = normalizeTokenUsage(raw);
  assert.deepEqual(usage, { promptTokens: 1_000, cachedTokens: 200, cacheWriteTokens: 300,
    completionTokens: 500, totalTokens: 1_500 });
  assert.deepEqual(normalizeTokenUsage(usage), usage);
  assert.deepEqual(raw, original);
  assert.equal(estimateCorrectionCostUsd('gpt-5.6-luna', raw), 0.000779);
  assert.equal(estimateCorrectionCostUsd('gpt-6-luna', raw), 0.0003395);
  // GPT-4o has no new cache-write premium; writes remain normal input there.
  assert.equal(estimateCorrectionCostUsd('gpt-4o', raw), 0.00725);
});

test('normalization prioritizes valid cache reads and clamps writes to the remaining input', () => {
  assert.deepEqual(normalizeTokenUsage({ promptTokens: 100, cachedTokens: 80, cacheWriteTokens: 80 }),
    { promptTokens: 100, cachedTokens: 80, cacheWriteTokens: 20, completionTokens: 0, totalTokens: 100 });
  assert.deepEqual(normalizeTokenUsage({ prompt_tokens: 100,
    prompt_tokens_details: { cached_tokens: 150, cache_write_tokens: 200 } }),
  { promptTokens: 100, cachedTokens: 100, cacheWriteTokens: 0, completionTokens: 0, totalTokens: 100 });
  for (const promptTokens of [0, 1, 100]) for (const cachedTokens of [0, 80, 150]) for (const cacheWriteTokens of [0, 80, 200]) {
    const result = normalizeTokenUsage({ promptTokens, cachedTokens, cacheWriteTokens });
    assert.ok(result.cachedTokens >= 0 && result.cacheWriteTokens >= 0);
    assert.ok(result.cachedTokens + result.cacheWriteTokens <= result.promptTokens);
  }
});

test('only nonnegative safe integer token counts are accepted', () => {
  for (const invalid of [undefined, null, NaN, Infinity, -Infinity, -1, '100', true, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(normalizeTokenUsage({ promptTokens: invalid, cachedTokens: invalid,
      cacheWriteTokens: invalid, completionTokens: invalid, totalTokens: invalid }),
    { promptTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, completionTokens: 0, totalTokens: 0 });
  }
  assert.deepEqual(normalizeTokenUsage(null),
    { promptTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, completionTokens: 0, totalTokens: 0 });
  assert.equal(normalizeTokenUsage({ promptTokens: Number.MAX_SAFE_INTEGER, completionTokens: 1 }).totalTokens,
    Number.MAX_SAFE_INTEGER);
});

test('prices include actual API cache-write usage without adding reasoning tokens again', () => {
  const usage = { prompt_tokens: 1_518, completion_tokens: 1_052, total_tokens: 2_570,
    prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1_515 },
    completion_tokens_details: { reasoning_tokens: 665 } };
  assert.ok(Math.abs(estimateCorrectionCostUsd('gpt-6-luna', usage) - 0.000715675) < 1e-12);
});

test('Luna long-context rates apply to the full request strictly above 272K input tokens', () => {
  const usage = { promptTokens: 272_000, cachedTokens: 100_000, cacheWriteTokens: 100_000, completionTokens: 1_000 };
  assert.equal(estimateCorrectionCostUsd('gpt-6-luna', usage), 0.0212);
  assert.equal(estimateCorrectionCostUsd('gpt-5.6-luna', usage), 0.0426);
  const longer = { ...usage, promptTokens: 272_001 };
  assert.ok(Math.abs(estimateCorrectionCostUsd('gpt-6-luna', longer) - 0.0421502) < 1e-12);
  assert.ok(Math.abs(estimateCorrectionCostUsd('gpt-5.6-luna', longer) - 0.0846004) < 1e-12);
  assert.equal(estimateCorrectionCostUsd('gpt-4o', longer), 0.5650025);
});
