import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { deleteAuthorizedTree } from "../desktop/software-manager/safe-delete.mjs";

function directoryStat({ link = false, reparse = false } = {}) {
  return {
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => link,
    isReparsePoint: () => reparse,
  };
}

function fileStat({ link = false, reparse = false } = {}) {
  return {
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => link,
    isReparsePoint: () => reparse,
  };
}

function noFollowAdapter(legacy) {
  function rejectUnsafe(stat) {
    if (stat.isSymbolicLink?.() || stat.isReparsePoint?.()) throw new Error("reparse_link_rejected");
  }

  async function directoryHandle(exactDirectory) {
    return {
      async listChildren() { return legacy.readdir(exactDirectory); },
      async openChildNoFollow(name) {
        const exact = path.join(exactDirectory, name);
        const stat = await legacy.lstat(exact);
        rejectUnsafe(stat);
        if (stat.isFile?.()) return { exact, kind: "file", name };
        if (!stat.isDirectory?.()) throw new Error("unsupported_file_type");
        return { exact, handle: await directoryHandle(exact), kind: "directory", name };
      },
      async unlinkChildNoFollow(descriptor) { return legacy.unlink(descriptor.exact); },
      async rmdirChildNoFollow(descriptor) { return legacy.rmdir(descriptor.exact); },
      async close() {},
    };
  }

  return {
    async openDirectoryNoFollow(root) {
      const stat = await legacy.lstat(root);
      rejectUnsafe(stat);
      if (!stat.isDirectory?.()) throw new Error("authorized_root_invalid");
      return directoryHandle(root);
    },
  };
}

function fakeTree(root, authorizedRoot) {
  const childDir = path.join(root, "nested");
  const firstFile = path.join(root, "one.txt");
  const secondFile = path.join(childDir, "two.txt");
  const calls = [];
  const nodes = new Map([
    [authorizedRoot, { stat: directoryStat(), children: [path.basename(root)] }],
    [root, { stat: directoryStat(), children: ["nested", "one.txt"] }],
    [childDir, { stat: directoryStat(), children: ["two.txt"] }],
    [firstFile, { stat: fileStat() }],
    [secondFile, { stat: fileStat() }],
  ]);
  const legacy = {
      async lstat(target) {
        calls.push(["lstat", target]);
        const node = nodes.get(target);
        if (!node) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return node.stat;
      },
      async readdir(target) {
        calls.push(["readdir", target]);
        return [...nodes.get(target).children];
      },
      async unlink(target) {
        calls.push(["unlink", target]);
        nodes.delete(target);
      },
      async rmdir(target) {
        calls.push(["rmdir", target]);
        nodes.delete(target);
      },
      async rm() { throw new Error("recursive rm must never be called"); },
      async exec() { throw new Error("shell deletion must never be called"); },
    };
  return {
    calls,
    fsApi: noFollowAdapter(legacy),
    paths: { childDir, firstFile, secondFile },
  };
}

test("deletes each exact file before removing only emptied directories", async () => {
  const authorizedRoot = path.resolve("sandbox", "owned");
  const target = path.join(authorizedRoot, "component");
  const { calls, fsApi, paths } = fakeTree(target, authorizedRoot);

  await deleteAuthorizedTree({ target, authorizedRoot, fsApi });

  const mutations = calls.filter(([operation]) => operation === "unlink" || operation === "rmdir");
  assert.deepEqual(mutations, [
    ["unlink", paths.secondFile],
    ["rmdir", paths.childDir],
    ["unlink", paths.firstFile],
    ["rmdir", target],
  ]);
});

for (const targetFactory of [
  (root) => root,
  (root) => `${root}-sibling`,
  (root) => `${root}${path.sep}child${path.sep}..${path.sep}component`,
]) {
  test("rejects roots, sibling prefixes, and parent traversal before walking", async () => {
    const authorizedRoot = path.resolve("sandbox", "owned");
    let called = false;
    await assert.rejects(deleteAuthorizedTree({
      target: targetFactory(authorizedRoot),
      authorizedRoot,
      fsApi: { async openDirectoryNoFollow() { called = true; } },
    }), /authorized|traversal/i);
    assert.equal(called, false);
  });
}

for (const stat of [
  { isDirectory: () => false, isFile: () => false, isSymbolicLink: () => true },
  { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, isReparsePoint: () => true },
]) {
  test("rejects links and reparse points without deleting them", async () => {
    const authorizedRoot = path.resolve("sandbox", "owned");
    const target = path.join(authorizedRoot, "component");
    let mutated = false;
    await assert.rejects(deleteAuthorizedTree({
      target,
      authorizedRoot,
      fsApi: noFollowAdapter({
        async lstat(value) { return value === authorizedRoot ? directoryStat() : stat; },
        async readdir() { return []; },
        async unlink() { mutated = true; },
        async rmdir() { mutated = true; },
      }),
    }), /reparse|link/i);
    assert.equal(mutated, false);
  });
}

