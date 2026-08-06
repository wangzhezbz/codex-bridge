import path from "node:path";

const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WINDOWS_MAX_PATH_WITHOUT_TERMINATOR = 259;
const OWNERSHIP_KEYS = Object.freeze([
  "schemaVersion",
  "installRoot",
  "components",
  "skills",
  "shortcuts",
  "rollback",
  "activeTask",
  "lastTask",
]);

function policyError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function failed(error) {
  return { ok: false, error };
}

function hasParentTraversal(value) {
  return String(value).split(/[\\/]+/u).includes("..");
}

function normalizeInstallCandidate(candidate) {
  const slashNormalized = candidate.replaceAll("/", "\\");
  let normalized;
  try {
    normalized = path.win32.normalize(slashNormalized);
  } catch {
    throw policyError("install_root_invalid");
  }
  if (normalized.startsWith("\\\\")) throw policyError("install_root_unc");
  if (!/^[a-z]:\\/iu.test(normalized) || normalized.includes("\0")) {
    throw policyError("install_root_invalid");
  }
  const rawSegments = slashNormalized.slice(3).split("\\");
  const finalIndex = rawSegments.length - 1;
  for (const [index, segment] of rawSegments.entries()) {
    if (segment.length === 0 && index === finalIndex) continue;
    if (segment.length === 0 || segment === "." || segment === ".." || /[ .]$/u.test(segment)
      || /[<>:"|?*\u0000-\u001f]/u.test(segment)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)) {
      throw policyError("install_root_noncanonical");
    }
  }
  const exact = normalized.replace(/[\\/]+$/u, "");
  if (exact.split("\\").some((segment) => segment.toLowerCase() === ".codex")) {
    throw policyError("install_root_protected");
  }
  return exact;
}

function canonicalWindowsPath(value) {
  return path.win32.resolve(String(value)).replace(/[\\/]+$/u, "") || path.win32.parse(String(value)).root;
}

function isEqualOrWithinWindows(target, root) {
  const normalizedTarget = canonicalWindowsPath(target).toLowerCase();
  const normalizedRoot = canonicalWindowsPath(root).toLowerCase();
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}\\`);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isOwnershipPath(value) {
  return typeof value === "string" && value.length > 0 && path.win32.isAbsolute(value)
    && !value.startsWith("\\\\") && !hasParentTraversal(value) && !value.includes("\0");
}

function isJsonValue(value, seen = new Set(), depth = 0) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > 32 || seen.has(value)) return false;
  if (!Array.isArray(value) && !isPlainObject(value)) return false;
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  const valid = children.every((child) => isJsonValue(child, seen, depth + 1));
  seen.delete(value);
  return valid;
}

function isPathRecord(value, pathField) {
  return isPlainObject(value) && Object.hasOwn(value, pathField) && isOwnershipPath(value[pathField])
    && isJsonValue(value);
}

function isRecordMap(value, pathField) {
  return isPlainObject(value) && Object.entries(value).every(([id, record]) => (
    SKILL_ID_PATTERN.test(id) && isPathRecord(record, pathField)
  ));
}

function isTaskRecord(value) {
  return value === null || (isPlainObject(value) && isJsonValue(value));
}

export function isValidOwnershipState(value) {
  if (!isPlainObject(value) || Object.keys(value).length !== OWNERSHIP_KEYS.length
    || !OWNERSHIP_KEYS.every((key) => Object.hasOwn(value, key))) return false;
  const validRollback = value.rollback === null
    || isPathRecord(value.rollback, "path")
    || (Array.isArray(value.rollback) && value.rollback.every((record) => isPathRecord(record, "path")));
  return value.schemaVersion === 1
    && (value.installRoot === null || isOwnershipPath(value.installRoot))
    && isRecordMap(value.components, "installPath")
    && isRecordMap(value.skills, "target")
    && Array.isArray(value.shortcuts) && value.shortcuts.every((record) => isPathRecord(record, "path"))
    && validRollback
    && isTaskRecord(value.activeTask)
    && isTaskRecord(value.lastTask);
}

export async function validateInstallRoot({ candidate, env = {}, maxRelativePath, access }) {
  if (typeof candidate !== "string" || candidate.trim() !== candidate || candidate.length === 0
    || !Number.isSafeInteger(maxRelativePath) || maxRelativePath < 0 || typeof access !== "function") {
    return failed("install_root_invalid");
  }
  if (hasParentTraversal(candidate)) return failed("install_path_traversal");
  let normalized;
  try {
    normalized = normalizeInstallCandidate(candidate);
  } catch (error) {
    return failed(error.code ?? "install_root_invalid");
  }
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
  if (Object.hasOwn(ownership, "installRoot") && typeof ownership.installRoot === "string") anchors.push(ownership.installRoot);
  if (ownership?.components && typeof ownership.components === "object" && !Array.isArray(ownership.components)) {
    for (const record of Object.values(ownership.components)) addRecordPath(record, "installPath", anchors);
  }
  if (ownership?.skills && typeof ownership.skills === "object" && !Array.isArray(ownership.skills)) {
    for (const record of Object.values(ownership.skills)) addRecordPath(record, "target", anchors);
  }
  if (Array.isArray(ownership?.shortcuts)) {
    for (const record of ownership.shortcuts) addRecordPath(record, "path", anchors);
  }
  if (Array.isArray(ownership?.rollback)) {
    for (const record of ownership.rollback) addRecordPath(record, "path", anchors);
  } else {
    addRecordPath(ownership?.rollback, "path", anchors);
  }
  return anchors;
}

function addRecordPath(record, field, anchors) {
  if (record && typeof record === "object" && !Array.isArray(record)
    && Object.getPrototypeOf(record) === Object.prototype && Object.hasOwn(record, field)
    && typeof record[field] === "string") {
    anchors.push(record[field]);
  }
}

export function isOwnedPath({ target, ownership }) {
  if (!isValidOwnershipState(ownership) || typeof target !== "string"
    || !path.win32.isAbsolute(target) || hasParentTraversal(target)) return false;
  return collectOwnedAnchors(ownership)
    .filter((anchor) => typeof anchor === "string" && path.win32.isAbsolute(anchor) && !hasParentTraversal(anchor))
    .some((anchor) => isEqualOrWithinWindows(target, anchor));
}
