import assert from "node:assert/strict";
import test from "node:test";

test("terminal text buffering preserves append order", async () => {
  const {
    appendTerminalText,
    createTextBuffer,
    textBufferValue,
  } = await import("../src/responses-stream-text.js");
  const state = createTextBuffer();

  appendTerminalText(state, "event: response.completed\n");
  appendTerminalText(state, "data: done\n\n");

  assert.equal(
    textBufferValue(state),
    "event: response.completed\ndata: done\n\n",
  );
});

test("terminal text buffering enforces UTF-8 bytes at the exact boundary", async () => {
  const {
    appendTerminalText,
    createTextBuffer,
    textBufferValue,
  } = await import("../src/responses-stream-text.js");
  const state = createTextBuffer({ maxBytes: 4 });

  appendTerminalText(state, "你");
  appendTerminalText(state, "a");
  assert.equal(textBufferValue(state), "你a");

  assert.throws(
    () => appendTerminalText(state, "b"),
    (error) => {
      assert.equal(error.name, "UpstreamResponseTooLargeError");
      assert.equal(error.statusCode, 502);
      assert.equal(error.code, "upstream_response_too_large");
      assert.equal(error.limitBytes, 4);
      assert.equal(error.actualBytes, 5);
      assert.equal(error.localHistoryError, undefined);
      return true;
    },
  );
  assert.equal(textBufferValue(state), "你a");
});

test("diagnostic tail keeps content within its character limit", async () => {
  const { appendDiagnosticTail } = await import("../src/responses-stream-text.js");

  assert.equal(appendDiagnosticTail("ab", "cd", { maxChars: 5 }), "abcd");
});

test("diagnostic tail drops only the oldest characters after overflow", async () => {
  const { appendDiagnosticTail } = await import("../src/responses-stream-text.js");

  assert.equal(appendDiagnosticTail("abc", "def", { maxChars: 5 }), "bcdef");
});
