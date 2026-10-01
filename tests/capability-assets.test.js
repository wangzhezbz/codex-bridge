import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { fileURLToPath } from "node:url";
import { saveCapabilityAssetResult } from "../src/capability-assets.js";
import networkDeadline from "../shared/network-deadline.cjs";

const { runWithNetworkDeadline } = networkDeadline;

for (const timeoutMs of [2_147_483_647, 2_147_483_648, Number.MAX_SAFE_INTEGER]) {
  test(`network deadline keeps a short operation alive with timeout ${timeoutMs}`, () => {
    const modulePath = fileURLToPath(new URL("../shared/network-deadline.cjs", import.meta.url));
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    delete childEnv.NODE_OPTIONS;
    // Real timers in a separate process catch both premature expiry and
    // overflow warnings without installing global timer or warning mocks.
    const result = spawnSync(process.execPath, ["--input-type=commonjs", "--eval", `
      const assert = require("node:assert/strict");
      const { getEventListeners } = require("node:events");
      const { runWithNetworkDeadline } = require(${JSON.stringify(modulePath)});
      (async () => {
        const parent = new AbortController();
        let operationSignal;
        const value = await runWithNetworkDeadline((signal) => {
          operationSignal = signal;
          return new Promise((resolve) => setTimeout(() => resolve("within-deadline"), 25));
        }, { timeoutMs: ${timeoutMs}, signal: parent.signal });
        assert.equal(value, "within-deadline");
        assert.equal(operationSignal.aborted, false);
        assert.equal(getEventListeners(parent.signal, "abort").length, 0);
        parent.abort(new Error("after successful completion"));
        assert.equal(operationSignal.aborted, false);
        console.log("long-deadline-preserved");
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `], { encoding: "utf8", windowsHide: true, timeout: 10_000, env: childEnv });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    assert.equal(result.error, undefined, output);
    assert.equal(result.status, 0, output);
    assert.match(result.stdout, /long-deadline-preserved/);
    assert.doesNotMatch(result.stderr, /TimeoutOverflowWarning/);
  });
}

for (const thrownType of ["error", "string"]) {
  test(`network deadline contains a timeout factory throwing ${thrownType} inside the task promise`, () => {
    const modulePath = fileURLToPath(new URL("../shared/network-deadline.cjs", import.meta.url));
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    delete childEnv.NODE_OPTIONS;
    // A separate process proves the timer does not leak to uncaughtException;
    // no global exception handler may turn an escaped error into a passing test.
    const result = spawnSync(process.execPath, ["--input-type=commonjs", "--eval", `
      const assert = require("node:assert/strict");
      const { getEventListeners } = require("node:events");
      const { runWithNetworkDeadline } = require(${JSON.stringify(modulePath)});
      (async () => {
        const parent = new AbortController();
        const reason = ${thrownType === "error" ? 'new Error("timeout-factory-error")' : '"timeout-factory-string"'};
        let operationSignal;
        let factoryCalls = 0;
        const watchdog = setTimeout(() => {
          throw new Error("timeout factory left the task pending");
        }, 2000);
        try {
          await assert.rejects(runWithNetworkDeadline((signal) => {
            operationSignal = signal;
            return new Promise(() => {});
          }, {
            timeoutMs: 5,
            signal: parent.signal,
            createTimeoutError() { factoryCalls += 1; throw reason; },
          }), (error) => error === reason);
          assert.equal(factoryCalls, 1);
          assert.equal(operationSignal.aborted, true);
          assert.equal(operationSignal.reason, reason);
          assert.equal(parent.signal.aborted, false);
          assert.equal(getEventListeners(parent.signal, "abort").length, 0);
          assert.equal(await runWithNetworkDeadline(() => "next-task", { timeoutMs: 1000 }), "next-task");
          console.log("timeout-factory-contained");
        } finally {
          clearTimeout(watchdog);
        }
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `], { encoding: "utf8", windowsHide: true, timeout: 10_000, env: childEnv });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    assert.equal(result.error, undefined, output);
    assert.equal(result.status, 0, output);
    assert.match(result.stdout, /timeout-factory-contained/);
  });
}

