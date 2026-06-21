import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MODE_ALL_API,
  MODE_HYBRID,
  MODEL_PRESETS,
  applyCodexConfig,
  buildRouterConfigFromSelection,
  buildCodexToml,
  detectModeFromConfig,
  ensureRouterConfig,
  providerCatalog,
  prepareRouterStartConfig,
  readCustomModels,
  restoreCodexConfig,
  saveCustomModel,
  saveSelection,
  saveSecrets,
  secretValue,
  secretStatus,
} from "../desktop/settings.mjs";

test("detectModeFromConfig distinguishes all-api and hybrid", () => {
  assert.equal(detectModeFromConfig({}), MODE_ALL_API);
  assert.equal(
    detectModeFromConfig({ clientAuth: { allowOpenAiBearer: true } }),
    MODE_HYBRID,
  );
});

test("buildCodexToml uses local token in all-api mode", () => {
  const rootDir = path.join(os.tmpdir(), "codex-bridge-router");
  const toml = buildCodexToml({
    rootDir,
    mode: MODE_ALL_API,
    port: 15722,
  });

  const expectedCatalogPath = path.resolve(rootDir, "model-catalog.json").replaceAll("\\", "/");
  assert.match(toml, /experimental_bearer_token = "sk-local-codex-router"/);
  assert.match(toml, /supports_websockets = false/);
  assert.match(toml, /base_url = "http:\/\/localhost:15722\/v1"/);
  assert.doesNotMatch(toml, /requires_openai_auth/);
  assert.match(toml, new RegExp(`model_catalog_json = "${escapeRegExp(expectedCatalogPath)}"`));
});

test("buildCodexToml uses OpenAI auth in hybrid mode", () => {
  const toml = buildCodexToml({
    rootDir: path.join(os.tmpdir(), "codex-bridge-router"),
    mode: MODE_HYBRID,
    port: 15722,
  });

  assert.match(toml, /requires_openai_auth = true/);
  assert.match(toml, /supports_websockets = false/);
  assert.match(toml, /base_url = "http:\/\/localhost:15722\/v1"/);
  assert.doesNotMatch(toml, /experimental_bearer_token/);
});

test("saveSecrets records only non-empty values", () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, {
    OPENAI_API_KEY: "  openai-key  ",
    DEEPSEEK_API_KEY: "",
    MOONSHOT_API_KEY: "kimi-key",
  });

  assert.deepEqual(secretStatus(rootDir), {
    ARK_API_KEY: false,
    DASHSCOPE_API_KEY: false,
    DEEPSEEK_API_KEY: false,
    HUNYUAN_API_KEY: false,
    MIMO_API_KEY: false,
    MINIMAX_API_KEY: false,
    MOONSHOT_API_KEY: true,
    OPENAI_API_KEY: true,
    OPENROUTER_API_KEY: false,
    QIANFAN_API_KEY: false,
    SILICONFLOW_API_KEY: false,
    STEPFUN_API_KEY: false,
    ZHIPUAI_API_KEY: false,
  });

  saveSecrets(rootDir, {
    OPENAI_API_KEY: "",
    DEEPSEEK_API_KEY: "deepseek-key",
    MOONSHOT_API_KEY: "",
  });

  assert.deepEqual(secretStatus(rootDir), {
    ARK_API_KEY: false,
    DASHSCOPE_API_KEY: false,
    DEEPSEEK_API_KEY: true,
    HUNYUAN_API_KEY: false,
    MIMO_API_KEY: false,
    MINIMAX_API_KEY: false,
    MOONSHOT_API_KEY: true,
    OPENAI_API_KEY: true,
    OPENROUTER_API_KEY: false,
    QIANFAN_API_KEY: false,
    SILICONFLOW_API_KEY: false,
    STEPFUN_API_KEY: false,
    ZHIPUAI_API_KEY: false,
  });
});

