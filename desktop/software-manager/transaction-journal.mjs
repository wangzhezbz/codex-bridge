import path from "node:path";

const SCHEMA_VERSION = 2;
const COMPONENT_IDS = new Set(["chatgpt", "v2rayn", "git"]);
const PHASES = [
  "prepared", "retiring_moved", "old_moved", "new_promoted", "state_committed", "cleanup_committed",
  "abort_started", "abort_incoming_isolated", "abort_current_restored", "abort_previous_restored",
  "abort_state_restoring", "abort_cleanup_started", "abort_cleanup_committed",
];
const ABORT_PHASES = [
  "abort_started", "abort_incoming_isolated", "abort_current_restored", "abort_previous_restored",
  "abort_state_restoring", "abort_cleanup_started", "abort_cleanup_committed",
];
const RECORD_KEYS = [
  "schemaVersion", "taskId", "componentId", "mode", "phase", "rootPath",
  "slots", "paths", "versions", "identities", "integrities", "ownershipBefore",
];
const SLOT_KEYS = ["current", "previous", "staging", "retiring"];
const VERSION_KEYS = ["incoming", "current", "previous"];
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;

function journalError(code, cause) {
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

function slotNames(componentId) {
  return componentId === "chatgpt"
    ? { current: "c", previous: "cp", staging: "ct", retiring: "cr" }
    : { current: "current", previous: "previous", staging: "staging", retiring: "retiring" };
}

function canonicalRoot(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 32_760
    || value !== value.normalize("NFC") || !/^[A-Za-z]:\\/u.test(value) || value.includes("/")
    || value.startsWith("\\\\") || value.includes("\0") || path.win32.normalize(value) !== value
    || value.toLowerCase() === path.win32.parse(value).root.toLowerCase()) {
    throw journalError("transaction_record_invalid");
  }
  const tail = value.slice(path.win32.parse(value).root.length);
  const segments = tail.split("\\");
  if (segments.length > 64 || segments.some((segment) => segment.length === 0 || segment.length > 255
    || segment === "." || segment === ".." || /[<>:"/\\|?*\u0000-\u001f]/u.test(segment)
    || /[ .]$/u.test(segment) || RESERVED_NAME.test(segment))) {
    throw journalError("transaction_record_invalid");
  }
  return value;
}

function normalizeIdentity(value) {
  if (value === null) return null;
  if (!hasExactKeys(value, ["volumeSerial", "fileId"])
    || typeof value.volumeSerial !== "string" || value.volumeSerial.length === 0 || value.volumeSerial.length > 128
    || typeof value.fileId !== "string" || value.fileId.length === 0 || value.fileId.length > 256) {
    throw journalError("transaction_record_invalid");
  }
  return { volumeSerial: value.volumeSerial, fileId: value.fileId };
}

function normalizeVersion(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !VERSION.test(value)) throw journalError("transaction_record_invalid");
  return value;
}

function normalizeIntegrity(value) {
  if (value === null) return null;
  if (!hasExactKeys(value, ["treeDigest", "manifestDigest"])
    || !SHA256.test(value.treeDigest ?? "") || !SHA256.test(value.manifestDigest ?? "")) {
    throw journalError("transaction_record_invalid");
  }
  return { treeDigest: value.treeDigest, manifestDigest: value.manifestDigest };
}

