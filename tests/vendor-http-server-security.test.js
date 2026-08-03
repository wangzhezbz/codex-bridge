import assert from "node:assert/strict";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createHttpServer } from "../vendor/chatgpt-codex-bridge/src/http-server.js";

test("embedded bridge rejects untrusted browser origins", async (t) => {
  const origin = await startBridgeServer(t);

  const response = await fetch(`${origin}/api/config`, {
    headers: { Origin: "https://attacker.example" },
  });

  assert.equal(response.status, 403);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("embedded bridge echoes only trusted browser origins", async (t) => {
  const origin = await startBridgeServer(t);
  const trustedOrigins = [
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    origin,
  ];

  for (const trustedOrigin of trustedOrigins) {
    const response = await fetch(`${origin}/api/config`, {
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

test("embedded bridge requires its configured token for browser mutations", async (t) => {
  const origin = await startBridgeServer(t, { apiToken: "bridge-test-token" });
  const body = JSON.stringify({ title: "Protected task", prompt: "test", run: false });

  for (const token of [null, "wrong-token"]) {
    const response = await fetch(`${origin}/api/tasks`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...(token ? { "X-Bridge-Token": token } : {}),
      },
      body,
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
  }

  const authorized = await fetch(`${origin}/api/tasks`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Bridge-Token": "bridge-test-token",
    },
    body,
  });
  assert.equal(authorized.status, 201);
});

test("embedded bridge exposes only the scoped token headers to the extension", async (t) => {
  const origin = await startBridgeServer(t, { apiToken: "bridge-test-token" });
  const extensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  const response = await fetch(`${origin}/api/extension/heartbeat`, {
    method: "OPTIONS",
    headers: {
      Origin: extensionOrigin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,x-bridge-token,x-bridge-scope",
    },
  });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), extensionOrigin);
  assert.equal(
    response.headers.get("access-control-allow-headers"),
    "Content-Type, X-Bridge-Token, X-Bridge-Scope",
  );
});

test("embedded bridge rejects JSON bodies above its configured byte limit", async (t) => {
  const origin = await startBridgeServer(t, { maxJsonBodyBytes: 64 });

  const response = await fetch(`${origin}/api/extension/heartbeat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ workerId: "x".repeat(128) }),
  });

  assert.equal(response.status, 413);
  assert.match(await response.text(), /exceeds.*limit/i);
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
