import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDefaultSkillRecoveryHooks,
  createPinnedSevenZipExecution,
  createProductionSoftwareManagerService,
} from "../desktop/software-manager/runtime-factory.mjs";
import { authorizeInstallRoot, authorizeSkillsRoot } from "../desktop/software-manager/path-policy.mjs";
import { createSkillPrepareJournal } from "../desktop/software-manager/skill-prepare-journal.mjs";

const CATALOG_URL = "https://shanhaiyouling.com/codexbridge-install-test/component-catalog.json";
const SEVEN_ZIP_PATH = "C:\\Program Files\\CodexBridge\\resources\\app.asar.unpacked\\node_modules\\7zip-bin\\win\\x64\\7za.exe";

function memoryRecoveryFs() {
  let sequence = 0;
  const entries = new Map();
  const deleted = [];
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
        async inspectDirectChildNoFollow() { return { kind: "absent" }; },
        async stagePreparedTreeNoFollow() {}, async recoverPreparedTreeNoFollow() {},
        async renameDirectChildNoReplace() {}, async deleteDirectChildTreeNoFollow() {}, async close() {},
      };
    },
    async inspectPreparedSkillSourceNoFollow() {},
    async validatePreparedSkillSourceForDeletionNoFollow() {},
    async deletePreparedSkillSourceNoFollow(plan) { deleted.push(plan); },
  };
}

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
  activeTask = null,
  rootFactories = null,
} = {}) {
  const calls = [];
  let ownership = state(persistedRoot);
  ownership.activeTask = activeTask;
  let currentToken = null;
  let tokenSequence = 0;
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
          return Object.freeze({ async recoverJournalTransactions() { calls.push("slots:recover"); return []; } });
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
          ownership.activeTask = null;
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
        async getCurrent() { calls.push("catalog:get"); return options.publicKeyPem === null ? null : currentCatalog; },
        async refresh() { calls.push("catalog:refresh"); return options.publicKeyPem === null ? null : currentCatalog; },
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
  const rootFactories = {
    createDownloadManager(options) { seen.download = options; return { kind: "download" }; },
    createInstallerWorkspace(options) { seen.workspace = options; return { kind: "workspace" }; },
    createWorkspaceDownloader(options) { seen.downloader = options; return { download: async () => {} }; },
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
      return { completed: new Promise((resolve) => { finishStream = resolve; }) };
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

test("service events use the injected bounded structured log sink", async () => {
  const harness = fixture();
  const runtime = await createProductionSoftwareManagerService(harness.options);
  await runtime.selectInstallRoot("D:\\CBApps");
  await runtime.service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  const phases = harness.calls.filter((entry) => Array.isArray(entry) && entry[0] === "log").map((entry) => entry[1]);
  assert.equal(phases.includes("prepare"), true);
  assert.equal(phases.includes("finished"), true);
});