function normalizeJson(value, state = { count: 0 }, depth = 0) {
  state.count += 1;
  if (state.count > 2_048 || depth > 16) throw journalError("transaction_record_invalid");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 32_760 || value.includes("\0")) throw journalError("transaction_record_invalid");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw journalError("transaction_record_invalid");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item, state, depth + 1));
  if (!isPlainRecord(value)) throw journalError("transaction_record_invalid");
  const result = {};
  for (const key of Object.keys(value)) {
    if (key.length === 0 || key.length > 256 || key.includes("\0")) throw journalError("transaction_record_invalid");
    Object.defineProperty(result, key, {
      value: normalizeJson(value[key], state, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function sameIdentity(left, right) {
  if (!left || !right) return false;
  return left.volumeSerial === right.volumeSerial && left.fileId === right.fileId;
}

function normalizeOwnershipBefore(value, {
  componentId, rootPath, paths, versions, identities, integrities,
}) {
  if (!hasExactKeys(value, ["component", "rollback", "activeTask", "lastTask"])) {
    throw journalError("transaction_record_invalid");
  }
  const normalized = normalizeJson(value);
  if (!(normalized.activeTask === null || isPlainRecord(normalized.activeTask))
    || !(normalized.lastTask === null || isPlainRecord(normalized.lastTask))) {
    throw journalError("transaction_record_invalid");
  }
  if (versions.current === null) {
    if (normalized.component !== null) throw journalError("transaction_record_invalid");
  } else if (!isPlainRecord(normalized.component)
    || normalized.component.installPath !== paths.current
    || normalized.component.version !== versions.current
    || normalized.component.treeDigest !== integrities.current.treeDigest
    || normalized.component.manifestDigest !== integrities.current.manifestDigest
    || normalized.component.managed !== true
    || !sameIdentity(normalized.component.slotIdentity, identities.current)) {
    throw journalError("transaction_record_invalid");
  }
  if (versions.previous === null) {
    if (normalized.rollback !== null) throw journalError("transaction_record_invalid");
  } else if (!isPlainRecord(normalized.rollback)
    || normalized.rollback.path !== paths.previous
    || normalized.rollback.rootPath !== rootPath
    || normalized.rollback.componentId !== componentId
    || normalized.rollback.version !== versions.previous
    || normalized.rollback.treeDigest !== integrities.previous.treeDigest
    || normalized.rollback.manifestDigest !== integrities.previous.manifestDigest
    || !sameIdentity(normalized.rollback.slotIdentity, identities.previous)) {
    throw journalError("transaction_record_invalid");
  }
  return normalized;
}

function normalizeRecord(value) {
  if (!hasExactKeys(value, RECORD_KEYS) || value.schemaVersion !== SCHEMA_VERSION
    || !TASK_ID.test(value.taskId ?? "") || !COMPONENT_IDS.has(value.componentId)
    || !["promote", "rollback"].includes(value.mode) || !PHASES.includes(value.phase)) {
    throw journalError("transaction_record_invalid");
  }
  const rootPath = canonicalRoot(value.rootPath);
  const expectedSlots = slotNames(value.componentId);
  if (!hasExactKeys(value.slots, SLOT_KEYS)
    || SLOT_KEYS.some((key) => value.slots[key] !== expectedSlots[key])) {
    throw journalError("transaction_record_invalid");
  }
  if (!hasExactKeys(value.paths, SLOT_KEYS)
    || SLOT_KEYS.some((key) => value.paths[key] !== path.win32.join(rootPath, expectedSlots[key]))) {
    throw journalError("transaction_record_invalid");
  }
  if (!hasExactKeys(value.versions, VERSION_KEYS) || !hasExactKeys(value.identities, VERSION_KEYS)
    || !hasExactKeys(value.integrities, VERSION_KEYS)) {
    throw journalError("transaction_record_invalid");
  }
  const versions = Object.fromEntries(VERSION_KEYS.map((key) => [key, normalizeVersion(value.versions[key])]));
  const identities = Object.fromEntries(VERSION_KEYS.map((key) => [key, normalizeIdentity(value.identities[key])]));
  const integrities = Object.fromEntries(VERSION_KEYS.map((key) => [key, normalizeIntegrity(value.integrities[key])]));
  for (const key of VERSION_KEYS) {
    if ((versions[key] === null) !== (identities[key] === null)
      || (versions[key] === null) !== (integrities[key] === null)) {
      throw journalError("transaction_record_invalid");
    }
  }
  if (value.mode === "promote") {
    if (versions.incoming === null || (versions.previous !== null && versions.current === null)) {
      throw journalError("transaction_record_invalid");
    }
  } else if (versions.incoming !== null || versions.current === null || versions.previous === null
    || value.phase === "old_moved") {
    throw journalError("transaction_record_invalid");
  }
  const paths = Object.fromEntries(SLOT_KEYS.map((key) => [key, path.win32.join(rootPath, expectedSlots[key])]));
  const ownershipBefore = normalizeOwnershipBefore(value.ownershipBefore, {
    componentId: value.componentId,
    rootPath,
    paths,
    versions,
    identities,
    integrities,
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    taskId: value.taskId,
    componentId: value.componentId,
    mode: value.mode,
    phase: value.phase,
    rootPath,
    slots: { ...expectedSlots },
    paths,
    versions,
    identities,
    integrities,
    ownershipBefore,
  };
}

function requireDirectory(directory) {
  if (!directory || typeof directory.listFileNamesNoFollow !== "function"
    || typeof directory.openFileNoFollow !== "function"
    || typeof directory.unlinkEntryNoFollow !== "function"
    || typeof directory.renameEntryNoFollow !== "function"
    || typeof directory.close !== "function") {
    throw journalError("transaction_journal_no_follow_capability_invalid");
  }
  return directory;
}

function requireFile(file, writable = false) {
  if (!file || !file.entry || typeof file.readFile !== "function" || typeof file.close !== "function"
    || (writable && (typeof file.writeFile !== "function" || typeof file.sync !== "function"))) {
    throw journalError("transaction_journal_file_capability_invalid");
  }
  return file;
}

function fileName(componentId, phase, temp = false) {
  return `${componentId}.${phase}.json${temp ? ".tmp" : ""}`;
}

function recordsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function forwardSequence(record) {
  if (record.mode === "rollback") {
    return ["prepared", "retiring_moved", "new_promoted", "state_committed", "cleanup_committed"];
  }
  return [
    "prepared",
    ...(record.versions.previous === null ? [] : ["retiring_moved"]),
    ...(record.versions.current === null ? [] : ["old_moved"]),
    "new_promoted",
    "state_committed",
    "cleanup_committed",
  ];
}

function expectedSequences(record) {
  const forward = forwardSequence(record);
  const stateIndex = forward.indexOf("state_committed");
  const aborts = [];
  for (let prefixLength = 1; prefixLength <= stateIndex; prefixLength += 1) {
    aborts.push([...forward.slice(0, prefixLength), ...ABORT_PHASES]);
  }
  return [forward, ...aborts];
}

function isExactPrefix(sequence, phases) {
  return phases.length <= sequence.length
    && phases.every((phase, index) => sequence[index] === phase);
}

async function readRecord(directory, name) {
  const file = await directory.openFileNoFollow(name, "r");
  if (file === null) return null;
  const handle = requireFile(file);
  try {
    return { entry: handle.entry, record: normalizeRecord(JSON.parse(await handle.readFile("utf8"))) };
  } catch (error) {
    if (error?.code === "transaction_record_invalid") throw error;
    throw journalError("transaction_journal_corrupt", error);
  } finally {
    await handle.close();
  }
}

async function unlinkNamed(directory, name) {
  const file = await directory.openFileNoFollow(name, "r");
  if (file === null) return false;
  const handle = requireFile(file);
  const entry = handle.entry;
  await handle.close();
  await directory.unlinkEntryNoFollow(entry);
  return true;
}

export function createTransactionJournal({ journalDir, fsApi }) {
  if (!fsApi || typeof fsApi.openJournalDirectoryNoFollow !== "function") {
    throw journalError("transaction_journal_no_follow_capability_required");
  }
  canonicalRoot(journalDir);

  async function openDirectory() {
    return requireDirectory(await fsApi.openJournalDirectoryNoFollow(journalDir));
  }

  async function record(value) {
    const normalized = normalizeRecord(value);
    const destinationName = fileName(normalized.componentId, normalized.phase);
    const tempName = fileName(normalized.componentId, normalized.phase, true);
    const directory = await openDirectory();
    try {
      const existing = await readRecord(directory, destinationName);
      if (existing) {
        if (!recordsEqual(existing.record, normalized)) throw journalError("transaction_journal_conflict");
        return existing.record;
      }
      const priorRecords = [];
      for (const phase of PHASES) {
        const prior = await readRecord(directory, fileName(normalized.componentId, phase));
        if (!prior) continue;
        if (!recordsEqual({ ...prior.record, phase: normalized.phase }, normalized)) {
          throw journalError("transaction_journal_conflict");
        }
        priorRecords.push(prior.record);
      }
      const priorSet = new Set(priorRecords.map((item) => item.phase));
      if (priorSet.size !== priorRecords.length) throw journalError("transaction_journal_conflict");
      const validNext = expectedSequences(normalized).some((sequence) => {
        const ordered = sequence.filter((phase) => priorSet.has(phase));
        return ordered.length === priorSet.size && isExactPrefix(sequence, ordered)
          && sequence[priorSet.size] === normalized.phase;
      });
      if (!validNext) throw journalError("transaction_journal_phase_order_invalid");
      await unlinkNamed(directory, tempName);

      const temp = requireFile(await directory.openFileNoFollow(tempName, "wx"), true);
      const tempEntry = temp.entry;
      try {
        await temp.writeFile(`${JSON.stringify(normalized)}\n`, "utf8");
        await temp.sync();
      } finally {
        await temp.close();
      }
      await directory.renameEntryNoFollow(tempEntry, destinationName);
      return normalized;
    } finally {
      await directory.close();
    }
  }

  async function listTransactions() {
    const directory = await openDirectory();
    try {
      const names = await directory.listFileNamesNoFollow();
      if (!Array.isArray(names) || names.length > COMPONENT_IDS.size * PHASES.length * 2) {
        throw journalError("transaction_journal_entry_limit");
      }
      const groups = new Map();
      for (const name of names) {
        const match = /^(chatgpt|v2rayn|git)\.(prepared|retiring_moved|old_moved|new_promoted|state_committed|cleanup_committed|abort_started|abort_incoming_isolated|abort_current_restored|abort_previous_restored|abort_state_restoring|abort_cleanup_started|abort_cleanup_committed)\.json(\.tmp)?$/u.exec(name);
        if (!match) throw journalError("transaction_journal_entry_invalid");
        if (match[3]) {
          await unlinkNamed(directory, name);
          continue;
        }
        const value = await readRecord(directory, name);
        if (!value) continue;
        const normalized = value.record;
        if (normalized.componentId !== match[1] || normalized.phase !== match[2]) {
          throw journalError("transaction_journal_corrupt");
        }
        const key = `${normalized.taskId}\0${normalized.componentId}`;
        const group = groups.get(key) ?? [];
        group.push(normalized);
        groups.set(key, group);
      }

      const transactions = [];
      for (const records of groups.values()) {
        const prepared = records.find((item) => item.phase === "prepared");
        const cleanup = records.find((item) => item.phase === "cleanup_committed");
        const abortCleanup = records.find((item) => item.phase === "abort_cleanup_committed");
        const anchor = prepared ?? cleanup ?? abortCleanup;
        if (!anchor || records.some((item) => {
          const comparable = { ...item, phase: "prepared" };
          return !recordsEqual(comparable, { ...anchor, phase: "prepared" });
        })) {
          throw journalError("transaction_journal_conflict");
        }
        const snapshot = { ...anchor, phase: "prepared" };
        const sequences = expectedSequences(snapshot);
        const present = new Set(records.map((item) => item.phase));
        let sequence;
        if (cleanup || abortCleanup) {
          sequence = sequences.find((candidate) => candidate.at(-1) === (cleanup ? "cleanup_committed" : "abort_cleanup_committed")
            && [...present].every((phase) => candidate.includes(phase)));
        } else {
          if (!prepared) throw journalError("transaction_journal_phase_order_invalid");
          sequence = sequences.find((candidate) => isExactPrefix(candidate, candidate.filter((phase) => present.has(phase)))
            && records.length === candidate.filter((phase) => present.has(phase)).length);
        }
        if (!sequence) throw journalError("transaction_journal_phase_order_invalid");
        records.sort((left, right) => sequence.indexOf(left.phase) - sequence.indexOf(right.phase));
        transactions.push({
          taskId: snapshot.taskId,
          componentId: snapshot.componentId,
          mode: snapshot.mode,
          records,
          snapshot,
        });
      }
      return transactions;
    } finally {
      await directory.close();
    }
  }

  async function clear(transaction) {
    const transactions = await listTransactions();
    const found = transactions.find((item) => item.taskId === transaction?.taskId
      && item.componentId === transaction?.componentId);
    if (!found) return;
    const directory = await openDirectory();
    try {
      const deletionOrder = [
        ...found.records.filter((item) => !["cleanup_committed", "abort_cleanup_committed"].includes(item.phase)),
        ...found.records.filter((item) => ["cleanup_committed", "abort_cleanup_committed"].includes(item.phase)),
      ];
      for (const item of deletionOrder) {
        const opened = await readRecord(directory, fileName(item.componentId, item.phase));
        if (!opened || opened.record.taskId !== found.taskId) throw journalError("transaction_journal_conflict");
        await directory.unlinkEntryNoFollow(opened.entry);
      }
    } finally {
      await directory.close();
    }
  }

  return Object.freeze({ record, listTransactions, clear });
}

export async function recoverTransactions({ journal, slots }) {
  if (!journal || typeof journal.listTransactions !== "function" || typeof journal.clear !== "function"
    || !slots || typeof slots.recoverTransaction !== "function") {
    throw journalError("transaction_recovery_capability_invalid");
  }
  const recovered = [];
  for (const transaction of await journal.listTransactions()) {
    await slots.recoverTransaction(transaction);
    await journal.clear(transaction);
    recovered.push({
      taskId: transaction.taskId,
      componentId: transaction.componentId,
      mode: transaction.mode,
    });
  }
  return recovered;
}
