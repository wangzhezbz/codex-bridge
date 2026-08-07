import crypto from "node:crypto";
import path from "node:path";
import { Writable } from "node:stream";

import { revalidateInstallRootCapability } from "./path-policy.mjs";

const MAX_DEPTH = 64;
const MAX_ENTRIES = 4_096;
const MAX_STATE_BYTES = 16 * 1_024 * 1_024;
const MAX_ARCHIVE_BYTES = 16 * 1_024 * 1_024 * 1_024;
const MAX_PATH_CHARS = 32_760;
const VERSION_MARKER_NAME = ".codexbridge-version.json";
const STATE_LOCK_NAME = ".codexbridge-ownership.lock";
const OPERATION_LEASE_NONCE = /^[a-f0-9]{32}$/u;
const OPERATION_LEASE_SCOPES = new Set(["prepare", "git-execute"]);
const COMPONENT_IDS = new Set(["chatgpt", "v2rayn", "git"]);
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DRIVE_PATH = /^[A-Za-z]:\\/u;
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;
const REQUIRED_NATIVE_METHODS = [
  "openPath", "queryHandle", "finalPath", "readFile", "writeFile", "appendFile", "flushFile",
  "createDirectory", "renameByHandle", "deleteByHandle", "closeHandle",
  "assertNoAlternateDataStreams", "enumerateDirectory",
];

function capabilityError(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function abortError(signal) {
  const error = capabilityError("archive_cancelled", signal?.reason);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function isMissing(error) {
  return error?.code === "entry_missing" || error?.code === "ENOENT"
    || error?.nativeCode === 2 || error?.nativeCode === 3;
}

function isOccupied(error) {
  return error?.code === "entry_exists" || error?.code === "EEXIST"
    || error?.nativeCode === 80 || error?.nativeCode === 183;
}

function isSharingViolation(error) {
  return error?.code === "sharing_violation" || error?.nativeCode === 32 || error?.nativeCode === 33;
}

function validateSegment(segment, code = "windows_path_segment_rejected") {
  if (typeof segment !== "string" || segment.length === 0 || segment !== segment.normalize("NFC")
    || segment === "." || segment === ".." || segment.length > 255
    || /[<>:"/\\|?*\u0000-\u001f]/u.test(segment) || /[ .]$/u.test(segment)
    || RESERVED_NAME.test(segment)) {
    throw capabilityError(code);
  }
  return segment;
}

function validateAbsolute(value, { allowRoot = false } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_CHARS
    || value.includes("/") || !DRIVE_PATH.test(value) || value.startsWith("\\\\")
    || value.startsWith("\\\\?\\") || value.startsWith("\\\\.\\") || value.includes("\0")) {
    throw capabilityError("windows_path_absolute_required");
  }
  const parsed = path.win32.parse(value);
  if (!allowRoot && value.toLowerCase() === parsed.root.toLowerCase()) {
    throw capabilityError("windows_path_root_rejected");
  }
  const tail = value.slice(parsed.root.length);
  const segments = tail.length === 0 ? [] : tail.split("\\");
  if (segments.length > MAX_DEPTH || segments.some((segment) => segment.length === 0)) {
    throw capabilityError("windows_path_depth_rejected");
  }
  for (const segment of segments) validateSegment(segment);
  const normalized = path.win32.normalize(value).normalize("NFC");
  if (normalized !== value.normalize("NFC")) throw capabilityError("windows_path_not_canonical");
  return value.normalize("NFC");
}

function validateChildName(value) {
  return validateSegment(value, "windows_child_name_rejected");
}

function validateRelativeSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0 || segments.length > MAX_DEPTH) {
    throw capabilityError("windows_relative_path_rejected");
  }
  return segments.map((segment) => validateSegment(segment, "windows_relative_path_rejected"));
}

function pathKey(value) {
  return value.normalize("NFC").toLowerCase();
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right);
}

function identityKey(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)
    || typeof identity.volumeSerial !== "string" || typeof identity.fileId !== "string"
    || identity.volumeSerial.length === 0 || identity.fileId.length === 0) {
    throw capabilityError("windows_file_identity_invalid");
  }
  return `${identity.volumeSerial}:${identity.fileId}`;
}

function publicIdentity(identity) {
  identityKey(identity);
  return Object.freeze({ volumeSerial: identity.volumeSerial, fileId: identity.fileId });
}

function validateInfo(info, expectedKind) {
  if (!info || typeof info !== "object" || typeof info.directory !== "boolean"
    || typeof info.reparse !== "boolean" || !Number.isSafeInteger(info.size) || info.size < 0
    || !Number.isSafeInteger(info.nlink) || info.nlink < 1) {
    throw capabilityError("windows_file_information_invalid");
  }
  identityKey(info.identity);
  if (info.reparse || Number(info.reparseTag ?? 0) !== 0) {
    throw capabilityError("windows_reparse_point_rejected");
  }
  if (expectedKind === "directory" && !info.directory) throw capabilityError("windows_directory_required");
  if (expectedKind === "file" && info.directory) throw capabilityError("windows_regular_file_required");
  return info;
}

function verifyIdentity(before, after) {
  validateInfo(after);
  if (identityKey(before) !== identityKey(after.identity)) throw capabilityError("windows_identity_changed");
}

async function closeHandles(nativeApi, handles, primaryError = null) {
  const closeErrors = [];
  for (const handle of [...handles].reverse()) {
    handles.delete(handle);
    try {
      await nativeApi.closeHandle(handle);
    } catch (error) {
      closeErrors.push(error);
    }
  }
  if (primaryError && closeErrors.length > 0) {
    throw new AggregateError([primaryError, ...closeErrors], primaryError.message, { cause: primaryError });
  }
  if (primaryError) throw primaryError;
  if (closeErrors.length === 1) throw closeErrors[0];
  if (closeErrors.length > 1) throw new AggregateError(closeErrors, "windows_handle_close_failed");
}

async function closeOne(nativeApi, owner, handle) {
  if (!owner.handles.delete(handle)) return;
  await nativeApi.closeHandle(handle);
}

function cumulativePaths(exactPath) {
  const parsed = path.win32.parse(exactPath);
  const segments = exactPath.slice(parsed.root.length).split("\\").filter(Boolean);
  const result = [parsed.root];
  let current = parsed.root;
  for (const segment of segments) {
    current = path.win32.join(current, segment);
    result.push(current);
  }
  return result;
}

async function openPinnedPath(nativeApi, exactPath, {
  kind,
  access,
  share,
  disposition = "openExisting",
  deleteOnClose = false,
} = {}) {
  const canonical = validateAbsolute(exactPath);
  const paths = cumulativePaths(canonical);
  const owner = { handles: new Set(), closed: false };
  const records = [];
  let primaryError;
  try {
    for (let index = 0; index < paths.length; index += 1) {
      const last = index === paths.length - 1;
      const expectedKind = last ? kind : "directory";
      const requestedAccess = last ? access : ["attributes"];
      const effectiveAccess = expectedKind === "directory"
        ? [...new Set([...requestedAccess, "traverse"])]
        : requestedAccess;
      const handle = await nativeApi.openPath(paths[index], {
        access: effectiveAccess,
        share: last ? share : ["read", "write"],
        disposition: last ? disposition : "openExisting",
        directory: expectedKind !== "file",
        deleteOnClose: last && deleteOnClose,
      });
      owner.handles.add(handle);
      const info = validateInfo(await nativeApi.queryHandle(handle), expectedKind);
      if (expectedKind === "file") await nativeApi.assertNoAlternateDataStreams(handle);
      const finalPath = validateAbsolute(await nativeApi.finalPath(handle), { allowRoot: index === 0 });
      if (!samePath(finalPath, paths[index])) throw capabilityError("windows_final_path_mismatch");
      records.push({ handle, info, path: finalPath });
    }
    return { owner, records, leaf: records.at(-1), path: canonical };
  } catch (error) {
    primaryError = error;
  }
  return closeHandles(nativeApi, owner.handles, primaryError);
}

function requireOpen(owner) {
  if (owner.closed) throw capabilityError("windows_capability_closed");
}

async function closeOwner(nativeApi, owner) {
  if (owner.closed) return;
  owner.closed = true;
  await closeHandles(nativeApi, owner.handles);
}

function ensureDirectChild(parentPath, name) {
  const child = path.win32.join(parentPath, validateChildName(name));
  if (!samePath(path.win32.dirname(child), parentPath)) throw capabilityError("windows_child_name_rejected");
  return child;
}

function hasExactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function digestJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function compareEntryPath(left, right) {
  const leftKey = left.path.toLowerCase();
  const rightKey = right.path.toLowerCase();
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function normalizeRequiredFiles(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ENTRIES) {
    throw capabilityError("version_manifest_invalid");
  }
  const entries = new Map();
  function add(entry) {
    const key = entry.path.toLowerCase();
    const existing = entries.get(key);
    if (existing && (existing.path !== entry.path || existing.directory !== entry.directory
      || existing.size !== entry.size)) {
      throw capabilityError("version_manifest_invalid");
    }
    entries.set(key, entry);
  }
  for (const item of value) {
    if (!hasExactKeys(item, ["path", "size", "directory"])
      || typeof item.path !== "string" || item.path.length === 0 || item.path.includes("\\")
      || typeof item.directory !== "boolean" || !Number.isSafeInteger(item.size) || item.size < 0
      || (item.directory && item.size !== 0)) {
      throw capabilityError("version_manifest_invalid");
    }
    const segments = validateRelativeSegments(item.path.split("/"));
    if (segments.join("/") !== item.path) throw capabilityError("version_manifest_invalid");
    for (let index = 1; index < segments.length; index += 1) {
      add({ path: segments.slice(0, index).join("/"), size: 0, directory: true });
    }
    add({ path: item.path, size: item.size, directory: item.directory });
  }
  return [...entries.values()].sort(compareEntryPath);
}

function normalizeVerificationRequest(value) {
  if (!hasExactKeys(value, ["componentId", "version", "requiredFiles"])
    || !COMPONENT_IDS.has(value.componentId) || !VERSION.test(value.version ?? "")) {
    throw capabilityError("version_verification_request_invalid");
  }
  const requiredFiles = normalizeRequiredFiles(value.requiredFiles);
  return {
    componentId: value.componentId,
    version: value.version,
    requiredFiles,
    manifestDigest: digestJson(requiredFiles),
  };
}

function normalizeVersionMarker(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== 5
    || value.schemaVersion !== 2
    || !COMPONENT_IDS.has(value.componentId)
    || typeof value.version !== "string" || !VERSION.test(value.version)
    || typeof value.treeDigest !== "string" || !SHA256.test(value.treeDigest)
    || typeof value.manifestDigest !== "string" || !SHA256.test(value.manifestDigest)) {
    throw capabilityError("version_marker_invalid");
  }
  return {
    schemaVersion: 2,
    componentId: value.componentId,
    version: value.version,
    treeDigest: value.treeDigest,
    manifestDigest: value.manifestDigest,
  };
}

function normalizeSealMetadata(value) {
  if (!hasExactKeys(value, ["schemaVersion", "componentId", "version", "treeDigest", "manifestDigest"])
    || value.schemaVersion !== 2 || !COMPONENT_IDS.has(value.componentId)
    || !VERSION.test(value.version ?? "") || !SHA256.test(value.treeDigest ?? "")
    || !SHA256.test(value.manifestDigest ?? "")) {
    throw capabilityError("version_marker_invalid");
  }
  return { ...value };
}

