import path from "node:path";

const SCHEMA_VERSION = 1;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SWAP_ID = /^[a-f0-9]{32}$/u;
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PHASES = Object.freeze([
  "reserved",
  "prepared",
  "old_moved",
  "new_published",
  "proof_written",
  "cleanup_committed",
]);
const RECORD_KEYS = Object.freeze([
  "schemaVersion", "phase", "taskId", "swapId", "skillId", "skillsRoot", "target",
  "sourcePath", "preparedPath", "oldPath", "identities", "previousEvidence", "expectedEvidence",
]);

function journalError(code, cause) {
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

function canonical(value) {
  if (typeof value !== "string" || !/^[A-Za-z]:\\/u.test(value) || value.includes("/")
    || value.includes("\0") || path.win32.normalize(value) !== value) {
    throw journalError("skill_swap_record_invalid");
  }
  const segments = value.slice(3).split("\\");
  if (segments.some((segment) => !segment || segment === "." || segment === ".."
    || /[<>:"|?*\u0000-\u001f]/u.test(segment) || /[ .]$/u.test(segment))) {
    throw journalError("skill_swap_record_invalid");
  }
  return value;
}

function identity(value, nullable = false) {
  if (nullable && value === null) return null;
  if (!exact(value, ["volumeSerial", "fileId"])
    || typeof value.volumeSerial !== "string" || value.volumeSerial.length === 0 || value.volumeSerial.length > 128
    || typeof value.fileId !== "string" || value.fileId.length === 0 || value.fileId.length > 256) {
    throw journalError("skill_swap_record_invalid");
  }
  return { volumeSerial: value.volumeSerial, fileId: value.fileId };
}

function directoryEvidence(value, allowAbsent = false) {
  if (allowAbsent && exact(value, ["kind"]) && value.kind === "absent") return { kind: "absent" };
  if (!exact(value, ["kind", "identity", "treeDigest", "manifestDigest", "skillMdSha256"])
    || value.kind !== "directory" || !SHA256.test(value.treeDigest ?? "")
    || !SHA256.test(value.manifestDigest ?? "") || !SHA256.test(value.skillMdSha256 ?? "")) {
    throw journalError("skill_swap_record_invalid");
  }
  return { ...structuredClone(value), identity: identity(value.identity) };
}

function requiredFile(value) {
  if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC")
    || value.includes("\\") || value.startsWith("/")
    || value.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw journalError("skill_swap_record_invalid");
  }
  return value;
}

function expectedEvidence(value) {
  if (!exact(value, ["treeDigest", "manifestDigest", "skillMdSha256", "requiredFiles"])
    || !SHA256.test(value.treeDigest ?? "") || !SHA256.test(value.manifestDigest ?? "")
    || !SHA256.test(value.skillMdSha256 ?? "") || !Array.isArray(value.requiredFiles)
    || value.requiredFiles.length === 0 || value.requiredFiles.length > 4_096) {
    throw journalError("skill_swap_record_invalid");
  }
  const requiredFiles = value.requiredFiles.map(requiredFile);
  if (!requiredFiles.includes("SKILL.md") || new Set(requiredFiles).size !== requiredFiles.length) {
    throw journalError("skill_swap_record_invalid");
  }
  return {
    treeDigest: value.treeDigest,
    manifestDigest: value.manifestDigest,
    skillMdSha256: value.skillMdSha256,
    requiredFiles,
  };
}

function normalizeRecord(value, skillsRoot) {
  if (!exact(value, RECORD_KEYS) || value.schemaVersion !== SCHEMA_VERSION
    || !PHASES.includes(value.phase) || !TASK_ID.test(value.taskId ?? "")
    || !SWAP_ID.test(value.swapId ?? "") || !SKILL_ID.test(value.skillId ?? "")) {
    throw journalError("skill_swap_record_invalid");
  }
  const root = canonical(skillsRoot);
  if (value.skillsRoot !== root || canonical(value.target) !== path.win32.join(root, value.skillId)) {
    throw journalError("skill_swap_record_invalid");
  }
  const preparedName = `.codexbridge-new-${value.skillId}-${value.swapId}`;
  const oldName = `.codexbridge-old-${value.skillId}-${value.swapId}`;
  if (canonical(value.preparedPath) !== path.win32.join(root, preparedName)
    || canonical(value.oldPath) !== path.win32.join(root, oldName)) {
    throw journalError("skill_swap_record_invalid");
  }
  const sourcePath = canonical(value.sourcePath);
  const previousEvidence = directoryEvidence(value.previousEvidence, true);
  if (!exact(value.identities, ["root", "source", "prepared", "old", "new"])) {
    throw journalError("skill_swap_record_invalid");
  }
  const identities = {
    root: identity(value.identities.root),
    source: identity(value.identities.source),
    prepared: identity(value.identities.prepared, true),
    old: identity(value.identities.old, true),
    new: identity(value.identities.new, true),
  };
  const expected = expectedEvidence(value.expectedEvidence);
  const preparedRequired = value.phase === "reserved" ? null : identities.prepared;
  const newRequired = value.phase === "reserved" ? null : identities.new;
  if (identities.prepared !== preparedRequired || identities.new !== newRequired
    || (previousEvidence.kind === "absent") !== (identities.old === null)
    || (previousEvidence.kind === "directory"
      && JSON.stringify(previousEvidence.identity) !== JSON.stringify(identities.old))) {
    throw journalError("skill_swap_record_invalid");
  }
  if (identities.prepared && JSON.stringify(identities.prepared) !== JSON.stringify(identities.new)) {
    throw journalError("skill_swap_record_invalid");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    phase: value.phase,
    taskId: value.taskId,
    swapId: value.swapId,
    skillId: value.skillId,
    skillsRoot: root,
    target: value.target,
    sourcePath,
    preparedPath: value.preparedPath,
    oldPath: value.oldPath,
    identities,
    previousEvidence,
    expectedEvidence: expected,
  };
}

function requireDirectory(value) {
  if (!value || typeof value.listFileNamesNoFollow !== "function"
    || typeof value.openFileNoFollow !== "function" || typeof value.unlinkEntryNoFollow !== "function"
    || typeof value.renameEntryNoFollow !== "function" || typeof value.close !== "function") {
    throw journalError("skill_swap_journal_capability_invalid");
  }
  return value;
}

function requireFile(value, writable = false) {
  if (!value || !value.entry || typeof value.readFile !== "function" || typeof value.close !== "function"
    || (writable && (typeof value.writeFile !== "function" || typeof value.sync !== "function"))) {
    throw journalError("skill_swap_journal_file_invalid");
  }
  return value;
}

function fileName(taskId, swapId, phase, temp = false) {
  return `${taskId}.${swapId}.${phase}.json${temp ? ".tmp" : ""}`;
}

async function readNamed(directory, name, skillsRoot) {
  const opened = await directory.openFileNoFollow(name, "r");
  if (opened === null) return null;
  const file = requireFile(opened);
  try {
    return { entry: file.entry, record: normalizeRecord(JSON.parse(await file.readFile("utf8")), skillsRoot) };
  } catch (error) {
    if (error?.code === "skill_swap_record_invalid") throw error;
    throw journalError("skill_swap_journal_corrupt", error);
  } finally {
    await file.close();
  }
}

function immutableEqual(left, right) {
  const mutable = new Set(["phase", "identities"]);
  const strip = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => !mutable.has(key)));
  return JSON.stringify(strip(left)) === JSON.stringify(strip(right));
}

