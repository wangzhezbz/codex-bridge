import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { getEventListeners } from "node:events";
import test from "node:test";

for (const timeoutMs of [0, 2_147_483_647, 2_147_483_648, Number.MAX_SAFE_INTEGER]) {
  for (const mode of ["request", "proxy-header", "idle", "drain"]) {
    test(`real ${mode} timer lets a short operation complete with configured timeout ${timeoutMs}`, () => {
      const lifecycleUrl = new URL("../src/upstream-request-lifecycle.js", import.meta.url).href;
      const guardUrl = new URL("../src/upstream-response-guard.js", import.meta.url).href;
      const script = `
        import assert from "node:assert/strict";
        import { Writable } from "node:stream";
        import { setTimeout as delay } from "node:timers/promises";
        import { createUpstreamRequestLifecycle, streamingProxyFetchOptions } from ${JSON.stringify(lifecycleUrl)};
        import { readUpstreamText, writeResponseChunk } from ${JSON.stringify(guardUrl)};
        const mode = ${JSON.stringify(mode)};
        const timeoutMs = ${timeoutMs};
        if (mode === "request" || mode === "proxy-header") {
          const options = mode === "request"
            ? { timeoutMs }
            : streamingProxyFetchOptions({}, {
                streamingResponse: true, timeoutMs: 0, proxyHeaderTimeoutMs: timeoutMs,
              }, true);
          const lifecycle = createUpstreamRequestLifecycle({}, "https://provider.example", {}, options);
          try {
            await delay(25);
            assert.equal(lifecycle.init.signal.aborted, false, "a long timeout aborted a short request");
            assert.equal(lifecycle.timedOut(), false);
          } finally {
            lifecycle.cleanup();
          }
        } else if (mode === "idle") {
          let timer;
          const response = new Response(new ReadableStream({
            start(controller) {
              timer = setTimeout(() => {
                controller.enqueue(Buffer.from("stream-result"));
                controller.close();
              }, 25);
            },
            cancel() { clearTimeout(timer); },
          }));
          try {
            assert.equal(await readUpstreamText(response, {}, {}, "https://provider.example", {
              responseIdleTimeoutMs: timeoutMs,
            }), "stream-result");
            assert.equal(response.body.locked, false);
          } finally {
            clearTimeout(timer);
          }
        } else {
          let written = "";
          const sink = new Writable({
            highWaterMark: 1,
            write(chunk, _encoding, callback) {
              written += chunk.toString();
              setTimeout(callback, 25);
            },
          });
          sink.on("error", () => {});
          try {
            await writeResponseChunk(sink, Buffer.from("stream-result"), {
              downstreamDrainTimeoutMs: timeoutMs,
            });
            assert.equal(written, "stream-result");
            assert.equal(sink.destroyed, false, "a long timeout destroyed a draining client");
            assert.equal(sink.listenerCount("drain"), 0);
          } finally {
            sink.destroy();
          }
        }
        console.log("timeout-operation-completed");
      `;
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
        encoding: "utf8", timeout: 10_000, windowsHide: true,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, `${mode} failed:\n${result.stderr}`);
      assert.match(result.stdout, /timeout-operation-completed/);
      assert.doesNotMatch(result.stderr, /TimeoutOverflowWarning/);
    });
  }
}

