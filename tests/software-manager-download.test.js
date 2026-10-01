import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import {
  consumePreparedDownloadVerification,
  createDownloadManager,
} from "../desktop/software-manager/download-manager.mjs";

const body = Buffer.from("CodexBridge component package: resumable and verified.");
// Watchdogs bound the test harness, not the downloader's virtual deadlines.
// Capture these before MockTimers is enabled so slow real file I/O can finish.
const scheduleWatchdog = globalThis.setTimeout;
const clearWatchdog = globalThis.clearTimeout;
const FILE_IO_WATCHDOG_MS = 5_000;

function assetFor(url, content = body) {
  return {
    url,
    size: content.length,
    sha256: createHash("sha256").update(content).digest("hex")
  };
}

async function startServer(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    async close() {
      server.close();
      await once(server, "close");
    }
  };
}

async function withTempDirectory(fn) {
  const directory = await mkdtemp(join(tmpdir(), "codexbridge-download-"));
  const createdFiles = new Set();
  const fixture = {
    directory,
    destination(name = "component.zip") {
      const destination = join(directory, name);
      createdFiles.add(destination);
      createdFiles.add(`${destination}.part`);
      return destination;
    }
  };
  try {
    return await fn(fixture);
  } finally {
    for (const path of createdFiles) {
      await unlink(path).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
    await rmdir(directory);
  }
}

async function settleWithin(pending, timeoutMs = 250) {
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((_resolve, reject) => {
        timer = scheduleWatchdog(() => reject(new Error("download_did_not_settle")), timeoutMs);
      }),
    ]);
  } finally {
    clearWatchdog(timer);
  }
}

test("resumes a partial package and verifies final SHA256", async () => {
  const seenRanges = [];
  const origin = await startServer((request, response) => {
    seenRanges.push(request.headers.range);
    const offset = Number(request.headers.range?.match(/^bytes=(\d+)-$/)?.[1] ?? 0);
    response.writeHead(offset ? 206 : 200, {
      "Content-Length": body.length - offset,
      ...(offset ? { "Content-Range": `bytes ${offset}-${body.length - 1}/${body.length}` } : {})
    });
    response.end(body.subarray(offset));
  });
  try {
    await withTempDirectory(async ({ destination: fixtureDestination }) => {
      const destination = fixtureDestination();
      await writeFile(`${destination}.part`, body.subarray(0, 7));
      const progress = [];
      const manager = createDownloadManager({ retryPolicy: { maxAttempts: 2, delayMs: 0 } });

      const result = await manager.download({
        asset: assetFor(`${origin.url}/component.zip`),
        destination,
        signal: AbortSignal.timeout(5_000),
        onProgress(event) {
          progress.push(event);
        }
      });

      assert.equal(result.resumed, true);
      assert.deepEqual(await readFile(destination), body);
      await assert.rejects(stat(`${destination}.part`));
      assert.deepEqual(seenRanges, ["bytes=7-"]);
      const transfer = progress.filter((event) => event.phase === "download").at(-1);
      assert.equal(transfer.receivedBytes, body.length);
      assert.equal(transfer.totalBytes, body.length);
      assert.equal(transfer.percent, 100);
      assert.equal(typeof transfer.bytesPerSecond, "number");
      assert.deepEqual(progress.at(-1), {
        phase: "verify-download",
        receivedBytes: body.length,
        totalBytes: body.length,
        percent: 100,
      });
    });
  } finally {
    await origin.close();
  }
});

test("high-frequency chunks are throttled before reaching IPC-facing progress listeners", async () => {
  const chunks = Array.from({ length: 2_000 }, () => Buffer.alloc(4_096, 7));
  const content = Buffer.concat(chunks);
  const fetchImpl = async () => new Response(Readable.toWeb(Readable.from(chunks)), { status: 200 });
  await withTempDirectory(async ({ destination: fixtureDestination }) => {
    const progress = [];
    const manager = createDownloadManager({ fetchImpl });
    await manager.download({
      asset: assetFor("https://download.example/component.zip", content),
      destination: fixtureDestination("throttled.zip"),
      onProgress: (event) => progress.push(event),
    });

    const transfer = progress.filter((event) => event.phase === "download");
    assert.equal(transfer.at(-1).percent, 100);
    assert.ok(transfer.length < 20, `expected throttled progress, received ${transfer.length} events`);
    assert.equal(progress.at(-1).phase, "verify-download");
  });
});

