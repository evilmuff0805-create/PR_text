// OpenAI standard processing prices as of 2026-07-11, in USD per 1M tokens.
export const CORRECTION_MODEL_PRICING = {
  'gpt-4o': { input: 2.5, cachedInput: 1.25, output: 10 },
  'gpt-5.6-luna': { input: 1, cachedInput: 0.1, output: 6 },
};

function finiteTokenCount(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function normalizeTokenUsage(usage) {
  const promptTokens = finiteTokenCount(usage?.promptTokens ?? usage?.prompt_tokens);
  const completionTokens = finiteTokenCount(usage?.completionTokens ?? usage?.completion_tokens);
  const cachedTokens = Math.min(
    promptTokens,
    finiteTokenCount(usage?.cachedTokens ?? usage?.prompt_tokens_details?.cached_tokens)
  );

  return {
    promptTokens,
    cachedTokens,
    completionTokens,
    totalTokens: finiteTokenCount(usage?.totalTokens ?? usage?.total_tokens) || promptTokens + completionTokens,
  };
}

export function estimateCorrectionCostUsd(model, usage) {
  const pricing = CORRECTION_MODEL_PRICING[model];
  if (!pricing) return null;

  const { promptTokens, cachedTokens, completionTokens } = normalizeTokenUsage(usage);
  const uncachedPromptTokens = Math.max(promptTokens - cachedTokens, 0);
  return (
    (uncachedPromptTokens * pricing.input
      + cachedTokens * pricing.cachedInput
      + completionTokens * pricing.output)
    / 1_000_000
  );
}
