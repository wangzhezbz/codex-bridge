import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import { MAX_SOFTWARE_PACKAGE_BYTES } from "../../shared/software-manager/catalog-schema.mjs";
import { readInstallRootCapability, revalidateInstallRootCapability } from "./path-policy.mjs";

const VERSION = /^\d+(?:\.\d+){1,3}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function retainedError(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function samePath(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

function canonicalPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.includes("/")
    || !/^[A-Za-z]:\\/u.test(value) || path.win32.normalize(value) !== value) {
    throw retainedError("git_retained_installer_path_rejected");
  }
  const segments = value.slice(3).split("\\");
  if (segments.some((segment) => !segment || segment === "." || segment === ".."
    || /[<>:"|?*\u0000-\u001f]/u.test(segment) || /[ .]$/u.test(segment))) {
    throw retainedError("git_retained_installer_path_rejected");
  }
  return value;
}

function validateRecord(record, installRoot, requireAll) {
  const keys = requireAll ? ["installRoot", "path", "sha256", "version"] : ["path"];
  if (!isPlainRecord(record) || Object.keys(record).sort().join("\0") !== keys.sort().join("\0")) {
    throw retainedError("git_retained_installer_invalid");
  }
  const filePath = canonicalPath(record.path);
  const downloadsRoot = path.win32.join(installRoot, "downloads");
  if (!samePath(path.win32.dirname(filePath), downloadsRoot)) {
    throw retainedError("git_retained_installer_path_rejected");
  }
  const match = /^git-(\d+(?:\.\d+){1,3})\.exe$/iu.exec(path.win32.basename(filePath));
  if (!match) throw retainedError("git_retained_installer_path_rejected");
  if (requireAll) {
    if (!samePath(canonicalPath(record.installRoot), installRoot)
      || !VERSION.test(record.version ?? "") || match[1] !== record.version
      || !SHA256.test(record.sha256 ?? "")) {
      throw retainedError("git_retained_installer_invalid");
    }
  }
  return { path: filePath, version: match[1], downloadsRoot };
}

function requireCapabilities(value) {
  if (!value || typeof value.pinExecutableFileNoFollow !== "function"
    || typeof value.deleteVerifiedExecutableFileNoFollow !== "function") {
    throw retainedError("git_retained_file_capabilities_required");
  }
  return value;
}

export function createRetainedInstallerStore({
  fileCapabilities,
  installRootCapability,
  openReadStream = (filePath) => fs.createReadStream(filePath),
} = {}) {
  const files = requireCapabilities(fileCapabilities);
  if (typeof openReadStream !== "function") throw retainedError("git_retained_stream_capability_required");
  const installRoot = readInstallRootCapability(installRootCapability);

  async function hashFile(rawPath) {
    const { path: filePath } = validateRecord({ path: rawPath }, installRoot, false);
    await revalidateInstallRootCapability(installRootCapability, { maxRelativePath: filePath.length - installRoot.length });
    const pin = await files.pinExecutableFileNoFollow(filePath);
    if (!pin || typeof pin.assertStableNoFollow !== "function" || typeof pin.close !== "function") {
      throw retainedError("git_retained_file_pin_invalid");
    }
    let primaryError = null;
    let digest;
    try {
      await pin.assertStableNoFollow();
      const stream = openReadStream(filePath);
      if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
        throw retainedError("git_retained_stream_invalid");
      }
      const hash = createHash("sha256");
      let total = 0;
      for await (const rawChunk of stream) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        total += chunk.length;
        if (!Number.isSafeInteger(total) || total > MAX_SOFTWARE_PACKAGE_BYTES) {
          throw retainedError("git_retained_installer_too_large");
        }
        hash.update(chunk);
      }
      await pin.assertStableNoFollow();
      digest = hash.digest("hex");
    } catch (error) {
      primaryError = error;
    }
    try {
      await pin.close();
    } catch (error) {
      if (primaryError) throw new AggregateError([primaryError, error], primaryError.message, { cause: primaryError });
      throw error;
    }
    if (primaryError) throw primaryError;
    return digest;
  }

  async function deleteVerified(record) {
    if (!isPlainRecord(record)) throw retainedError("git_retained_installer_invalid");
    const validated = validateRecord(record, installRoot, true);
    await revalidateInstallRootCapability(installRootCapability, {
      maxRelativePath: validated.path.length - installRoot.length,
    });
    await files.deleteVerifiedExecutableFileNoFollow(validated.path, record.sha256);
    return Object.freeze({ deleted: true });
  }

  return Object.freeze({ hashFile, deleteVerified });
}
