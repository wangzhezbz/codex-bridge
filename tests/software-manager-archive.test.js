import test, { after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { Writable } from "node:stream";

import { createArchiveService } from "../desktop/software-manager/archive-service.mjs";

const fixtureFiles = [];
const fixtureDirectories = [];
const SEVEN_ZIP_PATH = path.resolve("test-bin", "7za.exe");

after(async () => {
  for (const file of fixtureFiles) {
    await fs.unlink(file).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  for (const directory of fixtureDirectories.reverse()) {
    await fs.rmdir(directory).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
});

test("inspects a normal ZIP and reports normalized policy metadata", async () => {
  const archivePath = await writeZipFixture([
    { name: "app/", directory: true },
    { name: "app/readme.txt", body: "hello" },
    { name: "bin\\tool.exe", body: "tool" },
  ]);

  const result = await zipService().inspectArchive({ format: "zip", archivePath });

  assert.deepEqual(result.entries, [
    { path: "app", size: 0, directory: true },
    { path: "app/readme.txt", size: 5, directory: false },
    { path: "bin/tool.exe", size: 4, directory: false },
  ]);
  assert.equal(result.maxRelativePath, "app/readme.txt".length);
  assert.equal(result.totalUnpackedBytes, 9);
});

test("extracts ZIP bytes only after every entry passes preflight", async () => {
  const archivePath = await writeZipFixture([
    { name: "app/readme.txt", body: "hello" },
    { name: "app/config.json", body: "{}" },
  ]);
  const destination = path.resolve("staging", "zip-ok");
  const memory = memoryDestination(destination);
  const service = zipService(memory.fsApi);

  const result = await service.extractArchive({ format: "zip", archivePath, destination });

  assert.equal(result.totalUnpackedBytes, 7);
  assert.equal(memory.files.get("app/readme.txt"), "hello");
  assert.equal(memory.files.get("app/config.json"), "{}");
  assert.equal(memory.closed, true);
});

test("does not open a ZIP output file when a later entry is unsafe", async () => {
  const archivePath = await writeZipFixture([
    { name: "safe.txt", body: "would otherwise be written" },
    { name: "safe/../../outside.txt", body: "x" },
  ]);
  const destination = path.resolve("staging", "zip-preflight");
  const memory = memoryDestination(destination);

  await assert.rejects(
    zipService(memory.fsApi).extractArchive({ format: "zip", archivePath, destination }),
    /archive_path_escape/,
  );
  assert.equal(memory.openDestinationCalls, 0);
  assert.equal(memory.createFileCalls, 0);
});

for (const [label, name] of [
  ["absolute paths", "/outside.txt"],
  ["drive paths", "C:\\outside.txt"],
  ["parent traversal", "safe/../outside.txt"],
  ["backslash traversal", "safe\\..\\..\\outside.txt"],
]) {
  test(`rejects ZIP ${label}`, async () => {
    const archivePath = await writeZipFixture([{ name, body: "x" }]);
    await assert.rejects(zipService().inspectArchive({ format: "zip", archivePath }), /archive_path_escape/);
  });
}

test("rejects duplicate normalized ZIP names", async () => {
  const archivePath = await writeZipFixture([
    { name: "App/readme.txt", body: "one" },
    { name: "app\\README.txt", body: "two" },
  ]);
  await assert.rejects(zipService().inspectArchive({ format: "zip", archivePath }), /archive_duplicate_path/);
});

test("rejects a ZIP file that conflicts with a descendant path", async () => {
  const archivePath = await writeZipFixture([
    { name: "app/tool.exe", body: "tool" },
    { name: "app", body: "not a directory" },
  ]);
  await assert.rejects(zipService().inspectArchive({ format: "zip", archivePath }), /archive_path_conflict/);
});

test("rejects encrypted or unsupported ZIP entries during preflight", async (t) => {
  await t.test("encrypted", async () => {
    const archivePath = await writeZipFixture([{ name: "secret.txt", body: "x", flags: 0x801, method: 8 }]);
    await assert.rejects(zipService().inspectArchive({ format: "zip", archivePath }), /archive_encrypted_entry_rejected/);
  });

  await t.test("unsupported compression", async () => {
    const archivePath = await writeZipFixture([{ name: "odd.bin", body: "x", method: 99 }]);
    await assert.rejects(zipService().inspectArchive({ format: "zip", archivePath }), /archive_compression_rejected/);
  });
});

test("rejects ZIP symlink metadata", async () => {
  const archivePath = await writeZipFixture([
    { name: "link", body: "target", externalAttributes: (0o120777 << 16) >>> 0, hostSystem: 3 },
  ]);
  await assert.rejects(zipService().inspectArchive({ format: "zip", archivePath }), /archive_link_rejected/);
});

test("rejects ZIP reparse-point metadata", async () => {
  const archivePath = await writeZipFixture([
    { name: "junction", body: "target", externalAttributes: 0x400, hostSystem: 0 },
  ]);
  await assert.rejects(zipService().inspectArchive({ format: "zip", archivePath }), /archive_link_rejected/);
});

test("rejects a ZIP entry-count bomb", async () => {
  const entries = Array.from({ length: 4_097 }, (_, index) => ({ name: `files/${index}.txt`, body: "" }));
  const archivePath = await writeZipFixture(entries);
  await assert.rejects(zipService().inspectArchive({ format: "zip", archivePath }), /archive_entry_count_exceeded/);
});

test("rejects a ZIP declared unpacked-size bomb", async () => {
  const archivePath = await writeZipFixture(Array.from({ length: 5 }, (_, index) => ({
    name: `huge/${index}.bin`,
    body: "",
    declaredSize: 0xffff_ffff,
  })));
  await assert.rejects(zipService().inspectArchive({ format: "zip", archivePath }), /archive_unpacked_size_exceeded/);
});

test("cancellation before ZIP extraction opens neither archive destination nor output", async () => {
  const archivePath = await writeZipFixture([{ name: "safe.txt", body: "x" }]);
  const destination = path.resolve("staging", "zip-cancelled");
  const memory = memoryDestination(destination);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    zipService(memory.fsApi).extractArchive({ format: "zip", archivePath, destination, signal: controller.signal }),
    (error) => error?.name === "AbortError",
  );
  assert.equal(memory.openDestinationCalls, 0);
  assert.equal(memory.createFileCalls, 0);
});

test("lists a normal 7z with the fixed bundled executable command", async () => {
  const fake = fakeSevenZip({ listing: sevenZipListing([
    { path: "app", size: 0, attributes: "D" },
    { path: "app/tool.exe", size: 12, attributes: "A" },
  ]) });
  const service = createArchiveService({ sevenZipPath: SEVEN_ZIP_PATH, spawnFile: fake.spawnFile, fsApi: {} });

  const result = await service.inspectArchive({ format: "7z", archivePath: path.resolve("packages", "tool.7z") });

  assert.deepEqual(result.entries, [
    { path: "app", size: 0, directory: true },
    { path: "app/tool.exe", size: 12, directory: false },
  ]);
  assert.deepEqual(fake.calls[0].args, ["l", "-slt", "-ba", "--", path.resolve("packages", "tool.7z")]);
  assert.equal(fake.calls[0].file, SEVEN_ZIP_PATH);
  assert.equal(fake.calls[0].options.shell, false);
});

test("extracts 7z only with fixed arguments and no-follow capability verification", async () => {
  const archivePath = path.resolve("packages", "tool.7z");
  const destination = path.resolve("staging", "seven-ok");
  const fake = fakeSevenZip({ listing: sevenZipListing([{ path: "app/tool.exe", size: 12, attributes: "A" }]) });
  const memory = memoryDestination(destination, {
    verifiedTree: [{ path: "app/tool.exe", realPath: path.join(destination, "app", "tool.exe"), directory: false }],
  });
  const service = createArchiveService({ sevenZipPath: SEVEN_ZIP_PATH, spawnFile: fake.spawnFile, fsApi: memory.fsApi });

  const result = await service.extractArchive({ format: "7z", archivePath, destination });

  assert.equal(result.totalUnpackedBytes, 12);
  assert.deepEqual(fake.calls.map((call) => call.args), [
    ["l", "-slt", "-ba", "--", archivePath],
    ["x", "-y", `-o${destination}`, "--", archivePath],
  ]);
  assert.equal(fake.calls.every((call) => call.file === SEVEN_ZIP_PATH && call.options.shell === false), true);
  assert.equal(memory.archiveStableChecks, 3);
  assert.equal(memory.assertEmptyCalls, 1);
  assert.equal(memory.verifyTreeCalls, 1);
  assert.equal(memory.archivePinClosed, true);
  assert.equal(memory.closed, true);
});

test("rejects unsafe 7z listing before invoking extraction", async () => {
  const archivePath = path.resolve("packages", "bad.7z");
  const fake = fakeSevenZip({ listing: sevenZipListing([{ path: "safe\\..\\outside.txt", size: 1, attributes: "A" }]) });
  const memory = memoryDestination(path.resolve("staging", "seven-bad"));
  const service = createArchiveService({ sevenZipPath: SEVEN_ZIP_PATH, spawnFile: fake.spawnFile, fsApi: memory.fsApi });

  await assert.rejects(service.extractArchive({ format: "7z", archivePath, destination: memory.destination }), /archive_path_escape/);
  assert.equal(fake.calls.length, 1);
  assert.equal(memory.openDestinationCalls, 0);
});

test("rejects 7z symlink and reparse metadata", async () => {
  const fake = fakeSevenZip({ listing: [
    "Path = app/link",
    "Size = 3",
    "Attributes = A_ lrwxrwxrwx",
    "Symbolic Link = ../outside",
    "",
  ].join("\r\n") });
  const service = createArchiveService({ sevenZipPath: SEVEN_ZIP_PATH, spawnFile: fake.spawnFile, fsApi: {} });
  await assert.rejects(
    service.inspectArchive({ format: "7z", archivePath: path.resolve("packages", "link.7z") }),
    /archive_link_rejected/,
  );
});

test("rejects 7z entry-count and declared-size bombs", async (t) => {
  await t.test("entry count", async () => {
    const listing = sevenZipListing(Array.from({ length: 4_097 }, (_, index) => ({
      path: `files/${index}.txt`, size: 0, attributes: "A",
    })));
    const fake = fakeSevenZip({ listing });
    const service = createArchiveService({ sevenZipPath: SEVEN_ZIP_PATH, spawnFile: fake.spawnFile, fsApi: {} });
    await assert.rejects(
      service.inspectArchive({ format: "7z", archivePath: path.resolve("packages", "many.7z") }),
      /archive_entry_count_exceeded/,
    );
  });

  await t.test("unpacked size", async () => {
    const listing = sevenZipListing(Array.from({ length: 5 }, (_, index) => ({
      path: `huge/${index}.bin`, size: 0xffff_ffff, attributes: "A",
    })));
    const fake = fakeSevenZip({ listing });
    const service = createArchiveService({ sevenZipPath: SEVEN_ZIP_PATH, spawnFile: fake.spawnFile, fsApi: {} });
    await assert.rejects(
      service.inspectArchive({ format: "7z", archivePath: path.resolve("packages", "huge.7z") }),
      /archive_unpacked_size_exceeded/,
    );
  });
});

test("cancellation before 7z extraction does not spawn any process", async () => {
  const fake = fakeSevenZip({ listing: "" });
  const controller = new AbortController();
  controller.abort();
  const service = createArchiveService({ sevenZipPath: SEVEN_ZIP_PATH, spawnFile: fake.spawnFile, fsApi: {} });

  await assert.rejects(service.extractArchive({
    format: "7z",
    archivePath: path.resolve("packages", "cancel.7z"),
    destination: path.resolve("staging", "cancel"),
    signal: controller.signal,
  }), (error) => error?.name === "AbortError");
  assert.equal(fake.calls.length, 0);
});

test("rejects a post-7z no-follow tree report that escapes destination", async () => {
  const archivePath = path.resolve("packages", "escape.7z");
  const destination = path.resolve("staging", "seven-escape");
  const fake = fakeSevenZip({ listing: sevenZipListing([{ path: "app/tool.exe", size: 1, attributes: "A" }]) });
  const memory = memoryDestination(destination, {
    verifiedTree: [{ path: "app/tool.exe", realPath: path.resolve("outside", "tool.exe"), directory: false }],
  });
  const service = createArchiveService({ sevenZipPath: SEVEN_ZIP_PATH, spawnFile: fake.spawnFile, fsApi: memory.fsApi });

  await assert.rejects(service.extractArchive({ format: "7z", archivePath, destination }), /archive_output_escape/);
});

test("fails closed when extraction lacks stable no-follow capabilities", async (t) => {
  const zipPath = await writeZipFixture([{ name: "safe.txt", body: "x" }]);
  await t.test("ZIP destination", async () => {
    await assert.rejects(zipService({}).extractArchive({
      format: "zip", archivePath: zipPath, destination: path.resolve("staging", "missing-zip-capability"),
    }), /archive_no_follow_capability_required/);
  });

  await t.test("7z archive pin", async () => {
    const fake = fakeSevenZip({ listing: sevenZipListing([{ path: "safe.txt", size: 1, attributes: "A" }]) });
    const service = createArchiveService({
      sevenZipPath: SEVEN_ZIP_PATH,
      spawnFile: fake.spawnFile,
      fsApi: { async openArchiveDestinationNoFollow() { return memoryDestination("unused").root; } },
    });
    await assert.rejects(service.extractArchive({
      format: "7z",
      archivePath: path.resolve("packages", "missing-pin.7z"),
      destination: path.resolve("staging", "missing-pin"),
    }), /archive_no_follow_capability_required/);
  });
});

function zipService(fsApi = {}) {
  return createArchiveService({
    sevenZipPath: SEVEN_ZIP_PATH,
    spawnFile: async () => {
      throw new Error("7z must not run for ZIP tests");
    },
    fsApi,
  });
}

function fakeSevenZip({ listing }) {
  const calls = [];
  return {
    calls,
    async spawnFile(file, args, options) {
      calls.push({ file, args: [...args], options: { ...options } });
      return args[0] === "l"
        ? { exitCode: 0, stdout: listing, stderr: "" }
        : { exitCode: 0, stdout: "Everything is Ok", stderr: "" };
    },
  };
}

function sevenZipListing(entries) {
  return entries.map((entry) => [
    `Path = ${entry.path}`,
    `Size = ${entry.size}`,
    `Packed Size = ${entry.size}`,
    `Attributes = ${entry.attributes}`,
    "CRC = 00000000",
  ].join("\r\n")).join("\r\n\r\n");
}

function memoryDestination(destination, { verifiedTree = [] } = {}) {
  const files = new Map();
  const directories = new Set();
  const state = {
    destination,
    files,
    directories,
    openDestinationCalls: 0,
    createFileCalls: 0,
    assertEmptyCalls: 0,
    verifyTreeCalls: 0,
    archiveStableChecks: 0,
    archivePinClosed: false,
    closed: false,
  };
  const root = {
    async ensureDirectoryPathNoFollow(segments) {
      directories.add(segments.join("/"));
    },
    async createFilePathNoFollow(segments) {
      state.createFileCalls += 1;
      const relative = segments.join("/");
      const chunks = [];
      return new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
        final(callback) {
          files.set(relative, Buffer.concat(chunks).toString("utf8"));
          callback();
        },
      });
    },
    async assertEmptyNoFollow() {
      state.assertEmptyCalls += 1;
    },
    async verifyTreeNoFollow() {
      state.verifyTreeCalls += 1;
      return verifiedTree;
    },
    async close() {
      state.closed = true;
    },
  };
  state.root = root;
  state.fsApi = {
    async openArchiveDestinationNoFollow(exactDestination) {
      state.openDestinationCalls += 1;
      assert.equal(exactDestination, destination);
      return root;
    },
    async pinArchiveFileNoFollow() {
      return {
        async assertStableNoFollow() {
          state.archiveStableChecks += 1;
        },
        async close() {
          state.archivePinClosed = true;
        },
      };
    },
  };
  return state;
}

async function writeZipFixture(entries) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexbridge-archive-"));
  const archivePath = path.join(directory, "fixture.zip");
  fixtureDirectories.push(directory);
  fixtureFiles.push(archivePath);
  await fs.writeFile(archivePath, buildZip(entries));
  return archivePath;
}

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const spec of entries) {
    const name = Buffer.from(spec.name, "utf8");
    const body = Buffer.from(spec.body ?? "", "utf8");
    const directory = spec.directory === true || /[\\/]$/u.test(spec.name);
    const declaredSize = spec.declaredSize ?? body.length;
    const method = spec.method ?? (declaredSize === body.length ? 0 : 8);
    const flags = spec.flags ?? 0x800;
    const crc = crc32(body);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local, body);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(((spec.hostSystem ?? 0) << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(spec.externalAttributes ?? (directory ? 0x10 : 0), 38);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length + body.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function crc32(buffer) {
  let crc = 0xffff_ffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}
