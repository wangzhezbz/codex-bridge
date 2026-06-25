import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODEL_PRESETS } from "../desktop/presets.mjs";
import {
  buildRouterConfigFromSelection,
  saveCustomModel,
  saveSelection,
} from "../desktop/settings.mjs";
import {
  adapterIdForRoute,
  filterPayloadForAdapter,
  normalizeAdapterProfile,
} from "../src/adapter-profile.js";

test("adapter profiles classify native responses routes", () => {
  const profile = normalizeAdapterProfile({
    id: "gpt-5.5",
    provider: "codex",
    api: "responses",
    model: "gpt-5.5",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    authMode: "codex_openai",
    contextWindow: 258400,
    inputModalities: ["text", "image"],
  });

  assert.equal(profile.adapterId, "responses-native");
  assert.equal(profile.providerFamily, "openai");
  assert.equal(profile.supportsTools, "native");
  assert.equal(profile.supportsImages, "native");
  assert.equal(profile.supportsFiles, "native");
  assert.equal(profile.supportsResponsePreviousId, true);
  assert.ok(profile.safeParams.includes("previous_response_id"));
});

test("adapter profiles classify DeepSeek chat routes", () => {
  const profile = normalizeAdapterProfile({
    id: "gpt-5.4-mini",
    provider: "deepseek",
    api: "chat_completions",
    model: "deepseek-v4-pro",
    baseUrl: "https://api.deepseek.com/v1",
    contextWindow: 1000000,
    dropParams: ["response_format", "parallel_tool_calls"],
  });

  assert.equal(profile.adapterId, "chat-deepseek");
  assert.equal(profile.providerFamily, "deepseek");
  assert.equal(profile.supportsTools, "chat-functions");
  assert.equal(profile.supportsMcpNamespaces, true);
  assert.equal(profile.supportsImages, "none");
  assert.equal(profile.maxToolContinuationTurns, 2);
  assert.ok(profile.dropParams.includes("response_format"));
});

test("adapter profiles classify Kimi chat routes with image-url support", () => {
  const profile = normalizeAdapterProfile({
    id: "gpt-5.2",
    provider: "kimi",
    api: "chat_completions",
    model: "kimi-k2.7-code",
    baseUrl: "https://api.moonshot.cn/v1",
    contextWindow: 258400,
    inputModalities: ["text", "image"],
    dropParams: ["response_format", "parallel_tool_calls"],
  });

  assert.equal(profile.adapterId, "chat-kimi");
  assert.equal(profile.providerFamily, "kimi");
  assert.equal(profile.supportsImages, "chat-image-url");
  assert.equal(profile.supportsFiles, "text-placeholder");
});

test("custom chat routes default to conservative text-only behavior", () => {
  const profile = normalizeAdapterProfile({
    id: "custom-model",
    custom: true,
    provider: "custom",
    api: "chat_completions",
    model: "custom-model",
    baseUrl: "https://example.invalid/v1",
    contextWindow: 258400,
  });

  assert.equal(profile.adapterId, "custom-conservative");
  assert.equal(profile.customConservative, true);
  assert.equal(profile.supportsTools, "chat-functions");
  assert.equal(profile.supportsMcpNamespaces, true);
  assert.equal(profile.supportsImages, "none");
  assert.equal(profile.supportsFiles, "none");
  assert.ok(profile.safeParams.includes("tools"));
  assert.ok(profile.safeParams.includes("tool_choice"));
  assert.ok(!profile.safeParams.includes("parallel_tool_calls"));
  assert.ok(!profile.safeParams.includes("response_format"));
  assert.deepEqual(profile.dropParams, [
    "parallel_tool_calls",
    "response_format",
  ]);
});

