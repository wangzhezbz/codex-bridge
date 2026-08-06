import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createComponentAdapters } from "../desktop/software-manager/component-adapters.mjs";

const INSTALL_ROOT = "D:\\CBApps";
const SKILLS_ROOT = "C:\\Users\\tester\\.codex\\skills";
const DESKTOP = "C:\\Users\\tester\\Desktop";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const SKILL_HASH = "c".repeat(64);

function component(id, overrides = {}) {
  const defaults = {
    chatgpt: { name: "ChatGPT", version: "2.0.0", format: "zip", entrypoint: "ChatGPT.exe" },
    v2rayn: { name: "V2RayN", version: "7.0.4", format: "7z", entrypoint: "v2rayN.exe" },
    git: { name: "Git", version: "2.51.0", format: "exe", entrypoint: "cmd/git.exe" },
  }[id];
  return {
    id,
    architecture: "x64",
    assetUrl: `/codexbridge-test/packages/${id}-${defaults.version}.${defaults.format}`,
    size: 123,
    sha256: DIGEST_A,
    requiredFiles: [defaults.entrypoint],
    maxRelativePathLength: 80,
    publishedAt: "2026-08-07T00:00:00.000Z",
    supportsRollback: true,
    ...defaults,
    ...overrides,
  };
}

function skill(id = "documents") {
  return {
    id,
    name: id,
    description: "fixture",
    version: "1.0.0",
    assetUrl: `/codexbridge-test/packages/skill-${id}.zip`,
    size: 42,
    sha256: DIGEST_B,
    files: ["SKILL.md", "reference.md"],
  };
}

function emptyState() {
  return {
    schemaVersion: 1,
    installRoot: INSTALL_ROOT,
    components: {},
    skills: {},
    shortcuts: [],
    rollback: null,
    activeTask: null,
    lastTask: null,
  };
}

