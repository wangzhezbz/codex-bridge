import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bundledSevenZipPath,
  createDefaultSkillRecoveryHooks,
  createLazyShortcutFileApi,
  createPinnedSevenZipExecution,
  createProductionSoftwareManagerService,
} from "../desktop/software-manager/runtime-factory.mjs";
import { createCapabilityRecordStore } from "../desktop/software-manager/capability-record-store.mjs";
import { authorizeInstallRoot, authorizeSkillsRoot } from "../desktop/software-manager/path-policy.mjs";
import { createSkillPrepareJournal } from "../desktop/software-manager/skill-prepare-journal.mjs";
import { createSkillSwapJournal } from "../desktop/software-manager/skill-swap-journal.mjs";

const CATALOG_URL = "https://shanhaiyouling.com/codexbridge-install-test/component-catalog.json";
const SEVEN_ZIP_PATH = bundledSevenZipPath();

function memoryRecoveryFs() {
  let sequence = 0;
  const entries = new Map();
  const deleted = [];
  const skillTrees = new Map();
  const skillKey = (spec) => JSON.stringify(spec);
  const handle = (node) => ({
    entry: { name: node.name, identity: node.identity },
    async readFile() { return node.data; },
    async writeFile(value) { node.data = String(value); },
    async sync() {}, async close() {},
  });
  const directory = () => ({
    async listFileNamesNoFollow() { return [...entries.keys()]; },
    async openFileNoFollow(name, flags) {
      if (flags === "r") return entries.has(name) ? handle(entries.get(name)) : null;
      if (flags !== "wx" || entries.has(name)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      const node = { name, identity: ++sequence, data: "" }; entries.set(name, node); return handle(node);
    },
    async unlinkEntryNoFollow(entry) { entries.delete(entry.name); },
    async renameEntryNoFollow(entry, destination) {
      const node = entries.get(entry.name); entries.delete(entry.name); node.name = destination; entries.set(destination, node);
    },
    async close() {},
  });
  return {
    deleted,
    async openJournalDirectoryNoFollow() { return directory(); },
    async verifyPreparedSkillNoFollow() {},
    async openSkillRootNoFollow() {
      return {
        rootPath: "C:\\Users\\Example\\.codex\\skills",
        rootIdentity: { volumeSerial: "volume", fileId: "skills-root" },
        async inspectDirectChildNoFollow(spec) {
          return structuredClone(skillTrees.get(skillKey(spec)) ?? { kind: "absent" });
        },
        async stagePreparedTreeNoFollow() {},
        async recoverPreparedTreeNoFollow({ skillId, swapId, expected }) {
          const evidence = {
            kind: "directory", identity: { volumeSerial: "volume", fileId: `prepared-${swapId}` },
            treeDigest: expected.treeDigest, manifestDigest: expected.manifestDigest,
            skillMdSha256: expected.skillMdSha256,
          };
          skillTrees.set(skillKey({ kind: "prepared", skillId, swapId }), evidence);
          return structuredClone(evidence);
        },
        async renameDirectChildNoReplace({ from, to }) {
          const evidence = skillTrees.get(skillKey(from));
          if (!evidence) throw new Error("missing_skill_tree");
          skillTrees.delete(skillKey(from));
          skillTrees.set(skillKey(to), evidence);
          return structuredClone(evidence);
        },
        async deleteDirectChildTreeNoFollow({ child }) { skillTrees.delete(skillKey(child)); },
        async close() {},
      };
    },
    async inspectPreparedSkillSourceNoFollow() {},
    async validatePreparedSkillSourceForDeletionNoFollow() {},
    async deletePreparedSkillSourceNoFollow(plan) { deleted.push(plan); },
  };
}

function memoryRecordCapabilities(initial = {}) {
  const files = new Map(Object.entries(initial));
  const opened = [];
  return {
    files,
    opened,
    async openStateDirectoryNoFollow() {
      return {
        async openFileNoFollow(name, flags) {
          opened.push(name);
          if (flags !== "r") throw new Error("unexpected_write");
          if (!files.has(name)) return null;
          return {
            entry: { name },
            async readFile() { return files.get(name); },
            async close() {},
          };
        },
        async unlinkEntryNoFollow() { throw new Error("unexpected_unlink"); },
        async renameEntryNoFollow() { throw new Error("unexpected_rename"); },
        async close() {},
      };
    },
  };
}

test("capability record store falls back only from corrupt primary JSON and fails closed when backup is corrupt", async () => {
  const recoveredFs = memoryRecordCapabilities({
    "catalog.json": "{broken",
    "catalog.json.bak": JSON.stringify({ schemaVersion: 1, payload: "trusted-backup" }),
  });
  const recovered = createCapabilityRecordStore({
    fileCapabilities: recoveredFs, directoryPath: "C:\\data", fileName: "catalog.json",
  });
  assert.deepEqual(await recovered.read(), { schemaVersion: 1, payload: "trusted-backup" });
  assert.deepEqual(recoveredFs.opened, ["catalog.json", "catalog.json.bak"]);

  const corruptFs = memoryRecordCapabilities({ "catalog.json": "[]", "catalog.json.bak": "null" });
  const corrupt = createCapabilityRecordStore({
    fileCapabilities: corruptFs, directoryPath: "C:\\data", fileName: "catalog.json",
  });
  await assert.rejects(corrupt.read(), /software_manager_record_store_corrupt/u);

  const ioError = Object.assign(new Error("access_denied"), { code: "EACCES" });
  const deniedFs = memoryRecordCapabilities({ "catalog.json": "{}", "catalog.json.bak": "{}" });
  deniedFs.openStateDirectoryNoFollow = async () => ({
    async openFileNoFollow() { throw ioError; },
    async unlinkEntryNoFollow() {}, async renameEntryNoFollow() {}, async close() {},
  });
  const denied = createCapabilityRecordStore({
    fileCapabilities: deniedFs, directoryPath: "C:\\data", fileName: "catalog.json",
  });
  await assert.rejects(denied.read(), (error) => error === ioError);
});

function result(componentId, action, status = "skipped") {
  return {
    componentId,
    action,
    status,
    versionBefore: null,
    versionAfter: null,
    message: `${componentId}_${action}_${status}`,
    rollbackAvailable: false,
  };
}

function adapters() {
  const component = (id) => Object.freeze({
    inspectInstalled: async () => result(id, "inspect"),
    prepare: async () => result(id, "prepare"),
    commit: async () => result(id, "commit"),
    verify: async () => result(id, "verify"),
    uninstall: async () => result(id, "uninstall"),
    rollback: async () => result(id, "rollback"),
  });
  return Object.freeze({
    chatgpt: component("chatgpt"),
    v2rayn: component("v2rayn"),
    git: component("git"),
    skills: Object.freeze({
      inspectInstalled: async ({ skillIds = [] }) => skillIds.map((id) => result(id, "inspect")),
      prepare: async ({ skillIds = [] }) => skillIds.map((id) => result(id, "prepare")),
      commit: async ({ skillIds = [] }) => skillIds.map((id) => result(id, "commit")),
      verify: async ({ skillIds = [] }) => skillIds.map((id) => result(id, "verify")),
      uninstall: async ({ skillIds = [] }) => skillIds.map((id) => result(id, "uninstall")),
      rollback: async ({ skillIds = [] }) => skillIds.map((id) => result(id, "rollback")),
      discardPrepared: async () => [],
    }),
  });
}

function catalog() {
  const components = new Map(["chatgpt", "v2rayn", "git"].map((id) => [id, Object.freeze({
    id,
    name: id,
    version: "1.0.0",
    size: 1,
    sha256: "a".repeat(64),
    assetUrl: `https://shanhaiyouling.com/codexbridge-install-test/${id}.zip`,
    format: id === "v2rayn" ? "7z" : id === "git" ? "exe" : "zip",
    supportsRollback: id !== "git",
  })]));
  return Object.freeze({
    getComponent(id) { return components.get(id); },
    getSkill() { throw new Error("missing"); },
    listSkills() { return []; },
  });
}

function state(installRoot = null) {
  return {
    schemaVersion: 1,
    generation: 0,
    installRoot,
    components: {},
    skills: {},
    shortcuts: [],
    rollback: null,
    activeTask: null,
    lastTask: null,
  };
}

function fixture({
  platform = "win32",
  publicKeyPem = "trusted-key",
  currentCatalog = catalog(),
  persistedRoot = null,
  skillAuthorityError = null,
  skillAuthorityFailures = 0,
  includeSkillRecoveryHooks = false,
  skillRecoveryStatus = undefined,
  activeTask = null,
  rootFactories = null,
  catalogSequence = null,
} = {}) {
  const calls = [];
  let ownership = state(persistedRoot);
  ownership.activeTask = activeTask;
  let currentToken = null;
  let tokenSequence = 0;
  let catalogRefreshIndex = 0;
  let slotRecoveryOwnership;
  const tokens = new Map();
  const journal = {
    scopeId: "c:\\runtime-data\\journal",
    async listTransactions() { calls.push("journal:list"); return []; },
    async clear() { calls.push("journal:clear"); },
  };
  const ownershipStore = {
    async load() { calls.push("ownership:load"); return structuredClone(ownership); },
    async save(next) { calls.push("ownership:save"); ownership = structuredClone(next); return structuredClone(next); },
  };
  const runtimeFactories = {
    createWindowsInfrastructure(options) {
      calls.push(["windows-infrastructure", options.platform]);
      let remainingSkillFailures = skillAuthorityFailures;
      const infrastructure = {
        ownershipStore,
        journal,
        catalogCache: Object.freeze({ readEnvelope: async () => null, replaceEnvelope: async () => {} }),
        logSink: Object.freeze({ async write(entry) { calls.push(["log", entry.phase]); } }),
        rootFactories,
        async authorizeRoot(rootPath) {
          calls.push(["authorize-root", rootPath]);
          return Object.freeze({ kind: "root", path: rootPath, nonce: ++tokenSequence });
        },
        async createSlots({ installRootCapability }) {
          calls.push(["slots", installRootCapability]);
          return Object.freeze({
            async recoverJournalTransactions() {
              calls.push("slots:recover");
              if (slotRecoveryOwnership !== undefined) ownership = structuredClone(slotRecoveryOwnership);
              return [];
            },
          });
        },
        async getDesktopCapability() {
          calls.push("desktop-authority");
          return Object.freeze({ kind: "desktop" });
        },
        async getSkillsRootCapability() {
          calls.push("skills-authority");
          if (skillAuthorityError || remainingSkillFailures > 0) {
            remainingSkillFailures -= 1;
            throw skillAuthorityError ?? Object.assign(new Error("temporary-denial"), { code: "EACCES" });
          }
          return Object.freeze({ kind: "skills" });
        },
        async inferSkillInstallRoot() { calls.push("skills:infer-root"); return null; },
        async recoverActiveSkillTransaction() {
          if (includeSkillRecoveryHooks) calls.push("skills:recover-active");
          if (skillRecoveryStatus !== undefined) {
            return Object.freeze({ status: skillRecoveryStatus, state: structuredClone(ownership), heldLease: null });
          }
          ownership.activeTask = null;
          return Object.freeze({ status: "recovered", state: structuredClone(ownership), heldLease: null });
        },
        async cleanupAbandonedPreparedSkills() {
          if (includeSkillRecoveryHooks) calls.push("skills:cleanup-prepared");
        },
      };
      return Object.freeze(infrastructure);
    },
    createCatalogProvider(options) {
      calls.push(["catalog-provider", options.publicKeyPem]);
      return Object.freeze({
        async getCurrent() {
          calls.push("catalog:get");
          return options.publicKeyPem === null ? null : (catalogSequence?.[Math.max(0, catalogRefreshIndex - 1)] ?? currentCatalog);
        },
        async refresh() {
          calls.push("catalog:refresh");
          if (options.publicKeyPem === null) return null;
          const selected = catalogSequence?.[Math.min(catalogRefreshIndex, catalogSequence.length - 1)] ?? currentCatalog;
          catalogRefreshIndex += 1;
          return selected;
        },
      });
    },
    createRootAdapters(options) {
      calls.push(["root-adapters", options.installRootCapability, options.catalogService]);
      return adapters();
    },
    createWindowsHost(options) {
      calls.push(["windows-host", options.platform]);
      return Object.freeze({ marker: "host" });
    },
  };
  const installRootResolver = {
    getCurrentToken() { return currentToken; },
    async choose(rootPath) {
      const capability = await runtimeFactories.lastInfrastructure.authorizeRoot(rootPath);
      const token = `root_token_${String(++tokenSequence).padStart(8, "0")}`;
      tokens.set(token, capability);
      return { token };
    },
    async resolve(token) { return tokens.get(token); },
    async adopt(token) { currentToken = token; return token; },
    async discard(token) { if (token !== currentToken) tokens.delete(token); },
    async restoreOwnedRoot(rootPath) {
      if (rootPath === null) return null;
      const chosen = await this.choose(rootPath);
      await this.adopt(chosen.token);
      return chosen.token;
    },
    async clearCurrent() {
      calls.push("resolver:clear");
      const prior = currentToken;
      currentToken = null;
      if (prior !== null) tokens.delete(prior);
    },
  };
  const createInfrastructure = runtimeFactories.createWindowsInfrastructure;
  runtimeFactories.createWindowsInfrastructure = (options) => {
    const infrastructure = createInfrastructure(options);
    runtimeFactories.lastInfrastructure = infrastructure;
    return infrastructure;
  };
  runtimeFactories.createInstallRootResolver = () => installRootResolver;
  return {
    calls,
    currentCatalog,
    getOwnership() { return structuredClone(ownership); },
    installRootResolver,
    setSlotRecoveryOwnership(next) { slotRecoveryOwnership = structuredClone(next); },
    runtimeFactories,
    options: {
      platform,
      dataRoot: "C:\\runtime-data",
      homeDir: "C:\\Users\\Example",
      getDesktopPath: () => "C:\\Users\\Example\\Desktop",
      env: { LOCALAPPDATA: "C:\\Users\\Example\\AppData\\Local" },
      electronShell: {},
      fetchImpl: async () => { calls.push("fetch"); throw new Error("network_forbidden"); },
      execFile: async () => { calls.push("exec"); throw new Error("process_forbidden"); },
      spawn: async () => { calls.push("spawn"); throw new Error("process_forbidden"); },
      publicKeyPem,
      catalogUrl: CATALOG_URL,
      sevenZipPath: SEVEN_ZIP_PATH,
      koffi: { marker: "inert-koffi" },
      runtimeFactories,
    },
  };
}

test("non-Windows construction returns a disabled runtime without native construction", async () => {
  const harness = fixture({ platform: "darwin" });
  const runtime = await createProductionSoftwareManagerService(harness.options);
  assert.deepEqual(Object.keys(runtime), ["service", "recoverOffline", "selectInstallRoot"]);
  const snapshot = await runtime.service.getSnapshot();
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.readOnly, true);
  assert.equal(harness.calls.some((entry) => Array.isArray(entry) && entry[0] === "windows-infrastructure"), false);
});

