import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import boundedFile from "../shared/bounded-local-file.cjs";
import safeImport from "../desktop/safe-import-file.cjs";
import { createWindowsPrivateAcl } from "../desktop/windows-private-acl.mjs";
import { buildProviderLogoCandidate, restoreCodexConfigFromBackup, saveProviderLogo } from "../desktop/settings.mjs";
import {
  authorizeDesktopPath, authorizeInstallRoot, authorizeSkillsRoot,
  revalidateFixedDirectoryCapability, revalidateInstallRootCapability,
} from "../desktop/software-manager/path-policy.mjs";

const ID_EVEN = 9_007_199_254_740_992n;
const ID_ODD = 9_007_199_254_740_993n;
const TIME_NS = 1_700_000_000_000_000_000n;
const pairs = [[ID_EVEN, ID_ODD], [ID_ODD, ID_EVEN]];

function fixture(content = "good", extension = ".txt") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-precise-file-"));
  const source = path.join(root, `source${extension}`);
  const replacement = path.join(root, `replacement${extension}`);
  fs.writeFileSync(source, content);
  fs.writeFileSync(replacement, "evil");
  return { root, source, replacement };
}

function identified(stat, id, options, timeNs = TIME_NS) {
  const precise = options?.bigint === true;
  const result = Object.create(Object.getPrototypeOf(stat), Object.getOwnPropertyDescriptors(stat));
  result.ino = precise ? id : Number(id);
  result.mtimeMs = precise ? timeNs / 1_000_000n : Number(timeNs) / 1_000_000;
  result.ctimeMs = result.mtimeMs;
  result.mtime = new Date(Number(timeNs / 1_000_000n));
  result.ctime = result.mtime;
  if (precise) {
    result.mtimeNs = timeNs;
    result.ctimeNs = timeNs;
  }
  return result;
}

function injectSyncOpen(t, source, replacement, checkedId, openedId, openedTime = TIME_NS, linkedAtCheck = Infinity) {
  const original = Object.fromEntries(["lstatSync", "openSync", "fstatSync", "readSync", "closeSync"]
    .map((name) => [name, fs[name]]));
  const counts = { read: 0, close: 0 };
  let checks = 0;
  let descriptor;
  t.after(() => Object.assign(fs, original));
  fs.lstatSync = (file, options) => {
    const stat = original.lstatSync(file, options);
    if (file !== source) return stat;
    const result = identified(stat, checkedId, options);
    if (++checks >= linkedAtCheck) result.nlink = options?.bigint ? 2n : 2;
    return result;
  };
  fs.openSync = (file, ...args) => {
    const fd = original.openSync(file === source ? replacement : file, ...args);
    if (file === source) descriptor = fd;
    return fd;
  };
  fs.fstatSync = (fd, options) => {
    const stat = original.fstatSync(fd, options);
    return fd === descriptor ? identified(stat, openedId, options, openedTime) : stat;
  };
  fs.readSync = (fd, ...args) => {
    if (fd === descriptor) counts.read++;
    return original.readSync(fd, ...args);
  };
  fs.closeSync = (fd) => {
    if (fd === descriptor) counts.close++;
    return original.closeSync(fd);
  };
  return counts;
}

function injectAsyncOpen(t, source, replacement, checkedId, openedId) {
  const originalLstat = fs.promises.lstat;
  const originalOpen = fs.promises.open;
  const counts = { read: 0, close: 0 };
  t.after(() => {
    fs.promises.lstat = originalLstat;
    fs.promises.open = originalOpen;
  });
  fs.promises.lstat = async (file, options) => {
    const stat = await originalLstat(file, options);
    return file === source ? identified(stat, checkedId, options) : stat;
  };
  fs.promises.open = async (file, ...args) => {
    const handle = await originalOpen(file === source ? replacement : file, ...args);
    if (file !== source) return handle;
    const stat = handle.stat.bind(handle);
    const read = handle.read.bind(handle);
    const close = handle.close.bind(handle);
    handle.stat = async (options) => identified(await stat(options), openedId, options);
    handle.read = (...readArgs) => { counts.read++; return read(...readArgs); };
    handle.close = (...closeArgs) => { counts.close++; return close(...closeArgs); };
    return handle;
  };
  return counts;
}

