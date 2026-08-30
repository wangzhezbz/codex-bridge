import assert from "node:assert/strict";
import test from "node:test";

test("event-stream detection accepts case-insensitive content types with parameters", async () => {
  const { responseUsesEventStream } = await import("../src/responses-stream-policy.js");
  const response = new Response("", {
    headers: { "content-type": "Text/Event-Stream; Charset=UTF-8" },
  });

  assert.equal(responseUsesEventStream(response), true);
});

test("event-stream detection rejects missing and non-SSE content types", async () => {
  const { responseUsesEventStream } = await import("../src/responses-stream-policy.js");

  assert.equal(responseUsesEventStream(new Response("{}", {
    headers: { "content-type": "application/json" },
  })), false);
  assert.equal(responseUsesEventStream({}), false);
});

test("forced stream aggregation applies to non-stream Responses clients on subscription routes", async () => {
  const { shouldAggregateForcedResponsesStream } = await import(
    "../src/responses-stream-policy.js"
  );
  const route = { api: "responses", authMode: "codex_openai" };

  assert.equal(
    shouldAggregateForcedResponsesStream({ stream: false }, { stream: true }, route),
    true,
  );
  assert.equal(
    shouldAggregateForcedResponsesStream({}, { stream: true }, route),
    true,
  );
});

test("forced stream aggregation rejects each incompatible contract", async () => {
  const { shouldAggregateForcedResponsesStream } = await import(
    "../src/responses-stream-policy.js"
  );

  assert.equal(shouldAggregateForcedResponsesStream(
    { stream: true },
    { stream: true },
    { api: "responses", authMode: "codex_openai" },
  ), false);
  assert.equal(shouldAggregateForcedResponsesStream(
    { stream: false },
    { stream: false },
    { api: "responses", authMode: "codex_openai" },
  ), false);
  assert.equal(shouldAggregateForcedResponsesStream(
    { stream: false },
    { stream: true },
    { api: "chat_completions", authMode: "codex_openai" },
  ), false);
  assert.equal(shouldAggregateForcedResponsesStream(
    { stream: false },
    { stream: true },
    { api: "responses", authMode: "api_key" },
  ), false);
});

test("SSE shape detection recognizes leading and embedded SSE field lines", async () => {
  const { looksLikeSseResponse } = await import("../src/responses-stream-policy.js");

  assert.equal(looksLikeSseResponse("  data: [DONE]\n\n"), true);
  assert.equal(looksLikeSseResponse("event: response.created\ndata: {}\n\n"), true);
  assert.equal(looksLikeSseResponse(": keep-alive\n\n"), true);
  assert.equal(looksLikeSseResponse("gateway-prefix\n: keep-alive\n"), true);
  assert.equal(looksLikeSseResponse("gateway-prefix\nevent: response.failed\n"), true);
});

test("SSE shape detection rejects ordinary JSON and inline field words", async () => {
  const { looksLikeSseResponse } = await import("../src/responses-stream-policy.js");

  assert.equal(looksLikeSseResponse(), false);
  assert.equal(looksLikeSseResponse('{"data":"not an SSE field"}'), false);
  assert.equal(looksLikeSseResponse("prefix data: still inline"), false);
});
