import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyCatalogEnvelope } from "../desktop/software-manager/catalog-trust.mjs";
import { loadPublisherConfig } from "../scripts/software-manager/publisher-config.mjs";
import {
  downloadToPart,
  inspectV2RayNRelease,
  parseV2RayNArchiveListing,
  readPeFileVersion,
  V2RAYN_PACKAGE_NAME,
  V2RAYN_RELEASE_API_URL,
  V2RAYN_SIGNATURE_NAME,
  V2RAYN_SIGNING_FINGERPRINT,
} from "../scripts/software-manager/sync-v2rayn.mjs";
import { GIT_RELEASE_API_URL, inspectGitRelease, parseAuthenticodeTimestamp } from "../scripts/software-manager/sync-git.mjs";
import {
  publishComponentReleases,
  syncComponents,
  writeSoftwareSyncStatus,
} from "../scripts/software-manager/sync-components.mjs";

function tempRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function responseBytes(bytes, url = "", requestOptions = {}) {
  if (requestOptions.redirect === "manual") {
    const assetId = new URL(url).pathname.split("/").at(-1);
    return {
      ok: false,
      status: 302,
      headers: { get: (name) => name === "location"
        ? `https://release-assets.githubusercontent.com/github-production-release-asset/1/${assetId}?token=test`
        : null },
      body: { cancel: async () => {} },
    };
  }
  const match = /^bytes=(\d+)-(\d+)$/u.exec(requestOptions.headers?.range ?? "");
  const start = match ? Number(match[1]) : 0;
  const end = match ? Number(match[2]) : bytes.length - 1;
  const body = bytes.subarray(start, end + 1);
  return {
    ok: true,
    status: match ? 206 : 200,
    url,
    headers: { get: (name) => name === "content-range"
      ? (match ? `bytes ${start}-${end}/${bytes.length}` : null)
      : name === "content-length" ? String(body.length) : null },
    arrayBuffer: async () => Buffer.from(body),
  };
}

function isV2RayNSignatureAsset(url) {
  return new URL(url).pathname.endsWith("/102");
}

function v2rayNMetadata(version, packageSize, signatureSize, packageDigest = null) {
  const base = `https://github.com/fqfqgo/v2rayN/releases/download/${version}`;
  return {
    tag_name: version,
    assets: [
      {
        id: 101,
        name: V2RAYN_PACKAGE_NAME,
        size: packageSize,
        digest: packageDigest ? `sha256:${packageDigest}` : null,
        url: "https://api.github.com/repos/fqfqgo/v2rayN/releases/assets/101",
        browser_download_url: `${base}/${V2RAYN_PACKAGE_NAME}`,
      },
      {
        id: 102,
        name: V2RAYN_SIGNATURE_NAME,
        size: signatureSize,
        url: "https://api.github.com/repos/fqfqgo/v2rayN/releases/assets/102",
        browser_download_url: `${base}/${V2RAYN_SIGNATURE_NAME}`,
      },
    ],
  };
}

function component(id, sha256) {
  return {
    id,
    name: id,
    version: "1.0.0",
    architecture: "x64",
    format: id === "git" ? "exe" : "zip",
    assetUrl: `https://shanhaiyouling.com/codexbridge-test/packages/${id}-1.0.0.bin`,
    size: 1,
    sha256,
    entrypoint: id === "git" ? "cmd/git.exe" : "v2rayN.exe",
    requiredFiles: [id === "git" ? "cmd/git.exe" : "v2rayN.exe"],
    maxRelativePathLength: 32,
    publishedAt: "2026-08-08T00:00:00.000Z",
    supportsRollback: true,
  };
}

