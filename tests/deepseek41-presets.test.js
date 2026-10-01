import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MODEL_PRESETS, defaultSelectedModelIds } from "../desktop/presets.mjs";
import {
  buildRouterConfigFromSelection,
  MODE_ALL_API,
  MODE_HYBRID,
  modelCatalog,
  readSelection,
  refreshProviderModelDirectory,
  saveCustomModel,
  saveModelCapabilityOverride,
  saveSecrets,
  saveSelection,
  loadDesktopOptions,
  loadConfigProfiles,
  readModelCapabilityOverrides,
  readModelImageInputOverrides,
  readModelImageGenerationOverrides,
  resetModelCapabilityOverride,
  saveModelImageInputOverride,
  applyConfigMutationTransaction,
  readRouterConfig,
} from "../desktop/settings.mjs";
import { createConfigWriteCoordinator } from "../desktop/config-write-coordinator.mjs";
import { routeForModel, validateConfig } from "../src/config.js";
import { buildModelCatalog, openAiModelsList } from "../src/model-catalog.js";
import { createCodexModelSelectionState } from "../src/codex-model-selection.js";

function tempProject() {
  // Keep fixture state separate from the user's live Codex and Router state.
  const parent = process.env.CODEXBRIDGE_TEST_TMPDIR || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, "cb-deepseek41-presets-"));
}

const presetId = "deepseek-v4-1-flash";

test("DeepSeek Pro defaults to native Responses without overriding an explicit Chat setting", () => {
  const root = tempProject();
  saveSelection(root, ["deepseek-v4-pro"]);
  const before = buildRouterConfigFromSelection(root);
  assert.equal(before.models[0].api, "responses");
  assert.equal(before.models[0].model, "deepseek-v4-pro");
  assert.equal(before.models[0].supportsResponsePreviousId, false);
  assert.deepEqual(before.models[0].inputModalities, ["text"]);
  saveModelCapabilityOverride(root, "deepseek-v4-pro", { api: "chat_completions" });
  assert.equal(buildRouterConfigFromSelection(root).models[0].api, "chat_completions");
});

test("new API defaults exclude retired 4.1 choices while saved legacy routes remain valid", () => {
  const root = tempProject();
  assert.ok(defaultSelectedModelIds(MODE_ALL_API).every(id => !["openai-gpt-4-1", "openai-gpt-4-1-mini"].includes(id)));
  saveSelection(root, ["openai-gpt-4-1"], MODE_ALL_API);
  const route = buildRouterConfigFromSelection(root, MODE_ALL_API).models[0];
  assert.equal(route.model, "gpt-4.1");
  assert.equal(route.api, "responses");
});

test("the September provider refresh exposes exact official model IDs without replacing a saved route", () => {
  const rootDir = tempProject();
  saveSelection(rootDir, ["deepseek-v4-pro"]);
  const before = buildRouterConfigFromSelection(rootDir);
  const expected = [
    ["openai-gpt-5-6-terra", "gpt-5.6-terra", "responses"],
    ["anthropic-claude-fable-5-1", "claude-fable-5-1", "anthropic_messages"],
    ["anthropic-claude-opus-5-5", "claude-opus-5-5", "anthropic_messages"],
    ["anthropic-claude-sonnet-5", "claude-sonnet-5", "anthropic_messages"],
    ["xai-grok-4-7", "grok-4.7", "responses"],
    ["gemini-3-8-flash", "gemini-3.8-flash", "chat_completions"],
    ["kimi-k3", "kimi-k3", "chat_completions"],
    ["xiaomi-mimo-v2-6-pro", "mimo-v2.6-pro", "chat_completions"],
    ["xiaomi-mimo-v2-6-flash", "mimo-v2.6-flash", "chat_completions"],
    ["minimax-m3-1-flash-preview", "MiniMax-M3.1-Flash-Preview", "chat_completions"],
    ["stepfun-step-5-preview", "step-5-preview", "chat_completions"],
    ["qianfan-ernie-5-0", "ernie-5.0", "chat_completions"],
    ["doubao-seed-2-1-pro", "doubao-seed-2-1-pro-260915", "chat_completions"],
    ["qwen3-8-max", "qwen3.8-max", "chat_completions"],
    ["glm-5-3", "glm-5.3", "chat_completions"],
    ["openrouter-deepseek-v4-1-flash", "deepseek/deepseek-v4.1-flash", "chat_completions"],
    ["hunyuan-tokenhub-hy4-preview", "hy4-preview", "chat_completions"],
  ];
  const catalog = modelCatalog(rootDir);
  for (const [id, upstream, api] of expected) {
    const model = catalog.find(model => model.presetId === id);
    assert.ok(model, `${id} missing from the picker`);
    assert.equal(model.model, upstream);
    assert.equal(model.api, api);
  }
  assert.deepEqual(buildRouterConfigFromSelection(rootDir), before);
});

