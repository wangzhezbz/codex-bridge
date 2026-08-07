import path from "node:path";

import {
  compareVersions,
  MAX_SOFTWARE_PACKAGE_BYTES,
} from "../../shared/software-manager/catalog-schema.mjs";
import { consumePreparedDownloadVerification } from "./download-manager.mjs";
import { revalidateInstallRootCapability } from "./path-policy.mjs";
import { isTrustedCatalogService } from "./catalog-trust.mjs";

const COMPONENT_EXTENSIONS = Object.freeze({
  chatgpt: ".zip",
  v2rayn: ".7z",
  git: ".exe",
});
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
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
    "createDirectoryChildNoFollow",
    "createFileChildNoFollow",
    "openFileChildNoFollow",
    "inspectIssuedChildNoFollow",
    "describeIssuedDirectoryNoFollow",
    "resetIssuedFileNoFollow",
    "createIssuedFileWriteStreamNoFollow",
    "sealIssuedFileNoFollow",
    "sealIssuedSkillTreeNoFollow",
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
  fileCapabilities, installRootCapability, downloadManager, catalogService,
} = {}) {
  const files = validateFileCapabilities(fileCapabilities);
  const downloads = validateDownloadManager(downloadManager);
  if (!installRootCapability || typeof installRootCapability !== "object") {
    throw workspaceError("install_root_capability_invalid");
  }
  if (!isTrustedCatalogService(catalogService)) throw workspaceError("trusted_catalog_service_required");
  const authorities = new WeakMap();
  const promotedPackageProofs = new WeakMap();
  const pending = new Map();

  function requireDownloadAuthority(record) {
    const authority = authorities.get(record);
    if (!authority || authority.kind !== "download") throw workspaceError("workspace_receipt_invalid");
    if (authority.state !== "issued") throw workspaceError("workspace_receipt_consumed");
    return authority;
  }

  function createDownloadTarget(authority) {
    return Object.freeze(Object.assign(Object.create(null), {
      async inspect() {
        if (authority.state !== "issued") throw workspaceError("workspace_receipt_consumed");
        await revalidateInstallRootCapability(installRootCapability, {
          maxRelativePath: authority.relativePath.length,
        });
        const inspected = await authority.session.inspectIssuedChildNoFollow(authority.fileReceipt);
        if (authority.phase === "adopted" && inspected.size !== authority.size) {
          throw workspaceError("workspace_existing_package_mismatch");
        }
        return inspected;
      },
      async reset({ signal } = {}) {
        if (authority.state !== "issued" || authority.phase !== "partial") {
          throw workspaceError("workspace_receipt_consumed");
        }
        await revalidateInstallRootCapability(installRootCapability, {
          maxRelativePath: authority.relativePath.length,
        });
        authority.fileReceipt = await authority.session.resetIssuedFileNoFollow(
          authority.fileReceipt, signal === undefined ? {} : { signal },
        );
      },
      async createWriteStream({ append, maxBytes, signal }) {
        if (authority.state !== "issued" || authority.phase !== "partial") {
          throw workspaceError("workspace_receipt_consumed");
        }
        await revalidateInstallRootCapability(installRootCapability, {
          maxRelativePath: authority.relativePath.length,
        });
        return authority.session.createIssuedFileWriteStreamNoFollow(
          authority.fileReceipt, { append, maxBytes, signal },
        );
      },
      async verify({ size, sha256, signal }) {
        if (authority.state !== "issued") throw workspaceError("workspace_receipt_consumed");
        if (size !== authority.size || sha256 !== authority.sha256) {
          throw workspaceError("workspace_download_binding_invalid");
        }
        await revalidateInstallRootCapability(installRootCapability, {
          maxRelativePath: authority.relativePath.length,
        });
        if (authority.phase === "partial" || authority.phase === "adopted") {
          authority.fileReceipt = await authority.session.sealIssuedFileNoFollow(
            authority.fileReceipt, { size, sha256, signal },
          );
          authority.phase = authority.phase === "adopted" ? "promoted" : "sealed";
        } else {
          const inspected = await authority.session.inspectIssuedChildNoFollow(authority.fileReceipt);
          if (inspected.size !== size) throw workspaceError("workspace_file_size_mismatch");
        }
        return Object.freeze({ size, sha256 });
      },
    }));
  }

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
        target: authority.downloadTarget,
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
      } else {
        await authority.session.inspectIssuedChildNoFollow(authority.fileReceipt);
      }
      if (authority.phase === "sealed") {
        authority.fileReceipt = await authority.session.renameIssuedChildNoReplace(
          authority.fileReceipt,
          authority.finalName,
        );
        authority.phase = "promoted";
      }
      authority.state = "issued";
      const packageProof = Object.freeze(Object.create(null));
      promotedPackageProofs.set(packageProof, { state: "issued", authority });
      return Object.freeze({
        path: record.path,
        size: authority.size,
        sha256: authority.sha256,
        packageProof,
        downloadRecord: record,
      });
    } catch (error) {
      if (isOccupied(error)) {
        authority.state = "issued";
        throw error;
      }
      pending.delete(authority.key);
      return closeWithPrimary(authority, error);
    }
  }

  async function prepareDownloadRequest(request, { finalName, keyPrefix, publicFields }) {
    const partName = `${finalName}.part`;
    const relativePath = path.win32.join("downloads", partName);
    const rootPath = await revalidateInstallRootCapability(installRootCapability, {
      maxRelativePath: relativePath.length,
    });
    const finalPath = path.win32.join(rootPath, "downloads", finalName);
    const key = `${keyPrefix}:${finalPath.normalize("NFC").toLowerCase()}`;
    const binding = [
      ...Object.values(publicFields),
      String(request.size), request.sha256,
    ].join("\0");
    return prepareOnce(key, async () => {
      const { rootPath, session } = await openRoot(relativePath);
      try {
        const downloads = await session.createOrOpenDirectoryChildNoFollow(
          session.root, "downloads", { requireEmpty: false, role: "rename-parent" },
        );
        const occupied = await session.openFileChildNoFollow(downloads, finalName);
        const fileReceipt = occupied ?? await createOrOpenPart(session, downloads, partName);
        let record;
        record = makeReceipt({
          kind: "download",
          ...publicFields,
          size: request.size,
          sha256: request.sha256,
          path: finalPath,
          partPath: path.win32.join(rootPath, "downloads", partName),
          promotePartNoReplace: (verificationReceipt) => promotePartNoReplace(record, verificationReceipt),
        });
        authorities.set(record, {
          kind: "download",
          state: "issued",
          phase: occupied ? "adopted" : "partial",
          adoptedExisting: Boolean(occupied),
          key,
          session,
          fileReceipt,
          finalName,
          finalPath,
          partPath: record.partPath,
          size: request.size,
          sha256: request.sha256,
          ...publicFields,
          relativePath,
        });
        const authority = authorities.get(record);
        authority.downloadTarget = createDownloadTarget(authority);
        return record;
      } catch (error) {
        await session.close().catch((closeError) => {
          throw new AggregateError([error, closeError], error.message, { cause: error });
        });
        throw error;
      }
    }, binding);
  }

  async function prepareDownloadFile(raw) {
    const request = validateDownload(raw);
    return prepareDownloadRequest(request, {
      finalName: `${request.componentId}-${request.version}${request.extension}`,
      keyPrefix: "download",
      publicFields: {
        componentId: request.componentId,
        version: request.version,
        extension: request.extension,
      },
    });
  }

  async function prepareSkillDownloadFile(raw = {}) {
    const keys = ["skillId", "version", "size", "sha256"];
    if (!raw || Object.getPrototypeOf(raw) !== Object.prototype
      || Object.keys(raw).sort().join("\0") !== keys.sort().join("\0")) {
      throw workspaceError("workspace_skill_download_invalid");
    }
    const skillId = validateSkill(raw.skillId);
    const entry = catalogService.getSkill(skillId);
    if (raw.version !== entry.version || raw.size !== entry.size || raw.sha256 !== entry.sha256) {
      throw workspaceError("workspace_skill_catalog_mismatch");
    }
    return prepareDownloadRequest({
      size: entry.size,
      sha256: entry.sha256,
    }, {
      finalName: `skill-${entry.id}-${entry.version}.zip`,
      keyPrefix: "skill-download",
      publicFields: {
        skillId: entry.id,
        version: entry.version,
        extension: ".zip",
      },
    });
  }

  async function downloadPrepared(record, { asset, signal, onProgress } = {}) {
    const authority = requireDownloadAuthority(record);
    if (!asset || asset.size !== authority.size || asset.sha256 !== authority.sha256) {
      throw workspaceError("workspace_download_binding_invalid");
    }
    return downloads.downloadPrepared({
      asset, target: authority.downloadTarget, signal, onProgress,
    });
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
      const taskDescription = await session.describeIssuedDirectoryNoFollow(task);
      const leaf = await session.createDirectoryChildNoFollow(
        task, leafName, { role: "deletable" },
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
        ...fields,
        session,
        taskReceipt: task,
        taskCreated: taskDescription.created === true,
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
      if (authority.taskCreated && task.empty) {
        await authority.session.deleteIssuedChildNoFollow(authority.taskReceipt);
      }
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
        if (authority.phase === "partial" || authority.adoptedExisting) {
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

  async function settleComponentPackage(record, { deleteFile }) {
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
      if (deleteFile) {
        await authority.session.deleteIssuedChildNoFollow(authority.fileReceipt);
      } else {
        const inspected = await authority.session.inspectIssuedChildNoFollow(authority.fileReceipt);
        if (inspected.path !== authority.finalPath || inspected.kind !== "file"
          || inspected.size !== authority.size) {
          throw workspaceError("workspace_package_proof_mismatch");
        }
      }
    } catch (error) {
      primaryError = error;
    }
    pending.delete(authority.key);
    await closeWithPrimary(authority, primaryError);
    return true;
  }

  async function cleanupComponentPackage(record) {
    return settleComponentPackage(record, { deleteFile: true });
  }

  async function releaseComponentPackage(record) {
    return settleComponentPackage(record, { deleteFile: false });
  }

  async function sealSkillStaging(record, packageProof, context = {}) {
    const authority = claimRecord(record, "skill-staging");
    const keys = ["skillId", "expectedVersion"];
    if (!context || Object.getPrototypeOf(context) !== Object.prototype
      || Object.keys(context).sort().join("\0") !== keys.sort().join("\0")) {
      authority.state = "issued";
      throw workspaceError("workspace_skill_evidence_invalid");
    }
    let entry;
    try {
      entry = catalogService.getSkill(context.skillId);
    } catch (error) {
      authority.state = "issued";
      throw error;
    }
    const proofRecord = promotedPackageProofs.get(packageProof);
    if (authority.skillId !== entry.id || context.expectedVersion !== entry.version
      || !proofRecord || proofRecord.state !== "issued"
      || proofRecord.authority.skillId !== entry.id || proofRecord.authority.version !== entry.version
      || proofRecord.authority.size !== entry.size || proofRecord.authority.sha256 !== entry.sha256) {
      authority.state = "issued";
      throw workspaceError("workspace_skill_package_proof_mismatch");
    }
    proofRecord.state = "busy";
    let packageAuthoritySettled = false;
    let result;
    let primaryError = null;
    try {
      await revalidateInstallRootCapability(installRootCapability, {
        maxRelativePath: authority.relativePath.length,
      });
      await proofRecord.authority.session.inspectIssuedChildNoFollow(proofRecord.authority.fileReceipt);
      result = await authority.session.sealIssuedSkillTreeNoFollow(
        authority.leafReceipt,
        { requiredFiles: [...entry.files], packageSha256: entry.sha256 },
      );
      if (!result || result.sourceProof === null || typeof result.sourceProof !== "object"
        || !result.evidence || result.evidence.kind !== "directory") {
        throw workspaceError("workspace_skill_source_proof_invalid");
      }
      let packageCleanupError = null;
      try {
        await proofRecord.authority.session.deleteIssuedChildNoFollow(proofRecord.authority.fileReceipt);
      } catch (error) {
        packageCleanupError = error;
      }
      pending.delete(proofRecord.authority.key);
      await closeWithPrimary(proofRecord.authority, packageCleanupError);
      packageAuthoritySettled = true;
      proofRecord.state = "consumed";
    } catch (error) {
      if (proofRecord.authority.state === "consumed") packageAuthoritySettled = true;
      proofRecord.state = packageAuthoritySettled ? "consumed" : "issued";
      primaryError = error;
    }
    pending.delete(authority.key);
    await closeWithPrimary(authority, primaryError);
    return Object.freeze({ sourceProof: result.sourceProof, evidence: structuredClone(result.evidence) });
  }

  async function consumePromotedPackageProof(proof, expected) {
    const proofRecord = promotedPackageProofs.get(proof);
    if (!proofRecord) throw workspaceError("workspace_package_proof_invalid");
    if (proofRecord.state !== "issued") throw workspaceError("workspace_package_proof_consumed");
    const authority = proofRecord.authority;
    if (authority.state !== "issued" || authority.phase !== "promoted") {
      throw workspaceError("workspace_package_proof_invalid");
    }
    if (!expected || Object.getPrototypeOf(expected) !== Object.prototype
      || Object.keys(expected).sort().join("\0") !== ["path", "sha256", "size"].join("\0")
      || expected.path !== authority.finalPath
      || expected.size !== authority.size || expected.sha256 !== authority.sha256) {
      throw workspaceError("workspace_package_proof_mismatch");
    }
    proofRecord.state = "busy";
    try {
      await revalidateInstallRootCapability(installRootCapability, {
        maxRelativePath: authority.relativePath.length,
      });
      const inspected = await authority.session.inspectIssuedChildNoFollow(authority.fileReceipt);
      if (inspected.path !== expected.path || inspected.kind !== "file" || inspected.size !== expected.size) {
        throw workspaceError("workspace_package_proof_mismatch");
      }
      proofRecord.state = "consumed";
      return Object.freeze({ path: expected.path, size: expected.size, sha256: expected.sha256 });
    } catch (error) {
      proofRecord.state = "issued";
      throw error;
    }
  }

  return Object.freeze({
    prepareDownloadFile,
    prepareSkillDownloadFile,
    downloadPrepared,
    prepareComponentStaging,
    prepareSkillStaging,
    cleanupAbandonedPrepare,
    cleanupComponentPackage,
    releaseComponentPackage,
    sealSkillStaging,
    consumePromotedPackageProof,
  });
}