test("secretValue returns only known provider secrets", () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, {
    DEEPSEEK_API_KEY: "deepseek-key",
    UNKNOWN_API_KEY: "unknown-key",
  });

  assert.equal(secretValue(rootDir, "DEEPSEEK_API_KEY"), "deepseek-key");
  assert.throws(() => secretValue(rootDir, "UNKNOWN_API_KEY"), /Unknown API key env/);
});

test("provider catalog uses the current Kimi API key console", () => {
  const kimi = providerCatalog(makeTempProject()).find((provider) => provider.id === "kimi");

  assert.equal(kimi.keyUrl, "https://platform.kimi.com/console/api-keys");
});

test("provider catalog uses the domestic MiniMax platform", () => {
  const minimax = providerCatalog(makeTempProject()).find((provider) => provider.id === "minimax");

  assert.equal(minimax.keyUrl, "https://www.minimaxi.com/");
  assert.equal(minimax.docsUrl, "https://platform.minimaxi.com/docs/api-reference/text-openai-api");
  assert.equal(minimax.baseUrl, "https://api.minimaxi.com/v1");
  assert.equal(minimax.keyUrl.includes("minimax.io"), false);
  assert.equal(minimax.docsUrl.includes("minimax.io"), false);
  assert.equal(minimax.baseUrl.includes("minimax.io"), false);
});

test("provider catalog includes additional domestic OpenAI-compatible providers", () => {
  const providers = providerCatalog(makeTempProject());
  const byId = new Map(providers.map((provider) => [provider.id, provider]));

  assert.equal(byId.get("xiaomi")?.baseUrl, "https://api.xiaomimimo.com/v1");
  assert.equal(byId.get("minimax")?.baseUrl, "https://api.minimaxi.com/v1");
  assert.equal(byId.get("stepfun")?.baseUrl, "https://api.stepfun.ai/step_plan/v1");
  assert.equal(byId.get("qianfan")?.baseUrl, "https://api.baiduqianfan.ai/v1");
  assert.equal(byId.get("hunyuan")?.baseUrl, "https://api.hunyuan.cloud.tencent.com/v1");
  assert.equal(byId.get("volcengine")?.baseUrl, "https://ark.cn-beijing.volces.com/api/v3");
});

test("model presets include extra domestic coding and general models", () => {
  const presetIds = new Set(MODEL_PRESETS.map((model) => model.presetId));

  assert.ok(presetIds.has("xiaomi-mimo-v2-5-pro"));
  assert.ok(presetIds.has("minimax-m3"));
  assert.ok(presetIds.has("stepfun-step-3-7-flash"));
  assert.ok(presetIds.has("qianfan-ernie-4-0-turbo-8k"));
  assert.ok(presetIds.has("hunyuan-turbos-latest"));
  assert.ok(presetIds.has("doubao-seed-1-8"));
});

test("vision-capable presets advertise image input and text-only presets stay text-only", () => {
  const byId = new Map(MODEL_PRESETS.map((model) => [model.presetId, model]));

  assert.deepEqual(byId.get("kimi-k2-7-code")?.inputModalities, ["text", "image"]);
  assert.deepEqual(byId.get("kimi-k2-6")?.inputModalities, ["text", "image"]);
  assert.deepEqual(byId.get("xiaomi-mimo-v2-5-pro")?.inputModalities, ["text", "image"]);
  assert.deepEqual(byId.get("minimax-m3")?.inputModalities, ["text", "image"]);
  assert.deepEqual(byId.get("qwen3-vl-plus")?.inputModalities, ["text", "image"]);
  assert.deepEqual(byId.get("glm-4-6v")?.inputModalities, ["text", "image"]);
  assert.equal(byId.get("deepseek-v4-pro")?.inputModalities, undefined);
  assert.equal(byId.get("qwen3-coder-plus")?.inputModalities, undefined);
});

test("native GPT subscription presets advertise Codex fast mode", () => {
  const byId = new Map(MODEL_PRESETS.map((model) => [model.presetId, model]));
  const fastTier = [
    {
      id: "priority",
      name: "Fast",
      description: "1.5x speed, increased usage",
    },
  ];

  for (const presetId of ["codex-gpt-5-5", "codex-gpt-5-4"]) {
    assert.deepEqual(byId.get(presetId)?.additionalSpeedTiers, ["fast"]);
    assert.deepEqual(byId.get(presetId)?.serviceTiers, fastTier);
  }
  assert.equal(byId.get("codex-gpt-5-4-mini")?.serviceTiers, undefined);
  assert.equal(byId.get("openai-gpt-4-1")?.serviceTiers, undefined);
});

