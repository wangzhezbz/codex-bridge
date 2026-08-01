import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assetNameForPlatform,
  cleanupManagedUpdateArtifacts,
  fetchLatestRelease,
  fetchInitForUpdateDownload,
  generateMacPortableUpdateScript,
  generateWindowsPortableUpdateScript,
  inferUpdateInstallKind,
  installedLegacyAppCleanupTargets,
  installedAppVersionCleanupTargets,
  isNewerVersion,
  planReleaseUpdate,
  updateDownloadProxyLabel,
  validateDownloadedReleaseAsset,
} from "../desktop/updater.mjs";

const release = {
  tag_name: "v0.1.66",
  name: "v0.1.66",
  html_url: "https://github.com/wangzhezbz/codex-bridge/releases/tag/v0.1.66",
  body: "Release notes",
  assets: [
    {
      name: "CodexBridge-Windows-x64-Setup.exe",
      browser_download_url:
        "https://github.com/wangzhezbz/codex-bridge/releases/download/v0.1.66/CodexBridge-Windows-x64-Setup.exe",
      size: 146000000,
      digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    {
      name: "CodexBridge-Windows-x64-Portable.zip",
      browser_download_url:
        "https://github.com/wangzhezbz/codex-bridge/releases/download/v0.1.66/CodexBridge-Windows-x64-Portable.zip",
      size: 144000000,
      digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    {
      name: "CodexBridge-macOS-arm64-Portable.zip",
      browser_download_url:
        "https://github.com/wangzhezbz/codex-bridge/releases/download/v0.1.66/CodexBridge-macOS-arm64-Portable.zip",
      size: 115000000,
      digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    },
    {
      name: "CodexBridge-macOS-x64-Portable.zip",
      browser_download_url:
        "https://github.com/wangzhezbz/codex-bridge/releases/download/v0.1.66/CodexBridge-macOS-x64-Portable.zip",
      size: 121000000,
      digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    },
  ],
};

test("updater compares release versions without string-order mistakes", () => {
  assert.equal(isNewerVersion("v0.1.66", "0.1.65"), true);
  assert.equal(isNewerVersion("v0.1.65", "0.1.65"), false);
  assert.equal(isNewerVersion("v0.1.9", "0.1.10"), false);
  assert.equal(isNewerVersion("v0.2.0", "0.1.99"), true);
});

test("updater selects the preferred install asset for the current platform", () => {
  assert.equal(assetNameForPlatform("win32", "x64", { installKind: "installed" }), "CodexBridge-Windows-x64-Setup.exe");
  assert.equal(assetNameForPlatform("win32", "x64", { installKind: "portable" }), "CodexBridge-Windows-x64-Portable.zip");
  assert.equal(assetNameForPlatform("darwin", "arm64"), "CodexBridge-macOS-arm64-Portable.zip");
  assert.equal(assetNameForPlatform("darwin", "x64"), "CodexBridge-macOS-x64-Portable.zip");
  assert.equal(assetNameForPlatform("linux", "x64"), null);
});

test("updater treats unknown packaged Windows apps as installer updates unless explicitly portable", () => {
  const detected = inferUpdateInstallKind({
    appIsPackaged: true,
    platform: "win32",
    execPath: "D:\\Apps\\CodexBridge\\CodexBridge.exe",
    localAppData: "C:\\Users\\me\\AppData\\Local",
    registryRoot: "",
  });
  const forcedPortable = inferUpdateInstallKind({
    forcedInstallKind: "portable",
    appIsPackaged: true,
    platform: "win32",
    execPath: "D:\\Apps\\CodexBridge\\CodexBridge.exe",
    localAppData: "C:\\Users\\me\\AppData\\Local",
    registryRoot: "",
  });

  assert.equal(detected, "installed");
  assert.equal(forcedPortable, "portable");
});

test("updater detects official Windows portable update layouts", () => {
  assert.equal(
    inferUpdateInstallKind({
      appIsPackaged: true,
      platform: "win32",
      execPath: "D:\\CodexBridge-Windows-x64-Portable-v0.2.3\\CodexBridge-win32-x64\\CodexBridge.exe",
      localAppData: "C:\\Users\\me\\AppData\\Local",
      registryRoot: "",
    }),
    "portable",
  );
  assert.equal(
    inferUpdateInstallKind({
      appIsPackaged: true,
      platform: "win32",
      execPath: "D:\\CodexBridgePortable\\CodexBridge.exe",
      localAppData: "C:\\Users\\me\\AppData\\Local",
      registryRoot: "",
      portableMarkerFound: true,
    }),
    "portable",
  );
});

test("updater plans a direct install from the latest matching release asset", () => {
  const plan = planReleaseUpdate({
    currentVersion: "0.1.65",
    platform: "win32",
    arch: "x64",
    installKind: "installed",
    release,
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.updateAvailable, true);
  assert.equal(plan.latestVersion, "0.1.66");
  assert.equal(plan.asset.name, "CodexBridge-Windows-x64-Setup.exe");
  assert.equal(plan.asset.kind, "installer");
  assert.equal(
    plan.asset.sha256,
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  assert.match(plan.asset.downloadUrl, /v0\.1\.66/);
});

test("updater refuses automatic installation when the selected release asset has no trusted SHA-256 digest", () => {
  const releaseWithoutDigest = {
    ...release,
    assets: release.assets.map(({ digest: _digest, ...asset }) => asset),
  };

  const plan = planReleaseUpdate({
    currentVersion: "0.1.65",
    platform: "win32",
    arch: "x64",
    installKind: "installed",
    release: releaseWithoutDigest,
  });

  assert.equal(plan.ok, false);
  assert.equal(plan.updateAvailable, false);
  assert.equal(plan.asset, undefined);
  assert.match(plan.message, /SHA-256/);
});

test("updater refuses malformed or non-SHA-256 release digests", () => {
  const releaseWithMalformedDigest = {
    ...release,
    assets: release.assets.map((asset, index) => index === 0
      ? { ...asset, digest: "sha512:not-a-trusted-sha256" }
      : asset),
  };

  const plan = planReleaseUpdate({
    currentVersion: "0.1.65",
    platform: "win32",
    arch: "x64",
    installKind: "installed",
    release: releaseWithMalformedDigest,
  });

  assert.equal(plan.ok, false);
  assert.equal(plan.updateAvailable, false);
  assert.match(plan.message, /SHA-256/);
});

test("updater marks Windows setup as primary while preserving portable fallback metadata", () => {
  const plan = planReleaseUpdate({
    currentVersion: "0.1.65",
    platform: "win32",
    arch: "x64",
    installKind: "installed",
    release,
  });

  assert.equal(plan.installMode, "windows_setup");
  assert.equal(plan.asset.kind, "installer");
  assert.equal(plan.fallbackAsset.name, "CodexBridge-Windows-x64-Portable.zip");
  assert.equal(plan.fallbackAsset.kind, "portable");
  assert.doesNotMatch(plan.nextStep, /Windows Setup installer will be saved|updates folder|manual fallback/);
});

test("updater keeps portable builds on auto-applied portable packages even when setup exists", () => {
  const plan = planReleaseUpdate({
    currentVersion: "0.1.65",
    platform: "win32",
    arch: "x64",
    installKind: "portable",
    release,
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.asset.name, "CodexBridge-Windows-x64-Portable.zip");
  assert.equal(plan.asset.kind, "portable");
  assert.equal(plan.installMode, "portable_replacement");
  assert.equal(plan.fallbackAsset, null);
  assert.match(plan.nextStep, /自动|重启|新版/);
  assert.doesNotMatch(plan.nextStep, /手动|manual fallback|updates folder/);
});

test("installed Windows updater refuses portable fallback when no installer is published", () => {
  const portableOnlyRelease = {
    ...release,
    assets: release.assets.filter((asset) => asset.name !== "CodexBridge-Windows-x64-Setup.exe"),
  };
  const plan = planReleaseUpdate({
    currentVersion: "0.1.65",
    platform: "win32",
    arch: "x64",
    installKind: "installed",
    release: portableOnlyRelease,
  });

  assert.equal(plan.ok, false);
  assert.equal(plan.updateAvailable, false);
  assert.equal(plan.asset, undefined);
  assert.match(plan.message, /CodexBridge-Windows-x64-Setup\.exe/);
  assert.match(plan.message, /Setup\.exe|installer|安装器/i);
});

test("portable Windows updater still uses the portable asset when no installer is published", () => {
  const portableOnlyRelease = {
    ...release,
    assets: release.assets.filter((asset) => asset.name !== "CodexBridge-Windows-x64-Setup.exe"),
  };
  const plan = planReleaseUpdate({
    currentVersion: "0.1.65",
    platform: "win32",
    arch: "x64",
    installKind: "portable",
    release: portableOnlyRelease,
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.asset.name, "CodexBridge-Windows-x64-Portable.zip");
  assert.equal(plan.asset.kind, "portable");
  assert.equal(plan.installMode, "portable_replacement");
  assert.equal(plan.fallbackAsset, null);
  assert.match(plan.nextStep, /自动|重启|新版/);
  assert.doesNotMatch(plan.nextStep, /手动|manual fallback|updates folder/);
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

test("updater downloads use configured proxy settings", () => {
  const original = snapshotProxyEnv();
  try {
    clearProxyEnv();
    process.env.HTTPS_PROXY = "http://user:secret@127.0.0.1:7890";

    const init = fetchInitForUpdateDownload(
      "https://github.com/wangzhezbz/codex-bridge/releases/download/v0.1.77/CodexBridge-Windows-x64-Portable.zip",
      { headers: { "user-agent": "CodexBridge" } },
    );
    const label = updateDownloadProxyLabel(
      "https://github.com/wangzhezbz/codex-bridge/releases/download/v0.1.77/package.zip",
    );

    assert.ok(init.dispatcher, "expected updater download to use proxy dispatcher");
    assert.match(label, /^env:/);
    assert.doesNotMatch(label, /secret/);
  } finally {
    restoreProxyEnv(original);
  }
});

test("updater release checks use configured proxy settings", async () => {
  const original = snapshotProxyEnv();
  let seenInit = null;
  try {
    clearProxyEnv();
    process.env.HTTPS_PROXY = "http://127.0.0.1:7890";

    await fetchLatestRelease({
      releaseUrl: "https://api.github.com/repos/wangzhezbz/codex-bridge/releases/latest",
      fetchImpl: async (_url, init) => {
        seenInit = init;
        return new Response(JSON.stringify(release), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    assert.ok(seenInit?.dispatcher, "expected update check to use proxy dispatcher");
  } finally {
    restoreProxyEnv(original);
  }
});

test("updater falls back to GitHub latest redirect when release API is rate limited", async () => {
  const seenUrls = [];

  const latest = await fetchLatestRelease({
    releaseUrl: "https://api.github.com/repos/wangzhezbz/codex-bridge/releases/latest",
    fetchImpl: async (url, init) => {
      seenUrls.push(String(url));
      if (seenUrls.length === 1) {
        return new Response("rate limited", { status: 403 });
      }

      assert.equal(init.redirect, "manual");
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://github.com/wangzhezbz/codex-bridge/releases/tag/v0.1.94",
        },
      });
    },
  });

  assert.deepEqual(seenUrls, [
    "https://api.github.com/repos/wangzhezbz/codex-bridge/releases/latest",
    "https://github.com/wangzhezbz/codex-bridge/releases/latest",
  ]);
  assert.equal(latest.tag_name, "v0.1.94");
  assert.equal(
    latest.assets.find((asset) => asset.name === "CodexBridge-Windows-x64-Setup.exe")
      ?.browser_download_url,
    "https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-Windows-x64-Setup.exe",
  );
  assert.match(latest.body, /GitHub API 不可用/);
  assert.doesNotMatch(latest.body, /GitHub API unavailable/);

  const plan = planReleaseUpdate({
    currentVersion: "0.1.93",
    platform: "win32",
    arch: "x64",
    release: latest,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.updateAvailable, false);
  assert.equal(plan.latestVersion, "0.1.94");
  assert.equal(plan.asset, undefined);
  assert.match(plan.message, /SHA-256/);
});

test("updater reports release API and latest-page fallback failures in Chinese", async () => {
  const seenUrls = [];

  await assert.rejects(
    () => fetchLatestRelease({
      releaseUrl: "https://api.github.com/repos/wangzhezbz/codex-bridge/releases/latest",
      fetchImpl: async (url) => {
        seenUrls.push(String(url));
        if (seenUrls.length === 1) {
          return new Response("rate limited", { status: 403 });
        }
        return new Response("<html>oops</html>", { status: 500 });
      },
    }),
    (error) => {
      assert.match(error.message, /检查更新失败/);
      assert.match(error.message, /GitHub API 返回 HTTP 403/);
      assert.match(error.message, /releases\/latest 兜底也失败/);
      assert.match(error.message, /无法从 HTTP 500 解析最新版本标签/);
      assert.doesNotMatch(error.message, /GitHub API unavailable|fallback failed|could not resolve latest/);
      return true;
    },
  );

  assert.deepEqual(seenUrls, [
    "https://api.github.com/repos/wangzhezbz/codex-bridge/releases/latest",
    "https://github.com/wangzhezbz/codex-bridge/releases/latest",
  ]);
});

test("updater rejects downloaded installer and portable assets with invalid file headers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-updates-headers-"));
  const installerPath = path.join(root, "CodexBridge-Windows-x64-Setup.exe");
  const portablePath = path.join(root, "CodexBridge-Windows-x64-Portable.zip");
  fs.writeFileSync(installerPath, "<!doctype html><title>502 Bad Gateway</title>");
  fs.writeFileSync(portablePath, "<!doctype html><title>502 Bad Gateway</title>");

  await assert.rejects(
    async () => validateDownloadedReleaseAsset(installerPath, {
      kind: "installer",
      name: "CodexBridge-Windows-x64-Setup.exe",
      sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
    /invalid.*installer.*header/i,
  );
  await assert.rejects(
    async () => validateDownloadedReleaseAsset(portablePath, {
      kind: "portable",
      name: "CodexBridge-Windows-x64-Portable.zip",
      sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }),
    /invalid.*portable.*header/i,
  );

  fs.writeFileSync(
    installerPath,
    Buffer.concat([
      Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
      Buffer.from("signed installer payload"),
    ]),
  );
  fs.writeFileSync(
    portablePath,
    Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("signed portable payload"),
    ]),
  );
  assert.equal((await validateDownloadedReleaseAsset(installerPath, {
    kind: "installer",
    name: "CodexBridge-Windows-x64-Setup.exe",
    sha256: "b38a46aee5fb4a5c300773996ccd68fe4627f59db8fb8ef8e52ad26793366eea",
  })).ok, true);
  assert.equal((await validateDownloadedReleaseAsset(portablePath, {
    kind: "portable",
    name: "CodexBridge-Windows-x64-Portable.zip",
    sha256: "0c080cdf8b045f23e0ee0088aa508c2462038f848f7221bac0f2dd59cf0fc574",
  })).ok, true);
});

test("updater rejects a tampered package even when its executable header is valid", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-updates-digest-"));
  const packagePath = path.join(root, "CodexBridge-Windows-x64-Setup.exe");
  fs.writeFileSync(
    packagePath,
    Buffer.concat([
      Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
      Buffer.from("signed installer payload"),
    ]),
  );
  const asset = {
    kind: "installer",
    name: "CodexBridge-Windows-x64-Setup.exe",
    sha256: "b38a46aee5fb4a5c300773996ccd68fe4627f59db8fb8ef8e52ad26793366eea",
  };

  assert.equal((await validateDownloadedReleaseAsset(packagePath, asset)).ok, true);
  fs.appendFileSync(packagePath, "tampered");
  await assert.rejects(
    async () => validateDownloadedReleaseAsset(packagePath, asset),
    /SHA-256.*mismatch/i,
  );
});

test("updater refuses a valid-looking package when the trusted digest is missing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-updates-no-digest-"));
  const packagePath = path.join(root, "CodexBridge-Windows-x64-Portable.zip");
  fs.writeFileSync(packagePath, Buffer.from([0x50, 0x4b, 0x03, 0x04]));

  await assert.rejects(
    async () => validateDownloadedReleaseAsset(packagePath, {
      kind: "portable",
      name: "CodexBridge-Windows-x64-Portable.zip",
    }),
    /missing.*SHA-256/i,
  );
});

test("updater cleans old managed update artifacts while keeping the newest package", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-updates-"));
  const files = [
    "2026-06-28-010000000-CodexBridge-Windows-x64-Setup.exe",
    "install-update-2026-06-28-010000000.txt",
    "2026-06-28-020000000-CodexBridge-Windows-x64-Setup.exe",
    "install-update-2026-06-28-020000000.txt",
    "keep-user-file.txt",
  ];
  for (const file of files) {
    fs.writeFileSync(path.join(root, file), file);
  }

  await cleanupManagedUpdateArtifacts(root, { keepPackages: 1 });

  assert.equal(fs.existsSync(path.join(root, "2026-06-28-010000000-CodexBridge-Windows-x64-Setup.exe")), false);
  assert.equal(fs.existsSync(path.join(root, "install-update-2026-06-28-010000000.txt")), false);
  assert.equal(fs.existsSync(path.join(root, "2026-06-28-020000000-CodexBridge-Windows-x64-Setup.exe")), true);
  assert.equal(fs.existsSync(path.join(root, "install-update-2026-06-28-020000000.txt")), true);
  assert.equal(fs.existsSync(path.join(root, "keep-user-file.txt")), true);

  for (const file of fs.readdirSync(root)) {
    fs.rmSync(path.join(root, file), { force: true });
  }
  fs.rmdirSync(root);
});

test("updater keeps cleaning side files when a managed package is temporarily locked", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-updates-locked-"));
  const files = [
    "2026-06-28-010000000-CodexBridge-Windows-x64-Setup.exe",
    "install-update-2026-06-28-010000000.txt",
    "2026-06-28-020000000-CodexBridge-Windows-x64-Setup.exe",
    "install-update-2026-06-28-020000000.txt",
  ];
  for (const file of files) {
    fs.writeFileSync(path.join(root, file), file);
  }

  const result = await cleanupManagedUpdateArtifacts(root, {
    keepPackages: 1,
    removeFile: async (filePath, options) => {
      if (filePath.endsWith("2026-06-28-010000000-CodexBridge-Windows-x64-Setup.exe")) {
        throw new Error("file is locked by installer");
      }
      await fs.promises.rm(filePath, options);
    },
  });

  assert.equal(result.deleted.length, 1);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].message, /locked/);
  assert.equal(fs.existsSync(path.join(root, "2026-06-28-010000000-CodexBridge-Windows-x64-Setup.exe")), true);
  assert.equal(fs.existsSync(path.join(root, "install-update-2026-06-28-010000000.txt")), false);
  assert.equal(fs.existsSync(path.join(root, "2026-06-28-020000000-CodexBridge-Windows-x64-Setup.exe")), true);
  assert.equal(fs.existsSync(path.join(root, "install-update-2026-06-28-020000000.txt")), true);

  for (const file of fs.readdirSync(root)) {
    fs.rmSync(path.join(root, file), { force: true });
  }
  fs.rmdirSync(root);
});

