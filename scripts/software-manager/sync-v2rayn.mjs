import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";

export const V2RAYN_RELEASE_API_URL = "https://api.github.com/repos/fqfqgo/v2rayN/releases/latest";
export const V2RAYN_PACKAGE_NAME = "v2rayN-windows-64-desktop.zip";
export const V2RAYN_SIGNATURE_NAME = `${V2RAYN_PACKAGE_NAME}.sig`;
export const V2RAYN_SIGNING_FINGERPRINT = "A4A69C432C532A5F21D0B6EE14162A209ADA306B";
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const DOWNLOAD_RANGE_BYTES = 1024 * 1024;
const VERSION = /^\d+(?:\.\d+){0,3}$/u;
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

function syncError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function equivalentWindowsVersion(left, right) {
  if (!VERSION.test(left) || !VERSION.test(right)) return false;
  const normalized = (value) => {
    const parts = value.split(".").map(Number);
    while (parts.length < 4) parts.push(0);
    return parts.join(".");
  };
  return normalized(left) === normalized(right);
}

function safeWorkRoot(value) {
  const raw = String(value || "");
  if (!raw || !path.isAbsolute(raw) || path.normalize(raw) !== raw || raw === path.parse(raw).root) {
    throw syncError("software_sync_work_root_invalid");
  }
  return raw;
}

function selectV2RayNAssets(metadata) {
  const version = String(metadata?.tag_name || "").replace(/^v/iu, "");
  if (!VERSION.test(version) || !Array.isArray(metadata?.assets) || metadata.assets.length > 1_000) {
    throw syncError("software_sync_v2rayn_metadata_invalid");
  }
  const selected = new Map();
  for (const asset of metadata.assets) {
    if (![V2RAYN_PACKAGE_NAME, V2RAYN_SIGNATURE_NAME].includes(asset?.name)) continue;
    let browserUrl;
    let apiUrl;
    try {
      browserUrl = new URL(asset.browser_download_url);
      apiUrl = new URL(asset.url);
    } catch { throw syncError("software_sync_v2rayn_asset_rejected"); }
    if (browserUrl.protocol !== "https:" || browserUrl.hostname !== "github.com"
      || browserUrl.pathname !== `/fqfqgo/v2rayN/releases/download/${version}/${asset.name}`
      || browserUrl.search || browserUrl.hash || apiUrl.protocol !== "https:"
      || apiUrl.hostname !== "api.github.com" || !Number.isSafeInteger(asset.id) || asset.id < 1
      || apiUrl.pathname !== `/repos/fqfqgo/v2rayN/releases/assets/${asset.id}`
      || apiUrl.search || apiUrl.hash || !Number.isSafeInteger(asset.size) || asset.size < 1) {
      throw syncError("software_sync_v2rayn_asset_rejected");
    }
    const digestMatch = /^sha256:([a-f0-9]{64})$/u.exec(String(asset.digest || ""));
    if (asset.digest != null && !digestMatch) throw syncError("software_sync_v2rayn_asset_rejected");
    if (selected.has(asset.name)) throw syncError("software_sync_v2rayn_asset_invalid");
    selected.set(asset.name, {
      name: asset.name,
      url: apiUrl.href,
      size: asset.size,
      sha256: digestMatch?.[1] ?? null,
    });
  }
  if (!selected.has(V2RAYN_PACKAGE_NAME) || !selected.has(V2RAYN_SIGNATURE_NAME)) {
    throw syncError("software_sync_v2rayn_asset_invalid");
  }
  return { version, packageAsset: selected.get(V2RAYN_PACKAGE_NAME), signatureAsset: selected.get(V2RAYN_SIGNATURE_NAME) };
}

