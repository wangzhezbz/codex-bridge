import fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import { TEST_CATALOG_ORIGIN, TEST_CATALOG_PATH } from "../../shared/software-manager/catalog-schema.mjs";
import { createArchiveService } from "./archive-service.mjs";
import { createCatalogCache } from "./catalog-cache.mjs";
import { createCachedCatalogProvider } from "./catalog-provider.mjs";
import { createComponentAdapters, recoverSkillOwnershipOffline } from "./component-adapters.mjs";
import { createComponentFileService } from "./component-files.mjs";
import { createDownloadManager } from "./download-manager.mjs";
import { createGitIdentityCapabilities } from "./git-identity-capabilities.mjs";
import { createInstallRootResolver } from "./install-root-resolver.mjs";
import { getOwnershipCoordinator } from "./ownership-coordinator.mjs";
import { createInstallerWorkspace } from "./installer-workspace.mjs";
import { recoverOffline as recoverLocalTransactions } from "./offline-recovery.mjs";
import {
  authorizeDesktopPath,
  authorizeInstallRoot,
  authorizeSkillsRoot,
  readInstallRootCapability,
  resolveSkillTarget,
} from "./path-policy.mjs";
import { createRetainedInstallerStore } from "./retained-installer-store.mjs";
import { deleteAuthorizedTree } from "./safe-delete.mjs";
import { createSoftwareManagerService } from "./service.mjs";
import { createPreparedSkillRecovery, createSkillFileService } from "./skill-files.mjs";
import { createSkillPrepareJournal, inferPreparedSkillInstallRoot } from "./skill-prepare-journal.mjs";
import { createSkillSwapJournal } from "./skill-swap-journal.mjs";
import { createOwnershipStore } from "./state-store.mjs";
import { createTransactionJournal } from "./transaction-journal.mjs";
import { createVersionSlotManager } from "./version-slots.mjs";
import { createWin32FileApi } from "./win32-file-api.mjs";
import { createWin32SuspendedProcessCapability } from "./win32-suspended-process.mjs";
import { createWindowsFileCapabilities } from "./windows-file-capabilities.mjs";
import { createWindowsHost } from "./windows-host.mjs";

const FIXED_CATALOG_URL = `${TEST_CATALOG_ORIGIN}${TEST_CATALOG_PATH}`;
const MAX_RELATIVE_PATH = 4_096;
const MAX_RECORDS = 500;
const SEVEN_ZIP_SHA256 = Object.freeze({
  arm64: "81f67048b7366870e5d49f00a8c570570c6a0dd11c05df7a09a8c52870cc83bd",
  ia32: "31fd52f8996986623cf52c3b4d0f7ac74a9dec63fc16c902cef673eed550c435",
  x64: "b0cfdeaf429f5cc53f85123dd8f5a5feb92c19d31aa34df257edf9a26be05f95",
});
const HOST_METHODS = Object.freeze([
  "discoverGit", "verifyAuthenticode", "readFileVersion", "stopOwnedProcesses", "launchOwned",
  "planShortcut", "createShortcut", "inspectRecordedShortcut", "removeRecordedShortcut",
  "runGitInstaller", "runGitUninstaller",
]);
const SKILL_FILE_METHODS = Object.freeze([
  "verifyPreparedSkill", "hashFile", "replaceExact", "finalizeReplacement", "verifyCompletionProof",
  "recoverCompletionProof", "inspectExact", "deleteExact", "reconcileReplacement", "beginPreparedSource",
  "bindPreparedSource", "discardPrepared", "reconcilePreparedSources",
]);

function runtimeError(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function requireWindowsPath(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value
    || value.includes("\0") || !path.win32.isAbsolute(value)
    || path.win32.normalize(value) !== value) throw runtimeError(code);
  return value;
}

function requireRecord(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw runtimeError(code);
  return value;
}

function requireMethod(owner, name, code) {
  if (typeof owner?.[name] !== "function") throw runtimeError(code);
  return owner[name].bind(owner);
}