for (const errorSource of ["default", "returned-error", "non-error-return"]) {
  test(`network deadline preserves ${errorSource} timeout behavior`, async () => {
    const parent = new AbortController();
    const expected = new Error("custom timeout result");
    let operationSignal;
    const options = { timeoutMs: 5, signal: parent.signal };
    if (errorSource !== "default") {
      options.createTimeoutError = () => errorSource === "returned-error" ? expected : "not an Error";
    }
    await assert.rejects(runWithNetworkDeadline((signal) => {
      operationSignal = signal;
      return new Promise(() => {});
    }, options), (error) => {
      assert.equal(operationSignal.aborted, true);
      assert.equal(operationSignal.reason, error);
      if (errorSource === "returned-error") assert.equal(error, expected);
      else {
        assert.equal(error.code, "network_timeout");
        assert.equal(error.timeoutMs, 5);
      }
      return true;
    });
    assert.equal(parent.signal.aborted, false);
    assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  });
}

for (const timing of ["before-call", "before-dispatch"]) {
  test(`network deadline does not enter an operation cancelled ${timing}`, async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-deadline-cancel-"));
    const marker = path.join(outputDir, "operation-started.txt");
    const controller = new AbortController();
    const reason = new Error("cancelled before operation dispatch");
    if (timing === "before-call") controller.abort(reason);
    const pending = runWithNetworkDeadline(() => {
      fs.writeFileSync(marker, "this operation must not start", { flag: "wx" });
      return "unexpected result";
    }, { signal: controller.signal, timeoutMs: 1000 });
    if (timing === "before-dispatch") controller.abort(reason);
    try {
      await assert.rejects(pending, (error) => error === reason);
      assert.equal(fs.existsSync(marker), false);
    } finally {
      if (fs.existsSync(marker)) fs.unlinkSync(marker);
      fs.rmdirSync(outputDir);
    }
  });
}

test("a cancelled remote asset does not invoke its provider and a later retry succeeds", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-asset-cancel-before-fetch-"));
  const controller = new AbortController();
  const reason = new Error("cancelled remote asset");
  controller.abort(reason);
  const bytes = Buffer.from("saved asset bytes");
  let fetchCalls = 0;
  let saved;
  const input = {
    capability: "video",
    outputDir,
    upstream: { videoUrl: "https://assets.example/cancelled.mp4" },
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(bytes, { headers: { "content-type": "video/mp4" } });
    },
  };
  try {
    await assert.rejects(
      saveCapabilityAssetResult({ ...input, signal: controller.signal }),
      (error) => error === reason,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetchCalls, 0);
    assert.deepEqual(fs.readdirSync(outputDir), []);
    saved = await saveCapabilityAssetResult(input);
    assert.equal(fetchCalls, 1);
    assert.deepEqual(fs.readFileSync(saved.localPath), bytes);
  } finally {
    if (saved?.localPath) fs.unlinkSync(saved.localPath);
    fs.rmdirSync(outputDir);
  }
});

test("network deadline still aborts a running operation and ignores its late result", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled after operation started");
  let entered;
  let finishOperation;
  let operationSignal;
  const started = new Promise((resolve) => { entered = resolve; });
  const pending = runWithNetworkDeadline((signal) => {
    operationSignal = signal;
    entered();
    return new Promise((resolve) => { finishOperation = resolve; });
  }, { signal: controller.signal, timeoutMs: 1000 });
  await started;
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(operationSignal.aborted, true);
  finishOperation("late result");
  await new Promise((resolve) => setImmediate(resolve));
});

test("network deadline preserves success and detaches cancellation after completion", async () => {
  const controller = new AbortController();
  const expected = { value: "completed" };
  let operationSignal;
  const result = await runWithNetworkDeadline((signal) => {
    operationSignal = signal;
    return expected;
  }, { signal: controller.signal, timeoutMs: 1000 });
  assert.equal(result, expected);
  controller.abort(new Error("after completion"));
  assert.equal(operationSignal.aborted, false);
});

