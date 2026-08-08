import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";

export const V2RAYN_PACKAGE_URL = "https://v1.v2ai.top/ssr-download/v2rayn.7z";
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const VERSION = /^\d+(?:\.\d+){0,3}$/u;
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

function syncError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeWorkRoot(value) {
  const raw = String(value || "");
  if (!raw || !path.isAbsolute(raw) || path.normalize(raw) !== raw || raw === path.parse(raw).root) {
    throw syncError("software_sync_work_root_invalid");
  }
  return raw;
}

export async function downloadToPart({ url, fetchImpl = globalThis.fetch, workRoot, prefix }) {
  const root = safeWorkRoot(workRoot);
  await fsPromises.mkdir(root, { recursive: true });
  const packagePath = path.join(root, `${prefix}-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.part`);
  let response;
  try {
    response = await fetchImpl(url, { redirect: "follow", headers: { "user-agent": "CodexBridge-software-sync/1" } });
  } catch (error) {
    throw new Error("software_sync_download_failed", { cause: error });
  }
  if (!response?.ok) throw syncError("software_sync_download_failed");
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) throw syncError("software_sync_download_too_large");
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
    await output.sync();
  } catch (error) {
    await output.close().catch(() => {});
    await fsPromises.unlink(packagePath).catch(() => {});
    throw error;
  }
  await output.close();
  return Object.freeze({ packagePath, size, sha256: hash.digest("hex"), sourceUrl: url });
}

function validateInspection(value) {
  if (!value || !VERSION.test(value.version ?? "") || value.entrypoint !== "v2rayN.exe"
    || !Array.isArray(value.requiredFiles) || !value.requiredFiles.includes("v2rayN.exe")
    || value.requiredFiles.some((item) => typeof item !== "string" || !item || item.includes("\\") || item.includes(".."))
    || !Number.isSafeInteger(value.maxRelativePathLength) || value.maxRelativePathLength < 1) {
    throw syncError("software_sync_v2rayn_inspection_invalid");
  }
  return value;
}

export function readPeFileVersion(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  for (let offset = 0; offset + 16 <= buffer.length; offset += 1) {
    if (buffer.readUInt32LE(offset) !== 0xfeef04bd || buffer.readUInt32LE(offset + 4) !== 0x00010000) continue;
    const versionMs = buffer.readUInt32LE(offset + 8);
    const versionLs = buffer.readUInt32LE(offset + 12);
    const parts = [versionMs >>> 16, versionMs & 0xffff, versionLs >>> 16, versionLs & 0xffff];
    if (parts.every((value) => value === 0)) continue;
    return parts.join(".");
  }
  throw syncError("software_sync_pe_version_missing");
}

export async function inspectV2RayNRelease({
  currentCatalog = { components: [] },
  fetchImpl = globalThis.fetch,
  archiveInspector = defaultArchiveInspector,
  workRoot,
} = {}) {
  const downloaded = await downloadToPart({
    url: V2RAYN_PACKAGE_URL,
    fetchImpl,
    workRoot,
    prefix: "v2rayn",
  });
  try {
    const inspected = validateInspection(await archiveInspector(downloaded.packagePath));
    const current = currentCatalog.components?.find((item) => item.id === "v2rayn");
    const unchanged = current?.sha256 === downloaded.sha256;
    return Object.freeze({
      ...downloaded,
      id: "v2rayn",
      action: unchanged ? "noop" : "publish",
      ...(unchanged ? { reason: "content_unchanged" } : {}),
      version: inspected.version,
      identity: `${inspected.version}:${downloaded.sha256}`,
      format: "7z",
      entrypoint: inspected.entrypoint,
      requiredFiles: Object.freeze([...inspected.requiredFiles]),
      maxRelativePathLength: inspected.maxRelativePathLength,
    });
  } catch (error) {
    await fsPromises.unlink(downloaded.packagePath).catch(() => {});
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
  const paths = String(stdout).split(/\r?\n\r?\n/u).map((block) => {
    const values = Object.fromEntries(block.split(/\r?\n/u).map((line) => {
      const index = line.indexOf(" = ");
      return index < 0 ? ["", ""] : [line.slice(0, index), line.slice(index + 3)];
    }).filter(([key]) => key));
    return values.Folder === "+" ? null : values.Path;
  }).filter(Boolean);
  if (!paths.length || paths.some((value) => value.includes("\\") || value.startsWith("/")
    || value.split("/").some((part) => !part || part === "." || part === ".."))) {
    throw syncError("software_sync_v2rayn_archive_invalid");
  }
  const executableEntry = paths.filter((value) => /(?:^|\/)v2rayN\.exe$/u.test(value));
  if (executableEntry.length !== 1) throw syncError("software_sync_v2rayn_archive_invalid");
  const extractRoot = path.join(path.dirname(packagePath), `v2rayn-inspect-${process.pid}-${Date.now()}`);
  await fsPromises.mkdir(extractRoot);
  const executable = path.join(extractRoot, "v2rayN.exe");
  try {
    await execFileAsync(sevenZip, ["e", "-y", `-o${extractRoot}`, "--", packagePath, executableEntry[0]], {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return {
      version: readPeFileVersion(fs.readFileSync(executable)),
      entrypoint: "v2rayN.exe",
      requiredFiles: paths,
      maxRelativePathLength: Math.max(...paths.map((value) => value.length)),
    };
  } finally {
    await fsPromises.unlink(executable).catch(() => {});
    await fsPromises.rmdir(extractRoot).catch(() => {});
  }
}
