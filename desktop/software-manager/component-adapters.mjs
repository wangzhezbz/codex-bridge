import path from "node:path";

import {
  resolveCatalogAssetUrl,
  TEST_CATALOG_ORIGIN,
  TEST_CATALOG_PATH,
} from "../../shared/software-manager/catalog-schema.mjs";

const COMPONENTS = Object.freeze({
  chatgpt: Object.freeze({ rootName: "ChatGPT", current: "c", staging: "ct", shortcut: "ChatGPT" }),
  v2rayn: Object.freeze({ rootName: "V2RayN", current: "current", staging: "staging", shortcut: "V2RayN" }),
  git: Object.freeze({ rootName: "Git", current: "current", staging: "staging", shortcut: null }),
});
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RESULT_KEYS = Object.freeze([
  "componentId", "action", "status", "versionBefore", "versionAfter", "message", "rollbackAvailable",
]);

function adapterError(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function result(componentId, action, status, {
  versionBefore = null,
  versionAfter = null,
  message,
  rollbackAvailable = false,
} = {}) {
  const value = {
    componentId,
    action,
    status,
    versionBefore,
    versionAfter,
    message: message ?? `${componentId}_${action}_${status}`,
    rollbackAvailable: Boolean(rollbackAvailable),
  };
  if (Object.keys(value).length !== RESULT_KEYS.length) throw adapterError("component_result_invalid");
  return Object.freeze(value);
}

function failure(componentId, action, error, versionBefore = null) {
  return result(componentId, action, "failed", {
    versionBefore,
    versionAfter: versionBefore,
    message: typeof error?.code === "string" ? error.code : "component_operation_failed",
  });
}

function requireMethod(owner, name, code) {
  if (typeof owner?.[name] !== "function") throw adapterError(code);
  return owner[name].bind(owner);
}

function requireTaskId(value) {
  if (typeof value !== "string" || !TASK_ID.test(value)) throw adapterError("component_task_id_invalid");
  return value;
}

function requireWindowsAbsolute(value, code) {
  if (typeof value !== "string" || value.length === 0 || value !== path.win32.normalize(value)
    || !/^[A-Za-z]:\\/u.test(value) || value.startsWith("\\\\") || value.includes("\0")) {
    throw adapterError(code);
  }
  const root = path.win32.parse(value).root;
  if (value.toLowerCase() === root.toLowerCase()) throw adapterError(code);
  const segments = value.slice(root.length).split("\\");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw adapterError(code);
  return value;
}

function requireInstallRoot(value) {
  return requireWindowsAbsolute(value, "component_install_root_invalid");
}

function componentRoot(installRoot, componentId) {
  return path.win32.join(requireInstallRoot(installRoot), COMPONENTS[componentId].rootName);
}

function slotPath(installRoot, componentId, slot) {
  return path.win32.join(componentRoot(installRoot, componentId), COMPONENTS[componentId][slot]);
}

function componentEntrypoint(installRoot, componentId, component, slot = "current") {
  return path.win32.join(slotPath(installRoot, componentId, slot), ...component.entrypoint.split("/"));
}

function catalogComponent(catalog, componentId) {
  if (!isPlainRecord(catalog) || catalog.schemaVersion !== 1 || !Array.isArray(catalog.components)) {
    throw adapterError("component_catalog_invalid");
  }
  const matches = catalog.components.filter((value) => value?.id === componentId);
  if (matches.length !== 1 || !isPlainRecord(matches[0])) throw adapterError("component_catalog_entry_missing");
  const value = matches[0];
  const expectedFormat = { chatgpt: "zip", v2rayn: "7z", git: "exe" }[componentId];
  if (typeof value.version !== "string" || typeof value.format !== "string"
    || value.format !== expectedFormat
    || typeof value.assetUrl !== "string" || !Number.isSafeInteger(value.size) || value.size <= 0
    || !SHA256.test(value.sha256 ?? "") || !isSafeCatalogPath(value.entrypoint)
    || !Array.isArray(value.requiredFiles) || !value.requiredFiles.every(isSafeCatalogPath)
    || !value.requiredFiles.includes(value.entrypoint)) {
    throw adapterError("component_catalog_entry_invalid");
  }
  return value;
}

function catalogSkill(catalog, skillId) {
  if (!SKILL_ID.test(skillId ?? "") || !isPlainRecord(catalog) || catalog.schemaVersion !== 1
    || !Array.isArray(catalog.skills)) throw adapterError("skill_catalog_invalid");
  const matches = catalog.skills.filter((value) => value?.id === skillId);
  if (matches.length !== 1 || !isPlainRecord(matches[0])) throw adapterError("skill_not_in_signed_catalog");
  const value = matches[0];
  if (typeof value.version !== "string" || typeof value.assetUrl !== "string"
    || !Number.isSafeInteger(value.size) || value.size <= 0 || !SHA256.test(value.sha256 ?? "")
    || !Array.isArray(value.files) || !value.files.every(isSafeCatalogPath) || !value.files.includes("SKILL.md")) {
    throw adapterError("skill_catalog_entry_invalid");
  }
  return value;
}

function downloadAsset(item) {
  return Object.freeze({
    url: resolveCatalogAssetUrl(`${TEST_CATALOG_ORIGIN}${TEST_CATALOG_PATH}`, item.assetUrl),
    size: item.size,
    sha256: item.sha256,
  });
}

function isSafeCatalogPath(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.startsWith("/")
    && value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function extensionFor(format) {
  if (format === "zip" || format === "7z" || format === "exe") return format;
  throw adapterError("component_format_rejected");
}

function installedVersion(state, componentId) {
  const value = state?.components?.[componentId];
  return typeof value?.version === "string" ? value.version : null;
}

function rollbackRecords(state) {
  if (state?.rollback === null || state?.rollback === undefined) return [];
  return Array.isArray(state.rollback) ? state.rollback : [state.rollback];
}

function rollbackAvailable(state, componentId) {
  return rollbackRecords(state).some((record) => record?.componentId === componentId);
}

function removeRollback(state, componentId) {
  const records = rollbackRecords(state).filter((record) => record?.componentId !== componentId);
  return records.length === 0 ? null : records;
}

function assertStateRoot(state, installRoot) {
  if (!isPlainRecord(state) || !isPlainRecord(state.components) || !isPlainRecord(state.skills)
    || !Array.isArray(state.shortcuts)) throw adapterError("component_ownership_state_invalid");
  if (state.installRoot !== installRoot) throw adapterError("component_install_root_not_owned");
}

async function ensureStateRoot(ownershipStore, installRoot) {
  const state = await ownershipStore.load();
  if (!isPlainRecord(state)) throw adapterError("component_ownership_state_invalid");
  if (state.installRoot === null) {
    const next = structuredClone(state);
    next.installRoot = installRoot;
    await ownershipStore.save(next);
    return next;
  }
  assertStateRoot(state, installRoot);
  return state;
}

function assertManagedRecord(state, installRoot, componentId) {
  assertStateRoot(state, installRoot);
  const record = state.components[componentId];
  if (record === undefined) return null;
  const expected = slotPath(installRoot, componentId, "current");
  if (!isPlainRecord(record) || record.managed !== true || record.installPath !== expected
    || typeof record.version !== "string") throw adapterError("component_owned_record_invalid");
  return record;
}

function assertReceipt(value) {
  if (!isPlainRecord(value) || value.verificationReceipt === null
    || typeof value.verificationReceipt !== "object" || !SHA256.test(value.treeDigest ?? "")
    || !SHA256.test(value.manifestDigest ?? "")) {
    throw adapterError("component_verification_receipt_invalid");
  }
  return {
    verificationReceipt: value.verificationReceipt,
    treeDigest: value.treeDigest,
    manifestDigest: value.manifestDigest,
  };
}

function exactVersionUnchanged(state, componentId, expected) {
  return installedVersion(state, componentId) === expected;
}

function normalizeStopped(value) {
  if (!isPlainRecord(value) || !Array.isArray(value.stoppedProcessIds)
    || value.stoppedProcessIds.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) {
    throw adapterError("component_stop_result_invalid");
  }
  return value.stoppedProcessIds.length > 0;
}

function withoutComponentShortcuts(state, componentId) {
  return state.shortcuts.filter((record) => record?.componentId !== componentId);
}

export function createComponentAdapters({
  downloader,
  archiveService,
  versionSlots,
  ownershipStore,
  windowsHost,
  componentFiles,
  skillFiles,
  resolveSkillTarget,
  skillPathAccess = {},
} = {}) {
  const download = requireMethod(downloader, "download", "component_downloader_required");
  const extractArchive = requireMethod(archiveService, "extractArchive", "component_archive_required");
  const promotePreparedVersion = requireMethod(versionSlots, "promotePreparedVersion", "component_slots_required");
  const rollbackVersion = requireMethod(versionSlots, "rollbackVersion", "component_slots_required");
  const loadState = requireMethod(ownershipStore, "load", "component_ownership_store_required");
  const saveState = requireMethod(ownershipStore, "save", "component_ownership_store_required");
  const verifyComponent = requireMethod(componentFiles, "verifyComponent", "component_file_verifier_required");
  const verifyGitVersion = requireMethod(componentFiles, "verifyGitVersion", "git_version_verifier_required");
  const verifyPreparedGit = requireMethod(componentFiles, "verifyPreparedGit", "git_prepared_verifier_required");
  const deleteComponent = requireMethod(componentFiles, "deleteComponent", "component_delete_capability_required");
  const preparePersistentDirectory = requireMethod(
    componentFiles, "preparePersistentDirectory", "persistent_directory_capability_required",
  );
  const verifyPersistentDirectory = requireMethod(
    componentFiles, "verifyPersistentDirectory", "persistent_directory_capability_required",
  );
  const hashSkillFile = requireMethod(skillFiles, "hashFile", "skill_hash_capability_required");
  const verifyPreparedSkill = requireMethod(skillFiles, "verifyPreparedSkill", "skill_verify_capability_required");
  const replaceSkillExact = requireMethod(skillFiles, "replaceExact", "skill_replace_capability_required");
  const deleteSkillExact = requireMethod(skillFiles, "deleteExact", "skill_delete_capability_required");
  if (typeof resolveSkillTarget !== "function") throw adapterError("skill_path_resolver_required");

  const preparedComponents = new Map();
  const preparedSkills = new Map();

  async function prepareArchiveComponent(componentId, context) {
    const action = "prepare";
    let before = null;
    try {
      const taskId = requireTaskId(context?.taskId);
      const installRoot = requireInstallRoot(context?.installRoot);
      const state = await ensureStateRoot(ownershipStore, installRoot);
      const owned = assertManagedRecord(state, installRoot, componentId);
      before = owned?.version ?? null;
      const item = catalogComponent(context.catalog, componentId);
      const rootPath = componentRoot(installRoot, componentId);
      const destination = slotPath(installRoot, componentId, "staging");
      const persistentConfig = componentId === "v2rayn"
        ? await preparePersistentDirectory({
          componentId,
          rootPath: path.win32.join(installRoot, "V2RayN-Data"),
        })
        : null;
      const archivePath = path.win32.join(
        installRoot, "downloads", `${componentId}-${item.version}.${extensionFor(item.format)}`,
      );
      const downloaded = await download({
        asset: downloadAsset(item), destination: archivePath, signal: context.signal,
        onProgress: typeof context.onProgress === "function" ? context.onProgress : () => {},
      });
      if (!isPlainRecord(downloaded) || downloaded.path !== archivePath
        || downloaded.size !== item.size || downloaded.sha256 !== item.sha256) {
        throw adapterError("component_download_evidence_invalid");
      }
      const extracted = await extractArchive({
        format: item.format,
        archivePath,
        destination,
        signal: context.signal,
        verification: { componentId, version: item.version },
      });
      const receipt = assertReceipt(extracted);
      await verifyComponent({
        rootPath: destination,
        entrypointPath: componentEntrypoint(installRoot, componentId, item, "staging"),
        requiredFiles: item.requiredFiles.map((file) => path.win32.join(destination, ...file.split("/"))),
        expectedVersion: item.version,
        expectedPackageSha256: item.sha256,
      });
      preparedComponents.set(`${componentId}\0${taskId}`, Object.freeze({
        componentId, taskId, installRoot, rootPath, item, before, persistentConfig, ...receipt,
      }));
      return result(componentId, action, "succeeded", {
        versionBefore: before, versionAfter: item.version, message: "component_prepared",
        rollbackAvailable: rollbackAvailable(state, componentId),
      });
    } catch (error) {
      return failure(componentId, action, error, before);
    }
  }

  async function commitArchiveComponent(componentId, context) {
    const action = "commit";
    let before = null;
    try {
      const taskId = requireTaskId(context?.taskId);
      const key = `${componentId}\0${taskId}`;
      const prepared = preparedComponents.get(key);
      if (!prepared) throw adapterError("component_not_prepared");
      preparedComponents.delete(key);
      before = prepared.before;
      const state = await loadState();
      const owned = assertManagedRecord(state, prepared.installRoot, componentId);
      if (!exactVersionUnchanged(state, componentId, before)) throw adapterError("component_state_changed");
      if (componentId === "v2rayn") {
        await verifyPersistentDirectory({
          componentId,
          rootPath: path.win32.join(prepared.installRoot, "V2RayN-Data"),
          evidence: prepared.persistentConfig,
        });
      }
      const wasRunning = owned === null ? false : normalizeStopped(await windowsHost.stopOwnedProcesses([
        componentEntrypoint(prepared.installRoot, componentId, prepared.item),
      ]));
      const promoted = await promotePreparedVersion({
        taskId,
        componentId,
        rootPath: prepared.rootPath,
        version: prepared.item.version,
        verificationReceipt: prepared.verificationReceipt,
        treeDigest: prepared.treeDigest,
        manifestDigest: prepared.manifestDigest,
      });
      if (!isPlainRecord(promoted) || promoted.componentId !== componentId
        || promoted.version !== prepared.item.version) throw adapterError("component_promotion_result_invalid");
      const finalEntrypoint = componentEntrypoint(prepared.installRoot, componentId, prepared.item);
      await verifyComponent({
        rootPath: slotPath(prepared.installRoot, componentId, "current"),
        entrypointPath: finalEntrypoint,
        requiredFiles: prepared.item.requiredFiles.map((file) => path.win32.join(
          slotPath(prepared.installRoot, componentId, "current"), ...file.split("/"),
        )),
        expectedVersion: prepared.item.version,
        expectedPackageSha256: prepared.item.sha256,
      });
      if (componentId === "v2rayn") {
        await verifyPersistentDirectory({
          componentId,
          rootPath: path.win32.join(prepared.installRoot, "V2RayN-Data"),
          evidence: prepared.persistentConfig,
        });
      }

      let next = await loadState();
      const current = assertManagedRecord(next, prepared.installRoot, componentId);
      next = structuredClone(next);
      next.components[componentId] = {
        ...current,
        packageSha256: prepared.item.sha256,
        entrypoint: prepared.item.entrypoint,
        requiredFiles: [...prepared.item.requiredFiles],
        ...(componentId === "v2rayn"
          ? { configRoot: path.win32.join(prepared.installRoot, "V2RayN-Data") }
          : {}),
      };
      if (COMPONENTS[componentId].shortcut !== null) {
        let shortcut = next.shortcuts.find((record) => record?.componentId === componentId);
        if (!shortcut) {
          const desktopPath = requireWindowsAbsolute(context?.desktopPath, "shortcut_desktop_invalid");
          shortcut = await windowsHost.createShortcut({
            name: COMPONENTS[componentId].shortcut,
            desktopPath,
            targetPath: finalEntrypoint,
          });
          if (!isPlainRecord(shortcut) || shortcut.targetPath !== finalEntrypoint) {
            throw adapterError("shortcut_result_invalid");
          }
          next.shortcuts.push({ ...shortcut, componentId });
        }
      }
      await saveState(next);
      if (wasRunning) await windowsHost.launchOwned(finalEntrypoint);
      return result(componentId, action, "succeeded", {
        versionBefore: before,
        versionAfter: prepared.item.version,
        message: "component_committed",
        rollbackAvailable: Boolean(promoted.rollbackAvailable),
      });
    } catch (error) {
      return failure(componentId, action, error, before);
    }
  }

  async function inspectManaged(componentId, context) {
    const action = "inspect";
    try {
      const installRoot = requireInstallRoot(context?.installRoot);
      const state = await loadState();
      if (state?.installRoot === null) {
        return result(componentId, action, "skipped", { message: "component_not_installed" });
      }
      assertStateRoot(state, installRoot);
      const owned = assertManagedRecord(state, installRoot, componentId);
      if (!owned) return result(componentId, action, "skipped", { message: "component_not_installed" });
      return result(componentId, action, "succeeded", {
        versionBefore: owned.version, versionAfter: owned.version, message: "component_installed",
        rollbackAvailable: rollbackAvailable(state, componentId),
      });
    } catch (error) {
      return failure(componentId, action, error);
    }
  }

  async function verifyManaged(componentId, context) {
    const action = "verify";
    let before = null;
    try {
      const installRoot = requireInstallRoot(context?.installRoot);
      const state = await loadState();
      if (state?.installRoot === null) {
        return result(componentId, action, "skipped", { message: "component_not_installed" });
      }
      const record = assertManagedRecord(state, installRoot, componentId);
      if (!record) throw adapterError("component_not_installed");
      before = record.version;
      const item = catalogComponent(context.catalog, componentId);
      if (item.version !== record.version) throw adapterError("component_catalog_version_mismatch");
      await verifyComponent({
        rootPath: slotPath(installRoot, componentId, "current"),
        entrypointPath: componentEntrypoint(installRoot, componentId, item),
        requiredFiles: item.requiredFiles.map((file) => path.win32.join(
          slotPath(installRoot, componentId, "current"), ...file.split("/"),
        )),
        expectedVersion: item.version,
        expectedPackageSha256: record.packageSha256,
      });
      return result(componentId, action, "succeeded", {
        versionBefore: before, versionAfter: before, message: "component_verified",
        rollbackAvailable: rollbackAvailable(state, componentId),
      });
    } catch (error) {
      return failure(componentId, action, error, before);
    }
  }

  async function uninstallManaged(componentId, context) {
    const action = "uninstall";
    let before = null;
    try {
      const installRoot = requireInstallRoot(context?.installRoot);
      const state = await loadState();
      const record = assertManagedRecord(state, installRoot, componentId);
      if (!record) return result(componentId, action, "skipped", { message: "component_not_installed" });
      before = record.version;
      const item = context?.catalog ? catalogComponent(context.catalog, componentId) : null;
      const entrypoint = item?.entrypoint ?? record.entrypoint;
      if (typeof entrypoint !== "string") throw adapterError("component_entrypoint_missing");
      await windowsHost.stopOwnedProcesses([
        path.win32.join(slotPath(installRoot, componentId, "current"), ...entrypoint.split("/")),
      ]);
      const componentShortcuts = state.shortcuts.filter((shortcut) => shortcut?.componentId === componentId);
      for (const shortcut of componentShortcuts) await windowsHost.removeRecordedShortcut(shortcut);
      await deleteComponent({
        componentId,
        rootPath: componentRoot(installRoot, componentId),
        authorizedRoot: installRoot,
      });
      const next = structuredClone(await loadState());
      assertStateRoot(next, installRoot);
      delete next.components[componentId];
      next.shortcuts = withoutComponentShortcuts(next, componentId);
      next.rollback = removeRollback(next, componentId);
      await saveState(next);
      return result(componentId, action, "succeeded", {
        versionBefore: before, versionAfter: null, message: "component_uninstalled",
      });
    } catch (error) {
      return failure(componentId, action, error, before);
    }
  }

  async function rollbackManaged(componentId, context) {
    const action = "rollback";
    let before = null;
    try {
      const installRoot = requireInstallRoot(context?.installRoot);
      const state = await loadState();
      const record = assertManagedRecord(state, installRoot, componentId);
      if (!record) throw adapterError("component_not_installed");
      before = record.version;
      const item = context?.catalog ? catalogComponent(context.catalog, componentId) : null;
      const wasRunning = item ? normalizeStopped(await windowsHost.stopOwnedProcesses([
        componentEntrypoint(installRoot, componentId, item),
      ])) : false;
      const rolledBack = await rollbackVersion(componentId);
      if (!isPlainRecord(rolledBack) || rolledBack.componentId !== componentId
        || typeof rolledBack.version !== "string") throw adapterError("component_rollback_result_invalid");
      if (componentId === "git") {
        const entrypoint = item?.entrypoint ?? record.entrypoint;
        if (typeof entrypoint !== "string") throw adapterError("component_entrypoint_missing");
        await verifyGitVersion(
          path.win32.join(slotPath(installRoot, componentId, "current"), ...entrypoint.split("/")),
          rolledBack.version,
        );
      } else if (item) {
        const finalEntrypoint = componentEntrypoint(installRoot, componentId, item);
        await verifyComponent({
          rootPath: slotPath(installRoot, componentId, "current"), entrypointPath: finalEntrypoint,
          requiredFiles: item.requiredFiles.map((file) => path.win32.join(
            slotPath(installRoot, componentId, "current"), ...file.split("/"),
          )),
          expectedVersion: rolledBack.version,
        });
        if (wasRunning) await windowsHost.launchOwned(finalEntrypoint);
      }
      return result(componentId, action, "succeeded", {
        versionBefore: before, versionAfter: rolledBack.version,
        message: "component_rolled_back", rollbackAvailable: false,
      });
    } catch (error) {
      return failure(componentId, action, error, before);
    }
  }

  function createArchiveAdapter(componentId) {
    return Object.freeze({
      inspectInstalled: (context) => inspectManaged(componentId, context),
      prepare: (context) => prepareArchiveComponent(componentId, context),
      commit: (context) => commitArchiveComponent(componentId, context),
      verify: (context) => verifyManaged(componentId, context),
      uninstall: (context) => uninstallManaged(componentId, context),
      rollback: (context) => rollbackManaged(componentId, context),
    });
  }

  async function inspectGit(context) {
    const action = "inspect";
    try {
      const installRoot = requireInstallRoot(context?.installRoot);
      const state = await loadState();
      if (state?.installRoot === null) {
        return result("git", action, "skipped", { message: "git_not_installed" });
      }
      assertStateRoot(state, installRoot);
      const managed = assertManagedRecord(state, installRoot, "git");
      if (managed) return result("git", action, "succeeded", {
        versionBefore: managed.version, versionAfter: managed.version, message: "git_managed_installed",
        rollbackAvailable: rollbackAvailable(state, "git"),
      });
      const discovered = await windowsHost.discoverGit();
      if (discovered?.kind === "none") return result("git", action, "skipped", { message: "git_not_installed" });
      if (discovered?.kind !== "external" || discovered.ownership !== "external") {
        throw adapterError("git_discovery_invalid");
      }
      return result("git", action, "succeeded", {
        versionBefore: discovered.version, versionAfter: discovered.version, message: "git_external_installed",
      });
    } catch (error) {
      return failure("git", action, error);
    }
  }

  async function prepareGit(context) {
    const action = "prepare";
    let before = null;
    try {
      if (context?.selected !== true) throw adapterError("git_explicit_selection_required");
      const taskId = requireTaskId(context.taskId);
      const installRoot = requireInstallRoot(context.installRoot);
      const state = await ensureStateRoot(ownershipStore, installRoot);
      const managed = assertManagedRecord(state, installRoot, "git");
      const item = catalogComponent(context.catalog, "git");
      let discovery = null;
      if (!managed) {
        discovery = await windowsHost.discoverGit();
        if (!isPlainRecord(discovery) || !["none", "external"].includes(discovery.kind)) {
          throw adapterError("git_discovery_invalid");
        }
      }
      before = managed?.version ?? (discovery?.kind === "external" ? discovery.version : null);
      const installerPath = path.win32.join(installRoot, "downloads", `git-${item.version}.exe`);
      const downloaded = await download({
        asset: downloadAsset(item), destination: installerPath, signal: context.signal,
        onProgress: typeof context.onProgress === "function" ? context.onProgress : () => {},
      });
      if (!isPlainRecord(downloaded) || downloaded.path !== installerPath
        || downloaded.size !== item.size || downloaded.sha256 !== item.sha256) {
        throw adapterError("component_download_evidence_invalid");
      }
      const signature = await windowsHost.verifyAuthenticode(installerPath);
      if (!isPlainRecord(signature) || signature.status !== "Valid") throw adapterError("git_authenticode_invalid");
      if (discovery?.kind === "external") {
        if (discovery.ownership !== "external" || typeof discovery.installDir !== "string"
          || typeof discovery.executablePath !== "string" || typeof discovery.uninstallerPath !== "string") {
          throw adapterError("git_external_record_invalid");
        }
        preparedComponents.set(`git\0${taskId}`, Object.freeze({
          componentId: "git", taskId, installRoot, item, before, installerPath,
          mode: "external", discovery: structuredClone(discovery),
        }));
      } else {
        const rootPath = componentRoot(installRoot, "git");
        const staging = slotPath(installRoot, "git", "staging");
        await windowsHost.runGitInstaller({ installerPath, targetDir: staging });
        await verifyGitVersion(path.win32.join(staging, ...item.entrypoint.split("/")), item.version);
        const receipt = assertReceipt(await verifyPreparedGit({
          componentId: "git", rootPath: staging, version: item.version,
          requiredFiles: item.requiredFiles, expectedPackageSha256: item.sha256,
        }));
        preparedComponents.set(`git\0${taskId}`, Object.freeze({
          componentId: "git", taskId, installRoot, rootPath, item, before, installerPath,
          mode: "managed", ...receipt,
        }));
      }
      return result("git", action, "succeeded", {
        versionBefore: before, versionAfter: item.version, message: "git_prepared",
        rollbackAvailable: managed ? rollbackAvailable(state, "git") : false,
      });
    } catch (error) {
      return failure("git", action, error, before);
    }
  }

  async function commitGit(context) {
    const action = "commit";
    let before = null;
    try {
      const taskId = requireTaskId(context?.taskId);
      const key = `git\0${taskId}`;
      const prepared = preparedComponents.get(key);
      if (!prepared) throw adapterError("component_not_prepared");
      preparedComponents.delete(key);
      before = prepared.before;
      if (prepared.mode === "external") {
        const fresh = await windowsHost.discoverGit();
        if (JSON.stringify(fresh) !== JSON.stringify(prepared.discovery)) throw adapterError("git_external_state_changed");
        await windowsHost.runGitInstaller({ installerPath: prepared.installerPath, targetDir: fresh.installDir });
        await verifyGitVersion(fresh.executablePath, prepared.item.version);
        return result("git", action, "succeeded", {
          versionBefore: before, versionAfter: prepared.item.version,
          message: "git_external_updated", rollbackAvailable: false,
        });
      }
      const state = await loadState();
      assertManagedRecord(state, prepared.installRoot, "git");
      if (!exactVersionUnchanged(state, "git", before)) throw adapterError("component_state_changed");
      const promoted = await promotePreparedVersion({
        taskId, componentId: "git", rootPath: prepared.rootPath, version: prepared.item.version,
        verificationReceipt: prepared.verificationReceipt,
        treeDigest: prepared.treeDigest, manifestDigest: prepared.manifestDigest,
      });
      const executablePath = componentEntrypoint(prepared.installRoot, "git", prepared.item);
      await verifyGitVersion(executablePath, prepared.item.version);
      const next = structuredClone(await loadState());
      assertManagedRecord(next, prepared.installRoot, "git");
      next.components.git = {
        ...next.components.git,
        packageSha256: prepared.item.sha256,
        ownership: "managed",
        entrypoint: prepared.item.entrypoint,
        requiredFiles: [...prepared.item.requiredFiles],
      };
      await saveState(next);
      return result("git", action, "succeeded", {
        versionBefore: before, versionAfter: prepared.item.version, message: "git_managed_committed",
        rollbackAvailable: Boolean(promoted?.rollbackAvailable),
      });
    } catch (error) {
      return failure("git", action, error, before);
    }
  }

  async function verifyGit(context) {
    const action = "verify";
    let before = null;
    try {
      const installRoot = requireInstallRoot(context?.installRoot);
      const state = await loadState();
      if (state?.installRoot === null) {
        return result("git", action, "skipped", { message: "git_not_installed" });
      }
      assertStateRoot(state, installRoot);
      const managed = assertManagedRecord(state, installRoot, "git");
      if (managed) {
        before = managed.version;
        const item = catalogComponent(context.catalog, "git");
        await verifyGitVersion(componentEntrypoint(installRoot, "git", item), managed.version);
      } else {
        const external = await windowsHost.discoverGit();
        if (external?.kind !== "external") throw adapterError("git_not_installed");
        before = external.version;
        await verifyGitVersion(external.executablePath, external.version);
      }
      return result("git", action, "succeeded", {
        versionBefore: before, versionAfter: before, message: "git_verified",
        rollbackAvailable: managed ? rollbackAvailable(state, "git") : false,
      });
    } catch (error) {
      return failure("git", action, error, before);
    }
  }

  async function uninstallGit(context) {
    const action = "uninstall";
    let before = null;
    try {
      if (context?.selected !== true) throw adapterError("git_explicit_selection_required");
      const installRoot = requireInstallRoot(context.installRoot);
      const state = await loadState();
      assertStateRoot(state, installRoot);
      const managed = assertManagedRecord(state, installRoot, "git");
      if (managed) return uninstallManaged("git", context);
      const external = await windowsHost.discoverGit();
      if (external?.kind === "none") return result("git", action, "skipped", { message: "git_not_installed" });
      if (external?.kind !== "external" || external.ownership !== "external") throw adapterError("git_discovery_invalid");
      before = external.version;
      const fresh = await windowsHost.discoverGit();
      if (JSON.stringify(fresh) !== JSON.stringify(external)) throw adapterError("git_external_state_changed");
      await windowsHost.runGitUninstaller({ uninstallerPath: fresh.uninstallerPath, installDir: fresh.installDir });
      return result("git", action, "succeeded", {
        versionBefore: before, versionAfter: null, message: "git_external_uninstalled",
      });
    } catch (error) {
      return failure("git", action, error, before);
    }
  }

  async function rollbackGit(context) {
    return rollbackManaged("git", context);
  }

  async function prepareSkills(context) {
    const taskId = (() => {
      try { return requireTaskId(context?.taskId); } catch { return null; }
    })();
    if (!taskId) return [failure("skills", "prepare", adapterError("component_task_id_invalid"))];
    const results = [];
    const pending = new Map();
    preparedSkills.set(taskId, pending);
    const ids = Array.isArray(context?.skillIds) ? context.skillIds : [];
    for (const rawId of ids) {
      const componentId = typeof rawId === "string" ? rawId : "skills";
      try {
        const installRoot = requireInstallRoot(context.installRoot);
        await ensureStateRoot(ownershipStore, installRoot);
        const skillsRoot = requireWindowsAbsolute(context.skillsRoot, "skills_root_invalid");
        const item = catalogSkill(context.catalog, rawId);
        const destination = path.win32.join(installRoot, "staging", "skills", taskId, item.id);
        const archivePath = path.win32.join(installRoot, "downloads", `skill-${item.id}-${item.version}.zip`);
        const downloaded = await download({
          asset: downloadAsset(item), destination: archivePath, signal: context.signal,
          onProgress: typeof context.onProgress === "function" ? context.onProgress : () => {},
        });
        if (!isPlainRecord(downloaded) || downloaded.path !== archivePath
          || downloaded.size !== item.size || downloaded.sha256 !== item.sha256) {
          throw adapterError("component_download_evidence_invalid");
        }
        await extractArchive({ format: "zip", archivePath, destination, signal: context.signal });
        await verifyPreparedSkill({
          rootPath: destination,
          requiredFiles: item.files.map((file) => path.win32.join(destination, ...file.split("/"))),
          expectedPackageSha256: item.sha256,
        });
        const skillMdSha256 = await hashSkillFile(path.win32.join(destination, "SKILL.md"));
        if (!SHA256.test(skillMdSha256 ?? "")) throw adapterError("skill_md_hash_invalid");
        pending.set(item.id, Object.freeze({ item, installRoot, skillsRoot, destination, skillMdSha256 }));
        results.push(result(item.id, "prepare", "succeeded", {
          versionAfter: item.version, message: "skill_prepared",
        }));
      } catch (error) {
        results.push(failure(componentId, "prepare", error));
      }
    }
    return results;
  }

  async function commitSkills(context) {
    const taskId = (() => {
      try { return requireTaskId(context?.taskId); } catch { return null; }
    })();
    if (!taskId) return [failure("skills", "commit", adapterError("component_task_id_invalid"))];
    const pending = preparedSkills.get(taskId);
    if (!pending) return [failure("skills", "commit", adapterError("component_not_prepared"))];
    preparedSkills.delete(taskId);
    const ids = Array.isArray(context?.skillIds) ? context.skillIds : [];
    const results = [];
    for (const rawId of ids) {
      const prepared = pending.get(rawId);
      let before = null;
      try {
        if (!prepared || prepared.skillsRoot !== context.skillsRoot) throw adapterError("skill_not_prepared");
        const state = await loadState();
        assertStateRoot(state, prepared.installRoot);
        before = state.skills[rawId]?.version ?? null;
        const target = await resolveSkillTarget({
          skillsRoot: prepared.skillsRoot,
          skillId: rawId,
          realpath: skillPathAccess.realpath,
          lstat: skillPathAccess.lstat,
        });
        if (target !== path.win32.join(prepared.skillsRoot, rawId)) throw adapterError("skill_target_mismatch");
        await replaceSkillExact({
          source: prepared.destination,
          target,
          authorizedRoot: prepared.skillsRoot,
          requiredFiles: prepared.item.files,
          backup: false,
        });
        const installedHash = await hashSkillFile(path.win32.join(target, "SKILL.md"));
        if (installedHash !== prepared.skillMdSha256) throw adapterError("skill_md_hash_mismatch");
        const next = structuredClone(await loadState());
        assertStateRoot(next, prepared.installRoot);
        next.skills[rawId] = {
          target,
          version: prepared.item.version,
          packageSha256: prepared.item.sha256,
          skillMdSha256: prepared.skillMdSha256,
        };
        await saveState(next);
        results.push(result(rawId, "commit", "succeeded", {
          versionBefore: before, versionAfter: prepared.item.version, message: "skill_replaced",
        }));
      } catch (error) {
        results.push(failure(typeof rawId === "string" ? rawId : "skills", "commit", error, before));
      }
    }
    return results;
  }

  async function inspectSkills(context) {
    const state = await loadState();
    const ids = Array.isArray(context?.skillIds) ? context.skillIds : Object.keys(state.skills ?? {});
    return ids.map((id) => {
      const record = state.skills?.[id];
      return record
        ? result(id, "inspect", "succeeded", { versionBefore: record.version, versionAfter: record.version, message: "skill_installed" })
        : result(id, "inspect", "skipped", { message: "skill_not_installed" });
    });
  }

  async function verifySkills(context) {
    const state = await loadState();
    const results = [];
    for (const id of Array.isArray(context?.skillIds) ? context.skillIds : []) {
      const record = state.skills?.[id];
      try {
        if (!record) throw adapterError("skill_not_installed");
        const target = await resolveSkillTarget({
          skillsRoot: context.skillsRoot, skillId: id,
          realpath: skillPathAccess.realpath, lstat: skillPathAccess.lstat,
        });
        if (target !== record.target) throw adapterError("skill_target_mismatch");
        const hash = await hashSkillFile(path.win32.join(target, "SKILL.md"));
        if (hash !== record.skillMdSha256) throw adapterError("skill_md_hash_mismatch");
        results.push(result(id, "verify", "succeeded", {
          versionBefore: record.version, versionAfter: record.version, message: "skill_verified",
        }));
      } catch (error) {
        results.push(failure(id, "verify", error, record?.version ?? null));
      }
    }
    return results;
  }

  async function uninstallSkills(context) {
    const results = [];
    for (const rawId of Array.isArray(context?.skillIds) ? context.skillIds : []) {
      let before = null;
      try {
        if (!SKILL_ID.test(rawId ?? "")) throw adapterError("skill_id_rejected");
        const state = await loadState();
        const record = state.skills[rawId];
        if (!record) {
          results.push(result(rawId, "uninstall", "skipped", { message: "skill_not_installed" }));
          continue;
        }
        before = record.version;
        const target = await resolveSkillTarget({
          skillsRoot: context.skillsRoot, skillId: rawId,
          realpath: skillPathAccess.realpath, lstat: skillPathAccess.lstat,
        });
        if (target !== record.target || target !== path.win32.join(context.skillsRoot, rawId)) {
          throw adapterError("skill_target_mismatch");
        }
        await deleteSkillExact({ target, authorizedRoot: context.skillsRoot });
        const next = structuredClone(await loadState());
        if (next.skills[rawId]?.target !== target) throw adapterError("skill_state_changed");
        delete next.skills[rawId];
        await saveState(next);
        results.push(result(rawId, "uninstall", "succeeded", {
          versionBefore: before, versionAfter: null, message: "skill_uninstalled",
        }));
      } catch (error) {
        results.push(failure(typeof rawId === "string" ? rawId : "skills", "uninstall", error, before));
      }
    }
    return results;
  }

  async function rollbackSkills(context) {
    return (Array.isArray(context?.skillIds) ? context.skillIds : []).map((id) => result(
      id, "rollback", "skipped", { message: "skill_rollback_not_supported" },
    ));
  }

  return Object.freeze({
    chatgpt: createArchiveAdapter("chatgpt"),
    v2rayn: createArchiveAdapter("v2rayn"),
    git: Object.freeze({
      inspectInstalled: inspectGit,
      prepare: prepareGit,
      commit: commitGit,
      verify: verifyGit,
      uninstall: uninstallGit,
      rollback: rollbackGit,
    }),
    skills: Object.freeze({
      inspectInstalled: inspectSkills,
      prepare: prepareSkills,
      commit: commitSkills,
      verify: verifySkills,
      uninstall: uninstallSkills,
      rollback: rollbackSkills,
    }),
  });
}
