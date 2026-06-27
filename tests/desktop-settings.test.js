import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  MODE_ALL_API,
  MODE_HYBRID,
  MODEL_PRESETS,
  applyCodexConfig,
  buildRouterConfigFromSelection,
  buildCodexToml,
  detectModeFromConfig,
  ensureRouterConfig,
  loadDesktopOptions,
  modelCatalog,
  providerCatalog,
  prepareRouterStartConfig,
  readModelCapabilityOverrides,
  readModelDirectory,
  readRouterConfig,
  readCustomModels,
  refreshProviderModelDirectory,
  recoverCodexHistoryAccess,
  removeCustomModel,
  restoreCodexConfig,
  routerConfigPath,
  routerConfigDiagnostics,
  routerRuntimeEnv,
  readModelImageGenerationOverrides,
  saveModelImageInputOverride,
  saveModelCapabilityOverride,
  saveModelImageGenerationOverride,
  saveCustomModel,
  saveDesktopOptions,
  saveSelection,
  saveSecrets,
  secretValue,
  secretStatus,
  supportDiagnostics,
  syncCodexBridgeConversationProviders,
  writeRouterConfigFromSelection,
} from "../desktop/settings.mjs";

test("detectModeFromConfig distinguishes all-api and hybrid", () => {
  assert.equal(detectModeFromConfig({}), MODE_ALL_API);
  assert.equal(detectModeFromConfig({ mode: MODE_ALL_API, clientAuth: { allowOpenAiBearer: true } }), MODE_ALL_API);
  assert.equal(detectModeFromConfig({ mode: MODE_HYBRID, clientAuth: { allowOpenAiBearer: false } }), MODE_HYBRID);
  assert.equal(
    detectModeFromConfig({ clientAuth: { allowOpenAiBearer: true } }),
    MODE_HYBRID,
  );
});

test("buildCodexToml uses built-in OpenAI provider in all-api mode", () => {
  const rootDir = path.join(os.tmpdir(), "codex-bridge-router");
  const toml = buildCodexToml({
    rootDir,
    mode: MODE_ALL_API,
    port: 15722,
  });

  const expectedCatalogPath = path.resolve(rootDir, "model-catalog.json").replaceAll("\\", "/");
  assert.match(toml, /model_provider = "openai"/);
  assert.match(toml, /openai_base_url = "http:\/\/localhost:15722\/v1"/);
  assert.doesNotMatch(toml, /experimental_bearer_token/);
  assert.doesNotMatch(toml, /requires_openai_auth/);
  assert.doesNotMatch(toml, /supports_websockets/);
  assert.doesNotMatch(toml, /\[model_providers\.codex-bridge]/);
  assert.match(toml, new RegExp(`model_catalog_json = "${escapeRegExp(expectedCatalogPath)}"`));
});

test("buildCodexToml wraps CodexBridge-owned settings in managed markers", () => {
  const rootDir = path.join(os.tmpdir(), "codex-bridge-router");
  const toml = buildCodexToml({
    rootDir,
    mode: MODE_HYBRID,
  });

  assert.match(toml, /# >>> CodexBridge managed config/);
  assert.match(toml, /# <<< CodexBridge managed config/);
  assert.ok(toml.indexOf("# >>> CodexBridge managed config") < toml.indexOf("openai_base_url"));
  assert.ok(toml.indexOf("openai_base_url") < toml.indexOf("# <<< CodexBridge managed config"));
});

test("buildCodexToml keeps the built-in OpenAI provider in hybrid mode", () => {
  const toml = buildCodexToml({
    rootDir: path.join(os.tmpdir(), "codex-bridge-router"),
    mode: MODE_HYBRID,
    port: 15722,
  });

  assert.match(toml, /model_provider = "openai"/);
  assert.match(toml, /openai_base_url = "http:\/\/localhost:15722\/v1"/);
  assert.doesNotMatch(toml, /requires_openai_auth/);
  assert.doesNotMatch(toml, /supports_websockets/);
  assert.doesNotMatch(toml, /\[model_providers\.codex-bridge]/);
  assert.doesNotMatch(toml, /experimental_bearer_token/);
});

test("buildCodexToml keeps Codex desktop history on the built-in provider", () => {
  const toml = buildCodexToml({
    rootDir: path.join(os.tmpdir(), "codex-bridge-router"),
    mode: MODE_HYBRID,
    port: 15722,
  });

  assert.match(toml, /model_provider = "openai"/);
  assert.doesNotMatch(toml, /model_provider = "codex-bridge"/);
  assert.doesNotMatch(toml, /\[model_providers\.codex-bridge]/);
});

test("buildCodexToml keeps Codex response storage enabled for history", () => {
  const toml = buildCodexToml({
    rootDir: path.join(os.tmpdir(), "codex-bridge-router"),
    mode: MODE_HYBRID,
    port: 15722,
  });

  assert.match(toml, /disable_response_storage = false/);
  assert.doesNotMatch(toml, /disable_response_storage = true/);
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

test("routerConfigDiagnostics reports selected API routes missing provider keys", () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, {
    DEEPSEEK_API_KEY: "deepseek-key",
  });
  const diagnostics = routerConfigDiagnostics(rootDir, {
    models: [
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        api: "responses",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.5",
        authMode: "codex_openai",
      },
      {
        id: "gpt-5.4-mini",
        displayName: "DeepSeek V4 Pro",
        api: "chat_completions",
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-v4-pro",
        authMode: "api_key",
        apiKeyEnv: "DEEPSEEK_API_KEY",
      },
      {
        id: "gpt-5.2",
        displayName: "Kimi K2.7 Code",
        api: "chat_completions",
        baseUrl: "https://api.moonshot.cn/v1",
        model: "kimi-k2.7-code",
        authMode: "api_key",
        apiKeyEnv: "MOONSHOT_API_KEY",
      },
    ],
  });

  assert.equal(diagnostics.ok, false);
  assert.equal(diagnostics.apiKeyRoutes, 2);
  assert.equal(diagnostics.savedApiKeyRoutes, 1);
  assert.deepEqual(diagnostics.missingApiKeys.map((item) => item.apiKeyEnv), ["MOONSHOT_API_KEY"]);
  assert.match(diagnostics.missingApiKeys[0].displayName, /Kimi/);
});

test("routerConfigDiagnostics reports invalid upstream base URLs", () => {
  const rootDir = makeTempProject();
  const diagnostics = routerConfigDiagnostics(rootDir, {
    models: [
      {
        id: "bad-url",
        displayName: "Bad URL",
        api: "chat_completions",
        baseUrl: "api.example.com/v1",
        model: "bad-model",
        authMode: "api_key",
        apiKey: "inline-key",
      },
    ],
  });

  assert.equal(diagnostics.ok, false);
  assert.deepEqual(diagnostics.invalidBaseUrls.map((item) => item.id), ["bad-url"]);
});

test("desktop options persist proxy bypass setting", () => {
  const rootDir = makeTempProject();

  assert.equal(loadDesktopOptions(rootDir).bypassSystemProxy, false);
  const saved = saveDesktopOptions(rootDir, { bypassSystemProxy: true });

  assert.equal(saved.bypassSystemProxy, true);
  assert.equal(loadDesktopOptions(rootDir).bypassSystemProxy, true);
});

test("routerRuntimeEnv disables system proxy when desktop option is enabled", () => {
  const rootDir = makeTempProject();
  saveDesktopOptions(rootDir, { bypassSystemProxy: true });

  const env = routerRuntimeEnv(rootDir, {
    PATH: "base-path",
    CODEXBRIDGE_DISABLE_SYSTEM_PROXY: "0",
  });

  assert.equal(env.PATH, "base-path");
  assert.equal(env.ROUTER_CONFIG, path.join(rootDir, "config", "router.config.json"));
  assert.equal(env.CODEXBRIDGE_SECRETS_FILE, path.join(rootDir, "config", "secrets.local.json"));
  assert.equal(env.CODEXBRIDGE_DISABLE_SYSTEM_PROXY, "1");
});

test("supportDiagnostics redacts keys and summarizes current config", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  createCodexStateDbWithMetadata(codexDir, [
    {
      id: "thread_hidden_history",
      modelProvider: "openai",
      title: "Hidden migrated thread",
      source: "vscode",
      threadSource: "user",
      archived: 1,
      hasUserEvent: 0,
    },
  ]);
  saveSecrets(rootDir, {
    DEEPSEEK_API_KEY: "sk-secret-value",
  });
  saveDesktopOptions(rootDir, { bypassSystemProxy: true });

  const diagnostics = supportDiagnostics(rootDir, {
    appVersion: "0.1.18",
    routerRunning: true,
    lastHealth: { ok: false, message: "connect ECONNREFUSED 127.0.0.1:15722" },
    config: {
      port: 15722,
      models: [
        {
          id: "gpt-5.4-mini",
          displayName: "DeepSeek V4 Pro",
          api: "chat_completions",
          baseUrl: "https://api.deepseek.com/v1",
          model: "deepseek-v4-pro",
          authMode: "api_key",
          apiKeyEnv: "DEEPSEEK_API_KEY",
        },
        {
          id: "gpt-5.2",
          displayName: "Kimi K2.7 Code",
          api: "chat_completions",
          baseUrl: "https://user:pass@api.moonshot.cn/v1?token=secret-token-123456",
          model: "kimi-k2.7-code",
          authMode: "api_key",
          apiKeyEnv: "MOONSHOT_API_KEY",
        },
      ],
    },
    logs: [
      "[10:00:00] access POST /v1/responses host=localhost:15722 ua=Codex",
      "[10:00:01] req_a1234567 !! upstream route=gpt-5.2 status=502 error=fetch failed cause=UND_ERR_CONNECT_TIMEOUT",
      "[10:00:02] authorization=Bearer sk-sensitive-token",
    ],
    homeDir,
  });

  assert.match(diagnostics.text, /CodexBridge Diagnostics/);
  assert.match(diagnostics.text, /version: 0\.1\.18/);
  assert.match(diagnostics.text, /routerRunning: true/);
  assert.match(diagnostics.text, /bypassSystemProxy: true/);
  assert.match(diagnostics.text, /DEEPSEEK_API_KEY: saved/);
  assert.match(diagnostics.text, /MOONSHOT_API_KEY: missing/);
  assert.match(diagnostics.text, /Kimi K2\.7 Code -> kimi-k2\.7-code/);
  assert.match(diagnostics.text, /DeepSeek V4 Pro -> deepseek-v4-pro .*provider=deepseek/);
  assert.match(diagnostics.text, /capabilities: tools=chat-functions images=none files=text-placeholder compact=chat-summary/);
  assert.match(diagnostics.text, /Codex history diagnostics/);
  assert.match(diagnostics.text, /state_5\.sqlite: threads=1/);
  assert.match(diagnostics.text, /hiddenCandidates=1/);
  assert.match(diagnostics.text, /thread_hidden_history/);
  assert.match(diagnostics.text, /archived=1/);
  assert.match(diagnostics.text, /hasUserEvent=0/);
  assert.match(diagnostics.text, /UND_ERR_CONNECT_TIMEOUT/);
  assert.doesNotMatch(diagnostics.text, /sk-secret-value/);
  assert.doesNotMatch(diagnostics.text, /sk-sensitive-token/);
  assert.doesNotMatch(diagnostics.text, /user:pass/);
  assert.doesNotMatch(diagnostics.text, /secret-token-123456/);
  assert.match(diagnostics.text, /api\.moonshot\.cn/);
});

