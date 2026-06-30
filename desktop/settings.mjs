import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  MODEL_PRESETS,
  PROVIDERS,
  defaultSelectedModelIds,
  providerById,
} from "./presets.mjs";
import { normalizeAdapterProfile } from "../src/adapter-profile.js";
import { buildModelCatalog } from "../src/model-catalog.js";
import { proxySettingsForUrl } from "../src/proxy.js";

const require = createRequire(import.meta.url);

export {
  MODEL_PRESETS,
  PROVIDERS,
  defaultSelectedModelIds,
} from "./presets.mjs";

export const MODE_ALL_API = "all_api";
export const MODE_HYBRID = "hybrid";

const CODEX_BRIDGE_TOP_LEVEL_KEYS = new Set([
  "model_provider",
  "model",
  "model_catalog_json",
  "model_reasoning_effort",
  "model_context_window",
  "model_max_output_tokens",
  "model_auto_compact_token_limit",
  "sandbox_mode",
  "approval_policy",
  "disable_response_storage",
  "network_access",
  "openai_base_url",
  "windows_wsl_setup_acknowledged",
]);
const CODEX_BRIDGE_MANAGED_START = "# >>> CodexBridge managed config";
const CODEX_BRIDGE_MANAGED_END = "# <<< CodexBridge managed config";
const CODEX_BRIDGE_MODEL_ID_PREFIX = "cb-";
const DEFAULT_CODEX_BRIDGE_MODEL_ID = "cb-gpt-5-5";
const CODEX_BRIDGE_MODEL_CATALOG_FILENAME = "codexbridge-model-catalog.json";
const DEFAULT_CHAT_TOOL_CONTINUATION_TURNS = 5;

