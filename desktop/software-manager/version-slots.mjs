import path from "node:path";

import { deleteAuthorizedTree } from "./safe-delete.mjs";

const COMPONENT_IDS = new Set(["chatgpt", "v2rayn", "git"]);
const SLOT_KEYS = ["current", "previous", "staging", "retiring"];
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;

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
  if (!hasExactKeys(value, ["schemaVersion", "componentId", "version", "identity"])
    || value.schemaVersion !== 1 || value.componentId !== componentId
    || typeof value.version !== "string" || !VERSION.test(value.version)) {
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
  if (value.evidence === null && allowIncomplete) return value;
  if (value.evidence === null) throw slotError("slot_complete_evidence_required");
  const evidence = validateEvidence(value.evidence, componentId);
  if (!sameIdentity(evidence.identity, value.descriptor.identity)) throw slotError("slot_identity_changed");
  return { descriptor: value.descriptor, evidence };
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

function requireAuthorizedRoot(state, rootPath) {
  let installRoot;
  try {
    installRoot = canonicalRoot(state?.installRoot);
  } catch (error) {
    throw slotError("slot_root_not_owned", error);
  }
  if (path.win32.dirname(rootPath) !== installRoot) throw slotError("slot_root_not_owned");
}

function evidenceMatches(left, right) {
  return left !== null && right !== null
    && left.componentId === right.componentId && left.version === right.version
    && sameIdentity(left.identity, right.identity);
}

function requireManagedState(state, componentId, rootPath, current, previous) {
  requireAuthorizedRoot(state, rootPath);
  const component = state?.components?.[componentId];
  const names = namesFor(componentId);
  if (current === null) {
    if (component !== undefined) throw slotError("slot_ownership_mismatch");
  } else if (!isPlainRecord(component)
    || component.installPath !== path.win32.join(rootPath, names.current)
    || component.version !== current.version
    || !sameIdentity(component.slotIdentity, current.identity)) {
    throw slotError("slot_ownership_mismatch");
  }
  const rollback = rollbackFor(state, componentId);
  if (previous === null) {
    if (rollback !== null) throw slotError("slot_rollback_ownership_mismatch");
  } else if (!isPlainRecord(rollback)
    || rollback.path !== path.win32.join(rootPath, names.previous)
    || rollback.rootPath !== rootPath || rollback.version !== previous.version
    || !sameIdentity(rollback.slotIdentity, previous.identity)) {
    throw slotError("slot_rollback_ownership_mismatch");
  }
}

function baseRecord({ taskId, componentId, mode, rootPath, incoming, current, previous }) {
  const slots = namesFor(componentId);
  return {
    schemaVersion: 1,
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
  };
}

function evidenceFromSnapshot(snapshot, key) {
  if (snapshot.versions[key] === null || snapshot.identities[key] === null) return null;
  return {
    schemaVersion: 1,
    componentId: snapshot.componentId,
    version: snapshot.versions[key],
    identity: structuredClone(snapshot.identities[key]),
  };
}

function phaseRecord(snapshot, phase) {
  return { ...structuredClone(snapshot), phase };
}

function validatePromotionPlan(plan) {
  if (!hasExactKeys(plan, ["taskId", "componentId", "rootPath", "version"])
    || !TASK_ID.test(plan.taskId ?? "") || !COMPONENT_IDS.has(plan.componentId)
    || typeof plan.version !== "string" || !VERSION.test(plan.version)) {
    throw slotError("slot_promotion_plan_invalid");
  }
  return { ...plan, rootPath: canonicalRoot(plan.rootPath) };
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

export function createVersionSlotManager({ fsApi, ownershipStore, journal }) {
  if (!fsApi || typeof fsApi.openVersionRootNoFollow !== "function") {
    throw slotError("slot_no_follow_capability_required");
  }
  if (!ownershipStore || typeof ownershipStore.load !== "function" || typeof ownershipStore.save !== "function") {
    throw slotError("slot_ownership_store_required");
  }
  if (!journal || typeof journal.record !== "function" || typeof journal.clear !== "function") {
    throw slotError("slot_journal_required");
  }

  async function openRoot(rootPath) {
    return validateRootCapability(await fsApi.openVersionRootNoFollow(rootPath));
  }

  async function inspectLayout(snapshot, { allowIncompleteStaging = false } = {}) {
    const root = await openRoot(snapshot.rootPath);
    try {
      const layout = {};
      for (const key of SLOT_KEYS) {
        const opened = await root.openSlotNoFollow(snapshot.slots[key]);
        layout[key] = validateOpenedSlot(opened, snapshot.slots[key], snapshot.componentId, {
          allowIncomplete: allowIncompleteStaging && key === "staging",
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

  async function commitOwnership(snapshot) {
    const state = await ownershipStore.load();
    if (!isPlainRecord(state) || !isPlainRecord(state.components)) throw slotError("slot_ownership_state_invalid");
    const incoming = evidenceFromSnapshot(snapshot, "incoming");
    const current = evidenceFromSnapshot(snapshot, "current");
    const previous = evidenceFromSnapshot(snapshot, "previous");
    const desiredCurrent = snapshot.mode === "promote" ? incoming : previous;
    const desiredPrevious = snapshot.mode === "promote" ? current : null;
    const next = structuredClone(state);
    next.components[snapshot.componentId] = {
      ...(isPlainRecord(next.components[snapshot.componentId]) ? next.components[snapshot.componentId] : {}),
      installPath: snapshot.paths.current,
      version: desiredCurrent.version,
      slotIdentity: structuredClone(desiredCurrent.identity),
      managed: true,
    };
    next.rollback = withoutRollback(next, snapshot.componentId);
    if (desiredPrevious) {
      const record = {
        path: snapshot.paths.previous,
        rootPath: snapshot.rootPath,
        componentId: snapshot.componentId,
        version: desiredPrevious.version,
        slotIdentity: structuredClone(desiredPrevious.identity),
      };
      next.rollback = [...rollbackRecords(next), record];
    }
    next.activeTask = null;
    next.lastTask = {
      taskId: snapshot.taskId,
      componentId: snapshot.componentId,
      action: snapshot.mode === "promote" ? "promote" : "rollback",
    };
    await ownershipStore.save(next);
    await journal.record(phaseRecord(snapshot, "state_committed"));
  }

  async function deleteRetiring(snapshot, evidence, desiredCurrent) {
    if (!evidence) return;
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
      );
      if (!retiring) return;
      if (!evidenceMatches(retiring.evidence, evidence)) throw slotError("slot_retiring_identity_changed");
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
      await deleteRetiring(snapshot, previous, incoming);
      await journal.record(phaseRecord(snapshot, "cleanup_committed"));
      return;
    }

    await moveIfNeeded(snapshot, "retiring_moved", "current", "retiring", current);
    await moveIfNeeded(snapshot, "new_promoted", "previous", "current", previous);
    const layout = await inspectLayout(snapshot);
    if (!evidenceMatches(layout.current?.evidence, previous)) throw slotError("slot_rollback_postcondition_failed");
    await commitOwnership(snapshot);
    await deleteRetiring(snapshot, current, previous);
    await journal.record(phaseRecord(snapshot, "cleanup_committed"));
  }

  async function finishCommittedTransaction(snapshot) {
    const incoming = evidenceFromSnapshot(snapshot, "incoming");
    const current = evidenceFromSnapshot(snapshot, "current");
    const previous = evidenceFromSnapshot(snapshot, "previous");
    const desiredCurrent = snapshot.mode === "promote" ? incoming : previous;
    const desiredPrevious = snapshot.mode === "promote" ? current : null;
    const retired = snapshot.mode === "promote" ? previous : current;
    const layout = await inspectLayout(snapshot);
    assertRecognizedLayout(layout, snapshot);
    if (!evidenceMatches(layout.current?.evidence, desiredCurrent)
      || (desiredPrevious === null ? layout.previous !== null : !evidenceMatches(layout.previous?.evidence, desiredPrevious))
      || layout.staging !== null
      || (layout.retiring !== null && !evidenceMatches(layout.retiring.evidence, retired))) {
      throw slotError("slot_committed_layout_invalid");
    }
    const state = await ownershipStore.load();
    requireManagedState(state, snapshot.componentId, snapshot.rootPath, desiredCurrent, desiredPrevious);
    await deleteRetiring(snapshot, retired, desiredCurrent);
    await journal.record(phaseRecord(snapshot, "cleanup_committed"));
  }

  async function promotePreparedVersion(rawPlan) {
    const plan = validatePromotionPlan(rawPlan);
    const slots = namesFor(plan.componentId);
    const state = await ownershipStore.load();
    requireAuthorizedRoot(state, plan.rootPath);
    const root = await openRoot(plan.rootPath);
    let incoming;
    let current;
    let previous;
    try {
      const staging = validateOpenedSlot(
        await root.openSlotNoFollow(slots.staging), slots.staging, plan.componentId, { allowIncomplete: true },
      );
      if (!staging) throw slotError("slot_staging_missing");
      incoming = staging.evidence ?? validateEvidence(await root.sealPreparedSlotNoFollow(staging.descriptor, {
        schemaVersion: 1,
        componentId: plan.componentId,
        version: plan.version,
      }), plan.componentId);
      if (incoming.version !== plan.version) throw slotError("slot_staging_version_mismatch");
      const openedCurrent = validateOpenedSlot(
        await root.openSlotNoFollow(slots.current), slots.current, plan.componentId,
      );
      const openedPrevious = validateOpenedSlot(
        await root.openSlotNoFollow(slots.previous), slots.previous, plan.componentId,
      );
      current = openedCurrent?.evidence ?? null;
      previous = openedPrevious?.evidence ?? null;
      if (await root.openSlotNoFollow(slots.retiring) !== null) throw slotError("slot_recovery_required");
    } finally {
      await root.close();
    }

    requireManagedState(state, plan.componentId, plan.rootPath, current, previous);
    const snapshot = baseRecord({ ...plan, mode: "promote", incoming, current, previous });
    await journal.record(snapshot);
    const transaction = { taskId: snapshot.taskId, componentId: snapshot.componentId, mode: snapshot.mode, snapshot };
    await executeTransaction(snapshot);
    await journal.clear(transaction);
    return { componentId: plan.componentId, version: plan.version, rollbackAvailable: current !== null };
  }

  async function rollbackVersion(componentId) {
    namesFor(componentId);
    const state = await ownershipStore.load();
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
    const snapshot = baseRecord({
      taskId: `rollback-${componentId}`,
      componentId,
      mode: "rollback",
      rootPath,
      incoming: null,
      current,
      previous,
    });
    await journal.record(snapshot);
    const transaction = { taskId: snapshot.taskId, componentId, mode: "rollback", snapshot };
    await executeTransaction(snapshot);
    await journal.clear(transaction);
    return { componentId, version: previous.version, rollbackAvailable: false };
  }

  async function recoverTransaction(transaction) {
    if (!transaction || !transaction.snapshot || transaction.taskId !== transaction.snapshot.taskId
      || transaction.componentId !== transaction.snapshot.componentId || transaction.mode !== transaction.snapshot.mode) {
      throw slotError("slot_recovery_record_invalid");
    }
    if (Array.isArray(transaction.records)
      && transaction.records.some((record) => ["state_committed", "cleanup_committed"].includes(record.phase))) {
      await finishCommittedTransaction(transaction.snapshot);
      return;
    }
    await executeTransaction(transaction.snapshot);
  }

  return Object.freeze({ promotePreparedVersion, rollbackVersion, recoverTransaction });
}