async function defaultPgpVerifier(packagePath, signaturePath) {
  const executable = String(process.env.CBI_GPGV_PATH || (process.platform === "win32" ? "gpgv.exe" : "/usr/bin/gpgv"));
  const keyring = String(process.env.CBI_V2RAYN_KEYRING || "");
  if (!path.isAbsolute(executable) || path.normalize(executable) !== executable
    || !path.isAbsolute(keyring) || path.normalize(keyring) !== keyring) {
    throw syncError("software_sync_v2rayn_signature_tool_invalid");
  }
  const { stdout, stderr } = await execFileAsync(executable, [
    "--status-fd", "1", "--keyring", keyring, signaturePath, packagePath,
  ], { windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024, encoding: "utf8" });
  const output = `${stdout}\n${stderr}`;
  const matches = [...output.matchAll(/^\[GNUPG:\] VALIDSIG ([A-F0-9]{40})\b/gmu)];
  if (matches.length !== 1 || matches[0][1] !== V2RAYN_SIGNING_FINGERPRINT) {
    throw syncError("software_sync_v2rayn_signature_invalid");
  }
  return V2RAYN_SIGNING_FINGERPRINT;
}

async function downloadAttempt({ url, fetchImpl, packagePath, headers }) {
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: "follow",
      headers: { "user-agent": "CodexBridge-software-sync/1", ...headers },
      signal: AbortSignal.timeout(5 * 60_000),
    });
  } catch (error) {
    throw new Error("software_sync_download_failed", { cause: error });
  }
  if (!response?.ok) {
    const error = syncError("software_sync_download_failed");
    error.retryable = Number(response?.status) === 408 || Number(response?.status) === 429
      || Number(response?.status) >= 500;
    throw error;
  }
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
    throw syncError("software_sync_download_too_large");
  }
  const output = await fsPromises.open(packagePath, "wx", 0o600);
  let size = 0;
  const hash = crypto.createHash("sha256");
  try {
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        size += chunk.length;
        if (size > MAX_DOWNLOAD_BYTES) throw syncError("software_sync_download_too_large");
        hash.update(chunk);
        await output.write(chunk, 0, chunk.length, null);
      }
    } else {
      const bytes = Buffer.from(await response.arrayBuffer());
      size = bytes.length;
      if (size > MAX_DOWNLOAD_BYTES) throw syncError("software_sync_download_too_large");
      hash.update(bytes);
      await output.write(bytes, 0, bytes.length, null);
    }
    if (!size) throw syncError("software_sync_download_empty");
    if (declared > 0 && size !== declared) throw syncError("software_sync_download_incomplete");
    await output.sync();
  } catch (error) {
    await output.close().catch(() => {});
    await fsPromises.unlink(packagePath).catch(() => {});
    if (!error.code || ["software_sync_download_empty", "software_sync_download_incomplete"].includes(error.code)) {
      error.retryable = true;
    }
    throw error;
  }
  await output.close();
  return Object.freeze({ packagePath, size, sha256: hash.digest("hex"), sourceUrl: url });
}

function retryableDownloadError(error) {
  return error?.retryable === true || ["AbortError", "TimeoutError", "TypeError"].includes(error?.name)
    || (!error?.code && error?.message === "software_sync_download_failed");
}