test("component download retries transient transport failures and binds the final bytes", async () => {
  const bytes = Buffer.from("retry-complete");
  const delays = [];
  let calls = 0;
  const result = await downloadToPart({
    url: "https://github.com/example/release.bin",
    workRoot: tempRoot("component-download-retry"),
    prefix: "component",
    retryDelay: async (milliseconds) => { delays.push(milliseconds); },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error("socket closed");
      return responseBytes(bytes);
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(delays, [1_000]);
  assert.equal(fs.readFileSync(result.packagePath).equals(bytes), true);
  assert.equal(result.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
});

test("software sync status atomically replaces only its fixed work-root record", async () => {
  const workRoot = tempRoot("software-sync-status");
  const filePath = path.join(workRoot, "sync-status.json");
  await writeSoftwareSyncStatus({
    filePath,
    workRoot,
    value: { schemaVersion: 1, status: "running" },
  });
  await writeSoftwareSyncStatus({
    filePath,
    workRoot,
    value: { schemaVersion: 1, status: "succeeded", action: "published" },
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), {
    schemaVersion: 1,
    status: "succeeded",
    action: "published",
  });
  assert.equal(fs.readdirSync(workRoot).some((name) => name.includes(".tmp-")), false);
  await assert.rejects(writeSoftwareSyncStatus({
    filePath: path.join(workRoot, "other.json"),
    workRoot,
    value: { status: "failed" },
  }), /software_sync_status_path_invalid/u);
});

test("component download retries a truncated declared body but not a permanent HTTP rejection", async () => {
  const bytes = Buffer.from("complete");
  let truncatedReads = 0;
  let calls = 0;
  const result = await downloadToPart({
    url: "https://github.com/example/release.bin",
    workRoot: tempRoot("component-download-truncated"),
    prefix: "component",
    retryDelay: async () => {},
    fetchImpl: async () => {
      calls += 1;
      if (calls > 1) return responseBytes(bytes);
      return {
        ok: true,
        status: 200,
        headers: { get: () => String(bytes.length) },
        body: { getReader: () => ({
          read: async () => truncatedReads++ === 0
            ? { done: false, value: bytes.subarray(0, 2) }
            : { done: true },
        }) },
      };
    },
  });
  assert.equal(calls, 2);
  assert.equal(fs.readFileSync(result.packagePath).equals(bytes), true);

  let rejectedCalls = 0;
  await assert.rejects(downloadToPart({
    url: "https://github.com/example/missing.bin",
    workRoot: tempRoot("component-download-rejected"),
    prefix: "component",
    retryDelay: async () => { throw new Error("unexpected retry"); },
    fetchImpl: async () => (rejectedCalls += 1, { ok: false, status: 404 }),
  }), /software_sync_download_failed/u);
  assert.equal(rejectedCalls, 1);
});

test("known GitHub assets download in bounded verified ranges and retry one timed-out chunk", async () => {
  const bytes = Buffer.alloc((1024 * 1024) + 5, 0x5a);
  const ranges = [];
  const delays = [];
  let secondChunkAttempts = 0;
  const result = await downloadToPart({
    url: "https://api.github.com/repos/example/repo/releases/assets/1",
    workRoot: tempRoot("component-range-download"),
    prefix: "component",
    expectedSize: bytes.length,
    retryDelay: async (milliseconds) => { delays.push(milliseconds); },
    fetchImpl: async (url, options) => {
      if (options.headers.range) ranges.push(options.headers.range);
      if (options.headers.range?.startsWith("bytes=1048576-") && secondChunkAttempts++ === 0) {
        throw new DOMException("timed out", "TimeoutError");
      }
      return responseBytes(bytes, url, options);
    },
  });
  assert.deepEqual(ranges, [
    "bytes=0-1048575",
    `bytes=1048576-${bytes.length - 1}`,
    `bytes=1048576-${bytes.length - 1}`,
  ]);
  assert.deepEqual(delays, [1_000]);
  assert.equal(fs.readFileSync(result.packagePath).equals(bytes), true);
});

test("V2RayN archive listing normalizes official Windows separators without weakening containment", () => {
  const listing = parseV2RayNArchiveListing([
    "Path = v2rayN-windows-64\\bin",
    "Folder = +",
    "",
    "Path = v2rayN-windows-64\\v2rayN.exe",
    "Folder = -",
    "",
    "Path = v2rayN-windows-64\\bin\\xray.exe",
    "Folder = -",
  ].join("\r\n"));
  assert.equal(listing.extractionEntry, "v2rayN-windows-64\\v2rayN.exe");
  assert.equal(listing.entrypoint, "v2rayN-windows-64/v2rayN.exe");
  assert.deepEqual([...listing.requiredFiles], [
    "v2rayN-windows-64/v2rayN.exe",
    "v2rayN-windows-64/bin/xray.exe",
  ]);
});

test("V2RayN archive listing rejects traversal, drive paths, and normalized aliases", () => {
  const listing = (paths) => paths.map((value) => `Path = ${value}\r\nFolder = -`).join("\r\n\r\n");
  assert.throws(() => parseV2RayNArchiveListing(listing(["..\\v2rayN.exe"])), /software_sync_v2rayn_archive_invalid/u);
  assert.throws(() => parseV2RayNArchiveListing(listing(["C:\\v2rayN.exe"])), /software_sync_v2rayn_archive_invalid/u);
  assert.throws(() => parseV2RayNArchiveListing(listing([
    "app\\v2rayN.exe", "app/v2rayn.exe",
  ])), /software_sync_v2rayn_archive_invalid/u);
});

test("V2RayN official desktop ZIP publishes only after pinned PGP verification", async () => {
  const bytes = Buffer.from("v2rayn-release");
  const signature = Buffer.from("signature");
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const calls = [];
  const result = await inspectV2RayNRelease({
    currentCatalog: { schemaVersion: 1, components: [component("v2rayn", hash)], skills: [] },
    workRoot: tempRoot("v2rayn-sync"),
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      if (url === V2RAYN_RELEASE_API_URL) {
        return { ok: true, json: async () => v2rayNMetadata("7.24.7", bytes.length, signature.length) };
      }
      return responseBytes(isV2RayNSignatureAsset(url) ? signature : bytes, url, options);
    },
    archiveInspector: async (packagePath) => {
      assert.match(packagePath, /\.part$/u);
      return {
        version: "7.24.7.0",
        entrypoint: "v2rayn/v2rayN.exe",
        requiredFiles: ["v2rayn/v2rayN.exe", "v2rayn/bin/xray.exe"],
        maxRelativePathLength: 12,
      };
    },
    pgpVerifier: async (packagePath, signaturePath) => {
      assert.match(packagePath, /\.part$/u);
      assert.match(signaturePath, /\.part$/u);
      return V2RAYN_SIGNING_FINGERPRINT;
    },
  });
  assert.equal(result.action, "noop");
  assert.equal(result.reason, "content_unchanged");
  assert.equal(result.version, "7.24.7.0");
  assert.equal(result.format, "zip");
  assert.equal(result.authenticity, "pgp");
  assert.equal(result.entrypoint, "v2rayn/v2rayN.exe");
  assert.equal(calls[0][0], V2RAYN_RELEASE_API_URL);
  assert.equal(calls[1][1].redirect, "manual");
});

test("V2RayN skips the signed asset when official version, size, and digest are unchanged", async () => {
  const bytes = Buffer.from("already-published-v2rayn");
  const signature = Buffer.from("signature");
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const current = component("v2rayn", hash);
  Object.assign(current, { version: "7.24.7.0", format: "zip", size: bytes.length });
  const calls = [];
  const result = await inspectV2RayNRelease({
    currentCatalog: { schemaVersion: 1, components: [current], skills: [] },
    workRoot: tempRoot("v2rayn-current"),
    fetchImpl: async (url) => {
      calls.push(url);
      if (url !== V2RAYN_RELEASE_API_URL) throw new Error("asset must not be downloaded");
      return {
        ok: true,
        json: async () => v2rayNMetadata("7.24.7", bytes.length, signature.length, hash),
      };
    },
    archiveInspector: async () => { throw new Error("archive must not be inspected"); },
    pgpVerifier: async () => { throw new Error("unchanged asset must not be reverified"); },
  });
  assert.deepEqual(calls, [V2RAYN_RELEASE_API_URL]);
  assert.equal(result.action, "noop");
  assert.equal(result.reason, "version_and_digest_unchanged");
  assert.equal(result.version, "7.24.7.0");
  assert.equal(result.sha256, hash);
});

test("V2RayN release identity comes from signed ZIP version plus hash", async () => {
  const bytes = Buffer.from("changed-v2rayn-release");
  const signature = Buffer.from("signature");
  const result = await inspectV2RayNRelease({
    currentCatalog: { schemaVersion: 1, components: [], skills: [] },
    workRoot: tempRoot("v2rayn-changed"),
    fetchImpl: async (url, options) => url === V2RAYN_RELEASE_API_URL
      ? { ok: true, json: async () => v2rayNMetadata("7.24.7", bytes.length, signature.length) }
      : responseBytes(isV2RayNSignatureAsset(url) ? signature : bytes, url, options),
    archiveInspector: async () => ({
      version: "7.24.7.0",
      entrypoint: "v2rayN.exe",
      requiredFiles: ["v2rayN.exe"],
      maxRelativePathLength: 11,
    }),
    pgpVerifier: async () => V2RAYN_SIGNING_FINGERPRINT,
  });
  assert.equal(result.action, "publish");
  assert.equal(result.version, "7.24.7.0");
  assert.match(result.sha256, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(result.identity, /github\.com/u);
});

test("V2RayN release accepts only a trailing-zero-equivalent signed file version", async () => {
  const bytes = Buffer.from("changed-v2rayn-version");
  const signature = Buffer.from("signature");
  await assert.rejects(inspectV2RayNRelease({
    currentCatalog: { schemaVersion: 1, components: [], skills: [] },
    workRoot: tempRoot("v2rayn-version-mismatch"),
    fetchImpl: async (url, options) => url === V2RAYN_RELEASE_API_URL
      ? { ok: true, json: async () => v2rayNMetadata("7.24.7", bytes.length, signature.length) }
      : responseBytes(isV2RayNSignatureAsset(url) ? signature : bytes, url, options),
    archiveInspector: async () => ({
      version: "7.24.8.0",
      entrypoint: "v2rayN.exe",
      requiredFiles: ["v2rayN.exe"],
      maxRelativePathLength: 11,
    }),
    pgpVerifier: async () => V2RAYN_SIGNING_FINGERPRINT,
  }), /software_sync_v2rayn_version_mismatch/u);
});

test("V2RayN changed packages never reach publication when PGP verification fails", async () => {
  const bytes = Buffer.from("changed-v2rayn-release");
  const signature = Buffer.from("bad-signature");
  await assert.rejects(inspectV2RayNRelease({
    currentCatalog: { schemaVersion: 1, components: [], skills: [] },
    workRoot: tempRoot("v2rayn-bad-signature"),
    fetchImpl: async (url, options) => url === V2RAYN_RELEASE_API_URL
      ? { ok: true, json: async () => v2rayNMetadata("7.24.7", bytes.length, signature.length) }
      : responseBytes(isV2RayNSignatureAsset(url) ? signature : bytes, url, options),
    archiveInspector: async () => ({
      version: "7.24.7", entrypoint: "v2rayN.exe", requiredFiles: ["v2rayN.exe"], maxRelativePathLength: 11,
    }),
    pgpVerifier: async () => { throw new Error("bad signature"); },
  }), /bad signature/u);
});

test("cross-platform PE inspection reads the fixed file version without PowerShell", () => {
  const bytes = Buffer.alloc(96);
  bytes.writeUInt32LE(0xfeef04bd, 32);
  bytes.writeUInt32LE(0x00010000, 36);
  bytes.writeUInt32LE((7 << 16) | 20, 40);
  bytes.writeUInt32LE((4 << 16) | 9, 44);
  assert.equal(readPeFileVersion(bytes), "7.20.4.9");
  assert.throws(() => readPeFileVersion(Buffer.alloc(32)), /software_sync_pe_version_missing/);
});

test("PE inspection reads the outer executable version resource instead of an embedded runtime decoy", () => {
  const bytes = Buffer.alloc(1024);
  bytes.writeUInt32LE(0xfeef04bd, 32);
  bytes.writeUInt32LE(0x00010000, 36);
  bytes.writeUInt32LE((10 << 16) | 0, 40);
  bytes.writeUInt32LE((1026 << 16) | 32716, 44);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "binary");
  bytes.writeUInt16LE(1, 0x86);
  bytes.writeUInt16LE(0xf0, 0x94);
  bytes.writeUInt16LE(0x20b, 0x98);
  bytes.writeUInt32LE(0x1000, 0x118);
  bytes.writeUInt32LE(0x200, 0x11c);
  bytes.writeUInt32LE(0x200, 0x190);
  bytes.writeUInt32LE(0x1000, 0x194);
  bytes.writeUInt32LE(0x200, 0x198);
  bytes.writeUInt32LE(0x200, 0x19c);
  bytes.writeUInt16LE(1, 0x20e);
  bytes.writeUInt32LE(16, 0x210);
  bytes.writeUInt32LE(0x80000020, 0x214);
  bytes.writeUInt16LE(1, 0x22e);
  bytes.writeUInt32LE(1, 0x230);
  bytes.writeUInt32LE(0x80000040, 0x234);
  bytes.writeUInt16LE(1, 0x24e);
  bytes.writeUInt32LE(0x409, 0x250);
  bytes.writeUInt32LE(0x60, 0x254);
  bytes.writeUInt32LE(0x1080, 0x260);
  bytes.writeUInt32LE(64, 0x264);
  bytes.writeUInt32LE(0xfeef04bd, 0x290);
  bytes.writeUInt32LE(0x00010000, 0x294);
  bytes.writeUInt32LE((7 << 16) | 24, 0x298);
  bytes.writeUInt32LE((5 << 16) | 0, 0x29c);
  assert.equal(readPeFileVersion(bytes), "7.24.5.0");
});

test("Git sync selects only the official x64 installer and requires Valid Authenticode", async () => {
  const installer = Buffer.from("signed-git-installer");
  const calls = [];
  const result = await inspectGitRelease({
    currentCatalog: { schemaVersion: 1, components: [], skills: [] },
    workRoot: tempRoot("git-sync"),
    fetchImpl: async (url, options) => {
      calls.push(url);
      if (url === GIT_RELEASE_API_URL) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tag_name: "v2.55.0.windows.3",
            assets: [
              { name: "PortableGit-2.55.0.3-64-bit.7z.exe", browser_download_url: "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.3/PortableGit-2.55.0.3-64-bit.7z.exe" },
              { name: "Git-2.55.0.3-arm64.exe", browser_download_url: "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.3/Git-2.55.0.3-arm64.exe" },
              {
                id: 203,
                name: "Git-2.55.0.3-64-bit.exe",
                size: installer.length,
                url: "https://api.github.com/repos/git-for-windows/git/releases/assets/203",
                browser_download_url: "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.3/Git-2.55.0.3-64-bit.exe",
              },
            ],
          }),
        };
      }
      return responseBytes(installer, url, options);
    },
    authenticodeInspector: async (packagePath) => {
      assert.match(packagePath, /\.part$/u);
      return "Valid";
    },
  });
  assert.equal(calls[0], GIT_RELEASE_API_URL);
  assert.equal(calls[1], "https://api.github.com/repos/git-for-windows/git/releases/assets/203");
  assert.equal(result.version, "2.55.0.3");
  assert.equal(result.action, "publish");
  assert.equal(result.authenticode, "Valid");
});