for (const mode of [MODE_HYBRID, MODE_ALL_API]) {
  test(`V4.1 Flash saves the exact upstream identity and native Responses route in ${mode}`, () => {
    const rootDir = tempProject();
    saveSelection(rootDir, [presetId], mode);
    const config = buildRouterConfigFromSelection(rootDir, mode);

    assert.deepEqual(readSelection(rootDir, mode), [presetId]);
    assert.equal(config.models.length, 1);
    const [route] = config.models;
    assert.equal(route.id, "cb-deepseek-v4-1-flash");
    assert.equal(route.sourcePresetId, presetId);
    assert.equal(route.provider, "deepseek");
    assert.equal(route.displayName, "DeepSeek V4.1 Flash");
    assert.equal(route.model, "deepseek-flash");
    assert.equal(route.api, "responses");
    assert.equal(route.authMode, "api_key");
    assert.equal(route.apiKeyEnv, "DEEPSEEK_API_KEY");
    // Settings retains the shared provider /v1 URL, just as for the existing
    // V4 Flash preset; endpoint construction also preserves this prefix.
    assert.equal(route.baseUrl, "https://api.deepseek.com/v1");
    assert.equal(MODEL_PRESETS.find((model) => model.presetId === presetId).baseUrl, "https://api.deepseek.com");
    assert.equal(route.contextWindow, 1048576);
    assert.deepEqual(route.inputModalities, ["text", "image"]);
    assert.equal(route.supportsFiles, "text-placeholder");
    assert.equal(route.supportsResponsePreviousId, false);
    assert.equal(route.truncationPolicy, undefined);
    assert.equal(config.defaultModel, "cb-deepseek-v4-1-flash");
    assert.equal(config.clientAuth.allowOpenAiBearer, mode === MODE_HYBRID);
    assert.doesNotThrow(() => validateConfig(config));
    assert.equal(openAiModelsList(config).data[0].id, "cb-deepseek-v4-1-flash");
  });
}

test("V4.1 Flash exposes vision and none/low/high/max reasoning without invented native protocols", () => {
  const rootDir = tempProject();
  saveSelection(rootDir, [presetId]);
  const config = buildRouterConfigFromSelection(rootDir);
  const [entry] = buildModelCatalog(config).models;

  assert.equal(entry.slug, "cb-deepseek-v4-1-flash");
  assert.equal(entry.model, "deepseek-flash");
  assert.deepEqual(entry.input_modalities, ["text", "image"]);
  assert.equal(entry.default_reasoning_level, "high");
  assert.deepEqual(entry.supported_reasoning_levels.map(({ effort }) => effort), ["none", "low", "high", "max"]);
  assert.ok(entry.supported_reasoning_levels.every(({ description }) => /[\u4e00-\u9fff]/u.test(description)));
  assert.equal(entry.context_window, 1048576);
  assert.equal(entry.max_context_window, 1048576);
  assert.equal(entry.codexbridge_capabilities.files, "text-placeholder");
  assert.equal(entry.codexbridge_capabilities.previous_response_id, false);
  assert.equal(entry.use_responses_lite, false);
  assert.equal(entry.tool_mode, null);
  assert.equal(entry.multi_agent_version, null);
  assert.deepEqual(entry.additional_speed_tiers, []);
  assert.deepEqual(entry.service_tiers, []);
});

