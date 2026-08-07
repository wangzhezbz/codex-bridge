import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

const MAX_ARCHIVE_ENTRIES = 4_096;
const MAX_TOTAL_UNPACKED_BYTES = 16n * 1_024n * 1_024n * 1_024n;
const MAX_SEVEN_ZIP_LISTING_BYTES = 16 * 1_024 * 1_024;
const MAX_SEVEN_ZIP_STDERR_BYTES = 1 * 1_024 * 1_024;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_DIRECTORY_TYPE = 0o040000;
const UNIX_SYMLINK_TYPE = 0o120000;
const WINDOWS_REPARSE_POINT_ATTRIBUTE = 0x400;
const SEVEN_ZIP_LINK_FIELDS = new Set(["symbolic link", "hard link", "link", "copy link", "reparse"]);
const SEVEN_ZIP_ALLOWED_FIELDS = new Set([
  "path", "size", "packed size", "modified", "created", "accessed", "attributes", "crc",
  "encrypted", "method", "block", "folder", "symbolic link", "hard link", "link", "copy link",
  "reparse", "anti", "comment", "host os", "version", "characteristics", "type", "physical size",
  "headers size", "solid", "blocks", "volumes", "offset", "tail size", "embedded stub size",
  "cluster size", "sector size",
]);
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function archiveError(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function abortError(signal) {
  const error = new Error("archive_cancelled", signal?.reason === undefined ? undefined : { cause: signal.reason });
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function validateFormat(format) {
  if (format !== "zip" && format !== "7z") throw archiveError("archive_format_rejected");
  return format;
}

function normalizeVerification(value) {
  if (value === undefined) return null;
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== 2
    || !Object.hasOwn(value, "componentId") || !Object.hasOwn(value, "version")
    || !["chatgpt", "v2rayn", "git"].includes(value.componentId)
    || !VERSION.test(value.version ?? "")) {
    throw archiveError("archive_verification_invalid");
  }
  return { componentId: value.componentId, version: value.version };
}

function unwrapVerifiedTree(value, verification) {
  if (!verification) return { tree: value, receipt: null };
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== 4
    || !["tree", "verificationReceipt", "treeDigest", "manifestDigest"]
      .every((key) => Object.hasOwn(value, key))
    || !Array.isArray(value.tree)
    || value.verificationReceipt === null || typeof value.verificationReceipt !== "object"
    || !SHA256.test(value.treeDigest ?? "") || !SHA256.test(value.manifestDigest ?? "")) {
    throw archiveError("archive_verification_receipt_invalid");
  }
  return {
    tree: value.tree,
    receipt: {
      verificationReceipt: value.verificationReceipt,
      treeDigest: value.treeDigest,
      manifestDigest: value.manifestDigest,
    },
  };
}

function requireAbsolutePath(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !path.isAbsolute(value)) {
    throw archiveError(code);
  }
  return path.resolve(value);
}

function normalizeEntryPath(rawPath, directoryHint = false) {
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.includes("\0")
    || /^[\\/]/u.test(rawPath) || /^[a-z]:/iu.test(rawPath)) {
    throw archiveError("archive_path_escape");
  }
  const slashPath = rawPath.replaceAll("\\", "/");
  const directory = directoryHint || slashPath.endsWith("/");
  const withoutTrailingSlash = directory ? slashPath.replace(/\/+$/u, "") : slashPath;
  const segments = withoutTrailingSlash.split("/");
  if (segments.length === 0 || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw archiveError("archive_path_escape");
  }
  for (const segment of segments) {
    if (/[<>:"|?*\u0000-\u001f]/u.test(segment) || /[ .]$/u.test(segment)
      || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(segment)) {
      throw archiveError("archive_path_rejected");
    }
  }
  const normalized = segments.join("/").normalize("NFC");
  return {
    path: normalized,
    key: normalized.toLowerCase(),
    segments: normalized.split("/"),
    directory,
  };
}

