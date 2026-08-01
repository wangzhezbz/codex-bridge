import assert from "node:assert/strict";
import test from "node:test";

import {
  isNetworkFetchFailure,
  safeText,
  safeUrl,
  UpstreamHttpError,
  UpstreamNetworkError,
  UpstreamStreamError,
  upstreamErrorLogPreview,
} from "../src/upstream-network-errors.js";

test("UpstreamHttpError preserves bounded route and retry metadata", () => {
  const error = new UpstreamHttpError(
    429,
    '{"error":{"message":"rate limited"}}',
    "https://provider.example/v1/responses",
    {
      id: "cb-provider",
      displayName: "Provider",
      model: "model-x",
      api: "responses",
      apiKey: "must-not-copy",
    },
    { headers: new Headers({ "retry-after": "12" }) },
  );

  assert.equal(error.message, "Upstream returned HTTP 429");
  assert.equal(error.statusCode, 429);
  assert.equal(error.bodyText, '{"error":{"message":"rate limited"}}');
  assert.equal(error.upstreamUrl, "https://provider.example/v1/responses");
  assert.equal(error.retryAfter, "12");
  assert.deepEqual(error.route, {
    id: "cb-provider",
    displayName: "Provider",
    model: "model-x",
    api: "responses",
  });
});

test("UpstreamNetworkError produces redacted diagnostics without URL credentials or query secrets", () => {
  const cause = Object.assign(new Error("fetch failed"), {
    cause: { code: "ECONNRESET" },
  });
  const error = new UpstreamNetworkError(
    cause,
    "https://user:password@provider.example/v1/responses?api_key=sk-secret123#fragment",
    {
      id: "cb-provider",
      displayName: "Provider",
      model: "model-x",
      api: "responses",
      apiKey: "must-not-copy",
    },
    "env:http://127.0.0.1:7890",
  );

  assert.equal(error.name, "UpstreamNetworkError");
  assert.equal(error.statusCode, 502);
  assert.equal(error.code, "upstream_network_error");
  assert.equal(error.cause, cause);
  assert.equal(error.proxyLabel, "env:http://127.0.0.1:7890");
  assert.deepEqual(error.route, {
    id: "cb-provider",
    displayName: "Provider",
    model: "model-x",
    api: "responses",
  });
  assert.match(error.message, /Provider \/ cb-provider/);
  assert.match(error.message, /upstream_model=model-x api=responses: ECONNRESET/);
  assert.match(error.message, /proxy=env:http:\/\/127\.0\.0\.1:7890/);
  assert.match(error.message, /url=https:\/\/provider\.example\/v1\/responses$/);
  assert.doesNotMatch(error.message, /password|api_key|secret123|fragment/);
});

test("UpstreamStreamError keeps the stream diagnostic contract", () => {
  const error = new UpstreamStreamError(
    "socket closed while streaming",
    "https://provider.example/v1/responses",
    { id: "cb-provider", displayName: "Provider", model: "model-x", api: "responses" },
    "upstream_stream_truncated",
  );

  assert.equal(error.name, "UpstreamStreamError");
  assert.equal(error.statusCode, 502);
  assert.equal(error.code, "upstream_stream_truncated");
  assert.equal(error.upstreamUrl, "https://provider.example/v1/responses");
  assert.deepEqual(error.route, {
    id: "cb-provider",
    displayName: "Provider",
    model: "model-x",
    api: "responses",
  });
});

test("network failure classification accepts transport failures and rejects HTTP errors", () => {
  assert.equal(isNetworkFetchFailure(new Error("fetch failed")), true);
  assert.equal(
    isNetworkFetchFailure(Object.assign(new Error("request error"), { cause: { code: "UND_ERR_SOCKET" } })),
    true,
  );
  assert.equal(
    isNetworkFetchFailure(Object.assign(new Error("request error"), { cause: { code: "ETIMEDOUT" } })),
    true,
  );
  assert.equal(isNetworkFetchFailure(new Error("Upstream returned HTTP 502")), false);
  assert.equal(isNetworkFetchFailure(null), false);
});

test("network diagnostic formatting redacts secrets, collapses whitespace, and bounds previews", () => {
  assert.equal(
    safeText("Bearer abcdefgh\r\n next", 80),
    "Bearer [REDACTED] next",
  );
  assert.equal(safeText("123456789", 5), "12345");
  assert.equal(
    safeUrl("https://provider.example/v1/responses?token=secret#fragment"),
    "https://provider.example/v1/responses",
  );
  assert.equal(safeUrl("not a URL"), "not a URL");

  const httpError = new UpstreamHttpError(
    400,
    "Bearer abcdefgh\r\n bad request",
    "https://provider.example/v1/responses",
  );
  assert.equal(upstreamErrorLogPreview(httpError), " body=Bearer [REDACTED] bad request");
  assert.equal(upstreamErrorLogPreview(new Error("ordinary failure")), "");
});
