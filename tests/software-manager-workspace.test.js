import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import {
  consumePreparedDownloadVerification,
  createDownloadManager,
} from "../desktop/software-manager/download-manager.mjs";
import { createInstallerWorkspace } from "../desktop/software-manager/installer-workspace.mjs";
import { createTrustedCatalogService, verifyCatalogEnvelope } from "../desktop/software-manager/catalog-trust.mjs";
import { authorizeInstallRoot } from "../desktop/software-manager/path-policy.mjs";
import { MAX_SOFTWARE_PACKAGE_BYTES } from "../shared/software-manager/catalog-schema.mjs";

const ROOT = "D:\\CBApps";
const PACKAGE = Buffer.from("verified component package");
const TEST_CATALOG_URL = "https://shanhaiyouling.com/codexbridge-install-test/component-catalog.json";

function trustedCatalog() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const value = {
    schemaVersion: 1,
    components: [{
      id: "chatgpt", name: "ChatGPT", version: "1.0.0", architecture: "x64",
      assetUrl: "/codexbridge-test/packages/chatgpt.zip", size: PACKAGE.length,
      sha256: createHash("sha256").update(PACKAGE).digest("hex"), format: "zip",
      entrypoint: "ChatGPT.exe", requiredFiles: ["ChatGPT.exe"], maxRelativePathLength: 80,
      publishedAt: "2026-08-07T00:00:00.000Z", supportsRollback: true,
    }, {
      id: "v2rayn", name: "V2RayN", version: "7.0.4", architecture: "x64",
      assetUrl: "/codexbridge-test/packages/v2rayn.7z", size: PACKAGE.length,
      sha256: createHash("sha256").update(PACKAGE).digest("hex"), format: "7z",
      entrypoint: "v2rayN.exe", requiredFiles: ["v2rayN.exe"], maxRelativePathLength: 80,
      publishedAt: "2026-08-07T00:00:00.000Z", supportsRollback: true,
    }, {
      id: "git", name: "Git", version: "2.50.0", architecture: "x64",
      assetUrl: "/codexbridge-test/packages/git.exe", size: PACKAGE.length,
      sha256: createHash("sha256").update(PACKAGE).digest("hex"), format: "exe",
      entrypoint: "cmd/git.exe", requiredFiles: ["cmd/git.exe"], maxRelativePathLength: 80,
      publishedAt: "2026-08-07T00:00:00.000Z", supportsRollback: true,
    }],
    skills: [{
      id: "documents", name: "Documents", description: "fixture", version: "1.0.0",
      assetUrl: "/codexbridge-test/packages/skill-documents.zip", size: PACKAGE.length,
      sha256: createHash("sha256").update(PACKAGE).digest("hex"), files: ["SKILL.md", "reference.md"],
    }],
  };
  const jsonBytes = Buffer.from(JSON.stringify(value));
  const verified = verifyCatalogEnvelope({
    jsonBytes,
    signatureText: sign("RSA-SHA256", jsonBytes, privateKey).toString("base64"),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    catalogUrl: TEST_CATALOG_URL,
  });
  return createTrustedCatalogService(verified);
}

const TRUSTED_CATALOG = trustedCatalog();