function memoizeAsync(factory) {
  let value;
  let ready = false;
  let inFlight = null;
  return () => {
    if (ready) return Promise.resolve(value);
    if (inFlight === null) {
      const operation = Promise.resolve().then(factory).then((result) => {
        value = result;
        ready = true;
        return result;
      });
      inFlight = operation;
      operation.then(
        () => { if (inFlight === operation) inFlight = null; },
        () => { if (inFlight === operation) inFlight = null; },
      );
    }
    return inFlight;
  };
}

function lazyFacade(getService, methods) {
  return Object.freeze(Object.fromEntries(methods.map((name) => [name, async (...args) => {
    const service = await getService();
    return requireMethod(service, name, "software_manager_lazy_service_invalid")(...args);
  }])));
}

function emptyOwnership() {
  return {
    schemaVersion: 1, generation: 0, installRoot: null, components: {}, skills: {}, shortcuts: [],
    rollback: null, activeTask: null, lastTask: null,
  };
}

function disabledService(platform) {
  const resolver = Object.freeze({
    getCurrentToken: () => null,
    choose: async () => { throw runtimeError("software_manager_platform_disabled"); },
    resolve: async () => { throw runtimeError("software_manager_platform_disabled"); },
    adopt: async () => { throw runtimeError("software_manager_platform_disabled"); },
    discard: async () => {},
  });
  return createSoftwareManagerService({
    platform,
    catalogProvider: Object.freeze({ getCurrent: async () => null, refresh: async () => null }),
    adapterFactory: async () => { throw runtimeError("software_manager_platform_disabled"); },
    ownershipStore: Object.freeze({ load: async () => emptyOwnership() }),
    recoverTransactions: async () => [],
    installRootResolver: resolver,
  });
}

async function withRecordDirectory(fileCapabilities, directoryPath, operation) {
  const directory = await fileCapabilities.openStateDirectoryNoFollow(directoryPath);
  if (!directory || typeof directory.openFileNoFollow !== "function"
    || typeof directory.unlinkEntryNoFollow !== "function"
    || typeof directory.renameEntryNoFollow !== "function" || typeof directory.close !== "function") {
    await directory?.close?.().catch(() => {});
    throw runtimeError("software_manager_record_store_invalid");
  }
  let result;
  let primaryError = null;
  try { result = await operation(directory); } catch (error) { primaryError = error; }
  try { await directory.close(); } catch (error) {
    if (primaryError) throw new AggregateError([primaryError, error], primaryError.message, { cause: primaryError });
    throw error;
  }
  if (primaryError) throw primaryError;
  return result;
}

function createCapabilityRecordStore({ fileCapabilities, directoryPath, fileName }) {
  const tempName = `${fileName}.tmp`;
  const backupName = `${fileName}.bak`;
  async function readFile(directory, name) {
    const handle = await directory.openFileNoFollow(name, "r");
    if (handle === null) return null;
    try { return JSON.parse(await handle.readFile("utf8")); }
    finally { await handle.close(); }
  }
  return Object.freeze({
    async read() {
      return withRecordDirectory(fileCapabilities, directoryPath, async (directory) => (
        await readFile(directory, fileName) ?? await readFile(directory, backupName)
      ));
    },
    async replaceAtomic(value) {
      const lease = await fileCapabilities.acquireStateLockNoFollow(directoryPath);
      if (!lease || typeof lease.release !== "function") throw runtimeError("software_manager_record_lock_invalid");
      let primaryError = null;
      try {
        await withRecordDirectory(fileCapabilities, directoryPath, async (directory) => {
          const stale = await directory.openFileNoFollow(tempName, "r");
          if (stale) { const entry = stale.entry; await stale.close(); await directory.unlinkEntryNoFollow(entry); }
          const temp = await directory.openFileNoFollow(tempName, "wx");
          if (!temp || typeof temp.writeFile !== "function" || typeof temp.sync !== "function") {
            throw runtimeError("software_manager_record_file_invalid");
          }
          const tempEntry = temp.entry;
          try { await temp.writeFile(`${JSON.stringify(value)}\n`, "utf8"); await temp.sync(); }
          finally { await temp.close(); }
          const current = await directory.openFileNoFollow(fileName, "r");
          const backup = await directory.openFileNoFollow(backupName, "r");
          if (backup) { const entry = backup.entry; await backup.close(); await directory.unlinkEntryNoFollow(entry); }
          if (current) { const entry = current.entry; await current.close(); await directory.renameEntryNoFollow(entry, backupName); }
          await directory.renameEntryNoFollow(tempEntry, fileName);
        });
      } catch (error) { primaryError = error; }
      try { await lease.release(); } catch (error) {
        if (primaryError) throw new AggregateError([primaryError, error], primaryError.message, { cause: primaryError });
        throw error;
      }
      if (primaryError) throw primaryError;
    },
  });
}