function createPolicyCollector() {
  const entries = [];
  const normalizedNames = new Set();
  const knownPathKinds = new Map();
  let totalUnpackedBytes = 0n;
  let maxRelativePath = 0;

  return {
    add({ rawPath, size, directory, link = false, source }) {
      if (entries.length >= MAX_ARCHIVE_ENTRIES) throw archiveError("archive_entry_count_exceeded");
      if (link) throw archiveError("archive_link_rejected");
      const normalized = normalizeEntryPath(rawPath, directory);
      if (normalizedNames.has(normalized.key)) throw archiveError("archive_duplicate_path");
      for (let index = 1; index < normalized.segments.length; index += 1) {
        const ancestorKey = normalized.segments.slice(0, index).join("/").toLowerCase();
        if (knownPathKinds.get(ancestorKey) === false) throw archiveError("archive_path_conflict");
      }
      if (!normalized.directory
        && [...knownPathKinds.keys()].some((knownKey) => knownKey.startsWith(`${normalized.key}/`))) {
        throw archiveError("archive_path_conflict");
      }
      normalizedNames.add(normalized.key);
      knownPathKinds.set(normalized.key, normalized.directory);

      const numericSize = typeof size === "bigint" ? size : BigInt(size);
      if (numericSize < 0n || numericSize > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw archiveError("archive_entry_size_rejected");
      }
      if (normalized.directory && numericSize !== 0n) throw archiveError("archive_directory_size_rejected");
      totalUnpackedBytes += numericSize;
      if (totalUnpackedBytes > MAX_TOTAL_UNPACKED_BYTES) throw archiveError("archive_unpacked_size_exceeded");
      maxRelativePath = Math.max(maxRelativePath, normalized.path.length);
      entries.push({
        path: normalized.path,
        size: Number(numericSize),
        directory: normalized.directory,
        segments: normalized.segments,
        source,
      });
    },
    finish() {
      return {
        entries,
        publicResult: {
          entries: entries.map(({ path: entryPath, size, directory }) => ({ path: entryPath, size, directory })),
          maxRelativePath,
          totalUnpackedBytes: Number(totalUnpackedBytes),
        },
      };
    },
  };
}

function zipMetadata(entry) {
  const externalAttributes = Number(entry.externalFileAttributes) >>> 0;
  const unixMode = externalAttributes >>> 16;
  const unixType = unixMode & UNIX_FILE_TYPE_MASK;
  const link = unixType === UNIX_SYMLINK_TYPE
    || (externalAttributes & WINDOWS_REPARSE_POINT_ATTRIBUTE) !== 0;
  const directory = /[\\/]$/u.test(entry.fileName)
    || unixType === UNIX_DIRECTORY_TYPE
    || (externalAttributes & 0x10) !== 0;
  return { link, directory };
}

function openZipFile(archivePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, {
      autoClose: false,
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: false,
    }, (error, zipFile) => {
      if (error) reject(archiveError("archive_zip_invalid", error));
      else resolve(zipFile);
    });
  });
}

function closeZipFile(zipFile) {
  zipFile?.close();
}

function aggregateWithPrimary(primaryError, closeErrors) {
  if (primaryError && closeErrors.length > 0) {
    return new AggregateError([primaryError, ...closeErrors], primaryError.message, { cause: primaryError });
  }
  if (primaryError) return primaryError;
  if (closeErrors.length === 1) return closeErrors[0];
  if (closeErrors.length > 1) return new AggregateError(closeErrors, "archive_close_failed");
  return null;
}

async function finishWithClose({ primaryError, result, resources }) {
  const closeErrors = [];
  for (const resource of resources) {
    if (typeof resource?.close !== "function") continue;
    try {
      await resource.close();
    } catch (error) {
      closeErrors.push(error);
    }
  }
  const finalError = aggregateWithPrimary(primaryError, closeErrors);
  if (finalError) throw finalError;
  return result;
}

