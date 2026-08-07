import test, { after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { Readable, Writable } from "node:stream";

import { createArchiveService } from "../desktop/software-manager/archive-service.mjs";

const fixtureFiles = [];
const fixtureDirectories = [];
const SEVEN_ZIP_PATH = path.resolve("test-bin", "7za.exe");
const DESTINATION_IDENTITY = Object.freeze({ volumeSerial: "test", fileId: "destination" });

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

  const result = await service.extractArchive({
    format: "zip", archivePath, destination, destinationIdentity: DESTINATION_IDENTITY,
  });

  assert.equal(result.totalUnpackedBytes, 7);
  assert.equal(memory.files.get("app/readme.txt"), "hello");
  assert.equal(memory.files.get("app/config.json"), "{}");
  assert.equal(memory.verifyTreeCalls, 1);
  assert.equal(memory.closed, true);
});

test("verified extraction returns the opaque version receipt and manifest digest from the capability", async () => {
  const archivePath = await writeZipFixture([{ name: "app.exe", body: "payload" }]);
  const destination = path.resolve("staging", "zip-receipt");
  const verificationReceipt = Object.freeze(Object.create(null));
  const memory = memoryDestination(destination, {
    receiptResult: {
      verificationReceipt,
      treeDigest: "a".repeat(64),
      manifestDigest: "b".repeat(64),
    },
  });

  const result = await zipService(memory.fsApi).extractArchive({
    format: "zip",
    archivePath,
    destination,
    destinationIdentity: { volumeSerial: "test", fileId: "destination" },
    verification: { componentId: "chatgpt", version: "1.0.0" },
  });

  assert.equal(result.verificationReceipt, verificationReceipt);
  assert.equal(result.treeDigest, "a".repeat(64));
  assert.equal(result.manifestDigest, "b".repeat(64));
  assert.deepEqual(memory.verification, {
    componentId: "chatgpt",
    version: "1.0.0",
    requiredFiles: [{ path: "app.exe", size: 7, directory: false }],
  });
});

test("missing destination identity is rejected before opening or writing the ZIP destination", async () => {
  const archivePath = await writeZipFixture([{ name: "safe.txt", body: "x" }]);
  const destination = path.resolve("staging", "missing-identity");
  const memory = memoryDestination(destination);
  await assert.rejects(zipService(memory.fsApi).extractArchive({
    format: "zip", archivePath, destination,
  }), /archive_destination_identity_required/u);
  assert.equal(memory.openDestinationCalls, 0);
  assert.equal(memory.createFileCalls, 0);
});

test("wrong destination identity blocks 7z listing and every output mutation", async () => {
  const archivePath = path.resolve("packages", "wrong-identity.7z");
  const destination = path.resolve("staging", "wrong-identity");
  const fake = fakeSevenZip({
    listing: sevenZipListing([{ path: "safe.txt", size: 1, attributes: "A" }]),
  });
  const memory = memoryDestination(destination, {
    actualIdentity: { volumeSerial: "test", fileId: "different" },
  });
  const service = createArchiveService({
    sevenZipPath: SEVEN_ZIP_PATH,
    spawnFile: fake.spawnFile,
    spawnStream: fake.spawnStream,
    fsApi: memory.fsApi,
  });
  await assert.rejects(service.extractArchive({
    format: "7z", archivePath, destination, destinationIdentity: DESTINATION_IDENTITY,
  }), /archive_destination_identity_changed/u);
  assert.equal(fake.calls.length, 0);
  assert.equal(memory.createFileCalls, 0);
  assert.equal(memory.archivePinClosed, true);
});