test("supportDiagnostics includes route health, usage, proxy, and update paths without secrets", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-home-"));
  const updateDir = path.join(rootDir, "updates");
  saveDesktopOptions(rootDir, { bypassSystemProxy: true });

  const diagnostics = supportDiagnostics(rootDir, {
    appVersion: "0.1.101",
    routerRunning: true,
    updateDir,
    proxyEnv: {
      HTTPS_PROXY: "http://user:pass@127.0.0.1:7890",
      NO_PROXY: "localhost,127.0.0.1",
    },
    lastHealth: {
      ok: true,
      models: ["gpt-5.5", "deepseek-v4-pro"],
      unhealthyRoutes: 1,
      routes: [
        {
          id: "gpt-5.5",
          status: "healthy",
          api: "responses",
          model: "gpt-5.5",
        },
        {
          id: "deepseek-v4-pro",
          status: "rate_limited",
          api: "chat_completions",
          model: "deepseek-v4-pro",
          lastStatus: 429,
          lastErrorType: "rate_limit",
          cooldownRemainingMs: 12000,
          lastError: "Too Many Requests sk-sensitive-token",
        },
      ],
    },
    usageSummary: {
      totalCalls: 2,
      totalTokens: 321,
      statusCounts: { 200: 1, 429: 1 },
      latest: {
        route: "deepseek-v4-pro",
        status: 429,
        errorType: "rate_limit",
        error: "Too Many Requests sk-usage-secret",
      },
      byModel: [
        {
          route: "deepseek-v4-pro",
          calls: 2,
          errors: 1,
          lastStatus: 429,
          lastErrorType: "rate_limit",
          totalTokens: 321,
        },
      ],
    },
    config: {
      port: 15722,
      models: [
        {
          id: "deepseek-v4-pro",
          displayName: "DeepSeek V4 Pro",
          api: "chat_completions",
          baseUrl: "https://api.deepseek.com/v1",
          model: "deepseek-v4-pro",
          authMode: "api_key",
          apiKeyEnv: "DEEPSEEK_API_KEY",
        },
      ],
    },
    logs: [],
    homeDir,
  });

  assert.match(diagnostics.text, /Router route health/);
  assert.match(diagnostics.text, /deepseek-v4-pro: rate_limited/);
  assert.match(diagnostics.text, /lastErrorType=rate_limit/);
  assert.match(diagnostics.text, /cooldownMs=12000/);
  assert.match(diagnostics.text, /Usage diagnostics/);
  assert.match(diagnostics.text, /totalCalls: 2/);
  assert.match(diagnostics.text, /latest: deepseek-v4-pro status=429 errorType=rate_limit/);
  assert.match(diagnostics.text, /Proxy diagnostics/);
  assert.match(diagnostics.text, /HTTPS_PROXY: set http:\/\/127\.0\.0\.1:7890/);
  assert.match(diagnostics.text, /NO_PROXY: set localhost,127\.0\.0\.1/);
  assert.match(diagnostics.text, /Update diagnostics/);
  assert.match(diagnostics.text, new RegExp(escapeRegExp(updateDir)));
  assert.equal(diagnostics.summary.unhealthyRoutes, 1);
  assert.equal(diagnostics.summary.usage.totalCalls, 2);
  assert.equal(diagnostics.summary.proxy.HTTPS_PROXY, "set");
  assert.doesNotMatch(diagnostics.text, /user:pass/);
  assert.doesNotMatch(diagnostics.text, /sk-sensitive-token/);
  assert.doesNotMatch(diagnostics.text, /sk-usage-secret/);
});

test("supportDiagnostics reports effective upstream proxy per selected route", () => {
  const rootDir = makeTempProject();
  const diagnostics = supportDiagnostics(rootDir, {
    appVersion: "0.1.101",
    routerRunning: true,
    proxyEnv: {
      HTTPS_PROXY: "http://user:pass@127.0.0.1:7890",
      NO_PROXY: "localhost,127.0.0.1",
    },
    lastHealth: {
      ok: true,
      routes: [],
    },
    config: {
      port: 15722,
      models: [
        {
          id: "gpt-5.5",
          displayName: "GPT-5.5",
          api: "responses",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-5.5",
          authMode: "codex_openai",
        },
        {
          id: "local-test",
          displayName: "Local Test",
          api: "chat_completions",
          baseUrl: "http://localhost:9999/v1",
          model: "local-model",
          authMode: "api_key",
          apiKey: "inline-key",
        },
      ],
    },
    logs: [],
  });

  assert.match(diagnostics.text, /Effective upstream proxy/);
  assert.match(diagnostics.text, /gpt-5\.5: env:http:\/\/127\.0\.0\.1:7890/);
  assert.match(diagnostics.text, /local-test: direct/);
  assert.doesNotMatch(diagnostics.text, /user:pass/);
});