async function settleLifecycleOperation(operation) {
  let deadline;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        deadline = setTimeout(() => {
          reject(new Error("Upstream lifecycle operation did not settle."));
        }, 1_000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

test("upstream timeout normalization preserves aliases, precedence, disabled values, and native timer bounds", async () => {
  const { upstreamTimeoutMs, streamingProxyFetchOptions } = await import("../src/upstream-request-lifecycle.js");
  const { upstreamResponseIdleTimeoutMs } = await import("../src/upstream-response-guard.js");
  const cases = [
    { route: {}, options: {}, want: 600_000 },
    { route: { upstreamTimeoutMs: 1234.9 }, options: {}, want: 1234 },
    { route: { upstream_timeout_ms: "321.8" }, options: {}, want: 321 },
    { route: { requestTimeoutMs: Number.MAX_SAFE_INTEGER }, options: {}, want: 2_147_483_647 },
    { route: { request_timeout_ms: 2_147_483_648 }, options: {}, want: 2_147_483_647 },
    { route: { upstreamTimeoutMs: 4000 }, options: { timeoutMs: 0 }, want: 0 },
    { route: {}, options: { timeoutMs: -1 }, want: 600_000 },
    { route: {}, options: { timeoutMs: Infinity }, want: 600_000 },
    { route: {}, options: { timeoutMs: "750" }, want: 750 },
    { route: {}, options: { timeoutMs: 0.75 }, want: 0 },
  ];
  for (const { route, options, want } of cases) assert.equal(upstreamTimeoutMs(route, options), want);
  assert.equal(upstreamResponseIdleTimeoutMs({ upstreamResponseIdleTimeoutMs: 2_147_483_648 }), 2_147_483_647);
  assert.equal(upstreamResponseIdleTimeoutMs({ upstream_response_idle_timeout_ms: "125.8" }), 125);
  assert.equal(upstreamResponseIdleTimeoutMs({ upstreamResponseIdleTimeoutMs: 50 }, { responseIdleTimeoutMs: 0 }), 0);
  assert.equal(upstreamResponseIdleTimeoutMs({}, { responseIdleTimeoutMs: Infinity }), 600_000);
  const headerOptions = { streamingResponse: true, timeoutMs: 0, proxyHeaderTimeoutMs: Number.MAX_SAFE_INTEGER };
  assert.equal(streamingProxyFetchOptions({}, headerOptions, true).timeoutMs, 2_147_483_647);
  assert.equal(streamingProxyFetchOptions({}, { ...headerOptions, proxyHeaderTimeoutMs: 0 }, true).timeoutMs, 600_000);
  assert.equal(streamingProxyFetchOptions({}, { ...headerOptions, timeoutMs: 2000 }, true).timeoutMs, 2000);
  assert.equal(streamingProxyFetchOptions({}, headerOptions, false), headerOptions);
});

async function callWithResponse(t, response, clientSignal, options = {}) {
  const { callJsonUpstream } = await import("../src/upstream.js");
  t.mock.method(globalThis, "fetch", async () => response);
  return callJsonUpstream(
    "http://127.0.0.1:1/lifecycle-fixture",
    { id: "lifecycle-fixture", api: "images", model: "fixture", apiKey: "test-only" },
    { model: "fixture" },
    { clientSignal },
    { timeoutMs: 0, responseIdleTimeoutMs: 0, ...options },
  );
}

test("standalone upstream request lifecycle maps its deadline to a timeout error", async () => {
  const {
    createUpstreamRequestLifecycle,
  } = await import("../src/upstream-request-lifecycle.js");
  const lifecycle = createUpstreamRequestLifecycle(
    {},
    "https://provider.example/v1/responses?key=secret",
    { id: "lifecycle-test" },
    { timeoutMs: 10 },
  );
  let guardTimeout = null;

  try {
    await Promise.race([
      new Promise((resolve) => {
        lifecycle.init.signal.addEventListener("abort", resolve, { once: true });
      }),
      new Promise((_, reject) => {
        guardTimeout = setTimeout(
          () => reject(new Error("Lifecycle did not abort within the test deadline.")),
          250,
        );
      }),
    ]);

    const error = lifecycle.errorFor(lifecycle.init.signal.reason);
    assert.equal(error.name, "UpstreamTimeoutError");
    assert.equal(error.code, "upstream_timeout");
    assert.equal(error.timeoutMs, 10);
    assert.equal(error.message.includes("key=secret"), false);
  } finally {
    if (guardTimeout) {
      clearTimeout(guardTimeout);
    }
    lifecycle.cleanup();
  }
});

test("upstream response cancellation releases lifecycle listeners and the source reader before cleanup settles", async (t) => {
  const client = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from("12345"));
    },
    cancel() {
      cancelled = true;
      return new Promise(() => {});
    },
  }), { headers: { "content-length": "5" } });

  await assert.rejects(
    settleLifecycleOperation(callWithResponse(t, response, client.signal, {
      maxResponseBytes: 4,
    })),
    (error) => error?.code === "upstream_response_too_large",
  );

  assert.equal(cancelled, true);
  assert.deepEqual({
    abortListeners: getEventListeners(client.signal, "abort").length,
    sourceBodyLocked: response.body.locked,
  }, { abortListeners: 0, sourceBodyLocked: false });
});