test("network deadline attempts mandatory cleanup after cancellation without accepting its result", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled operation still needs cleanup");
  controller.abort(reason);
  let cleanupCalls = 0;
  await assert.rejects(runWithNetworkDeadline(() => {
    cleanupCalls += 1;
    return "cleanup finished";
  }, {
    signal: controller.signal,
    timeoutMs: 1000,
    allowAbortedStart: true,
  }), (error) => error === reason);
  assert.equal(cleanupCalls, 1);
});

test("capability asset saving keeps large visual outputs local without inline base64", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-capability-assets-"));
  const largePng = Buffer.concat([
    Buffer.from("iVBORw0KGgo=", "base64"),
    Buffer.alloc(768 * 1024, 7),
  ]);

  const result = await saveCapabilityAssetResult({
    capability: "webpage_screenshot",
    outputDir,
    upstream: {
      imageBase64: largePng.toString("base64"),
    },
  });

  assert.equal(result.capability, "webpage_screenshot");
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.bytes, largePng.length);
  assert.equal(result.base64, undefined);
  assert.match(result.localPath, /webpage_screenshot/);
  assert.equal(fs.existsSync(result.localPath), true);
  assert.equal(fs.statSync(result.localPath).size, largePng.length);
});

test("remote capability assets stream directly to disk without an unbounded body reader", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-capability-assets-stream-"));
  const chunks = Array.from({ length: 12 }, (_, index) => Buffer.alloc(64 * 1024, index));
  const expectedBytes = chunks.reduce((total, chunk) => total + chunk.length, 0);
  let arrayBufferCalled = false;
  const result = await saveCapabilityAssetResult({
    capability: "video",
    outputDir,
    upstream: { videoUrl: "https://assets.example/stream.mp4" },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "video/mp4" }),
      body: ReadableStream.from(chunks),
      async arrayBuffer() {
        arrayBufferCalled = true;
        throw new Error("streaming asset must not call arrayBuffer");
      },
    }),
  });

  assert.equal(arrayBufferCalled, false);
  assert.equal(result.bytes, expectedBytes);
  assert.equal(result.base64, undefined);
  assert.equal(fs.statSync(result.localPath).size, expectedBytes);
  assert.equal(fs.readdirSync(outputDir).some((name) => name.endsWith(".part")), false);
});

test("capability asset saving rejects oversized downloads before reading the body", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-capability-assets-large-"));
  let arrayBufferCalled = false;

  await assert.rejects(
    () => saveCapabilityAssetResult({
      capability: "webpage_screenshot",
      outputDir,
      provider: {
        id: "large-asset-provider",
        maxAssetBytes: 1024,
      },
      upstream: {
        imageUrl: "https://assets.example/large.png",
      },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({
          "content-length": "2048",
          "content-type": "image/png",
        }),
        async arrayBuffer() {
          arrayBufferCalled = true;
          return Buffer.from("should not be read").buffer;
        },
      }),
    }),
    (error) => {
      assert.equal(error.code, "asset_too_large");
      assert.match(error.message, /2048 bytes/);
      return true;
    },
  );

  assert.equal(arrayBufferCalled, false);
});

test("capability asset hard ceiling cannot be raised by provider configuration", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-capability-assets-hard-limit-"));
  let arrayBufferCalled = false;
  await assert.rejects(() => saveCapabilityAssetResult({
    capability: "video",
    outputDir,
    provider: { id: "unbounded-asset-provider", maxAssetBytes: Number.MAX_SAFE_INTEGER },
    upstream: { videoUrl: "https://assets.example/huge.mp4" },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({
        "content-length": String((256 * 1024 * 1024) + 1),
        "content-type": "video/mp4",
      }),
      async arrayBuffer() {
        arrayBufferCalled = true;
        return Buffer.alloc(0).buffer;
      },
    }),
  }), (error) => {
    assert.equal(error.code, "asset_too_large");
    assert.match(error.message, /268435456 bytes/u);
    return true;
  });
  assert.equal(arrayBufferCalled, false);
});