test("updater selects only previous versioned app directories for installed cleanup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-installed-cleanup-"));
  const current = path.join(root, "app-0.2.3");
  const previous = path.join(root, "app-0.2.2");
  const otherRoot = path.join(root, "other-install-root");
  const previousOtherRoot = path.join(otherRoot, "app-0.1.9");
  const unrelated = path.join(root, "logs");
  for (const dir of [current, previous, previousOtherRoot, unrelated]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(root, "app-0.2.1.txt"), "not a directory");

  const targets = await installedAppVersionCleanupTargets({
    installedRoots: [root, otherRoot, root],
    currentAppDir: current,
  });

  assert.deepEqual(targets.sort(), [previous, previousOtherRoot].sort());

  for (const file of [path.join(root, "app-0.2.1.txt")]) {
    fs.rmSync(file, { force: true });
  }
  for (const dir of [previousOtherRoot, otherRoot, previous, current, unrelated, root]) {
    fs.rmdirSync(dir);
  }
});

test("updater selects only known legacy installed app files for cleanup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-installed-legacy-cleanup-"));
  const current = path.join(root, "app-0.2.3");
  const resourcesApp = path.join(root, "resources", "app");
  const locales = path.join(root, "locales");
  for (const dir of [current, resourcesApp, locales]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(current, "CodexBridge.exe"), "new exe");
  fs.writeFileSync(path.join(root, "CodexBridge.exe"), "old exe");
  fs.writeFileSync(path.join(resourcesApp, "package.json"), JSON.stringify({ name: "codexbridge" }));
  fs.writeFileSync(path.join(locales, "en-US.pak"), "locale");
  fs.writeFileSync(path.join(root, "user-note.txt"), "keep me");

  const targets = await installedLegacyAppCleanupTargets({
    installedRoots: [root],
    currentAppDir: current,
  });

  assert.deepEqual(
    targets.map((target) => ({ path: target.path, kind: target.kind })).sort((left, right) => left.path.localeCompare(right.path)),
    [
      { path: path.join(root, "CodexBridge.exe"), kind: "file" },
      { path: locales, kind: "directory" },
      { path: path.join(root, "resources"), kind: "directory" },
    ].sort((left, right) => left.path.localeCompare(right.path)),
  );

  for (const file of [
    path.join(locales, "en-US.pak"),
    path.join(resourcesApp, "package.json"),
    path.join(current, "CodexBridge.exe"),
    path.join(root, "CodexBridge.exe"),
    path.join(root, "user-note.txt"),
  ]) {
    fs.rmSync(file, { force: true });
  }
  for (const dir of [
    resourcesApp,
    path.join(root, "resources"),
    locales,
    current,
    root,
  ]) {
    fs.rmdirSync(dir);
  }
});

