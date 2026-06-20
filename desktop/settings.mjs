import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MODE_ALL_API = "all_api";
export const MODE_HYBRID = "hybrid";

export function routerConfigPath(rootDir) {
  return path.join(rootDir, "config", "router.config.json");
}

export function secretsPath(rootDir) {
  return path.join(rootDir, "config", "secrets.local.json");
}

export function catalogPath(rootDir) {
  return path.join(rootDir, "model-catalog.json");
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

export function secretStatus(rootDir) {
  const secrets = loadSecrets(rootDir);
  return {
    FENNO_API_KEY: Boolean(secrets.FENNO_API_KEY),
    DEEPSEEK_API_KEY: Boolean(secrets.DEEPSEEK_API_KEY),
    MOONSHOT_API_KEY: Boolean(secrets.MOONSHOT_API_KEY),
  };
}

export function envWithSecrets(rootDir, baseEnv = process.env) {
  return {
    ...baseEnv,
    ...loadSecrets(rootDir),
  };
}

export function buildCodexToml({
  rootDir,
  mode,
  port = 15722,
  model = "gpt-5.5",
}) {
  const normalizedCatalogPath = toTomlPath(catalogPath(rootDir));
  const providerAuth =
    mode === MODE_HYBRID
      ? 'requires_openai_auth = true'
      : 'experimental_bearer_token = "sk-local-codex-router"';

  return [
    'model_provider = "codex-bridge"',
    `model = "${model}"`,
    `model_catalog_json = "${normalizedCatalogPath}"`,
    'model_reasoning_effort = "medium"',
    "disable_response_storage = true",
    'network_access = "enabled"',
    "windows_wsl_setup_acknowledged = true",
    "",
    "[model_providers.codex-bridge]",
    'name = "CodexBridge"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
    'wire_api = "responses"',
    providerAuth,
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

  let backup = null;
  if (fs.existsSync(target)) {
    backup = `${target}.codexbridge.${timestamp()}.bak`;
    fs.copyFileSync(target, backup);
  }

  fs.writeFileSync(target, buildCodexToml({ rootDir, mode, port }), "utf8");
  return { target, backup };
}

function toTomlPath(filePath) {
  return path.resolve(filePath).replaceAll("\\", "/");
}

function timestamp(date = new Date()) {
  return date
    .toISOString()
    .replaceAll(":", "")
    .replaceAll(".", "")
    .replace("T", "-")
    .replace("Z", "");
}
