import crypto from "node:crypto";
import path from "node:path";

const PHASES = Object.freeze(["intent", "bound", "sealed", "deleting"]);
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const FILE_NAME = /^skill-prepare-([a-f0-9]{64})\.(intent|bound|sealed|deleting)\.json$/u;
const TEMP_FILE_NAME = /^skill-prepare-([a-f0-9]{64})\.(intent|bound|sealed|deleting)\.json\.tmp$/u;
const LEASE_NONCE = /^[a-f0-9]{32}$/u;

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
    throw journalError("skill_prepare_record_invalid");
  }
  const segments = value.slice(3).split("\\");
  if (segments.some((segment) => !segment || segment === "." || segment === ".."
    || /[<>:"|?*\u0000-\u001f]/u.test(segment) || /[ .]$/u.test(segment))) {
    throw journalError("skill_prepare_record_invalid");
  }
  return value;
}

function identity(value, nullable = false) {
  if (nullable && value === null) return null;
  if (!exact(value, ["volumeSerial", "fileId"])
    || typeof value.volumeSerial !== "string" || value.volumeSerial.length === 0
    || typeof value.fileId !== "string" || value.fileId.length === 0) {
    throw journalError("skill_prepare_record_invalid");
  }
  return { volumeSerial: value.volumeSerial, fileId: value.fileId };
}

function evidence(value, nullable = false) {
  if (nullable && value === null) return null;
  if (!exact(value, ["kind", "identity", "treeDigest", "manifestDigest", "skillMdSha256"])
    || value.kind !== "directory" || !SHA256.test(value.treeDigest ?? "")
    || !SHA256.test(value.manifestDigest ?? "") || !SHA256.test(value.skillMdSha256 ?? "")) {
    throw journalError("skill_prepare_record_invalid");
  }
  return { ...structuredClone(value), identity: identity(value.identity) };
}

function recordKey(taskId, skillId) {
  return crypto.createHash("sha256").update(`${taskId}\0${skillId}`, "utf8").digest("hex");
}

function fileName(taskId, skillId, phase, temp = false) {
  return `skill-prepare-${recordKey(taskId, skillId)}.${phase}.json${temp ? ".tmp" : ""}`;
}

function normalizeRecord(value, installRoot) {
  if (!exact(value, [
    "schemaVersion", "phase", "taskId", "skillId", "installRoot", "sourcePath", "leaseScope", "leaseNonce",
    "identity", "evidence",
  ]) || value.schemaVersion !== 1 || !PHASES.includes(value.phase)
    || !TASK_ID.test(value.taskId ?? "") || !SKILL_ID.test(value.skillId ?? "")
    || value.leaseScope !== "prepare" || !LEASE_NONCE.test(value.leaseNonce ?? "")) {
    throw journalError("skill_prepare_record_invalid");
  }
  const root = canonical(installRoot);
  const expectedSource = path.win32.join(
    root, "staging", `task-${value.taskId}`, `skill-${value.skillId}.prepare`,
  );
  if (value.installRoot !== root || canonical(value.sourcePath) !== expectedSource) {
    throw journalError("skill_prepare_record_invalid");
  }
  const boundIdentity = identity(value.identity, true);
  const sealedEvidence = evidence(value.evidence, true);
  if (value.phase === "intent" ? (boundIdentity !== null || sealedEvidence !== null)
    : value.phase === "bound" ? (boundIdentity === null || sealedEvidence !== null)
      : value.phase === "sealed" ? (boundIdentity === null || sealedEvidence === null
        || JSON.stringify(boundIdentity) !== JSON.stringify(sealedEvidence.identity))
        : (boundIdentity === null || (sealedEvidence !== null
          && JSON.stringify(boundIdentity) !== JSON.stringify(sealedEvidence.identity)))) {
    throw journalError("skill_prepare_record_invalid");
  }
  return {
    schemaVersion: 1,
    phase: value.phase,
    taskId: value.taskId,
    skillId: value.skillId,
    installRoot: root,
    sourcePath: expectedSource,
    leaseScope: "prepare",
    leaseNonce: value.leaseNonce,
    identity: boundIdentity,
    evidence: sealedEvidence,
  };
}

function requireDirectory(value) {
  if (!value || typeof value.listFileNamesNoFollow !== "function"
    || typeof value.openFileNoFollow !== "function" || typeof value.unlinkEntryNoFollow !== "function"
    || typeof value.renameEntryNoFollow !== "function" || typeof value.close !== "function") {
    throw journalError("skill_prepare_journal_capability_invalid");
  }
  return value;
}

function requireFile(value, writable = false) {
  if (!value || !value.entry || typeof value.readFile !== "function" || typeof value.close !== "function"
    || (writable && (typeof value.writeFile !== "function" || typeof value.sync !== "function"))) {
    throw journalError("skill_prepare_journal_file_invalid");
  }
  return value;
}

function sameRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isOccupied(error) {
  return error?.code === "entry_exists" || error?.code === "EEXIST"
    || error?.nativeCode === 80 || error?.nativeCode === 183;
}

function isSharingViolation(error) {
  return error?.code === "sharing_violation" || error?.nativeCode === 32 || error?.nativeCode === 33;
}

function isMissingOrStale(error) {
  return error?.code === "entry_missing" || error?.code === "ENOENT"
    || error?.code === "stale_entry_identity" || error?.nativeCode === 2 || error?.nativeCode === 3;
}

async function readNamed(directory, name, installRoot) {
  const opened = await directory.openFileNoFollow(name, "r");
  if (opened === null) return null;
  const file = requireFile(opened);
  try {
    const record = normalizeRecord(JSON.parse(await file.readFile("utf8")), installRoot);
    const match = FILE_NAME.exec(name) ?? TEMP_FILE_NAME.exec(name);
    if (!match || match[1] !== recordKey(record.taskId, record.skillId) || match[2] !== record.phase) {
      throw journalError("skill_prepare_journal_conflict");
    }
    return { entry: file.entry, record };
  } catch (error) {
    if (error?.code?.startsWith("skill_prepare_")) throw error;
    throw journalError("skill_prepare_journal_corrupt", error);
  } finally {
    await file.close();
  }
}

export function createSkillPrepareJournal({ journalDir, fsApi, installRoot } = {}) {
  if (!fsApi || typeof fsApi.openJournalDirectoryNoFollow !== "function") {
    throw journalError("skill_prepare_journal_capability_required");
  }
  const root = canonical(installRoot);
  canonical(journalDir);

  async function openDirectory() {
    return requireDirectory(await fsApi.openJournalDirectoryNoFollow(journalDir));
  }

  async function readPhase(directory, taskId, skillId, phase) {
    const final = await readNamed(directory, fileName(taskId, skillId, phase), root);
    const temp = await readNamed(directory, fileName(taskId, skillId, phase, true), root);
    if (final && temp && !sameRecord(final.record, temp.record)) {
      throw journalError("skill_prepare_journal_conflict");
    }
    return { final, temp, record: final?.record ?? temp?.record ?? null };
  }

  async function settleTemp(directory, opened, destination, expectedRecord) {
    const { temp } = opened;
    const final = opened.final === undefined
      ? await readNamed(directory, destination, root)
      : opened.final;
    if (final) {
      if (!sameRecord(final.record, expectedRecord)
        || (temp && !sameRecord(temp.record, expectedRecord))) {
        throw journalError("skill_prepare_journal_conflict");
      }
      if (temp) await directory.unlinkEntryNoFollow(temp.entry);
      return expectedRecord;
    }
    if (!temp) throw journalError("skill_prepare_journal_conflict");
    if (!sameRecord(temp.record, expectedRecord)) {
      throw journalError("skill_prepare_journal_conflict");
    }
    try {
      await directory.renameEntryNoFollow(temp.entry, destination);
      return expectedRecord;
    } catch (error) {
      const published = await readNamed(directory, destination, root);
      if (!published || !sameRecord(published.record, expectedRecord)) throw error;
      if (isOccupied(error)) await directory.unlinkEntryNoFollow(temp.entry);
      return expectedRecord;
    }
  }

  function checkedNames(value) {
    if (!Array.isArray(value) || value.length > 4_096) {
      throw journalError("skill_prepare_journal_limit_exceeded");
    }
    for (const name of value) {
      if (typeof name !== "string") throw journalError("skill_prepare_journal_corrupt");
      if (name.startsWith("skill-prepare-") && !FILE_NAME.test(name) && !TEMP_FILE_NAME.test(name)) {
        throw journalError("skill_prepare_journal_corrupt");
      }
    }
    return value;
  }

  async function load({ taskId, skillId } = {}) {
    if (!TASK_ID.test(taskId ?? "") || !SKILL_ID.test(skillId ?? "")) {
      throw journalError("skill_prepare_lookup_invalid");
    }
    const directory = await openDirectory();
    try {
      const records = [];
      for (const phase of PHASES) {
        const value = await readPhase(directory, taskId, skillId, phase);
        if (value.record) records.push(value.record);
      }
      if (records.length === 0) return null;
      const phases = records.map((record) => record.phase);
      const validPaths = [
        ["intent"], ["intent", "bound"], ["intent", "bound", "sealed"],
        ["intent", "bound", "deleting"], ["intent", "bound", "sealed", "deleting"],
      ];
      const clearingSuffix = phases.at(-1) === "deleting";
      const validOrder = validPaths.some((candidate) => {
        if (clearingSuffix) return candidate.slice(-phases.length).join("\0") === phases.join("\0");
        return candidate.length === phases.length && candidate.join("\0") === phases.join("\0");
      });
      if (!validOrder
        || records.some((record) => record.taskId !== taskId || record.skillId !== skillId)) {
        throw journalError("skill_prepare_phase_order_invalid");
      }
      for (let index = 1; index < records.length; index += 1) {
        const prior = records[index - 1];
        const current = records[index];
        if (prior.sourcePath !== current.sourcePath || prior.installRoot !== current.installRoot
          || prior.leaseScope !== current.leaseScope || prior.leaseNonce !== current.leaseNonce
          || (prior.identity && JSON.stringify(prior.identity) !== JSON.stringify(current.identity))
          || (current.phase === "deleting"
            && JSON.stringify(prior.evidence) !== JSON.stringify(current.evidence))) {
          throw journalError("skill_prepare_journal_conflict");
        }
      }
      return { snapshot: records.at(-1), records };
    } finally {
      await directory.close();
    }
  }

  async function list({ claimLease } = {}) {
    const directory = await openDirectory();
    const liveHashes = new Set();
    try {
      const names = checkedNames(await directory.listFileNamesNoFollow());
      const pendingTemps = [];
      for (const name of names) {
        const tempMatch = TEMP_FILE_NAME.exec(name);
        if (!tempMatch) continue;
        let temp;
        try {
          temp = await readNamed(directory, name, root);
        } catch (error) {
          if (!isSharingViolation(error)) throw error;
          liveHashes.add(tempMatch[1]);
          continue;
        }
        if (!temp) continue;
        pendingTemps.push({ name, hash: tempMatch[1], temp });
      }
      for (const { name, hash, temp } of pendingTemps) {
        if (liveHashes.has(hash)) continue;
        if (typeof claimLease !== "function") {
          throw journalError("skill_prepare_lease_claim_required");
        }
        const lease = await claimLease({
          nonce: temp.record.leaseNonce, scope: temp.record.leaseScope,
        });
        if (lease === null) {
          liveHashes.add(hash);
          continue;
        }
        if (!lease || typeof lease.release !== "function") {
          throw journalError("skill_prepare_lease_claim_invalid");
        }
        const destination = name.slice(0, -4);
        try {
          await settleTemp(directory, { temp, final: undefined }, destination, temp.record);
        } catch (error) {
          if (!isMissingOrStale(error)) throw error;
        } finally {
          await lease.release();
        }
      }
    } finally {
      await directory.close();
    }
    const pairs = new Map();
    const directoryForRead = await openDirectory();
    try {
      const names = checkedNames(await directoryForRead.listFileNamesNoFollow());
      for (const name of names) {
        const finalMatch = FILE_NAME.exec(name);
        if (!finalMatch || liveHashes.has(finalMatch[1])) continue;
        const opened = await readNamed(directoryForRead, name, root);
        if (!opened) continue;
        const key = `${opened.record.taskId}\0${opened.record.skillId}`;
        pairs.set(key, { taskId: opened.record.taskId, skillId: opened.record.skillId });
      }
    } finally {
      await directoryForRead.close();
    }
    const result = [];
    for (const pair of pairs.values()) {
      const transaction = await load(pair);
      if (transaction) result.push(transaction.snapshot);
    }
    return result;
  }

  async function record(raw) {
    const normalized = normalizeRecord(raw, root);
    const existing = await load({ taskId: normalized.taskId, skillId: normalized.skillId });
    const priorPhase = existing?.snapshot.phase ?? null;
    if (existing?.records.some((item) => item.phase === normalized.phase)) {
      const prior = existing.records.find((item) => item.phase === normalized.phase);
      if (!prior || !sameRecord(prior, normalized)) {
        throw journalError("skill_prepare_journal_conflict");
      }
      const directory = await openDirectory();
      try {
        const opened = await readPhase(
          directory, normalized.taskId, normalized.skillId, normalized.phase,
        );
        return await settleTemp(directory, opened,
          fileName(normalized.taskId, normalized.skillId, normalized.phase), normalized);
      } finally {
        await directory.close();
      }
    }
    const allowed = priorPhase === null ? normalized.phase === "intent"
      : priorPhase === "intent" ? normalized.phase === "bound"
        : priorPhase === "bound" ? ["sealed", "deleting"].includes(normalized.phase)
          : priorPhase === "sealed" ? normalized.phase === "deleting" : false;
    if (!allowed) throw journalError("skill_prepare_phase_order_invalid");
    const directory = await openDirectory();
    const destination = fileName(normalized.taskId, normalized.skillId, normalized.phase);
    const tempName = fileName(normalized.taskId, normalized.skillId, normalized.phase, true);
    try {
      const existingTemp = await readNamed(directory, tempName, root);
      if (existingTemp) {
        if (!sameRecord(existingTemp.record, normalized)) {
          throw journalError("skill_prepare_journal_conflict");
        }
        return await settleTemp(
          directory, { temp: existingTemp, final: undefined }, destination, normalized,
        );
      }
      const temp = requireFile(await directory.openFileNoFollow(tempName, "wx"), true);
      try {
        await temp.writeFile(`${JSON.stringify(normalized)}\n`, "utf8");
        await temp.sync();
      } finally {
        await temp.close();
      }
      return await settleTemp(directory, {
        temp: { entry: temp.entry, record: normalized }, final: undefined,
      }, destination, normalized);
    } finally {
      await directory.close();
    }
  }

  async function clear({ taskId, skillId } = {}) {
    const transaction = await load({ taskId, skillId });
    if (!transaction) return false;
    const directory = await openDirectory();
    try {
      for (const record of transaction.records) {
        const opened = await readPhase(directory, taskId, skillId, record.phase);
        if (!opened.record || !sameRecord(opened.record, record)) {
          throw journalError("skill_prepare_journal_conflict");
        }
        if (opened.final) await directory.unlinkEntryNoFollow(opened.final.entry);
        if (opened.temp) await directory.unlinkEntryNoFollow(opened.temp.entry);
      }
    } finally {
      await directory.close();
    }
    return true;
  }

  return Object.freeze({ record, load, list, clear });
}
