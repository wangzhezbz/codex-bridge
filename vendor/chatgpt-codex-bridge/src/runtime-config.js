import path from "node:path";

function configuredPath(value, baseDir) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? path.resolve(baseDir, text) : null;
}

export function resolveBridgeDataDir(options = {}) {
  const env = options.env || process.env;
  const cwd = path.resolve(options.cwd || process.cwd());
  return (
    configuredPath(options.storeRoot, cwd) ||
    configuredPath(env.BRIDGE_DATA_DIR, cwd) ||
    configuredPath(env.BRIDGE_STORE, cwd) ||
    path.join(cwd, ".bridge")
  );
}

export function resolveBridgeExtensionDir(options = {}) {
  const env = options.env || process.env;
  const packageRoot = path.resolve(options.packageRoot || process.cwd());
  return (
    configuredPath(options.extensionSourceDir, packageRoot) ||
    configuredPath(env.BRIDGE_EXTENSION_DIR, packageRoot) ||
    path.join(packageRoot, "chrome-extension")
  );
}