test("does not open a ZIP output file when a later entry is unsafe", async () => {
  const archivePath = await writeZipFixture([
    { name: "safe.txt", body: "would otherwise be written" },
    { name: "safe/../../outside.txt", body: "x" },
  ]);
  const destination = path.resolve("staging", "zip-preflight");
  const memory = memoryDestination(destination);

  await assert.rejects(
    zipService(memory.fsApi).extractArchive({
      format: "zip", archivePath, destination, destinationIdentity: DESTINATION_IDENTITY,
    }),
    /archive_path_escape/,
  );
  assert.equal(memory.openDestinationCalls, 1);
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

for (const deviceName of ["COM1", "LPT9.txt", "COM¹", "lpt².log", "COM³.bin"]) {
  test(`rejects Windows device entry name ${deviceName}`, async () => {
    const archivePath = await writeZipFixture([{ name: `app/${deviceName}`, body: "x" }]);
    await assert.rejects(zipService().inspectArchive({ format: "zip", archivePath }), /archive_path_rejected/);
  });
}

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
    zipService(memory.fsApi).extractArchive({
      format: "zip", archivePath, destination,
      destinationIdentity: DESTINATION_IDENTITY, signal: controller.signal,
    }),
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
  assert.deepEqual(fake.calls[0].args, ["l", "-slt", "-ba", "-t7z", "-sns-", "--", path.resolve("packages", "tool.7z")]);
  assert.equal(fake.calls[0].file, SEVEN_ZIP_PATH);
  assert.equal(fake.calls[0].options.shell, false);
});

for (const attributes of ["RD", "HD", "RHD"]) {
  test(`recognizes compact Windows ${attributes} as a directory with children`, async () => {
    const fake = fakeSevenZip({ listing: sevenZipListing([
      { path: "hidden-dir", size: 0, attributes },
      { path: "hidden-dir/tool.exe", size: 12, attributes: "A" },
    ]) });
    const service = createArchiveService({ sevenZipPath: SEVEN_ZIP_PATH, spawnFile: fake.spawnFile, fsApi: {} });

    const result = await service.inspectArchive({ format: "7z", archivePath: path.resolve("packages", `${attributes}.7z`) });
    assert.deepEqual(result.entries, [
      { path: "hidden-dir", size: 0, directory: true },
      { path: "hidden-dir/tool.exe", size: 12, directory: false },
    ]);
  });
}

test("keeps a regular Unix mode token classified as a file", async () => {
  const fake = fakeSevenZip({ listing: sevenZipListing([
    { path: "app/tool", size: 12, attributes: "A_ -rwxr-xr-x" },
  ]) });
  const service = createArchiveService({ sevenZipPath: SEVEN_ZIP_PATH, spawnFile: fake.spawnFile, fsApi: {} });

  const result = await service.inspectArchive({ format: "7z", archivePath: path.resolve("packages", "unix-file.7z") });
  assert.deepEqual(result.entries, [{ path: "app/tool", size: 12, directory: false }]);
});

test("accepts correctly decoded non-ASCII 7z listing text", async () => {
  const fake = fakeSevenZip({ listing: sevenZipListing([
    { path: "工具/说明.txt", size: 6, attributes: "A" },
  ]) });
  const service = createArchiveService({ sevenZipPath: SEVEN_ZIP_PATH, spawnFile: fake.spawnFile, fsApi: {} });

  const result = await service.inspectArchive({ format: "7z", archivePath: path.resolve("packages", "中文.7z") });
  assert.deepEqual(result.entries, [{ path: "工具/说明.txt", size: 6, directory: false }]);
});

test("rejects undecoded Buffer stdout for a 7z listing", async () => {
  const fake = fakeSevenZip({ listing: Buffer.from(sevenZipListing([
    { path: "工具/说明.txt", size: 6, attributes: "A" },
  ]), "utf8") });
  const service = createArchiveService({ sevenZipPath: SEVEN_ZIP_PATH, spawnFile: fake.spawnFile, fsApi: {} });

  await assert.rejects(
    service.inspectArchive({ format: "7z", archivePath: path.resolve("packages", "buffer.7z") }),
    /archive_7z_listing_encoding_required/,
  );
});

