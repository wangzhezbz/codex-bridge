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
    seen.add(model.id);
  }
}

export function routeForModel(config, requestedModel) {
  const modelId = requestedModel || config.defaultModel;
  return (
    config.models.find((model) => model.id === modelId) ||
    config.models.find((model) => model.displayName === modelId) ||
    config.models.find((model) => model.id === config.defaultModel) ||
    config.models[0]
  );
}

export function apiKeyForRoute(route) {
  if (route.apiKey) {
    return route.apiKey;
  }
  if (route.apiKeyEnv) {
    return process.env[route.apiKeyEnv];
  }
  return undefined;
}

export function authModeForRoute(route) {
  return route.authMode || "api_key";
}

export function requireApiKey(route) {
  const key = apiKeyForRoute(route);
  if (!key) {
    const hint = route.apiKeyEnv ? ` Set ${route.apiKeyEnv}.` : "";
    const error = new Error(`Missing API key for ${route.id}.${hint}`);
    error.statusCode = 500;
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

export function routerOrigin(config) {
  return `http://${config.host || "127.0.0.1"}:${config.port || 15722}`;
}