test("built-in catalog does not recommend the private Fenno GPT provider", () => {
  const providers = providerCatalog(makeTempProject());
  const providerIds = new Set(providers.map((provider) => provider.id));
  const presetIds = new Set(MODEL_PRESETS.map((model) => model.presetId));

  assert.equal(providerIds.has("fenno"), false);
  assert.equal(Array.from(presetIds).some((id) => id.startsWith("fenno-")), false);
});

test("buildRouterConfigFromSelection maps selected models into five Codex slots", () => {
  const rootDir = makeTempProject();
  saveSelection(rootDir, [
    "codex-gpt-5-5",
    "codex-gpt-5-4",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "kimi-k2-7-code",
    "qwen-plus",
  ]);

  const config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.equal(config.models.length, 5);
  assert.deepEqual(config.models.map((model) => model.id), [
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex",
    "gpt-5.2",
  ]);
  assert.equal(config.models[2].displayName, "DeepSeek V4 Pro");
  assert.equal(config.models[4].displayName, "Kimi K2.7 Code");
});

test("buildRouterConfigFromSelection preserves native GPT speed tiers", () => {
  const rootDir = makeTempProject();
  saveSelection(rootDir, ["codex-gpt-5-5", "codex-gpt-5-4"]);

  const config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.deepEqual(config.models[0].additionalSpeedTiers, ["fast"]);
  assert.deepEqual(config.models[0].serviceTiers, [
    {
      id: "priority",
      name: "Fast",
      description: "1.5x speed, increased usage",
    },
  ]);
  assert.deepEqual(config.models[1].additionalSpeedTiers, ["fast"]);
  assert.equal(config.models[0].id, "gpt-5.5");
  assert.equal(config.models[1].id, "gpt-5.4");
});

test("domestic model presets route with their own provider keys", () => {
  const rootDir = makeTempProject();
  saveSelection(rootDir, [
    "xiaomi-mimo-v2-5-pro",
    "minimax-m3",
    "stepfun-step-3-7-flash",
    "qianfan-ernie-4-0-turbo-8k",
    "hunyuan-turbos-latest",
  ]);

  const config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.deepEqual(
    config.models.map((model) => model.apiKeyEnv),
    [
      "MIMO_API_KEY",
      "MINIMAX_API_KEY",
      "STEPFUN_API_KEY",
      "QIANFAN_API_KEY",
      "HUNYUAN_API_KEY",
    ],
  );
  assert.equal(config.models[0].displayName, "MiMo V2.5 Pro");
  assert.equal(config.models[1].model, "MiniMax-M3");
  assert.equal(config.models[2].baseUrl, "https://api.stepfun.ai/step_plan/v1");
});

test("all-api defaults use public API presets only", () => {
  const rootDir = makeTempProject();
  const config = buildRouterConfigFromSelection(rootDir, MODE_ALL_API);

  assert.equal(config.models.length, 5);
  assert.equal(config.models.some((model) => model.baseUrl.includes("fenno.ai")), false);
  assert.equal(config.models.some((model) => model.apiKeyEnv === "FENNO_API_KEY"), false);
  assert.equal(config.models[0].apiKeyEnv, "OPENAI_API_KEY");
});

test("bundled all-api router template does not contain private Fenno routes", () => {
  const template = fs.readFileSync(
    path.join(process.cwd(), "config", "router.config.example.json"),
    "utf8",
  );

  assert.doesNotMatch(template, /fenno/i);
  assert.doesNotMatch(template, /FENNO_API_KEY/);
});

