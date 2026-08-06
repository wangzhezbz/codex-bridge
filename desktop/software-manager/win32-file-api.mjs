import { createRequire } from "node:module";

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const DELETE = 0x00010000;
const FILE_SHARE_READ = 0x1;
const FILE_SHARE_WRITE = 0x2;
const FILE_SHARE_DELETE = 0x4;
const CREATE_NEW = 1;
const OPEN_EXISTING = 3;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const FILE_ATTRIBUTE_TAG_INFO = 9;
const FILE_ID_INFO = 18;
const FILE_DISPOSITION_INFO = 4;
const FILE_RENAME_INFO = 3;
const MAX_NATIVE_PATH_CHARS = 32_768;

function win32Error(code, operation, nativeCode) {
  const error = new Error(code);
  error.code = code;
  if (operation !== undefined) error.operation = operation;
  if (nativeCode !== undefined) error.nativeCode = nativeCode;
  return error;
}

function mapNativeCode(nativeCode) {
  if (nativeCode === 2 || nativeCode === 3) return "entry_missing";
  if (nativeCode === 5) return "access_denied";
  if (nativeCode === 32 || nativeCode === 33) return "sharing_violation";
  if (nativeCode === 80 || nativeCode === 183) return "entry_exists";
  if (nativeCode === 87) return "native_primitive_unsupported";
  return "windows_native_call_failed";
}

function maskFrom(values, table, code) {
  if (!Array.isArray(values) || values.some((value) => !Object.hasOwn(table, value))) {
    throw win32Error(code);
  }
  return values.reduce((mask, value) => mask | table[value], 0) >>> 0;
}

function handleValue(handle) {
  if (typeof handle === "bigint") return handle;
  if (typeof handle === "number" && Number.isSafeInteger(handle)) return BigInt(handle);
  throw win32Error("windows_handle_invalid");
}

