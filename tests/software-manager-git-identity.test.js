import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rmdir, unlink, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createGitIdentityCapabilities } from "../desktop/software-manager/git-identity-capabilities.mjs";
import { authorizeInstallRoot } from "../desktop/software-manager/path-policy.mjs";
import { createWin32FileApi } from "../desktop/software-manager/win32-file-api.mjs";
import { createWindowsFileCapabilities } from "../desktop/software-manager/windows-file-capabilities.mjs";

const HASH = "a".repeat(64);
const INSTALL_ROOT_CAPABILITY = await authorizeInstallRoot({
  candidate: "D:\\CBApps",
  maxRelativePath: 200,
  access: async () => {},
  realpath: async (value) => value,
  lstat: async () => ({
    dev: 1, ino: 1,
    isDirectory: () => true,
    isSymbolicLink: () => false,
    isReparsePoint: () => false,
  }),
});

function fixture({ missingAfterDelete = false, failMutableCloseOnce = null } = {}) {
  const calls = [];
  const hashes = new Map([
    ["D:\\CBApps\\downloads\\git-2.51.0.exe", HASH],
  ]);
  const openPins = new Set();
  function filePin(filePath) {
    const pin = {
      async assertStableNoFollow() {
        if (!openPins.has(pin)) throw new Error("pin_closed");
        calls.push(["stable", filePath]);
      },
      async close() {
        calls.push(["close-file", filePath]);
        if (failMutableCloseOnce === filePath) {
          failMutableCloseOnce = null;
          throw new Error("close_once_failed");
        }
        openPins.delete(pin);
      },
    };
    openPins.add(pin);
    return pin;
  }
  const fileCapabilities = {
    async pinArchiveFileNoFollow(filePath) {
      calls.push(["pin-archive", filePath]);
      return filePin(filePath);
    },
    async pinExecutableFileNoFollow(filePath) {
      calls.push(["pin-file", filePath]);
      if (missingAfterDelete && deleted.some((record) => record.path === filePath)) {
        throw Object.assign(new Error("missing"), { code: "entry_missing" });
      }
      return filePin(filePath);
    },
    async openDirectoryNoFollow(directoryPath) {
      calls.push(["pin-directory", directoryPath]);
      return {
        async listChildren() { calls.push(["list-directory", directoryPath]); return []; },
        async close() { calls.push(["close-directory", directoryPath]); },
      };
    },
  };
  const deleted = [];
  const capabilities = createGitIdentityCapabilities({
    fileCapabilities,
    installRootCapability: INSTALL_ROOT_CAPABILITY,
    async hashFile(filePath) { calls.push(["hash", filePath]); return hashes.get(filePath) ?? "b".repeat(64); },
    retainedInstallerStore: {
      async deleteVerified(value) {
        assert.equal(openPins.size, 0, "delete capability receives control only after the identity pin closes");
        deleted.push(value);
      },
    },
  });
  return { calls, hashes, deleted, capabilities };
}

const external = Object.freeze({
  kind: "external",
  ownership: "external",
  version: "2.50.0",
  installDir: "C:\\Git",
  executablePath: "C:\\Git\\cmd\\git.exe",
  uninstallerPath: "C:\\Git\\unins000.exe",
  registryKey: "HKLM\\Git",
});

test("pins the installer, registered Git root, git.exe and uninstaller and revalidates each file", async () => {
  const { calls, capabilities } = fixture();
  const pin = await capabilities.pinPlan({
    installerPath: "D:\\CBApps\\downloads\\git-2.51.0.exe",
    installerSha256: HASH,
    targetDir: external.installDir,
    discovery: external,
  });
  await capabilities.revalidate(pin, { installerSha256: HASH, discovery: external });
  assert.deepEqual(calls.filter(([kind]) => kind === "pin-file").map(([, value]) => value), [
    "D:\\CBApps\\downloads\\git-2.51.0.exe",
  ]);
  assert.deepEqual(calls.filter(([kind]) => kind === "pin-archive").map(([, value]) => value), [
    external.executablePath,
    external.uninstallerPath,
  ]);
  assert.deepEqual(calls.find(([kind]) => kind === "pin-directory"), ["pin-directory", external.installDir]);
  assert.equal(calls.filter(([kind]) => kind === "hash").length, 2);
  await capabilities.release(pin);
  await assert.rejects(capabilities.revalidate(pin), /git_identity_capability_invalid/u);
});

