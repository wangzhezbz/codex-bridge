import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultSelectedModelIds } from "../desktop/presets.mjs";
import {
  buildRouterConfigFromSelection,
  MODE_ALL_API,
  MODE_HYBRID,
  modelCatalog,
  readSelection,
  readModelCapabilityOverrides,
  readModelImageInputOverrides,
  saveCustomModel,
  saveSelection,
} from "../desktop/settings.mjs";
import { routeForModel, validateConfig } from "../src/config.js";
import { contextPolicyForRoute } from "../src/context-policy.js";
import { buildModelCatalog, openAiModelsList } from "../src/model-catalog.js";
import { createCodexModelSelectionState } from "../src/codex-model-selection.js";
import { createUsageStore, evaluateUsageBudgets, estimateUsageCosts } from "../desktop/usage.mjs";

function tempProject() {
  // Callers may isolate all artifacts without touching a live Codex installation.
  const parent = process.env.CODEXBRIDGE_TEST_TMPDIR || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, "cb-gpt6-presets-"));
}

function selectedConfig(ids, mode = MODE_HYBRID) {
  const rootDir = tempProject();
  saveSelection(rootDir, ids, mode);
  return { rootDir, config: buildRouterConfigFromSelection(rootDir, mode) };
}

const cases = [
  { preset: "codex-gpt-6-1-sol", slug: "cb-gpt-6-1-sol", model: "gpt-6.1-sol", auth: "codex_openai", base: "https://chatgpt.com/backend-api/codex", mode: MODE_HYBRID },
  { preset: "codex-gpt-6-sol", slug: "cb-gpt-6-sol", model: "gpt-6-sol", auth: "codex_openai", base: "https://chatgpt.com/backend-api/codex", mode: MODE_HYBRID },
  { preset: "codex-gpt-6-luna", slug: "cb-gpt-6-luna", model: "gpt-6-luna", auth: "codex_openai", base: "https://chatgpt.com/backend-api/codex", mode: MODE_HYBRID },
  { preset: "openai-gpt-6-1-sol", slug: "cb-openai-gpt-6-1-sol", model: "gpt-6.1-sol", auth: "api_key", base: "https://api.openai.com/v1", mode: MODE_ALL_API },
  { preset: "openai-gpt-6-sol", slug: "cb-openai-gpt-6-sol", model: "gpt-6-sol", auth: "api_key", base: "https://api.openai.com/v1", mode: MODE_ALL_API },
  { preset: "openai-gpt-6-luna", slug: "cb-openai-gpt-6-luna", model: "gpt-6-luna", auth: "api_key", base: "https://api.openai.com/v1", mode: MODE_ALL_API },
];

for (const expected of cases) {
  test(`${expected.preset} saves an exact route without alias, authentication or endpoint substitution`, () => {
    const { rootDir, config } = selectedConfig([expected.preset], expected.mode);
    assert.deepEqual(readSelection(rootDir, expected.mode), [expected.preset]);
    assert.equal(config.models.length, 1);
    const [route] = config.models;
    assert.equal(route.id, expected.slug);
    assert.equal(route.model, expected.model);
    assert.equal(route.authMode, expected.auth);
    assert.equal(route.baseUrl, expected.base);
    assert.equal(route.api, "responses");
    assert.equal(route.apiKeyEnv, expected.auth === "api_key" ? "OPENAI_API_KEY" : undefined);
    assert.equal(config.defaultModel, expected.slug);
    assert.equal(config.clientAuth.allowOpenAiBearer, expected.mode === MODE_HYBRID);
    assert.doesNotThrow(() => validateConfig(config));
    const catalog = JSON.parse(JSON.stringify(buildModelCatalog(config)));
    assert.equal(catalog.models.length, 1);
    assert.equal(catalog.models[0].slug, expected.slug);
    assert.equal(catalog.models[0].model, expected.model);
    assert.deepEqual(catalog.models[0].input_modalities, ["text", "image"]);
    assert.equal(openAiModelsList(config).data[0].id, expected.slug);
  });
}