test("null trust key stays read-only without fetch or adapter construction", async () => {
  const harness = fixture({ publicKeyPem: null });
  const runtime = await createProductionSoftwareManagerService(harness.options);
  const snapshot = await runtime.service.getSnapshot();
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.catalog.available, false);
  assert.equal(harness.calls.includes("fetch"), false);
  assert.equal(harness.calls.some((entry) => Array.isArray(entry) && entry[0] === "root-adapters"), false);
});

test("construction is side-effect free and catalog refresh remains explicit", async () => {
  const harness = fixture();
  const runtime = await createProductionSoftwareManagerService(harness.options);
  assert.equal(harness.calls.includes("catalog:get"), false);
  assert.equal(harness.calls.includes("catalog:refresh"), false);
  assert.equal(harness.calls.includes("fetch"), false);
  assert.equal(harness.calls.includes("exec"), false);
  assert.equal(harness.calls.includes("spawn"), false);
  assert.equal(harness.calls.includes("desktop-authority"), false);
  assert.equal(harness.calls.includes("skills-authority"), false);
  await runtime.service.refresh();
  assert.equal(harness.calls.filter((entry) => entry === "catalog:refresh").length, 1);
});

test("adapter creation waits for both a catalog and one selected root capability", async () => {
  const harness = fixture();
  const runtime = await createProductionSoftwareManagerService(harness.options);
  await runtime.service.refresh();
  assert.equal(harness.calls.some((entry) => Array.isArray(entry) && entry[0] === "root-adapters"), false);
  await runtime.selectInstallRoot("D:\\CBApps");
  const created = harness.calls.filter((entry) => Array.isArray(entry) && entry[0] === "root-adapters");
  assert.equal(created.length, 1);
  assert.equal(created[0][1].path, "D:\\CBApps");
  assert.equal(created[0][2], harness.currentCatalog);
});

