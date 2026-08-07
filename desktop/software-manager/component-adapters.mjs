import path from "node:path";

import { isTrustedCatalogService } from "./catalog-trust.mjs";
import { getOwnershipCoordinator } from "./ownership-coordinator.mjs";
import {
  readFixedDirectoryCapability,
  readInstallRootCapability,
  revalidateFixedDirectoryCapability,
  revalidateInstallRootCapability,
} from "./path-policy.mjs";

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const FORBIDDEN_CONTEXT_KEYS = new Set(["catalog", "installRoot", "skillsRoot", "desktopPath", "rendererPath"]);
const COMPONENTS = Object.freeze({
  chatgpt: Object.freeze({ current: "c", staging: "ct", shortcut: "ChatGPT" }),
  v2rayn: Object.freeze({ current: "current", staging: "staging", shortcut: "V2RayN" }),
});

function adapterError(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireMethod(owner, name, code) {
  if (typeof owner?.[name] !== "function") throw adapterError(code);
  return owner[name].bind(owner);
}

function requireTaskId(value) {
  if (typeof value !== "string" || !TASK_ID.test(value)) throw adapterError("component_task_id_invalid");
  return value;
}

function rejectForbiddenContext(context) {
  if (context === undefined) return {};
  if (!isRecord(context)) throw adapterError("component_context_invalid");
  if (Object.keys(context).some((key) => FORBIDDEN_CONTEXT_KEYS.has(key))) {
    throw adapterError("component_context_authority_rejected");
  }
  return context;
}

function requireVersionSegment(value) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+){0,3}$/u.test(value)
    || value === "." || value === ".." || value.includes("\\") || value.includes("/")) {
    throw adapterError("component_version_segment_invalid");
  }
  return value;
}

function componentRoot(installRoot, componentId) {
  if (componentId === "chatgpt") return installRoot;
  if (componentId === "v2rayn") return path.win32.join(installRoot, "V2RayN");
  if (componentId === "git") return path.win32.join(installRoot, "Git");
  throw adapterError("component_id_invalid");
}

function slotRoot(installRoot, componentId, slot) {
  return path.win32.join(componentRoot(installRoot, componentId), COMPONENTS[componentId][slot]);
}

function relativeFile(root, relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.includes("\\")
    || relativePath.startsWith("/") || relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
    throw adapterError("component_manifest_path_invalid");
  }
  return path.win32.join(root, ...relativePath.split("/"));
}

function componentEntrypoint(installRoot, componentId, entry, slot = "current") {
  return relativeFile(slotRoot(installRoot, componentId, slot), entry.entrypoint);
}

function result(componentId, action, status, {
  versionBefore = null, versionAfter = null, message = `${componentId}_${action}_${status}`,
  rollbackAvailable = false,
} = {}) {
  return Object.freeze({
    componentId, action, status, versionBefore, versionAfter, message,
    rollbackAvailable: Boolean(rollbackAvailable),
  });
}

function rollbackRecords(state) {
  if (state?.rollback === null || state?.rollback === undefined) return [];
  return Array.isArray(state.rollback) ? state.rollback : [state.rollback];
}

function stateRollbackAvailable(state, componentId) {
  if (componentId === "git") return Boolean(state?.components?.git?.previousInstaller);
  return rollbackRecords(state).some((record) => record?.componentId === componentId);
}

function stateVersion(state, componentId) {
  return typeof state?.components?.[componentId]?.version === "string"
    ? state.components[componentId].version
    : null;
}

function stateSkillVersion(state, skillId) {
  return typeof state?.skills?.[skillId]?.version === "string" ? state.skills[skillId].version : null;
}

function errorMessage(error) {
  return typeof error?.code === "string" ? error.code : "component_operation_failed";
}

