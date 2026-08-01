import { extractUsageFromSse } from "./sse.js";

export function extractResponsesUsage(text) {
  return extractUsageFromSse(text);
}

export function extractUsageObject(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidates = [
    value.usage,
    value.response?.usage,
    value.data?.usage,
    value.result?.usage,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") {
      return candidate;
    }
  }
  return null;
}

export function normalizeUsage(usage = {}) {
  const promptTokens = tokenNumber(
    usage.prompt_tokens,
    usage.input_tokens,
    usage.promptTokens,
    usage.inputTokens,
  );
  const completionTokens = tokenNumber(
    usage.completion_tokens,
    usage.output_tokens,
    usage.completionTokens,
    usage.outputTokens,
  );
  const cacheReadTokens = tokenNumber(
    usage.prompt_cache_hit_tokens,
    usage.cache_read_input_tokens,
    usage.cache_read_tokens,
    usage.prompt_tokens_details?.cached_tokens,
    usage.input_tokens_details?.cached_tokens,
    usage.promptTokensDetails?.cachedTokens,
    usage.inputTokensDetails?.cachedTokens,
  );
  const cacheCreationTokens = tokenNumber(
    usage.cache_creation_input_tokens,
    usage.cache_creation_tokens,
    usage.cache_write_input_tokens,
    usage.cache_write_tokens,
  );
  const cacheMissTokens = tokenNumber(
    usage.prompt_cache_miss_tokens,
    usage.cache_miss_input_tokens,
    usage.cache_miss_tokens,
  );
  const freshPromptTokens =
    cacheMissTokens > 0
      ? cacheMissTokens
      : Math.max(0, promptTokens - cacheReadTokens);
  const totalTokens = tokenNumber(
    usage.total_tokens,
    usage.totalTokens,
    promptTokens + completionTokens,
  );
  return {
    prompt_tokens: promptTokens,
    fresh_prompt_tokens: freshPromptTokens,
    cache_read_tokens: cacheReadTokens,
    cache_creation_tokens: cacheCreationTokens,
    cache_miss_tokens: cacheMissTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

function tokenNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) {
      return number;
    }
  }
  return 0;
}
