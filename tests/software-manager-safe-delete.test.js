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
  return {
    calls,
    fsApi: {
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
    },
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
      fsApi: { async lstat() { called = true; return directoryStat(); } },
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
      fsApi: {
        async lstat() { return stat; },
        async unlink() { mutated = true; },
        async rmdir() { mutated = true; },
      },
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
    fsApi: {
      async lstat(value) { return value === linkedChild ? fileStat({ link: true }) : directoryStat(); },
      async readdir() { return ["linked"]; },
      async unlink(value) { mutations.push(value); },
      async rmdir(value) { mutations.push(value); },
    },
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
    fsApi: {
      async lstat(value) { return value === authorizedRoot ? directoryStat({ link: true }) : directoryStat(); },
      async readdir() { return []; },
      async unlink(value) { mutations.push(value); },
      async rmdir(value) { mutations.push(value); },
    },
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
    fsApi: {
      async lstat(value) {
        if (value !== target && value !== authorizedRoot) childStatCalled = true;
        return directoryStat();
      },
      async readdir() { return ["..", "safe.txt"]; },
      async rmdir() { throw new Error("must not mutate"); },
    },
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
    fsApi: {
      async lstat() { return directoryStat(); },
      async readdir(value) {
        const relative = path.relative(target, value);
        const depth = relative === "" ? 0 : relative.split(path.sep).length;
        return depth < 66 ? [`level-${depth + 1}`] : [];
      },
      async unlink(value) { mutations.push(value); },
      async rmdir(value) { mutations.push(value); },
    },
  }), /depth/i);
  assert.deepEqual(mutations, []);
});
