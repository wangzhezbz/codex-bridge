import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync, mkdtempSync, rmdirSync, unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWin32FileApi } from "../desktop/software-manager/win32-file-api.mjs";

const CHILD_MARKER = "CODEXBRIDGE_WIN32_LONG_PATH_SMOKE_CHILD";

function closeQuietly(api, handle) {
  if (handle === null) return;
  try {
    api.closeHandle(handle);
  } catch {
    // The assertions report the primary failure; exact filesystem cleanup follows.
  }
}

function runNativeSmoke() {
  assert.equal(typeof process.versions.electron, "string");
  const api = createWin32FileApi({ platform: "win32" });
  const sandbox = mkdtempSync(path.join(tmpdir(), "codexbridge-win32-long-"));
  const longDirectory = path.join(sandbox, `dir-${"d".repeat(220)}`);
  const sourceName = `source-${"s".repeat(214)}.part`;
  const targetName = `target-${"t".repeat(215)}.zip`;
  const sourcePath = path.join(sandbox, sourceName);
  const targetPath = path.join(sandbox, targetName);
  let rootHandle = null;
  let directoryHandle = null;
  let fileHandle = null;

  assert.equal(longDirectory.length > 260, true);
  assert.equal(sourcePath.length > 260, true);
  assert.equal(targetPath.length > 260, true);

  try {
    api.createDirectory(longDirectory);
    directoryHandle = api.openPath(longDirectory, {
      access: ["read", "delete", "traverse"],
      share: ["read", "write"],
      disposition: "openExisting",
      directory: true,
    });
    assert.equal(api.finalPath(directoryHandle), longDirectory);

    fileHandle = api.openPath(sourcePath, {
      access: ["read", "write", "delete"],
      share: ["read", "write"],
      disposition: "createNew",
      directory: false,
    });
    api.writeFile(fileHandle, Buffer.from("long-path-smoke", "utf8"));
    api.flushFile(fileHandle);
    api.closeHandle(fileHandle);
    fileHandle = null;

    fileHandle = api.openPath(sourcePath, {
      access: ["read", "delete"],
      share: ["read", "write"],
      disposition: "openExisting",
      directory: false,
    });
    assert.equal(api.finalPath(fileHandle), sourcePath);

    rootHandle = api.openPath(sandbox, {
      access: ["read", "delete", "traverse"],
      share: ["read", "write"],
      disposition: "openExisting",
      directory: true,
    });
    api.renameByHandle(fileHandle, rootHandle, targetName, { replace: false });
    assert.equal(api.finalPath(fileHandle), targetPath);

    api.deleteByHandle(fileHandle);
    api.closeHandle(fileHandle);
    fileHandle = null;
    assert.equal(existsSync(targetPath), false);

    api.deleteByHandle(directoryHandle);
    api.closeHandle(directoryHandle);
    directoryHandle = null;
    assert.equal(existsSync(longDirectory), false);
  } finally {
    closeQuietly(api, fileHandle);
    closeQuietly(api, directoryHandle);
    closeQuietly(api, rootHandle);
    if (existsSync(sourcePath)) unlinkSync(sourcePath);
    if (existsSync(targetPath)) unlinkSync(targetPath);
    if (existsSync(longDirectory)) rmdirSync(longDirectory);
    if (existsSync(sandbox)) rmdirSync(sandbox);
  }
}

if (process.env[CHILD_MARKER] === "1") {
  test("real Win32 long-path primitives complete inside Electron", {
    skip: process.platform !== "win32",
  }, runNativeSmoke);
} else {
  test("Electron-as-Node completes a real isolated Win32 >260 path lifecycle", {
    skip: process.platform !== "win32",
  }, () => {
    const electronPath = createRequire(import.meta.url)("electron");
    const result = spawnSync(electronPath, ["--test", fileURLToPath(import.meta.url)], {
      encoding: "utf8",
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        [CHILD_MARKER]: "1",
      },
      timeout: 30_000,
      windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(
      result.status,
      0,
      `Electron Win32 long-path smoke failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  });
}