test("progress callback failures cannot invalidate a verified software package", async () => {
  const fetchImpl = async () => new Response(body, { status: 200 });
  await withTempDirectory(async ({ destination: fixtureDestination }) => {
    let progressCalls = 0;
    const manager = createDownloadManager({ fetchImpl });
    const destination = fixtureDestination("progress-isolated.zip");
    const result = await manager.download({
      asset: assetFor("https://download.example/component.zip"),
      destination,
      onProgress() {
        progressCalls += 1;
        if (progressCalls === 1) throw new Error("listener failed");
        return Promise.reject(new Error("async listener failed"));
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(result.size, body.length);
    assert.deepEqual(await readFile(destination), body);
    assert.ok(progressCalls >= 2);
  });
});

test("a request that ignores AbortSignal stops at the hard header deadline", async () => {
  await withTempDirectory(async ({ destination: fixtureDestination }) => {
    const destination = fixtureDestination("stalled-request.zip");
    let requestSignal = null;
    const manager = createDownloadManager({
      fetchImpl(_url, options) {
        requestSignal = options.signal;
        return new Promise(() => {});
      },
      retryPolicy: { maxAttempts: 1, delayMs: 0 },
      timeoutPolicy: { requestTimeoutMs: 20, inactivityTimeoutMs: 100, totalTimeoutMs: 200 },
    });

    await assert.rejects(
      manager.download({
        asset: assetFor("https://download.example/stalled-request.zip"),
        destination,
      }),
      (error) => error?.code === "download_request_timeout",
    );
    assert.equal(requestSignal?.aborted, true);
    await assert.rejects(stat(destination), { code: "ENOENT" });
    await assert.rejects(stat(`${destination}.part`), { code: "ENOENT" });
  });
});

test("uncooperative requests obey cancellation and total deadlines before the header deadline", async (t) => {
  for (const mode of ["cancel", "total"]) {
    await t.test(mode, async () => {
      await withTempDirectory(async ({ destination: fixtureDestination }) => {
        const destination = fixtureDestination(`${mode}-before-headers.zip`);
        const controller = new AbortController();
        const cancellation = new Error("user_cancelled_before_headers");
        const started = Promise.withResolvers();
        const response = Promise.withResolvers();
        let requestSignal;
        let bodyCancellations = 0;
        const manager = createDownloadManager({
          fetchImpl(_url, options) {
            requestSignal = options.signal;
            started.resolve();
            return response.promise;
          },
          retryPolicy: { maxAttempts: 3, delayMs: 0 },
          timeoutPolicy: { requestTimeoutMs: 1_000, totalTimeoutMs: mode === "total" ? 20 : 2_000 },
        });
        const pending = manager.download({
          asset: assetFor("https://download.example/component.zip"),
          destination,
          signal: controller.signal,
        }).catch((error) => error);
        try {
          await started.promise;
          if (mode === "cancel") controller.abort(cancellation);
          const error = await settleWithin(pending);
          if (mode === "cancel") assert.equal(error, cancellation);
          else assert.equal(error.code, "download_timeout");
          assert.equal(requestSignal.aborted, true);
        } finally {
          response.resolve(new Response(new ReadableStream({
            cancel() {
              bodyCancellations += 1;
              throw new Error("late_response_cleanup_failed");
            },
          })));
          await pending;
          await new Promise((resolve) => setImmediate(resolve));
        }
        assert.equal(bodyCancellations, 1);
        await assert.rejects(stat(destination), { code: "ENOENT" });
        await assert.rejects(stat(`${destination}.part`), { code: "ENOENT" });
      });
    });
  }
});

test("a cooperative fetch abort cannot replace the retryable header timeout", async () => {
  await withTempDirectory(async ({ destination: fixtureDestination }) => {
    let requests = 0;
    const destination = fixtureDestination("retry-after-header-timeout.zip");
    const manager = createDownloadManager({
      fetchImpl(_url, { signal }) {
        requests += 1;
        if (requests > 1) return new Response(body);
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("transport aborted", "AbortError"));
          }, { once: true });
        });
      },
      retryPolicy: { maxAttempts: 2, delayMs: 0 },
      timeoutPolicy: { requestTimeoutMs: 20, totalTimeoutMs: 2_000 },
    });
    await manager.download({ asset: assetFor("https://download.example/component.zip"), destination });
    assert.equal(requests, 2);
    assert.deepEqual(await readFile(destination), body);
  });
});

test("response cleanup cannot outlive cancellation or the total download deadline", async (t) => {
  for (const phase of ["http", "range", "redirect", "cross-origin", "reset", "writer"]) {
    for (const mode of ["cancel", "total"]) {
      await t.test(`${phase}: ${mode}`, async () => {
        const controller = new AbortController();
        const cancellation = new Error("user_cancelled_response_cleanup");
        const cleanupStarted = Promise.withResolvers();
        const cleanup = Promise.withResolvers();
        let requests = 0;
        let writers = 0;
        const responseBody = new ReadableStream({
          cancel() {
            cleanupStarted.resolve();
            return cleanup.promise;
          },
        });
        const manager = createDownloadManager({
          async fetchImpl() {
            requests += 1;
            assert.equal(requests, 1, "aborted cleanup must not start another request");
            const status = phase === "http" ? 503 : phase === "range" ? 206
              : phase.includes("redirect") || phase === "cross-origin" ? 302 : 200;
            return new Response(responseBody, {
              status,
              headers: {
                "Content-Range": "bytes 8-9/10",
                Location: phase === "cross-origin" ? "https://attacker.example/package.zip" : "/final.zip",
              },
            });
          },
          retryPolicy: { maxAttempts: 3, delayMs: 0 },
          timeoutPolicy: { requestTimeoutMs: 1_000, totalTimeoutMs: mode === "total" ? 20 : 2_000 },
        });
        const pending = manager.downloadPrepared({
          asset: assetFor("https://download.example/component.zip"),
          target: {
            async inspect() { return { size: phase === "range" || phase === "reset" ? 7 : 0 }; },
            async reset() { throw new Error("target_reset_failed"); },
            async createWriteStream() { writers += 1; throw new Error("target_writer_failed"); },
            async verify() { assert.fail("cancelled cleanup must not verify a package"); },
          },
          signal: controller.signal,
        }).catch((error) => error);
        try {
          await cleanupStarted.promise;
          if (mode === "cancel") controller.abort(cancellation);
          const error = await settleWithin(pending);
          if (mode === "cancel") assert.equal(error, cancellation);
          else assert.equal(error.code, "download_timeout");
          assert.equal(requests, 1);
          assert.equal(writers, phase === "writer" ? 1 : 0);
        } finally {
          cleanup.resolve();
          await pending;
        }
      });
    }
  }
});

