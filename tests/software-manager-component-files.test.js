import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";

import { createComponentFileService } from "../desktop/software-manager/component-files.mjs";
import { createTrustedCatalogService, verifyCatalogEnvelope } from "../desktop/software-manager/catalog-trust.mjs";
import { authorizeInstallRoot } from "../desktop/software-manager/path-policy.mjs";
import { createRetainedInstallerStore } from "../desktop/software-manager/retained-installer-store.mjs";

const ROOT = "D:\\CBApps";
const HASH = "a".repeat(64);
const PACKAGE_PROOF = Object.freeze(Object.create(null));
const TEST_CATALOG_URL = "https://shanhaiyouling.com/codexbridge-install-test/component-catalog.json";

const installRootCapability = await authorizeInstallRoot({
  candidate: ROOT,
  maxRelativePath: 240,
  access: async () => {},
  realpath: async (value) => value,
  lstat: async () => ({
    dev: 1, ino: 1,
    isDirectory: () => true,
    isSymbolicLink: () => false,
    isReparsePoint: () => false,
  }),
});

function component(id, version, format, entrypoint, requiredFiles = [entrypoint]) {
  return {
    id,
    name: id,
    version,
    architecture: "x64",
    format,
    assetUrl: `https://shanhaiyouling.com/codexbridge-test/packages/${id}-${version}.${format}`,
    size: 123,
    sha256: HASH,
    entrypoint,
    requiredFiles,
    maxRelativePathLength: 240,
    publishedAt: "2026-08-07T00:00:00.000Z",
    supportsRollback: true,
  };
}

function trustedCatalog() {
  const catalog = {
    schemaVersion: 1,
    components: [
      component("chatgpt", "2.0.0", "zip", "ChatGPT.exe", ["ChatGPT.exe", "resources/app.asar"]),
      component("v2rayn", "7.0.4", "7z", "v2rayN.exe"),
      component("git", "2.50.0", "exe", "cmd/git.exe"),
    ],
    skills: [],
  };
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jsonBytes = Buffer.from(JSON.stringify(catalog));
  const verified = verifyCatalogEnvelope({
    jsonBytes,
    signatureText: sign("RSA-SHA256", jsonBytes, privateKey).toString("base64"),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    catalogUrl: TEST_CATALOG_URL,
  });
  return createTrustedCatalogService(verified);
}

const CATALOG = trustedCatalog();

