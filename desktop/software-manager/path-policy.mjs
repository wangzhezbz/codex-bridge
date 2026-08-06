import path from "node:path";

const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WINDOWS_MAX_PATH_WITHOUT_TERMINATOR = 259;

function policyError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function failed(error) {
  return { ok: false, error };
}

function hasParentTraversal(value, pathApi = path) {
  return String(value).split(/[\\/]+/u).includes("..");
}

function canonicalWindowsPath(value) {
  return path.win32.resolve(String(value)).replace(/[\\/]+$/u, "") || path.win32.parse(String(value)).root;
}

function isEqualOrWithinWindows(target, root) {
  const normalizedTarget = canonicalWindowsPath(target).toLowerCase();
  const normalizedRoot = canonicalWindowsPath(root).toLowerCase();
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}\\`);
}

export async function validateInstallRoot({ candidate, env = {}, maxRelativePath, access }) {
  if (typeof candidate !== "string" || candidate.trim() !== candidate || candidate.length === 0
    || !Number.isSafeInteger(maxRelativePath) || maxRelativePath < 0 || typeof access !== "function") {
    return failed("install_root_invalid");
  }
  if (hasParentTraversal(candidate, path.win32)) return failed("install_path_traversal");
  if (candidate.startsWith("\\\\") || !path.win32.isAbsolute(candidate)) return failed("install_root_invalid");

  const normalized = path.win32.normalize(candidate).replace(/[\\/]+$/u, "");
  const parsed = path.win32.parse(normalized);
  if (!normalized || normalized.toLowerCase() === parsed.root.replace(/[\\/]+$/u, "").toLowerCase()) {
    return failed("install_root_protected");
  }

  const userProfile = typeof env.USERPROFILE === "string" ? env.USERPROFILE : null;
  const protectedRoots = [
    env.SystemRoot,
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.ProgramData,
    userProfile && path.win32.join(userProfile, "Desktop"),
    userProfile && path.win32.join(userProfile, "Documents"),
    userProfile && path.win32.join(userProfile, ".codex"),
    env.CODEX_HOME,
  ].filter((value) => typeof value === "string" && value.length > 0);
  if (protectedRoots.some((root) => isEqualOrWithinWindows(normalized, root))) {
    return failed("install_root_protected");
  }
  if (normalized.length + 1 + maxRelativePath > WINDOWS_MAX_PATH_WITHOUT_TERMINATOR) {
    return failed("install_peak_path_too_long");
  }

  try {
    await access(normalized);
  } catch {
    return failed("install_root_unwritable");
  }
  return { ok: true, path: normalized };
}

export async function resolveSkillTarget({ skillsRoot, skillId, realpath, lstat }) {
  if (typeof skillId !== "string" || !SKILL_ID_PATTERN.test(skillId)) throw policyError("skill_id_rejected");
  if (typeof realpath !== "function" || typeof lstat !== "function") throw policyError("skill_resolver_invalid");
  const root = await realpath(skillsRoot);
  const target = path.resolve(root, skillId);
  if (path.dirname(target).toLowerCase() !== path.resolve(root).toLowerCase()) throw policyError("skill_path_escape");
  const stat = await lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (stat?.isSymbolicLink?.() || stat?.isReparsePoint?.()) throw policyError("skill_reparse_point");
  return target;
}

function collectOwnedAnchors(ownership) {
  const anchors = [];
  if (typeof ownership?.installRoot === "string") anchors.push(ownership.installRoot);
  for (const section of [ownership?.components, ownership?.skills, ownership?.shortcuts, ownership?.rollback]) {
    collectSectionPaths(section, anchors);
  }
  return anchors;
}

function collectSectionPaths(value, anchors) {
  if (typeof value === "string") {
    anchors.push(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) collectSectionPaths(entry, anchors);
    return;
  }
  for (const key of ["path", "target", "installPath"]) {
    if (typeof value[key] === "string") anchors.push(value[key]);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!["path", "target", "installPath"].includes(key)) collectSectionPaths(entry, anchors);
  }
}

export function isOwnedPath({ target, ownership }) {
  if (typeof target !== "string" || !path.win32.isAbsolute(target) || hasParentTraversal(target, path.win32)) return false;
  return collectOwnedAnchors(ownership)
    .filter((anchor) => typeof anchor === "string" && path.win32.isAbsolute(anchor) && !hasParentTraversal(anchor, path.win32))
    .some((anchor) => isEqualOrWithinWindows(target, anchor));
}
