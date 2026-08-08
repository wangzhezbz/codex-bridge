import fs from "node:fs/promises";
import path from "node:path";

const LOCK_DIRECTORY = ".ownership-test-lock";
const OWNER_FILE = "owner.json";

function missing(error) { return error?.code === "ENOENT"; }
function occupied(error) { return error?.code === "EEXIST"; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function transientWindowsMutation(error) { return error?.code === "EPERM" || error?.code === "EBUSY"; }

async function retryTransientWindowsMutation(operation) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await operation(); } catch (error) {
      if (!transientWindowsMutation(error) || attempt >= 5) throw error;
      await delay(5 * (2 ** attempt));
    }
  }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

async function removeStaleLock(lockDir, fileSystem = fs) {
  const ownerPath = path.join(lockDir, OWNER_FILE);
  let owner = null;
  try { owner = JSON.parse(await fileSystem.readFile(ownerPath, "utf8")); } catch (error) {
    if (!missing(error) && !(error instanceof SyntaxError)) throw error;
  }
  if (owner && processAlive(owner.pid)) return false;
  if (!owner) {
    const stat = await fileSystem.stat(lockDir).catch((error) => { if (missing(error)) return null; throw error; });
    if (stat && Date.now() - stat.mtimeMs < 1_000) return false;
  }
  await retryTransientWindowsMutation(() => fileSystem.unlink(ownerPath)).catch((error) => { if (!missing(error)) throw error; });
  await retryTransientWindowsMutation(() => fileSystem.rmdir(lockDir)).catch((error) => { if (!missing(error) && error?.code !== "ENOTEMPTY") throw error; });
  return true;
}

async function acquireTestLockDirectory(stateDir, lockDirectoryName, wait = true, fileSystem = fs) {
  await fileSystem.mkdir(stateDir, { recursive: true });
  const lockDir = path.join(stateDir, lockDirectoryName);
  const ownerPath = path.join(lockDir, OWNER_FILE);
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await fileSystem.mkdir(lockDir);
      await fileSystem.writeFile(ownerPath, JSON.stringify({ pid: process.pid }), { flag: "wx" });
      let released = false;
      return {
        async release() {
          if (released) throw new Error("test_state_lock_already_released");
          released = true;
          await retryTransientWindowsMutation(() => fileSystem.unlink(ownerPath))
            .catch((error) => { if (!missing(error)) throw error; });
          await retryTransientWindowsMutation(() => fileSystem.rmdir(lockDir))
            .catch((error) => { if (!missing(error)) throw error; });
        },
      };
    } catch (error) {
      if (!occupied(error)) throw error;
      const removed = await removeStaleLock(lockDir, fileSystem);
      if (!wait && !removed) return null;
      if (Date.now() >= deadline) throw new Error("test_state_lock_timeout");
      await delay(10);
    }
  }
}

async function acquireTestLock(stateDir, fileSystem = fs) {
  return acquireTestLockDirectory(stateDir, LOCK_DIRECTORY, true, fileSystem);
}

async function acquireTestOperationLease(stateDir, { nonce, scope, wait = true }, fileSystem = fs) {
  if (!/^[a-f0-9]{32}$/u.test(nonce ?? "") || !["prepare", "git-execute"].includes(scope)) {
    throw new Error("test_operation_lease_invalid");
  }
  const lock = await acquireTestLockDirectory(stateDir, `.ownership-test-operation-${scope}-${nonce}`, wait, fileSystem);
  return lock === null ? null : { nonce, scope, release: lock.release };
}

function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }

export function createTestStateFs({ fsImpl = fs } = {}) {
  return Object.freeze({
    testOnly: true,
    acquireStateLockNoFollow: (stateDir) => acquireTestLock(stateDir, fsImpl),
    acquireOperationLeaseNoFollow: (stateDir, request) => acquireTestOperationLease(stateDir, request, fsImpl),
    async openStateDirectoryNoFollow(stateDir) {
      await fsImpl.mkdir(stateDir, { recursive: true });
      const rootStat = await fsImpl.lstat(stateDir);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("test_state_root_unsafe");
      return {
        async openFileNoFollow(name, flags) {
          if (!/^[a-z0-9._-]+$/iu.test(name) || !["r", "wx"].includes(flags)) throw new Error("test_state_name_invalid");
          const filePath = path.join(stateDir, name);
          let handle;
          try { handle = await fsImpl.open(filePath, flags); } catch (error) {
            if (flags === "r" && missing(error)) return null;
            throw error;
          }
          const stat = await handle.stat();
          if (!stat.isFile() || stat.isSymbolicLink?.()) { await handle.close(); throw new Error("test_state_file_unsafe"); }
          const entry = Object.freeze({ name, identity: { dev: stat.dev, ino: stat.ino } });
          return {
            entry,
            async readFile(encoding) { return handle.readFile(encoding); },
            async writeFile(value, encoding) { await handle.writeFile(value, encoding); },
            async sync() { await handle.sync(); },
            async close() { await handle.close(); },
          };
        },
        async unlinkEntryNoFollow(entry) {
          const filePath = path.join(stateDir, entry.name);
          const stat = await fsImpl.lstat(filePath);
          if (!sameIdentity(entry.identity, stat)) throw new Error("test_state_identity_changed");
          await retryTransientWindowsMutation(() => fsImpl.unlink(filePath));
        },
        async renameEntryNoFollow(entry, destinationName) {
          const sourcePath = path.join(stateDir, entry.name);
          const destinationPath = path.join(stateDir, destinationName);
          await retryTransientWindowsMutation(async () => {
            const stat = await fsImpl.lstat(sourcePath);
            if (!sameIdentity(entry.identity, stat)) throw new Error("test_state_identity_changed");
            await fsImpl.lstat(destinationPath).then(() => { throw Object.assign(new Error("destination_exists"), { code: "EEXIST" }); }, (error) => {
              if (!missing(error)) throw error;
            });
            await fsImpl.rename(sourcePath, destinationPath);
          });
        },
        async close() {},
      };
    },
  });
}

export async function acquireTestStateLock(stateDir) {
  return acquireTestLock(stateDir);
}