function fixture({
  state = emptyState(),
  gitDiscovery = { kind: "none" },
  gitDiscoveries = null,
  running = false,
  forgedArchiveReceipt = false,
  persistentFailureAt = null,
  skillHashes = null,
} = {}) {
  let currentState = structuredClone(state);
  const calls = {
    downloads: [], extracts: [], promotions: [], rollbacks: [], stopped: [], launched: [],
    shortcuts: [], removedShortcuts: [], verified: [], gitInstalls: [], gitUninstalls: [],
    replacedSkills: [], deletedSkills: [], deletedComponents: [], hashes: [],
    persistentPrepared: [], persistentVerified: [],
  };
  const receipts = new Map();
  const ownershipStore = {
    async load() { return structuredClone(currentState); },
    async save(next) { currentState = structuredClone(next); },
  };
  const windowsHost = {
    async discoverGit() {
      const value = Array.isArray(gitDiscoveries) && gitDiscoveries.length > 0
        ? gitDiscoveries.shift()
        : gitDiscovery;
      return structuredClone(value);
    },
    async verifyAuthenticode(filePath) {
      calls.verified.push({ kind: "authenticode", filePath });
      return { status: "Valid", thumbprint: "A", subject: "Git for Windows" };
    },
    async stopOwnedProcesses(paths) {
      calls.stopped.push([...paths]);
      return { stoppedProcessIds: running ? [123] : [] };
    },
    async launchOwned(executablePath) { calls.launched.push(executablePath); return { executablePath, pid: 456 }; },
    async createShortcut(record) {
      const collision = calls.shortcuts.length === 0 ? "（1）" : "（2）";
      const result = { ...record, path: path.win32.join(record.desktopPath, `${record.name}${collision}.lnk`) };
      calls.shortcuts.push(result);
      return result;
    },
    async removeRecordedShortcut(record) { calls.removedShortcuts.push(record); return { removed: true, path: record.path }; },
    async runGitInstaller(plan) { calls.gitInstalls.push(plan); return { targetDir: plan.targetDir }; },
    async runGitUninstaller(plan) { calls.gitUninstalls.push(plan); return { installDir: plan.installDir }; },
  };
  const archiveService = {
    async extractArchive(plan) {
      calls.extracts.push(plan);
      const verificationReceipt = Object.freeze(Object.create(null));
      if (!forgedArchiveReceipt) receipts.set(verificationReceipt, plan.verification);
      return {
        entries: [{ path: plan.verification?.componentId === "v2rayn" ? "v2rayN.exe" : "ChatGPT.exe", size: 10, directory: false }],
        maxRelativePath: 11,
        totalUnpackedBytes: 10,
        ...(plan.verification ? { verificationReceipt, treeDigest: DIGEST_A, manifestDigest: DIGEST_B } : {}),
      };
    },
  };
  const versionSlots = {
    async promotePreparedVersion(plan) {
      assert.deepEqual(receipts.get(plan.verificationReceipt), { componentId: plan.componentId, version: plan.version });
      calls.promotions.push(plan);
      currentState.components[plan.componentId] = {
        ...(currentState.components[plan.componentId] ?? {}),
        installPath: path.win32.join(plan.rootPath, plan.componentId === "chatgpt" ? "c" : "current"),
        version: plan.version,
        packageSha256: DIGEST_A,
        managed: true,
      };
      return { componentId: plan.componentId, version: plan.version, rollbackAvailable: Boolean(currentState.rollback) };
    },
    async rollbackVersion(componentId) { calls.rollbacks.push(componentId); return { componentId, version: "1.0.0", rollbackAvailable: false }; },
  };
  const componentFiles = {
    async verifyComponent(plan) { calls.verified.push({ kind: "component", ...plan }); return { version: plan.expectedVersion }; },
    async verifyGitVersion(executablePath, expectedVersion) {
      calls.verified.push({ kind: "git-version", executablePath, expectedVersion });
      return { executablePath, version: expectedVersion, stdout: `git version ${expectedVersion}` };
    },
    async verifyPreparedGit(plan) {
      const verificationReceipt = Object.freeze(Object.create(null));
      receipts.set(verificationReceipt, { componentId: "git", version: plan.version });
      return { verificationReceipt, treeDigest: DIGEST_A, manifestDigest: DIGEST_B };
    },
    async preparePersistentDirectory(plan) {
      calls.persistentPrepared.push(plan);
      return Object.freeze({ identity: "v2-config" });
    },
    async verifyPersistentDirectory(plan) {
      calls.persistentVerified.push(plan);
      if (calls.persistentVerified.length === persistentFailureAt) throw new Error("persistent_config_changed");
      return true;
    },
    async deleteComponent(plan) { calls.deletedComponents.push(plan); },
  };
  const skillFiles = {
    async hashFile(filePath) {
      calls.hashes.push(filePath);
      return Array.isArray(skillHashes) && skillHashes.length > 0 ? skillHashes.shift() : SKILL_HASH;
    },
    async verifyPreparedSkill() { return true; },
    async replaceExact(plan) { calls.replacedSkills.push(plan); },
    async deleteExact(plan) { calls.deletedSkills.push(plan); },
  };
  const resolveSkillTarget = async ({ skillsRoot, skillId }) => path.win32.join(skillsRoot, skillId);
  const downloader = {
    async download(plan) { calls.downloads.push(plan); return { path: plan.destination, size: plan.asset.size, sha256: plan.asset.sha256, resumed: false }; },
  };
  const adapters = createComponentAdapters({
    downloader, archiveService, versionSlots, ownershipStore, windowsHost,
    componentFiles, skillFiles, resolveSkillTarget,
  });
  return { adapters, calls, getState: () => structuredClone(currentState), windowsHost };
}

function catalog() {
  return { schemaVersion: 1, components: [component("chatgpt"), component("v2rayn"), component("git")], skills: [skill()] };
}

test("ChatGPT prepare derives c/cp/ct paths and passes the opaque archive receipt into the slot transaction", async () => {
  const { adapters, calls } = fixture();
  const prepared = await adapters.chatgpt.prepare({ taskId: "task-chat", installRoot: INSTALL_ROOT, catalog: catalog() });
  assert.equal(prepared.status, "succeeded");
  assert.equal(calls.extracts[0].destination, path.win32.join(INSTALL_ROOT, "ChatGPT", "ct"));
  const committed = await adapters.chatgpt.commit({ taskId: "task-chat", desktopPath: DESKTOP });
  assert.equal(committed.status, "succeeded");
  assert.equal(calls.promotions[0].rootPath, path.win32.join(INSTALL_ROOT, "ChatGPT"));
  assert.equal(typeof calls.promotions[0].verificationReceipt, "object");
  assert.equal(calls.promotions[0].treeDigest, DIGEST_A);
  assert.equal(calls.promotions[0].manifestDigest, DIGEST_B);
});

