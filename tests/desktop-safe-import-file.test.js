import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  MAX_CONFIG_PACKAGE_IMPORT_BYTES,
  readBoundedRegularUtf8File,
} = require("../desktop/safe-import-file.cjs");

test("an oversized import is rejected before the file is opened", () => {
  let opened = false;
  const fsImpl = {
    lstatSync: () => regularStat({ size: MAX_CONFIG_PACKAGE_IMPORT_BYTES + 1 }),
    openSync: () => {
      opened = true;
      return 1;
    },
  };

  assert.throws(
    () => readBoundedRegularUtf8File("synthetic.json", { fsImpl }),
    /too large/i,
  );
  assert.equal(opened, false);
});

test("symlinks and hardlinks are rejected before import bytes are read", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-safe-import-"));
  const source = path.join(root, "source.json");
  const hardlink = path.join(root, "hardlink.json");
  const symlink = path.join(root, "symlink.json");
  fs.writeFileSync(source, '{"version":1}', "utf8");
  fs.linkSync(source, hardlink);
  fs.symlinkSync(source, symlink, "file");
  try {
    assert.throws(() => readBoundedRegularUtf8File(hardlink), /single-link regular file/i);
    assert.throws(() => readBoundedRegularUtf8File(symlink), /single-link regular file/i);
  } finally {
    fs.unlinkSync(symlink);
    fs.unlinkSync(hardlink);
    fs.unlinkSync(source);
    fs.rmdirSync(root);
  }
});

test("the opened handle must match the checked file identity", () => {
  const fsImpl = {
    lstatSync: () => regularStat({ dev: 1, ino: 2, size: 2 }),
    openSync: () => 7,
    fstatSync: () => regularStat({ dev: 1, ino: 3, size: 2 }),
    closeSync: () => {},
  };

  assert.throws(
    () => readBoundedRegularUtf8File("synthetic.json", { fsImpl }),
    /changed before it could be read/i,
  );
});

test("a stable bounded regular file is read exactly as UTF-8", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-safe-import-ok-"));
  const target = path.join(root, "package.json");
  const content = '{"version":1,"name":"配置包"}';
  fs.writeFileSync(target, content, "utf8");
  try {
    assert.equal(readBoundedRegularUtf8File(target), content);
  } finally {
    fs.unlinkSync(target);
    fs.rmdirSync(root);
  }
});

function regularStat({ dev = 1, ino = 1, size = 0, nlink = 1 } = {}) {
  return {
    dev,
    ino,
    size,
    nlink,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}
