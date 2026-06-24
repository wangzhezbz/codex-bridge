import test from "node:test";
import assert from "node:assert/strict";
import {
  assetNameForPlatform,
  generateMacPortableUpdateScript,
  generateWindowsPortableUpdateScript,
  isNewerVersion,
  planReleaseUpdate,
} from "../desktop/updater.mjs";

const release = {
  tag_name: "v0.1.66",
  name: "v0.1.66",
  html_url: "https://github.com/wangzhezbz/codex-bridge/releases/tag/v0.1.66",
  body: "Release notes",
  assets: [
    {
      name: "CodexBridge-Windows-x64-Portable.zip",
      browser_download_url:
        "https://github.com/wangzhezbz/codex-bridge/releases/download/v0.1.66/CodexBridge-Windows-x64-Portable.zip",
      size: 144000000,
    },
    {
      name: "CodexBridge-macOS-arm64-Portable.zip",
      browser_download_url:
        "https://github.com/wangzhezbz/codex-bridge/releases/download/v0.1.66/CodexBridge-macOS-arm64-Portable.zip",
      size: 115000000,
    },
    {
      name: "CodexBridge-macOS-x64-Portable.zip",
      browser_download_url:
        "https://github.com/wangzhezbz/codex-bridge/releases/download/v0.1.66/CodexBridge-macOS-x64-Portable.zip",
      size: 121000000,
    },
  ],
};

test("updater compares release versions without string-order mistakes", () => {
  assert.equal(isNewerVersion("v0.1.66", "0.1.65"), true);
  assert.equal(isNewerVersion("v0.1.65", "0.1.65"), false);
  assert.equal(isNewerVersion("v0.1.9", "0.1.10"), false);
  assert.equal(isNewerVersion("v0.2.0", "0.1.99"), true);
});

test("updater selects the portable asset for the current platform", () => {
  assert.equal(assetNameForPlatform("win32", "x64"), "CodexBridge-Windows-x64-Portable.zip");
  assert.equal(assetNameForPlatform("darwin", "arm64"), "CodexBridge-macOS-arm64-Portable.zip");
  assert.equal(assetNameForPlatform("darwin", "x64"), "CodexBridge-macOS-x64-Portable.zip");
  assert.equal(assetNameForPlatform("linux", "x64"), null);
});

test("updater plans a direct install from the latest matching release asset", () => {
  const plan = planReleaseUpdate({
    currentVersion: "0.1.65",
    platform: "win32",
    arch: "x64",
    release,
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.updateAvailable, true);
  assert.equal(plan.latestVersion, "0.1.66");
  assert.equal(plan.asset.name, "CodexBridge-Windows-x64-Portable.zip");
  assert.match(plan.asset.downloadUrl, /v0\.1\.66/);
});

test("updater reports current and unsupported states clearly", () => {
  assert.deepEqual(
    planReleaseUpdate({
      currentVersion: "0.1.66",
      platform: "win32",
      arch: "x64",
      release,
    }).updateAvailable,
    false,
  );

  const unsupported = planReleaseUpdate({
    currentVersion: "0.1.65",
    platform: "linux",
    arch: "x64",
    release,
  });
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.message, /暂不支持/);
});

test("Windows portable updater script replaces and restarts without batch deletion", () => {
  const script = generateWindowsPortableUpdateScript({
    parentPid: 1234,
    zipPath: "C:\\Users\\me\\AppData\\Roaming\\CodexBridge\\updates\\CodexBridge.zip",
    currentAppDir: "C:\\Tools\\CodexBridge-win32-x64",
    exeName: "CodexBridge.exe",
    workDir: "C:\\Users\\me\\AppData\\Roaming\\CodexBridge\\updates",
    logPath: "C:\\Users\\me\\AppData\\Roaming\\CodexBridge\\logs\\update.log",
  });

  assert.match(script, /Rename-Item/);
  assert.match(script, /Expand-Archive/);
  assert.match(script, /Move-Item/);
  assert.match(script, /Start-Process/);
  assert.doesNotMatch(script, /Remove-Item\s+-Recurse|rm\s+-rf|rmdir\s+\/s|rd\s+\/s|del\s+\/s/i);
});

test("macOS portable updater script replaces the app bundle without recursive delete", () => {
  const script = generateMacPortableUpdateScript({
    parentPid: 1234,
    zipPath: "/Users/me/Library/Application Support/CodexBridge/updates/CodexBridge.zip",
    currentAppBundle: "/Applications/CodexBridge.app",
    workDir: "/Users/me/Library/Application Support/CodexBridge/updates",
    logPath: "/Users/me/Library/Application Support/CodexBridge/logs/update.log",
  });

  assert.match(script, /ditto -x -k/);
  assert.match(script, /mv "\$CURRENT_APP_BUNDLE"/);
  assert.match(script, /open "\$CURRENT_APP_BUNDLE"/);
  assert.doesNotMatch(script, /rm\s+-rf|Remove-Item\s+-Recurse|rmdir\s+\/s|rd\s+\/s|del\s+\/s/i);
});