function createBoundedLogSink(store) {
  return Object.freeze({
    async write(entry) {
      const prior = await store.read().catch(() => null);
      const records = Array.isArray(prior?.records) ? prior.records : [];
      await store.replaceAtomic({ schemaVersion: 1, records: [...records, structuredClone(entry)].slice(-MAX_RECORDS) });
    },
  });
}

function bundledSevenZipPath() {
  const packageEntry = createRequire(import.meta.url).resolve("7zip-bin");
  return path.win32.join(path.win32.dirname(packageEntry), "win", process.arch, "7za.exe");
}

function fixedSevenZip(rawPath, { allowInjectedPath = false } = {}) {
  const architecture = process.arch;
  const sha256 = SEVEN_ZIP_SHA256[architecture];
  if (!sha256) throw runtimeError("software_manager_7z_architecture_unsupported");
  const sevenZipPath = requireWindowsPath(rawPath ?? bundledSevenZipPath(), "software_manager_7z_path_invalid");
  const controlledPath = bundledSevenZipPath();
  if (!allowInjectedPath && sevenZipPath.toLowerCase() !== controlledPath.toLowerCase()) {
    throw runtimeError("software_manager_7z_path_rejected");
  }
  return Object.freeze({ sevenZipPath, sevenZipSha256: sha256 });
}

async function hashPinnedFile(fileCapabilities, filePath, maxBytes = 16 * 1_024 * 1_024) {
  const pin = await fileCapabilities.pinArchiveFileNoFollow(filePath);
  if (!pin || typeof pin.assertStableNoFollow !== "function" || typeof pin.close !== "function") {
    throw runtimeError("software_manager_file_pin_invalid");
  }
  let primaryError = null;
  let digest;
  try {
    await pin.assertStableNoFollow();
    const handle = await fsPromises.open(filePath, "r");
    try {
      const hash = createHash("sha256");
      let total = 0;
      for await (const chunk of handle.createReadStream()) {
        total += chunk.length;
        if (!Number.isSafeInteger(total) || total > maxBytes) throw runtimeError("software_manager_file_too_large");
        hash.update(chunk);
      }
      digest = hash.digest("hex");
    } finally { await handle.close(); }
    await pin.assertStableNoFollow();
  } catch (error) { primaryError = error; }
  if (primaryError) { await pin.close().catch(() => {}); throw primaryError; }
  return { digest, pin };
}

export function createPinnedSevenZipExecution({ fileCapabilities, sevenZipPath, sevenZipSha256, execFile, spawn }) {
  const run = requireMethod({ execFile }, "execFile", "software_manager_exec_file_required");
  const start = requireMethod({ spawn }, "spawn", "software_manager_spawn_required");
  async function pin() {
    const pinned = await hashPinnedFile(fileCapabilities, sevenZipPath);
    if (pinned.digest !== sevenZipSha256) {
      await pinned.pin.close().catch(() => {});
      throw runtimeError("software_manager_7z_hash_mismatch");
    }
    return pinned.pin;
  }
  return Object.freeze({
    async spawnFile(file, args, options) {
      if (file !== sevenZipPath) throw runtimeError("software_manager_7z_path_rejected");
      const held = await pin();
      try { return await run(file, args, options); }
      finally { await held.close(); }
    },
    async spawnStream(file, args, options) {
      if (file !== sevenZipPath) throw runtimeError("software_manager_7z_path_rejected");
      const held = await pin();
      let child;
      try { child = await start(file, args, options); }
      catch (error) { await held.close().catch(() => {}); throw error; }
      if (!child || typeof child !== "object" || !child.completed || typeof child.completed.then !== "function") {
        await held.close().catch(() => {});
        throw runtimeError("software_manager_spawn_result_invalid");
      }
      return Object.freeze({ ...child, completed: Promise.resolve(child.completed).finally(() => held.close()) });
    },
  });
}

