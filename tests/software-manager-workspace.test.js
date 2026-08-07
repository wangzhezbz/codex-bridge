import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createInstallerWorkspace } from "../desktop/software-manager/installer-workspace.mjs";
import { authorizeInstallRoot } from "../desktop/software-manager/path-policy.mjs";

const ROOT = "D:\\CBApps";

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

function fakeWorkspaceCapabilities({ expectedInstallRootCapability = null } = {}) {
  const calls = [];
  const nodes = new Map([[ROOT.toLowerCase(), { kind: "directory", empty: true, identity: 1 }]]);
  const sessions = new Set();
  let identity = 2;

  function key(value) { return value.toLowerCase(); }
  function add(pathValue, kind, options = {}) {
    nodes.set(key(pathValue), {
      kind,
      empty: options.empty ?? kind === "file",
      identity: options.identity ?? identity++,
      size: options.size ?? 0,
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
          issue(pathValue, kind) {
            const receipt = Object.freeze(Object.create(null));
            const node = nodes.get(key(pathValue));
            receipts.set(receipt, {
              path: pathValue, kind, identity: node.identity, state: "issued",
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
          async renameIssuedChildNoReplace(receipt, destinationName) {
            const record = this.require(receipt);
            const destination = path.win32.join(path.win32.dirname(record.path), destinationName);
            calls.push(["rename", record.path, destination]);
            if (nodes.has(key(destination))) throw Object.assign(new Error("entry_exists"), { code: "entry_exists" });
            const node = nodes.get(key(record.path));
            nodes.delete(key(record.path));
            nodes.set(key(destination), node);
            record.state = "consumed";
            return this.issue(destination, record.kind);
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
  };
}

test("workspace derives deterministic children and rejects renderer-controlled identifiers before opening a root", async () => {
  const installRoot = await installRootCapability();
  const fake = fakeWorkspaceCapabilities({ expectedInstallRootCapability: installRoot });
  const workspace = createInstallerWorkspace({
    fileCapabilities: fake.fileCapabilities,
    installRootCapability: installRoot,
  });

  for (const request of [
    () => workspace.prepareDownloadFile({ componentId: "other", version: "1.0.0", extension: ".zip" }),
    () => workspace.prepareDownloadFile({ componentId: "chatgpt", version: "..", extension: ".zip" }),
    () => workspace.prepareDownloadFile({ componentId: "chatgpt", version: "1.0.0", extension: ".exe" }),
    () => workspace.prepareComponentStaging({ taskId: "..\\escape", componentId: "chatgpt" }),
    () => workspace.prepareSkillStaging({ taskId: "task-1", skillId: "..\\escape" }),
  ]) {
    await assert.rejects(request(), /workspace_identifier_invalid/u);
  }
  assert.equal(fake.calls.length, 0);
  assert.equal(Object.keys(workspace).sort().join(","), [
    "cleanupAbandonedPrepare",
    "cleanupComponentPackage",
    "prepareComponentStaging",
    "prepareDownloadFile",
    "prepareSkillStaging",
  ].sort().join(","));
});

test("download preparation issues one exact adjacent part and promotes it by held receipt", async () => {
  const fake = fakeWorkspaceCapabilities();
  const workspace = createInstallerWorkspace({
    fileCapabilities: fake.fileCapabilities,
    installRootCapability: await installRootCapability(),
  });
  const download = await workspace.prepareDownloadFile({
    componentId: "chatgpt", version: "1.2.3", extension: ".zip",
  });

  assert.equal(download.path, "D:\\CBApps\\downloads\\chatgpt-1.2.3.zip");
  assert.equal(download.partPath, `${download.path}.part`);
  assert.equal(typeof download.promotePartNoReplace, "function");
  assert.equal(fake.nodes.has(download.partPath.toLowerCase()), true);
  assert.equal(fake.nodes.has(download.path.toLowerCase()), false);
  await download.promotePartNoReplace();
  assert.equal(fake.nodes.has(download.partPath.toLowerCase()), false);
  assert.equal(fake.nodes.has(download.path.toLowerCase()), true);

  await workspace.cleanupComponentPackage(download);
  assert.equal(fake.nodes.has(download.path.toLowerCase()), false);
  await assert.rejects(workspace.cleanupComponentPackage(download), /workspace_receipt_consumed/u);
});

test("cancelled download retains only its issued adjacent part and never enumerates or deletes another part", async () => {
  const fake = fakeWorkspaceCapabilities();
  fake.add("D:\\CBApps\\downloads", "directory", { empty: false });
  fake.add("D:\\CBApps\\downloads\\unrelated-9.9.9.zip.part", "file", { size: 12 });
  const workspace = createInstallerWorkspace({
    fileCapabilities: fake.fileCapabilities,
    installRootCapability: await installRootCapability(),
  });
  const download = await workspace.prepareDownloadFile({
    componentId: "v2rayn", version: "7.0.4", extension: ".7z",
  });
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
  const workspace = createInstallerWorkspace({
    fileCapabilities: fake.fileCapabilities,
    installRootCapability: await installRootCapability(),
  });
  const download = await workspace.prepareDownloadFile({
    componentId: "chatgpt", version: "3.0.0", extension: ".zip",
  });
  assert.equal(download.partPath, "D:\\CBApps\\downloads\\chatgpt-3.0.0.zip.part");
  assert.equal(fake.calls.some(([operation, , name]) => operation === "create-file"
    && name === "chatgpt-3.0.0.zip.part"), false);
  await workspace.cleanupAbandonedPrepare(download);
});

test("component and Skill staging reuse only empty deterministic directories and cleanup exact issued children", async () => {
  const fake = fakeWorkspaceCapabilities();
  const workspace = createInstallerWorkspace({
    fileCapabilities: fake.fileCapabilities,
    installRootCapability: await installRootCapability(),
  });
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
  const workspace = createInstallerWorkspace({
    fileCapabilities: fake.fileCapabilities,
    installRootCapability: await installRootCapability(),
  });
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
  const workspace = createInstallerWorkspace({
    fileCapabilities: fake.fileCapabilities,
    installRootCapability: await installRootCapability(),
  });
  await assert.rejects(
    workspace.prepareDownloadFile({ componentId: "git", version: "2.50.0", extension: ".exe" }),
    /workspace_package_collision/u,
  );
  assert.equal(fake.nodes.has("d:\\cbapps\\downloads\\git-2.50.0.exe"), true);
  await assert.rejects(workspace.cleanupComponentPackage(Object.freeze(Object.create(null))), /workspace_receipt_invalid/u);
  assert.equal(fake.calls.some(([operation]) => operation === "delete"), false);
});

test("workspace revalidates the exact install-root capability before cleanup and never mutates on identity drift", async () => {
  let identity = 10;
  const fake = fakeWorkspaceCapabilities();
  const workspace = createInstallerWorkspace({
    fileCapabilities: fake.fileCapabilities,
    installRootCapability: await installRootCapability({ getIdentity: () => identity }),
  });
  const prepared = await workspace.prepareComponentStaging({ taskId: "identity", componentId: "chatgpt" });
  identity = 11;
  await assert.rejects(workspace.cleanupAbandonedPrepare(prepared), /identity_changed/u);
  assert.equal(fake.nodes.has(prepared.path.toLowerCase()), true);
  assert.equal(fake.calls.some(([operation]) => operation === "delete"), false);
});

test("download rename collision restores the same receipt for one exact retry", async () => {
  const fake = fakeWorkspaceCapabilities();
  const workspace = createInstallerWorkspace({
    fileCapabilities: fake.fileCapabilities,
    installRootCapability: await installRootCapability(),
  });
  const download = await workspace.prepareDownloadFile({
    componentId: "chatgpt", version: "2.0.0", extension: ".zip",
  });
  fake.add(download.path, "file", { size: 1 });
  await assert.rejects(download.promotePartNoReplace(), /entry_exists/u);
  fake.nodes.delete(download.path.toLowerCase());
  assert.equal(await download.promotePartNoReplace(), download.path);
  await workspace.cleanupComponentPackage(download);
});