test("ChatGPT ignores external installations, preserves .codex, uses a collision-safe shortcut, and stays closed when it was closed", async () => {
  const { adapters, calls, getState } = fixture({ gitDiscovery: { kind: "external", installDir: "C:\\Other" } });
  const inspected = await adapters.chatgpt.inspectInstalled({ installRoot: INSTALL_ROOT });
  assert.equal(inspected.status, "skipped");
  await adapters.chatgpt.prepare({ taskId: "chat-closed", installRoot: INSTALL_ROOT, catalog: catalog() });
  await adapters.chatgpt.commit({ taskId: "chat-closed", desktopPath: DESKTOP });
  assert.deepEqual(calls.launched, []);
  assert.match(calls.shortcuts[0].path, /ChatGPT（1）\.lnk$/u);
  assert.equal(JSON.stringify(calls).includes(".codex"), false);
  assert.equal(getState().components.chatgpt.installPath, path.win32.join(INSTALL_ROOT, "ChatGPT", "c"));
});

test("ChatGPT restarts only when an owned old executable was running", async () => {
  const state = emptyState();
  state.components.chatgpt = { installPath: path.win32.join(INSTALL_ROOT, "ChatGPT", "c"), version: "1.0.0", packageSha256: DIGEST_A, managed: true };
  const { adapters, calls } = fixture({ state, running: true });
  await adapters.chatgpt.prepare({ taskId: "chat-running", installRoot: INSTALL_ROOT, catalog: catalog() });
  await adapters.chatgpt.commit({ taskId: "chat-running", desktopPath: DESKTOP });
  assert.deepEqual(calls.stopped[0], [path.win32.join(INSTALL_ROOT, "ChatGPT", "c", "ChatGPT.exe")]);
  assert.deepEqual(calls.launched, [path.win32.join(INSTALL_ROOT, "ChatGPT", "c", "ChatGPT.exe")]);
});

test("V2RayN keeps its persistent configuration root separate from all version slots", async () => {
  const { adapters, calls, getState } = fixture();
  await adapters.v2rayn.prepare({ taskId: "v2", installRoot: INSTALL_ROOT, catalog: catalog() });
  assert.equal(calls.extracts[0].destination, path.win32.join(INSTALL_ROOT, "V2RayN", "staging"));
  await adapters.v2rayn.commit({ taskId: "v2", desktopPath: DESKTOP });
  const record = getState().components.v2rayn;
  assert.equal(record.installPath, path.win32.join(INSTALL_ROOT, "V2RayN", "current"));
  assert.equal(record.configRoot, path.win32.join(INSTALL_ROOT, "V2RayN-Data"));
  assert.equal(record.configRoot.startsWith(`${path.win32.join(INSTALL_ROOT, "V2RayN")}\\`), false);
  assert.equal(calls.promotions[0].rootPath, path.win32.join(INSTALL_ROOT, "V2RayN"));
  assert.equal(calls.persistentPrepared[0].rootPath, record.configRoot);
  assert.equal(calls.persistentVerified[0].rootPath, record.configRoot);
});

test("V2RayN stops only the owned current executable, creates its shortcut, and preserves config on uninstall", async () => {
  const state = emptyState();
  state.components.v2rayn = {
    installPath: path.win32.join(INSTALL_ROOT, "V2RayN", "current"), configRoot: path.win32.join(INSTALL_ROOT, "V2RayN-Data"),
    version: "6.0.0", packageSha256: DIGEST_A, managed: true,
  };
  const { adapters, calls } = fixture({ state, running: true });
  await adapters.v2rayn.prepare({ taskId: "v2-update", installRoot: INSTALL_ROOT, catalog: catalog() });
  await adapters.v2rayn.commit({ taskId: "v2-update", desktopPath: DESKTOP });
  assert.deepEqual(calls.stopped[0], [path.win32.join(INSTALL_ROOT, "V2RayN", "current", "v2rayN.exe")]);
  assert.match(calls.shortcuts[0].path, /V2RayN（1）\.lnk$/u);
  await adapters.v2rayn.uninstall({ installRoot: INSTALL_ROOT });
  assert.equal(calls.deletedComponents[0].rootPath, path.win32.join(INSTALL_ROOT, "V2RayN"));
  assert.notEqual(calls.deletedComponents[0].rootPath, path.win32.join(INSTALL_ROOT, "V2RayN-Data"));
});