const CODEX_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const CODEX_SANDBOX_MODES = new Set([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
const CODEX_APPROVAL_POLICIES = new Set([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);

const LEGACY_CODEX_BRIDGE_THREAD_SOURCES = [
  "codex-bridge",
  "codexbridge",
  "codex_bridge",
  "local",
  "unknown",
];

const LEGACY_LOCAL_HISTORY_PROVIDERS = [
  "codex-multi-router",
  "codex_multi_router",
  "litellm",
  "custom",
  "deepseek",
  "kimi",
  "moonshot",
  "local",
  "unknown",
];

export function routerConfigPath(rootDir) {
  return path.join(rootDir, "config", "router.config.json");
}

export function secretsPath(rootDir) {
  return path.join(rootDir, "config", "secrets.local.json");
}

export function catalogPath(rootDir) {
  return path.join(rootDir, "model-catalog.json");
}

export function selectionPath(rootDir) {
  return path.join(rootDir, "config", "model-selection.json");
}

export function customModelsPath(rootDir) {
  return path.join(rootDir, "config", "custom-models.json");
}

export function modelCapabilitiesPath(rootDir) {
  return path.join(rootDir, "config", "model-capabilities.json");
}

export function modelDirectoryPath(rootDir) {
  return path.join(rootDir, "config", "model-directory.local.json");
}

export function providerOverridesPath(rootDir) {
  return path.join(rootDir, "config", "provider-overrides.json");
}

export function modelImageGenerationPath(rootDir) {
  return path.join(rootDir, "config", "model-image-generation.json");
}

export function desktopOptionsPath(rootDir) {
  return path.join(rootDir, "config", "desktop-options.json");
}

export function configProfilesPath(rootDir) {
  return path.join(rootDir, "config", "profiles.json");
}

export function codexConfigPath(homeDir = os.homedir()) {
  return path.join(homeDir, ".codex", "config.toml");
}

export function codexCatalogPath(homeDir = os.homedir()) {
  return path.join(homeDir, ".codex", CODEX_BRIDGE_MODEL_CATALOG_FILENAME);
}

export function exampleConfigForMode(rootDir, mode, templateRootDir = rootDir) {
  const file =
    mode === MODE_HYBRID
      ? "router.config.hybrid.example.json"
      : "router.config.example.json";
  return path.join(templateRootDir, "config", file);
}

export function ensureRouterConfig(rootDir, mode, templateRootDir = rootDir) {
  const source = exampleConfigForMode(rootDir, mode, templateRootDir);
  const target = routerConfigPath(rootDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return target;
}

export function readJsonIfExists(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeTextAtomic(target, text) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(temp, text, "utf8");
  fs.renameSync(temp, target);
}

function writeJsonAtomic(target, value) {
  writeTextAtomic(target, `${JSON.stringify(value, null, 2)}\n`);
}

export function readRouterConfig(rootDir) {
  return readJsonIfExists(routerConfigPath(rootDir), null);
}

export function detectModeFromConfig(config) {
  if (!config) {
    return MODE_HYBRID;
  }
  if (config.mode === MODE_HYBRID || config.mode === MODE_ALL_API) {
    return config.mode;
  }
  if (config?.clientAuth?.allowOpenAiBearer) {
    return MODE_HYBRID;
  }
  return MODE_ALL_API;
}

export function saveSecrets(rootDir, secrets) {
  const clean = { ...loadSecrets(rootDir) };
  for (const [key, value] of Object.entries(secrets || {})) {
    if (typeof value === "string" && value.trim()) {
      clean[key] = value.trim();
    }
  }
  const target = secretsPath(rootDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
  return clean;
}

export function loadSecrets(rootDir) {
  return readJsonIfExists(secretsPath(rootDir), {});
}

export function loadDesktopOptions(rootDir) {
  const saved = readJsonIfExists(desktopOptionsPath(rootDir), {});
  return normalizeDesktopOptions(saved);
}

export function saveDesktopOptions(rootDir, options = {}) {
  const saved = normalizeDesktopOptions({
    ...loadDesktopOptions(rootDir),
    ...(options || {}),
  });
  const target = desktopOptionsPath(rootDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(saved, null, 2)}\n`, "utf8");
  return saved;
}

export function loadConfigProfiles(rootDir) {
  const saved = readJsonIfExists(configProfilesPath(rootDir), {});
  const profiles = Array.isArray(saved?.profiles)
    ? saved.profiles
    : Array.isArray(saved)
      ? saved
      : [];
  return profiles
    .map(normalizeConfigProfile)
    .filter(Boolean)
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
}

export function saveConfigProfile(rootDir, profile = {}) {
  const normalized = normalizeConfigProfile({
    ...profile,
    updatedAt: new Date().toISOString(),
  });
  if (!normalized) {
    throw new Error("Config profile requires a name.");
  }
  const profiles = loadConfigProfiles(rootDir).filter((item) => item.id !== normalized.id);
  profiles.unshift(normalized);
  writeJsonAtomic(configProfilesPath(rootDir), {
    version: 1,
    profiles,
  });
  return normalized;
}

export function buildStartupCheck(rootDir, {
  homeDir = os.homedir(),
  appVersion = "",
  routerRunning = false,
  lastHealth = null,
  config = readRouterConfig(rootDir),
  proxyEnv = process.env,
  platform = process.platform,
} = {}) {
  const options = loadDesktopOptions(rootDir);
  const diagnostics = routerConfigDiagnostics(rootDir, config);
  const codexConfig = codexConfigPath(homeDir);
  const catalog = codexCatalogPath(homeDir);
  const backups = listCodexBackups({ homeDir });
  const proxyKeys = proxyEnvironmentKeys(proxyEnv);
  const codexLaunchTarget = options.codexDesktopLaunchTarget || options.codexDesktopExe || "";
  const items = [
    checkItem({
      id: "codex_config",
      label: "Codex 配置",
      status: fs.existsSync(codexConfig) ? "pass" : "warn",
      detail: fs.existsSync(codexConfig) ? codexConfig : "还没有找到 Codex config.toml。",
      action: "启动一次 Router 会自动写入 CodexBridge 配置。",
    }),
    checkItem({
      id: "model_catalog",
      label: "模型目录",
      status: fs.existsSync(catalog) || (Array.isArray(config?.models) && config.models.length > 0) ? "pass" : "warn",
      detail: fs.existsSync(catalog)
        ? catalog
        : `当前有 ${Array.isArray(config?.models) ? config.models.length : 0} 个模型路由可生成目录。`,
      count: Array.isArray(config?.models) ? config.models.length : 0,
      action: "启动 Router 或重新保存模型选择后会生成目录。",
    }),
    checkItem({
      id: "api_keys",
      label: "API Key",
      status: diagnostics.ok || !diagnostics.missingApiKeys.length ? "pass" : "fail",
      detail: diagnostics.missingApiKeys.length
        ? diagnostics.missingApiKeys.map((item) => `${item.displayName || item.id}: ${item.apiKeyEnv || "API Key"}`).join("; ")
        : `${diagnostics.savedApiKeyRoutes || 0}/${diagnostics.apiKeyRoutes || 0} 个 API 模型 Key 已就绪。`,
      count: diagnostics.missingApiKeys.length,
      action: "缺少 Key 的供应商需要先保存 API Key。",
    }),
    checkItem({
      id: "router",
      label: "Router",
      status: routerRunning && lastHealth?.ok ? "pass" : routerRunning ? "warn" : "warn",
      detail: routerRunning
        ? lastHealth?.ok
          ? `Router 正在 ${config?.port || options.routerPort || 15722} 端口运行，健康检查通过。`
          : lastHealth?.message || "Router 正在运行，但健康检查还没有通过。"
        : `Router 未运行，配置端口为 ${config?.port || options.routerPort || 15722}。`,
      action: routerRunning ? "查看具体模型路由健康状态。" : "点击启动 Router。",
    }),
    checkItem({
      id: "proxy",
      label: "Proxy",
      status: "pass",
      detail: proxyKeys.length
        ? `检测到 ${proxyKeys.join(", ")}；本地 Router 绕过系统代理：${options.bypassSystemProxy ? "已开启" : "未开启"}。`
        : `未检测到代理环境变量；本地 Router 绕过系统代理：${options.bypassSystemProxy ? "已开启" : "未开启"}。`,
      count: proxyKeys.length,
      action: "如果 127.0.0.1 请求被 VPN/代理截走，可以开启绕过代理。",
    }),
    checkItem({
      id: "backups",
      label: "备份",
      status: "pass",
      detail: backups.length ? `已有 ${backups.length} 个 Codex 配置备份。` : "还没有 CodexBridge 配置备份。",
      count: backups.length,
      action: "每次写入 Codex 配置前会保留备份。",
    }),
    checkItem({
      id: "codex_desktop",
      label: "Codex Desktop",
      status: codexLaunchTarget ? (fs.existsSync(codexLaunchTarget) ? "pass" : "fail") : platform === "darwin" ? "pass" : "warn",
      detail: codexLaunchTarget || (platform === "darwin" ? "macOS 通常可以从应用程序里启动 Codex。" : "还没有保存 Codex Desktop 启动路径。"),
      action: "如果重启 Codex 仍失败，可以选择 Codex.exe 或开始菜单快捷方式。",
    }),
  ];
  const summary = startupCheckSummary(items);
  return {
    version: 1,
    appVersion,
    checkedAt: new Date().toISOString(),
    summary,
    items,
  };
}

export function secretStatus(rootDir) {
  const secrets = loadSecrets(rootDir);
  const status = {};
  for (const keyEnv of knownSecretKeyEnvs(rootDir)) {
    status[keyEnv] = Boolean(secrets[keyEnv]);
  }
  return status;
}

export function secretValue(rootDir, keyEnv) {
  const allowed = knownSecretKeyEnvs(rootDir);
  if (!allowed.has(keyEnv)) {
    throw new Error(`Unknown API key env: ${keyEnv}`);
  }
  return loadSecrets(rootDir)[keyEnv] || "";
}

function knownSecretKeyEnvs(rootDir) {
  const keys = new Set(
    providerCatalog(rootDir)
      .map((provider) => provider.keyEnv)
      .filter(Boolean),
  );
  keys.add("OPENAI_API_KEY");
  for (const settings of Object.values(readModelImageGenerationOverrides(rootDir))) {
    if (settings?.apiKeyEnv) {
      keys.add(settings.apiKeyEnv);
    }
  }
  return keys;
}

export function envWithSecrets(rootDir, baseEnv = process.env) {
  return {
    ...baseEnv,
    ...loadSecrets(rootDir),
  };
}

export function routerRuntimeEnv(rootDir, baseEnv = process.env) {
  const env = envWithSecrets(rootDir, {
    ...baseEnv,
    ROUTER_CONFIG: routerConfigPath(rootDir),
    CODEXBRIDGE_SECRETS_FILE: secretsPath(rootDir),
  });
  if (loadDesktopOptions(rootDir).bypassSystemProxy) {
    env.CODEXBRIDGE_DISABLE_SYSTEM_PROXY = "1";
  }
  return env;
}

export function routerConfigDiagnostics(rootDir, config = readRouterConfig(rootDir)) {
  const routes = Array.isArray(config?.models) ? config.models : [];
  const secrets = loadSecrets(rootDir);
  const missingApiKeys = [];
  const invalidBaseUrls = [];
  let apiKeyRoutes = 0;
  let savedApiKeyRoutes = 0;
  let codexOpenAiRoutes = 0;

  for (const route of routes) {
    if (!isValidHttpUrl(route.baseUrl)) {
      invalidBaseUrls.push(routeDiagnosticItem(route));
    }

    if ((route.authMode || "api_key") === "codex_openai") {
      codexOpenAiRoutes += 1;
      continue;
    }

    apiKeyRoutes += 1;
    const apiKeyEnv = route.apiKeyEnv || route.keyEnv || "";
    const hasKey = Boolean(
      route.apiKey ||
        (apiKeyEnv && (secrets[apiKeyEnv] || process.env[apiKeyEnv])),
    );
    if (hasKey) {
      savedApiKeyRoutes += 1;
    } else {
      missingApiKeys.push({
        ...routeDiagnosticItem(route),
        apiKeyEnv,
      });
    }
  }

  return {
    ok: missingApiKeys.length === 0 && invalidBaseUrls.length === 0,
    totalRoutes: routes.length,
    apiKeyRoutes,
    savedApiKeyRoutes,
    codexOpenAiRoutes,
    missingApiKeys,
    invalidBaseUrls,
  };
}

export function supportDiagnostics(rootDir, {
  appVersion = "",
  routerRunning = false,
  lastHealth = null,
  usageSummary = null,
  updateDir = path.join(rootDir, "updates"),
  proxyEnv = process.env,
  proxySettingsOptions = {},
  config = readRouterConfig(rootDir),
  logs = [],
  platform = process.platform,
  arch = process.arch,
  release = os.release(),
  homeDir = os.homedir(),
} = {}) {
  const options = loadDesktopOptions(rootDir);
  const routeDiagnostics = routerConfigDiagnostics(rootDir, config);
  const historyDiagnostics = codexHistoryDiagnostics({ homeDir });
  const pluginDiagnostics = codexPluginRuntimeDiagnostics({ homeDir });
  const effectiveProxyEnv = proxyEnvWithDesktopOptions(proxyEnv, options);
  const secretMap = loadSecrets(rootDir);
  const selectedRoutes = Array.isArray(config?.models) ? config.models : [];
  const selectedKeyEnvs = [
    ...new Set(
      selectedRoutes
        .map((route) => route.apiKeyEnv || route.keyEnv || "")
        .filter(Boolean),
    ),
  ].sort();
  const errorLines = StringLines(logs)
    .filter((line) => /\b(error|status=4\d\d|status=5\d\d|!! upstream|compact-local-fallback|rate-limit|Health failed|Preflight)/i.test(line))
    .slice(-20)
    .map(redactSecretText);
  const toolLines = StringLines(logs)
    .filter((line) => /\btool(?:_return)?_diag\b/i.test(line))
    .slice(-20)
    .map(redactSecretText);

  const lines = [
    "CodexBridge Diagnostics",
    `version: ${appVersion || "unknown"}`,
    `platform: ${platform} ${arch} ${release}`,
    `dataRoot: ${rootDir}`,
    `routerRunning: ${Boolean(routerRunning)}`,
    `routerPort: ${config?.port || 15722}`,
    `bypassSystemProxy: ${Boolean(options.bypassSystemProxy)}`,
    `health: ${lastHealth?.ok ? "ok" : lastHealth?.message || "unknown"}`,
    `unhealthyRoutes: ${routeHealthSummary(lastHealth).unhealthyRoutes}`,
    "",
    "Selected models:",
    ...(selectedRoutes.length
      ? selectedRoutes.map(
          (route) =>
            `- ${route.id}: ${route.displayName} -> ${route.model} (${route.api}, ${route.authMode || "api_key"}) ${redactSecretText(route.baseUrl)} ${routeCapabilityDiagnosticText(route)}`,
        )
      : ["- none"]),
    "",
    "Model capability overrides:",
    ...modelCapabilityDiagnosticsLines(rootDir),
    "",
    "Provider model directory:",
    ...modelDirectoryDiagnosticsLines(rootDir),
    "",
    "Codex model catalog:",
    ...codexModelCatalogDiagnosticsLines(homeDir),
    "",
    "API keys:",
    ...(selectedKeyEnvs.length
      ? selectedKeyEnvs.map((keyEnv) => `- ${keyEnv}: ${secretMap[keyEnv] || process.env[keyEnv] ? "saved" : "missing"}`)
      : ["- none required"]),
    "",
    "Config diagnostics:",
    `- ok: ${routeDiagnostics.ok}`,
    `- missingApiKeys: ${routeDiagnostics.missingApiKeys.map((item) => `${item.displayName || item.id}:${item.apiKeyEnv || "API Key"}`).join(", ") || "none"}`,
    `- invalidBaseUrls: ${routeDiagnostics.invalidBaseUrls.map((item) => `${item.displayName || item.id}:${item.baseUrl || "(empty)"}`).join(", ") || "none"}`,
    "",
    "Router route health:",
    ...routeHealthSummary(lastHealth).lines,
    "",
    "Usage diagnostics:",
    ...usageDiagnosticsLines(usageSummary),
    "",
    "Request limits:",
    ...requestLimitDiagnosticsLines(config),
    "",
    "Proxy diagnostics:",
    ...proxyDiagnosticsLines(proxyEnv, options),
    "",
    "Effective upstream proxy:",
    ...effectiveUpstreamProxyLines(selectedRoutes, effectiveProxyEnv, proxySettingsOptions),
    "",
    "Update diagnostics:",
    ...updateDiagnosticsLines(updateDir),
    "",
    "Codex history diagnostics:",
    ...historyDiagnostics.lines,
    "",
    "Codex plugin diagnostics:",
    ...pluginDiagnostics.lines,
    "",
    "Recent tool diagnostics:",
    ...(toolLines.length ? toolLines.map((line) => `- ${line}`) : ["- none"]),
    "",
    "Recent errors:",
    ...(errorLines.length ? errorLines.map((line) => `- ${line}`) : ["- none"]),
  ];

  return {
    summary: {
      ok:
        routeDiagnostics.ok &&
        pluginDiagnostics.summary.ok &&
        routeHealthSummary(lastHealth).unhealthyRoutes === 0 &&
        Boolean(lastHealth?.ok || !routerRunning),
      missingApiKeys: routeDiagnostics.missingApiKeys,
      invalidBaseUrls: routeDiagnostics.invalidBaseUrls,
      errorCount: errorLines.length,
      toolDiagnosticCount: toolLines.length,
      unhealthyRoutes: routeHealthSummary(lastHealth).unhealthyRoutes,
      usage: usageDiagnosticsSummary(usageSummary),
      requestLimits: requestLimitDiagnosticsSummary(config),
      proxy: proxyDiagnosticsSummary(proxyEnv),
      effectiveProxyRoutes: effectiveUpstreamProxySummary(selectedRoutes, effectiveProxyEnv, proxySettingsOptions),
      update: {
        updateDir,
        updateDirExists: safeExists(updateDir),
      },
      modelCapabilityOverrides: Object.keys(readModelCapabilityOverrides(rootDir)).length,
      modelDirectory: modelDirectoryDiagnosticsSummary(rootDir),
      codexModelCatalog: codexModelCatalogDiagnosticsSummary(homeDir),
      history: historyDiagnostics.summary,
      codexPlugins: pluginDiagnostics.summary,
    },
    text: lines.join("\n"),
  };
}

function routeHealthSummary(lastHealth) {
  const routes = Array.isArray(lastHealth?.routes) ? lastHealth.routes : [];
  const unhealthyRoutes = Number.isFinite(Number(lastHealth?.unhealthyRoutes))
    ? Number(lastHealth.unhealthyRoutes)
    : routes.filter((route) => route?.status === "degraded" || route?.status === "rate_limited").length;
  return {
    unhealthyRoutes,
    lines: routes.length
      ? routes.map((route) => {
          const parts = [
            `- ${redactSecretText(route.id || route.model || "unknown")}: ${redactSecretText(route.status || "unknown")}`,
            `api=${redactSecretText(route.api || "")}`,
            `model=${redactSecretText(route.model || "")}`,
          ];
          if (route.lastStatus !== null && route.lastStatus !== undefined) {
            parts.push(`lastStatus=${Number(route.lastStatus)}`);
          }
          if (route.lastErrorType) {
            parts.push(`lastErrorType=${redactSecretText(route.lastErrorType)}`);
          }
          if (route.proxy) {
            parts.push(`proxy=${redactSecretText(route.proxy)}`);
          }
          const cooldownMs = Number(route.cooldownRemainingMs || route.rateLimit?.cooldownRemainingMs || 0);
          if (Number.isFinite(cooldownMs) && cooldownMs > 0) {
            parts.push(`cooldownMs=${Math.ceil(cooldownMs)}`);
          }
          if (route.lastError) {
            parts.push(`lastError=${redactSecretText(route.lastError).slice(0, 160)}`);
          }
          return parts.filter((part) => !part.endsWith("=")).join(" ");
        })
      : ["- no route health snapshot"],
  };
}

function usageDiagnosticsSummary(usageSummary = null) {
  return {
    totalCalls: Number(usageSummary?.totalCalls || 0),
    totalTokens: Number(usageSummary?.totalTokens || 0),
    statusCounts: usageSummary?.statusCounts || {},
    latestStatus: Number.isFinite(Number(usageSummary?.latest?.status))
      ? Number(usageSummary.latest.status)
      : null,
    latestErrorType: String(usageSummary?.latest?.errorType || ""),
  };
}

function modelCapabilityDiagnosticsLines(rootDir) {
  const overrides = readModelCapabilityOverrides(rootDir);
  const entries = Object.entries(overrides);
  if (!entries.length) {
    return ["- none"];
  }
  return entries.map(([presetId, override]) => {
    const parts = [`- ${redactSecretText(presetId)}`];
    if (override.inputModalities) {
      parts.push(`modalities=${override.inputModalities.join(",")}`);
    }
    if (override.contextWindow) {
      parts.push(`contextWindow=${override.contextWindow}`);
    }
    if (override.reasoning?.mode) {
      parts.push(`reasoning=${redactSecretText(override.reasoning.mode)}`);
    }
    if (override.updatedAt) {
      parts.push(`updatedAt=${redactSecretText(override.updatedAt)}`);
    }
    return parts.join(" ");
  });
}

function modelDirectoryDiagnosticsLines(rootDir) {
  const directory = readModelDirectory(rootDir);
  const entries = Object.values(directory.providers || {});
  if (!entries.length) {
    return ["- offline presets only"];
  }
  return entries.map((entry) =>
    `- ${redactSecretText(entry.providerId)} models=${entry.models?.length || 0} fetchedAt=${redactSecretText(entry.fetchedAt || "unknown")} baseUrl=${redactSecretText(entry.baseUrl || "")}`,
  );
}

function modelDirectoryDiagnosticsSummary(rootDir) {
  const directory = readModelDirectory(rootDir);
  const entries = Object.values(directory.providers || {});
  return {
    providerCount: entries.length,
    modelCount: entries.reduce((total, entry) => total + Number(entry.models?.length || 0), 0),
    staleProviders: entries
      .filter((entry) => modelDirectoryEntryIsStale(entry.fetchedAt))
      .map((entry) => entry.providerId),
  };
}

function codexModelCatalogDiagnostics(homeDir = os.homedir()) {
  const target = codexCatalogPath(homeDir);
  const summary = {
    path: target,
    exists: false,
    ok: false,
    models: 0,
    firstModels: [],
    error: "",
  };
  const lines = [`- path: ${toTomlPath(target)}`];

  if (!fs.existsSync(target)) {
    lines.push("- exists: false");
    return { lines, summary };
  }

  summary.exists = true;
  lines.push("- exists: true");

  try {
    const catalog = JSON.parse(fs.readFileSync(target, "utf8"));
    const models = Array.isArray(catalog?.models) ? catalog.models : [];
    summary.ok = true;
    summary.models = models.length;
    summary.firstModels = models
      .slice(0, 8)
      .map((model) => `${model.slug || model.id || "(no-id)"}:${model.display_name || model.name || "(no-name)"}`);
    lines.push("- ok: true");
    lines.push(`- models: ${summary.models}`);
    lines.push(`- firstModels: ${summary.firstModels.map(redactSecretText).join(", ") || "none"}`);
  } catch (error) {
    summary.error = redactSecretText(error?.message || error).slice(0, 200);
    lines.push("- ok: false");
    lines.push(`- error: ${summary.error}`);
  }

  return { lines, summary };
}

function codexModelCatalogDiagnosticsLines(homeDir = os.homedir()) {
  return codexModelCatalogDiagnostics(homeDir).lines;
}

function codexModelCatalogDiagnosticsSummary(homeDir = os.homedir()) {
  return codexModelCatalogDiagnostics(homeDir).summary;
}

function modelDirectoryEntryIsStale(fetchedAt) {
  const date = new Date(fetchedAt || "");
  if (Number.isNaN(date.getTime())) {
    return true;
  }
  return Date.now() - date.getTime() > 7 * 24 * 60 * 60 * 1000;
}

function usageDiagnosticsLines(usageSummary = null) {
  if (!usageSummary) {
    return ["- no usage summary"];
  }
  const lines = [
    `- totalCalls: ${Number(usageSummary.totalCalls || 0)}`,
    `- totalTokens: ${Number(usageSummary.totalTokens || 0)}`,
    `- statusCounts: ${formatStatusCounts(usageSummary.statusCounts)}`,
  ];
  const latest = usageSummary.latest;
  if (latest) {
    lines.push(
      `- latest: ${redactSecretText(latest.route || latest.codexModel || latest.upstreamModel || "unknown")} ` +
        `status=${Number.isFinite(Number(latest.status)) ? Number(latest.status) : "unknown"} ` +
        `errorType=${redactSecretText(latest.errorType || "")}` +
        (latest.error ? ` error=${redactSecretText(latest.error).slice(0, 160)}` : ""),
    );
  } else {
    lines.push("- latest: none");
  }
  const byModel = Array.isArray(usageSummary.byModel) ? usageSummary.byModel.slice(0, 5) : [];
  if (byModel.length) {
    lines.push("- byModel:");
    for (const item of byModel) {
      lines.push(
        `  - ${redactSecretText(item.route || item.codexModel || item.upstreamModel || "unknown")} ` +
          `calls=${Number(item.calls || 0)} errors=${Number(item.errors || 0)} ` +
          `lastStatus=${Number.isFinite(Number(item.lastStatus)) ? Number(item.lastStatus) : "unknown"} ` +
          `lastErrorType=${redactSecretText(item.lastErrorType || "")} ` +
          `totalTokens=${Number(item.totalTokens || 0)}`,
      );
    }
  }
  return lines;
}

function requestLimitDiagnosticsSummary(config = {}) {
  const configuredRequestLimit = configuredRequestLimitBytes(config, "requestBodyLimitBytes");
  const configuredResponsesLimit = configuredRequestLimitBytes(config, "responsesRequestBodyLimitBytes");
  const requestBodyLimitBytes = configuredRequestLimit || 25 * 1024 * 1024;
  return {
    requestBodyLimitBytes,
    responsesRequestBodyLimitBytes: configuredResponsesLimit || configuredRequestLimit || 100 * 1024 * 1024,
  };
}

function requestLimitDiagnosticsLines(config = {}) {
  const summary = requestLimitDiagnosticsSummary(config);
  return [
    `- requestBodyLimitBytes: ${formatBytes(summary.requestBodyLimitBytes)}`,
    `- responsesRequestBodyLimitBytes: ${formatBytes(summary.responsesRequestBodyLimitBytes)}`,
  ];
}

function configuredRequestLimitBytes(config = {}, camelKey) {
  const snakeKey = camelKey.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
  const value = Number(config?.[camelKey] ?? config?.[snakeKey] ?? 0);
  if (Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return 0;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "unknown";
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

function proxyDiagnosticsSummary(proxyEnv = {}) {
  const summary = {};
  for (const key of proxyDiagnosticKeys()) {
    summary[key] = proxyEnvValue(proxyEnv, key) ? "set" : "unset";
  }
  return summary;
}

function proxyDiagnosticsLines(proxyEnv = {}, options = {}) {
  const lines = [`- bypassSystemProxy: ${Boolean(options.bypassSystemProxy)}`];
  for (const key of proxyDiagnosticKeys()) {
    const value = proxyEnvValue(proxyEnv, key);
    lines.push(`- ${key}: ${value ? `set ${redactProxyValue(value)}` : "unset"}`);
  }
  return lines;
}

function proxyEnvWithDesktopOptions(proxyEnv = {}, options = {}) {
  if (!options.bypassSystemProxy) {
    return proxyEnv;
  }
  return {
    ...proxyEnv,
    CODEXBRIDGE_DISABLE_SYSTEM_PROXY: "1",
  };
}

function effectiveUpstreamProxyLines(routes = [], proxyEnv = {}, proxySettingsOptions = {}) {
  if (!routes.length) {
    return ["- no selected routes"];
  }
  return routes.slice(0, 12).map((route) => {
    const proxy = proxySettingsForUrl(route.baseUrl || "", proxyEnv, proxySettingsOptions);
    const label = proxy?.url
      ? `${proxy.source}:${redactProxyValue(proxy.url).replace(/\/$/, "")}`
      : "direct";
    return `- ${redactSecretText(route.id || route.model || "unknown")}: ${label}`;
  });
}

function effectiveUpstreamProxySummary(routes = [], proxyEnv = {}, proxySettingsOptions = {}) {
  let direct = 0;
  let proxied = 0;
  for (const route of routes) {
    if (proxySettingsForUrl(route.baseUrl || "", proxyEnv, proxySettingsOptions)?.url) {
      proxied += 1;
    } else {
      direct += 1;
    }
  }
  return { direct, proxied };
}

function updateDiagnosticsLines(updateDir) {
  return [
    `- updateDir: ${redactSecretText(updateDir || "")}`,
    `- updateDirExists: ${safeExists(updateDir)}`,
  ];
}

function formatStatusCounts(statusCounts = {}) {
  const entries = Object.entries(statusCounts || {})
    .map(([status, count]) => `${redactSecretText(status)}=${Number(count || 0)}`)
    .sort();
  return entries.join(", ") || "none";
}

function proxyDiagnosticKeys() {
  return ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"];
}

function proxyEnvValue(proxyEnv = {}, key) {
  return proxyEnv[key] || proxyEnv[key.toLowerCase()] || "";
}

function redactProxyValue(value) {
  const text = String(value || "");
  if (!text) {
    return "";
  }
  try {
    const url = new URL(text);
    url.username = "";
    url.password = "";
    return redactSecretText(url.toString().replace("://@", "://"));
  } catch {
    return redactSecretText(text.replace(/\/\/[^/@\s]+@/g, "//"));
  }
}

function safeExists(targetPath) {
  try {
    return Boolean(targetPath && fs.existsSync(targetPath));
  } catch {
    return false;
  }
}

function codexPluginRuntimeDiagnostics({ homeDir = os.homedir() } = {}) {
  const configPath = codexConfigPath(homeDir);
  const summary = {
    ok: true,
    reason: "",
    configPath,
    plugins: {},
    nodeRepl: {},
    skyRuntime: {},
    notifyHooks: [],
  };

  if (!fs.existsSync(configPath)) {
    summary.reason = "config_missing";
    return {
      summary,
      lines: ["- config.toml not found"],
    };
  }

  let content;
  try {
    content = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    summary.ok = false;
    summary.reason = "config_unreadable";
    return {
      summary,
      lines: [`- config.toml unreadable: ${redactSecretText(error.message)}`],
    };
  }

  const pluginIds = ["browser", "chrome", "computer-use"];
  const enabledPlugins = new Set();
  const pluginLines = [];
  const nodeReplCommand = readTomlStringInTable(content, "mcp_servers.node_repl", "command");
  const nodeReplEnv = {
    CODEX_CLI_PATH: readTomlStringInTable(content, "mcp_servers.node_repl.env", "CODEX_CLI_PATH"),
    NODE_REPL_NODE_PATH: readTomlStringInTable(content, "mcp_servers.node_repl.env", "NODE_REPL_NODE_PATH"),
    NODE_REPL_NODE_MODULE_DIRS: readTomlStringInTable(content, "mcp_servers.node_repl.env", "NODE_REPL_NODE_MODULE_DIRS"),
  };
  const resourceDirs = codexResourceDirsFromConfig({ nodeReplCommand, codexCliPath: nodeReplEnv.CODEX_CLI_PATH });

  for (const pluginId of pluginIds) {
    const tableName = `plugins."${pluginId}@openai-bundled"`;
    const tableExists = hasTomlTable(content, tableName);
    const enabled = tableExists ? readTomlBooleanInTable(content, tableName, "enabled") !== false : false;
    if (enabled) {
      enabledPlugins.add(pluginId);
    }
    const cachedVersions = openAiBundledCachedPluginVersions(homeDir, pluginId);
    const cached = latestVersion(cachedVersions);
    const bundled = latestVersion(resourceDirs.map((resourceDir) => bundledOpenAiPluginVersion(resourceDir, pluginId)).filter(Boolean));
    const stale = Boolean(cached && bundled && compareVersionStrings(cached, bundled) < 0);
    const pluginSummary = {
      enabled,
      cached,
      bundled,
      stale,
    };
    summary.plugins[pluginId] = pluginSummary;
    if (stale && enabled) {
      summary.ok = false;
      summary.reason ||= "stale_openai_bundled_plugin_cache";
    }
    if (enabled || cached || bundled) {
      pluginLines.push(
        `- ${pluginId}: enabled=${enabled}, cached=${cached || "missing"}, bundled=${bundled || "missing"}, stale=${stale}`,
      );
    }
  }

  const nodeReplExists = Boolean(nodeReplCommand && fs.existsSync(nodeReplCommand));
  const nodePathExists = Boolean(nodeReplEnv.NODE_REPL_NODE_PATH && fs.existsSync(nodeReplEnv.NODE_REPL_NODE_PATH));
  const moduleDirs = splitPathList(nodeReplEnv.NODE_REPL_NODE_MODULE_DIRS);
  const moduleDirExists = moduleDirs.some((dir) => fs.existsSync(dir));
  const codexCliExists = Boolean(nodeReplEnv.CODEX_CLI_PATH && fs.existsSync(nodeReplEnv.CODEX_CLI_PATH));
  summary.nodeRepl = {
    command: nodeReplCommand || "",
    commandExists: nodeReplExists,
    nodePathExists,
    moduleDirExists,
    codexCliExists,
  };

  const nativePluginEnabled = enabledPlugins.size > 0;
  if (nativePluginEnabled && (!nodeReplExists || !nodePathExists || !moduleDirExists || !codexCliExists)) {
    summary.ok = false;
    summary.reason ||= "node_repl_runtime_missing";
  }

  const skyRuntime = findSkyRuntime(moduleDirs);
  summary.skyRuntime = skyRuntime;
  if (nativePluginEnabled && !skyRuntime.ok) {
    summary.ok = false;
    summary.reason ||= "sky_runtime_missing";
  }

  const notifyHooks = readTopLevelTomlArrayStrings(content, "notify")
    .filter((value) => looksLikeExecutablePath(value))
    .map((value) => ({
      path: value,
      exists: fs.existsSync(value),
    }));
  summary.notifyHooks = notifyHooks;
  const missingNotifyHooks = notifyHooks.filter((item) => !item.exists);
  if (missingNotifyHooks.length) {
    summary.ok = false;
    summary.reason ||= "notify_hook_missing";
  }

  const lines = [
    ...pluginLines,
    `- node_repl command: ${nodeReplExists ? "ok" : nodeReplCommand ? "missing" : "not configured"}${nodeReplCommand ? ` ${redactSecretText(nodeReplCommand)}` : ""}`,
    `- node_repl env: node=${nodePathExists ? "ok" : nodeReplEnv.NODE_REPL_NODE_PATH ? "missing" : "not configured"}, modules=${moduleDirExists ? "ok" : nodeReplEnv.NODE_REPL_NODE_MODULE_DIRS ? "missing" : "not configured"}, codex=${codexCliExists ? "ok" : nodeReplEnv.CODEX_CLI_PATH ? "missing" : "not configured"}`,
    `- sky runtime: ${skyRuntime.ok ? `ok ${redactSecretText(skyRuntime.kind)}` : `missing${skyRuntime.kind ? ` ${redactSecretText(skyRuntime.kind)}` : ""}`}`,
    ...(notifyHooks.length
      ? notifyHooks.map((item) => `- notify hook: ${item.exists ? "ok" : "missing"} ${redactSecretText(item.path)}`)
      : ["- notify hook: not configured"]),
  ];

  return { summary, lines };
}

function codexHistoryDiagnostics({ homeDir = os.homedir() } = {}) {
  const summary = {
    ok: true,
    reason: "",
    databases: [],
  };
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch (error) {
    summary.ok = false;
    summary.reason = "node_sqlite_unavailable";
    return {
      summary,
      lines: [`- unavailable: node:sqlite ${redactSecretText(error.message)}`],
    };
  }

  const codexDir = path.join(homeDir, ".codex");
  if (!fs.existsSync(codexDir)) {
    summary.reason = "codex_dir_missing";
    return {
      summary,
      lines: ["- no .codex directory found"],
    };
  }

  const dbPaths = codexStateDatabasePaths(codexDir);
  if (!dbPaths.length) {
    summary.reason = "state_db_missing";
    return {
      summary,
      lines: ["- no state*.sqlite database found"],
    };
  }

  const lines = [];
  for (const dbPath of dbPaths) {
    const item = summarizeCodexHistoryDatabase(DatabaseSync, dbPath);
    summary.databases.push(item);
    if (!item.ok) {
      summary.ok = false;
      lines.push(`- ${path.basename(dbPath)}: error=${redactSecretText(item.error)}`);
      continue;
    }
    lines.push(
      `- ${path.basename(dbPath)}: threads=${item.totalThreads}, hiddenCandidates=${item.hiddenCandidates}, ` +
        `legacyProvider=${item.legacyProvider}, legacyLocalProvider=${item.legacyLocalProvider}, ` +
        `legacySource=${item.legacySource}, archived=${item.archived}, ` +
        `missingUserEvent=${item.missingUserEvent}, backups=${item.backups}, hiddenBackupRefs=${item.hiddenBackupReferenced}`,
    );
    if (item.providerGroups.length) {
      lines.push(`  providers: ${formatCountGroups(item.providerGroups)}`);
    }
    if (item.sourceGroups.length) {
      lines.push(`  sources: ${formatCountGroups(item.sourceGroups)}`);
    }
    if (item.threadSourceGroups.length) {
      lines.push(`  threadSources: ${formatCountGroups(item.threadSourceGroups)}`);
    }
    if (item.recentThreads.length) {
      lines.push("  recentThreads:");
      for (const row of item.recentThreads) {
        lines.push(
          `  - ${row.id} provider=${row.model_provider} source=${row.source} threadSource=${row.thread_source} ` +
            `archived=${row.archived} hasUserEvent=${row.has_user_event}`,
        );
      }
    }
  }

  return { summary, lines };
}

export function listCodexResources({ rootDir = process.cwd(), homeDir = os.homedir() } = {}) {
  const configPath = codexConfigPath(homeDir);
  const content = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const configuredMcpServers = parseMcpServers(content);
  const mcpServers = configuredMcpServers.filter((item) => item.enabled);
  const configuredPlugins = parseCodexPlugins(content);
  const enabledPlugins = configuredPlugins.filter((item) => item.enabled);
  const disabledPlugins = configuredPlugins
    .filter((item) => !item.enabled)
    .map((item) => ({ ...item, availability: "disabled" }));
  const cachedPlugins = listCodexPluginCache(homeDir);
  const visibleCachedPlugins = cachedPlugins
    .filter(isCodexVisibleInstalledPlugin)
    .map((plugin) => ({ ...plugin, availability: "enabled" }));
  const visibleConfiguredPlugins = enabledPlugins
    .filter(isCodexVisibleConfiguredPlugin)
    .map((plugin) => ({
      ...cachedPlugins.find((cached) => sameResourceId(cached.id, plugin.id)),
      ...plugin,
      availability: "enabled",
    }));
  const plugins = uniqueResourceItems([
    ...visibleCachedPlugins,
    ...visibleConfiguredPlugins,
  ], (item) => item.id);
  const visiblePluginIds = new Set(plugins.map((item) => normalizedResourceId(item.id)));
  const internalEnabledPlugins = enabledPlugins
    .filter(isCodexInternalPlugin)
    .map((plugin) => ({
      ...cachedPlugins.find((cached) => sameResourceId(cached.id, plugin.id)),
      ...plugin,
      availability: "internal",
    }));
  const cachedOnlyPlugins = cachedPlugins
    .filter((plugin) => !visiblePluginIds.has(normalizedResourceId(plugin.id)))
    .filter((plugin) => !isCodexVisibleInstalledPlugin(plugin))
    .map((plugin) => ({ ...plugin, availability: "cached" }));
  const skills = uniqueResourceItems([
    ...listCodexSkillFiles(homeDir),
  ], (item) => `${item.source}:${item.pluginId || ""}:${item.name}`);
  const discovered = {
    mcpServers: configuredMcpServers
      .filter((item) => !item.enabled)
      .map((item) => ({ ...item, availability: "disabled" })),
    plugins: uniqueResourceItems([
      ...disabledPlugins,
      ...internalEnabledPlugins,
      ...cachedOnlyPlugins,
    ], (item) => item.id),
    skills: uniqueResourceItems(
      [
        ...listAgentSkillFiles(homeDir).map((item) => ({ ...item, availability: "local" })),
        ...listPluginSkillFiles(homeDir, { pluginIds: visiblePluginIds, availability: "plugin" }),
        ...listPluginSkillFiles(homeDir, { excludePluginIds: visiblePluginIds, availability: "cached" }),
      ],
      (item) => `${item.source}:${item.pluginId || ""}:${item.name}`,
    ),
    prompts: [],
    agentFiles: [],
  };
  const prompts = uniqueResourceItems([
    ...listCodexPromptFiles(homeDir),
    ...listProjectPromptFiles(rootDir),
  ], (item) => item.path);
  const agentFiles = listAgentInstructionFiles(rootDir, homeDir);
  return {
    version: 1,
    configPath,
    summary: resourceCountSummary({ mcpServers, plugins, skills, prompts, agentFiles }),
    discoveredSummary: resourceCountSummary(discovered),
    mcpServers,
    plugins,
    skills,
    prompts,
    agentFiles,
    discovered,
  };
}

export function listCodexSessions({ homeDir = os.homedir(), limit = 80 } = {}) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    return [];
  }
  const codexDir = path.join(homeDir, ".codex");
  if (!fs.existsSync(codexDir)) {
    return [];
  }
  const workspaceState = readCodexWorkspaceState(homeDir);
  const requestedLimit = Number(limit || 50);
  const rowLimit = Math.min(Math.max(requestedLimit * 6, 200), 1000);
  let sessions = listCodexThreadCatalogSessions(codexDir, DatabaseSync, rowLimit, workspaceState);
  if (!sessions.length) {
    sessions = listCodexStateSessions(codexDir, DatabaseSync, rowLimit, workspaceState);
  }
  const seen = new Set();
  const output = [];
  for (const session of sessions
    .filter(isUserFacingSession)
    .sort((left, right) => right.sortAt - left.sortAt || right.id.localeCompare(left.id))) {
    const key = session.id.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(session);
    if (output.length >= requestedLimit) {
      break;
    }
  }
  return output;
}

function listCodexThreadCatalogSessions(codexDir, DatabaseSync, rowLimit, workspaceState) {
  const dbPath = path.join(codexDir, "sqlite", "codex-dev.db");
  if (!fs.existsSync(dbPath)) {
    return [];
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 1500");
    if (!hasTable(db, "local_thread_catalog")) {
      return [];
    }
    const columns = tableColumns(db, "local_thread_catalog");
    const selectColumns = [
      "thread_id AS id",
      columns.includes("display_title") ? "display_title AS title" : "thread_id AS title",
      columns.includes("model_provider") ? "model_provider" : "'' AS model_provider",
      "'' AS model",
      columns.includes("source_kind") ? "source_kind AS source" : "'' AS source",
      "'user' AS thread_source",
      "'' AS project",
      columns.includes("cwd") ? "cwd AS project_path" : "'' AS project_path",
      "0 AS archived",
      "1 AS has_user_event",
      "'' AS first_user_message",
      columns.includes("source_updated_at") ? "source_updated_at AS session_sort_at" : "0 AS session_sort_at",
    ].join(", ");
    const where = columns.includes("missing_candidate") ? " WHERE COALESCE(missing_candidate, 0) = 0" : "";
    const order = columns.includes("source_updated_at") ? " ORDER BY source_updated_at DESC, thread_id DESC" : " ORDER BY thread_id DESC";
    return db
      .prepare(`SELECT ${selectColumns} FROM local_thread_catalog${where}${order} LIMIT ?`)
      .all(rowLimit)
      .map((row) => classifySessionWorkspace(normalizeSessionRow(row, dbPath), workspaceState));
  } catch {
    return [];
  } finally {
    if (db) {
      db.close();
    }
  }
}

function listCodexStateSessions(codexDir, DatabaseSync, rowLimit, workspaceState) {
  const sessions = [];
  for (const dbPath of codexStateDatabasePaths(codexDir)) {
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec("PRAGMA busy_timeout = 1500");
      if (!hasTable(db, "threads")) {
        continue;
      }
      const columns = tableColumns(db, "threads");
      const selectColumns = [
        "id",
        columns.includes("title") ? "title" : "'' AS title",
        columns.includes("model_provider") ? "model_provider" : "'' AS model_provider",
        columns.includes("model") ? "model" : "'' AS model",
        columns.includes("source") ? "source" : "'' AS source",
        columns.includes("thread_source") ? "thread_source" : "'' AS thread_source",
        columns.includes("project") ? "project" : "'' AS project",
        sessionProjectPathSelect(columns),
        columns.includes("archived") ? "archived" : "0 AS archived",
        columns.includes("has_user_event") ? "has_user_event" : "0 AS has_user_event",
        columns.includes("first_user_message") ? "first_user_message" : "'' AS first_user_message",
        sessionSortSelect(columns),
      ].join(", ");
      const rows = db
        .prepare(`SELECT ${selectColumns} FROM threads${sessionOrderClause(columns)} LIMIT ?`)
        .all(rowLimit);
      for (const row of rows) {
        sessions.push(classifySessionWorkspace(normalizeSessionRow(row, dbPath), workspaceState));
      }
    } catch {
      // Ignore unreadable Codex history databases in the lightweight list.
    } finally {
      if (db) {
        db.close();
      }
    }
  }
  return sessions;
}

export function exportCodexSessionMarkdown(sessionId, { homeDir = os.homedir() } = {}) {
  const targetId = String(sessionId || "").trim();
  if (!targetId) {
    throw new Error("Session id is required.");
  }
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch (error) {
    throw new Error(`Codex session export unavailable: ${error.message}`);
  }
  const codexDir = path.join(homeDir, ".codex");
  const workspaceState = readCodexWorkspaceState(homeDir);
  for (const dbPath of fs.existsSync(codexDir) ? codexStateDatabasePaths(codexDir) : []) {
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec("PRAGMA busy_timeout = 1500");
      if (!hasTable(db, "threads")) {
        continue;
      }
      const columns = tableColumns(db, "threads");
      const row = selectSessionRow(db, columns, targetId);
      if (!row) {
        continue;
      }
      const session = classifySessionWorkspace(normalizeSessionRow(row, dbPath), workspaceState);
      const markdown = codexSessionMarkdown(session);
      return {
        session,
        databasePath: dbPath,
        markdown,
      };
    } finally {
      if (db) {
        db.close();
      }
    }
  }
  throw new Error("Codex session not found.");
}

function parseMcpServers(content) {
  return directTomlTables(content, "mcp_servers")
    .map(({ tableName, parts }) => {
      const name = parts[1] || "";
      return {
        name,
        tableName,
        command: readTomlStringInTable(content, tableName, "command") || "",
        enabled: readTomlBooleanInTable(content, tableName, "enabled") !== false,
        configured: true,
      };
    })
    .filter((item) => item.name);
}

function parseCodexPlugins(content) {
  return directTomlTables(content, "plugins")
    .map(({ tableName, parts }) => {
      const id = parts[1] || "";
      const enabled = readTomlBooleanInTable(content, tableName, "enabled") !== false;
      return {
        id,
        tableName,
        enabled,
        source: "config",
        availability: enabled ? "enabled" : "disabled",
      };
    })
    .filter((item) => item.id);
}

function listCodexSkillFiles(homeDir) {
  const skillRoot = path.join(homeDir, ".codex", "skills");
  return listSkillFilesFromRoot(skillRoot, "codex");
}

function listAgentSkillFiles(homeDir) {
  const skillRoot = path.join(homeDir, ".agents", "skills");
  return listSkillFilesFromRoot(skillRoot, "agents");
}

function listPluginSkillFiles(homeDir, { pluginIds = null, excludePluginIds = null, availability = "" } = {}) {
  const output = [];
  for (const plugin of listCodexPluginCache(homeDir)) {
    const pluginId = normalizedResourceId(plugin.id);
    if (pluginIds && !pluginIds.has(pluginId)) {
      continue;
    }
    if (excludePluginIds && excludePluginIds.has(pluginId)) {
      continue;
    }
    output.push(...listSkillFilesFromRoot(path.join(plugin.path, "skills"), "plugin", plugin.id, availability));
  }
  return output.sort((left, right) => left.name.localeCompare(right.name));
}

function listSkillFilesFromRoot(skillRoot, source, pluginId = "", availability = "enabled") {
  if (!fs.existsSync(skillRoot)) {
    return [];
  }
  return safeReadDir(skillRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const skillPath = path.join(skillRoot, entry.name, "SKILL.md");
      return {
        name: entry.name,
        path: skillPath,
        source,
        pluginId,
        availability,
        exists: fs.existsSync(skillPath),
      };
    })
    .filter((item) => item.exists)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function listCodexPromptFiles(homeDir) {
  const promptRoot = path.join(homeDir, ".codex", "prompts");
  return listPromptFilesFromRoot(promptRoot, "codex");
}

function listProjectPromptFiles(rootDir) {
  return listPromptFilesFromRoot(path.join(rootDir, ".codex", "prompts"), "project");
}

function listPromptFilesFromRoot(promptRoot, source) {
  if (!fs.existsSync(promptRoot)) {
    return [];
  }
  return safeReadDir(promptRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(md|txt|prompt)$/i.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: path.join(promptRoot, entry.name),
      source,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function listCodexPluginCache(homeDir) {
  const cacheRoot = path.join(homeDir, ".codex", "plugins", "cache");
  if (!fs.existsSync(cacheRoot)) {
    return [];
  }
  const output = [];
  for (const sourceEntry of safeReadDir(cacheRoot, { withFileTypes: true })) {
    if (!sourceEntry.isDirectory()) {
      continue;
    }
    const sourceRoot = path.join(cacheRoot, sourceEntry.name);
    for (const pluginEntry of safeReadDir(sourceRoot, { withFileTypes: true })) {
      if (!pluginEntry.isDirectory()) {
        continue;
      }
      const pluginRoot = path.join(sourceRoot, pluginEntry.name);
      const versionDirs = safeReadDir(pluginRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
      for (const versionEntry of versionDirs.length ? versionDirs : [{ name: "", isDirectory: () => true }]) {
        const pluginPath = versionEntry.name ? path.join(pluginRoot, versionEntry.name) : pluginRoot;
        if (!fs.existsSync(pluginPath)) {
          continue;
        }
        const manifest = readPluginManifest(pluginPath);
        output.push({
          id: `${pluginEntry.name}@${sourceEntry.name}`,
          name: pluginDisplayName(manifest, pluginEntry.name),
          version: versionEntry.name || pluginCacheVersion(pluginPath, manifest),
          source: "cache",
          pluginSource: sourceEntry.name,
          path: pluginPath,
        });
      }
    }
  }
  return output.sort((left, right) => left.id.localeCompare(right.id));
}

function readPluginManifest(pluginPath) {
  const candidates = [
    path.join(pluginPath, ".codex-plugin", "plugin.json"),
    path.join(pluginPath, ".claude-plugin", "plugin.json"),
    path.join(pluginPath, "plugin.json"),
    path.join(pluginPath, ".codex-plugin.json"),
    path.join(pluginPath, "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      return JSON.parse(fs.readFileSync(candidate, "utf8"));
    } catch {
      // Ignore malformed plugin metadata in the lightweight resource list.
    }
  }
  return null;
}

function pluginDisplayName(manifest, fallback = "") {
  const candidates = [
    manifest?.displayName,
    manifest?.display_name,
    manifest?.title,
    manifest?.name,
    fallback,
  ];
  return String(candidates.find((item) => String(item || "").trim()) || fallback || "");
}

function pluginCacheVersion(pluginPath, manifest = null) {
  if (manifest?.version) {
    return String(manifest.version);
  }
  const parsed = manifest || readPluginManifest(pluginPath);
  if (parsed?.version) {
    return String(parsed.version);
  }
  return "";
}

function resourceCountSummary(resources = {}) {
  return {
    mcpServers: Array.isArray(resources.mcpServers) ? resources.mcpServers.length : 0,
    plugins: Array.isArray(resources.plugins) ? resources.plugins.length : 0,
    skills: Array.isArray(resources.skills) ? resources.skills.length : 0,
    prompts: Array.isArray(resources.prompts) ? resources.prompts.length : 0,
    agentFiles: Array.isArray(resources.agentFiles) ? resources.agentFiles.length : 0,
  };
}

function normalizedResourceId(value) {
  return String(value || "").trim().toLowerCase();
}

function sameResourceId(left, right) {
  return normalizedResourceId(left) === normalizedResourceId(right);
}

function pluginSourceFromId(id = "") {
  const parts = String(id || "").split("@");
  return parts.length > 1 ? parts[parts.length - 1] : "";
}

function isCodexInternalPlugin(plugin = {}) {
  return plugin.pluginSource === "openai-bundled" || pluginSourceFromId(plugin.id) === "openai-bundled";
}

function isCodexVisibleInstalledPlugin(plugin = {}) {
  return plugin.pluginSource === "openai-curated-remote";
}

function isCodexVisibleConfiguredPlugin(plugin = {}) {
  const source = pluginSourceFromId(plugin.id);
  return source === "personal";
}

function uniqueResourceItems(items, keyFn) {
  const seen = new Set();
  const output = [];
  for (const item of items || []) {
    const rawKey = keyFn(item);
    const key = process.platform === "win32"
      ? String(rawKey || "").toLowerCase()
      : String(rawKey || "");
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(item);
  }
  return output;
}

function listAgentInstructionFiles(rootDir, homeDir) {
  const candidates = [
    path.join(rootDir, "AGENTS.md"),
    path.join(rootDir, ".codex", "AGENTS.md"),
    path.join(homeDir, ".codex", "AGENTS.md"),
  ];
  const seen = new Set();
  const output = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key) || !fs.existsSync(resolved)) {
      continue;
    }
    seen.add(key);
    output.push({
      name: path.basename(resolved),
      path: resolved,
    });
  }
  return output;
}

function normalizeSessionRow(row = {}, databasePath = "") {
  const workspacePath = normalizeStoredProjectPath(row.project_path || "");
  return {
    id: String(row.id || ""),
    title: String(row.title || row.id || "Untitled session"),
    modelProvider: String(row.model_provider || ""),
    model: String(row.model || ""),
    source: String(row.source || ""),
    threadSource: String(row.thread_source || ""),
    project: String(row.project || projectNameFromPath(workspacePath)),
    projectPath: workspacePath,
    workspacePath,
    archived: Number(row.archived || 0) !== 0,
    hasUserEvent: Number(row.has_user_event || 0) !== 0,
    firstUserMessage: String(row.first_user_message || ""),
    sortAt: normalizeSessionSortValue(row.session_sort_at),
    databasePath,
  };
}

function readCodexWorkspaceState(homeDir) {
  const statePath = path.join(homeDir, ".codex", ".codex-global-state.json");
  if (!fs.existsSync(statePath)) {
    return emptyCodexWorkspaceState();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const savedRoots = Array.isArray(parsed?.["electron-saved-workspace-roots"])
      ? parsed["electron-saved-workspace-roots"]
      : [];
    const activeRoots = Array.isArray(parsed?.["active-workspace-roots"])
      ? parsed["active-workspace-roots"]
      : [];
    const roots = savedRoots.length ? savedRoots : activeRoots;
    return {
      workspaceRoots: uniqueWorkspaceRoots(roots),
      projectlessThreadIds: new Set(
        (Array.isArray(parsed?.["projectless-thread-ids"]) ? parsed["projectless-thread-ids"] : [])
          .map((item) => String(item || "").toLowerCase())
          .filter(Boolean),
      ),
    };
  } catch {
    return emptyCodexWorkspaceState();
  }
}

function emptyCodexWorkspaceState() {
  return {
    workspaceRoots: [],
    projectlessThreadIds: new Set(),
  };
}

function uniqueWorkspaceRoots(roots = []) {
  const seen = new Set();
  const output = [];
  for (const root of roots) {
    const clean = normalizeStoredProjectPath(root);
    const key = canonicalProjectRootKey(clean);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push({
      path: clean,
      key,
    });
  }
  return output.sort((left, right) => right.key.length - left.key.length);
}

function classifySessionWorkspace(session = {}, workspaceState = emptyCodexWorkspaceState()) {
  const workspacePath = normalizeStoredProjectPath(session.workspacePath || session.projectPath || "");
  const id = String(session.id || "").toLowerCase();
  if (!workspacePath) {
    return {
      ...session,
      project: "",
      projectPath: "",
      workspacePath: "",
    };
  }
  if (workspaceState.projectlessThreadIds?.has(id)) {
    return {
      ...session,
      project: "",
      projectPath: "",
      workspacePath,
    };
  }
  const projectRoot = matchingWorkspaceRoot(workspacePath, workspaceState.workspaceRoots || []);
  if (projectRoot) {
    return {
      ...session,
      project: projectNameFromPath(projectRoot.path),
      projectPath: projectRoot.path,
      workspacePath,
    };
  }
  if (!workspaceState.workspaceRoots?.length) {
    return {
      ...session,
      project: String(session.project || projectNameFromPath(workspacePath)),
      projectPath: workspacePath,
      workspacePath,
    };
  }
  return {
    ...session,
    project: "",
    projectPath: "",
    workspacePath,
  };
}

function matchingWorkspaceRoot(workspacePath, workspaceRoots = []) {
  const workspaceKey = canonicalProjectRootKey(workspacePath);
  if (!workspaceKey) {
    return null;
  }
  return workspaceRoots.find((root) => workspaceKey === root.key || workspaceKey.startsWith(`${root.key}/`)) || null;
}

function canonicalProjectRootKey(projectPath = "") {
  const clean = normalizeStoredProjectPath(projectPath)
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  return process.platform === "win32" ? clean.toLowerCase() : clean;
}

function sessionProjectPathSelect(columns = []) {
  const candidates = ["project_path", "cwd", "working_directory", "workspace", "workspace_path", "root_dir"];
  const column = candidates.find((item) => columns.includes(item));
  return column ? `${column} AS project_path` : "'' AS project_path";
}

function sessionSortSelect(columns = []) {
  const column = sessionSortColumn(columns);
  return column ? `${quoteIdentifier(column)} AS session_sort_at` : "0 AS session_sort_at";
}

function sessionOrderClause(columns = []) {
  const column = sessionSortColumn(columns);
  return column
    ? ` ORDER BY ${quoteIdentifier(column)} DESC, id DESC`
    : " ORDER BY id DESC";
}

function sessionSortColumn(columns = []) {
  return [
    "recency_at_ms",
    "updated_at_ms",
    "last_active_at_ms",
    "last_message_at_ms",
    "created_at_ms",
    "recency_at",
    "updated_at",
    "last_active_at",
    "last_message_at",
    "created_at",
  ].find((item) => columns.includes(item));
}

function normalizeSessionSortValue(value) {
  if (value === null || value === undefined || value === "") {
    return 0;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isUserFacingSession(session = {}) {
  if (!session.id || session.archived) {
    return false;
  }
  const threadSource = String(session.threadSource || "").trim().toLowerCase();
  if (threadSource === "subagent") {
    return false;
  }
  if (threadSource && threadSource !== "user") {
    return false;
  }
  const source = String(session.source || "").trim();
  if (source.startsWith("{\"subagent\"") || source.includes("\"thread_spawn\"")) {
    return false;
  }
  return true;
}

function normalizeStoredProjectPath(projectPath = "") {
  return String(projectPath || "").replace(/^\\\\\?\\/, "").trim();
}

function projectNameFromPath(projectPath = "") {
  const clean = normalizeStoredProjectPath(projectPath).replace(/[\\/]+$/, "");
  if (!clean) {
    return "";
  }
  return path.basename(clean);
}

function selectSessionRow(db, columns, sessionId) {
  const selectColumns = [
    "id",
    columns.includes("title") ? "title" : "'' AS title",
    columns.includes("model_provider") ? "model_provider" : "'' AS model_provider",
    columns.includes("model") ? "model" : "'' AS model",
    columns.includes("source") ? "source" : "'' AS source",
    columns.includes("thread_source") ? "thread_source" : "'' AS thread_source",
    columns.includes("project") ? "project" : "'' AS project",
    sessionProjectPathSelect(columns),
    columns.includes("archived") ? "archived" : "0 AS archived",
    columns.includes("has_user_event") ? "has_user_event" : "0 AS has_user_event",
    columns.includes("first_user_message") ? "first_user_message" : "'' AS first_user_message",
  ].join(", ");
  return db.prepare(`SELECT ${selectColumns} FROM threads WHERE id = ?`).get(sessionId);
}

function codexSessionMarkdown(session) {
  const lines = [
    `# ${session.title || session.id}`,
    "",
    `- Thread ID: ${session.id}`,
    `- Provider: ${session.modelProvider || "-"}`,
    `- Model: ${session.model || "-"}`,
    `- Source: ${session.source || "-"}`,
    `- Project: ${session.project || "-"}`,
    `- Project path: ${session.projectPath || "-"}`,
    `- Workspace path: ${session.workspacePath || "-"}`,
    `- Archived: ${session.archived ? "yes" : "no"}`,
    "",
  ];
  if (session.firstUserMessage) {
    lines.push("## First User Message", "", session.firstUserMessage, "");
  }
  lines.push("## Notes", "", "Exported by CodexBridge. Full event replay depends on Codex local history storage.");
  return `${lines.join("\n")}\n`;
}

function tomlTableNames(content) {
  return String(content || "")
    .split(/\r?\n/)
    .map(tomlHeaderName)
    .filter(Boolean);
}

function directTomlTables(content, rootName) {
  return tomlTableNames(content)
    .map((tableName) => ({
      tableName,
      parts: tomlPathParts(tableName),
    }))
    .filter((item) => item.parts.length === 2 && item.parts[0] === rootName);
}

function tomlPathParts(value) {
  const parts = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const char of String(value || "")) {
    if (quote) {
      current += char;
      if (quote === '"' && char === "\\" && !escaped) {
        escaped = true;
        continue;
      }
      if (char === quote && !escaped) {
        quote = "";
      }
      escaped = false;
      continue;
    }
    if (char === "." && !quote) {
      parts.push(unquoteTomlString(current.trim()));
      current = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    }
    current += char;
  }
  if (current.trim()) {
    parts.push(unquoteTomlString(current.trim()));
  }
  return parts;
}

function unquoteTomlPathPart(value) {
  return String(value || "")
    .split(".")
    .map((part) => unquoteTomlString(part.trim()))
    .join(".");
}

function safeReadDir(target, options) {
  try {
    return fs.readdirSync(target, options);
  } catch {
    return [];
  }
}

function summarizeCodexHistoryDatabase(DatabaseSync, dbPath) {
  const item = {
    path: dbPath,
    ok: true,
    totalThreads: 0,
    hiddenCandidates: 0,
    legacyProvider: 0,
    legacyLocalProvider: 0,
    legacySource: 0,
    archived: 0,
    missingUserEvent: 0,
    backups: 0,
    hiddenBackupReferenced: 0,
    providerGroups: [],
    sourceGroups: [],
    threadSourceGroups: [],
    recentThreads: [],
  };
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 1500");
    if (!hasTable(db, "threads")) {
      return {
        ...item,
        ok: false,
        error: "threads table missing",
      };
    }
    const columns = tableColumns(db, "threads");
    item.totalThreads = sqliteCount(db, "SELECT COUNT(*) AS count FROM threads");
    item.backups = codexStateMergeSourcePaths(dbPath).length;
    item.hiddenBackupReferenced = countHiddenBackupReferencedThreads(DatabaseSync, dbPath);
    if (columns.includes("model_provider")) {
      item.legacyProvider = sqliteCount(
        db,
        "SELECT COUNT(*) AS count FROM threads WHERE model_provider = ?",
        "codex-bridge",
      );
      item.legacyLocalProvider = sqliteCount(
        db,
        `SELECT COUNT(*) AS count FROM threads WHERE LOWER(model_provider) IN (${legacyLocalProviderSqlList()})`,
      );
      item.providerGroups = sqliteGroupedCounts(db, "threads", "model_provider");
    }
    if (columns.includes("source")) {
      item.sourceGroups = sqliteGroupedCounts(db, "threads", "source");
    }
    if (columns.includes("thread_source")) {
      item.threadSourceGroups = sqliteGroupedCounts(db, "threads", "thread_source");
    }
    if (columns.includes("model_provider") && columns.includes("source")) {
      item.legacySource = sqliteCount(
        db,
        "SELECT COUNT(*) AS count FROM threads " +
          "WHERE model_provider = ? " +
          `AND LOWER(source) IN (${legacyThreadSourceSqlList()})`,
        "openai",
      );
    }
    if (columns.includes("archived")) {
      item.archived = sqliteCount(db, "SELECT COUNT(*) AS count FROM threads WHERE archived != 0");
    }
    if (columns.includes("has_user_event")) {
      item.missingUserEvent = sqliteCount(db, "SELECT COUNT(*) AS count FROM threads WHERE has_user_event = 0");
    }
    const predicate = visibilityIssuePredicate(columns);
    if (predicate) {
      item.hiddenCandidates = sqliteCount(db, `SELECT COUNT(*) AS count FROM threads WHERE ${predicate}`);
    }
    item.recentThreads = recentThreadDiagnostics(db, columns);
    return item;
  } catch (error) {
    return {
      ...item,
      ok: false,
      error: error.message,
    };
  } finally {
    if (db) {
      db.close();
    }
  }
}

function sqliteCount(db, sql, ...params) {
  return Number(db.prepare(sql).get(...params).count || 0);
}

function sqliteGroupedCounts(db, tableName, columnName) {
  return db
    .prepare(
      `SELECT COALESCE(NULLIF(CAST(${quoteIdentifier(columnName)} AS TEXT), ''), '(empty)') AS key, ` +
        `COUNT(*) AS count FROM ${quoteIdentifier(tableName)} ` +
        "GROUP BY key ORDER BY count DESC, key ASC LIMIT 8",
    )
    .all()
    .map((row) => ({
      key: redactSecretText(row.key),
      count: Number(row.count || 0),
    }));
}

function recentThreadDiagnostics(db, columns) {
  const selectedColumns = [
    "id",
    "model_provider",
    "source",
    "thread_source",
    "archived",
    "has_user_event",
  ].filter((column) => columns.includes(column));
  if (!selectedColumns.includes("id")) {
    return [];
  }
  const orderColumn = ["updated_at", "created_at", "last_active_at", "last_message_at"]
    .find((column) => columns.includes(column));
  const orderClause = orderColumn ? ` ORDER BY ${quoteIdentifier(orderColumn)} DESC` : " ORDER BY rowid DESC";
  try {
    return db
      .prepare(`SELECT ${selectedColumns.map(quoteIdentifier).join(", ")} FROM threads${orderClause} LIMIT 5`)
      .all()
      .map(normalizeRecentThreadDiagnostic);
  } catch {
    return db
      .prepare(`SELECT ${selectedColumns.map(quoteIdentifier).join(", ")} FROM threads LIMIT 5`)
      .all()
      .map(normalizeRecentThreadDiagnostic);
  }
}

function normalizeRecentThreadDiagnostic(row) {
  return {
    id: redactSecretText(row.id || "(empty)"),
    model_provider: redactSecretText(row.model_provider || "(missing)"),
    source: redactSecretText(row.source || "(missing)"),
    thread_source: redactSecretText(row.thread_source || "(missing)"),
    archived: row.archived ?? "(missing)",
    has_user_event: row.has_user_event ?? "(missing)",
  };
}

function formatCountGroups(groups) {
  return groups.map((group) => `${group.key}=${group.count}`).join(", ") || "none";
}

export function readProviderOverrides(rootDir) {
  const saved = readJsonIfExists(providerOverridesPath(rootDir), {});
  const source = saved?.providers && typeof saved.providers === "object"
    ? saved.providers
    : saved;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return {};
  }
  const overrides = {};
  for (const [providerId, value] of Object.entries(source)) {
    const normalized = normalizeProviderOverride(value);
    if (normalized) {
      overrides[providerId] = normalized;
    }
  }
  return overrides;
}

export function saveProviderOverride(rootDir, providerId, input = {}) {
  const id = String(providerId || input?.id || "").trim();
  if (!id) {
    throw new Error("Provider id is required.");
  }
  const overrides = readProviderOverrides(rootDir);
  const saved = normalizeProviderOverride({
    ...overrides[id],
    ...input,
    id,
  });
  if (!saved) {
    throw new Error("Provider settings are empty.");
  }
  saved.id = id;
  saved.updatedAt = new Date().toISOString();
  overrides[id] = saved;
  writeJsonAtomic(providerOverridesPath(rootDir), {
    version: 1,
    providers: overrides,
  });
  refreshRouterConfigIfPresent(rootDir);
  return saved;
}

export function saveProviderLogo(rootDir, ownerId, sourcePath) {
  const id = slugify(String(ownerId || "provider").trim()) || "provider";
  const source = String(sourcePath || "").trim();
  if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error("Logo file does not exist.");
  }
  const extension = providerLogoExtension(source);
  const targetDir = path.join(rootDir, "config", "provider-logos");
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, `${id}${extension}`);
  if (path.resolve(source) !== path.resolve(target)) {
    fs.copyFileSync(source, target);
  }
  return {
    path: target,
    logoUrl: pathToFileURL(target).href,
  };
}