test("each selected root creates only root-bound adapters and slots without persisting tokens", async () => {
  const harness = fixture();
  const runtime = await createProductionSoftwareManagerService(harness.options);
  await runtime.selectInstallRoot("D:\\One");
  await runtime.selectInstallRoot("E:\\Two");
  const roots = harness.calls
    .filter((entry) => Array.isArray(entry) && entry[0] === "root-adapters")
    .map((entry) => entry[1].path);
  assert.deepEqual(roots, ["D:\\One", "E:\\Two"]);
  assert.equal(harness.calls.some((entry) => Array.isArray(entry) && entry[0] === "slots" && !entry[1]), false);
  assert.equal(JSON.stringify(await harness.runtimeFactories.lastInfrastructure.ownershipStore.load()).includes("root_token_"), false);
});

test("catalog refresh rebuilds adapters for the same root capability with the new catalog identity", async () => {
  const firstCatalog = catalog();
  const secondCatalog = catalog();
  const harness = fixture({ catalogSequence: [firstCatalog, secondCatalog] });
  const runtime = await createProductionSoftwareManagerService(harness.options);
  await runtime.service.refresh();
  await runtime.selectInstallRoot("D:\\CBApps");
  await runtime.service.refresh();
  const compositions = harness.calls.filter((entry) => Array.isArray(entry) && entry[0] === "root-adapters");
  assert.equal(compositions.length, 2);
  assert.equal(compositions[0][2], firstCatalog);
  assert.equal(compositions[1][2], secondCatalog);
  assert.equal(compositions[0][1], compositions[1][1]);
});

test("root adapter composition receives the fixed bundled 7z path and pinned hash", async () => {
  const harness = fixture();
  let composition;
  harness.runtimeFactories.createRootAdapters = (options) => { composition = options; return adapters(); };
  const runtime = await createProductionSoftwareManagerService(harness.options);
  await runtime.selectInstallRoot("D:\\CBApps");
  assert.equal(composition.sevenZipPath, SEVEN_ZIP_PATH);
  assert.equal(composition.sevenZipSha256, "b0cfdeaf429f5cc53f85123dd8f5a5feb92c19d31aa34df257edf9a26be05f95");
});

