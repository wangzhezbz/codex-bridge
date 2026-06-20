import test from "node:test";
import assert from "node:assert/strict";
import { callJsonUpstream } from "../src/upstream.js";

test("upstream requests use HTTPS proxy dispatcher when configured", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = snapshotProxyEnv();
  let seenInit = null;

  globalThis.fetch = async (_url, init) => {
    seenInit = init;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    clearProxyEnv();
    process.env.HTTPS_PROXY = "http://127.0.0.1:7890";

    await callJsonUpstream(
      "https://api.openai.com/v1/chat/completions",
      {
        id: "gpt-5.5",
        api: "chat_completions",
        model: "gpt-5.5",
        apiKey: "test-key",
      },
      { model: "gpt-5.5" },
      {},
    );

    assert.ok(seenInit?.dispatcher, "expected fetch init to include proxy dispatcher");
  } finally {
    globalThis.fetch = originalFetch;
    restoreProxyEnv(originalEnv);
  }
});

function snapshotProxyEnv() {
  const keys = proxyEnvKeys();
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function clearProxyEnv() {
  for (const key of proxyEnvKeys()) {
    delete process.env[key];
  }
}

function restoreProxyEnv(snapshot) {
  clearProxyEnv();
  for (const [key, value] of Object.entries(snapshot)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}

function proxyEnvKeys() {
  return [
    "CODEXBRIDGE_HTTPS_PROXY",
    "CODEXBRIDGE_HTTP_PROXY",
    "CODEXBRIDGE_ALL_PROXY",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "https_proxy",
    "http_proxy",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
  ];
}
