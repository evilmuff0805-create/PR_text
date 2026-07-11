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
  assert.equal(estimateCorrectionCostUsd('gpt-5.6-luna', usage), 0.00382);
  assert.equal(estimateCorrectionCostUsd('unknown-model', usage), null);
});