test("Git sync skips the installer download when official metadata matches the signed catalog version", async () => {
  const current = component("git", "a".repeat(64));
  current.version = "2.55.0.3";
  const calls = [];
  const result = await inspectGitRelease({
    currentCatalog: { schemaVersion: 1, components: [current], skills: [] },
    workRoot: tempRoot("git-current"),
    fetchImpl: async (url) => {
      calls.push(url);
      assert.equal(url, GIT_RELEASE_API_URL);
      return {
        ok: true,
        json: async () => ({ assets: [{
          id: 204,
          name: "Git-2.55.0.3-64-bit.exe",
          size: 1,
          url: "https://api.github.com/repos/git-for-windows/git/releases/assets/204",
          browser_download_url: "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.3/Git-2.55.0.3-64-bit.exe",
        }] }),
      };
    },
    authenticodeInspector: async () => { throw new Error("installer must not be downloaded"); },
  });
  assert.equal(result.action, "noop");
  assert.equal(result.reason, "version_unchanged");
  assert.equal(result.version, "2.55.0.3");
  assert.equal(result.sha256, current.sha256);
  assert.deepEqual(calls, [GIT_RELEASE_API_URL]);
});

test("Git sync rejects unofficial assets and failed Authenticode before publication", async () => {
  const metadata = (browserUrl, { apiUrl = "https://api.github.com/repos/git-for-windows/git/releases/assets/205" } = {}) => ({
    ok: true,
    status: 200,
    json: async () => ({
      tag_name: "v2.51.0.windows.1",
      assets: [{ id: 205, name: "Git-2.51.0-64-bit.exe", size: 1, url: apiUrl, browser_download_url: browserUrl }],
    }),
  });
  await assert.rejects(inspectGitRelease({
    currentCatalog: { schemaVersion: 1, components: [], skills: [] },
    workRoot: tempRoot("git-unofficial"),
    fetchImpl: async (url, options) => url === GIT_RELEASE_API_URL
      ? metadata("https://example.test/Git-2.51.0-64-bit.exe")
      : responseBytes(Buffer.from("x"), url, options),
    authenticodeInspector: async () => "Valid",
  }), /software_sync_git_asset_rejected/);
  await assert.rejects(inspectGitRelease({
    currentCatalog: { schemaVersion: 1, components: [], skills: [] },
    workRoot: tempRoot("git-unsigned"),
    fetchImpl: async (url, options) => url === GIT_RELEASE_API_URL
      ? metadata("https://github.com/git-for-windows/git/releases/download/v2.51.0.windows.1/Git-2.51.0-64-bit.exe")
      : responseBytes(Buffer.from("x"), url, options),
    authenticodeInspector: async () => "NotSigned",
  }), /software_sync_git_authenticode_invalid/);
});

