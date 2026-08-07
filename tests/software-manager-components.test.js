import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import path from "node:path";
import test from "node:test";

import { createComponentAdapters } from "../desktop/software-manager/component-adapters.mjs";
import { createTrustedCatalogService, verifyCatalogEnvelope } from "../desktop/software-manager/catalog-trust.mjs";
import { getOwnershipCoordinator } from "../desktop/software-manager/ownership-coordinator.mjs";
import {
  authorizeDesktopPath, authorizeInstallRoot, authorizeSkillsRoot,
} from "../desktop/software-manager/path-policy.mjs";

const INSTALL_ROOT = "D:\\CBApps";
const SKILLS_ROOT = "C:\\Users\\tester\\.codex\\skills";
const DESKTOP = "C:\\Users\\tester\\Desktop";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const SKILL_HASH = "c".repeat(64);
const OLD_SKILL_HASH = "d".repeat(64);
const TEST_CATALOG_URL = "https://shanhaiyouling.com/codexbridge-install-test/component-catalog.json";
const directoryStat = { dev: 1, ino: 1, isDirectory: () => true, isSymbolicLink: () => false, isReparsePoint: () => false };

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
    schemaVersion: 1, generation: 0, installRoot, components: {}, skills: {}, shortcuts: [], rollback: null,
    activeTask: null, lastTask: null,
  };
}