test("supportDiagnostics effective upstream proxy honors system proxy bypass", () => {
  const rootDir = makeTempProject();
  saveDesktopOptions(rootDir, { bypassSystemProxy: true });

  const diagnostics = supportDiagnostics(rootDir, {
    proxyEnv: {},
    proxySettingsOptions: {
      platform: "darwin",
      macosProxySettings: {
        httpsEnable: true,
        httpsProxy: "127.0.0.1",
        httpsPort: 7890,
        exceptions: [],
      },
    },
    lastHealth: { ok: true, routes: [] },
    config: {
      port: 15722,
      models: [
        {
          id: "gpt-5.5",
          displayName: "GPT-5.5",
          api: "responses",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-5.5",
          authMode: "codex_openai",
        },
      ],
    },
  });

  assert.match(diagnostics.text, /bypassSystemProxy: true/);
  assert.match(diagnostics.text, /gpt-5\.5: direct/);
  assert.equal(diagnostics.summary.effectiveProxyRoutes.direct, 1);
  assert.equal(diagnostics.summary.effectiveProxyRoutes.proxied, 0);
});

test("supportDiagnostics reports stale Codex plugin runtime without mutating it", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-home-"));
  const codexDir = path.join(homeDir, ".codex");
  const installRoot = path.join(homeDir, "OpenAI.Codex_26.616.3767.0_x64");
  const resourcesDir = path.join(installRoot, "app", "resources");
  const nodeBinDir = path.join(resourcesDir, "cua_node", "bin");
  const nodeModuleDir = path.join(nodeBinDir, "node_modules");
  const nodeReplPath = path.join(nodeBinDir, "node_repl.exe");
  const nodePath = path.join(nodeBinDir, "node.exe");
  const codexCliPath = path.join(resourcesDir, "codex.exe");
  const skyBasePath = path.join(nodeModuleDir, "@oai", "sky");
  const skyClientPath = path.join(
    skyBasePath,
    "dist",
    "project",
    "cua",
    "sky_js",
    "src",
    "targets",
    "windows",
    "internal",
    "computer_use_client_base.js",
  );
  const bundledManifest = path.join(
    resourcesDir,
    "plugins",
    "openai-bundled",
    "plugins",
    "computer-use",
    ".codex-plugin",
    "plugin.json",
  );
  const cachedManifest = path.join(
    codexDir,
    "plugins",
    "cache",
    "openai-bundled",
    "computer-use",
    "26.611.62324",
    ".codex-plugin",
    "plugin.json",
  );

  for (const filePath of [nodeReplPath, nodePath, codexCliPath, skyClientPath, bundledManifest, cachedManifest]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      filePath.endsWith("plugin.json")
        ? JSON.stringify({ version: filePath === bundledManifest ? "26.616.31447" : "26.611.62324" })
        : "",
      "utf8",
    );
  }

  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    [
      `notify = ["${toFixtureTomlPath(path.join(installRoot, "missing", "codex-computer-use.exe"))}", "turn-ended"]`,
      "",
      '[plugins."computer-use@openai-bundled"]',
      "enabled = true",
      "",
      '[plugins."chrome@openai-bundled"]',
      "enabled = true",
      "",
      "[mcp_servers.node_repl]",
      `command = "${toFixtureTomlPath(nodeReplPath)}"`,
      "",
      "[mcp_servers.node_repl.env]",
      `CODEX_CLI_PATH = "${toFixtureTomlPath(codexCliPath)}"`,
      `NODE_REPL_NODE_PATH = "${toFixtureTomlPath(nodePath)}"`,
      `NODE_REPL_NODE_MODULE_DIRS = "${toFixtureTomlPath(nodeModuleDir)}"`,
      "",
    ].join("\n"),
    "utf8",
  );

  const diagnostics = supportDiagnostics(rootDir, {
    lastHealth: { ok: true },
    config: { port: 15722, models: [] },
    homeDir,
  });

  assert.equal(diagnostics.summary.codexPlugins.ok, false);
  assert.match(diagnostics.text, /Codex plugin diagnostics/);
  assert.match(diagnostics.text, /computer-use: enabled=true, cached=26\.611\.62324, bundled=26\.616\.31447, stale=true/);
  assert.match(diagnostics.text, /chrome: enabled=true/);
  assert.match(diagnostics.text, /node_repl command: ok/);
  assert.match(diagnostics.text, /sky runtime: ok/);
  assert.match(diagnostics.text, /notify hook: missing/);
});

test("supportDiagnostics reports encoded-only sky runtime as not importable", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-home-"));
  const codexDir = path.join(homeDir, ".codex");
  const resourcesDir = path.join(homeDir, "OpenAI.Codex_26.616.3767.0_x64", "app", "resources");
  const nodeBinDir = path.join(resourcesDir, "cua_node", "bin");
  const nodeModuleDir = path.join(nodeBinDir, "node_modules");
  const nodeReplPath = path.join(nodeBinDir, "node_repl.exe");
  const nodePath = path.join(nodeBinDir, "node.exe");
  const codexCliPath = path.join(resourcesDir, "codex.exe");
  const encodedSkyClientPath = path.join(
    nodeModuleDir,
    "%40oai",
    "sky",
    "dist",
    "project",
    "cua",
    "sky_js",
    "src",
    "targets",
    "windows",
    "internal",
    "computer_use_client_base.js",
  );

  for (const filePath of [nodeReplPath, nodePath, codexCliPath, encodedSkyClientPath]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "", "utf8");
  }
  fs.mkdirSync(codexDir, { recursive: true });

  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    [
      '[plugins."computer-use@openai-bundled"]',
      "enabled = true",
      "",
      "[mcp_servers.node_repl]",
      `command = "${toFixtureTomlPath(nodeReplPath)}"`,
      "",
      "[mcp_servers.node_repl.env]",
      `CODEX_CLI_PATH = "${toFixtureTomlPath(codexCliPath)}"`,
      `NODE_REPL_NODE_PATH = "${toFixtureTomlPath(nodePath)}"`,
      `NODE_REPL_NODE_MODULE_DIRS = "${toFixtureTomlPath(nodeModuleDir)}"`,
      "",
    ].join("\n"),
    "utf8",
  );

  const diagnostics = supportDiagnostics(rootDir, {
    lastHealth: { ok: true },
    config: { port: 15722, models: [] },
    homeDir,
  });

  assert.equal(diagnostics.summary.codexPlugins.ok, false);
  assert.equal(diagnostics.summary.codexPlugins.reason, "sky_runtime_missing");
  assert.match(diagnostics.text, /sky runtime: missing encoded_scope_only/);
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

  assert.deepEqual(byId.get("codex-gpt-5-5")?.inputModalities, ["text", "image"]);
  assert.deepEqual(byId.get("codex-gpt-5-4")?.inputModalities, ["text", "image"]);
  assert.deepEqual(byId.get("codex-gpt-5-4-mini")?.inputModalities, ["text", "image"]);
  assert.deepEqual(byId.get("openai-gpt-4-1")?.inputModalities, ["text", "image"]);
  assert.deepEqual(byId.get("openai-gpt-4-1-mini")?.inputModalities, ["text", "image"]);
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

