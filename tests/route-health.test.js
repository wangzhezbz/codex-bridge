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