test("capability asset saving cancels oversized chunked downloads without buffering the full body", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-capability-assets-chunked-"));
  let pulls = 0;
  let canceled = false;
  let arrayBufferCalled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls <= 5) {
        controller.enqueue(new Uint8Array(800));
      } else {
        controller.close();
      }
    },
    cancel() {
      canceled = true;
    },
  });

  await assert.rejects(
    () => saveCapabilityAssetResult({
      capability: "webpage_screenshot",
      outputDir,
      provider: {
        id: "chunked-asset-provider",
        maxAssetBytes: 1024,
      },
      upstream: {
        imageUrl: "https://assets.example/chunked.png",
      },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "image/png" }),
        body,
        async arrayBuffer() {
          arrayBufferCalled = true;
          throw new Error("unbounded arrayBuffer reader must not be called");
        },
      }),
    }),
    (error) => {
      assert.equal(error.code, "asset_too_large");
      assert.match(error.message, /1600 bytes/);
      return true;
    },
  );

  assert.equal(canceled, true);
  assert.equal(arrayBufferCalled, false);
  assert.ok(pulls < 6, `chunked asset was read to completion (${pulls} pulls)`);
  assert.equal(fs.readdirSync(outputDir).some((name) => name.endsWith(".part")), false);
});

test("capability asset saving stops a stalled download at the provider deadline", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-capability-assets-timeout-"));
  let seenSignal = null;
  const startedAt = Date.now();

  await assert.rejects(
    () => saveCapabilityAssetResult({
      capability: "webpage_screenshot",
      outputDir,
      provider: {
        id: "stalled-asset-provider",
        assetTimeoutMs: 20,
      },
      upstream: {
        imageUrl: "https://assets.example/stalled.png",
      },
      fetchImpl: async (_url, init) => {
        seenSignal = init.signal;
        return new Promise(() => {});
      },
    }),
    (error) => {
      assert.equal(error.code, "asset_download_timeout");
      assert.match(error.message, /已停止等待/);
      return true;
    },
  );

  assert.equal(seenSignal?.aborted, true);
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(fs.readdirSync(outputDir).some((name) => name.endsWith(".part")), false);
});

test("a stalled streamed asset cancels its body and removes the owned partial before rejecting", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-capability-assets-body-timeout-"));
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.alloc(1024, 3));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(() => saveCapabilityAssetResult({
    capability: "video",
    outputDir,
    provider: { id: "stalled-body-provider", assetTimeoutMs: 20 },
    upstream: { videoUrl: "https://assets.example/stalled-body.mp4" },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "video/mp4" }),
      body,
    }),
  }), (error) => error?.code === "asset_download_timeout");
  assert.equal(cancelled, true);
  assert.equal(fs.readdirSync(outputDir).some((name) => name.endsWith(".part")), false);
});

test("capability asset saving reports failed downloads in Chinese", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-capability-assets-download-fail-"));
  let canceled = false;

  try {
    await assert.rejects(
      () => saveCapabilityAssetResult({
        capability: "webpage_screenshot",
        outputDir,
        upstream: {
          imageUrl: "https://assets.example/expired.png",
        },
        fetchImpl: async () => ({
          ok: false,
          status: 403,
          headers: new Headers({ "content-type": "application/json" }),
          body: {
            cancel() {
              canceled = true;
              return Promise.resolve();
            },
          },
          async arrayBuffer() {
            return Buffer.from("forbidden").buffer;
          },
        }),
      }),
      (error) => {
        assert.equal(error.code, "asset_download_failed");
        assert.equal(error.statusCode, 403);
        assert.match(error.message, /能力结果下载失败：HTTP 403/);
        assert.doesNotMatch(error.message, /Capability result download failed/);
        return true;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(canceled, true);
  } finally {
    fs.rmdirSync(outputDir);
  }
});