test("native GPT subscription presets use the Codex desktop context window", () => {
  const byId = new Map(MODEL_PRESETS.map((model) => [model.presetId, model]));

  assert.equal(byId.get("codex-gpt-5-5")?.contextWindow, 258400);
  assert.equal(byId.get("codex-gpt-5-4")?.contextWindow, 258400);
  assert.equal(byId.get("codex-gpt-5-4-mini")?.contextWindow, 258400);
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

  assert.equal(config.mode, MODE_HYBRID);
  assert.equal(config.clientAuth.allowOpenAiBearer, true);
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

test("chat completion routes get a conservative default tool guard", () => {
  const rootDir = makeTempProject();
  saveSelection(rootDir, ["deepseek-v4-pro", "kimi-k2-7-code"], MODE_HYBRID);

  const config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.equal(config.models[0].api, "chat_completions");
  assert.equal(config.models[0].maxToolContinuationTurns, 5);
  assert.equal(config.models[1].api, "chat_completions");
  assert.equal(config.models[1].maxToolContinuationTurns, 5);
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

  assert.equal(config.mode, MODE_ALL_API);
  assert.equal(config.clientAuth.allowOpenAiBearer, true);
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
  assert.deepEqual(config.models[0].inputModalities, ["text"]);
  assert.equal(config.models[0].dropParams, undefined);
});

test("legacy custom default dropped params are ignored when routed", () => {
  const rootDir = makeTempProject();
  const configDir = path.join(rootDir, "config");
  fs.mkdirSync(configDir, { recursive: true });
  const customModelsFile = path.join(configDir, "custom-models.json");
  fs.writeFileSync(
    customModelsFile,
    JSON.stringify([
      {
        presetId: "custom-legacy-model",
        providerId: "custom-legacy",
        providerName: "Legacy Custom",
        displayName: "Legacy Custom Model",
        api: "chat_completions",
        baseUrl: "https://api.example.com/v1",
        model: "legacy-custom-model",
        authMode: "api_key",
        apiKeyEnv: "LEGACY_CUSTOM_API_KEY",
        inputModalities: ["text"],
        dropParams: ["response_format", "parallel_tool_calls"],
        custom: true,
      },
    ], null, 2),
    "utf8",
  );
  saveSelection(rootDir, ["custom-legacy-model"]);

  const [custom] = readCustomModels(rootDir);
  const config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.equal(custom.dropParams, undefined);
  assert.equal(config.models[0].dropParams, undefined);
});

test("custom models preserve explicit image input when saved and routed", () => {
  const rootDir = makeTempProject();
  const custom = saveCustomModel(rootDir, {
    providerName: "Image Provider",
    displayName: "Image Coder",
    model: "image-coder-v1",
    baseUrl: "https://api.example.com/v1",
    api: "chat_completions",
    inputModalities: ["text", "image"],
  });
  saveSelection(rootDir, [custom.presetId]);

  const config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.deepEqual(custom.inputModalities, ["text", "image"]);
  assert.deepEqual(config.models[0].inputModalities, ["text", "image"]);
});

test("preset image upload support can be overridden per model", () => {
  const rootDir = makeTempProject();
  saveSelection(rootDir, ["deepseek-v4-pro"]);

  const defaultConfig = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);
  assert.equal(defaultConfig.models[0].inputModalities, undefined);

  saveModelImageInputOverride(rootDir, "deepseek-v4-pro", true);
  const enabledConfig = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);
  assert.deepEqual(enabledConfig.models[0].inputModalities, ["text", "image"]);

  saveModelImageInputOverride(rootDir, "deepseek-v4-pro", false);
  const disabledConfig = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);
  assert.deepEqual(disabledConfig.models[0].inputModalities, ["text"]);
});

test("image generation provider can be configured per model", () => {
  const rootDir = makeTempProject();
  saveSelection(rootDir, ["codex-gpt-5-5", "deepseek-v4-pro"]);

  const defaultConfig = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);
  assert.equal(defaultConfig.models[0].imageGeneration.mode, "official");
  assert.equal(defaultConfig.models[0].imageGeneration.apiKeyEnv, "OPENAI_API_KEY");
  assert.equal(defaultConfig.models[1].imageGeneration.mode, "off");

  saveModelImageGenerationOverride(rootDir, "deepseek-v4-pro", {
    mode: "custom",
    displayName: "My Image API",
    baseUrl: "https://images.example.com/v1",
    endpoint: "/images/generations",
    model: "image-model-v1",
    size: "768x768",
    apiKeyEnv: "MY_IMAGE_API_KEY",
  });

  const overrides = readModelImageGenerationOverrides(rootDir);
  assert.equal(overrides["deepseek-v4-pro"].mode, "custom");

  const customConfig = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);
  assert.deepEqual(customConfig.models[1].imageGeneration, {
    enabled: true,
    mode: "custom",
    displayName: "My Image API",
    baseUrl: "https://images.example.com/v1",
    endpoint: "/images/generations",
    model: "image-model-v1",
    size: "768x768",
    apiKeyEnv: "MY_IMAGE_API_KEY",
  });
});

test("legacy official image generation overrides are ignored for non OpenAI models", () => {
  const rootDir = makeTempProject();
  saveSelection(rootDir, ["deepseek-v4-pro"]);
  saveModelImageGenerationOverride(rootDir, "deepseek-v4-pro", {
    mode: "official",
  });

  const config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);
  assert.equal(config.models[0].imageGeneration.mode, "off");
  assert.equal(config.models[0].imageGeneration.enabled, false);
  assert.equal(config.models[0].imageGeneration.apiKeyEnv, "");
});

test("legacy false image overrides do not disable built-in vision presets", () => {
  const rootDir = makeTempProject();
  const capabilitiesPath = path.join(rootDir, "config", "model-capabilities.json");
  fs.mkdirSync(path.dirname(capabilitiesPath), { recursive: true });
  fs.writeFileSync(
    capabilitiesPath,
    `${JSON.stringify({
      version: 1,
      imageInput: {
        "codex-gpt-5-5": false,
        "deepseek-v4-pro": true,
      },
    }, null, 2)}\n`,
    "utf8",
  );
  saveSelection(rootDir, ["codex-gpt-5-5", "deepseek-v4-pro"]);

  const migratedConfig = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);
  assert.deepEqual(migratedConfig.models[0].inputModalities, ["text", "image"]);
  assert.deepEqual(migratedConfig.models[1].inputModalities, ["text", "image"]);

  saveModelImageInputOverride(rootDir, "codex-gpt-5-5", false);
  const explicitConfig = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);
  assert.deepEqual(explicitConfig.models[0].inputModalities, ["text"]);
});

test("provider model directory refresh caches model ids without saving secrets", async () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, { DEEPSEEK_API_KEY: "deepseek-secret" });

  const result = await refreshProviderModelDirectory(rootDir, "deepseek", {
    now: () => "2026-06-26T01:02:03.000Z",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.deepseek.com/v1/models");
      assert.equal(options.method, "GET");
      assert.equal(options.headers.Authorization, "Bearer deepseek-secret");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: "deepseek-v4-pro", object: "model", owned_by: "deepseek" },
            { id: "deepseek-reasoner", created: 123 },
          ],
        }),
      };
    },
  });

  const directory = readModelDirectory(rootDir);
  const cached = directory.providers.deepseek;

  assert.equal(result.ok, true);
  assert.equal(result.providerId, "deepseek");
  assert.deepEqual(result.models.map((model) => model.id), [
    "deepseek-v4-pro",
    "deepseek-reasoner",
  ]);
  assert.equal(cached.fetchedAt, "2026-06-26T01:02:03.000Z");
  assert.equal(cached.baseUrl, "https://api.deepseek.com/v1");
  assert.deepEqual(cached.models.map((model) => model.id), [
    "deepseek-v4-pro",
    "deepseek-reasoner",
  ]);
  assert.equal(JSON.stringify(directory).includes("deepseek-secret"), false);
});

test("provider model directory refresh failure keeps presets and router config intact", async () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, { DEEPSEEK_API_KEY: "deepseek-secret" });
  saveSelection(rootDir, ["codex-gpt-5-5", "deepseek-v4-pro"]);
  const before = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  const result = await refreshProviderModelDirectory(rootDir, "deepseek", {
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      text: async () => "temporarily unavailable",
    }),
  });

  const after = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);
  const catalogIds = new Set(modelCatalog(rootDir).map((model) => model.presetId));

  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP 503/);
  assert.deepEqual(after, before);
  assert.equal(catalogIds.has("codex-gpt-5-5"), true);
  assert.equal(catalogIds.has("deepseek-v4-pro"), true);
});

test("subscription provider model directory refresh stays on offline presets", async () => {
  const rootDir = makeTempProject();
  let fetched = false;

  const result = await refreshProviderModelDirectory(rootDir, "codex", {
    fetchImpl: async () => {
      fetched = true;
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    },
  });
  const catalogIds = new Set(modelCatalog(rootDir).map((model) => model.presetId));

  assert.equal(result.ok, false);
  assert.match(result.error, /offline presets/);
  assert.equal(fetched, false);
  assert.equal(catalogIds.has("codex-gpt-5-5"), true);
});