function exactDiscovery(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateExternalGit(value) {
  if (!isRecord(value) || value.kind !== "external" || value.ownership !== "external"
    || !["version", "installDir", "executablePath", "uninstallerPath", "registryKey"]
      .every((key) => typeof value[key] === "string" && value[key].length > 0)) {
    throw adapterError("git_external_record_invalid");
  }
  return value;
}

function validateReceipt(value, code) {
  if (!isRecord(value) || value.verificationReceipt === null || typeof value.verificationReceipt !== "object"
    || !SHA256.test(value.treeDigest ?? "") || !SHA256.test(value.manifestDigest ?? "")) {
    throw adapterError(code);
  }
  return {
    verificationReceipt: value.verificationReceipt,
    treeDigest: value.treeDigest,
    manifestDigest: value.manifestDigest,
  };
}

function validateSkillTreeEvidence(value, code = "skill_tree_evidence_invalid") {
  if (!isRecord(value) || value.kind !== "directory" || !isRecord(value.identity)
    || typeof value.identity.volumeSerial !== "string" || value.identity.volumeSerial.length === 0
    || typeof value.identity.fileId !== "string" || value.identity.fileId.length === 0
    || !SHA256.test(value.treeDigest ?? "") || !SHA256.test(value.manifestDigest ?? "")
    || !SHA256.test(value.skillMdSha256 ?? "")) throw adapterError(code);
  return structuredClone(value);
}

function validatePreviousSkillEvidence(value) {
  if (isRecord(value) && value.kind === "absent" && Object.keys(value).length === 1) return { kind: "absent" };
  return validateSkillTreeEvidence(value, "skill_previous_evidence_invalid");
}

function sameSkillEvidence(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function skillEvidenceMatchesExpected(evidence, task) {
  return evidence.kind === "directory" && evidence.treeDigest === task.treeDigest
    && evidence.manifestDigest === task.manifestDigest && evidence.skillMdSha256 === task.skillMdSha256;
}

export function createComponentAdapters({
  catalogService,
  installRootCapability,
  skillsRootCapability,
  desktopCapability,
  downloader,
  archiveService,
  versionSlots,
  ownershipStore,
  windowsHost,
  componentFiles,
  skillFiles,
  gitIdentityCapabilities,
  resolveSkillTarget,
  skillPathAccess = {},
} = {}) {
  if (!isTrustedCatalogService(catalogService)) throw adapterError("trusted_catalog_service_required");
  const installRoot = readInstallRootCapability(installRootCapability);
  const skillsDirectory = readFixedDirectoryCapability(skillsRootCapability);
  const desktopDirectory = readFixedDirectoryCapability(desktopCapability);
  if (skillsDirectory.kind !== "skills" || desktopDirectory.kind !== "desktop") {
    throw adapterError("fixed_directory_capability_mismatch");
  }
  const skillsRoot = skillsDirectory.path;
  const desktopPath = desktopDirectory.path;
  const download = requireMethod(downloader, "download", "component_downloader_required");
  const extractArchive = requireMethod(archiveService, "extractArchive", "component_archive_required");
  const promotePreparedVersion = requireMethod(versionSlots, "promotePreparedVersion", "component_slots_required");
  const rollbackVersion = requireMethod(versionSlots, "rollbackVersion", "component_slots_required");
  let ownershipCoordinator;
  try { ownershipCoordinator = getOwnershipCoordinator(ownershipStore); } catch (error) {
    throw adapterError("component_ownership_store_required", error);
  }
  const loadState = requireMethod(ownershipCoordinator.store, "load", "component_ownership_store_required");
  const saveState = requireMethod(ownershipCoordinator.store, "save", "component_ownership_store_required");
  const verifyComponent = requireMethod(componentFiles, "verifyComponent", "component_file_verifier_required");
  const verifyGitVersion = requireMethod(componentFiles, "verifyGitVersion", "git_version_verifier_required");
  const deleteComponent = requireMethod(componentFiles, "deleteComponent", "component_delete_capability_required");
  const preparePersistentDirectory = requireMethod(componentFiles, "preparePersistentDirectory", "persistent_directory_capability_required");
  const verifyPersistentDirectory = requireMethod(componentFiles, "verifyPersistentDirectory", "persistent_directory_capability_required");
  const verifyPreparedSkill = requireMethod(skillFiles, "verifyPreparedSkill", "skill_verify_capability_required");
  const hashSkillFile = requireMethod(skillFiles, "hashFile", "skill_hash_capability_required");
  const replaceSkillExact = requireMethod(skillFiles, "replaceExact", "skill_replace_capability_required");
  const deleteSkillExact = requireMethod(skillFiles, "deleteExact", "skill_delete_capability_required");
  const inspectSkillExact = requireMethod(skillFiles, "inspectExact", "skill_inspect_capability_required");
  const finalizeSkillReplacement = requireMethod(skillFiles, "finalizeReplacement", "skill_completion_capability_required");
  const verifySkillCompletionProof = requireMethod(skillFiles, "verifyCompletionProof", "skill_completion_capability_required");
  const recoverSkillCompletionProof = requireMethod(skillFiles, "recoverCompletionProof", "skill_completion_capability_required");
  const recoverShortcutReservation = requireMethod(windowsHost, "recoverShortcutReservation", "shortcut_recovery_capability_required");
  const pinGitPlan = requireMethod(gitIdentityCapabilities, "pinPlan", "git_identity_capability_required");
  const revalidateGitPlan = requireMethod(gitIdentityCapabilities, "revalidate", "git_identity_capability_required");
  const releaseGitPlan = requireMethod(gitIdentityCapabilities, "release", "git_identity_capability_required");
  const retainInstaller = requireMethod(gitIdentityCapabilities, "retainInstaller", "git_identity_capability_required");
  const pinRetainedInstaller = requireMethod(gitIdentityCapabilities, "pinRetainedInstaller", "git_identity_capability_required");
  const discardRetainedInstaller = requireMethod(gitIdentityCapabilities, "discardRetainedInstaller", "git_identity_capability_required");
  if (typeof resolveSkillTarget !== "function") throw adapterError("skill_path_resolver_required");

  const preparedComponents = new Map();
  const preparedSkills = new Map();

  async function safeLoad() {
    try { return await loadState(); } catch { return null; }
  }

  async function failed(componentId, action, error, hint = null) {
    const latest = await safeLoad();
    const version = latest
      ? (componentId === "skills" || !["chatgpt", "v2rayn", "git"].includes(componentId)
        ? stateSkillVersion(latest, componentId)
        : stateVersion(latest, componentId))
      : hint;
    return result(componentId, action, "failed", {
      versionBefore: version, versionAfter: version, message: errorMessage(error),
      rollbackAvailable: latest ? stateRollbackAvailable(latest, componentId) : false,
    });
  }

  function assertStateForManaged(state) {
    if (!isRecord(state) || !isRecord(state.components) || !isRecord(state.skills)
      || !Array.isArray(state.shortcuts)) throw adapterError("component_ownership_state_invalid");
    if (state.installRoot !== null && state.installRoot !== installRoot) {
      throw adapterError("component_install_root_not_owned");
    }
    return state;
  }

  function managedRecord(state, componentId) {
    assertStateForManaged(state);
    const record = state.components[componentId];
    if (record === undefined) return null;
    const expected = componentId === "git"
      ? componentRoot(installRoot, "git")
      : slotRoot(installRoot, componentId, "current");
    if (!isRecord(record) || record.managed !== true || record.installPath !== expected
      || typeof record.version !== "string") throw adapterError("component_owned_record_invalid");
    return record;
  }

  function trustedComponent(componentId) {
    const entry = catalogService.getComponent(componentId);
    requireVersionSegment(entry.version);
    const expectedFormat = { chatgpt: "zip", v2rayn: "7z", git: "exe" }[componentId];
    if (entry.format !== expectedFormat || !Array.isArray(entry.requiredFiles)
      || !entry.requiredFiles.includes(entry.entrypoint)) throw adapterError("component_catalog_entry_invalid");
    for (const file of entry.requiredFiles) relativeFile("D:\\proof", file);
    return entry;
  }

  function componentPeakRelativePath(componentId, entry) {
    const destinations = componentId === "git"
      ? [path.win32.join("Git", entry.entrypoint), path.win32.join("downloads", `git-${entry.version}.exe`)]
      : [path.win32.relative(installRoot, slotRoot(installRoot, componentId, "staging"))];
    return Math.max(...destinations.map((prefix) => (
      prefix.length + (componentId === "git" ? 0 : 1 + entry.maxRelativePathLength)
    )));
  }

  function trustedSkill(skillId) {
    const entry = catalogService.getSkill(skillId);
    requireVersionSegment(entry.version);
    if (!Array.isArray(entry.files) || !entry.files.includes("SKILL.md")) {
      throw adapterError("skill_catalog_entry_invalid");
    }
    for (const file of entry.files) relativeFile("D:\\proof", file);
    return entry;
  }

  async function recoverSkillTransaction() {
    const state = await loadState();
    const task = state?.activeTask;
    if (!isRecord(task) || !["skill-replace", "skill-uninstall"].includes(task.kind)) return state;
    if (task.skillsRoot !== skillsRoot || typeof task.skillId !== "string"
      || task.target !== path.win32.join(skillsRoot, task.skillId)) {
      throw adapterError("skill_recovery_record_invalid");
    }
    const target = await resolveSkillTarget({
      skillsRoot, skillId: task.skillId, realpath: skillPathAccess.realpath, lstat: skillPathAccess.lstat,
    });
    if (target !== task.target) throw adapterError("skill_target_mismatch");
    const next = structuredClone(state);
    if (task.kind === "skill-replace") {
      if (!["reserved", "applied"].includes(task.phase) || !SHA256.test(task.packageSha256 ?? "")
        || !SHA256.test(task.skillMdSha256 ?? "") || !SHA256.test(task.treeDigest ?? "")
        || !SHA256.test(task.manifestDigest ?? "")) throw adapterError("skill_recovery_record_invalid");
      const previousEvidence = validatePreviousSkillEvidence(task.previousEvidence);
      const inspectedRaw = await inspectSkillExact({ target, authorizedRoot: skillsRoot });
      const inspected = inspectedRaw?.kind === "absent"
        ? validatePreviousSkillEvidence(inspectedRaw)
        : validateSkillTreeEvidence(inspectedRaw);
      if (task.phase === "reserved" && sameSkillEvidence(inspected, previousEvidence)) {
        next.activeTask = null;
        next.lastTask = { taskId: task.taskId, componentId: task.skillId, action: "skill-replace-aborted" };
        await saveState(next);
        return next;
      }
      let completionProof = task.completionProof;
      let appliedEvidence = task.appliedEvidence;
      if (task.phase === "reserved") {
        if (!skillEvidenceMatchesExpected(inspected, task)) throw adapterError("skill_recovery_content_mismatch");
        const recovered = await recoverSkillCompletionProof({
          target, taskId: task.taskId,
          expected: {
            treeDigest: task.treeDigest, manifestDigest: task.manifestDigest,
            skillMdSha256: task.skillMdSha256,
          },
        });
        if (!isRecord(recovered) || recovered.completionProof === undefined) {
          throw adapterError("skill_completion_recovery_invalid");
        }
        completionProof = recovered.completionProof;
        appliedEvidence = validateSkillTreeEvidence(recovered.evidence, "skill_completion_recovery_invalid");
        if (!sameSkillEvidence(appliedEvidence, inspected)) throw adapterError("skill_completion_recovery_invalid");
        next.activeTask = { ...structuredClone(task), phase: "applied", completionProof, appliedEvidence };
        await saveState(next);
      }
      const verified = validateSkillTreeEvidence(await verifySkillCompletionProof({
        completionProof, target, taskId: task.taskId,
        expected: {
          treeDigest: task.treeDigest, manifestDigest: task.manifestDigest,
          skillMdSha256: task.skillMdSha256,
        },
      }), "skill_completion_proof_invalid");
      if (!sameSkillEvidence(verified, appliedEvidence) || !sameSkillEvidence(verified, inspected)
        || !skillEvidenceMatchesExpected(verified, task)) throw adapterError("skill_completion_proof_invalid");
      next.skills[task.skillId] = {
        target, version: task.version, packageSha256: task.packageSha256,
        skillMdSha256: task.skillMdSha256, identity: verified.identity,
        treeDigest: verified.treeDigest, manifestDigest: verified.manifestDigest,
      };
    } else {
      const inspected = await inspectSkillExact({ target, authorizedRoot: skillsRoot });
      if (inspected?.kind !== "absent") throw adapterError("skill_uninstall_recovery_incomplete");
      delete next.skills[task.skillId];
    }
    next.activeTask = null;
    next.lastTask = { taskId: task.taskId, componentId: task.skillId, action: task.kind };
    await saveState(next);
    return next;
  }

  async function recoverComponentUninstall() {
    const state = assertStateForManaged(await loadState());
    const task = state.activeTask;
    if (!isRecord(task) || !["component-uninstall", "component-shortcut"].includes(task.kind)) return state;
    if (task.kind === "component-shortcut") {
      if (!["chatgpt", "v2rayn"].includes(task.componentId) || !["reserved", "applied"].includes(task.phase)
        || typeof task.taskId !== "string" || task.desktopPath !== desktopPath
        || typeof task.targetPath !== "string") throw adapterError("shortcut_recovery_record_invalid");
      const next = structuredClone(state);
      let shortcut = task.shortcut ?? null;
      if (task.phase === "reserved") {
        const recovered = await recoverShortcutReservation({
          reservationId: task.taskId, componentId: task.componentId,
          desktopPath, targetPath: task.targetPath, name: COMPONENTS[task.componentId].shortcut,
        });
        if (recovered?.kind === "absent") {
          next.activeTask = null;
          next.lastTask = { taskId: task.taskId, componentId: task.componentId, action: "shortcut-aborted" };
          await saveState(next);
          return next;
        }
        shortcut = recovered?.kind === "shortcut" ? recovered.shortcut : null;
      }
      if (!isRecord(shortcut) || shortcut.targetPath !== task.targetPath
        || shortcut.desktopPath !== desktopPath || shortcut.reservationId !== task.taskId
        || typeof shortcut.path !== "string" || path.win32.dirname(shortcut.path) !== desktopPath) {
        throw adapterError("shortcut_recovery_evidence_invalid");
      }
      next.shortcuts = next.shortcuts.filter((record) => record?.componentId !== task.componentId);
      next.shortcuts.push({ ...structuredClone(shortcut), componentId: task.componentId });
      next.activeTask = null;
      next.lastTask = { taskId: task.taskId, componentId: task.componentId, action: "shortcut" };
      await saveState(next);
      return next;
    }
    if (!["chatgpt", "v2rayn"].includes(task.componentId)
      || task.rootPath !== componentRoot(installRoot, task.componentId)) {
      throw adapterError("component_uninstall_recovery_record_invalid");
    }
    await deleteComponent({
      componentId: task.componentId, rootPath: task.rootPath, authorizedRoot: installRoot,
    });
    const next = structuredClone(state);
    delete next.components[task.componentId];
    next.shortcuts = next.shortcuts.filter((item) => item?.componentId !== task.componentId);
    next.rollback = rollbackRecords(next).filter((item) => item?.componentId !== task.componentId);
    if (next.rollback.length === 0) next.rollback = null;
    next.activeTask = null;
    next.lastTask = { taskId: task.taskId, componentId: task.componentId, action: "uninstall" };
    if (Object.keys(next.components).length === 0 && Object.keys(next.skills).length === 0) next.installRoot = null;
    await saveState(next);
    return next;
  }

  async function prepareArchiveComponent(componentId, rawContext) {
    const action = "prepare";
    try {
      const context = rejectForbiddenContext(rawContext);
      const taskId = requireTaskId(context.taskId);
      const state = await recoverComponentUninstall();
      const before = managedRecord(state, componentId)?.version ?? null;
      const entry = trustedComponent(componentId);
      await revalidateInstallRootCapability(installRootCapability, {
        maxRelativePath: componentPeakRelativePath(componentId, entry),
      });
      const rootPath = componentRoot(installRoot, componentId);
      const staging = slotRoot(installRoot, componentId, "staging");
      const persistentConfig = componentId === "v2rayn"
        ? await preparePersistentDirectory({ componentId, rootPath: path.win32.join(installRoot, "V2RayN-Data") })
        : null;
      const archivePath = path.win32.join(installRoot, "downloads", `${componentId}-${entry.version}.${entry.format}`);
      const downloaded = await download({
        asset: { url: entry.assetUrl, size: entry.size, sha256: entry.sha256 }, destination: archivePath,
        signal: context.signal, onProgress: typeof context.onProgress === "function" ? context.onProgress : () => {},
      });
      if (!isRecord(downloaded) || downloaded.path !== archivePath
        || downloaded.size !== entry.size || downloaded.sha256 !== entry.sha256) {
        throw adapterError("component_download_evidence_invalid");
      }
      const receipt = validateReceipt(await extractArchive({
        format: entry.format, archivePath, destination: staging, signal: context.signal,
        verification: { componentId, version: entry.version },
      }), "component_verification_receipt_invalid");
      await verifyComponent({
        rootPath: staging,
        entrypointPath: componentEntrypoint(installRoot, componentId, entry, "staging"),
        requiredFiles: entry.requiredFiles.map((file) => relativeFile(staging, file)),
        expectedVersion: entry.version,
        expectedPackageSha256: entry.sha256,
      });
      preparedComponents.set(`${componentId}\0${taskId}`, Object.freeze({
        taskId, componentId, before, entry, rootPath, persistentConfig, ...receipt,
      }));
      return result(componentId, action, "succeeded", {
        versionBefore: before, versionAfter: entry.version, message: "component_prepared",
        rollbackAvailable: stateRollbackAvailable(state, componentId),
      });
    } catch (error) {
      return failed(componentId, action, error);
    }
  }

  async function commitArchiveComponent(componentId, rawContext) {
    const action = "commit";
    let before = null;
    let wasRunning = false;
    let oldEntrypoint = null;
    try {
      const context = rejectForbiddenContext(rawContext);
      const taskId = requireTaskId(context.taskId);
      const key = `${componentId}\0${taskId}`;
      const prepared = preparedComponents.get(key);
      if (!prepared) throw adapterError("component_not_prepared");
      preparedComponents.delete(key);
      before = prepared.before;
      const state = await recoverComponentUninstall();
      const owned = managedRecord(state, componentId);
      if ((owned?.version ?? null) !== before) throw adapterError("component_state_changed");
      if (componentId === "v2rayn") {
        await verifyPersistentDirectory({
          componentId, rootPath: path.win32.join(installRoot, "V2RayN-Data"), evidence: prepared.persistentConfig,
        });
      }
      if (owned) {
        if (typeof owned.entrypointPath !== "string" || !Array.isArray(owned.requiredFiles)) {
          throw adapterError("component_runtime_metadata_missing");
        }
        oldEntrypoint = owned.entrypointPath;
        const stopped = await windowsHost.stopOwnedProcesses([oldEntrypoint]);
        wasRunning = Array.isArray(stopped?.stoppedProcessIds) && stopped.stoppedProcessIds.length > 0;
      }
      let promoted;
      const finalEntrypoint = componentEntrypoint(installRoot, componentId, prepared.entry);
      const finalRequiredFiles = prepared.entry.requiredFiles.map((file) => relativeFile(
        slotRoot(installRoot, componentId, "current"), file,
      ));
      try {
        promoted = await promotePreparedVersion({
          taskId, componentId, rootPath: prepared.rootPath, version: prepared.entry.version,
          verificationReceipt: prepared.verificationReceipt,
          treeDigest: prepared.treeDigest, manifestDigest: prepared.manifestDigest,
          runtimeMetadata: {
            entrypointPath: finalEntrypoint, requiredFiles: finalRequiredFiles, health: "pending-verify",
          },
        });
      } catch (error) {
        if (wasRunning) await windowsHost.launchOwned(oldEntrypoint).catch(() => {});
        throw error;
      }

      const warnings = [];
      let coreVerifyError = null;
      try {
        await verifyComponent({
          rootPath: slotRoot(installRoot, componentId, "current"), entrypointPath: finalEntrypoint,
          requiredFiles: finalRequiredFiles,
          expectedVersion: prepared.entry.version, expectedPackageSha256: prepared.entry.sha256,
        });
        if (componentId === "v2rayn") {
          await verifyPersistentDirectory({
            componentId, rootPath: path.win32.join(installRoot, "V2RayN-Data"), evidence: prepared.persistentConfig,
          });
        }
      } catch (error) { coreVerifyError = error; }
      if (coreVerifyError) {
        if (owned) {
          try {
            await rollbackVersion(componentId);
            if (wasRunning) await windowsHost.launchOwned(oldEntrypoint).catch(() => {});
          } catch (rollbackError) {
            return failed(componentId, action, rollbackError, before);
          }
        } else {
          const unhealthy = assertStateForManaged(await loadState());
          const current = managedRecord(unhealthy, componentId);
          if (current?.version === prepared.entry.version) {
            const marked = structuredClone(unhealthy);
            marked.components[componentId] = {
              ...current, entrypointPath: finalEntrypoint, requiredFiles: finalRequiredFiles,
              health: "failed-unhealthy", verifyError: errorMessage(coreVerifyError),
            };
            await saveState(marked).catch(() => {});
          }
        }
        return failed(componentId, action, coreVerifyError, before);
      }
      let stateAfter = assertStateForManaged(await loadState());
      const currentRecord = managedRecord(stateAfter, componentId);
      if (!currentRecord || currentRecord.version !== prepared.entry.version) {
        return failed(componentId, action, adapterError("component_state_changed"), before);
      }
      const withRuntimeMetadata = structuredClone(stateAfter);
      withRuntimeMetadata.components[componentId] = {
        ...currentRecord, entrypointPath: finalEntrypoint, requiredFiles: finalRequiredFiles, health: "healthy",
      };
      try {
        stateAfter = await saveState(withRuntimeMetadata);
      } catch (error) {
        warnings.push(`runtime_metadata:${errorMessage(error)}`);
      }
      const recordedShortcut = stateAfter?.shortcuts?.find((record) => record?.componentId === componentId);
      if (!recordedShortcut) {
        try {
          const shortcutTask = {
            kind: "component-shortcut", phase: "reserved", taskId, componentId,
            desktopPath, targetPath: finalEntrypoint,
          };
          const reserved = structuredClone(stateAfter);
          reserved.activeTask = shortcutTask;
          stateAfter = await saveState(reserved);
          const shortcut = await windowsHost.createShortcut({
            name: COMPONENTS[componentId].shortcut, desktopPath, targetPath: finalEntrypoint,
            reservationId: taskId,
          });
          if (!isRecord(shortcut) || shortcut.targetPath !== finalEntrypoint || shortcut.desktopPath !== desktopPath
            || shortcut.reservationId !== taskId || typeof shortcut.path !== "string"
            || path.win32.dirname(shortcut.path) !== desktopPath) throw adapterError("shortcut_result_invalid");
          if (stateAfter) {
            const applied = structuredClone(stateAfter);
            applied.activeTask = { ...shortcutTask, phase: "applied", shortcut: structuredClone(shortcut) };
            try {
              stateAfter = await saveState(applied);
              const adopted = structuredClone(stateAfter);
              adopted.shortcuts.push({ ...shortcut, componentId });
              adopted.activeTask = null;
              stateAfter = await saveState(adopted);
            } catch (error) {
              warnings.push(`shortcut_state:${errorMessage(error)}`);
            }
          }
        } catch (error) {
          warnings.push(`shortcut:${errorMessage(error)}`);
        }
      }
      if (wasRunning) {
        await windowsHost.launchOwned(finalEntrypoint)
          .catch((error) => { warnings.push(`restart:${errorMessage(error)}`); });
      }
      return result(componentId, action, "succeeded", {
        versionBefore: before, versionAfter: prepared.entry.version,
        message: warnings.length === 0 ? "component_committed" : `component_committed_with_warning:${warnings.join(",")}`,
        rollbackAvailable: Boolean(promoted?.rollbackAvailable),
      });
    } catch (error) {
      return failed(componentId, action, error, before);
    }
  }

  async function inspectManaged(componentId, rawContext) {
    try {
      rejectForbiddenContext(rawContext);
      const state = await recoverComponentUninstall();
      const record = managedRecord(state, componentId);
      if (!record) return result(componentId, "inspect", "skipped", { message: "component_not_installed" });
      return result(componentId, "inspect", "succeeded", {
        versionBefore: record.version, versionAfter: record.version, message: "component_installed",
        rollbackAvailable: stateRollbackAvailable(state, componentId),
      });
    } catch (error) { return failed(componentId, "inspect", error); }
  }

  async function verifyManaged(componentId, rawContext) {
    try {
      rejectForbiddenContext(rawContext);
      const state = await recoverComponentUninstall();
      const record = managedRecord(state, componentId);
      if (!record) throw adapterError("component_not_installed");
      if (typeof record.entrypointPath !== "string" || !Array.isArray(record.requiredFiles)) {
        throw adapterError("component_runtime_metadata_missing");
      }
      await verifyComponent({
        rootPath: slotRoot(installRoot, componentId, "current"),
        entrypointPath: record.entrypointPath,
        requiredFiles: record.requiredFiles,
        expectedVersion: record.version,
      });
      return result(componentId, "verify", "succeeded", {
        versionBefore: record.version, versionAfter: record.version, message: "component_verified",
        rollbackAvailable: stateRollbackAvailable(state, componentId),
      });
    } catch (error) { return failed(componentId, "verify", error); }
  }

  async function uninstallManaged(componentId, rawContext) {
    let before = null;
    let deleted = false;
    try {
      const context = rejectForbiddenContext(rawContext);
      const state = await recoverComponentUninstall();
      if (state.activeTask !== null) throw adapterError("component_pending_transaction");
      const record = managedRecord(state, componentId);
      if (!record) return result(componentId, "uninstall", "skipped", { message: "component_not_installed" });
      before = record.version;
      if (typeof record.entrypointPath !== "string") throw adapterError("component_runtime_metadata_missing");
      await windowsHost.stopOwnedProcesses([record.entrypointPath]);
      for (const shortcut of state.shortcuts.filter((item) => item?.componentId === componentId)) {
        await windowsHost.removeRecordedShortcut(shortcut);
      }
      const taskId = TASK_ID.test(context.taskId ?? "") ? context.taskId : `uninstall-${componentId}`;
      const reserved = structuredClone(state);
      reserved.activeTask = { kind: "component-uninstall", taskId, componentId, rootPath: componentRoot(installRoot, componentId) };
      await saveState(reserved);
      await deleteComponent({ componentId, rootPath: componentRoot(installRoot, componentId), authorizedRoot: installRoot });
      deleted = true;
      const next = structuredClone(reserved);
      delete next.components[componentId];
      next.shortcuts = next.shortcuts.filter((item) => item?.componentId !== componentId);
      next.rollback = rollbackRecords(next).filter((item) => item?.componentId !== componentId);
      if (next.rollback.length === 0) next.rollback = null;
      next.activeTask = null;
      await saveState(next).catch(() => {});
      return result(componentId, "uninstall", "succeeded", {
        versionBefore: before, versionAfter: null,
        message: deleted ? "component_uninstalled" : "component_uninstall_warning",
      });
    } catch (error) { return failed(componentId, "uninstall", error, before); }
  }

  async function rollbackManaged(componentId, rawContext) {
    let before = null;
    let wasRunning = false;
    let oldEntrypoint = null;
    try {
      rejectForbiddenContext(rawContext);
      const state = await recoverComponentUninstall();
      const record = managedRecord(state, componentId);
      if (!record) throw adapterError("component_not_installed");
      before = record.version;
      if (typeof record.entrypointPath !== "string" || !Array.isArray(record.requiredFiles)) {
        throw adapterError("component_runtime_metadata_missing");
      }
      oldEntrypoint = record.entrypointPath;
      const stopped = await windowsHost.stopOwnedProcesses([oldEntrypoint]);
      wasRunning = Array.isArray(stopped?.stoppedProcessIds) && stopped.stoppedProcessIds.length > 0;
      const rolled = await rollbackVersion(componentId);
      const warnings = [];
      const restoredState = assertStateForManaged(await loadState());
      const restored = managedRecord(restoredState, componentId);
      if (!restored || typeof restored.entrypointPath !== "string") throw adapterError("component_runtime_metadata_missing");
      if (wasRunning) await windowsHost.launchOwned(restored.entrypointPath)
        .catch((error) => warnings.push(`restart:${errorMessage(error)}`));
      return result(componentId, "rollback", "succeeded", {
        versionBefore: before, versionAfter: rolled.version,
        message: warnings.length ? `component_rolled_back_with_warning:${warnings.join(",")}` : "component_rolled_back",
      });
    } catch (error) {
      if (wasRunning && oldEntrypoint) await windowsHost.launchOwned(oldEntrypoint).catch(() => {});
      return failed(componentId, "rollback", error, before);
    }
  }

  function archiveAdapter(componentId) {
    return Object.freeze({
      inspectInstalled: (context) => inspectManaged(componentId, context),
      prepare: (context) => prepareArchiveComponent(componentId, context),
      commit: (context) => commitArchiveComponent(componentId, context),
      verify: (context) => verifyManaged(componentId, context),
      uninstall: (context) => uninstallManaged(componentId, context),
      rollback: (context) => rollbackManaged(componentId, context),
    });
  }

  function exactManagedGitDiscovery(discovery, managed) {
    return discovery.installDir === managed.installPath
      && discovery.executablePath === managed.executablePath
      && discovery.uninstallerPath === managed.uninstallerPath;
  }

  async function verifyRetainedGitInstaller(record) {
    const pin = await pinRetainedInstaller(record);
    try {
      await revalidateGitPlan(pin, { installerSha256: record.sha256 });
      const signature = await windowsHost.verifyAuthenticode(record.path);
      if (signature?.status !== "Valid") throw adapterError("git_authenticode_invalid");
      await revalidateGitPlan(pin, { installerSha256: record.sha256 });
    } finally {
      await releaseGitPlan(pin);
    }
  }

  async function finishGitRollbackCleanup(state) {
    const task = state.activeTask;
    if (task?.kind !== "git-rollback-cleanup") return state;
    await discardRetainedInstaller(task.rejectedInstaller);
    const next = structuredClone(state);
    next.activeTask = null;
    next.lastTask = { taskId: task.taskId, componentId: "git", action: "rollback" };
    await saveState(next);
    return next;
  }

  async function finishGitInstallCleanup(state) {
    const task = state.activeTask;
    if (task?.kind !== "git-install-cleanup") return state;
    await discardRetainedInstaller(task.replacedInstaller);
    const next = structuredClone(state);
    next.activeTask = null;
    next.lastTask = { taskId: task.taskId, componentId: "git", action: "install" };
    await saveState(next);
    return next;
  }

  async function recoverGitTransaction() {
    let state = assertStateForManaged(await loadState());
    const task = state.activeTask;
    if (!isRecord(task) || !["git-install", "git-install-cleanup", "git-rollback", "git-rollback-cleanup", "git-uninstall"].includes(task.kind)) {
      return state;
    }
    if (task.kind === "git-install-cleanup") return finishGitInstallCleanup(state);
    if (task.kind === "git-rollback-cleanup") return finishGitRollbackCleanup(state);
    const managed = managedRecord(state, "git");
    const targetDir = componentRoot(installRoot, "git");
    if (task.targetDir !== targetDir || task.executablePath !== relativeFile(targetDir, "cmd/git.exe")) {
      throw adapterError("git_recovery_record_invalid");
    }
    let discoveredRaw = await windowsHost.discoverGit();
    if (task.kind === "git-uninstall") {
      if (discoveredRaw?.kind !== "none") {
        const discovered = validateExternalGit(discoveredRaw);
        if (!managed || !exactManagedGitDiscovery(discovered, managed) || discovered.version !== managed.version) {
          throw adapterError("git_uninstall_recovery_incomplete");
        }
        const aborted = structuredClone(state);
        aborted.activeTask = null;
        await saveState(aborted);
        return aborted;
      }
      if (managed) await deleteComponent({ componentId: "git", rootPath: managed.installPath, authorizedRoot: installRoot });
      const next = structuredClone(state);
      delete next.components.git;
      next.activeTask = null;
      next.lastTask = { taskId: task.taskId, componentId: "git", action: "uninstall" };
      if (Object.keys(next.components).length === 0 && Object.keys(next.skills).length === 0) next.installRoot = null;
      await saveState(next);
      return next;
    }
    if (discoveredRaw?.kind === "none" && task.kind === "git-install" && managed === null) {
      const aborted = structuredClone(state);
      aborted.activeTask = null;
      await saveState(aborted);
      return aborted;
    }
    if (discoveredRaw?.kind === "none" && task.kind === "git-rollback") {
      await verifyRetainedGitInstaller({ path: task.installerPath, sha256: task.installerSha256, version: task.version });
      await windowsHost.runGitInstaller({ installerPath: task.installerPath, targetDir });
      discoveredRaw = await windowsHost.discoverGit();
    }
    const discovered = validateExternalGit(discoveredRaw);
    if (discovered.installDir !== targetDir || discovered.executablePath !== task.executablePath) {
      throw adapterError("git_recovery_registration_mismatch");
    }
    if (managed && exactManagedGitDiscovery(discovered, managed) && discovered.version === managed.version) {
      const aborted = structuredClone(state);
      aborted.activeTask = null;
      await saveState(aborted);
      return aborted;
    }
    await verifyGitVersion(task.executablePath, task.version);
    await verifyRetainedGitInstaller({ path: task.installerPath, sha256: task.installerSha256, version: task.version });
    const recoveredPin = await pinGitPlan({ discovery: discovered, targetDir });
    try { await revalidateGitPlan(recoveredPin, { discovery: discovered }); } finally { await releaseGitPlan(recoveredPin); }
    const next = structuredClone(state);
    next.installRoot = installRoot;
    if (task.kind === "git-install") {
      next.components.git = {
        managed: true, installPath: targetDir, version: task.version,
        executablePath: task.executablePath, uninstallerPath: discovered.uninstallerPath,
        currentInstaller: { path: task.installerPath, sha256: task.installerSha256, version: task.version },
        previousInstaller: managed?.currentInstaller ?? null,
      };
      next.activeTask = isRecord(task.replacedInstaller) ? {
        kind: "git-install-cleanup", taskId: task.taskId, targetDir,
        executablePath: task.executablePath, replacedInstaller: task.replacedInstaller,
      } : null;
      next.lastTask = { taskId: task.taskId, componentId: "git", action: "install" };
      await saveState(next);
      return next.activeTask ? finishGitInstallCleanup(next) : next;
    }
    if (!isRecord(task.rejectedInstaller)) throw adapterError("git_recovery_record_invalid");
    next.components.git = {
      ...managed, version: task.version,
      currentInstaller: { path: task.installerPath, sha256: task.installerSha256, version: task.version },
      previousInstaller: null,
      uninstallerPath: discovered.uninstallerPath,
    };
    next.activeTask = {
      kind: "git-rollback-cleanup", taskId: task.taskId, targetDir,
      executablePath: task.executablePath, rejectedInstaller: task.rejectedInstaller,
    };
    await saveState(next);
    return finishGitRollbackCleanup(next);
  }

  async function inspectGit(rawContext) {
    try {
      rejectForbiddenContext(rawContext);
      const state = await recoverGitTransaction();
      const managed = managedRecord(state, "git");
      if (managed) return result("git", "inspect", "succeeded", {
        versionBefore: managed.version, versionAfter: managed.version, message: "git_managed_installed",
        rollbackAvailable: Boolean(managed.previousInstaller),
      });
      const discovered = await windowsHost.discoverGit();
      if (discovered?.kind === "none") return result("git", "inspect", "skipped", { message: "git_not_installed" });
      const external = validateExternalGit(discovered);
      return result("git", "inspect", "succeeded", {
        versionBefore: external.version, versionAfter: external.version, message: "git_external_installed",
      });
    } catch (error) { return failed("git", "inspect", error); }
  }

  async function prepareGit(rawContext) {
    let pin = null;
    try {
      const context = rejectForbiddenContext(rawContext);
      if (context.selected !== true) throw adapterError("git_explicit_selection_required");
      const taskId = requireTaskId(context.taskId);
      const state = await recoverGitTransaction();
      if (state.activeTask !== null) throw adapterError("component_pending_transaction");
      const managed = managedRecord(state, "git");
      const discovery = await windowsHost.discoverGit();
      if (managed) {
        const current = validateExternalGit(discovery);
        if (!exactManagedGitDiscovery(current, managed) || current.version !== managed.version) {
          throw adapterError("git_managed_registration_mismatch");
        }
      }
      if (!managed && discovery?.kind !== "none") validateExternalGit(discovery);
      const entry = trustedComponent("git");
      await revalidateInstallRootCapability(installRootCapability, {
        maxRelativePath: componentPeakRelativePath("git", entry),
      });
      const installerPath = path.win32.join(installRoot, "downloads", `git-${entry.version}.exe`);
      const downloaded = await download({
        asset: { url: entry.assetUrl, size: entry.size, sha256: entry.sha256 }, destination: installerPath,
        signal: context.signal, onProgress: typeof context.onProgress === "function" ? context.onProgress : () => {},
      });
      if (!isRecord(downloaded) || downloaded.path !== installerPath
        || downloaded.size !== entry.size || downloaded.sha256 !== entry.sha256) {
        throw adapterError("component_download_evidence_invalid");
      }
      const signature = await windowsHost.verifyAuthenticode(installerPath);
      if (signature?.status !== "Valid") throw adapterError("git_authenticode_invalid");
      const mode = !managed && discovery?.kind === "external" ? "external" : "managed";
      const targetDir = mode === "external" ? discovery.installDir : componentRoot(installRoot, "git");
      pin = await pinGitPlan({
        installerPath, installerSha256: entry.sha256, targetDir,
        discovery: discovery?.kind === "external" ? discovery : null,
        targetMustBeAbsent: discovery?.kind === "none",
      });
      preparedComponents.set(`git\0${taskId}`, Object.freeze({
        taskId, mode, entry, installerPath, pin,
        discovery: discovery?.kind === "external" ? structuredClone(discovery) : null,
        before: managed?.version ?? (discovery?.kind === "external" ? discovery.version : null),
        previousRecord: managed ? structuredClone(managed) : null,
      }));
      pin = null;
      return result("git", "prepare", "succeeded", {
        versionBefore: managed?.version ?? (discovery?.version ?? null), versionAfter: entry.version,
        message: "git_prepared", rollbackAvailable: Boolean(managed?.previousInstaller),
      });
    } catch (error) {
      if (pin) await releaseGitPlan(pin).catch(() => {});
      return failed("git", "prepare", error);
    }
  }

  async function commitGit(rawContext) {
    let prepared = null;
    try {
      const context = rejectForbiddenContext(rawContext);
      const taskId = requireTaskId(context.taskId);
      const key = `git\0${taskId}`;
      prepared = preparedComponents.get(key);
      if (!prepared) throw adapterError("component_not_prepared");
      preparedComponents.delete(key);
      if (prepared.mode === "external") {
        const fresh = validateExternalGit(await windowsHost.discoverGit());
        if (!exactDiscovery(fresh, prepared.discovery)) throw adapterError("git_external_state_changed");
        await revalidateGitPlan(prepared.pin, { discovery: fresh, installerSha256: prepared.entry.sha256 });
        const signature = await windowsHost.verifyAuthenticode(prepared.installerPath);
        if (signature?.status !== "Valid") throw adapterError("git_authenticode_invalid");
        await revalidateGitPlan(prepared.pin, { discovery: fresh, installerSha256: prepared.entry.sha256 });
        await windowsHost.runGitInstaller({ installerPath: prepared.installerPath, targetDir: fresh.installDir });
        await verifyGitVersion(fresh.executablePath, prepared.entry.version);
        return result("git", "commit", "succeeded", {
          versionBefore: prepared.before, versionAfter: prepared.entry.version,
          message: "git_external_updated", rollbackAvailable: false,
        });
      }

      const state = await recoverGitTransaction();
      if (state.activeTask !== null) throw adapterError("component_pending_transaction");
      if (managedRecord(state, "git")?.version !== prepared.previousRecord?.version
        && !(managedRecord(state, "git") === null && prepared.previousRecord === null)) {
        throw adapterError("component_state_changed");
      }
      let currentDiscovery = null;
      if (prepared.previousRecord) {
        currentDiscovery = validateExternalGit(await windowsHost.discoverGit());
        if (!exactManagedGitDiscovery(currentDiscovery, prepared.previousRecord)
          || currentDiscovery.version !== prepared.previousRecord.version
          || !exactDiscovery(currentDiscovery, prepared.discovery)) {
          throw adapterError("git_managed_registration_mismatch");
        }
      } else if ((await windowsHost.discoverGit())?.kind !== "none") {
        throw adapterError("git_managed_target_occupied");
      }
      const identityExpectation = prepared.previousRecord
        ? { discovery: currentDiscovery, installerSha256: prepared.entry.sha256 }
        : { targetMustBeAbsent: true, installerSha256: prepared.entry.sha256 };
      await revalidateGitPlan(prepared.pin, identityExpectation);
      const signature = await windowsHost.verifyAuthenticode(prepared.installerPath);
      if (signature?.status !== "Valid") throw adapterError("git_authenticode_invalid");
      await revalidateGitPlan(prepared.pin, identityExpectation);
      const reservation = structuredClone(state);
      reservation.activeTask = {
        kind: "git-install", taskId, version: prepared.entry.version,
        targetDir: componentRoot(installRoot, "git"), executablePath: relativeFile(componentRoot(installRoot, "git"), prepared.entry.entrypoint),
        installerPath: prepared.installerPath, installerSha256: prepared.entry.sha256,
        replacedInstaller: prepared.previousRecord?.previousInstaller ?? null,
      };
      await saveState(reservation);
      await windowsHost.runGitInstaller({ installerPath: prepared.installerPath, targetDir: componentRoot(installRoot, "git") });
      const executablePath = relativeFile(componentRoot(installRoot, "git"), prepared.entry.entrypoint);
      await verifyGitVersion(executablePath, prepared.entry.version);
      const discovered = validateExternalGit(await windowsHost.discoverGit());
      if (discovered.installDir !== componentRoot(installRoot, "git") || discovered.executablePath !== executablePath) {
        throw adapterError("git_managed_registration_mismatch");
      }
      const installedPin = await pinGitPlan({ discovery: discovered, targetDir: discovered.installDir });
      try { await revalidateGitPlan(installedPin, { discovery: discovered }); } finally { await releaseGitPlan(installedPin); }
      const retained = await retainInstaller(prepared.pin, {
        path: prepared.installerPath, sha256: prepared.entry.sha256, version: prepared.entry.version,
      });
      const next = structuredClone(reservation);
      next.installRoot = installRoot;
      next.components.git = {
        managed: true, installPath: componentRoot(installRoot, "git"), version: prepared.entry.version,
        executablePath, uninstallerPath: discovered.uninstallerPath,
        currentInstaller: retained, previousInstaller: prepared.previousRecord?.currentInstaller ?? null,
      };
      next.activeTask = prepared.previousRecord?.previousInstaller ? {
        kind: "git-install-cleanup", taskId, targetDir: componentRoot(installRoot, "git"),
        executablePath, replacedInstaller: prepared.previousRecord.previousInstaller,
      } : null;
      next.lastTask = { taskId, componentId: "git", action: "install" };
      try { await saveState(next); } catch (error) {
        return result("git", "commit", "succeeded", {
          versionBefore: prepared.before, versionAfter: prepared.entry.version,
          message: `git_managed_committed_with_warning:${errorMessage(error)}`,
          rollbackAvailable: Boolean(next.components.git.previousInstaller),
        });
      }
      if (next.activeTask) {
        try { await finishGitInstallCleanup(next); } catch (error) {
          return result("git", "commit", "succeeded", {
            versionBefore: prepared.before, versionAfter: prepared.entry.version,
            message: `git_managed_committed_with_warning:${errorMessage(error)}`,
            rollbackAvailable: true,
          });
        }
      }
      return result("git", "commit", "succeeded", {
        versionBefore: prepared.before, versionAfter: prepared.entry.version,
        message: "git_managed_committed", rollbackAvailable: Boolean(next.components.git.previousInstaller),
      });
    } catch (error) {
      return failed("git", "commit", error, prepared?.before ?? null);
    } finally {
      if (prepared?.pin) await releaseGitPlan(prepared.pin).catch(() => {});
    }
  }

  async function verifyGit(rawContext) {
    try {
      rejectForbiddenContext(rawContext);
      const state = await recoverGitTransaction();
      const managed = managedRecord(state, "git");
      if (managed && state.activeTask !== null) throw adapterError("component_pending_transaction");
      if (managed) {
        await verifyGitVersion(managed.executablePath, managed.version);
        return result("git", "verify", "succeeded", {
          versionBefore: managed.version, versionAfter: managed.version,
          message: "git_verified", rollbackAvailable: Boolean(managed.previousInstaller),
        });
      }
      const external = validateExternalGit(await windowsHost.discoverGit());
      await verifyGitVersion(external.executablePath, external.version);
      return result("git", "verify", "succeeded", {
        versionBefore: external.version, versionAfter: external.version, message: "git_verified",
      });
    } catch (error) { return failed("git", "verify", error); }
  }

  async function uninstallGit(rawContext) {
    let pin = null;
    let before = null;
    try {
      const context = rejectForbiddenContext(rawContext);
      if (context.selected !== true) throw adapterError("git_explicit_selection_required");
      const state = await recoverGitTransaction();
      const managed = managedRecord(state, "git");
      if (state.activeTask !== null) throw adapterError("component_pending_transaction");
      const discovery = validateExternalGit(await windowsHost.discoverGit());
      if (managed && (discovery.installDir !== managed.installPath
        || discovery.executablePath !== managed.executablePath || discovery.uninstallerPath !== managed.uninstallerPath)) {
        throw adapterError("git_managed_registration_mismatch");
      }
      before = managed?.version ?? discovery.version;
      pin = await pinGitPlan({ discovery, targetDir: discovery.installDir });
      await revalidateGitPlan(pin, { discovery });
      const uninstallerSignature = await windowsHost.verifyAuthenticode(discovery.uninstallerPath);
      if (uninstallerSignature?.status !== "Valid") throw adapterError("git_uninstaller_authenticode_invalid");
      await revalidateGitPlan(pin, { discovery });
      let reserved = state;
      if (managed) {
        const taskId = requireTaskId(context.taskId);
        reserved = structuredClone(state);
        reserved.activeTask = {
          kind: "git-uninstall", taskId, targetDir: managed.installPath,
          executablePath: managed.executablePath,
        };
        await saveState(reserved);
      }
      await windowsHost.runGitUninstaller({ uninstallerPath: discovery.uninstallerPath, installDir: discovery.installDir });
      if (managed) {
        await deleteComponent({ componentId: "git", rootPath: managed.installPath, authorizedRoot: installRoot });
        const next = structuredClone(reserved);
        delete next.components.git;
        next.activeTask = null;
        next.lastTask = { taskId: reserved.activeTask.taskId, componentId: "git", action: "uninstall" };
        if (Object.keys(next.components).length === 0 && Object.keys(next.skills).length === 0) next.installRoot = null;
        try { await saveState(next); } catch (error) {
          return result("git", "uninstall", "succeeded", {
            versionBefore: before, versionAfter: null,
            message: `git_managed_uninstalled_with_warning:${errorMessage(error)}`,
          });
        }
      }
      return result("git", "uninstall", "succeeded", {
        versionBefore: before, versionAfter: null,
        message: managed ? "git_managed_uninstalled" : "git_external_uninstalled",
      });
    } catch (error) { return failed("git", "uninstall", error, before); }
    finally { if (pin) await releaseGitPlan(pin).catch(() => {}); }
  }

  async function rollbackGit(rawContext) {
    let pin = null;
    let targetPin = null;
    let before = null;
    try {
      const context = rejectForbiddenContext(rawContext);
      const taskId = requireTaskId(context.taskId);
      const state = await recoverGitTransaction();
      const managed = managedRecord(state, "git");
      if (!managed?.previousInstaller) throw adapterError("rollback_not_available");
      before = managed.version;
      const currentDiscovery = validateExternalGit(await windowsHost.discoverGit());
      if (!exactManagedGitDiscovery(currentDiscovery, managed) || currentDiscovery.version !== managed.version) {
        throw adapterError("git_managed_registration_mismatch");
      }
      targetPin = await pinGitPlan({ discovery: currentDiscovery, targetDir: managed.installPath });
      await revalidateGitPlan(targetPin, { discovery: currentDiscovery });
      const uninstallerSignature = await windowsHost.verifyAuthenticode(currentDiscovery.uninstallerPath);
      if (uninstallerSignature?.status !== "Valid") throw adapterError("git_uninstaller_authenticode_invalid");
      await revalidateGitPlan(targetPin, { discovery: currentDiscovery });
      pin = await pinRetainedInstaller(managed.previousInstaller);
      await revalidateGitPlan(pin, { installerSha256: managed.previousInstaller.sha256 });
      const signature = await windowsHost.verifyAuthenticode(managed.previousInstaller.path);
      if (signature?.status !== "Valid") throw adapterError("git_authenticode_invalid");
      await revalidateGitPlan(pin, { installerSha256: managed.previousInstaller.sha256 });
      const reservation = structuredClone(state);
      reservation.activeTask = {
        kind: "git-rollback", taskId, targetDir: managed.installPath,
        executablePath: managed.executablePath, version: managed.previousInstaller.version,
        installerPath: managed.previousInstaller.path, installerSha256: managed.previousInstaller.sha256,
        rejectedInstaller: managed.currentInstaller,
      };
      await saveState(reservation);
      await windowsHost.runGitUninstaller({
        uninstallerPath: currentDiscovery.uninstallerPath, installDir: currentDiscovery.installDir,
      });
      await releaseGitPlan(targetPin);
      targetPin = null;
      await revalidateGitPlan(pin, { installerSha256: managed.previousInstaller.sha256 });
      await windowsHost.runGitInstaller({ installerPath: managed.previousInstaller.path, targetDir: managed.installPath });
      await verifyGitVersion(managed.executablePath, managed.previousInstaller.version);
      const restoredDiscovery = validateExternalGit(await windowsHost.discoverGit());
      if (restoredDiscovery.installDir !== managed.installPath || restoredDiscovery.executablePath !== managed.executablePath) {
        throw adapterError("git_managed_registration_mismatch");
      }
      const restoredPin = await pinGitPlan({ discovery: restoredDiscovery, targetDir: managed.installPath });
      try { await revalidateGitPlan(restoredPin, { discovery: restoredDiscovery }); } finally { await releaseGitPlan(restoredPin); }
      const next = structuredClone(reservation);
      next.components.git = {
        ...managed, version: managed.previousInstaller.version,
        currentInstaller: managed.previousInstaller, previousInstaller: null,
        uninstallerPath: restoredDiscovery.uninstallerPath,
      };
      next.activeTask = {
        kind: "git-rollback-cleanup", taskId, targetDir: managed.installPath,
        executablePath: managed.executablePath, rejectedInstaller: managed.currentInstaller,
      };
      try { await saveState(next); } catch (error) {
        return result("git", "rollback", "succeeded", {
          versionBefore: before, versionAfter: managed.previousInstaller.version,
          message: `git_managed_rolled_back_with_warning:${errorMessage(error)}`, rollbackAvailable: false,
        });
      }
      try { await finishGitRollbackCleanup(next); } catch (error) {
        return result("git", "rollback", "succeeded", {
          versionBefore: before, versionAfter: managed.previousInstaller.version,
          message: `git_managed_rolled_back_with_warning:${errorMessage(error)}`, rollbackAvailable: false,
        });
      }
      return result("git", "rollback", "succeeded", {
        versionBefore: before, versionAfter: next.components.git.version,
        message: "git_managed_rolled_back", rollbackAvailable: false,
      });
    } catch (error) { return failed("git", "rollback", error, before); }
    finally {
      if (targetPin) await releaseGitPlan(targetPin).catch(() => {});
      if (pin) await releaseGitPlan(pin).catch(() => {});
    }
  }

  async function prepareSkills(rawContext) {
    let context;
    try { context = rejectForbiddenContext(rawContext); requireTaskId(context.taskId); }
    catch (error) { return [await failed("skills", "prepare", error)]; }
    const taskId = context.taskId;
    const ids = Array.isArray(context.skillIds) ? context.skillIds : [];
    const pending = new Map();
    preparedSkills.set(taskId, pending);
    const results = [];
    for (const id of ids) {
      try {
        await recoverSkillTransaction();
        const entry = trustedSkill(id);
        const destination = path.win32.join(installRoot, "staging", "skills", taskId, entry.id);
        const archivePath = path.win32.join(installRoot, "downloads", `skill-${entry.id}-${entry.version}.zip`);
        const downloaded = await download({
          asset: { url: entry.assetUrl, size: entry.size, sha256: entry.sha256 }, destination: archivePath,
          signal: context.signal, onProgress: typeof context.onProgress === "function" ? context.onProgress : () => {},
        });
        if (!isRecord(downloaded) || downloaded.path !== archivePath
          || downloaded.size !== entry.size || downloaded.sha256 !== entry.sha256) {
          throw adapterError("component_download_evidence_invalid");
        }
        await extractArchive({ format: "zip", archivePath, destination, signal: context.signal });
        const verified = await verifyPreparedSkill({
          rootPath: destination, requiredFiles: entry.files.map((file) => relativeFile(destination, file)),
          expectedPackageSha256: entry.sha256,
        });
        const receipt = validateReceipt(verified, "skill_verification_receipt_invalid");
        if (!SHA256.test(verified.skillMdSha256 ?? "")) throw adapterError("skill_md_hash_invalid");
        pending.set(id, Object.freeze({ entry, destination, skillMdSha256: verified.skillMdSha256, ...receipt }));
        results.push(result(id, "prepare", "succeeded", { versionAfter: entry.version, message: "skill_prepared" }));
      } catch (error) { results.push(await failed(typeof id === "string" ? id : "skills", "prepare", error)); }
    }
    return results;
  }

  async function commitSkills(rawContext) {
    let context;
    try { context = rejectForbiddenContext(rawContext); requireTaskId(context.taskId); }
    catch (error) { return [await failed("skills", "commit", error)]; }
    const pending = preparedSkills.get(context.taskId);
    if (!pending) return [await failed("skills", "commit", adapterError("component_not_prepared"))];
    preparedSkills.delete(context.taskId);
    const results = [];
    for (const id of Array.isArray(context.skillIds) ? context.skillIds : []) {
      const prepared = pending.get(id);
      try {
        if (!prepared) throw adapterError("skill_not_prepared");
        let state = await recoverSkillTransaction();
        assertStateForManaged(state);
        if (state.activeTask !== null) throw adapterError("component_pending_transaction");
        const target = await resolveSkillTarget({
          skillsRoot, skillId: id, realpath: skillPathAccess.realpath, lstat: skillPathAccess.lstat,
        });
        if (target !== path.win32.join(skillsRoot, id)) throw adapterError("skill_target_mismatch");
        const before = stateSkillVersion(state, id);
        const previousRaw = await inspectSkillExact({ target, authorizedRoot: skillsRoot });
        const previousEvidence = previousRaw?.kind === "absent"
          ? validatePreviousSkillEvidence(previousRaw)
          : validateSkillTreeEvidence(previousRaw, "skill_previous_evidence_invalid");
        const reserved = structuredClone(state);
        reserved.activeTask = {
          kind: "skill-replace", phase: "reserved", taskId: context.taskId, skillId: id, skillsRoot, target,
          version: prepared.entry.version, packageSha256: prepared.entry.sha256,
          skillMdSha256: prepared.skillMdSha256, treeDigest: prepared.treeDigest,
          manifestDigest: prepared.manifestDigest, previousEvidence,
        };
        await saveState(reserved);
        const replacement = await replaceSkillExact({
          source: prepared.destination, target, authorizedRoot: skillsRoot, backup: false,
          verificationReceipt: prepared.verificationReceipt,
          treeDigest: prepared.treeDigest, manifestDigest: prepared.manifestDigest,
          skillMdSha256: prepared.skillMdSha256, requiredFiles: prepared.entry.files,
        });
        if (!isRecord(replacement) || replacement.completionReceipt === undefined) {
          throw adapterError("skill_completion_receipt_invalid");
        }
        const completed = await finalizeSkillReplacement({
          completionReceipt: replacement.completionReceipt, target, taskId: context.taskId,
          expected: {
            treeDigest: prepared.treeDigest, manifestDigest: prepared.manifestDigest,
            skillMdSha256: prepared.skillMdSha256,
          },
        });
        if (!isRecord(completed) || completed.completionProof === undefined) {
          throw adapterError("skill_completion_evidence_invalid");
        }
        const appliedEvidence = validateSkillTreeEvidence(completed.evidence, "skill_completion_evidence_invalid");
        if (!skillEvidenceMatchesExpected(appliedEvidence, reserved.activeTask)) {
          throw adapterError("skill_completion_evidence_invalid");
        }
        const applied = structuredClone(reserved);
        applied.activeTask = {
          ...applied.activeTask, phase: "applied",
          completionProof: completed.completionProof, appliedEvidence,
        };
        try { await saveState(applied); } catch (error) {
          results.push(result(id, "commit", "succeeded", {
            versionBefore: before, versionAfter: prepared.entry.version,
            message: `skill_application_pending_warning:${errorMessage(error)}`,
          }));
          continue;
        }
        const adopted = structuredClone(applied);
        adopted.installRoot ??= installRoot;
        adopted.skills[id] = {
          target, version: prepared.entry.version, packageSha256: prepared.entry.sha256,
          skillMdSha256: prepared.skillMdSha256, identity: appliedEvidence.identity,
          treeDigest: appliedEvidence.treeDigest, manifestDigest: appliedEvidence.manifestDigest,
        };
        adopted.activeTask = null;
        adopted.lastTask = { taskId: context.taskId, componentId: id, action: "skill-replace" };
        try { await saveState(adopted); } catch (error) {
          results.push(result(id, "commit", "succeeded", {
            versionBefore: before, versionAfter: prepared.entry.version,
            message: `skill_adoption_pending_warning:${errorMessage(error)}`,
          }));
          continue;
        }
        results.push(result(id, "commit", "succeeded", {
          versionBefore: before, versionAfter: prepared.entry.version, message: "skill_replaced",
        }));
      } catch (error) { results.push(await failed(id, "commit", error)); }
    }
    return results;
  }

  async function inspectSkills(rawContext) {
    try {
      const context = rejectForbiddenContext(rawContext);
      const state = await recoverSkillTransaction();
      const ids = Array.isArray(context.skillIds) ? context.skillIds : Object.keys(state.skills);
      return ids.map((id) => {
        const version = stateSkillVersion(state, id);
        return version === null
          ? result(id, "inspect", "skipped", { message: "skill_not_installed" })
          : result(id, "inspect", "succeeded", {
            versionBefore: version, versionAfter: version, message: "skill_installed",
          });
      });
    } catch (error) { return [await failed("skills", "inspect", error)]; }
  }

  async function verifySkills(rawContext) {
    let context;
    try { context = rejectForbiddenContext(rawContext); } catch (error) { return [await failed("skills", "verify", error)]; }
    const results = [];
    for (const id of Array.isArray(context.skillIds) ? context.skillIds : []) {
      try {
        const state = await recoverSkillTransaction();
        if (state.activeTask !== null) throw adapterError("component_pending_transaction");
        const record = state.skills[id];
        if (!record) throw adapterError("skill_not_installed");
        const target = await resolveSkillTarget({ skillsRoot, skillId: id, ...skillPathAccess });
        if (target !== record.target) throw adapterError("skill_target_mismatch");
        if (await hashSkillFile(path.win32.join(target, "SKILL.md")) !== record.skillMdSha256) {
          throw adapterError("skill_md_hash_mismatch");
        }
        results.push(result(id, "verify", "succeeded", {
          versionBefore: record.version, versionAfter: record.version, message: "skill_verified",
        }));
      } catch (error) { results.push(await failed(id, "verify", error)); }
    }
    return results;
  }

  async function uninstallSkills(rawContext) {
    let context;
    try { context = rejectForbiddenContext(rawContext); } catch (error) { return [await failed("skills", "uninstall", error)]; }
    const results = [];
    for (const id of Array.isArray(context.skillIds) ? context.skillIds : []) {
      try {
        const state = await recoverSkillTransaction();
        if (state.activeTask !== null) throw adapterError("component_pending_transaction");
        const record = state.skills[id];
        if (!record) { results.push(result(id, "uninstall", "skipped", { message: "skill_not_installed" })); continue; }
        const target = await resolveSkillTarget({ skillsRoot, skillId: id, ...skillPathAccess });
        if (target !== record.target || target !== path.win32.join(skillsRoot, id)) throw adapterError("skill_target_mismatch");
        const reserved = structuredClone(state);
        reserved.activeTask = { kind: "skill-uninstall", taskId: `uninstall-${id}`, skillId: id, skillsRoot, target };
        await saveState(reserved);
        await deleteSkillExact({ target, authorizedRoot: skillsRoot });
        const next = structuredClone(reserved);
        delete next.skills[id]; next.activeTask = null;
        await saveState(next).catch(() => {});
        results.push(result(id, "uninstall", "succeeded", {
          versionBefore: record.version, versionAfter: null, message: "skill_uninstalled",
        }));
      } catch (error) { results.push(await failed(id, "uninstall", error)); }
    }
    return results;
  }

  const coordinated = (operation, authorities) => (...args) => ownershipCoordinator.runExclusive(async () => {
    if (authorities.install) await revalidateInstallRootCapability(installRootCapability);
    if (authorities.desktop) await revalidateFixedDirectoryCapability(desktopCapability);
    if (authorities.skills) await revalidateFixedDirectoryCapability(skillsRootCapability);
    return operation(...args);
  });
  const coordinatedArchiveAdapter = (componentId) => {
    const adapter = archiveAdapter(componentId);
    return Object.freeze(Object.fromEntries(Object.entries(adapter).map(([name, operation]) => [
      name, coordinated(operation, { install: true, desktop: true, skills: false }),
    ])));
  };

  return Object.freeze({
    chatgpt: coordinatedArchiveAdapter("chatgpt"),
    v2rayn: coordinatedArchiveAdapter("v2rayn"),
    git: Object.freeze({
      inspectInstalled: coordinated(inspectGit, { install: true }), prepare: coordinated(prepareGit, { install: true }),
      commit: coordinated(commitGit, { install: true }), verify: coordinated(verifyGit, { install: true }),
      uninstall: coordinated(uninstallGit, { install: true }), rollback: coordinated(rollbackGit, { install: true }),
    }),
    skills: Object.freeze({
      inspectInstalled: coordinated(inspectSkills, { skills: true }), prepare: coordinated(prepareSkills, { skills: true }),
      commit: coordinated(commitSkills, { skills: true }), verify: coordinated(verifySkills, { skills: true }),
      uninstall: coordinated(uninstallSkills, { skills: true }),
      rollback: coordinated(async (context) => {
        try { rejectForbiddenContext(context); } catch (error) { return [await failed("skills", "rollback", error)]; }
        return (Array.isArray(context?.skillIds) ? context.skillIds : []).map((id) => result(
          id, "rollback", "skipped", { message: "skill_rollback_not_supported" },
        ));
      }, { skills: true }),
    }),
  });
}
