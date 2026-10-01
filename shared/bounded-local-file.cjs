"use strict";

const fs = require("node:fs");

async function readBoundedLocalFile(filePath, options = {}) {
  const maxBytes = positiveByteLimit(options.maxBytes);
  const checked = await fs.promises.lstat(filePath, { bigint: true });
  if (!checked.isFile() || checked.isSymbolicLink()) throw notFileError();
  let handle = null;
  let primaryError = null;
  try {
    handle = await fs.promises.open(filePath, "r");
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(checked, opened)) throw changedError();
    const size = Number(opened.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
      throw tooLargeError(maxBytes, size);
    }
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!Number.isInteger(bytesRead) || bytesRead <= 0) {
        throw changedError();
      }
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(opened, after) || Number(after.size) !== buffer.length) throw changedError();
    return Object.freeze({ buffer, size: buffer.length });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (handle) {
      try { await handle.close(); }
      catch (closeError) {
        if (!primaryError) throw closeError;
      }
    }
  }
}

function readBoundedLocalFileSync(filePath, options = {}) {
  const maxBytes = positiveByteLimit(options.maxBytes);
  const checked = fs.lstatSync(filePath, { bigint: true });
  if (!checked.isFile() || checked.isSymbolicLink()) throw notFileError();
  let descriptor = null;
  try {
    descriptor = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || !sameIdentity(checked, stat)) throw changedError();
    const size = Number(stat.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
      throw tooLargeError(maxBytes, size);
    }
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (!Number.isInteger(count) || count <= 0) {
        const error = new Error("Local file changed while it was being read.");
        error.code = "bounded_local_file_changed";
        throw error;
      }
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(stat, after) || Number(after.size) !== buffer.length) throw changedError();
    return Object.freeze({ buffer, size: buffer.length });
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function tooLargeError(maxBytes, actualBytes) {
  const error = new Error(`Local file is too large: ${actualBytes} bytes; limit ${maxBytes} bytes.`);
  error.code = "bounded_local_file_too_large";
  error.maxBytes = maxBytes;
  error.actualBytes = actualBytes;
  return error;
}

function notFileError() {
  const error = new Error("Local path is not a regular file.");
  error.code = "bounded_local_file_not_file";
  return error;
}

function changedError() {
  const error = new Error("Local file changed while it was being read.");
  error.code = "bounded_local_file_changed";
  return error;
}

function sameIdentity(left, right) {
  return String(left?.dev) === String(right?.dev)
    && String(left?.ino) === String(right?.ino)
    && String(left?.size) === String(right?.size);
}

function positiveByteLimit(value) {
  const number = Number(value);
  const integer = Math.floor(number);
  if (!Number.isFinite(number) || integer <= 0) throw new TypeError("maxBytes must be positive");
  return Math.min(integer, Number.MAX_SAFE_INTEGER);
}

module.exports = { readBoundedLocalFile, readBoundedLocalFileSync };
