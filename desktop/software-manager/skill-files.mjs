import path from "node:path";
import { isTrustedCatalogService } from "./catalog-trust.mjs";
import { readInstallRootCapability } from "./path-policy.mjs";

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SWAP_ID = /^[a-f0-9]{32}$/u;
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function skillError(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function plain(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value, keys) {
  return plain(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function canonical(value, code = "skill_path_invalid") {
  if (typeof value !== "string" || !/^[A-Za-z]:\\/u.test(value) || value.includes("/")
    || value.includes("\0") || path.win32.normalize(value) !== value) throw skillError(code);
  const segments = value.slice(3).split("\\");
  if (segments.some((segment) => !segment || segment === "." || segment === ".."
    || /[<>:"|?*\u0000-\u001f]/u.test(segment) || /[ .]$/u.test(segment))) throw skillError(code);
  return value;
}

function publicIdentity(value, nullable = false) {
  if (nullable && value === null) return null;
  if (!exact(value, ["volumeSerial", "fileId"])
    || typeof value.volumeSerial !== "string" || value.volumeSerial.length === 0
    || typeof value.fileId !== "string" || value.fileId.length === 0) {
    throw skillError("skill_identity_invalid");
  }
  return { volumeSerial: value.volumeSerial, fileId: value.fileId };
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.volumeSerial === right.volumeSerial && left.fileId === right.fileId);
}

function directoryEvidence(value, code = "skill_tree_evidence_invalid", allowAbsent = false) {
  if (allowAbsent && exact(value, ["kind"]) && value.kind === "absent") return { kind: "absent" };
  if (!exact(value, ["kind", "identity", "treeDigest", "manifestDigest", "skillMdSha256"])
    || value.kind !== "directory" || !SHA256.test(value.treeDigest ?? "")
    || !SHA256.test(value.manifestDigest ?? "") || !SHA256.test(value.skillMdSha256 ?? "")) {
    throw skillError(code);
  }
  return { ...structuredClone(value), identity: publicIdentity(value.identity) };
}

function sameEvidence(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function expectedEvidence(value, requiredFiles = undefined) {
  const keys = requiredFiles === undefined
    ? ["treeDigest", "manifestDigest", "skillMdSha256"]
    : ["treeDigest", "manifestDigest", "skillMdSha256", "requiredFiles"];
  if (!exact(value, keys) || !SHA256.test(value.treeDigest ?? "")
    || !SHA256.test(value.manifestDigest ?? "") || !SHA256.test(value.skillMdSha256 ?? "")) {
    throw skillError("skill_expected_evidence_invalid");
  }
  const result = {
    treeDigest: value.treeDigest,
    manifestDigest: value.manifestDigest,
    skillMdSha256: value.skillMdSha256,
  };
  if (requiredFiles !== undefined) result.requiredFiles = normalizeRequiredFiles(value.requiredFiles);
  return result;
}

function evidenceMatches(value, expected) {
  return value?.kind === "directory"
    && value.treeDigest === expected.treeDigest
    && value.manifestDigest === expected.manifestDigest
    && value.skillMdSha256 === expected.skillMdSha256;
}

function normalizeRequiredFiles(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4_096) {
    throw skillError("skill_required_files_invalid");
  }
  const result = value.map((item) => {
    if (typeof item !== "string" || item.length === 0 || item !== item.normalize("NFC")
      || item.includes("\\") || item.startsWith("/")
      || item.split("/").some((part) => !part || part === "." || part === "..")) {
      throw skillError("skill_required_files_invalid");
    }
    return item;
  });
  if (!result.includes("SKILL.md") || new Set(result).size !== result.length) {
    throw skillError("skill_required_files_invalid");
  }
  return result;
}

function requireCapabilities(value) {
  if (!value || typeof value.verifyPreparedSkillNoFollow !== "function"
    || typeof value.openSkillRootNoFollow !== "function"
    || typeof value.inspectPreparedSkillSourceNoFollow !== "function"
    || typeof value.validatePreparedSkillSourceForDeletionNoFollow !== "function"
    || typeof value.deletePreparedSkillSourceNoFollow !== "function") {
    throw skillError("skill_file_capabilities_required");
  }
  return value;
}

function requirePrepareJournal(value) {
  if (!value || typeof value.record !== "function" || typeof value.load !== "function"
    || typeof value.list !== "function" || typeof value.clear !== "function") {
    throw skillError("skill_prepare_journal_required");
  }
  return value;
}

function requireJournal(value) {
  if (!value || typeof value.record !== "function" || typeof value.load !== "function"
    || typeof value.clear !== "function") throw skillError("skill_swap_journal_required");
  return value;
}

function requireWorkspace(value) {
  if (!value || typeof value.sealSkillStaging !== "function") {
    throw skillError("skill_workspace_required");
  }
  return value;
}

function requireSession(value) {
  const methods = [
    "inspectDirectChildNoFollow", "stagePreparedTreeNoFollow", "recoverPreparedTreeNoFollow",
    "renameDirectChildNoReplace", "deleteDirectChildTreeNoFollow", "close",
  ];
  if (!value || typeof value.rootPath !== "string" || !value.rootIdentity
    || methods.some((method) => typeof value[method] !== "function")) {
    throw skillError("skill_root_capability_invalid");
  }
  return value;
}

function targetParts(target, root) {
  const canonicalRoot = canonical(root, "skill_root_invalid");
  const canonicalTarget = canonical(target, "skill_target_invalid");
  if (path.win32.dirname(canonicalTarget) !== canonicalRoot) throw skillError("skill_target_invalid");
  const skillId = path.win32.basename(canonicalTarget);
  if (!SKILL_ID.test(skillId)) throw skillError("skill_target_invalid");
  return { root: canonicalRoot, target: canonicalTarget, skillId };
}

function proofFor({ taskId, swapId, target, evidence }) {
  return {
    schemaVersion: 1,
    taskId,
    swapId,
    target,
    identity: structuredClone(evidence.identity),
    treeDigest: evidence.treeDigest,
    manifestDigest: evidence.manifestDigest,
    skillMdSha256: evidence.skillMdSha256,
  };
}

function validateProof(value) {
  if (!exact(value, [
    "schemaVersion", "taskId", "swapId", "target", "identity", "treeDigest", "manifestDigest", "skillMdSha256",
  ]) || value.schemaVersion !== 1 || !TASK_ID.test(value.taskId ?? "") || !SWAP_ID.test(value.swapId ?? "")
    || !SHA256.test(value.treeDigest ?? "") || !SHA256.test(value.manifestDigest ?? "")
    || !SHA256.test(value.skillMdSha256 ?? "")) throw skillError("skill_completion_proof_invalid");
  return { ...structuredClone(value), target: canonical(value.target), identity: publicIdentity(value.identity) };
}

export function createPreparedSkillRecovery({
  fileCapabilities, installRootCapability, prepareJournal, prepareLeaseStore,
} = {}) {
  const files = requireCapabilities(fileCapabilities);
  const preparedJournal = requirePrepareJournal(prepareJournal);
  if (!installRootCapability || typeof installRootCapability !== "object") {
    throw skillError("skill_root_capabilities_required");
  }
  readInstallRootCapability(installRootCapability);
  if (!prepareLeaseStore || typeof prepareLeaseStore.acquireOperationLease !== "function") {
    throw skillError("skill_prepare_lease_capability_required");
  }
  async function discardOne(taskId, skillId) {
    const transaction = await preparedJournal.load({ taskId, skillId });
    if (!transaction) return false;
    let record = transaction.snapshot;
    if (["bound", "sealed"].includes(record.phase)) {
      const validated = await files.validatePreparedSkillSourceForDeletionNoFollow({
        installRootCapability, taskId, skillId,
        expectedIdentity: record.identity, expectedEvidence: record.evidence,
      });
      if (!plain(validated) || !["absent", "directory"].includes(validated.kind)
        || validated.sourcePath !== record.sourcePath
        || (validated.kind === "directory" && !sameIdentity(validated.identity, record.identity))) {
        throw skillError("skill_prepare_delete_validation_invalid");
      }
      record = await preparedJournal.record({ ...record, phase: "deleting" });
    }
    await files.deletePreparedSkillSourceNoFollow({
      installRootCapability, taskId, skillId,
      expectedIdentity: record.identity, expectedEvidence: null,
    });
    await preparedJournal.clear({ taskId, skillId });
    return true;
  }
  return Object.freeze({
    async reconcilePreparedSources() {
      const records = await preparedJournal.list({
        claimLease: ({ nonce, scope }) => prepareLeaseStore.acquireOperationLease({ nonce, scope, wait: false }),
      });
      let recovered = 0;
      for (const record of records) {
        const lease = await prepareLeaseStore.acquireOperationLease({
          nonce: record.leaseNonce, scope: record.leaseScope, wait: false,
        });
        if (lease === null) continue;
        try { await discardOne(record.taskId, record.skillId); recovered += 1; }
        finally { await lease.release(); }
      }
      return recovered;
    },
  });
}

export function createSkillFileService({
  fileCapabilities, installRootCapability, skillsRootCapability, catalogService, workspace,
  swapJournal, prepareJournal, prepareLeaseStore, hashFile, recoveryOnly = false,
} = {}) {
  if (typeof recoveryOnly !== "boolean") throw skillError("skill_recovery_mode_invalid");
  const files = requireCapabilities(fileCapabilities);
  const journal = requireJournal(swapJournal);
  const preparedJournal = requirePrepareJournal(prepareJournal);
  if (!prepareLeaseStore || typeof prepareLeaseStore.acquireOperationLease !== "function") {
    throw skillError("skill_prepare_lease_capability_required");
  }
  const stagingWorkspace = recoveryOnly ? null : requireWorkspace(workspace);
  if (!recoveryOnly && !isTrustedCatalogService(catalogService)) throw skillError("trusted_catalog_service_required");
  if (!installRootCapability || typeof installRootCapability !== "object"
    || !skillsRootCapability || typeof skillsRootCapability !== "object") {
    throw skillError("skill_root_capabilities_required");
  }
  const installRoot = readInstallRootCapability(installRootCapability);
  if (!recoveryOnly && typeof hashFile !== "function") throw skillError("skill_hash_capability_required");
  const verificationReceipts = new WeakMap();
  const completionReceipts = new WeakMap();

  function preparedSourcePath(taskId, skillId) {
    return path.win32.join(installRoot, "staging", `task-${taskId}`, `skill-${skillId}.prepare`);
  }

  async function beginPreparedSource(raw = {}) {
    if (!isTrustedCatalogService(catalogService)) throw skillError("trusted_catalog_service_required");
    if (!exact(raw, ["taskId", "skillId", "leaseScope", "leaseNonce"])
      || !TASK_ID.test(raw.taskId ?? "") || !SKILL_ID.test(raw.skillId ?? "")
      || raw.leaseScope !== "prepare" || !SWAP_ID.test(raw.leaseNonce ?? "")) {
      throw skillError("skill_prepare_request_invalid");
    }
    catalogService.getSkill(raw.skillId);
    return preparedJournal.record({
      schemaVersion: 1,
      phase: "intent",
      taskId: raw.taskId,
      skillId: raw.skillId,
      installRoot,
      sourcePath: preparedSourcePath(raw.taskId, raw.skillId),
      leaseScope: raw.leaseScope,
      leaseNonce: raw.leaseNonce,
      identity: null,
      evidence: null,
    });
  }

  async function bindPreparedSource(raw = {}) {
    if (!exact(raw, ["taskId", "skillId"]) || !TASK_ID.test(raw.taskId ?? "")
      || !SKILL_ID.test(raw.skillId ?? "")) throw skillError("skill_prepare_request_invalid");
    const transaction = await preparedJournal.load(raw);
    if (!transaction || transaction.snapshot.phase !== "intent") throw skillError("skill_prepare_intent_missing");
    const inspected = await files.inspectPreparedSkillSourceNoFollow({
      installRootCapability, taskId: raw.taskId, skillId: raw.skillId,
    });
    if (!exact(inspected, ["kind", "identity", "sourcePath"]) || inspected.kind !== "empty"
      || inspected.sourcePath !== transaction.snapshot.sourcePath) {
      throw skillError("skill_prepare_source_not_empty");
    }
    const sourceIdentity = publicIdentity(inspected.identity);
    return preparedJournal.record({
      ...transaction.snapshot,
      phase: "bound",
      identity: sourceIdentity,
      evidence: null,
    });
  }

  async function discardOnePrepared(taskId, skillId) {
    const transaction = await preparedJournal.load({ taskId, skillId });
    if (!transaction) return false;
    let record = transaction.snapshot;
    if (["bound", "sealed"].includes(record.phase)) {
      const validated = await files.validatePreparedSkillSourceForDeletionNoFollow({
        installRootCapability,
        taskId,
        skillId,
        expectedIdentity: record.identity,
        expectedEvidence: record.evidence,
      });
      if (!plain(validated) || !["absent", "directory"].includes(validated.kind)
        || validated.sourcePath !== record.sourcePath
        || (validated.kind === "directory" && !sameIdentity(validated.identity, record.identity))) {
        throw skillError("skill_prepare_delete_validation_invalid");
      }
      record = await preparedJournal.record({ ...record, phase: "deleting" });
    }
    await files.deletePreparedSkillSourceNoFollow({
      installRootCapability,
      taskId,
      skillId,
      expectedIdentity: record.identity,
      expectedEvidence: null,
    });
    await preparedJournal.clear({ taskId, skillId });
    return true;
  }

  async function discardPrepared(raw = {}) {
    if (!exact(raw, ["taskId", "skillIds"]) || !TASK_ID.test(raw.taskId ?? "")
      || !Array.isArray(raw.skillIds) || new Set(raw.skillIds).size !== raw.skillIds.length
      || raw.skillIds.some((skillId) => !SKILL_ID.test(skillId))) {
      throw skillError("skill_prepare_discard_invalid");
    }
    const results = [];
    for (const skillId of raw.skillIds) results.push(await discardOnePrepared(raw.taskId, skillId));
    return results;
  }

  async function reconcilePreparedSources() {
    const records = await preparedJournal.list({
      claimLease: ({ nonce, scope }) => prepareLeaseStore.acquireOperationLease({
        nonce, scope, wait: false,
      }),
    });
    let recovered = 0;
    for (const record of records) {
      const lease = await prepareLeaseStore.acquireOperationLease({
        nonce: record.leaseNonce, scope: record.leaseScope, wait: false,
      });
      if (lease === null) continue;
      try {
        await discardOnePrepared(record.taskId, record.skillId);
        recovered += 1;
      } finally {
        await lease.release();
      }
    }
    return recovered;
  }

  async function openRoot(authorizedRoot) {
    if (!skillsRootCapability || typeof skillsRootCapability !== "object") {
      throw skillError("skill_root_capabilities_required");
    }
    const root = canonical(authorizedRoot, "skill_root_invalid");
    const session = requireSession(await files.openSkillRootNoFollow({
      installRootCapability, skillsRootCapability,
    }));
    if (session.rootPath !== root) {
      await session.close().catch(() => {});
      throw skillError("skill_root_identity_mismatch");
    }
    publicIdentity(session.rootIdentity);
    return session;
  }

  async function verifyPreparedSkill(raw) {
    if (!isTrustedCatalogService(catalogService)) throw skillError("trusted_catalog_service_required");
    if (stagingWorkspace === null) throw skillError("skill_workspace_required");
    if (!exact(raw, ["taskId", "skillId", "expectedVersion", "stagingReceipt", "packageProof"])
      || !TASK_ID.test(raw.taskId ?? "")
      || raw.stagingReceipt === null || typeof raw.stagingReceipt !== "object"
      || raw.packageProof === null || typeof raw.packageProof !== "object") {
      throw skillError("skill_prepared_plan_invalid");
    }
    const entry = catalogService.getSkill(raw.skillId);
    if (raw.expectedVersion !== entry.version) throw skillError("skill_catalog_version_mismatch");
    const preparedTransaction = await preparedJournal.load({ taskId: raw.taskId, skillId: entry.id });
    if (!preparedTransaction || preparedTransaction.snapshot.phase !== "bound") {
      throw skillError("skill_prepare_source_unbound");
    }
    const requiredFiles = normalizeRequiredFiles([...entry.files]);
    const sealed = await stagingWorkspace.sealSkillStaging(
      raw.stagingReceipt,
      raw.packageProof,
      { skillId: entry.id, expectedVersion: entry.version },
    );
    if (!plain(sealed) || sealed.sourceProof === null || typeof sealed.sourceProof !== "object") {
      throw skillError("skill_source_proof_invalid");
    }
    const verified = await files.verifyPreparedSkillNoFollow({
      sourceProof: sealed.sourceProof,
      installRootCapability,
      requiredFiles,
      expectedPackageSha256: entry.sha256,
    });
    if (!plain(verified) || verified.verificationReceipt === null
      || typeof verified.verificationReceipt !== "object") {
      throw skillError("skill_prepared_evidence_invalid");
    }
    const sourcePath = canonical(verified.sourcePath, "skill_prepared_evidence_invalid");
    const evidence = directoryEvidence(verified.evidence, "skill_prepared_evidence_invalid");
    if (sourcePath !== preparedTransaction.snapshot.sourcePath
      || !sameIdentity(evidence.identity, preparedTransaction.snapshot.identity)) {
      throw skillError("skill_prepared_identity_changed");
    }
    if (sealed.evidence !== undefined
      && !sameEvidence(directoryEvidence(sealed.evidence, "skill_prepared_evidence_invalid"), evidence)) {
      throw skillError("skill_prepared_evidence_invalid");
    }
    const receipt = Object.freeze(Object.create(null));
    await preparedJournal.record({
      ...preparedTransaction.snapshot,
      phase: "sealed",
      evidence,
    });
    verificationReceipts.set(receipt, {
      sourcePath,
      sourceIdentity: evidence.identity,
      evidence,
      requiredFiles,
      packageSha256: entry.sha256,
      taskId: raw.taskId,
      skillId: entry.id,
      capabilityReceipt: verified.verificationReceipt,
      state: "issued",
    });
    return Object.freeze({
      verificationReceipt: receipt,
      treeDigest: evidence.treeDigest,
      manifestDigest: evidence.manifestDigest,
      skillMdSha256: evidence.skillMdSha256,
    });
  }

  function replacementPlan(raw) {
    const keys = [
      "taskId", "swapId", "source", "target", "authorizedRoot", "backup", "verificationReceipt",
      "treeDigest", "manifestDigest", "skillMdSha256", "requiredFiles", "previousEvidence",
    ];
    if (!exact(raw, keys) || !TASK_ID.test(raw.taskId ?? "") || !SWAP_ID.test(raw.swapId ?? "")
      || raw.backup !== false || raw.verificationReceipt === null || typeof raw.verificationReceipt !== "object") {
      throw skillError("skill_replace_plan_invalid");
    }
    const parts = targetParts(raw.target, raw.authorizedRoot);
    const source = canonical(raw.source, "skill_source_path_invalid");
    const expected = expectedEvidence({
      treeDigest: raw.treeDigest,
      manifestDigest: raw.manifestDigest,
      skillMdSha256: raw.skillMdSha256,
      requiredFiles: raw.requiredFiles,
    }, true);
    const previousEvidence = directoryEvidence(raw.previousEvidence, "skill_previous_evidence_invalid", true);
    const receipt = verificationReceipts.get(raw.verificationReceipt);
    if (!receipt || receipt.state !== "issued" || receipt.sourcePath !== source
      || receipt.taskId !== raw.taskId || receipt.skillId !== parts.skillId
      || receipt.packageSha256.length !== 64 || !evidenceMatches(receipt.evidence, expected)
      || JSON.stringify(receipt.requiredFiles) !== JSON.stringify(expected.requiredFiles)) {
      throw skillError("skill_source_receipt_invalid");
    }
    return { ...parts, taskId: raw.taskId, swapId: raw.swapId, source, expected, previousEvidence, receipt };
  }

  function journalRecord(plan, session, phase, identities) {
    return {
      schemaVersion: 1,
      phase,
      taskId: plan.taskId,
      swapId: plan.swapId,
      skillId: plan.skillId,
      skillsRoot: plan.root,
      target: plan.target,
      sourcePath: plan.source,
      preparedPath: path.win32.join(plan.root, `.codexbridge-new-${plan.skillId}-${plan.swapId}`),
      oldPath: path.win32.join(plan.root, `.codexbridge-old-${plan.skillId}-${plan.swapId}`),
      identities: {
        root: publicIdentity(session.rootIdentity),
        source: structuredClone(plan.receipt.sourceIdentity),
        prepared: identities.prepared,
        old: plan.previousEvidence.kind === "directory" ? structuredClone(plan.previousEvidence.identity) : null,
        new: identities.new,
      },
      previousEvidence: structuredClone(plan.previousEvidence),
      expectedEvidence: structuredClone(plan.expected),
    };
  }

  async function discardSourceAfterPreparedDurable(plan) {
    await discardOnePrepared(plan.taskId, plan.skillId);
  }

  async function replaceExact(raw) {
    const plan = replacementPlan(raw);
    plan.receipt.state = "busy";
    const session = await openRoot(plan.root);
    try {
      const targetSpec = { kind: "target", skillId: plan.skillId };
      const preparedSpec = { kind: "prepared", skillId: plan.skillId, swapId: plan.swapId };
      const oldSpec = { kind: "old", skillId: plan.skillId, swapId: plan.swapId };
      const before = directoryEvidence(await session.inspectDirectChildNoFollow(targetSpec), "skill_previous_evidence_invalid", true);
      if (!sameEvidence(before, plan.previousEvidence)) throw skillError("skill_previous_evidence_changed");
      const reserved = journalRecord(plan, session, "reserved", { prepared: null, new: null });
      await journal.record(reserved);
      const staged = directoryEvidence(await session.stagePreparedTreeNoFollow({
        sourceProof: plan.receipt.capabilityReceipt,
        skillId: plan.skillId,
        swapId: plan.swapId,
        expected: plan.expected,
      }), "skill_prepared_evidence_invalid");
      if (!evidenceMatches(staged, plan.expected)) throw skillError("skill_prepared_evidence_invalid");
      const identities = { prepared: staged.identity, new: staged.identity };
      await journal.record(journalRecord(plan, session, "prepared", identities));
      await discardSourceAfterPreparedDurable(plan);
      const current = directoryEvidence(await session.inspectDirectChildNoFollow(targetSpec), "skill_previous_evidence_invalid", true);
      if (!sameEvidence(current, plan.previousEvidence)) throw skillError("skill_previous_evidence_changed");
      if (current.kind === "directory") {
        await session.renameDirectChildNoReplace({ from: targetSpec, to: oldSpec, expectedIdentity: current.identity });
      }
      await journal.record(journalRecord(plan, session, "old_moved", identities));
      const targetAfterMove = directoryEvidence(await session.inspectDirectChildNoFollow(targetSpec), "skill_swap_ambiguous", true);
      if (targetAfterMove.kind !== "absent") throw skillError("skill_swap_ambiguous");
      const published = directoryEvidence(
        await session.renameDirectChildNoReplace({ from: preparedSpec, to: targetSpec, expectedIdentity: staged.identity }),
        "skill_published_evidence_invalid",
      );
      if (!sameEvidence(published, staged)) throw skillError("skill_published_evidence_invalid");
      await journal.record(journalRecord(plan, session, "new_published", identities));
      const completionReceipt = Object.freeze(Object.create(null));
      completionReceipts.set(completionReceipt, {
        state: "issued",
        taskId: plan.taskId,
        swapId: plan.swapId,
        target: plan.target,
        root: plan.root,
        skillId: plan.skillId,
        expected: plan.expected,
        evidence: published,
      });
      plan.receipt.state = "consumed";
      return Object.freeze({ completionReceipt });
    } catch (error) {
      plan.receipt.state = "consumed";
      throw error;
    } finally {
      await session.close();
    }
  }

  function reconcileRequest(raw) {
    if (!exact(raw, ["taskId", "swapId", "target", "expected"])
      || !TASK_ID.test(raw.taskId ?? "") || !SWAP_ID.test(raw.swapId ?? "")) {
      throw skillError("skill_reconcile_request_invalid");
    }
    return {
      taskId: raw.taskId,
      swapId: raw.swapId,
      target: canonical(raw.target, "skill_target_invalid"),
      expected: expectedEvidence(raw.expected),
    };
  }

  function recordToPlan(record) {
    return {
      taskId: record.taskId,
      swapId: record.swapId,
      skillId: record.skillId,
      root: record.skillsRoot,
      target: record.target,
      source: record.sourcePath,
      expected: record.expectedEvidence,
      previousEvidence: record.previousEvidence,
      receipt: { sourceIdentity: record.identities.source },
    };
  }

  async function reconcileReplacement(raw) {
    const request = reconcileRequest(raw);
    let transaction = await journal.load({ taskId: request.taskId, swapId: request.swapId });
    if (!transaction) return Object.freeze({ status: "absent" });
    let record = transaction.snapshot;
    if (record.target !== request.target || !evidenceMatches({ kind: "directory", ...record.expectedEvidence }, request.expected)) {
      throw skillError("skill_swap_record_mismatch");
    }
    const plan = recordToPlan(record);
    const session = await openRoot(record.skillsRoot);
    const targetSpec = { kind: "target", skillId: record.skillId };
    const preparedSpec = { kind: "prepared", skillId: record.skillId, swapId: record.swapId };
    const oldSpec = { kind: "old", skillId: record.skillId, swapId: record.swapId };
    const identities = { prepared: record.identities.prepared, new: record.identities.new };
    try {
      if (!sameIdentity(session.rootIdentity, record.identities.root)) throw skillError("skill_swap_root_identity_changed");
      if (record.phase === "reserved") {
        const prepared = directoryEvidence(await session.inspectDirectChildNoFollow(preparedSpec), "skill_swap_ambiguous", true);
        let staged = prepared;
        if (prepared.kind === "absent") {
          staged = directoryEvidence(await session.recoverPreparedTreeNoFollow({
            taskId: record.taskId,
            sourceIdentity: record.identities.source,
            skillId: record.skillId,
            swapId: record.swapId,
            expected: record.expectedEvidence,
          }), "skill_prepared_evidence_invalid");
        }
        if (!evidenceMatches(staged, record.expectedEvidence)) throw skillError("skill_swap_ambiguous");
        identities.prepared = staged.identity;
        identities.new = staged.identity;
        await journal.record(journalRecord(plan, session, "prepared", identities));
        record = (await journal.load({ taskId: request.taskId, swapId: request.swapId })).snapshot;
      }
      if (record.phase === "prepared") {
        await discardSourceAfterPreparedDurable(plan);
        const prepared = directoryEvidence(await session.inspectDirectChildNoFollow(preparedSpec), "skill_swap_ambiguous", true);
        const current = directoryEvidence(await session.inspectDirectChildNoFollow(targetSpec), "skill_swap_ambiguous", true);
        const old = directoryEvidence(await session.inspectDirectChildNoFollow(oldSpec), "skill_swap_ambiguous", true);
        if (current.kind === "absent" && sameEvidence(old, record.previousEvidence)) {
          // The old rename completed before its phase record was durable.
        } else {
          if (!sameEvidence(current, record.previousEvidence) || old.kind !== "absent") throw skillError("skill_swap_ambiguous");
          if (current.kind === "directory") {
            await session.renameDirectChildNoReplace({ from: targetSpec, to: oldSpec, expectedIdentity: current.identity });
          }
        }
        if (!evidenceMatches(prepared, record.expectedEvidence)
          || !sameIdentity(prepared.identity, record.identities.prepared)) throw skillError("skill_swap_ambiguous");
        await journal.record(journalRecord(plan, session, "old_moved", identities));
        record = (await journal.load({ taskId: request.taskId, swapId: request.swapId })).snapshot;
      }
      if (record.phase === "old_moved") {
        const current = directoryEvidence(await session.inspectDirectChildNoFollow(targetSpec), "skill_swap_ambiguous", true);
        const prepared = directoryEvidence(await session.inspectDirectChildNoFollow(preparedSpec), "skill_swap_ambiguous", true);
        const old = directoryEvidence(await session.inspectDirectChildNoFollow(oldSpec), "skill_swap_ambiguous", true);
        if (record.previousEvidence.kind === "directory" && !sameEvidence(old, record.previousEvidence)) {
          throw skillError("skill_swap_ambiguous");
        }
        if (record.previousEvidence.kind === "absent" && old.kind !== "absent") throw skillError("skill_swap_ambiguous");
        if (current.kind === "absent") {
          if (!evidenceMatches(prepared, record.expectedEvidence)
            || !sameIdentity(prepared.identity, record.identities.prepared)) throw skillError("skill_swap_ambiguous");
          await session.renameDirectChildNoReplace({ from: preparedSpec, to: targetSpec, expectedIdentity: prepared.identity });
        } else if (!evidenceMatches(current, record.expectedEvidence)
          || !sameIdentity(current.identity, record.identities.new) || prepared.kind !== "absent") {
          throw skillError("skill_swap_ambiguous");
        }
        await journal.record(journalRecord(plan, session, "new_published", identities));
        record = (await journal.load({ taskId: request.taskId, swapId: request.swapId })).snapshot;
      }
      let published = directoryEvidence(await session.inspectDirectChildNoFollow(targetSpec), "skill_swap_ambiguous");
      if (!evidenceMatches(published, record.expectedEvidence)
        || !sameIdentity(published.identity, record.identities.new)) throw skillError("skill_swap_ambiguous");
      if (record.phase === "new_published") {
        await journal.record(journalRecord(plan, session, "proof_written", identities));
        record = (await journal.load({ taskId: request.taskId, swapId: request.swapId })).snapshot;
      }
      if (record.phase === "proof_written") {
        const old = directoryEvidence(await session.inspectDirectChildNoFollow(oldSpec), "skill_swap_ambiguous", true);
        if (record.previousEvidence.kind === "directory") {
          if (sameEvidence(old, record.previousEvidence)) {
            await session.deleteDirectChildTreeNoFollow({ child: oldSpec, expectedEvidence: record.previousEvidence });
          } else if (old.kind !== "absent") {
            throw skillError("skill_swap_ambiguous");
          }
        } else if (old.kind !== "absent") throw skillError("skill_swap_ambiguous");
        await journal.record(journalRecord(plan, session, "cleanup_committed", identities));
        record = (await journal.load({ taskId: request.taskId, swapId: request.swapId })).snapshot;
      }
      if (record.phase !== "cleanup_committed") throw skillError("skill_swap_phase_invalid");
      const oldAfter = directoryEvidence(await session.inspectDirectChildNoFollow(oldSpec), "skill_swap_ambiguous", true);
      published = directoryEvidence(await session.inspectDirectChildNoFollow(targetSpec), "skill_swap_ambiguous");
      if (oldAfter.kind !== "absent" || !evidenceMatches(published, record.expectedEvidence)
        || !sameIdentity(published.identity, record.identities.new)) throw skillError("skill_swap_ambiguous");
      await journal.clear({ taskId: record.taskId, swapId: record.swapId });
      return Object.freeze({
        status: "completed",
        completionProof: proofFor({ taskId: record.taskId, swapId: record.swapId, target: record.target, evidence: published }),
        evidence: published,
      });
    } finally {
      await session.close();
    }
  }

  async function finalizeReplacement(raw) {
    if (!exact(raw, ["completionReceipt", "target", "taskId", "swapId", "expected"])
      || !TASK_ID.test(raw.taskId ?? "") || !SWAP_ID.test(raw.swapId ?? "")) {
      throw skillError("skill_completion_request_invalid");
    }
    const receipt = completionReceipts.get(raw.completionReceipt);
    if (!receipt || receipt.state !== "issued" || receipt.taskId !== raw.taskId || receipt.swapId !== raw.swapId
      || receipt.target !== raw.target || !evidenceMatches(receipt.evidence, expectedEvidence(raw.expected))) {
      throw skillError("skill_completion_receipt_invalid");
    }
    receipt.state = "consumed";
    const reconciled = await reconcileReplacement({
      taskId: raw.taskId,
      swapId: raw.swapId,
      target: raw.target,
      expected: raw.expected,
    });
    if (reconciled.status !== "completed") throw skillError("skill_completion_incomplete");
    return Object.freeze({ completionProof: reconciled.completionProof, evidence: reconciled.evidence });
  }

  async function inspectExact({ target, authorizedRoot } = {}) {
    const parts = targetParts(target, authorizedRoot);
    const session = await openRoot(parts.root);
    try {
      return directoryEvidence(await session.inspectDirectChildNoFollow({ kind: "target", skillId: parts.skillId }), "skill_tree_evidence_invalid", true);
    } finally {
      await session.close();
    }
  }

  async function deleteExact(raw) {
    if (!exact(raw, ["target", "authorizedRoot", "expectedEvidence"])) throw skillError("skill_delete_plan_invalid");
    const parts = targetParts(raw.target, raw.authorizedRoot);
    const expected = directoryEvidence(raw.expectedEvidence, "skill_delete_evidence_invalid");
    const session = await openRoot(parts.root);
    try {
      const targetSpec = { kind: "target", skillId: parts.skillId };
      const current = directoryEvidence(await session.inspectDirectChildNoFollow(targetSpec), "skill_delete_evidence_invalid", true);
      if (!sameEvidence(current, expected)) throw skillError("skill_delete_identity_mismatch");
      await session.deleteDirectChildTreeNoFollow({ child: targetSpec, expectedEvidence: expected });
      return true;
    } finally {
      await session.close();
    }
  }

  async function hashSkillFile(filePath) {
    const exactPath = canonical(filePath, "skill_file_path_invalid");
    if (path.win32.basename(exactPath) !== "SKILL.md") throw skillError("skill_file_path_invalid");
    const target = path.win32.dirname(exactPath);
    const root = path.win32.dirname(target);
    const evidence = await inspectExact({ target, authorizedRoot: root });
    if (evidence.kind !== "directory") throw skillError("skill_not_installed");
    return evidence.skillMdSha256;
  }

  async function recoverCompletionProof(raw) {
    if (!exact(raw, ["target", "taskId", "swapId", "expected"]) || !TASK_ID.test(raw.taskId ?? "")
      || !SWAP_ID.test(raw.swapId ?? "")) throw skillError("skill_completion_recovery_invalid");
    const expected = expectedEvidence(raw.expected);
    const target = canonical(raw.target);
    const evidence = await inspectExact({ target, authorizedRoot: path.win32.dirname(target) });
    if (!evidenceMatches(evidence, expected)) throw skillError("skill_completion_recovery_mismatch");
    return Object.freeze({
      completionProof: proofFor({ taskId: raw.taskId, swapId: raw.swapId, target, evidence }),
      evidence,
    });
  }

  async function verifyCompletionProof(raw) {
    if (!exact(raw, ["completionProof", "target", "taskId", "swapId", "expected"])) {
      throw skillError("skill_completion_proof_invalid");
    }
    const proof = validateProof(raw.completionProof);
    const expected = expectedEvidence(raw.expected);
    const target = canonical(raw.target);
    if (proof.taskId !== raw.taskId || proof.swapId !== raw.swapId || proof.target !== target
      || !evidenceMatches({ kind: "directory", ...proof }, expected)) {
      throw skillError("skill_completion_proof_invalid");
    }
    const evidence = await inspectExact({ target, authorizedRoot: path.win32.dirname(target) });
    if (!evidenceMatches(evidence, expected) || !sameIdentity(evidence.identity, proof.identity)) {
      throw skillError("skill_completion_proof_invalid");
    }
    return evidence;
  }

  return Object.freeze({
    beginPreparedSource,
    bindPreparedSource,
    discardPrepared,
    reconcilePreparedSources,
    verifyPreparedSkill,
    hashFile: hashSkillFile,
    replaceExact,
    finalizeReplacement,
    verifyCompletionProof,
    recoverCompletionProof,
    inspectExact,
    deleteExact,
    reconcileReplacement,
  });
}