test("response cleanup has its own deadline and consumes late rejection without retrying", async (t) => {
  for (const phase of ["http", "redirect"]) {
    await t.test(phase, async () => {
      const cleanup = Promise.withResolvers();
      let requests = 0;
      const manager = createDownloadManager({
        async fetchImpl() {
          requests += 1;
          return new Response(new ReadableStream({ cancel() { return cleanup.promise; } }), {
            status: phase === "http" ? 503 : 302,
            headers: { Location: "/final.zip" },
          });
        },
        retryPolicy: { maxAttempts: 3, delayMs: 0 },
        timeoutPolicy: { requestTimeoutMs: 20, totalTimeoutMs: 2_000 },
      });
      const pending = manager.downloadPrepared({
        asset: assetFor("https://download.example/component.zip"),
        target: {
          async inspect() { return { size: 0 }; }, async reset() {},
          async createWriteStream() { assert.fail("unreleased response must not open a writer"); },
          async verify() { assert.fail("unreleased response must not verify a package"); },
        },
      }).catch((error) => error);
      try {
        const error = await settleWithin(pending);
        if (phase === "http") {
          assert.ok(error instanceof AggregateError);
          assert.match(error.cause.message, /HTTP 503/u);
          assert.equal(error.errors[1].code, "download_cleanup_timeout");
        } else {
          assert.equal(error.code, "download_cleanup_timeout");
        }
        assert.equal(requests, 1);
      } finally {
        cleanup.reject(new Error("late_body_cleanup_failed"));
        await pending;
        await new Promise((resolve) => setImmediate(resolve));
      }
    });
  }
});

test("stuck body cancellation is bounded while pipeline still waits for the file handle to close", async (t) => {
  for (const mode of ["cancel", "total", "inactivity"]) {
    await t.test(mode, async (subtest) => {
      await withTempDirectory(async ({ destination: fixtureDestination }) => {
        subtest.mock.timers.enable({ apis: ["setTimeout"] });
        const destination = fixtureDestination(`${mode}-during-transfer.zip`);
        const controller = new AbortController();
        const cleanup = Promise.withResolvers();
        const cancellationStarted = Promise.withResolvers();
        const closeStarted = Promise.withResolvers();
        const allowClose = Promise.withResolvers();
        const transferStarted = Promise.withResolvers();
        const fileOpened = Promise.withResolvers();
        let output;
        let closed = false;
        let settled = false;
        let cancellations = 0;
        const responseBody = new ReadableStream({
          start(stream) { stream.enqueue(body.subarray(0, 8)); },
          cancel() { cancellations += 1; cancellationStarted.resolve(); return cleanup.promise; },
        });
        const manager = createDownloadManager({
          async fetchImpl() { return new Response(responseBody); },
          fsApi: {
            promises: fs.promises,
            createReadStream: fs.createReadStream,
            createWriteStream(path, options) {
              output = fs.createWriteStream(path, {
                ...options,
                fs: {
                  ...fs,
                  close(fd, callback) {
                    closeStarted.resolve();
                    allowClose.promise.then(() => fs.close(fd, callback));
                  },
                },
              });
              output.once("open", () => fileOpened.resolve());
              output.once("close", () => { closed = true; });
              return output;
            },
          },
          retryPolicy: { maxAttempts: 1, delayMs: 0 },
          timeoutPolicy: {
            requestTimeoutMs: 20,
            inactivityTimeoutMs: mode === "inactivity" ? 20 : 1_000,
            totalTimeoutMs: mode === "total" ? 20 : 2_000,
          },
        });
        const pending = manager.download({
          asset: assetFor("https://download.example/component.zip"),
          destination,
          signal: controller.signal,
          onProgress(event) {
            if (event.phase === "download") transferStarted.resolve();
          },
        }).catch((error) => error).finally(() => { settled = true; });
        try {
          // Establish the owned-file transfer phase before advancing any deadline.
          // A cold Windows stat/open must not win a 20ms timer meant for transfer.
          await settleWithin(Promise.all([transferStarted.promise, fileOpened.promise]), FILE_IO_WATCHDOG_MS);
          subtest.mock.timers.tick(19);
          await new Promise((resolve) => setImmediate(resolve));
          assert.equal(settled, false);
          assert.equal(cancellations, 0, "a transfer must not be cancelled before its deadline");
          if (mode === "cancel") controller.abort();
          else subtest.mock.timers.tick(1);
          await settleWithin(Promise.all([closeStarted.promise, cancellationStarted.promise]), FILE_IO_WATCHDOG_MS);
          // The response cancel promise deliberately never resolves; its own
          // deadline must expire without abandoning the still-owned file handle.
          subtest.mock.timers.tick(20);
          await new Promise((resolve) => setImmediate(resolve));
          assert.equal(settled, false, "a pending filesystem close must remain owned by the pipeline");
          assert.equal(closed, false);
          allowClose.resolve();
          const error = await settleWithin(pending, FILE_IO_WATCHDOG_MS);
          if (mode === "cancel") assert.equal(error.name, "AbortError");
          else assert.equal(error.code, mode === "total" ? "download_timeout" : "download_stalled");
          assert.equal(cancellations, 1);
          assert.equal(closed, true);
          assert.equal(output.closed, true);
          await assert.rejects(stat(destination), { code: "ENOENT" });
          assert.ok((await stat(`${destination}.part`)).size <= 8);
        } finally {
          controller.abort();
          allowClose.resolve();
          cleanup.resolve();
          try { await settleWithin(pending, FILE_IO_WATCHDOG_MS); }
          finally { subtest.mock.timers.reset(); }
        }
      });
    });
  }
});