test("custom chat routes preserve explicit image input in the adapter profile", () => {
  const profile = normalizeAdapterProfile({
    id: "custom-model",
    custom: true,
    provider: "custom",
    api: "chat_completions",
    model: "custom-model",
    baseUrl: "https://example.invalid/v1",
    contextWindow: 258400,
    inputModalities: ["text", "image"],
  });

  assert.equal(profile.customConservative, true);
  assert.equal(profile.supportsImages, "chat-image-url");
  assert.equal(profile.supportsTools, "chat-functions");
  assert.equal(profile.supportsMcpNamespaces, true);
  assert.equal(profile.supportsFiles, "none");
  assert.ok(profile.safeParams.includes("tools"));
  assert.ok(profile.safeParams.includes("tool_choice"));
  assert.ok(!profile.safeParams.includes("parallel_tool_calls"));
  assert.ok(!profile.safeParams.includes("response_format"));
  assert.deepEqual(profile.dropParams, [
    "parallel_tool_calls",
    "response_format",
  ]);
});

test("every built-in preset has an adapter profile", () => {
  const missing = [];
  for (const preset of MODEL_PRESETS) {
    const profile = normalizeAdapterProfile({
      ...preset,
      provider: preset.providerId,
      id: preset.presetId,
    });
    if (!profile.adapterId || !profile.providerFamily || !profile.safeParams.length) {
      missing.push(preset.presetId);
    }
  }
  assert.deepEqual(missing, []);
});

test("all generated selected routes preserve provider identity for adapter profiles", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "codexbridge-adapter-routes-"));
  saveSelection(rootDir, [
    "codex-gpt-5-5",
    "deepseek-v4-pro",
    "kimi-k2-7-code",
    "minimax-m3",
    "doubao-seed-1-8",
  ]);

  const config = buildRouterConfigFromSelection(rootDir, "hybrid");
  const routesWithoutProvider = config.models
    .filter((route) => !route.provider)
    .map((route) => route.id);

  assert.deepEqual(routesWithoutProvider, []);
  for (const route of config.models) {
    const profile = normalizeAdapterProfile(route);
    assert.equal(route.providerFamily, profile.providerFamily, route.id);
    assert.ok(profile.adapterId, route.id);
  }
});

test("custom model generated route remains conservative until image input is enabled", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "codexbridge-custom-profile-"));
  const custom = saveCustomModel(rootDir, {
    providerId: "custom",
    displayName: "My Custom Chat",
    baseUrl: "https://example.invalid/v1",
    model: "my-custom-chat",
    api: "chat_completions",
    apiKeyEnv: "CUSTOM_API_KEY",
  });
  saveSelection(rootDir, [custom.presetId]);

  const config = buildRouterConfigFromSelection(rootDir, "hybrid");
  const route = config.models[0];
  const profile = normalizeAdapterProfile(route);

  assert.equal(route.custom, true);
  assert.equal(route.providerFamily, "custom");
  assert.deepEqual(route.inputModalities, ["text"]);
  assert.equal(profile.adapterId, "custom-conservative");
  assert.equal(profile.supportsTools, "chat-functions");
  assert.equal(profile.supportsMcpNamespaces, true);
  assert.equal(profile.supportsImages, "none");
  assert.ok(profile.safeParams.includes("tools"));
  assert.ok(profile.safeParams.includes("tool_choice"));
  assert.ok(!profile.safeParams.includes("response_format"));
  assert.ok(!profile.safeParams.includes("parallel_tool_calls"));
  assert.ok(profile.dropParams.includes("response_format"));
  assert.ok(profile.dropParams.includes("parallel_tool_calls"));
});

