import path from "node:path";

import { readInstallRootCapability } from "./path-policy.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const VERSION = /^\d+(?:\.\d+){0,3}$/u;
const PINS = new WeakMap();

function identityError(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalPath(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.includes("/")
    || !/^[A-Za-z]:\\/u.test(value) || path.win32.normalize(value) !== value
    || value.includes("\0")) throw identityError(code);
  return value;
}

function samePath(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

function validateDiscovery(value, targetDir) {
  if (!isRecord(value) || value.kind !== "external" || value.ownership !== "external"
    || typeof value.version !== "string" || value.version.length === 0
    || typeof value.registryKey !== "string" || value.registryKey.length === 0) {
    throw identityError("git_identity_discovery_invalid");
  }
  const installDir = canonicalPath(value.installDir, "git_identity_install_dir_invalid");
  const executablePath = canonicalPath(value.executablePath, "git_identity_executable_invalid");
  const uninstallerPath = canonicalPath(value.uninstallerPath, "git_identity_uninstaller_invalid");
  if (!samePath(installDir, targetDir)
    || !samePath(path.win32.dirname(path.win32.dirname(executablePath)), installDir)
    || path.win32.basename(path.win32.dirname(executablePath)).toLowerCase() !== "cmd"
    || path.win32.basename(executablePath).toLowerCase() !== "git.exe"
    || !samePath(path.win32.dirname(uninstallerPath), installDir)
    || !/^unins\d{3}\.exe$/iu.test(path.win32.basename(uninstallerPath))) {
    throw identityError("git_identity_discovery_path_mismatch");
  }
  return structuredClone(value);
}

function validateRetained(value, downloadsRoot) {
  if (!isRecord(value) || !VERSION.test(value.version ?? "") || !SHA256.test(value.sha256 ?? "")) {
    throw identityError("git_retained_installer_invalid");
  }
  const filePath = canonicalPath(value.path, "git_retained_installer_invalid");
  if (!samePath(path.win32.dirname(filePath), downloadsRoot)
    || path.win32.basename(filePath).toLowerCase() !== `git-${value.version}.exe`.toLowerCase()) {
    throw identityError("git_retained_installer_path_rejected");
  }
  return Object.freeze({ path: filePath, sha256: value.sha256, version: value.version });
}

function validateFilePin(value) {
  if (!value || typeof value.assertStableNoFollow !== "function" || typeof value.close !== "function") {
    throw identityError("git_file_pin_invalid");
  }
  return value;
}

function validateDirectoryPin(value) {
  if (!value || typeof value.close !== "function") throw identityError("git_directory_pin_invalid");
  return value;
}

async function closeAll(handles) {
  const errors = [];
  for (const handle of handles.reverse()) {
    try { await handle.close(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "git_identity_release_failed");
}

export function createGitIdentityCapabilities({
  fileCapabilities,
  installRootCapability,
  hashFile,
  retainedInstallerStore,
} = {}) {
  if (typeof fileCapabilities?.pinArchiveFileNoFollow !== "function"
    || typeof fileCapabilities?.openDirectoryNoFollow !== "function") {
    throw identityError("git_file_capabilities_required");
  }
  if (typeof hashFile !== "function") throw identityError("git_hash_capability_required");
  if (typeof retainedInstallerStore?.deleteVerified !== "function") {
    throw identityError("git_retained_store_required");
  }
  const installRoot = readInstallRootCapability(installRootCapability);
  const downloadsRoot = path.win32.join(installRoot, "downloads");

  async function pinFile(filePath) {
    const pin = validateFilePin(await fileCapabilities.pinArchiveFileNoFollow(filePath));
    await pin.assertStableNoFollow();
    return pin;
  }

  async function pinPlan(rawPlan) {
    if (!isRecord(rawPlan)) throw identityError("git_identity_plan_invalid");
    const targetDir = canonicalPath(rawPlan.targetDir, "git_identity_target_invalid");
    const handles = [];
    const record = {
      state: "open", targetDir, discovery: null,
      installerPath: null, installerSha256: null, handles,
    };
    try {
      if (rawPlan.installerPath !== undefined) {
        record.installerPath = canonicalPath(rawPlan.installerPath, "git_identity_installer_invalid");
        if (!SHA256.test(rawPlan.installerSha256 ?? "")) throw identityError("git_identity_installer_hash_invalid");
        record.installerSha256 = rawPlan.installerSha256;
        handles.push(await pinFile(record.installerPath));
        if (await hashFile(record.installerPath) !== record.installerSha256) {
          throw identityError("git_identity_installer_hash_mismatch");
        }
      }
      if (rawPlan.discovery !== null && rawPlan.discovery !== undefined) {
        record.discovery = validateDiscovery(rawPlan.discovery, targetDir);
        handles.push(validateDirectoryPin(await fileCapabilities.openDirectoryNoFollow(targetDir)));
        handles.push(await pinFile(record.discovery.executablePath));
        handles.push(await pinFile(record.discovery.uninstallerPath));
      } else if (!samePath(targetDir, path.win32.join(installRoot, "Git"))) {
        throw identityError("git_identity_unregistered_target_rejected");
      }
      const capability = Object.freeze(Object.create(null));
      PINS.set(capability, record);
      return capability;
    } catch (error) {
      await closeAll(handles).catch(() => {});
      throw error;
    }
  }

  function requirePin(capability) {
    const record = PINS.get(capability);
    if (!record || record.state !== "open") throw identityError("git_identity_capability_invalid");
    return record;
  }

  async function revalidate(capability, expectation = {}) {
    const record = requirePin(capability);
    if (!isRecord(expectation)) throw identityError("git_identity_expectation_invalid");
    for (const handle of record.handles) {
      if (typeof handle.assertStableNoFollow === "function") await handle.assertStableNoFollow();
    }
    if (expectation.discovery !== undefined
      && JSON.stringify(validateDiscovery(expectation.discovery, record.targetDir)) !== JSON.stringify(record.discovery)) {
      throw identityError("git_identity_discovery_changed");
    }
    if (record.installerPath !== null) {
      const expectedHash = expectation.installerSha256 ?? record.installerSha256;
      if (expectedHash !== record.installerSha256 || await hashFile(record.installerPath) !== expectedHash) {
        throw identityError("git_identity_installer_hash_mismatch");
      }
    } else if (expectation.installerSha256 !== undefined) {
      throw identityError("git_identity_installer_missing");
    }
  }

  async function release(capability) {
    const record = requirePin(capability);
    record.state = "closed";
    await closeAll(record.handles);
  }

  async function retainInstaller(capability, value) {
    const record = requirePin(capability);
    const retained = validateRetained(value, downloadsRoot);
    if (record.installerPath === null || !samePath(retained.path, record.installerPath)
      || retained.sha256 !== record.installerSha256) throw identityError("git_retained_installer_identity_mismatch");
    await revalidate(capability, { installerSha256: retained.sha256 });
    return retained;
  }

  async function pinRetainedInstaller(value) {
    const retained = validateRetained(value, downloadsRoot);
    return pinPlan({
      installerPath: retained.path,
      installerSha256: retained.sha256,
      targetDir: path.win32.join(installRoot, "Git"),
    });
  }

  async function discardRetainedInstaller(value) {
    const retained = validateRetained(value, downloadsRoot);
    const pin = await pinRetainedInstaller(retained);
    try {
      await revalidate(pin, { installerSha256: retained.sha256 });
    } finally {
      await release(pin);
    }
    await retainedInstallerStore.deleteVerified({ ...retained, installRoot });
  }

  return Object.freeze({
    pinPlan,
    revalidate,
    release,
    retainInstaller,
    pinRetainedInstaller,
    discardRetainedInstaller,
  });
}
