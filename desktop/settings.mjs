import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CODEX_MODEL_SLOTS,
  MODEL_PRESETS,
  PROVIDERS,
  defaultSelectedModelIds,
  providerById,
} from "./presets.mjs";

export {
  CODEX_MODEL_SLOTS,
  MODEL_PRESETS,
  PROVIDERS,
  defaultSelectedModelIds,
} from "./presets.mjs";

export const MODE_ALL_API = "all_api";
export const MODE_HYBRID = "hybrid";

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

export function readRouterConfig(rootDir) {
  return readJsonIfExists(routerConfigPath(rootDir), null);
}

export function detectModeFromConfig(config) {
  if (!config) {
    return MODE_HYBRID;
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
  for (const provider of providerCatalog(rootDir)) {
    if (provider.keyEnv) {
      status[provider.keyEnv] = Boolean(secrets[provider.keyEnv]);
    }
  }
  return status;
}

export function secretValue(rootDir, keyEnv) {
  const allowed = new Set(
    providerCatalog(rootDir)
      .map((provider) => provider.keyEnv)
      .filter(Boolean),
  );
  if (!allowed.has(keyEnv)) {
    throw new Error(`Unknown API key env: ${keyEnv}`);
  }
  return loadSecrets(rootDir)[keyEnv] || "";
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
  config = readRouterConfig(rootDir),
  logs = [],
  platform = process.platform,
  arch = process.arch,
  release = os.release(),
} = {}) {
  const options = loadDesktopOptions(rootDir);
  const routeDiagnostics = routerConfigDiagnostics(rootDir, config);
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
    "",
    "Selected models:",
    ...(selectedRoutes.length
      ? selectedRoutes.map(
          (route) =>
            `- ${route.id}: ${route.displayName} -> ${route.model} (${route.api}, ${route.authMode || "api_key"}) ${route.baseUrl}`,
        )
      : ["- none"]),
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
    "Recent errors:",
    ...(errorLines.length ? errorLines.map((line) => `- ${line}`) : ["- none"]),
  ];

  return {
    summary: {
      ok: routeDiagnostics.ok && Boolean(lastHealth?.ok || !routerRunning),
      missingApiKeys: routeDiagnostics.missingApiKeys,
      invalidBaseUrls: routeDiagnostics.invalidBaseUrls,
      errorCount: errorLines.length,
    },
    text: lines.join("\n"),
  };
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
  return [...MODEL_PRESETS, ...readCustomModels(rootDir)];
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
  return Array.isArray(saved) ? saved : [];
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
  return model;
}

export function removeCustomModel(rootDir, presetId) {
  const models = readCustomModels(rootDir).filter(
    (model) => model.presetId !== presetId,
  );
  writeCustomModels(rootDir, models);
  const selection = readSelection(rootDir).filter((id) => id !== presetId);
  saveSelection(rootDir, selection.length ? selection : defaultSelectedModelIds(MODE_HYBRID));
  return models;
}

