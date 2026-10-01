import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildProviderLogoCandidate, saveProviderLogo } from "../desktop/settings.mjs";

const MAX_LOGO_BYTES = 256 * 1024;

function fixture(content = "source-logo") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-logo-io-"));
  const source = path.join(root, "source.png");
  const directory = path.join(root, "config", "provider-logos");
  const target = path.join(directory, "test.png");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(source, content);
  fs.writeFileSync(target, "previous-logo");
  return { root, source, directory, target };
}

function observeSource(t, source, afterOpened = () => {}) {
  const original = Object.fromEntries(["openSync", "fstatSync", "readFileSync", "readSync", "closeSync"]
    .map((name) => [name, fs[name]]));
  t.after(() => Object.assign(fs, original));
  let descriptor;
  let changed = false;
  const counts = { reads: 0, wholeReadBytes: 0, directReadBytes: 0, closes: 0 };
  fs.openSync = (file, flags, ...args) => {
    const fd = original.openSync(file, flags, ...args);
    if (file === source && (flags === "r" || (typeof flags === "number" && (flags & 3) === 0))) descriptor = fd;
    return fd;
  };
  fs.fstatSync = (fd, ...args) => {
    const stat = original.fstatSync(fd, ...args);
    if (fd === descriptor && !changed) {
      changed = true;
      afterOpened();
    }
    return stat;
  };
  fs.readFileSync = (file, ...args) => {
    const result = original.readFileSync(file, ...args);
    if (file === descriptor) {
      counts.reads++;
      counts.wholeReadBytes += Buffer.byteLength(result);
    }
    return result;
  };
  fs.readSync = (fd, ...args) => {
    const count = original.readSync(fd, ...args);
    if (fd === descriptor) {
      counts.reads++;
      counts.directReadBytes += count;
    }
    return count;
  };
  fs.closeSync = (fd) => {
    if (fd === descriptor) counts.closes++;
    return original.closeSync(fd);
  };
  return counts;
}

for (const size of [0, 16]) {
  test(`logo growth after size validation cannot make the reader consume the whole enlarged file (${size} bytes)`, (t) => {
    const { root, source } = fixture(Buffer.alloc(size, "a"));
    const counts = observeSource(t, source, () => fs.appendFileSync(source, Buffer.alloc(1024 * 1024, "b")));
    assert.throws(() => buildProviderLogoCandidate(root, "test", source), (error) => (
      ["provider_logo_file_changed", "provider_logo_file_too_large"].includes(error?.code)
    ));
    assert.ok(counts.reads > 0);
    const consumed = Math.max(counts.wholeReadBytes, counts.directReadBytes);
    assert.ok(consumed <= MAX_LOGO_BYTES + 1, `Consumed ${consumed} bytes despite the ${MAX_LOGO_BYTES}-byte limit`);
    assert.equal(counts.closes, 1);
  });
}

for (const size of [0, 16, MAX_LOGO_BYTES]) {
  test(`unchanged logo bytes round-trip at size ${size} and close the descriptor`, (t) => {
    const bytes = Buffer.alloc(size, 0x61);
    const { root, source } = fixture(bytes);
    const counts = observeSource(t, source);
    const candidate = buildProviderLogoCandidate(root, "test", source);
    assert.deepEqual(candidate.bytes, bytes);
    assert.equal(counts.closes, 1);
  });
}

test("a logo shrinking after open is rejected and its descriptor closes", (t) => {
  const { root, source } = fixture("not-empty");
  const counts = observeSource(t, source, () => fs.truncateSync(source, 0));
  assert.throws(() => buildProviderLogoCandidate(root, "test", source), { code: "provider_logo_file_changed" });
  assert.equal(counts.closes, 1);
});

test("logo reading handles positive short reads without dropping or duplicating bytes", (t) => {
  const bytes = Buffer.from("short-read-中文-logo");
  const { root, source } = fixture(bytes);
  const counts = observeSource(t, source);
  const observedReadSync = fs.readSync;
  fs.readSync = (fd, buffer, offset, length, position) => (
    observedReadSync(fd, buffer, offset, Math.min(length, 3), position)
  );
  const candidate = buildProviderLogoCandidate(root, "test", source);
  assert.deepEqual(candidate.bytes, bytes);
  assert.ok(counts.reads > 2);
  assert.equal(counts.closes, 1);
});

