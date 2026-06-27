import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  CODEX_MODEL_SLOTS,
  MODEL_PRESETS,
  PROVIDERS,
  defaultSelectedModelIds,
  providerById,
} from "./presets.mjs";
import { normalizeAdapterProfile } from "../src/adapter-profile.js";

const require = createRequire(import.meta.url);

export {
  CODEX_MODEL_SLOTS,
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

const CODEX_MODEL_SLOT_IDS = new Set(CODEX_MODEL_SLOTS.map((slot) => slot.id));
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

export function modelImageGenerationPath(rootDir) {
  return path.join(rootDir, "config", "model-image-generation.json");
}

export function desktopOptionsPath(rootDir) {
  return path.join(rootDir, "config", "desktop-options.json");
}

export function codexConfigPath(homeDir = os.homedir()) {
  return path.join(homeDir, ".codex", "config.toml");
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
  const saved = {
    ...loadDesktopOptions(rootDir),
    ...normalizeDesktopOptions(options),
  };
  const target = desktopOptionsPath(rootDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(saved, null, 2)}\n`, "utf8");
  return saved;
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
    .filter((line) => /\b(error|status=4\d\d|status=5\d\d|!! upstream|Health failed|Preflight)/i.test(line))
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
    "Proxy diagnostics:",
    ...proxyDiagnosticsLines(proxyEnv, options),
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
      unhealthyRoutes: routeHealthSummary(lastHealth).unhealthyRoutes,
      usage: usageDiagnosticsSummary(usageSummary),
      proxy: proxyDiagnosticsSummary(proxyEnv),
      update: {
        updateDir,
        updateDirExists: safeExists(updateDir),
      },
      modelCapabilityOverrides: Object.keys(readModelCapabilityOverrides(rootDir)).length,
      modelDirectory: modelDirectoryDiagnosticsSummary(rootDir),
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

export function providerCatalog(rootDir) {
  const customProviders = new Map();
  for (const model of readCustomModels(rootDir)) {
    if (!model.providerId || !model.keyEnv) {
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
        authMode: model.authMode || "api_key",
        description: "用户自定义 OpenAI-compatible Provider。",
        custom: true,
      });
    }
  }
  return [...PROVIDERS, ...customProviders.values()];
}

export function modelCatalog(rootDir) {
  const imageInputOverrides = readModelImageInputOverrides(rootDir);
  const capabilityOverrides = readModelCapabilityOverrides(rootDir);
  return [...MODEL_PRESETS, ...readCustomModels(rootDir)]
    .map((model) => modelWithDefaultCapabilities(model))
    .map((model) => applyModelImageInputOverride(model, imageInputOverrides))
    .map((model) => applyModelCapabilityOverride(model, capabilityOverrides))
    .map((model) => withCapabilityStatus(model));
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
  if ((provider.authMode || "api_key") === "api_key" && keyEnv && !apiKey) {
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
  if (selected.length > CODEX_MODEL_SLOTS.length) {
    throw new Error(`Codex can show at most ${CODEX_MODEL_SLOTS.length} models.`);
  }
  if (
    mode === MODE_ALL_API &&
    selected.some((model) => model.authMode === "codex_openai")
  ) {
    throw new Error("全部 API 模式不能选择“GPT 订阅”模型，请改选 API 模型或切换到混合模式。");
  }

  const imageGenerationOverrides = readModelImageGenerationOverrides(rootDir);
  const routes = selected.map((model, index) =>
    routeForSelectedModel(model, CODEX_MODEL_SLOTS[index], index, imageGenerationOverrides),
  );

  return {
    mode,
    host: "127.0.0.1",
    port: 15722,
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
    homeDir,
  });
  return { config, codex };
}

export function buildCodexToml({
  rootDir,
  port = 15722,
  model = "gpt-5.5",
  reasoningEffort = "medium",
  sandboxMode = "danger-full-access",
  approvalPolicy = "never",
}) {
  const normalizedCatalogPath = toTomlPath(catalogPath(rootDir));

  return [
    CODEX_BRIDGE_MANAGED_START,
    'model_provider = "openai"',
    `model = "${model}"`,
    `model_catalog_json = "${normalizedCatalogPath}"`,
    `model_reasoning_effort = "${reasoningEffort}"`,
    `sandbox_mode = "${sandboxMode}"`,
    `approval_policy = "${approvalPolicy}"`,
    "disable_response_storage = false",
    'network_access = "enabled"',
    `openai_base_url = "http://localhost:${port}/v1"`,
    "windows_wsl_setup_acknowledged = true",
    CODEX_BRIDGE_MANAGED_END,
    "",
  ].join("\n");
}

export function applyCodexConfig({
  rootDir,
  mode,
  port = 15722,
  homeDir = os.homedir(),
  validateWrittenConfig = validateCodexBridgeWrittenConfig,
}) {
  const target = codexConfigPath(homeDir);
  const targetDir = path.dirname(target);
  fs.mkdirSync(targetDir, { recursive: true });
  const existingContent = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  const currentSettings = currentCodexModelSettings(existingContent);
  const bridgeContent = buildCodexToml({ rootDir, mode, port, ...currentSettings });
  const content = mergeCodexBridgeConfig(existingContent, bridgeContent);

  if (fs.existsSync(target) && existingContent === content) {
    const historySync = syncCodexBridgeConversationProviders({ homeDir });
    return { target, backup: null, unchanged: true, historySync };
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
  return { target, backup, unchanged: false, historySync };
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
      nextStep: "请完全退出并重启 Codex。若还要使用 CodexBridge，请回到本应用点击“更新 Codex 配置”并打开 Router。",
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
  if (CODEX_MODEL_SLOT_IDS.has(model)) {
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

function normalizeSelection(rootDir, selectedModelIds, mode) {
  const available = new Set([
    ...MODEL_PRESETS.map((model) => model.presetId),
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
  return unique.slice(0, CODEX_MODEL_SLOTS.length);
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

function routeForSelectedModel(model, slot, priority, imageGenerationOverrides = {}) {
  const provider = providerById(model.providerId);
  const route = {
    id: slot.id,
    slotLabel: slot.label,
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
    route.maxToolContinuationTurns = 2;
  }
  if (model.custom && route.inputModalities === undefined) {
    route.inputModalities = normalizeInputModalities(model.inputModalities, ["text"]);
  }
  route.capabilityStatus = routeCapabilityStatus(route);
  return route;
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
  const providerId = `custom-${slugify(providerName)}`;
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
  return {
    bypassSystemProxy: Boolean(options.bypassSystemProxy),
  };
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
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/g, "sk-[REDACTED]")
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
