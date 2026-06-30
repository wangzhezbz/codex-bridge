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
  buildStartupCheck,
  buildRouterConfigFromSelection,
  buildCodexToml,
  detectModeFromConfig,
  ensureRouterConfig,
  exportCodexSessionMarkdown,
  listCodexBackups,
  listCodexResources,
  listCodexSessions,
  loadConfigProfiles,
  loadDesktopOptions,
  modelCatalog,
  modelDirectoryPath,
  providerCatalog,
  prepareRouterStartConfig,
  readModelCapabilityOverrides,
  readModelDirectory,
  readRouterConfig,
  readCustomModels,
  readProviderOverrides,
  refreshProviderModelDirectory,
  recoverCodexHistoryAccess,
  removeCustomModel,
  resetModelCapabilityOverride,
  restoreCodexConfig,
  restoreCodexConfigFromBackup,
  routerConfigPath,
  routerConfigDiagnostics,
  routerRuntimeEnv,
  readModelImageGenerationOverrides,
  saveModelImageInputOverride,
  saveModelCapabilityOverride,
  saveModelImageGenerationOverride,
  saveCustomModel,
  saveConfigProfile,
  saveDesktopOptions,
  saveProviderLogo,
  saveProviderOverride,
  saveSelection,
  saveSecrets,
  secretValue,
  secretStatus,
  supportDiagnostics,
  testProviderConnection,
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
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const toml = buildCodexToml({
    rootDir,
    mode: MODE_ALL_API,
    port: 15722,
    homeDir,
  });
  const catalogFile = toFixtureTomlPath(path.join(homeDir, ".codex", "codexbridge-model-catalog.json"));

  assert.match(toml, /model_provider = "openai"/);
  assert.match(toml, /openai_base_url = "http:\/\/127\.0\.0\.1:15722\/v1"/);
  assert.doesNotMatch(toml, /experimental_bearer_token/);
  assert.doesNotMatch(toml, /requires_openai_auth/);
  assert.doesNotMatch(toml, /supports_websockets/);
  assert.doesNotMatch(toml, /\[model_providers\.codex-bridge]/);
  assert.match(toml, new RegExp(`model_catalog_json = "${escapeRegExp(catalogFile)}"`));
});