function createWorkspaceDownloader({ workspace, downloadManager, catalogService }) {
  return Object.freeze({
    async download({ asset, destination, signal, onProgress }) {
      const components = ["chatgpt", "v2rayn", "git"].map((id) => catalogService.getComponent(id));
      const component = components.find((entry) => destination.endsWith(`\\${entry.id}-${entry.version}.${entry.format}`));
      const skill = component ? null : catalogService.listSkills().find((entry) => (
        destination.endsWith(`\\skill-${entry.id}-${entry.version}.zip`)
      ));
      if (!component && !skill) throw runtimeError("software_manager_download_destination_invalid");
      const record = component
        ? await workspace.prepareDownloadFile({
          componentId: component.id, version: component.version, extension: `.${component.format}`,
          size: component.size, sha256: component.sha256,
        })
        : await workspace.prepareSkillDownloadFile({
          skillId: skill.id, version: skill.version, size: skill.size, sha256: skill.sha256,
        });
      if (record.path !== destination || asset.url !== (component ?? skill).assetUrl
        || asset.size !== record.size || asset.sha256 !== record.sha256) {
        throw runtimeError("software_manager_download_binding_invalid");
      }
      const receipt = await downloadManager.downloadPrepared({
        asset, partPath: record.partPath, signal, onProgress,
      });
      return record.promotePartNoReplace(receipt);
    },
  });
}

