import fs from "node:fs/promises";
import path from "node:path";

const LOCK_DIRECTORY = ".ownership-test-lock";
const OWNER_FILE = "owner.json";

function missing(error) { return error?.code === "ENOENT"; }
function occupied(error) { return error?.code === "EEXIST"; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

async function removeStaleLock(lockDir) {
  const ownerPath = path.join(lockDir, OWNER_FILE);
  let owner = null;
  try { owner = JSON.parse(await fs.readFile(ownerPath, "utf8")); } catch (error) {
    if (!missing(error) && !(error instanceof SyntaxError)) throw error;
  }
  if (owner && processAlive(owner.pid)) return false;
  if (!owner) {
    const stat = await fs.stat(lockDir).catch((error) => { if (missing(error)) return null; throw error; });
    if (stat && Date.now() - stat.mtimeMs < 1_000) return false;
  }
  await fs.unlink(ownerPath).catch((error) => { if (!missing(error)) throw error; });
  await fs.rmdir(lockDir).catch((error) => { if (!missing(error) && error?.code !== "ENOTEMPTY") throw error; });
  return true;
}

async function acquireTestLock(stateDir) {
  await fs.mkdir(stateDir, { recursive: true });
  const lockDir = path.join(stateDir, LOCK_DIRECTORY);
  const ownerPath = path.join(lockDir, OWNER_FILE);
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await fs.mkdir(lockDir);
      await fs.writeFile(ownerPath, JSON.stringify({ pid: process.pid }), { flag: "wx" });
      let released = false;
      return {
        async release() {
          if (released) throw new Error("test_state_lock_already_released");
          released = true;
          await fs.unlink(ownerPath).catch((error) => { if (!missing(error)) throw error; });
          await fs.rmdir(lockDir).catch((error) => { if (!missing(error)) throw error; });
        },
      };
    } catch (error) {
      if (!occupied(error)) throw error;
      await removeStaleLock(lockDir);
      if (Date.now() >= deadline) throw new Error("test_state_lock_timeout");
      await delay(10);
    }
  }
}

function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }

export function createTestStateFs() {
  return Object.freeze({
    testOnly: true,
    acquireStateLockNoFollow: acquireTestLock,
    async openStateDirectoryNoFollow(stateDir) {
      await fs.mkdir(stateDir, { recursive: true });
      const rootStat = await fs.lstat(stateDir);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("test_state_root_unsafe");
      return {
        async openFileNoFollow(name, flags) {
          if (!/^[a-z0-9._-]+$/iu.test(name) || !["r", "wx"].includes(flags)) throw new Error("test_state_name_invalid");
          const filePath = path.join(stateDir, name);
          let handle;
          try { handle = await fs.open(filePath, flags); } catch (error) {
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
          const stat = await fs.lstat(filePath);
          if (!sameIdentity(entry.identity, stat)) throw new Error("test_state_identity_changed");
          await fs.unlink(filePath);
        },
        async renameEntryNoFollow(entry, destinationName) {
          const sourcePath = path.join(stateDir, entry.name);
          const destinationPath = path.join(stateDir, destinationName);
          const stat = await fs.lstat(sourcePath);
          if (!sameIdentity(entry.identity, stat)) throw new Error("test_state_identity_changed");
          await fs.lstat(destinationPath).then(() => { throw Object.assign(new Error("destination_exists"), { code: "EEXIST" }); }, (error) => {
            if (!missing(error)) throw error;
          });
          await fs.rename(sourcePath, destinationPath);
        },
        async close() {},
      };
    },
  });
}

export async function acquireTestStateLock(stateDir) {
  return acquireTestLock(stateDir);
}