test("extracts 7z only with fixed arguments and no-follow capability verification", async () => {
  const archivePath = path.resolve("packages", "tool.7z");
  const destination = path.resolve("staging", "seven-ok");
  const fake = fakeSevenZip({ listing: sevenZipListing([{ path: "app/tool.exe", size: 12, attributes: "A" }]) });
  const memory = memoryDestination(destination, {
    verifiedTree: [
      verifiedItem(destination, { path: "app", size: 0, directory: true }),
      verifiedItem(destination, { path: "app/tool.exe", size: 12, directory: false }),
    ],
  });
  const service = createArchiveService({
    sevenZipPath: SEVEN_ZIP_PATH,
    spawnFile: fake.spawnFile,
    spawnStream: fake.spawnStream,
    fsApi: memory.fsApi,
  });

  const result = await service.extractArchive({
    format: "7z", archivePath, destination, destinationIdentity: DESTINATION_IDENTITY,
  });

  assert.equal(result.totalUnpackedBytes, 12);
  assert.deepEqual(fake.calls.map((call) => call.args), [
    ["l", "-slt", "-ba", "-t7z", "-sns-", "--", archivePath],
    ["x", "-so", "-y", "-t7z", "-sns-", "--", archivePath, "app/tool.exe"],
  ]);
  assert.equal(fake.calls.some((call) => call.args.some((arg) => arg.startsWith("-o"))), false);
  assert.equal(memory.files.get("app/tool.exe"), "x".repeat(12));
  assert.equal(fake.calls.every((call) => call.file === SEVEN_ZIP_PATH && call.options.shell === false), true);
  assert.equal(memory.archiveStableChecks, 3);
  assert.equal(memory.assertEmptyCalls, 1);
  assert.equal(memory.verifyTreeCalls, 1);
  assert.equal(memory.archivePinClosed, true);
  assert.equal(memory.closed, true);
});

test("7z per-entry streaming requires process success and bounded stderr", async (t) => {
  const archivePath = path.resolve("packages", "stream-failure.7z");
  const destination = path.resolve("staging", "stream-failure");
  const listing = sevenZipListing([{ path: "safe.txt", size: 1, attributes: "A" }]);
  for (const [label, fake, expected] of [
    ["nonzero exit", fakeSevenZip({ listing, exitCode: 2, stderr: "failed" }), /archive_7z_failed/],
    ["stderr overflow", fakeSevenZip({ listing, stderr: "x".repeat(1_048_577) }), /archive_7z_stderr_exceeded/],
  ]) {
    await t.test(label, async () => {
      const memory = memoryDestination(destination);
      const service = createArchiveService({
        sevenZipPath: SEVEN_ZIP_PATH,
        spawnFile: fake.spawnFile,
        spawnStream: fake.spawnStream,
        fsApi: memory.fsApi,
      });
      await assert.rejects(service.extractArchive({
        format: "7z", archivePath, destination, destinationIdentity: DESTINATION_IDENTITY,
      }), expected);
      assert.equal(memory.closed, true);
      assert.equal(memory.archivePinClosed, true);
    });
  }
});

test("cancellation during one 7z stdout stream aborts extraction and closes capabilities", async () => {
  const archivePath = path.resolve("packages", "stream-cancel.7z");
  const destination = path.resolve("staging", "stream-cancel");
  const controller = new AbortController();
  const fake = fakeSevenZip({ listing: sevenZipListing([{ path: "safe.txt", size: 1, attributes: "A" }]) });
  const originalSpawnStream = fake.spawnStream;
  fake.spawnStream = async (...args) => {
    const process = await originalSpawnStream(...args);
    controller.abort(new Error("stop"));
    return process;
  };
  const memory = memoryDestination(destination);
  const service = createArchiveService({
    sevenZipPath: SEVEN_ZIP_PATH,
    spawnFile: fake.spawnFile,
    spawnStream: fake.spawnStream,
    fsApi: memory.fsApi,
  });
  await assert.rejects(
    service.extractArchive({
      format: "7z", archivePath, destination,
      destinationIdentity: DESTINATION_IDENTITY, signal: controller.signal,
    }),
    (error) => error?.name === "AbortError" || error?.code === "ABORT_ERR",
  );
  assert.equal(memory.closed, true);
  assert.equal(memory.archivePinClosed, true);
});