for (const { mode, defaults, defaultModel } of [
  {
    mode: MODE_HYBRID,
    defaults: ["codex-gpt-5-6-sol", "codex-gpt-5-6-terra", "deepseek-v4-pro", "deepseek-v4-flash", "kimi-k2-7-code"],
    defaultModel: "cb-gpt-5-6-sol",
  },
  {
    mode: MODE_ALL_API,
    defaults: ["openai-gpt-5-6-sol", "openai-gpt-5-6-luna", "deepseek-v4-pro", "deepseek-v4-flash", "kimi-k2-7-code"],
    defaultModel: "cb-openai-gpt-5-6-sol",
  },
]) {
  test(`V4.1 Flash remains opt-in and preserves existing defaults in ${mode}`, () => {
    const rootDir = tempProject();
    assert.deepEqual(defaultSelectedModelIds(mode), defaults);
    assert.deepEqual(readSelection(rootDir, mode), defaults);
    const config = buildRouterConfigFromSelection(rootDir, mode);
    assert.equal(config.defaultModel, defaultModel);
    assert.equal(config.models.some(({ model }) => model === "deepseek-flash"), false);
    assert.ok(modelCatalog(rootDir).some((model) => model.presetId === presetId));
  });

  test(`adding V4.1 Flash preserves exact V4 Pro and old Flash selections in ${mode}`, () => {
    const rootDir = tempProject();
    const existingIds = ["deepseek-v4-pro", "deepseek-v4-flash"];
    saveSelection(rootDir, existingIds, mode);
    const before = buildRouterConfigFromSelection(rootDir, mode);
    saveSelection(rootDir, [...existingIds, presetId], mode);
    const after = buildRouterConfigFromSelection(rootDir, mode);

    assert.deepEqual(readSelection(rootDir, mode), [...existingIds, presetId]);
    assert.deepEqual(after.models.slice(0, existingIds.length), before.models);
    assert.equal(after.defaultModel, "cb-deepseek-v4-pro");
    assert.deepEqual(after.models.map(({ model, api }) => ({ model, api })), [
      { model: "deepseek-v4-pro", api: "responses" },
      { model: "deepseek-v4-flash", api: "responses" },
      { model: "deepseek-flash", api: "responses" },
    ]);
  });
}

test("adding V4.1 Flash preserves the selected custom default and old Flash capability overrides", () => {
  const rootDir = tempProject();
  const custom = saveCustomModel(rootDir, {
    providerName: "Fixture Provider", displayName: "Pinned Custom", model: "my-pinned-model",
    baseUrl: "https://example.invalid/v1", api: "responses", contextWindow: 200000,
  });
  saveModelCapabilityOverride(rootDir, "deepseek-v4-flash", {
    inputModalities: ["text"], contextWindow: 262144,
  });
  const existingIds = [custom.presetId, "deepseek-v4-flash"];
  saveSelection(rootDir, existingIds);
  const before = buildRouterConfigFromSelection(rootDir);
  saveSelection(rootDir, [...existingIds, presetId]);
  const after = buildRouterConfigFromSelection(rootDir);

  assert.deepEqual(readSelection(rootDir), [...existingIds, presetId]);
  assert.deepEqual(after.models.slice(0, existingIds.length), before.models);
  assert.equal(after.defaultModel, before.defaultModel);
  assert.equal(after.models[0].model, "my-pinned-model");
  assert.equal(after.models[1].contextWindow, 262144);
  assert.deepEqual(after.models[1].inputModalities, ["text"]);
  assert.equal(after.models[2].model, "deepseek-flash");
});