const BUILT_IN_PROVIDER_CONTRACTS = {
  codex: {
    providerFamily: "openai",
    adapterId: "responses-native",
    api: "responses",
    supportsTools: "native",
    supportsFiles: "native",
    supportsResponsePreviousId: true,
  },
  openai: {
    providerFamily: "openai",
    adapterId: "responses-native",
    api: "responses",
    supportsTools: "native",
    supportsFiles: "native",
    supportsResponsePreviousId: true,
  },
  deepseek: {
    providerFamily: "deepseek",
    adapterId: "chat-deepseek",
    api: "chat_completions",
    supportsTools: "chat-functions",
    supportsFiles: "text-placeholder",
    supportsResponsePreviousId: false,
  },
  kimi: {
    providerFamily: "kimi",
    adapterId: "chat-kimi",
    api: "chat_completions",
    supportsTools: "chat-functions",
    supportsFiles: "text-placeholder",
    supportsResponsePreviousId: false,
  },
  xiaomi: {
    providerFamily: "openai-compatible",
    adapterId: "chat-openai-compatible",
    api: "chat_completions",
    supportsTools: "chat-functions",
    supportsFiles: "text-placeholder",
    supportsResponsePreviousId: false,
  },
  minimax: {
    providerFamily: "minimax",
    adapterId: "chat-minimax",
    api: "chat_completions",
    supportsTools: "chat-functions",
    supportsFiles: "text-placeholder",
    supportsResponsePreviousId: false,
  },
  stepfun: {
    providerFamily: "openai-compatible",
    adapterId: "chat-openai-compatible",
    api: "chat_completions",
    supportsTools: "chat-functions",
    supportsFiles: "text-placeholder",
    supportsResponsePreviousId: false,
  },
  qianfan: {
    providerFamily: "baidu",
    adapterId: "chat-openai-compatible",
    api: "chat_completions",
    supportsTools: "chat-functions",
    supportsFiles: "text-placeholder",
    supportsResponsePreviousId: false,
  },
  hunyuan: {
    providerFamily: "openai-compatible",
    adapterId: "chat-openai-compatible",
    api: "chat_completions",
    supportsTools: "chat-functions",
    supportsFiles: "text-placeholder",
    supportsResponsePreviousId: false,
  },
  volcengine: {
    providerFamily: "doubao",
    adapterId: "chat-doubao",
    api: "chat_completions",
    supportsTools: "chat-functions",
    supportsFiles: "text-placeholder",
    supportsResponsePreviousId: false,
  },
  qwen: {
    providerFamily: "qwen",
    adapterId: "chat-qwen",
    api: "chat_completions",
    supportsTools: "chat-functions",
    supportsFiles: "text-placeholder",
    supportsResponsePreviousId: false,
  },
  zhipu: {
    providerFamily: "openai-compatible",
    adapterId: "chat-openai-compatible",
    api: "chat_completions",
    supportsTools: "chat-functions",
    supportsFiles: "text-placeholder",
    supportsResponsePreviousId: false,
  },
  openrouter: {
    providerFamily: "openai-compatible",
    adapterId: "chat-openai-compatible",
    api: "chat_completions",
    supportsTools: "chat-functions",
    supportsFiles: "text-placeholder",
    supportsResponsePreviousId: false,
  },
  siliconflow: {
    providerFamily: "openai-compatible",
    adapterId: "chat-openai-compatible",
    api: "chat_completions",
    supportsTools: "chat-functions",
    supportsFiles: "text-placeholder",
    supportsResponsePreviousId: false,
  },
};

function expectedImageSupport(profileApi, inputModalities) {
  if (!Array.isArray(inputModalities) || !inputModalities.includes("image")) {
    return "none";
  }

  return profileApi === "responses" ? "native" : "chat-image-url";
}

const BUILT_IN_PROVIDER_IDS = [...new Set(MODEL_PRESETS.map((route) => route.providerId))].sort();
const EXPECTED_PROVIDER_IDS = Object.keys(BUILT_IN_PROVIDER_CONTRACTS).sort();

test("built-in preset providerId set matches shipped categories", () => {
  assert.deepEqual(BUILT_IN_PROVIDER_IDS, EXPECTED_PROVIDER_IDS);
});

test("built-in presets cover required provider categories", () => {
  const categories = new Set(
    MODEL_PRESETS.map((preset) =>
      normalizeAdapterProfile({
        ...preset,
        id: preset.presetId,
        provider: preset.providerId,
      }).adapterId,
    ),
  );

  for (const required of [
    "responses-native",
    "chat-deepseek",
    "chat-kimi",
    "chat-minimax",
    "chat-doubao",
    "chat-qwen",
    "chat-openai-compatible",
  ]) {
    assert.equal(categories.has(required), true, `${required} missing`);
  }
});