test("rejects unsafe 7z listing before invoking extraction", async () => {
  const archivePath = path.resolve("packages", "bad.7z");
  const fake = fakeSevenZip({ listing: sevenZipListing([{ path: "safe\\..\\outside.txt", size: 1, attributes: "A" }]) });
  const memory = memoryDestination(path.resolve("staging", "seven-bad"));
  const service = createArchiveService({ sevenZipPath: SEVEN_ZIP_PATH, spawnFile: fake.spawnFile, spawnStream: fake.spawnStream, fsApi: memory.fsApi });

  await assert.rejects(service.extractArchive({
    format: "7z", archivePath, destination: memory.destination,
    destinationIdentity: DESTINATION_IDENTITY,
  }), /archive_path_escape/);
  assert.equal(fake.calls.length, 1);
  assert.equal(memory.openDestinationCalls, 1);
  assert.equal(memory.createFileCalls, 0);
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

test("parses 7z security fields without overwrite or empty-value ambiguity", async (t) => {
  await t.test("duplicate critical field", async () => {
    const fake = fakeSevenZip({ listing: [
      "Path = safe.txt",
      "Size = 1",
      "Attributes = A",
      "Encrypted = -",
      "Path = outside.txt",
    ].join("\r\n") });
    const service = createArchiveService({ sevenZipPath: SEVEN_ZIP_PATH, spawnFile: fake.spawnFile, fsApi: {} });
    await assert.rejects(
      service.inspectArchive({ format: "7z", archivePath: path.resolve("packages", "duplicate.7z") }),
      /archive_7z_list_ambiguous/,
    );
  });

  for (const field of ["Symbolic Link", "Hard Link", "Link", "Copy Link", "Reparse"]) {
    await t.test(`non-empty ${field}`, async () => {
      const fake = fakeSevenZip({ listing: [
        "Path = app/link",
        "Size = 1",
        "Attributes = A",
        "Encrypted = -",
        `${field} = target`,
      ].join("\r\n") });
      const service = createArchiveService({ sevenZipPath: SEVEN_ZIP_PATH, spawnFile: fake.spawnFile, fsApi: {} });
      await assert.rejects(
        service.inspectArchive({ format: "7z", archivePath: path.resolve("packages", "link-field.7z") }),
        /archive_link_rejected/,
      );
    });
  }

  await t.test("empty link fields", async () => {
    const fake = fakeSevenZip({ listing: [
      "Path = app/ordinary.txt",
      "Size = 1",
      "Attributes = A",
      "Encrypted = -",
      "Symbolic Link = ",
      "Hard Link = ",
      "Link = ",
      "Copy Link = ",
      "Reparse = ",
    ].join("\r\n") });
    const service = createArchiveService({ sevenZipPath: SEVEN_ZIP_PATH, spawnFile: fake.spawnFile, fsApi: {} });
    const result = await service.inspectArchive({ format: "7z", archivePath: path.resolve("packages", "empty-links.7z") });
    assert.deepEqual(result.entries, [{ path: "app/ordinary.txt", size: 1, directory: false }]);
  });

  for (const whitespace of [" ", "\t", " \t "]) {
    await t.test(`whitespace-only symbolic-link target ${JSON.stringify(whitespace)}`, async () => {
      const fake = fakeSevenZip({ listing: [
        "Path = app/ambiguous-link",
        "Size = 1",
        "Attributes = A",
        "Encrypted = -",
        `Symbolic Link = ${whitespace}`,
      ].join("\r\n") });
      const service = createArchiveService({ sevenZipPath: SEVEN_ZIP_PATH, spawnFile: fake.spawnFile, fsApi: {} });
      await assert.rejects(
        service.inspectArchive({ format: "7z", archivePath: path.resolve("packages", "whitespace-link.7z") }),
        /archive_(?:link_rejected|7z_list_ambiguous)/,
      );
    });
  }

  await t.test("Unix l file-type attribute", async () => {
    const fake = fakeSevenZip({ listing: [
      "Path = app/unix-link",
      "Size = 1",
      "Attributes = A_ lrwxrwxrwx",
      "Encrypted = -",
    ].join("\r\n") });
    const service = createArchiveService({ sevenZipPath: SEVEN_ZIP_PATH, spawnFile: fake.spawnFile, fsApi: {} });
    await assert.rejects(
      service.inspectArchive({ format: "7z", archivePath: path.resolve("packages", "unix-link.7z") }),
      /archive_link_rejected/,
    );
  });

  for (const attributes of ["A symlink", "A junction", "A reparse"]) {
    await t.test(`semantic link attribute ${attributes}`, async () => {
      const fake = fakeSevenZip({ listing: [
        "Path = app/semantic-link",
        "Size = 1",
        `Attributes = ${attributes}`,
        "Encrypted = -",
      ].join("\r\n") });
      const service = createArchiveService({ sevenZipPath: SEVEN_ZIP_PATH, spawnFile: fake.spawnFile, fsApi: {} });
      await assert.rejects(
        service.inspectArchive({ format: "7z", archivePath: path.resolve("packages", "semantic-link.7z") }),
        /archive_link_rejected/,
      );
    });
  }

  await t.test("encrypted entry", async () => {
    const fake = fakeSevenZip({ listing: [
      "Path = secret.txt",
      "Size = 1",
      "Attributes = A",
      "Encrypted = +",
    ].join("\r\n") });
    const service = createArchiveService({ sevenZipPath: SEVEN_ZIP_PATH, spawnFile: fake.spawnFile, fsApi: {} });
    await assert.rejects(
      service.inspectArchive({ format: "7z", archivePath: path.resolve("packages", "encrypted.7z") }),
      /archive_encrypted_entry_rejected/,
    );
  });

  await t.test("malformed injected record line", async () => {
    const fake = fakeSevenZip({ listing: [
      "Path = safe.txt",
      "Size = 1",
      "Attributes = A",
      "this is not an slt field",
    ].join("\r\n") });
    const service = createArchiveService({ sevenZipPath: SEVEN_ZIP_PATH, spawnFile: fake.spawnFile, fsApi: {} });
    await assert.rejects(
      service.inspectArchive({ format: "7z", archivePath: path.resolve("packages", "injected.7z") }),
      /archive_7z_list_invalid/,
    );
  });

  await t.test("unknown injected field", async () => {
    const fake = fakeSevenZip({ listing: [
      "Path = safe.txt",
      "Size = 1",
      "Attributes = A",
      "Injected Field = outside.txt",
    ].join("\r\n") });
    const service = createArchiveService({ sevenZipPath: SEVEN_ZIP_PATH, spawnFile: fake.spawnFile, fsApi: {} });
    await assert.rejects(
      service.inspectArchive({ format: "7z", archivePath: path.resolve("packages", "unknown-field.7z") }),
      /archive_7z_list_invalid/,
    );
  });
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
    verifiedTree: [
      verifiedItem(destination, { path: "app", size: 0, directory: true }),
      { ...verifiedItem(destination, { path: "app/tool.exe", size: 1, directory: false }), realPath: path.resolve("outside", "tool.exe") },
    ],
  });
  const service = createArchiveService({ sevenZipPath: SEVEN_ZIP_PATH, spawnFile: fake.spawnFile, spawnStream: fake.spawnStream, fsApi: memory.fsApi });

  await assert.rejects(service.extractArchive({
    format: "7z", archivePath, destination, destinationIdentity: DESTINATION_IDENTITY,
  }), /archive_output_escape/);
});