export function createDefaultSkillRecoveryHooks({
  fileCapabilities, ownershipStore, dataRoot, skillsRoot,
  skillPathAccess = { realpath: fsPromises.realpath, lstat: fsPromises.lstat },
} = {}) {
  const skillSwapDirectory = path.win32.join(dataRoot, "skill-swaps");
  const skillPrepareDirectory = path.win32.join(dataRoot, "skill-prepares");
  function createRecoverySkillFiles({ installRootCapability, skillsRootCapability }) {
    const installRoot = readInstallRootCapability(installRootCapability);
    return createSkillFileService({
      fileCapabilities, installRootCapability, skillsRootCapability,
      catalogService: null, workspace: null,
      swapJournal: createSkillSwapJournal({ journalDir: skillSwapDirectory, fsApi: fileCapabilities, skillsRoot }),
      prepareJournal: createSkillPrepareJournal({
        journalDir: skillPrepareDirectory, fsApi: fileCapabilities, installRoot,
      }),
      prepareLeaseStore: ownershipStore, hashFile: null, recoveryOnly: true,
    });
  }
  async function inferSkillInstallRoot(ownership) {
    const task = ownership?.activeTask;
    if (!task || !["skill-replace", "skill-uninstall", "skill-prepare"].includes(task.kind)) return null;
    if (typeof task.taskId !== "string" || typeof task.skillId !== "string") {
      throw runtimeError("software_manager_skill_recovery_record_invalid");
    }
    const preparedRoot = await inferPreparedSkillInstallRoot({
      journalDir: skillPrepareDirectory, fsApi: fileCapabilities, taskId: task.taskId, skillId: task.skillId,
    });
    if (preparedRoot !== null) return preparedRoot;
    if (task.kind !== "skill-replace" || typeof task.swapId !== "string" || task.skillsRoot !== skillsRoot) return null;
    const transaction = await createSkillSwapJournal({
      journalDir: skillSwapDirectory, fsApi: fileCapabilities, skillsRoot,
    }).load({ taskId: task.taskId, swapId: task.swapId });
    if (!transaction) return null;
    const suffix = path.win32.join("staging", `task-${task.taskId}`, `skill-${task.skillId}.prepare`);
    const sourcePath = transaction.snapshot.sourcePath;
    if (typeof sourcePath !== "string" || !sourcePath.endsWith(`\\${suffix}`)) {
      throw runtimeError("software_manager_skill_recovery_record_invalid");
    }
    return sourcePath.slice(0, -(suffix.length + 1));
  }
  async function cleanupAbandonedPreparedSkills({ installRootCapability }) {
    const installRoot = readInstallRootCapability(installRootCapability);
    await createPreparedSkillRecovery({
      fileCapabilities, installRootCapability,
      prepareJournal: createSkillPrepareJournal({
        journalDir: skillPrepareDirectory, fsApi: fileCapabilities, installRoot,
      }),
      prepareLeaseStore: ownershipStore,
    }).reconcilePreparedSources();
    const coordinator = getOwnershipCoordinator(ownershipStore);
    return coordinator.runExclusive(async (store) => {
      const current = await store.load();
      const task = current.activeTask;
      const isSkillPrepare = task?.kind === "skill-prepare"
        || (task?.kind === "legacy-abandoned-prepare" && task.originalKind === "skill-prepare");
      if (!isSkillPrepare) return current;
      if (task.kind !== "legacy-abandoned-prepare"
        && (typeof task.leaseNonce !== "string" || typeof task.leaseScope !== "string")) {
        throw runtimeError("software_manager_skill_prepare_claim_invalid");
      }
      const lease = task.kind === "legacy-abandoned-prepare" ? { async release() {} }
        : await ownershipStore.acquireOperationLease({ nonce: task.leaseNonce, scope: task.leaseScope, wait: false });
      if (lease === null) return current;
      try {
        const next = structuredClone(current);
        next.activeTask = null;
        next.lastTask = {
          taskId: task.taskId,
          componentId: task.kind === "skill-prepare" ? task.skillId : task.componentId,
          action: "prepare-aborted",
        };
        return await store.save(next);
      } finally { await lease.release(); }
    });
  }
  return Object.freeze({
    inferSkillInstallRoot,
    async recoverActiveSkillTransaction({ installRootCapability, skillsRootCapability }) {
      return recoverSkillOwnershipOffline({
        ownershipStore, installRootCapability, skillsRootCapability,
        skillFiles: createRecoverySkillFiles({ installRootCapability, skillsRootCapability }),
        resolveSkillTarget,
        skillPathAccess,
      });
    },
    cleanupAbandonedPreparedSkills,
  });
}

function createDefaultWindowsInfrastructure({ platform, dataRoot, homeDir, getDesktopPath, env, koffi }) {
  const nativeApi = createWin32FileApi({ platform, koffi });
  const fileCapabilities = createWindowsFileCapabilities({ platform, nativeApi });
  const skillsRoot = path.win32.join(homeDir, ".codex", "skills");
  const ownershipStore = createOwnershipStore({
    stateDir: path.win32.join(dataRoot, "state"), fileCapabilities, fsApi: fileCapabilities, skillsRoot,
  });
  const journal = createTransactionJournal({
    journalDir: path.win32.join(dataRoot, "journal"), fsApi: fileCapabilities,
  });
  const catalogStore = createCapabilityRecordStore({
    fileCapabilities, directoryPath: path.win32.join(dataRoot, "catalog"), fileName: "catalog-cache.json",
  });
  const logStore = createCapabilityRecordStore({
    fileCapabilities, directoryPath: path.win32.join(dataRoot, "logs"), fileName: "software-manager.json",
  });
  const skillRecovery = createDefaultSkillRecoveryHooks({
    fileCapabilities, ownershipStore, dataRoot, skillsRoot,
  });
  return Object.freeze({
    nativeApi,
    fileCapabilities,
    ownershipStore,
    journal,
    catalogCache: createCatalogCache({ cacheStore: catalogStore }),
    logSink: createBoundedLogSink(logStore),
    skillsRoot,
    dataRoot,
    env,
    async authorizeRoot(rootPath) {
      return authorizeInstallRoot({
        candidate: rootPath, env, maxRelativePath: MAX_RELATIVE_PATH,
        access: (target) => fsPromises.access(target, fs.constants.R_OK | fs.constants.W_OK),
        realpath: fsPromises.realpath, lstat: fsPromises.lstat,
      });
    },
    async createSlots({ installRootCapability }) {
      return createVersionSlotManager({
        fsApi: fileCapabilities, ownershipStore, journal, installRootCapability,
      });
    },
    async getDesktopCapability() {
      return authorizeDesktopPath({ getDesktopPath, realpath: fsPromises.realpath, lstat: fsPromises.lstat });
    },
    async getSkillsRootCapability() {
      return authorizeSkillsRoot({ candidate: skillsRoot, realpath: fsPromises.realpath, lstat: fsPromises.lstat });
    },
    ...skillRecovery,
  });
}

