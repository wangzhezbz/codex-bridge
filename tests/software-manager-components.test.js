import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import path from "node:path";
import test from "node:test";

import { createComponentAdapters } from "../desktop/software-manager/component-adapters.mjs";
import { createTrustedCatalogService, verifyCatalogEnvelope } from "../desktop/software-manager/catalog-trust.mjs";
import {
  authorizeDesktopPath, authorizeInstallRoot, authorizeSkillsRoot,
} from "../desktop/software-manager/path-policy.mjs";

const INSTALL_ROOT = "D:\\CBApps";
const SKILLS_ROOT = "C:\\Users\\tester\\.codex\\skills";
const DESKTOP = "C:\\Users\\tester\\Desktop";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const SKILL_HASH = "c".repeat(64);
const TEST_CATALOG_URL = "https://shanhaiyouling.com/codexbridge-install-test/component-catalog.json";
const directoryStat = { isDirectory: () => true, isSymbolicLink: () => false, isReparsePoint: () => false };

const INSTALL_CAPABILITY = await authorizeInstallRoot({
  candidate: INSTALL_ROOT,
  env: { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", USERPROFILE: "C:\\Users\\tester" },
  maxRelativePath: 180,
  access: async () => {}, realpath: async (value) => value, lstat: async () => directoryStat,
});
const SKILLS_CAPABILITY = await authorizeSkillsRoot({
  candidate: SKILLS_ROOT, realpath: async (value) => value, lstat: async () => directoryStat,
});
const DESKTOP_CAPABILITY = await authorizeDesktopPath({
  getDesktopPath: () => DESKTOP, realpath: async (value) => value, lstat: async () => directoryStat,
});

function component(id, overrides = {}) {
  const defaults = {
    chatgpt: { name: "ChatGPT", version: "2.0.0", format: "zip", entrypoint: "ChatGPT.exe" },
    v2rayn: { name: "V2RayN", version: "7.0.4", format: "7z", entrypoint: "v2rayN.exe" },
    git: { name: "Git", version: "2.51.0", format: "exe", entrypoint: "cmd/git.exe" },
  }[id];
  return {
    id, architecture: "x64", assetUrl: `/codexbridge-test/packages/${id}-${defaults.version}.${defaults.format}`,
    size: 123, sha256: DIGEST_A, requiredFiles: [defaults.entrypoint], maxRelativePathLength: 80,
    publishedAt: "2026-08-07T00:00:00.000Z", supportsRollback: true, ...defaults, ...overrides,
  };
}

function skill(id = "documents") {
  return {
    id, name: id, description: "fixture", version: "1.0.0",
    assetUrl: `/codexbridge-test/packages/skill-${id}.zip`, size: 42, sha256: DIGEST_B,
    files: ["SKILL.md", "reference.md"],
  };
}

function trustedCatalog(entries = {}) {
  const value = {
    schemaVersion: 1,
    components: entries.components ?? [component("chatgpt"), component("v2rayn"), component("git")],
    skills: entries.skills ?? [skill()],
  };
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jsonBytes = Buffer.from(JSON.stringify(value));
  const verified = verifyCatalogEnvelope({
    jsonBytes,
    signatureText: sign("RSA-SHA256", jsonBytes, privateKey).toString("base64"),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    catalogUrl: TEST_CATALOG_URL,
  });
  return createTrustedCatalogService(verified);
}

const TRUSTED_CATALOG = trustedCatalog();

function emptyState(installRoot = null) {
  return {
    schemaVersion: 1, installRoot, components: {}, skills: {}, shortcuts: [], rollback: null,
    activeTask: null, lastTask: null,
  };
}

function fixture({
  state = emptyState(), gitDiscovery = { kind: "none" }, gitDiscoveries = null, running = false,
  slotFailure = null, finalVerifyFailure = null, shortcutFailure = null, restartFailure = null,
  stateSaveFailureAt = null, persistentFailureAt = null, skillHashes = null, gitInstallFailure = null,
  invalidAuthenticodePath = null,
} = {}) {
  let currentState = structuredClone(state);
  let saveCount = 0;
  const calls = {
    downloads: [], extracts: [], promotions: [], rollbacks: [], stopped: [], launched: [], shortcuts: [],
    removedShortcuts: [], verified: [], gitInstalls: [], gitUninstalls: [], replacedSkills: [], deletedSkills: [],
    deletedComponents: [], hashes: [], persistentPrepared: [], persistentVerified: [], gitPins: [], gitRevalidates: [],
    gitReleases: [], retained: [], discarded: [],
  };
  const archiveReceipts = new WeakSet();
  const skillReceipts = new WeakSet();
  const gitPins = new WeakSet();
  const deletedSkillTargets = new Set();
  const ownershipStore = {
    async load() { return structuredClone(currentState); },
    async save(next) {
      saveCount += 1;
      if (saveCount === stateSaveFailureAt) throw Object.assign(new Error("state_save_failed"), { code: "state_save_failed" });
      currentState = structuredClone(next);
    },
  };
  const windowsHost = {
    async discoverGit() {
      const value = Array.isArray(gitDiscoveries) && gitDiscoveries.length > 0 ? gitDiscoveries.shift() : gitDiscovery;
      if (value instanceof Error) throw value;
      return structuredClone(value);
    },
    async verifyAuthenticode(filePath) {
      calls.verified.push({ kind: "authenticode", filePath });
      return { status: filePath === invalidAuthenticodePath ? "NotSigned" : "Valid" };
    },
    async stopOwnedProcesses(paths) { calls.stopped.push([...paths]); return { stoppedProcessIds: running ? [123] : [] }; },
    async launchOwned(executablePath) {
      calls.launched.push(executablePath);
      if (restartFailure) throw restartFailure;
      return { executablePath, pid: 456 };
    },
    async createShortcut(record) {
      calls.shortcuts.push(record);
      if (shortcutFailure) throw shortcutFailure;
      return { ...record, path: path.win32.join(record.desktopPath, `${record.name}（1）.lnk`) };
    },
    async removeRecordedShortcut(record) { calls.removedShortcuts.push(record); return { removed: true }; },
    async runGitInstaller(plan) {
      calls.gitInstalls.push(plan);
      if (gitInstallFailure) throw gitInstallFailure;
      return { targetDir: plan.targetDir };
    },
    async runGitUninstaller(plan) { calls.gitUninstalls.push(plan); return { installDir: plan.installDir }; },
  };
  const archiveService = {
    async extractArchive(plan) {
      calls.extracts.push(plan);
      const verificationReceipt = Object.freeze(Object.create(null));
      archiveReceipts.add(verificationReceipt);
      return {
        entries: [{ path: plan.verification?.componentId === "v2rayn" ? "v2rayN.exe" : "ChatGPT.exe", size: 10, directory: false }],
        maxRelativePath: 11, totalUnpackedBytes: 10,
        ...(plan.verification ? { verificationReceipt, treeDigest: DIGEST_A, manifestDigest: DIGEST_B } : {}),
      };
    },
  };
  const versionSlots = {
    async promotePreparedVersion(plan) {
      calls.promotions.push(plan);
      if (slotFailure) throw slotFailure;
      assert.equal(archiveReceipts.has(plan.verificationReceipt), true);
      const rootPath = plan.componentId === "chatgpt" ? INSTALL_ROOT : path.win32.join(INSTALL_ROOT, "V2RayN");
      assert.equal(plan.rootPath, rootPath);
      currentState.installRoot = INSTALL_ROOT;
      currentState.components[plan.componentId] = {
        managed: true,
        installPath: path.win32.join(rootPath, plan.componentId === "chatgpt" ? "c" : "current"),
        version: plan.version, treeDigest: plan.treeDigest, manifestDigest: plan.manifestDigest,
      };
      return { componentId: plan.componentId, version: plan.version, rollbackAvailable: state.installRoot !== null };
    },
    async rollbackVersion(componentId) { calls.rollbacks.push(componentId); return { componentId, version: "1.0.0", rollbackAvailable: false }; },
  };
  let verifyCalls = 0;
  const componentFiles = {
    async verifyComponent(plan) {
      verifyCalls += 1;
      calls.verified.push({ kind: "component", ...plan });
      if (verifyCalls > 1 && finalVerifyFailure) throw finalVerifyFailure;
      return { version: plan.expectedVersion };
    },
    async verifyGitVersion(executablePath, expectedVersion) {
      calls.verified.push({ kind: "git-version", executablePath, expectedVersion });
      return { version: expectedVersion };
    },
    async deleteComponent(plan) { calls.deletedComponents.push(plan); },
    async preparePersistentDirectory(plan) { calls.persistentPrepared.push(plan); return { identity: "config" }; },
    async verifyPersistentDirectory(plan) {
      calls.persistentVerified.push(plan);
      if (calls.persistentVerified.length === persistentFailureAt) throw new Error("persistent_config_changed");
      return true;
    },
  };
  const skillFiles = {
    async verifyPreparedSkill(plan) {
      const verificationReceipt = Object.freeze(Object.create(null));
      skillReceipts.add(verificationReceipt);
      return { verificationReceipt, treeDigest: DIGEST_A, manifestDigest: DIGEST_B, skillMdSha256: SKILL_HASH };
    },
    async hashFile(filePath) {
      calls.hashes.push(filePath);
      return Array.isArray(skillHashes) && skillHashes.length > 0 ? skillHashes.shift() : SKILL_HASH;
    },
    async replaceExact(plan) {
      assert.equal(skillReceipts.has(plan.verificationReceipt), true);
      skillReceipts.delete(plan.verificationReceipt);
      calls.replacedSkills.push(plan);
    },
    async deleteExact(plan) { calls.deletedSkills.push(plan); deletedSkillTargets.add(plan.target); },
    async inspectExact({ target }) {
      if (deletedSkillTargets.has(target)) return { kind: "absent" };
      const record = currentState.skills.documents;
      return record?.target === target ? { kind: "directory", skillMdSha256: record.skillMdSha256 } : { kind: "absent" };
    },
  };
  const gitIdentityCapabilities = {
    async pinPlan(plan) {
      const capability = Object.freeze(Object.create(null));
      gitPins.add(capability); calls.gitPins.push(plan); return capability;
    },
    async revalidate(capability, plan) {
      assert.equal(gitPins.has(capability), true); calls.gitRevalidates.push(plan); return true;
    },
    async release(capability) { gitPins.delete(capability); calls.gitReleases.push(capability); },
    async retainInstaller(capability, record) {
      assert.equal(gitPins.has(capability), true); calls.retained.push(record);
      return { path: record.path, sha256: record.sha256, version: record.version };
    },
    async pinRetainedInstaller(record) {
      const capability = Object.freeze(Object.create(null)); gitPins.add(capability); calls.gitPins.push(record); return capability;
    },
    async discardRetainedInstaller(record) { calls.discarded.push(record); },
  };
  const downloader = {
    async download(plan) { calls.downloads.push(plan); return { path: plan.destination, size: plan.asset.size, sha256: plan.asset.sha256 }; },
  };
  const adapters = createComponentAdapters({
    catalogService: TRUSTED_CATALOG,
    installRootCapability: INSTALL_CAPABILITY,
    skillsRootCapability: SKILLS_CAPABILITY,
    desktopCapability: DESKTOP_CAPABILITY,
    downloader, archiveService, versionSlots, ownershipStore, windowsHost, componentFiles, skillFiles,
    gitIdentityCapabilities,
    resolveSkillTarget: async ({ skillsRoot, skillId }) => path.win32.join(skillsRoot, skillId),
  });
  return { adapters, calls, getState: () => structuredClone(currentState) };
}

const externalGit = Object.freeze({
  kind: "external", ownership: "external", version: "2.50.0", installDir: "C:\\Git",
  executablePath: "C:\\Git\\cmd\\git.exe", uninstallerPath: "C:\\Git\\unins000.exe", registryKey: "HKLM\\Git",
});

test("raw context catalog and path injection fails before ownership or download", async () => {
  const { adapters, calls, getState } = fixture();
  const result = await adapters.chatgpt.prepare({
    taskId: "injection", catalog: { components: [component("chatgpt", { version: "x\\..\\..\\..\\escaped" })] },
    installRoot: "C:\\Windows", desktopPath: "C:\\Users\\tester\\Documents",
  });
  assert.equal(result.status, "failed");
  assert.equal(getState().installRoot, null);
  assert.deepEqual(calls.downloads, []);
});

test("ChatGPT uses CBApps c/cp/ct directly and consumes the archive receipt in persistent slots", async () => {
  const { adapters, calls, getState } = fixture();
  assert.equal((await adapters.chatgpt.prepare({ taskId: "chat" })).status, "succeeded");
  assert.equal(calls.extracts[0].destination, "D:\\CBApps\\ct");
  const committed = await adapters.chatgpt.commit({ taskId: "chat" });
  assert.equal(committed.status, "succeeded");
  assert.equal(calls.promotions[0].rootPath, INSTALL_ROOT);
  assert.equal(getState().components.chatgpt.installPath, "D:\\CBApps\\c");
});

test("prepare or download failure never persists the selected install root", async () => {
  const { adapters, calls, getState } = fixture();
  calls.downloads.push = () => { throw Object.assign(new Error("download_failed"), { code: "download_failed" }); };
  const result = await adapters.chatgpt.prepare({ taskId: "download-fail" });
  assert.equal(result.status, "failed");
  assert.equal(getState().installRoot, null);
});

test("post-promotion verify, shortcut, state, or restart failures do not report failed after a durable switch", async (t) => {
  for (const [name, options] of [
    ["final verify", { finalVerifyFailure: new Error("final") }],
    ["shortcut", { shortcutFailure: new Error("shortcut") }],
    ["state", { stateSaveFailureAt: 1 }],
    ["restart", { running: true, restartFailure: new Error("restart") }],
  ]) {
    await t.test(name, async () => {
      const state = emptyState(INSTALL_ROOT);
      state.components.chatgpt = { managed: true, installPath: "D:\\CBApps\\c", version: "1.0.0" };
      const { adapters, calls } = fixture({ state, ...options });
      await adapters.chatgpt.prepare({ taskId: `warning-${name.replace(" ", "-")}` });
      const committed = await adapters.chatgpt.commit({ taskId: `warning-${name.replace(" ", "-")}` });
      assert.equal(committed.status, "succeeded");
      assert.match(committed.message, /warning|committed/u);
      assert.equal(calls.promotions.length, 1);
    });
  }
});

test("a pre-promotion V2RayN persistent-config identity failure prevents stop and promotion", async () => {
  const { adapters, calls } = fixture({ persistentFailureAt: 1 });
  await adapters.v2rayn.prepare({ taskId: "v2-config" });
  const committed = await adapters.v2rayn.commit({ taskId: "v2-config" });
  assert.equal(committed.status, "failed");
  assert.deepEqual(calls.stopped, []);
  assert.deepEqual(calls.promotions, []);
});

test("V2RayN retains a separate persistent config root and stops only an owned executable", async () => {
  const state = emptyState(INSTALL_ROOT);
  state.components.v2rayn = { managed: true, installPath: "D:\\CBApps\\V2RayN\\current", version: "6.0.0" };
  const { adapters, calls } = fixture({ state, running: true });
  await adapters.v2rayn.prepare({ taskId: "v2" });
  const committed = await adapters.v2rayn.commit({ taskId: "v2" });
  assert.equal(committed.status, "succeeded");
  assert.deepEqual(calls.stopped[0], ["D:\\CBApps\\V2RayN\\current\\v2rayN.exe"]);
  assert.equal(calls.persistentPrepared[0].rootPath, "D:\\CBApps\\V2RayN-Data");
});

test("a completed native component uninstall is recovered after its final state save fails", async () => {
  const state = emptyState(INSTALL_ROOT);
  state.components.chatgpt = { managed: true, installPath: "D:\\CBApps\\c", version: "2.0.0" };
  const { adapters, calls, getState } = fixture({ state, stateSaveFailureAt: 2 });
  const removed = await adapters.chatgpt.uninstall({ taskId: "chat-uninstall" });
  assert.equal(removed.status, "succeeded");
  assert.equal(getState().activeTask.kind, "component-uninstall");
  assert.equal((await adapters.chatgpt.inspectInstalled({})).status, "skipped");
  assert.equal(getState().activeTask, null);
  assert.equal(getState().components.chatgpt, undefined);
  assert.equal(calls.deletedComponents.length, 2);
});

test("external Git inspect works with null ownership and ambiguous discovery fails closed", async () => {
  const { adapters } = fixture({ gitDiscovery: externalGit });
  const found = await adapters.git.inspectInstalled({});
  assert.equal(found.status, "succeeded");
  assert.equal(found.versionAfter, "2.50.0");
  const blocked = fixture({ gitDiscovery: Object.assign(new Error("git_multiple_installations"), { code: "git_multiple_installations" }) });
  assert.equal((await blocked.adapters.git.inspectInstalled({})).status, "failed");
});

test("external Git update pins installer, registered root, git.exe and uninstaller and revalidates immediately before run", async () => {
  const { adapters, calls } = fixture({ gitDiscovery: externalGit });
  await adapters.git.prepare({ taskId: "git-external", selected: true });
  const committed = await adapters.git.commit({ taskId: "git-external" });
  assert.equal(committed.status, "succeeded");
  assert.equal(calls.gitPins[0].discovery.executablePath, externalGit.executablePath);
  assert.equal(calls.gitPins[0].discovery.uninstallerPath, externalGit.uninstallerPath);
  assert.equal(calls.gitRevalidates.length >= 2, true);
  assert.equal(calls.gitInstalls[0].targetDir, externalGit.installDir);
  assert.deepEqual(calls.shortcuts, []);
});

test("external Git target change between prepare and commit is blocked before installer execution", async () => {
  const changed = { ...externalGit, installDir: "E:\\Git", executablePath: "E:\\Git\\cmd\\git.exe", uninstallerPath: "E:\\Git\\unins000.exe" };
  const { adapters, calls } = fixture({ gitDiscoveries: [externalGit, changed], gitDiscovery: changed });
  await adapters.git.prepare({ taskId: "git-race", selected: true });
  assert.equal((await adapters.git.commit({ taskId: "git-race" })).status, "failed");
  assert.deepEqual(calls.gitInstalls, []);
});

test("managed Git installs to one stable directory, keeps signed installers for reinstall rollback, and never uses slots", async () => {
  const registered = {
    ...externalGit, version: "2.51.0", installDir: "D:\\CBApps\\Git",
    executablePath: "D:\\CBApps\\Git\\cmd\\git.exe", uninstallerPath: "D:\\CBApps\\Git\\unins000.exe",
  };
  const { adapters, calls, getState } = fixture({ gitDiscoveries: [{ kind: "none" }, registered], gitDiscovery: registered });
  await adapters.git.prepare({ taskId: "git-managed", selected: true });
  const installed = await adapters.git.commit({ taskId: "git-managed" });
  assert.equal(installed.status, "succeeded");
  assert.equal(calls.gitInstalls[0].targetDir, "D:\\CBApps\\Git");
  assert.equal(calls.promotions.length, 0);
  assert.equal(getState().components.git.installPath, "D:\\CBApps\\Git");
  assert.equal(getState().components.git.currentInstaller.version, "2.51.0");
  assert.deepEqual(calls.shortcuts, []);
});

test("managed Git adopts a completed fixed-target install after the final ownership save fails", async () => {
  const state = emptyState(INSTALL_ROOT);
  state.components.git = {
    managed: true, installPath: "D:\\CBApps\\Git", version: "2.50.0",
    executablePath: "D:\\CBApps\\Git\\cmd\\git.exe", uninstallerPath: "D:\\CBApps\\Git\\unins000.exe",
    currentInstaller: { path: "D:\\CBApps\\downloads\\git-2.50.0.exe", sha256: DIGEST_B, version: "2.50.0" },
    previousInstaller: null,
  };
  const installed = {
    ...externalGit, version: "2.51.0", installDir: "D:\\CBApps\\Git",
    executablePath: "D:\\CBApps\\Git\\cmd\\git.exe", uninstallerPath: "D:\\CBApps\\Git\\unins000.exe",
  };
  const { adapters, getState } = fixture({ state, gitDiscovery: installed, stateSaveFailureAt: 2 });
  await adapters.git.prepare({ taskId: "git-adopt", selected: true });
  const committed = await adapters.git.commit({ taskId: "git-adopt" });
  assert.equal(committed.status, "succeeded");
  assert.match(committed.message, /warning/u);
  assert.equal(getState().activeTask.kind, "git-install");
  const inspected = await adapters.git.inspectInstalled({});
  assert.equal(inspected.status, "succeeded");
  assert.equal(getState().components.git.version, "2.51.0");
  assert.equal(getState().components.git.previousInstaller.version, "2.50.0");
  assert.equal(getState().activeTask, null);
});

test("a managed Git installer failure leaves a reservation that the next inspection safely aborts", async () => {
  const { adapters, getState } = fixture({
    gitDiscovery: { kind: "none" },
    gitInstallFailure: Object.assign(new Error("installer_failed"), { code: "installer_failed" }),
  });
  await adapters.git.prepare({ taskId: "git-install-fail", selected: true });
  assert.equal((await adapters.git.commit({ taskId: "git-install-fail" })).status, "failed");
  assert.equal(getState().activeTask.kind, "git-install");
  assert.equal((await adapters.git.inspectInstalled({})).status, "skipped");
  assert.equal(getState().activeTask, null);
});

test("managed Git rollback reinstalls the retained previous installer into the same stable directory", async () => {
  const state = emptyState(INSTALL_ROOT);
  state.components.git = {
    managed: true, installPath: "D:\\CBApps\\Git", version: "2.51.0",
    executablePath: "D:\\CBApps\\Git\\cmd\\git.exe", uninstallerPath: "D:\\CBApps\\Git\\unins000.exe",
    currentInstaller: { path: "D:\\CBApps\\downloads\\git-2.51.0.exe", sha256: DIGEST_A, version: "2.51.0" },
    previousInstaller: { path: "D:\\CBApps\\downloads\\git-2.50.0.exe", sha256: DIGEST_B, version: "2.50.0" },
  };
  const discovery = { ...externalGit, ownership: "external", installDir: "D:\\CBApps\\Git", executablePath: "D:\\CBApps\\Git\\cmd\\git.exe", uninstallerPath: "D:\\CBApps\\Git\\unins000.exe", version: "2.51.0" };
  const { adapters, calls, getState } = fixture({ state, gitDiscovery: discovery });
  const rolled = await adapters.git.rollback({ taskId: "git-rollback" });
  assert.equal(rolled.status, "succeeded");
  assert.equal(calls.gitInstalls[0].installerPath, state.components.git.previousInstaller.path);
  assert.equal(calls.gitInstalls[0].targetDir, "D:\\CBApps\\Git");
  assert.equal(getState().components.git.version, "2.50.0");
  assert.equal(getState().components.git.previousInstaller, null);
});

test("managed Git rollback remains succeeded and is adopted after post-reinstall state failure", async () => {
  const state = emptyState(INSTALL_ROOT);
  state.components.git = {
    managed: true, installPath: "D:\\CBApps\\Git", version: "2.51.0",
    executablePath: "D:\\CBApps\\Git\\cmd\\git.exe", uninstallerPath: "D:\\CBApps\\Git\\unins000.exe",
    currentInstaller: { path: "D:\\CBApps\\downloads\\git-2.51.0.exe", sha256: DIGEST_A, version: "2.51.0" },
    previousInstaller: { path: "D:\\CBApps\\downloads\\git-2.50.0.exe", sha256: DIGEST_B, version: "2.50.0" },
  };
  const rolledBack = {
    ...externalGit, version: "2.50.0", installDir: "D:\\CBApps\\Git",
    executablePath: "D:\\CBApps\\Git\\cmd\\git.exe", uninstallerPath: "D:\\CBApps\\Git\\unins000.exe",
  };
  const { adapters, calls, getState } = fixture({ state, gitDiscovery: rolledBack, stateSaveFailureAt: 2 });
  const rolled = await adapters.git.rollback({ taskId: "git-rollback-adopt" });
  assert.equal(rolled.status, "succeeded");
  assert.match(rolled.message, /warning/u);
  assert.equal(getState().activeTask.kind, "git-rollback");
  assert.equal((await adapters.git.inspectInstalled({})).status, "succeeded");
  assert.equal(getState().components.git.version, "2.50.0");
  assert.equal(getState().activeTask, null);
  assert.equal(calls.discarded.length, 1);
});

test("Git uninstall always runs the registered uninstaller; external requires explicit selection", async () => {
  const { adapters, calls } = fixture({ gitDiscovery: externalGit });
  assert.equal((await adapters.git.uninstall({ selected: false })).status, "failed");
  assert.equal((await adapters.git.uninstall({ selected: true, taskId: "git-uninstall" })).status, "succeeded");
  assert.deepEqual(calls.gitUninstalls[0], { uninstallerPath: externalGit.uninstallerPath, installDir: externalGit.installDir });
  assert.equal(calls.verified.some((item) => item.kind === "authenticode"
    && item.filePath === externalGit.uninstallerPath), true);
});

test("Git uninstall rejects an untrusted registered uninstaller before execution", async () => {
  const { adapters, calls } = fixture({
    gitDiscovery: externalGit,
    invalidAuthenticodePath: externalGit.uninstallerPath,
  });
  const removed = await adapters.git.uninstall({ selected: true, taskId: "git-untrusted-uninstaller" });
  assert.equal(removed.status, "failed");
  assert.deepEqual(calls.gitUninstalls, []);
});

test("managed Git uninstall is recovered when deletion completed before ownership save failed", async () => {
  const state = emptyState(INSTALL_ROOT);
  state.components.git = {
    managed: true, installPath: "D:\\CBApps\\Git", version: "2.51.0",
    executablePath: "D:\\CBApps\\Git\\cmd\\git.exe", uninstallerPath: "D:\\CBApps\\Git\\unins000.exe",
    currentInstaller: { path: "D:\\CBApps\\downloads\\git-2.51.0.exe", sha256: DIGEST_A, version: "2.51.0" },
    previousInstaller: null,
  };
  const registered = {
    ...externalGit, version: "2.51.0", installDir: "D:\\CBApps\\Git",
    executablePath: "D:\\CBApps\\Git\\cmd\\git.exe", uninstallerPath: "D:\\CBApps\\Git\\unins000.exe",
  };
  const { adapters, getState } = fixture({
    state, gitDiscoveries: [registered, { kind: "none" }], stateSaveFailureAt: 2,
  });
  const removed = await adapters.git.uninstall({ selected: true, taskId: "git-uninstall-recover" });
  assert.equal(removed.status, "succeeded");
  assert.equal(getState().activeTask.kind, "git-uninstall");
  const inspected = await adapters.git.inspectInstalled({});
  assert.equal(inspected.status, "skipped");
  assert.equal(getState().components.git, undefined);
  assert.equal(getState().activeTask, null);
});

test("Skill replacement consumes a source receipt, reserves ownership, and adopts the new version after save failure", async () => {
  const { adapters, calls, getState } = fixture({ stateSaveFailureAt: 2 });
  assert.equal((await adapters.skills.prepare({ taskId: "skills", skillIds: ["documents"] }))[0].status, "succeeded");
  const committed = await adapters.skills.commit({ taskId: "skills", skillIds: ["documents"] });
  assert.equal(committed[0].status, "succeeded");
  assert.equal(calls.replacedSkills[0].target, "C:\\Users\\tester\\.codex\\skills\\documents");
  assert.equal(calls.replacedSkills[0].backup, false);
  assert.equal(getState().activeTask?.kind, "skill-replace");
  const recovered = await adapters.skills.inspectInstalled({ skillIds: ["documents"] });
  assert.equal(recovered[0].status, "succeeded");
  assert.equal(getState().skills.documents.version, "1.0.0");
  assert.equal(getState().activeTask, null);
});

test("Skill uninstall is independently recovered after deletion completed before state save", async () => {
  const state = emptyState(INSTALL_ROOT);
  state.skills.documents = {
    target: "C:\\Users\\tester\\.codex\\skills\\documents", version: "1.0.0",
    packageSha256: DIGEST_B, skillMdSha256: SKILL_HASH,
  };
  const { adapters, getState } = fixture({ state, stateSaveFailureAt: 2 });
  const removed = await adapters.skills.uninstall({ skillIds: ["documents"] });
  assert.equal(removed[0].status, "succeeded");
  assert.equal(getState().activeTask.kind, "skill-uninstall");
  const inspected = await adapters.skills.inspectInstalled({ skillIds: ["documents"] });
  assert.equal(inspected[0].status, "skipped");
  assert.equal(getState().skills.documents, undefined);
  assert.equal(getState().activeTask, null);
});

test("Skills are independent and an unsigned ID cannot mutate a sibling or the root", async () => {
  const { adapters, calls } = fixture();
  const prepared = await adapters.skills.prepare({ taskId: "skills-batch", skillIds: ["documents", "unsigned"] });
  assert.equal(prepared[0].status, "succeeded");
  assert.equal(prepared[1].status, "failed");
  await adapters.skills.commit({ taskId: "skills-batch", skillIds: ["documents"] });
  assert.deepEqual(calls.replacedSkills.map((entry) => entry.target), ["C:\\Users\\tester\\.codex\\skills\\documents"]);
});

test("failed results use the newest persistent version snapshot and never reject on state load errors", async () => {
  const state = emptyState(INSTALL_ROOT);
  state.components.chatgpt = { managed: true, installPath: "D:\\CBApps\\c", version: "1.0.0" };
  const { adapters } = fixture({ state, slotFailure: Object.assign(new Error("slot_failed"), { code: "slot_failed" }) });
  await adapters.chatgpt.prepare({ taskId: "latest-state" });
  const failed = await adapters.chatgpt.commit({ taskId: "latest-state" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.versionBefore, "1.0.0");
  assert.equal(failed.versionAfter, "1.0.0");
});
