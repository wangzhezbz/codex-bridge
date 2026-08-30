import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import path from "node:path";
import test from "node:test";

import { createComponentAdapters } from "../desktop/software-manager/component-adapters.mjs";
import { createTrustedCatalogService, verifyCatalogEnvelope } from "../desktop/software-manager/catalog-trust.mjs";
import { getOwnershipCoordinator } from "../desktop/software-manager/ownership-coordinator.mjs";
import { createWindowsHost } from "../desktop/software-manager/windows-host.mjs";
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
const SECOND_INSTALL_ROOT = "E:\\CBApps";
const SECOND_INSTALL_CAPABILITY = await authorizeInstallRoot({
  candidate: SECOND_INSTALL_ROOT,
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

test("component inspection exposes only the owned install path and exact rollback target version", async () => {
  const state = emptyState(INSTALL_ROOT);
  state.components.chatgpt = {
    managed: true,
    installPath: "D:\\CBApps\\c",
    version: "2.0.0",
    entrypointPath: "D:\\CBApps\\c\\ChatGPT.exe",
    requiredFiles: ["D:\\CBApps\\c\\ChatGPT.exe"],
    health: "healthy",
  };
  state.rollback = [{ componentId: "chatgpt", path: "D:\\CBApps\\cp", version: "1.0.0" }];
  const { adapters } = fixture({ state });
  const inspected = await adapters.chatgpt.inspectInstalled({});
  assert.equal(inspected.status, "succeeded");
  assert.deepEqual(inspected.details, {
    installPath: "D:\\CBApps\\c",
    previousVersion: "1.0.0",
  });
});

function fixture({
  state = emptyState(), gitDiscovery = { kind: "none" }, gitDiscoveries = null, running = false,
  slotFailure = null, rollbackFailure = null, finalVerifyFailure = null, shortcutFailure = null, restartFailure = null,
  stateSaveFailureAt = null, persistentFailureAt = null, skillHashes = null, gitInstallFailure = null,
  invalidAuthenticodePath = null, initialSkillEvidence = null,
  catalogService = TRUSTED_CATALOG, installRootCapability = INSTALL_CAPABILITY,
  skillsRootCapability = SKILLS_CAPABILITY, desktopCapability = DESKTOP_CAPABILITY,
  onDownload = null, onExtract = null,
  onReplaceSkill = null, onGitInstall = null, onVerifyComponent = null,
  onDiscardPreparedSkill = null,
  onAuthenticode = null, onGitPin = null, gitExecutionTimeoutMs = undefined,
  onGitUninstall = null,
  availableDiskBytes = Number.MAX_SAFE_INTEGER,
  packageCleanupFailure = null, packageReleaseFailure = null,
  preparedSkillReconcileOverride = null,
  windowsHostOverride = null,
  initialPreparedSkillSources = [], recoverReservedSkillFromPreparedSource = false,
} = {}) {
  let currentState = structuredClone(state);
  let saveCount = 0;
  const calls = {
    downloads: [], extracts: [], promotions: [], rollbacks: [], stopped: [], launched: [], shortcuts: [],
    removedShortcuts: [], inspectedShortcuts: [], verified: [], gitInstalls: [], gitUninstalls: [], replacedSkills: [], deletedSkills: [],
    deletedComponents: [], hashes: [], persistentPrepared: [], persistentVerified: [], gitPins: [], gitRevalidates: [],
    gitReleases: [], retained: [], discarded: [],
    gitMutableReleases: [],
    reconciledSkills: [], skillOperations: [],
    cleanedSkillPackages: [], releasedComponentPackages: [], cleanedSkillStaging: [],
    begunSkillSources: [], boundSkillSources: [], discardedSkillSources: [],
    skillRecoveryOrder: [], discardLeaseBusy: [],
    discardedPreparedVersions: [],
  };
  const archiveReceipts = new WeakSet();
  const packageProofs = new WeakMap();
  const downloadRecords = new Map();
  const downloadedFiles = new Set();
  const skillReceipts = new WeakSet();
  const skillCompletionReceipts = new WeakSet();
  const skillProofs = new Map();
  const installedSkillEvidence = new Map();
  if (initialSkillEvidence && typeof initialSkillEvidence === "object") {
    installedSkillEvidence.set(initialSkillEvidence.target, structuredClone(initialSkillEvidence.evidence));
  }
  const gitPins = new WeakSet();
  const shortcutReservations = new Map();
  const shortcutPlans = new WeakMap();
  let shortcutSequence = 0;
  const deletedSkillTargets = new Set();
  const operationLeases = new Map();
  const preparedSkillSources = new Map();
  for (const record of initialPreparedSkillSources) {
    preparedSkillSources.set(`${record.taskId}:${record.skillId}`, structuredClone(record));
  }
  const ownershipStore = {
    async acquireOperationLease({ nonce, scope, wait = true }) {
      const key = `${scope}:${nonce}`;
      if (operationLeases.has(key)) return wait ? Promise.reject(new Error("test_operation_lease_busy")) : null;
      operationLeases.set(key, true);
      let released = false;
      return {
        nonce, scope,
        async release() {
          if (released) throw new Error(`test_operation_lease_already_released:${key}`);
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
  const fakeWindowsHost = {
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
    async planShortcut(record) {
      const shortcut = {
        ...record,
        creationId: (++shortcutSequence).toString(16).padStart(32, "0"),
        path: path.win32.join(record.desktopPath, `${record.name}（1）.lnk`),
      };
      const plan = Object.freeze(Object.create(null));
      shortcutPlans.set(plan, structuredClone(shortcut));
      return { plan, shortcut };
    },
    async createShortcut(plan) {
      const record = shortcutPlans.get(plan);
      if (!record) throw new Error("shortcut_plan_invalid");
      shortcutPlans.delete(plan);
      calls.shortcuts.push(record);
      if (shortcutFailure) throw shortcutFailure;
      shortcutReservations.set(record.path, structuredClone(record));
      return structuredClone(record);
    },
    async inspectRecordedShortcut(record) {
      calls.inspectedShortcuts.push(structuredClone(record));
      const shortcut = shortcutReservations.get(record.path);
      return shortcut ? { kind: "shortcut", shortcut: structuredClone(shortcut) } : { kind: "absent" };
    },
    async removeRecordedShortcut(record) {
      calls.removedShortcuts.push(record);
      shortcutReservations.delete(record.path);
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
  const windowsHost = windowsHostOverride ?? fakeWindowsHost;
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
    async bindPreparedVersion(plan) {
      return testOwnershipCoordinator.runExclusive(async (store) => {
        const next = await store.load();
        assert.equal(next.activeTask.taskId, plan.taskId);
        next.activeTask = {
          ...next.activeTask,
          stagingIdentity: { volumeSerial: "test", fileId: `${plan.componentId}-${plan.taskId}` },
        };
        const saved = await store.save(next);
        return structuredClone(saved.activeTask);
      });
    },
    async discardPreparedVersion(plan) {
      calls.discardedPreparedVersions.push(structuredClone(plan));
      return true;
    },
    async promotePreparedVersion(plan) {
      calls.promotions.push(plan);
      if (slotFailure) throw slotFailure;
      assert.equal(archiveReceipts.has(plan.verificationReceipt), true);
      const rootPath = plan.componentId === "chatgpt" ? INSTALL_ROOT : path.win32.join(INSTALL_ROOT, "V2RayN");
      assert.equal(plan.rootPath, rootPath);
      const next = await testOwnershipCoordinator.store.load();
      assert.equal(next.activeTask.kind, "component-prepare");
      assert.equal(next.activeTask.taskId, plan.taskId);
      assert.equal(next.activeTask.componentId, plan.componentId);
      assert.equal(next.activeTask.version, plan.version);
      assert.equal(next.activeTask.leaseScope, "prepare");
      assert.equal(next.activeTask.leaseNonce, plan.prepareLeaseNonce);
      assert.deepEqual(next.activeTask.stagingIdentity, {
        volumeSerial: "test", fileId: `${plan.componentId}-${plan.taskId}`,
      });
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
      next.activeTask = null;
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
      if (plan.phase === "staging") {
        assert.equal(packageProofs.has(plan.packageProof), true);
        packageProofs.delete(plan.packageProof);
        assert.equal(plan.expectedPackageSha256, DIGEST_A);
      } else {
        assert.equal(plan.phase, "current");
        assert.equal(Object.hasOwn(plan, "packageProof"), false);
        assert.equal(Object.hasOwn(plan, "expectedPackageSha256"), false);
      }
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
    async beginPreparedSource(plan) {
      calls.begunSkillSources.push(structuredClone(plan));
      preparedSkillSources.set(`${plan.taskId}:${plan.skillId}`, { ...structuredClone(plan), phase: "intent" });
    },
    async bindPreparedSource(plan) {
      calls.boundSkillSources.push(structuredClone(plan));
      const key = `${plan.taskId}:${plan.skillId}`;
      const bound = {
        ...preparedSkillSources.get(key), phase: "bound",
        identity: { volumeSerial: "skill-volume", fileId: `skill-${plan.taskId}-${plan.skillId}` },
      };
      preparedSkillSources.set(key, bound);
      return structuredClone(bound);
    },
    async discardPrepared(plan) {
      calls.discardedSkillSources.push(structuredClone(plan));
      for (const skillId of plan.skillIds) {
        const record = preparedSkillSources.get(`${plan.taskId}:${skillId}`);
        if (!record) continue;
        const competingLease = await ownershipStore.acquireOperationLease({
          nonce: record.leaseNonce, scope: record.leaseScope, wait: false,
        });
        calls.discardLeaseBusy.push(competingLease === null);
        await competingLease?.release();
      }
      await onDiscardPreparedSkill?.(plan);
      return plan.skillIds.map((skillId) => preparedSkillSources.delete(`${plan.taskId}:${skillId}`));
    },
    async reconcilePreparedSources() {
      if (preparedSkillReconcileOverride) return preparedSkillReconcileOverride();
      calls.skillRecoveryOrder.push("prepare-reconcile");
      let recovered = 0;
      for (const [key, record] of preparedSkillSources) {
        const lease = await ownershipStore.acquireOperationLease({
          nonce: record.leaseNonce, scope: record.leaseScope, wait: false,
        });
        if (lease === null) continue;
        try {
          preparedSkillSources.delete(key);
          calls.discardedSkillSources.push({ taskId: record.taskId, skillIds: [record.skillId], recovery: true });
          recovered += 1;
        } finally {
          await lease.release();
        }
      }
      return {
        status: preparedSkillSources.size === 0 ? "complete" : "live",
        cleaned: Array.from({ length: recovered }), live: [], unresolved: [], failed: [],
      };
    },
    async verifyPreparedSkill(plan) {
      assert.equal(typeof plan.taskId, "string");
      assert.equal(plan.skillId, "documents");
      assert.equal(plan.expectedVersion, "1.0.0");
      assert.equal(plan.stagingReceipt?.path, path.win32.join(
        INSTALL_ROOT, "staging", `task-${plan.stagingReceipt.taskId}`, "skill-documents.prepare",
      ));
      const boundDownload = packageProofs.get(plan.packageProof);
      assert.equal(downloadRecords.has(boundDownload), true);
      packageProofs.delete(plan.packageProof);
      downloadedFiles.delete(downloadRecords.get(boundDownload));
      downloadRecords.delete(boundDownload);
      const verificationReceipt = Object.freeze(Object.create(null));
      skillReceipts.add(verificationReceipt);
      const key = `${plan.taskId}:${plan.skillId}`;
      preparedSkillSources.set(key, { ...preparedSkillSources.get(key), phase: "sealed" });
      return { verificationReceipt, treeDigest: DIGEST_A, manifestDigest: DIGEST_B, skillMdSha256: SKILL_HASH };
    },
    async hashFile(filePath) {
      calls.hashes.push(filePath);
      return Array.isArray(skillHashes) && skillHashes.length > 0 ? skillHashes.shift() : SKILL_HASH;
    },
    async replaceExact(plan) {
      assert.match(plan.swapId, /^[a-f0-9]{32}$/u);
      assert.equal(plan.taskId.length > 0, true);
      assert.equal(Object.hasOwn(plan, "previousEvidence"), true);
      await onReplaceSkill?.(plan);
      assert.equal(skillReceipts.has(plan.verificationReceipt), true);
      skillReceipts.delete(plan.verificationReceipt);
      calls.replacedSkills.push(plan);
      preparedSkillSources.delete(`${plan.taskId}:${path.win32.basename(plan.target)}`);
      const completionReceipt = Object.freeze(Object.create(null));
      skillCompletionReceipts.add(completionReceipt);
      installedSkillEvidence.set(plan.target, {
        kind: "directory", identity: { volumeSerial: "v", fileId: `skill-${calls.replacedSkills.length}` },
        treeDigest: plan.treeDigest, manifestDigest: plan.manifestDigest,
        skillMdSha256: plan.skillMdSha256,
      });
      return { completionReceipt };
    },
    async finalizeReplacement({ completionReceipt, target, taskId, swapId, expected }) {
      assert.equal(typeof taskId, "string");
      assert.match(swapId, /^[a-f0-9]{32}$/u);
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
    async verifyCompletionProof({ completionProof, target, swapId }) {
      assert.match(swapId, /^[a-f0-9]{32}$/u);
      const evidence = skillProofs.get(completionProof);
      if (!evidence || !installedSkillEvidence.has(target)) throw new Error("skill_completion_proof_invalid");
      return structuredClone(evidence);
    },
    async recoverCompletionProof({ target, swapId, expected }) {
      assert.match(swapId, /^[a-f0-9]{32}$/u);
      const evidence = installedSkillEvidence.get(target);
      if (!evidence || evidence.treeDigest !== expected.treeDigest
        || evidence.manifestDigest !== expected.manifestDigest
        || evidence.skillMdSha256 !== expected.skillMdSha256) throw new Error("skill_completion_recovery_mismatch");
      const proof = `skill-proof-${skillProofs.size + 1}`;
      skillProofs.set(proof, structuredClone(evidence));
      return { completionProof: proof, evidence: structuredClone(evidence) };
    },
    async deleteExact(plan) {
      assert.equal(Object.hasOwn(plan, "expectedEvidence"), true);
      calls.deletedSkills.push(plan); deletedSkillTargets.add(plan.target); installedSkillEvidence.delete(plan.target);
    },
    async inspectExact({ target }) {
      calls.skillOperations.push(["inspect", target]);
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
    async reconcileReplacement(plan) {
      calls.skillRecoveryOrder.push("swap-reconcile");
      calls.reconciledSkills.push(structuredClone(plan));
      calls.skillOperations.push(["reconcile", plan.target]);
      if (recoverReservedSkillFromPreparedSource) {
        const key = `${plan.taskId}:${path.win32.basename(plan.target)}`;
        const source = preparedSkillSources.get(key);
        if (!source || source.phase !== "sealed") throw new Error("skill_recovery_source_missing");
        installedSkillEvidence.set(plan.target, {
          kind: "directory", identity: { volumeSerial: "v", fileId: "recovered-from-source" },
          treeDigest: plan.expected.treeDigest,
          manifestDigest: plan.expected.manifestDigest,
          skillMdSha256: plan.expected.skillMdSha256,
        });
        preparedSkillSources.delete(key);
        calls.discardedSkillSources.push({
          taskId: plan.taskId, skillIds: [path.win32.basename(plan.target)], recovery: "swap-prepared",
        });
      }
      return { status: "completed" };
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
      if ([...downloadRecords.values()].includes(plan.destination)) {
        throw new Error("test_workspace_download_still_pending");
      }
      const packageProof = Object.freeze(Object.create(null));
      const downloadRecord = Object.freeze(Object.create(null));
      packageProofs.set(packageProof, downloadRecord);
      downloadRecords.set(downloadRecord, plan.destination);
      downloadedFiles.add(plan.destination);
      return {
        path: plan.destination, size: plan.asset.size, sha256: plan.asset.sha256,
        packageProof, downloadRecord,
      };
    },
  };
  const installerWorkspace = {
    async prepareSkillStaging({ taskId, skillId }) {
      return Object.freeze({
        kind: "skill-staging",
        taskId,
        skillId,
        path: path.win32.join(INSTALL_ROOT, "staging", `task-${taskId}`, `skill-${skillId}.prepare`),
      });
    },
    async cleanupAbandonedPrepare(record) { calls.cleanedSkillStaging.push(record); },
    async cleanupComponentPackage(record) {
      assert.equal(downloadRecords.has(record), true);
      downloadedFiles.delete(downloadRecords.get(record));
      downloadRecords.delete(record);
      calls.cleanedSkillPackages.push(record);
      if (packageCleanupFailure) throw packageCleanupFailure;
    },
    async releaseComponentPackage(record) {
      assert.equal(downloadRecords.has(record), true);
      downloadRecords.delete(record);
      calls.releasedComponentPackages.push(record);
      if (typeof packageReleaseFailure === "function") await packageReleaseFailure();
      else if (packageReleaseFailure) throw packageReleaseFailure;
    },
  };
  const adapterOptions = {
    catalogService,
    installRootCapability,
    skillsRootCapability,
    desktopCapability,
    downloader, archiveService, versionSlots, ownershipStore, windowsHost, componentFiles, skillFiles,
    installerWorkspace,
    gitIdentityCapabilities,
    getAvailableDiskBytes: async () => availableDiskBytes,
    ...(gitExecutionTimeoutMs === undefined ? {} : { gitExecutionTimeoutMs }),
    resolveSkillTarget: async ({ skillsRoot, skillId }) => path.win32.join(skillsRoot, skillId),
  };
  const adapters = createComponentAdapters(adapterOptions);
  return {
    adapters, calls, getState: () => structuredClone(currentState),
    createAnotherAdapters: () => createComponentAdapters(adapterOptions),
    createAnotherProcessAdapters: () => createComponentAdapters({
      ...adapterOptions,
      ownershipStore: {
        acquireOperationLease: ownershipStore.acquireOperationLease.bind(ownershipStore),
        load: ownershipStore.load.bind(ownershipStore),
        compareAndSwap: ownershipStore.compareAndSwap.bind(ownershipStore),
      },
    }),
    createAdaptersForInstallRoot: (nextInstallRootCapability) => createComponentAdapters({
      ...adapterOptions, installRootCapability: nextInstallRootCapability,
      ownershipStore: {
        acquireOperationLease: ownershipStore.acquireOperationLease.bind(ownershipStore),
        load: ownershipStore.load.bind(ownershipStore),
        compareAndSwap: ownershipStore.compareAndSwap.bind(ownershipStore),
      },
    }),
    reconcilePreparedSkillSources: () => skillFiles.reconcilePreparedSources(),
    preparedSkillSourceCount: () => preparedSkillSources.size,
    simulateProcessCrash: () => {
      operationLeases.clear();
      downloadRecords.clear();
    },
  };
}

const externalGit = Object.freeze({
  kind: "external", ownership: "external", version: "2.50.0", installDir: "C:\\Git",
  executablePath: "C:\\Git\\cmd\\git.exe", uninstallerPath: "C:\\Git\\unins000.exe",
  registryKey: "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Git_is1",
});

function realShortcutHostFixture() {
  const shortcuts = new Map();
  const held = new Map();
  const tempCapabilities = new WeakSet();
  const sealedCapabilities = new WeakSet();
  let sequence = 0;
  const calls = { writes: [], removes: [] };
  const electronShell = {
    writeShortcutLink(shortcutPath, operation, options) {
      calls.writes.push({ shortcutPath, operation, options: structuredClone(options) });
      shortcuts.set(shortcutPath, { target: options.target, description: options.description });
      return true;
    },
    readShortcutLink(shortcutPath) {
      const shortcut = shortcuts.get(shortcutPath);
      if (!shortcut) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return structuredClone(shortcut);
    },
  };
  const shortcutFileApi = {
    async createTemp({ directory, suffix }) {
      const capability = Object.freeze({ path: path.win32.join(directory, `.cb-shortcut-${++sequence}${suffix}`) });
      tempCapabilities.add(capability);
      return capability;
    },
    async sealTemp(capability) {
      if (!tempCapabilities.has(capability) || !shortcuts.has(capability.path)) throw new Error("invalid_temp");
      const sealed = Object.freeze({ path: capability.path });
      sealedCapabilities.add(sealed);
      held.set(sealed.path, sealed);
      return sealed;
    },
    async commitNoReplace(capability, destinationPath) {
      if (!sealedCapabilities.has(capability) || held.get(capability.path) !== capability) throw new Error("invalid_seal");
      if (shortcuts.has(destinationPath)) return "occupied";
      shortcuts.set(destinationPath, shortcuts.get(capability.path));
      shortcuts.delete(capability.path);
      held.delete(capability.path);
      return "committed";
    },
    async removeTemp(capability) {
      shortcuts.delete(capability.path);
      held.delete(capability.path);
    },
    async inspectExact(shortcutPath) {
      if (!shortcuts.has(shortcutPath)) return { kind: "absent" };
      const descriptor = Object.freeze({ kind: "file", path: shortcutPath });
      held.set(shortcutPath, descriptor);
      return descriptor;
    },
    async removeExact(descriptor) {
      if (held.get(descriptor.path) !== descriptor || !shortcuts.has(descriptor.path)) return false;
      calls.removes.push(descriptor.path);
      shortcuts.delete(descriptor.path);
      held.delete(descriptor.path);
      return true;
    },
    async release(descriptor) {
      if (held.get(descriptor.path) === descriptor) held.delete(descriptor.path);
    },
  };
  const host = createWindowsHost({
    platform: "win32",
    getSystemDirectory: () => "C:\\Windows\\System32",
    env: {},
    electronShell,
    shortcutFileApi,
    registryReader: async () => null,
    processLister: async () => [],
    spawnDetached: async () => ({ pid: 1, started: Promise.resolve(), unref() {} }),
    suspendedProcess: { async run() { return { pid: 1, exitCode: 0 }; } },
    execFile: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  });
  return { host, shortcuts, calls };
}

test("real Windows host and component adapters adopt exact ChatGPT and V2RayN shortcuts", async (t) => {
  for (const [componentId, expectedName, expectedTarget] of [
    ["chatgpt", "ChatGPT", "D:\\CBApps\\c\\ChatGPT.exe"],
    ["v2rayn", "V2RayN", "D:\\CBApps\\V2RayN\\current\\v2rayN.exe"],
  ]) {
    await t.test(componentId, async () => {
      const realHost = realShortcutHostFixture();
      const { adapters, getState } = fixture({ windowsHostOverride: realHost.host });
      assert.equal((await adapters[componentId].prepare({ taskId: `real-${componentId}` })).status, "succeeded");
      const committed = await adapters[componentId].commit({ taskId: `real-${componentId}` });
      assert.equal(committed.status, "succeeded", committed.message);
      assert.equal(committed.message, "component_committed");
      assert.equal(getState().activeTask, null);
      assert.equal(getState().shortcuts.length, 1);
      assert.equal(getState().shortcuts[0].componentId, componentId);
      assert.equal(getState().shortcuts[0].name, expectedName);
      assert.equal(getState().shortcuts[0].targetPath, expectedTarget);
      assert.deepEqual(realHost.shortcuts.get(getState().shortcuts[0].path), {
        target: expectedTarget,
        description: `CodexBridge:${expectedName}:${getState().shortcuts[0].creationId}`,
      });
    });
  }
});

test("real Windows host recovery adopts one created shortcut after applied-state persistence fails", async () => {
  const realHost = realShortcutHostFixture();
  const { adapters, getState } = fixture({ windowsHostOverride: realHost.host, stateSaveFailureAt: 6 });
  assert.equal((await adapters.chatgpt.prepare({ taskId: "real-shortcut-recovery" })).status, "succeeded");
  const committed = await adapters.chatgpt.commit({ taskId: "real-shortcut-recovery" });
  assert.equal(committed.status, "succeeded");
  assert.match(committed.message, /shortcut_state/u);
  assert.equal(getState().activeTask.phase, "reserved");
  assert.equal(realHost.calls.writes.length, 1);

  assert.equal((await adapters.chatgpt.inspectInstalled({})).status, "succeeded");
  assert.equal(realHost.calls.writes.length, 1);
  assert.equal(getState().activeTask, null);
  assert.equal(getState().shortcuts.length, 1);
  const recordedPath = getState().shortcuts[0].path;

  assert.equal((await adapters.chatgpt.uninstall({ taskId: "real-shortcut-remove" })).status, "succeeded");
  assert.deepEqual(realHost.calls.removes, [recordedPath]);
  assert.equal(realHost.shortcuts.size, 0);
});

test("reserved shortcut collision recovery clears the WAL without adopting or deleting the occupied link", async () => {
  const realHost = realShortcutHostFixture();
  let plannedShortcut = null;
  let raceOnce = true;
  const racingHost = {
    ...realHost.host,
    async planShortcut(request) {
      const planned = await realHost.host.planShortcut(request);
      plannedShortcut = planned.shortcut;
      return planned;
    },
    async createShortcut(plan) {
      if (raceOnce) {
        raceOnce = false;
        realHost.shortcuts.set(plannedShortcut.path, {
          target: "C:\\Other\\ChatGPT.exe",
          description: "user-owned shortcut",
        });
      }
      return realHost.host.createShortcut(plan);
    },
  };
  const { adapters, getState } = fixture({ windowsHostOverride: racingHost });
  assert.equal((await adapters.chatgpt.prepare({ taskId: "shortcut-collision-race" })).status, "succeeded");
  const committed = await adapters.chatgpt.commit({ taskId: "shortcut-collision-race" });
  assert.equal(committed.status, "succeeded");
  assert.match(committed.message, /shortcut_plan_occupied/u);
  assert.equal(getState().activeTask.phase, "reserved");
  const occupiedPath = plannedShortcut.path;

  assert.equal((await adapters.chatgpt.inspectInstalled({})).status, "succeeded");
  assert.equal(getState().activeTask, null);
  assert.deepEqual(getState().shortcuts, []);
  assert.deepEqual(realHost.shortcuts.get(occupiedPath), {
    target: "C:\\Other\\ChatGPT.exe",
    description: "user-owned shortcut",
  });

  assert.equal((await adapters.chatgpt.prepare({ taskId: "after-shortcut-collision-update" })).status, "succeeded");
  assert.equal((await adapters.chatgpt.commit({ taskId: "after-shortcut-collision-update" })).status, "succeeded");
  assert.equal(getState().shortcuts.length, 1);
  const ownedPath = getState().shortcuts[0].path;
  assert.notEqual(ownedPath, occupiedPath);
  assert.equal((await adapters.chatgpt.uninstall({ taskId: "after-shortcut-collision" })).status, "succeeded");
  assert.equal(realHost.shortcuts.has(occupiedPath), true);
  assert.equal(realHost.shortcuts.has(ownedPath), false);
  assert.deepEqual(realHost.calls.removes, [ownedPath]);
});

test("reserved shortcut host failure recovers as absent and does not block later operations", async () => {
  const { adapters, getState } = fixture({ shortcutFailure: new Error("host failed") });
  assert.equal((await adapters.v2rayn.prepare({ taskId: "shortcut-host-failure" })).status, "succeeded");
  const committed = await adapters.v2rayn.commit({ taskId: "shortcut-host-failure" });
  assert.equal(committed.status, "succeeded");
  assert.equal(getState().activeTask.phase, "reserved");

  assert.equal((await adapters.v2rayn.inspectInstalled({})).status, "succeeded");
  assert.equal(getState().activeTask, null);
  assert.deepEqual(getState().shortcuts, []);
  assert.equal((await adapters.v2rayn.uninstall({ taskId: "after-shortcut-host-failure" })).status, "succeeded");
});

test("applied shortcut marker mismatch remains pending and never adopts or deletes the occupied link", async () => {
  const targetPath = "D:\\CBApps\\c\\ChatGPT.exe";
  const shortcutPath = `${DESKTOP}\\ChatGPT.lnk`;
  const state = emptyState(INSTALL_ROOT);
  state.components.chatgpt = {
    managed: true, installPath: "D:\\CBApps\\c", version: "2.0.0",
    entrypointPath: targetPath, requiredFiles: [targetPath], health: "healthy",
  };
  state.activeTask = {
    kind: "component-shortcut", phase: "applied", taskId: "applied-mismatch", componentId: "chatgpt",
    desktopPath: DESKTOP, targetPath,
    shortcut: {
      name: "ChatGPT", path: shortcutPath, desktopPath: DESKTOP,
      targetPath, creationId: "e".repeat(32),
    },
  };
  const realHost = realShortcutHostFixture();
  realHost.shortcuts.set(shortcutPath, { target: targetPath, description: "user-owned shortcut" });
  const { adapters, getState } = fixture({ state, windowsHostOverride: realHost.host });

  assert.equal((await adapters.chatgpt.inspectInstalled({})).status, "failed");
  assert.equal(getState().activeTask.phase, "applied");
  assert.equal(realHost.shortcuts.has(shortcutPath), true);
  assert.deepEqual(realHost.calls.removes, []);
});

test("component adapter rejects malformed shortcut plan evidence before reserving or creating", async () => {
  const realHost = realShortcutHostFixture();
  const malformedHost = {
    ...realHost.host,
    async planShortcut(request) {
      const planned = await realHost.host.planShortcut(request);
      return { ...planned, shortcut: { ...planned.shortcut, rendererValue: "not-authority" } };
    },
  };
  const { adapters, getState } = fixture({ windowsHostOverride: malformedHost });
  assert.equal((await adapters.chatgpt.prepare({ taskId: "malformed-shortcut-plan" })).status, "succeeded");
  const committed = await adapters.chatgpt.commit({ taskId: "malformed-shortcut-plan" });

  assert.equal(committed.status, "succeeded");
  assert.match(committed.message, /shortcut_plan_invalid/u);
  assert.equal(getState().activeTask, null);
  assert.deepEqual(getState().shortcuts, []);
  assert.equal(realHost.calls.writes.length, 0);
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

test("disk space preflight blocks components and Skills before any download", async () => {
  const componentFixture = fixture({ availableDiskBytes: 0 });
  const componentResult = await componentFixture.adapters.chatgpt.prepare({ taskId: "disk-low-component" });
  assert.equal(componentResult.status, "failed");
  assert.match(componentResult.message, /component_disk_space_insufficient/u);
  assert.deepEqual(componentFixture.calls.downloads, []);

  const skillFixture = fixture({ availableDiskBytes: 0 });
  const [skillResult] = await skillFixture.adapters.skills.prepare({
    taskId: "disk-low-skill",
    skillIds: ["documents"],
  });
  assert.equal(skillResult.componentId, "documents");
  assert.equal(skillResult.status, "failed");
  assert.match(skillResult.message, /component_disk_space_insufficient/u);
  assert.deepEqual(skillFixture.calls.downloads, []);
});

test("ChatGPT prepares in a task-unique directory and still commits to fixed c/cp slots", async () => {
  const { adapters, calls, getState } = fixture();
  assert.equal((await adapters.chatgpt.prepare({ taskId: "chat" })).status, "succeeded");
  const stagingRoot = calls.extracts[0].destination;
  assert.match(stagingRoot, /^D:\\CBApps\\\.p-[a-f0-9]{32}$/u);
  assert.deepEqual(calls.extracts[0].destinationIdentity, getState().activeTask.stagingIdentity);
  assert.deepEqual(calls.verified[0], {
    kind: "component",
    componentId: "chatgpt",
    phase: "staging",
    stagingName: getState().activeTask.stagingName,
    rootPath: stagingRoot,
    entrypointPath: `${stagingRoot}\\ChatGPT.exe`,
    requiredFiles: [`${stagingRoot}\\ChatGPT.exe`],
    expectedVersion: "2.0.0",
    expectedPackageSha256: DIGEST_A,
    packageProof: calls.verified[0].packageProof,
  });
  const committed = await adapters.chatgpt.commit({ taskId: "chat" });
  assert.equal(committed.status, "succeeded", committed.message);
  assert.equal(calls.promotions[0].rootPath, INSTALL_ROOT);
  assert.deepEqual(calls.verified[1], {
    kind: "component",
    componentId: "chatgpt",
    phase: "current",
    rootPath: "D:\\CBApps\\c",
    entrypointPath: "D:\\CBApps\\c\\ChatGPT.exe",
    requiredFiles: ["D:\\CBApps\\c\\ChatGPT.exe"],
    expectedVersion: "2.0.0",
  });
  assert.equal(getState().components.chatgpt.installPath, "D:\\CBApps\\c");
});

test("ChatGPT rollback verifies the restored entrypoint, files, and version before reporting success", async () => {
  const state = emptyState(INSTALL_ROOT);
  state.components.chatgpt = {
    managed: true,
    installPath: "D:\\CBApps\\c",
    version: "1.0.0",
    entrypointPath: "D:\\CBApps\\c\\ChatGPT.exe",
    requiredFiles: ["D:\\CBApps\\c\\ChatGPT.exe"],
    health: "healthy",
  };
  const current = fixture({ state });
  assert.equal((await current.adapters.chatgpt.prepare({ taskId: "rollback-verify" })).status, "succeeded");
  assert.equal((await current.adapters.chatgpt.commit({ taskId: "rollback-verify" })).status, "succeeded");
  const rolledBack = await current.adapters.chatgpt.rollback({});
  assert.equal(rolledBack.status, "succeeded");
  assert.deepEqual(current.calls.verified.at(-1), {
    kind: "component",
    componentId: "chatgpt",
    phase: "current",
    rootPath: "D:\\CBApps\\c",
    entrypointPath: "D:\\CBApps\\c\\ChatGPT.exe",
    requiredFiles: ["D:\\CBApps\\c\\ChatGPT.exe"],
    expectedVersion: "1.0.0",
  });
});

test("archive prepare closes and deletes each exact package on success or verification failure", async () => {
  const successful = fixture();
  assert.equal((await successful.adapters.chatgpt.prepare({ taskId: "archive-clean-1" })).status, "succeeded");
  assert.equal(successful.calls.cleanedSkillPackages.length, 1);
  const another = fixture();
  assert.equal((await another.adapters.chatgpt.prepare({ taskId: "archive-clean-2" })).status, "succeeded");
  assert.equal(another.calls.cleanedSkillPackages.length, 1);

  const failed = fixture({
    onVerifyComponent: async () => {
      throw Object.assign(new Error("test_archive_verify_failed"), { code: "test_archive_verify_failed" });
    },
  });
  const result = await failed.adapters.v2rayn.prepare({ taskId: "archive-clean-failed" });
  assert.equal(result.status, "failed");
  assert.match(result.message, /test_archive_verify_failed/u);
  assert.equal(failed.calls.cleanedSkillPackages.length, 1);
});

test("a live archive prepare cannot be discarded by another process and its owner still commits", async () => {
  const harness = fixture();
  const owner = harness.adapters;
  const contender = harness.createAnotherProcessAdapters();
  assert.equal((await owner.chatgpt.prepare({ taskId: "archive-live-owner" })).status, "succeeded");
  assert.equal(harness.getState().activeTask.taskId, "archive-live-owner");

  const blocked = await contender.chatgpt.prepare({ taskId: "archive-live-contender" });
  assert.equal(blocked.status, "failed");
  assert.match(blocked.message, /component_pending_transaction|component_install_root_not_owned/u);
  assert.equal(harness.calls.discardedPreparedVersions.length, 0);

  const committed = await owner.chatgpt.commit({ taskId: "archive-live-owner" });
  assert.equal(committed.status, "succeeded", committed.message);
  assert.equal(harness.getState().components.chatgpt.version, "2.0.0");
});

test("a Skills-only ownership state can inspect and safely rebind a newly selected install root", async () => {
  const state = emptyState(INSTALL_ROOT);
  state.skills.documents = {
    target: `${SKILLS_ROOT}\\documents`, version: "1.0.0", packageSha256: DIGEST_A,
    skillMdSha256: OLD_SKILL_HASH, identity: { volumeSerial: "skills", fileId: "documents" },
    treeDigest: DIGEST_A, manifestDigest: DIGEST_B,
  };
  const harness = fixture({ state });
  const selectedRoot = harness.createAdaptersForInstallRoot(SECOND_INSTALL_CAPABILITY);

  const inspected = await selectedRoot.chatgpt.inspectInstalled({});
  assert.equal(inspected.status, "skipped", inspected.message);
  assert.equal(harness.getState().installRoot, INSTALL_ROOT);

  const prepared = await selectedRoot.chatgpt.prepare({ taskId: "rebind-after-skills" });
  assert.equal(prepared.status, "succeeded", prepared.message);
  assert.equal(harness.getState().installRoot, SECOND_INSTALL_ROOT);
  assert.equal(harness.getState().skills.documents.version, "1.0.0");
});

test("a selected root cannot replace the ownership root of an installed managed component", async () => {
  const state = emptyState(INSTALL_ROOT);
  state.components.chatgpt = {
    managed: true, installPath: `${INSTALL_ROOT}\\c`, version: "2.0.0",
    entrypointPath: `${INSTALL_ROOT}\\c\\ChatGPT.exe`,
    requiredFiles: [`${INSTALL_ROOT}\\c\\ChatGPT.exe`], health: "healthy",
  };
  const harness = fixture({ state });
  const selectedRoot = harness.createAdaptersForInstallRoot(SECOND_INSTALL_CAPABILITY);

  const inspected = await selectedRoot.chatgpt.inspectInstalled({});
  assert.equal(inspected.status, "failed");
  assert.match(inspected.message, /component_install_root_not_owned/u);
  assert.equal(harness.getState().installRoot, INSTALL_ROOT);
});

test("a dead archive prepare is discarded under its old claim before a new prepare retries", async () => {
  const harness = fixture();
  assert.equal((await harness.adapters.v2rayn.prepare({ taskId: "archive-dead-owner" })).status, "succeeded");
  const abandoned = structuredClone(harness.getState().activeTask);
  harness.simulateProcessCrash();

  const restarted = harness.createAnotherProcessAdapters();
  const retried = await restarted.v2rayn.prepare({ taskId: "archive-after-crash" });
  assert.equal(retried.status, "succeeded", retried.message);
  assert.deepEqual(harness.calls.discardedPreparedVersions, [{
    componentId: "v2rayn", taskId: abandoned.taskId, leaseNonce: abandoned.leaseNonce,
  }]);
  assert.equal(harness.getState().activeTask.taskId, "archive-after-crash");
});

test("archive extraction failure discards only its bound staging before the next prepare", async () => {
  let extractFailures = 1;
  const harness = fixture({
    onExtract: async () => {
      if (extractFailures > 0) { extractFailures -= 1; throw new Error("partial_archive_write_failed"); }
    },
  });
  const failed = await harness.adapters.chatgpt.prepare({ taskId: "archive-partial" });
  assert.equal(failed.status, "failed");
  assert.match(failed.message, /partial_archive_write_failed/u);
  assert.equal(harness.calls.discardedPreparedVersions.length, 1);
  assert.equal(harness.getState().activeTask, null);

  const retried = await harness.createAnotherProcessAdapters().chatgpt.prepare({ taskId: "archive-partial-retry" });
  assert.equal(retried.status, "succeeded", retried.message);
});

test("Git prepare hands the installer from workspace authority to its independent pin and releases failures", async () => {
  const successful = fixture({ gitDiscovery: { kind: "none" } });
  assert.equal((await successful.adapters.git.prepare({ taskId: "git-handoff-1", selected: true })).status, "succeeded");
  assert.equal(successful.calls.releasedComponentPackages.length, 1);
  assert.equal(successful.calls.cleanedSkillPackages.length, 0);
  const another = fixture({ gitDiscovery: { kind: "none" } });
  assert.equal((await another.adapters.git.prepare({ taskId: "git-handoff-2", selected: true })).status, "succeeded");
  assert.equal(another.calls.releasedComponentPackages.length, 1);
  assert.equal(another.calls.downloads.length, 1);
  assert.equal(another.calls.gitPins[0].installerPath, "D:\\CBApps\\downloads\\git-2.51.0.exe");
  assert.equal(another.calls.gitPins[0].installerSha256, DIGEST_A);

  const failed = fixture({
    gitDiscovery: { kind: "none" },
    onGitPin: async () => {
      throw Object.assign(new Error("test_git_pin_failed"), { code: "test_git_pin_failed" });
    },
  });
  const result = await failed.adapters.git.prepare({ taskId: "git-handoff-failed", selected: true });
  assert.equal(result.status, "failed");
  assert.match(result.message, /test_git_pin_failed/u);
  assert.equal(failed.calls.cleanedSkillPackages.length, 1);
  assert.equal(failed.calls.releasedComponentPackages.length, 0);
});

test("Git close-only failure keeps root ownership and a rebuilt adapter safely adopts the same verified installer", async () => {
  let releaseFailures = 1;
  const harness = fixture({
    gitDiscovery: { kind: "none" },
    packageReleaseFailure: async () => {
      if (releaseFailures > 0) {
        releaseFailures -= 1;
        throw Object.assign(new Error("test_workspace_close_failed"), { code: "test_workspace_close_failed" });
      }
    },
  });
  const first = await harness.adapters.git.prepare({ taskId: "git-close-failed", selected: true });
  assert.equal(first.status, "failed");
  assert.match(first.message, /test_workspace_close_failed/u);
  assert.equal(harness.getState().installRoot, INSTALL_ROOT);
  assert.equal(harness.getState().activeTask.taskId, "git-close-failed");

  const restarted = harness.createAnotherAdapters();
  const retried = await restarted.git.prepare({ taskId: "git-close-retry", selected: true });
  assert.equal(retried.status, "succeeded", retried.message);
  assert.equal(harness.calls.downloads.length, 2);
  assert.equal(harness.calls.gitPins.length, 2);
  assert.equal(harness.getState().activeTask.taskId, "git-close-retry");
  assert.equal(harness.getState().installRoot, INSTALL_ROOT);
});

test("a failed Git commit can safely reprepare the retained same-version installer", async () => {
  const harness = fixture({
    gitDiscovery: { kind: "none" },
    gitInstallFailure: Object.assign(new Error("test_git_commit_failed"), { code: "test_git_commit_failed" }),
  });
  assert.equal((await harness.adapters.git.prepare({ taskId: "git-commit-first", selected: true })).status, "succeeded");
  assert.equal((await harness.adapters.git.commit({ taskId: "git-commit-first" })).status, "failed");
  const retried = await harness.createAnotherAdapters().git.prepare({
    taskId: "git-commit-retry", selected: true,
  });
  assert.equal(retried.status, "succeeded", retried.message);
  assert.equal(harness.calls.downloads.length, 2);
  assert.equal(harness.calls.gitPins.length >= 2, true);
});

test("a live Git prepare pins its exact root until the owner atomically starts and commits", async () => {
  const installed = {
    ...externalGit, version: "2.51.0", installDir: "D:\\CBApps\\Git",
    executablePath: "D:\\CBApps\\Git\\cmd\\git.exe", uninstallerPath: "D:\\CBApps\\Git\\unins000.exe",
  };
  const harness = fixture({
    gitDiscoveries: [{ kind: "none" }, { kind: "none" }, installed], gitDiscovery: installed,
  });
  assert.equal((await harness.adapters.git.prepare({ taskId: "git-root-a", selected: true })).status, "succeeded");
  const rootB = harness.createAdaptersForInstallRoot(SECOND_INSTALL_CAPABILITY);
  const blocked = await rootB.chatgpt.prepare({ taskId: "chat-root-b" });
  assert.equal(blocked.status, "failed");
  assert.match(blocked.message, /component_pending_transaction|component_install_root_not_owned/u);
  assert.equal(harness.getState().installRoot, INSTALL_ROOT);

  const committed = await harness.adapters.git.commit({ taskId: "git-root-a" });
  assert.equal(committed.status, "succeeded", committed.message);
  assert.equal(harness.getState().components.git.installPath, "D:\\CBApps\\Git");
});

test("a dead Git prepare releases its old root before another process prepares on a new root", async () => {
  const harness = fixture({ gitDiscovery: { kind: "none" } });
  assert.equal((await harness.adapters.git.prepare({ taskId: "git-dead-root-a", selected: true })).status, "succeeded");
  harness.simulateProcessCrash();

  const rootB = harness.createAdaptersForInstallRoot(SECOND_INSTALL_CAPABILITY);
  const retried = await rootB.git.prepare({ taskId: "git-root-b", selected: true });
  assert.equal(retried.status, "succeeded", retried.message);
  assert.equal(harness.getState().installRoot, SECOND_INSTALL_ROOT);
  assert.equal(harness.getState().activeTask.taskId, "git-root-b");
});

test("Git prepare recovers after a process dies during download or identity pin", async (t) => {
  for (const phase of ["download", "pin"]) {
    await t.test(phase, async () => {
      let enteredResolve;
      let releaseResolve;
      let calls = 0;
      const entered = new Promise((resolve) => { enteredResolve = resolve; });
      const blocked = new Promise((resolve) => { releaseResolve = resolve; });
      const pause = async () => {
        calls += 1;
        if (calls === 1) { enteredResolve(); await blocked; }
      };
      const harness = fixture({
        gitDiscovery: { kind: "none" },
        ...(phase === "download" ? { onDownload: pause } : { onGitPin: pause }),
      });
      const abandoned = harness.adapters.git.prepare({ taskId: `git-${phase}-crash`, selected: true });
      await entered;
      harness.simulateProcessCrash();

      const recovered = await harness.createAnotherProcessAdapters().git.prepare({
        taskId: `git-${phase}-recovered`, selected: true,
      });
      assert.equal(recovered.status, "succeeded", recovered.message);
      assert.equal(harness.getState().activeTask.taskId, `git-${phase}-recovered`);

      releaseResolve();
      assert.equal((await abandoned).status, "failed");
    });
  }
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

test("applied shortcut recovery never adopts a persisted record without exact host evidence", async () => {
  const state = emptyState(INSTALL_ROOT);
  state.components.chatgpt = {
    managed: true, installPath: "D:\\CBApps\\c", version: "2.0.0",
    entrypointPath: "D:\\CBApps\\c\\ChatGPT.exe", requiredFiles: ["D:\\CBApps\\c\\ChatGPT.exe"],
    health: "healthy",
  };
  state.activeTask = {
    kind: "component-shortcut", phase: "applied", taskId: "forged-applied", componentId: "chatgpt",
    desktopPath: DESKTOP, targetPath: "D:\\CBApps\\c\\ChatGPT.exe",
    shortcut: {
      name: "ChatGPT", path: `${DESKTOP}\\ChatGPT.lnk`, desktopPath: DESKTOP,
      targetPath: "D:\\CBApps\\c\\ChatGPT.exe", creationId: "f".repeat(32),
    },
  };
  const { adapters, getState } = fixture({ state });

  assert.equal((await adapters.chatgpt.inspectInstalled({})).status, "succeeded");
  assert.equal(getState().activeTask, null);
  assert.deepEqual(getState().shortcuts, []);
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

test("component uninstall rejects foreign or legacy shortcut records before stopping or deleting", async (t) => {
  const targetPath = "D:\\CBApps\\c\\ChatGPT.exe";
  const base = emptyState(INSTALL_ROOT);
  base.components.chatgpt = {
    managed: true, installPath: "D:\\CBApps\\c", version: "2.0.0",
    entrypointPath: targetPath, requiredFiles: [targetPath], health: "healthy",
  };
  const owned = {
    componentId: "chatgpt", name: "ChatGPT", path: `${DESKTOP}\\ChatGPT.lnk`,
    desktopPath: DESKTOP, targetPath, creationId: "a".repeat(32),
  };
  const cases = [
    ["foreign desktop", { ...owned, path: "C:\\Other\\Desktop\\ChatGPT.lnk", desktopPath: "C:\\Other\\Desktop" }],
    ["legacy missing marker", { componentId: "chatgpt", name: "ChatGPT", path: owned.path, desktopPath: DESKTOP, targetPath }],
  ];

  for (const [name, shortcut] of cases) {
    await t.test(name, async () => {
      const state = structuredClone(base);
      state.shortcuts = [shortcut];
      const { adapters, calls, getState } = fixture({ state });
      const removed = await adapters.chatgpt.uninstall({ taskId: `reject-${name.replaceAll(" ", "-")}` });
      assert.equal(removed.status, "failed");
      assert.deepEqual(calls.stopped, []);
      assert.deepEqual(calls.removedShortcuts, []);
      assert.deepEqual(calls.deletedComponents, []);
      assert.equal(getState().components.chatgpt.entrypointPath, targetPath);
    });
  }
});

test("component uninstall validates but preserves another component's owned shortcut", async () => {
  const chatTarget = "D:\\CBApps\\c\\ChatGPT.exe";
  const v2Target = "D:\\CBApps\\V2RayN\\current\\v2rayN.exe";
  const state = emptyState(INSTALL_ROOT);
  state.components = {
    chatgpt: {
      managed: true, installPath: "D:\\CBApps\\c", version: "2.0.0",
      entrypointPath: chatTarget, requiredFiles: [chatTarget], health: "healthy",
    },
    v2rayn: {
      managed: true, installPath: "D:\\CBApps\\V2RayN\\current", version: "7.0.4",
      entrypointPath: v2Target, requiredFiles: [v2Target], health: "healthy",
    },
  };
  state.shortcuts = [
    {
      componentId: "chatgpt", name: "ChatGPT", path: `${DESKTOP}\\ChatGPT.lnk`,
      desktopPath: DESKTOP, targetPath: chatTarget, creationId: "a".repeat(32),
    },
    {
      componentId: "v2rayn", name: "V2RayN", path: `${DESKTOP}\\V2RayN.lnk`,
      desktopPath: DESKTOP, targetPath: v2Target, creationId: "b".repeat(32),
    },
  ];
  const { adapters, calls, getState } = fixture({ state });

  const removed = await adapters.chatgpt.uninstall({ taskId: "remove-only-chatgpt" });

  assert.equal(removed.status, "succeeded");
  assert.deepEqual(calls.removedShortcuts.map((shortcut) => shortcut.componentId), ["chatgpt"]);
  assert.deepEqual(getState().shortcuts.map((shortcut) => shortcut.componentId), ["v2rayn"]);
  assert.equal(getState().components.v2rayn.entrypointPath, v2Target);
});

test("shortcut recovery revalidates the trusted desktop capability immediately before inspection", async () => {
  let identityRead = 0;
  const changingDesktopCapability = await authorizeDesktopPath({
    getDesktopPath: () => DESKTOP,
    realpath: async (value) => value,
    lstat: async () => ({ ...directoryStat, ino: ++identityRead <= 2 ? 1 : 2 }),
  });
  const targetPath = "D:\\CBApps\\c\\ChatGPT.exe";
  const state = emptyState(INSTALL_ROOT);
  state.components.chatgpt = {
    managed: true, installPath: "D:\\CBApps\\c", version: "2.0.0",
    entrypointPath: targetPath, requiredFiles: [targetPath], health: "healthy",
  };
  state.activeTask = {
    kind: "component-shortcut", phase: "reserved", taskId: "desktop-identity-race", componentId: "chatgpt",
    desktopPath: DESKTOP, targetPath,
    shortcut: {
      name: "ChatGPT", path: `${DESKTOP}\\ChatGPT.lnk`, desktopPath: DESKTOP,
      targetPath, creationId: "a".repeat(32),
    },
  };
  const { adapters, calls, getState } = fixture({ state, desktopCapability: changingDesktopCapability });

  const inspected = await adapters.chatgpt.inspectInstalled({});

  assert.equal(inspected.status, "failed");
  assert.deepEqual(calls.inspectedShortcuts, []);
  assert.equal(getState().activeTask.taskId, "desktop-identity-race");
});

test("external Git inspect works with null ownership and ambiguous discovery fails closed", async () => {
  const { adapters } = fixture({ gitDiscovery: externalGit });
  const found = await adapters.git.inspectInstalled({});
  assert.equal(found.status, "succeeded");
  assert.equal(found.versionAfter, "2.50.0");
  assert.deepEqual(found.details, { ownership: "external", installPath: externalGit.installDir, previousVersion: null });
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

test("external Git success and crash recovery release only a transient install root", async (t) => {
  await t.test("success", async () => {
    const harness = fixture({ gitDiscovery: externalGit });
    assert.equal((await harness.adapters.git.prepare({ taskId: "external-root-success", selected: true })).status, "succeeded");
    const committed = await harness.adapters.git.commit({ taskId: "external-root-success" });
    assert.equal(committed.status, "succeeded", committed.message);
    assert.equal(harness.getState().installRoot, null);
  });

  await t.test("crash recovery", async () => {
    const updated = { ...externalGit, version: "2.51.0" };
    let enteredResolve;
    let releaseResolve;
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    const blocked = new Promise((resolve) => { releaseResolve = resolve; });
    const harness = fixture({
      gitDiscoveries: [externalGit, externalGit, updated], gitDiscovery: updated,
      onGitInstall: async () => { enteredResolve(); await blocked; },
    });
    assert.equal((await harness.adapters.git.prepare({ taskId: "external-root-crash", selected: true })).status, "succeeded");
    const abandoned = harness.adapters.git.commit({ taskId: "external-root-crash" });
    await entered;
    harness.simulateProcessCrash();
    const inspected = await harness.createAnotherProcessAdapters().git.inspectInstalled({});
    assert.equal(inspected.status, "succeeded", inspected.message);
    assert.equal(harness.getState().installRoot, null);
    releaseResolve();
    assert.equal((await abandoned).status, "failed");
  });

  await t.test("managed ownership retained", async () => {
    const state = emptyState(INSTALL_ROOT);
    state.components.chatgpt = { managed: true, installPath: "D:\\CBApps\\c", version: "1.0.0" };
    const harness = fixture({ state, gitDiscovery: externalGit });
    assert.equal((await harness.adapters.git.prepare({ taskId: "external-root-owned", selected: true })).status, "succeeded");
    assert.equal((await harness.adapters.git.commit({ taskId: "external-root-owned" })).status, "succeeded");
    assert.equal(harness.getState().installRoot, INSTALL_ROOT);
  });
});

test("managed Git crash before first installer mutation releases only an otherwise transient root", async (t) => {
  for (const scenario of ["empty", "owned"]) {
    await t.test(scenario, async () => {
      let enteredResolve;
      let releaseResolve;
      const entered = new Promise((resolve) => { enteredResolve = resolve; });
      const blocked = new Promise((resolve) => { releaseResolve = resolve; });
      const state = emptyState(scenario === "owned" ? INSTALL_ROOT : null);
      if (scenario === "owned") {
        state.components.chatgpt = {
          managed: true, installPath: `${INSTALL_ROOT}\\c`, version: "1.0.0",
          entrypointPath: `${INSTALL_ROOT}\\c\\ChatGPT.exe`,
          requiredFiles: [`${INSTALL_ROOT}\\c\\ChatGPT.exe`],
        };
      }
      const harness = fixture({
        state, gitDiscovery: { kind: "none" },
        onGitInstall: async () => { enteredResolve(); await blocked; },
      });
      assert.equal((await harness.adapters.git.prepare({
        taskId: `managed-root-${scenario}`, selected: true,
      })).status, "succeeded");
      const abandoned = harness.adapters.git.commit({ taskId: `managed-root-${scenario}` });
      await entered;
      harness.simulateProcessCrash();
      const inspected = await harness.createAnotherProcessAdapters().git.inspectInstalled({});
      assert.notEqual(inspected.status, "failed", inspected.message);
      assert.equal(harness.getState().installRoot, scenario === "owned" ? INSTALL_ROOT : null);
      releaseResolve();
      await abandoned;
    });
  }
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
    state, gitDiscoveries: [current, current, installed], gitDiscovery: installed, stateSaveFailureAt: 4,
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
    state, gitDiscoveries: [current, current, installed], gitDiscovery: installed, stateSaveFailureAt: 3,
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

test("external Git uninstall recovery clears a dead claim after fresh discovery proves removal", async () => {
  const first = fixture({
    gitDiscoveries: [externalGit, { kind: "none" }],
    gitDiscovery: { kind: "none" },
    stateSaveFailureAt: 2,
  });
  const removed = await first.adapters.git.uninstall({ selected: true, taskId: "external-remove-recover" });
  assert.equal(removed.status, "failed");
  assert.equal(first.getState().activeTask.kind, "git-uninstall");
  assert.equal(first.getState().activeTask.mode, "external");
  assert.equal(first.getState().activeTask.registryKey, externalGit.registryKey);

  const recovered = await first.createAnotherAdapters().git.inspectInstalled({});
  assert.equal(recovered.status, "skipped", recovered.message);
  assert.equal(first.getState().activeTask, null);
  assert.equal(first.calls.gitUninstalls.length, 1, "recovery must never execute the uninstaller again");
});

test("external Git uninstall recovery aborts only for the same registry identity and fails closed on replacement", async () => {
  const unchanged = fixture({
    gitDiscoveries: [externalGit, externalGit], gitDiscovery: externalGit, stateSaveFailureAt: 2,
  });
  assert.equal((await unchanged.adapters.git.uninstall({ selected: true, taskId: "external-remove-unchanged" })).status, "failed");
  assert.equal((await unchanged.createAnotherAdapters().git.inspectInstalled({})).status, "succeeded");
  assert.equal(unchanged.getState().activeTask, null);
  assert.equal(unchanged.calls.gitUninstalls.length, 1);

  const replacement = {
    ...externalGit,
    registryKey: "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Git_is1",
  };
  const changed = fixture({
    gitDiscoveries: [externalGit, replacement], gitDiscovery: replacement, stateSaveFailureAt: 2,
  });
  assert.equal((await changed.adapters.git.uninstall({ selected: true, taskId: "external-remove-replaced" })).status, "failed");
  const recovery = await changed.createAnotherAdapters().git.inspectInstalled({});
  assert.equal(recovery.status, "failed");
  assert.match(recovery.message, /git_uninstall_recovery_incomplete/u);
  assert.equal(changed.getState().activeTask.kind, "git-uninstall");
  assert.equal(changed.calls.gitUninstalls.length, 1);
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
    kind: "git-uninstall", phase: "executing", taskId: "hung-managed-remove", mode: "managed",
    version: registered.version, targetDir: registered.installDir, executablePath: registered.executablePath,
    uninstallerPath: registered.uninstallerPath, registryKey: registered.registryKey, leaseScope: "git-execute",
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
  assert.equal(getState().activeTask, null);
  assert.equal(getState().installRoot, INSTALL_ROOT);
  const committed = await adapters.skills.commit({ taskId: "skills", skillIds: ["documents"] });
  assert.equal(committed[0].status, "succeeded");
  assert.equal(calls.replacedSkills[0].target, "C:\\Users\\tester\\.codex\\skills\\documents");
  assert.equal(calls.replacedSkills[0].backup, false);
  assert.equal(getState().activeTask?.kind, "skill-replace");
  assert.match(getState().activeTask.swapId, /^[a-f0-9]{32}$/u);
  calls.skillOperations.length = 0;
  const recovered = await adapters.skills.inspectInstalled({ skillIds: ["documents"] });
  assert.equal(recovered[0].status, "succeeded");
  assert.equal(getState().skills.documents.version, "1.0.0");
  assert.equal(getState().activeTask, null);
  assert.deepEqual(calls.skillOperations.slice(0, 2).map(([operation]) => operation), ["reconcile", "inspect"]);
});

test("Skill replace failure before swap WAL preserves root and lease evidence for restart recovery", async () => {
  const shared = fixture({ onReplaceSkill: async () => { throw new Error("before_swap_wal"); } });
  assert.equal((await shared.adapters.skills.prepare({ taskId: "skill-prewal", skillIds: ["documents"] }))[0].status, "succeeded");
  const committed = await shared.adapters.skills.commit({ taskId: "skill-prewal", skillIds: ["documents"] });
  assert.equal(committed[0].status, "failed");
  const claim = shared.getState().activeTask;
  assert.equal(claim.kind, "skill-replace");
  assert.equal(claim.phase, "reserved");
  assert.equal(claim.installRoot, INSTALL_ROOT);
  assert.equal(claim.leaseScope, "prepare");
  assert.match(claim.leaseNonce, /^[a-f0-9]{32}$/u);
  assert.equal(shared.preparedSkillSourceCount(), 0);

  const restarted = shared.createAnotherAdapters();
  const inspected = await restarted.skills.inspectInstalled({ skillIds: ["documents"] });
  assert.equal(inspected[0].status, "skipped");
  assert.equal(shared.getState().activeTask, null);
  assert.equal(shared.getState().lastTask.action, "skill-replace-aborted");
});

test("a live Skill replace lease blocks a second adapter before swap mutation and the owner completes normally", async () => {
  let enteredResolve;
  let continueResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const continueCommit = new Promise((resolve) => { continueResolve = resolve; });
  const shared = fixture({
    onReplaceSkill: async () => { enteredResolve(); await continueCommit; },
  });
  assert.equal((await shared.adapters.skills.prepare({
    taskId: "skill-live-replace", skillIds: ["documents"],
  }))[0].status, "succeeded");
  const committing = shared.adapters.skills.commit({
    taskId: "skill-live-replace", skillIds: ["documents"],
  });
  await entered;
  const liveClaim = shared.getState().activeTask;
  assert.equal(liveClaim.kind, "skill-replace");
  assert.equal(liveClaim.leaseScope, "prepare");
  const operationsBefore = shared.calls.skillOperations.length;
  await shared.createAnotherProcessAdapters().skills.inspectInstalled({ skillIds: ["documents"] });
  assert.deepEqual(shared.getState().activeTask, liveClaim);
  assert.equal(shared.calls.skillOperations.length, operationsBefore);
  assert.equal(shared.preparedSkillSourceCount(), 1);
  continueResolve();
  assert.equal((await committing)[0].status, "succeeded");
  assert.equal(shared.getState().activeTask, null);
});

test("Skill entrypoints recover a reserved swap before reclaiming its dead prepared-source lease", async (t) => {
  for (const entrypoint of ["inspect", "prepare"]) {
    await t.test(entrypoint, async () => {
      const target = path.win32.join(SKILLS_ROOT, "documents");
      const state = emptyState(INSTALL_ROOT);
      state.activeTask = {
        kind: "skill-replace",
        installRoot: INSTALL_ROOT,
        leaseScope: "prepare",
        leaseNonce: "6".repeat(32),
        phase: "reserved",
        taskId: "swap-crash",
        swapId: "5".repeat(32),
        skillId: "documents",
        skillsRoot: SKILLS_ROOT,
        target,
        version: "1.0.0",
        packageSha256: DIGEST_B,
        skillMdSha256: SKILL_HASH,
        treeDigest: DIGEST_A,
        manifestDigest: DIGEST_B,
        previousEvidence: { kind: "absent" },
      };
      const preparedSource = {
        taskId: "swap-crash",
        skillId: "documents",
        leaseScope: "prepare",
        leaseNonce: "6".repeat(32),
        phase: "sealed",
      };
      const current = fixture({
        state,
        initialPreparedSkillSources: [preparedSource],
        recoverReservedSkillFromPreparedSource: true,
      });
      if (entrypoint === "inspect") {
        const result = await current.adapters.skills.inspectInstalled({ skillIds: ["documents"] });
        assert.equal(result[0].status, "succeeded", JSON.stringify(result[0]));
      } else {
        assert.deepEqual(await current.adapters.skills.prepare({ taskId: "next-task", skillIds: [] }), []);
      }
      assert.deepEqual(current.calls.skillRecoveryOrder.slice(0, 2), ["swap-reconcile", "prepare-reconcile"]);
      assert.equal(current.preparedSkillSourceCount(), 0);
      assert.equal(current.getState().activeTask, null);
      assert.equal(current.getState().skills.documents.version, "1.0.0");
      assert.equal(current.calls.discardedSkillSources.filter((item) => item.recovery === "swap-prepared").length, 1);
      assert.equal(current.calls.discardedSkillSources.filter((item) => item.recovery === true).length, 0);
    });
  }
});

test("Skill uninstall is independently recovered after deletion completed before state save", async () => {
  const state = emptyState(INSTALL_ROOT);
  state.skills.documents = {
    target: "C:\\Users\\tester\\.codex\\skills\\documents", version: "1.0.0",
    packageSha256: DIGEST_B, skillMdSha256: SKILL_HASH,
    identity: { volumeSerial: "v", fileId: "existing" }, treeDigest: DIGEST_A, manifestDigest: DIGEST_B,
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
    kind: "skill-replace", phase: "reserved", taskId: "skill-tree-mismatch", swapId: "1".repeat(32), skillId: "documents",
    installRoot: INSTALL_ROOT, leaseScope: "prepare", leaseNonce: "7".repeat(32),
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
    kind: "skill-replace", phase: "applied", taskId: "skill-forged", swapId: "2".repeat(32), skillId: "documents",
    installRoot: INSTALL_ROOT, leaseScope: "prepare", leaseNonce: "8".repeat(32),
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
    kind: "skill-replace", phase: "reserved", taskId: "skill-before-mutation", swapId: "3".repeat(32), skillId: "documents",
    installRoot: INSTALL_ROOT, leaseScope: "prepare", leaseNonce: "9".repeat(32),
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

test("first-install reserved Skill abort releases its transient root after a complete prepared-source rescan", async () => {
  const state = emptyState(null);
  state.activeTask = {
    kind: "skill-replace", phase: "reserved", taskId: "skill-first-abort", swapId: "4".repeat(32), skillId: "documents",
    installRoot: INSTALL_ROOT, leaseScope: "prepare", leaseNonce: "a".repeat(32),
    skillsRoot: SKILLS_ROOT, target: `${SKILLS_ROOT}\\documents`, version: "1.0.0",
    packageSha256: DIGEST_B, skillMdSha256: SKILL_HASH, treeDigest: DIGEST_A, manifestDigest: DIGEST_B,
    previousEvidence: { kind: "absent" },
  };
  const { adapters, getState } = fixture({ state });
  const inspected = await adapters.skills.inspectInstalled({ skillIds: ["documents"] });
  assert.equal(inspected[0].status, "skipped", JSON.stringify(inspected[0]));
  assert.equal(getState().activeTask, null);
  assert.equal(getState().installRoot, null);
  assert.equal(getState().lastTask.action, "skill-replace-aborted");
});

test("Skill prepared-source reconciliation failure is reported and retains transient root ownership", async () => {
  const recoveryError = Object.assign(new Error("prepared_recovery_failed"), { code: "prepared_recovery_failed" });
  const { adapters, getState } = fixture({
    state: emptyState(INSTALL_ROOT),
    preparedSkillReconcileOverride: async () => ({
      status: "failed", cleaned: [], live: [], unresolved: [], failed: [{ error: recoveryError }],
    }),
  });
  const inspected = await adapters.skills.inspectInstalled({ skillIds: ["documents"] });
  assert.equal(inspected[0].status, "failed");
  assert.match(inspected[0].message, /prepared_recovery_failed/u);
  const prepared = await adapters.skills.prepare({ taskId: "reconcile-failed", skillIds: ["documents"] });
  assert.equal(prepared[0].componentId, "documents");
  assert.equal(prepared[0].status, "failed");
  assert.match(prepared[0].message, /prepared_recovery_failed/u);
  assert.equal(getState().installRoot, INSTALL_ROOT);
});

test("live Skill prepared source retains transient root and does not race cleanup", async () => {
  let scans = 0;
  const { adapters, getState } = fixture({
    state: emptyState(INSTALL_ROOT),
    preparedSkillReconcileOverride: async () => {
      scans += 1;
      return { status: "live", cleaned: [], live: [{ taskId: "live" }], unresolved: [], failed: [] };
    },
  });
  const inspected = await adapters.skills.inspectInstalled({ skillIds: ["documents"] });
  assert.equal(inspected[0].status, "skipped");
  assert.equal(scans, 1);
  assert.equal(getState().installRoot, INSTALL_ROOT);
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
  assert.equal(calls.cleanedSkillPackages.length, 1);
  assert.equal(calls.cleanedSkillStaging.length, 1);
  assert.deepEqual(getState().skills, {});
});

test("lazy Skills authority retries after denial without affecting components", async () => {
  let calls = 0;
  const provider = async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("skills_denied"), { code: "EACCES" });
    return SKILLS_CAPABILITY;
  };
  const { adapters } = fixture({ skillsRootCapability: provider });
  const denied = await adapters.skills.inspectInstalled({ skillIds: ["documents"] });
  assert.equal(calls, 1);
  assert.equal(denied[0].status, "failed");
  assert.notEqual((await adapters.chatgpt.inspectInstalled({})).status, "failed");
  const retried = await adapters.skills.inspectInstalled({ skillIds: ["documents"] });
  assert.equal(calls, 2);
  assert.equal(retried[0].componentId, "documents");
  assert.notEqual(retried[0].status, "failed");
});

test("a second adapter skips a live sealed Skill prepare and reclaims it only after the owner crashes", async () => {
  const shared = fixture();
  const second = shared.createAnotherAdapters();
  const prepared = await shared.adapters.skills.prepare({ taskId: "lease-a", skillIds: ["documents"] });
  assert.equal(prepared[0].status, "succeeded");
  assert.equal(shared.preparedSkillSourceCount(), 1);

  await second.skills.inspectInstalled({ skillIds: ["documents"] });
  assert.equal(shared.preparedSkillSourceCount(), 1);
  assert.equal(shared.calls.discardedSkillSources.some((item) => item.recovery === true), false);

  shared.simulateProcessCrash();
  await second.skills.inspectInstalled({ skillIds: ["documents"] });
  assert.equal(shared.preparedSkillSourceCount(), 0);
  assert.equal(shared.calls.discardedSkillSources.filter((item) => item.recovery === true).length, 1);
});

test("Skill owner keeps its prepare lease until exact discard finishes", async () => {
  let enteredResolve;
  let cleanupResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const cleanupBlocked = new Promise((resolve) => { cleanupResolve = resolve; });
  const shared = fixture({
    onDiscardPreparedSkill: async () => {
      enteredResolve();
      await cleanupBlocked;
    },
  });
  const prepared = await shared.adapters.skills.prepare({ taskId: "lease-discard", skillIds: ["documents"] });
  assert.equal(prepared[0].status, "succeeded");

  const discarding = shared.adapters.skills.discardPrepared({
    taskId: "lease-discard", skillIds: ["documents"],
  });
  await entered;
  assert.equal((await shared.reconcilePreparedSkillSources()).status, "live");
  assert.equal(shared.preparedSkillSourceCount(), 1);
  assert.equal(shared.calls.discardedSkillSources.some((item) => item.recovery === true), false);

  cleanupResolve();
  assert.deepEqual(await discarding, [true]);
  assert.equal(shared.preparedSkillSourceCount(), 0);
  assert.equal(shared.getState().installRoot, null);
  assert.deepEqual(shared.calls.discardLeaseBusy, [true]);
  assert.equal(shared.calls.discardedSkillSources.filter((item) => item.recovery === true).length, 0);
});

test("Skill prepare and commit failure cleanup retain the owner lease through source deletion", async (t) => {
  await t.test("prepare failure", async () => {
    const shared = fixture({ onExtract: async () => { throw new Error("test_extract_failed"); } });
    const [prepared] = await shared.adapters.skills.prepare({ taskId: "lease-prepare-failure", skillIds: ["documents"] });
    assert.equal(prepared.status, "failed");
    assert.deepEqual(shared.calls.discardLeaseBusy, [true]);
    assert.equal(shared.preparedSkillSourceCount(), 0);
  });

  await t.test("commit failure", async () => {
    const shared = fixture({ onReplaceSkill: async () => { throw new Error("test_replace_failed"); } });
    assert.equal((await shared.adapters.skills.prepare({
      taskId: "lease-commit-failure", skillIds: ["documents"],
    }))[0].status, "succeeded");
    const [committed] = await shared.adapters.skills.commit({
      taskId: "lease-commit-failure", skillIds: ["documents"],
    });
    assert.equal(committed.status, "failed");
    assert.deepEqual(shared.calls.discardLeaseBusy, [true]);
    assert.equal(shared.preparedSkillSourceCount(), 0);
  });
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
  const excessive = `${`${"a".repeat(250)}/`.repeat(132)}SKILL.md`;
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