export function providerCatalog(rootDir) {
  const overrides = readProviderOverrides(rootDir);
  const customProviders = new Map();
  const builtInProviderIds = new Set(PROVIDERS.map((provider) => provider.id));
  for (const model of readCustomModels(rootDir)) {
    if (!model.providerId || !model.keyEnv) {
      continue;
    }
    if (builtInProviderIds.has(model.providerId)) {
      continue;
    }
    if (!customProviders.has(model.providerId)) {
      customProviders.set(model.providerId, {
        id: model.providerId,
        name: model.providerName || model.providerId,
        shortName: model.providerName || "Custom",
        keyEnv: model.keyEnv,
        keyLabel: `${model.providerName || "Custom"} API Key`,
        keyUrl: model.keyUrl || "",
        docsUrl: model.docsUrl || "",
        baseUrl: model.baseUrl,
        api: model.api || "chat_completions",
        logoUrl: model.logoUrl || "",
        authMode: model.authMode || "api_key",
        description: "用户自定义 OpenAI-compatible Provider。",
        custom: true,
      });
    }
  }
  return [...PROVIDERS, ...customProviders.values()]
    .map((provider) => applyProviderOverride(provider, overrides[provider.id]));
}

export function modelCatalog(rootDir) {
  const providers = providerCatalog(rootDir);
  const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
  const imageInputOverrides = readModelImageInputOverrides(rootDir);
  const capabilityOverrides = readModelCapabilityOverrides(rootDir);
  return [...effectiveBuiltInModels(rootDir, providers), ...readCustomModels(rootDir)]
    .map((model) => applyProviderSettingsToModel(model, providerMap.get(model.providerId)))
    .map((model) => modelWithDefaultCapabilities(model))
    .map((model) => applyModelImageInputOverride(model, imageInputOverrides))
    .map((model) => applyModelCapabilityOverride(model, capabilityOverrides))
    .map((model) => withCapabilityStatus(model));
}