export function createWin32FileApi({ platform = process.platform, koffi } = {}) {
  if (platform !== "win32") throw win32Error("windows_platform_required");
  const ffi = koffi ?? createRequire(import.meta.url)("koffi");
  if (!ffi || typeof ffi.load !== "function") throw win32Error("koffi_adapter_required");

  const kernel32 = ffi.load("Kernel32.dll");
  const CreateFileW = kernel32.func("CreateFileW", "intptr_t", [
    "str16", "uint32_t", "uint32_t", "void *", "uint32_t", "uint32_t", "intptr_t",
  ]);
  const CloseHandle = kernel32.func("CloseHandle", "int", ["intptr_t"]);
  const GetLastError = kernel32.func("GetLastError", "uint32_t", []);
  const GetFileInformationByHandle = kernel32.func(
    "GetFileInformationByHandle", "int", ["intptr_t", "void *"],
  );
  const GetFileInformationByHandleEx = kernel32.func(
    "GetFileInformationByHandleEx", "int", ["intptr_t", "int", "void *", "uint32_t"],
  );
  const GetFinalPathNameByHandleW = kernel32.func(
    "GetFinalPathNameByHandleW", "uint32_t", ["intptr_t", "void *", "uint32_t", "uint32_t"],
  );
  const ReadFile = kernel32.func("ReadFile", "int", ["intptr_t", "void *", "uint32_t", "void *", "void *"]);
  const WriteFile = kernel32.func("WriteFile", "int", ["intptr_t", "void *", "uint32_t", "void *", "void *"]);
  const FlushFileBuffers = kernel32.func("FlushFileBuffers", "int", ["intptr_t"]);
  const CreateDirectoryW = kernel32.func("CreateDirectoryW", "int", ["str16", "void *"]);
  const SetFileInformationByHandle = kernel32.func(
    "SetFileInformationByHandle", "int", ["intptr_t", "int", "void *", "uint32_t"],
  );
  const pointerSize = typeof ffi.sizeof === "function" ? ffi.sizeof("intptr_t") : 8;
  if (pointerSize !== 4 && pointerSize !== 8) throw win32Error("windows_pointer_size_unsupported");

  function failure(operation) {
    const nativeCode = Number(GetLastError());
    return win32Error(mapNativeCode(nativeCode), operation, nativeCode);
  }

  function requireSuccess(result, operation) {
    if (!result) throw failure(operation);
  }

  function openPath(exactPath, options) {
    const access = maskFrom(options?.access, {
      read: GENERIC_READ,
      write: GENERIC_WRITE,
      delete: DELETE,
      attributes: 0x80,
      traverse: 0x20,
    }, "windows_open_access_invalid");
    const share = maskFrom(options?.share, {
      read: FILE_SHARE_READ,
      write: FILE_SHARE_WRITE,
      delete: FILE_SHARE_DELETE,
    }, "windows_open_share_invalid");
    const creation = options?.disposition === "openExisting" ? OPEN_EXISTING
      : options?.disposition === "createNew" ? CREATE_NEW
        : null;
    if (creation === null || typeof options?.directory !== "boolean") {
      throw win32Error("windows_open_options_invalid");
    }
    const flags = FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT
      | (options.directory ? FILE_FLAG_BACKUP_SEMANTICS : 0);
    const handle = CreateFileW(exactPath, access, share, null, creation, flags, 0);
    if (handleValue(handle) === -1n) throw failure("CreateFileW");
    return handle;
  }

  function queryHandle(handle) {
    const basic = Buffer.alloc(52);
    requireSuccess(GetFileInformationByHandle(handle, basic), "GetFileInformationByHandle");
    const tag = Buffer.alloc(8);
    requireSuccess(
      GetFileInformationByHandleEx(handle, FILE_ATTRIBUTE_TAG_INFO, tag, tag.length),
      "GetFileInformationByHandleEx(FileAttributeTagInfo)",
    );
    const id = Buffer.alloc(24);
    requireSuccess(
      GetFileInformationByHandleEx(handle, FILE_ID_INFO, id, id.length),
      "GetFileInformationByHandleEx(FileIdInfo)",
    );
    const attributes = tag.readUInt32LE(0);
    const size = (BigInt(basic.readUInt32LE(32)) << 32n) | BigInt(basic.readUInt32LE(36));
    if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw win32Error("native_file_too_large");
    return {
      identity: Object.freeze({
        volumeSerial: id.readBigUInt64LE(0).toString(16).padStart(16, "0"),
        fileId: id.subarray(8, 24).toString("hex"),
      }),
      directory: (attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0,
      reparse: (attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0,
      reparseTag: tag.readUInt32LE(4),
      size: Number(size),
      nlink: basic.readUInt32LE(40),
    };
  }

  function finalPath(handle) {
    const output = Buffer.alloc(MAX_NATIVE_PATH_CHARS * 2);
    const length = Number(GetFinalPathNameByHandleW(handle, output, MAX_NATIVE_PATH_CHARS, 0));
    if (length === 0) throw failure("GetFinalPathNameByHandleW");
    if (length >= MAX_NATIVE_PATH_CHARS) throw win32Error("native_path_buffer_exceeded");
    const value = output.subarray(0, length * 2).toString("utf16le");
    return value.startsWith("\\\\?\\UNC\\") ? `\\\\${value.slice(8)}`
      : value.startsWith("\\\\?\\") ? value.slice(4)
        : value;
  }

  function readFile(handle, maxBytes) {
    const info = queryHandle(handle);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || info.size > maxBytes) {
      throw win32Error("native_file_too_large");
    }
    const output = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < output.length) {
      const count = Math.min(output.length - offset, 0x7fff_ffff);
      const read = Buffer.alloc(4);
      requireSuccess(ReadFile(handle, output.subarray(offset, offset + count), count, read, null), "ReadFile");
      const actual = read.readUInt32LE(0);
      if (actual === 0) throw win32Error("native_unexpected_eof");
      offset += actual;
    }
    return output;
  }

  function writeChunk(handle, value) {
    const input = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let offset = 0;
    while (offset < input.length) {
      const count = Math.min(input.length - offset, 0x7fff_ffff);
      const written = Buffer.alloc(4);
      requireSuccess(WriteFile(handle, input.subarray(offset, offset + count), count, written, null), "WriteFile");
      const actual = written.readUInt32LE(0);
      if (actual === 0) throw win32Error("native_short_write");
      offset += actual;
    }
  }

  function createDirectory(exactPath) {
    requireSuccess(CreateDirectoryW(exactPath, null), "CreateDirectoryW");
  }

  function renameByHandle(handle, rootHandle, name, { replace = false } = {}) {
    if (replace) throw win32Error("windows_replace_rename_rejected");
    if (typeof name !== "string" || name.length === 0 || name === "." || name === ".."
      || /[\\/:\0]/u.test(name)) {
      throw win32Error("windows_rename_name_invalid");
    }
    // User-mode SetFileInformationByHandle rejects a non-null RootDirectory on supported
    // Windows builds. Resolve the already-pinned directory handle and submit one atomic,
    // no-replace rename with an absolute target instead of falling back to path rename.
    const rootPath = finalPath(rootHandle).replace(/[\\]+$/u, "");
    const destinationPath = `${rootPath}\\${name}`;
    if (destinationPath.length >= MAX_NATIVE_PATH_CHARS) throw win32Error("native_path_buffer_exceeded");
    const encoded = Buffer.from(destinationPath, "utf16le");
    const rootOffset = pointerSize === 8 ? 8 : 4;
    const lengthOffset = rootOffset + pointerSize;
    const nameOffset = lengthOffset + 4;
    const structureSize = pointerSize === 8 ? 24 : 16;
    const info = Buffer.alloc(structureSize + encoded.length);
    info.writeUInt32LE(0, 0);
    info.writeUInt32LE(encoded.length, lengthOffset);
    encoded.copy(info, nameOffset);
    requireSuccess(
      SetFileInformationByHandle(handle, FILE_RENAME_INFO, info, info.length),
      "SetFileInformationByHandle(FileRenameInfo)",
    );
  }

  function deleteByHandle(handle) {
    const info = Buffer.from([1]);
    requireSuccess(
      SetFileInformationByHandle(handle, FILE_DISPOSITION_INFO, info, info.length),
      "SetFileInformationByHandle(FileDispositionInfo)",
    );
  }

  function closeHandle(handle) {
    requireSuccess(CloseHandle(handle), "CloseHandle");
  }

  return Object.freeze({
    openPath,
    queryHandle,
    finalPath,
    readFile,
    writeFile: writeChunk,
    appendFile: writeChunk,
    flushFile(handle) { requireSuccess(FlushFileBuffers(handle), "FlushFileBuffers"); },
    createDirectory,
    renameByHandle,
    deleteByHandle,
    closeHandle,
  });
}