for (const mode of ["sync", "async"]) {
  const read = mode === "sync" ? boundedFile.readBoundedLocalFileSync : boundedFile.readBoundedLocalFile;
  for (const [checkedId, openedId] of pairs) {
    test(`${mode} bounded reader rejects distinct 64-bit file IDs ${checkedId}/${openedId}`, async (t) => {
      const { source, replacement } = fixture();
      assert.equal(Number(checkedId), Number(openedId), "the precision-loss condition must be present");
      const counts = mode === "sync"
        ? injectSyncOpen(t, source, replacement, checkedId, openedId)
        : injectAsyncOpen(t, source, replacement, checkedId, openedId);
      const operation = () => read(source, { maxBytes: 16 });
      if (mode === "sync") assert.throws(operation, { code: "bounded_local_file_changed" });
      else await assert.rejects(operation, { code: "bounded_local_file_changed" });
      assert.equal(counts.read, 0);
      assert.equal(counts.close, 1);
    });
  }

  test(`${mode} bounded reader accepts an unchanged large file ID`, async (t) => {
    const { source } = fixture("A中B");
    if (mode === "sync") injectSyncOpen(t, source, source, ID_ODD, ID_ODD);
    else injectAsyncOpen(t, source, source, ID_ODD, ID_ODD);
    const result = await read(source, { maxBytes: 5 });
    assert.equal(result.buffer.toString("utf8"), "A中B");
    assert.equal(result.size, 5);
    assert.equal(typeof result.size, "number");
  });

  for (const content of ["", "A中B"]) {
    test(`${mode} bounded reader preserves real bytes and numeric size for ${content ? "UTF-8" : "empty"} files`, async () => {
      const { source } = fixture(content);
      const result = await read(source, { maxBytes: 5 });
      assert.deepEqual(result.buffer, Buffer.from(content));
      assert.equal(result.size, Buffer.byteLength(content));
      assert.doesNotThrow(() => JSON.stringify(result));
    });
  }
  test(`${mode} bounded reader retains its size limit`, async () => {
    const { source } = fixture();
    const operation = () => read(source, { maxBytes: 3 });
    const check = (error) => error.code === "bounded_local_file_too_large" && error.actualBytes === 4;
    if (mode === "sync") assert.throws(operation, check);
    else await assert.rejects(operation, check);
  });
  test(`${mode} bounded reader still rejects directories`, async () => {
    const { root } = fixture();
    const operation = () => read(root, { maxBytes: 1024 });
    if (mode === "sync") assert.throws(operation, { code: "bounded_local_file_not_file" });
    else await assert.rejects(operation, { code: "bounded_local_file_not_file" });
  });
}

for (const [checkedId, openedId] of pairs) {
  test(`config import rejects rounded file ID collision ${checkedId}/${openedId}`, (t) => {
    const { source, replacement } = fixture();
    const counts = injectSyncOpen(t, source, replacement, checkedId, openedId);
    assert.throws(() => safeImport.readBoundedRegularUtf8File(source), { code: "CONFIG_PACKAGE_FILE_CHANGED" });
    assert.equal(counts.read, 0);
    assert.equal(counts.close, 1);
  });
}

for (const kind of ["install", "skills", "desktop"]) {
  for (const [firstId, nextId] of pairs) {
    test(`${kind} root authority rejects rounded directory ID collision ${firstId}/${nextId}`, async () => {
      let id = firstId;
      const resolvers = {
        realpath: async (value) => value,
        lstat: async (_value, options) => ({
          dev: options?.bigint ? 1n : 1, ino: options?.bigint ? id : Number(id),
          isDirectory: () => true, isSymbolicLink: () => false, isReparsePoint: () => false,
        }),
      };
      const capability = kind === "install"
        ? await authorizeInstallRoot({ candidate: "D:\\CBApps", env: {}, maxRelativePath: 180, access: async () => {}, ...resolvers })
        : kind === "skills"
          ? await authorizeSkillsRoot({ candidate: "C:\\Users\\fixture\\.codex\\skills", ...resolvers })
          : await authorizeDesktopPath({ getDesktopPath: () => "C:\\Users\\fixture\\Desktop", ...resolvers });
      id = nextId;
      await assert.rejects(kind === "install"
        ? revalidateInstallRootCapability(capability, { maxRelativePath: 180 })
        : revalidateFixedDirectoryCapability(capability), /identity_changed/);
    });
  }
}

