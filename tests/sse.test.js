import test from "node:test";
import assert from "node:assert/strict";
import {
  buildResponsesStreamErrorSse,
  extractResponseObjectFromSse,
  extractUsageFromSse,
  parseSseEvents,
  responsesSseStreamComplete,
} from "../src/sse.js";

test("responses SSE parser extracts usage and completed response regardless of DONE", () => {
  const response = {
    id: "resp_p0_3_sse",
    status: "completed",
    output_text: "stream completed",
  };
  const stream = [
    "event: response.usage",
    `data: ${JSON.stringify({
      type: "response.usage",
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
    })}`,
    "",
    "event: response.completed",
    `data: ${JSON.stringify({ type: "response.completed", response })}`,
    "",
  ].join("\n");

  assert.equal(responsesSseStreamComplete(stream), true);
  assert.equal(extractResponseObjectFromSse(stream).id, "resp_p0_3_sse");
  assert.deepEqual(extractUsageFromSse(stream), {
    input_tokens: 3,
    output_tokens: 4,
    total_tokens: 7,
  });
});

test("responses SSE parser treats missing terminal event and DONE as truncated", () => {
  const truncated = [
    "event: response.output_text.delta",
    `data: ${JSON.stringify({
      type: "response.output_text.delta",
      delta: "partial",
    })}`,
    "",
  ].join("\n");

  assert.equal(responsesSseStreamComplete(truncated), false);

  const errorStream = buildResponsesStreamErrorSse(
    "Upstream stream ended before response.completed or [DONE].",
    { model: "gpt-compatible" },
  );
  assert.equal(responsesSseStreamComplete(errorStream), true);
  assert.match(errorStream, /event: response\.failed/);
  assert.match(errorStream, /data: \[DONE\]/);
});

test("SSE parser keeps multiline data payloads intact", () => {
  const events = parseSseEvents("event: note\ndata: first\ndata: second\n\n");
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "note");
  assert.equal(events[0].data, "first\nsecond");
});