test("manual capability overrides apply to one route without changing route-specific parameters", () => {
  const rootDir = makeTempProject();
  saveSelection(rootDir, ["deepseek-v4-pro", "kimi-k2-7-code"]);

  const saved = saveModelCapabilityOverride(rootDir, "deepseek-v4-pro", {
    inputModalities: ["text", "image", "file", "audio"],
    contextWindow: 123456,
    reasoning: { mode: "unknown", note: "manual verification pending" },
  });
  const overrides = readModelCapabilityOverrides(rootDir);
  const deepseek = modelCatalog(rootDir).find((model) => model.presetId === "deepseek-v4-pro");
  const config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.deepEqual(saved.inputModalities, ["text", "image", "file", "audio"]);
  assert.equal(saved.contextWindow, 123456);
  assert.equal(saved.reasoning.mode, "unknown");
  assert.deepEqual(overrides["deepseek-v4-pro"].inputModalities, ["text", "image", "file", "audio"]);
  assert.equal(deepseek.capabilityOverrideSource, "manual");
  assert.deepEqual(deepseek.inputModalities, ["text", "image", "file", "audio"]);
  assert.equal(deepseek.contextWindow, 123456);
  assert.deepEqual(config.models[0].inputModalities, ["text", "image", "file", "audio"]);
  assert.equal(config.models[0].contextWindow, 123456);
  assert.equal(config.models[0].capabilityOverrides.reasoning.mode, "unknown");
  assert.deepEqual(config.models[0].dropParams, ["response_format", "parallel_tool_calls"]);
  assert.equal(config.models[1].sourcePresetId, "kimi-k2-7-code");
  assert.equal(config.models[1].contextWindow, 258400);
});

test("custom models can disable image upload support", () => {
  const rootDir = makeTempProject();
  const custom = saveCustomModel(rootDir, {
    providerName: "Text Provider",
    displayName: "Text Coder",
    model: "text-coder-v1",
    baseUrl: "https://api.example.com/v1",
    api: "chat_completions",
    inputModalities: ["text"],
  });
  saveSelection(rootDir, [custom.presetId]);

  const config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.deepEqual(config.models[0].inputModalities, ["text"]);
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

test("legacy custom models without saved modalities default to text-only input", () => {
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

  assert.deepEqual(config.models[0].inputModalities, ["text"]);
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

test("writeRouterConfigFromSelection commits config with atomic rename", () => {
  const rootDir = makeTempProject();
  saveSelection(rootDir, ["deepseek-v4-pro"], MODE_HYBRID);
  let renameCalls = 0;
  const originalRenameSync = fs.renameSync;
  fs.renameSync = function renameSyncSpy(...args) {
    renameCalls += 1;
    return originalRenameSync.apply(this, args);
  };

  try {
    writeRouterConfigFromSelection(rootDir, MODE_HYBRID);
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(renameCalls, 1);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(routerConfigPath(rootDir), "utf8")));
});

test("saving a selected custom model refreshes router config", () => {
  const rootDir = makeTempProject();
  const custom = saveCustomModel(rootDir, {
    providerName: "Original Provider",
    displayName: "Original Coder",
    model: "original-coder-v1",
    baseUrl: "https://api.original.example/v1",
    api: "chat_completions",
  });
  saveSelection(rootDir, [custom.presetId], MODE_HYBRID);
  writeRouterConfigFromSelection(rootDir, MODE_HYBRID);

  saveCustomModel(rootDir, {
    presetId: custom.presetId,
    providerName: "Renamed Provider",
    displayName: "Renamed Coder",
    model: "renamed-coder-v2",
    baseUrl: "https://api.renamed.example/v1",
    api: "responses",
  });

  const config = readRouterConfig(rootDir);
  assert.equal(config.models[0].displayName, "Renamed Coder");
  assert.equal(config.models[0].model, "renamed-coder-v2");
  assert.equal(config.models[0].api, "responses");
});

test("removing a selected custom model refreshes router config and selection", () => {
  const rootDir = makeTempProject();
  const custom = saveCustomModel(rootDir, {
    providerName: "Temporary Provider",
    displayName: "Temporary Coder",
    model: "temporary-coder-v1",
    baseUrl: "https://api.temporary.example/v1",
    api: "chat_completions",
  });
  saveSelection(rootDir, [custom.presetId, "deepseek-v4-pro"], MODE_HYBRID);
  writeRouterConfigFromSelection(rootDir, MODE_HYBRID);

  removeCustomModel(rootDir, custom.presetId);

  const config = readRouterConfig(rootDir);
  assert.equal(config.models.length, 1);
  assert.equal(config.models[0].sourcePresetId, "deepseek-v4-pro");
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
  assert.match(written, /model_provider = "openai"/);
  assert.match(written, /openai_base_url = "http:\/\/localhost:15722\/v1"/);
  assert.doesNotMatch(written, /\[model_providers\.codex-bridge]/);
  assert.equal(result.target, target);
  assert.equal(fs.existsSync(result.backup), true);
});

test("applyCodexConfig preserves existing Codex user settings while adding CodexBridge", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const target = path.join(codexDir, "config.toml");
  fs.writeFileSync(
    target,
    [
      'sandbox_mode = "danger-full-access"',
      'approval_policy = "never"',
      'notify = ["C:/Codex/openai-bundled/computer-use/codex-computer-use.exe", "turn-ended"]',
      "",
      "[history]",
      'persistence = "save-all"',
      "",
      "[desktop]",
      'appearanceTheme = "dark"',
      "",
      "[projects.'f:\\game_code\\demo']",
      'trust_level = "trusted"',
      "",
      '[plugins."computer-use@openai-bundled"]',
      "enabled = true",
      "",
      "[mcp_servers.node_repl]",
      'command = "C:/Codex/node_repl.exe"',
      "",
      "[mcp_servers.node_repl.env]",
      'NODE_REPL_NODE_PATH = "C:/Codex/node.exe"',
      'NODE_REPL_NODE_MODULE_DIRS = "C:/Codex/node_modules"',
      "",
      "[hooks.state]",
      'notify = ["C:/Codex/hook.exe"]',
      "",
    ].join("\n"),
    "utf8",
  );

  applyCodexConfig({ rootDir, mode: MODE_HYBRID, homeDir });
  const written = fs.readFileSync(target, "utf8");

  assert.match(written, /model_provider = "openai"/);
  assert.match(written, /# >>> CodexBridge managed config/);
  assert.match(written, /# <<< CodexBridge managed config/);
  assert.match(written, /openai_base_url = "http:\/\/localhost:15722\/v1"/);
  assert.doesNotMatch(written, /\[model_providers\.codex-bridge]/);
  assert.match(written, /sandbox_mode = "danger-full-access"/);
  assert.match(written, /\[history]\s+persistence = "save-all"/);
  assert.match(written, /\[desktop]\s+appearanceTheme = "dark"/);
  assert.match(written, /\[projects\.'f:\\game_code\\demo']\s+trust_level = "trusted"/);
  assert.match(written, /notify = \["C:\/Codex\/openai-bundled\/computer-use\/codex-computer-use\.exe", "turn-ended"]/);
  assert.match(written, /\[plugins\."computer-use@openai-bundled"]\s+enabled = true/);
  assert.match(written, /\[mcp_servers\.node_repl]\s+command = "C:\/Codex\/node_repl\.exe"/);
  assert.match(written, /\[mcp_servers\.node_repl\.env]\s+NODE_REPL_NODE_PATH = "C:\/Codex\/node\.exe"\s+NODE_REPL_NODE_MODULE_DIRS = "C:\/Codex\/node_modules"/);
  assert.match(written, /\[hooks\.state]\s+notify = \["C:\/Codex\/hook\.exe"]/);
});

test("applyCodexConfig rolls back when written CodexBridge config fails validation", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const target = path.join(codexDir, "config.toml");
  const original = [
    'model = "user-model"',
    "",
    "[mcp_servers.node_repl]",
    'command = "C:/Codex/node_repl.exe"',
    "",
  ].join("\n");
  fs.writeFileSync(target, original, "utf8");

  assert.throws(
    () => applyCodexConfig({
      rootDir,
      mode: MODE_HYBRID,
      homeDir,
      validateWrittenConfig: () => {
        throw new Error("synthetic validation failure");
      },
    }),
    /synthetic validation failure/,
  );

  assert.equal(fs.readFileSync(target, "utf8"), original);
  assert.equal(fs.readdirSync(codexDir).some((name) => /^config\.toml\.codexbridge\..+\.bak$/.test(name)), true);
});

test("applyCodexConfig writes stable sandbox defaults when Codex has none", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const target = path.join(codexDir, "config.toml");
  fs.writeFileSync(target, 'model = "old"\n', "utf8");

  applyCodexConfig({ rootDir, mode: MODE_HYBRID, homeDir });
  const written = fs.readFileSync(target, "utf8");

  assert.match(written, /sandbox_mode = "danger-full-access"/);
  assert.match(written, /approval_policy = "never"/);
});

test("applyCodexConfig preserves current sandbox and approval settings", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const target = path.join(codexDir, "config.toml");
  fs.writeFileSync(
    target,
    [
      'sandbox_mode = "workspace-write"',
      'approval_policy = "on-request"',
      'model = "gpt-5.2"',
      "",
    ].join("\n"),
    "utf8",
  );

  applyCodexConfig({ rootDir, mode: MODE_HYBRID, homeDir });
  const written = fs.readFileSync(target, "utf8");

  assert.match(written, /sandbox_mode = "workspace-write"/);
  assert.match(written, /approval_policy = "on-request"/);
});

test("applyCodexConfig removes stale top-level Codex context overrides", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const target = path.join(codexDir, "config.toml");
  fs.writeFileSync(
    target,
    [
      'model = "gpt-5.5"',
      "model_context_window = 1100000",
      "model_max_output_tokens = 90000",
      "model_auto_compact_token_limit = 900000",
      "",
      "[mcp_servers.node_repl]",
      'command = "C:/Codex/node_repl.exe"',
      "",
    ].join("\n"),
    "utf8",
  );

  applyCodexConfig({ rootDir, mode: MODE_HYBRID, homeDir });
  const written = fs.readFileSync(target, "utf8");

  assert.match(written, /model_catalog_json = /);
  assert.doesNotMatch(written, /^model_context_window\s*=/m);
  assert.doesNotMatch(written, /^model_max_output_tokens\s*=/m);
  assert.doesNotMatch(written, /^model_auto_compact_token_limit\s*=/m);
  assert.match(written, /\[mcp_servers\.node_repl]\s+command = "C:\/Codex\/node_repl\.exe"/);
});