function effectiveBuiltInModels(rootDir, providers = providerCatalog(rootDir)) {
  const directory = readModelDirectory(rootDir);
  const providersById = new Map(providers.map((provider) => [provider.id, provider]));
  const presetsByProvider = new Map();
  for (const model of MODEL_PRESETS) {
    const list = presetsByProvider.get(model.providerId) || [];
    list.push(model);
    presetsByProvider.set(model.providerId, list);
  }
  const usedPresetIds = new Set(MODEL_PRESETS.map((model) => model.presetId));
  const models = [];
  for (const [providerId, presets] of presetsByProvider.entries()) {
    const provider = providersById.get(providerId);
    const entry = directory.providers?.[providerId];
    if (!provider || !entry || (provider.authMode || "api_key") === "codex_openai") {
      models.push(...presets);
      continue;
    }
    models.push(...modelsForProviderDirectoryEntry(provider, entry, presets, usedPresetIds));
  }
  return models;
}

function modelsForProviderDirectoryEntry(provider, entry, presets, usedPresetIds) {
  const providerId = provider.id;
  const exactTemplates = new Map(
    presets.map((model) => [providerModelKey(providerId, model.model), model]),
  );
  const fallbackTemplate = presets[0] || providerDefaultModelTemplate(providerId);
  const models = [];
  for (const remoteModel of entry.models || []) {
    const upstreamModel = String(remoteModel?.id || "").trim();
    if (!upstreamModel) {
      continue;
    }
    const exact = exactTemplates.get(providerModelKey(providerId, upstreamModel));
    const presetId = exact?.presetId || uniqueSyncedPresetId(
      `${providerId}-${slugify(upstreamModel)}`,
      usedPresetIds,
    );
    usedPresetIds.add(presetId);
    const dropParams = exact?.dropParams || fallbackTemplate?.dropParams || [];
    models.push({
      ...(exact || {}),
      presetId,
      providerId,
      providerName: provider.name || entry.providerName || providerId,
      displayName: exact?.displayName || `${provider.shortName || provider.name || providerId} ${upstreamModel}`,
      description: exact?.description || `${upstreamModel} synced from ${provider.name || providerId}.`,
      api: provider.api || exact?.api || fallbackTemplate?.api || "chat_completions",
      baseUrl: provider.baseUrl || entry.baseUrl || fallbackTemplate?.baseUrl || "",
      model: upstreamModel,
      authMode: provider.authMode || "api_key",
      apiKeyEnv: provider.keyEnv || undefined,
      keyEnv: provider.keyEnv || undefined,
      keyUrl: provider.keyUrl || "",
      docsUrl: provider.docsUrl || "",
      logoUrl: provider.logoUrl || "",
      contextWindow: Number(remoteModel?.contextWindow || exact?.contextWindow || fallbackTemplate?.contextWindow || 258400),
      ...(Array.isArray(exact?.inputModalities)
        ? { inputModalities: [...exact.inputModalities] }
        : exact ? {} : { inputModalities: ["text"] }),
      ...(Array.isArray(dropParams) && dropParams.length ? { dropParams: [...dropParams] } : {}),
      synced: true,
      custom: false,
    });
  }
  return models;
}

function applyProviderSettingsToModel(model, provider) {
  if (!provider) {
    return model;
  }
  const next = {
    ...model,
    providerName: provider.name || model.providerName || model.providerId,
    keyUrl: provider.keyUrl ?? model.keyUrl,
    docsUrl: provider.docsUrl ?? model.docsUrl,
    logoUrl: provider.logoUrl ?? model.logoUrl,
  };
  if ((next.authMode || provider.authMode || "api_key") !== "codex_openai") {
    if (provider.baseUrl) {
      next.baseUrl = provider.baseUrl;
    }
    if (provider.api && !model.custom) {
      next.api = provider.api;
    }
  }
  if (provider.keyEnv) {
    next.keyEnv = provider.keyEnv;
    next.apiKeyEnv = provider.keyEnv;
  }
  if (provider.authMode) {
    next.authMode = provider.authMode;
  }
  return next;
}

function normalizeProviderOverride(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const result = {};
  for (const key of ["id", "name", "shortName", "baseUrl", "keyUrl", "docsUrl", "keyEnv", "keyLabel", "logoUrl"]) {
    if (typeof input[key] === "string") {
      const value = input[key].trim();
      if (value) {
        result[key] = key === "baseUrl" ? value.replace(/\/+$/, "") : value;
      }
    }
  }
  if (input.api === "responses" || input.api === "chat_completions") {
    result.api = input.api;
  }
  if (input.authMode === "codex_openai" || input.authMode === "api_key") {
    result.authMode = input.authMode;
  }
  if (typeof input.custom === "boolean") {
    result.custom = input.custom;
  }
  if (typeof input.updatedAt === "string" && input.updatedAt.trim()) {
    result.updatedAt = input.updatedAt.trim();
  }
  return Object.keys(result).length ? result : null;
}

function applyProviderOverride(provider, override) {
  if (!override) {
    return { ...provider };
  }
  return {
    ...provider,
    ...override,
    id: provider.id,
    custom: Boolean(provider.custom),
  };
}

function syncedProviderModels(rootDir) {
  const directory = readModelDirectory(rootDir);
  const providers = providerCatalog(rootDir);
  const builtinUpstreamKeys = new Set(
    MODEL_PRESETS.map((model) => providerModelKey(model.providerId, model.model)),
  );
  const usedPresetIds = new Set(MODEL_PRESETS.map((model) => model.presetId));
  const synced = [];

  for (const [providerId, entry] of Object.entries(directory.providers || {})) {
    const provider = providers.find((item) => item.id === providerId);
    if (!provider || (provider.authMode || "api_key") === "codex_openai") {
      continue;
    }
    const template = providerDefaultModelTemplate(providerId);
    for (const remoteModel of entry.models || []) {
      const upstreamModel = String(remoteModel?.id || "").trim();
      if (!upstreamModel || builtinUpstreamKeys.has(providerModelKey(providerId, upstreamModel))) {
        continue;
      }
      const presetId = uniqueSyncedPresetId(
        `${providerId}-${slugify(upstreamModel)}`,
        usedPresetIds,
      );
      usedPresetIds.add(presetId);
      synced.push({
        presetId,
        providerId,
        providerName: provider.name || entry.providerName || providerId,
        displayName: `${provider.shortName || provider.name || providerId} ${upstreamModel}`,
        description: `${upstreamModel} synced from ${provider.name || providerId}.`,
        api: template?.api || "chat_completions",
        baseUrl: entry.baseUrl || provider.baseUrl,
        model: upstreamModel,
        authMode: provider.authMode || "api_key",
        apiKeyEnv: provider.keyEnv || undefined,
        keyEnv: provider.keyEnv || undefined,
        keyUrl: provider.keyUrl || "",
        docsUrl: provider.docsUrl || "",
        contextWindow: template?.contextWindow || 258400,
        inputModalities: ["text"],
        ...(Array.isArray(template?.dropParams) ? { dropParams: [...template.dropParams] } : {}),
        synced: true,
        custom: false,
      });
    }
  }

  return synced;
}

function providerModelKey(providerId, upstreamModel) {
  return `${String(providerId || "").toLowerCase()}\u0000${String(upstreamModel || "").toLowerCase()}`;
}

function providerDefaultModelTemplate(providerId) {
  return MODEL_PRESETS.find((model) => model.providerId === providerId);
}

