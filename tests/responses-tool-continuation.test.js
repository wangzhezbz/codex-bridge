import assert from "node:assert/strict";
import test from "node:test";

test("response input normalization preserves arrays and wraps scalar items", async () => {
  const { responseInputItems } = await import(
    "../src/responses-tool-continuation.js"
  );
  const items = [{ type: "message", role: "user", content: "continue" }];

  assert.deepEqual(responseInputItems(), []);
  assert.deepEqual(responseInputItems(null), []);
  assert.equal(responseInputItems(items), items);
  assert.deepEqual(responseInputItems(items[0]), items);
});

test("tool output continuation groups collapse adjacent outputs", async () => {
  const { responseToolOutputContinuationGroups } = await import(
    "../src/responses-tool-continuation.js"
  );
  const output = (callId) => ({
    type: "function_call_output",
    call_id: callId,
    output: `result:${callId}`,
  });

  assert.equal(responseToolOutputContinuationGroups(output("single")), 1);
  assert.equal(
    responseToolOutputContinuationGroups([
      output("first"),
      output("adjacent"),
      { type: "message", role: "user", content: "next" },
      output("separate"),
    ]),
    2,
  );
  assert.equal(
    responseToolOutputContinuationGroups([
      { type: "function_call", call_id: "call-1", name: "lookup", arguments: "{}" },
    ]),
    0,
  );
});

test("chat tool continuation turns add stored positive turns to current groups", async () => {
  const { chatToolContinuationTurns } = await import(
    "../src/responses-tool-continuation.js"
  );
  const requestBody = {
    previous_response_id: "resp-previous",
    input: [
      { type: "function_call_output", call_id: "call-1", output: "one" },
      { type: "message", role: "user", content: "again" },
      { type: "function_call_output", call_id: "call-2", output: "two" },
    ],
  };
  const history = {
    getResponseMeta(responseId) {
      assert.equal(responseId, "resp-previous");
      return { toolContinuationTurns: 3 };
    },
  };

  assert.equal(chatToolContinuationTurns(requestBody, history), 5);
});

test("chat tool continuation turns stop before consulting history without outputs", async () => {
  const { chatToolContinuationTurns } = await import(
    "../src/responses-tool-continuation.js"
  );
  const history = {
    getResponseMeta() {
      throw new Error("history must not be read");
    },
  };

  assert.equal(
    chatToolContinuationTurns(
      { input: [{ type: "message", role: "user", content: "ordinary request" }] },
      history,
    ),
    0,
  );
});
