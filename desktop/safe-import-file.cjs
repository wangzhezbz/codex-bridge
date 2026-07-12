const fs = require("node:fs");

const MAX_CONFIG_PACKAGE_IMPORT_BYTES = 16 * 1024 * 1024;

function readBoundedRegularUtf8File(filePath, {
  maxBytes = MAX_CONFIG_PACKAGE_IMPORT_BYTES,
  fsImpl = fs,
} = {}) {
  const limit = Number(maxBytes);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TypeError("Import byte limit must be a positive integer.");
  }

  const checked = fsImpl.lstatSync(filePath);
  assertSingleLinkRegularFile(checked);
  assertBoundedSize(checked.size, limit);

  let descriptor = null;
  try {
    descriptor = fsImpl.openSync(filePath, "r");
    const opened = fsImpl.fstatSync(descriptor);
    assertSingleLinkRegularFile(opened);
    assertSameIdentity(checked, opened);
    assertBoundedSize(opened.size, limit);

    const byteLength = Number(opened.size);
    const buffer = Buffer.alloc(byteLength);
    let offset = 0;
    while (offset < byteLength) {
      const bytesRead = fsImpl.readSync(
        descriptor,
        buffer,
        offset,
        byteLength - offset,
        offset,
      );
      if (!Number.isInteger(bytesRead) || bytesRead <= 0) {
        throw safeImportError(
          "CONFIG_PACKAGE_FILE_CHANGED",
          "Config package changed while it was being read.",
        );
      }
      offset += bytesRead;
    }

    const afterRead = fsImpl.fstatSync(descriptor);
    assertSingleLinkRegularFile(afterRead);
    assertSameIdentity(opened, afterRead);
    if (Number(afterRead.size) !== byteLength) {
      throw safeImportError(
        "CONFIG_PACKAGE_FILE_CHANGED",
        "Config package changed while it was being read.",
      );
    }
    return buffer.toString("utf8");
  } finally {
    if (descriptor !== null) {
      fsImpl.closeSync(descriptor);
    }
  }
}

function assertSingleLinkRegularFile(stat) {
  if (
    !stat ||
    typeof stat.isFile !== "function" ||
    !stat.isFile() ||
    (typeof stat.isSymbolicLink === "function" && stat.isSymbolicLink()) ||
    Number(stat.nlink) !== 1
  ) {
    throw safeImportError(
      "CONFIG_PACKAGE_FILE_UNSAFE",
      "Config package must be a single-link regular file.",
    );
  }
}

function assertBoundedSize(size, maxBytes) {
  const byteLength = Number(size);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw safeImportError(
      "CONFIG_PACKAGE_FILE_UNSAFE",
      "Config package has an invalid file size.",
    );
  }
  if (byteLength > maxBytes) {
    throw safeImportError(
      "CONFIG_PACKAGE_TOO_LARGE",
      `Config package is too large; maximum size is ${maxBytes} bytes.`,
    );
  }
}

function assertSameIdentity(expected, actual) {
  if (
    String(expected.dev) !== String(actual.dev) ||
    String(expected.ino) !== String(actual.ino) ||
    Number(expected.size) !== Number(actual.size) ||
    Number(expected.nlink) !== Number(actual.nlink)
  ) {
    throw safeImportError(
      "CONFIG_PACKAGE_FILE_CHANGED",
      "Config package changed before it could be read safely.",
    );
  }
}

function safeImportError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  MAX_CONFIG_PACKAGE_IMPORT_BYTES,
  readBoundedRegularUtf8File,
};