function uniqueSyncedPresetId(base, usedPresetIds) {
  let candidate = `remote-${base}`;
  let suffix = 2;
  while (usedPresetIds.has(candidate)) {
    candidate = `remote-${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export function readSelection(rootDir, mode = MODE_HYBRID) {
  const saved = readJsonIfExists(selectionPath(rootDir), null);
  if (Array.isArray(saved?.selectedModelIds)) {
    return normalizeSelection(rootDir, saved.selectedModelIds, mode);
  }
  return defaultSelectedModelIds(mode);
}

export function saveSelection(rootDir, selectedModelIds, mode = MODE_HYBRID) {
  const normalized = normalizeSelection(rootDir, selectedModelIds, mode);
  const target = selectionPath(rootDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    `${JSON.stringify({ selectedModelIds: normalized }, null, 2)}\n`,
    "utf8",
  );
  return normalized;
}

export function readCustomModels(rootDir) {
  const saved = readJsonIfExists(customModelsPath(rootDir), []);
  return Array.isArray(saved) ? saved.map(normalizeSavedCustomModel) : [];
}

export function readModelImageInputOverrides(rootDir) {
  const saved = readModelCapabilitiesFile(rootDir);
  return imageInputOverridesFromCapabilities(saved);
}

function imageInputOverridesFromCapabilities(saved) {
  const source = saved?.imageInput && typeof saved.imageInput === "object"
    ? saved.imageInput
    : saved;
  const legacyFormat = Number(saved?.version || 0) < 2;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return {};
  }
  const overrides = {};
  for (const [presetId, enabled] of Object.entries(source)) {
    if (typeof enabled === "boolean") {
      if (legacyFormat && enabled === false && builtInVisionPresetIds().has(presetId)) {
        continue;
      }
      overrides[presetId] = enabled;
    }
  }
  return overrides;
}

export function readModelCapabilityOverrides(rootDir) {
  const saved = readModelCapabilitiesFile(rootDir);
  const source = saved?.overrides && typeof saved.overrides === "object"
    ? saved.overrides
    : saved?.capabilityOverrides && typeof saved.capabilityOverrides === "object"
      ? saved.capabilityOverrides
      : {};
  const overrides = {};
  for (const [presetId, value] of Object.entries(source || {})) {
    const normalized = normalizeModelCapabilityOverride(value, { keepUpdatedAt: true });
    if (normalized) {
      overrides[presetId] = normalized;
    }
  }
  return overrides;
}

export function saveModelImageInputOverride(rootDir, presetId, enabled) {
  const id = String(presetId || "").trim();
  if (!id) {
    throw new Error("Model id is required.");
  }
  const imageInput = readModelImageInputOverrides(rootDir);
  const capabilityOverrides = readModelCapabilityOverrides(rootDir);
  imageInput[id] = Boolean(enabled);
  if (Array.isArray(capabilityOverrides[id]?.inputModalities)) {
    capabilityOverrides[id] = {
      ...capabilityOverrides[id],
      inputModalities: toggleInputModality(
        capabilityOverrides[id].inputModalities,
        "image",
        Boolean(enabled),
      ),
      updatedAt: new Date().toISOString(),
    };
  }
  writeModelCapabilities(rootDir, { imageInput, overrides: capabilityOverrides });
  return { presetId: id, imageInput: imageInput[id] };
}

export function saveModelCapabilityOverride(rootDir, presetId, override = {}, options = {}) {
  const id = String(presetId || "").trim();
  if (!id) {
    throw new Error("Model id is required.");
  }
  const normalized = normalizeModelCapabilityOverride(override);
  if (!normalized) {
    throw new Error("At least one model capability override is required.");
  }
  const imageInput = readModelImageInputOverrides(rootDir);
  const overrides = readModelCapabilityOverrides(rootDir);
  const updatedAt = typeof options.now === "function"
    ? String(options.now())
    : new Date().toISOString();
  const saved = {
    ...normalized,
    updatedAt,
  };
  overrides[id] = saved;
  if (Array.isArray(saved.inputModalities)) {
    imageInput[id] = saved.inputModalities.includes("image");
  }
  writeModelCapabilities(rootDir, { imageInput, overrides });
  refreshRouterConfigIfPresent(rootDir);
  return saved;
}

export function resetModelCapabilityOverride(rootDir, presetId) {
  const id = String(presetId || "").trim();
  if (!id) {
    throw new Error("Model id is required.");
  }
  const imageInput = readModelImageInputOverrides(rootDir);
  const overrides = readModelCapabilityOverrides(rootDir);
  delete overrides[id];
  writeModelCapabilities(rootDir, { imageInput, overrides });
  refreshRouterConfigIfPresent(rootDir);
  return { presetId: id, reset: true };
}

export function readModelDirectory(rootDir) {
  return normalizeModelDirectory(readJsonIfExists(modelDirectoryPath(rootDir), {}));
}

export async function refreshProviderModelDirectory(rootDir, providerId, {
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
} = {}) {
  const id = String(providerId || "").trim();
  const provider = providerCatalog(rootDir).find((item) => item.id === id);
  const existing = readModelDirectory(rootDir).providers[id] || null;
  if (!provider) {
    return modelDirectoryRefreshFailure(id, `Unknown provider: ${id}`, existing);
  }
  if ((provider.authMode || "api_key") === "codex_openai") {
    return modelDirectoryRefreshFailure(id, "Codex subscription providers use offline presets.", existing);
  }
  if (typeof fetchImpl !== "function") {
    return modelDirectoryRefreshFailure(id, "fetch is not available in this runtime", existing);
  }
  const endpoint = modelDirectoryEndpointForProvider(provider);
  if (!endpoint) {
    return modelDirectoryRefreshFailure(id, "Provider does not expose a model directory endpoint.", existing);
  }
  const keyEnv = provider.keyEnv || provider.apiKeyEnv || "";
  const apiKey = keyEnv ? (loadSecrets(rootDir)[keyEnv] || process.env[keyEnv] || "") : "";
  if (providerRequiresApiKey(provider) && !apiKey) {
    return modelDirectoryRefreshFailure(id, `Missing API key: ${keyEnv}`, existing);
  }

  try {
    const headers = { Accept: "application/json" };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers,
    });
    if (!response?.ok) {
      const text = typeof response?.text === "function" ? await response.text() : "";
      throw new Error(`HTTP ${response?.status || 0}${text ? ` ${String(text).slice(0, 160)}` : ""}`);
    }
    const body = typeof response.json === "function" ? await response.json() : {};
    const models = normalizeProviderModelList(body);
    const directory = readModelDirectory(rootDir);
    const entry = {
      providerId: id,
      providerName: provider.name || id,
      baseUrl: String(provider.baseUrl || "").trim().replace(/\/+$/, ""),
      endpoint,
      source: "remote",
      fetchedAt: String(now()),
      models,
    };
    directory.providers[id] = entry;
    writeJsonAtomic(modelDirectoryPath(rootDir), directory);
    return {
      ok: true,
      ...entry,
      count: models.length,
    };
  } catch (error) {
    return modelDirectoryRefreshFailure(id, error.message || String(error), existing);
  }
}

export async function testProviderConnection(rootDir, providerInput, {
  fetchImpl = globalThis.fetch,
} = {}) {
  const provider = resolveConnectionProvider(rootDir, providerInput);
  const providerId = provider?.id || String(providerInput || "").trim();
  if (!provider) {
    return {
      ok: false,
      providerId,
      error: `Unknown provider: ${providerId}`,
    };
  }
  if ((provider.authMode || "api_key") === "codex_openai") {
    return {
      ok: false,
      providerId: provider.id,
      error: "Codex subscription providers do not expose an API-key model endpoint.",
    };
  }
  if (typeof fetchImpl !== "function") {
    return {
      ok: false,
      providerId: provider.id,
      error: "fetch is not available in this runtime",
    };
  }
  const endpoint = modelDirectoryEndpointForProvider(provider);
  if (!endpoint) {
    return {
      ok: false,
      providerId: provider.id,
      error: "Provider Base URL is invalid.",
    };
  }
  const keyEnv = provider.keyEnv || provider.apiKeyEnv || "";
  const apiKey = String(
    provider.apiKey ||
      (keyEnv ? (loadSecrets(rootDir)[keyEnv] || process.env[keyEnv] || "") : ""),
  ).trim();
  if (providerRequiresApiKey(provider) && !apiKey) {
    return {
      ok: false,
      providerId: provider.id,
      endpoint,
      error: `Missing API key: ${keyEnv}`,
    };
  }
  const headers = { Accept: "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  try {
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers,
    });
    const ok = Boolean(response?.ok);
    const status = Number(response?.status || 0);
    let body = "";
    if (!ok && typeof response?.text === "function") {
      body = await response.text();
    }
    return {
      ok,
      providerId: provider.id,
      endpoint,
      status,
      message: ok ? "Connection OK" : `HTTP ${status || 0}${body ? ` ${String(body).slice(0, 160)}` : ""}`,
      ...(ok ? {} : { error: `HTTP ${status || 0}${body ? ` ${String(body).slice(0, 160)}` : ""}` }),
    };
  } catch (error) {
    return {
      ok: false,
      providerId: provider.id,
      endpoint,
      error: error.message || String(error),
    };
  }
}

function resolveConnectionProvider(rootDir, providerInput) {
  const providers = providerCatalog(rootDir);
  if (typeof providerInput === "string") {
    return providers.find((provider) => provider.id === providerInput) || null;
  }
  if (!providerInput || typeof providerInput !== "object" || Array.isArray(providerInput)) {
    return null;
  }
  const id = String(providerInput.providerId || providerInput.id || "").trim();
  const base = providers.find((provider) => provider.id === id) || {
    id,
    name: providerInput.name || providerInput.shortName || id,
    shortName: providerInput.shortName || providerInput.name || id,
    authMode: "api_key",
  };
  if (!id) {
    return null;
  }
  return {
    ...base,
    ...normalizeProviderOverride({
      ...providerInput,
      id,
    }),
    apiKey: typeof providerInput.apiKey === "string" ? providerInput.apiKey.trim() : "",
  };
}

export function readModelImageGenerationOverrides(rootDir) {
  const saved = readJsonIfExists(modelImageGenerationPath(rootDir), {});
  const source = saved?.imageGeneration && typeof saved.imageGeneration === "object"
    ? saved.imageGeneration
    : saved;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return {};
  }
  const overrides = {};
  for (const [presetId, value] of Object.entries(source)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    try {
      overrides[presetId] = normalizeImageGenerationSettings(value);
    } catch {
      // Ignore invalid legacy entries instead of blocking the app startup.
    }
  }
  return overrides;
}

export function saveModelImageGenerationOverride(rootDir, presetId, settings) {
  const id = String(presetId || "").trim();
  if (!id) {
    throw new Error("Model id is required.");
  }
  const overrides = readModelImageGenerationOverrides(rootDir);
  overrides[id] = normalizeImageGenerationSettings(settings);
  const target = modelImageGenerationPath(rootDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    `${JSON.stringify({ version: 1, imageGeneration: overrides }, null, 2)}\n`,
    "utf8",
  );
  return { presetId: id, imageGeneration: overrides[id] };
}

export function saveCustomModel(rootDir, input) {
  const existingModels = readCustomModels(rootDir);
  const existing = input?.presetId
    ? existingModels.find((item) => item.presetId === input.presetId)
    : null;
  const model = normalizeCustomModel({
    ...input,
    keyEnv: input?.keyEnv || existing?.keyEnv || existing?.apiKeyEnv,
    inputModalities: input?.inputModalities || existing?.inputModalities,
    docsUrl: input?.docsUrl ?? existing?.docsUrl,
    logoUrl: input?.logoUrl ?? existing?.logoUrl,
    contextWindow: input?.contextWindow || existing?.contextWindow,
  });
  const models = existingModels.filter(
    (item) => item.presetId !== model.presetId,
  );
  models.push(model);
  writeCustomModels(rootDir, models);
  refreshRouterConfigIfPresent(rootDir);
  return model;
}

export function removeCustomModel(rootDir, presetId) {
  const models = readCustomModels(rootDir).filter(
    (model) => model.presetId !== presetId,
  );
  writeCustomModels(rootDir, models);
  const selection = readSelection(rootDir).filter((id) => id !== presetId);
  saveSelection(rootDir, selection.length ? selection : defaultSelectedModelIds(MODE_HYBRID));
  refreshRouterConfigIfPresent(rootDir);
  return models;
}

export function writeRouterConfigFromSelection(rootDir, mode = MODE_HYBRID) {
  const config = buildRouterConfigFromSelection(rootDir, mode);
  const target = routerConfigPath(rootDir);
  writeJsonAtomic(target, config);
  return config;
}

function refreshRouterConfigIfPresent(rootDir) {
  const current = readRouterConfig(rootDir);
  if (!current) {
    return null;
  }
  return writeRouterConfigFromSelection(rootDir, detectModeFromConfig(current));
}

export function buildRouterConfigFromSelection(rootDir, mode = MODE_HYBRID) {
  const selectedModelIds = readSelection(rootDir, mode);
  const models = modelCatalog(rootDir);
  const desktopOptions = loadDesktopOptions(rootDir);
  const selected = selectedModelIds.map((id) => {
    const model = models.find((item) => item.presetId === id);
    if (!model) {
      throw new Error(`Selected model is not available: ${id}`);
    }
    return model;
  });
  if (selected.length === 0) {
    throw new Error("Please select at least one model.");
  }
  if (
    mode === MODE_ALL_API &&
    selected.some((model) => model.authMode === "codex_openai")
  ) {
    throw new Error("全部 API 模式不能选择“GPT 订阅”模型，请改选 API 模型或切换到混合模式。");
  }

  const imageGenerationOverrides = readModelImageGenerationOverrides(rootDir);
  const routes = selected.map((model, index) =>
    routeForSelectedModel(model, index, imageGenerationOverrides),
  );

  return {
    mode,
    host: "127.0.0.1",
    port: desktopOptions.routerPort,
    authToken: "sk-local-codex-router",
    clientAuth: {
      allowOpenAiBearer: true,
    },
    defaultModel: routes[0].id,
    catalog: {
      contextWindow: 258400,
      effectiveContextWindowPercent: 95,
      autoCompactPercent: 80,
    },
    models: routes,
  };
}

export function prepareRouterStartConfig({
  rootDir,
  mode = MODE_HYBRID,
  homeDir = os.homedir(),
} = {}) {
  if (!rootDir) {
    throw new Error("rootDir is required.");
  }
  const config = writeRouterConfigFromSelection(rootDir, mode);
  const codex = applyCodexConfig({
    rootDir,
    mode,
    port: config.port || 15722,
    model: config.defaultModel,
    homeDir,
  });
  return { config, codex };
}

export function buildCodexToml({
  rootDir,
  port = 15722,
  model = DEFAULT_CODEX_BRIDGE_MODEL_ID,
  reasoningEffort = "medium",
  sandboxMode = "danger-full-access",
  approvalPolicy = "never",
  homeDir = os.homedir(),
}) {
  const modelCatalogJson = toTomlString(toTomlPath(codexCatalogPath(homeDir)));
  return [
    CODEX_BRIDGE_MANAGED_START,
    'model_provider = "openai"',
    `model = "${model}"`,
    `model_catalog_json = ${modelCatalogJson}`,
    `model_reasoning_effort = "${reasoningEffort}"`,
    `sandbox_mode = "${sandboxMode}"`,
    `approval_policy = "${approvalPolicy}"`,
    "disable_response_storage = false",
    'network_access = "enabled"',
    `openai_base_url = "http://127.0.0.1:${port}/v1"`,
    "windows_wsl_setup_acknowledged = true",
    CODEX_BRIDGE_MANAGED_END,
    "",
  ].join("\n");
}

function writeCodexVisibleModelCatalog({ rootDir, mode = MODE_HYBRID, homeDir = os.homedir() }) {
  const config = readRouterConfig(rootDir) || buildRouterConfigFromSelection(rootDir, mode);
  const target = codexCatalogPath(homeDir);
  writeJsonAtomic(target, buildModelCatalog(config));
  return target;
}

export function applyCodexConfig({
  rootDir,
  mode,
  port = 15722,
  model = null,
  homeDir = os.homedir(),
  validateWrittenConfig = validateCodexBridgeWrittenConfig,
}) {
  const target = codexConfigPath(homeDir);
  const targetDir = path.dirname(target);
  fs.mkdirSync(targetDir, { recursive: true });
  const modelCatalogTarget = writeCodexVisibleModelCatalog({
    rootDir,
    mode: mode || MODE_HYBRID,
    homeDir,
  });
  const existingContent = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  const currentSettings = currentCodexModelSettings(existingContent);
  const bridgeContent = buildCodexToml({
    rootDir,
    mode,
    port,
    homeDir,
    ...currentSettings,
    model: model || currentSettings.model || DEFAULT_CODEX_BRIDGE_MODEL_ID,
  });
  const content = mergeCodexBridgeConfig(existingContent, bridgeContent);

  if (fs.existsSync(target) && existingContent === content) {
    const historySync = syncCodexBridgeConversationProviders({ homeDir });
    return { target, backup: null, unchanged: true, modelCatalog: modelCatalogTarget, historySync };
  }

  let backup = null;
  if (fs.existsSync(target)) {
    backup = `${target}.codexbridge.${timestamp()}.bak`;
    fs.copyFileSync(target, backup);
  }

  try {
    fs.writeFileSync(target, content, "utf8");
    validateWrittenConfig({ target, content, rootDir, mode, port });
  } catch (error) {
    if (backup && fs.existsSync(backup)) {
      fs.copyFileSync(backup, target);
    } else {
      fs.writeFileSync(target, existingContent, "utf8");
    }
    throw error;
  }
  const historySync = syncCodexBridgeConversationProviders({ homeDir });
  return { target, backup, unchanged: false, modelCatalog: modelCatalogTarget, historySync };
}

export function restoreCodexConfig({ homeDir = os.homedir() } = {}) {
  const target = codexConfigPath(homeDir);
  const targetDir = path.dirname(target);
  if (!fs.existsSync(targetDir)) {
    throw new Error("没有找到 CodexBridge 写入前的备份，无法自动恢复 Codex 配置。");
  }

  const backups = codexBridgeBackups(targetDir);

  if (!backups.length) {
    const stripped = restoreByStrippingManagedCodexBridgeBlock(target);
    if (stripped) {
      return stripped;
    }
    throw new Error("没有找到 CodexBridge 写入前的备份，无法自动恢复 Codex 配置。");
  }
  const restoreFrom = preferredRestoreBackup(backups);

  fs.mkdirSync(targetDir, { recursive: true });
  let currentBackup = null;
  if (fs.existsSync(target)) {
    currentBackup = `${target}.before-restore.${timestamp()}.bak`;
    fs.copyFileSync(target, currentBackup);
  }
  fs.copyFileSync(restoreFrom.fullPath, target);
  return {
    target,
    backup: restoreFrom.fullPath,
    currentBackup,
  };
}

export function listCodexBackups({ homeDir = os.homedir() } = {}) {
  const target = codexConfigPath(homeDir);
  const targetDir = path.dirname(target);
  if (!fs.existsSync(targetDir)) {
    return [];
  }
  const patterns = [
    { kind: "codexbridge", pattern: /^config\.toml\.codexbridge\..+\.bak$/ },
    { kind: "before_restore", pattern: /^config\.toml\.before-restore\..+\.bak$/ },
    { kind: "history_access", pattern: /^config\.toml\.history-access\..+\.bak$/ },
  ];
  return fs
    .readdirSync(targetDir)
    .filter((name) => patterns.some((item) => item.pattern.test(name)))
    .map((name) => {
      const fullPath = path.join(targetDir, name);
      const stat = fs.statSync(fullPath);
      const kind = patterns.find((item) => item.pattern.test(name))?.kind || "backup";
      return {
        name,
        fullPath,
        kind,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        updatedAt: new Date(stat.mtimeMs).toISOString(),
      };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
}

export function restoreCodexConfigFromBackup(backupPath, { homeDir = os.homedir() } = {}) {
  const target = codexConfigPath(homeDir);
  const allowed = new Set(listCodexBackups({ homeDir }).map((item) => path.resolve(item.fullPath)));
  const resolvedBackup = path.resolve(String(backupPath || ""));
  if (!allowed.has(resolvedBackup)) {
    throw new Error("Backup is not a known CodexBridge config backup.");
  }
  if (!fs.existsSync(resolvedBackup)) {
    throw new Error("Selected Codex config backup does not exist.");
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let currentBackup = null;
  if (fs.existsSync(target)) {
    currentBackup = `${target}.before-restore.${timestamp()}.bak`;
    fs.copyFileSync(target, currentBackup);
  }
  fs.copyFileSync(resolvedBackup, target);
  return {
    target,
    backup: resolvedBackup,
    currentBackup,
  };
}

function restoreByStrippingManagedCodexBridgeBlock(target) {
  if (!fs.existsSync(target)) {
    return null;
  }
  const current = fs.readFileSync(target, "utf8");
  if (!hasCodexBridgeManagedBlock(current)) {
    return null;
  }
  const currentBackup = `${target}.before-restore.${timestamp()}.bak`;
  fs.copyFileSync(target, currentBackup);
  const stripped = stripCodexBridgeConfig(current);
  fs.writeFileSync(target, stripped.trim() ? `${stripped.trimEnd()}\n` : "", "utf8");
  return {
    action: "strip_managed_block",
    target,
    backup: null,
    currentBackup,
  };
}

export function syncCodexBridgeConversationProviders({ homeDir = os.homedir() } = {}) {
  const codexDir = path.join(homeDir, ".codex");
  const result = {
    ok: true,
    skipped: false,
    reason: "",
    totalUpdatedThreads: 0,
    totalImportedThreads: 0,
    totalNormalizedThreads: 0,
    databases: [],
  };

  if (!fs.existsSync(codexDir)) {
    return {
      ...result,
      skipped: true,
      reason: "codex_dir_missing",
    };
  }

  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch (error) {
    return {
      ...result,
      ok: false,
      skipped: true,
      reason: "node_sqlite_unavailable",
      error: error.message,
    };
  }

  const dbPaths = codexStateDatabasePaths(codexDir);
  if (!dbPaths.length) {
    return {
      ...result,
      skipped: true,
      reason: "state_db_missing",
    };
  }

  for (const dbPath of dbPaths) {
    const item = {
      path: dbPath,
      ok: true,
      skipped: false,
      reason: "",
      updatedThreads: 0,
      importedThreads: 0,
      normalizedThreads: 0,
      backup: null,
    };
    try {
      const missingBackupThreads = countMissingThreadsFromHistoryBackups(DatabaseSync, dbPath);
      const legacyThreads = countLegacyCodexBridgeThreads(DatabaseSync, dbPath);
      const legacyLocalProviderThreads = countLegacyLocalProviderThreads(DatabaseSync, dbPath);
      const hiddenLegacyMetadataThreads = countHiddenLegacyMetadataThreads(DatabaseSync, dbPath);
      const hiddenBackupReferencedThreads = countHiddenBackupReferencedThreads(DatabaseSync, dbPath);
      const openAiUserEventThreads = countOpenAiUserEventMetadataThreads(DatabaseSync, dbPath);
      if (
        legacyThreads < 1 &&
        legacyLocalProviderThreads < 1 &&
        missingBackupThreads < 1 &&
        hiddenLegacyMetadataThreads < 1 &&
        hiddenBackupReferencedThreads < 1 &&
        openAiUserEventThreads < 1
      ) {
        item.skipped = true;
        item.reason = "no_legacy_threads";
        result.databases.push(item);
        continue;
      }

      item.backup = backupCodexStateDatabase(dbPath);
      item.importedThreads = importMissingThreadsFromHistoryBackups(DatabaseSync, dbPath);
      item.updatedThreads = updateLegacyCodexBridgeThreads(DatabaseSync, dbPath);
      item.normalizedThreads =
        normalizeHiddenLegacyThreadMetadata(DatabaseSync, dbPath) +
        normalizeBackupReferencedThreadMetadata(DatabaseSync, dbPath) +
        normalizeLegacyLocalHistoryProviders(DatabaseSync, dbPath) +
        normalizeOpenAiUserEventMetadata(DatabaseSync, dbPath);
      result.totalImportedThreads += item.importedThreads;
      result.totalUpdatedThreads += item.updatedThreads;
      result.totalNormalizedThreads += item.normalizedThreads;
      result.databases.push(item);
    } catch (error) {
      item.ok = false;
      item.error = error.message;
      result.ok = false;
      result.databases.push(item);
    }
  }

  return result;
}

function countMissingThreadsFromHistoryBackups(DatabaseSync, dbPath) {
  const backupPaths = codexStateMergeSourcePaths(dbPath);
  if (!backupPaths.length) {
    return 0;
  }
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 1500");
    if (!hasTable(db, "threads")) {
      return 0;
    }
    let missing = 0;
    backupPaths.forEach((backupPath, index) => {
      const alias = `backup_${index}`;
      db.exec(`ATTACH DATABASE ${sqlString(backupPath)} AS ${quoteIdentifier(alias)}`);
      try {
        if (!hasAttachedTable(db, alias, "threads")) {
          return;
        }
        missing += Number(
          db
            .prepare(
              `SELECT COUNT(*) AS count FROM ${quoteIdentifier(alias)}.threads AS b ` +
                "WHERE b.id IS NOT NULL " +
                "AND NOT EXISTS (SELECT 1 FROM main.threads AS t WHERE t.id = b.id)",
            )
            .get().count,
        );
      } finally {
        db.exec(`DETACH DATABASE ${quoteIdentifier(alias)}`);
      }
    });
    return missing;
  } finally {
    db.close();
  }
}

function importMissingThreadsFromHistoryBackups(DatabaseSync, dbPath) {
  const backupPaths = codexStateMergeSourcePaths(dbPath);
  if (!backupPaths.length) {
    return 0;
  }
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 1500");
    if (!hasTable(db, "threads")) {
      return 0;
    }
    const mainThreadColumns = tableColumns(db, "threads");
    let importedThreads = 0;
    backupPaths.forEach((backupPath, index) => {
      const alias = `backup_${index}`;
      db.exec(`ATTACH DATABASE ${sqlString(backupPath)} AS ${quoteIdentifier(alias)}`);
      try {
        if (!hasAttachedTable(db, alias, "threads")) {
          return;
        }
        const sourceThreadColumns = attachedTableColumns(db, alias, "threads");
        const threadColumns = sharedColumns(mainThreadColumns, sourceThreadColumns);
        if (!threadColumns.includes("id")) {
          return;
        }
        const importedIds = db
          .prepare(
            `SELECT b.id FROM ${quoteIdentifier(alias)}.threads AS b ` +
              "WHERE b.id IS NOT NULL " +
              "AND NOT EXISTS (SELECT 1 FROM main.threads AS t WHERE t.id = b.id)",
          )
          .all()
          .map((row) => row.id);
        if (!importedIds.length) {
          return;
        }

        const columnList = threadColumns.map(quoteIdentifier).join(", ");
        const sourceList = threadColumns
          .map((column) => `b.${quoteIdentifier(column)}`)
          .join(", ");
        const insertResult = db
          .prepare(
            `INSERT INTO main.threads (${columnList}) ` +
              `SELECT ${sourceList} FROM ${quoteIdentifier(alias)}.threads AS b ` +
              "WHERE b.id IS NOT NULL " +
              "AND NOT EXISTS (SELECT 1 FROM main.threads AS t WHERE t.id = b.id)",
          )
          .run();
        importedThreads += Number(insertResult.changes || 0);
        copyImportedThreadSideTables(db, alias, importedIds);
      } finally {
        db.exec(`DETACH DATABASE ${quoteIdentifier(alias)}`);
      }
    });
    return importedThreads;
  } finally {
    db.close();
  }
}

function copyImportedThreadSideTables(db, alias, threadIds) {
  const idSet = new Set(threadIds.filter(Boolean));
  if (!idSet.size) {
    return;
  }
  copyRowsForImportedThreads(db, alias, "thread_dynamic_tools", ["thread_id"], idSet);
  copyRowsForImportedThreads(db, alias, "thread_spawn_edges", ["parent_thread_id", "child_thread_id"], idSet);
}

function copyRowsForImportedThreads(db, alias, tableName, threadColumns, threadIds) {
  if (!hasTable(db, tableName) || !hasAttachedTable(db, alias, tableName)) {
    return;
  }
  const mainColumns = tableColumns(db, tableName);
  const sourceColumns = attachedTableColumns(db, alias, tableName);
  const availableThreadColumns = threadColumns.filter((column) => (
    mainColumns.includes(column) &&
    sourceColumns.includes(column)
  ));
  if (!availableThreadColumns.length) {
    return;
  }
  const columns = sharedColumns(mainColumns, sourceColumns);
  const columnList = columns.map(quoteIdentifier).join(", ");
  const sourceList = columns.map((column) => `b.${quoteIdentifier(column)}`).join(", ");
  const ids = [...threadIds].map(sqlString).join(", ");
  const predicates = availableThreadColumns
    .map((column) => `b.${quoteIdentifier(column)} IN (${ids})`)
    .join(" OR ");
  db
    .prepare(
      `INSERT INTO main.${quoteIdentifier(tableName)} (${columnList}) ` +
        `SELECT ${sourceList} FROM ${quoteIdentifier(alias)}.${quoteIdentifier(tableName)} AS b ` +
        `WHERE ${predicates}`,
    )
    .run();
}

function codexStateMergeSourcePaths(dbPath) {
  const dir = path.dirname(dbPath);
  const baseName = path.basename(dbPath);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => (
      name.startsWith(`${baseName}.`) &&
      name.endsWith(".bak") &&
      !name.endsWith(".bak-wal") &&
      !name.endsWith(".bak-shm")
    ))
    .sort()
    .map((name) => path.join(dir, name))
    .filter(isSQLiteDatabaseFile);
}

function isSQLiteDatabaseFile(filePath) {
  try {
    const handle = fs.openSync(filePath, "r");
    try {
      const header = Buffer.alloc(16);
      const bytesRead = fs.readSync(handle, header, 0, header.length, 0);
      return bytesRead === header.length && header.toString("utf8") === "SQLite format 3\0";
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return false;
  }
}

function hasTable(db, tableName) {
  return Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName),
  );
}

function hasAttachedTable(db, alias, tableName) {
  return Boolean(
    db
      .prepare(
        `SELECT name FROM ${quoteIdentifier(alias)}.sqlite_master ` +
          "WHERE type = 'table' AND name = ?",
      )
      .get(tableName),
  );
}

function tableColumns(db, tableName) {
  return db
    .prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
    .all()
    .map((column) => column.name);
}

function attachedTableColumns(db, alias, tableName) {
  return db
    .prepare(`PRAGMA ${quoteIdentifier(alias)}.table_info(${quoteIdentifier(tableName)})`)
    .all()
    .map((column) => column.name);
}

function sharedColumns(left, right) {
  const rightSet = new Set(right);
  return left.filter((column) => rightSet.has(column));
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function recoverCodexHistoryAccess({ homeDir = os.homedir() } = {}) {
  const target = codexConfigPath(homeDir);
  const historySync = syncCodexBridgeConversationProviders({ homeDir });
  if (!fs.existsSync(target)) {
    throw new Error("没有找到 Codex 配置文件，无法自动开启历史对话显示。");
  }

  const content = fs.readFileSync(target, "utf8");
  if (!isCodexBridgeToml(content)) {
    return {
      target,
      currentBackup: null,
      unchanged: true,
      action: "recover_history_access",
      historySync,
      message: "当前 Codex 配置不是 CodexBridge 配置，无需调整。历史对话应由当前 Codex 配置自行显示。",
      nextStep: "请完全退出并重启 Codex。若还要使用 CodexBridge，请回到本应用开启 Router，配置会自动刷新。",
    };
  }

  const nextContent = enableResponseStorage(content);
  let currentBackup = null;
  let unchanged = nextContent === content;
  if (!unchanged) {
    currentBackup = `${target}.history-access.${timestamp()}.bak`;
    fs.copyFileSync(target, currentBackup);
    fs.writeFileSync(target, nextContent, "utf8");
  }

  return {
    target,
    currentBackup,
    unchanged,
    action: "recover_history_access",
    historySync,
    message: unchanged
      ? "配置已包含历史对话设置，没有修改；请完全退出并重新打开 Codex。"
      : "已开启历史对话显示，并保留当前模型、插件与 Router 配置；请完全退出并重新打开 Codex。",
    nextStep: "请完全退出并重启 Codex；历史会话会按 Codex 内置 OpenAI 分组显示，模型栏仍会继续使用 CodexBridge 当前配置。",
  };
}

function codexStateDatabasePaths(codexDir) {
  return fs
    .readdirSync(codexDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^state(?:_\d+)?\.sqlite$/.test(name))
    .sort()
    .map((name) => path.join(codexDir, name));
}

function countLegacyCodexBridgeThreads(DatabaseSync, dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 1500");
    if (!hasThreadProviderColumn(db)) {
      return 0;
    }
    return Number(
      db
        .prepare("SELECT COUNT(*) AS count FROM threads WHERE model_provider = ?")
        .get("codex-bridge").count,
    );
  } finally {
    db.close();
  }
}

function countLegacyLocalProviderThreads(DatabaseSync, dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 1500");
    if (!hasThreadProviderColumn(db)) {
      return 0;
    }
    return Number(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM threads WHERE LOWER(model_provider) IN (${legacyLocalProviderSqlList()})`,
        )
        .get().count,
    );
  } finally {
    db.close();
  }
}

