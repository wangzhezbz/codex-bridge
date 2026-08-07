import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import path from "node:path";
import test from "node:test";

import { createSkillFileService } from "../desktop/software-manager/skill-files.mjs";
import { createSkillSwapJournal } from "../desktop/software-manager/skill-swap-journal.mjs";
import { createTrustedCatalogService, verifyCatalogEnvelope } from "../desktop/software-manager/catalog-trust.mjs";

const SKILLS_ROOT = "C:\\Users\\tester\\.codex\\skills";
const TARGET = `${SKILLS_ROOT}\\documents`;
const SOURCE = "D:\\CBApps\\staging\\task-skill-task\\skill-documents.prepare";
const TREE = "a".repeat(64);
const MANIFEST = "b".repeat(64);
const SKILL_MD = "c".repeat(64);
const OLD_TREE = "d".repeat(64);
const OLD_MANIFEST = "e".repeat(64);
const OLD_SKILL_MD = "f".repeat(64);
const SWAP_ID = "1".repeat(32);
const INSTALL_CAPABILITY = Object.freeze(Object.create(null));
const SKILLS_CAPABILITY = Object.freeze(Object.create(null));

function trustedCatalog() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const component = (id, format, entrypoint) => ({
    id, name: id, version: "1.0.0", architecture: "x64",
    assetUrl: `/codexbridge-test/packages/${id}.${format}`,
    size: 1, sha256: "8".repeat(64), format, entrypoint, requiredFiles: [entrypoint],
    maxRelativePathLength: 80, publishedAt: "2026-08-07T00:00:00.000Z", supportsRollback: true,
  });
  const value = {
    schemaVersion: 1,
    components: [component("chatgpt", "zip", "ChatGPT.exe"), component("v2rayn", "7z", "v2rayN.exe"), component("git", "exe", "cmd/git.exe")],
    skills: [{
      id: "documents", name: "Documents", description: "fixture", version: "1.0.0",
      assetUrl: "/codexbridge-test/packages/skill-documents.zip", size: 42,
      sha256: "9".repeat(64), files: ["SKILL.md", "reference.md"],
    }],
  };
  const jsonBytes = Buffer.from(JSON.stringify(value));
  const verified = verifyCatalogEnvelope({
    jsonBytes,
    signatureText: sign("RSA-SHA256", jsonBytes, privateKey).toString("base64"),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    catalogUrl: "https://shanhaiyouling.com/codexbridge-install-test/component-catalog.json",
  });
  return createTrustedCatalogService(verified);
}

const TRUSTED_CATALOG = trustedCatalog();

function identity(fileId) {
  return { volumeSerial: "volume", fileId };
}

function evidence(fileId, overrides = {}) {
  return {
    kind: "directory",
    identity: identity(fileId),
    treeDigest: TREE,
    manifestDigest: MANIFEST,
    skillMdSha256: SKILL_MD,
    ...overrides,
  };
}

