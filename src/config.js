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
    throw new Error("Router 配置必须包含非空的 models 数组。");
  }

  const seen = new Set();
  for (const model of config.models) {
    for (const field of ["id", "displayName", "api", "baseUrl", "model"]) {
      if (!model[field] || typeof model[field] !== "string") {
        throw new Error(`模型配置缺少字符串字段：${field}`);
      }
    }
    if (seen.has(model.id)) {
      throw new Error(`模型 ID 重复：${model.id}`);
    }
    if (!["responses", "chat_completions"].includes(model.api)) {
      throw new Error(`模型 ${model.id} 使用了不支持的接口类型：${model.api}`);
    }
    if (
      model.authMode &&
      !["api_key", "codex_openai"].includes(model.authMode)
    ) {
      throw new Error(`模型 ${model.id} 使用了不支持的鉴权模式：${model.authMode}`);
    }
    if (baseUrlPointsBackToRouter(model.baseUrl, config)) {
      throw new Error(
        `模型 ${model.id} 的 Base URL 指回了 CodexBridge Router 自己：${model.baseUrl}。` +
          "请改成真实上游供应商的 Base URL。",
      );
    }
    seen.add(model.id);
  }
}

export function routeForModel(config, requestedModel, options = {}) {
  if (!requestedModel) {
    const route = defaultRoute(config);
    if (route) {
      return route;
    }
    throw createModelNotConfiguredError(config, "(default)", options);
  }
  const requested = String(requestedModel || "").trim();
  const normalized = normalizeModelName(requested);

  const routes = activeModels(config);
  const slotRoute = routes.find((model) =>
    modelSlotAliases(model).some((alias) => alias === normalized),
  );
  if (slotRoute) {
    return slotRoute;
  }
  if (options.exactModelIdOnly) {
    throw createModelNotConfiguredError(config, requested, options);
  }

  const route = routes.find((model) =>
    modelFallbackAliases(model).some((alias) => alias === normalized),
  );
  if (route) {
    return route;
  }
  throw createModelNotConfiguredError(config, requested, options);
}

function createModelNotConfiguredError(config, requested, options = {}) {
  const routes = activeModels(config);
  const availableValues = options.exactModelIdOnly
    ? routes.map((model) => model.id)
    : routes.flatMap((model) => [model.id, model.displayName, model.model]);
  const available = availableValues.filter(Boolean).join(", ");
  const message = options.exactModelIdOnly
    ? `CodexBridge 没有为 Codex 客户端配置这个模型：${requested}。请改用这些模型 ID 之一：${available}`
    : `CodexBridge 没有配置这个模型：${requested}。当前可用模型：${available}`;
  const error = new Error(
    message,
  );
  error.statusCode = 404;
  error.code = "model_not_configured";
  return error;
}

function defaultRoute(config) {
  const routes = activeModels(config);
  return (
    routes.find((model) => model.id === config.defaultModel) ||
    routes[0]
  );
}

function activeModels(config = {}) {
  return Array.isArray(config.models)
    ? config.models.filter((model) => model && model.enabled !== false)
    : [];
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
    return secretFileValue(route.apiKeyEnv) || process.env[route.apiKeyEnv];
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
      ? `请在 CodexBridge 的 API Key 设置里填写 ${route.apiKeyEnv}。`
      : "请在 CodexBridge 的 API Key 设置里填写这个供应商的 Key。";
    const error = new Error(`${label || route.id} 缺少 API Key。${hint}`);
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