function countHiddenLegacyMetadataThreads(DatabaseSync, dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 1500");
    if (!hasTable(db, "threads")) {
      return 0;
    }
    const columns = tableColumns(db, "threads");
    if (!columns.includes("model_provider")) {
      return 0;
    }
    const predicates = [];
    if (columns.includes("source")) {
      predicates.push(legacySourceNeedsVscodeSql("source"));
    }
    if (columns.includes("thread_source")) {
      predicates.push(legacyThreadSourceNeedsUserSql("thread_source"));
    }
    if (!predicates.length) {
      return 0;
    }
    return Number(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM threads " +
            "WHERE model_provider = ? " +
            `AND (${predicates.join(" OR ")})`,
        )
        .get("openai").count,
    );
  } finally {
    db.close();
  }
}

function countOpenAiUserEventMetadataThreads(DatabaseSync, dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 1500");
    if (!hasTable(db, "threads")) {
      return 0;
    }
    const columns = tableColumns(db, "threads");
    if (!columns.includes("model_provider") || !columns.includes("has_user_event")) {
      return 0;
    }
    const userContentPredicate = realUserContentSql(columns);
    if (!userContentPredicate) {
      return 0;
    }
    return Number(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM threads " +
            "WHERE model_provider = ? " +
            "AND has_user_event = 0 " +
            `AND (${userContentPredicate})`,
        )
        .get("openai").count,
    );
  } finally {
    db.close();
  }
}