test("rejects a linked child discovered during the walk", async () => {
  const authorizedRoot = path.resolve("sandbox", "owned");
  const target = path.join(authorizedRoot, "component");
  const linkedChild = path.join(target, "linked");
  const mutations = [];
  await assert.rejects(deleteAuthorizedTree({
    target,
    authorizedRoot,
    fsApi: noFollowAdapter({
      async lstat(value) { return value === linkedChild ? fileStat({ link: true }) : directoryStat(); },
      async readdir() { return ["linked"]; },
      async unlink(value) { mutations.push(value); },
      async rmdir(value) { mutations.push(value); },
    }),
  }), /reparse|link/i);
  assert.deepEqual(mutations, []);
});

test("rejects a linked authorized root before walking its child", async () => {
  const authorizedRoot = path.resolve("sandbox", "owned");
  const target = path.join(authorizedRoot, "component");
  const mutations = [];
  await assert.rejects(deleteAuthorizedTree({
    target,
    authorizedRoot,
    fsApi: noFollowAdapter({
      async lstat(value) { return value === authorizedRoot ? directoryStat({ link: true }) : directoryStat(); },
      async readdir() { return []; },
      async unlink(value) { mutations.push(value); },
      async rmdir(value) { mutations.push(value); },
    }),
  }), /reparse|link/i);
  assert.deepEqual(mutations, []);
});

test("rejects malicious child names returned by the filesystem", async () => {
  const authorizedRoot = path.resolve("sandbox", "owned");
  const target = path.join(authorizedRoot, "component");
  let childStatCalled = false;
  await assert.rejects(deleteAuthorizedTree({
    target,
    authorizedRoot,
    fsApi: noFollowAdapter({
      async lstat(value) {
        if (value !== target && value !== authorizedRoot) childStatCalled = true;
        return directoryStat();
      },
      async readdir() { return ["..", "safe.txt"]; },
      async unlink() { throw new Error("must not mutate"); },
      async rmdir() { throw new Error("must not mutate"); },
    }),
  }), /authorized|entry|traversal/i);
  assert.equal(childStatCalled, false);
});

test("bounds the depth-first walk before deleting an unexpectedly deep tree", async () => {
  const authorizedRoot = path.resolve("sandbox", "owned");
  const target = path.join(authorizedRoot, "component");
  const mutations = [];
  await assert.rejects(deleteAuthorizedTree({
    target,
    authorizedRoot,
    fsApi: noFollowAdapter({
      async lstat() { return directoryStat(); },
      async readdir(value) {
        const relative = path.relative(target, value);
        const depth = relative === "" ? 0 : relative.split(path.sep).length;
        return depth < 66 ? [`level-${depth + 1}`] : [];
      },
      async unlink(value) { mutations.push(value); },
      async rmdir(value) { mutations.push(value); },
    }),
  }), /depth/i);
  assert.deepEqual(mutations, []);
});

test("fails closed when fsApi cannot provide stable no-follow handles", async () => {
  const authorizedRoot = path.resolve("sandbox", "owned");
  let inspected = false;
  await assert.rejects(deleteAuthorizedTree({
    target: path.join(authorizedRoot, "component"),
    authorizedRoot,
    fsApi: { async lstat() { inspected = true; return directoryStat(); } },
  }), /no.follow|capability/i);
  assert.equal(inspected, false);
});

test("does not traverse an external tree when a directory entry is replaced after stable open", async () => {
  const authorizedRoot = path.resolve("sandbox", "owned");
  const target = path.join(authorizedRoot, "component");
  let externalTouched = false;
  let originalTouched = false;
  let replaced = false;
  const targetHandle = {
    async listChildren() { return ["inside.txt"]; },
    async openChildNoFollow(name) { return { identity: "original-file", kind: "file", name }; },
    async unlinkChildNoFollow(descriptor) {
      assert.equal(descriptor.identity, "original-file");
      originalTouched = true;
    },
    async rmdirChildNoFollow() { externalTouched = true; },
    async close() {},
  };
  const rootHandle = {
    async listChildren() { return ["component"]; },
    async openChildNoFollow(name) {
      const descriptor = { handle: targetHandle, identity: "original-directory", kind: "directory", name };
      replaced = true;
      return descriptor;
    },
    async unlinkChildNoFollow() { externalTouched = true; },
    async rmdirChildNoFollow(descriptor) {
      assert.equal(descriptor.identity, "original-directory");
      originalTouched = true;
    },
    async close() {},
  };
  await deleteAuthorizedTree({
    target,
    authorizedRoot,
    fsApi: {
      async openDirectoryNoFollow() { return rootHandle; },
    },
  });
  assert.equal(replaced, true);
  assert.equal(originalTouched, true);
  assert.equal(externalTouched, false);
});
