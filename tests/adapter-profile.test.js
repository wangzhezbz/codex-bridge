import test from "node:test";
import assert from "node:assert/strict";
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
  assert.equal(profile.supportsImages, "none");
  assert.equal(profile.supportsFiles, "text-placeholder");
  assert.deepEqual(profile.dropParams, ["parallel_tool_calls", "response_format"]);
});

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

test("adapterIdForRoute is stable for known provider families", () => {
  assert.equal(adapterIdForRoute({ provider: "minimax", api: "chat_completions" }), "chat-minimax");
  assert.equal(adapterIdForRoute({ provider: "volcengine", api: "chat_completions" }), "chat-doubao");
  assert.equal(adapterIdForRoute({ provider: "qwen", api: "chat_completions" }), "chat-qwen");
  assert.equal(adapterIdForRoute({ provider: "zhipu", api: "chat_completions" }), "chat-openai-compatible");
});