function countHiddenBackupReferencedThreads(DatabaseSync, dbPath) {
  return withCodexStateMergeSources(DatabaseSync, dbPath, (db, alias) => {
    if (!hasAttachedTable(db, alias, "threads") || !hasTable(db, "threads")) {
      return 0;
    }
    const sourceColumns = attachedTableColumns(db, alias, "threads");
    const mainColumns = tableColumns(db, "threads");
    if (!sourceColumns.includes("id") || !sourceColumns.includes("model_provider")) {
      return 0;
    }
    const predicate = visibilityIssuePredicate(mainColumns, "t");
    if (!predicate) {
      return 0;
    }
    return Number(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM main.threads AS t ` +
            `WHERE (${predicate}) ` +
            `AND EXISTS (` +
            `SELECT 1 FROM ${quoteIdentifier(alias)}.threads AS b ` +
            "WHERE b.id = t.id AND b.model_provider = ?" +
            ")",
        )
        .get("codex-bridge").count,
    );
  });
}

function updateLegacyCodexBridgeThreads(DatabaseSync, dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 1500");
    const columns = tableColumns(db, "threads");
    const assignments = ["model_provider = ?"];
    if (columns.includes("source")) {
      assignments.push(
        "source = CASE " +
          `WHEN ${legacySourceNeedsVscodeSql("source")} THEN 'vscode' ` +
          "ELSE source END",
      );
    }
    if (columns.includes("thread_source")) {
      assignments.push(
        "thread_source = CASE " +
          `WHEN ${legacyThreadSourceNeedsUserSql("thread_source")} THEN 'user' ` +
          "ELSE thread_source END",
      );
    }
    addVisibleThreadAssignments(assignments, columns);
    const result = db
      .prepare(`UPDATE threads SET ${assignments.join(", ")} WHERE model_provider = ?`)
      .run("openai", "codex-bridge");
    return Number(result.changes || 0);
  } finally {
    db.close();
  }
}

function normalizeHiddenLegacyThreadMetadata(DatabaseSync, dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 1500");
    if (!hasTable(db, "threads")) {
      return 0;
    }
    const columns = tableColumns(db, "threads");
    if (!columns.includes("model_provider")) {
      return 0;
    }
    const predicates = [];
    const assignments = [];
    if (columns.includes("source")) {
      predicates.push(legacySourceNeedsVscodeSql("source"));
      assignments.push(
        "source = CASE " +
          `WHEN ${legacySourceNeedsVscodeSql("source")} THEN 'vscode' ` +
          "ELSE source END",
      );
    }
    if (columns.includes("thread_source")) {
      predicates.push(legacyThreadSourceNeedsUserSql("thread_source"));
      assignments.push(
        "thread_source = CASE " +
          `WHEN ${legacyThreadSourceNeedsUserSql("thread_source")} THEN 'user' ` +
          "ELSE thread_source END",
      );
    }
    if (!assignments.length || !predicates.length) {
      return 0;
    }
    addVisibleThreadAssignments(assignments, columns);
    const result = db
      .prepare(
        `UPDATE threads SET ${assignments.join(", ")} ` +
          "WHERE model_provider = ? " +
          `AND (${predicates.join(" OR ")})`,
      )
      .run("openai");
    return Number(result.changes || 0);
  } finally {
    db.close();
  }
}

function normalizeBackupReferencedThreadMetadata(DatabaseSync, dbPath) {
  return withCodexStateMergeSources(DatabaseSync, dbPath, (db, alias) => {
    if (!hasAttachedTable(db, alias, "threads") || !hasTable(db, "threads")) {
      return 0;
    }
    const sourceColumns = attachedTableColumns(db, alias, "threads");
    const mainColumns = tableColumns(db, "threads");
    if (!sourceColumns.includes("id") || !sourceColumns.includes("model_provider")) {
      return 0;
    }
    const predicate = visibilityIssuePredicate(mainColumns, "threads");
    if (!predicate) {
      return 0;
    }
    const assignments = [];
    if (mainColumns.includes("source")) {
      assignments.push(
        "source = CASE " +
          `WHEN ${legacySourceNeedsVscodeSql("source")} THEN 'vscode' ` +
          "ELSE source END",
      );
    }
    if (mainColumns.includes("thread_source")) {
      assignments.push(
        "thread_source = CASE " +
          `WHEN ${legacyThreadSourceNeedsUserSql("thread_source")} THEN 'user' ` +
          "ELSE thread_source END",
      );
    }
    addVisibleThreadAssignments(assignments, mainColumns);
    if (!assignments.length) {
      return 0;
    }
    const result = db
      .prepare(
        `UPDATE main.threads SET ${assignments.join(", ")} ` +
          `WHERE (${predicate}) ` +
          `AND EXISTS (` +
          `SELECT 1 FROM ${quoteIdentifier(alias)}.threads AS b ` +
          "WHERE b.id = main.threads.id AND b.model_provider = ?" +
          ")",
      )
      .run("codex-bridge");
    return Number(result.changes || 0);
  });
}

function normalizeLegacyLocalHistoryProviders(DatabaseSync, dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 1500");
    if (!hasTable(db, "threads")) {
      return 0;
    }
    const columns = tableColumns(db, "threads");
    if (!columns.includes("model_provider")) {
      return 0;
    }
    const assignments = ["model_provider = ?"];
    if (columns.includes("source")) {
      assignments.push(
        "source = CASE " +
          `WHEN ${legacySourceNeedsVscodeSql("source")} THEN 'vscode' ` +
          "ELSE source END",
      );
    }
    if (columns.includes("thread_source")) {
      assignments.push(
        "thread_source = CASE " +
          `WHEN ${legacyThreadSourceNeedsUserSql("thread_source")} THEN 'user' ` +
          "ELSE thread_source END",
      );
    }
    addVisibleThreadAssignments(assignments, columns);
    const result = db
      .prepare(
        `UPDATE threads SET ${assignments.join(", ")} ` +
          `WHERE LOWER(model_provider) IN (${legacyLocalProviderSqlList()})`,
      )
      .run("openai");
    return Number(result.changes || 0);
  } finally {
    db.close();
  }
}

function normalizeOpenAiUserEventMetadata(DatabaseSync, dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 1500");
    if (!hasTable(db, "threads")) {
      return 0;
    }
    const columns = tableColumns(db, "threads");
    if (!columns.includes("model_provider") || !columns.includes("has_user_event")) {
      return 0;
    }
    const userContentPredicate = realUserContentSql(columns);
    if (!userContentPredicate) {
      return 0;
    }
    const result = db
      .prepare(
        "UPDATE threads SET has_user_event = 1 " +
          "WHERE model_provider = ? " +
          "AND has_user_event = 0 " +
          `AND (${userContentPredicate})`,
      )
      .run("openai");
    return Number(result.changes || 0);
  } finally {
    db.close();
  }
}

function withCodexStateMergeSources(DatabaseSync, dbPath, callback) {
  const backupPaths = codexStateMergeSourcePaths(dbPath);
  if (!backupPaths.length) {
    return 0;
  }
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 1500");
    let total = 0;
    backupPaths.forEach((backupPath, index) => {
      const alias = `backup_${index}`;
      db.exec(`ATTACH DATABASE ${sqlString(backupPath)} AS ${quoteIdentifier(alias)}`);
      try {
        total += Number(callback(db, alias, backupPath) || 0);
      } finally {
        db.exec(`DETACH DATABASE ${quoteIdentifier(alias)}`);
      }
    });
    return total;
  } finally {
    db.close();
  }
}

function addVisibleThreadAssignments(assignments, columns) {
  if (columns.includes("archived")) {
    assignments.push("archived = 0");
  }
  if (columns.includes("has_user_event")) {
    assignments.push("has_user_event = 1");
  }
}

function visibilityIssuePredicate(columns, tableAlias) {
  const prefix = tableAlias ? `${tableAlias}.` : "";
  const predicates = [];
  if (columns.includes("source")) {
    predicates.push(legacySourceNeedsVscodeSql(`${prefix}source`));
  }
  if (columns.includes("thread_source")) {
    predicates.push(legacyThreadSourceNeedsUserSql(`${prefix}thread_source`));
  }
  if (columns.includes("archived")) {
    predicates.push(`${prefix}archived != 0`);
  }
  if (columns.includes("has_user_event")) {
    predicates.push(`${prefix}has_user_event = 0`);
  }
  return predicates.join(" OR ");
}

function legacyThreadSourceSqlList() {
  return LEGACY_CODEX_BRIDGE_THREAD_SOURCES.map(sqlString).join(", ");
}

function legacyLocalProviderSqlList() {
  return LEGACY_LOCAL_HISTORY_PROVIDERS.map(sqlString).join(", ");
}

function legacyThreadSourceNeedsUserSql(columnExpr) {
  return `(${columnExpr} IS NULL OR ${columnExpr} = '' OR LOWER(${columnExpr}) IN (${legacyThreadSourceSqlList()}))`;
}

function legacySourceNeedsVscodeSql(columnExpr) {
  return `(${columnExpr} IS NULL OR ${columnExpr} = '' OR LOWER(${columnExpr}) IN (${legacyThreadSourceSqlList()}))`;
}

function realUserContentSql(columns, tableAlias) {
  const prefix = tableAlias ? `${tableAlias}.` : "";
  const contentColumns = ["first_user_message", "preview", "title"].filter((column) =>
    columns.includes(column),
  );
  if (!contentColumns.length) {
    return "";
  }
  return contentColumns
    .map((column) => `NULLIF(TRIM(CAST(${prefix}${quoteIdentifier(column)} AS TEXT)), '') IS NOT NULL`)
    .join(" OR ");
}

function hasThreadProviderColumn(db) {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("threads");
  if (!table) {
    return false;
  }
  const columns = db.prepare("PRAGMA table_info(threads)").all();
  return columns.some((column) => column.name === "model_provider");
}

function backupCodexStateDatabase(dbPath) {
  const backup = `${dbPath}.codexbridge-history.${timestamp()}.bak`;
  fs.copyFileSync(dbPath, backup);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${dbPath}${suffix}`;
    if (fs.existsSync(sidecar)) {
      fs.copyFileSync(sidecar, `${backup}${suffix}`);
    }
  }
  return backup;
}

function mergeCodexBridgeConfig(baseContent, bridgeContent) {
  const bridgeBlock = codexBridgeManagedBlock(bridgeContent);
  const cleanedBase = stripCodexBridgeConfig(baseContent || "");
  const { preamble, tables } = splitTomlPreamble(cleanedBase);
  const sections = [
    preamble.join("\n"),
    bridgeBlock,
    tables.join("\n"),
  ].filter((section) => section.trim());
  return `${sections.join("\n\n")}\n`;
}

function codexBridgeManagedBlock(content) {
  const managed = extractCodexBridgeManagedBlock(content);
  if (managed.length) {
    return trimBlankLines(managed).join("\n");
  }
  const bridge = extractCodexBridgeConfig(content);
  const legacyLines = trimBlankLines([
    ...bridge.topLevelLines,
    ...(bridge.providerLines.length ? ["", ...bridge.providerLines] : []),
  ]);
  return [
    CODEX_BRIDGE_MANAGED_START,
    ...legacyLines,
    CODEX_BRIDGE_MANAGED_END,
  ].join("\n");
}

function validateCodexBridgeWrittenConfig({ target, content, port = 15722 } = {}) {
  const written = content ?? (target && fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "");
  if (!hasCodexBridgeManagedBlock(written)) {
    throw new Error("CodexBridge config validation failed: managed block marker missing.");
  }
  if (readTopLevelTomlString(written, "model_provider") !== "openai") {
    throw new Error("CodexBridge config validation failed: model_provider is not openai.");
  }
  if (!readTopLevelTomlString(written, "model_catalog_json")) {
    throw new Error("CodexBridge config validation failed: model_catalog_json is missing.");
  }
  const baseUrl = readTopLevelTomlString(written, "openai_base_url");
  const expected = new RegExp(`^http://(?:localhost|127\\.0\\.0\\.1):${Number(port || 15722)}/v1$`);
  if (!expected.test(baseUrl || "")) {
    throw new Error("CodexBridge config validation failed: openai_base_url does not point to the local router.");
  }
  if (hasTomlTable(written, "model_providers.codex-bridge")) {
    throw new Error("CodexBridge config validation failed: legacy codex-bridge provider table remains.");
  }
  return true;
}

function currentCodexModelSettings(content) {
  const settings = {};
  const model = readTopLevelTomlString(content, "model");
  if (isCodexBridgeModelId(model)) {
    settings.model = model;
  }

  const reasoningEffort = readTopLevelTomlString(content, "model_reasoning_effort");
  if (CODEX_REASONING_EFFORTS.has(reasoningEffort)) {
    settings.reasoningEffort = reasoningEffort;
  }

  const sandboxMode = readTopLevelTomlString(content, "sandbox_mode");
  if (CODEX_SANDBOX_MODES.has(sandboxMode)) {
    settings.sandboxMode = sandboxMode;
  }

  const approvalPolicy = readTopLevelTomlString(content, "approval_policy");
  if (CODEX_APPROVAL_POLICIES.has(approvalPolicy)) {
    settings.approvalPolicy = approvalPolicy;
  }

  return settings;
}

function isCodexBridgeModelId(value) {
  return typeof value === "string" && value.startsWith(CODEX_BRIDGE_MODEL_ID_PREFIX);
}

function readTopLevelTomlString(content, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*${escapedKey}\\s*=\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"`);
  for (const line of String(content || "").split(/\r?\n/)) {
    if (isTomlTableHeader(line)) {
      break;
    }
    const match = line.match(pattern);
    if (match) {
      return match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
  }
  return null;
}

function readTopLevelTomlArrayStrings(content, key) {
  const escapedKey = escapeRegex(key);
  const startPattern = new RegExp(`^\\s*${escapedKey}\\s*=\\s*\\[`);
  const lines = [];
  let collecting = false;
  for (const line of String(content || "").split(/\r?\n/)) {
    if (!collecting && isTomlTableHeader(line)) {
      break;
    }
    if (!collecting && !startPattern.test(line)) {
      continue;
    }
    collecting = true;
    lines.push(line);
    if (line.includes("]")) {
      break;
    }
  }
  return extractTomlQuotedStrings(lines.join("\n"));
}

function readTomlStringInTable(content, tableName, key) {
  const keyPattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*('[^']*'|"[^"\\\\]*(?:\\\\.[^"\\\\]*)*")`);
  for (const line of tomlTableLines(content, tableName)) {
    const match = line.match(keyPattern);
    if (match) {
      return unquoteTomlString(match[1]);
    }
  }
  return null;
}

function readTomlBooleanInTable(content, tableName, key) {
  const keyPattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*(true|false)\\b`, "i");
  for (const line of tomlTableLines(content, tableName)) {
    const match = line.match(keyPattern);
    if (match) {
      return match[1].toLowerCase() === "true";
    }
  }
  return null;
}

function hasTomlTable(content, tableName) {
  return tomlTableLines(content, tableName).length > 0 || String(content || "")
    .split(/\r?\n/)
    .some((line) => tomlHeaderName(line) === tableName);
}

function tomlTableLines(content, tableName) {
  const output = [];
  let collecting = false;
  for (const line of String(content || "").split(/\r?\n/)) {
    const headerName = tomlHeaderName(line);
    if (headerName) {
      if (collecting) {
        break;
      }
      collecting = headerName === tableName;
      continue;
    }
    if (collecting) {
      output.push(line);
    }
  }
  return output;
}

function tomlHeaderName(line) {
  const match = String(line || "").match(/^\s*\[\s*(.+?)\s*]\s*(?:#.*)?$/);
  return match ? match[1].trim() : "";
}

function extractTomlQuotedStrings(value) {
  const strings = [];
  const pattern = /'([^']*)'|"([^"\\]*(?:\\.[^"\\]*)*)"/g;
  let match;
  while ((match = pattern.exec(String(value || "")))) {
    strings.push(unquoteTomlString(match[0]));
  }
  return strings;
}

function unquoteTomlString(value) {
  const text = String(value || "");
  if (text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1);
  }
  if (text.startsWith('"') && text.endsWith('"')) {
    return text
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  return text;
}

function codexResourceDirsFromConfig({ nodeReplCommand, codexCliPath } = {}) {
  const dirs = [];
  if (codexCliPath && path.basename(codexCliPath).toLowerCase() === "codex.exe") {
    dirs.push(path.dirname(codexCliPath));
  }
  if (nodeReplCommand && path.basename(nodeReplCommand).toLowerCase() === "node_repl.exe") {
    dirs.push(path.resolve(path.dirname(nodeReplCommand), "..", ".."));
  }
  return uniqueExistingParents(dirs);
}

function uniqueExistingParents(paths) {
  const seen = new Set();
  const output = [];
  for (const item of paths) {
    const normalized = path.normalize(item || "");
    const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function bundledOpenAiPluginVersion(resourcesDir, pluginId) {
  if (!resourcesDir) {
    return "";
  }
  return pluginVersionFromDir(path.join(resourcesDir, "plugins", "openai-bundled", "plugins", pluginId));
}

function openAiBundledCachedPluginVersions(homeDir, pluginId) {
  const pluginRoot = path.join(homeDir, ".codex", "plugins", "cache", "openai-bundled", pluginId);
  if (!fs.existsSync(pluginRoot)) {
    return [];
  }
  try {
    return fs
      .readdirSync(pluginRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => pluginVersionFromDir(path.join(pluginRoot, entry.name)) || entry.name)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function pluginVersionFromDir(pluginDir) {
  for (const manifestPath of [
    path.join(pluginDir, ".codex-plugin", "plugin.json"),
    path.join(pluginDir, "plugin.json"),
  ]) {
    try {
      if (!fs.existsSync(manifestPath)) {
        continue;
      }
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      return String(manifest.version || "").trim();
    } catch {
      return "";
    }
  }
  return "";
}

function latestVersion(versions) {
  return [...new Set((versions || []).filter(Boolean))]
    .sort(compareVersionStrings)
    .at(-1) || "";
}

function compareVersionStrings(left, right) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] || 0;
    const rightPart = rightParts[index] || 0;
    if (leftPart !== rightPart) {
      return leftPart - rightPart;
    }
  }
  return String(left || "").localeCompare(String(right || ""));
}

function versionParts(version) {
  return String(version || "")
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((part) => Number(part));
}

function splitPathList(value) {
  return String(value || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function findSkyRuntime(moduleDirs) {
  for (const moduleDir of moduleDirs || []) {
    const importablePath = skyClientPath(moduleDir, "@oai");
    if (fs.existsSync(importablePath)) {
      return {
        ok: true,
        kind: "(@oai/sky)",
        path: importablePath,
      };
    }
    const encodedPath = skyClientPath(moduleDir, "%40oai");
    if (fs.existsSync(encodedPath)) {
      return {
        ok: false,
        kind: "encoded_scope_only",
        path: encodedPath,
      };
    }
  }
  return {
    ok: false,
    kind: "",
    path: "",
  };
}

function skyClientPath(moduleDir, packageDir) {
  return path.join(
    moduleDir,
    packageDir,
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
}

function looksLikeExecutablePath(value) {
  return /\.exe$/i.test(String(value || "")) || /[\\/]/.test(String(value || ""));
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripCodexBridgeConfig(content) {
  if (hasCodexBridgeManagedBlock(content)) {
    return stripCodexBridgeManagedBlocks(content);
  }

  const lines = content.split(/\r?\n/);
  const output = [];
  let inTable = false;
  let skippingBridgeProvider = false;

  for (const line of lines) {
    if (skippingBridgeProvider) {
      if (!isTomlTableHeader(line)) {
        continue;
      }
      skippingBridgeProvider = false;
    }

    if (isCodexBridgeProviderHeader(line)) {
      skippingBridgeProvider = true;
      inTable = true;
      continue;
    }

    if (isTomlTableHeader(line)) {
      inTable = true;
      output.push(line);
      continue;
    }

    if (!inTable && isCodexBridgeTopLevelLine(line)) {
      continue;
    }

    output.push(line);
  }

  return trimBlankLines(output).join("\n");
}

function hasCodexBridgeManagedBlock(content) {
  const text = String(content || "");
  return text.includes(CODEX_BRIDGE_MANAGED_START) && text.includes(CODEX_BRIDGE_MANAGED_END);
}

function extractCodexBridgeManagedBlock(content) {
  const lines = String(content || "").split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === CODEX_BRIDGE_MANAGED_START);
  if (start < 0) {
    return [];
  }
  const endOffset = lines.slice(start + 1).findIndex((line) => line.trim() === CODEX_BRIDGE_MANAGED_END);
  if (endOffset < 0) {
    return [];
  }
  const end = start + 1 + endOffset;
  return lines.slice(start, end + 1);
}

function stripCodexBridgeManagedBlocks(content) {
  const lines = String(content || "").split(/\r?\n/);
  const output = [];
  let skipping = false;

  for (const line of lines) {
    if (line.trim() === CODEX_BRIDGE_MANAGED_START) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (line.trim() === CODEX_BRIDGE_MANAGED_END) {
        skipping = false;
      }
      continue;
    }
    output.push(line);
  }

  return trimBlankLines(output).join("\n");
}

function extractCodexBridgeConfig(content) {
  const lines = content.split(/\r?\n/);
  const topLevelLines = [];
  const providerLines = [];
  let inTable = false;
  let collectingBridgeProvider = false;

  for (const line of lines) {
    if (collectingBridgeProvider) {
      if (isTomlTableHeader(line)) {
        collectingBridgeProvider = false;
      } else {
        providerLines.push(line);
        continue;
      }
    }

    if (isCodexBridgeProviderHeader(line)) {
      collectingBridgeProvider = true;
      providerLines.push(line);
      inTable = true;
      continue;
    }

    if (isTomlTableHeader(line)) {
      inTable = true;
      continue;
    }

    if (!inTable && isCodexBridgeTopLevelLine(line)) {
      topLevelLines.push(line);
    }
  }

  return {
    topLevelLines: trimBlankLines(topLevelLines),
    providerLines: trimBlankLines(providerLines),
  };
}

function splitTomlPreamble(content) {
  const lines = trimBlankLines(content.split(/\r?\n/));
  const firstTableIndex = lines.findIndex((line) => isTomlTableHeader(line));
  if (firstTableIndex < 0) {
    return { preamble: lines, tables: [] };
  }
  return {
    preamble: trimBlankLines(lines.slice(0, firstTableIndex)),
    tables: trimBlankLines(lines.slice(firstTableIndex)),
  };
}

function isCodexBridgeTopLevelLine(line) {
  const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/);
  return Boolean(match && CODEX_BRIDGE_TOP_LEVEL_KEYS.has(match[1]));
}

function isTomlTableHeader(line) {
  return /^\s*\[/.test(line);
}

function isCodexBridgeProviderHeader(line) {
  return /^\s*\[model_providers\.codex-bridge]\s*$/.test(line);
}

function trimBlankLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) {
    start += 1;
  }
  while (end > start && !lines[end - 1].trim()) {
    end -= 1;
  }
  return lines.slice(start, end);
}

function enableResponseStorage(content) {
  if (/^\s*disable_response_storage\s*=/m.test(content)) {
    return content.replace(
      /^(\s*disable_response_storage\s*=\s*)true(\s*(?:#.*)?)$/m,
      "$1false$2",
    );
  }
  const lines = content.split(/\r?\n/);
  const insertAt = lines.findIndex((line) => /^\s*network_access\s*=/.test(line));
  if (insertAt >= 0) {
    lines.splice(insertAt, 0, "disable_response_storage = false");
    return lines.join("\n");
  }
  return `${content.trimEnd()}\ndisable_response_storage = false\n`;
}

function codexBridgeBackups(targetDir) {
  return fs
    .readdirSync(targetDir)
    .filter((name) => /^config\.toml\.codexbridge\..+\.bak$/.test(name))
    .map((name) => {
      const fullPath = path.join(targetDir, name);
      return {
        fullPath,
        name,
        stamp: codexBridgeBackupStamp(name),
        mtimeMs: fs.statSync(fullPath).mtimeMs,
      };
    })
    .sort((a, b) =>
      b.stamp.localeCompare(a.stamp) ||
      b.mtimeMs - a.mtimeMs ||
      b.name.localeCompare(a.name)
    );
}

function codexBridgeBackupStamp(name) {
  return String(name || "").match(/^config\.toml\.codexbridge\.(.+)\.bak$/)?.[1] || "";
}

function preferredRestoreBackup(backups) {
  const nonBridgeBackup = backups.find((backup) => {
    try {
      return !isCodexBridgeToml(fs.readFileSync(backup.fullPath, "utf8"));
    } catch {
      return false;
    }
  });
  return nonBridgeBackup || backups.at(-1);
}

function isCodexBridgeToml(content) {
  return (
    /model_provider\s*=\s*"codex-bridge"/.test(content) ||
    /\[model_providers\.codex-bridge]/.test(content) ||
    /openai_base_url\s*=\s*"http:\/\/(?:localhost|127\.0\.0\.1):\d+\/v1"/.test(content)
  );
}

function toTomlPath(filePath) {
  return path.resolve(filePath).replaceAll("\\", "/");
}

function toTomlString(value) {
  return `"${String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function normalizeSelection(rootDir, selectedModelIds, mode) {
  const available = new Set([
    ...effectiveBuiltInModels(rootDir).map((model) => model.presetId),
    ...defaultSelectedModelIds(mode),
  ]);
  const custom = readCustomModels(rootDir).map((model) => model.presetId);
  for (const id of custom) {
    available.add(id);
  }
  const unique = [];
  for (const id of selectedModelIds || []) {
    if (!id || unique.includes(id)) {
      continue;
    }
    if (!available.has(id)) {
      continue;
    }
    unique.push(id);
  }
  return unique;
}

function modelWithDefaultCapabilities(model) {
  if (model.custom && model.inputModalities === undefined) {
    return {
      ...model,
      inputModalities: normalizeInputModalities(model.inputModalities, ["text"]),
    };
  }
  return model;
}

function applyModelImageInputOverride(model, overrides) {
  if (overrides[model.presetId] === undefined) {
    return model;
  }
  return {
    ...model,
    inputModalities: overrides[model.presetId] ? ["text", "image"] : ["text"],
    imageInputOverride: overrides[model.presetId],
  };
}

function applyModelCapabilityOverride(model, overrides) {
  const override = overrides[model.presetId];
  if (!override) {
    return model;
  }
  const next = {
    ...model,
    capabilityOverrides: override,
    capabilityOverrideSource: "manual",
  };
  if (override.updatedAt) {
    next.capabilityOverrideUpdatedAt = override.updatedAt;
  }
  if (Array.isArray(override.inputModalities)) {
    next.inputModalities = override.inputModalities;
  }
  if (override.contextWindow) {
    next.contextWindow = override.contextWindow;
  }
  if (override.reasoning) {
    next.reasoningCapabilityOverride = override.reasoning;
  }
  return next;
}

function builtInVisionPresetIds() {
  return new Set(
    MODEL_PRESETS
      .filter((model) =>
        (Array.isArray(model.inputModalities) && model.inputModalities.includes("image")) ||
        model.api === "responses"
      )
      .map((model) => model.presetId),
  );
}

function codexBridgeRouteIdForModel(model = {}) {
  const upstreamModel = String(model.model || "").trim();
  if ((model.providerId === "codex" || model.authMode === "codex_openai") && upstreamModel) {
    return `${CODEX_BRIDGE_MODEL_ID_PREFIX}${slugify(upstreamModel)}`;
  }
  const source = model.presetId || upstreamModel || model.displayName || "model";
  return `${CODEX_BRIDGE_MODEL_ID_PREFIX}${slugify(source)}`;
}

function routeForSelectedModel(model, priority, imageGenerationOverrides = {}) {
  const provider = providerById(model.providerId);
  const route = {
    id: codexBridgeRouteIdForModel(model),
    sourcePresetId: model.presetId,
    provider: model.providerId,
    providerFamily: model.providerFamily || providerFamilyForRoute(model, provider),
    custom: Boolean(model.custom),
    displayName: model.displayName,
    description: model.description || `${model.displayName} via ${provider?.name || model.providerName || model.providerId}.`,
    api: model.api,
    baseUrl: model.baseUrl,
    model: model.model,
    authMode: model.authMode || provider?.authMode || "api_key",
    contextWindow: model.contextWindow || 258400,
    priority,
    imageGeneration: imageGenerationForModel(model, imageGenerationOverrides[model.presetId]),
  };
  if (route.authMode === "api_key") {
    route.apiKeyEnv = model.apiKeyEnv || model.keyEnv || provider?.keyEnv;
  }
  for (const key of [
    "rpm",
    "tpm",
    "dropParams",
    "inputModalities",
    "providerFamily",
    "supportsPromptCaching",
    "supportsTools",
    "supportsImages",
    "supportsFiles",
    "supportsMcpNamespaces",
    "supportsResponsePreviousId",
    "defaultReasoningLevel",
    "supportedReasoningLevels",
    "additionalSpeedTiers",
    "serviceTiers",
    "maxToolContinuationTurns",
    "max_tool_continuation_turns",
    "upstreamTimeoutMs",
    "upstream_timeout_ms",
    "capabilityOverrides",
    "capabilityOverrideSource",
    "capabilityOverrideUpdatedAt",
    "reasoningCapabilityOverride",
  ]) {
    if (model[key] !== undefined) {
      route[key] = model[key];
    }
  }
  if (route.api === "chat_completions" && route.maxToolContinuationTurns === undefined) {
    route.maxToolContinuationTurns = DEFAULT_CHAT_TOOL_CONTINUATION_TURNS;
  }
  if (model.custom && route.inputModalities === undefined) {
    route.inputModalities = normalizeInputModalities(model.inputModalities, ["text"]);
  }
  removeLegacyKimiLocalThrottle(route, model);
  route.capabilityStatus = routeCapabilityStatus(route);
  return route;
}

function removeLegacyKimiLocalThrottle(route = {}, model = {}) {
  if (!isKimiRoute(route) || model.custom) {
    return;
  }
  if (Number(route.rpm) === 12 && route.rateLimit === undefined) {
    delete route.rpm;
  }
}

function isKimiRoute(route = {}) {
  const provider = String(route.provider || route.providerId || route.providerFamily || "").toLowerCase();
  if (provider.includes("kimi") || provider.includes("moonshot")) {
    return true;
  }
  const baseUrl = String(route.baseUrl || "").toLowerCase();
  const model = String(route.model || route.id || "").toLowerCase();
  return baseUrl.includes("moonshot") || model.includes("kimi");
}

function providerFamilyForRoute(model = {}, provider) {
  if (model.providerFamily) {
    return model.providerFamily;
  }
  const providerId = String(model.providerId || model.provider || provider?.id || "").toLowerCase();
  if (providerId === "codex" || providerId === "openai") {
    return "openai";
  }
  if (providerId === "deepseek") {
    return "deepseek";
  }
  if (providerId === "kimi" || providerId === "moonshot") {
    return "kimi";
  }
  if (providerId === "minimax") {
    return "minimax";
  }
  if (providerId === "volcengine") {
    return "doubao";
  }
  if (providerId === "qwen") {
    return "qwen";
  }
  if (providerId === "qianfan") {
    return "baidu";
  }
  if (providerId === "xiaomi" || providerId === "stepfun" || providerId === "hunyuan" || providerId === "zhipu" || providerId === "openrouter" || providerId === "siliconflow") {
    return "openai-compatible";
  }
  if (Boolean(model.custom) || String(model.providerName || provider?.name || "").toLowerCase().includes("custom")) {
    return "custom";
  }
  return "openai-compatible";
}

function imageGenerationForModel(model = {}, override) {
  if (override) {
    const overrideMode = String(override.mode || "").trim().toLowerCase();
    if (overrideMode === "official" && !modelAllowsOfficialImageGeneration(model)) {
      return normalizeImageGenerationSettings({ mode: "off" });
    }
    return normalizeImageGenerationSettings(override);
  }
  return normalizeImageGenerationSettings(defaultImageGenerationForModel(model));
}

function defaultImageGenerationForModel(model = {}) {
  if (modelAllowsOfficialImageGeneration(model)) {
    return { mode: "official" };
  }
  return { mode: "off" };
}

function modelAllowsOfficialImageGeneration(model = {}) {
  const providerId = String(model.providerId || model.provider || "").toLowerCase();
  const authMode = String(model.authMode || "").toLowerCase();
  return providerId === "codex" || providerId === "openai" || authMode === "codex_openai";
}

function normalizeImageGenerationSettings(input = {}) {
  const mode = String(input.mode || "official").trim().toLowerCase();
  if (input.enabled === false || mode === "off" || mode === "disabled") {
    return {
      enabled: false,
      mode: "off",
      displayName: String(input.displayName || "Image Generation Disabled").trim(),
      baseUrl: "",
      endpoint: "/images/generations",
      model: "",
      size: String(input.size || "1024x1024").trim(),
      apiKeyEnv: "",
    };
  }
  if (mode === "custom") {
    const baseUrl = String(input.baseUrl || "").trim().replace(/\/+$/, "");
    const model = String(input.model || "").trim();
    const apiKeyEnv = String(input.apiKeyEnv || "IMAGE_GENERATION_API_KEY").trim();
    if (!baseUrl || !model || !apiKeyEnv) {
      throw new Error("Custom image generation requires Base URL, model, and API key env.");
    }
    return {
      enabled: true,
      mode: "custom",
      displayName: String(input.displayName || "Custom Image Generation").trim(),
      baseUrl,
      endpoint: normalizeEndpoint(input.endpoint || "/images/generations"),
      model,
      size: String(input.size || "1024x1024").trim(),
      apiKeyEnv,
    };
  }
  return {
    enabled: true,
    mode: "official",
    displayName: "OpenAI Image Generation",
    baseUrl: "https://api.openai.com/v1",
    endpoint: "/images/generations",
    model: "gpt-image-1",
    size: "1024x1024",
    apiKeyEnv: "OPENAI_API_KEY",
  };
}

function normalizeEndpoint(value) {
  const endpoint = String(value || "/images/generations").trim();
  return endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
}

function normalizeCustomModel(input = {}) {
  const providerName = String(input.providerName || "Custom").trim();
  const displayName = String(input.displayName || "").trim();
  const model = String(input.model || "").trim();
  const baseUrl = String(input.baseUrl || "").trim().replace(/\/+$/, "");
  if (!displayName || !model || !baseUrl) {
    throw new Error("自定义模型需要填写显示名称、真实模型名和 Base URL。");
  }
  const providerId = String(input.providerId || "").trim() || `custom-${slugify(providerName)}`;
  const keyEnv = String(input.keyEnv || `${slugifyEnv(providerName)}_API_KEY`).trim();
  const dropParams = normalizeCustomDropParams(input.dropParams);
  return {
    presetId: input.presetId || `custom-${slugify(providerName)}-${slugify(model)}`,
    providerId,
    providerName,
    displayName,
    description: String(input.description || `${displayName} via ${providerName}.`).trim(),
    api: input.api === "responses" ? "responses" : "chat_completions",
    baseUrl,
    model,
    authMode: "api_key",
    apiKeyEnv: keyEnv,
    keyEnv,
    keyUrl: String(input.keyUrl || "").trim(),
    docsUrl: String(input.docsUrl || "").trim(),
    logoUrl: String(input.logoUrl || "").trim(),
    contextWindow: Number(input.contextWindow || 258400),
    inputModalities: normalizeInputModalities(input.inputModalities, ["text"]),
    ...(dropParams.length && input.api !== "responses" ? { dropParams } : {}),
    custom: true,
  };
}

function normalizeSavedCustomModel(model) {
  if (!model || typeof model !== "object" || !model.custom) {
    return model;
  }
  if (!isLegacyDefaultCustomDropParams(model.dropParams)) {
    return model;
  }
  const cleaned = { ...model };
  delete cleaned.dropParams;
  return cleaned;
}

function normalizeCustomDropParams(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(
    value
      .map((param) => String(param || "").trim())
      .filter(Boolean),
  )];
}

function isLegacyDefaultCustomDropParams(value) {
  if (!Array.isArray(value) || value.length !== 2) {
    return false;
  }
  const normalized = new Set(value.map((param) => String(param || "").trim()));
  return normalized.has("response_format") && normalized.has("parallel_tool_calls");
}

function writeCustomModels(rootDir, models) {
  const target = customModelsPath(rootDir);
  writeJsonAtomic(target, models);
}

function readModelCapabilitiesFile(rootDir) {
  const saved = readJsonIfExists(modelCapabilitiesPath(rootDir), {});
  return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
}

function writeModelCapabilities(rootDir, { imageInput = {}, overrides = {} } = {}) {
  const target = modelCapabilitiesPath(rootDir);
  writeJsonAtomic(target, {
    version: 3,
    imageInput,
    overrides,
  });
}

function normalizeModelCapabilityOverride(value, { keepUpdatedAt = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const result = {};
  const inputModalities = normalizeCapabilityInputModalities(value);
  if (inputModalities) {
    result.inputModalities = inputModalities;
  }
  const contextWindow = Number(value.contextWindow);
  if (Number.isFinite(contextWindow) && contextWindow > 0) {
    result.contextWindow = Math.floor(contextWindow);
  }
  const reasoning = normalizeReasoningCapabilityOverride(value.reasoning ?? value.reasoningMode);
  if (reasoning) {
    result.reasoning = reasoning;
  }
  if (keepUpdatedAt && typeof value.updatedAt === "string" && value.updatedAt.trim()) {
    result.updatedAt = value.updatedAt.trim();
  }
  return Object.keys(result).length ? result : null;
}

function normalizeCapabilityInputModalities(value = {}) {
  const hasInputModalities = Array.isArray(value.inputModalities);
  const hasBooleanOverrides = ["imageInput", "fileInput", "audioInput"].some(
    (key) => Object.prototype.hasOwnProperty.call(value, key),
  );
  if (!hasInputModalities && !hasBooleanOverrides) {
    return null;
  }
  const base = normalizeInputModalities(
    hasInputModalities ? value.inputModalities : ["text"],
    ["text"],
  );
  const set = new Set(base);
  for (const [key, modality] of [
    ["imageInput", "image"],
    ["fileInput", "file"],
    ["audioInput", "audio"],
  ]) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue;
    }
    if (value[key]) {
      set.add(modality);
    } else {
      set.delete(modality);
    }
  }
  set.add("text");
  return orderInputModalities([...set]);
}

function normalizeReasoningCapabilityOverride(value) {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    const mode = value.trim();
    return mode ? { mode } : null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const mode = String(value.mode || value.status || "").trim();
  if (!mode) {
    return null;
  }
  const result = { mode };
  if (typeof value.note === "string" && value.note.trim()) {
    result.note = value.note.trim().slice(0, 200);
  }
  return result;
}

function toggleInputModality(inputModalities, modality, enabled) {
  const set = new Set(normalizeInputModalities(inputModalities, ["text"]));
  if (enabled) {
    set.add(modality);
  } else {
    set.delete(modality);
  }
  set.add("text");
  return orderInputModalities([...set]);
}

function orderInputModalities(inputModalities) {
  const set = new Set(inputModalities);
  return ["text", "image", "file", "audio"].filter((modality) => set.has(modality));
}

function normalizeModelDirectory(saved) {
  const providers = {};
  const source = saved?.providers && typeof saved.providers === "object"
    ? saved.providers
    : {};
  for (const [providerId, entry] of Object.entries(source)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    providers[providerId] = {
      providerId,
      providerName: String(entry.providerName || providerId).trim(),
      baseUrl: String(entry.baseUrl || "").trim(),
      endpoint: String(entry.endpoint || "").trim(),
      source: String(entry.source || "remote").trim(),
      fetchedAt: String(entry.fetchedAt || "").trim(),
      models: normalizeProviderModelList({ data: entry.models || [] }),
    };
  }
  return {
    version: 1,
    providers,
  };
}

function modelDirectoryEndpointForProvider(provider = {}) {
  const baseUrl = String(provider.baseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl || !isValidHttpUrl(baseUrl)) {
    return "";
  }
  return `${baseUrl}/models`;
}

function providerLogoExtension(sourcePath) {
  const extension = path.extname(String(sourcePath || "").trim()).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".ico"].includes(extension)) {
    return extension;
  }
  return ".png";
}

function providerRequiresApiKey(provider = {}) {
  const authMode = provider.authMode || "api_key";
  return authMode === "api_key" && Boolean(provider.keyEnv || provider.apiKeyEnv);
}

function normalizeProviderModelList(body) {
  const rawModels = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.models)
      ? body.models
      : Array.isArray(body)
        ? body
        : [];
  const seen = new Set();
  const models = [];
  for (const item of rawModels) {
    const id = typeof item === "string" ? item : String(item?.id || item?.name || "").trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const model = { id };
    if (item && typeof item === "object" && !Array.isArray(item)) {
      if (item.object) {
        model.object = String(item.object);
      }
      if (item.owned_by) {
        model.ownedBy = String(item.owned_by);
      }
      if (Number.isFinite(Number(item.created))) {
        model.created = Number(item.created);
      }
    }
    models.push(model);
  }
  return models;
}