test("releases only mutable target pins at process start and retains the installer identity", async () => {
  const { calls, capabilities } = fixture();
  const pin = await capabilities.pinPlan({
    installerPath: "D:\\CBApps\\downloads\\git-2.51.0.exe",
    installerSha256: HASH,
    targetDir: external.installDir,
    discovery: external,
  });

  await capabilities.releaseMutable(pin);
  const closedAfterStart = calls.filter(([kind]) => kind.startsWith("close-")).map(([, value]) => value);
  assert.deepEqual(closedAfterStart.sort(), [
    external.executablePath,
    external.installDir,
    external.uninstallerPath,
  ].sort());
  await capabilities.revalidate(pin, { installerSha256: HASH });
  assert.equal(calls.filter(([kind, value]) => kind === "stable"
    && value === "D:\\CBApps\\downloads\\git-2.51.0.exe").length > 0, true);
  await assert.rejects(capabilities.releaseMutable(pin), /git_mutable_identity_already_released/u);
  await capabilities.release(pin);
  assert.equal(calls.some(([kind, value]) => kind === "close-file"
    && value === "D:\\CBApps\\downloads\\git-2.51.0.exe"), true);
});

test("a mutable close failure remains retryable and does not mark the pin released early", async () => {
  const { calls, capabilities } = fixture({ failMutableCloseOnce: external.uninstallerPath });
  const pin = await capabilities.pinPlan({
    installerPath: "D:\\CBApps\\downloads\\git-2.51.0.exe",
    installerSha256: HASH,
    targetDir: external.installDir,
    discovery: external,
  });

  await assert.rejects(capabilities.releaseMutable(pin), /close_once_failed/u);
  await capabilities.releaseMutable(pin);
  assert.equal(calls.filter(([kind, value]) => kind === "close-file"
    && value === external.uninstallerPath).length, 2);
  await capabilities.revalidate(pin, { installerSha256: HASH });
  await capabilities.release(pin);
});

test("rejects a changed registration and unregistered arbitrary installation target", async () => {
  const { capabilities } = fixture();
  const pin = await capabilities.pinPlan({
    installerPath: "D:\\CBApps\\downloads\\git-2.51.0.exe",
    installerSha256: HASH,
    targetDir: external.installDir,
    discovery: external,
  });
  await assert.rejects(capabilities.revalidate(pin, {
    discovery: { ...external, registryKey: "HKCU\\Git" },
  }), /git_identity_discovery_changed/u);
  await capabilities.release(pin);
  await assert.rejects(capabilities.pinPlan({ targetDir: "E:\\Git" }), /git_identity_unregistered_target_rejected/u);
});

test("a first managed install pins the install-root parent and repeatedly proves the Git child is absent", async () => {
  const { calls, capabilities } = fixture();
  const pin = await capabilities.pinPlan({ targetDir: "D:\\CBApps\\Git", targetMustBeAbsent: true });
  await capabilities.revalidate(pin, { targetMustBeAbsent: true });
  assert.equal(calls.filter(([kind, value]) => kind === "pin-directory" && value === "D:\\CBApps").length, 1);
  assert.equal(calls.filter(([kind]) => kind === "list-directory").length, 2);
  await capabilities.release(pin);
});

test("retained installers are restricted to the managed downloads directory and deleted through the bound store", async () => {
  const { capabilities, deleted } = fixture();
  const retained = { path: "D:\\CBApps\\downloads\\git-2.51.0.exe", sha256: HASH, version: "2.51.0" };
  const pin = await capabilities.pinRetainedInstaller(retained);
  assert.deepEqual(await capabilities.retainInstaller(pin, retained), retained);
  await capabilities.release(pin);
  await capabilities.discardRetainedInstaller(retained);
  assert.deepEqual(deleted, [{ ...retained, installRoot: "D:\\CBApps" }]);
  await assert.rejects(capabilities.pinRetainedInstaller({
    ...retained,
    path: "C:\\Users\\Public\\git-2.51.0.exe",
  }), /git_retained_installer_path_rejected/u);
  await assert.rejects(capabilities.pinRetainedInstaller({
    ...retained,
    version: "2.50.0",
  }), /git_retained_installer_path_rejected/u);
});

test("retained installer cleanup is idempotent when deletion succeeded before ownership cleanup was saved", async () => {
  const { capabilities, deleted } = fixture({ missingAfterDelete: true });
  const retained = { path: "D:\\CBApps\\downloads\\git-2.51.0.exe", sha256: HASH, version: "2.51.0" };
  assert.deepEqual(await capabilities.discardRetainedInstaller(retained), { deleted: true, missing: false });
  assert.deepEqual(await capabilities.discardRetainedInstaller(retained), { deleted: false, missing: true });
  assert.equal(deleted.length, 1);
});

