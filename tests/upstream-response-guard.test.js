import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Writable } from "node:stream";
import { getEventListeners } from "node:events";
import boundedResponseBody from "../shared/bounded-response-body.cjs";

const { readBoundedResponseBytes, readBoundedResponseText } = boundedResponseBody;

for (const scenario of [
  { name: "synchronous read fault before idle deadline", timeoutMs: 20 },
  { name: "synchronous read fault before later client abort", timeoutMs: 0, abortAfter: true },
  { name: "synchronous read fault with client abort inside read", timeoutMs: 0, abortInside: true },
  { name: "synchronous read fault with stalled cancellation", timeoutMs: 20, stallCancellation: true },
  { name: "rejected read promise before idle deadline", timeoutMs: 20, promiseRead: true },
  { name: "rejected read promise with client abort inside read", timeoutMs: 0, abortInside: true, promiseRead: true },
]) {
  test(`${scenario.name} releases guards without an unhandled secondary rejection`, () => {
    const moduleUrl = new URL("../src/upstream-response-guard.js", import.meta.url).href;
    const script = `
      import assert from "node:assert/strict";
      import { getEventListeners } from "node:events";
      import { setTimeout as delay } from "node:timers/promises";
      import { readUpstreamText } from ${JSON.stringify(moduleUrl)};
      const scenario = ${JSON.stringify(scenario)};
      const client = new AbortController();
      const sourceError = new Error("fixture source read failed");
      let cancellations = 0;
      let releases = 0;
      const upstream = new Response(new ReadableStream({
        cancel() {
          cancellations++;
          return scenario.stallCancellation ? new Promise(() => {}) : undefined;
        },
      }));
      const nativeGetReader = upstream.body.getReader.bind(upstream.body);
      upstream.body.getReader = () => {
        const reader = nativeGetReader();
        const nativeRelease = reader.releaseLock.bind(reader);
        reader.releaseLock = () => { releases++; nativeRelease(); };
        reader.read = () => {
          if (scenario.abortInside) client.abort(new Error("fixture client left inside read"));
          if (scenario.promiseRead) return Promise.reject(sourceError);
          throw sourceError;
        };
        return reader;
      };
      await assert.rejects(readUpstreamText(upstream, { clientSignal: client.signal }, {}, "", {
        responseIdleTimeoutMs: scenario.timeoutMs,
      }), (error) => error === sourceError);
      console.log(JSON.stringify({
        phase: "source-error-caught",
        abortListeners: getEventListeners(client.signal, "abort").length,
        bodyLocked: upstream.body.locked,
      }));
      if (scenario.abortAfter) client.abort(new Error("fixture client left after read failure"));
      await delay(60);
      assert.equal(getEventListeners(client.signal, "abort").length, 0);
      assert.equal(upstream.body.locked, false);
      assert.equal(cancellations, 1);
      assert.equal(releases, 1);
      console.log("read-failure-cleanup-completed");
    `;
    const result = spawnSync(process.execPath, [
      "--unhandled-rejections=strict", "--input-type=module", "--eval", script,
    ], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `${scenario.name}:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /read-failure-cleanup-completed/);
    assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/u)[0]), {
      phase: "source-error-caught", abortListeners: 0, bodyLocked: false,
    });
  });
}

for (const entry of [
  { name: "request option", route: {}, options: { maxResponseBytes: 0.5 } },
  { name: "route option", route: { maxUpstreamResponseBytes: 0.5 }, options: {} },
  { name: "snake-case route option", route: { max_upstream_response_bytes: 0.5 }, options: {} },
]) {
  test(`sub-byte ${entry.name} cannot disable the upstream body limit`, async () => {
    const { readUpstreamText } = await import("../src/upstream-response-guard.js");
    let cancelled = 0;
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from("fixture"));
        controller.close();
      },
      cancel() { cancelled++; },
    }), { headers: { "content-length": "67108865" } });
    await assert.rejects(readUpstreamText(response, {}, entry.route, "", entry.options), (error) => (
      error?.code === "upstream_response_too_large"
      && error.limitBytes === 67108864 && error.actualBytes === 67108865
    ));
    assert.equal(cancelled, 1);
    assert.equal(response.body.locked, false);
  });
}

test("upstream byte-limit normalization preserves whole-byte values and safe invalid-value defaults", async () => {
  const { upstreamResponseLimitBytes } = await import("../src/upstream-response-guard.js");
  for (const value of [undefined, 0, -1, NaN, Infinity, 0.25, Number.MIN_VALUE]) {
    assert.equal(upstreamResponseLimitBytes({}, { maxResponseBytes: value }), 67108864);
  }
  assert.equal(upstreamResponseLimitBytes({}, { maxResponseBytes: 1.9 }), 1);
  assert.equal(upstreamResponseLimitBytes({ maxUpstreamResponseBytes: "2048.9" }), 2048);
  assert.equal(upstreamResponseLimitBytes({ max_upstream_response_bytes: 4096 }), 4096);
  assert.equal(upstreamResponseLimitBytes({ maxUpstreamResponseBytes: 4096 }, { maxResponseBytes: 1024 }), 1024);
});

test("bounded web body skips a queued read after cancellation and still releases its lock", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled before body read");
  let pulls = 0;
  let cancellations = 0;
  const body = new ReadableStream({
    pull() { pulls += 1; },
    cancel() { cancellations += 1; },
  }, { highWaterMark: 0 });
  const pending = readBoundedResponseBytes({ body }, { maxBytes: 1024, signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(pulls, 0);
  assert.equal(cancellations, 1);
  assert.equal(body.locked, false);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("bounded async body skips queued next after cancellation but destroys and returns the iterator", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled before iterator read");
  let nextCalls = 0;
  let returnCalls = 0;
  let destroys = 0;
  const body = {
    [Symbol.asyncIterator]() { return this; },
    next() { nextCalls += 1; return new Promise(() => {}); },
    return() { returnCalls += 1; return { done: true }; },
    destroy() { destroys += 1; },
  };
  const pending = readBoundedResponseBytes({ body }, { maxBytes: 1024, signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(nextCalls, 0);
  assert.equal(returnCalls, 1);
  assert.equal(destroys, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

for (const method of ["arrayBuffer", "text"]) {
  test(`bounded body does not call queued ${method} after cancellation`, async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before fallback read");
    let calls = 0;
    const bytes = Buffer.from("body");
    const response = {
      [method]() {
        calls += 1;
        return method === "text" ? "body" : Uint8Array.from(bytes).buffer;
      },
    };
    const pending = readBoundedResponseBytes(response, { maxBytes: 1024, signal: controller.signal });
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    assert.equal(calls, 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.deepEqual(await readBoundedResponseBytes(response, {
      maxBytes: 1024, signal: new AbortController().signal,
    }), bytes);
    assert.equal(calls, 1);
  });
}

test("bounded web body still cancels an in-flight read and preserves the abort reason", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled during body read");
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let pulls = 0;
  let cancellationReason;
  const body = new ReadableStream({
    pull() { pulls += 1; markStarted(); },
    cancel(value) { cancellationReason = value; },
  }, { highWaterMark: 0 });
  const pending = readBoundedResponseBytes({ body }, { maxBytes: 1024, signal: controller.signal });
  await started;
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(pulls, 1);
  assert.equal(cancellationReason, reason);
  assert.equal(body.locked, false);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("bounded web body completes a split UTF-8 response without cancelling it", async () => {
  const controller = new AbortController();
  let cancellations = 0;
  const body = new ReadableStream({
    start(stream) {
      stream.enqueue(Buffer.from([0x41, 0xe4]));
      stream.enqueue(Buffer.from([0xb8, 0xad, 0x42]));
      stream.close();
    },
    cancel() { cancellations += 1; },
  });
  assert.equal(await readBoundedResponseText({ body }, {
    maxBytes: 5, signal: controller.signal,
  }), "A中B");
  assert.equal(cancellations, 0);
  assert.equal(body.locked, false);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("a drain deadline destroys the writable even before a client abort signal arrives", async () => {
  const { writeResponseChunk, isClientClosedStreamWrite } = await import("../src/upstream-response-guard.js");
  const res = new Writable({ highWaterMark: 1, write() {} });
  const context = { downstreamDrainTimeoutMs: 10, clientSignal: new AbortController().signal };
  try {
    await assert.rejects(writeResponseChunk(res, "first", context), (error) => {
      assert.equal(error.code, "client_closed_request");
      assert.equal(isClientClosedStreamWrite(context, res, error), true);
      return true;
    });
    assert.equal(res.destroyed, true);
    assert.equal(context.clientSignal.aborted, false);
    for (const event of ["drain", "close", "error"]) assert.equal(res.listenerCount(event), 0);
    assert.equal(isClientClosedStreamWrite(context, res, { code: "client_closed_request" }), false,
      "an arbitrary upstream error code must not be mistaken for the guard's client termination");
  } finally {
    res.destroy();
  }
});

test("a writable that drains successfully is kept open and loses temporary listeners", async () => {
  const { writeResponseChunk } = await import("../src/upstream-response-guard.js");
  let completeWrite;
  const res = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) { completeWrite = callback; } });
  try {
    const pending = writeResponseChunk(res, "first", { downstreamDrainTimeoutMs: 1000 });
    assert.equal(res.listenerCount("drain"), 1);
    completeWrite();
    await pending;
    assert.equal(res.destroyed, false);
    assert.equal(res.writableEnded, false);
    for (const event of ["drain", "close", "error"]) assert.equal(res.listenerCount(event), 0);
  } finally {
    res.destroy();
  }
});

async function settleWithoutWaitingForCancellation(operation) {
  let deadline;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        deadline = setTimeout(() => {
          reject(new Error("Upstream operation is still waiting for cancellation cleanup."));
        }, 1_000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

test("standalone upstream response guard rejects a body above the route byte limit", async () => {
  const {
    readUpstreamText,
    UpstreamResponseTooLargeError,
  } = await import("../src/upstream-response-guard.js");
  const response = new Response("12345", {
    headers: {
      "content-length": "5",
      "content-type": "text/plain; charset=utf-8",
    },
  });

  await assert.rejects(
    () => readUpstreamText(
      response,
      {},
      { id: "guard-test", maxUpstreamResponseBytes: 4 },
      "https://provider.example/v1/responses?key=secret",
    ),
    (error) => {
      assert.ok(error instanceof UpstreamResponseTooLargeError);
      assert.equal(error.code, "upstream_response_too_large");
      assert.equal(error.limitBytes, 4);
      assert.equal(error.actualBytes, 5);
      assert.equal(error.message.includes("key=secret"), false);
      return true;
    },
  );
});

test("upstream response timeout tolerates a non-Promise reader cancel result", async () => {
  const { readUpstreamText } = await import("../src/upstream-response-guard.js");
  let cancelCalls = 0;
  let releaseCalls = 0;
  const reader = {
    read: () => new Promise(() => {}),
    cancel() {
      cancelCalls += 1;
      return undefined;
    },
    releaseLock() {
      releaseCalls += 1;
    },
  };
  const response = {
    headers: { get: () => null },
    body: { getReader: () => reader },
  };
  const startedAt = Date.now();

  await assert.rejects(
    readUpstreamText(response, {}, { id: "cancel-compat" }, "https://provider.example/v1", {
      responseIdleTimeoutMs: 20,
    }),
    (error) => error?.code === "upstream_timeout",
  );
  assert.ok(Date.now() - startedAt < 500);
  assert.ok(cancelCalls >= 1);
  assert.equal(releaseCalls, 1);
});

test("cancelUpstreamResponse does not wait for a stream cancellation that never settles", async () => {
  const { cancelUpstreamResponse } = await import("../src/upstream-response-guard.js");
  let cancelled = false;
  const response = new Response(new ReadableStream({
    cancel() {
      cancelled = true;
      return new Promise(() => {});
    },
  }));

  await settleWithoutWaitingForCancellation(cancelUpstreamResponse(response));

  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});

test("declared upstream overflow rejects even when body cancellation never settles", async () => {
  const { readUpstreamText } = await import("../src/upstream-response-guard.js");
  let cancelled = false;
  const response = new Response(new ReadableStream({
    cancel() {
      cancelled = true;
      return new Promise(() => {});
    },
  }), { headers: { "content-length": "5" } });

  await assert.rejects(
    settleWithoutWaitingForCancellation(readUpstreamText(response, {}, {}, "", {
      maxResponseBytes: 4,
    })),
    (error) => error?.code === "upstream_response_too_large" && error.actualBytes === 5,
  );

  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});

test("streamed upstream overflow releases its reader without waiting for cancellation", async () => {
  const { readUpstreamText } = await import("../src/upstream-response-guard.js");
  let cancellationReason;
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from("12345"));
    },
    cancel(reason) {
      cancellationReason = reason;
      return new Promise(() => {});
    },
  }));

  await assert.rejects(
    settleWithoutWaitingForCancellation(readUpstreamText(response, {}, {}, "", {
      maxResponseBytes: 4,
    })),
    (error) => {
      assert.equal(error?.code, "upstream_response_too_large");
      assert.equal(error.actualBytes, 5);
      assert.equal(cancellationReason, error);
      return true;
    },
  );

  assert.equal(response.body.locked, false);
});

test("upstream idle timeout releases a real stream whose cancellation never settles", async () => {
  const { readUpstreamText } = await import("../src/upstream-response-guard.js");
  let cancellationReason;
  const response = new Response(new ReadableStream({
    pull() {
      return new Promise(() => {});
    },
    cancel(reason) {
      cancellationReason = reason;
      return new Promise(() => {});
    },
  }));

  await assert.rejects(
    settleWithoutWaitingForCancellation(readUpstreamText(response, {}, {}, "", {
      responseIdleTimeoutMs: 20,
    })),
    (error) => {
      assert.equal(error?.code, "upstream_timeout");
      assert.equal(error.timeoutMs, 20);
      assert.equal(cancellationReason, error);
      return true;
    },
  );

  assert.equal(response.body.locked, false);
});

test("an already aborted upstream read cancels the unread response body", async () => {
  const { readUpstreamText } = await import("../src/upstream-response-guard.js");
  const controller = new AbortController();
  controller.abort(new Error("client left before reading"));
  let cancelled = false;
  const response = new Response(new ReadableStream({
    cancel() {
      cancelled = true;
      return new Promise(() => {});
    },
  }));

  await assert.rejects(
    settleWithoutWaitingForCancellation(readUpstreamText(response, {
      clientSignal: controller.signal,
    })),
    (error) => error?.code === "client_closed_request",
  );

  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});

test("client abort during a pending upstream read does not wait for stream cancellation", async () => {
  const { readUpstreamText } = await import("../src/upstream-response-guard.js");
  const controller = new AbortController();
  let readStarted;
  const reading = new Promise((resolve) => { readStarted = resolve; });
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull() {
      readStarted();
      return new Promise(() => {});
    },
    cancel() {
      cancelled = true;
      return new Promise(() => {});
    },
  }));
  const result = readUpstreamText(response, { clientSignal: controller.signal }, {}, "", {
    responseIdleTimeoutMs: 0,
  });
  await reading;
  controller.abort(new Error("client left during read"));

  await assert.rejects(
    settleWithoutWaitingForCancellation(result),
    (error) => error?.code === "client_closed_request",
  );

  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});

test("client abort between upstream chunks rejects before yielding another buffered chunk", async () => {
  const { readUpstreamBody } = await import("../src/upstream-response-guard.js");
  const controller = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(streamController) {
      streamController.enqueue(Buffer.from("first"));
      streamController.enqueue(Buffer.from("second"));
    },
    cancel() {
      cancelled = true;
      return new Promise(() => {});
    },
  }));
  const iterator = readUpstreamBody(response, { clientSignal: controller.signal }, {}, "", {
    responseIdleTimeoutMs: 0,
  });

  try {
    assert.equal((await iterator.next()).value.toString(), "first");
    controller.abort(new Error("client left between chunks"));

    await assert.rejects(
      settleWithoutWaitingForCancellation(iterator.next()),
      (error) => error?.code === "client_closed_request",
    );
    assert.equal(cancelled, true);
    assert.equal(response.body.locked, false);
  } finally {
    void iterator.return().catch(() => {});
  }
});

test("client abort after a read settles rejects instead of yielding the completed chunk", async () => {
  const { readUpstreamBody } = await import("../src/upstream-response-guard.js");
  const controller = new AbortController();
  const response = new Response(new ReadableStream({
    pull(streamController) {
      streamController.enqueue(Buffer.from("arrived during abort"));
      queueMicrotask(() => controller.abort(new Error("client left as read settled")));
    },
    cancel() {
      return new Promise(() => {});
    },
  }));
  const iterator = readUpstreamBody(response, { clientSignal: controller.signal }, {}, "", {
    responseIdleTimeoutMs: 0,
  });

  try {
    await assert.rejects(
      settleWithoutWaitingForCancellation(iterator.next()),
      (error) => error?.code === "client_closed_request",
    );
    assert.equal(response.body.locked, false);
  } finally {
    void iterator.return().catch(() => {});
  }
});

test("ending an upstream iterator releases its lock even when stream cancellation stalls", async () => {
  const { readUpstreamBody } = await import("../src/upstream-response-guard.js");
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from("first"));
    },
    cancel() {
      cancelled = true;
      return new Promise(() => {});
    },
  }));
  const iterator = readUpstreamBody(response);
  assert.equal((await iterator.next()).value.toString(), "first");

  assert.deepEqual(await settleWithoutWaitingForCancellation(iterator.return()), {
    value: undefined,
    done: true,
  });
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});

test("a late stream cancellation failure does not replace the upstream overflow error", async () => {
  const { readUpstreamText } = await import("../src/upstream-response-guard.js");
  let rejectCancellation;
  const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
  let cancellationReason;
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from("12345"));
    },
    cancel(reason) {
      cancellationReason = reason;
      return cancellation;
    },
  }));

  try {
    await assert.rejects(
      settleWithoutWaitingForCancellation(readUpstreamText(response, {}, {}, "", {
        maxResponseBytes: 4,
      })),
      (error) => {
        assert.equal(error?.code, "upstream_response_too_large");
        assert.equal(cancellationReason, error);
        return true;
      },
    );
    assert.equal(response.body.locked, false);
  } finally {
    rejectCancellation(new Error("transport failed after cancellation"));
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test("cancelUpstreamResponse consumes a cancellation rejection delivered after returning", async () => {
  const { cancelUpstreamResponse } = await import("../src/upstream-response-guard.js");
  let rejectCancellation;
  const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
  const response = new Response(new ReadableStream({ cancel: () => cancellation }));

  try {
    await settleWithoutWaitingForCancellation(cancelUpstreamResponse(response));
    assert.equal(response.body.locked, false);
  } finally {
    rejectCancellation(new Error("transport cleanup failed later"));
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test("a throwing stream cancellation preserves the original upstream overflow error", async () => {
  const { readUpstreamText } = await import("../src/upstream-response-guard.js");
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from("12345"));
    },
    cancel() {
      throw new Error("transport cancellation threw");
    },
  }));

  await assert.rejects(
    readUpstreamText(response, {}, {}, "", { maxResponseBytes: 4 }),
    (error) => error?.code === "upstream_response_too_large" && error.actualBytes === 5,
  );
  assert.equal(response.body.locked, false);
});

test("an upstream read failure preserves the source error while releasing the reader", async () => {
  const { readUpstreamText } = await import("../src/upstream-response-guard.js");
  const sourceError = new Error("upstream transport failed during read");
  const response = new Response(new ReadableStream({
    pull(controller) {
      controller.error(sourceError);
    },
  }));

  await assert.rejects(readUpstreamText(response), (error) => error === sourceError);
  assert.equal(response.body.locked, false);
});

test("a completed upstream read keeps all chunks and releases its reader without cancellation", async () => {
  const { readUpstreamText } = await import("../src/upstream-response-guard.js");
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from([0x41, 0xe4]));
      controller.enqueue(Buffer.from([0xb8, 0xad, 0x42]));
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  }));

  assert.equal(await readUpstreamText(response, {}, {}, "", { maxResponseBytes: 5 }), "A中B");
  assert.equal(cancelled, false);
  assert.equal(response.body.locked, false);
});