test("provider directory refresh retains V4.1 identity and capabilities alongside exact old identities", async () => {
  const rootDir = tempProject();
  saveSecrets(rootDir, { DEEPSEEK_API_KEY: "fixture-deepseek-key" });
  const ids = ["deepseek-v4-pro", "deepseek-v4-flash", presetId];
  saveSelection(rootDir, ids);
  const before = buildRouterConfigFromSelection(rootDir);
  const result = await refreshProviderModelDirectory(rootDir, "deepseek", {
    now: () => "2026-09-23T04:00:00.000Z",
    fetchImpl: async () => new Response(JSON.stringify({
      data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-v4-flash" }, { id: "deepseek-flash" }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(readSelection(rootDir), ids);
  const models = modelCatalog(rootDir).filter(({ providerId }) => providerId === "deepseek");
  assert.deepEqual(models.map(({ presetId }) => presetId), ids);
  assert.equal(models[2].displayName, "DeepSeek V4.1 Flash");
  assert.equal(models[2].api, "responses");
  assert.deepEqual(models[2].inputModalities, ["text", "image"]);
  assert.deepEqual(buildRouterConfigFromSelection(rootDir), before);
  const entry = buildModelCatalog(before).models[2];
  assert.equal(entry.default_reasoning_level, "high");
  assert.deepEqual(entry.supported_reasoning_levels.map(({ effort }) => effort), ["none", "low", "high", "max"]);
});

const legacyFlashId = "remote-deepseek-deepseek-flash";
const legacyFlashRoute = "cb-remote-deepseek-deepseek-flash";
const currentFlashRoute = "cb-deepseek-v4-1-flash";

function fixtureFile(rootDir, fileName, value) {
  const configDir = path.join(rootDir, "config");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, fileName), JSON.stringify(value));
}

test("an older official model directory cannot hide new curated DeepSeek models", () => {
  const rootDir = tempProject();
  fixtureFile(rootDir, "model-directory.local.json", { version: 1, providers: { deepseek: {
    providerId: "deepseek", providerName: "DeepSeek", baseUrl: "https://api.deepseek.com/v1",
    source: "remote", fetchedAt: "2026-08-01T00:00:00.000Z", models: [{ id: "deepseek-v4-pro" }],
  } } });
  const flash = modelCatalog(rootDir).find(model => model.presetId === "deepseek-v4-1-flash");
  assert.ok(flash, "A stale cache hid V4.1 Flash");
  assert.equal(flash.model, "deepseek-flash");
  assert.equal(flash.api, "responses");
});

function legacyFlashProject({ flashFirst = false, api = "responses" } = {}) {
  const rootDir = tempProject();
  // Serialized shape and IDs captured from the pre-preset build, without
  // calling today's selection normalizer to fabricate yesterday's state.
  fixtureFile(rootDir, "model-directory.local.json", { version: 1, providers: { deepseek: {
    providerId: "deepseek", providerName: "DeepSeek", baseUrl: "https://api.deepseek.com/v1",
    endpoint: "https://api.deepseek.com/v1/models", source: "remote", fetchedAt: "2026-09-22T00:00:00.000Z",
    models: (flashFirst ? ["deepseek-flash", "deepseek-v4-pro"] : ["deepseek-v4-pro", "deepseek-flash"]).map(id => ({ id })),
  } } });
  fixtureFile(rootDir, "model-selection.json", { selectedModelIds: [legacyFlashId] });
  fixtureFile(rootDir, "model-capabilities.json", { version: 3, imageInput: { [legacyFlashId]: false }, overrides: {
    [legacyFlashId]: { api, inputModalities: ["text"], contextWindow: 131072, updatedAt: "2026-09-22T00:00:00.000Z" },
  } });
  return rootDir;
}

for (const flashFirst of [false, true]) for (const api of ["responses", "chat_completions"]) {
  test(`legacy discovered Flash upgrades without replacing the model or ${api} override (${flashFirst ? "Flash" : "Pro"} first)`, () => {
    const rootDir = legacyFlashProject({ flashFirst, api });
    assert.deepEqual(readSelection(rootDir), [presetId]);
    const config = buildRouterConfigFromSelection(rootDir);
    assert.equal(config.models.length, 1);
    assert.equal(config.models[0].model, "deepseek-flash");
    assert.equal(config.models[0].api, api);
    assert.equal(config.models[0].contextWindow, 131072);
    assert.deepEqual(config.models[0].inputModalities, ["text"]);
    assert.equal(config.defaultModel, currentFlashRoute);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(rootDir, "config", "model-selection.json"))), { selectedModelIds: [presetId] });
    assert.deepEqual(buildRouterConfigFromSelection(rootDir), config, "repeated startup must be idempotent");
  });
}

test("promoted Flash preserves auxiliary routing, failover and its route-specific budget", () => {
  const rootDir = legacyFlashProject();
  fixtureFile(rootDir, "model-selection.json", { selectedModelIds: ["deepseek-v4-pro", legacyFlashId] });
  fixtureFile(rootDir, "desktop-options.json", {
    codexAuxiliaryModelId: legacyFlashRoute,
    smartRouting: { autoSelectRules: { ordinaryChat: { mode: "route", routeId: legacyFlashRoute } },
      failover: { mode: "ordered", routeIds: [legacyFlashRoute, "cb-deepseek-v4-pro"] } },
    usageBudgets: { routes: { [legacyFlashRoute]: { dailyCallLimit: 7 } }, providers: { deepseek: { dailyTokenLimit: 999 } } },
  });
  const config = buildRouterConfigFromSelection(rootDir);
  assert.equal(config.codexAuxiliaryTasks.routeId, currentFlashRoute);
  assert.equal(config.smartRouting.autoSelectRules.ordinaryChat.routeId, currentFlashRoute);
  assert.deepEqual(config.smartRouting.failover.routeIds, [currentFlashRoute, "cb-deepseek-v4-pro"]);
  assert.deepEqual(config.usageBudgets.routes, { [currentFlashRoute]: { dailyCallLimit: 7 } });
  assert.deepEqual(config.usageBudgets.providers, { deepseek: { dailyTokenLimit: 999 } });
  assert.equal(loadDesktopOptions(rootDir).codexAuxiliaryModelId, currentFlashRoute);
});

