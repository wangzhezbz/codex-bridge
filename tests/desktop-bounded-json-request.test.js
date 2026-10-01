import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import requestReader from "../desktop/bounded-json-request.cjs";
import boundedLineDecoder from "../desktop/bounded-line-decoder.cjs";

const { readBoundedJsonRequest } = requestReader;
const { createBoundedLineDecoder } = boundedLineDecoder;

test("bounded line decoder rejects an unterminated line before retaining beyond its limit", () => {
  const errors = [];
  const decoder = createBoundedLineDecoder({
    maxLineBytes: 4,
    onError: (error) => errors.push(error),
  });

  assert.equal(decoder.push(Buffer.from("1234")), true);
  assert.equal(decoder.bufferedBytes, 4);
  assert.equal(decoder.push(Buffer.from("5")), false);
  assert.equal(decoder.bufferedBytes, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "bounded_line_too_large");
});

test("bounded line decoder accepts the exact limit and handles split CRLF lines", () => {
  const lines = [];
  const decoder = createBoundedLineDecoder({
    maxLineBytes: 6,
    onLine: (line) => lines.push(line),
  });

  decoder.push(Buffer.from("123456\nalpha\r"));
  decoder.push(Buffer.from("\nbeta"));
  decoder.end();

  assert.deepEqual(lines, ["123456", "alpha", "beta"]);
  assert.equal(decoder.bufferedBytes, 0);
});

test("bounded line decoder stops parsing the current chunk when a callback closes it", () => {
  const lines = [];
  let decoder;
  decoder = createBoundedLineDecoder({
    onLine: (line) => {
      lines.push(line);
      decoder.close();
    },
  });

  assert.equal(decoder.push(Buffer.from("first\nsecond\n")), false);
  assert.deepEqual(lines, ["first"]);
});

test("bounded JSON request parses a complete body and removes every listener", async () => {
  const req = fakeRequest();
  const pending = readBoundedJsonRequest(req);
  req.emit("data", Buffer.from('{"ok":'));
  req.emit("data", Buffer.from("true}"));
  req.emit("end");

  assert.deepEqual(await pending, { ok: true });
  for (const event of ["data", "error", "end", "aborted", "close"]) {
    assert.equal(req.listenerCount(event), 0);
  }
});

test("bounded JSON request rejects and destroys an oversized body", async () => {
  const req = fakeRequest();
  const pending = readBoundedJsonRequest(req, { limitBytes: 4 });
  req.emit("data", Buffer.from("12345"));

  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "local_executor_request_too_large");
    return true;
  });
  assert.equal(req.destroyCalls, 1);
});

for (const event of ["aborted", "close"]) {
  test(`bounded JSON request rejects when the client emits ${event} before end`, async () => {
    const req = fakeRequest();
    const pending = readBoundedJsonRequest(req);
    req.emit("data", Buffer.from("{"));
    req.emit(event);

    await assert.rejects(pending, (error) => {
      assert.equal(error.code, "local_executor_request_aborted");
      return true;
    });
  });
}

test("bounded JSON request timeout rejects, destroys the request, and clears its timer", async () => {
  const req = fakeRequest();
  let fireTimeout;
  let cleared = false;
  const timer = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  const pending = readBoundedJsonRequest(req, {
    timeoutMs: 30_000,
    setTimeoutFn(callback, timeoutMs) {
      assert.equal(timeoutMs, 30_000);
      fireTimeout = callback;
      return timer;
    },
    clearTimeoutFn(value) {
      assert.equal(value, timer);
      cleared = true;
    },
  });

  assert.equal(timer.unrefCalled, true);
  fireTimeout();
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "local_executor_request_timeout");
    return true;
  });
  assert.equal(req.destroyCalls, 1);
  assert.equal(cleared, true);
});

test("bounded JSON request reports invalid JSON without retaining listeners", async () => {
  const req = fakeRequest();
  const pending = readBoundedJsonRequest(req);
  req.emit("data", Buffer.from("{"));
  req.emit("end");
  await assert.rejects(pending, (error) => error.code === "local_executor_invalid_json");
  assert.equal(req.listenerCount("close"), 0);
});

function fakeRequest() {
  const req = new EventEmitter();
  req.destroyed = false;
  req.destroyCalls = 0;
  req.destroy = () => {
    req.destroyed = true;
    req.destroyCalls += 1;
    req.emit("close");
  };
  return req;
}