function fakeFiles(initial = {}) {
  const calls = [];
  const nodes = new Map();
  let sequence = 0;
  const key = (value) => value.toLowerCase();
  function add(path, kind = "file", options = {}) {
    const data = Buffer.from(options.data ?? "fixture");
    nodes.set(key(path), {
      path, kind, data,
      identity: options.identity ?? { volumeSerial: "vol", fileId: String(++sequence) },
      invalid: options.invalid ?? null,
    });
  }
  for (const [path, value] of Object.entries(initial)) add(path, value.kind, value);

  function directChild(parent, name) {
    return `${parent}\\${name}`;
  }

  function directoryFacade(rootPath) {
    let closed = false;
    return {
      async listChildren() {
        assert.equal(closed, false);
        const prefix = `${key(rootPath)}\\`;
        return [...nodes.values()]
          .filter((node) => key(node.path).startsWith(prefix)
            && !key(node.path).slice(prefix.length).includes("\\"))
          .map((node) => node.path.slice(rootPath.length + 1));
      },
      async openChildNoFollow(name) {
        assert.equal(closed, false);
        const node = nodes.get(key(directChild(rootPath, name)));
        if (!node) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        if (node.invalid) throw Object.assign(new Error(node.invalid), { code: node.invalid });
        return Object.freeze({
          name,
          kind: node.kind,
          identity: structuredClone(node.identity),
          ...(node.kind === "directory" ? { handle: directoryFacade(node.path) } : {}),
        });
      },
      async assertChildDescriptorNoFollow() { return true; },
      async unlinkChildNoFollow() {},
      async rmdirChildNoFollow() {},
      async close() { closed = true; },
    };
  }

  const fileCapabilities = {
    async pinArchiveFileNoFollow(filePath) {
      calls.push(["pin", filePath]);
      const node = nodes.get(key(filePath));
      if (!node || node.kind !== "file") throw Object.assign(new Error("missing"), { code: "ENOENT" });
      if (node.invalid) throw Object.assign(new Error(node.invalid), { code: node.invalid });
      const identity = JSON.stringify(node.identity);
      let closed = false;
      return {
        async assertStableNoFollow() {
          if (closed || JSON.stringify(nodes.get(key(filePath))?.identity) !== identity) {
            throw Object.assign(new Error("windows_identity_changed"), { code: "windows_identity_changed" });
          }
        },
        async close() { closed = true; },
      };
    },
    async openDirectoryNoFollow(rootPath) {
      calls.push(["open-directory", rootPath]);
      return directoryFacade(rootPath);
    },
    async openInstallerWorkspaceRootNoFollow(capability) {
      assert.equal(capability, installRootCapability);
      const receipts = new WeakMap();
      const root = Object.freeze(Object.create(null));
      receipts.set(root, { path: ROOT, kind: "directory" });
      function issue(node) {
        const receipt = Object.freeze(Object.create(null));
        receipts.set(receipt, { ...node });
        return receipt;
      }
      function get(receipt) {
        const value = receipts.get(receipt);
        if (!value) throw new Error("receipt_invalid");
        return value;
      }
      return {
        root,
        async createOrOpenDirectoryChildNoFollow(parent, name) {
          const parentNode = get(parent);
          const childPath = directChild(parentNode.path, name);
          let node = nodes.get(key(childPath));
          if (!node) {
            add(childPath, "directory");
            node = nodes.get(key(childPath));
          }
          if (node.kind !== "directory") throw new Error("directory_required");
          return issue(node);
        },
        async openDirectoryChildNoFollow(parent, name) {
          const node = nodes.get(key(directChild(get(parent).path, name)));
          return node?.kind === "directory" ? issue(node) : null;
        },
        async openFileChildNoFollow(parent, name) {
          const node = nodes.get(key(directChild(get(parent).path, name)));
          return node?.kind === "file" ? issue(node) : null;
        },
        async inspectIssuedChildNoFollow(receipt) {
          const node = get(receipt);
          return { path: node.path, kind: node.kind, size: node.data.length };
        },
        async sealIssuedFileNoFollow(receipt, expected) {
          const node = get(receipt);
          const actual = createHash("sha256").update(node.data).digest("hex");
          if (node.data.length !== expected.size || actual !== expected.sha256) {
            throw Object.assign(new Error("workspace_file_hash_mismatch"), { code: "workspace_file_hash_mismatch" });
          }
          calls.push(["seal", node.path, actual]);
          return issue(node);
        },
        async deleteIssuedChildNoFollow(receipt) {
          const node = get(receipt);
          calls.push(["delete", node.path, structuredClone(node.identity)]);
          nodes.delete(key(node.path));
        },
        async close() { calls.push(["close-workspace"]); },
      };
    },
  };
  return { calls, nodes, add, fileCapabilities };
}

function componentFixture({ files = fakeFiles(), version = "2.0.0", execFile } = {}) {
  const consumed = [];
  const deleted = [];
  const service = createComponentFileService({
    fileCapabilities: files.fileCapabilities,
    installRootCapability,
    catalogService: CATALOG,
    workspace: {
      async consumePromotedPackageProof(proof, expected) {
        assert.equal(proof, PACKAGE_PROOF);
        consumed.push(expected);
        return expected;
      },
    },
    versionReader: { async readFileVersion(filePath) { return filePath.endsWith("v2rayN.exe") ? "7.0.4" : version; } },
    execFile: execFile ?? (async () => ({ stdout: "git version 2.50.0.windows.1\n", stderr: "", exitCode: 0 })),
    async deleteAuthorizedTree(plan) { deleted.push(plan.target); },
  });
  return { service, files, consumed, deleted };
}

test("staging verification consumes the sealed package proof and derives every path from the trusted catalog", async () => {
  const files = fakeFiles({
    "D:\\CBApps\\ct\\ChatGPT.exe": {},
    "D:\\CBApps\\ct\\resources\\app.asar": {},
  });
  const fixture = componentFixture({ files });
  const result = await fixture.service.verifyComponent({
    componentId: "chatgpt",
    phase: "staging",
    rootPath: "D:\\CBApps\\ct",
    entrypointPath: "D:\\CBApps\\ct\\ChatGPT.exe",
    requiredFiles: ["D:\\CBApps\\ct\\ChatGPT.exe", "D:\\CBApps\\ct\\resources\\app.asar"],
    expectedVersion: "2.0.0",
    expectedPackageSha256: HASH,
    packageProof: PACKAGE_PROOF,
  });
  assert.deepEqual(result, { componentId: "chatgpt", version: "2.0.0" });
  assert.deepEqual(fixture.consumed, [{
    path: "D:\\CBApps\\downloads\\chatgpt-2.0.0.zip", size: 123, sha256: HASH,
  }]);
  assert.deepEqual(files.calls.filter(([kind]) => kind === "pin").map(([, value]) => value), [
    "D:\\CBApps\\ct\\ChatGPT.exe",
    "D:\\CBApps\\ct\\resources\\app.asar",
  ]);
});

