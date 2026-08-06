import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

const MAX_ARCHIVE_ENTRIES = 4_096;
const MAX_TOTAL_UNPACKED_BYTES = 16n * 1_024n * 1_024n * 1_024n;
const MAX_SEVEN_ZIP_LISTING_BYTES = 16 * 1_024 * 1_024;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_DIRECTORY_TYPE = 0o040000;
const UNIX_SYMLINK_TYPE = 0o120000;
const WINDOWS_REPARSE_POINT_ATTRIBUTE = 0x400;

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
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)) {
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
  try {
    zipFile?.close();
  } catch {
    // The first validation or extraction error remains authoritative.
  }
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
        closeZipFile(zipFile);
        finish(reject, abortError(signal));
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
    closeZipFile(zipFile);
    throw error;
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
    || typeof handle.createFilePathNoFollow !== "function" || typeof handle.close !== "function") {
    throw archiveError("archive_no_follow_capability_invalid");
  }
  return handle;
}

async function extractZip({ archivePath, destination, signal, fsApi }) {
  throwIfAborted(signal);
  const enumerated = await enumerateZip(archivePath, signal);
  let destinationHandle;
  try {
    throwIfAborted(signal);
    if (typeof fsApi?.openArchiveDestinationNoFollow !== "function") {
      throw archiveError("archive_no_follow_capability_required");
    }
    destinationHandle = requireZipDestinationHandle(await fsApi.openArchiveDestinationNoFollow(destination));
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
    return enumerated.publicResult;
  } finally {
    closeZipFile(enumerated.zipFile);
    await destinationHandle?.close();
  }
}

function parseSevenZipListing(stdout) {
  const collector = createPolicyCollector();
  const blocks = String(stdout).replace(/^\uFEFF/u, "").split(/\r?\n\s*\r?\n/u);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const fields = new Map();
    for (const line of block.split(/\r?\n/u)) {
      if (!line) continue;
      const separator = line.indexOf(" = ");
      if (separator <= 0) throw archiveError("archive_7z_list_invalid");
      fields.set(line.slice(0, separator), line.slice(separator + 3));
    }
    const rawPath = fields.get("Path");
    const rawSize = fields.get("Size");
    if (rawPath === undefined || rawSize === undefined || !/^\d+$/u.test(rawSize)) {
      throw archiveError("archive_7z_list_invalid");
    }
    const attributes = fields.get("Attributes") ?? "";
    const link = [...fields.keys()].some((key) => /(?:symbolic|hard) link|reparse/iu.test(key))
      || /reparse|symlink|junction/iu.test(attributes)
      || attributes.toLowerCase().includes("l");
    const directory = /[\\/]$/u.test(rawPath) || /^d/iu.test(attributes) || fields.get("Folder") === "+";
    collector.add({ rawPath, size: BigInt(rawSize), directory, link });
  }
  return collector.finish();
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
  return Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : result.stdout;
}

async function inspectSevenZip({ archivePath, signal, sevenZipPath, spawnFile }) {
  const stdout = await runSevenZip({
    sevenZipPath,
    spawnFile,
    args: ["l", "-slt", "-ba", "--", archivePath],
    signal,
  });
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
    || typeof handle.verifyTreeNoFollow !== "function" || typeof handle.close !== "function") {
    throw archiveError("archive_no_follow_capability_invalid");
  }
  return handle;
}

function isEqualOrWithin(target, root) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function validateVerifiedTree(tree, destination) {
  if (!Array.isArray(tree)) throw archiveError("archive_no_follow_tree_invalid");
  const seen = new Set();
  for (const item of tree) {
    if (!item || typeof item !== "object" || typeof item.path !== "string"
      || typeof item.realPath !== "string" || typeof item.directory !== "boolean"
      || item.link === true || item.reparse === true) {
      throw archiveError("archive_no_follow_tree_invalid");
    }
    const normalized = normalizeEntryPath(item.path, item.directory);
    if (seen.has(normalized.key)) throw archiveError("archive_duplicate_output_path");
    seen.add(normalized.key);
    const realPath = requireAbsolutePath(item.realPath, "archive_output_escape");
    if (!isEqualOrWithin(realPath, destination)) throw archiveError("archive_output_escape");
  }
}

async function extractSevenZip({ archivePath, destination, signal, sevenZipPath, spawnFile, fsApi }) {
  throwIfAborted(signal);
  if (typeof fsApi?.pinArchiveFileNoFollow !== "function"
    || typeof fsApi?.openArchiveDestinationNoFollow !== "function") {
    throw archiveError("archive_no_follow_capability_required");
  }
  const archivePin = requireArchivePin(await fsApi.pinArchiveFileNoFollow(archivePath));
  let destinationHandle;
  try {
    await archivePin.assertStableNoFollow();
    const inspected = await inspectSevenZip({ archivePath, signal, sevenZipPath, spawnFile });
    throwIfAborted(signal);
    await archivePin.assertStableNoFollow();
    destinationHandle = requireSevenZipDestinationHandle(await fsApi.openArchiveDestinationNoFollow(destination));
    await destinationHandle.assertEmptyNoFollow();
    throwIfAborted(signal);
    await runSevenZip({
      sevenZipPath,
      spawnFile,
      args: ["x", "-y", `-o${destination}`, "--", archivePath],
      signal,
    });
    throwIfAborted(signal);
    await archivePin.assertStableNoFollow();
    validateVerifiedTree(await destinationHandle.verifyTreeNoFollow(), destination);
    return inspected.publicResult;
  } finally {
    await destinationHandle?.close();
    await archivePin.close();
  }
}

export function createArchiveService({ sevenZipPath, spawnFile, fsApi } = {}) {
  const bundledSevenZipPath = sevenZipPath === undefined
    ? undefined
    : requireAbsolutePath(sevenZipPath, "archive_7z_path_rejected");

  return {
    async inspectArchive({ format, archivePath } = {}) {
      const exactFormat = validateFormat(format);
      const exactArchivePath = requireAbsolutePath(archivePath, "archive_path_rejected");
      if (exactFormat === "zip") {
        const enumerated = await enumerateZip(exactArchivePath);
        closeZipFile(enumerated.zipFile);
        return enumerated.publicResult;
      }
      if (!bundledSevenZipPath) throw archiveError("archive_7z_path_required");
      return (await inspectSevenZip({
        archivePath: exactArchivePath,
        sevenZipPath: bundledSevenZipPath,
        spawnFile,
      })).publicResult;
    },

    async extractArchive({ format, archivePath, destination, signal } = {}) {
      throwIfAborted(signal);
      const exactFormat = validateFormat(format);
      const exactArchivePath = requireAbsolutePath(archivePath, "archive_path_rejected");
      const exactDestination = requireAbsolutePath(destination, "archive_destination_rejected");
      if (exactFormat === "zip") {
        return extractZip({ archivePath: exactArchivePath, destination: exactDestination, signal, fsApi });
      }
      if (!bundledSevenZipPath) throw archiveError("archive_7z_path_required");
      return extractSevenZip({
        archivePath: exactArchivePath,
        destination: exactDestination,
        signal,
        sevenZipPath: bundledSevenZipPath,
        spawnFile,
        fsApi,
      });
    },
  };
}
