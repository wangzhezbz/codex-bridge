import path from "node:path";

import { isValidOwnershipState } from "./path-policy.mjs";

const STATE_LOCKS = new Map();

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
  if (!handle) return { entry: null, value: null };
  try {
    const parsed = JSON.parse(await handle.readFile("utf8"));
    return { entry: handle.entry, value: isValidOwnershipState(parsed, { skillsRoot }) ? parsed : null };
  } catch {
    return { entry: handle.entry, value: null };
  } finally {
    await handle.close();
  }
}

async function openStateDirectory(fsApi, stateDir) {
  return requireDirectoryHandle(await fsApi.openStateDirectoryNoFollow(stateDir));
}

async function withStateLock(stateDir, action) {
  const key = stateDir.toLowerCase();
  const previous = STATE_LOCKS.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => gate, () => gate);
  STATE_LOCKS.set(key, tail);
  await previous.catch(() => {});
  try { return await action(); } finally {
    release();
    if (STATE_LOCKS.get(key) === tail) STATE_LOCKS.delete(key);
  }
}

export function createOwnershipStore({ stateDir, fsApi, skillsRoot }) {
  if (typeof stateDir !== "string" || !path.isAbsolute(stateDir) || !fsApi) {
    throw stateError("ownership_store_invalid");
  }
  if (typeof fsApi.openStateDirectoryNoFollow !== "function") {
    throw stateError("ownership_no_follow_capability_required");
  }
  const mainName = "ownership.json";
  const tempName = "ownership.json.tmp";
  const backupName = "ownership.json.bak";

  async function loadUnlocked() {
    const directory = await openStateDirectory(fsApi, stateDir);
    try {
      const main = await readValidated(directory, mainName, skillsRoot);
      if (main.value) return main.value;
      const backup = await readValidated(directory, backupName, skillsRoot);
      return backup.value ?? emptyState();
    } finally {
      await directory.close();
    }
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
        if (main.value) {
          if (backup.entry) await directory.unlinkEntryNoFollow(backup.entry);
          await directory.renameEntryNoFollow(main.entry, backupName);
        } else {
          await directory.unlinkEntryNoFollow(main.entry);
        }
      } else if (backup.entry && !backup.value) {
        await directory.unlinkEntryNoFollow(backup.entry);
      }
      await directory.renameEntryNoFollow(tempEntry, mainName);
    } finally {
      await directory.close();
    }
  }

  return Object.freeze({
    async load() { return withStateLock(stateDir, loadUnlocked); },
    async compareAndSwap(expectedGeneration, value) {
      if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
        throw stateError("ownership_generation_invalid");
      }
      if (!isValidOwnershipState(value, { skillsRoot })) throw stateError("ownership_state_invalid");
      return withStateLock(stateDir, async () => {
        const current = await loadUnlocked();
        if (current.generation !== expectedGeneration) throw stateError("ownership_generation_conflict");
        const next = { ...structuredClone(value), generation: expectedGeneration + 1 };
        await writeUnlocked(next);
        return next;
      });
    },
    async save(value) {
      if (!isValidOwnershipState(value, { skillsRoot })) throw stateError("ownership_state_invalid");
      return withStateLock(stateDir, async () => {
        const current = await loadUnlocked();
        const next = { ...structuredClone(value), generation: current.generation + 1 };
        await writeUnlocked(next);
        return next;
      });
    },
  });
}