async function resolveAssetDownloadUrl({ url, fetchImpl, headers }) {
  let parsed;
  try { parsed = new URL(url); } catch { throw syncError("software_sync_download_url_invalid"); }
  if (parsed.protocol !== "https:" || parsed.hostname !== "api.github.com"
    || !/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/assets\/\d+$/u.test(parsed.pathname)
    || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw syncError("software_sync_download_url_invalid");
  }
  let response;
  try {
    response = await fetchImpl(parsed.href, {
      redirect: "manual",
      headers: { "user-agent": "CodexBridge-software-sync/1", ...headers },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error("software_sync_download_failed", { cause: error });
  }
  const location = response?.headers?.get?.("location");
  try { await response?.body?.cancel?.(); } catch {}
  let resolved;
  try { resolved = new URL(location); } catch { throw syncError("software_sync_download_redirect_invalid"); }
  if (![301, 302, 303, 307, 308].includes(response?.status) || resolved.protocol !== "https:"
    || resolved.hostname !== "release-assets.githubusercontent.com" || resolved.username || resolved.password
    || resolved.hash || !resolved.pathname.startsWith("/github-production-release-asset/")) {
    throw syncError("software_sync_download_redirect_invalid");
  }
  return resolved.href;
}

async function fetchRangeChunk({ url, fetchImpl, headers, start, end, total }) {
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: "error",
      headers: {
        "user-agent": "CodexBridge-software-sync/1",
        ...headers,
        range: `bytes=${start}-${end}`,
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error("software_sync_download_failed", { cause: error });
  }
  if (response?.status !== 206) {
    const error = syncError("software_sync_download_range_rejected");
    error.retryable = Number(response?.status) === 408 || Number(response?.status) === 429
      || Number(response?.status) >= 500;
    throw error;
  }
  const expectedLength = end - start + 1;
  if (response.headers?.get?.("content-range") !== `bytes ${start}-${end}/${total}`
    || Number(response.headers?.get?.("content-length")) !== expectedLength) {
    throw syncError("software_sync_download_range_invalid");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== expectedLength) throw syncError("software_sync_download_incomplete");
  return bytes;
}

async function downloadRangesToPart({
  url, fetchImpl, packagePath, headers, expectedSize, retryDelay, onProgress,
}) {
  const resolvedUrl = await resolveAssetDownloadUrl({ url, fetchImpl, headers });
  const assetHeaders = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== "authorization"));
  const output = await fsPromises.open(packagePath, "wx", 0o600);
  const hash = crypto.createHash("sha256");
  let size = 0;
  try {
    while (size < expectedSize) {
      const end = Math.min(expectedSize - 1, size + DOWNLOAD_RANGE_BYTES - 1);
      let bytes;
      let lastError;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          bytes = await fetchRangeChunk({
            url: resolvedUrl, fetchImpl, headers: assetHeaders, start: size, end, total: expectedSize,
          });
          break;
        } catch (error) {
          lastError = error;
          if (!retryableDownloadError(error) || attempt === 3) break;
          await retryDelay(attempt * 1_000);
        }
      }
      if (!bytes) {
        if (lastError?.code) throw lastError;
        throw new Error("software_sync_download_failed", { cause: lastError });
      }
      let written = 0;
      while (written < bytes.length) {
        const result = await output.write(bytes, written, bytes.length - written, null);
        if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten < 1) {
          throw syncError("software_sync_download_write_failed");
        }
        written += result.bytesWritten;
      }
      hash.update(bytes);
      size += bytes.length;
      if (typeof onProgress === "function") {
        await onProgress(Object.freeze({ downloadedBytes: size, totalBytes: expectedSize }));
      }
    }
    await output.sync();
  } catch (error) {
    await output.close().catch(() => {});
    await fsPromises.unlink(packagePath).catch(() => {});
    throw error;
  }
  await output.close();
  return Object.freeze({ packagePath, size, sha256: hash.digest("hex"), sourceUrl: url });
}

export async function downloadToPart({
  url, fetchImpl = globalThis.fetch, workRoot, prefix,
  headers = {},
  expectedSize = null,
  onProgress = null,
  retryDelay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const root = safeWorkRoot(workRoot);
  await fsPromises.mkdir(root, { recursive: true });
  const packagePath = path.join(root, `${prefix}-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.part`);
  if (expectedSize !== null) {
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > MAX_DOWNLOAD_BYTES) {
      throw syncError("software_sync_download_size_invalid");
    }
    return downloadRangesToPart({
      url, fetchImpl, packagePath, headers, expectedSize, retryDelay, onProgress,
    });
  }
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await downloadAttempt({ url, fetchImpl, packagePath, headers });
    } catch (error) {
      lastError = error;
      await fsPromises.unlink(packagePath).catch(() => {});
      if (!retryableDownloadError(error) || attempt === 3) break;
      await retryDelay(attempt * 1_000);
    }
  }
  if (lastError?.code) throw lastError;
  throw new Error("software_sync_download_failed", { cause: lastError });
}