test("external Git updates in place only after explicit selection and has no rollback or shortcut", async () => {
  const external = {
    kind: "external", ownership: "external", version: "2.50.0", installDir: "C:\\Git",
    executablePath: "C:\\Git\\cmd\\git.exe", uninstallerPath: "C:\\Git\\unins000.exe", registryKey: "HKLM\\Git",
  };
  const { adapters, calls } = fixture({ gitDiscovery: external });
  const refused = await adapters.git.prepare({ taskId: "git-no", installRoot: INSTALL_ROOT, catalog: catalog(), selected: false });
  assert.equal(refused.status, "failed");
  assert.equal(calls.gitInstalls.length, 0);
  await adapters.git.prepare({ taskId: "git-yes", installRoot: INSTALL_ROOT, catalog: catalog(), selected: true });
  const result = await adapters.git.commit({ taskId: "git-yes" });
  assert.equal(result.status, "succeeded");
  assert.equal(result.rollbackAvailable, false);
  assert.equal(calls.gitInstalls[0].targetDir, "C:\\Git");
  assert.equal(calls.verified.at(-1).executablePath, "C:\\Git\\cmd\\git.exe");
  assert.deepEqual(calls.shortcuts, []);
  assert.deepEqual(calls.promotions, []);
});

test("ambiguous or unregistered Git discovery fails closed before download or mutation", async () => {
  const { adapters, calls, windowsHost } = fixture();
  windowsHost.discoverGit = async () => { throw Object.assign(new Error("git_multiple_installations"), { code: "git_multiple_installations" }); };
  const result = await adapters.git.prepare({ taskId: "git-ambiguous", installRoot: INSTALL_ROOT, catalog: catalog(), selected: true });
  assert.equal(result.status, "failed");
  assert.equal(result.message, "git_multiple_installations");
  assert.deepEqual(calls.downloads, []);
});

test("managed Git uses a verified persistent slot transaction, exact target version check, rollback, and no shortcut", async () => {
  const state = emptyState();
  state.components.git = { installPath: path.win32.join(INSTALL_ROOT, "Git", "current"), version: "2.50.0", packageSha256: DIGEST_A, ownership: "managed", managed: true };
  const { adapters, calls } = fixture({ state });
  await adapters.git.prepare({ taskId: "git-managed", installRoot: INSTALL_ROOT, catalog: catalog(), selected: true });
  const result = await adapters.git.commit({ taskId: "git-managed" });
  assert.equal(result.status, "succeeded");
  assert.equal(calls.gitInstalls[0].targetDir, path.win32.join(INSTALL_ROOT, "Git", "staging"));
  assert.equal(calls.promotions[0].componentId, "git");
  assert.equal(calls.verified.at(-1).executablePath, path.win32.join(INSTALL_ROOT, "Git", "current", "cmd", "git.exe"));
  assert.deepEqual(calls.shortcuts, []);
  await adapters.git.rollback({ installRoot: INSTALL_ROOT });
  assert.deepEqual(calls.rollbacks, ["git"]);
});

test("same-name Skill replacement derives only signed direct-child IDs and verifies SKILL.md after replacement", async () => {
  const { adapters, calls, getState } = fixture();
  const prepared = await adapters.skills.prepare({
    taskId: "skills", installRoot: INSTALL_ROOT, skillsRoot: SKILLS_ROOT,
    skillIds: ["documents"], catalog: catalog(), rendererPath: "C:\\Users\\tester",
  });
  assert.equal(prepared[0].status, "succeeded");
  const result = await adapters.skills.commit({ taskId: "skills", skillIds: ["documents"], skillsRoot: SKILLS_ROOT });
  assert.equal(result[0].status, "succeeded");
  assert.equal(calls.replacedSkills[0].target, path.win32.join(SKILLS_ROOT, "documents"));
  assert.equal(calls.replacedSkills[0].authorizedRoot, SKILLS_ROOT);
  assert.equal(calls.replacedSkills.some(({ target }) => target === SKILLS_ROOT), false);
  assert.equal(calls.hashes.at(-1), path.win32.join(SKILLS_ROOT, "documents", "SKILL.md"));
  assert.equal(getState().skills.documents.target, path.win32.join(SKILLS_ROOT, "documents"));
});

test("Skills reject unsigned IDs and uninstall deletes only the explicitly selected exact target", async () => {
  const state = emptyState();
  state.skills.documents = { target: path.win32.join(SKILLS_ROOT, "documents"), version: "1.0.0", skillMdSha256: SKILL_HASH };
  state.skills.spreadsheets = { target: path.win32.join(SKILLS_ROOT, "spreadsheets"), version: "1.0.0", skillMdSha256: SKILL_HASH };
  const { adapters, calls, getState } = fixture({ state });
  const refused = await adapters.skills.prepare({
    taskId: "bad-skill", installRoot: INSTALL_ROOT, skillsRoot: SKILLS_ROOT,
    skillIds: ["not-signed"], catalog: catalog(),
  });
  assert.equal(refused[0].status, "failed");
  await adapters.skills.uninstall({ skillsRoot: SKILLS_ROOT, skillIds: ["documents"] });
  assert.deepEqual(calls.deletedSkills.map(({ target }) => target), [path.win32.join(SKILLS_ROOT, "documents")]);
  assert.equal(Object.hasOwn(getState().skills, "documents"), false);
  assert.equal(Object.hasOwn(getState().skills, "spreadsheets"), true);
});