test("Windows portable updater script replaces and restarts without batch deletion", () => {
  const script = generateWindowsPortableUpdateScript({
    parentPid: 1234,
    blockingPids: [5678],
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
  assert.match(script, /function Find-CodexBridgeAppDir/);
  assert.match(script, /function Remove-FileSafely/);
  assert.match(script, /function Remove-DirectoryTreeSafely/);
  assert.match(script, /function Wait-AppDirectoryProcessesExit/);
  assert.match(script, /Get-CimInstance Win32_Process/);
  assert.match(script, /Stop-Process -Id \$runningPid -Force/);
  assert.match(script, /Updater script started/);
  assert.match(script, /Current app directory: \$CURRENT_APP_DIR/);
  assert.match(script, /Update package: \$ZIP_PATH/);
  assert.match(script, /Update work directory: \$WORK_DIR/);
  assert.match(script, /\$EXE_NAME = 'CodexBridge\.exe'/);
  assert.match(script, /function Show-UpdateNotice/);
  assert.match(script, /function Convert-UpdateText/);
  assert.match(script, /FromBase64String/);
  assert.match(script, /WScript\.Shell/);
  assert.match(script, /Q29kZXhCcmlkZ2Ug5q2j5Zyo5a6J6KOF5pu05paw/);
  assert.doesNotMatch(script, /CodexBridge is installing the update/);
  assert.match(script, /Invoke-UpdateStep "Renaming current app directory"/);
  assert.match(script, /Invoke-UpdateStep "Moving new app directory into place"/);
  assert.match(script, /Show-UpdateFailure \$failureMessage/);
  assert.match(script, /Open-UpdateFolder/);
  assert.match(script, /function Restore-PreviousAppDirectory/);
  assert.match(script, /function Start-CodexBridgeAfterFailure/);
  assert.match(script, /Restore-PreviousAppDirectory/);
  assert.match(script, /Start-CodexBridgeAfterFailure/);
  assert.match(script, /5pu05paw5aSx6LSl77yb5bey5bC96YeP5oGi5aSN5bm26YeN5ZCv5pen54mI5pys44CC/);
  assert.match(script, /Start-Sleep -Seconds 8/);
  assert.doesNotMatch(script, /Update failed; old app directory was restored and left closed/);
  assert.match(script, /resources\\app\\package\.json/);
  assert.match(script, /-ArgumentList "--updated"/);
  assert.match(script, /-WorkingDirectory \$CURRENT_APP_DIR -PassThru/);
  assert.match(script, /Updated CodexBridge exited immediately after launch/);
  assert.match(script, /Remove-DirectoryTreeSafely \$backupDir/);
  assert.match(script, /Remove-DirectoryTreeSafely \$extractDir/);
  assert.match(script, /Remove-FileSafely \$ZIP_PATH/);
  assert.match(script, /5pu05paw5a6M5oiQ77yM5pen54mI5pys5bey56e76Zmk44CC/);
  assert.match(script, /\$\{EXE_NAME\}: \$AppDir/);
  assert.doesNotMatch(script, /\$EXE_NAME:/);
  assert.match(script, /\$WAIT_PIDS = @\(1234, 5678\)/);
  assert.match(script, /Waiting for process \$TargetPid to exit/);
  assert.doesNotMatch(script, /Remove-Item\s+-Recurse|rm\s+-rf|rmdir\s+\/s|rd\s+\/s|del\s+\/s/i);
});

test("Windows portable updater defaults to the CodexBridge executable name", () => {
  const script = generateWindowsPortableUpdateScript({
    zipPath: "C:\\updates\\CodexBridge.zip",
    currentAppDir: "C:\\Tools\\CodexBridge-win32-x64",
    workDir: "C:\\updates",
    logPath: "C:\\updates\\update.log",
  });

  assert.match(script, /\$EXE_NAME = 'CodexBridge\.exe'/);
  assert.doesNotMatch(script, /\$EXE_NAME = ''/);
});

test("Windows portable updater script parses in PowerShell", { skip: process.platform !== "win32" }, () => {
  const script = generateWindowsPortableUpdateScript({
    parentPid: 1234,
    blockingPids: [5678],
    zipPath: "C:\\Users\\me\\AppData\\Roaming\\CodexBridge\\updates\\CodexBridge.zip",
    currentAppDir: "C:\\Tools\\CodexBridge-win32-x64",
    exeName: "CodexBridge.exe",
    workDir: "C:\\Users\\me\\AppData\\Roaming\\CodexBridge\\updates",
    logPath: "C:\\Users\\me\\AppData\\Roaming\\CodexBridge\\logs\\update.log",
  });

  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "$script = [Console]::In.ReadToEnd(); [scriptblock]::Create($script) | Out-Null",
    ],
    {
      input: script,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
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

function snapshotProxyEnv() {
  const snapshot = {};
  for (const key of proxyEnvKeys()) {
    snapshot[key] = process.env[key];
  }
  return snapshot;
}

function restoreProxyEnv(snapshot) {
  clearProxyEnv();
  for (const [key, value] of Object.entries(snapshot)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}

function clearProxyEnv() {
  for (const key of proxyEnvKeys()) {
    delete process.env[key];
  }
}

function proxyEnvKeys() {
  return [
    "CODEXBRIDGE_HTTPS_PROXY",
    "CODEXBRIDGE_HTTP_PROXY",
    "CODEXBRIDGE_ALL_PROXY",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "https_proxy",
    "http_proxy",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
  ];
}
