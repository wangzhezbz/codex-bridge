import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyCatalogEnvelope } from "../desktop/software-manager/catalog-trust.mjs";
import { loadPublisherConfig } from "../scripts/software-manager/publisher-config.mjs";
import { inspectV2RayNRelease, readPeFileVersion, V2RAYN_PACKAGE_URL } from "../scripts/software-manager/sync-v2rayn.mjs";
import { GIT_RELEASE_API_URL, inspectGitRelease, parseAuthenticodeTimestamp } from "../scripts/software-manager/sync-git.mjs";
import { publishComponentReleases, syncComponents } from "../scripts/software-manager/sync-components.mjs";

function tempRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function responseBytes(bytes, url = "") {
  return {
    ok: true,
    status: 200,
    url,
    headers: { get: () => String(bytes.length) },
    arrayBuffer: async () => Buffer.from(bytes),
  };
}

function component(id, sha256) {
  return {
    id,
    name: id,
    version: "1.0.0",
    architecture: "x64",
    format: id === "git" ? "exe" : "7z",
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

test("V2RayN fixed URL publishes only when inspected content changes", async () => {
  const bytes = Buffer.from("v2rayn-release");
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const calls = [];
  const result = await inspectV2RayNRelease({
    currentCatalog: { schemaVersion: 1, components: [component("v2rayn", hash)], skills: [] },
    workRoot: tempRoot("v2rayn-sync"),
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return responseBytes(bytes, V2RAYN_PACKAGE_URL);
    },
    archiveInspector: async (packagePath) => {
      assert.match(packagePath, /\.part$/u);
      return {
        version: "7.20.4",
        entrypoint: "v2rayn/v2rayN.exe",
        requiredFiles: ["v2rayn/v2rayN.exe", "v2rayn/bin/xray.exe"],
        maxRelativePathLength: 12,
      };
    },
  });
  assert.equal(result.action, "noop");
  assert.equal(result.reason, "content_unchanged");
  assert.equal(result.version, "7.20.4");
  assert.equal(result.entrypoint, "v2rayn/v2rayN.exe");
  assert.equal(calls[0][0], V2RAYN_PACKAGE_URL);
  assert.equal(calls[0][1].redirect, "follow");
});

test("V2RayN release identity comes from internal version plus hash, never the fixed URL", async () => {
  const bytes = Buffer.from("changed-v2rayn-release");
  const result = await inspectV2RayNRelease({
    currentCatalog: { schemaVersion: 1, components: [], skills: [] },
    workRoot: tempRoot("v2rayn-changed"),
    fetchImpl: async () => responseBytes(bytes, V2RAYN_PACKAGE_URL),
    archiveInspector: async () => ({
      version: "7.20.4",
      entrypoint: "v2rayN.exe",
      requiredFiles: ["v2rayN.exe"],
      maxRelativePathLength: 11,
    }),
  });
  assert.equal(result.action, "publish");
  assert.equal(result.version, "7.20.4");
  assert.match(result.sha256, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(result.identity, /v1\.v2ai\.top/u);
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
    fetchImpl: async (url) => {
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
              { name: "Git-2.55.0.3-64-bit.exe", browser_download_url: "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.3/Git-2.55.0.3-64-bit.exe" },
            ],
          }),
        };
      }
      return responseBytes(installer, url);
    },
    authenticodeInspector: async (packagePath) => {
      assert.match(packagePath, /\.part$/u);
      return "Valid";
    },
  });
  assert.equal(calls[0], GIT_RELEASE_API_URL);
  assert.match(calls[1], /^https:\/\/github\.com\/git-for-windows\/git\/releases\/download\//u);
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
          name: "Git-2.55.0.3-64-bit.exe",
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
  const metadata = (url) => ({
    ok: true,
    status: 200,
    json: async () => ({
      tag_name: "v2.51.0.windows.1",
      assets: [{ name: "Git-2.51.0-64-bit.exe", browser_download_url: url }],
    }),
  });
  await assert.rejects(inspectGitRelease({
    currentCatalog: { schemaVersion: 1, components: [], skills: [] },
    workRoot: tempRoot("git-unofficial"),
    fetchImpl: async (url) => url === GIT_RELEASE_API_URL
      ? metadata("https://example.test/Git-2.51.0-64-bit.exe")
      : responseBytes(Buffer.from("x"), url),
    authenticodeInspector: async () => "Valid",
  }), /software_sync_git_asset_rejected/);
  await assert.rejects(inspectGitRelease({
    currentCatalog: { schemaVersion: 1, components: [], skills: [] },
    workRoot: tempRoot("git-unsigned"),
    fetchImpl: async (url) => url === GIT_RELEASE_API_URL
      ? metadata("https://github.com/git-for-windows/git/releases/download/v2.51.0.windows.1/Git-2.51.0-64-bit.exe")
      : responseBytes(Buffer.from("x"), url),
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
      size: 2, sha256: crypto.createHash("sha256").update("v2").digest("hex"), format: "7z",
      entrypoint: "v2rayN.exe", requiredFiles: ["v2rayN.exe"], maxRelativePathLength: 11,
    },
    {
      action: "publish", id: "git", version: "2.51.0", packagePath: gitPath,
      size: 3, sha256: crypto.createHash("sha256").update("git").digest("hex"), format: "exe",
      entrypoint: "cmd/git.exe", requiredFiles: ["cmd/git.exe"], maxRelativePathLength: 32,
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

test("package.json exposes the combined component sync command", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  assert.equal(packageJson.scripts["software:sync"], "node scripts/software-manager/sync-components.mjs");
});
