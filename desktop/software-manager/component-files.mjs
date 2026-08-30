import path from "node:path";

import { compareVersions } from "../../shared/software-manager/catalog-schema.mjs";
import { isTrustedCatalogService } from "./catalog-trust.mjs";
import { readInstallRootCapability, revalidateInstallRootCapability } from "./path-policy.mjs";

const VERSION = /^\d+(?:\.\d+){1,3}$/u;
const GIT_VERSION = /^(\d+(?:\.\d+){1,3})(?:\.windows\.([1-9]\d*))?$/u;
const GIT_VERSION_OUTPUT = /^git version (\d+(?:\.\d+){1,3})\.windows\.([1-9]\d*)\r?\n?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CHATGPT_VERSION_MARKER = ".codexbridge-chatgpt-version.json";
const CHATGPT_VERSION_MARKER_MAX_BYTES = 1_024;
const CHATGPT_RUNTIME_REQUIRED_FILES = new Set([
  CHATGPT_VERSION_MARKER,
  "ChatGPT.exe",
  "Codex.exe",
  "chrome.dll",
  "resources/app.asar",
  "resources/codex.exe",
]);
const V2RAYN_RUNTIME_REQUIRED_FILES = new Set([
  "v2rayn/v2rayN.exe",
  "v2rayn/guiConfigs/guiNConfig.json",
  "v2rayn/e_sqlite3.dll",
  "v2rayn/bin/mihomo/mihomo.exe",
  "v2rayn/bin/sing_box/sing-box.exe",
  "v2rayn/bin/xray/xray.exe",
]);
const PREPARE_NAME = /^\.p-[a-f0-9]{32}$/u;
const MISSING_CODES = new Set([
  "entry_missing", "ENOENT", "ERROR_FILE_NOT_FOUND", "ERROR_PATH_NOT_FOUND", "windows_path_missing",
]);
const COMPONENT_SLOTS = Object.freeze({
  chatgpt: Object.freeze({ staging: "ct", current: "c" }),
  v2rayn: Object.freeze({ staging: "staging", current: "current" }),
});
const CHATGPT_OWNED_CHILDREN = Object.freeze(["c", "cp", "ct", "cr"]);

