import path from "node:path";

import { getOwnershipCoordinator } from "./ownership-coordinator.mjs";
import { readInstallRootCapability } from "./path-policy.mjs";
import { deleteAuthorizedTree } from "./safe-delete.mjs";

const COMPONENT_IDS = new Set(["chatgpt", "v2rayn", "git"]);
const COMPONENT_ROOT_NAMES = Object.freeze({ chatgpt: null, v2rayn: "V2RayN", git: "Git" });
const SLOT_KEYS = ["current", "previous", "staging", "retiring"];
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;
const ACTIVE_TRANSACTION_KIND = "software-version-slot";
const ACTIVE_TRANSACTION_LIFECYCLES = new Set(["reserved", "active", "clearing"]);
const ACTIVE_TRANSACTION_KEYS = [
  "kind", "schemaVersion", "lifecycle", "journalScope", "taskId", "componentId", "mode", "rootPath",
];

function slotError(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  return isPlainRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function namesFor(componentId) {
  if (!COMPONENT_IDS.has(componentId)) throw slotError("slot_component_invalid");
  return componentId === "chatgpt"
    ? { current: "c", previous: "cp", staging: "ct", retiring: "cr" }
    : { current: "current", previous: "previous", staging: "staging", retiring: "retiring" };
}

function canonicalRoot(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 32_760
    || value !== value.normalize("NFC") || !/^[A-Za-z]:\\/u.test(value) || value.includes("/")
    || value.startsWith("\\\\") || value.includes("\0") || path.win32.normalize(value) !== value
    || value.toLowerCase() === path.win32.parse(value).root.toLowerCase()) {
    throw slotError("slot_root_invalid");
  }
  const tail = value.slice(path.win32.parse(value).root.length);
  const segments = tail.split("\\");
  if (segments.length > 64 || segments.some((segment) => segment.length === 0 || segment.length > 255
    || segment === "." || segment === ".." || /[<>:"/\\|?*\u0000-\u001f]/u.test(segment)
    || /[ .]$/u.test(segment) || RESERVED_NAME.test(segment))) {
    throw slotError("slot_root_invalid");
  }
  return value;
}

function identityKey(identity) {
  if (!hasExactKeys(identity, ["volumeSerial", "fileId"])
    || typeof identity.volumeSerial !== "string" || identity.volumeSerial.length === 0
    || typeof identity.fileId !== "string" || identity.fileId.length === 0) {
    throw slotError("slot_identity_invalid");
  }
  return `${identity.volumeSerial}\0${identity.fileId}`;
}

function sameIdentity(left, right) {
  return identityKey(left) === identityKey(right);
}

function validateEvidence(value, componentId) {
  if (!hasExactKeys(value, [
    "schemaVersion", "componentId", "version", "treeDigest", "manifestDigest", "identity",
  ])
    || value.schemaVersion !== 2 || value.componentId !== componentId
    || typeof value.version !== "string" || !VERSION.test(value.version)
    || !SHA256.test(value.treeDigest ?? "") || !SHA256.test(value.manifestDigest ?? "")) {
    throw slotError("slot_complete_evidence_invalid");
  }
  identityKey(value.identity);
  return structuredClone(value);
}

function validateRootCapability(root) {
  if (!root || typeof root.openSlotNoFollow !== "function"
    || typeof root.sealPreparedSlotNoFollow !== "function"
    || typeof root.renameSlotNoReplace !== "function"
    || typeof root.listChildren !== "function" || typeof root.openChildNoFollow !== "function"
    || typeof root.unlinkChildNoFollow !== "function" || typeof root.rmdirChildNoFollow !== "function"
    || typeof root.close !== "function") {
    throw slotError("slot_no_follow_capability_invalid");
  }
  return root;
}

function validateOpenedSlot(value, expectedName, componentId, { allowIncomplete = false } = {}) {
  if (value === null) return null;
  if (!value || !value.descriptor || value.descriptor.name !== expectedName
    || value.descriptor.kind !== "directory" || !value.descriptor.handle
    || !sameIdentity(value.descriptor.identity, value.descriptor.identity)) {
    throw slotError("slot_descriptor_invalid");
  }
  if (value.evidence === null && allowIncomplete) {
    return { descriptor: value.descriptor, evidence: null, markerStatus: value.markerStatus ?? "missing" };
  }
  if (value.evidence === null) throw slotError("slot_complete_evidence_required");
  const evidence = validateEvidence(value.evidence, componentId);
  if (!sameIdentity(evidence.identity, value.descriptor.identity)) throw slotError("slot_identity_changed");
  return { descriptor: value.descriptor, evidence, markerStatus: value.markerStatus ?? "complete" };
}

function rollbackRecords(state) {
  if (state.rollback === null) return [];
  return Array.isArray(state.rollback) ? state.rollback : [state.rollback];
}

function rollbackFor(state, componentId) {
  return rollbackRecords(state).find((record) => record?.componentId === componentId) ?? null;
}

function withoutRollback(state, componentId) {
  const remaining = rollbackRecords(state).filter((record) => record?.componentId !== componentId);
  if (remaining.length === 0) return null;
  return remaining;
}

function installRootFor(rootPath, componentId) {
  return componentId === "chatgpt" ? rootPath : path.win32.dirname(rootPath);
}

function rootMatchesInstallRoot(rootPath, componentId, installRoot) {
  return componentId === "chatgpt"
    ? rootPath === installRoot
    : path.win32.dirname(rootPath) === installRoot
      && rootPath === path.win32.join(installRoot, COMPONENT_ROOT_NAMES[componentId]);
}

function requireAuthorizedRoot(state, rootPath, componentId, { allowUnclaimed = false } = {}) {
  if (allowUnclaimed && state?.installRoot === null) return installRootFor(rootPath, componentId);
  let installRoot;
  try {
    installRoot = canonicalRoot(state?.installRoot);
  } catch (error) {
    throw slotError("slot_root_not_owned", error);
  }
  if (!rootMatchesInstallRoot(rootPath, componentId, installRoot)) {
    throw slotError("slot_root_not_owned");
  }
  return installRoot;
}

function evidenceMatches(left, right) {
  return left !== null && right !== null
    && left.componentId === right.componentId && left.version === right.version
    && left.treeDigest === right.treeDigest && left.manifestDigest === right.manifestDigest
    && sameIdentity(left.identity, right.identity);
}

function requireManagedState(state, componentId, rootPath, current, previous, { allowUnclaimed = false } = {}) {
  requireAuthorizedRoot(state, rootPath, componentId, { allowUnclaimed });
  const component = state?.components?.[componentId];
  const names = namesFor(componentId);
  if (current === null) {
    if (component !== undefined) throw slotError("slot_ownership_mismatch");
  } else if (!isPlainRecord(component)
    || component.managed !== true
    || component.installPath !== path.win32.join(rootPath, names.current)
    || component.version !== current.version
    || component.treeDigest !== current.treeDigest
    || component.manifestDigest !== current.manifestDigest
    || !sameIdentity(component.slotIdentity, current.identity)) {
    throw slotError("slot_ownership_mismatch");
  }
  const rollback = rollbackFor(state, componentId);
  if (previous === null) {
    if (rollback !== null) throw slotError("slot_rollback_ownership_mismatch");
  } else if (!isPlainRecord(rollback)
    || rollback.path !== path.win32.join(rootPath, names.previous)
    || rollback.rootPath !== rootPath || rollback.version !== previous.version
    || rollback.treeDigest !== previous.treeDigest
    || rollback.manifestDigest !== previous.manifestDigest
    || !sameIdentity(rollback.slotIdentity, previous.identity)) {
    throw slotError("slot_rollback_ownership_mismatch");
  }
}

function ownershipSlice(state, componentId) {
  return {
    installRoot: structuredClone(state.installRoot),
    component: state.components[componentId] === undefined
      ? null
      : structuredClone(state.components[componentId]),
    rollback: structuredClone(rollbackFor(state, componentId)),
    activeTask: structuredClone(state.activeTask),
    lastTask: structuredClone(state.lastTask),
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function isVersionTransactionClaim(value) {
  if (!hasExactKeys(value, ACTIVE_TRANSACTION_KEYS)
    || value.kind !== ACTIVE_TRANSACTION_KIND || value.schemaVersion !== 1
    || !ACTIVE_TRANSACTION_LIFECYCLES.has(value.lifecycle)
    || typeof value.journalScope !== "string" || value.journalScope !== value.journalScope.toLowerCase()
    || !TASK_ID.test(value.taskId ?? "") || !COMPONENT_IDS.has(value.componentId)
    || !["promote", "rollback"].includes(value.mode)) {
    return false;
  }
  try {
    return canonicalRoot(value.journalScope) === value.journalScope
      && canonicalRoot(value.rootPath) === value.rootPath;
  } catch {
    return false;
  }
}

function transactionClaim(value, journalScope, lifecycle) {
  const claim = {
    kind: ACTIVE_TRANSACTION_KIND,
    schemaVersion: 1,
    lifecycle,
    journalScope,
    taskId: value.taskId,
    componentId: value.componentId,
    mode: value.mode,
    rootPath: value.rootPath,
  };
  if (!isVersionTransactionClaim(claim)) throw slotError("slot_active_transaction_invalid");
  return claim;
}

function claimMatches(value, transaction, journalScope, lifecycles = ACTIVE_TRANSACTION_LIFECYCLES) {
  if (!isVersionTransactionClaim(value) || !lifecycles.has(value.lifecycle)) return false;
  return sameJson(value, transactionClaim(transaction, journalScope, value.lifecycle));
}

function managedStateMatches(state, componentId, rootPath, current, previous, options) {
  try {
    requireManagedState(state, componentId, rootPath, current, previous, options);
    return true;
  } catch {
    return false;
  }
}

function desiredEvidence(snapshot) {
  const incoming = evidenceFromSnapshot(snapshot, "incoming");
  const current = evidenceFromSnapshot(snapshot, "current");
  const previous = evidenceFromSnapshot(snapshot, "previous");
  return snapshot.mode === "promote"
    ? { current: incoming, previous: current }
    : { current: previous, previous: null };
}

function componentRuntimeMetadata(value) {
  if (!isPlainRecord(value)) return {};
  const metadata = {};
  if (typeof value.entrypointPath === "string") metadata.entrypointPath = value.entrypointPath;
  if (Array.isArray(value.requiredFiles) && value.requiredFiles.every((item) => typeof item === "string")) {
    metadata.requiredFiles = structuredClone(value.requiredFiles);
  }
  if (typeof value.health === "string") metadata.health = value.health;
  return metadata;
}

function expectedPostOwnership(snapshot) {
  const desired = desiredEvidence(snapshot);
  const before = snapshot.ownershipBefore;
  return {
    installRoot: installRootFor(snapshot.rootPath, snapshot.componentId),
    component: {
      ...(snapshot.mode === "promote"
        ? structuredClone(snapshot.runtimeMetadata)
        : componentRuntimeMetadata(before.rollback)),
      installPath: snapshot.paths.current,
      version: desired.current.version,
      treeDigest: desired.current.treeDigest,
      manifestDigest: desired.current.manifestDigest,
      slotIdentity: structuredClone(desired.current.identity),
      managed: true,
    },
    rollback: desired.previous ? {
      ...(snapshot.mode === "promote" ? componentRuntimeMetadata(before.component) : {}),
      path: snapshot.paths.previous,
      rootPath: snapshot.rootPath,
      componentId: snapshot.componentId,
      version: desired.previous.version,
      treeDigest: desired.previous.treeDigest,
      manifestDigest: desired.previous.manifestDigest,
      slotIdentity: structuredClone(desired.previous.identity),
    } : null,
    activeTask: structuredClone(before.activeTask),
    lastTask: {
      taskId: snapshot.taskId,
      componentId: snapshot.componentId,
      action: snapshot.mode === "promote" ? "promote" : "rollback",
    },
  };
}

function expectedAbortOwnership(snapshot) {
  if (snapshot.mode === "promote") return structuredClone(snapshot.ownershipBefore);
  return {
    ...structuredClone(snapshot.ownershipBefore),
    rollback: null,
  };
}

function applyOwnershipSlice(state, componentId, slice) {
  const next = structuredClone(state);
  next.installRoot = structuredClone(slice.installRoot);
  if (slice.component === null) delete next.components[componentId];
  else next.components[componentId] = structuredClone(slice.component);
  next.rollback = withoutRollback(next, componentId);
  if (slice.rollback !== null) {
    next.rollback = [...rollbackRecords(next), structuredClone(slice.rollback)];
  }
  next.activeTask = structuredClone(slice.activeTask);
  next.lastTask = structuredClone(slice.lastTask);
  return next;
}

function requireRecoveryOwnershipState(state, snapshot, { allowAbort = false } = {}) {
  const slice = ownershipSlice(state, snapshot.componentId);
  const preMatches = sameJson(slice, snapshot.ownershipBefore);
  const desired = desiredEvidence(snapshot);
  const postMatches = sameJson(slice, expectedPostOwnership(snapshot)) && managedStateMatches(
    state, snapshot.componentId, snapshot.rootPath, desired.current, desired.previous,
  );
  const abortPrevious = snapshot.mode === "promote"
    ? evidenceFromSnapshot(snapshot, "previous")
    : null;
  const abortCurrent = evidenceFromSnapshot(snapshot, "current");
  const abortMatches = allowAbort && sameJson(slice, expectedAbortOwnership(snapshot))
    && managedStateMatches(state, snapshot.componentId, snapshot.rootPath, abortCurrent, abortPrevious, {
      allowUnclaimed: abortCurrent === null && snapshot.ownershipBefore.installRoot === null,
    });
  if (!preMatches && !postMatches && !abortMatches) throw slotError("slot_recovery_ownership_mismatch");
  if (abortMatches) return "abort";
  return postMatches ? "post" : "pre";
}

function baseRecord({ taskId, componentId, mode, rootPath, incoming, current, previous, state, runtimeMetadata = null }) {
  const slots = namesFor(componentId);
  return {
    schemaVersion: 2,
    taskId,
    componentId,
    mode,
    phase: "prepared",
    rootPath,
    slots,
    paths: Object.fromEntries(SLOT_KEYS.map((key) => [key, path.win32.join(rootPath, slots[key])])),
    versions: {
      incoming: incoming?.version ?? null,
      current: current?.version ?? null,
      previous: previous?.version ?? null,
    },
    identities: {
      incoming: incoming?.identity ?? null,
      current: current?.identity ?? null,
      previous: previous?.identity ?? null,
    },
    integrities: {
      incoming: incoming ? {
        treeDigest: incoming.treeDigest, manifestDigest: incoming.manifestDigest,
      } : null,
      current: current ? {
        treeDigest: current.treeDigest, manifestDigest: current.manifestDigest,
      } : null,
      previous: previous ? {
        treeDigest: previous.treeDigest, manifestDigest: previous.manifestDigest,
      } : null,
    },
    runtimeMetadata: mode === "promote" ? structuredClone(runtimeMetadata) : null,
    ownershipBefore: ownershipSlice(state, componentId),
  };
}

function evidenceFromSnapshot(snapshot, key) {
  if (snapshot.versions[key] === null || snapshot.identities[key] === null) return null;
  return {
    schemaVersion: 2,
    componentId: snapshot.componentId,
    version: snapshot.versions[key],
    treeDigest: snapshot.integrities[key].treeDigest,
    manifestDigest: snapshot.integrities[key].manifestDigest,
    identity: structuredClone(snapshot.identities[key]),
  };
}

function phaseRecord(snapshot, phase) {
  return { ...structuredClone(snapshot), phase };
}

function validatePromotionPlan(plan) {
  if (!hasExactKeys(plan, [
    "taskId", "componentId", "rootPath", "version", "verificationReceipt", "treeDigest", "manifestDigest",
    "runtimeMetadata",
  ])
    || !TASK_ID.test(plan.taskId ?? "") || !COMPONENT_IDS.has(plan.componentId)
    || typeof plan.version !== "string" || !VERSION.test(plan.version)
    || plan.verificationReceipt === null || typeof plan.verificationReceipt !== "object"
    || !SHA256.test(plan.treeDigest ?? "")
    || !SHA256.test(plan.manifestDigest ?? "")
    || !hasExactKeys(plan.runtimeMetadata, ["entrypointPath", "requiredFiles", "health"])
    || typeof plan.runtimeMetadata.entrypointPath !== "string"
    || !Array.isArray(plan.runtimeMetadata.requiredFiles) || plan.runtimeMetadata.requiredFiles.length === 0
    || plan.runtimeMetadata.health !== "pending-verify") {
    throw slotError("slot_promotion_plan_invalid");
  }
  const rootPath = canonicalRoot(plan.rootPath);
  const currentRoot = path.win32.join(rootPath, namesFor(plan.componentId).current);
  const runtimePaths = [plan.runtimeMetadata.entrypointPath, ...plan.runtimeMetadata.requiredFiles];
  if (runtimePaths.some((candidate) => path.win32.normalize(candidate) !== candidate
    || !candidate.toLowerCase().startsWith(`${currentRoot.toLowerCase()}\\`))) {
    throw slotError("slot_promotion_runtime_metadata_invalid");
  }
  return { ...plan, rootPath };
}

export function planPeakBytes({ current, previous, incoming } = {}) {
  const values = [current, previous, incoming];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw slotError("slot_bytes_invalid");
  }
  let total = 0;
  for (const value of values) {
    if (value > Number.MAX_SAFE_INTEGER - total) throw slotError("slot_bytes_overflow");
    total += value;
  }
  return total;
}

export function createVersionSlotManager({ fsApi, ownershipStore, journal, installRootCapability = null }) {
  if (!fsApi || typeof fsApi.openVersionRootNoFollow !== "function") {
    throw slotError("slot_no_follow_capability_required");
  }
  if (!ownershipStore || typeof ownershipStore.load !== "function"
    || typeof ownershipStore.compareAndSwap !== "function") {
    throw slotError("slot_ownership_store_required");
  }
  const ownershipCoordinator = getOwnershipCoordinator(ownershipStore);
  ownershipStore = ownershipCoordinator.store;
  if (!journal || typeof journal.record !== "function" || typeof journal.listTransactions !== "function"
    || typeof journal.clear !== "function" || typeof journal.scopeId !== "string") {
    throw slotError("slot_journal_required");
  }
  let journalScope;
  try {
    journalScope = canonicalRoot(journal.scopeId);
  } catch (error) {
    throw slotError("slot_journal_required", error);
  }
  if (journalScope !== journalScope.toLowerCase()) throw slotError("slot_journal_required");
  let authorizedInstallRoot = null;
  if (installRootCapability !== null) {
    try {
      authorizedInstallRoot = readInstallRootCapability(installRootCapability);
    } catch (error) {
      throw slotError("slot_install_root_capability_invalid", error);
    }
  }

  function requireManagerAuthorizedRoot(state, rootPath, componentId, { allowUnclaimed = false } = {}) {
    if (state?.installRoot !== null) return requireAuthorizedRoot(state, rootPath, componentId);
    const derived = installRootFor(rootPath, componentId);
    if (!allowUnclaimed || authorizedInstallRoot === null
      || derived.toLowerCase() !== authorizedInstallRoot.toLowerCase()) {
      throw slotError("slot_root_not_owned");
    }
    return authorizedInstallRoot;
  }

  async function requireNoPendingTransaction(state) {
    if (state?.activeTask !== null) throw slotError("slot_pending_transaction");
    const pending = await journal.listTransactions();
    if (!Array.isArray(pending)) throw slotError("slot_journal_invalid");
    if (pending.length !== 0) throw slotError("slot_pending_transaction");
  }

  async function releaseMatchingClaim(transaction, allowedLifecycles) {
    const state = await ownershipStore.load();
    if (state?.activeTask === null) return false;
    if (!claimMatches(state?.activeTask, transaction, journalScope, allowedLifecycles)) {
      throw slotError("slot_active_transaction_changed");
    }
    await ownershipStore.save({ ...structuredClone(state), activeTask: null });
    return true;
  }

  async function beginTransaction(state, snapshot) {
    const expectedActive = transactionClaim(snapshot, journalScope, "active");
    if (!sameJson(snapshot.ownershipBefore.activeTask, expectedActive)) {
      throw slotError("slot_active_transaction_invalid");
    }
    const reserved = transactionClaim(snapshot, journalScope, "reserved");
    try {
      await ownershipStore.save({ ...structuredClone(state), activeTask: reserved });
    } catch (error) {
      try {
        await releaseMatchingClaim(snapshot, new Set(["reserved"]));
      } catch {
        // A persisted reservation remains recoverable by its journal scope.
      }
      throw error;
    }
    try {
      await journal.record(snapshot);
    } catch (error) {
      let durable = true;
      try {
        const pending = await journal.listTransactions();
        if (!Array.isArray(pending)) throw slotError("slot_journal_invalid");
        durable = pending.some((transaction) => transaction.taskId === snapshot.taskId
          && transaction.componentId === snapshot.componentId && transaction.mode === snapshot.mode);
      } catch {
        // Ambiguous journal state must retain its persistent reservation.
      }
      if (!durable) await releaseMatchingClaim(snapshot, new Set(["reserved"]));
      throw error;
    }
    const reservedState = await ownershipStore.load();
    if (!claimMatches(reservedState?.activeTask, snapshot, journalScope, new Set(["reserved", "active"]))) {
      throw slotError("slot_active_transaction_changed");
    }
    if (reservedState.activeTask.lifecycle === "reserved") {
      await ownershipStore.save({ ...structuredClone(reservedState), activeTask: expectedActive });
    }
  }

  async function markTransactionClearing(snapshot) {
    if (snapshot.ownershipBefore.activeTask === null) return;
    if (!isVersionTransactionClaim(snapshot.ownershipBefore.activeTask)) {
      throw slotError("slot_active_transaction_invalid");
    }
    const state = await ownershipStore.load();
    if (!claimMatches(state?.activeTask, snapshot, journalScope, new Set(["active", "clearing"]))) {
      throw slotError("slot_active_transaction_changed");
    }
    if (state.activeTask.lifecycle === "active") {
      await ownershipStore.save({
        ...structuredClone(state),
        activeTask: transactionClaim(snapshot, journalScope, "clearing"),
      });
    }
  }

  async function finishAndClearTransaction(transaction) {
    await markTransactionClearing(transaction.snapshot);
    await journal.clear(transaction);
    if (isVersionTransactionClaim(transaction.snapshot.ownershipBefore.activeTask)) {
      await releaseMatchingClaim(transaction.snapshot, new Set(["clearing"]));
    }
  }

  async function openRoot(rootPath) {
    return validateRootCapability(await fsApi.openVersionRootNoFollow(rootPath));
  }

  async function inspectLayout(snapshot, {
    allowIncompleteStaging = false,
    allowIncompleteRetiring = false,
    allowIncompleteAny = false,
  } = {}) {
    const root = await openRoot(snapshot.rootPath);
    try {
      const layout = {};
      for (const key of SLOT_KEYS) {
        const opened = await root.openSlotNoFollow(snapshot.slots[key]);
        layout[key] = validateOpenedSlot(opened, snapshot.slots[key], snapshot.componentId, {
          allowIncomplete: allowIncompleteAny || (allowIncompleteStaging && key === "staging")
            || (allowIncompleteRetiring && key === "retiring"),
        });
      }
      return layout;
    } finally {
      await root.close();
    }
  }

  function locate(layout, evidence) {
    if (!evidence) return null;
    const locations = SLOT_KEYS.filter((key) => layout[key] && evidenceMatches(layout[key].evidence, evidence));
    if (locations.length > 1) throw slotError("slot_identity_duplicated");
    return locations[0] ?? null;
  }

  function locateByIdentity(layout, evidence) {
    if (!evidence) return null;
    const locations = SLOT_KEYS.filter((key) => layout[key]
      && sameIdentity(layout[key].descriptor.identity, evidence.identity));
    if (locations.length > 1) throw slotError("slot_identity_duplicated");
    return locations[0] ?? null;
  }

  function assertRecognizedLayout(layout, snapshot) {
    const recognized = ["incoming", "current", "previous"]
      .map((key) => evidenceFromSnapshot(snapshot, key))
      .filter(Boolean);
    for (const slot of Object.values(layout)) {
      if (slot && !recognized.some((evidence) => evidenceMatches(slot.evidence, evidence))) {
        throw slotError("slot_unrecognized_complete_version");
      }
    }
  }

  function assertAbortLayout(layout, snapshot) {
    const abortTarget = evidenceFromSnapshot(
      snapshot,
      snapshot.mode === "promote" ? "incoming" : "previous",
    );
    const recognized = ["incoming", "current", "previous"]
      .map((key) => evidenceFromSnapshot(snapshot, key))
      .filter(Boolean);
    for (const slot of Object.values(layout)) {
      if (!slot) continue;
      if (recognized.some((evidence) => evidenceMatches(slot.evidence, evidence))) continue;
      if (slot.evidence === null && abortTarget
        && sameIdentity(slot.descriptor.identity, abortTarget.identity)) continue;
      throw slotError("slot_unrecognized_complete_version");
    }
  }

  function slotMatchesEvidence(slot, evidence, { allowMarkerless = false } = {}) {
    if (!slot || !evidence) return false;
    if (evidenceMatches(slot.evidence, evidence)) return true;
    return allowMarkerless && slot.evidence === null && slot.markerStatus === "missing"
      && sameIdentity(slot.descriptor.identity, evidence.identity);
  }

  function optionalSlotMatches(slot, evidence) {
    return evidence === null ? slot === null : slotMatchesEvidence(slot, evidence);
  }

  async function moveIfNeeded(snapshot, phase, sourceKey, destinationKey, evidence) {
    if (!evidence) return;
    const layout = await inspectLayout(snapshot);
    assertRecognizedLayout(layout, snapshot);
    const location = locate(layout, evidence);
    if (location === destinationKey) return;
    if (location !== sourceKey) throw slotError("slot_complete_version_missing");
    if (layout[destinationKey] !== null) throw slotError("slot_destination_occupied");

    await journal.record(phaseRecord(snapshot, phase));
    const root = await openRoot(snapshot.rootPath);
    try {
      const source = validateOpenedSlot(
        await root.openSlotNoFollow(snapshot.slots[sourceKey]),
        snapshot.slots[sourceKey],
        snapshot.componentId,
      );
      if (!source || !evidenceMatches(source.evidence, evidence)) throw slotError("slot_identity_changed");
      const destination = await root.openSlotNoFollow(snapshot.slots[destinationKey]);
      if (destination !== null) throw slotError("slot_destination_occupied");
      await root.renameSlotNoReplace(source.descriptor, snapshot.slots[destinationKey]);
    } finally {
      await root.close();
    }
  }

  async function revertMoveIfNeeded(snapshot, phase, sourceKey, destinationKey, evidence) {
    await journal.record(phaseRecord(snapshot, phase));
    if (!evidence) return;
    const layout = await inspectLayout(snapshot, { allowIncompleteAny: true });
    assertAbortLayout(layout, snapshot);
    const location = locate(layout, evidence);
    if (location === destinationKey) return;
    if (location !== sourceKey) throw slotError("slot_complete_version_missing");
    if (layout[destinationKey] !== null) throw slotError("slot_destination_occupied");

    const root = await openRoot(snapshot.rootPath);
    try {
      const source = validateOpenedSlot(
        await root.openSlotNoFollow(snapshot.slots[sourceKey]),
        snapshot.slots[sourceKey],
        snapshot.componentId,
      );
      if (!source || !evidenceMatches(source.evidence, evidence)) {
        throw slotError("slot_identity_changed");
      }
      if (await root.openSlotNoFollow(snapshot.slots[destinationKey]) !== null) {
        throw slotError("slot_destination_occupied");
      }
      await root.renameSlotNoReplace(source.descriptor, snapshot.slots[destinationKey]);
    } finally {
      await root.close();
    }
  }

  async function restoreAbortOwnership(snapshot) {
    const state = await ownershipStore.load();
    const stateKind = requireRecoveryOwnershipState(state, snapshot, { allowAbort: true });
    if (stateKind === "abort" || (snapshot.mode === "promote" && stateKind === "pre")) return;
    await ownershipStore.save(applyOwnershipSlice(
      state,
      snapshot.componentId,
      expectedAbortOwnership(snapshot),
    ));
  }

  async function isolateAbortTarget(snapshot) {
    await journal.record(phaseRecord(snapshot, "abort_incoming_isolated"));
    const target = evidenceFromSnapshot(
      snapshot,
      snapshot.mode === "promote" ? "incoming" : "previous",
    );
    if (!target) return;
    const layout = await inspectLayout(snapshot, { allowIncompleteAny: true });
    assertAbortLayout(layout, snapshot);
    const location = locateByIdentity(layout, target);
    if (location === null || location === "staging") return;
    const allowedSources = snapshot.mode === "promote" ? ["current"] : ["current", "previous"];
    if (!allowedSources.includes(location)) throw slotError("slot_abort_target_location_invalid");
    if (layout[location].evidence !== null) throw slotError("slot_abort_complete_version_protected");
    if (layout.staging !== null) throw slotError("slot_destination_occupied");

    const root = await openRoot(snapshot.rootPath);
    try {
      const source = validateOpenedSlot(
        await root.openSlotNoFollow(snapshot.slots[location]),
        snapshot.slots[location],
        snapshot.componentId,
        { allowIncomplete: true },
      );
      if (!source || source.evidence !== null
        || !sameIdentity(source.descriptor.identity, target.identity)) {
        throw slotError("slot_abort_target_changed");
      }
      if (await root.openSlotNoFollow(snapshot.slots.staging) !== null) {
        throw slotError("slot_destination_occupied");
      }
      await root.renameSlotNoReplace(source.descriptor, snapshot.slots.staging);
    } finally {
      await root.close();
    }
  }

  async function deleteAbortedTarget(snapshot) {
    const target = evidenceFromSnapshot(
      snapshot,
      snapshot.mode === "promote" ? "incoming" : "previous",
    );
    if (!target) return;
    const layout = await inspectLayout(snapshot, { allowIncompleteAny: true });
    assertAbortLayout(layout, snapshot);
    const location = locateByIdentity(layout, target);
    if (location === null) return;
    const candidate = layout[location];
    if (candidate.evidence !== null) throw slotError("slot_abort_complete_version_protected");
    if (location !== "staging") throw slotError("slot_abort_incoming_not_isolated");
    const root = await openRoot(snapshot.rootPath);
    try {
      const opened = validateOpenedSlot(
        await root.openSlotNoFollow(snapshot.slots.staging),
        snapshot.slots.staging,
        snapshot.componentId,
        { allowIncomplete: true },
      );
      if (!opened || opened.evidence !== null
        || !sameIdentity(opened.descriptor.identity, target.identity)) {
        throw slotError("slot_abort_target_changed");
      }
      await deleteAuthorizedTree({
        target: snapshot.paths.staging,
        authorizedRoot: snapshot.rootPath,
        rootHandle: root,
        targetDescriptor: opened.descriptor,
      });
    } finally {
      await root.close();
    }
  }

  async function abortTransaction(snapshot) {
    const current = evidenceFromSnapshot(snapshot, "current");
    const previous = evidenceFromSnapshot(snapshot, "previous");
    await journal.record(phaseRecord(snapshot, "abort_started"));
    await isolateAbortTarget(snapshot);
    if (snapshot.mode === "promote") {
      await revertMoveIfNeeded(snapshot, "abort_current_restored", "previous", "current", current);
      await revertMoveIfNeeded(snapshot, "abort_previous_restored", "retiring", "previous", previous);
    } else {
      await revertMoveIfNeeded(snapshot, "abort_current_restored", "retiring", "current", current);
      await journal.record(phaseRecord(snapshot, "abort_previous_restored"));
    }
    await journal.record(phaseRecord(snapshot, "abort_state_restoring"));
    await restoreAbortOwnership(snapshot);
    await journal.record(phaseRecord(snapshot, "abort_cleanup_started"));
    await deleteAbortedTarget(snapshot);
    await journal.record(phaseRecord(snapshot, "abort_cleanup_committed"));
  }

  async function finishAbortedTransaction(snapshot) {
    const state = await ownershipStore.load();
    requireAuthorizedRoot(state, snapshot.rootPath, snapshot.componentId, {
      allowUnclaimed: snapshot.ownershipBefore.installRoot === null,
    });
    const expectedPrevious = snapshot.mode === "promote"
      ? evidenceFromSnapshot(snapshot, "previous")
      : null;
    if (!sameJson(ownershipSlice(state, snapshot.componentId), expectedAbortOwnership(snapshot))) {
      throw slotError("slot_abort_ownership_mismatch");
    }
    if (!managedStateMatches(
      state,
      snapshot.componentId,
      snapshot.rootPath,
      evidenceFromSnapshot(snapshot, "current"),
      expectedPrevious,
    )) {
      throw slotError("slot_abort_ownership_mismatch");
    }
    const layout = await inspectLayout(snapshot, { allowIncompleteAny: true });
    assertAbortLayout(layout, snapshot);
    const abortTarget = evidenceFromSnapshot(
      snapshot,
      snapshot.mode === "promote" ? "incoming" : "previous",
    );
    if (locateByIdentity(layout, abortTarget) !== null
      || !optionalSlotMatches(layout.current, evidenceFromSnapshot(snapshot, "current"))
      || !optionalSlotMatches(layout.previous, expectedPrevious)
      || layout.staging !== null
      || layout.retiring !== null) {
      throw slotError("slot_abort_layout_invalid");
    }
  }

  async function commitOwnership(snapshot) {
    const state = await ownershipStore.load();
    if (!isPlainRecord(state) || !isPlainRecord(state.components)) throw slotError("slot_ownership_state_invalid");
    const stateKind = requireRecoveryOwnershipState(state, snapshot);
    if (stateKind === "pre") {
      await ownershipStore.save(applyOwnershipSlice(
        state, snapshot.componentId, expectedPostOwnership(snapshot),
      ));
    }
    const confirmed = await ownershipStore.load();
    if (requireRecoveryOwnershipState(confirmed, snapshot) !== "post") {
      throw slotError("slot_ownership_commit_lost");
    }
    await journal.record(phaseRecord(snapshot, "state_committed"));
  }

  async function deleteRetiring(snapshot, evidence, desiredCurrent, { allowMarkerless = false } = {}) {
    if (!evidence) return;
    const state = await ownershipStore.load();
    if (requireRecoveryOwnershipState(state, snapshot) !== "post") {
      throw slotError("slot_retiring_state_changed");
    }
    const root = await openRoot(snapshot.rootPath);
    try {
      const current = validateOpenedSlot(
        await root.openSlotNoFollow(snapshot.slots.current), snapshot.slots.current, snapshot.componentId,
      );
      if (!current || !evidenceMatches(current.evidence, desiredCurrent)) {
        throw slotError("slot_only_complete_version_protected");
      }
      const retiring = validateOpenedSlot(
        await root.openSlotNoFollow(snapshot.slots.retiring), snapshot.slots.retiring, snapshot.componentId,
        { allowIncomplete: allowMarkerless },
      );
      if (!retiring) return;
      if (!slotMatchesEvidence(retiring, evidence, { allowMarkerless })) {
        throw slotError("slot_retiring_identity_changed");
      }
      await deleteAuthorizedTree({
        target: snapshot.paths.retiring,
        authorizedRoot: snapshot.rootPath,
        rootHandle: root,
        targetDescriptor: retiring.descriptor,
      });
    } finally {
      await root.close();
    }
  }

  async function executeTransaction(snapshot) {
    const incoming = evidenceFromSnapshot(snapshot, "incoming");
    const current = evidenceFromSnapshot(snapshot, "current");
    const previous = evidenceFromSnapshot(snapshot, "previous");
    const initialLayout = await inspectLayout(snapshot);
    assertRecognizedLayout(initialLayout, snapshot);
    for (const evidence of [incoming, current, previous].filter(Boolean)) {
      if (locate(initialLayout, evidence) === null) throw slotError("slot_complete_version_missing");
    }
    if (snapshot.mode === "promote") {
      await moveIfNeeded(snapshot, "retiring_moved", "previous", "retiring", previous);
      await moveIfNeeded(snapshot, "old_moved", "current", "previous", current);
      await moveIfNeeded(snapshot, "new_promoted", "staging", "current", incoming);
      const layout = await inspectLayout(snapshot);
      if (!evidenceMatches(layout.current?.evidence, incoming)
        || (current !== null && !evidenceMatches(layout.previous?.evidence, current))) {
        throw slotError("slot_promotion_postcondition_failed");
      }
      await commitOwnership(snapshot);
      await deleteRetiring(snapshot, previous, incoming, { allowMarkerless: true });
      await journal.record(phaseRecord(snapshot, "cleanup_committed"));
      return;
    }

    await moveIfNeeded(snapshot, "retiring_moved", "current", "retiring", current);
    await moveIfNeeded(snapshot, "new_promoted", "previous", "current", previous);
    const layout = await inspectLayout(snapshot);
    if (!evidenceMatches(layout.current?.evidence, previous)) throw slotError("slot_rollback_postcondition_failed");
    await commitOwnership(snapshot);
    await deleteRetiring(snapshot, current, previous, { allowMarkerless: true });
    await journal.record(phaseRecord(snapshot, "cleanup_committed"));
  }

  async function finishCommittedTransaction(snapshot) {
    const incoming = evidenceFromSnapshot(snapshot, "incoming");
    const current = evidenceFromSnapshot(snapshot, "current");
    const previous = evidenceFromSnapshot(snapshot, "previous");
    const desiredCurrent = snapshot.mode === "promote" ? incoming : previous;
    const desiredPrevious = snapshot.mode === "promote" ? current : null;
    const retired = snapshot.mode === "promote" ? previous : current;
    const layout = await inspectLayout(snapshot, { allowIncompleteRetiring: true });
    const retiringRecognized = layout.retiring === null
      || slotMatchesEvidence(layout.retiring, retired, { allowMarkerless: true });
    assertRecognizedLayout({ ...layout, retiring: retiringRecognized ? null : layout.retiring }, snapshot);
    if (!evidenceMatches(layout.current?.evidence, desiredCurrent)
      || (desiredPrevious === null ? layout.previous !== null : !evidenceMatches(layout.previous?.evidence, desiredPrevious))
      || layout.staging !== null
      || !retiringRecognized) {
      throw slotError("slot_committed_layout_invalid");
    }
    const state = await ownershipStore.load();
    requireManagedState(state, snapshot.componentId, snapshot.rootPath, desiredCurrent, desiredPrevious);
    await deleteRetiring(snapshot, retired, desiredCurrent, { allowMarkerless: true });
    await journal.record(phaseRecord(snapshot, "cleanup_committed"));
  }

  async function promotePreparedVersion(rawPlan) {
    const plan = validatePromotionPlan(rawPlan);
    const slots = namesFor(plan.componentId);
    const state = await ownershipStore.load();
    await requireNoPendingTransaction(state);
    requireManagerAuthorizedRoot(state, plan.rootPath, plan.componentId, { allowUnclaimed: true });
    const root = await openRoot(plan.rootPath);
    let incoming;
    let current;
    let previous;
    let snapshot;
    try {
      const staging = validateOpenedSlot(
        await root.openSlotNoFollow(slots.staging), slots.staging, plan.componentId, { allowIncomplete: true },
      );
      if (!staging) throw slotError("slot_staging_missing");
      const openedCurrent = validateOpenedSlot(
        await root.openSlotNoFollow(slots.current), slots.current, plan.componentId,
      );
      const openedPrevious = validateOpenedSlot(
        await root.openSlotNoFollow(slots.previous), slots.previous, plan.componentId,
      );
      current = openedCurrent?.evidence ?? null;
      previous = openedPrevious?.evidence ?? null;
      if (await root.openSlotNoFollow(slots.retiring) !== null) throw slotError("slot_recovery_required");
      requireManagedState(state, plan.componentId, plan.rootPath, current, previous, {
        allowUnclaimed: current === null && state.installRoot === null,
      });
      incoming = validateEvidence({
        schemaVersion: 2,
        componentId: plan.componentId,
        version: plan.version,
        treeDigest: plan.treeDigest,
        manifestDigest: plan.manifestDigest,
        identity: staging.descriptor.identity,
      }, plan.componentId);
      const descriptor = { ...plan, mode: "promote" };
      const claimedState = {
        ...structuredClone(state),
        activeTask: transactionClaim(descriptor, journalScope, "active"),
      };
      snapshot = baseRecord({ ...descriptor, incoming, current, previous, state: claimedState });
      await beginTransaction(state, snapshot);
      const sealed = validateEvidence(await root.sealPreparedSlotNoFollow(staging.descriptor, {
        schemaVersion: 2,
        componentId: plan.componentId,
        version: plan.version,
        treeDigest: plan.treeDigest,
        manifestDigest: plan.manifestDigest,
      }, plan.verificationReceipt), plan.componentId);
      if (!evidenceMatches(sealed, incoming)) throw slotError("slot_staging_integrity_mismatch");
    } finally {
      await root.close();
    }

    const transaction = { taskId: snapshot.taskId, componentId: snapshot.componentId, mode: snapshot.mode, snapshot };
    await executeTransaction(snapshot);
    await finishAndClearTransaction(transaction);
    return { componentId: plan.componentId, version: plan.version, rollbackAvailable: current !== null };
  }

  async function rollbackVersion(componentId) {
    namesFor(componentId);
    const state = await ownershipStore.load();
    await requireNoPendingTransaction(state);
    const rollback = rollbackFor(state, componentId);
    if (!rollback) throw slotError("rollback_not_available");
    const rootPath = canonicalRoot(rollback.rootPath);
    const slots = namesFor(componentId);
    const root = await openRoot(rootPath);
    let current;
    let previous;
    try {
      const openedCurrent = validateOpenedSlot(await root.openSlotNoFollow(slots.current), slots.current, componentId);
      const openedPrevious = validateOpenedSlot(await root.openSlotNoFollow(slots.previous), slots.previous, componentId);
      current = openedCurrent?.evidence ?? null;
      previous = openedPrevious?.evidence ?? null;
      if (!current || !previous) throw slotError("rollback_slot_missing");
      if (await root.openSlotNoFollow(slots.staging) !== null || await root.openSlotNoFollow(slots.retiring) !== null) {
        throw slotError("slot_recovery_required");
      }
    } finally {
      await root.close();
    }
    requireManagedState(state, componentId, rootPath, current, previous);
    const descriptor = {
      taskId: `rollback-${componentId}`,
      componentId,
      mode: "rollback",
      rootPath,
    };
    const claimedState = {
      ...structuredClone(state),
      activeTask: transactionClaim(descriptor, journalScope, "active"),
    };
    const snapshot = baseRecord({
      ...descriptor,
      incoming: null,
      current,
      previous,
      state: claimedState,
    });
    await beginTransaction(state, snapshot);
    const transaction = { taskId: snapshot.taskId, componentId, mode: "rollback", snapshot };
    await executeTransaction(snapshot);
    await finishAndClearTransaction(transaction);
    return { componentId, version: previous.version, rollbackAvailable: false };
  }

  async function prepareRecoveryClaim(snapshot, phases) {
    const snapshotClaim = snapshot.ownershipBefore.activeTask;
    if (snapshotClaim === null) return;
    if (!isVersionTransactionClaim(snapshotClaim)) throw slotError("slot_recovery_claim_invalid");
    if (!claimMatches(snapshotClaim, snapshot, journalScope, new Set(["active"]))) {
      throw slotError("slot_recovery_claim_invalid");
    }
    const state = await ownershipStore.load();
    if (!claimMatches(state?.activeTask, snapshot, journalScope)) {
      throw slotError("slot_recovery_claim_mismatch");
    }
    if (state.activeTask.lifecycle === "clearing"
      && !phases.has("cleanup_committed") && !phases.has("abort_cleanup_committed")) {
      throw slotError("slot_recovery_claim_phase_invalid");
    }
    if (state.activeTask.lifecycle !== "active") {
      await ownershipStore.save({
        ...structuredClone(state),
        activeTask: transactionClaim(snapshot, journalScope, "active"),
      });
    }
  }

  async function recoverTransaction(transaction) {
    if (!transaction || !transaction.snapshot || transaction.taskId !== transaction.snapshot.taskId
      || transaction.componentId !== transaction.snapshot.componentId || transaction.mode !== transaction.snapshot.mode) {
      throw slotError("slot_recovery_record_invalid");
    }
    const phases = new Set(Array.isArray(transaction.records)
      ? transaction.records.map((record) => record.phase)
      : []);
    await prepareRecoveryClaim(transaction.snapshot, phases);
    const hasAbortPhase = [...phases].some((phase) => phase.startsWith("abort_"));
    const state = await ownershipStore.load();
    requireManagerAuthorizedRoot(state, transaction.snapshot.rootPath, transaction.snapshot.componentId, {
      allowUnclaimed: transaction.snapshot.ownershipBefore.installRoot === null,
    });
    requireRecoveryOwnershipState(state, transaction.snapshot, {
      allowAbort: hasAbortPhase,
    });
    if (phases.has("abort_cleanup_committed")) {
      await finishAbortedTransaction(transaction.snapshot);
      return;
    }
    if (phases.has("abort_started")) {
      await abortTransaction(transaction.snapshot);
      return;
    }
    if (phases.has("state_committed") || phases.has("cleanup_committed")) {
      await finishCommittedTransaction(transaction.snapshot);
      return;
    }
    const layout = await inspectLayout(transaction.snapshot, { allowIncompleteAny: true });
    assertAbortLayout(layout, transaction.snapshot);
    const requiredTarget = evidenceFromSnapshot(
      transaction.snapshot,
      transaction.mode === "promote" ? "incoming" : "previous",
    );
    const location = locateByIdentity(layout, requiredTarget);
    if (location === null || !evidenceMatches(layout[location].evidence, requiredTarget)) {
      await abortTransaction(transaction.snapshot);
      return;
    }
    await executeTransaction(transaction.snapshot);
  }

  async function recoverJournalTransactions(recoveryJournal) {
    if (recoveryJournal !== journal) throw slotError("slot_recovery_journal_mismatch");
    const transactions = await journal.listTransactions();
    if (!Array.isArray(transactions)) throw slotError("slot_journal_invalid");
    if (transactions.length === 0) {
      const state = await ownershipStore.load();
      const active = state?.activeTask;
      if (isVersionTransactionClaim(active) && active.journalScope === journalScope) {
        if (active.lifecycle === "active") throw slotError("slot_recovery_journal_missing");
        await releaseMatchingClaim(active, new Set([active.lifecycle]));
      }
      return [];
    }

    const recovered = [];
    for (const transaction of transactions) {
      await recoverTransaction(transaction);
      await finishAndClearTransaction(transaction);
      recovered.push({
        taskId: transaction.taskId,
        componentId: transaction.componentId,
        mode: transaction.mode,
      });
    }
    return recovered;
  }

  return Object.freeze({
    promotePreparedVersion(rawPlan) {
      return ownershipCoordinator.runExclusive(() => promotePreparedVersion(rawPlan));
    },
    rollbackVersion(componentId) {
      return ownershipCoordinator.runExclusive(() => rollbackVersion(componentId));
    },
    recoverJournalTransactions(recoveryJournal) {
      return ownershipCoordinator.runExclusive(() => recoverJournalTransactions(recoveryJournal));
    },
  });
}