test("7z post-extraction tree must exactly match preflight metadata", async (t) => {
  const archivePath = path.resolve("packages", "tree-contract.7z");
  const destination = path.resolve("staging", "tree-contract");
  const expectedTree = [
    verifiedItem(destination, { path: "app", size: 0, directory: true }),
    verifiedItem(destination, { path: "app/tool.exe", size: 12, directory: false }),
  ];
  const cases = [
    ["missing entry", expectedTree.slice(0, 1)],
    ["extra entry", [...expectedTree, verifiedItem(destination, { path: "extra.txt", size: 1, directory: false })]],
    ["type mismatch", [expectedTree[0], { ...expectedTree[1], directory: true }]],
    ["size mismatch", [expectedTree[0], { ...expectedTree[1], size: 13 }]],
    ["missing explicit link evidence", [expectedTree[0], omit(expectedTree[1], "link")]],
    ["hard link", [expectedTree[0], { ...expectedTree[1], hardLink: true }]],
    ["multiple links", [expectedTree[0], { ...expectedTree[1], nlink: 2 }]],
    ["file path trailing slash", [expectedTree[0], { ...expectedTree[1], path: "app/tool.exe/" }]],
    ["directory path trailing slash", [{ ...expectedTree[0], path: "app/" }, expectedTree[1]]],
    ["noncanonical separator", [expectedTree[0], { ...expectedTree[1], path: "app\\tool.exe" }]],
  ];

  for (const [label, verifiedTree] of cases) {
    await t.test(label, async () => {
      const fake = fakeSevenZip({ listing: sevenZipListing([{ path: "app/tool.exe", size: 12, attributes: "A" }]) });
      const memory = memoryDestination(destination, { verifiedTree });
      const service = createArchiveService({ sevenZipPath: SEVEN_ZIP_PATH, spawnFile: fake.spawnFile, spawnStream: fake.spawnStream, fsApi: memory.fsApi });
      await assert.rejects(
        service.extractArchive({
          format: "7z", archivePath, destination, destinationIdentity: DESTINATION_IDENTITY,
        }),
        /archive_(?:no_follow_tree_invalid|output_mismatch)/,
      );
    });
  }
});

