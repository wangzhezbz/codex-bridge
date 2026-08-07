import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import {
  access, lstat, mkdir, mkdtemp, realpath, rmdir, unlink, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { deleteAuthorizedTree } from "../desktop/software-manager/safe-delete.mjs";
import { authorizeInstallRoot } from "../desktop/software-manager/path-policy.mjs";
import { createWin32FileApi } from "../desktop/software-manager/win32-file-api.mjs";
import { createWindowsFileCapabilities } from "../desktop/software-manager/windows-file-capabilities.mjs";
import { MAX_SOFTWARE_PACKAGE_BYTES } from "../shared/software-manager/catalog-schema.mjs";

function codedError(code, nativeCode) {
  return Object.assign(new Error(code), { code, nativeCode });
}

function createFakeNative(initial = []) {
  const nodes = new Map();
  const handles = new Set();
  const calls = [];
  let identitySeed = 1;
  let failOpen = null;
  let failClose = null;
  let failRename = null;
  let failDelete = null;
  let readChunkHook = null;

  const key = (value) => value.toLowerCase();
  const canonical = (value) => value.replace(/[\\]+$/u, "") || value;
  function add(path, options = {}) {
    const exact = /^[A-Za-z]:\\$/u.test(path) ? path : canonical(path);
    const node = {
      path: exact,
      kind: options.kind ?? "directory",
      data: Buffer.from(options.data ?? ""),
      reparse: options.reparse === true,
      nlink: options.nlink ?? 1,
      streams: options.streams ?? ["::$DATA"],
      identity: options.identity ?? { volumeSerial: "vol-1", fileId: `id-${identitySeed++}` },
      deleted: false,
    };
    nodes.set(key(exact), node);
    return node;
  }
  function ensureAncestors(exactPath) {
    const parsed = /^([A-Za-z]:)\\(.*)$/u.exec(exactPath);
    if (!parsed) return;
    let current = `${parsed[1]}\\`;
    if (!nodes.has(key(current))) add(current);
    for (const segment of parsed[2].split("\\").slice(0, -1)) {
      if (!segment) continue;
      current = current.endsWith("\\") ? `${current}${segment}` : `${current}\\${segment}`;
      if (!nodes.has(key(current))) add(current);
    }
  }
  for (const spec of initial) {
    ensureAncestors(spec.path);
    add(spec.path, spec);
  }

  function requireHandle(handle) {
    if (!handles.has(handle) || handle.closed) throw codedError("invalid_handle");
    return handle;
  }
  const nativeApi = {
    async openPath(exactPath, options) {
      calls.push(["open", exactPath, structuredClone(options)]);
      if (failOpen?.path?.toLowerCase() === exactPath.toLowerCase()) throw failOpen.error;
      let node = nodes.get(key(exactPath));
      if (options.disposition === "createNew") {
        if (node && !node.deleted) throw codedError("entry_exists", 183);
        ensureAncestors(exactPath);
        node = add(exactPath, { kind: options.directory ? "directory" : "file" });
      } else if (!node || node.deleted) {
        throw codedError("entry_missing", 2);
      }
      const category = (access) => new Set(access.map((value) => (
        value === "write" ? "write" : value === "delete" ? "delete" : "read"
      )));
      const requestedAccess = category(options.access);
      const requestedShare = new Set(options.share);
      for (const existing of handles) {
        if (existing.closed || existing.node !== node) continue;
        const existingAccess = category(existing.options.access);
        if ([...requestedAccess].some((value) => !existing.options.share.includes(value))
          || [...existingAccess].some((value) => !requestedShare.has(value))) {
          throw codedError("sharing_violation", 32);
        }
      }
      const handle = { node, options, closed: false, position: 0 };
      handles.add(handle);
      return handle;
    },
    async queryHandle(handle) {
      const { node } = requireHandle(handle);
      calls.push(["query", node.path]);
      return {
        identity: structuredClone(node.identity),
        directory: node.kind === "directory",
        reparse: node.reparse,
        reparseTag: node.reparse ? 0xa000000c : 0,
        size: node.kind === "file" ? node.data.length : 0,
        nlink: node.nlink,
      };
    },
    async finalPath(handle) {
      return requireHandle(handle).node.path;
    },
    async readFile(handle, maxBytes) {
      const { node } = requireHandle(handle);
      if (node.data.length > maxBytes) throw codedError("native_file_too_large");
      return Buffer.from(node.data);
    },
    async readChunk(handle, maxBytes) {
      const current = requireHandle(handle);
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 1024 * 1024) {
        throw codedError("native_read_chunk_size_invalid");
      }
      if (readChunkHook) readChunkHook(current, calls);
      const chunk = current.node.data.subarray(current.position, current.position + maxBytes);
      current.position += chunk.length;
      calls.push(["read-chunk", current.node.path, maxBytes, chunk.length]);
      return Buffer.from(chunk);
    },
    async writeFile(handle, value) {
      const { node } = requireHandle(handle);
      node.data = Buffer.from(value);
    },
    async appendFile(handle, value) {
      const { node } = requireHandle(handle);
      node.data = Buffer.concat([node.data, Buffer.from(value)]);
    },
    async flushFile(handle) {
      calls.push(["flush", requireHandle(handle).node.path]);
    },
    async assertNoAlternateDataStreams(handle) {
      const { node } = requireHandle(handle);
      calls.push(["streams", node.path]);
      if (node.streams.some((name) => name !== "::$DATA")) throw codedError("alternate_data_stream_rejected");
    },
    async *enumerateDirectory(handle, { limit }) {
      const { node } = requireHandle(handle);
      calls.push(["enumerate", node.path, limit]);
      const prefix = `${node.path.replace(/[\\]+$/u, "")}\\`.toLowerCase();
      let count = 0;
      for (const child of [...nodes.values()]
        .filter((candidate) => !candidate.deleted && candidate.path.toLowerCase().startsWith(prefix))
        .filter((candidate) => !candidate.path.slice(prefix.length).includes("\\"))) {
        count += 1;
        if (count > limit) throw codedError("native_directory_entry_limit_exceeded");
        yield {
          name: child.path.slice(prefix.length),
          reparse: child.reparse,
          identity: structuredClone(child.identity),
        };
      }
    },
    async createDirectory(exactPath) {
      calls.push(["mkdir", exactPath]);
      if (nodes.has(key(exactPath))) throw codedError("entry_exists", 183);
      ensureAncestors(exactPath);
      add(exactPath, { kind: "directory" });
    },
    async renameByHandle(handle, rootHandle, name, { replace }) {
      const source = requireHandle(handle).node;
      const root = requireHandle(rootHandle).node;
      calls.push(["rename-handle", source.path, root.path, name, replace]);
      if (failRename?.path?.toLowerCase() === source.path.toLowerCase()) throw failRename.error;
      const destination = `${root.path.replace(/[\\]+$/u, "")}\\${name}`;
      if (nodes.has(key(destination)) && !nodes.get(key(destination)).deleted && !replace) {
        throw codedError("entry_exists", 183);
      }
      const sourcePath = source.path;
      const descendants = [...nodes.values()].filter((node) => node !== source
        && node.path.toLowerCase().startsWith(`${sourcePath.toLowerCase()}\\`));
      nodes.delete(key(sourcePath));
      source.path = destination;
      nodes.set(key(destination), source);
      for (const descendant of descendants) {
        nodes.delete(key(descendant.path));
        descendant.path = `${destination}${descendant.path.slice(sourcePath.length)}`;
        nodes.set(key(descendant.path), descendant);
      }
    },
    async deleteByHandle(handle, { directory }) {
      const { node } = requireHandle(handle);
      calls.push(["delete-handle", node.path, directory]);
      if (failDelete?.path?.toLowerCase() === node.path.toLowerCase()) throw failDelete.error;
      node.deleted = true;
      nodes.delete(key(node.path));
    },
    async closeHandle(handle) {
      if (!handles.has(handle) || handle.closed) throw codedError("double_close");
      calls.push(["close", handle.node.path, structuredClone(handle.options)]);
      handle.closed = true;
      handles.delete(handle);
      if (failClose?.path?.toLowerCase() === handle.node.path.toLowerCase()) throw failClose.error;
    },
  };
  const fsApi = {
    async readdir(exactPath) {
      calls.push(["readdir", exactPath]);
      const prefix = `${exactPath.replace(/[\\]+$/u, "")}\\`.toLowerCase();
      return [...nodes.values()]
        .filter((node) => !node.deleted && node.path.toLowerCase().startsWith(prefix))
        .map((node) => node.path.slice(prefix.length))
        .filter((relative) => relative.length > 0 && !relative.includes("\\"));
    },
  };
  return {
    nativeApi,
    fsApi,
    calls,
    nodes,
    handles,
    add(path, options) { ensureAncestors(path); return add(path, options); },
    replace(path, options) {
      nodes.delete(key(path));
      return this.add(path, options);
    },
    failOpen(path, error) { failOpen = { path, error }; },
    failClose(path, error) { failClose = { path, error }; },
    failRename(path, error) { failRename = { path, error }; },
    failDelete(path, error) { failDelete = { path, error }; },
    onReadChunk(hook) { readChunkHook = hook; },
    get(path) { return nodes.get(key(path)); },
  };
}