function packageMetadata(content = PACKAGE) {
  return {
    size: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function downloadRequest(componentId, version, extension, content = PACKAGE) {
  return { componentId, version, extension, ...packageMetadata(content) };
}

async function installRootCapability({ identity = 10, getIdentity = () => identity } = {}) {
  return authorizeInstallRoot({
    candidate: ROOT,
    env: {
      SystemRoot: "C:\\Windows",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      USERPROFILE: "C:\\Users\\me",
    },
    maxRelativePath: 180,
    access: async () => {},
    realpath: async (value) => value,
    lstat: async () => ({
      dev: 1,
      ino: getIdentity(),
      isDirectory: () => true,
      isSymbolicLink: () => false,
      isReparsePoint: () => false,
    }),
  });
}

function fakeWorkspaceCapabilities({ expectedInstallRootCapability = null, skillSealFailure = null } = {}) {
  const calls = [];
  const nodes = new Map([[ROOT.toLowerCase(), { kind: "directory", empty: true, identity: 1 }]]);
  const sessions = new Set();
  const skillSourceProofs = new WeakSet();
  let identity = 2;

  function key(value) { return value.toLowerCase(); }
  function add(pathValue, kind, options = {}) {
    nodes.set(key(pathValue), {
      kind,
      empty: options.empty ?? kind === "file",
      identity: options.identity ?? identity++,
      data: Buffer.from(options.data ?? Buffer.alloc(options.size ?? 0)),
      size: options.data === undefined ? options.size ?? 0 : Buffer.byteLength(options.data),
    });
  }

  return {
    calls,
    nodes,
    add,
    fileCapabilities: {
      async openInstallerWorkspaceRootNoFollow(installRootCapability, { maxRelativePath } = {}) {
        if (expectedInstallRootCapability) assert.equal(installRootCapability, expectedInstallRootCapability);
        assert.equal(Number.isSafeInteger(maxRelativePath) && maxRelativePath > 0, true);
        const rootPath = ROOT;
        calls.push(["open-root", rootPath]);
        assert.equal(rootPath, ROOT);
        const receipts = new WeakMap();
        const root = Object.freeze(Object.create(null));
        receipts.set(root, { path: ROOT, kind: "directory", identity: 1, state: "issued" });
        const session = {
          root,
          closed: false,
          issue(pathValue, kind, { sealed = false } = {}) {
            const receipt = Object.freeze(Object.create(null));
            const node = nodes.get(key(pathValue));
            receipts.set(receipt, {
              path: pathValue, kind, identity: node.identity, state: "issued", sealed,
            });
            return receipt;
          },
          require(receipt) {
            const record = receipts.get(receipt);
            if (!record || record.state !== "issued") throw Object.assign(new Error("workspace_receipt_invalid"), { code: "workspace_receipt_invalid" });
            return record;
          },
          async createOrOpenDirectoryChildNoFollow(parentReceipt, name, { requireEmpty = false } = {}) {
            const parent = this.require(parentReceipt);
            const childPath = path.win32.join(parent.path, name);
            calls.push(["directory", parent.path, name, requireEmpty]);
            const existing = nodes.get(key(childPath));
            if (existing && existing.kind !== "directory") throw Object.assign(new Error("windows_directory_required"), { code: "windows_directory_required" });
            if (existing && requireEmpty && !existing.empty) throw Object.assign(new Error("workspace_directory_not_empty"), { code: "workspace_directory_not_empty" });
            if (!existing) add(childPath, "directory", { empty: true });
            return this.issue(childPath, "directory");
          },
          async createFileChildNoFollow(parentReceipt, name) {
            const parent = this.require(parentReceipt);
            const childPath = path.win32.join(parent.path, name);
            calls.push(["create-file", parent.path, name]);
            if (nodes.has(key(childPath))) throw Object.assign(new Error("entry_exists"), { code: "entry_exists" });
            add(childPath, "file");
            return this.issue(childPath, "file");
          },
          async openFileChildNoFollow(parentReceipt, name) {
            const parent = this.require(parentReceipt);
            const childPath = path.win32.join(parent.path, name);
            calls.push(["open-file", parent.path, name]);
            const existing = nodes.get(key(childPath));
            if (!existing) return null;
            if (existing.kind !== "file") throw Object.assign(new Error("windows_regular_file_required"), { code: "windows_regular_file_required" });
            return this.issue(childPath, "file");
          },
          async inspectIssuedChildNoFollow(receipt) {
            const record = this.require(receipt);
            const node = nodes.get(key(record.path));
            if (!node || node.identity !== record.identity) throw Object.assign(new Error("windows_identity_changed"), { code: "windows_identity_changed" });
            return Object.freeze({ path: record.path, kind: record.kind, size: node.size, empty: node.empty });
          },
          async resetIssuedFileNoFollow(receipt) {
            const record = this.require(receipt);
            const node = nodes.get(key(record.path));
            if (!node || node.identity !== record.identity) throw Object.assign(new Error("windows_identity_changed"), { code: "windows_identity_changed" });
            node.data = Buffer.alloc(0);
            node.size = 0;
            calls.push(["reset-file", record.path]);
            return receipt;
          },
          async createIssuedFileWriteStreamNoFollow(receipt, { append, maxBytes, signal } = {}) {
            const record = this.require(receipt);
            const node = nodes.get(key(record.path));
            if (!node || node.identity !== record.identity) throw Object.assign(new Error("windows_identity_changed"), { code: "windows_identity_changed" });
            if (!append && node.data.length !== 0) throw new Error("workspace_file_reset_required");
            calls.push(["writer", record.path, append]);
            return new Writable({
              write(chunk, _encoding, callback) {
                if (signal?.aborted) { callback(Object.assign(new Error("aborted"), { code: "ABORT_ERR" })); return; }
                const current = nodes.get(key(record.path));
                if (!current || current.identity !== record.identity) {
                  callback(Object.assign(new Error("windows_identity_changed"), { code: "windows_identity_changed" }));
                  return;
                }
                const next = Buffer.concat([current.data, Buffer.from(chunk)]);
                if (next.length > maxBytes) { callback(new Error("workspace_file_size_exceeded")); return; }
                current.data = next;
                current.size = next.length;
                callback();
              },
            });
          },
          async sealIssuedFileNoFollow(receipt, { size, sha256, signal } = {}) {
            const record = this.require(receipt);
            const node = nodes.get(key(record.path));
            calls.push(["seal", record.path, size, sha256]);
            if (signal?.aborted) throw Object.assign(new Error("workspace_file_seal_cancelled"), { code: "ABORT_ERR" });
            if (!node || node.identity !== record.identity) throw Object.assign(new Error("windows_identity_changed"), { code: "windows_identity_changed" });
            if (record.kind !== "file") throw Object.assign(new Error("workspace_file_receipt_required"), { code: "workspace_file_receipt_required" });
            if (node.data.length !== size) throw Object.assign(new Error("workspace_file_size_mismatch"), { code: "workspace_file_size_mismatch" });
            if (createHash("sha256").update(node.data).digest("hex") !== sha256) {
              throw Object.assign(new Error("workspace_file_hash_mismatch"), { code: "workspace_file_hash_mismatch" });
            }
            record.state = "consumed";
            return this.issue(record.path, "file", { sealed: true });
          },
          async sealIssuedSkillTreeNoFollow(receipt, expected) {
            const record = this.require(receipt);
            if (record.kind !== "directory") throw new Error("workspace_directory_receipt_required");
            calls.push(["seal-skill-tree", record.path, structuredClone(expected)]);
            if (skillSealFailure) throw skillSealFailure;
            const sourceProof = Object.freeze(Object.create(null));
            skillSourceProofs.add(sourceProof);
            return {
              sourceProof,
              evidence: {
                kind: "directory",
                identity: { volumeSerial: "v", fileId: "skill" },
                treeDigest: "a".repeat(64),
                manifestDigest: "b".repeat(64),
                skillMdSha256: "c".repeat(64),
              },
            };
          },
          async renameIssuedChildNoReplace(receipt, destinationName) {
            const record = this.require(receipt);
            if (!record.sealed) throw Object.assign(new Error("workspace_sealed_file_required"), { code: "workspace_sealed_file_required" });
            const destination = path.win32.join(path.win32.dirname(record.path), destinationName);
            calls.push(["rename", record.path, destination]);
            if (nodes.has(key(destination))) throw Object.assign(new Error("entry_exists"), { code: "entry_exists" });
            const node = nodes.get(key(record.path));
            nodes.delete(key(record.path));
            nodes.set(key(destination), node);
            record.state = "consumed";
            return this.issue(destination, record.kind, { sealed: true });
          },
          async deleteIssuedChildNoFollow(receipt) {
            const record = this.require(receipt);
            const node = nodes.get(key(record.path));
            if (!node || node.identity !== record.identity) throw Object.assign(new Error("windows_identity_changed"), { code: "windows_identity_changed" });
            if (record.kind === "directory" && !node.empty) throw Object.assign(new Error("workspace_directory_not_empty"), { code: "workspace_directory_not_empty" });
            calls.push(["delete", record.path]);
            nodes.delete(key(record.path));
            record.state = "consumed";
          },
          async close() {
            this.closed = true;
            calls.push(["close"]);
          },
        };
        sessions.add(session);
        return session;
      },
    },
    sessions,
    skillSourceProofs,
  };
}

function fakePreparedDownloadManager(fake, content = PACKAGE) {
  const fsApi = {
    async stat(exactPath) {
      const node = fake.nodes.get(exactPath.toLowerCase());
      if (!node) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { size: node.data.length };
    },
    createReadStream(exactPath) {
      const node = fake.nodes.get(exactPath.toLowerCase());
      if (!node) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return Readable.from([node.data]);
    },
    createWriteStream(exactPath, { flags }) {
      let node = fake.nodes.get(exactPath.toLowerCase());
      if (!node) {
        fake.add(exactPath, "file");
        node = fake.nodes.get(exactPath.toLowerCase());
      }
      if (flags === "w") node.data = Buffer.alloc(0);
      return new Writable({
        write(chunk, encoding, callback) {
          node.data = Buffer.concat([node.data, Buffer.from(chunk)]);
          node.size = node.data.length;
          callback();
        },
      });
    },
    async rename() { throw new Error("prepared download must not rename"); },
  };
  return createDownloadManager({
    fsApi,
    fetchImpl: async () => new Response(content, {
      status: 200,
      headers: { "Content-Length": String(content.length) },
    }),
    retryPolicy: { maxAttempts: 1, delayMs: 0 },
  });
}

async function createWorkspace(
  fake,
  installRoot = null,
  downloadManager = null,
) {
  const rootCapability = installRoot ?? await installRootCapability();
  const preparedDownloadManager = downloadManager ?? fakePreparedDownloadManager(fake);
  return {
    downloadManager: preparedDownloadManager,
    workspace: createInstallerWorkspace({
      fileCapabilities: fake.fileCapabilities,
      installRootCapability: rootCapability,
      downloadManager: preparedDownloadManager,
      catalogService: TRUSTED_CATALOG,
    }),
  };
}

test("workspace derives deterministic children and rejects renderer-controlled identifiers before opening a root", async () => {
  const installRoot = await installRootCapability();
  const fake = fakeWorkspaceCapabilities({ expectedInstallRootCapability: installRoot });
  const { workspace } = await createWorkspace(fake, installRoot);

  for (const request of [
    () => workspace.prepareDownloadFile(downloadRequest("other", "1.0.0", ".zip")),
    () => workspace.prepareDownloadFile(downloadRequest("chatgpt", "..", ".zip")),
    () => workspace.prepareDownloadFile(downloadRequest("chatgpt", "V1", ".zip")),
    () => workspace.prepareDownloadFile(downloadRequest("chatgpt", "v1", ".zip")),
    () => workspace.prepareDownloadFile(downloadRequest("chatgpt", "1_0", ".zip")),
    () => workspace.prepareDownloadFile(downloadRequest("chatgpt", "1+0", ".zip")),
    () => workspace.prepareDownloadFile(downloadRequest("chatgpt", "1-0", ".zip")),
    () => workspace.prepareDownloadFile(downloadRequest("chatgpt", "1.0.0", ".exe")),
    () => workspace.prepareComponentStaging({ taskId: "..\\escape", componentId: "chatgpt" }),
    () => workspace.prepareSkillStaging({ taskId: "task-1", skillId: "..\\escape" }),
  ]) {
    await assert.rejects(request(), /workspace_identifier_invalid/u);
  }
  assert.equal(fake.calls.length, 0);
  assert.equal(Object.keys(workspace).sort().join(","), [
    "cleanupAbandonedPrepare",
    "cleanupComponentPackage",
    "consumePromotedPackageProof",
    "downloadPrepared",
    "prepareComponentStaging",
    "prepareDownloadFile",
    "prepareSkillDownloadFile",
    "prepareSkillStaging",
    "sealSkillStaging",
  ].sort().join(","));
});

test("workspace seals one issued Skill staging tree into an opaque source proof", async () => {
  const installRootCapabilityValue = await installRootCapability();
  const fake = fakeWorkspaceCapabilities({ expectedInstallRootCapability: installRootCapabilityValue });
  const preparedDownloadManager = fakePreparedDownloadManager(fake);
  const workspace = createInstallerWorkspace({
    fileCapabilities: fake.fileCapabilities,
    installRootCapability: installRootCapabilityValue,
    downloadManager: preparedDownloadManager,
    catalogService: TRUSTED_CATALOG,
  });
  const entry = TRUSTED_CATALOG.getSkill("documents");
  const download = await workspace.prepareSkillDownloadFile({
    skillId: entry.id, version: entry.version, size: entry.size, sha256: entry.sha256,
  });
  const verification = await workspace.downloadPrepared(download, {
    asset: { url: entry.assetUrl, size: entry.size, sha256: entry.sha256 },
  });
  const promoted = await download.promotePartNoReplace(verification);
  const staging = await workspace.prepareSkillStaging({ taskId: "skill-task", skillId: "documents" });
  const context = { skillId: "documents", expectedVersion: entry.version };
  const sealed = await workspace.sealSkillStaging(staging, promoted.packageProof, context);
  assert.equal(fake.skillSourceProofs.has(sealed.sourceProof), true);
  assert.equal(sealed.evidence.treeDigest, "a".repeat(64));
  assert.deepEqual(fake.calls.find(([operation]) => operation === "seal-skill-tree").slice(2), [{
    requiredFiles: entry.files,
    packageSha256: entry.sha256,
  }]);
  assert.equal(fake.nodes.has(promoted.path.toLowerCase()), false);
  assert.equal([...fake.sessions].every((session) => session.closed), true);
  await assert.rejects(
    workspace.sealSkillStaging(staging, promoted.packageProof, context),
    /workspace_receipt_consumed/u,
  );
});

test("failed Skill sealing keeps the exact promoted package recoverable until original-record cleanup closes it", async () => {
  const installRootCapabilityValue = await installRootCapability();
  const fake = fakeWorkspaceCapabilities({
    expectedInstallRootCapability: installRootCapabilityValue,
    skillSealFailure: new Error("test_skill_seal_failed"),
  });
  const preparedDownloadManager = fakePreparedDownloadManager(fake);
  const workspace = createInstallerWorkspace({
    fileCapabilities: fake.fileCapabilities,
    installRootCapability: installRootCapabilityValue,
    downloadManager: preparedDownloadManager,
    catalogService: TRUSTED_CATALOG,
  });
  const entry = TRUSTED_CATALOG.getSkill("documents");
  const download = await workspace.prepareSkillDownloadFile({
    skillId: entry.id, version: entry.version, size: entry.size, sha256: entry.sha256,
  });
  const verification = await workspace.downloadPrepared(download, {
    asset: { url: entry.assetUrl, size: entry.size, sha256: entry.sha256 },
  });
  const promoted = await download.promotePartNoReplace(verification);
  const staging = await workspace.prepareSkillStaging({ taskId: "failed-skill", skillId: entry.id });
  await assert.rejects(
    workspace.sealSkillStaging(staging, promoted.packageProof, {
      skillId: entry.id, expectedVersion: entry.version,
    }),
    /test_skill_seal_failed/u,
  );
  assert.equal(fake.nodes.has(promoted.path.toLowerCase()), true);
  await workspace.cleanupComponentPackage(promoted.downloadRecord);
  assert.equal(fake.nodes.has(promoted.path.toLowerCase()), false);
  assert.equal([...fake.sessions].every((session) => session.closed), true);
});

test("workspace rejects an incomplete session before file mutation and leaves download verification unconsumed", async (t) => {
  for (const mode of ["missing", "non-function"]) {
    await t.test(mode, async () => {
      const fake = fakeWorkspaceCapabilities();
      const downloadManager = fakePreparedDownloadManager(fake);
      const receiptPath = "D:\\CBApps\\downloads\\already-verified.zip.part";
      fake.add(receiptPath, "file");
      const asset = {
        url: "https://shanhaiyouling.com/codexbridge-test/packages/already-verified.zip",
        ...packageMetadata(),
      };
      const verification = await downloadManager.downloadPrepared({ asset, partPath: receiptPath });
      const originalOpen = fake.fileCapabilities.openInstallerWorkspaceRootNoFollow;
      fake.fileCapabilities.openInstallerWorkspaceRootNoFollow = async (...args) => {
        const session = await originalOpen(...args);
        if (mode === "missing") delete session.sealIssuedFileNoFollow;
        else session.sealIssuedFileNoFollow = null;
        return session;
      };
      const { workspace } = await createWorkspace(
        fake,
        await installRootCapability(),
        downloadManager,
      );
      await assert.rejects(
        workspace.prepareDownloadFile(downloadRequest("chatgpt", "1.3.0", ".zip")),
        /workspace_file_capabilities_invalid/u,
      );
      assert.equal(fake.calls.some(([operation]) => operation === "directory"
        || operation === "create-file" || operation === "open-file"), false);
      assert.equal([...fake.sessions].every((session) => session.closed), true);
      assert.deepEqual(consumePreparedDownloadVerification(downloadManager, verification, {
        partPath: receiptPath,
        size: PACKAGE.length,
        sha256: packageMetadata().sha256,
      }), {
        partPath: receiptPath,
        size: PACKAGE.length,
        sha256: packageMetadata().sha256,
      });
    });
  }
});

test("workspace accepts the shared package ceiling and rejects larger downloads before any side effect", async () => {
  const fake = fakeWorkspaceCapabilities();
  let fetches = 0;
  const downloadManager = {
    async downloadPrepared() { fetches += 1; },
  };
  const { workspace } = await createWorkspace(fake, await installRootCapability(), downloadManager);
  await assert.rejects(workspace.prepareDownloadFile({
    ...downloadRequest("chatgpt", "1.4.0", ".zip"),
    size: MAX_SOFTWARE_PACKAGE_BYTES + 1,
  }), /workspace_asset_invalid/u);
  assert.equal(fetches, 0);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual([...fake.nodes.keys()], [ROOT.toLowerCase()]);

  const accepted = await workspace.prepareDownloadFile({
    ...downloadRequest("chatgpt", "1.4.0", ".zip"),
    size: MAX_SOFTWARE_PACKAGE_BYTES,
  });
  assert.equal(accepted.partPath.endsWith("chatgpt-1.4.0.zip.part"), true);
  await workspace.cleanupAbandonedPrepare(accepted);
});

test("download pending authority is keyed by final casefold path and rejects changed signed metadata", async () => {
  const fake = fakeWorkspaceCapabilities();
  const { workspace } = await createWorkspace(fake);
  const request = downloadRequest("chatgpt", "01.0", ".zip");
  const first = workspace.prepareDownloadFile(request);
  await assert.rejects(
    workspace.prepareDownloadFile({
      ...request,
      size: request.size + 1,
      sha256: "0".repeat(64),
    }),
    /workspace_path_alias_collision/u,
  );
  const prepared = await first;
  assert.equal(prepared.path, "D:\\CBApps\\downloads\\chatgpt-01.0.zip");
  await workspace.cleanupAbandonedPrepare(prepared);
});

test("download preparation issues one exact adjacent part and promotes it by held receipt", async () => {
  const fake = fakeWorkspaceCapabilities();
  const { downloadManager, workspace } = await createWorkspace(fake);
  const request = downloadRequest("chatgpt", "1.2.3", ".zip");
  const download = await workspace.prepareDownloadFile(request);

  assert.equal(download.path, "D:\\CBApps\\downloads\\chatgpt-1.2.3.zip");
  assert.equal(download.partPath, `${download.path}.part`);
  assert.equal(typeof download.promotePartNoReplace, "function");
  assert.equal(fake.nodes.has(download.partPath.toLowerCase()), true);
  assert.equal(fake.nodes.has(download.path.toLowerCase()), false);
  await assert.rejects(
    download.promotePartNoReplace(Object.freeze({ verified: true })),
    /verification_receipt_invalid/u,
  );
  assert.equal(fake.calls.some(([operation]) => operation === "rename"), false);
  const verification = await workspace.downloadPrepared(download, {
    asset: { url: "https://shanhaiyouling.com/codexbridge-test/packages/chatgpt.zip", ...packageMetadata() },
  });
  const promoted = await download.promotePartNoReplace(verification);
  assert.equal(promoted.path, download.path);
  assert.equal(promoted.packageProof !== null && typeof promoted.packageProof === "object", true);
  assert.equal(fake.nodes.has(download.partPath.toLowerCase()), false);
  assert.equal(fake.nodes.has(download.path.toLowerCase()), true);
  assert.equal(fake.calls.filter(([operation]) => operation === "rename").length, 1);

  await assert.rejects(workspace.consumePromotedPackageProof(promoted.packageProof, {
    path: download.path,
    size: request.size,
    sha256: "0".repeat(64),
  }), /workspace_package_proof_mismatch/u);
  assert.deepEqual(await workspace.consumePromotedPackageProof(promoted.packageProof, {
    path: download.path,
    size: request.size,
    sha256: request.sha256,
  }), {
    path: download.path,
    size: request.size,
    sha256: request.sha256,
  });
  await assert.rejects(workspace.consumePromotedPackageProof(promoted.packageProof, {
    path: download.path,
    size: request.size,
    sha256: request.sha256,
  }), /workspace_package_proof_consumed/u);

  await workspace.cleanupComponentPackage(download);
  assert.equal(fake.nodes.has(download.path.toLowerCase()), false);
  await assert.rejects(workspace.cleanupComponentPackage(download), /workspace_receipt_consumed/u);
});

test("download promotion rejects an identity replacement after manager verification and never publishes it", async () => {
  const fake = fakeWorkspaceCapabilities();
  const { downloadManager, workspace } = await createWorkspace(fake);
  const request = downloadRequest("chatgpt", "1.2.4", ".zip");
  const download = await workspace.prepareDownloadFile(request);
  const verification = await workspace.downloadPrepared(download, {
    asset: { url: "https://shanhaiyouling.com/codexbridge-test/packages/chatgpt.zip", ...packageMetadata() },
  });
  fake.add(download.partPath, "file", { data: PACKAGE });

  await assert.rejects(download.promotePartNoReplace(verification), /windows_identity_changed/u);
  assert.equal(fake.nodes.has(download.path.toLowerCase()), false);
  assert.equal(fake.calls.some(([operation]) => operation === "rename"), false);
});

test("prepared cancellation and hash failure retain only the exact part and never invoke workspace publish", async () => {
  for (const mode of ["cancel", "hash"]) {
    const fake = fakeWorkspaceCapabilities();
    const content = mode === "hash" ? Buffer.alloc(PACKAGE.length, 0x78) : PACKAGE;
    const downloadManager = fakePreparedDownloadManager(fake, content);
    const { workspace } = await createWorkspace(fake, await installRootCapability(), downloadManager);
    const request = downloadRequest("git", mode === "hash" ? "2.1" : "2.2", ".exe");
    const prepared = await workspace.prepareDownloadFile(request);
    const controller = new AbortController();
    if (mode === "cancel") controller.abort();
    await assert.rejects(
      workspace.downloadPrepared(prepared, {
        asset: {
          url: `https://shanhaiyouling.com/codexbridge-test/packages/${mode}.exe`,
          ...packageMetadata(),
        },
        signal: controller.signal,
      }),
      mode === "cancel" ? { name: "AbortError" } : /(?:sha256|hash)/i,
    );
    assert.equal(fake.nodes.has(prepared.partPath.toLowerCase()), true);
    assert.equal(fake.nodes.has(prepared.path.toLowerCase()), false);
    assert.equal(fake.calls.some(([operation]) => operation === "rename"), false);
    assert.deepEqual(await workspace.cleanupAbandonedPrepare(prepared), { partialRetained: true });
  }
});

test("cancelled download retains only its issued adjacent part and never enumerates or deletes another part", async () => {
  const fake = fakeWorkspaceCapabilities();
  fake.add("D:\\CBApps\\downloads", "directory", { empty: false });
  fake.add("D:\\CBApps\\downloads\\unrelated-9.9.9.zip.part", "file", { size: 12 });
  const { workspace } = await createWorkspace(fake);
  const download = await workspace.prepareDownloadFile(downloadRequest("v2rayn", "7.0.4", ".7z"));
  await workspace.cleanupAbandonedPrepare(download);

  assert.equal(fake.nodes.has(download.partPath.toLowerCase()), true);
  assert.equal(fake.nodes.has("d:\\cbapps\\downloads\\unrelated-9.9.9.zip.part"), true);
  assert.equal(fake.calls.some(([operation]) => operation === "list"), false);
  assert.equal(fake.calls.some(([operation, exact]) => operation === "delete" && exact.endsWith(".part")), false);
});

test("the one deterministic adjacent part is reopened for resume instead of creating a fallback file", async () => {
  const fake = fakeWorkspaceCapabilities();
  fake.add("D:\\CBApps\\downloads", "directory", { empty: false });
  fake.add("D:\\CBApps\\downloads\\chatgpt-3.0.0.zip.part", "file", { size: 17 });
  const { workspace } = await createWorkspace(fake);
  const download = await workspace.prepareDownloadFile(downloadRequest("chatgpt", "3.0.0", ".zip"));
  assert.equal(download.partPath, "D:\\CBApps\\downloads\\chatgpt-3.0.0.zip.part");
  assert.equal(fake.calls.some(([operation, , name]) => operation === "create-file"
    && name === "chatgpt-3.0.0.zip.part"), false);
  await workspace.cleanupAbandonedPrepare(download);
});

test("component and Skill staging reuse only empty deterministic directories and cleanup exact issued children", async () => {
  const fake = fakeWorkspaceCapabilities();
  const { workspace } = await createWorkspace(fake);
  const component = await workspace.prepareComponentStaging({ taskId: "software-123", componentId: "git" });
  const skill = await workspace.prepareSkillStaging({ taskId: "software-124", skillId: "documents" });
  assert.equal(component.path, "D:\\CBApps\\staging\\task-software-123\\git.prepare");
  assert.equal(skill.path, "D:\\CBApps\\staging\\task-software-124\\skill-documents.prepare");

  await workspace.cleanupAbandonedPrepare(component);
  await workspace.cleanupAbandonedPrepare(skill);
  assert.equal(fake.nodes.has(component.path.toLowerCase()), false);
  assert.equal(fake.nodes.has(skill.path.toLowerCase()), false);
  await assert.rejects(workspace.cleanupAbandonedPrepare({ ...component }), /workspace_receipt_invalid/u);

  fake.add("D:\\CBApps\\staging\\task-busy", "directory", { empty: false });
  fake.add("D:\\CBApps\\staging\\task-busy\\chatgpt.prepare", "directory", { empty: false });
  await assert.rejects(
    workspace.prepareComponentStaging({ taskId: "busy", componentId: "chatgpt" }),
    /workspace_directory_not_empty/u,
  );
});

test("concurrent creation converges on the same exact empty staging path without arbitrary fallback names", async () => {
  const fake = fakeWorkspaceCapabilities();
  const { workspace } = await createWorkspace(fake);
  const [left, right] = await Promise.all([
    workspace.prepareComponentStaging({ taskId: "same-task", componentId: "chatgpt" }),
    workspace.prepareComponentStaging({ taskId: "same-task", componentId: "chatgpt" }),
  ]);
  assert.equal(left, right);
  assert.equal(left.path, "D:\\CBApps\\staging\\task-same-task\\chatgpt.prepare");
  assert.equal(fake.calls.some((call) => call.join("|").includes("(1)")), false);
  await workspace.cleanupAbandonedPrepare(left);
});

test("package collision and foreign cleanup fail closed without deleting the occupied child", async () => {
  const fake = fakeWorkspaceCapabilities();
  fake.add("D:\\CBApps\\downloads", "directory", { empty: false });
  fake.add("D:\\CBApps\\downloads\\git-2.50.0.exe", "file", { size: 99 });
  const { workspace } = await createWorkspace(fake);
  await assert.rejects(
    workspace.prepareDownloadFile(downloadRequest("git", "2.50.0", ".exe")),
    /workspace_package_collision/u,
  );
  assert.equal(fake.nodes.has("d:\\cbapps\\downloads\\git-2.50.0.exe"), true);
  await assert.rejects(workspace.cleanupComponentPackage(Object.freeze(Object.create(null))), /workspace_receipt_invalid/u);
  assert.equal(fake.calls.some(([operation]) => operation === "delete"), false);
});

test("workspace revalidates the exact install-root capability before cleanup and never mutates on identity drift", async () => {
  let identity = 10;
  const fake = fakeWorkspaceCapabilities();
  const { workspace } = await createWorkspace(
    fake,
    await installRootCapability({ getIdentity: () => identity }),
  );
  const prepared = await workspace.prepareComponentStaging({ taskId: "identity", componentId: "chatgpt" });
  identity = 11;
  await assert.rejects(workspace.cleanupAbandonedPrepare(prepared), /identity_changed/u);
  assert.equal(fake.nodes.has(prepared.path.toLowerCase()), true);
  assert.equal(fake.calls.some(([operation]) => operation === "delete"), false);
});

test("download rename collision consumes verification and requires a fresh exact verification before retry", async () => {
  const fake = fakeWorkspaceCapabilities();
  const { downloadManager, workspace } = await createWorkspace(fake);
  const request = downloadRequest("chatgpt", "2.0.0", ".zip");
  const download = await workspace.prepareDownloadFile(request);
  const asset = {
    url: "https://shanhaiyouling.com/codexbridge-test/packages/chatgpt.zip",
    ...packageMetadata(),
  };
  const firstVerification = await workspace.downloadPrepared(download, { asset });
  fake.add(download.path, "file", { size: 1 });
  await assert.rejects(download.promotePartNoReplace(firstVerification), /entry_exists/u);
  fake.nodes.delete(download.path.toLowerCase());
  await assert.rejects(download.promotePartNoReplace(firstVerification), /verification_receipt_consumed/u);
  const secondVerification = await workspace.downloadPrepared(download, { asset });
  const promoted = await download.promotePartNoReplace(secondVerification);
  assert.equal(promoted.path, download.path);
  assert.equal(typeof promoted.packageProof, "object");
  assert.equal(fake.calls.filter(([operation]) => operation === "seal").length, 1);
  await workspace.cleanupComponentPackage(download);
});
