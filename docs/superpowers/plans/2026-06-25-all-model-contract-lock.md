# 全模型兼容契约锁定 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 先为所有内置预设和自定义模型建立 adapter profile、参数白名单和回归测试，锁住现有可用行为，防止后续会话层改造把模型、工具、MCP 或参数兼容性搞坏。

**Architecture:** 第一阶段只加“兼容契约层”，不重写会话渲染，不启用自动路由，不改变用户可见 UI。新增 `src/adapter-profile.js` 负责把 route 标准化为 `AdapterProfile`，并提供 request payload 过滤函数；现有 `src/upstream.js` 和 `src/responses-to-chat.js` 在 fetch 前调用过滤函数，所有 provider 特殊能力通过测试锁定。

**Tech Stack:** Node.js ESM, `node:test`, existing CodexBridge router modules, no new runtime dependency.

## Global Constraints

- 禁止批量删除文件或目录；不要使用 `del /s`、`rd /s`、`rmdir /s`、`Remove-Item -Recurse`、`rm -rf`。
- 不实现自动路由；自动路由只保留在设计文档中，后续单独研究。
- 不改变现有模型选择 UI 和更新 UI。
- 不发版，除非所有本地检查和打包烟测通过。
- 所有内置预设模型类别都要有兼容契约测试，不只覆盖 DeepSeek 和 Kimi。
- 自定义模型默认保守：纯文本、最小参数、无图片、无文件、无推测工具能力。
- provider 不支持的参数必须在 fetch 前丢弃，不能靠上游 400/422 来发现。
- 工具、MCP namespace、工具结果续写行为不能退化。

---

## File Structure

- Create `src/adapter-profile.js`
  - Responsibility: derive route capabilities, provider family, safe parameter sets, attachment defaults, and payload filtering.
- Create `tests/adapter-profile.test.js`
  - Responsibility: unit tests for profile derivation, safe params, built-in preset coverage, and custom conservative behavior.
- Modify `src/upstream.js`
  - Responsibility: apply adapter payload filtering before native Responses fetch and before chat-completions fetch.
- Modify `src/responses-to-chat.js`
  - Responsibility: keep existing conversion behavior, but expose or use safe payload filtering after chat body is assembled.
- Modify `desktop/presets.mjs`
  - Responsibility: add explicit capability hints only where derivation is not enough.
- Modify `desktop/settings.mjs`
  - Responsibility: carry capability hints from selected/custom model into generated router config.
- Modify `tests/conversion.test.js`
  - Responsibility: verify chat payloads and model catalog remain compatible after profile integration.
- Modify `tests/server.test.js`
  - Responsibility: end-to-end local upstream checks that unsupported params are not sent and custom conservative routes stay safe.

---

### Task 1: Adapter Profile Module

**Files:**
- Create: `src/adapter-profile.js`
- Create: `tests/adapter-profile.test.js`

**Interfaces:**
- Produces: `normalizeAdapterProfile(route: object): AdapterProfile`
- Produces: `filterPayloadForAdapter(payload: object, profileOrRoute: object, options?: { api?: string }): object`
- Produces: `adapterIdForRoute(route: object): string`
- Consumes: route objects from `src/config.js`, `desktop/presets.mjs`, and generated router config.

`AdapterProfile` shape:

```js
{
  adapterId: "chat-deepseek",
  providerFamily: "deepseek",
  api: "chat_completions",
  contextWindow: 1000000,
  catalogContextWindow: 1000000,
  supportsTools: "chat-functions",
  supportsMcpNamespaces: true,
  supportsImages: "none",
  supportsFiles: "text-placeholder",
  supportsResponsePreviousId: false,
  supportsPromptCaching: "unknown",
  safeParams: ["model", "messages", "stream", "tools", "tool_choice", "temperature", "top_p", "presence_penalty", "frequency_penalty", "seed", "user", "max_tokens", "stop"],
  dropParams: ["response_format", "parallel_tool_calls"],
  maxToolContinuationTurns: 2,
  upstreamTimeoutMs: 300000,
  customConservative: false
}
```

- [ ] **Step 1: Write failing adapter profile tests**

Create `tests/adapter-profile.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
node --test tests\adapter-profile.test.js
```