function safeArchiveRelative(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.includes(":")
    && !value.includes("\0") && !value.startsWith("/")
    && value.split("/").every((part) => part && part !== "." && part !== "..");
}

export function parseV2RayNArchiveListing(stdout) {
  const entries = String(stdout).split(/\r?\n\r?\n/u).map((block) => {
    const values = Object.fromEntries(block.split(/\r?\n/u).map((line) => {
      const index = line.indexOf(" = ");
      return index < 0 ? ["", ""] : [line.slice(0, index), line.slice(index + 3)];
    }).filter(([key]) => key));
    if (values.Folder === "+" || !values.Path) return null;
    const original = values.Path;
    const normalized = original.replaceAll("\\", "/");
    return { original, normalized };
  }).filter(Boolean);
  const normalizedKeys = new Set();
  for (const entry of entries) {
    const key = entry.normalized.normalize("NFC").toLowerCase();
    if (!safeArchiveRelative(entry.normalized) || normalizedKeys.has(key)) {
      throw syncError("software_sync_v2rayn_archive_invalid");
    }
    normalizedKeys.add(key);
  }
  const executableEntries = entries.filter(({ normalized }) => /(?:^|\/)v2rayN\.exe$/u.test(normalized));
  if (!entries.length || executableEntries.length !== 1) {
    throw syncError("software_sync_v2rayn_archive_invalid");
  }
  return Object.freeze({
    extractionEntry: executableEntries[0].original,
    entrypoint: executableEntries[0].normalized,
    requiredFiles: Object.freeze(entries.map(({ normalized }) => normalized)),
  });
}

function validateInspection(value) {
  if (!value || !VERSION.test(value.version ?? "") || !safeArchiveRelative(value.entrypoint)
    || !/(?:^|\/)v2rayN\.exe$/u.test(value.entrypoint)
    || !Array.isArray(value.requiredFiles) || !value.requiredFiles.includes(value.entrypoint)
    || value.requiredFiles.some((item) => !safeArchiveRelative(item))
    || !Number.isSafeInteger(value.maxRelativePathLength) || value.maxRelativePathLength < 1) {
    throw syncError("software_sync_v2rayn_inspection_invalid");
  }
  return value;
}

function scanFixedFileVersion(buffer, start = 0, end = buffer.length) {
  for (let offset = start; offset + 16 <= end; offset += 1) {
    if (buffer.readUInt32LE(offset) !== 0xfeef04bd || buffer.readUInt32LE(offset + 4) !== 0x00010000) continue;
    const versionMs = buffer.readUInt32LE(offset + 8);
    const versionLs = buffer.readUInt32LE(offset + 12);
    const parts = [versionMs >>> 16, versionMs & 0xffff, versionLs >>> 16, versionLs & 0xffff];
    if (parts.every((value) => value === 0)) continue;
    return parts.join(".");
  }
  return null;
}

function rangeFits(buffer, offset, size) {
  return Number.isSafeInteger(offset) && Number.isSafeInteger(size) && offset >= 0 && size >= 0
    && offset <= buffer.length && size <= buffer.length - offset;
}