test("GPT-6.1 Sol API route uses official Responses limits and excludes unsupported none/minimal efforts", () => {
  const { config } = selectedConfig(["openai-gpt-6-1-sol"], MODE_ALL_API);
  const [route] = config.models;
  const [entry] = buildModelCatalog(config).models;
  assert.deepEqual(entry.supported_reasoning_levels.map(({ effort }) => effort), [
    "low", "medium", "high", "xhigh", "max",
  ]);
  assert.equal(entry.default_reasoning_level, "medium");
  assert.equal(entry.context_window, 1050000);
  assert.deepEqual(entry.truncation_policy, { mode: "tokens", limit: 922000 });
  assert.equal(contextPolicyForRoute(route).inputBudget, 922000);
  assert.equal(contextPolicyForRoute(route).outputReserveTokens, 128000);
});

test("GPT-6.1 Sol subscription route stays on ChatGPT auth with account-gated Fast and Ultra", () => {
  const { config } = selectedConfig(["codex-gpt-6-1-sol"]);
  const [route] = config.models;
  const [entry] = buildModelCatalog(config).models;
  assert.deepEqual(entry.supported_reasoning_levels.map(({ effort }) => effort), [
    "low", "medium", "high", "xhigh", "max", "ultra",
  ]);
  assert.equal(entry.context_window, 272000);
  assert.deepEqual(entry.additional_speed_tiers, ["fast"]);
  assert.equal(entry.service_tiers[0]?.id, "priority");
  assert.equal(entry.use_responses_lite, false);
  assert.equal(entry.tool_mode, null);
  assert.equal(entry.multi_agent_version, null);
  assert.equal(contextPolicyForRoute(route).inputBudget, 258400);
});

test("saved official OpenAI directory cache still exposes new 6.1 Sol without replacing the user's selected model", () => {
  const rootDir = tempProject();
  const selected = ["codex-gpt-6-sol", "openai-gpt-6-sol"];
  saveSelection(rootDir, selected);
  const configDir = path.join(rootDir, "config");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "model-directory.local.json"), JSON.stringify({
    version: 1,
    providers: { openai: {
      providerId: "openai", providerName: "OpenAI API", baseUrl: "https://api.openai.com/v1",
      endpoint: "https://api.openai.com/v1/models", source: "remote", fetchedAt: "2026-09-28T00:00:00.000Z",
      presetRevision: "2026-09-28", models: [{ id: "gpt-6-sol" }],
    } },
  }));
  const choices = modelCatalog(rootDir);
  assert.ok(choices.some(({ presetId, model }) => presetId === "openai-gpt-6-1-sol" && model === "gpt-6.1-sol"));
  assert.deepEqual(readSelection(rootDir), selected);
  assert.equal(buildRouterConfigFromSelection(rootDir).defaultModel, "cb-gpt-6-sol");
});

for (const name of ["sol", "luna"]) {
  test(`GPT-6 ${name} API catalog offers none through max with the verified input reserve`, () => {
    const { config } = selectedConfig([`openai-gpt-6-${name}`], MODE_ALL_API);
    const [entry] = buildModelCatalog(config).models;
    assert.deepEqual(entry.supported_reasoning_levels.map(({ effort }) => effort), [
      "none", "low", "medium", "high", "xhigh", "max",
    ]);
    assert.equal(entry.default_reasoning_level, "medium");
    assert.equal(entry.context_window, 1050000);
    const policy = contextPolicyForRoute(config.models[0]);
    assert.equal(policy.inputBudget, 922000);
    assert.equal(policy.outputReserveTokens, 128000);
    assert.deepEqual(entry.truncation_policy, { mode: "tokens", limit: 922000 });
    assert.deepEqual(entry.additional_speed_tiers, []);
    assert.deepEqual(entry.service_tiers, []);
  });

  test(`GPT-6 ${name} subscription catalog uses a conservative window without guessing native protocols`, () => {
    const { config } = selectedConfig([`codex-gpt-6-${name}`]);
    const [entry] = buildModelCatalog(config).models;
    assert.equal(entry.context_window, 272000);
    assert.equal(entry.max_context_window, 272000);
    assert.equal(contextPolicyForRoute(config.models[0]).inputBudget, 258400);
    assert.equal(entry.use_responses_lite, false);
    assert.equal(entry.tool_mode, null);
    assert.equal(entry.multi_agent_version, null);
    assert.deepEqual(entry.additional_speed_tiers, []);
    assert.deepEqual(entry.service_tiers, []);
    assert.deepEqual(entry.supported_reasoning_levels.map(({ effort }) => effort), name === "sol"
      ? ["low", "medium", "high", "xhigh", "max", "ultra"]
      : ["low", "medium", "high", "xhigh", "max"]);
  });
}