Expected: FAIL with module not found for `../src/adapter-profile.js`.

- [ ] **Step 3: Implement minimal adapter profile module**

Create `src/adapter-profile.js`:

```js
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_CHAT_TOOL_TURNS = 2;

const RESPONSES_SAFE_PARAMS = [
  "model",
  "input",
  "messages",
  "instructions",
  "previous_response_id",
  "stream",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "temperature",
  "top_p",
  "max_output_tokens",
  "metadata",
  "store",
  "reasoning",
  "service_tier",
  "user",
];

const CHAT_SAFE_PARAMS = [
  "model",
  "messages",
  "stream",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "temperature",
  "top_p",
  "presence_penalty",
  "frequency_penalty",
  "seed",
  "user",
  "max_tokens",
  "max_completion_tokens",
  "stop",
  "response_format",
  "reasoning_split",
];

const DEFAULT_CHAT_DROP_PARAMS = ["parallel_tool_calls", "response_format"];

export function normalizeAdapterProfile(route = {}) {
  const providerFamily = providerFamilyForRoute(route);
  const api = route.api === "responses" ? "responses" : "chat_completions";
  const adapterId = adapterIdForRoute({ ...route, providerFamily, api });
  const customConservative = Boolean(route.custom) || providerFamily === "custom";
  const inputModalities = Array.isArray(route.inputModalities)
    ? route.inputModalities
    : [];
  const supportsImages = imageSupportForRoute(route, api, inputModalities, customConservative);
  const dropParams = normalizedDropParams(route, api, customConservative);

  return {
    adapterId,
    providerFamily,
    api,
    contextWindow: positiveNumber(route.contextWindow, 258400),
    catalogContextWindow: positiveNumber(
      route.catalogContextWindow,
      positiveNumber(route.contextWindow, 258400),
    ),
    supportsTools: api === "responses" ? "native" : "chat-functions",
    supportsMcpNamespaces: api === "responses" || !customConservative,
    supportsImages,
    supportsFiles: api === "responses" ? "native" : "text-placeholder",
    supportsResponsePreviousId: api === "responses",
    supportsPromptCaching: route.supportsPromptCaching || "unknown",
    safeParams: api === "responses" ? RESPONSES_SAFE_PARAMS : CHAT_SAFE_PARAMS,
    dropParams,
    maxToolContinuationTurns: positiveInteger(
      route.maxToolContinuationTurns ?? route.max_tool_continuation_turns,
      api === "chat_completions" ? DEFAULT_CHAT_TOOL_TURNS : 0,
    ),
    upstreamTimeoutMs: positiveInteger(
      route.upstreamTimeoutMs ?? route.upstream_timeout_ms,
      DEFAULT_TIMEOUT_MS,
    ),
    customConservative,
  };
}

export function adapterIdForRoute(route = {}) {
  const providerFamily = route.providerFamily || providerFamilyForRoute(route);
  if (route.api === "responses") {
    return "responses-native";
  }
  if (providerFamily === "deepseek") return "chat-deepseek";
  if (providerFamily === "kimi") return "chat-kimi";
  if (providerFamily === "minimax") return "chat-minimax";
  if (providerFamily === "doubao") return "chat-doubao";
  if (providerFamily === "qwen") return "chat-qwen";
  if (providerFamily === "gemini") return "chat-gemini";
  if (providerFamily === "custom") return "custom-conservative";
  return "chat-openai-compatible";
}

export function filterPayloadForAdapter(payload = {}, profileOrRoute = {}, options = {}) {
  const profile = profileOrRoute.safeParams
    ? profileOrRoute
    : normalizeAdapterProfile({
        ...profileOrRoute,
        api: options.api || profileOrRoute.api,
      });
  const allowed = new Set(profile.safeParams || []);
  const dropped = new Set(profile.dropParams || []);
  const result = {};
  for (const [key, value] of Object.entries(payload || {})) {
    if (allowed.has(key) && !dropped.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

function providerFamilyForRoute(route = {}) {
  const raw = String(route.providerFamily || route.provider || route.providerId || route.sourcePresetId || route.baseUrl || route.model || "").toLowerCase();
  if (route.custom || raw.includes("custom")) return "custom";
  if (raw.includes("codex") || raw.includes("openai") || raw.includes("chatgpt.com")) return "openai";
  if (raw.includes("deepseek")) return "deepseek";
  if (raw.includes("kimi") || raw.includes("moonshot")) return "kimi";
  if (raw.includes("minimax")) return "minimax";
  if (raw.includes("volc") || raw.includes("doubao") || raw.includes("ark.cn")) return "doubao";
  if (raw.includes("qwen") || raw.includes("dashscope")) return "qwen";
  if (raw.includes("gemini") || raw.includes("google")) return "gemini";
  if (raw.includes("baidu") || raw.includes("qianfan")) return "baidu";
  return "openai-compatible";
}

function imageSupportForRoute(route, api, inputModalities, customConservative) {
  if (!inputModalities.includes("image")) {
    return "none";
  }
  if (api === "responses") {
    return "native";
  }
  return customConservative ? "none" : "chat-image-url";
}

function normalizedDropParams(route, api, customConservative) {
  const configured = Array.isArray(route.dropParams) ? route.dropParams : [];
  const defaults = api === "chat_completions" && customConservative
    ? DEFAULT_CHAT_DROP_PARAMS
    : [];
  return [...new Set([...configured, ...defaults])].sort();
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}
```

