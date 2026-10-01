import assert from "node:assert/strict";
import test from "node:test";

test("usage extraction prefers the direct response usage object", async () => {
  const { extractUsageObject } = await import("../src/upstream-usage.js");

  assert.deepEqual(
    extractUsageObject({
      usage: { input_tokens: 11 },
      response: { usage: { input_tokens: 22 } },
      data: { usage: { input_tokens: 33 } },
      result: { usage: { input_tokens: 44 } },
    }),
    { input_tokens: 11 },
  );
});

test("Responses usage separates cached input from fresh input", async () => {
  const { normalizeUsage } = await import("../src/upstream-usage.js");

  assert.deepEqual(
    normalizeUsage({
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 150,
      input_tokens_details: { cached_tokens: 90 },
    }),
    {
      prompt_tokens: 120,
      fresh_prompt_tokens: 30,
      cache_read_tokens: 90,
      cache_creation_tokens: 0,
      cache_miss_tokens: 0,
      completion_tokens: 30,
      total_tokens: 150,
    },
  );
});

test("explicit cache miss tokens take precedence over derived fresh input", async () => {
  const { normalizeUsage } = await import("../src/upstream-usage.js");

  assert.deepEqual(
    normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 7,
      prompt_cache_hit_tokens: 30,
      prompt_cache_miss_tokens: 60,
      cache_creation_input_tokens: 10,
    }),
    {
      prompt_tokens: 100,
      fresh_prompt_tokens: 60,
      cache_read_tokens: 30,
      cache_creation_tokens: 10,
      cache_miss_tokens: 60,
      completion_tokens: 7,
      total_tokens: 107,
    },
  );
});

test("camelCase usage fields derive total tokens when the provider omits them", async () => {
  const { normalizeUsage } = await import("../src/upstream-usage.js");

  assert.deepEqual(
    normalizeUsage({
      promptTokens: 8,
      completionTokens: 5,
      promptTokensDetails: { cachedTokens: 3 },
    }),
    {
      prompt_tokens: 8,
      fresh_prompt_tokens: 5,
      cache_read_tokens: 3,
      cache_creation_tokens: 0,
      cache_miss_tokens: 0,
      completion_tokens: 5,
      total_tokens: 13,
    },
  );
});

test("Responses and Chat usage split nested cache writes from ordinary input", async () => {
  const { normalizeUsage } = await import("../src/upstream-usage.js");
  const cases = [
    {
      input_tokens: 100_000,
      output_tokens: 25,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 100_000 },
      expectedFresh: 0,
      expectedRead: 0,
      expectedWrite: 100_000,
    },
    {
      prompt_tokens: 100_000,
      completion_tokens: 25,
      prompt_tokens_details: { cached_tokens: 20_000, cache_write_tokens: 30_000 },
      expectedFresh: 50_000,
      expectedRead: 20_000,
      expectedWrite: 30_000,
    },
    {
      inputTokens: 100_000,
      outputTokens: 25,
      inputTokensDetails: { cachedTokens: 20_000, cacheWriteTokens: 30_000 },
      expectedFresh: 50_000,
      expectedRead: 20_000,
      expectedWrite: 30_000,
    },
  ];
  for (const { expectedFresh, expectedRead, expectedWrite, ...raw } of cases) {
    const usage = normalizeUsage(raw);
    assert.equal(usage.prompt_tokens, 100_000);
    assert.equal(usage.fresh_prompt_tokens, expectedFresh);
    assert.equal(usage.cache_read_tokens, expectedRead);
    assert.equal(usage.cache_creation_tokens, expectedWrite);
    assert.equal(usage.total_tokens, 100_025);
  }
});

test("native Anthropic cache counters are additional to ordinary input", async () => {
  const { normalizeUsage } = await import("../src/upstream-usage.js");
  assert.deepEqual(normalizeUsage({
    input_tokens: 10,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 30,
    output_tokens: 5,
  }), {
    prompt_tokens: 60,
    fresh_prompt_tokens: 10,
    cache_read_tokens: 20,
    cache_creation_tokens: 30,
    cache_miss_tokens: 0,
    completion_tokens: 5,
    total_tokens: 65,
  });
});

test("modern write pricing provenance is restricted to known official API models", async () => {
  const { normalizeUsage } = await import("../src/upstream-usage.js");
  const raw = { input_tokens: 100, input_tokens_details: { cache_write_tokens: 100 } };
  const cases = [
    [{ model: "gpt-6-astra", baseUrl: "https://api.openai.com/v1", authMode: "api_key" }, "openai"],
    [{ model: "gpt-5.6-sol", baseUrl: "https://api.openai.com/v1" }, "openai"],
    [{ model: "gpt-5.6-terra", baseUrl: "https://api.openai.com/v1" }, "openai"],
    [{ model: "gpt-5.6-luna", baseUrl: "https://api.openai.com/v1" }, "openai"],
    [{ model: "gpt-5.5", baseUrl: "https://api.openai.com/v1" }, "input"],
    [{ model: "gpt-6-astra", baseUrl: "https://proxy.example/v1", provider: "openai" }, "input"],
    [{ model: "gpt-6-astra", baseUrl: "https://api.openai.com.example/v1" }, "input"],
    [{ model: "gpt-6-astra", baseUrl: "https://api.openai.com/v1", authMode: "codex_openai" }, "input"],
    [{}, "input"],
  ];
  for (const [route, expected] of cases) {
    const normalized = normalizeUsage(raw, route);
    assert.equal(normalized.cache_write_rate_kind, expected, JSON.stringify(route));
    assert.deepEqual(normalizeUsage(normalized, route), normalized);
  }
  assert.equal(normalizeUsage({
    input_tokens: 100,
    input_tokens_details: { cache_write_tokens: 0 },
  }).cache_write_rate_kind, "input");
  assert.equal(normalizeUsage({ prompt_tokens: 100, cache_creation_tokens: 100 }).cache_write_rate_kind, undefined);
});

test("explicit zero fresh or cache-miss counts do not fall back to prompt input", async () => {
  const { normalizeUsage } = await import("../src/upstream-usage.js");
  assert.equal(normalizeUsage({
    prompt_tokens: 100,
    prompt_cache_miss_tokens: 0,
    prompt_cache_hit_tokens: 70,
    cache_creation_tokens: 30,
  }).fresh_prompt_tokens, 0);
  assert.equal(normalizeUsage({
    prompt_tokens: 100,
    fresh_prompt_tokens: 0,
    cache_read_tokens: 70,
    cache_creation_tokens: 30,
  }).fresh_prompt_tokens, 0);
});

test("Responses SSE usage extraction returns the completed event usage", async () => {
  const { extractResponsesUsage } = await import("../src/upstream-usage.js");
  const stream = [
    "event: response.created",
    'data: {"type":"response.created","response":{"id":"resp_usage","status":"in_progress"}}',
    "",
    "event: response.completed",
    'data: {"type":"response.completed","response":{"id":"resp_usage","status":"completed","usage":{"input_tokens":12,"output_tokens":4,"total_tokens":16}}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  assert.deepEqual(extractResponsesUsage(stream), {
    input_tokens: 12,
    output_tokens: 4,
    total_tokens: 16,
  });
});
