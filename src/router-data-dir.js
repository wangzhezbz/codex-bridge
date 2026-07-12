import path from "node:path";

export function resolveRouterDataRoot({ env = process.env, cwd = process.cwd() } = {}) {
  const explicit = String(env.CODEXBRIDGE_DATA_DIR || "").trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  const configPath = String(env.ROUTER_CONFIG || "").trim();
  if (configPath) {
    const configDir = path.dirname(path.resolve(configPath));
    return path.basename(configDir).toLowerCase() === "config"
      ? path.dirname(configDir)
      : configDir;
  }
  return path.resolve(cwd);
}

export function resolveResponseHistoryPath(options = {}) {
  return path.join(
    resolveRouterDataRoot(options),
    "state",
    "response-history.sqlite3",
  );
}