test("new GPT-6 presets remain opt-in and preserve prior defaults", () => {
  assert.deepEqual(defaultSelectedModelIds(MODE_HYBRID), [
    "codex-gpt-5-6-sol", "codex-gpt-5-6-terra", "deepseek-v4-pro", "deepseek-v4-flash", "kimi-k2-7-code",
  ]);
  assert.deepEqual(defaultSelectedModelIds(MODE_ALL_API), [
    "openai-gpt-5-6-sol", "openai-gpt-5-6-luna", "deepseek-v4-pro", "deepseek-v4-flash", "kimi-k2-7-code",
  ]);
  const hybrid = buildRouterConfigFromSelection(tempProject(), MODE_HYBRID);
  assert.equal(hybrid.defaultModel, "cb-gpt-5-6-sol");
  const api = buildRouterConfigFromSelection(tempProject(), MODE_ALL_API);
  assert.equal(api.defaultModel, "cb-openai-gpt-5-6-sol");
  assert.equal([...hybrid.models, ...api.models].some(({ model }) => /^gpt-6-(sol|luna)$/.test(model)), false);
});

test("old Astra and 5.6 selections retain their exact routes alongside new opt-in models", () => {
  const ids = ["codex-gpt-5-6", "codex-gpt-5-6-sol", "codex-gpt-5-6-terra", "codex-gpt-5-6-luna", "codex-gpt-6-astra", "openai-gpt-6-astra"];
  const { rootDir, config: before } = selectedConfig(ids);
  saveSelection(rootDir, [...ids, "codex-gpt-6-sol", "openai-gpt-6-luna"]);
  const after = buildRouterConfigFromSelection(rootDir);
  assert.deepEqual(readSelection(rootDir), [...ids, "codex-gpt-6-sol", "openai-gpt-6-luna"]);
  assert.deepEqual(after.models.slice(0, ids.length), before.models);
  assert.equal(after.defaultModel, before.defaultModel);
  assert.deepEqual(after.models.map(({ model }) => model), [
    "gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna",
  ]);
});

test("custom selection and model settings survive adding a built-in GPT-6 route", () => {
  const rootDir = tempProject();
  const custom = saveCustomModel(rootDir, {
    providerName: "Fixture Provider", displayName: "Pinned Custom", model: "my-pinned-model",
    baseUrl: "https://example.invalid/v1", api: "responses", contextWindow: 200000,
  });
  saveSelection(rootDir, [custom.presetId]);
  const before = buildRouterConfigFromSelection(rootDir);
  saveSelection(rootDir, [custom.presetId, "openai-gpt-6-sol"]);
  const after = buildRouterConfigFromSelection(rootDir);
  assert.deepEqual(readSelection(rootDir), [custom.presetId, "openai-gpt-6-sol"]);
  assert.deepEqual(after.models[0], before.models[0]);
  assert.equal(after.defaultModel, before.defaultModel);
  assert.equal(after.models[1].model, "gpt-6-sol");
});

const promotedApiModels = [
  { model: "gpt-6.1-sol", oldId: "remote-openai-gpt-6-1-sol", presetId: "openai-gpt-6-1-sol", oldRoute: "cb-remote-openai-gpt-6-1-sol", route: "cb-openai-gpt-6-1-sol", subscription: "codex-gpt-6-1-sol" },
  { model: "gpt-6-sol", oldId: "remote-openai-gpt-6-sol", presetId: "openai-gpt-6-sol", oldRoute: "cb-remote-openai-gpt-6-sol", route: "cb-openai-gpt-6-sol", subscription: "codex-gpt-6-sol" },
  { model: "gpt-6-luna", oldId: "remote-openai-gpt-6-luna", presetId: "openai-gpt-6-luna", oldRoute: "cb-remote-openai-gpt-6-luna", route: "cb-openai-gpt-6-luna", subscription: "codex-gpt-6-luna" },
];