- [ ] **Step 4: Run adapter profile tests**

Run:

```powershell
node --test tests\adapter-profile.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- src/adapter-profile.js tests/adapter-profile.test.js
git commit -m "Add adapter profile contracts"
```

---

### Task 2: Built-In Preset Coverage And Custom Conservative Defaults

**Files:**
- Modify: `tests/adapter-profile.test.js`
- Modify: `desktop/presets.mjs`
- Modify: `desktop/settings.mjs`

**Interfaces:**
- Consumes: `normalizeAdapterProfile(route)` from Task 1.
- Produces: generated router routes containing enough metadata for profile derivation: `provider`, `sourcePresetId`, `inputModalities`, `dropParams`, and optional capability hints.

- [ ] **Step 1: Add failing preset coverage tests**

Append to `tests/adapter-profile.test.js`:

```js
import { MODEL_PRESETS } from "../desktop/presets.mjs";
import {
  buildRouterConfigFromSelection,
  saveCustomModel,
  saveSelection,
} from "../desktop/settings.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const profile = normalizeAdapterProfile(config.models[0]);

  assert.equal(profile.adapterId, "custom-conservative");
  assert.equal(profile.supportsImages, "none");
  assert.ok(profile.dropParams.includes("response_format"));
  assert.ok(profile.dropParams.includes("parallel_tool_calls"));
});
```

- [ ] **Step 2: Run tests to verify current gap**

Run:

```powershell
node --test tests\adapter-profile.test.js
```

Expected: FAIL if generated custom route does not carry enough custom/provider metadata or conservative drops.

- [ ] **Step 3: Carry explicit capability metadata through generated routes**

Modify `desktop/settings.mjs` inside `routeForSelectedModel(...)`. In the `route` object, add:

```js
    custom: Boolean(model.custom),
    providerFamily: model.providerFamily,
```

Extend the existing copied-key loop to include:

```js
    "providerFamily",
    "supportsPromptCaching",
    "supportsTools",
    "supportsImages",
    "supportsFiles",
    "supportsMcpNamespaces",
    "supportsResponsePreviousId",
```

Then keep the existing chat default:

```js
  if (route.api === "chat_completions" && route.maxToolContinuationTurns === undefined) {
    route.maxToolContinuationTurns = 2;
  }
```

For custom chat routes, ensure conservative drops exist:

```js
  if (model.custom && route.api === "chat_completions") {
    const drops = Array.isArray(route.dropParams) ? route.dropParams : [];
    route.dropParams = [...new Set([...drops, "parallel_tool_calls", "response_format"])];
  }
```

- [ ] **Step 4: Keep preset data compatible**

Only change `desktop/presets.mjs` if tests show a preset cannot be classified from `providerId`, `api`, and `inputModalities`. If a provider needs explicit family, add it in that route's extra object:

