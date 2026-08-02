import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createConfigWriteCoordinator } from "../desktop/config-write-coordinator.mjs";
import { hiddenPluginNamesFromDesktopSelectorSource } from "../desktop/codex-desktop-plugin-page-policy.mjs";
import { normalizeAdapterProfile } from "../src/adapter-profile.js";
import {
  MODE_ALL_API,
  MODE_HYBRID,
  MODEL_PRESETS,
  applyCodexConfig,
  buildProviderLogoCandidate,
  buildRouteSyncPlan,
  buildStartupCheck as buildStartupCheckProduction,
  buildRouterConfigFromSelection,
  buildCodexToml,
  buildRealAcceptanceReport,
  buildReleaseGateReport,
  capabilityProviderRegistry,
  configProfilesPath,
  configPackageSyncDirectory,
  configPackageSyncStatusPath,
  configPackageCodexResourceCount,
  detectModeFromConfig,
  ensureRouterConfig,
  executeCapabilityProvider,
  exportCodexLooseSessionsMarkdown,
  exportCodexFilteredSessionsMarkdown,
  exportCodexSessionTreeMarkdown,
  exportCodexSessionMarkdown,
  exportCodexProjectMarkdown,
  exportConfigPackage,
  exportConfigPackageToDirectory,
  capabilityExecutionHistoryPath,
  clearImageGenerationHistory,
  codexProjectRecoveryPlan,
  readCapabilityExecutionHistory,
  imageOutputDirPath,
  imageGenerationHistoryPath,
  imageGenerationSettingsForProvider,
  importConfigPackage,
  latestConfigPackageImportBackupPath,
  latestConfigPackageSyncPackagePath,
  listCodexBackups,
  readCodexPromptInputSnapshot,
  readCodexAppServerResourceSnapshot,
  readCodexResourceSnapshots,
  listCodexResources,
  listCodexSessionTree,
  listCodexSessions,
  loadConfigProfiles,
  loadDesktopOptions,
  modelReferenceStatus,
  modelCatalog,
  modelDirectoryPath,
  modelImageGenerationPath,
  desktopOptionsPath,
  providerOverridesPath,
  providerCatalog,
  prepareRouterStartConfig,
  previewConfigPackageImport,
  readCodexCliResourceSnapshot,
  readConfigPackageImportBackupStatus,
  readConfigPackageSyncStatus,
  readModelCapabilityOverrides,
  readModelDirectory,
  readRouterConfig,
  readCustomModels,
  readProviderOverrides,
  releaseAssetsFromDirectory,
  resetProviderOverride,
  saveReleaseGateReport,
  refreshProviderModelDirectory,
  recoverCodexHistoryAccess,
  removeCustomModel,
  repairDesktopModelReferences,
  resetModelCapabilityOverride,
  restoreCodexConfig,
  restoreCodexConfigFromBackup,
  restoreLatestConfigPackageImportBackup,
  importLatestConfigPackageFromSyncDirectory,
  routerConfigPath,
  routerConfigDiagnostics,
  routerRuntimeEnv,
  readSelection,
  readImageProviderConfig,
  readImageProviders,
  readCapabilityProviderConfig,
  readCapabilityProviders,
  readCapabilityProviderGroups,
  refreshCodexVisibleModelCatalogIfManaged,
  repairManagedCodexConfigCompatibility,
  saveCapabilityProviderTestResult,
  readImageGenerationHistory,
  readModelImageGenerationOverrides,
  recordImageGenerationHistory,
  recordCapabilityExecutionHistory,
  saveModelImageInputOverride,
  saveModelCapabilityOverride,
  saveModelImageGenerationOverride,
  saveImageProvider,
  saveCapabilityProvider,
  saveImageProviderTestResult,
  removeCapabilityProvider,
  saveCustomModel,
  saveConfigProfile,
  saveDesktopOptions,
  saveProviderLogo,
  saveProviderOverride,
  saveSelection,
  saveSecrets,
  selectionPath,
  secretsPath,
  secretValue,
  secretStatus,
  setCodexResourceEnabled,
  supportDiagnostics,
  testCapabilityProviderConnection,
  testProviderConnection,
  syncCodexBridgeConversationProviders,
  synchronizeRouteState,
  refreshCodexPluginMarketplaces,
  removeCodexPluginResource,
  updateCodexPluginResource,
  writeRouterConfigFromSelection,
} from "../desktop/settings.mjs";

const require = createRequire(import.meta.url);

const hermeticEnvironmentKeys = [
  "USERPROFILE",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "PROGRAMDATA",
  "PUBLIC",
  "ProgramFiles",
  "PROGRAMFILES",
  "ProgramFiles(x86)",
  "PROGRAMFILES(X86)",
  "PATH",
  "Path",
];
const originalHermeticEnvironment = Object.fromEntries(
  hermeticEnvironmentKeys.map((key) => [key, process.env[key]]),
);

test.before(() => {
  const root = path.join(os.tmpdir(), `codexbridge-settings-hermetic-${process.pid}`);
  const userProfile = path.join(root, "User");
  const driveRoot = path.parse(root).root || "C:\\";
  process.env.USERPROFILE = userProfile;
  process.env.HOME = userProfile;
  process.env.HOMEDRIVE = driveRoot.replace(/[\\/]$/, "");
  process.env.HOMEPATH = path.relative(driveRoot, userProfile).replace(/\//g, "\\");
  process.env.APPDATA = path.join(userProfile, "AppData", "Roaming");
  process.env.LOCALAPPDATA = path.join(userProfile, "AppData", "Local");
  process.env.ProgramData = path.join(root, "ProgramData");
  process.env.PROGRAMDATA = process.env.ProgramData;
  process.env.PUBLIC = path.join(root, "Public");
  process.env.ProgramFiles = path.join(root, "Program Files");
  process.env.PROGRAMFILES = process.env.ProgramFiles;
  process.env["ProgramFiles(x86)"] = path.join(root, "Program Files (x86)");
  process.env["PROGRAMFILES(X86)"] = process.env["ProgramFiles(x86)"];
  process.env.PATH = "";
  process.env.Path = "";
});

test.after(() => {
  for (const [key, value] of Object.entries(originalHermeticEnvironment)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function buildStartupCheck(rootDir, options = {}) {
  return buildStartupCheckProduction(rootDir, {
    ...options,
    codexDesktopLocatorOptions: {
      shellAppCandidates: [],
      pathCandidates: [],
      execFile: () => {
        throw new Error("hermetic desktop locator must not start external commands");
      },
      ...(options.codexDesktopLocatorOptions || {}),
    },
  });
}

test("detectModeFromConfig distinguishes all-api and hybrid", () => {
  assert.equal(detectModeFromConfig({}), MODE_ALL_API);
  assert.equal(detectModeFromConfig({ mode: MODE_ALL_API, clientAuth: { allowOpenAiBearer: true } }), MODE_ALL_API);
  assert.equal(detectModeFromConfig({ mode: MODE_HYBRID, clientAuth: { allowOpenAiBearer: false } }), MODE_HYBRID);
  assert.equal(
    detectModeFromConfig({ clientAuth: { allowOpenAiBearer: true } }),
    MODE_HYBRID,
  );
});

test("buildCodexToml uses an authenticated local provider without requiring ChatGPT login in all-api mode", () => {
  const rootDir = path.join(os.tmpdir(), "codex-bridge-router");
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const toml = buildCodexToml({
    rootDir,
    mode: MODE_ALL_API,
    port: 15722,
    homeDir,
    authToken: "cbr_test_token",
  });
  const catalogFile = toFixtureTomlPath(path.join(homeDir, ".codex", "codexbridge-model-catalog.json"));

  assert.match(toml, /model_provider = "codexbridge"/);
  assert.match(toml, /model_providers\.codexbridge\.base_url = "http:\/\/127\.0\.0\.1:15722\/v1"/);
  assert.match(toml, /model_providers\.codexbridge\.wire_api = "responses"/);
  assert.match(toml, /model_providers\.codexbridge\.requires_openai_auth = false/);
  assert.match(
    toml,
    /model_providers\.codexbridge\.http_headers = \{ Authorization = "Bearer cbr_test_token" \}/,
  );
  assert.doesNotMatch(toml, /openai_base_url/);
  assert.doesNotMatch(toml, /experimental_bearer_token/);
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

  assert.match(toml, /model = "cb-gpt-5-6-sol"/);
  assert.doesNotMatch(toml, /model = "gpt-5\.6-sol"/);
});

test("buildCodexToml preserves the OpenAI history provider while proxying hybrid mode", () => {
  const toml = buildCodexToml({
    rootDir: path.join(os.tmpdir(), "codex-bridge-router"),
    mode: MODE_HYBRID,
    port: 15722,
  });

  assert.match(toml, /model_provider = "openai"/);
  assert.match(toml, /openai_base_url = "http:\/\/127\.0\.0\.1:15722\/v1"/);
  assert.doesNotMatch(toml, /model_providers\.codexbridge/);
  assert.doesNotMatch(toml, /supports_websockets/);
  assert.doesNotMatch(toml, /\[model_providers\.codex-bridge]/);
  assert.doesNotMatch(toml, /experimental_bearer_token/);
});

test("buildCodexToml keeps Codex desktop history in the built-in OpenAI provider namespace", () => {
  const toml = buildCodexToml({
    rootDir: path.join(os.tmpdir(), "codex-bridge-router"),
    mode: MODE_HYBRID,
    port: 15722,
  });

  assert.match(toml, /model_provider = "openai"/);
  assert.doesNotMatch(toml, /model_provider = "codex-bridge"/);
  assert.doesNotMatch(toml, /\[model_providers\.codex-bridge]/);
});

test("buildCodexToml omits the removed response storage override", () => {
  const toml = buildCodexToml({
    rootDir: path.join(os.tmpdir(), "codex-bridge-router"),
    mode: MODE_HYBRID,
    port: 15722,
  });

  assert.doesNotMatch(toml, /disable_response_storage/);
});

test("saveSecrets records only non-empty values", () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, {
    OPENAI_API_KEY: "  openai-key  ",
    DEEPSEEK_API_KEY: "",
    MOONSHOT_API_KEY: "kimi-key",
  });

  assert.deepEqual(secretStatus(rootDir), {
    ANTHROPIC_API_KEY: false,
    ARK_API_KEY: false,
    DASHSCOPE_API_KEY: false,
    DEEPSEEK_API_KEY: false,
    GEMINI_API_KEY: false,
    HUNYUAN_API_KEY: false,
    KIMI_CODE_API_KEY: false,
    MIMO_API_KEY: false,
    MINIMAX_API_KEY: false,
    MOONSHOT_API_KEY: true,
    OPENAI_API_KEY: true,
    OPENROUTER_API_KEY: false,
    QIANFAN_API_KEY: false,
    SILICONFLOW_API_KEY: false,
    STEPFUN_API_KEY: false,
    XAI_API_KEY: false,
    ZHIPUAI_API_KEY: false,
  });

  saveSecrets(rootDir, {
    OPENAI_API_KEY: "",
    DEEPSEEK_API_KEY: "deepseek-key",
    MOONSHOT_API_KEY: "",
  });

  assert.deepEqual(secretStatus(rootDir), {
    ANTHROPIC_API_KEY: false,
    ARK_API_KEY: false,
    DASHSCOPE_API_KEY: false,
    DEEPSEEK_API_KEY: true,
    GEMINI_API_KEY: false,
    HUNYUAN_API_KEY: false,
    KIMI_CODE_API_KEY: false,
    MIMO_API_KEY: false,
    MINIMAX_API_KEY: false,
    MOONSHOT_API_KEY: true,
    OPENAI_API_KEY: true,
    OPENROUTER_API_KEY: false,
    QIANFAN_API_KEY: false,
    SILICONFLOW_API_KEY: false,
    STEPFUN_API_KEY: false,
    XAI_API_KEY: false,
    ZHIPUAI_API_KEY: false,
  });
});

test("saveSecrets writes the local secret file atomically", () => {
  const rootDir = makeTempProject();
  const target = secretsPath(rootDir);
  const originalRenameSync = fs.renameSync;
  const renames = [];
  fs.renameSync = (from, to) => {
    renames.push({ from, to });
    return originalRenameSync(from, to);
  };
  try {
    saveSecrets(rootDir, { OPENAI_API_KEY: "openai-key" });
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(renames.length, 1);
  assert.equal(renames[0].to, target);
  assert.match(path.basename(renames[0].from), /^\.secrets\.local\.json\.\d+\.\d+\.tmp$/);
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).OPENAI_API_KEY, "openai-key");
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
  assert.equal(loadDesktopOptions(rootDir).localRateLimitEnabled, false);
  assert.equal(loadDesktopOptions(rootDir).duplicateRequestProtection, false);
  assert.equal(loadDesktopOptions(rootDir).autoSelectModel, false);
  assert.equal(loadDesktopOptions(rootDir).autoFailover, false);
  const saved = saveDesktopOptions(rootDir, {
    bypassSystemProxy: true,
    routerPort: 15999,
    localRateLimitEnabled: true,
    duplicateRequestProtection: false,
    autoSelectModel: true,
    autoFailover: true,
    usageBudgets: {
      global: {
        dailyTokenLimit: 1000,
        dailyCallLimit: 20,
        dailyCostLimit: 3.5,
        inputCostPerMillion: 1.25,
      },
      routes: { "cb-kimi-k2-7-code": { dailyTokenLimit: 500, outputCostPerMillion: 2.5 } },
      providers: { deepseek: { dailyCallLimit: 5, dailyCostLimit: 0.75, cacheCostPerMillion: 0.125 } },
    },
    codexDesktopExe: " C:\\Tools\\Codex\\Codex.exe ",
    codexDesktopLaunchTarget: " C:\\Users\\User\\Desktop\\Codex.lnk ",
  });

  assert.equal(saved.bypassSystemProxy, true);
  assert.equal(saved.routerPort, 15999);
  assert.equal(saved.localRateLimitEnabled, true);
  assert.equal(saved.duplicateRequestProtection, false);
  assert.equal(saved.autoSelectModel, true);
  assert.equal(saved.autoFailover, true);
  assert.equal(saved.usageBudgets.global.dailyTokenLimit, 1000);
  assert.equal(saved.usageBudgets.global.dailyCallLimit, 20);
  assert.equal(saved.usageBudgets.global.dailyCostLimit, 3.5);
  assert.equal(saved.usageBudgets.global.inputCostPerMillion, 1.25);
  assert.equal(saved.usageBudgets.routes["cb-kimi-k2-7-code"].dailyTokenLimit, 500);
  assert.equal(saved.usageBudgets.routes["cb-kimi-k2-7-code"].outputCostPerMillion, 2.5);
  assert.equal(saved.usageBudgets.providers.deepseek.dailyCallLimit, 5);
  assert.equal(saved.usageBudgets.providers.deepseek.dailyCostLimit, 0.75);
  assert.equal(saved.usageBudgets.providers.deepseek.cacheCostPerMillion, 0.125);
  assert.equal(saved.codexDesktopExe, "C:\\Tools\\Codex\\Codex.exe");
  assert.equal(saved.codexDesktopLaunchTarget, "C:\\Users\\User\\Desktop\\Codex.lnk");
  const partial = saveDesktopOptions(rootDir, { bypassSystemProxy: false });
  assert.equal(partial.bypassSystemProxy, false);
  assert.equal(partial.routerPort, 15999);
  assert.equal(partial.localRateLimitEnabled, true);
  assert.equal(partial.duplicateRequestProtection, false);
  assert.equal(partial.autoSelectModel, true);
  assert.equal(partial.autoFailover, true);
  assert.equal(partial.usageBudgets.global.dailyTokenLimit, 1000);
  assert.equal(partial.usageBudgets.global.dailyCostLimit, 3.5);
  assert.equal(partial.usageBudgets.global.inputCostPerMillion, 1.25);
  assert.equal(partial.codexDesktopExe, "C:\\Tools\\Codex\\Codex.exe");
  assert.equal(partial.codexDesktopLaunchTarget, "C:\\Users\\User\\Desktop\\Codex.lnk");
});

test("legacy default-on duplicate protection migrates off until the user explicitly enables it", () => {
  const rootDir = makeTempProject();
  const target = desktopOptionsPath(rootDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({
    routerPort: 15991,
    duplicateRequestProtection: true,
  }, null, 2), "utf8");

  const migrated = loadDesktopOptions(rootDir);
  assert.equal(migrated.routerPort, 15991);
  assert.equal(migrated.duplicateRequestProtection, false);
  assert.equal(migrated.duplicateRequestProtectionPolicyVersion, 2);

  const persisted = saveDesktopOptions(rootDir, { bypassSystemProxy: true });
  assert.equal(persisted.duplicateRequestProtection, false);
  assert.equal(persisted.duplicateRequestProtectionPolicyVersion, 2);
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).duplicateRequestProtection, false);

  const explicitlyEnabled = saveDesktopOptions(rootDir, {
    duplicateRequestProtection: true,
  });
  assert.equal(explicitlyEnabled.duplicateRequestProtection, true);
  assert.equal(explicitlyEnabled.duplicateRequestProtectionPolicyVersion, 2);
});

test("explicit duplicate protection survives partial saves and config export/import", () => {
  const rootDir = makeTempProject();

  const rateLimited = saveDesktopOptions(rootDir, { localRateLimitEnabled: true });
  assert.equal(rateLimited.localRateLimitEnabled, true);
  assert.equal(rateLimited.duplicateRequestProtection, false);

  const duplicatesEnabled = saveDesktopOptions(rootDir, { duplicateRequestProtection: true });
  assert.equal(duplicatesEnabled.localRateLimitEnabled, true);
  assert.equal(duplicatesEnabled.duplicateRequestProtection, true);
  assert.equal(duplicatesEnabled.duplicateRequestProtectionPolicyVersion, 2);

  const rateLimitDisabled = saveDesktopOptions(rootDir, { localRateLimitEnabled: false });
  assert.equal(rateLimitDisabled.localRateLimitEnabled, false);
  assert.equal(rateLimitDisabled.duplicateRequestProtection, true);

  const exported = exportConfigPackage(rootDir, { includeCodexResources: false });
  assert.equal(exported.desktopOptions.duplicateRequestProtection, true);

  const importedRoot = makeTempProject();
  importConfigPackage(importedRoot, exported);
  assert.equal(loadDesktopOptions(importedRoot).duplicateRequestProtection, true);
  assert.equal(loadDesktopOptions(importedRoot).duplicateRequestProtectionPolicyVersion, 2);
});

test("saveDesktopOptions writes desktop options atomically", () => {
  const rootDir = makeTempProject();
  const target = desktopOptionsPath(rootDir);
  const originalRenameSync = fs.renameSync;
  const renames = [];
  fs.renameSync = (from, to) => {
    renames.push({ from, to });
    return originalRenameSync(from, to);
  };
  try {
    saveDesktopOptions(rootDir, { routerPort: 15999 });
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(renames.length, 1);
  assert.equal(renames[0].to, target);
  assert.match(path.basename(renames[0].from), /^\.desktop-options\.json\.\d+\.\d+\.tmp$/);
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).routerPort, 15999);
});

test("router config uses the configured desktop router port", () => {
  const rootDir = makeTempProject();
  saveDesktopOptions(rootDir, { routerPort: 15999 });
  const config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.equal(config.port, 15999);
});

test("desktop persists an unpredictable Router token and keeps the all-api Codex provider in sync", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-router-token-"));

  const first = writeRouterConfigFromSelection(rootDir, MODE_ALL_API);
  const second = writeRouterConfigFromSelection(rootDir, MODE_ALL_API);
  const toml = buildCodexToml({
    rootDir,
    homeDir,
    mode: MODE_ALL_API,
    port: second.port,
    authToken: second.authToken,
  });

  assert.match(first.authToken, /^cbr_[a-f0-9]{32}$/);
  assert.notEqual(first.authToken, "sk-local-codex-router");
  assert.equal(first.clientAuth.allowOpenAiBearer, false);
  assert.equal(second.authToken, first.authToken);
  assert.match(
    toml,
    new RegExp(`Authorization = "Bearer ${escapeRegExp(second.authToken)}"`),
  );
  assert.doesNotMatch(toml, /sk-local-codex-router/);
});

test("router config exports smart routing switches and keeps them disabled by default", () => {
  const rootDir = makeTempProject();
  let config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.deepEqual(config.smartRouting, {
    autoSelectModel: false,
    autoFailover: false,
  });

  saveDesktopOptions(rootDir, {
    autoSelectModel: true,
    autoFailover: true,
  });
  config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.deepEqual(config.smartRouting, {
    autoSelectModel: true,
    autoFailover: true,
  });
});

test("router config exports Codex auxiliary task handling with first model as default", () => {
  const rootDir = makeTempProject();
  saveSelection(rootDir, ["deepseek-v4-pro", "kimi-k2-7-code"], MODE_HYBRID);
  let config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.deepEqual(config.codexAuxiliaryTasks, {
    intercept: false,
    routeId: "cb-deepseek-v4-pro",
  });

  saveDesktopOptions(rootDir, {
    interceptCodexAuxiliaryTasks: true,
    codexAuxiliaryModelId: "cb-kimi-k2-7-code",
  });
  config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.deepEqual(config.codexAuxiliaryTasks, {
    intercept: true,
    routeId: "cb-kimi-k2-7-code",
  });
});

test("desktop options persist configurable smart routing policies", () => {
  const rootDir = makeTempProject();

  const saved = saveDesktopOptions(rootDir, {
    autoSelectModel: true,
    autoFailover: true,
    smartRouting: {
      autoSelectRules: {
        code: { mode: "route", routeId: "cb-kimi-k2-7-code" },
        longContext: { mode: "off" },
        ordinaryChat: { mode: "route", routeId: "cb-deepseek-v4-pro" },
      },
      failover: {
        mode: "ordered",
        routeIds: ["cb-deepseek-v4-pro", "cb-kimi-k2-7-code"],
      },
    },
  });

  assert.deepEqual(saved.smartRouting.autoSelectRules.code, {
    mode: "route",
    routeId: "cb-kimi-k2-7-code",
  });
  assert.deepEqual(saved.smartRouting.autoSelectRules.longContext, {
    mode: "off",
    routeId: "",
  });
  assert.deepEqual(saved.smartRouting.failover, {
    mode: "ordered",
    routeIds: ["cb-deepseek-v4-pro", "cb-kimi-k2-7-code"],
  });

  const partial = saveDesktopOptions(rootDir, {
    smartRouting: {
      autoSelectRules: {
        imageGeneration: { mode: "off" },
      },
    },
  });
  assert.deepEqual(partial.smartRouting.autoSelectRules.code, {
    mode: "route",
    routeId: "cb-kimi-k2-7-code",
  });
  assert.deepEqual(partial.smartRouting.autoSelectRules.imageGeneration, {
    mode: "off",
    routeId: "",
  });
  assert.deepEqual(partial.smartRouting.failover, {
    mode: "ordered",
    routeIds: ["cb-deepseek-v4-pro", "cb-kimi-k2-7-code"],
  });

  const config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);
  assert.equal(config.smartRouting.autoSelectModel, true);
  assert.equal(config.smartRouting.autoFailover, true);
  assert.deepEqual(config.smartRouting.autoSelectRules.code, {
    mode: "route",
    routeId: "cb-kimi-k2-7-code",
  });
  assert.deepEqual(config.smartRouting.autoSelectRules.imageGeneration, {
    mode: "off",
    routeId: "",
  });
  assert.deepEqual(config.smartRouting.failover, {
    mode: "ordered",
    routeIds: ["cb-deepseek-v4-pro", "cb-kimi-k2-7-code"],
  });
});

test("router config repairs stale auxiliary and smart routing route references", () => {
  const rootDir = makeTempProject();
  fs.mkdirSync(path.join(rootDir, "config"), { recursive: true });
  fs.writeFileSync(
    modelDirectoryPath(rootDir),
    JSON.stringify({
      version: 1,
      providers: {
        "kimi-code": {
          providerId: "kimi-code",
          providerName: "Kimi Code",
          baseUrl: "https://api.kimi.com/coding/v1",
          models: [{ id: "kimi-for-coding" }],
        },
      },
    }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    selectionPath(rootDir),
    JSON.stringify({ selectedModelIds: ["kimi-code-k3"] }, null, 2),
    "utf8",
  );
  saveDesktopOptions(rootDir, {
    interceptCodexAuxiliaryTasks: true,
    codexAuxiliaryModelId: "cb-kimi-code-k3",
    autoSelectModel: true,
    autoFailover: true,
    smartRouting: {
      autoSelectRules: {
        code: { mode: "route", routeId: "cb-kimi-code-k3" },
        longContext: { mode: "route", routeId: "cb-missing-model" },
      },
      failover: {
        mode: "ordered",
        routeIds: ["cb-missing-model", "cb-kimi-code-k3"],
      },
    },
  });

  const config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.deepEqual(config.codexAuxiliaryTasks, {
    intercept: true,
    routeId: "cb-kimi-code-for-coding",
  });
  assert.deepEqual(config.smartRouting.autoSelectRules.code, {
    mode: "route",
    routeId: "cb-kimi-code-for-coding",
  });
  assert.deepEqual(config.smartRouting.autoSelectRules.longContext, {
    mode: "auto",
    routeId: "",
  });
  assert.deepEqual(config.smartRouting.failover, {
    mode: "ordered",
    routeIds: ["cb-kimi-code-for-coding"],
  });

  const saved = loadDesktopOptions(rootDir);
  assert.equal(saved.codexAuxiliaryModelId, "cb-kimi-code-for-coding");
  assert.equal(saved.smartRouting.autoSelectRules.code.routeId, "cb-kimi-code-for-coding");
  assert.deepEqual(saved.smartRouting.failover.routeIds, ["cb-kimi-code-for-coding"]);
});

test("model reference status reports stale selection, auxiliary, smart routing, and failover refs", () => {
  const rootDir = makeTempProject();
  fs.mkdirSync(path.join(rootDir, "config"), { recursive: true });
  fs.writeFileSync(
    modelDirectoryPath(rootDir),
    JSON.stringify({
      version: 1,
      providers: {
        "kimi-code": {
          providerId: "kimi-code",
          providerName: "Kimi Code",
          baseUrl: "https://api.kimi.com/coding/v1",
          models: [{ id: "kimi-for-coding" }],
        },
      },
    }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    selectionPath(rootDir),
    JSON.stringify({ selectedModelIds: ["kimi-code-k3"] }, null, 2),
    "utf8",
  );
  saveDesktopOptions(rootDir, {
    interceptCodexAuxiliaryTasks: true,
    codexAuxiliaryModelId: "cb-kimi-code-k3",
    smartRouting: {
      autoSelectRules: {
        code: { mode: "route", routeId: "cb-kimi-code-k3" },
        longContext: { mode: "route", routeId: "cb-missing-model" },
      },
      failover: {
        mode: "ordered",
        routeIds: ["cb-missing-model", "cb-kimi-code-k3"],
      },
    },
  });

  const status = modelReferenceStatus(rootDir, MODE_HYBRID);

  assert.equal(status.ok, false);
  assert.equal(status.issueCount, 6);
  assert.deepEqual(status.rawSelectedModelIds, ["kimi-code-k3"]);
  assert.deepEqual(status.selectedModelIds, ["kimi-code-for-coding"]);
  assert.deepEqual(
    status.issues.map((issue) => [issue.kind, issue.value, issue.repairedValue]),
    [
      ["selection", "kimi-code-k3", "kimi-code-for-coding"],
      ["codex_auxiliary", "cb-kimi-code-k3", "cb-kimi-code-for-coding"],
      ["smart_route", "cb-kimi-code-k3", "cb-kimi-code-for-coding"],
      ["smart_route", "cb-missing-model", ""],
      ["smart_failover", "cb-missing-model", ""],
      ["smart_failover", "cb-kimi-code-k3", "cb-kimi-code-for-coding"],
    ],
  );
});

test("repairDesktopModelReferences returns before and after model reference status", () => {
  const rootDir = makeTempProject();
  fs.mkdirSync(path.join(rootDir, "config"), { recursive: true });
  fs.writeFileSync(
    modelDirectoryPath(rootDir),
    JSON.stringify({
      version: 1,
      providers: {
        "kimi-code": {
          providerId: "kimi-code",
          providerName: "Kimi Code",
          baseUrl: "https://api.kimi.com/coding/v1",
          models: [{ id: "kimi-for-coding" }],
        },
      },
    }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    routerConfigPath(rootDir),
    JSON.stringify({ mode: MODE_HYBRID, models: [{ id: "cb-kimi-code-k3" }] }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    selectionPath(rootDir),
    JSON.stringify({ selectedModelIds: ["kimi-code-k3"] }, null, 2),
    "utf8",
  );
  saveDesktopOptions(rootDir, {
    codexAuxiliaryModelId: "cb-kimi-code-k3",
    smartRouting: {
      autoSelectRules: {
        code: { mode: "route", routeId: "cb-kimi-code-k3" },
      },
      failover: {
        mode: "ordered",
        routeIds: ["cb-missing-model", "cb-kimi-code-k3"],
      },
    },
  });

  const repair = repairDesktopModelReferences(rootDir, MODE_HYBRID);

  assert.equal(repair.beforeStatus.ok, false);
  assert.equal(repair.beforeStatus.issueCount, 5);
  assert.equal(repair.afterStatus.ok, true);
  assert.equal(repair.afterStatus.issueCount, 0);
  assert.deepEqual(repair.selectedModelIds, ["kimi-code-for-coding"]);
  assert.equal(repair.codexAuxiliaryModelId, "cb-kimi-code-for-coding");
  assert.deepEqual(repair.smartRouting.failover.routeIds, ["cb-kimi-code-for-coding"]);
});

test("repairDesktopModelReferences repairs stale model references stored in config profiles", () => {
  const rootDir = makeTempProject();
  fs.mkdirSync(path.join(rootDir, "config"), { recursive: true });
  fs.writeFileSync(
    modelDirectoryPath(rootDir),
    JSON.stringify({
      version: 1,
      providers: {
        "kimi-code": {
          providerId: "kimi-code",
          providerName: "Kimi Code",
          baseUrl: "https://api.kimi.com/coding/v1",
          models: [{ id: "kimi-for-coding" }],
        },
      },
    }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    configProfilesPath(rootDir),
    JSON.stringify({
      version: 1,
      profiles: [
        {
          id: "old-kimi-profile",
          name: "Old Kimi",
          mode: MODE_HYBRID,
          selectedModelIds: ["kimi-code-k3"],
          desktopOptions: {
            codexAuxiliaryModelId: "cb-kimi-code-k3",
            smartRouting: {
              autoSelectRules: {
                code: { mode: "route", routeId: "cb-kimi-code-k3" },
                longContext: { mode: "route", routeId: "cb-missing-model" },
              },
              failover: {
                mode: "ordered",
                routeIds: ["cb-missing-model", "cb-kimi-code-k3"],
              },
            },
          },
        },
      ],
    }, null, 2),
    "utf8",
  );

  const repair = repairDesktopModelReferences(rootDir, MODE_HYBRID);
  const [profile] = loadConfigProfiles(rootDir);

  assert.equal(repair.profileReferenceRepairCount, 1);
  assert.deepEqual(profile.selectedModelIds, ["kimi-code-for-coding"]);
  assert.equal(profile.desktopOptions.codexAuxiliaryModelId, "cb-kimi-code-for-coding");
  assert.deepEqual(profile.desktopOptions.smartRouting.autoSelectRules.code, {
    mode: "route",
    routeId: "cb-kimi-code-for-coding",
  });
  assert.deepEqual(profile.desktopOptions.smartRouting.autoSelectRules.longContext, {
    mode: "auto",
    routeId: "",
  });
  assert.deepEqual(profile.desktopOptions.smartRouting.failover, {
    mode: "ordered",
    routeIds: ["cb-kimi-code-for-coding"],
  });
});

test("synchronizeRouteState repairs stale desktop references and refreshes the independent model catalog in one pass", () => {
  const rootDir = makeTempProject();
  fs.mkdirSync(path.join(rootDir, "config"), { recursive: true });
  fs.writeFileSync(
    modelDirectoryPath(rootDir),
    JSON.stringify({
      version: 1,
      providers: {
        "kimi-code": {
          providerId: "kimi-code",
          providerName: "Kimi Code",
          baseUrl: "https://api.kimi.com/coding/v1",
          models: [{ id: "kimi-for-coding" }],
        },
      },
    }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    routerConfigPath(rootDir),
    JSON.stringify({ mode: MODE_HYBRID, models: [{ id: "cb-kimi-code-k3" }] }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    selectionPath(rootDir),
    JSON.stringify({ selectedModelIds: ["kimi-code-k3"] }, null, 2),
    "utf8",
  );
  saveDesktopOptions(rootDir, {
    codexAuxiliaryModelId: "cb-kimi-code-k3",
    smartRouting: {
      autoSelectRules: {
        code: { mode: "route", routeId: "cb-kimi-code-k3" },
      },
      failover: {
        mode: "ordered",
        routeIds: ["cb-missing-model", "cb-kimi-code-k3"],
      },
    },
  });
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    buildCodexToml({ rootDir, mode: MODE_HYBRID, homeDir, model: "cb-kimi-code-k3" }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(codexDir, "models_cache.json"),
    JSON.stringify({
      models: [
        { slug: "cb-kimi-code-k3", display_name: "Stale Kimi Code", codexbridge_cache_entry: true },
      ],
    }, null, 2),
    "utf8",
  );

  const plan = buildRouteSyncPlan(rootDir, { mode: MODE_HYBRID, homeDir });
  const result = synchronizeRouteState(rootDir, { mode: MODE_HYBRID, homeDir });
  const nativeCache = JSON.parse(fs.readFileSync(path.join(codexDir, "models_cache.json"), "utf8"));
  const catalog = JSON.parse(fs.readFileSync(path.join(codexDir, "codexbridge-model-catalog.json"), "utf8"));
  const catalogSlugs = catalog.models.map((model) => model.slug);

  assert.equal(plan.needsRepair, true);
  assert.deepEqual(
    plan.actions.map((action) => [action.id, action.status]),
    [
      ["repair_model_references", "pending"],
      ["write_router_config", "pending"],
      ["refresh_codex_model_catalog", "pending"],
    ],
  );
  assert.equal(result.ok, true);
  assert.equal(result.beforeStatus.ok, false);
  assert.equal(result.afterStatus.ok, true);
  assert.deepEqual(result.selectedModelIds, ["kimi-code-for-coding"]);
  assert.equal(result.config.defaultModel, "cb-kimi-code-for-coding");
  assert.equal(result.catalog.skipped, false);
  assert.equal(catalogSlugs.includes("cb-kimi-code-for-coding"), true);
  assert.equal(catalogSlugs.includes("cb-kimi-code-k3"), false);
  assert.deepEqual(nativeCache.models.map((model) => model.slug), ["cb-kimi-code-k3"]);
  assert.equal(loadDesktopOptions(rootDir).codexAuxiliaryModelId, "cb-kimi-code-for-coding");
});

test("router config builds from repaired selected model ids instead of stale saved ids", () => {
  const rootDir = makeTempProject();
  fs.mkdirSync(path.join(rootDir, "config"), { recursive: true });
  fs.writeFileSync(
    modelDirectoryPath(rootDir),
    JSON.stringify({
      version: 1,
      providers: {
        "kimi-code": {
          providerId: "kimi-code",
          providerName: "Kimi Code",
          baseUrl: "https://api.kimi.com/coding/v1",
          models: [{ id: "kimi-for-coding" }],
        },
      },
    }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    selectionPath(rootDir),
    JSON.stringify({ selectedModelIds: ["kimi-code-k3"] }, null, 2),
    "utf8",
  );

  const config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.deepEqual(readSelection(rootDir, MODE_HYBRID), ["kimi-code-for-coding"]);
  assert.equal(config.defaultModel, "cb-kimi-code-for-coding");
  assert.equal(config.models[0].sourcePresetId, "kimi-code-for-coding");
});

test("router config repairs stale selected upstream model names after provider sync", () => {
  const rootDir = makeTempProject();
  fs.mkdirSync(path.join(rootDir, "config"), { recursive: true });
  fs.writeFileSync(
    modelDirectoryPath(rootDir),
    JSON.stringify({
      version: 1,
      providers: {
        kimi: {
          providerId: "kimi",
          providerName: "Kimi",
          baseUrl: "https://api.moonshot.cn/v1",
          models: [{ id: "moonshotai/Kimi-K2.6" }],
        },
      },
    }, null, 2),
    "utf8",
  );
  const syncedKimi = modelCatalog(rootDir).find((model) =>
    model.providerId === "kimi" && model.model === "moonshotai/Kimi-K2.6"
  );
  assert.ok(syncedKimi?.presetId);
  fs.writeFileSync(
    selectionPath(rootDir),
    JSON.stringify({ selectedModelIds: ["deepseek-v4-pro", "kimi-k2.7-code"] }, null, 2),
    "utf8",
  );

  const config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.deepEqual(readSelection(rootDir, MODE_HYBRID), ["deepseek-v4-pro", syncedKimi.presetId]);
  assert.equal(config.models.length, 2);
  assert.equal(config.models[1].sourcePresetId, syncedKimi.presetId);
  assert.equal(config.models[1].model, "moonshotai/Kimi-K2.6");
});

test("provider save repairs stale selected model before refreshing router config", () => {
  const rootDir = makeTempProject();
  fs.mkdirSync(path.join(rootDir, "config"), { recursive: true });
  fs.writeFileSync(
    modelDirectoryPath(rootDir),
    JSON.stringify({
      version: 1,
      providers: {
        "kimi-code": {
          providerId: "kimi-code",
          providerName: "Kimi Code",
          baseUrl: "https://api.kimi.com/coding/v1",
          models: [{ id: "kimi-for-coding" }],
        },
      },
    }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    routerConfigPath(rootDir),
    JSON.stringify({ mode: MODE_HYBRID, models: [{ id: "cb-kimi-code-k3" }] }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    selectionPath(rootDir),
    JSON.stringify({ selectedModelIds: ["kimi-code-k3"] }, null, 2),
    "utf8",
  );

  assert.doesNotThrow(() => saveProviderOverride(rootDir, "deepseek", {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    api: "chat_completions",
  }));

  assert.deepEqual(readSelection(rootDir, MODE_HYBRID), ["kimi-code-for-coding"]);
  assert.equal(readRouterConfig(rootDir).models[0].id, "cb-kimi-code-for-coding");
});

test("provider reset clears overrides and repairs stale references", () => {
  const rootDir = makeTempProject();
  fs.mkdirSync(path.join(rootDir, "config"), { recursive: true });
  fs.writeFileSync(
    modelDirectoryPath(rootDir),
    JSON.stringify({
      version: 1,
      providers: {
        "kimi-code": {
          providerId: "kimi-code",
          providerName: "Kimi Code",
          baseUrl: "https://api.kimi.com/coding/v1",
          models: [{ id: "kimi-for-coding" }],
        },
      },
    }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    routerConfigPath(rootDir),
    JSON.stringify({ mode: MODE_HYBRID, models: [{ id: "cb-kimi-code-k3" }] }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    selectionPath(rootDir),
    JSON.stringify({ selectedModelIds: ["kimi-code-k3"] }, null, 2),
    "utf8",
  );
  saveProviderOverride(rootDir, "kimi-code", {
    name: "Kimi Code Custom",
    shortName: "Kimi Code",
    baseUrl: "https://api.kimi.com/coding/v1",
    api: "chat_completions",
  });
  assert.equal(providerCatalog(rootDir).find((provider) => provider.id === "kimi-code").name, "Kimi Code Custom");

  const result = resetProviderOverride(rootDir, "kimi-code");

  assert.equal(result.removed, true);
  assert.equal(readProviderOverrides(rootDir)["kimi-code"], undefined);
  assert.notEqual(providerCatalog(rootDir).find((provider) => provider.id === "kimi-code").name, "Kimi Code Custom");
  assert.deepEqual(readSelection(rootDir, MODE_HYBRID), ["kimi-code-for-coding"]);
  assert.equal(readRouterConfig(rootDir).models[0].id, "cb-kimi-code-for-coding");
});

test("router config exports local rate limit switch disabled by default", () => {
  const rootDir = makeTempProject();
  let config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.deepEqual(config.rateLimit, {
    enabled: false,
    mode: "off",
  });
  assert.equal(config.models.every((route) => route.localRateLimitEnabled === false), true);

  saveDesktopOptions(rootDir, { localRateLimitEnabled: true });
  config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.deepEqual(config.rateLimit, {
    enabled: true,
    mode: "relaxed",
  });
  assert.equal(config.models.every((route) => route.localRateLimitEnabled === true), true);
});

test("duplicate request protection is disabled by default in a new router config", () => {
  const rootDir = makeTempProject();
  let config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.equal(config.duplicateRequestProtection, false);
  assert.equal(config.rateLimit.enabled, false);

  saveDesktopOptions(rootDir, { duplicateRequestProtection: true });
  config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);
  assert.equal(config.duplicateRequestProtection, true);
  assert.equal(config.rateLimit.enabled, false);

  saveDesktopOptions(rootDir, { localRateLimitEnabled: true });
  config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);
  assert.equal(config.duplicateRequestProtection, true);
  assert.equal(config.rateLimit.enabled, true);
});

test("router config exports usage budgets for router-side guards", () => {
  const rootDir = makeTempProject();
  saveDesktopOptions(rootDir, {
    usageBudgets: {
      global: {
        dailyTokenLimit: 1000,
        dailyCallLimit: 20,
        dailyCostLimit: 3.5,
        inputCostPerMillion: 1.25,
      },
      routes: { "cb-kimi-k2-7-code": { dailyTokenLimit: 500, outputCostPerMillion: 2.5 } },
      providers: { deepseek: { dailyCallLimit: 5, dailyCostLimit: 0.75, cacheCostPerMillion: 0.125 } },
    },
  });

  const config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.deepEqual(config.usageBudgets, {
    global: {
      dailyTokenLimit: 1000,
      dailyCallLimit: 20,
      dailyCostLimit: 3.5,
      inputCostPerMillion: 1.25,
    },
    routes: { "cb-kimi-k2-7-code": { dailyTokenLimit: 500, outputCostPerMillion: 2.5 } },
    providers: { deepseek: { dailyCallLimit: 5, dailyCostLimit: 0.75, cacheCostPerMillion: 0.125 } },
  });
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
  assert.equal(env.CODEXBRIDGE_DATA_DIR, rootDir);
  assert.equal(env.CODEXBRIDGE_DISABLE_SYSTEM_PROXY, "1");
});

test("routerRuntimeEnv keeps Bridge-owned paths authoritative over secret-file collisions", () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, {
    CODEXBRIDGE_DATA_DIR: "C:\\hijacked-data",
    ROUTER_CONFIG: "C:\\hijacked-router.json",
    CODEXBRIDGE_SECRETS_FILE: "C:\\hijacked-secrets.json",
    DEEPSEEK_API_KEY: "fake-ordinary-secret",
  });

  const env = routerRuntimeEnv(rootDir, {
    CODEXBRIDGE_DATA_DIR: "C:\\base-data",
    ROUTER_CONFIG: "C:\\base-router.json",
    CODEXBRIDGE_SECRETS_FILE: "C:\\base-secrets.json",
  });

  assert.equal(env.CODEXBRIDGE_DATA_DIR, rootDir);
  assert.equal(env.ROUTER_CONFIG, path.join(rootDir, "config", "router.config.json"));
  assert.equal(
    env.CODEXBRIDGE_SECRETS_FILE,
    path.join(rootDir, "config", "secrets.local.json"),
  );
  assert.equal(env.DEEPSEEK_API_KEY, "fake-ordinary-secret");
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
    codexCliSnapshot: codexCliAuthoritySnapshot(),
    codexPromptInputSnapshot: codexPromptSkillsSnapshot([{
      name: "demo",
      description: "Use when testing diagnostics.",
      path: path.join(homeDir, ".codex", "skills", "demo", "SKILL.md"),
    }]),
  });

  assert.match(diagnostics.text, /CodexBridge Diagnostics/);
  assert.match(diagnostics.text, /version: 0\.1\.18/);
  assert.match(diagnostics.text, /routerRunning: true/);
  assert.match(diagnostics.text, /bypassSystemProxy: true/);
  assert.match(diagnostics.text, /autoSelectModel: false/);
  assert.match(diagnostics.text, /autoFailover: false/);
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
  fs.mkdirSync(path.join(homeDir, ".codex", "skills", "demo"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".codex", "skills", "demo", "SKILL.md"), "# Demo\nUse when testing diagnostics.\n", "utf8");
  fs.writeFileSync(
    path.join(homeDir, ".codex", "config.toml"),
    [
      '[mcp_servers.node_repl]',
      'command = "C:/Codex/node_repl.exe"',
      "",
      '[plugins."disabled@personal"]',
      "enabled = false",
      "",
    ].join("\n"),
    "utf8",
  );
  saveDesktopOptions(rootDir, { bypassSystemProxy: true });
  saveImageProvider(rootDir, {
    id: "siliconflow-kolors",
    name: "硅基流动 Kolors",
    adapter: "siliconflow_images",
    baseUrl: "https://api.siliconflow.cn/v1",
    endpoint: "/images/generations",
    model: "Kwai-Kolors/Kolors",
    apiKeyEnv: "SILICONFLOW_API_KEY",
    makeDefault: true,
  });
  saveImageProviderTestResult(rootDir, "siliconflow-kolors", {
    ok: false,
    message: "API Key 不正确或没有权限。",
  });

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
          imageGeneration: {
            mode: "provider",
            providerId: "siliconflow-kolors",
          },
        },
      ],
    },
    logs: [
      "[2026-06-29T10:00:00.000Z] req_tool123 tool_diag route=deepseek-v4-pro mode=chat-compat tools=3 chat_tools=2 suppressed=1 namespaces=2 namespace_names=mcp__figma__,mcp__node_repl__ node_repl=true command=false apply_patch=true tool_choice=auto sk-tool-secret",
      "[2026-06-29T10:00:01.000Z] req_tool456 tool_return_diag route=deepseek-v4-pro mode=chat-compat returned_tools=2 runnable_tools=1 suppressed_tools=1 unknown_tools=1 namespaces=1 namespace_names=mcp__figma__ node_repl=false command=false apply_patch=false sk-return-secret",
      `[2026-06-29T10:00:02.000Z] req_decision_support route_trace ${JSON.stringify({
        traceVersion: "route-trace-v1",
        requestId: "req_decision_support",
        requestedModel: "cb-chat",
        route: { id: "cb-code", displayName: "GPT Code" },
        events: [
          {
            phase: "route_decision",
            details: {
              decisionVersion: "route-decision-v2",
              requestKind: "normal",
              reason: "code_task",
              requestedModel: "cb-chat",
              originalRoute: "cb-chat",
              selectedRoute: "cb-code",
              selectedUpstreamModel: "gpt-code",
              selectedApi: "chat_completions",
              changed: true,
              skippedRoutes: [
                { routeId: "cb-rate-limited", reason: "rate_limited", detail: "sk-route-secret" },
              ],
            },
          },
          {
            phase: "context_switch_compact",
            details: {
              fromRouteId: "cb-large",
              fromDisplayName: "DeepSeek Long",
              fromContextWindow: 1_000_000,
              toRouteId: "cb-code",
              toDisplayName: "GPT Code",
              toContextWindow: 2_048,
              estimatedTokens: 66_044,
              targetInputBudget: 1_331,
            },
          },
        ],
      })}`,
    ],
    homeDir,
    codexCliSnapshot: codexCliAuthoritySnapshot(),
    codexPromptInputSnapshot: codexPromptSkillsSnapshot(),
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
  assert.match(diagnostics.text, /responsesCompactRequestBodyLimitBytes: 200\.0 MB/);
  assert.match(diagnostics.text, /Proxy diagnostics/);
  assert.match(diagnostics.text, /HTTPS_PROXY: set http:\/\/127\.0\.0\.1:7890/);
  assert.match(diagnostics.text, /NO_PROXY: set localhost,127\.0\.0\.1/);
  assert.match(diagnostics.text, /Update diagnostics/);
  assert.match(diagnostics.text, new RegExp(escapeRegExp(updateDir)));
  assert.match(diagnostics.text, /Release preflight/);
  assert.match(diagnostics.text, /图片生成代理: fail/);
  assert.match(diagnostics.text, /硅基流动 Kolors 最近测试失败/);
  assert.match(diagnostics.text, /API Key 不正确或没有权限/);
  assert.match(diagnostics.text, /Image provider diagnostics/);
  assert.match(diagnostics.text, /defaultProviderId: siliconflow-kolors/);
  assert.match(diagnostics.text, /siliconflow-kolors: 硅基流动 Kolors/);
  assert.match(diagnostics.text, /adapter=siliconflow_images/);
  assert.match(diagnostics.text, /model=Kwai-Kolors\/Kolors/);
  assert.match(diagnostics.text, /size=1024x1024/);
  assert.match(diagnostics.text, /key=SILICONFLOW_API_KEY:missing/);
  assert.match(diagnostics.text, /lastTest=fail/);
  assert.match(diagnostics.text, /Codex resource diagnostics/);
  assert.match(diagnostics.text, /current: plugins=0, mcp=0, skills=0/);
  assert.match(diagnostics.text, /discoveredNotCurrent: plugins=1/);
  assert.match(diagnostics.text, /discoveredPlugin:disabled@personal status=warn label=未启用/);
  assert.equal(diagnostics.summary.releasePreflight.statusCounts.fail, 3);
  assert.equal(diagnostics.summary.imageProviders.providerCount, 1);
  assert.equal(diagnostics.summary.imageProviders.testedProviders, 1);
  assert.equal(diagnostics.summary.imageProviders.failedProviders, 1);
  assert.equal(diagnostics.summary.resources.current.mcpServers, 0);
  assert.equal(diagnostics.summary.resources.current.skills, 0);
  assert.equal(diagnostics.summary.resources.warnings, 2);
  assert.match(diagnostics.text, /Recent tool diagnostics/);
  assert.match(diagnostics.text, /tool_diag route=deepseek-v4-pro/);
  assert.match(diagnostics.text, /tool_return_diag route=deepseek-v4-pro/);
  assert.match(diagnostics.text, /namespace_names=mcp__figma__,mcp__node_repl__/);
  assert.match(diagnostics.text, /unknown_tools=1/);
  assert.match(diagnostics.text, /Recent route decisions/);
  assert.match(diagnostics.text, /req_decision_support: code_task cb-chat -> cb-code upstream=gpt-code api=chat_completions changed=true skipped=cb-rate-limited:rate_limited/);
  assert.match(diagnostics.text, /estimated=66044 budget=1331 context=1000000->2048/);
  assert.equal(diagnostics.summary.routeDecisionCount, 1);
  assert.doesNotMatch(diagnostics.text, / route_trace \{/);
  assert.equal(diagnostics.summary.unhealthyRoutes, 1);
  assert.equal(diagnostics.summary.usage.totalCalls, 2);
  assert.equal(diagnostics.summary.proxy.HTTPS_PROXY, "set");
  assert.doesNotMatch(diagnostics.text, /user:pass/);
  assert.doesNotMatch(diagnostics.text, /sk-sensitive-token/);
  assert.doesNotMatch(diagnostics.text, /sk-usage-secret/);
  assert.doesNotMatch(diagnostics.text, /sk-tool-secret/);
  assert.doesNotMatch(diagnostics.text, /sk-return-secret/);
  assert.doesNotMatch(diagnostics.text, /sk-route-secret/);
});

test("supportDiagnostics overall status includes release preflight failures", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  saveImageProvider(rootDir, {
    id: "broken-image",
    name: "测试生图供应商",
    adapter: "generic_template",
    baseUrl: "https://api.example.com/v1",
    endpoint: "/images/generations",
    model: "missing-image-model",
    apiKeyEnv: "IMAGE_TEST_KEY",
    makeDefault: true,
  });
  saveImageProviderTestResult(rootDir, "broken-image", {
    ok: false,
    message: "模型名错误或没有权限。",
  });

  const diagnostics = supportDiagnostics(rootDir, {
    appVersion: "0.2.3",
    routerRunning: true,
    homeDir,
    proxyEnv: {},
    lastHealth: {
      ok: true,
      models: ["gpt-5.5"],
      unhealthyRoutes: 0,
      routes: [
        {
          id: "gpt-5.5",
          status: "healthy",
          api: "responses",
          model: "gpt-5.5",
        },
      ],
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
          imageGeneration: {
            mode: "provider",
            providerId: "broken-image",
          },
        },
      ],
    },
    codexCliSnapshot: codexCliAuthoritySnapshot(),
    codexPromptInputSnapshot: codexPromptSkillsSnapshot(),
  });

  assert.equal(diagnostics.summary.releasePreflight.ok, false);
  assert.equal(diagnostics.summary.ok, false);
  assert.equal(diagnostics.summary.releasePreflight.releaseGate.blockedByFailures, true);
  assert.ok(diagnostics.summary.releasePreflight.releaseGate.failureItemIds.includes("image_generation_proxy"));
  assert.ok(diagnostics.summary.releasePreflight.releaseGate.blockingItemIds.includes("image_generation_proxy"));
  assert.ok(diagnostics.summary.releasePreflight.releaseGate.realEvidenceBlockingItemIds.includes("image_generation_proxy"));
  assert.equal(diagnostics.summary.releasePreflight.releaseGate.codeOrConfigOk, true);
  assert.match(diagnostics.text, /releaseGate: reason=failures/);
  assert.match(diagnostics.text, /releaseGate:[^\n]*codeOrConfigOk=true/);
  assert.match(diagnostics.text, /blockingItemIds=image_generation_proxy/);
  assert.match(diagnostics.text, /realEvidenceBlockingItemIds=image_generation_proxy/);
  assert.match(diagnostics.text, /localSetupBlockingItemIds=none/);
  assert.match(diagnostics.text, /codeOrConfigBlockingItemIds=none/);
});

test("supportDiagnostics includes strict release gate warning buckets", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-strict-diagnostics-"));

  const diagnostics = supportDiagnostics(rootDir, {
    appVersion: "0.2.4",
    platform: "win32",
    arch: "x64",
    homeDir,
    routerRunning: false,
    lastHealth: null,
    codexCliSnapshot: codexCliAuthoritySnapshot(),
    codexPromptInputSnapshot: codexPromptSkillsSnapshot(),
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
    codexCliSnapshot: codexCliAuthoritySnapshot(),
    codexPromptInputSnapshot: codexPromptSkillsSnapshot(),
  });

  assert.equal(diagnostics.summary.releasePreflight.releaseGate.reason, "ok");
  assert.equal(diagnostics.summary.releasePreflight.strictReleaseGate.reason, "strict_warnings");
  assert.equal(diagnostics.summary.releasePreflight.strictReleaseGate.blockedByWarnings, true);
  assert.ok(diagnostics.summary.releasePreflight.strictReleaseGate.realEvidenceBlockingItemIds.includes("router"));
  assert.ok(diagnostics.summary.releasePreflight.strictReleaseGate.realEvidenceBlockingItemIds.includes("update_flow"));
  assert.ok(diagnostics.summary.releasePreflight.strictReleaseGate.localSetupBlockingItemIds.includes("codex_config"));
  assert.match(diagnostics.text, /strictReleaseGate: reason=strict_warnings/);
  assert.match(diagnostics.text, /strictReleaseGate:[^\n]*realEvidenceBlockingItemIds=.*router.*update_flow/);
  assert.match(diagnostics.text, /strictReleaseGate:[^\n]*localSetupBlockingItemIds=.*codex_config/);
});

test("supportDiagnostics includes local code-ready release handoff", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-code-ready-diagnostics-"));

  const diagnostics = supportDiagnostics(rootDir, {
    appVersion: "0.2.4",
    platform: "win32",
    arch: "x64",
    homeDir,
    routerRunning: false,
    lastHealth: null,
    codexCliSnapshot: codexCliAuthoritySnapshot(),
    codexPromptInputSnapshot: codexPromptSkillsSnapshot(),
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

  assert.equal(diagnostics.summary.releasePreflight.codeReady.ok, true);
  assert.equal(diagnostics.summary.releasePreflight.codeReady.codeOrConfigOk, true);
  assert.deepEqual(diagnostics.summary.releasePreflight.codeReady.codeOrConfigBlockingItemIds, []);
  assert.ok(diagnostics.summary.releasePreflight.codeReady.ignoredRealEvidenceItemIds.includes("router"));
  assert.ok(diagnostics.summary.releasePreflight.codeReady.ignoredRealEvidenceItemIds.includes("update_flow"));
  assert.ok(diagnostics.summary.releasePreflight.codeReady.ignoredLocalSetupItemIds.includes("codex_config"));
  assert.match(diagnostics.text, /codeReady: ok=true/);
  assert.match(diagnostics.text, /codeReady:[^\n]*ignoredRealEvidenceItemIds=.*router.*update_flow/);
  assert.match(diagnostics.text, /codeReady:[^\n]*ignoredLocalSetupItemIds=.*codex_config/);
  assert.match(diagnostics.text, /codeReady:[^\n]*codeOrConfigBlockingItemIds=none/);
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
  const fakeProgramFiles = path.join(rootDir, "Program Files x86");
  const fakeNsis = path.join(fakeProgramFiles, "NSIS");
  fs.mkdirSync(fakeNsis, { recursive: true });
  fs.writeFileSync(path.join(fakeNsis, "makensis.exe"), "");

  const check = buildStartupCheck(rootDir, {
    homeDir,
    appVersion: "0.1.200",
    routerRunning: false,
    lastHealth: null,
    codexCliSnapshot: codexCliAuthoritySnapshot(),
    codexPromptInputSnapshot: codexPromptSkillsSnapshot(),
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
    toolEnv: {
      "ProgramFiles(x86)": fakeProgramFiles,
      PATH: "",
      Path: "",
    },
    platform: "win32",
    arch: "x64",
  });

  assert.equal(check.summary.ok, false);
  assert.equal(check.summary.pass, 15);
  assert.equal(check.summary.warn, 5);
  assert.equal(check.summary.fail, 1);
  assert.equal(check.items.find((item) => item.id === "codex_config").status, "pass");
  assert.equal(check.items.find((item) => item.id === "router").status, "warn");
  assert.equal(check.items.find((item) => item.id === "route_health").status, "warn");
  assert.equal(check.items.find((item) => item.id === "image_generation_proxy").status, "warn");
  const capabilityProviderItem = check.items.find((item) => item.id === "capability_providers");
  assert.equal(capabilityProviderItem.status, "pass");
  assert.match(capabilityProviderItem.detail, /未配置实验能力供应商/);
  assert.match(capabilityProviderItem.action, /能力页添加实验供应商/);
  assert.equal(check.items.find((item) => item.id === "real_environment_acceptance").status, "warn");
  assert.equal(check.items.find((item) => item.id === "codex_resources").status, "warn");
  assert.equal(check.items.find((item) => item.id === "codex_sessions").status, "pass");
  assert.equal(check.items.find((item) => item.id === "plugin_runtime").status, "pass");
  assert.equal(check.items.find((item) => item.id === "model_directory").status, "pass");
  assert.equal(check.items.find((item) => item.id === "model_references").status, "pass");
  assert.equal(check.items.find((item) => item.id === "delete_safety").status, "pass");
  assert.equal(check.items.find((item) => item.id === "update_flow").status, "pass");
  assert.equal(check.items.find((item) => item.id === "api_keys").status, "pass");
  assert.equal(check.items.find((item) => item.id === "codex_desktop").status, "fail");
  assert.match(check.items.find((item) => item.id === "proxy").detail, /HTTPS_PROXY/);
  assert.equal(check.items.find((item) => item.id === "backups").count, 1);
  assert.equal(check.items.find((item) => item.id === "codex_config").label, "Codex 配置");
  assert.equal(check.items.find((item) => item.id === "model_catalog").label, "模型目录");
  assert.equal(check.items.find((item) => item.id === "api_keys").label, "API Key");
  assert.doesNotMatch(JSON.stringify(check.items), /Model catalog|Start Router|No proxy environment/i);
});

test("startup check reports a malformed CodexBridge managed TOML block as a failure", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-invalid-managed-toml-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    '# >>> CodexBridge managed config\nmodel = "cb-stale"\n',
    "utf8",
  );

  const check = buildStartupCheck(rootDir, {
    homeDir,
    config: { port: 15722, models: [] },
    codexCliSnapshot: codexCliAuthoritySnapshot(),
    codexPromptInputSnapshot: codexPromptSkillsSnapshot(),
  });
  const item = check.items.find((entry) => entry.id === "codex_config");

  assert.equal(item.status, "fail");
  assert.match(item.detail, /CodexBridge.*(?:不完整|损坏|无效)/);
  assert.match(item.action, /启动 Router.*自动修复|自动修复.*启动 Router/);
  assert.equal(check.summary.ok, false);
  assert.ok(check.summary.fail >= 1);
});

test("startup check accepts discoverable Codex Desktop shortcuts without a saved launch target", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const fakeProfile = path.join(homeDir, "Users", "Tester");
  const fakeDesktop = path.join(fakeProfile, "Desktop");
  fs.mkdirSync(fakeDesktop, { recursive: true });
  const shortcutPath = path.join(fakeDesktop, "Codex.lnk");
  const desktopTarget = path.join(fakeProfile, "Apps", "Codex.exe");
  fs.mkdirSync(path.dirname(desktopTarget), { recursive: true });
  fs.writeFileSync(shortcutPath, "shortcut placeholder", "utf8");
  fs.writeFileSync(desktopTarget, "desktop fixture", "utf8");

  const check = buildStartupCheck(rootDir, {
    homeDir,
    config: { port: 15722, models: [] },
    platform: "win32",
    toolEnv: {
      USERPROFILE: fakeProfile,
      APPDATA: path.join(fakeProfile, "AppData", "Roaming"),
      ProgramData: path.join(rootDir, "ProgramData"),
      PUBLIC: path.join(rootDir, "Public"),
      LOCALAPPDATA: path.join(fakeProfile, "AppData", "Local"),
      PATH: "",
      Path: "",
    },
    codexDesktopLocatorOptions: {
      resolveShortcut: (candidate) => candidate === shortcutPath ? { targetPath: desktopTarget } : null,
    },
  });

  const codexDesktop = check.items.find((item) => item.id === "codex_desktop");
  assert.equal(codexDesktop.status, "pass");
  assert.equal(codexDesktop.detail, desktopTarget);
});

test("startup check rejects an existing ChatGPT shortcut that resolves to a browser", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-desktop-invalid-shortcut-"));
  const shortcutPath = path.join(homeDir, "Desktop", "ChatGPT.lnk");
  const chromeTarget = path.join(homeDir, "Chrome", "chrome.exe");
  fs.mkdirSync(path.dirname(shortcutPath), { recursive: true });
  fs.mkdirSync(path.dirname(chromeTarget), { recursive: true });
  fs.writeFileSync(shortcutPath, "shortcut placeholder", "utf8");
  fs.writeFileSync(chromeTarget, "browser fixture", "utf8");

  const check = buildStartupCheck(rootDir, {
    homeDir,
    config: { port: 15722, models: [] },
    platform: "win32",
    toolEnv: { USERPROFILE: homeDir, PATH: "", Path: "" },
    codexCliSnapshot: codexCliAuthoritySnapshot(),
    codexPromptInputSnapshot: codexPromptSkillsSnapshot(),
    codexDesktopLocatorOptions: {
      resolveShortcut: () => ({ targetPath: chromeTarget, arguments: "https://chatgpt.com" }),
    },
  });
  const desktop = check.items.find((item) => item.id === "codex_desktop");

  assert.equal(desktop.status, "warn");
  assert.doesNotMatch(desktop.detail, /ChatGPT\.lnk/);
});

test("startup check discovers Codex Start Menu shortcuts from homeDir when env is incomplete", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const shortcutDir = path.join(
    homeDir,
    "AppData",
    "Roaming",
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "OpenAI",
  );
  fs.mkdirSync(shortcutDir, { recursive: true });
  const shortcutPath = path.join(shortcutDir, "Codex.lnk");
  const desktopTarget = path.join(homeDir, "Apps", "Codex.exe");
  fs.mkdirSync(path.dirname(desktopTarget), { recursive: true });
  fs.writeFileSync(shortcutPath, "shortcut placeholder", "utf8");
  fs.writeFileSync(desktopTarget, "desktop fixture", "utf8");

  const check = buildStartupCheck(rootDir, {
    homeDir,
    config: { port: 15722, models: [] },
    platform: "win32",
    toolEnv: {
      PATH: "",
      Path: "",
    },
    codexDesktopLocatorOptions: {
      resolveShortcut: (candidate) => candidate === shortcutPath ? { targetPath: desktopTarget } : null,
    },
  });

  const codexDesktop = check.items.find((item) => item.id === "codex_desktop");
  assert.equal(codexDesktop.status, "pass");
  assert.equal(codexDesktop.detail, desktopTarget);
});

test("startup check accepts the WindowsApps Codex alias without a saved launch target", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const fakeProfile = path.join(homeDir, "Users", "Tester");
  const fakeLocalAppData = path.join(fakeProfile, "AppData", "Local");
  const aliasPath = path.join(fakeLocalAppData, "Microsoft", "WindowsApps", "Codex.exe");
  fs.mkdirSync(path.dirname(aliasPath), { recursive: true });
  fs.writeFileSync(aliasPath, "app execution alias", "utf8");

  const check = buildStartupCheck(rootDir, {
    homeDir,
    config: { port: 15722, models: [] },
    platform: "win32",
    toolEnv: {
      USERPROFILE: fakeProfile,
      APPDATA: path.join(fakeProfile, "AppData", "Roaming"),
      ProgramData: path.join(rootDir, "ProgramData"),
      PUBLIC: path.join(rootDir, "Public"),
      LOCALAPPDATA: fakeLocalAppData,
      PATH: "",
      Path: "",
    },
  });

  const codexDesktop = check.items.find((item) => item.id === "codex_desktop");
  assert.equal(codexDesktop.status, "pass");
  assert.equal(codexDesktop.detail, aliasPath);
});

test("startup check prefers the unified ChatGPT shortcut while retaining legacy Codex", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-desktop-shortcut-"));
  const shortcutDir = path.join(homeDir, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "OpenAI");
  fs.mkdirSync(shortcutDir, { recursive: true });
  const chatgptShortcut = path.join(shortcutDir, "ChatGPT.lnk");
  const chatgptTarget = path.join(homeDir, "Apps", "ChatGPT.exe");
  fs.mkdirSync(path.dirname(chatgptTarget), { recursive: true });
  fs.writeFileSync(chatgptShortcut, "shortcut placeholder", "utf8");
  fs.writeFileSync(path.join(shortcutDir, "Codex.lnk"), "legacy shortcut placeholder", "utf8");
  fs.writeFileSync(chatgptTarget, "desktop fixture", "utf8");

  const check = buildStartupCheck(rootDir, {
    homeDir,
    config: { port: 15722, models: [] },
    platform: "win32",
    toolEnv: { PATH: "", Path: "" },
    codexCliSnapshot: codexCliAuthoritySnapshot(),
    codexPromptInputSnapshot: codexPromptSkillsSnapshot(),
    codexDesktopLocatorOptions: {
      resolveShortcut: (candidate) => candidate === chatgptShortcut ? { targetPath: chatgptTarget } : null,
    },
  });
  const desktop = check.items.find((item) => item.id === "codex_desktop");

  assert.equal(desktop.label, "ChatGPT / Codex");
  assert.equal(desktop.status, "pass");
  assert.equal(desktop.detail, chatgptTarget);
  assert.match(desktop.action, /ChatGPT\.exe|Codex\.exe/);
});

test("startup check accepts a validated official Store shortcut", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-desktop-store-shortcut-"));
  const shortcutPath = path.join(homeDir, "Desktop", "ChatGPT.lnk");
  const storeTarget = "shell:AppsFolder\\OpenAI.ChatGPT_2p2nqsd0c76g0!App";
  fs.mkdirSync(path.dirname(shortcutPath), { recursive: true });
  fs.writeFileSync(shortcutPath, "shortcut placeholder", "utf8");

  const check = buildStartupCheck(rootDir, {
    homeDir,
    config: { port: 15722, models: [] },
    platform: "win32",
    toolEnv: { USERPROFILE: homeDir, PATH: "", Path: "" },
    codexCliSnapshot: codexCliAuthoritySnapshot(),
    codexPromptInputSnapshot: codexPromptSkillsSnapshot(),
    codexDesktopLocatorOptions: {
      resolveShortcut: () => ({
        targetPath: "C:\\Windows\\explorer.exe",
        arguments: storeTarget,
      }),
      resolveStoreInstall: () => "C:\\Store\\ChatGPT",
    },
  });
  const desktop = check.items.find((item) => item.id === "codex_desktop");

  assert.equal(desktop.status, "pass");
  assert.equal(desktop.detail, storeTarget);
});

test("startup check accepts the unified ChatGPT Windows app alias", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-desktop-alias-"));
  const localAppData = path.join(homeDir, "AppData", "Local");
  const aliasPath = path.join(localAppData, "Microsoft", "WindowsApps", "ChatGPT.exe");
  fs.mkdirSync(path.dirname(aliasPath), { recursive: true });
  fs.writeFileSync(aliasPath, "app execution alias", "utf8");

  const check = buildStartupCheck(rootDir, {
    homeDir,
    config: { port: 15722, models: [] },
    platform: "win32",
    toolEnv: { USERPROFILE: homeDir, LOCALAPPDATA: localAppData, PATH: "", Path: "" },
    codexCliSnapshot: codexCliAuthoritySnapshot(),
    codexPromptInputSnapshot: codexPromptSkillsSnapshot(),
  });
  const desktop = check.items.find((item) => item.id === "codex_desktop");

  assert.equal(desktop.status, "pass");
  assert.equal(desktop.detail, aliasPath);
});

test("startup check excludes ChatGPT Classic and CodexBridge launch targets", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-desktop-exclusions-"));
  const shortcutDir = path.join(homeDir, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs");
  fs.mkdirSync(shortcutDir, { recursive: true });
  const classicPath = path.join(shortcutDir, "ChatGPT Classic.lnk");
  const bridgePath = path.join(shortcutDir, "CodexBridge.lnk");
  fs.writeFileSync(classicPath, "classic shortcut", "utf8");
  fs.writeFileSync(bridgePath, "bridge shortcut", "utf8");

  const check = buildStartupCheck(rootDir, {
    homeDir,
    config: { port: 15722, models: [] },
    platform: "win32",
    toolEnv: { USERPROFILE: homeDir, APPDATA: path.join(homeDir, "AppData", "Roaming"), PATH: "", Path: "" },
    codexCliSnapshot: codexCliAuthoritySnapshot(),
    codexPromptInputSnapshot: codexPromptSkillsSnapshot(),
  });
  const desktop = check.items.find((item) => item.id === "codex_desktop");

  assert.equal(desktop.status, "warn");
  assert.doesNotMatch(desktop.detail, /ChatGPT Classic|CodexBridge/);
});

test("startup check accepts a unified ChatGPT macOS application bundle", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-desktop-macos-"));
  const appPath = path.posix.join(homeDir.replaceAll("\\", "/"), "Applications", "ChatGPT.app");
  fs.mkdirSync(appPath, { recursive: true });

  const check = buildStartupCheck(rootDir, {
    homeDir,
    config: { port: 15722, models: [] },
    platform: "darwin",
    toolEnv: { CHATGPT_DESKTOP_APP: appPath },
    codexCliSnapshot: codexCliAuthoritySnapshot(),
    codexPromptInputSnapshot: codexPromptSkillsSnapshot(),
  });
  const desktop = check.items.find((item) => item.id === "codex_desktop");

  assert.equal(desktop.label, "ChatGPT / Codex");
  assert.equal(desktop.status, "pass");
  assert.equal(desktop.detail, appPath);
});

test("startup check reports stale model references as a user-visible warning", () => {
  const rootDir = makeTempProject();
  fs.mkdirSync(path.join(rootDir, "config"), { recursive: true });
  fs.writeFileSync(
    modelDirectoryPath(rootDir),
    JSON.stringify({
      version: 1,
      providers: {
        "kimi-code": {
          providerId: "kimi-code",
          providerName: "Kimi Code",
          baseUrl: "https://api.kimi.com/coding/v1",
          models: [{ id: "kimi-for-coding" }],
        },
      },
    }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    selectionPath(rootDir),
    JSON.stringify({ selectedModelIds: ["kimi-code-k3"] }, null, 2),
    "utf8",
  );
  saveDesktopOptions(rootDir, {
    codexAuxiliaryModelId: "cb-kimi-code-k3",
  });

  const check = buildStartupCheck(rootDir, {
    config: { mode: MODE_HYBRID, models: [] },
  });
  const item = check.items.find((entry) => entry.id === "model_references");

  assert.equal(item.status, "warn");
  assert.equal(item.count, 2);
  assert.match(item.detail, /2/);
  assert.match(item.action, /修复失效模型引用/);
});

test("release preflight surfaces packaged app smoke evidence", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const packagedSmokeReport = {
    ok: true,
    checkedAt: "2026-07-05T07:10:00.000Z",
    appPath: "F:\\game_code\\router\\release\\CodexBridge-Windows-x64-Portable-v0.2.3-local\\CodexBridge-win32-x64",
    exePath: "F:\\game_code\\router\\release\\CodexBridge-Windows-x64-Portable-v0.2.3-local\\CodexBridge-win32-x64\\CodexBridge.exe",
    desktopSmoke: { ok: true, durationMs: 1200 },
    routerSmoke: { ok: true, durationMs: 900, models: ["gpt-5.5"] },
  };

  const check = buildStartupCheck(rootDir, {
    homeDir,
    appVersion: "0.2.3",
    packagedSmokeReport,
  });
  const item = check.items.find((entry) => entry.id === "packaged_app_smoke");

  assert.ok(item, "expected packaged_app_smoke preflight item");
  assert.equal(item.status, "pass");
  assert.match(item.detail, /CodexBridge\.exe/);
  assert.match(item.detail, /桌面 smoke/);
  assert.match(item.detail, /Router health smoke/);
  assert.equal(item.count, 2);
});

test("release preflight checks config package portability without secrets", () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, {
    DEEPSEEK_API_KEY: "sk-should-not-export",
  });
  saveSelection(rootDir, ["deepseek-v4-pro"], MODE_HYBRID);
  saveDesktopOptions(rootDir, {
    routerPort: 15988,
    usageBudgets: {
      global: {
        dailyTokenLimit: 100000,
      },
      providers: {
        deepseek: {
          outputCostPerMillion: 2.25,
        },
      },
    },
    codexDesktopExe: "C:\\Users\\Administrator\\AppData\\Local\\Microsoft\\WindowsApps\\Codex.exe",
    codexDesktopLaunchTarget: "C:\\Users\\Administrator\\Desktop\\Codex.lnk",
  });
  saveImageProvider(rootDir, {
    id: "siliconflow-kolors",
    name: "硅基流动 Kolors",
    adapter: "siliconflow_images",
    baseUrl: "https://api.siliconflow.cn/v1",
    endpoint: "/images/generations",
    model: "Kwai-Kolors/Kolors",
    apiKeyEnv: "SILICONFLOW_API_KEY",
    makeDefault: true,
  });
  saveImageProviderTestResult(rootDir, "siliconflow-kolors", {
    ok: true,
    localPath: "C:\\Users\\Administrator\\Pictures\\generated-images\\sample.png",
  });
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-preflight-package-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(path.join(codexDir, "skills", "demo"), { recursive: true });
  fs.writeFileSync(path.join(codexDir, "skills", "demo", "SKILL.md"), "# Demo\nUse when testing portable resources.\n", "utf8");
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    [
      "[mcp_servers.node_repl]",
      'command = "C:/Codex/node_repl.exe"',
      '[plugins."github@openai-curated-remote"]',
      "enabled = true",
    ].join("\n"),
    "utf8",
  );

  const check = buildStartupCheck(rootDir, {
    homeDir,
    routerRunning: true,
    lastHealth: { ok: true, models: [], unhealthyRoutes: 0, routes: [] },
    config: { models: [] },
    platform: "win32",
    arch: "x64",
    codexCliSnapshot: codexCliAuthoritySnapshot(),
    codexPromptInputSnapshot: codexPromptSkillsSnapshot([{
      name: "demo",
      description: "Use when testing local skills.",
      path: path.join(codexDir, "skills", "demo", "SKILL.md"),
    }]),
    codexAppServerSnapshot: {
      apps: { ok: true, items: [] },
      skills: {
        ok: true,
        items: [{
          name: "demo",
          path: path.join(codexDir, "skills", "demo", "SKILL.md"),
          scope: "user",
          enabled: true,
        }],
      },
    },
  });
  const configPackage = check.items.find((item) => item.id === "config_package");
  const serialized = JSON.stringify(configPackage);

  assert.equal(configPackage.status, "pass");
  assert.match(configPackage.detail, /配置包/);
  assert.match(configPackage.detail, /API Key 不会写进配置包/);
  assert.match(configPackage.detail, /需要重填 2 个 Key/);
  assert.doesNotMatch(configPackage.detail, /DEEPSEEK_API_KEY|SILICONFLOW_API_KEY/);
  assert.match(configPackage.action, /导出|迁移/);
  assert.match(configPackage.action, /重填|重新填写/);
  assert.doesNotMatch(serialized, /sk-should-not-export/);
  assert.doesNotMatch(serialized, /secrets\.local|Codex\.lnk|node_repl\.exe|generated-images|sample\.png|Administrator/);
});

test("release preflight warns when provider model directory cache is stale", () => {
  const rootDir = makeTempProject();
  const directoryPath = modelDirectoryPath(rootDir);
  fs.mkdirSync(path.dirname(directoryPath), { recursive: true });
  fs.writeFileSync(
    directoryPath,
    JSON.stringify({
      version: 1,
      providers: {
        deepseek: {
          providerId: "deepseek",
          providerName: "DeepSeek",
          baseUrl: "https://api.deepseek.com/v1",
          fetchedAt: "2000-01-01T00:00:00.000Z",
          models: [{ id: "deepseek-v4-pro" }],
        },
      },
    }, null, 2),
    "utf8",
  );

  const item = buildStartupCheck(rootDir, {
    routerRunning: true,
    lastHealth: { ok: true, models: [], unhealthyRoutes: 0, routes: [] },
    config: { models: [] },
  }).items.find((entry) => entry.id === "model_directory");

  assert.ok(item, "expected a model_directory preflight item");
  assert.equal(item.status, "warn");
  assert.match(item.label, /模型列表/);
  assert.match(item.detail, /DeepSeek/);
  assert.match(item.detail, /过期|超过 7 天|重新同步/);
  assert.match(item.action, /同步模型列表/);
});

test("release preflight explains saved model selection when router config is missing", () => {
  const rootDir = makeTempProject();
  saveSelection(rootDir, ["deepseek-v4-pro", "kimi-k2-7-code"], MODE_HYBRID);

  const modelCatalog = buildStartupCheck(rootDir, {
    homeDir: fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-no-router-config-")),
    config: { models: [] },
  }).items.find((item) => item.id === "model_catalog");

  assert.equal(modelCatalog.status, "warn");
  assert.equal(modelCatalog.count, 0);
  assert.match(modelCatalog.detail, /已保存 2 个模型选择/);
  assert.match(modelCatalog.detail, /路由配置还没有生成/);
  assert.match(modelCatalog.action, /保存模型选择|启动 Router/);
});

test("release preflight explains default model selection when router config is missing", () => {
  const rootDir = makeTempProject();

  const modelCatalog = buildStartupCheck(rootDir, {
    homeDir: fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-no-router-config-")),
    config: null,
  }).items.find((item) => item.id === "model_catalog");

  assert.equal(modelCatalog.status, "warn");
  assert.equal(modelCatalog.count, 0);
  assert.match(modelCatalog.detail, /当前默认模型选择 5 个/);
  assert.match(modelCatalog.detail, /路由配置还没有生成/);
  assert.match(modelCatalog.action, /保存模型选择|启动 Router/);
});

test("release preflight calls out experimental smart routing switches", () => {
  const rootDir = makeTempProject();

  const disabled = buildStartupCheck(rootDir, {
    routerRunning: true,
    lastHealth: { ok: true, models: [], unhealthyRoutes: 0, routes: [] },
    config: {
      models: [],
      smartRouting: {
        autoSelectModel: false,
        autoFailover: false,
      },
    },
  }).items.find((item) => item.id === "smart_routing");
  assert.equal(disabled.status, "pass");
  assert.match(disabled.detail, /自动选模/);
  assert.match(disabled.detail, /关闭/);

  const enabled = buildStartupCheck(rootDir, {
    routerRunning: true,
    lastHealth: { ok: true, models: [], unhealthyRoutes: 0, routes: [] },
    config: {
      models: [],
      smartRouting: {
        autoSelectModel: true,
        autoFailover: true,
      },
    },
  }).items.find((item) => item.id === "smart_routing");
  assert.equal(enabled.status, "warn");
  assert.equal(enabled.count, 2);
  assert.match(enabled.detail, /自动选模/);
  assert.match(enabled.detail, /失败自动切换/);
  assert.match(enabled.action, /默认关闭|发布/);
});

test("release preflight surfaces usage budget controls", () => {
  const rootDir = makeTempProject();

  const empty = buildStartupCheck(rootDir, {
    routerRunning: true,
    lastHealth: { ok: true, models: [], unhealthyRoutes: 0, routes: [] },
    config: {
      models: [],
      usageBudgets: {},
    },
  }).items.find((item) => item.id === "usage_budget");
  assert.ok(empty, "expected a usage_budget preflight item");
  assert.equal(empty.status, "pass");
  assert.equal(empty.count, 0);
  assert.match(empty.detail, /未设置|未配置/);

  const costOnly = buildStartupCheck(rootDir, {
    routerRunning: true,
    lastHealth: { ok: true, models: [], unhealthyRoutes: 0, routes: [] },
    config: {
      models: [],
      usageBudgets: {
        providers: {
          deepseek: {
            inputCostPerMillion: 1.25,
            outputCostPerMillion: 2.5,
          },
        },
      },
    },
  }).items.find((item) => item.id === "usage_budget");
  assert.ok(costOnly, "expected a cost-only usage_budget preflight item");
  assert.equal(costOnly.status, "pass");
  assert.equal(costOnly.count, 1);
  assert.match(costOnly.detail, /费用估算/);
  assert.match(costOnly.detail, /deepseek/);
  assert.match(costOnly.action, /每日上限/);

  const configured = buildStartupCheck(rootDir, {
    routerRunning: true,
    lastHealth: { ok: true, models: [], unhealthyRoutes: 0, routes: [] },
    config: {
      models: [],
      usageBudgets: {
        global: {
          dailyTokenLimit: 100000,
          dailyCallLimit: 50,
        },
        routes: {
          "cb-deepseek-v4-pro": {
            dailyTokenLimit: 50000,
          },
        },
        providers: {
          deepseek: {
            dailyCallLimit: 20,
          },
        },
      },
    },
  }).items.find((item) => item.id === "usage_budget");

  assert.ok(configured, "expected a configured usage_budget preflight item");
  assert.equal(configured.status, "pass");
  assert.equal(configured.count, 3);
  assert.match(configured.detail, /全局/);
  assert.match(configured.detail, /cb-deepseek-v4-pro/);
  assert.match(configured.detail, /deepseek/);
  assert.match(configured.action, /每日上限|预算/);
});

test("release preflight flags route health and image generation proxy readiness", () => {
  const rootDir = makeTempProject();
  saveImageProvider(rootDir, {
    id: "siliconflow-kolors",
    name: "硅基流动 Kolors",
    adapter: "siliconflow_images",
    baseUrl: "https://api.siliconflow.cn/v1",
    endpoint: "/images/generations",
    model: "Kwai-Kolors/Kolors",
    apiKeyEnv: "SILICONFLOW_API_KEY",
    makeDefault: true,
  });
  saveImageProviderTestResult(rootDir, "siliconflow-kolors", {
    ok: true,
    durationMs: 1200,
    localPath: "C:\\CodexBridge\\generated-images\\sample.png",
  });

  const check = buildStartupCheck(rootDir, {
    routerRunning: true,
    lastHealth: {
      ok: true,
      models: [{ id: "deepseek" }],
      unhealthyRoutes: 0,
      routes: [
        {
          id: "deepseek",
          status: "healthy",
          model: "deepseek-v4",
          api: "chat_completions",
        },
      ],
    },
    config: {
      port: 15999,
      models: [
        {
          id: "deepseek",
          displayName: "DeepSeek",
          api: "chat_completions",
          baseUrl: "https://api.deepseek.com/v1",
          model: "deepseek-v4",
          authMode: "codex_openai",
          imageGeneration: {
            mode: "provider",
            providerId: "siliconflow-kolors",
          },
        },
      ],
    },
  });

  const routeHealth = check.items.find((item) => item.id === "route_health");
  const imageProxy = check.items.find((item) => item.id === "image_generation_proxy");
  assert.equal(routeHealth.status, "pass");
  assert.equal(routeHealth.count, 0);
  assert.equal(imageProxy.status, "pass");
  assert.equal(imageProxy.count, 1);
  assert.match(imageProxy.detail, /硅基流动 Kolors/);
  assert.match(imageProxy.detail, /最近测试通过|1200ms/);
});

test("user-facing startup route health explains how to start Router without release vocabulary", () => {
  const rootDir = makeTempProject();
  const routeHealth = buildStartupCheck(rootDir, {
    routerRunning: false,
    lastHealth: null,
    config: {
      models: [
        {
          id: "deepseek",
          displayName: "DeepSeek",
          api: "chat_completions",
          baseUrl: "https://api.deepseek.com/v1",
          model: "deepseek-v4",
          authMode: "codex_openai",
        },
      ],
    },
  }).items.find((item) => item.id === "route_health");

  assert.ok(routeHealth, "expected route_health preflight item");
  assert.equal(routeHealth.status, "warn");
  assert.doesNotMatch(
    `${routeHealth.detail}\n${routeHealth.action}`,
    /发布前|正式发包|安装包目录|NSIS|makensis|验收目录/,
  );
  assert.equal(routeHealth.detail, "Router 还没有启动，启动后才能检查模型线路是否可用。");
  assert.equal(routeHealth.action, "请回到“概览”启动 Router；启动成功后再点“重新体检”。");
});

test("release preflight checks Windows update installer and portable assets", () => {
  const rootDir = makeTempProject();
  const baseOptions = {
    platform: "win32",
    arch: "x64",
    routerRunning: true,
    lastHealth: {
      ok: true,
      models: [],
      unhealthyRoutes: 0,
      routes: [],
    },
    config: {
      models: [],
    },
  };

  const missingInstaller = buildStartupCheck(rootDir, {
    ...baseOptions,
    releaseAssets: ["CodexBridge-Windows-x64-Portable.zip"],
  }).items.find((item) => item.id === "update_flow");

  assert.equal(missingInstaller.status, "fail");
  assert.match(missingInstaller.detail, /CodexBridge-Windows-x64-Setup\.exe/);
  assert.match(missingInstaller.detail, /安装版不能只发 zip/);
  assert.match(missingInstaller.action, /Setup\.exe|安装包/);

  const ready = buildStartupCheck(rootDir, {
    ...baseOptions,
    releaseAssets: [
      "CodexBridge-Windows-x64-Setup.exe",
      "CodexBridge-Windows-x64-Portable.zip",
    ],
  }).items.find((item) => item.id === "update_flow");

  assert.equal(ready.status, "pass");
  assert.match(ready.detail, /Setup\.exe/);
  assert.match(ready.detail, /Portable\.zip/);
  assert.match(ready.detail, /安装脚本/);
  assert.match(ready.detail, /桌面图标/);
  assert.match(ready.detail, /启动新版/);
  assert.match(ready.detail, /清理安装包/);

  const emptyArtifact = buildStartupCheck(rootDir, {
    ...baseOptions,
    releaseAssets: [
      { name: "CodexBridge-Windows-x64-Setup.exe", size: 0 },
      { name: "CodexBridge-Windows-x64-Portable.zip", size: 1024 },
    ],
  }).items.find((item) => item.id === "update_flow");

  assert.equal(emptyArtifact.status, "fail");
  assert.match(emptyArtifact.detail, /空文件|大小异常|0 B/);
  assert.match(emptyArtifact.detail, /CodexBridge-Windows-x64-Setup\.exe/);

  const invalidFormat = buildStartupCheck(rootDir, {
    ...baseOptions,
    releaseAssets: [
      { name: "CodexBridge-Windows-x64-Setup.exe", size: 1024, headerHex: "6e6f742d" },
      { name: "CodexBridge-Windows-x64-Portable.zip", size: 1024, headerHex: "6e6f742d" },
    ],
  }).items.find((item) => item.id === "update_flow");

  assert.equal(invalidFormat.status, "fail");
  assert.match(invalidFormat.detail, /文件头|格式/);
  assert.match(invalidFormat.detail, /Windows EXE|ZIP/);
  assert.match(invalidFormat.detail, /CodexBridge-Windows-x64-Setup\.exe/);
  assert.match(invalidFormat.detail, /CodexBridge-Windows-x64-Portable\.zip/);

  const legacyNames = buildStartupCheck(rootDir, {
    ...baseOptions,
    releaseAssets: [
      "CodexBridge-Windows-x64-Setup.exe",
      "CodexBridge-Windows-x64-Portable.zip",
      "CodexBridge-windows-portable.zip",
      "CodexBridge-Windows-x64-Portable-v0.2.0.zip",
    ],
  }).items.find((item) => item.id === "update_flow");

  assert.equal(legacyNames.status, "fail");
  assert.match(legacyNames.detail, /旧命名|混淆/);
  assert.match(legacyNames.detail, /CodexBridge-windows-portable\.zip/);
  assert.match(legacyNames.detail, /CodexBridge-Windows-x64-Portable-v0\.2\.0\.zip/);
  assert.match(legacyNames.action, /只保留|Setup\.exe|Portable\.zip/);

  const missingBuilder = buildStartupCheck(rootDir, {
    ...baseOptions,
    toolEnv: {
      "ProgramFiles(x86)": "",
      PATH: "",
      Path: "",
    },
  }).items.find((item) => item.id === "update_flow");

  assert.equal(missingBuilder.status, "warn");
  assert.match(missingBuilder.detail, /NSIS|makensis/);
  assert.match(missingBuilder.action, /安装 NSIS|MAKENSIS_EXE/);

  const fakeProgramFiles = path.join(rootDir, "Program Files x86");
  const fakeNsis = path.join(fakeProgramFiles, "NSIS");
  fs.mkdirSync(fakeNsis, { recursive: true });
  fs.writeFileSync(path.join(fakeNsis, "makensis.exe"), "");

  const localPreflight = buildStartupCheck(rootDir, {
    ...baseOptions,
    toolEnv: {
      "ProgramFiles(x86)": fakeProgramFiles,
      PATH: "",
      Path: "",
    },
  }).items.find((item) => item.id === "update_flow");

  assert.equal(localPreflight.status, "pass");
  assert.match(localPreflight.detail, /安装包命名规则已确认/);
  assert.match(localPreflight.detail, /NSIS|makensis/);
});

test("release preflight checks forbidden batch-delete commands", () => {
  const rootDir = makeTempProject();
  const item = buildStartupCheck(rootDir, {
    platform: "win32",
    arch: "x64",
    routerRunning: true,
    lastHealth: {
      ok: true,
      models: [],
      unhealthyRoutes: 0,
      routes: [],
    },
    config: {
      models: [],
    },
  }).items.find((entry) => entry.id === "delete_safety");

  assert.ok(item, "expected a delete_safety preflight item");
  assert.equal(item.status, "pass");
  assert.match(item.label, /删除安全|清理安全/);
  assert.match(item.detail, /未发现|没有发现/);
  assert.match(item.detail, /批量删除命令/);
});

test("release preflight fails stale OpenAI bundled plugin runtime", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  const installRoot = path.join(homeDir, "OpenAI.Codex_26.616.3767.0_x64");
  const resourcesDir = path.join(installRoot, "app", "resources");
  const nodeBinDir = path.join(resourcesDir, "cua_node", "bin");
  const nodeReplPath = path.join(nodeBinDir, "node_repl.exe");
  const codexCliPath = path.join(resourcesDir, "codex.exe");
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

  for (const filePath of [nodeReplPath, codexCliPath, bundledManifest, cachedManifest]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      filePath.endsWith("plugin.json")
        ? JSON.stringify({ name: "computer-use", version: filePath === bundledManifest ? "26.616.31447" : "26.611.62324" })
        : "",
      "utf8",
    );
  }

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
      "",
    ].join("\n"),
    "utf8",
  );

  const check = buildStartupCheck(rootDir, {
    homeDir,
    routerRunning: true,
    lastHealth: { ok: true, models: [], unhealthyRoutes: 0, routes: [] },
    config: { models: [] },
  });
  const pluginRuntime = check.items.find((item) => item.id === "plugin_runtime");

  assert.equal(pluginRuntime.status, "fail");
  assert.match(pluginRuntime.detail, /computer-use/);
  assert.match(pluginRuntime.detail, /26\.611\.62324/);
  assert.match(pluginRuntime.detail, /26\.616\.31447/);
  assert.match(pluginRuntime.action, /Codex Desktop|缓存/);
  assert.equal(check.summary.fail >= 1, true);
});

test("release preflight warns about untested image providers and fails failed image providers", () => {
  const rootDir = makeTempProject();
  saveImageProvider(rootDir, {
    id: "siliconflow-kolors",
    name: "硅基流动 Kolors",
    adapter: "siliconflow_images",
    baseUrl: "https://api.siliconflow.cn/v1",
    endpoint: "/images/generations",
    model: "Kwai-Kolors/Kolors",
    apiKeyEnv: "SILICONFLOW_API_KEY",
    makeDefault: true,
  });

  const baseOptions = {
    routerRunning: true,
    lastHealth: {
      ok: true,
      models: [{ id: "deepseek" }],
      unhealthyRoutes: 0,
      routes: [{ id: "deepseek", status: "healthy" }],
    },
    config: {
      models: [
        {
          id: "deepseek",
          displayName: "DeepSeek",
          api: "chat_completions",
          imageGeneration: {
            mode: "provider",
            providerId: "siliconflow-kolors",
          },
        },
      ],
    },
  };

  const untested = buildStartupCheck(rootDir, baseOptions).items.find(
    (item) => item.id === "image_generation_proxy",
  );
  assert.equal(untested.status, "warn");
  assert.match(untested.detail, /尚未测试|测试生图/);

  saveImageProviderTestResult(rootDir, "siliconflow-kolors", {
    ok: false,
    message: "API Key 不正确或没有权限。",
  });
  const failed = buildStartupCheck(rootDir, baseOptions).items.find(
    (item) => item.id === "image_generation_proxy",
  );
  assert.equal(failed.status, "fail");
  assert.match(failed.detail, /测试失败|API Key/);
});

test("release preflight warns when image provider tests are stale", () => {
  const rootDir = makeTempProject();
  saveImageProvider(rootDir, {
    id: "siliconflow-kolors",
    name: "硅基流动 Kolors",
    adapter: "siliconflow_images",
    baseUrl: "https://api.siliconflow.cn/v1",
    endpoint: "/images/generations",
    model: "Kwai-Kolors/Kolors",
    apiKeyEnv: "SILICONFLOW_API_KEY",
    makeDefault: true,
  });
  saveImageProviderTestResult(rootDir, "siliconflow-kolors", {
    ok: true,
    durationMs: 777,
    checkedAt: "2000-01-01T00:00:00.000Z",
  });

  const item = buildStartupCheck(rootDir, {
    routerRunning: true,
    lastHealth: { ok: true, models: [{ id: "deepseek" }], unhealthyRoutes: 0, routes: [] },
    config: {
      models: [
        {
          id: "deepseek",
          displayName: "DeepSeek",
          imageGeneration: {
            mode: "provider",
            providerId: "siliconflow-kolors",
          },
        },
      ],
    },
  }).items.find((entry) => entry.id === "image_generation_proxy");

  assert.equal(item.status, "warn");
  assert.match(item.detail, /硅基流动 Kolors/);
  assert.match(item.detail, /过期|超过 7 天|重新测试/);
  assert.match(item.action, /测试生图/);
});

test("release preflight tracks custom capability provider readiness", () => {
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "paddle-ocr",
    name: "Paddle OCR",
    capability: "ocr",
    adapter: "generic_http",
    baseUrl: "https://ocr.example.com/v1",
    endpoint: "/ocr",
    model: "ocr-v1",
    apiKeyEnv: "OCR_API_KEY",
    makeDefault: true,
  });

  const baseOptions = {
    routerRunning: true,
    lastHealth: {
      ok: true,
      models: [],
      unhealthyRoutes: 0,
      routes: [],
    },
    config: {
      models: [],
    },
  };

  const untested = buildStartupCheck(rootDir, baseOptions).items.find(
    (item) => item.id === "capability_providers",
  );
  assert.equal(untested.status, "warn");
  assert.equal(untested.count, 1);
  assert.match(untested.detail, /Paddle OCR/);
  assert.match(untested.detail, /体检|测试/);

  saveCapabilityProviderTestResult(rootDir, "paddle-ocr", {
    ok: true,
    durationMs: 88,
    checks: [
      { id: "request", label: "请求供应商", status: "pass" },
    ],
  });
  const passed = buildStartupCheck(rootDir, baseOptions).items.find(
    (item) => item.id === "capability_providers",
  );
  assert.equal(passed.status, "pass");
  assert.equal(passed.count, 1);
  assert.match(passed.detail, /Paddle OCR/);
  assert.match(passed.detail, /体检通过|88ms/);

  saveCapabilityProvider(rootDir, {
    id: "bocha-search",
    name: "Bocha Search",
    capability: "web_search",
    adapter: "generic_http",
    baseUrl: "https://api.bochaai.com/v1",
    endpoint: "/web-search",
    apiKeyEnv: "BOCHA_API_KEY",
  });
  saveCapabilityProviderTestResult(rootDir, "bocha-search", {
    ok: false,
    message: "API Key 无效或没有权限。",
  });
  const failed = buildStartupCheck(rootDir, baseOptions).items.find(
    (item) => item.id === "capability_providers",
  );
  assert.equal(failed.status, "fail");
  assert.equal(failed.count, 1);
  assert.match(failed.detail, /Bocha Search/);
  assert.match(failed.detail, /API Key/);

  saveCapabilityProviderTestResult(rootDir, "bocha-search", {
    ok: false,
    message: "能力供应商体检失败。",
    checks: [
      {
        id: "rate_limit",
        label: "频率限制",
        status: "fail",
        message: "供应商限流，请 30s 后再试。",
      },
    ],
  });
  const rateLimited = buildStartupCheck(rootDir, baseOptions).items.find(
    (item) => item.id === "capability_providers",
  );
  assert.equal(rateLimited.status, "fail");
  assert.match(rateLimited.detail, /Bocha Search/);
  assert.match(rateLimited.detail, /频率限制|限流/);
  assert.match(rateLimited.detail, /30s/);
});

test("release preflight warns when capability provider tests are stale", () => {
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "bocha-search",
    name: "Bocha Search",
    capability: "web_search",
    adapter: "generic_http",
    baseUrl: "https://api.bochaai.com/v1",
    endpoint: "/web-search",
    apiKeyEnv: "BOCHA_API_KEY",
    makeDefault: true,
  });
  saveCapabilityProviderTestResult(rootDir, "bocha-search", {
    ok: true,
    durationMs: 66,
    checkedAt: "2000-01-01T00:00:00.000Z",
    checks: [
      { id: "request", label: "请求供应商", status: "pass" },
    ],
  });

  const item = buildStartupCheck(rootDir, {
    routerRunning: true,
    lastHealth: { ok: true, models: [], unhealthyRoutes: 0, routes: [] },
    config: { models: [] },
  }).items.find((entry) => entry.id === "capability_providers");

  assert.equal(item.status, "warn");
  assert.match(item.detail, /Bocha Search/);
  assert.match(item.detail, /过期|超过 7 天|重新体检/);
  assert.match(item.action, /测试能力|重新体检/);
});

test("release preflight surfaces real environment acceptance gaps", () => {
  const rootDir = makeTempProject();
  saveImageProvider(rootDir, {
    id: "siliconflow-kolors",
    name: "硅基流动 Kolors",
    adapter: "siliconflow_images",
    baseUrl: "https://api.siliconflow.cn/v1",
    endpoint: "/images/generations",
    model: "Kwai-Kolors/Kolors",
    apiKeyEnv: "SILICONFLOW_API_KEY",
    makeDefault: true,
  });
  saveImageProviderTestResult(rootDir, "siliconflow-kolors", {
    ok: true,
    localPath: "C:\\Users\\Administrator\\Pictures\\CodexBridge\\sample.png",
    durationMs: 1200,
    checkedAt: new Date().toISOString(),
  });
  saveCapabilityProvider(rootDir, {
    id: "bocha-search",
    name: "Bocha Search",
    capability: "web_search",
    adapter: "generic_http",
    baseUrl: "https://api.bochaai.com/v1",
    endpoint: "/web-search",
    apiKeyEnv: "BOCHA_API_KEY",
    makeDefault: true,
  });

  const item = buildStartupCheck(rootDir, {
    routerRunning: false,
    lastHealth: null,
    config: { models: [] },
    platform: "win32",
    arch: "x64",
  }).items.find((entry) => entry.id === "real_environment_acceptance");

  assert.ok(item, "expected a real_environment_acceptance preflight item");
  assert.equal(item.status, "warn");
  assert.match(item.label, /真实环境检查/);
  assert.match(item.detail, /正式发包检查还差/);
  assert.match(item.detail, /普通启动.*不受影响/);
  assert.doesNotMatch(item.detail, /通过发布体检/);
  assert.doesNotMatch(item.detail, /已验证：.*硅基流动 Kolors/);
  assert.doesNotMatch(item.detail, /图片供应商缺少.*硅基流动 Kolors/);
  assert.match(item.action, /正式发包前/);
  assert.match(item.action, /检查/);
  assert.doesNotMatch(item.action, /npm run release:gate/);
  assert.doesNotMatch(item.action, /release:preflight/);
});

test("release preflight accepts an explicit real environment acceptance report", () => {
  const rootDir = makeTempProject();
  const item = buildStartupCheck(rootDir, {
    routerRunning: false,
    lastHealth: null,
    config: { models: [] },
    platform: "win32",
    arch: "x64",
    realAcceptanceReport: {
      ok: true,
      checkedAt: "2026-07-05T08:00:00.000Z",
      router: {
        ok: true,
        detail: "real router health passed",
        models: ["gpt-5.5"],
      },
      imageProvider: {
        ok: true,
        provider: "SiliconFlow Kolors",
        localPath: "C:\\Users\\Administrator\\Pictures\\CodexBridge\\sample.png",
        durationMs: 1200,
      },
      capabilityProvider: {
        ok: true,
        provider: "Local Chrome Bridge",
        capability: "browser",
        durationMs: 300,
      },
      windowsInstaller: {
        ok: true,
        setupExe: "CodexBridge-Windows-x64-Setup.exe",
        portableZip: "CodexBridge-Windows-x64-Portable.zip",
      },
    },
  }).items.find((entry) => entry.id === "real_environment_acceptance");

  assert.ok(item, "expected real_environment_acceptance preflight item");
  assert.equal(item.status, "pass");
  assert.equal(item.count, 0);
  assert.match(item.detail, /真实 Router、图片供应商、能力桥接和 Windows 安装更新都已检查/);
  assert.match(item.detail, /2026-07-05T08:00:00.000Z/);
  assert.doesNotMatch(item.detail, /待验证/);
});

test("release preflight incomplete real acceptance report points to release gate", () => {
  const rootDir = makeTempProject();
  const item = buildStartupCheck(rootDir, {
    routerRunning: false,
    lastHealth: null,
    config: { models: [] },
    platform: "win32",
    arch: "x64",
    realAcceptanceReport: {
      ok: false,
      error: "installer smoke missing",
      router: { ok: true, detail: "router checked" },
    },
  }).items.find((entry) => entry.id === "real_environment_acceptance");

  assert.ok(item, "expected real_environment_acceptance preflight item");
  assert.equal(item.status, "warn");
  assert.match(item.detail, /正式发包检查还差/);
  assert.doesNotMatch(item.action, /npm run release:gate/);
  assert.doesNotMatch(item.action, /release:preflight|重新运行发布体检/);
});

test("real acceptance report builder records current Router, provider, and installer evidence", () => {
  const rootDir = makeTempProject();
  const checkedAt = new Date().toISOString();
  saveImageProvider(rootDir, {
    id: "siliconflow-kolors",
    name: "SiliconFlow Kolors",
    adapter: "siliconflow_images",
    baseUrl: "https://api.siliconflow.cn/v1",
    endpoint: "/images/generations",
    model: "Kwai-Kolors/Kolors",
    apiKeyEnv: "SILICONFLOW_API_KEY",
    makeDefault: true,
  });
  saveImageProviderTestResult(rootDir, "siliconflow-kolors", {
    ok: true,
    localPath: "C:\\Users\\Administrator\\Pictures\\CodexBridge\\sample.png",
    durationMs: 1200,
    checkedAt,
  });
  saveCapabilityProvider(rootDir, {
    id: "local-browser",
    name: "Local Chrome Bridge",
    capability: "browser",
    adapter: "local_browser",
    makeDefault: true,
  });
  saveCapabilityProviderTestResult(rootDir, "local-browser", {
    ok: true,
    durationMs: 300,
    checkedAt,
  });

  const report = buildRealAcceptanceReport(rootDir, {
    routerRunning: true,
    lastHealth: {
      ok: true,
      unhealthyRoutes: 0,
      models: ["cb-gpt-5-5"],
      routes: [{ id: "cb-gpt-5-5" }],
    },
    releaseAssets: [
      {
        name: "CodexBridge-Windows-x64-Setup.exe",
        path: "D:\\release\\CodexBridge-Windows-x64-Setup.exe",
        size: 1024,
        headerHex: "4d5a9000",
      },
      {
        name: "CodexBridge-Windows-x64-Portable.zip",
        path: "D:\\release\\CodexBridge-Windows-x64-Portable.zip",
        size: 2048,
        headerHex: "504b0304",
      },
    ],
    platform: "win32",
    arch: "x64",
    now: () => checkedAt,
  });

  assert.equal(report.ok, true);
  assert.equal(report.checkedAt, checkedAt);
  assert.equal(report.source, "desktop-preflight");
  assert.equal(report.router.ok, true);
  assert.deepEqual(report.router.models, ["cb-gpt-5-5"]);
  assert.equal(report.imageProviders.length, 1);
  assert.equal(report.imageProviders[0].provider, "SiliconFlow Kolors");
  assert.equal(report.imageProviders[0].localPath, "C:\\Users\\Administrator\\Pictures\\CodexBridge\\sample.png");
  assert.equal(report.capabilityProviders.length, 1);
  assert.equal(report.capabilityProviders[0].provider, "Local Chrome Bridge");
  assert.equal(report.capabilityProviders[0].capability, "browser");
  assert.equal(report.windowsInstaller.ok, true);
  assert.match(report.windowsInstaller.setupExe, /CodexBridge-Windows-x64-Setup\.exe$/);
  assert.match(report.windowsInstaller.portableZip, /CodexBridge-Windows-x64-Portable\.zip$/);
});

test("release gate report builder writes machine-readable desktop preflight evidence", () => {
  const rootDir = makeTempProject();
  const reportPath = path.join(rootDir, "release-gate.json");

  const report = buildReleaseGateReport(rootDir, {
    appVersion: "0.2.4",
    routerRunning: false,
    strictWarnings: true,
    now: () => "2026-07-05T10:00:00.000Z",
  });

  assert.equal(report.ok, false);
  assert.equal(report.appVersion, "0.2.4");
  assert.equal(report.checkedAt, "2026-07-05T10:00:00.000Z");
  assert.equal(report.releaseGate.strictWarnings, true);
  assert.equal(report.releaseGate.blockedByWarnings, true);
  assert.equal(report.releaseGate.reason, "strict_warnings");
  assert.ok(report.releaseGate.warningItemIds.includes("router"));
  assert.ok(report.releaseGate.blockingItemIds.includes("router"));
  assert.ok(report.releaseGate.realEvidenceRequiredItemIds.includes("router"));
  assert.ok(report.releaseGate.realEvidenceRequiredItemIds.includes("route_health"));
  assert.ok(report.releaseGate.realEvidenceRequiredItemIds.includes("image_generation_proxy"));
  assert.ok(report.releaseGate.realEvidenceRequiredItemIds.includes("real_environment_acceptance"));
  assert.ok(report.releaseGate.realEvidenceRequiredItemIds.includes("update_flow"));
  assert.doesNotMatch(report.releaseGate.realEvidenceRequiredItemIds.join(","), /capability_providers/);
  assert.doesNotMatch(report.releaseGate.realEvidenceRequiredItemIds.join(","), /model_catalog/);
  assert.ok(report.releaseGate.realEvidenceBlockingItemIds.includes("update_flow"));
  assert.ok(report.releaseGate.localSetupBlockingItemIds.includes("model_catalog"));
  assert.doesNotMatch(report.releaseGate.codeOrConfigBlockingItemIds.join(","), /model_catalog/);
  assert.equal(report.dataRoot, rootDir);
  assert.equal(report.summary.warn > 0, true);
  assert.equal(Array.isArray(report.items), true);
  const acceptanceItem = report.items.find((item) => item.id === "real_environment_acceptance");
  assert.ok(acceptanceItem, "expected release gate report to include real environment acceptance");
  assert.match(acceptanceItem.action, /真实 Key|正式发包前/);
  assert.doesNotMatch(acceptanceItem.action, /npm run release:gate/);
  assert.doesNotMatch(acceptanceItem.action, /release:preflight/);

  const saved = saveReleaseGateReport(rootDir, reportPath, {
    appVersion: "0.2.4",
    routerRunning: false,
    strictWarnings: true,
    now: () => "2026-07-05T10:00:00.000Z",
  });
  const written = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(saved.filePath, reportPath);
  assert.equal(saved.ok, false);
  assert.equal(written.releaseGate.reason, "strict_warnings");
  assert.equal(written.releaseGate.ok, false);
});

test("release asset scanner records installer file paths, sizes, and headers", () => {
  const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-release-assets-"));
  const setupPath = path.join(releaseDir, "CodexBridge-Windows-x64-Setup.exe");
  const portablePath = path.join(releaseDir, "CodexBridge-Windows-x64-Portable.zip");
  fs.writeFileSync(setupPath, Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x01]));
  fs.writeFileSync(portablePath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x02]));

  const assets = releaseAssetsFromDirectory(releaseDir);

  assert.deepEqual(
    assets.map((asset) => ({
      name: asset.name,
      path: asset.path,
      size: asset.size,
      headerHex: asset.headerHex,
    })),
    [
      {
        name: "CodexBridge-Windows-x64-Portable.zip",
        path: portablePath,
        size: 5,
        headerHex: "504b0304",
      },
      {
        name: "CodexBridge-Windows-x64-Setup.exe",
        path: setupPath,
        size: 5,
        headerHex: "4d5a9000",
      },
    ],
  );
});

test("release preflight separates local capability providers from remote untested providers", () => {
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "local-browser",
    name: "本地 Chrome",
    capability: "browser",
    adapter: "local_browser",
    makeDefault: true,
  });
  saveCapabilityProvider(rootDir, {
    id: "local-computer-use",
    name: "本地 Computer Use",
    capability: "computer_use",
    adapter: "local_computer_use",
  });

  const item = buildStartupCheck(rootDir, {
    routerRunning: true,
    lastHealth: { ok: true, models: [], unhealthyRoutes: 0, routes: [] },
    config: { models: [] },
  }).items.find((entry) => entry.id === "capability_providers");

  assert.ok(item, "expected a capability_providers preflight item");
  assert.equal(item.status, "warn");
  assert.equal(item.count, 2);
  assert.match(item.detail, /本地 Chrome/);
  assert.match(item.detail, /本地 Computer Use/);
  assert.match(item.detail, /本地执行器|桌面端/);
  assert.match(item.detail, /不是 GPT 原生 Chrome/);
  assert.match(item.detail, /安全动作|白名单|不会自动点击/);
  assert.doesNotMatch(item.detail, /尚未体检/);
  assert.match(item.action, /打开能力页|试运行|诊断/);
});

test("release preflight fails disabled default capability providers", () => {
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "disabled-browser",
    name: "Disabled Browser",
    capability: "browser",
    adapter: "local_browser",
    enabled: false,
    makeDefault: true,
  });
  saveCapabilityProvider(rootDir, {
    id: "paddle-ocr",
    name: "Paddle OCR",
    capability: "ocr",
    adapter: "generic_http",
    baseUrl: "https://ocr.example.com/v1",
    endpoint: "/ocr",
    model: "ocr-v1",
    apiKeyEnv: "OCR_API_KEY",
    makeDefault: true,
  });
  saveCapabilityProviderTestResult(rootDir, "paddle-ocr", {
    ok: true,
    durationMs: 88,
  });

  const item = buildStartupCheck(rootDir, {
    routerRunning: true,
    lastHealth: { ok: true, models: [], unhealthyRoutes: 0, routes: [] },
    config: { models: [] },
  }).items.find((entry) => entry.id === "capability_providers");

  assert.ok(item, "expected a capability_providers preflight item");
  assert.equal(item.status, "fail");
  assert.equal(item.count, 1);
  assert.match(item.detail, /Disabled Browser/);
  assert.match(item.detail, /默认/);
  assert.match(item.detail, /停用/);
  assert.match(item.action, /重新选择默认|启用/);
});

test("release preflight explains current Codex resources versus local cache", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(path.join(codexDir, "skills", "demo"), { recursive: true });
  fs.mkdirSync(
    path.join(codexDir, "plugins", "cache", "personal", "cowart", "0.1.3", "skills", "cowart-open-canvas"),
    { recursive: true },
  );
  fs.writeFileSync(path.join(codexDir, "skills", "demo", "SKILL.md"), "# Demo\nUse when testing local skills.\n", "utf8");
  fs.writeFileSync(
    path.join(codexDir, "plugins", "cache", "personal", "cowart", "0.1.3", ".codex-plugin.json"),
    JSON.stringify({ name: "cowart", version: "0.1.3" }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(codexDir, "plugins", "cache", "personal", "cowart", "0.1.3", "skills", "cowart-open-canvas", "SKILL.md"),
    "# Cowart\nOpen the canvas.\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    [
      "[mcp_servers.node_repl]",
      'command = "C:/Codex/node_repl.exe"',
      "",
      '[plugins."disabled@personal"]',
      "enabled = false",
      "",
    ].join("\n"),
    "utf8",
  );

  const check = buildStartupCheck(rootDir, {
    homeDir,
    routerRunning: true,
    lastHealth: { ok: true, models: [], unhealthyRoutes: 0, routes: [] },
    config: { models: [] },
    codexCliSnapshot: codexCliAuthoritySnapshot(),
    codexPromptInputSnapshot: codexPromptSkillsSnapshot([{
      name: "demo",
      description: "Use when testing local skills.",
      path: path.join(codexDir, "skills", "demo", "SKILL.md"),
    }]),
    codexAppServerSnapshot: {
      apps: { ok: true, items: [] },
      skills: {
        ok: true,
        items: [{
          name: "demo",
          path: path.join(codexDir, "skills", "demo", "SKILL.md"),
          scope: "user",
          enabled: true,
        }],
      },
    },
  });
  const resources = check.items.find((item) => item.id === "codex_resources");

  assert.equal(resources.status, "pass");
  assert.equal(resources.count, 1);
  assert.match(resources.detail, /MCP 0/);
  assert.match(resources.detail, /技能 1/);
  assert.match(resources.detail, /本地发现|缓存/);
  assert.match(resources.detail, /插件 2/);
  assert.match(resources.detail, /技能 1/);
  assert.match(resources.action, /不计入当前可用|资源页/);
});

test("release preflight uses Codex CLI resource snapshot for current resource counts", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    [
      '[plugins."github@openai-curated-remote"]',
      "enabled = true",
      "",
      '[plugins."old-local@personal"]',
      "enabled = true",
      "",
      '[plugins."browser@openai-bundled"]',
      "enabled = true",
      "",
      "[mcp_servers.node_repl]",
      'command = "C:/Codex/node_repl.exe"',
      "",
      "[mcp_servers.config_only]",
      'command = "C:/Codex/config-only.exe"',
      "",
    ].join("\n"),
    "utf8",
  );

  const check = buildStartupCheck(rootDir, {
    homeDir,
    routerRunning: true,
    lastHealth: { ok: true, models: [], unhealthyRoutes: 0, routes: [] },
    config: { models: [] },
    codexCliSnapshot: {
      plugins: {
        ok: true,
        items: [
          {
            pluginId: "github@openai-curated-remote",
            name: "github",
            marketplaceName: "openai-curated-remote",
            installed: true,
            enabled: true,
          },
          {
            pluginId: "browser@openai-bundled",
            name: "browser",
            marketplaceName: "openai-bundled",
            installed: true,
            enabled: true,
          },
          {
            pluginId: "cowart@personal",
            name: "cowart",
            marketplaceName: "personal",
            installed: true,
            enabled: false,
          },
        ],
      },
      mcpServers: {
        ok: true,
        items: [
          {
            name: "node_repl",
            enabled: true,
            transport: { command: "C:/Codex/node_repl.exe", args: [] },
          },
          {
            name: "plugin_mcp",
            enabled: true,
            transport: { command: "C:/Codex/plugin-mcp.exe", args: [] },
          },
          {
            name: "disabled_cli",
            enabled: false,
            transport: { command: "C:/Codex/disabled.exe", args: [] },
          },
        ],
      },
    },
    codexPromptInputSnapshot: codexPromptSkillsSnapshot(),
    codexAppServerSnapshot: {
      apps: { ok: true, items: [] },
      skills: { ok: true, items: [] },
    },
  });
  const resources = check.items.find((item) => item.id === "codex_resources");
  const configPackage = check.items.find((item) => item.id === "config_package");

  assert.equal(resources.count, 3);
  assert.match(resources.detail, /MCP 0/);
  assert.match(resources.detail, /插件 2/);
  assert.match(resources.detail, /本地发现|缓存/);
  assert.doesNotMatch(configPackage.detail, /Codex 资源清单/);
});

test("release preflight does not warn only because local plugin cache is not currently usable", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-current-resources-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(path.join(codexDir, "plugins", "cache", "personal", "old-cache", "0.1.0"), { recursive: true });
  fs.writeFileSync(path.join(codexDir, "config.toml"), "", "utf8");
  fs.writeFileSync(
    path.join(codexDir, "plugins", "cache", "personal", "old-cache", "0.1.0", ".codex-plugin.json"),
    JSON.stringify({ name: "old-cache", version: "0.1.0" }),
    "utf8",
  );

  const check = buildStartupCheck(rootDir, {
    homeDir,
    routerRunning: true,
    lastHealth: { ok: true, models: [], unhealthyRoutes: 0, routes: [] },
    config: { models: [] },
    codexCliSnapshot: {
      plugins: {
        ok: true,
        items: [{
          pluginId: "github@openai-curated-remote",
          name: "github",
          marketplaceName: "openai-curated-remote",
          installed: true,
          enabled: true,
        }],
      },
      mcpServers: {
        ok: true,
        items: [{
          name: "node_repl",
          enabled: true,
          transport: { command: "C:/Codex/node_repl.exe", args: [] },
        }],
      },
    },
    codexPromptInputSnapshot: codexPromptSkillsSnapshot(),
    codexAppServerSnapshot: {
      apps: { ok: true, items: [] },
      skills: { ok: true, items: [] },
    },
  });
  const resources = check.items.find((item) => item.id === "codex_resources");

  assert.equal(resources.status, "pass");
  assert.equal(resources.count, 1);
  assert.match(resources.detail, /当前可用：MCP 0、插件 1/);
  assert.match(resources.detail, /本地发现|缓存/);
  assert.match(resources.action, /以当前可用为准|不计入当前可用/);
});

test("release preflight config package mirrors CLI-only current resource counts", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-cli-only-resources-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, "config.toml"), "", "utf8");

  const check = buildStartupCheck(rootDir, {
    homeDir,
    routerRunning: true,
    lastHealth: { ok: true, models: [], unhealthyRoutes: 0, routes: [] },
    config: { models: [] },
    codexCliSnapshot: {
      plugins: {
        ok: true,
        items: [
          {
            pluginId: "github@openai-curated-remote",
            name: "github",
            marketplaceName: "openai-curated-remote",
            installed: true,
            enabled: true,
          },
        ],
      },
      mcpServers: {
        ok: true,
        items: [
          {
            name: "node_repl",
            enabled: true,
            transport: { command: "C:/Codex/node_repl.exe", args: [] },
          },
        ],
      },
    },
    codexPromptInputSnapshot: codexPromptSkillsSnapshot(),
    codexAppServerSnapshot: {
      apps: { ok: true, items: [] },
      skills: { ok: true, items: [] },
    },
  });
  const resources = check.items.find((item) => item.id === "codex_resources");
  const configPackage = check.items.find((item) => item.id === "config_package");

  assert.equal(resources.count, 1);
  assert.match(resources.detail, /MCP 0/);
  assert.match(resources.detail, /插件 1/);
  assert.doesNotMatch(configPackage.detail, /Codex 资源清单/);
});

test("release preflight config package mirrors Codex local skill setting counts", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-preflight-prompt-skills-"));
  const codexDir = path.join(homeDir, ".codex");
  const visibleSkillDir = path.join(codexDir, "skills", "visible-skill");
  const hiddenSkillDir = path.join(codexDir, "skills", "hidden-local-skill");
  const systemSkillDir = path.join(codexDir, "skills", ".system", "imagegen");
  const pluginSkillDir = path.join(codexDir, "plugins", "cache", "openai-bundled", "browser", "26.0.0", "skills", "browser-skill");
  fs.mkdirSync(visibleSkillDir, { recursive: true });
  fs.mkdirSync(hiddenSkillDir, { recursive: true });
  fs.mkdirSync(systemSkillDir, { recursive: true });
  fs.mkdirSync(pluginSkillDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, "config.toml"), "", "utf8");
  fs.writeFileSync(path.join(visibleSkillDir, "SKILL.md"), "# Visible\nUse when visible.\n", "utf8");
  fs.writeFileSync(path.join(hiddenSkillDir, "SKILL.md"), "# Hidden\nUse when hidden.\n", "utf8");
  fs.writeFileSync(path.join(systemSkillDir, "SKILL.md"), "# Imagegen\nUse when generating images.\n", "utf8");
  fs.writeFileSync(path.join(pluginSkillDir, "SKILL.md"), "# Browser Skill\nUse when browsing.\n", "utf8");

  const promptRoot = path.join(codexDir, "skills").replace(/\\/g, "/");
  const systemPromptRoot = path.join(codexDir, "skills", ".system").replace(/\\/g, "/");
  const pluginPromptRoot = path.join(codexDir, "plugins", "cache", "openai-bundled", "browser", "26.0.0", "skills").replace(/\\/g, "/");
  const promptSnapshot = {
    ok: true,
    items: [
      {
        type: "message",
        role: "developer",
        content: [{
          type: "input_text",
          text: [
            "<skills_instructions>",
            "### Skill roots",
            `- \`r0\` = \`${promptRoot}\``,
            `- \`r1\` = \`${pluginPromptRoot}\``,
            `- \`r2\` = \`${systemPromptRoot}\``,
            "### Available skills",
            "- visible-skill: Use when visible. (file: r0/visible-skill/SKILL.md)",
            "- browser:browser-skill: Use when browsing. (file: r1/browser-skill/SKILL.md)",
            "- imagegen: Use when generating images. (file: r2/imagegen/SKILL.md)",
            "</skills_instructions>",
          ].join("\n"),
        }],
      },
    ],
  };

  const check = buildStartupCheck(rootDir, {
    homeDir,
    routerRunning: true,
    lastHealth: { ok: true, models: [], unhealthyRoutes: 0, routes: [] },
    config: { models: [] },
    codexCliSnapshot: codexCliAuthoritySnapshot(),
    codexPromptInputSnapshot: promptSnapshot,
    codexAppServerSnapshot: {
      apps: { ok: true, items: [] },
      skills: {
        ok: true,
        items: [
          { name: "visible-skill", path: path.join(visibleSkillDir, "SKILL.md"), scope: "user", enabled: true },
          { name: "hidden-local-skill", path: path.join(hiddenSkillDir, "SKILL.md"), scope: "user", enabled: true },
          { name: "imagegen", path: path.join(systemSkillDir, "SKILL.md"), scope: "system", enabled: true },
          { name: "browser:browser-skill", path: path.join(pluginSkillDir, "SKILL.md"), scope: "user", enabled: true },
        ],
      },
    },
  });
  const resources = check.items.find((item) => item.id === "codex_resources");
  const configPackage = check.items.find((item) => item.id === "config_package");

  assert.equal(resources.count, 2);
  assert.match(resources.detail, /技能 2/);
  assert.doesNotMatch(configPackage.detail, /Codex 资源清单/);
});

test("release preflight surfaces Codex session and project inventory", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({
      "pinned-project-ids": ["C:/Users/Administrator/Documents/aaa"],
      "projectless-thread-ids": ["thread_loose"],
    }),
    "utf8",
  );
  createCodexThreadCatalogDb(codexDir, [
    {
      id: "thread_project",
      title: "Project Session",
      cwd: "C:/Users/Administrator/Documents/aaa",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 20,
    },
    {
      id: "thread_loose",
      title: "Loose Session",
      cwd: "C:/Users/Administrator/Documents/aaa",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 10,
    },
  ]);

  const check = buildStartupCheck(rootDir, {
    homeDir,
    routerRunning: true,
    lastHealth: { ok: true, models: [], unhealthyRoutes: 0, routes: [] },
    config: { models: [] },
  });
  const sessions = check.items.find((item) => item.id === "codex_sessions");

  assert.ok(sessions, "expected a codex_sessions preflight item");
  assert.equal(sessions.status, "pass");
  assert.equal(sessions.count, 2);
  assert.match(sessions.detail, /本机 Codex 会话索引 2 个/);
  assert.match(sessions.detail, /项目 1 个/);
  assert.match(sessions.detail, /项目内会话 1 个/);
  assert.match(sessions.detail, /无项目会话 1 个/);
  assert.match(sessions.action, /会话页|项目文件夹/);
});

test("resource snapshot is skipped when the Codex home directory is missing", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const binDir = path.join(homeDir, "bin");
  const markerPath = path.join(homeDir, "codex-cli-called.txt");
  fs.mkdirSync(binDir, { recursive: true });
  if (process.platform === "win32") {
    fs.writeFileSync(
      path.join(binDir, "codex.cmd"),
      `@echo off\r\necho called > "${markerPath}"\r\necho []\r\n`,
      "utf8",
    );
  } else {
    const executable = path.join(binDir, "codex");
    fs.writeFileSync(
      executable,
      `#!/bin/sh\necho called > "${markerPath}"\necho '[]'\n`,
      "utf8",
    );
    fs.chmodSync(executable, 0o755);
  }

  const previousPATH = process.env.PATH;
  const previousPath = process.env.Path;
  const nextPath = `${binDir}${path.delimiter}${previousPath || previousPATH || ""}`;
  process.env.PATH = nextPath;
  process.env.Path = nextPath;
  try {
    const resources = listCodexResources({
      rootDir,
      homeDir,
      includeCodexCliSnapshot: true,
    });

    assert.equal(resources.summary.plugins, null);
    assert.equal(resources.readStatus.plugins.code, "codex_home_missing");
    assert.equal(fs.existsSync(markerPath), false);
  } finally {
    process.env.PATH = previousPATH;
    if (previousPath === undefined) {
      delete process.env.Path;
    } else {
      process.env.Path = previousPath;
    }
  }
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

test("config profiles repair stale selected and desktop model references when saved", () => {
  const rootDir = makeTempProject();
  fs.mkdirSync(path.join(rootDir, "config"), { recursive: true });
  fs.writeFileSync(
    modelDirectoryPath(rootDir),
    JSON.stringify({
      version: 1,
      providers: {
        "kimi-code": {
          providerId: "kimi-code",
          providerName: "Kimi Code",
          baseUrl: "https://api.kimi.com/coding/v1",
          models: [{ id: "kimi-for-coding" }],
        },
      },
    }, null, 2),
    "utf8",
  );

  const saved = saveConfigProfile(rootDir, {
    name: "Kimi repaired profile",
    mode: MODE_HYBRID,
    selectedModelIds: ["kimi-code-k3"],
    desktopOptions: {
      codexAuxiliaryModelId: "cb-kimi-code-k3",
      smartRouting: {
        autoSelectRules: {
          code: { mode: "route", routeId: "cb-kimi-code-k3" },
          longContext: { mode: "route", routeId: "cb-missing-model" },
        },
        failover: {
          mode: "ordered",
          routeIds: ["cb-missing-model", "cb-kimi-code-k3"],
        },
      },
    },
  });

  assert.deepEqual(saved.selectedModelIds, ["kimi-code-for-coding"]);
  assert.equal(saved.desktopOptions.codexAuxiliaryModelId, "cb-kimi-code-for-coding");
  assert.deepEqual(saved.desktopOptions.smartRouting.autoSelectRules.code, {
    mode: "route",
    routeId: "cb-kimi-code-for-coding",
  });
  assert.deepEqual(saved.desktopOptions.smartRouting.autoSelectRules.longContext, {
    mode: "auto",
    routeId: "",
  });
  assert.deepEqual(saved.desktopOptions.smartRouting.failover, {
    mode: "ordered",
    routeIds: ["cb-kimi-code-for-coding"],
  });
});

test("config packages export local settings without secrets and import them on another machine", () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, { DEEPSEEK_API_KEY: "sk-should-not-export" });
  saveSelection(rootDir, ["deepseek-v4-pro"], MODE_HYBRID);
  saveDesktopOptions(rootDir, {
    routerPort: 15988,
    bypassSystemProxy: true,
    usageBudgets: {
      global: {
        dailyTokenLimit: 100000,
        dailyCostLimit: 12.5,
        inputCostPerMillion: 1.5,
      },
      providers: {
        deepseek: {
          dailyCallLimit: 200,
          dailyCostLimit: 8.75,
          outputCostPerMillion: 2.25,
        },
      },
      routes: {
        "cb-deepseek-v4-pro": {
          dailyTokenLimit: 50000,
        },
      },
    },
    codexDesktopExe: "C:\\Users\\Administrator\\AppData\\Local\\Microsoft\\WindowsApps\\Codex.exe",
    codexDesktopLaunchTarget: "C:\\Users\\Administrator\\Desktop\\Codex.lnk",
  });
  saveProviderOverride(rootDir, "deepseek", {
    name: "DeepSeek Proxy",
    baseUrl: "https://proxy.example.com/v1",
    logoUrl: "file:///C:/Users/Administrator/AppData/Roaming/CodexBridge/config/provider-logos/deepseek.png",
  });
  saveCustomModel(rootDir, {
    providerId: "custom-api",
    providerName: "Custom API",
    displayName: "My Coder",
    model: "my-coder-v1",
    baseUrl: "https://api.example.com/v1",
    keyEnv: "CUSTOM_API_KEY",
    logoUrl: "file:///C:/Users/Administrator/AppData/Roaming/CodexBridge/config/provider-logos/custom-api.png",
  });
  saveImageProvider(rootDir, {
    id: "siliconflow-kolors",
    name: "硅基流动 Kolors",
    adapter: "siliconflow_images",
    baseUrl: "https://api.siliconflow.cn/v1",
    endpoint: "/images/generations",
    model: "Kwai-Kolors/Kolors",
    apiKeyEnv: "SILICONFLOW_API_KEY",
    makeDefault: true,
  });
  saveImageProviderTestResult(rootDir, "siliconflow-kolors", {
    ok: true,
    durationMs: 1200,
    localPath: "C:\\Users\\Administrator\\Pictures\\generated-images\\sample.png",
    checks: [{ id: "api_key", label: "API Key", status: "pass" }],
  });
  saveCapabilityProvider(rootDir, {
    id: "paddle-ocr",
    name: "Paddle OCR",
    capability: "ocr",
    adapter: "generic_http",
    baseUrl: "https://ocr.example.com/v1",
    endpoint: "/ocr",
    model: "ocr-v1",
    apiKeyEnv: "OCR_API_KEY",
    makeDefault: true,
    lastTest: {
      ok: true,
      localPath: "C:\\Users\\Administrator\\Pictures\\ocr-cache\\sample.txt",
    },
  });
  saveCapabilityProvider(rootDir, {
    id: "local-file",
    name: "Local File",
    capability: "file_processing",
    adapter: "local_file",
    defaults: {
      action: "extract_text",
      maxCharacters: 6000,
      path: "C:\\Users\\Administrator\\Documents\\private-contract.txt",
      files: [
        "C:\\Users\\Administrator\\Documents\\private-a.txt",
        "C:\\Users\\Administrator\\Documents\\private-b.txt",
      ],
      outputPath: "C:\\Users\\Administrator\\Pictures\\generated-images\\file-result.txt",
    },
  });
  const customModelsPath = path.join(rootDir, "config", "custom-models.json");
  const customModels = JSON.parse(fs.readFileSync(customModelsPath, "utf8"));
  customModels[0].apiKey = "sk-custom-model-should-not-export";
  fs.writeFileSync(customModelsPath, JSON.stringify(customModels, null, 2), "utf8");

  const imageProvidersPath = path.join(rootDir, "config", "image-providers.json");
  const imageProviders = JSON.parse(fs.readFileSync(imageProvidersPath, "utf8"));
  imageProviders.providers[0].apiKey = "sk-image-provider-should-not-export";
  imageProviders.providers[0].defaults = {
    batch_size: 1,
    public_style: "clean",
    authToken: "sk-nested-image-auth-token-should-not-export",
    headers: {
      Authorization: "Bearer sk-nested-image-header-should-not-export",
    },
    cookie: "session=sk-nested-image-cookie-should-not-export",
  };
  fs.writeFileSync(imageProvidersPath, JSON.stringify(imageProviders, null, 2), "utf8");

  const capabilityProvidersPath = path.join(rootDir, "config", "capability-providers.json");
  const capabilityProviders = JSON.parse(fs.readFileSync(capabilityProvidersPath, "utf8"));
  capabilityProviders.providers[0].apiKey = "sk-capability-provider-should-not-export";
  capabilityProviders.providers[0].defaults = {
    language: "zh",
    api_key: "sk-nested-capability-default-should-not-export",
    refresh_token: "sk-nested-capability-refresh-token-should-not-export",
    client_secret: "sk-nested-capability-client-secret-should-not-export",
  };
  fs.writeFileSync(capabilityProvidersPath, JSON.stringify(capabilityProviders, null, 2), "utf8");

  saveModelImageGenerationOverride(rootDir, "deepseek-v4-pro", {
    mode: "custom",
    displayName: "Local Custom Image",
    baseUrl: "https://images.example.com/v1",
    endpoint: "/images/generations",
    model: "image-model",
    size: "1024x1024",
    apiKeyEnv: "LOCAL_IMAGE_API_KEY",
    outputDir: "C:\\Users\\Administrator\\Pictures\\generated-images",
    historyPath: "C:\\Users\\Administrator\\AppData\\Roaming\\CodexBridge\\image-history.json",
    defaults: { prompt_strength: 0.8 },
    response: { imageUrlPath: "data[0].url" },
  });
  const imageGenerationConfigPath = modelImageGenerationPath(rootDir);
  const imageGenerationConfig = JSON.parse(fs.readFileSync(imageGenerationConfigPath, "utf8"));
  const unsafeImageGeneration = imageGenerationConfig.imageGeneration["deepseek-v4-pro"];
  unsafeImageGeneration.apiKey = "sk-local-image-should-not-export";
  unsafeImageGeneration.defaults.access_token = "sk-nested-model-default-should-not-export";
  unsafeImageGeneration.defaults.bearerToken = "sk-nested-model-bearer-token-should-not-export";
  unsafeImageGeneration.response.signedUrl =
    "https://example.com/image.png?token=sk-nested-model-response-should-not-export";
  unsafeImageGeneration.response.auth_cookie = "sk-nested-model-response-cookie-should-not-export";
  fs.writeFileSync(imageGenerationConfigPath, JSON.stringify(imageGenerationConfig, null, 2), "utf8");
  saveModelCapabilityOverride(rootDir, "deepseek-v4-pro", {
    inputModalities: ["text", "image"],
  });
  saveConfigProfile(rootDir, {
    id: "work-profile",
    name: "Work Profile",
    mode: MODE_HYBRID,
    selectedModelIds: ["deepseek-v4-pro"],
    desktopOptions: {
      routerPort: 15989,
      codexDesktopExe: "C:\\Users\\Administrator\\AppData\\Local\\Programs\\Codex\\Codex.exe",
      codexDesktopLaunchTarget: "C:\\Users\\Administrator\\Desktop\\Codex.lnk",
    },
  });
  saveDesktopOptions(rootDir, {
    acceptanceReleaseDir: "C:\\Users\\Administrator\\Downloads\\CodexBridgeRelease",
  });

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-config-package-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(path.join(codexDir, "skills", "demo"), { recursive: true });
  fs.writeFileSync(path.join(codexDir, "skills", "demo", "SKILL.md"), "# Demo\nUse when testing package previews.\n", "utf8");
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    [
      "[mcp_servers.node_repl]",
      'command = "C:/Codex/node_repl.exe"',
      '[plugins."github@openai-curated-remote"]',
      "enabled = true",
    ].join("\n"),
    "utf8",
  );

  const exported = exportConfigPackage(rootDir, {
    homeDir,
    codexCliSnapshot: codexCliAuthoritySnapshot({
      installedPlugins: [{ id: "github@openai-curated-remote", name: "GitHub", enabled: true }],
    }),
    codexPromptInputSnapshot: codexPromptSkillsSnapshot([{
      name: "demo",
      description: "Use when testing package previews.",
      path: path.join(codexDir, "skills", "demo", "SKILL.md"),
    }]),
  });
  const serialized = JSON.stringify(exported);

  assert.equal(exported.version, 1);
  assert.equal(exported.includesSecrets, false);
  assert.deepEqual(exported.selection.selectedModelIds, ["deepseek-v4-pro"]);
  assert.doesNotMatch(serialized, /sk-should-not-export/);
  assert.doesNotMatch(serialized, /sk-local-image-should-not-export/);
  assert.doesNotMatch(serialized, /sk-custom-model-should-not-export/);
  assert.doesNotMatch(serialized, /sk-image-provider-should-not-export/);
  assert.doesNotMatch(serialized, /sk-capability-provider-should-not-export/);
  assert.doesNotMatch(serialized, /sk-nested-image-header-should-not-export/);
  assert.doesNotMatch(serialized, /sk-nested-image-auth-token-should-not-export/);
  assert.doesNotMatch(serialized, /sk-nested-image-cookie-should-not-export/);
  assert.doesNotMatch(serialized, /sk-nested-capability-default-should-not-export/);
  assert.doesNotMatch(serialized, /sk-nested-capability-refresh-token-should-not-export/);
  assert.doesNotMatch(serialized, /sk-nested-capability-client-secret-should-not-export/);
  assert.doesNotMatch(serialized, /sk-nested-model-default-should-not-export/);
  assert.doesNotMatch(serialized, /sk-nested-model-bearer-token-should-not-export/);
  assert.doesNotMatch(serialized, /sk-nested-model-response-should-not-export/);
  assert.doesNotMatch(serialized, /sk-nested-model-response-cookie-should-not-export/);
  assert.doesNotMatch(serialized, /secrets.local/);
  assert.doesNotMatch(serialized, /lastTest|generated-images|sample\.png|Administrator|image-history|provider-logos/);
  assert.doesNotMatch(serialized, /private-contract|private-a|private-b|file-result|Documents|Pictures/);
  const exportedLocalFileProvider = exported.capabilityProviders.providers.find((provider) => provider.id === "local-file");
  assert.equal(exportedLocalFileProvider.defaults.action, "extract_text");
  assert.equal(exportedLocalFileProvider.defaults.maxCharacters, 6000);
  assert.equal(exportedLocalFileProvider.defaults.path, undefined);
  assert.equal(exportedLocalFileProvider.defaults.files, undefined);
  assert.equal(exportedLocalFileProvider.defaults.outputPath, undefined);
  assert.equal(exported.desktopOptions.routerPort, 15988);
  assert.equal(exported.desktopOptions.bypassSystemProxy, true);
  assert.equal(exported.desktopOptions.usageBudgets.global.dailyTokenLimit, 100000);
  assert.equal(exported.desktopOptions.usageBudgets.global.dailyCostLimit, 12.5);
  assert.equal(exported.desktopOptions.usageBudgets.providers.deepseek.dailyCostLimit, 8.75);
  assert.equal(exported.desktopOptions.usageBudgets.providers.deepseek.outputCostPerMillion, 2.25);
  assert.equal(exported.desktopOptions.usageBudgets.routes["cb-deepseek-v4-pro"].dailyTokenLimit, 50000);
  assert.deepEqual(exported.requiredSecretKeys, [
    "CUSTOM_API_KEY",
    "DEEPSEEK_API_KEY",
    "LOCAL_IMAGE_API_KEY",
    "OCR_API_KEY",
    "SILICONFLOW_API_KEY",
  ]);
  assert.equal(exported.desktopOptions.codexDesktopExe, undefined);
  assert.equal(exported.desktopOptions.codexDesktopLaunchTarget, undefined);
  assert.equal(exported.desktopOptions.acceptanceReleaseDir, undefined);
  assert.equal(exported.profiles[0].desktopOptions.routerPort, 15989);
  assert.equal(exported.profiles[0].desktopOptions.codexDesktopExe, undefined);
  assert.equal(exported.profiles[0].desktopOptions.codexDesktopLaunchTarget, undefined);
  assert.equal(exported.profiles[0].desktopOptions.acceptanceReleaseDir, undefined);

  const packageForImport = JSON.parse(JSON.stringify(exported));
  packageForImport.profiles[0].desktopOptions.codexDesktopExe = "C:\\Users\\Administrator\\Downloads\\Codex.exe";
  packageForImport.profiles[0].desktopOptions.codexDesktopLaunchTarget = "C:\\Users\\Administrator\\Desktop\\Codex.lnk";
  packageForImport.profiles[0].desktopOptions.acceptanceReleaseDir = "C:\\Users\\Administrator\\Downloads\\OldRelease";
  packageForImport.customModels[0].apiKey = "sk-imported-custom-model-should-not-import";
  packageForImport.imageProviders.providers[0].apiKey = "sk-imported-image-provider-should-not-import";
  packageForImport.imageProviders.providers[0].defaults.Authorization = "Bearer sk-imported-image-default-should-not-import";
  packageForImport.capabilityProviders.providers[0].apiKey = "sk-imported-capability-provider-should-not-import";
  packageForImport.capabilityProviders.providers[0].defaults.client_secret = "sk-imported-capability-default-should-not-import";
  packageForImport.modelImageGeneration["deepseek-v4-pro"].apiKey = "sk-imported-model-image-should-not-import";
  packageForImport.modelImageGeneration["deepseek-v4-pro"].defaults.access_token = "sk-imported-model-image-default-should-not-import";

  const targetRoot = makeTempProject();
  assert.throws(
    () => previewConfigPackageImport(targetRoot, packageForImport),
    (error) => error?.code === "CONFIG_PACKAGE_INVALID" &&
      error.issues.some((issue) => issue.path === "$.customModels[0].apiKey") &&
      !JSON.stringify(error).includes("sk-imported-custom-model-should-not-import"),
  );
  assert.equal(fs.existsSync(path.join(targetRoot, "config")), false);

  const preview = previewConfigPackageImport(targetRoot, exported);

  assert.equal(preview.ok, true);
  assert.deepEqual(preview.imported, [
    "模型选择",
    "桌面设置",
    "自定义模型",
    "供应商设置",
    "能力供应商",
    "图片供应商",
    "生图代理设置",
    "模型能力",
    "配置档",
    "用量预算",
    "Codex 资源清单",
  ]);
  assert.equal(preview.selectedModelCount, 1);
  assert.equal(preview.customModelCount, 1);
  assert.equal(preview.providerOverrideCount, 1);
  assert.equal(preview.imageProviderCount, 1);
  assert.equal(preview.capabilityProviderCount, 2);
  assert.equal(preview.profileCount, 1);
  assert.equal(preview.usageBudgetCount, 3);
  assert.equal(preview.codexResourceCount, 2);
  assert.deepEqual(preview.missingSecretKeys, [
    "CUSTOM_API_KEY",
    "DEEPSEEK_API_KEY",
    "LOCAL_IMAGE_API_KEY",
    "OCR_API_KEY",
    "SILICONFLOW_API_KEY",
  ]);
  assert.equal(fs.existsSync(path.join(targetRoot, "config")), false);

  const imported = importConfigPackage(targetRoot, exported);

  assert.equal(imported.ok, true);
  assert.match(imported.backupFileName, /^CodexBridge-config-before-import-\d{4}-\d{2}-\d{2}-\d+\.json$/);
  assert.equal(fs.existsSync(imported.backupPath), true);
  assert.match(imported.message, new RegExp(escapeRegExp(imported.backupFileName)));
  assert.deepEqual(imported.missingSecretKeys, [
    "CUSTOM_API_KEY",
    "DEEPSEEK_API_KEY",
    "LOCAL_IMAGE_API_KEY",
    "OCR_API_KEY",
    "SILICONFLOW_API_KEY",
  ]);
  assert.match(imported.message, /需要重填 Key：CUSTOM_API_KEY、DEEPSEEK_API_KEY、LOCAL_IMAGE_API_KEY、OCR_API_KEY、SILICONFLOW_API_KEY/);
  assert.deepEqual(readSelection(targetRoot, MODE_HYBRID), ["deepseek-v4-pro"]);
  const targetDesktopOptions = loadDesktopOptions(targetRoot);
  assert.equal(targetDesktopOptions.routerPort, 15988);
  assert.equal(targetDesktopOptions.usageBudgets.global.dailyTokenLimit, 100000);
  assert.equal(targetDesktopOptions.usageBudgets.global.dailyCostLimit, 12.5);
  assert.equal(targetDesktopOptions.usageBudgets.providers.deepseek.dailyCallLimit, 200);
  assert.equal(targetDesktopOptions.usageBudgets.providers.deepseek.dailyCostLimit, 8.75);
  assert.equal(targetDesktopOptions.usageBudgets.routes["cb-deepseek-v4-pro"].dailyTokenLimit, 50000);
  assert.equal(loadConfigProfiles(targetRoot)[0].desktopOptions.routerPort, 15989);
  const importedProfilesRaw = JSON.parse(fs.readFileSync(path.join(targetRoot, "config", "profiles.json"), "utf8"));
  assert.equal(importedProfilesRaw.profiles[0].desktopOptions.codexDesktopExe, undefined);
  assert.equal(importedProfilesRaw.profiles[0].desktopOptions.codexDesktopLaunchTarget, undefined);
  assert.equal(importedProfilesRaw.profiles[0].desktopOptions.acceptanceReleaseDir, undefined);
  assert.equal(readProviderOverrides(targetRoot).deepseek.name, "DeepSeek Proxy");
  assert.equal(readProviderOverrides(targetRoot).deepseek.logoUrl, undefined);
  assert.equal(readCustomModels(targetRoot)[0].model, "my-coder-v1");
  assert.equal(readCustomModels(targetRoot)[0].logoUrl, undefined);
  assert.equal(readCustomModels(targetRoot)[0].apiKey, undefined);
  assert.equal(readImageProviderConfig(targetRoot).defaultProviderId, "siliconflow-kolors");
  assert.equal(readImageProviderConfig(targetRoot).providers[0].lastTest, undefined);
  assert.equal(readImageProviderConfig(targetRoot).providers[0].defaults.batch_size, 1);
  assert.equal(readImageProviderConfig(targetRoot).providers[0].defaults.public_style, "clean");
  assert.equal(readImageProviderConfig(targetRoot).providers[0].defaults.authToken, undefined);
  assert.equal(readImageProviderConfig(targetRoot).providers[0].defaults.Authorization, undefined);
  assert.equal(readImageProviderConfig(targetRoot).providers[0].defaults.headers, undefined);
  assert.equal(readImageProviderConfig(targetRoot).providers[0].defaults.cookie, undefined);
  assert.equal(readCapabilityProviderConfig(targetRoot).defaults.ocr, "paddle-ocr");
  assert.equal(readCapabilityProviderConfig(targetRoot).providers[0].lastTest, undefined);
  assert.equal(readCapabilityProviderConfig(targetRoot).providers[0].defaults.language, "zh");
  assert.equal(readCapabilityProviderConfig(targetRoot).providers[0].defaults.api_key, undefined);
  assert.equal(readCapabilityProviderConfig(targetRoot).providers[0].defaults.refresh_token, undefined);
  assert.equal(readCapabilityProviderConfig(targetRoot).providers[0].defaults.client_secret, undefined);
  const importedLocalFileProvider = readCapabilityProviderConfig(targetRoot).providers.find((provider) => provider.id === "local-file");
  assert.equal(importedLocalFileProvider.defaults.action, "extract_text");
  assert.equal(importedLocalFileProvider.defaults.maxCharacters, 6000);
  assert.equal(importedLocalFileProvider.defaults.path, undefined);
  assert.equal(importedLocalFileProvider.defaults.files, undefined);
  assert.equal(importedLocalFileProvider.defaults.outputPath, undefined);
  const importedImageGeneration = readModelImageGenerationOverrides(targetRoot)["deepseek-v4-pro"];
  assert.equal(importedImageGeneration.mode, "custom");
  assert.equal(importedImageGeneration.apiKey, undefined);
  assert.equal(importedImageGeneration.outputDir, undefined);
  assert.equal(importedImageGeneration.historyPath, undefined);
  assert.equal(importedImageGeneration.apiKeyEnv, "LOCAL_IMAGE_API_KEY");
  assert.equal(importedImageGeneration.defaults.prompt_strength, 0.8);
  assert.equal(importedImageGeneration.defaults.access_token, undefined);
  assert.equal(importedImageGeneration.defaults.bearerToken, undefined);
  assert.equal(importedImageGeneration.response.imageUrlPath, "data[0].url");
  assert.equal(importedImageGeneration.response.signedUrl, undefined);
  assert.equal(importedImageGeneration.response.auth_cookie, undefined);
  assert.deepEqual(readModelCapabilityOverrides(targetRoot)["deepseek-v4-pro"].inputModalities, ["text", "image"]);
  assert.equal(secretStatus(targetRoot).DEEPSEEK_API_KEY, false);
  assert.equal(readRouterConfig(targetRoot).models.some((model) => model.id === "cb-deepseek-v4-pro"), true);
});

test("config package import backs up the previous local config without secrets", () => {
  const sourceRoot = makeTempProject();
  saveSelection(sourceRoot, ["deepseek-v4-pro"], MODE_HYBRID);
  saveProviderOverride(sourceRoot, "deepseek", {
    name: "Imported DeepSeek",
    baseUrl: "https://proxy.example.com/v1",
  });
  const packageForImport = exportConfigPackage(sourceRoot, { includeCodexResources: false });

  const targetRoot = makeTempProject();
  saveSelection(targetRoot, ["codex-gpt-5-5"], MODE_HYBRID);
  saveProviderOverride(targetRoot, "deepseek", {
    name: "Old DeepSeek",
    baseUrl: "https://old.example.com/v1",
  });
  saveSecrets(targetRoot, {
    DEEPSEEK_API_KEY: "sk-target-should-not-be-backed-up",
  });

  const imported = importConfigPackage(targetRoot, packageForImport);

  assert.equal(imported.ok, true);
  assert.equal(fs.existsSync(imported.backupPath), true);
  assert.match(imported.backupFileName, /^CodexBridge-config-before-import-/);
  const backupStatus = readConfigPackageImportBackupStatus(targetRoot);
  assert.equal(backupStatus.ok, true);
  assert.equal(backupStatus.latestFileName, imported.backupFileName);
  assert.equal(backupStatus.backupCount, 1);
  const backupPackage = JSON.parse(fs.readFileSync(imported.backupPath, "utf8"));
  assert.equal(backupPackage.includesSecrets, false);
  assert.equal(backupPackage.backupReason, "before_config_package_import");
  assert.deepEqual(backupPackage.selection.selectedModelIds, ["codex-gpt-5-5"]);
  assert.equal(backupPackage.providerOverrides.deepseek.name, "Old DeepSeek");
  assert.doesNotMatch(JSON.stringify(backupPackage), /sk-target-should-not-be-backed-up/);
  assert.deepEqual(readSelection(targetRoot, MODE_HYBRID), ["deepseek-v4-pro"]);
  assert.equal(readProviderOverrides(targetRoot).deepseek.name, "Imported DeepSeek");
});

test("config package import backups can restore the latest local config without losing the current one", () => {
  const sourceRoot = makeTempProject();
  saveSelection(sourceRoot, ["deepseek-v4-pro"], MODE_HYBRID);
  saveProviderOverride(sourceRoot, "deepseek", {
    name: "Imported DeepSeek",
    baseUrl: "https://proxy.example.com/v1",
  });
  const packageForImport = exportConfigPackage(sourceRoot, { includeCodexResources: false });

  const targetRoot = makeTempProject();
  saveSelection(targetRoot, ["codex-gpt-5-5"], MODE_HYBRID);
  saveProviderOverride(targetRoot, "deepseek", {
    name: "Original DeepSeek",
    baseUrl: "https://original.example.com/v1",
  });

  const imported = importConfigPackage(targetRoot, packageForImport);
  assert.equal(latestConfigPackageImportBackupPath(targetRoot), imported.backupPath);
  assert.deepEqual(readSelection(targetRoot, MODE_HYBRID), ["deepseek-v4-pro"]);

  const restored = restoreLatestConfigPackageImportBackup(targetRoot);

  assert.equal(restored.ok, true);
  assert.equal(restored.restoredBackupFileName, imported.backupFileName);
  assert.notEqual(restored.backupFileName, imported.backupFileName);
  assert.match(restored.message, /已恢复导入前备份/);
  assert.doesNotMatch(restored.message, /Restored config|Current config/i);
  assert.deepEqual(readSelection(targetRoot, MODE_HYBRID), ["codex-gpt-5-5"]);
  assert.equal(readProviderOverrides(targetRoot).deepseek.name, "Original DeepSeek");
  const backupStatus = readConfigPackageImportBackupStatus(targetRoot);
  assert.equal(backupStatus.ok, true);
  assert.equal(backupStatus.backupCount, 2);
  assert.equal(backupStatus.latestFileName, restored.backupFileName);
});

test("config package local restore errors stay readable in Chinese", () => {
  const rootDir = makeTempProject();
  const settingsSource = fs.readFileSync(path.join(process.cwd(), "desktop", "settings.mjs"), "utf8");

  assert.throws(
    () => restoreLatestConfigPackageImportBackup(rootDir),
    /没有可恢复的导入前备份/,
  );
  assert.throws(
    () => importLatestConfigPackageFromSyncDirectory(rootDir),
    /没有可导入的同步目录配置包/,
  );
  assert.doesNotMatch(settingsSource, /Unable to create a unique config package import backup name/);
});

test("config packages preserve uploaded provider logos as data urls without local paths", () => {
  const rootDir = makeTempProject();
  const logoDir = path.join(rootDir, "config", "provider-logos");
  fs.mkdirSync(logoDir, { recursive: true });
  const logoPath = path.join(logoDir, "deepseek.png");
  fs.writeFileSync(logoPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const logoUrl = pathToFileURL(logoPath).href;

  saveProviderOverride(rootDir, "deepseek", {
    name: "DeepSeek Logo",
    baseUrl: "https://api.deepseek.com/v1",
    logoUrl,
  });
  saveCustomModel(rootDir, {
    providerId: "custom-logo",
    providerName: "Custom Logo",
    displayName: "Logo Coder",
    model: "logo-coder-v1",
    baseUrl: "https://api.example.com/v1",
    keyEnv: "CUSTOM_LOGO_API_KEY",
    logoUrl,
  });

  const exported = exportConfigPackage(rootDir);
  const serialized = JSON.stringify(exported);

  assert.doesNotMatch(serialized, new RegExp(escapeRegExp(path.resolve(rootDir))));
  assert.doesNotMatch(serialized, /provider-logos/);
  assert.match(exported.providerOverrides.deepseek.logoUrl, /^data:image\/png;base64,/);
  assert.match(exported.customModels[0].logoUrl, /^data:image\/png;base64,/);
  assert.equal(exported.embeddedLogoCount, 2);

  const targetRoot = makeTempProject();
  importConfigPackage(targetRoot, exported);

  assert.match(readProviderOverrides(targetRoot).deepseek.logoUrl, /^data:image\/png;base64,/);
  assert.match(readCustomModels(targetRoot)[0].logoUrl, /^data:image\/png;base64,/);
});

test("config packages can be exported to a sync directory without secrets", () => {
  const rootDir = makeTempProject();
  const syncDir = path.join(rootDir, "OneDrive-CodexBridge");
  fs.mkdirSync(syncDir, { recursive: true });
  saveSecrets(rootDir, {
    DEEPSEEK_API_KEY: "deepseek-secret-value",
  });
  saveSelection(rootDir, ["deepseek-v4-pro"], MODE_HYBRID);

  const result = exportConfigPackageToDirectory(rootDir, syncDir, {
    now: () => new Date("2026-07-05T12:34:56.789Z"),
  });

  assert.equal(result.ok, true);
  assert.equal(result.directory, syncDir);
  assert.match(path.basename(result.filePath), /^CodexBridge-config-2026-07-05-123456789\.json$/);
  assert.equal(fs.existsSync(result.filePath), true);
  const serialized = fs.readFileSync(result.filePath, "utf8");
  const exported = JSON.parse(serialized);
  assert.equal(exported.includesSecrets, false);
  assert.deepEqual(exported.selection.selectedModelIds, ["deepseek-v4-pro"]);
  assert.deepEqual(exported.secretKeys, ["DEEPSEEK_API_KEY"]);
  assert.doesNotMatch(serialized, /deepseek-secret-value/);

  const syncStatusPath = configPackageSyncStatusPath(rootDir);
  assert.equal(fs.existsSync(syncStatusPath), true);
  const syncStatus = JSON.parse(fs.readFileSync(syncStatusPath, "utf8"));
  assert.equal(syncStatus.directory, syncDir);
  assert.equal(syncStatus.filePath, result.filePath);
  assert.equal(syncStatus.fileName, path.basename(result.filePath));
  assert.equal(syncStatus.selectedModelCount, 1);
  assert.equal(syncStatus.requiredSecretKeyCount, 1);
  assert.doesNotMatch(JSON.stringify(syncStatus), /deepseek-secret-value/);

  const publicStatus = readConfigPackageSyncStatus(rootDir);
  assert.equal(publicStatus.ok, true);
  assert.equal(publicStatus.fileName, path.basename(result.filePath));
  assert.equal(publicStatus.directoryName, "OneDrive-CodexBridge");
  assert.equal(publicStatus.fileExists, true);
  assert.equal(publicStatus.selectedModelCount, 1);
  assert.equal(publicStatus.requiredSecretKeyCount, 1);
  assert.equal(publicStatus.filePath, undefined);
  assert.equal(publicStatus.directory, undefined);
  assert.doesNotMatch(JSON.stringify(publicStatus), new RegExp(escapeRegExp(rootDir)));
  assert.equal(configPackageSyncDirectory(rootDir), path.resolve(syncDir));
});

test("config packages can be imported from the latest sync-directory export with a local backup", () => {
  const sourceRoot = makeTempProject();
  const syncDir = path.join(sourceRoot, "OneDrive-CodexBridge");
  fs.mkdirSync(syncDir, { recursive: true });
  saveSelection(sourceRoot, ["deepseek-v4-pro"], MODE_HYBRID);
  saveProviderOverride(sourceRoot, "deepseek", {
    name: "Synced DeepSeek",
    baseUrl: "https://sync.example.com/v1",
  });
  const exported = exportConfigPackageToDirectory(sourceRoot, syncDir, {
    now: () => new Date("2026-07-05T12:34:56.789Z"),
  });

  assert.equal(latestConfigPackageSyncPackagePath(sourceRoot), exported.filePath);

  const targetRoot = makeTempProject();
  fs.mkdirSync(path.dirname(configPackageSyncStatusPath(targetRoot)), { recursive: true });
  fs.copyFileSync(configPackageSyncStatusPath(sourceRoot), configPackageSyncStatusPath(targetRoot));
  saveSelection(targetRoot, ["codex-gpt-5-5"], MODE_HYBRID);
  saveProviderOverride(targetRoot, "deepseek", {
    name: "Target DeepSeek",
    baseUrl: "https://target.example.com/v1",
  });

  const imported = importLatestConfigPackageFromSyncDirectory(targetRoot);

  assert.equal(imported.ok, true);
  assert.equal(imported.sourceFileName, path.basename(exported.filePath));
  assert.match(imported.message, /已从同步目录导入配置包/);
  assert.doesNotMatch(imported.message, /Imported config|Current config/i);
  assert.equal(fs.existsSync(imported.backupPath), true);
  assert.deepEqual(readSelection(targetRoot, MODE_HYBRID), ["deepseek-v4-pro"]);
  assert.equal(readProviderOverrides(targetRoot).deepseek.name, "Synced DeepSeek");
  const backupPackage = JSON.parse(fs.readFileSync(imported.backupPath, "utf8"));
  assert.deepEqual(backupPackage.selection.selectedModelIds, ["codex-gpt-5-5"]);
  assert.equal(backupPackage.providerOverrides.deepseek.name, "Target DeepSeek");
});

test("release preflight reports sync-directory config package evidence without full local paths", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-sync-preflight-"));
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  const syncDir = path.join(rootDir, "OneDrive-CodexBridge");
  fs.mkdirSync(syncDir, { recursive: true });
  saveSelection(rootDir, ["deepseek-v4-pro"], MODE_HYBRID);
  exportConfigPackageToDirectory(rootDir, syncDir, {
    now: () => new Date("2026-07-05T12:34:56.789Z"),
    homeDir,
    codexCliSnapshot: codexCliAuthoritySnapshot(),
    codexPromptInputSnapshot: codexPromptSkillsSnapshot(),
  });

  const check = buildStartupCheck(rootDir, {
    homeDir,
    routerRunning: true,
    lastHealth: { ok: true, models: [], unhealthyRoutes: 0, routes: [] },
    config: { models: [] },
    codexCliSnapshot: codexCliAuthoritySnapshot(),
    codexPromptInputSnapshot: codexPromptSkillsSnapshot(),
  });
  const item = check.items.find((entry) => entry.id === "config_package");

  assert.equal(item.status, "pass");
  assert.match(item.detail, /配置包/);
  assert.match(item.detail, /API Key 不会写进配置包/);
  assert.doesNotMatch(item.detail, new RegExp(escapeRegExp(rootDir)));
  assert.match(item.action, /导出|迁移|重新填写/);
});

test("config package import rejects packages that declare embedded secrets", () => {
  const sourceRoot = makeTempProject();
  saveCustomModel(sourceRoot, {
    providerName: "Secret Provider",
    displayName: "Secret Model",
    model: "secret-model",
    baseUrl: "https://api.example.com/v1",
    keyEnv: "SECRET_MODEL_API_KEY",
  });
  const packageWithSecrets = {
    ...exportConfigPackage(sourceRoot),
    includesSecrets: true,
    customModels: [
      {
        providerName: "Secret Provider",
        displayName: "Secret Model",
        model: "secret-model",
        baseUrl: "https://api.example.com/v1",
        keyEnv: "SECRET_MODEL_API_KEY",
        apiKey: "sk-import-should-never-touch-target",
      },
    ],
  };
  const targetRoot = makeTempProject();

  assert.throws(
    () => importConfigPackage(targetRoot, packageWithSecrets),
    /配置包声明包含内嵌密钥|不含 API Key/,
  );
  assert.deepEqual(readCustomModels(targetRoot), []);
  assert.equal(fs.existsSync(path.join(targetRoot, "config", "secrets.local.json")), false);
});

test("config package export self-validates and fails closed without reflecting invalid values", () => {
  const rootDir = makeTempProject();
  const invalidMode = "synthetic-invalid-export-mode";

  assert.throws(
    () => exportConfigPackage(rootDir, {
      mode: invalidMode,
      includeCodexResources: false,
    }),
    (error) => {
      assert.equal(error.code, "CONFIG_PACKAGE_INVALID");
      assert.doesNotMatch(error.message, new RegExp(invalidMode));
      assert.doesNotMatch(JSON.stringify(error.issues || []), new RegExp(invalidMode));
      return true;
    },
  );
});

test("config packages include a portable Codex resource manifest without auto-enabling resources", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(path.join(codexDir, "skills", "demo"), { recursive: true });
  fs.writeFileSync(path.join(codexDir, "skills", "demo", "SKILL.md"), "# Demo\nUse when testing portable resources.\n", "utf8");
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    [
      "[mcp_servers.node_repl]",
      'command = "C:/Codex/node_repl.exe"',
      '[plugins."github@openai-curated-remote"]',
      "enabled = true",
    ].join("\n"),
    "utf8",
  );

  const exported = exportConfigPackage(rootDir, {
    homeDir,
    codexCliSnapshot: codexCliAuthoritySnapshot({
      installedPlugins: [{ id: "github@openai-curated-remote", name: "GitHub", enabled: true }],
    }),
    codexPromptInputSnapshot: codexPromptSkillsSnapshot([{
      name: "demo",
      description: "Use when testing portable resources.",
      path: path.join(codexDir, "skills", "demo", "SKILL.md"),
    }]),
  });

  assert.equal(exported.codexResources?.portableOnly, true);
  assert.equal(exported.codexResources?.summary?.mcpServers, 0);
  assert.equal(exported.codexResources?.summary?.plugins, 1);
  assert.equal(exported.codexResources?.summary?.skills, 1);
  assert.deepEqual(exported.codexResources?.mcpServers.map((item) => item.name), []);
  assert.deepEqual(exported.codexResources?.plugins.map((item) => item.id), ["github@openai-curated-remote"]);
  assert.deepEqual(exported.codexResources?.skills.map((item) => item.name), ["demo"]);
  assert.doesNotMatch(JSON.stringify(exported), /node_repl\.exe/);

  const targetHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-target-home-"));
  const targetCodexDir = path.join(targetHomeDir, ".codex");
  fs.mkdirSync(targetCodexDir, { recursive: true });
  fs.writeFileSync(path.join(targetCodexDir, "config.toml"), "", "utf8");
  const imported = importConfigPackage(makeTempProject(), exported, { homeDir: targetHomeDir });

  assert.match(imported.message, /Codex 资源清单/);
  assert.doesNotMatch(fs.readFileSync(path.join(targetCodexDir, "config.toml"), "utf8"), /github@openai-curated-remote|node_repl/);
});

test("backup center lists and restores a selected Codex config backup", async () => {
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

  const restored = await restoreCodexConfigFromBackup(backup, {
    homeDir,
    coordinator: codexRestoreCoordinator(homeDir),
  });
  assert.equal(restored.backup, backup);
  assert.ok(restored.currentBackup);
  assert.equal(typeof restored.configRevision, "string");
  assert.equal(fs.readFileSync(target, "utf8"), 'model = "backup"\n');
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(fs.statSync(restored.currentBackup).mode & 0o777, 0o600);
  }
});

test("Codex config restore reads the selected backup through one stable file handle", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const target = path.join(codexDir, "config.toml");
  const backup = path.join(codexDir, "config.toml.codexbridge.2026-07-01-020202000.bak");
  const parked = `${backup}.parked-test`;
  const trusted = Buffer.from('model = "trusted"\n', "utf8");
  const attacker = Buffer.from('model = "pwned!!"\n', "utf8");
  fs.writeFileSync(target, 'model = "current"\n', "utf8");
  fs.writeFileSync(backup, trusted);
  const identity = fs.lstatSync(backup);
  const originalReadSync = fs.readSync;
  let swapped = false;

  fs.readSync = function injectedRestoreSwap(source, ...args) {
    const opened = fs.fstatSync(source);
    const readsBackup = opened.dev === identity.dev && opened.ino === identity.ino;
    if (!swapped && readsBackup) {
      swapped = true;
      fs.renameSync(backup, parked);
      fs.writeFileSync(backup, attacker);
      try {
        return originalReadSync.call(fs, source, ...args);
      } finally {
        fs.unlinkSync(backup);
        fs.renameSync(parked, backup);
      }
    }
    return originalReadSync.call(fs, source, ...args);
  };

  try {
    await assert.rejects(
      restoreCodexConfigFromBackup(backup, {
        homeDir,
        coordinator: codexRestoreCoordinator(homeDir),
      }),
      (error) => error?.code === "config_transaction_failed",
    );
  } finally {
    fs.readSync = originalReadSync;
    if (fs.existsSync(parked)) {
      fs.renameSync(parked, backup);
    }
  }

  assert.equal(swapped, true);
  assert.deepEqual(fs.readFileSync(target), Buffer.from('model = "current"\n', "utf8"));
  assert.deepEqual(fs.readFileSync(backup), trusted);
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
  fs.mkdirSync(
    path.join(homeDir, ".codex", "plugins", "cache", "openai-curated", "game-studio", "3fdeeb49", "skills", "game-studio"),
    { recursive: true },
  );
  fs.mkdirSync(path.join(homeDir, ".codex", "prompts"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, ".codex", "prompts"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".codex", "skills", "demo", "SKILL.md"), "# Demo\nUse when testing local skills.\n", "utf8");
  fs.writeFileSync(path.join(homeDir, ".agents", "skills", "agent-demo", "SKILL.md"), "# Agent Demo\nUse when testing agent skills.\n", "utf8");
  fs.writeFileSync(
    path.join(homeDir, ".codex", "plugins", "cache", "openai-curated-remote", "github", "0.1.5", ".codex-plugin.json"),
    JSON.stringify({ name: "github", displayName: "GitHub", version: "0.1.5", description: "GitHub workflow tools" }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(homeDir, ".codex", "plugins", "cache", "openai-curated-remote", "github", "0.1.5", "skills", "gh-fix-ci", "SKILL.md"),
    [
      "---",
      "name: gh-fix-ci",
      "description: Fix failing GitHub Actions checks from Codex.",
      "---",
      "",
      "# GH Fix CI",
      "Use this when CI is failing.",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(homeDir, ".codex", "plugins", "cache", "personal", "cowart", "0.1.3", ".codex-plugin.json"),
    JSON.stringify({ name: "cowart", version: "0.1.3" }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(homeDir, ".codex", "plugins", "cache", "personal", "cowart", "0.1.3", "skills", "cowart-open-canvas", "SKILL.md"),
    [
      "---",
      "name: cowart-open-canvas",
      "description: Open the Cowart canvas for visual work.",
      "---",
      "",
      "# Cowart Open Canvas",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(homeDir, ".codex", "plugins", "cache", "openai-curated", "game-studio", "3fdeeb49", ".codex-plugin.json"),
    JSON.stringify({ name: "game-studio", displayName: "Game Studio", version: "3fdeeb49", description: "Build browser games." }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(homeDir, ".codex", "plugins", "cache", "openai-curated", "game-studio", "3fdeeb49", "skills", "game-studio", "SKILL.md"),
    [
      "---",
      "name: game-studio",
      "description: Route early browser-game work.",
      "---",
      "",
      "# Game Studio",
    ].join("\n"),
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
      '[plugins."game-studio@openai-curated"]',
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

  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: codexCliAuthoritySnapshot({
      installedPlugins: [
        { id: "browser@openai-bundled", name: "Browser", enabled: true },
        {
          id: "game-studio@openai-curated",
          name: "Game Studio",
          enabled: true,
          path: path.join(homeDir, ".codex", "plugins", "cache", "openai-curated", "game-studio", "3fdeeb49"),
        },
      ],
    }),
    codexPromptInputSnapshot: codexPromptSkillsSnapshot([{
      name: "demo",
      description: "Use when testing local skills.",
      path: path.join(homeDir, ".codex", "skills", "demo", "SKILL.md"),
    }]),
  });

  assert.equal(resources.summary.mcpServers, 0);
  assert.equal(resources.summary.plugins, 3);
  assert.equal(resources.summary.skills, 1);
  assert.equal(resources.summary.prompts, 2);
  assert.equal(resources.summary.agentFiles, 1);
  const nodeReplMcp = resources.discovered.mcpServers.find((item) => item.name === "node_repl");
  assert.equal(nodeReplMcp.name, "node_repl");
  assert.match(nodeReplMcp.description, /MCP/);
  assert.match(nodeReplMcp.purpose, /MCP|node_repl/i);
  assert.deepEqual(nodeReplMcp.diagnostic, {
    status: "warn",
    label: "配置未确认",
    detail: "这个 MCP 写在 Codex 配置里，但 Codex 官方列表没有确认当前可用。",
  });
  assert.deepEqual(nodeReplMcp.management, {
    toggleable: true,
    toggleKind: "mcp",
    id: "node_repl",
    nextEnabled: false,
    actionLabel: "停用",
    updateable: false,
    note: "只在 config.toml 里看到，Codex 官方列表没有确认；建议重启 Codex 或检查配置来源。",
  });
  assert.equal(resources.mcpServers.some((item) => item.name === "node_repl.env"), false);
  assert.equal(resources.mcpServers.some((item) => item.name === "disabled_server"), false);
  assert.ok(resources.plugins.some((item) =>
    item.id === "game-studio@openai-curated" &&
    item.name === "Game Studio" &&
    item.description === "Build browser games." &&
    /Build browser games|plugin/i.test(item.purpose || "") &&
    item.diagnostic?.label === "已安装" &&
    item.management.toggleable === true,
  ));
  assert.equal(resources.plugins.some((item) => item.id === "github@openai-curated-remote"), true);
  assert.equal(resources.plugins.some((item) => item.id === "browser@openai-bundled"), true);
  assert.equal(resources.plugins.some((item) => item.id === "cowart@personal"), false);
  const marketplacePlugin = resources.plugins.find((item) => item.id === "github@openai-curated-remote");
  const internalPlugin = resources.plugins.find((item) => item.id === "browser@openai-bundled");
  const cachedPlugin = resources.discovered.plugins.find((item) => item.id === "cowart@personal");
  const disabledPlugin = resources.discovered.plugins.find((item) => item.id === "disabled@personal");
  assert.equal(marketplacePlugin.name, "GitHub");
  assert.equal(marketplacePlugin.description, "GitHub workflow tools");
  assert.equal(marketplacePlugin.availability, "remote_installed");
  assert.deepEqual(marketplacePlugin.diagnostic, {
    status: "pass",
    label: "已安装",
    detail: "正式插件缓存和 manifest 已确认；prompt 探测只表示当前任务是否已加载。",
  });
  assert.equal(marketplacePlugin.management.toggleable, false);
  assert.match(marketplacePlugin.management.note, /正式插件缓存/);
  assert.equal(internalPlugin.availability, "internal");
  assert.equal(internalPlugin.diagnostic.label, "内置运行能力");
  assert.equal(internalPlugin.management.toggleable, true);
  assert.equal(internalPlugin.management.nextEnabled, false);
  assert.match(internalPlugin.management.note, /内置运行能力/);
  assert.equal(cachedPlugin.availability, "cached");
  assert.equal(cachedPlugin.management.toggleable, false);
  assert.match(cachedPlugin.management.note, /只是本地缓存/);
  assert.equal(disabledPlugin.availability, "disabled");
  assert.equal(disabledPlugin.diagnostic.label, "未启用");
  assert.equal(disabledPlugin.management.toggleable, true);
  assert.equal(disabledPlugin.management.nextEnabled, true);
  assert.equal(resources.skills[0].name, "demo");
  assert.equal(resources.skills[0].description, "Use when testing local skills.");
  assert.match(resources.skills[0].purpose, /Use when testing local skills|skill/i);
  assert.deepEqual(resources.skills[0].diagnostic, {
    status: "pass",
    label: "Codex 当前可见",
    detail: "这个技能来自 Codex prompt-input 快照，已经进入当前模型提示。",
  });
  assert.deepEqual(resources.skills[0].management, {
    toggleable: true,
    toggleKind: "skill",
    id: "demo",
    nextEnabled: false,
    actionLabel: "停用",
    updateable: false,
    note: "来自 Codex 当前模型提示；这才计入当前可用技能。",
  });
  assert.equal(resources.skills.some((item) => item.name === "agent-demo" && item.source === "agents"), false);
  assert.equal(resources.skills.some((item) => item.name === "gh-fix-ci" && item.source === "plugin"), false);
  const pluginSkill = resources.discovered.skills.find((item) => item.name === "game-studio" && item.availability === "plugin");
  assert.ok(resources.discovered.skills.some((item) => item.name === "agent-demo" && item.availability === "local"));
  const cachedMarketplaceSkill = resources.discovered.skills.find((item) => item.name === "gh-fix-ci" && item.availability === "plugin");
  const cachedSkill = resources.discovered.skills.find((item) => item.name === "cowart-open-canvas" && item.availability === "cached");
  assert.equal(pluginSkill.description, "Route early browser-game work.");
  assert.equal(cachedMarketplaceSkill.description, "Fix failing GitHub Actions checks from Codex.");
  assert.equal(cachedSkill.description, "Open the Cowart canvas for visual work.");
  assert.equal(pluginSkill.diagnostic.label, "跟随插件");
  assert.equal(cachedMarketplaceSkill.diagnostic.label, "跟随插件");
  assert.equal(pluginSkill.management.toggleable, false);
  assert.equal(pluginSkill.management.updateable, true);
  assert.equal(pluginSkill.management.updateAction, "update_plugin");
  assert.equal(pluginSkill.management.id, "game-studio@openai-curated");
  assert.match(pluginSkill.management.note, /跟随插件/);
  assert.equal(cachedMarketplaceSkill.management.toggleable, false);
  assert.match(cachedMarketplaceSkill.management.note, /跟随插件/);
  assert.equal(cachedSkill.management.toggleable, false);
  assert.match(cachedSkill.management.note, /插件未启用或只是缓存/);
  assert.equal(resources.prompts[0].name, "ship.md");
  assert.equal(resources.prompts[0].description, "可复用提示词文件。");
  assert.match(resources.prompts[0].purpose, /提示词|prompt/i);
  assert.equal(resources.agentFiles[0].description, "Codex 会读取的项目或用户规则文件。");
  assert.match(resources.agentFiles[0].purpose, /AGENTS|规则|Codex/i);
  assert.deepEqual(resources.breakdown.current, {
    mcpServers: {},
    plugins: { "openai-bundled": 1, "openai-curated": 1, "openai-curated-remote": 1 },
    skills: { codex: 1 },
    prompts: { codex: 1, project: 1 },
    agentFiles: { project: 1 },
    marketplaces: {},
  });
  assert.deepEqual(resources.breakdown.discovered.plugins, {
    disabled: 1,
    cached: 1,
  });
  assert.deepEqual(resources.breakdown.discovered.skills, {
    local: 1,
    plugin: 2,
    cached: 1,
  });
});

test("resource center surfaces installable marketplace plugins from Codex CLI snapshots", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".codex", "config.toml"), "", "utf8");

  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: {
      plugins: {
        ok: true,
        items: [
          {
            pluginId: "github@openai-curated-remote",
            name: "GitHub",
            description: "Triage PRs and issues.",
            marketplaceName: "openai-curated-remote",
            installed: false,
            enabled: false,
          },
        ],
      },
      mcpServers: {
        ok: true,
        items: [],
      },
    },
  });

  const installablePlugin = resources.discovered.plugins.find((item) => item.id === "github@openai-curated-remote");

  assert.equal(resources.summary.plugins, 0);
  assert.equal(resources.discoveredSummary.plugins, 1);
  assert.equal(installablePlugin.availability, "marketplace");
  assert.equal(installablePlugin.installed, false);
  assert.deepEqual(installablePlugin.diagnostic, {
    status: "info",
    label: "可安装",
    detail: "Codex 插件市场里有这个插件，但本机当前还没有安装启用。",
  });
  assert.equal(installablePlugin.management.toggleable, false);
  assert.equal(installablePlugin.management.updateable, true);
  assert.equal(installablePlugin.management.updateAction, "update_plugin");
  assert.equal(installablePlugin.management.updateLabel, "安装插件");
  assert.match(installablePlugin.management.note, /插件市场可见但尚未安装/);
});

test("resource center primary counts follow Codex CLI enabled resources instead of config candidates", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-settings-counts-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    [
      "[mcp_servers.node_repl]",
      'command = "C:/Codex/node_repl.exe"',
      "",
      "[mcp_servers.chatgpt-codex-bridge]",
      'url = "http://127.0.0.1:3000/mcp"',
      "",
      "[mcp_servers.openaiDeveloperDocs]",
      'url = "https://developers.openai.com/mcp"',
      "",
    ].join("\n"),
    "utf8",
  );

  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: {
      plugins: {
        ok: true,
        items: [
          { pluginId: "browser@openai-bundled", name: "Browser", installed: true, enabled: true },
          { pluginId: "latex@openai-bundled", name: "LaTeX", installed: false, enabled: false },
        ],
      },
      mcpServers: {
        ok: true,
        items: [
          { name: "node_repl", enabled: true },
          { name: "chatgpt-codex-bridge", enabled: true },
          { name: "openaiDeveloperDocs", enabled: true },
          { name: "plugin_runtime_one", enabled: true },
          { name: "plugin_runtime_two", enabled: true },
        ],
      },
    },
    codexPromptInputSnapshot: codexPromptSkillsSnapshot(),
  });

  assert.deepEqual(resources.plugins.map((item) => item.id), ["browser@openai-bundled"]);
  assert.deepEqual(resources.mcpServers.map((item) => item.name), [
    "node_repl",
    "chatgpt-codex-bridge",
    "openaiDeveloperDocs",
    "plugin_runtime_one",
    "plugin_runtime_two",
  ]);
  assert.equal(resources.summary.plugins, 1);
  assert.equal(resources.summary.mcpServers, 5);
  assert.ok(resources.discovered.plugins.some((item) => item.id === "latex@openai-bundled"));
  assert.equal(resources.discovered.mcpServers.some((item) => item.name === "node_repl"), false);
  assert.equal(resources.discovered.mcpServers.some((item) => item.name === "plugin_runtime_one"), false);
});

test("resource center enriches marketplace plugin details from Codex CLI source manifests", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const pluginPath = path.join(homeDir, ".codex", ".tmp", "plugins", "plugins", "github");
  fs.mkdirSync(path.join(pluginPath, ".codex-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(pluginPath, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name: "github",
      version: "0.1.6",
      description: "Inspect repositories, triage pull requests and issues, debug CI, and publish changes.",
      interface: {
        displayName: "GitHub",
        shortDescription: "Triage PRs, issues, CI, and publish flows",
        longDescription: "Use GitHub to inspect repositories, review pull requests, address feedback, and debug failing Actions checks.",
        developerName: "OpenAI",
        category: "Developer Tools",
        capabilities: ["Interactive", "Write"],
        websiteURL: "https://github.com/",
      },
    }),
    "utf8",
  );

  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: {
      plugins: {
        ok: true,
        items: [
          {
            pluginId: "github@openai-curated",
            name: "github",
            marketplaceName: "openai-curated",
            version: "0.1.6",
            installed: false,
            enabled: false,
            source: { source: "local", path: pluginPath },
            marketplaceSource: { sourceType: "local", source: "openai-curated" },
            installPolicy: "AVAILABLE",
            authPolicy: "ON_INSTALL",
          },
        ],
      },
      mcpServers: { ok: true, items: [] },
    },
  });

  const plugin = resources.discovered.plugins.find((item) => item.id === "github@openai-curated");

  assert.equal(plugin.name, "GitHub");
  assert.equal(plugin.description, "Triage PRs, issues, CI, and publish flows");
  assert.match(plugin.purpose, /review pull requests/);
  assert.deepEqual(
    plugin.details.map((item) => item.value),
    [
      "github@openai-curated",
      "openai-curated",
      "未安装 / 市场候选",
      "0.1.6",
      "Developer Tools",
      "Interactive, Write",
      "本地目录",
      "OpenAI",
    ],
  );
});

test("Codex CLI resource snapshot includes available marketplace plugins", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const fakeCliScript = path.join(homeDir, "fake-codex-cli.cjs");
  fs.writeFileSync(
    fakeCliScript,
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'plugin' && args[1] === 'list') {",
      "  console.log(JSON.stringify({",
      "    installed: [{ pluginId: 'github@openai-curated-remote', name: 'GitHub', marketplaceName: 'openai-curated-remote', installed: true, enabled: true }],",
      "    available: [{ pluginId: 'supabase@openai-curated-remote', name: 'Supabase', marketplaceName: 'openai-curated-remote', installed: false, enabled: false }]",
      "  }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'mcp' && args[1] === 'list') {",
      "  console.log(JSON.stringify([]));",
      "  process.exit(0);",
      "}",
      "process.exit(9);",
    ].filter(Boolean).join("\n"),
    "utf8",
  );
  fs.chmodSync(fakeCliScript, 0o755);
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    [
      "[mcp_servers.node_repl.env]",
      `CODEX_CLI_PATH = "${toFixtureTomlPath(process.execPath)}"`,
      "",
    ].join("\n"),
    "utf8",
  );

  const snapshot = readCodexCliResourceSnapshot({
    homeDir,
    timeoutMs: 5000,
    cacheMs: 0,
    codexCliArgsPrefix: [fakeCliScript],
  });
  const resources = listCodexResources({ rootDir, homeDir, codexCliSnapshot: snapshot });

  assert.equal(snapshot.plugins.ok, true);
  assert.deepEqual(snapshot.plugins.items.map((item) => item.pluginId), [
    "github@openai-curated-remote",
    "supabase@openai-curated-remote",
  ]);
  assert.equal(resources.summary.plugins, 1);
  assert.equal(resources.plugins[0].id, "github@openai-curated-remote");
  assert.equal(
    resources.discovered.plugins.find((item) => item.id === "supabase@openai-curated-remote")?.availability,
    "marketplace",
  );
});

test("Codex CLI resource snapshot requests uninstalled marketplace plugins", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const fakeCliScript = path.join(homeDir, "fake-codex-cli.mjs");
  const logPath = path.join(homeDir, "codex-cli-calls.jsonl");
  fs.writeFileSync(
    fakeCliScript,
    [
      "import fs from 'node:fs';",
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(process.env.CODEX_FAKE_LOG, JSON.stringify(args) + '\\n');",
      "if (args[0] === 'plugin' && args[1] === 'list' && args.includes('--available') && args.includes('--json')) {",
      "  console.log(JSON.stringify({ available: [{ pluginId: 'supabase@openai-curated-remote', name: 'Supabase', marketplaceName: 'openai-curated-remote', installed: false }] }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'plugin' && args[1] === 'list' && !args.includes('--available') && args.includes('--json')) {",
      "  console.log(JSON.stringify({ installed: [] }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'mcp' && args[1] === 'list' && args.includes('--json')) {",
      "  console.log(JSON.stringify([]));",
      "  process.exit(0);",
      "}",
      "process.exit(9);",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    [
      "[mcp_servers.node_repl.env]",
      `CODEX_CLI_PATH = "${toFixtureTomlPath(process.execPath)}"`,
      "",
    ].join("\n"),
    "utf8",
  );

  const snapshot = readCodexCliResourceSnapshot({
    homeDir,
    timeoutMs: 5000,
    cacheMs: 0,
    codexCliArgsPrefix: [fakeCliScript],
    env: { CODEX_FAKE_LOG: logPath },
  });
  const resources = listCodexResources({ rootDir, homeDir, codexCliSnapshot: snapshot });

  assert.equal(snapshot.plugins.ok, true);
  assert.equal(resources.discovered.plugins[0].id, "supabase@openai-curated-remote");
  assert.equal(resources.discovered.plugins[0].availability, "marketplace");
  const calls = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.deepEqual(calls[0], ["plugin", "list", "--json"]);
  assert.deepEqual(calls[1], ["plugin", "list", "--available", "--json"]);
});

test("Codex CLI resource snapshot counts short installed Codex setting plugins", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const fakeCliScript = path.join(homeDir, "fake-codex-cli.mjs");
  fs.writeFileSync(
    fakeCliScript,
    [
      "const args = process.argv.slice(2);",
      "if (args[0] === 'plugin' && args[1] === 'list' && !args.includes('--available') && args.includes('--json')) {",
      "  console.log(JSON.stringify({ installed: [",
      "    { id: 'github', name: 'GitHub', installed: true, enabled: true },",
      "    { id: 'supabase', name: 'Supabase', installed: true, enabled: true },",
      "    { id: 'remotion', name: 'Remotion', installed: true, enabled: true },",
      "    { id: 'superpowers', name: 'Superpowers', installed: true, enabled: true },",
      "    { id: 'hyperframes', name: 'HyperFrames by HeyGen', installed: true, enabled: true }",
      "  ] }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'plugin' && args[1] === 'list' && args.includes('--available') && args.includes('--json')) {",
      "  console.log(JSON.stringify({ available: [] }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'mcp' && args[1] === 'list') {",
      "  console.log(JSON.stringify([]));",
      "  process.exit(0);",
      "}",
      "process.exit(9);",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    [
      "[mcp_servers.node_repl.env]",
      `CODEX_CLI_PATH = "${toFixtureTomlPath(process.execPath)}"`,
      "",
    ].join("\n"),
    "utf8",
  );

  const snapshot = readCodexCliResourceSnapshot({
    homeDir,
    timeoutMs: 5000,
    cacheMs: 0,
    codexCliArgsPrefix: [fakeCliScript],
  });
  const resources = listCodexResources({ rootDir, homeDir, codexCliSnapshot: snapshot });

  assert.equal(snapshot.plugins.ok, true);
  assert.equal(resources.summary.plugins, 5);
  assert.deepEqual(resources.plugins.map((plugin) => plugin.id), [
    "github",
    "supabase",
    "remotion",
    "superpowers",
    "hyperframes",
  ]);
});

test("resource center still recognizes valid curated installs when CLI plugins are unavailable", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-plugin-cache-fallback-"));
  const codexDir = path.join(homeDir, ".codex");
  const pluginNames = ["github", "supabase", "remotion", "superpowers", "hyperframes"];
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, "config.toml"), "", "utf8");
  for (const pluginName of pluginNames) {
    const pluginPath = path.join(codexDir, "plugins", "cache", "openai-curated-remote", pluginName, "1.0.0");
    fs.mkdirSync(path.join(pluginPath, ".codex-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginPath, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: pluginName, version: "1.0.0" }),
      "utf8",
    );
  }
  const bundledPath = path.join(codexDir, "plugins", "cache", "openai-bundled", "computer-use", "26.0.0");
  fs.mkdirSync(path.join(bundledPath, ".codex-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(bundledPath, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "computer-use", version: "26.0.0" }),
    "utf8",
  );

  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: {
      plugins: { ok: false, items: [], error: "codex cli unavailable" },
      mcpServers: { ok: true, items: [] },
    },
  });

  assert.equal(resources.summary.plugins, null);
  assert.equal(resources.readStatus.plugins.state, "unavailable");
  assert.equal(resources.readStatus.plugins.reason, "codex cli unavailable");
  assert.deepEqual(resources.plugins.map((plugin) => plugin.id).sort(), pluginNames.map((name) => `${name}@openai-curated-remote`).sort());
  assert.equal(resources.plugins.find((plugin) => plugin.id === "github@openai-curated-remote")?.availability, "remote_installed");
  assert.equal(resources.discovered.plugins.find((plugin) => plugin.id === "computer-use@openai-bundled")?.availability, "cached");
});

test("resource center recognizes valid curated installs when Codex CLI installed list is empty", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-plugin-empty-cli-fallback-"));
  const codexDir = path.join(homeDir, ".codex");
  const pluginSources = new Map([
    ["github", "openai-curated-remote"],
    ["supabase", "openai-curated-remote"],
    ["remotion", "openai-curated"],
    ["superpowers", "openai-curated"],
    ["hyperframes", "openai-curated"],
    ["computer-use", "openai-bundled"],
  ]);
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, "config.toml"), "", "utf8");
  for (const [pluginName, pluginSource] of pluginSources) {
    const pluginPath = path.join(codexDir, "plugins", "cache", pluginSource, pluginName, "1.0.0");
    fs.mkdirSync(path.join(pluginPath, ".codex-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginPath, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: pluginName, version: "1.0.0" }),
      "utf8",
    );
  }

  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: {
      plugins: { ok: true, items: [] },
      mcpServers: { ok: true, items: [] },
    },
  });

  assert.equal(resources.summary.plugins, 2);
  assert.equal(resources.authority.plugins.source, "codex-cli");
  assert.deepEqual(resources.plugins.map((plugin) => plugin.id).sort(), [
    "github@openai-curated-remote",
    "supabase@openai-curated-remote",
  ]);
  assert.equal(resources.plugins.find((plugin) => plugin.id === "github@openai-curated-remote")?.availability, "remote_installed");
  assert.equal(resources.discovered.plugins.find((plugin) => plugin.id === "computer-use@openai-bundled")?.availability, "cached");
});

test("resource center keeps enabled configured plugins diagnostic-only when the official installed list is empty", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-plugin-config-fallback-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    [
      '[plugins."github@openai-curated-remote"]',
      "enabled = true",
      "",
      '[plugins."code-review@claude-plugins-official"]',
      "enabled = true",
      "",
      '[plugins."cowart@personal"]',
      "enabled = true",
      "",
      '[plugins."browser@openai-bundled"]',
      "enabled = true",
      "",
    ].join("\n"),
    "utf8",
  );

  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: {
      plugins: { ok: true, items: [] },
      mcpServers: { ok: true, items: [] },
    },
  });

  assert.equal(resources.summary.plugins, 0);
  assert.equal(resources.authority.plugins.source, "codex-cli");
  assert.deepEqual(resources.plugins.map((plugin) => plugin.id), []);
  assert.deepEqual(
    resources.discovered.plugins
      .filter((plugin) => plugin.availability === "config_only" || plugin.availability === "internal")
      .map((plugin) => plugin.id)
      .sort(),
    [
      "browser@openai-bundled",
      "code-review@claude-plugins-official",
      "cowart@personal",
      "github@openai-curated-remote",
    ],
  );
});

test("resource center keeps valid curated installs current when only internal plugins are configured", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-plugin-cache-with-internal-"));
  const codexDir = path.join(homeDir, ".codex");
  const pluginNames = ["github", "supabase", "remotion", "superpowers", "hyperframes"];
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    [
      '[plugins."browser@openai-bundled"]',
      "enabled = true",
      "",
    ].join("\n"),
    "utf8",
  );
  for (const pluginName of pluginNames) {
    const pluginPath = path.join(codexDir, "plugins", "cache", "openai-curated-remote", pluginName, "1.0.0");
    fs.mkdirSync(path.join(pluginPath, ".codex-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginPath, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: pluginName, version: "1.0.0" }),
      "utf8",
    );
  }

  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: {
      plugins: { ok: false, items: [], error: "codex cli unavailable" },
      mcpServers: { ok: true, items: [] },
    },
  });

  assert.equal(resources.summary.plugins, null);
  assert.deepEqual(resources.plugins.map((plugin) => plugin.id).sort(), pluginNames.map((name) => `${name}@openai-curated-remote`).sort());
  assert.equal(resources.plugins.find((plugin) => plugin.id === "github@openai-curated-remote")?.availability, "remote_installed");
  assert.equal(resources.discovered.plugins.find((plugin) => plugin.id === "browser@openai-bundled")?.availability, "internal");
});

test("resource center flags stale OpenAI bundled plugin cache and explains the update path", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  const installRoot = path.join(homeDir, "OpenAI.Codex_26.616.3767.0_x64");
  const resourcesDir = path.join(installRoot, "app", "resources");
  const nodeBinDir = path.join(resourcesDir, "cua_node", "bin");
  const nodeReplPath = path.join(nodeBinDir, "node_repl.exe");
  const codexCliPath = path.join(resourcesDir, "codex.exe");
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

  for (const filePath of [nodeReplPath, codexCliPath, bundledManifest, cachedManifest]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      filePath.endsWith("plugin.json")
        ? JSON.stringify({ name: "computer-use", version: filePath === bundledManifest ? "26.616.31447" : "26.611.62324" })
        : "",
      "utf8",
    );
  }

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
      "",
    ].join("\n"),
    "utf8",
  );

  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: codexCliAuthoritySnapshot({
      installedPlugins: [{
        id: "computer-use@openai-bundled",
        name: "computer-use",
        enabled: true,
        path: path.dirname(path.dirname(cachedManifest)),
      }],
    }),
    codexPromptInputSnapshot: codexPromptSkillsSnapshot(),
  });
  const plugin = resources.plugins.find((item) => item.id === "computer-use@openai-bundled");

  assert.ok(plugin);
  assert.equal(plugin.availability, "internal");
  assert.equal(plugin.runtime.stale, true);
  assert.equal(plugin.runtime.cached, "26.611.62324");
  assert.equal(plugin.runtime.bundled, "26.616.31447");
  assert.deepEqual(plugin.diagnostic, {
    status: "warn",
    label: "缓存过旧",
    detail: "Codex 内置 computer-use 是 26.616.31447，本机缓存还是 26.611.62324；旧缓存可能导致 Computer Use、Chrome 或浏览器能力异常。",
  });
  assert.equal(plugin.management.updateable, true);
  assert.equal(plugin.management.updateAction, "check_updates");
  assert.equal(plugin.management.updateLabel, "更新 Codex Desktop");
  assert.match(plugin.management.updateNote, /随 Codex Desktop 更新/);
  assert.match(plugin.management.note, /缓存过旧/);
});

test("resource center keeps enabled plugin skills in diagnostics instead of Codex skill counts", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  const pluginSkillDir = path.join(
    codexDir,
    "plugins",
    "cache",
    "openai-curated-remote",
    "github",
    "0.1.5",
    "skills",
    "gh-fix-ci",
  );
  fs.mkdirSync(pluginSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, "plugins", "cache", "openai-curated-remote", "github", "0.1.5", ".codex-plugin.json"),
    JSON.stringify({ name: "github", displayName: "GitHub", version: "0.1.5" }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginSkillDir, "SKILL.md"),
    [
      "---",
      "name: gh-fix-ci",
      "description: Fix failing GitHub Actions checks from Codex.",
      "---",
      "",
      "# GH Fix CI",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    [
      '[plugins."github@openai-curated-remote"]',
      "enabled = true",
      "",
    ].join("\n"),
    "utf8",
  );

  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: codexCliAuthoritySnapshot({
      installedPlugins: [{ id: "github@openai-curated-remote", name: "GitHub", enabled: true }],
    }),
    codexPromptInputSnapshot: codexPromptSkillsSnapshot(),
  });
  const pluginSkill = resources.discovered.skills.find((item) => item.name === "gh-fix-ci");

  assert.equal(resources.summary.skills, 0);
  assert.equal(pluginSkill?.source, "plugin");
  assert.equal(pluginSkill?.pluginSource, "openai-curated-remote");
  assert.equal(pluginSkill?.availability, "plugin");
  assert.equal(pluginSkill?.diagnostic.status, "pass");
  assert.equal(pluginSkill?.management.toggleable, false);
  assert.equal(resources.skills.some((item) => item.name === "gh-fix-ci"), false);
  assert.deepEqual(resources.breakdown.current.skills, {});
  assert.deepEqual(resources.breakdown.discovered.skills, { plugin: 1 });
}
);

test("resource center uses Codex prompt-input plugin skills as the current skill authority", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  const pluginSkillsRoot = path.join(
    codexDir,
    "plugins",
    "cache",
    "openai-curated-remote",
    "github",
    "0.1.5",
    "skills",
  );
  const visibleSkillDir = path.join(pluginSkillsRoot, "gh-fix-ci");
  const hiddenSkillDir = path.join(pluginSkillsRoot, "gh-address-comments");
  fs.mkdirSync(visibleSkillDir, { recursive: true });
  fs.mkdirSync(hiddenSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, "plugins", "cache", "openai-curated-remote", "github", "0.1.5", ".codex-plugin.json"),
    JSON.stringify({ name: "github", displayName: "GitHub", version: "0.1.5" }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(visibleSkillDir, "SKILL.md"),
    [
      "---",
      "name: gh-fix-ci",
      "description: Fix failing GitHub Actions checks from Codex.",
      "---",
      "",
      "# GH Fix CI",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(hiddenSkillDir, "SKILL.md"),
    "# GH Address Comments\nUse when addressing review comments.\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    [
      '[plugins."github@openai-curated-remote"]',
      "enabled = true",
      "",
    ].join("\n"),
    "utf8",
  );
  const promptRoot = pluginSkillsRoot.replace(/\\/g, "/");
  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: codexCliAuthoritySnapshot({
      installedPlugins: [{ id: "github@openai-curated-remote", name: "GitHub", enabled: true }],
    }),
    codexPromptInputSnapshot: {
      ok: true,
      items: [
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: [
                "<skills_instructions>",
                "### Skill roots",
                `- \`r0\` = \`${promptRoot}\``,
                "### Available skills",
                "- github:gh-fix-ci: Fix failing GitHub Actions checks from Codex. (file: r0/gh-fix-ci/SKILL.md)",
                "</skills_instructions>",
              ].join("\n"),
            },
          ],
        },
      ],
    },
  });

  assert.equal(resources.authority.skills.source, "codex-prompt-input");
  assert.equal(resources.summary.skills, 1);
  assert.deepEqual(resources.skills.map((item) => item.name), ["github:gh-fix-ci"]);
  const promptSkill = resources.skills.find((item) => item.name === "github:gh-fix-ci");
  assert.equal(promptSkill?.availability, "prompt");
  assert.equal(promptSkill?.source, "plugin");
  assert.equal(promptSkill?.pluginId, "github@openai-curated-remote");
  assert.equal(promptSkill?.pluginSource, "openai-curated-remote");
  assert.equal(promptSkill?.diagnostic.status, "pass");
  assert.equal(resources.discovered.skills.find((item) => item.name === "gh-address-comments")?.availability, "plugin");
  assert.deepEqual(resources.breakdown.current.skills, { "openai-curated-remote": 1 });
  assert.deepEqual(resources.breakdown.discovered.skills, { plugin: 1 });
});

test("resource center uses prompt-input visibility instead of local skill inventory for primary counts", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  const visibleSkillDir = path.join(codexDir, "skills", "visible-skill");
  const hiddenSkillDir = path.join(codexDir, "skills", "hidden-local-skill");
  fs.mkdirSync(visibleSkillDir, { recursive: true });
  fs.mkdirSync(hiddenSkillDir, { recursive: true });
  fs.writeFileSync(path.join(visibleSkillDir, "SKILL.md"), "# Visible\nUse when visible.\n", "utf8");
  fs.writeFileSync(path.join(hiddenSkillDir, "SKILL.md"), "# Hidden\nUse when hidden.\n", "utf8");

  const promptRoot = path.join(codexDir, "skills").replace(/\\/g, "/");
  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexPromptInputSnapshot: {
      ok: true,
      items: [
        {
          type: "message",
          role: "developer",
          content: [{
            type: "input_text",
            text: [
              "<skills_instructions>",
              "### Skill roots",
              `- \`r0\` = \`${promptRoot}\``,
              "### Available skills",
              "- visible-skill: Use when visible. (file: r0/visible-skill/SKILL.md)",
              "</skills_instructions>",
            ].join("\n"),
          }],
        },
      ],
    },
  });

  assert.equal(resources.authority.skills.source, "codex-prompt-input");
  assert.deepEqual(resources.skills.map((item) => item.name), ["visible-skill"]);
  assert.equal(resources.summary.skills, 1);
  assert.equal(
    resources.discovered.skills.find((item) => item.name === "hidden-local-skill")?.availability,
    "codex-local",
  );
  assert.deepEqual(resources.breakdown.current.skills, { codex: 1 });
});

test("resource center keeps local skills diagnostic-only when prompt-input is unavailable", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  const skillDir = path.join(codexDir, "skills", "local-only-skill");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Local Only\nUse when only local files are visible.\n", "utf8");

  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexPromptInputSnapshot: {
      ok: false,
      items: [],
      error: "codex debug prompt-input failed",
    },
  });

  assert.equal(resources.authority.skills.source, "codex-prompt-input");
  assert.equal(resources.summary.skills, null);
  assert.equal(resources.readStatus.skills.state, "unavailable");
  assert.deepEqual(resources.skills.map((item) => item.name), []);
  assert.equal(
    resources.discovered.skills.find((item) => item.name === "local-only-skill")?.availability,
    "codex-local",
  );
  assert.deepEqual(resources.breakdown.current.skills, {});
});

test("resource center waits long enough for Codex prompt input skill snapshots", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    [
      "[mcp_servers.node_repl.env]",
      `CODEX_CLI_PATH = "${process.execPath.replace(/\\/g, "/")}"`,
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(homeDir, "debug"),
    [
      "if (process.argv[2] !== 'prompt-input') process.exit(2);",
      "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4500);",
      "console.log(JSON.stringify([{",
      "  type: 'message',",
      "  role: 'developer',",
      "  content: [{",
      "    type: 'input_text',",
      "    text: '<skills_instructions>\\n### Available skills\\n- demo: Demo skill. (file: C:/demo/SKILL.md)\\n</skills_instructions>'",
      "  }]",
      "}]));",
    ].join("\n"),
    "utf8",
  );

  const snapshot = readCodexPromptInputSnapshot({ homeDir, cacheMs: 0 });

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.items.length, 1);
  assert.match(JSON.stringify(snapshot.items), /Available skills/);
});

test("resource center uses enabled installed CLI plugins and enabled CLI MCPs", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    [
      '[plugins."github@openai-curated-remote"]',
      "enabled = true",
      "",
      '[plugins."old-local@personal"]',
      "enabled = true",
      "",
      '[plugins."browser@openai-bundled"]',
      "enabled = true",
      "",
      "[mcp_servers.node_repl]",
      'command = "C:/Codex/node_repl.exe"',
      "",
      "[mcp_servers.config_only]",
      'command = "C:/Codex/config-only.exe"',
      "",
    ].join("\n"),
    "utf8",
  );

  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: {
      plugins: {
        ok: true,
        items: [
          {
            pluginId: "github@openai-curated-remote",
            name: "github",
            marketplaceName: "openai-curated-remote",
            version: "0.1.5",
            installed: true,
            enabled: true,
            source: { source: "local", path: "C:/Codex/github" },
          },
          {
            pluginId: "browser@openai-bundled",
            name: "browser",
            marketplaceName: "openai-bundled",
            version: "26.623.70822",
            installed: true,
            enabled: true,
            source: { source: "local", path: "C:/Codex/browser" },
          },
          {
            pluginId: "cowart@personal",
            name: "cowart",
            marketplaceName: "personal",
            version: "0.1.3",
            installed: true,
            enabled: false,
            source: { source: "local", path: "C:/Codex/cowart" },
          },
        ],
      },
      mcpServers: {
        ok: true,
        items: [
          {
            name: "node_repl",
            enabled: true,
            transport: { type: "stdio", command: "C:/Codex/node_repl.exe", args: [] },
          },
          {
            name: "plugin_mcp",
            enabled: true,
            transport: { type: "stdio", command: "C:/Codex/plugin-mcp.exe", args: ["serve"] },
          },
          {
            name: "disabled_cli",
            enabled: false,
            disabled_reason: "disabled by Codex",
            transport: { type: "stdio", command: "C:/Codex/disabled.exe", args: [] },
          },
        ],
      },
    },
    codexPromptInputSnapshot: codexPromptSkillsSnapshot(),
  });

  assert.equal(resources.summary.plugins, 2);
  assert.deepEqual(resources.plugins.map((item) => item.id), [
    "github@openai-curated-remote",
    "browser@openai-bundled",
  ]);
  assert.equal(resources.plugins.find((item) => item.id === "browser@openai-bundled")?.source, "codex-cli");
  const configOnlyPlugin = resources.discovered.plugins.find((item) => item.id === "old-local@personal");
  assert.equal(configOnlyPlugin?.availability, "config_only");
  assert.equal(configOnlyPlugin?.diagnostic.status, "warn");
  assert.equal(resources.discovered.plugins.find((item) => item.id === "cowart@personal")?.availability, "disabled");

  assert.equal(resources.summary.mcpServers, 2);
  assert.ok(resources.mcpServers.some((item) =>
    item.name === "node_repl" &&
    item.configured === true &&
    item.management.toggleable === true,
  ));
  assert.equal(resources.mcpServers.find((item) => item.name === "plugin_mcp")?.source, "codex-cli");
  assert.equal(resources.discovered.mcpServers.find((item) => item.name === "config_only")?.availability, "config_only");
  assert.equal(resources.discovered.mcpServers.find((item) => item.name === "disabled_cli")?.diagnostic.status, "warn");
});

test("resource center counts Codex installed plugins when CLI omits marketplaceName", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".codex", "config.toml"), "", "utf8");

  const pluginPath = path.join(homeDir, ".codex", ".tmp", "plugins", "plugins", "github");
  fs.mkdirSync(pluginPath, { recursive: true });

  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: {
      plugins: {
        ok: true,
        items: [
          {
            id: "github",
            name: "GitHub",
            installed: true,
            enabled: true,
            source: { source: "local", path: pluginPath },
          },
        ],
      },
      mcpServers: { ok: true, items: [] },
    },
  });

  assert.equal(resources.summary.plugins, 1);
  assert.equal(resources.plugins[0]?.id, "github");
  assert.equal(resources.plugins[0]?.pluginSource, "openai-curated");
});

test("resource center primary counts include valid curated installs but ignore bundled cache extras", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, "config.toml"), "", "utf8");

  for (const name of Array.from({ length: 15 }, (_, index) => `skill-${index + 1}`)) {
    const skillDir = path.join(codexDir, "skills", name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `# ${name}\nUse when testing ${name}.\n`, "utf8");
  }
  const cachedPluginDir = path.join(codexDir, "plugins", "cache", "openai-curated-remote", "cached-only", "0.0.1");
  fs.mkdirSync(path.join(cachedPluginDir, ".codex-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(cachedPluginDir, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "cached-only", displayName: "Cached Only" }),
    "utf8",
  );
  const bundledPluginDir = path.join(codexDir, "plugins", "cache", "openai-bundled", "browser", "26.1.0");
  fs.mkdirSync(path.join(bundledPluginDir, ".codex-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(bundledPluginDir, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "browser", displayName: "Browser" }),
    "utf8",
  );

  const skillLines = Array.from({ length: 15 }, (_, index) => {
    const name = `skill-${index + 1}`;
    return `- ${name}: Skill ${index + 1}. (file: ${path.join(codexDir, "skills", name, "SKILL.md")})`;
  });
  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: {
      plugins: {
        ok: true,
        items: [
          { id: "github", name: "GitHub", installed: true, enabled: true },
          { id: "supabase", name: "Supabase", installed: true, enabled: true },
          { id: "remotion", name: "Remotion", installed: true, enabled: true },
          { id: "superpowers", name: "Superpowers", installed: true, enabled: true },
          { id: "hyperframes", name: "HyperFrames by HeyGen", installed: true, enabled: true },
        ],
      },
      mcpServers: {
        ok: true,
        items: [{
          name: "node_repl",
          enabled: true,
          transport: { type: "stdio", command: "C:/Codex/node_repl.exe", args: [] },
        }],
      },
    },
    codexPromptInputSnapshot: {
      ok: true,
      items: [{
        type: "message",
        role: "developer",
        content: [{
          type: "input_text",
          text: [
            "<skills_instructions>",
            "### Available skills",
            ...skillLines,
            "</skills_instructions>",
          ].join("\n"),
        }],
      }],
    },
  });

  assert.equal(resources.summary.plugins, 6);
  assert.equal(resources.summary.mcpServers, 1);
  assert.equal(resources.summary.skills, 15);
  assert.ok(resources.plugins.some((item) => item.id === "cached-only@openai-curated-remote"));
  assert.equal(resources.discoveredSummary.plugins, 1);
  assert.equal(resources.discovered.plugins.some((item) => item.id === "cached-only@openai-curated-remote"), false);
  assert.ok(resources.discovered.plugins.some((item) => item.id === "browser@openai-bundled"));
  assert.equal(resources.discovered.skills.length, 0);
});

test("resource center mirrors ChatGPT plugin-page counts instead of runtime-wide inventories", () => {
  const rootDir = makeTempProject();
  fs.writeFileSync(path.join(rootDir, "AGENTS.md"), "# Fixture agent rules\n", "utf8");
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-plugin-page-counts-"));
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".codex", "config.toml"), "", "utf8");

  const installedPlugins = Array.from({ length: 11 }, (_, pluginIndex) => {
    const pluginPath = path.join(homeDir, "plugins", `plugin-${pluginIndex + 1}`);
    fs.mkdirSync(path.join(pluginPath, ".codex-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginPath, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: `plugin-${pluginIndex + 1}`,
        ...(pluginIndex === 0 ? { mcpServers: { plugin_mcp: { command: "node" } } } : {}),
      }),
      "utf8",
    );
    if (pluginIndex < 4) {
      fs.writeFileSync(
        path.join(pluginPath, ".app.json"),
        JSON.stringify({ apps: { [`fixture_app_${pluginIndex + 1}`]: { name: `Fixture App ${pluginIndex + 1}` } } }),
        "utf8",
      );
    }
    if (pluginIndex < 11) {
      const skillCount = pluginIndex < 8 ? 5 : 4;
      for (let skillIndex = 0; skillIndex < skillCount; skillIndex += 1) {
        const skillName = `plugin-${pluginIndex + 1}-skill-${skillIndex + 1}`;
        const skillPath = path.join(pluginPath, "skills", skillName);
        fs.mkdirSync(skillPath, { recursive: true });
        fs.writeFileSync(path.join(skillPath, "SKILL.md"), `# ${skillName}\nUse for fixture testing.\n`, "utf8");
      }
    }
    return {
      id: `plugin-${pluginIndex + 1}@fixture`,
      name: `Plugin ${pluginIndex + 1}`,
      path: pluginPath,
      installed: true,
      enabled: true,
    };
  });
  const promptSkills = Array.from({ length: 30 }, (_, index) => ({
    name: `prompt-skill-${index + 1}`,
    description: "Prompt-wide fixture skill.",
    path: path.join(homeDir, "prompt-skills", `prompt-skill-${index + 1}`, "SKILL.md"),
  }));
  const recommendedSkillsDir = path.join(homeDir, ".codex", "vendor_imports");
  fs.mkdirSync(recommendedSkillsDir, { recursive: true });
  fs.writeFileSync(
    path.join(recommendedSkillsDir, "skills-curated-cache.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      skills: ["plugin-page-skill-2", "plugin-page-skill-8", "plugin-page-skill-14"]
        .map((id) => ({ id, name: id, repoPath: `skills/.curated/${id}` })),
    }),
    "utf8",
  );
  const desktopVisiblePlugins = installedPlugins
    .filter((_plugin, index) => index !== 10)
    .map((plugin) => ({ ...plugin, desktopPageVisible: true }));

  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: {
      plugins: { ok: true, items: installedPlugins },
      mcpServers: {
        ok: true,
        items: [
          { name: "node_repl", enabled: true },
          { name: "sites-design-picker", enabled: true },
        ],
      },
    },
    codexPromptInputSnapshot: codexPromptSkillsSnapshot(promptSkills),
    codexAppServerSnapshot: {
      plugins: { ok: true, items: desktopVisiblePlugins },
      apps: {
        ok: true,
        items: [
          {
            id: "fixture_app_1",
            name: "Fixture App 1",
            pluginDisplayNames: ["plugin-1"],
            isAccessible: true,
            isEnabled: true,
          },
          {
            id: "fixture_app_2",
            name: "Fixture App 2",
            pluginDisplayNames: [],
            isAccessible: true,
            isEnabled: true,
          },
        ],
      },
      skills: {
        ok: true,
        items: [
          ...Array.from({ length: 19 }, (_, index) => ({
            name: `plugin-page-skill-${index + 1}`,
            displayName: `Plugin page skill ${index + 1}`,
            path: path.join(
              homeDir,
              ".codex",
              "skills",
              `plugin-page-skill-${index + 1}`,
              "SKILL.md",
            ),
            scope: "user",
            enabled: true,
          })),
          ...Array.from({ length: 52 }, (_, index) => ({
            name: `plugin-internal-skill-${index + 1}`,
            path: path.join(
              installedPlugins[index % installedPlugins.length].path,
              "skills",
              `plugin-internal-skill-${index + 1}`,
              "SKILL.md",
            ),
            scope: "user",
            enabled: true,
          })),
          {
            name: "system-only-skill",
            path: path.join(homeDir, ".codex", "skills", ".system", "system-only-skill", "SKILL.md"),
            scope: "system",
            enabled: true,
          },
        ],
      },
    },
  });

  assert.equal(resources.pluginPage.summary.plugins, 11);
  assert.equal(resources.pluginPage.summary.apps, 1);
  assert.equal(resources.pluginPage.summary.mcpServers, 1);
  assert.equal(resources.pluginPage.summary.skills, 19);
  assert.equal(resources.summary.agentFiles, 1);
  assert.equal(resources.pluginPage.plugins.length, 11);
  assert.equal(resources.pluginPage.diagnostics.cliInstalledPlugins, 11);
  assert.equal(resources.pluginPage.diagnostics.userSkills, 19);
  assert.equal(resources.pluginPage.diagnostics.plugins.find((item) => item.id === installedPlugins[10].id)?.desktopPageVisible, false);
  assert.equal(resources.pluginPage.diagnostics.plugins.find((item) => item.id === installedPlugins[10].id)?.cliInstalled, true);
  assert.deepEqual(resources.pluginPage.apps.map((item) => item.name), ["Fixture App 1"]);
  assert.deepEqual(resources.pluginPage.mcpServers.map((item) => item.name), ["plugin-1"]);
  assert.equal(resources.pluginPage.skills.every((item) => item.source === "codex-user-skill"), true);
  assert.deepEqual(
    resources.pluginPage.skills.map((item) => item.id),
    Array.from({ length: 19 }, (_, index) => `plugin-page-skill-${index + 1}`),
  );
  assert.equal(resources.pluginPage.diagnostics.manifestAppDeclarations, 4);
  assert.equal(resources.pluginPage.diagnostics.discoveredSkillFiles, 52);
});

test("resource center treats six valid curated cache plugins as installed without prompt visibility", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-runtime-plugin-merge-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, "config.toml"), "", "utf8");

  const bundledIds = ["sites", "browser", "chrome", "computer-use", "visualize"];
  const cliPlugins = bundledIds.map((name) => ({
    id: `${name}@openai-bundled`,
    name,
    installed: true,
    enabled: true,
  }));
  const remoteIds = ["github", "hyperframes", "openai-templates", "remotion", "supabase", "superpowers"];
  const promptSkills = [];
  for (const name of remoteIds) {
    const versions = name === "github" ? ["0.1.0", "0.2.0"] : ["1.0.0"];
    for (const version of versions) {
      const pluginPath = path.join(codexDir, "plugins", "cache", "openai-curated-remote", name, version);
      fs.mkdirSync(path.join(pluginPath, ".codex-plugin"), { recursive: true });
      fs.writeFileSync(
        path.join(pluginPath, ".codex-plugin", "plugin.json"),
        JSON.stringify({ name, version }),
        "utf8",
      );
      const skillPath = path.join(pluginPath, "skills", `${name}-skill`, "SKILL.md");
      fs.mkdirSync(path.dirname(skillPath), { recursive: true });
      fs.writeFileSync(skillPath, `# ${name}\n`, "utf8");
    }
  }

  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: {
      plugins: { ok: true, items: cliPlugins },
      mcpServers: { ok: true, items: [] },
    },
    codexPromptInputSnapshot: codexPromptSkillsSnapshot(promptSkills),
  });

  const installedIds = resources.pluginPage.plugins.map((item) => item.id).sort();
  assert.equal(installedIds.length, 11);
  assert.deepEqual(installedIds, [
    ...bundledIds.map((name) => `${name}@openai-bundled`),
    ...remoteIds.map((name) => `${name}@openai-curated-remote`),
  ].sort());
  assert.equal(resources.pluginPage.plugins.filter((item) => item.pluginSource === "openai-bundled").length, 5);
  const remoteInstalled = resources.pluginPage.plugins.filter((item) => item.availability === "remote_installed");
  assert.equal(remoteInstalled.length, 6);
  assert.equal(remoteInstalled.every((item) => item.installed === true && item.runtimeLoaded === false), true);
  assert.equal(remoteInstalled.every((item) => item.cliInstalled === false), true);
  assert.equal(remoteInstalled.every((item) => item.diagnostic?.label === "已安装"), true);
  assert.equal(resources.pluginPage.plugins.filter((item) => item.id === "github@openai-curated-remote").length, 1);
});

test("Codex app-server refresh keeps the last authoritative app snapshot when a later read is unavailable", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-app-server-last-good-"));
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  const rootDir = makeTempProject();
  let call = 0;
  const options = {
    rootDir,
    homeDir,
    cacheMs: 60_000,
    locatedCli: { found: true, cliTarget: "C:/fixture/codex.exe" },
    now: () => 50_000 + call,
    execFile: () => {
      call += 1;
      if (call === 1) {
        return JSON.stringify({
          ok: true,
          refreshedAt: "2026-07-12T00:00:00.000Z",
          plugins: { ok: true, items: [{ id: "sites@openai-bundled", installed: true, enabled: true }] },
          apps: { ok: true, items: [{ id: "connector_sites", name: "Sites", pluginDisplayNames: ["Sites"] }] },
          skills: { ok: true, items: [] },
        });
      }
      return JSON.stringify({
        ok: false,
        refreshedAt: "2026-07-12T00:00:01.000Z",
        plugins: { ok: false, items: [], code: "not_ready", error: "plugin service not ready" },
        apps: { ok: true, items: [], code: "ok" },
        skills: { ok: false, items: [], code: "not_ready", error: "skills not ready" },
      });
    },
  };

  const authoritative = readCodexAppServerResourceSnapshot(options);
  const retained = readCodexAppServerResourceSnapshot({ ...options, forceRefresh: true });

  assert.equal(authoritative.apps.items[0]?.name, "Sites");
  assert.equal(retained.apps.items[0]?.name, "Sites");
  assert.equal(retained.apps.stale, true);
  assert.equal(retained.apps.cached, true);
  assert.equal(retained.apps.refreshError.code, "empty_not_ready");
  assert.equal(retained.snapshotSource, "last_authoritative_cache");
});

test("ChatGPT Desktop plugin visibility policy follows the installed renderer selector", () => {
  const currentSelector = "function visible(plugin){return plugin.name !== `browser` && plugin.name !== 'legacy-lab'}";
  const futureSelector = "function visible(plugin){return Boolean(plugin && plugin.name)}";

  assert.deepEqual(
    hiddenPluginNamesFromDesktopSelectorSource(currentSelector),
    ["browser", "legacy-lab"],
  );
  assert.deepEqual(hiddenPluginNamesFromDesktopSelectorSource(futureSelector), []);
});

test("resource center counts Codex CLI installed plugins when snapshot only exposes display names", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-name-only-plugins-"));
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".codex", "config.toml"), "", "utf8");

  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: {
      plugins: {
        ok: true,
        items: [
          { name: "GitHub", installed: true, enabled: true },
          { name: "Supabase", installed: true, enabled: true },
          { name: "Remotion", installed: true, enabled: true },
          { name: "Superpowers", installed: true, enabled: true },
          { name: "HyperFrames by HeyGen", installed: true, enabled: true },
        ],
      },
      mcpServers: {
        ok: true,
        items: [],
      },
    },
  });

  assert.equal(resources.summary.plugins, 5);
  assert.deepEqual(resources.plugins.map((item) => item.id), [
    "github",
    "supabase",
    "remotion",
    "superpowers",
    "hyperframes-by-heygen",
  ]);
});

test("resource center reports which source controls each resource count", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  const skillDir = path.join(codexDir, "skills", "demo");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Demo\nUse when testing local skills.\n", "utf8");
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    [
      '[plugins."github@openai-curated-remote"]',
      "enabled = true",
      "",
      "[mcp_servers.node_repl]",
      'command = "C:/Codex/node_repl.exe"',
      "",
    ].join("\n"),
    "utf8",
  );

  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: {
      plugins: {
        ok: true,
        items: [{
          pluginId: "github@openai-curated-remote",
          name: "github",
          marketplaceName: "openai-curated-remote",
          installed: true,
          enabled: true,
        }],
      },
      mcpServers: {
        ok: true,
        items: [{
          name: "node_repl",
          enabled: true,
          transport: { type: "stdio", command: "C:/Codex/node_repl.exe", args: [] },
        }],
      },
    },
    codexPromptInputSnapshot: codexPromptSkillsSnapshot([{
      name: "demo",
      description: "Use when testing local skills.",
      path: path.join(skillDir, "SKILL.md"),
    }]),
  });

  assert.equal(resources.authority.plugins.source, "codex-cli");
  assert.match(resources.authority.plugins.detail, /Codex 官方列表/);
  assert.equal(resources.authority.mcpServers.source, "codex-cli");
  assert.equal(resources.authority.skills.source, "codex-prompt-input");
  assert.match(resources.authority.skills.detail, /prompt-input/);
  assert.match(resources.authority.skills.detail, /本地与插件缓存文件仅用于诊断/);

  const diagnostics = supportDiagnostics(rootDir, {
    homeDir,
    codexCliSnapshot: {
      plugins: {
        ok: true,
        items: [{
          pluginId: "github@openai-curated-remote",
          name: "github",
          marketplaceName: "openai-curated-remote",
          installed: true,
          enabled: true,
        }],
      },
      mcpServers: {
        ok: true,
        items: [{
          name: "node_repl",
          enabled: true,
          transport: { type: "stdio", command: "C:/Codex/node_repl.exe", args: [] },
        }],
      },
    },
    codexPromptInputSnapshot: codexPromptSkillsSnapshot([{
      name: "demo",
      description: "Use when testing local skills.",
      path: path.join(skillDir, "SKILL.md"),
    }]),
  });
  assert.match(diagnostics.text, /pluginsAuthority: codex-cli/);
  assert.match(diagnostics.text, /mcpAuthority: codex-cli/);
  assert.match(diagnostics.text, /skillsAuthority: codex-prompt-input/);
});

test("resource center current counts mirror official CLI and prompt-input authorities", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(path.join(codexDir, "skills", "brainstorming"), { recursive: true });
  fs.mkdirSync(path.join(codexDir, "skills", "frontend-design"), { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, "skills", "brainstorming", "SKILL.md"),
    "# Brainstorming\nUse before creative work.\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(codexDir, "skills", "frontend-design", "SKILL.md"),
    "# Frontend Design\nCreate high quality interfaces.\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    [
      '[plugins."github@openai-curated-remote"]',
      "enabled = true",
      "",
      '[plugins."superpowers@openai-curated"]',
      "enabled = true",
      "",
      '[plugins."cowart@personal"]',
      "enabled = true",
      "",
      '[plugins."browser@openai-bundled"]',
      "enabled = true",
      "",
      "[mcp_servers.node_repl]",
      'command = "C:/Codex/node_repl.exe"',
      "",
    ].join("\n"),
    "utf8",
  );

  const promptRoot = path.join(codexDir, "plugins", "cache", "openai-curated-remote", "github", "0.1.5", "skills")
    .replace(/\\/g, "/");
  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: {
      plugins: {
        ok: true,
        items: [
          {
            pluginId: "github@openai-curated-remote",
            name: "github",
            marketplaceName: "openai-curated-remote",
            version: "0.1.5",
            installed: true,
            enabled: true,
          },
          {
            pluginId: "superpowers@openai-curated",
            name: "superpowers",
            marketplaceName: "openai-curated",
            version: "3fdeeb49",
            installed: true,
            enabled: true,
          },
          {
            pluginId: "cowart@personal",
            name: "cowart",
            marketplaceName: "personal",
            version: "0.1.3",
            installed: true,
            enabled: true,
          },
          {
            pluginId: "code-review@claude-plugins-official",
            name: "code-review",
            marketplaceName: "claude-plugins-official",
            version: "local",
            installed: true,
            enabled: true,
          },
          {
            pluginId: "browser@openai-bundled",
            name: "browser",
            marketplaceName: "openai-bundled",
            version: "26.623.70822",
            installed: true,
            enabled: true,
          },
        ],
      },
      mcpServers: {
        ok: true,
        items: [{
          name: "node_repl",
          enabled: true,
          transport: { type: "stdio", command: "C:/Codex/node_repl.exe", args: [] },
        }],
      },
    },
    codexPromptInputSnapshot: {
      ok: true,
      items: [
        {
          type: "message",
          role: "developer",
          content: [{
            type: "input_text",
            text: [
              "<skills_instructions>",
              "### Skill roots",
              `- \`r0\` = \`${promptRoot}\``,
              "### Available skills",
              "- imagegen: Generate images. (file: C:/Codex/system/imagegen/SKILL.md)",
              "- browser:control-in-app-browser: Control browser. (file: C:/Codex/browser/SKILL.md)",
              "- github:gh-fix-ci: Fix GitHub CI. (file: r0/gh-fix-ci/SKILL.md)",
              `- brainstorming: Use before creative work. (file: ${path.join(codexDir, "skills", "brainstorming", "SKILL.md").replace(/\\/g, "/")})`,
              "</skills_instructions>",
            ].join("\n"),
          }],
        },
      ],
    },
  });

  assert.deepEqual(resources.plugins.map((item) => item.id), [
    "github@openai-curated-remote",
    "superpowers@openai-curated",
    "cowart@personal",
    "code-review@claude-plugins-official",
    "browser@openai-bundled",
  ]);
  assert.deepEqual(resources.skills.map((item) => item.name), [
    "imagegen",
    "browser:control-in-app-browser",
    "github:gh-fix-ci",
    "brainstorming",
  ]);
  assert.equal(resources.summary.plugins, 5);
  assert.equal(resources.summary.skills, 4);
  assert.equal(resources.summary.mcpServers, 1);
  assert.equal(resources.plugins.find((item) => item.id === "cowart@personal")?.source, "codex-cli");
  assert.equal(resources.plugins.find((item) => item.id === "code-review@claude-plugins-official")?.source, "codex-cli");
  assert.equal(resources.plugins.find((item) => item.id === "browser@openai-bundled")?.source, "codex-cli");
  assert.equal(resources.skills.some((item) => item.name === "imagegen"), true);
  assert.equal(resources.skills.some((item) => item.name === "github:gh-fix-ci"), true);
  assert.equal(resources.authority.plugins.source, "codex-cli");
  assert.equal(resources.authority.skills.source, "codex-prompt-input");
});

test("resource center breaks Codex CLI plugins down by marketplace source", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    [
      '[plugins."github@openai-curated-remote"]',
      "enabled = true",
      "",
      '[plugins."cowart@personal"]',
      "enabled = true",
      "",
    ].join("\n"),
    "utf8",
  );

  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: {
      plugins: {
        ok: true,
        items: [
          {
            pluginId: "github@openai-curated-remote",
            name: "github",
            marketplaceName: "openai-curated-remote",
            installed: true,
            enabled: true,
          },
          {
            pluginId: "cowart@personal",
            name: "cowart",
            marketplaceName: "personal",
            installed: true,
            enabled: true,
          },
        ],
      },
      mcpServers: { ok: true, items: [] },
    },
  });

  assert.deepEqual(resources.breakdown.current.plugins, {
    "openai-curated-remote": 1,
    personal: 1,
  });
  assert.deepEqual(resources.breakdown.discovered.plugins, {});
});

test("resource manager toggles configured plugins and MCP servers without touching other Codex config", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const configPath = path.join(codexDir, "config.toml");
  fs.writeFileSync(
    configPath,
    [
      'model = "gpt-5.5"',
      "",
      '[mcp_servers.node_repl]',
      'command = "C:/Codex/node_repl.exe"',
      "",
      '[mcp_servers.disabled_server]',
      'command = "C:/Codex/disabled.exe"',
      "enabled = false",
      "",
      '[plugins."github@openai-curated-remote"]',
      "enabled = true",
      "",
      '[plugins."cowart@personal"]',
      "enabled = false",
      "",
    ].join("\n"),
    "utf8",
  );

  const disabledPlugin = setCodexResourceEnabled({
    homeDir,
    kind: "plugin",
    id: "github@openai-curated-remote",
    enabled: false,
  });
  const enabledMcp = setCodexResourceEnabled({
    homeDir,
    kind: "mcp",
    id: "disabled_server",
    enabled: true,
  });

  const written = fs.readFileSync(configPath, "utf8");
  assert.deepEqual({
    ok: disabledPlugin.ok,
    kind: disabledPlugin.kind,
    id: disabledPlugin.id,
    enabled: disabledPlugin.enabled,
  }, {
    ok: true,
    kind: "plugin",
    id: "github@openai-curated-remote",
    enabled: false,
  });
  assert.equal(fs.existsSync(disabledPlugin.backup), true);
  assert.deepEqual({
    ok: enabledMcp.ok,
    kind: enabledMcp.kind,
    id: enabledMcp.id,
    enabled: enabledMcp.enabled,
  }, {
    ok: true,
    kind: "mcp",
    id: "disabled_server",
    enabled: true,
  });
  assert.equal(fs.existsSync(enabledMcp.backup), true);
  assert.match(written, /model = "gpt-5\.5"/);
  assert.match(written, /\[plugins\."github@openai-curated-remote"]\s+enabled = false/);
  assert.match(written, /\[plugins\."cowart@personal"]\s+enabled = false/);
  assert.match(written, /\[mcp_servers\.node_repl]\s+command = "C:\/Codex\/node_repl\.exe"/);
  assert.match(written, /\[mcp_servers\.disabled_server]\s+command = "C:\/Codex\/disabled\.exe"\s+enabled = true/);
});

test("resource manager backs up Codex config before toggling plugin or MCP resources", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const configPath = path.join(codexDir, "config.toml");
  const original = [
    'model = "gpt-5.5"',
    "",
    '[plugins."github@openai-curated-remote"]',
    "enabled = true",
    "",
  ].join("\n");
  fs.writeFileSync(configPath, original, "utf8");

  const result = setCodexResourceEnabled({
    homeDir,
    kind: "plugin",
    id: "github@openai-curated-remote",
    enabled: false,
  });
  const backups = listCodexBackups({ homeDir });

  assert.equal(result.backup, backups[0]?.fullPath);
  assert.equal(backups.length, 1);
  assert.equal(backups[0].kind, "codexbridge");
  assert.equal(fs.readFileSync(backups[0].fullPath, "utf8"), original);
  assert.match(fs.readFileSync(configPath, "utf8"), /enabled = false/);
});

test("resource manager toggles local Codex skills without deleting the skill folder", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const skillDir = path.join(homeDir, ".codex", "skills", "demo");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Demo\nUse when testing local skills.\n", "utf8");

  const disabled = setCodexResourceEnabled({
    homeDir,
    kind: "skill",
    id: "demo",
    enabled: false,
  });
  const disabledResources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: codexCliAuthoritySnapshot(),
    codexPromptInputSnapshot: codexPromptSkillsSnapshot(),
  });

  assert.deepEqual(disabled, {
    ok: true,
    kind: "skill",
    id: "demo",
    enabled: false,
  });
  assert.equal(fs.existsSync(skillDir), true);
  assert.equal(fs.existsSync(path.join(skillDir, "SKILL.md")), false);
  assert.equal(fs.existsSync(path.join(skillDir, "SKILL.md.disabled")), true);
  assert.equal(disabledResources.skills.some((item) => item.name === "demo"), false);
  assert.ok(disabledResources.discovered.skills.some((item) =>
    item.name === "demo" && item.availability === "disabled" && item.enabled === false,
  ));

  const enabled = setCodexResourceEnabled({
    homeDir,
    kind: "skill",
    id: "demo",
    enabled: true,
  });
  const enabledResources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: codexCliAuthoritySnapshot(),
    codexPromptInputSnapshot: codexPromptSkillsSnapshot([{
      name: "demo",
      description: "Use when testing local skills.",
      path: path.join(skillDir, "SKILL.md"),
    }]),
  });

  assert.deepEqual(enabled, {
    ok: true,
    kind: "skill",
    id: "demo",
    enabled: true,
  });
  assert.equal(fs.existsSync(path.join(skillDir, "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(skillDir, "SKILL.md.disabled")), false);
  assert.ok(enabledResources.skills.some((item) =>
    item.name === "demo" && item.availability === "prompt" && item.enabled === true,
  ));
});

test("resource manager invalidates cached Codex CLI resource snapshots after toggling resources", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const fakeCli = path.join(homeDir, "fake-codex-cli.mjs");
  const statePath = path.join(homeDir, "plugin-enabled.txt");
  fs.writeFileSync(statePath, "true", "utf8");
  fs.writeFileSync(
    fakeCli,
    [
      "import fs from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const enabled = fs.readFileSync(process.env.CODEX_FAKE_STATE, 'utf8').trim() === 'true';",
      "if (args[0] === 'plugin' && args[1] === 'list') {",
      "  console.log(JSON.stringify({ installed: [{ pluginId: 'github@openai-curated-remote', name: 'GitHub', marketplaceName: 'openai-curated-remote', installed: true, enabled }] }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'mcp' && args[1] === 'list') {",
      "  console.log(JSON.stringify([]));",
      "  process.exit(0);",
      "}",
      "process.exit(9);",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    [
      "[mcp_servers.node_repl.env]",
      `CODEX_CLI_PATH = "${toFixtureTomlPath(process.execPath)}"`,
      "",
      '[plugins."github@openai-curated-remote"]',
      "enabled = true",
      "",
    ].join("\n"),
    "utf8",
  );

  const first = readCodexCliResourceSnapshot({
    homeDir,
    codexCliArgsPrefix: [fakeCli],
    env: { CODEX_FAKE_STATE: statePath },
  });
  fs.writeFileSync(statePath, "false", "utf8");
  setCodexResourceEnabled({
    homeDir,
    kind: "plugin",
    id: "github@openai-curated-remote",
    enabled: false,
  });
  const second = readCodexCliResourceSnapshot({
    homeDir,
    codexCliArgsPrefix: [fakeCli],
    env: { CODEX_FAKE_STATE: statePath },
  });

  assert.equal(first.plugins.items[0]?.enabled, true);
  assert.equal(second.plugins.items[0]?.enabled, false);
});

test("resource manager invalidates cached Codex prompt input after toggling local skills", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  const skillDir = path.join(codexDir, "skills", "demo");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Demo\nUse when testing local skills.\n", "utf8");
  fs.writeFileSync(
    path.join(homeDir, "debug"),
    [
      "const fs = require('node:fs');",
      "const skillFile = " + JSON.stringify(path.join(skillDir, "SKILL.md")) + ";",
      "if (process.argv[2] !== 'prompt-input') process.exit(2);",
      "const text = fs.existsSync(skillFile)",
      "  ? '<skills_instructions>\\n### Available skills\\n- demo: Demo skill. (file: ' + skillFile.replace(/\\\\/g, '/') + ')\\n</skills_instructions>'",
      "  : '<skills_instructions>\\n### Available skills\\n</skills_instructions>';",
      "console.log(JSON.stringify([{ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] }]));",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    [
      "[mcp_servers.node_repl.env]",
      `CODEX_CLI_PATH = "${toFixtureTomlPath(process.execPath)}"`,
      "",
    ].join("\n"),
    "utf8",
  );

  const first = readCodexPromptInputSnapshot({ homeDir });
  setCodexResourceEnabled({
    homeDir,
    kind: "skill",
    id: "demo",
    enabled: false,
  });
  const second = readCodexPromptInputSnapshot({ homeDir });

  assert.match(JSON.stringify(first.items), /demo/);
  assert.doesNotMatch(JSON.stringify(second.items), /demo/);
});

test("resource center displays Codex skill frontmatter names while managing the skill folder", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const skillDir = path.join(homeDir, ".codex", "skills", "taste-skill");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: design-taste-frontend",
      "description: Anti-slop frontend skill.",
      "---",
      "",
      "# Taste Skill",
    ].join("\n"),
    "utf8",
  );

  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: codexCliAuthoritySnapshot(),
    codexPromptInputSnapshot: codexPromptSkillsSnapshot([{
      name: "design-taste-frontend",
      description: "Anti-slop frontend skill.",
      path: path.join(skillDir, "SKILL.md"),
    }]),
  });
  const skill = resources.skills.find((item) => item.name === "design-taste-frontend");

  assert.ok(skill);
  assert.equal(skill.folderName, "taste-skill");
  assert.equal(skill.description, "Anti-slop frontend skill.");
  assert.equal(skill.management.id, "taste-skill");

  const disabled = setCodexResourceEnabled({
    homeDir,
    kind: "skill",
    id: skill.management.id,
    enabled: false,
  });
  const disabledResources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: codexCliAuthoritySnapshot(),
    codexPromptInputSnapshot: codexPromptSkillsSnapshot(),
  });
  const disabledSkill = disabledResources.discovered.skills.find((item) =>
    item.name === "design-taste-frontend" && item.availability === "disabled"
  );

  assert.deepEqual(disabled, {
    ok: true,
    kind: "skill",
    id: "taste-skill",
    enabled: false,
  });
  assert.ok(disabledSkill);
  assert.equal(disabledSkill.folderName, "taste-skill");
  assert.equal(disabledSkill.management.id, "taste-skill");
  assert.equal(fs.existsSync(path.join(skillDir, "SKILL.md")), false);
  assert.equal(fs.existsSync(path.join(skillDir, "SKILL.md.disabled")), true);
});

test("resource manager updates marketplace plugins through Codex CLI without touching bundled plugins", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const fakeCli = path.join(homeDir, "fake-codex-cli.mjs");
  const logPath = path.join(homeDir, "codex-cli-calls.jsonl");
  fs.writeFileSync(
    fakeCli,
    [
      "import fs from 'node:fs';",
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(process.env.CODEX_FAKE_LOG, JSON.stringify({ args, CODEX_HOME: process.env.CODEX_HOME }) + '\\n');",
      "if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'upgrade') {",
      "  console.log(JSON.stringify({ ok: true, marketplace: args[3] || 'all' }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'plugin' && args[1] === 'add') {",
      "  console.log(JSON.stringify({ ok: true, plugin: args[2] }));",
      "  process.exit(0);",
      "}",
      "console.error('unexpected args: ' + args.join(' '));",
      "process.exit(9);",
    ].join("\n"),
    "utf8",
  );

  const result = updateCodexPluginResource({
    homeDir,
    id: "github@openai-curated-remote",
    executable: process.execPath,
    codexCliArgsPrefix: [fakeCli],
    env: { CODEX_FAKE_LOG: logPath },
  });

  assert.equal(result.ok, true);
  assert.equal(result.kind, "plugin");
  assert.equal(result.id, "github@openai-curated-remote");
  assert.equal(result.marketplace, "openai-curated-remote");
  assert.equal(result.refreshed, true);
  assert.equal(result.installed, true);
  assert.match(result.message, /已刷新插件市场/);
  assert.match(result.message, /已重新安装插件/);
  const calls = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((call) => call.args), [
    ["plugin", "marketplace", "upgrade", "openai-curated-remote", "--json"],
    ["plugin", "add", "github@openai-curated-remote", "--json"],
  ]);
  assert.equal(calls[0].CODEX_HOME, path.join(homeDir, ".codex"));

  assert.throws(
    () => updateCodexPluginResource({
      homeDir,
      id: "browser@openai-bundled",
      executable: process.execPath,
      codexCliArgsPrefix: [fakeCli],
      env: { CODEX_FAKE_LOG: logPath },
    }),
    /Codex Desktop/,
  );
});

test("resource manager refreshes all plugin marketplaces without installing or removing plugins", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const fakeCli = path.join(homeDir, "fake-codex-cli.mjs");
  const logPath = path.join(homeDir, "codex-cli-calls.jsonl");
  fs.writeFileSync(
    fakeCli,
    [
      "import fs from 'node:fs';",
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(process.env.CODEX_FAKE_LOG, JSON.stringify({ args, CODEX_HOME: process.env.CODEX_HOME }) + '\\n');",
      "if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'upgrade') {",
      "  console.log(JSON.stringify({ ok: true, refreshed: ['openai-curated-remote', 'debug'] }));",
      "  process.exit(0);",
      "}",
      "process.exit(9);",
    ].join("\n"),
    "utf8",
  );

  const result = refreshCodexPluginMarketplaces({
    homeDir,
    executable: process.execPath,
    codexCliArgsPrefix: [fakeCli],
    env: { CODEX_FAKE_LOG: logPath },
  });

  assert.equal(result.ok, true);
  assert.equal(result.kind, "plugin_marketplaces");
  assert.equal(result.marketplace, "all");
  assert.equal(result.refreshed, true);
  assert.match(result.message, /已刷新插件市场/);
  const calls = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((call) => call.args), [
    ["plugin", "marketplace", "upgrade", "--json"],
  ]);
  assert.equal(calls[0].CODEX_HOME, path.join(homeDir, ".codex"));
});

test("resource manager still reinstalls marketplace plugins when snapshot refresh is not supported", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const fakeCli = path.join(homeDir, "fake-codex-cli.mjs");
  const logPath = path.join(homeDir, "codex-cli-calls.jsonl");
  fs.writeFileSync(
    fakeCli,
    [
      "import fs from 'node:fs';",
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(process.env.CODEX_FAKE_LOG, JSON.stringify({ args }) + '\\n');",
      "if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'upgrade') {",
      "  console.log('marketplace is not configured as a Git marketplace');",
      "  process.exit(2);",
      "}",
      "if (args[0] === 'plugin' && args[1] === 'add') {",
      "  console.log(JSON.stringify({ ok: true, plugin: args[2] }));",
      "  process.exit(0);",
      "}",
      "process.exit(9);",
    ].join("\n"),
    "utf8",
  );

  const result = updateCodexPluginResource({
    homeDir,
    id: "game-studio@openai-curated",
    executable: process.execPath,
    codexCliArgsPrefix: [fakeCli],
    env: { CODEX_FAKE_LOG: logPath },
  });

  assert.equal(result.ok, true);
  assert.equal(result.refreshed, false);
  assert.equal(result.installed, true);
  assert.match(result.refreshError, /not configured as a Git marketplace/);
  assert.match(result.message, /插件市场刷新未完成/);
  assert.match(result.message, /已继续重新安装插件/);
  const calls = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((call) => call.args), [
    ["plugin", "marketplace", "upgrade", "openai-curated", "--json"],
    ["plugin", "add", "game-studio@openai-curated", "--json"],
  ]);
});

test("resource manager removes marketplace plugins through Codex CLI only after explicit action", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const fakeCli = path.join(homeDir, "fake-codex-cli.mjs");
  const logPath = path.join(homeDir, "codex-cli-calls.jsonl");
  fs.writeFileSync(
    fakeCli,
    [
      "import fs from 'node:fs';",
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(process.env.CODEX_FAKE_LOG, JSON.stringify({ args, CODEX_HOME: process.env.CODEX_HOME }) + '\\n');",
      "if (args[0] === 'plugin' && args[1] === 'remove') {",
      "  console.log(JSON.stringify({ ok: true, removed: args[2] }));",
      "  process.exit(0);",
      "}",
      "process.exit(9);",
    ].join("\n"),
    "utf8",
  );

  const result = removeCodexPluginResource({
    homeDir,
    id: "github@openai-curated-remote",
    executable: process.execPath,
    codexCliArgsPrefix: [fakeCli],
    env: { CODEX_FAKE_LOG: logPath },
  });

  assert.equal(result.ok, true);
  assert.equal(result.kind, "plugin");
  assert.equal(result.id, "github@openai-curated-remote");
  assert.equal(result.removed, true);
  assert.match(result.message, /已卸载插件/);
  const calls = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((call) => call.args), [
    ["plugin", "remove", "github@openai-curated-remote", "--json"],
  ]);
  assert.equal(calls[0].CODEX_HOME, path.join(homeDir, ".codex"));

  assert.throws(
    () => removeCodexPluginResource({
      homeDir,
      id: "browser@openai-bundled",
      executable: process.execPath,
      codexCliArgsPrefix: [fakeCli],
      env: { CODEX_FAKE_LOG: logPath },
    }),
    /Codex Desktop/,
  );
  assert.throws(
    () => removeCodexPluginResource({
      homeDir,
      id: "cowart@personal",
      executable: process.execPath,
      codexCliArgsPrefix: [fakeCli],
      env: { CODEX_FAKE_LOG: logPath },
    }),
    /个人本地插件/,
  );
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
  assert.match(exported.markdown, /## 迁移说明/);
  assert.match(exported.markdown, /不会自动写回 Codex Desktop/);
  assert.match(exported.markdown, /无项目会话/);
  assert.equal(exported.databasePath, dbPath);
});

test("session export includes user and assistant messages from rollout history", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  const sessionDir = path.join(codexDir, "sessions", "2026", "07", "03");
  fs.mkdirSync(sessionDir, { recursive: true });
  const rolloutPath = path.join(sessionDir, "rollout-thread_export.jsonl");
  fs.writeFileSync(
    rolloutPath,
    [
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "internal setup" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "帮我看一下项目" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "我先检查项目结构和当前状态。" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "这一步已经完成。" }] } }),
    ].join("\n"),
    "utf8",
  );
  fs.mkdirSync(codexDir, { recursive: true });
  createCodexStateDbWithMetadata(codexDir, [
    {
      id: "thread_export",
      modelProvider: "openai",
      model: "gpt-5.5",
      title: "Export Session",
      source: "vscode",
      threadSource: "user",
      firstUserMessage: "fallback first message",
      rolloutPath,
    },
  ]);

  const exported = exportCodexSessionMarkdown("thread_export", { homeDir });

  assert.match(exported.markdown, /## Conversation/);
  assert.match(exported.markdown, /### User/);
  assert.match(exported.markdown, /帮我看一下项目/);
  assert.match(exported.markdown, /### Assistant/);
  assert.match(exported.markdown, /我先检查项目结构和当前状态。/);
  assert.match(exported.markdown, /这一步已经完成。/);
  assert.doesNotMatch(exported.markdown, /internal setup/);
});

test("project export includes only sessions from the selected project", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  const sessionDir = path.join(codexDir, "sessions", "2026", "07", "03");
  fs.mkdirSync(sessionDir, { recursive: true });
  const projectRolloutPath = path.join(sessionDir, "rollout-thread_project_a.jsonl");
  const looseRolloutPath = path.join(sessionDir, "rollout-thread_loose.jsonl");
  fs.writeFileSync(
    projectRolloutPath,
    [
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "project question" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "project answer" }] } }),
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    looseRolloutPath,
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "loose question" }] } }),
    "utf8",
  );
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({
      "pinned-project-ids": ["C:/Users/Administrator/Documents/aaa"],
      "thread-workspace-root-hints": {
        thread_loose: "C:/Users/Administrator/Documents/Codex",
      },
    }),
    "utf8",
  );
  createCodexStateDbWithMetadata(codexDir, [
    {
      id: "thread_project_a",
      modelProvider: "openai",
      model: "gpt-5.5",
      title: "AAA Project Session",
      source: "desktop",
      threadSource: "user",
      cwd: "C:/Users/Administrator/Documents/aaa",
      firstUserMessage: "project fallback",
      rolloutPath: projectRolloutPath,
      recencyAtMs: 30,
    },
    {
      id: "thread_loose",
      modelProvider: "openai",
      model: "gpt-5.5",
      title: "Loose Session",
      source: "desktop",
      threadSource: "user",
      cwd: "C:/Users/Administrator/Documents/aaa",
      firstUserMessage: "loose fallback",
      rolloutPath: looseRolloutPath,
      recencyAtMs: 20,
    },
  ]);

  const exported = exportCodexProjectMarkdown("path:c:/users/administrator/documents/aaa", { homeDir });

  assert.equal(exported.project.name, "aaa");
  assert.equal(exported.project.sessions.length, 1);
  assert.match(exported.markdown, /# Codex Project: aaa/);
  assert.match(exported.markdown, /## 迁移清单/);
  assert.match(exported.markdown, /先在目标机器用 Codex 打开项目目录/);
  assert.match(exported.markdown, /AAA Project Session/);
  assert.match(exported.markdown, /## Session: AAA Project Session/);
  assert.match(exported.markdown, /迁移说明/);
  assert.match(exported.markdown, /请先在目标机器用 Codex 打开项目目录/);
  assert.match(exported.markdown, /project question/);
  assert.match(exported.markdown, /project answer/);
  assert.doesNotMatch(exported.markdown, /Loose Session/);
  assert.doesNotMatch(exported.markdown, /loose question/);
});

test("loose session export includes only sessions without a Codex project", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  const sessionDir = path.join(codexDir, "sessions", "2026", "07", "03");
  fs.mkdirSync(sessionDir, { recursive: true });
  const projectRolloutPath = path.join(sessionDir, "rollout-thread_project_for_loose_export.jsonl");
  const looseRolloutPath = path.join(sessionDir, "rollout-thread_loose_export.jsonl");
  fs.writeFileSync(
    projectRolloutPath,
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "project-only question" }] } }),
    "utf8",
  );
  fs.writeFileSync(
    looseRolloutPath,
    [
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "loose-only question" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "loose-only answer" }] } }),
    ].join("\n"),
    "utf8",
  );
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({
      "pinned-project-ids": ["C:/Users/Administrator/Documents/aaa"],
      "projectless-thread-ids": ["thread_loose_export"],
    }),
    "utf8",
  );
  createCodexStateDbWithMetadata(codexDir, [
    {
      id: "thread_project_for_loose_export",
      modelProvider: "openai",
      model: "gpt-5.5",
      title: "AAA Project Session",
      source: "desktop",
      threadSource: "user",
      cwd: "C:/Users/Administrator/Documents/aaa",
      firstUserMessage: "project fallback",
      rolloutPath: projectRolloutPath,
      recencyAtMs: 30,
    },
    {
      id: "thread_loose_export",
      modelProvider: "openai",
      model: "gpt-5.5",
      title: "Loose Session",
      source: "desktop",
      threadSource: "user",
      cwd: "C:/Users/Administrator/Documents/aaa",
      firstUserMessage: "loose fallback",
      rolloutPath: looseRolloutPath,
      recencyAtMs: 20,
    },
  ]);

  const exported = exportCodexLooseSessionsMarkdown({ homeDir });

  assert.equal(exported.group.sessions.length, 1);
  assert.equal(exported.group.sessions[0].id, "thread_loose_export");
  assert.match(exported.markdown, /# Codex No-Project Sessions/);
  assert.match(exported.markdown, /## 迁移清单/);
  assert.match(exported.markdown, /无项目会话会作为普通对话留档/);
  assert.match(exported.markdown, /Loose Session/);
  assert.match(exported.markdown, /loose-only question/);
  assert.match(exported.markdown, /loose-only answer/);
  assert.doesNotMatch(exported.markdown, /AAA Project Session/);
  assert.doesNotMatch(exported.markdown, /project-only question/);
});

test("session tree export includes projects and no-project sessions in one handoff", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  const sessionDir = path.join(codexDir, "sessions", "2026", "07", "03");
  fs.mkdirSync(sessionDir, { recursive: true });
  const projectRolloutPath = path.join(sessionDir, "rollout-thread_project_tree_export.jsonl");
  const looseRolloutPath = path.join(sessionDir, "rollout-thread_loose_tree_export.jsonl");
  fs.writeFileSync(
    projectRolloutPath,
    [
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "project tree question" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "project tree answer" }] } }),
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    looseRolloutPath,
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "loose tree question" }] } }),
    "utf8",
  );
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({
      "pinned-project-ids": ["C:/Users/Administrator/Documents/aaa"],
      "projectless-thread-ids": ["thread_loose_tree_export"],
    }),
    "utf8",
  );
  createCodexStateDbWithMetadata(codexDir, [
    {
      id: "thread_project_tree_export",
      modelProvider: "openai",
      model: "gpt-5.5",
      title: "Project Tree Session",
      source: "desktop",
      threadSource: "user",
      cwd: "C:/Users/Administrator/Documents/aaa",
      rolloutPath: projectRolloutPath,
      recencyAtMs: 30,
    },
    {
      id: "thread_loose_tree_export",
      modelProvider: "openai",
      model: "gpt-5.5",
      title: "Loose Tree Session",
      source: "desktop",
      threadSource: "user",
      cwd: "C:/Users/Administrator/Documents/aaa",
      rolloutPath: looseRolloutPath,
      recencyAtMs: 20,
    },
  ]);

  const exported = exportCodexSessionTreeMarkdown({ homeDir });

  assert.equal(exported.tree.summary.sessions, 2);
  assert.equal(exported.tree.summary.projects, 1);
  assert.equal(exported.tree.summary.projectSessions, 1);
  assert.equal(exported.tree.summary.looseSessions, 1);
  assert.match(exported.markdown, /# Codex Sessions And Projects/);
  assert.match(exported.markdown, /## 迁移清单/);
  assert.match(exported.markdown, /目标机器/);
  assert.match(exported.markdown, /## Project Index/);
  assert.match(exported.markdown, /- aaa: 1 session/);
  assert.match(exported.markdown, /Project Tree Session/);
  assert.match(exported.markdown, /Model: gpt-5\.5/);
  assert.match(exported.markdown, /First user: project tree question/);
  assert.match(exported.markdown, /## Project: aaa/);
  assert.match(exported.markdown, /Project Tree Session/);
  assert.match(exported.markdown, /project tree question/);
  assert.match(exported.markdown, /project tree answer/);
  assert.match(exported.markdown, /## No-Project Index/);
  assert.match(exported.markdown, /## No-Project Sessions/);
  assert.match(exported.markdown, /Loose Tree Session/);
  assert.match(exported.markdown, /这是无项目会话/);
  assert.match(exported.markdown, /loose tree question/);
});

test("session tree export can include only filtered session ids", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({
      "pinned-project-ids": ["C:/Users/Administrator/Documents/aaa"],
      "projectless-thread-ids": ["thread_filtered_loose"],
    }),
    "utf8",
  );
  createCodexStateDbWithMetadata(codexDir, [
    {
      id: "thread_filtered_project",
      modelProvider: "openai",
      model: "gpt-5.5",
      title: "Filtered Project Session",
      source: "desktop",
      threadSource: "user",
      cwd: "C:/Users/Administrator/Documents/aaa",
      firstUserMessage: "keep project",
      recencyAtMs: 30,
    },
    {
      id: "thread_not_filtered",
      modelProvider: "openai",
      model: "gpt-5.5",
      title: "Hidden Project Session",
      source: "desktop",
      threadSource: "user",
      cwd: "C:/Users/Administrator/Documents/aaa",
      firstUserMessage: "do not export",
      recencyAtMs: 20,
    },
    {
      id: "thread_filtered_loose",
      modelProvider: "openai",
      model: "gpt-5.5",
      title: "Filtered Loose Session",
      source: "desktop",
      threadSource: "user",
      cwd: "C:/Users/Administrator/Documents/aaa",
      firstUserMessage: "keep loose",
      recencyAtMs: 10,
    },
  ]);

  const exported = exportCodexFilteredSessionsMarkdown({
    sessionIds: ["thread_filtered_project", "thread_filtered_loose"],
    filterText: "Filtered",
    homeDir,
  });

  assert.equal(exported.tree.summary.sessions, 2);
  assert.equal(exported.tree.summary.projects, 1);
  assert.equal(exported.tree.summary.projectSessions, 1);
  assert.equal(exported.tree.summary.looseSessions, 1);
  assert.equal(exported.filterText, "Filtered");
  assert.match(exported.markdown, /# Codex Filtered Sessions/);
  assert.match(exported.markdown, /## 迁移清单/);
  assert.match(exported.markdown, /只包含当前筛选结果/);
  assert.match(exported.markdown, /- Filter: Filtered/);
  assert.match(exported.markdown, /Filtered Project Session/);
  assert.match(exported.markdown, /Filtered Loose Session/);
  assert.doesNotMatch(exported.markdown, /Hidden Project Session/);
  assert.doesNotMatch(exported.markdown, /do not export/);
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

test("session center honors Codex per-thread workspace hints for projectless chats", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({
      "pinned-project-ids": ["C:/Users/Administrator/Documents/aaa"],
      "thread-workspace-root-hints": {
        thread_projectless_inside_root: "C:/Users/Administrator/Documents/Codex",
      },
    }),
    "utf8",
  );
  createCodexThreadCatalogDb(codexDir, [
    {
      id: "thread_project",
      title: "Project Session",
      cwd: "C:/Users/Administrator/Documents/aaa",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 30,
    },
    {
      id: "thread_projectless_inside_root",
      title: "Projectless Inside Root",
      cwd: "C:/Users/Administrator/Documents/aaa",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 20,
    },
  ]);

  const tree = listCodexSessionTree({ homeDir, limit: 50 });

  assert.equal(tree.summary.sessions, 2);
  assert.equal(tree.summary.projects, 1);
  assert.equal(tree.summary.projectSessions, 1);
  assert.equal(tree.summary.looseSessions, 1);
  assert.deepEqual(tree.projects[0].sessions.map((item) => item.id), ["thread_project"]);
  assert.equal(tree.projects[0].sessions[0].projectReason, "workspace_root");
  assert.deepEqual(tree.looseSessions.map((item) => item.id), ["thread_projectless_inside_root"]);
  assert.equal(tree.looseSessions[0].projectReason, "workspace_hint_outside_projects");
  assert.equal(tree.looseSessions[0].workspacePath, "C:/Users/Administrator/Documents/Codex");
});

test("session center honors Codex thread project assignments before transient cwd", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({
      "pinned-project-ids": ["C:/Users/Administrator/Documents/aaa"],
      "thread-project-assignments": {
        thread_project_saved_elsewhere: "C:/Users/Administrator/Documents/aaa",
      },
    }),
    "utf8",
  );
  createCodexThreadCatalogDb(codexDir, [
    {
      id: "thread_project_saved_elsewhere",
      title: "Assigned Project Session",
      cwd: "C:/Users/Administrator/Documents/Codex/2026-07/new-chat-8",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 20,
    },
  ]);

  const tree = listCodexSessionTree({ homeDir, limit: 50 });

  assert.equal(tree.summary.sessions, 1);
  assert.equal(tree.summary.projects, 1);
  assert.equal(tree.summary.projectSessions, 1);
  assert.equal(tree.summary.looseSessions, 0);
  assert.deepEqual(tree.projects[0].sessions.map((item) => item.id), ["thread_project_saved_elsewhere"]);
  assert.equal(tree.projects[0].sessions[0].projectPath, "C:/Users/Administrator/Documents/aaa");
  assert.equal(tree.projects[0].sessions[0].projectReason, "thread_assignment");
  assert.equal(
    tree.projects[0].sessions[0].workspacePath,
    "C:/Users/Administrator/Documents/Codex/2026-07/new-chat-8",
  );
});

test("session center honors Codex sidebar project thread order assignments", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({
      "pinned-project-ids": ["C:/Users/Administrator/Documents/aaa"],
      "sidebar-project-thread-orders": {
        "C:/Users/Administrator/Documents/aaa": ["thread_project_from_sidebar"],
      },
    }),
    "utf8",
  );
  createCodexThreadCatalogDb(codexDir, [
    {
      id: "thread_project_from_sidebar",
      title: "Sidebar Assigned Project Session",
      cwd: "C:/Users/Administrator/Documents/Codex/2026-07/new-chat-9",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 20,
    },
  ]);

  const tree = listCodexSessionTree({ homeDir, limit: 50 });

  assert.equal(tree.summary.sessions, 1);
  assert.equal(tree.summary.projects, 1);
  assert.equal(tree.summary.projectSessions, 1);
  assert.equal(tree.summary.looseSessions, 0);
  assert.deepEqual(tree.projects[0].sessions.map((item) => item.id), ["thread_project_from_sidebar"]);
  assert.equal(tree.projects[0].sessions[0].projectPath, "C:/Users/Administrator/Documents/aaa");
});

test("session center treats Codex projectless output threads as loose sessions", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({
      "pinned-project-ids": ["C:/Users/Administrator/Documents/aaa"],
      "thread-projectless-output-directories": {
        thread_output_marked_projectless: "C:/Users/Administrator/Documents/Codex/2026-07/new-chat/outputs",
      },
    }),
    "utf8",
  );
  createCodexThreadCatalogDb(codexDir, [
    {
      id: "thread_project",
      title: "Project Session",
      cwd: "C:/Users/Administrator/Documents/aaa",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 30,
    },
    {
      id: "thread_output_marked_projectless",
      title: "Projectless Output Thread",
      cwd: "C:/Users/Administrator/Documents/aaa",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 20,
    },
  ]);

  const tree = listCodexSessionTree({ homeDir, limit: 50 });

  assert.equal(tree.summary.sessions, 2);
  assert.equal(tree.summary.projects, 1);
  assert.equal(tree.summary.projectSessions, 1);
  assert.equal(tree.summary.looseSessions, 1);
  assert.deepEqual(tree.projects[0].sessions.map((item) => item.id), ["thread_project"]);
  assert.deepEqual(tree.looseSessions.map((item) => item.id), ["thread_output_marked_projectless"]);
  assert.equal(tree.looseSessions[0].workspacePath, "C:/Users/Administrator/Documents/aaa");
});

test("session center builds a Codex-style project folder tree from saved workspace roots", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({
      "electron-saved-workspace-roots": [
        "C:/Users/Administrator/Documents/aaa",
        "C:/Users/Administrator/Documents/empty-project",
      ],
      "projectless-thread-ids": ["thread_projectless_inside_root"],
    }),
    "utf8",
  );
  createCodexThreadCatalogDb(codexDir, [
    {
      id: "thread_project",
      title: "Project Session",
      cwd: "C:/Users/Administrator/Documents/aaa",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 30,
    },
    {
      id: "thread_project_child",
      title: "Project Child Session",
      cwd: "C:/Users/Administrator/Documents/aaa/src",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 20,
    },
    {
      id: "thread_projectless_inside_root",
      title: "Projectless Inside Root",
      cwd: "C:/Users/Administrator/Documents/aaa",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 10,
    },
    {
      id: "thread_projectless_codex_folder",
      title: "Projectless Codex Folder",
      cwd: "C:/Users/Administrator/Documents/Codex/2026-07/new-chat-1",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 5,
    },
  ]);

  const tree = listCodexSessionTree({ homeDir, limit: 50 });

  assert.equal(tree.summary.sessions, 4);
  assert.equal(tree.summary.projects, 2);
  assert.equal(tree.summary.projectSessions, 2);
  assert.equal(tree.summary.looseSessions, 2);
  assert.deepEqual(tree.projects.map((item) => item.name), ["aaa", "empty-project"]);
  assert.deepEqual(tree.projects[0].sessions.map((item) => item.id), [
    "thread_project",
    "thread_project_child",
  ]);
  assert.deepEqual(tree.projects[1].sessions, []);
  assert.deepEqual(tree.looseSessions.map((item) => item.id), [
    "thread_projectless_inside_root",
    "thread_projectless_codex_folder",
  ]);
});

test("session center uses pinned Codex projects before older saved workspace roots", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({
      "electron-saved-workspace-roots": [
        "C:/Users/Administrator/Documents/aaa",
        "C:/Users/Administrator/Documents/old-output",
      ],
      "pinned-project-ids": ["C:/Users/Administrator/Documents/aaa"],
    }),
    "utf8",
  );
  createCodexThreadCatalogDb(codexDir, [
    {
      id: "thread_project",
      title: "Project Session",
      cwd: "C:/Users/Administrator/Documents/aaa",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 20,
    },
    {
      id: "thread_old_saved_root",
      title: "Old Saved Root Session",
      cwd: "C:/Users/Administrator/Documents/old-output",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 10,
    },
  ]);

  const tree = listCodexSessionTree({ homeDir, limit: 50 });

  assert.equal(tree.summary.sessions, 2);
  assert.equal(tree.summary.projects, 1);
  assert.equal(tree.summary.projectSessions, 1);
  assert.equal(tree.summary.looseSessions, 1);
  assert.deepEqual(tree.projects.map((item) => item.name), ["aaa"]);
  assert.deepEqual(tree.projects[0].sessions.map((item) => item.id), ["thread_project"]);
  assert.deepEqual(tree.looseSessions.map((item) => item.id), ["thread_old_saved_root"]);
});

test("session center uses active Codex project roots before project-order history", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({
      "active-workspace-roots": ["C:/Users/Administrator/Documents/aaa"],
      "project-order": [
        "C:/Users/Administrator/Documents/aaa",
        "C:/Users/Administrator/Documents/bridge",
      ],
      "electron-saved-workspace-roots": [
        "C:/Users/Administrator/Documents/aaa",
        "C:/Users/Administrator/Documents/bridge",
      ],
    }),
    "utf8",
  );
  createCodexThreadCatalogDb(codexDir, [
    {
      id: "thread_active_project",
      title: "Active Project Session",
      cwd: "C:/Users/Administrator/Documents/aaa",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 20,
    },
    {
      id: "thread_other_visible_project",
      title: "Other Visible Project Session",
      cwd: "C:/Users/Administrator/Documents/bridge",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 10,
    },
  ]);

  const tree = listCodexSessionTree({ homeDir, limit: 50 });

  assert.equal(tree.summary.sessions, 2);
  assert.equal(tree.summary.projects, 1);
  assert.equal(tree.summary.activeProjects, 1);
  assert.equal(tree.summary.historyProjects, 0);
  assert.equal(tree.summary.projectSessions, 1);
  assert.equal(tree.summary.looseSessions, 1);
  assert.deepEqual(tree.projects.map((item) => [item.name, item.source, item.active]), [
    ["aaa", "active", true],
  ]);
  assert.deepEqual(tree.projects[0].sessions.map((session) => session.id), ["thread_active_project"]);
  assert.deepEqual(tree.looseSessions.map((session) => session.id), ["thread_other_visible_project"]);
});

test("session center does not count project-order-only roots as visible while active roots exist", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({
      "active-workspace-roots": ["C:/Users/Administrator/Documents/aaa"],
      "project-order": [
        "C:/Users/Administrator/Documents/aaa",
        "C:/Users/Administrator/Documents/old-project",
      ],
      "electron-saved-workspace-roots": [
        "C:/Users/Administrator/Documents/aaa",
        "C:/Users/Administrator/Documents/old-project",
      ],
    }),
    "utf8",
  );
  createCodexThreadCatalogDb(codexDir, [
    {
      id: "thread_active_project",
      title: "Active Project Session",
      cwd: "C:/Users/Administrator/Documents/aaa",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 20,
    },
    {
      id: "thread_old_project_order",
      title: "Old Project Order Session",
      cwd: "C:/Users/Administrator/Documents/old-project",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 10,
    },
  ]);

  const tree = listCodexSessionTree({ homeDir, limit: 50 });

  assert.equal(tree.summary.sessions, 2);
  assert.equal(tree.summary.projects, 1);
  assert.equal(tree.summary.activeProjects, 1);
  assert.equal(tree.summary.historyProjects, 0);
  assert.equal(tree.summary.projectSessions, 1);
  assert.equal(tree.summary.looseSessions, 1);
  assert.deepEqual(tree.projects.map((item) => [item.name, item.source, item.active]), [
    ["aaa", "active", true],
  ]);
  assert.deepEqual(tree.projects[0].sessions.map((session) => session.id), ["thread_active_project"]);
  assert.deepEqual(tree.looseSessions.map((session) => session.id), ["thread_old_project_order"]);
});

test("session center keeps project-order history loose while an active project is visible", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({
      "active-workspace-roots": ["C:/Users/Administrator/Documents/aaa"],
      "project-order": [
        "C:/Users/Administrator/Documents/aaa",
        "C:/Users/Administrator/Documents/old-router",
        "C:/Users/Administrator/Documents/old-tools",
      ],
      "electron-saved-workspace-roots": [
        "C:/Users/Administrator/Documents/aaa",
        "C:/Users/Administrator/Documents/old-router",
        "C:/Users/Administrator/Documents/old-tools",
      ],
    }),
    "utf8",
  );
  createCodexThreadCatalogDb(codexDir, [
    {
      id: "thread_active_project",
      title: "Active Project Session",
      cwd: "C:/Users/Administrator/Documents/aaa",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 40,
    },
    {
      id: "thread_old_router",
      title: "Old Router Chat",
      cwd: "C:/Users/Administrator/Documents/old-router",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 30,
    },
    {
      id: "thread_old_tools",
      title: "Old Tools Chat",
      cwd: "C:/Users/Administrator/Documents/old-tools",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 20,
    },
  ]);

  const tree = listCodexSessionTree({ homeDir, limit: 50 });

  assert.equal(tree.summary.sessions, 3);
  assert.equal(tree.summary.projects, 1);
  assert.equal(tree.summary.activeProjects, 1);
  assert.equal(tree.summary.historyProjects, 0);
  assert.equal(tree.summary.projectSessions, 1);
  assert.equal(tree.summary.looseSessions, 2);
  assert.deepEqual(tree.projects.map((item) => [item.name, item.source, item.active]), [
    ["aaa", "active", true],
  ]);
  assert.deepEqual(tree.projects[0].sessions.map((session) => session.id), ["thread_active_project"]);
  assert.deepEqual(tree.looseSessions.map((session) => session.id), ["thread_old_router", "thread_old_tools"]);
});

test("session center uses active roots before saved workspace history", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({
      "active-workspace-roots": ["C:/Users/Administrator/Documents/aaa"],
      "electron-saved-workspace-roots": [
        "C:/Users/Administrator/Documents/aaa",
        "C:/Users/Administrator/Documents/old-project",
      ],
    }),
    "utf8",
  );
  createCodexThreadCatalogDb(codexDir, [
    {
      id: "thread_active_project",
      title: "Active Project Session",
      cwd: "C:/Users/Administrator/Documents/aaa",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 20,
    },
    {
      id: "thread_saved_project",
      title: "Saved Project Session",
      cwd: "C:/Users/Administrator/Documents/old-project",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 10,
    },
  ]);

  const tree = listCodexSessionTree({ homeDir, limit: 50 });

  assert.equal(tree.summary.projects, 1);
  assert.equal(tree.summary.activeProjects, 1);
  assert.equal(tree.summary.historyProjects, 0);
  assert.equal(tree.summary.projectSessions, 1);
  assert.equal(tree.summary.looseSessions, 1);
  assert.deepEqual(
    tree.projects.map((item) => [item.name, item.active, item.source]),
    [
      ["aaa", true, "active"],
    ],
  );
  assert.deepEqual(tree.projects[0].sessions.map((session) => session.id), ["thread_active_project"]);
  assert.deepEqual(tree.looseSessions.map((session) => session.id), ["thread_saved_project"]);
});

test("session center treats Codex sidebar project thread order as authoritative", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({
      "active-workspace-roots": ["C:/Users/Administrator/Documents/aaa"],
      "sidebar-project-thread-orders": {
        "C:/Users/Administrator/Documents/aaa": ["thread_visible_project"],
      },
    }),
    "utf8",
  );
  createCodexThreadCatalogDb(codexDir, [
    {
      id: "thread_visible_project",
      title: "Visible Project Session",
      cwd: "C:/Users/Administrator/Documents/aaa",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 30,
    },
    {
      id: "thread_same_cwd_old_chat",
      title: "Same CWD Old Chat",
      cwd: "C:/Users/Administrator/Documents/aaa",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 20,
    },
    {
      id: "thread_same_child_cwd_old_chat",
      title: "Same Child CWD Old Chat",
      cwd: "C:/Users/Administrator/Documents/aaa/src",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 10,
    },
  ]);

  const tree = listCodexSessionTree({ homeDir, limit: 50 });

  assert.equal(tree.summary.projects, 1);
  assert.equal(tree.summary.projectSessions, 1);
  assert.equal(tree.summary.looseSessions, 2);
  assert.deepEqual(tree.projects.map((item) => item.name), ["aaa"]);
  assert.deepEqual(tree.projects[0].sessions.map((session) => session.id), ["thread_visible_project"]);
  assert.deepEqual(tree.looseSessions.map((session) => session.id), [
    "thread_same_cwd_old_chat",
    "thread_same_child_cwd_old_chat",
  ]);
  assert.deepEqual(tree.looseSessions.map((session) => session.projectReason), [
    "outside_sidebar_project_threads",
    "outside_sidebar_project_threads",
  ]);
  assert.equal(tree.projects[0].sessions[0].projectReason, "sidebar_project_thread_order");
  assert.deepEqual(tree.classification.projectReasons, {
    sidebar_project_thread_order: 1,
    outside_sidebar_project_threads: 2,
  });
  assert.deepEqual(tree.classification.projectSources, {
    active: 1,
  });
  assert.equal(tree.classification.sidebarProjectThreadAssignments, 1);
});

test("session center mirrors one visible Codex project with assigned sessions and loose chats", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const projectThreadIds = Array.from({ length: 15 }, (_, index) => `thread_aaa_${index + 1}`);
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({
      "active-workspace-roots": ["C:/Users/Administrator/Documents/aaa"],
      "project-order": [
        "C:/Users/Administrator/Documents/aaa",
        "C:/Users/Administrator/Documents/old-router",
        "C:/Users/Administrator/Documents/old-tools",
      ],
      "electron-saved-workspace-roots": [
        "C:/Users/Administrator/Documents/aaa",
        "C:/Users/Administrator/Documents/old-router",
        "C:/Users/Administrator/Documents/old-tools",
      ],
      "sidebar-project-thread-orders": {
        "C:/Users/Administrator/Documents/aaa": projectThreadIds,
      },
    }),
    "utf8",
  );
  createCodexThreadCatalogDb(codexDir, [
    ...projectThreadIds.map((id, index) => ({
      id,
      title: `AAA ${index + 1}`,
      cwd: index % 2 === 0
        ? "C:/Users/Administrator/Documents/aaa"
        : "C:/Users/Administrator/Documents/aaa/src",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 100 - index,
    })),
    {
      id: "thread_same_root_not_in_sidebar",
      title: "Same Root Loose Chat",
      cwd: "C:/Users/Administrator/Documents/aaa",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 20,
    },
    {
      id: "thread_old_project_history",
      title: "Old Project History Chat",
      cwd: "C:/Users/Administrator/Documents/old-router",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 10,
    },
    {
      id: "thread_generated_new_chat",
      title: "Generated New Chat",
      cwd: "C:/Users/Administrator/Documents/Codex/2026-07/new-chat-8",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 5,
    },
  ]);

  const tree = listCodexSessionTree({ homeDir, limit: 80 });

  assert.equal(tree.summary.sessions, 18);
  assert.equal(tree.summary.projects, 1);
  assert.equal(tree.summary.activeProjects, 1);
  assert.equal(tree.summary.historyProjects, 0);
  assert.equal(tree.summary.projectSessions, 15);
  assert.equal(tree.summary.looseSessions, 3);
  assert.deepEqual(tree.projects.map((project) => [project.name, project.source, project.active]), [
    ["aaa", "active", true],
  ]);
  assert.deepEqual(tree.projects[0].sessions.map((session) => session.id), projectThreadIds);
  assert.deepEqual(tree.looseSessions.map((session) => session.id), [
    "thread_same_root_not_in_sidebar",
    "thread_old_project_history",
    "thread_generated_new_chat",
  ]);
  assert.deepEqual(tree.looseSessions.map((session) => session.projectReason), [
    "outside_sidebar_project_threads",
    "outside_current_projects",
    "codex_generated_workspace",
  ]);
});

test("session center explains mixed project and no-project classification reasons", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({
      "active-workspace-roots": ["C:/Users/Administrator/Documents/aaa"],
      "projectless-thread-ids": ["thread_marked_loose"],
      "sidebar-project-thread-orders": {
        "C:/Users/Administrator/Documents/aaa": [
          "thread_visible_one",
          "thread_visible_two",
        ],
      },
    }),
    "utf8",
  );
  createCodexThreadCatalogDb(codexDir, [
    {
      id: "thread_visible_one",
      title: "Visible One",
      cwd: "C:/Users/Administrator/Documents/aaa",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 50,
    },
    {
      id: "thread_visible_two",
      title: "Visible Two",
      cwd: "C:/Users/Administrator/Documents/aaa/src",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 40,
    },
    {
      id: "thread_old_inside_project",
      title: "Old Inside Project",
      cwd: "C:/Users/Administrator/Documents/aaa",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 30,
    },
    {
      id: "thread_marked_loose",
      title: "Marked Loose",
      cwd: "C:/Users/Administrator/Documents/aaa",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 20,
    },
    {
      id: "thread_generated_workspace",
      title: "Generated Workspace",
      cwd: "C:/Users/Administrator/Documents/Codex/2026-07/new-chat-7",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 10,
    },
  ]);

  const tree = listCodexSessionTree({ homeDir, limit: 50 });

  assert.equal(tree.summary.projects, 1);
  assert.equal(tree.summary.projectSessions, 2);
  assert.equal(tree.summary.looseSessions, 3);
  assert.deepEqual(tree.projects[0].sessions.map((session) => session.id), [
    "thread_visible_one",
    "thread_visible_two",
  ]);
  assert.deepEqual(tree.looseSessions.map((session) => session.id), [
    "thread_old_inside_project",
    "thread_marked_loose",
    "thread_generated_workspace",
  ]);
  assert.deepEqual(tree.classification.projectReasons, {
    sidebar_project_thread_order: 2,
    outside_sidebar_project_threads: 1,
    projectless_marker: 1,
    codex_generated_workspace: 1,
  });
  assert.equal(tree.classification.sidebarProjectThreadAssignments, 2);
  assert.equal(tree.classification.projectlessThreadMarkers, 1);
  assert.equal(tree.classification.workspaceRoots, 1);
});

test("session center applies sidebar thread authority only to the matching project root", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({
      "active-workspace-roots": [
        "C:/Users/Administrator/Documents/aaa",
        "C:/Users/Administrator/Documents/bbb",
      ],
      "sidebar-project-thread-orders": {
        "C:/Users/Administrator/Documents/aaa": ["thread_aaa_visible"],
      },
    }),
    "utf8",
  );
  createCodexThreadCatalogDb(codexDir, [
    {
      id: "thread_aaa_visible",
      title: "AAA Visible Session",
      cwd: "C:/Users/Administrator/Documents/aaa",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 30,
    },
    {
      id: "thread_aaa_old",
      title: "AAA Old Session",
      cwd: "C:/Users/Administrator/Documents/aaa",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 20,
    },
    {
      id: "thread_bbb_project",
      title: "BBB Project Session",
      cwd: "C:/Users/Administrator/Documents/bbb",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 10,
    },
  ]);

  const tree = listCodexSessionTree({ homeDir, limit: 50 });

  assert.equal(tree.summary.projects, 2);
  assert.equal(tree.summary.projectSessions, 2);
  assert.equal(tree.summary.looseSessions, 1);
  const projectSessions = new Map(tree.projects.map((project) => [
    project.name,
    project.sessions.map((session) => session.id),
  ]));
  assert.deepEqual(projectSessions.get("aaa"), ["thread_aaa_visible"]);
  assert.deepEqual(projectSessions.get("bbb"), ["thread_bbb_project"]);
  assert.deepEqual(tree.looseSessions.map((session) => session.id), ["thread_aaa_old"]);
});

test("session center ignores Codex generated output folders saved as workspace roots", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({
      "electron-saved-workspace-roots": [
        "C:/Users/Administrator/Documents/aaa",
        "C:/Users/Administrator/Documents/Codex/2026-06-24/new-chat-7",
        "C:/Users/Administrator/Documents/Codex/2026-06-23/plugin-computer-use-openai-bundled-play",
      ],
    }),
    "utf8",
  );
  createCodexThreadCatalogDb(codexDir, [
    {
      id: "thread_project",
      title: "Project Session",
      cwd: "C:/Users/Administrator/Documents/aaa",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 30,
    },
    {
      id: "thread_new_chat",
      title: "Projectless Chat",
      cwd: "C:/Users/Administrator/Documents/Codex/2026-06-24/new-chat-7",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 20,
    },
    {
      id: "thread_plugin_output",
      title: "Plugin Output Chat",
      cwd: "C:/Users/Administrator/Documents/Codex/2026-06-23/plugin-computer-use-openai-bundled-play",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 10,
    },
  ]);

  const tree = listCodexSessionTree({ homeDir, limit: 50 });

  assert.equal(tree.summary.sessions, 3);
  assert.equal(tree.summary.projects, 1);
  assert.equal(tree.summary.projectSessions, 1);
  assert.equal(tree.summary.looseSessions, 2);
  assert.deepEqual(tree.projects.map((item) => item.name), ["aaa"]);
  assert.deepEqual(tree.projects[0].sessions.map((item) => item.id), ["thread_project"]);
  assert.deepEqual(tree.looseSessions.map((item) => item.id), [
    "thread_new_chat",
    "thread_plugin_output",
  ]);
});

test("session center does not invent projects from cwd when Codex has no visible project roots", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({}),
    "utf8",
  );
  createCodexThreadCatalogDb(codexDir, [
    {
      id: "thread_plain_cwd",
      title: "Plain Cwd Chat",
      cwd: "C:/Users/Administrator/Documents/aaa",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 30,
    },
    {
      id: "thread_plugin_cwd",
      title: "Plugin Generated Chat",
      cwd: "C:/Users/Administrator/Documents/Codex/2026-06-23/plugin-computer-use-openai-bundled-play",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 20,
    },
  ]);

  const tree = listCodexSessionTree({ homeDir, limit: 50 });

  assert.equal(tree.summary.sessions, 2);
  assert.equal(tree.summary.projects, 0);
  assert.equal(tree.summary.projectSessions, 0);
  assert.equal(tree.summary.looseSessions, 2);
  assert.deepEqual(tree.projects, []);
  assert.deepEqual(tree.looseSessions.map((item) => item.id), [
    "thread_plain_cwd",
    "thread_plugin_cwd",
  ]);
  assert.deepEqual(tree.looseSessions.map((item) => item.projectReason), [
    "outside_current_projects",
    "codex_generated_workspace",
  ]);
});

test("session center keeps Codex generated chat folders loose when project roots are unavailable", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({}),
    "utf8",
  );
  createCodexThreadCatalogDb(codexDir, [
    {
      id: "thread_project",
      title: "Project Session",
      cwd: "C:/Users/Administrator/Documents/aaa",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 30,
    },
    {
      id: "thread_new_chat",
      title: "Loose Chat",
      cwd: "C:/Users/Administrator/Documents/Codex/2026-06-24/new-chat-7",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 20,
    },
    {
      id: "thread_plugin_output",
      title: "Plugin Output Chat",
      cwd: "C:/Users/Administrator/Documents/Codex/2026-06-23/plugin-computer-use-openai-bundled-play",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 10,
    },
  ]);

  const tree = listCodexSessionTree({ homeDir, limit: 50 });

  assert.equal(tree.summary.sessions, 3);
  assert.equal(tree.summary.projects, 0);
  assert.equal(tree.summary.projectSessions, 0);
  assert.equal(tree.summary.looseSessions, 3);
  assert.deepEqual(tree.projects, []);
  assert.deepEqual(tree.looseSessions.map((item) => item.id), [
    "thread_project",
    "thread_new_chat",
    "thread_plugin_output",
  ]);
  assert.deepEqual(tree.looseSessions.map((item) => item.projectReason), [
    "outside_current_projects",
    "codex_generated_workspace",
    "codex_generated_workspace",
  ]);
});

test("project recovery plan launches only real Codex project roots", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({
      "electron-saved-workspace-roots": [
        "C:/Users/Administrator/Documents/aaa",
        "C:/Users/Administrator/Documents/Codex/2026-06-24/new-chat-7",
        "C:/Users/Administrator/Documents/missing-project",
      ],
    }),
    "utf8",
  );
  createCodexThreadCatalogDb(codexDir, [
    {
      id: "thread_project",
      title: "Project Session",
      cwd: "C:/Users/Administrator/Documents/aaa",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 30,
    },
    {
      id: "thread_missing",
      title: "Missing Project Session",
      cwd: "C:/Users/Administrator/Documents/missing-project",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 20,
    },
    {
      id: "thread_new_chat",
      title: "Loose Chat",
      cwd: "C:/Users/Administrator/Documents/Codex/2026-06-24/new-chat-7",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 10,
    },
  ]);

  const plan = codexProjectRecoveryPlan({
    homeDir,
    limit: 50,
    exists: (targetPath) => targetPath.endsWith("/aaa") || targetPath.endsWith("\\aaa"),
  });

  assert.equal(plan.summary.projects, 2);
  assert.equal(plan.summary.launchableProjects, 1);
  assert.equal(plan.summary.missingProjects, 1);
  assert.deepEqual(plan.launchRoots.map((item) => item.name), ["aaa"]);
  assert.deepEqual(plan.missingRoots.map((item) => item.name), ["missing-project"]);
  assert.deepEqual(plan.looseSessions.map((item) => item.id), ["thread_new_chat"]);
});

test("project recovery plan separates history-only roots for automatic startup sync", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-auto-recovery-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({
      "project-order": ["F:/history-project"],
    }),
    "utf8",
  );
  createCodexThreadCatalogDb(codexDir, [
    {
      id: "thread_history",
      title: "History",
      cwd: "F:/history-project",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 10,
    },
  ]);

  const plan = codexProjectRecoveryPlan({
    homeDir,
    limit: 50,
    exists: () => true,
  });

  assert.deepEqual(plan.launchRoots.map((item) => item.name), ["history-project"]);
  assert.deepEqual(plan.autoLaunchRoots.map((item) => item.name), ["history-project"]);
  assert.equal(plan.summary.autoLaunchableProjects, 1);
});

test("sidebar recovery writes every scanned real session back to ChatGPT state without pinning threads", async () => {
  const settingsModule = await import("../desktop/settings.mjs");
  assert.equal(typeof settingsModule.recoverCodexSidebarState, "function");

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-sidebar-recovery-"));
  const codexDir = path.join(homeDir, ".codex");
  const statePath = path.join(codexDir, ".codex-global-state.json");
  const projectPath = path.join(homeDir, "Documents", "aaa");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      "electron-saved-workspace-roots": [],
      "pinned-thread-ids": ["thread-user-pinned"],
      "sidebar-project-thread-orders": {
        [projectPath]: ["thread-project-old"],
      },
      "projectless-thread-ids": ["thread-loose-old"],
      "thread-workspace-root-hints": {
        "thread-existing-hint": projectPath,
      },
      "unrelated-setting": true,
    }),
    "utf8",
  );

  const result = settingsModule.recoverCodexSidebarState({
    homeDir,
    sessionTree: {
      projects: [{
        path: projectPath,
        sessions: [
          { id: "thread-project-new-1" },
          { id: "thread-project-new-2" },
        ],
      }],
      looseSessions: [
        { id: "thread-loose-new-1" },
        { id: "thread-loose-new-2" },
        {
          id: "thread-project-missing-from-sidebar",
          workspacePath: projectPath,
          projectReason: "outside_sidebar_project_threads",
        },
      ],
    },
  });

  const restored = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(result.ok, true);
  assert.equal(result.projectSessions, 4);
  assert.equal(result.looseSessions, 3);
  assert.ok(result.backup && fs.existsSync(result.backup));
  assert.deepEqual(restored["sidebar-project-thread-orders"][projectPath], [
    "thread-project-new-1",
    "thread-project-new-2",
    "thread-project-missing-from-sidebar",
    "thread-project-old",
  ]);
  assert.deepEqual(restored["projectless-thread-ids"], [
    "thread-loose-new-1",
    "thread-loose-new-2",
    "thread-loose-old",
  ]);
  assert.equal(restored["thread-workspace-root-hints"]["thread-project-new-1"], projectPath);
  assert.equal(restored["thread-workspace-root-hints"]["thread-project-new-2"], projectPath);
  assert.deepEqual(restored["electron-saved-workspace-roots"], [projectPath]);
  assert.deepEqual(restored["pinned-thread-ids"], ["thread-user-pinned"]);
  assert.equal(restored["unrelated-setting"], true);
});

test("session center merges recoverable state history behind the latest local catalog", () => {
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
  const recoverableRollout = path.join(
    codexDir,
    "sessions",
    "2026",
    "07",
    "12",
    "rollout-thread_recoverable_state.jsonl",
  );
  fs.mkdirSync(path.dirname(recoverableRollout), { recursive: true });
  fs.writeFileSync(
    recoverableRollout,
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "recover this real local conversation" }],
      },
    }),
    "utf8",
  );
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
    {
      id: "thread_recoverable_state",
      modelProvider: "openai",
      title: "Recoverable State Session",
      source: "vscode",
      threadSource: "user",
      cwd: "F:/game_code/router",
      firstUserMessage: "recover this real local conversation",
      rolloutPath: recoverableRollout,
      recencyAtMs: 150,
    },
  ]);

  const sessions = listCodexSessions({ homeDir, limit: 50 });

  assert.deepEqual(
    sessions.map((item) => item.id),
    ["thread_catalog", "thread_recoverable_state"],
  );
  assert.equal(sessions[0].project, "router");
  assert.equal(sessions[0].projectPath, "F:/game_code/router");
  assert.equal(sessions[1].rolloutPath, recoverableRollout);
});

test("session export works for sessions that only exist in the Codex local thread catalog", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  const sessionDir = path.join(codexDir, "sessions", "2026", "07", "03");
  fs.mkdirSync(sessionDir, { recursive: true });
  const rolloutPath = path.join(sessionDir, "rollout-thread_catalog_only.jsonl");
  fs.writeFileSync(
    rolloutPath,
    [
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "catalog only question" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "catalog only answer" }] } }),
    ].join("\n"),
    "utf8",
  );
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({ "project-order": ["F:/game_code/router"] }),
    "utf8",
  );
  createCodexThreadCatalogDb(codexDir, [
    {
      id: "thread_catalog_only",
      title: "Catalog Only Session",
      cwd: "F:/game_code/router",
      sourceKind: "desktop",
      modelProvider: "openai",
      updatedAt: 200,
    },
  ]);

  const exported = exportCodexSessionMarkdown("thread_catalog_only", { homeDir });

  assert.match(exported.markdown, /# Catalog Only Session/);
  assert.match(exported.markdown, /Project: router/);
  assert.match(exported.markdown, /catalog only question/);
  assert.match(exported.markdown, /catalog only answer/);
  assert.match(exported.databasePath, /codex-dev\.db$/);
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

test("session center can load more than the old 50 item sidebar cap", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const rows = [];
  for (let index = 0; index < 75; index += 1) {
    rows.push({
      id: `thread_many_${String(index).padStart(2, "0")}`,
      modelProvider: "openai",
      model: "gpt-5.5",
      title: `Visible ${index}`,
      source: "desktop",
      threadSource: "user",
      archived: 0,
      hasUserEvent: 1,
      firstUserMessage: `hello ${index}`,
      recencyAtMs: 1000 - index,
    });
  }
  createCodexStateDbWithMetadata(codexDir, rows);

  const tree = listCodexSessionTree({ homeDir, limit: 500 });

  assert.equal(tree.summary.sessions, 75);
  assert.equal(tree.summary.loadedSessions, 75);
  assert.equal(tree.summary.limit, 500);
  assert.equal(tree.summary.mayHaveMore, false);
  assert.equal(tree.sessions.length, 75);
  assert.equal(tree.sessions[0].id, "thread_many_00");
  assert.equal(tree.sessions.at(-1).id, "thread_many_74");
});

test("session tree separates raw, user, catalog, sidebar, recoverable, internal, and archived counts", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  const projectPath = "F:/game_code/router";
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, ".codex-global-state.json"),
    JSON.stringify({
      "electron-saved-workspace-roots": [projectPath],
      "sidebar-project-thread-orders": { [projectPath]: ["thread_user_catalog"] },
      "projectless-thread-ids": [],
    }),
    "utf8",
  );
  const activeRollout = path.join(codexDir, "sessions", "2026", "07", "12", "rollout-thread_user_recoverable.jsonl");
  const catalogRollout = path.join(codexDir, "sessions", "2026", "07", "12", "rollout-thread_user_catalog.jsonl");
  const archivedRollout = path.join(codexDir, "archived_sessions", "2026", "07", "12", "rollout-thread_user_archived.jsonl");
  for (const [target, id] of [[activeRollout, "thread_user_recoverable"], [catalogRollout, "thread_user_catalog"], [archivedRollout, "thread_user_archived"]]) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, [
      JSON.stringify({ type: "session_meta", payload: { id, cwd: projectPath, source: "vscode" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: id }] } }),
    ].join("\n"), "utf8");
  }
  createCodexStateDbWithMetadata(codexDir, [
    { id: "thread_user_catalog", modelProvider: "openai", title: "Catalog", source: "vscode", threadSource: "user", cwd: projectPath, hasUserEvent: 1, rolloutPath: catalogRollout, recencyAtMs: 40 },
    { id: "thread_user_recoverable", modelProvider: "codexbridge", title: "Recoverable", source: "vscode", threadSource: "user", cwd: projectPath, hasUserEvent: 1, rolloutPath: activeRollout, recencyAtMs: 30 },
    { id: "thread_user_archived", modelProvider: "custom", title: "Archived", source: "vscode", threadSource: "user", cwd: projectPath, archived: 1, hasUserEvent: 1, rolloutPath: archivedRollout, recencyAtMs: 20 },
    { id: "thread_subagent", modelProvider: "openai", title: "Subagent", source: '{"subagent":{"thread_spawn":{}}}', threadSource: "subagent", cwd: projectPath, hasUserEvent: 0, recencyAtMs: 10 },
  ]);
  createCodexThreadCatalogDb(codexDir, [{
    id: "thread_user_catalog",
    title: "Catalog",
    cwd: projectPath,
    sourceKind: "vscode",
    modelProvider: "openai",
    updatedAt: 40,
  }]);

  const tree = listCodexSessionTree({ homeDir, limit: 50 });

  assert.equal(tree.summary.rawThreads, 4);
  assert.equal(tree.summary.userThreads, 3);
  assert.equal(tree.summary.activeUserThreads, 2);
  assert.equal(tree.summary.catalogThreads, 1);
  assert.equal(tree.summary.sidebarThreads, 1);
  assert.equal(tree.summary.recoverableThreads, 1);
  assert.equal(tree.summary.subagentThreads, 1);
  assert.equal(tree.summary.internalThreads, 0);
  assert.equal(tree.summary.archivedThreads, 1);
});

test("session center marks the list as limited when the load cap is reached", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const rows = [];
  for (let index = 0; index < 12; index += 1) {
    rows.push({
      id: `thread_limited_${String(index).padStart(2, "0")}`,
      modelProvider: "openai",
      model: "gpt-5.5",
      title: `Limited ${index}`,
      source: "desktop",
      threadSource: "user",
      archived: 0,
      hasUserEvent: 1,
      firstUserMessage: `limited ${index}`,
      recencyAtMs: 1000 - index,
    });
  }
  createCodexStateDbWithMetadata(codexDir, rows);

  const tree = listCodexSessionTree({ homeDir, limit: 10 });

  assert.equal(tree.summary.sessions, 10);
  assert.equal(tree.summary.loadedSessions, 10);
  assert.equal(tree.summary.limit, 10);
  assert.equal(tree.summary.mayHaveMore, true);
  assert.equal(tree.sessions.length, 10);
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
  assert.equal(byId.get("qianfan")?.baseUrl, "https://qianfan.baidubce.com/v2");
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

test("GPT subscription and OpenAI presets omit GPT from display names without changing upstream model ids", () => {
  const official = MODEL_PRESETS
    .filter((model) => ["codex", "openai"].includes(model.providerId))
    .map((model) => [model.presetId, model.displayName, model.model]);

  assert.deepEqual(official, [
    ["codex-gpt-5-6", "5.6（订阅兼容）", "gpt-5.6"],
    ["codex-gpt-5-6-sol", "5.6-Sol", "gpt-5.6-sol"],
    ["codex-gpt-5-6-terra", "5.6-Terra", "gpt-5.6-terra"],
    ["codex-gpt-5-6-luna", "5.6-Luna", "gpt-5.6-luna"],
    ["codex-gpt-5-5", "5.5", "gpt-5.5"],
    ["codex-gpt-5-4", "5.4", "gpt-5.4"],
    ["codex-gpt-5-4-mini", "5.4-Mini", "gpt-5.4-mini"],
    ["openai-gpt-4-1", "OpenAI 4.1", "gpt-4.1"],
    ["openai-gpt-4-1-mini", "OpenAI 4.1 Mini", "gpt-4.1-mini"],
  ]);
});

test("built-in DeepSeek presets do not expose the retired deepseek-reasoner alias", () => {
  const retired = MODEL_PRESETS.filter((preset) =>
    preset.providerId === "deepseek" && preset.model === "deepseek-reasoner"
  );

  assert.deepEqual(retired, []);
});

test("vision-capable presets advertise image input and text-only presets stay text-only", () => {
  const byId = new Map(MODEL_PRESETS.map((model) => [model.presetId, model]));

  assert.deepEqual(byId.get("codex-gpt-5-6-sol")?.inputModalities, ["text", "image"]);
  assert.deepEqual(byId.get("codex-gpt-5-6-terra")?.inputModalities, ["text", "image"]);
  assert.deepEqual(byId.get("codex-gpt-5-6-luna")?.inputModalities, ["text", "image"]);
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

  for (const presetId of [
    "codex-gpt-5-6",
    "codex-gpt-5-6-sol",
    "codex-gpt-5-6-terra",
    "codex-gpt-5-6-luna",
    "codex-gpt-5-5",
    "codex-gpt-5-4",
  ]) {
    assert.deepEqual(byId.get(presetId)?.additionalSpeedTiers, ["fast"]);
    assert.deepEqual(byId.get(presetId)?.serviceTiers, fastTier);
  }
  assert.equal(byId.get("codex-gpt-5-4-mini")?.serviceTiers, undefined);
  assert.equal(byId.get("openai-gpt-4-1")?.serviceTiers, undefined);
});

test("native GPT subscription presets use the Codex desktop context window", () => {
  const byId = new Map(MODEL_PRESETS.map((model) => [model.presetId, model]));

  assert.equal(byId.get("codex-gpt-5-6")?.contextWindow, 372000);
  assert.equal(byId.get("codex-gpt-5-6-sol")?.contextWindow, 372000);
  assert.equal(byId.get("codex-gpt-5-6-terra")?.contextWindow, 372000);
  assert.equal(byId.get("codex-gpt-5-6-luna")?.contextWindow, 372000);
  assert.equal(byId.get("codex-gpt-5-5")?.contextWindow, 258400);
  assert.equal(byId.get("codex-gpt-5-4")?.contextWindow, 258400);
  assert.equal(byId.get("codex-gpt-5-4-mini")?.contextWindow, 258400);
});

test("native GPT 5.6 presets expose current Codex reasoning and Responses Lite metadata", () => {
  const byId = new Map(MODEL_PRESETS.map((model) => [model.presetId, model]));
  const compatible = byId.get("codex-gpt-5-6");
  const sol = byId.get("codex-gpt-5-6-sol");
  const terra = byId.get("codex-gpt-5-6-terra");
  const luna = byId.get("codex-gpt-5-6-luna");

  assert.equal(compatible?.model, "gpt-5.6");
  assert.equal(compatible?.displayName, "5.6（订阅兼容）");
  assert.match(compatible?.userDescription || "", /ChatGPT 订阅账号/);
  assert.match(compatible?.userDescription || "", /不固定为 Sol、Terra 或 Luna/);
  assert.equal(sol?.model, "gpt-5.6-sol");
  assert.equal(terra?.model, "gpt-5.6-terra");
  assert.equal(luna?.model, "gpt-5.6-luna");
  assert.equal(sol?.defaultReasoningLevel, "low");
  assert.equal(terra?.defaultReasoningLevel, "medium");
  assert.equal(luna?.defaultReasoningLevel, "medium");
  assert.deepEqual(sol?.supportedReasoningLevels.map((item) => item.effort), [
    "low", "medium", "high", "xhigh", "max", "ultra",
  ]);
  assert.deepEqual(luna?.supportedReasoningLevels.map((item) => item.effort), [
    "low", "medium", "high", "xhigh", "max",
  ]);
  for (const preset of [compatible, sol, terra, luna]) {
    assert.equal(preset?.useResponsesLite, true);
    assert.equal(preset?.supportsReasoningSummaries, true);
    assert.equal(preset?.defaultReasoningSummary, "auto");
    assert.equal(preset?.supportVerbosity, true);
    assert.equal(preset?.defaultVerbosity, "low");
    assert.equal(preset?.webSearchToolType, "text_and_image");
  }
});

test("buildRouterConfigFromSelection exposes the explicit GPT 5.6 subscription-compatible route", () => {
  const rootDir = makeTempProject();
  saveSelection(rootDir, ["codex-gpt-5-6"], MODE_HYBRID);

  const config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.equal(config.models.length, 1);
  assert.equal(config.models[0].id, "cb-gpt-5-6");
  assert.equal(config.models[0].model, "gpt-5.6");
  assert.equal(config.models[0].displayName, "5.6（订阅兼容）");
  assert.match(config.models[0].description || "", /账号不支持显式 5.6-Sol/);
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

test("buildRouterConfigFromSelection exports configured capability providers for router-side tools", () => {
  const rootDir = makeTempProject();
  saveSelection(rootDir, ["codex-gpt-5-5", "deepseek-v4-pro"], MODE_HYBRID);
  saveCapabilityProvider(rootDir, {
    id: "local-browser",
    name: "Local Browser",
    capability: "browser",
    adapter: "local_browser",
    makeDefault: true,
  });
  saveCapabilityProvider(rootDir, {
    id: "paddle-ocr",
    name: "Paddle OCR",
    capability: "ocr",
    adapter: "generic_http",
    baseUrl: "https://ocr.example.com/v1",
    endpoint: "/ocr",
    model: "ocr-v1",
    apiKeyEnv: "OCR_API_KEY",
    makeDefault: true,
  });

  const config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.ok(Array.isArray(config.capabilityProviders));
  const providersById = new Map(config.capabilityProviders.map((provider) => [provider.id, provider]));
  assert.equal(providersById.get("local-browser").adapter, "local_browser");
  assert.deepEqual(providersById.get("local-browser").capabilities, ["browser"]);
  assert.deepEqual(providersById.get("local-browser").defaultCapabilities, ["browser"]);
  assert.equal(providersById.get("paddle-ocr").baseUrl, "https://ocr.example.com/v1");
  assert.equal(providersById.get("paddle-ocr").endpoint, "/ocr");
  assert.equal(providersById.get("paddle-ocr").model, "ocr-v1");
  assert.equal(providersById.get("paddle-ocr").apiKeyEnv, "OCR_API_KEY");
  assert.equal(providersById.get("paddle-ocr").apiKey, undefined);
  assert.equal(config.localExecutorUrl, undefined);
  assert.equal(config.localExecutorToken, undefined);
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

test("stale selected built-in model is replaced by the synced provider model", () => {
  const rootDir = makeTempProject();
  fs.mkdirSync(path.join(rootDir, "config"), { recursive: true });
  fs.writeFileSync(
    modelDirectoryPath(rootDir),
    JSON.stringify({
      version: 1,
      providers: {
        "kimi-code": {
          providerId: "kimi-code",
          providerName: "Kimi Code",
          baseUrl: "https://api.kimi.com/coding/v1",
          models: [{ id: "kimi-for-coding" }],
        },
      },
    }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    selectionPath(rootDir),
    JSON.stringify({ selectedModelIds: ["kimi-code-k3"] }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    routerConfigPath(rootDir),
    JSON.stringify({ mode: MODE_HYBRID, models: [] }, null, 2),
    "utf8",
  );

  assert.doesNotThrow(() => saveProviderOverride(rootDir, "kimi-code", {
    name: "Kimi Code",
    baseUrl: "https://api.kimi.com/coding/v1",
    api: "chat_completions",
  }));

  const config = readRouterConfig(rootDir);
  assert.equal(config.models.length, 1);
  assert.equal(config.models[0].sourcePresetId, "kimi-code-for-coding");
  assert.equal(config.models[0].model, "kimi-for-coding");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(selectionPath(rootDir), "utf8")).selectedModelIds,
    ["kimi-code-for-coding"],
  );
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
  assert.equal(config.clientAuth.allowOpenAiBearer, false);
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
  assert.equal(names.get("cb-openai-gpt-4-1"), "OpenAI 4.1");
  assert.equal(names.get("cb-deepseek-v4-pro"), "DeepSeek V4 Pro");
  assert.equal(names.get("cb-kimi-k2-7-code"), "Kimi K2.7 Code");
  assert.equal(catalog.models.some((model) => model.display_name === "自定义"), false);
});

test("Codex-visible GPT 5.6 catalog enables automatic reasoning summaries", () => {
  const rootDir = makeTempProject();
  saveSelection(rootDir, ["codex-gpt-5-6-sol"], MODE_HYBRID);
  writeRouterConfigFromSelection(rootDir, MODE_HYBRID);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));

  applyCodexConfig({ rootDir, mode: MODE_HYBRID, homeDir });

  const catalogFile = path.join(homeDir, ".codex", "codexbridge-model-catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  const model = catalog.models.find((item) => item.slug === "cb-gpt-5-6-sol");

  assert.equal(model?.supports_reasoning_summaries, true);
  assert.equal(model?.default_reasoning_summary, "auto");
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
    assert.equal(first.codexbridge_capabilities.matrix.version, "route-capability-matrix-v1");
    assert.equal(first.codexbridge_capabilities.summary.version, "route-capability-matrix-v1");
    assert.equal(deepseek.supports_tools, "chat-functions");
    assert.equal(deepseek.supports_mcp_namespaces, true);
    assert.equal(deepseek.codexbridge_capabilities.mcp_namespaces, "native");
    assert.equal(
      deepseek.codexbridge_capabilities.matrix.items.find((item) => item.key === "files").state,
      "degraded",
    );
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

test("reserved Router control vars cannot be saved as provider API key envs", () => {
  const rootDir = makeTempProject();
  for (const apiKeyEnv of [
    "CODEXBRIDGE_DATA_DIR",
    "ROUTER_CONFIG",
    "CODEXBRIDGE_SECRETS_FILE",
  ]) {
    assert.throws(
      () => saveCustomModel(rootDir, {
        providerName: `Custom ${apiKeyEnv}`,
        displayName: `Custom ${apiKeyEnv}`,
        model: `model-${apiKeyEnv.toLowerCase()}`,
        baseUrl: "https://api.example.test/v1",
        keyEnv: apiKeyEnv,
      }),
      /Router control environment variable/i,
    );
    assert.throws(
      () => saveCapabilityProvider(rootDir, {
        id: `cap-${apiKeyEnv.toLowerCase()}`,
        name: `Capability ${apiKeyEnv}`,
        capability: "ocr",
        baseUrl: "https://capability.example.test/v1",
        apiKeyEnv,
      }),
      /Router control environment variable/i,
    );
    assert.throws(
      () => saveImageProvider(rootDir, {
        id: `image-${apiKeyEnv.toLowerCase()}`,
        name: `Image ${apiKeyEnv}`,
        model: "image-model",
        baseUrl: "https://image.example.test/v1",
        apiKeyEnv,
      }),
      /Router control environment variable/i,
    );
  }
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
    outputDir: imageOutputDirPath(rootDir),
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
    outputDir: imageOutputDirPath(rootDir),
    historyPath: imageGenerationHistoryPath(rootDir),
  });
});

test("image generation provider library stores multiple providers and a default", () => {
  const rootDir = makeTempProject();

  const siliconflow = saveImageProvider(rootDir, {
    id: "siliconflow-kolors",
    name: "硅基流动 Kolors",
    adapter: "siliconflow_images",
    baseUrl: "https://api.siliconflow.cn/v1",
    endpoint: "/images/generations",
    model: "Kwai-Kolors/Kolors",
    size: "1024x1024",
    apiKeyEnv: "SILICONFLOW_API_KEY",
    defaults: {
      batch_size: 1,
      num_inference_steps: 20,
      guidance_scale: 7.5,
    },
    makeDefault: true,
  });
  const zai = saveImageProvider(rootDir, {
    id: "zai-glm-image",
    name: "智谱 GLM Image",
    adapter: "zai_images",
    baseUrl: "https://api.z.ai/api/paas/v4",
    endpoint: "/images/generations",
    model: "glm-image",
    size: "1280x1280",
    apiKeyEnv: "ZAI_API_KEY",
  });

  assert.equal(siliconflow.id, "siliconflow-kolors");
  assert.equal(zai.id, "zai-glm-image");
  assert.deepEqual(readImageProviders(rootDir).map((provider) => provider.id), [
    "siliconflow-kolors",
    "zai-glm-image",
  ]);
  assert.equal(readImageProviderConfig(rootDir).defaultProviderId, "siliconflow-kolors");
});

test("image providers are exposed as generic capability providers", () => {
  const rootDir = makeTempProject();

  saveImageProvider(rootDir, {
    id: "siliconflow-kolors",
    name: "硅基流动 Kolors",
    adapter: "siliconflow_images",
    baseUrl: "https://api.siliconflow.cn/v1",
    endpoint: "/images/generations",
    model: "Kwai-Kolors/Kolors",
    size: "1024x1024",
    apiKeyEnv: "SILICONFLOW_API_KEY",
    makeDefault: true,
  });
  saveImageProvider(rootDir, {
    id: "zai-glm-image",
    name: "智谱 GLM Image",
    adapter: "zai_images",
    baseUrl: "https://api.z.ai/api/paas/v4",
    endpoint: "/images/generations",
    model: "glm-image",
    size: "1280x1280",
    apiKeyEnv: "ZAI_API_KEY",
    priority: 20,
  });

  const providers = readCapabilityProviders(rootDir);
  const registry = capabilityProviderRegistry(rootDir);

  assert.deepEqual(providers.map((provider) => provider.id), [
    "siliconflow-kolors",
    "zai-glm-image",
  ]);
  assert.deepEqual(providers.map((provider) => provider.capabilities), [
    ["image_generation"],
    ["image_generation"],
  ]);
  assert.equal(providers[0].default, true);
  assert.equal(providers[0].kind, "image_provider");
  assert.equal(providers[0].adapter, "siliconflow_images");
  assert.equal(providers[1].priority, 20);
  assert.equal(registry.select("image_generation").id, "siliconflow-kolors");
  assert.equal(registry.select("image_generation", { providerId: "zai-glm-image" }).id, "zai-glm-image");
  assert.equal(registry.select("ocr"), null);
  assert.deepEqual(registry.summary().capabilities, { image_generation: 2 });
});

test("custom capability providers can be saved and selected per ability", () => {
  const rootDir = makeTempProject();

  saveCapabilityProvider(rootDir, {
    id: "paddle-ocr",
    name: "Paddle OCR",
    capability: "ocr",
    adapter: "generic_http",
    baseUrl: "https://ocr.example.com/v1",
    endpoint: "/ocr",
    model: "ocr-v1",
    apiKeyEnv: "OCR_API_KEY",
    makeDefault: true,
    priority: 20,
  });
  saveCapabilityProvider(rootDir, {
    id: "bocha-search",
    name: "Bocha Search",
    capability: "web_search",
    adapter: "generic_http",
    baseUrl: "https://api.bochaai.com/v1",
    endpoint: "/web-search",
    apiKeyEnv: "BOCHA_API_KEY",
    makeDefault: true,
    priority: 10,
  });
  saveCapabilityProvider(rootDir, {
    id: "local-browser",
    name: "Local Browser",
    capability: "browser",
    adapter: "local_browser",
    enabled: false,
  });

  const config = readCapabilityProviderConfig(rootDir);
  const providers = readCapabilityProviders(rootDir);
  const groups = readCapabilityProviderGroups(rootDir);
  const registry = capabilityProviderRegistry(rootDir);
  const byCapability = new Map(groups.map((group) => [group.capability, group]));

  assert.deepEqual(config.defaults, {
    ocr: "paddle-ocr",
    web_search: "bocha-search",
  });
  assert.deepEqual(providers.map((provider) => provider.id), [
    "paddle-ocr",
    "bocha-search",
    "local-browser",
  ]);
  assert.equal(providers.find((provider) => provider.id === "paddle-ocr").source, "capabilityProviders");
  assert.deepEqual(providers.find((provider) => provider.id === "paddle-ocr").defaultCapabilities, ["ocr"]);
  assert.equal(registry.select("ocr").id, "paddle-ocr");
  assert.equal(registry.select("web_search").id, "bocha-search");
  assert.equal(registry.select("browser"), null);
  assert.equal(byCapability.get("ocr").defaultProviderId, "paddle-ocr");
  assert.equal(byCapability.get("web_search").defaultProviderId, "bocha-search");
  assert.equal(byCapability.get("browser").disabledCount, 1);

  const removed = removeCapabilityProvider(rootDir, "paddle-ocr");
  assert.equal(removed.defaults.ocr, undefined);
  assert.equal(capabilityProviderRegistry(rootDir).select("ocr"), null);
});

test("capability provider connection test posts a generic HTTP health request and stores result", async () => {
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "paddle-ocr",
    name: "Paddle OCR",
    capability: "ocr",
    adapter: "generic_http",
    baseUrl: "https://ocr.example.com/v1",
    endpoint: "/ocr",
    model: "ocr-v1",
    apiKeyEnv: "OCR_API_KEY",
    makeDefault: true,
  });
  saveSecrets(rootDir, { OCR_API_KEY: "ocr-secret" });

  const requests = [];
  const result = await testCapabilityProviderConnection(rootDir, "paddle-ocr", {
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, id: "test_ocr_1" }),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.providerId, "paddle-ocr");
  assert.equal(result.endpoint, "https://ocr.example.com/v1/ocr");
  assert.match(result.message, /体检通过|测试通过/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://ocr.example.com/v1/ocr");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers.Authorization, "Bearer ocr-secret");
  assert.equal(requests[0].options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    capability: "ocr",
    input: "ping",
    model: "ocr-v1",
    test: true,
  });
  assert.equal(result.checks.find((check) => check.id === "api_key").status, "pass");
  assert.equal(result.checks.find((check) => check.id === "request").status, "pass");
  assert.equal(result.checks.find((check) => check.id === "response_format").status, "pass");

  const saved = saveCapabilityProviderTestResult(rootDir, "paddle-ocr", result);
  const provider = readCapabilityProviders(rootDir).find((item) => item.id === "paddle-ocr");

  assert.equal(saved.ok, true);
  assert.equal(provider.lastTest.ok, true);
  assert.equal(provider.lastTest.status, "pass");
  assert.equal(provider.lastTest.checks.find((check) => check.id === "request").status, "pass");
});

test("capability provider test results are redacted before being stored", () => {
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "bocha-search",
    name: "Bocha Search",
    capability: "web_search",
    adapter: "generic_http",
    baseUrl: "https://api.bochaai.com/v1",
    endpoint: "/web-search",
    apiKeyEnv: "BOCHA_API_KEY",
    makeDefault: true,
  });

  const saved = saveCapabilityProviderTestResult(rootDir, "bocha-search", {
    ok: false,
    message: "HTTP 401 Bearer sk-capability-test-message-secret",
    checks: [
      {
        id: "auth",
        label: "认证",
        status: "fail",
        detail: "Authorization failed with token sk-capability-test-detail-secret",
      },
    ],
  });
  const provider = readCapabilityProviders(rootDir).find((item) => item.id === "bocha-search");
  const serialized = JSON.stringify(provider.lastTest);

  assert.equal(saved.ok, false);
  assert.doesNotMatch(serialized, /sk-capability-test-message-secret/);
  assert.doesNotMatch(serialized, /sk-capability-test-detail-secret/);
  assert.match(provider.lastTest.message, /Bearer \[REDACTED\]/);
  assert.match(provider.lastTest.checks[0].detail, /sk-\[REDACTED\]/);
});

test("capability provider connection diagnostics validate model permission and response format", async () => {
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "paddle-ocr",
    name: "Paddle OCR",
    capability: "ocr",
    adapter: "generic_http",
    baseUrl: "https://ocr.example.com/v1",
    endpoint: "/ocr",
    model: "ocr-v1",
    apiKeyEnv: "OCR_API_KEY",
  });
  saveSecrets(rootDir, { OCR_API_KEY: "ocr-secret" });

  const result = await testCapabilityProviderConnection(rootDir, "paddle-ocr", {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, text: "invoice total 42" }),
    }),
  });

  assert.equal(result.ok, true);
  assert.match(result.message, /体检通过/);
  assert.equal(result.checks.find((check) => check.id === "adapter").status, "pass");
  assert.equal(result.checks.find((check) => check.id === "quota_permission").status, "pass");
  assert.equal(result.checks.find((check) => check.id === "model_name").status, "pass");
  assert.match(result.checks.find((check) => check.id === "model_name").message, /ocr-v1/);
  assert.equal(result.checks.find((check) => check.id === "response_format").status, "pass");
});

test("capability provider connection diagnostics explain quota and model failures in Chinese", async () => {
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "bocha-search",
    name: "Bocha Search",
    capability: "web_search",
    adapter: "generic_http",
    baseUrl: "https://api.bochaai.com/v1",
    endpoint: "/web-search",
    model: "bad-search-model",
    apiKeyEnv: "BOCHA_API_KEY",
  });
  saveSecrets(rootDir, { BOCHA_API_KEY: "search-secret" });

  const quotaResult = await testCapabilityProviderConnection(rootDir, "bocha-search", {
    fetchImpl: async () => ({
      ok: false,
      status: 402,
      text: async () => '{"error":{"message":"insufficient_quota"}}',
    }),
  });

  assert.equal(quotaResult.ok, false);
  assert.equal(quotaResult.status, 402);
  assert.match(quotaResult.message, /余额|额度/);
  assert.equal(quotaResult.checks.find((check) => check.id === "quota_permission").status, "fail");
  assert.match(quotaResult.checks.find((check) => check.id === "quota_permission").message, /余额|额度/);
  assert.equal(quotaResult.checks.find((check) => check.id === "model_name").status, "warn");

  const modelResult = await testCapabilityProviderConnection(rootDir, "bocha-search", {
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      text: async () => '{"error":{"message":"model bad-search-model not found"}}',
    }),
  });

  assert.equal(modelResult.ok, false);
  assert.equal(modelResult.checks.find((check) => check.id === "model_name").status, "fail");
  assert.match(modelResult.checks.find((check) => check.id === "model_name").message, /模型|model/i);

  const rateLimitedResult = await testCapabilityProviderConnection(rootDir, "bocha-search", {
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      text: async () => '{"error":{"message":"Too Many Requests; retry after 30s"}}',
    }),
  });

  assert.equal(rateLimitedResult.ok, false);
  assert.equal(rateLimitedResult.status, 429);
  assert.equal(rateLimitedResult.checks.find((check) => check.id === "rate_limit").status, "fail");
  assert.match(rateLimitedResult.checks.find((check) => check.id === "rate_limit").message, /限流|30s|稍后/);
  assert.equal(rateLimitedResult.checks.find((check) => check.id === "quota_permission").status, "warn");

  const rateLimitedHeaderResult = await testCapabilityProviderConnection(rootDir, "bocha-search", {
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: {
        get: (name) => (String(name).toLowerCase() === "retry-after" ? "45" : null),
      },
      text: async () => '{"error":{"message":"Too Many Requests"}}',
    }),
  });

  assert.equal(rateLimitedHeaderResult.ok, false);
  assert.equal(rateLimitedHeaderResult.status, 429);
  assert.match(rateLimitedHeaderResult.message, /45s/);
  assert.match(rateLimitedHeaderResult.checks.find((check) => check.id === "rate_limit").message, /45s/);
});

test("capability provider connection diagnostics flag invalid JSON response formats", async () => {
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "screenshot-api",
    name: "Screenshot API",
    capability: "webpage_screenshot",
    adapter: "generic_http",
    baseUrl: "https://capture.example.com/v1",
    endpoint: "/screenshots",
    apiKeyEnv: "SCREENSHOT_API_KEY",
  });
  saveSecrets(rootDir, { SCREENSHOT_API_KEY: "screenshot-secret" });

  const result = await testCapabilityProviderConnection(rootDir, "screenshot-api", {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => "<html>not json</html>",
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.find((check) => check.id === "response_format").status, "fail");
  assert.match(result.checks.find((check) => check.id === "response_format").message, /JSON|格式/);
});

test("capability provider connection failures never reflect API keys or remote response bodies", async () => {
  const rootDir = makeTempProject();
  const secret = "opaque-capability-key-314159";
  const remoteMarker = "capability-upstream-private-body";
  saveCapabilityProvider(rootDir, {
    id: "secure-search",
    name: "Secure Search",
    capability: "web_search",
    adapter: "generic_http",
    baseUrl: "https://search.example.test/v1",
    endpoint: "/search",
    model: "secure-search-v1",
    apiKeyEnv: "SECURE_SEARCH_API_KEY",
  });
  saveSecrets(rootDir, { SECURE_SEARCH_API_KEY: secret });

  const httpResult = await testCapabilityProviderConnection(rootDir, "secure-search", {
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({
        error: { message: `model secure-search-v1 rejected ${secret} ${remoteMarker}` },
      }),
    }),
  });
  const transportResult = await testCapabilityProviderConnection(rootDir, "secure-search", {
    fetchImpl: async () => {
      throw new Error(`socket failed ${secret} ${remoteMarker}`);
    },
  });

  for (const result of [httpResult, transportResult]) {
    const serialized = JSON.stringify(result);
    assert.equal(result.ok, false);
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.doesNotMatch(serialized, new RegExp(remoteMarker));
  }
});

test("capability provider connection test fails before network when required API key is missing", async () => {
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "bocha-search",
    name: "Bocha Search",
    capability: "web_search",
    adapter: "generic_http",
    baseUrl: "https://api.bochaai.com/v1",
    endpoint: "/web-search",
    apiKeyEnv: "BOCHA_API_KEY",
  });
  let fetchCalled = false;

  const result = await testCapabilityProviderConnection(rootDir, "bocha-search", {
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called without a key");
    },
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.ok, false);
  assert.equal(result.providerId, "bocha-search");
  assert.match(result.message, /API Key/);
  assert.equal(result.checks.find((check) => check.id === "api_key").status, "fail");
});

test("capability provider connection test verifies local browser executor without API keys", async () => {
  const { createDesktopLocalCapabilityExecutor } = require("../desktop/local-capabilities.cjs");
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "local-browser",
    name: "Local Browser",
    capability: "browser",
    adapter: "local_browser",
    makeDefault: true,
  });

  const result = await testCapabilityProviderConnection(rootDir, "local-browser", {
    localCapabilityExecutor: createDesktopLocalCapabilityExecutor({
      openExternal: async () => {
        throw new Error("diagnose should not open");
      },
      fetchImpl: async () => {
        throw new Error("diagnose should not fetch");
      },
      capturePageScreenshot: async () => {
        throw new Error("diagnose should not screenshot");
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.providerId, "local-browser");
  assert.equal(result.endpoint, "");
  assert.match(result.message, /本地能力体检通过/);
  assert.equal(result.checks.some((check) => check.id === "executor" && check.status === "pass"), true);
  assert.equal(result.checks.some((check) => check.id === "actions" && /open_url/.test(check.detail)), true);
  assert.equal(result.checks.some((check) => check.id === "api_key"), false);
});

test("executeCapabilityProvider posts a generic HTTP request through the selected provider", async () => {
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "paddle-ocr",
    name: "Paddle OCR",
    capability: "ocr",
    adapter: "generic_http",
    baseUrl: "https://ocr.example.com/v1",
    endpoint: "/ocr",
    model: "ocr-v1",
    apiKeyEnv: "OCR_API_KEY",
    makeDefault: true,
  });
  saveSecrets(rootDir, { OCR_API_KEY: "ocr-secret" });

  const requests = [];
  const result = await executeCapabilityProvider(rootDir, {
    capability: "ocr",
    providerId: "paddle-ocr",
    input: { imageUrl: "https://example.com/receipt.png" },
    sourceModel: "deepseek-v4-pro",
    requestId: "req_ocr_manual",
  }, {
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ text: "total 42", confidence: 0.98 }),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.handled, true);
  assert.equal(result.failed, false);
  assert.equal(result.capability, "ocr");
  assert.equal(result.providerId, "paddle-ocr");
  assert.equal(result.endpoint, "https://ocr.example.com/v1/ocr");
  assert.equal(result.response.output_text, "total 42");
  assert.deepEqual(result.upstream, { text: "total 42", confidence: 0.98 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://ocr.example.com/v1/ocr");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers.Authorization, "Bearer ocr-secret");
  assert.equal(requests[0].options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    capability: "ocr",
    input: { imageUrl: "https://example.com/receipt.png" },
    model: "ocr-v1",
    requestId: "req_ocr_manual",
    sourceModel: "deepseek-v4-pro",
  });
  assert.deepEqual(result.trace.map((item) => item.phase), [
    "selectProvider",
    "execute",
    "saveResult",
    "buildResponse",
    "recordHistory",
  ]);
});

test("executeCapabilityProvider rejects oversized generic HTTP responses before reading the body", async () => {
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "large-ocr",
    name: "Large OCR",
    capability: "ocr",
    adapter: "generic_http",
    baseUrl: "https://ocr.example.com/v1",
    endpoint: "/ocr",
    apiKeyEnv: "OCR_API_KEY",
    makeDefault: true,
    maxResponseBytes: 1024,
  });
  saveSecrets(rootDir, { OCR_API_KEY: "ocr-secret" });
  let textCalled = false;

  const result = await executeCapabilityProvider(rootDir, {
    capability: "ocr",
    input: { imageUrl: "https://example.com/large.png" },
    requestId: "req_large_ocr_response",
  }, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: {
        get: (name) => String(name).toLowerCase() === "content-length" ? "2048" : "",
      },
      text: async () => {
        textCalled = true;
        return JSON.stringify({ text: "this body should not be read" });
      },
    }),
  });

  assert.equal(textCalled, false);
  assert.equal(result.ok, false);
  assert.equal(result.failed, true);
  assert.equal(result.error.code, "provider_response_too_large");
  assert.equal(result.errorPhase, "execute");
  assert.match(result.response.output_text, /response|响应|过大|large/i);

  const history = readCapabilityExecutionHistory(rootDir);
  assert.equal(history.length, 1);
  assert.equal(history[0].ok, false);
  assert.equal(history[0].errorCode, "provider_response_too_large");
  assert.equal(history[0].errorPhase, "execute");
});

test("executeCapabilityProvider includes provider default payload fields without overriding request fields", async () => {
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "speech-api",
    name: "Speech API",
    capability: "speech",
    adapter: "generic_http",
    baseUrl: "https://speech.example.com/v1",
    endpoint: "/speech",
    model: "speech-v1",
    makeDefault: true,
    defaults: {
      voice: "warm",
      format: "mp3",
      input: { should_not_override: true },
      model: "default-should-not-override",
    },
  });
  let requestBody = null;

  const result = await executeCapabilityProvider(rootDir, {
    capability: "speech",
    input: { action: "synthesize", text: "Welcome to CodexBridge." },
    options: { speed: 1.05 },
  }, {
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ text: "speech ready" }),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(requestBody, {
    voice: "warm",
    format: "mp3",
    capability: "speech",
    input: { action: "synthesize", text: "Welcome to CodexBridge." },
    model: "speech-v1",
    options: { speed: 1.05 },
  });
});

test("executeCapabilityProvider records successful generic capability runs", async () => {
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "paddle-ocr",
    name: "Paddle OCR",
    capability: "ocr",
    adapter: "generic_http",
    baseUrl: "https://ocr.example.com/v1",
    endpoint: "/ocr",
    apiKeyEnv: "OCR_API_KEY",
    makeDefault: true,
  });
  saveSecrets(rootDir, { OCR_API_KEY: "ocr-secret" });

  const result = await executeCapabilityProvider(rootDir, {
    capability: "ocr",
    input: { imageUrl: "https://example.com/receipt.png" },
    sourceModel: "deepseek-v4-pro",
    requestId: "req_ocr_history",
  }, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ text: "total 42", confidence: 0.98 }),
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.historyItem.providerId, "paddle-ocr");
  assert.equal(fs.existsSync(capabilityExecutionHistoryPath(rootDir)), true);
  const history = readCapabilityExecutionHistory(rootDir);
  assert.equal(history.length, 1);
  assert.equal(history[0].id, result.historyItem.id);
  assert.equal(history[0].ok, true);
  assert.equal(history[0].capability, "ocr");
  assert.equal(history[0].providerName, "Paddle OCR");
  assert.equal(history[0].sourceModel, "deepseek-v4-pro");
  assert.equal(history[0].requestId, "req_ocr_history");
  assert.equal(history[0].outputText, "total 42");
  assert.match(history[0].inputSummary, /receipt\.png/);
});

test("executeCapabilityProvider redacts secrets from generic capability history", async () => {
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "secure-search",
    name: "Secure Search",
    capability: "web_search",
    adapter: "generic_http",
    baseUrl: "https://search.example.com/v1",
    endpoint: "/search",
    apiKeyEnv: "SECURE_SEARCH_API_KEY",
    makeDefault: true,
  });
  saveSecrets(rootDir, { SECURE_SEARCH_API_KEY: "saved-search-key" });

  const result = await executeCapabilityProvider(rootDir, {
    capability: "web_search",
    input: {
      query: "CodexBridge",
      api_key: "sk-history-input-should-not-persist",
      Authorization: "Bearer sk-history-auth-should-not-persist",
      nested: {
        refresh_token: "sk-history-refresh-should-not-persist",
      },
    },
    sourceModel: "deepseek-v4-pro",
    requestId: "req_secret_history",
  }, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        text: "done with token sk-history-output-should-not-persist",
      }),
    }),
  });

  assert.equal(result.ok, true);
  const history = readCapabilityExecutionHistory(rootDir);
  assert.equal(history.length, 1);
  const serialized = JSON.stringify(history[0]);
  assert.doesNotMatch(serialized, /sk-history-input-should-not-persist/);
  assert.doesNotMatch(serialized, /sk-history-auth-should-not-persist/);
  assert.doesNotMatch(serialized, /sk-history-refresh-should-not-persist/);
  assert.doesNotMatch(serialized, /sk-history-output-should-not-persist/);
  assert.match(history[0].inputSummary, /CodexBridge/);
  assert.match(history[0].outputText, /done with token/);
  assert.match(history[0].outputText, /\[REDACTED\]/);
});

test("executeCapabilityProvider records failed generic capability runs", async () => {
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "bocha-search",
    name: "Bocha Search",
    capability: "web_search",
    adapter: "generic_http",
    baseUrl: "https://api.bochaai.com/v1",
    endpoint: "/web-search",
    apiKeyEnv: "BOCHA_API_KEY",
    makeDefault: true,
  });

  const result = await executeCapabilityProvider(rootDir, {
    capability: "web_search",
    input: { query: "CodexBridge" },
    sourceModel: "qwen-plus",
    requestId: "req_search_history_fail",
  }, {
    fetchImpl: async () => {
      throw new Error("fetch should not be called without a key");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.historyItem.providerId, "bocha-search");
  const history = readCapabilityExecutionHistory(rootDir);
  assert.equal(history.length, 1);
  assert.equal(history[0].ok, false);
  assert.equal(history[0].capability, "web_search");
  assert.equal(history[0].errorCode, "missing_api_key");
  assert.equal(history[0].errorPhase, "execute");
  assert.equal(history[0].sourceModel, "qwen-plus");
  assert.match(history[0].outputText, /API Key/);
  assert.match(history[0].inputSummary, /CodexBridge/);
});

test("executeCapabilityProvider can run an unsaved form provider with a typed key", async () => {
  const rootDir = makeTempProject();
  const requests = [];

  const result = await executeCapabilityProvider(rootDir, {
    provider: {
      id: "temp-search",
      name: "Temp Search",
      capability: "web_search",
      adapter: "generic_http",
      baseUrl: "https://search.example.com/v1",
      endpoint: "/search",
      apiKeyEnv: "TEMP_SEARCH_API_KEY",
      apiKey: "typed-search-key",
    },
    capability: "web_search",
    input: { query: "CodexBridge" },
  }, {
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ answer: "result summary" }),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.providerId, "temp-search");
  assert.equal(result.response.output_text, "result summary");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers.Authorization, "Bearer typed-search-key");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    capability: "web_search",
    input: { query: "CodexBridge" },
  });
});

test("executeCapabilityProvider can use an injected local browser executor", async () => {
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "local-browser",
    name: "Local Browser",
    capability: "browser",
    adapter: "local_browser",
    makeDefault: true,
  });
  let fetchCalled = false;
  const localExecutions = [];

  const result = await executeCapabilityProvider(rootDir, {
    capability: "browser",
    input: { action: "open_url", url: "https://example.com/docs" },
    sourceModel: "qwen-plus",
    requestId: "req_local_browser_open",
  }, {
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("local browser should not call fetch");
    },
    localCapabilityExecutor: async (payload) => {
      localExecutions.push(payload);
      return {
        text: `已打开浏览器：${payload.request.input.url}`,
        action: payload.request.input.action,
        url: payload.request.input.url,
        handledBy: "test-local-browser",
      };
    },
  });

  assert.equal(fetchCalled, false);
  assert.equal(localExecutions.length, 1);
  assert.equal(localExecutions[0].adapter, "local_browser");
  assert.equal(localExecutions[0].capability, "browser");
  assert.equal(localExecutions[0].provider.id, "local-browser");
  assert.equal(result.ok, true);
  assert.equal(result.providerId, "local-browser");
  assert.equal(result.response.output_text, "已打开浏览器：https://example.com/docs");
  assert.equal(result.output.text, "已打开浏览器：https://example.com/docs");
  assert.deepEqual(result.trace.map((item) => item.phase), [
    "selectProvider",
    "execute",
    "saveResult",
    "buildResponse",
    "recordHistory",
  ]);
  const history = readCapabilityExecutionHistory(rootDir);
  assert.equal(history.length, 1);
  assert.equal(history[0].ok, true);
  assert.equal(history[0].capability, "browser");
  assert.equal(history[0].providerId, "local-browser");
  assert.match(history[0].inputSummary, /example\.com\/docs/);
  assert.match(history[0].outputText, /已打开浏览器/);
});

test("executeCapabilityProvider reports all supported local browser actions when an action is unsupported", async () => {
  const { createDesktopLocalCapabilityExecutor } = require("../desktop/local-capabilities.cjs");
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "local-browser",
    name: "Local Browser",
    capability: "browser",
    adapter: "local_browser",
    makeDefault: true,
  });

  const result = await executeCapabilityProvider(rootDir, {
    capability: "browser",
    input: { action: "scroll_page", url: "https://example.com/docs" },
  }, {
    localCapabilityExecutor: createDesktopLocalCapabilityExecutor({
      openExternal: async () => {
        throw new Error("unsupported action should not open");
      },
      fetchImpl: async () => {
        throw new Error("unsupported action should not fetch");
      },
      capturePageScreenshot: async () => {
        throw new Error("unsupported action should not screenshot");
      },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.failed, true);
  assert.equal(result.error.code, "local_action_unsupported");
  assert.match(result.response.output_text, /open_url/);
  assert.match(result.response.output_text, /read_url/);
  assert.match(result.response.output_text, /screenshot_url/);
  assert.doesNotMatch(result.response.output_text, /only supports open_url|只支持 open_url/);
});

test("executeCapabilityProvider saves visual capability output locally", async () => {
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "screenshot-api",
    name: "Screenshot API",
    capability: "webpage_screenshot",
    adapter: "generic_http",
    baseUrl: "https://capture.example.com/v1",
    endpoint: "/screenshots",
    apiKeyEnv: "SCREENSHOT_API_KEY",
    makeDefault: true,
  });
  saveSecrets(rootDir, { SCREENSHOT_API_KEY: "screenshot-secret" });
  const imageBytes = Buffer.from("fake-png-bytes");
  const signedImageUrl =
    "https://cdn.example.com/capture.png?X-Amz-Credential=AKIAHISTORYSECRET&X-Amz-Signature=temporary-history-signature&token=temporary-history-token";
  const requests = [];

  const result = await executeCapabilityProvider(rootDir, {
    capability: "webpage_screenshot",
    input: { url: "https://example.com" },
    requestId: "req_screenshot_save",
    sourceModel: "deepseek-v4-pro",
  }, {
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (String(url) === "https://capture.example.com/v1/screenshots") {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ imageUrl: signedImageUrl }),
        };
      }
      if (String(url) === signedImageUrl) {
        return {
          ok: true,
          status: 200,
          headers: new Map([["content-type", "image/png"]]),
          arrayBuffer: async () => imageBytes,
        };
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.savedResult.mimeType, "image/png");
  assert.equal(fs.existsSync(result.savedResult.localPath), true);
  assert.deepEqual(fs.readFileSync(result.savedResult.localPath), imageBytes);
  assert.equal(result.savedResult.base64, imageBytes.toString("base64"));
  assert.match(result.response.output_text, /已保存|local/i);
  assert.equal(result.response.localPath, result.savedResult.localPath);
  assert.equal(result.response.base64, imageBytes.toString("base64"));
  assert.equal(result.output.localPath, result.savedResult.localPath);
  assert.equal(requests.length, 2);
  const history = readCapabilityExecutionHistory(rootDir);
  assert.equal(history.length, 1);
  assert.equal(history[0].sourceUrl, "https://cdn.example.com/capture.png");
  const serializedHistory = JSON.stringify(history[0]);
  assert.doesNotMatch(serializedHistory, /X-Amz-Credential/);
  assert.doesNotMatch(serializedHistory, /temporary-history-signature/);
  assert.doesNotMatch(serializedHistory, /temporary-history-token/);
});

test("executeCapabilityProvider rejects oversized visual asset downloads before reading the body", async () => {
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "large-screenshot-api",
    name: "Large Screenshot API",
    capability: "webpage_screenshot",
    adapter: "generic_http",
    baseUrl: "https://capture.example.com/v1",
    endpoint: "/screenshots",
    apiKeyEnv: "SCREENSHOT_API_KEY",
    makeDefault: true,
    maxAssetBytes: 1024,
  });
  saveSecrets(rootDir, { SCREENSHOT_API_KEY: "screenshot-secret" });
  const imageUrl = "https://cdn.example.com/large-capture.png";
  let arrayBufferCalled = false;

  const result = await executeCapabilityProvider(rootDir, {
    capability: "webpage_screenshot",
    input: { url: "https://example.com" },
    requestId: "req_large_asset",
  }, {
    fetchImpl: async (url) => {
      if (String(url) === "https://capture.example.com/v1/screenshots") {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ imageUrl }),
        };
      }
      if (String(url) === imageUrl) {
        return {
          ok: true,
          status: 200,
          headers: {
            get: (name) => String(name).toLowerCase() === "content-length" ? "2048" : "",
          },
          arrayBuffer: async () => {
            arrayBufferCalled = true;
            return Buffer.alloc(2048);
          },
        };
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });

  assert.equal(arrayBufferCalled, false);
  assert.equal(result.ok, false);
  assert.equal(result.failed, true);
  assert.equal(result.error.code, "asset_too_large");
  assert.equal(result.errorPhase, "saveResult");
  assert.equal(result.savedResult, null);
  assert.match(result.response.output_text, /过大|large|too large/i);

  const history = readCapabilityExecutionHistory(rootDir);
  assert.equal(history.length, 1);
  assert.equal(history[0].ok, false);
  assert.equal(history[0].errorCode, "asset_too_large");
  assert.equal(history[0].errorPhase, "saveResult");
});

test("executeCapabilityProvider saves local browser screenshots returned by the desktop executor", async () => {
  const { createDesktopLocalCapabilityExecutor } = require("../desktop/local-capabilities.cjs");
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "local-browser-screenshot",
    name: "Local Browser Screenshot",
    capability: "webpage_screenshot",
    adapter: "local_browser",
    makeDefault: true,
  });
  const screenshotBytes = Buffer.from("local-screenshot-png");
  const captures = [];

  const result = await executeCapabilityProvider(rootDir, {
    capability: "webpage_screenshot",
    input: {
      action: "screenshot_url",
      url: "https://example.com/dashboard",
      viewport: "desktop",
      fullPage: true,
    },
    requestId: "req_local_screenshot",
    sourceModel: "qwen-plus",
  }, {
    localCapabilityExecutor: createDesktopLocalCapabilityExecutor({
      capturePageScreenshot: async (payload) => {
        captures.push(payload);
        return screenshotBytes;
      },
      openExternal: async () => {
        throw new Error("screenshot should not open a visible browser");
      },
      fetchImpl: async () => {
        throw new Error("screenshot should not fetch text");
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].url, "https://example.com/dashboard");
  assert.equal(captures[0].viewport, "desktop");
  assert.equal(captures[0].fullPage, true);
  assert.equal(result.savedResult.mimeType, "image/png");
  assert.equal(fs.existsSync(result.savedResult.localPath), true);
  assert.deepEqual(fs.readFileSync(result.savedResult.localPath), screenshotBytes);
  assert.equal(result.response.localPath, result.savedResult.localPath);
  assert.equal(result.output.localPath, result.savedResult.localPath);
  assert.equal(result.output.mimeType, "image/png");

  const history = readCapabilityExecutionHistory(rootDir);
  assert.equal(history.length, 1);
  assert.equal(history[0].ok, true);
  assert.equal(history[0].capability, "webpage_screenshot");
  assert.equal(history[0].providerId, "local-browser-screenshot");
  assert.equal(history[0].localPath, result.savedResult.localPath);
  assert.equal(history[0].mimeType, "image/png");
});

test("executeCapabilityProvider keeps oversized visual capability output local only", async () => {
  const { createDesktopLocalCapabilityExecutor } = require("../desktop/local-capabilities.cjs");
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "local-large-screenshot",
    name: "Local Large Screenshot",
    capability: "webpage_screenshot",
    adapter: "local_browser",
    makeDefault: true,
  });
  const screenshotBytes = Buffer.alloc(768 * 1024, 9);

  const result = await executeCapabilityProvider(rootDir, {
    capability: "webpage_screenshot",
    input: {
      action: "screenshot_url",
      url: "https://example.com/large",
      viewport: "desktop",
      fullPage: true,
    },
    requestId: "req_large_screenshot",
    sourceModel: "kimi-k2-7-code",
  }, {
    localCapabilityExecutor: createDesktopLocalCapabilityExecutor({
      capturePageScreenshot: async () => screenshotBytes,
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.savedResult.bytes, screenshotBytes.length);
  assert.equal(result.savedResult.base64, undefined);
  assert.equal(result.response.base64, undefined);
  assert.equal(result.output.localPath, result.savedResult.localPath);

  const history = readCapabilityExecutionHistory(rootDir, { includeThumbnails: true });
  assert.equal(history.length, 1);
  assert.equal(history[0].thumbnailDataUrl, undefined);
  assert.equal(history[0].thumbnailStatus, "too_large");
});

test("executeCapabilityProvider fails before network when provider key is missing", async () => {
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "bocha-search",
    name: "Bocha Search",
    capability: "web_search",
    adapter: "generic_http",
    baseUrl: "https://api.bochaai.com/v1",
    endpoint: "/web-search",
    apiKeyEnv: "BOCHA_API_KEY",
    makeDefault: true,
  });
  let fetchCalled = false;

  const result = await executeCapabilityProvider(rootDir, {
    capability: "web_search",
    input: { query: "CodexBridge" },
  }, {
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called without a key");
    },
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.ok, false);
  assert.equal(result.handled, true);
  assert.equal(result.failed, true);
  assert.equal(result.providerId, "bocha-search");
  assert.equal(result.error.code, "missing_api_key");
  assert.match(result.response.output_text, /API Key/);
});

test("executeCapabilityProvider explains provider auth failures without raw upstream text", async () => {
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "paddle-ocr",
    name: "Paddle OCR",
    capability: "ocr",
    adapter: "generic_http",
    baseUrl: "https://ocr.example.com/v1",
    endpoint: "/ocr",
    apiKeyEnv: "OCR_API_KEY",
    makeDefault: true,
  });
  saveSecrets(rootDir, { OCR_API_KEY: "bad-key" });

  const result = await executeCapabilityProvider(rootDir, {
    capability: "ocr",
    input: { imageUrl: "https://example.com/receipt.png" },
  }, {
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      text: async () => '{"error":{"message":"Incorrect API key provided.","type":"invalid_api_key"}}',
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "provider_http_error");
  assert.equal(result.error.statusCode, 401);
  assert.match(result.response.output_text, /Paddle OCR.*API Key.*不正确|API Key.*Paddle OCR.*不正确/);
  assert.doesNotMatch(result.response.output_text, /Incorrect API key provided/);
  assert.doesNotMatch(result.response.output_text, /invalid_api_key/);
});

test("executeCapabilityProvider explains HTML gateway failures as endpoint or proxy issues", async () => {
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "screenshot-api",
    name: "Screenshot API",
    capability: "webpage_screenshot",
    adapter: "generic_http",
    baseUrl: "https://ciyuan.fast/v1",
    endpoint: "/screenshots",
    apiKeyEnv: "SCREENSHOT_API_KEY",
    makeDefault: true,
  });
  saveSecrets(rootDir, { SCREENSHOT_API_KEY: "screenshot-key" });

  const result = await executeCapabilityProvider(rootDir, {
    capability: "webpage_screenshot",
    input: { url: "https://example.com" },
  }, {
    fetchImpl: async () => ({
      ok: false,
      status: 502,
      text: async () => "<!DOCTYPE html><html><head><title>ciyuan.fast | 502: Bad gateway</title></head><body>Bad gateway</body></html>",
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "provider_http_error");
  assert.equal(result.error.statusCode, 502);
  assert.match(result.response.output_text, /Screenshot API/);
  assert.match(result.response.output_text, /Base URL|Endpoint/);
  assert.match(result.response.output_text, /HTML|gateway|网关|代理/i);
  assert.doesNotMatch(result.response.output_text, /<!DOCTYPE|<html|<title>/i);
});

test("executeCapabilityProvider keeps provider retry hints for rate limits", async () => {
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "bocha-search",
    name: "Bocha Search",
    capability: "web_search",
    adapter: "generic_http",
    baseUrl: "https://api.bochaai.com/v1",
    endpoint: "/web-search",
    apiKeyEnv: "BOCHA_API_KEY",
    makeDefault: true,
  });
  saveSecrets(rootDir, { BOCHA_API_KEY: "search-key" });

  const result = await executeCapabilityProvider(rootDir, {
    capability: "web_search",
    input: { query: "CodexBridge" },
  }, {
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      text: async () => '{"error":{"message":"Too Many Requests; retry after 45s"}}',
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "provider_http_error");
  assert.equal(result.error.statusCode, 429);
  assert.match(result.response.output_text, /Bocha Search/);
  assert.match(result.response.output_text, /限流|请求过快/);
  assert.match(result.response.output_text, /45s/);
});

test("executeCapabilityProvider reads Retry-After headers for rate limits", async () => {
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "bocha-search",
    name: "Bocha Search",
    capability: "web_search",
    adapter: "generic_http",
    baseUrl: "https://api.bochaai.com/v1",
    endpoint: "/web-search",
    apiKeyEnv: "BOCHA_API_KEY",
    makeDefault: true,
  });
  saveSecrets(rootDir, { BOCHA_API_KEY: "search-key" });

  const result = await executeCapabilityProvider(rootDir, {
    capability: "web_search",
    input: { query: "CodexBridge" },
  }, {
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: {
        get: (name) => (String(name).toLowerCase() === "retry-after" ? "30" : null),
      },
      text: async () => '{"error":{"message":"Too Many Requests"}}',
    }),
  });

  assert.equal(result.ok, false);
  assert.match(result.response.output_text, /限流|请求过快/);
  assert.match(result.response.output_text, /30s/);
});

test("executeCapabilityProvider explains visual asset download failures without raw upstream text", async () => {
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "screenshot-api",
    name: "Screenshot API",
    capability: "webpage_screenshot",
    adapter: "generic_http",
    baseUrl: "https://capture.example.com/v1",
    endpoint: "/screenshots",
    apiKeyEnv: "SCREENSHOT_API_KEY",
    makeDefault: true,
  });
  saveSecrets(rootDir, { SCREENSHOT_API_KEY: "screenshot-secret" });

  const result = await executeCapabilityProvider(rootDir, {
    capability: "webpage_screenshot",
    input: { url: "https://example.com" },
  }, {
    fetchImpl: async (url) => {
      if (String(url) === "https://capture.example.com/v1/screenshots") {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ imageUrl: "https://cdn.example.com/expired.png" }),
        };
      }
      return {
        ok: false,
        status: 403,
        text: async () => '{"error":{"message":"temporary url expired"}}',
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "asset_download_failed");
  assert.equal(result.errorPhase, "saveResult");
  assert.match(result.response.output_text, /Screenshot API.*下载.*失败|下载.*Screenshot API.*失败/);
  assert.doesNotMatch(result.response.output_text, /Capability result download failed/);
  assert.doesNotMatch(result.response.output_text, /temporary url expired/);
});

test("executeCapabilityProvider reports local adapters as explicit manual-executor gaps", async () => {
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "local-file",
    name: "Local File",
    capability: "file_processing",
    adapter: "local_file",
    makeDefault: true,
  });
  let fetchCalled = false;

  const result = await executeCapabilityProvider(rootDir, {
    capability: "file_processing",
    input: { path: "C:/tmp/report.pdf" },
  }, {
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("local adapters should not use fetch");
    },
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.ok, false);
  assert.equal(result.failed, true);
  assert.equal(result.providerId, "local-file");
  assert.equal(result.error.code, "local_executor_not_configured");
  assert.match(result.error.message, /本地执行器还未接入/);
  assert.doesNotMatch(result.error.message, /not connected/i);
  assert.match(result.response.output_text, /本地执行器还未接入/);
  assert.doesNotMatch(result.response.output_text, /not connected/i);
});

test("executeCapabilityProvider explains missing fetch runtime in Chinese", async () => {
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "ocr-provider",
    name: "OCR Provider",
    capability: "ocr",
    adapter: "generic_http",
    baseUrl: "https://ocr.example.com/v1",
    endpoint: "/ocr",
    makeDefault: true,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = undefined;

  try {
    const result = await executeCapabilityProvider(rootDir, {
      capability: "ocr",
      input: { imageUrl: "https://example.com/invoice.png" },
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "fetch_unavailable");
    assert.match(result.error.message, /运行环境.*能力供应商.*请求/);
    assert.match(result.response.output_text, /运行环境.*能力供应商.*请求/);
    assert.doesNotMatch(result.error.message, /This runtime cannot send capability provider requests/i);
    assert.doesNotMatch(result.response.output_text, /This runtime cannot send capability provider requests/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("executeCapabilityProvider keeps setup errors readable in Chinese", async () => {
  const rootDir = makeTempProject();

  const missingProvider = await executeCapabilityProvider(rootDir, {
    capability: "ocr",
    input: { imageUrl: "https://example.com/invoice.png" },
  });
  assert.equal(missingProvider.ok, false);
  assert.equal(missingProvider.error.code, "provider_not_configured");
  assert.match(missingProvider.error.message, /没有.*能力供应商/);
  assert.doesNotMatch(missingProvider.error.message, /No enabled provider/i);

  saveCapabilityProvider(rootDir, {
    id: "ocr-provider",
    name: "OCR Provider",
    capability: "ocr",
    adapter: "generic_http",
    baseUrl: "",
    endpoint: "",
    makeDefault: true,
  });
  const invalidEndpoint = await executeCapabilityProvider(rootDir, {
    capability: "ocr",
    input: { imageUrl: "https://example.com/invoice.png" },
  });

  assert.equal(invalidEndpoint.ok, false);
  assert.equal(invalidEndpoint.error.code, "invalid_endpoint");
  assert.match(invalidEndpoint.error.message, /Base URL.*Endpoint.*无效/);
  assert.doesNotMatch(invalidEndpoint.error.message, /Capability provider Base URL or Endpoint is invalid/i);
});

test("executeCapabilityProvider can read an explicit local text file through the desktop executor", async () => {
  const rootDir = makeTempProject();
  const { createDesktopLocalCapabilityExecutor } = require("../desktop/local-capabilities.cjs");
  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-local-file-provider-"));
  const filePath = path.join(fileDir, "handoff.md");
  fs.writeFileSync(filePath, "# CodexBridge\nLocal file provider text.", "utf8");
  saveCapabilityProvider(rootDir, {
    id: "local-file",
    name: "Local File",
    capability: "file_processing",
    adapter: "local_file",
    makeDefault: true,
  });
  let fetchCalled = false;

  const result = await executeCapabilityProvider(rootDir, {
    capability: "file_processing",
    input: {
      action: "extract_text",
      path: filePath,
    },
  }, {
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("local file should not use fetch");
    },
    localCapabilityExecutor: createDesktopLocalCapabilityExecutor({}),
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.ok, true);
  assert.equal(result.failed, false);
  assert.equal(result.providerId, "local-file");
  assert.equal(result.response.data.handledBy, "desktop_local_file");
  assert.equal(result.response.data.filePath, filePath);
  assert.equal(result.response.data.mimeType, "text/markdown");
  assert.match(result.response.output_text, /CodexBridge/);
  assert.match(result.response.output_text, /Local file provider text/);
});

test("executeCapabilityProvider records local file inspection metadata in history", async () => {
  const rootDir = makeTempProject();
  const { createDesktopLocalCapabilityExecutor } = require("../desktop/local-capabilities.cjs");
  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-local-file-inspect-history-"));
  const filePath = path.join(fileDir, "models.json");
  fs.writeFileSync(filePath, JSON.stringify({ models: ["alpha", "beta"] }, null, 2), "utf8");
  saveCapabilityProvider(rootDir, {
    id: "local-file",
    name: "Local File",
    capability: "file_processing",
    adapter: "local_file",
    makeDefault: true,
  });

  const result = await executeCapabilityProvider(rootDir, {
    capability: "file_processing",
    input: {
      action: "inspect_file",
      path: filePath,
      maxCharacters: 80,
    },
    sourceModel: "qwen-plus",
    requestId: "req_local_file_inspect_history",
  }, {
    localCapabilityExecutor: createDesktopLocalCapabilityExecutor({}),
  });

  assert.equal(result.ok, true);
  assert.equal(result.response.data.action, "inspect_file");
  assert.equal(result.response.data.filePath, filePath);
  assert.equal(result.response.data.mimeType, "application/json");
  const history = readCapabilityExecutionHistory(rootDir);
  assert.equal(history.length, 1);
  assert.equal(history[0].capability, "file_processing");
  assert.equal(history[0].providerId, "local-file");
  assert.equal(history[0].sourceModel, "qwen-plus");
  assert.equal(history[0].requestId, "req_local_file_inspect_history");
  assert.equal(history[0].localPath, filePath);
  assert.equal(history[0].mimeType, "application/json");
  assert.equal(history[0].fileName, "models.json");
  assert.equal(history[0].lineCount, 6);
  assert.match(history[0].outputText, /文件检查/);
  assert.match(history[0].preview, /alpha/);
});

test("executeCapabilityProvider explains unsupported local file actions", async () => {
  const rootDir = makeTempProject();
  const { createDesktopLocalCapabilityExecutor } = require("../desktop/local-capabilities.cjs");
  saveCapabilityProvider(rootDir, {
    id: "local-file",
    name: "Local File",
    capability: "file_processing",
    adapter: "local_file",
    makeDefault: true,
  });

  const result = await executeCapabilityProvider(rootDir, {
    capability: "file_processing",
    input: {
      action: "summarize_folder",
      path: rootDir,
    },
  }, {
    localCapabilityExecutor: createDesktopLocalCapabilityExecutor({}),
  });

  assert.equal(result.ok, false);
  assert.equal(result.failed, true);
  assert.equal(result.providerId, "local-file");
  assert.equal(result.error.code, "local_action_unsupported");
  assert.match(result.response.output_text, /inspect_file/);
  assert.match(result.response.output_text, /extract_text/);
  assert.match(result.response.output_text, /本地文本文件路径/);
});

test("capability provider groups expose future ability slots for the desktop market", () => {
  const rootDir = makeTempProject();

  saveImageProvider(rootDir, {
    id: "siliconflow-kolors",
    name: "硅基流动 Kolors",
    adapter: "siliconflow_images",
    baseUrl: "https://api.siliconflow.cn/v1",
    endpoint: "/images/generations",
    model: "Kwai-Kolors/Kolors",
    size: "1024x1024",
    apiKeyEnv: "SILICONFLOW_API_KEY",
    makeDefault: true,
  });

  const groups = readCapabilityProviderGroups(rootDir);
  const byCapability = new Map(groups.map((group) => [group.capability, group]));

  assert.deepEqual(groups.map((group) => group.capability), [
    "image_generation",
    "ocr",
    "web_search",
    "browser",
    "computer_use",
    "file_processing",
    "webpage_screenshot",
    "speech",
    "video",
  ]);
  assert.equal(byCapability.get("image_generation").enabledCount, 1);
  assert.equal(byCapability.get("image_generation").defaultProviderId, "siliconflow-kolors");
  assert.equal(byCapability.get("ocr").enabledCount, 0);
  assert.equal(byCapability.get("web_search").providers.length, 0);
  assert.equal(byCapability.get("browser").providers.length, 0);
  assert.equal(byCapability.get("computer_use").providers.length, 0);
  assert.equal(byCapability.get("webpage_screenshot").providers.length, 0);
  assert.equal(byCapability.get("speech").providers.length, 0);
  assert.equal(byCapability.get("video").providers.length, 0);
});

test("capability provider groups describe local browser and computer use bridge limits", () => {
  const rootDir = makeTempProject();

  saveCapabilityProvider(rootDir, {
    id: "local-browser",
    name: "Local Browser",
    capability: "browser",
    capabilities: ["browser", "webpage_screenshot"],
    adapter: "local_browser",
    makeDefault: true,
  });
  saveCapabilityProvider(rootDir, {
    id: "local-computer-use",
    name: "Local Computer Use",
    capability: "computer_use",
    adapter: "local_computer_use",
    makeDefault: true,
  });
  saveCapabilityProvider(rootDir, {
    id: "local-file",
    name: "Local File",
    capability: "file_processing",
    adapter: "local_file",
    makeDefault: true,
  });

  const groups = readCapabilityProviderGroups(rootDir);
  const byCapability = new Map(groups.map((group) => [group.capability, group]));
  const browserProvider = byCapability.get("browser").providers.find((item) => item.id === "local-browser");
  const screenshotProvider = byCapability.get("webpage_screenshot").providers.find((item) => item.id === "local-browser");
  const computerUseProvider = byCapability.get("computer_use").providers.find((item) => item.id === "local-computer-use");
  const localFileProvider = byCapability.get("file_processing").providers.find((item) => item.id === "local-file");

  assert.equal(browserProvider.bridge.mode, "local_bridge");
  assert.equal(browserProvider.bridge.nativeTool, false);
  assert.deepEqual(browserProvider.bridge.supportedActions, ["open_url", "read_url", "screenshot_url"]);
  assert.match(browserProvider.bridge.limitation, /不是 GPT 原生 Chrome 工具/);
  assert.equal(screenshotProvider.bridge.requiresDesktopExecutor, true);
  assert.equal(computerUseProvider.bridge.mode, "local_bridge");
  assert.equal(computerUseProvider.bridge.canControlDesktop, false);
  assert.equal(computerUseProvider.bridge.requiresGptResponses, true);
  assert.deepEqual(computerUseProvider.bridge.supportedActions, ["diagnose", "list_apps", "open_app", "screenshot_desktop"]);
  assert.match(computerUseProvider.bridge.limitation, /不会自动点击|完整 Computer Use/);
  assert.equal(localFileProvider.bridge.mode, "local_bridge");
  assert.deepEqual(localFileProvider.bridge.supportedActions, ["diagnose", "inspect_file", "extract_text"]);
  assert.match(localFileProvider.bridge.limitation, /明确给出的本地文本文件/);
});

test("executeCapabilityProvider treats local computer use as a local executor gap", async () => {
  const rootDir = makeTempProject();
  saveCapabilityProvider(rootDir, {
    id: "local-computer-use",
    name: "Local Computer Use",
    capability: "computer_use",
    adapter: "local_computer_use",
    makeDefault: true,
  });
  let fetchCalled = false;

  const result = await executeCapabilityProvider(rootDir, {
    capability: "computer_use",
    input: { action: "diagnose" },
  }, {
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("local computer use should not use fetch");
    },
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.ok, false);
  assert.equal(result.failed, true);
  assert.equal(result.providerId, "local-computer-use");
  assert.equal(result.error.code, "local_executor_not_configured");
});

test("executeCapabilityProvider can run local computer use safe diagnostics", async () => {
  const rootDir = makeTempProject();
  const { createDesktopLocalCapabilityExecutor } = require("../desktop/local-capabilities.cjs");
  saveCapabilityProvider(rootDir, {
    id: "local-computer-use",
    name: "Local Computer Use",
    capability: "computer_use",
    adapter: "local_computer_use",
    makeDefault: true,
  });
  let fetchCalled = false;

  const result = await executeCapabilityProvider(rootDir, {
    capability: "computer_use",
    input: { action: "diagnose" },
  }, {
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("local computer use should not use fetch");
    },
    localCapabilityExecutor: createDesktopLocalCapabilityExecutor({}),
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.ok, true);
  assert.equal(result.failed, false);
  assert.equal(result.providerId, "local-computer-use");
  assert.equal(result.response.data.handledBy, "desktop_local_computer_use");
  assert.deepEqual(result.response.data.supportedActions, ["diagnose", "list_apps", "open_app"]);
  assert.equal(result.response.data.canControlDesktop, false);
  assert.match(result.response.output_text, /Computer Use/);
});

test("executeCapabilityProvider saves local computer use desktop screenshots", async () => {
  const rootDir = makeTempProject();
  const { createDesktopLocalCapabilityExecutor } = require("../desktop/local-capabilities.cjs");
  const screenshotBytes = Buffer.from("desktop-screenshot-png");
  saveCapabilityProvider(rootDir, {
    id: "local-computer-use",
    name: "Local Computer Use",
    capability: "computer_use",
    adapter: "local_computer_use",
    makeDefault: true,
  });

  const result = await executeCapabilityProvider(rootDir, {
    capability: "computer_use",
    input: { action: "screenshot_desktop" },
    requestId: "req_desktop_screenshot",
  }, {
    localCapabilityExecutor: createDesktopLocalCapabilityExecutor({
      captureDesktopScreenshot: async () => screenshotBytes,
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.savedResult.mimeType, "image/png");
  assert.match(result.savedResult.localPath, /codexbridge-computer_use-.*\.png$/);
  assert.deepEqual(fs.readFileSync(result.savedResult.localPath), screenshotBytes);
  assert.match(result.response.output_text, /桌面截图已生成/);
  const history = readCapabilityExecutionHistory(rootDir, { limit: 5 });
  assert.equal(history[0].capability, "computer_use");
  assert.equal(history[0].providerId, "local-computer-use");
  assert.equal(history[0].localPath, result.savedResult.localPath);
});

test("image capability providers preserve enabled state and priority for market ordering", () => {
  const rootDir = makeTempProject();

  saveImageProvider(rootDir, {
    id: "siliconflow-kolors",
    name: "硅基流动 Kolors",
    adapter: "siliconflow_images",
    baseUrl: "https://api.siliconflow.cn/v1",
    endpoint: "/images/generations",
    model: "Kwai-Kolors/Kolors",
    size: "1024x1024",
    apiKeyEnv: "SILICONFLOW_API_KEY",
    makeDefault: true,
    priority: 10,
  });
  saveImageProvider(rootDir, {
    id: "zai-glm-image",
    name: "智谱 GLM Image",
    adapter: "zai_images",
    baseUrl: "https://api.z.ai/api/paas/v4",
    endpoint: "/images/generations",
    model: "glm-image",
    size: "1280x1280",
    apiKeyEnv: "ZAI_API_KEY",
    priority: 50,
  });
  saveImageProvider(rootDir, {
    id: "disabled-openai-image",
    name: "停用 OpenAI Image",
    adapter: "openai_images",
    baseUrl: "https://api.openai.com/v1",
    endpoint: "/images/generations",
    model: "gpt-image-1",
    size: "1024x1024",
    apiKeyEnv: "OPENAI_API_KEY",
    enabled: false,
    priority: 99,
  });

  const providers = readCapabilityProviders(rootDir);
  const registry = capabilityProviderRegistry(rootDir);

  assert.equal(providers.find((provider) => provider.id === "disabled-openai-image").enabled, false);
  assert.equal(providers.find((provider) => provider.id === "disabled-openai-image").priority, 99);
  assert.deepEqual(registry.list("image_generation").map((provider) => provider.id), [
    "siliconflow-kolors",
    "zai-glm-image",
  ]);
  assert.deepEqual(registry.list("image_generation", { includeDisabled: true }).map((provider) => provider.id), [
    "siliconflow-kolors",
    "disabled-openai-image",
    "zai-glm-image",
  ]);
  assert.equal(registry.select("image_generation").id, "siliconflow-kolors");
  assert.deepEqual(registry.summary().capabilities, { image_generation: 2 });
});

test("disabled default image provider falls back to enabled backup for generated routes", () => {
  const rootDir = makeTempProject();
  saveSelection(rootDir, ["deepseek-v4-pro"], MODE_HYBRID);

  saveImageProvider(rootDir, {
    id: "disabled-default-image",
    name: "停用默认生图",
    adapter: "siliconflow_images",
    baseUrl: "https://api.siliconflow.cn/v1",
    endpoint: "/images/generations",
    model: "Kwai-Kolors/Kolors",
    size: "1024x1024",
    apiKeyEnv: "SILICONFLOW_API_KEY",
    makeDefault: true,
    enabled: false,
    priority: 100,
  });
  saveImageProvider(rootDir, {
    id: "zai-backup-image",
    name: "智谱备用生图",
    adapter: "zai_images",
    baseUrl: "https://api.z.ai/api/paas/v4",
    endpoint: "/images/generations",
    model: "glm-image",
    size: "1280x1280",
    apiKeyEnv: "ZAI_API_KEY",
    priority: 50,
  });

  const config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.equal(readImageProviderConfig(rootDir).defaultProviderId, "disabled-default-image");
  assert.equal(config.models[0].imageGeneration.providerId, "zai-backup-image");
  assert.equal(config.models[0].imageGeneration.adapter, "zai_images");
});

test("image provider test settings include local output and history paths", () => {
  const rootDir = makeTempProject();
  const settings = imageGenerationSettingsForProvider(rootDir, {
    id: "siliconflow-kolors",
    name: "硅基流动 Kolors",
    adapter: "siliconflow_images",
    baseUrl: "https://api.siliconflow.cn/v1",
    endpoint: "/images/generations",
    model: "Kwai-Kolors/Kolors",
    size: "1024x1024",
    apiKeyEnv: "SILICONFLOW_API_KEY",
    apiKey: "typed-key",
    defaults: {
      batch_size: 1,
    },
  });

  assert.equal(settings.mode, "custom");
  assert.equal(settings.providerId, "siliconflow-kolors");
  assert.equal(settings.displayName, "硅基流动 Kolors");
  assert.equal(settings.apiKey, "typed-key");
  assert.equal(settings.outputDir, imageOutputDirPath(rootDir));
  assert.equal(settings.historyPath, imageGenerationHistoryPath(rootDir));
  assert.equal(settings.response.imageUrlPath, "images[0].url");
});

test("generic image provider settings preserve templates and blank size", () => {
  const rootDir = makeTempProject();
  saveSelection(rootDir, ["deepseek-v4-pro"], MODE_HYBRID);

  saveImageProvider(rootDir, {
    id: "generic-render",
    name: "Generic Render",
    adapter: "generic_template",
    baseUrl: "https://images.example/v2",
    endpoint: "/render",
    model: "render-v1",
    size: "",
    apiKeyEnv: "GENERIC_IMAGE_API_KEY",
    makeDefault: true,
    headers: {
      "x-api-key": "{{apiKey}}",
      "x-size": "{{size}}",
    },
    request: {
      template: {
        engine: "{{model}}",
        text: "{{prompt}}",
        resolution: "{{size}}",
      },
    },
    response: {
      imageUrlPath: "result.assets[0].src",
    },
  });

  const savedProvider = readImageProviderConfig(rootDir).providers[0];
  assert.equal(savedProvider.size, "");
  assert.equal(savedProvider.headers["x-api-key"], "{{apiKey}}");
  assert.equal(savedProvider.request.template.resolution, "{{size}}");

  const config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);
  const imageGeneration = config.models[0].imageGeneration;
  assert.equal(imageGeneration.size, "");
  assert.equal(imageGeneration.adapter, "generic_template");
  assert.equal(imageGeneration.headers["x-api-key"], "{{apiKey}}");
  assert.equal(imageGeneration.request.template.engine, "{{model}}");
  assert.equal(imageGeneration.response.imageUrlPath, "result.assets[0].src");

  const exported = exportConfigPackage(rootDir, { includeCodexResources: false });
  assert.equal(exported.imageProviders.providers[0].headers["x-api-key"], "{{apiKey}}");
  assert.equal(exported.imageProviders.providers[0].headers["x-size"], "{{size}}");
});

test("image generation history records thumbnails and can clear generated files", () => {
  const rootDir = makeTempProject();
  const outputDir = imageOutputDirPath(rootDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const imagePath = path.join(outputDir, "sample.png");
  fs.writeFileSync(imagePath, Buffer.from("image"));

  recordImageGenerationHistory(rootDir, {
    providerId: "siliconflow-kolors",
    providerName: "硅基流动 Kolors",
    sourceModel: "deepseek-v4-pro",
    prompt: "画一只小猫",
    localPath: imagePath,
    mimeType: "image/png",
    durationMs: 1234,
  });

  const history = readImageGenerationHistory(rootDir, { includeThumbnails: true });
  assert.equal(history.length, 1);
  assert.equal(history[0].providerName, "硅基流动 Kolors");
  assert.equal(history[0].sourceModel, "deepseek-v4-pro");
  assert.equal(history[0].durationMs, 1234);
  assert.match(history[0].thumbnailDataUrl, /^data:image\/png;base64,/);

  const cleared = clearImageGenerationHistory(rootDir, { deleteFiles: true });
  assert.equal(cleared.removedRecords, 1);
  assert.equal(cleared.removedFiles, 1);
  assert.equal(fs.existsSync(imagePath), false);
  assert.deepEqual(readImageGenerationHistory(rootDir), []);
});

test("image generation history does not inline oversized preview images", () => {
  const rootDir = makeTempProject();
  const outputDir = imageOutputDirPath(rootDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const imagePath = path.join(outputDir, "large.png");
  fs.writeFileSync(imagePath, Buffer.alloc(768 * 1024, 1));

  recordImageGenerationHistory(rootDir, {
    providerId: "siliconflow-kolors",
    providerName: "SiliconFlow Kolors",
    sourceModel: "deepseek-v4-pro",
    prompt: "draw a large dashboard",
    localPath: imagePath,
    mimeType: "image/png",
  });

  const history = readImageGenerationHistory(rootDir, { includeThumbnails: true });
  assert.equal(history.length, 1);
  assert.equal(history[0].localPath, imagePath);
  assert.equal(history[0].thumbnailDataUrl, undefined);
  assert.equal(history[0].thumbnailStatus, "too_large");
});

test("image generation history does not inline thumbnails outside generated images", () => {
  const rootDir = makeTempProject();
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-external-image-"));
  const externalImagePath = path.join(externalDir, "outside.png");
  fs.writeFileSync(externalImagePath, Buffer.from("external-image"));

  recordImageGenerationHistory(rootDir, {
    providerId: "siliconflow-kolors",
    providerName: "SiliconFlow Kolors",
    sourceModel: "deepseek-v4-pro",
    prompt: "external image should not be inlined",
    localPath: externalImagePath,
    mimeType: "image/png",
  });

  const history = readImageGenerationHistory(rootDir, { includeThumbnails: true });
  assert.equal(history.length, 1);
  assert.equal(history[0].localPath, externalImagePath);
  assert.equal(history[0].thumbnailDataUrl, undefined);
  assert.equal(history[0].thumbnailStatus, "outside_output_dir");
});

test("image provider test keeps oversized generated images local only", async () => {
  const { generateImageWithSettings } = await import("../src/image-generation.js");
  const rootDir = makeTempProject();
  const outputDir = imageOutputDirPath(rootDir);
  const largeImage = Buffer.alloc(768 * 1024, 2);

  const result = await generateImageWithSettings({
    id: "large-image-test",
    providerId: "large-image-test",
    displayName: "Large Image Test",
    enabled: true,
    mode: "custom",
    baseUrl: "https://images.example.com/v1",
    endpoint: "/images/generations",
    model: "image-large",
    size: "1024x1024",
    apiKeyEnv: "IMAGE_API_KEY",
    apiKey: "typed-secret",
    outputDir,
  }, "画一张大图", {
    route: {
      id: "desktop-image-provider-test",
      displayName: "图片供应商测试",
    },
    requestedModel: "image-provider-test",
    sourceModel: "设置页测试",
    callJsonUpstream: async () => ({
      data: [
        {
          b64_json: largeImage.toString("base64"),
        },
      ],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.localImage.bytes, largeImage.length);
  assert.equal(result.localImage.base64, undefined);
  assert.equal(fs.existsSync(result.localImage.localPath), true);
  assert.deepEqual(fs.readFileSync(result.localImage.localPath), largeImage);
  assert.equal(
    result.response.output.some((item) => item.type === "image_generation_call"),
    false,
  );
  assert.match(result.response.output_text, /已保存到本地/);
});

test("image provider test reports local image download failures in Chinese", async () => {
  const { generateImageWithSettings } = await import("../src/image-generation.js");
  const rootDir = makeTempProject();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    headers: new Map(),
    arrayBuffer: async () => Buffer.alloc(0),
  });

  try {
    const result = await generateImageWithSettings({
      id: "download-failure-test",
      providerId: "download-failure-test",
      displayName: "Download Failure Test",
      enabled: true,
      mode: "custom",
      baseUrl: "https://images.example.com/v1",
      endpoint: "/images/generations",
      model: "image-url",
      size: "1024x1024",
      apiKeyEnv: "IMAGE_API_KEY",
      apiKey: "typed-secret",
      outputDir: imageOutputDirPath(rootDir),
      historyPath: imageGenerationHistoryPath(rootDir),
    }, "画一张需要下载的图", {
      route: {
        id: "desktop-image-provider-test",
        displayName: "图片供应商测试",
      },
      requestedModel: "image-provider-test",
      sourceModel: "设置页测试",
      captureErrors: true,
      callJsonUpstream: async () => ({
        data: [
          {
            url: "https://cdn.example.com/generated.png",
          },
        ],
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.localImage, null);
    assert.match(result.error.message, /下载|保存/);
    assert.match(result.response.output_text, /下载|保存/);
    assert.equal(result.errorPhase, "saveResult");

    const history = readImageGenerationHistory(rootDir);
    assert.equal(history.length, 1);
    assert.equal(history[0].ok, false);
    assert.match(history[0].errorMessage, /下载|保存/);
    assert.equal(history[0].errorPhase, "saveResult");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("image generation history keeps failed attempts for troubleshooting", () => {
  const rootDir = makeTempProject();

  recordImageGenerationHistory(rootDir, {
    ok: false,
    providerId: "siliconflow-kolors",
    providerName: "硅基流动 Kolors",
    sourceModel: "kimi-k2-7-code",
    prompt: "画一只小猫",
    durationMs: 4321,
    errorCode: "insufficient_quota",
    errorMessage: "余额不足，请检查套餐或充值。",
    errorPhase: "execute",
  });

  const history = readImageGenerationHistory(rootDir, { includeThumbnails: true });
  assert.equal(history.length, 1);
  assert.equal(history[0].ok, false);
  assert.equal(history[0].providerName, "硅基流动 Kolors");
  assert.equal(history[0].sourceModel, "kimi-k2-7-code");
  assert.equal(history[0].localPath, "");
  assert.equal(history[0].errorCode, "insufficient_quota");
  assert.equal(history[0].errorMessage, "余额不足，请检查套餐或充值。");
  assert.equal(history[0].errorPhase, "execute");
  assert.equal(history[0].thumbnailDataUrl, undefined);
});

test("image generation history keeps multiple failed attempts without local files", () => {
  const rootDir = makeTempProject();

  recordImageGenerationHistory(rootDir, {
    id: "failed-auth",
    ok: false,
    providerId: "siliconflow-kolors",
    providerName: "SiliconFlow Kolors",
    sourceModel: "kimi-k2-7-code",
    prompt: "draw a cat",
    errorCode: "invalid_api_key",
    errorMessage: "API Key 无效",
    createdAt: "2026-02-01T00:00:00.000Z",
  });
  recordImageGenerationHistory(rootDir, {
    id: "failed-quota",
    ok: false,
    providerId: "siliconflow-kolors",
    providerName: "SiliconFlow Kolors",
    sourceModel: "kimi-k2-7-code",
    prompt: "draw a cat again",
    errorCode: "insufficient_quota",
    errorMessage: "余额不足",
    createdAt: "2026-02-01T00:01:00.000Z",
  });

  const history = readImageGenerationHistory(rootDir);
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((item) => item.errorCode), ["insufficient_quota", "invalid_api_key"]);
  assert.deepEqual(history.map((item) => item.localPath), ["", ""]);
});

test("image generation history cleanup can remove only old generated files", () => {
  const rootDir = makeTempProject();
  const outputDir = imageOutputDirPath(rootDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const oldImagePath = path.join(outputDir, "old.png");
  const recentImagePath = path.join(outputDir, "recent.png");
  fs.writeFileSync(oldImagePath, Buffer.from("old-image"));
  fs.writeFileSync(recentImagePath, Buffer.from("recent-image"));

  recordImageGenerationHistory(rootDir, {
    providerName: "硅基流动 Kolors",
    sourceModel: "deepseek-v4-pro",
    prompt: "旧图",
    localPath: oldImagePath,
    mimeType: "image/png",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  recordImageGenerationHistory(rootDir, {
    providerName: "硅基流动 Kolors",
    sourceModel: "deepseek-v4-pro",
    prompt: "新图",
    localPath: recentImagePath,
    mimeType: "image/png",
    createdAt: "2026-02-10T00:00:00.000Z",
  });

  const cleaned = clearImageGenerationHistory(rootDir, {
    deleteFiles: true,
    olderThanDays: 30,
    now: "2026-02-15T00:00:00.000Z",
  });

  assert.equal(cleaned.removedRecords, 1);
  assert.equal(cleaned.keptRecords, 1);
  assert.equal(cleaned.removedFiles, 1);
  assert.equal(fs.existsSync(oldImagePath), false);
  assert.equal(fs.existsSync(recentImagePath), true);
  assert.deepEqual(readImageGenerationHistory(rootDir).map((item) => item.prompt), ["新图"]);
});

test("non OpenAI models inherit the default image provider or use a selected provider", () => {
  const rootDir = makeTempProject();
  saveSelection(rootDir, ["deepseek-v4-pro", "kimi-k2-7-code"]);
  saveImageProvider(rootDir, {
    id: "siliconflow-kolors",
    name: "硅基流动 Kolors",
    adapter: "siliconflow_images",
    baseUrl: "https://api.siliconflow.cn/v1",
    endpoint: "/images/generations",
    model: "Kwai-Kolors/Kolors",
    size: "1024x1024",
    apiKeyEnv: "SILICONFLOW_API_KEY",
    defaults: {
      batch_size: 1,
      num_inference_steps: 20,
      guidance_scale: 7.5,
    },
    makeDefault: true,
  });
  saveImageProvider(rootDir, {
    id: "zai-glm-image",
    name: "智谱 GLM Image",
    adapter: "zai_images",
    baseUrl: "https://api.z.ai/api/paas/v4",
    endpoint: "/images/generations",
    model: "glm-image",
    size: "1280x1280",
    apiKeyEnv: "ZAI_API_KEY",
  });
  saveModelImageGenerationOverride(rootDir, "kimi-k2-7-code", {
    mode: "provider",
    providerId: "zai-glm-image",
  });

  const config = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);

  assert.deepEqual(config.models[0].imageGeneration, {
    enabled: true,
    mode: "custom",
    providerId: "siliconflow-kolors",
    adapter: "siliconflow_images",
    displayName: "硅基流动 Kolors",
    baseUrl: "https://api.siliconflow.cn/v1",
    endpoint: "/images/generations",
    model: "Kwai-Kolors/Kolors",
    size: "1024x1024",
    apiKeyEnv: "SILICONFLOW_API_KEY",
    defaults: {
      batch_size: 1,
      num_inference_steps: 20,
      guidance_scale: 7.5,
    },
    response: {
      imageUrlPath: "images[0].url",
      imageBase64Path: "data[0].b64_json",
    },
    outputDir: imageOutputDirPath(rootDir),
    historyPath: imageGenerationHistoryPath(rootDir),
  });
  assert.equal(config.models[1].imageGeneration.providerId, "zai-glm-image");
  assert.equal(config.models[1].imageGeneration.adapter, "zai_images");
  assert.equal(config.models[1].imageGeneration.response.imageUrlPath, "data[0].url");
  assert.equal(config.models[1].imageGeneration.outputDir, imageOutputDirPath(rootDir));
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

test("Kimi and Kimi Code are separate built-in providers with independent endpoints and credentials", () => {
  const rootDir = makeTempProject();
  const providers = providerCatalog(rootDir);
  const kimi = providers.find((provider) => provider.id === "kimi");
  const kimiCode = providers.find((provider) => provider.id === "kimi-code");

  assert.ok(kimi);
  assert.ok(kimiCode);
  assert.equal(kimi.baseUrl, "https://api.moonshot.cn/v1");
  assert.equal(kimi.keyEnv, "MOONSHOT_API_KEY");
  assert.equal(kimiCode.baseUrl, "https://api.kimi.com/coding/v1");
  assert.equal(kimiCode.keyEnv, "KIMI_CODE_API_KEY");
});

test("built-in Kimi refresh stays on the Moonshot catalog and does not inject Kimi Code models", async () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, { MOONSHOT_API_KEY: "moonshot-secret" });

  const result = await refreshProviderModelDirectory(rootDir, "kimi", {
    now: () => "2026-07-29T01:02:03.000Z",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.moonshot.cn/v1/models");
      assert.equal(options.headers.Authorization, "Bearer moonshot-secret");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: "kimi-k2.6", object: "model" },
            { id: "kimi-k2.5", object: "model" },
          ],
        }),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.models.map((model) => model.id), [
    "kimi-k2.6",
    "kimi-k2.5",
  ]);
  assert.equal(result.models.some((model) => model.id === "k3"), false);
});

test("built-in Kimi Code refresh uses its own catalog and keeps current official model ids visible", async () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, { KIMI_CODE_API_KEY: "kimi-code-secret" });

  const result = await refreshProviderModelDirectory(rootDir, "kimi-code", {
    now: () => "2026-07-29T01:02:03.000Z",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.kimi.com/coding/v1/models");
      assert.equal(options.headers.Authorization, "Bearer kimi-code-secret");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: "kimi-for-coding", object: "model" },
          ],
        }),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.models.map((model) => model.id), [
    "k3",
    "k3-256k",
    "kimi-for-coding",
    "kimi-for-coding-highspeed",
  ]);
  assert.deepEqual(
    modelCatalog(rootDir)
      .filter((model) => model.providerId === "kimi-code")
      .map((model) => model.model),
    [
      "k3",
      "k3-256k",
      "kimi-for-coding",
      "kimi-for-coding-highspeed",
    ],
  );
});

test("a saved Kimi Moonshot override is preserved instead of being migrated to Kimi Code", async () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, { MOONSHOT_API_KEY: "moonshot-secret" });
  saveProviderOverride(rootDir, "kimi", {
    name: "Kimi / Moonshot",
    shortName: "Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    keyUrl: "https://platform.kimi.com/console/api-keys",
    docsUrl: "https://www.kimi.com/code/docs/en/",
    keyEnv: "MOONSHOT_API_KEY",
    keyLabel: "Kimi API Key",
  });

  const result = await refreshProviderModelDirectory(rootDir, "kimi", {
    fetchImpl: async (url) => {
      assert.equal(url, "https://api.moonshot.cn/v1/models");
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "kimi-k2.6" }] }),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.models.map((model) => model.id), ["kimi-k2.6"]);
  assert.equal(result.models.some((model) => model.id === "k3"), false);
});

test("legacy Kimi overrides that point at the Kimi Code endpoint migrate to the separate provider", () => {
  const rootDir = makeTempProject();
  const target = providerOverridesPath(rootDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({
    version: 1,
    providers: {
      kimi: {
        id: "kimi",
        name: "Kimi",
        baseUrl: "https://api.kimi.com/coding/v1/",
        keyEnv: "MOONSHOT_API_KEY",
        keyLabel: "Kimi API Key",
      },
    },
  }, null, 2)}\n`, "utf8");

  const overrides = readProviderOverrides(rootDir);
  const providers = providerCatalog(rootDir);

  assert.equal(overrides.kimi, undefined);
  assert.equal(overrides["kimi-code"].id, "kimi-code");
  assert.equal(overrides["kimi-code"].baseUrl, "https://api.kimi.com/coding/v1");
  assert.equal(overrides["kimi-code"].keyEnv, "KIMI_CODE_API_KEY");
  assert.equal(
    providers.find((provider) => provider.id === "kimi").baseUrl,
    "https://api.moonshot.cn/v1",
  );
  assert.equal(
    providers.find((provider) => provider.id === "kimi-code").baseUrl,
    "https://api.kimi.com/coding/v1",
  );
});

test("legacy Kimi model directory entries from the coding endpoint migrate without mixing Moonshot", () => {
  const rootDir = makeTempProject();
  const target = modelDirectoryPath(rootDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({
    version: 1,
    providers: {
      kimi: {
        providerId: "kimi",
        providerName: "Kimi",
        baseUrl: "https://api.kimi.com/coding/v1",
        endpoint: "https://api.kimi.com/coding/v1/models",
        models: [{ id: "kimi-for-coding" }],
      },
    },
  }, null, 2)}\n`, "utf8");

  const directory = readModelDirectory(rootDir);
  const models = modelCatalog(rootDir);

  assert.equal(directory.providers.kimi, undefined);
  assert.equal(directory.providers["kimi-code"].providerId, "kimi-code");
  assert.deepEqual(directory.providers["kimi-code"].models.map((model) => model.id), [
    "kimi-for-coding",
  ]);
  assert.equal(
    models.some((model) =>
      model.providerId === "kimi-code"
      && model.presetId === "kimi-code-for-coding"
      && model.model === "kimi-for-coding"
    ),
    true,
  );
  assert.equal(
    models.filter((model) => model.providerId === "kimi").some((model) =>
      model.model === "kimi-for-coding"
    ),
    false,
  );
});

test("legacy Kimi Code model references repair to the new provider without changing Moonshot choices", () => {
  const rootDir = makeTempProject();
  const directoryTarget = modelDirectoryPath(rootDir);
  fs.mkdirSync(path.dirname(directoryTarget), { recursive: true });
  fs.writeFileSync(directoryTarget, `${JSON.stringify({
    version: 1,
    providers: {
      kimi: {
        providerId: "kimi",
        providerName: "Kimi",
        baseUrl: "https://api.kimi.com/coding/v1",
        models: [{ id: "kimi-for-coding" }],
      },
    },
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(selectionPath(rootDir), `${JSON.stringify({
    selectedModelIds: [
      "remote-kimi-kimi-for-coding",
      "kimi-k2-6",
    ],
  }, null, 2)}\n`, "utf8");
  saveDesktopOptions(rootDir, {
    codexAuxiliaryModelId: "cb-remote-kimi-kimi-for-coding",
    smartRouting: {
      autoSelect: true,
      autoSelectRules: {
        code: {
          mode: "route",
          routeId: "cb-remote-kimi-kimi-for-coding",
        },
      },
      failover: {
        enabled: true,
        routeIds: ["cb-remote-kimi-kimi-for-coding"],
      },
    },
  });

  const repair = repairDesktopModelReferences(rootDir);

  assert.deepEqual(repair.selectedModelIds, [
    "kimi-code-for-coding",
    "kimi-k2-6",
  ]);
  assert.equal(repair.codexAuxiliaryModelId, "cb-kimi-code-for-coding");
  assert.equal(
    repair.smartRouting.autoSelectRules.code.routeId,
    "cb-kimi-code-for-coding",
  );
  assert.deepEqual(repair.smartRouting.failover.routeIds, [
    "cb-kimi-code-for-coding",
  ]);
});

test("provider model directory refresh uses the configured proxy path", async () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, { DEEPSEEK_API_KEY: "deepseek-secret" });
  const previousProxy = process.env.CODEXBRIDGE_HTTPS_PROXY;
  process.env.CODEXBRIDGE_HTTPS_PROXY = "http://127.0.0.1:19876";

  try {
    const result = await refreshProviderModelDirectory(rootDir, "deepseek", {
      fetchImpl: async (_url, options) => {
        assert.ok(options.dispatcher, "model directory refresh should use the shared proxy dispatcher");
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: "deepseek-chat" }] }),
        };
      },
    });

    assert.equal(result.ok, true);
  } finally {
    if (previousProxy === undefined) {
      delete process.env.CODEXBRIDGE_HTTPS_PROXY;
    } else {
      process.env.CODEXBRIDGE_HTTPS_PROXY = previousProxy;
    }
  }
});

test("provider model directory refresh classifies fetch failures and preserves cached models", async () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, { DEEPSEEK_API_KEY: "deepseek-secret" });
  await refreshProviderModelDirectory(rootDir, "deepseek", {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "deepseek-chat" }] }),
    }),
  });

  const networkError = new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect timed out with private upstream details"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    }),
  });
  const result = await refreshProviderModelDirectory(rootDir, "deepseek", {
    fetchImpl: async () => {
      throw networkError;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.cached, true);
  assert.deepEqual(result.models.map((model) => model.id), ["deepseek-chat"]);
  assert.match(result.error, /无法连接模型服务/);
  assert.match(result.error, /provider_models_connect_timeout/);
  assert.doesNotMatch(result.error, /private upstream details|fetch failed/);
  assert.ok(result.error.length <= 240);
});

test("provider model directory refresh rejects oversized responses before reading the body", async () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, { DEEPSEEK_API_KEY: "deepseek-secret" });
  await refreshProviderModelDirectory(rootDir, "deepseek", {
    now: () => "2026-06-26T01:02:03.000Z",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ id: "deepseek-v4-pro" }],
      }),
    }),
  });
  let jsonCalled = false;

  const result = await refreshProviderModelDirectory(rootDir, "deepseek", {
    now: () => "2026-06-26T02:03:04.000Z",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: {
        get: (name) => String(name).toLowerCase() === "content-length" ? String(9 * 1024 * 1024) : "",
      },
      json: async () => {
        jsonCalled = true;
        return { data: [{ id: "deepseek-should-not-be-read" }] };
      },
    }),
  });

  assert.equal(jsonCalled, false);
  assert.equal(result.ok, false);
  assert.equal(result.cached, true);
  assert.equal(result.stale, true);
  assert.match(result.error, /too large|过大|large/i);
  assert.deepEqual(result.models.map((model) => model.id), ["deepseek-v4-pro"]);

  const directory = readModelDirectory(rootDir);
  assert.equal(directory.providers.deepseek.fetchedAt, "2026-06-26T01:02:03.000Z");
  assert.deepEqual(directory.providers.deepseek.models.map((model) => model.id), ["deepseek-v4-pro"]);
});

test("provider model directory refresh keeps the last cache on 200 invalid JSON or wrong shapes", async () => {
  for (const [label, response] of [
    ["invalid-json", {
      ok: true,
      status: 200,
      text: async () => "{not-valid-json",
    }],
    ["wrong-shape", {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, message: "not a model directory" }),
    }],
  ]) {
    const rootDir = makeTempProject();
    saveSecrets(rootDir, { DEEPSEEK_API_KEY: `cache-shape-key-${label}` });
    const seeded = await refreshProviderModelDirectory(rootDir, "deepseek", {
      now: () => "2026-06-26T01:02:03.000Z",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "deepseek-last-known-good" }] }),
      }),
    });
    assert.equal(seeded.ok, true);

    const result = await refreshProviderModelDirectory(rootDir, "deepseek", {
      now: () => "2026-06-26T02:03:04.000Z",
      fetchImpl: async () => response,
    });
    const cached = readModelDirectory(rootDir).providers.deepseek;

    assert.equal(result.ok, false, label);
    assert.equal(result.cached, true, label);
    assert.equal(result.stale, true, label);
    assert.match(result.error, /JSON|format|shape|model directory/i, label);
    assert.deepEqual(result.models.map((model) => model.id), ["deepseek-last-known-good"], label);
    assert.equal(cached.fetchedAt, "2026-06-26T01:02:03.000Z", label);
    assert.deepEqual(cached.models.map((model) => model.id), ["deepseek-last-known-good"], label);
  }
});

test("provider model directory refresh bounds chunked response bodies without calling unbounded text readers", async () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, { DEEPSEEK_API_KEY: "stream-bound-test-key" });
  const chunk = new Uint8Array(1024 * 1024);
  let reads = 0;
  let canceled = false;
  let textCalled = false;

  const result = await refreshProviderModelDirectory(rootDir, "deepseek", {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "" },
      body: {
        getReader() {
          return {
            async read() {
              reads += 1;
              return { done: false, value: chunk };
            },
            async cancel() {
              canceled = true;
            },
            releaseLock() {},
          };
        },
      },
      async text() {
        textCalled = true;
        throw new Error("unbounded text reader must not be called");
      },
    }),
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /too large|过大/i);
  assert.equal(reads, 9);
  assert.equal(canceled, true);
  assert.equal(textCalled, false);
});

test("provider model directory refresh times out a stalled fetch", async () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, { DEEPSEEK_API_KEY: "timeout-test-key" });

  const pending = refreshProviderModelDirectory(rootDir, "deepseek", {
    timeoutMs: 10,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("aborted stalled provider request");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
  });
  const result = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve("test-timeout"), 250)),
  ]);

  assert.notEqual(result, "test-timeout");
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out|超时/i);
});

test("provider model directory refresh has a hard deadline when fetch ignores AbortSignal", async () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, { DEEPSEEK_API_KEY: "hard-fetch-timeout-key" });

  const pending = refreshProviderModelDirectory(rootDir, "deepseek", {
    timeoutMs: 10,
    fetchImpl: async () => new Promise(() => {}),
  });
  const result = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve("test-timeout"), 250)),
  ]);

  assert.notEqual(result, "test-timeout");
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out|timeout/i);
});

test("provider model directory refresh has a hard deadline when the body reader stalls", async () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, { DEEPSEEK_API_KEY: "hard-body-timeout-key" });

  const pending = refreshProviderModelDirectory(rootDir, "deepseek", {
    timeoutMs: 10,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "" },
      text: async () => new Promise(() => {}),
    }),
  });
  const result = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve("test-timeout"), 250)),
  ]);

  assert.notEqual(result, "test-timeout");
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out|timeout/i);
});

test("a slower older refresh cannot overwrite a newer refresh for the same provider", async () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, { DEEPSEEK_API_KEY: "refresh-order-key" });
  let releaseSlow;
  let markSlowStarted;
  const slowGate = new Promise((resolve) => {
    releaseSlow = resolve;
  });
  const slowStarted = new Promise((resolve) => {
    markSlowStarted = resolve;
  });

  const slow = refreshProviderModelDirectory(rootDir, "deepseek", {
    now: () => "2026-06-26T01:00:00.000Z",
    fetchImpl: async () => {
      markSlowStarted();
      await slowGate;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "deepseek-slow-old" }] }),
      };
    },
  });
  await slowStarted;

  const fast = await refreshProviderModelDirectory(rootDir, "deepseek", {
    now: () => "2026-06-26T02:00:00.000Z",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "deepseek-fast-new" }] }),
    }),
  });
  releaseSlow();
  const slowResult = await slow;
  const cached = readModelDirectory(rootDir).providers.deepseek;

  assert.equal(fast.ok, true);
  assert.equal(slowResult.ok, false);
  assert.equal(slowResult.stale, true);
  assert.deepEqual(cached.models.map((model) => model.id), ["deepseek-fast-new"]);
  assert.equal(cached.fetchedAt, "2026-06-26T02:00:00.000Z");
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

test("custom intermediary model refresh replaces its seed model with the remote directory", async () => {
  const rootDir = makeTempProject();
  const seed = saveCustomModel(rootDir, {
    providerId: "custom-relay",
    providerName: "Custom Relay",
    displayName: "Relay Seed",
    model: "relay-seed",
    baseUrl: "https://relay.example/v1",
    api: "responses",
    keyEnv: "CUSTOM_RELAY_API_KEY",
  });
  saveSecrets(rootDir, { CUSTOM_RELAY_API_KEY: "relay-secret" });
  saveSelection(rootDir, [seed.presetId], MODE_HYBRID);

  const result = await refreshProviderModelDirectory(rootDir, "custom-relay", {
    now: () => "2026-07-18T12:00:00.000Z",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://relay.example/v1/models");
      assert.equal(options.headers.Authorization, "Bearer relay-secret");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          object: "list",
          data: [
            { id: "relay-model-a", display_name: "Relay Model A" },
            { id: "relay-model-b" },
          ],
        }),
      };
    },
  });

  const relayModels = modelCatalog(rootDir)
    .filter((model) => model.providerId === "custom-relay");

  assert.equal(result.ok, true);
  assert.deepEqual(relayModels.map((model) => model.model), [
    "relay-model-a",
    "relay-model-b",
  ]);
  assert.equal(relayModels.some((model) => model.presetId === seed.presetId), false);
  assert.equal(relayModels[0].displayName, "Relay Model A");
  assert.equal(relayModels[0].api, "responses");
  assert.equal(relayModels[0].baseUrl, "https://relay.example/v1");
  assert.equal(relayModels[0].apiKeyEnv, "CUSTOM_RELAY_API_KEY");
  assert.equal(relayModels[0].custom, true);

  assert.deepEqual(readSelection(rootDir, MODE_HYBRID), [relayModels[0].presetId]);
  const [route] = buildRouterConfigFromSelection(rootDir, MODE_HYBRID).models;
  assert.equal(route.model, "relay-model-a");
  assert.equal(route.api, "responses");
  assert.equal(route.baseUrl, "https://relay.example/v1");
  assert.equal(route.apiKeyEnv, "CUSTOM_RELAY_API_KEY");
  assert.equal(route.custom, true);
});

test("custom intermediary model refresh exposes every compatible remote model instead of keeping the two saved seeds", async () => {
  const rootDir = makeTempProject();
  for (const model of ["gpt-5.6-sol", "gpt-5.5"]) {
    saveCustomModel(rootDir, {
      providerId: "custom-pptoken",
      providerName: "PPToken",
      displayName: model,
      model,
      baseUrl: "https://api.pptoken.org/v1",
      api: "responses",
      keyEnv: "CUSTOM_PPTOKEN_API_KEY",
    });
  }
  saveSecrets(rootDir, { CUSTOM_PPTOKEN_API_KEY: "pptoken-secret" });

  const remoteIds = [
    "gpt-5.6-sol",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.3",
    "o3",
    "o4-mini",
    "codex-mini-latest",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4o",
    "gpt-4o-mini",
    "claude-sonnet-4",
    "gemini-2.5-pro",
  ];
  const result = await refreshProviderModelDirectory(rootDir, "custom-pptoken", {
    now: () => "2026-07-18T13:00:00.000Z",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.pptoken.org/v1/models");
      assert.equal(options.headers.Authorization, "Bearer pptoken-secret");
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: remoteIds.map((id) => ({ id })) }),
      };
    },
  });

  const visibleModels = modelCatalog(rootDir)
    .filter((model) => model.providerId === "custom-pptoken");

  assert.equal(result.ok, true);
  assert.equal(result.count, 13);
  assert.equal(visibleModels.length, 13);
  assert.deepEqual(visibleModels.map((model) => model.model), remoteIds);
  assert.ok(visibleModels.every((model) => model.api === "responses"));
  assert.ok(visibleModels.every((model) => model.custom === true));
});

test("custom intermediary model refresh accepts a full OpenAI-compatible endpoint as Base URL", async () => {
  const rootDir = makeTempProject();
  saveCustomModel(rootDir, {
    providerId: "custom-full-endpoint",
    providerName: "Custom Full Endpoint",
    displayName: "Endpoint Seed",
    model: "endpoint-seed",
    baseUrl: "https://relay.example/v1/chat/completions",
    api: "chat_completions",
    keyEnv: "CUSTOM_FULL_ENDPOINT_API_KEY",
  });
  saveSecrets(rootDir, { CUSTOM_FULL_ENDPOINT_API_KEY: "endpoint-secret" });

  const result = await refreshProviderModelDirectory(rootDir, "custom-full-endpoint", {
    fetchImpl: async (url) => {
      assert.equal(url, "https://relay.example/v1/models");
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "endpoint-model" }] }),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    modelCatalog(rootDir)
      .filter((model) => model.providerId === "custom-full-endpoint")
      .map((model) => model.model),
    ["endpoint-model"],
  );
});

test("Volcano Ark model refresh keeps non-chat identities out of the chat model catalog", async () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, { ARK_API_KEY: "ark-secret" });

  const result = await refreshProviderModelDirectory(rootDir, "volcengine", {
    now: () => "2026-07-18T08:00:00.000Z",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: "doubao-seed-2-0-pro-260215" },
          { id: "mistral-7b-instruct-v0.2" },
          { id: "doubao-embedding-text-240515" },
          { id: "doubao-seedream-4-0-250828" },
          { id: "doubao-seedance-1-5-pro-251215" },
        ],
      }),
    }),
  });

  const rawIds = readModelDirectory(rootDir).providers.volcengine.models.map((model) => model.id);
  const chatIds = modelCatalog(rootDir)
    .filter((model) => model.providerId === "volcengine")
    .map((model) => model.model);

  assert.equal(result.ok, true);
  assert.deepEqual(rawIds, [
    "doubao-seed-2-0-pro-260215",
    "mistral-7b-instruct-v0.2",
    "doubao-embedding-text-240515",
    "doubao-seedream-4-0-250828",
    "doubao-seedance-1-5-pro-251215",
  ]);
  assert.deepEqual(chatIds, [
    "doubao-seed-2-0-pro-260215",
    "mistral-7b-instruct-v0.2",
  ]);
});

test("Volcano Ark model refresh uses readable names without changing upstream model IDs", async () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, { ARK_API_KEY: "ark-secret" });

  await refreshProviderModelDirectory(rootDir, "volcengine", {
    now: () => "2026-07-18T08:00:00.000Z",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: "doubao-seed-2-0-pro-260215" },
          { id: "mistral-7b-instruct-v0.2" },
          { id: "ep-20260718-test", display_name: "客服知识库模型" },
        ],
      }),
    }),
  });

  const models = modelCatalog(rootDir).filter((model) => model.providerId === "volcengine");
  const doubao = models.find((model) => model.model === "doubao-seed-2-0-pro-260215");
  const mistral = models.find((model) => model.model === "mistral-7b-instruct-v0.2");
  const endpoint = models.find((model) => model.model === "ep-20260718-test");

  assert.equal(doubao.displayName, "Doubao Seed 2.0 Pro · 2026-02-15");
  assert.equal(mistral.displayName, "Mistral 7B Instruct v0.2");
  assert.equal(endpoint.displayName, "客服知识库模型");
  assert.equal(endpoint.model, "ep-20260718-test");
  assert.equal(readModelDirectory(rootDir).providers.volcengine.models[2].displayName, "客服知识库模型");

  saveSelection(rootDir, [doubao.presetId], MODE_HYBRID);
  const route = buildRouterConfigFromSelection(rootDir, MODE_HYBRID).models[0];
  assert.equal(route.provider, "volcengine");
  assert.equal(route.providerFamily, "doubao");
  assert.equal(route.api, "chat_completions");
  assert.equal(route.model, "doubao-seed-2-0-pro-260215");
  const profile = normalizeAdapterProfile(route);
  assert.equal(profile.adapterId, "chat-doubao");
  assert.equal(profile.dropParams.includes("reasoning"), true);
});

test("Volcano Ark GLM 5.2 refresh uses Responses without changing ordinary Doubao chat routes", async () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, { ARK_API_KEY: "ark-secret" });

  await refreshProviderModelDirectory(rootDir, "volcengine", {
    now: () => "2026-07-18T09:00:00.000Z",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: "glm-5.2" },
          { id: "doubao-seed-2-0-pro-260215" },
        ],
      }),
    }),
  });

  const models = modelCatalog(rootDir).filter((model) => model.providerId === "volcengine");
  const glm = models.find((model) => model.model === "glm-5.2");
  const doubao = models.find((model) => model.model === "doubao-seed-2-0-pro-260215");

  assert.equal(glm.displayName, "GLM 5.2");
  assert.equal(glm.api, "responses");
  assert.equal(glm.baseUrl, "https://ark.cn-beijing.volces.com/api/v3");
  assert.equal(doubao.api, "chat_completions");

  saveSelection(rootDir, [glm.presetId], MODE_HYBRID);
  const route = buildRouterConfigFromSelection(rootDir, MODE_HYBRID).models[0];
  assert.equal(route.model, "glm-5.2");
  assert.equal(route.api, "responses");
  assert.equal(route.baseUrl, "https://ark.cn-beijing.volces.com/api/v3");
  assert.equal(normalizeAdapterProfile(route).adapterId, "responses-native");

  const codingRootDir = makeTempProject();
  saveSecrets(codingRootDir, { ARK_API_KEY: "coding-plan-secret" });
  saveProviderOverride(codingRootDir, "volcengine", {
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
  });
  await refreshProviderModelDirectory(codingRootDir, "volcengine", {
    now: () => "2026-07-18T09:05:00.000Z",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: "glm-5.2" },
          { id: "doubao-seed-2.0-code" },
        ],
      }),
    }),
  });
  const codingModels = modelCatalog(codingRootDir)
    .filter((model) => model.providerId === "volcengine");
  assert.equal(codingModels.find((model) => model.model === "glm-5.2")?.api, "responses");
  assert.equal(codingModels.find((model) => model.model === "doubao-seed-2.0-code")?.api, "responses");
  assert.ok(codingModels.every((model) => model.baseUrl === "https://ark.cn-beijing.volces.com/api/coding/v3"));
});

test("saved Volcano provider settings cannot demote GLM 5.2 or Coding Plan routes to Chat", async () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, { ARK_API_KEY: "ark-secret" });
  saveProviderOverride(rootDir, "volcengine", {
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    api: "chat_completions",
  });
  await refreshProviderModelDirectory(rootDir, "volcengine", {
    now: () => "2026-07-18T09:10:00.000Z",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "glm-5.2" }, { id: "doubao-seed-2-0-pro-260215" }] }),
    }),
  });

  let models = modelCatalog(rootDir).filter((model) => model.providerId === "volcengine");
  const glmModel = models.find((model) => model.model === "glm-5.2");
  const doubaoModel = models.find((model) => model.model === "doubao-seed-2-0-pro-260215");
  assert.equal(glmModel?.api, "responses");
  assert.equal(doubaoModel?.api, "chat_completions");
  saveSelection(rootDir, [glmModel.presetId, doubaoModel.presetId], MODE_HYBRID);
  let routes = buildRouterConfigFromSelection(rootDir, MODE_HYBRID).models;
  assert.equal(routes.find((route) => route.model === "glm-5.2")?.api, "responses");
  assert.equal(routes.find((route) => route.model === "doubao-seed-2-0-pro-260215")?.api, "chat_completions");

  saveProviderOverride(rootDir, "volcengine", {
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    api: "chat_completions",
  });
  models = modelCatalog(rootDir).filter((model) => model.providerId === "volcengine");
  assert.ok(models.length > 0);
  assert.ok(models.every((model) => model.api === "responses"));
  saveSelection(rootDir, models.map((model) => model.presetId), MODE_HYBRID);
  routes = buildRouterConfigFromSelection(rootDir, MODE_HYBRID).models;
  assert.ok(routes.length > 0);
  assert.ok(routes.every((route) => route.api === "responses"));
});

test("provider model refresh keeps obvious non-chat endpoints out of every chat model catalog", async () => {
  const openaiRoot = makeTempProject();
  saveSecrets(openaiRoot, { OPENAI_API_KEY: "openai-secret" });
  await refreshProviderModelDirectory(openaiRoot, "openai", {
    now: () => "2026-07-18T09:20:00.000Z",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: "gpt-4.1" },
          { id: "text-embedding-3-large" },
          { id: "gpt-image-1" },
          { id: "whisper-1" },
          { id: "omni-moderation-latest" },
        ],
      }),
    }),
  });
  assert.deepEqual(
    modelCatalog(openaiRoot).filter((model) => model.providerId === "openai").map((model) => model.model),
    ["gpt-4.1"],
  );

  const qwenRoot = makeTempProject();
  saveSecrets(qwenRoot, { DASHSCOPE_API_KEY: "qwen-secret" });
  await refreshProviderModelDirectory(qwenRoot, "qwen", {
    now: () => "2026-07-18T09:25:00.000Z",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: "qwen3-coder-plus" },
          { id: "qwen3-vl-plus" },
          { id: "text-embedding-v4" },
          { id: "gte-rerank-v2" },
          { id: "qwen-tts-latest" },
        ],
      }),
    }),
  });
  assert.deepEqual(
    modelCatalog(qwenRoot).filter((model) => model.providerId === "qwen").map((model) => model.model),
    ["qwen3-coder-plus", "qwen3-vl-plus"],
  );
});

test("synced OpenAI models omit GPT from display names while retaining gpt upstream ids", async () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, { OPENAI_API_KEY: "openai-secret" });
  await refreshProviderModelDirectory(rootDir, "openai", {
    now: () => "2026-08-02T10:00:00.000Z",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "gpt-4.1" }, { id: "gpt-4o" }] }),
    }),
  });

  const models = modelCatalog(rootDir).filter((model) => model.providerId === "openai");
  assert.deepEqual(
    models.map((model) => [model.displayName, model.model]),
    [["OpenAI 4.1", "gpt-4.1"], ["OpenAI 4o", "gpt-4o"]],
  );
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

test("provider logo candidates reject symbolic-link and hard-link source files", (t) => {
  const rootDir = makeTempProject();
  const original = path.join(rootDir, "original-logo.png");
  const hardLink = path.join(rootDir, "hard-linked-logo.png");
  fs.writeFileSync(original, "trusted-logo-bytes", "utf8");
  fs.linkSync(original, hardLink);

  assert.throws(
    () => buildProviderLogoCandidate(rootDir, "hard-linked", hardLink),
    /hard.?link|single.?link|unsafe/i,
  );

  const symlinkSource = path.join(rootDir, "symbolic-logo.png");
  try {
    fs.symlinkSync(original, symlinkSource, "file");
  } catch (error) {
    t.diagnostic(`symbolic-link source check skipped: ${error.code || error.message}`);
    return;
  }
  assert.throws(
    () => buildProviderLogoCandidate(rootDir, "symbolic", symlinkSource),
    /symbolic.?link|unsafe/i,
  );
});

test("provider logo writes reject linked targets and managed-directory junctions", (t) => {
  const sourceRoot = makeTempProject();
  const source = path.join(sourceRoot, "source-logo.png");
  fs.writeFileSync(source, "new-logo-bytes", "utf8");

  for (const kind of ["hard-link", "symbolic-link"]) {
    const rootDir = makeTempProject();
    const logoDir = path.join(rootDir, "config", "provider-logos");
    const target = path.join(logoDir, "deepseek.png");
    const victim = path.join(rootDir, `${kind}-victim.png`);
    fs.mkdirSync(logoDir, { recursive: true });
    fs.writeFileSync(victim, `${kind}-victim-bytes`, "utf8");
    try {
      if (kind === "hard-link") {
        fs.linkSync(victim, target);
      } else {
        fs.symlinkSync(victim, target, "file");
      }
    } catch (error) {
      t.diagnostic(`${kind} target check skipped: ${error.code || error.message}`);
      continue;
    }

    assert.throws(
      () => saveProviderLogo(rootDir, "deepseek", source),
      /symbolic.?link|hard.?link|single.?link|unsafe/i,
      kind,
    );
    assert.equal(fs.readFileSync(victim, "utf8"), `${kind}-victim-bytes`, kind);
  }

  const junctionRoot = makeTempProject();
  const outsideDir = path.join(junctionRoot, "outside-logo-dir");
  const managedDir = path.join(junctionRoot, "config", "provider-logos");
  fs.mkdirSync(path.dirname(managedDir), { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  try {
    fs.symlinkSync(outsideDir, managedDir, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.diagnostic(`managed-directory junction check skipped: ${error.code || error.message}`);
    return;
  }
  assert.throws(
    () => saveProviderLogo(junctionRoot, "deepseek", source),
    /symbolic.?link|junction|outside|unsafe/i,
  );
  assert.equal(fs.existsSync(path.join(outsideDir, "deepseek.png")), false);
});

test("provider logo candidate detects a source path swap while reading", () => {
  const rootDir = makeTempProject();
  const source = path.join(rootDir, "source-logo.png");
  const moved = path.join(rootDir, "source-logo-original.png");
  fs.writeFileSync(source, "trusted-logo-bytes", "utf8");
  const originalReadFileSync = fs.readFileSync;
  let swapped = false;

  fs.readFileSync = function patchedReadFileSync(file, ...args) {
    if (!swapped && typeof file === "number") {
      swapped = true;
      fs.renameSync(source, moved);
      fs.writeFileSync(source, "attacker-replacement-bytes", "utf8");
    }
    return originalReadFileSync.call(this, file, ...args);
  };
  try {
    assert.throws(
      () => buildProviderLogoCandidate(rootDir, "deepseek", source),
      /changed|identity|unsafe/i,
    );
    assert.equal(swapped, true);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

test("config export never follows managed provider logo links", (t) => {
  for (const kind of ["hard-link", "symbolic-link"]) {
    const rootDir = makeTempProject();
    const logoDir = path.join(rootDir, "config", "provider-logos");
    const outside = path.join(rootDir, `${kind}-private.png`);
    const managed = path.join(logoDir, `${kind}.png`);
    const marker = `${kind}-private-logo-marker`;
    fs.mkdirSync(logoDir, { recursive: true });
    fs.writeFileSync(outside, marker, "utf8");
    try {
      if (kind === "hard-link") {
        fs.linkSync(outside, managed);
      } else {
        fs.symlinkSync(outside, managed, "file");
      }
    } catch (error) {
      t.diagnostic(`${kind} export check skipped: ${error.code || error.message}`);
      continue;
    }
    saveProviderOverride(rootDir, "deepseek", {
      logoUrl: pathToFileURL(managed).href,
    });

    const exported = exportConfigPackage(rootDir, { includeCodexResources: false });
    const serialized = JSON.stringify(exported);
    assert.doesNotMatch(serialized, new RegExp(marker), kind);
    assert.equal(exported.providerOverrides.deepseek.logoUrl, undefined, kind);
  }
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

test("Claude, Grok, and Gemini are independent built-in providers", () => {
  const providers = providerCatalog(makeTempProject());
  const anthropic = providers.find((provider) => provider.id === "anthropic");
  const xai = providers.find((provider) => provider.id === "xai");
  const gemini = providers.find((provider) => provider.id === "gemini");

  assert.deepEqual(
    [anthropic?.keyEnv, xai?.keyEnv, gemini?.keyEnv],
    ["ANTHROPIC_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY"],
  );
  assert.equal(anthropic?.api, "anthropic_messages");
  assert.equal(anthropic?.authMode, "anthropic_api_key");
  assert.equal(xai?.api, "chat_completions");
  assert.equal(gemini?.api, "chat_completions");
  assert.equal(
    MODEL_PRESETS.some((model) =>
      model.providerId === "anthropic" &&
      model.model === "claude-sonnet-4-6" &&
      model.api === "anthropic_messages"),
    true,
  );
  assert.equal(
    MODEL_PRESETS.some((model) => model.providerId === "xai" && model.model === "grok-4.5"),
    true,
  );
  assert.equal(
    MODEL_PRESETS.some((model) => model.providerId === "gemini" && model.model === "gemini-3.5-flash"),
    true,
  );
});

test("Anthropic model refresh uses native Anthropic authentication headers", async () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, { ANTHROPIC_API_KEY: "anthropic-secret" });
  let seen = null;

  const result = await refreshProviderModelDirectory(rootDir, "anthropic", {
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              id: "claude-sonnet-4-6",
              display_name: "Claude Sonnet 4.6",
              type: "model",
            },
          ],
          has_more: false,
        }),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(seen.url, "https://api.anthropic.com/v1/models");
  assert.equal(seen.options.headers["x-api-key"], "anthropic-secret");
  assert.equal(seen.options.headers["anthropic-version"], "2023-06-01");
  assert.equal(seen.options.headers.Authorization, undefined);
});

test("provider connection diagnostics validate key, model names, and response format", async () => {
  const rootDir = makeTempProject();
  const result = await testProviderConnection(rootDir, {
    providerId: "deepseek",
    apiKey: "typed-secret",
  }, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: "deepseek-v4-pro" },
          { id: "deepseek-v4-flash" },
        ],
      }),
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.summary.modelCount, 2);
  assert.equal(result.summary.matchedModelCount, 2);
  assert.match(result.message, /体检通过/);
  assert.deepEqual(
    result.checks.map((check) => check.id),
    ["base_url", "api_key", "quota_permission", "model_directory", "model_name", "response_format"],
  );
  assert.ok(result.checks.every((check) => check.status === "pass"));
  assert.match(result.checks.find((check) => check.id === "model_name").message, /deepseek-v4-pro/);
});

test("provider connection diagnostics explain quota and permission failures in Chinese", async () => {
  const rootDir = makeTempProject();
  const result = await testProviderConnection(rootDir, {
    providerId: "deepseek",
    apiKey: "typed-secret",
  }, {
    fetchImpl: async () => ({
      ok: false,
      status: 402,
      text: async () => '{"error":{"message":"insufficient_quota"}}',
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 402);
  assert.match(result.error, /余额|额度/);
  assert.equal(result.checks.find((check) => check.id === "api_key").status, "pass");
  assert.equal(result.checks.find((check) => check.id === "quota_permission").status, "fail");
  assert.match(result.checks.find((check) => check.id === "quota_permission").message, /余额|额度/);
});

test("provider connection diagnostics summarize HTML gateway errors without leaking raw pages", async () => {
  const rootDir = makeTempProject();
  const result = await testProviderConnection(rootDir, {
    providerId: "deepseek",
    apiKey: "typed-secret",
  }, {
    fetchImpl: async () => ({
      ok: false,
      status: 502,
      text: async () => "<!DOCTYPE html><html><head><title>ciyuan.fast | 502: Bad gateway</title></head><body>Bad gateway</body></html>",
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.match(result.error, /服务异常|网关错误/);
  assert.match(result.error, /502/);
  assert.doesNotMatch(result.error, /<!DOCTYPE|<html|<title>/i);
  assert.doesNotMatch(result.checks.find((check) => check.id === "quota_permission").message, /<!DOCTYPE|<html|<title>/i);
});

test("provider connection failures never reflect typed keys or remote response bodies", async () => {
  const rootDir = makeTempProject();
  const secret = "opaque-provider-key-271828";
  const remoteMarker = "provider-upstream-private-body";
  const providerInput = {
    providerId: "deepseek",
    apiKey: secret,
  };

  const httpResult = await testProviderConnection(rootDir, providerInput, {
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({
        error: { message: `authorization rejected ${secret} ${remoteMarker}` },
      }),
    }),
  });
  const transportResult = await testProviderConnection(rootDir, providerInput, {
    fetchImpl: async () => {
      throw new Error(`network failed ${secret} ${remoteMarker}`);
    },
  });

  for (const result of [httpResult, transportResult]) {
    const serialized = JSON.stringify(result);
    assert.equal(result.ok, false);
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.doesNotMatch(serialized, new RegExp(remoteMarker));
  }
});

test("provider connection diagnostics flag invalid model list formats", async () => {
  const rootDir = makeTempProject();
  const result = await testProviderConnection(rootDir, {
    providerId: "deepseek",
    apiKey: "typed-secret",
  }, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => "{\"ok\":true}",
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 200);
  assert.match(result.error, /返回格式/);
  assert.equal(result.checks.find((check) => check.id === "response_format").status, "fail");
  assert.ok(result.summary.failed >= 1);
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

test("provider model directory refresh never returns an echoed key or upstream response body", async () => {
  const rootDir = makeTempProject();
  const secret = "provider-refresh-echo-secret";
  saveSecrets(rootDir, { DEEPSEEK_API_KEY: secret });

  const result = await refreshProviderModelDirectory(rootDir, "deepseek", {
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      text: async () => `Authorization failed for ${secret}; upstream-private-body`,
    }),
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP 401/);
  assert.doesNotMatch(result.error, /provider-refresh-echo-secret|upstream-private-body/);
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

test("legacy custom models are normalized and credentialed URLs never reach catalogs, routes, or exports", () => {
  const rootDir = makeTempProject();
  const configDir = path.join(rootDir, "config");
  fs.mkdirSync(configDir, { recursive: true });
  const credentialMarker = "legacy-url-password-marker";
  const queryMarker = "legacy-query-token-marker";
  fs.writeFileSync(
    path.join(configDir, "custom-models.json"),
    JSON.stringify([
      {
        presetId: "custom-legacy-userinfo",
        providerId: "custom-legacy-userinfo",
        providerName: "Legacy Userinfo",
        displayName: "Legacy Userinfo",
        api: "chat_completions",
        baseUrl: `https://demo:${credentialMarker}@api.example.com/v1`,
        model: "legacy-userinfo",
        apiKeyEnv: "LEGACY_USERINFO_API_KEY",
        keyEnv: "LEGACY_USERINFO_API_KEY",
        custom: true,
      },
      {
        presetId: "custom-legacy-query",
        providerId: "custom-legacy-query",
        providerName: "Legacy Query",
        displayName: "Legacy Query",
        api: "chat_completions",
        baseUrl: `https://api.example.com/v1?x-auth-token=${queryMarker}`,
        model: "legacy-query",
        apiKeyEnv: "LEGACY_QUERY_API_KEY",
        keyEnv: "LEGACY_QUERY_API_KEY",
        custom: true,
      },
      {
        presetId: "custom-legacy-safe",
        providerId: "custom-legacy-safe",
        providerName: "Legacy Safe",
        displayName: "Legacy Safe",
        api: "chat_completions",
        baseUrl: "https://api.example.com/v1",
        model: "legacy-safe",
        apiKeyEnv: "LEGACY_SAFE_API_KEY",
        keyEnv: "LEGACY_SAFE_API_KEY",
        xAuthToken: "legacy-inline-token-value",
        custom: true,
      },
    ], null, 2),
    "utf8",
  );

  const models = readCustomModels(rootDir);
  assert.deepEqual(models.map((model) => model.presetId), ["custom-legacy-safe"]);
  assert.deepEqual(models[0].inputModalities, ["text"]);
  assert.equal(models[0].xAuthToken, undefined);
  assert.equal(
    modelCatalog(rootDir).some((model) =>
      model.presetId === "custom-legacy-userinfo" || model.presetId === "custom-legacy-query"),
    false,
  );

  saveSelection(rootDir, ["custom-legacy-safe"], MODE_HYBRID);
  const router = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);
  assert.deepEqual(router.models.map((model) => model.sourcePresetId), ["custom-legacy-safe"]);
  const exportedText = JSON.stringify(exportConfigPackage(rootDir, { includeCodexResources: false }));
  assert.doesNotMatch(exportedText, new RegExp(credentialMarker));
  assert.doesNotMatch(exportedText, new RegExp(queryMarker));
  assert.doesNotMatch(exportedText, /custom-legacy-userinfo|custom-legacy-query/);
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

test("ordinary router config writes receive a fresh UUID revision while pure builds stay revision-free", () => {
  const rootDir = makeTempProject();
  saveSelection(rootDir, ["deepseek-v4-pro"], MODE_HYBRID);

  const pure = buildRouterConfigFromSelection(rootDir, MODE_HYBRID);
  assert.equal(pure.configRevision, undefined);

  const first = writeRouterConfigFromSelection(rootDir, MODE_HYBRID);
  const second = writeRouterConfigFromSelection(rootDir, MODE_HYBRID);
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  assert.match(first.configRevision, uuidPattern);
  assert.match(second.configRevision, uuidPattern);
  assert.notEqual(second.configRevision, first.configRevision);
  assert.equal(readRouterConfig(rootDir).configRevision, second.configRevision);
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

test("repairManagedCodexConfigCompatibility migrates the legacy built-in provider before requests", () => {
  const rootDir = makeTempProject();
  saveSelection(rootDir, ["deepseek-v4-pro", "kimi-k2-7-code"], MODE_HYBRID);
  writeRouterConfigFromSelection(rootDir, MODE_HYBRID);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const target = path.join(codexDir, "config.toml");
  fs.writeFileSync(
    target,
    [
      "# >>> CodexBridge managed config",
      'model_provider = "openai"',
      'model = "cb-deepseek-v4-pro"',
      `model_catalog_json = "${toFixtureTomlPath(path.join(codexDir, "codexbridge-model-catalog.json"))}"`,
      'model_reasoning_effort = "medium"',
      'openai_base_url = "http://127.0.0.1:15722/v1"',
      "disable_response_storage = false",
      "# <<< CodexBridge managed config",
      "",
      "[history]",
      'persistence = "save-all"',
      "",
    ].join("\n"),
    "utf8",
  );

  const result = repairManagedCodexConfigCompatibility({
    rootDir,
    mode: MODE_HYBRID,
    homeDir,
  });
  const written = fs.readFileSync(target, "utf8");

  assert.equal(result.repaired, true);
  assert.ok(result.backup);
  assert.match(written, /model = "cb-deepseek-v4-pro"/);
  assert.match(written, /model_provider = "openai"/);
  assert.match(written, /openai_base_url = "http:\/\/127\.0\.0\.1:15722\/v1"/);
  assert.doesNotMatch(written, /model_providers\.codexbridge|disable_response_storage/);
  assert.match(written, /\[history]\s+persistence = "save-all"/);
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
  saveSelection(rootDir, ["codex-gpt-5-6-terra", "codex-gpt-5-6-sol"], MODE_HYBRID);
  writeRouterConfigFromSelection(rootDir, MODE_HYBRID);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const target = path.join(codexDir, "config.toml");
  fs.writeFileSync(
    target,
    [
      'model_provider = "codexbridge"',
      'model = "cb-gpt-5-6-terra"',
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
  assert.match(written, /model = "cb-gpt-5-6-terra"/);
  assert.match(written, /model_reasoning_effort = "high"/);
  assert.match(written, /openai_base_url = "http:\/\/127\.0\.0\.1:15722\/v1"/);
  assert.match(written, /\[history]\s+persistence = "save-all"/);
});

test("applyCodexConfig writes a Codex-visible model catalog next to config.toml", () => {
  const rootDir = makeTempProject();
  saveSelection(rootDir, [
    "codex-gpt-5-5",
    "deepseek-v4-pro",
    "kimi-k2-7-code",
  ], MODE_HYBRID);
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
  assert.equal(catalog.models[0].display_name, "5.5");
  const bySlug = new Map(catalog.models.map((model) => [model.slug, model]));
  assert.equal(bySlug.get("cb-deepseek-v4-pro")?.id, "cb-deepseek-v4-pro");
  assert.equal(bySlug.get("cb-deepseek-v4-pro")?.object, "model");
  assert.equal(bySlug.get("cb-deepseek-v4-pro")?.name, "DeepSeek V4 Pro");
  assert.equal(bySlug.get("cb-deepseek-v4-pro")?.display_name, "DeepSeek V4 Pro");
  assert.equal(bySlug.get("cb-deepseek-v4-pro")?.provider, "deepseek");
  assert.equal(bySlug.get("cb-deepseek-v4-pro")?.model, "deepseek-v4-pro");
  assert.equal(bySlug.get("cb-kimi-k2-7-code")?.name, "Kimi K2.7 Code");
  assert.equal(bySlug.get("cb-kimi-k2-7-code")?.provider, "kimi");
});

test("applyCodexConfig leaves the Codex native model cache untouched", () => {
  const rootDir = makeTempProject();
  saveSelection(rootDir, [
    "codex-gpt-5-5",
    "deepseek-v4-pro",
    "kimi-k2-7-code",
  ], MODE_HYBRID);
  writeRouterConfigFromSelection(rootDir, MODE_HYBRID);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const cacheFile = path.join(codexDir, "models_cache.json");
  const nativeCache = {
    fetched_at: "2026-01-01T00:00:00.000Z",
    etag: "remote-cache",
    client_version: "0.142.4",
    models: [
      { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
    ],
  };
  fs.writeFileSync(cacheFile, JSON.stringify(nativeCache, null, 2), "utf8");

  applyCodexConfig({ rootDir, mode: MODE_HYBRID, homeDir });

  const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  assert.deepEqual(cache, nativeCache);
});

test("applyCodexConfig exposes per-model context windows to the independent CodexBridge catalog", () => {
  const rootDir = makeTempProject();
  saveSelection(rootDir, ["deepseek-v4-pro"], MODE_HYBRID);
  saveModelCapabilityOverride(rootDir, "deepseek-v4-pro", {
    contextWindow: 1_000_000,
  });
  const config = writeRouterConfigFromSelection(rootDir, MODE_HYBRID);
  config.catalog = {
    ...config.catalog,
    contextWindow: 258400,
  };
  fs.writeFileSync(routerConfigPath(rootDir), JSON.stringify(config, null, 2), "utf8");
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));

  applyCodexConfig({ rootDir, mode: MODE_HYBRID, homeDir });

  const codexDir = path.join(homeDir, ".codex");
  const catalog = JSON.parse(fs.readFileSync(path.join(codexDir, "codexbridge-model-catalog.json"), "utf8"));
  const catalogModel = catalog.models.find((model) => model.slug === "cb-deepseek-v4-pro");

  assert.equal(config.models[0].contextWindow, 1_000_000);
  assert.equal(catalogModel?.context_window, 1_000_000);
  assert.equal(catalogModel?.max_context_window, 1_000_000);
  assert.equal(catalogModel?.auto_compact_token_limit, 800_000);
  assert.equal(catalogModel?.codexbridge_capabilities?.context_window, 1_000_000);
  assert.equal(fs.existsSync(path.join(codexDir, "models_cache.json")), false);
});

test("refreshCodexVisibleModelCatalogIfManaged updates the independent picker catalog after route changes", () => {
  const rootDir = makeTempProject();
  saveSelection(rootDir, [
    "deepseek-v4-pro",
    "kimi-k2-7-code",
  ], MODE_HYBRID);
  writeRouterConfigFromSelection(rootDir, MODE_HYBRID);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const configFile = path.join(codexDir, "config.toml");
  const existingConfig = [
    "model = \"cb-deepseek-v4-pro\"",
    buildCodexToml({ rootDir, mode: MODE_HYBRID, homeDir, model: "cb-deepseek-v4-pro" }),
  ].join("\n");
  fs.writeFileSync(configFile, existingConfig, "utf8");

  const result = refreshCodexVisibleModelCatalogIfManaged({
    rootDir,
    mode: MODE_HYBRID,
    homeDir,
  });

  const catalog = JSON.parse(fs.readFileSync(result.catalog, "utf8"));
  const bySlug = new Map(catalog.models.map((model) => [model.slug, model]));

  assert.equal(result.skipped, false);
  assert.equal(result.catalog, path.join(codexDir, "codexbridge-model-catalog.json"));
  assert.equal(fs.readFileSync(configFile, "utf8"), existingConfig);
  assert.equal(bySlug.get("cb-deepseek-v4-pro")?.display_name, "DeepSeek V4 Pro");
  assert.equal(bySlug.get("cb-kimi-k2-7-code")?.name, "Kimi K2.7 Code");
});

test("refreshCodexVisibleModelCatalogIfManaged repairs unavailable selected CodexBridge model", () => {
  const rootDir = makeTempProject();
  saveSelection(rootDir, ["deepseek-v4-pro"], MODE_HYBRID);
  writeRouterConfigFromSelection(rootDir, MODE_HYBRID);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const configFile = path.join(codexDir, "config.toml");
  fs.writeFileSync(
    configFile,
    buildCodexToml({ rootDir, mode: MODE_HYBRID, homeDir, model: "cb-kimi-k2-7-code" }),
    "utf8",
  );

  const result = refreshCodexVisibleModelCatalogIfManaged({
    rootDir,
    mode: MODE_HYBRID,
    homeDir,
  });
  const written = fs.readFileSync(configFile, "utf8");

  assert.equal(result.skipped, false);
  assert.equal(result.modelRepaired, true);
  assert.equal(result.previousModel, "cb-kimi-k2-7-code");
  assert.equal(result.model, "cb-deepseek-v4-pro");
  assert.match(written, /model = "cb-deepseek-v4-pro"/);
  assert.doesNotMatch(written, /model = "cb-kimi-k2-7-code"/);
});

test("refreshCodexVisibleModelCatalogIfManaged repairs legacy top-level stale CodexBridge model", () => {
  const rootDir = makeTempProject();
  saveSelection(rootDir, ["deepseek-v4-pro"], MODE_HYBRID);
  writeRouterConfigFromSelection(rootDir, MODE_HYBRID);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const configFile = path.join(codexDir, "config.toml");
  fs.writeFileSync(
    configFile,
    [
      'model = "cb-kimi-k2-7-code"',
      buildCodexToml({ rootDir, mode: MODE_HYBRID, homeDir, model: "cb-kimi-k2-7-code" }),
    ].join("\n"),
    "utf8",
  );

  const result = refreshCodexVisibleModelCatalogIfManaged({
    rootDir,
    mode: MODE_HYBRID,
    homeDir,
  });
  const written = fs.readFileSync(configFile, "utf8");

  assert.equal(result.modelRepaired, true);
  assert.equal((written.match(/model = "cb-deepseek-v4-pro"/g) || []).length, 2);
  assert.doesNotMatch(written, /model = "cb-kimi-k2-7-code"/);
});

test("applyCodexConfig replaces stale selected CodexBridge model with current catalog model", () => {
  const rootDir = makeTempProject();
  saveSelection(rootDir, ["deepseek-v4-pro"], MODE_HYBRID);
  writeRouterConfigFromSelection(rootDir, MODE_HYBRID);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const configFile = path.join(codexDir, "config.toml");
  fs.writeFileSync(
    configFile,
    buildCodexToml({ rootDir, mode: MODE_HYBRID, homeDir, model: "cb-kimi-k2-7-code" }),
    "utf8",
  );

  applyCodexConfig({ rootDir, mode: MODE_HYBRID, homeDir });
  const written = fs.readFileSync(configFile, "utf8");

  assert.match(written, /model = "cb-deepseek-v4-pro"/);
  assert.doesNotMatch(written, /model = "cb-kimi-k2-7-code"/);
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

test("applyCodexConfig leaves legacy Codex state conversations unchanged when config is current", () => {
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
  assert.equal(Object.hasOwn(result, "historySync"), false);
  assert.equal(providerCount(dbPath, "codex-bridge"), 1);
  assert.equal(providerCount(dbPath, "openai"), 1);
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

test("restoreCodexConfig restores the latest CodexBridge backup", async () => {
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

  const restored = await restoreCodexConfig({
    homeDir,
    coordinator: codexRestoreCoordinator(homeDir),
  });

  assert.equal(restored.target, target);
  assert.equal(restored.backup, secondBackup);
  assert.equal(typeof restored.configRevision, "string");
  assert.ok(restored.currentBackup);
  assert.equal(fs.readFileSync(target, "utf8"), 'model = "manual-after"\n');
});

test("restoreCodexConfig prefers the latest non-CodexBridge backup", async () => {
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

  await restoreCodexConfig({ homeDir, coordinator: codexRestoreCoordinator(homeDir) });

  assert.equal(fs.readFileSync(target, "utf8"), 'model = "original-user-config"\n');
});

test("restoreCodexConfig falls back to the oldest backup when all backups are CodexBridge configs", async () => {
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

  await restoreCodexConfig({ homeDir, coordinator: codexRestoreCoordinator(homeDir) });

  assert.match(fs.readFileSync(target, "utf8"), /model_provider = "openai"/);
});

test("restoreCodexConfig explains when no backup exists", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));

  await assert.rejects(
    restoreCodexConfig({ homeDir, coordinator: codexRestoreCoordinator(homeDir) }),
    /没有找到 CodexBridge 写入前的备份/,
  );
});

test("restoreCodexConfig can remove only the managed CodexBridge block when no backup exists", async () => {
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

  const restored = await restoreCodexConfig({
    homeDir,
    coordinator: codexRestoreCoordinator(homeDir),
  });
  const written = fs.readFileSync(target, "utf8");

  assert.equal(restored.action, "strip_managed_block");
  assert.equal(restored.backup, null);
  assert.equal(typeof restored.configRevision, "string");
  assert.ok(restored.currentBackup);
  assert.doesNotMatch(written, /# >>> CodexBridge managed config/);
  assert.doesNotMatch(written, /openai_base_url = "http:\/\/127\.0\.0\.1:15722\/v1"/);
  assert.match(written, /notify = \["C:\/Codex\/openai-bundled\/computer-use\/codex-computer-use\.exe", "turn-ended"]/);
  assert.match(written, /\[history]\s+persistence = "save-all"/);
  assert.match(written, /\[plugins\."computer-use@openai-bundled"]\s+enabled = true/);
  assert.match(written, /\[mcp_servers\.node_repl]\s+command = "C:\/Codex\/node_repl\.exe"/);
  assert.match(written, /\[hooks\.state]\s+notify = \["C:\/Codex\/hook\.exe"]/);
});

test("recoverCodexHistoryAccess keeps CodexBridge config and removes the deprecated storage override", async () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const target = path.join(codexDir, "config.toml");
  fs.writeFileSync(target, 'model = "original-history-view"\n', "utf8");

  applyCodexConfig({ rootDir, mode: MODE_HYBRID, homeDir });
  let current = fs.readFileSync(target, "utf8");
  current = `${current.trimEnd()}\ndisable_response_storage = true # old history toggle\n`;
  fs.writeFileSync(target, current, "utf8");

  const recovered = await recoverCodexHistoryAccess({
    homeDir,
    coordinator: codexRestoreCoordinator(homeDir),
  });
  const written = fs.readFileSync(target, "utf8");

  assert.equal(recovered.action, "recover_history_access");
  assert.equal(recovered.target, target);
  assert.match(written, /model_provider = "openai"/);
  assert.match(written, /openai_base_url = "http:\/\/127\.0\.0\.1:15722\/v1"/);
  assert.doesNotMatch(written, /disable_response_storage/);
  assert.doesNotMatch(written, /original-history-view/);
  assert.match(recovered.message, /历史对话/);
  assert.match(recovered.nextStep, /重启 Codex/);
  assert.doesNotMatch(recovered.nextStep, /内置 OpenAI|built-in OpenAI/i);
  assert.ok(recovered.currentBackup, "current CodexBridge config should be backed up before recovery");
});

test("recoverCodexHistoryAccess does not roll current CodexBridge config back to old backups", async () => {
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

  const recovered = await recoverCodexHistoryAccess({
    homeDir,
    coordinator: codexRestoreCoordinator(homeDir),
  });
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

test("conversation provider sync entrypoint returns a read-only catalog recovery preview", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const dbPath = createCodexStateDb(codexDir, [
    ["thread_a", "codex-bridge", "gpt-5.5", "Bridge A"],
    ["thread_b", "codex-bridge", "gpt-5.4", "Bridge B"],
    ["thread_c", "openai", "gpt-5.5", "OpenAI C"],
  ]);

  const result = syncCodexBridgeConversationProviders({ homeDir });

  assert.equal(result.ok, false, "preview reports the missing current catalog without writing it");
  assert.equal(result.summary.stateThreads, 3);
  assert.equal(result.summary.catalogThreads, 0);
  assert.equal(result.summary.userThreads, 0);
  assert.equal(result.summary.internalThreads, 3);
  assert.equal(providerCount(dbPath, "codex-bridge"), 2);
  assert.equal(providerCount(dbPath, "openai"), 1);
  assert.equal(
    fs.readdirSync(codexDir).some((name) => name.includes("codexbridge-history")),
    false,
  );
});

function makeTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-test-"));
}

function codexRestoreCoordinator(homeDir) {
  const codexDir = path.join(homeDir, ".codex");
  const coordinator = createConfigWriteCoordinator({
    privateAcl: {
      async securePath() {},
      async verifyPath() {
        return true;
      },
    },
  });
  coordinator.configure({
    allowedRoots: [codexDir],
    journalDir: path.join(codexDir, ".restore-transactions"),
  });
  return coordinator;
}

function codexCliAuthoritySnapshot({ installedPlugins = [], availablePlugins = [], mcpServers = [] } = {}) {
  for (const plugin of installedPlugins) {
    assert.equal(typeof plugin.enabled, "boolean", `installed plugin ${plugin.id || plugin.pluginId || plugin.name} needs enabled`);
  }
  for (const server of mcpServers) {
    assert.equal(typeof server.enabled, "boolean", `MCP server ${server.name} needs enabled`);
  }
  const installed = installedPlugins.map((plugin) => ({
    ...plugin,
    installed: true,
    codexListKind: "installed",
  }));
  const available = availablePlugins.map((plugin) => ({
    ...plugin,
    installed: false,
    enabled: false,
    codexListKind: "available",
  }));
  return {
    executable: "C:/fixture/resources/codex.exe",
    plugins: {
      ok: true,
      code: "ok",
      items: [...installed, ...available],
      installed: { ok: true, code: "ok", items: installed },
      available: { ok: true, code: "ok", items: available },
    },
    mcpServers: { ok: true, code: "ok", items: mcpServers },
  };
}

function codexPromptSkillsSnapshot(skills = []) {
  const lines = skills.map((skill) => {
    const name = String(skill.name || "").trim();
    const description = String(skill.description || "Fixture skill.").trim();
    const filePath = String(skill.path || `C:/fixture/skills/${name}/SKILL.md`).replace(/\\/g, "/");
    return `- ${name}: ${description} (file: ${filePath})`;
  });
  return {
    ok: true,
    code: "ok",
    items: [{
      type: "input_text",
      text: ["### Available skills", ...lines].join("\n"),
    }],
  };
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
        "rollout_path TEXT,",
        "recency_at_ms INTEGER DEFAULT 0",
        ")",
      ].join(" "),
    );
    db.exec(
      "CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT)",
    );
    const insert = db.prepare(
      "INSERT INTO threads (id, model_provider, model, title, source, thread_source, cwd, archived, has_user_event, first_user_message, rollout_path, recency_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        row.rolloutPath ?? null,
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

test("Codex CLI resource snapshot retries a transient start timeout and caches only success", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-cli-retry-"));
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  const calls = [];
  let locatorCalls = 0;
  const execFile = (_executable, args) => {
    calls.push([...args]);
    if (calls.length === 1) {
      const error = new Error("spawn timed out");
      error.code = "ETIMEDOUT";
      error.killed = true;
      throw error;
    }
    if (args[0] === "plugin" && args.includes("--available")) {
      return JSON.stringify({ available: [] });
    }
    if (args[0] === "plugin") {
      return JSON.stringify({ installed: [
        { id: "retry-success", installed: true, enabled: true },
      ] });
    }
    return JSON.stringify([]);
  };
  const options = {
    homeDir,
    cacheMs: 60_000,
    locateCli: () => {
      locatorCalls += 1;
      return { found: true, cliTarget: "C:/fixture/codex.exe" };
    },
    execFile,
    now: () => 1_000,
  };

  const first = readCodexCliResourceSnapshot(options);
  const callCountAfterFirst = calls.length;
  const cached = readCodexCliResourceSnapshot(options);
  const refreshed = readCodexCliResourceSnapshot({ ...options, forceRefresh: true });

  assert.equal(first.plugins.ok, true);
  assert.equal(first.plugins.items[0]?.id, "retry-success");
  assert.equal(callCountAfterFirst, 4);
  assert.strictEqual(cached, first);
  assert.equal(locatorCalls, 2);
  assert.equal(calls.length, 7);
  assert.notStrictEqual(refreshed, first);
});

test("Codex CLI resource snapshot does not cache failed reads", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-cli-no-failure-cache-"));
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  let calls = 0;
  const options = {
    homeDir,
    cacheMs: 60_000,
    locateCli: () => ({ found: true, cliTarget: "C:/fixture/missing-codex.exe" }),
    execFile: () => {
      calls += 1;
      const error = new Error("spawn ENOENT");
      error.code = "ENOENT";
      throw error;
    },
    now: () => 2_000,
  };

  const first = readCodexCliResourceSnapshot(options);
  const callsAfterFirst = calls;
  const second = readCodexCliResourceSnapshot(options);

  assert.equal(first.plugins.ok, false);
  assert.equal(first.mcpServers.ok, false);
  assert.ok(callsAfterFirst > 0);
  assert.ok(calls > callsAfterFirst);
  assert.notStrictEqual(second, first);
});

test("unsupported installed plugin schema keeps current unknown and available diagnostics", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-cli-schema-"));
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  const snapshot = readCodexCliResourceSnapshot({
    homeDir,
    cacheMs: 0,
    locateCli: () => ({ found: true, cliTarget: "C:/fixture/codex.exe" }),
    execFile: (_executable, args) => {
      if (args[0] === "plugin" && args.includes("--available")) {
        return JSON.stringify({ available: [
          { id: "candidate@fixture-market", name: "Candidate" },
        ] });
      }
      if (args[0] === "plugin") {
        return JSON.stringify({ unexpected: [] });
      }
      return JSON.stringify([]);
    },
  });
  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: snapshot,
    codexPromptInputSnapshot: { ok: false, items: [], code: "unavailable", error: "fixture" },
  });

  assert.equal(snapshot.plugins.ok, false);
  assert.equal(snapshot.plugins.code, "unsupported_schema");
  assert.equal(snapshot.plugins.installed.code, "unsupported_schema");
  assert.equal(snapshot.plugins.available.ok, true);
  assert.equal(snapshot.plugins.items[0]?.installed, false);
  assert.equal(resources.summary.plugins, null);
  assert.equal(resources.readStatus.plugins.state, "unavailable");
  assert.equal(resources.readStatus.plugins.code, "unsupported_schema");
  assert.equal(
    resources.discovered.plugins.find((item) => item.id === "candidate@fixture-market")?.availability,
    "marketplace",
  );
});

test("installed plugin entries require an explicit enabled boolean", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-plugin-enabled-schema-"));
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  const snapshot = readCodexCliResourceSnapshot({
    homeDir,
    cacheMs: 0,
    locateCli: () => ({ found: true, cliTarget: "C:/fixture/codex.exe" }),
    execFile: (_executable, args) => {
      if (args[0] === "plugin" && args.includes("--available")) {
        return JSON.stringify({ available: [] });
      }
      if (args[0] === "plugin") {
        return JSON.stringify({ installed: [{ id: "ambiguous@fixture-market", name: "Ambiguous" }] });
      }
      return JSON.stringify([]);
    },
  });
  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: snapshot,
    codexPromptInputSnapshot: codexPromptSkillsSnapshot(),
  });

  assert.equal(snapshot.plugins.installed.ok, false);
  assert.equal(snapshot.plugins.installed.code, "unsupported_schema");
  assert.equal(snapshot.plugins.ok, false);
  assert.equal(resources.summary.plugins, null);
  assert.equal(resources.readStatus.plugins.code, "unsupported_schema");
});

test("MCP entries require an explicit enabled boolean", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-mcp-enabled-schema-"));
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  const snapshot = readCodexCliResourceSnapshot({
    homeDir,
    cacheMs: 0,
    locateCli: () => ({ found: true, cliTarget: "C:/fixture/codex.exe" }),
    execFile: (_executable, args) => {
      if (args[0] === "plugin" && args.includes("--available")) {
        return JSON.stringify({ available: [] });
      }
      if (args[0] === "plugin") {
        return JSON.stringify({ installed: [{ id: "enabled@fixture-market", enabled: true }] });
      }
      return JSON.stringify([{ name: "ambiguous-mcp" }]);
    },
  });
  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: snapshot,
    codexPromptInputSnapshot: codexPromptSkillsSnapshot(),
  });

  assert.equal(snapshot.mcpServers.ok, false);
  assert.equal(snapshot.mcpServers.code, "unsupported_schema");
  assert.equal(resources.summary.mcpServers, null);
  assert.equal(resources.readStatus.mcpServers.code, "unsupported_schema");
});

test("resource current counts require official installed and enabled provenance", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-cli-provenance-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const cachedDir = path.join(codexDir, "plugins", "cache", "fixture-market", "cached-only", "1.0.0");
  fs.mkdirSync(path.join(cachedDir, ".codex-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(cachedDir, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "cached-only", version: "1.0.0" }),
    "utf8",
  );
  const snapshot = readCodexCliResourceSnapshot({
    homeDir,
    cacheMs: 0,
    locateCli: () => ({ found: true, cliTarget: "C:/fixture/codex.exe" }),
    execFile: (_executable, args) => {
      if (args[0] === "plugin" && args.includes("--available")) {
        return JSON.stringify({ available: [
          { id: "available-only@fixture-market", name: "Available only" },
        ] });
      }
      if (args[0] === "plugin") {
        return JSON.stringify({ installed: [
          { id: "enabled@fixture-market", installed: true, enabled: true },
          { id: "disabled@fixture-market", installed: true, enabled: false },
        ] });
      }
      return JSON.stringify([]);
    },
  });
  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: snapshot,
    codexPromptInputSnapshot: { ok: false, items: [], code: "unavailable", error: "fixture" },
  });

  assert.deepEqual(snapshot.plugins.installed.items.map((item) => item.id), [
    "enabled@fixture-market",
    "disabled@fixture-market",
  ]);
  assert.equal(snapshot.plugins.available.items[0]?.installed, false);
  assert.equal(resources.summary.plugins, 1);
  assert.deepEqual(resources.plugins.map((item) => item.id), ["enabled@fixture-market"]);
  assert.equal(
    resources.discovered.plugins.find((item) => item.id === "disabled@fixture-market")?.availability,
    "disabled",
  );
  assert.equal(
    resources.discovered.plugins.find((item) => item.id === "available-only@fixture-market")?.availability,
    "marketplace",
  );
  assert.equal(
    resources.discovered.plugins.find((item) => item.id === "cached-only@fixture-market")?.availability,
    "cached",
  );
});

test("resource read status distinguishes successful empty authorities from unavailable authorities", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-read-status-"));
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  const knownEmpty = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: {
      plugins: { ok: true, items: [], installed: { ok: true, items: [] }, available: { ok: true, items: [] } },
      mcpServers: { ok: true, items: [] },
    },
    codexPromptInputSnapshot: {
      ok: true,
      items: [{ type: "input_text", text: "### Available skills" }],
    },
  });
  const unavailable = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: {
      plugins: { ok: false, items: [], code: "timeout", error: "timed out" },
      mcpServers: { ok: false, items: [], code: "start_failed", error: "not found" },
    },
    codexPromptInputSnapshot: { ok: false, items: [], code: "command_failed", error: "failed" },
  });

  assert.deepEqual(
    {
      plugins: knownEmpty.summary.plugins,
      mcpServers: knownEmpty.summary.mcpServers,
      skills: knownEmpty.summary.skills,
      marketplaces: knownEmpty.summary.marketplaces,
    },
    { plugins: 0, mcpServers: 0, skills: 0, marketplaces: 0 },
  );
  assert.equal(knownEmpty.readStatus.plugins.state, "ok");
  assert.equal(knownEmpty.readStatus.mcpServers.state, "ok");
  assert.equal(knownEmpty.readStatus.skills.state, "ok");
  assert.equal(unavailable.summary.plugins, null);
  assert.equal(unavailable.summary.mcpServers, null);
  assert.equal(unavailable.summary.skills, null);
  assert.equal(unavailable.readStatus.plugins.reason, "timed out");
  assert.equal(unavailable.readStatus.mcpServers.code, "start_failed");
  assert.equal(unavailable.readStatus.marketplaces.state, "ok");
});

test("plugin page snapshot is unavailable when every app-server authority failed", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-resource-all-failed-"));
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".codex", "config.toml"), "", "utf8");
  const failedKind = { ok: false, items: [], code: "probe_failed", error: "probe failed" };

  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: {
      plugins: { ...failedKind, installed: failedKind, available: failedKind },
      mcpServers: failedKind,
    },
    codexPromptInputSnapshot: failedKind,
    codexAppServerSnapshot: {
      ok: false,
      plugins: failedKind,
      apps: failedKind,
      skills: failedKind,
      snapshotSource: "codex-app-server",
      refreshedAt: "2026-07-14T00:00:00.000Z",
    },
  });

  assert.equal(resources.pluginPage.snapshot.state, "unavailable");
});

test("resource preflight and support diagnostics preserve unknown authoritative counts", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-unknown-preflight-"));
  fs.mkdirSync(path.join(homeDir, ".codex", "prompts"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".codex", "prompts", "known.md"), "# Known prompt\n", "utf8");
  fs.writeFileSync(path.join(rootDir, "AGENTS.md"), "# Known rules\n", "utf8");
  const codexCliSnapshot = {
    plugins: { ok: false, items: [], code: "timeout", error: "plugin read timed out" },
    mcpServers: { ok: false, items: [], code: "start_failed", error: "mcp command did not start" },
  };
  const codexPromptInputSnapshot = {
    ok: false,
    items: [],
    code: "command_failed",
    error: "prompt-input failed",
  };

  const check = buildStartupCheck(rootDir, {
    homeDir,
    routerRunning: true,
    lastHealth: { ok: true, models: [], unhealthyRoutes: 0, routes: [] },
    config: { models: [] },
    codexCliSnapshot,
    codexPromptInputSnapshot,
  });
  const resources = check.items.find((item) => item.id === "codex_resources");
  const configPackage = check.items.find((item) => item.id === "config_package");
  const diagnostics = supportDiagnostics(rootDir, {
    homeDir,
    config: { models: [] },
    codexCliSnapshot,
    codexPromptInputSnapshot,
  });

  assert.equal(resources.status, "warn");
  assert.equal(resources.count, null);
  assert.match(resources.detail, /MCP 无法读取/);
  assert.match(resources.detail, /插件 无法读取/);
  assert.match(resources.detail, /技能 无法读取/);
  assert.doesNotMatch(resources.detail, /MCP 0|插件 0|技能 0/);
  assert.match(diagnostics.text, /current: plugins=unavailable, mcp=unavailable, skills=unavailable/);
  assert.match(diagnostics.text, /pluginsRead: unavailable code=timeout reason=plugin read timed out/);
  assert.match(diagnostics.text, /mcpRead: unavailable code=start_failed reason=mcp command did not start/);
  assert.doesNotMatch(diagnostics.text, /current: plugins=0, mcp=0, skills=0/);
  assert.equal(configPackage.status, "warn");
  assert.equal(configPackage.count, null);
  assert.equal(configPackage.blockingClass, "local_setup");
  assert.equal(
    diagnostics.summary.releasePreflight.codeReady.codeOrConfigBlockingItemIds.includes("config_package"),
    false,
  );
  assert.equal(
    diagnostics.summary.releasePreflight.codeReady.ignoredLocalSetupItemIds.includes("config_package"),
    true,
  );
});

test("Codex prompt-input snapshot retries, refreshes, and caches only successful skill reads", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-prompt-retry-"));
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  let calls = 0;
  const options = {
    homeDir,
    cacheMs: 60_000,
    locateCli: () => ({ found: true, cliTarget: "C:/fixture/codex.exe" }),
    execFile: () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("prompt-input timed out");
        error.code = "ETIMEDOUT";
        throw error;
      }
      return JSON.stringify([{
        type: "input_text",
        text: "### Available skills\n- demo: Demo skill. (file: C:/demo/SKILL.md)",
      }]);
    },
    now: () => 3_000,
  };

  const first = readCodexPromptInputSnapshot(options);
  const cached = readCodexPromptInputSnapshot(options);
  const refreshed = readCodexPromptInputSnapshot({ ...options, forceRefresh: true });

  assert.equal(first.ok, true);
  assert.equal(first.attempts, 2);
  assert.strictEqual(cached, first);
  assert.equal(calls, 3);
  assert.notStrictEqual(refreshed, first);

  const failedHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-prompt-failure-cache-"));
  fs.mkdirSync(path.join(failedHome, ".codex"), { recursive: true });
  let failedCalls = 0;
  const failedOptions = {
    homeDir: failedHome,
    cacheMs: 60_000,
    locateCli: () => ({ found: true, cliTarget: "C:/fixture/missing-codex.exe" }),
    execFile: () => {
      failedCalls += 1;
      const error = new Error("spawn ENOENT");
      error.code = "ENOENT";
      throw error;
    },
    now: () => 4_000,
  };
  const failedFirst = readCodexPromptInputSnapshot(failedOptions);
  const callsAfterFailure = failedCalls;
  const failedSecond = readCodexPromptInputSnapshot(failedOptions);

  assert.equal(failedFirst.ok, false);
  assert.equal(failedFirst.code, "start_failed");
  assert.ok(failedCalls > callsAfterFailure);
  assert.notStrictEqual(failedSecond, failedFirst);
});

test("Codex prompt-input snapshot rejects unsupported skill schemas instead of caching empty success", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-prompt-schema-"));
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  let calls = 0;
  const options = {
    homeDir,
    cacheMs: 60_000,
    locateCli: () => ({ found: true, cliTarget: "C:/fixture/codex.exe" }),
    execFile: () => {
      calls += 1;
      return JSON.stringify([{ type: "input_text", text: "### Available skills\n- new-shape: { path: 'C:/new' }" }]);
    },
    now: () => 5_000,
  };

  const first = readCodexPromptInputSnapshot(options);
  const second = readCodexPromptInputSnapshot(options);

  assert.equal(first.ok, false);
  assert.equal(first.code, "unsupported_schema");
  assert.equal(calls, 2);
  assert.notStrictEqual(second, first);
});

test("config package resource counts and sync status preserve authoritative unknown", () => {
  assert.equal(configPackageCodexResourceCount({
    summary: { mcpServers: 1, plugins: 2, skills: 3, prompts: 4, agentFiles: 5 },
  }), 15);
  assert.equal(configPackageCodexResourceCount({
    summary: { mcpServers: 1, plugins: null, skills: 3, prompts: 4, agentFiles: 5 },
  }), null);
  assert.equal(configPackageCodexResourceCount({
    summary: { plugins: 2, prompts: 1 },
  }), 3);

  const rootDir = makeTempProject();
  const syncPath = configPackageSyncStatusPath(rootDir);
  fs.mkdirSync(path.dirname(syncPath), { recursive: true });
  fs.writeFileSync(syncPath, JSON.stringify({
    fileName: "CodexBridge-config-2026-07-11-1.json",
    exportedAt: "2026-07-11T00:00:00.000Z",
    codexResourceCount: null,
  }), "utf8");

  assert.equal(readConfigPackageSyncStatus(rootDir).codexResourceCount, null);

  fs.writeFileSync(syncPath, JSON.stringify({
    fileName: "CodexBridge-config-2026-07-11-2.json",
    exportedAt: "2026-07-11T00:00:01.000Z",
  }), "utf8");
  assert.equal(readConfigPackageSyncStatus(rootDir).codexResourceCount, null);

  fs.writeFileSync(syncPath, JSON.stringify({
    fileName: "CodexBridge-config-2026-07-11-3.json",
    exportedAt: "2026-07-11T00:00:02.000Z",
    codexResourceCount: "not-a-count",
  }), "utf8");
  assert.equal(readConfigPackageSyncStatus(rootDir).codexResourceCount, null);

  fs.writeFileSync(syncPath, JSON.stringify({
    fileName: "CodexBridge-config-2026-07-11-4.json",
    exportedAt: "2026-07-11T00:00:03.000Z",
    codexResourceCount: 0,
  }), "utf8");
  assert.equal(readConfigPackageSyncStatus(rootDir).codexResourceCount, 0);
});

test("portable Codex resource manifests preserve null summaries and read states", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-portable-unknown-"));
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "AGENTS.md"), "# Rules\n", "utf8");
  const pkg = exportConfigPackage(rootDir, {
    homeDir,
    codexCliSnapshot: {
      plugins: { ok: false, items: [], code: "timeout", error: "timed out" },
      mcpServers: { ok: false, items: [], code: "start_failed", error: "failed" },
    },
    includeCodexCliSnapshot: true,
    codexPromptInputSnapshot: {
      ok: false,
      items: [],
      code: "command_failed",
      error: "prompt failed",
    },
    includeCodexPromptInputSnapshot: true,
  });

  assert.equal(pkg.codexResources.summary.plugins, null);
  assert.equal(pkg.codexResources.summary.mcpServers, null);
  assert.equal(pkg.codexResources.summary.skills, null);
  assert.equal(pkg.codexResources.readStatus.plugins.code, "timeout");
  assert.equal(configPackageCodexResourceCount(pkg.codexResources), null);
});

test("Codex CLI list item schema drift is unsupported instead of successful empty", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-item-schema-"));
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  const snapshot = readCodexCliResourceSnapshot({
    homeDir,
    cacheMs: 0,
    locateCli: () => ({ found: true, cliTarget: "C:/fixture/codex.exe" }),
    execFile: (_executable, args) => {
      if (args[0] === "plugin" && args.includes("--available")) {
        return JSON.stringify([]);
      }
      return JSON.stringify([{}]);
    },
  });

  assert.equal(snapshot.plugins.ok, false);
  assert.equal(snapshot.plugins.code, "unsupported_schema");
  assert.equal(snapshot.mcpServers.ok, false);
  assert.equal(snapshot.mcpServers.code, "unsupported_schema");
});

test("MCP current count requires an explicit enabled state", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-mcp-enabled-"));
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: {
      plugins: { ok: true, items: [] },
      mcpServers: {
        ok: true,
        items: [
          { name: "enabled", enabled: true },
          { name: "disabled", enabled: false },
          { name: "ambiguous" },
        ],
      },
    },
    codexPromptInputSnapshot: { ok: false, items: [], code: "unavailable", error: "fixture" },
  });

  assert.equal(resources.summary.mcpServers, 1);
  assert.deepEqual(resources.mcpServers.map((item) => item.name), ["enabled"]);
  assert.equal(
    resources.discovered.mcpServers.find((item) => item.name === "ambiguous")?.availability,
    "disabled",
  );
});

test("dynamic Codex authorities flow through locator snapshots into resource summaries", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-dynamic-authorities-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const installedPlugins = Array.from({ length: 6 }, (_, index) => ({
    id: `plugin-${index}@fixture-market`,
    name: `Plugin ${index}`,
    enabled: index % 3 !== 0,
  }));
  const availablePlugins = Array.from({ length: 3 }, (_, index) => ({
    id: `available-${index}@fixture-market`,
    name: `Available ${index}`,
  }));
  const mcpItems = Array.from({ length: 5 }, (_, index) => ({
    name: `mcp-${index}`,
    enabled: index !== 1,
  }));
  const skillItems = Array.from({ length: 7 }, (_, index) => ({
    name: `skill-${index}`,
    path: `C:/fixture/skills/skill-${index}/SKILL.md`,
  }));
  const marketplaceIds = Array.from({ length: 4 }, (_, index) => `market-${index}`);
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    marketplaceIds.map((id) => `[marketplaces."${id}"]\nsource = "https://example.invalid/${id}"\n`).join("\n"),
    "utf8",
  );
  const desktopOptions = { codexDesktopLaunchTarget: "C:/fixture/Codex.lnk" };
  const locatedOptions = [];
  const locateCli = (options) => {
    locatedOptions.push(options);
    assert.deepEqual(options.desktopOptions, desktopOptions);
    return { found: true, cliTarget: "C:/fixture/resources/codex.exe" };
  };
  const snapshots = readCodexResourceSnapshots({
    homeDir,
    cacheMs: 0,
    desktopOptions,
    locateCli,
    execFile: (_executable, args) => {
      if (args[0] === "debug") {
        return JSON.stringify([{
          type: "input_text",
          text: [
            "### Available skills",
            ...skillItems.map((item) => `- ${item.name}: Dynamic skill. (file: ${item.path})`),
          ].join("\n"),
        }]);
      }
      if (args[0] === "plugin" && args.includes("--available")) {
        return JSON.stringify({ available: availablePlugins });
      }
      if (args[0] === "plugin") {
        return JSON.stringify({ installed: installedPlugins });
      }
      return JSON.stringify(mcpItems);
    },
  });
  const resources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot: snapshots.codexCliSnapshot,
    codexPromptInputSnapshot: snapshots.codexPromptInputSnapshot,
  });

  assert.equal(locatedOptions.length, 1);
  assert.equal(resources.summary.plugins, installedPlugins.filter((item) => item.enabled).length);
  assert.equal(resources.summary.mcpServers, mcpItems.filter((item) => item.enabled).length);
  assert.equal(resources.summary.skills, skillItems.length);
  assert.equal(resources.summary.marketplaces, marketplaceIds.length);
  assert.equal(
    resources.discovered.plugins.filter((item) => item.availability === "marketplace").length,
    availablePlugins.length,
  );
});