test("buildCodexToml points Codex at an absolute catalog file", () => {
  const rootDir = path.join(os.tmpdir(), "codex-bridge-router");
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const toml = buildCodexToml({
    rootDir,
    mode: MODE_HYBRID,
    port: 15722,
    homeDir,
  });
  const catalogFile = toFixtureTomlPath(path.join(homeDir, ".codex", "codexbridge-model-catalog.json"));

  assert.match(toml, new RegExp(`model_catalog_json = "${escapeRegExp(catalogFile)}"`));
  assert.doesNotMatch(toml, new RegExp(escapeRegExp(path.resolve(rootDir))));
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

test("buildCodexToml defaults to an independent CodexBridge model id", () => {
  const rootDir = path.join(os.tmpdir(), "codex-bridge-router");
  const toml = buildCodexToml({
    rootDir,
    mode: MODE_HYBRID,
  });

  assert.match(toml, /model = "cb-gpt-5-5"/);
  assert.doesNotMatch(toml, /model = "gpt-5\.5"/);
});

test("buildCodexToml keeps the built-in OpenAI provider in hybrid mode", () => {
  const toml = buildCodexToml({
    rootDir: path.join(os.tmpdir(), "codex-bridge-router"),
    mode: MODE_HYBRID,
    port: 15722,
  });

  assert.match(toml, /model_provider = "openai"/);
  assert.match(toml, /openai_base_url = "http:\/\/127\.0\.0\.1:15722\/v1"/);
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

test("desktop options persist router port without clobbering partial updates", () => {
  const rootDir = makeTempProject();

  assert.equal(loadDesktopOptions(rootDir).routerPort, 15722);
  const saved = saveDesktopOptions(rootDir, {
    bypassSystemProxy: true,
    routerPort: 15999,
    codexDesktopExe: " C:\\Tools\\Codex\\Codex.exe ",
    codexDesktopLaunchTarget: " C:\\Users\\User\\Desktop\\Codex.lnk ",
  });

  assert.equal(saved.bypassSystemProxy, true);
  assert.equal(saved.routerPort, 15999);
  assert.equal(saved.codexDesktopExe, "C:\\Tools\\Codex\\Codex.exe");
  assert.equal(saved.codexDesktopLaunchTarget, "C:\\Users\\User\\Desktop\\Codex.lnk");
  const partial = saveDesktopOptions(rootDir, { bypassSystemProxy: false });
  assert.equal(partial.bypassSystemProxy, false);
  assert.equal(partial.routerPort, 15999);
  assert.equal(partial.codexDesktopExe, "C:\\Tools\\Codex\\Codex.exe");
  assert.equal(partial.codexDesktopLaunchTarget, "C:\\Users\\User\\Desktop\\Codex.lnk");
});

test("router config uses the configured desktop router port", () => {
  const rootDir = makeTempProject();
  saveDesktopOptions(rootDir, { routerPort: 15999 });
  const config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.equal(config.port, 15999);
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
      "[10:00:03] req_kimi !! compact-local-fallback route=cb-kimi-k2-7-code reason=Your account org-testfixtures000000000 / proj-testfixtures000000000 <ak-testfixtures000000000> request reached organization TPD rate limit",
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
  assert.doesNotMatch(diagnostics.text, /ak-testfixtures000000000/);
  assert.doesNotMatch(diagnostics.text, /org-testfixtures000000000/);
  assert.doesNotMatch(diagnostics.text, /proj-testfixtures000000000/);
  assert.match(diagnostics.text, /ak-\[REDACTED\]/);
  assert.match(diagnostics.text, /org-\[REDACTED\]/);
  assert.match(diagnostics.text, /proj-\[REDACTED\]/);
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
      requestBodyLimitBytes: 1048576,
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
    logs: [
      "[2026-06-29T10:00:00.000Z] req_tool123 tool_diag route=deepseek-v4-pro mode=chat-compat tools=3 chat_tools=2 suppressed=1 namespaces=2 namespace_names=mcp__figma__,mcp__node_repl__ node_repl=true command=false apply_patch=true tool_choice=auto sk-tool-secret",
      "[2026-06-29T10:00:01.000Z] req_tool456 tool_return_diag route=deepseek-v4-pro mode=chat-compat returned_tools=2 runnable_tools=1 suppressed_tools=1 unknown_tools=1 namespaces=1 namespace_names=mcp__figma__ node_repl=false command=false apply_patch=false sk-return-secret",
    ],
    homeDir,
  });

  assert.match(diagnostics.text, /Router route health/);
  assert.match(diagnostics.text, /deepseek-v4-pro: rate_limited/);
  assert.match(diagnostics.text, /lastErrorType=rate_limit/);
  assert.match(diagnostics.text, /cooldownMs=12000/);
  assert.match(diagnostics.text, /Usage diagnostics/);
  assert.match(diagnostics.text, /totalCalls: 2/);
  assert.match(diagnostics.text, /latest: deepseek-v4-pro status=429 errorType=rate_limit/);
  assert.match(diagnostics.text, /Request limits/);
  assert.match(diagnostics.text, /requestBodyLimitBytes: 1\.0 MB/);
  assert.match(diagnostics.text, /responsesRequestBodyLimitBytes: 1\.0 MB/);
  assert.match(diagnostics.text, /Proxy diagnostics/);
  assert.match(diagnostics.text, /HTTPS_PROXY: set http:\/\/127\.0\.0\.1:7890/);
  assert.match(diagnostics.text, /NO_PROXY: set localhost,127\.0\.0\.1/);
  assert.match(diagnostics.text, /Update diagnostics/);
  assert.match(diagnostics.text, new RegExp(escapeRegExp(updateDir)));
  assert.match(diagnostics.text, /Recent tool diagnostics/);
  assert.match(diagnostics.text, /tool_diag route=deepseek-v4-pro/);
  assert.match(diagnostics.text, /tool_return_diag route=deepseek-v4-pro/);
  assert.match(diagnostics.text, /namespace_names=mcp__figma__,mcp__node_repl__/);
  assert.match(diagnostics.text, /unknown_tools=1/);
  assert.equal(diagnostics.summary.unhealthyRoutes, 1);
  assert.equal(diagnostics.summary.usage.totalCalls, 2);
  assert.equal(diagnostics.summary.proxy.HTTPS_PROXY, "set");
  assert.doesNotMatch(diagnostics.text, /user:pass/);
  assert.doesNotMatch(diagnostics.text, /sk-sensitive-token/);
  assert.doesNotMatch(diagnostics.text, /sk-usage-secret/);
  assert.doesNotMatch(diagnostics.text, /sk-tool-secret/);
  assert.doesNotMatch(diagnostics.text, /sk-return-secret/);
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

test("startup check summarizes Codex, router, catalog, keys, proxy, and backups", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, "config.toml"), 'model = "gpt-5.5"\n', "utf8");
  fs.writeFileSync(path.join(codexDir, "config.toml.codexbridge.2026-07-01-010101000.bak"), 'model = "old"\n', "utf8");
  saveSecrets(rootDir, { DEEPSEEK_API_KEY: "deepseek-key" });
  saveDesktopOptions(rootDir, { routerPort: 15999, codexDesktopExe: "C:\\Tools\\Codex\\Codex.exe" });

  const check = buildStartupCheck(rootDir, {
    homeDir,
    appVersion: "0.1.200",
    routerRunning: false,
    lastHealth: null,
    config: {
      port: 15999,
      models: [
        {
          id: "deepseek",
          displayName: "DeepSeek",
          api: "chat_completions",
          baseUrl: "https://api.deepseek.com/v1",
          model: "deepseek-v4",
          authMode: "api_key",
          apiKeyEnv: "DEEPSEEK_API_KEY",
        },
      ],
    },
    proxyEnv: { HTTPS_PROXY: "http://127.0.0.1:7890" },
    platform: "win32",
  });

  assert.equal(check.summary.ok, false);
  assert.equal(check.summary.pass, 5);
  assert.equal(check.summary.warn, 1);
  assert.equal(check.summary.fail, 1);
  assert.equal(check.items.find((item) => item.id === "codex_config").status, "pass");
  assert.equal(check.items.find((item) => item.id === "router").status, "warn");
  assert.equal(check.items.find((item) => item.id === "api_keys").status, "pass");
  assert.equal(check.items.find((item) => item.id === "codex_desktop").status, "fail");
  assert.match(check.items.find((item) => item.id === "proxy").detail, /HTTPS_PROXY/);
  assert.equal(check.items.find((item) => item.id === "backups").count, 1);
  assert.equal(check.items.find((item) => item.id === "codex_config").label, "Codex 配置");
  assert.equal(check.items.find((item) => item.id === "model_catalog").label, "模型目录");
  assert.equal(check.items.find((item) => item.id === "api_keys").label, "API Key");
  assert.doesNotMatch(JSON.stringify(check.items), /Model catalog|Start Router|No proxy environment/i);
});

test("config profiles save and load model selections and desktop options", () => {
  const rootDir = makeTempProject();
  saveSelection(rootDir, ["gpt-5.5", "deepseek-v4-pro"], MODE_HYBRID);
  saveDesktopOptions(rootDir, { routerPort: 15988, bypassSystemProxy: true });

  const saved = saveConfigProfile(rootDir, {
    name: "Domestic API",
    mode: MODE_HYBRID,
    selectedModelIds: ["deepseek-v4-pro"],
    desktopOptions: { routerPort: 15988, bypassSystemProxy: true },
  });
  const profiles = loadConfigProfiles(rootDir);

  assert.equal(saved.id, "domestic-api");
  assert.equal(profiles.length, 1);
  assert.deepEqual(profiles[0].selectedModelIds, ["deepseek-v4-pro"]);
  assert.equal(profiles[0].desktopOptions.routerPort, 15988);
  assert.equal(profiles[0].desktopOptions.bypassSystemProxy, true);

  const renamed = saveConfigProfile(rootDir, {
    ...profiles[0],
    name: "国内模型常用配置",
  });
  assert.equal(renamed.id, "domestic-api");
  assert.equal(loadConfigProfiles(rootDir)[0].name, "国内模型常用配置");
});

test("backup center lists and restores a selected Codex config backup", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const target = path.join(codexDir, "config.toml");
  const backup = path.join(codexDir, "config.toml.codexbridge.2026-07-01-010101000.bak");
  fs.writeFileSync(target, 'model = "current"\n', "utf8");
  fs.writeFileSync(backup, 'model = "backup"\n', "utf8");

  const backups = listCodexBackups({ homeDir });
  assert.equal(backups.length, 1);
  assert.equal(backups[0].fullPath, backup);
  assert.equal(backups[0].kind, "codexbridge");

  const restored = restoreCodexConfigFromBackup(backup, { homeDir });
  assert.equal(restored.backup, backup);
  assert.ok(restored.currentBackup);
  assert.equal(fs.readFileSync(target, "utf8"), 'model = "backup"\n');
});