function mapZipError(error) {
  if (/absolute path|invalid relative path/iu.test(String(error?.message ?? ""))) {
    return archiveError("archive_path_escape", error);
  }
  return archiveError("archive_zip_invalid", error);
}

async function enumerateZip(archivePath, signal) {
  throwIfAborted(signal);
  const zipFile = await openZipFile(archivePath);
  try {
    if (zipFile.entryCount > MAX_ARCHIVE_ENTRIES) throw archiveError("archive_entry_count_exceeded");
    const collector = createPolicyCollector();
    const collected = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        callback(value);
      };
      const onAbort = () => {
        const primaryError = abortError(signal);
        try {
          closeZipFile(zipFile);
          finish(reject, primaryError);
        } catch (closeError) {
          finish(reject, aggregateWithPrimary(primaryError, [closeError]));
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      zipFile.on("error", (error) => finish(reject, mapZipError(error)));
      zipFile.on("entry", (entry) => {
        if (settled) return;
        try {
          throwIfAborted(signal);
          if ((entry.generalPurposeBitFlag & 1) !== 0) {
            throw archiveError("archive_encrypted_entry_rejected");
          }
          if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
            throw archiveError("archive_compression_rejected");
          }
          const metadata = zipMetadata(entry);
          collector.add({
            rawPath: entry.fileName,
            size: entry.uncompressedSize,
            directory: metadata.directory,
            link: metadata.link,
            source: entry,
          });
          zipFile.readEntry();
        } catch (error) {
          finish(reject, error);
        }
      });
      zipFile.on("end", () => {
        try {
          finish(resolve, collector.finish());
        } catch (error) {
          finish(reject, error);
        }
      });
      zipFile.readEntry();
    });
    return { zipFile, ...collected };
  } catch (error) {
    try {
      closeZipFile(zipFile);
      throw error;
    } catch (closeError) {
      if (closeError === error) throw error;
      throw aggregateWithPrimary(error, [closeError]);
    }
  }
}

function openZipReadStream(zipFile, entry) {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) reject(archiveError("archive_zip_read_failed", error));
      else resolve(stream);
    });
  });
}

function requireZipDestinationHandle(handle) {
  if (!handle || typeof handle.ensureDirectoryPathNoFollow !== "function"
    || typeof handle.createFilePathNoFollow !== "function"
    || typeof handle.verifyTreeNoFollow !== "function" || typeof handle.close !== "function") {
    throw archiveError("archive_no_follow_capability_invalid");
  }
  return handle;
}

async function extractZip({ archivePath, destination, destinationIdentity, signal, fsApi, verification }) {
  throwIfAborted(signal);
  let enumerated;
  let destinationHandle;
  let result;
  let primaryError;
  try {
    throwIfAborted(signal);
    if (typeof fsApi?.openArchiveDestinationNoFollow !== "function") {
      throw archiveError("archive_no_follow_capability_required");
    }
    destinationHandle = await fsApi.openArchiveDestinationNoFollow(destination, { expectedIdentity: destinationIdentity });
    requireZipDestinationHandle(destinationHandle);
    enumerated = await enumerateZip(archivePath, signal);
    for (const entry of enumerated.entries) {
      throwIfAborted(signal);
      if (entry.directory) {
        await destinationHandle.ensureDirectoryPathNoFollow([...entry.segments]);
        continue;
      }
      const parents = entry.segments.slice(0, -1);
      if (parents.length > 0) await destinationHandle.ensureDirectoryPathNoFollow(parents);
      const output = await destinationHandle.createFilePathNoFollow([...entry.segments], {
        exclusive: true,
        size: entry.size,
      });
      if (!output || typeof output.write !== "function" || typeof output.end !== "function") {
        throw archiveError("archive_no_follow_file_handle_invalid");
      }
      const input = await openZipReadStream(enumerated.zipFile, entry.source);
      await pipeline(input, output, signal ? { signal } : {});
    }
    throwIfAborted(signal);
    const verified = await destinationHandle.verifyTreeNoFollow(signal, verification ? {
      ...verification,
      requiredFiles: enumerated.publicResult.entries,
    } : undefined);
    throwIfAborted(signal);
    const unwrapped = unwrapVerifiedTree(verified, verification);
    validateVerifiedTree(unwrapped.tree, destination, enumerated.publicResult.entries);
    result = unwrapped.receipt
      ? { ...enumerated.publicResult, ...unwrapped.receipt }
      : enumerated.publicResult;
  } catch (error) {
    primaryError = error;
  }
  return finishWithClose({
    primaryError,
    result,
    resources: [destinationHandle, enumerated ? { close: () => closeZipFile(enumerated.zipFile) } : null],
  });
}