test("applyCodexConfig preserves the current Codex model selection", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const target = path.join(codexDir, "config.toml");
  fs.writeFileSync(
    target,
    [
      'model_provider = "openai"',
      'model = "gpt-5.2"',
      'model_reasoning_effort = "high"',
      "",
      "[history]",
      'persistence = "save-all"',
      "",
    ].join("\n"),
    "utf8",
  );

  applyCodexConfig({ rootDir, mode: MODE_HYBRID, homeDir });
  const written = fs.readFileSync(target, "utf8");

  assert.match(written, /model_provider = "openai"/);
  assert.match(written, /model = "gpt-5\.2"/);
  assert.match(written, /model_reasoning_effort = "high"/);
  assert.match(written, /openai_base_url = "http:\/\/localhost:15722\/v1"/);
  assert.match(written, /\[history]\s+persistence = "save-all"/);
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

test("applyCodexConfig syncs legacy CodexBridge conversations even when config is current", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const target = path.join(codexDir, "config.toml");
  fs.writeFileSync(target, buildCodexToml({ rootDir, mode: MODE_HYBRID }), "utf8");
  const dbPath = createCodexStateDb(codexDir, [
    ["thread_bridge", "codex-bridge", "gpt-5.5", "Bridge thread"],
    ["thread_openai", "openai", "gpt-5.5", "OpenAI thread"],
  ]);

  const result = applyCodexConfig({
    rootDir,
    mode: MODE_HYBRID,
    homeDir,
  });

  assert.equal(result.unchanged, true);
  assert.equal(result.historySync.totalUpdatedThreads, 1);
  assert.equal(providerCount(dbPath, "codex-bridge"), 0);
  assert.equal(providerCount(dbPath, "openai"), 2);
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
  assert.match(written, /model_provider = "openai"/);
  assert.match(written, /openai_base_url = "http:\/\/localhost:15722\/v1"/);
  assert.doesNotMatch(written, /\[model_providers\.codex-bridge]/);
  assert.doesNotMatch(written, /http:\/\/127\.0\.0\.1:15722\/v1/);
});

test("restoreCodexConfig restores the latest CodexBridge backup", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const target = path.join(codexDir, "config.toml");
  fs.writeFileSync(target, buildCodexToml({ rootDir, mode: MODE_HYBRID }), "utf8");
  const firstBackup = path.join(codexDir, "config.toml.codexbridge.2026-06-25-010000000.bak");
  const secondBackup = path.join(codexDir, "config.toml.codexbridge.2026-06-25-020000000.bak");
  fs.writeFileSync(firstBackup, 'model = "before"\n', "utf8");
  fs.writeFileSync(secondBackup, 'model = "manual-after"\n', "utf8");

  const restored = restoreCodexConfig({ homeDir });

  assert.equal(restored.target, target);
  assert.equal(restored.backup, secondBackup);
  assert.equal(fs.readFileSync(target, "utf8"), 'model = "manual-after"\n');
});

test("restoreCodexConfig prefers the latest non-CodexBridge backup", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const target = path.join(codexDir, "config.toml");
  fs.writeFileSync(target, buildCodexToml({ rootDir, mode: MODE_HYBRID }), "utf8");
  fs.writeFileSync(
    path.join(codexDir, "config.toml.codexbridge.2026-06-25-010000000.bak"),
    'model_provider = "openai"\nopenai_base_url = "http://localhost:15722/v1"\n',
    "utf8",
  );
  fs.writeFileSync(
    path.join(codexDir, "config.toml.codexbridge.2026-06-25-020000000.bak"),
    'model = "original-user-config"\n',
    "utf8",
  );

  restoreCodexConfig({ homeDir });

  assert.equal(fs.readFileSync(target, "utf8"), 'model = "original-user-config"\n');
});

test("restoreCodexConfig falls back to the oldest backup when all backups are CodexBridge configs", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const target = path.join(codexDir, "config.toml");
  const bridgeConfig = buildCodexToml({ rootDir, mode: MODE_HYBRID });
  fs.writeFileSync(target, bridgeConfig, "utf8");
  fs.writeFileSync(
    `${target}.codexbridge.2026-06-21-120000000.bak`,
    bridgeConfig,
    "utf8",
  );

  restoreCodexConfig({ homeDir });

  assert.match(fs.readFileSync(target, "utf8"), /model_provider = "openai"/);
});

test("restoreCodexConfig explains when no backup exists", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));

  assert.throws(() => restoreCodexConfig({ homeDir }), /没有找到 CodexBridge 写入前的备份/);
});

test("restoreCodexConfig can remove only the managed CodexBridge block when no backup exists", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const target = path.join(codexDir, "config.toml");
  fs.writeFileSync(
    target,
    [
      'notify = ["C:/Codex/openai-bundled/computer-use/codex-computer-use.exe", "turn-ended"]',
      "",
      buildCodexToml({ rootDir, mode: MODE_HYBRID }).trimEnd(),
      "",
      "[history]",
      'persistence = "save-all"',
      "",
      '[plugins."computer-use@openai-bundled"]',
      "enabled = true",
      "",
      "[mcp_servers.node_repl]",
      'command = "C:/Codex/node_repl.exe"',
      "",
      "[hooks.state]",
      'notify = ["C:/Codex/hook.exe"]',
      "",
    ].join("\n"),
    "utf8",
  );

  const restored = restoreCodexConfig({ homeDir });
  const written = fs.readFileSync(target, "utf8");

  assert.equal(restored.action, "strip_managed_block");
  assert.equal(restored.backup, null);
  assert.ok(restored.currentBackup);
  assert.doesNotMatch(written, /# >>> CodexBridge managed config/);
  assert.doesNotMatch(written, /openai_base_url = "http:\/\/localhost:15722\/v1"/);
  assert.match(written, /notify = \["C:\/Codex\/openai-bundled\/computer-use\/codex-computer-use\.exe", "turn-ended"]/);
  assert.match(written, /\[history]\s+persistence = "save-all"/);
  assert.match(written, /\[plugins\."computer-use@openai-bundled"]\s+enabled = true/);
  assert.match(written, /\[mcp_servers\.node_repl]\s+command = "C:\/Codex\/node_repl\.exe"/);
  assert.match(written, /\[hooks\.state]\s+notify = \["C:\/Codex\/hook\.exe"]/);
});