test("resource center lists MCP, plugins, skills, prompts, and AGENTS files", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  fs.mkdirSync(path.join(homeDir, ".codex", "skills", "demo"), { recursive: true });
  fs.mkdirSync(path.join(homeDir, ".agents", "skills", "agent-demo"), { recursive: true });
  fs.mkdirSync(
    path.join(homeDir, ".codex", "plugins", "cache", "openai-curated-remote", "github", "0.1.5", "skills", "gh-fix-ci"),
    { recursive: true },
  );
  fs.mkdirSync(
    path.join(homeDir, ".codex", "plugins", "cache", "personal", "cowart", "0.1.3", "skills", "cowart-open-canvas"),
    { recursive: true },
  );
  fs.mkdirSync(path.join(homeDir, ".codex", "prompts"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, ".codex", "prompts"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".codex", "skills", "demo", "SKILL.md"), "# Demo\n", "utf8");
  fs.writeFileSync(path.join(homeDir, ".agents", "skills", "agent-demo", "SKILL.md"), "# Agent Demo\n", "utf8");
  fs.writeFileSync(
    path.join(homeDir, ".codex", "plugins", "cache", "openai-curated-remote", "github", "0.1.5", ".codex-plugin.json"),
    JSON.stringify({ name: "github", displayName: "GitHub", version: "0.1.5" }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(homeDir, ".codex", "plugins", "cache", "openai-curated-remote", "github", "0.1.5", "skills", "gh-fix-ci", "SKILL.md"),
    "# GH Fix CI\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(homeDir, ".codex", "plugins", "cache", "personal", "cowart", "0.1.3", ".codex-plugin.json"),
    JSON.stringify({ name: "cowart", version: "0.1.3" }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(homeDir, ".codex", "plugins", "cache", "personal", "cowart", "0.1.3", "skills", "cowart-open-canvas", "SKILL.md"),
    "# Cowart Open Canvas\n",
    "utf8",
  );
  fs.writeFileSync(path.join(homeDir, ".codex", "prompts", "ship.md"), "Ship it\n", "utf8");
  fs.writeFileSync(path.join(rootDir, ".codex", "prompts", "project.md"), "Project prompt\n", "utf8");
  fs.writeFileSync(
    path.join(homeDir, ".codex", "config.toml"),
    [
      '[mcp_servers.node_repl]',
      'command = "C:/Codex/node_repl.exe"',
      "",
      '[mcp_servers.node_repl.env]',
      'NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS = "1000"',
      "",
      '[mcp_servers.disabled_server]',
      'command = "C:/Codex/disabled.exe"',
      "enabled = false",
      "",
      '[plugins."browser@openai-bundled"]',
      "enabled = true",
      "",
      '[plugins."disabled@personal"]',
      "enabled = false",
      "",
      '[plugins."browser@openai-bundled".mcp_servers.browser]',
      "enabled = true",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(path.join(rootDir, "AGENTS.md"), "agent rules\n", "utf8");

  const resources = listCodexResources({ rootDir, homeDir });

  assert.equal(resources.summary.mcpServers, 1);
  assert.equal(resources.summary.plugins, 1);
  assert.equal(resources.summary.skills, 1);
  assert.equal(resources.summary.prompts, 2);
  assert.equal(resources.summary.agentFiles, 1);
  assert.equal(resources.mcpServers[0].name, "node_repl");
  assert.equal(resources.mcpServers.some((item) => item.name === "node_repl.env"), false);
  assert.equal(resources.mcpServers.some((item) => item.name === "disabled_server"), false);
  assert.equal(resources.plugins[0].id, "github@openai-curated-remote");
  assert.equal(resources.plugins[0].name, "GitHub");
  assert.equal(resources.plugins.some((item) => item.id === "browser@openai-bundled"), false);
  assert.equal(resources.plugins.some((item) => item.id === "cowart@personal"), false);
  assert.equal(resources.discovered.plugins.some((item) => item.id === "browser@openai-bundled" && item.availability === "internal"), true);
  assert.equal(resources.discovered.plugins.some((item) => item.id === "cowart@personal" && item.availability === "cached"), true);
  assert.equal(resources.discovered.plugins.some((item) => item.id === "disabled@personal" && item.availability === "disabled"), true);
  assert.equal(resources.skills[0].name, "demo");
  assert.equal(resources.skills.some((item) => item.name === "agent-demo" && item.source === "agents"), false);
  assert.equal(resources.skills.some((item) => item.name === "gh-fix-ci" && item.source === "plugin"), false);
  assert.ok(resources.discovered.skills.some((item) => item.name === "agent-demo" && item.availability === "local"));
  assert.ok(resources.discovered.skills.some((item) => item.name === "gh-fix-ci" && item.availability === "plugin"));
  assert.ok(resources.discovered.skills.some((item) => item.name === "cowart-open-canvas" && item.availability === "cached"));
  assert.equal(resources.prompts[0].name, "ship.md");
});

test("session center lists Codex sessions and exports a markdown handoff", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const dbPath = createCodexStateDbWithMetadata(codexDir, [
    {
      id: "thread_alpha",
      modelProvider: "openai",
      model: "gpt-5.5",
      title: "Alpha Session",
      source: "vscode",
      threadSource: "user",
      archived: 0,
      hasUserEvent: 1,
      firstUserMessage: "hello alpha",
    },
  ]);

  const sessions = listCodexSessions({ homeDir });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "thread_alpha");
  assert.equal(sessions[0].title, "Alpha Session");
  assert.equal(sessions[0].modelProvider, "openai");

  const exported = exportCodexSessionMarkdown("thread_alpha", { homeDir });
  assert.match(exported.markdown, /# Alpha Session/);
  assert.match(exported.markdown, /thread_alpha/);
  assert.match(exported.markdown, /hello alpha/);
  assert.equal(exported.databasePath, dbPath);
});

test("session center surfaces project/workspace information", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({ "electron-saved-workspace-roots": ["F:/game_code/router"] }),
    "utf8",
  );
  const dbPath = path.join(codexDir, "state_5.sqlite");
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
        "project TEXT,",
        "cwd TEXT,",
        "first_user_message TEXT",
        ")",
      ].join(" "),
    );
    db.prepare(
      "INSERT INTO threads (id, model_provider, model, title, source, thread_source, project, cwd, first_user_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "thread_project",
      "openai",
      "gpt-5.5",
      "Project Session",
      "desktop",
      "user",
      "router",
      "F:/game_code/router",
      "fix project session",
    );
  } finally {
    db.close();
  }

  const sessions = listCodexSessions({ homeDir });
  assert.equal(sessions[0].project, "router");
  assert.equal(sessions[0].projectPath, "F:/game_code/router");
  assert.equal(sessions[0].workspacePath, "F:/game_code/router");

  const exported = exportCodexSessionMarkdown("thread_project", { homeDir });
  assert.match(exported.markdown, /Project: router/);
  assert.match(exported.markdown, /Project path: F:\/game_code\/router/);
  assert.match(exported.markdown, /Workspace path: F:\/game_code\/router/);
});