function parseSevenZipListing(stdout) {
  const collector = createPolicyCollector();
  const blocks = stdout.replace(/^\uFEFF/u, "").split(/\r?\n\s*\r?\n/u);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const fields = new Map();
    for (const line of block.split(/\r?\n/u)) {
      if (!line) continue;
      const separator = line.indexOf(" = ");
      if (separator <= 0) throw archiveError("archive_7z_list_invalid");
      const fieldName = line.slice(0, separator);
      const fieldValue = line.slice(separator + 3);
      if (!/^[A-Za-z][A-Za-z0-9 ]*$/u.test(fieldName) || fieldName.trim() !== fieldName
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(fieldValue)) {
        throw archiveError("archive_7z_list_invalid");
      }
      const fieldKey = fieldName.toLowerCase();
      if (!SEVEN_ZIP_ALLOWED_FIELDS.has(fieldKey)) throw archiveError("archive_7z_list_invalid");
      if (fields.has(fieldKey)) throw archiveError("archive_7z_list_ambiguous");
      fields.set(fieldKey, fieldValue);
    }
    const rawPath = fields.get("path");
    const rawSize = fields.get("size");
    const attributes = fields.get("attributes");
    if (rawPath === undefined || rawSize === undefined || attributes === undefined || !/^\d+$/u.test(rawSize)) {
      throw archiveError("archive_7z_list_invalid");
    }
    const encrypted = fields.get("encrypted");
    if (encrypted === "+") throw archiveError("archive_encrypted_entry_rejected");
    if (encrypted !== undefined && encrypted !== "" && encrypted !== "-") {
      throw archiveError("archive_7z_list_invalid");
    }
    const folder = fields.get("folder");
    if (folder !== undefined && folder !== "+" && folder !== "-") throw archiveError("archive_7z_list_invalid");
    const anti = fields.get("anti");
    if (anti !== undefined && anti !== "" && anti !== "-") throw archiveError("archive_7z_list_invalid");
    const attributePolicy = parseSevenZipAttributes(attributes);
    const link = [...SEVEN_ZIP_LINK_FIELDS].some((field) => fields.has(field) && fields.get(field) !== "")
      || attributePolicy.link;
    const directory = /[\\/]$/u.test(rawPath) || attributePolicy.directory || folder === "+";
    collector.add({ rawPath, size: BigInt(rawSize), directory, link, source: rawPath });
  }
  return collector.finish();
}

function parseSevenZipAttributes(attributes) {
  const tokens = attributes.trim().split(/\s+/u).filter(Boolean);
  const unixMode = tokens.find((token) => /^[bcdlps-][rwxstST-]{9}$/u.test(token));
  const windowsCompact = tokens.find((token) => /^(?=.*[A-Za-z])[RHSDACTPLOINE.]+$/iu.test(token));
  return {
    link: unixMode?.[0]?.toLowerCase() === "l"
      || windowsCompact?.toUpperCase().includes("L") === true
      || /\b(?:symlink|junction|reparse)\b/iu.test(attributes),
    directory: unixMode?.[0]?.toLowerCase() === "d"
      || windowsCompact?.toUpperCase().includes("D") === true,
  };
}

