import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyUpstreamError,
  createRouteHealthStore,
} from "../src/route-health.js";

test("classifyUpstreamError separates common upstream failure categories", () => {
  assert.equal(
    classifyUpstreamError({
      statusCode: 401,
      bodyText: JSON.stringify({ error: { message: "Invalid API key" } }),
    }).type,
    "authentication_error",
  );
  assert.equal(
    classifyUpstreamError({
      statusCode: 415,
      bodyText: JSON.stringify({ error: { message: "Unsupported media type: input_image" } }),
    }).type,
    "media_unsupported",
  );
  assert.equal(
    classifyUpstreamError(
      {
        statusCode: 400,
        bodyText: JSON.stringify({ detail: "Stream must be set to true" }),
      },
      { compactKind: "v2" },
    ).type,
    "compact_unsupported",
  );
  assert.equal(
    classifyUpstreamError({
      name: "UpstreamNetworkError",
      statusCode: 502,
      code: "upstream_network_error",
      message: "CodexBridge network error",
    }).code,
    "upstream_network_error",
  );
  assert.equal(
    classifyUpstreamError({
      statusCode: 503,
      bodyText: JSON.stringify({
        error: {
          message: "No available channel for model Agnes 2.0 Flash under group default (distributor)",
        },
      }),
    }).code,
    "upstream_provider_unavailable",
  );
  const payloadTooLarge = classifyUpstreamError({
    statusCode: 413,
    bodyText: JSON.stringify({
      error: {
        message: "Payload Too Large: nginx client_max_body_size exceeded",
      },
    }),
  });
  assert.equal(payloadTooLarge.type, "payload_too_large");
  assert.equal(payloadTooLarge.code, "upstream_payload_too_large");
});

test("route health snapshot reports degraded routes and recovers after success", () => {
  let now = Date.parse("2026-06-25T00:00:00.000Z");
  const store = createRouteHealthStore({
    now: () => now,
    rateLimitStatus: () => ({
      cooldownRemainingMs: 0,
      nextAfterMs: 0,
    }),
  });
  const route = {
    id: "deepseek-v4-pro",
    provider: "deepseek",
    api: "chat_completions",
    model: "deepseek-v4-pro",
  };

  store.recordError(route, {
    statusCode: 400,
    bodyText: JSON.stringify({ error: { message: "Unknown parameter: reasoning" } }),
  });
  let snapshot = store.snapshot({ models: [route] });
  assert.equal(snapshot.unhealthyRoutes, 1);
  assert.equal(snapshot.routes[0].status, "degraded");
  assert.equal(snapshot.routes[0].lastErrorType, "parameter_error");

  now += 1000;
  store.recordSuccess(route);
  snapshot = store.snapshot({ models: [route] });
  assert.equal(snapshot.unhealthyRoutes, 0);
  assert.equal(snapshot.routes[0].status, "healthy");
  assert.equal(snapshot.routes[0].lastErrorType, "parameter_error");
});

test("route health redacts provider account identifiers from upstream errors", () => {
  const store = createRouteHealthStore({
    rateLimitStatus: () => ({
      cooldownRemainingMs: 0,
      nextAfterMs: 0,
    }),
  });
  const route = {
    id: "kimi-k2-code",
    provider: "kimi",
    api: "chat_completions",
    model: "kimi-k2-code",
  };

  store.recordError(route, {
    statusCode: 429,
    bodyText: JSON.stringify({
      error: {
        message:
          "Your account org-testfixtures000000000 / proj-testfixtures000000000 <ak-testfixtures000000000> request reached organization TPD rate limit",
      },
    }),
  });
  const snapshot = store.snapshot({ models: [route] });
  const lastError = snapshot.routes[0].lastError;

  assert.match(lastError, /TPD rate limit/);
  assert.doesNotMatch(lastError, /ak-testfixtures000000000/);
  assert.doesNotMatch(lastError, /org-testfixtures000000000/);
  assert.doesNotMatch(lastError, /proj-testfixtures000000000/);
  assert.match(lastError, /ak-\[REDACTED\]/);
  assert.match(lastError, /org-\[REDACTED\]/);
  assert.match(lastError, /proj-\[REDACTED\]/);
});

test("route health snapshot includes effective upstream proxy label", () => {
  const original = captureProxyEnv();
  process.env.CODEXBRIDGE_HTTPS_PROXY = "http://user:pass@127.0.0.1:7890";
  process.env.NO_PROXY = "";
  process.env.no_proxy = "";

  try {
    const store = createRouteHealthStore({
      rateLimitStatus: () => ({
        cooldownRemainingMs: 0,
        nextAfterMs: 0,
      }),
    });
    const snapshot = store.snapshot({
      models: [
        {
          id: "gpt-5.5",
          api: "responses",
          model: "gpt-5.5",
          baseUrl: "https://api.openai.com/v1",
        },
      ],
    });

    assert.match(snapshot.routes[0].proxy, /env:http:\/\/\*\*\*:\*\*\*@127\.0\.0\.1:7890/);
    assert.doesNotMatch(snapshot.routes[0].proxy, /user:pass/);
  } finally {
    restoreProxyEnv(original);
  }
});

function captureProxyEnv() {
  const keys = [
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
  const values = {};
  for (const key of keys) {
    values[key] = process.env[key];
    delete process.env[key];
  }
  return values;
}

function restoreProxyEnv(values) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