test("session center uses Codex workspace roots instead of treating every cwd as a project", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({
      "electron-saved-workspace-roots": ["C:/Users/Administrator/Documents/aaa"],
      "projectless-thread-ids": ["thread_projectless_inside_root"],
    }),
    "utf8",
  );
  createCodexStateDbWithMetadata(codexDir, [
    {
      id: "thread_project",
      modelProvider: "openai",
      title: "Project Session",
      source: "vscode",
      threadSource: "user",
      cwd: "C:/Users/Administrator/Documents/aaa",
      firstUserMessage: "inside project",
      recencyAtMs: 30,
    },
    {
      id: "thread_projectless_inside_root",
      modelProvider: "openai",
      title: "Projectless Inside Root",
      source: "vscode",
      threadSource: "user",
      cwd: "C:/Users/Administrator/Documents/aaa",
      firstUserMessage: "ordinary chat opened from aaa",
      recencyAtMs: 20,
    },
    {
      id: "thread_projectless_codex_folder",
      modelProvider: "openai",
      title: "Projectless Codex Folder",
      source: "vscode",
      threadSource: "user",
      cwd: "C:/Users/Administrator/Documents/Codex/2026-07/new-chat-1",
      firstUserMessage: "ordinary chat",
      recencyAtMs: 10,
    },
  ]);

  const sessions = listCodexSessions({ homeDir, limit: 50 });

  assert.deepEqual(sessions.map((item) => item.id), [
    "thread_project",
    "thread_projectless_inside_root",
    "thread_projectless_codex_folder",
  ]);
  assert.equal(sessions[0].project, "aaa");
  assert.equal(sessions[0].projectPath, "C:/Users/Administrator/Documents/aaa");
  assert.equal(sessions[1].project, "");
  assert.equal(sessions[1].projectPath, "");
  assert.equal(sessions[1].workspacePath, "C:/Users/Administrator/Documents/aaa");
  assert.equal(sessions[2].project, "");
  assert.equal(sessions[2].projectPath, "");
  assert.equal(sessions[2].workspacePath, "C:/Users/Administrator/Documents/Codex/2026-07/new-chat-1");
});

