// OpenAI Standard prices as of 2026-10-18, in USD per 1M tokens:
// https://developers.openai.com/api/docs/models/gpt-6-luna
// https://developers.openai.com/api/docs/models/gpt-5.6-luna
export const CORRECTION_MODEL_PRICING = {
  'gpt-4o': { input: 2.5, cachedInput: 1.25, output: 10 },
  'gpt-5.6-luna': { input: 0.20, cachedInput: 0.02, cacheWriteInput: 0.25, output: 1.20 },
  'gpt-6-luna': { input: 0.10, cachedInput: 0.01, cacheWriteInput: 0.125, output: 0.50 },
};
const LONG_CONTEXT_LUNA_MODELS = new Set(['gpt-5.6-luna', 'gpt-6-luna']);
const LONG_CONTEXT_PROMPT_THRESHOLD = 272_000;

function finiteTokenCount(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function normalizeTokenUsage(usage) {
  const promptTokens = finiteTokenCount(usage?.promptTokens ?? usage?.prompt_tokens);
  const completionTokens = finiteTokenCount(usage?.completionTokens ?? usage?.completion_tokens);
  const cachedTokens = Math.min(
    promptTokens,
    finiteTokenCount(usage?.cachedTokens ?? usage?.prompt_tokens_details?.cached_tokens)
  );
  const cacheWriteTokens = Math.min(
    promptTokens - cachedTokens,
    finiteTokenCount(usage?.cacheWriteTokens ?? usage?.prompt_tokens_details?.cache_write_tokens)
  );

  return {
    promptTokens,
    cachedTokens,
    cacheWriteTokens,
    completionTokens,
    totalTokens: finiteTokenCount(usage?.totalTokens ?? usage?.total_tokens)
      || Math.min(Number.MAX_SAFE_INTEGER, promptTokens + completionTokens),
  };
}

export function estimateCorrectionCostUsd(model, usage) {
  const pricing = CORRECTION_MODEL_PRICING[model];
  if (!pricing) return null;

  const { promptTokens, cachedTokens, cacheWriteTokens, completionTokens } = normalizeTokenUsage(usage);
  const uncachedPromptTokens = promptTokens - cachedTokens - cacheWriteTokens;
  // Above 272K, the multipliers apply to the full Luna request, not just its excess.
  const longContext = LONG_CONTEXT_LUNA_MODELS.has(model) && promptTokens > LONG_CONTEXT_PROMPT_THRESHOLD;
  const inputMultiplier = longContext ? 2 : 1;
  const outputMultiplier = longContext ? 1.5 : 1;
  return (
    ((uncachedPromptTokens * pricing.input
      + cachedTokens * pricing.cachedInput
      + cacheWriteTokens * (pricing.cacheWriteInput ?? pricing.input)) * inputMultiplier
      + completionTokens * pricing.output * outputMultiplier)
    / 1_000_000
  );
}
