import assert from "node:assert/strict";
import test from "node:test";

import { buildCompactResponsesRequest } from "../src/compact.js";

test("subscription compact requests stream and omit the output-token limit", async () => {
  const { responsesCompactRequestOptions } = await import(
    "../src/responses-compact-request-policy.js"
  );

  const options = responsesCompactRequestOptions({ authMode: "codex_openai" });
  const body = buildCompactResponsesRequest({ input: "compact subscription history" }, options);

  assert.deepEqual(options, {
    stream: true,
    omitMaxOutputTokens: true,
  });
  assert.equal(body.stream, true);
  assert.equal(body.max_output_tokens, undefined);
});

test("API-key compact requests stay non-streaming and keep the output-token limit", async () => {
  const { responsesCompactRequestOptions } = await import(
    "../src/responses-compact-request-policy.js"
  );

  const options = responsesCompactRequestOptions({ authMode: "api_key" });
  const body = buildCompactResponsesRequest({ input: "compact API history" }, options);

  assert.deepEqual(options, {
    stream: false,
    omitMaxOutputTokens: false,
  });
  assert.equal(body.stream, false);
  assert.equal(Number.isInteger(body.max_output_tokens), true);
  assert.equal(body.max_output_tokens > 0, true);
});

test("compact request policy defaults routes without subscription auth to API-key behavior", async () => {
  const { responsesCompactRequestOptions } = await import(
    "../src/responses-compact-request-policy.js"
  );

  assert.deepEqual(responsesCompactRequestOptions({}), {
    stream: false,
    omitMaxOutputTokens: false,
  });
});