test("default root composition binds workspace, files, and adapters to the selected capability", async () => {
  const seen = {};
  let managerPreparedCalls = 0;
  let workspacePreparedCalls = 0;
  const rootFactories = {
    createDownloadManager(options) {
      seen.download = options;
      return { async downloadPrepared() { managerPreparedCalls += 1; throw new Error("path_reopen_forbidden"); } };
    },
    createInstallerWorkspace(options) {
      seen.workspace = options;
      return {
        async prepareDownloadFile({ componentId, version, extension, size, sha256 }) {
          const record = {
            path: `D:\\CBApps\\downloads\\${componentId}-${version}${extension}`,
            partPath: `D:\\CBApps\\downloads\\${componentId}-${version}${extension}.part`,
            size, sha256,
            async promotePartNoReplace(receipt) { assert.equal(receipt.bound, true); return { path: this.path }; },
          };
          return record;
        },
        async downloadPrepared(record, { asset }) {
          workspacePreparedCalls += 1;
          assert.equal(record.partPath.endsWith(".part"), true);
          assert.equal(asset.url, "https://shanhaiyouling.com/codexbridge-install-test/chatgpt.zip");
          return { bound: true };
        },
      };
    },
    createArchiveService(options) { seen.archive = options; return { extractArchive: async () => {} }; },
    createComponentFileService(options) { seen.files = options; return { kind: "files" }; },
    createRetainedInstallerStore(options) {
      seen.retained = options;
      return { hashFile: async () => "a".repeat(64) };
    },
    createGitIdentityCapabilities(options) { seen.git = options; return { kind: "git-identity" }; },
    createComponentAdapters(options) { seen.adapters = options; return adapters(); },
  };
  const harness = fixture({ rootFactories });
  delete harness.runtimeFactories.createRootAdapters;
  const runtime = await createProductionSoftwareManagerService(harness.options);
  await runtime.selectInstallRoot("D:\\CBApps");
  assert.equal(seen.workspace.installRootCapability.path, "D:\\CBApps");
  assert.equal(seen.files.installRootCapability, seen.workspace.installRootCapability);
  assert.equal(seen.retained.installRootCapability, seen.workspace.installRootCapability);
  assert.equal(seen.adapters.installRootCapability, seen.workspace.installRootCapability);
  assert.equal(typeof seen.archive.spawnFile, "function");
  assert.equal(typeof seen.adapters.skillsRootCapability, "function");
  assert.equal(typeof seen.adapters.desktopCapability, "function");
  assert.equal(harness.calls.includes("desktop-authority"), false);
  assert.equal(harness.calls.includes("skills-authority"), false);
  assert.equal(harness.calls.includes("windows-host"), false);
  await seen.adapters.downloader.download({
    asset: {
      url: "https://shanhaiyouling.com/codexbridge-install-test/chatgpt.zip",
      size: 1,
      sha256: "a".repeat(64),
    },
    destination: "D:\\CBApps\\downloads\\chatgpt-1.0.0.zip",
  });
  assert.equal(workspacePreparedCalls, 1);
  assert.equal(managerPreparedCalls, 0);
});

test("production composition rejects a caller-selected 7z binary before native construction", async () => {
  await assert.rejects(createProductionSoftwareManagerService({
    platform: "win32",
    dataRoot: "C:\\runtime-data",
    homeDir: "C:\\Users\\Example",
    env: {},
    publicKeyPem: null,
    catalogUrl: CATALOG_URL,
    sevenZipPath: "C:\\attacker\\node_modules\\7zip-bin\\win\\x64\\7za.exe",
  }), /software_manager_7z_path_rejected/u);
});

test("runtime factory injection cannot authorize a caller-selected 7z binary", async () => {
  const harness = fixture();
  await assert.rejects(createProductionSoftwareManagerService({
    ...harness.options,
    sevenZipPath: "C:\\attacker\\node_modules\\7zip-bin\\win\\x64\\7za.exe",
  }), /software_manager_7z_path_rejected/u);
  assert.equal(harness.calls.some((entry) => Array.isArray(entry) && entry[0] === "windows-infrastructure"), false);
});

test("pinned 7z execution rechecks every spawn and holds the stream pin until completion", async (t) => {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "codexbridge-7z-"));
  const executable = path.join(directory, "7za.exe");
  await fsPromises.writeFile(executable, "trusted");
  t.after(async () => {
    await fsPromises.unlink(executable).catch(() => {});
    await fsPromises.rmdir(directory).catch(() => {});
  });
  let pinsClosed = 0;
  let execCalls = 0;
  let spawnCalls = 0;
  let identityChanged = false;
  let finishStream;
  const execution = createPinnedSevenZipExecution({
    fileCapabilities: {
      async pinArchiveFileNoFollow() {
        return {
          async assertStableNoFollow() {
            if (identityChanged) throw Object.assign(new Error("identity_changed"), { code: "identity_changed" });
          },
          async close() { pinsClosed += 1; },
        };
      },
    },
    sevenZipPath: executable,
    sevenZipSha256: createHash("sha256").update("trusted").digest("hex"),
    async execFile() { execCalls += 1; return { stdout: "", stderr: "" }; },
    async spawn() {
      spawnCalls += 1;
      return {
        stdout: { pipe() {} },
        stderr: { async *[Symbol.asyncIterator]() {} },
        cancel() {},
        completed: new Promise((resolve) => { finishStream = resolve; }),
      };
    },
  });
  await execution.spawnFile(executable, ["t"], {});
  assert.equal(execCalls, 1);
  await assert.rejects(execution.spawnFile(path.join(directory, "other.exe"), [], {}), /software_manager_7z_path_rejected/u);
  assert.equal(execCalls, 1);
  await fsPromises.writeFile(executable, "tampered-after-construction");
  await assert.rejects(execution.spawnFile(executable, [], {}), /software_manager_7z_hash_mismatch/u);
  assert.equal(execCalls, 1);
  await fsPromises.writeFile(executable, "trusted");
  identityChanged = true;
  await assert.rejects(execution.spawnFile(executable, [], {}), /identity_changed/u);
  assert.equal(execCalls, 1);
  identityChanged = false;
  const child = await execution.spawnStream(executable, ["x"], {});
  assert.equal(spawnCalls, 1);
  const closedBeforeCompletion = pinsClosed;
  finishStream();
  await child.completed;
  assert.equal(pinsClosed, closedBeforeCompletion + 1);
});

