import assert from "node:assert/strict";
import test from "node:test";

import { createWin32FileApi } from "../desktop/software-manager/win32-file-api.mjs";
import { createWindowsFileCapabilities } from "../desktop/software-manager/windows-file-capabilities.mjs";

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
      const handle = { node, options, closed: false };
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
      nodes.delete(key(source.path));
      source.path = destination;
      nodes.set(key(destination), source);
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

test("thin Win32 layer binds only fixed Kernel32 APIs and opens no-follow with directory semantics", async () => {
  const bindings = [];
  const createCalls = [];
  const setInfoCalls = [];
  const stubs = new Map([
    ["CreateFileW", (...args) => { createCalls.push(args); return 42n; }],
    ["CloseHandle", () => 1],
    ["GetLastError", () => 0],
    ["SetFileInformationByHandle", (...args) => { setInfoCalls.push(args); return 1; }],
    ["GetFinalPathNameByHandleW", (_handle, output) => {
      const value = Buffer.from("C:\\safe", "utf16le");
      value.copy(output);
      return value.length / 2;
    }],
  ]);
  const koffi = {
    load(name) {
      assert.equal(name, "Kernel32.dll");
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
  await api.renameByHandle(42n, 99n, "target.lnk", { replace: false });
  await api.deleteByHandle(42n, { directory: false });
  assert.equal(setInfoCalls[0][1], 3);
  assert.equal(setInfoCalls[0][2].readUInt32LE(0), 0);
  assert.equal(setInfoCalls[0][2].readBigUInt64LE(8), 0n);
  const renameNameLength = setInfoCalls[0][2].readUInt32LE(16);
  assert.equal(
    setInfoCalls[0][2].subarray(20, 20 + renameNameLength).toString("utf16le"),
    "\\\\?\\C:\\safe\\target.lnk",
  );
  assert.equal(setInfoCalls[0][2].length, 24 + Buffer.byteLength("\\\\?\\C:\\safe\\target.lnk", "utf16le"));
  assert.equal(setInfoCalls[1][1], 4);
  assert.equal(bindings.every((definition) => definition[0] === "__stdcall"), true);
  assert.deepEqual(bindings.map((definition) => definition[1]), [
    "CreateFileW", "CloseHandle", "GetLastError", "GetFileInformationByHandle",
    "GetFileInformationByHandleEx", "GetFinalPathNameByHandleW", "ReadFile", "WriteFile",
    "FlushFileBuffers", "CreateDirectoryW", "SetFileInformationByHandle",
  ]);
});
