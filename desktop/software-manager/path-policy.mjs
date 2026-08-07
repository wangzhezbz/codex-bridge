import path from "node:path";
import {
  isShortcutBoundToCurrent,
  isValidActiveTask,
  isValidShortcutRecord,
} from "./ownership-task-schema.mjs";

const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WINDOWS_MAX_PATH_WITHOUT_TERMINATOR = 259;
const OWNERSHIP_KEYS = Object.freeze([
  "schemaVersion",
  "generation",
  "installRoot",
  "components",
  "skills",
  "shortcuts",
  "rollback",
  "activeTask",
  "lastTask",
]);
const INSTALL_ROOT_CAPABILITIES = new WeakMap();
const FIXED_DIRECTORY_CAPABILITIES = new WeakMap();

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

function normalizeCanonicalWindowsPath(candidate, {
  allowCodexSkillId = null,
  allowCodexSkillsRoot = false,
  allowTrailingSeparator = false,
} = {}) {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.trim() !== candidate) {
    throw policyError("path_noncanonical");
  }
  const slashNormalized = candidate.replaceAll("/", "\\");
  let normalized;
  try {
    normalized = path.win32.normalize(slashNormalized);
  } catch {
    throw policyError("install_root_invalid");
  }
  if (normalized.startsWith("\\\\")) throw policyError("path_unc_or_device");
  if (!/^[a-z]:\\/iu.test(normalized) || normalized.includes("\0")) {
    throw policyError("path_not_drive_absolute");
  }
  const rawSegments = slashNormalized.slice(3).split("\\");
  const finalIndex = rawSegments.length - 1;
  for (const [index, segment] of rawSegments.entries()) {
    if (segment.length === 0 && index === finalIndex) continue;
    if (segment.length === 0 || segment === "." || segment === ".." || /[ .]$/u.test(segment)
      || /[<>:"|?*\u0000-\u001f]/u.test(segment)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)) {
      throw policyError("path_noncanonical");
    }
  }
  const exact = normalized.replace(/[\\/]+$/u, "");
  if (!allowTrailingSeparator && slashNormalized !== exact) throw policyError("path_noncanonical");
  const segments = exact.split("\\");
  const codexIndex = segments.findIndex((segment) => segment.toLowerCase() === ".codex");
  if (codexIndex !== -1) {
    const allowedSkillsRoot = allowCodexSkillsRoot
      && codexIndex === segments.length - 2
      && segments[codexIndex + 1]?.toLowerCase() === "skills";
    const allowedSkillPath = typeof allowCodexSkillId === "string"
      && codexIndex === segments.length - 3
      && segments[codexIndex + 1]?.toLowerCase() === "skills"
      && segments[codexIndex + 2] === allowCodexSkillId;
    if (!allowedSkillsRoot && !allowedSkillPath) throw policyError("path_codex_data_rejected");
  }
  return exact;
}