function observeTemp(t, directory, { afterClose, beforeOpen, failSync = false } = {}) {
  const original = Object.fromEntries(["openSync", "closeSync", "fsyncSync"]
    .map((name) => [name, fs[name]]));
  t.after(() => Object.assign(fs, original));
  let temp;
  let descriptor;
  let closed = false;
  let attempted = false;
  fs.openSync = (file, ...args) => {
    if (!attempted && typeof file === "string" && path.dirname(file) === directory && file.endsWith(".tmp")) {
      attempted = true;
      temp = file;
      beforeOpen?.(file);
      descriptor = original.openSync(file, ...args);
      return descriptor;
    }
    return original.openSync(file, ...args);
  };
  fs.fsyncSync = (fd) => {
    if (fd === descriptor && failSync) throw Object.assign(new Error("fixture fsync failure"), { code: "EIO" });
    return original.fsyncSync(fd);
  };
  fs.closeSync = (fd) => {
    const result = original.closeSync(fd);
    if (fd === descriptor && !closed) {
      closed = true;
      afterClose?.(temp);
    }
    return result;
  };
  return { tempPath: () => temp, descriptor: () => descriptor };
}

for (const replacement of ["regular-file", "hard-link"]) {
  test(`failed logo commit preserves a replacement ${replacement} at its former temporary path`, (t) => {
    const { root, source, directory, target } = fixture();
    const displaced = path.join(directory, "displaced-owned-file");
    const external = path.join(root, "external-file");
    fs.writeFileSync(external, "external-content");
    const observed = observeTemp(t, directory, { afterClose: (temp) => {
      fs.renameSync(temp, displaced);
      if (replacement === "hard-link") fs.linkSync(external, temp);
      else fs.writeFileSync(temp, "external-content");
    } });
    assert.throws(() => saveProviderLogo(root, "test", source), (error) => (
      ["provider_logo_file_changed", "provider_logo_file_unsafe"].includes(error?.code)
    ));
    assert.equal(fs.existsSync(observed.tempPath()), true, "failure cleanup must not delete the replacement");
    assert.equal(fs.readFileSync(observed.tempPath(), "utf8"), "external-content");
    assert.equal(fs.readFileSync(external, "utf8"), "external-content");
    assert.equal(fs.readFileSync(displaced, "utf8"), "source-logo");
    assert.equal(fs.readFileSync(target, "utf8"), "previous-logo");
  });
}

test("failed logo flush removes only its own temporary file and leaves the previous logo", (t) => {
  const { root, source, directory, target } = fixture();
  const observed = observeTemp(t, directory, { failSync: true });
  assert.throws(() => saveProviderLogo(root, "test", source), { code: "EIO" });
  assert.equal(fs.existsSync(observed.tempPath()), false);
  assert.equal(fs.readFileSync(target, "utf8"), "previous-logo");
});

test("exclusive temporary creation failure never deletes the existing file", (t) => {
  const { root, source, directory, target } = fixture();
  const observed = observeTemp(t, directory, { beforeOpen: (temp) => fs.writeFileSync(temp, "preexisting", { flag: "wx" }) });
  assert.throws(() => saveProviderLogo(root, "test", source), { code: "EEXIST" });
  assert.equal(fs.readFileSync(observed.tempPath(), "utf8"), "preexisting");
  assert.equal(fs.readFileSync(target, "utf8"), "previous-logo");
});

test("failed initial temporary fstat preserves the unverifiable path and closes the created descriptor", (t) => {
  const { root, source, directory, target } = fixture();
  const observed = observeTemp(t, directory);
  const originalStat = fs.fstatSync;
  const originalClose = fs.closeSync;
  let closed = 0;
  let failed = false;
  t.after(() => { fs.fstatSync = originalStat; });
  fs.fstatSync = (fd, ...args) => {
    if (fd === observed.descriptor() && !failed) {
      failed = true;
      throw Object.assign(new Error("fixture fstat failure"), { code: "EIO" });
    }
    return originalStat(fd, ...args);
  };
  fs.closeSync = (fd) => {
    if (fd === observed.descriptor()) closed++;
    return originalClose(fd);
  };
  assert.throws(() => saveProviderLogo(root, "test", source), { code: "EIO" });
  assert.equal(closed, 1);
  assert.equal(fs.existsSync(observed.tempPath()), true);
  assert.equal(fs.readFileSync(target, "utf8"), "previous-logo");
});
