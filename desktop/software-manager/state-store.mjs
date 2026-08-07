import path from "node:path";

import { isValidOwnershipState } from "./path-policy.mjs";

const STATE_LOCKS = new Map();
const LEGACY_OWNERSHIP_KEYS = Object.freeze([
  "schemaVersion", "installRoot", "components", "skills", "shortcuts", "rollback", "activeTask", "lastTask",
]);
const OPERATION_LEASE_NONCE = /^[a-f0-9]{32}$/u;
const OPERATION_LEASE_SCOPES = new Set(["prepare", "git-execute"]);
const OWNERSHIP_KEYS = Object.freeze([...LEGACY_OWNERSHIP_KEYS, "generation"]);

function stateError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function emptyState() {
  return {
    schemaVersion: 1,
    generation: 0,
    installRoot: null,
    components: {},
    skills: {},
    shortcuts: [],
    rollback: null,
    activeTask: null,
    lastTask: null,
  };
}

function plainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactRecord(value, keys) {
  return plainRecord(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function migrateKnownRound3Task(value) {
  if (!exactRecord(value, OWNERSHIP_KEYS) || !Number.isSafeInteger(value.generation) || value.generation < 0) return null;
  const task = value.activeTask;
  let migratedTask = null;
  if (exactRecord(task, ["kind", "taskId", "componentId", "version"])
    && task.kind === "component-prepare") {
    migratedTask = {
      kind: "legacy-abandoned-prepare", originalKind: task.kind,
      taskId: task.taskId, componentId: task.componentId, version: task.version,
    };
  } else if (exactRecord(task, ["kind", "taskId", "skillId", "version"])
    && task.kind === "skill-prepare") {
    migratedTask = {
      kind: "legacy-abandoned-prepare", originalKind: task.kind,
      taskId: task.taskId, componentId: task.skillId, version: task.version,
    };
  } else if (exactRecord(task, [
    "kind", "taskId", "version", "targetDir", "executablePath", "installerPath", "installerSha256", "replacedInstaller",
  ]) && task.kind === "git-install") {
    migratedTask = { ...structuredClone(task), kind: "legacy-git-install-recovery" };
  }
  if (migratedTask === null) return null;
  const migrated = structuredClone(value);
  migrated.activeTask = migratedTask;
  return migrated;
}

function requireDirectoryHandle(handle) {
  if (!handle || typeof handle.openFileNoFollow !== "function"
    || typeof handle.unlinkEntryNoFollow !== "function" || typeof handle.renameEntryNoFollow !== "function"
    || typeof handle.close !== "function") {
    throw stateError("ownership_no_follow_capability_invalid");
  }
  return handle;
}

function requireFileHandle(handle) {
  if (!handle || !handle.entry || typeof handle.readFile !== "function" || typeof handle.close !== "function") {
    throw stateError("ownership_no_follow_file_invalid");
  }
  return handle;
}

async function openExisting(directory, name) {
  const handle = await directory.openFileNoFollow(name, "r");
  return handle === null ? null : requireFileHandle(handle);
}

async function readValidated(directory, name, skillsRoot) {
  const handle = await openExisting(directory, name);
  if (!handle) return { entry: null, status: "missing", value: null };
  try {
    let parsed;
    try { parsed = JSON.parse(await handle.readFile("utf8")); } catch {
      return { entry: handle.entry, status: "corrupt", value: null };
    }
    if (isValidOwnershipState(parsed, { skillsRoot })) {
      return { entry: handle.entry, status: "current", value: parsed };
    }
    const round3 = migrateKnownRound3Task(parsed);
    if (round3 && isValidOwnershipState(round3, { skillsRoot })) {
      return { entry: handle.entry, status: "legacy", value: round3 };
    }
    const plain = plainRecord(parsed);
    if (plain && Object.keys(parsed).length === LEGACY_OWNERSHIP_KEYS.length
      && LEGACY_OWNERSHIP_KEYS.every((key) => Object.hasOwn(parsed, key))) {
      const migrated = { ...structuredClone(parsed), generation: 0 };
      const taskMigrated = migrateKnownRound3Task(migrated) ?? migrated;
      if (isValidOwnershipState(taskMigrated, { skillsRoot })) {
        return { entry: handle.entry, status: "legacy", value: taskMigrated };
      }
    }
    return { entry: handle.entry, status: "invalid", value: null };
  } catch {
    return { entry: handle.entry, status: "corrupt", value: null };
  } finally {
    await handle.close();
  }
}

function usable(record) {
  return record.status === "current" || record.status === "legacy";
}

async function openStateDirectory(fsApi, stateDir) {
  return requireDirectoryHandle(await fsApi.openStateDirectoryNoFollow(stateDir));
}

async function withStateLock(stateDir, fsApi, action) {
  const key = stateDir.toLowerCase();
  const previous = STATE_LOCKS.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => gate, () => gate);
  STATE_LOCKS.set(key, tail);
  await previous.catch(() => {});
  let processLock;
  let result;
  let primaryError;
  try {
    processLock = await fsApi.acquireStateLockNoFollow(stateDir);
    if (!processLock || typeof processLock.release !== "function") {
      throw stateError("ownership_state_lock_capability_invalid");
    }
    result = await action();
  } catch (error) {
    primaryError = error;
  } finally {
    let releaseError;
    try {
      if (processLock) await processLock.release();
    } catch (error) {
      releaseError = error;
    } finally {
      release();
      if (STATE_LOCKS.get(key) === tail) STATE_LOCKS.delete(key);
    }
    if (primaryError && releaseError) {
      throw new AggregateError([primaryError, releaseError], primaryError.message, { cause: primaryError });
    }
    if (releaseError) throw releaseError;
  }
  if (primaryError) throw primaryError;
  return result;
}

export function createOwnershipStore({ stateDir, fsApi, skillsRoot }) {
  if (typeof stateDir !== "string" || !path.isAbsolute(stateDir) || !fsApi) {
    throw stateError("ownership_store_invalid");
  }
  if (typeof fsApi.openStateDirectoryNoFollow !== "function") {
    throw stateError("ownership_no_follow_capability_required");
  }
  if (typeof fsApi.acquireStateLockNoFollow !== "function") {
    throw stateError("ownership_state_lock_capability_required");
  }
  if (typeof fsApi.acquireOperationLeaseNoFollow !== "function") {
    throw stateError("ownership_operation_lease_capability_required");
  }
  const mainName = "ownership.json";
  const tempName = "ownership.json.tmp";
  const backupName = "ownership.json.bak";

  async function loadUnlocked() {
    const directory = await openStateDirectory(fsApi, stateDir);
    let selected;
    let main;
    let backup;
    try {
      main = await readValidated(directory, mainName, skillsRoot);
      if (usable(main)) selected = main;
      else {
        backup = await readValidated(directory, backupName, skillsRoot);
        if (usable(backup)) selected = backup;
      }
    } finally {
      await directory.close();
    }
    if (selected) {
      if (selected.status === "legacy") await writeUnlocked(selected.value);
      return selected.value;
    }
    if (main?.status === "invalid" || backup?.status === "invalid") {
      throw stateError("ownership_state_invalid");
    }
    return emptyState();
  }

  async function writeUnlocked(value) {
    if (!isValidOwnershipState(value, { skillsRoot })) throw stateError("ownership_state_invalid");
    const directory = await openStateDirectory(fsApi, stateDir);
    try {
      const existingTemp = await openExisting(directory, tempName);
      if (existingTemp) {
        const entry = existingTemp.entry;
        await existingTemp.close();
        await directory.unlinkEntryNoFollow(entry);
      }
      const temp = requireFileHandle(await directory.openFileNoFollow(tempName, "wx"));
      if (typeof temp.writeFile !== "function" || typeof temp.sync !== "function") {
        await temp.close();
        throw stateError("ownership_no_follow_file_invalid");
      }
      const tempEntry = temp.entry;
      try {
        await temp.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
        await temp.sync();
      } finally {
        await temp.close();
      }
      const main = await readValidated(directory, mainName, skillsRoot);
      const backup = await readValidated(directory, backupName, skillsRoot);
      if (main.entry) {
        if (usable(main)) {
          if (backup.entry) await directory.unlinkEntryNoFollow(backup.entry);
          await directory.renameEntryNoFollow(main.entry, backupName);
        } else {
          await directory.unlinkEntryNoFollow(main.entry);
        }
      } else if (backup.entry && !usable(backup)) {
        await directory.unlinkEntryNoFollow(backup.entry);
      }
      await directory.renameEntryNoFollow(tempEntry, mainName);
    } finally {
      await directory.close();
    }
  }

  return Object.freeze({
    async acquireOperationLease({ nonce, scope, wait = true } = {}) {
      if (!OPERATION_LEASE_NONCE.test(nonce ?? "") || !OPERATION_LEASE_SCOPES.has(scope)
        || typeof wait !== "boolean") throw stateError("ownership_operation_lease_request_invalid");
      const lease = await fsApi.acquireOperationLeaseNoFollow(stateDir, { nonce, scope, wait });
      if (lease === null && !wait) return null;
      if (!lease || lease.nonce !== nonce || lease.scope !== scope || typeof lease.release !== "function") {
        throw stateError("ownership_operation_lease_capability_invalid");
      }
      return lease;
    },
    async load() { return withStateLock(stateDir, fsApi, loadUnlocked); },
    async compareAndSwap(expectedGeneration, value) {
      if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
        throw stateError("ownership_generation_invalid");
      }
      if (!isValidOwnershipState(value, { skillsRoot })) throw stateError("ownership_state_invalid");
      return withStateLock(stateDir, fsApi, async () => {
        const current = await loadUnlocked();
        if (current.generation !== expectedGeneration) throw stateError("ownership_generation_conflict");
        const next = { ...structuredClone(value), generation: expectedGeneration + 1 };
        await writeUnlocked(next);
        return next;
      });
    },
    async save(value) {
      if (!isValidOwnershipState(value, { skillsRoot })) throw stateError("ownership_state_invalid");
      return withStateLock(stateDir, fsApi, async () => {
        const current = await loadUnlocked();
        const next = { ...structuredClone(value), generation: current.generation + 1 };
        await writeUnlocked(next);
        return next;
      });
    },
  });
}