function modelDirectoryRefreshFailure(providerId, error, existing) {
  return {
    ok: false,
    providerId,
    error: String(error || "Unknown model directory refresh error."),
    cached: Boolean(existing),
    stale: Boolean(existing),
    models: existing?.models || [],
  };
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "model";
}

function slugifyEnv(value) {
  return String(value)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "CUSTOM";
}

function normalizeInputModalities(value, defaultModalities = ["text", "image"]) {
  const requested = Array.isArray(value) && value.length ? value : defaultModalities;
  const normalized = [];
  for (const modality of requested) {
    if (!["text", "image", "file", "audio"].includes(modality) || normalized.includes(modality)) {
      continue;
    }
    normalized.push(modality);
  }
  if (!normalized.includes("text")) {
    normalized.unshift("text");
  }
  return normalized;
}

function routeDiagnosticItem(route = {}) {
  return {
    id: route.id || "",
    displayName: route.displayName || route.id || "",
    provider: route.provider || "",
    model: route.model || "",
    api: route.api || "",
    baseUrl: route.baseUrl || "",
    capabilityStatus: route.capabilityStatus || routeCapabilityStatus(route),
  };
}

function withCapabilityStatus(model = {}) {
  return {
    ...model,
    capabilityStatus: routeCapabilityStatus({
      ...model,
      id: model.presetId || model.id,
      sourcePresetId: model.presetId || model.sourcePresetId,
      provider: model.providerId || model.provider,
    }),
  };
}

function routeCapabilityStatus(route = {}) {
  const profile = normalizeAdapterProfile(route);
  const capabilities = profile.capabilities || {};
  const compact = capabilities.compact || {};
  return {
    provider: route.provider || route.providerId || profile.providerFamily || "",
    providerFamily: profile.providerFamily || "",
    api: profile.api || route.api || "",
    upstreamModel: route.model || "",
    tools: capabilities.tools || "unknown",
    mcpNamespaces: capabilities.mcpNamespaces === true ? "native" : capabilities.mcpNamespaces || "unknown",
    images: capabilities.images || "unknown",
    files: capabilities.files || "unknown",
    audio: capabilities.audio || "none",
    reasoning: capabilities.reasoning?.mode || "unknown",
    compact: compact.mode || "unknown",
    compactStrategy: compact.strategy || "",
    promptCache: capabilities.promptCache || "unknown",
    contextWindow: capabilities.contextWindow || route.contextWindow || 0,
  };
}

function routeCapabilityDiagnosticText(route = {}) {
  const status = route.capabilityStatus || routeCapabilityStatus(route);
  return [
    `provider=${status.provider || status.providerFamily || "-"}`,
    `capabilities: tools=${status.tools || "unknown"}`,
    `images=${status.images || "unknown"}`,
    `files=${status.files || "unknown"}`,
    `compact=${status.compact || "unknown"}`,
    `context=${status.contextWindow || "-"}`,
  ].join(" ");
}

function normalizeDesktopOptions(options = {}) {
  const routerPort = normalizeRouterPort(options.routerPort ?? options.port);
  const codexDesktopExe = String(options.codexDesktopExe || "").trim();
  const codexDesktopLaunchTarget = String(options.codexDesktopLaunchTarget || "").trim();
  return {
    bypassSystemProxy: Boolean(options.bypassSystemProxy),
    routerPort,
    codexDesktopExe,
    codexDesktopLaunchTarget,
  };
}

function normalizeConfigProfile(profile = {}) {
  const name = String(profile.name || "").trim();
  if (!name) {
    return null;
  }
  const id = String(profile.id || slugify(name)).trim() || slugify(name);
  const mode = profile.mode === MODE_ALL_API ? MODE_ALL_API : MODE_HYBRID;
  return {
    id,
    name,
    mode,
    selectedModelIds: Array.isArray(profile.selectedModelIds)
      ? [...new Set(profile.selectedModelIds.map((item) => String(item || "").trim()).filter(Boolean))]
      : [],
    desktopOptions: normalizeDesktopOptions(profile.desktopOptions || {}),
    note: String(profile.note || "").trim().slice(0, 240),
    createdAt: String(profile.createdAt || profile.updatedAt || new Date().toISOString()),
    updatedAt: String(profile.updatedAt || new Date().toISOString()),
  };
}

function checkItem({ id, label, status, detail, action = "", count = null } = {}) {
  const normalizedStatus = ["pass", "warn", "fail"].includes(status) ? status : "warn";
  return {
    id: String(id || ""),
    label: String(label || id || ""),
    status: normalizedStatus,
    detail: String(detail || ""),
    action: String(action || ""),
    count: Number.isFinite(Number(count)) ? Number(count) : null,
  };
}

function startupCheckSummary(items = []) {
  const summary = {
    ok: true,
    pass: 0,
    warn: 0,
    fail: 0,
  };
  for (const item of items) {
    if (item.status === "pass") {
      summary.pass += 1;
    } else if (item.status === "fail") {
      summary.fail += 1;
      summary.ok = false;
    } else {
      summary.warn += 1;
    }
  }
  return summary;
}

function proxyEnvironmentKeys(env = process.env) {
  return ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]
    .filter((key) => env[key] || env[key.toLowerCase()]);
}

function normalizeRouterPort(value) {
  const numeric = Number(value || 15722);
  if (!Number.isInteger(numeric) || numeric < 1024 || numeric > 65535) {
    return 15722;
  }
  return numeric;
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function StringLines(lines) {
  if (Array.isArray(lines)) {
    return lines.map((line) => String(line || ""));
  }
  return String(lines || "").split(/\r?\n/);
}

function redactSecretText(value) {
  return String(value || "")
    .replace(/:\/\/[^/?#\s]+@/g, "://[REDACTED]@")
    .replace(
      /([?&](?:api[_-]?key|token|access_token|secret|key)=)[^&#\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ak)-[A-Za-z0-9._-]{6,}\b/gi, (match) => {
      const prefix = match.slice(0, 2).toLowerCase();
      return `${prefix}-[REDACTED]`;
    })
    .replace(/<\s*(ak)-[A-Za-z0-9._-]{6,}\s*>/gi, "<ak-[REDACTED]>")
    .replace(/\b(?:org|proj)-[A-Za-z0-9._-]{8,}\b/gi, (match) => {
      const prefix = match.split("-")[0].toLowerCase();
      return `${prefix}-[REDACTED]`;
    })
    .replace(/(api[_-]?key["'\s:=]+)[A-Za-z0-9._-]{8,}/gi, "$1[REDACTED]")
    .slice(0, 1000);
}

function timestamp(date = new Date()) {
  return date
    .toISOString()
    .replaceAll(":", "")
    .replaceAll(".", "")
    .replace("T", "-")
    .replace("Z", "");
}
