import path from "node:path";

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const VERSION = /^\d+(?:\.\d+){0,3}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const LEASE_NONCE = /^[a-f0-9]{32}$/u;
const SHORTCUT_CREATION_ID = /^[a-f0-9]{32}$/u;
const SKILL_SWAP_ID = /^[a-f0-9]{32}$/u;
const COMPONENT = new Set(["chatgpt", "v2rayn"]);
const GIT_TASK = new Set(["git-install", "git-external-install", "git-install-cleanup", "git-rollback", "git-rollback-cleanup", "git-uninstall"]);
const GIT_REGISTRY_KEYS = new Set([
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Git_is1",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Git_is1",
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Git_is1",
]);
const SHORTCUT_RECORD_KEYS = Object.freeze(["name", "path", "desktopPath", "targetPath", "creationId"]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value, keys) {
  return record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function json(value, seen = new Set(), depth = 0) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > 16 || seen.has(value)) return false;
  if (!Array.isArray(value) && !record(value)) return false;
  seen.add(value);
  const valid = (Array.isArray(value) ? value : Object.values(value)).every((child) => json(child, seen, depth + 1));
  seen.delete(value);
  return valid;
}

function canonicalPath(value) {
  if (typeof value !== "string" || !/^[A-Za-z]:\\/u.test(value) || value.includes("/") || value.includes("\0")) return false;
  const segments = value.slice(3).split("\\");
  return path.win32.normalize(value).replace(/[\\]+$/u, "") === value
    && segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".."
      && !/[ .]$/u.test(segment) && !/[<>:"|?*\u0000-\u001f]/u.test(segment)
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment));
}

