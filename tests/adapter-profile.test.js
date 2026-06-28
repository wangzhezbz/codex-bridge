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

test("codex_openai responses routes enforce ChatGPT backend request contract", () => {
  const filtered = filterPayloadForAdapter(
    {
      model: "gpt-5.5",
      input: "hello",
      stream: false,
      max_output_tokens: 4096,
      temperature: 0.4,
      top_p: 0.9,
      store: true,
      include: ["output_text"],
      prompt_cache_key: "codex-cache-key",
      client_metadata: { encrypted_context: "keep" },
    },
    {
      id: "gpt-5.5",
      provider: "codex",
      api: "responses",
      model: "gpt-5.5",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "codex_openai",
    },
  );

  assert.equal(filtered.stream, true);
  assert.equal(filtered.store, false);
  assert.equal(filtered.max_output_tokens, undefined);
  assert.equal(filtered.temperature, undefined);
  assert.equal(filtered.top_p, undefined);
  assert.equal(filtered.prompt_cache_key, "codex-cache-key");
  assert.deepEqual(filtered.client_metadata, { encrypted_context: "keep" });
  assert.deepEqual(filtered.include, ["output_text", "reasoning.encrypted_content"]);
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
  assert.equal(profile.maxToolContinuationTurns, 5);
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

test("chat stream payloads request usage only for real streaming requests", () => {
  const route = {
    id: "custom-stream",
    custom: true,
    api: "chat_completions",
    model: "custom-stream",
  };

  assert.deepEqual(
    filterPayloadForAdapter({
      model: "custom-stream",
      messages: [],
      stream: true,
    }, route),
    {
      model: "custom-stream",
      messages: [],
      stream: true,
      stream_options: { include_usage: true },
    },
  );

  assert.deepEqual(
    filterPayloadForAdapter({
      model: "custom-stream",
      messages: [],
      stream: false,
    }, route),
    {
      model: "custom-stream",
      messages: [],
      stream: false,
    },
  );

  assert.equal(
    filterPayloadForAdapter(
      {
        model: "custom-stream",
        messages: [],
        stream: true,
        stream_options: { include_usage: false, vendor_flag: true },
      },
      { ...route, dropParams: ["stream_options"] },
    ).stream_options,
    undefined,
  );
});

test("custom chat routes default to text-only input while preserving OpenAI-compatible params", () => {
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
  assert.ok(profile.safeParams.includes("parallel_tool_calls"));
  assert.ok(profile.safeParams.includes("response_format"));
  assert.deepEqual(profile.dropParams, []);
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
  assert.ok(profile.safeParams.includes("parallel_tool_calls"));
  assert.ok(profile.safeParams.includes("response_format"));
  assert.deepEqual(profile.dropParams, []);
});

test("adapter profiles expose a unified capability matrix for native responses routes", () => {
  const profile = normalizeAdapterProfile({
    id: "gpt-5.5",
    provider: "codex",
    api: "responses",
    model: "gpt-5.5",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    authMode: "codex_openai",
    contextWindow: 258400,
    catalogContextWindow: 200000,
    inputModalities: ["text", "image", "file", "audio"],
    supportsPromptCaching: "native",
  });

  assert.equal(profile.capabilities.api, "responses");
  assert.equal(profile.capabilities.providerFamily, "openai");
  assert.equal(profile.capabilities.tools, profile.supportsTools);
  assert.equal(profile.capabilities.mcpNamespaces, profile.supportsMcpNamespaces);
  assert.equal(profile.capabilities.images, profile.supportsImages);
  assert.equal(profile.capabilities.files, profile.supportsFiles);
  assert.equal(profile.capabilities.audio, "native");
  assert.equal(profile.capabilities.reasoning.mode, "responses-native");
  assert.equal(profile.capabilities.compact.mode, "responses-native");
  assert.equal(profile.capabilities.compact.strategy, "responses-stream");
  assert.equal(profile.capabilities.compact.requiresStream, true);
  assert.equal(profile.capabilities.compact.retryWithStream, false);
  assert.equal(profile.capabilities.compact.fallback, "local-summary");
  assert.equal(profile.capabilities.previousResponseId, true);
  assert.equal(profile.capabilities.promptCache, "native");
  assert.equal(profile.capabilities.contextWindow, 258400);
  assert.equal(profile.capabilities.catalogContextWindow, 200000);
});

test("adapter profiles expose route-specific chat capabilities without weakening custom models", () => {
  const deepseek = normalizeAdapterProfile({
    id: "deepseek-v4-pro",
    provider: "deepseek",
    api: "chat_completions",
    model: "deepseek-v4-pro",
    contextWindow: 1000000,
    inputModalities: ["text"],
    dropParams: ["response_format"],
  });

  assert.equal(deepseek.capabilities.api, "chat_completions");
  assert.equal(deepseek.capabilities.providerFamily, "deepseek");
  assert.equal(deepseek.capabilities.tools, "chat-functions");
  assert.equal(deepseek.capabilities.mcpNamespaces, true);
  assert.equal(deepseek.capabilities.images, "none");
  assert.equal(deepseek.capabilities.files, "text-placeholder");
  assert.equal(deepseek.capabilities.audio, "none");
  assert.equal(deepseek.capabilities.reasoning.mode, "deepseek-thinking");
  assert.equal(deepseek.capabilities.compact.mode, "chat-summary");
  assert.equal(deepseek.capabilities.compact.strategy, "chat-json");
  assert.equal(deepseek.capabilities.compact.requiresStream, false);
  assert.equal(deepseek.capabilities.compact.fallback, "local-summary");
  assert.equal(deepseek.capabilities.promptCache, "unknown");
  assert.equal(deepseek.capabilities.contextWindow, 1000000);

  const custom = normalizeAdapterProfile({
    id: "custom-model",
    provider: "custom",
    custom: true,
    api: "chat_completions",
    model: "custom-model",
    inputModalities: ["text", "image", "audio"],
  });

  assert.equal(custom.capabilities.providerFamily, "custom");
  assert.equal(custom.capabilities.tools, "chat-functions");
  assert.equal(custom.capabilities.images, "chat-image-url");
  assert.equal(custom.capabilities.files, "none");
  assert.equal(custom.capabilities.audio, "chat-input-audio");
  assert.equal(custom.capabilities.reasoning.mode, "openai-compatible-passthrough");
  assert.equal(custom.capabilities.compact.strategy, "chat-json");
  assert.equal(custom.capabilities.compact.fallback, "local-summary");
  assert.equal(custom.capabilities.parameters.mode, "openai-compatible-passthrough");
  assert.ok(custom.safeParams.includes("tools"));
  assert.ok(custom.safeParams.includes("tool_choice"));
  assert.ok(custom.safeParams.includes("parallel_tool_calls"));
  assert.ok(custom.safeParams.includes("response_format"));
});

test("adapter profiles report manual capability overrides without changing reasoning params", () => {
  const profile = normalizeAdapterProfile({
    id: "deepseek-v4-pro",
    provider: "deepseek",
    api: "chat_completions",
    model: "deepseek-v4-pro",
    inputModalities: ["text", "image", "file", "audio"],
    contextWindow: 123456,
    capabilityOverrides: {
      reasoning: { mode: "unknown", note: "manual verification pending" },
    },
    dropParams: ["response_format", "parallel_tool_calls"],
  });

  assert.equal(profile.supportsImages, "chat-image-url");
  assert.equal(profile.capabilities.audio, "none");
  assert.equal(profile.capabilities.contextWindow, 123456);
  assert.equal(profile.capabilities.reasoning.mode, "unknown");
  assert.equal(profile.capabilities.reasoning.manualOverride, true);
  assert.deepEqual(profile.capabilities.reasoning.params, [
    "reasoning_effort",
    "thinking",
  ]);
  assert.equal(profile.dropParams.includes("response_format"), true);
  assert.equal(profile.dropParams.includes("parallel_tool_calls"), true);
  assert.equal(profile.dropParams.includes("reasoning"), true);
});

test("adapter profiles keep reasoning parameters route-specific and preserve custom passthrough", () => {
  const deepseekV4 = normalizeAdapterProfile({
    provider: "deepseek",
    api: "chat_completions",
    model: "deepseek-v4-pro",
  });
  assert.equal(deepseekV4.dropParams.includes("reasoning"), true);
  assert.equal(deepseekV4.dropParams.includes("enable_thinking"), true);
  assert.equal(deepseekV4.dropParams.includes("reasoning_effort"), false);
  assert.equal(deepseekV4.dropParams.includes("thinking"), false);
  assert.deepEqual(deepseekV4.capabilities.reasoning.params, [
    "reasoning_effort",
    "thinking",
  ]);

  const deepseekReasoner = normalizeAdapterProfile({
    provider: "deepseek",
    api: "chat_completions",
    model: "deepseek-reasoner",
  });
  assert.equal(deepseekReasoner.dropParams.includes("reasoning_effort"), true);
  assert.equal(deepseekReasoner.dropParams.includes("thinking"), true);

  const kimi27 = normalizeAdapterProfile({
    provider: "kimi",
    api: "chat_completions",
    model: "kimi-k2.7-code",
  });
  assert.equal(kimi27.dropParams.includes("thinking"), true);
  assert.deepEqual(kimi27.capabilities.reasoning.params, []);

  const kimi26 = normalizeAdapterProfile({
    provider: "kimi",
    api: "chat_completions",
    model: "kimi-k2.6",
  });
  assert.equal(kimi26.dropParams.includes("thinking"), false);
  assert.deepEqual(kimi26.capabilities.reasoning.params, ["thinking"]);

  const qwen = normalizeAdapterProfile({
    provider: "qwen",
    api: "chat_completions",
    model: "qwen3-coder-plus",
  });
  assert.equal(qwen.dropParams.includes("reasoning"), true);
  assert.equal(qwen.dropParams.includes("enable_thinking"), false);
  assert.deepEqual(qwen.capabilities.reasoning.params, [
    "enable_thinking",
    "thinking_budget",
  ]);

  const openrouter = normalizeAdapterProfile({
    provider: "openrouter",
    api: "chat_completions",
    model: "anthropic/claude-sonnet-4.5",
  });
  assert.equal(openrouter.providerFamily, "openrouter");
  assert.equal(openrouter.dropParams.includes("reasoning"), false);
  assert.equal(openrouter.dropParams.includes("enable_thinking"), true);
  assert.deepEqual(openrouter.capabilities.reasoning.params, [
    "reasoning",
    "reasoning_effort",
  ]);

  const custom = normalizeAdapterProfile({
    provider: "custom",
    custom: true,
    api: "chat_completions",
    model: "custom-model",
  });
  for (const param of [
    "reasoning",
    "reasoning_effort",
    "thinking",
    "enable_thinking",
    "thinking_budget",
    "extra_body",
  ]) {
    assert.equal(custom.safeParams.includes(param), true, param);
    assert.equal(custom.dropParams.includes(param), false, param);
  }
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
  assert.ok(profile.safeParams.includes("response_format"));
  assert.ok(profile.safeParams.includes("parallel_tool_calls"));
  assert.deepEqual(profile.dropParams, []);
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
    providerFamily: "zhipu",
    adapterId: "chat-openai-compatible",
    api: "chat_completions",
    supportsTools: "chat-functions",
    supportsFiles: "text-placeholder",
    supportsResponsePreviousId: false,
  },
  openrouter: {
    providerFamily: "openrouter",
    adapterId: "chat-openai-compatible",
    api: "chat_completions",
    supportsTools: "chat-functions",
    supportsFiles: "text-placeholder",
    supportsResponsePreviousId: false,
  },
  siliconflow: {
    providerFamily: "siliconflow",
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
      assert.equal(profile.capabilities.providerFamily, expected.providerFamily, `${route.presetId} capabilities.providerFamily`);
      assert.equal(profile.capabilities.api, expected.api, `${route.presetId} capabilities.api`);
      assert.equal(profile.capabilities.tools, expected.supportsTools, `${route.presetId} capabilities.tools`);
      assert.equal(profile.capabilities.files, expected.supportsFiles, `${route.presetId} capabilities.files`);
      assert.equal(profile.capabilities.previousResponseId, expected.supportsResponsePreviousId, `${route.presetId} capabilities.previousResponseId`);
      assert.equal(profile.capabilities.images, expectedImageSupport(profile.api, route.inputModalities), `${route.presetId} capabilities.images`);
      assert.equal(profile.capabilities.contextWindow, profile.contextWindow, `${route.presetId} capabilities.contextWindow`);
      assert.equal(profile.capabilities.catalogContextWindow, profile.catalogContextWindow, `${route.presetId} capabilities.catalogContextWindow`);
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

test("custom routes pass through OpenAI-compatible tool and format params by default", () => {
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
  assert.equal(filtered.parallel_tool_calls, true);
  assert.deepEqual(filtered.response_format, { type: "json_object" });
  assert.deepEqual(filtered.messages, [{ role: "user", content: "hello" }]);
});

test("custom routes honor explicitly configured dropped params", () => {
  const payload = {
    model: "custom-model",
    messages: [{ role: "user", content: "hello" }],
    parallel_tool_calls: true,
    response_format: { type: "json_object" },
  };

  const filtered = filterPayloadForAdapter(payload, {
    provider: "custom",
    custom: true,
    api: "chat_completions",
    model: "custom-model",
    dropParams: ["parallel_tool_calls"],
  });

  assert.equal(filtered.parallel_tool_calls, undefined);
  assert.deepEqual(filtered.response_format, { type: "json_object" });
});

test("payload filtering recursively drops non-json values without damaging tool schemas", () => {
  const drops = [];
  const payload = {
    model: "custom-model",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "hello", debug: undefined },
          { type: "text", text: "world", unsafe: () => "nope" },
        ],
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "select_body_parts",
          description: "Select body parts.",
          parameters: {
            type: "object",
            properties: {
              excludedBodyParts: {
                type: "array",
                items: { $ref: "#/$defs/BodyPart" },
              },
              metadata: {
                type: "object",
                properties: {
                  source: { type: "string" },
                },
              },
            },
            $defs: {
              BodyPart: {
                type: "string",
                enum: ["head", "arm", "leg"],
              },
            },
            definitions: {
              LegacyPart: {
                type: "string",
                enum: ["tail"],
              },
            },
          },
        },
      },
    ],
    metadata: {
      ok: true,
      skipMe: Symbol("skip"),
    },
  };

  const filtered = filterPayloadForAdapter(payload, {
    provider: "custom",
    custom: true,
    api: "chat_completions",
    model: "custom-model",
  }, {
    onDrop: (drop) => drops.push(drop),
  });

  assert.equal(filtered.messages[0].content[0].debug, undefined);
  assert.equal(filtered.messages[0].content[1].unsafe, undefined);
  assert.equal(filtered.metadata, undefined);
  assert.equal(filtered.tools[0].function.parameters.properties.metadata.properties.source.type, "string");
  assert.equal(filtered.tools[0].function.parameters.properties.excludedBodyParts.items.$ref, "#/$defs/BodyPart");
  assert.deepEqual(filtered.tools[0].function.parameters.$defs.BodyPart.enum, ["head", "arm", "leg"]);
  assert.deepEqual(filtered.tools[0].function.parameters.definitions.LegacyPart.enum, ["tail"]);
  assert.deepEqual(
    drops.map((drop) => `${drop.path}:${drop.reason}`).sort(),
    [
      "messages[0].content[0].debug:non_json_value",
      "messages[0].content[1].unsafe:non_json_value",
      "metadata:unsupported_top_level_param",
    ],
  );
});

test("adapterIdForRoute is stable for known provider families", () => {
  assert.equal(adapterIdForRoute({ provider: "minimax", api: "chat_completions" }), "chat-minimax");
  assert.equal(adapterIdForRoute({ provider: "volcengine", api: "chat_completions" }), "chat-doubao");
  assert.equal(adapterIdForRoute({ provider: "qwen", api: "chat_completions" }), "chat-qwen");
  assert.equal(adapterIdForRoute({ provider: "zhipu", api: "chat_completions" }), "chat-openai-compatible");
});
