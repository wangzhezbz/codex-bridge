import * as fsPromises from "node:fs/promises";
import { createHash } from "node:crypto";

function executionError(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function requireMethod(owner, name, code) {
  if (typeof owner?.[name] !== "function") throw executionError(code);
  return owner[name].bind(owner);
}

async function closePinWithPrimary(pin, primaryError) {
  let closeError = null;
  try { await pin.close(); } catch (error) { closeError = error; }
  if (closeError) {
    throw new AggregateError([primaryError, closeError], primaryError.message, { cause: primaryError });
  }
  throw primaryError;
}

export async function hashPinnedFile(fileCapabilities, filePath, maxBytes = 16 * 1_024 * 1_024) {
  const pin = await fileCapabilities.pinArchiveFileNoFollow(filePath);
  if (!pin || typeof pin.assertStableNoFollow !== "function" || typeof pin.close !== "function") {
    const invalid = executionError("software_manager_file_pin_invalid");
    if (pin && typeof pin.close === "function") return closePinWithPrimary(pin, invalid);
    throw invalid;
  }
  let primaryError = null;
  let digest;
  try {
    await pin.assertStableNoFollow();
    const handle = await fsPromises.open(filePath, "r");
    try {
      const hash = createHash("sha256");
      let total = 0;
      for await (const chunk of handle.createReadStream()) {
        total += chunk.length;
        if (!Number.isSafeInteger(total) || total > maxBytes) {
          throw executionError("software_manager_file_too_large");
        }
        hash.update(chunk);
      }
      digest = hash.digest("hex");
    } finally { await handle.close(); }
    await pin.assertStableNoFollow();
  } catch (error) { primaryError = error; }
  if (primaryError) return closePinWithPrimary(pin, primaryError);
  return { digest, pin };
}

export function createPinnedSevenZipExecution({
  fileCapabilities, sevenZipPath, sevenZipSha256, execFile, spawn,
}) {
  const run = requireMethod({ execFile }, "execFile", "software_manager_exec_file_required");
  const start = requireMethod({ spawn }, "spawn", "software_manager_spawn_required");
  async function pin() {
    const pinned = await hashPinnedFile(fileCapabilities, sevenZipPath);
    if (pinned.digest !== sevenZipSha256) {
      return closePinWithPrimary(pinned.pin, executionError("software_manager_7z_hash_mismatch"));
    }
    return pinned.pin;
  }
  async function closeAfterCompletion(completed, held) {
    let result;
    let primaryError = null;
    try { result = await completed; } catch (error) { primaryError = error; }
    let closeError = null;
    try { await held.close(); } catch (error) { closeError = error; }
    if (primaryError && closeError) {
      throw new AggregateError([primaryError, closeError], primaryError.message, { cause: primaryError });
    }
    if (primaryError) throw primaryError;
    if (closeError) throw closeError;
    return result;
  }
  async function settleInvalidChild(child, held, primaryError, { cancel = null, completed = null } = {}) {
    const errors = [primaryError];
    try {
      if (typeof cancel === "function") await cancel.call(child);
    } catch (error) { errors.push(error); }
    if (completed && typeof completed.then === "function") {
      let timer = null;
      try {
        await Promise.race([
          Promise.resolve(completed).catch(() => {}),
          new Promise((resolve) => { timer = setTimeout(resolve, 250); }),
        ]);
      } finally { if (timer !== null) clearTimeout(timer); }
    }
    try { await held.close(); } catch (error) { errors.push(error); }
    if (errors.length > 1) throw new AggregateError(errors, primaryError.message, { cause: primaryError });
    throw primaryError;
  }
  return Object.freeze({
    async spawnFile(file, args, options) {
      if (file !== sevenZipPath) throw executionError("software_manager_7z_path_rejected");
      const held = await pin();
      return closeAfterCompletion(Promise.resolve().then(() => run(file, args, options)), held);
    },
    async spawnStream(file, args, options) {
      if (file !== sevenZipPath) throw executionError("software_manager_7z_path_rejected");
      const held = await pin();
      let child;
      try { child = await start(file, args, options); }
      catch (error) { return closePinWithPrimary(held, error); }
      let stdout;
      let stderr;
      let completed;
      let cancel;
      try {
        stdout = child?.stdout;
        stderr = child?.stderr;
        completed = child?.completed;
        cancel = child?.cancel;
      } catch (error) {
        return settleInvalidChild(
          child, held, executionError("software_manager_spawn_result_invalid", error), { cancel, completed },
        );
      }
      if (!child || typeof child !== "object" || !stdout || typeof stdout.pipe !== "function"
        || !stderr || typeof stderr[Symbol.asyncIterator] !== "function"
        || !completed || typeof completed.then !== "function" || typeof cancel !== "function") {
        return settleInvalidChild(
          child, held, executionError("software_manager_spawn_result_invalid"), { cancel, completed },
        );
      }
      return Object.freeze({
        stdout,
        stderr,
        cancel: cancel.bind(child),
        completed: closeAfterCompletion(Promise.resolve(completed), held),
      });
    },
  });
}