test("component verification rejects caller-substituted catalog files before consuming package authority", async () => {
  const files = fakeFiles({ "D:\\CBApps\\ct\\evil.exe": {} });
  const fixture = componentFixture({ files });
  await assert.rejects(fixture.service.verifyComponent({
    componentId: "chatgpt", phase: "staging", rootPath: "D:\\CBApps\\ct",
    entrypointPath: "D:\\CBApps\\ct\\evil.exe", requiredFiles: ["D:\\CBApps\\ct\\evil.exe"],
    expectedVersion: "2.0.0", expectedPackageSha256: HASH, packageProof: PACKAGE_PROOF,
  }), /component_catalog_path_mismatch/u);
  assert.deepEqual(fixture.consumed, []);
});

test("current verification never accepts or claims a package hash and still pins every exact file", async () => {
  const files = fakeFiles({
    "D:\\CBApps\\c\\ChatGPT.exe": {},
    "D:\\CBApps\\c\\resources\\app.asar": {},
  });
  const fixture = componentFixture({ files });
  await fixture.service.verifyComponent({
    componentId: "chatgpt", phase: "current", rootPath: "D:\\CBApps\\c",
    entrypointPath: "D:\\CBApps\\c\\ChatGPT.exe",
    requiredFiles: ["D:\\CBApps\\c\\ChatGPT.exe", "D:\\CBApps\\c\\resources\\app.asar"],
    expectedVersion: "2.0.0",
  });
  await assert.rejects(fixture.service.verifyComponent({
    componentId: "chatgpt", phase: "current", rootPath: "D:\\CBApps\\c",
    entrypointPath: "D:\\CBApps\\c\\ChatGPT.exe",
    requiredFiles: ["D:\\CBApps\\c\\ChatGPT.exe", "D:\\CBApps\\c\\resources\\app.asar"],
    expectedVersion: "2.0.0", expectedPackageSha256: HASH, packageProof: PACKAGE_PROOF,
  }), /component_verification_plan_invalid/u);
});

test("component verification fails closed on reparse, hardlink, ADS, or version mismatch evidence", async () => {
  for (const invalid of ["windows_reparse_point_rejected", "windows_hard_link_rejected", "windows_alternate_data_stream_rejected"]) {
    const files = fakeFiles({
      "D:\\CBApps\\c\\ChatGPT.exe": { invalid },
      "D:\\CBApps\\c\\resources\\app.asar": {},
    });
    await assert.rejects(componentFixture({ files }).service.verifyComponent({
      componentId: "chatgpt", phase: "current", rootPath: "D:\\CBApps\\c",
      entrypointPath: "D:\\CBApps\\c\\ChatGPT.exe",
      requiredFiles: ["D:\\CBApps\\c\\ChatGPT.exe", "D:\\CBApps\\c\\resources\\app.asar"],
      expectedVersion: "2.0.0",
    }), new RegExp(invalid, "u"));
  }
  const files = fakeFiles({
    "D:\\CBApps\\c\\ChatGPT.exe": {},
    "D:\\CBApps\\c\\resources\\app.asar": {},
  });
  await assert.rejects(componentFixture({ files, version: "1.9.0" }).service.verifyComponent({
    componentId: "chatgpt", phase: "current", rootPath: "D:\\CBApps\\c",
    entrypointPath: "D:\\CBApps\\c\\ChatGPT.exe",
    requiredFiles: ["D:\\CBApps\\c\\ChatGPT.exe", "D:\\CBApps\\c\\resources\\app.asar"],
    expectedVersion: "2.0.0",
  }), /component_version_mismatch/u);
});

test("Git verification executes only the pinned exact executable with a bounded no-shell call", async () => {
  const gitPath = "D:\\CBApps\\Git\\cmd\\git.exe";
  const files = fakeFiles({ [gitPath]: {} });
  const execCalls = [];
  const fixture = componentFixture({ files, async execFile(file, args, options) {
    execCalls.push([file, args, options]);
    return { stdout: "git version 2.50.0.windows.1\n", stderr: "", exitCode: 0 };
  } });
  await fixture.service.verifyGitVersion(gitPath, "2.50.0");
  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0][0], gitPath);
  assert.deepEqual(execCalls[0][1], ["--version"]);
  assert.equal(execCalls[0][2].shell, false);
  assert.equal(Number.isSafeInteger(execCalls[0][2].timeout), true);
  assert.equal(execCalls.some(([exe]) => /(?:^|\\)where(?:\.exe)?$/iu.test(exe)), false);
});