function readPeResourceFileVersion(buffer) {
  if (!rangeFits(buffer, 0x3c, 4)) return null;
  const peOffset = buffer.readUInt32LE(0x3c);
  if (!rangeFits(buffer, peOffset, 24) || buffer.toString("binary", peOffset, peOffset + 4) !== "PE\0\0") return null;
  const sectionCount = buffer.readUInt16LE(peOffset + 6);
  const optionalSize = buffer.readUInt16LE(peOffset + 20);
  if (sectionCount < 1 || sectionCount > 96) return null;
  const optionalOffset = peOffset + 24;
  if (!rangeFits(buffer, optionalOffset, optionalSize)) return null;
  const magic = buffer.readUInt16LE(optionalOffset);
  const dataDirectoryOffset = magic === 0x20b ? optionalOffset + 112 : magic === 0x10b ? optionalOffset + 96 : -1;
  const resourceDirectoryEntry = dataDirectoryOffset + (2 * 8);
  if (!rangeFits(buffer, resourceDirectoryEntry, 8)) return null;
  const resourceRva = buffer.readUInt32LE(resourceDirectoryEntry);
  if (!resourceRva) return null;
  const sectionOffset = optionalOffset + optionalSize;
  if (!rangeFits(buffer, sectionOffset, sectionCount * 40)) return null;

  const rvaToOffset = (rva) => {
    for (let index = 0; index < sectionCount; index += 1) {
      const current = sectionOffset + (index * 40);
      const virtualSize = buffer.readUInt32LE(current + 8);
      const virtualAddress = buffer.readUInt32LE(current + 12);
      const rawSize = buffer.readUInt32LE(current + 16);
      const rawOffset = buffer.readUInt32LE(current + 20);
      const span = Math.max(virtualSize, rawSize);
      if (rva < virtualAddress || rva >= virtualAddress + span) continue;
      const relative = rva - virtualAddress;
      if (relative >= rawSize || !rangeFits(buffer, rawOffset + relative, 1)) return null;
      return rawOffset + relative;
    }
    return null;
  };

  const resourceRoot = rvaToOffset(resourceRva);
  if (resourceRoot === null) return null;
  const entriesAt = (relativeOffset) => {
    const directory = resourceRoot + relativeOffset;
    if (!rangeFits(buffer, directory, 16)) return [];
    const count = buffer.readUInt16LE(directory + 12) + buffer.readUInt16LE(directory + 14);
    if (count < 1 || count > 4096 || !rangeFits(buffer, directory + 16, count * 8)) return [];
    return Array.from({ length: count }, (_, index) => {
      const entry = directory + 16 + (index * 8);
      return { name: buffer.readUInt32LE(entry), target: buffer.readUInt32LE(entry + 4) };
    });
  };
  const versionType = entriesAt(0).find((entry) => !(entry.name & 0x80000000) && (entry.name & 0xffff) === 16);
  if (!versionType) return null;

  const resolveData = (target, depth = 0) => {
    if (depth > 4) return null;
    if (target & 0x80000000) {
      for (const entry of entriesAt(target & 0x7fffffff)) {
        const resolved = resolveData(entry.target, depth + 1);
        if (resolved) return resolved;
      }
      return null;
    }
    const dataEntry = resourceRoot + (target & 0x7fffffff);
    if (!rangeFits(buffer, dataEntry, 16)) return null;
    const dataOffset = rvaToOffset(buffer.readUInt32LE(dataEntry));
    const dataSize = buffer.readUInt32LE(dataEntry + 4);
    return dataOffset !== null && rangeFits(buffer, dataOffset, dataSize) ? [dataOffset, dataOffset + dataSize] : null;
  };
  const range = resolveData(versionType.target);
  return range ? scanFixedFileVersion(buffer, range[0], range[1]) : null;
}

export function readPeFileVersion(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  const version = readPeResourceFileVersion(buffer) ?? scanFixedFileVersion(buffer);
  if (version) return version;
  throw syncError("software_sync_pe_version_missing");
}