function requireSpawnResult(result) {
  if (!result || typeof result !== "object" || !Number.isInteger(result.exitCode)
    || !(typeof result.stdout === "string" || Buffer.isBuffer(result.stdout))
    || !(typeof result.stderr === "string" || Buffer.isBuffer(result.stderr))) {
    throw archiveError("archive_7z_adapter_invalid");
  }
  return result;
}

async function runSevenZip({ sevenZipPath, spawnFile, args, signal }) {
  throwIfAborted(signal);
  if (typeof spawnFile !== "function") throw archiveError("archive_7z_adapter_required");
  const result = requireSpawnResult(await spawnFile(sevenZipPath, [...args], {
    shell: false,
    windowsHide: true,
    signal,
  }));
  throwIfAborted(signal);
  const stdoutBytes = Buffer.byteLength(result.stdout);
  if (stdoutBytes > MAX_SEVEN_ZIP_LISTING_BYTES) throw archiveError("archive_7z_output_exceeded");
  if (result.exitCode !== 0) throw archiveError("archive_7z_failed");
  return result.stdout;
}

function requireStreamingProcess(value) {
  if (!value || typeof value !== "object" || !value.stdout || typeof value.stdout.pipe !== "function"
    || !value.stderr || typeof value.stderr[Symbol.asyncIterator] !== "function"
    || !value.completed || typeof value.completed.then !== "function"
    || typeof value.cancel !== "function") {
    throw archiveError("archive_7z_stream_adapter_invalid");
  }
  return value;
}

async function consumeBoundedStderr(stream) {
  let size = 0;
  for await (const chunk of stream) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_SEVEN_ZIP_STDERR_BYTES) throw archiveError("archive_7z_stderr_exceeded");
  }
}

async function streamSevenZipEntry({
  archivePath, rawEntryPath, output, signal, sevenZipPath, spawnStream,
}) {
  throwIfAborted(signal);
  if (typeof spawnStream !== "function") throw archiveError("archive_7z_stream_adapter_required");
  let processHandle;
  try {
    processHandle = requireStreamingProcess(await spawnStream(sevenZipPath, [
      "x", "-so", "-y", "-t7z", "-sns-", "--", archivePath, rawEntryPath,
    ], {
      shell: false,
      windowsHide: true,
      signal,
    }));
    throwIfAborted(signal);
    const [,, completed] = await Promise.all([
      pipeline(processHandle.stdout, output, signal ? { signal } : {}),
      consumeBoundedStderr(processHandle.stderr),
      processHandle.completed,
    ]);
    throwIfAborted(signal);
    if (!completed || !Number.isInteger(completed.exitCode)) {
      throw archiveError("archive_7z_stream_adapter_invalid");
    }
    if (completed.exitCode !== 0) throw archiveError("archive_7z_failed");
  } catch (error) {
    try {
      processHandle?.cancel();
    } catch (cancelError) {
      throw new AggregateError([error, cancelError], error.message, { cause: error });
    }
    throw error;
  }
}

async function inspectSevenZip({ archivePath, signal, sevenZipPath, spawnFile }) {
  const stdout = await runSevenZip({
    sevenZipPath,
    spawnFile,
    args: ["l", "-slt", "-ba", "-t7z", "-sns-", "--", archivePath],
    signal,
  });
  if (typeof stdout !== "string") throw archiveError("archive_7z_listing_encoding_required");
  return parseSevenZipListing(stdout);
}

function requireArchivePin(handle) {
  if (!handle || typeof handle.assertStableNoFollow !== "function" || typeof handle.close !== "function") {
    throw archiveError("archive_no_follow_capability_invalid");
  }
  return handle;
}

