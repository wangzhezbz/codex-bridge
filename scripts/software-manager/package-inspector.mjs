import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

import { MAX_SOFTWARE_PACKAGE_ENTRIES } from "../../shared/software-manager/catalog-schema.mjs";

const MAX_FILES = MAX_SOFTWARE_PACKAGE_ENTRIES;
const MAX_ZIP32_SIZE = 0xffff_ffff;
const CRC_TABLE = buildCrcTable();

function inspectError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeRelative(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096
    && !value.includes("\\") && !value.startsWith("/")
    && value.split("/").every((part) => part && part !== "." && part !== "..");
}

function crc32File(filePath) {
  const handle = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let crc = 0xffff_ffff;
  try {
    for (;;) {
      const read = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (!read) break;
      for (let index = 0; index < read; index += 1) {
        crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
      }
    }
  } finally {
    fs.closeSync(handle);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

export function inspectPackageTree(rootPath) {
  const root = path.resolve(String(rootPath || ""));
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw inspectError("publisher_input_tree_invalid");
  const entries = [];
  const pending = [{ absolute: root, relative: "" }];
  while (pending.length) {
    const current = pending.pop();
    const children = fs.readdirSync(current.absolute, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      const absolute = path.join(current.absolute, child.name);
      const relative = current.relative ? `${current.relative}/${child.name}` : child.name;
      if (!safeRelative(relative)) throw inspectError("publisher_package_path_invalid");
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw inspectError("publisher_package_link_rejected");
      }
      if (stat.isDirectory()) {
        pending.push({ absolute, relative });
      } else {
        if (stat.size > MAX_ZIP32_SIZE) throw inspectError("publisher_package_zip32_limit");
        entries.push(Object.freeze({
          absolute,
          path: relative,
          size: stat.size,
          crc32: crc32File(absolute),
        }));
        if (entries.length > MAX_FILES) throw inspectError("publisher_package_entry_limit");
      }
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (!entries.length) throw inspectError("publisher_package_empty");
  const casefold = new Set();
  for (const entry of entries) {
    const folded = entry.path.toLocaleLowerCase("en-US");
    if (casefold.has(folded)) throw inspectError("publisher_package_path_duplicate");
    casefold.add(folded);
  }
  return Object.freeze({
    root,
    entries: Object.freeze(entries),
    files: Object.freeze(entries.map((entry) => entry.path)),
    maxRelativePathLength: Math.max(...entries.map((entry) => entry.path.length)),
  });
}

export async function writeImmutableStoredZip({ tree, destination }) {
  const directory = path.dirname(destination);
  await fsPromises.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(destination)}.${process.pid}.${Date.now()}.part`);
  let output;
  try {
    output = await fsPromises.open(temporary, "wx", 0o644);
    let offset = 0;
    const central = [];
    for (const entry of tree.entries) {
      const name = Buffer.from(entry.path, "utf8");
      const local = localHeader(name, entry);
      await output.write(local, 0, local.length, null);
      offset += local.length;
      const input = await fsPromises.open(entry.absolute, "r");
      try {
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let position = 0;
        while (position < entry.size) {
          const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, entry.size - position), position);
          if (!bytesRead) throw inspectError("publisher_package_source_truncated");
          await output.write(buffer, 0, bytesRead, null);
          position += bytesRead;
          offset += bytesRead;
        }
      } finally {
        await input.close();
      }
      central.push(centralHeader(name, entry, offset - entry.size - local.length));
    }
    const centralOffset = offset;
    for (const record of central) {
      await output.write(record, 0, record.length, null);
      offset += record.length;
    }
    const end = endRecord(central.length, offset - centralOffset, centralOffset);
    await output.write(end, 0, end.length, null);
    await output.sync();
    await output.close();
    output = null;
    try {
      await fsPromises.link(temporary, destination);
    } catch (error) {
      if (error?.code === "EEXIST") throw inspectError("publisher_immutable_object_exists");
      throw error;
    }
    await fsPromises.unlink(temporary);
    return destination;
  } catch (error) {
    if (output) await output.close().catch(() => {});
    await fsPromises.unlink(temporary).catch((failure) => {
      if (failure?.code !== "ENOENT") throw failure;
    });
    throw error;
  }
}

function localHeader(name, entry) {
  const value = Buffer.alloc(30 + name.length);
  value.writeUInt32LE(0x04034b50, 0);
  value.writeUInt16LE(20, 4);
  value.writeUInt16LE(0x0800, 6);
  value.writeUInt16LE(0, 8);
  value.writeUInt16LE(0, 10);
  value.writeUInt16LE(0x0021, 12);
  value.writeUInt32LE(entry.crc32, 14);
  value.writeUInt32LE(entry.size, 18);
  value.writeUInt32LE(entry.size, 22);
  value.writeUInt16LE(name.length, 26);
  name.copy(value, 30);
  return value;
}

function centralHeader(name, entry, offset) {
  const value = Buffer.alloc(46 + name.length);
  value.writeUInt32LE(0x02014b50, 0);
  value.writeUInt16LE(20, 4);
  value.writeUInt16LE(20, 6);
  value.writeUInt16LE(0x0800, 8);
  value.writeUInt16LE(0, 10);
  value.writeUInt16LE(0, 12);
  value.writeUInt16LE(0x0021, 14);
  value.writeUInt32LE(entry.crc32, 16);
  value.writeUInt32LE(entry.size, 20);
  value.writeUInt32LE(entry.size, 24);
  value.writeUInt16LE(name.length, 28);
  value.writeUInt32LE(offset, 42);
  name.copy(value, 46);
  return value;
}

function endRecord(count, centralSize, centralOffset) {
  if (count > 0xffff || centralSize > MAX_ZIP32_SIZE || centralOffset > MAX_ZIP32_SIZE) {
    throw inspectError("publisher_package_zip32_limit");
  }
  const value = Buffer.alloc(22);
  value.writeUInt32LE(0x06054b50, 0);
  value.writeUInt16LE(count, 8);
  value.writeUInt16LE(count, 10);
  value.writeUInt32LE(centralSize, 12);
  value.writeUInt32LE(centralOffset, 16);
  return value;
}

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
}