export function createSkillSwapJournal({ journalDir, fsApi, skillsRoot } = {}) {
  if (!fsApi || typeof fsApi.openJournalDirectoryNoFollow !== "function") {
    throw journalError("skill_swap_journal_capability_required");
  }
  const root = canonical(skillsRoot);
  canonical(journalDir);

  async function openDirectory() {
    return requireDirectory(await fsApi.openJournalDirectoryNoFollow(journalDir));
  }

  async function load({ taskId, swapId } = {}) {
    if (!TASK_ID.test(taskId ?? "") || !SWAP_ID.test(swapId ?? "")) {
      throw journalError("skill_swap_lookup_invalid");
    }
    const directory = await openDirectory();
    try {
      const records = [];
      for (const phase of PHASES) {
        const value = await readNamed(directory, fileName(taskId, swapId, phase), root);
        if (value) records.push(value.record);
      }
      if (records.length === 0) return null;
      if (records.some((record) => record.taskId !== taskId || record.swapId !== swapId
        || !immutableEqual(record, records[0]))) {
        throw journalError("skill_swap_journal_conflict");
      }
      const phaseIndexes = records.map((record) => PHASES.indexOf(record.phase));
      const clearingSuffix = records.at(-1).phase === "cleanup_committed";
      const firstIndex = clearingSuffix ? phaseIndexes[0] : 0;
      if (phaseIndexes.some((index, position) => index !== firstIndex + position)) {
        throw journalError("skill_swap_phase_order_invalid");
      }
      for (let index = 1; index < records.length; index += 1) {
        const prior = records[index - 1];
        const current = records[index];
        if (prior.phase === "reserved") {
          if (!current.identities.prepared || !current.identities.new) {
            throw journalError("skill_swap_journal_conflict");
          }
        } else if (JSON.stringify(prior.identities) !== JSON.stringify(current.identities)) {
          throw journalError("skill_swap_journal_conflict");
        }
      }
      return { snapshot: records.at(-1), records };
    } finally {
      await directory.close();
    }
  }

  async function record(raw) {
    const normalized = normalizeRecord(raw, root);
    const existing = await load({ taskId: normalized.taskId, swapId: normalized.swapId });
    const expectedIndex = existing ? existing.records.length : 0;
    const phaseIndex = PHASES.indexOf(normalized.phase);
    if (phaseIndex < expectedIndex) {
      const same = existing.records[phaseIndex];
      if (JSON.stringify(same) !== JSON.stringify(normalized)) throw journalError("skill_swap_journal_conflict");
      return same;
    }
    if (phaseIndex !== expectedIndex || (existing && !immutableEqual(existing.snapshot, normalized))) {
      throw journalError("skill_swap_phase_order_invalid");
    }
    if (existing && existing.snapshot.phase !== "reserved"
      && JSON.stringify(existing.snapshot.identities) !== JSON.stringify(normalized.identities)) {
      throw journalError("skill_swap_journal_conflict");
    }
    const directory = await openDirectory();
    const destination = fileName(normalized.taskId, normalized.swapId, normalized.phase);
    const tempName = fileName(normalized.taskId, normalized.swapId, normalized.phase, true);
    try {
      const tempExisting = await readNamed(directory, tempName, root);
      if (tempExisting) {
        if (JSON.stringify(tempExisting.record) !== JSON.stringify(normalized)) {
          throw journalError("skill_swap_journal_conflict");
        }
        await directory.renameEntryNoFollow(tempExisting.entry, destination);
        return normalized;
      }
      const temp = requireFile(await directory.openFileNoFollow(tempName, "wx"), true);
      const entry = temp.entry;
      try {
        await temp.writeFile(`${JSON.stringify(normalized)}\n`, "utf8");
        await temp.sync();
      } finally {
        await temp.close();
      }
      await directory.renameEntryNoFollow(entry, destination);
      return normalized;
    } finally {
      await directory.close();
    }
  }

  async function clear({ taskId, swapId } = {}) {
    const transaction = await load({ taskId, swapId });
    if (!transaction) return false;
    if (transaction.snapshot.phase !== "cleanup_committed") {
      throw journalError("skill_swap_cleanup_not_committed");
    }
    const directory = await openDirectory();
    try {
      for (const recordValue of transaction.records) {
        const opened = await readNamed(directory, fileName(taskId, swapId, recordValue.phase), root);
        if (!opened || JSON.stringify(opened.record) !== JSON.stringify(recordValue)) {
          throw journalError("skill_swap_journal_conflict");
        }
        await directory.unlinkEntryNoFollow(opened.entry);
      }
    } finally {
      await directory.close();
    }
    return true;
  }

  return Object.freeze({ record, load, clear });
}