async function createDefaultRootAdapters({
  platform, infrastructure, catalogService, installRootCapability, versionSlots,
  getDesktopCapability, getSkillsRootCapability, getWindowsHost,
  fetchImpl, execFile, spawn, sevenZipPath, sevenZipSha256,
}) {
  const { fileCapabilities, ownershipStore, dataRoot, skillsRoot } = infrastructure;
  const rootFactories = Object.freeze({
    createDownloadManager, createInstallerWorkspace, createWorkspaceDownloader,
    createArchiveService, createComponentFileService, createRetainedInstallerStore,
    createGitIdentityCapabilities, createSkillSwapJournal, createSkillPrepareJournal,
    createSkillFileService, createComponentAdapters,
    ...(infrastructure.rootFactories ?? {}),
  });
  const downloadManager = rootFactories.createDownloadManager({ fetchImpl });
  const workspace = rootFactories.createInstallerWorkspace({
    fileCapabilities, installRootCapability, downloadManager, catalogService,
  });
  const downloader = rootFactories.createWorkspaceDownloader({ workspace, downloadManager, catalogService });
  const sevenZip = createPinnedSevenZipExecution({
    fileCapabilities, sevenZipPath, sevenZipSha256, execFile, spawn,
  });
  const archiveService = rootFactories.createArchiveService({
    sevenZipPath, spawnFile: sevenZip.spawnFile, spawnStream: sevenZip.spawnStream, fsApi: fileCapabilities,
  });
  const lazyHost = lazyFacade(getWindowsHost, HOST_METHODS);
  const componentFiles = rootFactories.createComponentFileService({
    fileCapabilities, installRootCapability, catalogService, workspace,
    versionReader: lazyHost, execFile, deleteAuthorizedTree,
  });
  const retainedInstallerStore = rootFactories.createRetainedInstallerStore({ fileCapabilities, installRootCapability });
  const gitIdentityCapabilities = rootFactories.createGitIdentityCapabilities({
    fileCapabilities, installRootCapability,
    hashFile: retainedInstallerStore.hashFile, retainedInstallerStore,
  });
  const getSkillFiles = memoizeAsync(async () => {
    const skillsRootCapability = await getSkillsRootCapability();
    const swapJournal = rootFactories.createSkillSwapJournal({
      journalDir: path.win32.join(dataRoot, "skill-swaps"), fsApi: fileCapabilities, skillsRoot,
    });
    const prepareJournal = rootFactories.createSkillPrepareJournal({
      journalDir: path.win32.join(dataRoot, "skill-prepares"), fsApi: fileCapabilities,
      installRoot: await (async () => {
        const { readInstallRootCapability } = await import("./path-policy.mjs");
        return readInstallRootCapability(installRootCapability);
      })(),
    });
    return rootFactories.createSkillFileService({
      fileCapabilities, installRootCapability, skillsRootCapability, catalogService, workspace,
      swapJournal, prepareJournal, prepareLeaseStore: ownershipStore,
      hashFile: async (filePath) => {
        const pinned = await hashPinnedFile(fileCapabilities, filePath);
        await pinned.pin.close();
        return pinned.digest;
      },
    });
  });
  return rootFactories.createComponentAdapters({
    catalogService,
    installRootCapability,
    skillsRootCapability: getSkillsRootCapability,
    desktopCapability: getDesktopCapability,
    downloader,
    archiveService,
    versionSlots,
    ownershipStore,
    windowsHost: lazyHost,
    componentFiles,
    skillFiles: lazyFacade(getSkillFiles, SKILL_FILE_METHODS),
    installerWorkspace: workspace,
    gitIdentityCapabilities,
    resolveSkillTarget,
    skillPathAccess: { realpath: fsPromises.realpath, lstat: fsPromises.lstat },
  });
}