test("Git verification accepts and strictly compares an external Windows Git version", async () => {
  const gitPath = "D:\\CBApps\\Git\\cmd\\git.exe";
  const files = fakeFiles({ [gitPath]: {} });
  const fixture = componentFixture({ files, async execFile() {
    return { stdout: "git version 2.50.0.windows.1\n", stderr: "", exitCode: 0 };
  } });
  assert.deepEqual(await fixture.service.verifyGitVersion(gitPath, "2.50.0.windows.1"), {
    version: "2.50.0.windows.1",
  });
  await assert.rejects(
    fixture.service.verifyGitVersion(gitPath, "2.50.0.windows.2"),
    /git_version_mismatch/u,
  );
});

test("component deletion plans never include install root, V2RayN-Data, or unrelated children", async () => {
  const files = fakeFiles({
    "D:\\CBApps\\c": { kind: "directory" },
    "D:\\CBApps\\cp": { kind: "directory" },
    "D:\\CBApps\\ct": { kind: "directory" },
    "D:\\CBApps\\cr": { kind: "directory" },
    "D:\\CBApps\\V2RayN": { kind: "directory" },
    "D:\\CBApps\\V2RayN-Data": { kind: "directory" },
    "D:\\CBApps\\unrelated": { kind: "directory" },
  });
  const fixture = componentFixture({ files });
  await fixture.service.deleteComponent({ componentId: "chatgpt", rootPath: ROOT, authorizedRoot: ROOT });
  assert.deepEqual(fixture.deleted.sort(), ["c", "cp", "cr", "ct"].map((name) => `${ROOT}\\${name}`).sort());
  fixture.deleted.length = 0;
  await fixture.service.deleteComponent({ componentId: "v2rayn", rootPath: `${ROOT}\\V2RayN`, authorizedRoot: ROOT });
  assert.deepEqual(fixture.deleted, [`${ROOT}\\V2RayN`]);
});

test("persistent V2RayN data evidence is serializable and rejects a replaced directory identity", async () => {
  const files = fakeFiles();
  const fixture = componentFixture({ files });
  const evidence = await fixture.service.preparePersistentDirectory({
    componentId: "v2rayn", rootPath: `${ROOT}\\V2RayN-Data`,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(evidence)), evidence);
  await fixture.service.verifyPersistentDirectory({
    componentId: "v2rayn", rootPath: `${ROOT}\\V2RayN-Data`, evidence,
  });
  files.nodes.get(`${ROOT}\\V2RayN-Data`.toLowerCase()).identity = { volumeSerial: "vol", fileId: "replaced" };
  await assert.rejects(fixture.service.verifyPersistentDirectory({
    componentId: "v2rayn", rootPath: `${ROOT}\\V2RayN-Data`, evidence,
  }), /persistent_directory_identity_changed/u);
});

test("retained installer hashes under a pin and deletes only a sealed exact downloads child", async () => {
  const installerPath = `${ROOT}\\downloads\\git-2.50.0.exe`;
  const data = Buffer.from("retained installer");
  const sha256 = createHash("sha256").update(data).digest("hex");
  const files = fakeFiles({
    [`${ROOT}\\downloads`]: { kind: "directory" },
    [installerPath]: { data },
  });
  const store = createRetainedInstallerStore({
    fileCapabilities: files.fileCapabilities,
    installRootCapability,
    openReadStream: (filePath) => Readable.from([files.nodes.get(filePath.toLowerCase()).data]),
  });
  assert.equal(await store.hashFile(installerPath), sha256);
  assert.deepEqual(await store.deleteVerified({
    installRoot: ROOT, path: installerPath, version: "2.50.0", sha256,
  }), { deleted: true });
  assert.equal(files.nodes.has(installerPath.toLowerCase()), false);
  assert.equal(files.calls.some(([kind, filePath]) => kind === "seal" && filePath === installerPath), true);
  assert.equal(files.calls.some(([kind, filePath]) => kind === "delete" && filePath === installerPath), true);
});

test("retained installer store rejects paths, versions, and hashes outside the fixed record", async () => {
  const store = createRetainedInstallerStore({
    fileCapabilities: fakeFiles().fileCapabilities,
    installRootCapability,
    openReadStream: () => Readable.from([]),
  });
  for (const record of [
    { installRoot: ROOT, path: "D:\\Elsewhere\\git-2.50.0.exe", version: "2.50.0", sha256: HASH },
    { installRoot: ROOT, path: `${ROOT}\\downloads\\git-latest.exe`, version: "latest", sha256: HASH },
    { installRoot: ROOT, path: `${ROOT}\\downloads\\git-2.49.0.exe`, version: "2.50.0", sha256: HASH },
  ]) {
    await assert.rejects(store.deleteVerified(record), /git_retained_installer/u);
  }
});
