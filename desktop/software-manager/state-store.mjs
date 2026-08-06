import path from "node:path";

const STATE_KEYS = Object.freeze([
  "schemaVersion",
  "installRoot",
  "components",
  "skills",
  "shortcuts",
  "rollback",
  "activeTask",
  "lastTask",
]);

function stateError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isObjectOrNull(value) {
  return value === null || isPlainObject(value);
}

function isValidState(value) {
  if (!isPlainObject(value) || Object.keys(value).length !== STATE_KEYS.length
    || !STATE_KEYS.every((key) => Object.hasOwn(value, key))) return false;
  return value.schemaVersion === 1
    && (value.installRoot === null || (typeof value.installRoot === "string" && value.installRoot.length > 0))
    && isPlainObject(value.components)
    && isPlainObject(value.skills)
    && Array.isArray(value.shortcuts)
    && (value.rollback === null || Array.isArray(value.rollback) || isPlainObject(value.rollback))
    && isObjectOrNull(value.activeTask)
    && isObjectOrNull(value.lastTask);
}

function emptyState() {
  return {
    schemaVersion: 1,
    installRoot: null,
    components: {},
    skills: {},
    shortcuts: [],
    rollback: null,
    activeTask: null,
    lastTask: null,
  };
}

function isLink(stat) {
  return Boolean(stat?.isSymbolicLink?.() || stat?.isReparsePoint?.());
}

async function inspect(fsApi, target) {
  try {
    return await fsApi.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readValidated(fsApi, target) {
  const stat = await inspect(fsApi, target);
  if (!stat || isLink(stat) || (typeof stat.isFile === "function" && !stat.isFile())) return null;
  try {
    const parsed = JSON.parse(await fsApi.readFile(target, "utf8"));
    return isValidState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function rejectLinkAt(fsApi, target) {
  const stat = await inspect(fsApi, target);
  if (isLink(stat)) throw stateError("ownership_state_reparse_link");
  return stat;
}

export function createOwnershipStore({ stateDir, fsApi }) {
  if (typeof stateDir !== "string" || !path.isAbsolute(stateDir) || !fsApi) {
    throw stateError("ownership_store_invalid");
  }
  const mainPath = path.join(stateDir, "ownership.json");
  const tempPath = path.join(stateDir, "ownership.json.tmp");
  const backupPath = path.join(stateDir, "ownership.json.bak");

  return Object.freeze({
    async load() {
      return await readValidated(fsApi, mainPath)
        ?? await readValidated(fsApi, backupPath)
        ?? emptyState();
    },

    async save(value) {
      if (!isValidState(value)) throw stateError("ownership_state_invalid");
      const tempStat = await rejectLinkAt(fsApi, tempPath);
      if (tempStat) {
        if (typeof fsApi.unlink !== "function") throw stateError("ownership_store_invalid");
        await fsApi.unlink(tempPath);
      }

      const handle = await fsApi.open(tempPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }

      try {
        const mainStat = await rejectLinkAt(fsApi, mainPath);
        const backupStat = await rejectLinkAt(fsApi, backupPath);
        if (mainStat) {
          const current = await readValidated(fsApi, mainPath);
          if (current) {
            if (backupStat) await fsApi.unlink(backupPath);
            await fsApi.rename(mainPath, backupPath);
          } else {
            await fsApi.unlink(mainPath);
          }
        } else if (backupStat && !await readValidated(fsApi, backupPath)) {
          await fsApi.unlink(backupPath);
        }
        await fsApi.rename(tempPath, mainPath);
      } catch (error) {
        throw error;
      }
    },
  });
}