test("session center prefers Codex local thread catalog over stale history rows", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({ "electron-saved-workspace-roots": ["F:/game_code/router"] }),
    "utf8",
  );
  createCodexThreadCatalogDb(codexDir, [
    {
      id: "thread_catalog",
      title: "Catalog Session",
      cwd: "F:/game_code/router",
      sourceKind: "vscode",
      modelProvider: "openai",
      updatedAt: 200,
    },
  ]);
  createCodexStateDbWithMetadata(codexDir, [
    {
      id: "thread_stale_state_only",
      modelProvider: "openai",
      title: "Stale State Only",
      source: "vscode",
      threadSource: "user",
      cwd: "F:/game_code/router",
      firstUserMessage: "not in sidebar catalog",
      recencyAtMs: 300,
    },
  ]);

  const sessions = listCodexSessions({ homeDir, limit: 50 });

  assert.deepEqual(sessions.map((item) => item.id), ["thread_catalog"]);
  assert.equal(sessions[0].project, "router");
  assert.equal(sessions[0].projectPath, "F:/game_code/router");
});

test("session center counts only user-facing Codex threads once", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  createCodexStateDbWithMetadata(
    codexDir,
    [
      {
        id: "thread_z_old",
        modelProvider: "openai",
        model: "gpt-5.5",
        title: "Old Visible",
        source: "vscode",
        threadSource: "user",
        cwd: "\\\\?\\F:\\game_code\\router",
        archived: 0,
        hasUserEvent: 0,
        firstUserMessage: "old visible",
        recencyAtMs: 10,
      },
      {
        id: "thread_a_new",
        modelProvider: "openai",
        model: "gpt-5.5",
        title: "New Visible",
        source: "vscode",
        threadSource: "user",
        cwd: "F:/game_code/router",
        archived: 0,
        hasUserEvent: 0,
        firstUserMessage: "new visible",
        recencyAtMs: 30,
      },
      {
        id: "thread_legacy_visible",
        modelProvider: "openai",
        model: "gpt-5.5",
        title: "Legacy Visible",
        source: "vscode",
        threadSource: null,
        cwd: "F:/game_code/legacy",
        archived: 0,
        hasUserEvent: 0,
        firstUserMessage: "legacy visible",
        recencyAtMs: 20,
      },
      {
        id: "thread_archived",
        modelProvider: "openai",
        model: "gpt-5.5",
        title: "Archived",
        source: "vscode",
        threadSource: "user",
        cwd: "F:/game_code/router",
        archived: 1,
        hasUserEvent: 0,
        firstUserMessage: "archived",
        recencyAtMs: 40,
      },
      {
        id: "thread_subagent",
        modelProvider: "openai",
        model: "gpt-5.5",
        title: "Subagent",
        source: "{\"subagent\":{\"thread_spawn\":{}}}",
        threadSource: "subagent",
        cwd: "F:/game_code/router",
        archived: 0,
        hasUserEvent: 0,
        firstUserMessage: "subagent",
        recencyAtMs: 50,
      },
    ],
    path.join(codexDir, "state_5.sqlite"),
  );
  createCodexStateDbWithMetadata(
    codexDir,
    [
      {
        id: "thread_a_new",
        modelProvider: "openai",
        model: "gpt-5.5",
        title: "New Visible Duplicate",
        source: "vscode",
        threadSource: "user",
        cwd: "F:/game_code/router",
        archived: 0,
        hasUserEvent: 0,
        firstUserMessage: "duplicate",
        recencyAtMs: 35,
      },
    ],
    path.join(codexDir, "state_6.sqlite"),
  );

  const sessions = listCodexSessions({ homeDir, limit: 50 });

  assert.deepEqual(
    sessions.map((item) => item.id),
    ["thread_a_new", "thread_legacy_visible", "thread_z_old"],
  );
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

test("buildRouterConfigFromSelection exposes selected models with independent CodexBridge ids", () => {
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
  assert.equal(config.models.length, 6);
  assert.deepEqual(config.models.map((model) => model.id), [
    "cb-gpt-5-5",
    "cb-gpt-5-4",
    "cb-deepseek-v4-pro",
    "cb-deepseek-v4-flash",
    "cb-kimi-k2-7-code",
    "cb-qwen-plus",
  ]);
  assert.equal(config.defaultModel, "cb-gpt-5-5");
  assert.equal(config.models[2].displayName, "DeepSeek V4 Pro");
  assert.equal(config.models[4].displayName, "Kimi K2.7 Code");
  assert.equal(config.models[5].displayName, "Qwen Plus");
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
  assert.equal(config.models[0].id, "cb-gpt-5-5");
  assert.equal(config.models[1].id, "cb-gpt-5-4");
  assert.equal(config.models[0].model, "gpt-5.5");
  assert.equal(config.models[1].model, "gpt-5.4");
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

test("built-in Kimi routes do not impose local rpm throttling by default", () => {
  const rootDir = makeTempProject();
  saveSelection(rootDir, ["kimi-k2-7-code", "kimi-k2-6"], MODE_HYBRID);

  const config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  const kimiRoutes = config.models.filter((model) => model.provider === "kimi");
  assert.equal(kimiRoutes.length, 2);
  for (const route of kimiRoutes) {
    assert.equal(route.rpm, undefined, route.id);
    assert.equal(route.rateLimit, undefined, route.id);
  }
});

test("synced Kimi routes do not inherit legacy built-in rpm throttling", () => {
  const rootDir = makeTempProject();
  fs.mkdirSync(path.join(rootDir, "config"), { recursive: true });
  fs.writeFileSync(
    modelDirectoryPath(rootDir),
    JSON.stringify({
      version: 1,
      providers: {
        kimi: {
          providerId: "kimi",
          models: [{ id: "kimi-k2.8-code" }],
        },
      },
    }),
  );
  const synced = modelCatalog(rootDir).find((model) => model.model === "kimi-k2.8-code");
  assert.ok(synced?.presetId);
  saveSelection(rootDir, [synced.presetId], MODE_HYBRID);

  const config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.equal(config.models.length, 1);
  assert.equal(config.models[0].provider, "kimi");
  assert.equal(config.models[0].model, "kimi-k2.8-code");
  assert.equal(config.models[0].rpm, undefined);
  assert.equal(config.models[0].rateLimit, undefined);
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

test("all-api Codex-visible model catalog keeps provider display names", () => {
  const rootDir = makeTempProject();
  writeRouterConfigFromSelection(rootDir, MODE_ALL_API);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));

  applyCodexConfig({ rootDir, mode: MODE_ALL_API, homeDir });

  const target = path.join(homeDir, ".codex", "config.toml");
  const written = fs.readFileSync(target, "utf8");
  const catalogFile = path.join(homeDir, ".codex", "codexbridge-model-catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  const names = new Map(catalog.models.map((model) => [model.slug, model.display_name]));

  assert.match(written, new RegExp(`model_catalog_json = "${escapeRegExp(toFixtureTomlPath(catalogFile))}"`));
  assert.equal(names.get("cb-openai-gpt-4-1"), "OpenAI GPT-4.1");
  assert.equal(names.get("cb-deepseek-v4-pro"), "DeepSeek V4 Pro");
  assert.equal(names.get("cb-kimi-k2-7-code"), "Kimi K2.7 Code");
  assert.equal(catalog.models.some((model) => model.display_name === "自定义"), false);
});

test("Codex-visible model catalog keeps tool and MCP capability metadata in both modes", () => {
  const assertCatalogCapabilities = (mode, expectedFirstToolMode) => {
    const rootDir = makeTempProject();
    writeRouterConfigFromSelection(rootDir, mode);
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));

    applyCodexConfig({ rootDir, mode, homeDir });

    const catalogFile = path.join(homeDir, ".codex", "codexbridge-model-catalog.json");
    const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
    const first = catalog.models[0];
    const deepseek = catalog.models.find((model) => model.slug === "cb-deepseek-v4-pro");

    assert.equal(first.supports_tools, expectedFirstToolMode);
    assert.equal(first.supports_mcp_namespaces, true);
    assert.equal(first.codexbridge_capabilities.mcp_namespaces, "native");
    assert.equal(deepseek.supports_tools, "chat-functions");
    assert.equal(deepseek.supports_mcp_namespaces, true);
    assert.equal(deepseek.codexbridge_capabilities.mcp_namespaces, "native");
  };

  assertCatalogCapabilities(MODE_HYBRID, "native");
  assertCatalogCapabilities(MODE_ALL_API, "native");
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
  assert.equal(config.models[0].id, "cb-custom-my-provider-my-coder-v1");
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

test("provider model directory refresh requires a saved API key", async () => {
  const rootDir = makeTempProject();
  let fetched = false;

  const result = await refreshProviderModelDirectory(rootDir, "deepseek", {
    now: () => "2026-06-26T01:02:03.000Z",
    fetchImpl: async () => {
      fetched = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      };
    },
  });

  const directory = readModelDirectory(rootDir);

  assert.equal(result.ok, false);
  assert.match(result.error, /Missing API key: DEEPSEEK_API_KEY/);
  assert.equal(fetched, false);
  assert.equal(directory.providers.deepseek, undefined);
});

test("provider model directory refresh sends the saved API key", async () => {
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
  assert.equal(JSON.stringify(directory).includes("DEEPSEEK_API_KEY"), false);
});

test("provider model directory refresh replaces built-in provider models with the remote list", async () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, { DEEPSEEK_API_KEY: "deepseek-secret" });
  saveSelection(rootDir, ["codex-gpt-5-5", "deepseek-v4-pro"], MODE_HYBRID);
  const before = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  await refreshProviderModelDirectory(rootDir, "deepseek", {
    now: () => "2026-06-26T01:02:03.000Z",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: "deepseek-v4-pro" },
          { id: "deepseek-coder-next" },
        ],
      }),
    }),
  });

  const catalog = modelCatalog(rootDir);
  const synced = catalog.find((model) => model.model === "deepseek-coder-next");
  const deepseekModels = catalog
    .filter((model) => model.providerId === "deepseek")
    .map((model) => model.model);
  const after = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.deepEqual(deepseekModels, [
    "deepseek-v4-pro",
    "deepseek-coder-next",
  ]);
  assert.ok(synced);
  assert.equal(synced.providerId, "deepseek");
  assert.equal(synced.api, "chat_completions");
  assert.equal(synced.authMode, "api_key");
  assert.equal(synced.apiKeyEnv, "DEEPSEEK_API_KEY");
  assert.equal(synced.custom, false);
  assert.deepEqual(after, before);
});

