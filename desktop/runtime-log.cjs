const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

function appendBoundedLog(filePath, line, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const limit = Math.max(32, Number(maxBytes) || DEFAULT_MAX_BYTES);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const entry = boundedEntryBuffer(line, limit);
  const currentSize = fileSize(filePath);
  if (currentSize > 0 && currentSize + entry.length > limit) {
    writeTailBackup(filePath, `${filePath}.1`, limit);
    fs.truncateSync(filePath, 0);
  }
  fs.appendFileSync(filePath, entry);
}

function boundedEntryBuffer(line, maxBytes) {
  const raw = Buffer.from(`${String(line || "").replace(/\r?\n$/, "")}\n`, "utf8");
  if (raw.length <= maxBytes) {
    return raw;
  }
  const marker = Buffer.from("[entry truncated]\n", "utf8");
  const tailBytes = Math.max(0, maxBytes - marker.length);
  return Buffer.concat([marker, raw.subarray(raw.length - tailBytes)]).subarray(0, maxBytes);
}

function writeTailBackup(sourcePath, backupPath, maxBytes) {
  const size = fileSize(sourcePath);
  if (size <= 0) {
    return;
  }
  const length = Math.min(size, maxBytes);
  const buffer = Buffer.alloc(length);
  const descriptor = fs.openSync(sourcePath, "r");
  try {
    fs.readSync(descriptor, buffer, 0, length, Math.max(0, size - length));
  } finally {
    fs.closeSync(descriptor);
  }
  fs.writeFileSync(backupPath, buffer);
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

module.exports = {
  appendBoundedLog,
  DEFAULT_MAX_BYTES,
};
