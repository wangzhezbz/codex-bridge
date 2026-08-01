import assert from "node:assert/strict";
import test from "node:test";

test("official Responses objects retain their original identity", async () => {
  const { normalizeResponsesObject } = await import("../src/responses-object.js");
  const response = {
    id: "resp_official",
    object: "response",
    status: "completed",
    output: [],
  };

  assert.equal(normalizeResponsesObject(response), response);
});

test("response-like provider payloads receive the Responses object marker", async () => {
  const { normalizeResponsesObject } = await import("../src/responses-object.js");
  const cases = [
    { input: { id: "resp_status", status: "completed" }, field: "status", value: "completed" },
    { input: { id: "resp_output", output: [] }, field: "output", value: [] },
    { input: { id: "resp_text", output_text: "answer" }, field: "output_text", value: "answer" },
    { input: { id: "resp_usage", usage: { input_tokens: 2 } }, field: "usage", value: { input_tokens: 2 } },
  ];

  for (const { input, field, value } of cases) {
    assert.deepEqual(normalizeResponsesObject(input), {
      object: "response",
      id: input.id,
      [field]: value,
    });
  }
});

test("unidentified or id-only values are not treated as Responses objects", async () => {
  const { normalizeResponsesObject } = await import("../src/responses-object.js");

  for (const value of [null, [], "response", {}, { id: "" }, { id: 42 }, { id: "resp_id_only" }]) {
    assert.equal(normalizeResponsesObject(value), null);
  }
});

test("Responses object detection accepts official and provider-compatible shapes", async () => {
  const { isResponsesObject } = await import("../src/responses-object.js");

  assert.equal(isResponsesObject({ id: "resp_official", object: "response" }), true);
  assert.equal(isResponsesObject({ id: "resp_compatible", output_text: "" }), true);
  assert.equal(isResponsesObject({ id: "resp_unknown" }), false);
});

test("only error-free completed Responses objects pass completion detection", async () => {
  const { isCompletedResponsesObject } = await import("../src/responses-object.js");

  assert.equal(isCompletedResponsesObject({ id: "resp_done", status: "completed" }), true);
  assert.equal(
    isCompletedResponsesObject({
      id: "resp_failed_completion",
      status: "completed",
      error: { code: "upstream_failed" },
    }),
    false,
  );
  assert.equal(isCompletedResponsesObject({ id: "resp_running", status: "in_progress" }), false);
  assert.equal(isCompletedResponsesObject({ id: "resp_upper", status: "COMPLETED" }), false);
});
