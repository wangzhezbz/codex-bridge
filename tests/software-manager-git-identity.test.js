import assert from "node:assert/strict";
import test from "node:test";

import { createGitIdentityCapabilities } from "../desktop/software-manager/git-identity-capabilities.mjs";
import { authorizeInstallRoot } from "../desktop/software-manager/path-policy.mjs";

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

function fixture({ missingAfterDelete = false } = {}) {
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
      async close() { openPins.delete(pin); calls.push(["close-file", filePath]); },
    };
    openPins.add(pin);
    return pin;
  }
  const fileCapabilities = {
    async pinArchiveFileNoFollow(filePath) {
      calls.push(["pin-file", filePath]);
      if (missingAfterDelete && deleted.some((record) => record.path === filePath)) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
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
    external.executablePath,
    external.uninstallerPath,
  ]);
  assert.deepEqual(calls.find(([kind]) => kind === "pin-directory"), ["pin-directory", external.installDir]);
  assert.equal(calls.filter(([kind]) => kind === "hash").length, 2);
  await capabilities.release(pin);
  await assert.rejects(capabilities.revalidate(pin), /git_identity_capability_invalid/u);
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