function within(target, root) {
  if (!canonicalPath(target) || !canonicalPath(root)) return false;
  const normalizedTarget = target.toLowerCase();
  const normalizedRoot = root.toLowerCase();
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}\\`);
}

function installer(value) {
  return exact(value, ["path", "sha256", "version"])
    && canonicalPath(value.path) && SHA256.test(value.sha256) && VERSION.test(value.version);
}

function identity(value) {
  return exact(value, ["volumeSerial", "fileId"])
    && typeof value.volumeSerial === "string" && value.volumeSerial.length > 0
    && typeof value.fileId === "string" && value.fileId.length > 0;
}

function skillEvidence(value, allowAbsent = false) {
  if (allowAbsent && exact(value, ["kind"]) && value.kind === "absent") return true;
  return exact(value, ["kind", "identity", "treeDigest", "manifestDigest", "skillMdSha256"])
    && value.kind === "directory" && identity(value.identity)
    && SHA256.test(value.treeDigest) && SHA256.test(value.manifestDigest) && SHA256.test(value.skillMdSha256);
}

function validVersionSlot(task, ownership) {
  return exact(task, ["kind", "schemaVersion", "lifecycle", "journalScope", "taskId", "componentId", "mode", "rootPath"])
    && task.kind === "software-version-slot" && task.schemaVersion === 1
    && ["reserved", "active", "clearing"].includes(task.lifecycle)
    && typeof task.journalScope === "string" && task.journalScope === task.journalScope.toLowerCase()
    && TASK_ID.test(task.taskId) && COMPONENT.has(task.componentId)
    && ["promote", "rollback"].includes(task.mode) && canonicalPath(task.rootPath)
    && (ownership.installRoot === null || within(task.rootPath, ownership.installRoot));
}

function validShortcutName(componentId, name, shortcutPath) {
  if (componentId === "chatgpt") return name === "ChatGPT"
    && /^ChatGPT(?:（[1-9]\d*）)?\.lnk$/u.test(path.win32.basename(shortcutPath));
  if (componentId === "v2rayn") return name === "V2RayN"
    && /^V2RayN(?:（[1-9]\d*）)?\.lnk$/u.test(path.win32.basename(shortcutPath));
  return false;
}

export function isValidShortcutRecord(value, {
  componentId,
  desktopPath,
  targetPath,
  includeComponentId = false,
} = {}) {
  const keys = includeComponentId ? ["componentId", ...SHORTCUT_RECORD_KEYS] : SHORTCUT_RECORD_KEYS;
  if (!exact(value, keys)) return false;
  const boundComponentId = includeComponentId ? value.componentId : componentId;
  return COMPONENT.has(boundComponentId)
    && (!includeComponentId || componentId === undefined || componentId === boundComponentId)
    && canonicalPath(value.path) && canonicalPath(value.desktopPath) && canonicalPath(value.targetPath)
    && path.win32.dirname(value.path) === value.desktopPath
    && (desktopPath === undefined || value.desktopPath === desktopPath)
    && (targetPath === undefined || value.targetPath === targetPath)
    && SHORTCUT_CREATION_ID.test(value.creationId)
    && validShortcutName(boundComponentId, value.name, value.path);
}

export function isShortcutBoundToCurrent(value, ownership, componentId = value?.componentId) {
  if (!COMPONENT.has(componentId) || !record(ownership) || !canonicalPath(ownership.installRoot)) return false;
  const component = ownership.components?.[componentId];
  if (!record(component)) return false;
  const currentPath = componentId === "chatgpt"
    ? path.win32.join(ownership.installRoot, "c")
    : path.win32.join(ownership.installRoot, "V2RayN", "current");
  return component.managed === true
    && component.installPath === currentPath
    && component.entrypointPath === value?.targetPath
    && within(component.entrypointPath, currentPath)
    && component.entrypointPath.toLowerCase() !== currentPath.toLowerCase();
}

function validShortcut(task, ownership) {
  const common = ["kind", "phase", "taskId", "componentId", "desktopPath", "targetPath", "shortcut"];
  const keys = common;
  if (!exact(task, keys) || task.kind !== "component-shortcut" || !["reserved", "applied"].includes(task.phase)
    || !TASK_ID.test(task.taskId) || !COMPONENT.has(task.componentId)
    || !canonicalPath(task.desktopPath) || !canonicalPath(task.targetPath)) return false;
  return isShortcutBoundToCurrent(task.shortcut, ownership, task.componentId)
    && isValidShortcutRecord(task.shortcut, {
      componentId: task.componentId, desktopPath: task.desktopPath, targetPath: task.targetPath,
    });
}

function validComponentUninstall(task, ownership) {
  return exact(task, ["kind", "taskId", "componentId", "rootPath"])
    && task.kind === "component-uninstall" && TASK_ID.test(task.taskId) && COMPONENT.has(task.componentId)
    && canonicalPath(task.rootPath)
    && typeof ownership.installRoot === "string" && within(task.rootPath, ownership.installRoot);
}

function validGit(task, ownership) {
  if (!GIT_TASK.has(task.kind) || !TASK_ID.test(task.taskId ?? "")
    || !canonicalPath(task.targetDir) || !canonicalPath(task.executablePath)
    || (!(task.kind === "git-external-install" || (task.kind === "git-uninstall" && task.mode === "external"))
      && (typeof ownership.installRoot !== "string" || !within(task.targetDir, ownership.installRoot)))) return false;
  if (task.kind === "git-uninstall") {
    return exact(task, [
      "kind", "phase", "taskId", "mode", "version", "targetDir", "executablePath", "uninstallerPath",
      "registryKey", "leaseScope", "leaseNonce",
    ]) && task.phase === "executing" && ["managed", "external"].includes(task.mode) && VERSION.test(task.version)
      && canonicalPath(task.uninstallerPath) && GIT_REGISTRY_KEYS.has(task.registryKey)
      && path.win32.dirname(task.uninstallerPath) === task.targetDir
      && /^unins\d{3}\.exe$/iu.test(path.win32.basename(task.uninstallerPath))
      && path.win32.dirname(task.executablePath) === path.win32.join(task.targetDir, "cmd")
      && path.win32.basename(task.executablePath).toLowerCase() === "git.exe"
      && (task.mode !== "managed" || (typeof ownership.installRoot === "string"
        && task.targetDir === path.win32.join(ownership.installRoot, "Git")))
      && task.leaseScope === "git-execute" && LEASE_NONCE.test(task.leaseNonce);
  }
  if (task.kind === "git-install-cleanup") return exact(task, ["kind", "taskId", "targetDir", "executablePath", "replacedInstaller"])
    && installer(task.replacedInstaller);
  if (task.kind === "git-rollback-cleanup") return exact(task, ["kind", "taskId", "targetDir", "executablePath", "rejectedInstaller"])
    && installer(task.rejectedInstaller);
  const tail = task.kind === "git-install" ? "replacedInstaller" : task.kind === "git-external-install" ? null : "rejectedInstaller";
  const keys = ["kind", "taskId", "version", "targetDir", "executablePath", "installerPath", "installerSha256"];
  if (tail) keys.push(tail);
  if (task.kind === "git-rollback") keys.push("phase");
  if (["git-install", "git-external-install", "git-rollback"].includes(task.kind)) keys.push("leaseScope", "leaseNonce");
  return exact(task, keys)
    && VERSION.test(task.version) && canonicalPath(task.installerPath) && SHA256.test(task.installerSha256)
    && (!tail || task[tail] === null || installer(task[tail]))
    && (task.kind !== "git-rollback" || ["uninstalling", "installing"].includes(task.phase))
    && (!["git-install", "git-external-install", "git-rollback"].includes(task.kind)
      || (task.leaseScope === "git-execute" && LEASE_NONCE.test(task.leaseNonce)));
}

function validSkill(task, skillsRoot, ownership) {
  if (!SKILL_ID.test(task.skillId ?? "") || !TASK_ID.test(task.taskId ?? "")
    || task.skillsRoot !== skillsRoot || !canonicalPath(task.skillsRoot) || !canonicalPath(task.target)
    || task.target !== path.win32.join(skillsRoot, task.skillId)) return false;
  if (task.kind === "skill-uninstall") {
    return exact(task, ["kind", "taskId", "skillId", "skillsRoot", "target"]);
  }
  if (task.kind !== "skill-replace" || !["reserved", "applied"].includes(task.phase)) return false;
  if (!canonicalPath(task.installRoot)
    || (ownership.installRoot !== null && ownership.installRoot !== task.installRoot)) return false;
  const common = [
    "kind", "phase", "taskId", "swapId", "skillId", "installRoot", "skillsRoot", "target", "version",
    "packageSha256", "skillMdSha256", "treeDigest", "manifestDigest", "previousEvidence", "leaseScope", "leaseNonce",
  ];
  const keys = task.phase === "applied" ? [...common, "completionProof", "appliedEvidence"] : common;
  return exact(task, keys) && SKILL_SWAP_ID.test(task.swapId ?? "")
    && VERSION.test(task.version) && SHA256.test(task.packageSha256)
    && SHA256.test(task.skillMdSha256) && SHA256.test(task.treeDigest) && SHA256.test(task.manifestDigest)
    && skillEvidence(task.previousEvidence, true)
    && task.leaseScope === "prepare" && LEASE_NONCE.test(task.leaseNonce)
    && (task.phase === "reserved" || (json(task.completionProof) && skillEvidence(task.appliedEvidence)));
}

export function isValidActiveTask(task, { ownership, skillsRoot } = {}) {
  if (task === null) return true;
  if (!record(task) || !record(ownership) || !Number.isSafeInteger(ownership.generation)) return false;
  if (task.kind === "software-version-slot") return validVersionSlot(task, ownership);
  if (task.kind === "component-shortcut") return validShortcut(task, ownership);
  if (task.kind === "component-uninstall") return validComponentUninstall(task, ownership);
  if (task.kind === "component-prepare") {
    const common = ["kind", "taskId", "componentId", "version", "leaseScope", "leaseNonce"];
    const archiveCommon = [...common, "stagingName"];
    const archiveNameValid = /^\.p-[a-f0-9]{32}$/u.test(task.stagingName ?? "");
    const boundArchive = ["chatgpt", "v2rayn"].includes(task.componentId)
      && exact(task, [...archiveCommon, "stagingIdentity"])
      && archiveNameValid
      && identity(task.stagingIdentity);
    const boundFirstV2Archive = task.componentId === "v2rayn"
      && exact(task, [...archiveCommon, "stagingIdentity", "componentRootIdentity"])
      && archiveNameValid
      && identity(task.stagingIdentity)
      && identity(task.componentRootIdentity);
    const reservedArchive = ["chatgpt", "v2rayn"].includes(task.componentId)
      && exact(task, archiveCommon) && archiveNameValid;
    const legacyOrGit = exact(task, common);
    return (legacyOrGit || reservedArchive || boundArchive || boundFirstV2Archive)
      && TASK_ID.test(task.taskId) && ["chatgpt", "v2rayn", "git"].includes(task.componentId)
      && VERSION.test(task.version) && task.leaseScope === "prepare" && LEASE_NONCE.test(task.leaseNonce);
  }
  if (task.kind === "skill-prepare") {
    return exact(task, ["kind", "taskId", "skillId", "version", "leaseScope", "leaseNonce"])
      && TASK_ID.test(task.taskId) && SKILL_ID.test(task.skillId) && VERSION.test(task.version)
      && task.leaseScope === "prepare" && LEASE_NONCE.test(task.leaseNonce);
  }
  if (task.kind === "legacy-abandoned-prepare") {
    return exact(task, ["kind", "originalKind", "taskId", "componentId", "version"])
      && ["component-prepare", "skill-prepare"].includes(task.originalKind)
      && TASK_ID.test(task.taskId) && VERSION.test(task.version)
      && (task.originalKind === "component-prepare"
        ? ["chatgpt", "v2rayn", "git"].includes(task.componentId)
        : SKILL_ID.test(task.componentId));
  }
  if (task.kind === "legacy-git-install-recovery") {
    return exact(task, [
      "kind", "taskId", "version", "targetDir", "executablePath", "installerPath", "installerSha256", "replacedInstaller",
    ]) && TASK_ID.test(task.taskId) && VERSION.test(task.version)
      && canonicalPath(task.targetDir) && canonicalPath(task.executablePath)
      && canonicalPath(task.installerPath) && SHA256.test(task.installerSha256)
      && typeof ownership.installRoot === "string" && within(task.targetDir, ownership.installRoot)
      && (task.replacedInstaller === null || installer(task.replacedInstaller));
  }
  if (GIT_TASK.has(task.kind)) return validGit(task, ownership);
  if (["skill-replace", "skill-uninstall"].includes(task.kind)) return validSkill(task, skillsRoot, ownership);
  return false;
}