test("recoverCodexHistoryAccess keeps CodexBridge config and only enables history storage", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const target = path.join(codexDir, "config.toml");
  fs.writeFileSync(target, 'model = "original-history-view"\n', "utf8");

  applyCodexConfig({ rootDir, mode: MODE_HYBRID, homeDir });
  let current = fs.readFileSync(target, "utf8");
  current = current.replace("disable_response_storage = false", "disable_response_storage = true # old history toggle");
  fs.writeFileSync(target, current, "utf8");

  const recovered = recoverCodexHistoryAccess({ homeDir });
  const written = fs.readFileSync(target, "utf8");

  assert.equal(recovered.action, "recover_history_access");
  assert.equal(recovered.target, target);
  assert.match(written, /model_provider = "openai"/);
  assert.match(written, /openai_base_url = "http:\/\/localhost:15722\/v1"/);
  assert.match(written, /disable_response_storage = false/);
  assert.doesNotMatch(written, /original-history-view/);
  assert.match(recovered.message, /历史对话/);
  assert.match(recovered.nextStep, /重启 Codex/);
  assert.ok(recovered.currentBackup, "current CodexBridge config should be backed up before recovery");
});

test("recoverCodexHistoryAccess does not roll current CodexBridge config back to old backups", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const target = path.join(codexDir, "config.toml");
  fs.writeFileSync(
    target,
    [
      'sandbox_mode = "danger-full-access"',
      "",
      "[history]",
      'persistence = "save-all"',
      "",
      "[desktop]",
      'appearanceTheme = "dark"',
      "",
    ].join("\n"),
    "utf8",
  );

  const applied = applyCodexConfig({ rootDir, mode: MODE_HYBRID, homeDir });
  fs.writeFileSync(target, buildCodexToml({ rootDir, mode: MODE_HYBRID }), "utf8");

  const recovered = recoverCodexHistoryAccess({ homeDir });
  const written = fs.readFileSync(target, "utf8");

  assert.ok(applied.backup);
  assert.equal(recovered.action, "recover_history_access");
  assert.match(written, /model_provider = "openai"/);
  assert.match(written, /openai_base_url = "http:\/\/localhost:15722\/v1"/);
  assert.doesNotMatch(written, /\[model_providers\.codex-bridge]/);
  assert.doesNotMatch(written, /\[history]\s+persistence = "save-all"/);
  assert.doesNotMatch(written, /\[desktop]\s+appearanceTheme = "dark"/);
  assert.doesNotMatch(written, /disable_response_storage = true/);
});

test("syncCodexBridgeConversationProviders moves legacy provider threads into OpenAI", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const dbPath = createCodexStateDb(codexDir, [
    ["thread_a", "codex-bridge", "gpt-5.5", "Bridge A"],
    ["thread_b", "codex-bridge", "gpt-5.4", "Bridge B"],
    ["thread_c", "openai", "gpt-5.5", "OpenAI C"],
  ]);

  const result = syncCodexBridgeConversationProviders({ homeDir });

  assert.equal(result.totalUpdatedThreads, 2);
  assert.equal(result.databases.length, 1);
  assert.equal(result.databases[0].updatedThreads, 2);
  assert.ok(result.databases[0].backup);
  assert.equal(fs.existsSync(result.databases[0].backup), true);
  assert.equal(providerCount(dbPath, "codex-bridge"), 0);
  assert.equal(providerCount(dbPath, "openai"), 3);
});

test("syncCodexBridgeConversationProviders merges missing threads from history backups", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const dbPath = createCodexStateDb(codexDir, [
    ["thread_old_history", "openai", "gpt-5.5", "Old history"],
  ]);
  createCodexStateDb(codexDir, [
    ["thread_new_bridge", "codex-bridge", "gpt-5.4", "New Bridge thread"],
    ["thread_new_child", "codex-bridge", "gpt-5.4", "New child thread"],
  ], `${dbPath}.codexbridge-history.2026-06-22-090000000.bak`, {
    spawnEdges: [["thread_new_bridge", "thread_new_child", "completed"]],
  });

  const result = syncCodexBridgeConversationProviders({ homeDir });

  assert.equal(result.totalImportedThreads, 2);
  assert.equal(result.totalUpdatedThreads, 2);
  assert.equal(threadCount(dbPath), 3);
  assert.equal(threadSpawnEdgeCount(dbPath), 1);
  assert.equal(providerCount(dbPath, "codex-bridge"), 0);
  assert.equal(providerCount(dbPath, "openai"), 3);
  assert.equal(threadTitle(dbPath, "thread_old_history"), "Old history");
  assert.equal(threadTitle(dbPath, "thread_new_bridge"), "New Bridge thread");
});

test("syncCodexBridgeConversationProviders also merges missing threads from restore-era state backups", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const dbPath = createCodexStateDb(codexDir, [
    ["thread_old_history", "openai", "gpt-5.5", "Old history"],
  ]);
  createCodexStateDb(codexDir, [
    ["thread_new_bridge", "codex-bridge", "gpt-5.4", "New Bridge thread"],
  ], `${dbPath}.before-restore.2026-06-22-090000000.bak`);

  const result = syncCodexBridgeConversationProviders({ homeDir });

  assert.equal(result.totalImportedThreads, 1);
  assert.equal(result.totalUpdatedThreads, 1);
  assert.equal(threadCount(dbPath), 2);
  assert.equal(providerCount(dbPath, "codex-bridge"), 0);
  assert.equal(providerCount(dbPath, "openai"), 2);
  assert.equal(threadTitle(dbPath, "thread_new_bridge"), "New Bridge thread");
});

test("syncCodexBridgeConversationProviders normalizes legacy user thread metadata for Codex visibility", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const dbPath = createCodexStateDbWithMetadata(codexDir, [
    {
      id: "thread_bridge_visible",
      modelProvider: "codex-bridge",
      source: "codex-bridge",
      threadSource: null,
      title: "Bridge should be visible",
    },
  ]);

  const result = syncCodexBridgeConversationProviders({ homeDir });
  const metadata = threadMetadata(dbPath, "thread_bridge_visible");

  assert.equal(result.totalUpdatedThreads, 1);
  assert.equal(metadata.model_provider, "openai");
  assert.equal(metadata.source, "vscode");
  assert.equal(metadata.thread_source, "user");
  assert.equal(metadata.archived, 0);
});

test("syncCodexBridgeConversationProviders rewrites legacy thread_source values", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const dbPath = createCodexStateDbWithMetadata(codexDir, [
    {
      id: "thread_bridge_thread_source",
      modelProvider: "codex-bridge",
      source: "codex-bridge",
      threadSource: "codex-bridge",
      title: "Bridge thread source",
    },
  ]);

  const result = syncCodexBridgeConversationProviders({ homeDir });
  const metadata = threadMetadata(dbPath, "thread_bridge_thread_source");

  assert.equal(result.totalUpdatedThreads, 1);
  assert.equal(metadata.model_provider, "openai");
  assert.equal(metadata.source, "vscode");
  assert.equal(metadata.thread_source, "user");
});

test("syncCodexBridgeConversationProviders repairs metadata left behind after provider-only migration", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const dbPath = createCodexStateDbWithMetadata(codexDir, [
    {
      id: "thread_already_openai",
      modelProvider: "openai",
      source: "codex-bridge",
      threadSource: null,
      title: "Provider fixed but still hidden",
    },
  ]);

  const result = syncCodexBridgeConversationProviders({ homeDir });
  const metadata = threadMetadata(dbPath, "thread_already_openai");

  assert.equal(result.totalUpdatedThreads, 0);
  assert.equal(result.totalNormalizedThreads, 1);
  assert.equal(metadata.model_provider, "openai");
  assert.equal(metadata.source, "vscode");
  assert.equal(metadata.thread_source, "user");
});