function normalizeInstallCandidate(candidate) {
  return normalizeCanonicalWindowsPath(candidate, { allowTrailingSeparator: true });
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

function isOwnershipPath(value, options) {
  try {
    normalizeCanonicalWindowsPath(value, options);
    return true;
  } catch {
    return false;
  }
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

function isPathRecord(value, pathField, options) {
  return isPlainObject(value) && Object.hasOwn(value, pathField) && isOwnershipPath(value[pathField], options)
    && isJsonValue(value);
}

function isRecordMap(value, pathField) {
  return isPlainObject(value) && Object.entries(value).every(([id, record]) => (
    SKILL_ID_PATTERN.test(id) && isPathRecord(record, pathField)
  ));
}

function deriveCanonicalSkillTarget(skillsRoot, skillId) {
  if (typeof skillsRoot !== "string" || !SKILL_ID_PATTERN.test(skillId)) {
    throw policyError("skill_context_invalid");
  }
  const root = normalizeCanonicalWindowsPath(skillsRoot, { allowCodexSkillsRoot: true });
  if (root !== skillsRoot) throw policyError("skill_context_noncanonical");
  const target = normalizeCanonicalWindowsPath(path.win32.join(root, skillId), { allowCodexSkillId: skillId });
  if (path.win32.dirname(target) !== root) throw policyError("skill_path_escape");
  return target;
}

function isSkillRecordMap(value, skillsRoot) {
  if (!isPlainObject(value)) return false;
  return Object.entries(value).every(([id, record]) => {
    if (!SKILL_ID_PATTERN.test(id) || !isPlainObject(record) || !Object.hasOwn(record, "target")
      || typeof record.target !== "string" || !isJsonValue(record)) return false;
    try {
      return record.target === deriveCanonicalSkillTarget(skillsRoot, id);
    } catch {
      return false;
    }
  });
}

function isShortcutRecordList(value, ownership) {
  return Array.isArray(value) && value.every((shortcut) => {
    if (!isValidShortcutRecord(shortcut, { includeComponentId: true })) return false;
    return isShortcutBoundToCurrent(shortcut, ownership);
  });
}

export function isValidOwnershipState(value, { skillsRoot } = {}) {
  if (!isPlainObject(value) || Object.keys(value).length !== OWNERSHIP_KEYS.length
    || !OWNERSHIP_KEYS.every((key) => Object.hasOwn(value, key))) return false;
  const validRollback = value.rollback === null
    || isPathRecord(value.rollback, "path")
    || (Array.isArray(value.rollback) && value.rollback.every((record) => isPathRecord(record, "path")));
  return value.schemaVersion === 1
    && Number.isSafeInteger(value.generation) && value.generation >= 0
    && (value.installRoot === null || isOwnershipPath(value.installRoot))
    && isRecordMap(value.components, "installPath")
    && isSkillRecordMap(value.skills, skillsRoot)
    && isShortcutRecordList(value.shortcuts, value)
    && validRollback
    && isValidActiveTask(value.activeTask, { ownership: value, skillsRoot })
    && (value.lastTask === null || (isPlainObject(value.lastTask) && isJsonValue(value.lastTask)));
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

function opaqueCapability() {
  return Object.freeze(Object.create(null));
}

async function requireStableDirectory({ candidate, options, realpath, lstat, code }) {
  if (typeof realpath !== "function" || typeof lstat !== "function") throw policyError(`${code}_resolver_invalid`);
  const expected = normalizeCanonicalWindowsPath(candidate, options);
  const resolved = normalizeCanonicalWindowsPath(await realpath(expected), options);
  if (resolved.toLowerCase() !== expected.toLowerCase()) throw policyError(`${code}_identity_changed`);
  const stat = await lstat(expected);
  if (!stat?.isDirectory?.() || stat?.isSymbolicLink?.() || stat?.isReparsePoint?.()) {
    throw policyError(`${code}_reparse_or_not_directory`);
  }
  const dev = stat?.dev;
  const ino = stat?.ino;
  if (!(["number", "bigint"].includes(typeof dev) && ["number", "bigint"].includes(typeof ino))) {
    throw policyError(`${code}_identity_unavailable`);
  }
  return { path: expected, identity: `${String(dev)}:${String(ino)}` };
}

export async function authorizeInstallRoot({ candidate, env = {}, maxRelativePath, access, realpath, lstat }) {
  const validated = await validateInstallRoot({ candidate, env, maxRelativePath, access });
  if (!validated.ok) throw policyError(validated.error);
  const stable = await requireStableDirectory({
    candidate: validated.path,
    options: {},
    realpath,
    lstat,
    code: "install_root",
  });
  const capability = opaqueCapability();
  INSTALL_ROOT_CAPABILITIES.set(capability, Object.freeze({
    ...stable, env: { ...env }, maxRelativePath, access, realpath, lstat,
  }));
  return capability;
}

export async function authorizeSkillsRoot({ candidate, realpath, lstat }) {
  const stable = await requireStableDirectory({
    candidate,
    options: { allowCodexSkillsRoot: true },
    realpath,
    lstat,
    code: "skills_root",
  });
  if (!/\\\.codex\\skills$/iu.test(stable.path)) throw policyError("skills_root_rejected");
  const capability = opaqueCapability();
  FIXED_DIRECTORY_CAPABILITIES.set(capability, Object.freeze({ kind: "skills", ...stable, realpath, lstat }));
  return capability;
}

export async function authorizeDesktopPath({ getDesktopPath, realpath, lstat }) {
  if (typeof getDesktopPath !== "function") throw policyError("desktop_resolver_invalid");
  const stable = await requireStableDirectory({
    candidate: getDesktopPath(),
    options: {},
    realpath,
    lstat,
    code: "desktop",
  });
  const capability = opaqueCapability();
  FIXED_DIRECTORY_CAPABILITIES.set(capability, Object.freeze({ kind: "desktop", ...stable, realpath, lstat }));
  return capability;
}

export function readInstallRootCapability(capability) {
  const value = INSTALL_ROOT_CAPABILITIES.get(capability);
  if (!value) throw policyError("install_root_capability_invalid");
  return value.path;
}

export function readFixedDirectoryCapability(capability) {
  const value = FIXED_DIRECTORY_CAPABILITIES.get(capability);
  if (!value) throw policyError("fixed_directory_capability_invalid");
  return { kind: value.kind, path: value.path };
}

export async function revalidateInstallRootCapability(capability, { maxRelativePath } = {}) {
  const value = INSTALL_ROOT_CAPABILITIES.get(capability);
  if (!value) throw policyError("install_root_capability_invalid");
  const requestedBudget = maxRelativePath ?? value.maxRelativePath;
  const validated = await validateInstallRoot({
    candidate: value.path, env: value.env, maxRelativePath: requestedBudget, access: value.access,
  });
  if (!validated.ok) throw policyError(validated.error);
  const current = await requireStableDirectory({
    candidate: value.path, options: {}, realpath: value.realpath, lstat: value.lstat, code: "install_root",
  });
  if (current.identity !== value.identity) throw policyError("install_root_identity_changed");
  return value.path;
}

export async function revalidateFixedDirectoryCapability(capability) {
  const value = FIXED_DIRECTORY_CAPABILITIES.get(capability);
  if (!value) throw policyError("fixed_directory_capability_invalid");
  const options = value.kind === "skills" ? { allowCodexSkillsRoot: true } : {};
  const current = await requireStableDirectory({
    candidate: value.path, options, realpath: value.realpath, lstat: value.lstat, code: value.kind === "skills" ? "skills_root" : "desktop",
  });
  if (current.identity !== value.identity) throw policyError(`${value.kind === "skills" ? "skills_root" : "desktop"}_identity_changed`);
  return { kind: value.kind, path: value.path };
}

export async function resolveSkillTarget({ skillsRoot, skillId, realpath, lstat }) {
  if (typeof skillId !== "string" || !SKILL_ID_PATTERN.test(skillId)) throw policyError("skill_id_rejected");
  if (typeof realpath !== "function" || typeof lstat !== "function") throw policyError("skill_resolver_invalid");
  const root = await realpath(skillsRoot);
  const target = deriveCanonicalSkillTarget(root, skillId);
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

export function isOwnedPath({ target, ownership, skillsRoot }) {
  if (!isValidOwnershipState(ownership, { skillsRoot }) || typeof target !== "string"
    || !path.win32.isAbsolute(target) || hasParentTraversal(target)) return false;
  return collectOwnedAnchors(ownership)
    .filter((anchor) => typeof anchor === "string" && path.win32.isAbsolute(anchor) && !hasParentTraversal(anchor))
    .some((anchor) => isEqualOrWithinWindows(target, anchor));
}