function requireSevenZipDestinationHandle(handle) {
  if (!handle || typeof handle.assertEmptyNoFollow !== "function"
    || typeof handle.ensureDirectoryPathNoFollow !== "function"
    || typeof handle.createFilePathNoFollow !== "function"
    || typeof handle.verifyTreeNoFollow !== "function" || typeof handle.close !== "function") {
    throw archiveError("archive_no_follow_capability_invalid");
  }
  return handle;
}

function isEqualOrWithin(target, root) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function expectedExtractedTree(entries) {
  const expected = new Map();
  for (const entry of entries) {
    const segments = entry.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const parentPath = segments.slice(0, index).join("/");
      const parentKey = parentPath.normalize("NFC").toLowerCase();
      if (!expected.has(parentKey)) expected.set(parentKey, { path: parentPath, size: 0, directory: true });
    }
    expected.set(entry.path.normalize("NFC").toLowerCase(), entry);
  }
  return expected;
}

function validateVerifiedTree(tree, destination, inspectedEntries) {
  if (!Array.isArray(tree)) throw archiveError("archive_no_follow_tree_invalid");
  const expected = expectedExtractedTree(inspectedEntries);
  const seen = new Set();
  for (const item of tree) {
    if (!item || typeof item !== "object" || typeof item.path !== "string"
      || typeof item.realPath !== "string" || typeof item.directory !== "boolean"
      || !Number.isSafeInteger(item.size) || item.size < 0
      || item.link !== false || item.reparse !== false || item.hardLink !== false || item.nlink !== 1) {
      throw archiveError("archive_no_follow_tree_invalid");
    }
    const normalized = normalizeEntryPath(item.path, item.directory);
    if (normalized.directory !== item.directory || normalized.path !== item.path) {
      throw archiveError("archive_no_follow_tree_invalid");
    }
    if (seen.has(normalized.key)) throw archiveError("archive_duplicate_output_path");
    seen.add(normalized.key);
    const realPath = requireAbsolutePath(item.realPath, "archive_output_escape");
    if (!isEqualOrWithin(realPath, destination)) throw archiveError("archive_output_escape");
    const expectedRealPath = path.resolve(destination, ...normalized.segments);
    if (!isEqualOrWithin(realPath, expectedRealPath) || !isEqualOrWithin(expectedRealPath, realPath)) {
      throw archiveError("archive_output_mismatch");
    }
    const expectedItem = expected.get(normalized.key);
    if (!expectedItem || expectedItem.directory !== item.directory || expectedItem.size !== item.size) {
      throw archiveError("archive_output_mismatch");
    }
    expected.delete(normalized.key);
  }
  if (expected.size !== 0) throw archiveError("archive_output_mismatch");
}