test("pinned 7z stream preserves prototype accessors and binds cancel to the started child", async (t) => {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "codexbridge-7z-abi-"));
  const executable = path.join(directory, "7za.exe");
  await fsPromises.writeFile(executable, "trusted");
  t.after(async () => {
    await fsPromises.unlink(executable).catch(() => {});
    await fsPromises.rmdir(directory).catch(() => {});
  });
  const stdout = { pipe() {} };
  const stderr = { async *[Symbol.asyncIterator]() {} };
  class Child {
    get stdout() { return stdout; }
    get stderr() { return stderr; }
    get completed() { return Promise.resolve({ exitCode: 0 }); }
    cancel() { assert.equal(this, child); this.cancelled = true; }
  }
  const child = new Child();
  const execution = createPinnedSevenZipExecution({
    fileCapabilities: {
      async pinArchiveFileNoFollow() {
        return { async assertStableNoFollow() {}, async close() {} };
      },
    },
    sevenZipPath: executable,
    sevenZipSha256: createHash("sha256").update("trusted").digest("hex"),
    async execFile() {},
    async spawn() { return child; },
  });
  const stream = await execution.spawnStream(executable, [], {});
  assert.equal(stream.stdout, stdout);
  assert.equal(stream.stderr, stderr);
  stream.cancel();
  assert.equal(child.cancelled, true);
  assert.deepEqual(await stream.completed, { exitCode: 0 });
});

test("invalid pinned 7z child is cancelled and settled before its executable pin closes", async (t) => {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "codexbridge-7z-invalid-"));
  const executable = path.join(directory, "7za.exe");
  await fsPromises.writeFile(executable, "trusted");
  t.after(async () => {
    await fsPromises.unlink(executable).catch(() => {});
    await fsPromises.rmdir(directory).catch(() => {});
  });
  const order = [];
  let finish;
  const execution = createPinnedSevenZipExecution({
    fileCapabilities: {
      async pinArchiveFileNoFollow() {
        return { async assertStableNoFollow() {}, async close() { order.push("close"); } };
      },
    },
    sevenZipPath: executable,
    sevenZipSha256: createHash("sha256").update("trusted").digest("hex"),
    async execFile() {},
    async spawn() {
      return {
        cancel() { order.push("cancel"); finish({ exitCode: 1 }); },
        completed: new Promise((resolve) => { finish = resolve; }),
      };
    },
  });
  await assert.rejects(execution.spawnStream(executable, [], {}), /software_manager_spawn_result_invalid/u);
  assert.deepEqual(order, ["cancel", "close"]);
});

test("pinned 7z completion preserves the process failure when pin cleanup also fails", async (t) => {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "codexbridge-7z-errors-"));
  const executable = path.join(directory, "7za.exe");
  await fsPromises.writeFile(executable, "trusted");
  t.after(async () => {
    await fsPromises.unlink(executable).catch(() => {});
    await fsPromises.rmdir(directory).catch(() => {});
  });
  const primary = new Error("process_failed");
  const execution = createPinnedSevenZipExecution({
    fileCapabilities: {
      async pinArchiveFileNoFollow() {
        return { async assertStableNoFollow() {}, async close() { throw new Error("pin_close_failed"); } };
      },
    },
    sevenZipPath: executable,
    sevenZipSha256: createHash("sha256").update("trusted").digest("hex"),
    async execFile() {},
    async spawn() {
      return {
        stdout: { pipe() {} }, stderr: { async *[Symbol.asyncIterator]() {} }, cancel() {},
        completed: Promise.reject(primary),
      };
    },
  });
  await assert.rejects(execution.spawnStream(executable, [], {}).then(({ completed }) => completed), (error) => {
    assert.equal(error instanceof AggregateError, true);
    assert.equal(error.cause, primary);
    assert.deepEqual(error.errors.map(({ message }) => message), ["process_failed", "pin_close_failed"]);
    return true;
  });
});

test("pinned 7z file execution preserves the process failure when pin cleanup also fails", async (t) => {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "codexbridge-7z-file-errors-"));
  const executable = path.join(directory, "7za.exe");
  await fsPromises.writeFile(executable, "trusted");
  t.after(async () => {
    await fsPromises.unlink(executable).catch(() => {});
    await fsPromises.rmdir(directory).catch(() => {});
  });
  const primary = new Error("exec_failed");
  const execution = createPinnedSevenZipExecution({
    fileCapabilities: {
      async pinArchiveFileNoFollow() {
        return { async assertStableNoFollow() {}, async close() { throw new Error("pin_close_failed"); } };
      },
    },
    sevenZipPath: executable,
    sevenZipSha256: createHash("sha256").update("trusted").digest("hex"),
    async execFile() { throw primary; },
    async spawn() {},
  });
  await assert.rejects(execution.spawnFile(executable, [], {}), (error) => {
    assert.equal(error instanceof AggregateError, true);
    assert.equal(error.cause, primary);
    assert.deepEqual(error.errors.map(({ message }) => message), ["exec_failed", "pin_close_failed"]);
    return true;
  });
});

test("invalid pinned 7z child getter cannot bypass pin cleanup", async (t) => {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "codexbridge-7z-getter-"));
  const executable = path.join(directory, "7za.exe");
  await fsPromises.writeFile(executable, "trusted");
  t.after(async () => {
    await fsPromises.unlink(executable).catch(() => {});
    await fsPromises.rmdir(directory).catch(() => {});
  });
  let closed = 0;
  const execution = createPinnedSevenZipExecution({
    fileCapabilities: {
      async pinArchiveFileNoFollow() {
        return { async assertStableNoFollow() {}, async close() { closed += 1; } };
      },
    },
    sevenZipPath: executable,
    sevenZipSha256: createHash("sha256").update("trusted").digest("hex"),
    async execFile() {},
    async spawn() {
      return Object.defineProperties({}, {
        stdout: { get() { throw new Error("hostile_getter"); } },
        cancel: { get() { throw new Error("must_not_reread"); } },
        completed: { get() { throw new Error("must_not_reread"); } },
      });
    },
  });
  await assert.rejects(execution.spawnStream(executable, [], {}), (error) => (
    error?.code === "software_manager_spawn_result_invalid" && error.cause?.message === "hostile_getter"
  ));
  assert.equal(closed, 1);
});

