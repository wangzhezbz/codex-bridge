function recordError(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

async function withRecordDirectory(fileCapabilities, directoryPath, operation) {
  const directory = await fileCapabilities.openStateDirectoryNoFollow(directoryPath);
  if (!directory || typeof directory.openFileNoFollow !== "function"
    || typeof directory.unlinkEntryNoFollow !== "function"
    || typeof directory.renameEntryNoFollow !== "function" || typeof directory.close !== "function") {
    await directory?.close?.().catch(() => {});
    throw recordError("software_manager_record_store_invalid");
  }
  let result;
  let primaryError = null;
  try { result = await operation(directory); } catch (error) { primaryError = error; }
  try { await directory.close(); } catch (error) {
    if (primaryError) throw new AggregateError([primaryError, error], primaryError.message, { cause: primaryError });
    throw error;
  }
  if (primaryError) throw primaryError;
  return result;
}

export function createCapabilityRecordStore({ fileCapabilities, directoryPath, fileName }) {
  const tempName = `${fileName}.tmp`;
  const backupName = `${fileName}.bak`;
  async function readFile(directory, name) {
    const handle = await directory.openFileNoFollow(name, "r");
    if (handle === null) return null;
    try {
      const value = JSON.parse(await handle.readFile("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw recordError("software_manager_record_invalid");
      }
      return value;
    } finally { await handle.close(); }
  }
  async function readCandidate(directory, name) {
    try { return { kind: "value", value: await readFile(directory, name) }; }
    catch (error) {
      if (error instanceof SyntaxError || error?.code === "software_manager_record_invalid") {
        return { kind: "invalid", error };
      }
      throw error;
    }
  }
  return Object.freeze({
    async read() {
      return withRecordDirectory(fileCapabilities, directoryPath, async (directory) => {
        const current = await readCandidate(directory, fileName);
        if (current.kind === "value" && current.value !== null) return current.value;
        const backup = await readCandidate(directory, backupName);
        if (backup.kind === "value" && backup.value !== null) return backup.value;
        if (current.kind === "invalid" || backup.kind === "invalid") {
          const causes = [current, backup].filter(({ kind }) => kind === "invalid").map(({ error }) => error);
          throw new AggregateError(causes, "software_manager_record_store_corrupt", { cause: causes[0] });
        }
        return null;
      });
    },
    async replaceAtomic(value) {
      const lease = await fileCapabilities.acquireStateLockNoFollow(directoryPath);
      if (!lease || typeof lease.release !== "function") throw recordError("software_manager_record_lock_invalid");
      let primaryError = null;
      try {
        await withRecordDirectory(fileCapabilities, directoryPath, async (directory) => {
          const stale = await directory.openFileNoFollow(tempName, "r");
          if (stale) { const entry = stale.entry; await stale.close(); await directory.unlinkEntryNoFollow(entry); }
          const temp = await directory.openFileNoFollow(tempName, "wx");
          if (!temp || typeof temp.writeFile !== "function" || typeof temp.sync !== "function") {
            throw recordError("software_manager_record_file_invalid");
          }
          const tempEntry = temp.entry;
          try { await temp.writeFile(`${JSON.stringify(value)}\n`, "utf8"); await temp.sync(); }
          finally { await temp.close(); }
          const current = await directory.openFileNoFollow(fileName, "r");
          const backup = await directory.openFileNoFollow(backupName, "r");
          if (backup) { const entry = backup.entry; await backup.close(); await directory.unlinkEntryNoFollow(entry); }
          if (current) { const entry = current.entry; await current.close(); await directory.renameEntryNoFollow(entry, backupName); }
          await directory.renameEntryNoFollow(tempEntry, fileName);
        });
      } catch (error) { primaryError = error; }
      try { await lease.release(); } catch (error) {
        if (primaryError) throw new AggregateError([primaryError, error], primaryError.message, { cause: primaryError });
        throw error;
      }
      if (primaryError) throw primaryError;
    },
  });
}
