import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  assetNameForPlatform,
  fetchLatestRelease,
  fetchInitForUpdateDownload,
  generateMacPortableUpdateScript,
  generateWindowsPortableUpdateScript,
  isNewerVersion,
  planReleaseUpdate,
  updateDownloadProxyLabel,
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
    },
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

test("updater selects the preferred install asset for the current platform", () => {
  assert.equal(assetNameForPlatform("win32", "x64"), "CodexBridge-Windows-x64-Setup.exe");
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
  assert.equal(plan.asset.name, "CodexBridge-Windows-x64-Setup.exe");
  assert.equal(plan.asset.kind, "installer");
  assert.match(plan.asset.downloadUrl, /v0\.1\.66/);
});

test("updater marks Windows setup as primary while preserving portable fallback metadata", () => {
  const plan = planReleaseUpdate({
    currentVersion: "0.1.65",
    platform: "win32",
    arch: "x64",
    release,
  });

  assert.equal(plan.installMode, "windows_setup");
  assert.equal(plan.asset.kind, "installer");
  assert.equal(plan.fallbackAsset.name, "CodexBridge-Windows-x64-Portable.zip");
  assert.equal(plan.fallbackAsset.kind, "portable");
  assert.match(plan.nextStep, /Windows Setup/);
  assert.match(plan.nextStep, /updates/);
});

test("updater falls back to the portable asset when no installer is published", () => {
  const portableOnlyRelease = {
    ...release,
    assets: release.assets.filter((asset) => asset.name !== "CodexBridge-Windows-x64-Setup.exe"),
  };
  const plan = planReleaseUpdate({
    currentVersion: "0.1.65",
    platform: "win32",
    arch: "x64",
    release: portableOnlyRelease,
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.asset.name, "CodexBridge-Windows-x64-Portable.zip");
  assert.equal(plan.asset.kind, "portable");
  assert.equal(plan.installMode, "manual_portable");
  assert.equal(plan.fallbackAsset, null);
  assert.match(plan.nextStep, /manual fallback/);
  assert.match(plan.nextStep, /updates/);
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

  const plan = planReleaseUpdate({
    currentVersion: "0.1.93",
    platform: "win32",
    arch: "x64",
    release: latest,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.updateAvailable, true);
  assert.equal(plan.latestVersion, "0.1.94");
  assert.equal(plan.asset.kind, "installer");
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
  assert.match(script, /function Wait-AppDirectoryProcessesExit/);
  assert.match(script, /Get-CimInstance Win32_Process/);
  assert.match(script, /Stop-Process -Id \$runningPid -Force/);
  assert.match(script, /Updater script started/);
  assert.match(script, /Current app directory: \$CURRENT_APP_DIR/);
  assert.match(script, /Update package: \$ZIP_PATH/);
  assert.match(script, /Update work directory: \$WORK_DIR/);
  assert.match(script, /\$EXE_NAME = 'CodexBridge\.exe'/);
  assert.match(script, /function Show-UpdateNotice/);
  assert.match(script, /WScript\.Shell/);
  assert.match(script, /CodexBridge is installing the update/);
  assert.match(script, /Invoke-UpdateStep "Renaming current app directory"/);
  assert.match(script, /Invoke-UpdateStep "Moving new app directory into place"/);
  assert.match(script, /Show-UpdateFailure \$failureMessage/);
  assert.match(script, /Open-UpdateFolder/);
  assert.match(script, /function Restore-PreviousAppDirectory/);
  assert.match(script, /function Start-CodexBridgeAfterFailure/);
  assert.match(script, /Restore-PreviousAppDirectory/);
  assert.match(script, /Start-CodexBridgeAfterFailure/);
  assert.match(script, /Update failed; previous app was restored and restarted when possible/);
  assert.match(script, /Start-Sleep -Seconds 8/);
  assert.doesNotMatch(script, /Update failed; old app directory was restored and left closed/);
  assert.match(script, /resources\\app\\package\.json/);
  assert.match(script, /-ArgumentList "--updated"/);
  assert.match(script, /-WorkingDirectory \$CURRENT_APP_DIR -PassThru/);
  assert.match(script, /Updated CodexBridge exited immediately after launch/);
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