test("default shortcut facade keeps receipts on one API instance, exposes all methods, and retries denial", async () => {
  let capabilityCalls = 0;
  let apiCalls = 0;
  let denyOnce = true;
  const liveReceipts = new WeakSet();
  const events = [];
  const shortcutFileApi = createLazyShortcutFileApi({
    async getDesktopCapability() {
      capabilityCalls += 1;
      if (denyOnce) {
        denyOnce = false;
        throw Object.assign(new Error("desktop_denied"), { code: "EACCES" });
      }
      return Object.freeze({ kind: "desktop", sequence: capabilityCalls });
    },
    fileCapabilities: {
      createShortcutFileApi(capability) {
        apiCalls += 1;
        const instance = apiCalls;
        const requireReceipt = (receipt) => {
          if (!liveReceipts.has(receipt)) throw new Error("foreign_shortcut_receipt");
        };
        return {
          async inspectExact() { events.push([instance, "inspect", capability.sequence]); return { kind: "absent" }; },
          async createTemp() {
            const receipt = Object.freeze(Object.create(null));
            liveReceipts.add(receipt); events.push([instance, "createTemp"]); return receipt;
          },
          async sealTemp(receipt) { requireReceipt(receipt); events.push([instance, "sealTemp"]); return receipt; },
          async commitNoReplace(receipt) { requireReceipt(receipt); events.push([instance, "commit"]); return { path: "desktop.lnk" }; },
          async removeTemp(receipt) { requireReceipt(receipt); events.push([instance, "removeTemp"]); },
          async removeExact() { events.push([instance, "removeExact"]); },
          async release() { events.push([instance, "release"]); },
        };
      },
    },
  });
  await assert.rejects(shortcutFileApi.inspectExact("ChatGPT.lnk"), /desktop_denied/u);
  const receipt = await shortcutFileApi.createTemp("ChatGPT.lnk");
  await shortcutFileApi.sealTemp(receipt);
  await shortcutFileApi.commitNoReplace(receipt);
  await shortcutFileApi.inspectExact("ChatGPT.lnk");
  await shortcutFileApi.release();
  await shortcutFileApi.removeExact("ChatGPT.lnk");
  assert.equal(capabilityCalls, 2);
  assert.equal(apiCalls, 1);
  assert.deepEqual(events.map(([instance, method]) => [instance, method]), [
    [1, "createTemp"], [1, "sealTemp"], [1, "commit"],
    [1, "inspect"], [1, "release"], [1, "removeExact"],
  ]);
  assert.equal(typeof shortcutFileApi.removeTemp, "function");
});

test("host, Desktop, and Skills authorities are separately lazy and cached", async () => {
  const harness = fixture();
  let composition;
  harness.runtimeFactories.createRootAdapters = (options) => { composition = options; return adapters(); };
  const runtime = await createProductionSoftwareManagerService(harness.options);
  await runtime.selectInstallRoot("D:\\CBApps");
  assert.equal(harness.calls.includes("windows-host"), false);
  assert.equal(harness.calls.includes("desktop-authority"), false);
  assert.equal(harness.calls.includes("skills-authority"), false);
  assert.equal((await composition.getWindowsHost()).marker, "host");
  await composition.getWindowsHost();
  await composition.getDesktopCapability();
  await composition.getDesktopCapability();
  await composition.getSkillsRootCapability();
  await composition.getSkillsRootCapability();
  assert.equal(harness.calls.filter((entry) => Array.isArray(entry) && entry[0] === "windows-host").length, 1);
  assert.equal(harness.calls.filter((entry) => entry === "desktop-authority").length, 1);
  assert.equal(harness.calls.filter((entry) => entry === "skills-authority").length, 1);
});

test("lazy authority shares one in-flight request but retries after a denial", async () => {
  const harness = fixture({ skillAuthorityFailures: 1 });
  let composition;
  harness.runtimeFactories.createRootAdapters = (options) => { composition = options; return adapters(); };
  const runtime = await createProductionSoftwareManagerService(harness.options);
  await runtime.selectInstallRoot("D:\\CBApps");
  const first = await Promise.allSettled([
    composition.getSkillsRootCapability(),
    composition.getSkillsRootCapability(),
  ]);
  assert.deepEqual(first.map(({ status }) => status), ["rejected", "rejected"]);
  assert.equal(harness.calls.filter((entry) => entry === "skills-authority").length, 1);
  assert.equal((await composition.getSkillsRootCapability()).kind, "skills");
  assert.equal(harness.calls.filter((entry) => entry === "skills-authority").length, 2);
});

test("a denied Skills root does not prevent component adapter composition", async () => {
  const harness = fixture({ skillAuthorityError: Object.assign(new Error("denied"), { code: "EACCES" }) });
  let composition;
  harness.runtimeFactories.createRootAdapters = (options) => { composition = options; return adapters(); };
  const runtime = await createProductionSoftwareManagerService(harness.options);
  await runtime.selectInstallRoot("D:\\CBApps");
  const snapshot = await runtime.service.getSnapshot();
  assert.equal(snapshot.components.every((entry) => entry.updateState !== "error"), true);
  await assert.rejects(composition.getSkillsRootCapability(), /denied/u);
  assert.equal((await runtime.service.getSnapshot()).components.every((entry) => entry.updateState !== "error"), true);
});

test("offline recovery uses only local ownership journal root authorization and root-bound slots", async () => {
  const harness = fixture({ persistedRoot: "D:\\CBApps" });
  const runtime = await createProductionSoftwareManagerService(harness.options);
  const recovered = await runtime.recoverOffline();
  assert.equal(recovered.status, "recovered");
  assert.equal(recovered.installRoot, "D:\\CBApps");
  assert.equal(harness.calls.includes("catalog:get"), false);
  assert.equal(harness.calls.includes("catalog:refresh"), false);
  assert.equal(harness.calls.includes("fetch"), false);
  assert.equal(harness.calls.includes("exec"), false);
  assert.equal(harness.calls.includes("spawn"), false);
  assert.equal(harness.calls.includes("windows-host"), false);
  assert.equal(harness.calls.includes("desktop-authority"), false);
  assert.equal(harness.calls.includes("skills-authority"), false);
  assert.equal(harness.calls.filter((entry) => Array.isArray(entry) && entry[0] === "slots").length, 1);
});

test("slot recovery clearing first-install ownership revokes the old resolver token instead of restoring the inferred root", async () => {
  const harness = fixture({ persistedRoot: "D:\\CBApps" });
  const runtime = await createProductionSoftwareManagerService(harness.options);
  await runtime.service.getSnapshot();
  const oldToken = harness.installRootResolver.getCurrentToken();
  assert.equal(typeof oldToken, "string");
  harness.setSlotRecoveryOwnership(state(null));
  await runtime.recoverOffline();
  assert.equal(harness.installRootResolver.getCurrentToken(), null);
  assert.equal(harness.calls.includes("resolver:clear"), true);
  assert.equal(await harness.installRootResolver.resolve(oldToken), undefined);
  const adaptersBefore = harness.calls.filter((entry) => Array.isArray(entry) && entry[0] === "root-adapters").length;
  await runtime.service.getSnapshot();
  const adaptersAfter = harness.calls.filter((entry) => Array.isArray(entry) && entry[0] === "root-adapters").length;
  assert.equal(adaptersAfter, adaptersBefore);
});

