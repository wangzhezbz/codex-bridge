import diagnostics from "./thread-provider-diagnostics.cjs";
import { canonicalModelReference } from "../shared/model-preset-aliases.cjs";

export const CODEX_BRIDGE_PROVIDER_ID = "codexbridge";
export const CODEX_OPENAI_HISTORY_PROVIDER_ID = "openai";
export const CODEX_BRIDGE_LEGACY_LOCAL_AUTH_TOKEN = "sk-local-codex-router";

export function selectedApiModelsForRecovery(currentIds, expectedIds, models) {
  return selectedModelsForModeSwitch(currentIds, expectedIds, models, "all_api");
}

export function selectedModelsForModeSwitch(currentIds, expectedIds, models, mode) {
  if (mode !== "hybrid" && mode !== "all_api") throw new Error("不支持的计费模式。");
  const configuredIds = new Set(models.map((model) => model.presetId));
  // Both the UI preflight and the in-lock recheck compare logical identity.
  // An explicitly configured legacy slot still takes precedence over an alias.
  const resolveId = (id) => configuredIds.has(id) ? id : canonicalModelReference(id);
  if (!Array.isArray(currentIds) || !Array.isArray(expectedIds) ||
      currentIds.length !== expectedIds.length ||
      !currentIds.every((id, index) => typeof id === "string" && id &&
        typeof expectedIds[index] === "string" && expectedIds[index] &&
        resolveId(id) === resolveId(expectedIds[index]))) {
    throw new Error("模型列表已变化，请刷新后重新确认切换计费模式。");
  }
  const available = new Set(models.filter((model) => mode === "hybrid" || (model.authMode || "api_key") !== "codex_openai")
    .map((model) => model.presetId));
  const selected = [...new Set(currentIds.map(resolveId).filter((id) => available.has(id)))];
  if (!selected.length) throw new Error(mode === "all_api"
    ? "当前未选择 API 模型，请先在模型页选择并保存第三方 API 模型。"
    : "当前未选择可用模型，请先在模型页选择并保存模型。");
  return selected;
}

export function codexBridgeProviderTomlLines({
  port = 15722,
  requiresOpenAiAuth = true,
  authToken = "",
} = {}) {
  const routerPort = Number.isInteger(Number(port)) && Number(port) > 0
    ? Number(port)
    : 15722;
  const prefix = `model_providers.${CODEX_BRIDGE_PROVIDER_ID}`;
  const localAuthToken = String(authToken || "").trim();
  if (!requiresOpenAiAuth && !localAuthToken) {
    throw new Error("authToken is required when requiresOpenAiAuth is false.");
  }
  const authLines = requiresOpenAiAuth
    ? [`${prefix}.requires_openai_auth = true`]
    : [
        `${prefix}.requires_openai_auth = false`,
        `${prefix}.http_headers = { Authorization = "Bearer ${escapeTomlString(localAuthToken)}" }`,
      ];
  return [
    `${prefix}.name = "CodexBridge"`,
    `${prefix}.base_url = "http://127.0.0.1:${routerPort}/v1"`,
    `${prefix}.wire_api = "responses"`,
    ...authLines,
    `${prefix}.request_max_retries = 0`,
    `${prefix}.stream_max_retries = 0`,
    `${prefix}.stream_idle_timeout_ms = 600000`,
  ];
}

export function codexBridgeProviderTomlLinesForMode({
  port = 15722,
  mode,
  authToken = "",
} = {}) {
  if (mode === "hybrid") {
    const routerPort = Number.isInteger(Number(port)) && Number(port) > 0
      ? Number(port)
      : 15722;
    return [`openai_base_url = "http://127.0.0.1:${routerPort}/v1"`];
  }
  if (mode === "all_api") {
    return codexBridgeProviderTomlLines({
      port,
      requiresOpenAiAuth: false,
      authToken,
    });
  }
  throw new Error(
    `Unsupported CodexBridge provider mode ${JSON.stringify(mode)}. Expected "hybrid" or "all_api".`,
  );
}