const MODEL_PRESETS_BY_PROVIDER_ID = new Map();
for (const route of MODEL_PRESETS) {
  const routes = MODEL_PRESETS_BY_PROVIDER_ID.get(route.providerId) || [];
  routes.push(route);
  MODEL_PRESETS_BY_PROVIDER_ID.set(route.providerId, routes);
}

for (const [providerId, expected] of Object.entries(BUILT_IN_PROVIDER_CONTRACTS)) {
  test(`built-in preset contract: ${providerId}`, () => {
    const routes = MODEL_PRESETS_BY_PROVIDER_ID.get(providerId);
    assert.ok(routes, `missing presets for providerId: ${providerId}`);

    for (const route of routes) {
      const profile = normalizeAdapterProfile(route);

      assert.equal(profile.providerFamily, expected.providerFamily, `${route.presetId} providerFamily`);
      assert.equal(profile.adapterId, expected.adapterId, `${route.presetId} adapterId`);
      assert.equal(profile.api, expected.api, `${route.presetId} api`);
      assert.equal(profile.supportsTools, expected.supportsTools, `${route.presetId} supportsTools`);
      assert.equal(profile.supportsFiles, expected.supportsFiles, `${route.presetId} supportsFiles`);
      assert.equal(profile.supportsResponsePreviousId, expected.supportsResponsePreviousId, `${route.presetId} supportsResponsePreviousId`);
      assert.equal(profile.supportsImages, expectedImageSupport(profile.api, route.inputModalities), `${route.presetId} supportsImages`);
      assert.equal(profile.customConservative, false, `${route.presetId} customConservative`);
      assert.ok(Array.isArray(profile.safeParams), `${route.presetId} safeParams`);
      assert.ok(profile.safeParams.length > 0, `${route.presetId} safeParams length`);
    }
  });
}

test("payload filtering keeps only adapter-safe chat parameters", () => {
  const payload = {
    model: "deepseek-v4-pro",
    messages: [{ role: "user", content: "hello" }],
    stream: false,
    tools: [],
    temperature: 0.2,
    response_format: { type: "json_object" },
    parallel_tool_calls: true,
    store: true,
    metadata: { request: "abc" },
  };
  const filtered = filterPayloadForAdapter(payload, {
    provider: "deepseek",
    api: "chat_completions",
    model: "deepseek-v4-pro",
    dropParams: ["response_format", "parallel_tool_calls"],
  });

  assert.deepEqual(Object.keys(filtered).sort(), [
    "messages",
    "model",
    "stream",
    "temperature",
    "tools",
  ]);
  assert.equal(filtered.response_format, undefined);
  assert.equal(filtered.parallel_tool_calls, undefined);
  assert.equal(filtered.store, undefined);
});

test("custom conservative routes still pass through tools and tool_choice during filtering", () => {
  const payload = {
    model: "custom-model",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ type: "function", function: { name: "lookup" } }],
    tool_choice: { type: "function", function: { name: "lookup" } },
    parallel_tool_calls: true,
    response_format: { type: "json_object" },
  };

  const filtered = filterPayloadForAdapter(payload, {
    provider: "custom",
    custom: true,
    api: "chat_completions",
    model: "custom-model",
  });

  assert.deepEqual(filtered.tools, payload.tools);
  assert.deepEqual(filtered.tool_choice, payload.tool_choice);
  assert.equal(filtered.parallel_tool_calls, undefined);
  assert.equal(filtered.response_format, undefined);
  assert.deepEqual(filtered.messages, [{ role: "user", content: "hello" }]);
});

test("adapterIdForRoute is stable for known provider families", () => {
  assert.equal(adapterIdForRoute({ provider: "minimax", api: "chat_completions" }), "chat-minimax");
  assert.equal(adapterIdForRoute({ provider: "volcengine", api: "chat_completions" }), "chat-doubao");
  assert.equal(adapterIdForRoute({ provider: "qwen", api: "chat_completions" }), "chat-qwen");
  assert.equal(adapterIdForRoute({ provider: "zhipu", api: "chat_completions" }), "chat-openai-compatible");
});