const DEFAULT_FACTORIES = Object.freeze({
  createWindowsInfrastructure: createDefaultWindowsInfrastructure,
  createCatalogProvider: (options) => createCachedCatalogProvider(options),
  createInstallRootResolver: (options) => createInstallRootResolver(options),
  createRootAdapters: createDefaultRootAdapters,
  createWindowsHost(options) {
    const shortcutFileApi = Object.freeze(Object.fromEntries([
      "inspectExact", "createTemp", "sealTemp", "commitNoReplace", "removeExact", "release",
    ].map((name) => [name, async (...args) => {
      const capability = await options.getDesktopCapability();
      const api = options.infrastructure.fileCapabilities.createShortcutFileApi(capability);
      return requireMethod(api, name, "shortcut_file_capability_invalid")(...args);
    }])));
    return createWindowsHost({
      platform: options.platform,
      execFile: options.execFile,
      electronShell: options.electronShell,
      shortcutFileApi,
      spawnDetached: options.spawn,
      suspendedProcess: createWin32SuspendedProcessCapability({ platform: options.platform, koffi: options.koffi }),
      getSystemDirectory: () => options.infrastructure.nativeApi.getSystemDirectory(),
      env: options.env,
    });
  },
});

export async function createProductionSoftwareManagerService({
  platform = process.platform,
  dataRoot,
  homeDir,
  getDesktopPath,
  env = {},
  electronShell,
  fetchImpl = globalThis.fetch,
  execFile,
  spawn,
  publicKeyPem = null,
  catalogUrl = FIXED_CATALOG_URL,
  sevenZipPath,
  koffi,
  runtimeFactories = {},
} = {}) {
  if (platform !== "win32") {
    const service = disabledService(platform);
    return Object.freeze({
      service,
      recoverOffline: async () => Object.freeze({ status: "noop", installRoot: null, recovered: Object.freeze([]) }),
      selectInstallRoot: (candidate) => service.chooseInstallRoot(candidate),
    });
  }
  const exactDataRoot = requireWindowsPath(dataRoot, "software_manager_data_root_invalid");
  const exactHomeDir = requireWindowsPath(homeDir, "software_manager_home_root_invalid");
  if (catalogUrl !== FIXED_CATALOG_URL) throw runtimeError("software_manager_catalog_url_rejected");
  if (publicKeyPem !== null && typeof publicKeyPem !== "string") throw runtimeError("software_manager_catalog_key_invalid");
  requireRecord(env, "software_manager_environment_invalid");
  const injectedFactories = requireRecord(runtimeFactories, "software_manager_factories_invalid");
  const sevenZip = fixedSevenZip(sevenZipPath, { allowInjectedPath: Object.keys(injectedFactories).length > 0 });
  const factories = Object.freeze({ ...DEFAULT_FACTORIES, ...injectedFactories });
  const infrastructure = await factories.createWindowsInfrastructure({
    platform, dataRoot: exactDataRoot, homeDir: exactHomeDir, getDesktopPath, env, koffi,
  });
  for (const name of [
    "authorizeRoot", "createSlots", "getDesktopCapability", "getSkillsRootCapability",
    "inferSkillInstallRoot", "recoverActiveSkillTransaction", "cleanupAbandonedPreparedSkills",
  ]) {
    requireMethod(infrastructure, name, "software_manager_infrastructure_invalid");
  }
  const ownershipStore = requireRecord(infrastructure.ownershipStore, "software_manager_infrastructure_invalid");
  const journal = requireRecord(infrastructure.journal, "software_manager_infrastructure_invalid");
  const catalogProvider = factories.createCatalogProvider({
    catalogUrl,
    signatureUrl: `${catalogUrl}.sig`,
    publicKeyPem,
    fetchImpl,
    cache: infrastructure.catalogCache,
  });
  const installRootResolver = factories.createInstallRootResolver({
    authorizeRoot: infrastructure.authorizeRoot.bind(infrastructure),
    getPersistedRoot: async () => (await ownershipStore.load()).installRoot,
  });
  const getDesktopCapability = memoizeAsync(() => infrastructure.getDesktopCapability());
  const getSkillsRootCapability = memoizeAsync(() => infrastructure.getSkillsRootCapability());
  const getWindowsHost = memoizeAsync(() => factories.createWindowsHost({
    platform, infrastructure, getDesktopCapability, env, electronShell, execFile, spawn, koffi,
  }));
  const rootRuntimes = new WeakMap();

  function createSlots(installRootCapability) {
    return infrastructure.createSlots({ installRootCapability });
  }

  async function createRootRuntime({ catalogService, installRootCapability }) {
    if (!catalogService || !installRootCapability || typeof installRootCapability !== "object") {
      throw runtimeError("software_manager_root_runtime_invalid");
    }
    let created = rootRuntimes.get(installRootCapability);
    if (!created) {
      created = Promise.resolve().then(async () => {
        const versionSlots = await createSlots(installRootCapability);
        if (!versionSlots || typeof versionSlots !== "object") throw runtimeError("software_manager_slots_invalid");
        return factories.createRootAdapters({
          platform,
          infrastructure,
          catalogService,
          installRootCapability,
          versionSlots,
          getDesktopCapability,
          getSkillsRootCapability,
          getWindowsHost,
          fetchImpl,
          execFile,
          spawn,
          ...sevenZip,
        });
      });
      rootRuntimes.set(installRootCapability, created);
      created.catch(() => {
        if (rootRuntimes.get(installRootCapability) === created) rootRuntimes.delete(installRootCapability);
      });
    }
    return created;
  }

  let recoveryInFlight = null;
  const recoverOffline = () => {
    if (recoveryInFlight !== null) return recoveryInFlight;
    const operation = Promise.resolve().then(async () => {
      const recovered = await recoverLocalTransactions({
        ownershipStore,
        journal,
        authorizeRoot: infrastructure.authorizeRoot.bind(infrastructure),
        createSlots: ({ installRootCapability }) => createSlots(installRootCapability),
      });
      let current = await ownershipStore.load();
      let installRoot = recovered.installRoot ?? current.installRoot;
      if (installRoot === null) installRoot = await infrastructure.inferSkillInstallRoot(structuredClone(current));
      let installRootCapability = null;
      if (typeof installRoot === "string") {
        installRootCapability = await infrastructure.authorizeRoot(installRoot);
      }
      if (["skill-replace", "skill-uninstall"].includes(current.activeTask?.kind)) {
        const skillsRootCapability = await getSkillsRootCapability();
        await infrastructure.recoverActiveSkillTransaction({
          ownership: structuredClone(current), installRootCapability, skillsRootCapability,
        });
      }
      if (installRootCapability) await infrastructure.cleanupAbandonedPreparedSkills({ installRootCapability });
      current = await ownershipStore.load();
      const restoredRoot = current.installRoot ?? installRoot;
      if (typeof restoredRoot === "string") await installRootResolver.restoreOwnedRoot(restoredRoot);
      if (recovered.installRoot === restoredRoot) return recovered;
      return Object.freeze({ ...recovered, status: "recovered", installRoot: restoredRoot });
    });
    recoveryInFlight = operation;
    operation.then(
      () => { if (recoveryInFlight === operation) recoveryInFlight = null; },
      () => { if (recoveryInFlight === operation) recoveryInFlight = null; },
    );
    return operation;
  };
  const service = createSoftwareManagerService({
    platform,
    catalogProvider,
    adapterFactory: createRootRuntime,
    ownershipStore,
    recoverTransactions: recoverOffline,
    installRootResolver,
    logSink: infrastructure.logSink,
  });
  return Object.freeze({
    service,
    recoverOffline,
    selectInstallRoot: (candidate) => service.chooseInstallRoot(candidate),
  });
}
