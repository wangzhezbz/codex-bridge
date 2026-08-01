import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MODEL_PRESETS,
  PROVIDERS,
  defaultSelectedModelIds,
  providerById,
} from "./presets.mjs";
import { normalizeAdapterProfile } from "../src/adapter-profile.js";
import { routeCapabilityMatrix, routeCapabilitySummary } from "../src/route-capability-matrix.js";
import {
  createCapabilityProviderRegistry,
  groupCapabilityProviders,
  runCapabilityProxy,
} from "../src/capability-proxy.js";
import { buildModelCatalog } from "../src/model-catalog.js";
import { fetchInitWithProxy, proxySettingsForUrl } from "../src/proxy.js";
import { routeDecisionSummaryForLog } from "../src/route-trace.js";
import {
  CODEX_BRIDGE_LEGACY_LOCAL_AUTH_TOKEN,
  CODEX_BRIDGE_PROVIDER_ID,
  codexBridgeProviderIdForMode,
  codexBridgeProviderTomlLinesForMode,
} from "./codex-provider.mjs";
import { createConfigWriteCoordinator } from "./config-write-coordinator.mjs";
import {
  buildConfigMutationDraft,
  inspectManagedCodexTomlBlock,
  materializeConfigMutationEntries,
  repairMalformedManagedCodexToml,
  removeUnmanagedCodexBridgeConflicts,
  removeManagedCodexTomlBlock,
  replaceManagedCodexTomlBlock,
} from "./config-mutation.mjs";
import {
  ConfigPackageValidationError,
  isApprovedCredentialTemplate,
  isCredentialFieldName,
  isCredentialUrlQueryKey,
  parseConfigPackageImport,
  validateConfigPackageImport,
} from "./config-import-validation.mjs";

export { validateConfigPackageImport };

export function parseConfigPackageImportCandidate(input) {
  return parseConfigPackageImport(input);
}
import { locateCodexCliSync, locateOpenAIDesktopSync } from "./codex-locator.mjs";
import { readCodexDesktopPluginPagePolicy } from "./codex-desktop-plugin-page-policy.mjs";
import { assetNameForPlatform } from "./updater.mjs";
import {
  applyCodexThreadCatalogRecovery,
  previewCodexThreadCatalogRecovery,
  probeCodexThreadCatalogWritable,
  restoreCodexThreadCatalogRecoveryBackup,
} from "./codex-thread-catalog-recovery.mjs";

const require = createRequire(import.meta.url);
const repoRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export {
  MODEL_PRESETS,
  PROVIDERS,
  defaultSelectedModelIds,
} from "./presets.mjs";

export {
  applyCodexThreadCatalogRecovery,
  previewCodexThreadCatalogRecovery,
  probeCodexThreadCatalogWritable,
  restoreCodexThreadCatalogRecoveryBackup,
};

export const MODE_ALL_API = "all_api";
export const MODE_HYBRID = "hybrid";

export const sharedConfigWriteCoordinator = createConfigWriteCoordinator();

const KNOWN_CAPABILITY_PROVIDER_GROUPS = [
  "image_generation",
  "ocr",
  "web_search",
  "browser",
  "computer_use",
  "file_processing",
  "webpage_screenshot",
  "speech",
  "video",
];

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
const CODEX_BRIDGE_ROUTER_ORIGINAL_MARKER = "# CodexBridge router original backup v1";
const CODEX_BRIDGE_MODEL_ID_PREFIX = "cb-";
const DEFAULT_CODEX_BRIDGE_MODEL_ID = "cb-gpt-5-6-sol";
const CODEX_BRIDGE_MODEL_CATALOG_FILENAME = "codexbridge-model-catalog.json";
const CODEX_MODELS_CACHE_FILENAME = "models_cache.json";
const DEFAULT_CHAT_TOOL_CONTINUATION_TURNS = 5;
const DUPLICATE_REQUEST_PROTECTION_POLICY_VERSION = 2;
const CODEX_CLI_RESOURCE_SNAPSHOT_CACHE_MS = 10000;
const CODEX_PROMPT_INPUT_SNAPSHOT_CACHE_MS = 10000;
const CODEX_APP_SERVER_RESOURCE_SNAPSHOT_CACHE_MS = 60000;
const CONFIG_PACKAGE_MAX_EMBEDDED_LOGO_BYTES = 256 * 1024;
const HISTORY_INLINE_THUMBNAIL_MAX_BYTES = 512 * 1024;
const CODEX_CONFIG_RESTORE_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_CAPABILITY_PROVIDER_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const PROVIDER_MODEL_DIRECTORY_TIMEOUT_MS = 15_000;
const PROVIDER_MODEL_REFRESH_REQUEST = Symbol("providerModelRefreshRequest");
const providerModelRefreshRequests = new Map();
const DEFAULT_CAPABILITY_ASSET_MAX_BYTES = 64 * 1024 * 1024;
const ROUTER_CONTROL_ENV_NAMES = new Set([
  "CODEXBRIDGE_DATA_DIR",
  "ROUTER_CONFIG",
  "CODEXBRIDGE_SECRETS_FILE",
]);
const PREFLIGHT_PROVIDER_TEST_STALE_DAYS = 7;
const PREFLIGHT_PROVIDER_TEST_STALE_MS = PREFLIGHT_PROVIDER_TEST_STALE_DAYS * 24 * 60 * 60 * 1000;
const CODEX_SETTINGS_PLUGIN_SOURCE_BY_SLUG = new Map([
  ["github", "openai-curated-remote"],
  ["supabase", "openai-curated-remote"],
  ["remotion", "openai-curated"],
  ["superpowers", "openai-curated"],
  ["hyperframes", "openai-curated"],
  ["hyperframes-by-heygen", "openai-curated"],
  ["game-studio", "openai-curated"],
]);
const CODEX_PLUGIN_PAGE_SKILL_EXCLUDED_PLUGIN_IDS = new Set([
  "computer-use@openai-bundled",
]);
const CODEX_PLUGIN_PAGE_HIDDEN_MARKETPLACES = new Set([
  "openai-bundled",
]);
const CODEX_RESOURCE_HIDDEN_MCP_SERVER_NAMES = new Set([
  "node_repl",
]);
const DELETE_SAFETY_SCAN_FILES = [
  ".github/workflows/desktop-portable.yml",
  "desktop/main.cjs",
  "desktop/updater.mjs",
  "scripts/installer/windows/CodexBridge.nsi",
  "scripts/package-windows.mjs",
  "scripts/package-windows-release-artifacts.mjs",
];
const FORBIDDEN_BATCH_DELETE_COMMANDS = [
  ["del /s", /\bdel\s+\/s\b/i],
  ["rd /s", /\brd\s+\/s\b/i],
  ["rmdir /s", /\brmdir\s+\/s\b/i],
  ["Remove-Item -Recurse", /\bRemove-Item\b[^\r\n]*\s-Recurse\b/i],
  ["rm -rf", /\brm\s+-[a-z]*r[a-z]*f[a-z]*\b/i],
];

let codexCliResourceSnapshotCache = null;
let codexPromptInputSnapshotCache = null;
let codexAppServerResourceSnapshotCache = null;

function invalidateCodexResourceSnapshotCaches() {
  codexCliResourceSnapshotCache = null;
  codexPromptInputSnapshotCache = null;
  codexAppServerResourceSnapshotCache = null;
}

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
const DESKTOP_SMART_RULE_KEYS = [
  "imageGeneration",
  "code",
  "longContext",
  "ordinaryChat",
];
const DESKTOP_SMART_RULE_LABELS = {
  imageGeneration: "生图请求",
  code: "代码任务",
  longContext: "长上下文",
  ordinaryChat: "普通聊天",
};
const DESKTOP_SMART_RULE_MODES = new Set(["auto", "route", "off"]);
const DESKTOP_SMART_FAILOVER_MODES = new Set(["auto", "ordered", "off"]);

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

export function capabilityProvidersPath(rootDir) {
  return path.join(rootDir, "config", "capability-providers.json");
}

export function imageProvidersPath(rootDir) {
  return path.join(rootDir, "config", "image-providers.json");
}

export function modelImageGenerationPath(rootDir) {
  return path.join(rootDir, "config", "model-image-generation.json");
}

export function configPackageSyncStatusPath(rootDir) {
  return path.join(rootDir, "config", "config-package-sync.local.json");
}

export function configPackageImportBackupDir(rootDir) {
  return path.join(rootDir, "config", "config-package-import-backups");
}

function listConfigPackageImportBackups(rootDir) {
  const directory = configPackageImportBackupDir(rootDir);
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    return [];
  }
  return fs.readdirSync(directory)
    .filter((fileName) => /^CodexBridge-config-before-import-\d{4}-\d{2}-\d{2}-\d+(?:-\d{3})?\.json$/i.test(fileName))
    .map((fileName) => {
      const fullPath = path.join(directory, fileName);
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) {
          return null;
        }
        return {
          fileName,
          fullPath,
          mtimeMs: stat.mtimeMs,
          updatedAt: stat.mtime.toISOString(),
          bytes: stat.size,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.fileName.localeCompare(a.fileName));
}

export function latestConfigPackageImportBackupPath(rootDir) {
  return listConfigPackageImportBackups(rootDir)[0]?.fullPath || "";
}

export function readConfigPackageImportBackupStatus(rootDir) {
  const directory = configPackageImportBackupDir(rootDir);
  const backups = listConfigPackageImportBackups(rootDir);
  if (!backups.length) {
    return null;
  }
  const latest = backups[0];
  return {
    ok: true,
    directoryName: safeConfigPackageBasename(directory),
    latestFileName: latest.fileName,
    latestUpdatedAt: latest.updatedAt,
    latestBytes: latest.bytes,
    backupCount: backups.length,
  };
}

export function readConfigPackageSyncStatus(rootDir) {
  const status = readJsonIfExists(configPackageSyncStatusPath(rootDir), null);
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    return null;
  }
  const fileName = safeConfigPackageBasename(status.fileName || status.filePath);
  const directoryName = safeConfigPackageBasename(status.directory);
  const exportedAt = String(status.exportedAt || "").trim();
  const filePath = String(status.filePath || "").trim();
  const fileExists = filePath ? fs.existsSync(filePath) : false;
  return {
    ok: Boolean(fileName || directoryName || exportedAt),
    fileName,
    directoryName,
    exportedAt,
    fileExists,
    includesSecrets: false,
    selectedModelCount: nonNegativeInteger(status.selectedModelCount),
    providerCount: nonNegativeInteger(status.providerCount),
    capabilityProviderCount: nonNegativeInteger(status.capabilityProviderCount),
    imageProviderCount: nonNegativeInteger(status.imageProviderCount),
    codexResourceCount: nullableNonNegativeInteger(status.codexResourceCount),
    embeddedLogoCount: nonNegativeInteger(status.embeddedLogoCount),
    requiredSecretKeyCount: nonNegativeInteger(status.requiredSecretKeyCount),
  };
}

export function latestConfigPackageSyncPackagePath(rootDir) {
  const status = readJsonIfExists(configPackageSyncStatusPath(rootDir), null);
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    return "";
  }
  const filePath = String(status.filePath || "").trim();
  if (!filePath || !/^CodexBridge-config-\d{4}-\d{2}-\d{2}-\d+\.json$/i.test(path.basename(filePath))) {
    return "";
  }
  const resolvedPath = path.resolve(filePath);
  const directory = String(status.directory || "").trim();
  if (directory && !isPathInside(resolvedPath, path.resolve(directory))) {
    return "";
  }
  try {
    const stat = fs.statSync(resolvedPath);
    return stat.isFile() ? resolvedPath : "";
  } catch {
    return "";
  }
}

export function importLatestConfigPackageFromSyncDirectory(rootDir, options = {}) {
  const filePath = latestConfigPackageSyncPackagePath(rootDir);
  if (!filePath) {
    throw new Error("没有可导入的同步目录配置包。请先导出到同步目录，或确认同步目录里的配置包文件仍然存在。");
  }
  const result = importConfigPackage(rootDir, fs.readFileSync(filePath, "utf8"), options);
  return {
    ...result,
    sourceFileName: path.basename(filePath),
    sourceDirectoryName: safeConfigPackageBasename(path.dirname(filePath)),
    message: `已从同步目录导入配置包：${path.basename(filePath)}。已先备份当前配置：${result.backupFileName}。`,
  };
}

export function configPackageSyncDirectory(rootDir) {
  const status = readJsonIfExists(configPackageSyncStatusPath(rootDir), null);
  const directory = String(status?.directory || "").trim();
  return directory ? path.resolve(directory) : "";
}

function safeConfigPackageBasename(value = "") {
  const raw = String(value || "").trim();
  return raw ? path.basename(raw) : "";
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function nullableNonNegativeInteger(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

export function imageOutputDirPath(rootDir) {
  return path.join(rootDir, "generated-images");
}

export function imageGenerationHistoryPath(rootDir) {
  return path.join(rootDir, "config", "image-generation-history.json");
}

export function capabilityExecutionHistoryPath(rootDir) {
  return path.join(rootDir, "config", "capability-execution-history.json");
}

export function readImageGenerationHistory(rootDir, options = {}) {
  const history = readJsonIfExists(imageGenerationHistoryPath(rootDir), {});
  const source = Array.isArray(history?.items) ? history.items : [];
  const items = source
    .map((item) => normalizeImageGenerationHistoryItem(item))
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
    .slice(0, Number(options.limit || 120));
  if (!options.includeThumbnails) {
    return items;
  }
  return items.map((item) => ({
    ...item,
    ...(imageHistoryThumbnail(item.localPath, item.mimeType, {
      allowedRoots: [imageOutputDirPath(rootDir)],
    }) || {}),
  }));
}

export function recordImageGenerationHistory(rootDir, item = {}) {
  const record = normalizeImageGenerationHistoryItem({
    ...item,
    id: item.id || `img_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    createdAt: item.createdAt || new Date().toISOString(),
  });
  if (!record || (!record.localPath && record.ok !== false)) {
    return null;
  }
  const historyPath = imageGenerationHistoryPath(rootDir);
  const existing = readImageGenerationHistory(rootDir);
  const items = [
    record,
    ...existing.filter((entry) =>
      entry.id !== record.id && (!record.localPath || entry.localPath !== record.localPath),
    ),
  ].slice(0, 120);
  writeJsonAtomic(historyPath, { version: 1, items });
  return record;
}

export function clearImageGenerationHistory(rootDir, options = {}) {
  const items = readImageGenerationHistory(rootDir);
  const { removeItems, keepItems } = splitImageGenerationHistoryForCleanup(items, options);
  let removedFiles = 0;
  if (options.deleteFiles) {
    const outputDir = path.resolve(imageOutputDirPath(rootDir));
    for (const item of removeItems) {
      const localPath = path.resolve(String(item.localPath || ""));
      const insideOutputDir = localPath === outputDir || localPath.startsWith(`${outputDir}${path.sep}`);
      if (!insideOutputDir || !fs.existsSync(localPath)) {
        continue;
      }
      const stat = fs.statSync(localPath);
      if (!stat.isFile()) {
        continue;
      }
      fs.unlinkSync(localPath);
      removedFiles += 1;
    }
  }
  writeJsonAtomic(imageGenerationHistoryPath(rootDir), { version: 1, items: keepItems });
  return {
    removedRecords: removeItems.length,
    removedFiles,
    keptRecords: keepItems.length,
  };
}

export function readCapabilityExecutionHistory(rootDir, options = {}) {
  const history = readJsonIfExists(capabilityExecutionHistoryPath(rootDir), {});
  const source = Array.isArray(history?.items) ? history.items : [];
  const items = source
    .map((item) => normalizeCapabilityExecutionHistoryItem(item))
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
    .slice(0, Number(options.limit || 200));
  if (!options.includeThumbnails) {
    return items;
  }
  return items.map((item) => {
    if (!item.localPath || !String(item.mimeType || "").startsWith("image/")) {
      return item;
    }
    return {
      ...item,
      ...(imageHistoryThumbnail(item.localPath, item.mimeType, {
        allowedRoots: [
          imageOutputDirPath(rootDir),
          path.join(rootDir, "generated-capability-assets"),
        ],
      }) || {}),
    };
  });
}

export function recordCapabilityExecutionHistory(rootDir, item = {}) {
  const record = normalizeCapabilityExecutionHistoryItem({
    ...item,
    id: item.id || `cap_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    createdAt: item.createdAt || new Date().toISOString(),
  });
  if (!record) {
    return null;
  }
  const historyPath = capabilityExecutionHistoryPath(rootDir);
  const existing = readCapabilityExecutionHistory(rootDir);
  const items = [
    record,
    ...existing.filter((entry) => entry.id !== record.id),
  ].slice(0, 200);
  writeJsonAtomic(historyPath, { version: 1, items });
  return record;
}

export function clearCapabilityExecutionHistory(rootDir, options = {}) {
  const items = readCapabilityExecutionHistory(rootDir);
  const { removeItems, keepItems } = splitImageGenerationHistoryForCleanup(items, options);
  let removedFiles = 0;
  if (options.deleteFiles) {
    const outputRoots = [
      path.resolve(imageOutputDirPath(rootDir)),
      path.resolve(path.join(rootDir, "generated-capability-assets")),
    ];
    for (const item of removeItems) {
      const localPath = path.resolve(String(item.localPath || ""));
      const insideOutputRoot = outputRoots.some((root) =>
        localPath === root || localPath.startsWith(`${root}${path.sep}`),
      );
      if (!insideOutputRoot || !fs.existsSync(localPath)) {
        continue;
      }
      const stat = fs.statSync(localPath);
      if (!stat.isFile()) {
        continue;
      }
      fs.unlinkSync(localPath);
      removedFiles += 1;
    }
  }
  writeJsonAtomic(capabilityExecutionHistoryPath(rootDir), { version: 1, items: keepItems });
  return {
    removedRecords: removeItems.length,
    removedFiles,
    keptRecords: keepItems.length,
  };
}

function splitImageGenerationHistoryForCleanup(items = [], options = {}) {
  const olderThanDays = Number(options.olderThanDays || 0);
  const keepLatest = Number(options.keepLatest || 0);
  if (!(olderThanDays > 0) && !(keepLatest > 0)) {
    return { removeItems: items, keepItems: [] };
  }

  const nowMs = Date.parse(options.now || new Date().toISOString());
  const cutoffMs = olderThanDays > 0 && Number.isFinite(nowMs)
    ? nowMs - olderThanDays * 24 * 60 * 60 * 1000
    : null;
  const removeItems = [];
  const keepItems = [];

  items.forEach((item, index) => {
    const createdMs = Date.parse(item.createdAt || "");
    const tooOld = cutoffMs !== null && Number.isFinite(createdMs) && createdMs < cutoffMs;
    const overLimit = keepLatest > 0 && index >= keepLatest;
    if (tooOld || overLimit) {
      removeItems.push(item);
    } else {
      keepItems.push(item);
    }
  });

  return { removeItems, keepItems };
}

function normalizeImageGenerationHistoryItem(item = {}) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }
  const localPath = String(item.localPath || "").trim();
  const createdAt = String(item.createdAt || "").trim() || new Date().toISOString();
  const errorMessage = String(item.errorMessage || item.error?.message || "").trim();
  const ok = item.ok === false || String(item.status || "").toLowerCase() === "failed"
    ? false
    : true;
  if (!localPath && ok !== false && !errorMessage) {
    return null;
  }
  return {
    id: String(item.id || `img_${Date.parse(createdAt) || Date.now()}`).trim(),
    ok,
    providerId: String(item.providerId || "").trim(),
    providerName: String(item.providerName || item.displayName || "图片供应商").trim(),
    sourceModel: String(item.sourceModel || item.route || "").trim(),
    prompt: String(item.prompt || "").trim(),
    localPath,
    mimeType: String(item.mimeType || "image/png").trim(),
    durationMs: Number.isFinite(Number(item.durationMs)) ? Math.max(0, Math.round(Number(item.durationMs))) : 0,
    errorCode: String(item.errorCode || item.error?.code || "").trim(),
    errorMessage,
    errorPhase: String(item.errorPhase || "").trim(),
    createdAt,
  };
}

function normalizeCapabilityExecutionHistoryItem(item = {}) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }
  const data = item.data && typeof item.data === "object" && !Array.isArray(item.data) ? item.data : {};
  const responseData = item.response?.data && typeof item.response.data === "object" && !Array.isArray(item.response.data)
    ? item.response.data
    : {};
  const filePath = String(
    item.filePath ||
      data.filePath ||
      responseData.filePath ||
      item.localPath ||
      item.savedResult?.localPath ||
      item.response?.localPath ||
      "",
  ).trim();
  const lineCount = Number(item.lineCount ?? data.lineCount ?? responseData.lineCount);
  const createdAt = String(item.createdAt || "").trim() || new Date().toISOString();
  const capability = String(item.capability || "").trim();
  const providerId = String(item.providerId || item.provider?.id || "").trim();
  const providerName = String(
    item.providerName ||
      item.provider?.displayName ||
      item.provider?.name ||
      providerId ||
      "能力供应商",
  ).trim();
  const outputText = shortCapabilityHistoryText(
    item.outputText ||
      item.response?.output_text ||
      item.text ||
      item.result ||
      item.answer ||
      item.error?.message ||
      "",
    600,
  );
  return {
    id: String(item.id || `cap_${Date.parse(createdAt) || Date.now()}`).trim(),
    ok: item.ok === undefined ? !item.failed : Boolean(item.ok),
    capability,
    providerId,
    providerName,
    sourceModel: String(item.sourceModel || item.context?.sourceModel || item.request?.sourceModel || "").trim(),
    requestId: String(item.requestId || item.context?.requestId || item.request?.requestId || "").trim(),
    inputSummary: shortCapabilityHistoryText(item.inputSummary || item.request?.input || item.input || "", 300),
    outputText,
    localPath: filePath,
    mimeType: String(item.mimeType || data.mimeType || responseData.mimeType || item.savedResult?.mimeType || item.response?.mimeType || "").trim(),
    fileName: String(item.fileName || data.fileName || responseData.fileName || "").trim(),
    lineCount: Number.isFinite(lineCount) ? Math.max(0, Math.round(lineCount)) : 0,
    preview: shortCapabilityHistoryText(item.preview || data.preview || responseData.preview || "", 600),
    sourceUrl: safeCapabilityHistorySourceUrl(item.sourceUrl || item.savedResult?.sourceUrl || item.response?.sourceUrl || ""),
    durationMs: Number.isFinite(Number(item.durationMs)) ? Math.max(0, Math.round(Number(item.durationMs))) : 0,
    errorCode: String(item.errorCode || item.normalizedError?.code || item.error?.code || "").trim(),
    errorPhase: String(item.errorPhase || "").trim(),
    createdAt,
  };
}

function shortCapabilityHistoryText(value, maxLength = 300) {
  let text = "";
  if (typeof value === "string") {
    text = value;
  } else if (value !== null && value !== undefined) {
    try {
      text = JSON.stringify(portableSecretObject(value));
    } catch {
      text = String(value);
    }
  }
  text = redactSecretText(String(text || "")).replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function safeCapabilityHistorySourceUrl(value = "") {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return redactSecretText(`${url.origin}${url.pathname}`).slice(0, 500);
    }
  } catch {
    // Fall back to conservative text cleanup below.
  }
  return redactSecretText(raw.split(/[?#]/)[0] || raw).slice(0, 500);
}

function imageHistoryThumbnail(localPath, mimeType = "image/png", options = {}) {
  const target = String(localPath || "").trim();
  if (!target || !fs.existsSync(target)) {
    return null;
  }
  const allowedRoots = Array.isArray(options.allowedRoots)
    ? options.allowedRoots.map((root) => String(root || "").trim()).filter(Boolean)
    : [];
  if (allowedRoots.length && !pathIsInsideAnyRoot(target, allowedRoots)) {
    return {
      thumbnailStatus: "outside_output_dir",
    };
  }
  const stat = fs.statSync(target);
  if (!stat.isFile()) {
    return null;
  }
  if (stat.size > HISTORY_INLINE_THUMBNAIL_MAX_BYTES) {
    return {
      thumbnailStatus: "too_large",
      thumbnailBytes: stat.size,
    };
  }
  return {
    thumbnailDataUrl: `data:${mimeType || "image/png"};base64,${fs.readFileSync(target).toString("base64")}`,
  };
}

function pathIsInsideAnyRoot(targetPath, roots = []) {
  const target = path.resolve(String(targetPath || ""));
  return roots.some((root) => {
    const resolvedRoot = path.resolve(String(root || ""));
    if (!resolvedRoot) {
      return false;
    }
    const relative = path.relative(resolvedRoot, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
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

export function codexRouterOriginalPath(homeDir = os.homedir()) {
  return path.join(homeDir, ".codex", "config.codexbridge-router-original.toml");
}

export function codexCatalogPath(homeDir = os.homedir()) {
  return path.join(homeDir, ".codex", CODEX_BRIDGE_MODEL_CATALOG_FILENAME);
}

export function codexModelsCachePath(homeDir = os.homedir()) {
  return path.join(homeDir, ".codex", CODEX_MODELS_CACHE_FILENAME);
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
  writeJsonAtomic(secretsPath(rootDir), clean);
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
  const current = loadDesktopOptions(rootDir);
  const incoming = options || {};
  const saved = normalizeDesktopOptions({
    ...current,
    ...incoming,
    smartRouting: mergeDesktopSmartRouting(current.smartRouting, incoming.smartRouting),
  });
  writeJsonAtomic(desktopOptionsPath(rootDir), saved);
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
  const normalized = normalizeConfigProfileForStorage(rootDir, {
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

export function exportConfigPackage(rootDir, options = {}) {
  const config = readRouterConfig(rootDir);
  const mode = options.mode || detectModeFromConfig(config);
  const status = secretStatus(rootDir);
  const desktopOptions = portableDesktopOptions(loadDesktopOptions(rootDir));
  const customModels = portableCustomModels(readCustomModels(rootDir), rootDir);
  const providerOverrides = portableProviderOverrides(readProviderOverrides(rootDir), rootDir);
  const capabilityProviders = portableCapabilityProviderConfig(readCapabilityProviderConfig(rootDir));
  const imageProviders = portableImageProviderConfig(readImageProviderConfig(rootDir));
  const modelImageGeneration = portableModelImageGenerationOverrides(readModelImageGenerationOverrides(rootDir));
  const codexResources = options.includeCodexResources === false
    ? null
    : portableCodexResourceManifest(rootDir, {
        homeDir: options.homeDir,
        codexCliSnapshot: options.codexCliSnapshot,
        includeCodexCliSnapshot: Boolean(options.includeCodexCliSnapshot),
        codexPromptInputSnapshot: options.codexPromptInputSnapshot,
        includeCodexPromptInputSnapshot: Boolean(options.includeCodexPromptInputSnapshot),
      });
  const pkg = {
    schema: "codexbridge.config-package",
    version: 1,
    exportedAt: new Date().toISOString(),
    includesSecrets: false,
    mode,
    selection: {
      mode,
      selectedModelIds: readSelection(rootDir, mode),
    },
    desktopOptions,
    customModels,
    providerOverrides,
    capabilityProviders,
    imageProviders,
    modelImageGeneration,
    embeddedLogoCount: configPackageEmbeddedLogoCount({
      customModels,
      providerOverrides,
    }),
    modelCapabilities: {
      imageInput: readModelImageInputOverrides(rootDir),
      overrides: readModelCapabilityOverrides(rootDir),
    },
    profiles: portableConfigProfiles(loadConfigProfiles(rootDir)),
    ...(codexResources ? { codexResources } : {}),
    secretKeys: Object.entries(status)
      .filter(([, saved]) => Boolean(saved))
      .map(([key]) => key)
      .sort(),
  };
  const portablePackage = {
    ...pkg,
    requiredSecretKeys: configPackageRequiredSecretKeys(pkg, config),
  };
  const validation = validateConfigPackageImport(portablePackage);
  if (!validation.ok) {
    throw new ConfigPackageValidationError(validation.issues);
  }
  return portablePackage;
}

export function exportConfigPackageToDirectory(rootDir, directory, options = {}) {
  const targetDir = path.resolve(String(directory || "").trim());
  if (!targetDir) {
    throw new Error("需要指定配置包同步目录。");
  }
  fs.mkdirSync(targetDir, { recursive: true });
  if (!fs.statSync(targetDir).isDirectory()) {
    throw new Error("配置包同步目标不是目录。");
  }
  const now = typeof options.now === "function" ? options.now() : options.now;
  const date = now ? new Date(now) : new Date();
  const pkg = exportConfigPackage(rootDir, options);
  const filePath = path.join(targetDir, `CodexBridge-config-${timestamp(date)}.json`);
  writeJsonAtomic(filePath, pkg);
  const result = {
    ok: true,
    directory: targetDir,
    filePath,
    fileName: path.basename(filePath),
    exportedAt: date.toISOString(),
    includesSecrets: false,
    selectedModelCount: pkg.selection?.selectedModelIds?.length || 0,
    providerCount: Object.keys(pkg.providerOverrides || {}).length,
    capabilityProviderCount: pkg.capabilityProviders?.providers?.length || 0,
    imageProviderCount: pkg.imageProviders?.providers?.length || 0,
    codexResourceCount: configPackageCodexResourceCount(pkg.codexResources),
    embeddedLogoCount: pkg.embeddedLogoCount || 0,
    requiredSecretKeyCount: pkg.requiredSecretKeys?.length || 0,
  };
  writeJsonAtomic(configPackageSyncStatusPath(rootDir), {
    version: 1,
    directory: result.directory,
    filePath: result.filePath,
    fileName: result.fileName,
    exportedAt: result.exportedAt,
    includesSecrets: result.includesSecrets,
    selectedModelCount: result.selectedModelCount,
    providerCount: result.providerCount,
    capabilityProviderCount: result.capabilityProviderCount,
    imageProviderCount: result.imageProviderCount,
    codexResourceCount: result.codexResourceCount,
    embeddedLogoCount: result.embeddedLogoCount,
    requiredSecretKeyCount: result.requiredSecretKeyCount,
  });
  return result;
}

function createConfigPackageImportBackup(rootDir, options = {}) {
  const createdAt = new Date();
  const { backupPath, fileName } = configPackageImportBackupTarget(rootDir, createdAt);
  const pkg = {
    ...exportConfigPackage(rootDir, {
      ...options,
      includeCodexResources: false,
    }),
    backupReason: "before_config_package_import",
    backupCreatedAt: createdAt.toISOString(),
  };
  writeJsonAtomic(backupPath, pkg);
  return {
    backupPath,
    backupFileName: fileName,
    backupCreatedAt: createdAt.toISOString(),
    includesSecrets: false,
  };
}

function configPackageImportBackupTarget(rootDir, createdAt) {
  const backupDir = configPackageImportBackupDir(rootDir);
  const baseFileName = `CodexBridge-config-before-import-${timestamp(createdAt)}`;
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? "" : `-${String(index).padStart(3, "0")}`;
    const fileName = `${baseFileName}${suffix}.json`;
    const backupPath = path.join(backupDir, fileName);
    if (!fs.existsSync(backupPath)) {
      return { backupPath, fileName };
    }
  }
  throw new Error("无法创建唯一的导入前备份文件名。请稍后重试，或先清理过多的同一时间备份文件。");
}

export function configPackageCodexResourceCount(resources = {}) {
  const summary = resources?.summary || {};
  if (
    ["mcpServers", "plugins", "skills"].some((kind) =>
      summary[kind] === null || resources?.readStatus?.[kind]?.ok === false,
    )
  ) {
    return null;
  }
  return [
    summary.mcpServers,
    summary.plugins,
    summary.skills,
    summary.prompts,
    summary.agentFiles,
  ].reduce((total, value) => total + Math.max(0, Number(value) || 0), 0);
}

function configPackageEmbeddedLogoCount(value) {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + configPackageEmbeddedLogoCount(item), 0);
  }
  if (!value || typeof value !== "object") {
    return 0;
  }
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (key === "logoUrl") {
      if (typeof item === "string" && /^data:image\//i.test(item)) {
        count += 1;
      }
      continue;
    }
    count += configPackageEmbeddedLogoCount(item);
  }
  return count;
}

function portableCapabilityProviderConfig(config = {}) {
  const providers = Array.isArray(config.providers)
    ? config.providers.map((provider) => {
        const { lastTest: _lastTest, ...portable } = portableSecretObject(provider || {});
        if (isLocalCapabilityProvider(portable)) {
          portable.defaults = portableLocalCapabilityDefaults(portable.defaults);
        }
        return portable;
      })
    : [];
  return {
    version: 1,
    defaults: plainObject(config.defaults),
    providers,
  };
}

function portableLocalCapabilityDefaults(defaults = {}) {
  if (Array.isArray(defaults)) {
    return defaults.map((item) => portableLocalCapabilityDefaults(item));
  }
  if (!defaults || typeof defaults !== "object") {
    return defaults;
  }
  const result = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (isLocalCapabilityPathKey(key)) {
      continue;
    }
    result[key] = portableLocalCapabilityDefaults(value);
  }
  return result;
}

function isLocalCapabilityPathKey(key = "") {
  const normalized = String(key || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  return [
    "path",
    "paths",
    "filepath",
    "filepaths",
    "inputpath",
    "inputpaths",
    "outputpath",
    "outputpaths",
    "outputdir",
    "outputdirectory",
    "file",
    "files",
    "directory",
    "directories",
    "dir",
    "dirs",
    "folder",
    "folders",
    "workspace",
    "workspacepath",
    "downloadpath",
    "screenshotpath",
  ].includes(normalized);
}

function portableCustomModels(models = [], rootDir = "") {
  return Array.isArray(models)
    ? models.map((model) => portableLogoObject(model, rootDir))
    : [];
}

function portableProviderOverrides(overrides = {}, rootDir = "") {
  const result = {};
  for (const [providerId, override] of Object.entries(overrides || {})) {
    if (!override || typeof override !== "object" || Array.isArray(override)) {
      continue;
    }
    result[providerId] = portableLogoObject(override, rootDir);
  }
  return result;
}

function portableLogoObject(value = {}, rootDir = "") {
  const result = portableSecretObject(value);
  if (result.logoUrl) {
    const portableLogoUrl = portableLogoUrlValue(result.logoUrl, rootDir);
    if (portableLogoUrl) {
      result.logoUrl = portableLogoUrl;
    } else {
      delete result.logoUrl;
    }
  }
  return result;
}

function portableLogoUrlValue(value = "", rootDir = "") {
  const logoUrl = String(value || "").trim();
  if (isPortableLogoUrl(logoUrl)) {
    return logoUrl;
  }
  return managedLogoFileDataUrl(logoUrl, rootDir);
}

function providerLogoSafetyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertProviderLogoByteLimit(size, maxBytes) {
  const byteLength = Number(size);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw providerLogoSafetyError(
      "provider_logo_file_unsafe",
      "Unsafe provider logo file size.",
    );
  }
  if (byteLength > maxBytes) {
    throw providerLogoSafetyError(
      "provider_logo_file_too_large",
      `Provider logo exceeds the ${maxBytes}-byte size limit.`,
    );
  }
  return byteLength;
}

function assertSingleLinkProviderLogoFile(stat) {
  if (stat?.isSymbolicLink?.()) {
    throw providerLogoSafetyError(
      "provider_logo_file_unsafe",
      "Unsafe provider logo: symbolic links are not allowed.",
    );
  }
  if (!stat?.isFile?.()) {
    throw providerLogoSafetyError(
      "provider_logo_file_unsafe",
      "Unsafe provider logo: a regular file is required.",
    );
  }
  if (Number(stat.nlink) !== 1) {
    throw providerLogoSafetyError(
      "provider_logo_file_unsafe",
      "Unsafe provider logo: only single-link files are allowed.",
    );
  }
}

function sameProviderLogoFileSnapshot(expected, actual) {
  return String(expected?.dev) === String(actual?.dev) &&
    String(expected?.ino) === String(actual?.ino) &&
    Number(expected?.size) === Number(actual?.size) &&
    Number(expected?.nlink) === Number(actual?.nlink) &&
    Number(expected?.mtimeMs) === Number(actual?.mtimeMs) &&
    Number(expected?.ctimeMs) === Number(actual?.ctimeMs);
}

function providerLogoChangedError() {
  return providerLogoSafetyError(
    "provider_logo_file_changed",
    "Unsafe provider logo: file identity or size changed while it was being read.",
  );
}

function readProviderLogoFileSafely(sourcePath, {
  maxBytes = CONFIG_PACKAGE_MAX_EMBEDDED_LOGO_BYTES,
} = {}) {
  const limit = Number(maxBytes);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TypeError("Provider logo byte limit must be a positive integer.");
  }
  const source = path.resolve(String(sourcePath || "").trim());
  const checked = fs.lstatSync(source);
  assertSingleLinkProviderLogoFile(checked);
  assertProviderLogoByteLimit(checked.size, limit);

  const noFollow = Number(fs.constants.O_NOFOLLOW) || 0;
  let descriptor = null;
  try {
    descriptor = fs.openSync(source, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    assertSingleLinkProviderLogoFile(opened);
    assertProviderLogoByteLimit(opened.size, limit);
    if (!sameProviderLogoFileSnapshot(checked, opened)) {
      throw providerLogoChangedError();
    }

    const bytes = fs.readFileSync(descriptor);
    const afterRead = fs.fstatSync(descriptor);
    let afterPath;
    try {
      afterPath = fs.lstatSync(source);
    } catch {
      throw providerLogoChangedError();
    }
    assertSingleLinkProviderLogoFile(afterRead);
    assertSingleLinkProviderLogoFile(afterPath);
    const finalSize = assertProviderLogoByteLimit(afterRead.size, limit);
    assertProviderLogoByteLimit(afterPath.size, limit);
    if (
      !sameProviderLogoFileSnapshot(opened, afterRead) ||
      !sameProviderLogoFileSnapshot(afterRead, afterPath) ||
      bytes.length !== finalSize
    ) {
      throw providerLogoChangedError();
    }
    return bytes;
  } finally {
    if (descriptor !== null) {
      fs.closeSync(descriptor);
    }
  }
}

function pathIsWithin(candidatePath, parentPath) {
  const relative = path.relative(comparablePath(parentPath), comparablePath(candidatePath));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function lstatProviderLogoPath(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function assertSafeProviderLogoDirectory(directoryPath, physicalRoot) {
  const stat = lstatProviderLogoPath(directoryPath);
  if (!stat) {
    return false;
  }
  if (stat.isSymbolicLink?.()) {
    throw providerLogoSafetyError(
      "provider_logo_path_unsafe",
      "Unsafe provider logo path: symbolic links and junctions are not allowed.",
    );
  }
  if (!stat.isDirectory?.()) {
    throw providerLogoSafetyError(
      "provider_logo_path_unsafe",
      "Unsafe provider logo path: every parent must be a directory.",
    );
  }
  const physicalPath = fs.realpathSync.native(directoryPath);
  if (!pathIsWithin(physicalPath, physicalRoot)) {
    throw providerLogoSafetyError(
      "provider_logo_path_unsafe",
      "Provider logo path resolves outside the managed data directory.",
    );
  }
  return true;
}

function assertManagedProviderLogoPath(rootDir, targetPath, {
  allowMissingTarget = false,
} = {}) {
  const root = path.resolve(String(rootDir || ""));
  const managedDirectory = path.join(root, "config", "provider-logos");
  const target = path.resolve(String(targetPath || ""));
  const targetRelative = path.relative(
    comparablePath(managedDirectory),
    comparablePath(target),
  );
  if (
    !targetRelative ||
    targetRelative === ".." ||
    targetRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(targetRelative)
  ) {
    throw providerLogoSafetyError(
      "provider_logo_target_invalid",
      "Provider logo target is outside the managed logo directory.",
    );
  }

  const rootStat = lstatProviderLogoPath(root);
  if (!rootStat || rootStat.isSymbolicLink?.() || !rootStat.isDirectory?.()) {
    throw providerLogoSafetyError(
      "provider_logo_path_unsafe",
      "Unsafe provider logo root: a real directory is required.",
    );
  }
  const physicalRoot = fs.realpathSync.native(root);
  const parentRelative = path.relative(root, path.dirname(target));
  let current = root;
  let missingParent = false;
  for (const segment of parentRelative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const exists = assertSafeProviderLogoDirectory(current, physicalRoot);
    if (!exists) {
      missingParent = true;
    } else if (missingParent) {
      throw providerLogoSafetyError(
        "provider_logo_path_unsafe",
        "Unsafe provider logo path changed while it was being checked.",
      );
    }
  }

  const targetStat = lstatProviderLogoPath(target);
  if (!targetStat) {
    if (!allowMissingTarget) {
      throw providerLogoSafetyError(
        "provider_logo_file_unsafe",
        "Unsafe provider logo: the managed file does not exist.",
      );
    }
    return target;
  }
  if (missingParent) {
    throw providerLogoSafetyError(
      "provider_logo_path_unsafe",
      "Unsafe provider logo path changed while it was being checked.",
    );
  }
  assertSingleLinkProviderLogoFile(targetStat);
  const physicalTarget = fs.realpathSync.native(target);
  const physicalManagedDirectory = fs.realpathSync.native(managedDirectory);
  if (!pathIsWithin(physicalTarget, physicalManagedDirectory)) {
    throw providerLogoSafetyError(
      "provider_logo_path_unsafe",
      "Provider logo file resolves outside the managed logo directory.",
    );
  }
  return target;
}

function unlinkSingleProviderLogoTemp(tempPath) {
  try {
    fs.unlinkSync(tempPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function writeProviderLogoAtomic(rootDir, targetPath, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  assertProviderLogoByteLimit(bytes.length, CONFIG_PACKAGE_MAX_EMBEDDED_LOGO_BYTES);
  const target = assertManagedProviderLogoPath(rootDir, targetPath, {
    allowMissingTarget: true,
  });
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor = null;
  let removeTemp = false;
  try {
    descriptor = fs.openSync(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    removeTemp = true;
    const opened = fs.fstatSync(descriptor);
    assertSingleLinkProviderLogoFile(opened);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    const written = fs.fstatSync(descriptor);
    assertSingleLinkProviderLogoFile(written);
    if (
      String(opened.dev) !== String(written.dev) ||
      String(opened.ino) !== String(written.ino) ||
      Number(written.size) !== bytes.length
    ) {
      throw providerLogoChangedError();
    }
    fs.closeSync(descriptor);
    descriptor = null;

    const tempStat = fs.lstatSync(temp);
    assertSingleLinkProviderLogoFile(tempStat);
    if (
      String(written.dev) !== String(tempStat.dev) ||
      String(written.ino) !== String(tempStat.ino) ||
      Number(tempStat.size) !== bytes.length
    ) {
      throw providerLogoChangedError();
    }
    assertManagedProviderLogoPath(rootDir, temp, { allowMissingTarget: false });
    assertManagedProviderLogoPath(rootDir, target, { allowMissingTarget: true });
    fs.renameSync(temp, target);
    removeTemp = false;

    const committed = fs.lstatSync(target);
    assertSingleLinkProviderLogoFile(committed);
    if (
      String(tempStat.dev) !== String(committed.dev) ||
      String(tempStat.ino) !== String(committed.ino) ||
      Number(committed.size) !== bytes.length
    ) {
      throw providerLogoChangedError();
    }
  } finally {
    if (descriptor !== null) {
      fs.closeSync(descriptor);
    }
    if (removeTemp) {
      unlinkSingleProviderLogoTemp(temp);
    }
  }
}

function managedLogoFileDataUrl(value = "", rootDir = "") {
  if (!rootDir) {
    return "";
  }
  let filePath = "";
  try {
    filePath = /^file:/i.test(String(value || ""))
      ? fileURLToPath(value)
      : path.isAbsolute(String(value || ""))
        ? String(value || "")
        : "";
  } catch {
    return "";
  }
  if (!filePath) {
    return "";
  }
  const resolvedFile = path.resolve(filePath);
  let bytes;
  try {
    assertManagedProviderLogoPath(rootDir, resolvedFile, { allowMissingTarget: false });
    bytes = readProviderLogoFileSafely(resolvedFile, {
      maxBytes: CONFIG_PACKAGE_MAX_EMBEDDED_LOGO_BYTES,
    });
  } catch {
    return "";
  }
  const mimeType = logoMimeType(resolvedFile);
  if (!mimeType) {
    return "";
  }
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function comparablePath(value = "") {
  const normalized = path.resolve(String(value || ""));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function logoMimeType(filePath = "") {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  if (ext === ".gif") {
    return "image/gif";
  }
  if (ext === ".svg") {
    return "image/svg+xml";
  }
  if (ext === ".ico") {
    return "image/x-icon";
  }
  return "";
}

function portableSecretObject(value = {}, fieldName = "") {
  if (Array.isArray(value)) {
    return value
      .map((item) => portableSecretObject(item, fieldName))
      .filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string") {
      if (looksLikeEmbeddedProviderCredential(value)) {
        return undefined;
      }
      try {
        const parsed = new URL(value);
        if (providerUrlContainsCredential(parsed)) {
          return undefined;
        }
      } catch {
        // Non-URL strings are validated by the strict package self-check.
      }
    }
    return value;
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (isCredentialFieldName(key)) {
      if (typeof item === "string" && isApprovedCredentialTemplate(item)) {
        result[key] = item.trim();
      }
      continue;
    }
    const portable = portableSecretObject(item, key);
    if (portable !== undefined) {
      result[key] = portable;
    }
  }
  return Object.keys(result).length || Object.keys(value).length === 0 ? result : undefined;
}

function isPortableLogoUrl(value = "") {
  const logoUrl = String(value || "").trim();
  return /^https?:\/\//i.test(logoUrl) || /^data:image\//i.test(logoUrl);
}

function portableImageProviderConfig(config = {}) {
  const providers = Array.isArray(config.providers)
    ? config.providers.map((provider) => {
        const { lastTest: _lastTest, ...portable } = portableSecretObject(provider || {});
        return portable;
      })
    : [];
  return {
    version: 1,
    defaultProviderId: String(config.defaultProviderId || "").trim(),
    providers,
  };
}

function portableModelImageGenerationOverrides(overrides = {}) {
  const result = {};
  for (const [presetId, value] of Object.entries(overrides || {})) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const {
      apiKey: _apiKey,
      outputDir: _outputDir,
      historyPath: _historyPath,
      lastTest: _lastTest,
      ...portable
    } = value;
    result[presetId] = portableSecretObject(portable);
  }
  return result;
}

function portableDesktopOptions(options = {}) {
  const {
    acceptanceReleaseDir: _acceptanceReleaseDir,
    codexDesktopExe: _codexDesktopExe,
    codexDesktopLaunchTarget: _codexDesktopLaunchTarget,
    ...portable
  } = options || {};
  return portable;
}

function portableConfigProfiles(profiles = []) {
  return Array.isArray(profiles)
    ? profiles
      .map((profile) => {
        const normalized = normalizeConfigProfile({
          ...profile,
          desktopOptions: portableDesktopOptions(profile?.desktopOptions || {}),
        });
        return normalized
          ? {
              ...normalized,
              desktopOptions: portableDesktopOptions(normalized.desktopOptions),
            }
          : null;
      })
      .filter(Boolean)
    : [];
}

function portableCodexResourceManifest(rootDir, {
  homeDir = os.homedir(),
  codexCliSnapshot = null,
  includeCodexCliSnapshot = false,
  codexPromptInputSnapshot = null,
  includeCodexPromptInputSnapshot = false,
} = {}) {
  let resources = null;
  try {
    resources = listCodexResources({
      rootDir,
      homeDir,
      codexCliSnapshot,
      includeCodexCliSnapshot,
      codexPromptInputSnapshot,
      includeCodexPromptInputSnapshot,
    });
  } catch {
    return null;
  }
  const summary = resources?.summary || {};
  const mcpServers = portableResourceItems(resources?.mcpServers, portableMcpServerItem);
  const plugins = portableResourceItems(resources?.plugins, portablePluginItem);
  const skills = portableResourceItems(resources?.skills, portableSkillItem);
  const prompts = portableResourceItems(resources?.prompts, portablePromptItem);
  const agentFiles = portableResourceItems(resources?.agentFiles, portableAgentFileItem);
  const resourceCount = configPackageCodexResourceCount(resources);
  if (
    resourceCount !== null &&
    !mcpServers.length &&
    !plugins.length &&
    !skills.length &&
    !prompts.length &&
    !agentFiles.length
  ) {
    return null;
  }
  return {
    version: 1,
    portableOnly: true,
    autoApply: false,
    note: "This manifest is for migration diagnostics only. Importing it does not enable MCP servers, plugins, skills, prompts, or AGENTS rules on the target machine.",
    summary: {
      mcpServers: portableResourceSummaryCount(summary.mcpServers),
      plugins: portableResourceSummaryCount(summary.plugins),
      skills: portableResourceSummaryCount(summary.skills),
      prompts: portableResourceSummaryCount(summary.prompts),
      agentFiles: portableResourceSummaryCount(summary.agentFiles),
    },
    readStatus: portableCodexResourceReadStatus(resources?.readStatus),
    mcpServers,
    plugins,
    skills,
    prompts,
    agentFiles,
  };
}

function portableResourceSummaryCount(value) {
  if (value === null) {
    return null;
  }
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : null;
}

function portableCodexResourceReadStatus(readStatus = {}) {
  const result = {};
  for (const kind of ["plugins", "mcpServers", "skills", "marketplaces"]) {
    const status = readStatus?.[kind];
    if (!status || typeof status !== "object" || Array.isArray(status)) {
      continue;
    }
    const ok = status.ok === true;
    result[kind] = stripEmptyPortableResourceFields({
      ok,
      state: ok ? "ok" : "unavailable",
      source: portableResourceText(status.source),
      code: portableResourceText(status.code || (ok ? "ok" : "unavailable")),
      reason: boundedCodexReadReason(portableResourceText(status.reason)),
    });
  }
  return result;
}

function portableResourceItems(items = [], mapper) {
  return (Array.isArray(items) ? items : [])
    .map(mapper)
    .filter(Boolean)
    .slice(0, 200);
}

function portableMcpServerItem(item = {}) {
  const name = String(item.name || "").trim();
  if (!name) {
    return null;
  }
  return stripEmptyPortableResourceFields({
    name,
    description: portableResourceText(item.description),
    purpose: portableResourceText(item.purpose),
    source: portableResourceText(item.source),
    availability: portableResourceText(item.availability || "enabled"),
    enabled: item.enabled !== false,
  });
}

function portablePluginItem(item = {}) {
  const id = String(item.id || "").trim();
  if (!id) {
    return null;
  }
  return stripEmptyPortableResourceFields({
    id,
    name: portableResourceText(item.name),
    description: portableResourceText(item.description),
    purpose: portableResourceText(item.purpose),
    source: portableResourceText(item.pluginSource || item.source),
    availability: portableResourceText(item.availability || "enabled"),
    enabled: item.enabled !== false,
    version: portableResourceText(item.version),
  });
}

function portableSkillItem(item = {}) {
  const name = String(item.name || "").trim();
  if (!name) {
    return null;
  }
  return stripEmptyPortableResourceFields({
    name,
    description: portableResourceText(item.description),
    purpose: portableResourceText(item.purpose),
    source: portableResourceText(item.source),
    availability: portableResourceText(item.availability || "enabled"),
    enabled: item.enabled !== false,
  });
}

function portablePromptItem(item = {}) {
  const name = String(item.name || item.title || "").trim();
  if (!name) {
    return null;
  }
  return stripEmptyPortableResourceFields({
    name,
    description: portableResourceText(item.description),
    source: portableResourceText(item.source),
    availability: portableResourceText(item.availability || "enabled"),
  });
}

function portableAgentFileItem(item = {}) {
  const name = String(item.name || item.fileName || "AGENTS.md").trim();
  return stripEmptyPortableResourceFields({
    name,
    description: portableResourceText(item.description),
    source: portableResourceText(item.source),
    availability: portableResourceText(item.availability || "enabled"),
  });
}

function portableResourceText(value = "") {
  return String(value || "")
    .replace(/[A-Za-z]:[\\/][^\s"'<>]+/g, "[local path]")
    .replace(/\\\\\?\\[^\s"'<>]+/g, "[local path]")
    .replace(/\/(?:Users|home)\/[^\s"'<>]+/g, "[local path]")
    .replace(/\b[^\s"'<>\\/]+\.exe\b/gi, "[local command]")
    .trim()
    .slice(0, 500);
}

function stripEmptyPortableResourceFields(item = {}) {
  const result = {};
  for (const [key, value] of Object.entries(item)) {
    if (value === "" || value === undefined || value === null) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

export function importConfigPackage(rootDir, input = {}, _options = {}) {
  const pkg = normalizeConfigPackage(input);
  const backup = createConfigPackageImportBackup(rootDir, _options);
  const mode = pkg.selection?.mode || pkg.mode || MODE_HYBRID;
  const imported = [];
  if (Array.isArray(pkg.selection?.selectedModelIds)) {
    saveSelection(rootDir, pkg.selection.selectedModelIds, mode);
    imported.push("模型选择");
  }
  if (pkg.desktopOptions && typeof pkg.desktopOptions === "object" && !Array.isArray(pkg.desktopOptions)) {
    saveDesktopOptions(rootDir, portableDesktopOptions(pkg.desktopOptions));
    imported.push("桌面设置");
  }
  if (Array.isArray(pkg.customModels)) {
    const models = pkg.customModels
      .map((model) => normalizeSavedCustomModel(portableLogoObject(model)))
      .filter(Boolean);
    writeCustomModels(rootDir, models);
    imported.push("自定义模型");
  }
  if (pkg.providerOverrides && typeof pkg.providerOverrides === "object" && !Array.isArray(pkg.providerOverrides)) {
    const overrides = {};
    for (const [providerId, value] of Object.entries(pkg.providerOverrides)) {
      const normalized = normalizeProviderOverride({
        ...portableLogoObject(value),
        id: value?.id || providerId,
      });
      if (normalized) {
        overrides[providerId] = normalized;
      }
    }
    writeJsonAtomic(providerOverridesPath(rootDir), {
      version: 1,
      providers: overrides,
    });
    imported.push("供应商设置");
  }
  if (pkg.capabilityProviders && typeof pkg.capabilityProviders === "object" && !Array.isArray(pkg.capabilityProviders)) {
    saveCapabilityProviderConfig(rootDir, portableCapabilityProviderConfig(pkg.capabilityProviders));
    imported.push("能力供应商");
  }
  if (pkg.imageProviders && typeof pkg.imageProviders === "object" && !Array.isArray(pkg.imageProviders)) {
    saveImageProviderConfig(rootDir, portableImageProviderConfig(pkg.imageProviders));
    imported.push("图片供应商");
  }
  if (pkg.modelImageGeneration && typeof pkg.modelImageGeneration === "object" && !Array.isArray(pkg.modelImageGeneration)) {
    const overrides = {};
    for (const [presetId, value] of Object.entries(portableModelImageGenerationOverrides(pkg.modelImageGeneration))) {
      try {
        overrides[presetId] = normalizeImageGenerationSettings(value);
      } catch {
        // Ignore invalid package entries instead of blocking the full import.
      }
    }
    writeJsonAtomic(modelImageGenerationPath(rootDir), {
      version: 1,
      imageGeneration: overrides,
    });
    imported.push("生图代理设置");
  }
  if (pkg.modelCapabilities && typeof pkg.modelCapabilities === "object" && !Array.isArray(pkg.modelCapabilities)) {
    const imageInput = {};
    for (const [presetId, enabled] of Object.entries(pkg.modelCapabilities.imageInput || {})) {
      if (typeof enabled === "boolean") {
        imageInput[presetId] = enabled;
      }
    }
    const overrides = {};
    for (const [presetId, value] of Object.entries(pkg.modelCapabilities.overrides || {})) {
      const normalized = normalizeModelCapabilityOverride(value, { keepUpdatedAt: true });
      if (normalized) {
        overrides[presetId] = normalized;
      }
    }
    writeModelCapabilities(rootDir, { imageInput, overrides });
    imported.push("模型能力");
  }
  if (Array.isArray(pkg.profiles)) {
    const profiles = portableConfigProfiles(pkg.profiles);
    writeJsonAtomic(configProfilesPath(rootDir), {
      version: 1,
      profiles,
    });
    imported.push("配置档");
  }
  const config = writeRouterConfigFromSelection(rootDir, mode);
  const requiredSecretKeys = configPackageRequiredSecretKeys(pkg, config);
  const secretMap = loadSecrets(rootDir);
  const missingSecretKeys = requiredSecretKeys.filter((key) => !(secretMap[key] || process.env[key]));
  const keyMessage = missingSecretKeys.length
    ? `需要重填 Key：${missingSecretKeys.join("、")}。`
    : "API Key 未导入；本机已有需要的 Key。";
  const resourceMessage = pkg.codexResources?.portableOnly
    ? "Codex 资源清单已随包导入为迁移参考；不会自动启用 MCP、插件、Skills、提示词或 AGENTS 规则。"
    : "";
  return {
    ok: true,
    mode,
    imported,
    requiredSecretKeys,
    missingSecretKeys,
    modelCount: Array.isArray(config?.models) ? config.models.length : 0,
    secretsImported: false,
    backupPath: backup.backupPath,
    backupFileName: backup.backupFileName,
    backupCreatedAt: backup.backupCreatedAt,
    resourceManifest: pkg.codexResources?.portableOnly ? pkg.codexResources : null,
    message: `配置包已导入：${imported.join("、") || "没有可导入项"}。已先备份当前配置：${backup.backupFileName}。${keyMessage}${resourceMessage ? ` ${resourceMessage}` : ""}`,
  };
}

export function restoreLatestConfigPackageImportBackup(rootDir, options = {}) {
  const backupPath = latestConfigPackageImportBackupPath(rootDir);
  if (!backupPath) {
    throw new Error("没有可恢复的导入前备份。导入配置包后，CodexBridge 才会自动生成可恢复的本机备份。");
  }
  const restoredBackupFileName = path.basename(backupPath);
  const restoredPackage = fs.readFileSync(backupPath, "utf8");
  const result = importConfigPackage(rootDir, restoredPackage, options);
  return {
    ...result,
    restoredBackupFileName,
    message: `已恢复导入前备份：${restoredBackupFileName}。恢复前已先备份当前配置：${result.backupFileName}。`,
  };
}

export function previewConfigPackageImport(rootDir, input = {}) {
  const pkg = parseConfigPackageImport(input);
  const mode = pkg.selection?.mode || pkg.mode || MODE_HYBRID;
  const selectedModelCount = Array.isArray(pkg.selection?.selectedModelIds)
    ? pkg.selection.selectedModelIds.length
    : 0;
  const customModelCount = Array.isArray(pkg.customModels) ? pkg.customModels.length : 0;
  const providerOverrideCount = pkg.providerOverrides && typeof pkg.providerOverrides === "object" && !Array.isArray(pkg.providerOverrides)
    ? Object.keys(pkg.providerOverrides).length
    : 0;
  const capabilityProviderCount = Array.isArray(pkg.capabilityProviders?.providers)
    ? pkg.capabilityProviders.providers.length
    : 0;
  const imageProviderCount = Array.isArray(pkg.imageProviders?.providers)
    ? pkg.imageProviders.providers.length
    : 0;
  const imageGenerationOverrideCount = Object.keys(plainObject(pkg.modelImageGeneration)).length;
  const capabilityOverrideCount = Object.keys(plainObject(pkg.modelCapabilities?.overrides)).length +
    Object.keys(plainObject(pkg.modelCapabilities?.imageInput)).length;
  const profileCount = Array.isArray(pkg.profiles) ? pkg.profiles.length : 0;
  const usageBudgetCount = usageBudgetScopeSummaries(pkg.desktopOptions?.usageBudgets || {}).length;
  const codexResourceCount = configPackageCodexResourceCount(pkg.codexResources);
  const requiredSecretKeys = configPackageRequiredSecretKeys(pkg, null);
  const secretMap = loadSecrets(rootDir);
  const missingSecretKeys = requiredSecretKeys.filter((key) => !(secretMap[key] || process.env[key]));
  const imported = [];
  if (selectedModelCount) imported.push("模型选择");
  if (pkg.desktopOptions && typeof pkg.desktopOptions === "object" && !Array.isArray(pkg.desktopOptions)) imported.push("桌面设置");
  if (customModelCount) imported.push("自定义模型");
  if (providerOverrideCount) imported.push("供应商设置");
  if (capabilityProviderCount) imported.push("能力供应商");
  if (imageProviderCount) imported.push("图片供应商");
  if (imageGenerationOverrideCount) imported.push("生图代理设置");
  if (capabilityOverrideCount) imported.push("模型能力");
  if (profileCount) imported.push("配置档");
  if (usageBudgetCount) imported.push("用量预算");
  if (codexResourceCount) imported.push("Codex 资源清单");

  return {
    ok: true,
    mode,
    imported,
    selectedModelCount,
    customModelCount,
    providerOverrideCount,
    capabilityProviderCount,
    imageProviderCount,
    imageGenerationOverrideCount,
    capabilityOverrideCount,
    profileCount,
    usageBudgetCount,
    codexResourceCount,
    embeddedLogoCount: nonNegativeInteger(pkg.embeddedLogoCount || configPackageEmbeddedLogoCount(pkg)),
    requiredSecretKeys,
    missingSecretKeys,
    secretsImported: false,
    includesSecrets: false,
    resourceManifestIncluded: Boolean(pkg.codexResources?.portableOnly),
  };
}

function normalizeConfigPackage(input = {}) {
  const pkg = typeof input === "string" ? JSON.parse(input) : input;
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
    throw new Error("配置包必须是 JSON 对象。");
  }
  if (pkg.schema && pkg.schema !== "codexbridge.config-package") {
    throw new Error("这不是 CodexBridge 配置包。");
  }
  if (Number(pkg.version || 0) !== 1) {
    throw new Error("不支持的 CodexBridge 配置包版本。");
  }
  if (pkg.includesSecrets === true) {
    throw new Error("这个 CodexBridge 配置包声明包含内嵌密钥。请先重新导出不含 API Key 的配置包，再导入。");
  }
  return pkg;
}

function configPackageRequiredSecretKeys(pkg = {}, config = null) {
  const keys = new Set();
  collectSecretKeyNames(pkg?.requiredSecretKeys, keys);
  collectSecretKeyNames(pkg?.secretKeys, keys);
  collectSecretKeyReferences(pkg?.customModels, keys);
  collectSecretKeyReferences(pkg?.providerOverrides, keys);
  collectSecretKeyReferences(pkg?.capabilityProviders, keys);
  collectSecretKeyReferences(pkg?.imageProviders, keys);
  collectSecretKeyReferences(pkg?.modelImageGeneration, keys);
  collectRouterConfigSecretKeys(config, keys);
  return [...keys].sort();
}

function collectRouterConfigSecretKeys(config = null, keys = new Set()) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return;
  }
  const models = Array.isArray(config.models) ? config.models : [];
  for (const model of models) {
    if (!model || typeof model !== "object" || Array.isArray(model)) {
      continue;
    }
    const authMode = String(model.authMode || "api_key").trim();
    if (authMode === "api_key") {
      addSecretKeyName(keys, model.apiKeyEnv || model.keyEnv);
    }
    collectSecretKeyReferences(model.imageGeneration, keys);
  }
  collectSecretKeyReferences(config.capabilityProviders, keys);
}

function collectSecretKeyReferences(value, keys = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectSecretKeyReferences(item, keys));
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const normalized = String(key || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (normalized === "apikeyenv" || normalized === "keyenv") {
      addSecretKeyName(keys, item);
      continue;
    }
    collectSecretKeyReferences(item, keys);
  }
}

function collectSecretKeyNames(value, keys = new Set()) {
  if (!Array.isArray(value)) {
    return;
  }
  value.forEach((item) => addSecretKeyName(keys, item));
}

function addSecretKeyName(keys, value) {
  const key = String(value || "").trim();
  if (!key || /[\s\r\n]/.test(key)) {
    return;
  }
  keys.add(key);
}

export function buildStartupCheck(rootDir, {
  homeDir = os.homedir(),
  appVersion = "",
  routerRunning = false,
  lastHealth = null,
  config = readRouterConfig(rootDir),
  proxyEnv = process.env,
  toolEnv = process.env,
  platform = process.platform,
  arch = process.arch,
  releaseAssets = null,
  realAcceptanceReport = null,
  packagedSmokeReport = null,
  codexCliSnapshot = null,
  codexPromptInputSnapshot = null,
  codexAppServerSnapshot = null,
  includeCodexPromptInputSnapshot = false,
  codexDesktopLocatorOptions = {},
} = {}) {
  const options = loadDesktopOptions(rootDir);
  const diagnostics = routerConfigDiagnostics(rootDir, config);
  const codexConfig = codexConfigPath(homeDir);
  const catalog = codexCatalogPath(homeDir);
  const mode = detectModeFromConfig(config);
  const resourceCodexCliSnapshot = codexCliSnapshot || readCodexCliResourceSnapshot({ homeDir });
  const resourceCodexPromptInputSnapshot = codexPromptInputSnapshot ||
    (includeCodexPromptInputSnapshot ? readCodexPromptInputSnapshot({ homeDir }) : null);
  const configuredRoutes = Array.isArray(config?.models) ? config.models : [];
  const savedSelection = readJsonIfExists(selectionPath(rootDir), null);
  const savedSelectionCount = Array.isArray(savedSelection?.selectedModelIds)
    ? normalizeSelection(rootDir, savedSelection.selectedModelIds, mode).length
    : 0;
  const effectiveSelectionCount = savedSelectionCount || readSelection(rootDir, mode).length;
  const selectionStateDetail = savedSelectionCount
    ? `已保存 ${savedSelectionCount} 个模型选择`
    : effectiveSelectionCount
      ? `当前默认模型选择 ${effectiveSelectionCount} 个`
      : "";
  const backups = listCodexBackups({ homeDir });
  const proxyKeys = proxyEnvironmentKeys(proxyEnv);
  const items = [
    codexConfigPreflightItem(codexConfig),
    checkItem({
      id: "model_catalog",
      label: "模型目录",
      status: fs.existsSync(catalog) || configuredRoutes.length > 0 ? "pass" : "warn",
      detail: fs.existsSync(catalog)
        ? catalog
        : configuredRoutes.length
          ? `当前有 ${configuredRoutes.length} 个模型路由可生成目录。`
          : selectionStateDetail
            ? `当前有 0 个模型路由可生成目录；${selectionStateDetail}，但路由配置还没有生成。`
            : "当前有 0 个模型路由可生成目录。",
      count: configuredRoutes.length,
      action: configuredRoutes.length || !effectiveSelectionCount
        ? "启动 Router 或重新保存模型选择后会生成目录。"
        : "重新保存模型选择或启动 Router，让 CodexBridge 生成路由配置和模型目录。",
    }),
    modelDirectoryPreflightItem(rootDir),
    modelReferencesPreflightItem(rootDir, mode),
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
    routeHealthPreflightItem({ routerRunning, lastHealth, config }),
    imageGenerationProxyPreflightItem(rootDir, config),
    capabilityProvidersPreflightItem(rootDir),
    realEnvironmentAcceptancePreflightItem(rootDir, {
      routerRunning,
      lastHealth,
      platform,
      arch,
      releaseAssets,
      realAcceptanceReport,
    }),
    ...preflightOptionalItem(packagedAppSmokePreflightItem(packagedSmokeReport)),
    pluginRuntimePreflightItem({ homeDir }),
    codexResourcesPreflightItem(rootDir, {
      homeDir,
      codexCliSnapshot: resourceCodexCliSnapshot,
      codexPromptInputSnapshot: resourceCodexPromptInputSnapshot,
      codexAppServerSnapshot,
    }),
    codexSessionsPreflightItem({ homeDir }),
    configPackagePreflightItem(rootDir, {
      homeDir,
      codexCliSnapshot: resourceCodexCliSnapshot,
      codexPromptInputSnapshot: resourceCodexPromptInputSnapshot,
    }),
    smartRoutingPreflightItem(config),
    usageBudgetPreflightItem(config),
    deleteSafetyPreflightItem(),
    updateFlowPreflightItem({ platform, arch, releaseAssets, env: toolEnv }),
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
    codexDesktopPreflightItem({
      options,
      platform,
      env: toolEnv,
      homeDir,
      locatorOptions: codexDesktopLocatorOptions,
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

function codexConfigPreflightItem(target) {
  if (!fs.existsSync(target)) {
    return checkItem({
      id: "codex_config",
      label: "Codex 配置",
      status: "warn",
      detail: "还没有找到 Codex config.toml。",
      action: "启动一次 Router 会自动写入 CodexBridge 配置。",
    });
  }
  try {
    inspectManagedCodexTomlBlock(fs.readFileSync(target));
    return checkItem({
      id: "codex_config",
      label: "Codex 配置",
      status: "pass",
      detail: target,
      action: "Codex 配置结构正常。",
    });
  } catch (error) {
    if (error?.code !== "managed_toml_invalid") {
      throw error;
    }
    return checkItem({
      id: "codex_config",
      label: "Codex 配置",
      status: "fail",
      detail: "Codex 配置中的 CodexBridge 管理块不完整或无效。",
      action: "启动 Router 时会先备份原文件并自动修复；如仍失败，请复制诊断信息。",
    });
  }
}

function codexDesktopPreflightItem({
  options = {},
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
  locatorOptions = {},
} = {}) {
  const savedLaunchTarget = String(options.codexDesktopLaunchTarget || options.codexDesktopExe || "").trim();
  let located = null;
  try {
    located = ["win32", "darwin"].includes(platform)
      ? locateOpenAIDesktopSync({
          ...(locatorOptions && typeof locatorOptions === "object" ? locatorOptions : {}),
          platform,
          env,
          homeDir,
          desktopOptions: options,
        })
      : null;
  } catch {
    located = null;
  }
  const discoveredTarget = String(located?.launchTarget || "").trim();
  const platformLocation = platform === "darwin" ? "macOS 应用程序目录" : "常见 Windows 位置";
  return checkItem({
    id: "codex_desktop",
    label: "ChatGPT / Codex",
    status: discoveredTarget ? "pass" : savedLaunchTarget ? "fail" : "warn",
    detail: discoveredTarget || (savedLaunchTarget
      ? "已保存的 ChatGPT / Codex 启动项不存在、无法解析，或不是受支持的官方桌面应用。"
      : `还没有保存 ChatGPT / Codex 启动路径，也没有在${platformLocation}找到可用应用。`),
    action: discoveredTarget
      ? "已自动找到 ChatGPT / Codex；如果重启仍失败，可以手动选择 ChatGPT.exe、ChatGPT.app、Codex.exe 或开始菜单快捷方式。"
      : "请选择 ChatGPT.exe、ChatGPT.app 或 Codex.exe，并确认桌面、开始菜单或应用程序目录里存在官方启动入口。",
  });
}

function codexSessionsPreflightItem({ homeDir = os.homedir() } = {}) {
  try {
    const tree = listCodexSessionTree({ homeDir, limit: 500 });
    const summary = tree.summary || {};
    const totalSessions = Number(summary.sessions || 0);
    const totalProjects = Number(summary.projects || 0);
    const projectSessions = Number(summary.projectSessions || 0);
    const looseSessions = Number(summary.looseSessions || 0);
    const mayHaveMore = Boolean(summary.mayHaveMore);
    const loadedText = mayHaveMore
      ? `当前已加载本机 Codex 会话索引前 ${totalSessions} 个最近会话，Codex 本地库可能还有更多。`
      : `本机 Codex 会话索引 ${totalSessions} 个。`;
    const classificationText = codexSessionClassificationText(tree.classification);
    return checkItem({
      id: "codex_sessions",
      label: "会话与项目",
      status: "pass",
      detail: `${loadedText}项目 ${totalProjects} 个，项目内会话 ${projectSessions} 个，无项目会话 ${looseSessions} 个。${classificationText ? `归类依据：${classificationText}。` : ""}`,
      count: totalSessions,
      action: totalSessions
        ? "发布前可在会话页核对项目文件夹和无项目会话，并按需导出 Markdown。"
        : "如果用户期望看到历史，请打开会话页复制诊断或先确认 Codex 已保存历史。不会影响模型路由。",
    });
  } catch (error) {
    return checkItem({
      id: "codex_sessions",
      label: "会话与项目",
      status: "warn",
      detail: `会话与项目读取失败：${redactSecretText(error.message || error)}`,
      count: 0,
      action: "发布前建议打开会话页复制诊断，确认项目文件夹、无项目会话和导出功能可读。",
    });
  }
}

function codexSessionClassificationText(classification = {}) {
  const reasons = classification?.projectReasons && typeof classification.projectReasons === "object"
    ? classification.projectReasons
    : {};
  return Object.entries(reasons)
    .filter(([, count]) => Number(count || 0) > 0)
    .map(([reason, count]) => `${codexSessionReasonLabel(reason)} ${count}`)
    .join("，");
}

function codexSessionReasonLabel(reason = "") {
  if (reason === "sidebar_project_thread_order") {
    return "侧边栏项目顺序";
  }
  if (reason === "thread_assignment") {
    return "Codex 项目分配";
  }
  if (reason === "workspace_root") {
    return "工作区根目录";
  }
  if (reason === "outside_sidebar_project_threads") {
    return "同工作区但不在侧边栏项目里";
  }
  if (reason === "projectless_marker") {
    return "Codex 无项目标记";
  }
  if (reason === "codex_generated_workspace") {
    return "Codex 临时工作目录";
  }
  if (reason === "workspace_hint_outside_projects") {
    return "工作区提示在项目外";
  }
  if (reason === "outside_current_projects") {
    return "当前项目外";
  }
  if (reason === "missing_workspace") {
    return "缺少工作目录";
  }
  return reason || "未知";
}

function smartRoutingPreflightItem(config = {}) {
  const smart = config?.smartRouting && typeof config.smartRouting === "object"
    ? config.smartRouting
    : {};
  const enabled = [
    smart.autoSelectModel === true ? "自动选模型" : "",
    smart.autoFailover === true ? "失败自动切换" : "",
  ].filter(Boolean);

  if (enabled.length) {
    return checkItem({
      id: "smart_routing",
      label: "智能路由",
      status: "warn",
      detail: `${enabled.join("、")} 已开启；这两个功能属于实验能力，可能改变用户手动选择的模型或失败后的请求走向。`,
      count: enabled.length,
      action: "发正式包前请确认这是用户主动打开的设置；默认发布配置应保持关闭。",
    });
  }

  return checkItem({
    id: "smart_routing",
    label: "智能路由",
    status: "pass",
    detail: "自动选模型和失败自动切换均为关闭状态，符合默认安全策略。",
    count: 0,
    action: "需要试验智能路由时，可在设置里手动开启；不要在默认配置里强制打开。",
  });
}

function modelDirectoryPreflightItem(rootDir) {
  const directory = readModelDirectory(rootDir);
  const entries = Object.values(directory.providers || {});
  if (!entries.length) {
    return checkItem({
      id: "model_directory",
      label: "模型列表缓存",
      status: "pass",
      detail: "还没有远程模型列表缓存；当前会使用内置离线模型预设，普通路由不受影响。",
      count: 0,
      action: "需要同步供应商模型列表时，请先保存 API Key，再点击对应供应商的“同步模型列表”。",
    });
  }

  const staleEntries = entries.filter((entry) => modelDirectoryEntryIsStale(entry.fetchedAt));
  if (staleEntries.length) {
    return checkItem({
      id: "model_directory",
      label: "模型列表缓存",
      status: "warn",
      detail: `以下供应商模型列表缓存已超过 7 天或时间不可用：${staleEntries.map((entry) => entry.providerName || entry.providerId).join("、")}。`,
      count: staleEntries.length,
      action: "发布前请在模型页重新点击“同步模型列表”，确认模型数量、模型名和权限仍然可用。",
    });
  }

  return checkItem({
    id: "model_directory",
    label: "模型列表缓存",
    status: "pass",
    detail: `已有 ${entries.length} 个供应商模型列表缓存，均在 7 天内同步。`,
    count: entries.reduce((total, entry) => total + Number(entry.models?.length || 0), 0),
    action: "模型列表缓存只影响模型页展示和同步结果，不会自动改变用户已保存的模型选择。",
  });
}

function modelReferencesPreflightItem(rootDir, mode = "") {
  const status = modelReferenceStatus(rootDir, mode);
  if (status.ok) {
    return checkItem({
      id: "model_references",
      label: "模型引用",
      status: "pass",
      detail: "模型选择、辅助任务模型、智能切换和备用顺序都指向当前可用模型。",
      count: 0,
      action: "删除或同步模型后如果出现失效引用，可在设置页点击“修复失效模型引用”。",
    });
  }
  const issueLabels = status.issues
    .slice(0, 4)
    .map((issue) => issue.label)
    .join("、");
  return checkItem({
    id: "model_references",
    label: "模型引用",
    status: "warn",
    detail: `${status.issueCount} 项模型引用失效：${issueLabels}${status.issueCount > 4 ? "等" : ""}。`,
    count: status.issueCount,
    action: "到设置页点击“修复失效模型引用”，会把旧模型、辅助任务、智能切换和备用顺序改为当前可用模型。",
  });
}

function usageBudgetPreflightItem(config = {}) {
  const budgets = normalizeUsageBudgetOptions(config?.usageBudgets || {});
  const scopes = usageBudgetScopeSummaries(budgets);
  if (!scopes.length) {
    return checkItem({
      id: "usage_budget",
      label: "用量预算",
      status: "pass",
      detail: "未设置每日预算；Router 不会因为额度保护拦截请求。",
      count: 0,
      action: "如果用户接了多个 API，建议按全局、模型或供应商设置每日 Token / 请求上限。",
    });
  }

  return checkItem({
    id: "usage_budget",
    label: "用量预算",
    status: "pass",
    detail: `已配置 ${scopes.length} 组每日预算：${scopes.join("；")}。`,
    count: scopes.length,
    action: "发布前确认这些每日上限是用户主动设置的；预算命中后 Router 会本地拦截，避免继续消耗上游额度。",
  });
}

function usageBudgetScopeSummaries(budgets = {}) {
  const result = [];
  if (usageBudgetHasSettings(budgets.global)) {
    result.push(`全局 ${usageBudgetSettingsText(budgets.global)}`);
  }
  for (const [routeId, budget] of Object.entries(budgets.routes || {})) {
    if (usageBudgetHasSettings(budget)) {
      result.push(`模型 ${routeId} ${usageBudgetSettingsText(budget)}`);
    }
  }
  for (const [providerId, budget] of Object.entries(budgets.providers || {})) {
    if (usageBudgetHasSettings(budget)) {
      result.push(`供应商 ${providerId} ${usageBudgetSettingsText(budget)}`);
    }
  }
  return result;
}

function usageBudgetHasSettings(budget = {}) {
  return usageBudgetHasLimit(budget) || usageBudgetHasCost(budget);
}

function usageBudgetHasLimit(budget = {}) {
  return Boolean(
    Number(budget.dailyTokenLimit || 0) ||
      Number(budget.dailyCallLimit || 0) ||
      Number(budget.dailyCostLimit || 0),
  );
}

function usageBudgetHasCost(budget = {}) {
  return Boolean(
    Number(budget.inputCostPerMillion || 0) ||
      Number(budget.cacheCostPerMillion || 0) ||
      Number(budget.outputCostPerMillion || 0),
  );
}

function usageBudgetSettingsText(budget = {}) {
  const parts = [];
  if (Number(budget.dailyTokenLimit || 0) > 0) {
    parts.push(`每日 ${usageBudgetNumberText(budget.dailyTokenLimit)} Token`);
  }
  if (Number(budget.dailyCallLimit || 0) > 0) {
    parts.push(`每日 ${usageBudgetNumberText(budget.dailyCallLimit)} 次请求`);
  }
  if (Number(budget.dailyCostLimit || 0) > 0) {
    parts.push(`每日 ${usageBudgetCostNumberText(budget.dailyCostLimit)} 费用上限`);
  }
  const costText = usageBudgetCostText(budget);
  if (costText) {
    parts.push(`费用估算 ${costText}`);
  }
  return parts.join(" / ");
}

function usageBudgetCostText(budget = {}) {
  const parts = [];
  if (Number(budget.inputCostPerMillion || 0) > 0) {
    parts.push(`输入 ${usageBudgetCostNumberText(budget.inputCostPerMillion)}/百万`);
  }
  if (Number(budget.cacheCostPerMillion || 0) > 0) {
    parts.push(`缓存 ${usageBudgetCostNumberText(budget.cacheCostPerMillion)}/百万`);
  }
  if (Number(budget.outputCostPerMillion || 0) > 0) {
    parts.push(`输出 ${usageBudgetCostNumberText(budget.outputCostPerMillion)}/百万`);
  }
  return parts.join("、");
}

function usageBudgetNumberText(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? String(Math.floor(number)) : "0";
}

function usageBudgetCostNumberText(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? String(number) : "0";
}

function configPackagePreflightItem(rootDir, {
  homeDir = os.homedir(),
  codexCliSnapshot = null,
  codexPromptInputSnapshot = null,
} = {}) {
  try {
    const exported = exportConfigPackage(rootDir, {
      homeDir,
      codexCliSnapshot,
      includeCodexCliSnapshot: Boolean(codexCliSnapshot),
      codexPromptInputSnapshot,
      includeCodexPromptInputSnapshot: Boolean(codexPromptInputSnapshot),
    });
    const serialized = JSON.stringify(exported);
    const leakedSecretKeys = configPackageLeakedSecretKeys(rootDir, serialized);
    const leakedLocalHints = [
      "secrets.local",
      "codexDesktopExe",
      "codexDesktopLaunchTarget",
    ].filter((hint) => serialized.includes(hint));

    if (exported.includesSecrets || leakedSecretKeys.length || leakedLocalHints.length) {
      return checkItem({
        id: "config_package",
        label: "配置包",
        status: "fail",
        detail: [
          exported.includesSecrets ? "配置包标记为包含密钥" : "",
          leakedSecretKeys.length ? `疑似带出 Key：${leakedSecretKeys.join("、")}` : "",
          leakedLocalHints.length ? `疑似带出本机路径字段：${leakedLocalHints.join("、")}` : "",
        ].filter(Boolean).join("；"),
        count: leakedSecretKeys.length + leakedLocalHints.length + (exported.includesSecrets ? 1 : 0),
        action: "请先修复配置包导出逻辑，确保只导出可迁移设置，不导出 API Key 和本机私有路径。",
      });
    }

    const selectionCount = Array.isArray(exported.selection?.selectedModelIds)
      ? exported.selection.selectedModelIds.length
      : 0;
    const customModelCount = Array.isArray(exported.customModels) ? exported.customModels.length : 0;
    const providerOverrideCount = Object.keys(plainObject(exported.providerOverrides)).length;
    const imageProviderCount = Array.isArray(exported.imageProviders?.providers)
      ? exported.imageProviders.providers.length
      : 0;
    const capabilityProviderCount = Array.isArray(exported.capabilityProviders?.providers)
      ? exported.capabilityProviders.providers.length
      : 0;
    const imageGenerationOverrideCount = Object.keys(plainObject(exported.modelImageGeneration)).length;
    const capabilityOverrideCount = Object.keys(plainObject(exported.modelCapabilities?.overrides)).length;
    const profileCount = Array.isArray(exported.profiles) ? exported.profiles.length : 0;
    const usageBudgetCount = usageBudgetScopeSummaries(exported.desktopOptions?.usageBudgets || {}).length;
    const codexResourceCount = configPackageCodexResourceCount(exported.codexResources);
    const requiredSecretKeys = Array.isArray(exported.requiredSecretKeys)
      ? exported.requiredSecretKeys.map((key) => String(key || "").trim()).filter(Boolean)
      : [];
    const requiredSecretText = requiredSecretKeys.length
      ? `导入新机器后需要重填 ${requiredSecretKeys.length} 个 Key`
      : "没有检测到需要重填的 Key";
    const knownCount = selectionCount +
      customModelCount +
      providerOverrideCount +
      imageProviderCount +
      capabilityProviderCount +
      imageGenerationOverrideCount +
      capabilityOverrideCount +
      profileCount +
      usageBudgetCount;
    const resourceCountUnavailable = codexResourceCount === null;
    const count = resourceCountUnavailable ? null : knownCount + codexResourceCount;

    return checkItem({
      id: "config_package",
      label: "配置包",
      status: resourceCountUnavailable ? "warn" : "pass",
      blockingClass: resourceCountUnavailable ? "local_setup" : "",
      detail: resourceCountUnavailable
        ? `可导出 ${knownCount} 项已知配置；Codex 资源清单当前无法读取，未将其伪装成 0；API Key 不会写进配置包；${requiredSecretText}。`
        : `可导出 ${count} 项配置；API Key 不会写进配置包；${requiredSecretText}。`,
      count,
      action: resourceCountUnavailable
        ? "请刷新资源页并确认 Codex CLI 与 prompt-input 均可读取，再导出包含权威资源清单的配置包。"
        : requiredSecretKeys.length
        ? "迁移到新机器后，在模型页重新填写供应商 Key。"
        : "配置包可用于迁移设置；如果新机器没有 Key，需要重新填写。",
    });
  } catch (error) {
    return checkItem({
      id: "config_package",
      label: "配置包",
      status: "fail",
      detail: `配置包导出失败：${redactSecretText(error.message || error)}`,
      count: 1,
      action: "请先修复配置包导出问题，否则用户迁移配置或发测试包时容易丢设置。",
    });
  }
}

function configPackageSyncEvidenceText(rootDir) {
  const status = readConfigPackageSyncStatus(rootDir);
  if (!status?.ok) {
    return "还没有同步目录导出记录";
  }
  const parts = [
    status.fileName || "未知配置包",
    status.directoryName ? `目录 ${status.directoryName}` : "",
    status.exportedAt,
  ].filter(Boolean);
  if (status.fileExists) {
    return `同步目录最近导出：${parts.join("，")}`;
  }
  return `同步目录记录存在但文件缺失：${parts.join("，")}`;
}

function configPackageLeakedSecretKeys(rootDir, serialized = "") {
  const secrets = loadSecrets(rootDir);
  return Object.entries(secrets)
    .filter(([, value]) => typeof value === "string" && value.trim().length >= 6)
    .filter(([, value]) => serialized.includes(value.trim()))
    .map(([key]) => key);
}

function routeHealthPreflightItem({ routerRunning = false, lastHealth = null, config = {} } = {}) {
  const configuredRoutes = Array.isArray(config?.models) ? config.models : [];
  const healthRoutes = Array.isArray(lastHealth?.routes) ? lastHealth.routes : [];
  const unhealthyRoutes = Number.isFinite(Number(lastHealth?.unhealthyRoutes))
    ? Number(lastHealth.unhealthyRoutes)
    : healthRoutes.filter((route) => {
        const status = String(route?.status || "").toLowerCase();
        return status && status !== "healthy";
      }).length;

  if (!routerRunning) {
    return checkItem({
      id: "route_health",
      label: "路由健康",
      status: "warn",
      detail: "Router 还没有启动，启动后才能检查模型线路是否可用。",
      count: 0,
      action: "请回到“概览”启动 Router；启动成功后再点“重新体检”。",
    });
  }

  if (!lastHealth) {
    return checkItem({
      id: "route_health",
      label: "路由健康",
      status: "warn",
      detail: "Router 正在运行，但还没有健康检查结果。",
      count: 0,
      action: "等待 Router 健康检查完成，或点击重新体检。",
    });
  }

  if (!lastHealth.ok || unhealthyRoutes > 0) {
    return checkItem({
      id: "route_health",
      label: "路由健康",
      status: "fail",
      detail: lastHealth.message || `发现 ${unhealthyRoutes} 条上游路由需要处理。`,
      count: unhealthyRoutes,
      action: "先打开日志确认是 Key、Base URL、限流、模型名还是上游服务异常。",
    });
  }

  return checkItem({
    id: "route_health",
    label: "路由健康",
    status: "pass",
    detail: `Router 健康检查通过，${healthRoutes.length || configuredRoutes.length} 条路由没有发现异常。`,
    count: 0,
    action: "发布前体检已覆盖当前 Router 路由快照。",
  });
}

function imageGenerationProxyPreflightItem(rootDir, config = {}) {
  const imageProviderConfig = readImageProviderConfig(rootDir);
  const providers = Array.isArray(imageProviderConfig.providers) ? imageProviderConfig.providers : [];
  const providerIds = new Set(providers.map((provider) => provider.id));
  const defaultProvider = providers.find((provider) => provider.id === imageProviderConfig.defaultProviderId) || null;
  const routes = Array.isArray(config?.models) ? config.models : [];
  const imageRoutes = routes.filter((route) => imageGenerationEnabledForPreflight(route.imageGeneration));
  const missingProviderRoutes = imageRoutes.filter((route) => {
    const providerId = String(route.imageGeneration?.providerId || "").trim();
    return providerId && !providerIds.has(providerId);
  });

  if (missingProviderRoutes.length) {
    return checkItem({
      id: "image_generation_proxy",
      label: "图片生成代理",
      status: "fail",
      detail: missingProviderRoutes
        .map((route) => `${route.displayName || route.id}: ${route.imageGeneration?.providerId || "未指定供应商"}`)
        .join("; "),
      count: missingProviderRoutes.length,
      action: "这些模型引用的图片供应商不存在，需要重新选择生图代理或保存图片供应商。",
    });
  }

  if (!providers.length) {
    return checkItem({
      id: "image_generation_proxy",
      label: "图片生成代理",
      status: "warn",
      detail: "还没有配置图片供应商；普通聊天路由不受影响，但非 GPT 模型无法走生图代理。",
      count: 0,
      action: "如果要发布带生图代理的版本，请先在设置里添加并测试图片供应商。",
    });
  }

  if (!defaultProvider && imageRoutes.length === 0) {
    return checkItem({
      id: "image_generation_proxy",
      label: "图片生成代理",
      status: "warn",
      detail: `已有 ${providers.length} 个图片供应商，但没有默认供应商，也没有模型单独绑定。`,
      count: providers.length,
      action: "建议设置一个默认图片供应商，或给需要生图的模型单独指定供应商。",
    });
  }

  const activeProviderIds = new Set();
  for (const route of imageRoutes) {
    const providerId = String(route.imageGeneration?.providerId || "").trim();
    if (providerId) {
      activeProviderIds.add(providerId);
    } else if (defaultProvider?.id) {
      activeProviderIds.add(defaultProvider.id);
    }
  }
  if (activeProviderIds.size === 0 && defaultProvider?.id) {
    activeProviderIds.add(defaultProvider.id);
  }
  const activeProviders = providers.filter((provider) => activeProviderIds.has(provider.id));
  const failedProviderTests = activeProviders.filter((provider) => provider.lastTest?.ok === false);
  if (failedProviderTests.length) {
    return checkItem({
      id: "image_generation_proxy",
      label: "图片生成代理",
      status: "fail",
      detail: failedProviderTests
        .map((provider) => {
          const message = provider.lastTest?.message ? `：${provider.lastTest.message}` : "";
          return `${provider.name} 最近测试失败${message}`;
        })
        .join("; "),
      count: failedProviderTests.length,
      action: "请在图片供应商页重新点击“测试生图”，确认 Key、模型名、尺寸和返回格式都可用。",
    });
  }

  const staleProviderTests = activeProviders.filter((provider) =>
    provider.lastTest?.ok && providerTestResultIsStale(provider.lastTest)
  );
  if (staleProviderTests.length) {
    return checkItem({
      id: "image_generation_proxy",
      label: "图片生成代理",
      status: "warn",
      detail: `以下图片供应商测试记录已超过 ${PREFLIGHT_PROVIDER_TEST_STALE_DAYS} 天：${staleProviderTests.map((provider) => provider.name).join("、")}。发布前请重新测试生图。`,
      count: staleProviderTests.length,
      action: "发布前请在图片供应商页重新点击“测试生图”，确认 Key、模型名、尺寸、返回格式和本地保存仍然可用。",
    });
  }

  const untestedProviders = activeProviders.filter((provider) => !provider.lastTest);
  if (untestedProviders.length) {
    return checkItem({
      id: "image_generation_proxy",
      label: "图片生成代理",
      status: "warn",
      detail: `以下图片供应商尚未测试生图：${untestedProviders.map((provider) => provider.name).join("、")}。`,
      count: untestedProviders.length,
      action: "发布前请在图片供应商页点击“测试生图”，确认能生成并保存到本地。",
    });
  }

  const providerNames = [
    ...new Set(
      imageRoutes
        .map((route) => {
          const providerId = String(route.imageGeneration?.providerId || "").trim();
          const provider = providers.find((item) => item.id === providerId);
          return route.imageGeneration?.displayName || provider?.name || providerId;
        })
        .filter(Boolean),
    ),
  ];
  const names = providerNames.length
    ? providerNames.join("、")
    : `${defaultProvider?.name || "默认图片供应商"}`;
  const testSummary = activeProviders
    .filter((provider) => provider.lastTest?.ok)
    .map((provider) => {
      const duration = Number.isFinite(Number(provider.lastTest.durationMs))
        ? `，耗时 ${Math.round(Number(provider.lastTest.durationMs))}ms`
        : "";
      return `${provider.name} 最近测试通过${duration}`;
    })
    .join("；");

  return checkItem({
    id: "image_generation_proxy",
    label: "图片生成代理",
    status: "pass",
    detail: `已配置 ${providers.length} 个图片供应商，当前可用：${names}。${testSummary ? `${testSummary}。` : ""}生成图片会保存到 ${imageOutputDirPath(rootDir)}。`,
    count: imageRoutes.length || providers.length,
    action: "发布前可在图片供应商页点击“测试生图”确认 Key、模型名和尺寸可用。",
  });
}

function imageGenerationEnabledForPreflight(settings = {}) {
  if (!settings || settings.enabled === false) {
    return false;
  }
  const mode = String(settings.mode || "").trim().toLowerCase();
  return mode === "custom" || mode === "official" || mode === "provider";
}

function capabilityProvidersPreflightItem(rootDir) {
  const config = readCapabilityProviderConfig(rootDir);
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const enabledProviders = providers.filter((provider) => provider.enabled !== false);
  const defaults = plainObject(config.defaults);
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const disabledDefaults = Object.entries(defaults)
    .map(([capability, providerId]) => {
      const provider = providerById.get(providerId);
      if (!provider || provider.enabled !== false) {
        return null;
      }
      return { capability, provider };
    })
    .filter(Boolean);

  if (disabledDefaults.length) {
    return checkItem({
      id: "capability_providers",
      label: "能力供应商",
      status: "fail",
      detail: disabledDefaults.map(({ capability, provider }) =>
        `${capabilityProviderCapabilityName(capability)} 默认供应商 ${provider.name} 已停用。`
      ).join("；"),
      count: disabledDefaults.length,
      action: "请在能力页重新选择默认供应商，或启用这些供应商后重新体检。",
    });
  }

  if (!enabledProviders.length) {
    return checkItem({
      id: "capability_providers",
      label: "能力供应商",
      status: "pass",
      detail: "未配置实验能力供应商；普通模型路由不受影响。",
      count: 0,
      action: "需要手动试运行 OCR、搜索、浏览器或 Computer Use 时，再到能力页添加实验供应商。",
    });
  }

  const failed = enabledProviders.filter((provider) => provider.lastTest?.ok === false);
  if (failed.length) {
    return checkItem({
      id: "capability_providers",
      label: "能力供应商",
      status: "fail",
      detail: failed.map((provider) => {
        const capability = capabilityProviderCapabilityName(provider.capability || provider.capabilities?.[0]);
        const failureDetail = capabilityProviderLastTestFailureDetail(provider.lastTest);
        const message = failureDetail ? `：${failureDetail}` : "";
        return `${provider.name} ${capability} 体检失败${message}`;
      }).join("; "),
      count: failed.length,
      action: "请在能力页重新体检，确认 Key、Base URL、Endpoint、权限和返回格式。",
    });
  }

  const stale = enabledProviders.filter((provider) =>
    provider.lastTest?.ok && providerTestResultIsStale(provider.lastTest)
  );
  if (stale.length) {
    return checkItem({
      id: "capability_providers",
      label: "能力供应商",
      status: "warn",
      detail: `以下能力供应商测试记录已超过 ${PREFLIGHT_PROVIDER_TEST_STALE_DAYS} 天：${stale.map((provider) => provider.name).join("、")}。发布前请重新体检。`,
      count: stale.length,
      action: "发布前请在能力页重新点击“测试能力”或试运行本地能力，确认接口、权限和返回格式仍然可用。",
    });
  }

  const untested = enabledProviders.filter((provider) => !provider.lastTest);
  const untestedRemote = untested.filter((provider) => !isLocalCapabilityProvider(provider));
  const untestedLocal = untested.filter((provider) => isLocalCapabilityProvider(provider));
  if (untestedRemote.length) {
    return checkItem({
      id: "capability_providers",
      label: "能力供应商",
      status: "warn",
      detail: `以下远程能力供应商尚未体检：${untestedRemote.map((provider) => provider.name).join("、")}。`,
      count: untestedRemote.length,
      action: "发布前建议逐个点击“测试能力”，确认接口可用。",
    });
  }
  if (untestedLocal.length) {
    return checkItem({
      id: "capability_providers",
      label: "能力供应商",
      status: "warn",
      detail: `以下本地能力供应商需要桌面端执行器确认：${untestedLocal.map(localCapabilityProviderPreflightText).join("；")}。`,
      count: untestedLocal.length,
      action: "发布前请打开能力页试运行或复制诊断，确认本地 Chrome、Computer Use 或文件执行器可用。",
    });
  }

  const defaultLabels = Object.entries(defaults)
    .map(([capability, providerId]) => {
      const provider = enabledProviders.find((item) => item.id === providerId);
      return provider ? `${capabilityProviderCapabilityName(capability)} 默认 ${provider.name}` : "";
    })
    .filter(Boolean);
  const testedText = enabledProviders.map((provider) => {
    const duration = Number.isFinite(Number(provider.lastTest?.durationMs))
      ? `，${Math.round(Number(provider.lastTest.durationMs))}ms`
      : "";
    return `${provider.name} 体检通过${duration}`;
  }).join("；");

  return checkItem({
    id: "capability_providers",
    label: "能力供应商",
    status: "pass",
    detail: `${testedText || `${enabledProviders.length} 个能力供应商已配置。`}${defaultLabels.length ? `；${defaultLabels.join("，")}` : ""}`,
    count: enabledProviders.length,
    action: "实验能力供应商只用于手动体检和试运行，不会自动改变模型请求路由。",
  });
}

function realEnvironmentAcceptancePreflightItem(rootDir, {
  routerRunning = false,
  lastHealth = null,
  platform = process.platform,
  arch = process.arch,
  releaseAssets = null,
  realAcceptanceReport = null,
} = {}) {
  const reportItem = realAcceptanceReportPreflightItem(realAcceptanceReport);
  if (reportItem) {
    return reportItem;
  }

  const passed = [];
  const missing = [];

  const unhealthyRoutes = Number(lastHealth?.unhealthyRoutes || 0);
  if (routerRunning && lastHealth?.ok && unhealthyRoutes === 0) {
    passed.push("真实 Router 路由健康已通过");
  } else if (routerRunning) {
    missing.push("真实 Router 已启动但路由健康还没有完全通过");
  } else {
    missing.push("真实 Router 还没有启动并通过严格发布检查");
  }

  const imageProviders = readImageProviders(rootDir)
    .filter((provider) => provider.enabled !== false);
  const freshImageProviders = imageProviders.filter((provider) =>
    provider.lastTest?.ok && !providerTestResultIsStale(provider.lastTest)
  );
  if (freshImageProviders.length) {
    passed.push(`图片供应商已真实测试：${freshImageProviders.map((provider) => provider.name).join("、")}`);
  } else if (imageProviders.length) {
    missing.push(`图片供应商缺少近期成功测试生图记录：${imageProviders.map((provider) => provider.name).join("、")}`);
  } else {
    missing.push("还没有图片供应商的真实测试生图记录");
  }

  const capabilityProviders = readCapabilityProviders(rootDir)
    .filter((provider) => provider.enabled !== false)
    .filter((provider) => !capabilityProviderHasCapability(provider, "image_generation"));
  const remoteCapabilityProviders = capabilityProviders
    .filter((provider) => !isLocalCapabilityProvider(provider));
  const freshRemoteCapabilityProviders = remoteCapabilityProviders.filter((provider) =>
    provider.lastTest?.ok && !providerTestResultIsStale(provider.lastTest)
  );
  const freshLocalCapabilityProviders = capabilityProviders
    .filter((provider) => isLocalCapabilityProvider(provider))
    .filter((provider) => provider.lastTest?.ok && !providerTestResultIsStale(provider.lastTest));
  if (freshRemoteCapabilityProviders.length) {
    passed.push(`远程能力供应商已真实体检：${freshRemoteCapabilityProviders.map((provider) => provider.name).join("、")}`);
  } else if (remoteCapabilityProviders.length) {
    missing.push(`远程能力供应商缺少近期成功体检记录：${remoteCapabilityProviders.map((provider) => provider.name).join("、")}`);
  } else if (freshLocalCapabilityProviders.length) {
    passed.push(`本地能力桥接已试运行：${freshLocalCapabilityProviders.map((provider) => provider.name).join("、")}`);
  } else {
    missing.push("还没有真实能力供应商或本地能力桥接的成功体检记录");
  }

  const releaseAssetProof = releaseAssetAcceptanceProof(releaseAssets, { platform, arch });
  if (releaseAssetProof.ok) {
    passed.push(releaseAssetProof.detail);
  } else {
    missing.push(releaseAssetProof.detail);
  }

  return checkItem({
    id: "real_environment_acceptance",
    label: "真实环境检查",
    status: missing.length ? "warn" : "pass",
      detail: missing.length
        ? `正式发包检查还差 ${missing.length} 项；普通启动不受影响。`
        : `正式发包检查已通过 ${passed.length} 项。`,
      count: missing.length,
      action: missing.length
        ? "正式发包前再选择安装包目录并导出检查记录。"
        : "真实 Router、供应商和安装包检查记录齐全，可以进入最后发布检查。",
  });
}

export function buildRealAcceptanceReport(rootDir, {
  routerRunning = false,
  lastHealth = null,
  releaseAssets = null,
  platform = process.platform,
  arch = process.arch,
  now = () => new Date().toISOString(),
} = {}) {
  const checkedAt = String(now());
  const router = realAcceptanceRouterReport({ routerRunning, lastHealth });
  const imageProviders = readImageProviders(rootDir)
    .filter((provider) => provider.enabled !== false)
    .filter((provider) => freshPassedProviderTest(provider.lastTest))
    .map((provider) => realAcceptanceProviderEntry(provider, { capability: "image_generation" }));
  const capabilityProviders = readCapabilityProviders(rootDir)
    .filter((provider) => provider.enabled !== false)
    .filter((provider) => !capabilityProviderHasCapability(provider, "image_generation"))
    .filter((provider) => freshPassedProviderTest(provider.lastTest))
    .map((provider) => realAcceptanceProviderEntry(provider));
  const windowsInstaller = realAcceptanceWindowsInstallerReport(releaseAssets, { platform, arch });
  const missing = [
    router.ok ? "" : "Router health",
    imageProviders.length ? "" : "image provider test",
    capabilityProviders.length ? "" : "capability provider test",
    windowsInstaller.ok ? "" : "Windows installer assets",
  ].filter(Boolean);

  return {
    version: 1,
    source: "desktop-preflight",
    checkedAt,
    ok: missing.length === 0,
    missing,
    router,
    imageProviders,
    capabilityProviders,
    windowsInstaller,
    platform,
    arch,
  };
}

export function saveRealAcceptanceReport(rootDir, filePath, options = {}) {
  const report = buildRealAcceptanceReport(rootDir, options);
  writeJsonAtomic(filePath, report);
  return {
    ok: report.ok,
    report,
    filePath,
  };
}

export function buildReleaseGateReport(rootDir, {
  homeDir = os.homedir(),
  appVersion = "",
  routerRunning = false,
  lastHealth = null,
  config = readRouterConfig(rootDir),
  proxyEnv = process.env,
  toolEnv = process.env,
  platform = process.platform,
  arch = process.arch,
  releaseAssets = null,
  realAcceptanceReport = null,
  packagedSmokeReport = null,
  codexCliSnapshot = null,
  codexPromptInputSnapshot = null,
  strictWarnings = false,
  now = () => new Date().toISOString(),
} = {}) {
  const check = buildStartupCheck(rootDir, {
    homeDir,
    appVersion,
    routerRunning,
    lastHealth,
    config,
    proxyEnv,
    toolEnv,
    platform,
    arch,
    releaseAssets,
    realAcceptanceReport,
    packagedSmokeReport,
    codexCliSnapshot,
    codexPromptInputSnapshot,
    includeCodexPromptInputSnapshot: Boolean(codexPromptInputSnapshot),
  });
  const releaseGate = releasePreflightGateSummary(check, { strictWarnings });
  return {
    ok: releaseGate.ok,
    releaseGate,
    dataRoot: rootDir,
    homeDir,
    ...check,
    appVersion,
    checkedAt: String(now()),
  };
}

export function saveReleaseGateReport(rootDir, filePath, options = {}) {
  const report = buildReleaseGateReport(rootDir, options);
  writeJsonAtomic(filePath, report);
  return {
    ok: report.ok,
    report,
    filePath,
  };
}

export function releaseAssetsFromDirectory(dirPath = "") {
  const releaseDir = String(dirPath || "").trim();
  if (!releaseDir) {
    return [];
  }
  const resolved = path.resolve(releaseDir);
  let entries;
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch (error) {
    throw new Error(`无法读取发布目录：${resolved}。${error?.message || error}`);
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const filePath = path.join(resolved, entry.name);
      const stat = fs.statSync(filePath);
      return {
        name: entry.name,
        path: filePath,
        size: stat.size,
        headerHex: readFileHeaderHex(filePath, 4),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function readFileHeaderHex(filePath, byteCount = 4) {
  const buffer = Buffer.alloc(byteCount);
  let handle;
  try {
    handle = fs.openSync(filePath, "r");
    const bytesRead = fs.readSync(handle, buffer, 0, byteCount, 0);
    return buffer.subarray(0, bytesRead).toString("hex");
  } finally {
    if (handle !== undefined) {
      fs.closeSync(handle);
    }
  }
}

function realAcceptanceRouterReport({ routerRunning = false, lastHealth = null } = {}) {
  const routes = Array.isArray(lastHealth?.routes) ? lastHealth.routes : [];
  const unhealthyRoutes = Number.isFinite(Number(lastHealth?.unhealthyRoutes))
    ? Number(lastHealth.unhealthyRoutes)
    : 0;
  const models = Array.isArray(lastHealth?.models)
    ? lastHealth.models
        .map((item) => String(typeof item === "string" ? item : item?.id || item?.model || "").trim())
        .filter(Boolean)
    : routes
        .map((route) => String(route?.id || route?.model || "").trim())
        .filter(Boolean);
  const ok = Boolean(routerRunning && lastHealth?.ok && unhealthyRoutes === 0);
  return {
    ok,
    detail: ok
      ? "Router health passed with no unhealthy routes."
      : String(lastHealth?.message || "Router has not passed a live health check.").trim(),
    routes: routes.length,
    unhealthyRoutes,
    models: [...new Set(models)],
  };
}

function freshPassedProviderTest(lastTest = null) {
  if (!lastTest || lastTest.ok !== true) {
    return false;
  }
  const checkedAt = Date.parse(lastTest.checkedAt || lastTest.createdAt || "");
  if (!Number.isFinite(checkedAt)) {
    return false;
  }
  return !providerTestResultIsStale(lastTest);
}

function realAcceptanceProviderEntry(provider = {}, { capability = "" } = {}) {
  const lastTest = provider.lastTest || {};
  const durationMs = Number(lastTest.durationMs || 0);
  const providerCapability = capability || provider.capability || provider.capabilities?.[0] || "";
  return {
    ok: true,
    provider: provider.name || provider.displayName || provider.providerId || provider.id || "provider",
    providerId: provider.providerId || provider.id || "",
    capability: providerCapability,
    checkedAt: String(lastTest.checkedAt || lastTest.createdAt || "").trim(),
    durationMs: Number.isFinite(durationMs) ? Math.round(durationMs) : 0,
    ...(lastTest.localPath ? { localPath: lastTest.localPath } : {}),
  };
}

function realAcceptanceWindowsInstallerReport(releaseAssets, { platform = process.platform, arch = process.arch } = {}) {
  const proof = releaseAssetAcceptanceProof(releaseAssets, { platform, arch });
  const assets = normalizeReleaseAssetEntries(releaseAssets) || [];
  const setupName = assetNameForPlatform(platform, arch, { installKind: "installed" });
  const portableName = assetNameForPlatform(platform, arch, { installKind: "portable" });
  const setup = assets.find((asset) => asset.name.toLowerCase() === setupName.toLowerCase()) || null;
  const portable = assets.find((asset) => asset.name.toLowerCase() === portableName.toLowerCase()) || null;
  return {
    ok: proof.ok,
    detail: proof.detail,
    setupExe: setup?.path || setup?.name || "",
    portableZip: portable?.path || portable?.name || "",
    setupSize: setup?.size || 0,
    portableSize: portable?.size || 0,
  };
}

function realAcceptanceReportPreflightItem(report = null) {
  if (!report || typeof report !== "object") {
    return null;
  }

  const passed = [];
  const missing = [];
  const checkedAt = String(report.checkedAt || report.createdAt || "").trim();
  const router = report.router && typeof report.router === "object" ? report.router : null;
  const imageProviders = normalizeAcceptanceEntries(report.imageProviders || report.imageProvider);
  const capabilityProviders = normalizeAcceptanceEntries(report.capabilityProviders || report.capabilityProvider);
  const installer = report.windowsInstaller || report.installer || report.updateFlow || null;
  const reportError = String(report.error || "").trim();
  if (report.ok === false) {
    missing.push(reportError || "真实检查报告标记为未通过");
  }

  if (router?.ok === true) {
    const detail = String(router.detail || "").trim();
    const models = Array.isArray(router.models)
      ? router.models.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    passed.push([
      "真实 Router 检查报告已通过",
      detail,
      models.length ? `模型 ${models.join("、")}` : "",
    ].filter(Boolean).join("，"));
  } else {
    missing.push("真实 Router 检查报告缺失或未通过");
  }

  const passedImages = imageProviders.filter((item) => item?.ok === true);
  if (passedImages.length) {
    passed.push(`图片供应商检查报告已通过：${passedImages.map(acceptanceProviderName).join("、")}`);
  } else {
    missing.push("图片供应商检查报告缺失或未通过");
  }

  const passedCapabilities = capabilityProviders.filter((item) => item?.ok === true);
  if (passedCapabilities.length) {
    passed.push(`能力供应商检查报告已通过：${passedCapabilities.map(acceptanceProviderName).join("、")}`);
  } else {
    missing.push("能力供应商或本地能力桥接检查报告缺失或未通过");
  }

  if (installer && typeof installer === "object" && installer.ok === true) {
    const setupExe = String(installer.setupExe || installer.setupPath || "").trim();
    const portableZip = String(installer.portableZip || installer.portablePath || "").trim();
    passed.push([
      "Windows 安装/更新检查报告已通过",
      setupExe || "Setup.exe",
      portableZip || "Portable.zip",
    ].filter(Boolean).join("，"));
  } else {
    missing.push("Windows 安装/更新检查报告缺失或未通过");
  }

  const reportOk = report.ok !== false && missing.length === 0;
  const shortDetail = reportOk
    ? "真实 Router、图片供应商、能力桥接和 Windows 安装更新都已检查。"
    : `正式发包检查还差 ${missing.length} 项；普通启动和日常使用不受影响。`;
  return checkItem({
    id: "real_environment_acceptance",
    label: "真实环境检查",
    status: reportOk ? "pass" : "warn",
    detail: checkedAt ? `${shortDetail} 报告时间 ${redactSecretText(checkedAt)}。` : shortDetail,
    count: missing.length,
    action: reportOk
      ? "可以进入发版前最后检查。"
      : "正式发包前再补齐真实 Key、真实 Router 和真实安装包检查。",
  });
}

function normalizeAcceptanceEntries(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [value].filter((item) => item && typeof item === "object");
}

function acceptanceProviderName(item = {}) {
  const provider = String(item.provider || item.name || item.providerId || "").trim();
  const capability = String(item.capability || "").trim();
  const localPath = String(item.localPath || item.filePath || "").trim();
  const durationMs = Number(item.durationMs || 0);
  return [
    provider || "未命名供应商",
    capability,
    localPath,
    Number.isFinite(durationMs) && durationMs > 0 ? `${Math.round(durationMs)}ms` : "",
  ].filter(Boolean).join("，");
}

function packagedAppSmokePreflightItem(report = null) {
  if (!report || typeof report !== "object") {
    return null;
  }
  const ok = report.ok === true && report.desktopSmoke?.ok === true && report.routerSmoke?.ok === true;
  const exePath = String(report.exePath || "").trim();
  const checkedAt = String(report.checkedAt || "").trim();
  const desktopMs = Number(report.desktopSmoke?.durationMs || 0);
  const routerMs = Number(report.routerSmoke?.durationMs || 0);
  const models = Array.isArray(report.routerSmoke?.models)
    ? report.routerSmoke.models.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  return checkItem({
    id: "packaged_app_smoke",
    label: "打包应用 smoke",
    status: ok ? "pass" : "fail",
    detail: ok
      ? [
          `${exePath || "CodexBridge.exe"} 已通过桌面 smoke 和 Router health smoke`,
          checkedAt ? `时间 ${checkedAt}` : "",
          desktopMs > 0 ? `桌面 smoke ${Math.round(desktopMs)}ms` : "",
          routerMs > 0 ? `Router health smoke ${Math.round(routerMs)}ms` : "",
          models.length ? `模型 ${models.join("、")}` : "",
        ].filter(Boolean).join("；")
      : [
          `${exePath || "CodexBridge.exe"} 打包 smoke 未通过`,
          report.error ? redactSecretText(report.error) : "",
        ].filter(Boolean).join("；"),
    count: ok ? 2 : 1,
    action: ok
      ? "这只能证明打包后的 exe 能启动桌面和本地 Router health；真实安装器和供应商仍需单独检查。"
      : "请重新运行 npm run package:win 和 npm run package:win:smoke，确认打包后的 CodexBridge.exe 可以启动。",
  });
}

function preflightOptionalItem(item) {
  return item ? [item] : [];
}

function releaseAssetAcceptanceProof(releaseAssets, { platform = process.platform, arch = process.arch } = {}) {
  const expectedAssets = expectedUpdateAssetsForPlatform(platform, arch);
  if (!expectedAssets.length) {
    return {
      ok: true,
      detail: `当前平台 ${platform} ${arch} 没有内置安装包检查规则`,
    };
  }

  const providedAssets = normalizeReleaseAssetEntries(releaseAssets);
  if (!providedAssets) {
    return {
      ok: false,
      detail: `还没有提供真实 Windows 安装包发布目录；至少需要 ${expectedAssets.join("、")}`,
    };
  }

  const provided = new Set(providedAssets.map((asset) => asset.name.toLowerCase()));
  const missing = expectedAssets.filter((name) => !provided.has(name.toLowerCase()));
  if (missing.length) {
    return {
      ok: false,
      detail: `真实安装包缺少 ${missing.join("、")}`,
    };
  }

  const invalidSize = providedAssets.filter((asset) =>
    expectedAssets.some((name) => name.toLowerCase() === asset.name.toLowerCase()) &&
    asset.hasSize &&
    asset.size <= 0
  );
  if (invalidSize.length) {
    return {
      ok: false,
      detail: `真实安装包大小异常：${invalidSize.map((asset) => asset.name).join("、")}`,
    };
  }

  const invalidFormats = releaseAssetFormatFailures(providedAssets, { platform, arch });
  if (invalidFormats.length) {
    return {
      ok: false,
      detail: `真实安装包格式异常：${invalidFormats.map((item) => item.name).join("、")}`,
    };
  }

  return {
    ok: true,
    detail: `真实安装包已验证：${expectedAssets.join("、")}`,
  };
}

function capabilityProviderHasCapability(provider = {}, capability = "") {
  const target = String(capability || "").trim();
  if (!target) {
    return false;
  }
  const capabilities = Array.isArray(provider.capabilities)
    ? provider.capabilities
    : [provider.capability];
  return capabilities.map((item) => String(item || "").trim()).includes(target);
}

function isLocalCapabilityProvider(provider = {}) {
  return ["local_browser", "local_computer_use", "local_file"].includes(
    String(provider.adapter || "").trim().toLowerCase(),
  );
}

function localCapabilityProviderPreflightText(provider = {}) {
  const bridge = capabilityProviderBridgeInfo(provider);
  if (!bridge?.limitation) {
    return provider.name || provider.id || "本地能力供应商";
  }
  return `${provider.name || provider.id || "本地能力供应商"}（${bridge.limitation}）`;
}

function providerTestResultIsStale(lastTest = null) {
  const checkedAtMs = Date.parse(lastTest?.checkedAt || lastTest?.createdAt || "");
  if (!Number.isFinite(checkedAtMs)) {
    return false;
  }
  return Date.now() - checkedAtMs > PREFLIGHT_PROVIDER_TEST_STALE_MS;
}

function capabilityProviderLastTestFailureDetail(lastTest = {}) {
  const parts = [];
  const message = String(lastTest?.message || "").trim();
  if (message) {
    parts.push(message);
  }
  const failedChecks = Array.isArray(lastTest?.checks)
    ? lastTest.checks.filter((check) => check?.status === "fail").slice(0, 3)
    : [];
  for (const check of failedChecks) {
    const label = String(check.label || check.id || "检查项").trim();
    const detail = String(check.message || check.detail || "").trim();
    const text = detail ? `${label}：${detail}` : label;
    if (!parts.some((part) => part.includes(detail || label))) {
      parts.push(text);
    }
  }
  return parts.map((part) => redactSecretText(part)).filter(Boolean).join("；");
}

function codexResourcesPreflightItem(rootDir, {
  homeDir = os.homedir(),
  codexCliSnapshot = null,
  codexPromptInputSnapshot = null,
  codexAppServerSnapshot = null,
} = {}) {
  let resources;
  try {
    resources = listCodexResources({
      rootDir,
      homeDir,
      codexCliSnapshot,
      includeCodexCliSnapshot: true,
      codexPromptInputSnapshot,
      includeCodexPromptInputSnapshot: Boolean(codexPromptInputSnapshot),
      codexAppServerSnapshot,
    });
  } catch (error) {
    return checkItem({
      id: "codex_resources",
      label: "Codex 资源",
      status: "warn",
      detail: `资源中心读取失败：${redactSecretText(error.message || error)}`,
      count: Number.NaN,
      action: "发布前建议打开资源页复制诊断，确认 MCP、插件、Skills 和 AGENTS 规则能被 Codex 正常读取。",
    });
  }

  const summary = resources.pluginPage
    ? { ...(resources.summary || resourceCountSummary(resources)), ...(resources.pluginPage.summary || {}) }
    : (resources.summary || resourceCountSummary(resources));
  const readStatus = resources.pluginPage
    ? { ...(resources.readStatus || {}), ...(resources.pluginPage.readStatus || {}) }
    : (resources.readStatus || {});
  const authority = resources.pluginPage
    ? { ...(resources.authority || {}), ...(resources.pluginPage.authority || {}) }
    : (resources.authority || {});
  const discoveredSummary = resources.discoveredSummary || resourceCountSummary(resources.discovered || {});
  const diagnostics = resourceDiagnosticsSummary(resources.pluginPage || resources);
  const currentAuthorityKinds = resources.pluginPage
    ? ["plugins", "apps", "mcpServers", "skills"]
    : ["mcpServers", "plugins", "skills", "marketplaces"];
  const unavailableCurrentAuthorities = currentAuthorityKinds
    .filter((kind) => summary[kind] === null || readStatus?.[kind]?.ok === false);
  const currentTotal = unavailableCurrentAuthorities.length ? null : sumResourceCounts(summary);
  const discoveredTotal = sumResourceCounts(discoveredSummary);
  const warningCount = resources.pluginPage
    ? 0
    : (codexResourceCurrentAuthorityAvailable(authority)
      ? diagnostics.currentWarnings
      : diagnostics.warnings);
  const status = warningCount || unavailableCurrentAuthorities.length ? "warn" : currentTotal ? "pass" : "warn";
  const discoveredText = discoveredTotal
    ? `本地发现/缓存：${resourceCountText(discoveredSummary)}，不计入当前可用。`
    : "没有额外的未启用或缓存资源。";

  return checkItem({
    id: "codex_resources",
    label: "Codex 资源",
    status,
    detail: `当前可用：${resourceCountText(summary)}。${discoveredText}`,
    count: currentTotal,
    action: unavailableCurrentAuthorities.length
      ? "Codex 官方资源清单未能完整读取；请重试刷新并根据资源页读状态排查 CLI 或 prompt-input，不能把无法读取当作 0。"
      : warningCount
      ? "如果数量和 Codex 里看到的不一致，以当前可用为准；缓存或未启用项需要在 Codex 插件市场或资源页启用后才可用。"
      : discoveredTotal
        ? "以当前可用为准；本地发现或缓存的资源不计入当前可用，需要在 Codex 插件市场或资源页启用后才可用。"
        : "发布前可在资源页查看和复制诊断，确认 MCP、插件、Skills、提示词和规则文件都在预期位置。",
  });
}

function codexResourceCurrentAuthorityAvailable(authority = {}) {
  return [
    authority.plugins,
    authority.mcpServers,
    authority.skills,
  ].some((entry) => {
    const source = String(entry?.source || "").trim();
    return source === "codex-cli" || source === "codex-app-server" || source === "codex-prompt" || source === "local-fallback";
  });
}

function sumResourceCounts(summary = {}) {
  return ["mcpServers", "plugins", "skills", "marketplaces", "prompts", "agentFiles"]
    .reduce((total, kind) => total + resourceNumericCount(summary[kind]), 0);
}

function resourceCountText(summary = {}) {
  return [
    `MCP ${resourceDisplayCount(summary.mcpServers)}`,
    `插件 ${resourceDisplayCount(summary.plugins)}`,
    `技能 ${resourceDisplayCount(summary.skills)}`,
    `市场 ${resourceDisplayCount(summary.marketplaces)}`,
    `提示词 ${resourceDisplayCount(summary.prompts)}`,
    `规则 ${resourceDisplayCount(summary.agentFiles)}`,
  ].join("、");
}

function resourceNumericCount(value) {
  const number = Number(value);
  return value !== null && Number.isFinite(number) ? number : 0;
}

function resourceDisplayCount(value, unavailableText = "无法读取") {
  if (value === null || !Number.isFinite(Number(value))) {
    return unavailableText;
  }
  return String(Number(value));
}

function pluginRuntimePreflightItem({ homeDir = os.homedir() } = {}) {
  const diagnostics = codexPluginRuntimeDiagnostics({ homeDir });
  const summary = diagnostics.summary || {};
  const plugins = summary.plugins || {};
  const enabledPlugins = Object.entries(plugins).filter(([, plugin]) => plugin?.enabled);
  const stalePlugins = enabledPlugins.filter(([, plugin]) => plugin?.stale && plugin?.cached && plugin?.bundled);

  if (stalePlugins.length) {
    return checkItem({
      id: "plugin_runtime",
      label: "插件运行时",
      status: "fail",
      detail: stalePlugins
        .map(([name, plugin]) => `${name}: 缓存 ${plugin.cached}，Codex 内置 ${plugin.bundled}`)
        .join("；"),
      count: stalePlugins.length,
      action: "请先更新 Codex Desktop，重启 Codex 后让内置插件缓存重新生成；否则 Chrome、浏览器或 Computer Use 能力可能异常。",
    });
  }

  if (enabledPlugins.length && summary.ok === false) {
    return checkItem({
      id: "plugin_runtime",
      label: "插件运行时",
      status: "fail",
      detail: `已启用 ${enabledPlugins.length} 个 OpenAI 内置插件，但运行时体检失败：${summary.reason || "unknown"}。`,
      count: enabledPlugins.length,
      action: "请先在资源页复制诊断信息，确认 node_repl、Codex CLI、插件缓存和通知 hook 都可用。",
    });
  }

  if (!enabledPlugins.length) {
    return checkItem({
      id: "plugin_runtime",
      label: "插件运行时",
      status: "pass",
      detail: "当前没有启用 OpenAI 内置插件运行能力；普通模型路由不受影响。",
      count: 0,
      action: "需要 Chrome、浏览器或 Computer Use 时，再到 Codex 插件市场或资源页确认插件状态。",
    });
  }

  return checkItem({
    id: "plugin_runtime",
    label: "插件运行时",
    status: "pass",
    detail: `已启用 ${enabledPlugins.length} 个 OpenAI 内置插件，未发现旧缓存或运行时缺失。`,
    count: enabledPlugins.length,
    action: "发布前体检已覆盖内置插件缓存、node_repl 和本地运行时状态。",
  });
}

function deleteSafetyPreflightItem() {
  const findings = [];
  const unreadable = [];
  for (const relativePath of DELETE_SAFETY_SCAN_FILES) {
    const filePath = path.join(repoRootDir, relativePath);
    let content = "";
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      unreadable.push(`${relativePath}: ${redactSecretText(error.message || error)}`);
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (const [lineIndex, line] of lines.entries()) {
      for (const [command, pattern] of FORBIDDEN_BATCH_DELETE_COMMANDS) {
        if (pattern.test(line)) {
          findings.push(`${relativePath}:${lineIndex + 1} ${command}`);
        }
      }
    }
  }

  if (findings.length) {
    return checkItem({
      id: "delete_safety",
      label: "删除安全",
      status: "fail",
      detail: `发现 ${findings.length} 处禁用的批量删除命令。`,
      count: findings.length,
      action: "发布/更新脚本只能逐个明确路径清理文件；不要使用 del /s、rd /s、rmdir /s、Remove-Item -Recurse 或 rm -rf。",
    });
  }

  if (unreadable.length) {
    return checkItem({
      id: "delete_safety",
      label: "删除安全",
      status: "warn",
      detail: `源码发布脚本未完整随当前包提供，已跳过 ${unreadable.length} 个发版文件检查。`,
      count: unreadable.length,
      action: "这只影响发版自检；普通使用和 Router 启动不受影响。",
    });
  }

  return checkItem({
    id: "delete_safety",
    label: "删除安全",
    status: "pass",
      detail: `已扫描 ${DELETE_SAFETY_SCAN_FILES.length} 个发布/更新文件，未发现禁用的批量删除命令。`,
    count: 0,
      action: "自动更新只能逐个明确路径清理旧安装包和旧版本文件。",
  });
}

function updateFlowPreflightItem({
  platform = process.platform,
  arch = process.arch,
  releaseAssets = null,
  env = process.env,
} = {}) {
  const expectedAssets = expectedUpdateAssetsForPlatform(platform, arch);
  if (!expectedAssets.length) {
    return checkItem({
      id: "update_flow",
      label: "自动更新",
      status: "warn",
      detail: `当前平台 ${platform} ${arch} 没有内置自动更新包规则。`,
      count: 0,
      action: "发布前需要手动确认更新包命名和安装流程。",
    });
  }

  const installerScript = platform === "win32"
    ? windowsInstallerScriptPreflight()
    : null;
  const providedAssets = normalizeReleaseAssetEntries(releaseAssets);
  if (providedAssets) {
    const providedNames = providedAssets.map((asset) => asset.name);
    const provided = new Set(providedNames.map((name) => name.toLowerCase()));
    const legacyNames = legacyUpdateAssetNames(providedNames);
    if (legacyNames.length) {
      return checkItem({
        id: "update_flow",
        label: "自动更新",
        status: "fail",
        detail: `发现容易混淆的旧命名更新包：${legacyNames.join("、")}。`,
        count: legacyNames.length,
        action: "发布目录只保留 CodexBridge-Windows-x64-Setup.exe 和 CodexBridge-Windows-x64-Portable.zip，避免用户点到旧包或只拿到 zip。",
      });
    }
    const missing = expectedAssets.filter((name) => !provided.has(name.toLowerCase()));
    if (missing.length) {
      const setupName = platform === "win32"
        ? assetNameForPlatform(platform, arch, { installKind: "installed" })
        : "";
      const portableName = platform === "win32"
        ? assetNameForPlatform(platform, arch, { installKind: "portable" })
        : "";
      const hasPortableOnlyHint = Boolean(
        setupName &&
        portableName &&
        missing.some((name) => name.toLowerCase() === setupName.toLowerCase()) &&
        provided.has(portableName.toLowerCase()),
      );
      const zipOnlyHint = hasPortableOnlyHint
        ? " Windows 安装版不能只发 zip；安装版自动更新必须提供 Setup.exe。"
        : "";
      return checkItem({
        id: "update_flow",
        label: "自动更新",
        status: "fail",
        detail: `缺少自动更新发布包：${missing.join("、")}。${zipOnlyHint}`,
        count: missing.length,
        action: "Windows 安装版必须发布 Setup.exe；Portable.zip 作为便携版和回退更新包。",
      });
    }

    const invalidArtifacts = providedAssets.filter((asset) =>
      expectedAssets.some((name) => name.toLowerCase() === asset.name.toLowerCase()) &&
        asset.hasSize &&
        asset.size <= 0,
    );
    if (invalidArtifacts.length) {
      return checkItem({
        id: "update_flow",
        label: "自动更新",
        status: "fail",
        detail: `发布包文件大小异常：${invalidArtifacts.map((asset) => `${asset.name} ${formatBytes(asset.size)}`).join("、")}。`,
        count: invalidArtifacts.length,
        action: "重新生成 Windows 发布包，确认 Setup.exe 和 Portable.zip 都不是空文件后再发布。",
      });
    }

    const invalidFormats = releaseAssetFormatFailures(providedAssets, { platform, arch });
    if (invalidFormats.length) {
      return checkItem({
        id: "update_flow",
        label: "自动更新",
        status: "fail",
        detail: `发布包文件头格式异常：${invalidFormats.map((item) => `${item.name} 不是有效的 ${item.expected}`).join("、")}。`,
        count: invalidFormats.length,
        action: "重新生成 Windows 发布包，确认 Setup.exe 是 Windows 安装器，Portable.zip 是有效 ZIP 文件后再发布。",
      });
    }

    if (installerScript && !installerScript.ok) {
      return checkItem({
        id: "update_flow",
        label: "自动更新",
        status: "fail",
        detail: `安装器脚本还缺 ${installerScript.missing.length} 项发版要求。`,
        count: installerScript.missing.length,
        action: "正式发 Windows 安装包前需要补齐安装目录、桌面图标、启动新版和清理参数。",
      });
    }

    const installerScriptText = installerScript?.ok
      ? "安装脚本已覆盖可选安装目录、桌面图标、启动新版、清理安装包。"
      : "";

    return checkItem({
      id: "update_flow",
      label: "自动更新",
      status: "pass",
    detail: `需要的安装包命名已确认：${expectedAssets.join("、")}。${installerScriptText}`,
    count: expectedAssets.length,
    action: "正式发版时会继续检查 Setup.exe、Portable.zip 和安装脚本。",
    });
  }

  if (installerScript && !installerScript.ok) {
    return checkItem({
      id: "update_flow",
      label: "自动更新",
      status: "warn",
      detail: "没有选择安装包目录；自动更新安装器只在正式发包前检查。",
      count: installerScript.missing.length,
      action: "普通使用可忽略；正式发包前选择安装包目录再检查。",
    });
  }

  const installerBuilder = platform === "win32"
    ? windowsInstallerBuilderPreflight(env)
    : null;
  if (installerBuilder && !installerBuilder.ok) {
    return checkItem({
      id: "update_flow",
      label: "自动更新",
      status: "warn",
      detail: `安装包命名规则已确认；本机没有 NSIS，当前机器不能生成真实 Setup.exe。`,
      count: expectedAssets.length,
      action: "普通使用可忽略；正式发包交给 Windows 发包任务或安装 NSIS。",
    });
  }

  const installerScriptText = installerScript?.ok
    ? "安装脚本已覆盖可选安装目录、桌面图标、启动新版、清理安装包。"
    : "";
  const installerBuilderText = installerBuilder?.ok
    ? `本机已找到 NSIS / makensis：${installerBuilder.path}。`
    : "";

  return checkItem({
    id: "update_flow",
    label: "自动更新",
    status: "pass",
    detail: `安装包命名规则已确认：${expectedAssets.join("、")}。${installerBuilderText || installerScriptText}`,
    count: expectedAssets.length,
    action: "正式发版时再检查真实安装包和安装脚本流程。",
  });
}

function windowsInstallerBuilderPreflight(env = process.env) {
  const programFilesX86 = String(env?.["ProgramFiles(x86)"] || "").trim();
  const configured = normalizeExecutablePath(env?.MAKENSIS_EXE);
  const candidates = [
    configured,
    programFilesX86 ? path.join(programFilesX86, "NSIS", "makensis.exe") : "",
    ...executablePathsFromEnvPath("makensis.exe", env),
    ...executablePathsFromEnvPath("makensis", env),
  ].filter(Boolean);
  const seen = new Set();
  for (const candidate of candidates) {
    const clean = normalizeExecutablePath(candidate);
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (fs.existsSync(clean)) {
      return { ok: true, path: clean };
    }
  }
  return {
    ok: false,
    path: "",
  };
}

function executablePathsFromEnvPath(commandName, env = process.env) {
  const rawPath = String(env?.PATH || env?.Path || "").trim();
  if (!rawPath) {
    return [];
  }
  return rawPath
    .split(path.delimiter)
    .map((entry) => normalizeExecutablePath(path.join(entry, commandName)))
    .filter(Boolean);
}

function normalizeExecutablePath(value = "") {
  return String(value || "").trim().replace(/^"|"$/g, "");
}

function windowsInstallerScriptPreflight() {
  const scriptPath = path.join(repoRootDir, "scripts", "installer", "windows", "CodexBridge.nsi");
  if (!fs.existsSync(scriptPath)) {
    return {
      ok: false,
      missing: ["安装脚本缺失"],
    };
  }
  let content = "";
  try {
    content = fs.readFileSync(scriptPath, "utf8");
  } catch (error) {
    return {
      ok: false,
      missing: [`安装脚本读取失败：${redactSecretText(error.message || error)}`],
    };
  }
  const checks = [
    ["可选安装目录", /!insertmacro\s+MUI_PAGE_DIRECTORY/],
    ["用户目录默认安装", /InstallDir\s+"\$LOCALAPPDATA\\Programs\\CodexBridge"/],
    ["桌面图标", /CreateShortCut\s+"\$DESKTOP\\CodexBridge\.lnk"/],
    ["启动新版", /ExecShell\s+""\s+"\$INSTDIR\\app-\$\{VERSION\}\\CodexBridge\.exe"\s+"[^"]*--updated/],
    ["旧版清理参数", /--previous-install-dir/],
    ["清理安装包参数", /--cleanup-installer/],
  ];
  const missing = checks
    .filter(([, pattern]) => !pattern.test(content))
    .map(([label]) => label);
  if (/RMDir\s+\/r|Delete\s+\/REBOOTOK|Remove-Item\s+-Recurse|rm\s+-rf|rmdir\s+\/s|rd\s+\/s|del\s+\/s/i.test(content)) {
    missing.push("安装脚本包含批量删除命令");
  }
  return {
    ok: missing.length === 0,
    missing,
  };
}

function expectedUpdateAssetsForPlatform(platform = process.platform, arch = process.arch) {
  const names = [
    assetNameForPlatform(platform, arch, { installKind: "installed" }),
    assetNameForPlatform(platform, arch, { installKind: "portable" }),
  ].filter(Boolean);
  return [...new Set(names)];
}

function legacyUpdateAssetNames(releaseAssets = []) {
  return releaseAssets.filter((name) => {
    const value = String(name || "").trim();
    if (!value) {
      return false;
    }
    return [
      /^CodexBridge-windows-portable/i,
      /^CodexBridge-win32-x64/i,
      /^CodexBridge-Windows-x64-Portable-v/i,
      /^CodexBridge-Windows-x64-Setup-v/i,
    ].some((pattern) => pattern.test(value));
  });
}

function normalizeReleaseAssetEntries(releaseAssets) {
  if (!Array.isArray(releaseAssets)) {
    return null;
  }
  return releaseAssets
    .map((asset) => {
      const name = String(typeof asset === "string" ? asset : asset?.name || "").trim();
      if (!name) {
        return null;
      }
      const rawSize = typeof asset === "string" ? undefined : asset?.size;
      const size = Number(rawSize);
      return {
        name,
        path: String(typeof asset === "string" ? "" : asset?.path || "").trim(),
        hasSize: Number.isFinite(size),
        size: Number.isFinite(size) ? Math.max(0, Math.round(size)) : 0,
        headerHex: String(typeof asset === "string" ? "" : asset?.headerHex || "").trim().toLowerCase(),
      };
    })
    .filter(Boolean);
}

function releaseAssetFormatFailures(assets = [], { platform = process.platform, arch = process.arch } = {}) {
  if (platform !== "win32") {
    return [];
  }
  const setupName = assetNameForPlatform(platform, arch, { installKind: "installed" }).toLowerCase();
  const portableName = assetNameForPlatform(platform, arch, { installKind: "portable" }).toLowerCase();
  const failures = [];
  for (const asset of assets) {
    const name = String(asset.name || "").trim();
    const key = name.toLowerCase();
    const header = String(asset.headerHex || "").trim().toLowerCase();
    if (!header) {
      continue;
    }
    if (key === setupName && !header.startsWith("4d5a")) {
      failures.push({ name, expected: "Windows EXE 安装器" });
    }
    if (key === portableName && !header.startsWith("504b")) {
      failures.push({ name, expected: "ZIP 压缩包" });
    }
  }
  return failures;
}

function normalizeReleaseAssetNames(releaseAssets) {
  const entries = normalizeReleaseAssetEntries(releaseAssets);
  return entries ? entries.map((asset) => asset.name) : null;
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
      .filter((keyEnv) => keyEnv && !isRouterControlEnvName(keyEnv)),
  );
  keys.add("OPENAI_API_KEY");
  for (const settings of Object.values(readModelImageGenerationOverrides(rootDir))) {
    if (settings?.apiKeyEnv && !isRouterControlEnvName(settings.apiKeyEnv)) {
      keys.add(settings.apiKeyEnv);
    }
  }
  return keys;
}

function secretStatusForMutationState(rootDir, state) {
  const keys = new Set(
    providerCatalog(rootDir, state)
      .map((provider) => provider.keyEnv)
      .filter((keyEnv) => keyEnv && !isRouterControlEnvName(keyEnv)),
  );
  keys.add("OPENAI_API_KEY");
  for (const settings of Object.values(state?.modelImageGeneration || {})) {
    if (settings?.apiKeyEnv && !isRouterControlEnvName(settings.apiKeyEnv)) {
      keys.add(settings.apiKeyEnv);
    }
  }
  return Object.fromEntries(
    [...keys]
      .sort()
      .map((keyEnv) => [keyEnv, Boolean(state?.secrets?.[keyEnv])]),
  );
}

function providerApiKeyEnv(value) {
  const keyEnv = String(value || "").trim();
  if (isRouterControlEnvName(keyEnv)) {
    throw new Error(
      `${keyEnv} is a Router control environment variable and cannot be used as an API key env.`,
    );
  }
  return keyEnv;
}

function isRouterControlEnvName(value) {
  return ROUTER_CONTROL_ENV_NAMES.has(String(value || "").trim().toUpperCase());
}

export function envWithSecrets(rootDir, baseEnv = process.env) {
  return {
    ...baseEnv,
    ...loadSecrets(rootDir),
  };
}

export function routerRuntimeEnv(rootDir, baseEnv = process.env) {
  const env = {
    ...envWithSecrets(rootDir, baseEnv),
    CODEXBRIDGE_DATA_DIR: rootDir,
    ROUTER_CONFIG: routerConfigPath(rootDir),
    CODEXBRIDGE_SECRETS_FILE: secretsPath(rootDir),
  };
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
  codexCliSnapshot = null,
  codexPromptInputSnapshot = null,
} = {}) {
  const options = loadDesktopOptions(rootDir);
  const routeDiagnostics = routerConfigDiagnostics(rootDir, config);
  const historyDiagnostics = codexHistoryDiagnostics({ homeDir });
  const pluginDiagnostics = codexPluginRuntimeDiagnostics({ homeDir });
  const codexResources = listCodexResources({
    rootDir,
    homeDir,
    codexCliSnapshot,
    includeCodexCliSnapshot: true,
    codexPromptInputSnapshot,
    includeCodexPromptInputSnapshot: Boolean(codexPromptInputSnapshot),
  });
  const releasePreflight = buildStartupCheck(rootDir, {
    homeDir,
    appVersion,
    routerRunning,
    lastHealth,
    config,
    proxyEnv,
    platform,
    arch,
    codexCliSnapshot,
    codexPromptInputSnapshot,
  });
  const effectiveProxyEnv = proxyEnvWithDesktopOptions(proxyEnv, options);
  const secretMap = loadSecrets(rootDir);
  const imageProviderDiagnostics = imageProviderDiagnosticsForSupport(rootDir, secretMap);
  const selectedRoutes = Array.isArray(config?.models) ? config.models : [];
  const selectedKeyEnvs = [
    ...new Set(
      selectedRoutes
        .map((route) => route.apiKeyEnv || route.keyEnv || "")
        .filter(Boolean),
    ),
  ].sort();
  const errorLines = StringLines(logs)
    .filter((line) =>
      !/\broute_trace\b/i.test(line) &&
        /\b(error|status=4\d\d|status=5\d\d|!! upstream|compact-local-fallback|rate-limit|Health failed|Preflight)/i.test(line)
    )
    .slice(-20)
    .map(redactSecretText);
  const toolLines = StringLines(logs)
    .filter((line) => /\btool(?:_return)?_diag\b/i.test(line))
    .slice(-20)
    .map(redactSecretText);
  const routeDecisionLines = routeDecisionDiagnosticsLines(logs);

  const lines = [
    "CodexBridge Diagnostics",
    `version: ${appVersion || "unknown"}`,
    `platform: ${platform} ${arch} ${release}`,
    `dataRoot: ${rootDir}`,
    `routerRunning: ${Boolean(routerRunning)}`,
    `routerPort: ${config?.port || 15722}`,
    `bypassSystemProxy: ${Boolean(options.bypassSystemProxy)}`,
    `autoSelectModel: ${Boolean(options.autoSelectModel)}`,
    `autoFailover: ${Boolean(options.autoFailover)}`,
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
    "Image provider diagnostics:",
    ...imageProviderDiagnostics.lines,
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
    "Release preflight:",
    ...releasePreflightDiagnosticsLines(releasePreflight),
    "",
    "Codex history diagnostics:",
    ...historyDiagnostics.lines,
    "",
    "Codex plugin diagnostics:",
    ...pluginDiagnostics.lines,
    "",
    "Codex resource diagnostics:",
    ...resourceDiagnosticsLines(codexResources),
    "",
    "Recent tool diagnostics:",
    ...(toolLines.length ? toolLines.map((line) => `- ${line}`) : ["- none"]),
    "",
    "Recent route decisions:",
    ...(routeDecisionLines.length ? routeDecisionLines.map((line) => `- ${line}`) : ["- none"]),
    "",
    "Recent errors:",
    ...(errorLines.length ? errorLines.map((line) => `- ${line}`) : ["- none"]),
  ];

  return {
    summary: {
      ok:
        routeDiagnostics.ok &&
        pluginDiagnostics.summary.ok &&
        Boolean(releasePreflight.summary?.ok) &&
        routeHealthSummary(lastHealth).unhealthyRoutes === 0 &&
        Boolean(lastHealth?.ok || !routerRunning),
      missingApiKeys: routeDiagnostics.missingApiKeys,
      invalidBaseUrls: routeDiagnostics.invalidBaseUrls,
      errorCount: errorLines.length,
      toolDiagnosticCount: toolLines.length,
      routeDecisionCount: routeDecisionLines.length,
      unhealthyRoutes: routeHealthSummary(lastHealth).unhealthyRoutes,
      usage: usageDiagnosticsSummary(usageSummary),
      requestLimits: requestLimitDiagnosticsSummary(config),
      resources: resourceDiagnosticsSummary(codexResources),
      proxy: proxyDiagnosticsSummary(proxyEnv),
      effectiveProxyRoutes: effectiveUpstreamProxySummary(selectedRoutes, effectiveProxyEnv, proxySettingsOptions),
      update: {
        updateDir,
        updateDirExists: safeExists(updateDir),
      },
      releasePreflight: {
        ok: Boolean(releasePreflight.summary?.ok),
        statusCounts: {
          pass: Number(releasePreflight.summary?.pass || 0),
          warn: Number(releasePreflight.summary?.warn || 0),
          fail: Number(releasePreflight.summary?.fail || 0),
        },
        releaseGate: releasePreflightGateSummary(releasePreflight),
        strictReleaseGate: releasePreflightGateSummary(releasePreflight, { strictWarnings: true }),
        codeReady: releasePreflightCodeReadySummary(releasePreflight),
      },
      modelCapabilityOverrides: Object.keys(readModelCapabilityOverrides(rootDir)).length,
      modelDirectory: modelDirectoryDiagnosticsSummary(rootDir),
      imageProviders: imageProviderDiagnostics.summary,
      codexModelCatalog: codexModelCatalogDiagnosticsSummary(homeDir),
      history: historyDiagnostics.summary,
      codexPlugins: pluginDiagnostics.summary,
    },
    text: lines.join("\n"),
  };
}

function routeDecisionDiagnosticsLines(logs = []) {
  return StringLines(logs)
    .map(routeDecisionDiagnosticLine)
    .filter(Boolean)
    .slice(-20)
    .map(redactSecretText);
}

function routeDecisionDiagnosticLine(line = "") {
  const text = String(line || "");
  const marker = " route_trace ";
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) {
    return "";
  }
  const payload = text.slice(markerIndex + marker.length).trim();
  if (!payload) {
    return "";
  }
  try {
    const trace = JSON.parse(payload);
    return routeDecisionSummaryForLog(trace);
  } catch {
    return "";
  }
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

function imageProviderDiagnosticsForSupport(rootDir, secretMap = {}) {
  const config = readImageProviderConfig(rootDir);
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const testedProviders = providers.filter((provider) => provider.lastTest).length;
  const failedProviders = providers.filter((provider) => provider.lastTest?.ok === false).length;
  const summary = {
    providerCount: providers.length,
    defaultProviderId: config.defaultProviderId || "",
    testedProviders,
    failedProviders,
    untestedProviders: providers.length - testedProviders,
  };
  const lines = [`- defaultProviderId: ${redactSecretText(config.defaultProviderId || "none")}`];
  if (!providers.length) {
    lines.push("- providers: none");
    return { lines, summary };
  }
  for (const provider of providers) {
    const keyState = provider.apiKeyEnv
      ? `${redactSecretText(provider.apiKeyEnv)}:${secretMap[provider.apiKeyEnv] || process.env[provider.apiKeyEnv] ? "saved" : "missing"}`
      : "none";
    const lastTest = imageProviderLastTestDiagnostic(provider.lastTest);
    lines.push(
      `- ${redactSecretText(provider.id)}: ${redactSecretText(provider.name)} ` +
        `adapter=${redactSecretText(provider.adapter || "")} ` +
        `model=${redactSecretText(provider.model || "")} ` +
        `size=${redactSecretText(provider.size || "")} ` +
        `key=${keyState} ` +
        `lastTest=${lastTest}`,
    );
  }
  return { lines, summary };
}

function imageProviderLastTestDiagnostic(lastTest = null) {
  if (!lastTest) {
    return "untested";
  }
  const status = lastTest.ok ? "pass" : "fail";
  const parts = [status];
  if (Number.isFinite(Number(lastTest.durationMs))) {
    parts.push(`${Math.round(Number(lastTest.durationMs))}ms`);
  }
  if (lastTest.checkedAt) {
    parts.push(`checkedAt=${redactSecretText(lastTest.checkedAt)}`);
  }
  if (lastTest.message) {
    parts.push(`message=${redactSecretText(lastTest.message).slice(0, 160)}`);
  }
  return parts.join(" ");
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

function releasePreflightDiagnosticsLines(check = {}) {
  const summary = check?.summary || {};
  const items = Array.isArray(check?.items) ? check.items : [];
  const releaseGate = releasePreflightGateSummary(check);
  const strictReleaseGate = releasePreflightGateSummary(check, { strictWarnings: true });
  const codeReady = releasePreflightCodeReadySummary(check);
  const lines = [
    `- ok: ${Boolean(summary.ok)}`,
    `- statusCounts: pass=${Number(summary.pass || 0)}, warn=${Number(summary.warn || 0)}, fail=${Number(summary.fail || 0)}`,
    releaseGateDiagnosticsLine("releaseGate", releaseGate),
    releaseGateDiagnosticsLine("strictReleaseGate", strictReleaseGate),
    codeReadyDiagnosticsLine(codeReady),
  ];
  if (!items.length) {
    lines.push("- no preflight items");
    return lines;
  }
  for (const item of items) {
    const parts = [
      `- ${redactSecretText(item.label || item.id || "unknown")}: ${redactSecretText(item.status || "warn")}`,
    ];
    if (item.count !== null && item.count !== undefined) {
      parts.push(`count=${Number(item.count)}`);
    }
    if (item.detail) {
      parts.push(`detail=${redactSecretText(item.detail)}`);
    }
    if (item.action) {
      parts.push(`action=${redactSecretText(item.action)}`);
    }
    lines.push(parts.join(" "));
  }
  return lines;
}

function releaseGateDiagnosticsLine(label, releaseGate = {}) {
  return `- ${label}: reason=${redactSecretText(releaseGate.reason)} codeOrConfigOk=${releaseGate.codeOrConfigOk ? "true" : "false"} blockingItemIds=${releaseGate.blockingItemIds.map(redactSecretText).join(",") || "none"} realEvidenceBlockingItemIds=${releaseGate.realEvidenceBlockingItemIds.map(redactSecretText).join(",") || "none"} localSetupBlockingItemIds=${releaseGate.localSetupBlockingItemIds.map(redactSecretText).join(",") || "none"} codeOrConfigBlockingItemIds=${releaseGate.codeOrConfigBlockingItemIds.map(redactSecretText).join(",") || "none"} failureItemIds=${releaseGate.failureItemIds.map(redactSecretText).join(",") || "none"} warningItemIds=${releaseGate.warningItemIds.map(redactSecretText).join(",") || "none"}`;
}

function codeReadyDiagnosticsLine(codeReady = {}) {
  const ignoredRealEvidenceItemIds = Array.isArray(codeReady.ignoredRealEvidenceItemIds)
    ? codeReady.ignoredRealEvidenceItemIds
    : [];
  const ignoredLocalSetupItemIds = Array.isArray(codeReady.ignoredLocalSetupItemIds)
    ? codeReady.ignoredLocalSetupItemIds
    : [];
  const codeOrConfigBlockingItemIds = Array.isArray(codeReady.codeOrConfigBlockingItemIds)
    ? codeReady.codeOrConfigBlockingItemIds
    : [];
  const failureItemIds = Array.isArray(codeReady.failureItemIds) ? codeReady.failureItemIds : [];
  const warningItemIds = Array.isArray(codeReady.warningItemIds) ? codeReady.warningItemIds : [];
  return `- codeReady: ok=${codeReady.ok ? "true" : "false"} codeOrConfigOk=${codeReady.codeOrConfigOk ? "true" : "false"} ignoredRealEvidenceItemIds=${ignoredRealEvidenceItemIds.map(redactSecretText).join(",") || "none"} ignoredLocalSetupItemIds=${ignoredLocalSetupItemIds.map(redactSecretText).join(",") || "none"} codeOrConfigBlockingItemIds=${codeOrConfigBlockingItemIds.map(redactSecretText).join(",") || "none"} failureItemIds=${failureItemIds.map(redactSecretText).join(",") || "none"} warningItemIds=${warningItemIds.map(redactSecretText).join(",") || "none"}`;
}

const REAL_EVIDENCE_RELEASE_ITEM_IDS = new Set([
  "router",
  "route_health",
  "image_generation_proxy",
  "capability_providers",
  "real_environment_acceptance",
  "update_flow",
]);

const LOCAL_SETUP_RELEASE_ITEM_IDS = new Set([
  "codex_config",
  "codex_desktop",
  "model_catalog",
  "codex_resources",
]);

export function releasePreflightGateSummary(check = {}, { strictWarnings = false } = {}) {
  const summary = check?.summary || {};
  const failCount = Number(summary.fail || 0);
  const warnCount = Number(summary.warn || 0);
  const failureItemIds = releaseItemIdsByStatus(check?.items, "fail");
  const warningItemIds = releaseItemIdsByStatus(check?.items, "warn");
  const blockingItemIds = [
    ...failureItemIds,
    ...(strictWarnings ? warningItemIds : []),
  ];
  const realEvidenceRequiredItemIds = releaseItemIdsRequiringRealEvidence(check?.items);
  const realEvidenceBlockingSet = new Set(
    realEvidenceRequiredItemIds.filter((itemId) => blockingItemIds.includes(itemId)),
  );
  const realEvidenceBlockingItemIds = blockingItemIds.filter((itemId) => realEvidenceBlockingSet.has(itemId));
  const declaredLocalSetupItemIds = new Set(
    (Array.isArray(check?.items) ? check.items : [])
      .filter((item) => item?.blockingClass === "local_setup")
      .map((item) => String(item.id || "").trim())
      .filter(Boolean),
  );
  const localSetupBlockingItemIds = blockingItemIds.filter((itemId) =>
    !realEvidenceBlockingSet.has(itemId) &&
      (LOCAL_SETUP_RELEASE_ITEM_IDS.has(itemId) || declaredLocalSetupItemIds.has(itemId))
  );
  const localSetupBlockingSet = new Set(localSetupBlockingItemIds);
  const codeOrConfigBlockingItemIds = blockingItemIds.filter((itemId) =>
    !realEvidenceBlockingSet.has(itemId) && !localSetupBlockingSet.has(itemId)
  );
  const codeOrConfigOk = codeOrConfigBlockingItemIds.length === 0;
  return {
    ok: Boolean(summary.ok) && (!strictWarnings || warnCount === 0),
    strictWarnings: Boolean(strictWarnings),
    blockedByWarnings: Boolean(strictWarnings && failCount === 0 && warnCount > 0),
    blockedByFailures: failCount > 0,
    failureItemIds,
    warningItemIds,
    blockingItemIds,
    realEvidenceRequiredItemIds,
    realEvidenceBlockingItemIds,
    localSetupBlockingItemIds,
    codeOrConfigBlockingItemIds,
    codeOrConfigOk,
    realEvidenceBlockingItems: releaseGateItemsByIds(check?.items, realEvidenceBlockingItemIds),
    localSetupBlockingItems: releaseGateItemsByIds(check?.items, localSetupBlockingItemIds),
    codeOrConfigBlockingItems: releaseGateItemsByIds(check?.items, codeOrConfigBlockingItemIds),
    reason: failCount > 0
      ? "failures"
      : strictWarnings && warnCount > 0
        ? "strict_warnings"
        : "ok",
  };
}

export function releasePreflightCodeReadySummary(check = {}) {
  const strictGate = releasePreflightGateSummary(check, { strictWarnings: true });
  return {
    ok: strictGate.codeOrConfigOk,
    strictWarnings: true,
    codeOrConfigOk: strictGate.codeOrConfigOk,
    failureItemIds: strictGate.failureItemIds,
    warningItemIds: strictGate.warningItemIds,
    codeOrConfigBlockingItemIds: strictGate.codeOrConfigBlockingItemIds,
    codeOrConfigBlockingItems: strictGate.codeOrConfigBlockingItems,
    ignoredRealEvidenceItemIds: strictGate.realEvidenceBlockingItemIds,
    ignoredRealEvidenceItems: strictGate.realEvidenceBlockingItems,
    ignoredLocalSetupItemIds: strictGate.localSetupBlockingItemIds,
    ignoredLocalSetupItems: strictGate.localSetupBlockingItems,
  };
}

function releaseItemIdsByStatus(items = [], status = "") {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item?.status === status)
    .map((item) => String(item.id || "").trim())
    .filter(Boolean);
}

function releaseItemIdsRequiringRealEvidence(items = []) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item?.status === "warn" || item?.status === "fail")
    .map((item) => String(item.id || "").trim())
    .filter((itemId) => REAL_EVIDENCE_RELEASE_ITEM_IDS.has(itemId));
}

function releaseGateItemsByIds(items = [], itemIds = []) {
  const byId = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const id = String(item?.id || "").trim();
    if (id && !byId.has(id)) {
      byId.set(id, item);
    }
  }
  return (Array.isArray(itemIds) ? itemIds : [])
    .map((itemId) => releaseGateItemDetails(byId.get(itemId), itemId))
    .filter(Boolean);
}

function releaseGateItemDetails(item = {}, fallbackId = "") {
  const id = String(item?.id || fallbackId || "").trim();
  if (!id) {
    return null;
  }
  const detail = {
    id,
    label: String(item?.label || id).trim(),
    status: String(item?.status || "warn").trim(),
  };
  if (item?.count !== null && item?.count !== undefined) {
    detail.count = Number(item.count || 0);
  }
  if (item?.detail) {
    detail.detail = String(item.detail);
  }
  if (item?.action) {
    detail.action = String(item.action);
  }
  return detail;
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
        `missingUserEvent=${item.missingUserEvent}`,
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

export function listCodexResources({
  rootDir = process.cwd(),
  homeDir = os.homedir(),
  codexCliSnapshot = null,
  codexPromptInputSnapshot = null,
  codexAppServerSnapshot = null,
  includeCodexCliSnapshot = false,
  includeCodexPromptInputSnapshot = false,
  includeCodexAppServerSnapshot = false,
} = {}) {
  const configPath = codexConfigPath(homeDir);
  let content = "";
  let configReadError = null;
  try {
    content = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  } catch (error) {
    configReadError = error;
  }
  const cliSnapshot = codexCliSnapshot || (includeCodexCliSnapshot ? readCodexCliResourceSnapshot({ homeDir }) : null);
  const promptInputSnapshot = codexPromptInputSnapshot ||
    (includeCodexPromptInputSnapshot ? readCodexPromptInputSnapshot({ homeDir }) : null);
  const appServerSnapshot = codexAppServerSnapshot ||
    (includeCodexAppServerSnapshot ? readCodexAppServerResourceSnapshot({ rootDir, homeDir }) : null);
  const promptSkillSnapshot = normalizeCodexPromptInputSkills(promptInputSnapshot?.items || [], { homeDir });
  const usePromptSkills = promptInputSnapshot?.ok === true && promptSkillSnapshot.ok;
  const cliPlugins = normalizeCodexCliPlugins(cliSnapshot?.plugins?.items || []);
  const cliMcpServers = normalizeCodexCliMcpServers(cliSnapshot?.mcpServers?.items || []);
  const cliPluginSnapshotOk = cliSnapshot?.plugins?.ok === true;
  const useCliPluginAvailability = cliSnapshot?.plugins?.available?.ok === true ||
    (cliPluginSnapshotOk && !cliSnapshot?.plugins?.available);
  const useCliMcpServers = cliSnapshot?.mcpServers?.ok === true;
  const readStatus = {
    plugins: codexResourceReadStatus(cliSnapshot?.plugins, "codex-cli"),
    mcpServers: codexResourceReadStatus(cliSnapshot?.mcpServers, "codex-cli"),
    skills: usePromptSkills
      ? codexResourceReadStatus({ ok: true }, "codex-prompt-input")
      : codexResourceReadStatus(
          {
            ok: false,
            code: promptInputSnapshot?.ok === true ? "unsupported_schema" : promptInputSnapshot?.code,
            error: promptInputSnapshot?.ok === true
              ? "Codex prompt-input 未返回可识别的 Available skills 清单。"
              : promptInputSnapshot?.error,
          },
          "codex-prompt-input",
        ),
    marketplaces: configReadError
      ? codexResourceReadStatus({ ok: false, code: "config_read_failed", error: configReadError?.message }, "config")
      : codexResourceReadStatus({ ok: true }, "config"),
  };
  const configuredMcpServers = parseMcpServers(content);
  const runtimeMcpServers = (useCliMcpServers
    ? cliMcpServers
        .filter((item) => item.enabled)
        .map((item) => mergeCodexCliMcpServer(item, configuredMcpServers))
    : [])
    .map(addMcpResourceManagement);
  const marketplaces = listCodexPluginMarketplaces(content);
  const configuredPlugins = parseCodexPlugins(content);
  const enabledPlugins = configuredPlugins.filter((item) => item.enabled);
  const pluginRuntime = codexPluginRuntimeDiagnostics({ homeDir }).summary?.plugins || {};
  const cachedPlugins = annotatePluginRuntime(listCodexPluginCache(homeDir), pluginRuntime);
  const configuredPluginIds = new Set(configuredPlugins.map((item) => normalizedResourceId(item.id)));
  const cliPluginIds = new Set(cliPlugins.map((item) => normalizedResourceId(item.id)));
  const cliInstalledPlugins = cliPlugins.filter((plugin) => plugin.installed && plugin.enabled);
  const desktopRuntimeInstalledPlugins = desktopRuntimeInstalledPluginResources(
    cachedPlugins,
    promptSkillSnapshot.items,
  );
  const useCliPlugins = cliPluginSnapshotOk;
  const disabledPlugins = configuredPlugins
    .filter((item) => !item.enabled)
    .map((item) => mergeConfiguredPluginCache(item, cachedPlugins, "disabled", pluginRuntime));
  const cliDisabledPlugins = useCliPlugins
    ? cliPlugins
        .filter((plugin) => plugin.installed && !plugin.enabled)
        .map((plugin) => mergeCodexCliPlugin(plugin, configuredPlugins, cachedPlugins, "disabled", pluginRuntime))
    : [];
  const configOnlyEnabledPlugins = useCliPlugins
    ? enabledPlugins
        .filter((plugin) => !cliPluginIds.has(normalizedResourceId(plugin.id)))
        .map((plugin) => mergeConfiguredPluginCache(
          plugin,
          cachedPlugins,
          isCodexInternalPlugin(plugin) ? "internal" : "config_only",
          pluginRuntime,
        ))
    : [];
  const currentPlugins = uniqueResourceItems([
    ...(useCliPlugins
      ? cliInstalledPlugins
        .map((plugin) => mergeCodexCliPlugin(
          plugin,
          configuredPlugins,
          cachedPlugins,
          plugin.enabled === false ? "disabled" : isCodexInternalPlugin(plugin) ? "internal" : "installed",
          pluginRuntime,
        ))
      : []),
    ...desktopRuntimeInstalledPlugins,
  ], (item) => item.id);
  const pluginPageAvailablePlugins = useCliPluginAvailability
    ? cliPlugins
        .filter((plugin) => !plugin.installed)
        .filter(isCodexPluginPageAvailablePlugin)
        .map((plugin) => mergeCodexCliPlugin(plugin, configuredPlugins, cachedPlugins, "marketplace", pluginRuntime))
    : [];
  const pluginPagePlugins = uniqueResourceItems([
    ...currentPlugins.filter(isCodexPluginPageInstalledPlugin),
  ], (item) => item.id);
  const activePluginIds = pluginPagePlugins
    .filter((plugin) => plugin.installed !== false)
    .filter((plugin) => plugin.enabled !== false && plugin.availability !== "disabled")
    .map((plugin) => normalizedResourceId(plugin.id));
  const activePluginIdSet = new Set(activePluginIds);
  const internalCurrentPlugins = currentPlugins
    .filter((plugin) => !isCodexPluginPageInstalledPlugin(plugin))
    .map((plugin) => ({
      ...plugin,
      availability: plugin.enabled === false || plugin.availability === "disabled"
        ? "disabled"
        : isCodexInternalPlugin(plugin)
          ? "internal"
          : "external",
    }));
  const configuredDiagnosticPlugins = useCliPlugins
    ? []
    : enabledPlugins
        .map((plugin) => mergeConfiguredPluginCache(
          plugin,
          cachedPlugins,
          isCodexInternalPlugin(plugin) ? "internal" : "config_only",
          pluginRuntime,
        ));
  const plugins = pluginPagePlugins
    .map(addPluginResourceManagement);
  const currentPluginIds = new Set(plugins.map((item) => normalizedResourceId(item.id)));
  const cachedOnlyPlugins = cachedPlugins
    .filter((plugin) => !currentPluginIds.has(normalizedResourceId(plugin.id)))
    .filter((plugin) => !configuredPluginIds.has(normalizedResourceId(plugin.id)))
    .filter((plugin) => !cliPluginIds.has(normalizedResourceId(plugin.id)))
    .map((plugin) => ({ ...plugin, availability: "cached" }));
  const marketplaceAvailablePlugins = useCliPluginAvailability
    ? cliPlugins
        .filter((plugin) => !plugin.installed)
        .filter(isCodexMarketplacePlugin)
        .filter((plugin) => !isCodexPluginPageAvailablePlugin(plugin))
        .map((plugin) => mergeCodexCliPlugin(plugin, configuredPlugins, cachedPlugins, "marketplace", pluginRuntime))
    : [];
  const pluginMcpServers = listPluginMcpResources(
    pluginPagePlugins.filter((plugin) => activePluginIdSet.has(normalizedResourceId(plugin.id))),
  );
  const mcpServers = runtimeMcpServers;
  const currentMcpNames = new Set(mcpServers.map((item) => normalizedResourceId(item.name)));
  const fileVisibleSkills = uniqueResourceItems(listCodexSkillFiles(homeDir), skillResourceKey);
  const promptVisibleSkills = usePromptSkills
    ? promptSkillSnapshot.items.map((item) => ({ ...item, availability: "prompt", enabled: true }))
    : [];
  const currentSkillItems = usePromptSkills ? promptVisibleSkills : [];
  const currentSkillKeyFn = skillResourceKey;
  const skills = uniqueResourceItems(currentSkillItems, currentSkillKeyFn).map(addSkillResourceManagement);
  const currentSkillKeys = new Set(skills.map(currentSkillKeyFn));
  const discovered = {
    mcpServers: uniqueResourceItems([
      ...cliMcpServers
        .filter((item) => !item.enabled)
        .map((item) => mergeCodexCliMcpServer(item, configuredMcpServers, "disabled")),
      ...configuredMcpServers
        .filter((item) => !currentMcpNames.has(normalizedResourceId(item.name)))
        .map((item) => ({
          ...item,
          availability: item.enabled ? "config_only" : "disabled",
        })),
      ...pluginMcpServers.map((item) => ({
        ...item,
        availability: item.enabled === false ? "disabled" : "plugin_runtime",
      })),
    ], (item) => item.name).map(addMcpResourceManagement),
    plugins: uniqueResourceItems([
      ...pluginPageAvailablePlugins,
      ...internalCurrentPlugins,
      ...configuredDiagnosticPlugins,
      ...disabledPlugins,
      ...cliDisabledPlugins,
      ...configOnlyEnabledPlugins,
      ...marketplaceAvailablePlugins,
      ...cachedOnlyPlugins,
    ], (item) => item.id).map(addPluginResourceManagement),
    skills: uniqueResourceItems(
      [
        ...listDisabledCodexSkillFiles(homeDir),
        ...fileVisibleSkills.map((item) => ({ ...item, availability: "codex-local" })),
        ...listAgentSkillFiles(homeDir).map((item) => ({ ...item, availability: "local" })),
        ...listPluginSkillFilesForPlugins(pluginPagePlugins, {
          pluginIds: activePluginIdSet,
          includePersonal: true,
          availability: "plugin",
        }),
        ...listPluginSkillFiles(homeDir, { excludePluginIds: activePluginIdSet, availability: "cached" }),
      ].filter((item) => !currentSkillKeys.has(currentSkillKeyFn(item))),
      skillResourceKey,
    ).map(addSkillResourceManagement),
    prompts: [],
    agentFiles: [],
    marketplaces: [],
  };
  const prompts = uniqueResourceItems([
    ...listCodexPromptFiles(homeDir),
    ...listProjectPromptFiles(rootDir),
  ], (item) => item.path);
  const agentFiles = listAgentInstructionFiles(rootDir, homeDir);
  const chatGptCliInstalledPlugins = uniqueResourceItems([
    ...(useCliPlugins
      ? cliPlugins
          .filter((plugin) => plugin.installed)
          .map((plugin) => mergeCodexCliPlugin(
            plugin,
            configuredPlugins,
            cachedPlugins,
            plugin.enabled === false ? "disabled" : "installed",
            pluginRuntime,
          ))
      : []),
    ...desktopRuntimeInstalledPlugins,
  ],
    (item) => item.id,
  );
  const desktopPluginPagePolicy = appServerSnapshot?.desktopPluginPagePolicy || null;
  const appServerPluginItems = appServerSnapshot?.plugins?.ok === true
    ? (Array.isArray(appServerSnapshot.plugins.items) ? appServerSnapshot.plugins.items : [])
    : null;
  const desktopVisiblePluginIds = appServerPluginItems === null
    ? null
    : new Set(
        appServerPluginItems
          .filter((plugin) => plugin?.installed !== false && plugin?.enabled !== false && plugin?.desktopPageVisible !== false)
          .map((plugin) => normalizedResourceId(plugin.id))
          .filter(Boolean),
      );
  const desktopPolicyHiddenPluginNames = new Set(
    desktopPluginPagePolicy?.ok === true
      ? (desktopPluginPagePolicy.hiddenPluginNames || []).map(normalizedResourceId).filter(Boolean)
      : [],
  );
  // The CLI installed list is the authoritative installed-plugin inventory.
  // Renderer selectors and app-server visibility are diagnostics only: they
  // must not silently subtract Browser (or a future plugin) from this count.
  const chatGptPluginPagePlugins = [...chatGptCliInstalledPlugins];
  const chatGptActivePluginIds = new Set(
    chatGptPluginPagePlugins
      .filter((plugin) => plugin.enabled !== false && plugin.availability !== "disabled")
      .map((plugin) => normalizedResourceId(plugin.id)),
  );
  const chatGptPluginPageMcpServers = listPluginMcpResources(
    chatGptPluginPagePlugins.filter((plugin) => chatGptActivePluginIds.has(normalizedResourceId(plugin.id))),
  ).map(addMcpResourceManagement);
  const manifestPluginApps = listPluginAppResources(
    chatGptCliInstalledPlugins.filter((plugin) => plugin.enabled !== false),
  );
  const discoveredPluginSkillFiles = listPluginSkillFilesForPlugins(chatGptCliInstalledPlugins, {
    pluginIds: new Set(chatGptCliInstalledPlugins.map((plugin) => normalizedResourceId(plugin.id))),
    includePersonal: true,
    availability: "plugin",
  }).map(addSkillResourceManagement);
  const chatGptPluginPageApps = appServerSnapshot?.apps?.ok === true
    ? normalizeCodexPluginPageApps(appServerSnapshot.apps.items, chatGptPluginPagePlugins)
    : [];
  const chatGptPluginPageSkillSnapshot = appServerSnapshot?.skills?.ok === true
    ? normalizeCodexPluginPageSkills(appServerSnapshot.skills.items, { homeDir })
    : { items: [], userSkills: [], recommendedExcluded: [] };
  const chatGptPluginPageSkills = chatGptPluginPageSkillSnapshot.items;
  const chatGptPluginPageReadStatus = {
    plugins: codexResourceReadStatus(cliSnapshot?.plugins, "codex-cli"),
    apps: appServerSnapshot?.apps?.ok === true
      ? codexResourceReadStatus(appServerSnapshot.apps, "codex-app-server")
      : codexResourceReadStatus(cliSnapshot?.plugins, "codex-plugin-app-manifest"),
    mcpServers: codexResourceReadStatus(cliSnapshot?.plugins, "codex-plugin-manifest"),
    skills: appServerSnapshot?.skills?.ok === true
      ? codexResourceReadStatus(appServerSnapshot.skills, "codex-app-server")
      : codexResourceReadStatus(cliSnapshot?.plugins, "codex-plugin-manifest"),
  };
  const chatGptPluginPageSummary = {
    plugins: chatGptPluginPagePlugins.length,
    apps: chatGptPluginPageApps.length,
    mcpServers: chatGptPluginPageMcpServers.length,
    skills: chatGptPluginPageSkills.length,
  };
  for (const kind of ["plugins", "apps", "mcpServers", "skills"]) {
    if (chatGptPluginPageReadStatus[kind]?.ok !== true) {
      chatGptPluginPageSummary[kind] = null;
    }
  }
  const chatGptPluginPageSnapshot = {
    state: appServerSnapshot?.stale === true
      ? "cached"
      : ["plugins", "apps", "skills"].some((kind) => appServerSnapshot?.[kind]?.ok === true)
        ? "authoritative"
        : "unavailable",
    source: appServerSnapshot?.snapshotSource || "unavailable",
    refreshedAt: appServerSnapshot?.authoritativeRefreshedAt || appServerSnapshot?.refreshedAt || null,
    attemptedAt: appServerSnapshot?.refreshedAt || null,
    cached: appServerSnapshot?.cached === true,
    stale: appServerSnapshot?.stale === true,
    appIds: chatGptPluginPageApps.map((item) => item.id),
  };
  const summary = resourceCountSummary({ mcpServers, plugins, skills, prompts, agentFiles, marketplaces });
  for (const kind of ["plugins", "mcpServers", "skills", "marketplaces"]) {
    if (readStatus[kind]?.ok !== true) {
      summary[kind] = null;
    }
  }
  return {
    version: 1,
    configPath,
    authority: resourceCountAuthority(),
    readStatus,
    summary,
    pluginPage: {
      snapshot: chatGptPluginPageSnapshot,
      authority: {
        plugins: resourceAuthorityEntry(
          "codex-cli",
          "ChatGPT 已安装插件",
          "统计 Codex CLI installed 列表中的全部已安装条目，包含当前停用项。",
        ),
        apps: resourceAuthorityEntry(
          "codex-app-server",
          "ChatGPT 插件应用",
          "统计 Codex app-server app/list 当前返回且与已安装插件关联的应用。",
        ),
        mcpServers: resourceAuthorityEntry(
          "codex-plugin-manifest",
          "ChatGPT 插件 MCP",
          "只统计当前已启用插件声明的 MCP，不混入全局运行时 MCP。",
        ),
        skills: resourceAuthorityEntry(
          "codex-app-server",
          "Codex 用户技能",
          "统计 Codex app-server skills/list 返回且位于当前用户 CODEX_HOME/skills 下的非系统技能。",
        ),
      },
      readStatus: chatGptPluginPageReadStatus,
      summary: chatGptPluginPageSummary,
      plugins: chatGptPluginPagePlugins.map(addPluginResourceManagement),
      apps: chatGptPluginPageApps,
      mcpServers: chatGptPluginPageMcpServers,
      skills: chatGptPluginPageSkills,
      diagnostics: {
        manifestAppDeclarations: manifestPluginApps.length,
        discoveredSkillFiles: discoveredPluginSkillFiles.length,
        cliInstalledPlugins: chatGptCliInstalledPlugins.length,
        userSkills: chatGptPluginPageSkillSnapshot.userSkills.length,
        recommendedSkillsClassified: chatGptPluginPageSkillSnapshot.recommendedExcluded.length,
        plugins: chatGptCliInstalledPlugins.map((plugin) => ({
          id: plugin.id,
          cliInstalled: true,
          configured: configuredPluginIds.has(normalizedResourceId(plugin.id)),
          enabled: plugin.enabled !== false,
          cached: cachedPlugins.some((cached) => normalizedResourceId(cached.id) === normalizedResourceId(plugin.id)),
          desktopPageVisible: desktopVisiblePluginIds !== null
            ? desktopVisiblePluginIds.has(normalizedResourceId(plugin.id))
            : !desktopPolicyHiddenPluginNames.has(
                normalizedResourceId(plugin.name || String(plugin.id || "").split("@")[0]),
              ),
        })),
        desktopPluginPagePolicy,
      },
    },
    discoveredSummary: resourceCountSummary(discovered),
    breakdown: resourceBreakdown({ mcpServers, plugins, skills, prompts, agentFiles, marketplaces, discovered }),
    mcpServers,
    plugins,
    skills,
    prompts,
    agentFiles,
    marketplaces,
    discovered,
  };
}

export function readCodexResourceSnapshots(options = {}) {
  const codexCliSnapshot = readCodexCliResourceSnapshot(options);
  const locatedCli = codexCliSnapshot?.executable
    ? {
        found: true,
        cliTarget: codexCliSnapshot.executable,
        source: "shared-resource-snapshot",
        kind: "executable",
      }
    : {
        found: false,
        cliTarget: "",
        locatorErrorCode: codexCliSnapshot?.plugins?.code || "cli_not_found",
        locatorError: codexCliSnapshot?.plugins?.error || "未找到可执行的 Codex CLI。",
      };
  const codexPromptInputSnapshot = readCodexPromptInputSnapshot({
    ...options,
    locatedCli,
  });
  const codexAppServerSnapshot = readCodexAppServerResourceSnapshot({
    ...options,
    rootDir: options.rootDir || process.cwd(),
    locatedCli,
  });
  return {
    executable: codexCliSnapshot?.executable || codexPromptInputSnapshot?.executable || codexAppServerSnapshot?.executable || "",
    codexCliSnapshot,
    codexPromptInputSnapshot,
    codexAppServerSnapshot,
  };
}

export function readCodexAppServerResourceSnapshot({
  rootDir = process.cwd(),
  homeDir = os.homedir(),
  timeoutMs = 20000,
  cacheMs = CODEX_APP_SERVER_RESOURCE_SNAPSHOT_CACHE_MS,
  locatedCli = undefined,
  forceRefresh = false,
  locateCli = locateCodexCliSync,
  execFile = execFileSync,
  env = {},
  desktopOptions = {},
  now = Date.now,
} = {}) {
  const desktopPluginPagePolicy = readCodexDesktopPluginPagePolicy({ homeDir, desktopOptions });
  let located = locatedCli;
  if (located === undefined) {
    try {
      located = locateCli({ homeDir, env: { ...process.env, ...env }, desktopOptions });
    } catch (error) {
      return { executable: "", ok: false, plugins: { ok: false, items: [] }, apps: { ok: false, items: [] }, skills: { ok: false, items: [] }, desktopPluginPagePolicy, code: "locator_failed", error: boundedCodexReadReason(error?.message) };
    }
  }
  const executable = typeof located === "string"
    ? located.trim()
    : String(located?.cliTarget || "").trim();
  if (!executable) {
    return { executable: "", ok: false, plugins: { ok: false, items: [] }, apps: { ok: false, items: [] }, skills: { ok: false, items: [] }, desktopPluginPagePolicy, code: "cli_not_found", error: "Codex CLI is missing." };
  }
  const cacheKey = codexSnapshotRequestKey("app-server-resources", {
    rootDir: path.resolve(rootDir),
    homeDir,
    executable,
    desktopOptions,
    env,
  });
  const timestamp = codexSnapshotNow(now);
  if (
    !forceRefresh &&
    cacheMs > 0 &&
    codexAppServerResourceSnapshotCache?.key === cacheKey &&
    timestamp - codexAppServerResourceSnapshotCache.at < cacheMs
  ) {
    return codexAppServerResourceSnapshotCache.value;
  }
  const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), "codex-app-server-probe.mjs");
  try {
    const output = execFile(
      process.execPath,
      [worker, JSON.stringify({ executable, homeDir, cwd: rootDir, timeoutMs: Math.max(1000, timeoutMs - 2000) })],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    const parsed = JSON.parse(String(output || "{}"));
    const freshValue = {
      executable,
      refreshedAt: parsed.refreshedAt || new Date(timestamp).toISOString(),
      snapshotSource: "codex-app-server",
      ...parsed,
      desktopPluginPagePolicy,
    };
    const previous = codexAppServerResourceSnapshotCache?.key === cacheKey
      ? codexAppServerResourceSnapshotCache.value
      : null;
    const value = retainAuthoritativeAppServerKinds(freshValue, previous);
    if (["plugins", "apps", "skills"].some((kind) => freshValue?.[kind]?.ok === true)) {
      codexAppServerResourceSnapshotCache = { key: cacheKey, at: timestamp, value };
    }
    return value;
  } catch (error) {
    const failure = {
      executable,
      ok: false,
      plugins: { ok: false, items: [], code: "probe_failed", error: boundedCodexReadReason(error?.message) },
      apps: { ok: false, items: [], code: "probe_failed", error: boundedCodexReadReason(error?.message) },
      skills: { ok: false, items: [], code: "probe_failed", error: boundedCodexReadReason(error?.message) },
      desktopPluginPagePolicy,
      refreshedAt: new Date(timestamp).toISOString(),
      snapshotSource: "codex-app-server",
      code: "probe_failed",
      error: boundedCodexReadReason(error?.message),
    };
    const previous = codexAppServerResourceSnapshotCache?.key === cacheKey
      ? codexAppServerResourceSnapshotCache.value
      : null;
    return retainAuthoritativeAppServerKinds(failure, previous);
  }
}

function retainAuthoritativeAppServerKinds(fresh, previous) {
  if (!previous) return fresh;
  let retained = false;
  const merged = { ...fresh };
  for (const kind of ["plugins", "apps", "skills"]) {
    const freshItems = Array.isArray(fresh?.[kind]?.items) ? fresh[kind].items : [];
    const previousItems = Array.isArray(previous?.[kind]?.items) ? previous[kind].items : [];
    const transientEmptyApps = kind === "apps" && fresh?.[kind]?.ok === true && freshItems.length === 0 && previousItems.length > 0;
    if ((fresh?.[kind]?.ok === true && !transientEmptyApps) || previous?.[kind]?.ok !== true) continue;
    retained = true;
    merged[kind] = {
      ...previous[kind],
      cached: true,
      stale: true,
      refreshError: {
        code: transientEmptyApps ? "empty_not_ready" : String(fresh?.[kind]?.code || fresh?.code || "unavailable"),
        error: transientEmptyApps
          ? "Codex app-server returned an empty app list before the previous authoritative app became available."
          : String(fresh?.[kind]?.error || fresh?.error || "Codex app-server is unavailable."),
      },
    };
  }
  return retained
    ? {
        ...merged,
        ok: true,
        cached: true,
        stale: true,
        snapshotSource: "last_authoritative_cache",
        authoritativeRefreshedAt: previous.authoritativeRefreshedAt || previous.refreshedAt || null,
      }
    : merged;
}

export function readCodexCliResourceSnapshot({
  homeDir = os.homedir(),
  timeoutMs = 8000,
  cacheMs = CODEX_CLI_RESOURCE_SNAPSHOT_CACHE_MS,
  codexCliArgsPrefix = [],
  env = {},
  desktopOptions = {},
  locatedCli = undefined,
  forceRefresh = false,
  locateCli = locateCodexCliSync,
  execFile = execFileSync,
  now = Date.now,
} = {}) {
  const codexHome = path.join(homeDir, ".codex");
  if (!fs.existsSync(codexHome)) {
    return codexCliUnavailableResourceSnapshot("", "codex_home_missing", `CODEX_HOME 不存在：${codexHome}`);
  }
  const prefix = Array.isArray(codexCliArgsPrefix)
    ? codexCliArgsPrefix.map((arg) => String(arg))
    : [];
  const explicitCliPath = codexCliConfiguredPathForSnapshot(homeDir);
  const cacheKey = codexSnapshotRequestKey("resources", {
    homeDir,
    explicitCliPath,
    prefix,
    desktopOptions,
    env,
  });
  const timestamp = codexSnapshotNow(now);
  if (
    !forceRefresh &&
    cacheMs > 0 &&
    codexCliResourceSnapshotCache?.key === cacheKey &&
    timestamp - codexCliResourceSnapshotCache.at < cacheMs
  ) {
    return codexCliResourceSnapshotCache.value;
  }
  let located = locatedCli;
  if (located === undefined) {
    try {
      located = typeof locateCli === "function"
        ? locateCli({
            homeDir,
            env: { ...process.env, ...env },
            desktopOptions,
            codexCliPath: explicitCliPath,
            explicitCliTargets: explicitCliPath ? [explicitCliPath] : [],
          })
        : null;
    } catch (error) {
      return codexCliUnavailableResourceSnapshot(
        explicitCliPath,
        "locator_failed",
        boundedCodexReadReason(error?.message || String(error)),
      );
    }
  }
  if (located?.locatorError) {
    return codexCliUnavailableResourceSnapshot(
      explicitCliPath,
      String(located.locatorErrorCode || "locator_failed"),
      boundedCodexReadReason(located.locatorError),
    );
  }
  const executable = typeof located === "string"
    ? located.trim()
    : String(located?.cliTarget || "").trim();
  if (!executable) {
    return codexCliUnavailableResourceSnapshot("", "cli_not_found", "未找到可执行的 Codex CLI。");
  }
  const installedPluginListArgs = ["plugin", "list", "--json"];
  const availablePluginListArgs = ["plugin", "list", "--available", "--json"];
  const mcpListArgs = ["mcp", "list", "--json"];
  const installedPlugins = readCodexCliJsonList(executable, [...prefix, ...installedPluginListArgs], {
    homeDir,
    timeoutMs,
    env,
    commandArgs: installedPluginListArgs,
    execFile,
  });
  const availablePlugins = readCodexCliJsonList(executable, [...prefix, ...availablePluginListArgs], {
    homeDir,
    timeoutMs,
    env,
    commandArgs: availablePluginListArgs,
    execFile,
  });
  const snapshot = {
    executable,
    plugins: mergeCodexCliPluginListResults(installedPlugins, availablePlugins),
    mcpServers: readCodexCliJsonList(executable, [...prefix, ...mcpListArgs], {
      homeDir,
      timeoutMs,
      env,
      commandArgs: mcpListArgs,
      execFile,
    }),
  };
  if (
    snapshot.plugins?.installed?.ok === true &&
    snapshot.plugins?.available?.ok === true &&
    snapshot.mcpServers?.ok === true
  ) {
    codexCliResourceSnapshotCache = {
      key: cacheKey,
      at: timestamp,
      value: snapshot,
    };
  }
  return snapshot;
}

function codexCliUnavailableResourceSnapshot(executable = "", code = "unavailable", error = "") {
  const failure = {
    ok: false,
    items: [],
    code,
    error: boundedCodexReadReason(error || "无法读取 Codex CLI。"),
  };
  return {
    executable,
    plugins: {
      ...failure,
      installed: { ...failure },
      available: { ...failure },
    },
    mcpServers: { ...failure },
  };
}

function codexSnapshotNow(now = Date.now) {
  const value = typeof now === "function" ? now() : now;
  const number = Number(value);
  return Number.isFinite(number) ? number : Date.now();
}

function codexSnapshotRequestKey(kind = "", {
  homeDir = os.homedir(),
  explicitCliPath = "",
  prefix = [],
  desktopOptions = {},
  env = {},
} = {}) {
  const envCliPathKey = Object.keys(env || {}).find((key) => key.toLowerCase() === "codex_cli_path");
  return JSON.stringify([
    kind,
    path.resolve(homeDir),
    String(explicitCliPath || ""),
    Array.isArray(prefix) ? prefix.map(String) : [],
    String(desktopOptions?.codexCliPath || ""),
    String(desktopOptions?.codexDesktopLaunchTarget || ""),
    String(desktopOptions?.codexDesktopExe || ""),
    envCliPathKey ? String(env[envCliPathKey] || "") : "",
  ]);
}

function mergeCodexCliPluginListResults(installedResult = {}, availableResult = {}) {
  const installedOk = installedResult?.ok === true;
  const availableOk = availableResult?.ok === true;
  const errors = [installedResult?.error, availableResult?.error].filter(Boolean);
  return {
    ok: installedOk,
    code: installedOk ? "ok" : String(installedResult?.code || "unavailable"),
    items: mergeCodexCliPluginListItems(
      availableOk ? availableResult.items : [],
      installedOk ? installedResult.items : [],
    ),
    installed: installedResult,
    available: availableResult,
    partial: !installedOk || !availableOk,
    error: installedOk ? "" : boundedCodexReadReason(installedResult?.error || errors.join("; ")),
    errors,
  };
}

function mergeCodexCliPluginListItems(availableItems = [], installedItems = []) {
  const byKey = new Map();
  for (const item of Array.isArray(availableItems) ? availableItems : []) {
    const key = codexCliPluginListItemKey(item);
    if (!key) {
      continue;
    }
    byKey.set(key, {
      ...item,
      codexListKind: "available",
      installed: false,
      enabled: false,
    });
  }
  const installedKeys = [];
  for (const item of Array.isArray(installedItems) ? installedItems : []) {
    const key = codexCliPluginListItemKey(item);
    if (!key) {
      continue;
    }
    const existing = byKey.get(key) || {};
    installedKeys.push(key);
    byKey.set(key, {
      ...existing,
      ...item,
      codexListKind: "installed",
      installed: true,
      enabled: item?.enabled === true,
    });
  }
  const installedKeySet = new Set(installedKeys);
  return [
    ...installedKeys.map((key) => byKey.get(key)).filter(Boolean),
    ...Array.from(byKey.entries())
      .filter(([key]) => !installedKeySet.has(key))
      .map(([, item]) => item),
  ];
}

function codexCliPluginListItemKey(item = {}) {
  return normalizedResourceId(codexCliPluginId(item));
}

export function readCodexPromptInputSnapshot({
  homeDir = os.homedir(),
  timeoutMs = 12000,
  cacheMs = CODEX_PROMPT_INPUT_SNAPSHOT_CACHE_MS,
  env = {},
  desktopOptions = {},
  locatedCli = undefined,
  forceRefresh = false,
  locateCli = locateCodexCliSync,
  execFile = execFileSync,
  now = Date.now,
} = {}) {
  const codexHome = path.join(homeDir, ".codex");
  if (!fs.existsSync(codexHome)) {
    return {
      executable: "",
      ok: false,
      items: [],
      code: "codex_home_missing",
      error: `CODEX_HOME 不存在：${codexHome}`,
    };
  }
  const explicitCliPath = codexCliConfiguredPathForSnapshot(homeDir);
  const cacheKey = codexSnapshotRequestKey("prompt-input", {
    homeDir,
    explicitCliPath,
    desktopOptions,
    env,
  });
  const timestamp = codexSnapshotNow(now);
  if (
    !forceRefresh &&
    cacheMs > 0 &&
    codexPromptInputSnapshotCache?.key === cacheKey &&
    timestamp - codexPromptInputSnapshotCache.at < cacheMs
  ) {
    return codexPromptInputSnapshotCache.value;
  }
  let located = locatedCli;
  if (located === undefined) {
    try {
      located = typeof locateCli === "function"
        ? locateCli({
            homeDir,
            env: { ...process.env, ...env },
            desktopOptions,
            codexCliPath: explicitCliPath,
            explicitCliTargets: explicitCliPath ? [explicitCliPath] : [],
          })
        : null;
    } catch (error) {
      return {
        executable: explicitCliPath,
        ok: false,
        items: [],
        code: "locator_failed",
        error: boundedCodexReadReason(error?.message || String(error)),
      };
    }
  }
  if (located?.locatorError) {
    return {
      executable: explicitCliPath,
      ok: false,
      items: [],
      code: String(located.locatorErrorCode || "locator_failed"),
      error: boundedCodexReadReason(located.locatorError),
    };
  }
  const executable = typeof located === "string"
    ? located.trim()
    : String(located?.cliTarget || "").trim();
  if (!executable) {
    return {
      executable: "",
      ok: false,
      items: [],
      code: "cli_not_found",
      error: "未找到可执行的 Codex CLI。",
    };
  }
  const snapshot = readCodexCliPromptInput(executable, { homeDir, timeoutMs, env, execFile });
  if (snapshot.ok === true) {
    codexPromptInputSnapshotCache = {
      key: cacheKey,
      at: timestamp,
      value: snapshot,
    };
  }
  return snapshot;
}

function readCodexCliPromptInput(
  executable,
  { homeDir = os.homedir(), timeoutMs = 12000, env = {}, execFile = execFileSync } = {},
) {
  let output = "";
  let attempts = 0;
  while (attempts < 2) {
    attempts += 1;
    try {
      output = execFile(
        executable,
        ["debug", "prompt-input"],
        codexCliExecOptions({ homeDir, timeoutMs, env }),
      );
      break;
    } catch (error) {
      const failure = codexCliExecutionFailure(error, attempts);
      if (attempts >= 2 || !failure.transient) {
        return { executable, ...failure.result };
      }
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(String(output || "null"));
  } catch (error) {
    return {
      executable,
      ok: false,
      items: [],
      code: "invalid_json",
      error: boundedCodexReadReason(error?.message || String(error)),
      attempts,
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      executable,
      ok: false,
      items: [],
      code: "unsupported_schema",
      error: "Codex prompt-input 返回了不支持的 JSON schema。",
      attempts,
    };
  }
  const normalized = normalizeCodexPromptInputSkills(parsed, { homeDir });
  if (!normalized.ok) {
    return {
      executable,
      ok: false,
      items: parsed,
      code: "unsupported_schema",
      error: "Codex prompt-input 未返回可识别的 Available skills 清单。",
      attempts,
    };
  }
  return {
    executable,
    ok: true,
    items: parsed,
    code: "ok",
    attempts,
  };
}

function readCodexCliJsonList(
  executable,
  args,
  {
    homeDir = os.homedir(),
    timeoutMs = 8000,
    env = {},
    commandArgs = args,
    execFile = execFileSync,
    retryCount = 1,
  } = {},
) {
  let output = "";
  let attempts = 0;
  const maxAttempts = Math.max(1, Math.min(2, Number(retryCount) + 1 || 1));
  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      output = execFile(executable, args, codexCliExecOptions({ homeDir, timeoutMs, env }));
      break;
    } catch (error) {
      const failure = codexCliExecutionFailure(error, attempts);
      if (attempts >= maxAttempts || !failure.transient) {
        return failure.result;
      }
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(String(output || "null"));
  } catch (error) {
    return {
      ok: false,
      items: [],
      code: "invalid_json",
      error: boundedCodexReadReason(error?.message || String(error)),
      attempts,
    };
  }
  const extracted = codexCliJsonListItems(parsed, commandArgs);
  if (!extracted.ok) {
    return {
      ok: false,
      items: [],
      code: "unsupported_schema",
      error: `Codex CLI ${extracted.kind} 返回了不支持的 JSON schema。`,
      attempts,
    };
  }
  if (!extracted.items.every((item) => codexCliListItemSchemaValid(item, extracted.kind))) {
    return {
      ok: false,
      items: [],
      code: "unsupported_schema",
      error: `Codex CLI ${extracted.kind} 条目缺少必需字段。`,
      attempts,
    };
  }
  return {
    ok: true,
    items: codexCliListItemsWithProvenance(extracted.items, extracted.kind),
    code: "ok",
    kind: extracted.kind,
    attempts,
  };
}

function codexCliJsonListItems(parsed, args = []) {
  const kind = codexCliJsonListKind(args);
  if (Array.isArray(parsed)) {
    return { ok: true, items: parsed, kind };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, items: [], kind };
  }
  const keys = kind === "plugin-installed"
    ? ["installed", "plugins", "items"]
    : kind === "plugin-available"
      ? ["available", "plugins", "items"]
      : ["servers", "mcpServers", "items"];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) {
      return Array.isArray(parsed[key])
        ? { ok: true, items: parsed[key], kind }
        : { ok: false, items: [], kind };
    }
  }
  return { ok: false, items: [], kind };
}

function codexCliJsonListKind(args = []) {
  if (args[0] === "plugin" && args[1] === "list") {
    return args.includes("--available") ? "plugin-available" : "plugin-installed";
  }
  return "mcp-servers";
}

function codexCliListItemsWithProvenance(items = [], kind = "") {
  return (Array.isArray(items) ? items : []).map((item) => {
    if (!item || typeof item !== "object") {
      return item;
    }
    if (kind === "plugin-installed") {
      return { ...item, codexListKind: "installed", installed: true };
    }
    if (kind === "plugin-available") {
      return { ...item, codexListKind: "available", installed: false, enabled: false };
    }
    return { ...item, codexListKind: "mcp" };
  });
}

function codexCliListItemSchemaValid(item, kind = "") {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return false;
  }
  if (kind === "plugin-installed") {
    return Boolean(codexCliPluginId(item)) && typeof item.enabled === "boolean";
  }
  if (kind === "plugin-available") {
    return Boolean(codexCliPluginId(item));
  }
  return Boolean(String(item.name || "").trim()) && typeof item.enabled === "boolean";
}

function codexCliExecutionFailure(error, attempts = 1) {
  const rawCode = String(error?.code || "").toUpperCase();
  const message = boundedCodexReadReason(error?.message || String(error));
  const timeout = rawCode === "ETIMEDOUT" || /timed?\s*out|timeout/i.test(message);
  const startFailure = ["ENOENT", "EACCES", "EPERM", "UNKNOWN"].includes(rawCode) ||
    /^spawn\b/i.test(message);
  const code = timeout ? "timeout" : startFailure ? "start_failed" : "command_failed";
  return {
    transient: timeout || startFailure,
    result: {
      ok: false,
      items: [],
      code,
      error: message,
      attempts,
    },
  };
}

function runCodexCliJsonCommand(executable, args, { homeDir = os.homedir(), timeoutMs = 30000, env = {} } = {}) {
  try {
    const output = execFileSync(executable, args, codexCliExecOptions({ homeDir, timeoutMs, env }));
    try {
      return output ? JSON.parse(output) : null;
    } catch {
      return { rawOutput: output };
    }
  } catch (error) {
    const stderr = String(error?.stderr || "").trim();
    const stdout = String(error?.stdout || "").trim();
    const detail = stderr || stdout || error?.message || String(error);
    throw new Error(`Codex CLI 执行失败：${detail}`);
  }
}

function codexCliExecOptions({ homeDir = os.homedir(), timeoutMs = 2500, env = {} } = {}) {
  return {
    cwd: homeDir,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    env: {
      ...process.env,
      ...env,
      CODEX_HOME: path.join(homeDir, ".codex"),
    },
    maxBuffer: 8 * 1024 * 1024,
  };
}

function codexCliConfiguredPathForSnapshot(homeDir) {
  const configPath = codexConfigPath(homeDir);
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf8");
      const configured = readTomlStringInTable(content, "mcp_servers.node_repl.env", "CODEX_CLI_PATH");
      return String(configured || "").trim();
    }
  } catch {
    // The locator can still use its remaining candidates.
  }
  return "";
}

function codexCliExecutableForSnapshot(homeDir) {
  const explicitCliPath = codexCliConfiguredPathForSnapshot(homeDir);
  try {
    const located = locateCodexCliSync({
      homeDir,
      codexCliPath: explicitCliPath,
      explicitCliTargets: explicitCliPath ? [explicitCliPath] : [],
    });
    return String(located?.cliTarget || "").trim();
  } catch {
    return "";
  }
}

function normalizeCodexCliPlugins(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const id = codexCliPluginId(item);
      if (!id) {
        return null;
      }
      const source = item?.source || {};
      const sourcePath = String(source.path || item?.path || "").trim();
      const manifest = sourcePath ? readPluginManifest(sourcePath) : null;
      const metadata = pluginManifestMetadata(manifest);
      const displayName = item?.displayName || item?.name || item?.title || id.split("@")[0] || id;
      return {
        id,
        name: pluginDisplayName(manifest, displayName).trim(),
        description: pluginDescription(manifest, item?.description || item?.summary || ""),
        purpose: pluginPurpose(manifest, item?.description || item?.summary || ""),
        version: String(item?.version || pluginCacheVersion(sourcePath, manifest) || "").trim(),
        installed: item?.codexListKind === "installed" || item?.installed === true,
        enabled: item?.codexListKind !== "available" && item?.enabled === true,
        source: "codex-cli",
        pluginSource: codexCliPluginSource(item, id, sourcePath),
        path: sourcePath,
        pluginSourceKind: String(source.source || "").trim(),
        pluginSourceUrl: String(source.url || "").trim(),
        marketplaceSourceKind: String(item?.marketplaceSource?.sourceType || "").trim(),
        marketplaceSourceUrl: String(item?.marketplaceSource?.source || "").trim(),
        installPolicy: String(item?.installPolicy || "").trim(),
        authPolicy: String(item?.authPolicy || "").trim(),
        ...metadata,
      };
    })
    .filter(Boolean);
}

function codexCliPluginId(item = {}) {
  const explicit = String(item?.pluginId || item?.id || item?.slug || "").trim();
  if (explicit) {
    return explicit;
  }
  return pluginNameSlug(item?.name || item?.displayName || item?.title || "");
}

function normalizeCodexCliMcpServers(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const name = String(item?.name || "").trim();
      if (!name) {
        return null;
      }
      const transport = item?.transport || {};
      const command = String(transport.command || item?.command || "").trim();
      const args = Array.isArray(transport.args) ? transport.args.map((arg) => String(arg)) : [];
      return {
        name,
        command,
        args,
        description: command ? `Codex CLI 报告的 MCP：${path.basename(command)}` : "Codex CLI 报告的 MCP。",
        enabled: item?.enabled === true,
        disabledReason: String(item?.disabled_reason || item?.disabledReason || "").trim(),
        source: "codex-cli",
        availability: item?.enabled === true ? "enabled" : "disabled",
        configured: false,
        transport,
      };
    })
    .filter(Boolean);
}

function normalizeCodexPromptInputSkills(items = [], { homeDir = os.homedir() } = {}) {
  const texts = promptInputTextBlocks(items);
  const roots = new Map();
  for (const text of texts) {
    for (const line of text.split(/\r?\n/)) {
      const match = /^-\s+`([^`]+)`\s*=\s*`([^`]+)`\s*$/.exec(line.trim());
      if (match) {
        roots.set(match[1], match[2]);
      }
    }
  }
  const output = [];
  let sawAvailableSkills = false;
  let sawSkillEntry = false;
  for (const text of texts) {
    const lines = text.split(/\r?\n/);
    let inSkills = false;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (/^###\s+Available skills\b/i.test(line)) {
        sawAvailableSkills = true;
        inSkills = true;
        continue;
      }
      if (inSkills && /^###\s+/.test(line)) {
        inSkills = false;
      }
      if (!inSkills) {
        continue;
      }
      if (/^-\s+/.test(line)) {
        sawSkillEntry = true;
      }
      const match = /^-\s+([^\s]+):\s*(.*?)\s*\(file:\s*([^)]+)\)\s*$/.exec(line);
      if (!match) {
        continue;
      }
      const name = normalizeSkillName(match[1]);
      const filePath = resolvePromptSkillPath(match[3], roots);
      const sourceInfo = promptSkillSourceInfo(filePath, homeDir);
      const metadata = filePath ? skillMetadata(filePath, sourceInfo.folderName || name) : {};
      output.push({
        name,
        folderName: sourceInfo.folderName || metadata.folderName || path.basename(path.dirname(filePath || name)),
        path: filePath,
        description: normalizeSkillDescription(match[2]) || metadata.description,
        source: sourceInfo.source,
        pluginId: sourceInfo.pluginId,
        ...(sourceInfo.pluginSource ? { pluginSource: sourceInfo.pluginSource } : {}),
        availability: "prompt",
        enabled: true,
        promptVisible: true,
      });
    }
  }
  return {
    ok: sawAvailableSkills && (!sawSkillEntry || output.length > 0),
    items: uniqueResourceItems(output.filter((item) => item.name), skillResourceKey),
  };
}

function promptInputTextBlocks(items = []) {
  const output = [];
  const visit = (value) => {
    if (!value) {
      return;
    }
    if (typeof value === "string") {
      output.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (typeof value === "object") {
      if (value.type === "input_text" && typeof value.text === "string") {
        output.push(value.text);
        return;
      }
      if (Array.isArray(value.content)) {
        visit(value.content);
      }
    }
  };
  visit(items);
  return output;
}

function resolvePromptSkillPath(fileRef = "", roots = new Map()) {
  const ref = String(fileRef || "").trim().replace(/^`|`$/g, "");
  if (!ref) {
    return "";
  }
  const rootMatch = /^([^/\\]+)[/\\](.+)$/.exec(ref);
  if (rootMatch && roots.has(rootMatch[1])) {
    return path.normalize(path.join(pathFromPromptValue(roots.get(rootMatch[1])), rootMatch[2]));
  }
  return path.normalize(pathFromPromptValue(ref));
}

function pathFromPromptValue(value = "") {
  return String(value || "").replace(/\//g, path.sep);
}

function promptSkillSourceInfo(skillPath = "", homeDir = os.homedir()) {
  const folderName = skillPath ? path.basename(path.dirname(skillPath)) : "";
  const codexSkillRoot = path.join(homeDir, ".codex", "skills");
  const agentSkillRoot = path.join(homeDir, ".agents", "skills");
  const pluginCacheRoot = path.join(homeDir, ".codex", "plugins", "cache");
  if (isPathInside(skillPath, pluginCacheRoot)) {
    const parts = path.relative(pluginCacheRoot, skillPath).split(path.sep).filter(Boolean);
    const pluginSource = parts[0] || "";
    const pluginName = parts[1] || "";
    return {
      source: "plugin",
      pluginSource,
      pluginId: pluginName && pluginSource ? `${pluginName}@${pluginSource}` : "",
      folderName,
    };
  }
  if (isPathInside(skillPath, agentSkillRoot)) {
    return { source: "agents", pluginId: "", folderName };
  }
  if (isPathInside(skillPath, codexSkillRoot)) {
    return { source: "codex", pluginId: "", folderName };
  }
  return { source: "codex-prompt", pluginId: "", folderName };
}

function desktopRuntimeInstalledPluginResources(cachedPlugins = [], promptSkills = []) {
  const promptPathsByPluginId = new Map();
  for (const skill of Array.isArray(promptSkills) ? promptSkills : []) {
    const id = normalizedResourceId(skill?.pluginId);
    if (!id) {
      continue;
    }
    const paths = promptPathsByPluginId.get(id) || [];
    if (skill?.path) {
      paths.push(path.resolve(String(skill.path)));
    }
    promptPathsByPluginId.set(id, paths);
  }
  const candidatesById = new Map();
  for (const plugin of Array.isArray(cachedPlugins) ? cachedPlugins : []) {
    const id = normalizedResourceId(plugin?.id);
    if (
      !id ||
      plugin?.pluginSource !== "openai-curated-remote" ||
      plugin?.runtimeManifestValid !== true
    ) {
      continue;
    }
    const candidates = candidatesById.get(id) || [];
    candidates.push(plugin);
    candidatesById.set(id, candidates);
  }
  const output = [];
  for (const [id, candidates] of candidatesById.entries()) {
    const promptPaths = promptPathsByPluginId.get(id) || [];
    const pathMatched = candidates.filter((candidate) =>
      promptPaths.some((skillPath) => isPathInside(skillPath, candidate.path)),
    );
    const preferred = [...(pathMatched.length ? pathMatched : candidates)].sort((left, right) =>
      compareVersionStrings(String(right.version || ""), String(left.version || "")),
    )[0];
    if (!preferred) {
      continue;
    }
    output.push({
      ...preferred,
      id: preferred.id,
      source: "desktop-runtime",
      availability: "remote_installed",
      installed: true,
      enabled: true,
      cliInstalled: false,
      runtimeLoaded: pathMatched.length > 0,
      runtimeEvidence: {
        manifest: preferred.runtimeManifestPath,
        promptVisibleSkillCount: promptPaths.length,
      },
    });
  }
  return output.sort((left, right) => left.id.localeCompare(right.id));
}

function isUserManagedPromptSkill(item = {}) {
  if (item.source !== "codex") {
    return false;
  }
  const skillPath = String(item.path || "");
  if (!skillPath) {
    return false;
  }
  return !skillPath.split(/[\\/]+/).includes(".system");
}

function isPathInside(targetPath = "", parentPath = "") {
  if (!targetPath || !parentPath) {
    return false;
  }
  const relative = path.relative(path.resolve(parentPath), path.resolve(targetPath));
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function mergeCodexCliMcpServer(item = {}, configuredMcpServers = [], availability = "") {
  const configured = configuredMcpServers.find((candidate) =>
    normalizedResourceId(candidate.name) === normalizedResourceId(item.name),
  ) || {};
  const command = item.command || configured.command || "";
  const configuredTable = String(configured.tableName || "");
  return {
    ...configured,
    ...item,
    command,
    tableName: configuredTable,
    source: configuredTable ? "config" : "codex-cli",
    configured: Boolean(configuredTable),
    availability: availability || item.availability || (item.enabled === false ? "disabled" : "enabled"),
    description: command ? `Codex CLI 报告的 MCP：${path.basename(command)}` : (item.description || configured.description || "Codex CLI 报告的 MCP。"),
  };
}

function mergeCodexCliPlugin(item = {}, configuredPlugins = [], cachedPlugins = [], availability = "", pluginRuntime = {}) {
  const configured = configuredPlugins.find((candidate) => sameResourceId(candidate.id, item.id)) || {};
  const cached = cachedPlugins.find((candidate) => sameResourceId(candidate.id, item.id)) || {};
  const runtime = cached.runtime || pluginRuntimeForResourceId(pluginRuntime, item.id || configured.id || cached.id);
  return {
    ...cached,
    ...configured,
    ...item,
    id: item.id || configured.id || cached.id || "",
    name: item.name || cached.name || configured.name || item.id || "",
    description: cached.description || configured.description || item.description || "",
    version: item.version || cached.version || configured.version || "",
    path: item.path || cached.path || configured.path || "",
    pluginSource: item.pluginSource || cached.pluginSource || pluginSourceFromId(item.id || configured.id),
    source: "codex-cli",
    availability,
    tableName: configured.tableName || "",
    enabled: item.enabled === true,
    installed: item.installed === true,
    ...(hasPluginRuntime(runtime) ? { runtime } : {}),
  };
}

function listPluginMcpResources(plugins = []) {
  return uniqueResourceItems(
    (Array.isArray(plugins) ? plugins : [])
      .filter((plugin) => pluginHasMcpServers(plugin))
      .map((plugin) => {
        const pluginId = String(plugin.id || "").trim();
        const pluginName = String(plugin.name || pluginId).trim();
        return {
          name: pluginName || pluginId,
          id: pluginId,
          pluginId,
          pluginSource: plugin.pluginSource || pluginSourceFromId(pluginId),
          path: plugin.path || "",
          source: "plugin",
          availability: plugin.enabled === false ? "disabled" : "plugin",
          enabled: plugin.enabled !== false,
          configured: false,
          description: plugin.description || `插件 ${pluginName || pluginId} 提供的 MCP 服务。`,
          purpose: plugin.purpose || plugin.description || `插件 ${pluginName || pluginId} 提供的 MCP 服务。`,
        };
      }),
    (item) => item.pluginId || item.name,
  ).sort((left, right) => String(left.name || "").localeCompare(String(right.name || "")));
}

function listPluginAppResources(plugins = []) {
  const apps = [];
  for (const plugin of Array.isArray(plugins) ? plugins : []) {
    const pluginPath = String(plugin?.path || "").trim();
    if (!pluginPath || plugin.installed === false || plugin.enabled === false) {
      continue;
    }
    const appManifestPath = path.join(pluginPath, ".app.json");
    let manifest;
    try {
      if (!fs.existsSync(appManifestPath)) {
        continue;
      }
      manifest = JSON.parse(fs.readFileSync(appManifestPath, "utf8"));
    } catch {
      continue;
    }
    const entries = Array.isArray(manifest?.apps)
      ? manifest.apps.map((app, index) => [String(app?.id || app?.name || index), app])
      : manifest?.apps && typeof manifest.apps === "object"
        ? Object.entries(manifest.apps)
        : [];
    for (const [appId, appValue] of entries) {
      const app = appValue && typeof appValue === "object" ? appValue : {};
      const pluginId = String(plugin.id || "").trim();
      apps.push({
        id: `${pluginId}:${appId}`,
        name: String(app.name || app.displayName || app.title || appId),
        pluginId,
        pluginSource: plugin.pluginSource || pluginSourceFromId(pluginId),
        path: appManifestPath,
        source: "plugin-app",
        availability: "plugin",
        enabled: true,
        description: String(app.description || `插件 ${plugin.name || pluginId} 提供的应用。`),
        purpose: String(app.description || `插件 ${plugin.name || pluginId} 提供的应用。`),
      });
    }
  }
  return uniqueResourceItems(apps, (item) => item.id)
    .sort((left, right) => String(left.name || "").localeCompare(String(right.name || "")));
}

function normalizeCodexPluginPageApps(items = [], plugins = []) {
  const pluginNames = new Set(
    plugins.flatMap((plugin) => [plugin.name, plugin.displayName, String(plugin.id || "").split("@")[0]])
      .map(normalizedResourceId)
      .filter(Boolean),
  );
  return uniqueResourceItems(
    (Array.isArray(items) ? items : [])
      .filter((item) => Array.isArray(item?.pluginDisplayNames))
      .filter((item) => item.pluginDisplayNames.some((name) => pluginNames.has(normalizedResourceId(name))))
      .map((item) => ({
        id: String(item.id || item.name || ""),
        name: String(item.name || item.id || ""),
        description: String(item.description || ""),
        enabled: item.isEnabled !== false,
        accessible: item.isAccessible !== false,
        pluginDisplayNames: item.pluginDisplayNames.map(String),
        source: "codex-app-server",
        availability: "plugin_page",
      }))
      .filter((item) => item.id && item.name),
    (item) => item.id,
  );
}

function normalizeCodexPluginPageSkills(items = [], { homeDir = os.homedir() } = {}) {
  const skillsRoot = path.resolve(homeDir, ".codex", "skills").toLowerCase();
  const systemSkillsRoot = path.join(skillsRoot, ".system").toLowerCase();
  const userSkills = uniqueResourceItems(
    (Array.isArray(items) ? items : [])
      .filter((skill) => skill?.enabled !== false)
      .filter((skill) => String(skill?.scope || "user").toLowerCase() !== "system")
      .filter((skill) => {
        const skillPath = String(skill?.path || "");
        if (!skillPath) return false;
        const resolvedSkillPath = path.resolve(skillPath).toLowerCase();
        return (
          resolvedSkillPath.startsWith(`${skillsRoot}${path.sep}`) &&
          resolvedSkillPath !== systemSkillsRoot &&
          !resolvedSkillPath.startsWith(`${systemSkillsRoot}${path.sep}`)
        );
      })
      .map((skill) => ({
        id: String(skill.name || skill.id || ""),
        name: String(skill.name || skill.id || ""),
        displayName: String(skill.interface?.displayName || skill.displayName || skill.name || skill.id || ""),
        description: String(skill.description || ""),
        path: String(skill.path || ""),
        source: "codex-user-skill",
        availability: "user",
        enabled: true,
        authorityEvidence: "codex-app-server:skills/list",
      }))
      .filter((skill) => skill.name),
    (skill) => normalizedResourceId(skill.name),
  );
  const recommendedSkillKeys = readCodexDesktopRecommendedSkillKeys(homeDir);
  const recommendedExcluded = userSkills.filter((skill) => recommendedSkillKeys.has(normalizedResourceId(skill.name)));
  const visibleSkills = userSkills
    .map((skill) => addSkillResourceManagement({
      ...skill,
      pluginId: null,
      source: "codex-user-skill",
      desktopPageVisible: true,
      authorityEvidence: "codex-app-server:skills/list + CODEX_HOME user-skill path",
      recommended: recommendedSkillKeys.has(normalizedResourceId(skill.name)),
    }));
  return { items: visibleSkills, userSkills, recommendedExcluded };
}

function readCodexDesktopRecommendedSkillKeys(homeDir) {
  const cachePath = path.join(homeDir, ".codex", "vendor_imports", "skills-curated-cache.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    return new Set(
      (Array.isArray(parsed?.skills) ? parsed.skills : [])
        .flatMap((skill) => [skill?.id, skill?.name])
        .map(normalizedResourceId)
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

function pluginHasMcpServers(plugin = {}) {
  if (!plugin.path) {
    return false;
  }
  const manifest = readPluginManifest(plugin.path);
  return Boolean(
    manifest?.mcpServers ||
      manifest?.mcp_servers ||
      manifest?.mcp ||
      manifest?.mcpServer ||
      manifest?.mcp_server,
  );
}

function resourceBreakdown(resources = {}) {
  const discovered = resources.discovered || {};
  return {
    current: {
      mcpServers: resourceSourceBreakdown(resources.mcpServers),
      plugins: resourceSourceBreakdown(resources.plugins),
      skills: resourceSourceBreakdown(resources.skills),
      prompts: resourceSourceBreakdown(resources.prompts),
      agentFiles: resourceSourceBreakdown(resources.agentFiles),
      marketplaces: resourceSourceBreakdown(resources.marketplaces),
    },
    discovered: {
      mcpServers: resourceAvailabilityBreakdown(discovered.mcpServers),
      plugins: resourceAvailabilityBreakdown(discovered.plugins),
      skills: resourceAvailabilityBreakdown(discovered.skills),
      prompts: resourceAvailabilityBreakdown(discovered.prompts),
      agentFiles: resourceAvailabilityBreakdown(discovered.agentFiles),
      marketplaces: resourceAvailabilityBreakdown(discovered.marketplaces),
    },
  };
}

function codexResourceReadStatus(result, source = "") {
  if (result?.ok === true) {
    return {
      ok: true,
      state: "ok",
      source,
      code: "ok",
      reason: "",
    };
  }
  const nestedError = result?.installed?.error || result?.available?.error || "";
  const errors = Array.isArray(result?.errors) ? result.errors.filter(Boolean).join("; ") : "";
  return {
    ok: false,
    state: "unavailable",
    source,
    code: String(result?.code || result?.installed?.code || "unavailable"),
    reason: boundedCodexReadReason(result?.reason || result?.error || nestedError || errors || "无法读取。"),
  };
}

function boundedCodexReadReason(value = "", maxLength = 320) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function resourceCountAuthority() {
  return {
    plugins: resourceAuthorityEntry(
      "codex-cli",
      "Codex 官方插件列表",
      "插件主数量只统计 Codex 官方列表的 installed 结果中已安装且已启用的条目；available、配置与缓存只用于诊断。",
    ),
    mcpServers: resourceAuthorityEntry(
      "codex-cli",
      "Codex 官方 MCP 列表",
      "MCP 主数量只统计 Codex CLI 实际返回的已启用服务；config.toml 与插件内部 MCP 仅用于诊断。",
    ),
    skills: resourceAuthorityEntry(
      "codex-prompt-input",
      "Codex 当前可见技能",
      "技能主数量来自 Codex prompt-input 的 Available skills 清单；本地与插件缓存文件仅用于诊断。",
    ),
    marketplaces: resourceAuthorityEntry(
      "config",
      "Codex 市场配置",
      "市场数量来自可解析的 config.toml marketplaces 配置。",
    ),
    prompts: resourceAuthorityEntry("filesystem", "提示词文件", "提示词数量来自 Codex 用户目录和当前项目里的提示词文件。"),
    agentFiles: resourceAuthorityEntry("filesystem", "规则文件", "规则文件数量来自当前项目和 Codex 用户目录里的 AGENTS.md。"),
  };
}

function resourceAuthorityEntry(source = "", label = "", detail = "") {
  return { source, label, detail };
}

function resourceSourceBreakdown(items = []) {
  return resourceBreakdownBy(items, (item) => resourceSourceBreakdownKey(item));
}

function resourceSourceBreakdownKey(item = {}) {
  if (item.pluginSource && (item.id || item.pluginId) && item.source !== "config") {
    return item.pluginSource;
  }
  return item.source || item.pluginSource || "unknown";
}

function resourceAvailabilityBreakdown(items = []) {
  return resourceBreakdownBy(items, (item) => item.availability || item.source || "unknown");
}

function resourceBreakdownBy(items = [], keyFn) {
  const output = {};
  for (const item of Array.isArray(items) ? items : []) {
    const rawKey = String(keyFn(item) || "").trim() || "unknown";
    output[rawKey] = (output[rawKey] || 0) + 1;
  }
  return output;
}

function mergeConfiguredPluginCache(plugin = {}, cachedPlugins = [], availability = "", pluginRuntime = {}) {
  const cached = cachedPlugins.find((item) => sameResourceId(item.id, plugin.id)) || {};
  const runtime = cached.runtime || pluginRuntimeForResourceId(pluginRuntime, plugin.id || cached.id);
  return {
    ...cached,
    ...plugin,
    id: plugin.id || cached.id || "",
    name: cached.name || plugin.name || plugin.id || "",
    description: cached.description || plugin.description || "",
    version: cached.version || plugin.version || "",
    path: cached.path || plugin.path || "",
    pluginSource: cached.pluginSource || pluginSourceFromId(plugin.id),
    source: plugin.source || cached.source || "config",
    availability,
    ...(hasPluginRuntime(runtime) ? { runtime } : {}),
  };
}

function addMcpResourceManagement(item = {}) {
  const nextEnabled = item.enabled === false || item.availability === "disabled";
  const toggleable = Boolean(item.tableName);
  return {
    ...item,
    source: item.source || "config",
    purpose: codexResourcePurpose(item, "mcp"),
    diagnostic: mcpResourceDiagnostic(item, { nextEnabled }),
    management: {
      toggleable,
      toggleKind: "mcp",
      id: item.name || "",
      nextEnabled,
      actionLabel: nextEnabled ? "启用" : "停用",
      updateable: false,
      note: mcpManagementNote(item, { nextEnabled, toggleable }),
    },
  };
}

function mcpManagementNote(item = {}, { nextEnabled = false, toggleable = false } = {}) {
  if (item.source === "plugin") {
    return "来自已安装插件的 MCP；是否可用以 Codex 插件页和当前会话为准。";
  }
  if (!toggleable && item.source === "codex-cli") {
    return item.enabled === false
      ? "Codex 官方列表显示它未启用；如果来自插件，请到 Codex 插件页处理。"
      : "来自 Codex 官方列表，可能由插件提供；CodexBridge 只读展示，不直接改开关。";
  }
  if (item.availability === "config_only") {
    return "只在 config.toml 里看到，Codex 官方列表没有确认；建议重启 Codex 或检查配置来源。";
  }
  return `${nextEnabled ? "未启用" : "当前可用"}；开关写入 Codex config.toml，重启 Codex 后最稳。`;
}

function addPluginResourceManagement(item = {}) {
  const nextEnabled = item.enabled === false || item.availability === "disabled";
  const toggleable = Boolean(item.tableName);
  const update = pluginUpdateInfo(item);
  const remove = pluginRemoveInfo(item);
  return {
    ...item,
    purpose: codexResourcePurpose(item, "plugin"),
    details: pluginResourceDetails(item),
    diagnostic: pluginResourceDiagnostic(item, { nextEnabled, toggleable }),
    management: {
      toggleable,
      toggleKind: "plugin",
      id: item.id || "",
      nextEnabled,
      actionLabel: nextEnabled ? "启用" : "停用",
      updateable: update.updateable,
      updateLabel: update.label,
      updateNote: update.note,
      updateAction: update.action || "",
      removeable: remove.removeable,
      removeLabel: remove.label,
      removeNote: remove.note,
      removeAction: remove.action || "",
      removeId: remove.id || "",
      note: pluginManagementNote(item, { nextEnabled, toggleable }),
    },
  };
}

function pluginManagementNote(item = {}, { nextEnabled = false, toggleable = false } = {}) {
  const stale = pluginRuntimeStale(item);
  const stalePrefix = stale
    ? "缓存过旧：请先更新 Codex Desktop，必要时重启 Codex 让插件缓存重新生成。"
    : "";
  const joinNote = (note) => [stalePrefix, note].filter(Boolean).join(" ");
  if (item.availability === "config_only") {
    return joinNote("只在 config.toml 里看到，Codex 官方列表没有确认已安装启用；建议重启 Codex 或回到插件页检查。");
  }
  if (item.availability === "external") {
    return joinNote("Codex CLI 或配置能看到这个插件，但它不属于 Codex 插件页主统计；CodexBridge 只放到诊断区展示。");
  }
  if (item.availability === "marketplace") {
    return joinNote("插件市场可见但尚未安装；可以通过 CodexBridge 调用 Codex CLI 安装，安装后重启 Codex 最稳。");
  }
  if (item.availability === "remote_installed") {
    return joinNote(item.runtimeLoaded
      ? "正式插件缓存和当前提示均已确认；更新和卸载请在 Codex 插件市场处理。"
      : "正式插件缓存和 manifest 已确认安装；当前探测任务未加载其技能，不影响安装数量。");
  }
  if (item.source === "codex-cli" && !toggleable) {
    return joinNote(item.enabled === false
      ? "Codex 官方列表显示它未启用；请到 Codex 插件页启用。"
      : "来自 Codex 官方列表；CodexBridge 只读展示，安装、卸载和更新仍以 Codex 插件页为准。");
  }
  if (item.availability === "cached") {
    return joinNote("只是本地缓存，不代表 Codex 当前可用；请先在 Codex 插件市场启用或更新。");
  }
  if (item.availability === "internal") {
    return joinNote("内置运行能力；开关写入 Codex config.toml，重启 Codex 后最稳。");
  }
  if (item.availability === "disabled") {
    return joinNote("未启用；开关写入 Codex config.toml，重启 Codex 后最稳。");
  }
  if (!toggleable) {
    return joinNote("当前 Codex 插件市场可见；更新和卸载请在 Codex 插件市场处理。");
  }
  return joinNote(`${nextEnabled ? "未启用" : "当前可用"}；开关写入 Codex config.toml，重启 Codex 后最稳。`);
}

function addSkillResourceManagement(item = {}) {
  const nextEnabled = item.enabled === false || item.availability === "disabled";
  const localCodexSkill = item.source === "codex" && !item.pluginId;
  const managementId = item.folderName || item.name || "";
  const update = skillUpdateInfo(item);
  return {
    ...item,
    purpose: codexResourcePurpose(item, "skill"),
    diagnostic: skillResourceDiagnostic(item, { nextEnabled, localCodexSkill }),
    management: {
      toggleable: localCodexSkill,
      toggleKind: "skill",
      id: update.id || managementId,
      nextEnabled,
      actionLabel: nextEnabled ? "启用" : "停用",
      updateable: update.updateable,
      ...(update.updateable || update.label || update.note || update.action
        ? {
            updateLabel: update.label,
            updateNote: update.note,
            updateAction: update.action || "",
          }
        : {}),
      note: skillManagementNote(item, { nextEnabled, localCodexSkill }),
    },
  };
}

function codexResourcePurpose(item = {}, kind = "") {
  const explicitPurpose = String(item.purpose || "").trim();
  if (explicitPurpose) {
    return explicitPurpose;
  }
  const description = String(item.description || "").trim();
  const name = String(item.name || item.id || "").trim();
  if (kind === "mcp") {
    return [
      description || `MCP 服务 ${name || "未命名"}，给 Codex 提供外部工具或本地能力。`,
      item.command ? "Codex 调用时会通过这里配置的命令启动服务。" : "",
    ].filter(Boolean).join(" ");
  }
  if (kind === "plugin") {
    return [
      description || `Codex 插件 ${name || "未命名"}，用于扩展 Codex 的工具、MCP 或技能能力。`,
      item.availability === "internal"
        ? "这是 Codex 内置运行能力，通常支撑浏览器、Chrome 或 Computer Use。"
        : "插件可用性以 Codex 插件页和当前会话提示为准。",
    ].filter(Boolean).join(" ");
  }
  if (kind === "skill") {
    return [
      description || `Codex 技能 ${name || "未命名"}，用于在匹配任务时给模型补充专门流程。`,
      item.pluginId ? "它来自插件，是否可用跟随插件开关。" : "它来自本地技能文件，重启 Codex 后最稳。",
    ].filter(Boolean).join(" ");
  }
  return description;
}

function pluginResourceDetails(item = {}) {
  return [
    resourceDetailRow("插件 ID", item.id),
    resourceDetailRow("市场", item.pluginSource || pluginSourceFromId(item.id)),
    resourceDetailRow("状态", pluginInstallStateLabel(item)),
    resourceDetailRow("版本", item.version),
    resourceDetailRow("分类", item.category),
    resourceDetailRow("能力", Array.isArray(item.capabilities) ? item.capabilities.join(", ") : item.capabilities),
    resourceDetailRow("来源", pluginOriginLabel(item)),
    resourceDetailRow("开发者", item.developerName),
  ].filter(Boolean);
}

function resourceDetailRow(label = "", value = "") {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }
  return { label, value: text };
}

function pluginInstallStateLabel(item = {}) {
  if (item.availability === "marketplace" || item.installed === false) {
    return "未安装 / 市场候选";
  }
  if (item.availability === "installed") {
    return item.enabled === false ? "已安装 / 未启用" : "已安装";
  }
  if (item.enabled === false || item.availability === "disabled") {
    return item.installed === false ? "未安装" : "已安装 / 未启用";
  }
  if (item.installed === true || item.source === "codex-cli") {
    return "已安装 / 已启用";
  }
  if (item.availability === "cached") {
    return "本地缓存";
  }
  return item.availability || "";
}

function pluginOriginLabel(item = {}) {
  const kind = String(item.pluginSourceKind || item.marketplaceSourceKind || "").trim().toLowerCase();
  if (kind === "git") {
    return "Git 仓库";
  }
  if (kind === "local" || item.path) {
    return "本地目录";
  }
  if (item.pluginSourceUrl || item.marketplaceSourceUrl) {
    return "远程来源";
  }
  if (item.source === "cache") {
    return "本地缓存";
  }
  return "";
}

function skillUpdateInfo(item = {}) {
  const pluginId = String(item.pluginId || "").trim();
  if (!pluginId) {
    return {
      updateable: false,
      id: "",
      label: "",
      note: "",
      action: "",
    };
  }
  const update = pluginUpdateInfo({
    id: pluginId,
    pluginSource: item.pluginSource || pluginSourceFromId(pluginId),
    availability: item.availability === "cached" ? "cached" : "plugin",
  });
  return {
    ...update,
    id: pluginId,
    label: update.label || "刷新/更新插件",
  };
}

function skillManagementNote(item = {}, { nextEnabled = false, localCodexSkill = false } = {}) {
  if (item.availability === "prompt") {
    return "来自 Codex 当前模型提示；这才计入当前可用技能。";
  }
  if (item.availability === "not_prompt") {
    return "本地文件存在，但当前模型提示没有加载；先以 Codex 设置页/当前会话实际可见为准。";
  }
  if (localCodexSkill) {
    return `${nextEnabled ? "本地技能已停用" : "本地技能文件"}；${nextEnabled ? "启用会恢复单个 SKILL.md" : "停用会把单个 SKILL.md 改名"}，重启 Codex 后最稳。`;
  }
  if (item.pluginId && item.availability === "plugin") {
    return "来自已启用插件，是否可用跟随插件开关。";
  }
  if (item.pluginId && item.availability === "cached") {
    return "插件未启用或只是缓存，Codex 当前不一定能调用这个技能。";
  }
  if (item.source === "agents") {
    return "Agents 本地技能目录；CodexBridge 只展示，不直接修改。";
  }
  return "只读展示资源；CodexBridge 当前不直接管理。";
}

function mcpResourceDiagnostic(item = {}, { nextEnabled = false } = {}) {
  if (item.source === "plugin" && item.availability === "plugin") {
    return resourceDiagnostic("pass", "插件提供", "这个 MCP 来自已安装插件，按 Codex 插件页口径计入。");
  }
  if (item.availability === "config_only") {
    return resourceDiagnostic("warn", "配置未确认", "这个 MCP 写在 Codex 配置里，但 Codex 官方列表没有确认当前可用。");
  }
  if (!item.tableName && item.source === "codex-cli") {
    return item.enabled === false
      ? resourceDiagnostic("warn", "Codex 已停用", item.disabledReason || "Codex 官方列表显示这个 MCP 当前未启用。")
      : resourceDiagnostic("pass", "Codex 已启用", "Codex 官方列表显示这个 MCP 当前可用；可能来自插件，CodexBridge 只读展示。");
  }
  if (!item.tableName) {
    return resourceDiagnostic("info", "只读发现", "没有对应的 Codex config.toml 表，只用于展示。");
  }
  if (nextEnabled) {
    return resourceDiagnostic("warn", "未启用", "这个 MCP 写在 Codex 配置里，但当前不会被 Codex 调用。");
  }
  const command = String(item.command || "").trim();
  if (!command) {
    return resourceDiagnostic("warn", "缺少命令", "这个 MCP 已启用，但没有读取到启动命令。");
  }
  return resourceDiagnostic("pass", "当前可用", "这个 MCP 已在 Codex 配置中启用。");
}

function pluginResourceDiagnostic(item = {}, { nextEnabled = false, toggleable = false } = {}) {
  const runtime = item.runtime || {};
  if (item.availability === "config_only") {
    return resourceDiagnostic("warn", "配置未确认", "这个插件写在 Codex 配置里，但 Codex 官方列表没有确认当前已安装启用。");
  }
  if (pluginRuntimeStale(item)) {
    const pluginName = openAiBundledPluginName(item.id || item.name || "");
    return resourceDiagnostic(
      "warn",
      "缓存过旧",
      `Codex 内置 ${pluginName} 是 ${runtime.bundled}，本机缓存还是 ${runtime.cached}；旧缓存可能导致 Computer Use、Chrome 或浏览器能力异常。`,
    );
  }
  if (item.availability === "cached") {
    return resourceDiagnostic("warn", "仅本地缓存", "本机缓存里有这个插件，但 Codex 当前配置没有启用它。");
  }
  if (item.availability === "marketplace") {
    return resourceDiagnostic("info", "可安装", "Codex 插件市场里有这个插件，但本机当前还没有安装启用。");
  }
  if (item.availability === "remote_installed") {
    return resourceDiagnostic(
      "pass",
      "已安装",
      item.runtimeLoaded
        ? "正式插件缓存、manifest 和当前提示均已确认。"
        : "正式插件缓存和 manifest 已确认；prompt 探测只表示当前任务是否已加载。",
    );
  }
  if (item.availability === "external") {
    return resourceDiagnostic("info", "扩展可见", "Codex CLI 或配置能看到这个插件，但它不属于 Codex 插件页主统计；是否能用以 Codex 当前会话实际提示为准。");
  }
  if (item.availability === "internal") {
    return resourceDiagnostic("pass", "内置运行能力", "这是 Codex 内置能力插件；通常服务于浏览器、Chrome 或 Computer Use 等底层能力。");
  }
  if (item.availability === "installed") {
    return resourceDiagnostic("pass", "已安装", "Codex 插件页显示这个插件已安装；是否进入当前会话，以 Codex 当前插件开关和重启状态为准。");
  }
  if (nextEnabled || item.availability === "disabled") {
    return resourceDiagnostic("warn", "未启用", "这个插件在 Codex 配置里存在，但当前处于停用状态。");
  }
  if (item.source === "codex-cli") {
    return resourceDiagnostic("pass", "Codex 已启用", "Codex 官方列表显示这个插件当前已安装并启用。");
  }
  if (toggleable) {
    return resourceDiagnostic("pass", "当前可用", "这个插件已在 Codex 配置中启用。");
  }
  return resourceDiagnostic("info", "市场可见", "CodexBridge 只能读取到这个插件，更新和安装状态以 Codex 插件市场为准。");
}

function skillResourceDiagnostic(item = {}, { nextEnabled = false, localCodexSkill = false } = {}) {
  if (item.availability === "prompt") {
    return resourceDiagnostic("pass", "Codex 当前可见", "这个技能来自 Codex prompt-input 快照，已经进入当前模型提示。");
  }
  if (item.availability === "not_prompt") {
    return resourceDiagnostic("info", "未进入当前提示", "本地文件存在，但没有出现在 Codex 当前模型提示里；不计入当前可用。");
  }
  if (localCodexSkill) {
    return nextEnabled
      ? resourceDiagnostic("warn", "已停用", "本地技能文件已被改名停用，启用后会恢复单个 SKILL.md。")
      : resourceDiagnostic("pass", "文件可读取", "这个技能位于 Codex 用户技能目录；如果 Codex 设置页另有开关，以 Codex 设置页为准。");
  }
  if (item.pluginId && item.availability === "plugin") {
    return resourceDiagnostic("pass", "跟随插件", "这个技能来自已启用插件，插件可用时技能才会进入 Codex。");
  }
  if (item.pluginId && item.availability === "cached") {
    return resourceDiagnostic("warn", "插件未启用", "这个技能只来自插件缓存，Codex 当前不一定能调用。");
  }
  if (item.source === "agents") {
    return resourceDiagnostic("info", "用户目录", "这是 Agents 技能目录里的技能，CodexBridge 只展示不改动。");
  }
  return resourceDiagnostic("info", "只读资源", "CodexBridge 只展示这个资源，不直接管理。");
}

function resourceDiagnostic(status = "info", label = "", detail = "") {
  return {
    status,
    label,
    detail,
  };
}

function annotatePluginRuntime(plugins = [], pluginRuntime = {}) {
  return plugins.map((plugin) => {
    const runtime = pluginRuntimeForResourceId(pluginRuntime, plugin.id);
    return hasPluginRuntime(runtime)
      ? { ...plugin, runtime }
      : plugin;
  });
}

function pluginRuntimeForResourceId(pluginRuntime = {}, resourceId = "") {
  const pluginName = openAiBundledPluginName(resourceId);
  return pluginRuntime[pluginName] || {};
}

function openAiBundledPluginName(resourceId = "") {
  return String(resourceId || "").split("@")[0] || String(resourceId || "");
}

function hasPluginRuntime(runtime = {}) {
  return Boolean(runtime && (runtime.cached || runtime.bundled || runtime.stale || runtime.enabled));
}

function pluginRuntimeStale(item = {}) {
  return Boolean(item.runtime?.stale && item.runtime?.cached && item.runtime?.bundled);
}

function pluginUpdateInfo(item = {}) {
  if (pluginRuntimeStale(item)) {
    return {
      updateable: true,
      action: "check_updates",
      label: "更新 Codex Desktop",
      note: "这个内置能力随 Codex Desktop 更新；更新后重启 Codex，让新版内置插件重新生成缓存。",
    };
  }
  if (item.availability === "internal" || isCodexInternalPlugin(item)) {
    return {
      updateable: false,
      label: "随 Codex Desktop 更新",
      note: "这是 Codex 内置能力，CodexBridge 只做诊断和开关，不直接替换插件文件。",
    };
  }
  if (isCodexMarketplacePlugin(item)) {
    return {
      updateable: true,
      action: "update_plugin",
      label: item.availability === "marketplace"
        ? "安装插件"
        : item.availability === "cached"
          ? "安装/更新插件"
          : "刷新/更新插件",
      note: "会先刷新这个 Codex 插件市场快照，再用 Codex CLI 重新安装该插件；执行前会再次确认。",
    };
  }
  if (item.availability === "cached" || item.source === "cache") {
    return {
      updateable: false,
      label: "去 Codex 插件市场更新",
      note: "本地缓存不代表当前启用状态；安装、更新和卸载以 Codex 插件市场为准。",
    };
  }
  if (item.pluginSource === "personal") {
    return {
      updateable: false,
      label: "本地插件",
      note: "个人插件通常来自本机目录或手动安装，更新前请确认来源版本。",
    };
  }
  return {
    updateable: false,
    label: "",
    note: "",
  };
}

function pluginRemoveInfo(item = {}) {
  if (!isCodexMarketplacePlugin(item)) {
    return {
      removeable: false,
      id: "",
      label: "",
      note: "",
      action: "",
    };
  }
  const id = String(item.id || "").trim();
  const installed = item.installed === true || Boolean(item.tableName);
  const canRemove = Boolean(id && installed && item.availability !== "marketplace");
  if (!canRemove) {
    return {
      removeable: false,
      id,
      label: "",
      note: "",
      action: "",
    };
  }
  return {
    removeable: true,
    id,
    label: "卸载插件",
    note: "通过 Codex CLI 从本地配置和缓存里移除这个插件；执行前会再次确认。",
    action: "remove_plugin",
  };
}

export function updateCodexPluginResource({
  homeDir = os.homedir(),
  id = "",
  executable = "",
  codexCliArgsPrefix = [],
  timeoutMs = 30000,
  env = {},
} = {}) {
  const resourceId = String(id || "").trim();
  const selector = codexPluginSelectorParts(resourceId);
  if (!selector.plugin || !selector.marketplace) {
    throw new Error("需要指定插件 ID，例如 github@openai-curated-remote。");
  }
  if (selector.marketplace === "openai-bundled") {
    throw new Error("Codex 内置插件随 Codex Desktop 更新，请使用 Codex Desktop 更新流程。");
  }
  if (selector.marketplace === "personal") {
    throw new Error("个人本地插件不能自动更新，请确认来源后手动更新。");
  }
  const cli = executable || codexCliExecutableForSnapshot(homeDir);
  const prefix = Array.isArray(codexCliArgsPrefix)
    ? codexCliArgsPrefix.map((arg) => String(arg))
    : [];
  let refresh = null;
  let refreshError = "";
  try {
    refresh = runCodexCliJsonCommand(
      cli,
      [...prefix, "plugin", "marketplace", "upgrade", selector.marketplace, "--json"],
      { homeDir, timeoutMs, env },
    );
  } catch (error) {
    refreshError = error?.message || String(error);
  }
  let install = null;
  try {
    install = runCodexCliJsonCommand(
      cli,
      [...prefix, "plugin", "add", resourceId, "--json"],
      { homeDir, timeoutMs, env },
    );
  } catch (error) {
    const installError = error?.message || String(error);
    throw new Error(refreshError
      ? `${installError}；插件市场刷新也失败：${refreshError}`
      : installError);
  }
  invalidateCodexResourceSnapshotCaches();
  return {
    ok: true,
    kind: "plugin",
    id: resourceId,
    plugin: selector.plugin,
    marketplace: selector.marketplace,
    refreshed: !refreshError,
    installed: true,
    message: refreshError
      ? `插件市场刷新未完成：${refreshError}；已继续重新安装插件 ${resourceId}。`
      : `已刷新插件市场 ${selector.marketplace}，并已重新安装插件 ${resourceId}。`,
    ...(refreshError ? { refreshError } : {}),
    refresh,
    install,
  };
}

export function removeCodexPluginResource({
  homeDir = os.homedir(),
  id = "",
  executable = "",
  codexCliArgsPrefix = [],
  timeoutMs = 30000,
  env = {},
} = {}) {
  const resourceId = String(id || "").trim();
  const selector = codexPluginSelectorParts(resourceId);
  if (!selector.plugin || !selector.marketplace) {
    throw new Error("需要指定插件 ID，例如 github@openai-curated-remote。");
  }
  if (selector.marketplace === "openai-bundled") {
    throw new Error("Codex 内置插件随 Codex Desktop 管理，不能从 CodexBridge 自动卸载。");
  }
  if (selector.marketplace === "personal") {
    throw new Error("个人本地插件不能自动卸载，请确认来源后手动处理。");
  }
  const cli = executable || codexCliExecutableForSnapshot(homeDir);
  const prefix = Array.isArray(codexCliArgsPrefix)
    ? codexCliArgsPrefix.map((arg) => String(arg))
    : [];
  const remove = runCodexCliJsonCommand(
    cli,
    [...prefix, "plugin", "remove", resourceId, "--json"],
    { homeDir, timeoutMs, env },
  );
  invalidateCodexResourceSnapshotCaches();
  return {
    ok: true,
    kind: "plugin",
    id: resourceId,
    plugin: selector.plugin,
    marketplace: selector.marketplace,
    removed: true,
    message: `已卸载插件 ${resourceId}。`,
    remove,
  };
}

export function refreshCodexPluginMarketplaces({
  homeDir = os.homedir(),
  marketplace = "",
  executable = "",
  codexCliArgsPrefix = [],
  timeoutMs = 30000,
  env = {},
} = {}) {
  const cli = executable || codexCliExecutableForSnapshot(homeDir);
  const prefix = Array.isArray(codexCliArgsPrefix)
    ? codexCliArgsPrefix.map((arg) => String(arg))
    : [];
  const marketplaceName = String(marketplace || "").trim();
  const args = [
    ...prefix,
    "plugin",
    "marketplace",
    "upgrade",
    ...(marketplaceName ? [marketplaceName] : []),
    "--json",
  ];
  const refresh = runCodexCliJsonCommand(cli, args, { homeDir, timeoutMs, env });
  invalidateCodexResourceSnapshotCaches();
  return {
    ok: true,
    kind: "plugin_marketplaces",
    marketplace: marketplaceName || "all",
    refreshed: true,
    message: marketplaceName
      ? `已刷新插件市场 ${marketplaceName}。`
      : "已刷新插件市场快照。",
    refresh,
  };
}

export function setCodexResourceEnabled({ homeDir = os.homedir(), kind = "", id = "", enabled = true } = {}) {
  const resourceKind = normalizeCodexResourceKind(kind);
  const resourceId = String(id || "").trim();
  if (!resourceKind || !resourceId) {
    throw new Error("需要指定要管理的资源类型和名称。");
  }
  if (resourceKind === "skill") {
    const result = setCodexLocalSkillEnabled({ homeDir, id: resourceId, enabled });
    invalidateCodexResourceSnapshotCaches();
    return result;
  }
  const target = codexConfigPath(homeDir);
  if (!fs.existsSync(target)) {
    throw new Error("还没有找到 Codex config.toml，无法修改资源开关。");
  }
  const content = fs.readFileSync(target, "utf8");
  const tableName = resourceKind === "plugin"
    ? tomlTablePath(["plugins", resourceId])
    : tomlTablePath(["mcp_servers", resourceId]);
  if (!hasTomlTable(content, tableName)) {
    throw new Error(`Codex 配置里没有找到 ${resourceKind === "plugin" ? "插件" : "MCP"}：${resourceId}`);
  }
  const nextContent = setTomlTableBoolean(content, tableName, "enabled", Boolean(enabled));
  const backup = `${target}.codexbridge.${timestamp()}.bak`;
  fs.copyFileSync(target, backup);
  writeTextAtomic(target, nextContent);
  invalidateCodexResourceSnapshotCaches();
  return {
    ok: true,
    kind: resourceKind,
    id: resourceId,
    enabled: Boolean(enabled),
    backup,
  };
}

function normalizeCodexResourceKind(kind = "") {
  const value = String(kind || "").trim().toLowerCase();
  if (value === "plugin" || value === "plugins") {
    return "plugin";
  }
  if (value === "mcp" || value === "mcp_server" || value === "mcpservers") {
    return "mcp";
  }
  if (value === "skill" || value === "skills") {
    return "skill";
  }
  return "";
}

function setCodexLocalSkillEnabled({ homeDir = os.homedir(), id = "", enabled = true } = {}) {
  const skillName = safeCodexLocalSkillName(id);
  const skillDir = path.join(homeDir, ".codex", "skills", skillName);
  const enabledPath = path.join(skillDir, "SKILL.md");
  const disabledPath = path.join(skillDir, "SKILL.md.disabled");
  if (!fs.existsSync(skillDir)) {
    throw new Error(`没有找到本地技能：${skillName}`);
  }
  if (enabled) {
    if (fs.existsSync(enabledPath)) {
      return { ok: true, kind: "skill", id: skillName, enabled: true };
    }
    if (!fs.existsSync(disabledPath)) {
      throw new Error(`没有找到可启用的技能文件：${skillName}`);
    }
    fs.renameSync(disabledPath, enabledPath);
    return { ok: true, kind: "skill", id: skillName, enabled: true };
  }
  if (fs.existsSync(disabledPath)) {
    return { ok: true, kind: "skill", id: skillName, enabled: false };
  }
  if (!fs.existsSync(enabledPath)) {
    throw new Error(`没有找到可停用的技能文件：${skillName}`);
  }
  fs.renameSync(enabledPath, disabledPath);
  return { ok: true, kind: "skill", id: skillName, enabled: false };
}

function safeCodexLocalSkillName(value = "") {
  const name = String(value || "").trim();
  if (
    !name
    || name === "."
    || name === ".."
    || name.startsWith(".")
    || name.includes("/")
    || name.includes("\\")
    || path.basename(name) !== name
  ) {
    throw new Error("技能名称不合法，只能管理 .codex/skills 下的单个本地技能。");
  }
  return name;
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
  const catalogSessions = listCodexThreadCatalogSessions(
    codexDir,
    DatabaseSync,
    rowLimit,
    workspaceState,
  );
  const stateSessions = listCodexStateSessions(
    codexDir,
    DatabaseSync,
    rowLimit,
    workspaceState,
  );
  let sessions = stateSessions;
  if (catalogSessions.length) {
    const catalogIds = new Set(
      catalogSessions.map((session) => String(session.id || "").toLowerCase()),
    );
    sessions = [
      ...catalogSessions,
      ...stateSessions.filter((session) =>
        !catalogIds.has(String(session.id || "").toLowerCase()) &&
        sessionHasRecoverableRollout(session)
      ),
    ];
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

export function listCodexSessionTree({ homeDir = os.homedir(), limit = 80 } = {}) {
  const limitValue = Number(limit || 80);
  const requestedLimit = Number.isFinite(limitValue) && limitValue > 0 ? limitValue : 80;
  const sessions = listCodexSessions({ homeDir, limit });
  const workspaceState = readCodexWorkspaceState(homeDir);
  const projectMap = new Map();
  const projects = [];
  const looseSessions = [];

  for (const root of workspaceState.workspaceRoots || []) {
    const key = sessionProjectTreeKey(root.path);
    if (!key || projectMap.has(key)) {
      continue;
    }
    const project = {
      key,
      name: projectNameFromPath(root.path),
      path: root.path,
      active: Boolean(root.active),
      source: root.source || "workspace",
      sessions: [],
    };
    projectMap.set(key, project);
    projects.push(project);
  }

  for (const session of sessions) {
    const projectPath = normalizeStoredProjectPath(session.projectPath || "");
    const key = sessionProjectTreeKey(projectPath);
    if (!key) {
      looseSessions.push(session);
      continue;
    }
    if (!projectMap.has(key)) {
      const project = {
        key,
        name: session.project || projectNameFromPath(projectPath),
        path: projectPath,
        active: Boolean(session.projectActive),
        source: session.projectSource || "session",
        sessions: [],
      };
      projectMap.set(key, project);
      projects.push(project);
    }
    projectMap.get(key).sessions.push(session);
  }

  const projectSessions = projects.reduce((sum, project) => sum + project.sessions.length, 0);
  const activeProjects = projects.filter((project) => project.active).length;
  const classification = codexSessionTreeClassification({
    sessions,
    projects,
    workspaceState,
  });
  let recoverySummary = {};
  try {
    recoverySummary = previewCodexThreadCatalogRecovery({ homeDir }).summary || {};
  } catch {
    recoverySummary = {};
  }
  return {
    version: 1,
    summary: {
      sessions: sessions.length,
      projects: projects.length,
      activeProjects,
      historyProjects: Math.max(0, projects.length - activeProjects),
      projectSessions,
      looseSessions: looseSessions.length,
      loadedSessions: sessions.length,
      limit: requestedLimit,
      mayHaveMore: sessions.length >= requestedLimit,
      rawThreads: Number(recoverySummary.rawThreads || sessions.length),
      userThreads: Number(recoverySummary.userThreads || sessions.length),
      activeUserThreads: Number(recoverySummary.activeUserThreads || sessions.length),
      catalogThreads: Number(recoverySummary.catalogThreads || 0),
      sidebarThreads: Number(recoverySummary.sidebarThreads || 0),
      recoverableThreads: Number(recoverySummary.recoverableThreads || 0),
      subagentThreads: Number(recoverySummary.subagentThreads || 0),
      internalThreads: Number(recoverySummary.internalThreads || 0),
      archivedThreads: Number(recoverySummary.archivedThreads || 0),
      unrecoverableThreads: Number(recoverySummary.unrecoverableThreads || 0),
    },
    classification,
    sessions,
    projects,
    looseSessions,
  };
}

function codexSessionTreeClassification({
  sessions = [],
  projects = [],
  workspaceState = emptyCodexWorkspaceState(),
} = {}) {
  return {
    projectReasons: countBy(sessions, (session) => session.projectReason || "unknown"),
    projectSources: countBy(projects, (project) => project.source || "unknown"),
    workspaceRoots: Array.isArray(workspaceState.workspaceRoots) ? workspaceState.workspaceRoots.length : 0,
    sidebarProjectThreadAssignments: workspaceState.sidebarProjectThreadAssignments?.size || 0,
    projectlessThreadMarkers: workspaceState.projectlessThreadIds?.size || 0,
  };
}

function countBy(items = [], keyFn) {
  const counts = {};
  for (const item of Array.isArray(items) ? items : []) {
    const key = String(keyFn(item) || "unknown");
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

export function codexProjectRecoveryPlan({
  homeDir = os.homedir(),
  limit = 500,
  exists = fs.existsSync,
} = {}) {
  const tree = listCodexSessionTree({ homeDir, limit });
  const roots = [];
  const seen = new Set();
  for (const project of tree.projects || []) {
    const cleanPath = normalizeStoredProjectPath(project.path || "");
    const key = sessionProjectTreeKey(cleanPath);
    if (!key || seen.has(key) || isCodexGeneratedWorkspaceRoot(cleanPath)) {
      continue;
    }
    seen.add(key);
    let pathExists = false;
    try {
      pathExists = Boolean(exists(cleanPath));
    } catch {
      pathExists = false;
    }
    roots.push({
      key,
      name: project.name || projectNameFromPath(cleanPath),
      path: cleanPath,
      sessions: Array.isArray(project.sessions) ? project.sessions.length : 0,
      exists: pathExists,
      active: Boolean(project.active),
    });
  }
  for (const session of tree.looseSessions || []) {
    if (!String(session?.projectPath || "").trim()) {
      continue;
    }
    const cleanPath = normalizeStoredProjectPath(session.projectPath || "");
    const key = sessionProjectTreeKey(cleanPath);
    if (!key || seen.has(key) || isCodexGeneratedWorkspaceRoot(cleanPath)) {
      continue;
    }
    seen.add(key);
    let pathExists = false;
    try {
      pathExists = Boolean(exists(cleanPath));
    } catch {
      pathExists = false;
    }
    roots.push({
      key,
      name: session.project || projectNameFromPath(cleanPath),
      path: cleanPath,
      sessions: (tree.looseSessions || []).filter((item) =>
        sessionProjectTreeKey(item.projectPath || "") === key
      ).length,
      exists: pathExists,
      active: false,
    });
  }
  const launchRoots = roots.filter((root) => root.exists);
  const autoLaunchRoots = launchRoots.filter((root) => !root.active);
  const missingRoots = roots.filter((root) => !root.exists);
  return {
    version: 1,
    summary: {
      projects: roots.length,
      launchableProjects: launchRoots.length,
      autoLaunchableProjects: autoLaunchRoots.length,
      missingProjects: missingRoots.length,
      sessions: Number(tree.summary?.sessions || 0),
      looseSessions: Number(tree.summary?.looseSessions || 0),
    },
    roots,
    launchRoots,
    autoLaunchRoots,
    missingRoots,
    looseSessions: tree.looseSessions || [],
  };
}

export function recoverCodexSidebarState({
  homeDir = os.homedir(),
  limit = 1000,
  sessionTree = null,
} = {}) {
  const codexDir = path.join(homeDir, ".codex");
  const statePath = path.join(codexDir, ".codex-global-state.json");
  if (!fs.existsSync(statePath)) {
    throw new Error("没有找到 ChatGPT 本地状态文件，无法恢复会话侧栏。");
  }
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    throw new Error("ChatGPT 本地状态文件正在写入或已损坏；请先完全退出 ChatGPT 后重试恢复会话。");
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("ChatGPT 本地状态文件格式无效，已停止恢复以保护历史数据。");
  }

  const tree = sessionTree || listCodexSessionTree({ homeDir, limit });
  const existingOrders = state["sidebar-project-thread-orders"];
  const sidebarOrders = existingOrders && typeof existingOrders === "object" && !Array.isArray(existingOrders)
    ? { ...existingOrders }
    : {};
  const workspaceHints = state["thread-workspace-root-hints"] &&
    typeof state["thread-workspace-root-hints"] === "object" &&
    !Array.isArray(state["thread-workspace-root-hints"])
    ? { ...state["thread-workspace-root-hints"] }
    : {};
  const savedRoots = Array.isArray(state["electron-saved-workspace-roots"])
    ? [...state["electron-saved-workspace-roots"]]
    : [];
  const savedRootKeys = new Set(savedRoots.map((item) => sessionProjectTreeKey(item)));
  const projectThreadIds = new Set();
  const reattachedLooseThreadIds = new Set();
  const looseTreeSessions = Array.isArray(tree?.looseSessions) ? tree.looseSessions : [];
  let projectSessions = 0;

  for (const project of Array.isArray(tree?.projects) ? tree.projects : []) {
    const projectPath = normalizeStoredProjectPath(project?.path || "");
    const projectKey = sessionProjectTreeKey(projectPath);
    if (!projectKey) {
      continue;
    }
    const matchingOrderKey = Object.keys(sidebarOrders)
      .find((item) => sessionProjectTreeKey(item) === projectKey) || projectPath;
    const missingSidebarSessions = looseTreeSessions.filter((session) => {
      if (String(session?.projectReason || "") !== "outside_sidebar_project_threads") {
        return false;
      }
      const workspaceKey = canonicalProjectRootKey(session?.workspacePath || "");
      const rootKey = canonicalProjectRootKey(projectPath);
      return Boolean(workspaceKey && rootKey && (workspaceKey === rootKey || workspaceKey.startsWith(`${rootKey}/`)));
    });
    const scannedIds = [
      ...(Array.isArray(project?.sessions) ? project.sessions : []),
      ...missingSidebarSessions,
    ]
      .map((session) => String(session?.id || "").trim())
      .filter(Boolean);
    for (const session of missingSidebarSessions) {
      const threadId = String(session?.id || "").trim().toLowerCase();
      if (threadId) {
        reattachedLooseThreadIds.add(threadId);
      }
    }
    const existingIds = Array.isArray(sidebarOrders[matchingOrderKey])
      ? sidebarOrders[matchingOrderKey]
      : [];
    const restoredIds = orderedUniqueStrings([...scannedIds, ...existingIds]);
    sidebarOrders[matchingOrderKey] = restoredIds;
    for (const threadId of restoredIds) {
      projectThreadIds.add(threadId.toLowerCase());
      workspaceHints[threadId] = projectPath;
    }
    projectSessions += restoredIds.length;
    if (!savedRootKeys.has(projectKey)) {
      savedRoots.push(projectPath);
      savedRootKeys.add(projectKey);
    }
  }

  const looseScannedIds = looseTreeSessions
    .map((session) => String(session?.id || "").trim())
    .filter((threadId) => threadId && !reattachedLooseThreadIds.has(threadId.toLowerCase()));
  const looseExistingIds = Array.isArray(state["projectless-thread-ids"])
    ? state["projectless-thread-ids"]
    : [];
  const projectlessThreadIds = orderedUniqueStrings([...looseScannedIds, ...looseExistingIds])
    .filter((threadId) => !projectThreadIds.has(threadId.toLowerCase()));

  const persistedAtomState = state["electron-persisted-atom-state"] &&
    typeof state["electron-persisted-atom-state"] === "object" &&
    !Array.isArray(state["electron-persisted-atom-state"])
    ? { ...state["electron-persisted-atom-state"] }
    : {};
  persistedAtomState["sidebar-project-list-expanded-v1"] = true;
  for (const projectPath of savedRoots) {
    persistedAtomState[`sidebar-project-expanded-v1-codex:${projectPath}`] = true;
  }

  const nextState = {
    ...state,
    "electron-persisted-atom-state": persistedAtomState,
    "electron-saved-workspace-roots": savedRoots,
    "sidebar-project-thread-orders": sidebarOrders,
    "projectless-thread-ids": projectlessThreadIds,
    "thread-workspace-root-hints": workspaceHints,
  };
  const backup = nextCodexRestoreBackupPath(statePath, "before-sidebar-recovery");
  fs.copyFileSync(statePath, backup);
  writeJsonAtomic(statePath, nextState);

  const verified = JSON.parse(fs.readFileSync(statePath, "utf8"));
  if (!verified || typeof verified !== "object") {
    fs.copyFileSync(backup, statePath);
    throw new Error("恢复后的 ChatGPT 状态校验失败，已自动还原原文件。");
  }
  return {
    ok: true,
    statePath,
    backup,
    projects: Object.keys(sidebarOrders).length,
    projectSessions,
    looseSessions: projectlessThreadIds.length,
    totalSessions: projectSessions + projectlessThreadIds.length,
    message: `已把 ${projectSessions} 条项目会话和 ${projectlessThreadIds.length} 条无项目会话写回 ChatGPT 侧栏索引。`,
  };
}

function orderedUniqueStrings(values = []) {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const item = String(value || "").trim();
    const key = item.toLowerCase();
    if (!item || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(item);
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
    db.exec("PRAGMA query_only = ON");
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
      "'' AS rollout_path",
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

function selectCodexThreadCatalogSession(codexDir, DatabaseSync, sessionId, workspaceState) {
  const dbPath = path.join(codexDir, "sqlite", "codex-dev.db");
  if (!fs.existsSync(dbPath)) {
    return null;
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA query_only = ON");
    db.exec("PRAGMA busy_timeout = 1500");
    if (!hasTable(db, "local_thread_catalog")) {
      return null;
    }
    const columns = tableColumns(db, "local_thread_catalog");
    if (!columns.includes("thread_id")) {
      return null;
    }
    const selectColumns = [
      "thread_id AS id",
      columns.includes("display_title") ? "display_title AS title" : "thread_id AS title",
      columns.includes("model_provider") ? "model_provider" : "'' AS model_provider",
      "'' AS model",
      columns.includes("source_kind") ? "source_kind AS source" : "'' AS source",
      "'user' AS thread_source",
      "'' AS project",
      columns.includes("cwd") ? "cwd AS project_path" : "'' AS project_path",
      "'' AS rollout_path",
      "0 AS archived",
      "1 AS has_user_event",
      "'' AS first_user_message",
      columns.includes("source_updated_at") ? "source_updated_at AS session_sort_at" : "0 AS session_sort_at",
    ].join(", ");
    const missingPredicate = columns.includes("missing_candidate") ? " AND COALESCE(missing_candidate, 0) = 0" : "";
    const row = db
      .prepare(`SELECT ${selectColumns} FROM local_thread_catalog WHERE thread_id = ?${missingPredicate}`)
      .get(sessionId);
    if (!row) {
      return null;
    }
    row.rollout_path = findCodexRolloutPathForThread(codexDir, sessionId);
    return {
      session: classifySessionWorkspace(normalizeSessionRow(row, dbPath), workspaceState),
      databasePath: dbPath,
    };
  } catch {
    return null;
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
      db.exec("PRAGMA query_only = ON");
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
        columns.includes("rollout_path") ? "rollout_path" : "'' AS rollout_path",
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
    throw new Error("请选择要导出的 Codex 会话。");
  }
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch (error) {
    throw new Error(`当前运行环境不支持导出 Codex 会话：${error.message}`);
  }
  const codexDir = path.join(homeDir, ".codex");
  const workspaceState = readCodexWorkspaceState(homeDir);
  if (fs.existsSync(codexDir)) {
    const catalogExport = selectCodexThreadCatalogSession(codexDir, DatabaseSync, targetId, workspaceState);
    if (catalogExport) {
      const exportedSession = {
        ...catalogExport.session,
        transcript: readCodexRolloutTranscript(catalogExport.session.rolloutPath),
      };
      const markdown = codexSessionMarkdown(exportedSession);
      return {
        session: exportedSession,
        databasePath: catalogExport.databasePath,
        markdown,
      };
    }
  }
  for (const dbPath of fs.existsSync(codexDir) ? codexStateDatabasePaths(codexDir) : []) {
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec("PRAGMA query_only = ON");
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
      const exportedSession = {
        ...session,
        transcript: readCodexRolloutTranscript(session.rolloutPath),
      };
      const markdown = codexSessionMarkdown(exportedSession);
      return {
        session: exportedSession,
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

export function exportCodexProjectMarkdown(projectKey, { homeDir = os.homedir(), limit = 1000 } = {}) {
  const targetKey = String(projectKey || "").trim();
  if (!targetKey) {
    throw new Error("Project key is required.");
  }
  const tree = listCodexSessionTree({ homeDir, limit });
  const project = (tree.projects || []).find((item) => sameSessionProjectTreeKey(item.key, targetKey));
  if (!project) {
    throw new Error("Codex project not found.");
  }
  const exportedProject = {
    ...project,
    sessions: (project.sessions || []).map((session) => ({
      ...session,
      transcript: readCodexRolloutTranscript(session.rolloutPath),
    })),
  };
  return {
    project: exportedProject,
    markdown: codexProjectMarkdown(exportedProject),
  };
}

export function exportCodexLooseSessionsMarkdown({ homeDir = os.homedir(), limit = 1000 } = {}) {
  const tree = listCodexSessionTree({ homeDir, limit });
  const group = {
    key: "loose",
    name: "No-project sessions",
    sessions: (tree.looseSessions || []).map((session) => ({
      ...session,
      transcript: readCodexRolloutTranscript(session.rolloutPath),
    })),
  };
  return {
    group,
    markdown: codexLooseSessionsMarkdown(group),
  };
}

export function exportCodexSessionTreeMarkdown({ homeDir = os.homedir(), limit = 1000 } = {}) {
  const tree = listCodexSessionTree({ homeDir, limit });
  const exportedTree = {
    ...tree,
    projects: (tree.projects || []).map((project) => ({
      ...project,
      sessions: (project.sessions || []).map((session) => ({
        ...session,
        transcript: readCodexRolloutTranscript(session.rolloutPath),
      })),
    })),
    looseSessions: (tree.looseSessions || []).map((session) => ({
      ...session,
      transcript: readCodexRolloutTranscript(session.rolloutPath),
    })),
  };
  return {
    tree: exportedTree,
    markdown: codexSessionTreeMarkdown(exportedTree),
  };
}

export function exportCodexFilteredSessionsMarkdown({ sessionIds = [], filterText = "", homeDir = os.homedir(), limit = 1000 } = {}) {
  const requestedIds = new Set(
    (Array.isArray(sessionIds) ? sessionIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean),
  );
  if (!requestedIds.size) {
    throw new Error("请至少选择一个要导出的 Codex 会话。");
  }
  const tree = listCodexSessionTree({ homeDir, limit });
  const filteredProjects = [];
  for (const project of tree.projects || []) {
    const sessions = (project.sessions || [])
      .filter((session) => requestedIds.has(String(session.id || "")))
      .map((session) => ({
        ...session,
        transcript: readCodexRolloutTranscript(session.rolloutPath),
      }));
    if (!sessions.length) {
      continue;
    }
    filteredProjects.push({
      ...project,
      sessions,
    });
  }
  const looseSessions = (tree.looseSessions || [])
    .filter((session) => requestedIds.has(String(session.id || "")))
    .map((session) => ({
      ...session,
      transcript: readCodexRolloutTranscript(session.rolloutPath),
    }));
  const projectSessions = filteredProjects.reduce((sum, project) => sum + (project.sessions || []).length, 0);
  const exportedTree = {
    ...tree,
    filtered: true,
    filterText: String(filterText || "").trim(),
    projects: filteredProjects,
    looseSessions,
    summary: {
      ...(tree.summary || {}),
      sessions: projectSessions + looseSessions.length,
      projects: filteredProjects.length,
      projectSessions,
      looseSessions: looseSessions.length,
      requestedSessions: requestedIds.size,
      missingSessions: Math.max(0, requestedIds.size - projectSessions - looseSessions.length),
    },
  };
  return {
    tree: exportedTree,
    filterText: exportedTree.filterText,
    markdown: codexFilteredSessionsMarkdown(exportedTree, exportedTree.filterText),
  };
}

function parseMcpServers(content) {
  return directTomlTables(content, "mcp_servers")
    .map(({ tableName, parts }) => {
      const name = parts[1] || "";
      const command = readTomlStringInTable(content, tableName, "command") || "";
      return {
        name,
        tableName,
        command,
        description: command ? `通过 ${path.basename(command)} 提供 MCP 工具。` : "Codex MCP 服务。",
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
        description: "写在 Codex 配置里的插件。",
      };
    })
    .filter((item) => item.id);
}

function sessionHasRecoverableRollout(session = {}) {
  const rolloutPath = normalizeStoredProjectPath(session.rolloutPath || "");
  if (!rolloutPath) {
    return false;
  }
  try {
    return fs.statSync(rolloutPath).isFile();
  } catch {
    return false;
  }
}

export async function setCodexResourceEnabledTransaction({
  homeDir = os.homedir(),
  kind = "",
  id = "",
  enabled = true,
  coordinator = sharedConfigWriteCoordinator,
} = {}) {
  const resourceKind = normalizeCodexResourceKind(kind);
  const resourceId = String(id || "").trim();
  if (!resourceKind || !resourceId) {
    throw new Error("A resource kind and id are required.");
  }
  if (resourceKind === "skill") {
    return coordinator.runExclusive(() => {
      const result = setCodexLocalSkillEnabled({ homeDir, id: resourceId, enabled });
      invalidateCodexResourceSnapshotCaches();
      return result;
    });
  }
  const target = codexConfigPath(homeDir);
  const committed = await coordinator.runTransaction({
    operation: "resource:setEnabled",
    prepare: () => {
      const originalBytes = readOptionalFileBytes(target);
      if (originalBytes === null) {
        throw new Error("Codex config.toml is missing.");
      }
      const content = originalBytes.toString("utf8");
      const tableName = resourceKind === "plugin"
        ? tomlTablePath(["plugins", resourceId])
        : tomlTablePath(["mcp_servers", resourceId]);
      if (!hasTomlTable(content, tableName)) {
        throw new Error("The requested Codex resource table is missing.");
      }
      const nextContent = setTomlTableBoolean(content, tableName, "enabled", Boolean(enabled));
      return {
        entries: [{
          id: "codexConfig",
          target,
          content: nextContent,
          sensitive: true,
          expectedOriginal: { exists: true, bytes: originalBytes },
          validate: ({ content: candidate }) => {
            const candidateText = Buffer.isBuffer(candidate)
              ? candidate.toString("utf8")
              : String(candidate);
            if (
              !hasTomlTable(candidateText, tableName) ||
              readTomlBooleanInTable(candidateText, tableName, "enabled") !== Boolean(enabled)
            ) {
              throw new Error("Codex resource toggle candidate did not validate.");
            }
          },
        }],
        value: {
          ok: true,
          kind: resourceKind,
          id: resourceId,
          enabled: Boolean(enabled),
          backup: null,
        },
      };
    },
  });
  invalidateCodexResourceSnapshotCaches();
  return { ...committed.value, configRevision: committed.configRevision };
}

function listCodexPluginMarketplaces(content = "") {
  return directTomlTables(content, "marketplaces")
    .map(({ tableName, parts }) => {
      const id = String(parts[1] || "").trim();
      if (!id || CODEX_PLUGIN_PAGE_HIDDEN_MARKETPLACES.has(id)) {
        return null;
      }
      return {
        id,
        name: id,
        tableName,
        source: "config",
        availability: "marketplace_source",
        enabled: true,
        description: "Codex 插件市场来源。",
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function listCodexSkillFiles(homeDir) {
  const skillRoot = path.join(homeDir, ".codex", "skills");
  return listSkillFilesFromRoot(skillRoot, "codex")
    .map((item) => ({ ...item, enabled: true }));
}

function listDisabledCodexSkillFiles(homeDir) {
  const skillRoot = path.join(homeDir, ".codex", "skills");
  return listSkillFilesFromRoot(skillRoot, "codex", "", "disabled", { fileName: "SKILL.md.disabled" })
    .map((item) => ({ ...item, enabled: false }));
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
    output.push(...listSkillFilesFromRoot(
      path.join(plugin.path, "skills"),
      "plugin",
      plugin.id,
      availability,
      { pluginSource: plugin.pluginSource },
    ));
  }
  return output.sort((left, right) => left.name.localeCompare(right.name));
}

function listPluginSkillFilesForPlugins(
  plugins = [],
  {
    pluginIds = null,
    excludePluginIds = null,
    includePersonal = false,
    availability = "plugin",
  } = {},
) {
  const output = [];
  for (const plugin of Array.isArray(plugins) ? plugins : []) {
    const pluginId = normalizedResourceId(plugin.id);
    if (!pluginId || !plugin.path || plugin.installed === false) {
      continue;
    }
    if (pluginIds && !pluginIds.has(pluginId)) {
      continue;
    }
    if (excludePluginIds && excludePluginIds.has(pluginId)) {
      continue;
    }
    const pluginSource = plugin.pluginSource || pluginSourceFromId(plugin.id);
    if (!includePersonal && pluginSource === "personal") {
      continue;
    }
    output.push(...listSkillFilesFromPluginPath(plugin.path, plugin.id, availability, pluginSource));
  }
  return uniqueResourceItems(output, skillResourceKey)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function listSkillFilesFromPluginPath(pluginPath = "", pluginId = "", availability = "plugin", pluginSource = "") {
  const manifest = readPluginManifest(pluginPath);
  const roots = pluginSkillRoots(pluginPath, manifest);
  return roots.flatMap((skillRoot) =>
    listSkillFilesFromRoot(skillRoot, "plugin", pluginId, availability, { pluginSource }),
  );
}

function pluginSkillRoots(pluginPath = "", manifest = null) {
  const roots = new Set();
  const addRoot = (value) => {
    const raw = String(value || "").trim();
    if (!raw) {
      return;
    }
    const normalized = raw.replace(/[\\/]+$/, "");
    const resolved = path.isAbsolute(normalized)
      ? normalized
      : path.resolve(pluginPath, normalized);
    roots.add(resolved);
  };
  if (typeof manifest?.skills === "string") {
    addRoot(manifest.skills);
  }
  if (Array.isArray(manifest?.skills)) {
    manifest.skills.forEach(addRoot);
  }
  addRoot("skills");
  addRoot(path.join("plugin", "skills"));
  return [...roots];
}

function listSkillFilesFromRoot(skillRoot, source, pluginId = "", availability = "enabled", options = {}) {
  if (!fs.existsSync(skillRoot)) {
    return [];
  }
  const fileName = options.fileName || "SKILL.md";
  return safeReadDir(skillRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const skillPath = path.join(skillRoot, entry.name, fileName);
      const metadata = skillMetadata(skillPath, entry.name);
      return {
        name: metadata.name,
        folderName: entry.name,
        path: skillPath,
        source,
        pluginId,
        ...(options.pluginSource ? { pluginSource: options.pluginSource } : {}),
        availability,
        exists: fs.existsSync(skillPath),
        description: metadata.description,
      };
    })
    .filter((item) => item.exists)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function skillMetadata(skillPath, fallbackName = "") {
  try {
    const text = fs.readFileSync(skillPath, "utf8").slice(0, 6000);
    return {
      name: skillFrontmatterName(text) || fallbackName,
      description: skillDescriptionFromText(text),
    };
  } catch {
    return {
      name: fallbackName,
      description: "",
    };
  }
}

function skillDescription(skillPath) {
  try {
    const text = fs.readFileSync(skillPath, "utf8").slice(0, 6000);
    return skillDescriptionFromText(text);
  } catch {
    return "";
  }
}

function skillDescriptionFromText(text) {
  const frontmatterDescription = skillFrontmatterDescription(text);
  if (frontmatterDescription) {
    return frontmatterDescription;
  }
  const body = stripSkillFrontmatter(text);
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const titleIndex = lines.findIndex((line) => /^#{1,3}\s+/.test(line));
  const candidates = titleIndex >= 0 ? lines.slice(titleIndex + 1) : lines;
  const description = candidates.find((line) =>
    !/^#{1,6}\s+/.test(line) &&
    !/^[-*]\s*$/.test(line) &&
    !/^```/.test(line)
  );
  return String(description || "").replace(/^[-*]\s+/, "").slice(0, 220);
}

function skillFrontmatterName(text) {
  const frontmatter = extractSkillFrontmatter(text);
  if (!frontmatter) {
    return "";
  }
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = /^name\s*:\s*(.*)$/i.exec(line);
    if (!match) {
      continue;
    }
    const value = normalizeSkillName(unquoteYamlScalar(match[1].trim()));
    if (value) {
      return value;
    }
  }
  return "";
}

function skillFrontmatterDescription(text) {
  const frontmatter = extractSkillFrontmatter(text);
  if (!frontmatter) {
    return "";
  }
  const lines = frontmatter.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /^description\s*:\s*(.*)$/i.exec(line);
    if (!match) {
      continue;
    }
    const value = match[1].trim();
    if (value === ">" || value === "|") {
      return normalizeSkillDescription(collectYamlBlock(lines, index + 1));
    }
    return normalizeSkillDescription(unquoteYamlScalar(value));
  }
  return "";
}

function stripSkillFrontmatter(text) {
  const lines = String(text || "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return text;
  }
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  return endIndex >= 0 ? lines.slice(endIndex + 1).join("\n") : text;
}

function extractSkillFrontmatter(text) {
  const lines = String(text || "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return "";
  }
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  return endIndex >= 0 ? lines.slice(1, endIndex).join("\n") : "";
}

function collectYamlBlock(lines, startIndex) {
  const output = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && !/^\s/.test(line)) {
      break;
    }
    output.push(line.trim());
  }
  return output.join(" ");
}

function unquoteYamlScalar(value) {
  const trimmed = String(value || "").trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function normalizeSkillDescription(value) {
  return String(value || "").replace(/^[-*]\s+/, "").replace(/\s+/g, " ").trim().slice(0, 220);
}

function normalizeSkillName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 120);
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
      description: "可复用提示词文件。",
      purpose: "提示词资源，用来让 Codex 快速复用一段固定任务说明或工作模板。",
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
        const runtimeManifestPath = pluginRuntimeManifestPath(pluginPath);
        output.push({
          id: `${pluginEntry.name}@${sourceEntry.name}`,
          name: pluginDisplayName(manifest, pluginEntry.name),
          description: pluginDescription(manifest),
          version: versionEntry.name || pluginCacheVersion(pluginPath, manifest),
          source: "cache",
          pluginSource: sourceEntry.name,
          path: pluginPath,
          runtimeManifestPath,
          runtimeManifestValid: Boolean(runtimeManifestPath),
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
    manifest?.interface?.displayName,
    manifest?.interface?.display_name,
    manifest?.displayName,
    manifest?.display_name,
    manifest?.title,
    manifest?.name,
    fallback,
  ];
  return String(candidates.find((item) => String(item || "").trim()) || fallback || "");
}

function pluginDescription(manifest, fallback = "") {
  return String(
    manifest?.interface?.shortDescription ||
      manifest?.interface?.short_description ||
      manifest?.shortDescription ||
      manifest?.short_description ||
      manifest?.description ||
      manifest?.summary ||
      manifest?.about ||
      fallback ||
      "",
  ).trim();
}

function pluginPurpose(manifest, fallback = "") {
  const defaultPrompt = Array.isArray(manifest?.interface?.defaultPrompt)
    ? manifest.interface.defaultPrompt.join(" ")
    : "";
  return String(
    manifest?.interface?.longDescription ||
      manifest?.interface?.long_description ||
      manifest?.longDescription ||
      manifest?.long_description ||
      defaultPrompt ||
      manifest?.description ||
      manifest?.summary ||
      fallback ||
      "",
  ).replace(/\s+/g, " ").trim();
}

function pluginManifestMetadata(manifest) {
  const metadata = manifest?.interface || {};
  const capabilities = Array.isArray(metadata.capabilities)
    ? metadata.capabilities.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  return {
    category: String(metadata.category || manifest?.category || "").trim(),
    capabilities,
    developerName: String(metadata.developerName || metadata.developer || manifest?.author?.name || manifest?.author || "").trim(),
    websiteUrl: String(metadata.websiteURL || metadata.websiteUrl || manifest?.homepage || manifest?.repository || "").trim(),
  };
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
    marketplaces: Array.isArray(resources.marketplaces) ? resources.marketplaces.length : 0,
    prompts: Array.isArray(resources.prompts) ? resources.prompts.length : 0,
    agentFiles: Array.isArray(resources.agentFiles) ? resources.agentFiles.length : 0,
  };
}

function pluginRuntimeManifestPath(pluginPath) {
  const candidates = [
    path.join(pluginPath, ".codex-plugin", "plugin.json"),
    path.join(pluginPath, ".claude-plugin", "plugin.json"),
    path.join(pluginPath, "plugin.json"),
    path.join(pluginPath, ".codex-plugin.json"),
  ];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (parsed && typeof parsed === "object") {
        return candidate;
      }
    } catch {
      // A malformed manifest is not runtime installation evidence.
    }
  }
  return "";
}

function resourceDiagnosticsSummary(resources = {}) {
  const summary = resources.summary || resourceCountSummary(resources);
  const discoveredSummary = resources.discoveredSummary || resourceCountSummary(resources.discovered || {});
  const diagnostics = resourceDiagnosticEntries(resources);
  const currentWarnings = diagnostics.filter((item) => !resourceDiagnosticKindIsDiscovered(item.kind) && item.status && item.status !== "pass").length;
  const discoveredWarnings = diagnostics.filter((item) => resourceDiagnosticKindIsDiscovered(item.kind) && item.status && item.status !== "pass").length;
  return {
    current: summary,
    discovered: discoveredSummary,
    currentWarnings,
    discoveredWarnings,
    warnings: currentWarnings + discoveredWarnings,
  };
}

function resourceDiagnosticKindIsDiscovered(kind = "") {
  return String(kind || "").startsWith("discovered");
}

function resourceDiagnosticsLines(resources = {}) {
  const summary = resources.summary || resourceCountSummary(resources);
  const discoveredSummary = resources.discoveredSummary || resourceCountSummary(resources.discovered || {});
  const diagnostics = resourceDiagnosticEntries(resources);
  const nonPass = diagnostics.filter((item) => item.status && item.status !== "pass");
  const authority = resources.authority || {};
  const lines = [
    `- current: plugins=${resourceDisplayCount(summary.plugins, "unavailable")}, mcp=${resourceDisplayCount(summary.mcpServers, "unavailable")}, skills=${resourceDisplayCount(summary.skills, "unavailable")}, marketplaces=${resourceDisplayCount(summary.marketplaces, "unavailable")}, prompts=${resourceDisplayCount(summary.prompts, "unavailable")}, agentFiles=${resourceDisplayCount(summary.agentFiles, "unavailable")}`,
    `- discoveredNotCurrent: plugins=${Number(discoveredSummary.plugins || 0)}, mcp=${Number(discoveredSummary.mcpServers || 0)}, skills=${Number(discoveredSummary.skills || 0)}`,
    resourceAuthorityDiagnosticLine("pluginsAuthority", authority.plugins),
    resourceAuthorityDiagnosticLine("mcpAuthority", authority.mcpServers),
    resourceAuthorityDiagnosticLine("skillsAuthority", authority.skills),
    resourceReadStatusDiagnosticLine("pluginsRead", resources.readStatus?.plugins),
    resourceReadStatusDiagnosticLine("mcpRead", resources.readStatus?.mcpServers),
    resourceReadStatusDiagnosticLine("skillsRead", resources.readStatus?.skills),
    resourceReadStatusDiagnosticLine("marketplacesRead", resources.readStatus?.marketplaces),
    `- warnings: ${nonPass.length}`,
  ].filter(Boolean);
  for (const item of nonPass.slice(0, 12)) {
    lines.push(
      `- ${redactSecretText(item.kind)}:${redactSecretText(item.name)} ` +
        `status=${redactSecretText(item.status)} label=${redactSecretText(item.label)} ` +
        `detail=${redactSecretText(item.detail)}`,
    );
  }
  if (nonPass.length > 12) {
    lines.push(`- truncated: ${nonPass.length - 12} additional resource warnings`);
  }
  return lines;
}

function resourceReadStatusDiagnosticLine(label, entry = {}) {
  const state = entry?.ok === true ? "ok" : "unavailable";
  const code = String(entry?.code || (entry?.ok === true ? "ok" : "unavailable"));
  const reason = boundedCodexReadReason(entry?.reason || "");
  return reason
    ? `- ${label}: ${state} code=${redactSecretText(code)} reason=${redactSecretText(reason)}`
    : `- ${label}: ${state} code=${redactSecretText(code)}`;
}

function resourceAuthorityDiagnosticLine(label, entry = {}) {
  const source = String(entry?.source || "").trim();
  if (!source) {
    return "";
  }
  const detail = String(entry?.detail || "").trim();
  return detail
    ? `- ${label}: ${redactSecretText(source)} detail=${redactSecretText(detail)}`
    : `- ${label}: ${redactSecretText(source)}`;
}

function resourceDiagnosticEntries(resources = {}) {
  const discovered = resources.discovered || {};
  return [
    ...resourceDiagnosticEntriesForKind("mcp", resources.mcpServers),
    ...resourceDiagnosticEntriesForKind("plugin", resources.plugins),
    ...resourceDiagnosticEntriesForKind("skill", resources.skills),
    ...resourceDiagnosticEntriesForKind("discoveredMcp", discovered.mcpServers),
    ...resourceDiagnosticEntriesForKind("discoveredPlugin", discovered.plugins),
    ...resourceDiagnosticEntriesForKind("discoveredSkill", discovered.skills),
  ];
}

function resourceDiagnosticEntriesForKind(kind, items = []) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item) => {
      const diagnostic = item?.diagnostic || {};
      return {
        kind,
        name: item?.name || item?.id || item?.path || item?.command || "-",
        status: diagnostic.status || "",
        label: diagnostic.label || "",
        detail: diagnostic.detail || "",
      };
    })
    .filter((item) => item.status || item.label || item.detail);
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

function codexCliPluginSource(item = {}, id = "", sourcePath = "") {
  const explicit = String(item?.marketplaceName || pluginSourceFromId(id)).trim();
  if (explicit) {
    return explicit;
  }
  const source = item?.source || {};
  const normalized = [
    sourcePath,
    source.path,
    source.url,
    source.source,
    item?.path,
    item?.marketplaceSource?.source,
    item?.marketplaceSource?.sourceType,
  ]
    .map((value) => String(value || "").replace(/\\/g, "/").toLowerCase())
    .filter(Boolean)
    .join("\n");
  if (
    normalized.includes("/.codex/.tmp/plugins/plugins/")
    || normalized.includes("/plugins/cache/openai-curated/")
    || normalized.includes("/marketplaces/openai-curated/")
  ) {
    return "openai-curated";
  }
  if (
    normalized.includes("/plugins/cache/openai-curated-remote/")
    || normalized.includes("/marketplaces/openai-curated-remote/")
  ) {
    return "openai-curated-remote";
  }
  if (
    normalized.includes("/bundled-marketplaces/openai-bundled")
    || normalized.includes("/plugins/cache/openai-bundled/")
  ) {
    return "openai-bundled";
  }
  if (
    normalized.includes("/plugins/cache/personal/")
    || normalized.includes("/plugins/personal/")
  ) {
    return "personal";
  }
  if (
    normalized.includes("/marketplaces/claude-plugins-official")
    || normalized.includes("/plugins/cache/claude-plugins-official/")
  ) {
    return "claude-plugins-official";
  }
  const knownSource = codexSettingsPluginSourceFromName(item, id);
  if (knownSource) {
    return knownSource;
  }
  return "";
}

function codexSettingsPluginSourceFromName(item = {}, id = "") {
  const candidates = [
    id,
    item?.pluginId,
    item?.id,
    item?.name,
    item?.displayName,
    item?.title,
  ];
  for (const value of candidates) {
    const slug = pluginNameSlug(value);
    if (CODEX_SETTINGS_PLUGIN_SOURCE_BY_SLUG.has(slug)) {
      return CODEX_SETTINGS_PLUGIN_SOURCE_BY_SLUG.get(slug);
    }
  }
  return "";
}

function pluginNameSlug(value = "") {
  const withoutSource = String(value || "").split("@")[0] || "";
  return withoutSource
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function codexPluginSelectorParts(id = "") {
  const value = String(id || "").trim();
  const index = value.lastIndexOf("@");
  if (index <= 0 || index >= value.length - 1) {
    return {
      plugin: value,
      marketplace: "",
    };
  }
  return {
    plugin: value.slice(0, index),
    marketplace: value.slice(index + 1),
  };
}

function isCodexInternalPlugin(plugin = {}) {
  return plugin.pluginSource === "openai-bundled" || pluginSourceFromId(plugin.id) === "openai-bundled";
}

function isCodexVisibleConfiguredMcpServer(server = {}) {
  const name = normalizedResourceId(server.name);
  return server.enabled !== false && name !== "" && !CODEX_RESOURCE_HIDDEN_MCP_SERVER_NAMES.has(name);
}

function isCodexMarketplacePlugin(plugin = {}) {
  if (isCodexInternalPlugin(plugin)) {
    return false;
  }
  const marketplace = codexPluginSelectorParts(plugin.id || "").marketplace || plugin.pluginSource || "";
  return marketplace !== "" && marketplace !== "personal";
}

function isCodexPluginPageInstalledPlugin(plugin = {}) {
  return plugin.availability !== "marketplace" && plugin.availability !== "cached" && plugin.installed !== false;
}

function isCodexPluginPageAvailablePlugin(plugin = {}) {
  return plugin.installed === false && isCodexInternalPlugin(plugin);
}

function isCodexPluginPageConfiguredPlugin(plugin = {}) {
  return plugin.enabled !== false && plugin.availability !== "marketplace" && plugin.availability !== "cached";
}

function isCodexVisibleInstalledPlugin(plugin = {}) {
  if (plugin.availability === "marketplace" || plugin.availability === "cached") {
    return false;
  }
  return isCodexExternalPlugin(plugin);
}

function isCodexVisibleConfiguredPlugin(plugin = {}) {
  return plugin.enabled !== false && isCodexExternalPlugin(plugin);
}

function isCodexExternalPlugin(plugin = {}) {
  if (isCodexInternalPlugin(plugin)) {
    return false;
  }
  const source = plugin.pluginSource || pluginSourceFromId(plugin.id);
  if (source === "personal") {
    return false;
  }
  if (source) {
    return true;
  }
  return Boolean(String(plugin.id || plugin.name || "").trim());
}

function isCodexPluginCacheFallbackCandidate(plugin = {}) {
  const source = plugin.pluginSource || pluginSourceFromId(plugin.id);
  return source !== "openai-bundled";
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

function skillResourceKey(item = {}) {
  const filePath = normalizedFilePathKey(item.path);
  if (filePath) {
    return `path:${filePath}`;
  }
  return `${item.source || ""}:${item.pluginId || ""}:${normalizeSkillName(item.name || "")}`;
}

function pluginPageSkillResourceKey(item = {}) {
  return `skill:${normalizeSkillName(item.name || item.folderName || item.path || "")}`;
}

function normalizedFilePathKey(value = "") {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  const resolved = path.resolve(text);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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
      source: resolved.startsWith(path.resolve(rootDir)) ? "project" : "codex",
      description: "Codex 会读取的项目或用户规则文件。",
      purpose: "AGENTS 规则文件，用来告诉 Codex 当前项目或用户目录里的操作边界、约定和注意事项。",
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
    rolloutPath: normalizeStoredProjectPath(row.rollout_path || ""),
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
    const pinnedRoots = Array.isArray(parsed?.["pinned-project-ids"])
      ? parsed["pinned-project-ids"]
      : [];
    const localProjectRoots = codexProjectRootsFromValue(parsed?.["local-projects"]);
    const projectOrderRoots = codexProjectRootsFromValue(parsed?.["project-order"]);
    const activeRootKeys = new Set(uniqueWorkspaceRoots(activeRoots).map((root) => root.key));
    const rootSource = pinnedRoots.length
      ? "pinned"
      : localProjectRoots.length
        ? "local"
        : activeRoots.length
          ? "active"
          : projectOrderRoots.length
            ? "project_order"
            : "saved";
    const roots = pinnedRoots.length
      ? pinnedRoots
      : localProjectRoots.length
        ? localProjectRoots
        : activeRoots.length
          ? activeRoots
          : projectOrderRoots.length
            ? projectOrderRoots
            : savedRoots;
    const projectlessThreadIds = new Set(
      (Array.isArray(parsed?.["projectless-thread-ids"]) ? parsed["projectless-thread-ids"] : [])
        .map((item) => String(item || "").toLowerCase())
        .filter(Boolean),
    );
    for (const threadId of Object.keys(parsed?.["thread-projectless-output-directories"] || {})) {
      const id = String(threadId || "").toLowerCase();
      if (id) {
        projectlessThreadIds.add(id);
      }
    }
    const threadProjectAssignments = codexThreadProjectAssignmentsFromValue(parsed?.["thread-project-assignments"]);
    const sidebarThreadProjectAssignments =
      codexSidebarProjectThreadAssignmentsFromValue(parsed?.["sidebar-project-thread-orders"]);
    mergeThreadProjectAssignments(
      threadProjectAssignments,
      sidebarThreadProjectAssignments,
    );
    return {
      workspaceRoots: uniqueWorkspaceRoots(roots)
        .filter((root) => !isCodexGeneratedWorkspaceRoot(root.path))
        .map((root) => ({
          ...root,
          active: activeRootKeys.has(root.key),
          source: rootSource,
      })),
      threadWorkspaceRootHints: codexThreadWorkspaceRootHintsFromValue(parsed?.["thread-workspace-root-hints"]),
      threadProjectAssignments,
      sidebarProjectThreadAssignments: sidebarThreadProjectAssignments,
      sidebarProjectRootKeys: new Set(
        [...sidebarThreadProjectAssignments.values()]
          .map((projectRoot) => canonicalProjectRootKey(projectRoot))
          .filter(Boolean),
      ),
      sidebarProjectThreadOrderAuthoritative: sidebarThreadProjectAssignments.size > 0,
      projectlessThreadIds,
    };
  } catch {
    return emptyCodexWorkspaceState();
  }
}

function codexProjectRootsFromValue(value) {
  if (Array.isArray(value)) {
    return value.map(codexProjectRootFromEntry).filter(Boolean);
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([key, entry]) => codexProjectRootFromEntry(entry) || key)
      .filter(Boolean);
  }
  return [];
}

function codexThreadWorkspaceRootHintsFromValue(value) {
  const output = new Map();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return output;
  }
  for (const [threadId, root] of Object.entries(value)) {
    const id = String(threadId || "").toLowerCase();
    const clean = normalizeStoredProjectPath(root);
    if (!id || !clean) {
      continue;
    }
    output.set(id, clean);
  }
  return output;
}

function codexThreadProjectAssignmentsFromValue(value) {
  const output = new Map();
  if (!value || typeof value !== "object") {
    return output;
  }
  const entries = Array.isArray(value)
    ? value.map((entry) => [entry?.threadId || entry?.thread_id || entry?.id, entry])
    : Object.entries(value);
  for (const [threadId, entry] of entries) {
    const id = String(threadId || "").toLowerCase();
    const clean = normalizeStoredProjectPath(codexProjectRootFromEntry(entry));
    if (!id || !clean) {
      continue;
    }
    output.set(id, clean);
  }
  return output;
}

function codexSidebarProjectThreadAssignmentsFromValue(value) {
  const output = new Map();
  if (!value || typeof value !== "object") {
    return output;
  }
  const entries = Array.isArray(value)
    ? value.map((entry) => [codexProjectRootFromEntry(entry), codexSidebarThreadIdsFromValue(entry)])
    : Object.entries(value);
  for (const [projectRoot, threadIdsValue] of entries) {
    const cleanRoot = normalizeStoredProjectPath(projectRoot);
    if (!cleanRoot) {
      continue;
    }
    const threadIds = codexSidebarThreadIdsFromValue(threadIdsValue);
    for (const threadId of threadIds) {
      const id = String(threadId || "").toLowerCase();
      if (id) {
        output.set(id, cleanRoot);
      }
    }
  }
  return output;
}

function codexSidebarThreadIdsFromValue(value) {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? value.threadIds || value.thread_ids || value.threads || value.order || value.threadOrder || []
      : [];
  if (!Array.isArray(source)) {
    return [];
  }
  return source
    .map((item) => typeof item === "string" ? item : item?.threadId || item?.thread_id || item?.id || "")
    .filter(Boolean);
}

function mergeThreadProjectAssignments(target, source) {
  for (const [threadId, projectRoot] of source) {
    if (!target.has(threadId)) {
      target.set(threadId, projectRoot);
    }
  }
  return target;
}

function codexProjectRootFromEntry(entry) {
  if (typeof entry === "string") {
    return entry;
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return "";
  }
  return String(
    entry.path
      || entry.root
      || entry.workspaceRoot
      || entry.workspacePath
      || entry.cwd
      || entry.id
      || "",
  ).trim();
}

function emptyCodexWorkspaceState() {
  return {
    workspaceRoots: [],
    threadWorkspaceRootHints: new Map(),
    threadProjectAssignments: new Map(),
    sidebarProjectThreadAssignments: new Map(),
    sidebarProjectRootKeys: new Set(),
    sidebarProjectThreadOrderAuthoritative: false,
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
  return output;
}

function isCodexGeneratedWorkspaceRoot(rootPath = "") {
  const clean = normalizeStoredProjectPath(rootPath).replace(/\\/g, "/");
  return /\/Documents\/Codex\/\d{4}-\d{2}(?:-\d{2})?\//i.test(clean);
}

function classifySessionWorkspace(session = {}, workspaceState = emptyCodexWorkspaceState()) {
  const id = String(session.id || "").toLowerCase();
  const hintedWorkspacePath = normalizeStoredProjectPath(workspaceState.threadWorkspaceRootHints?.get(id) || "");
  const workspacePath = normalizeStoredProjectPath(hintedWorkspacePath || session.workspacePath || session.projectPath || "");
  if (!workspacePath) {
    return {
      ...session,
      project: "",
      projectPath: "",
      workspacePath: "",
      projectReason: "missing_workspace",
    };
  }
  if (workspaceState.projectlessThreadIds?.has(id)) {
    return {
      ...session,
      project: "",
      projectPath: "",
      workspacePath,
      projectReason: "projectless_marker",
    };
  }
  const sidebarAssignedProjectPath = normalizeStoredProjectPath(workspaceState.sidebarProjectThreadAssignments?.get(id) || "");
  const sidebarAssignedProjectRoot = sidebarAssignedProjectPath && !isCodexGeneratedWorkspaceRoot(sidebarAssignedProjectPath)
    ? matchingWorkspaceRoot(sidebarAssignedProjectPath, workspaceState.workspaceRoots || []) || {
        path: sidebarAssignedProjectPath,
        key: canonicalProjectRootKey(sidebarAssignedProjectPath),
        source: "sidebar",
      }
    : null;
  if (sidebarAssignedProjectRoot?.path) {
    return {
      ...session,
      project: projectNameFromPath(sidebarAssignedProjectRoot.path),
      projectPath: sidebarAssignedProjectRoot.path,
      projectActive: Boolean(sidebarAssignedProjectRoot.active),
      projectSource: sidebarAssignedProjectRoot.source || "sidebar",
      projectReason: "sidebar_project_thread_order",
      workspacePath,
    };
  }
  const assignedProjectPath = normalizeStoredProjectPath(workspaceState.threadProjectAssignments?.get(id) || "");
  const assignedProjectRoot = assignedProjectPath && !isCodexGeneratedWorkspaceRoot(assignedProjectPath)
    ? matchingWorkspaceRoot(assignedProjectPath, workspaceState.workspaceRoots || []) || {
        path: assignedProjectPath,
        key: canonicalProjectRootKey(assignedProjectPath),
      }
    : null;
  if (assignedProjectRoot?.path) {
    return {
      ...session,
      project: projectNameFromPath(assignedProjectRoot.path),
      projectPath: assignedProjectRoot.path,
      projectActive: Boolean(assignedProjectRoot.active),
      projectSource: assignedProjectRoot.source || "assignment",
      projectReason: "thread_assignment",
      workspacePath,
    };
  }
  const projectRoot = matchingWorkspaceRoot(workspacePath, workspaceState.workspaceRoots || []);
  if (
    projectRoot &&
    workspaceState.sidebarProjectThreadOrderAuthoritative &&
    workspaceState.sidebarProjectRootKeys?.has(projectRoot.key)
  ) {
    return {
      ...session,
      project: "",
      projectPath: "",
      projectActive: false,
      projectSource: "",
      projectReason: "outside_sidebar_project_threads",
      workspacePath,
    };
  }
  if (projectRoot) {
    return {
      ...session,
      project: projectNameFromPath(projectRoot.path),
      projectPath: projectRoot.path,
      projectActive: Boolean(projectRoot.active),
      projectSource: projectRoot.source || "workspace",
      projectReason: "workspace_root",
      workspacePath,
    };
  }
  if (isCodexGeneratedWorkspaceRoot(workspacePath)) {
    return {
      ...session,
      project: "",
      projectPath: "",
      workspacePath,
      projectReason: "codex_generated_workspace",
    };
  }
  return {
    ...session,
    project: "",
    projectPath: "",
    workspacePath,
    projectReason: hintedWorkspacePath ? "workspace_hint_outside_projects" : "outside_current_projects",
  };
}

function matchingWorkspaceRoot(workspacePath, workspaceRoots = []) {
  const workspaceKey = canonicalProjectRootKey(workspacePath);
  if (!workspaceKey) {
    return null;
  }
  const matchers = [...workspaceRoots].sort((left, right) => right.key.length - left.key.length);
  return matchers.find((root) => workspaceKey === root.key || workspaceKey.startsWith(`${root.key}/`)) || null;
}

function sessionProjectTreeKey(projectPath = "") {
  const key = canonicalProjectRootKey(projectPath);
  return key ? `path:${key}` : "";
}

function sameSessionProjectTreeKey(left = "", right = "") {
  return String(left || "").toLowerCase() === String(right || "").toLowerCase();
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
    columns.includes("rollout_path") ? "rollout_path" : "'' AS rollout_path",
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
    ...codexSessionMigrationLines(session),
    "",
  ];
  const transcript = Array.isArray(session.transcript) ? session.transcript : [];
  if (transcript.length) {
    lines.push("## Conversation", "");
    for (const item of transcript) {
      lines.push(`### ${codexTranscriptRoleLabel(item.role)}`, "", item.text, "");
    }
  } else if (session.firstUserMessage) {
    lines.push("## First User Message", "", session.firstUserMessage, "");
  }
  lines.push("## Notes", "", "Exported by CodexBridge. Full event replay depends on Codex local history storage.");
  return `${lines.join("\n")}\n`;
}

function codexSessionMigrationLines(session = {}) {
  const projectName = markdownSessionField(session.project);
  const projectPath = markdownSessionField(session.projectPath);
  const lines = [
    "## 迁移说明",
    "",
    "- 这份 Markdown 用于跨机器留档、迁移参考或人工恢复；不会自动写回 Codex Desktop 的本地会话数据库。",
  ];
  if (projectPath || projectName) {
    const target = projectPath || projectName;
    lines.push(`- 这是项目会话。迁移到新机器时，请先在目标机器用 Codex 打开项目目录：${target}，再参考本文件恢复标题、模型和上下文。`);
  } else {
    lines.push("- 这是无项目会话；迁移后会作为普通对话留档，需要归入项目时请先在目标机器打开项目目录并重新整理。");
  }
  lines.push("- API Key、插件、MCP、Skills 和本机路径仍以目标机器的 Codex/CodexBridge 配置为准。");
  return lines;
}

function markdownSessionField(value = "") {
  const text = String(value || "").trim();
  return text && text !== "-" ? text : "";
}

function codexExportMigrationChecklistLines({ projects = [], looseSessions = [], filtered = false } = {}) {
  const projectItems = Array.isArray(projects) ? projects : [];
  const looseItems = Array.isArray(looseSessions) ? looseSessions : [];
  const projectTargets = [...new Set(projectItems
    .map((project) => markdownSessionField(project.path || project.projectPath || project.name || project.key))
    .filter(Boolean))];
  const lines = [
    "## 迁移清单",
    "",
    "- 这份导出用于跨机器留档、迁移参考或人工恢复；不会自动写回 Codex Desktop 本地会话数据库。",
  ];
  if (filtered) {
    lines.push("- 这份文件只包含当前筛选结果；需要完整备份时请回到会话页使用“导出全部 Markdown”。");
  }
  if (projectTargets.length === 1) {
    lines.push(`- 项目会话：先在目标机器用 Codex 打开项目目录：${projectTargets[0]}，再按会话标题、模型和首条消息人工定位。`);
  } else if (projectTargets.length > 1) {
    lines.push(`- 项目会话：先在目标机器用 Codex 打开 ${projectTargets.length} 个项目目录；具体路径见下方 Project Index / Project sections。`);
  } else {
    lines.push("- 项目会话：如果需要保留项目归属，请先在目标机器用 Codex 打开对应项目目录。");
  }
  if (looseItems.length) {
    lines.push("- 无项目会话会作为普通对话留档；需要归入项目时，请先在目标机器打开项目目录并重新整理。");
  }
  lines.push("- API Key、插件、MCP、Skills 和本机路径仍以目标机器的 Codex/CodexBridge 配置为准。", "");
  return lines;
}

function codexProjectMarkdown(project = {}) {
  const sessions = Array.isArray(project.sessions) ? project.sessions : [];
  const lines = [
    `# Codex Project: ${project.name || project.path || project.key || "Untitled project"}`,
    "",
    `- Project key: ${project.key || "-"}`,
    `- Project path: ${project.path || "-"}`,
    `- Sessions: ${sessions.length}`,
    "",
    ...codexExportMigrationChecklistLines({ projects: [{ ...project, sessions }] }),
  ];
  for (const session of sessions) {
    lines.push("---", "", ...codexSessionMarkdownForProject(session));
  }
  lines.push("## Notes", "", "Exported by CodexBridge as a project-level handoff.");
  return `${lines.join("\n")}\n`;
}

function codexLooseSessionsMarkdown(group = {}) {
  const sessions = Array.isArray(group.sessions) ? group.sessions : [];
  const lines = [
    "# Codex No-Project Sessions",
    "",
    `- Sessions: ${sessions.length}`,
    "",
    ...codexExportMigrationChecklistLines({ looseSessions: sessions }),
  ];
  for (const session of sessions) {
    lines.push("---", "", ...codexSessionMarkdownForProject(session));
  }
  lines.push("## Notes", "", "Exported by CodexBridge as a no-project session handoff.");
  return `${lines.join("\n")}\n`;
}

function codexSessionTreeMarkdown(tree = {}) {
  const projects = Array.isArray(tree.projects) ? tree.projects : [];
  const looseSessions = Array.isArray(tree.looseSessions) ? tree.looseSessions : [];
  const summary = tree.summary || {};
  const lines = [
    "# Codex Sessions And Projects",
    "",
    `- Sessions: ${summary.sessions ?? projects.reduce((sum, project) => sum + (project.sessions || []).length, looseSessions.length)}`,
    `- Projects: ${summary.projects ?? projects.length}`,
    `- Project sessions: ${summary.projectSessions ?? projects.reduce((sum, project) => sum + (project.sessions || []).length, 0)}`,
    `- No-project sessions: ${summary.looseSessions ?? looseSessions.length}`,
    "",
    ...codexExportMigrationChecklistLines({ projects, looseSessions }),
    "## Project Index",
    "",
  ];
  if (projects.length) {
    for (const project of projects) {
      const sessions = Array.isArray(project.sessions) ? project.sessions : [];
      lines.push(`- ${project.name || project.path || project.key || "Untitled project"}: ${sessionCountLabel(sessions.length)}`);
      for (const session of sessions) {
        lines.push(`  - ${codexSessionIndexLine(session)}`);
      }
    }
  } else {
    lines.push("- No projects.");
  }
  lines.push("", "## No-Project Index", "");
  if (looseSessions.length) {
    for (const session of looseSessions) {
      lines.push(`- ${codexSessionIndexLine(session)}`);
    }
  } else {
    lines.push("- No no-project sessions.");
  }
  lines.push("");
  for (const project of projects) {
    lines.push(
      `## Project: ${project.name || project.path || project.key || "Untitled project"}`,
      "",
      `- Project key: ${project.key || "-"}`,
      `- Project path: ${project.path || "-"}`,
      `- Sessions: ${(project.sessions || []).length}`,
      "",
    );
    for (const session of project.sessions || []) {
      lines.push("---", "", ...codexSessionMarkdownForProject(session));
    }
  }
  lines.push(
    "## No-Project Sessions",
    "",
    `- Sessions: ${looseSessions.length}`,
    "",
  );
  for (const session of looseSessions) {
    lines.push("---", "", ...codexSessionMarkdownForProject(session));
  }
  lines.push("## Notes", "", "Exported by CodexBridge as a full local sessions handoff.");
  return `${lines.join("\n")}\n`;
}

function codexFilteredSessionsMarkdown(tree = {}, filterText = "") {
  const projects = Array.isArray(tree.projects) ? tree.projects : [];
  const looseSessions = Array.isArray(tree.looseSessions) ? tree.looseSessions : [];
  const summary = tree.summary || {};
  const sessionCount = summary.sessions ?? projects.reduce((sum, project) => sum + (project.sessions || []).length, looseSessions.length);
  const lines = [
    "# Codex Filtered Sessions",
    "",
    `- Filter: ${oneLineMarkdownPreview(filterText || "-", 240) || "-"}`,
    `- Sessions: ${sessionCount}`,
    `- Projects: ${summary.projects ?? projects.length}`,
    `- Project sessions: ${summary.projectSessions ?? projects.reduce((sum, project) => sum + (project.sessions || []).length, 0)}`,
    `- No-project sessions: ${summary.looseSessions ?? looseSessions.length}`,
    "",
    ...codexExportMigrationChecklistLines({ projects, looseSessions, filtered: true }),
    "## Filtered Project Index",
    "",
  ];
  if (projects.length) {
    for (const project of projects) {
      const sessions = Array.isArray(project.sessions) ? project.sessions : [];
      lines.push(`- ${project.name || project.path || project.key || "Untitled project"}: ${sessionCountLabel(sessions.length)}`);
      for (const session of sessions) {
        lines.push(`  - ${codexSessionIndexLine(session)}`);
      }
    }
  } else {
    lines.push("- No matching projects.");
  }
  lines.push("", "## Filtered No-Project Index", "");
  if (looseSessions.length) {
    for (const session of looseSessions) {
      lines.push(`- ${codexSessionIndexLine(session)}`);
    }
  } else {
    lines.push("- No matching no-project sessions.");
  }
  lines.push("");
  for (const project of projects) {
    lines.push(
      `## Project: ${project.name || project.path || project.key || "Untitled project"}`,
      "",
      `- Project key: ${project.key || "-"}`,
      `- Project path: ${project.path || "-"}`,
      `- Sessions: ${(project.sessions || []).length}`,
      "",
    );
    for (const session of project.sessions || []) {
      lines.push("---", "", ...codexSessionMarkdownForProject(session));
    }
  }
  lines.push(
    "## No-Project Sessions",
    "",
    `- Sessions: ${looseSessions.length}`,
    "",
  );
  for (const session of looseSessions) {
    lines.push("---", "", ...codexSessionMarkdownForProject(session));
  }
  lines.push("## Notes", "", "Exported by CodexBridge from the current filtered sessions view.");
  return `${lines.join("\n")}\n`;
}

function sessionCountLabel(count = 0) {
  const value = Number(count || 0);
  return `${value} ${value === 1 ? "session" : "sessions"}`;
}

function codexSessionIndexLine(session = {}) {
  const parts = [
    oneLineMarkdownPreview(session.title || session.id || "Untitled session"),
    `Provider: ${oneLineMarkdownPreview(session.modelProvider || "-", 80)}`,
    `Model: ${oneLineMarkdownPreview(session.model || "-", 80)}`,
  ];
  const firstUser = codexSessionFirstUserPreview(session);
  if (firstUser) {
    parts.push(`First user: ${firstUser}`);
  }
  return parts.join(" | ");
}

function codexSessionFirstUserPreview(session = {}) {
  const transcript = Array.isArray(session.transcript) ? session.transcript : [];
  const userItem = transcript.find((item) => item?.role === "user" && String(item.text || "").trim());
  return oneLineMarkdownPreview(userItem?.text || session.firstUserMessage || "", 180);
}

function oneLineMarkdownPreview(value = "", limit = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  const max = Math.max(20, Number(limit || 160));
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function codexSessionMarkdownForProject(session = {}) {
  return codexSessionMarkdown(session)
    .trim()
    .split(/\r?\n/)
    .map((line, index) => {
      if (index === 0 && line.startsWith("# ")) {
        return `## Session: ${line.slice(2)}`;
      }
      if (line.startsWith("### ")) {
        return `#### ${line.slice(4)}`;
      }
      if (line.startsWith("## ")) {
        return `### ${line.slice(3)}`;
      }
      return line;
    });
}

function findCodexRolloutPathForThread(codexDir = "", threadId = "") {
  const cleanId = String(threadId || "").trim();
  const sessionsDir = path.join(codexDir, "sessions");
  if (!cleanId || !fs.existsSync(sessionsDir)) {
    return "";
  }
  const stack = [sessionsDir];
  let bestPath = "";
  let bestMtime = 0;
  while (stack.length) {
    const currentDir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl") || !entry.name.includes(cleanId)) {
        continue;
      }
      const mtime = fileMtimeMs(fullPath);
      if (!bestPath || mtime >= bestMtime) {
        bestPath = fullPath;
        bestMtime = mtime;
      }
    }
  }
  return bestPath;
}

function fileMtimeMs(filePath = "") {
  try {
    return fs.statSync(filePath).mtimeMs || 0;
  } catch {
    return 0;
  }
}

function readCodexRolloutTranscript(rolloutPath = "", options = {}) {
  const target = normalizeStoredProjectPath(rolloutPath);
  if (!target || !fs.existsSync(target)) {
    return [];
  }
  const maxMessages = Math.max(1, Number(options.maxMessages || 200));
  const maxTotalChars = Math.max(1000, Number(options.maxTotalChars || 60000));
  const messages = [];
  let totalChars = 0;
  for (const line of fs.readFileSync(target, "utf8").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const item = codexRolloutTranscriptItem(line);
    if (!item) {
      continue;
    }
    const remaining = maxTotalChars - totalChars;
    if (remaining <= 0) {
      break;
    }
    const text = item.text.length > remaining
      ? `${item.text.slice(0, Math.max(0, remaining - 20)).trimEnd()}\n\n[内容过长，已截断]`
      : item.text;
    messages.push({ role: item.role, text });
    totalChars += text.length;
    if (messages.length >= maxMessages) {
      break;
    }
  }
  return messages;
}

function codexRolloutTranscriptItem(line = "") {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed?.type !== "response_item" || parsed?.payload?.type !== "message") {
    return null;
  }
  const role = String(parsed.payload.role || "").toLowerCase();
  if (role !== "user" && role !== "assistant") {
    return null;
  }
  const text = codexMessageContentText(parsed.payload.content);
  return text ? { role, text } : null;
}

function codexMessageContentText(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (!part || typeof part !== "object") {
        return "";
      }
      if (typeof part.text === "string") {
        return part.text;
      }
      if (typeof part.content === "string") {
        return part.content;
      }
      if (part.type === "input_image" || part.type === "image_url") {
        return "[图片]";
      }
      if (part.type === "input_file") {
        return `[文件${part.filename ? `: ${part.filename}` : ""}]`;
      }
      return "";
    })
    .map((text) => String(text || "").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function codexTranscriptRoleLabel(role = "") {
  return String(role || "").toLowerCase() === "assistant" ? "Assistant" : "User";
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

function tomlTablePath(parts = []) {
  return parts.map(tomlPathSegment).join(".");
}

function tomlPathSegment(value = "") {
  const text = String(value || "");
  if (/^[A-Za-z0-9_-]+$/.test(text)) {
    return text;
  }
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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
    providerGroups: [],
    sourceGroups: [],
    threadSourceGroups: [],
    recentThreads: [],
  };
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA query_only = ON");
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
      const legacyKimiCode = isLegacyKimiCodeProvider(providerId, normalized);
      const targetProviderId = legacyKimiCode ? "kimi-code" : providerId;
      if (legacyKimiCode && overrides[targetProviderId]) {
        continue;
      }
      overrides[targetProviderId] = legacyKimiCode
        ? {
            ...normalized,
            id: "kimi-code",
            name: normalized.name === "Kimi" ? "Kimi Code" : normalized.name,
            shortName: normalized.shortName === "Kimi" ? "Kimi Code" : normalized.shortName,
            keyEnv: "KIMI_CODE_API_KEY",
            keyLabel: normalized.keyLabel === "Kimi API Key"
              ? "Kimi Code API Key"
              : normalized.keyLabel,
          }
        : normalized;
    }
  }
  return overrides;
}

export function saveProviderOverride(rootDir, providerId, input = {}) {
  const id = String(providerId || input?.id || "").trim();
  if (!id) {
    throw new Error("Provider id is required.");
  }
  if (input.keyEnv) {
    providerApiKeyEnv(input.keyEnv);
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

export function resetProviderOverride(rootDir, providerId) {
  const id = String(providerId || "").trim();
  if (!id) {
    throw new Error("Provider id is required.");
  }
  const overrides = readProviderOverrides(rootDir);
  const removed = Object.prototype.hasOwnProperty.call(overrides, id);
  if (removed) {
    delete overrides[id];
    writeJsonAtomic(providerOverridesPath(rootDir), {
      version: 1,
      providers: overrides,
    });
  }
  const repair = repairDesktopModelReferences(rootDir);
  return {
    removed,
    provider: providerCatalog(rootDir).find((provider) => provider.id === id) || null,
    repair,
  };
}

export function saveProviderLogo(rootDir, ownerId, sourcePath) {
  const id = slugify(String(ownerId || "provider").trim()) || "provider";
  const source = String(sourcePath || "").trim();
  const bytes = readProviderLogoFileSafely(source);
  const extension = providerLogoExtension(source);
  const targetDir = path.join(rootDir, "config", "provider-logos");
  const target = path.join(targetDir, `${id}${extension}`);
  assertManagedProviderLogoPath(rootDir, target, { allowMissingTarget: true });
  fs.mkdirSync(targetDir, { recursive: true });
  assertManagedProviderLogoPath(rootDir, target, { allowMissingTarget: true });
  writeProviderLogoAtomic(rootDir, target, bytes);
  return {
    path: target,
    logoUrl: pathToFileURL(target).href,
  };
}

export function providerCatalog(rootDir, state = null) {
  const overrides = state && Object.prototype.hasOwnProperty.call(state, "providerOverrides")
    ? state.providerOverrides
    : readProviderOverrides(rootDir);
  const customModels = state && Object.prototype.hasOwnProperty.call(state, "customModels")
    ? state.customModels
    : readCustomModels(rootDir);
  const customProviders = new Map();
  const builtInProviderIds = new Set(PROVIDERS.map((provider) => provider.id));
  for (const model of customModels) {
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

export function modelCatalog(rootDir, state = null) {
  const providers = providerCatalog(rootDir, state);
  const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
  const imageInputOverrides = state && Object.prototype.hasOwnProperty.call(state, "modelImageInput")
    ? state.modelImageInput
    : readModelImageInputOverrides(rootDir);
  const capabilityOverrides = state && Object.prototype.hasOwnProperty.call(state, "modelCapabilities")
    ? state.modelCapabilities
    : readModelCapabilityOverrides(rootDir);
  const customModels = state && Object.prototype.hasOwnProperty.call(state, "customModels")
    ? state.customModels
    : readCustomModels(rootDir);
  return [
    ...effectiveBuiltInModels(rootDir, providers, state),
    ...effectiveCustomModels(rootDir, customModels, providers, state),
  ]
    .map((model) => applyProviderSettingsToModel(model, providerMap.get(model.providerId)))
    .map((model) => modelWithDefaultCapabilities(model))
    .map((model) => applyModelImageInputOverride(model, imageInputOverrides))
    .map((model) => applyModelCapabilityOverride(model, capabilityOverrides))
    .map((model) => withCapabilityStatus(model));
}

function effectiveCustomModels(rootDir, customModels, providers = providerCatalog(rootDir), state = null) {
  const directory = state && Object.prototype.hasOwnProperty.call(state, "modelDirectory")
    ? state.modelDirectory
    : readModelDirectory(rootDir);
  const providersById = new Map(providers.map((provider) => [provider.id, provider]));
  const modelsByCustomProvider = new Map();
  const unchanged = [];

  for (const model of customModels) {
    const provider = providersById.get(model.providerId);
    if (!provider?.custom) {
      unchanged.push(model);
      continue;
    }
    const models = modelsByCustomProvider.get(model.providerId) || [];
    models.push(model);
    modelsByCustomProvider.set(model.providerId, models);
  }

  const usedPresetIds = new Set([
    ...MODEL_PRESETS.map((model) => model.presetId),
    ...customModels.map((model) => model.presetId),
  ]);
  const refreshed = [];
  for (const [providerId, seedModels] of modelsByCustomProvider.entries()) {
    const provider = providersById.get(providerId);
    const entry = directory.providers?.[providerId];
    if (!provider || !entry) {
      refreshed.push(...seedModels);
      continue;
    }
    refreshed.push(...modelsForProviderDirectoryEntry(
      provider,
      entry,
      seedModels,
      usedPresetIds,
    ));
  }

  return [...unchanged, ...refreshed];
}

function effectiveBuiltInModels(rootDir, providers = providerCatalog(rootDir), state = null) {
  const directory = state && Object.prototype.hasOwnProperty.call(state, "modelDirectory")
    ? state.modelDirectory
    : readModelDirectory(rootDir);
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
    if (!upstreamModel || !providerDirectoryModelSupportsConfiguredApi(provider, remoteModel)) {
      continue;
    }
    const exact = exactTemplates.get(providerModelKey(providerId, upstreamModel));
    const presetId = exact?.presetId || uniqueSyncedPresetId(
      `${providerId}-${slugify(upstreamModel)}`,
      usedPresetIds,
    );
    usedPresetIds.add(presetId);
    const dropParams = exact?.dropParams || fallbackTemplate?.dropParams || [];
    const displayName = exact?.displayName || providerDirectoryModelDisplayName(
      provider,
      remoteModel,
      upstreamModel,
    );
    const api = providerDirectoryModelApi(provider, entry, remoteModel, exact, fallbackTemplate);
    models.push({
      ...(exact || {}),
      presetId,
      providerId,
      providerName: provider.name || entry.providerName || providerId,
      displayName,
      description: exact?.description || `${displayName} (${upstreamModel}) synced from ${provider.name || providerId}.`,
      api,
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
      custom: Boolean(provider.custom || exact?.custom || fallbackTemplate?.custom),
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
    if (provider.baseUrl && (!model.custom || !model.baseUrl)) {
      next.baseUrl = provider.baseUrl;
    }
    if (!model.custom) {
      next.api = providerDirectoryModelApi(
        provider,
        { baseUrl: provider.baseUrl || model.baseUrl || "" },
        { id: model.model || "" },
        model,
        model,
      );
    }
  }
  if (provider.keyEnv && (!model.custom || !(model.keyEnv || model.apiKeyEnv))) {
    next.keyEnv = provider.keyEnv;
    next.apiKeyEnv = provider.keyEnv;
  }
  if (provider.authMode && !model.authMode) {
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
        if (key === "keyEnv" && isRouterControlEnvName(value)) {
          continue;
        }
        if (/url$/i.test(key)) {
          assertCredentialFreeProviderUrl(value);
        }
        result[key] = key === "baseUrl" ? value.replace(/\/+$/, "") : value;
      }
    }
  }
  if (["responses", "chat_completions", "anthropic_messages"].includes(input.api)) {
    result.api = input.api;
  }
  if (["codex_openai", "api_key", "anthropic_api_key"].includes(input.authMode)) {
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

function isKimiCodeBaseUrl(value) {
  const source = String(value || "").trim();
  if (!source) {
    return false;
  }
  try {
    const parsed = new URL(source);
    return parsed.protocol === "https:"
      && parsed.hostname.toLowerCase() === "api.kimi.com"
      && parsed.pathname.replace(/\/+$/, "").toLowerCase() === "/coding/v1";
  } catch {
    return false;
  }
}

function isLegacyKimiCodeProvider(providerId, value = {}) {
  return String(providerId || value?.id || "").trim() === "kimi"
    && isKimiCodeBaseUrl(value?.baseUrl);
}

function legacyKimiCodeProviderOverride(rootDir) {
  const saved = readJsonIfExists(providerOverridesPath(rootDir), {});
  const source = saved?.providers && typeof saved.providers === "object"
    ? saved.providers
    : saved;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return null;
  }
  const legacy = normalizeProviderOverride(source.kimi);
  return legacy && isLegacyKimiCodeProvider("kimi", legacy)
    ? legacy
    : null;
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
      if (
        !upstreamModel
        || !providerDirectoryModelSupportsConfiguredApi(provider, remoteModel)
        || builtinUpstreamKeys.has(providerModelKey(providerId, upstreamModel))
      ) {
        continue;
      }
      const presetId = uniqueSyncedPresetId(
        `${providerId}-${slugify(upstreamModel)}`,
        usedPresetIds,
      );
      usedPresetIds.add(presetId);
      const displayName = providerDirectoryModelDisplayName(provider, remoteModel, upstreamModel);
      const api = providerDirectoryModelApi(provider, entry, remoteModel, null, template);
      synced.push({
        presetId,
        providerId,
        providerName: provider.name || entry.providerName || providerId,
        displayName,
        description: `${displayName} (${upstreamModel}) synced from ${provider.name || providerId}.`,
        api,
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

function providerDirectoryModelSupportsConfiguredApi(provider = {}, remoteModel = {}) {
  const metadata = [
    remoteModel.modelType,
    remoteModel.taskType,
    remoteModel.endpointType,
    remoteModel.category,
    ...(Array.isArray(remoteModel.capabilities) ? remoteModel.capabilities : []),
  ]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean)
    .join(" ");
  if (/(^|\W)(chat|text[_ -]?generation|language[_ -]?model|llm)(\W|$)/i.test(metadata)) {
    return true;
  }
  if (/(^|\W)(embedding|rerank|image[_ -]?generation|video[_ -]?generation|speech|audio|tts|asr|3d|realtime)(\W|$)/i.test(metadata)) {
    return false;
  }

  const id = String(remoteModel.id || "").trim().toLowerCase();
  return !/(^|[-_./])(text[-_.]?embedding|embedding|embeddings|embed|rerank|reranker|seedream|seedance|seededit|imagegen|image[-_.]?generation|gpt[-_.]?image|dall[-_.]?e|stable[-_.]?diffusion|video[-_.]?generation|cogvideo|tts|asr|whisper|transcription|transcribe|moderation|realtime|3d)([-_./]|$)/i.test(id);
}

function providerDirectoryModelApi(provider = {}, entry = {}, remoteModel = {}, exact = null, fallback = null) {
  if (provider.id === "volcengine") {
    const baseUrl = String(provider.baseUrl || entry.baseUrl || "").trim().replace(/\/+$/, "");
    const modelId = String(remoteModel.id || "").trim().toLowerCase();
    if (/\/api\/coding\/v3$/i.test(baseUrl) || /^(?:glm-5\.2|glm-latest)$/i.test(modelId)) {
      return "responses";
    }
  }
  return provider.api || exact?.api || fallback?.api || "chat_completions";
}

function providerDirectoryModelDisplayName(provider = {}, remoteModel = {}, upstreamModel = "") {
  const explicit = String(remoteModel.displayName || "").trim();
  if (explicit && explicit.toLowerCase() !== String(upstreamModel).trim().toLowerCase()) {
    return explicit;
  }
  if (provider.id === "volcengine") {
    return readableVolcanoModelName(upstreamModel);
  }
  return `${provider.shortName || provider.name || provider.id || "Model"} ${upstreamModel}`.trim();
}

function readableVolcanoModelName(upstreamModel) {
  const raw = String(upstreamModel || "").trim();
  if (!raw) {
    return "Volcano Ark Model";
  }
  if (/^ep[-_]/i.test(raw)) {
    return `Ark Endpoint ${raw.slice(3)}`;
  }

  let core = raw;
  let releaseDate = "";
  const dateMatch = core.match(/[-_](\d{2})(\d{2})(\d{2})$/);
  if (dateMatch) {
    releaseDate = `20${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
    core = core.slice(0, -dateMatch[0].length);
  }

  const sourceTokens = core.split(/[-_]+/).filter(Boolean);
  const tokens = [];
  for (let index = 0; index < sourceTokens.length; index += 1) {
    const token = sourceTokens[index];
    if (/^\d+$/.test(token) && /^\d+$/.test(sourceTokens[index + 1] || "")) {
      const versionParts = [token];
      while (/^\d+$/.test(sourceTokens[index + 1] || "")) {
        versionParts.push(sourceTokens[index + 1]);
        index += 1;
      }
      tokens.push(versionParts.join("."));
      continue;
    }
    if (/^\d+k$/i.test(token) || /^\d+b$/i.test(token)) {
      tokens.push(token.toUpperCase());
      continue;
    }
    if (/^v\d+(?:\.\d+)+$/i.test(token)) {
      tokens.push(`v${token.slice(1)}`);
      continue;
    }
    tokens.push(token.toLowerCase() === "glm"
      ? "GLM"
      : token.charAt(0).toUpperCase() + token.slice(1));
  }
  const readable = tokens.join(" ") || raw;
  return releaseDate ? `${readable} · ${releaseDate}` : readable;
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
    const normalized = normalizeSelection(rootDir, saved.selectedModelIds, mode);
    return normalized.length ? normalized : fallbackSelectedModelIds(rootDir, mode);
  }
  return fallbackSelectedModelIds(rootDir, mode);
}

export function saveSelection(rootDir, selectedModelIds, mode = MODE_HYBRID) {
  const normalized = normalizeSelection(rootDir, selectedModelIds, mode);
  const selected = normalized.length ? normalized : fallbackSelectedModelIds(rootDir, mode);
  const target = selectionPath(rootDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    `${JSON.stringify({ selectedModelIds: selected }, null, 2)}\n`,
    "utf8",
  );
  return selected;
}

export function readCustomModels(rootDir) {
  const saved = readJsonIfExists(customModelsPath(rootDir), []);
  return Array.isArray(saved)
    ? saved
      .map(normalizeSavedCustomModel)
      .filter(Boolean)
      .filter((model) => !isRouterControlEnvName(model?.keyEnv || model?.apiKeyEnv))
    : [];
}

export function buildProviderLogoCandidate(rootDir, ownerId, sourcePath) {
  const id = slugify(String(ownerId || "provider").trim()) || "provider";
  const source = String(sourcePath || "").trim();
  const bytes = readProviderLogoFileSafely(source);
  const extension = providerLogoExtension(source);
  const target = path.join(rootDir, "config", "provider-logos", `${id}${extension}`);
  assertManagedProviderLogoPath(rootDir, target, { allowMissingTarget: true });
  return {
    source,
    target,
    logoUrl: pathToFileURL(target).href,
    bytes,
  };
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
  timeoutMs = PROVIDER_MODEL_DIRECTORY_TIMEOUT_MS,
} = {}) {
  const result = await fetchProviderModelDirectoryCandidate(rootDir, providerId, {
    fetchImpl,
    now,
    timeoutMs,
  });
  if (!result.ok) {
    return result;
  }
  if (!providerModelRefreshIsCurrent(rootDir, result.providerId, result)) {
    return modelDirectoryRefreshFailure(
      result.providerId,
      "A newer provider model directory refresh superseded this request.",
      readModelDirectory(rootDir).providers[result.providerId] || null,
    );
  }
  const currentFingerprint = providerModelDirectoryFingerprint(rootDir, result.providerId);
  if (currentFingerprint !== result.providerFingerprint) {
    return modelDirectoryRefreshFailure(
      result.providerId,
      "Provider settings changed while the remote model directory was loading.",
      readModelDirectory(rootDir).providers[result.providerId] || null,
    );
  }
  const directory = readModelDirectory(rootDir);
  const entry = providerModelDirectoryEntry(result);
  directory.providers[result.providerId] = entry;
  writeJsonAtomic(modelDirectoryPath(rootDir), directory);
  completeProviderModelRefresh(result);
  return result;
}

export async function fetchProviderModelDirectoryCandidate(rootDir, providerId, {
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
  timeoutMs = PROVIDER_MODEL_DIRECTORY_TIMEOUT_MS,
} = {}) {
  const id = String(providerId || "").trim();
  const refreshRequest = beginProviderModelRefresh(rootDir, id);
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

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const requestTimeoutMs = Math.max(1, Number(timeoutMs) || PROVIDER_MODEL_DIRECTORY_TIMEOUT_MS);
  let timedOut = false;
  let timeout = null;
  const deadline = new Promise((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller?.abort();
      reject(Object.assign(new Error("Provider model directory request timed out."), {
        code: "provider_model_directory_timeout",
      }));
    }, requestTimeoutMs);
  });

  try {
    const headers = providerApiHeaders(provider, apiKey);
    const requestInit = fetchInitWithProxy(endpoint, {
        method: "GET",
        headers,
        ...(controller ? { signal: controller.signal } : {}),
      });
    const response = await Promise.race([
      Promise.resolve().then(() => fetchImpl(endpoint, requestInit)),
      deadline,
    ]);
    if (!response?.ok) {
      throw new Error(`HTTP ${response?.status || 0}: provider model directory request failed.`);
    }
    const body = await Promise.race([
      readProviderConnectionBody(response, {
        maxBytes: DEFAULT_CAPABILITY_PROVIDER_RESPONSE_MAX_BYTES,
        signal: controller?.signal,
      }),
      deadline,
    ]);
    if (body.parseError || !providerModelDirectoryBodyLooksValid(body.json)) {
      throw capabilityExecutionError(
        "provider_model_directory_invalid_response",
        "Provider model directory returned invalid JSON or an unsupported response shape.",
      );
    }
    const models = mergeOfficialProviderDirectoryModels(
      provider,
      normalizeProviderModelList(body.json || {}),
    );
    const entry = {
      providerId: id,
      providerName: provider.name || id,
      baseUrl: String(provider.baseUrl || "").trim().replace(/\/+$/, ""),
      endpoint,
      source: "remote",
      fetchedAt: String(now()),
      models,
    };
    return attachProviderModelRefreshRequest({
      ok: true,
      ...entry,
      count: models.length,
      providerFingerprint: providerModelDirectoryFingerprintFromValues(provider, apiKey),
    }, refreshRequest);
  } catch (error) {
    const failure = timedOut || error?.name === "AbortError"
      ? Object.assign(new Error("Provider model directory request timed out."), {
        code: "provider_model_directory_timeout",
      })
      : error;
    return modelDirectoryRefreshFailure(
      id,
      modelDirectoryRefreshErrorMessage(failure, { secretValues: [apiKey] }),
      existing,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function testProviderConnection(rootDir, providerInput, {
  fetchImpl = globalThis.fetch,
} = {}) {
  const provider = resolveConnectionProvider(rootDir, providerInput);
  const providerId = provider?.id || String(providerInput || "").trim();
  const checks = [];
  const addCheck = (id, label, status, message) => {
    checks.push({ id, label, status, message });
  };
  if (!provider) {
    return {
      ok: false,
      providerId,
      error: `Unknown provider: ${providerId}`,
      checks: [
        {
          id: "provider",
          label: "供应商",
          status: "fail",
          message: `没有找到这个供应商：${providerId || "未命名"}`,
        },
      ],
      summary: providerConnectionSummary([
        { status: "fail" },
      ]),
    };
  }
  if ((provider.authMode || "api_key") === "codex_openai") {
    const localChecks = [
      {
        id: "provider",
        label: "供应商",
        status: "warn",
        message: "这是 Codex 订阅模型，使用 Codex 登录态，不走 API Key 模型列表接口。",
      },
    ];
    return {
      ok: false,
      providerId: provider.id,
      error: "Codex subscription providers do not expose an API-key model endpoint.",
      message: "Codex 订阅模型不提供 API Key 连接体检。",
      checks: localChecks,
      summary: providerConnectionSummary(localChecks),
    };
  }
  if (typeof fetchImpl !== "function") {
    const localChecks = [
      {
        id: "runtime",
        label: "运行环境",
        status: "fail",
        message: "当前运行环境没有 fetch，无法发起体检请求。",
      },
    ];
    return {
      ok: false,
      providerId: provider.id,
      error: "fetch is not available in this runtime",
      message: "当前运行环境不支持连接体检。",
      checks: localChecks,
      summary: providerConnectionSummary(localChecks),
    };
  }
  const endpoint = modelDirectoryEndpointForProvider(provider);
  if (!endpoint) {
    const localChecks = [
      {
        id: "base_url",
        label: "Base URL",
        status: "fail",
        message: "Base URL 不是有效的 http/https 地址，无法拼出 /models 体检接口。",
      },
    ];
    return {
      ok: false,
      providerId: provider.id,
      error: "Provider Base URL is invalid.",
      message: "Base URL 无效，请检查供应商地址。",
      checks: localChecks,
      summary: providerConnectionSummary(localChecks),
    };
  }
  addCheck("base_url", "Base URL", "pass", `将请求模型列表接口：${endpoint}`);
  const keyEnv = provider.keyEnv || provider.apiKeyEnv || "";
  const apiKey = String(
    provider.apiKey ||
      (keyEnv ? (loadSecrets(rootDir)[keyEnv] || process.env[keyEnv] || "") : ""),
  ).trim();
  if (providerRequiresApiKey(provider) && !apiKey) {
    addCheck("api_key", "API Key", "fail", `缺少 API Key：${keyEnv || "未配置 Key 名"}`);
    return {
      ok: false,
      providerId: provider.id,
      endpoint,
      error: `缺少 API Key: ${keyEnv} / Missing API key: ${keyEnv}`,
      message: "缺少 API Key，请先填写或保存 Key 后再体检。",
      checks,
      summary: providerConnectionSummary(checks),
    };
  }
  addCheck(
    "api_key",
    "API Key",
    "pass",
    apiKey ? `已带上 ${keyEnv || "API Key"} 请求。` : "这个供应商不需要 API Key。",
  );
  const headers = providerApiHeaders(provider, apiKey);
  try {
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers,
    });
    const ok = Boolean(response?.ok);
    const status = Number(response?.status || 0);
    const body = await readProviderConnectionBody(response, {
      maxBytes: capabilityProviderResponseMaxBytes(provider),
    });
    if (!ok) {
      const friendly = providerConnectionHttpError(status, body.text, provider);
      const rateLimited = providerConnectionIsRateLimited(status, body.text);
      addCheck(
        "quota_permission",
        "额度 / 权限",
        rateLimited ? "warn" : providerConnectionPermissionStatus(status),
        rateLimited
          ? "本次失败是供应商限流，不直接说明 Key、余额或权限错误。"
          : friendly,
      );
      if (rateLimited) {
        addCheck(
          "rate_limit",
          "频率限制",
          "fail",
          friendly,
        );
      }
      return {
        ok: false,
        providerId: provider.id,
        endpoint,
        status,
        message: friendly,
        error: friendly,
        checks,
        summary: providerConnectionSummary(checks),
      };
    }

    addCheck("quota_permission", "额度 / 权限", "pass", "模型列表接口已放行，Key 权限可用。");
    const hasDirectoryShape = providerModelDirectoryBodyLooksValid(body.json);
    const models = hasDirectoryShape ? normalizeProviderModelList(body.json) : [];
    const configuredModels = providerConfiguredModels(rootDir, provider.id);
    const returnedIds = new Set(models.map((model) => model.id));
    const matchedModels = configuredModels.filter((model) => returnedIds.has(model.model));
    addCheck(
      "model_directory",
      "模型列表",
      hasDirectoryShape ? "pass" : body.hasBody ? "fail" : "warn",
      hasDirectoryShape
        ? `模型列表接口返回 ${models.length} 个模型。`
        : body.hasBody
          ? "模型列表接口返回了内容，但格式不是 OpenAI-compatible 的 data/models 数组。"
          : "模型列表接口可访问，但没有返回可解析的模型列表；聊天路由仍可继续使用已配置模型。",
    );
    addCheck(
      "model_name",
      "模型名",
      modelNameCheckStatus(hasDirectoryShape, models.length, configuredModels.length, matchedModels.length),
      modelNameCheckMessage(hasDirectoryShape, configuredModels, matchedModels),
    );
    addCheck(
      "response_format",
      "返回格式",
      hasDirectoryShape ? "pass" : body.hasBody ? "fail" : "warn",
      hasDirectoryShape
        ? "返回格式有效，可用于同步和校验模型名。"
        : body.hasBody
          ? "返回格式无效，无法确认模型名；请检查 Base URL 是否真的是 OpenAI-compatible /v1 地址。"
          : "无法读取返回格式；只确认了 HTTP 连接可用。",
    );
    const summary = providerConnectionSummary(checks, {
      modelCount: models.length,
      configuredModelCount: configuredModels.length,
      matchedModelCount: matchedModels.length,
    });
    const healthy = summary.failed === 0;
    return {
      ok: healthy,
      providerId: provider.id,
      endpoint,
      status,
      message: healthy
        ? `供应商体检通过：模型接口可用，返回 ${models.length} 个模型。`
        : "供应商体检发现问题，请查看下面的检查项。",
      checks,
      summary,
      models,
      ...(healthy ? {} : { error: "供应商返回格式异常，无法可靠读取模型列表。" }),
    };
  } catch (error) {
    const safeError = providerConnectionCaughtError(error);
    addCheck(
      "quota_permission",
      "额度 / 权限",
      "fail",
      safeError,
    );
    return {
      ok: false,
      providerId: provider.id,
      endpoint,
      error: safeError,
      message: safeError,
      checks,
      summary: providerConnectionSummary(checks),
    };
  }
}

async function readProviderConnectionBody(response, options = {}) {
  const maxBytes = positiveProviderResponseBytes(options.maxBytes, DEFAULT_CAPABILITY_PROVIDER_RESPONSE_MAX_BYTES);
  const contentLength = Number.parseInt(responseHeader(response, "content-length"), 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw capabilityExecutionError(
      "provider_response_too_large",
      `Capability provider response is too large: ${contentLength} bytes; limit ${maxBytes} bytes.`,
    );
  }

  let text = "";
  let json = null;
  let parseError = "";
  if (response?.body && typeof response.body.getReader === "function") {
    text = await readBoundedProviderWebStream(response.body, maxBytes, options.signal);
    if (text.trim()) {
      try {
        json = JSON.parse(text);
      } catch (error) {
        parseError = error.message || String(error);
      }
    }
  } else if (response?.body && typeof response.body[Symbol.asyncIterator] === "function") {
    text = await readBoundedProviderAsyncStream(response.body, maxBytes, options.signal);
    if (text.trim()) {
      try {
        json = JSON.parse(text);
      } catch (error) {
        parseError = error.message || String(error);
      }
    }
  } else if (typeof response?.text === "function") {
    text = await response.text();
    const bodyBytes = Buffer.byteLength(text, "utf8");
    if (bodyBytes > maxBytes) {
      throw capabilityExecutionError(
        "provider_response_too_large",
        `Capability provider response is too large: ${bodyBytes} bytes; limit ${maxBytes} bytes.`,
      );
    }
    if (text.trim()) {
      try {
        json = JSON.parse(text);
      } catch (error) {
        parseError = error.message || String(error);
      }
    }
  } else if (typeof response?.json === "function") {
    try {
      json = await response.json();
      text = JSON.stringify(json);
      const bodyBytes = Buffer.byteLength(text, "utf8");
      if (bodyBytes > maxBytes) {
        throw capabilityExecutionError(
          "provider_response_too_large",
          `Capability provider response is too large: ${bodyBytes} bytes; limit ${maxBytes} bytes.`,
        );
      }
    } catch (error) {
      if (error?.code === "provider_response_too_large") {
        throw error;
      }
      parseError = error.message || String(error);
    }
  }
  return {
    text,
    json,
    parseError,
    hasBody: Boolean(text.trim()) || Boolean(json),
  };
}

function capabilityProviderResponseMaxBytes(provider = {}) {
  return positiveProviderResponseBytes(
    provider.maxResponseBytes ||
      provider.max_response_bytes ||
      provider.responseMaxBytes ||
      provider.response_max_bytes,
    DEFAULT_CAPABILITY_PROVIDER_RESPONSE_MAX_BYTES,
  );
}

function capabilityProviderAssetMaxBytes(provider = {}) {
  return positiveProviderResponseBytes(
    provider.maxAssetBytes ||
      provider.max_asset_bytes ||
      provider.assetMaxBytes ||
      provider.asset_max_bytes,
    DEFAULT_CAPABILITY_ASSET_MAX_BYTES,
  );
}

function positiveProviderResponseBytes(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function providerConnectionSummary(checks = [], extra = {}) {
  const summary = {
    passed: 0,
    warned: 0,
    failed: 0,
    modelCount: 0,
    configuredModelCount: 0,
    matchedModelCount: 0,
    ...extra,
  };
  for (const check of checks) {
    if (check?.status === "pass") {
      summary.passed += 1;
    } else if (check?.status === "warn") {
      summary.warned += 1;
    } else if (check?.status === "fail") {
      summary.failed += 1;
    }
  }
  return summary;
}

function providerModelDirectoryBodyLooksValid(body) {
  return Array.isArray(body) || Array.isArray(body?.data) || Array.isArray(body?.models);
}

function providerConfiguredModels(rootDir, providerId) {
  return modelCatalog(rootDir)
    .filter((model) => model.providerId === providerId)
    .map((model) => ({
      displayName: model.displayName || model.name || model.model,
      model: String(model.model || "").trim(),
    }))
    .filter((model) => model.model);
}

function modelNameCheckStatus(hasDirectoryShape, modelCount, configuredCount, matchedCount) {
  if (!hasDirectoryShape) {
    return "warn";
  }
  if (!configuredCount || !modelCount) {
    return "warn";
  }
  return matchedCount > 0 ? "pass" : "warn";
}

function modelNameCheckMessage(hasDirectoryShape, configuredModels, matchedModels) {
  if (!hasDirectoryShape) {
    return "模型列表格式不可用，暂时无法校验模型名。";
  }
  if (!configuredModels.length) {
    return "这个供应商还没有配置模型。";
  }
  if (!matchedModels.length) {
    return "没有在远程模型列表里匹配到当前配置的模型；如果供应商不完整公开模型列表，聊天仍可能可用。";
  }
  const names = matchedModels.slice(0, 3).map((model) => model.model).join("、");
  const suffix = matchedModels.length > 3 ? ` 等 ${matchedModels.length} 个` : "";
  return `已匹配当前配置模型：${names}${suffix}。`;
}

function providerConnectionPermissionStatus(status) {
  if (status === 401 || status === 402 || status === 403 || status === 429) {
    return "fail";
  }
  if (status >= 500) {
    return "warn";
  }
  return "fail";
}

function providerConnectionIsRateLimited(status, bodyText = "") {
  const body = providerErrorBodySnippet(bodyText).toLowerCase();
  return status === 429 || /rate[_\s-]?limit|too many requests|throttle|限流|频率/.test(body);
}

function providerErrorBodySnippet(bodyText) {
  const raw = String(bodyText || "").trim();
  if (!raw) {
    return "";
  }
  const looksLikeHtml = /<!doctype|<\/?[a-z][\s\S]*>/i.test(raw);
  let text = raw;
  if (looksLikeHtml) {
    const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
    text = title || raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ");
  }
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function providerConnectionHttpError(status, bodyText, provider = {}) {
  const body = providerErrorBodySnippet(bodyText);
  const haystack = `${status} ${body}`.toLowerCase();
  const providerName = provider.name || provider.id || "供应商";
  if (status === 401 || /invalid[_\s-]?api[_\s-]?key|incorrect api key|unauthorized/.test(haystack)) {
    return `${providerName} API Key 无效或已过期：HTTP ${status || 0}`;
  }
  if (status === 402 || /insufficient[_\s-]?quota|quota|balance|余额|额度/.test(haystack)) {
    return `${providerName} 余额不足或额度已用完：HTTP ${status || 0}`;
  }
  if (status === 403 || /permission|forbidden|not allowed|无权限|未授权/.test(haystack)) {
    return `${providerName} Key 权限不足或模型未授权：HTTP ${status || 0}`;
  }
  if (status === 429 || /rate[_\s-]?limit|too many requests|限流/.test(haystack)) {
    return `${providerName} 正在限流，请稍后再试：HTTP ${status || 0}`;
  }
  if (status === 404) {
    return `${providerName} 的模型列表接口不存在，请检查 Base URL 是否应该带 /v1：HTTP 404`;
  }
  if (status >= 500) {
    return `${providerName} 服务异常或网关错误：HTTP ${status || 0}`;
  }
  return `${providerName} 连接失败：HTTP ${status || 0}`;
}

function providerConnectionCaughtError(error = {}) {
  if (error?.code === "provider_response_too_large") {
    return "供应商响应超过安全大小限制，连接体检已停止。";
  }
  if (error?.code === "provider_model_directory_timeout" || error?.name === "AbortError") {
    return "供应商连接请求超时，请稍后重试。";
  }
  return "供应商连接请求失败，请检查网络、代理和供应商地址后重试。";
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

const IMAGE_PROVIDER_ADAPTERS = new Set([
  "openai_images",
  "siliconflow_images",
  "zai_images",
  "generic_template",
]);

export function readCapabilityProviderConfig(rootDir) {
  const saved = readJsonIfExists(capabilityProvidersPath(rootDir), {});
  const providersSource = Array.isArray(saved?.providers)
    ? saved.providers
    : Array.isArray(saved)
      ? saved
      : [];
  const providers = providersSource
    .map((provider) => {
      try {
        return normalizeCustomCapabilityProvider(provider);
      } catch {
        try {
          return normalizeCustomCapabilityProvider(sanitizeLegacyProviderCredentials(provider));
        } catch {
          return null;
        }
      }
    })
    .filter(Boolean);
  const defaults = capabilityProviderDefaultsForProviders(providers, saved?.defaults || saved?.defaultProviderIds);
  return {
    version: 1,
    defaults,
    providers,
  };
}

export function saveCapabilityProvider(rootDir, input = {}) {
  const config = readCapabilityProviderConfig(rootDir);
  const provider = normalizeCustomCapabilityProvider(input);
  const providers = config.providers.filter((item) => item.id !== provider.id);
  providers.push(provider);
  const defaults = {
    ...config.defaults,
  };
  if (input.makeDefault || provider.enabled !== false) {
    for (const capability of provider.capabilities) {
      if (input.makeDefault || !defaults[capability]) {
        defaults[capability] = provider.id;
      }
    }
  }
  return writeCapabilityProviderConfig(rootDir, { providers, defaults }).providers.find((item) => item.id === provider.id);
}

export function saveCapabilityProviderTestResult(rootDir, providerId, result = {}) {
  const id = String(providerId || "").trim();
  if (!id) {
    return null;
  }
  const config = readCapabilityProviderConfig(rootDir);
  let saved = null;
  const providers = config.providers.map((provider) => {
    if (provider.id !== id) {
      return provider;
    }
    saved = {
      ...provider,
      lastTest: normalizeImageProviderTestResult(result),
    };
    return saved;
  });
  if (!saved) {
    return null;
  }
  writeCapabilityProviderConfig(rootDir, {
    providers,
    defaults: config.defaults,
  });
  return saved.lastTest;
}

export async function testCapabilityProviderConnection(rootDir, input = {}, options = {}) {
  const startedAt = Date.now();
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : globalThis.fetch;
  const provider = capabilityProviderForTest(rootDir, input);
  const checks = [];
  const checkEntry = (id, label, status, detail = "") => ({
      id,
      label,
      status,
      ...(detail ? { detail, message: detail } : {}),
    });
  const addCheck = (id, label, status, detail = "") => {
    checks.push(checkEntry(id, label, status, detail));
  };
  const setCheck = (id, label, status, detail = "") => {
    const next = checkEntry(id, label, status, detail);
    const index = checks.findIndex((check) => check.id === id);
    if (index >= 0) {
      checks[index] = next;
      return;
    }
    checks.push(next);
  };

  if (!provider) {
    addCheck("provider", "供应商配置", "fail", "没有找到可测试的能力供应商。");
    return capabilityProviderTestResult({
      ok: false,
      providerId: "",
      message: "能力供应商配置不完整，无法体检。",
      checks,
      startedAt,
    });
  }

  const capability = provider.capability || provider.capabilities?.[0] || "";
  const adapter = String(provider.adapter || "generic_http").trim();
  addCheck("capability", "能力类型", capability ? "pass" : "fail", capabilityProviderCapabilityName(capability));
  if (provider.enabled === false) {
    addCheck("enabled", "启用状态", "warn", "这个供应商当前停用；体检只验证配置，不会自动启用。");
  }

  if (adapter === "local_browser" || adapter === "local_file" || adapter === "local_computer_use") {
    addCheck("adapter", "接口模式", "pass", `${capabilityProviderAdapterName(adapter)} 已配置。`);
    if (typeof options.localCapabilityExecutor === "function") {
      try {
        const localResult = await options.localCapabilityExecutor({
          adapter,
          capability,
          provider,
          request: {
            capability,
            input: { action: "diagnose" },
          },
          rootDir,
        });
        addCheck("executor", "桌面执行器", "pass", "已接入本地桌面执行器。");
        const supportedActions = Array.isArray(localResult?.supportedActions)
          ? localResult.supportedActions.map((item) => String(item || "").trim()).filter(Boolean)
          : [];
        if (supportedActions.length) {
          addCheck("actions", "支持动作", "pass", supportedActions.join("、"));
        }
        return capabilityProviderTestResult({
          ok: checks.every((check) => check.status !== "fail"),
          providerId: provider.id,
          provider,
          endpoint: "",
          message: "本地能力体检通过；桌面执行器已接入。",
          checks,
          startedAt,
        });
      } catch (error) {
        addCheck(
          "executor",
          "桌面执行器",
          "fail",
          error?.message || "本地桌面执行器未接入或不可用。",
        );
        return capabilityProviderTestResult({
          ok: false,
          providerId: provider.id,
          provider,
          endpoint: "",
          message: "本地能力体检失败；桌面执行器未接入或不可用。",
          error: error?.message || String(error),
          checks,
          startedAt,
        });
      }
    }
    addCheck("executor", "桌面执行器", "warn", "当前环境没有暴露本地执行器；请在桌面端里测试。");
    return capabilityProviderTestResult({
      ok: checks.every((check) => check.status !== "fail"),
      providerId: provider.id,
      provider,
      endpoint: "",
      message: "本地能力配置已通过；桌面执行器未在当前环境暴露。",
      checks,
      startedAt,
    });
  }

  if (adapter !== "generic_http") {
    addCheck("adapter", "接口模式", "fail", `暂不支持测试这个接口模式：${adapter}`);
    return capabilityProviderTestResult({
      ok: false,
      providerId: provider.id,
      provider,
      message: "能力供应商接口模式暂不支持体检。",
      checks,
      startedAt,
    });
  }
  setCheck("adapter", "接口模式", "pass", `${capabilityProviderAdapterName(adapter)} 已配置。`);

  if (typeof fetchImpl !== "function") {
    addCheck("runtime", "运行环境", "fail", "当前运行环境没有 fetch，无法发起体检请求。");
    return capabilityProviderTestResult({
      ok: false,
      providerId: provider.id,
      provider,
      message: "当前环境不支持能力体检。",
      checks,
      startedAt,
    });
  }

  const endpoint = capabilityProviderTestEndpoint(provider);
  if (!endpoint) {
    addCheck("base_url", "Base URL / Endpoint", "fail", "Base URL 或 Endpoint 无法拼成有效 http/https 地址。");
    return capabilityProviderTestResult({
      ok: false,
      providerId: provider.id,
      provider,
      message: "能力供应商地址无效，请检查 Base URL 和 Endpoint。",
      checks,
      startedAt,
    });
  }
  addCheck("base_url", "Base URL / Endpoint", "pass", `将请求 ${endpoint}`);

  const keyEnv = provider.apiKeyEnv || provider.keyEnv || "";
  const apiKey = String(
    provider.apiKey ||
      (keyEnv ? (loadSecrets(rootDir)[keyEnv] || process.env[keyEnv] || "") : ""),
  ).trim();
  if (keyEnv && !apiKey) {
    addCheck("api_key", "API Key", "fail", `缺少 ${keyEnv}，请先填写或保存 Key。`);
    return capabilityProviderTestResult({
      ok: false,
      providerId: provider.id,
      provider,
      endpoint,
      message: "缺少 API Key，请先填写或保存 Key 后再体检。",
      checks,
      startedAt,
    });
  }
  addCheck(
    "api_key",
    "API Key",
    "pass",
    apiKey ? `已带上 ${keyEnv || "API Key"} 请求。` : "这个供应商未配置 Key 名，按无需 Key 测试。",
  );

  const modelName = String(provider.model || "").trim();
  setCheck(
    "model_name",
    "模型名",
    modelName ? "warn" : "warn",
    modelName
      ? `将使用模型名 ${modelName} 发起能力测试；是否可用要看供应商返回。`
      : "未配置模型名；如果这个能力接口不需要 model 字段，可以忽略。",
  );

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const payload = {
    capability,
    input: String(options.input || "ping").trim() || "ping",
    ...(provider.model ? { model: provider.model } : {}),
    test: true,
  };

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const status = Number(response?.status || 0);
    const body = await readProviderConnectionBody(response, {
      maxBytes: capabilityProviderResponseMaxBytes(provider),
    });
    if (!response?.ok) {
      const friendly = capabilityProviderHttpError(status, body.text, provider);
      const modelFailure = capabilityProviderModelError(status, body.text, provider);
      const rateLimited = providerConnectionIsRateLimited(status, body.text);
      const friendlyWithRetry = rateLimited
        ? capabilityProviderRateLimitDetail(friendly, providerRetryAfterHeader(response))
        : friendly;
      setCheck(
        "quota_permission",
        "额度 / 权限",
        rateLimited ? "warn" : (modelFailure ? "warn" : providerConnectionPermissionStatus(status)),
        rateLimited
          ? capabilityProviderRateLimitDetail(
            "供应商返回频率限制，本次失败不直接说明 Key、余额或权限错误；请稍后再试。",
            providerRetryAfterHeader(response),
          )
          : (modelFailure ? "供应商已响应，但失败更像是模型名或能力参数问题；请先检查模型名和接口参数。" : friendlyWithRetry),
      );
      setCheck(
        "rate_limit",
        "频率限制",
        rateLimited ? "fail" : "pass",
        rateLimited ? friendlyWithRetry : "没有检测到供应商频率限制。",
      );
      if (modelFailure) {
        setCheck(
          "model_name",
          "模型名",
          "fail",
          `供应商不接受模型名 ${modelName || "未配置"}：HTTP ${status || 0}`,
        );
      }
      addCheck("request", "请求供应商", providerConnectionPermissionStatus(status), friendlyWithRetry);
      setCheck(
        "response_format",
        "返回格式",
        body.parseError ? "fail" : "warn",
        body.parseError ? "供应商返回的错误内容不是有效 JSON。" : "请求没有通过，暂时无法确认返回格式。",
      );
      return capabilityProviderTestResult({
        ok: false,
        providerId: provider.id,
        provider,
        endpoint,
        status,
        message: friendlyWithRetry,
        error: friendlyWithRetry,
        checks,
        startedAt,
      });
    }

    addCheck("request", "请求供应商", "pass", `HTTP ${status || 200}，测试接口已响应。`);
    setCheck("rate_limit", "频率限制", "pass", "没有检测到供应商频率限制。");
    setCheck("quota_permission", "额度 / 权限", "pass", "测试接口已放行，Key 权限和额度没有被供应商拒绝。");
    setCheck(
      "model_name",
      "模型名",
      modelName ? "pass" : "warn",
      modelName
        ? `供应商接受了模型名 ${modelName}。`
        : "测试接口按无模型名请求通过；如果真实接口需要 model 字段，请补上模型名。",
    );
    const validBody = body.json && typeof body.json === "object" && !Array.isArray(body.json);
    setCheck(
      "response_format",
      "返回格式",
      validBody ? "pass" : "fail",
      validBody
        ? "返回的是 JSON 对象，可作为能力接口响应继续解析。"
        : body.parseError ? "供应商返回的内容不是有效 JSON。" : "返回不是 JSON 对象，请检查测试 Endpoint 是否返回结构化结果。",
    );

    return capabilityProviderTestResult({
      ok: validBody,
      providerId: provider.id,
      provider,
      endpoint,
      status,
      response: body.json,
      message: validBody
        ? "能力供应商体检通过。"
        : "能力供应商已响应，但返回格式不适合 CodexBridge 解析。",
      checks,
      startedAt,
    });
  } catch (error) {
    const safeError = providerConnectionCaughtError(error);
    setCheck(
      "quota_permission",
      "额度 / 权限",
      "fail",
      safeError,
    );
    addCheck("request", "请求供应商", "fail", safeError);
    return capabilityProviderTestResult({
      ok: false,
      providerId: provider.id,
      provider,
      endpoint,
      message: safeError,
      error: safeError,
      checks,
      startedAt,
    });
  }
}

export async function executeCapabilityProvider(rootDir, input = {}, options = {}) {
  const request = normalizeCapabilityExecutionRequest(input);
  const capability = request.capability;
  const providers = capabilityProvidersForExecution(rootDir, request);
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : globalThis.fetch;
  const context = {
    rootDir,
    requestId: request.requestId || "",
    sourceModel: request.sourceModel || "",
  };

  const result = await runCapabilityProxy({
    capability,
    providers,
    request,
    context,
    selectProvider: ({ capability: targetCapability, request: currentRequest }) => {
      if (!targetCapability) {
        throw capabilityExecutionError("missing_capability", "能力类型不能为空，请先选择要执行的能力。");
      }
      const registry = createCapabilityProviderRegistry(providers);
      const provider = registry.select(targetCapability, currentRequest);
      if (!provider) {
        throw capabilityExecutionError(
          "provider_not_configured",
          `没有为 ${capabilityProviderCapabilityName(targetCapability)} 配置已启用的能力供应商。`,
        );
      }
      return provider;
    },
    execute: ({ capability: targetCapability, provider, request: currentRequest }) =>
      executeGenericCapabilityProvider(rootDir, provider, currentRequest, {
        capability: targetCapability,
        fetchImpl,
        localCapabilityExecutor: options.localCapabilityExecutor,
      }),
    saveResult: ({ capability: targetCapability, provider, request: currentRequest, upstream }) =>
      saveCapabilityExecutionResult(rootDir, {
        capability: targetCapability,
        provider,
        request: currentRequest,
        upstream,
        fetchImpl,
      }),
    buildResponse: ({ capability: targetCapability, provider, upstream, savedResult, durationMs }) => ({
      type: "capability.execution",
      capability: targetCapability,
      providerId: provider.id,
      providerName: provider.displayName || provider.name || provider.id,
      endpoint: capabilityProviderTestEndpoint(provider),
      durationMs,
      output_text: capabilityExecutionOutputText(upstream, savedResult, targetCapability),
      data: upstream,
      ...(savedResult?.localPath ? { localPath: savedResult.localPath } : {}),
      ...(savedResult?.mimeType ? { mimeType: savedResult.mimeType } : {}),
      ...(savedResult?.sourceUrl ? { sourceUrl: savedResult.sourceUrl } : {}),
      ...(savedResult?.base64 ? { base64: savedResult.base64 } : {}),
    }),
    buildErrorResponse: ({ capability: targetCapability, provider, normalizedError, phase, durationMs }) => ({
      type: "capability.execution.error",
      capability: targetCapability,
      providerId: provider?.id || "",
      providerName: provider?.displayName || provider?.name || provider?.id || "",
      endpoint: provider ? capabilityProviderTestEndpoint(provider) : "",
      durationMs,
      errorPhase: phase,
      output_text: capabilityExecutionErrorMessage(normalizedError, provider, targetCapability),
      error: normalizedError,
    }),
    recordHistory: (payload) => recordCapabilityExecutionHistory(
      rootDir,
      capabilityExecutionHistoryItemFromRun(payload),
    ),
  });

  const selectedProvider = providers.find((provider) => provider.id === result.providerId) || null;
  return {
    ...result,
    ok: Boolean(result.handled && !result.skipped && !result.failed),
    endpoint: selectedProvider ? capabilityProviderTestEndpoint(selectedProvider) : result.response?.endpoint || "",
    output: result.failed ? null : capabilityExecutionOutput(result.upstream, result.savedResult),
  };
}

function capabilityExecutionHistoryItemFromRun({
  capability,
  provider,
  request,
  context,
  upstream,
  savedResult,
  response,
  durationMs,
  failed = false,
  errorPhase = "",
  normalizedError = null,
} = {}) {
  const upstreamData = upstream && typeof upstream === "object" && !Array.isArray(upstream) ? upstream : {};
  return {
    ok: !failed,
    capability,
    providerId: provider?.id || provider?.providerId || "",
    providerName: provider?.displayName || provider?.name || provider?.id || "",
    sourceModel: context?.sourceModel || request?.sourceModel || "",
    requestId: context?.requestId || request?.requestId || "",
    input: request?.input,
    outputText: response?.output_text || "",
    localPath: savedResult?.localPath || response?.localPath || upstreamData.filePath || "",
    mimeType: savedResult?.mimeType || response?.mimeType || upstreamData.mimeType || "",
    fileName: upstreamData.fileName || "",
    lineCount: upstreamData.lineCount || 0,
    preview: upstreamData.preview || "",
    sourceUrl: savedResult?.sourceUrl || response?.sourceUrl || "",
    durationMs,
    errorCode: normalizedError?.code || "",
    errorPhase,
  };
}

function capabilityProvidersForExecution(rootDir, request = {}) {
  const savedProviders = readCapabilityProviders(rootDir)
    .filter((provider) => provider.source === "capabilityProviders");
  const inlineProvider = capabilityExecutionInlineProvider(rootDir, request);
  if (!inlineProvider) {
    return savedProviders;
  }
  return [
    inlineProvider,
    ...savedProviders.filter((provider) => provider.id !== inlineProvider.id),
  ];
}

function capabilityExecutionInlineProvider(rootDir, request = {}) {
  const source = request?.provider && typeof request.provider === "object" && !Array.isArray(request.provider)
    ? request.provider
    : null;
  if (!source) {
    return null;
  }
  const provider = capabilityProviderForTest(rootDir, source);
  if (!provider) {
    return null;
  }
  return {
    ...provider,
    providerId: provider.id,
    source: "capabilityProviders",
    default: true,
    defaultCapabilities: provider.capabilities,
    enabled: provider.enabled !== false,
  };
}

async function executeGenericCapabilityProvider(rootDir, provider = {}, request = {}, options = {}) {
  const adapter = String(provider.adapter || "generic_http").trim();
  if (adapter === "local_browser" || adapter === "local_file" || adapter === "local_computer_use") {
    if (typeof options.localCapabilityExecutor === "function") {
      const result = await options.localCapabilityExecutor({
        adapter,
        capability: options.capability || request.capability || provider.capability || "",
        provider,
        request,
        rootDir,
      });
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw capabilityExecutionError(
          "invalid_response_format",
          "Local capability executor did not return a JSON object.",
        );
      }
      return {
        ...result,
        local: true,
        adapter,
      };
    }
    throw capabilityExecutionError(
      "local_executor_not_configured",
      `${capabilityProviderAdapterName(adapter)}的本地执行器还未接入。请在桌面端启用对应本地执行器后再试。`,
    );
  }
  if (adapter !== "generic_http") {
    throw capabilityExecutionError(
      "unsupported_adapter",
      `能力供应商模式暂不支持手动执行：${adapter}。`,
    );
  }

  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw capabilityExecutionError("fetch_unavailable", "当前运行环境不能发送能力供应商请求，请升级运行环境或改用桌面端内置执行。");
  }

  const endpoint = capabilityProviderTestEndpoint(provider);
  if (!endpoint) {
    throw capabilityExecutionError("invalid_endpoint", "能力供应商的 Base URL 或 Endpoint 无效，请检查配置。");
  }

  const keyEnv = provider.apiKeyEnv || provider.keyEnv || "";
  const apiKey = String(
    provider.apiKey ||
      (keyEnv ? (loadSecrets(rootDir)[keyEnv] || process.env[keyEnv] || "") : ""),
  ).trim();
  if (keyEnv && !apiKey) {
    throw capabilityExecutionError(
      "missing_api_key",
      `Missing API Key: ${keyEnv}.`,
      { statusCode: 401 },
    );
  }

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(capabilityExecutionPayload(provider, request, options.capability)),
  });
  const status = Number(response?.status || 0);
  const body = await readProviderConnectionBody(response, {
    maxBytes: capabilityProviderResponseMaxBytes(provider),
  });
  if (!response?.ok) {
    throw capabilityExecutionError(
      "provider_http_error",
      capabilityProviderHttpError(status, body.text, provider),
      {
        statusCode: status,
        bodyText: body.text,
        retryAfter: providerRetryAfterHeader(response),
      },
    );
  }
  if (!body.json || typeof body.json !== "object" || Array.isArray(body.json)) {
    throw capabilityExecutionError(
      "invalid_response_format",
      body.parseError || "Capability provider did not return a JSON object.",
      { bodyText: body.text },
    );
  }
  return body.json;
}

async function saveCapabilityExecutionResult(rootDir, input = {}) {
  const capability = String(input.capability || "").trim();
  const source = capabilityAssetSource(capability, input.upstream);
  if (!source) {
    return null;
  }
  const fetchImpl = typeof input.fetchImpl === "function" ? input.fetchImpl : globalThis.fetch;
  const payload = await readCapabilityAssetPayload(source, fetchImpl, {
    maxBytes: capabilityProviderAssetMaxBytes(input.provider),
  });
  if (!payload?.bytes?.length) {
    return null;
  }
  const outputDir = capabilityAssetOutputDir(rootDir, capability);
  const localPath = writeCapabilityAsset(payload.bytes, {
    outputDir,
    capability,
    mimeType: payload.mimeType,
    sourceUrl: source.url,
  });
  if (!localPath) {
    return null;
  }
  const mimeType = payload.mimeType || capabilityAssetDefaultMimeType(capability);
  return {
    capability,
    providerId: input.provider?.id || "",
    providerName: input.provider?.displayName || input.provider?.name || input.provider?.id || "",
    localPath,
    mimeType,
    sourceUrl: source.url || "",
    bytes: payload.bytes.length,
    ...(shouldInlineCapabilityAssetResult(payload.bytes, mimeType) ? { base64: payload.bytes.toString("base64") } : {}),
  };
}

function capabilityAssetSource(capability = "", upstream = {}) {
  if (!upstream || typeof upstream !== "object" || Array.isArray(upstream)) {
    return null;
  }
  const normalizedCapability = String(capability || "").trim();
  const urlKeys = capabilityAssetUrlKeys(normalizedCapability);
  const base64Keys = capabilityAssetBase64Keys(normalizedCapability);
  const base64 = firstStringValue(upstream, base64Keys);
  if (base64) {
    return { base64 };
  }
  const url = firstStringValue(upstream, urlKeys);
  return url ? { url } : null;
}

function capabilityAssetUrlKeys(capability = "") {
  if (capability === "speech") {
    return ["audioUrl", "audio_url", "speechUrl", "speech_url", "url"];
  }
  if (capability === "video") {
    return ["videoUrl", "video_url", "url"];
  }
  if (capability === "webpage_screenshot" || capability === "image_generation") {
    return ["imageUrl", "image_url", "screenshotUrl", "screenshot_url", "url"];
  }
  return ["imageUrl", "image_url", "assetUrl", "asset_url"];
}

function capabilityAssetBase64Keys(capability = "") {
  if (capability === "speech") {
    return ["audioBase64", "audio_base64", "base64", "b64_json"];
  }
  if (capability === "video") {
    return ["videoBase64", "video_base64", "base64", "b64_json"];
  }
  return ["imageBase64", "image_base64", "screenshotBase64", "screenshot_base64", "base64", "b64_json"];
}

function firstStringValue(value, keys = []) {
  const wanted = new Set(keys);
  const stack = [value];
  while (stack.length) {
    const current = stack.shift();
    if (!current || typeof current !== "object") {
      continue;
    }
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    for (const [key, item] of Object.entries(current)) {
      if (wanted.has(key) && typeof item === "string" && item.trim()) {
        return item.trim();
      }
      if (item && typeof item === "object") {
        stack.push(item);
      }
    }
  }
  return "";
}

async function readCapabilityAssetPayload(source = {}, fetchImpl, options = {}) {
  const maxBytes = positiveProviderResponseBytes(options.maxBytes, DEFAULT_CAPABILITY_ASSET_MAX_BYTES);
  if (source.base64) {
    const parsed = parseCapabilityBase64(source.base64);
    const bytes = Buffer.from(parsed.base64, "base64");
    assertCapabilityAssetWithinLimit(bytes.length, maxBytes);
    return {
      bytes,
      mimeType: parsed.mimeType || "",
    };
  }
  const url = String(source.url || "").trim();
  if (!url) {
    return null;
  }
  if (url.startsWith("data:")) {
    const parsed = parseCapabilityDataUrl(url);
    const bytes = Buffer.from(parsed.base64, "base64");
    assertCapabilityAssetWithinLimit(bytes.length, maxBytes);
    return {
      bytes,
      mimeType: parsed.mimeType || "",
    };
  }
  if (typeof fetchImpl !== "function") {
    return null;
  }
  let parsedUrl = null;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return null;
  }
  const response = await fetchImpl(url);
  if (!response?.ok) {
    throw capabilityExecutionError(
      "asset_download_failed",
      `能力结果下载失败：HTTP ${response?.status || 0}。`,
      { statusCode: Number(response?.status || 0) },
    );
  }
  const contentLength = Number.parseInt(responseHeader(response, "content-length"), 10);
  if (Number.isFinite(contentLength)) {
    assertCapabilityAssetWithinLimit(contentLength, maxBytes);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  assertCapabilityAssetWithinLimit(bytes.length, maxBytes);
  return {
    bytes,
    mimeType: responseHeader(response, "content-type").split(";")[0].trim(),
  };
}

function assertCapabilityAssetWithinLimit(bytes, maxBytes) {
  if (Number.isFinite(bytes) && bytes > maxBytes) {
    throw capabilityExecutionError(
      "asset_too_large",
      `Capability result asset is too large: ${bytes} bytes; limit ${maxBytes} bytes.`,
    );
  }
}

function parseCapabilityBase64(value = "") {
  const text = String(value || "").trim();
  return text.startsWith("data:") ? parseCapabilityDataUrl(text) : { base64: text, mimeType: "" };
}

function parseCapabilityDataUrl(value = "") {
  const match = String(value || "").match(/^data:([^;,]+)?;base64,(.+)$/s);
  if (!match) {
    throw capabilityExecutionError("invalid_asset_data", "Capability provider returned an invalid data URL.");
  }
  return {
    mimeType: match[1] || "",
    base64: match[2] || "",
  };
}

function responseHeader(response, name) {
  const headers = response?.headers;
  if (!headers) {
    return "";
  }
  if (typeof headers.get === "function") {
    return String(headers.get(name) || "");
  }
  return String(headers[name] || headers[String(name).toLowerCase()] || "");
}

function capabilityAssetOutputDir(rootDir, capability = "") {
  if (capability === "webpage_screenshot" || capability === "image_generation") {
    return imageOutputDirPath(rootDir);
  }
  return path.join(rootDir, "generated-capability-assets");
}

function writeCapabilityAsset(bytes, { outputDir = "", capability = "", mimeType = "", sourceUrl = "" } = {}) {
  const targetDir = String(outputDir || "").trim();
  if (!targetDir || !Buffer.isBuffer(bytes) || !bytes.length) {
    return "";
  }
  const ext = capabilityAssetExtension(mimeType, sourceUrl, capability);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const prefix = String(capability || "capability").replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
  const target = path.resolve(targetDir, `codexbridge-${prefix}-${Date.now()}-${hash}${ext}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return target;
}

function capabilityAssetExtension(mimeType = "", sourceUrl = "", capability = "") {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.includes("jpeg") || mime.includes("jpg")) {
    return ".jpg";
  }
  if (mime.includes("png")) {
    return ".png";
  }
  if (mime.includes("webp")) {
    return ".webp";
  }
  if (mime.includes("gif")) {
    return ".gif";
  }
  if (mime.includes("mpeg") || mime.includes("mp3")) {
    return ".mp3";
  }
  if (mime.includes("wav")) {
    return ".wav";
  }
  if (mime.includes("ogg")) {
    return ".ogg";
  }
  if (mime.includes("mp4")) {
    return ".mp4";
  }
  if (mime.includes("webm")) {
    return ".webm";
  }
  const fromUrl = String(sourceUrl || "").split("?")[0].match(/\.(png|jpe?g|webp|gif|mp3|wav|ogg|m4a|mp4|webm|mov)$/i)?.[0];
  if (fromUrl) {
    return fromUrl.toLowerCase().replace(".jpeg", ".jpg");
  }
  if (capability === "speech") {
    return ".mp3";
  }
  if (capability === "video") {
    return ".mp4";
  }
  return ".png";
}

function capabilityAssetDefaultMimeType(capability = "") {
  if (capability === "speech") {
    return "audio/mpeg";
  }
  if (capability === "video") {
    return "video/mp4";
  }
  return "image/png";
}

function shouldInlineCapabilityAssetResult(bytes, mimeType = "") {
  return Buffer.isBuffer(bytes) &&
    bytes.length > 0 &&
    bytes.length <= HISTORY_INLINE_THUMBNAIL_MAX_BYTES &&
    String(mimeType || "").toLowerCase().startsWith("image/");
}

function normalizeCapabilityExecutionRequest(input = {}) {
  const source = plainObject(input);
  const capability = String(source.capability || source.type || "").trim();
  const providerId = String(
    source.providerId ||
      source.preferredProviderId ||
      source.capabilityProviderId ||
      "",
  ).trim();
  const request = {
    ...source,
    capability,
    input: hasOwn(source, "input")
      ? source.input
      : capabilityExecutionFallbackInput(source),
  };
  if (providerId) {
    request.providerId = providerId;
  }
  if (source.requestId) {
    request.requestId = String(source.requestId).trim();
  }
  if (source.sourceModel) {
    request.sourceModel = String(source.sourceModel).trim();
  }
  if (source.options && typeof source.options === "object" && !Array.isArray(source.options)) {
    request.options = plainObject(source.options);
  }
  return request;
}

function capabilityExecutionFallbackInput(source = {}) {
  if (hasOwn(source, "query")) {
    return source.query;
  }
  if (hasOwn(source, "text")) {
    return source.text;
  }
  if (hasOwn(source, "file")) {
    return source.file;
  }
  if (hasOwn(source, "files")) {
    return source.files;
  }
  if (hasOwn(source, "url")) {
    return source.url;
  }
  if (hasOwn(source, "prompt")) {
    return source.prompt;
  }
  return "";
}

function capabilityExecutionPayload(provider = {}, request = {}, capability = "") {
  const payload = {
    ...plainObject(provider.defaults),
    capability,
    input: request.input,
  };
  if (provider.model) {
    payload.model = provider.model;
  }
  if (request.requestId) {
    payload.requestId = request.requestId;
  }
  if (request.sourceModel) {
    payload.sourceModel = request.sourceModel;
  }
  if (request.options && Object.keys(request.options).length) {
    payload.options = request.options;
  }
  return payload;
}

function capabilityExecutionOutput(upstream, savedResult) {
  if (!savedResult?.localPath) {
    return upstream;
  }
  if (upstream && typeof upstream === "object" && !Array.isArray(upstream)) {
    return {
      ...upstream,
      localPath: savedResult.localPath,
      mimeType: savedResult.mimeType || "",
      sourceUrl: savedResult.sourceUrl || "",
      ...(savedResult.base64 ? { base64: savedResult.base64 } : {}),
    };
  }
  return {
    value: upstream,
    localPath: savedResult.localPath,
    mimeType: savedResult.mimeType || "",
    sourceUrl: savedResult.sourceUrl || "",
    ...(savedResult.base64 ? { base64: savedResult.base64 } : {}),
  };
}

function capabilityExecutionOutputText(upstream, savedResult = null, capability = "") {
  if (savedResult?.localPath) {
    const upstreamText = capabilityExecutionReadableText(upstream);
    const savedText = `${capabilityProviderCapabilityName(capability)}结果已保存到本地：${savedResult.localPath}`;
    return upstreamText ? `${upstreamText}\n${savedText}` : savedText;
  }
  const readableText = capabilityExecutionReadableText(upstream);
  if (readableText) {
    return readableText;
  }
  if (typeof upstream === "string") {
    return upstream.trim();
  }
  if (!upstream || typeof upstream !== "object" || Array.isArray(upstream)) {
    return upstream == null ? "" : String(upstream);
  }
  for (const key of ["output_text", "text", "result", "answer", "content", "summary"]) {
    const value = upstream[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return JSON.stringify(upstream, null, 2);
}

function capabilityExecutionReadableText(upstream) {
  if (typeof upstream === "string") {
    return upstream.trim();
  }
  if (!upstream || typeof upstream !== "object" || Array.isArray(upstream)) {
    return "";
  }
  for (const key of ["output_text", "text", "result", "answer", "content", "summary"]) {
    const value = upstream[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function localActionUnsupportedMessage(providerName, capabilityName, provider = {}, capability = "") {
  const adapter = String(provider?.adapter || "").trim().toLowerCase();
  const normalizedCapability = String(capability || "").trim().toLowerCase();
  if (adapter === "local_browser" || normalizedCapability === "browser" || normalizedCapability === "webpage_screenshot") {
    return `${providerName} 的本地${capabilityName}能力暂不支持这次操作。当前浏览器能力支持 open_url、read_url、screenshot_url，并且请求输入里需要提供 http/https 的 url。`;
  }
  if (adapter === "local_computer_use" || normalizedCapability === "computer_use") {
    return `${providerName} 的本地${capabilityName}能力暂不支持这次操作。当前 Computer Use 本地能力支持 diagnose、list_apps、open_app、screenshot_desktop；完整鼠标、键盘和窗口控制仍需要 Codex 原生 GPT 能力。`;
  }
  if (adapter === "local_file" || normalizedCapability === "file_processing") {
    return `${providerName} 的本地${capabilityName}能力暂不支持这次操作。当前文件处理能力支持 inspect_file、extract_text，并且请求输入里需要提供明确的本地文本文件路径。`;
  }
  return `${providerName} 的本地${capabilityName}能力暂不支持这次操作。请检查能力类型、接口模式和请求输入。`;
}

function capabilityExecutionErrorMessage(error = {}, provider = {}, capability = "") {
  const providerName = provider?.displayName || provider?.name || provider?.id || "能力供应商";
  const capabilityName = capabilityProviderCapabilityName(capability);
  if (error.code === "missing_api_key") {
    return `${providerName} 缺少 API Key，请先保存 Key 后再试。${error.message ? ` ${error.message}` : ""}`.trim();
  }
  if (error.code === "local_executor_not_configured") {
    return `${providerName} 的本地执行器还未接入。请在桌面端启用对应本地执行器后再试。`;
  }
  if (error.code === "local_action_unsupported") {
    return localActionUnsupportedMessage(providerName, capabilityName, provider, capability);
  }
  if (error.code === "provider_not_configured") {
    return "没有找到可用的实验能力供应商，请先在能力页的实验配置里启用或添加一个供应商。";
  }
  if (error.code === "invalid_endpoint") {
    return `${providerName} 的 Base URL 或 Endpoint 无效，请检查配置。`;
  }
  if (error.code === "provider_http_error") {
    return capabilityExecutionHttpErrorMessage(error, providerName, capabilityName);
  }
  if (error.code === "provider_response_too_large") {
    return `${providerName} 返回的${capabilityName}响应过大，CodexBridge 已停止读取，避免卡住或把异常页面写进结果。请调小返回内容、改用文件链接，或提高该能力供应商的 maxResponseBytes 上限。`;
  }
  if (error.code === "asset_too_large") {
    return `${providerName} 返回的${capabilityName}结果文件过大，CodexBridge 已停止下载，避免占用过多内存或磁盘。请调小图片/音频/视频尺寸，改用更小的结果，或提高该能力供应商的 maxAssetBytes 上限。`;
  }
  if (error.code === "asset_download_failed") {
    const status = Number(error.statusCode || 0);
    const statusText = status ? `（HTTP ${status}）` : "";
    return `${providerName} 已返回 ${capabilityName}结果，但结果文件下载失败${statusText}。请检查图片链接是否过期、是否需要权限，或稍后重试。`;
  }
  if (error.code === "invalid_asset_data") {
    return `${providerName} 已返回 ${capabilityName}结果，但结果文件格式无效，CodexBridge 无法保存展示。请检查供应商返回格式。`;
  }
  if (error.code === "invalid_response_format") {
    return `${providerName} 已响应，但返回格式不是 CodexBridge 可解析的 JSON 对象。请检查 Endpoint 是否返回结构化 JSON。`;
  }
  return `${providerName} 执行失败：${error.message || "未知错误"}`;
}

function capabilityExecutionHttpErrorMessage(error = {}, providerName = "能力供应商", capabilityName = "能力") {
  const status = Number(error.statusCode || 0);
  const rawDetail = String(error.detail || error.message || "");
  const detail = rawDetail.toLowerCase();
  if (
    status === 401 ||
    status === 403 ||
    /api[_\s-]?key|invalid[_\s-]?key|incorrect api key|unauthorized|forbidden|permission|auth/.test(detail)
  ) {
    return `${providerName} 的 API Key 不正确或没有权限使用${capabilityName}能力。请检查 Key、权限和该能力是否已开通。`;
  }
  if (status === 402 || /insufficient|quota|balance|credit|余额|额度|欠费/.test(detail)) {
    return `${providerName} 的余额或额度不足，暂时不能执行${capabilityName}能力。请检查账户余额、套餐额度或计费状态。`;
  }
  if (status === 429 || /rate[_\s-]?limit|too many requests|throttle|限流|频率/.test(detail)) {
    const retryHint = capabilityRetryAfterHint(error.retryAfter || rawDetail);
    const retryText = retryHint ? `供应商建议等待 ${retryHint} 后再试。` : "请稍后再试。";
    return `${providerName} 当前请求过快，被供应商限流了。${retryText}也可以换一个可用的${capabilityName}供应商。`;
  }
  if (status === 404 || /model.*not.*found|unknown model|invalid model|模型.*不存在|模型名/.test(detail)) {
    return `${providerName} 的模型名或接口地址不正确。请检查模型名、Base URL 和 Endpoint。`;
  }
  if (status === 413 || /size|resolution|dimension|too large|payload|尺寸|分辨率|过大/.test(detail)) {
    return `${providerName} 不支持当前请求的尺寸或内容大小。请换一个尺寸，或调小输入内容后重试。`;
  }
  if (/moderation|safety|policy|blocked|content_filter|审核|安全|违规/.test(detail)) {
    return `${providerName} 的内容审核拦截了这次${capabilityName}请求。请换一个更安全、明确的输入后再试。`;
  }
  if (status >= 500 && capabilityExecutionHtmlGatewayError(error)) {
    return `${providerName} 返回了 HTML 网关或网页错误（HTTP ${status}）。请检查 Base URL、Endpoint、代理/VPN，或稍后重试供应商服务。`;
  }
  if (status >= 500) {
    return `${providerName} 服务暂时异常或网关错误（HTTP ${status}）。请稍后重试，或切换备用供应商。`;
  }
  const statusText = status ? `HTTP ${status}` : "未知状态";
  return `${providerName} 执行${capabilityName}能力失败：${statusText}。请检查供应商配置后重试。`;
}

function capabilityExecutionHtmlGatewayError(error = {}) {
  const bodyText = String(error.bodyText || error.detail || "");
  if (!bodyText) {
    return false;
  }
  const snippet = providerErrorBodySnippet(bodyText);
  const haystack = `${bodyText} ${snippet}`.toLowerCase();
  return /<!doctype|<html\b|<title\b|bad gateway|html\s*(?:error|错误|网页|页面)|网关|网页/.test(haystack);
}

function capabilityRetryAfterHint(value = "") {
  const text = String(value || "");
  const match = text.match(/retry[_\s-]*after["'\s:=]*(\d+\s*(?:ms|s|sec|secs|second|seconds|秒|分钟|min|mins|minute|minutes)?)/i) ||
    text.match(/(\d+\s*(?:ms|s|sec|secs|second|seconds|秒|分钟|min|mins|minute|minutes))\s*(?:后|later|retry)/i);
  if (match) {
    return capabilityRetryAfterText(match[1]);
  }
  return /^\d+$/.test(text.trim()) ? capabilityRetryAfterText(text) : "";
}

function capabilityRetryAfterText(value = "") {
  const text = String(value || "").replace(/\s+/g, "");
  return /^\d+$/.test(text) ? `${text}s` : text;
}

function capabilityProviderRateLimitDetail(message = "", retryAfter = "") {
  const text = String(message || "").trim();
  const retryHint = capabilityRetryAfterHint(retryAfter);
  if (!retryHint || text.includes(retryHint)) {
    return text;
  }
  return `${text} 供应商建议等待 ${retryHint} 后再试。`;
}

function providerRetryAfterHeader(response = {}) {
  const headers = response?.headers;
  if (!headers || typeof headers.get !== "function") {
    return "";
  }
  return String(headers.get("retry-after") || headers.get("Retry-After") || "").trim();
}

function capabilityExecutionError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  if (extra.statusCode) {
    error.statusCode = extra.statusCode;
  }
  if (extra.bodyText) {
    error.bodyText = extra.bodyText;
  }
  if (extra.retryAfter) {
    error.retryAfter = extra.retryAfter;
  }
  return error;
}

function capabilityProviderForTest(rootDir, input = {}) {
  const raw = typeof input === "string"
    ? { id: input }
    : input?.provider && typeof input.provider === "object" && !Array.isArray(input.provider)
      ? input.provider
      : input;
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const id = String(source.providerId || source.id || "").trim();
  const saved = id
    ? readCapabilityProviderConfig(rootDir).providers.find((provider) => provider.id === id)
    : null;
  const merged = {
    ...(saved || {}),
    ...source,
    id: id || source.id || saved?.id,
  };
  try {
    const provider = normalizeCustomCapabilityProvider(merged);
    if (typeof source.apiKey === "string" && source.apiKey.trim()) {
      provider.apiKey = source.apiKey.trim();
    }
    return provider;
  } catch {
    return null;
  }
}

function capabilityProviderTestEndpoint(provider = {}) {
  const baseUrl = String(provider.baseUrl || "").trim().replace(/\/+$/, "");
  const endpoint = String(provider.endpoint || "").trim();
  if (!baseUrl || !endpoint || !/^https?:\/\//i.test(baseUrl)) {
    return "";
  }
  const target = `${baseUrl}${normalizeEndpoint(endpoint)}`;
  try {
    return new URL(target).toString();
  } catch {
    return "";
  }
}

function capabilityProviderTestResult(input = {}) {
  const checks = Array.isArray(input.checks) ? input.checks : [];
  const summary = providerConnectionSummary(checks);
  const durationMs = Math.max(0, Math.round(Date.now() - Number(input.startedAt || Date.now())));
  return {
    ok: Boolean(input.ok),
    providerId: String(input.providerId || input.provider?.id || "").trim(),
    ...(input.provider ? { provider: capabilityProviderPublicFields(input.provider) } : {}),
    ...(Object.hasOwn(input, "endpoint") ? { endpoint: input.endpoint } : {}),
    ...(Number.isFinite(Number(input.status)) ? { status: Number(input.status) } : {}),
    durationMs,
    message: String(input.message || (input.ok ? "能力供应商体检通过。" : "能力供应商体检失败。")).trim(),
    ...(input.error ? { error: input.error } : {}),
    ...(input.response ? { response: input.response } : {}),
    checks,
    summary,
  };
}

function capabilityProviderPublicFields(provider = {}) {
  return {
    id: provider.id,
    name: provider.name,
    displayName: provider.displayName || provider.name,
    capability: provider.capability || provider.capabilities?.[0] || "",
    capabilities: provider.capabilities || [],
    adapter: provider.adapter || "generic_http",
    ...(provider.model ? { model: provider.model } : {}),
    ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
  };
}

function capabilityProviderCapabilityName(capability) {
  return {
    image_generation: "图片生成",
    ocr: "OCR",
    web_search: "搜索",
    browser: "浏览器",
    computer_use: "Computer Use",
    file_processing: "文件处理",
    webpage_screenshot: "网页截图",
    speech: "语音",
    video: "视频",
  }[capability] || capability || "未知能力";
}

function capabilityProviderAdapterName(adapter) {
  return {
    generic_http: "通用 HTTP 接口",
    local_browser: "本地浏览器能力",
    local_file: "本地文件处理",
    local_computer_use: "本地 Computer Use",
  }[adapter] || adapter || "未知接口";
}

function capabilityProviderHttpError(status, bodyText, provider = {}) {
  return providerConnectionHttpError(status, bodyText, {
    id: provider.id,
    name: provider.displayName || provider.name || provider.id || "能力供应商",
  });
}

function capabilityProviderModelError(status, bodyText, provider = {}) {
  const model = String(provider.model || "").trim().toLowerCase();
  if (!model) {
    return false;
  }
  const text = String(bodyText || "").toLowerCase();
  const statusLooksLikeModelValidation = [400, 404, 422].includes(Number(status || 0));
  if (!statusLooksLikeModelValidation) {
    return false;
  }
  if (text.includes(model)) {
    return true;
  }
  return /model|模型|not[_\s-]?found|does not exist|invalid[_\s-]?model|unknown[_\s-]?model/.test(text);
}

export function saveCapabilityProviderConfig(rootDir, input = {}) {
  return writeCapabilityProviderConfig(rootDir, {
    providers: input.providers || [],
    defaults: input.defaults || input.defaultProviderIds || {},
  });
}

export function removeCapabilityProvider(rootDir, providerId) {
  const id = String(providerId || "").trim();
  const config = readCapabilityProviderConfig(rootDir);
  const providers = config.providers.filter((provider) => provider.id !== id);
  const defaults = {};
  for (const [capability, defaultProviderId] of Object.entries(config.defaults)) {
    if (defaultProviderId !== id) {
      defaults[capability] = defaultProviderId;
    }
  }
  return writeCapabilityProviderConfig(rootDir, { providers, defaults });
}

function writeCapabilityProviderConfig(rootDir, input = {}) {
  const providers = (Array.isArray(input.providers) ? input.providers : [])
    .map(normalizeCustomCapabilityProvider);
  const config = {
    version: 1,
    defaults: capabilityProviderDefaultsForProviders(providers, input.defaults || input.defaultProviderIds),
    providers,
  };
  writeJsonAtomic(capabilityProvidersPath(rootDir), config);
  return config;
}

function capabilityProviderDefaultsForProviders(providers = [], defaults = {}) {
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const result = {};
  for (const [capability, providerId] of Object.entries(plainObject(defaults))) {
    const capabilityId = String(capability || "").trim();
    const id = String(providerId || "").trim();
    const provider = providerById.get(id);
    if (capabilityId && provider?.capabilities?.includes(capabilityId)) {
      result[capabilityId] = id;
    }
  }
  return result;
}

export function readImageProviderConfig(rootDir) {
  const saved = readJsonIfExists(imageProvidersPath(rootDir), {});
  const providersSource = Array.isArray(saved?.providers)
    ? saved.providers
    : Array.isArray(saved)
      ? saved
      : [];
  const providers = providersSource
    .map((provider) => {
      try {
        return normalizeImageProvider(provider);
      } catch {
        try {
          return normalizeImageProvider(sanitizeLegacyProviderCredentials(provider));
        } catch {
          return null;
        }
      }
    })
    .filter(Boolean);
  const providerIds = new Set(providers.map((provider) => provider.id));
  const defaultProviderId = providerIds.has(saved?.defaultProviderId)
    ? saved.defaultProviderId
    : "";
  return {
    version: 1,
    defaultProviderId,
    providers,
  };
}

export function readImageProviders(rootDir) {
  return readImageProviderConfig(rootDir).providers;
}

export function readCapabilityProviders(rootDir, state = null) {
  const imageProviderConfig = state && Object.prototype.hasOwnProperty.call(state, "imageProviderConfig")
    ? state.imageProviderConfig
    : readImageProviderConfig(rootDir);
  const customProviderConfig = state && Object.prototype.hasOwnProperty.call(state, "capabilityProviderConfig")
    ? state.capabilityProviderConfig
    : readCapabilityProviderConfig(rootDir);
  return [
    ...customProviderConfig.providers.map((provider, index) =>
      capabilityProviderFromCustomProvider(provider, {
        defaults: customProviderConfig.defaults,
        index,
      }),
    ),
    ...imageProviderConfig.providers.map((provider, index) =>
      capabilityProviderFromImageProvider(provider, {
        defaultProviderId: imageProviderConfig.defaultProviderId,
        index: index + customProviderConfig.providers.length,
      }),
    ),
  ];
}

export function readCapabilityProviderGroups(rootDir) {
  return groupCapabilityProviders(readCapabilityProviders(rootDir), {
    knownCapabilities: KNOWN_CAPABILITY_PROVIDER_GROUPS,
    includeEmpty: true,
    includeDisabled: true,
  });
}

export function capabilityProviderRegistry(rootDir) {
  return createCapabilityProviderRegistry(readCapabilityProviders(rootDir));
}

export function imageGenerationSettingsForProvider(rootDir, input = {}) {
  const provider = normalizeImageProvider(input);
  const settings = imageGenerationForProvider(provider);
  return {
    ...imageGenerationWithOutputDir(settings, rootDir),
    ...(typeof input.apiKey === "string" && input.apiKey.trim()
      ? { apiKey: input.apiKey.trim() }
      : {}),
  };
}

export function saveImageProvider(rootDir, input = {}) {
  const config = readImageProviderConfig(rootDir);
  const provider = normalizeImageProvider(input);
  const providers = config.providers.filter((item) => item.id !== provider.id);
  providers.push(provider);
  const defaultProviderId =
    input.makeDefault || !config.defaultProviderId
      ? provider.id
      : config.defaultProviderId;
  writeImageProviderConfig(rootDir, { providers, defaultProviderId });
  refreshRouterConfigIfPresent(rootDir);
  return provider;
}

export function saveImageProviderTestResult(rootDir, providerId, result = {}) {
  const id = String(providerId || "").trim();
  if (!id) {
    return null;
  }
  const config = readImageProviderConfig(rootDir);
  let saved = null;
  const providers = config.providers.map((provider) => {
    if (provider.id !== id) {
      return provider;
    }
    saved = {
      ...provider,
      lastTest: normalizeImageProviderTestResult(result),
    };
    return saved;
  });
  if (!saved) {
    return null;
  }
  writeImageProviderConfig(rootDir, {
    providers,
    defaultProviderId: config.defaultProviderId,
  });
  return saved.lastTest;
}

export function saveImageProviderConfig(rootDir, input = {}) {
  const config = writeImageProviderConfig(rootDir, {
    providers: input.providers || [],
    defaultProviderId: input.defaultProviderId || "",
  });
  refreshRouterConfigIfPresent(rootDir);
  return config;
}

export function removeImageProvider(rootDir, providerId) {
  const id = String(providerId || "").trim();
  const config = readImageProviderConfig(rootDir);
  const providers = config.providers.filter((provider) => provider.id !== id);
  const defaultProviderId = config.defaultProviderId === id ? "" : config.defaultProviderId;
  const next = writeImageProviderConfig(rootDir, { providers, defaultProviderId });
  refreshRouterConfigIfPresent(rootDir);
  return next;
}

function writeImageProviderConfig(rootDir, input = {}) {
  const providers = (Array.isArray(input.providers) ? input.providers : [])
    .map(normalizeImageProvider);
  const providerIds = new Set(providers.map((provider) => provider.id));
  const defaultProviderId = providerIds.has(input.defaultProviderId)
    ? input.defaultProviderId
    : "";
  const config = {
    version: 1,
    defaultProviderId,
    providers,
  };
  writeJsonAtomic(imageProvidersPath(rootDir), config);
  return config;
}

function normalizeCustomCapabilityProvider(input = {}) {
  const name = String(input.name || input.displayName || "").trim();
  const id = String(input.id || slugify(`${name || "capability-provider"}`)).trim();
  const capabilities = uniqueCapabilityValues([
    input.capability,
    ...(Array.isArray(input.capabilities) ? input.capabilities : []),
    ...(Array.isArray(input.supports) ? input.supports : []),
  ]);
  if (!id || !name || !capabilities.length) {
    throw new Error("Capability provider requires id, name, and at least one capability.");
  }
  const adapter = String(input.adapter || "generic_http").trim();
  const provider = {
    id,
    name,
    displayName: String(input.displayName || name).trim(),
    kind: "capability_provider",
    source: "capabilityProviders",
    capability: capabilities[0],
    capabilities,
    adapter,
  };
  const baseUrl = String(input.baseUrl || "").trim().replace(/\/+$/, "");
  if (baseUrl) {
    assertCredentialFreeProviderUrl(baseUrl);
    provider.baseUrl = baseUrl;
  }
  const endpoint = String(input.endpoint || "").trim();
  if (endpoint) {
    provider.endpoint = normalizeEndpoint(endpoint);
  }
  const model = String(input.model || "").trim();
  if (model) {
    provider.model = model;
  }
  const apiKeyEnv = providerApiKeyEnv(input.apiKeyEnv);
  if (apiKeyEnv) {
    provider.apiKeyEnv = apiKeyEnv;
  }
  if (input.enabled === false) {
    provider.enabled = false;
  }
  const priority = Number(input.priority);
  if (Number.isFinite(priority)) {
    provider.priority = Math.round(priority);
  }
  const maxResponseBytes = positiveProviderResponseBytes(
    input.maxResponseBytes ||
      input.max_response_bytes ||
      input.responseMaxBytes ||
      input.response_max_bytes,
    0,
  );
  if (maxResponseBytes) {
    provider.maxResponseBytes = maxResponseBytes;
  }
  const maxAssetBytes = positiveProviderResponseBytes(
    input.maxAssetBytes ||
      input.max_asset_bytes ||
      input.assetMaxBytes ||
      input.asset_max_bytes,
    0,
  );
  if (maxAssetBytes) {
    provider.maxAssetBytes = maxAssetBytes;
  }
  const defaults = plainObject(input.defaults);
  if (Object.keys(defaults).length) {
    assertCredentialFreeProviderObject(defaults);
    provider.defaults = defaults;
  }
  const lastTest = normalizeImageProviderTestResult(input.lastTest, { optional: true });
  if (lastTest) {
    provider.lastTest = lastTest;
  }
  return provider;
}

function normalizeImageProvider(input = {}) {
  const name = String(input.name || input.displayName || "").trim();
  const model = String(input.model || "").trim();
  const id = String(input.id || slugify(`${name || "image-provider"}-${model || ""}`)).trim();
  const adapter = String(input.adapter || "openai_images").trim();
  const baseUrl = String(input.baseUrl || "").trim().replace(/\/+$/, "");
  const endpoint = normalizeEndpoint(input.endpoint || "/images/generations");
  const apiKeyEnv = providerApiKeyEnv(
    input.apiKeyEnv || defaultImageProviderKeyEnv(adapter, name),
  );
  if (!id || !name || !model || !baseUrl || !apiKeyEnv) {
    throw new Error("图片供应商需要填写 id、名称、Base URL、模型名和 API Key 环境变量。");
  }
  if (!IMAGE_PROVIDER_ADAPTERS.has(adapter)) {
    throw new Error(`不支持的图片供应商接口模式：${adapter}`);
  }
  assertCredentialFreeProviderUrl(baseUrl);
  const provider = {
    id,
    name,
    adapter,
    baseUrl,
    endpoint,
    model,
    size: hasOwn(input, "size") ? String(input.size || "").trim() : defaultImageProviderSize(adapter),
    apiKeyEnv,
    response: normalizeImageProviderResponse(adapter, input.response),
  };
  if (input.enabled === false) {
    provider.enabled = false;
  }
  const priority = Number(input.priority);
  if (Number.isFinite(priority)) {
    provider.priority = Math.round(priority);
  }
  const maxAssetBytes = positiveProviderResponseBytes(
    input.maxAssetBytes ||
      input.max_asset_bytes ||
      input.assetMaxBytes ||
      input.asset_max_bytes,
    0,
  );
  if (maxAssetBytes) {
    provider.maxAssetBytes = maxAssetBytes;
  }
  const defaults = plainObject(input.defaults);
  if (Object.keys(defaults).length) {
    assertCredentialFreeProviderObject(defaults);
    provider.defaults = defaults;
  }
  const request = normalizeImageProviderRequest(input.request);
  if (Object.keys(request).length) {
    assertCredentialFreeProviderObject(request);
    provider.request = request;
  }
  const headers = normalizeImageProviderHeaders(input.headers);
  if (Object.keys(headers).length) {
    assertCredentialFreeProviderObject(headers);
    provider.headers = headers;
  }
  const lastTest = normalizeImageProviderTestResult(input.lastTest, { optional: true });
  if (lastTest) {
    provider.lastTest = lastTest;
  }
  return provider;
}

function capabilityProviderFromCustomProvider(provider = {}, options = {}) {
  const priority = Number(provider.priority);
  const defaults = plainObject(options.defaults);
  const defaultCapabilities = provider.capabilities.filter((capability) => defaults[capability] === provider.id);
  const bridge = capabilityProviderBridgeInfo(provider);
  return {
    id: provider.id,
    providerId: provider.id,
    name: provider.name,
    displayName: provider.displayName || provider.name,
    kind: provider.kind || "capability_provider",
    source: "capabilityProviders",
    capability: provider.capability || provider.capabilities[0],
    capabilities: provider.capabilities,
    default: defaultCapabilities.length > 0,
    defaultCapabilities,
    enabled: provider.enabled !== false,
    priority: Number.isFinite(priority) ? priority : 0,
    adapter: provider.adapter,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    ...(provider.endpoint ? { endpoint: provider.endpoint } : {}),
    ...(provider.model ? { model: provider.model } : {}),
    ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
    ...(provider.maxResponseBytes ? { maxResponseBytes: provider.maxResponseBytes } : {}),
    ...(provider.maxAssetBytes ? { maxAssetBytes: provider.maxAssetBytes } : {}),
    ...(Object.keys(plainObject(provider.defaults)).length ? { defaults: plainObject(provider.defaults) } : {}),
    index: Number.isFinite(Number(options.index)) ? Number(options.index) : 0,
    ...(provider.lastTest ? { lastTest: provider.lastTest } : {}),
    ...(bridge ? { bridge } : {}),
  };
}

function capabilityProviderFromImageProvider(provider = {}, options = {}) {
  const priority = Number(provider.priority);
  return {
    id: provider.id,
    providerId: provider.id,
    name: provider.name,
    displayName: provider.name,
    kind: "image_provider",
    source: "imageProviders",
    capability: "image_generation",
    capabilities: ["image_generation"],
    default: provider.id === options.defaultProviderId,
    defaultCapabilities: provider.id === options.defaultProviderId ? ["image_generation"] : [],
    enabled: provider.enabled !== false,
    priority: Number.isFinite(priority) ? priority : 0,
    adapter: provider.adapter,
    baseUrl: provider.baseUrl,
    endpoint: provider.endpoint,
    model: provider.model,
    size: provider.size,
    apiKeyEnv: provider.apiKeyEnv,
    ...(Object.keys(plainObject(provider.response)).length ? { response: plainObject(provider.response) } : {}),
    ...(Object.keys(plainObject(provider.request)).length ? { request: plainObject(provider.request) } : {}),
    ...(Object.keys(plainObject(provider.headers)).length ? { headers: plainObject(provider.headers) } : {}),
    ...(provider.maxAssetBytes ? { maxAssetBytes: provider.maxAssetBytes } : {}),
    ...(Object.keys(plainObject(provider.defaults)).length ? { defaults: plainObject(provider.defaults) } : {}),
    index: Number.isFinite(Number(options.index)) ? Number(options.index) : 0,
    ...(provider.lastTest ? { lastTest: provider.lastTest } : {}),
  };
}

function capabilityProviderBridgeInfo(provider = {}) {
  const adapter = String(provider.adapter || "").trim();
  const capabilities = new Set(Array.isArray(provider.capabilities) ? provider.capabilities : []);
  if (adapter === "local_browser") {
    const supportedActions = ["open_url", "read_url"];
    if (capabilities.has("webpage_screenshot")) {
      supportedActions.push("screenshot_url");
    }
    return {
      mode: "local_bridge",
      label: "本地浏览器桥接",
      nativeTool: false,
      safe: true,
      supportedActions,
      requiresDesktopExecutor: capabilities.has("webpage_screenshot"),
      limitation: "这是 CodexBridge 受控浏览器桥接，不是 GPT 原生 Chrome 工具；只处理 http/https，网页截图需要桌面执行器。",
    };
  }
  if (adapter === "local_computer_use") {
    return {
      mode: "local_bridge",
      label: "本地 Computer Use 桥接",
      nativeTool: false,
      safe: true,
      supportedActions: ["diagnose", "list_apps", "open_app", "screenshot_desktop"],
      requiresDesktopExecutor: true,
      requiresGptResponses: true,
      canControlDesktop: false,
      limitation: "这是 CodexBridge 受控桥接，不是完整 Computer Use；只开放诊断、白名单启动应用和截图，不会自动点击、输入或操作窗口。完整 Computer Use 仍需 GPT / OpenAI Responses 路由。",
    };
  }
  if (adapter === "local_file") {
    return {
      mode: "local_bridge",
      label: "本地文件桥接",
      nativeTool: false,
      safe: true,
      supportedActions: ["diagnose", "inspect_file", "extract_text"],
      requiresDesktopExecutor: false,
      limitation: "只读取请求里明确给出的本地文本文件，不扫描目录，也不读取二进制文件。",
    };
  }
  return null;
}

function normalizeImageProviderTestResult(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return options.optional ? null : {
      ok: false,
      status: "fail",
      checkedAt: new Date().toISOString(),
      message: "图片供应商测试失败。",
    };
  }
  const ok = Boolean(input.ok);
  const checkedAt = String(input.checkedAt || input.createdAt || new Date().toISOString()).trim();
  const result = {
    ok,
    status: ok ? "pass" : "fail",
    checkedAt,
  };
  const durationMs = Number(input.durationMs);
  if (Number.isFinite(durationMs) && durationMs >= 0) {
    result.durationMs = Math.round(durationMs);
  }
  const message = String(input.message || input.error?.message || "").trim();
  if (message) {
    result.message = redactSecretText(message).slice(0, 500);
  }
  const localPath = String(input.localPath || input.localImage?.localPath || "").trim();
  if (localPath) {
    result.localPath = localPath;
  }
  if (Array.isArray(input.checks)) {
    result.checks = input.checks
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        id: String(item.id || "").trim(),
        label: String(item.label || "").trim(),
        status: String(item.status || "unknown").trim(),
        ...(String(item.detail || item.message || "").trim()
          ? { detail: redactSecretText(String(item.detail || item.message || "").trim()).slice(0, 500) }
          : {}),
      }))
      .filter((item) => item.id || item.label)
      .slice(0, 12);
  }
  return result;
}

function defaultImageProviderKeyEnv(adapter, name) {
  if (adapter === "siliconflow_images") {
    return "SILICONFLOW_API_KEY";
  }
  if (adapter === "zai_images") {
    return "ZAI_API_KEY";
  }
  if (adapter === "openai_images") {
    return "OPENAI_API_KEY";
  }
  return `${slugifyEnv(name || "IMAGE_GENERATION")}_API_KEY`;
}

function defaultImageProviderSize(adapter) {
  if (adapter === "zai_images") {
    return "1280x1280";
  }
  return "1024x1024";
}

function normalizeImageProviderResponse(adapter, response = {}) {
  const source = response && typeof response === "object" && !Array.isArray(response)
    ? response
    : {};
  const imageUrlPath = String(
    source.imageUrlPath ||
      (adapter === "siliconflow_images" ? "images[0].url" : "") ||
      (adapter === "zai_images" ? "data[0].url" : "") ||
      "data[0].url",
  ).trim();
  const imageBase64Path = String(source.imageBase64Path || "data[0].b64_json").trim();
  return {
    imageUrlPath,
    imageBase64Path,
  };
}

function normalizeImageProviderRequest(request = {}) {
  const source = request && typeof request === "object" && !Array.isArray(request)
    ? request
    : {};
  const template = plainObject(source.template);
  return Object.keys(template).length ? { template } : {};
}

function normalizeImageProviderHeaders(headers = {}) {
  const source = headers && typeof headers === "object" && !Array.isArray(headers)
    ? headers
    : {};
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    const name = String(key || "").trim();
    if (!name || value === undefined || value === null) {
      continue;
    }
    const text = String(value).trim();
    if (text) {
      result[name] = text;
    }
  }
  return result;
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return JSON.parse(JSON.stringify(value));
}

function assertCredentialFreeProviderObject(value) {
  const visit = (entry, fieldName = "") => {
    if (Array.isArray(entry)) {
      for (const item of entry) {
        visit(item, fieldName);
      }
      return;
    }
    if (entry && typeof entry === "object") {
      for (const [key, item] of Object.entries(entry)) {
        const normalizedKey = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
        if (isCredentialFieldName(normalizedKey)) {
          if (typeof item !== "string" || !isApprovedCredentialTemplate(item)) {
            throw embeddedProviderCredentialError();
          }
        }
        visit(item, key);
      }
      return;
    }
    if (typeof entry !== "string") {
      return;
    }
    if (looksLikeEmbeddedProviderCredential(entry)) {
      throw embeddedProviderCredentialError();
    }
    assertCredentialFreeProviderUrl(entry);
  };
  visit(value);
}

function looksLikeEmbeddedProviderCredential(value) {
  const text = String(value || "").trim();
  if (!text || isApprovedCredentialTemplate(text)) {
    return false;
  }
  return /^(?:Bearer|Basic)\s+\S+/i.test(text) ||
    /\bsk-[A-Za-z0-9_-]{6,}\b/.test(text) ||
    /\bAIza[0-9A-Za-z_-]{20,}\b/.test(text) ||
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(text);
}

function assertCredentialFreeProviderUrl(value) {
  const text = String(value || "").trim();
  if (!text) {
    return;
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return;
  }
  if (providerUrlContainsCredential(parsed)) {
    throw embeddedProviderCredentialError();
  }
}

function providerUrlContainsCredential(parsed) {
  if (parsed.username || parsed.password) {
    return true;
  }
  for (const [key, queryValue] of parsed.searchParams) {
    if (isCredentialUrlQueryKey(key) && !isApprovedCredentialTemplate(queryValue)) {
      return true;
    }
  }
  return false;
}

function sanitizeLegacyProviderCredentials(value, fieldName = "") {
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeLegacyProviderCredentials(item, fieldName))
      .filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (
        isCredentialFieldName(key) &&
        (typeof item !== "string" || !isApprovedCredentialTemplate(item))
      ) {
        continue;
      }
      const sanitized = sanitizeLegacyProviderCredentials(item, key);
      if (sanitized !== undefined) {
        result[key] = sanitized;
      }
    }
    return Object.keys(result).length || Object.keys(value).length === 0 ? result : undefined;
  }
  if (typeof value !== "string") {
    return value;
  }
  if (looksLikeEmbeddedProviderCredential(value)) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (providerUrlContainsCredential(parsed)) {
      return undefined;
    }
  } catch {
    // Non-URL strings are validated by their owning normalizer.
  }
  return value;
}

function embeddedProviderCredentialError() {
  const error = new Error("Embedded provider credentials are not allowed; use an API key environment variable.");
  error.code = "embedded_provider_credential";
  return error;
}

function assertSecretValuesAbsentFromConfigArtifacts(secrets = {}, artifacts = []) {
  const values = Object.values(secrets || {})
    .filter((value) => typeof value === "string" && value.length > 0);
  if (!values.length) {
    return;
  }
  for (const value of values) {
    if (artifacts.some((artifact) => configArtifactContainsText(artifact, value))) {
      const error = new Error("A configuration candidate contained a local secret value.");
      error.code = "config_secret_taint";
      throw error;
    }
  }
}

function configArtifactContainsText(value, needle, seen = new WeakSet()) {
  if (typeof value === "string") {
    return value.includes(needle);
  }
  if (Buffer.isBuffer(value)) {
    return value.includes(Buffer.from(needle, "utf8"));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => configArtifactContainsText(item, needle, seen));
  }
  return Object.entries(value).some(([key, item]) =>
    key.includes(needle) || configArtifactContainsText(item, needle, seen)
  );
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function uniqueCapabilityValues(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    result.push(text);
  }
  return result;
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
      try {
        overrides[presetId] = normalizeImageGenerationSettings(
          sanitizeLegacyProviderCredentials(value),
        );
      } catch {
        // Ignore irrecoverably invalid legacy entries instead of blocking startup.
      }
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
  const config = {
    ...buildRouterConfigFromSelection(rootDir, mode),
    configRevision: randomUUID(),
  };
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

export function modelReferenceStatus(rootDir, mode = "") {
  const current = readRouterConfig(rootDir);
  const targetMode = mode || detectModeFromConfig(current);
  const rawSelection = rawSelectedModelIds(rootDir);
  const selectedModelIds = readSelection(rootDir, targetMode);
  const models = modelCatalog(rootDir);
  const modelById = new Map(models.map((model) => [model.presetId, model]));
  const availablePresetIds = new Set(models.map((model) => model.presetId));
  const routes = routesForSelectedModelIds(rootDir, selectedModelIds, models);
  const currentReferenceIds = currentModelReferenceIds(routes);
  const firstRouteId = routes[0]?.id || "";
  const issues = [];

  for (const value of rawSelection) {
    if (!value || availablePresetIds.has(value)) {
      continue;
    }
    const repairedValue = replacementPresetIdForStaleSelection(rootDir, value, selectedModelIds, modelById);
    issues.push(modelReferenceIssue({
      kind: "selection",
      label: "模型选择",
      value,
      repairedValue,
    }));
  }

  const desktopOptions = loadDesktopOptions(rootDir);
  const auxiliaryRouteId = String(desktopOptions.codexAuxiliaryModelId || "").trim();
  if (auxiliaryRouteId && !currentReferenceIds.has(auxiliaryRouteId)) {
    issues.push(modelReferenceIssue({
      kind: "codex_auxiliary",
      label: "辅助任务模型",
      value: auxiliaryRouteId,
      repairedValue: resolveDesktopRouteReference(rootDir, auxiliaryRouteId, routes) || firstRouteId,
    }));
  }

  const smartRouting = normalizeDesktopSmartRouting(desktopOptions.smartRouting);
  for (const key of DESKTOP_SMART_RULE_KEYS) {
    const rule = normalizeDesktopSmartRule(smartRouting.autoSelectRules?.[key]);
    if (!rule.routeId || currentReferenceIds.has(rule.routeId)) {
      continue;
    }
    issues.push(modelReferenceIssue({
      kind: "smart_route",
      label: `${DESKTOP_SMART_RULE_LABELS[key] || key}模型`,
      key,
      value: rule.routeId,
      repairedValue: resolveDesktopRouteReference(rootDir, rule.routeId, routes),
      repairedMode: resolveDesktopRouteReference(rootDir, rule.routeId, routes) ? rule.mode : "auto",
    }));
  }

  const failover = normalizeDesktopSmartFailover(smartRouting.failover);
  failover.routeIds.forEach((routeId, index) => {
    if (!routeId || currentReferenceIds.has(routeId)) {
      return;
    }
    issues.push(modelReferenceIssue({
      kind: "smart_failover",
      label: `失败备用 ${index + 1}`,
      index,
      value: routeId,
      repairedValue: resolveDesktopRouteReference(rootDir, routeId, routes),
    }));
  });

  return {
    ok: issues.length === 0,
    issueCount: issues.length,
    repairAvailable: issues.length > 0,
    mode: targetMode,
    rawSelectedModelIds: rawSelection,
    selectedModelIds,
    routeIds: routes.map((route) => route.id),
    issues,
  };
}

function currentModelReferenceIds(routes = []) {
  const ids = new Set();
  for (const route of routes) {
    for (const value of [route.id, route.sourcePresetId]) {
      const id = String(value || "").trim();
      if (id) {
        ids.add(id);
      }
    }
  }
  return ids;
}

function rawSelectedModelIds(rootDir) {
  const saved = readJsonIfExists(selectionPath(rootDir), null);
  if (!Array.isArray(saved?.selectedModelIds)) {
    return [];
  }
  return [...new Set(
    saved.selectedModelIds
      .map((id) => String(id || "").trim())
      .filter(Boolean),
  )];
}

function routesForSelectedModelIds(rootDir, selectedModelIds = [], models = modelCatalog(rootDir)) {
  const imageGenerationOverrides = readModelImageGenerationOverrides(rootDir);
  const imageProviderConfig = readImageProviderConfig(rootDir);
  return selectedModelIds
    .map((id) => models.find((model) => model.presetId === id))
    .filter(Boolean)
    .map((model, index) =>
      routeForSelectedModel(model, index, imageGenerationOverrides, imageProviderConfig, rootDir),
    );
}

function replacementPresetIdForStaleSelection(rootDir, presetId, selectedModelIds = [], modelById = new Map()) {
  const providerId = providerIdForUnavailableSelection(rootDir, presetId);
  if (!providerId) {
    return selectedModelIds[0] || "";
  }
  return selectedModelIds.find((id) => modelById.get(id)?.providerId === providerId) ||
    selectedModelIds[0] ||
    "";
}

function modelReferenceIssue({
  kind,
  label,
  value,
  repairedValue = "",
  repairedMode = "",
  key = "",
  index = undefined,
}) {
  return {
    kind,
    label,
    key,
    index,
    value: String(value || "").trim(),
    repairedValue: String(repairedValue || "").trim(),
    repairedMode: String(repairedMode || "").trim(),
  };
}

export function repairDesktopModelReferences(rootDir, mode = "") {
  const current = readRouterConfig(rootDir);
  const targetMode = mode || detectModeFromConfig(current);
  const beforeStatus = modelReferenceStatus(rootDir, targetMode);
  const selectedModelIds = saveSelection(rootDir, readSelection(rootDir, targetMode), targetMode);
  const config = current
    ? writeRouterConfigFromSelection(rootDir, targetMode)
    : buildRouterConfigFromSelection(rootDir, targetMode);
  const desktopOptions = loadDesktopOptions(rootDir);
  const profileReferenceRepair = repairConfigProfilesModelReferences(rootDir);
  const afterStatus = modelReferenceStatus(rootDir, targetMode);
  return {
    mode: targetMode,
    selectedModelIds,
    configWritten: Boolean(current),
    codexAuxiliaryModelId: desktopOptions.codexAuxiliaryModelId || "",
    smartRouting: desktopOptions.smartRouting,
    profileReferenceRepairCount: profileReferenceRepair.repairedCount,
    profileReferenceRepair,
    routeIds: (config.models || []).map((route) => route.id).filter(Boolean),
    beforeStatus,
    afterStatus,
  };
}

async function readBoundedProviderWebStream(body, maxBytes, signal) {
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      if (signal?.aborted) {
        const error = new Error("Provider response read was aborted.");
        error.name = "AbortError";
        throw error;
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = Buffer.from(value || []);
      total += chunk.length;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The bounded read already failed closed.
        }
        throw capabilityExecutionError(
          "provider_response_too_large",
          `Capability provider response is too large; limit ${maxBytes} bytes.`,
        );
      }
      chunks.push(chunk);
    }
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      // Releasing a failed reader is best-effort.
    }
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function readBoundedProviderAsyncStream(body, maxBytes, signal) {
  const chunks = [];
  let total = 0;
  for await (const value of body) {
    if (signal?.aborted) {
      const error = new Error("Provider response read was aborted.");
      error.name = "AbortError";
      throw error;
    }
    const chunk = Buffer.from(value || []);
    total += chunk.length;
    if (total > maxBytes) {
      body.destroy?.();
      throw capabilityExecutionError(
        "provider_response_too_large",
        `Capability provider response is too large; limit ${maxBytes} bytes.`,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function repairConfigProfilesModelReferences(rootDir) {
  const profiles = loadConfigProfiles(rootDir);
  if (!profiles.length) {
    return { repairedCount: 0, profiles: [] };
  }
  let repairedCount = 0;
  const repairedProfiles = profiles
    .map((profile) => {
      const before = configProfileModelReferenceSnapshot(profile);
      const normalized = normalizeConfigProfileForStorage(rootDir, profile);
      if (!normalized) {
        return null;
      }
      if (before !== configProfileModelReferenceSnapshot(normalized)) {
        repairedCount += 1;
      }
      return normalized;
    })
    .filter(Boolean);
  if (repairedCount) {
    writeJsonAtomic(configProfilesPath(rootDir), {
      version: 1,
      profiles: repairedProfiles,
    });
  }
  return {
    repairedCount,
    profiles: repairedProfiles,
  };
}

function normalizeConfigProfileForStorage(rootDir, profile = {}) {
  const normalized = normalizeConfigProfile(profile);
  if (!normalized) {
    return null;
  }
  const mode = normalized.mode === MODE_ALL_API ? MODE_ALL_API : MODE_HYBRID;
  const rawSelectedModelIds = Array.isArray(normalized.selectedModelIds)
    ? normalized.selectedModelIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  const selectedModelIds = normalizeSelection(rootDir, rawSelectedModelIds, mode);
  const selected = selectedModelIds.length
    ? selectedModelIds
    : rawSelectedModelIds.length ? fallbackSelectedModelIds(rootDir, mode) : [];
  const effectiveSelected = selected.length ? selected : fallbackSelectedModelIds(rootDir, mode);
  const routes = routesForSelectedModelIds(rootDir, effectiveSelected, modelCatalog(rootDir));
  const desktopOptions = normalizeDesktopRouteReferences(rootDir, normalized.desktopOptions || {}, routes);
  return normalizeConfigProfile({
    ...normalized,
    mode,
    selectedModelIds: selected,
    desktopOptions,
  });
}

function configProfileModelReferenceSnapshot(profile = {}) {
  const options = normalizeDesktopOptions(profile.desktopOptions || {});
  return JSON.stringify({
    mode: profile.mode === MODE_ALL_API ? MODE_ALL_API : MODE_HYBRID,
    selectedModelIds: Array.isArray(profile.selectedModelIds)
      ? profile.selectedModelIds.map((id) => String(id || "").trim()).filter(Boolean)
      : [],
    codexAuxiliaryModelId: options.codexAuxiliaryModelId || "",
    smartRouting: normalizeDesktopSmartRouting(options.smartRouting),
  });
}

export function buildRouteSyncPlan(rootDir, {
  mode = "",
  homeDir = os.homedir(),
  refreshCodexCache = true,
} = {}) {
  if (!rootDir) {
    throw new Error("rootDir is required.");
  }
  const current = readRouterConfig(rootDir);
  const targetMode = mode || detectModeFromConfig(current);
  const beforeStatus = modelReferenceStatus(rootDir, targetMode);
  const cachePlan = codexVisibleModelCatalogRefreshPlan(homeDir, refreshCodexCache);
  const actions = [];
  if (beforeStatus.repairAvailable) {
    actions.push({
      id: "repair_model_references",
      status: "pending",
      issueCount: beforeStatus.issueCount,
    });
  }
  actions.push({
    id: "write_router_config",
    status: "pending",
    mode: targetMode,
  });
  actions.push({
    id: "refresh_codex_model_catalog",
    status: cachePlan.status,
    reason: cachePlan.reason,
  });
  return {
    mode: targetMode,
    needsRepair: beforeStatus.repairAvailable,
    beforeStatus,
    codexCache: cachePlan,
    actions,
  };
}

export function synchronizeRouteState(rootDir, {
  mode = "",
  homeDir = os.homedir(),
  refreshCodexCache = true,
} = {}) {
  const plan = buildRouteSyncPlan(rootDir, { mode, homeDir, refreshCodexCache });
  const repair = plan.needsRepair
    ? repairDesktopModelReferences(rootDir, plan.mode)
    : null;
  const profileReferenceRepair = repair?.profileReferenceRepair || repairConfigProfilesModelReferences(rootDir);
  const config = writeRouterConfigFromSelection(rootDir, plan.mode);
  const catalog = refreshCodexCache
    ? refreshCodexVisibleModelCatalogIfManaged({
      rootDir,
      mode: plan.mode,
      homeDir,
    })
    : { skipped: true, reason: "disabled", catalog: null };
  const afterStatus = modelReferenceStatus(rootDir, plan.mode);
  const selectedModelIds = readSelection(rootDir, plan.mode);
  return {
    mode: plan.mode,
    ok: afterStatus.ok,
    needsRepair: plan.needsRepair,
    selectedModelIds,
    config,
    catalog,
    cache: catalog,
    repair,
    profileReferenceRepairCount: profileReferenceRepair.repairedCount,
    profileReferenceRepair,
    beforeStatus: plan.beforeStatus,
    afterStatus,
    actions: routeSyncCompletedActions(plan.actions, catalog),
  };
}

function routeSyncCompletedActions(actions = [], catalog = {}) {
  return actions.map((action) => {
    if (action.id === "refresh_codex_model_catalog") {
      return {
        ...action,
        status: catalog.skipped ? "skipped" : "completed",
        reason: catalog.reason || "",
      };
    }
    return {
      ...action,
      status: "completed",
    };
  });
}

function codexVisibleModelCatalogRefreshPlan(homeDir = os.homedir(), enabled = true) {
  if (!enabled) {
    return { status: "skipped", reason: "disabled" };
  }
  const target = codexConfigPath(homeDir);
  if (!fs.existsSync(target)) {
    return { status: "skipped", reason: "codex_config_missing" };
  }
  const current = fs.readFileSync(target, "utf8");
  if (!hasCodexBridgeManagedBlock(current)) {
    return { status: "skipped", reason: "codexbridge_not_managed" };
  }
  return { status: "pending", reason: "" };
}

export function buildRouterConfigFromSelection(rootDir, mode = MODE_HYBRID) {
  const candidate = buildRouterConfigCandidate(rootDir, {
    mode,
    selectedModelIds: readSelection(rootDir, mode),
  });
  persistNormalizedSelectionIfNeeded(rootDir, candidate.selectedModelIds, mode);
  persistDesktopRouteReferencesIfNeeded(
    rootDir,
    candidate.rawDesktopOptions,
    candidate.desktopOptions,
  );
  return candidate.routerConfig;
}

function buildRouterConfigCandidate(rootDir, {
  mode = MODE_HYBRID,
  selectedModelIds = [],
  configRevision = "",
  state = null,
  models = modelCatalog(rootDir, state),
} = {}) {
  const providers = providerCatalog(rootDir, state);
  const normalizedSelectedModelIds = repairSelectionAgainstModels(
    rootDir,
    selectedModelIds,
    mode,
    models,
    providers,
  );
  const rawDesktopOptions = state && Object.prototype.hasOwnProperty.call(state, "desktopOptions")
    ? state.desktopOptions
    : loadDesktopOptions(rootDir);
  const modelById = new Map(models.map((model) => [model.presetId, model]));
  const selected = normalizedSelectedModelIds
    .map((id) => modelById.get(id))
    .filter(Boolean);
  if (selected.length === 0) {
    throw new Error("Please select at least one model.");
  }
  if (
    mode === MODE_ALL_API &&
    selected.some((model) => model.authMode === "codex_openai")
  ) {
    throw new Error("全部 API 模式不能选择“GPT 订阅”模型，请改选 API 模型或切换到混合模式。");
  }

  const imageGenerationOverrides = state && Object.prototype.hasOwnProperty.call(state, "modelImageGeneration")
    ? state.modelImageGeneration
    : readModelImageGenerationOverrides(rootDir);
  const imageProviderConfig = state && Object.prototype.hasOwnProperty.call(state, "imageProviderConfig")
    ? state.imageProviderConfig
    : readImageProviderConfig(rootDir);
  const capabilityProviders = readCapabilityProviders(rootDir, state);
  const routes = selected.map((model, index) =>
    routeForSelectedModel(model, index, imageGenerationOverrides, imageProviderConfig, rootDir),
  );
  const desktopOptions = normalizeDesktopRouteReferences(
    rootDir,
    rawDesktopOptions,
    routes,
    providers,
  );
  const requestedAuxiliaryRouteId = String(desktopOptions.codexAuxiliaryModelId || "").trim();
  const codexAuxiliaryRouteId = routes.some((route) => route.id === requestedAuxiliaryRouteId)
    ? requestedAuxiliaryRouteId
    : routes[0].id;

  const routerConfig = {
    ...(configRevision ? { configRevision } : {}),
    mode,
    host: "127.0.0.1",
    port: desktopOptions.routerPort,
    authToken: routerAuthToken(rootDir, state),
    clientAuth: {
      allowOpenAiBearer: mode === MODE_HYBRID,
    },
    defaultModel: routes[0].id,
    catalog: {
      effectiveContextWindowPercent: 95,
      autoCompactPercent: 80,
    },
    smartRouting: routerSmartRoutingOptionsFromDesktopOptions(desktopOptions),
    codexAuxiliaryTasks: {
      intercept: Boolean(desktopOptions.interceptCodexAuxiliaryTasks),
      routeId: codexAuxiliaryRouteId,
    },
    rateLimit: {
      enabled: Boolean(desktopOptions.localRateLimitEnabled),
      mode: Boolean(desktopOptions.localRateLimitEnabled) ? "relaxed" : "off",
    },
    duplicateRequestProtection: desktopOptions.duplicateRequestProtection === true,
    usageBudgets: desktopOptions.usageBudgets || {},
    capabilityProviders,
    models: routes.map((route) => ({
      ...route,
      localRateLimitEnabled: Boolean(desktopOptions.localRateLimitEnabled),
    })),
  };
  return {
    selectedModelIds: normalizedSelectedModelIds,
    rawDesktopOptions,
    desktopOptions,
    routerConfig,
  };
}

const generatedRouterAuthTokens = new Map();

function routerAuthToken(rootDir, state = null) {
  const rootKey = path.resolve(rootDir);
  const currentConfig = state && Object.prototype.hasOwnProperty.call(state, "routerConfig")
    ? state.routerConfig
    : readRouterConfig(rootDir);
  const currentToken = String(currentConfig?.authToken || "").trim();
  if (currentToken && currentToken !== CODEX_BRIDGE_LEGACY_LOCAL_AUTH_TOKEN) {
    generatedRouterAuthTokens.set(rootKey, currentToken);
    return currentToken;
  }
  if (!generatedRouterAuthTokens.has(rootKey)) {
    generatedRouterAuthTokens.set(
      rootKey,
      `cbr_${randomUUID().replaceAll("-", "")}`,
    );
  }
  return generatedRouterAuthTokens.get(rootKey);
}

export function buildModeSwitchCandidates({
  rootDir,
  homeDir = os.homedir(),
  mode,
  selectedModelIds = [],
  configRevision,
} = {}) {
  validateModeSwitchRequest({ rootDir, homeDir, mode, selectedModelIds });
  if (typeof configRevision !== "string" || !configRevision.trim()) {
    throw new TypeError("configRevision must be a non-empty string.");
  }

  const normalized = normalizeSelection(rootDir, selectedModelIds, mode);
  const effectiveSelectedModelIds = normalized.length
    ? normalized
    : fallbackSelectedModelIds(rootDir, mode);
  const routerCandidate = buildRouterConfigCandidate(rootDir, {
    mode,
    selectedModelIds: effectiveSelectedModelIds,
    configRevision,
  });
  const routerConfig = routerCandidate.routerConfig;
  const committedSelectedModelIds = routerCandidate.selectedModelIds;
  const catalog = buildModelCatalog(routerConfig);
  const targets = {
    selectionPath: selectionPath(rootDir),
    routerConfigPath: routerConfigPath(rootDir),
    codexCatalogPath: codexCatalogPath(homeDir),
    codexConfigPath: codexConfigPath(homeDir),
  };

  const currentToml = fs.existsSync(targets.codexConfigPath)
    ? fs.readFileSync(targets.codexConfigPath, "utf8")
    : "";
  const currentSettings = currentCodexModelSettings(currentToml);
  const requestedModel = currentSettings.model || routerConfig.defaultModel;
  const resolvedModel = resolveCodexBridgeModelForCatalog(catalog, requestedModel).model;
  const bridgeToml = buildCodexToml({
    rootDir,
    homeDir,
    mode,
    port: routerConfig.port || 15722,
    authToken: routerConfig.authToken,
    ...currentSettings,
    model: resolvedModel,
  });
  const codexConfig = mergeCodexBridgeConfig(currentToml, bridgeToml);
  const routeModelIds = routerConfig.models.map((model) => model.id);
  const selection = { mode, selectedModelIds: committedSelectedModelIds };

  const entries = [
    {
      id: "selection",
      target: targets.selectionPath,
      content: `${JSON.stringify(selection, null, 2)}\n`,
      validate: ({ content }) => validateModeSwitchSelectionCandidate(
        content,
        mode,
        committedSelectedModelIds,
      ),
    },
    {
      id: "routerConfig",
      target: targets.routerConfigPath,
      content: `${JSON.stringify(routerConfig, null, 2)}\n`,
      validate: ({ content, configRevision: candidateRevision }) =>
        validateModeSwitchRouterCandidate(content, {
          mode,
          selectedModelIds: committedSelectedModelIds,
          routeModelIds,
          configRevision: candidateRevision,
        }),
    },
    {
      id: "codexCatalog",
      target: targets.codexCatalogPath,
      content: `${JSON.stringify(catalog, null, 2)}\n`,
      validate: ({ content }) => validateModeSwitchCatalogCandidate(content, routeModelIds),
    },
    {
      id: "codexConfig",
      target: targets.codexConfigPath,
      content: codexConfig,
      validate: (context) => {
        validateModeSwitchCodexCandidate(context.content, {
          target: targets.codexConfigPath,
          catalogTarget: targets.codexCatalogPath,
          mode,
          port: routerConfig.port || 15722,
          authToken: routerConfig.authToken,
          routeModelIds,
        });
        validateModeSwitchCrossFileCandidates(context.entries, {
          mode,
          selectedModelIds: committedSelectedModelIds,
          routeModelIds,
          configRevision: context.configRevision,
        });
      },
    },
  ];

  return {
    entries,
    value: {
      mode,
      selectedModelIds: committedSelectedModelIds,
      routerConfig,
      targets,
      restartRequired: true,
      codexRestartRequired: true,
    },
    mode,
    selectedModelIds: committedSelectedModelIds,
    routerConfig,
    catalog,
    codexConfig,
    targets,
  };
}

export async function applyModeSwitchTransaction({
  rootDir,
  homeDir = os.homedir(),
  mode,
  selectedModelIds = [],
  coordinator = sharedConfigWriteCoordinator,
  verifyCommitted,
} = {}) {
  validateModeSwitchRequest({ rootDir, homeDir, mode, selectedModelIds });
  if (!coordinator || typeof coordinator.runTransaction !== "function") {
    throw new TypeError("coordinator must expose runTransaction().");
  }
  if (verifyCommitted !== undefined && typeof verifyCommitted !== "function") {
    throw new TypeError("verifyCommitted must be a function when provided.");
  }

  const result = await applyConfigMutationTransaction({
    rootDir,
    homeDir,
    operation: "mode:select",
    payload: { mode, selectedModelIds },
    coordinator,
    verifyCommitted,
  });

  return {
    ...result,
    targets: {
      selectionPath: selectionPath(rootDir),
      routerConfigPath: routerConfigPath(rootDir),
      codexCatalogPath: codexCatalogPath(homeDir),
      codexConfigPath: codexConfigPath(homeDir),
    },
    restartRequired: true,
    codexRestartRequired: true,
  };
}

const CONFIG_MUTATION_SOURCE_DEFINITIONS = {
  secrets: {
    target: (rootDir) => secretsPath(rootDir),
    sensitive: true,
    value: (state) => state.secrets,
  },
  profiles: {
    target: (rootDir) => configProfilesPath(rootDir),
    value: (state) => ({ version: 1, profiles: state.configProfiles }),
  },
  customModels: {
    target: (rootDir) => customModelsPath(rootDir),
    value: (state) => state.customModels,
  },
  providerOverrides: {
    target: (rootDir) => providerOverridesPath(rootDir),
    value: (state) => ({ version: 1, providers: state.providerOverrides }),
  },
  modelCapabilities: {
    target: (rootDir) => modelCapabilitiesPath(rootDir),
    value: (state) => ({
      version: 3,
      imageInput: state.modelImageInput,
      overrides: state.modelCapabilities,
    }),
  },
  modelDirectory: {
    target: (rootDir) => modelDirectoryPath(rootDir),
    value: (state) => state.modelDirectory,
  },
  capabilityProviders: {
    target: (rootDir) => capabilityProvidersPath(rootDir),
    value: (state) => state.capabilityProviderConfig,
  },
  imageProviders: {
    target: (rootDir) => imageProvidersPath(rootDir),
    value: (state) => state.imageProviderConfig,
  },
  modelImageGeneration: {
    target: (rootDir) => modelImageGenerationPath(rootDir),
    value: (state) => ({ version: 1, imageGeneration: state.modelImageGeneration }),
  },
};

function configMutationTrackedTargets(rootDir, homeDir) {
  return [
    ...Object.values(CONFIG_MUTATION_SOURCE_DEFINITIONS).map((definition) =>
      definition.target(rootDir)),
    selectionPath(rootDir),
    desktopOptionsPath(rootDir),
    routerConfigPath(rootDir),
    catalogPath(rootDir),
    codexCatalogPath(homeDir),
    codexConfigPath(homeDir),
    codexRouterOriginalPath(homeDir),
  ];
}

function readOptionalFileBytes(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function providerModelDirectoryEntry(result = {}) {
  return {
    providerId: String(result.providerId || "").trim(),
    providerName: String(result.providerName || result.providerId || "").trim(),
    baseUrl: String(result.baseUrl || "").trim().replace(/\/+$/, ""),
    endpoint: String(result.endpoint || "").trim(),
    source: "remote",
    fetchedAt: String(result.fetchedAt || "").trim(),
    models: Array.isArray(result.models) ? result.models : [],
  };
}

function providerModelDirectoryFingerprint(rootDir, providerId, state = null) {
  const provider = providerCatalog(rootDir, state).find((item) => item.id === providerId);
  if (!provider) {
    return "";
  }
  const keyEnv = provider.keyEnv || provider.apiKeyEnv || "";
  const secrets = state?.secrets || loadSecrets(rootDir);
  const apiKey = keyEnv ? (secrets[keyEnv] || process.env[keyEnv] || "") : "";
  return providerModelDirectoryFingerprintFromValues(provider, apiKey);
}

function providerModelDirectoryFingerprintFromValues(provider = {}, apiKey = "") {
  return hashJson({
    id: provider.id || "",
    name: provider.name || "",
    baseUrl: provider.baseUrl || "",
    api: provider.api || "",
    authMode: provider.authMode || "",
    keyEnv: provider.keyEnv || provider.apiKeyEnv || "",
    keyFingerprint: apiKey
      ? createHash("sha256").update(String(apiKey)).digest("hex")
      : "",
  });
}

function sameOptionalBytes(left, right) {
  if (left === null || right === null) {
    return left === right;
  }
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.equals(right);
}

function readConfigMutationState(rootDir, homeDir) {
  const routerConfig = readRouterConfig(rootDir);
  const mode = detectModeFromConfig(routerConfig);
  const selectionDocument = readJsonIfExists(selectionPath(rootDir), null);
  const selectedModelIds = Array.isArray(selectionDocument?.selectedModelIds)
    ? selectionDocument.selectedModelIds.map((id) => String(id || "").trim()).filter(Boolean)
    : readSelection(rootDir, mode);
  const secrets = loadSecrets(rootDir);
  const providerOverrides = readProviderOverrides(rootDir);
  const pendingSourceMigrations = [];
  const legacyKimiCode = legacyKimiCodeProviderOverride(rootDir);
  if (legacyKimiCode) {
    pendingSourceMigrations.push("providerOverrides");
    const legacyKeyEnv = String(legacyKimiCode.keyEnv || "MOONSHOT_API_KEY").trim();
    if (
      !secrets.KIMI_CODE_API_KEY
      && legacyKeyEnv
      && secrets[legacyKeyEnv]
    ) {
      secrets.KIMI_CODE_API_KEY = secrets[legacyKeyEnv];
      pendingSourceMigrations.push("secrets");
    }
  }
  return {
    mode,
    selectedModelIds,
    secrets,
    desktopOptions: loadDesktopOptions(rootDir),
    configProfiles: loadConfigProfiles(rootDir),
    customModels: readCustomModels(rootDir),
    providerOverrides,
    modelImageInput: readModelImageInputOverrides(rootDir),
    modelCapabilities: readModelCapabilityOverrides(rootDir),
    modelDirectory: readModelDirectory(rootDir),
    capabilityProviderConfig: readCapabilityProviderConfig(rootDir),
    imageProviderConfig: readImageProviderConfig(rootDir),
    modelImageGeneration: readModelImageGenerationOverrides(rootDir),
    routerConfig,
    pendingSourceMigrations,
  };
}

function captureStableConfigMutationSnapshot(rootDir, homeDir) {
  const targets = configMutationTrackedTargets(rootDir, homeDir);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = new Map(targets.map((target) => [target, readOptionalFileBytes(target)]));
    const state = readConfigMutationState(rootDir, homeDir);
    const after = new Map(targets.map((target) => [target, readOptionalFileBytes(target)]));
    if (targets.every((target) => sameOptionalBytes(before.get(target), after.get(target)))) {
      return { state, originals: after };
    }
  }
  const error = new Error("Configuration changed while the transaction snapshot was being read");
  error.code = "config_snapshot_changed";
  throw error;
}

function cloneConfigMutationState(state) {
  return JSON.parse(JSON.stringify(state));
}

function configMutationNow(options = {}) {
  const value = typeof options.now === "function" ? options.now() : options.now;
  return value ? new Date(value).toISOString() : new Date().toISOString();
}

function normalizeImportedItems(items, normalize, section) {
  const result = [];
  for (const item of items || []) {
    const normalized = normalize(item);
    if (!normalized) {
      const error = new Error(`Validated configuration package section became invalid: ${section}`);
      error.code = "config_package_candidate_invalid";
      throw error;
    }
    result.push(normalized);
  }
  return result;
}

function applyConfigPackageCandidateToState(state, candidate, touched) {
  const imported = [];
  if (candidate.mode === MODE_ALL_API || candidate.mode === MODE_HYBRID) {
    state.mode = candidate.mode;
  }
  if (candidate.selection) {
    state.mode = candidate.selection.mode;
    state.selectedModelIds = [...candidate.selection.selectedModelIds];
    imported.push("model_selection");
  }
  if (candidate.desktopOptions) {
    state.desktopOptions = normalizeDesktopOptions({
      ...state.desktopOptions,
      ...candidate.desktopOptions,
      smartRouting: mergeDesktopSmartRouting(
        state.desktopOptions.smartRouting,
        candidate.desktopOptions.smartRouting,
      ),
    });
    imported.push("desktop_options");
  }
  if (candidate.customModels) {
    state.customModels = normalizeImportedItems(
      candidate.customModels,
      normalizeSavedCustomModel,
      "customModels",
    );
    touched.add("customModels");
    imported.push("custom_models");
  }
  if (candidate.providerOverrides) {
    const providers = {};
    for (const [providerId, value] of Object.entries(candidate.providerOverrides)) {
      const normalized = normalizeProviderOverride({ ...value, id: value.id || providerId });
      if (!normalized) {
        const error = new Error("Validated provider override became invalid");
        error.code = "config_package_candidate_invalid";
        throw error;
      }
      providers[providerId] = normalized;
    }
    state.providerOverrides = providers;
    touched.add("providerOverrides");
    imported.push("provider_overrides");
  }
  if (candidate.capabilityProviders) {
    const providers = candidate.capabilityProviders.providers.map(normalizeCustomCapabilityProvider);
    state.capabilityProviderConfig = {
      version: 1,
      providers,
      defaults: capabilityProviderDefaultsForProviders(
        providers,
        candidate.capabilityProviders.defaults,
      ),
    };
    touched.add("capabilityProviders");
    imported.push("capability_providers");
  }
  if (candidate.imageProviders) {
    const providers = candidate.imageProviders.providers.map(normalizeImageProvider);
    const providerIds = new Set(providers.map((provider) => provider.id));
    state.imageProviderConfig = {
      version: 1,
      providers,
      defaultProviderId: providerIds.has(candidate.imageProviders.defaultProviderId)
        ? candidate.imageProviders.defaultProviderId
        : "",
    };
    touched.add("imageProviders");
    imported.push("image_providers");
  }
  if (candidate.modelImageGeneration) {
    state.modelImageGeneration = Object.fromEntries(
      Object.entries(candidate.modelImageGeneration).map(([presetId, value]) => [
        presetId,
        normalizeImageGenerationSettings(value),
      ]),
    );
    touched.add("modelImageGeneration");
    imported.push("model_image_generation");
  }
  if (candidate.modelCapabilities) {
    state.modelImageInput = { ...candidate.modelCapabilities.imageInput };
    state.modelCapabilities = Object.fromEntries(
      Object.entries(candidate.modelCapabilities.overrides).map(([presetId, value]) => {
        const normalized = normalizeModelCapabilityOverride(value, { keepUpdatedAt: true });
        if (!normalized) {
          const error = new Error("Validated model capability became invalid");
          error.code = "config_package_candidate_invalid";
          throw error;
        }
        return [presetId, normalized];
      }),
    );
    touched.add("modelCapabilities");
    imported.push("model_capabilities");
  }
  if (candidate.profiles) {
    state.configProfiles = normalizeImportedItems(
      candidate.profiles,
      normalizeConfigProfile,
      "profiles",
    );
    touched.add("profiles");
    imported.push("profiles");
  }
  return imported;
}

function assertConfigPackageProspectiveReferences(rootDir, state, candidate) {
  const models = modelCatalog(rootDir, state);
  const providers = providerCatalog(rootDir, state);
  const modelIds = models.map((model) => String(model.presetId || "").trim());
  const modelIdSet = new Set(modelIds);
  const providerIdSet = new Set(providers.map((provider) => String(provider.id || "").trim()));
  if (
    modelIds.some((id) => !id) ||
    modelIdSet.size !== modelIds.length ||
    providers.some((provider) => !String(provider.id || "").trim()) ||
    providerIdSet.size !== providers.length
  ) {
    throw configPackageReferenceError("catalog");
  }

  const assertSelection = (selectedModelIds, mode, section) => {
    const requested = Array.isArray(selectedModelIds)
      ? selectedModelIds.map((id) => String(id || "").trim())
      : [];
    const normalized = repairSelectionAgainstModels(
      rootDir,
      requested,
      mode,
      models,
      providers,
    );
    if (JSON.stringify(normalized) !== JSON.stringify(requested)) {
      throw configPackageReferenceError(section);
    }
  };

  if (
    Object.hasOwn(candidate, "selection") ||
    Object.hasOwn(candidate, "mode") ||
    Object.hasOwn(candidate, "customModels") ||
    Object.hasOwn(candidate, "providerOverrides")
  ) {
    assertSelection(state.selectedModelIds, state.mode, "selection");
  }

  if (candidate.providerOverrides) {
    for (const providerId of Object.keys(candidate.providerOverrides)) {
      if (!providerIdSet.has(providerId)) {
        throw configPackageReferenceError("providerOverrides");
      }
    }
  }

  if (candidate.modelCapabilities) {
    for (const presetId of [
      ...Object.keys(candidate.modelCapabilities.imageInput || {}),
      ...Object.keys(candidate.modelCapabilities.overrides || {}),
    ]) {
      if (!modelIdSet.has(presetId)) {
        throw configPackageReferenceError("modelCapabilities");
      }
    }
  }

  if (candidate.modelImageGeneration) {
    const imageProviderIds = new Set(
      state.imageProviderConfig.providers.map((provider) => String(provider.id || "").trim()),
    );
    for (const [presetId, imageSettings] of Object.entries(candidate.modelImageGeneration)) {
      if (!modelIdSet.has(presetId)) {
        throw configPackageReferenceError("modelImageGeneration");
      }
      if (
        imageSettings?.mode === "provider" &&
        !imageProviderIds.has(String(imageSettings.providerId || "").trim())
      ) {
        throw configPackageReferenceError("modelImageGeneration");
      }
    }
  }

  if (candidate.desktopOptions && importedDesktopOptionsHaveRouteReferences(candidate.desktopOptions)) {
    assertImportedDesktopRouteReferences(rootDir, state, state.desktopOptions, {
      mode: state.mode,
      selectedModelIds: state.selectedModelIds,
      models,
      providers,
      section: "desktopOptions",
    });
  }

  if (candidate.profiles) {
    const profilesById = new Map(state.configProfiles.map((profile) => [profile.id, profile]));
    for (const candidateProfile of candidate.profiles) {
      const profile = profilesById.get(candidateProfile.id);
      if (!profile) {
        throw configPackageReferenceError("profiles");
      }
      assertSelection(profile.selectedModelIds, profile.mode, "profiles");
      assertImportedDesktopRouteReferences(rootDir, state, profile.desktopOptions, {
        mode: profile.mode,
        selectedModelIds: profile.selectedModelIds,
        models,
        providers,
        section: "profiles",
      });
    }
  }
}

function importedDesktopOptionsHaveRouteReferences(options = {}) {
  return Object.hasOwn(options, "codexAuxiliaryModelId") ||
    Object.hasOwn(options, "smartRouting") ||
    Object.keys(options.usageBudgets?.routes || {}).length > 0 ||
    Object.keys(options.usageBudgets?.providers || {}).length > 0;
}

function assertImportedDesktopRouteReferences(
  rootDir,
  state,
  desktopOptions,
  { mode, selectedModelIds, models, providers, section },
) {
  const prospectiveState = {
    ...state,
    mode,
    selectedModelIds: [...selectedModelIds],
    desktopOptions: normalizeDesktopOptions(desktopOptions || {}),
  };
  let built;
  try {
    built = buildRouterConfigCandidate(rootDir, {
      mode,
      selectedModelIds,
      configRevision: "import-reference-validation",
      state: prospectiveState,
      models,
    });
  } catch {
    throw configPackageReferenceError(section);
  }
  if (
    JSON.stringify(desktopRouteReferenceSnapshot(prospectiveState.desktopOptions)) !==
    JSON.stringify(desktopRouteReferenceSnapshot(built.desktopOptions))
  ) {
    throw configPackageReferenceError(section);
  }
  const routeIds = new Set(built.routerConfig.models.map((route) => route.id));
  for (const routeId of Object.keys(prospectiveState.desktopOptions.usageBudgets?.routes || {})) {
    if (!routeIds.has(routeId)) {
      throw configPackageReferenceError(section);
    }
  }
  const providerIds = new Set(providers.map((provider) => provider.id));
  for (const providerId of Object.keys(prospectiveState.desktopOptions.usageBudgets?.providers || {})) {
    if (!providerIds.has(providerId)) {
      throw configPackageReferenceError(section);
    }
  }
}

function configPackageReferenceError(section) {
  const error = new Error(`Validated configuration package has an unavailable ${section} reference.`);
  error.code = "config_package_reference_invalid";
  return error;
}

function mutateConfigState(rootDir, baseState, operation, payload = {}, options = {}) {
  const state = cloneConfigMutationState(baseState);
  const touched = new Set(
    Array.isArray(state.pendingSourceMigrations)
      ? state.pendingSourceMigrations
      : [],
  );
  delete state.pendingSourceMigrations;
  let operationResult = {};

  if (operation === "configPackage:import" || operation === "configPackage:restoreLatestImportBackup") {
    const candidate = parseConfigPackageImport(payload.candidate || payload.input || payload.package || payload);
    const imported = applyConfigPackageCandidateToState(state, candidate, touched);
    assertConfigPackageProspectiveReferences(rootDir, state, candidate);
    const requiredSecretKeys = candidate.requiredSecretKeys || [];
    operationResult = {
      imported,
      requiredSecretKeys,
      missingSecretKeys: requiredSecretKeys.filter((key) => !state.secrets[key]),
      secretsImported: false,
    };
  } else if (operation === "secrets:save") {
    for (const [key, value] of Object.entries(payload.secrets || payload || {})) {
      if (typeof value === "string" && value.trim()) {
        state.secrets[key] = value.trim();
      }
    }
    touched.add("secrets");
    operationResult = {
      savedKeys: Object.keys(state.secrets).sort(),
      secretStatus: secretStatusForMutationState(rootDir, state),
    };
  } else if (operation === "options:save") {
    const incoming = payload.options || payload || {};
    state.desktopOptions = normalizeDesktopOptions({
      ...state.desktopOptions,
      ...incoming,
      smartRouting: mergeDesktopSmartRouting(
        state.desktopOptions.smartRouting,
        incoming.smartRouting,
      ),
    });
    operationResult = { saved: state.desktopOptions };
  } else if (operation === "mode:select") {
    if (payload.mode !== MODE_ALL_API && payload.mode !== MODE_HYBRID) {
      throw new Error("Unsupported mode.");
    }
    state.mode = payload.mode;
    state.selectedModelIds = Array.isArray(payload.selectedModelIds)
      ? payload.selectedModelIds
      : [];
  } else if (operation === "models:saveSelection") {
    state.selectedModelIds = Array.isArray(payload.selectedModelIds)
      ? payload.selectedModelIds
      : Array.isArray(payload)
        ? payload
        : [];
  } else if (operation === "models:saveImageInput") {
    const presetId = String(payload.presetId || "").trim();
    if (!presetId) {
      throw new Error("Model id is required.");
    }
    const enabled = Boolean(payload.imageInput);
    state.modelImageInput[presetId] = enabled;
    if (Array.isArray(state.modelCapabilities[presetId]?.inputModalities)) {
      state.modelCapabilities[presetId] = {
        ...state.modelCapabilities[presetId],
        inputModalities: toggleInputModality(
          state.modelCapabilities[presetId].inputModalities,
          "image",
          enabled,
        ),
        updatedAt: configMutationNow(options),
      };
    }
    touched.add("modelCapabilities");
    operationResult = { saved: { presetId, imageInput: enabled } };
  } else if (operation === "models:saveImageGeneration") {
    const presetId = String(payload.presetId || "").trim();
    if (!presetId) {
      throw new Error("Model id is required.");
    }
    const imageGenerationInput = { ...(payload.imageGeneration || {}) };
    const apiKey = typeof imageGenerationInput.apiKey === "string"
      ? imageGenerationInput.apiKey.trim()
      : "";
    delete imageGenerationInput.apiKey;
    state.modelImageGeneration[presetId] = normalizeImageGenerationSettings(imageGenerationInput);
    touched.add("modelImageGeneration");
    if (apiKey && state.modelImageGeneration[presetId].apiKeyEnv) {
      state.secrets[state.modelImageGeneration[presetId].apiKeyEnv] = apiKey;
      touched.add("secrets");
    }
    operationResult = {
      saved: { presetId, imageGeneration: state.modelImageGeneration[presetId] },
    };
  } else if (operation === "models:saveCapabilities") {
    const presetId = String(payload.presetId || "").trim();
    const normalized = normalizeModelCapabilityOverride(payload.capabilities || payload.override || {});
    if (!presetId || !normalized) {
      throw new Error("Model id and at least one capability override are required.");
    }
    const saved = { ...normalized, updatedAt: configMutationNow(options) };
    state.modelCapabilities[presetId] = saved;
    if (Array.isArray(saved.inputModalities)) {
      state.modelImageInput[presetId] = saved.inputModalities.includes("image");
    }
    touched.add("modelCapabilities");
    operationResult = { saved };
  } else if (operation === "models:resetCapabilities") {
    const presetId = String(payload.presetId || payload || "").trim();
    if (!presetId) {
      throw new Error("Model id is required.");
    }
    delete state.modelCapabilities[presetId];
    touched.add("modelCapabilities");
    operationResult = { reset: { presetId, reset: true } };
  } else if (operation === "providers:refreshModels") {
    const refresh = payload.refreshResult || payload.result || payload || {};
    const providerId = String(refresh.providerId || payload.providerId || "").trim();
    if (!refresh.ok || !providerId || !refresh.providerFingerprint) {
      throw new Error("A successful provider model refresh candidate is required.");
    }
    if (!providerModelRefreshIsCurrent(rootDir, providerId, refresh)) {
      throw staleProviderModelRefreshError();
    }
    const currentFingerprint = providerModelDirectoryFingerprint(rootDir, providerId, state);
    if (currentFingerprint !== refresh.providerFingerprint) {
      const error = new Error("Provider settings changed while the model directory was loading.");
      error.code = "provider_refresh_stale";
      throw error;
    }
    state.modelDirectory.providers[providerId] = providerModelDirectoryEntry(refresh);
    state.modelDirectory = normalizeModelDirectory(state.modelDirectory);
    touched.add("modelDirectory");
    operationResult = { refresh: { ...providerModelDirectoryEntry(refresh), ok: true, count: refresh.models.length } };
  } else if (operation === "providers:save") {
    const input = payload.provider || payload || {};
    const providerId = String(input.providerId || input.id || "").trim();
    if (!providerId) {
      throw new Error("Provider id is required.");
    }
    if (input.keyEnv) {
      providerApiKeyEnv(input.keyEnv);
    }
    const saved = normalizeProviderOverride({
      ...(state.providerOverrides[providerId] || {}),
      ...input,
      id: providerId,
      updatedAt: configMutationNow(options),
    });
    if (!saved) {
      throw new Error("Provider settings are empty.");
    }
    saved.id = providerId;
    state.providerOverrides[providerId] = saved;
    touched.add("providerOverrides");
    const currentProvider = providerCatalog(rootDir, state).find((item) => item.id === providerId);
    const keyEnv = saved.keyEnv || currentProvider?.keyEnv || "";
    const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (apiKey && keyEnv) {
      state.secrets[keyEnv] = apiKey;
      touched.add("secrets");
    }
    operationResult = { saved };
  } else if (operation === "providers:reset") {
    const providerId = String(payload.providerId || payload || "").trim();
    if (!providerId) {
      throw new Error("Provider id is required.");
    }
    const providerName = providerCatalog(rootDir, state)
      .find((provider) => provider.id === providerId)?.name || providerId;
    const removed = Object.prototype.hasOwnProperty.call(state.providerOverrides, providerId);
    delete state.providerOverrides[providerId];
    touched.add("providerOverrides");
    operationResult = { removed, providerId, providerName };
  } else if (operation === "imageProviders:save") {
    const input = payload.provider || payload || {};
    const provider = normalizeImageProvider(input);
    state.imageProviderConfig.providers = state.imageProviderConfig.providers
      .filter((item) => item.id !== provider.id);
    state.imageProviderConfig.providers.push(provider);
    if (input.makeDefault || !state.imageProviderConfig.defaultProviderId) {
      state.imageProviderConfig.defaultProviderId = provider.id;
    }
    touched.add("imageProviders");
    const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (apiKey && provider.apiKeyEnv) {
      state.secrets[provider.apiKeyEnv] = apiKey;
      touched.add("secrets");
    }
    operationResult = { saved: provider };
  } else if (operation === "imageProviders:remove") {
    const providerId = String(payload.providerId || payload || "").trim();
    state.imageProviderConfig.providers = state.imageProviderConfig.providers
      .filter((provider) => provider.id !== providerId);
    if (state.imageProviderConfig.defaultProviderId === providerId) {
      state.imageProviderConfig.defaultProviderId = "";
    }
    touched.add("imageProviders");
    operationResult = { providerId, config: state.imageProviderConfig };
  } else if (operation === "capabilityProviders:save") {
    const input = payload.provider || payload || {};
    const provider = normalizeCustomCapabilityProvider(input);
    state.capabilityProviderConfig.providers = state.capabilityProviderConfig.providers
      .filter((item) => item.id !== provider.id);
    state.capabilityProviderConfig.providers.push(provider);
    const defaults = { ...state.capabilityProviderConfig.defaults };
    if (input.makeDefault || provider.enabled !== false) {
      for (const capability of provider.capabilities) {
        if (input.makeDefault || !defaults[capability]) {
          defaults[capability] = provider.id;
        }
      }
    }
    state.capabilityProviderConfig.defaults = capabilityProviderDefaultsForProviders(
      state.capabilityProviderConfig.providers,
      defaults,
    );
    touched.add("capabilityProviders");
    const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (apiKey && provider.apiKeyEnv) {
      state.secrets[provider.apiKeyEnv] = apiKey;
      touched.add("secrets");
    }
    operationResult = { saved: provider };
  } else if (operation === "capabilityProviders:remove") {
    const providerId = String(payload.providerId || payload || "").trim();
    state.capabilityProviderConfig.providers = state.capabilityProviderConfig.providers
      .filter((provider) => provider.id !== providerId);
    state.capabilityProviderConfig.defaults = Object.fromEntries(
      Object.entries(state.capabilityProviderConfig.defaults)
        .filter(([, id]) => id !== providerId),
    );
    touched.add("capabilityProviders");
    operationResult = { providerId, config: state.capabilityProviderConfig };
  } else if (operation === "logos:select") {
    const providerId = String(payload.providerId || "").trim();
    const logoUrl = String(payload.logoUrl || "").trim();
    if (!payload.logoTarget || !Buffer.isBuffer(payload.logoBytes) || !logoUrl) {
      throw new Error("A validated provider logo candidate is required.");
    }
    if (payload.applyToProvider && providerId) {
      const saved = normalizeProviderOverride({
        ...(state.providerOverrides[providerId] || {}),
        id: providerId,
        logoUrl,
        updatedAt: configMutationNow(options),
      });
      if (!saved) {
        throw new Error("Provider settings are empty.");
      }
      state.providerOverrides[providerId] = saved;
      touched.add("providerOverrides");
    }
    operationResult = { saved: { path: payload.logoTarget, logoUrl }, providerId };
  } else if (operation === "customModel:save") {
    const input = payload.model || payload || {};
    const existing = input.presetId
      ? state.customModels.find((item) => item.presetId === input.presetId)
      : null;
    const model = normalizeCustomModel({
      ...input,
      keyEnv: input.keyEnv || existing?.keyEnv || existing?.apiKeyEnv,
      inputModalities: input.inputModalities || existing?.inputModalities,
      docsUrl: input.docsUrl ?? existing?.docsUrl,
      logoUrl: input.logoUrl ?? existing?.logoUrl,
      contextWindow: input.contextWindow || existing?.contextWindow,
    });
    state.customModels = state.customModels.filter((item) => item.presetId !== model.presetId);
    state.customModels.push(model);
    touched.add("customModels");
    const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (apiKey && model.keyEnv) {
      state.secrets[model.keyEnv] = apiKey;
      touched.add("secrets");
    }
    operationResult = { saved: model };
  } else if (operation === "customModel:remove") {
    const presetId = String(payload.presetId || payload || "").trim();
    state.customModels = state.customModels.filter((model) => model.presetId !== presetId);
    state.selectedModelIds = state.selectedModelIds.filter((id) => id !== presetId);
    touched.add("customModels");
    operationResult = { presetId, models: state.customModels };
  } else if (operation === "profiles:apply") {
    const profileId = String(payload.profileId || payload || "").trim();
    const profile = state.configProfiles.find((item) => item.id === profileId);
    if (!profile) {
      throw new Error("Config profile not found.");
    }
    state.mode = profile.mode;
    state.selectedModelIds = [...(profile.selectedModelIds || [])];
    state.desktopOptions = normalizeDesktopOptions(profile.desktopOptions || {});
    operationResult = { profile };
  } else if (operation === "profiles:save") {
    const input = payload.profile || payload || {};
    const profile = normalizeConfigProfileForStorage(rootDir, {
      ...input,
      mode: input.mode === MODE_ALL_API || input.mode === MODE_HYBRID
        ? input.mode
        : state.mode,
      selectedModelIds: Array.isArray(input.selectedModelIds)
        ? input.selectedModelIds
        : [...state.selectedModelIds],
      desktopOptions: input.desktopOptions && typeof input.desktopOptions === "object"
        ? input.desktopOptions
        : state.desktopOptions,
      updatedAt: configMutationNow(options),
    });
    if (!profile) {
      throw new Error("Config profile requires a name.");
    }
    state.configProfiles = state.configProfiles.filter((item) => item.id !== profile.id);
    state.configProfiles.unshift(profile);
    touched.add("profiles");
    operationResult = { saved: profile };
  } else if (
    ![
      "models:repairReferences",
      "catalog:generate",
      "codex:apply",
      "codex:initialize",
      "router:start",
      "startup:repair",
    ].includes(operation)
  ) {
    const error = new Error("Unsupported configuration mutation operation");
    error.code = "config_mutation_unsupported";
    throw error;
  }

  return { state, touched, operationResult };
}

function sourceCandidatesForMutation(rootDir, state, touched, originals) {
  return [...touched].map((id) => {
    const definition = CONFIG_MUTATION_SOURCE_DEFINITIONS[id];
    if (!definition) {
      throw new Error(`Unknown configuration source: ${id}`);
    }
    const target = definition.target(rootDir);
    return {
      id,
      target,
      value: definition.value(state),
      sensitive: Boolean(definition.sensitive),
      originalBytes: originals.get(target),
    };
  });
}

function configPackageBackupFromState(rootDir, state, createdAt) {
  const customModels = portableCustomModels(state.customModels, rootDir);
  const providerOverrides = portableProviderOverrides(state.providerOverrides, rootDir);
  const pkg = {
    schema: "codexbridge.config-package",
    version: 1,
    exportedAt: createdAt,
    includesSecrets: false,
    mode: state.mode,
    selection: {
      mode: state.mode,
      selectedModelIds: [...state.selectedModelIds],
    },
    desktopOptions: portableDesktopOptions(state.desktopOptions),
    customModels,
    providerOverrides,
    capabilityProviders: portableCapabilityProviderConfig(state.capabilityProviderConfig),
    imageProviders: portableImageProviderConfig(state.imageProviderConfig),
    modelImageGeneration: portableModelImageGenerationOverrides(state.modelImageGeneration),
    embeddedLogoCount: configPackageEmbeddedLogoCount({ customModels, providerOverrides }),
    modelCapabilities: {
      imageInput: { ...state.modelImageInput },
      overrides: { ...state.modelCapabilities },
    },
    profiles: portableConfigProfiles(state.configProfiles),
    secretKeys: Object.keys(state.secrets).sort(),
    backupReason: "before_config_package_import",
    backupCreatedAt: createdAt,
  };
  return {
    ...pkg,
    requiredSecretKeys: configPackageRequiredSecretKeys(pkg, state.routerConfig),
  };
}

function shouldInstallManagedCodexBlock(operation) {
  return [
    "mode:select",
    "codex:apply",
    "codex:initialize",
    "router:start",
  ].includes(operation);
}

function managedCodexMutationPlan({
  operation,
  state,
  routerConfig,
  catalog,
  currentBytes,
  currentExists,
}) {
  const install = shouldInstallManagedCodexBlock(operation);
  let workingBytes = currentBytes;
  let repairedMalformed = false;
  let inspected;
  try {
    inspected = inspectManagedCodexTomlBlock(workingBytes);
  } catch (error) {
    if (operation !== "router:start" || error?.code !== "managed_toml_invalid") {
      throw error;
    }
    workingBytes = repairMalformedManagedCodexToml(currentBytes);
    inspected = inspectManagedCodexTomlBlock(workingBytes);
    repairedMalformed = true;
  }
  const includeCodexConfig = install || inspected.state === "managed";
  if (!includeCodexConfig) {
    return {
      includeCodexConfig: false,
      allowManagedBlockInsert: false,
      block: "",
      baseBytes: workingBytes,
      preserveOriginal: false,
      repairedMalformed,
    };
  }
  const currentSettings = currentCodexModelSettings(workingBytes.toString("utf8"));
  const requestedModel = currentSettings.model || routerConfig.defaultModel;
  const resolvedModel = resolveCodexBridgeModelForCatalog(catalog, requestedModel).model;
  const preserveOriginal = install && inspected.state === "unmanaged" && currentExists;
  const originalBackupBytes = repairedMalformed ? workingBytes : currentBytes;
  let block = buildCodexToml({
    rootDir: state.rootDir,
    homeDir: state.homeDir,
    mode: state.mode,
    port: routerConfig.port || 15722,
    authToken: routerConfig.authToken,
    ...currentSettings,
    model: resolvedModel,
  });
  if (preserveOriginal) {
    block = block.replace(
      CODEX_BRIDGE_MANAGED_END,
      `${CODEX_BRIDGE_ROUTER_ORIGINAL_MARKER}\n${CODEX_BRIDGE_MANAGED_END}`,
    );
  }
  return {
    includeCodexConfig: true,
    allowManagedBlockInsert: install,
    block,
    baseBytes: preserveOriginal
      ? removeUnmanagedCodexBridgeConflicts(workingBytes)
      : workingBytes,
    preserveOriginal,
    originalBackupBytes,
    repairedMalformed,
  };
}

export async function applyConfigMutationTransaction({
  rootDir,
  homeDir = os.homedir(),
  operation,
  payload = {},
  coordinator = sharedConfigWriteCoordinator,
  verifyCommitted,
  now,
  managedTomlRetryDelays = [100, 250, 500],
  waitForManagedTomlRetry = ({ delayMs }) => new Promise((resolve) => setTimeout(resolve, delayMs)),
} = {}) {
  if (typeof rootDir !== "string" || !rootDir.trim()) {
    throw new TypeError("rootDir is required.");
  }
  if (typeof homeDir !== "string" || !homeDir.trim()) {
    throw new TypeError("homeDir is required.");
  }
  if (typeof operation !== "string" || !operation.trim()) {
    throw new TypeError("operation is required.");
  }
  if (!coordinator || typeof coordinator.runTransaction !== "function") {
    throw new TypeError("coordinator must expose runTransaction().");
  }
  const providerRefreshCandidate = operation === "providers:refreshModels"
    ? (payload.refreshResult || payload.result || payload || {})
    : null;
  const transactionVerifier = providerRefreshCandidate
    ? async (context) => {
        if (typeof verifyCommitted === "function") {
          await verifyCommitted(context);
        }
        const providerId = String(providerRefreshCandidate.providerId || payload.providerId || "").trim();
        if (!providerModelRefreshIsCurrent(rootDir, providerId, providerRefreshCandidate)) {
          throw staleProviderModelRefreshError();
        }
      }
    : verifyCommitted;

  const transactionResult = await coordinator.runTransaction({
    operation,
    prepare: async ({ configRevision }) => {
      const retryDelays = Array.isArray(managedTomlRetryDelays)
        ? managedTomlRetryDelays.map(Number).filter((value) => Number.isFinite(value) && value >= 0)
        : [];
      for (let managedTomlAttempt = 0; ; managedTomlAttempt += 1) {
        try {
      const snapshot = captureStableConfigMutationSnapshot(rootDir, homeDir);
      const preparedAt = configMutationNow({ now });
      const mutated = mutateConfigState(
        rootDir,
        snapshot.state,
        operation,
        payload,
        { now: preparedAt },
      );
      const state = {
        ...mutated.state,
        rootDir,
        homeDir,
      };
      const models = modelCatalog(rootDir, state);
      const providers = providerCatalog(rootDir, state);
      state.selectedModelIds = repairSelectionAgainstModels(
        rootDir,
        state.selectedModelIds,
        state.mode,
        models,
        providers,
      );
      const routerCandidate = buildRouterConfigCandidate(rootDir, {
        mode: state.mode,
        selectedModelIds: state.selectedModelIds,
        configRevision,
        state,
        models,
      });
      state.selectedModelIds = routerCandidate.selectedModelIds;
      state.desktopOptions = routerCandidate.desktopOptions;
      const routerConfig = routerCandidate.routerConfig;
      const catalog = buildModelCatalog(routerConfig);
      const currentCodexBytes = snapshot.originals.get(codexConfigPath(homeDir)) ?? Buffer.alloc(0);
      const managedPlan = managedCodexMutationPlan({
        operation,
        state,
        routerConfig,
        catalog,
        currentBytes: currentCodexBytes,
        currentExists: snapshot.originals.get(codexConfigPath(homeDir)) !== null,
      });
      const sources = sourceCandidatesForMutation(
        rootDir,
        state,
        mutated.touched,
        snapshot.originals,
      );
      let importBackup = null;
      if (operation === "configPackage:import" || operation === "configPackage:restoreLatestImportBackup") {
        const backupTarget = configPackageImportBackupTarget(rootDir, new Date(preparedAt));
        importBackup = {
          backupPath: backupTarget.backupPath,
          backupFileName: backupTarget.fileName,
          backupCreatedAt: preparedAt,
        };
        sources.push({
          id: "importBackup",
          target: backupTarget.backupPath,
          value: configPackageBackupFromState(rootDir, snapshot.state, preparedAt),
          sensitive: false,
          originalBytes: null,
        });
      }
      assertSecretValuesAbsentFromConfigArtifacts(state.secrets, [
        ...sources
          .filter((entry) => entry.id !== "secrets")
          .map((entry) => entry.value),
        { mode: state.mode, selectedModelIds: state.selectedModelIds },
        state.desktopOptions,
        routerConfig,
        catalog,
        managedPlan.block,
        mutated.operationResult,
      ]);
      const draft = buildConfigMutationDraft({
        operation,
        configRevision,
        mode: state.mode,
        sources,
        selection: {
          target: selectionPath(rootDir),
          value: { mode: state.mode, selectedModelIds: state.selectedModelIds },
          originalBytes: snapshot.originals.get(selectionPath(rootDir)),
        },
        options: {
          target: desktopOptionsPath(rootDir),
          value: state.desktopOptions,
          originalBytes: snapshot.originals.get(desktopOptionsPath(rootDir)),
        },
        router: {
          target: routerConfigPath(rootDir),
          originalBytes: snapshot.originals.get(routerConfigPath(rootDir)),
        },
        rootCatalog: {
          target: catalogPath(rootDir),
          originalBytes: snapshot.originals.get(catalogPath(rootDir)),
        },
        codexCatalog: {
          target: codexCatalogPath(homeDir),
          originalBytes: snapshot.originals.get(codexCatalogPath(homeDir)),
        },
        codexConfig: {
          target: codexConfigPath(homeDir),
          currentBytes: managedPlan.baseBytes,
          originalBytes: snapshot.originals.get(codexConfigPath(homeDir)),
        },
        includeCodexConfig: managedPlan.includeCodexConfig,
        allowManagedBlockInsert: managedPlan.allowManagedBlockInsert,
        buildRouterConfig: () => routerConfig,
        buildRootCatalog: () => catalog,
        buildCodexCatalog: () => catalog,
        buildManagedCodexBlock: () => managedPlan.block,
      });
      const entries = materializeConfigMutationEntries(draft);
      if (managedPlan.preserveOriginal) {
        const draftEntryIds = new Set(entries.map((entry) => entry.id));
        for (const entry of entries) {
          const validateDraftEntry = entry.validate;
          entry.validate = (context) => validateDraftEntry({
            ...context,
            entries: context.entries.filter((candidate) => draftEntryIds.has(candidate.id)),
          });
        }
        const backupTarget = codexRouterOriginalPath(homeDir);
        const backupOriginal = snapshot.originals.get(backupTarget);
        entries.push({
          id: "codexRouterOriginal",
          target: backupTarget,
          content: managedPlan.originalBackupBytes,
          sensitive: true,
          expectedOriginal: backupOriginal === null
            ? { exists: false }
            : { exists: true, bytes: backupOriginal },
          validate: ({ content }) => {
            const candidate = Buffer.isBuffer(content) ? content : Buffer.from(content);
            if (!candidate.equals(managedPlan.originalBackupBytes)) {
              throw new Error("Codex Router original backup candidate changed");
            }
          },
        });
        if (managedPlan.repairedMalformed) {
          const malformedBackupTarget = nextCodexRestoreBackupPath(
            codexConfigPath(homeDir),
            "managed-invalid",
          );
          entries.push({
            id: "codexManagedInvalidBackup",
            target: malformedBackupTarget,
            content: currentCodexBytes,
            sensitive: true,
            mode: 0o600,
            expectedOriginal: { exists: false },
            validate: validateExactCodexRestoreCandidate(currentCodexBytes),
          });
        }
      }
      if (operation === "logos:select") {
        const logoTarget = path.resolve(String(payload.logoTarget || ""));
        if (!/\.(?:png|jpe?g|webp|gif|svg|ico)$/i.test(logoTarget)) {
          const error = new Error("Provider logo target is outside the managed logo directory.");
          error.code = "provider_logo_target_invalid";
          throw error;
        }
        assertManagedProviderLogoPath(rootDir, logoTarget, { allowMissingTarget: true });
        const logoBytes = Buffer.from(payload.logoBytes);
        const originalLogoBytes = fs.existsSync(logoTarget)
          ? readProviderLogoFileSafely(logoTarget)
          : null;
        const draftEntryIds = new Set(entries.map((entry) => entry.id));
        for (const entry of entries) {
          const validateDraftEntry = entry.validate;
          entry.validate = (context) => validateDraftEntry({
            ...context,
            entries: context.entries.filter((candidate) => draftEntryIds.has(candidate.id)),
          });
        }
        entries.push({
          id: "providerLogo",
          target: logoTarget,
          content: logoBytes,
          expectedOriginal: originalLogoBytes === null
            ? { exists: false }
            : { exists: true, bytes: originalLogoBytes },
          sensitive: false,
          validate: ({ content }) => {
            const candidate = Buffer.isBuffer(content) ? content : Buffer.from(content);
            if (!candidate.equals(logoBytes)) {
              throw new Error("Provider logo candidate did not validate.");
            }
          },
        });
      }
      return {
        entries,
        value: {
          operation,
          mode: state.mode,
          selectedModelIds: state.selectedModelIds,
          routerConfig,
          catalog,
          codexConfigUpdated: managedPlan.includeCodexConfig,
          result: {
            ...mutated.operationResult,
            ...(importBackup || {}),
          },
        },
      };
        } catch (error) {
          if (error?.code !== "managed_toml_invalid" || managedTomlAttempt >= retryDelays.length) {
            throw error;
          }
          await waitForManagedTomlRetry({
            attempt: managedTomlAttempt + 1,
            delayMs: retryDelays[managedTomlAttempt],
            error,
          });
        }
      }
    },
    verifyCommitted: transactionVerifier,
  });
  if (providerRefreshCandidate) {
    completeProviderModelRefresh(providerRefreshCandidate);
  }

  return {
    ...transactionResult.value,
    revision: transactionResult.configRevision,
    configRevision: transactionResult.configRevision,
  };
}

export function configureSharedConfigWriteCoordinator({
  rootDir,
  homeDir = os.homedir(),
  journalDir = path.join(rootDir || "", "config", ".transactions"),
} = {}) {
  if (typeof rootDir !== "string" || !path.isAbsolute(rootDir)) {
    throw new TypeError("rootDir must be an absolute path.");
  }
  if (typeof homeDir !== "string" || !path.isAbsolute(homeDir)) {
    throw new TypeError("homeDir must be an absolute path.");
  }
  return sharedConfigWriteCoordinator.configure({
    allowedRoots: [rootDir, path.join(homeDir, ".codex")],
    journalDir,
  });
}

export async function recoverSharedConfigTransactions(options = {}) {
  configureSharedConfigWriteCoordinator(options);
  return sharedConfigWriteCoordinator.recoverPendingTransactions();
}

function mergeRouterOriginalWithConcurrentRemainder(
  backupBytes,
  expectedRemainder,
  currentRemainder,
) {
  if (
    expectedRemainder.length > 0 &&
    currentRemainder.length >= expectedRemainder.length &&
    currentRemainder.subarray(0, expectedRemainder.length).equals(expectedRemainder)
  ) {
    return Buffer.concat([
      backupBytes,
      currentRemainder.subarray(expectedRemainder.length),
    ]);
  }
  if (
    expectedRemainder.length > 0 &&
    currentRemainder.length >= expectedRemainder.length &&
    currentRemainder
      .subarray(currentRemainder.length - expectedRemainder.length)
      .equals(expectedRemainder)
  ) {
    return Buffer.concat([
      currentRemainder.subarray(0, currentRemainder.length - expectedRemainder.length),
      backupBytes,
    ]);
  }
  return null;
}

export async function removeManagedCodexConfigTransaction({
  homeDir = os.homedir(),
  coordinator = sharedConfigWriteCoordinator,
} = {}) {
  const target = codexConfigPath(homeDir);
  const backupTarget = codexRouterOriginalPath(homeDir);
  const committed = await coordinator.runTransaction({
    operation: "router:stop",
    prepare: () => {
      const originalBytes = readOptionalFileBytes(target);
      if (originalBytes === null) {
        return { entries: [], value: { target, removed: false, reason: "codex_config_missing" } };
      }
      const inspected = inspectManagedCodexTomlBlock(originalBytes);
      if (inspected.state === "unmanaged") {
        return { entries: [], value: { target, removed: false, reason: "codexbridge_not_managed" } };
      }
      const usesOriginalBackup = originalBytes
        .toString("utf8")
        .includes(CODEX_BRIDGE_ROUTER_ORIGINAL_MARKER);
      let content;
      let reason = "managed_block_removed";
      if (usesOriginalBackup) {
        const backupBytes = readOptionalFileBytes(backupTarget);
        if (backupBytes === null) {
          const error = new Error("Codex Router original backup is missing");
          error.code = "codex_router_original_missing";
          throw error;
        }
        const placeholderBlock = [
          CODEX_BRIDGE_MANAGED_START,
          CODEX_BRIDGE_MANAGED_END,
          "",
        ].join("\n");
        const expectedRemainder = removeManagedCodexTomlBlock(
          replaceManagedCodexTomlBlock(
            removeUnmanagedCodexBridgeConflicts(backupBytes),
            placeholderBlock,
          ),
        );
        const currentRemainder = removeManagedCodexTomlBlock(originalBytes);
        if (!currentRemainder.equals(expectedRemainder)) {
          const merged = mergeRouterOriginalWithConcurrentRemainder(
            backupBytes,
            expectedRemainder,
            currentRemainder,
          );
          if (merged) {
            content = merged;
            reason = "router_original_restored_with_concurrent_changes";
          } else {
            content = currentRemainder;
            reason = "managed_block_removed_after_restore_conflict";
          }
        } else {
          content = backupBytes;
          reason = "router_original_restored";
        }
      } else {
        content = removeManagedCodexTomlBlock(originalBytes);
      }
      return {
        entries: [{
          id: "codexConfig",
          target,
          content,
          sensitive: true,
          expectedOriginal: { exists: true, bytes: originalBytes },
          validate: ({ content: candidate }) => {
            if (inspectManagedCodexTomlBlock(candidate).state !== "unmanaged") {
              throw new Error("Managed CodexBridge TOML block was not removed");
            }
          },
        }],
        value: { target, removed: true, reason },
      };
    },
  });
  return {
    ...committed.value,
    configRevision: committed.configRevision,
  };
}

export function runSharedConfigExclusive(work) {
  return sharedConfigWriteCoordinator.runExclusive(work);
}

function validateModeSwitchRequest({ rootDir, homeDir, mode, selectedModelIds }) {
  if (typeof rootDir !== "string" || !rootDir.trim()) {
    throw new TypeError("rootDir is required.");
  }
  if (typeof homeDir !== "string" || !homeDir.trim()) {
    throw new TypeError("homeDir is required.");
  }
  if (mode !== MODE_HYBRID && mode !== MODE_ALL_API) {
    throw new Error(
      `Unsupported mode ${JSON.stringify(mode)}. Expected "hybrid" or "all_api".`,
    );
  }
  if (!Array.isArray(selectedModelIds)) {
    throw new TypeError("selectedModelIds must be an array.");
  }
}

function validateModeSwitchSelectionCandidate(content, mode, selectedModelIds) {
  const selection = parseModeSwitchJsonCandidate(content, "selection");
  if (selection?.mode !== mode) {
    throw new Error("Mode transaction selection candidate has the wrong mode.");
  }
  assertModeSwitchStringArray(
    selection?.selectedModelIds,
    selectedModelIds,
    "selection model IDs",
  );
}

function validateModeSwitchRouterCandidate(content, {
  mode,
  selectedModelIds,
  routeModelIds,
  configRevision,
}) {
  const config = parseModeSwitchJsonCandidate(content, "Router config");
  if (config?.mode !== mode) {
    throw new Error("Mode transaction Router candidate has the wrong mode.");
  }
  if (config?.configRevision !== configRevision) {
    throw new Error("Mode transaction Router candidate has the wrong revision.");
  }
  if (!Array.isArray(config?.models) || config.models.length === 0) {
    throw new Error("Mode transaction Router candidate has no models.");
  }
  assertModeSwitchStringArray(
    config.models.map((model) => String(model?.sourcePresetId || "")),
    selectedModelIds,
    "Router source model IDs",
  );
  assertModeSwitchStringArray(
    config.models.map((model) => String(model?.id || "")),
    routeModelIds,
    "Router route model IDs",
  );
  if (config.defaultModel !== routeModelIds[0]) {
    throw new Error("Mode transaction Router candidate has the wrong default model.");
  }
  if (
    mode === MODE_ALL_API &&
    config.models.some((model) => model?.authMode === "codex_openai")
  ) {
    throw new Error("All-API Router candidate contains a subscription model.");
  }
}

function validateModeSwitchCatalogCandidate(content, routeModelIds) {
  const catalog = parseModeSwitchJsonCandidate(content, "Codex model catalog");
  if (!Array.isArray(catalog?.models)) {
    throw new Error("Mode transaction Codex catalog candidate has no models array.");
  }
  assertModeSwitchStringArray(
    catalog.models.map((model) => String(model?.slug || model?.id || "")),
    routeModelIds,
    "Codex catalog model IDs",
  );
}

function validateModeSwitchCodexCandidate(content, {
  target,
  catalogTarget,
  mode,
  port,
  authToken,
  routeModelIds,
}) {
  validateCodexBridgeWrittenConfig({ target, content, mode, port });
  const startCount = String(content).split(CODEX_BRIDGE_MANAGED_START).length - 1;
  const endCount = String(content).split(CODEX_BRIDGE_MANAGED_END).length - 1;
  if (startCount !== 1 || endCount !== 1) {
    throw new Error("Mode transaction Codex candidate must contain one managed block.");
  }

  const catalogPathValue = readTopLevelTomlString(content, "model_catalog_json");
  if (catalogPathValue !== toTomlPath(catalogTarget)) {
    throw new Error("Mode transaction Codex candidate points at the wrong model catalog.");
  }
  const selectedModel = readTopLevelTomlString(content, "model");
  if (!routeModelIds.includes(selectedModel)) {
    throw new Error("Mode transaction Codex candidate selects a model outside the catalog.");
  }

  const requiresOpenAiAuth = readTopLevelTomlBoolean(
    content,
    `model_providers.${CODEX_BRIDGE_PROVIDER_ID}.requires_openai_auth`,
  );
  const headerPattern = new RegExp(
    `^\\s*model_providers\\.${escapeRegex(CODEX_BRIDGE_PROVIDER_ID)}\\.http_headers\\s*=\\s*\\{\\s*Authorization\\s*=\\s*"Bearer ${escapeRegex(authToken)}"\\s*}\\s*$`,
    "m",
  );
  if (mode === MODE_HYBRID) {
    if (
      readTopLevelTomlString(content, "model_provider") !== "openai" ||
      !/^http:\/\/(?:localhost|127\.0\.0\.1):\d+\/v1$/.test(
        readTopLevelTomlString(content, "openai_base_url") || "",
      ) ||
      headerPattern.test(content)
    ) {
      throw new Error("Hybrid Codex candidate must preserve the OpenAI history provider and proxy its base URL.");
    }
    return;
  }
  if (requiresOpenAiAuth !== false || !headerPattern.test(content)) {
    throw new Error("All-API Codex candidate must use the synchronized local Router header.");
  }
}

function validateModeSwitchCrossFileCandidates(entries, {
  mode,
  selectedModelIds,
  routeModelIds,
  configRevision,
}) {
  const selection = parseModeSwitchJsonCandidate(
    modeSwitchCandidateContent(entries, "selection"),
    "selection",
  );
  const routerConfig = parseModeSwitchJsonCandidate(
    modeSwitchCandidateContent(entries, "routerConfig"),
    "Router config",
  );
  const catalog = parseModeSwitchJsonCandidate(
    modeSwitchCandidateContent(entries, "codexCatalog"),
    "Codex model catalog",
  );
  const codexConfig = modeSwitchCandidateContent(entries, "codexConfig");

  if (selection.mode !== mode || routerConfig.mode !== mode) {
    throw new Error("Mode transaction candidates disagree on mode.");
  }
  if (routerConfig.configRevision !== configRevision) {
    throw new Error("Mode transaction candidates disagree on revision.");
  }
  assertModeSwitchStringArray(selection.selectedModelIds, selectedModelIds, "selection model IDs");
  assertModeSwitchStringArray(
    routerConfig.models.map((model) => String(model?.sourcePresetId || "")),
    selectedModelIds,
    "cross-file source model IDs",
  );
  assertModeSwitchStringArray(
    routerConfig.models.map((model) => String(model?.id || "")),
    routeModelIds,
    "cross-file route model IDs",
  );
  assertModeSwitchStringArray(
    catalog.models.map((model) => String(model?.slug || model?.id || "")),
    routeModelIds,
    "cross-file catalog model IDs",
  );
  if (!routeModelIds.includes(readTopLevelTomlString(codexConfig, "model"))) {
    throw new Error("Mode transaction Codex model is not present in the Router candidates.");
  }
  if (
    mode === MODE_ALL_API &&
    !new RegExp(
      `Authorization\\s*=\\s*"Bearer ${escapeRegex(routerConfig.authToken)}"`,
    ).test(codexConfig)
  ) {
    throw new Error("Mode transaction Router and Codex candidates disagree on the local token.");
  }
}

function modeSwitchCandidateContent(entries, id) {
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`Mode transaction candidate is missing ${id}.`);
  }
  return String(entry.content ?? "");
}

function parseModeSwitchJsonCandidate(content, label) {
  try {
    return JSON.parse(String(content));
  } catch {
    throw new Error(`Mode transaction ${label} candidate is invalid JSON.`);
  }
}

function assertModeSwitchStringArray(actual, expected, label) {
  if (
    !Array.isArray(actual) ||
    actual.some((value) => typeof value !== "string" || !value) ||
    !sameStringArray(actual, expected)
  ) {
    throw new Error(`Mode transaction ${label} do not match.`);
  }
}

function readTopLevelTomlBoolean(content, key) {
  const pattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*(true|false)\\s*(?:#.*)?$`, "i");
  for (const line of String(content || "").split(/\r?\n/)) {
    if (isTomlTableHeader(line)) {
      break;
    }
    const match = line.match(pattern);
    if (match) {
      return match[1].toLowerCase() === "true";
    }
  }
  return null;
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
  mode = MODE_HYBRID,
  port = 15722,
  authToken = "",
  model = DEFAULT_CODEX_BRIDGE_MODEL_ID,
  reasoningEffort = "medium",
  sandboxMode = "danger-full-access",
  approvalPolicy = "never",
  homeDir = os.homedir(),
}) {
  const modelCatalogJson = toTomlString(toTomlPath(codexCatalogPath(homeDir)));
  const providerLines = codexBridgeProviderTomlLinesForMode({
    port,
    mode,
    authToken,
  });
  return [
    CODEX_BRIDGE_MANAGED_START,
    `model_provider = "${codexBridgeProviderIdForMode(mode)}"`,
    `model = "${model}"`,
    `model_catalog_json = ${modelCatalogJson}`,
    `model_reasoning_effort = "${reasoningEffort}"`,
    `sandbox_mode = "${sandboxMode}"`,
    `approval_policy = "${approvalPolicy}"`,
    ...providerLines,
    CODEX_BRIDGE_MANAGED_END,
    "",
  ].join("\n");
}

function writeCodexVisibleModelCatalog({ rootDir, mode = MODE_HYBRID, homeDir = os.homedir() }) {
  const config = readRouterConfig(rootDir) || buildRouterConfigFromSelection(rootDir, mode);
  const target = codexCatalogPath(homeDir);
  const catalog = buildModelCatalog(config);
  writeJsonAtomic(target, catalog);
  return target;
}

export function refreshCodexVisibleModelCatalogIfManaged({
  rootDir,
  mode = MODE_HYBRID,
  homeDir = os.homedir(),
} = {}) {
  if (!rootDir) {
    throw new Error("rootDir is required.");
  }
  const target = codexConfigPath(homeDir);
  if (!fs.existsSync(target)) {
    return { skipped: true, reason: "codex_config_missing", catalog: null };
  }
  const current = fs.readFileSync(target, "utf8");
  if (!hasCodexBridgeManagedBlock(current)) {
    return { skipped: true, reason: "codexbridge_not_managed", catalog: null };
  }
  const catalog = writeCodexVisibleModelCatalog({ rootDir, mode, homeDir });
  const repair = repairManagedCodexModelSelection(target, current, readJsonIfExists(catalog, {}));
  return {
    skipped: false,
    reason: "",
    catalog,
    ...repair,
  };
}

export function repairManagedCodexConfigCompatibility({
  rootDir,
  mode = MODE_HYBRID,
  homeDir = os.homedir(),
} = {}) {
  if (!rootDir) {
    throw new Error("rootDir is required.");
  }
  const plan = managedCodexConfigCompatibilityPlan({ homeDir, mode });
  if (!plan.needsRepair) {
    return { repaired: false, skipped: true, reason: plan.reason, target: plan.target };
  }
  const result = applyCodexConfig({ rootDir, mode, homeDir });
  return {
    ...result,
    repaired: true,
    skipped: false,
    reason: "legacy_provider_migrated",
  };
}

export function managedCodexConfigCompatibilityPlan({
  homeDir = os.homedir(),
  mode = MODE_HYBRID,
} = {}) {
  const target = codexConfigPath(homeDir);
  if (!fs.existsSync(target)) {
    return { needsRepair: false, reason: "codex_config_missing", target };
  }
  const current = fs.readFileSync(target, "utf8");
  if (!hasCodexBridgeManagedBlock(current)) {
    return { needsRepair: false, reason: "codexbridge_not_managed", target };
  }
  const providerId = readTopLevelTomlString(current, "model_provider") || "";
  const bridgeBaseUrl = readTopLevelTomlString(
    current,
    `model_providers.${CODEX_BRIDGE_PROVIDER_ID}.base_url`,
  );
  const bridgeWireApi = readTopLevelTomlString(
    current,
    `model_providers.${CODEX_BRIDGE_PROVIDER_ID}.wire_api`,
  );
  const openAiBaseUrl = readTopLevelTomlString(current, "openai_base_url");
  const needsRepair = mode === MODE_HYBRID
    ? providerId !== "openai" ||
      !openAiBaseUrl ||
      /model_providers\.codexbridge\./.test(current) ||
      /^\s*(?:disable_response_storage|network_access|windows_wsl_setup_acknowledged)\s*=/m.test(current)
    : providerId !== CODEX_BRIDGE_PROVIDER_ID || !bridgeBaseUrl || bridgeWireApi !== "responses";
  return {
    needsRepair,
    reason: needsRepair ? "legacy_provider_detected" : "already_compatible",
    target,
  };
}

function repairManagedCodexModelSelection(target, currentContent, catalog = {}) {
  const previousModel = readTopLevelTomlString(currentContent, "model") || "";
  if (!isCodexBridgeModelId(previousModel)) {
    return {
      modelRepaired: false,
      previousModel,
      model: previousModel,
    };
  }
  const resolved = resolveCodexBridgeModelForCatalog(catalog, previousModel);
  if (!resolved.changed) {
    return {
      modelRepaired: false,
      previousModel,
      model: resolved.model,
    };
  }
  const nextContent = replaceManagedCodexModel(currentContent, resolved.model);
  if (nextContent !== currentContent) {
    writeTextAtomic(target, nextContent.endsWith("\n") ? nextContent : `${nextContent}\n`);
  }
  return {
    modelRepaired: true,
    previousModel,
    model: resolved.model,
  };
}

function resolveCodexBridgeModelForCatalog(catalog = {}, requestedModel = "") {
  const catalogIds = codexBridgeCatalogModelIds(catalog);
  const requested = String(requestedModel || "").trim();
  if (requested && catalogIds.includes(requested)) {
    return { model: requested, changed: false };
  }
  const fallback = catalogIds[0] || requested || DEFAULT_CODEX_BRIDGE_MODEL_ID;
  return {
    model: fallback,
    changed: Boolean(requested && fallback && requested !== fallback && catalogIds.length),
  };
}

function codexBridgeCatalogModelIds(catalog = {}) {
  return Array.isArray(catalog.models)
    ? catalog.models
        .map((model) => String(model?.slug || model?.id || "").trim())
        .filter(Boolean)
    : [];
}

function replaceManagedCodexModel(content, modelId) {
  const lines = String(content || "").split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === CODEX_BRIDGE_MANAGED_START);
  if (start < 0) {
    return content;
  }
  const endOffset = lines.slice(start + 1).findIndex((line) => line.trim() === CODEX_BRIDGE_MANAGED_END);
  if (endOffset < 0) {
    return content;
  }
  const end = start + 1 + endOffset;
  let insertAt = start + 1;
  for (let index = start + 1; index < end; index += 1) {
    if (/^\s*model_provider\s*=/.test(lines[index])) {
      insertAt = index + 1;
    }
    if (/^\s*model\s*=/.test(lines[index])) {
      lines[index] = `model = ${toTomlString(modelId)}`;
      return replaceTopLevelCodexBridgeModelLines(lines, modelId).join("\n");
    }
  }
  lines.splice(insertAt, 0, `model = ${toTomlString(modelId)}`);
  return replaceTopLevelCodexBridgeModelLines(lines, modelId).join("\n");
}

function replaceTopLevelCodexBridgeModelLines(lines, modelId) {
  let inTopLevel = true;
  return lines.map((line) => {
    if (isTomlTableHeader(line)) {
      inTopLevel = false;
    }
    if (
      inTopLevel &&
      /^\s*model\s*=/.test(line)
    ) {
      return `model = ${toTomlString(modelId)}`;
    }
    return line;
  });
}

function syncCodexModelsCache(homeDir, catalog = {}) {
  const target = codexModelsCachePath(homeDir);
  const bridgeModels = Array.isArray(catalog.models) ? catalog.models : [];
  const bridgeSlugs = new Set(
    bridgeModels
      .map((model) => String(model?.slug || model?.id || "").trim())
      .filter(Boolean),
  );
  const existing = readJsonIfExists(target, {});
  const existingModels = Array.isArray(existing?.models) ? existing.models : [];
  const keptModels = existingModels.filter((model) => {
    const slug = String(model?.slug || model?.id || "").trim();
    if (!slug) {
      return false;
    }
    return (
      !bridgeSlugs.has(slug) &&
      !isCodexBridgeModelCacheEntry(model)
    );
  });
  const cacheModels = [
    ...bridgeModels.map((model) => codexBridgeModelCacheEntry(model)),
    ...keptModels,
  ];
  const updatedAt = new Date().toISOString();
  writeJsonAtomic(target, {
    ...existing,
    fetched_at: updatedAt,
    etag: existing?.etag || `codexbridge-local-${hashJson({ models: bridgeModels }).slice(0, 12)}`,
    client_version: existing?.client_version || "codexbridge",
    codexbridge_updated_at: updatedAt,
    models: cacheModels,
  });
  return target;
}

function codexBridgeModelCacheEntry(model = {}) {
  const slug = String(model?.slug || model?.id || "").trim();
  const displayName = String(
    model?.display_name ||
      model?.displayName ||
      model?.name ||
      slug,
  ).trim() || slug;
  const capabilities = model?.codexbridge_capabilities &&
    typeof model.codexbridge_capabilities === "object"
    ? model.codexbridge_capabilities
    : {};
  const provider = String(
    model?.provider ||
      model?.owned_by ||
      capabilities.provider_family ||
      "codexbridge",
  ).trim() || "codexbridge";
  const upstreamModel = String(
    model?.model ||
      capabilities.upstream_model ||
      slug,
  ).trim() || slug;
  return {
    ...model,
    slug,
    id: model?.id || slug,
    object: model?.object || "model",
    name: displayName,
    displayName,
    title: model?.title || displayName,
    display_name: displayName,
    owned_by: model?.owned_by || provider,
    provider,
    model: upstreamModel,
    codexbridge_cache_entry: true,
  };
}

function isCodexBridgeModelCacheEntry(model = {}) {
  const slug = String(model?.slug || model?.id || "").trim();
  return Boolean(
    model.codexbridge_cache_entry ||
      model.codexbridge_capabilities ||
      slug.startsWith(CODEX_BRIDGE_MODEL_ID_PREFIX)
  );
}

function hashJson(value) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
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
  const modelCatalog = readJsonIfExists(modelCatalogTarget, {});
  const existingContent = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  const currentSettings = currentCodexModelSettings(existingContent);
  const requestedModel = model || currentSettings.model || DEFAULT_CODEX_BRIDGE_MODEL_ID;
  const resolvedModel = resolveCodexBridgeModelForCatalog(modelCatalog, requestedModel).model;
  const bridgeContent = buildCodexToml({
    rootDir,
    mode,
    port,
    authToken: readRouterConfig(rootDir)?.authToken || "",
    homeDir,
    ...currentSettings,
    model: resolvedModel,
  });
  const content = mergeCodexBridgeConfig(existingContent, bridgeContent);

  if (fs.existsSync(target) && existingContent === content) {
    return { target, backup: null, unchanged: true, modelCatalog: modelCatalogTarget };
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
  return { target, backup, unchanged: false, modelCatalog: modelCatalogTarget };
}

function requireCodexRestoreCoordinator(coordinator) {
  if (!coordinator || typeof coordinator.runTransaction !== "function") {
    throw new TypeError("coordinator must expose runTransaction().");
  }
}

function expectedOriginalForRestore(bytes) {
  return bytes === null
    ? { exists: false }
    : { exists: true, bytes };
}

function candidateBytes(content) {
  return Buffer.isBuffer(content) ? content : Buffer.from(content);
}

function validateExactCodexRestoreCandidate(expectedBytes, validateSemantics) {
  const expected = Buffer.from(expectedBytes);
  return ({ content }) => {
    const candidate = candidateBytes(content);
    if (!candidate.equals(expected)) {
      throw new Error("Codex restore candidate bytes changed after preparation.");
    }
    validateSemantics?.(candidate);
  };
}

function nextCodexRestoreBackupPath(target, kind) {
  const base = `${target}.${kind}.${timestamp()}`;
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? "" : `-${index}`;
    const candidate = `${base}${suffix}.bak`;
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("Unable to allocate a unique Codex restore backup path.");
}

function stableCodexRestoreSourceBytes(sourcePath, targetDir) {
  const resolvedSource = path.resolve(sourcePath);
  const resolvedTargetDir = path.resolve(targetDir);
  if (path.dirname(resolvedSource) !== resolvedTargetDir) {
    throw new Error("Codex restore source must remain inside the Codex config directory.");
  }
  const directoryBefore = fs.lstatSync(resolvedTargetDir);
  if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) {
    throw new Error("Codex restore directory must be one real directory.");
  }
  const before = fs.lstatSync(resolvedSource);
  if (!codexRestoreSourceStatIsSafe(before)) {
    throw new Error("Codex restore source must be one bounded regular file.");
  }
  const descriptor = fs.openSync(resolvedSource, "r");
  try {
    const opened = fs.fstatSync(descriptor);
    if (!codexRestoreSourceStatIsSafe(opened) || !sameCodexRestoreSourceStat(before, opened)) {
      throw new Error("Codex restore source changed while it was being opened.");
    }
    const bytes = readBoundedCodexRestoreDescriptor(descriptor, opened.size);
    const afterRead = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(resolvedSource);
    const directoryAfter = fs.lstatSync(resolvedTargetDir);
    if (
      codexRestoreSourceStatIsSafe(afterRead) &&
      codexRestoreSourceStatIsSafe(afterPath) &&
      sameCodexRestoreSourceStat(opened, afterRead) &&
      sameCodexRestoreSourceStat(opened, afterPath) &&
      directoryAfter.isDirectory() &&
      !directoryAfter.isSymbolicLink() &&
      sameCodexRestoreSourceStat(directoryBefore, directoryAfter)
    ) {
      return bytes;
    }
    throw new Error("Codex restore source changed while it was being read.");
  } finally {
    fs.closeSync(descriptor);
  }
}

function readBoundedCodexRestoreDescriptor(descriptor, expectedSize) {
  const bytes = Buffer.alloc(expectedSize);
  let offset = 0;
  while (offset < expectedSize) {
    const count = fs.readSync(descriptor, bytes, offset, expectedSize - offset, offset);
    if (count <= 0) {
      throw new Error("Codex restore source changed while it was being read.");
    }
    offset += count;
  }
  const extra = Buffer.allocUnsafe(1);
  if (fs.readSync(descriptor, extra, 0, 1, expectedSize) !== 0) {
    throw new Error("Codex restore source grew while it was being read.");
  }
  return bytes;
}

function codexRestoreSourceStatIsSafe(stat) {
  return Boolean(
    stat &&
    stat.isFile() &&
    !stat.isSymbolicLink?.() &&
    (!Number.isInteger(stat.nlink) || stat.nlink === 1) &&
    stat.size >= 0 &&
    stat.size <= CODEX_CONFIG_RESTORE_MAX_BYTES
  );
}

function sameCodexRestoreSourceStat(left, right) {
  return Boolean(
    left &&
    right &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function buildCodexRestoreTransaction({
  target,
  originalBytes,
  restoredBytes,
  backupKind,
  value,
  validateTarget,
}) {
  const currentBackup = originalBytes === null
    ? null
    : nextCodexRestoreBackupPath(target, backupKind);
  const entries = [];
  if (currentBackup) {
    entries.push({
      id: "codexConfigRestoreBackup",
      target: currentBackup,
      content: originalBytes,
      expectedOriginal: { exists: false },
      sensitive: true,
      mode: 0o600,
      validate: validateExactCodexRestoreCandidate(originalBytes),
    });
  }
  entries.push({
    id: "codexConfig",
    target,
    content: restoredBytes,
    expectedOriginal: expectedOriginalForRestore(originalBytes),
    sensitive: true,
    mode: 0o600,
    validate: validateExactCodexRestoreCandidate(restoredBytes, validateTarget),
  });
  return {
    entries,
    value: {
      ...value,
      target,
      currentBackup,
    },
  };
}

function codexRestoreUnavailableError() {
  return new Error("没有找到 CodexBridge 写入前的备份，无法自动恢复 Codex 配置。");
}

export async function restoreCodexConfig({
  homeDir = os.homedir(),
  coordinator = sharedConfigWriteCoordinator,
} = {}) {
  const target = codexConfigPath(homeDir);
  const targetDir = path.dirname(target);
  if (!fs.existsSync(targetDir)) {
    throw codexRestoreUnavailableError();
  }
  const preflightBackups = codexBridgeBackups(targetDir);
  const preflightOriginal = readOptionalFileBytes(target);
  if (
    preflightBackups.length === 0 &&
    (preflightOriginal === null || !hasCodexBridgeManagedBlock(preflightOriginal.toString("utf8")))
  ) {
    throw codexRestoreUnavailableError();
  }
  requireCodexRestoreCoordinator(coordinator);
  const committed = await coordinator.runTransaction({
    operation: "codex:restore",
    prepare: () => {
      const originalBytes = readOptionalFileBytes(target);
      const backups = codexBridgeBackups(targetDir);
      if (backups.length > 0) {
        const restoreFrom = preferredRestoreBackup(backups);
        return buildCodexRestoreTransaction({
          target,
          originalBytes,
          restoredBytes: restoreFrom.bytes,
          backupKind: "before-restore",
          value: { backup: restoreFrom.fullPath },
        });
      }
      const stripped = restoreByStrippingManagedCodexBridgeBlock(target, originalBytes);
      if (stripped) {
        return stripped;
      }
      throw codexRestoreUnavailableError();
    },
  });
  return {
    ...committed.value,
    configRevision: committed.configRevision,
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
    { kind: "managed_invalid", pattern: /^config\.toml\.managed-invalid\..+\.bak$/ },
    { kind: "before_restore", pattern: /^config\.toml\.before-restore\..+\.bak$/ },
    { kind: "history_access", pattern: /^config\.toml\.history-access\..+\.bak$/ },
  ];
  return fs
    .readdirSync(targetDir)
    .filter((name) => patterns.some((item) => item.pattern.test(name)))
    .flatMap((name) => {
      const fullPath = path.join(targetDir, name);
      let stat;
      try {
        stat = fs.lstatSync(fullPath);
      } catch {
        return [];
      }
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        (Number.isInteger(stat.nlink) && stat.nlink !== 1) ||
        stat.size > CODEX_CONFIG_RESTORE_MAX_BYTES
      ) {
        return [];
      }
      const kind = patterns.find((item) => item.pattern.test(name))?.kind || "backup";
      return [{
        name,
        fullPath,
        kind,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        updatedAt: new Date(stat.mtimeMs).toISOString(),
      }];
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
}

export async function restoreCodexConfigFromBackup(backupPath, {
  homeDir = os.homedir(),
  coordinator = sharedConfigWriteCoordinator,
} = {}) {
  const target = codexConfigPath(homeDir);
  const resolvedBackup = path.resolve(String(backupPath || ""));
  const preflightAllowed = new Set(
    listCodexBackups({ homeDir }).map((item) => path.resolve(item.fullPath)),
  );
  if (!preflightAllowed.has(resolvedBackup)) {
    throw new Error("Backup is not a known CodexBridge config backup.");
  }
  if (!fs.existsSync(resolvedBackup)) {
    throw new Error("Selected Codex config backup does not exist.");
  }
  requireCodexRestoreCoordinator(coordinator);
  const committed = await coordinator.runTransaction({
    operation: "backups:restore",
    prepare: () => {
      const allowed = new Set(
        listCodexBackups({ homeDir }).map((item) => path.resolve(item.fullPath)),
      );
      if (!allowed.has(resolvedBackup)) {
        throw new Error("Backup is not a known CodexBridge config backup.");
      }
      const restoredBytes = stableCodexRestoreSourceBytes(resolvedBackup, path.dirname(target));
      return buildCodexRestoreTransaction({
        target,
        originalBytes: readOptionalFileBytes(target),
        restoredBytes,
        backupKind: "before-restore",
        value: { backup: resolvedBackup },
      });
    },
  });
  return {
    ...committed.value,
    configRevision: committed.configRevision,
  };
}

function restoreByStrippingManagedCodexBridgeBlock(target, originalBytes) {
  if (originalBytes === null) {
    return null;
  }
  const current = originalBytes.toString("utf8");
  if (!hasCodexBridgeManagedBlock(current)) {
    return null;
  }
  const stripped = stripCodexBridgeConfig(current);
  const restoredBytes = Buffer.from(stripped.trim() ? `${stripped.trimEnd()}\n` : "", "utf8");
  return buildCodexRestoreTransaction({
    target,
    originalBytes,
    restoredBytes,
    backupKind: "before-restore",
    value: { action: "strip_managed_block", backup: null },
    validateTarget: (candidate) => {
      if (hasCodexBridgeManagedBlock(candidate.toString("utf8"))) {
        throw new Error("Managed CodexBridge block remains in restore candidate.");
      }
    },
  });
}

export function syncCodexBridgeConversationProviders({
  homeDir = os.homedir(),
  codexStopped = false,
  apply = false,
} = {}) {
  if (!apply) {
    return previewCodexThreadCatalogRecovery({ homeDir });
  }
  return applyCodexThreadCatalogRecovery({ homeDir, codexStopped });
}

function hasTable(db, tableName) {
  return Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName),
  );
}

function tableColumns(db, tableName) {
  return db
    .prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
    .all()
    .map((column) => column.name);
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export async function recoverCodexHistoryAccess({
  homeDir = os.homedir(),
  coordinator = sharedConfigWriteCoordinator,
} = {}) {
  const target = codexConfigPath(homeDir);
  if (!fs.existsSync(target)) {
    throw new Error("没有找到 Codex 配置文件，无法自动开启历史对话显示。");
  }
  requireCodexRestoreCoordinator(coordinator);
  const committed = await coordinator.runTransaction({
    operation: "codex:recover-history",
    prepare: () => {
      const originalBytes = readOptionalFileBytes(target);
      if (originalBytes === null) {
        throw new Error("没有找到 Codex 配置文件，无法自动开启历史对话显示。");
      }
      const content = originalBytes.toString("utf8");
      if (!isCodexBridgeToml(content)) {
        return {
          entries: [],
          value: {
            target,
            currentBackup: null,
            unchanged: true,
            action: "recover_history_access",
            message: "当前 Codex 配置不是 CodexBridge 配置，无需调整。历史对话应由当前 Codex 配置自行显示。",
            nextStep: "请完全退出并重启 Codex。若还要使用 CodexBridge，请回到本应用开启 Router，配置会自动刷新。",
          },
        };
      }
      const nextContent = enableResponseStorage(content);
      const unchanged = nextContent === content;
      const value = {
        unchanged,
        action: "recover_history_access",
        message: unchanged
          ? "配置已包含历史对话设置，没有修改；请完全退出并重新打开 Codex。"
          : "已开启历史对话显示，并保留当前模型、插件与 Router 配置；请完全退出并重新打开 Codex。",
        nextStep: "请完全退出并重启 Codex；历史会话将由 Codex 按当前数据库状态显示，模型栏仍会继续使用 CodexBridge 当前配置。",
      };
      if (unchanged) {
        return {
          entries: [],
          value: { ...value, target, currentBackup: null },
        };
      }
      const restoredBytes = Buffer.from(nextContent, "utf8");
      return buildCodexRestoreTransaction({
        target,
        originalBytes,
        restoredBytes,
        backupKind: "history-access",
        value,
        validateTarget: (candidate) => {
          const candidateText = candidate.toString("utf8");
          if (!isCodexBridgeToml(candidateText) || enableResponseStorage(candidateText) !== candidateText) {
            throw new Error("Codex history recovery candidate did not validate.");
          }
        },
      });
    },
  });
  return {
    ...committed.value,
    configRevision: committed.configRevision,
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

function validateCodexBridgeWrittenConfig({
  target,
  content,
  mode = MODE_HYBRID,
  port = 15722,
} = {}) {
  const written = content ?? (target && fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "");
  if (!hasCodexBridgeManagedBlock(written)) {
    throw new Error("CodexBridge 配置校验失败：没有找到托管配置块标记。");
  }
  const expectedProviderId = codexBridgeProviderIdForMode(mode);
  if (readTopLevelTomlString(written, "model_provider") !== expectedProviderId) {
    throw new Error("CodexBridge 配置校验失败：model_provider 必须是 codexbridge。");
  }
  if (!readTopLevelTomlString(written, "model_catalog_json")) {
    throw new Error("CodexBridge 配置校验失败：缺少 model_catalog_json。");
  }
  const expected = new RegExp(`^http://(?:localhost|127\\.0\\.0\\.1):${Number(port || 15722)}/v1$`);
  if (mode === MODE_HYBRID) {
    const openAiBaseUrl = readTopLevelTomlString(written, "openai_base_url");
    if (!expected.test(openAiBaseUrl || "")) {
      throw new Error("CodexBridge config validation failed: openai_base_url does not point to the local Router.");
    }
    if (/model_providers\.codexbridge\./.test(written)) {
      throw new Error("CodexBridge config validation failed: hybrid mode changed the history provider namespace.");
    }
    return true;
  }
  const baseUrl = readTopLevelTomlString(
    written,
    `model_providers.${CODEX_BRIDGE_PROVIDER_ID}.base_url`,
  );
  if (!expected.test(baseUrl || "")) {
    throw new Error("CodexBridge 配置校验失败：codexbridge provider 的 base_url 没有指向本地 Router。");
  }
  if (
    readTopLevelTomlString(
      written,
      `model_providers.${CODEX_BRIDGE_PROVIDER_ID}.wire_api`,
    ) !== "responses"
  ) {
    throw new Error("CodexBridge 配置校验失败：provider 的 wire_api 必须是 responses。");
  }
  if (hasTomlTable(written, "model_providers.codex-bridge")) {
    throw new Error("CodexBridge 配置校验失败：仍残留旧版 codex-bridge provider 配置。");
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

function setTomlTableBoolean(content, tableName, key, value) {
  const source = String(content || "");
  const lines = tomlLinesWithOffsets(source);
  let tableStart = -1;
  let tableEnd = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const headerName = tomlHeaderName(lines[index].content);
    if (!headerName) {
      continue;
    }
    if (tableStart >= 0) {
      tableEnd = index;
      break;
    }
    if (headerName === tableName) {
      tableStart = index;
    }
  }
  if (tableStart < 0) {
    throw new Error(`TOML table not found: ${tableName}`);
  }
  const keyPattern = new RegExp(`^(\\s*)${escapeRegex(key)}\\s*=\\s*(true|false)\\b(.*)$`, "i");
  for (let index = tableStart + 1; index < tableEnd; index += 1) {
    const line = lines[index];
    const match = line.content.match(keyPattern);
    if (!match) {
      continue;
    }
    const replacement = `${match[1]}${key} = ${value ? "true" : "false"}${match[3] || ""}`;
    return `${source.slice(0, line.start)}${replacement}${source.slice(line.contentEnd)}`;
  }
  const header = lines[tableStart];
  const newline = header.newline || lines.find((line) => line.newline)?.newline || "\n";
  const insertion = header.newline
    ? `${key} = ${value ? "true" : "false"}${newline}`
    : `${newline}${key} = ${value ? "true" : "false"}${newline}`;
  return `${source.slice(0, header.end)}${insertion}${source.slice(header.end)}`;
}

function tomlLinesWithOffsets(content) {
  const lines = [];
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    if (!match[0]) {
      break;
    }
    const start = match.index;
    const contentEnd = start + match[1].length;
    lines.push({
      content: match[1],
      newline: match[2],
      start,
      contentEnd,
      end: start + match[0].length,
    });
    if (!match[2]) {
      break;
    }
  }
  return lines;
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
  return String(content || "").replace(
    /^\s*disable_response_storage\s*=.*(?:\r?\n|$)/gm,
    "",
  );
}

function codexBridgeBackups(targetDir) {
  return fs
    .readdirSync(targetDir)
    .filter((name) => /^config\.toml\.codexbridge\..+\.bak$/.test(name))
    .flatMap((name) => {
      const fullPath = path.join(targetDir, name);
      let bytes;
      let stat;
      try {
        bytes = stableCodexRestoreSourceBytes(fullPath, targetDir);
        stat = fs.lstatSync(fullPath);
      } catch {
        return [];
      }
      return [{
        fullPath,
        name,
        bytes,
        stamp: codexBridgeBackupStamp(name),
        mtimeMs: stat.mtimeMs,
      }];
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
      return !isCodexBridgeToml(backup.bytes.toString("utf8"));
    } catch {
      return false;
    }
  });
  return nonBridgeBackup || backups.at(-1);
}

function isCodexBridgeToml(content) {
  return (
    /model_provider\s*=\s*"codexbridge"/.test(content) ||
    /model_providers\.codexbridge\.base_url\s*=\s*"http:\/\/(?:localhost|127\.0\.0\.1):\d+\/v1"/.test(content) ||
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

function currentSelectableModels(rootDir, mode) {
  const models = modelCatalog(rootDir);
  if (mode === MODE_ALL_API) {
    return models.filter((model) => (model.authMode || "api_key") !== "codex_openai");
  }
  return models;
}

function fallbackSelectedModelIds(rootDir, mode) {
  const defaults = normalizeSelection(rootDir, defaultSelectedModelIds(mode), mode);
  if (defaults.length) {
    return defaults;
  }
  const first = currentSelectableModels(rootDir, mode)[0]?.presetId || "";
  return first ? [first] : [];
}

function persistNormalizedSelectionIfNeeded(rootDir, selectedModelIds, mode) {
  const saved = readJsonIfExists(selectionPath(rootDir), null);
  if (!Array.isArray(saved?.selectedModelIds)) {
    return;
  }
  const raw = saved.selectedModelIds
    .map((id) => String(id || "").trim())
    .filter(Boolean);
  if (sameStringArray(raw, selectedModelIds)) {
    return;
  }
  saveSelection(rootDir, selectedModelIds, mode);
}

function sameStringArray(left = [], right = []) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function normalizeSelection(rootDir, selectedModelIds, mode) {
  const models = currentSelectableModels(rootDir, mode);
  const available = new Set(models.map((model) => model.presetId));
  const firstByProvider = new Map();
  for (const model of models) {
    if (model.providerId && model.presetId && !firstByProvider.has(model.providerId)) {
      firstByProvider.set(model.providerId, model.presetId);
    }
  }
  const unique = [];
  for (const id of selectedModelIds || []) {
    const selectedId = normalizeLegacyKimiCodeModelReference(id);
    if (!selectedId || unique.includes(selectedId)) {
      continue;
    }
    if (available.has(selectedId)) {
      unique.push(selectedId);
      continue;
    }
    const providerId = providerIdForUnavailableSelection(rootDir, selectedId);
    const replacement = providerId ? firstByProvider.get(providerId) : "";
    if (replacement && !unique.includes(replacement)) {
      unique.push(replacement);
    }
  }
  return unique;
}

function repairSelectionAgainstModels(
  rootDir,
  selectedModelIds,
  mode,
  models = modelCatalog(rootDir),
  providers = providerCatalog(rootDir),
) {
  const selectableModels = mode === MODE_ALL_API
    ? models.filter((model) => (model.authMode || "api_key") !== "codex_openai")
    : models;
  const available = new Set(selectableModels.map((model) => model.presetId));
  const firstByProvider = new Map();
  for (const model of selectableModels) {
    if (model.providerId && model.presetId && !firstByProvider.has(model.providerId)) {
      firstByProvider.set(model.providerId, model.presetId);
    }
  }
  const repaired = [];
  for (const id of selectedModelIds || []) {
    const selectedId = normalizeLegacyKimiCodeModelReference(id);
    if (!selectedId || repaired.includes(selectedId)) {
      continue;
    }
    if (available.has(selectedId)) {
      repaired.push(selectedId);
      continue;
    }
    const providerId = providerIdForUnavailableSelection(rootDir, selectedId, providers);
    const replacement = providerId ? firstByProvider.get(providerId) : "";
    if (replacement && !repaired.includes(replacement)) {
      repaired.push(replacement);
    }
  }
  if (repaired.length) {
    return repaired;
  }
  const fallback = selectableModels.find((model) => available.has(model.presetId))?.presetId || "";
  return fallback ? [fallback] : [];
}

function providerIdForUnavailableSelection(
  rootDir,
  presetId,
  providers = providerCatalog(rootDir),
) {
  const id = normalizeLegacyKimiCodeModelReference(presetId);
  const known = MODEL_PRESETS.find((model) =>
    model.presetId === id ||
    model.model === id ||
    `cb-${model.presetId}` === id ||
    `cb-${model.model}` === id
  );
  if (known?.providerId) {
    return known.providerId;
  }
  const custom = readCustomModels(rootDir).find((model) =>
    model.presetId === id ||
    model.model === id ||
    `cb-${model.presetId}` === id ||
    `cb-${model.model}` === id
  );
  if (custom?.providerId) {
    return custom.providerId;
  }
  if (!id.startsWith("remote-")) {
    return "";
  }
  const suffix = id.slice("remote-".length);
  return providers
    .map((provider) => provider.id)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .find((providerId) => suffix === providerId || suffix.startsWith(`${providerId}-`)) || "";
}

const LEGACY_KIMI_CODE_MODEL_REFERENCES = new Map([
  ["remote-kimi-k3", "kimi-code-k3"],
  ["remote-kimi-k3-256k", "kimi-code-k3-256k"],
  ["remote-kimi-kimi-for-coding", "kimi-code-for-coding"],
  ["remote-kimi-kimi-for-coding-highspeed", "kimi-code-for-coding-highspeed"],
]);

function normalizeLegacyKimiCodeModelReference(value) {
  const id = String(value || "").trim();
  const hasRoutePrefix = id.startsWith(CODEX_BRIDGE_MODEL_ID_PREFIX);
  const sourceId = hasRoutePrefix
    ? id.slice(CODEX_BRIDGE_MODEL_ID_PREFIX.length)
    : id;
  const migrated = LEGACY_KIMI_CODE_MODEL_REFERENCES.get(sourceId) || sourceId;
  return hasRoutePrefix ? `${CODEX_BRIDGE_MODEL_ID_PREFIX}${migrated}` : migrated;
}

function normalizeDesktopRouteReferences(
  rootDir,
  desktopOptions = {},
  routes = [],
  providers = providerCatalog(rootDir),
) {
  const firstRouteId = routes[0]?.id || "";
  const requestedAuxiliaryRouteId = String(desktopOptions.codexAuxiliaryModelId || "").trim();
  const auxiliaryRouteId = requestedAuxiliaryRouteId
    ? resolveDesktopRouteReference(rootDir, requestedAuxiliaryRouteId, routes, providers) || firstRouteId
    : "";
  return {
    ...desktopOptions,
    codexAuxiliaryModelId: auxiliaryRouteId,
    smartRouting: normalizeDesktopSmartRoutingRouteReferences(
      rootDir,
      desktopOptions.smartRouting,
      routes,
      providers,
    ),
  };
}

function normalizeDesktopSmartRoutingRouteReferences(
  rootDir,
  smartRouting = {},
  routes = [],
  providers = providerCatalog(rootDir),
) {
  const normalized = normalizeDesktopSmartRouting(smartRouting);
  const autoSelectRules = Object.fromEntries(
    DESKTOP_SMART_RULE_KEYS.map((key) => {
      const rule = normalizeDesktopSmartRule(normalized.autoSelectRules?.[key]);
      const routeId = rule.routeId
        ? resolveDesktopRouteReference(rootDir, rule.routeId, routes, providers)
        : "";
      if (rule.mode === "route" && !routeId) {
        return [key, { mode: "auto", routeId: "" }];
      }
      return [key, {
        mode: rule.mode,
        routeId,
      }];
    }),
  );
  const failover = normalizeDesktopSmartFailover(normalized.failover);
  const routeIds = [];
  for (const routeId of failover.routeIds) {
    const resolved = resolveDesktopRouteReference(rootDir, routeId, routes, providers);
    if (resolved && !routeIds.includes(resolved)) {
      routeIds.push(resolved);
    }
  }
  return {
    autoSelectRules,
    failover: {
      mode: failover.mode === "ordered" && !routeIds.length ? "auto" : failover.mode,
      routeIds,
    },
  };
}

function resolveDesktopRouteReference(
  rootDir,
  routeId,
  routes = [],
  providers = providerCatalog(rootDir),
) {
  const id = normalizeLegacyKimiCodeModelReference(routeId);
  if (!id) {
    return "";
  }
  if (routes.some((route) => route.id === id)) {
    return id;
  }
  const sourcePresetId = id.startsWith(CODEX_BRIDGE_MODEL_ID_PREFIX)
    ? id.slice(CODEX_BRIDGE_MODEL_ID_PREFIX.length)
    : id;
  const providerId = providerIdForUnavailableSelection(rootDir, sourcePresetId, providers);
  if (!providerId) {
    return "";
  }
  return routes.find((route) => route.provider === providerId)?.id || "";
}

function persistDesktopRouteReferencesIfNeeded(rootDir, before = {}, after = {}) {
  const beforeRefs = desktopRouteReferenceSnapshot(before);
  const afterRefs = desktopRouteReferenceSnapshot(after);
  if (JSON.stringify(beforeRefs) === JSON.stringify(afterRefs)) {
    return;
  }
  saveDesktopOptions(rootDir, {
    codexAuxiliaryModelId: after.codexAuxiliaryModelId || "",
    smartRouting: after.smartRouting,
  });
}

function desktopRouteReferenceSnapshot(options = {}) {
  return {
    codexAuxiliaryModelId: String(options.codexAuxiliaryModelId || "").trim(),
    smartRouting: normalizeDesktopSmartRouting(options.smartRouting),
  };
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
  if (model.authMode === "codex_openai" && upstreamModel) {
    return `${CODEX_BRIDGE_MODEL_ID_PREFIX}${slugify(upstreamModel)}`;
  }
  const source = model.presetId || upstreamModel || model.displayName || "model";
  return `${CODEX_BRIDGE_MODEL_ID_PREFIX}${slugify(source)}`;
}

function routeForSelectedModel(
  model,
  priority,
  imageGenerationOverrides = {},
  imageProviderConfig = { providers: [], defaultProviderId: "" },
  rootDir = "",
) {
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
    imageGeneration: imageGenerationForModel(
      model,
      imageGenerationOverrides[model.presetId],
      imageProviderConfig,
      rootDir,
    ),
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
  const baseUrl = String(model.baseUrl || provider?.baseUrl || "").toLowerCase();
  if (providerId === "codex" || providerId === "openai") {
    return "openai";
  }
  if (providerId === "deepseek") {
    return "deepseek";
  }
  if (providerId === "anthropic") {
    return "anthropic";
  }
  if (providerId === "xai") {
    return "xai";
  }
  if (providerId === "gemini") {
    return "gemini";
  }
  if (providerId === "kimi" || providerId === "moonshot") {
    return "kimi";
  }
  if (providerId === "minimax") {
    return "minimax";
  }
  if (
    providerId === "volcengine" ||
    baseUrl.includes("ark.cn-") ||
    baseUrl.includes("volces.com")
  ) {
    return "doubao";
  }
  if (providerId === "qwen") {
    return "qwen";
  }
  if (providerId === "qianfan") {
    return "baidu";
  }
  if (providerId === "zhipu") {
    return "zhipu";
  }
  if (providerId === "openrouter") {
    return "openrouter";
  }
  if (providerId === "siliconflow") {
    return "siliconflow";
  }
  if (providerId === "xiaomi" || providerId === "stepfun" || providerId === "hunyuan") {
    return "openai-compatible";
  }
  if (Boolean(model.custom) || String(model.providerName || provider?.name || "").toLowerCase().includes("custom")) {
    return "custom";
  }
  return "openai-compatible";
}

function imageGenerationForModel(
  model = {},
  override,
  imageProviderConfig = { providers: [], defaultProviderId: "" },
  rootDir = "",
) {
  if (override) {
    const overrideMode = String(override.mode || "").trim().toLowerCase();
    if (overrideMode === "provider") {
      return imageGenerationWithOutputDir(
        imageGenerationForProvider(
          imageProviderById(imageProviderConfig, override.providerId),
        ),
        rootDir,
      );
    }
    if (overrideMode === "inherit") {
      const inherited = inheritedImageGenerationForModel(model, imageProviderConfig);
      if (inherited) {
        return imageGenerationWithOutputDir(inherited, rootDir);
      }
    }
    if (overrideMode === "official" && !modelAllowsOfficialImageGeneration(model)) {
      return normalizeImageGenerationSettings({ mode: "off" });
    }
    return imageGenerationWithOutputDir(normalizeImageGenerationSettings(override), rootDir);
  }
  const inherited = inheritedImageGenerationForModel(model, imageProviderConfig);
  if (inherited) {
    return imageGenerationWithOutputDir(inherited, rootDir);
  }
  return imageGenerationWithOutputDir(
    normalizeImageGenerationSettings(defaultImageGenerationForModel(model)),
    rootDir,
  );
}

function defaultImageGenerationForModel(model = {}) {
  if (modelAllowsOfficialImageGeneration(model)) {
    return { mode: "official" };
  }
  return { mode: "off" };
}

function inheritedImageGenerationForModel(model = {}, imageProviderConfig = {}) {
  if (modelAllowsOfficialImageGeneration(model)) {
    return null;
  }
  const provider = defaultImageProviderForGeneration(imageProviderConfig);
  return provider ? imageGenerationForProvider(provider) : null;
}

function defaultImageProviderForGeneration(config = {}) {
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const enabledProviders = providers.filter((provider) => provider?.enabled !== false);
  const defaultProvider = enabledProviders.find((provider) => provider.id === config.defaultProviderId);
  if (defaultProvider) {
    return defaultProvider;
  }
  return enabledProviders.sort(compareImageProviderPriority)[0] || null;
}

function imageProviderById(config = {}, providerId, options = {}) {
  const id = String(providerId || "").trim();
  if (!id) {
    return null;
  }
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const provider = providers.find((item) => item.id === id) || null;
  if (!provider || (provider.enabled === false && !options.includeDisabled)) {
    return null;
  }
  return provider;
}

function compareImageProviderPriority(left = {}, right = {}) {
  const priorityDiff = Number(right.priority || 0) - Number(left.priority || 0);
  if (priorityDiff) {
    return priorityDiff;
  }
  return String(left.id || "").localeCompare(String(right.id || ""));
}

function imageGenerationForProvider(provider) {
  if (!provider) {
    return normalizeImageGenerationSettings({ mode: "off" });
  }
  return normalizeImageGenerationSettings({
    mode: "custom",
    providerId: provider.id,
    adapter: provider.adapter,
    displayName: provider.name,
    baseUrl: provider.baseUrl,
    endpoint: provider.endpoint,
    model: provider.model,
    size: provider.size,
    apiKeyEnv: provider.apiKeyEnv,
    defaults: provider.defaults,
    response: provider.response,
    request: provider.request,
    headers: provider.headers,
  });
}

function imageGenerationWithOutputDir(settings, rootDir = "") {
  if (!settings?.enabled || !["custom", "official"].includes(settings.mode)) {
    return settings;
  }
  if (!rootDir) {
    return settings;
  }
  const outputDir = settings.outputDir || imageOutputDirPath(rootDir);
  const historyPath = settings.historyPath || imageGenerationHistoryPath(rootDir);
  if (settings.outputDir === outputDir && settings.historyPath === historyPath) {
    return settings;
  }
  return {
    ...settings,
    outputDir,
    historyPath,
  };
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
      size: hasOwn(input, "size") ? String(input.size || "").trim() : "1024x1024",
      apiKeyEnv: "",
    };
  }
  if (mode === "inherit") {
    return {
      enabled: true,
      mode: "inherit",
    };
  }
  if (mode === "provider") {
    const providerId = String(input.providerId || "").trim();
    if (!providerId) {
      throw new Error("Image provider id is required.");
    }
    return {
      enabled: true,
      mode: "provider",
      providerId,
    };
  }
  if (mode === "custom") {
    const baseUrl = String(input.baseUrl || "").trim().replace(/\/+$/, "");
    const model = String(input.model || "").trim();
    const apiKeyEnv = providerApiKeyEnv(
      input.apiKeyEnv || "IMAGE_GENERATION_API_KEY",
    );
    if (!baseUrl || !model || !apiKeyEnv) {
      throw new Error("Custom image generation requires Base URL, model, and API key env.");
    }
    assertCredentialFreeProviderUrl(baseUrl);
    const defaults = plainObject(input.defaults);
    const response = plainObject(input.response);
    const request = normalizeImageProviderRequest(input.request);
    const headers = normalizeImageProviderHeaders(input.headers);
    for (const nested of [defaults, response, request, headers]) {
      if (Object.keys(nested).length) {
        assertCredentialFreeProviderObject(nested);
      }
    }
    return {
      enabled: true,
      mode: "custom",
      displayName: String(input.displayName || "Custom Image Generation").trim(),
      baseUrl,
      endpoint: normalizeEndpoint(input.endpoint || "/images/generations"),
      model,
      size: hasOwn(input, "size") ? String(input.size || "").trim() : "1024x1024",
      apiKeyEnv,
      ...(input.providerId ? { providerId: String(input.providerId).trim() } : {}),
      ...(input.adapter ? { adapter: String(input.adapter).trim() } : {}),
      ...(Object.keys(defaults).length ? { defaults } : {}),
      ...(Object.keys(response).length ? { response } : {}),
      ...(Object.keys(request).length ? { request } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(input.outputDir ? { outputDir: String(input.outputDir).trim() } : {}),
      ...(input.historyPath ? { historyPath: String(input.historyPath).trim() } : {}),
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
    ...(input.outputDir ? { outputDir: String(input.outputDir).trim() } : {}),
    ...(input.historyPath ? { historyPath: String(input.historyPath).trim() } : {}),
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
  assertCredentialFreeProviderUrl(baseUrl);
  const providerId = String(input.providerId || "").trim() || `custom-${slugify(providerName)}`;
  const keyEnv = providerApiKeyEnv(
    input.keyEnv || input.apiKeyEnv || `${slugifyEnv(providerName)}_API_KEY`,
  );
  const dropParams = normalizeCustomDropParams(input.dropParams);
  for (const urlValue of [input.keyUrl, input.docsUrl, input.logoUrl]) {
    if (urlValue) {
      assertCredentialFreeProviderUrl(urlValue);
    }
  }
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
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    return null;
  }
  const sanitized = sanitizeLegacyProviderCredentials(model);
  let normalized;
  try {
    normalized = normalizeCustomModel(sanitized);
  } catch {
    return null;
  }
  for (const optionalUrlField of ["keyUrl", "docsUrl", "logoUrl"]) {
    if (!Object.hasOwn(sanitized, optionalUrlField)) {
      delete normalized[optionalUrlField];
    }
  }
  if (isLegacyDefaultCustomDropParams(normalized.dropParams)) {
    const cleaned = { ...normalized };
    delete cleaned.dropParams;
    return cleaned;
  }
  return normalized;
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
    const legacyKimiCode = isLegacyKimiCodeProvider(providerId, entry);
    const targetProviderId = legacyKimiCode ? "kimi-code" : providerId;
    if (legacyKimiCode && providers[targetProviderId]) {
      continue;
    }
    const providerName = String(entry.providerName || targetProviderId).trim();
    providers[targetProviderId] = {
      providerId: targetProviderId,
      providerName: legacyKimiCode && providerName === "Kimi"
        ? "Kimi Code"
        : providerName,
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
  try {
    const parsed = new URL(baseUrl);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    const endpointSuffix = [
      "/v1/responses/compact",
      "/responses/compact",
      "/v1/chat/completions",
      "/chat/completions",
      "/v1/responses",
      "/responses",
    ].find((suffix) => pathname.toLowerCase().endsWith(suffix));
    if (endpointSuffix) {
      const prefix = pathname.slice(0, -endpointSuffix.length).replace(/\/+$/, "");
      const versionPrefix = endpointSuffix.startsWith("/v1/") ? "/v1" : "";
      parsed.pathname = `${prefix}${versionPrefix}/models`;
    } else {
      parsed.pathname = `${pathname}/models`;
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return `${baseUrl}/models`;
  }
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
  return ["api_key", "anthropic_api_key"].includes(authMode)
    && Boolean(provider.keyEnv || provider.apiKeyEnv);
}

function providerApiHeaders(provider = {}, apiKey = "") {
  const headers = { Accept: "application/json" };
  if (!apiKey) return headers;
  if (
    (provider.authMode || "") === "anthropic_api_key"
    || provider.api === "anthropic_messages"
  ) {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = provider.anthropicVersion || "2023-06-01";
    return headers;
  }
  headers.Authorization = `Bearer ${apiKey}`;
  return headers;
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
      if (item.owned_by || item.ownedBy) {
        model.ownedBy = String(item.owned_by || item.ownedBy);
      }
      if (Number.isFinite(Number(item.created))) {
        model.created = Number(item.created);
      }
      const displayName = String(
        item.display_name || item.displayName || item.title || (item.id ? item.name : "") || "",
      ).trim();
      if (displayName) {
        model.displayName = displayName;
      }
      for (const [target, aliases] of Object.entries({
        modelType: ["model_type", "modelType", "type"],
        taskType: ["task_type", "taskType"],
        endpointType: ["endpoint_type", "endpointType"],
        category: ["category"],
      })) {
        const value = aliases
          .map((key) => item[key])
          .find((candidate) => typeof candidate === "string" && candidate.trim());
        if (value) {
          model[target] = value.trim();
        }
      }
      if (Array.isArray(item.capabilities)) {
        model.capabilities = item.capabilities
          .filter((value) => typeof value === "string" && value.trim())
          .map((value) => value.trim());
      }
    }
    models.push(model);
  }
  return models;
}

function mergeOfficialProviderDirectoryModels(provider = {}, remoteModels = []) {
  const officialModels = officialProviderDirectoryModels(provider);
  if (!officialModels.length) {
    return remoteModels;
  }
  const byId = new Map();
  for (const model of [...officialModels, ...remoteModels]) {
    const id = String(model?.id || "").trim();
    if (!id) {
      continue;
    }
    byId.set(id, {
      ...(byId.get(id) || {}),
      ...model,
      id,
    });
  }
  return [...byId.values()];
}

function officialProviderDirectoryModels(provider = {}) {
  if (String(provider.id || "").trim() !== "kimi-code") {
    return [];
  }
  try {
    const baseUrl = new URL(String(provider.baseUrl || "").trim());
    if (
      baseUrl.hostname.toLowerCase() !== "api.kimi.com"
      || !/^\/coding\/v1\/?$/i.test(baseUrl.pathname)
    ) {
      return [];
    }
  } catch {
    return [];
  }
  return [
    { id: "k3", displayName: "Kimi K3", modelType: "chat" },
    { id: "k3-256k", displayName: "Kimi K3 256K", modelType: "chat" },
    { id: "kimi-for-coding", displayName: "Kimi For Coding", modelType: "chat" },
    {
      id: "kimi-for-coding-highspeed",
      displayName: "Kimi For Coding Highspeed",
      modelType: "chat",
    },
  ];
}

function providerModelRefreshKey(rootDir, providerId) {
  return `${comparablePath(rootDir)}\u0000${String(providerId || "").trim()}`;
}

function beginProviderModelRefresh(rootDir, providerId) {
  const key = providerModelRefreshKey(rootDir, providerId);
  const token = Symbol("providerModelRefreshToken");
  providerModelRefreshRequests.set(key, token);
  return { key, token };
}

function attachProviderModelRefreshRequest(result, request) {
  Object.defineProperty(result, PROVIDER_MODEL_REFRESH_REQUEST, {
    value: request,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return result;
}

function providerModelRefreshIsCurrent(rootDir, providerId, result) {
  const request = result?.[PROVIDER_MODEL_REFRESH_REQUEST];
  const key = providerModelRefreshKey(rootDir, providerId);
  return Boolean(
    request &&
    request.key === key &&
    providerModelRefreshRequests.get(key) === request.token
  );
}

function completeProviderModelRefresh(result) {
  const request = result?.[PROVIDER_MODEL_REFRESH_REQUEST];
  if (request && providerModelRefreshRequests.get(request.key) === request.token) {
    providerModelRefreshRequests.delete(request.key);
  }
}

function staleProviderModelRefreshError() {
  const error = new Error("A newer provider model directory refresh superseded this request.");
  error.code = "provider_refresh_stale";
  return error;
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

function modelDirectoryRefreshErrorMessage(error, { secretValues = [] } = {}) {
  const safeMessage = redactKnownSecretValues(
    error?.message || String(error),
    secretValues,
  );
  const causeCode = String(error?.cause?.code || error?.code || "").trim().toUpperCase();
  if (error?.code === "provider_response_too_large") {
    return "模型列表响应过大（too large），CodexBridge 已停止读取，原有模型列表已保留。";
  }
  if (error?.code === "provider_model_directory_timeout") {
    return "模型服务响应超时，请检查 Base URL、网络或系统代理后重试；原有模型列表已保留。（诊断码：provider_models_timeout）";
  }
  if ([
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "ETIMEDOUT",
  ].includes(causeCode)) {
    return "无法连接模型服务：连接超时。请检查 Base URL、网络或系统代理后重试；原有模型列表已保留。（诊断码：provider_models_connect_timeout）";
  }
  if ([
    "ENOTFOUND",
    "EAI_AGAIN",
  ].includes(causeCode)) {
    return "无法连接模型服务：域名解析失败。请检查 Base URL、DNS 或系统代理后重试；原有模型列表已保留。（诊断码：provider_models_dns_error）";
  }
  if ([
    "CERT_HAS_EXPIRED",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "ERR_TLS_CERT_ALTNAME_INVALID",
  ].includes(causeCode)) {
    return "无法连接模型服务：HTTPS 证书校验失败。请检查 Base URL、证书或代理后重试；原有模型列表已保留。（诊断码：provider_models_tls_error）";
  }
  if (
    safeMessage.toLowerCase() === "fetch failed" ||
    [
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "UND_ERR_SOCKET",
    ].includes(causeCode)
  ) {
    return "无法连接模型服务。请检查 Base URL、网络、DNS 或系统代理后重试；原有模型列表已保留。（诊断码：provider_models_network_error）";
  }
  return safeMessage.length > 320
    ? `${safeMessage.slice(0, 317)}...`
    : safeMessage;
}

function redactKnownSecretValues(value, secretValues = []) {
  let text = String(value || "");
  for (const secret of secretValues) {
    if (typeof secret === "string" && secret) {
      text = text.split(secret).join("[REDACTED]");
    }
  }
  return redactSecretText(text);
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
  const matrix = routeCapabilityMatrix(route);
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
    matrix,
    summary: routeCapabilitySummary(route),
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
  const acceptanceReleaseDir = String(options.acceptanceReleaseDir || "").trim();
  const codexDesktopExe = String(options.codexDesktopExe || "").trim();
  const codexDesktopLaunchTarget = String(options.codexDesktopLaunchTarget || "").trim();
  return {
    bypassSystemProxy: Boolean(options.bypassSystemProxy),
    routerPort,
    localRateLimitEnabled: Boolean(options.localRateLimitEnabled),
    duplicateRequestProtection:
      Number(options.duplicateRequestProtectionPolicyVersion) ===
        DUPLICATE_REQUEST_PROTECTION_POLICY_VERSION &&
      options.duplicateRequestProtection === true,
    duplicateRequestProtectionPolicyVersion:
      DUPLICATE_REQUEST_PROTECTION_POLICY_VERSION,
    interceptCodexAuxiliaryTasks: Boolean(options.interceptCodexAuxiliaryTasks),
    codexAuxiliaryModelId: String(options.codexAuxiliaryModelId || "").trim(),
    autoSelectModel: Boolean(options.autoSelectModel),
    autoFailover: Boolean(options.autoFailover),
    smartRouting: normalizeDesktopSmartRouting(options.smartRouting),
    usageBudgets: normalizeUsageBudgetOptions(options.usageBudgets),
    acceptanceReleaseDir,
    codexDesktopExe,
    codexDesktopLaunchTarget,
  };
}

function mergeDesktopSmartRouting(current = {}, incoming = {}) {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return normalizeDesktopSmartRouting(current);
  }
  return normalizeDesktopSmartRouting({
    ...current,
    ...incoming,
    autoSelectRules: {
      ...(current?.autoSelectRules || {}),
      ...(incoming.autoSelectRules || {}),
    },
    failover: {
      ...(current?.failover || {}),
      ...(incoming.failover || {}),
    },
  });
}

function normalizeDesktopSmartRouting(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const sourceRules = source.autoSelectRules && typeof source.autoSelectRules === "object" && !Array.isArray(source.autoSelectRules)
    ? source.autoSelectRules
    : {};
  return {
    autoSelectRules: Object.fromEntries(
      DESKTOP_SMART_RULE_KEYS.map((key) => [key, normalizeDesktopSmartRule(sourceRules[key])]),
    ),
    failover: normalizeDesktopSmartFailover(source.failover),
  };
}

function normalizeDesktopSmartRule(rule = {}) {
  const source = rule && typeof rule === "object" && !Array.isArray(rule) ? rule : {};
  const mode = DESKTOP_SMART_RULE_MODES.has(source.mode) ? source.mode : "auto";
  return {
    mode,
    routeId: String(source.routeId || "").trim(),
  };
}

function normalizeDesktopSmartFailover(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const mode = DESKTOP_SMART_FAILOVER_MODES.has(source.mode) ? source.mode : "auto";
  const routeIds = Array.isArray(source.routeIds)
    ? source.routeIds
    : typeof source.routeIds === "string"
      ? source.routeIds.split(",")
      : [];
  return {
    mode,
    routeIds: [...new Set(routeIds.map((routeId) => String(routeId || "").trim()).filter(Boolean))],
  };
}

function routerSmartRoutingOptionsFromDesktopOptions(desktopOptions = {}) {
  const normalized = normalizeDesktopSmartRouting(desktopOptions.smartRouting);
  const smartRouting = {
    autoSelectModel: Boolean(desktopOptions.autoSelectModel),
    autoFailover: Boolean(desktopOptions.autoFailover),
  };
  if (hasDesktopSmartRoutingPolicy(normalized)) {
    smartRouting.autoSelectRules = normalized.autoSelectRules;
    smartRouting.failover = normalized.failover;
  }
  return smartRouting;
}

function hasDesktopSmartRoutingPolicy(smartRouting = {}) {
  const rules = smartRouting.autoSelectRules || {};
  const hasRulePolicy = DESKTOP_SMART_RULE_KEYS.some((key) => {
    const rule = normalizeDesktopSmartRule(rules[key]);
    return rule.mode !== "auto" || Boolean(rule.routeId);
  });
  const failover = normalizeDesktopSmartFailover(smartRouting.failover);
  return hasRulePolicy || failover.mode !== "auto" || failover.routeIds.length > 0;
}

function normalizeUsageBudgetOptions(input = {}) {
  if (!input || typeof input !== "object") {
    return {};
  }
  const result = {};
  const global = normalizeUsageBudgetScope(input.global || {});
  if (Object.keys(global).length) {
    result.global = global;
  }
  const routes = normalizeUsageBudgetMap(input.routes);
  if (Object.keys(routes).length) {
    result.routes = routes;
  }
  const providers = normalizeUsageBudgetMap(input.providers);
  if (Object.keys(providers).length) {
    result.providers = providers;
  }
  return result;
}

function normalizeUsageBudgetMap(input = {}) {
  const result = {};
  if (!input || typeof input !== "object") {
    return result;
  }
  for (const [key, value] of Object.entries(input)) {
    const scope = normalizeUsageBudgetScope(value);
    if (String(key || "").trim() && Object.keys(scope).length) {
      result[String(key).trim()] = scope;
    }
  }
  return result;
}

function normalizeUsageBudgetScope(input = {}) {
  const result = {};
  const dailyTokenLimit = positiveUsageBudgetNumber(input.dailyTokenLimit);
  const dailyCallLimit = positiveUsageBudgetNumber(input.dailyCallLimit);
  const dailyCostLimit = positiveUsageCostNumber(input.dailyCostLimit);
  const inputCostPerMillion = positiveUsageCostNumber(input.inputCostPerMillion);
  const cacheCostPerMillion = positiveUsageCostNumber(input.cacheCostPerMillion);
  const outputCostPerMillion = positiveUsageCostNumber(input.outputCostPerMillion);
  if (dailyTokenLimit) {
    result.dailyTokenLimit = dailyTokenLimit;
  }
  if (dailyCallLimit) {
    result.dailyCallLimit = dailyCallLimit;
  }
  if (dailyCostLimit) {
    result.dailyCostLimit = dailyCostLimit;
  }
  if (inputCostPerMillion) {
    result.inputCostPerMillion = inputCostPerMillion;
  }
  if (cacheCostPerMillion) {
    result.cacheCostPerMillion = cacheCostPerMillion;
  }
  if (outputCostPerMillion) {
    result.outputCostPerMillion = outputCostPerMillion;
  }
  return result;
}

function positiveUsageBudgetNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function positiveUsageCostNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number * 1_000_000) / 1_000_000 : 0;
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

function checkItem({ id, label, status, detail, action = "", count = null, blockingClass = "" } = {}) {
  const normalizedStatus = ["pass", "warn", "fail"].includes(status) ? status : "warn";
  return {
    id: String(id || ""),
    label: String(label || id || ""),
    status: normalizedStatus,
    detail: String(detail || ""),
    action: String(action || ""),
    count: count !== null && count !== undefined && Number.isFinite(Number(count)) ? Number(count) : null,
    ...(blockingClass ? { blockingClass: String(blockingClass) } : {}),
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