function fixture({
  state = emptyState(), gitDiscovery = { kind: "none" }, gitDiscoveries = null, running = false,
  slotFailure = null, rollbackFailure = null, finalVerifyFailure = null, shortcutFailure = null, restartFailure = null,
  stateSaveFailureAt = null, persistentFailureAt = null, skillHashes = null, gitInstallFailure = null,
  invalidAuthenticodePath = null, initialSkillEvidence = null,
  catalogService = TRUSTED_CATALOG, installRootCapability = INSTALL_CAPABILITY,
  skillsRootCapability = SKILLS_CAPABILITY, onDownload = null, onExtract = null,
  onReplaceSkill = null, onGitInstall = null, onVerifyComponent = null,
  onAuthenticode = null, onGitPin = null, gitExecutionTimeoutMs = undefined,
  onGitUninstall = null,
} = {}) {
  let currentState = structuredClone(state);
  let saveCount = 0;
  const calls = {
    downloads: [], extracts: [], promotions: [], rollbacks: [], stopped: [], launched: [], shortcuts: [],
    removedShortcuts: [], verified: [], gitInstalls: [], gitUninstalls: [], replacedSkills: [], deletedSkills: [],
    deletedComponents: [], hashes: [], persistentPrepared: [], persistentVerified: [], gitPins: [], gitRevalidates: [],
    gitReleases: [], retained: [], discarded: [],
    gitMutableReleases: [],
  };
  const archiveReceipts = new WeakSet();
  const skillReceipts = new WeakSet();
  const skillCompletionReceipts = new WeakSet();
  const skillProofs = new Map();
  const installedSkillEvidence = new Map();
  if (initialSkillEvidence && typeof initialSkillEvidence === "object") {
    installedSkillEvidence.set(initialSkillEvidence.target, structuredClone(initialSkillEvidence.evidence));
  }
  const gitPins = new WeakSet();
  const shortcutReservations = new Map();
  const deletedSkillTargets = new Set();
  const operationLeases = new Map();
  const ownershipStore = {
    async acquireOperationLease({ nonce, scope, wait = true }) {
      const key = `${scope}:${nonce}`;
      if (operationLeases.has(key)) return wait ? Promise.reject(new Error("test_operation_lease_busy")) : null;
      operationLeases.set(key, true);
      let released = false;
      return {
        nonce, scope,
        async release() {
          if (released) throw new Error("test_operation_lease_already_released");
          released = true;
          operationLeases.delete(key);
        },
      };
    },
    async load() { return structuredClone(currentState); },
    async compareAndSwap(expectedGeneration, next) {
      saveCount += 1;
      if (saveCount === stateSaveFailureAt) throw Object.assign(new Error("state_save_failed"), { code: "state_save_failed" });
      if (currentState.generation !== expectedGeneration) throw new Error("ownership_generation_conflict");
      currentState = { ...structuredClone(next), generation: expectedGeneration + 1 };
      return structuredClone(currentState);
    },
  };
  const testOwnershipCoordinator = getOwnershipCoordinator(ownershipStore);
  const windowsHost = {
    async discoverGit() {
      const value = Array.isArray(gitDiscoveries) && gitDiscoveries.length > 0 ? gitDiscoveries.shift() : gitDiscovery;
      if (value instanceof Error) throw value;
      return structuredClone(value);
    },
    async verifyAuthenticode(filePath) {
      calls.verified.push({ kind: "authenticode", filePath });
      await onAuthenticode?.(filePath);
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
      const shortcut = { ...record, path: path.win32.join(record.desktopPath, `${record.name}（1）.lnk`) };
      if (typeof record.reservationId === "string") shortcutReservations.set(record.reservationId, structuredClone(shortcut));
      return shortcut;
    },
    async recoverShortcutReservation({ reservationId }) {
      const shortcut = shortcutReservations.get(reservationId);
      return shortcut ? { kind: "shortcut", shortcut: structuredClone(shortcut) } : { kind: "absent" };
    },
    async removeRecordedShortcut(record) {
      calls.removedShortcuts.push(record);
      for (const [id, shortcut] of shortcutReservations) {
        if (shortcut.path === record.path) shortcutReservations.delete(id);
      }
      return { removed: true };
    },
    async runGitInstaller(plan) {
      calls.gitInstalls.push(plan);
      await plan.onStarted?.();
      await onGitInstall?.(plan);
      if (gitInstallFailure) throw gitInstallFailure;
      return { targetDir: plan.targetDir };
    },
    async runGitUninstaller(plan) {
      calls.gitUninstalls.push(plan); await plan.onStarted?.(); await onGitUninstall?.(plan); return { installDir: plan.installDir };
    },
  };
  const archiveService = {
    async extractArchive(plan) {
      calls.extracts.push(plan);
      await onExtract?.(plan);
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
    previousComponents: new Map(),
    async promotePreparedVersion(plan) {
      calls.promotions.push(plan);
      if (slotFailure) throw slotFailure;
      assert.equal(archiveReceipts.has(plan.verificationReceipt), true);
      const rootPath = plan.componentId === "chatgpt" ? INSTALL_ROOT : path.win32.join(INSTALL_ROOT, "V2RayN");
      assert.equal(plan.rootPath, rootPath);
      const next = await testOwnershipCoordinator.store.load();
      this.previousComponents.set(plan.componentId, structuredClone(next.components[plan.componentId] ?? null));
      next.installRoot = INSTALL_ROOT;
      next.components[plan.componentId] = {
        managed: true,
        installPath: path.win32.join(rootPath, plan.componentId === "chatgpt" ? "c" : "current"),
        version: plan.version, treeDigest: plan.treeDigest, manifestDigest: plan.manifestDigest,
        ...structuredClone(plan.runtimeMetadata),
      };
      if (this.previousComponents.get(plan.componentId)) {
        next.rollback = [{ componentId: plan.componentId, path: `${rootPath}\\previous` }];
      }
      await testOwnershipCoordinator.store.save(next);
      return { componentId: plan.componentId, version: plan.version, rollbackAvailable: state.installRoot !== null };
    },
    async rollbackVersion(componentId) {
      calls.rollbacks.push(componentId);
      if (rollbackFailure) throw rollbackFailure;
      const next = await testOwnershipCoordinator.store.load();
      const previous = this.previousComponents.get(componentId);
      if (!previous) throw new Error("rollback_not_available");
      next.components[componentId] = structuredClone(previous);
      next.rollback = null;
      await testOwnershipCoordinator.store.save(next);
      return { componentId, version: previous.version, rollbackAvailable: false };
    },
  };
  let verifyCalls = 0;
  const componentFiles = {
    async verifyComponent(plan) {
      verifyCalls += 1;
      calls.verified.push({ kind: "component", ...plan });
      await onVerifyComponent?.(plan);
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
      await onReplaceSkill?.(plan);
      assert.equal(skillReceipts.has(plan.verificationReceipt), true);
      skillReceipts.delete(plan.verificationReceipt);
      calls.replacedSkills.push(plan);
      const completionReceipt = Object.freeze(Object.create(null));
      skillCompletionReceipts.add(completionReceipt);
      installedSkillEvidence.set(plan.target, {
        kind: "directory", identity: { volumeSerial: "v", fileId: `skill-${calls.replacedSkills.length}` },
        treeDigest: plan.treeDigest, manifestDigest: plan.manifestDigest,
        skillMdSha256: plan.skillMdSha256,
      });
      return { completionReceipt };
    },
    async finalizeReplacement({ completionReceipt, target, expected }) {
      assert.equal(skillCompletionReceipts.has(completionReceipt), true);
      skillCompletionReceipts.delete(completionReceipt);
      const evidence = installedSkillEvidence.get(target);
      assert.deepEqual({ treeDigest: evidence.treeDigest, manifestDigest: evidence.manifestDigest }, {
        treeDigest: expected.treeDigest, manifestDigest: expected.manifestDigest,
      });
      const proof = `skill-proof-${skillProofs.size + 1}`;
      skillProofs.set(proof, structuredClone(evidence));
      return { completionProof: proof, evidence: structuredClone(evidence) };
    },
    async verifyCompletionProof({ completionProof, target }) {
      const evidence = skillProofs.get(completionProof);
      if (!evidence || !installedSkillEvidence.has(target)) throw new Error("skill_completion_proof_invalid");
      return structuredClone(evidence);
    },
    async recoverCompletionProof({ target, expected }) {
      const evidence = installedSkillEvidence.get(target);
      if (!evidence || evidence.treeDigest !== expected.treeDigest
        || evidence.manifestDigest !== expected.manifestDigest
        || evidence.skillMdSha256 !== expected.skillMdSha256) throw new Error("skill_completion_recovery_mismatch");
      const proof = `skill-proof-${skillProofs.size + 1}`;
      skillProofs.set(proof, structuredClone(evidence));
      return { completionProof: proof, evidence: structuredClone(evidence) };
    },
    async deleteExact(plan) {
      calls.deletedSkills.push(plan); deletedSkillTargets.add(plan.target); installedSkillEvidence.delete(plan.target);
    },
    async inspectExact({ target }) {
      if (deletedSkillTargets.has(target)) return { kind: "absent" };
      if (installedSkillEvidence.has(target)) return structuredClone(installedSkillEvidence.get(target));
      const record = currentState.skills.documents;
      if (record?.target !== target) return { kind: "absent" };
      const previous = currentState.activeTask?.previousEvidence;
      const evidence = {
        kind: "directory",
        identity: record.identity ?? previous?.identity ?? { volumeSerial: "v", fileId: "existing" },
        treeDigest: record.treeDigest ?? previous?.treeDigest ?? DIGEST_B,
        manifestDigest: record.manifestDigest ?? previous?.manifestDigest ?? DIGEST_A,
        skillMdSha256: record.skillMdSha256,
      };
      installedSkillEvidence.set(target, evidence);
      return structuredClone(evidence);
    },
  };
  const gitIdentityCapabilities = {
    async pinPlan(plan) {
      const capability = Object.freeze(Object.create(null));
      gitPins.add(capability); calls.gitPins.push(plan); await onGitPin?.(plan); return capability;
    },
    async revalidate(capability, plan) {
      assert.equal(gitPins.has(capability), true); calls.gitRevalidates.push(plan); return true;
    },
    async releaseMutable(capability) {
      assert.equal(gitPins.has(capability), true); calls.gitMutableReleases.push(capability);
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
    async download(plan) {
      calls.downloads.push(plan);
      await onDownload?.(plan);
      return { path: plan.destination, size: plan.asset.size, sha256: plan.asset.sha256 };
    },
  };
  const adapterOptions = {
    catalogService,
    installRootCapability,
    skillsRootCapability,
    desktopCapability: DESKTOP_CAPABILITY,
    downloader, archiveService, versionSlots, ownershipStore, windowsHost, componentFiles, skillFiles,
    gitIdentityCapabilities,
    ...(gitExecutionTimeoutMs === undefined ? {} : { gitExecutionTimeoutMs }),
    resolveSkillTarget: async ({ skillsRoot, skillId }) => path.win32.join(skillsRoot, skillId),
  };
  const adapters = createComponentAdapters(adapterOptions);
  return {
    adapters, calls, getState: () => structuredClone(currentState),
    createAnotherAdapters: () => createComponentAdapters(adapterOptions),
  };
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
  assert.equal(committed.status, "succeeded", committed.message);
  assert.equal(calls.promotions[0].rootPath, INSTALL_ROOT);
  assert.equal(getState().components.chatgpt.installPath, "D:\\CBApps\\c");
});

test("prepare or download failure never persists the selected install root", async () => {
  const { adapters, calls, getState } = fixture();
  calls.downloads.push = () => { throw Object.assign(new Error("download_failed"), { code: "download_failed" }); };
  const result = await adapters.chatgpt.prepare({ taskId: "download-fail" });
  assert.equal(result.status, "failed");
  assert.equal(getState().installRoot, null);
  assert.equal(getState().activeTask, null);
});

test("post-promotion shortcut, state, or restart failures do not report failed after a verified switch", async (t) => {
  for (const [name, options] of [
    ["shortcut", { shortcutFailure: new Error("shortcut") }],
    ["state", { stateSaveFailureAt: 4 }],
    ["restart", { running: true, restartFailure: new Error("restart") }],
  ]) {
    await t.test(name, async () => {
      const state = emptyState(INSTALL_ROOT);
      state.components.chatgpt = {
        managed: true, installPath: "D:\\CBApps\\c", version: "1.0.0",
        entrypointPath: "D:\\CBApps\\c\\ChatGPT.exe", requiredFiles: ["D:\\CBApps\\c\\ChatGPT.exe"],
      };
      const { adapters, calls } = fixture({ state, ...options });
      await adapters.chatgpt.prepare({ taskId: `warning-${name.replace(" ", "-")}` });
      const committed = await adapters.chatgpt.commit({ taskId: `warning-${name.replace(" ", "-")}` });
      assert.equal(committed.status, "succeeded");
      assert.match(committed.message, /warning|committed/u);
      assert.equal(calls.promotions.length, 1);
    });
  }
});

test("shortcut creation is reserved before mutation and adopted without duplication after an applied-state save failure", async () => {
  const { adapters, calls, getState } = fixture({ stateSaveFailureAt: 6 });
  await adapters.chatgpt.prepare({ taskId: "shortcut-recover" });
  const committed = await adapters.chatgpt.commit({ taskId: "shortcut-recover" });
  assert.equal(committed.status, "succeeded");
  assert.equal(getState().activeTask.kind, "component-shortcut");
  assert.equal(getState().activeTask.phase, "reserved");
  assert.equal(calls.shortcuts.length, 1);
  assert.equal((await adapters.chatgpt.inspectInstalled({})).status, "succeeded");
  assert.equal(calls.shortcuts.length, 1);
  assert.equal(getState().activeTask, null);
  assert.equal(getState().shortcuts.length, 1);
});

test("core verification failure rolls an update back and returns failed with the restored version", async () => {
  const state = emptyState(INSTALL_ROOT);
  state.components.chatgpt = {
    managed: true, installPath: "D:\\CBApps\\c", version: "1.0.0",
    entrypointPath: "D:\\CBApps\\c\\OldChat.exe", requiredFiles: ["D:\\CBApps\\c\\OldChat.exe"],
  };
  const { adapters, calls, getState } = fixture({ state, running: true, finalVerifyFailure: new Error("final") });
  await adapters.chatgpt.prepare({ taskId: "verify-rollback" });
  const committed = await adapters.chatgpt.commit({ taskId: "verify-rollback" });
  assert.equal(committed.status, "failed");
  assert.equal(committed.versionAfter, "1.0.0");
  assert.deepEqual(calls.rollbacks, ["chatgpt"]);
  assert.deepEqual(calls.stopped[0], ["D:\\CBApps\\c\\OldChat.exe"]);
  assert.equal(calls.launched.at(-1), "D:\\CBApps\\c\\OldChat.exe");
  assert.equal(getState().components.chatgpt.entrypointPath, "D:\\CBApps\\c\\OldChat.exe");
  assert.deepEqual(calls.shortcuts, []);
});

test("core verification failure on first install records failed-unhealthy and never reports success", async () => {
  const { adapters, calls, getState } = fixture({ finalVerifyFailure: new Error("final") });
  await adapters.chatgpt.prepare({ taskId: "verify-first" });
  const committed = await adapters.chatgpt.commit({ taskId: "verify-first" });
  assert.equal(committed.status, "failed");
  assert.equal(committed.versionAfter, "2.0.0");
  assert.equal(committed.rollbackAvailable, false);
  assert.equal(getState().components.chatgpt.health, "failed-unhealthy");
  assert.deepEqual(calls.shortcuts, []);
  assert.deepEqual(calls.launched, []);
});

test("an interrupted first-install health save recovers pending-verify durably and inspect never reports normal", async () => {
  const { adapters, calls, getState } = fixture({
    finalVerifyFailure: new Error("final"), stateSaveFailureAt: 4,
  });
  await adapters.chatgpt.prepare({ taskId: "verify-first-interrupted" });
  const committed = await adapters.chatgpt.commit({ taskId: "verify-first-interrupted" });
  assert.equal(committed.status, "failed");
  assert.equal(getState().components.chatgpt.health, "pending-verify");

  const inspected = await adapters.chatgpt.inspectInstalled({});
  assert.equal(inspected.status, "failed");
  assert.equal(inspected.versionBefore, "2.0.0");
  assert.equal(inspected.rollbackAvailable, false);
  assert.match(inspected.message, /component_failed_unhealthy/u);
  assert.equal(getState().components.chatgpt.health, "failed-unhealthy");

  const inspectedAfterRestart = await adapters.chatgpt.inspectInstalled({});
  assert.equal(inspectedAfterRestart.status, "failed");
  assert.equal(inspectedAfterRestart.versionAfter, "2.0.0");
});

test("rollback failure after core verification failure reports the actually installed new version", async () => {
  const state = emptyState(INSTALL_ROOT);
  state.components.chatgpt = {
    managed: true, installPath: "D:\\CBApps\\c", version: "1.0.0",
    entrypointPath: "D:\\CBApps\\c\\OldChat.exe", requiredFiles: ["D:\\CBApps\\c\\OldChat.exe"],
  };
  const { adapters } = fixture({
    state, finalVerifyFailure: new Error("final"),
    rollbackFailure: Object.assign(new Error("rollback_failed"), { code: "rollback_failed" }),
  });
  await adapters.chatgpt.prepare({ taskId: "verify-rollback-fail" });
  const committed = await adapters.chatgpt.commit({ taskId: "verify-rollback-fail" });
  assert.equal(committed.status, "failed");
  assert.equal(committed.versionAfter, "2.0.0");
  assert.equal(committed.rollbackAvailable, true);
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
  state.components.v2rayn = {
    managed: true, installPath: "D:\\CBApps\\V2RayN\\current", version: "6.0.0",
    entrypointPath: "D:\\CBApps\\V2RayN\\current\\v2rayN.exe",
    requiredFiles: ["D:\\CBApps\\V2RayN\\current\\v2rayN.exe"],
  };
  const { adapters, calls } = fixture({ state, running: true });
  await adapters.v2rayn.prepare({ taskId: "v2" });
  const committed = await adapters.v2rayn.commit({ taskId: "v2" });
  assert.equal(committed.status, "succeeded");
  assert.deepEqual(calls.stopped[0], ["D:\\CBApps\\V2RayN\\current\\v2rayN.exe"]);
  assert.equal(calls.persistentPrepared[0].rootPath, "D:\\CBApps\\V2RayN-Data");
});

test("a completed native component uninstall is recovered after its final state save fails", async () => {
  const state = emptyState(INSTALL_ROOT);
  state.components.chatgpt = {
    managed: true, installPath: "D:\\CBApps\\c", version: "2.0.0",
    entrypointPath: "D:\\CBApps\\c\\ChatGPT.exe", requiredFiles: ["D:\\CBApps\\c\\ChatGPT.exe"],
  };
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
  const { adapters, calls, getState } = fixture({
    gitDiscoveries: [{ kind: "none" }, { kind: "none" }, registered], gitDiscovery: registered,
  });
  await adapters.git.prepare({ taskId: "git-managed", selected: true });
  const installed = await adapters.git.commit({ taskId: "git-managed" });
  assert.equal(installed.status, "succeeded");
  assert.equal(calls.gitInstalls[0].targetDir, "D:\\CBApps\\Git");
  assert.equal(calls.promotions.length, 0);
  assert.equal(getState().components.git.installPath, "D:\\CBApps\\Git");
  assert.equal(getState().components.git.currentInstaller.version, "2.51.0");
  assert.equal(calls.gitPins[0].targetMustBeAbsent, true);
  assert.deepEqual(calls.shortcuts, []);
});

test("managed Git update pins the existing registered target and rejects replacement before installer execution", async () => {
  const state = emptyState(INSTALL_ROOT);
  state.components.git = {
    managed: true, installPath: "D:\\CBApps\\Git", version: "2.50.0",
    executablePath: "D:\\CBApps\\Git\\cmd\\git.exe", uninstallerPath: "D:\\CBApps\\Git\\unins000.exe",
    currentInstaller: { path: "D:\\CBApps\\downloads\\git-2.50.0.exe", sha256: DIGEST_B, version: "2.50.0" },
    previousInstaller: null,
  };
  const current = { ...externalGit, version: "2.50.0", installDir: state.components.git.installPath,
    executablePath: state.components.git.executablePath, uninstallerPath: state.components.git.uninstallerPath };
  const replaced = { ...current, uninstallerPath: "D:\\CBApps\\Git\\unins001.exe" };
  const { adapters, calls } = fixture({ state, gitDiscoveries: [current, replaced], gitDiscovery: replaced });
  assert.equal((await adapters.git.prepare({ taskId: "git-managed-race", selected: true })).status, "succeeded");
  assert.equal(calls.gitPins[0].discovery.uninstallerPath, current.uninstallerPath);
  assert.equal((await adapters.git.commit({ taskId: "git-managed-race" })).status, "failed");
  assert.deepEqual(calls.gitInstalls, []);
});

test("a third managed Git update reports cleanup persistence failure and recovers it immediately", async () => {
  const state = emptyState(INSTALL_ROOT);
  state.components.git = {
    managed: true, installPath: "D:\\CBApps\\Git", version: "2.50.0",
    executablePath: "D:\\CBApps\\Git\\cmd\\git.exe", uninstallerPath: "D:\\CBApps\\Git\\unins000.exe",
    currentInstaller: { path: "D:\\CBApps\\downloads\\git-2.50.0.exe", sha256: DIGEST_B, version: "2.50.0" },
    previousInstaller: { path: "D:\\CBApps\\downloads\\git-2.49.0.exe", sha256: DIGEST_A, version: "2.49.0" },
  };
  const current = { ...externalGit, version: "2.50.0", installDir: state.components.git.installPath,
    executablePath: state.components.git.executablePath, uninstallerPath: state.components.git.uninstallerPath };
  const installed = { ...current, version: "2.51.0" };
  const { adapters, calls, getState } = fixture({
    state, gitDiscoveries: [current, current, installed], gitDiscovery: installed, stateSaveFailureAt: 5,
  });
  const prepared = await adapters.git.prepare({ taskId: "git-third", selected: true });
  assert.equal(prepared.status, "succeeded");
  const committed = await adapters.git.commit({ taskId: "git-third" });
  assert.equal(committed.status, "failed");
  assert.match(committed.message, /git_managed_recovered_after_state_failure/u);
  assert.equal(getState().activeTask, null);
  assert.equal(calls.discarded.length, 2);
  assert.equal((await adapters.git.inspectInstalled({})).status, "succeeded");
  assert.equal(calls.discarded.length, 2);
  assert.equal(getState().components.git.currentInstaller.version, "2.51.0");
  assert.equal(getState().components.git.previousInstaller.version, "2.50.0");
  assert.equal(calls.discarded[0].version, "2.49.0");
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
  const current = { ...installed, version: "2.50.0" };
  const { adapters, calls, getState } = fixture({
    state, gitDiscoveries: [current, current, installed], gitDiscovery: installed, stateSaveFailureAt: 4,
  });
  await adapters.git.prepare({ taskId: "git-adopt", selected: true });
  const committed = await adapters.git.commit({ taskId: "git-adopt" });
  assert.equal(committed.status, "failed", committed.message);
  assert.match(committed.message, /recovered_after_state_failure/u);
  assert.equal(committed.versionAfter, "2.51.0");
  assert.equal(getState().activeTask, null);
  const installsBeforeInspect = calls.gitInstalls.length;
  const inspected = await adapters.git.inspectInstalled({});
  assert.equal(inspected.status, "succeeded", inspected.message);
  assert.equal(calls.gitInstalls.length, installsBeforeInspect, "strict recovery must not execute the installer twice");
  assert.equal(getState().components.git.version, "2.51.0");
  assert.equal(getState().components.git.previousInstaller.version, "2.50.0");
  assert.equal(getState().activeTask, null);
});

test("an aborted Git process keeps a recoverable claim and receives the configured deadline", async () => {
  const controller = new AbortController();
  const abortError = Object.assign(new Error("installer_aborted"), { name: "AbortError", code: "ABORT_ERR" });
  const first = fixture({
    gitDiscovery: { kind: "none" },
    gitExecutionTimeoutMs: 30_000,
    onGitInstall(plan) {
      assert.equal(plan.signal, controller.signal);
      assert.equal(plan.timeoutMs, 30_000);
      throw abortError;
    },
  });
  assert.equal((await first.adapters.git.prepare({ taskId: "cancelled-git", selected: true })).status, "succeeded");
  const committed = await first.adapters.git.commit({ taskId: "cancelled-git", signal: controller.signal });
  assert.equal(committed.status, "failed");
  assert.match(committed.message, /ABORT_ERR/u);
  assert.equal(first.getState().activeTask.kind, "git-install");
  const recovered = await first.createAnotherAdapters().git.inspectInstalled({});
  assert.equal(recovered.status, "skipped");
  assert.equal(first.getState().activeTask, null);
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
  const restored = { ...discovery, version: "2.50.0" };
  const { adapters, calls, getState } = fixture({ state, gitDiscoveries: [discovery, restored], gitDiscovery: restored });
  const rolled = await adapters.git.rollback({ taskId: "git-rollback" });
  assert.equal(rolled.status, "succeeded", rolled.message);
  assert.equal(calls.gitUninstalls[0].uninstallerPath, discovery.uninstallerPath);
  assert.equal(calls.gitUninstalls[0].installDir, discovery.installDir);
  assert.equal(calls.gitUninstalls[0].timeoutMs, 900_000);
  assert.equal(typeof calls.gitUninstalls[0].onStarted, "function");
  assert.equal(calls.gitPins.some((record) => record.discovery?.uninstallerPath === discovery.uninstallerPath), true);
  assert.equal(calls.gitPins.some((record) => record.targetDir === state.components.git.installPath
    && record.targetMustBeAbsent === true), true);
  assert.equal(calls.gitMutableReleases.length, 2, "uninstaller and installer targets release only after each spawn");
  assert.equal(calls.gitInstalls[0].installerPath, state.components.git.previousInstaller.path);
  assert.equal(calls.gitInstalls[0].targetDir, "D:\\CBApps\\Git");
  assert.equal(getState().components.git.version, "2.50.0");
  assert.equal(getState().components.git.previousInstaller, null);
});

test("managed Git rollback reports failed-pending and is adopted after post-reinstall state failure", async () => {
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
  const current = { ...rolledBack, version: "2.51.0" };
  const { adapters, calls, getState } = fixture({
    state, gitDiscoveries: [current, rolledBack, rolledBack], gitDiscovery: rolledBack, stateSaveFailureAt: 3,
  });
  const rolled = await adapters.git.rollback({ taskId: "git-rollback-adopt" });
  assert.equal(rolled.status, "failed");
  assert.match(rolled.message, /state_save_failed/u);
  assert.equal(getState().activeTask.kind, "git-rollback");
  assert.equal(getState().activeTask.phase, "installing");
  const recovered = await adapters.git.inspectInstalled({});
  assert.equal(recovered.status, "succeeded", recovered.message);
  assert.equal(getState().components.git.version, "2.50.0");
  assert.equal(getState().activeTask, null);
  assert.equal(calls.discarded.length, 1);
});

test("rollback crash recovery pins an absent target until the replacement installer starts", async () => {
  const state = emptyState(INSTALL_ROOT);
  const rejectedInstaller = { path: "D:\\CBApps\\downloads\\git-2.51.0.exe", sha256: DIGEST_A, version: "2.51.0" };
  const previousInstaller = { path: "D:\\CBApps\\downloads\\git-2.50.0.exe", sha256: DIGEST_B, version: "2.50.0" };
  state.components.git = {
    managed: true, installPath: "D:\\CBApps\\Git", version: "2.51.0",
    executablePath: "D:\\CBApps\\Git\\cmd\\git.exe", uninstallerPath: "D:\\CBApps\\Git\\unins000.exe",
    currentInstaller: rejectedInstaller, previousInstaller,
  };
  state.activeTask = {
    kind: "git-rollback", phase: "installing", taskId: "recover-rollback", version: previousInstaller.version,
    targetDir: state.components.git.installPath, executablePath: state.components.git.executablePath,
    installerPath: previousInstaller.path, installerSha256: previousInstaller.sha256,
    rejectedInstaller, leaseScope: "git-execute", leaseNonce: "7".repeat(32),
  };
  const restored = {
    ...externalGit, version: previousInstaller.version, installDir: state.components.git.installPath,
    executablePath: state.components.git.executablePath, uninstallerPath: state.components.git.uninstallerPath,
  };
  const { adapters, calls } = fixture({ state, gitDiscoveries: [{ kind: "none" }, restored], gitDiscovery: restored });
  const inspected = await adapters.git.inspectInstalled({});
  assert.equal(inspected.status, "succeeded", inspected.message);
  assert.equal(calls.gitPins.some((record) => record.targetDir === state.components.git.installPath
    && record.targetMustBeAbsent === true), true);
  assert.equal(calls.gitMutableReleases.length, 1);
});

test("rollback recovery distinguishes pre-uninstall abort, post-uninstall resume, and phase mismatch", async () => {
  const makeState = (phase, taskId) => {
    const state = emptyState(INSTALL_ROOT);
    const rejectedInstaller = { path: "D:\\CBApps\\downloads\\git-2.51.0.exe", sha256: DIGEST_A, version: "2.51.0" };
    const previousInstaller = { path: "D:\\CBApps\\downloads\\git-2.50.0.exe", sha256: DIGEST_B, version: "2.50.0" };
    state.components.git = {
      managed: true, installPath: "D:\\CBApps\\Git", version: "2.51.0",
      executablePath: "D:\\CBApps\\Git\\cmd\\git.exe", uninstallerPath: "D:\\CBApps\\Git\\unins000.exe",
      currentInstaller: rejectedInstaller, previousInstaller,
    };
    state.activeTask = {
      kind: "git-rollback", phase, taskId, version: previousInstaller.version,
      targetDir: state.components.git.installPath, executablePath: state.components.git.executablePath,
      installerPath: previousInstaller.path, installerSha256: previousInstaller.sha256,
      rejectedInstaller, leaseScope: "git-execute", leaseNonce: "7".repeat(32),
    };
    return state;
  };
  const current = { ...externalGit, version: "2.51.0", installDir: "D:\\CBApps\\Git",
    executablePath: "D:\\CBApps\\Git\\cmd\\git.exe", uninstallerPath: "D:\\CBApps\\Git\\unins000.exe" };
  const restored = { ...current, version: "2.50.0" };

  const preUninstall = fixture({ state: makeState("uninstalling", "fault-pre-uninstall"), gitDiscovery: current });
  assert.equal((await preUninstall.adapters.git.inspectInstalled({})).status, "succeeded");
  assert.equal(preUninstall.getState().activeTask, null);
  assert.deepEqual(preUninstall.calls.gitInstalls, []);

  const postUninstall = fixture({
    state: makeState("uninstalling", "fault-post-uninstall"),
    gitDiscoveries: [{ kind: "none" }, restored], gitDiscovery: restored,
  });
  assert.equal((await postUninstall.adapters.git.inspectInstalled({})).status, "succeeded");
  assert.equal(postUninstall.getState().components.git.version, "2.50.0");
  assert.equal(postUninstall.calls.gitInstalls.length, 1);

  const mismatched = fixture({ state: makeState("installing", "fault-phase-mismatch"), gitDiscovery: current });
  const mismatchResult = await mismatched.adapters.git.inspectInstalled({});
  assert.equal(mismatchResult.status, "failed");
  assert.match(mismatchResult.message, /git_rollback_recovery_phase_mismatch/u);
  assert.deepEqual(mismatched.calls.gitInstalls, []);
});

test("Git uninstall always runs the registered uninstaller; external requires explicit selection", async () => {
  const { adapters, calls } = fixture({ gitDiscovery: externalGit });
  assert.equal((await adapters.git.uninstall({ selected: false })).status, "failed");
  assert.equal((await adapters.git.uninstall({ selected: true, taskId: "git-uninstall" })).status, "succeeded");
  assert.equal(calls.gitUninstalls[0].uninstallerPath, externalGit.uninstallerPath);
  assert.equal(calls.gitUninstalls[0].installDir, externalGit.installDir);
  assert.equal(calls.gitUninstalls[0].timeoutMs, 900_000);
  assert.equal(typeof calls.gitUninstalls[0].onStarted, "function");
  assert.equal(calls.verified.some((item) => item.kind === "authenticode"
    && item.filePath === externalGit.uninstallerPath), true);
});

test("a hung external Git uninstall keeps a leased persistent claim visible without blocking a second adapter", async () => {
  let unblock;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const blocked = new Promise((resolve) => { unblock = resolve; });
  const first = fixture({
    gitDiscovery: externalGit,
    onGitUninstall: async () => { signalStarted(); await blocked; },
  });
  const removing = first.adapters.git.uninstall({ selected: true, taskId: "hung-external-remove" });
  await started;
  assert.equal(first.getState().activeTask.kind, "git-uninstall");
  assert.equal(first.getState().activeTask.phase, "executing");
  assert.equal(first.getState().activeTask.leaseScope, "git-execute");
  const inspected = await Promise.race([
    first.createAnotherAdapters().git.inspectInstalled({}),
    new Promise((_, reject) => setTimeout(() => reject(new Error("external_uninstall_probe_blocked")), 100)),
  ]);
  assert.equal(inspected.status, "failed");
  assert.match(inspected.message, /component_pending_transaction/u);
  unblock();
  assert.equal((await removing).status, "succeeded");
});

test("a hung managed Git uninstall keeps the same live claim visible to a second adapter", async () => {
  const state = emptyState(INSTALL_ROOT);
  state.components.git = {
    managed: true, installPath: "D:\\CBApps\\Git", version: "2.51.0",
    executablePath: "D:\\CBApps\\Git\\cmd\\git.exe", uninstallerPath: "D:\\CBApps\\Git\\unins000.exe",
    currentInstaller: { path: "D:\\CBApps\\downloads\\git-2.51.0.exe", sha256: DIGEST_A, version: "2.51.0" },
    previousInstaller: null,
  };
  const registered = { ...externalGit, version: "2.51.0", installDir: state.components.git.installPath,
    executablePath: state.components.git.executablePath, uninstallerPath: state.components.git.uninstallerPath };
  let unblock;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const blocked = new Promise((resolve) => { unblock = resolve; });
  const first = fixture({
    state, gitDiscovery: registered,
    onGitUninstall: async () => { signalStarted(); await blocked; },
  });
  const removing = first.adapters.git.uninstall({ selected: true, taskId: "hung-managed-remove" });
  await started;
  assert.deepEqual(first.getState().activeTask, {
    kind: "git-uninstall", phase: "executing", taskId: "hung-managed-remove", managed: true,
    version: registered.version, targetDir: registered.installDir, executablePath: registered.executablePath,
    uninstallerPath: registered.uninstallerPath, leaseScope: "git-execute",
    leaseNonce: first.getState().activeTask.leaseNonce,
  });
  const inspected = await Promise.race([
    first.createAnotherAdapters().git.inspectInstalled({}),
    new Promise((_, reject) => setTimeout(() => reject(new Error("managed_uninstall_probe_blocked")), 100)),
  ]);
  assert.equal(inspected.status, "failed");
  assert.match(inspected.message, /component_pending_transaction/u);
  unblock();
  assert.equal((await removing).status, "succeeded");
});

test("rollback persists one live lease across uninstalling and installing phases", async () => {
  const state = emptyState(INSTALL_ROOT);
  state.components.git = {
    managed: true, installPath: "D:\\CBApps\\Git", version: "2.51.0",
    executablePath: "D:\\CBApps\\Git\\cmd\\git.exe", uninstallerPath: "D:\\CBApps\\Git\\unins000.exe",
    currentInstaller: { path: "D:\\CBApps\\downloads\\git-2.51.0.exe", sha256: DIGEST_A, version: "2.51.0" },
    previousInstaller: { path: "D:\\CBApps\\downloads\\git-2.50.0.exe", sha256: DIGEST_B, version: "2.50.0" },
  };
  const current = { ...externalGit, version: "2.51.0", installDir: state.components.git.installPath,
    executablePath: state.components.git.executablePath, uninstallerPath: state.components.git.uninstallerPath };
  const restored = { ...current, version: "2.50.0" };
  let unblockUninstall;
  let signalUninstall;
  let unblockInstall;
  let signalInstall;
  const uninstallStarted = new Promise((resolve) => { signalUninstall = resolve; });
  const uninstallBlocked = new Promise((resolve) => { unblockUninstall = resolve; });
  const installStarted = new Promise((resolve) => { signalInstall = resolve; });
  const installBlocked = new Promise((resolve) => { unblockInstall = resolve; });
  const first = fixture({
    state, gitDiscoveries: [current, restored], gitDiscovery: restored,
    onGitUninstall: async () => { signalUninstall(); await uninstallBlocked; },
    onGitInstall: async () => { signalInstall(); await installBlocked; },
  });
  const rolling = first.adapters.git.rollback({ taskId: "hung-rollback-install" });
  await uninstallStarted;
  const uninstallingTask = first.getState().activeTask;
  assert.equal(uninstallingTask.kind, "git-rollback");
  assert.equal(uninstallingTask.phase, "uninstalling");
  assert.equal(uninstallingTask.leaseScope, "git-execute");
  const uninstallingInspection = await Promise.race([
    first.createAnotherAdapters().git.inspectInstalled({}),
    new Promise((_, reject) => setTimeout(() => reject(new Error("rollback_uninstall_probe_blocked")), 100)),
  ]);
  assert.equal(uninstallingInspection.status, "failed");
  assert.match(uninstallingInspection.message, /component_pending_transaction/u);
  unblockUninstall();
  await installStarted;
  const task = first.getState().activeTask;
  assert.equal(task.kind, "git-rollback");
  assert.equal(task.phase, "installing");
  assert.equal(task.leaseScope, "git-execute");
  assert.equal(task.leaseNonce, uninstallingTask.leaseNonce);
  const inspected = await Promise.race([
    first.createAnotherAdapters().git.inspectInstalled({}),
    new Promise((_, reject) => setTimeout(() => reject(new Error("rollback_probe_blocked")), 100)),
  ]);
  assert.equal(inspected.status, "failed");
  assert.match(inspected.message, /component_pending_transaction/u);
  unblockInstall();
  assert.equal((await rolling).status, "succeeded");
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
  assert.equal(removed.status, "failed");
  assert.match(removed.message, /state_save_failed/u);
  assert.equal(getState().activeTask.kind, "git-uninstall");
  const inspected = await adapters.git.inspectInstalled({});
  assert.equal(inspected.status, "skipped");
  assert.equal(getState().components.git, undefined);
  assert.equal(getState().activeTask, null);
});

test("Skill replacement consumes a source receipt, reserves ownership, and adopts the new version after save failure", async () => {
  const { adapters, calls, getState } = fixture({ stateSaveFailureAt: 4 });
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

test("reserved Skill recovery does not adopt a tree that only matches the expected SKILL.md hash", async () => {
  const state = emptyState(INSTALL_ROOT);
  state.skills.documents = {
    target: "C:\\Users\\tester\\.codex\\skills\\documents", version: "0.9.0",
    packageSha256: DIGEST_A, skillMdSha256: SKILL_HASH,
  };
  state.activeTask = {
    kind: "skill-replace", phase: "reserved", taskId: "skill-tree-mismatch", skillId: "documents",
    skillsRoot: SKILLS_ROOT, target: state.skills.documents.target, version: "1.0.0",
    packageSha256: DIGEST_B, skillMdSha256: SKILL_HASH,
    treeDigest: DIGEST_A, manifestDigest: DIGEST_B,
    previousEvidence: {
      kind: "directory", identity: { volumeSerial: "v", fileId: "old" },
      treeDigest: DIGEST_B, manifestDigest: DIGEST_A, skillMdSha256: SKILL_HASH,
    },
  };
  const { adapters, getState } = fixture({
    state,
    initialSkillEvidence: {
      target: state.skills.documents.target,
      evidence: {
        kind: "directory", identity: { volumeSerial: "v", fileId: "unexpected" },
        treeDigest: DIGEST_A, manifestDigest: DIGEST_A, skillMdSha256: SKILL_HASH,
      },
    },
  });
  const inspected = await adapters.skills.inspectInstalled({ skillIds: ["documents"] });
  assert.equal(inspected[0].status, "failed");
  assert.equal(getState().skills.documents.version, "0.9.0");
  assert.equal(getState().activeTask.phase, "reserved");
});

test("forged applied Skill completion evidence is rejected without adoption", async () => {
  const state = emptyState(INSTALL_ROOT);
  state.activeTask = {
    kind: "skill-replace", phase: "applied", taskId: "skill-forged", skillId: "documents",
    skillsRoot: SKILLS_ROOT, target: "C:\\Users\\tester\\.codex\\skills\\documents", version: "1.0.0",
    packageSha256: DIGEST_B, skillMdSha256: SKILL_HASH, treeDigest: DIGEST_A, manifestDigest: DIGEST_B,
    previousEvidence: { kind: "absent" }, completionProof: { forged: true },
  };
  const { adapters, getState } = fixture({ state });
  const inspected = await adapters.skills.inspectInstalled({ skillIds: ["documents"] });
  assert.equal(inspected[0].status, "failed");
  assert.equal(getState().skills.documents, undefined);
  assert.equal(getState().activeTask.phase, "applied");
});

test("reserved Skill recovery safely clears a pre-mutation failure after verifying the complete previous tree", async () => {
  const target = "C:\\Users\\tester\\.codex\\skills\\documents";
  const state = emptyState(INSTALL_ROOT);
  state.skills.documents = {
    target, version: "0.9.0", packageSha256: DIGEST_A, skillMdSha256: OLD_SKILL_HASH,
    identity: { volumeSerial: "v", fileId: "old" }, treeDigest: DIGEST_B, manifestDigest: DIGEST_A,
  };
  state.activeTask = {
    kind: "skill-replace", phase: "reserved", taskId: "skill-before-mutation", skillId: "documents",
    skillsRoot: SKILLS_ROOT, target, version: "1.0.0", packageSha256: DIGEST_B,
    skillMdSha256: SKILL_HASH, treeDigest: DIGEST_A, manifestDigest: DIGEST_B,
    previousEvidence: {
      kind: "directory", identity: state.skills.documents.identity,
      treeDigest: DIGEST_B, manifestDigest: DIGEST_A, skillMdSha256: OLD_SKILL_HASH,
    },
  };
  const { adapters, getState } = fixture({ state, skillHashes: [OLD_SKILL_HASH] });
  const inspected = await adapters.skills.inspectInstalled({ skillIds: ["documents"] });
  assert.equal(inspected[0].status, "succeeded", JSON.stringify(inspected[0]));
  assert.equal(inspected[0].versionAfter, "0.9.0");
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
  state.components.chatgpt = {
    managed: true, installPath: "D:\\CBApps\\c", version: "1.0.0",
    entrypointPath: "D:\\CBApps\\c\\ChatGPT.exe", requiredFiles: ["D:\\CBApps\\c\\ChatGPT.exe"],
  };
  const { adapters } = fixture({ state, slotFailure: Object.assign(new Error("slot_failed"), { code: "slot_failed" }) });
  await adapters.chatgpt.prepare({ taskId: "latest-state" });
  const failed = await adapters.chatgpt.commit({ taskId: "latest-state" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.versionBefore, "1.0.0");
  assert.equal(failed.versionAfter, "1.0.0");
});

async function mutableDirectoryCapabilities() {
  let installIdentity = 1;
  let skillsIdentity = 1;
  const stat = (identity) => ({
    dev: 1, ino: identity, isDirectory: () => true,
    isSymbolicLink: () => false, isReparsePoint: () => false,
  });
  const installRootCapability = await authorizeInstallRoot({
    candidate: INSTALL_ROOT,
    env: { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", USERPROFILE: "C:\\Users\\tester" },
    maxRelativePath: 180, access: async () => {}, realpath: async (value) => value,
    lstat: async () => stat(installIdentity),
  });
  const skillsRootCapability = await authorizeSkillsRoot({
    candidate: SKILLS_ROOT, realpath: async (value) => value,
    lstat: async () => stat(skillsIdentity),
  });
  return {
    installRootCapability, skillsRootCapability,
    driftInstall: () => { installIdentity += 1; },
    driftSkills: () => { skillsIdentity += 1; },
  };
}

test("skills prepare revalidates install and skills roots after download before extraction", async () => {
  const capabilities = await mutableDirectoryCapabilities();
  const { adapters, calls, getState } = fixture({
    ...capabilities,
    onDownload: () => capabilities.driftInstall(),
  });
  const [prepared] = await adapters.skills.prepare({ taskId: "skills-drift-install", skillIds: ["documents"] });
  assert.equal(prepared.status, "failed");
  assert.match(prepared.message, /install_root_identity_changed/u);
  assert.equal(calls.downloads.length, 1);
  assert.equal(calls.extracts.length, 0);
  assert.deepEqual(getState().skills, {});
});

for (const [stage, hook] of [
  ["download", "onDownload"],
  ["extract", "onExtract"],
  ["verification", "onVerifyComponent"],
]) {
  test(`archive prepare rejects install-root identity drift after ${stage}`, async () => {
    const capabilities = await mutableDirectoryCapabilities();
    const { adapters, calls, getState } = fixture({
      ...capabilities,
      [hook]: () => capabilities.driftInstall(),
    });
    const prepared = await adapters.chatgpt.prepare({ taskId: `archive-drift-${stage}` });
    assert.equal(prepared.status, "failed");
    assert.match(prepared.message, /install_root_identity_changed/u);
    assert.equal(getState().activeTask, null);
    assert.equal(calls.promotions.length, 0);
  });
}

for (const [stage, hook] of [
  ["download", "onDownload"],
  ["authenticode", "onAuthenticode"],
  ["identity pin", "onGitPin"],
]) {
  test(`Git prepare rejects install-root identity drift after ${stage}`, async () => {
    const capabilities = await mutableDirectoryCapabilities();
    const { adapters, calls, getState } = fixture({
      ...capabilities,
      [hook]: () => capabilities.driftInstall(),
    });
    const prepared = await adapters.git.prepare({ taskId: `git-drift-${stage.replaceAll(" ", "-")}`, selected: true });
    assert.equal(prepared.status, "failed");
    assert.match(prepared.message, /install_root_identity_changed/u);
    assert.equal(getState().activeTask, null);
    assert.equal(calls.gitInstalls.length, 0);
  });
}

test("skills commit revalidates both roots before replacement", async () => {
  const capabilities = await mutableDirectoryCapabilities();
  const { adapters, calls, getState } = fixture(capabilities);
  assert.equal((await adapters.skills.prepare({ taskId: "skills-drift-root", skillIds: ["documents"] }))[0].status, "succeeded");
  capabilities.driftSkills();
  const [committed] = await adapters.skills.commit({ taskId: "skills-drift-root", skillIds: ["documents"] });
  assert.equal(committed.status, "failed");
  assert.match(committed.message, /skills_root_identity_changed/u);
  assert.equal(calls.replacedSkills.length, 0);
  assert.deepEqual(getState().skills, {});
});

test("skills reject a catalog whose staging peak exceeds the authorized Windows path budget", async () => {
  const excessive = `${"nested/".repeat(36)}SKILL.md`;
  const catalogService = trustedCatalog({ skills: [{ ...skill("documents"), files: ["SKILL.md", excessive] }] });
  const { adapters, calls } = fixture({ catalogService });
  const [prepared] = await adapters.skills.prepare({ taskId: "skills-long-path", skillIds: ["documents"] });
  assert.equal(prepared.status, "failed");
  assert.match(prepared.message, /install_peak_path_too_long/u);
  assert.equal(calls.downloads.length, 0);
  assert.equal(calls.extracts.length, 0);
});

test("a hung download releases the global ownership lock while its claim makes concurrent mutations pending", async () => {
  let releaseDownload;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseDownload = resolve; });
  const first = fixture({ onDownload: async () => { signalStarted(); await blocked; } });
  const secondAdapters = first.createAnotherAdapters();
  const preparing = first.adapters.chatgpt.prepare({ taskId: "hung-download" });
  await started;

  const inspected = await Promise.race([
    secondAdapters.chatgpt.inspectInstalled({}),
    new Promise((_, reject) => setTimeout(() => reject(new Error("inspect_blocked")), 100)),
  ]);
  assert.equal(inspected.status, "failed");
  assert.match(inspected.message, /component_pending_transaction/u);
  const competing = await secondAdapters.v2rayn.uninstall({ taskId: "competing-remove" });
  assert.equal(competing.status, "failed");
  assert.match(competing.message, /component_pending_transaction/u);

  const independent = fixture();
  const independentInspect = await independent.adapters.chatgpt.inspectInstalled({});
  assert.equal(independentInspect.status, "skipped");
  releaseDownload();
  assert.equal((await preparing).status, "succeeded");
});

test("a hung managed Git installer releases the ownership lock and keeps the durable claim pending", async () => {
  const state = emptyState(INSTALL_ROOT);
  state.components.git = {
    managed: true, installPath: "D:\\CBApps\\Git", version: "2.50.0",
    executablePath: "D:\\CBApps\\Git\\cmd\\git.exe", uninstallerPath: "D:\\CBApps\\Git\\unins000.exe",
    currentInstaller: { path: "D:\\CBApps\\downloads\\git-2.50.0.exe", sha256: DIGEST_B, version: "2.50.0" },
    previousInstaller: null,
  };
  const current = {
    ...externalGit, version: "2.50.0", installDir: state.components.git.installPath,
    executablePath: state.components.git.executablePath, uninstallerPath: state.components.git.uninstallerPath,
  };
  const installed = { ...current, version: "2.51.0" };
  let releaseInstaller;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseInstaller = resolve; });
  const { adapters, calls, getState, createAnotherAdapters } = fixture({
    state, gitDiscoveries: [current, current, installed], gitDiscovery: installed,
    onGitInstall: async () => { signalStarted(); await blocked; },
  });
  assert.equal((await adapters.git.prepare({ taskId: "hung-installer", selected: true })).status, "succeeded");
  const secondAdapters = createAnotherAdapters();
  const committing = adapters.git.commit({ taskId: "hung-installer" });
  await started;

  const inspected = await Promise.race([
    secondAdapters.git.inspectInstalled({}),
    new Promise((_, reject) => setTimeout(() => reject(new Error("installer_inspect_blocked")), 100)),
  ]);
  assert.equal(inspected.status, "failed");
  assert.match(inspected.message, /component_pending_transaction/u);
  const competing = await secondAdapters.git.uninstall({ selected: true, taskId: "competing-git-remove" });
  assert.equal(competing.status, "failed");
  assert.match(competing.message, /component_pending_transaction/u);
  assert.equal(getState().activeTask.kind, "git-install");
  assert.equal(calls.gitMutableReleases.length, 1);

  releaseInstaller();
  assert.equal((await committing).status, "succeeded");
  assert.equal(getState().components.git.version, "2.51.0");
});

test("a hung external Git installer also persists a live lease claim visible to a second adapter", async () => {
  let releaseInstaller;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseInstaller = resolve; });
  const first = fixture({
    gitDiscovery: externalGit,
    onGitInstall: async () => { signalStarted(); await blocked; },
  });
  assert.equal((await first.adapters.git.prepare({ taskId: "hung-external", selected: true })).status, "succeeded");
  const secondAdapters = first.createAnotherAdapters();
  const committing = first.adapters.git.commit({ taskId: "hung-external" });
  await started;
  const inspected = await Promise.race([
    secondAdapters.git.inspectInstalled({}),
    new Promise((_, reject) => setTimeout(() => reject(new Error("external_inspect_blocked")), 100)),
  ]);
  assert.equal(inspected.status, "failed");
  assert.match(inspected.message, /component_pending_transaction/u);
  releaseInstaller();
  assert.equal((await committing).status, "succeeded");
  assert.equal(first.getState().activeTask, null);
});