test("a response body that stops producing bytes fails at the inactivity deadline", async (t) => {
  for (const initialBytes of [0, 8]) await t.test(`durable prefix ${initialBytes}`, async (subtest) => {
    await withTempDirectory(async ({ destination: fixtureDestination }) => {
      const content = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
      const destination = fixtureDestination("stalled-body.zip");
      if (initialBytes) await writeFile(`${destination}.part`, content.subarray(0, initialBytes));
      subtest.mock.timers.enable({ apis: ["setTimeout"] });
      const controller = new AbortController();
      const transferStarted = Promise.withResolvers();
      let cancelled = false;
      let settled = false;
      const bodyStream = new ReadableStream({
        start(controller) {
          controller.enqueue(content.subarray(initialBytes, initialBytes + 8));
        },
        cancel() {
          cancelled = true;
        },
      });
      const manager = createDownloadManager({
        fetchImpl: async () => new Response(bodyStream, {
          status: initialBytes ? 206 : 200,
          headers: initialBytes ? { "content-range": `bytes ${initialBytes}-31/32` } : {},
        }),
        retryPolicy: { maxAttempts: 1, delayMs: 0 },
        timeoutPolicy: { requestTimeoutMs: 100, inactivityTimeoutMs: 20, totalTimeoutMs: 200 },
      });

      const pending = manager.download({
        asset: assetFor("https://download.example/stalled-body.zip", content),
        destination,
        signal: controller.signal,
        onProgress() { transferStarted.resolve(); },
      }).catch(error => error).finally(() => { settled = true; });
      try {
        await settleWithin(transferStarted.promise, FILE_IO_WATCHDOG_MS);
        subtest.mock.timers.tick(19);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(settled, false, "an active stream must survive until its inactivity deadline");
        subtest.mock.timers.tick(1);
        const error = await settleWithin(pending, FILE_IO_WATCHDOG_MS);
        assert.equal(error?.code, "download_stalled");
        assert.equal(cancelled, true);
        // Received bytes can still be queued for disk when the deadline fires.
        // Preserve every previously durable byte and never promote a partial.
        const partial = await readFile(`${destination}.part`);
        assert.ok(partial.length >= initialBytes && partial.length <= initialBytes + 8);
        assert.deepEqual(partial, content.subarray(0, partial.length));
        await assert.rejects(stat(destination), { code: "ENOENT" });
      } finally {
        controller.abort();
        try { await settleWithin(pending, FILE_IO_WATCHDOG_MS); }
        finally { subtest.mock.timers.reset(); }
      }
    });
  });
});

test("an oversized response is cut off before the excess chunk reaches disk", async () => {
  await withTempDirectory(async ({ destination: fixtureDestination }) => {
    const expected = Buffer.alloc(8, 1);
    let cancelled = false;
    const bodyStream = new ReadableStream({
      start(controller) {
        controller.enqueue(expected);
        controller.enqueue(Buffer.alloc(8, 2));
      },
      cancel() {
        cancelled = true;
      },
    });
    const manager = createDownloadManager({
      fetchImpl: async () => new Response(bodyStream, { status: 200 }),
      retryPolicy: { maxAttempts: 1, delayMs: 0 },
      timeoutPolicy: { requestTimeoutMs: 100, inactivityTimeoutMs: 100, totalTimeoutMs: 500 },
    });
    const destination = fixtureDestination("oversized.zip");

    await assert.rejects(
      manager.download({
        asset: assetFor("https://download.example/oversized.zip", expected),
        destination,
      }),
      /exceeds the catalog length/u,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true);
    assert.ok((await stat(`${destination}.part`)).size <= expected.length);
    await assert.rejects(stat(destination), { code: "ENOENT" });
  });
});

test("prepared mode verifies one exact part without publishing and issues an opaque instance-bound receipt", async () => {
  const origin = await startServer((request, response) => {
    response.writeHead(200, { "Content-Length": body.length });
    response.end(body);
  });
  try {
    await withTempDirectory(async ({ destination: fixtureDestination }) => {
      const destination = fixtureDestination();
      const partPath = `${destination}.part`;
      const asset = assetFor(`${origin.url}/component.zip`);
      const manager = createDownloadManager();
      const receipt = await manager.downloadPrepared({ asset, partPath });

      assert.deepEqual(await readFile(partPath), body);
      await assert.rejects(stat(destination));
      assert.equal(Object.getPrototypeOf(receipt), null);
      assert.deepEqual(Object.keys(receipt), []);
      assert.equal(Object.isFrozen(receipt), true);

      assert.throws(
        () => consumePreparedDownloadVerification(manager, Object.freeze({ verified: true }), {
          partPath, size: asset.size, sha256: asset.sha256,
        }),
        /verification_receipt_invalid/u,
      );

      assert.throws(
        () => consumePreparedDownloadVerification(createDownloadManager(), receipt, {
          partPath, size: asset.size, sha256: asset.sha256,
        }),
        /verification_(?:manager|receipt)_invalid/u,
      );
      assert.deepEqual(
        consumePreparedDownloadVerification(manager, receipt, {
          partPath, size: asset.size, sha256: asset.sha256,
        }),
        { partPath, size: asset.size, sha256: asset.sha256 },
      );
      assert.throws(
        () => consumePreparedDownloadVerification(manager, receipt, {
          partPath, size: asset.size, sha256: asset.sha256,
        }),
        /verification_receipt_consumed/u,
      );
    });
  } finally {
    await origin.close();
  }
});

