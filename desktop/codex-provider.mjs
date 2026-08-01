export const CODEX_BRIDGE_PROVIDER_ID = "codexbridge";
export const CODEX_OPENAI_HISTORY_PROVIDER_ID = "openai";
export const CODEX_BRIDGE_LEGACY_LOCAL_AUTH_TOKEN = "sk-local-codex-router";

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
