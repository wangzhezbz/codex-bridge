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

export function normalizeUsage(usage = {}, route = {}) {
  usage = usage && typeof usage === "object" ? usage : {};
  const reportedPromptTokens = tokenNumber(
    usage.prompt_tokens,
    usage.input_tokens,
    usage.promptTokens,
    usage.inputTokens,
    usage.prompt,
  );
  const completionTokens = tokenNumber(
    usage.completion_tokens,
    usage.output_tokens,
    usage.completionTokens,
    usage.outputTokens,
    usage.completion,
  );
  const cacheReadTokens = tokenNumber(
    usage.prompt_cache_hit_tokens,
    usage.cache_read_input_tokens,
    usage.cache_read_tokens,
    usage.prompt_tokens_details?.cached_tokens,
    usage.input_tokens_details?.cached_tokens,
    usage.promptTokensDetails?.cachedTokens,
    usage.inputTokensDetails?.cachedTokens,
    usage.cached_tokens,
    usage.cacheReadTokens,
    usage.cached,
  );
  const modernCacheWriteTokens = optionalTokenNumber(
    usage.input_tokens_details?.cache_write_tokens,
    usage.prompt_tokens_details?.cache_write_tokens,
    usage.inputTokensDetails?.cacheWriteTokens,
    usage.promptTokensDetails?.cacheWriteTokens,
  );
  const cacheCreationTokens = tokenNumber(
    modernCacheWriteTokens,
    usage.cache_creation_input_tokens,
    usage.cache_creation_tokens,
    usage.cache_write_input_tokens,
    usage.cache_write_tokens,
    usage.cacheCreationTokens,
  );
  const cacheMissTokens = optionalTokenNumber(
    usage.prompt_cache_miss_tokens,
    usage.cache_miss_input_tokens,
    usage.cache_miss_tokens,
  );
  // Native Anthropic-style input excludes both cache counters. OpenAI-style
  // prompt/input totals already include them, including nested cache writes.
  const separateCacheInput = usage.prompt_tokens === undefined && usage.promptTokens === undefined &&
    usage.input_tokens_details === undefined && usage.inputTokensDetails === undefined &&
    (usage.input_tokens !== undefined || usage.inputTokens !== undefined) &&
    (usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined ||
      usage.cache_write_input_tokens !== undefined);
  const promptTokens = reportedPromptTokens + (separateCacheInput ? cacheReadTokens + cacheCreationTokens : 0);
  const freshPromptTokens = optionalTokenNumber(
    usage.fresh_prompt_tokens,
    usage.fresh_tokens,
    usage.freshPromptTokens,
    usage.fresh,
    cacheMissTokens,
  ) ?? Math.max(0, promptTokens - cacheReadTokens - cacheCreationTokens);
  const totalTokens = tokenNumber(
    usage.total_tokens,
    usage.totalTokens,
    usage.total,
    promptTokens + completionTokens,
  );
  const cacheWriteRateKind = modernCacheWriteTokens !== undefined
    ? officialOpenAiCacheWriteRoute(route) ? "openai" : "input"
    : usage.cache_write_rate_kind;
  return {
    prompt_tokens: promptTokens,
    fresh_prompt_tokens: freshPromptTokens,
    cache_read_tokens: cacheReadTokens,
    cache_creation_tokens: cacheCreationTokens,
    cache_miss_tokens: cacheMissTokens ?? 0,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    ...(["openai", "input"].includes(cacheWriteRateKind) ? { cache_write_rate_kind: cacheWriteRateKind } : {}),
  };
}

function officialOpenAiCacheWriteRoute(route = {}) {
  if (route.authMode === "codex_openai" || !/^gpt-(?:5\.6(?:[-.]|$)|6-astra(?:-|$))/i.test(String(route.model || ""))) {
    return false;
  }
  try {
    return new URL(route.baseUrl).origin === "https://api.openai.com";
  } catch {
    return false;
  }
}

function tokenNumber(...values) {
  return optionalTokenNumber(...values) ?? 0;
}

function optionalTokenNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) {
      return number;
    }
  }
  return undefined;
}