test("component methods always return the unified result shape and fail closed on verification errors", async () => {
  const { adapters } = fixture();
  const result = await adapters.chatgpt.commit({ taskId: "missing", desktopPath: DESKTOP });
  assert.deepEqual(Object.keys(result).sort(), [
    "action", "componentId", "message", "rollbackAvailable", "status", "versionAfter", "versionBefore",
  ]);
  assert.equal(result.status, "failed");
});

test("a forged archive receipt cannot cross the persistent version-slot boundary", async () => {
  const { adapters, calls } = fixture({ forgedArchiveReceipt: true });
  await adapters.chatgpt.prepare({ taskId: "forged-receipt", installRoot: INSTALL_ROOT, catalog: catalog() });
  const committed = await adapters.chatgpt.commit({ taskId: "forged-receipt", desktopPath: DESKTOP });
  assert.equal(committed.status, "failed");
  assert.deepEqual(calls.promotions, []);
  assert.deepEqual(calls.shortcuts, []);
});

test("V2RayN refuses promotion when its persistent configuration evidence changed", async () => {
  const { adapters, calls } = fixture({ persistentFailureAt: 1 });
  await adapters.v2rayn.prepare({ taskId: "v2-config-race", installRoot: INSTALL_ROOT, catalog: catalog() });
  const committed = await adapters.v2rayn.commit({ taskId: "v2-config-race", desktopPath: DESKTOP });
  assert.equal(committed.status, "failed");
  assert.deepEqual(calls.promotions, []);
  assert.deepEqual(calls.stopped, []);
});

test("external Git is re-discovered immediately before mutation and a changed target is blocked", async () => {
  const first = {
    kind: "external", ownership: "external", version: "2.50.0", installDir: "C:\\Git",
    executablePath: "C:\\Git\\cmd\\git.exe", uninstallerPath: "C:\\Git\\unins000.exe", registryKey: "HKLM\\Git",
  };
  const changed = { ...first, installDir: "E:\\OtherGit", executablePath: "E:\\OtherGit\\cmd\\git.exe", uninstallerPath: "E:\\OtherGit\\unins000.exe" };
  const { adapters, calls } = fixture({ gitDiscoveries: [first, changed], gitDiscovery: changed });
  await adapters.git.prepare({ taskId: "git-race", installRoot: INSTALL_ROOT, catalog: catalog(), selected: true });
  const committed = await adapters.git.commit({ taskId: "git-race" });
  assert.equal(committed.status, "failed");
  assert.equal(committed.message, "git_external_state_changed");
  assert.deepEqual(calls.gitInstalls, []);
});

test("Skill replacement fails closed when installed SKILL.md differs and does not claim ownership", async () => {
  const { adapters, calls, getState } = fixture({ skillHashes: [SKILL_HASH, "d".repeat(64)] });
  await adapters.skills.prepare({
    taskId: "skill-hash-race", installRoot: INSTALL_ROOT, skillsRoot: SKILLS_ROOT,
    skillIds: ["documents"], catalog: catalog(),
  });
  const committed = await adapters.skills.commit({
    taskId: "skill-hash-race", skillsRoot: SKILLS_ROOT, skillIds: ["documents"],
  });
  assert.equal(committed[0].status, "failed");
  assert.equal(committed[0].message, "skill_md_hash_mismatch");
  assert.equal(calls.replacedSkills.length, 1);
  assert.equal(Object.hasOwn(getState().skills, "documents"), false);
});

test("fresh ownership state inspects missing managed components without discovering external ChatGPT or V2RayN", async () => {
  const state = emptyState();
  state.installRoot = null;
  const { adapters } = fixture({ state });
  assert.equal((await adapters.chatgpt.inspectInstalled({ installRoot: INSTALL_ROOT })).status, "skipped");
  assert.equal((await adapters.v2rayn.inspectInstalled({ installRoot: INSTALL_ROOT })).status, "skipped");
});