test("startup recovery orders slots before Skill reconciliation and restores the resolver token last", async () => {
  const harness = fixture({
    persistedRoot: "D:\\CBApps",
    includeSkillRecoveryHooks: true,
    activeTask: { kind: "skill-replace" },
  });
  const runtime = await createProductionSoftwareManagerService(harness.options);
  await runtime.service.getSnapshot();
  const slotRecovery = harness.calls.indexOf("slots:recover");
  const activeSkill = harness.calls.indexOf("skills:recover-active");
  const preparedCleanup = harness.calls.indexOf("skills:cleanup-prepared");
  const adapter = harness.calls.findIndex((entry) => Array.isArray(entry) && entry[0] === "root-adapters");
  assert.equal(slotRecovery >= 0, true);
  assert.equal(slotRecovery < activeSkill && activeSkill < preparedCleanup && preparedCleanup < adapter, true);
  assert.equal(harness.calls.includes("catalog:refresh"), false);
  assert.equal(harness.calls.includes("windows-host"), false);
});

test("startup recovery never cleans prepared Skills when task ownership changed during recovery", async () => {
  const task = { kind: "skill-replace" };
  const harness = fixture({
    persistedRoot: "D:\\CBApps",
    includeSkillRecoveryHooks: true,
    skillRecoveryStatus: "changed",
    activeTask: task,
  });
  const runtime = await createProductionSoftwareManagerService(harness.options);
  await runtime.recoverOffline();
  assert.equal(harness.calls.includes("skills:recover-active"), true);
  assert.equal(harness.calls.includes("skills:cleanup-prepared"), false);
  assert.deepEqual(harness.getOwnership().activeTask, task);
});

test("default Skill recovery infers a skill-only reserved root before swap and cleans its abandoned prepare", async () => {
  const fsApi = memoryRecoveryFs();
  const taskId = "skill-only";
  const skillId = "documents";
  const leaseNonce = "7".repeat(32);
  const installRootCapability = await authorizeInstallRoot({
    candidate: "D:\\CBApps", env: {}, maxRelativePath: 180,
    access: async () => {}, realpath: async (value) => value,
    lstat: async () => ({
      dev: 1, ino: 2, isDirectory: () => true, isSymbolicLink: () => false, isReparsePoint: () => false,
    }),
  });
  const skillsRootCapability = await authorizeSkillsRoot({
    candidate: "C:\\Users\\Example\\.codex\\skills",
    realpath: async (value) => value,
    lstat: async () => ({
      dev: 1, ino: 3, isDirectory: () => true, isSymbolicLink: () => false, isReparsePoint: () => false,
    }),
  });
  const prepareJournal = createSkillPrepareJournal({
    journalDir: "C:\\runtime-data\\skill-prepares", fsApi, installRoot: "D:\\CBApps",
  });
  await prepareJournal.record({
    schemaVersion: 1, phase: "intent", taskId, skillId,
    installRoot: "D:\\CBApps",
    sourcePath: "D:\\CBApps\\staging\\task-skill-only\\skill-documents.prepare",
    leaseScope: "prepare", leaseNonce, identity: null, evidence: null,
  });
  let ownership = state(null);
  ownership.activeTask = {
    kind: "skill-replace", phase: "reserved", taskId, skillId,
    swapId: "8".repeat(32), skillsRoot: "C:\\Users\\Example\\.codex\\skills",
    installRoot: "D:\\CBApps", leaseScope: "prepare", leaseNonce,
    target: "C:\\Users\\Example\\.codex\\skills\\documents",
    version: "1.0.0", packageSha256: "a".repeat(64), skillMdSha256: "b".repeat(64),
    treeDigest: "c".repeat(64), manifestDigest: "d".repeat(64), previousEvidence: { kind: "absent" },
  };
  const ownershipStore = {
    async load() { return structuredClone(ownership); },
    async compareAndSwap(expected, next) {
      assert.equal(expected, ownership.generation); ownership = structuredClone(next); return structuredClone(ownership);
    },
    async acquireOperationLease() { return { async release() {} }; },
  };
  const hooks = createDefaultSkillRecoveryHooks({
    fileCapabilities: fsApi,
    ownershipStore,
    dataRoot: "C:\\runtime-data",
    skillsRoot: "C:\\Users\\Example\\.codex\\skills",
    skillPathAccess: {
      realpath: async (value) => value,
      lstat: async () => ({
        dev: 1, ino: 4, isDirectory: () => true, isSymbolicLink: () => false, isReparsePoint: () => false,
      }),
    },
  });
  assert.equal(await hooks.inferSkillInstallRoot(ownership), "D:\\CBApps");
  await hooks.recoverActiveSkillTransaction({ installRootCapability, skillsRootCapability });
  assert.equal(ownership.activeTask, null);
  assert.equal(ownership.lastTask.action, "skill-replace-aborted");
  await hooks.cleanupAbandonedPreparedSkills({ installRootCapability });
  assert.equal(fsApi.deleted.length, 1);
  assert.equal(await hooks.inferSkillInstallRoot(ownership), null);
});