function componentError(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  return isPlainRecord(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function runtimeRequiredRelativeFiles(entry) {
  if (entry.id === "git") return entry.requiredFiles;
  const allowlist = entry.id === "chatgpt"
    ? CHATGPT_RUNTIME_REQUIRED_FILES
    : V2RAYN_RUNTIME_REQUIRED_FILES;
  const critical = entry.requiredFiles.filter((item) => allowlist.has(item));
  return critical.includes(entry.entrypoint) ? critical : [entry.entrypoint, ...critical];
}

function relativeBudget(installRoot, paths) {
  let maximum = 0;
  for (const filePath of paths) {
    const relative = path.win32.relative(installRoot, filePath);
    if (path.win32.isAbsolute(relative) || relative === ".." || relative.startsWith("..\\")) {
      throw componentError("component_catalog_path_mismatch");
    }
    maximum = Math.max(maximum, relative.length);
  }
  return maximum;
}

function canonicalPath(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.includes("/")) {
    throw componentError(code);
  }
  if (!/^[A-Za-z]:\\/u.test(value) || path.win32.normalize(value) !== value) throw componentError(code);
  const segments = value.slice(3).split("\\");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".."
    || /[<>:"|?*\u0000-\u001f]/u.test(segment) || /[ .]$/u.test(segment))) {
    throw componentError(code);
  }
  return value;
}

function samePath(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

function parseGitVersion(value) {
  const match = GIT_VERSION.exec(value ?? "");
  return match ? Object.freeze({ base: match[1], windowsRevision: match[2] ?? null }) : null;
}

function relativeFile(root, relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.includes("\\")
    || relativePath.startsWith("/") || relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
    throw componentError("component_catalog_path_invalid");
  }
  return path.win32.join(root, ...relativePath.split("/"));
}

function componentRoot(installRoot, componentId) {
  return componentId === "chatgpt" ? installRoot : path.win32.join(installRoot, "V2RayN");
}

function slotRoot(installRoot, componentId, phase) {
  return path.win32.join(componentRoot(installRoot, componentId), COMPONENT_SLOTS[componentId][phase]);
}

function requireFileCapabilities(value) {
  const methods = ["pinArchiveFileNoFollow", "openDirectoryNoFollow", "openInstallerWorkspaceRootNoFollow"];
  if (!value || methods.some((name) => typeof value[name] !== "function")) {
    throw componentError("component_file_capabilities_required");
  }
  return value;
}

function requireWorkspace(value) {
  if (!value || typeof value.consumePromotedPackageProof !== "function") {
    throw componentError("component_workspace_required");
  }
  return value;
}

function requireVersionReader(value) {
  if (!value || typeof value.readFileVersion !== "function") throw componentError("component_version_reader_required");
  return value;
}

function publicIdentity(value) {
  if (!isPlainRecord(value) || typeof value.volumeSerial !== "string" || value.volumeSerial.length === 0
    || typeof value.fileId !== "string" || value.fileId.length === 0) {
    throw componentError("persistent_directory_identity_invalid");
  }
  return Object.freeze({ volumeSerial: value.volumeSerial, fileId: value.fileId });
}

function identityKey(value) {
  const identity = publicIdentity(value);
  return `${identity.volumeSerial}\0${identity.fileId}`;
}

function isMissing(error) {
  return MISSING_CODES.has(error?.code) || MISSING_CODES.has(error?.cause?.code);
}

function parseChatGPTVersionMarker(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > CHATGPT_VERSION_MARKER_MAX_BYTES) {
    throw componentError("component_version_marker_invalid");
  }
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch (error) {
    throw componentError("component_version_marker_invalid", error);
  }
  if (!exactKeys(value, ["schemaVersion", "componentId", "version"])
    || value.schemaVersion !== 1 || value.componentId !== "chatgpt" || !VERSION.test(value.version ?? "")) {
    throw componentError("component_version_marker_invalid");
  }
  return value.version;
}