test("provider overrides update provider catalog and generated routes", () => {
  const rootDir = makeTempProject();
  const saved = saveProviderOverride(rootDir, "deepseek", {
    name: "DeepSeek Proxy",
    shortName: "DS Proxy",
    baseUrl: "https://proxy.example.com/v1",
    api: "responses",
    keyUrl: "https://proxy.example.com/key",
    docsUrl: "https://proxy.example.com/docs",
  });
  saveSelection(rootDir, ["deepseek-v4-pro"], MODE_HYBRID);

  const provider = providerCatalog(rootDir).find((item) => item.id === "deepseek");
  const model = modelCatalog(rootDir).find((item) => item.presetId === "deepseek-v4-pro");
  const config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.equal(saved.baseUrl, "https://proxy.example.com/v1");
  assert.equal(readProviderOverrides(rootDir).deepseek.name, "DeepSeek Proxy");
  assert.equal(provider.name, "DeepSeek Proxy");
  assert.equal(provider.shortName, "DS Proxy");
  assert.equal(provider.baseUrl, "https://proxy.example.com/v1");
  assert.equal(provider.api, "responses");
  assert.equal(model.baseUrl, "https://proxy.example.com/v1");
  assert.equal(model.api, "responses");
  assert.equal(config.models[0].baseUrl, "https://proxy.example.com/v1");
  assert.equal(config.models[0].api, "responses");
});