test("cancellation during 7z no-follow verification fails closed and closes handles", async () => {
  const archivePath = path.resolve("packages", "verify-cancel.7z");
  const destination = path.resolve("staging", "verify-cancel");
  const controller = new AbortController();
  const fake = fakeSevenZip({ listing: sevenZipListing([{ path: "safe.txt", size: 1, attributes: "A" }]) });
  const memory = memoryDestination(destination, {
    verifiedTree: [verifiedItem(destination, { path: "safe.txt", size: 1, directory: false })],
    onVerify(signal) {
      assert.equal(signal, controller.signal);
      controller.abort();
    },
  });
  const service = createArchiveService({ sevenZipPath: SEVEN_ZIP_PATH, spawnFile: fake.spawnFile, spawnStream: fake.spawnStream, fsApi: memory.fsApi });

  await assert.rejects(
    service.extractArchive({
      format: "7z", archivePath, destination,
      destinationIdentity: DESTINATION_IDENTITY, signal: controller.signal,
    }),
    (error) => error?.name === "AbortError",
  );
  assert.equal(memory.archivePinClosed, true);
  assert.equal(memory.closed, true);
});

test("7z cleanup closes every available handle without hiding the primary error", async () => {
  const archivePath = path.resolve("packages", "cleanup.7z");
  const destination = path.resolve("staging", "cleanup");
  const fake = fakeSevenZip({ listing: sevenZipListing([{ path: "safe.txt", size: 1, attributes: "A" }]) });
  const primaryTree = [{ ...verifiedItem(destination, { path: "safe.txt", size: 1, directory: false }), size: 2 }];
  const memory = memoryDestination(destination, {
    verifiedTree: primaryTree,
    destinationCloseError: new Error("destination_close_failed"),
    pinCloseError: new Error("pin_close_failed"),
  });
  const service = createArchiveService({ sevenZipPath: SEVEN_ZIP_PATH, spawnFile: fake.spawnFile, spawnStream: fake.spawnStream, fsApi: memory.fsApi });

  await assert.rejects(service.extractArchive({
    format: "7z", archivePath, destination, destinationIdentity: DESTINATION_IDENTITY,
  }), (error) => {
    assert.equal(error instanceof AggregateError, true);
    assert.match(error.errors[0].message, /archive_output_mismatch/);
    assert.match(error.errors[1].message, /destination_close_failed/);
    assert.match(error.errors[2].message, /pin_close_failed/);
    return true;
  });
  assert.equal(memory.closed, true);
  assert.equal(memory.archivePinClosed, true);
});

test("invalid closeable 7z capability handles are still released", async (t) => {
  const archivePath = path.resolve("packages", "invalid-handle.7z");
  const destination = path.resolve("staging", "invalid-handle");
  const fake = fakeSevenZip({ listing: sevenZipListing([{ path: "safe.txt", size: 1, attributes: "A" }]) });

  await t.test("archive pin", async () => {
    let pinClosed = false;
    const service = createArchiveService({
      sevenZipPath: SEVEN_ZIP_PATH,
      spawnFile: fake.spawnFile,
      fsApi: {
        async pinArchiveFileNoFollow() {
          return { async close() { pinClosed = true; } };
        },
        async openArchiveDestinationNoFollow() {
          throw new Error("must not open destination");
        },
      },
    });
    await assert.rejects(service.extractArchive({
      format: "7z", archivePath, destination, destinationIdentity: DESTINATION_IDENTITY,
    }), /archive_no_follow_capability_invalid/);
    assert.equal(pinClosed, true);
  });

  await t.test("destination", async () => {
    let destinationClosed = false;
    let pinClosed = false;
    const service = createArchiveService({
      sevenZipPath: SEVEN_ZIP_PATH,
      spawnFile: fake.spawnFile,
      fsApi: {
        async pinArchiveFileNoFollow() {
          return {
            async assertStableNoFollow() {},
            async close() { pinClosed = true; },
          };
        },
        async openArchiveDestinationNoFollow() {
          return { async close() { destinationClosed = true; } };
        },
      },
    });
    await assert.rejects(service.extractArchive({
      format: "7z", archivePath, destination, destinationIdentity: DESTINATION_IDENTITY,
    }), /archive_no_follow_capability_invalid/);
    assert.equal(destinationClosed, true);
    assert.equal(pinClosed, true);
  });
});

