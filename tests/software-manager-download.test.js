import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { createDownloadManager } from "../desktop/software-manager/download-manager.mjs";

const body = Buffer.from("CodexBridge component package: resumable and verified.");

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
      assert.equal(progress.at(-1).receivedBytes, body.length);
      assert.equal(progress.at(-1).totalBytes, body.length);
      assert.equal(progress.at(-1).percent, 100);
      assert.equal(progress.at(-1).phase, "download");
      assert.equal(typeof progress.at(-1).bytesPerSecond, "number");
    });
  } finally {
    await origin.close();
  }
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