test("prepared capability target resumes, writes, and verifies without reopening a filesystem path", async () => {
  let content = Buffer.from(body.subarray(0, 7));
  const calls = [];
  const target = Object.freeze({
    async inspect() { calls.push("inspect"); return { size: content.length }; },
    async reset() { calls.push("reset"); content = Buffer.alloc(0); },
    async createWriteStream({ append, maxBytes }) {
      calls.push(["writer", append, maxBytes]);
      if (!append) content = Buffer.alloc(0);
      return new Writable({
        write(chunk, _encoding, callback) {
          content = Buffer.concat([content, Buffer.from(chunk)]);
          callback(content.length <= maxBytes ? null : new Error("too_large"));
        },
      });
    },
    async verify({ size, sha256 }) {
      calls.push("verify");
      assert.equal(content.length, size);
      assert.equal(createHash("sha256").update(content).digest("hex"), sha256);
      return { size, sha256 };
    },
  });
  const manager = createDownloadManager({
    fsApi: {
      async stat() { throw new Error("global_stat_forbidden"); },
      createWriteStream() { throw new Error("global_write_forbidden"); },
      createReadStream() { throw new Error("global_hash_forbidden"); },
    },
    async fetchImpl(_url, { headers }) {
      assert.equal(headers.Range, "bytes=7-");
      return new Response(body.subarray(7), {
        status: 206,
        headers: { "Content-Range": `bytes 7-${body.length - 1}/${body.length}` },
      });
    },
    retryPolicy: { maxAttempts: 1, delayMs: 0 },
  });
  const asset = assetFor("https://shanhaiyouling.com/codexbridge-test/packages/component.zip");
  const receipt = await manager.downloadPrepared({ asset, target });
  assert.deepEqual(content, body);
  assert.deepEqual(calls, ["inspect", ["writer", true, body.length], "verify"]);
  assert.deepEqual(consumePreparedDownloadVerification(manager, receipt, {
    target, size: asset.size, sha256: asset.sha256,
  }), { target, size: asset.size, sha256: asset.sha256 });
});

test("a stalled prepared capability download retries from its verified partial length", async () => {
  let content = Buffer.alloc(0);
  let fetches = 0;
  let firstBodyCancelled = false;
  const target = Object.freeze({
    async inspect() { return { size: content.length }; },
    async reset() { content = Buffer.alloc(0); },
    async createWriteStream({ append, maxBytes }) {
      if (!append) content = Buffer.alloc(0);
      return new Writable({
        write(chunk, _encoding, callback) {
          content = Buffer.concat([content, Buffer.from(chunk)]);
          callback(content.length <= maxBytes ? null : new Error("too_large"));
        },
      });
    },
    async verify({ size, sha256 }) {
      assert.equal(content.length, size);
      assert.equal(createHash("sha256").update(content).digest("hex"), sha256);
      return { size, sha256 };
    },
  });
  const manager = createDownloadManager({
    async fetchImpl(_url, { headers }) {
      fetches += 1;
      if (fetches === 1) {
        assert.equal(headers.Range, undefined);
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(body.subarray(0, 7));
          },
          cancel() {
            firstBodyCancelled = true;
          },
        }), { status: 200 });
      }
      assert.equal(headers.Range, "bytes=7-");
      return new Response(body.subarray(7), {
        status: 206,
        headers: { "Content-Range": `bytes 7-${body.length - 1}/${body.length}` },
      });
    },
    retryPolicy: { maxAttempts: 2, delayMs: 0 },
    timeoutPolicy: { requestTimeoutMs: 100, inactivityTimeoutMs: 20, totalTimeoutMs: 500 },
  });
  const asset = assetFor("https://shanhaiyouling.com/codexbridge-test/packages/component.zip");

  const receipt = await manager.downloadPrepared({ asset, target });

  assert.equal(firstBodyCancelled, true);
  assert.equal(fetches, 2);
  assert.deepEqual(content, body);
  assert.deepEqual(consumePreparedDownloadVerification(manager, receipt, {
    target, size: asset.size, sha256: asset.sha256,
  }), { target, size: asset.size, sha256: asset.sha256 });
});

test("prepared downloads reject neither or both destination modes before fetching", async () => {
  let fetches = 0;
  const manager = createDownloadManager({
    async fetchImpl() { fetches += 1; throw new Error("fetch_must_not_run"); },
  });
  const asset = assetFor("https://shanhaiyouling.com/codexbridge-test/packages/component.zip");
  const target = {
    async inspect() { return { size: 0 }; },
    async reset() {},
    async createWriteStream() { return new Writable(); },
    async verify() { return { size: asset.size, sha256: asset.sha256 }; },
  };
  await assert.rejects(manager.downloadPrepared({ asset }), /exactly one prepared download target/u);
  await assert.rejects(manager.downloadPrepared({ asset, target: undefined }), /exactly one prepared download target/u);
  await assert.rejects(manager.downloadPrepared({ asset, partPath: "D:\\part", target }), /exactly one prepared download target/u);
  assert.equal(fetches, 0);
});

test("prepared verification binding mismatch consumes the receipt and cannot be retried with corrected metadata", async () => {
  await withTempDirectory(async ({ destination: fixtureDestination }) => {
    const destination = fixtureDestination();
    const partPath = `${destination}.part`;
    const asset = assetFor("https://shanhaiyouling.com/codexbridge-test/packages/component.zip");
    await writeFile(partPath, body);
    const manager = createDownloadManager({
      fetchImpl() { throw new Error("complete part must not fetch"); },
    });
    for (const override of [
      { partPath: `${partPath}.alias` },
      { size: asset.size + 1 },
      { sha256: "0".repeat(64) },
    ]) {
      const receipt = await manager.downloadPrepared({ asset, partPath });
      assert.throws(
        () => consumePreparedDownloadVerification(manager, receipt, {
          partPath, size: asset.size, sha256: asset.sha256, ...override,
        }),
        /verification_binding_mismatch/u,
      );
      assert.throws(
        () => consumePreparedDownloadVerification(manager, receipt, {
          partPath, size: asset.size, sha256: asset.sha256,
        }),
        /verification_receipt_consumed/u,
      );
    }
    await assert.rejects(stat(destination));
  });
});