export function createWindowsFileCapabilities({
  platform = process.platform,
  nativeApi,
  randomUUID = crypto.randomUUID,
} = {}) {
  if (platform !== "win32") throw capabilityError("windows_platform_required");
  if (!nativeApi || REQUIRED_NATIVE_METHODS.some((name) => typeof nativeApi[name] !== "function")) {
    throw capabilityError("windows_native_api_required");
  }
  if (typeof randomUUID !== "function") {
    throw capabilityError("windows_file_adapter_required");
  }
  const verificationReceipts = new WeakMap();

  async function openRecordDirectoryNoFollow(stateDir, { includeListing = false } = {}) {
    const pin = await openPinnedPath(nativeApi, stateDir, {
      kind: "directory",
      access: ["attributes"],
      share: ["read", "write"],
    });
    const descriptors = new WeakMap();
    const descriptorSet = new Set();

    async function openFileNoFollow(name, flags) {
      requireOpen(pin.owner);
      if (flags !== "r" && flags !== "wx") throw capabilityError("state_open_flags_rejected");
      const entryPath = ensureDirectChild(pin.path, name);
      let handle;
      try {
        handle = await nativeApi.openPath(entryPath, {
          access: flags === "r" ? ["read", "delete"] : ["read", "write", "delete"],
          share: ["read", "write"],
          disposition: flags === "r" ? "openExisting" : "createNew",
          directory: false,
        });
      } catch (error) {
        if (flags === "r" && isMissing(error)) return null;
        throw error;
      }
      pin.owner.handles.add(handle);
      try {
        const info = validateInfo(await nativeApi.queryHandle(handle), "file");
        if (info.nlink !== 1) throw capabilityError("windows_hard_link_rejected");
        const finalPath = validateAbsolute(await nativeApi.finalPath(handle));
        if (!samePath(finalPath, entryPath)) throw capabilityError("windows_final_path_mismatch");
        const entry = Object.freeze({ name, identity: publicIdentity(info.identity) });
        await nativeApi.assertNoAlternateDataStreams(handle);
        const descriptor = { handle, identity: info.identity, state: "open" };
        descriptors.set(entry, descriptor);
        descriptorSet.add(descriptor);
        let facadeClosed = false;
        return Object.freeze({
          entry,
          async readFile(encoding) {
            if (facadeClosed) throw capabilityError("state_file_closed");
            const data = await nativeApi.readFile(handle, MAX_STATE_BYTES);
            return encoding === undefined ? data : data.toString(encoding);
          },
          async writeFile(value, encoding) {
            if (facadeClosed || flags !== "wx") throw capabilityError("state_file_not_writable");
            const data = Buffer.isBuffer(value) ? value : Buffer.from(value, encoding);
            if (data.length > MAX_STATE_BYTES) throw capabilityError("state_file_too_large");
            await nativeApi.writeFile(handle, data);
          },
          async sync() {
            if (facadeClosed || flags !== "wx") throw capabilityError("state_file_not_writable");
            await nativeApi.flushFile(handle);
          },
          async close() { facadeClosed = true; },
        });
      } catch (error) {
        await closeOne(nativeApi, pin.owner, handle).catch((closeError) => {
          throw new AggregateError([error, closeError], error.message, { cause: error });
        });
        throw error;
      }
    }

    function requireDescriptor(entry) {
      requireOpen(pin.owner);
      const descriptor = descriptors.get(entry);
      if (!descriptor || !descriptorSet.has(descriptor)) throw capabilityError("state_descriptor_invalid");
      if (descriptor.state !== "open") throw capabilityError("state_descriptor_consumed");
      descriptor.state = "busy";
      return descriptor;
    }

    async function mutate(entry, operation, { retryOccupied = false } = {}) {
      const descriptor = requireDescriptor(entry);
      let primaryError = null;
      try {
        const current = validateInfo(await nativeApi.queryHandle(descriptor.handle), "file");
        verifyIdentity(descriptor.identity, current);
        await nativeApi.assertNoAlternateDataStreams(descriptor.handle);
        await operation(descriptor);
        descriptor.state = "consumed";
      } catch (error) {
        if (retryOccupied && isOccupied(error)) {
          descriptor.state = "open";
          throw error;
        }
        descriptor.state = "consumed";
        primaryError = error;
      }
      try {
        await closeOne(nativeApi, pin.owner, descriptor.handle);
      } catch (closeError) {
        if (primaryError) throw new AggregateError([primaryError, closeError], primaryError.message, { cause: primaryError });
        throw closeError;
      }
      if (primaryError) throw primaryError;
    }

    const facade = {
      openFileNoFollow,
      async unlinkEntryNoFollow(entry) {
        await mutate(entry, (descriptor) => nativeApi.deleteByHandle(descriptor.handle, { directory: false }));
      },
      async renameEntryNoFollow(entry, destinationName) {
        const name = validateChildName(destinationName);
        await mutate(entry, (descriptor) => nativeApi.renameByHandle(
          descriptor.handle, pin.leaf.handle, name, { replace: false },
        ), { retryOccupied: true });
      },
      async close() { await closeOwner(nativeApi, pin.owner); },
    };
    if (includeListing) {
      facade.listFileNamesNoFollow = async () => {
        requireOpen(pin.owner);
        const names = [];
        try {
          for await (const entry of nativeApi.enumerateDirectory(pin.leaf.handle, { limit: MAX_ENTRIES })) {
            if (!entry || entry.reparse === true) throw capabilityError("windows_reparse_point_rejected");
            names.push(validateChildName(entry.name));
          }
        } catch (error) {
          if (error?.code === "native_directory_entry_limit_exceeded"
            || error?.code === "windows_directory_limit_exceeded") {
            throw capabilityError("journal_entry_limit_exceeded", error);
          }
          throw error;
        }
        return names;
      };
    }
    return Object.freeze(facade);
  }

  async function openStateDirectoryNoFollow(stateDir) {
    return openRecordDirectoryNoFollow(stateDir);
  }

  async function acquireStateLockNoFollow(stateDir) {
    const lockPath = ensureDirectChild(validateAbsolute(stateDir), STATE_LOCK_NAME);
    const deadline = Date.now() + 30_000;
    for (;;) {
      let pin;
      try {
        try {
          pin = await openPinnedPath(nativeApi, lockPath, {
            kind: "file", access: ["read", "write", "attributes"], share: [], disposition: "createNew",
          });
        } catch (error) {
          if (!isOccupied(error)) throw error;
          pin = await openPinnedPath(nativeApi, lockPath, {
            kind: "file", access: ["read", "write", "attributes"], share: [], disposition: "openExisting",
          });
        }
        if (pin.leaf.info.nlink !== 1) throw capabilityError("windows_hard_link_rejected");
        let released = false;
        return Object.freeze({
          async release() {
            if (released) throw capabilityError("state_lock_already_released");
            released = true;
            await closeOwner(nativeApi, pin.owner);
          },
        });
      } catch (error) {
        if (pin) await closeOwner(nativeApi, pin.owner).catch(() => {});
        if (!isSharingViolation(error)) throw error;
        if (Date.now() >= deadline) throw capabilityError("state_lock_timeout", error);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  async function acquireOperationLeaseNoFollow(stateDir, { nonce, scope, wait = true } = {}) {
    if (!OPERATION_LEASE_NONCE.test(nonce ?? "") || !OPERATION_LEASE_SCOPES.has(scope)
      || typeof wait !== "boolean") throw capabilityError("operation_lease_request_invalid");
    const leaseName = `.codexbridge-operation-${scope}-${nonce}.lock`;
    const leasePath = ensureDirectChild(validateAbsolute(stateDir), leaseName);
    const deadline = Date.now() + 30_000;
    for (;;) {
      let pin;
      try {
        try {
          pin = await openPinnedPath(nativeApi, leasePath, {
            kind: "file", access: ["read", "write", "delete", "attributes"], share: [], disposition: "createNew",
            deleteOnClose: true,
          });
        } catch (error) {
          if (!isOccupied(error)) throw error;
          pin = await openPinnedPath(nativeApi, leasePath, {
            kind: "file", access: ["read", "write", "delete", "attributes"], share: [], disposition: "openExisting",
            deleteOnClose: true,
          });
        }
        if (pin.leaf.info.nlink !== 1) throw capabilityError("windows_hard_link_rejected");
        let released = false;
        return Object.freeze({
          nonce, scope,
          async release() {
            if (released) throw capabilityError("operation_lease_already_released");
            released = true;
            pin.owner.closed = true;
            await closeHandles(nativeApi, pin.owner.handles);
          },
        });
      } catch (error) {
        if (pin) await closeOwner(nativeApi, pin.owner).catch(() => {});
        if (!isSharingViolation(error)) throw error;
        if (!wait) return null;
        if (Date.now() >= deadline) throw capabilityError("operation_lease_timeout", error);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  async function openJournalDirectoryNoFollow(journalDir) {
    return openRecordDirectoryNoFollow(journalDir, { includeListing: true });
  }

  async function openInstallerWorkspaceRootNoFollow(installRootCapability, { maxRelativePath } = {}) {
    if (!Number.isSafeInteger(maxRelativePath) || maxRelativePath < 0) {
      throw capabilityError("workspace_root_options_invalid");
    }
    const rootPath = await revalidateInstallRootCapability(installRootCapability, { maxRelativePath });
    const pin = await openPinnedPath(nativeApi, rootPath, {
      kind: "directory",
      access: ["read", "attributes"],
      share: ["read", "write"],
    });
    if (pin.leaf.info.nlink !== 1) {
      return closeHandles(nativeApi, pin.owner.handles, capabilityError("windows_hard_link_rejected"));
    }
    try {
      const confirmed = await revalidateInstallRootCapability(installRootCapability, { maxRelativePath });
      if (!samePath(confirmed, rootPath)) throw capabilityError("install_root_identity_changed");
    } catch (error) {
      return closeHandles(nativeApi, pin.owner.handles, error);
    }
    const receiptMap = new WeakMap();
    const session = Object.freeze(Object.create(null));

    function issue({ path: exactPath, info, handle, kind, parent = null }) {
      const receipt = Object.freeze(Object.create(null));
      receiptMap.set(receipt, {
        session,
        path: exactPath,
        identity: info.identity,
        handle,
        kind,
        parent,
        state: "issued",
      });
      return receipt;
    }

    const root = issue({
      path: pin.path,
      info: pin.leaf.info,
      handle: pin.leaf.handle,
      kind: "directory",
    });

    function requireReceipt(receipt, { directory = false, claim = false } = {}) {
      requireOpen(pin.owner);
      const internal = receiptMap.get(receipt);
      if (!internal || internal.session !== session) throw capabilityError("workspace_receipt_invalid");
      if (internal.state !== "issued") throw capabilityError("workspace_receipt_consumed");
      if (directory && internal.kind !== "directory") throw capabilityError("workspace_directory_receipt_required");
      if (claim) internal.state = "busy";
      return internal;
    }

    async function assertStable(internal, expectedKind = internal.kind) {
      const current = validateInfo(await nativeApi.queryHandle(internal.handle), expectedKind);
      verifyIdentity(internal.identity, current);
      if (current.nlink !== 1) throw capabilityError("windows_hard_link_rejected");
      if (expectedKind === "file") await nativeApi.assertNoAlternateDataStreams(internal.handle);
      const finalPath = validateAbsolute(await nativeApi.finalPath(internal.handle));
      if (!samePath(finalPath, internal.path)) throw capabilityError("windows_final_path_mismatch");
      return current;
    }

    async function listAtMostOne(internal) {
      try {
        for await (const entry of nativeApi.enumerateDirectory(internal.handle, { limit: 1 })) {
          if (!entry || entry.reparse === true) throw capabilityError("windows_reparse_point_rejected");
          validateChildName(entry.name);
          return false;
        }
        return true;
      } catch (error) {
        if (error?.code === "native_directory_entry_limit_exceeded"
          || error?.code === "windows_directory_limit_exceeded") return false;
        throw error;
      }
    }

    async function openDirectChild(parent, name, { kind, disposition }) {
      const parentInternal = requireReceipt(parent, { directory: true });
      const exactName = validateChildName(name);
      await assertStable(parentInternal, "directory");
      const childPath = ensureDirectChild(parentInternal.path, exactName);
      const handle = await nativeApi.openPath(childPath, {
        access: kind === "file"
          ? ["read", "write", "attributes", "delete"]
          : ["read", "attributes", "delete"],
        share: ["read", "write", "delete"],
        disposition,
        directory: kind === "directory",
      });
      pin.owner.handles.add(handle);
      try {
        const info = validateInfo(await nativeApi.queryHandle(handle), kind);
        if (info.nlink !== 1) throw capabilityError("windows_hard_link_rejected");
        if (kind === "file") await nativeApi.assertNoAlternateDataStreams(handle);
        const finalPath = validateAbsolute(await nativeApi.finalPath(handle));
        if (!samePath(finalPath, childPath)) throw capabilityError("windows_final_path_mismatch");
        await assertStable(parentInternal, "directory");
        return issue({ path: finalPath, info, handle, kind, parent });
      } catch (error) {
        await closeOne(nativeApi, pin.owner, handle).catch((closeError) => {
          throw new AggregateError([error, closeError], error.message, { cause: error });
        });
        throw error;
      }
    }

    async function createOrOpenDirectoryChildNoFollow(parent, name, options = {}) {
      const hasRequireEmpty = options !== null && typeof options === "object"
        && Object.hasOwn(options, "requireEmpty");
      if (!hasExactKeys(options, hasRequireEmpty ? ["requireEmpty"] : [])
        || (hasRequireEmpty && typeof options.requireEmpty !== "boolean")) {
        throw capabilityError("workspace_directory_options_invalid");
      }
      const requireEmpty = options.requireEmpty ?? false;
      const parentInternal = requireReceipt(parent, { directory: true });
      const exactName = validateChildName(name);
      await assertStable(parentInternal, "directory");
      const childPath = ensureDirectChild(parentInternal.path, exactName);
      try {
        await nativeApi.createDirectory(childPath);
      } catch (error) {
        if (!isOccupied(error)) throw error;
      }
      const receipt = await openDirectChild(parent, exactName, {
        kind: "directory",
        disposition: "openExisting",
      });
      if (requireEmpty) {
        const internal = requireReceipt(receipt, { directory: true });
        let empty;
        try {
          empty = await listAtMostOne(internal);
        } catch (error) {
          internal.state = "consumed";
          await closeOne(nativeApi, pin.owner, internal.handle).catch((closeError) => {
            throw new AggregateError([error, closeError], error.message, { cause: error });
          });
          throw error;
        }
        if (!empty) {
          internal.state = "consumed";
          await closeOne(nativeApi, pin.owner, internal.handle);
          throw capabilityError("workspace_directory_not_empty");
        }
      }
      return receipt;
    }

    async function createFileChildNoFollow(parent, name) {
      return openDirectChild(parent, name, { kind: "file", disposition: "createNew" });
    }

    async function openFileChildNoFollow(parent, name) {
      try {
        return await openDirectChild(parent, name, { kind: "file", disposition: "openExisting" });
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    }

    async function inspectIssuedChildNoFollow(receipt) {
      const internal = requireReceipt(receipt);
      const info = await assertStable(internal);
      const empty = internal.kind === "directory" ? await listAtMostOne(internal) : info.size === 0;
      return Object.freeze({ path: internal.path, kind: internal.kind, size: info.size, empty });
    }

    async function renameIssuedChildNoReplace(receipt, destinationName) {
      const internal = requireReceipt(receipt, { claim: true });
      if (internal.kind !== "file" || !internal.parent) {
        internal.state = "issued";
        throw capabilityError("workspace_file_receipt_required");
      }
      let destination;
      try {
        const parentInternal = requireReceipt(internal.parent, { directory: true });
        const name = validateChildName(destinationName);
        destination = ensureDirectChild(parentInternal.path, name);
        await assertStable(parentInternal, "directory");
        await assertStable(internal, "file");
        await nativeApi.renameByHandle(internal.handle, parentInternal.handle, name, { replace: false });
        internal.path = destination;
        await assertStable(internal, "file");
        const current = validateInfo(await nativeApi.queryHandle(internal.handle), "file");
        internal.state = "consumed";
        return issue({
          path: destination,
          info: current,
          handle: internal.handle,
          kind: "file",
          parent: internal.parent,
        });
      } catch (error) {
        if (isOccupied(error)) internal.state = "issued";
        else internal.state = "consumed";
        throw error;
      }
    }

    async function deleteIssuedChildNoFollow(receipt) {
      const internal = requireReceipt(receipt, { claim: true });
      if (!internal.parent) {
        internal.state = "issued";
        throw capabilityError("workspace_root_mutation_rejected");
      }
      let primaryError = null;
      try {
        await assertStable(internal);
        if (internal.kind === "directory" && !(await listAtMostOne(internal))) {
          internal.state = "issued";
          throw capabilityError("workspace_directory_not_empty");
        }
        await nativeApi.deleteByHandle(internal.handle, { directory: internal.kind === "directory" });
        internal.state = "consumed";
      } catch (error) {
        if (internal.state === "busy") internal.state = "consumed";
        primaryError = error;
      }
      if (internal.state === "consumed") {
        try {
          await closeOne(nativeApi, pin.owner, internal.handle);
        } catch (closeError) {
          if (primaryError) throw new AggregateError([primaryError, closeError], primaryError.message, { cause: primaryError });
          throw closeError;
        }
      }
      if (primaryError) throw primaryError;
      return true;
    }

    return Object.freeze({
      root,
      createOrOpenDirectoryChildNoFollow,
      createFileChildNoFollow,
      openFileChildNoFollow,
      inspectIssuedChildNoFollow,
      renameIssuedChildNoReplace,
      deleteIssuedChildNoFollow,
      async close() { await closeOwner(nativeApi, pin.owner); },
    });
  }

  async function openStableDirectoryNoFollow(rootPath, { versionSlots = false } = {}) {
    const pin = await openPinnedPath(nativeApi, rootPath, {
      kind: "directory",
      access: ["read", "attributes"],
      share: ["read", "write"],
    });
    pin.owner.enumerated = 0;
    const descriptorMap = new WeakMap();

    function makeDirectoryFacade(record) {
      let facadeClosed = false;
      const token = {};
      function requireFacade() {
        requireOpen(pin.owner);
        if (facadeClosed) throw capabilityError("delete_directory_closed");
      }
      return Object.freeze({
        async assertChildDescriptorNoFollow(descriptor) {
          requireFacade();
          const internal = descriptorMap.get(descriptor);
          if (!internal || internal.token !== token || internal.state !== "open") {
            throw capabilityError("delete_descriptor_invalid");
          }
          return true;
        },
        async listChildren() {
          requireFacade();
          const names = [];
          try {
            for await (const entry of nativeApi.enumerateDirectory(record.handle, {
              limit: MAX_ENTRIES - pin.owner.enumerated,
            })) {
              pin.owner.enumerated += 1;
              if (pin.owner.enumerated > MAX_ENTRIES) throw capabilityError("delete_entry_count_exceeded");
              if (!entry || entry.reparse === true) throw capabilityError("windows_reparse_point_rejected");
              names.push(validateChildName(entry.name));
            }
          } catch (error) {
            if (error?.code === "native_directory_entry_limit_exceeded"
              || error?.code === "windows_directory_limit_exceeded") {
              throw capabilityError("delete_entry_limit_exceeded", error);
            }
            throw error;
          }
          return names;
        },
        async openChildNoFollow(name) {
          requireFacade();
          const childPath = ensureDirectChild(record.path, name);
          const handle = await nativeApi.openPath(childPath, {
            access: ["read", "attributes", "delete"],
            share: ["read", "write"],
            disposition: "openExisting",
            directory: true,
          });
          pin.owner.handles.add(handle);
          try {
            const info = validateInfo(await nativeApi.queryHandle(handle));
            if (info.nlink !== 1) throw capabilityError("windows_hard_link_rejected");
            const finalPath = validateAbsolute(await nativeApi.finalPath(handle));
            if (!samePath(finalPath, childPath)) throw capabilityError("windows_final_path_mismatch");
            const kind = info.directory ? "directory" : "file";
            const descriptor = Object.freeze({
              name,
              kind,
              identity: publicIdentity(info.identity),
              ...(kind === "directory" ? { handle: makeDirectoryFacade({ handle, path: finalPath, info }) } : {}),
            });
            if (!info.directory) await nativeApi.assertNoAlternateDataStreams(handle);
            descriptorMap.set(descriptor, {
              handle, identity: info.identity, directory: info.directory, token, state: "open", path: finalPath,
            });
            return descriptor;
          } catch (error) {
            await closeOne(nativeApi, pin.owner, handle).catch((closeError) => {
              throw new AggregateError([error, closeError], error.message, { cause: error });
            });
            throw error;
          }
        },
        async unlinkChildNoFollow(descriptor) {
          requireFacade();
          await mutateDeleteDescriptor(descriptor, false, token);
        },
        async rmdirChildNoFollow(descriptor) {
          requireFacade();
          await mutateDeleteDescriptor(descriptor, true, token);
        },
        async close() { facadeClosed = true; },
      });
    }

    async function mutateDeleteDescriptor(descriptor, directory, token) {
      const internal = descriptorMap.get(descriptor);
      if (!internal || internal.token !== token || internal.directory !== directory) {
        throw capabilityError("delete_descriptor_invalid");
      }
      if (internal.state !== "open") throw capabilityError("delete_descriptor_consumed");
      internal.state = "busy";
      let primaryError = null;
      try {
        const current = validateInfo(await nativeApi.queryHandle(internal.handle), directory ? "directory" : "file");
        verifyIdentity(internal.identity, current);
        if (!directory) await nativeApi.assertNoAlternateDataStreams(internal.handle);
        await nativeApi.deleteByHandle(internal.handle, { directory });
      } catch (error) {
        primaryError = error;
      }
      internal.state = "consumed";
      try {
        await closeOne(nativeApi, pin.owner, internal.handle);
      } catch (closeError) {
        if (primaryError) throw new AggregateError([primaryError, closeError], primaryError.message, { cause: primaryError });
        throw closeError;
      }
      if (primaryError) throw primaryError;
    }

    async function computeVersionTree(slotInternal) {
      requireOpen(pin.owner);
      const rootInfo = validateInfo(await nativeApi.queryHandle(slotInternal.handle), "directory");
      verifyIdentity(slotInternal.identity, rootInfo);
      const entries = [];
      let entryCount = 0;
      let totalBytes = 0;

      async function namesFor(record) {
        const names = [];
        try {
          for await (const entry of nativeApi.enumerateDirectory(record.handle, {
            limit: MAX_ENTRIES - entryCount,
          })) {
            if (!entry || entry.reparse === true) throw capabilityError("windows_reparse_point_rejected");
            names.push(validateChildName(entry.name));
          }
        } catch (error) {
          if (error?.code === "native_directory_entry_limit_exceeded"
            || error?.code === "windows_directory_limit_exceeded") {
            throw capabilityError("version_tree_entry_count_exceeded", error);
          }
          throw error;
        }
        return names.sort((left, right) => left.localeCompare(right, "en"));
      }

      async function walk(record, relativeSegments, depth) {
        if (depth > MAX_DEPTH) throw capabilityError("version_tree_depth_exceeded");
        for (const name of await namesFor(record)) {
          if (depth === 0 && name === VERSION_MARKER_NAME) continue;
          entryCount += 1;
          if (entryCount > MAX_ENTRIES) throw capabilityError("version_tree_entry_count_exceeded");
          const childPath = ensureDirectChild(record.path, name);
          const handle = await nativeApi.openPath(childPath, {
            access: ["read", "attributes"],
            share: ["read"],
            disposition: "openExisting",
            directory: true,
          });
          pin.owner.handles.add(handle);
          let primaryError = null;
          try {
            const info = validateInfo(await nativeApi.queryHandle(handle));
            if (info.nlink !== 1) throw capabilityError("windows_hard_link_rejected");
            const finalPath = validateAbsolute(await nativeApi.finalPath(handle));
            if (!samePath(finalPath, childPath)) throw capabilityError("windows_final_path_mismatch");
            const itemSegments = [...relativeSegments, name];
            const relative = itemSegments.join("/");
            if (info.directory) {
              entries.push({ path: relative, size: 0, directory: true });
              await walk({ handle, path: finalPath }, itemSegments, depth + 1);
            } else {
              await nativeApi.assertNoAlternateDataStreams(handle);
              totalBytes += info.size;
              if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_ARCHIVE_BYTES) {
                throw capabilityError("version_tree_size_exceeded");
              }
              const content = await nativeApi.readFile(handle, MAX_ARCHIVE_BYTES);
              if (!Buffer.isBuffer(content) || content.length !== info.size) {
                throw capabilityError("version_tree_read_invalid");
              }
              entries.push({
                path: relative,
                size: info.size,
                directory: false,
                sha256: crypto.createHash("sha256").update(content).digest("hex"),
              });
            }
          } catch (error) {
            primaryError = error;
          }
          try {
            await closeOne(nativeApi, pin.owner, handle);
          } catch (closeError) {
            if (primaryError) {
              throw new AggregateError([primaryError, closeError], primaryError.message, { cause: primaryError });
            }
            throw closeError;
          }
          if (primaryError) throw primaryError;
        }
      }

      await walk({ handle: slotInternal.handle, path: slotInternal.path }, [], 0);
      entries.sort(compareEntryPath);
      const manifest = entries.map(({ path: entryPath, size, directory }) => ({
        path: entryPath, size, directory,
      }));
      return {
        entries,
        treeDigest: digestJson(entries),
        manifestDigest: digestJson(manifest),
      };
    }

    const rootFacade = makeDirectoryFacade(pin.leaf);
    if (!versionSlots) {
      return Object.freeze({ ...rootFacade, async close() { await closeOwner(nativeApi, pin.owner); } });
    }

    function requireSlotDescriptor(descriptor, { claim = false } = {}) {
      requireOpen(pin.owner);
      const internal = descriptorMap.get(descriptor);
      if (!internal || internal.token === undefined || !internal.directory) {
        throw capabilityError("version_slot_descriptor_invalid");
      }
      if (internal.state !== "open") throw capabilityError("version_slot_descriptor_consumed");
      if (claim) internal.state = "busy";
      return internal;
    }

    async function openMarker(internal, flags) {
      const markerPath = ensureDirectChild(internal.path, VERSION_MARKER_NAME);
      let handle;
      try {
        handle = await nativeApi.openPath(markerPath, {
          access: flags === "r" ? ["read", "attributes"] : ["read", "write", "attributes", "delete"],
          share: ["read", "write"],
          disposition: flags === "r" ? "openExisting" : "createNew",
          directory: false,
        });
      } catch (error) {
        if (flags === "r" && isMissing(error)) return null;
        throw error;
      }
      pin.owner.handles.add(handle);
      try {
        const info = validateInfo(await nativeApi.queryHandle(handle), "file");
        if (info.nlink !== 1) throw capabilityError("windows_hard_link_rejected");
        await nativeApi.assertNoAlternateDataStreams(handle);
        const finalPath = validateAbsolute(await nativeApi.finalPath(handle));
        if (!samePath(finalPath, markerPath)) throw capabilityError("windows_final_path_mismatch");
        return { handle, info, path: markerPath };
      } catch (error) {
        await closeOne(nativeApi, pin.owner, handle).catch((closeError) => {
          throw new AggregateError([error, closeError], error.message, { cause: error });
        });
        throw error;
      }
    }

    async function readMarker(internal) {
      const marker = await openMarker(internal, "r");
      if (!marker) return { evidence: null, markerStatus: "missing" };
      let primaryError = null;
      let result;
      try {
        const data = await nativeApi.readFile(marker.handle, MAX_STATE_BYTES);
        const metadata = normalizeVersionMarker(JSON.parse(data.toString("utf8")));
        const tree = await computeVersionTree(internal);
        if (tree.treeDigest !== metadata.treeDigest || tree.manifestDigest !== metadata.manifestDigest) {
          throw capabilityError("version_tree_digest_mismatch");
        }
        result = {
          evidence: { ...metadata, identity: publicIdentity(internal.identity) },
          markerStatus: "complete",
        };
      } catch (error) {
        if (["version_marker_invalid", "version_tree_digest_mismatch"].includes(error?.code)
          || error instanceof SyntaxError) {
          result = { evidence: null, markerStatus: "invalid" };
        } else {
          primaryError = error;
        }
      } finally {
        try {
          await closeOne(nativeApi, pin.owner, marker.handle);
        } catch (closeError) {
          if (primaryError) throw new AggregateError([primaryError, closeError], primaryError.message, { cause: primaryError });
          throw closeError;
        }
      }
      if (primaryError) throw primaryError;
      return result;
    }

    async function openSlotNoFollow(name) {
      let descriptor;
      try {
        descriptor = await rootFacade.openChildNoFollow(name);
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
      if (descriptor.kind !== "directory") throw capabilityError("version_slot_directory_required");
      const internal = requireSlotDescriptor(descriptor);
      const marker = await readMarker(internal);
      return Object.freeze({ descriptor, ...marker });
    }

    async function sealPreparedSlotNoFollow(descriptor, value, verificationReceipt) {
      const metadata = normalizeSealMetadata(value);
      const internal = requireSlotDescriptor(descriptor);
      const receipt = verificationReceipts.get(verificationReceipt);
      if (!receipt) throw capabilityError("version_verification_receipt_invalid");
      if (receipt.state !== "fresh") throw capabilityError("version_verification_receipt_consumed");
      const priorReceiptState = receipt.state;
      if (identityKey(receipt.directoryIdentity) !== identityKey(internal.identity)) {
        throw capabilityError("version_verification_receipt_directory_mismatch");
      }
      if (receipt.componentId !== metadata.componentId || receipt.version !== metadata.version
        || receipt.treeDigest !== metadata.treeDigest
        || receipt.manifestDigest !== metadata.manifestDigest) {
        throw capabilityError("version_verification_receipt_mismatch");
      }
      receipt.state = "busy";
      let succeeded = false;
      try {
        const current = validateInfo(await nativeApi.queryHandle(internal.handle), "directory");
        verifyIdentity(internal.identity, current);
        const tree = await computeVersionTree(internal);
        if (tree.treeDigest !== receipt.treeDigest || tree.manifestDigest !== receipt.manifestDigest) {
          throw capabilityError("version_tree_digest_mismatch");
        }
        const markerMetadata = normalizeVersionMarker({
          ...metadata,
        });
        const existing = await readMarker(internal);
        if (existing.markerStatus === "invalid") throw capabilityError("version_marker_conflict");
        if (existing.evidence) {
          if (existing.evidence.componentId !== markerMetadata.componentId
            || existing.evidence.version !== markerMetadata.version
            || existing.evidence.treeDigest !== markerMetadata.treeDigest
            || existing.evidence.manifestDigest !== markerMetadata.manifestDigest) {
            throw capabilityError("version_marker_conflict");
          }
          succeeded = true;
          receipt.state = "consumed";
          return existing.evidence;
        }
        const marker = await openMarker(internal, "wx");
        let primaryError = null;
        try {
          await nativeApi.writeFile(marker.handle, Buffer.from(`${JSON.stringify(markerMetadata)}\n`, "utf8"));
          await nativeApi.flushFile(marker.handle);
        } catch (error) {
          primaryError = error;
        } finally {
          try {
            await closeOne(nativeApi, pin.owner, marker.handle);
          } catch (closeError) {
            if (primaryError) {
              throw new AggregateError([primaryError, closeError], primaryError.message, { cause: primaryError });
            }
            throw closeError;
          }
        }
        if (primaryError) throw primaryError;
        succeeded = true;
        receipt.state = "consumed";
        return { ...markerMetadata, identity: publicIdentity(internal.identity) };
      } finally {
        if (!succeeded && receipt.state === "busy") receipt.state = priorReceiptState;
      }
    }

    async function renameSlotNoReplace(descriptor, destinationName) {
      const internal = requireSlotDescriptor(descriptor, { claim: true });
      let primaryError = null;
      try {
        const current = validateInfo(await nativeApi.queryHandle(internal.handle), "directory");
        verifyIdentity(internal.identity, current);
        await nativeApi.renameByHandle(
          internal.handle, pin.leaf.handle, validateChildName(destinationName), { replace: false },
        );
      } catch (error) {
        primaryError = error;
      }
      internal.state = "consumed";
      try {
        await closeOne(nativeApi, pin.owner, internal.handle);
      } catch (closeError) {
        if (primaryError) throw new AggregateError([primaryError, closeError], primaryError.message, { cause: primaryError });
        throw closeError;
      }
      if (primaryError) throw primaryError;
    }

    return Object.freeze({
      ...rootFacade,
      openSlotNoFollow,
      sealPreparedSlotNoFollow,
      renameSlotNoReplace,
      async close() { await closeOwner(nativeApi, pin.owner); },
    });
  }

  async function openDirectoryNoFollow(rootPath) {
    return openStableDirectoryNoFollow(rootPath);
  }

  async function openVersionRootNoFollow(rootPath) {
    return openStableDirectoryNoFollow(rootPath, { versionSlots: true });
  }

  async function pinArchiveFileNoFollow(archivePath) {
    const pin = await openPinnedPath(nativeApi, archivePath, {
      kind: "file",
      access: ["read", "attributes"],
      share: ["read"],
    });
    if (pin.leaf.info.nlink !== 1) {
      return closeHandles(nativeApi, pin.owner.handles, capabilityError("windows_hard_link_rejected"));
    }
    return Object.freeze({
      async assertStableNoFollow() {
        requireOpen(pin.owner);
        const current = validateInfo(await nativeApi.queryHandle(pin.leaf.handle), "file");
        verifyIdentity(pin.leaf.info.identity, current);
        const finalPath = validateAbsolute(await nativeApi.finalPath(pin.leaf.handle));
        if (!samePath(finalPath, pin.path)) throw capabilityError("windows_final_path_mismatch");
      },
      async close() { await closeOwner(nativeApi, pin.owner); },
    });
  }

  async function openArchiveDestinationNoFollow(destinationPath) {
    const pin = await openPinnedPath(nativeApi, destinationPath, {
      kind: "directory",
      access: ["read", "attributes"],
      share: ["read"],
    });
    const tracked = new Map([["", { ...pin.leaf, relative: "", directory: true, expectedSize: 0 }]]);
    const directories = new Map([["", tracked.get("")]]);

    async function enumerate(record, limit) {
      const entries = [];
      try {
        for await (const entry of nativeApi.enumerateDirectory(record.handle, { limit })) {
          if (!entry || entry.reparse === true) throw capabilityError("windows_reparse_point_rejected");
          entries.push(validateChildName(entry.name));
        }
      } catch (error) {
        if (error?.code === "native_directory_entry_limit_exceeded"
          || error?.code === "windows_directory_limit_exceeded") {
          throw capabilityError("archive_entry_count_exceeded", error);
        }
        throw error;
      }
      return entries.sort((left, right) => left.localeCompare(right, "en"));
    }

    async function assertEmptyNoFollow() {
      requireOpen(pin.owner);
      if ((await enumerate(pin.leaf, 1)).length !== 0) throw capabilityError("archive_destination_not_empty");
    }

    async function ensureDirectoryPathNoFollow(rawSegments) {
      requireOpen(pin.owner);
      const segments = validateRelativeSegments(rawSegments);
      let record = pin.leaf;
      for (let index = 0; index < segments.length; index += 1) {
        const relative = segments.slice(0, index + 1).join("/");
        if (directories.has(relative)) {
          record = directories.get(relative);
          continue;
        }
        const childPath = ensureDirectChild(record.path, segments[index]);
        await nativeApi.createDirectory(childPath);
        const handle = await nativeApi.openPath(childPath, {
          access: ["read", "attributes"], share: ["read"], disposition: "openExisting", directory: true,
        });
        pin.owner.handles.add(handle);
        try {
          const info = validateInfo(await nativeApi.queryHandle(handle), "directory");
          if (info.nlink !== 1) throw capabilityError("windows_hard_link_rejected");
          const finalPath = validateAbsolute(await nativeApi.finalPath(handle));
          if (!samePath(finalPath, childPath)) throw capabilityError("windows_final_path_mismatch");
          record = { handle, info, path: finalPath, relative, directory: true, expectedSize: 0 };
          directories.set(relative, record);
          tracked.set(relative, record);
        } catch (error) {
          await closeOne(nativeApi, pin.owner, handle).catch((closeError) => {
            throw new AggregateError([error, closeError], error.message, { cause: error });
          });
          throw error;
        }
      }
      return record;
    }

    async function createFilePathNoFollow(rawSegments, { exclusive, size } = {}) {
      requireOpen(pin.owner);
      const segments = validateRelativeSegments(rawSegments);
      if (exclusive !== true || !Number.isSafeInteger(size) || size < 0 || size > MAX_ARCHIVE_BYTES) {
        throw capabilityError("archive_output_options_invalid");
      }
      const parent = segments.length === 1 ? pin.leaf : await ensureDirectoryPathNoFollow(segments.slice(0, -1));
      const outputPath = ensureDirectChild(parent.path, segments.at(-1));
      const handle = await nativeApi.openPath(outputPath, {
        access: ["read", "write"], share: ["read"], disposition: "createNew", directory: false,
      });
      pin.owner.handles.add(handle);
      try {
        const info = validateInfo(await nativeApi.queryHandle(handle), "file");
        if (info.nlink !== 1) throw capabilityError("windows_hard_link_rejected");
        await nativeApi.assertNoAlternateDataStreams(handle);
        const finalPath = validateAbsolute(await nativeApi.finalPath(handle));
        if (!samePath(finalPath, outputPath)) throw capabilityError("windows_final_path_mismatch");
        const relative = segments.join("/");
        const trackedRecord = {
          handle, info, path: finalPath, relative, directory: false, expectedSize: size,
          contentHasher: crypto.createHash("sha256"), contentDigest: null,
        };
        tracked.set(relative, trackedRecord);
      } catch (error) {
        await closeOne(nativeApi, pin.owner, handle).catch((closeError) => {
          throw new AggregateError([error, closeError], error.message, { cause: error });
        });
        throw error;
      }
      let written = 0;
      let settled = false;
      const trackedRecord = tracked.get(segments.join("/"));
      return new Writable({
        write(chunk, _encoding, callback) {
          const data = Buffer.from(chunk);
          written += data.length;
          if (written > size || written > MAX_ARCHIVE_BYTES) {
            callback(capabilityError("archive_output_size_exceeded"));
            return;
          }
          trackedRecord.contentHasher.update(data);
          Promise.resolve(nativeApi.appendFile(handle, data)).then(() => callback(), callback);
        },
        final(callback) {
          if (written !== size) {
            callback(capabilityError("archive_output_size_mismatch"));
            return;
          }
          Promise.resolve(nativeApi.flushFile(handle))
            .then(() => {
              trackedRecord.contentDigest = trackedRecord.contentHasher.digest("hex");
              trackedRecord.contentHasher = null;
              settled = true;
              callback();
            }, callback);
        },
        destroy(error, callback) {
          if (settled || !error) {
            callback(error);
            return;
          }
          tracked.delete(segments.join("/"));
          closeOne(nativeApi, pin.owner, handle).then(() => callback(error), (closeError) => {
            callback(error ? new AggregateError([error, closeError], error.message, { cause: error }) : closeError);
          });
        },
      });
    }

    async function verifyTreeNoFollow(signal, rawVerification) {
      requireOpen(pin.owner);
      throwIfAborted(signal);
      const verification = rawVerification === undefined
        ? null
        : normalizeVerificationRequest(rawVerification);
      const result = [];
      const digestEntries = [];
      let entryCount = 0;
      let totalBytes = 0;
      for (const [relative, record] of tracked) {
        if (relative === "") continue;
        throwIfAborted(signal);
        const info = validateInfo(await nativeApi.queryHandle(record.handle), record.directory ? "directory" : "file");
        verifyIdentity(record.info.identity, info);
        if (info.nlink !== 1) throw capabilityError("archive_hard_link_rejected");
        if (!record.directory) {
          await nativeApi.assertNoAlternateDataStreams(record.handle);
          if (info.size !== record.expectedSize) throw capabilityError("archive_output_size_mismatch");
        }
        const realPath = validateAbsolute(await nativeApi.finalPath(record.handle));
        if (!samePath(realPath, record.path)) throw capabilityError("archive_output_identity_mismatch");
      }

      async function inspectExtra(record, name) {
        const childPath = ensureDirectChild(record.path, name);
        const handle = await nativeApi.openPath(childPath, {
          access: ["read", "attributes"], share: ["read"], disposition: "openExisting", directory: true,
        });
        const transient = new Set([handle]);
        let primaryError = null;
        try {
          const info = validateInfo(await nativeApi.queryHandle(handle));
          if (info.nlink !== 1) throw capabilityError("archive_hard_link_rejected");
          if (!info.directory) await nativeApi.assertNoAlternateDataStreams(handle);
          const realPath = validateAbsolute(await nativeApi.finalPath(handle));
          if (!samePath(realPath, childPath)) throw capabilityError("archive_output_identity_mismatch");
          throw capabilityError("archive_output_extra_entry");
        } catch (error) {
          primaryError = error;
        }
        return closeHandles(nativeApi, transient, primaryError);
      }

      async function walk(record, relativeSegments, depth) {
        throwIfAborted(signal);
        if (depth > MAX_DEPTH) throw capabilityError("archive_depth_exceeded");
        for (const name of await enumerate(record, MAX_ENTRIES - entryCount)) {
          throwIfAborted(signal);
          entryCount += 1;
          if (entryCount > MAX_ENTRIES) throw capabilityError("archive_entry_count_exceeded");
          const itemSegments = [...relativeSegments, name];
          const relative = itemSegments.join("/");
          const child = tracked.get(relative);
          if (!child) await inspectExtra(record, name);
          const info = validateInfo(await nativeApi.queryHandle(child.handle), child.directory ? "directory" : "file");
          totalBytes += child.directory ? 0 : info.size;
          if (totalBytes > MAX_ARCHIVE_BYTES) throw capabilityError("archive_output_size_exceeded");
          result.push({
            path: relative,
            realPath: child.path,
            directory: child.directory,
            size: child.directory ? 0 : info.size,
            link: false,
            reparse: false,
            hardLink: false,
            nlink: 1,
          });
          if (!child.directory && !SHA256.test(child.contentDigest ?? "")) {
            throw capabilityError("version_tree_content_digest_missing");
          }
          digestEntries.push({
            path: relative,
            size: child.directory ? 0 : info.size,
            directory: child.directory,
            ...(!child.directory ? { sha256: child.contentDigest } : {}),
          });
          if (child.directory) await walk(child, itemSegments, depth + 1);
        }
      }
      await walk(pin.leaf, [], 0);
      throwIfAborted(signal);
      if (verification) {
        digestEntries.sort(compareEntryPath);
        const actualManifest = digestEntries.map(({ path: entryPath, size, directory }) => ({
          path: entryPath, size, directory,
        }));
        const actualManifestDigest = digestJson(actualManifest);
        if (actualManifestDigest !== verification.manifestDigest) {
          throw capabilityError("version_manifest_mismatch");
        }
        const currentRoot = validateInfo(await nativeApi.queryHandle(pin.leaf.handle), "directory");
        verifyIdentity(pin.leaf.info.identity, currentRoot);
        const verificationReceipt = Object.freeze(Object.create(null));
        const treeDigest = digestJson(digestEntries);
        verificationReceipts.set(verificationReceipt, {
          state: "fresh",
          directoryIdentity: publicIdentity(pin.leaf.info.identity),
          componentId: verification.componentId,
          version: verification.version,
          manifestDigest: verification.manifestDigest,
          treeDigest,
        });
        return Object.freeze({
          tree: result,
          verificationReceipt,
          treeDigest,
          manifestDigest: verification.manifestDigest,
        });
      }
      return result;
    }

    try {
      await assertEmptyNoFollow();
    } catch (error) {
      return closeHandles(nativeApi, pin.owner.handles, error);
    }
    return Object.freeze({
      assertEmptyNoFollow,
      ensureDirectoryPathNoFollow,
      createFilePathNoFollow,
      verifyTreeNoFollow,
      async close() { await closeOwner(nativeApi, pin.owner); },
    });
  }

  function createShortcutFileApi() {
    const tempMap = new WeakMap();
    const inspectionMap = new WeakMap();

    async function acquireMutationHandle(internal, identityErrorCode = "shortcut_temp_identity_changed") {
      if (internal.mutationHandle) return internal.mutationHandle;
      let handle;
      try {
        handle = await nativeApi.openPath(internal.path, {
          access: ["read", "delete"], share: ["read"], disposition: "openExisting", directory: false,
        });
      } catch (error) {
        if (isMissing(error)) throw capabilityError(identityErrorCode, error);
        throw error;
      }
      internal.pin.owner.handles.add(handle);
      try {
        const info = validateInfo(await nativeApi.queryHandle(handle), "file");
        if (info.nlink !== 1 || identityKey(info.identity) !== identityKey(internal.identity)) {
          throw capabilityError(identityErrorCode);
        }
        await nativeApi.assertNoAlternateDataStreams(handle);
        const finalPath = validateAbsolute(await nativeApi.finalPath(handle));
        if (!samePath(finalPath, internal.path)) throw capabilityError(identityErrorCode);
        internal.mutationHandle = handle;
        return handle;
      } catch (error) {
        await closeOne(nativeApi, internal.pin.owner, handle).catch((closeError) => {
          throw new AggregateError([error, closeError], error.message, { cause: error });
        });
        throw error;
      }
    }

    function claimTemp(temp, allowedStates = ["open"]) {
      const internal = tempMap.get(temp);
      if (!internal || internal.active !== temp || !allowedStates.includes(internal.state)) {
        throw capabilityError("shortcut_temp_capability_invalid");
      }
      requireOpen(internal.pin.owner);
      internal.state = "busy";
      return internal;
    }

    async function closeOwnerWithPrimary(owner, primaryError) {
      try {
        await closeOwner(nativeApi, owner);
      } catch (closeError) {
        if (primaryError) throw new AggregateError([primaryError, closeError], primaryError.message, { cause: primaryError });
        throw closeError;
      }
      if (primaryError) throw primaryError;
    }

    async function settleTempFailure(internal, primaryError, { acquireIfMissing = false } = {}) {
      const errors = [primaryError];
      let deletionConfirmed = false;
      if (!internal.mutationHandle && acquireIfMissing) {
        try {
          await acquireMutationHandle(internal);
        } catch (error) {
          errors.push(error);
        }
      }
      if (internal.mutationHandle) {
        try {
          await nativeApi.deleteByHandle(internal.mutationHandle, { directory: false });
          deletionConfirmed = true;
        } catch (error) {
          errors.push(error);
        }
      }
      internal.state = deletionConfirmed ? "consumed" : "cleanup_unconfirmed";
      if (deletionConfirmed) internal.active = null;
      const failure = errors.length === 1
        ? primaryError
        : new AggregateError(errors, primaryError.message, { cause: primaryError });
      try {
        return await closeOwnerWithPrimary(internal.pin.owner, failure);
      } catch (error) {
        if (!deletionConfirmed) internal.cleanupError = error;
        throw error;
      }
    }

    return Object.freeze({
      async createTemp({ directory, suffix } = {}) {
        const desktopPath = validateAbsolute(directory);
        if (suffix !== ".lnk") throw capabilityError("shortcut_temp_suffix_rejected");
        const uuid = randomUUID();
        if (typeof uuid !== "string" || !/^[0-9a-f-]{36}$/iu.test(uuid)) {
          throw capabilityError("shortcut_temp_random_invalid");
        }
        const pin = await openPinnedPath(nativeApi, desktopPath, {
          kind: "directory", access: ["attributes"], share: ["read", "write"],
        });
        const tempPath = ensureDirectChild(desktopPath, `.codexbridge-shortcut-${uuid}.lnk`);
        let handle;
        try {
          handle = await nativeApi.openPath(tempPath, {
            access: ["attributes"],
            share: ["read", "write", "delete"],
            disposition: "createNew",
            directory: false,
          });
          pin.owner.handles.add(handle);
          const info = validateInfo(await nativeApi.queryHandle(handle), "file");
          if (info.nlink !== 1) throw capabilityError("windows_hard_link_rejected");
          await nativeApi.assertNoAlternateDataStreams(handle);
          const finalPath = validateAbsolute(await nativeApi.finalPath(handle));
          if (!samePath(finalPath, tempPath)) throw capabilityError("windows_final_path_mismatch");
          const temp = Object.freeze({ path: tempPath });
          tempMap.set(temp, {
            pin, path: tempPath, identity: info.identity, initialHandle: handle,
            mutationHandle: null, state: "open", active: temp,
          });
          return temp;
        } catch (error) {
          return closeHandles(nativeApi, pin.owner.handles, error);
        }
      },
      async sealTemp(temp) {
        const internal = claimTemp(temp);
        let sealHandle;
        try {
          sealHandle = await nativeApi.openPath(internal.path, {
            access: ["read", "attributes"],
            share: ["read", "delete"],
            disposition: "openExisting",
            directory: false,
          });
          internal.pin.owner.handles.add(sealHandle);
          const info = validateInfo(await nativeApi.queryHandle(sealHandle), "file");
          if (info.nlink !== 1 || identityKey(info.identity) !== identityKey(internal.identity)) {
            throw capabilityError("shortcut_temp_identity_changed");
          }
          await nativeApi.assertNoAlternateDataStreams(sealHandle);
          const finalPath = validateAbsolute(await nativeApi.finalPath(sealHandle));
          if (!samePath(finalPath, internal.path)) throw capabilityError("shortcut_temp_identity_changed");
          internal.sealHandle = sealHandle;
          await closeOne(nativeApi, internal.pin.owner, internal.initialHandle);
          const sealed = Object.freeze({ path: internal.path });
          internal.active = sealed;
          internal.state = "open";
          tempMap.set(sealed, internal);
          return sealed;
        } catch (error) {
          internal.active = null;
          internal.state = "consumed";
          return closeOwnerWithPrimary(internal.pin.owner, error);
        }
      },
      async commitNoReplace(sealed, candidatePath) {
        const internal = claimTemp(sealed);
        let candidate;
        try {
          candidate = validateAbsolute(candidatePath);
          if (!samePath(path.win32.dirname(candidate), internal.pin.path)) {
            throw capabilityError("shortcut_candidate_directory_mismatch");
          }
          validateChildName(path.win32.basename(candidate));
        } catch (error) {
          return settleTempFailure(internal, error, { acquireIfMissing: true });
        }
        try {
          const mutationHandle = await acquireMutationHandle(internal);
          await nativeApi.renameByHandle(
            mutationHandle, internal.pin.leaf.handle, path.win32.basename(candidate), { replace: false },
          );
        } catch (error) {
          if (isOccupied(error)) {
            internal.state = "open";
            return "occupied";
          }
          return settleTempFailure(internal, error);
        }
        internal.state = "consumed";
        internal.active = null;
        await closeOwner(nativeApi, internal.pin.owner);
        return "committed";
      },
      async removeTemp(temp) {
        const internal = tempMap.get(temp);
        if (!internal) throw capabilityError("shortcut_temp_capability_invalid");
        if (internal.state === "cleanup_unconfirmed") {
          throw capabilityError("shortcut_temp_cleanup_unconfirmed", internal.cleanupError);
        }
        if (internal.state === "consumed" && internal.pin.owner.closed) return true;
        if (internal.active !== temp || !["open", "failed"].includes(internal.state)) {
          throw capabilityError("shortcut_temp_capability_invalid");
        }
        requireOpen(internal.pin.owner);
        internal.state = "busy";
        let primaryError = null;
        try {
          const handle = await acquireMutationHandle(internal);
          await nativeApi.deleteByHandle(handle, { directory: false });
        } catch (error) {
          primaryError = error;
        } finally {
          internal.state = "consumed";
          internal.active = null;
          await closeOwnerWithPrimary(internal.pin.owner, primaryError);
        }
        return true;
      },
      async inspectExact(shortcutPath) {
        const exact = validateAbsolute(shortcutPath);
        let pin;
        try {
          pin = await openPinnedPath(nativeApi, exact, {
            kind: undefined,
            access: ["read", "attributes"],
            share: ["read", "delete"],
          });
        } catch (error) {
          if (isMissing(error)) return Object.freeze({ kind: "absent" });
          throw error;
        }
        try {
          const info = pin.leaf.info;
          if (info.directory || info.reparse || info.nlink !== 1) {
            await closeOwner(nativeApi, pin.owner);
            return Object.freeze({ kind: "other" });
          }
          await nativeApi.assertNoAlternateDataStreams(pin.leaf.handle);
          const descriptor = Object.freeze({ kind: "file", path: exact });
          inspectionMap.set(descriptor, {
            pin, path: exact, identity: info.identity, sealHandle: pin.leaf.handle,
            mutationHandle: null, state: "open",
          });
          return descriptor;
        } catch (error) {
          return closeOwnerWithPrimary(pin.owner, error);
        }
      },
      async removeExact(descriptor) {
        const internal = inspectionMap.get(descriptor);
        if (!internal || internal.state !== "open") throw capabilityError("shortcut_inspection_capability_invalid");
        internal.state = "busy";
        try {
          const info = validateInfo(await nativeApi.queryHandle(internal.sealHandle), "file");
          if (info.nlink !== 1 || identityKey(info.identity) !== identityKey(internal.identity)) {
            throw capabilityError("shortcut_identity_changed");
          }
          await nativeApi.assertNoAlternateDataStreams(internal.sealHandle);
          const finalPath = validateAbsolute(await nativeApi.finalPath(internal.sealHandle));
          if (!samePath(finalPath, descriptor.path)) throw capabilityError("shortcut_identity_changed");
          const mutationHandle = await acquireMutationHandle(internal, "shortcut_identity_changed");
          await nativeApi.deleteByHandle(mutationHandle, { directory: false });
        } catch (error) {
          internal.state = "consumed";
          return closeOwnerWithPrimary(internal.pin.owner, error);
        }
        internal.state = "consumed";
        await closeOwner(nativeApi, internal.pin.owner);
        return true;
      },
      async release(descriptor) {
        const internal = inspectionMap.get(descriptor);
        if (!internal) throw capabilityError("shortcut_inspection_capability_invalid");
        if (internal.state === "consumed" && internal.pin.owner.closed) return;
        if (!["open", "failed"].includes(internal.state)) {
          throw capabilityError("shortcut_inspection_capability_invalid");
        }
        internal.state = "busy";
        try {
          await closeOwner(nativeApi, internal.pin.owner);
        } finally {
          internal.state = "consumed";
        }
      },
    });
  }

  return Object.freeze({
    acquireStateLockNoFollow,
    acquireOperationLeaseNoFollow,
    openStateDirectoryNoFollow,
    openJournalDirectoryNoFollow,
    openInstallerWorkspaceRootNoFollow,
    openDirectoryNoFollow,
    openVersionRootNoFollow,
    pinArchiveFileNoFollow,
    openArchiveDestinationNoFollow,
    createShortcutFileApi,
  });
}