function escapeTomlString(value) {
  return String(value || "")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
}

export function codexBridgeProviderIdForMode(mode) {
  if (mode === "hybrid") {
    return CODEX_OPENAI_HISTORY_PROVIDER_ID;
  }
  if (mode === "all_api") {
    return CODEX_BRIDGE_PROVIDER_ID;
  }
  throw new Error(
    `Unsupported CodexBridge provider mode ${JSON.stringify(mode)}. Expected "hybrid" or "all_api".`,
  );
}

const HISTORY_PROVIDER_IDS = new Set(["openai", "codexbridge", "codex-bridge"]);
const THREAD_ID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function planThreadProviderCompatibility(sessions, { mode, completed = {} } = {}) {
  const provider = codexBridgeProviderIdForMode(mode);
  const seen = new Set();
  return (Array.isArray(sessions) ? sessions : []).flatMap((session) => {
    const { id, model, modelProvider, source, threadSource } = session || {};
    if (!THREAD_ID_PATTERN.test(id || "") || seen.has(id) ||
        !HISTORY_PROVIDER_IDS.has(modelProvider) ||
        !["vscode", "cli"].includes(source) ||
        (threadSource && threadSource !== "user") || session.archived ||
        (!session.hasUserEvent && threadSource !== "user") || typeof model !== "string" || !model.trim() ||
        model.length > 256 || /[\r\n\0]/.test(model)) return [];
    seen.add(id);
    if (completed[id]?.provider === provider && completed[id]?.model === model) return [];
    return [{ id, model, provider }];
  });
}

// Saving the unchanged model makes the resumed provider durable in the native
// owned-settings snapshot. Changing only config.toml or only resuming does not.
export async function repairThreadProviderCompatibility({ rpc, candidates, onUpdated = () => {} } = {}) {
  if (typeof rpc !== "function" || !Array.isArray(candidates) || candidates.some((item) =>
    !THREAD_ID_PATTERN.test(item?.id || "") || !["openai", "codexbridge"].includes(item?.provider) ||
    typeof item?.model !== "string" || !item.model.trim() || item.model.length > 256 || /[\r\n\0]/.test(item.model))) {
    throw new TypeError("Invalid thread provider compatibility candidates.");
  }
  const updated = [], failed = [];
  for (const candidate of candidates) {
    const { id: threadId, model, provider } = candidate;
    let resumed = false;
    let failureCode = "thread_provider_rpc_failed";
    try {
      const before = await rpc("thread/read", { threadId, includeTurns: false });
      if (before?.thread?.id !== threadId || !HISTORY_PROVIDER_IDS.has(before?.thread?.modelProvider)) {
        failureCode = "thread_identity_changed";
        throw new Error(failureCode);
      }
      const result = await rpc("thread/resume", { threadId, model, modelProvider: provider, excludeTurns: true });
      resumed = true;
      if (result?.thread?.id !== threadId) failureCode = "thread_identity_changed";
      else if (result?.model !== model) failureCode = "thread_model_changed";
      else if (result?.modelProvider !== provider) failureCode = "thread_provider_not_applied";
      else failureCode = "";
      if (failureCode) throw new Error(failureCode);
      failureCode = "thread_settings_save_failed";
      await rpc("thread/settings/update", { threadId, model });
      failureCode = "thread_provider_receipt_failed";
      await onUpdated(candidate);
      updated.push(candidate);
    } catch (error) {
      failed.push({ id: threadId, code: error?.code === -32601 && failureCode === "thread_settings_save_failed"
        ? "thread_settings_unsupported" : diagnostics.compatibilityFailureCode(error, failureCode) });
    } finally {
      if (resumed) {
        try { await rpc("thread/unsubscribe", { threadId }); } catch { /* Private helper connection is closed by its owner. */ }
      }
    }
  }
  return { ok: failed.length === 0, updated, failed };
}
