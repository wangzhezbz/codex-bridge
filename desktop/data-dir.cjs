const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const APP_DIR_NAME = "CodexBridge";
const LEGACY_DATA_DIR_NAME = "CodexBridgeData";

function resolveDataRootDir({
  appRootDir,
  env = process.env,
  execPath = process.execPath,
  isPackaged = false,
  platform = process.platform,
} = {}) {
  const override = String(env.CODEXBRIDGE_DATA_DIR || "").trim();
  if (override) {
    return platform === "win32" ? path.win32.resolve(override) : path.resolve(override);
  }
  if (!isPackaged) {
    return appRootDir;
  }
  if (platform === "win32") {
    const appData =
      env.APPDATA || (env.USERPROFILE && path.win32.join(env.USERPROFILE, "AppData", "Roaming"));
    if (appData) {
      return path.win32.join(appData, APP_DIR_NAME);
    }
  }
  if (platform === "darwin") {
    const homeDir = env.HOME || env.USERPROFILE || os.homedir();
    return path.posix.join(
      String(homeDir).replaceAll("\\", "/"),
      "Library",
      "Application Support",
      APP_DIR_NAME,
    );
  }
  return path.join(env.HOME || env.USERPROFILE || os.homedir(), ".codexbridge");
}

function legacyPortableDataCandidates({
  execPath = process.execPath,
  targetDir,
} = {}) {
  const exeDir = path.dirname(execPath);
  const candidates = new Set();

  addCandidate(candidates, path.join(exeDir, LEGACY_DATA_DIR_NAME));
  for (const root of ancestorDirs(exeDir, 4)) {
    addCandidate(candidates, path.join(root, LEGACY_DATA_DIR_NAME));
    for (const child of safeChildDirs(root)) {
      addCandidate(candidates, path.join(child, LEGACY_DATA_DIR_NAME));
      addCandidate(candidates, path.join(child, "CodexBridge-win32-x64", LEGACY_DATA_DIR_NAME));
      for (const grandchild of safeChildDirs(child, 120)) {
        addCandidate(candidates, path.join(grandchild, LEGACY_DATA_DIR_NAME));
        addCandidate(candidates, path.join(grandchild, "CodexBridge-win32-x64", LEGACY_DATA_DIR_NAME));
      }
    }
  }

  return Array.from(candidates)
    .filter((candidate) => hasPortableData(candidate))
    .filter((candidate) => !samePath(candidate, targetDir))
    .filter((candidate) => !isInside(candidate, targetDir))
    .sort((a, b) => newestMtimeMs(b) - newestMtimeMs(a));
}

function migrateLegacyPortableData({ targetDir, legacyDirs = [] } = {}) {
  const result = {
    copiedFiles: 0,
    skippedFiles: 0,
    sourceDirs: [],
    messages: [],
  };
  if (!targetDir) {
    return result;
  }

  const seen = new Set();
  for (const legacyDir of legacyDirs) {
    if (!legacyDir || seen.has(normalizeKey(legacyDir))) {
      continue;
    }
    seen.add(normalizeKey(legacyDir));
    if (!hasPortableData(legacyDir) || samePath(legacyDir, targetDir) || isInside(legacyDir, targetDir)) {
      continue;
    }
    try {
      const copied = copyMissingTree(legacyDir, targetDir);
      if (copied.copiedFiles > 0) {
        result.sourceDirs.push(legacyDir);
        result.messages.push(
          `Migrated ${copied.copiedFiles} file(s) from legacy portable data: ${legacyDir}`,
        );
      }
      result.copiedFiles += copied.copiedFiles;
      result.skippedFiles += copied.skippedFiles;
    } catch (error) {
      result.messages.push(`Could not migrate legacy portable data from ${legacyDir}: ${error.message}`);
    }
  }
  return result;
}

function copyMissingTree(sourceDir, targetDir) {
  const result = { copiedFiles: 0, skippedFiles: 0 };
  if (!fs.existsSync(sourceDir)) {
    return result;
  }
  const stats = fs.statSync(sourceDir);
  if (stats.isDirectory()) {
    fs.mkdirSync(targetDir, { recursive: true });
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      const source = path.join(sourceDir, entry.name);
      const target = path.join(targetDir, entry.name);
      if (entry.isDirectory()) {
        const child = copyMissingTree(source, target);
        result.copiedFiles += child.copiedFiles;
        result.skippedFiles += child.skippedFiles;
      } else if (entry.isFile()) {
        if (fs.existsSync(target)) {
          result.skippedFiles += 1;
          continue;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
        result.copiedFiles += 1;
      }
    }
  }
  return result;
}

function hasPortableData(dir) {
  if (!dir || !fs.existsSync(dir)) {
    return false;
  }
  const markers = [
    path.join("config", "router.config.json"),
    path.join("config", "secrets.local.json"),
    path.join("config", "model-selection.json"),
    path.join("config", "custom-models.json"),
    path.join("logs", "usage.local.json"),
    "model-catalog.json",
  ];
  return markers.some((marker) => fs.existsSync(path.join(dir, marker)));
}

function ancestorDirs(startDir, limit) {
  const dirs = [];
  let current = path.resolve(startDir);
  for (let index = 0; index < limit && current; index += 1) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return dirs;
}

function safeChildDirs(dir, limit = 80) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .slice(0, limit)
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

function addCandidate(candidates, candidate) {
  if (candidate) {
    candidates.add(path.resolve(candidate));
  }
}

function newestMtimeMs(dir) {
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

function samePath(a, b) {
  if (!a || !b) {
    return false;
  }
  return normalizeKey(a) === normalizeKey(b);
}

function isInside(candidate, targetDir) {
  if (!candidate || !targetDir) {
    return false;
  }
  const relative = path.relative(path.resolve(targetDir), path.resolve(candidate));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function normalizeKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

module.exports = {
  legacyPortableDataCandidates,
  migrateLegacyPortableData,
  resolveDataRootDir,
};