test("a prepare claim abandoned by a crashed process is cleared on restart", async () => {
  const state = emptyState();
  state.activeTask = {
    kind: "component-prepare", taskId: "crashed-download", componentId: "chatgpt", version: "2.0.0",
    leaseScope: "prepare", leaseNonce: "1".repeat(32),
  };
  const { adapters, getState } = fixture({ state });
  const inspected = await adapters.chatgpt.inspectInstalled({});
  assert.equal(inspected.status, "skipped");
  assert.equal(getState().activeTask, null);
  assert.equal(getState().lastTask.action, "prepare-aborted");
});

test("a migrated round3 prepare is explicitly abandoned without probing a nonexistent lease", async () => {
  const state = emptyState();
  state.activeTask = {
    kind: "legacy-abandoned-prepare", originalKind: "component-prepare",
    taskId: "round3-prepare", componentId: "chatgpt", version: "2.0.0",
  };
  const { adapters, getState } = fixture({ state });
  assert.equal((await adapters.chatgpt.inspectInstalled({})).status, "skipped");
  assert.equal(getState().activeTask, null);
  assert.equal(getState().lastTask.action, "legacy-prepare-abandoned");
});

test("a migrated round3 Git install reconciles fresh discovery without rerunning its installer", async () => {
  const state = emptyState(INSTALL_ROOT);
  state.components.git = {
    managed: true, installPath: "D:\\CBApps\\Git", version: "2.50.0",
    executablePath: "D:\\CBApps\\Git\\cmd\\git.exe", uninstallerPath: "D:\\CBApps\\Git\\unins000.exe",
    currentInstaller: { path: "D:\\CBApps\\downloads\\git-2.50.0.exe", sha256: DIGEST_B, version: "2.50.0" },
    previousInstaller: null,
  };
  state.activeTask = {
    kind: "legacy-git-install-recovery", taskId: "round3-git", version: "2.51.0",
    targetDir: state.components.git.installPath, executablePath: state.components.git.executablePath,
    installerPath: "D:\\CBApps\\downloads\\git-2.51.0.exe", installerSha256: DIGEST_A,
    replacedInstaller: null,
  };
  const installed = {
    ...externalGit, version: "2.51.0", installDir: state.components.git.installPath,
    executablePath: state.components.git.executablePath, uninstallerPath: state.components.git.uninstallerPath,
  };
  const { adapters, calls, getState } = fixture({ state, gitDiscovery: installed });
  const inspected = await adapters.git.inspectInstalled({});
  assert.equal(inspected.status, "succeeded", inspected.message);
  assert.equal(getState().components.git.version, "2.51.0");
  assert.equal(getState().activeTask, null);
  assert.equal(calls.gitInstalls.length, 0);
});
