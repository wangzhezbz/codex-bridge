import fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import { TEST_CATALOG_ORIGIN, TEST_CATALOG_PATH } from "../../shared/software-manager/catalog-schema.mjs";
import { createArchiveService } from "./archive-service.mjs";
import { createCatalogCache } from "./catalog-cache.mjs";
import { createCapabilityRecordStore } from "./capability-record-store.mjs";
import { createCachedCatalogProvider } from "./catalog-provider.mjs";
import { readBundledCatalogEnvelope } from "./bundled-catalog.mjs";
import { createComponentAdapters } from "./component-adapters.mjs";
import { createComponentFileService } from "./component-files.mjs";
import { createDownloadManager } from "./download-manager.mjs";
import { createGitIdentityCapabilities } from "./git-identity-capabilities.mjs";
import { createInstallRootResolver } from "./install-root-resolver.mjs";
import { createLazyShortcutFileApi } from "./lazy-shortcut-file-api.mjs";
import {
  createPinnedSevenZipExecution,
  hashPinnedFile,
} from "./pinned-sevenzip-execution.mjs";
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
import { createDefaultSkillRecoveryHooks } from "./skill-recovery-hooks.mjs";
import { deleteAuthorizedTree } from "./safe-delete.mjs";
import { createSoftwareManagerService } from "./service.mjs";
import { createSkillFileService } from "./skill-files.mjs";
import { createSkillPrepareJournal } from "./skill-prepare-journal.mjs";
import { createSkillSwapJournal } from "./skill-swap-journal.mjs";
import { createOwnershipStore } from "./state-store.mjs";
import { createTransactionJournal } from "./transaction-journal.mjs";
import { createVersionSlotManager } from "./version-slots.mjs";
import { createWin32FileApi } from "./win32-file-api.mjs";
import { createWin32SuspendedProcessCapability } from "./win32-suspended-process.mjs";
import { createWindowsFileCapabilities } from "./windows-file-capabilities.mjs";
import { createWindowsHost } from "./windows-host.mjs";

const FIXED_CATALOG_URL = `${TEST_CATALOG_ORIGIN}${TEST_CATALOG_PATH}`;
const MAX_RELATIVE_PATH = 212;
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

function fixedSevenZip(rawPath) {
  const architecture = process.arch;
  const sha256 = SEVEN_ZIP_SHA256[architecture];
  if (!sha256) throw runtimeError("software_manager_7z_architecture_unsupported");
  const sevenZipPath = requireWindowsPath(rawPath ?? bundledSevenZipPath(), "software_manager_7z_path_invalid");
  const controlledPath = bundledSevenZipPath();
  if (sevenZipPath.toLowerCase() !== controlledPath.toLowerCase()) {
    throw runtimeError("software_manager_7z_path_rejected");
  }
  return Object.freeze({ sevenZipPath, sevenZipSha256: sha256 });
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
      let record = null;
      try {
        record = component
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
        const receipt = await workspace.downloadPrepared(record, { asset, signal, onProgress });
        return await record.promotePartNoReplace(receipt);
      } catch (error) {
        if (record === null) throw error;
        let cleanupError = null;
        try { await workspace.cleanupAbandonedPrepare(record); } catch (failure) { cleanupError = failure; }
        if (cleanupError) {
          throw new AggregateError([error, cleanupError], error.message, { cause: error });
        }
        throw error;
      }
    },
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
    async ensureRuntimeDirectories() {
      await fileCapabilities.ensureManagedDirectoriesNoFollow(
        path.win32.dirname(dataRoot),
        [path.win32.basename(dataRoot)],
      );
      return fileCapabilities.ensureManagedDirectoriesNoFollow(dataRoot, [
        "state", "journal", "catalog", "logs", "skill-swaps", "skill-prepares",
      ]);
    },
    async ensureInstallRootDirectory(rootPath) {
      return fileCapabilities.ensureManagedDirectoriesNoFollow(
        path.win32.dirname(rootPath),
        [path.win32.basename(rootPath)],
      );
    },
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
      // A fresh Windows profile may have .codex but no skills directory yet.
      // Installing a Skill is the operation that should create this managed
      // location; requiring users to pre-create it turns first install into a
      // failed/hanging-looking task. Create each direct child through the
      // no-follow Win32 capability so reparses and parent swaps are rejected.
      const codexDir = path.win32.join(homeDir, ".codex");
      await fileCapabilities.ensureManagedDirectoriesNoFollow(homeDir, [".codex"]);
      await fileCapabilities.ensureManagedDirectoriesNoFollow(codexDir, ["skills"]);
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
    getAvailableDiskBytes: async (rootPath) => {
      const stats = await fsPromises.statfs(rootPath);
      const available = BigInt(stats.bavail) * BigInt(stats.bsize);
      return available > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(available);
    },
  });
}

