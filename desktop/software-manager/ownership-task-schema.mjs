import path from "node:path";

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const VERSION = /^\d+(?:\.\d+){0,3}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const COMPONENT = new Set(["chatgpt", "v2rayn"]);
const GIT_TASK = new Set(["git-install", "git-install-cleanup", "git-rollback", "git-rollback-cleanup", "git-uninstall"]);

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

function validShortcut(task) {
  const common = ["kind", "phase", "taskId", "componentId", "desktopPath", "targetPath"];
  const keys = task.phase === "applied" ? [...common, "shortcut"] : common;
  if (!exact(task, keys) || task.kind !== "component-shortcut" || !["reserved", "applied"].includes(task.phase)
    || !TASK_ID.test(task.taskId) || !COMPONENT.has(task.componentId)
    || !canonicalPath(task.desktopPath) || !canonicalPath(task.targetPath)) return false;
  return task.phase === "reserved" || (exact(task.shortcut, ["name", "desktopPath", "targetPath", "reservationId", "path"])
    && task.shortcut.desktopPath === task.desktopPath && task.shortcut.targetPath === task.targetPath
    && task.shortcut.reservationId === task.taskId && canonicalPath(task.shortcut.path)
    && path.win32.dirname(task.shortcut.path) === task.desktopPath);
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
    || typeof ownership.installRoot !== "string" || !within(task.targetDir, ownership.installRoot)) return false;
  if (task.kind === "git-uninstall") return exact(task, ["kind", "taskId", "targetDir", "executablePath"]);
  if (task.kind === "git-install-cleanup") return exact(task, ["kind", "taskId", "targetDir", "executablePath", "replacedInstaller"])
    && installer(task.replacedInstaller);
  if (task.kind === "git-rollback-cleanup") return exact(task, ["kind", "taskId", "targetDir", "executablePath", "rejectedInstaller"])
    && installer(task.rejectedInstaller);
  const tail = task.kind === "git-install" ? "replacedInstaller" : "rejectedInstaller";
  return exact(task, ["kind", "taskId", "version", "targetDir", "executablePath", "installerPath", "installerSha256", tail])
    && VERSION.test(task.version) && canonicalPath(task.installerPath) && SHA256.test(task.installerSha256)
    && (task[tail] === null || installer(task[tail]));
}

function validSkill(task, skillsRoot) {
  if (!SKILL_ID.test(task.skillId ?? "") || !TASK_ID.test(task.taskId ?? "")
    || task.skillsRoot !== skillsRoot || !canonicalPath(task.skillsRoot) || !canonicalPath(task.target)
    || task.target !== path.win32.join(skillsRoot, task.skillId)) return false;
  if (task.kind === "skill-uninstall") {
    return exact(task, ["kind", "taskId", "skillId", "skillsRoot", "target"]);
  }
  if (task.kind !== "skill-replace" || !["reserved", "applied"].includes(task.phase)) return false;
  const common = ["kind", "phase", "taskId", "skillId", "skillsRoot", "target", "version", "packageSha256", "skillMdSha256", "treeDigest", "manifestDigest", "previousEvidence"];
  const keys = task.phase === "applied" ? [...common, "completionProof", "appliedEvidence"] : common;
  return exact(task, keys) && VERSION.test(task.version) && SHA256.test(task.packageSha256)
    && SHA256.test(task.skillMdSha256) && SHA256.test(task.treeDigest) && SHA256.test(task.manifestDigest)
    && skillEvidence(task.previousEvidence, true)
    && (task.phase === "reserved" || (json(task.completionProof) && skillEvidence(task.appliedEvidence)));
}

export function isValidActiveTask(task, { ownership, skillsRoot } = {}) {
  if (task === null) return true;
  if (!record(task) || !record(ownership) || !Number.isSafeInteger(ownership.generation)) return false;
  if (task.kind === "software-version-slot") return validVersionSlot(task, ownership);
  if (task.kind === "component-shortcut") return validShortcut(task);
  if (task.kind === "component-uninstall") return validComponentUninstall(task, ownership);
  if (task.kind === "component-prepare") {
    return exact(task, ["kind", "taskId", "componentId", "version"])
      && TASK_ID.test(task.taskId) && ["chatgpt", "v2rayn", "git"].includes(task.componentId)
      && VERSION.test(task.version);
  }
  if (task.kind === "skill-prepare") {
    return exact(task, ["kind", "taskId", "skillId", "version"])
      && TASK_ID.test(task.taskId) && SKILL_ID.test(task.skillId) && VERSION.test(task.version);
  }
  if (GIT_TASK.has(task.kind)) return validGit(task, ownership);
  if (["skill-replace", "skill-uninstall"].includes(task.kind)) return validSkill(task, skillsRoot);
  return false;
}
