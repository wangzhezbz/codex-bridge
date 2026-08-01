import assert from "node:assert/strict";
import test from "node:test";

class TestUpstreamHttpError extends Error {
  constructor(statusCode, bodyText = "") {
    super(`Upstream returned HTTP ${statusCode}`);
    this.statusCode = statusCode;
    this.bodyText = bodyText;
  }
}

async function fallbackPolicy() {
  const { createUpstreamUrlFallbackPolicy } = await import(
    "../src/upstream-url-fallback.js"
  );
  return createUpstreamUrlFallbackPolicy({
    UpstreamHttpError: TestUpstreamHttpError,
  });
}

test("root provider URLs produce versioned Chat and Responses fallbacks", async () => {
  const {
    chatCompletionsRootFallbackUrl,
    responsesV1FallbackUrl,
  } = await fallbackPolicy();
  const route = { baseUrl: "https://provider.example/?tenant=ignored#section" };

  assert.equal(
    chatCompletionsRootFallbackUrl(
      route,
      "https://provider.example/chat/completions",
    ),
    "https://provider.example/v1/chat/completions",
  );
  assert.equal(
    responsesV1FallbackUrl(
      route,
      "https://provider.example/responses",
      "/responses",
    ),
    "https://provider.example/v1/responses",
  );
});

test("versioned or endpoint base URLs do not produce root fallbacks", async () => {
  const {
    chatCompletionsRootFallbackUrl,
    responsesV1FallbackUrl,
  } = await fallbackPolicy();

  assert.equal(
    chatCompletionsRootFallbackUrl(
      { baseUrl: "https://provider.example/v1" },
      "https://provider.example/v1/chat/completions",
    ),
    "",
  );
  assert.equal(
    responsesV1FallbackUrl(
      { baseUrl: "https://provider.example/v1/responses" },
      "https://provider.example/v1/responses",
    ),
    "",
  );
});

test("Chat fallback requires the expected non-JSON HTML error", async () => {
  const { chatCompletionsV1FallbackUrl } = await fallbackPolicy();
  const route = { baseUrl: "https://provider.example" };
  const upstreamUrl = "https://provider.example/chat/completions";

  assert.equal(
    chatCompletionsV1FallbackUrl(
      route,
      upstreamUrl,
      new TestUpstreamHttpError(
        502,
        "Upstream returned non-JSON body: <!doctype html><html><body>portal</body></html>",
      ),
    ),
    "https://provider.example/v1/chat/completions",
  );
  assert.equal(
    chatCompletionsV1FallbackUrl(
      route,
      upstreamUrl,
      new TestUpstreamHttpError(502, "Upstream returned non-JSON body: plain text"),
    ),
    "",
  );
  assert.equal(
    chatCompletionsV1FallbackUrl(
      route,
      upstreamUrl,
      new TestUpstreamHttpError(400, "<!doctype html><html></html>"),
    ),
    "",
  );
});

test("HTML response detection reads the content type without consuming the body", async () => {
  const { upstreamResponseLooksHtml } = await fallbackPolicy();

  assert.equal(
    upstreamResponseLooksHtml({
      headers: { get: () => "text/html; charset=utf-8" },
    }),
    true,
  );
  assert.equal(
    upstreamResponseLooksHtml({
      headers: { get: () => "application/json" },
    }),
    false,
  );
});