function fixtureFile(rootDir, fileName, value) {
  const configDir = path.join(rootDir, "config");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, fileName), JSON.stringify(value));
}

function legacyApiProject(expected, api = "responses") {
  const rootDir = tempProject();
  // Literal persisted pre-promotion IDs, never saved through today's normalizer.
  // Astra intentionally precedes the selected model to expose provider fallback.
  fixtureFile(rootDir, "model-directory.local.json", { version: 1, providers: { openai: {
    providerId: "openai", providerName: "OpenAI API", baseUrl: "https://api.openai.com/v1",
    endpoint: "https://api.openai.com/v1/models", source: "remote", fetchedAt: "2026-09-22T00:00:00.000Z",
    models: [{ id: "gpt-6-astra" }, { id: expected.model }],
  } } });
  fixtureFile(rootDir, "model-selection.json", { selectedModelIds: [expected.oldId] });
  fixtureFile(rootDir, "model-capabilities.json", { version: 3,
    imageInput: { [expected.oldId]: false },
    overrides: { [expected.oldId]: { api, inputModalities: ["text"], contextWindow: 131072, updatedAt: "2026-09-22T00:00:00.000Z" } },
  });
  return rootDir;
}

for (const expected of promotedApiModels) {
  for (const api of ["responses", "chat_completions"]) {
    test(`legacy ${expected.model} selection preserves exact upstream and saved ${api} capabilities with Astra first`, () => {
      const rootDir = legacyApiProject(expected, api);
      assert.deepEqual(readSelection(rootDir), [expected.presetId]);
      const config = buildRouterConfigFromSelection(rootDir);
      assert.equal(config.models.length, 1);
      const [route] = config.models;
      assert.equal(route.id, expected.route);
      assert.equal(route.model, expected.model);
      assert.equal(route.authMode, "api_key");
      assert.equal(route.baseUrl, "https://api.openai.com/v1");
      assert.equal(route.apiKeyEnv, "OPENAI_API_KEY");
      assert.equal(route.api, api);
      assert.equal(route.contextWindow, 131072);
      assert.deepEqual(route.inputModalities, ["text"]);
      assert.equal(readModelImageInputOverrides(rootDir)[expected.presetId], false);
      assert.equal(config.defaultModel, expected.route);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(rootDir, "config", "model-selection.json"))).selectedModelIds, [expected.presetId]);
      assert.deepEqual(buildRouterConfigFromSelection(rootDir), config, "repeat startup is idempotent");
    });
  }

  test(`current ${expected.model} capability records win old-ID collisions in either insertion order`, () => {
    for (const canonicalFirst of [false, true]) {
      const rootDir = legacyApiProject(expected);
      const oldEntry = [expected.oldId, { contextWindow: 131072, api: "chat_completions", inputModalities: ["text"] }];
      const newEntry = [expected.presetId, { contextWindow: 262144, api: "responses", inputModalities: ["text", "image"] }];
      fixtureFile(rootDir, "model-capabilities.json", { version: 3,
        imageInput: Object.fromEntries(canonicalFirst ? [[expected.presetId, true], [expected.oldId, false]] : [[expected.oldId, false], [expected.presetId, true]]),
        overrides: Object.fromEntries(canonicalFirst ? [newEntry, oldEntry] : [oldEntry, newEntry]),
      });
      const [route] = buildRouterConfigFromSelection(rootDir).models;
      assert.equal(route.model, expected.model);
      assert.equal(route.contextWindow, 262144);
      assert.equal(route.api, "responses");
      assert.deepEqual(route.inputModalities, ["text", "image"]);
      assert.deepEqual(Object.keys(readModelCapabilityOverrides(rootDir)), [expected.presetId]);
      assert.deepEqual(readModelImageInputOverrides(rootDir), { [expected.presetId]: true });
    }
  });

  test(`stale ${expected.model} route resolves only to the configured API slot, never Astra or subscription`, () => {
    const { config } = selectedConfig(["openai-gpt-6-astra", expected.subscription, expected.presetId]);
    const strict = { exactModelIdOnly: true };
    const route = routeForModel(config, expected.oldRoute, strict);
    assert.equal(route.id, expected.route);
    assert.equal(route.model, expected.model);
    assert.equal(route.authMode, "api_key");
    assert.equal(route.baseUrl, "https://api.openai.com/v1");
    assert.throws(() => routeForModel({ ...config, models: config.models.slice(0, 2) }, expected.oldRoute, strict), { code: "model_not_configured" });
    assert.throws(() => routeForModel(config, `${expected.oldRoute}-2`, strict), { code: "model_not_configured" });
    assert.throws(() => routeForModel(config, `cb-remote-${expected.subscription}`, strict), { code: "model_not_configured" });
  });

  test(`an explicitly configured old ${expected.model} slot retains strict lookup precedence`, () => {
    const { config } = selectedConfig([expected.presetId]);
    const explicit = { ...config.models[0], id: expected.oldRoute, model: "explicit-custom-slot", baseUrl: "https://example.invalid/v1" };
    assert.equal(routeForModel({ ...config, models: [...config.models, explicit] }, expected.oldRoute, { exactModelIdOnly: true }), explicit);
  });

  test(`old ${expected.model} model-settings selection corrects stale reconnect only when its API slot is configured`, () => {
    const state = createCodexModelSelectionState();
    const headers = { "x-codex-thread-id": `migration-${expected.model}` };
    const previousModel = "cb-openai-gpt-6-astra";
    state.recordModelSetting({ headers, body: { model: expected.oldRoute }, previousModel });
    const body = { model: previousModel, previous_response_id: "resp_before_switch" };
    const applied = state.applyToRequest({ headers, body, configuredModelIds: [previousModel, expected.route] });
    assert.equal(applied.changed, true);
    assert.equal(body.model, expected.oldRoute);
    for (const configuredModelIds of [[previousModel], [previousModel, `cb-${expected.model}`]]) {
      const unconfigured = { model: previousModel, previous_response_id: "resp_before_switch" };
      assert.equal(state.applyToRequest({ headers, body: unconfigured, configuredModelIds }).changed, false);
      assert.equal(unconfigured.model, previousModel);
    }
  });

  test(`historical ${expected.model} usage follows its promoted API route and prices without rewriting events`, () => {
    const event = {
      requestId: "req_migrated", route: expected.oldRoute, codexModel: expected.oldRoute,
      api: "responses", upstreamModel: expected.model, status: 200,
      startedAt: "2026-09-23T04:00:00.000Z", finishedAt: "2026-09-23T04:00:01.000Z",
      promptTokens: 1000000, freshPromptTokens: 1000000, completionTokens: 1, totalTokens: 1000001,
    };
    const store = createUsageStore({ initialEvents: [event] });
    const before = structuredClone(store.events());
    const routes = [{ id: expected.route, model: expected.model, api: "responses", provider: "openai" }];
    const summary = store.summary({ routes });
    assert.equal(summary.current.totalCalls, 1);
    assert.equal(summary.current.totalTokens, 1000001);
    const budgets = { routes: { [expected.route]: { dailyCallLimit: 1, inputCostPerMillion: 10 } }, providers: { openai: { dailyCallLimit: 1 } } };
    const options = { routes, now: "2026-09-23T04:00:02.000Z" };
    assert.deepEqual(evaluateUsageBudgets(summary, budgets, options).map(alert => alert.scope).sort(), ["provider", "route"]);
    assert.equal(estimateUsageCosts(summary, budgets, options).totalCost, 10);
    assert.deepEqual(store.events(), before);
    assert.equal(summary.current.events[0].route, expected.oldRoute);

    const explicitRoutes = [...routes, { ...routes[0], id: expected.oldRoute }];
    const explicitSummary = store.summary({ routes: explicitRoutes });
    const explicitBudgets = { routes: { ...budgets.routes, [expected.oldRoute]: { inputCostPerMillion: 30 } } };
    assert.equal(estimateUsageCosts(explicitSummary, explicitBudgets, { ...options, routes: explicitRoutes }).totalCost, 30);
    for (const change of [{ upstreamModel: "gpt-6-astra" }, { api: "chat_completions" }]) {
      const mismatched = createUsageStore({ initialEvents: [{ ...event, ...change }] }).summary({ routes });
      assert.equal(mismatched.current.totalCalls, 0);
      assert.equal(mismatched.history.totalCalls, 1);
    }
  });
}