test("provider logos are copied into the local data directory", () => {
  const rootDir = makeTempProject();
  const source = path.join(rootDir, "source-logo.png");
  fs.writeFileSync(source, "fake-png-bytes", "utf8");

  const saved = saveProviderLogo(rootDir, "deepseek", source);

  assert.match(saved.logoUrl, /^file:\/\/\//);
  assert.equal(path.basename(saved.path), "deepseek.png");
  assert.equal(fs.readFileSync(saved.path, "utf8"), "fake-png-bytes");
  assert.match(saved.path, /provider-logos/);
});

test("provider connection test requires an API key before fetching", async () => {
  const rootDir = makeTempProject();
  let fetched = false;
  const result = await testProviderConnection(rootDir, "deepseek", {
    fetchImpl: async () => {
      fetched = true;
      return {
        ok: true,
        status: 200,
        text: async () => "",
      };
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /Missing API key: DEEPSEEK_API_KEY/);
  assert.equal(fetched, false);
});

test("provider connection test can use a typed unsaved API key", async () => {
  const rootDir = makeTempProject();
  const result = await testProviderConnection(rootDir, {
    providerId: "deepseek",
    apiKey: "typed-secret",
  }, {
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.deepseek.com/v1/models");
      assert.equal(options.method, "GET");
      assert.equal(options.headers.Authorization, "Bearer typed-secret");
      return {
        ok: true,
        status: 200,
        text: async () => "",
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.providerId, "deepseek");
  assert.equal(result.status, 200);
});

test("synced provider models can be selected and routed explicitly", async () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, { DEEPSEEK_API_KEY: "deepseek-secret" });

  await refreshProviderModelDirectory(rootDir, "deepseek", {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ id: "deepseek-coder-next" }],
      }),
    }),
  });

  const synced = modelCatalog(rootDir).find((model) => model.model === "deepseek-coder-next");
  saveSelection(rootDir, [synced.presetId], MODE_HYBRID);
  const config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.equal(config.models.length, 1);
  assert.equal(config.models[0].sourcePresetId, synced.presetId);
  assert.equal(config.models[0].model, "deepseek-coder-next");
  assert.equal(config.models[0].provider, "deepseek");
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