test("successful upstream EOF releases the source reader and lifecycle listeners", async (t) => {
  const client = new AbortController();
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('{"ok":'));
      controller.enqueue(Buffer.from("true}"));
      controller.close();
    },
  }), { headers: { "content-type": "application/json" } });

  assert.deepEqual(
    await settleLifecycleOperation(callWithResponse(t, response, client.signal)),
    { ok: true },
  );
  assert.deepEqual({
    abortListeners: getEventListeners(client.signal, "abort").length,
    sourceBodyLocked: response.body.locked,
  }, { abortListeners: 0, sourceBodyLocked: false });
});

test("upstream source errors release the reader while preserving the original failure", async (t) => {
  const client = new AbortController();
  const sourceError = new Error("source read failed");
  const response = new Response(new ReadableStream({
    pull(controller) {
      controller.error(sourceError);
    },
  }));

  await assert.rejects(
    settleLifecycleOperation(callWithResponse(t, response, client.signal)),
    (error) => error === sourceError,
  );
  assert.deepEqual({
    abortListeners: getEventListeners(client.signal, "abort").length,
    sourceBodyLocked: response.body.locked,
  }, { abortListeners: 0, sourceBodyLocked: false });
});

test("cancelling a pending upstream pull does not close or error its already closed controller", async (t) => {
  const client = new AbortController();
  let cancelled = false;
  let sourcePullStarted = false;
  const lateControllerOperations = [];
  for (const method of ["close", "error"]) {
    const originalMethod = ReadableStreamDefaultController.prototype[method];
    t.mock.method(ReadableStreamDefaultController.prototype, method, function (...args) {
      if (cancelled) lateControllerOperations.push(method);
      return Reflect.apply(originalMethod, this, args);
    });
  }
  const response = new Response(new ReadableStream({
    pull() {
      sourcePullStarted = true;
      return new Promise(() => {});
    },
    cancel() {
      cancelled = true;
      return new Promise(() => {});
    },
  }), { headers: { "content-length": "5" } });

  await assert.rejects(
    settleLifecycleOperation(callWithResponse(t, response, client.signal, {
      maxResponseBytes: 4,
    })),
    (error) => error?.code === "upstream_response_too_large",
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sourcePullStarted, true);
  assert.equal(cancelled, true);
  assert.deepEqual(lateControllerOperations, []);
  assert.equal(response.body.locked, false);
});

test("a late upstream cancellation failure cannot retain the lifecycle or replace overflow", async (t) => {
  const client = new AbortController();
  let rejectCancellation;
  const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from("12345"));
    },
    cancel() {
      return cancellation;
    },
  }), { headers: { "content-length": "5" } });

  try {
    await assert.rejects(
      settleLifecycleOperation(callWithResponse(t, response, client.signal, {
        maxResponseBytes: 4,
      })),
      (error) => error?.code === "upstream_response_too_large",
    );
    assert.deepEqual({
      abortListeners: getEventListeners(client.signal, "abort").length,
      sourceBodyLocked: response.body.locked,
    }, { abortListeners: 0, sourceBodyLocked: false });
  } finally {
    rejectCancellation(new Error("transport cancellation failed later"));
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test("an upstream idle timeout releases a pending source reader even when cancellation never settles", async (t) => {
  const client = new AbortController();
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
    settleLifecycleOperation(callWithResponse(t, response, client.signal, {
      responseIdleTimeoutMs: 20,
    })),
    (error) => {
      assert.equal(error?.code, "upstream_timeout");
      assert.equal(cancellationReason, error);
      return true;
    },
  );
  assert.deepEqual({
    abortListeners: getEventListeners(client.signal, "abort").length,
    sourceBodyLocked: response.body.locked,
  }, { abortListeners: 0, sourceBodyLocked: false });
});