export async function inspectV2RayNRelease({
  currentCatalog = { components: [] },
  fetchImpl = globalThis.fetch,
  archiveInspector = defaultArchiveInspector,
  pgpVerifier = defaultPgpVerifier,
  workRoot,
  githubToken = process.env.GITHUB_TOKEN,
  onProgress = null,
} = {}) {
  const metadataResponse = await fetchImpl(V2RAYN_RELEASE_API_URL, {
    redirect: "error",
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "CodexBridge-software-sync/1",
      ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}),
    },
  });
  if (!metadataResponse?.ok) throw syncError("software_sync_v2rayn_metadata_failed");
  const selected = selectV2RayNAssets(await metadataResponse.json());
  const current = currentCatalog.components?.find((item) => item.id === "v2rayn");
  if (selected.packageAsset.sha256 && current?.format === "zip"
    && equivalentWindowsVersion(current.version, selected.version)
    && current.size === selected.packageAsset.size && current.sha256 === selected.packageAsset.sha256) {
    return Object.freeze({
      id: "v2rayn",
      action: "noop",
      reason: "version_and_digest_unchanged",
      version: current.version,
      sha256: current.sha256,
      identity: `${current.version}:${current.sha256}`,
    });
  }
  const downloaded = await downloadToPart({
    url: selected.packageAsset.url,
    fetchImpl,
    workRoot,
    prefix: "v2rayn",
    expectedSize: selected.packageAsset.size,
    headers: {
      accept: "application/octet-stream",
      ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}),
    },
    onProgress: typeof onProgress === "function"
      ? (event) => onProgress(Object.freeze({ componentId: "v2rayn", ...event }))
      : null,
  });
  let signature = null;
  try {
    if (downloaded.size !== selected.packageAsset.size) throw syncError("software_sync_v2rayn_asset_size_mismatch");
    signature = await downloadToPart({
      url: selected.signatureAsset.url,
      fetchImpl,
      workRoot,
      prefix: "v2rayn-signature",
      expectedSize: selected.signatureAsset.size,
      headers: {
        accept: "application/octet-stream",
        ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}),
      },
    });
    if (signature.size !== selected.signatureAsset.size || signature.size > 64 * 1024) {
      throw syncError("software_sync_v2rayn_signature_invalid");
    }
    const fingerprint = await pgpVerifier(downloaded.packagePath, signature.packagePath);
    if (fingerprint !== V2RAYN_SIGNING_FINGERPRINT) throw syncError("software_sync_v2rayn_signature_invalid");
    const inspected = validateInspection(await archiveInspector(downloaded.packagePath));
    if (!equivalentWindowsVersion(inspected.version, selected.version)) {
      throw syncError("software_sync_v2rayn_version_mismatch");
    }
    const unchanged = current?.sha256 === downloaded.sha256;
    return Object.freeze({
      ...downloaded,
      id: "v2rayn",
      action: unchanged ? "noop" : "publish",
      ...(unchanged ? { reason: "content_unchanged" } : {}),
      version: inspected.version,
      identity: `${inspected.version}:${downloaded.sha256}`,
      format: "zip",
      entrypoint: inspected.entrypoint,
      requiredFiles: Object.freeze([...inspected.requiredFiles]),
      maxRelativePathLength: inspected.maxRelativePathLength,
      authenticity: "pgp",
      signingFingerprint: fingerprint,
      signaturePath: signature.packagePath,
    });
  } catch (error) {
    await fsPromises.unlink(downloaded.packagePath).catch(() => {});
    if (signature) await fsPromises.unlink(signature.packagePath).catch(() => {});
    throw error;
  }
}

async function defaultArchiveInspector(packagePath) {
  const sevenZipRoot = path.dirname(require.resolve("7zip-bin"));
  const platformDirectory = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
  const sevenZip = path.join(sevenZipRoot, platformDirectory, process.arch, process.platform === "win32" ? "7za.exe" : "7za");
  const { stdout } = await execFileAsync(sevenZip, ["l", "-slt", "-ba", "--", packagePath], {
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const listing = parseV2RayNArchiveListing(stdout);
  const extractRoot = path.join(path.dirname(packagePath), `v2rayn-inspect-${process.pid}-${Date.now()}`);
  await fsPromises.mkdir(extractRoot);
  const executable = path.join(extractRoot, "v2rayN.exe");
  try {
    await execFileAsync(sevenZip, ["e", "-y", `-o${extractRoot}`, "--", packagePath, listing.extractionEntry], {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return {
      version: readPeFileVersion(fs.readFileSync(executable)),
      entrypoint: listing.entrypoint,
      requiredFiles: listing.requiredFiles,
      maxRelativePathLength: Math.max(...listing.requiredFiles.map((value) => value.length)),
    };
  } finally {
    await fsPromises.unlink(executable).catch(() => {});
    await fsPromises.rmdir(extractRoot).catch(() => {});
  }
}
