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