test("restarts from zero when a server ignores the resume Range", async () => {
  const seenRanges = [];
  const origin = await startServer((request, response) => {
    seenRanges.push(request.headers.range);
    response.writeHead(200, { "Content-Length": body.length });
    response.end(body);
  });
  try {
    await withTempDirectory(async ({ destination: fixtureDestination }) => {
      const destination = fixtureDestination();
      await writeFile(`${destination}.part`, body.subarray(0, 9));
      const manager = createDownloadManager();

      const result = await manager.download({ asset: assetFor(`${origin.url}/component.zip`), destination });

      assert.equal(result.resumed, false);
      assert.deepEqual(await readFile(destination), body);
      assert.deepEqual(seenRanges, ["bytes=9-"]);
    });
  } finally {
    await origin.close();
  }
});

test("Range fallback checks cancellation again before resetting the held target", async () => {
  const controller = new AbortController();
  let resets = 0;
  let cancellations = 0;
  const responseBody = new ReadableStream({
    pull() {},
    cancel() { cancellations += 1; },
  });
  const target = {
    async inspect() { return { size: 9 }; },
    async reset() { resets += 1; },
    async createWriteStream() { throw new Error("writer_must_not_open"); },
    async verify() { throw new Error("verify_must_not_run"); },
  };
  const manager = createDownloadManager({
    async fetchImpl() {
      controller.abort();
      return { status: 200, headers: new Headers(), body: responseBody };
    },
    retryPolicy: { maxAttempts: 1, delayMs: 0 },
  });
  await assert.rejects(manager.downloadPrepared({
    asset: assetFor("https://shanhaiyouling.com/codexbridge-test/packages/component.zip"),
    target,
    signal: controller.signal,
  }), { name: "AbortError" });
  assert.equal(resets, 0);
  assert.equal(cancellations, 1);
});

test("Range fallback preserves response cleanup failure when synchronous abort is normalized", async () => {
  const controller = new AbortController();
  const cleanup = new Error("range_abort_body_cancel_failed");
  const responseBody = new ReadableStream({ pull() {}, cancel() { throw cleanup; } });
  const manager = createDownloadManager({
    async fetchImpl() {
      controller.abort();
      return { status: 200, headers: new Headers(), body: responseBody };
    },
    retryPolicy: { maxAttempts: 1, delayMs: 0 },
  });
  await assert.rejects(manager.downloadPrepared({
    asset: assetFor("https://shanhaiyouling.com/codexbridge-test/packages/component.zip"),
    target: {
      async inspect() { return { size: 9 }; }, async reset() {},
      async createWriteStream() { throw new Error("writer_must_not_open"); },
      async verify() { throw new Error("verify_must_not_run"); },
    },
    signal: controller.signal,
  }), (error) => (
    error instanceof AggregateError
    && error.errors[0]?.name === "AbortError"
    && error.errors[1] === cleanup
    && error.cause?.name === "AbortError"
  ));
});

test("reset and writer setup failures cancel the response body and preserve cleanup failures", async (t) => {
  for (const phase of ["reset", "writer"]) {
    await t.test(phase, async () => {
      const primary = Object.assign(new Error(`${phase}_failed`), { retryable: false });
      const cleanup = new Error(`${phase}_body_cancel_failed`);
      let cancellations = 0;
      const responseBody = new ReadableStream({
        pull() {},
        cancel() { cancellations += 1; throw cleanup; },
      });
      const target = {
        async inspect() { return { size: phase === "reset" ? 7 : 0 }; },
        async reset() { throw primary; },
        async createWriteStream() { throw primary; },
        async verify() { throw new Error("verify_must_not_run"); },
      };
      const manager = createDownloadManager({
        async fetchImpl() { return { status: 200, headers: new Headers(), body: responseBody }; },
        retryPolicy: { maxAttempts: 1, delayMs: 0 },
      });
      await assert.rejects(manager.downloadPrepared({
        asset: assetFor("https://shanhaiyouling.com/codexbridge-test/packages/component.zip"), target,
      }), (error) => (
        error instanceof AggregateError
        && error.cause === primary
        && error.errors[0] === primary
        && error.errors[1] === cleanup
      ));
      assert.equal(cancellations, 1);
    });
  }
});

test("every retryable HTTP failure cancels its response body before the next attempt", async () => {
  let requests = 0;
  let cancellations = 0;
  const manager = createDownloadManager({
    async fetchImpl() {
      requests += 1;
      return {
        status: 503,
        headers: new Headers(),
        body: new ReadableStream({ pull() {}, cancel() { cancellations += 1; } }),
      };
    },
    retryPolicy: { maxAttempts: 2, delayMs: 0 },
  });
  await assert.rejects(manager.downloadPrepared({
    asset: assetFor("https://shanhaiyouling.com/codexbridge-test/packages/component.zip"),
    target: {
      async inspect() { return { size: 0 }; }, async reset() {},
      async createWriteStream() { throw new Error("writer_must_not_open"); },
      async verify() { throw new Error("verify_must_not_run"); },
    },
  }), /HTTP 503/u);
  assert.equal(requests, 2);
  assert.equal(cancellations, 2);
});

