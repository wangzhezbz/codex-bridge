import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createHttpServer } from "../vendor/chatgpt-codex-bridge/src/http-server.js";

test("embedded bridge rejects untrusted browser origins", async (t) => {
  const origin = await startBridgeServer(t);

  const response = await fetch(`${origin}/health`, {
    headers: { Origin: "https://attacker.example" },
  });

  assert.equal(response.status, 403);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("embedded bridge echoes only trusted browser origins", async (t) => {
  const origin = await startBridgeServer(t);
  const trustedOrigins = [
    "https://chatgpt.com",
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    origin,
  ];

  for (const trustedOrigin of trustedOrigins) {
    const response = await fetch(`${origin}/health`, {
      headers: { Origin: trustedOrigin },
    });

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("access-control-allow-origin"),
      trustedOrigin,
    );
    assert.match(response.headers.get("vary") || "", /(?:^|,\s*)Origin(?:,|$)/i);
  }
});

test("embedded bridge keeps non-browser local clients origin-free", async (t) => {
  const origin = await startBridgeServer(t);

  const response = await fetch(`${origin}/health`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("embedded bridge rejects a forged Host even when Origin matches it", async (t) => {
  const origin = await startBridgeServer(t);
  const port = new URL(origin).port;

  const response = await rawRequest(origin, {
    Host: `attacker.example:${port}`,
    Origin: `http://attacker.example:${port}`,
  });

  assert.equal(response.status, 403);
  assert.equal(response.allowOrigin, null);
});

test("embedded bridge requires its configured token for cross-origin API calls", async (t) => {
  const origin = await startBridgeServer(t, { authToken: "bridge-test-token" });
  const extensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

  for (const token of [null, "wrong-token"]) {
    const response = await fetch(`${origin}/api/config`, {
      headers: {
        Origin: extensionOrigin,
        ...(token ? { "X-CodexBridge-Token": token } : {}),
      },
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("access-control-allow-origin"), extensionOrigin);
  }

  const authorized = await fetch(`${origin}/api/config`, {
    headers: {
      Origin: extensionOrigin,
      "X-CodexBridge-Token": "bridge-test-token",
    },
  });
  assert.equal(authorized.status, 200);

  const sameOrigin = await fetch(`${origin}/api/config`, {
    headers: { Origin: origin },
  });
  assert.equal(sameOrigin.status, 200);
});

test("embedded bridge requires its token for sensitive download imports from every origin", async (t) => {
  const origin = await startBridgeServer(t, { authToken: "bridge-test-token" });
  const body = JSON.stringify({
    filename: "small.txt",
    contentType: "text/plain",
    base64Data: Buffer.from("hello").toString("base64"),
  });

  for (const headers of [{}, { Origin: origin }]) {
    const response = await fetch(`${origin}/api/downloads/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
    assert.equal(response.status, 401);
  }

  const authorized = await fetch(`${origin}/api/downloads/import`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-CodexBridge-Token": "bridge-test-token",
    },
    body,
  });
  assert.equal(authorized.status, 201);
});

test("embedded bridge rejects JSON bodies above its configured byte limit", async (t) => {
  const origin = await startBridgeServer(t, { maxJsonBodyBytes: 64 });

  const response = await fetch(`${origin}/api/extension/heartbeat`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ workerId: "x".repeat(128) }),
  });

  assert.equal(response.status, 413);
  assert.match(await response.text(), /too large/i);
});

async function startBridgeServer(t, options = {}) {
  const server = createHttpServer({
    storeRoot: path.join(
      tmpdir(),
      `codexbridge-vendor-http-security-${process.pid}-${Math.random().toString(16).slice(2)}`,
    ),
    ...options,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function rawRequest(origin, headers) {
  const url = new URL("/health", origin);
  return new Promise((resolve, reject) => {
    const request = http.request(url, { headers }, (response) => {
      response.resume();
      response.once("end", () => {
        resolve({
          status: response.statusCode,
          allowOrigin: response.headers["access-control-allow-origin"] || null,
        });
      });
    });
    request.once("error", reject);
    request.end();
  });
}
