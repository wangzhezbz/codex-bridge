import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import {
  access, lstat, mkdir, mkdtemp, realpath, rmdir, unlink, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { promisify } from "node:util";

import { deleteAuthorizedTree } from "../desktop/software-manager/safe-delete.mjs";
import { authorizeInstallRoot, authorizeSkillsRoot } from "../desktop/software-manager/path-policy.mjs";
import { createWin32FileApi } from "../desktop/software-manager/win32-file-api.mjs";
import { createWindowsFileCapabilities } from "../desktop/software-manager/windows-file-capabilities.mjs";
import { createSkillPrepareJournal } from "../desktop/software-manager/skill-prepare-journal.mjs";
import { MAX_SOFTWARE_PACKAGE_BYTES } from "../shared/software-manager/catalog-schema.mjs";

const execFileAsync = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const SEVEN_ZIP_PATH = join(dirname(require.resolve("7zip-bin")), "win", process.arch, "7za.exe");

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
  let failStreams = null;
  let readChunkHook = null;
  let openPathHook = null;

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
    async openPath(requestedPath, options) {
      let exactPath = requestedPath;
      if (openPathHook) {
        const redirected = openPathHook({
          path: requestedPath,
          options: structuredClone(options),
          handles,
          get: (value) => nodes.get(key(value)),
        });
        if (typeof redirected === "string") exactPath = redirected;
      }
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
    async setFilePosition(handle, offset) {
      const current = requireHandle(handle);
      current.position = offset;
      calls.push(["seek", current.node.path, offset]);
    },
    async truncateFile(handle, size) {
      const current = requireHandle(handle);
      current.node.data = current.node.data.subarray(0, size);
      current.position = size;
      calls.push(["truncate", current.node.path, size]);
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
      if (failStreams?.path?.toLowerCase() === node.path.toLowerCase()) throw failStreams.error;
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
    async createDirectoryAtNoFollow(parentHandle, name, options) {
      const parent = requireHandle(parentHandle).node;
      const exactPath = `${parent.path}\\${name}`;
      calls.push(["mkdir-at", parent.path, name, structuredClone(options)]);
      if (nodes.has(key(exactPath))) throw codedError("entry_exists", 183);
      const node = add(exactPath, { kind: "directory" });
      const handle = { node, options, closed: false };
      handles.add(handle);
      return handle;
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
    clearFailRename() { failRename = null; },
    failDelete(path, error) { failDelete = { path, error }; },
    failStreams(path, error) { failStreams = { path, error }; },
    onReadChunk(hook) { readChunkHook = hook; },
    onOpenPath(hook) { openPathHook = hook; },
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

async function skillsRootAuthority(candidate = "C:\\Users\\me\\.codex\\skills") {
  return authorizeSkillsRoot({
    candidate,
    realpath: async (value) => value,
    lstat: async () => ({
      dev: 2, ino: 3,
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

test("Skill prepare journal reuses held production descriptors for publish, recovery, and clear", async (t) => {
  const journalDir = "C:\\work\\journal";
  const installRoot = "C:\\work\\apps";
  const sourcePath = `${installRoot}\\staging\\task-task1\\skill-documents.prepare`;
  const leaseNonce = "1".repeat(32);
  const record = (phase) => ({
    schemaVersion: 1,
    phase,
    taskId: "task1",
    skillId: "documents",
    installRoot,
    sourcePath,
    leaseScope: "prepare",
    leaseNonce,
    identity: phase === "intent" ? null : { volumeSerial: "volume", fileId: "source" },
    evidence: ["sealed", "deleting"].includes(phase) ? {
      kind: "directory",
      identity: { volumeSerial: "volume", fileId: "source" },
      treeDigest: "a".repeat(64),
      manifestDigest: "b".repeat(64),
      skillMdSha256: "c".repeat(64),
    } : null,
  });
  const create = (fake) => createSkillPrepareJournal({
    journalDir,
    installRoot,
    fsApi: capabilities(fake),
  });

  await t.test("fresh intent bound and sealed publication", async () => {
    const fake = createFakeNative([{ path: journalDir }, { path: installRoot }]);
    const journal = create(fake);
    for (const phase of ["intent", "bound", "sealed"]) await journal.record(record(phase));
    assert.equal((await journal.load({ taskId: "task1", skillId: "documents" })).snapshot.phase, "sealed");
    assert.equal(fake.handles.size, 0);
  });

  await t.test("dead flushed temp publication", async () => {
    const fake = createFakeNative([{ path: journalDir }, { path: installRoot }]);
    const journal = create(fake);
    const tempPath = `${journalDir}\\skill-prepare-${createHash("sha256")
      .update("task1\0documents", "utf8").digest("hex")}.intent.json.tmp`;
    fake.failRename(tempPath, codedError("test_publish_failed"));
    await assert.rejects(journal.record(record("intent")), /test_publish_failed/u);
    fake.clearFailRename();
    assert.equal((await journal.list({
      claimLease: async () => ({ async release() {} }),
    }))[0].phase, "intent");
    assert.equal(fake.handles.size, 0);
  });

  await t.test("another live writer keeps its temp and predecessor hidden", async () => {
    const fake = createFakeNative([{ path: journalDir }, { path: installRoot }]);
    const fileCapabilities = capabilities(fake);
    const journal = createSkillPrepareJournal({ journalDir, installRoot, fsApi: fileCapabilities });
    await journal.record(record("intent"));
    const recordHash = createHash("sha256").update("task1\0documents", "utf8").digest("hex");
    const writer = await fileCapabilities.openJournalDirectoryNoFollow(journalDir);
    const temp = await writer.openFileNoFollow(`skill-prepare-${recordHash}.bound.json.tmp`, "wx");
    await temp.writeFile(`${JSON.stringify(record("bound"))}\n`, "utf8");
    await temp.sync();
    await temp.close();

    assert.deepEqual(await journal.list({ claimLease: async () => {
      throw new Error("live_writer_lease_must_not_be_probed");
    } }), []);
    assert.equal(fake.get(`${journalDir}\\skill-prepare-${recordHash}.bound.json.tmp`).deleted, false);

    await writer.close();
    assert.equal((await journal.list({
      claimLease: async () => ({ async release() {} }),
    }))[0].phase, "bound");
    assert.equal(fake.handles.size, 0);
  });

  await t.test("temp-only clear", async () => {
    const fake = createFakeNative([{ path: journalDir }, { path: installRoot }]);
    const journal = create(fake);
    await journal.record(record("intent"));
    const tempPath = `${journalDir}\\skill-prepare-${createHash("sha256")
      .update("task1\0documents", "utf8").digest("hex")}.bound.json.tmp`;
    fake.failRename(tempPath, codedError("test_publish_failed"));
    await assert.rejects(journal.record(record("bound")), /test_publish_failed/u);
    fake.clearFailRename();
    assert.equal(await journal.clear({ taskId: "task1", skillId: "documents" }), true);
    assert.equal(await journal.load({ taskId: "task1", skillId: "documents" }), null);
    assert.equal(fake.handles.size, 0);
  });
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
  for (let index = 0; index < 16_383; index += 1) {
    entries.push({ path: `C:\\work\\owned\\file-${index}.txt`, kind: "file", data: "" });
  }
  entries.push({ path: "C:\\work\\owned\\nested\\overflow.txt", kind: "file", data: "" });
  const fake = createFakeNative(entries);
  const root = await capabilities(fake).openDirectoryNoFollow("C:\\work\\owned");
  const names = await root.listChildren();
  assert.equal(names.length, 16_384);
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

test("archive nested directory creation deletes its exact failed postcondition target", async (t) => {
  await t.test("exact cleanup", async () => {
    const child = "C:\\work\\staging\\app";
    const fake = createFakeNative([{ path: "C:\\work\\staging" }]);
    fake.failStreams(child, new Error("archive_directory_ads_probe_failed"));
    const destination = await capabilities(fake).openArchiveDestinationNoFollow("C:\\work\\staging");
    await assert.rejects(
      destination.ensureDirectoryPathNoFollow(["app"]),
      /archive_directory_ads_probe_failed/u,
    );
    assert.equal(fake.get(child), undefined);
    await destination.close();
    assert.equal(fake.handles.size, 0);
  });

  await t.test("cleanup error aggregation", async () => {
    const child = "C:\\work\\staging\\app";
    const fake = createFakeNative([{ path: "C:\\work\\staging" }]);
    fake.failStreams(child, new Error("archive_directory_ads_probe_failed"));
    fake.failDelete(child, new Error("archive_directory_cleanup_failed"));
    const destination = await capabilities(fake).openArchiveDestinationNoFollow("C:\\work\\staging");
    await assert.rejects(destination.ensureDirectoryPathNoFollow(["app"]), (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.match(error.errors[0].message, /archive_directory_ads_probe_failed/u);
      assert.match(error.errors[1].message, /archive_directory_cleanup_failed/u);
      return true;
    });
    assert.notEqual(fake.get(child), undefined);
    await destination.close();
    assert.equal(fake.handles.size, 0);
  });
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

test("atomic workspace directory creation cleans an exact postcondition failure and preserves cleanup errors", async (t) => {
  await t.test("exact cleanup", async () => {
    const child = "D:\\CBApps\\task-new";
    const fake = createFakeNative([{ path: "D:\\CBApps" }]);
    fake.failStreams(child, new Error("directory_ads_probe_failed"));
    const workspace = await capabilities(fake).openInstallerWorkspaceRootNoFollow(
      await installRootAuthority("D:\\CBApps"), { maxRelativePath: 80 },
    );
    await assert.rejects(workspace.createDirectoryChildNoFollow(
      workspace.root, "task-new", { role: "deletable" },
    ), /directory_ads_probe_failed/u);
    assert.equal(fake.get(child), undefined);
    assert.equal(fake.calls.some(([operation, , , options]) => operation === "mkdir-at"
      && JSON.stringify(options?.share) === JSON.stringify(["read"])), true);
    await workspace.close();
    assert.equal(fake.handles.size, 0);
  });

  await t.test("cleanup error aggregation", async () => {
    const child = "D:\\CBApps\\task-stuck";
    const fake = createFakeNative([{ path: "D:\\CBApps" }]);
    fake.failStreams(child, new Error("directory_ads_probe_failed"));
    fake.failDelete(child, new Error("directory_cleanup_failed"));
    const workspace = await capabilities(fake).openInstallerWorkspaceRootNoFollow(
      await installRootAuthority("D:\\CBApps"), { maxRelativePath: 80 },
    );
    await assert.rejects(workspace.createDirectoryChildNoFollow(
      workspace.root, "task-stuck", { role: "deletable" },
    ), (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.match(error.errors[0].message, /directory_ads_probe_failed/u);
      assert.match(error.errors[1].message, /directory_cleanup_failed/u);
      return true;
    });
    assert.notEqual(fake.get(child), undefined);
    await workspace.close();
    assert.equal(fake.handles.size, 0);
  });
});

test("Skill source proof copies across roots then swaps only held direct children inside Skills root", async () => {
  const skillMd = Buffer.from("skill");
  const reference = Buffer.from("reference");
  const fileEntries = [
    { path: "reference.md", size: reference.length, directory: false, sha256: createHash("sha256").update(reference).digest("hex") },
    { path: "SKILL.md", size: skillMd.length, directory: false, sha256: createHash("sha256").update(skillMd).digest("hex") },
  ].sort((left, right) => left.path.localeCompare(right.path, "en"));
  const manifest = fileEntries.map(({ path: entryPath, size, directory }) => ({ path: entryPath, size, directory }));
  const expected = {
    requiredFiles: ["SKILL.md", "reference.md"],
    packageSha256: "9".repeat(64),
    treeDigest: createHash("sha256").update(JSON.stringify(fileEntries)).digest("hex"),
    manifestDigest: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    skillMdSha256: createHash("sha256").update(skillMd).digest("hex"),
  };
  const source = "D:\\CBApps\\staging\\task-skill-task\\skill-documents.prepare";
  const skillsRoot = "C:\\Users\\me\\.codex\\skills";
  const fake = createFakeNative([
    { path: "D:\\CBApps" },
    { path: "D:\\CBApps\\staging" },
    { path: "D:\\CBApps\\staging\\task-skill-task" },
    { path: source },
    { path: `${source}\\SKILL.md`, kind: "file", data: skillMd },
    { path: `${source}\\reference.md`, kind: "file", data: reference },
    { path: skillsRoot },
  ]);
  const api = capabilities(fake);
  const installRootCapability = await installRootAuthority("D:\\CBApps");
  const skillsRootCapability = await skillsRootAuthority(skillsRoot);
  const workspace = await api.openInstallerWorkspaceRootNoFollow(installRootCapability, { maxRelativePath: 100 });
  const staging = await workspace.openDirectoryChildNoFollow(workspace.root, "staging", { role: "anchor" });
  const task = await workspace.openDirectoryChildNoFollow(staging, "task-skill-task", { role: "deletable" });
  const leaf = await workspace.openDirectoryChildNoFollow(task, "skill-documents.prepare", { role: "deletable" });
  const sealed = await workspace.sealIssuedSkillTreeNoFollow(leaf, {
    requiredFiles: expected.requiredFiles,
    packageSha256: expected.packageSha256,
  });
  assert.deepEqual(sealed.evidence, {
    kind: "directory",
    identity: fake.get(source).identity,
    treeDigest: expected.treeDigest,
    manifestDigest: expected.manifestDigest,
    skillMdSha256: expected.skillMdSha256,
  });
  await workspace.close();
  const verified = await api.verifyPreparedSkillNoFollow({
    sourceProof: sealed.sourceProof,
    installRootCapability,
    requiredFiles: expected.requiredFiles,
    expectedPackageSha256: expected.packageSha256,
  });
  assert.deepEqual(verified.evidence, {
    kind: "directory",
    identity: fake.get(source).identity,
    treeDigest: expected.treeDigest,
    manifestDigest: expected.manifestDigest,
    skillMdSha256: expected.skillMdSha256,
  });

  const swap = await api.openSkillRootNoFollow({ installRootCapability, skillsRootCapability });
  const staged = await swap.stagePreparedTreeNoFollow({
    sourceProof: verified.verificationReceipt,
    skillId: "documents",
    swapId: "1".repeat(32),
    expected,
  });
  assert.equal(staged.treeDigest, expected.treeDigest);
  const published = await swap.renameDirectChildNoReplace({
    from: { kind: "prepared", skillId: "documents", swapId: "1".repeat(32) },
    to: { kind: "target", skillId: "documents" },
    expectedIdentity: staged.identity,
  });
  assert.deepEqual(published, staged);
  assert.equal(fake.get(`${skillsRoot}\\documents\\SKILL.md`).data.toString(), "skill");
  assert.equal(fake.get(source)?.path, source, "cross-root source must be copied, never renamed");
  const recovered = await swap.recoverPreparedTreeNoFollow({
    taskId: "skill-task",
    sourceIdentity: fake.get(source).identity,
    skillId: "documents",
    swapId: "2".repeat(32),
    expected,
  });
  assert.equal(recovered.treeDigest, expected.treeDigest);
  await assert.rejects(swap.recoverPreparedTreeNoFollow({
    taskId: "skill-task",
    sourcePath: source,
    sourceIdentity: fake.get(source).identity,
    skillId: "documents",
    swapId: "3".repeat(32),
    expected,
  }), /skill_recovery_request_invalid/u);
  await swap.close();
  assert.equal(fake.handles.size, 0);
});

test("Skill exact deletion locally closes its target handle and preserves scan plus close failures", async () => {
  const skillsRoot = "C:\\Users\\me\\.codex\\skills";
  const target = `${skillsRoot}\\documents`;
  const fake = createFakeNative([
    { path: "D:\\CBApps" },
    { path: skillsRoot },
    { path: target },
    { path: `${target}\\SKILL.md`, kind: "file", data: Buffer.from("skill"), reparse: true },
  ]);
  const api = capabilities(fake);
  const swap = await api.openSkillRootNoFollow({
    installRootCapability: await installRootAuthority("D:\\CBApps"),
    skillsRootCapability: await skillsRootAuthority(skillsRoot),
  });
  const baselineHandles = fake.handles.size;
  fake.failClose(target, new Error("test_target_close_failed"));
  await assert.rejects(swap.deleteDirectChildTreeNoFollow({
    child: { kind: "target", skillId: "documents" },
    expectedEvidence: {
      kind: "directory",
      identity: fake.get(target).identity,
      treeDigest: "a".repeat(64),
      manifestDigest: "b".repeat(64),
      skillMdSha256: "c".repeat(64),
    },
  }), (error) => {
    const rendered = JSON.stringify(error, Object.getOwnPropertyNames(error));
    assert.match(rendered, /windows_reparse_point_rejected/u);
    assert.match(rendered, /test_target_close_failed/u);
    return true;
  });
  assert.equal(fake.handles.size, baselineHandles);
  await swap.close();
  assert.equal(fake.handles.size, 0);
});

test("prepared Skill cleanup is identity-bound, fail-closed for intent, and preserves task siblings", async () => {
  const source = "D:\\CBApps\\staging\\task-skill-task\\skill-documents.prepare";
  const sibling = "D:\\CBApps\\staging\\task-skill-task\\skill-images.prepare";
  const fake = createFakeNative([
    { path: "D:\\CBApps" },
    { path: "D:\\CBApps\\staging" },
    { path: "D:\\CBApps\\staging\\task-skill-task" },
    { path: source },
    { path: `${source}\\partial.txt`, kind: "file", data: Buffer.from("partial") },
    { path: sibling },
  ]);
  const api = capabilities(fake);
  const installRootCapability = await installRootAuthority("D:\\CBApps");
  assert.equal((await api.inspectPreparedSkillSourceNoFollow({
    installRootCapability, taskId: "skill-task", skillId: "documents",
  })).kind, "nonempty");
  await assert.rejects(api.deletePreparedSkillSourceNoFollow({
    installRootCapability,
    taskId: "skill-task",
    skillId: "documents",
    expectedIdentity: null,
    expectedEvidence: null,
  }), /skill_prepare_unbound_occupied/u);

  const sourceIdentity = structuredClone(fake.get(source).identity);
  assert.deepEqual(await api.validatePreparedSkillSourceForDeletionNoFollow({
    installRootCapability,
    taskId: "skill-task",
    skillId: "documents",
    expectedIdentity: sourceIdentity,
    expectedEvidence: null,
  }), { kind: "directory", identity: sourceIdentity, sourcePath: source });
  await api.deletePreparedSkillSourceNoFollow({
    installRootCapability,
    taskId: "skill-task",
    skillId: "documents",
    expectedIdentity: sourceIdentity,
    expectedEvidence: null,
  });
  assert.equal(fake.get(source), undefined);
  assert.notEqual(fake.get(sibling), undefined);
  assert.notEqual(fake.get("D:\\CBApps\\staging\\task-skill-task"), undefined);
  assert.equal(fake.handles.size, 0);
});

test("absent prepared Skill cleanup never adopts or removes an unbound task parent", async () => {
  const task = "D:\\CBApps\\staging\\task-skill-task";
  const fake = createFakeNative([
    { path: "D:\\CBApps" },
    { path: "D:\\CBApps\\staging" },
    { path: task },
  ]);
  const result = await capabilities(fake).deletePreparedSkillSourceNoFollow({
    installRootCapability: await installRootAuthority("D:\\CBApps"),
    taskId: "skill-task",
    skillId: "documents",
    expectedIdentity: { volumeSerial: "vol-1", fileId: "missing" },
    expectedEvidence: null,
  });
  assert.deepEqual(result, { deleted: false, absent: true });
  assert.notEqual(fake.get(task), undefined);
  assert.equal(fake.get("D:\\CBApps\\staging") !== undefined, true);
  assert.equal(fake.handles.size, 0);
});

test("Skill cross-root copy holds every nested parent against an ancestor junction swap", async () => {
  const skillMd = Buffer.from("skill");
  const guide = Buffer.from("guide");
  const entries = [
    { path: "docs", size: 0, directory: true },
    { path: "docs/guide.md", size: guide.length, directory: false, sha256: createHash("sha256").update(guide).digest("hex") },
    { path: "SKILL.md", size: skillMd.length, directory: false, sha256: createHash("sha256").update(skillMd).digest("hex") },
  ].sort((left, right) => {
    const leftKey = left.path.toLowerCase();
    const rightKey = right.path.toLowerCase();
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : left.path.localeCompare(right.path, "en");
  });
  const expected = {
    requiredFiles: ["SKILL.md", "docs/guide.md"],
    packageSha256: "9".repeat(64),
    treeDigest: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    manifestDigest: createHash("sha256").update(JSON.stringify(
      entries.map(({ path: entryPath, size, directory }) => ({ path: entryPath, size, directory })),
    )).digest("hex"),
    skillMdSha256: createHash("sha256").update(skillMd).digest("hex"),
  };
  const source = "D:\\CBApps\\staging\\task-skill-task\\skill-documents.prepare";
  const skillsRoot = "C:\\Users\\me\\.codex\\skills";
  const preparedRoot = `${skillsRoot}\\.codexbridge-new-documents-${"4".repeat(32)}`;
  const nestedParent = `${preparedRoot}\\docs`;
  const fake = createFakeNative([
    { path: "D:\\CBApps" },
    { path: "D:\\CBApps\\staging" },
    { path: "D:\\CBApps\\staging\\task-skill-task" },
    { path: source },
    { path: `${source}\\SKILL.md`, kind: "file", data: skillMd },
    { path: `${source}\\docs` },
    { path: `${source}\\docs\\guide.md`, kind: "file", data: guide },
    { path: skillsRoot },
    { path: "C:\\outside" },
  ]);
  const api = capabilities(fake);
  const installRootCapability = await installRootAuthority("D:\\CBApps");
  const workspace = await api.openInstallerWorkspaceRootNoFollow(installRootCapability, { maxRelativePath: 100 });
  const staging = await workspace.openDirectoryChildNoFollow(workspace.root, "staging", { role: "anchor" });
  const task = await workspace.openDirectoryChildNoFollow(staging, "task-skill-task", { role: "deletable" });
  const leaf = await workspace.openDirectoryChildNoFollow(task, "skill-documents.prepare", { role: "deletable" });
  const sealed = await workspace.sealIssuedSkillTreeNoFollow(leaf, {
    requiredFiles: expected.requiredFiles,
    packageSha256: expected.packageSha256,
  });
  await workspace.close();
  const verified = await api.verifyPreparedSkillNoFollow({
    sourceProof: sealed.sourceProof,
    installRootCapability,
    requiredFiles: expected.requiredFiles,
    expectedPackageSha256: expected.packageSha256,
  });
  let outsideCreates = 0;
  fake.onOpenPath(({ path: openedPath, options, handles, get }) => {
    if (openedPath.toLowerCase() !== `${nestedParent}\\guide.md`.toLowerCase()
      || options.disposition !== "createNew") return openedPath;
    const parent = get(nestedParent);
    const deletionBlocked = [...handles].some((handle) => handle.node === parent
      && !handle.closed && !handle.options.share.includes("delete"));
    if (deletionBlocked) return openedPath;
    outsideCreates += 1;
    return "C:\\outside\\guide.md";
  });
  const swap = await api.openSkillRootNoFollow({
    installRootCapability,
    skillsRootCapability: await skillsRootAuthority(skillsRoot),
  });
  const staged = await swap.stagePreparedTreeNoFollow({
    sourceProof: verified.verificationReceipt,
    skillId: "documents",
    swapId: "4".repeat(32),
    expected,
  });
  assert.equal(staged.treeDigest, expected.treeDigest);
  assert.equal(outsideCreates, 0);
  assert.equal(fake.get("C:\\outside\\guide.md"), undefined);
  await swap.close();
  assert.equal(fake.handles.size, 0);
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
    access: ["read", "write", "attributes", "delete"],
    share: ["read"],
    disposition: "createNew",
    directory: false,
  });
  await assert.rejects(
    workspace.renameIssuedChildNoReplace(part, "chatgpt-1.0.0.zip"),
    /workspace_sealed_file_required/u,
  );

  await assert.rejects(
    fake.nativeApi.openPath(partPath, {
      access: ["write"],
      share: ["read", "write", "delete"],
      disposition: "openExisting",
      directory: false,
    }),
    /sharing_violation/u,
  );

  const sealed = await workspace.sealIssuedFileNoFollow(part, {
    size: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  });
  await assert.rejects(workspace.sealIssuedFileNoFollow(sealed, {
    size: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  }), /workspace_file_receipt_required/u);
  await assert.rejects(workspace.inspectIssuedChildNoFollow(part), /receipt_(?:invalid|consumed)/u);
  const sealedHandle = fake.calls.findLast((call) => call[0] === "open" && call[1] === partPath);
  assert.deepEqual(sealedHandle[2], {
    access: ["read", "attributes"],
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
  assert.equal(fake.handles.size, 0);
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
  for (const scenario of ["growth", "truncation", "abort"]) {
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
      await assert.rejects(
        workspace.sealIssuedFileNoFollow(part, {
          size: expected.length,
          sha256: expectedHash,
          ...(scenario === "abort" ? { signal: controller.signal } : {}),
        }),
        scenario === "abort" ? { code: "ABORT_ERR" } : /workspace_file_size_mismatch/u,
      );
      assert.equal(fake.calls.some((call) => call[0] === "rename-handle"), false);
      const liveSealHandles = [...fake.handles].filter((handle) => handle.node.path === partPath
        && handle.options.access.includes("delete"));
      assert.equal(liveSealHandles.length, 1);
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

test("real Windows installer workspace lets the bundled 7za consume a promoted package while retaining safe cleanup", {
  skip: process.platform !== "win32",
}, async () => {
  const tempParent = await mkdtemp(join(tmpdir(), "codexbridge-installer-workspace-"));
  const rootPath = join(tempParent, `workspace-${"x".repeat(48)}`);
  await mkdir(rootPath);
  const downloadsPath = join(rootPath, "downloads");
  const stagingPath = join(rootPath, "staging");
  const preexistingTaskPath = join(stagingPath, "task-preexisting");
  const partPath = join(downloadsPath, "chatgpt-1.0.0.zip.part");
  const finalPath = join(downloadsPath, "chatgpt-1.0.0.zip");
  const sourceArchive = join(tempParent, "source.zip");
  const sourcePayload = join(tempParent, "payload.txt");
  let workspace = null;
  try {
    await writeFile(sourcePayload, "real-7za-consumer-smoke");
    await execFileAsync(SEVEN_ZIP_PATH, ["a", "-tzip", sourceArchive, sourcePayload, "-y"]);
    const content = await fs.promises.readFile(sourceArchive);
    await unlink(sourceArchive);
    await unlink(sourcePayload);
    const stableRootPath = await realpath(rootPath);
    const installRoot = await authorizeInstallRoot({
      candidate: stableRootPath,
      env: process.env,
      maxRelativePath: 100,
      access,
      realpath,
      lstat,
    });
    const fileApi = createWindowsFileCapabilities({
      platform: "win32",
      nativeApi: createWin32FileApi({ platform: "win32" }),
    });
    workspace = await fileApi.openInstallerWorkspaceRootNoFollow(installRoot, { maxRelativePath: 100 });
    const downloads = await workspace.createOrOpenDirectoryChildNoFollow(
      workspace.root, "downloads", { requireEmpty: false, role: "rename-parent" },
    );
    const part = await workspace.createFileChildNoFollow(downloads, "chatgpt-1.0.0.zip.part");
    const contentHash = createHash("sha256").update(content).digest("hex");
    const output = await workspace.createIssuedFileWriteStreamNoFollow(part, {
      append: false, maxBytes: content.length, signal: new AbortController().signal,
    });
    await finishWritable(output, content);
    assert.equal((await workspace.inspectIssuedChildNoFollow(part)).size, content.length);
    await assert.rejects(
      fs.promises.open(partPath, "r+"),
      (error) => ["EBUSY", "EPERM", "EACCES"].includes(error?.code),
    );
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
    const tested = await execFileAsync(SEVEN_ZIP_PATH, ["t", finalPath]);
    assert.match(tested.stdout, /Everything is Ok/u);
    await workspace.deleteIssuedChildNoFollow(promoted);
    const staging = await workspace.createOrOpenDirectoryChildNoFollow(
      workspace.root, "staging", { requireEmpty: false, role: "anchor" },
    );
    const task = await workspace.createOrOpenDirectoryChildNoFollow(
      staging, "task-smoke", { requireEmpty: false, role: "deletable" },
    );
    const leaf = await workspace.createDirectoryChildNoFollow(
      task, "skill-documents.prepare", { role: "deletable" },
    );
    const leafDescription = await workspace.describeIssuedDirectoryNoFollow(leaf);
    const inspected = await fileApi.inspectPreparedSkillSourceNoFollow({
      installRootCapability: installRoot, taskId: "smoke", skillId: "documents",
    });
    assert.deepEqual(inspected.identity, leafDescription.identity);
    const destination = await fileApi.openArchiveDestinationNoFollow(leafDescription.path, {
      expectedIdentity: leafDescription.identity,
    });
    await destination.assertEmptyNoFollow();
    await destination.close();
    await workspace.deleteIssuedChildNoFollow(leaf);
    await workspace.deleteIssuedChildNoFollow(task);
    await mkdir(preexistingTaskPath);
    const preexistingTask = await workspace.createOrOpenDirectoryChildNoFollow(
      staging, "task-preexisting", { requireEmpty: false, role: "deletable" },
    );
    assert.equal((await workspace.describeIssuedDirectoryNoFollow(preexistingTask)).created, false);
    const preexistingLeaf = await workspace.createDirectoryChildNoFollow(
      preexistingTask, "skill-documents.prepare", { role: "deletable" },
    );
    const preexistingDescription = await workspace.describeIssuedDirectoryNoFollow(preexistingLeaf);
    const preexistingInspected = await fileApi.inspectPreparedSkillSourceNoFollow({
      installRootCapability: installRoot, taskId: "preexisting", skillId: "documents",
    });
    assert.deepEqual(preexistingInspected.identity, preexistingDescription.identity);
    await workspace.deleteIssuedChildNoFollow(preexistingLeaf);
    await workspace.close();
    workspace = null;
  } finally {
    if (workspace) await workspace.close().catch(() => {});
    await unlink(partPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    await unlink(finalPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    await unlink(sourceArchive).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    await unlink(sourcePayload).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    await rmdir(join(stagingPath, "task-smoke", "skill-documents.prepare")).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    await rmdir(join(stagingPath, "task-smoke")).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    await rmdir(join(preexistingTaskPath, "skill-documents.prepare")).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    await rmdir(preexistingTaskPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    await rmdir(stagingPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    await rmdir(downloadsPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    await rmdir(rootPath);
    await rmdir(tempParent);
  }
});

test("real Windows atomic same-name directory collision stays a plain occupied error and preserves foreign content", {
  skip: process.platform !== "win32",
}, async () => {
  const tempParent = await mkdtemp(join(tmpdir(), "codexbridge-atomic-collision-"));
  const rootPath = join(tempParent, "CBApps");
  const foreignPath = join(rootPath, "foreign.prepare");
  const sentinelPath = join(foreignPath, "sentinel.txt");
  let workspace = null;
  try {
    await mkdir(rootPath);
    await mkdir(foreignPath);
    await writeFile(sentinelPath, "foreign-sentinel");
    const stableRootPath = await realpath(rootPath);
    const installRoot = await authorizeInstallRoot({
      candidate: stableRootPath, env: process.env, maxRelativePath: 80,
      access, realpath, lstat,
    });
    const fileApi = createWindowsFileCapabilities({
      platform: "win32", nativeApi: createWin32FileApi({ platform: "win32" }),
    });
    workspace = await fileApi.openInstallerWorkspaceRootNoFollow(installRoot, { maxRelativePath: 80 });
    const beforeReceipt = await workspace.openDirectoryChildNoFollow(
      workspace.root, "foreign.prepare", { role: "anchor" },
    );
    const before = await workspace.describeIssuedDirectoryNoFollow(beforeReceipt);
    await workspace.close();
    workspace = await fileApi.openInstallerWorkspaceRootNoFollow(installRoot, { maxRelativePath: 80 });
    await assert.rejects(
      workspace.createDirectoryChildNoFollow(
        workspace.root, "foreign.prepare", { role: "deletable" },
      ),
      (error) => error instanceof AggregateError === false
        && error?.code === "entry_exists"
        && (error?.nativeCode === 80 || error?.nativeCode === 183),
    );
    await workspace.close();
    workspace = await fileApi.openInstallerWorkspaceRootNoFollow(installRoot, { maxRelativePath: 80 });
    const afterReceipt = await workspace.openDirectoryChildNoFollow(
      workspace.root, "foreign.prepare", { role: "anchor" },
    );
    const after = await workspace.describeIssuedDirectoryNoFollow(afterReceipt);
    assert.deepEqual(after.identity, before.identity);
    assert.equal(await fs.promises.readFile(sentinelPath, "utf8"), "foreign-sentinel");
    await workspace.close();
    workspace = null;
  } finally {
    if (workspace) await workspace.close().catch(() => {});
    await unlink(sentinelPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    await rmdir(foreignPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    await rmdir(rootPath);
    await rmdir(tempParent);
  }
});

test("real Windows empty install root creates and safely reopens fixed ChatGPT and V2RayN staging slots", {
  skip: process.platform !== "win32",
}, async () => {
  const tempParent = await mkdtemp(join(tmpdir(), "codexbridge-fixed-staging-"));
  const rootPath = join(tempParent, "CBApps");
  const chatgptStagingPath = join(rootPath, "ct");
  const v2raynRootPath = join(rootPath, "V2RayN");
  const v2raynStagingPath = join(v2raynRootPath, "staging");
  let workspace = null;
  try {
    await mkdir(rootPath);
    const stableRootPath = await realpath(rootPath);
    const installRoot = await authorizeInstallRoot({
      candidate: stableRootPath, env: process.env, maxRelativePath: 32,
      access, realpath, lstat,
    });
    const fileApi = createWindowsFileCapabilities({
      platform: "win32", nativeApi: createWin32FileApi({ platform: "win32" }),
    });
    workspace = await fileApi.openInstallerWorkspaceRootNoFollow(installRoot, { maxRelativePath: 32 });
    const chatgptStaging = await workspace.createDirectoryChildNoFollow(
      workspace.root, "ct", { role: "deletable" },
    );
    assert.equal((await workspace.inspectIssuedChildNoFollow(chatgptStaging)).empty, true);
    const v2raynRoot = await workspace.createOrOpenDirectoryChildNoFollow(
      workspace.root, "V2RayN", { requireEmpty: false, role: "anchor" },
    );
    const v2raynStaging = await workspace.createDirectoryChildNoFollow(
      v2raynRoot, "staging", { role: "deletable" },
    );
    assert.equal((await workspace.inspectIssuedChildNoFollow(v2raynStaging)).empty, true);
    await workspace.close();
    workspace = null;

    for (const [componentRoot, slotName] of [
      [stableRootPath, "ct"],
      [join(stableRootPath, "V2RayN"), "staging"],
    ]) {
      const target = join(componentRoot, slotName);
      const versionRoot = await fileApi.openVersionRootNoFollow(componentRoot);
      try {
        const opened = await versionRoot.openSlotNoFollow(slotName);
        assert.equal(opened?.markerStatus, "missing");
        await deleteAuthorizedTree({
          target, authorizedRoot: componentRoot, rootHandle: versionRoot,
          targetDescriptor: opened.descriptor,
        });
      } finally {
        await versionRoot.close();
      }
      await assert.rejects(access(target), { code: "ENOENT" });
    }
  } finally {
    if (workspace) await workspace.close().catch(() => {});
    await rmdir(chatgptStagingPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    await rmdir(v2raynStagingPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    await rmdir(v2raynRootPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    await rmdir(rootPath);
    await rmdir(tempParent);
  }
});

test("installer workspace writer stays bound to one held direct-child identity for reset, resume, and verification", async () => {
  const partPath = "D:\\CBApps\\downloads\\chatgpt-1.0.0.zip.part";
  const fake = createFakeNative([{ path: "D:\\CBApps" }]);
  const installRoot = await installRootAuthority("D:\\CBApps");
  const api = capabilities(fake);
  const workspace = await api.openInstallerWorkspaceRootNoFollow(installRoot, { maxRelativePath: 100 });
  const downloads = await workspace.createOrOpenDirectoryChildNoFollow(
    workspace.root, "downloads", { requireEmpty: false, role: "rename-parent" },
  );
  let part = await workspace.createFileChildNoFollow(downloads, "chatgpt-1.0.0.zip.part");

  await assert.rejects(fake.nativeApi.openPath(partPath, {
    access: ["write", "delete"], share: ["read", "write", "delete"],
    disposition: "openExisting", directory: false,
  }), /sharing_violation/u);

  let output = await workspace.createIssuedFileWriteStreamNoFollow(part, {
    append: false, maxBytes: 6, signal: new AbortController().signal,
  });
  await finishWritable(output, "abc");
  assert.equal((await workspace.inspectIssuedChildNoFollow(part)).size, 3);
  await workspace.resetIssuedFileNoFollow(part, {});
  assert.equal((await workspace.inspectIssuedChildNoFollow(part)).size, 0);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(workspace.createIssuedFileWriteStreamNoFollow(part, {
    append: false, maxBytes: 2, signal: aborted.signal,
  }), { name: "AbortError" });
  output = await workspace.createIssuedFileWriteStreamNoFollow(part, {
    append: false, maxBytes: 2, signal: new AbortController().signal,
  });
  await assert.rejects(finishWritable(output, "toolong"), /workspace_file_size_exceeded/u);
  assert.equal(fake.get(partPath).data.length, 0);
  output = await workspace.createIssuedFileWriteStreamNoFollow(part, {
    append: false, maxBytes: 6, signal: new AbortController().signal,
  });
  await finishWritable(output, "abc");
  output = await workspace.createIssuedFileWriteStreamNoFollow(part, {
    append: true, maxBytes: 6, signal: new AbortController().signal,
  });
  await finishWritable(output, "def");
  const digest = createHash("sha256").update("abcdef").digest("hex");
  part = await workspace.sealIssuedFileNoFollow(part, { size: 6, sha256: digest });
  assert.equal((await workspace.inspectIssuedChildNoFollow(part)).size, 6);

  const foreignSession = await api.openInstallerWorkspaceRootNoFollow(installRoot, { maxRelativePath: 100 });
  await assert.rejects(
    foreignSession.createIssuedFileWriteStreamNoFollow(part, {
      append: false, maxBytes: 2, signal: new AbortController().signal,
    }),
    /workspace_receipt_invalid/u,
  );
  await foreignSession.close();
  await workspace.close();
});

test("installer workspace reset honors its signal again immediately before truncation", async () => {
  const partPath = "D:\\CBApps\\downloads\\chatgpt-1.0.0.zip.part";
  const fake = createFakeNative([{ path: "D:\\CBApps" }]);
  const workspace = await capabilities(fake).openInstallerWorkspaceRootNoFollow(
    await installRootAuthority("D:\\CBApps"), { maxRelativePath: 100 },
  );
  const downloads = await workspace.createOrOpenDirectoryChildNoFollow(
    workspace.root, "downloads", { requireEmpty: false, role: "rename-parent" },
  );
  const part = await workspace.createFileChildNoFollow(downloads, "chatgpt-1.0.0.zip.part");
  fake.get(partPath).data = Buffer.from("partial");
  const controller = new AbortController();
  const originalSeek = fake.nativeApi.setFilePosition;
  fake.nativeApi.setFilePosition = async (...args) => {
    await originalSeek(...args);
    controller.abort();
  };
  await assert.rejects(
    workspace.resetIssuedFileNoFollow(part, { signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.equal(fake.calls.some(([operation]) => operation === "truncate"), false);
  assert.equal(fake.get(partPath).data.toString(), "partial");
  await workspace.close();
});

test("promoted package downgrades to a read-only shared handle and safely upgrades only for cleanup", async () => {
  const partPath = "D:\\CBApps\\downloads\\chatgpt-1.0.0.zip.part";
  const finalPath = "D:\\CBApps\\downloads\\chatgpt-1.0.0.zip";
  const fake = createFakeNative([{ path: "D:\\CBApps" }]);
  const workspace = await capabilities(fake).openInstallerWorkspaceRootNoFollow(
    await installRootAuthority("D:\\CBApps"), { maxRelativePath: 100 },
  );
  const downloads = await workspace.createOrOpenDirectoryChildNoFollow(
    workspace.root, "downloads", { requireEmpty: false, role: "rename-parent" },
  );
  const part = await workspace.createFileChildNoFollow(downloads, "chatgpt-1.0.0.zip.part");
  const content = Buffer.from("consumer-readable-package");
  const output = await workspace.createIssuedFileWriteStreamNoFollow(part, {
    append: false, maxBytes: content.length, signal: new AbortController().signal,
  });
  await finishWritable(output, content);
  const sealed = await workspace.sealIssuedFileNoFollow(part, {
    size: content.length, sha256: createHash("sha256").update(content).digest("hex"),
  });
  const promoted = await workspace.renameIssuedChildNoReplace(sealed, "chatgpt-1.0.0.zip");
  const held = [...fake.handles].filter((handle) => handle.node.path === finalPath);
  assert.equal(held.length, 1);
  assert.deepEqual(held[0].options.access, ["read", "attributes"]);
  assert.deepEqual(held[0].options.share, ["read"]);
  const consumer = await fake.nativeApi.openPath(finalPath, {
    access: ["read"], share: ["read"], disposition: "openExisting", directory: false,
  });
  await assert.rejects(fake.nativeApi.openPath(finalPath, {
    access: ["write"], share: ["read", "write", "delete"], disposition: "openExisting", directory: false,
  }), /sharing_violation/u);
  await assert.rejects(fake.nativeApi.openPath(finalPath, {
    access: ["delete"], share: ["read", "write", "delete"], disposition: "openExisting", directory: false,
  }), /sharing_violation/u);
  await fake.nativeApi.closeHandle(consumer);
  await workspace.deleteIssuedChildNoFollow(promoted);
  assert.equal(fake.get(finalPath), undefined);
  const mutationOpen = fake.calls.find((call) => call[0] === "open" && call[1] === finalPath
    && call[2].access.includes("delete"));
  assert.equal(Boolean(mutationOpen), true);
  await workspace.close();
  assert.equal(fake.handles.size, 0);
  assert.equal(fake.get(partPath), undefined);
});

test("promoted package cleanup rejects a replacement in the read-pin to delete-handle gap", async () => {
  const finalPath = "D:\\CBApps\\downloads\\chatgpt-1.0.0.zip";
  const fake = createFakeNative([{ path: "D:\\CBApps" }]);
  const workspace = await capabilities(fake).openInstallerWorkspaceRootNoFollow(
    await installRootAuthority("D:\\CBApps"), { maxRelativePath: 100 },
  );
  const downloads = await workspace.createOrOpenDirectoryChildNoFollow(
    workspace.root, "downloads", { requireEmpty: false, role: "rename-parent" },
  );
  const part = await workspace.createFileChildNoFollow(downloads, "chatgpt-1.0.0.zip.part");
  const content = Buffer.from("verified-original");
  const output = await workspace.createIssuedFileWriteStreamNoFollow(part, {
    append: false, maxBytes: content.length, signal: new AbortController().signal,
  });
  await finishWritable(output, content);
  const sealed = await workspace.sealIssuedFileNoFollow(part, {
    size: content.length, sha256: createHash("sha256").update(content).digest("hex"),
  });
  const promoted = await workspace.renameIssuedChildNoReplace(sealed, "chatgpt-1.0.0.zip");
  let replaceOnMutationOpen = true;
  fake.onOpenPath(({ path: openedPath, options }) => {
    if (replaceOnMutationOpen && openedPath === finalPath && options.access.includes("delete")) {
      replaceOnMutationOpen = false;
      fake.replace(finalPath, { kind: "file", data: "foreign" });
    }
  });
  await assert.rejects(workspace.deleteIssuedChildNoFollow(promoted), /windows_identity_changed/u);
  assert.equal(fake.get(finalPath).data.toString(), "foreign");
  assert.equal(fake.calls.some((call) => call[0] === "delete-handle" && call[1] === finalPath), false);
  await workspace.close();
  assert.equal(fake.handles.size, 0);
});

test("installer workspace writer rejects replacement, hardlink, and reparse drift before writing foreign bytes", async (t) => {
  for (const attack of ["replacement", "hardlink", "reparse"]) {
    await t.test(attack, async () => {
      const partPath = "D:\\CBApps\\downloads\\chatgpt-1.0.0.zip.part";
      const fake = createFakeNative([{ path: "D:\\CBApps" }]);
      const workspace = await capabilities(fake).openInstallerWorkspaceRootNoFollow(
        await installRootAuthority("D:\\CBApps"), { maxRelativePath: 100 },
      );
      const downloads = await workspace.createOrOpenDirectoryChildNoFollow(
        workspace.root, "downloads", { requireEmpty: false, role: "rename-parent" },
      );
      const part = await workspace.createFileChildNoFollow(downloads, "chatgpt-1.0.0.zip.part");
      const original = fake.get(partPath);
      let foreign = original;
      if (attack === "replacement") foreign = fake.replace(partPath, { kind: "file" });
      if (attack === "hardlink") original.nlink = 2;
      if (attack === "reparse") original.reparse = true;
      await assert.rejects(
        workspace.createIssuedFileWriteStreamNoFollow(part, {
          append: false, maxBytes: 7, signal: new AbortController().signal,
        }),
        /windows_(?:identity_changed|hard_link_rejected|reparse_point_rejected)/u,
      );
      assert.equal(original.data.length, 0);
      assert.equal(foreign.data.length, 0);
      await workspace.close();
    });
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
  const createDirectoryCalls = [];
  const setInfoCalls = [];
  const seekCalls = [];
  const truncateCalls = [];
  const ntSetInfoCalls = [];
  let ntStatus = 0;
  const finalPaths = new Map([
    [42n, "\\\\?\\C:\\safe\\source.part"],
    [99n, "\\\\?\\C:\\safe"],
  ]);
  const stubs = new Map([
    ["CreateFileW", (...args) => { createCalls.push(args); return 42n; }],
    ["CreateDirectoryW", (...args) => { createDirectoryCalls.push(args); return 1; }],
    ["CloseHandle", () => 1],
    ["GetLastError", () => 0],
    ["SetFileInformationByHandle", (...args) => { setInfoCalls.push(args); return 1; }],
    ["SetFilePointerEx", (...args) => { seekCalls.push(args); return 1; }],
    ["SetEndOfFile", (...args) => { truncateCalls.push(args); return 1; }],
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
  assert.equal(api.finalPath(handle), "C:\\safe\\source.part");
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
  api.createDirectory("C:\\safe\\child");
  assert.deepEqual(createDirectoryCalls, [["\\\\?\\C:\\safe\\child", null]]);
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
  api.setFilePosition(42n, 7);
  api.truncateFile(42n, 3);
  assert.deepEqual(seekCalls, [[42n, 7n, null, 0], [42n, 3n, null, 0]]);
  assert.deepEqual(truncateCalls, [[42n]]);
  assert.throws(() => api.setFilePosition(42n, -1), /native_file_offset_invalid/u);
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
    "GetFileInformationByHandleEx", "GetFinalPathNameByHandleW", "GetSystemDirectoryW", "ReadFile", "WriteFile",
    "SetFilePointerEx", "SetEndOfFile",
    "FlushFileBuffers", "CreateDirectoryW", "SetFileInformationByHandle",
    "NtSetInformationFile", "RtlNtStatusToDosError",
  ]);
});

test("thin Win32 path prefixing accepts only canonical drive paths and counts UTF-16 units", () => {
  const created = [];
  const koffi = {
    load() {
      return {
        func(...definition) {
          const name = definition[1];
          if (name === "CreateDirectoryW") {
            return (exactPath) => { created.push(exactPath); return 1; };
          }
          return () => 1;
        },
      };
    },
    sizeof(type) { return type === "intptr_t" ? 8 : 4; },
  };
  const api = createWin32FileApi({ platform: "win32", koffi });

  for (const candidate of [
    "C:\\safe\\..\\escape",
    "C:\\safe\\.\\child",
    "C:\\safe\\\\child",
    "C:\\safe\\",
    "C:\\safe\\trailing.",
    "C:\\safe\\trailing ",
    "C:\\safe\\CON",
    "C:\\safe\\nul.txt",
    "C:\\safe\\COM1",
    "C:\\safe\\LPT9.log",
    "C:\\safe\\wild*card",
    "C:\\safe\\wild?card",
    "C:\\safe\\alternate:data",
    "C:\\safe\\control\u0001name",
    `C:\\safe\\${"x".repeat(256)}`,
    "C:/safe/child",
    "C:safe\\child",
    "\\\\server\\share\\child",
    "\\\\?\\C:\\safe\\child",
    "\\\\.\\C:\\safe\\child",
  ]) {
    assert.throws(() => api.createDirectory(candidate), /windows_path_(?:absolute_required|not_canonical)/u);
  }

  const maximumPath = `C:\\${[
    ...Array.from({ length: 127 }, () => "a".repeat(255)),
    "\ud83d\ude00".repeat(124),
  ].join("\\")}`;
  assert.equal(maximumPath.length, 32_763);
  api.createDirectory(maximumPath);
  assert.equal(created.at(-1).startsWith("\\\\?\\C:\\"), true);
  assert.equal(created.at(-1).length + 1, 32_768);

  assert.throws(
    () => api.createDirectory(`${maximumPath}a`),
    (error) => error?.code === "native_path_buffer_exceeded",
  );
});

test("native error 206 is reported as path-too-long rather than missing", () => {
  const koffi = {
    load() {
      return {
        func(...definition) {
          const name = definition[1];
          if (name === "CreateFileW") return () => -1n;
          if (name === "GetLastError") return () => 206;
          return () => 1;
        },
      };
    },
    sizeof(type) { return type === "intptr_t" ? 8 : 4; },
  };
  const api = createWin32FileApi({ platform: "win32", koffi });
  assert.throws(
    () => api.openPath("C:\\safe\\child", {
      access: ["read"], share: ["read"], disposition: "openExisting", directory: false,
    }),
    (error) => error?.code === "windows_path_too_long"
      && error?.nativeCode === 206
      && error?.operation === "CreateFileW",
  );
});

test("thin Win32 layer gets a strict system directory through GetSystemDirectoryW", () => {
  const bindings = [];
  const koffi = {
    load() {
      return {
        func(...definition) {
          const name = definition.length === 4 ? definition[1] : definition[0];
          bindings.push(name);
          if (name === "GetSystemDirectoryW") {
            return (output, capacity) => {
              const value = Buffer.from("C:\\Windows\\System32", "utf16le");
              assert.equal(capacity > value.length / 2, true);
              value.copy(output);
              return value.length / 2;
            };
          }
          return () => 1;
        },
      };
    },
    sizeof(type) { return type === "intptr_t" ? 8 : 4; },
  };
  const api = createWin32FileApi({ platform: "win32", koffi });
  assert.equal(api.getSystemDirectory(), "C:\\Windows\\System32");
  assert.equal(bindings.includes("GetSystemDirectoryW"), true);
});

test("GetSystemDirectoryW rejects native failure, buffer overflow, and noncanonical output", () => {
  function apiWithSystemDirectory(stub, lastError = 5) {
    return createWin32FileApi({
      platform: "win32",
      koffi: {
        load() {
          return {
            func(...definition) {
              const name = definition.length === 4 ? definition[1] : definition[0];
              if (name === "GetSystemDirectoryW") return stub;
              if (name === "GetLastError") return () => lastError;
              return () => 1;
            },
          };
        },
        sizeof(type) { return type === "intptr_t" ? 8 : 4; },
      },
    });
  }
  assert.throws(
    () => apiWithSystemDirectory(() => 0).getSystemDirectory(),
    (error) => error?.code === "access_denied" && error?.operation === "GetSystemDirectoryW",
  );
  assert.throws(
    () => apiWithSystemDirectory((_output, capacity) => capacity).getSystemDirectory(),
    /native_path_buffer_exceeded/u,
  );
  assert.throws(
    () => apiWithSystemDirectory((output) => {
      const value = Buffer.from("Windows\\System32", "utf16le");
      value.copy(output);
      return value.length / 2;
    }).getSystemDirectory(),
    /windows_system_directory_invalid/u,
  );
});

test("real Win32 system-directory query is isolated from process environment", {
  skip: process.platform !== "win32",
}, () => {
  const before = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH };
  const value = createWin32FileApi({ platform: "win32" }).getSystemDirectory();
  assert.match(value, /^[A-Za-z]:\\[^/]+/u);
  assert.equal(value.endsWith("\\"), false);
  assert.deepEqual({ SystemRoot: process.env.SystemRoot, PATH: process.env.PATH }, before);
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
