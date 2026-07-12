import test from "node:test";
import assert from "node:assert/strict";

import { evaluateRouteContractMatrix } from "../src/route-contract-matrix.js";

function route(overrides = {}) {
  return {
    id: "cb-chat",
    displayName: "Chat",
    provider: "qwen",
    api: "chat_completions",
    model: "qwen-plus",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: "test-key",
    contextWindow: 128000,
    ...overrides,
  };
}

function baseConfig(overrides = {}) {
  return {
    defaultModel: "cb-chat",
    smartRouting: {
      autoSelectModel: true,
      autoFailover: true,
      failover: {
        mode: "ordered",
        routeIds: ["cb-code", "cb-long"],
      },
    },
    codexAuxiliaryTasks: {
      intercept: false,
      routeId: "cb-helper",
    },
    models: [
      route(),
      route({
        id: "cb-code",
        displayName: "Code",
        provider: "openai",
        api: "responses",
        model: "gpt-5.5",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 258400,
      }),
      route({
        id: "cb-long",
        displayName: "Long",
        provider: "kimi",
        model: "kimi-k2.7-code",
        baseUrl: "https://api.moonshot.cn/v1",
        contextWindow: 1000000,
      }),
      route({
        id: "cb-helper",
        displayName: "Helper",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        baseUrl: "https://api.deepseek.com/v1",
      }),
      route({
        id: "cb-image",
        displayName: "Image Proxy",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        baseUrl: "https://api.deepseek.com/v1",
        imageGeneration: {
          mode: "custom",
          baseUrl: "https://images.example/v1",
          endpoint: "/images/generations",
          model: "image-model",
          apiKey: "image-key",
        },
      }),
    ],
    ...overrides,
  };
}

test("evaluateRouteContractMatrix verifies the golden routing contract in one report", () => {
  const config = baseConfig();
  const report = evaluateRouteContractMatrix(config, [
    {
      id: "manual-route",
      kind: "route",
      request: { model: "cb-chat", input: "hello" },
      expect: {
        routeId: "cb-chat",
        requestKind: "normal",
        reason: "manual_route",
        decisionVersion: "route-decision-v2",
      },
    },
    {
      id: "stale-codex-model",
      kind: "route",
      request: { model: "cb-deleted", input: "hello" },
      options: { isCodexClient: true, routeOptions: { exactModelIdOnly: true } },
      expect: {
        routeId: "cb-chat",
        requestKind: "stale_codex_model",
        reason: "stale_model_fallback",
      },
    },
    {
      id: "auxiliary-helper",
      kind: "route",
      request: { model: "gpt-5.4-mini", input: "compact this" },
      options: { isCodexClient: true, routeOptions: { exactModelIdOnly: true } },
      expect: {
        routeId: "cb-helper",
        requestKind: "codex_auxiliary",
        reason: "codex_auxiliary_task",
        rewriteModel: "deepseek-v4-flash",
      },
    },
    {
      id: "auxiliary-deleted",
      kind: "route",
      config: baseConfig({
        codexAuxiliaryTasks: {
          intercept: false,
          routeId: "cb-deleted-helper",
        },
      }),
      request: { model: "gpt-5.4-mini", input: "compact this" },
      options: { isCodexClient: true, routeOptions: { exactModelIdOnly: true } },
      expectErrorCode: "auxiliary_route_not_available",
    },
    {
      id: "image-generation",
      kind: "route",
      request: { model: "cb-chat", input: "generate an image of a small cat" },
      expect: {
        routeId: "cb-image",
        reason: "image_generation_task",
      },
    },
    {
      id: "long-context",
      kind: "route",
      request: { model: "cb-chat", input: "summarize\n" + "data ".repeat(12000) },
      expect: {
        routeId: "cb-long",
        reason: "long_context_task",
      },
    },
    {
      id: "ordered-failover",
      kind: "failover",
      currentRouteId: "cb-chat",
      error: { statusCode: 502, message: "bad gateway" },
      expect: {
        routeId: "cb-code",
        reason: "upstream_unavailable",
      },
    },
  ]);

  assert.equal(report.ok, true);
  assert.deepEqual(report.summary, {
    total: 7,
    passed: 7,
    failed: 0,
  });
  assert.deepEqual(
    report.rows.map((row) => [row.id, row.ok, row.actual.routeId || row.actual.errorCode]),
    [
      ["manual-route", true, "cb-chat"],
      ["stale-codex-model", true, "cb-chat"],
      ["auxiliary-helper", true, "cb-helper"],
      ["auxiliary-deleted", true, "auxiliary_route_not_available"],
      ["image-generation", true, "cb-image"],
      ["long-context", true, "cb-long"],
      ["ordered-failover", true, "cb-code"],
    ],
  );
});