export function writeRouterConfigFromSelection(rootDir, mode = MODE_HYBRID) {
  const config = buildRouterConfigFromSelection(rootDir, mode);
  const target = routerConfigPath(rootDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
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

  const routes = selected.map((model, index) =>
    routeForSelectedModel(model, CODEX_MODEL_SLOTS[index], index),
  );

  return {
    host: "127.0.0.1",
    port: 15722,
    authToken: "sk-local-codex-router",
    clientAuth: {
      allowOpenAiBearer: mode === MODE_HYBRID,
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
  mode,
  port = 15722,
  model = "gpt-5.5",
}) {
  const normalizedCatalogPath = toTomlPath(catalogPath(rootDir));
  const providerAuth =
    mode === MODE_HYBRID
      ? 'requires_openai_auth = true'
      : 'experimental_bearer_token = "sk-local-codex-router"';

  return [
    'model_provider = "codex-bridge"',
    `model = "${model}"`,
    `model_catalog_json = "${normalizedCatalogPath}"`,
    'model_reasoning_effort = "medium"',
    "disable_response_storage = true",
    'network_access = "enabled"',
    "windows_wsl_setup_acknowledged = true",
    "",
    "[model_providers.codex-bridge]",
    'name = "CodexBridge"',
    `base_url = "http://localhost:${port}/v1"`,
    'wire_api = "responses"',
    "supports_websockets = false",
    providerAuth,
    "",
  ].join("\n");
}

export function applyCodexConfig({
  rootDir,
  mode,
  port = 15722,
  homeDir = os.homedir(),
}) {
  const target = codexConfigPath(homeDir);
  const targetDir = path.dirname(target);
  fs.mkdirSync(targetDir, { recursive: true });
  const content = buildCodexToml({ rootDir, mode, port });

  if (fs.existsSync(target) && fs.readFileSync(target, "utf8") === content) {
    return { target, backup: null, unchanged: true };
  }

  let backup = null;
  if (fs.existsSync(target)) {
    backup = `${target}.codexbridge.${timestamp()}.bak`;
    fs.copyFileSync(target, backup);
  }

  fs.writeFileSync(target, content, "utf8");
  return { target, backup, unchanged: false };
}

export function restoreCodexConfig({ homeDir = os.homedir() } = {}) {
  const target = codexConfigPath(homeDir);
  const targetDir = path.dirname(target);
  if (!fs.existsSync(targetDir)) {
    throw new Error("没有找到 CodexBridge 写入前的备份，无法自动恢复 Codex 配置。");
  }

  const backups = fs
    .readdirSync(targetDir)
    .filter((name) => /^config\.toml\.codexbridge\..+\.bak$/.test(name))
    .map((name) => {
      const fullPath = path.join(targetDir, name);
      return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (!backups.length) {
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

export function recoverCodexHistoryAccess({ homeDir = os.homedir() } = {}) {
  const restored = restoreCodexConfig({ homeDir });
  return {
    ...restored,
    action: "recover_history_access",
    message: "已恢复 CodexBridge 写入前的 Codex 配置。重启 Codex 后，之前的历史对话通常会回到原来的列表视图。",
    nextStep: "请完全退出并重启 Codex；如果之后还要使用 CodexBridge，再回到本应用点击“更新 Codex 配置”并打开 Router。",
  };
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
    /\[model_providers\.codex-bridge]/.test(content)
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

function routeForSelectedModel(model, slot, priority) {
  const provider = providerById(model.providerId);
  const route = {
    id: slot.id,
    slotLabel: slot.label,
    sourcePresetId: model.presetId,
    provider: model.providerId,
    displayName: model.displayName,
    description: model.description || `${model.displayName} via ${provider?.name || model.providerName || model.providerId}.`,
    api: model.api,
    baseUrl: model.baseUrl,
    model: model.model,
    authMode: model.authMode || provider?.authMode || "api_key",
    contextWindow: model.contextWindow || 258400,
    priority,
  };
  if (route.authMode === "api_key") {
    route.apiKeyEnv = model.apiKeyEnv || model.keyEnv || provider?.keyEnv;
  }
  for (const key of [
    "rpm",
    "tpm",
    "dropParams",
    "inputModalities",
    "defaultReasoningLevel",
    "supportedReasoningLevels",
    "additionalSpeedTiers",
    "serviceTiers",
  ]) {
    if (model[key] !== undefined) {
      route[key] = model[key];
    }
  }
  if (model.custom && route.inputModalities === undefined) {
    route.inputModalities = normalizeInputModalities(model.inputModalities);
  }
  return route;
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
    inputModalities: normalizeInputModalities(input.inputModalities),
    dropParams:
      input.api === "responses" ? undefined : ["response_format", "parallel_tool_calls"],
    custom: true,
  };
}

function writeCustomModels(rootDir, models) {
  const target = customModelsPath(rootDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(models, null, 2)}\n`, "utf8");
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

function normalizeInputModalities(value) {
  const requested = Array.isArray(value) && value.length ? value : ["text", "image"];
  const normalized = [];
  for (const modality of requested) {
    if (!["text", "image"].includes(modality) || normalized.includes(modality)) {
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
  };
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
