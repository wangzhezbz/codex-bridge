import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyCatalogEnvelope } from "../desktop/software-manager/catalog-trust.mjs";
import { loadPublisherConfig } from "../scripts/software-manager/publisher-config.mjs";
import { inspectV2RayNRelease, V2RAYN_PACKAGE_URL } from "../scripts/software-manager/sync-v2rayn.mjs";
import { GIT_RELEASE_API_URL, inspectGitRelease } from "../scripts/software-manager/sync-git.mjs";
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
        entrypoint: "v2rayN.exe",
        requiredFiles: ["v2rayN.exe", "bin/xray.exe"],
        maxRelativePathLength: 12,
      };
    },
  });
  assert.equal(result.action, "noop");
  assert.equal(result.reason, "content_unchanged");
  assert.equal(result.version, "7.20.4");
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
            tag_name: "v2.51.0.windows.1",
            assets: [
              { name: "PortableGit-2.51.0-64-bit.7z.exe", browser_download_url: "https://github.com/git-for-windows/git/releases/download/v2.51.0.windows.1/PortableGit-2.51.0-64-bit.7z.exe" },
              { name: "Git-2.51.0-arm64.exe", browser_download_url: "https://github.com/git-for-windows/git/releases/download/v2.51.0.windows.1/Git-2.51.0-arm64.exe" },
              { name: "Git-2.51.0-64-bit.exe", browser_download_url: "https://github.com/git-for-windows/git/releases/download/v2.51.0.windows.1/Git-2.51.0-64-bit.exe" },
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
  assert.equal(result.version, "2.51.0");
  assert.equal(result.action, "publish");
  assert.equal(result.authenticode, "Valid");
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