test("syncCodexBridgeConversationProviders repairs legacy thread_source left after prior migration", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const dbPath = createCodexStateDbWithMetadata(codexDir, [
    {
      id: "thread_prior_migration_thread_source",
      modelProvider: "openai",
      source: "vscode",
      threadSource: "codex-bridge",
      title: "Provider and source fixed but thread source hidden",
    },
  ]);

  const result = syncCodexBridgeConversationProviders({ homeDir });
  const metadata = threadMetadata(dbPath, "thread_prior_migration_thread_source");

  assert.equal(result.totalUpdatedThreads, 0);
  assert.equal(result.totalNormalizedThreads, 1);
  assert.equal(metadata.model_provider, "openai");
  assert.equal(metadata.source, "vscode");
  assert.equal(metadata.thread_source, "user");
});

test("syncCodexBridgeConversationProviders unarchives and marks migrated user threads as having user events", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const dbPath = createCodexStateDbWithMetadata(codexDir, [
    {
      id: "thread_archived_bridge",
      modelProvider: "codex-bridge",
      source: "codex-bridge",
      threadSource: null,
      archived: 1,
      hasUserEvent: 0,
      title: "Archived Bridge thread",
    },
  ]);

  syncCodexBridgeConversationProviders({ homeDir });
  const metadata = threadMetadata(dbPath, "thread_archived_bridge");

  assert.equal(metadata.model_provider, "openai");
  assert.equal(metadata.source, "vscode");
  assert.equal(metadata.thread_source, "user");
  assert.equal(metadata.archived, 0);
  assert.equal(metadata.has_user_event, 1);
});

test("syncCodexBridgeConversationProviders repairs visibility for threads already migrated in a previous version", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const dbPath = createCodexStateDbWithMetadata(codexDir, [
    {
      id: "thread_previously_migrated",
      modelProvider: "openai",
      source: "vscode",
      threadSource: "user",
      archived: 1,
      hasUserEvent: 0,
      title: "Already migrated but hidden",
    },
    {
      id: "thread_real_user_archive",
      modelProvider: "openai",
      source: "vscode",
      threadSource: "user",
      archived: 1,
      hasUserEvent: 1,
      title: "Real user archive",
    },
  ]);
  createCodexStateDbWithMetadata(codexDir, [
    {
      id: "thread_previously_migrated",
      modelProvider: "codex-bridge",
      source: "codex-bridge",
      threadSource: null,
      archived: 1,
      hasUserEvent: 0,
      title: "Already migrated but hidden",
    },
  ], `${dbPath}.codexbridge-history.2026-06-22-100000000.bak`);

  const result = syncCodexBridgeConversationProviders({ homeDir });
  const migrated = threadMetadata(dbPath, "thread_previously_migrated");
  const archived = threadMetadata(dbPath, "thread_real_user_archive");

  assert.equal(result.totalNormalizedThreads, 1);
  assert.equal(migrated.archived, 0);
  assert.equal(migrated.has_user_event, 1);
  assert.equal(archived.archived, 1);
  assert.equal(archived.has_user_event, 1);
});

test("syncCodexBridgeConversationProviders normalizes legacy local model providers", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const dbPath = createCodexStateDbWithMetadata(codexDir, [
    {
      id: "thread_litellm",
      modelProvider: "litellm",
      source: "vscode",
      threadSource: "user",
      title: "LiteLLM thread",
      firstUserMessage: "hello from litellm",
    },
    {
      id: "thread_custom",
      modelProvider: "custom",
      source: "vscode",
      threadSource: "user",
      title: "Custom thread",
      firstUserMessage: "hello from custom",
    },
    {
      id: "thread_router",
      modelProvider: "codex-multi-router",
      source: "vscode",
      threadSource: "user",
      title: "Router thread",
      firstUserMessage: "hello from router",
    },
    {
      id: "thread_deepseek",
      modelProvider: "deepseek",
      source: "vscode",
      threadSource: "user",
      title: "DeepSeek thread",
      firstUserMessage: "hello from deepseek",
    },
  ]);

  const result = syncCodexBridgeConversationProviders({ homeDir });

  assert.equal(result.totalNormalizedThreads, 4);
  assert.equal(providerCount(dbPath, "openai"), 4);
  for (const id of ["thread_litellm", "thread_custom", "thread_router", "thread_deepseek"]) {
    const metadata = threadMetadata(dbPath, id);
    assert.equal(metadata.model_provider, "openai");
    assert.equal(metadata.source, "vscode");
    assert.equal(metadata.thread_source, "user");
    assert.equal(metadata.has_user_event, 1);
  }
});

test("syncCodexBridgeConversationProviders marks existing OpenAI user threads as user events", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const dbPath = createCodexStateDbWithMetadata(codexDir, [
    {
      id: "thread_openai_missing_user_event",
      modelProvider: "openai",
      source: "vscode",
      threadSource: "user",
      title: "Visible title",
      hasUserEvent: 0,
      firstUserMessage: "你好",
    },
    {
      id: "thread_empty_without_message",
      modelProvider: "openai",
      source: "vscode",
      threadSource: "user",
      title: "",
      hasUserEvent: 0,
      firstUserMessage: "",
    },
  ]);

  const result = syncCodexBridgeConversationProviders({ homeDir });
  const repaired = threadMetadata(dbPath, "thread_openai_missing_user_event");
  const empty = threadMetadata(dbPath, "thread_empty_without_message");

  assert.equal(result.totalNormalizedThreads, 1);
  assert.equal(repaired.model_provider, "openai");
  assert.equal(repaired.has_user_event, 1);
  assert.equal(empty.has_user_event, 0);
});

function makeTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-test-"));
}

function toFixtureTomlPath(filePath) {
  return filePath.replaceAll("\\", "/");
}

function createCodexStateDb(codexDir, rows, dbPath = path.join(codexDir, "state_5.sqlite"), options = {}) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT, model TEXT, title TEXT)",
    );
    db.exec(
      "CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT)",
    );
    const insert = db.prepare(
      "INSERT INTO threads (id, model_provider, model, title) VALUES (?, ?, ?, ?)",
    );
    for (const row of rows) {
      insert.run(...row);
    }
    const insertSpawnEdge = db.prepare(
      "INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status) VALUES (?, ?, ?)",
    );
    for (const row of options.spawnEdges || []) {
      insertSpawnEdge.run(...row);
    }
  } finally {
    db.close();
  }
  return dbPath;
}

function createCodexStateDbWithMetadata(codexDir, rows, dbPath = path.join(codexDir, "state_5.sqlite")) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      [
        "CREATE TABLE threads (",
        "id TEXT PRIMARY KEY,",
        "model_provider TEXT,",
        "model TEXT,",
        "title TEXT,",
        "source TEXT,",
        "thread_source TEXT,",
        "archived INTEGER DEFAULT 0,",
        "has_user_event INTEGER DEFAULT 0,",
        "first_user_message TEXT",
        ")",
      ].join(" "),
    );
    db.exec(
      "CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT)",
    );
    const insert = db.prepare(
      "INSERT INTO threads (id, model_provider, model, title, source, thread_source, archived, has_user_event, first_user_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const row of rows) {
      insert.run(
        row.id,
        row.modelProvider,
        row.model || "gpt-5.5",
        row.title,
        row.source,
        row.threadSource,
        row.archived || 0,
        row.hasUserEvent || 0,
        row.firstUserMessage ?? null,
      );
    }
  } finally {
    db.close();
  }
  return dbPath;
}

function threadCount(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT COUNT(*) AS count FROM threads").get().count;
  } finally {
    db.close();
  }
}

function threadTitle(dbPath, id) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT title FROM threads WHERE id = ?").get(id).title;
  } finally {
    db.close();
  }
}

function threadMetadata(dbPath, id) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT model_provider, source, thread_source, archived, has_user_event FROM threads WHERE id = ?")
      .get(id);
  } finally {
    db.close();
  }
}

function threadSpawnEdgeCount(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT COUNT(*) AS count FROM thread_spawn_edges").get().count;
  } finally {
    db.close();
  }
}

function providerCount(dbPath, provider) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT COUNT(*) AS count FROM threads WHERE model_provider = ?")
      .get(provider).count;
  } finally {
    db.close();
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