```js
route("doubao-seed-1-8", "volcengine", "Doubao Seed 1.8", "doubao-seed-1-8-251228", "chat_completions", 258400, {
  providerFamily: "doubao",
  dropParams: ["response_format", "parallel_tool_calls"],
})
```

Use this only for ambiguous providers.

- [ ] **Step 5: Run preset coverage tests**

Run:

```powershell
node --test tests\adapter-profile.test.js tests\desktop-settings.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```powershell
git add -- tests/adapter-profile.test.js desktop/presets.mjs desktop/settings.mjs
git commit -m "Lock adapter profiles for presets"
```

---

### Task 3: Apply Safe Parameter Filtering Before Upstream Fetch

**Files:**
- Modify: `src/upstream.js`
- Modify: `src/responses-to-chat.js`
- Modify: `tests/server.test.js`
- Modify: `tests/conversion.test.js`

**Interfaces:**
- Consumes: `filterPayloadForAdapter(payload, route)` from Task 1.
- Produces: all upstream fetch payloads have adapter-allowed params only.

- [ ] **Step 1: Add failing server test for unsupported chat params**

Append to `tests/server.test.js`:

```js
test("server filters unsupported chat params before upstream fetch", async () => {
  let upstreamBody;
  const upstream = http.createServer(async (req, res) => {
    upstreamBody = await readJson(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl_param_filter",
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });

  await listen(upstream);
  const router = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    defaultModel: "deepseek-v4-pro",
    models: [{
      id: "deepseek-v4-pro",
      provider: "deepseek",
      displayName: "DeepSeek V4 Pro",
      api: "chat_completions",
      baseUrl: `${serverUrl(upstream)}/v1`,
      model: "deepseek-v4-pro",
      apiKey: "upstream-key",
      dropParams: ["response_format", "parallel_tool_calls"],
    }],
  });

  await listen(router);
  try {
    const response = await fetchJson(`${serverUrl(router)}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        input: "hello",
        response_format: { type: "json_object" },
        parallel_tool_calls: true,
        metadata: { unsafe: true },
        store: true,
      }),
    });

    assert.equal(response.output_text, "ok");
    assert.equal(upstreamBody.response_format, undefined);
    assert.equal(upstreamBody.parallel_tool_calls, undefined);
    assert.equal(upstreamBody.metadata, undefined);
    assert.equal(upstreamBody.store, undefined);
    assert.deepEqual(upstreamBody.messages.at(-1), { role: "user", content: "hello" });
  } finally {
    await close(router);
    await close(upstream);
  }
});
```

- [ ] **Step 2: Add conversion test for chat body filtering**

Append to `tests/conversion.test.js`:

```js
test("chat conversion output can be filtered by adapter safe params", () => {
  const converted = responsesToChatRequest(
    {
      input: "hello",
      response_format: { type: "json_object" },
      parallel_tool_calls: true,
      metadata: { unsafe: true },
      store: true,
    },
    {
      ...route,
      provider: "deepseek",
      dropParams: ["response_format", "parallel_tool_calls"],
    },
    new ResponseHistory(),
  );
  const filtered = filterPayloadForAdapter(converted.body, {
    ...route,
    provider: "deepseek",
    dropParams: ["response_format", "parallel_tool_calls"],
  });

  assert.equal(filtered.response_format, undefined);
  assert.equal(filtered.parallel_tool_calls, undefined);
  assert.equal(filtered.metadata, undefined);
  assert.equal(filtered.store, undefined);
  assert.equal(filtered.messages.at(-1).content, "hello");
});
```

Add import at the top of `tests/conversion.test.js`:

```js
import { filterPayloadForAdapter } from "../src/adapter-profile.js";
```

- [ ] **Step 3: Run targeted tests to verify failure**

Run:

```powershell
node --test tests\server.test.js tests\conversion.test.js
```

Expected: FAIL until `src/upstream.js` applies adapter filtering to actual upstream body.

- [ ] **Step 4: Filter payloads in upstream before fetch**

Modify `src/upstream.js` imports:

```js
import { filterPayloadForAdapter } from "./adapter-profile.js";
```

In `proxyResponsesApi(...)`, after `inlineLocalHistoryForResponsesPayload(...)` and before `fetchUpstream(...)`, add:

```js
  const upstreamPayload = filterPayloadForAdapter(payload, route, { api: "responses" });
```

Use `upstreamPayload` in failure key, logging fetch body, and upstream fetch:

```js
  throwIfRecentUpstreamFailure(route, upstreamUrl, upstreamPayload, context);
  ...
      body: JSON.stringify(upstreamPayload),
```

In `callJsonUpstream(...)`, add before `throwIfRecentUpstreamFailure(...)`:

```js
  const upstreamPayload = filterPayloadForAdapter(payload, route);
```

Use `upstreamPayload` for failure key and body:

```js
  throwIfRecentUpstreamFailure(route, upstreamUrl, upstreamPayload, context);
  ...
      body: JSON.stringify(upstreamPayload),
```

When remembering failures in this function, use `upstreamPayload`:

```js
    rememberUpstreamFailure(route, upstreamUrl, upstreamPayload, error, options);
```

- [ ] **Step 5: Run targeted tests**

Run:

```powershell
node --test tests\adapter-profile.test.js tests\conversion.test.js tests\server.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```powershell
git add -- src/upstream.js tests/server.test.js tests/conversion.test.js
git commit -m "Filter upstream payloads by adapter contract"
```

---

### Task 4: All-Model Category Smoke Tests

**Files:**
- Modify: `tests/server.test.js`
- Modify: `tests/adapter-profile.test.js`

**Interfaces:**
- Consumes: adapter profiles and payload filtering from Tasks 1-3.
- Produces: regression coverage for all model categories without live provider calls.

- [ ] **Step 1: Add provider category table test**

Append to `tests/adapter-profile.test.js`:

```js
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
```

- [ ] **Step 2: Add local upstream smoke helper in server tests**

Add helper near existing server test helpers in `tests/server.test.js`:

```js
async function exerciseChatRoute(routeOverrides = {}, requestOverrides = {}) {
  let upstreamBody;
  const upstream = http.createServer(async (req, res) => {
    upstreamBody = await readJson(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `chatcmpl_${routeOverrides.provider || "generic"}_smoke`,
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "smoke ok" } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }));
  });
  await listen(upstream);

  const route = {
    id: routeOverrides.id || "smoke-model",
    provider: routeOverrides.provider || "custom",
    displayName: routeOverrides.displayName || "Smoke Model",
    api: "chat_completions",
    baseUrl: `${serverUrl(upstream)}/v1`,
    model: routeOverrides.model || "smoke-model",
    apiKey: "upstream-key",
    ...routeOverrides,
  };
  const router = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    defaultModel: route.id,
    models: [route],
  });
  await listen(router);

  try {
    const response = await fetchJson(`${serverUrl(router)}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: route.id,
        input: "smoke text",
        response_format: { type: "json_object" },
        parallel_tool_calls: true,
        ...requestOverrides,
      }),
    });
    return { response, upstreamBody };
  } finally {
    await close(router);
    await close(upstream);
  }
}
```

- [ ] **Step 3: Add all category smoke tests**

Append to `tests/server.test.js`:

```js
test("chat provider categories complete text requests without unsafe params", async () => {
  for (const route of [
    { id: "deepseek-smoke", provider: "deepseek", model: "deepseek-v4-pro", dropParams: ["response_format", "parallel_tool_calls"] },
    { id: "kimi-smoke", provider: "kimi", model: "kimi-k2.7-code", inputModalities: ["text", "image"], dropParams: ["response_format", "parallel_tool_calls"] },
    { id: "minimax-smoke", provider: "minimax", model: "MiniMax-M3", dropParams: ["response_format", "parallel_tool_calls"] },
    { id: "doubao-smoke", provider: "volcengine", model: "doubao-seed-1-8-251228", dropParams: ["response_format", "parallel_tool_calls"] },
    { id: "qwen-smoke", provider: "qwen", model: "qwen3-coder-plus", dropParams: ["parallel_tool_calls"] },
    { id: "generic-smoke", provider: "openrouter", model: "anthropic/claude-sonnet-4.5", dropParams: ["parallel_tool_calls"] },
  ]) {
    const { response, upstreamBody } = await exerciseChatRoute(route);
    assert.equal(response.output_text, "smoke ok", route.id);
    assert.equal(upstreamBody.parallel_tool_calls, undefined, route.id);
    if (route.dropParams.includes("response_format")) {
      assert.equal(upstreamBody.response_format, undefined, route.id);
    }
  }
});

test("custom conservative chat route completes text and drops risky params", async () => {
  const { response, upstreamBody } = await exerciseChatRoute({
    id: "custom-smoke",
    provider: "custom",
    custom: true,
    model: "custom-model",
  });

  assert.equal(response.output_text, "smoke ok");
  assert.equal(upstreamBody.response_format, undefined);
  assert.equal(upstreamBody.parallel_tool_calls, undefined);
  assert.equal(upstreamBody.messages.at(-1).content, "smoke text");
});
```

- [ ] **Step 4: Run category smoke tests**

Run:

```powershell
node --test tests\adapter-profile.test.js tests\server.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```powershell
git add -- tests/adapter-profile.test.js tests/server.test.js
git commit -m "Add all-model category smoke tests"
```

---

### Task 5: Verification Gate And Documentation Update

**Files:**
- Modify: `docs/superpowers/specs/2026-06-25-all-model-session-safety-design.md`
- Modify: `docs/release-checklist.md` if it exists; otherwise create `docs/release-checklist.md`

**Interfaces:**
- Consumes: new test commands from Tasks 1-4.
- Produces: release checklist that future changes must follow before version bump and GitHub release.

- [ ] **Step 1: Create release checklist if missing**

If `docs/release-checklist.md` does not exist, create it:

```md
# Release Checklist

Before tagging a CodexBridge release:

1. Run `npm run check`.
2. Run `npm run desktop:smoke`.
3. Run `npm run package:win`.
4. Run `npm run package:win:smoke`.
5. Confirm all built-in adapter profile tests pass.
6. Confirm all local provider-category smoke tests pass.
7. Confirm `git status --short --branch` is clean before tagging.
8. Push `main`.
9. Create and push the version tag.
10. Wait for GitHub Actions release build success.
11. Confirm `/releases/latest` points to the new version.

Do not tag a release when any built-in provider category has a known compatibility failure.
```

- [ ] **Step 2: Add Phase 1 completion note to the Chinese spec**

In `docs/superpowers/specs/2026-06-25-all-model-session-safety-design.md`, under `### 阶段 1：锁定兼容契约`, add:

```md
阶段 1 完成后，仓库必须至少包含：

- `src/adapter-profile.js`：标准化 route 能力和参数白名单。
- `tests/adapter-profile.test.js`：覆盖所有内置预设和自定义保守模式。
- server 层参数过滤测试：证明不支持参数不会发到上游。
- provider 类别 smoke 测试：覆盖 native Responses、DeepSeek、Kimi、MiniMax、Doubao、Qwen、generic chat、自定义保守模式。
```

- [ ] **Step 3: Run full verification**

Run:

```powershell
npm run check
```

Expected: PASS with all tests passing.

Then run:

```powershell
npm run desktop:smoke
```

Expected output includes:

```text
CodexBridge desktop smoke loaded.
```

- [ ] **Step 4: Commit Task 5**

```powershell
git add -- docs/superpowers/specs/2026-06-25-all-model-session-safety-design.md docs/release-checklist.md
git commit -m "Document all-model release gate"
```

---

## Final Verification Before Implementation Branch Completion

After all tasks are complete, run:

```powershell
npm run check
npm run desktop:smoke
npm run package:win
npm run package:win:smoke
git status --short --branch
```

Expected:

- `npm run check`: all tests pass.
- `npm run desktop:smoke`: desktop smoke loads.
- `npm run package:win`: creates a Windows portable package.
- `npm run package:win:smoke`: packaged executable smoke passes.
- `git status --short --branch`: branch is clean after commits.

Do not bump version or create a release tag during this plan unless the user explicitly asks for a release.

## Self-Review Checklist

- This plan implements only Phase 1 of the spec: adapter contracts, safe params, built-in preset coverage, and release gates.
- Auto-routing, compression, attachment ledger, and UI surfacing are intentionally outside this plan and remain separate future plans.
- Every runtime change has a failing test before implementation.
- Every task is independently committable.
- No task requires live provider credentials.
- No task introduces new dependencies.
