import path from "node:path";

import {
  compareVersions,
  MAX_SOFTWARE_PACKAGE_BYTES,
} from "../../shared/software-manager/catalog-schema.mjs";
import { consumePreparedDownloadVerification } from "./download-manager.mjs";
import { revalidateInstallRootCapability } from "./path-policy.mjs";

const COMPONENT_EXTENSIONS = Object.freeze({
  chatgpt: ".zip",
  v2rayn: ".7z",
  git: ".exe",
});
const TASK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function workspaceError(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function isOccupied(error) {
  return error?.code === "entry_exists" || error?.code === "EEXIST"
    || error?.nativeCode === 80 || error?.nativeCode === 183;
}

function validIdentifier(value, pattern) {
  return typeof value === "string" && value === value.normalize("NFC") && pattern.test(value);
}

function validateComponent(componentId) {
  if (!Object.hasOwn(COMPONENT_EXTENSIONS, componentId)) throw workspaceError("workspace_identifier_invalid");
  return componentId;
}

function validateDownload(request = {}) {
  const { componentId, version, extension } = request;
  const component = validateComponent(componentId);
  try {
    compareVersions(version, version);
  } catch {
    throw workspaceError("workspace_identifier_invalid");
  }
  if (extension !== COMPONENT_EXTENSIONS[component]) throw workspaceError("workspace_identifier_invalid");
  if (!Number.isSafeInteger(request.size) || request.size <= 0
    || request.size > MAX_SOFTWARE_PACKAGE_BYTES || !SHA256.test(request.sha256 ?? "")) {
    throw workspaceError("workspace_asset_invalid");
  }
  return {
    componentId: component,
    version,
    extension,
    size: request.size,
    sha256: request.sha256,
  };
}

function validateTask(taskId) {
  if (!validIdentifier(taskId, TASK_ID)) throw workspaceError("workspace_identifier_invalid");
  return taskId;
}

function validateSkill(skillId) {
  if (!validIdentifier(skillId, SKILL_ID)) throw workspaceError("workspace_identifier_invalid");
  return skillId;
}

function validateFileCapabilities(value) {
  if (!value || typeof value.openInstallerWorkspaceRootNoFollow !== "function") {
    throw workspaceError("workspace_file_capabilities_invalid");
  }
  return value;
}

function validateDownloadManager(value) {
  if (!value || typeof value.downloadPrepared !== "function") {
    throw workspaceError("workspace_download_manager_invalid");
  }
  return value;
}

function requireSession(value) {
  const methods = [
    "createOrOpenDirectoryChildNoFollow",
    "createFileChildNoFollow",
    "openFileChildNoFollow",
    "inspectIssuedChildNoFollow",
    "sealIssuedFileNoFollow",
    "renameIssuedChildNoReplace",
    "deleteIssuedChildNoFollow",
    "close",
  ];
  if (!value || !value.root || methods.some((name) => typeof value[name] !== "function")) {
    throw workspaceError("workspace_file_capabilities_invalid");
  }
  return value;
}

function makeReceipt(fields) {
  return Object.freeze(Object.assign(Object.create(null), fields));
}

export function createInstallerWorkspace({
  fileCapabilities, installRootCapability, downloadManager,
} = {}) {
  const files = validateFileCapabilities(fileCapabilities);
  const downloads = validateDownloadManager(downloadManager);
  if (!installRootCapability || typeof installRootCapability !== "object") {
    throw workspaceError("install_root_capability_invalid");
  }
  const authorities = new WeakMap();
  const pending = new Map();

  async function openRoot(relativePath) {
    const maxRelativePath = relativePath.length;
    const rootPath = await revalidateInstallRootCapability(installRootCapability, { maxRelativePath });
    const openedSession = await files.openInstallerWorkspaceRootNoFollow(
      installRootCapability,
      { maxRelativePath },
    );
    let session;
    try {
      session = requireSession(openedSession);
    } catch (error) {
      if (typeof openedSession?.close !== "function") throw error;
      await openedSession.close().catch((closeError) => {
        throw new AggregateError([error, closeError], error.message, { cause: error });
      });
      throw error;
    }
    try {
      const confirmed = await revalidateInstallRootCapability(installRootCapability, { maxRelativePath });
      if (confirmed.toLowerCase() !== rootPath.toLowerCase()) throw workspaceError("install_root_identity_changed");
      return { rootPath, session };
    } catch (error) {
      await session.close().catch((closeError) => {
        throw new AggregateError([error, closeError], error.message, { cause: error });
      });
      throw error;
    }
  }

  async function createOrOpenPart(session, downloads, partName) {
    const existing = await session.openFileChildNoFollow(downloads, partName);
    if (existing) return existing;
    try {
      return await session.createFileChildNoFollow(downloads, partName);
    } catch (error) {
      if (!isOccupied(error)) throw error;
      const raced = await session.openFileChildNoFollow(downloads, partName);
      if (!raced) throw workspaceError("workspace_file_create_race", error);
      return raced;
    }
  }

  function prepareOnce(key, operation, binding = key) {
    const existing = pending.get(key);
    if (existing) {
      if (existing.binding !== binding) throw workspaceError("workspace_path_alias_collision");
      return existing.promise;
    }
    const promise = Promise.resolve().then(operation);
    const entry = { binding, promise };
    pending.set(key, entry);
    promise.catch(() => {
      if (pending.get(key) === entry) pending.delete(key);
    });
    return promise;
  }

  function claimRecord(record, expectedKind) {
    const authority = authorities.get(record);
    if (!authority) throw workspaceError("workspace_receipt_invalid");
    if (authority.state !== "issued") throw workspaceError("workspace_receipt_consumed");
    if (expectedKind && authority.kind !== expectedKind) throw workspaceError("workspace_receipt_kind_invalid");
    authority.state = "busy";
    return authority;
  }

  async function closeWithPrimary(authority, primaryError = null) {
    let closeError = null;
    try {
      await authority.session.close();
    } catch (error) {
      closeError = error;
    }
    authority.state = "consumed";
    if (primaryError && closeError) {
      throw new AggregateError([primaryError, closeError], primaryError.message, { cause: primaryError });
    }
    if (primaryError) throw primaryError;
    if (closeError) throw closeError;
  }

  async function promotePartNoReplace(record, verificationReceipt) {
    const authority = claimRecord(record, "download");
    try {
      consumePreparedDownloadVerification(downloads, verificationReceipt, {
        partPath: authority.partPath,
        size: authority.size,
        sha256: authority.sha256,
      });
    } catch (error) {
      authority.state = "issued";
      throw error;
    }
    try {
      await revalidateInstallRootCapability(installRootCapability, {
        maxRelativePath: authority.relativePath.length,
      });
      await authority.session.inspectIssuedChildNoFollow(authority.fileReceipt);
      if (authority.phase === "partial") {
        authority.fileReceipt = await authority.session.sealIssuedFileNoFollow(
          authority.fileReceipt,
          { size: authority.size, sha256: authority.sha256 },
        );
        authority.phase = "sealed";
      }
      authority.fileReceipt = await authority.session.renameIssuedChildNoReplace(
        authority.fileReceipt,
        authority.finalName,
      );
      authority.phase = "promoted";
      authority.state = "issued";
      return record.path;
    } catch (error) {
      if (isOccupied(error)) {
        authority.state = "issued";
        throw error;
      }
      pending.delete(authority.key);
      return closeWithPrimary(authority, error);
    }
  }

  async function prepareDownloadFile(raw) {
    const request = validateDownload(raw);
    const finalName = `${request.componentId}-${request.version}${request.extension}`;
    const partName = `${finalName}.part`;
    const relativePath = path.win32.join("downloads", partName);
    const rootPath = await revalidateInstallRootCapability(installRootCapability, {
      maxRelativePath: relativePath.length,
    });
    const finalPath = path.win32.join(rootPath, "downloads", finalName);
    const key = `download:${finalPath.normalize("NFC").toLowerCase()}`;
    const binding = [
      request.componentId, request.version, request.extension,
      String(request.size), request.sha256,
    ].join("\0");
    return prepareOnce(key, async () => {
      const { rootPath, session } = await openRoot(relativePath);
      try {
        const downloads = await session.createOrOpenDirectoryChildNoFollow(
          session.root, "downloads", { requireEmpty: false, role: "rename-parent" },
        );
        const occupied = await session.openFileChildNoFollow(downloads, finalName);
        if (occupied) throw workspaceError("workspace_package_collision");
        const fileReceipt = await createOrOpenPart(session, downloads, partName);
        let record;
        record = makeReceipt({
          kind: "download",
          componentId: request.componentId,
          version: request.version,
          extension: request.extension,
          size: request.size,
          sha256: request.sha256,
          path: finalPath,
          partPath: path.win32.join(rootPath, "downloads", partName),
          promotePartNoReplace: (verificationReceipt) => promotePartNoReplace(record, verificationReceipt),
        });
        authorities.set(record, {
          kind: "download",
          state: "issued",
          phase: "partial",
          key,
          session,
          fileReceipt,
          finalName,
          partPath: record.partPath,
          size: request.size,
          sha256: request.sha256,
          relativePath,
        });
        return record;
      } catch (error) {
        await session.close().catch((closeError) => {
          throw new AggregateError([error, closeError], error.message, { cause: error });
        });
        throw error;
      }
    }, binding);
  }

  async function prepareStaging({ kind, key, taskId, leafName, fields }) {
    const relativePath = path.win32.join("staging", `task-${taskId}`, leafName);
    const { rootPath, session } = await openRoot(relativePath);
    try {
      const staging = await session.createOrOpenDirectoryChildNoFollow(
        session.root, "staging", { requireEmpty: false, role: "anchor" },
      );
      const task = await session.createOrOpenDirectoryChildNoFollow(
        staging, `task-${taskId}`, { requireEmpty: false, role: "deletable" },
      );
      const leaf = await session.createOrOpenDirectoryChildNoFollow(
        task, leafName, { requireEmpty: true, role: "deletable" },
      );
      const record = makeReceipt({
        kind,
        taskId,
        ...fields,
        path: path.win32.join(rootPath, relativePath),
      });
      authorities.set(record, {
        kind,
        state: "issued",
        key,
        session,
        taskReceipt: task,
        leafReceipt: leaf,
        relativePath,
      });
      return record;
    } catch (error) {
      await session.close().catch((closeError) => {
        throw new AggregateError([error, closeError], error.message, { cause: error });
      });
      throw error;
    }
  }

  async function prepareComponentStaging(raw = {}) {
    const taskId = validateTask(raw.taskId);
    const componentId = validateComponent(raw.componentId);
    const key = `component:${taskId}:${componentId}`;
    return prepareOnce(key, () => prepareStaging({
      kind: "component-staging",
      key,
      taskId,
      leafName: `${componentId}.prepare`,
      fields: { componentId },
    }));
  }

  async function prepareSkillStaging(raw = {}) {
    const taskId = validateTask(raw.taskId);
    const skillId = validateSkill(raw.skillId);
    const key = `skill:${taskId}:${skillId}`;
    return prepareOnce(key, () => prepareStaging({
      kind: "skill-staging",
      key,
      taskId,
      leafName: `skill-${skillId}.prepare`,
      fields: { skillId },
    }));
  }

  async function cleanupStaging(record, authority) {
    let primaryError = null;
    try {
      await revalidateInstallRootCapability(installRootCapability, {
        maxRelativePath: authority.relativePath.length,
      });
      const leaf = await authority.session.inspectIssuedChildNoFollow(authority.leafReceipt);
      if (!leaf.empty) throw workspaceError("workspace_directory_not_empty");
      await authority.session.deleteIssuedChildNoFollow(authority.leafReceipt);
      const task = await authority.session.inspectIssuedChildNoFollow(authority.taskReceipt);
      if (task.empty) await authority.session.deleteIssuedChildNoFollow(authority.taskReceipt);
    } catch (error) {
      primaryError = error;
    }
    pending.delete(authority.key);
    return closeWithPrimary(authority, primaryError);
  }

  async function cleanupAbandonedPrepare(record) {
    const authority = claimRecord(record);
    if (authority.kind === "download") {
      let primaryError = null;
      try {
        await revalidateInstallRootCapability(installRootCapability, {
          maxRelativePath: authority.relativePath.length,
        });
        if (authority.phase === "partial") {
          await authority.session.inspectIssuedChildNoFollow(authority.fileReceipt);
        } else {
          await authority.session.deleteIssuedChildNoFollow(authority.fileReceipt);
        }
      } catch (error) {
        primaryError = error;
      }
      pending.delete(authority.key);
      await closeWithPrimary(authority, primaryError);
      return Object.freeze({ partialRetained: authority.phase === "partial" });
    }
    return cleanupStaging(record, authority);
  }

  async function cleanupComponentPackage(record) {
    const authority = claimRecord(record, "download");
    if (authority.phase !== "promoted") {
      authority.state = "issued";
      throw workspaceError("workspace_package_not_promoted");
    }
    let primaryError = null;
    try {
      await revalidateInstallRootCapability(installRootCapability, {
        maxRelativePath: authority.relativePath.length,
      });
      await authority.session.deleteIssuedChildNoFollow(authority.fileReceipt);
    } catch (error) {
      primaryError = error;
    }
    pending.delete(authority.key);
    await closeWithPrimary(authority, primaryError);
    return true;
  }

  return Object.freeze({
    prepareDownloadFile,
    prepareComponentStaging,
    prepareSkillStaging,
    cleanupAbandonedPrepare,
    cleanupComponentPackage,
  });
}
