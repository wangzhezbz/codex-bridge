import fs from "node:fs";
import path from "node:path";
import { canonicalModelReference } from "../shared/model-preset-aliases.cjs";

const DEFAULT_CONFIG = path.resolve("config", "router.config.json");
const EXAMPLE_CONFIG = path.resolve("config", "router.config.example.json");
const MAX_ROUTER_CONFIG_BYTES = 16 * 1024 * 1024;
const MAX_ROUTER_SECRETS_BYTES = 4 * 1024 * 1024;
const MAX_ROUTER_MODELS = 1_024;
let secretsFileCache = null;

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
  const raw = readBoundedUtf8File(resolved, MAX_ROUTER_CONFIG_BYTES, {
    invalidCode: "router_config_file_invalid",
    tooLargeCode: "router_config_too_large",
    label: "Router 配置文件",
  });
  const config = JSON.parse(raw);
  config.__path = resolved;
  validateConfig(config);
  return config;
}

export function validateConfig(config) {
  if (!Array.isArray(config.models) || config.models.length === 0) {
    throw new Error("Router 配置必须包含非空的 models 数组。");
  }
  if (config.models.length > MAX_ROUTER_MODELS) {
    const error = new Error(`Router 配置包含过多模型，最多允许 ${MAX_ROUTER_MODELS} 个。`);
    error.code = "router_config_model_limit";
    throw error;
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
    if (!["responses", "chat_completions", "anthropic_messages"].includes(model.api)) {
      throw new Error(`模型 ${model.id} 使用了不支持的接口类型：${model.api}`);
    }
    if (
      model.authMode &&
      !["api_key", "codex_openai", "anthropic_api_key"].includes(model.authMode)
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
  ) || routes.find((model) =>
    modelSlotAliases(model).includes(normalizeModelName(canonicalModelReference(requested))),
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
    secretsFileCache = null;
    return undefined;
  }
  const resolved = path.resolve(secretsFile);
  try {
    const currentFingerprint = localFileFingerprint(resolved);
    let secrets = secretsFileCache?.path === resolved && secretsFileCache.fingerprint === currentFingerprint
      ? secretsFileCache.value
      : null;
    if (!secrets) {
      let before = currentFingerprint;
      let stableFingerprint = "";
      for (let attempt = 0; attempt < 3; attempt += 1) {
        secrets = JSON.parse(readBoundedUtf8File(resolved, MAX_ROUTER_SECRETS_BYTES, {
          invalidCode: "router_secrets_file_invalid",
          tooLargeCode: "router_secrets_too_large",
          label: "Router secrets 文件",
        }));
        const after = localFileFingerprint(resolved);
        if (after === before) {
          stableFingerprint = after;
          break;
        }
        before = after;
      }
      if (!stableFingerprint) {
        secretsFileCache = null;
        return undefined;
      }
      if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) {
        secretsFileCache = null;
        return undefined;
      }
      secretsFileCache = { path: resolved, fingerprint: stableFingerprint, value: secrets };
    }
    const value = secrets?.[keyEnv];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    secretsFileCache = null;
    return undefined;
  }
}

function localFileFingerprint(filePath) {
  const stat = fs.statSync(filePath, { bigint: true });
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs]
    .map(String)
    .join(":");
}

function readBoundedUtf8File(filePath, maxBytes, { invalidCode, tooLargeCode, label }) {
  let descriptor = null;
  try {
    descriptor = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) {
      throw configFileError(invalidCode, `${label}不是可读取的普通文件。`);
    }
    if (stat.size > maxBytes) {
      throw configFileError(tooLargeCode, `${label}过大，最大允许 ${maxBytes} bytes。`);
    }
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!Number.isInteger(count) || count <= 0) {
        throw configFileError(invalidCode, `${label}在读取过程中发生变化。`);
      }
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (after.size !== stat.size || after.dev !== stat.dev || after.ino !== stat.ino) {
      throw configFileError(invalidCode, `${label}在读取过程中发生变化。`);
    }
    return bytes.toString("utf8");
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function configFileError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
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