test("invalid resume ranges and cross-origin redirects cancel their response bodies", async (t) => {
  for (const mode of ["range", "redirect"]) {
    await t.test(mode, async () => {
      let cancellations = 0;
      const responseBody = new ReadableStream({ pull() {}, cancel() { cancellations += 1; } });
      const manager = createDownloadManager({
        async fetchImpl() {
          return mode === "range"
            ? { status: 206, headers: new Headers({ "Content-Range": "bytes 8-9/10" }), body: responseBody }
            : {
              status: 302,
              headers: new Headers({ Location: "https://attacker.example/package.zip" }),
              body: responseBody,
            };
        },
        retryPolicy: { maxAttempts: 1, delayMs: 0 },
      });
      await assert.rejects(manager.downloadPrepared({
        asset: assetFor("https://shanhaiyouling.com/codexbridge-test/packages/component.zip"),
        target: {
          async inspect() { return { size: mode === "range" ? 7 : 0 }; }, async reset() {},
          async createWriteStream() { throw new Error("writer_must_not_open"); },
          async verify() { throw new Error("verify_must_not_run"); },
        },
      }), mode === "range" ? /Content-Range/u : /redirect crosses/u);
      assert.equal(cancellations, 1);
    });
  }
});

test("same-origin redirect bodies are cancelled before requesting the next hop", async () => {
  let requests = 0;
  let redirectCancellations = 0;
  const target = {
    async inspect() { return { size: 0 }; }, async reset() {},
    async createWriteStream() { return new Writable({ write(_chunk, _encoding, callback) { callback(); } }); },
    async verify({ size, sha256 }) { return { size, sha256 }; },
  };
  const manager = createDownloadManager({
    async fetchImpl() {
      requests += 1;
      if (requests === 1) {
        return {
          status: 302,
          headers: new Headers({ Location: "/codexbridge-test/packages/final.zip" }),
          body: new ReadableStream({ pull() {}, cancel() { redirectCancellations += 1; } }),
        };
      }
      return new Response(body, { status: 200 });
    },
    retryPolicy: { maxAttempts: 1, delayMs: 0 },
  });
  await manager.downloadPrepared({
    asset: assetFor("https://shanhaiyouling.com/codexbridge-test/packages/component.zip"), target,
  });
  assert.equal(requests, 2);
  assert.equal(redirectCancellations, 1);
});

test("retries a connection reset within its bounded retry budget", async () => {
  let requests = 0;
  const origin = await startServer((request, response) => {
    requests += 1;
    if (requests === 1) {
      response.destroy();
      return;
    }
    response.writeHead(200, { "Content-Length": body.length });
    response.end(body);
  });
  try {
    await withTempDirectory(async ({ destination: fixtureDestination }) => {
      const destination = fixtureDestination();
      const manager = createDownloadManager({ retryPolicy: { maxAttempts: 2, delayMs: 0 } });

      await manager.download({ asset: assetFor(`${origin.url}/component.zip`), destination });

      assert.equal(requests, 2);
      assert.deepEqual(await readFile(destination), body);
    });
  } finally {
    await origin.close();
  }
});

test("a local writable ECONNRESET fails fast and cancels the response without retry", async () => {
  let fetches = 0;
  let cancellations = 0;
  const failure = Object.assign(new Error("local_write_reset"), { code: "ECONNRESET" });
  const target = {
    async inspect() { return { size: 0 }; },
    async reset() {},
    async createWriteStream() {
      return new Writable({ write(_chunk, _encoding, callback) { callback(failure); } });
    },
    async verify() { throw new Error("verify_must_not_run"); },
  };
  const manager = createDownloadManager({
    async fetchImpl() {
      fetches += 1;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(body); },
        cancel() { cancellations += 1; },
      }), { status: 200 });
    },
    retryPolicy: { maxAttempts: 3, delayMs: 0 },
  });
  await assert.rejects(manager.downloadPrepared({
    asset: assetFor("https://shanhaiyouling.com/codexbridge-test/packages/component.zip"), target,
  }), (error) => error === failure);
  assert.equal(fetches, 1);
  assert.equal(cancellations, 1);
});

test("an upstream response stream ECONNRESET remains retryable", async () => {
  let fetches = 0;
  const target = {
    async inspect() { return { size: 0 }; },
    async reset() {},
    async createWriteStream() {
      return new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    },
    async verify({ size, sha256 }) { return { size, sha256 }; },
  };
  const manager = createDownloadManager({
    async fetchImpl() {
      fetches += 1;
      if (fetches === 1) {
        return new Response(new ReadableStream({
          start(controller) {
            controller.error(Object.assign(new Error("upstream_reset"), { code: "ECONNRESET" }));
          },
        }), { status: 200 });
      }
      return new Response(body, { status: 200 });
    },
    retryPolicy: { maxAttempts: 2, delayMs: 0 },
  });
  await manager.downloadPrepared({
    asset: assetFor("https://shanhaiyouling.com/codexbridge-test/packages/component.zip"), target,
  });
  assert.equal(fetches, 2);
});