test("fails closed when extraction lacks stable no-follow capabilities", async (t) => {
  const zipPath = await writeZipFixture([{ name: "safe.txt", body: "x" }]);
  await t.test("ZIP destination", async () => {
    await assert.rejects(zipService({}).extractArchive({
      format: "zip", archivePath: zipPath, destination: path.resolve("staging", "missing-zip-capability"),
      destinationIdentity: DESTINATION_IDENTITY,
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
      destinationIdentity: DESTINATION_IDENTITY,
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

function fakeSevenZip({ listing, exitCode = 0, stderr = "" }) {
  const calls = [];
  const listedSizes = new Map([...String(listing).matchAll(/Path = ([^\r\n]+)[\s\S]*?Size = (\d+)/gu)]
    .map((match) => [match[1], Number(match[2])]));
  return {
    calls,
    async spawnFile(file, args, options) {
      calls.push({ file, args: [...args], options: { ...options } });
      return args[0] === "l"
        ? { exitCode: 0, stdout: listing, stderr: "" }
        : { exitCode: 0, stdout: "Everything is Ok", stderr: "" };
    },
    async spawnStream(file, args, options) {
      calls.push({ file, args: [...args], options: { ...options }, streaming: true });
      const rawPath = args.at(-1);
      return {
        stdout: Readable.from([Buffer.alloc(listedSizes.get(rawPath) ?? 0, "x")]),
        stderr: Readable.from([Buffer.from(stderr)]),
        completed: Promise.resolve({ exitCode }),
        cancel() {},
      };
    },
  };
}

function sevenZipListing(entries) {
  return entries.map((entry) => [
    `Path = ${entry.path}`,
    `Size = ${entry.size}`,
    `Packed Size = ${entry.size}`,
    `Attributes = ${entry.attributes}`,
    "Encrypted = -",
    "CRC = 00000000",
  ].join("\r\n")).join("\r\n\r\n");
}

function memoryDestination(destination, {
  verifiedTree,
  onVerify,
  receiptResult,
  destinationCloseError,
  pinCloseError,
  actualIdentity = DESTINATION_IDENTITY,
} = {}) {
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
    async verifyTreeNoFollow(signal, verification) {
      state.verifyTreeCalls += 1;
      state.verifySignal = signal;
      state.verification = verification;
      await onVerify?.(signal);
      const tree = verifiedTree !== undefined ? verifiedTree : [
        ...[...directories].map((relativePath) => verifiedItem(destination, {
          path: relativePath, size: 0, directory: true,
        })),
        ...[...files].map(([relativePath, value]) => verifiedItem(destination, {
          path: relativePath, size: Buffer.byteLength(value), directory: false,
        })),
      ];
      return receiptResult && verification ? { tree, ...receiptResult } : tree;
    },
    async close() {
      state.closed = true;
      if (destinationCloseError) throw destinationCloseError;
    },
  };
  state.root = root;
  state.fsApi = {
    async openArchiveDestinationNoFollow(exactDestination, { expectedIdentity } = {}) {
      state.openDestinationCalls += 1;
      assert.equal(exactDestination, destination);
      if (JSON.stringify(expectedIdentity) !== JSON.stringify(actualIdentity)) {
        throw Object.assign(new Error("archive_destination_identity_changed"), {
          code: "archive_destination_identity_changed",
        });
      }
      return root;
    },
    async pinArchiveFileNoFollow() {
      return {
        async assertStableNoFollow() {
          state.archiveStableChecks += 1;
        },
        async close() {
          state.archivePinClosed = true;
          if (pinCloseError) throw pinCloseError;
        },
      };
    },
  };
  return state;
}

function verifiedItem(destination, { path: relativePath, size, directory }) {
  return {
    path: relativePath,
    realPath: path.join(destination, ...relativePath.split("/")),
    size,
    directory,
    link: false,
    reparse: false,
    hardLink: false,
    nlink: 1,
  };
}

function omit(value, key) {
  const copy = { ...value };
  delete copy[key];
  return copy;
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