function capabilities(fake, randomUUID = () => "00000000-0000-4000-8000-000000000001") {
  return createWindowsFileCapabilities({
    platform: "win32",
    nativeApi: fake.nativeApi,
    fsApi: fake.fsApi,
    randomUUID,
  });
}

async function installRootAuthority(candidate) {
  return authorizeInstallRoot({
    candidate,
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
      dev: 1, ino: candidate.toLowerCase() === "d:\\cbapps" ? 1 : 2,
      isDirectory: () => true, isSymbolicLink: () => false, isReparsePoint: () => false,
    }),
  });
}

test("Windows ownership lock uses an exclusive no-follow handle and becomes available after release", async () => {
  const fake = createFakeNative([{ path: "C:\\state", kind: "directory" }]);
  const fileCapabilities = capabilities(fake);
  const first = await fileCapabilities.acquireStateLockNoFollow("C:\\state");
  let secondAcquired = false;
  const secondPromise = fileCapabilities.acquireStateLockNoFollow("C:\\state").then((lock) => {
    secondAcquired = true;
    return lock;
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(secondAcquired, false);
  await first.release();
  const second = await secondPromise;
  assert.equal(secondAcquired, true);
  await second.release();
  const lockOpens = fake.calls.filter((call) => call[0] === "open"
    && call[1] === "C:\\state\\.codexbridge-ownership.lock");
  assert.equal(lockOpens.some((call) => call[2].share.length === 0), true);
});

test("native Windows file adapters reject non-Windows construction before loading native code", () => {
  let nativeTouched = false;
  assert.throws(
    () => createWin32FileApi({
      platform: "linux",
      koffi: new Proxy({}, { get() { nativeTouched = true; } }),
    }),
    /windows_platform_required/,
  );
  assert.throws(
    () => createWindowsFileCapabilities({ platform: "linux", nativeApi: {} }),
    /windows_platform_required/,
  );
  assert.equal(nativeTouched, false);
});

test("capability paths reject traversal, namespaces, UNC, ADS, roots, and reserved Windows names before native open", async () => {
  const fake = createFakeNative();
  const api = capabilities(fake);
  for (const unsafe of [
    "C:\\safe\\..\\escape",
    "\\\\server\\share\\state",
    "\\\\?\\C:\\state",
    "\\\\.\\C:\\state",
    "C:\\state:ads",
    "C:\\",
    "C:\\safe\\CON",
    "C:\\safe\\COM¹.json",
    "C:\\safe\\LPT²",
  ]) {
    await assert.rejects(api.openStateDirectoryNoFollow(unsafe), /windows_path_/u);
  }
  assert.equal(fake.calls.length, 0);
});

test("state directory and entries reject reparses and close every pinned handle", async () => {
  const fake = createFakeNative([{ path: "C:\\work\\state", reparse: true }]);
  await assert.rejects(capabilities(fake).openStateDirectoryNoFollow("C:\\work\\state"), /reparse/u);
  assert.equal(fake.handles.size, 0);

  fake.replace("C:\\work\\state", { kind: "directory" });
  fake.add("C:\\work\\state\\ownership.json", { kind: "file", data: "{}", reparse: true });
  const directory = await capabilities(fake).openStateDirectoryNoFollow("C:\\work\\state");
  await assert.rejects(directory.openFileNoFollow("ownership.json", "r"), /reparse/u);
  await directory.close();
  assert.equal(fake.handles.size, 0);
});

test("opened regular files reject non-default alternate data streams", async () => {
  const fake = createFakeNative([
    { path: "C:\\work\\state" },
    { path: "C:\\work\\state\\ownership.json", kind: "file", data: "{}", streams: ["::$DATA", ":payload:$DATA"] },
  ]);
  const directory = await capabilities(fake).openStateDirectoryNoFollow("C:\\work\\state");
  await assert.rejects(directory.openFileNoFollow("ownership.json", "r"), /alternate_data_stream/u);
  await directory.close();
  assert.equal(fake.handles.size, 0);
});

test("handle cleanup preserves the primary rejection when CloseHandle also fails", async () => {
  const fake = createFakeNative([{ path: "C:\\work\\state", reparse: true }]);
  fake.failClose("C:\\", codedError("close_failed", 6));
  await assert.rejects(
    capabilities(fake).openStateDirectoryNoFollow("C:\\work\\state"),
    (error) => error instanceof AggregateError
      && error.errors[0].code === "windows_reparse_point_rejected"
      && error.errors[1].code === "close_failed",
  );
  assert.equal(fake.handles.size, 0);
});

test("state reads and mutations remain bound to the opened descriptor identity", async () => {
  const fake = createFakeNative([
    { path: "C:\\work\\state" },
    { path: "C:\\work\\state\\ownership.json", kind: "file", data: "original" },
  ]);
  const directory = await capabilities(fake).openStateDirectoryNoFollow("C:\\work\\state");
  const stateDirectoryOpen = fake.calls.find((call) => call[0] === "open" && call[1] === "C:\\work\\state");
  assert.deepEqual(stateDirectoryOpen[2].access, ["attributes", "traverse"]);
  const file = await directory.openFileNoFollow("ownership.json", "r");
  fake.replace("C:\\work\\state\\ownership.json", { kind: "file", data: "replacement" });
  assert.equal(await file.readFile("utf8"), "original");
  const entry = file.entry;
  await file.close();
  await directory.renameEntryNoFollow(entry, "ownership.json.bak");
  assert.equal(fake.calls.some((call) => call[0] === "rename-handle" && call[1].endsWith("ownership.json")), true);
  await assert.rejects(directory.renameEntryNoFollow(entry, "again.json"), /descriptor_consumed/u);
  await directory.close();
  assert.equal(fake.handles.size, 0);
});

test("descriptor mutation fails closed when stable identity evidence changes", async () => {
  const fake = createFakeNative([
    { path: "C:\\work\\state" },
    { path: "C:\\work\\state\\ownership.json", kind: "file", data: "original" },
  ]);
  const directory = await capabilities(fake).openStateDirectoryNoFollow("C:\\work\\state");
  const file = await directory.openFileNoFollow("ownership.json", "r");
  const openedNode = [...fake.handles].find((handle) => handle.node.path.endsWith("ownership.json")).node;
  openedNode.identity = { volumeSerial: "vol-1", fileId: "swapped" };
  await file.close();
  await assert.rejects(directory.unlinkEntryNoFollow(file.entry), /identity_changed/u);
  assert.equal(fake.calls.some((call) => call[0] === "delete-handle"), false);
  await directory.close();
  assert.equal(fake.handles.size, 0);
});

test("state descriptor mutation is synchronously claimed before the first await", async () => {
  const fake = createFakeNative([
    { path: "C:\\work\\state" },
    { path: "C:\\work\\state\\ownership.json", kind: "file", data: "original" },
  ]);
  const directory = await capabilities(fake).openStateDirectoryNoFollow("C:\\work\\state");
  const file = await directory.openFileNoFollow("ownership.json", "r");
  await file.close();
  const results = await Promise.allSettled([
    directory.unlinkEntryNoFollow(file.entry),
    directory.unlinkEntryNoFollow(file.entry),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(fake.calls.filter((call) => call[0] === "delete-handle").length, 1);
  await directory.close();
});

test("state exclusive create is syncable and rename never replaces an occupied destination", async () => {
  const fake = createFakeNative([
    { path: "C:\\work\\state" },
    { path: "C:\\work\\state\\occupied.json", kind: "file", data: "keep" },
  ]);
  const directory = await capabilities(fake).openStateDirectoryNoFollow("C:\\work\\state");
  const temp = await directory.openFileNoFollow("ownership.json.tmp", "wx");
  await temp.writeFile("payload", "utf8");
  await temp.sync();
  await temp.close();
  await assert.rejects(directory.renameEntryNoFollow(temp.entry, "occupied.json"), /entry_exists/u);
  assert.equal(fake.get("C:\\work\\state\\occupied.json").data.toString(), "keep");
  assert.equal(fake.calls.some((call) => call[0] === "flush"), true);
  await directory.close();
});

async function finishWritable(output, value) {
  const completed = new Promise((resolve, reject) => {
    output.once("finish", resolve);
    output.once("error", reject);
  });
  output.end(value);
  await completed;
}

async function issueVersionReceipt(api, destinationPath, { componentId = "chatgpt", version = "1.0.0" } = {}) {
  const destination = await api.openArchiveDestinationNoFollow(destinationPath);
  const output = await destination.createFilePathNoFollow(["app.exe"], { exclusive: true, size: 7 });
  await finishWritable(output, "payload");
  const verified = await destination.verifyTreeNoFollow(undefined, {
    componentId,
    version,
    requiredFiles: [{ path: "app.exe", size: 7, directory: false }],
  });
  await destination.close();
  return verified;
}

test("version-root capability consumes an opaque exact-tree receipt before sealing and renames by held identity", async () => {
  const fake = createFakeNative([
    { path: "C:\\work\\versions" },
    { path: "C:\\work\\versions\\ct" },
  ]);
  const api = capabilities(fake);
  const verified = await issueVersionReceipt(api, "C:\\work\\versions\\ct");
  assert.ok(verified.verificationReceipt && typeof verified.verificationReceipt === "object");
  assert.match(verified.treeDigest, /^[a-f0-9]{64}$/u);
  assert.match(verified.manifestDigest, /^[a-f0-9]{64}$/u);

  const root = await api.openVersionRootNoFollow("C:\\work\\versions");
  const staging = await root.openSlotNoFollow("ct");
  assert.equal(staging.evidence, null);
  await assert.rejects(
    root.sealPreparedSlotNoFollow(staging.descriptor, {
      schemaVersion: 2,
      componentId: "chatgpt",
      version: "1.0.0",
      treeDigest: verified.treeDigest,
      manifestDigest: verified.manifestDigest,
    }, {}),
    /version_verification_receipt_invalid/u,
  );
  const evidence = await root.sealPreparedSlotNoFollow(staging.descriptor, {
    schemaVersion: 2,
    componentId: "chatgpt",
    version: "1.0.0",
    treeDigest: verified.treeDigest,
    manifestDigest: verified.manifestDigest,
  }, verified.verificationReceipt);
  assert.equal(evidence.version, "1.0.0");
  assert.deepEqual(evidence.identity, staging.descriptor.identity);
  assert.equal(evidence.treeDigest, verified.treeDigest);
  assert.equal(evidence.manifestDigest, verified.manifestDigest);
  assert.equal(fake.calls.some((call) => call[0] === "flush" && call[1].endsWith(".codexbridge-version.json")), true);
  await assert.rejects(
    root.sealPreparedSlotNoFollow(staging.descriptor, {
      schemaVersion: 2,
      componentId: "chatgpt",
      version: "1.0.0",
      treeDigest: verified.treeDigest,
      manifestDigest: verified.manifestDigest,
    }, verified.verificationReceipt),
    /version_verification_receipt_consumed/u,
  );

  await root.renameSlotNoReplace(staging.descriptor, "c");
  assert.equal(fake.calls.some((call) => call[0] === "rename-handle"
    && call[1] === "C:\\work\\versions\\ct" && call[3] === "c" && call[4] === false), true);
  await root.close();
  assert.equal(fake.handles.size, 0);

  fake.add("C:\\work\\versions\\ct", { kind: "directory" });
  fake.add("C:\\work\\versions\\ct\\app.exe", { kind: "file", data: "payload" });
  const secondRoot = await api.openVersionRootNoFollow("C:\\work\\versions");
  const replacementStaging = await secondRoot.openSlotNoFollow("ct");
  await assert.rejects(
    secondRoot.sealPreparedSlotNoFollow(replacementStaging.descriptor, {
      schemaVersion: 2,
      componentId: "chatgpt",
      version: "1.0.0",
      treeDigest: verified.treeDigest,
      manifestDigest: verified.manifestDigest,
    }, verified.verificationReceipt),
    /version_verification_receipt_(?:consumed|directory_mismatch)/u,
  );
  await secondRoot.close();
});

test("version receipt rejects wrong bindings, stale reuse, missing files, and changed content", async () => {
  const fake = createFakeNative([
    { path: "C:\\work\\versions" },
    { path: "C:\\work\\versions\\ct" },
    { path: "C:\\work\\other" },
  ]);
  const api = capabilities(fake);
  const wrongDirectory = await issueVersionReceipt(api, "C:\\work\\other");
  let root = await api.openVersionRootNoFollow("C:\\work\\versions");
  let staging = await root.openSlotNoFollow("ct");
  await assert.rejects(
    root.sealPreparedSlotNoFollow(staging.descriptor, {
      schemaVersion: 2,
      componentId: "chatgpt",
      version: "1.0.0",
      treeDigest: wrongDirectory.treeDigest,
      manifestDigest: wrongDirectory.manifestDigest,
    }, wrongDirectory.verificationReceipt),
    /version_verification_receipt_directory_mismatch/u,
  );
  await root.close();

  const verified = await issueVersionReceipt(api, "C:\\work\\versions\\ct");
  root = await api.openVersionRootNoFollow("C:\\work\\versions");
  staging = await root.openSlotNoFollow("ct");
  for (const metadata of [
    {
      schemaVersion: 2,
      componentId: "chatgpt",
      version: "2.0.0",
      treeDigest: verified.treeDigest,
      manifestDigest: verified.manifestDigest,
    },
    {
      schemaVersion: 2,
      componentId: "git",
      version: "1.0.0",
      treeDigest: verified.treeDigest,
      manifestDigest: verified.manifestDigest,
    },
    {
      schemaVersion: 2,
      componentId: "chatgpt",
      version: "1.0.0",
      treeDigest: verified.treeDigest,
      manifestDigest: "0".repeat(64),
    },
    {
      schemaVersion: 2,
      componentId: "chatgpt",
      version: "1.0.0",
      treeDigest: "0".repeat(64),
      manifestDigest: verified.manifestDigest,
    },
  ]) {
    await assert.rejects(
      root.sealPreparedSlotNoFollow(staging.descriptor, metadata, verified.verificationReceipt),
      /version_verification_receipt_mismatch/u,
    );
  }
  await root.close();

  fake.get("C:\\work\\versions\\ct\\app.exe").data = Buffer.from("changed");
  root = await api.openVersionRootNoFollow("C:\\work\\versions");
  staging = await root.openSlotNoFollow("ct");
  await assert.rejects(
    root.sealPreparedSlotNoFollow(staging.descriptor, {
      schemaVersion: 2,
      componentId: "chatgpt",
      version: "1.0.0",
      treeDigest: verified.treeDigest,
      manifestDigest: verified.manifestDigest,
    }, verified.verificationReceipt),
    /version_tree_digest_mismatch/u,
  );
  await root.close();

  fake.get("C:\\work\\versions\\ct\\app.exe").data = Buffer.from("payload");
  fake.get("C:\\work\\versions\\ct\\app.exe").deleted = true;
  root = await api.openVersionRootNoFollow("C:\\work\\versions");
  staging = await root.openSlotNoFollow("ct");
  await assert.rejects(
    root.sealPreparedSlotNoFollow(staging.descriptor, {
      schemaVersion: 2,
      componentId: "chatgpt",
      version: "1.0.0",
      treeDigest: verified.treeDigest,
      manifestDigest: verified.manifestDigest,
    }, verified.verificationReceipt),
    /version_tree_digest_mismatch/u,
  );
  await root.close();
});

test("openSlot validates the V2 marker against the current exact-tree content digest", async () => {
  const fake = createFakeNative([
    { path: "C:\\work\\versions" },
    { path: "C:\\work\\versions\\ct" },
  ]);
  const api = capabilities(fake);
  const verified = await issueVersionReceipt(api, "C:\\work\\versions\\ct");
  let root = await api.openVersionRootNoFollow("C:\\work\\versions");
  let staging = await root.openSlotNoFollow("ct");
  await root.sealPreparedSlotNoFollow(staging.descriptor, {
    schemaVersion: 2,
    componentId: "chatgpt",
    version: "1.0.0",
    treeDigest: verified.treeDigest,
    manifestDigest: verified.manifestDigest,
  }, verified.verificationReceipt);
  await root.close();

  fake.get("C:\\work\\versions\\ct\\app.exe").data = Buffer.from("PAYLOAD");
  root = await api.openVersionRootNoFollow("C:\\work\\versions");
  staging = await root.openSlotNoFollow("ct");
  assert.equal(staging.markerStatus, "invalid");
  assert.equal(staging.evidence, null);
  await root.close();
});

test("version-root rename rejects identity drift before invoking the native rename", async () => {
  const fake = createFakeNative([
    { path: "C:\\work\\versions" },
    { path: "C:\\work\\versions\\ct" },
  ]);
  const root = await capabilities(fake).openVersionRootNoFollow("C:\\work\\versions");
  const staging = await root.openSlotNoFollow("ct");
  fake.get("C:\\work\\versions\\ct").identity = { volumeSerial: "vol-1", fileId: "swapped" };
  await assert.rejects(root.renameSlotNoReplace(staging.descriptor, "c"), /identity_changed/u);
  assert.equal(fake.calls.some((call) => call[0] === "rename-handle"), false);
  await root.close();
  assert.equal(fake.handles.size, 0);
});

test("version-root descriptor deletes a retiring tree only through the shared handle-bound safe walker", async () => {
  const fake = createFakeNative([
    { path: "C:\\work\\versions" },
    { path: "C:\\work\\versions\\cr" },
    { path: "C:\\work\\versions\\cr\\payload.bin", kind: "file", data: "old" },
  ]);
  const root = await capabilities(fake).openVersionRootNoFollow("C:\\work\\versions");
  const retiring = await root.openSlotNoFollow("cr");
  await deleteAuthorizedTree({
    target: "C:\\work\\versions\\cr",
    authorizedRoot: "C:\\work\\versions",
    rootHandle: root,
    targetDescriptor: retiring.descriptor,
  });
  assert.equal(fake.get("C:\\work\\versions\\cr"), undefined);
  assert.equal(fake.get("C:\\work\\versions\\cr\\payload.bin"), undefined);
  assert.equal(fake.calls.filter((call) => call[0] === "delete-handle").length, 2);
  assert.equal(fake.handles.size, 0);
});

test("descriptor deletion rejects a slot capability from another pinned root before touching its tree", async () => {
  const fake = createFakeNative([
    { path: "C:\\work\\versions-a" },
    { path: "C:\\work\\versions-a\\cr" },
    { path: "C:\\work\\versions-b" },
    { path: "C:\\work\\versions-b\\cr" },
    { path: "C:\\work\\versions-b\\cr\\keep.bin", kind: "file", data: "keep" },
  ]);
  const capabilitiesApi = capabilities(fake);
  const rootA = await capabilitiesApi.openVersionRootNoFollow("C:\\work\\versions-a");
  const rootB = await capabilitiesApi.openVersionRootNoFollow("C:\\work\\versions-b");
  const foreign = await rootB.openSlotNoFollow("cr");
  await assert.rejects(
    deleteAuthorizedTree({
      target: "C:\\work\\versions-a\\cr",
      authorizedRoot: "C:\\work\\versions-a",
      rootHandle: rootA,
      targetDescriptor: foreign.descriptor,
    }),
    /delete_no_follow_descriptor_invalid/u,
  );
  assert.equal(fake.get("C:\\work\\versions-b\\cr\\keep.bin").data.toString(), "keep");
  assert.equal(fake.calls.some((call) => call[0] === "delete-handle"), false);
  await rootB.close();
  assert.equal(fake.handles.size, 0);
});

test("journal directory exposes bounded direct-child listing plus flushed no-replace publication", async () => {
  const fake = createFakeNative([{ path: "C:\\work\\journal" }]);
  const directory = await capabilities(fake).openJournalDirectoryNoFollow("C:\\work\\journal");
  const temp = await directory.openFileNoFollow("chatgpt.prepared.json.tmp", "wx");
  await temp.writeFile("{}", "utf8");
  await temp.sync();
  await temp.close();
  await directory.renameEntryNoFollow(temp.entry, "chatgpt.prepared.json");
  assert.deepEqual(await directory.listFileNamesNoFollow(), ["chatgpt.prepared.json"]);
  assert.equal(fake.calls.some((call) => call[0] === "flush"), true);
  assert.equal(fake.calls.some((call) => call[0] === "rename-handle" && call[4] === false), true);
  await directory.close();
  assert.equal(fake.handles.size, 0);
});

test("safe-delete lists bounded names and deletes files and directories by descriptor handle", async () => {
  const fake = createFakeNative([
    { path: "C:\\work\\owned" },
    { path: "C:\\work\\owned\\tree" },
    { path: "C:\\work\\owned\\tree\\file.txt", kind: "file", data: "x" },
  ]);
  const root = await capabilities(fake).openDirectoryNoFollow("C:\\work\\owned");
  const tree = await root.openChildNoFollow("tree");
  assert.deepEqual(await tree.handle.listChildren(), ["file.txt"]);
  const file = await tree.handle.openChildNoFollow("file.txt");
  await tree.handle.unlinkChildNoFollow(file);
  await tree.handle.close();
  await root.rmdirChildNoFollow(tree);
  assert.deepEqual(fake.calls.filter((call) => call[0] === "delete-handle").map((call) => call[2]), [false, true]);
  await root.close();
  assert.equal(fake.handles.size, 0);
  assert.equal(fake.calls.some((call) => call[0] === "readdir"), false);
  assert.equal(fake.calls.some((call) => call[0] === "enumerate"), true);
});

test("safe-delete directory enumeration enforces one owner-wide entry budget", async () => {
  const entries = [{ path: "C:\\work\\owned" }, { path: "C:\\work\\owned\\nested" }];
  for (let index = 0; index < 4_095; index += 1) {
    entries.push({ path: `C:\\work\\owned\\file-${index}.txt`, kind: "file", data: "" });
  }
  entries.push({ path: "C:\\work\\owned\\nested\\overflow.txt", kind: "file", data: "" });
  const fake = createFakeNative(entries);
  const root = await capabilities(fake).openDirectoryNoFollow("C:\\work\\owned");
  const names = await root.listChildren();
  assert.equal(names.length, 4_096);
  const nested = await root.openChildNoFollow("nested");
  await assert.rejects(nested.handle.listChildren(), /entry_limit/u);
  await nested.handle.close();
  await root.close();
});

test("archive pin detects identity change while holding the exact file", async () => {
  const fake = createFakeNative([{ path: "C:\\work\\archive.7z", kind: "file", data: "archive" }]);
  const pin = await capabilities(fake).pinArchiveFileNoFollow("C:\\work\\archive.7z");
  const handle = [...fake.handles].find((candidate) => candidate.node.kind === "file");
  handle.node.identity = { volumeSerial: "vol-1", fileId: "changed" };
  await assert.rejects(pin.assertStableNoFollow(), /identity_changed/u);
  await pin.close();
  assert.equal(fake.handles.size, 0);
});

test("archive destination must be initially empty and closes handles on rejection", async () => {
  const fake = createFakeNative([
    { path: "C:\\work\\staging" },
    { path: "C:\\work\\staging\\occupied.txt", kind: "file", data: "x" },
  ]);
  await assert.rejects(capabilities(fake).openArchiveDestinationNoFollow("C:\\work\\staging"), /destination_not_empty/u);
  assert.equal(fake.handles.size, 0);
});

test("verified archive walk rejects hard links and observes cancellation while closing handles", async () => {
  const hardLinkFake = createFakeNative([
    { path: "C:\\work\\staging" },
    { path: "C:\\work\\staging\\payload.exe", kind: "file", data: "x", nlink: 2 },
  ]);
  const hardLinkDestination = await capabilities(hardLinkFake).openArchiveDestinationNoFollow("C:\\work\\staging").catch((error) => {
    assert.match(error.message, /destination_not_empty/u);
    return null;
  });
  assert.equal(hardLinkDestination, null);

  const fake = createFakeNative([{ path: "C:\\work\\staging" }]);
  const destination = await capabilities(fake).openArchiveDestinationNoFollow("C:\\work\\staging");
  fake.add("C:\\work\\staging\\payload.exe", { kind: "file", data: "x", nlink: 2 });
  await assert.rejects(destination.verifyTreeNoFollow(), /hard_link/u);
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await assert.rejects(destination.verifyTreeNoFollow(controller.signal), { code: "ABORT_ERR" });
  await destination.close();
  assert.equal(fake.handles.size, 0);
});

test("archive destination creates pinned parents and a writable exclusive file with verified evidence", async () => {
  const fake = createFakeNative([{ path: "C:\\work\\staging" }]);
  const destination = await capabilities(fake).openArchiveDestinationNoFollow("C:\\work\\staging");
  await destination.ensureDirectoryPathNoFollow(["app", "bin"]);
  const output = await destination.createFilePathNoFollow(["app", "bin", "tool.exe"], { exclusive: true, size: 4 });
  output.write(Buffer.from("tool"));
  output.end();
  await new Promise((resolve, reject) => {
    output.once("finish", resolve);
    output.once("error", reject);
  });
  const trackedHandle = [...fake.handles].find((handle) => handle.node.path.endsWith("tool.exe"));
  assert.equal(trackedHandle?.closed, false);
  assert.deepEqual(trackedHandle?.options.share, ["read"]);
  assert.deepEqual(await destination.verifyTreeNoFollow(), [
    { path: "app", realPath: "C:\\work\\staging\\app", directory: true, size: 0, link: false, reparse: false, hardLink: false, nlink: 1 },
    { path: "app/bin", realPath: "C:\\work\\staging\\app\\bin", directory: true, size: 0, link: false, reparse: false, hardLink: false, nlink: 1 },
    { path: "app/bin/tool.exe", realPath: "C:\\work\\staging\\app\\bin\\tool.exe", directory: false, size: 4, link: false, reparse: false, hardLink: false, nlink: 1 },
  ]);
  await destination.close();
  assert.equal(fake.handles.size, 0);
});

test("installer workspace capability issues exact direct children and mutates only held identities", async () => {
  const fake = createFakeNative([{ path: "D:\\CBApps" }]);
  const api = capabilities(fake);
  const workspace = await api.openInstallerWorkspaceRootNoFollow(
    await installRootAuthority("D:\\CBApps"), { maxRelativePath: 80 },
  );
  assert.equal(await workspace.openDirectoryChildNoFollow(
    workspace.root, "downloads", { role: "rename-parent" },
  ), null);
  assert.equal(fake.get("D:\\CBApps\\downloads"), undefined);
  const [downloads, concurrentDownloads] = await Promise.all([
    workspace.createOrOpenDirectoryChildNoFollow(workspace.root, "downloads", { requireEmpty: false, role: "rename-parent" }),
    workspace.createOrOpenDirectoryChildNoFollow(workspace.root, "downloads", { requireEmpty: false, role: "rename-parent" }),
  ]);
  const reopenedDownloads = await workspace.openDirectoryChildNoFollow(
    workspace.root, "downloads", { role: "rename-parent" },
  );
  assert.deepEqual(
    await workspace.inspectIssuedChildNoFollow(reopenedDownloads),
    await workspace.inspectIssuedChildNoFollow(downloads),
  );
  assert.deepEqual(
    await workspace.inspectIssuedChildNoFollow(concurrentDownloads),
    await workspace.inspectIssuedChildNoFollow(downloads),
  );
  const part = await workspace.createFileChildNoFollow(downloads, "chatgpt-1.0.0.zip.part");
  assert.deepEqual(await workspace.inspectIssuedChildNoFollow(part), {
    path: "D:\\CBApps\\downloads\\chatgpt-1.0.0.zip.part",
    kind: "file",
    size: 0,
    empty: true,
  });
  const sealed = await workspace.sealIssuedFileNoFollow(part, {
    size: 0,
    sha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
  });
  const promoted = await workspace.renameIssuedChildNoReplace(sealed, "chatgpt-1.0.0.zip");
  await assert.rejects(workspace.inspectIssuedChildNoFollow(part), /receipt_(?:invalid|consumed)/u);
  await assert.rejects(workspace.deleteIssuedChildNoFollow(workspace.root), /root_mutation_rejected/u);
  await workspace.deleteIssuedChildNoFollow(promoted);
  assert.equal(fake.get("D:\\CBApps\\downloads\\chatgpt-1.0.0.zip"), undefined);
  await assert.rejects(workspace.deleteIssuedChildNoFollow(promoted), /receipt_(?:invalid|consumed)/u);
  await workspace.close();
  assert.equal(fake.handles.size, 0);
  await assert.rejects(workspace.inspectIssuedChildNoFollow(downloads), /capability_closed/u);
});

test("installer workspace pins writable parts, seals signed bytes in chunks, and renames only sealed files", async () => {
  const fake = createFakeNative([{ path: "D:\\CBApps" }]);
  const workspace = await capabilities(fake).openInstallerWorkspaceRootNoFollow(
    await installRootAuthority("D:\\CBApps"), { maxRelativePath: 80 },
  );
  const downloads = await workspace.createOrOpenDirectoryChildNoFollow(
    workspace.root, "downloads", { requireEmpty: false, role: "rename-parent" },
  );
  const part = await workspace.createFileChildNoFollow(downloads, "chatgpt-1.0.0.zip.part");
  await workspace.inspectIssuedChildNoFollow(part);
  const partPath = "D:\\CBApps\\downloads\\chatgpt-1.0.0.zip.part";
  const content = Buffer.from("signed-package-content");
  fake.get(partPath).data = content;
  const initialHandle = [...fake.handles].find((handle) => handle.node.path === partPath);
  assert.deepEqual(initialHandle.options, {
    access: ["read", "attributes"],
    share: ["read", "write", "delete"],
    disposition: "createNew",
    directory: false,
  });
  await assert.rejects(
    workspace.renameIssuedChildNoReplace(part, "chatgpt-1.0.0.zip"),
    /workspace_sealed_file_required/u,
  );

  const writer = await fake.nativeApi.openPath(partPath, {
    access: ["write"],
    share: ["read", "write", "delete"],
    disposition: "openExisting",
    directory: false,
  });
  await assert.rejects(
    workspace.sealIssuedFileNoFollow(part, {
      size: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
    }),
    /sharing_violation/u,
  );
  await fake.nativeApi.closeHandle(writer);

  const sealed = await workspace.sealIssuedFileNoFollow(part, {
    size: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  });
  await assert.rejects(workspace.inspectIssuedChildNoFollow(part), /receipt_(?:invalid|consumed)/u);
  const sealOpen = fake.calls.findLast((call) => call[0] === "open" && call[1] === partPath);
  assert.deepEqual(sealOpen[2], {
    access: ["read", "attributes", "delete"],
    share: ["read"],
    disposition: "openExisting",
    directory: false,
  });
  assert.equal(initialHandle.closed, true);
  assert.equal(fake.calls.filter((call) => call[0] === "read-chunk").length >= 2, true);
  await assert.rejects(fake.nativeApi.openPath(partPath, {
    access: ["write"],
    share: ["read", "write", "delete"],
    disposition: "openExisting",
    directory: false,
  }), /sharing_violation/u);

  const promoted = await workspace.renameIssuedChildNoReplace(sealed, "chatgpt-1.0.0.zip");
  assert.equal(fake.get("D:\\CBApps\\downloads\\chatgpt-1.0.0.zip.part"), undefined);
  assert.notEqual(fake.get("D:\\CBApps\\downloads\\chatgpt-1.0.0.zip"), undefined);
  assert.equal(fake.calls.some((call) => call[0] === "rename-handle"
    && call[2] === "D:\\CBApps\\downloads"), true);
  await workspace.deleteIssuedChildNoFollow(promoted);
  await workspace.close();
});

test("installer workspace seal rejects same-length rewrites, identity swaps, and signed hash mismatches without publishing", async () => {
  const expected = Buffer.from("expected-package");
  const expectedHash = createHash("sha256").update(expected).digest("hex");
  for (const scenario of ["same-length-rewrite", "identity-swap"]) {
    const fake = createFakeNative([{ path: "D:\\CBApps" }]);
    const workspace = await capabilities(fake).openInstallerWorkspaceRootNoFollow(
      await installRootAuthority("D:\\CBApps"), { maxRelativePath: 80 },
    );
    const downloads = await workspace.createOrOpenDirectoryChildNoFollow(
      workspace.root, "downloads", { requireEmpty: false, role: "rename-parent" },
    );
    const partPath = "D:\\CBApps\\downloads\\package.zip.part";
    const part = await workspace.createFileChildNoFollow(downloads, "package.zip.part");
    fake.get(partPath).data = Buffer.from(expected);
    if (scenario === "same-length-rewrite") {
      fake.get(partPath).data = Buffer.alloc(expected.length, 0x78);
    } else {
      fake.replace(partPath, { kind: "file", data: expected });
    }
    await assert.rejects(
      workspace.sealIssuedFileNoFollow(part, { size: expected.length, sha256: expectedHash }),
      scenario === "same-length-rewrite" ? /workspace_file_hash_mismatch/u : /identity_changed/u,
    );
    assert.equal(fake.get("D:\\CBApps\\downloads\\package.zip"), undefined);
    assert.equal(fake.calls.some((call) => call[0] === "rename-handle"), false);
    await workspace.close();
  }
});

test("installer workspace seal fails closed on growth, truncation, abort, and handle-close errors", async (t) => {
  const expected = Buffer.from("expected-package");
  const expectedHash = createHash("sha256").update(expected).digest("hex");
  for (const scenario of ["growth", "truncation", "abort", "close-error"]) {
    await t.test(scenario, async () => {
      const fake = createFakeNative([{ path: "D:\\CBApps" }]);
      const workspace = await capabilities(fake).openInstallerWorkspaceRootNoFollow(
        await installRootAuthority("D:\\CBApps"), { maxRelativePath: 80 },
      );
      const downloads = await workspace.createOrOpenDirectoryChildNoFollow(
        workspace.root, "downloads", { requireEmpty: false, role: "rename-parent" },
      );
      const partPath = "D:\\CBApps\\downloads\\package.zip.part";
      const part = await workspace.createFileChildNoFollow(downloads, "package.zip.part");
      fake.get(partPath).data = Buffer.from(expected);
      const controller = new AbortController();
      let hooked = false;
      fake.onReadChunk((handle) => {
        if (hooked) return;
        hooked = true;
        if (scenario === "growth") handle.node.data = Buffer.concat([handle.node.data, Buffer.from("x")]);
        if (scenario === "truncation") handle.node.data = handle.node.data.subarray(0, handle.node.data.length - 1);
        if (scenario === "abort") controller.abort(new Error("stop"));
      });
      if (scenario === "close-error") fake.failClose(partPath, new Error("close failed"));
      await assert.rejects(
        workspace.sealIssuedFileNoFollow(part, {
          size: expected.length,
          sha256: expectedHash,
          ...(scenario === "abort" ? { signal: controller.signal } : {}),
        }),
        scenario === "abort" ? { code: "ABORT_ERR" }
          : scenario === "close-error" ? /close failed/u
            : /workspace_file_size_mismatch/u,
      );
      assert.equal(fake.calls.some((call) => call[0] === "rename-handle"), false);
      const liveSealHandles = [...fake.handles].filter((handle) => handle.node.path === partPath
        && handle.options.access.includes("delete"));
      assert.equal(liveSealHandles.length, 0);
      if (scenario === "close-error") {
        await assert.rejects(workspace.inspectIssuedChildNoFollow(part), /capability_closed|receipt_consumed/u);
      }
      await workspace.close().catch(() => {});
      assert.equal(fake.handles.size, 0);
    });
  }
});

test("installer workspace seal shares the catalog package-size ceiling", async () => {
  const fake = createFakeNative([{ path: "D:\\CBApps" }]);
  const workspace = await capabilities(fake).openInstallerWorkspaceRootNoFollow(
    await installRootAuthority("D:\\CBApps"), { maxRelativePath: 80 },
  );
  const downloads = await workspace.createOrOpenDirectoryChildNoFollow(
    workspace.root, "downloads", { requireEmpty: false, role: "rename-parent" },
  );
  const part = await workspace.createFileChildNoFollow(downloads, "package.zip.part");
  await assert.rejects(
    workspace.sealIssuedFileNoFollow(part, {
      size: MAX_SOFTWARE_PACKAGE_BYTES,
      sha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
    }),
    /workspace_file_size_mismatch/u,
  );
  await assert.rejects(
    workspace.sealIssuedFileNoFollow(part, {
      size: MAX_SOFTWARE_PACKAGE_BYTES + 1,
      sha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
    }),
    /workspace_file_seal_options_invalid/u,
  );
  assert.equal(fake.calls.some((call) => call[0] === "rename-handle"), false);
  await workspace.close();
});

test("real Windows installer workspace seals after Node closes and blocks same-length rewrites", {
  skip: process.platform !== "win32",
}, async () => {
  const tempParent = await mkdtemp(join(tmpdir(), "codexbridge-installer-workspace-"));
  const rootPath = join(tempParent, `workspace-${"x".repeat(48)}`);
  await mkdir(rootPath);
  const downloadsPath = join(rootPath, "downloads");
  const stagingPath = join(rootPath, "staging");
  const partPath = join(downloadsPath, "chatgpt-1.0.0.zip.part");
  const finalPath = join(downloadsPath, "chatgpt-1.0.0.zip");
  let workspace = null;
  try {
    const stableRootPath = await realpath(rootPath);
    const installRoot = await authorizeInstallRoot({
      candidate: stableRootPath,
      env: process.env,
      maxRelativePath: 100,
      access,
      realpath,
      lstat,
    });
    workspace = await createWindowsFileCapabilities({
      platform: "win32",
      nativeApi: createWin32FileApi({ platform: "win32" }),
    }).openInstallerWorkspaceRootNoFollow(installRoot, { maxRelativePath: 100 });
    const downloads = await workspace.createOrOpenDirectoryChildNoFollow(
      workspace.root, "downloads", { requireEmpty: false, role: "rename-parent" },
    );
    const part = await workspace.createFileChildNoFollow(downloads, "chatgpt-1.0.0.zip.part");
    const content = Buffer.from("node-stream-compatible");
    const contentHash = createHash("sha256").update(content).digest("hex");
    const output = fs.createWriteStream(partPath, { flags: "w" });
    output.end(content);
    await once(output, "close");
    assert.equal((await workspace.inspectIssuedChildNoFollow(part)).size, content.length);
    const heldWriter = await fs.promises.open(partPath, "r+");
    await assert.rejects(
      workspace.sealIssuedFileNoFollow(part, { size: content.length, sha256: contentHash }),
      /sharing_violation/u,
    );
    await heldWriter.close();
    await writeFile(partPath, Buffer.alloc(content.length, 0x78));
    await assert.rejects(
      workspace.sealIssuedFileNoFollow(part, { size: content.length, sha256: contentHash }),
      /workspace_file_hash_mismatch/u,
    );
    await writeFile(partPath, content);
    const sealed = await workspace.sealIssuedFileNoFollow(part, {
      size: content.length,
      sha256: contentHash,
    });
    await assert.rejects(writeFile(partPath, Buffer.alloc(content.length, 0x79)), (error) => (
      error?.code === "EBUSY" || error?.code === "EPERM" || error?.code === "EACCES"
    ));
    await writeFile(finalPath, "occupied");
    await assert.rejects(
      workspace.renameIssuedChildNoReplace(sealed, "chatgpt-1.0.0.zip"),
      /entry_exists/u,
    );
    await unlink(finalPath);
    const promoted = await workspace.renameIssuedChildNoReplace(sealed, "chatgpt-1.0.0.zip");
    await workspace.deleteIssuedChildNoFollow(promoted);
    const staging = await workspace.createOrOpenDirectoryChildNoFollow(
      workspace.root, "staging", { requireEmpty: false, role: "anchor" },
    );
    const task = await workspace.createOrOpenDirectoryChildNoFollow(
      staging, "task-smoke", { requireEmpty: false, role: "deletable" },
    );
    const leaf = await workspace.createOrOpenDirectoryChildNoFollow(
      task, "chatgpt.prepare", { requireEmpty: true, role: "deletable" },
    );
    await workspace.deleteIssuedChildNoFollow(leaf);
    await workspace.deleteIssuedChildNoFollow(task);
    await workspace.close();
    workspace = null;
  } finally {
    if (workspace) await workspace.close().catch(() => {});
    await unlink(partPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    await unlink(finalPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    await rmdir(join(stagingPath, "task-smoke", "chatgpt.prepare")).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    await rmdir(join(stagingPath, "task-smoke")).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    await rmdir(stagingPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    await rmdir(downloadsPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    await rmdir(rootPath);
    await rmdir(tempParent);
  }
});

test("installer workspace child reuse rejects nonempty, reparse, hardlink, ADS, and identity drift", async (t) => {
  const base = [
    { path: "D:\\CBApps" },
    { path: "D:\\CBApps\\staging" },
    { path: "D:\\CBApps\\staging\\busy", kind: "file", data: "x" },
  ];
  const fake = createFakeNative(base);
  const rootAuthority = await installRootAuthority("D:\\CBApps");
  const workspace = await capabilities(fake).openInstallerWorkspaceRootNoFollow(
    rootAuthority, { maxRelativePath: 80 },
  );
  await assert.rejects(
    workspace.createOrOpenDirectoryChildNoFollow(workspace.root, "extra", { requireEmpty: true, extra: true }),
    /workspace_directory_options_invalid/u,
  );
  await assert.rejects(
    workspace.createOrOpenDirectoryChildNoFollow(workspace.root, "extra", { requireEmpty: true, role: "arbitrary" }),
    /workspace_directory_options_invalid/u,
  );
  await assert.rejects(
    workspace.createOrOpenDirectoryChildNoFollow(workspace.root, "staging", { requireEmpty: true }),
    /workspace_directory_not_empty/u,
  );
  await workspace.close();

  for (const [label, options, expected] of [
    ["reparse", { reparse: true }, /reparse/u],
    ["hardlink", { nlink: 2 }, /hard_link/u],
    ["ADS", { streams: ["::$DATA", ":evil:$DATA"] }, /alternate_data_stream/u],
  ]) {
    await t.test(label, async () => {
      const hostile = createFakeNative([
        { path: "D:\\CBApps" },
        { path: "D:\\CBApps\\downloads" },
        { path: "D:\\CBApps\\downloads\\package.zip.part", kind: "file", ...options },
      ]);
      const scoped = await capabilities(hostile).openInstallerWorkspaceRootNoFollow(
        rootAuthority, { maxRelativePath: 80 },
      );
      const downloads = await scoped.createOrOpenDirectoryChildNoFollow(scoped.root, "downloads", { requireEmpty: false });
      await assert.rejects(scoped.openFileChildNoFollow(downloads, "package.zip.part"), expected);
      await scoped.close();
      assert.equal(hostile.handles.size, 0);
    });
  }

  const changed = createFakeNative([
    { path: "D:\\CBApps" },
    { path: "D:\\CBApps\\downloads" },
    { path: "D:\\CBApps\\downloads\\package.zip.part", kind: "file" },
  ]);
  const scoped = await capabilities(changed).openInstallerWorkspaceRootNoFollow(
    rootAuthority, { maxRelativePath: 80 },
  );
  const downloads = await scoped.createOrOpenDirectoryChildNoFollow(scoped.root, "downloads", { requireEmpty: false });
  const part = await scoped.openFileChildNoFollow(downloads, "package.zip.part");
  changed.get("D:\\CBApps\\downloads\\package.zip.part").identity = { volumeSerial: "vol-1", fileId: "changed" };
  await assert.rejects(scoped.deleteIssuedChildNoFollow(part), /identity_changed/u);
  assert.notEqual(changed.get("D:\\CBApps\\downloads\\package.zip.part"), undefined);
  await scoped.close();
});

test("installer workspace rejects foreign receipts, collisions, and concurrent double consumption", async () => {
  const fake = createFakeNative([
    { path: "D:\\CBApps" },
    { path: "D:\\Other" },
    { path: "D:\\CBApps\\downloads" },
    { path: "D:\\CBApps\\downloads\\occupied.zip", kind: "file", data: "keep" },
  ]);
  const api = capabilities(fake);
  const owned = await api.openInstallerWorkspaceRootNoFollow(
    await installRootAuthority("D:\\CBApps"), { maxRelativePath: 80 },
  );
  const other = await api.openInstallerWorkspaceRootNoFollow(
    await installRootAuthority("D:\\Other"), { maxRelativePath: 80 },
  );
  const downloads = await owned.createOrOpenDirectoryChildNoFollow(
    owned.root, "downloads", { requireEmpty: false, role: "rename-parent" },
  );
  const part = await owned.createFileChildNoFollow(downloads, "package.zip.part");
  await assert.rejects(other.inspectIssuedChildNoFollow(part), /workspace_receipt_invalid/u);
  const sealed = await owned.sealIssuedFileNoFollow(part, {
    size: 0,
    sha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
  });
  await assert.rejects(owned.renameIssuedChildNoReplace(sealed, "occupied.zip"), /entry_exists/u);
  assert.equal(fake.get("D:\\CBApps\\downloads\\occupied.zip").data.toString(), "keep");
  const results = await Promise.allSettled([
    owned.deleteIssuedChildNoFollow(sealed),
    owned.deleteIssuedChildNoFollow(sealed),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(fake.calls.filter((call) => call[0] === "delete-handle"
    && call[1].endsWith("package.zip.part")).length, 1);
  await owned.close();
  await other.close();
});

test("shortcut temp revalidates identity and commits by handle without replacing candidates", async () => {
  const fake = createFakeNative([
    { path: "C:\\Users\\me\\Desktop" },
    { path: "C:\\Users\\me\\Desktop\\ChatGPT.lnk", kind: "file", data: "existing" },
  ]);
  const shortcut = capabilities(fake).createShortcutFileApi();
  const temp = await shortcut.createTemp({ directory: "C:\\Users\\me\\Desktop", suffix: ".lnk" });
  const tempOpen = fake.calls.find((call) => call[0] === "open" && call[1] === temp.path);
  assert.deepEqual(tempOpen[2], {
    access: ["attributes"],
    share: ["read", "write", "delete"],
    disposition: "createNew",
    directory: false,
  });
  fake.get(temp.path).data = Buffer.from("electron shortcut");
  const sealed = await shortcut.sealTemp(temp);
  assert.equal(sealed.path, temp.path);
  const sealedHandle = [...fake.handles].find((handle) => handle.node.path === temp.path && !handle.options.access.includes("delete"));
  assert.deepEqual(sealedHandle.options.access, ["read", "attributes"]);
  assert.deepEqual(sealedHandle.options.share, ["read", "delete"]);
  const electronRead = await fake.nativeApi.openPath(temp.path, {
    access: ["read"], share: ["read"], disposition: "openExisting", directory: false,
  });
  await assert.rejects(fake.nativeApi.openPath(temp.path, {
    access: ["write"], share: ["read", "write", "delete"], disposition: "openExisting", directory: false,
  }), /sharing_violation/u);
  await fake.nativeApi.closeHandle(electronRead);
  assert.equal(await shortcut.commitNoReplace(sealed, "C:\\Users\\me\\Desktop\\ChatGPT.lnk"), "occupied");
  const heldAfterCollision = [...fake.handles].filter((handle) => handle.node.path === temp.path);
  assert.equal(heldAfterCollision.length, 2);
  assert.equal(heldAfterCollision.some((handle) => handle.options.access.includes("delete")), true);
  const mutationOpenIndex = fake.calls.findIndex((call) => call[0] === "open"
    && call[1] === temp.path && call[2].access.includes("delete"));
  const sealCloseIndex = fake.calls.findIndex((call) => call[0] === "close"
    && call[1] === temp.path && call[2].access.includes("read")
    && call[2].share.includes("delete") && !call[2].access.includes("delete"));
  assert.equal(mutationOpenIndex >= 0, true);
  assert.equal(sealCloseIndex === -1 || sealCloseIndex > mutationOpenIndex, true);
  assert.equal(await shortcut.commitNoReplace(sealed, "C:\\Users\\me\\Desktop\\ChatGPT（2）.lnk"), "committed");
  assert.equal(fake.get("C:\\Users\\me\\Desktop\\ChatGPT.lnk").data.toString(), "existing");
  assert.equal(fake.get("C:\\Users\\me\\Desktop\\ChatGPT（2）.lnk").data.toString(), "electron shortcut");
  assert.equal(fake.calls.some((call) => call[0] === "rename-handle"), true);
});

test("shortcut commit rejects a temp identity swapped after Electron writes", async () => {
  const fake = createFakeNative([{ path: "C:\\Users\\me\\Desktop" }]);
  const shortcut = capabilities(fake).createShortcutFileApi();
  const temp = await shortcut.createTemp({ directory: "C:\\Users\\me\\Desktop", suffix: ".lnk" });
  fake.replace(temp.path, { kind: "file", data: "attacker" });
  await assert.rejects(
    shortcut.sealTemp(temp),
    /identity_changed/u,
  );
  assert.equal(fake.calls.some((call) => call[0] === "rename-handle"), false);
  assert.equal(fake.handles.size, 0);
  assert.equal(await shortcut.removeTemp(temp), true);
});

test("shortcut removeTemp closes the whole owner and aggregates identity and close failures", async () => {
  const fake = createFakeNative([{ path: "C:\\Users\\me\\Desktop" }]);
  const shortcut = capabilities(fake).createShortcutFileApi();
  const temp = await shortcut.createTemp({ directory: "C:\\Users\\me\\Desktop", suffix: ".lnk" });
  fake.replace(temp.path, { kind: "file", data: "attacker" });
  fake.failClose(temp.path, new Error("close failed"));

  await assert.rejects(shortcut.removeTemp(temp), (error) => {
    assert.equal(error instanceof AggregateError, true);
    assert.match(JSON.stringify(error, Object.getOwnPropertyNames(error)), /identity_changed|close failed/u);
    return true;
  });
  assert.equal(fake.handles.size, 0);
});

test("shortcut inspection distinguishes absence from access errors and removal consumes exact identity", async () => {
  const path = "C:\\Users\\me\\Desktop\\ChatGPT.lnk";
  const fake = createFakeNative([{ path: "C:\\Users\\me\\Desktop" }]);
  const shortcut = capabilities(fake).createShortcutFileApi();
  assert.deepEqual(await shortcut.inspectExact(path), { kind: "absent" });
  fake.failOpen(path, codedError("access_denied", 5));
  await assert.rejects(shortcut.inspectExact(path), /access_denied/u);

  const removable = createFakeNative([
    { path: "C:\\Users\\me\\Desktop" },
    { path, kind: "file", data: "shortcut" },
  ]);
  const removableApi = capabilities(removable).createShortcutFileApi();
  const inspected = await removableApi.inspectExact(path);
  assert.equal(inspected.kind, "file");
  const electronRead = await removable.nativeApi.openPath(path, {
    access: ["read"], share: ["read"], disposition: "openExisting", directory: false,
  });
  await removable.nativeApi.closeHandle(electronRead);
  assert.equal(await removableApi.removeExact(inspected), true);
  assert.equal(removable.calls.some((call) => call[0] === "delete-handle"), true);
  assert.deepEqual(await removableApi.inspectExact(path), { kind: "absent" });
});

test("shortcut inspection reports directories as other and rejects reparses instead of absence", async () => {
  const directoryPath = "C:\\Users\\me\\Desktop\\folder.lnk";
  const reparsePath = "C:\\Users\\me\\Desktop\\linked.lnk";
  const fake = createFakeNative([
    { path: "C:\\Users\\me\\Desktop" },
    { path: directoryPath },
    { path: reparsePath, kind: "file", reparse: true },
  ]);
  const shortcut = capabilities(fake).createShortcutFileApi();
  assert.deepEqual(await shortcut.inspectExact(directoryPath), { kind: "other" });
  await assert.rejects(shortcut.inspectExact(reparsePath), /reparse/u);
  assert.equal(fake.handles.size, 0);
});

test("shortcut held descriptor is synchronously claimed and only occupied restores retryability", async () => {
  const fake = createFakeNative([{ path: "C:\\Users\\me\\Desktop" }]);
  const shortcut = capabilities(fake).createShortcutFileApi();
  const temp = await shortcut.createTemp({ directory: "C:\\Users\\me\\Desktop", suffix: ".lnk" });
  fake.get(temp.path).data = Buffer.from("shortcut");
  const sealed = await shortcut.sealTemp(temp);
  const results = await Promise.allSettled([
    shortcut.commitNoReplace(sealed, "C:\\Users\\me\\Desktop\\ChatGPT.lnk"),
    shortcut.commitNoReplace(sealed, "C:\\Users\\me\\Desktop\\V2RayN.lnk"),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(fake.calls.filter((call) => call[0] === "rename-handle").length, 1);
});

test("shortcut commit failure deletes the temp and closes both held handles", async () => {
  const fake = createFakeNative([{ path: "C:\\Users\\me\\Desktop" }]);
  const shortcut = capabilities(fake).createShortcutFileApi();
  const temp = await shortcut.createTemp({ directory: "C:\\Users\\me\\Desktop", suffix: ".lnk" });
  fake.get(temp.path).data = Buffer.from("shortcut");
  const sealed = await shortcut.sealTemp(temp);
  fake.failRename(temp.path, new Error("rename failed"));

  await assert.rejects(
    shortcut.commitNoReplace(sealed, "C:\\Users\\me\\Desktop\\ChatGPT.lnk"),
    /rename failed/u,
  );
  assert.equal(fake.get(temp.path), undefined);
  assert.equal(fake.handles.size, 0);
  assert.equal(await shortcut.removeTemp(sealed), true);
});

for (const [label, candidatePath, expected] of [
  ["invalid candidate", "ChatGPT.lnk", /windows_path_absolute_required/u],
  ["cross-directory candidate", "D:\\Other\\ChatGPT.lnk", /candidate_directory_mismatch/u],
]) {
  test(`shortcut ${label} still deletes the sealed temp by its held identity`, async () => {
    const fake = createFakeNative([{ path: "C:\\Users\\me\\Desktop" }]);
    const shortcut = capabilities(fake).createShortcutFileApi();
    const temp = await shortcut.createTemp({ directory: "C:\\Users\\me\\Desktop", suffix: ".lnk" });
    fake.get(temp.path).data = Buffer.from("shortcut");
    const sealed = await shortcut.sealTemp(temp);

    await assert.rejects(shortcut.commitNoReplace(sealed, candidatePath), expected);
    assert.equal(fake.get(temp.path), undefined);
    assert.equal(fake.calls.some((call) => call[0] === "delete-handle" && call[1] === temp.path), true);
    assert.equal(fake.handles.size, 0);
    assert.equal(await shortcut.removeTemp(sealed), true);
  });
}

test("shortcut invalid candidate preserves mutation-open and close failures without claiming cleanup", async () => {
  const fake = createFakeNative([{ path: "C:\\Users\\me\\Desktop" }]);
  const shortcut = capabilities(fake).createShortcutFileApi();
  const temp = await shortcut.createTemp({ directory: "C:\\Users\\me\\Desktop", suffix: ".lnk" });
  fake.get(temp.path).data = Buffer.from("shortcut");
  const sealed = await shortcut.sealTemp(temp);
  fake.failOpen(temp.path, new Error("mutation open failed"));
  fake.failClose(temp.path, new Error("seal close failed"));

  await assert.rejects(shortcut.commitNoReplace(sealed, "ChatGPT.lnk"), (error) => {
    assert.equal(error instanceof AggregateError, true);
    const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
    assert.match(serialized, /windows_path_absolute_required/u);
    assert.match(serialized, /mutation open failed/u);
    assert.match(serialized, /seal close failed/u);
    return true;
  });
  assert.notEqual(fake.get(temp.path), undefined);
  assert.equal(fake.handles.size, 0);
  await assert.rejects(shortcut.removeTemp(sealed), /cleanup_unconfirmed/u);
});

test("shortcut removeExact failure closes both held handles and aggregates close failures", async () => {
  const shortcutPath = "C:\\Users\\me\\Desktop\\ChatGPT.lnk";
  const fake = createFakeNative([
    { path: "C:\\Users\\me\\Desktop" },
    { path: shortcutPath, kind: "file", data: "shortcut" },
  ]);
  const shortcut = capabilities(fake).createShortcutFileApi();
  const inspected = await shortcut.inspectExact(shortcutPath);
  fake.failDelete(shortcutPath, new Error("delete failed"));
  fake.failClose(shortcutPath, new Error("close failed"));

  await assert.rejects(shortcut.removeExact(inspected), (error) => {
    assert.equal(error instanceof AggregateError, true);
    assert.match(JSON.stringify(error, Object.getOwnPropertyNames(error)), /delete failed|close failed/u);
    return true;
  });
  assert.equal(fake.handles.size, 0);
  await shortcut.release(inspected);
});

test("thin Win32 layer binds fixed Kernel32 and Ntdll APIs with a relative held-parent rename", async () => {
  const bindings = [];
  const createCalls = [];
  const setInfoCalls = [];
  const ntSetInfoCalls = [];
  let ntStatus = 0;
  const finalPaths = new Map([
    [42n, "C:\\safe\\source.part"],
    [99n, "C:\\safe"],
  ]);
  const stubs = new Map([
    ["CreateFileW", (...args) => { createCalls.push(args); return 42n; }],
    ["CloseHandle", () => 1],
    ["GetLastError", () => 0],
    ["SetFileInformationByHandle", (...args) => { setInfoCalls.push(args); return 1; }],
    ["NtSetInformationFile", (...args) => { ntSetInfoCalls.push(args); return ntStatus; }],
    ["RtlNtStatusToDosError", (status) => {
      assert.equal(status, -1073741771);
      return 183;
    }],
    ["GetFinalPathNameByHandleW", (handle, output) => {
      const value = Buffer.from(finalPaths.get(BigInt(handle)) ?? "C:\\safe", "utf16le");
      value.copy(output);
      return value.length / 2;
    }],
  ]);
  const koffi = {
    load(name) {
      assert.equal(["Kernel32.dll", "ntdll.dll"].includes(name), true);
      return {
        func(...definition) {
          bindings.push(definition);
          const name = definition.length === 4 ? definition[1] : definition[0];
          return stubs.get(name) ?? (() => 1);
        },
      };
    },
    sizeof(type) { return type === "intptr_t" ? 8 : 4; },
  };
  const api = createWin32FileApi({ platform: "win32", koffi });
  const handle = await api.openPath("C:\\safe", {
    access: ["read", "delete", "traverse"],
    share: ["read", "write"],
    disposition: "openExisting",
    directory: true,
  });
  assert.equal(handle, 42n);
  assert.equal(createCalls[0][0], "\\\\?\\C:\\safe");
  assert.equal(createCalls[0][5] & 0x00200000, 0x00200000);
  assert.equal(createCalls[0][5] & 0x02000000, 0x02000000);
  assert.equal(createCalls[0][1] & 0x20, 0x20);
  assert.equal(createCalls[0][2] & 0x4, 0);
  await api.openPath("C:\\lease", {
    access: ["read", "delete"], share: [], disposition: "createNew",
    directory: false, deleteOnClose: true,
  });
  assert.equal(createCalls[1][5] & 0x04000000, 0x04000000);
  assert.equal(createCalls[1][2], 0);
  await api.renameByHandle(42n, 99n, "target.lnk", { replace: false });
  ntStatus = -1073741771;
  assert.throws(
    () => api.renameByHandle(42n, 99n, "occupied.lnk", { replace: false }),
    /entry_exists/u,
  );
  ntStatus = 0;
  finalPaths.set(99n, "D:\\other");
  assert.throws(
    () => api.renameByHandle(42n, 99n, "escape.lnk", { replace: false }),
    /windows_rename_directory_mismatch/u,
  );
  finalPaths.set(99n, "C:\\safe");
  await api.deleteByHandle(42n, { directory: false });
  assert.equal(ntSetInfoCalls[0][0], 42n);
  assert.equal(ntSetInfoCalls[0][4], 10);
  assert.equal(ntSetInfoCalls[0][2].readUInt32LE(0), 0);
  assert.equal(ntSetInfoCalls[0][2].readBigUInt64LE(8), 99n);
  const renameNameLength = ntSetInfoCalls[0][2].readUInt32LE(16);
  assert.equal(
    ntSetInfoCalls[0][2].subarray(20, 20 + renameNameLength).toString("utf16le"),
    "target.lnk",
  );
  assert.equal(ntSetInfoCalls[0][2].length, 24 + Buffer.byteLength("target.lnk", "utf16le"));
  assert.equal(setInfoCalls[0][1], 4);
  assert.equal(bindings.every((definition) => definition[0] === "__stdcall"), true);
  assert.deepEqual(bindings.map((definition) => definition[1]), [
    "CreateFileW", "CloseHandle", "GetLastError", "GetFileInformationByHandle",
    "GetFileInformationByHandleEx", "GetFinalPathNameByHandleW", "ReadFile", "WriteFile",
    "FlushFileBuffers", "CreateDirectoryW", "SetFileInformationByHandle",
    "NtSetInformationFile", "RtlNtStatusToDosError",
  ]);
});

test("thin Win32 layer exposes a bounded single-chunk read primitive", () => {
  const payload = Buffer.from("chunked-package");
  let reads = 0;
  let eof = false;
  const koffi = {
    load() {
      return {
        func(...definition) {
          const name = definition.length === 4 ? definition[1] : definition[0];
          if (name === "ReadFile") {
            return (_handle, output, count, read) => {
              reads += 1;
              const chunk = eof ? Buffer.alloc(0) : payload.subarray(0, count);
              eof = true;
              chunk.copy(output);
              read.writeUInt32LE(chunk.length, 0);
              return 1;
            };
          }
          return () => 1;
        },
      };
    },
    sizeof(type) { return type === "intptr_t" ? 8 : 4; },
  };
  const api = createWin32FileApi({ platform: "win32", koffi });
  assert.deepEqual(api.readChunk(42n, 7), payload.subarray(0, 7));
  assert.deepEqual(api.readChunk(42n, 7), Buffer.alloc(0));
  assert.equal(reads, 2);
  assert.throws(() => api.readChunk(42n, 0), /native_read_chunk_size_invalid/u);
  assert.throws(() => api.readChunk(42n, 1024 * 1024 + 1), /native_read_chunk_size_invalid/u);
});

test("Ntdll same-directory rename uses the x86 FILE_RENAME_INFORMATION ABI", () => {
  const ntCalls = [];
  const paths = new Map([[7n, "C:\\safe\\package.part"], [9n, "C:\\safe"]]);
  const stubs = new Map([
    ["GetFinalPathNameByHandleW", (handle, output) => {
      const value = Buffer.from(paths.get(BigInt(handle)), "utf16le");
      value.copy(output);
      return value.length / 2;
    }],
    ["NtSetInformationFile", (...args) => { ntCalls.push(args); return 0; }],
    ["RtlNtStatusToDosError", () => 317],
  ]);
  const koffi = {
    load() {
      return {
        func(...definition) {
          const name = definition.length === 4 ? definition[1] : definition[0];
          return stubs.get(name) ?? (() => 1);
        },
      };
    },
    sizeof(type) { return type === "intptr_t" ? 4 : 4; },
  };
  const api = createWin32FileApi({ platform: "win32", koffi });
  api.renameByHandle(7n, 9n, "package.zip", { replace: false });
  const info = ntCalls[0][2];
  assert.equal(info.readUInt32LE(0), 0);
  assert.equal(info.readUInt32LE(4), 9);
  const nameLength = info.readUInt32LE(8);
  assert.equal(info.subarray(12, 12 + nameLength).toString("utf16le"), "package.zip");
  assert.equal(info.length, 16 + Buffer.byteLength("package.zip", "utf16le"));
  assert.equal(ntCalls[0][4], 10);
});