async function extractSevenZip({
  archivePath, destination, destinationIdentity, signal, sevenZipPath, spawnFile, spawnStream, fsApi, verification,
}) {
  throwIfAborted(signal);
  if (typeof fsApi?.pinArchiveFileNoFollow !== "function"
    || typeof fsApi?.openArchiveDestinationNoFollow !== "function") {
    throw archiveError("archive_no_follow_capability_required");
  }
  let archivePin;
  let destinationHandle;
  let result;
  let primaryError;
  try {
    archivePin = await fsApi.pinArchiveFileNoFollow(archivePath);
    requireArchivePin(archivePin);
    throwIfAborted(signal);
    await archivePin.assertStableNoFollow();
    throwIfAborted(signal);
    destinationHandle = await fsApi.openArchiveDestinationNoFollow(destination, { expectedIdentity: destinationIdentity });
    requireSevenZipDestinationHandle(destinationHandle);
    throwIfAborted(signal);
    await destinationHandle.assertEmptyNoFollow();
    throwIfAborted(signal);
    const inspected = await inspectSevenZip({ archivePath, signal, sevenZipPath, spawnFile });
    throwIfAborted(signal);
    await archivePin.assertStableNoFollow();
    throwIfAborted(signal);
    for (const entry of inspected.entries) {
      throwIfAborted(signal);
      if (entry.directory) {
        await destinationHandle.ensureDirectoryPathNoFollow([...entry.segments]);
        continue;
      }
      const parents = entry.segments.slice(0, -1);
      if (parents.length > 0) await destinationHandle.ensureDirectoryPathNoFollow(parents);
      const output = await destinationHandle.createFilePathNoFollow([...entry.segments], {
        exclusive: true,
        size: entry.size,
      });
      if (!output || typeof output.write !== "function" || typeof output.end !== "function") {
        throw archiveError("archive_no_follow_file_handle_invalid");
      }
      await streamSevenZipEntry({
        archivePath,
        rawEntryPath: entry.source,
        output,
        signal,
        sevenZipPath,
        spawnStream,
      });
    }
    throwIfAborted(signal);
    await archivePin.assertStableNoFollow();
    throwIfAborted(signal);
    const verified = await destinationHandle.verifyTreeNoFollow(signal, verification ? {
      ...verification,
      requiredFiles: inspected.publicResult.entries,
    } : undefined);
    throwIfAborted(signal);
    const unwrapped = unwrapVerifiedTree(verified, verification);
    validateVerifiedTree(unwrapped.tree, destination, inspected.publicResult.entries);
    result = unwrapped.receipt
      ? { ...inspected.publicResult, ...unwrapped.receipt }
      : inspected.publicResult;
  } catch (error) {
    primaryError = error;
  }
  return finishWithClose({ primaryError, result, resources: [destinationHandle, archivePin] });
}

export function createArchiveService({ sevenZipPath, spawnFile, spawnStream, fsApi } = {}) {
  const bundledSevenZipPath = sevenZipPath === undefined
    ? undefined
    : requireAbsolutePath(sevenZipPath, "archive_7z_path_rejected");

  return {
    async inspectArchive({ format, archivePath } = {}) {
      const exactFormat = validateFormat(format);
      const exactArchivePath = requireAbsolutePath(archivePath, "archive_path_rejected");
      if (exactFormat === "zip") {
        const enumerated = await enumerateZip(exactArchivePath);
        return finishWithClose({
          result: enumerated.publicResult,
          resources: [{ close: () => closeZipFile(enumerated.zipFile) }],
        });
      }
      if (!bundledSevenZipPath) throw archiveError("archive_7z_path_required");
      return (await inspectSevenZip({
        archivePath: exactArchivePath,
        sevenZipPath: bundledSevenZipPath,
        spawnFile,
      })).publicResult;
    },

    async extractArchive({
      format, archivePath, destination, destinationIdentity = null, signal, verification: rawVerification,
    } = {}) {
      throwIfAborted(signal);
      const exactFormat = validateFormat(format);
      const exactArchivePath = requireAbsolutePath(archivePath, "archive_path_rejected");
      const exactDestination = requireAbsolutePath(destination, "archive_destination_rejected");
      if (destinationIdentity === null) {
        throw archiveError("archive_destination_identity_required");
      }
      if (!destinationIdentity || typeof destinationIdentity !== "object"
        || Object.keys(destinationIdentity).length !== 2
        || typeof destinationIdentity.volumeSerial !== "string" || destinationIdentity.volumeSerial.length === 0
        || typeof destinationIdentity.fileId !== "string" || destinationIdentity.fileId.length === 0) {
        throw archiveError("archive_destination_identity_rejected");
      }
      const verification = normalizeVerification(rawVerification);
      if (exactFormat === "zip") {
        return extractZip({
          archivePath: exactArchivePath, destination: exactDestination, destinationIdentity,
          signal, fsApi, verification,
        });
      }
      if (!bundledSevenZipPath) throw archiveError("archive_7z_path_required");
      return extractSevenZip({
        archivePath: exactArchivePath,
        destination: exactDestination,
        destinationIdentity,
        signal,
        sevenZipPath: bundledSevenZipPath,
        spawnFile,
        spawnStream,
        fsApi,
        verification,
      });
    },
  };
}
