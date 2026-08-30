import { authModeForRoute, requireApiKey } from "./config.js";

const CODEX_EXACT_PASSTHROUGH_HEADERS = [
  "user-agent",
  "chatgpt-account-id",
  "x-openai-fedramp",
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-codex-beta-features",
  "x-codex-turn-state",
  "x-codex-turn-metadata",
  "x-codex-parent-thread-id",
  "x-codex-window-id",
  "x-codex-installation-id",
  "x-oai-attestation",
  "x-responsesapi-include-timing-metrics",
  "x-openai-internal-codex-responses-lite",
  "openai-beta",
  "openai-organization",
  "openai-project",
];

const CODEX_PASSTHROUGH_HEADER_PREFIXES = [
  "chatgpt-",
  "openai-",
  "x-codex-",
  "x-oai-",
  "x-openai-",
];

const CODEX_PASSTHROUGH_BLOCKED_HEADERS = new Set([
  "accept",
  "authorization",
  "connection",
  "content-encoding",
  "content-length",
  "content-type",
  "host",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function upstreamHeaders(route, context = {}, options = {}) {
  const anthropicAuth = authModeForRoute(route) === "anthropic_api_key"
    || route.api === "anthropic_messages";
  const headers = anthropicAuth
    ? {
        "content-type": "application/json",
        "x-api-key": requireApiKey(route),
        "anthropic-version": route.anthropicVersion || "2023-06-01",
      }
    : {
        "content-type": "application/json",
        authorization: `Bearer ${upstreamBearerToken(route, context)}`,
      };

  const customHeaders = route?.headers && typeof route.headers === "object" && !Array.isArray(route.headers)
    ? route.headers
    : {};
  for (const [name, value] of Object.entries(customHeaders)) {
    const key = String(name || "").trim();
    const valueText = String(value ?? "").trim();
    if (!key || !valueText || blockedCustomUpstreamHeader(key)) {
      continue;
    }
    headers[key] = valueText;
  }

  if (options.acceptEventStream) {
    headers.accept = "text/event-stream";
    if (route?.api === "chat_completions" || route?.api === "anthropic_messages") {
      headers["accept-encoding"] = "identity";
    }
  }

  if (authModeForRoute(route) === "codex_openai") {
    addCodexPassthroughHeaders(headers, context.clientHeaders);
    if (!headerValue(headers, "chatgpt-account-id")) {
      setCodexPassthroughHeader(
        headers,
        "chatgpt-account-id",
        chatgptAccountIdFromBearerToken(context.clientAuth?.bearerToken),
      );
    }
  }

  return headers;
}

export function filteredHeaders(headers) {
  const result = {};
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    if (
      [
        "content-encoding",
        "content-length",
        "connection",
        "keep-alive",
        "transfer-encoding",
      ].includes(lower)
    ) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

function blockedCustomUpstreamHeader(name = "") {
  const normalized = String(name || "").trim().toLowerCase();
  return [
    "anthropic-version",
    "authorization",
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "x-api-key",
  ].includes(normalized);
}

function upstreamBearerToken(route, context = {}) {
  if (authModeForRoute(route) === "codex_openai") {
    if (context.clientAuth?.kind === "codex_openai" && context.clientAuth.bearerToken) {
      return context.clientAuth.bearerToken;
    }
    const error = new Error(
      `Route ${route.id} requires Codex/OpenAI bearer authentication.`,
    );
    error.statusCode = 401;
    throw error;
  }
  return requireApiKey(route);
}

function addCodexPassthroughHeaders(target, source) {
  for (const name of CODEX_EXACT_PASSTHROUGH_HEADERS) {
    setCodexPassthroughHeader(target, name, headerValue(source, name));
  }
  for (const [rawName, rawValue] of Object.entries(source || {})) {
    const name = String(rawName || "").toLowerCase();
    if (!shouldPassthroughCodexHeader(name)) {
      continue;
    }
    setCodexPassthroughHeader(target, name, headerValue({ [name]: rawValue }, name));
  }
}

function shouldPassthroughCodexHeader(name) {
  return (
    !CODEX_PASSTHROUGH_BLOCKED_HEADERS.has(name) &&
    (
      CODEX_EXACT_PASSTHROUGH_HEADERS.includes(name) ||
      CODEX_PASSTHROUGH_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))
    )
  );
}

function setCodexPassthroughHeader(target, name, value) {
  if (value && !CODEX_PASSTHROUGH_BLOCKED_HEADERS.has(name)) {
    target[name] = value;
  }
}

function chatgptAccountIdFromBearerToken(bearerToken) {
  const token = String(bearerToken || "").trim();
  if (!token || token.length > 32 * 1024) {
    return "";
  }
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1] || parts[1].length > 24 * 1024) {
    return "";
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const accountId = String(
      payload?.["https://api.openai.com/auth"]?.chatgpt_account_id || "",
    ).trim();
    return /^[A-Za-z0-9._:-]{1,160}$/.test(accountId) ? accountId : "";
  } catch {
    return "";
  }
}

export function headerValue(headers, name) {
  if (!headers || !name) {
    return "";
  }
  if (typeof headers.get === "function") {
    return String(headers.get(name) || headers.get(name.toLowerCase()) || headers.get(name.toUpperCase()) || "").trim();
  }
  const value = headers[name] || headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value.find(Boolean) || "";
  }
  return typeof value === "string" ? value : "";
}