test("real Win32 pins block Git target mutation until the process-start release", {
  skip: process.platform !== "win32" ? "requires production Win32 handles" : false,
}, async () => {
  const installRoot = path.win32.join(process.cwd(), `.tmp-cb-git-pin-${randomUUID()}`);
  const downloadsRoot = path.win32.join(installRoot, "downloads");
  const gitRoot = path.win32.join(installRoot, "Git");
  const cmdRoot = path.win32.join(gitRoot, "cmd");
  const installerPath = path.win32.join(downloadsRoot, "git-2.51.0.exe");
  const executablePath = path.win32.join(cmdRoot, "git.exe");
  const movedExecutablePath = path.win32.join(cmdRoot, "git-moved.exe");
  const uninstallerPath = path.win32.join(gitRoot, "unins000.exe");
  await mkdir(downloadsRoot, { recursive: true });
  await mkdir(cmdRoot, { recursive: true });
  await writeFile(installerPath, "signed installer fixture");
  await writeFile(executablePath, "git fixture");
  await writeFile(uninstallerPath, "uninstaller fixture");
  const installerSha256 = createHash("sha256").update(await readFile(installerPath)).digest("hex");
  const installRootCapability = await authorizeInstallRoot({
    candidate: installRoot,
    env: { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", USERPROFILE: "C:\\Users\\tester" },
    maxRelativePath: 80,
    access: async () => {},
    realpath: async (value) => value,
    lstat: async (value) => {
      const info = await lstat(value);
      return {
        dev: info.dev, ino: info.ino,
        isDirectory: () => info.isDirectory(),
        isSymbolicLink: () => info.isSymbolicLink(),
        isReparsePoint: () => false,
      };
    },
  });
  const fileCapabilities = createWindowsFileCapabilities({
    nativeApi: createWin32FileApi(),
  });
  const capabilities = createGitIdentityCapabilities({
    fileCapabilities,
    installRootCapability,
    async hashFile(value) {
      return createHash("sha256").update(await readFile(value)).digest("hex");
    },
    retainedInstallerStore: { async deleteVerified() {} },
  });
  const discovery = {
    kind: "external", ownership: "external", version: "2.50.0",
    installDir: gitRoot, executablePath, uninstallerPath, registryKey: "HKLM\\Git",
  };
  let pin;
  try {
    pin = await capabilities.pinPlan({
      installerPath, installerSha256, targetDir: gitRoot, discovery,
    });
    await assert.rejects(rename(executablePath, movedExecutablePath), (error) => (
      ["EBUSY", "EPERM", "EACCES"].includes(error?.code)
    ));
    await capabilities.releaseMutable(pin);
    await rename(executablePath, movedExecutablePath);
    await capabilities.revalidate(pin, { installerSha256 });
  } finally {
    if (pin) await capabilities.release(pin).catch(() => {});
    await unlink(movedExecutablePath).catch(() => {});
    await unlink(executablePath).catch(() => {});
    await unlink(uninstallerPath).catch(() => {});
    await unlink(installerPath).catch(() => {});
    await rmdir(cmdRoot).catch(() => {});
    await rmdir(gitRoot).catch(() => {});
    await rmdir(downloadsRoot).catch(() => {});
    await rmdir(installRoot).catch(() => {});
  }
});

test("real Win32 accepts and deletes only the verified Git-installer link when link count exceeds one", {
  skip: process.platform !== "win32" ? "requires production Win32 handles" : false,
}, async () => {
  const root = path.win32.join(process.cwd(), `.tmp-cb-git-hardlink-${randomUUID()}`);
  const installerPath = path.win32.join(root, "git-2.51.0.exe");
  const siblingLink = path.win32.join(root, "git-cache-link.exe");
  const data = Buffer.from("signed git installer hardlink fixture");
  const sha256 = createHash("sha256").update(data).digest("hex");
  await mkdir(root);
  await writeFile(installerPath, data);
  await link(installerPath, siblingLink);
  const files = createWindowsFileCapabilities({ nativeApi: createWin32FileApi() });
  let pin = null;
  try {
    await assert.rejects(files.pinArchiveFileNoFollow(installerPath), /hard_link/u);
    pin = await files.pinExecutableFileNoFollow(installerPath);
    await pin.assertStableNoFollow();
    await pin.close();
    pin = null;
    await files.deleteVerifiedExecutableFileNoFollow(installerPath, sha256);
    await assert.rejects(readFile(installerPath), { code: "ENOENT" });
    assert.deepEqual(await readFile(siblingLink), data);
  } finally {
    if (pin) await pin.close().catch(() => {});
    await unlink(installerPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    await unlink(siblingLink).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    await rmdir(root).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  }
});
