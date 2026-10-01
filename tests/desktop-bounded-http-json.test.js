import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import boundedHttp from "../desktop/bounded-http-json.cjs";

const { requestBoundedJsonOverHttp } = boundedHttp;

test("bounded local HTTP JSON probe parses a normal response", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await listen(server);
  try {
    assert.deepEqual(await requestBoundedJsonOverHttp(serverUrl(server)), { ok: true });
  } finally {
    await close(server);
  }
});

test("bounded local HTTP JSON probe stops a body stalled after response headers", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.flushHeaders();
  });
  await listen(server);
  const startedAt = Date.now();
  try {
    const result = await requestBoundedJsonOverHttp(serverUrl(server), { timeoutMs: 25 });
    assert.equal(result, null);
    assert.ok(Date.now() - startedAt < 500);
  } finally {
    server.closeAllConnections?.();
    await close(server);
  }
});

test("bounded local HTTP JSON probe rejects declared and chunked oversized bodies", async () => {
  for (const declared of [true, false]) {
    const server = http.createServer((_req, res) => {
      const bytes = Buffer.from(JSON.stringify({ value: "x".repeat(128) }));
      res.writeHead(200, {
        "content-type": "application/json",
        ...(declared ? { "content-length": String(bytes.length) } : {}),
      });
      res.end(bytes);
    });
    await listen(server);
    try {
      assert.equal(await requestBoundedJsonOverHttp(serverUrl(server), { maxBytes: 32 }), null);
    } finally {
      server.closeAllConnections?.();
      await close(server);
    }
  }
});

test("bounded local HTTP JSON probe maps invalid JSON and non-success status to null", async () => {
  let requestCount = 0;
  const server = http.createServer((_req, res) => {
    requestCount += 1;
    res.writeHead(requestCount === 1 ? 200 : 503, { "content-type": "application/json" });
    res.end(requestCount === 1 ? "{" : JSON.stringify({ error: true }));
  });
  await listen(server);
  try {
    assert.equal(await requestBoundedJsonOverHttp(serverUrl(server)), null);
    assert.equal(await requestBoundedJsonOverHttp(serverUrl(server)), null);
  } finally {
    await close(server);
  }
});

function serverUrl(server) {
  return `http://127.0.0.1:${server.address().port}/health`;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}