test("default Skill recovery releases task A lease without mutating a replacement task B", async () => {
  const fsApi = memoryRecoveryFs();
  const skillRoot = "C:\\Users\\Example\\.codex\\skills";
  const installRootCapability = await authorizeInstallRoot({
    candidate: "D:\\CBApps", env: {}, maxRelativePath: 180,
    access: async () => {}, realpath: async (value) => value,
    lstat: async () => ({
      dev: 1, ino: 2, isDirectory: () => true, isSymbolicLink: () => false, isReparsePoint: () => false,
    }),
  });
  const skillsRootCapability = await authorizeSkillsRoot({
    candidate: skillRoot, realpath: async (value) => value,
    lstat: async () => ({
      dev: 1, ino: 3, isDirectory: () => true, isSymbolicLink: () => false, isReparsePoint: () => false,
    }),
  });
  const task = (taskId, nonce) => ({
    kind: "skill-replace", phase: "reserved", taskId, skillId: "documents",
    swapId: taskId === "task-a" ? "a".repeat(32) : "b".repeat(32),
    skillsRoot: skillRoot, installRoot: "D:\\CBApps", leaseScope: "prepare", leaseNonce: nonce,
    target: `${skillRoot}\\documents`, version: "1.0.0",
    packageSha256: "1".repeat(64), skillMdSha256: "2".repeat(64),
    treeDigest: "3".repeat(64), manifestDigest: "4".repeat(64), previousEvidence: { kind: "absent" },
  });
  const taskA = task("task-a", "5".repeat(32));
  const taskB = task("task-b", "6".repeat(32));
  let ownership = state("D:\\CBApps");
  ownership.activeTask = taskA;
  let released = 0;
  const ownershipStore = {
    async load() { return structuredClone(ownership); },
    async compareAndSwap(expected, next) {
      assert.equal(expected, ownership.generation);
      ownership = { ...structuredClone(next), generation: expected + 1 };
      return structuredClone(ownership);
    },
    async acquireOperationLease({ nonce, scope, wait }) {
      assert.deepEqual({ nonce, scope, wait }, { nonce: taskA.leaseNonce, scope: "prepare", wait: false });
      ownership.activeTask = structuredClone(taskB);
      return { async release() { released += 1; } };
    },
  };
  const hooks = createDefaultSkillRecoveryHooks({
    fileCapabilities: fsApi, ownershipStore, dataRoot: "C:\\runtime-data", skillsRoot: skillRoot,
    skillPathAccess: {
      realpath: async (value) => value,
      lstat: async () => ({
        dev: 1, ino: 4, isDirectory: () => true, isSymbolicLink: () => false, isReparsePoint: () => false,
      }),
    },
  });
  const recovered = await hooks.recoverActiveSkillTransaction({ installRootCapability, skillsRootCapability });
  assert.equal(recovered.status, "changed");
  assert.equal(recovered.heldLease, null);
  assert.equal(released, 1);
  assert.deepEqual(ownership.activeTask, taskB);
  assert.equal(ownership.lastTask, null);
});

test("default Skill recovery leaves a live swap WAL untouched and recovers it only after lease death", async () => {
  const fsApi = memoryRecoveryFs();
  const taskId = "swap-live";
  const skillId = "documents";
  const swapId = "a".repeat(32);
  const leaseNonce = "b".repeat(32);
  const skillRoot = "C:\\Users\\Example\\.codex\\skills";
  const sourcePath = `D:\\CBApps\\staging\\task-${taskId}\\skill-${skillId}.prepare`;
  const target = `${skillRoot}\\${skillId}`;
  const swapJournal = createSkillSwapJournal({
    journalDir: "C:\\runtime-data\\skill-swaps", fsApi, skillsRoot: skillRoot,
  });
  await swapJournal.record({
    schemaVersion: 1, phase: "reserved", taskId, swapId, skillId,
    skillsRoot: skillRoot, target, sourcePath, leaseScope: "prepare", leaseNonce,
    preparedPath: `${skillRoot}\\.codexbridge-new-${skillId}-${swapId}`,
    oldPath: `${skillRoot}\\.codexbridge-old-${skillId}-${swapId}`,
    identities: {
      root: { volumeSerial: "volume", fileId: "skills-root" },
      source: { volumeSerial: "volume", fileId: "source" },
      prepared: null, old: null, new: null,
    },
    previousEvidence: { kind: "absent" },
    expectedEvidence: {
      treeDigest: "1".repeat(64), manifestDigest: "2".repeat(64), skillMdSha256: "3".repeat(64),
      requiredFiles: ["SKILL.md"],
    },
  });
  const installRootCapability = await authorizeInstallRoot({
    candidate: "D:\\CBApps", env: {}, maxRelativePath: 180,
    access: async () => {}, realpath: async (value) => value,
    lstat: async () => ({
      dev: 1, ino: 2, isDirectory: () => true, isSymbolicLink: () => false, isReparsePoint: () => false,
    }),
  });
  const skillsRootCapability = await authorizeSkillsRoot({
    candidate: skillRoot, realpath: async (value) => value,
    lstat: async () => ({
      dev: 1, ino: 3, isDirectory: () => true, isSymbolicLink: () => false, isReparsePoint: () => false,
    }),
  });
  let ownership = state("D:\\CBApps");
  ownership.activeTask = {
    kind: "skill-replace", phase: "reserved", taskId, swapId, skillId,
    installRoot: "D:\\CBApps", skillsRoot: skillRoot, target,
    version: "1.0.0", packageSha256: "4".repeat(64), skillMdSha256: "3".repeat(64),
    treeDigest: "1".repeat(64), manifestDigest: "2".repeat(64), previousEvidence: { kind: "absent" },
    leaseScope: "prepare", leaseNonce,
  };
  let live = true;
  let released = 0;
  const ownershipStore = {
    async load() { return structuredClone(ownership); },
    async compareAndSwap(expected, next) {
      assert.equal(expected, ownership.generation);
      ownership = { ...structuredClone(next), generation: expected + 1 };
      return structuredClone(ownership);
    },
    async acquireOperationLease() {
      if (live) return null;
      return { async release() { released += 1; } };
    },
  };
  const hooks = createDefaultSkillRecoveryHooks({
    fileCapabilities: fsApi, ownershipStore, dataRoot: "C:\\runtime-data", skillsRoot: skillRoot,
    skillPathAccess: {
      realpath: async (value) => value,
      lstat: async () => ({
        dev: 1, ino: 4, isDirectory: () => true, isSymbolicLink: () => false, isReparsePoint: () => false,
      }),
    },
  });
  assert.equal(await hooks.inferSkillInstallRoot(ownership), "D:\\CBApps");
  const busy = await hooks.recoverActiveSkillTransaction({ installRootCapability, skillsRootCapability });
  assert.equal(busy.status, "busy");
  assert.equal(ownership.activeTask.taskId, taskId);
  assert.notEqual(await swapJournal.load({ taskId, swapId }), null);

  live = false;
  const recovered = await hooks.recoverActiveSkillTransaction({ installRootCapability, skillsRootCapability });
  assert.equal(recovered.status, "recovered");
  assert.equal(ownership.activeTask, null);
  await hooks.cleanupAbandonedPreparedSkills({ installRootCapability, heldLease: recovered.heldLease });
  assert.equal(released, 1);
  assert.equal(await swapJournal.load({ taskId, swapId }), null);
});

test("service events use the injected bounded structured log sink", async () => {
  const harness = fixture();
  const runtime = await createProductionSoftwareManagerService(harness.options);
  await runtime.selectInstallRoot("D:\\CBApps");
  await runtime.service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  const phases = harness.calls.filter((entry) => Array.isArray(entry) && entry[0] === "log").map((entry) => entry[1]);
  assert.equal(phases.includes("prepare"), true);
  assert.equal(phases.includes("finished"), true);
});