test("manual capability overrides can be reset without changing image upload overrides", () => {
  const rootDir = makeTempProject();
  saveModelCapabilityOverride(rootDir, "deepseek-v4-pro", {
    inputModalities: ["text", "file", "audio"],
    contextWindow: 123456,
    reasoning: { mode: "unsupported" },
  });
  saveModelImageInputOverride(rootDir, "deepseek-v4-pro", true);

  const reset = resetModelCapabilityOverride(rootDir, "deepseek-v4-pro");
  const overrides = readModelCapabilityOverrides(rootDir);
  const model = modelCatalog(rootDir).find((item) => item.presetId === "deepseek-v4-pro");

  assert.equal(reset.presetId, "deepseek-v4-pro");
  assert.equal(reset.reset, true);
  assert.equal(overrides["deepseek-v4-pro"], undefined);
  assert.notEqual(model.capabilityOverrideSource, "manual");
  assert.deepEqual(model.inputModalities, ["text", "image"]);
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

test("custom models can extend an existing provider without creating a duplicate provider", () => {
  const rootDir = makeTempProject();
  const custom = saveCustomModel(rootDir, {
    providerId: "deepseek",
    providerName: "DeepSeek",
    displayName: "DeepSeek Custom",
    model: "deepseek-custom",
    baseUrl: "https://api.deepseek.com/v1",
    api: "responses",
    keyEnv: "DEEPSEEK_API_KEY",
    contextWindow: 123456,
    inputModalities: ["text", "image"],
  });
  const providers = providerCatalog(rootDir).filter((provider) => provider.id === "deepseek");
  const model = modelCatalog(rootDir).find((item) => item.presetId === custom.presetId);

  assert.equal(custom.providerId, "deepseek");
  assert.equal(providers.length, 1);
  assert.equal(model.providerId, "deepseek");
  assert.equal(model.baseUrl, "https://api.deepseek.com/v1");
  assert.equal(model.api, "responses");
  assert.equal(model.apiKeyEnv, "DEEPSEEK_API_KEY");
  assert.equal(model.contextWindow, 123456);
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
  assert.match(written, /openai_base_url = "http:\/\/127\.0\.0\.1:15722\/v1"/);
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
  assert.match(written, /openai_base_url = "http:\/\/127\.0\.0\.1:15722\/v1"/);
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

test("applyCodexConfig preserves the current independent CodexBridge model selection", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const target = path.join(codexDir, "config.toml");
  fs.writeFileSync(
    target,
    [
      'model_provider = "openai"',
      'model = "cb-gpt-5-4"',
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
  assert.match(written, /model = "cb-gpt-5-4"/);
  assert.match(written, /model_reasoning_effort = "high"/);
  assert.match(written, /openai_base_url = "http:\/\/127\.0\.0\.1:15722\/v1"/);
  assert.match(written, /\[history]\s+persistence = "save-all"/);
});

test("applyCodexConfig writes a Codex-visible model catalog next to config.toml", () => {
  const rootDir = makeTempProject();
  writeRouterConfigFromSelection(rootDir, MODE_HYBRID);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));

  applyCodexConfig({ rootDir, mode: MODE_HYBRID, homeDir });

  const target = path.join(homeDir, ".codex", "config.toml");
  const written = fs.readFileSync(target, "utf8");
  const catalogFile = path.join(homeDir, ".codex", "codexbridge-model-catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));

  assert.match(written, new RegExp(`model_catalog_json = "${escapeRegExp(toFixtureTomlPath(catalogFile))}"`));
  assert.doesNotMatch(written, new RegExp(escapeRegExp(path.resolve(rootDir))));
  assert.equal(catalog.models[0].slug, "cb-gpt-5-5");
  assert.equal(catalog.models[0].display_name, "GPT-5.5");
});

test("applyCodexConfig skips backup when Codex config is already current", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const target = path.join(codexDir, "config.toml");
  fs.writeFileSync(target, buildCodexToml({ rootDir, mode: MODE_HYBRID, homeDir }), "utf8");

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
  fs.writeFileSync(target, buildCodexToml({ rootDir, mode: MODE_HYBRID, homeDir }), "utf8");
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
  assert.equal(result.config.defaultModel, "cb-gpt-5-5");
  assert.match(written, /model_provider = "openai"/);
  assert.match(written, /openai_base_url = "http:\/\/127\.0\.0\.1:15722\/v1"/);
  assert.doesNotMatch(written, /\[model_providers\.codex-bridge]/);
});

test("restoreCodexConfig restores the latest CodexBridge backup", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const target = path.join(codexDir, "config.toml");
  fs.writeFileSync(target, buildCodexToml({ rootDir, mode: MODE_HYBRID, homeDir }), "utf8");
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
  fs.writeFileSync(target, buildCodexToml({ rootDir, mode: MODE_HYBRID, homeDir }), "utf8");
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
  const bridgeConfig = buildCodexToml({ rootDir, mode: MODE_HYBRID, homeDir });
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
      buildCodexToml({ rootDir, mode: MODE_HYBRID, homeDir }).trimEnd(),
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
  assert.doesNotMatch(written, /openai_base_url = "http:\/\/127\.0\.0\.1:15722\/v1"/);
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
  assert.match(written, /openai_base_url = "http:\/\/127\.0\.0\.1:15722\/v1"/);
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
  fs.writeFileSync(target, buildCodexToml({ rootDir, mode: MODE_HYBRID, homeDir }), "utf8");

  const recovered = recoverCodexHistoryAccess({ homeDir });
  const written = fs.readFileSync(target, "utf8");

  assert.ok(applied.backup);
  assert.equal(recovered.action, "recover_history_access");
  assert.match(written, /model_provider = "openai"/);
  assert.match(written, /openai_base_url = "http:\/\/127\.0\.0\.1:15722\/v1"/);
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
        "cwd TEXT,",
        "archived INTEGER DEFAULT 0,",
        "has_user_event INTEGER DEFAULT 0,",
        "first_user_message TEXT,",
        "recency_at_ms INTEGER DEFAULT 0",
        ")",
      ].join(" "),
    );
    db.exec(
      "CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT)",
    );
    const insert = db.prepare(
      "INSERT INTO threads (id, model_provider, model, title, source, thread_source, cwd, archived, has_user_event, first_user_message, recency_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const row of rows) {
      insert.run(
        row.id,
        row.modelProvider,
        row.model || "gpt-5.5",
        row.title,
        row.source,
        row.threadSource ?? null,
        row.cwd ?? "",
        row.archived || 0,
        row.hasUserEvent || 0,
        row.firstUserMessage ?? null,
        row.recencyAtMs || 0,
      );
    }
  } finally {
    db.close();
  }
  return dbPath;
}

function createCodexThreadCatalogDb(codexDir, rows, dbPath = path.join(codexDir, "sqlite", "codex-dev.db")) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      [
        "CREATE TABLE local_thread_catalog (",
        "host_id TEXT,",
        "thread_id TEXT PRIMARY KEY,",
        "display_title TEXT,",
        "source_created_at INTEGER,",
        "source_updated_at INTEGER,",
        "cwd TEXT,",
        "source_kind TEXT,",
        "source_detail TEXT,",
        "model_provider TEXT,",
        "git_branch TEXT,",
        "observation_sequence INTEGER,",
        "missing_candidate INTEGER DEFAULT 0",
        ")",
      ].join(" "),
    );
    const insert = db.prepare(
      "INSERT INTO local_thread_catalog (host_id, thread_id, display_title, source_created_at, source_updated_at, cwd, source_kind, source_detail, model_provider, git_branch, observation_sequence, missing_candidate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const row of rows) {
      insert.run(
        row.hostId || "local",
        row.id,
        row.title,
        row.createdAt || row.updatedAt || 0,
        row.updatedAt || 0,
        row.cwd || "",
        row.sourceKind || "vscode",
        row.sourceDetail ?? null,
        row.modelProvider || "",
        row.gitBranch || "",
        row.observationSequence || 0,
        row.missingCandidate || 0,
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