function createMemoryJournalFs(initial = {}) {
  let sequence = 0;
  const entries = new Map(Object.entries(initial).map(([name, data]) => [
    name, { name, identity: ++sequence, data },
  ]));
  const calls = [];
  let crashAfterNextUnlink = false;

  function current(entry) {
    const node = entries.get(entry.name);
    if (!node || node.identity !== entry.identity) throw Object.assign(new Error("stale"), { code: "stale_entry_identity" });
    return node;
  }

  function handle(node) {
    return {
      entry: { name: node.name, identity: node.identity },
      async readFile() { return node.data; },
      async writeFile(value) { node.data = String(value); },
      async sync() {},
      async close() {},
    };
  }

  const fsApi = {
    async openJournalDirectoryNoFollow() {
      return {
        async listFileNamesNoFollow() { return [...entries.keys()]; },
        async openFileNoFollow(name, flags) {
          if (flags === "r") return entries.has(name) ? handle(entries.get(name)) : null;
          if (flags !== "wx" || entries.has(name)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
          const node = { name, identity: ++sequence, data: "" };
          entries.set(name, node);
          return handle(node);
        },
        async unlinkEntryNoFollow(entry) {
          calls.push(["unlink", entry.name]);
          current(entry);
          entries.delete(entry.name);
          if (crashAfterNextUnlink) {
            crashAfterNextUnlink = false;
            throw new Error("test_crash_after_journal_unlink");
          }
        },
        async renameEntryNoFollow(entry, destinationName) {
          calls.push(["rename", entry.name, destinationName]);
          const node = current(entry);
          if (entries.has(destinationName)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
          entries.delete(entry.name);
          node.name = destinationName;
          entries.set(destinationName, node);
        },
        async close() {},
      };
    },
  };
  return {
    fsApi,
    calls,
    entries,
    crashAfterUnlink() { crashAfterNextUnlink = true; },
    replace(name, data) { entries.set(name, { name, identity: ++sequence, data }); },
  };
}

function createFakeSkillCapabilities({ existing = null } = {}) {
  const rootIdentity = identity("skills-root");
  const sourceEvidence = evidence("source");
  const trees = new Map();
  if (existing) trees.set("documents", structuredClone(existing));
  const calls = [];
  let preparedSequence = 0;
  const sourceReceipts = new WeakMap();
  const sourceProof = Object.freeze(Object.create(null));
  sourceReceipts.set(sourceProof, { path: SOURCE, identity: identity("source"), evidence: sourceEvidence });

  function inspect(name) {
    const value = trees.get(name);
    return value ? structuredClone(value) : { kind: "absent" };
  }

  function specName(spec) {
    if (spec.kind === "target") return spec.skillId;
    return `.codexbridge-${spec.kind === "prepared" ? "new" : "old"}-${spec.skillId}-${spec.swapId}`;
  }

  const fileCapabilities = {
    async verifyPreparedSkillNoFollow({ sourceProof: suppliedProof, installRootCapability, requiredFiles, expectedPackageSha256 }) {
      assert.equal(installRootCapability, INSTALL_CAPABILITY);
      const source = sourceReceipts.get(suppliedProof);
      if (!source) throw new Error("skill_source_proof_invalid");
      assert.deepEqual(requiredFiles, ["SKILL.md", "reference.md"]);
      assert.equal(expectedPackageSha256, "9".repeat(64));
      const receipt = Object.freeze(Object.create(null));
      sourceReceipts.set(receipt, source);
      return { verificationReceipt: receipt, evidence: structuredClone(sourceEvidence), sourcePath: source.path };
    },
    async openSkillRootNoFollow({ installRootCapability, skillsRootCapability }) {
      assert.equal(installRootCapability, INSTALL_CAPABILITY);
      assert.equal(skillsRootCapability, SKILLS_CAPABILITY);
      return {
        rootPath: SKILLS_ROOT,
        rootIdentity: structuredClone(rootIdentity),
        async inspectDirectChildNoFollow(spec) {
          const name = specName(spec);
          calls.push(["inspect", name]);
          return inspect(name);
        },
        async stagePreparedTreeNoFollow({ sourceProof: verificationReceipt, skillId, swapId, expected }) {
          const destinationName = specName({ kind: "prepared", skillId, swapId });
          calls.push(["stage", SOURCE, destinationName]);
          const source = sourceReceipts.get(verificationReceipt);
          if (!source) throw new Error("skill_source_receipt_invalid");
          if (trees.has(destinationName)) throw new Error("skill_destination_exists");
          const staged = evidence(`prepared-${++preparedSequence}`);
          assert.equal(staged.treeDigest, expected.treeDigest);
          trees.set(destinationName, staged);
          return structuredClone(staged);
        },
        async recoverPreparedTreeNoFollow({ taskId, sourceIdentity, skillId, swapId, expected }) {
          const destinationName = specName({ kind: "prepared", skillId, swapId });
          calls.push(["recover-stage", SOURCE, destinationName]);
          assert.equal(taskId, "skill-task");
          assert.deepEqual(sourceIdentity, identity("source"));
          if (!trees.has(destinationName)) trees.set(destinationName, evidence(`prepared-${++preparedSequence}`));
          const staged = trees.get(destinationName);
          assert.equal(staged.treeDigest, expected.treeDigest);
          return structuredClone(staged);
        },
        async renameDirectChildNoReplace({ from, to, expectedIdentity }) {
          const fromName = specName(from);
          const destinationName = specName(to);
          calls.push(["rename", fromName, destinationName]);
          const value = trees.get(fromName);
          if (!value || trees.has(destinationName) || JSON.stringify(value.identity) !== JSON.stringify(expectedIdentity)) {
            throw new Error("skill_rename_identity_mismatch");
          }
          trees.delete(fromName);
          trees.set(destinationName, value);
          return structuredClone(value);
        },
        async deleteDirectChildTreeNoFollow({ child, expectedEvidence }) {
          const name = specName(child);
          calls.push(["delete", name]);
          const value = trees.get(name);
          if (!value || JSON.stringify(value) !== JSON.stringify(expectedEvidence)) throw new Error("skill_delete_identity_mismatch");
          trees.delete(name);
        },
        async close() {},
      };
    },
  };
  const stagingReceipt = Object.freeze(Object.create(null));
  const packageProof = Object.freeze(Object.create(null));
  const workspace = {
    async sealSkillStaging(suppliedStaging, suppliedPackage, context) {
      assert.equal(suppliedStaging, stagingReceipt);
      assert.equal(suppliedPackage, packageProof);
      assert.deepEqual(context, { skillId: "documents", expectedVersion: "1.0.0" });
      return { sourceProof, evidence: structuredClone(sourceEvidence) };
    },
  };
  return {
    fileCapabilities, calls, trees, inspect, sourceReceipts, sourceProof,
    stagingReceipt, packageProof, workspace,
  };
}

function createFixture({ existing = null, crashAfterPhase = null } = {}) {
  const memory = createMemoryJournalFs();
  const durableJournal = createSkillSwapJournal({
    journalDir: "D:\\CBState\\skill-swaps",
    fsApi: memory.fsApi,
    skillsRoot: SKILLS_ROOT,
  });
  let crashed = false;
  const journal = crashAfterPhase === null ? durableJournal : Object.freeze({
    ...durableJournal,
    async record(record) {
      const result = await durableJournal.record(record);
      if (!crashed && record.phase === crashAfterPhase) {
        crashed = true;
        throw new Error(`test_crash_after_${crashAfterPhase}`);
      }
      return result;
    },
  });
  const capabilities = createFakeSkillCapabilities({ existing });
  const service = createSkillFileService({
    fileCapabilities: capabilities.fileCapabilities,
    installRootCapability: INSTALL_CAPABILITY,
    skillsRootCapability: SKILLS_CAPABILITY,
    catalogService: TRUSTED_CATALOG,
    workspace: capabilities.workspace,
    swapJournal: journal,
    hashFile: async () => { throw new Error("raw_path_hash_forbidden"); },
  });
  return { memory, journal, capabilities, service };
}

async function prepare(service, sourceProof) {
  return service.verifyPreparedSkill({
    skillId: "documents",
    expectedVersion: "1.0.0",
    stagingReceipt: sourceProof.stagingReceipt,
    packageProof: sourceProof.packageProof,
  });
}

function replacementPlan(verified, previousEvidence = { kind: "absent" }) {
  return {
    taskId: "skill-task",
    swapId: SWAP_ID,
    source: SOURCE,
    target: TARGET,
    authorizedRoot: SKILLS_ROOT,
    backup: false,
    verificationReceipt: verified.verificationReceipt,
    treeDigest: TREE,
    manifestDigest: MANIFEST,
    skillMdSha256: SKILL_MD,
    requiredFiles: ["SKILL.md", "reference.md"],
    previousEvidence,
  };
}

test("Skill swap journal rejects extra, legacy, and foreign records without deleting anything", async () => {
  const memory = createMemoryJournalFs();
  const journal = createSkillSwapJournal({
    journalDir: "D:\\CBState\\skill-swaps",
    fsApi: memory.fsApi,
    skillsRoot: SKILLS_ROOT,
  });
  const record = {
    schemaVersion: 1,
    phase: "reserved",
    taskId: "skill-task",
    swapId: SWAP_ID,
    skillId: "documents",
    skillsRoot: SKILLS_ROOT,
    target: TARGET,
    sourcePath: SOURCE,
    preparedPath: `${SKILLS_ROOT}\\.codexbridge-new-documents-${SWAP_ID}`,
    oldPath: `${SKILLS_ROOT}\\.codexbridge-old-documents-${SWAP_ID}`,
    identities: { root: identity("skills-root"), source: identity("source"), prepared: null, old: null, new: null },
    previousEvidence: { kind: "absent" },
    expectedEvidence: { treeDigest: TREE, manifestDigest: MANIFEST, skillMdSha256: SKILL_MD, requiredFiles: ["SKILL.md", "reference.md"] },
  };
  await journal.record(record);
  const stored = [...memory.entries.entries()].find(([name]) => name.endsWith(".reserved.json"));
  assert.ok(stored);
  memory.replace(stored[0], JSON.stringify({ ...record, surprise: true }));
  await assert.rejects(journal.load({ taskId: record.taskId, swapId: record.swapId }), /skill_swap_record_invalid/u);
  assert.equal(memory.calls.some(([operation]) => operation === "unlink"), false);
});

test("Skill swap journal resumes an interrupted cleanup from the exact cleanup-committed suffix", async () => {
  const memory = createMemoryJournalFs();
  const journal = createSkillSwapJournal({
    journalDir: "D:\\CBState\\skill-swaps",
    fsApi: memory.fsApi,
    skillsRoot: SKILLS_ROOT,
  });
  const base = {
    schemaVersion: 1,
    taskId: "skill-task",
    swapId: SWAP_ID,
    skillId: "documents",
    skillsRoot: SKILLS_ROOT,
    target: TARGET,
    sourcePath: SOURCE,
    preparedPath: `${SKILLS_ROOT}\\.codexbridge-new-documents-${SWAP_ID}`,
    oldPath: `${SKILLS_ROOT}\\.codexbridge-old-documents-${SWAP_ID}`,
    previousEvidence: { kind: "absent" },
    expectedEvidence: {
      treeDigest: TREE, manifestDigest: MANIFEST, skillMdSha256: SKILL_MD,
      requiredFiles: ["SKILL.md", "reference.md"],
    },
  };
  await journal.record({
    ...base,
    phase: "reserved",
    identities: { root: identity("skills-root"), source: identity("source"), prepared: null, old: null, new: null },
  });
  const completeIdentities = {
    root: identity("skills-root"), source: identity("source"),
    prepared: identity("prepared"), old: null, new: identity("prepared"),
  };
  for (const phase of ["prepared", "old_moved", "new_published", "proof_written", "cleanup_committed"]) {
    await journal.record({ ...base, phase, identities: completeIdentities });
  }
  memory.crashAfterUnlink();
  await assert.rejects(journal.clear({ taskId: "skill-task", swapId: SWAP_ID }), /test_crash_after_journal_unlink/u);
  const recovered = await journal.load({ taskId: "skill-task", swapId: SWAP_ID });
  assert.equal(recovered.snapshot.phase, "cleanup_committed");
  assert.equal(recovered.records[0].phase, "prepared");
  assert.equal(await journal.clear({ taskId: "skill-task", swapId: SWAP_ID }), true);
  assert.equal(await journal.load({ taskId: "skill-task", swapId: SWAP_ID }), null);
});

test("new Skill install publishes exact evidence and never touches an unrelated Skill", async () => {
  const { service, capabilities } = createFixture({ existing: null });
  capabilities.trees.set("pdf", evidence("pdf", { treeDigest: OLD_TREE }));
  const verified = await prepare(service, capabilities);
  const replacement = await service.replaceExact(replacementPlan(verified));
  const completed = await service.finalizeReplacement({
    completionReceipt: replacement.completionReceipt,
    target: TARGET,
    taskId: "skill-task",
    swapId: SWAP_ID,
    expected: { treeDigest: TREE, manifestDigest: MANIFEST, skillMdSha256: SKILL_MD },
  });
  assert.deepEqual(completed.evidence, capabilities.inspect("documents"));
  assert.equal(capabilities.inspect("pdf").identity.fileId, "pdf");
  assert.equal(capabilities.calls.some(([operation, name]) => operation === "delete" && name === "pdf"), false);
});

test("same-name Skill replacement moves old, publishes new, and deletes only the journal-bound old tree", async () => {
  const old = evidence("old", { treeDigest: OLD_TREE, manifestDigest: OLD_MANIFEST, skillMdSha256: OLD_SKILL_MD });
  const { service, capabilities } = createFixture({ existing: old });
  const verified = await prepare(service, capabilities);
  const replacement = await service.replaceExact(replacementPlan(verified, old));
  await service.finalizeReplacement({
    completionReceipt: replacement.completionReceipt,
    target: TARGET,
    taskId: "skill-task",
    swapId: SWAP_ID,
    expected: { treeDigest: TREE, manifestDigest: MANIFEST, skillMdSha256: SKILL_MD },
  });
  assert.deepEqual(capabilities.inspect("documents"), evidence("prepared-1"));
  assert.deepEqual(capabilities.calls.filter(([operation]) => operation === "delete").map((call) => call[1]), [
    `.codexbridge-old-documents-${SWAP_ID}`,
  ]);
});

for (const phase of ["reserved", "prepared", "old_moved", "new_published", "proof_written"]) {
  test(`Skill replacement reconciliation recovers exact ${phase} phase`, async () => {
    const old = evidence("old", { treeDigest: OLD_TREE, manifestDigest: OLD_MANIFEST, skillMdSha256: OLD_SKILL_MD });
    const fixture = createFixture({ existing: old, crashAfterPhase: phase });
    const verified = await prepare(fixture.service, fixture.capabilities);
    const plan = replacementPlan(verified, old);
    if (phase === "proof_written") {
      const replacement = await fixture.service.replaceExact(plan);
      await assert.rejects(fixture.service.finalizeReplacement({
        completionReceipt: replacement.completionReceipt,
        target: TARGET,
        taskId: "skill-task",
        swapId: SWAP_ID,
        expected: { treeDigest: TREE, manifestDigest: MANIFEST, skillMdSha256: SKILL_MD },
      }), new RegExp(`test_crash_after_${phase}`));
    } else {
      await assert.rejects(
        fixture.service.replaceExact(plan),
        new RegExp(`test_crash_after_${phase}`),
      );
    }
    const restarted = createSkillFileService({
      fileCapabilities: fixture.capabilities.fileCapabilities,
      installRootCapability: INSTALL_CAPABILITY,
      skillsRootCapability: SKILLS_CAPABILITY,
      catalogService: TRUSTED_CATALOG,
      workspace: fixture.capabilities.workspace,
      swapJournal: fixture.journal,
      hashFile: async () => { throw new Error("raw_path_hash_forbidden"); },
    });
    const reconciled = await restarted.reconcileReplacement({
      taskId: "skill-task",
      swapId: SWAP_ID,
      target: TARGET,
      expected: { treeDigest: TREE, manifestDigest: MANIFEST, skillMdSha256: SKILL_MD },
    });
    assert.equal(reconciled.status, "completed");
    assert.equal((await restarted.inspectExact({ target: TARGET, authorizedRoot: SKILLS_ROOT })).treeDigest, TREE);
  });
}

test("ambiguous identity during recovery fails closed and deletes no tree", async () => {
  const old = evidence("old", { treeDigest: OLD_TREE, manifestDigest: OLD_MANIFEST, skillMdSha256: OLD_SKILL_MD });
  const fixture = createFixture({ existing: old, crashAfterPhase: "old_moved" });
  const verified = await prepare(fixture.service, fixture.capabilities);
  await assert.rejects(
    fixture.service.replaceExact(replacementPlan(verified, old)),
    /test_crash_after_old_moved/u,
  );
  fixture.capabilities.trees.set("documents", evidence("foreign", { treeDigest: OLD_TREE }));
  const deletesBefore = fixture.capabilities.calls.filter(([operation]) => operation === "delete").length;
  await assert.rejects(fixture.service.reconcileReplacement({
    taskId: "skill-task",
    swapId: SWAP_ID,
    target: TARGET,
    expected: { treeDigest: TREE, manifestDigest: MANIFEST, skillMdSha256: SKILL_MD },
  }), /skill_swap_ambiguous/u);
  assert.equal(fixture.capabilities.calls.filter(([operation]) => operation === "delete").length, deletesBefore);
});

test("exact uninstall rejects a foreign identity and preserves sibling Skills", async () => {
  const owned = evidence("owned");
  const { service, capabilities } = createFixture({ existing: owned });
  capabilities.trees.set("pdf", evidence("pdf"));
  await assert.rejects(service.deleteExact({
    target: TARGET,
    authorizedRoot: SKILLS_ROOT,
    expectedEvidence: evidence("foreign"),
  }), /skill_delete_identity_mismatch/u);
  assert.equal(capabilities.inspect("documents").identity.fileId, "owned");
  assert.equal(capabilities.inspect("pdf").identity.fileId, "pdf");
});

test("prepared tree verification requires exact SKILL.md and full manifest evidence", async () => {
  const capabilities = createFakeSkillCapabilities();
  capabilities.fileCapabilities.verifyPreparedSkillNoFollow = async () => ({
    verificationReceipt: Object.freeze(Object.create(null)),
    sourcePath: SOURCE,
    evidence: { ...evidence("source"), skillMdSha256: null },
  });
  const service = createSkillFileService({
    fileCapabilities: capabilities.fileCapabilities,
    installRootCapability: INSTALL_CAPABILITY,
    skillsRootCapability: SKILLS_CAPABILITY,
    catalogService: TRUSTED_CATALOG,
    workspace: capabilities.workspace,
    swapJournal: createSkillSwapJournal({
      journalDir: "D:\\CBState\\skill-swaps",
      fsApi: createMemoryJournalFs().fsApi,
      skillsRoot: SKILLS_ROOT,
    }),
    hashFile: async () => { throw new Error("raw_path_hash_forbidden"); },
  });
  await assert.rejects(prepare(service, capabilities), /skill_prepared_evidence_invalid/u);
});