export function createComponentFileService({
  fileCapabilities,
  installRootCapability,
  catalogService,
  workspace,
  versionReader,
  execFile,
  deleteAuthorizedTree,
  gitTimeoutMs = 15_000,
} = {}) {
  const files = requireFileCapabilities(fileCapabilities);
  const packages = requireWorkspace(workspace);
  const versions = requireVersionReader(versionReader);
  if (!isTrustedCatalogService(catalogService)) throw componentError("trusted_catalog_service_required");
  if (typeof execFile !== "function") throw componentError("component_exec_file_required");
  if (typeof deleteAuthorizedTree !== "function") throw componentError("component_delete_capability_required");
  if (!Number.isSafeInteger(gitTimeoutMs) || gitTimeoutMs <= 0 || gitTimeoutMs > 60_000) {
    throw componentError("git_version_timeout_invalid");
  }
  const installRoot = readInstallRootCapability(installRootCapability);

  function validateVerificationPlan(plan) {
    if (!isPlainRecord(plan) || !Object.hasOwn(COMPONENT_SLOTS, plan.componentId)
      || !["staging", "current"].includes(plan.phase)) {
      throw componentError("component_verification_plan_invalid");
    }
    const keys = plan.phase === "staging"
      ? ["componentId", "phase", "stagingName", "rootPath", "entrypointPath", "requiredFiles", "expectedVersion", "expectedPackageSha256", "packageProof"]
      : ["componentId", "phase", "rootPath", "entrypointPath", "requiredFiles", "expectedVersion"];
    if (!exactKeys(plan, keys) || !Array.isArray(plan.requiredFiles) || !VERSION.test(plan.expectedVersion ?? "")) {
      throw componentError("component_verification_plan_invalid");
    }
    if (plan.phase === "staging" && (!SHA256.test(plan.expectedPackageSha256 ?? "")
      || !PREPARE_NAME.test(plan.stagingName ?? "")
      || plan.packageProof === null || typeof plan.packageProof !== "object")) {
      throw componentError("component_verification_plan_invalid");
    }
    return plan;
  }

  async function verifyComponent(rawPlan) {
    const plan = validateVerificationPlan(rawPlan);
    const entry = catalogService.getComponent(plan.componentId);
    if (entry.version !== plan.expectedVersion) throw componentError("component_catalog_version_mismatch");
    const expectedRoot = plan.phase === "staging"
      ? path.win32.join(componentRoot(installRoot, plan.componentId), plan.stagingName)
      : slotRoot(installRoot, plan.componentId, plan.phase);
    const expectedEntrypoint = relativeFile(expectedRoot, entry.entrypoint);
    const expectedRequiredFiles = runtimeRequiredRelativeFiles(entry)
      .map((item) => relativeFile(expectedRoot, item));
    let rootPath;
    let entrypointPath;
    let requiredFiles;
    try {
      rootPath = canonicalPath(plan.rootPath, "component_catalog_path_mismatch");
      entrypointPath = canonicalPath(plan.entrypointPath, "component_catalog_path_mismatch");
      requiredFiles = plan.requiredFiles.map((item) => canonicalPath(item, "component_catalog_path_mismatch"));
    } catch (error) {
      if (error?.code) throw error;
      throw componentError("component_catalog_path_mismatch", error);
    }
    if (!samePath(rootPath, expectedRoot) || !samePath(entrypointPath, expectedEntrypoint)
      || requiredFiles.length !== expectedRequiredFiles.length
      || requiredFiles.some((item, index) => !samePath(item, expectedRequiredFiles[index]))) {
      throw componentError("component_catalog_path_mismatch");
    }
    await revalidateInstallRootCapability(installRootCapability, {
      maxRelativePath: relativeBudget(installRoot, [rootPath, entrypointPath, ...requiredFiles]),
    });
    if (plan.phase === "staging" && plan.expectedPackageSha256 !== entry.sha256) {
      throw componentError("component_catalog_package_mismatch");
    }

    const pins = [];
    const pinsByPath = new Map();
    let primaryError = null;
    try {
      const uniquePaths = [...new Map(requiredFiles.map((item) => [item.toLowerCase(), item])).values()];
      if (!uniquePaths.some((item) => samePath(item, entrypointPath))) {
        throw componentError("component_entrypoint_not_required");
      }
      for (const filePath of uniquePaths) {
        const pin = await files.pinArchiveFileNoFollow(filePath);
        if (!pin || typeof pin.assertStableNoFollow !== "function" || typeof pin.close !== "function") {
          throw componentError("component_file_pin_invalid");
        }
        pins.push(pin);
        pinsByPath.set(filePath.toLowerCase(), pin);
        await pin.assertStableNoFollow();
      }
      let actualVersion;
      const markerPath = relativeFile(expectedRoot, CHATGPT_VERSION_MARKER);
      if (plan.componentId === "chatgpt"
        && uniquePaths.some((item) => samePath(item, markerPath))) {
        const markerPin = pinsByPath.get(markerPath.toLowerCase());
        if (typeof markerPin?.readFileNoFollow !== "function") {
          throw componentError("component_version_marker_capability_required");
        }
        actualVersion = parseChatGPTVersionMarker(
          await markerPin.readFileNoFollow(CHATGPT_VERSION_MARKER_MAX_BYTES),
        );
      } else {
        actualVersion = await versions.readFileVersion(entrypointPath);
      }
      if (!VERSION.test(actualVersion ?? "") || compareVersions(actualVersion, plan.expectedVersion) !== 0) {
        throw componentError("component_version_mismatch");
      }
      for (const pin of pins) await pin.assertStableNoFollow();
      if (plan.phase === "staging") {
        const extension = entry.format;
        const packagePath = path.win32.join(installRoot, "downloads", `${plan.componentId}-${entry.version}.${extension}`);
        await packages.consumePromotedPackageProof(plan.packageProof, {
          path: packagePath, size: entry.size, sha256: entry.sha256,
        });
      }
    } catch (error) {
      primaryError = error;
    }
    const closeErrors = [];
    for (const pin of pins.reverse()) {
      try { await pin.close(); } catch (error) { closeErrors.push(error); }
    }
    if (primaryError && closeErrors.length > 0) {
      throw new AggregateError([primaryError, ...closeErrors], primaryError.message, { cause: primaryError });
    }
    if (primaryError) throw primaryError;
    if (closeErrors.length === 1) throw closeErrors[0];
    if (closeErrors.length > 1) throw new AggregateError(closeErrors, "component_file_release_failed");
    return Object.freeze({ componentId: plan.componentId, version: plan.expectedVersion });
  }

  async function verifyGitVersion(rawExecutablePath, expectedVersion) {
    const executablePath = canonicalPath(rawExecutablePath, "git_executable_path_invalid");
    const parsedExpectedVersion = parseGitVersion(expectedVersion);
    if (!parsedExpectedVersion || path.win32.basename(executablePath).toLowerCase() !== "git.exe"
      || path.win32.basename(path.win32.dirname(executablePath)).toLowerCase() !== "cmd") {
      throw componentError("git_executable_path_invalid");
    }
    const pin = await files.pinArchiveFileNoFollow(executablePath);
    if (!pin || typeof pin.assertStableNoFollow !== "function" || typeof pin.close !== "function") {
      throw componentError("component_file_pin_invalid");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(componentError("git_version_timeout")), gitTimeoutMs);
    timer.unref?.();
    let primaryError = null;
    try {
      await pin.assertStableNoFollow();
      const result = await execFile(executablePath, ["--version"], {
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: gitTimeoutMs,
        signal: controller.signal,
        env: Object.create(null),
      });
      const exitCode = result?.exitCode ?? result?.code ?? 0;
      const stdout = Buffer.isBuffer(result?.stdout) ? result.stdout.toString("utf8") : result?.stdout;
      const stderr = Buffer.isBuffer(result?.stderr) ? result.stderr.toString("utf8") : (result?.stderr ?? "");
      if (exitCode !== 0 || typeof stdout !== "string" || typeof stderr !== "string" || stderr.length !== 0) {
        throw componentError("git_version_output_invalid");
      }
      const match = GIT_VERSION_OUTPUT.exec(stdout);
      const actualBase = match?.[1];
      const actualWindowsRevision = match?.[2] ?? null;
      if (!match || compareVersions(actualBase, parsedExpectedVersion.base) !== 0
        || (parsedExpectedVersion.windowsRevision !== null
          && actualWindowsRevision !== parsedExpectedVersion.windowsRevision)) {
        throw componentError("git_version_mismatch");
      }
      await pin.assertStableNoFollow();
    } catch (error) {
      primaryError = controller.signal.aborted ? controller.signal.reason : error;
    } finally {
      clearTimeout(timer);
      try { await pin.close(); } catch (error) {
        if (primaryError) throw new AggregateError([primaryError, error], primaryError.message, { cause: primaryError });
        throw error;
      }
    }
    if (primaryError) throw primaryError;
    return Object.freeze({ version: expectedVersion });
  }

  async function deleteOne(target, childName) {
    const root = await files.openDirectoryNoFollow(installRoot);
    if (!root || typeof root.openChildNoFollow !== "function" || typeof root.close !== "function") {
      throw componentError("component_directory_capability_invalid");
    }
    let descriptor;
    try {
      descriptor = await root.openChildNoFollow(childName);
    } catch (error) {
      try { await root.close(); } catch {}
      if (isMissing(error)) return false;
      throw error;
    }
    if (!descriptor || descriptor.kind !== "directory") {
      try { await root.close(); } catch {}
      throw componentError("component_delete_target_invalid");
    }
    await deleteAuthorizedTree({
      target,
      authorizedRoot: installRoot,
      rootHandle: root,
      targetDescriptor: descriptor,
    });
    return true;
  }

  async function deleteComponent(plan) {
    if (!exactKeys(plan, ["componentId", "rootPath", "authorizedRoot"])
      || !["chatgpt", "v2rayn", "git"].includes(plan.componentId)) {
      throw componentError("component_delete_plan_invalid");
    }
    await revalidateInstallRootCapability(installRootCapability);
    const authorizedRoot = canonicalPath(plan.authorizedRoot, "component_delete_root_invalid");
    const rootPath = canonicalPath(plan.rootPath, "component_delete_target_invalid");
    if (!samePath(authorizedRoot, installRoot)) throw componentError("component_delete_root_invalid");
    if (plan.componentId === "chatgpt") {
      if (!samePath(rootPath, installRoot)) throw componentError("component_delete_target_invalid");
      for (const name of CHATGPT_OWNED_CHILDREN) await deleteOne(path.win32.join(installRoot, name), name);
      return true;
    }
    const name = plan.componentId === "v2rayn" ? "V2RayN" : "Git";
    const expected = path.win32.join(installRoot, name);
    if (!samePath(rootPath, expected)) throw componentError("component_delete_target_invalid");
    await deleteOne(expected, name);
    return true;
  }

  async function readPersistentIdentity() {
    const root = await files.openDirectoryNoFollow(installRoot);
    if (!root || typeof root.openChildNoFollow !== "function" || typeof root.close !== "function") {
      throw componentError("persistent_directory_capability_invalid");
    }
    try {
      const descriptor = await root.openChildNoFollow("V2RayN-Data");
      if (!descriptor || descriptor.kind !== "directory") throw componentError("persistent_directory_invalid");
      return publicIdentity(descriptor.identity);
    } finally {
      await root.close();
    }
  }

  function validatePersistentPlan(plan, withEvidence = false) {
    const keys = withEvidence ? ["componentId", "rootPath", "evidence"] : ["componentId", "rootPath"];
    if (!exactKeys(plan, keys) || plan.componentId !== "v2rayn"
      || !samePath(canonicalPath(plan.rootPath, "persistent_directory_path_invalid"), path.win32.join(installRoot, "V2RayN-Data"))) {
      throw componentError("persistent_directory_path_invalid");
    }
    return plan;
  }

  async function preparePersistentDirectory(rawPlan) {
    validatePersistentPlan(rawPlan);
    await revalidateInstallRootCapability(installRootCapability);
    const session = await files.openInstallerWorkspaceRootNoFollow(installRootCapability, { maxRelativePath: 32 });
    if (!session || !session.root || typeof session.createOrOpenDirectoryChildNoFollow !== "function"
      || typeof session.close !== "function") throw componentError("persistent_directory_capability_invalid");
    try {
      await session.createOrOpenDirectoryChildNoFollow(
        session.root, "V2RayN-Data", { requireEmpty: false, role: "anchor" },
      );
    } finally {
      await session.close();
    }
    const identity = await readPersistentIdentity();
    return Object.freeze({ kind: "directory", identity });
  }

  async function verifyPersistentDirectory(rawPlan) {
    const plan = validatePersistentPlan(rawPlan, true);
    if (!exactKeys(plan.evidence, ["kind", "identity"]) || plan.evidence.kind !== "directory") {
      throw componentError("persistent_directory_identity_invalid");
    }
    await revalidateInstallRootCapability(installRootCapability);
    const current = await readPersistentIdentity();
    if (identityKey(current) !== identityKey(plan.evidence.identity)) {
      throw componentError("persistent_directory_identity_changed");
    }
    return true;
  }

  return Object.freeze({
    verifyComponent,
    verifyGitVersion,
    deleteComponent,
    preparePersistentDirectory,
    verifyPersistentDirectory,
  });
}