test("custom models can be saved and routed with their own API key env", () => {
  const rootDir = makeTempProject();
  const custom = saveCustomModel(rootDir, {
    providerName: "My Provider",
    displayName: "My Coder",
    model: "my-coder-v1",
    baseUrl: "https://api.example.com/v1",
    api: "chat_completions",
  });
  saveSelection(rootDir, [custom.presetId]);

  const config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.equal(config.models.length, 1);
  assert.equal(config.models[0].id, "gpt-5.5");
  assert.equal(config.models[0].displayName, "My Coder");
  assert.equal(config.models[0].apiKeyEnv, "MY_PROVIDER_API_KEY");
  assert.deepEqual(config.models[0].inputModalities, ["text", "image"]);
});

test("editing a custom model preserves its existing API key slot", () => {
  const rootDir = makeTempProject();
  const custom = saveCustomModel(rootDir, {
    providerName: "Original Provider",
    displayName: "Original Coder",
    model: "original-coder-v1",
    baseUrl: "https://api.original.example/v1",
    api: "chat_completions",
  });

  const edited = saveCustomModel(rootDir, {
    presetId: custom.presetId,
    providerName: "Renamed Provider",
    displayName: "Renamed Coder",
    model: "renamed-coder-v2",
    baseUrl: "https://api.renamed.example/v1",
    api: "responses",
  });
  const saved = readCustomModels(rootDir);

  assert.equal(saved.length, 1);
  assert.equal(edited.presetId, custom.presetId);
  assert.equal(edited.displayName, "Renamed Coder");
  assert.equal(edited.keyEnv, custom.keyEnv);
  assert.equal(edited.apiKeyEnv, custom.apiKeyEnv);
});

test("legacy custom models without saved modalities default to image input", () => {
  const rootDir = makeTempProject();
  fs.mkdirSync(path.join(rootDir, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "config", "custom-models.json"),
    JSON.stringify([
      {
        presetId: "custom-legacy-vision",
        providerId: "custom-legacy",
        providerName: "Legacy Provider",
        displayName: "Legacy Vision",
        api: "chat_completions",
        baseUrl: "https://api.example.com/v1",
        model: "legacy-vision",
        authMode: "api_key",
        apiKeyEnv: "LEGACY_PROVIDER_API_KEY",
        keyEnv: "LEGACY_PROVIDER_API_KEY",
        custom: true,
      },
    ], null, 2),
    "utf8",
  );
  saveSelection(rootDir, ["custom-legacy-vision"]);

  const config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.deepEqual(config.models[0].inputModalities, ["text", "image"]);
});

test("ensureRouterConfig copies the selected example", () => {
  const rootDir = makeTempProject();
  fs.mkdirSync(path.join(rootDir, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "config", "router.config.example.json"),
    '{"clientAuth":{"allowOpenAiBearer":false},"models":[{"id":"a"}]}',
  );
  fs.writeFileSync(
    path.join(rootDir, "config", "router.config.hybrid.example.json"),
    '{"clientAuth":{"allowOpenAiBearer":true},"models":[{"id":"b"}]}',
  );

  ensureRouterConfig(rootDir, MODE_HYBRID);
  const copied = JSON.parse(
    fs.readFileSync(path.join(rootDir, "config", "router.config.json"), "utf8"),
  );
  assert.equal(copied.clientAuth.allowOpenAiBearer, true);
});

test("ensureRouterConfig can copy bundled templates into a separate data directory", () => {
  const dataRootDir = makeTempProject();
  const templateRootDir = makeTempProject();
  fs.mkdirSync(path.join(templateRootDir, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(templateRootDir, "config", "router.config.example.json"),
    '{"clientAuth":{"allowOpenAiBearer":false},"models":[{"id":"api"}]}',
  );
  fs.writeFileSync(
    path.join(templateRootDir, "config", "router.config.hybrid.example.json"),
    '{"clientAuth":{"allowOpenAiBearer":true},"models":[{"id":"hybrid"}]}',
  );

  const target = ensureRouterConfig(dataRootDir, MODE_HYBRID, templateRootDir);
  const copied = JSON.parse(fs.readFileSync(target, "utf8"));

  assert.equal(target, path.join(dataRootDir, "config", "router.config.json"));
  assert.equal(copied.models[0].id, "hybrid");
});

test("applyCodexConfig writes config and creates backup", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const target = path.join(codexDir, "config.toml");
  fs.writeFileSync(target, 'model = "old"\n', "utf8");

  const result = applyCodexConfig({
    rootDir,
    mode: MODE_HYBRID,
    homeDir,
  });

  const written = fs.readFileSync(target, "utf8");
  assert.match(written, /requires_openai_auth = true/);
  assert.equal(result.target, target);
  assert.equal(fs.existsSync(result.backup), true);
});

