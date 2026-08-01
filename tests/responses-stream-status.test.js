import assert from "node:assert/strict";
import test from "node:test";

test("Responses terminal classification recognizes DONE and named terminal events", async () => {
  const { responsesTerminalKind } = await import("../src/responses-stream-status.js");

  assert.equal(responsesTerminalKind("data: [DONE]\n\n"), "done");
  for (const type of [
    "response.completed",
    "response.failed",
    "response.incomplete",
    "response.cancelled",
  ]) {
    assert.equal(
      responsesTerminalKind(`event: ${type}\ndata: {"type":"response.output_text.delta"}\n\n`),
      type,
    );
  }
});

test("Responses terminal classification falls back to the JSON payload type", async () => {
  const { responsesTerminalKind } = await import("../src/responses-stream-status.js");

  assert.equal(
    responsesTerminalKind('data: {"type":"response.failed"}\n\n'),
    "response.failed",
  );
  assert.equal(
    responsesTerminalKind(
      'event: response.output_text.delta\ndata: {"type":"response.completed"}\n\n',
    ),
    "",
  );
});

test("Responses terminal classification ignores malformed and non-terminal events", async () => {
  const { responsesTerminalKind } = await import("../src/responses-stream-status.js");

  assert.equal(responsesTerminalKind(), "");
  assert.equal(responsesTerminalKind("data: not-json\n\n"), "");
  assert.equal(
    responsesTerminalKind('event: response.output_text.delta\ndata: {"delta":"partial"}\n\n'),
    "",
  );
});

test("only matching non-success Responses terminals pass through", async () => {
  const { isPassThroughNonSuccessTerminal } = await import(
    "../src/responses-stream-status.js"
  );

  for (const [kind, status] of [
    ["response.failed", "failed"],
    ["response.incomplete", "incomplete"],
    ["response.cancelled", "cancelled"],
  ]) {
    assert.equal(
      isPassThroughNonSuccessTerminal(kind, {
        id: `resp_${status}`,
        status: status.toUpperCase(),
      }),
      true,
    );
  }

  assert.equal(
    isPassThroughNonSuccessTerminal("response.completed", {
      id: "resp_completed",
      status: "completed",
    }),
    false,
  );
  assert.equal(
    isPassThroughNonSuccessTerminal("response.failed", {
      id: "resp_mismatch",
      status: "incomplete",
    }),
    false,
  );
  assert.equal(
    isPassThroughNonSuccessTerminal("response.failed", {
      id: "resp_id_only",
    }),
    false,
  );
});