test("legacy profile selections and per-model image settings survive promotion", () => {
  const rootDir = legacyFlashProject();
  fixtureFile(rootDir, "profiles.json", { version: 1, profiles: [{
    id: "old", name: "Saved before upgrade", mode: MODE_HYBRID, selectedModelIds: [legacyFlashId],
    desktopOptions: { codexAuxiliaryModelId: legacyFlashRoute },
  }] });
  fixtureFile(rootDir, "model-image-generation.json", { version: 1, imageGeneration: {
    [legacyFlashId]: { enabled: true, mode: "custom", baseUrl: "https://image.example.invalid/v1", model: "saved-image-model", apiKeyEnv: "SAVED_IMAGE_KEY" },
  } });
  assert.deepEqual(loadConfigProfiles(rootDir)[0].selectedModelIds, [presetId]);
  assert.equal(loadConfigProfiles(rootDir)[0].desktopOptions.codexAuxiliaryModelId, currentFlashRoute);
  assert.equal(readModelImageGenerationOverrides(rootDir)[presetId]?.model, "saved-image-model");
  assert.equal(buildRouterConfigFromSelection(rootDir).models[0].imageGeneration.model, "saved-image-model");
});

test("explicit current settings win a legacy-key collision in either insertion order", () => {
  for (const canonicalFirst of [false, true]) {
    const rootDir = legacyFlashProject();
    const oldEntry = [legacyFlashId, { contextWindow: 131072, api: "chat_completions", inputModalities: ["text"] }];
    const newEntry = [presetId, { contextWindow: 262144, api: "responses", inputModalities: ["text", "image"] }];
    fixtureFile(rootDir, "model-capabilities.json", { version: 3,
      imageInput: Object.fromEntries(canonicalFirst ? [[presetId, true], [legacyFlashId, false]] : [[legacyFlashId, false], [presetId, true]]),
      overrides: Object.fromEntries(canonicalFirst ? [newEntry, oldEntry] : [oldEntry, newEntry]),
    });
    const model = buildRouterConfigFromSelection(rootDir).models[0];
    assert.equal(model.contextWindow, 262144);
    assert.equal(model.api, "responses");
    assert.deepEqual(model.inputModalities, ["text", "image"]);
    assert.deepEqual(Object.keys(readModelCapabilityOverrides(rootDir)), [presetId]);
  }
});

test("saving and resetting via either ID cannot resurrect obsolete capability keys", () => {
  const rootDir = legacyFlashProject();
  saveModelCapabilityOverride(rootDir, legacyFlashId, { contextWindow: 262144, inputModalities: ["text"] });
  assert.equal(buildRouterConfigFromSelection(rootDir).models[0].contextWindow, 262144);
  saveModelImageInputOverride(rootDir, legacyFlashId, true);
  assert.equal(readModelImageInputOverrides(rootDir)[presetId], true);
  resetModelCapabilityOverride(rootDir, legacyFlashId);
  assert.deepEqual(readModelCapabilityOverrides(rootDir), {});
  assert.equal(buildRouterConfigFromSelection(rootDir).models[0].contextWindow, 1048576);
  assert.deepEqual(readModelCapabilityOverrides(rootDir), {}, "a second read must not revive the old key");
});

test("a stale task's exact legacy route resolves only to its configured Flash slot", () => {
  const rootDir = tempProject();
  saveSelection(rootDir, ["deepseek-v4-pro", presetId]);
  const config = buildRouterConfigFromSelection(rootDir);
  assert.equal(routeForModel(config, legacyFlashRoute, { exactModelIdOnly: true }).model, "deepseek-flash");
  assert.throws(() => routeForModel({ ...config, models: config.models.slice(0, 1) }, legacyFlashRoute, { exactModelIdOnly: true }), /没有/);
  assert.throws(() => routeForModel(config, `${legacyFlashRoute}-2`, { exactModelIdOnly: true }), /没有/);
  const explicit = { ...config.models[0], id: legacyFlashRoute, model: "explicit-custom-slot" };
  assert.equal(routeForModel({ ...config, models: [...config.models, explicit] }, legacyFlashRoute, { exactModelIdOnly: true }).model, "explicit-custom-slot");
});