test("Linux Authenticode validation derives one bounded verification time from the signed timestamp", () => {
  assert.equal(parseAuthenticodeTimestamp("\tTimestamp time: Jul 10 15:28:37 2026 GMT\n"), 1783697317);
  assert.throws(() => parseAuthenticodeTimestamp(""), /software_sync_git_timestamp_invalid/);
  assert.throws(() => parseAuthenticodeTimestamp("Timestamp time: Jul 10 15:28:37 2026 GMT\nTimestamp time: Jul 10 15:28:37 2026 GMT\n"), /software_sync_git_timestamp_invalid/);
});

test("combined sync inspects every source before one publisher call and leaves catalog unchanged on download failure", async () => {
  const calls = [];
  await assert.rejects(syncComponents({
    currentCatalog: { schemaVersion: 1, components: [], skills: [] },
    sources: {
      v2rayn: async () => ({ action: "publish", id: "v2rayn", packagePath: "D:\\temp\\v.part" }),
      git: async () => { throw new Error("download_failed"); },
    },
    publisher: async () => { calls.push("published"); },
  }), /download_failed/);
  assert.deepEqual(calls, []);
});

test("default component publisher writes immutable assets and one signed catalog replacement", async () => {
  const root = tempRoot("sync-publisher");
  const publicRoot = path.join(root, "public");
  const workRoot = path.join(root, "work");
  fs.mkdirSync(publicRoot);
  fs.mkdirSync(workRoot);
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signingKeyFile = path.join(root, "private.pem");
  fs.writeFileSync(signingKeyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
  const config = loadPublisherConfig({
    CBI_SIGNING_KEY_FILE: signingKeyFile,
    CBI_PUBLIC_ROOT: publicRoot,
    CBI_PACKAGE_BASE_URL: "https://shanhaiyouling.com/codexbridge-test/packages/",
  });
  const v2Path = path.join(workRoot, "v2rayn.part");
  const gitPath = path.join(workRoot, "git.part");
  fs.writeFileSync(v2Path, "v2");
  fs.writeFileSync(gitPath, "git");
  const releases = [
    {
      action: "publish", id: "v2rayn", version: "7.20.4", packagePath: v2Path,
      size: 2, sha256: crypto.createHash("sha256").update("v2").digest("hex"), format: "zip",
      entrypoint: "v2rayN.exe", requiredFiles: ["v2rayN.exe"], maxRelativePathLength: 11,
      authenticity: "pgp", signingFingerprint: V2RAYN_SIGNING_FINGERPRINT,
    },
    {
      action: "publish", id: "git", version: "2.51.0", packagePath: gitPath,
      size: 3, sha256: crypto.createHash("sha256").update("git").digest("hex"), format: "exe",
      entrypoint: "cmd/git.exe", requiredFiles: ["cmd/git.exe"], maxRelativePathLength: 32,
      authenticode: "Valid",
    },
  ];
  const result = await publishComponentReleases({
    config,
    currentCatalog: { schemaVersion: 1, components: [], skills: [] },
    releases,
    publishedAt: "2026-08-08T00:00:00.000Z",
  });
  const verified = verifyCatalogEnvelope({
    jsonBytes: fs.readFileSync(result.catalogPath),
    signatureText: fs.readFileSync(result.signaturePath, "utf8").trim(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    catalogUrl: "https://shanhaiyouling.com/codexbridge-install-test/component-catalog.json",
  });
  assert.deepEqual(verified.components.map((item) => item.id), ["git", "v2rayn"]);
  assert.equal(result.events.at(-1), "catalog_replaced");
});

test("component publisher verifies every DogeCloud object before signing CDN URLs", async () => {
  const root = tempRoot("sync-dogecloud");
  const publicRoot = path.join(root, "public");
  fs.mkdirSync(publicRoot);
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signingKeyFile = path.join(root, "private.pem");
  fs.writeFileSync(signingKeyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
  const config = loadPublisherConfig({
    CBI_SIGNING_KEY_FILE: signingKeyFile,
    CBI_PUBLIC_ROOT: publicRoot,
    CBI_PACKAGE_BASE_URL: "https://download.shanhaiyouling.com/codexbridge-test/packages/",
  });
  const packagePath = path.join(root, "git.part");
  fs.writeFileSync(packagePath, "git");
  const sha256 = crypto.createHash("sha256").update("git").digest("hex");
  const result = await publishComponentReleases({
    config,
    currentCatalog: { schemaVersion: 1, components: [], skills: [] },
    releases: [{
      action: "publish", id: "git", version: "2.51.0", packagePath,
      size: 3, sha256, format: "exe", entrypoint: "cmd/git.exe",
      requiredFiles: ["cmd/git.exe"], maxRelativePathLength: 32, authenticode: "Valid",
    }],
    publishedAt: "2026-08-08T00:00:00.000Z",
    artifactPublisher: {
      publish: async ({ relativePath, expectedSize, expectedSha256 }) => ({
        action: "verified",
        objectKey: `codexbridge-test/packages/${relativePath}`,
        size: expectedSize,
        sha256: expectedSha256,
        url: `https://download.shanhaiyouling.com/codexbridge-test/packages/${relativePath}`,
      }),
    },
  });
  const verified = verifyCatalogEnvelope({
    jsonBytes: fs.readFileSync(result.catalogPath),
    signatureText: fs.readFileSync(result.signaturePath, "utf8").trim(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    catalogUrl: "https://shanhaiyouling.com/codexbridge-install-test/component-catalog.json",
  });
  assert.equal(verified.components[0].assetUrl, "https://download.shanhaiyouling.com/codexbridge-test/packages/git-2.51.0-x64-9a881b9b9f23.exe");
  assert.deepEqual(result.events.slice(-4), ["package_verified", "object_verified", "signature_written", "catalog_replaced"]);
});

test("package.json exposes the combined component sync command", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  assert.equal(packageJson.scripts["software:sync"], "node scripts/software-manager/sync-components.mjs");
});