test("applyCodexConfig skips backup when Codex config is already current", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const target = path.join(codexDir, "config.toml");
  fs.writeFileSync(target, buildCodexToml({ rootDir, mode: MODE_HYBRID }), "utf8");

  const result = applyCodexConfig({
    rootDir,
    mode: MODE_HYBRID,
    homeDir,
  });

  assert.equal(result.target, target);
  assert.equal(result.backup, null);
  assert.equal(fs.readdirSync(codexDir).filter((name) => name.includes(".bak")).length, 0);
});

test("prepareRouterStartConfig refreshes stale Codex local endpoint before router starts", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const target = path.join(codexDir, "config.toml");
  fs.writeFileSync(
    target,
    [
      'model_provider = "codex-bridge"',
      'model_catalog_json = "C:/old/model-catalog.json"',
      "[model_providers.codex-bridge]",
      'base_url = "http://127.0.0.1:15722/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n"),
    "utf8",
  );
  saveSelection(rootDir, ["codex-gpt-5-5", "deepseek-v4-pro"], MODE_HYBRID);

  const result = prepareRouterStartConfig({ rootDir, mode: MODE_HYBRID, homeDir });

  const written = fs.readFileSync(target, "utf8");
  assert.equal(result.config.defaultModel, "gpt-5.5");
  assert.match(written, /base_url = "http:\/\/localhost:15722\/v1"/);
  assert.doesNotMatch(written, /http:\/\/127\.0\.0\.1:15722\/v1/);
});

test("restoreCodexConfig restores the latest CodexBridge backup", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const target = path.join(codexDir, "config.toml");
  fs.writeFileSync(target, 'model = "before"\n', "utf8");

  const first = applyCodexConfig({ rootDir, mode: MODE_HYBRID, homeDir });
  fs.writeFileSync(target, 'model = "manual-after"\n', "utf8");
  const second = applyCodexConfig({ rootDir, mode: MODE_ALL_API, homeDir });
  assert.notEqual(first.backup, second.backup);

  const restored = restoreCodexConfig({ homeDir });

  assert.equal(restored.target, target);
  assert.equal(restored.backup, second.backup);
  assert.equal(fs.readFileSync(target, "utf8"), 'model = "manual-after"\n');
});

test("restoreCodexConfig prefers the latest non-CodexBridge backup", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const target = path.join(codexDir, "config.toml");
  fs.writeFileSync(target, 'model = "original-user-config"\n', "utf8");

  applyCodexConfig({ rootDir, mode: MODE_HYBRID, homeDir });
  applyCodexConfig({ rootDir, mode: MODE_ALL_API, homeDir });

  restoreCodexConfig({ homeDir });

  assert.equal(fs.readFileSync(target, "utf8"), 'model = "original-user-config"\n');
});

test("restoreCodexConfig falls back to the oldest backup when all backups are CodexBridge configs", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const target = path.join(codexDir, "config.toml");
  fs.writeFileSync(target, buildCodexToml({ rootDir, mode: MODE_HYBRID }), "utf8");

  applyCodexConfig({ rootDir, mode: MODE_ALL_API, homeDir });
  restoreCodexConfig({ homeDir });

  assert.match(fs.readFileSync(target, "utf8"), /model_provider = "codex-bridge"/);
});

test("restoreCodexConfig explains when no backup exists", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));

  assert.throws(() => restoreCodexConfig({ homeDir }), /没有找到 CodexBridge 写入前的备份/);
});

function makeTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-test-"));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
