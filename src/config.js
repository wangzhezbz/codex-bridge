import fs from "node:fs";
import path from "node:path";

const DEFAULT_CONFIG = path.resolve("config", "router.config.json");
const EXAMPLE_CONFIG = path.resolve("config", "router.config.example.json");

export function resolveConfigPath(configPath = process.env.ROUTER_CONFIG) {
  if (configPath) {
    return path.resolve(configPath);
  }
  if (fs.existsSync(DEFAULT_CONFIG)) {
    return DEFAULT_CONFIG;
  }
  return EXAMPLE_CONFIG;
}

export function loadConfig(configPath) {
  const resolved = resolveConfigPath(configPath);
  const raw = fs.readFileSync(resolved, "utf8");
  const config = JSON.parse(raw);
  config.__path = resolved;
  validateConfig(config);
  return config;
}

export function validateConfig(config) {
  if (!Array.isArray(config.models) || config.models.length === 0) {
    throw new Error("router config must contain a non-empty models array");
  }

  const seen = new Set();
  for (const model of config.models) {
    for (const field of ["id", "displayName", "api", "baseUrl", "model"]) {
      if (!model[field] || typeof model[field] !== "string") {
        throw new Error(`model entry is missing string field ${field}`);
      }
    }
    if (seen.has(model.id)) {
      throw new Error(`duplicate model id: ${model.id}`);
    }
    if (!["responses", "chat_completions"].includes(model.api)) {
      throw new Error(`model ${model.id} has unsupported api ${model.api}`);
    }
    if (
      model.authMode &&
      !["api_key", "codex_openai"].includes(model.authMode)
    ) {
      throw new Error(`model ${model.id} has unsupported authMode ${model.authMode}`);
    }
    if (baseUrlPointsBackToRouter(model.baseUrl, config)) {
      throw new Error(
        `model ${model.id} baseUrl points back to CodexBridge Router itself: ${model.baseUrl}. ` +
          "Use the real upstream provider Base URL instead.",
      );
    }
    seen.add(model.id);
  }
}

export function routeForModel(config, requestedModel, options = {}) {
  if (!requestedModel) {
    return defaultRoute(config);
  }
  const requested = String(requestedModel || "").trim();
  const normalized = normalizeModelName(requested);

  const slotRoute = config.models.find((model) =>
    modelSlotAliases(model).some((alias) => alias === normalized),
  );
  if (slotRoute) {
    return slotRoute;
  }
  if (options.exactModelIdOnly) {
    throw createModelNotConfiguredError(config, requested, options);
  }

  const route = config.models.find((model) =>
    modelFallbackAliases(model).some((alias) => alias === normalized),
  );
  if (route) {
    return route;
  }
  throw createModelNotConfiguredError(config, requested, options);
}

function createModelNotConfiguredError(config, requested, options = {}) {
  const availableValues = options.exactModelIdOnly
    ? config.models.map((model) => model.id)
    : config.models.flatMap((model) => [model.id, model.displayName, model.model]);
  const available = availableValues.filter(Boolean).join(", ");
  const message = options.exactModelIdOnly
    ? `Model is not configured in CodexBridge for Codex client requests: ${requested}. Use one of these model ids: ${available}`
    : `Model is not configured in CodexBridge: ${requested}. Available models: ${available}`;
  const error = new Error(
    message,
  );
  error.statusCode = 404;
  error.code = "model_not_configured";
  return error;
}

function defaultRoute(config) {
  return (
    config.models.find((model) => model.id === config.defaultModel) ||
    config.models[0]
  );
}

function modelSlotAliases(model) {
  return normalizedAliases([model.id]);
}

function modelFallbackAliases(model) {
  return normalizedAliases([
    model.displayName,
    model.model,
    model.slotLabel,
    model.sourcePresetId,
  ]);
}

function normalizedAliases(values) {
  return [
    ...values,
  ]
    .filter(Boolean)
    .flatMap((value) => [
      normalizeModelName(value),
      normalizeModelName(String(value).replace(/^codex-/, "")),
    ]);
}

function normalizeModelName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function apiKeyForRoute(route) {
  if (route.apiKey) {
    return route.apiKey;
  }
  if (route.apiKeyEnv) {
    return process.env[route.apiKeyEnv] || secretFileValue(route.apiKeyEnv);
  }
  return undefined;
}

