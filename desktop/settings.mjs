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
  "disable_response_storage",
  "network_access",
  "openai_base_url",
  "windows_wsl_setup_acknowledged",
]);

const LEGACY_CODEX_BRIDGE_THREAD_SOURCES = [
  "codex-bridge",
  "codexbridge",
  "codex_bridge",
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
    "Codex history diagnostics:",
    ...historyDiagnostics.lines,
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
      history: historyDiagnostics.summary,
    },
    text: lines.join("\n"),
  };
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
        `legacyProvider=${item.legacyProvider}, legacySource=${item.legacySource}, archived=${item.archived}, ` +
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
            `archived=${row.archived} hasUserEvent=${row.has_user_event} title=${row.title}`,
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
    "title",
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
    title: redactSecretText(row.title || "(untitled)").slice(0, 80),
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
}) {
  const normalizedCatalogPath = toTomlPath(catalogPath(rootDir));

  return [
    'model_provider = "openai"',
    `model = "${model}"`,
    `model_catalog_json = "${normalizedCatalogPath}"`,
    'model_reasoning_effort = "medium"',
    "disable_response_storage = false",
    'network_access = "enabled"',
    `openai_base_url = "http://localhost:${port}/v1"`,
    "windows_wsl_setup_acknowledged = true",
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
  const bridgeContent = buildCodexToml({ rootDir, mode, port });
  const existingContent = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  const content = mergeCodexBridgeConfig(existingContent, bridgeContent);
  const historySync = syncCodexBridgeConversationProviders({ homeDir });

  if (fs.existsSync(target) && existingContent === content) {
    return { target, backup: null, unchanged: true, historySync };
  }

  let backup = null;
  if (fs.existsSync(target)) {
    backup = `${target}.codexbridge.${timestamp()}.bak`;
    fs.copyFileSync(target, backup);
  }

  fs.writeFileSync(target, content, "utf8");
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
      const hiddenLegacyMetadataThreads = countHiddenLegacyMetadataThreads(DatabaseSync, dbPath);
      const hiddenBackupReferencedThreads = countHiddenBackupReferencedThreads(DatabaseSync, dbPath);
      if (
        legacyThreads < 1 &&
        missingBackupThreads < 1 &&
        hiddenLegacyMetadataThreads < 1 &&
        hiddenBackupReferencedThreads < 1
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
        normalizeBackupReferencedThreadMetadata(DatabaseSync, dbPath);
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

function countHiddenLegacyMetadataThreads(DatabaseSync, dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 1500");
    if (!hasTable(db, "threads")) {
      return 0;
    }
    const columns = tableColumns(db, "threads");
    if (!columns.includes("model_provider") || !columns.includes("source")) {
      return 0;
    }
    return Number(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM threads " +
            "WHERE model_provider = ? " +
            `AND LOWER(source) IN (${legacyThreadSourceSqlList()})`,
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
          `WHEN source IS NULL OR source = '' OR LOWER(source) IN (${legacyThreadSourceSqlList()}) THEN 'vscode' ` +
          "ELSE source END",
      );
    }
    if (columns.includes("thread_source")) {
      assignments.push(
        "thread_source = CASE " +
          "WHEN thread_source IS NULL OR thread_source = '' THEN 'user' " +
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
    if (!columns.includes("model_provider") || !columns.includes("source")) {
      return 0;
    }
    const assignments = ["source = 'vscode'"];
    if (columns.includes("thread_source")) {
      assignments.push(
        "thread_source = CASE " +
          "WHEN thread_source IS NULL OR thread_source = '' THEN 'user' " +
          "ELSE thread_source END",
      );
    }
    addVisibleThreadAssignments(assignments, columns);
    const result = db
      .prepare(
        `UPDATE threads SET ${assignments.join(", ")} ` +
          "WHERE model_provider = ? " +
          `AND LOWER(source) IN (${legacyThreadSourceSqlList()})`,
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
          "WHEN source IS NULL OR source = '' THEN 'vscode' " +
          "ELSE source END",
      );
    }
    if (mainColumns.includes("thread_source")) {
      assignments.push(
        "thread_source = CASE " +
          "WHEN thread_source IS NULL OR thread_source = '' THEN 'user' " +
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
    predicates.push(`(${prefix}source IS NULL OR ${prefix}source = '' OR LOWER(${prefix}source) IN (${legacyThreadSourceSqlList()}))`);
  }
  if (columns.includes("thread_source")) {
    predicates.push(`(${prefix}thread_source IS NULL OR ${prefix}thread_source = '')`);
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
  const bridge = extractCodexBridgeConfig(bridgeContent);
  const cleanedBase = stripCodexBridgeConfig(baseContent || "");
  const { preamble, tables } = splitTomlPreamble(cleanedBase);
  const sections = [
    preamble.join("\n"),
    bridge.topLevelLines.join("\n"),
    bridge.providerLines.join("\n"),
    tables.join("\n"),
  ].filter((section) => section.trim());
  return `${sections.join("\n\n")}\n`;
}

function stripCodexBridgeConfig(content) {
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
      return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
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
