import assert from "node:assert/strict";
import test from "node:test";

test("Anthropic custom headers cannot replace trusted authentication headers", async () => {
  const { upstreamHeaders } = await import("../src/upstream-header-policy.js");

  const headers = upstreamHeaders({
    id: "claude",
    api: "anthropic_messages",
    authMode: "anthropic_api_key",
    apiKey: "trusted-anthropic-key",
    headers: {
      "x-api-key": "attacker-key",
      authorization: "Bearer attacker-key",
      "anthropic-version": "1900-01-01",
      "x-safe-custom-header": "preserved",
    },
  });

  assert.equal(headers["x-api-key"], "trusted-anthropic-key");
  assert.equal(headers.authorization, undefined);
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers["x-safe-custom-header"], "preserved");
});

test("Codex headers forward runtime metadata without forwarding client authentication", async () => {
  const { upstreamHeaders } = await import("../src/upstream-header-policy.js");

  const headers = upstreamHeaders(
    {
      id: "gpt-codex",
      authMode: "codex_openai",
      headers: {
        authorization: "Bearer route-attacker-key",
        "x-safe-custom-header": "preserved",
      },
    },
    {
      clientAuth: {
        kind: "codex_openai",
        bearerToken: "trusted-codex-token",
      },
      clientHeaders: {
        authorization: "Bearer client-attacker-key",
        "content-type": "text/plain",
        "x-codex-new-runtime-header": "runtime-123",
        "openai-sentinel-chat-requirements-token": "requirements-123",
      },
    },
    { acceptEventStream: true },
  );

  assert.equal(headers.authorization, "Bearer trusted-codex-token");
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers.accept, "text/event-stream");
  assert.equal(headers["x-safe-custom-header"], "preserved");
  assert.equal(headers["x-codex-new-runtime-header"], "runtime-123");
  assert.equal(headers["openai-sentinel-chat-requirements-token"], "requirements-123");
});

test("response headers omit transport-specific encoding and length metadata", async () => {
  const { filteredHeaders } = await import("../src/upstream-header-policy.js");

  const headers = filteredHeaders(new Headers({
    connection: "keep-alive",
    "content-encoding": "gzip",
    "content-length": "123",
    "content-type": "application/json",
    "keep-alive": "timeout=5",
    "transfer-encoding": "chunked",
    "x-request-id": "req-123",
  }));

  assert.deepEqual(headers, {
    "content-type": "application/json",
    "x-request-id": "req-123",
  });
});

test("streaming upstream requests disable content encoding for stable SSE boundaries", async () => {
  const { upstreamHeaders } = await import("../src/upstream-header-policy.js");

  const headers = upstreamHeaders(
    {
      id: "deepseek-stream",
      api: "chat_completions",
      apiKey: "trusted-key",
      headers: { "accept-encoding": "gzip" },
    },
    {},
    { acceptEventStream: true },
  );

  assert.equal(headers.accept, "text/event-stream");
  assert.equal(headers["accept-encoding"], "identity");
});

test("native Responses streams keep their existing transport path unchanged", async () => {
  const { upstreamHeaders } = await import("../src/upstream-header-policy.js");

  const headers = upstreamHeaders(
    {
      id: "codex-native",
      api: "responses",
      authMode: "codex_openai",
    },
    {
      clientAuth: {
        kind: "codex_openai",
        bearerToken: "trusted-codex-token",
      },
    },
    { acceptEventStream: true },
  );

  assert.equal(headers.accept, "text/event-stream");
  assert.equal(headers["accept-encoding"], undefined);
});
