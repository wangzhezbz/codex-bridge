import assert from "node:assert/strict";
import test from "node:test";

test("SSE block accumulation emits complete LF blocks and retains the unfinished tail", async () => {
  const {
    createSseBlockAccumulator,
    finishSseBlockAccumulator,
    takeCompleteSseBlocks,
  } = await import("../src/responses-sse-blocks.js");
  const state = createSseBlockAccumulator();

  assert.deepEqual(
    takeCompleteSseBlocks(
      state,
      Buffer.from("event: first\ndata: one\n\nevent: second\ndata: two"),
    ),
    ["event: first\ndata: one\n\n"],
  );
  assert.equal(finishSseBlockAccumulator(state), "event: second\ndata: two");
  assert.equal(finishSseBlockAccumulator(state), "");
});

test("SSE block accumulation recognizes CRLF and bare CR separators split across chunks", async () => {
  const {
    createSseBlockAccumulator,
    finishSseBlockAccumulator,
    takeCompleteSseBlocks,
  } = await import("../src/responses-sse-blocks.js");
  const state = createSseBlockAccumulator();
  const blocks = [];

  for (const piece of [
    "event: crlf\r\ndata: one\r",
    "\n\r",
    "\nevent: cr\rdata: two\r",
    "\rremaining",
  ]) {
    blocks.push(...takeCompleteSseBlocks(state, Buffer.from(piece)));
  }

  assert.deepEqual(blocks, [
    "event: crlf\r\ndata: one\r\n\r\n",
    "event: cr\rdata: two\r\r",
  ]);
  assert.equal(finishSseBlockAccumulator(state), "remaining");
});

test("SSE block accumulation preserves UTF-8 characters split between byte chunks", async () => {
  const {
    createSseBlockAccumulator,
    takeCompleteSseBlocks,
  } = await import("../src/responses-sse-blocks.js");
  const state = createSseBlockAccumulator();
  const event = Buffer.from("data: 你好\n\n", "utf8");
  const splitInsideFirstCharacter = Buffer.byteLength("data: ", "utf8") + 1;

  assert.deepEqual(
    takeCompleteSseBlocks(state, event.subarray(0, splitInsideFirstCharacter)),
    [],
  );
  assert.deepEqual(
    takeCompleteSseBlocks(state, event.subarray(splitInsideFirstCharacter)),
    ["data: 你好\n\n"],
  );
});

test("SSE block accumulation enforces its byte limit without rejecting the exact boundary", async () => {
  const {
    createSseBlockAccumulator,
    takeCompleteSseBlocks,
  } = await import("../src/responses-sse-blocks.js");

  const exactState = createSseBlockAccumulator({ maxBytes: 5 });
  assert.deepEqual(takeCompleteSseBlocks(exactState, Buffer.from("abc\n\n")), ["abc\n\n"]);

  const oversizedState = createSseBlockAccumulator({ maxBytes: 5 });
  assert.throws(
    () => takeCompleteSseBlocks(oversizedState, Buffer.from("abcdef")),
    (error) => {
      assert.equal(error.name, "UpstreamResponseTooLargeError");
      assert.equal(error.statusCode, 502);
      assert.equal(error.code, "upstream_response_too_large");
      assert.equal(error.limitBytes, 5);
      assert.equal(error.actualBytes, 6);
      assert.equal(error.localHistoryError, undefined);
      return true;
    },
  );
});