function aclFixture({ firstId, nextId, nlink = 1 }) {
  const userSid = "S-1-5-21-111-222-333-1001";
  let reads = 0;
  let commands = 0;
  const acl = createWindowsPrivateAcl({
    platform: "win32", systemRoot: "C:\\Windows", tempDirectory: "C:\\fixture-temp", randomId: () => "precision",
    commandRunner: async (executable) => {
      commands++;
      return { stdout: Buffer.from(executable.endsWith("whoami.exe") ? `"DOMAIN\\User","${userSid}"` : ""), stderr: Buffer.alloc(0) };
    },
    fileOps: {
      lstat: async (_target, options) => {
        const id = reads++ === 0 ? firstId : nextId;
        return { dev: options?.bigint ? 1n : 1, ino: options?.bigint ? id : Number(id),
          nlink: options?.bigint ? BigInt(nlink) : nlink,
          isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
      },
      readFile: async () => `candidate.tmp\r\nD:PAI(A;;FA;;;BA)(A;;FA;;;SY)(A;;FA;;;${userSid})\r\n`,
      unlink: async () => {},
    },
  });
  return { acl, commandCount: () => commands };
}

for (const method of ["securePath", "verifyPath"]) {
  for (const [firstId, nextId] of pairs) {
    test(`ACL ${method} rejects rounded file ID collision ${firstId}/${nextId}`, async () => {
      const { acl } = aclFixture({ firstId, nextId });
      await assert.rejects(acl[method]("C:\\fixture\\candidate.tmp", { kind: "file" }), { code: "windows_private_acl_path_changed" });
    });
  }
  test(`ACL ${method} accepts an unchanged large ID`, async () => {
    const { acl } = aclFixture({ firstId: ID_ODD, nextId: ID_ODD });
    await acl[method]("C:\\fixture\\candidate.tmp", { kind: "file" });
  });
  test(`ACL ${method} still rejects hard links before any permission command`, async () => {
    const { acl, commandCount } = aclFixture({ firstId: ID_ODD, nextId: ID_ODD, nlink: 2 });
    await assert.rejects(acl[method]("C:\\fixture\\candidate.tmp", { kind: "file" }), { code: "windows_private_acl_invalid_path" });
    assert.equal(commandCount(), 0);
  });
}

for (const [checkedId, openedId] of pairs) {
  test(`provider logo reading rejects rounded file ID collision ${checkedId}/${openedId}`, (t) => {
    const { root, source, replacement } = fixture("good", ".png");
    injectSyncOpen(t, source, replacement, checkedId, openedId);
    assert.throws(() => buildProviderLogoCandidate(root, "precision", source), { code: "provider_logo_file_changed" });
  });
}

test("provider logo reading preserves sub-millisecond timestamp checks", (t) => {
  const { root, source } = fixture("good", ".png");
  injectSyncOpen(t, source, source, ID_ODD, ID_ODD, TIME_NS + 100_000n);
  assert.throws(() => buildProviderLogoCandidate(root, "precision", source), { code: "provider_logo_file_changed" });
});

test("provider logo reading accepts an unchanged large ID", (t) => {
  const { root, source } = fixture("good", ".png");
  injectSyncOpen(t, source, source, ID_ODD, ID_ODD);
  assert.deepEqual(buildProviderLogoCandidate(root, "precision", source).bytes, Buffer.from("good"));
});

for (const stage of ["before-commit", "after-commit"]) {
  for (const [firstId, nextId] of pairs) {
    test(`provider logo ${stage} detects rounded ID collision ${firstId}/${nextId}`, (t) => {
      const { root, source } = fixture("good", ".png");
      const target = path.join(root, "config", "provider-logos", "precision.png");
      const original = Object.fromEntries(["openSync", "fstatSync", "lstatSync", "renameSync"].map((name) => [name, fs[name]]));
      let temp;
      let descriptor;
      let renames = 0;
      t.after(() => Object.assign(fs, original));
      fs.openSync = (file, ...args) => {
        const fd = original.openSync(file, ...args);
        if (typeof file === "string" && path.dirname(file) === path.dirname(target) && file.endsWith(".tmp")) {
          temp = file;
          descriptor = fd;
        }
        return fd;
      };
      fs.fstatSync = (fd, options) => {
        const stat = original.fstatSync(fd, options);
        return fd === descriptor ? identified(stat, firstId, options) : stat;
      };
      fs.lstatSync = (file, options) => {
        const stat = original.lstatSync(file, options);
        if (file === temp) return identified(stat, stage === "before-commit" ? nextId : firstId, options);
        if (file === target) return identified(stat, nextId, options);
        return stat;
      };
      fs.renameSync = (from, to) => {
        if (from === temp && to === target) renames++;
        return original.renameSync(from, to);
      };
      assert.throws(() => saveProviderLogo(root, "precision", source), { code: "provider_logo_file_changed" });
      assert.equal(renames, stage === "before-commit" ? 0 : 1);
    });
  }
}

function restoreFixture() {
  const { root } = fixture();
  const directory = path.join(root, ".codex");
  fs.mkdirSync(directory);
  const target = path.join(directory, "config.toml");
  const backup = path.join(directory, "config.toml.codexbridge.precision.bak");
  const replacement = path.join(root, "different-backup.toml");
  fs.writeFileSync(target, 'model = "current"\n');
  fs.writeFileSync(backup, 'model = "good"\n');
  fs.writeFileSync(replacement, 'model = "evil"\n');
  let prepared;
  const coordinator = {
    async runTransaction({ prepare }) {
      prepared = await prepare();
      return { value: prepared.value, configRevision: "precision-fixture" };
    },
  };
  return { root, directory, target, backup, replacement, coordinator, plan: () => prepared };
}

for (const [checkedId, openedId] of pairs) {
  test(`Codex restore reading rejects rounded file ID collision ${checkedId}/${openedId}`, async (t) => {
    const item = restoreFixture();
    const counts = injectSyncOpen(t, item.backup, item.replacement, checkedId, openedId);
    await assert.rejects(restoreCodexConfigFromBackup(item.backup, { homeDir: item.root, coordinator: item.coordinator }), /source changed/);
    assert.equal(counts.read, 0);
    assert.equal(counts.close, 1);
  });
  test(`Codex restore rejects rounded parent directory ID collision ${checkedId}/${openedId}`, async (t) => {
    const item = restoreFixture();
    const original = fs.lstatSync;
    let checked = false;
    t.after(() => { fs.lstatSync = original; });
    fs.lstatSync = (file, options) => {
      const stat = original(file, options);
      if (file !== item.directory) return stat;
      const result = identified(stat, checked ? openedId : checkedId, options);
      checked = true;
      return result;
    };
    await assert.rejects(restoreCodexConfigFromBackup(item.backup, { homeDir: item.root, coordinator: item.coordinator }), /source changed/);
  });
}

test("Codex restore preserves sub-millisecond timestamp checks", async (t) => {
  const item = restoreFixture();
  injectSyncOpen(t, item.backup, item.backup, ID_ODD, ID_ODD, TIME_NS + 100_000n);
  await assert.rejects(restoreCodexConfigFromBackup(item.backup, { homeDir: item.root, coordinator: item.coordinator }), /source changed/);
});

test("Codex restore still rejects hard links appearing after its backup listing", async (t) => {
  const item = restoreFixture();
  const counts = injectSyncOpen(t, item.backup, item.backup, ID_ODD, ID_ODD, TIME_NS, 3);
  await assert.rejects(restoreCodexConfigFromBackup(item.backup, { homeDir: item.root, coordinator: item.coordinator }), /bounded regular file/);
  assert.equal(counts.read, 0);
});

test("Codex restore accepts stable large IDs without exposing BigInt in its result", async (t) => {
  const item = restoreFixture();
  injectSyncOpen(t, item.backup, item.backup, ID_ODD, ID_ODD);
  const result = await restoreCodexConfigFromBackup(item.backup, { homeDir: item.root, coordinator: item.coordinator });
  assert.equal(result.configRevision, "precision-fixture");
  assert.deepEqual(item.plan().entries.find((entry) => entry.id === "codexConfig").content, Buffer.from('model = "good"\n'));
  assert.doesNotThrow(() => JSON.stringify(result));
});