function secretFileValue(keyEnv) {
  const secretsFile = process.env.CODEXBRIDGE_SECRETS_FILE;
  if (!secretsFile || !fs.existsSync(secretsFile)) {
    return undefined;
  }
  try {
    const secrets = JSON.parse(fs.readFileSync(secretsFile, "utf8"));
    const value = secrets?.[keyEnv];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function authModeForRoute(route) {
  return route.authMode || "api_key";
}

export function requireApiKey(route) {
  const key = apiKeyForRoute(route);
  if (!key) {
    const label = [route.displayName, route.id].filter(Boolean).join(" / ");
    const hint = route.apiKeyEnv
      ? ` Set ${route.apiKeyEnv} in CodexBridge API Key settings.`
      : " Configure an API key in CodexBridge API Key settings.";
    const error = new Error(`Missing API key for ${label || route.id}.${hint}`);
    error.statusCode = 400;
    error.code = "missing_provider_api_key";
    throw error;
  }
  return key;
}

export function joinUpstreamUrl(baseUrl, endpoint) {
  const cleanBase = String(baseUrl).replace(/\/+$/, "");
  if (cleanBase.endsWith(endpoint)) {
    return cleanBase;
  }
  return `${cleanBase}${endpoint}`;
}

const OPENAI_ENDPOINT_SUFFIXES = [
  { path: "/v1/responses/compact", family: "responses_compact", versioned: true },
  { path: "/responses/compact", family: "responses_compact", versioned: false },
  { path: "/v1/chat/completions", family: "chat_completions", versioned: true },
  { path: "/chat/completions", family: "chat_completions", versioned: false },
  { path: "/v1/responses", family: "responses", versioned: true },
  { path: "/responses", family: "responses", versioned: false },
];

export function joinOpenAiEndpointUrl(baseUrl, endpoint) {
  const cleanEndpoint = String(endpoint || "").startsWith("/")
    ? String(endpoint || "")
    : `/${endpoint || ""}`;
  const cleanBase = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!cleanBase) {
    return cleanEndpoint;
  }

  const normalized = replaceOpenAiEndpointSuffix(cleanBase, cleanEndpoint);
  if (normalized) {
    return normalized;
  }
  return collapseDuplicateV1(joinUpstreamUrl(cleanBase, cleanEndpoint));
}

function replaceOpenAiEndpointSuffix(baseUrl, endpoint) {
  const requested = openAiEndpointFamily(endpoint);
  if (!requested) {
    return "";
  }

  try {
    const parsed = new URL(baseUrl);
    const pathname = parsed.pathname.replace(/\/+$/, "") || "";
    const matched = matchingOpenAiEndpointSuffix(pathname);
    if (!matched) {
      return "";
    }
    const prefix = pathname.slice(0, -matched.path.length).replace(/\/+$/, "");
    parsed.pathname = `${prefix}${openAiEndpointPathForFamily(requested, matched.versioned)}`;
    parsed.search = "";
    parsed.hash = "";
    return collapseDuplicateV1(parsed.toString());
  } catch {
    const matched = matchingOpenAiEndpointSuffix(baseUrl);
    if (!matched) {
      return "";
    }
    const prefix = baseUrl.slice(0, -matched.path.length).replace(/\/+$/, "");
    return collapseDuplicateV1(`${prefix}${openAiEndpointPathForFamily(requested, matched.versioned)}`);
  }
}

function openAiEndpointFamily(endpoint) {
  const normalized = String(endpoint || "").toLowerCase().replace(/\/+$/, "");
  if (normalized.endsWith("/responses/compact")) {
    return "responses_compact";
  }
  if (normalized.endsWith("/chat/completions")) {
    return "chat_completions";
  }
  if (normalized.endsWith("/responses")) {
    return "responses";
  }
  return "";
}

function matchingOpenAiEndpointSuffix(value) {
  const normalized = String(value || "").toLowerCase().replace(/\/+$/, "");
  return OPENAI_ENDPOINT_SUFFIXES.find((suffix) => normalized.endsWith(suffix.path)) || null;
}

function openAiEndpointPathForFamily(family, versioned) {
  const prefix = versioned ? "/v1" : "";
  if (family === "responses_compact") {
    return `${prefix}/responses/compact`;
  }
  if (family === "responses") {
    return `${prefix}/responses`;
  }
  return `${prefix}/chat/completions`;
}

function collapseDuplicateV1(value) {
  let result = String(value || "");
  while (result.includes("/v1/v1/")) {
    result = result.replace("/v1/v1/", "/v1/");
  }
  return result.replace(/\/v1\/v1$/, "/v1");
}

export function routerOrigin(config) {
  return `http://${config.host || "127.0.0.1"}:${config.port || 15722}`;
}

function baseUrlPointsBackToRouter(baseUrl, config = {}) {
  const routerPort = Number(config.port || 15722);
  if (!Number.isFinite(routerPort) || routerPort <= 0) {
    return false;
  }
  try {
    const parsed = new URL(baseUrl);
    const targetPort = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    if (targetPort !== routerPort) {
      return false;
    }
    return isLocalRouterHost(parsed.hostname) && isLocalRouterHost(config.host || "127.0.0.1");
  } catch {
    return false;
  }
}

function isLocalRouterHost(value) {
  const host = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "::" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.startsWith("127.")
  );
}