test("a model-settings change using the old Flash ID still corrects a stale reconnect", () => {
  const state = createCodexModelSelectionState();
  const headers = { "x-codex-thread-id": "migration-fixture" };
  state.recordModelSetting({ headers, body: { model: legacyFlashRoute }, previousModel: "cb-deepseek-v4-pro" });
  const body = { model: "cb-deepseek-v4-pro", previous_response_id: "resp_before_switch" };
  const applied = state.applyToRequest({ headers, body, configuredModelIds: ["cb-deepseek-v4-pro", currentFlashRoute] });
  assert.equal(applied.changed, true);
  assert.equal(body.model, legacyFlashRoute);
  const unconfigured = { model: "cb-deepseek-v4-pro", previous_response_id: "resp_before_switch" };
  assert.equal(state.applyToRequest({ headers, body: unconfigured, configuredModelIds: ["cb-deepseek-v4-pro"] }).changed, false);
});

function migrationTransaction(rootDir) {
  const homeDir = path.join(rootDir, "fixture-home");
  fs.mkdirSync(homeDir, { recursive: true });
  const coordinator = createConfigWriteCoordinator({ privateAcl: { async securePath() {} } });
  coordinator.configure({ allowedRoots: [rootDir, homeDir], journalDir: path.join(rootDir, ".config-transactions") });
  return (operation, payload) => applyConfigMutationTransaction({ rootDir, homeDir, coordinator, operation, payload });
}

test("transactional saves and reset accept the legacy Flash ID without stale overrides winning", async () => {
  const rootDir = legacyFlashProject();
  const mutate = migrationTransaction(rootDir);
  await mutate("models:saveCapabilities", { presetId: legacyFlashId, capabilities: { contextWindow: 262144, api: "responses", inputModalities: ["text"] } });
  assert.equal(readRouterConfig(rootDir).models[0].contextWindow, 262144);
  await mutate("models:saveImageInput", { presetId: legacyFlashId, imageInput: true });
  assert.deepEqual(readRouterConfig(rootDir).models[0].inputModalities, ["text", "image"]);
  await mutate("models:resetCapabilities", { presetId: legacyFlashId });
  assert.deepEqual(readModelCapabilityOverrides(rootDir), {});
  assert.equal(readRouterConfig(rootDir).models[0].contextWindow, 1048576);
});

test("an exact saved selection may migrate a verified ID without permitting a different model", async () => {
  const rootDir = legacyFlashProject();
  const mutate = migrationTransaction(rootDir);
  const mode = buildRouterConfigFromSelection(rootDir).mode;
  await mutate("models:saveSelection", { selectedModelIds: [legacyFlashId], expectedMode: mode, exactSelection: true });
  assert.equal(readRouterConfig(rootDir).models[0].model, "deepseek-flash");
  await assert.rejects(mutate("models:saveSelection", { selectedModelIds: [`${legacyFlashId}-unverified`], expectedMode: mode, exactSelection: true }));
  assert.equal(readRouterConfig(rootDir).models[0].model, "deepseek-flash");
});

test("an old configuration package imports selection, capabilities and image settings under one canonical identity", async () => {
  const rootDir = legacyFlashProject();
  const mutate = migrationTransaction(rootDir);
  await mutate("configPackage:import", { input: {
    schema: "codexbridge.config-package", version: 1, includesSecrets: false,
    requiredSecretKeys: ["SAVED_IMAGE_KEY"],
    selection: { mode: MODE_HYBRID, selectedModelIds: [legacyFlashId] },
    modelCapabilities: { imageInput: { [legacyFlashId]: false }, overrides: {
      [legacyFlashId]: { contextWindow: 65536, api: "responses", inputModalities: ["text"] },
    } },
    modelImageGeneration: { [legacyFlashId]: { enabled: true, mode: "custom", displayName: "Fixture image", endpoint: "/images/generations", size: "1024x1024", model: "imported-image", baseUrl: "https://image.example.invalid/v1", apiKeyEnv: "SAVED_IMAGE_KEY" } },
  } });
  const config = readRouterConfig(rootDir);
  assert.equal(config.models[0].model, "deepseek-flash");
  assert.equal(config.models[0].contextWindow, 65536);
  assert.equal(config.models[0].imageGeneration.model, "imported-image");
  assert.deepEqual(Object.keys(readModelCapabilityOverrides(rootDir)), [presetId]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(rootDir, "config", "model-selection.json"))).selectedModelIds, [presetId]);
});
