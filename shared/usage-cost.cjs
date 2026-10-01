function optionalUsageCostRate(value) {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function normalizeUsageCostRates(input = {}) {
  input = input && typeof input === "object" ? input : {};
  const cacheWriteCostPerMillion = optionalUsageCostRate(
    input.cacheWriteCostPerMillion ?? input.cache_write_cost_per_million,
  );
  return {
    inputCostPerMillion: optionalUsageCostRate(input.inputCostPerMillion ?? input.input_cost_per_million) ?? 0,
    cacheCostPerMillion: optionalUsageCostRate(input.cacheCostPerMillion ?? input.cache_cost_per_million) ?? 0,
    outputCostPerMillion: optionalUsageCostRate(input.outputCostPerMillion ?? input.output_cost_per_million) ?? 0,
    ...(cacheWriteCostPerMillion === undefined ? {} : { cacheWriteCostPerMillion }),
  };
}

function hasUsageCostRates(rates = {}) {
  return Boolean(rates.inputCostPerMillion || rates.cacheCostPerMillion || rates.outputCostPerMillion ||
    rates.cacheWriteCostPerMillion !== undefined);
}

function estimateUsageTokenCosts(metrics = {}, rates = {}) {
  const normalized = normalizeUsageCostRates(rates);
  const inputRate = normalized.inputCostPerMillion;
  // Preserve the legacy read/cache price fallback for existing configurations.
  const cacheRate = normalized.cacheCostPerMillion || inputRate;
  const writes = nonnegativeNumber(metrics.cacheCreationTokens);
  const openaiWrites = Math.min(writes, nonnegativeNumber(metrics.openaiCacheWriteTokens));
  const inputWrites = Math.min(writes - openaiWrites, nonnegativeNumber(metrics.inputCacheWriteTokens));
  const legacyWrites = writes - openaiWrites - inputWrites;
  const inputCost = nonnegativeNumber(metrics.freshPromptTokens) * inputRate / 1_000_000;
  const cacheReadCost = nonnegativeNumber(metrics.cacheReadTokens) * cacheRate / 1_000_000;
  // Only provenance-checked official API writes get this multiplier. These are
  // user-configured flat-rate estimates, not currency prices or context tiers.
  const cacheWriteCost = normalized.cacheWriteCostPerMillion !== undefined
    ? writes * normalized.cacheWriteCostPerMillion / 1_000_000
    : (openaiWrites * inputRate * 1.25 + inputWrites * inputRate + legacyWrites * cacheRate) / 1_000_000;
  const outputCost = nonnegativeNumber(metrics.completionTokens) * normalized.outputCostPerMillion / 1_000_000;
  const cacheCost = cacheReadCost + cacheWriteCost;
  return { inputCost, cacheReadCost, cacheWriteCost, cacheCost, outputCost, totalCost: inputCost + cacheCost + outputCost };
}

function nonnegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

module.exports = { optionalUsageCostRate, normalizeUsageCostRates, hasUsageCostRates, estimateUsageTokenCosts };