const DEFAULT_FACTORIES = Object.freeze({
  createWindowsInfrastructure: createDefaultWindowsInfrastructure,
  createCatalogProvider: (options) => createCachedCatalogProvider(options),
  readBundledCatalogEnvelope,
  createInstallRootResolver: (options) => createInstallRootResolver(options),
  createRootAdapters: createDefaultRootAdapters,
  createWindowsHost(options) {
    const shortcutFileApi = createLazyShortcutFileApi({
      getDesktopCapability: options.getDesktopCapability,
      fileCapabilities: options.infrastructure.fileCapabilities,
    });
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
  defaultInstallRoot = null,
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
  const exactDefaultInstallRoot = defaultInstallRoot === null
    ? null
    : requireWindowsPath(defaultInstallRoot, "software_manager_default_install_root_invalid");
  if (catalogUrl !== FIXED_CATALOG_URL) throw runtimeError("software_manager_catalog_url_rejected");
  if (publicKeyPem !== null && typeof publicKeyPem !== "string") throw runtimeError("software_manager_catalog_key_invalid");
  requireRecord(env, "software_manager_environment_invalid");
  const runtimeEnv = Object.freeze({ ...env });
  const injectedFactories = requireRecord(runtimeFactories, "software_manager_factories_invalid");
  const injectedEnsureDefaultInstallRoot = typeof injectedFactories.ensureDefaultInstallRoot === "function"
    ? injectedFactories.ensureDefaultInstallRoot
    : null;
  const sevenZip = fixedSevenZip(sevenZipPath);
  const factories = Object.freeze({ ...DEFAULT_FACTORIES, ...injectedFactories });
  const infrastructure = await factories.createWindowsInfrastructure({
    platform, dataRoot: exactDataRoot, homeDir: exactHomeDir, getDesktopPath, env: runtimeEnv, koffi,
  });
  for (const name of [
    "ensureRuntimeDirectories", "ensureInstallRootDirectory", "authorizeRoot", "createSlots", "getDesktopCapability", "getSkillsRootCapability",
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
    bundledEnvelope: factories.readBundledCatalogEnvelope({ catalogUrl }),
  });
  const installRootResolver = factories.createInstallRootResolver({
    authorizeRoot: infrastructure.authorizeRoot.bind(infrastructure),
    getPersistedRoot: async () => (await ownershipStore.load()).installRoot,
  });
  for (const name of ["getCurrentToken", "choose", "resolve", "adopt", "discard", "restoreOwnedRoot", "clearCurrent"]) {
    requireMethod(installRootResolver, name, "software_manager_install_root_resolver_invalid");
  }
  const getDesktopCapability = memoizeAsync(() => infrastructure.getDesktopCapability());
  const getSkillsRootCapability = memoizeAsync(() => infrastructure.getSkillsRootCapability());
  const getWindowsHost = memoizeAsync(() => factories.createWindowsHost({
    platform, infrastructure, getDesktopCapability, env: runtimeEnv, electronShell, execFile, spawn, koffi,
  }));
  const rootRuntimes = new WeakMap();

  function createSlots(installRootCapability) {
    return infrastructure.createSlots({ installRootCapability });
  }

  async function createRootRuntime({ catalogService, installRootCapability }) {
    if (!catalogService || typeof catalogService !== "object"
      || !installRootCapability || typeof installRootCapability !== "object") {
      throw runtimeError("software_manager_root_runtime_invalid");
    }
    let catalogs = rootRuntimes.get(installRootCapability);
    if (!catalogs) {
      catalogs = new WeakMap();
      rootRuntimes.set(installRootCapability, catalogs);
    }
    let created = catalogs.get(catalogService);
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
      catalogs.set(catalogService, created);
      created.catch(() => {
        if (catalogs.get(catalogService) === created) catalogs.delete(catalogService);
      });
    }
    return created;
  }

  let recoveryInFlight = null;
  const recoverOffline = () => {
    if (recoveryInFlight !== null) return recoveryInFlight;
    const operation = Promise.resolve().then(async () => {
      await infrastructure.ensureRuntimeDirectories();
      // Establish the display and capability for the install root before
      // recovering interrupted work. A broken recovery record must not leave
      // the page with a placeholder path or disable choosing another root.
      const beforeRecovery = await ownershipStore.load();
      let initialRoot = beforeRecovery.installRoot;
      if (initialRoot === null) {
        try {
          initialRoot = await infrastructure.inferSkillInstallRoot(structuredClone(beforeRecovery));
        } catch (error) {
          // A malformed or incomplete abandoned Skill record is still handled
          // by the strict recovery pass below. It must not prevent the safe
          // default root from being selected and displayed first.
          if (exactDefaultInstallRoot === null) throw error;
          initialRoot = null;
        }
      }
      const selectedBeforeRecovery = typeof installRootResolver.getCurrentPath === "function"
        ? installRootResolver.getCurrentPath()
        : null;
      if (typeof initialRoot === "string" && selectedBeforeRecovery !== initialRoot) {
        await installRootResolver.restoreOwnedRoot(initialRoot);
      } else if (initialRoot === null && exactDefaultInstallRoot !== null
        && selectedBeforeRecovery !== exactDefaultInstallRoot) {
        if (injectedEnsureDefaultInstallRoot) await injectedEnsureDefaultInstallRoot(exactDefaultInstallRoot);
        else await infrastructure.ensureInstallRootDirectory(exactDefaultInstallRoot);
        const chosen = await installRootResolver.choose(exactDefaultInstallRoot);
        const token = typeof chosen === "string" ? chosen : chosen?.token;
        if (typeof token !== "string") throw runtimeError("software_manager_install_root_invalid");
        await installRootResolver.adopt(token);
      }
      const recovered = await recoverLocalTransactions({
        ownershipStore,
        journal,
        authorizeRoot: infrastructure.authorizeRoot.bind(infrastructure),
        createSlots: ({ installRootCapability }) => createSlots(installRootCapability),
      });
      let current = await ownershipStore.load();
      let installRoot = recovered.installRoot ?? current.installRoot;
      if (installRoot === null) {
        try {
          installRoot = await infrastructure.inferSkillInstallRoot(structuredClone(current));
        } catch (error) {
          const selected = typeof installRootResolver.getCurrentPath === "function"
            ? installRootResolver.getCurrentPath()
            : null;
          if (typeof selected !== "string") throw error;
          installRoot = selected;
        }
      }
      if (installRoot === null && typeof installRootResolver.getCurrentPath === "function") {
        installRoot = installRootResolver.getCurrentPath();
      }
      let installRootCapability = null;
      if (typeof installRoot === "string") {
        installRootCapability = await infrastructure.authorizeRoot(installRoot);
      }
      if (["skill-replace", "skill-uninstall"].includes(current.activeTask?.kind)) {
        const skillsRootCapability = await getSkillsRootCapability();
        const skillRecovery = await infrastructure.recoverActiveSkillTransaction({
          ownership: structuredClone(current), installRootCapability, skillsRootCapability,
        });
        if (skillRecovery?.status === "recovered" && installRootCapability) {
          await infrastructure.cleanupAbandonedPreparedSkills({
            installRootCapability, heldLease: skillRecovery?.heldLease ?? null,
          });
        }
      } else if (installRootCapability) {
        await infrastructure.cleanupAbandonedPreparedSkills({ installRootCapability, heldLease: null });
      }
      current = await ownershipStore.load();
      let restoredRoot = current.installRoot;
      const selectedRoot = typeof installRootResolver.getCurrentPath === "function"
        ? installRootResolver.getCurrentPath()
        : null;
      if (restoredRoot === null && exactDefaultInstallRoot !== null
        && typeof selectedRoot === "string"
        && selectedRoot.toLowerCase() === exactDefaultInstallRoot.toLowerCase()) {
        restoredRoot = selectedRoot;
      }
      if (typeof restoredRoot === "string") {
        if (restoredRoot !== selectedRoot) await installRootResolver.restoreOwnedRoot(restoredRoot);
      } else if (exactDefaultInstallRoot !== null) {
        if (injectedEnsureDefaultInstallRoot) await injectedEnsureDefaultInstallRoot(exactDefaultInstallRoot);
        else await infrastructure.ensureInstallRootDirectory(exactDefaultInstallRoot);
        const chosen = await installRootResolver.choose(exactDefaultInstallRoot);
        const token = typeof chosen === "string" ? chosen : chosen?.token;
        if (typeof token !== "string") throw runtimeError("software_manager_install_root_invalid");
        await installRootResolver.adopt(token);
        restoredRoot = exactDefaultInstallRoot;
      } else {
        await installRootResolver.clearCurrent();
      }
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
