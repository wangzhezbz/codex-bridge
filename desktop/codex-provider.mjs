export const CODEX_BRIDGE_PROVIDER_ID = "codexbridge";
export const CODEX_OPENAI_HISTORY_PROVIDER_ID = "openai";
export const CODEX_BRIDGE_LOCAL_AUTH_TOKEN = "sk-local-codex-router";

export function codexBridgeProviderTomlLines({
  port = 15722,
  requiresOpenAiAuth = true,
} = {}) {
  const routerPort = Number.isInteger(Number(port)) && Number(port) > 0
    ? Number(port)
    : 15722;
  const prefix = `model_providers.${CODEX_BRIDGE_PROVIDER_ID}`;
  const authLines = requiresOpenAiAuth
    ? [`${prefix}.requires_openai_auth = true`]
    : [
        `${prefix}.requires_openai_auth = false`,
        `${prefix}.http_headers = { Authorization = "Bearer ${CODEX_BRIDGE_LOCAL_AUTH_TOKEN}" }`,
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

export function codexBridgeProviderTomlLinesForMode({ port = 15722, mode } = {}) {
  if (mode === "hybrid") {
    const routerPort = Number.isInteger(Number(port)) && Number(port) > 0
      ? Number(port)
      : 15722;
    return [`openai_base_url = "http://127.0.0.1:${routerPort}/v1"`];
  }
  if (mode === "all_api") {
    return codexBridgeProviderTomlLines({ port, requiresOpenAiAuth: false });
  }
  throw new Error(
    `Unsupported CodexBridge provider mode ${JSON.stringify(mode)}. Expected "hybrid" or "all_api".`,
  );
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