test("deterministic capability, identity, permission, receipt, and hash failures fail fast", async (t) => {
  const cases = [
    ["unknown target error", null, "inspect"],
    ["capability", "workspace_file_size_mismatch", "inspect"],
    ["identity", "windows_identity_changed", "inspect"],
    ["permission", "EACCES", "inspect"],
    ["receipt", "workspace_receipt_consumed", "inspect"],
    ["hash", "workspace_file_hash_mismatch", "verify"],
    ["network-shaped capability error", "ECONNRESET", "inspect"],
  ];
  for (const [name, code, phase] of cases) {
    await t.test(name, async () => {
      let inspections = 0;
      let fetches = 0;
      let verifications = 0;
      const failure = code === null ? new Error("unknown_target_failure") : Object.assign(new Error(code), { code });
      const target = {
        async inspect() {
          inspections += 1;
          if (phase === "inspect") throw failure;
          return { size: 0 };
        },
        async reset() {},
        async createWriteStream() { return new Writable({ write(_chunk, _encoding, callback) { callback(); } }); },
        async verify() { verifications += 1; throw failure; },
      };
      const manager = createDownloadManager({
        async fetchImpl() { fetches += 1; return new Response(body, { status: 200 }); },
        retryPolicy: { maxAttempts: 3, delayMs: 0 },
      });
      await assert.rejects(manager.downloadPrepared({
        asset: assetFor("https://shanhaiyouling.com/codexbridge-test/packages/component.zip"), target,
      }), (error) => error === failure);
      assert.equal(inspections, 1);
      assert.equal(fetches, phase === "verify" ? 1 : 0);
      assert.equal(verifications, phase === "verify" ? 1 : 0);
    });
  }
});

test("cancellation leaves exactly one partial file and never promotes it", async () => {
  const origin = await startServer((request, response) => {
    response.writeHead(200, { "Content-Length": body.length });
    response.write(body.subarray(0, 8));
    const timer = setTimeout(() => response.end(body.subarray(8)), 1_000);
    response.once("close", () => clearTimeout(timer));
  });
  try {
    await withTempDirectory(async ({ directory, destination: fixtureDestination }) => {
      const destination = fixtureDestination();
      const controller = new AbortController();
      const manager = createDownloadManager();

      await assert.rejects(
        manager.download({
          asset: assetFor(`${origin.url}/component.zip`),
          destination,
          signal: controller.signal,
          onProgress() {
            controller.abort();
          }
        }),
        { name: "AbortError" }
      );

      assert.deepEqual(await readdir(directory), ["component.zip.part"]);
      await assert.rejects(stat(destination));
    });
  } finally {
    await origin.close();
  }
});

test("rejects a length mismatch without promoting the partial package", async () => {
  const truncated = body.subarray(0, body.length - 3);
  const origin = await startServer((request, response) => {
    response.writeHead(200, { "Content-Length": truncated.length });
    response.end(truncated);
  });
  try {
    await withTempDirectory(async ({ destination: fixtureDestination }) => {
      const destination = fixtureDestination();
      const manager = createDownloadManager();

      await assert.rejects(manager.download({ asset: assetFor(`${origin.url}/component.zip`), destination }), /length/i);

      assert.deepEqual(await readFile(`${destination}.part`), truncated);
      await assert.rejects(stat(destination));
    });
  } finally {
    await origin.close();
  }
});

test("rejects a SHA256 mismatch without promoting the partial package", async () => {
  const origin = await startServer((request, response) => {
    response.writeHead(200, { "Content-Length": body.length });
    response.end(body);
  });
  try {
    await withTempDirectory(async ({ destination: fixtureDestination }) => {
      const destination = fixtureDestination();
      const manager = createDownloadManager();
      const asset = { ...assetFor(`${origin.url}/component.zip`), sha256: "0".repeat(64) };

      await assert.rejects(manager.download({ asset, destination }), /sha256/i);

      assert.deepEqual(await readFile(`${destination}.part`), body);
      await assert.rejects(stat(destination));
    });
  } finally {
    await origin.close();
  }
});

test("rejects cross-origin redirects before forwarding authorization", async () => {
  let targetRequests = 0;
  let targetAuthorization;
  const target = await startServer((request, response) => {
    targetRequests += 1;
    targetAuthorization = request.headers.authorization;
    response.writeHead(200, { "Content-Length": body.length });
    response.end(body);
  });
  const source = await startServer((request, response) => {
    response.writeHead(302, { Location: `${target.url}/component.zip` });
    response.end();
  });
  try {
    await withTempDirectory(async ({ directory, destination: fixtureDestination }) => {
      const destination = fixtureDestination();
      const manager = createDownloadManager();

      await assert.rejects(
        manager.download({ asset: assetFor(`${source.url}/component.zip`), destination }),
        /redirect.*origin/i
      );

      assert.deepEqual(await readdir(directory), []);
      assert.equal(targetRequests, 0);
      assert.equal(targetAuthorization, undefined);
    });
  } finally {
    await source.close();
    await target.close();
  }
});

test("cancellation during SHA256 verification leaves the partial package unpromoted", async () => {
  let beginHash;
  const hashStarted = new Promise((resolve) => {
    beginHash = resolve;
  });
  let releaseHash;
  const hashCanFinish = new Promise((resolve) => {
    releaseHash = resolve;
  });
  const delayedHashFs = {
    ...await import("node:fs/promises"),
    createWriteStream: fs.createWriteStream,
    createReadStream() {
      return Readable.from((async function* () {
        beginHash();
        yield body.subarray(0, 8);
        await hashCanFinish;
        yield body.subarray(8);
      })());
    }
  };
  const origin = await startServer((request, response) => {
    response.writeHead(200, { "Content-Length": body.length });
    response.end(body);
  });
  try {
    await withTempDirectory(async ({ directory, destination: fixtureDestination }) => {
      const destination = fixtureDestination();
      const controller = new AbortController();
      const manager = createDownloadManager({ fsApi: delayedHashFs });
      const download = manager.download({
        asset: assetFor(`${origin.url}/component.zip`),
        destination,
        signal: controller.signal
      });

      await hashStarted;
      controller.abort();
      releaseHash();

      await assert.rejects(download, { name: "AbortError" });
      assert.deepEqual(await readdir(directory), ["component.zip.part"]);
      assert.deepEqual(await readFile(`${destination}.part`), body);
      await assert.rejects(stat(destination));
    });
  } finally {
    await origin.close();
  }
});
