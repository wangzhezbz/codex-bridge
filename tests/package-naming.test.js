import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const originalCodexCliPath = process.env.CODEX_CLI_PATH;
const originalChatGptDesktopExe = process.env.CHATGPT_DESKTOP_EXE;
let hermeticCodexCliRoot = "";

test.before(() => {
  hermeticCodexCliRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openai-package-cli-fixture-"));
  const fakeCodexCliPath = path.join(hermeticCodexCliRoot, "codex.exe");
  const fakeChatGptDesktopPath = path.join(hermeticCodexCliRoot, "ChatGPT.exe");
  fs.writeFileSync(fakeCodexCliPath, "not a real executable", "utf8");
  fs.writeFileSync(fakeChatGptDesktopPath, "not a real executable", "utf8");
  process.env.CODEX_CLI_PATH = fakeCodexCliPath;
  process.env.CHATGPT_DESKTOP_EXE = fakeChatGptDesktopPath;
});

test.after(() => {
  if (originalCodexCliPath === undefined) {
    delete process.env.CODEX_CLI_PATH;
  } else {
    process.env.CODEX_CLI_PATH = originalCodexCliPath;
  }
  if (originalChatGptDesktopExe === undefined) {
    delete process.env.CHATGPT_DESKTOP_EXE;
  } else {
    process.env.CHATGPT_DESKTOP_EXE = originalChatGptDesktopExe;
  }
  const fakeCodexCliPath = path.join(hermeticCodexCliRoot, "codex.exe");
  const fakeChatGptDesktopPath = path.join(hermeticCodexCliRoot, "ChatGPT.exe");
  if (fs.existsSync(fakeCodexCliPath)) {
    fs.unlinkSync(fakeCodexCliPath);
  }
  if (fs.existsSync(fakeChatGptDesktopPath)) {
    fs.unlinkSync(fakeChatGptDesktopPath);
  }
  if (hermeticCodexCliRoot && fs.existsSync(hermeticCodexCliRoot)) {
    fs.rmdirSync(hermeticCodexCliRoot);
  }
});

test("bundled router examples keep experimental smart routing explicitly disabled", () => {
  for (const fileName of ["router.config.example.json", "router.config.hybrid.example.json"]) {
    const configPath = path.join(process.cwd(), "config", fileName);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

    assert.deepEqual(
      config.smartRouting,
      {
        autoSelectModel: false,
        autoFailover: false,
      },
      `${fileName} must not publish auto routing as enabled or implicit`,
    );
  }
});

test("duplicate request protection is disabled by default in both bundled router examples", () => {
  for (const fileName of ["router.config.example.json", "router.config.hybrid.example.json"]) {
    const configPath = path.join(process.cwd(), "config", fileName);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

    assert.equal(
      config.duplicateRequestProtection,
      false,
      `${fileName} must publish duplicate-request protection as explicit opt-in`,
    );
  }
});

test("bundled router examples require an external local token instead of publishing a shared secret", () => {
  for (const fileName of ["router.config.example.json", "router.config.hybrid.example.json"]) {
    const configPath = path.join(process.cwd(), "config", fileName);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

    assert.equal(config.authToken, undefined);
    assert.equal(config.authTokenEnv, "CODEXBRIDGE_ROUTER_TOKEN");
  }
  const allApiConfig = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "config", "router.config.example.json"),
      "utf8",
    ),
  );
  assert.equal(allApiConfig.clientAuth.allowOpenAiBearer, false);
});

test("bundled router examples use stateless native Responses for DeepSeek V4 Flash", () => {
  for (const fileName of ["router.config.example.json", "router.config.hybrid.example.json"]) {
    const configPath = path.join(process.cwd(), "config", fileName);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const flash = config.models.find((model) => model.model === "deepseek-v4-flash");

    assert.ok(flash, `${fileName} must include DeepSeek V4 Flash`);
    assert.equal(flash.api, "responses");
    assert.equal(flash.baseUrl, "https://api.deepseek.com");
    assert.equal(flash.contextWindow, 1048576);
    assert.equal(flash.supportsResponsePreviousId, false);
    assert.equal(flash.supportsFiles, "text-placeholder");
  }
});

test("project and Windows CI gates include the complete desktop refresh flow", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
  );
  const workflow = fs.readFileSync(
    path.join(process.cwd(), ".github", "workflows", "desktop-portable.yml"),
    "utf8",
  );

  assert.match(
    packageJson.scripts["check:syntax"],
    /desktop\/provider-model-refresh-flow\.mjs/,
    "the new desktop flow module must be syntax checked",
  );
  assert.match(
    packageJson.scripts["check:syntax"],
    /tests\/provider-model-refresh-flow\.test\.js/,
    "the new desktop flow test must be syntax checked",
  );
  assert.match(
    packageJson.scripts["test:desktop"],
    /tests\/provider-model-refresh-flow\.test\.js/,
    "the new desktop flow test must run in the full project gate",
  );
  assert.match(
    workflow,
    /- name: Run full project check\s+env:\s+CODEXBRIDGE_SKIP_WINDOWS_HOSTED_RUNNER_INTEGRATION: "1"\s+run: npm run check/,
    "Windows CI must use the same complete check gate as local verification",
  );
});

test("Windows release gate transitively runs the real Electron long-path smoke", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
  );
  const workflow = fs.readFileSync(
    path.join(process.cwd(), ".github", "workflows", "desktop-portable.yml"),
    "utf8",
  );
  const smokeGate = packageJson.scripts["check:software-manager-win32"];

  assert.equal(typeof smokeGate, "string", "the Win32 smoke must have a fixed npm gate");
  assert.match(
    smokeGate,
    /node --test tests\/software-manager-win32-long-path-smoke\.test\.js/u,
    "the fixed gate must execute the real Electron >260 path lifecycle test",
  );
  assert.match(
    packageJson.scripts.check,
    /npm run check:software-manager-win32/u,
    "the full project check must retain the Win32 smoke gate",
  );
  assert.match(
    workflow,
    /jobs:\s+windows:[\s\S]*?- name: Run full project check[\s\S]*?run: npm run check[\s\S]*?\n  macos:/u,
    "the Windows release workflow must retain the full project check before packaging",
  );
});

test("embedded Bridge model selector omits GPT from labels without changing model values", () => {
  const html = fs.readFileSync(
    path.join(process.cwd(), "vendor", "chatgpt-codex-bridge", "public", "index.html"),
    "utf8",
  );
  const visibleModels = [...html.matchAll(/<option value="(gpt-[^"]+)">([^<]+)<\/option>/g)]
    .map((match) => [match[1], match[2].trim()]);

  assert.deepEqual(visibleModels, [
    ["gpt-5.6-sol", "5.6 Sol"],
    ["gpt-5.5", "5.5"],
    ["gpt-5.4", "5.4"],
    ["gpt-5.3", "5.3"],
  ]);
});

test("Windows CI runs OS integration tests in the user profile temp directory", () => {
  const workflow = fs.readFileSync(
    path.join(process.cwd(), ".github", "workflows", "desktop-portable.yml"),
    "utf8",
  );

  assert.match(workflow, /Join-Path \$env:USERPROFILE "AppData\\Local\\Temp"/);
  assert.match(workflow, /"TEMP=\$userTemp"/);
  assert.match(workflow, /"TMP=\$userTemp"/);
  assert.doesNotMatch(workflow, /"TEMP=\$env:RUNNER_TEMP"/);
  assert.doesNotMatch(workflow, /"TMP=\$env:RUNNER_TEMP"/);
});

test("desktop security policy runs in the fixed syntax and desktop gates", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
  );

  assert.match(
    packageJson.scripts["check:syntax"],
    /desktop\/window-security\.cjs/,
  );
  assert.match(
    packageJson.scripts["check:syntax"],
    /tests\/desktop-window-security\.test\.js/,
  );
  assert.match(
    packageJson.scripts["test:desktop"],
    /tests\/desktop-window-security\.test\.js/,
  );
});

test("desktop quit path does not send renderer updates after the window is destroyed", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "desktop", "main.cjs"), "utf8");

  assert.match(main, /function sendToRenderer/);
  assert.match(main, /webContents\.isDestroyed\(\)/);
  assert.match(main, /requestManagedAppQuit\("before-quit"\)/);
  assert.match(main, /managedQuitReady/);
  assert.match(main, /loadRouterLifecycleController\(\)\)\.quit\(\{ reason \}\)/);
  assert.match(main, /if \(managedQuitReady\)/);
  assert.doesNotMatch(main, /mainWindow\?\.webContents\.send/);
});

test("desktop enforces a single running instance", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "desktop", "main.cjs"), "utf8");
  const lockIndex = main.indexOf("requestSingleInstanceLock");
  const readyIndex = main.indexOf("app.whenReady()");

  assert.notEqual(lockIndex, -1);
  assert.notEqual(readyIndex, -1);
  assert.ok(lockIndex < readyIndex, "single instance lock must be acquired before app.whenReady()");
  assert.match(main, /app\.on\("second-instance"/);
  assert.match(main, /showMainWindow\(\)/);
});

test("desktop updater waits for router child process before replacing portable files", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "desktop", "main.cjs"), "utf8");

  assert.match(main, /blockingPids:\s*\[routerProcess\?\.pid\]\.filter\(Boolean\)/);
});

test("desktop update launches installers and portable replacements automatically", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "desktop", "main.cjs"), "utf8");

  assert.match(main, /prepareInstallerUpdate/);
  assert.match(main, /async function currentInstallKind/);
  assert.match(main, /installKind:\s*await currentInstallKind\(\)/);
  assert.match(main, /inferUpdateInstallKind/);
  assert.match(main, /portableMarkerFound:\s*windowsPortableMarkerFound\(appDir\)/);
  assert.match(main, /installedRootFromRegistry/);
  assert.match(main, /reg\.exe/);
  assert.match(main, /HKCU\\\\Software\\\\CodexBridge/);
  assert.match(main, /launchDownloadedInstaller\(prepared\.installerPath\)/);
  assert.match(main, /await shell\.openPath\(installerPath\)/);
  assert.doesNotMatch(main, /spawn\(installerPath,\s*\["\/S"\]/);
  assert.doesNotMatch(main, /"\/S"/);
  assert.match(main, /phase:\s*"launching"/);
  assert.match(main, /quitAfterUpdateLaunch\(\)/);
  assert.match(main, /installerPath:\s*prepared\.installerPath/);
  assert.match(main, /installerNotePath:\s*prepared\.installerNotePath/);
  assert.match(main, /updateFolder:\s*prepared\.updatesDir/);
  assert.match(main, /nextStep:/);
  assert.match(main, /validateDownloadedReleaseAsset\?\.\(installerPath,\s*plan\.asset\)/);
  assert.match(main, /preparePortableUpdate/);
  assert.match(main, /launchPortableUpdateScript\(prepared\.scriptPath\)/);
  assert.match(main, /phase:\s*"restarting"/);
  assert.match(main, /relaunching:\s*true/);
  assert.match(main, /downloadPath:\s*prepared\.downloadPath/);
  assert.match(main, /manualNotePath:\s*prepared\.manualNotePath/);
  assert.match(main, /validateDownloadedReleaseAsset\?\.\(downloadPath,\s*plan\.asset\)/);
  assert.match(main, /writeInstallerUpdateInstructions/);
  assert.match(main, /CodexBridge Windows 安装器更新说明/);
  assert.match(main, /当前正在运行的旧版不会被静默覆盖/);
  assert.doesNotMatch(main, /Windows Setup installer update/);
  assert.doesNotMatch(main, /Update package ready for manual install/);
  assert.doesNotMatch(main, /shell\.showItemInFolder\(prepared\.downloadPath\)/);
  assert.doesNotMatch(main, /onSpawn:\s*\(\) => exitForPortableUpdate\(\)/);
});

test("desktop auto-launches the portable updater from the running app", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "desktop", "main.cjs"), "utf8");

  assert.match(main, /function launchPortableUpdateScript\(scriptPath\)/);
  assert.match(main, /spawn\("powershell\.exe",\s*\[/);
  assert.match(main, /"-ExecutionPolicy",\s*"Bypass"/);
  assert.match(main, /"-File",\s*scriptPath/);
  assert.match(main, /child\.unref\?\.\(\)/);
  assert.match(main, /quitAfterUpdateLaunch\(\)/);
  assert.doesNotMatch(main, /function launchPortableUpdater/);
  assert.doesNotMatch(main, /function exitForPortableUpdate/);
  assert.doesNotMatch(main, /spawn\("cmd\.exe"/);
  assert.doesNotMatch(main, /start "" \/min powershell\.exe/);
});

test("desktop updater uses the data update folder and auto-cleans update artifacts", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "desktop", "main.cjs"), "utf8");

  assert.match(main, /const updatesDir = portableUpdatesDir\(\)/);
  assert.match(main, /return path\.join\(dataRootDir,\s*"updates"\)/);
  assert.doesNotMatch(main, /path\.resolve\(path\.dirname\(process\.execPath\), "\.\.", "updates"\)/);
  assert.doesNotMatch(main, /path\.join\(path\.dirname\(currentMacAppBundle\(\)\), "updates"\)/);
  assert.match(main, /const downloadPath = path\.join\(updatesDir, `\$\{stamp\}-\$\{plan\.asset\.name\}`\)/);
  assert.match(main, /const finalBytes = fs\.statSync\(targetPath\)\.size/);
  assert.match(main, /更新包下载不完整/);
  assert.match(main, /function writeManualUpdateInstructions/);
  assert.match(main, /CodexBridge 免安装更新兜底说明/);
  assert.match(main, /自动更新通常会在下载后启动辅助脚本/);
  assert.match(main, /如果自动更新没有重启/);
  assert.doesNotMatch(main, /Portable update fallback instructions/);
  assert.doesNotMatch(main, /Automatic update should launch the helper script/);
  assert.doesNotMatch(main, /If automatic update does not restart/);
  assert.doesNotMatch(main, /The automatic updater normally backs up/);
  assert.doesNotMatch(main, /path\.join\(updatesDir, "downloads"\)/);
});

test("desktop update completion uses in-app notification instead of a native message box", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "desktop", "main.cjs"), "utf8");

  assert.match(main, /updates:finished/);
  let checked = 0;
  let cursor = 0;
  while (true) {
    const index = main.indexOf('sendToRenderer("updates:finished"', cursor);
    if (index === -1) {
      break;
    }
    const region = main.slice(Math.max(0, index - 500), index + 500);
    assert.doesNotMatch(region, /dialog\.showMessageBox\(mainWindow/);
    checked += 1;
    cursor = index + 1;
  }
  assert.ok(checked >= 1);
});

test("desktop smoke checks cover capability diagnostics and project recovery", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "desktop", "main.cjs"), "utf8");
  const start = main.indexOf("async function runDesktopSmokeChecks");
  assert.notEqual(start, -1);
  const smoke = main.slice(start);

  assert.match(smoke, /"#capabilities"/);
  assert.match(smoke, /"#capabilitySummary"/);
  assert.match(smoke, /"#capabilityDiagnostics"/);
  assert.match(smoke, /"#capabilityProviderForm"/);
  assert.match(smoke, /"#recoverCodexProjects"/);
  assert.match(smoke, /"#imageProviderForm"/);
  assert.match(smoke, /"#testImageProvider"/);
  assert.match(smoke, /"#imageGenerationHistory"/);
  assert.match(smoke, /"#usageBudgetScope"/);
  assert.match(smoke, /"#usageBudgetTarget"/);
  assert.match(smoke, /"#resourceSearch"/);
  assert.match(smoke, /"#resourceStatusFilter"/);
  assert.match(smoke, /"#refreshResources"/);
  assert.match(smoke, /exactResourceSummaryRequired/);
  assert.match(smoke, /resourceRefreshButton\.click\(\)/);
  assert.match(smoke, /"#exportConfigPackage"/);
  assert.match(smoke, /"#importConfigPackage"/);
  assert.match(smoke, /"data-export-all-sessions"/);
}
);

test("Windows packaged smoke writes a machine-readable report for release preflight", () => {
  const smoke = fs.readFileSync(path.join(process.cwd(), "scripts", "smoke-packaged-windows.mjs"), "utf8");
  const main = fs.readFileSync(path.join(process.cwd(), "desktop", "main.cjs"), "utf8");

  assert.match(smoke, /packaged-smoke-report\.json/);
  assert.match(smoke, /CODEXBRIDGE_PACKAGED_SMOKE_REPORT/);
  assert.match(smoke, /function writeSmokeReport/);
  assert.match(smoke, /desktopSmoke/);
  assert.match(smoke, /routerSmoke/);
  assert.match(smoke, /checkedAt/);
  assert.match(smoke, /CODEXBRIDGE_DESKTOP_SMOKE_START_ROUTER/);
  assert.match(smoke, /duplicateRequestProtection:\s*true/);
  assert.match(smoke, /model\s*=\s*"gpt-5\.5"/);
  assert.match(smoke, /approval_policy\s*=\s*"on-request"/);
  assert.match(smoke, /CODEXBRIDGE_DESKTOP_SMOKE_HOME:\s*smokeHomeDir/);
  assert.doesNotMatch(smoke, /USERPROFILE:\s*smokeHomeDir/);
  assert.match(main, /window\.codexBridge\.startRouter\(\)/);
  assert.match(main, /window\.codexBridge\.stopRouter\(\)/);
  assert.match(main, /duplicateRequestProtection !== false/);
});

test("Windows packaged smoke rejects stale Embedded Bridge contents", () => {
  const smoke = fs.readFileSync(path.join(process.cwd(), "scripts", "smoke-packaged-windows.mjs"), "utf8");

  assert.match(smoke, /embedded-manifest\.json/);
  assert.match(smoke, /bridge-api-client\.js/);
  assert.match(smoke, /visible-branding\.js/);
  assert.match(smoke, /bridge-auth\.js/);
  assert.match(smoke, /extensionProtocolVersion/);
  assert.match(smoke, /v20260801-adaptive-office-wait/);
  assert.match(smoke, /@hono["',]+\s*"node-server/);
  assert.match(smoke, /fast-uri/);
  assert.match(smoke, /assertDependencyVersionAtLeast/);
});

test("desktop cleans old managed update artifacts and previous installed apps after update", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "desktop", "main.cjs"), "utf8");

  assert.match(main, /cleanupUpdateArtifactsOnStartup/);
  assert.match(main, /cleanupManagedUpdateArtifacts\?\.\(portableUpdatesDir\(\),\s*\{\s*keepPackages:\s*launchedAfterUpdate \? 0 : 1\s*\}\)/);
  assert.match(main, /cleanupInstalledAppVersionsAfterUpdate/);
  assert.match(main, /cleanupInstallerPackageAfterUpdate/);
  assert.match(main, /updatePreviousInstallDir\(\)/);
  assert.match(main, /updateCleanupInstallerPath\(\)/);
  assert.match(main, /cleanupInstallerPackageAfterUpdate\(0\)/);
  assert.match(main, /setTimeout\(\(\) => cleanupInstallerPackageAfterUpdate\(attempt \+ 1\), 3000\)/);
  assert.match(main, /installedLegacyAppCleanupTargets\?\.\(/);
  assert.match(main, /managedUpdateDirectoryCleanupTargets\?\.\(portableUpdatesDir\(\)\)/);
  assert.match(main, /cleanupMacAppBackupsAfterRendererReady/);
  assert.match(main, /managedMacAppBackupCleanupTargets\?\.\(\{ currentAppBundle \}\)/);
  assert.match(main, /removeInstalledCleanupTargetSafeSync/);
  assert.match(main, /removeDirectoryTreeSafeSync/);
  assert.match(main, /prepareInstallerUpdate/);
  assert.match(main, /keepPackages:\s*1/);
});

test("desktop empty usage summary includes fresh and cache token fields", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "desktop", "main.cjs"), "utf8");

  assert.match(main, /freshPromptTokens:\s*0/);
  assert.match(main, /cacheReadTokens:\s*0/);
  assert.match(main, /cacheCreationTokens:\s*0/);
});

test("desktop restart finds ChatGPT and Codex across common install locations and shortcuts", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "desktop", "main.cjs"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));

  assert.match(main, /async function codexDesktopLaunchCandidates/);
  assert.match(main, /codexDesktopShortcutTargets/);
  assert.match(main, /resolveWindowsShortcutTarget/);
  assert.match(main, /where\.exe/);
  assert.match(main, /CODEX_DESKTOP_EXE/);
  assert.match(main, /CHATGPT_DESKTOP_EXE/);
  assert.match(main, /settings\.loadDesktopOptions\(dataRootDir\)/);
  assert.match(main, /canonicalSavedOpenAIDesktopTarget\(desktopOptions\)/);
  assert.match(main, /codexDesktopExe/);
  assert.match(main, /codexDesktopLaunchTarget/);
  assert.match(main, /codex:select-exe/);
  assert.match(main, /Choose ChatGPT\.exe, Codex\.exe, or a compatible shortcut/);
  assert.match(main, /findCodexDesktopShortcuts/);
  assert.match(main, /launchCodexDesktopTarget/);
  assert.match(main, /explorer\.exe/);
  assert.match(main, /require\("node:os"\)/);
  assert.match(main, /windowsCodexDesktopEnvDefaults/);
  assert.match(main, /os\.homedir\(\)/);
  assert.match(main, /publicProfile/);
  assert.match(main, /ChatGPT\.lnk/);
  assert.match(main, /Codex\.lnk/);
  assert.match(main, /where\.exe[\s\S]*ChatGPT\.exe/);
  assert.match(main, /where\.exe[\s\S]*Codex\.exe/);
  assert.match(pkg.scripts["check:syntax"], /desktop\/openai-desktop-compat\.cjs/);
});

test("desktop router watchdog restarts crashed routers unless the user stopped it", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "desktop", "main.cjs"), "utf8");

  assert.match(main, /ROUTER_RESTART_MAX_ATTEMPTS/);
  assert.match(main, /scheduleRouterRestart\(code\)/);
  assert.doesNotMatch(main, /routerStopRequested/);
  assert.match(main, /if \(isQuitting \|\| routerProcess \|\| routerRestartTimer\)/);
  assert.match(main, /cancelRouterRestartTimer\(\)/);
  assert.match(main, /options\.watchdog/);
  assert.match(main, /ROUTER_RESTART_MAX_DELAY_MS/);
});

test("desktop opens local folders only after ensuring they exist", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "desktop", "main.cjs"), "utf8");

  assert.match(main, /function ensureFolderForOpen/);
  assert.match(main, /fs\.mkdirSync\(resolvedFolder,\s*\{\s*recursive:\s*true\s*\}\)/);
  assert.match(main, /const openError = await shell\.openPath\(folder\)/);
  assert.match(main, /if \(openError\)/);
});

test("Windows release archive uses formal portable package naming", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  const workflow = fs.readFileSync(
    path.join(process.cwd(), ".github", "workflows", "desktop-portable.yml"),
    "utf8",
  );
  const packager = fs.readFileSync(
    path.join(process.cwd(), "scripts", "package-windows.mjs"),
    "utf8",
  );
  const artifactsScriptPath = path.join(process.cwd(), "scripts", "package-windows-release-artifacts.mjs");
  const artifactsScript = fs.existsSync(artifactsScriptPath)
    ? fs.readFileSync(artifactsScriptPath, "utf8")
    : "";

  assert.equal(packageJson.scripts["package:win:artifacts"], "node scripts/package-windows-release-artifacts.mjs");
  assert.match(packageJson.scripts["check:syntax"], /scripts\/package-windows-release-artifacts\.mjs/);
  assert.match(workflow, /CodexBridge-Windows-x64-Portable\.zip/);
  assert.match(workflow, /CodexBridge-Windows-x64-Setup\.exe/);
  assert.match(workflow, /releases\/latest\/download\/CodexBridge-Windows-x64-Portable\.zip/);
  assert.match(workflow, /releases\/latest\/download\/CodexBridge-Windows-x64-Setup\.exe/);
  assert.match(workflow, /npm run package:win:artifacts/);
  assert.match(workflow, /choco install nsis -y/);
  assert.doesNotMatch(workflow, /Compress-Archive -Path \(Join-Path \$portableZipRoot "\*"\)/);
  assert.doesNotMatch(workflow, /& \$makensis/);
  assert.match(artifactsScript, /CodexBridge-Windows-x64-Portable\.zip/);
  assert.match(artifactsScript, /CodexBridge-Windows-x64-Setup\.exe/);
  assert.match(artifactsScript, /\.codexbridge-portable/);
  assert.match(artifactsScript, /makensis/);
  assert.match(artifactsScript, /CodexBridge\.nsi/);
  assert.match(artifactsScript, /--portable-only/);
  assert.match(packager, /\\\.tmp-updates-/);
  assert.match(packager, /\\\.tmp-release-/);
  assert.match(workflow, /Smoke test Windows release archive/);
  assert.match(workflow, /CodexBridge\.exe/);
  assert.match(workflow, /Join-Path \$extractPath "\.codexbridge-portable"/);
  assert.doesNotMatch(workflow, /Compress-Archive -Path "release\/\*"/);
  assert.match(workflow, /prerelease: false/);
  assert.doesNotMatch(workflow, /CodexBridge-windows-portable/);
  assert.doesNotMatch(workflow, /files: dist-artifacts\/\*/);
  assert.match(workflow, /files:\s*\|[\s\S]*release-assets\/CodexBridge-Windows-x64-Setup\.exe/);
  assert.match(workflow, /files:\s*\|[\s\S]*release-assets\/CodexBridge-Windows-x64-Portable\.zip/);
  assert.match(workflow, /files:\s*\|[\s\S]*release-assets\/CodexBridge-macOS-arm64-Portable\.zip/);
  assert.match(workflow, /files:\s*\|[\s\S]*release-assets\/CodexBridge-macOS-x64-Portable\.zip/);
  assert.match(packager, /CODEXBRIDGE_RELEASE_VERSION/);
  assert.match(packager, /CodexBridge-Windows-x64-Portable-/);
  assert.match(packager, /codexbridge-icon\.ico/);
  assert.match(packager, /\^\\\/\\\.agents/);
  assert.match(packager, /\^\\\/\\\.codex/);
  assert.match(packager, /\^\\\/\\\.superpowers/);
  assert.match(packager, /\^\\\/\\\.tmp/);
  assert.match(packager, /\\\.tmp-release-/);
});

test("Windows packaged smoke validates the app in the real user data filesystem", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "scripts", "smoke-packaged-windows.mjs"),
    "utf8",
  );
  assert.match(source, /process\.env\.LOCALAPPDATA/);
  assert.match(source, /path\.win32\.isAbsolute\(localAppData\)/);
});

test("GitHub release publishing flattens and verifies every downloadable asset", () => {
  const workflow = fs.readFileSync(
    path.join(process.cwd(), ".github", "workflows", "desktop-portable.yml"),
    "utf8",
  );
  assert.match(workflow, /Prepare verified release assets/);
  assert.match(workflow, /find dist-artifacts -type f -name/);
  assert.match(workflow, /test -s "release-assets\/\$name"/);
  for (const name of [
    "CodexBridge-Windows-x64-Setup.exe",
    "CodexBridge-Windows-x64-Portable.zip",
    "CodexBridge-macOS-arm64-Portable.zip",
    "CodexBridge-macOS-x64-Portable.zip",
  ]) {
    assert.match(workflow, new RegExp(`release-assets/${name.replaceAll(".", "\\.")}`));
  }
});

test("Windows release artifact script creates portable zip and setup with injected makensis", {
  skip: process.platform !== "win32",
}, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-artifacts-test-"));
  const appDir = path.join(tempDir, "CodexBridge-win32-x64");
  const outDir = path.join(tempDir, "dist-artifacts");
  const fakeMakensis = path.join(tempDir, "fake-makensis.mjs");
  fs.mkdirSync(path.join(appDir, "resources", "app", "src"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "CodexBridge.exe"), "fake exe", "utf8");
  fs.writeFileSync(path.join(appDir, "resources", "app", "package.json"), "{}", "utf8");
  fs.writeFileSync(path.join(appDir, "resources", "app", "src", "server.js"), "console.log('router');\n", "utf8");
  fs.writeFileSync(fakeMakensis, `
import fs from "node:fs";
const args = process.argv.slice(2);
if (args.includes("/VERSION")) {
  console.log("fake makensis 3.0");
  process.exit(0);
}
const outArg = args.find((arg) => arg.startsWith("/DOUT_FILE="));
if (!outArg) {
  throw new Error("missing /DOUT_FILE");
}
fs.writeFileSync(outArg.slice("/DOUT_FILE=".length), "fake setup", "utf8");
`, "utf8");

  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/package-windows-release-artifacts.mjs",
    "--app-dir",
    appDir,
    "--out-dir",
    outDir,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MAKENSIS_EXE: process.execPath,
      MAKENSIS_EXTRA_ARGS: JSON.stringify([fakeMakensis]),
    },
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  const portableZip = path.join(outDir, "CodexBridge-Windows-x64-Portable.zip");
  const setupExe = path.join(outDir, "CodexBridge-Windows-x64-Setup.exe");
  assert.match(stdout, /Windows release artifacts created/);
  assert.ok(fs.statSync(portableZip).size > 0);
  assert.equal(fs.readFileSync(setupExe, "utf8"), "fake setup");

  const { stdout: entryOutput } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead('${portableZip.replace(/'/g, "''")}'); try { @($z.Entries | ForEach-Object FullName) | ConvertTo-Json -Compress } finally { $z.Dispose() }`,
  ], {
    cwd: process.cwd(),
    windowsHide: true,
  });
  const zipEntries = JSON.parse(entryOutput.trim());
  assert.equal(zipEntries.includes(".codexbridge-portable"), true);
  assert.equal(zipEntries.some((entry) => entry === "./" || entry.startsWith("./")), false);

  const extractDir = path.join(tempDir, "extract");
  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Expand-Archive -LiteralPath '${portableZip.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
  ], {
    cwd: process.cwd(),
    windowsHide: true,
  });
  assert.equal(fs.existsSync(path.join(extractDir, ".codexbridge-portable")), true);
  assert.equal(fs.existsSync(path.join(extractDir, "CodexBridge.exe")), true);
  assert.equal(fs.existsSync(path.join(extractDir, "resources", "app", "package.json")), true);
});

test("Windows installer script installs a versioned app and does not batch-delete", () => {
  const installer = fs.readFileSync(
    path.join(process.cwd(), "scripts", "installer", "windows", "CodexBridge.nsi"),
    "utf8",
  );

  assert.match(installer, /InstallDir "\$LOCALAPPDATA\\Programs\\CodexBridge"/);
  assert.match(installer, /!insertmacro MUI_PAGE_DIRECTORY/);
  assert.match(installer, /SetOutPath "\$INSTDIR\\app-\$\{VERSION\}"/);
  assert.match(installer, /File \/r "\$\{APP_DIR\}\\\*\.\*"/);
  assert.match(installer, /CreateShortCut "\$DESKTOP\\CodexBridge\.lnk"/);
  assert.match(installer, /Var PREVIOUS_INSTALL_DIR/);
  assert.match(installer, /ReadRegStr \$PREVIOUS_INSTALL_DIR HKCU "Software\\CodexBridge" "InstallRoot"/);
  assert.match(installer, /WriteRegStr HKCU "Software\\CodexBridge" "CurrentVersion"/);
  assert.match(installer, /WriteRegStr HKCU "Software\\CodexBridge" "InstallRoot" "\$INSTDIR"/);
  assert.match(installer, /ExecShell "" "\$INSTDIR\\app-\$\{VERSION\}\\CodexBridge\.exe" "--updated --previous-install-dir/);
  assert.match(installer, /--cleanup-installer/);
  assert.doesNotMatch(installer, /RMDir\s+\/r|Delete\s+\/REBOOTOK|Remove-Item\s+-Recurse|rm\s+-rf|rmdir\s+\/s|rd\s+\/s|del\s+\/s/i);
});

test("release preflight has an explicit CLI gate before packaging", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  const releaseChecklist = fs.readFileSync(path.join(process.cwd(), "docs", "release-checklist.md"), "utf8");
  const releasesDoc = fs.readFileSync(path.join(process.cwd(), "docs", "releases.md"), "utf8");
  const preflightScriptPath = path.join(process.cwd(), "scripts", "release-preflight.mjs");

  assert.equal(packageJson.scripts["release:preflight"], "node scripts/release-preflight.mjs");
  assert.equal(packageJson.scripts["release:gate"], "node scripts/release-preflight.mjs --strict-warnings");
  assert.equal(packageJson.scripts["release:code-ready"], "node scripts/release-preflight.mjs --code-ready");
  assert.match(packageJson.scripts["check:syntax"], /scripts\/release-preflight\.mjs/);
  assert.ok(fs.existsSync(preflightScriptPath));
  assert.match(releaseChecklist, /npm run release:preflight/);
  assert.match(releaseChecklist, /npm run release:code-ready/);
  assert.match(releaseChecklist, /npm run release:gate/);
  assert.match(releaseChecklist, /--strict-warnings/);
  assert.match(releaseChecklist, /codeReady\.ignoredRealEvidenceItemIds/);
  assert.match(releaseChecklist, /releaseGate\.realEvidenceBlockingItemIds/);
  assert.match(releaseChecklist, /releaseGate\.localSetupBlockingItemIds/);
  assert.match(releaseChecklist, /releaseGate\.codeOrConfigBlockingItemIds/);
  assert.match(releaseChecklist, /只保留 `CodexBridge-Windows-x64-Setup\.exe` 和 `CodexBridge-Windows-x64-Portable\.zip`/);
  assert.match(releasesDoc, /npm run release:preflight/);
  assert.match(releasesDoc, /npm run release:code-ready/);
  assert.match(releasesDoc, /npm run release:gate/);
  assert.match(releasesDoc, /--strict-warnings/);
  assert.match(releasesDoc, /codeReady\.ignoredRealEvidenceItemIds/);
  assert.match(releasesDoc, /真实环境验收缺口/);
  assert.match(releasesDoc, /本机配置\/运行待办/);
  assert.match(releasesDoc, /仓库代码\/配置阻断项/);
});

test("release preflight shares one bounded Codex resource discovery snapshot", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts", "release-preflight.mjs"), "utf8");

  assert.match(script, /readCodexResourceSnapshots/);
  assert.match(
    script,
    /const\s+\{\s*codexCliSnapshot,\s*codexPromptInputSnapshot\s*\}\s*=\s*readCodexResourceSnapshots\(\{\s*homeDir\s*\}\)/,
  );
  assert.match(script, /buildStartupCheck[\s\S]*codexCliSnapshot,[\s\S]*codexPromptInputSnapshot,/);
  assert.doesNotMatch(script, /readCodexPromptInputSnapshot\(\{\s*homeDir,\s*timeoutMs:\s*2500\s*\}\)/);
});

test("release preflight plain report uses readable Chinese labels", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts", "release-preflight.mjs"), "utf8");

  assert.match(script, /CodexBridge 发布前体检/);
  assert.match(script, /数据目录:/);
  assert.match(script, /Codex 目录:/);
  assert.match(script, /结果:/);
  assert.match(script, /const reportStatus = releaseReportStatus\(summary, \{ strictWarnings \}\);/);
  assert.match(script, /结果: \$\{reportStatus\}/);
  assert.match(script, /有提醒/);
  assert.match(script, /建议：\$\{item\.action\}/);
  assert.match(script, /发布前体检未通过/);
  assert.doesNotMatch(script, /鍙|鏁|寤|妫|缁|澶|辫|绌/);
});

test("release preflight help points final release checks to the strict gate", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/release-preflight.mjs",
    "--help",
  ], {
    cwd: process.cwd(),
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });

  assert.match(stdout, /npm run release:preflight/);
  assert.match(stdout, /npm run release:code-ready/);
  assert.match(stdout, /npm run release:gate -- --platform win32 --arch x64 --release-dir/);
  assert.match(stdout, /local code readiness/i);
  assert.match(stdout, /strict release gate/i);
  assert.match(stdout, /--code-ready/);
  assert.match(stdout, /--strict-warnings/);
});

test("release preflight strict warnings explain warning-only blockers", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-preflight-strict-data-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-preflight-strict-home-"));
  const configDir = path.join(dataDir, "config");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "router.config.json"),
    JSON.stringify({
      host: "127.0.0.1",
      port: 1,
      authToken: "sk-local-codex-router",
      defaultModel: "deepseek-v4-pro",
      models: [
        {
          id: "deepseek-v4-pro",
          displayName: "DeepSeek V4 Pro",
          api: "chat_completions",
          providerId: "deepseek",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          baseUrl: "https://api.deepseek.com/v1",
          model: "deepseek-v4-pro",
        },
      ],
    }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    path.join(configDir, "secrets.local.json"),
    JSON.stringify({ DEEPSEEK_API_KEY: "sk-test" }, null, 2),
    "utf8",
  );

  let result = null;
  try {
    await execFileAsync(process.execPath, [
      "scripts/release-preflight.mjs",
      "--data-dir",
      dataDir,
      "--home-dir",
      homeDir,
      "--strict-warnings",
      "--platform",
      "win32",
      "--arch",
      "x64",
    ], { cwd: process.cwd() });
  } catch (error) {
    result = error;
  }

  assert.ok(result, "strict warnings should exit non-zero when WARN items exist");
  assert.equal(result.code, 1);
  assert.match(result.stdout, /仓库代码状态: 已收尾/);
  assert.match(result.stdout, /真实环境验收缺口: .*router.*image_generation_proxy.*update_flow/);
  assert.match(result.stdout, /本机配置\/运行待办: .*codex_config.*codex_resources/);
  assert.doesNotMatch(result.stdout, /仓库代码\/配置阻断项:/);
  assert.match(result.stdout, /真实验收下一步（交给真实环境测试，不阻塞本地代码收尾）:[\s\S]*update_flow[\s\S]*(NSIS|makensis|GitHub Actions)/);
  assert.match(result.stdout, /本机配置\/运行下一步（可交给测试机或当前机器处理）:[\s\S]*codex_config[\s\S]*(Router|CodexBridge)/);
  assert.match(result.stdout, /严格模式: 提醒项也会阻止正式发包；真实环境验收缺口请交给拿着真实 Key、真实安装包的人补证据，本地代码不要在这里空转。/);
  assert.match(result.stdout, /严格模式未通过：请先处理 WARN 提醒项；真实验收缺口和本机配置\/运行待办可以记录给测试机处理，仓库代码\/配置阻断项需要在本仓库修掉。/);
  assert.match(result.stdout, /结果: 需要处理/);
});

test("release preflight JSON explains strict warning blockers", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-preflight-strict-json-data-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-preflight-strict-json-home-"));
  const configDir = path.join(dataDir, "config");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "router.config.json"),
    JSON.stringify({
      host: "127.0.0.1",
      port: 1,
      authToken: "sk-local-codex-router",
      defaultModel: "deepseek-v4-pro",
      models: [
        {
          id: "deepseek-v4-pro",
          displayName: "DeepSeek V4 Pro",
          api: "chat_completions",
          providerId: "deepseek",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          baseUrl: "https://api.deepseek.com/v1",
          model: "deepseek-v4-pro",
        },
      ],
    }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    path.join(configDir, "secrets.local.json"),
    JSON.stringify({ DEEPSEEK_API_KEY: "sk-test" }, null, 2),
    "utf8",
  );

  let result = null;
  try {
    await execFileAsync(process.execPath, [
      "scripts/release-preflight.mjs",
      "--data-dir",
      dataDir,
      "--home-dir",
      homeDir,
      "--strict-warnings",
      "--json",
      "--platform",
      "win32",
      "--arch",
      "x64",
    ], { cwd: process.cwd() });
  } catch (error) {
    result = error;
  }

  assert.ok(result, "strict warning JSON should exit non-zero when WARN items exist");
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.releaseGate.ok, false);
  assert.equal(report.releaseGate.strictWarnings, true);
  assert.equal(report.releaseGate.blockedByWarnings, true);
  assert.equal(report.releaseGate.blockedByFailures, false);
  assert.equal(report.releaseGate.reason, "strict_warnings");
  assert.deepEqual(report.releaseGate.failureItemIds, []);
  assert.ok(report.releaseGate.warningItemIds.includes("router"));
  assert.ok(report.releaseGate.warningItemIds.includes("image_generation_proxy"));
  assert.ok(report.releaseGate.warningItemIds.includes("update_flow"));
  assert.ok(report.releaseGate.blockingItemIds.includes("router"));
  assert.ok(report.releaseGate.blockingItemIds.includes("image_generation_proxy"));
  assert.ok(report.releaseGate.blockingItemIds.includes("update_flow"));
  assert.ok(report.releaseGate.realEvidenceRequiredItemIds.includes("router"));
  assert.ok(report.releaseGate.realEvidenceRequiredItemIds.includes("route_health"));
  assert.ok(report.releaseGate.realEvidenceRequiredItemIds.includes("image_generation_proxy"));
  assert.doesNotMatch(report.releaseGate.realEvidenceRequiredItemIds.join(","), /capability_providers/);
  assert.ok(report.releaseGate.realEvidenceRequiredItemIds.includes("real_environment_acceptance"));
  assert.ok(report.releaseGate.realEvidenceRequiredItemIds.includes("update_flow"));
  assert.doesNotMatch(report.releaseGate.realEvidenceRequiredItemIds.join(","), /model_catalog/);
  assert.doesNotMatch(report.releaseGate.realEvidenceRequiredItemIds.join(","), /codex_config/);
  assert.doesNotMatch(report.releaseGate.realEvidenceRequiredItemIds.join(","), /codex_resources/);
  assert.ok(report.releaseGate.realEvidenceBlockingItemIds.includes("update_flow"));
  assert.ok(report.releaseGate.localSetupBlockingItemIds.includes("codex_config"));
  assert.ok(report.releaseGate.localSetupBlockingItemIds.includes("codex_resources"));
  assert.equal(report.releaseGate.codeOrConfigOk, true);
  assert.doesNotMatch(report.releaseGate.codeOrConfigBlockingItemIds.join(","), /codex_config|codex_resources/);
  const updateFlowBlocker = report.releaseGate.realEvidenceBlockingItems.find((item) => item.id === "update_flow");
  assert.ok(updateFlowBlocker, "expected update_flow to include actionable real-evidence blocker details");
  assert.equal(updateFlowBlocker.status, "warn");
  assert.match(updateFlowBlocker.label, /自动更新/);
  assert.match(updateFlowBlocker.detail, /Setup\.exe|makensis|NSIS/);
  assert.match(updateFlowBlocker.action, /NSIS|makensis|GitHub Actions/);
  const codexConfigBlocker = report.releaseGate.localSetupBlockingItems.find((item) => item.id === "codex_config");
  assert.ok(codexConfigBlocker, "expected codex_config to include actionable local setup blocker details");
  assert.match(codexConfigBlocker.action, /Router|CodexBridge 配置/);
});

test("release code-ready accepts the provisioned software-manager catalog trust", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-code-ready-data-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-code-ready-home-"));
  const configDir = path.join(dataDir, "config");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "router.config.json"),
    JSON.stringify({
      host: "127.0.0.1",
      port: 1,
      authToken: "sk-local-codex-router",
      defaultModel: "deepseek-v4-pro",
      models: [
        {
          id: "deepseek-v4-pro",
          displayName: "DeepSeek V4 Pro",
          api: "chat_completions",
          providerId: "deepseek",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          baseUrl: "https://api.deepseek.com/v1",
          model: "deepseek-v4-pro",
        },
      ],
    }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    path.join(configDir, "secrets.local.json"),
    JSON.stringify({ DEEPSEEK_API_KEY: "sk-test" }, null, 2),
    "utf8",
  );

  const result = await execFileAsync(process.execPath, [
      "scripts/release-preflight.mjs",
      "--data-dir",
      dataDir,
      "--home-dir",
      homeDir,
      "--code-ready",
      "--json",
      "--platform",
      "win32",
      "--arch",
      "x64",
  ], {
    cwd: process.cwd(),
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });

  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.codeReady.ok, true);
  assert.equal(report.codeReady.strictWarnings, true);
  assert.equal(report.codeReady.codeOrConfigOk, true);
  assert.equal(report.codeReady.codeOrConfigBlockingItemIds.includes("catalog_trust_not_provisioned"), false);
  assert.ok(report.codeReady.ignoredRealEvidenceItemIds.includes("router"));
  assert.ok(report.codeReady.ignoredRealEvidenceItemIds.includes("image_generation_proxy"));
  assert.ok(report.codeReady.ignoredRealEvidenceItemIds.includes("update_flow"));
  assert.ok(report.codeReady.ignoredLocalSetupItemIds.includes("codex_config"));
  assert.ok(report.codeReady.ignoredLocalSetupItemIds.includes("codex_resources"));
  assert.equal(report.releaseGate.strictWarnings, false);
  assert.equal(report.releaseGate.ok, true);
});

test("release preflight CLI probes a running router before reporting health", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-preflight-data-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-preflight-home-"));
  const server = http.createServer((req, res) => {
    if (req.url !== "/health") {
      res.writeHead(404).end("{}");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      models: ["deepseek-v4-pro"],
      unhealthyRoutes: 0,
      routes: [{ id: "deepseek-v4-pro", status: "healthy" }],
    }));
  });
  await listen(server, 0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  fs.mkdirSync(path.join(dataDir, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "config", "router.config.json"),
    JSON.stringify({
      host: "127.0.0.1",
      port,
      authToken: "sk-local-codex-router",
      defaultModel: "deepseek-v4-pro",
      models: [
        {
          id: "deepseek-v4-pro",
          displayName: "DeepSeek V4 Pro",
          api: "chat_completions",
          providerId: "deepseek",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          baseUrl: "https://api.deepseek.com/v1",
          model: "deepseek-v4-pro",
        },
      ],
    }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    path.join(dataDir, "config", "secrets.local.json"),
    JSON.stringify({ DEEPSEEK_API_KEY: "sk-test" }, null, 2),
    "utf8",
  );
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      "scripts/release-preflight.mjs",
      "--data-dir",
      dataDir,
      "--home-dir",
      homeDir,
      "--json",
    ], {
      cwd: process.cwd(),
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const report = JSON.parse(stdout);
    assert.equal(report.items.find((item) => item.id === "router")?.status, "pass");
    assert.equal(report.items.find((item) => item.id === "route_health")?.status, "pass");
  } finally {
    await closeServer(server);
  }
});

test("release preflight CLI rejects empty release artifacts from a directory", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-preflight-data-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-preflight-home-"));
  const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-release-dir-"));
  fs.writeFileSync(path.join(releaseDir, "CodexBridge-Windows-x64-Setup.exe"), "");
  fs.writeFileSync(path.join(releaseDir, "CodexBridge-Windows-x64-Portable.zip"), "not-empty");

  let stdout = "";
  try {
    const result = await execFileAsync(process.execPath, [
      "scripts/release-preflight.mjs",
      "--data-dir",
      dataDir,
      "--home-dir",
      homeDir,
      "--platform",
      "win32",
      "--arch",
      "x64",
      "--release-dir",
      releaseDir,
      "--json",
    ], {
      cwd: process.cwd(),
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    stdout = error.stdout || "";
  }
  const report = JSON.parse(stdout);
  const updateFlow = report.items.find((item) => item.id === "update_flow");

  assert.equal(report.ok, false);
  assert.equal(updateFlow.status, "fail");
  assert.match(updateFlow.detail, /大小异常|空文件/);
  assert.match(updateFlow.detail, /CodexBridge-Windows-x64-Setup\.exe/);
});

test("release preflight CLI rejects non-empty artifacts with invalid file headers", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-preflight-data-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-preflight-home-"));
  const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-release-dir-"));
  fs.writeFileSync(path.join(releaseDir, "CodexBridge-Windows-x64-Setup.exe"), "not-a-real-exe");
  fs.writeFileSync(path.join(releaseDir, "CodexBridge-Windows-x64-Portable.zip"), "not-a-real-zip");

  let stdout = "";
  try {
    const result = await execFileAsync(process.execPath, [
      "scripts/release-preflight.mjs",
      "--data-dir",
      dataDir,
      "--home-dir",
      homeDir,
      "--platform",
      "win32",
      "--arch",
      "x64",
      "--release-dir",
      releaseDir,
      "--json",
    ], {
      cwd: process.cwd(),
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    stdout = error.stdout || "";
  }
  const report = JSON.parse(stdout);
  const updateFlow = report.items.find((item) => item.id === "update_flow");

  assert.equal(report.ok, false);
  assert.equal(updateFlow.status, "fail");
  assert.match(updateFlow.detail, /格式|文件头|不是有效/);
  assert.match(updateFlow.detail, /CodexBridge-Windows-x64-Setup\.exe/);
  assert.match(updateFlow.detail, /CodexBridge-Windows-x64-Portable\.zip/);
});

test("release preflight CLI reads packaged smoke report evidence", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-preflight-data-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-preflight-home-"));
  const reportPath = path.join(os.tmpdir(), `codexbridge-packaged-smoke-${Date.now()}.json`);
  fs.writeFileSync(
    reportPath,
    JSON.stringify({
      ok: true,
      checkedAt: "2026-07-05T07:15:00.000Z",
      appPath: "F:\\game_code\\router\\release\\CodexBridge-Windows-x64-Portable-v0.2.3-local\\CodexBridge-win32-x64",
      exePath: "F:\\game_code\\router\\release\\CodexBridge-Windows-x64-Portable-v0.2.3-local\\CodexBridge-win32-x64\\CodexBridge.exe",
      desktopSmoke: { ok: true, durationMs: 1100 },
      routerSmoke: { ok: true, durationMs: 800, models: ["gpt-5.5"] },
    }),
    "utf8",
  );

  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/release-preflight.mjs",
    "--data-dir",
    dataDir,
    "--home-dir",
    homeDir,
    "--packaged-smoke-report",
    reportPath,
    "--json",
  ], {
    cwd: process.cwd(),
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  const report = JSON.parse(stdout);
  const smokeItem = report.items.find((item) => item.id === "packaged_app_smoke");

  assert.equal(smokeItem.status, "pass");
  assert.match(smokeItem.detail, /CodexBridge\.exe/);
  assert.match(smokeItem.detail, /Router health smoke/);
});

test("release preflight CLI reads real environment acceptance report evidence", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-preflight-data-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-preflight-home-"));
  const reportPath = path.join(os.tmpdir(), `codexbridge-acceptance-${Date.now()}.json`);
  fs.writeFileSync(
    reportPath,
    JSON.stringify({
      ok: true,
      checkedAt: "2026-07-05T08:10:00.000Z",
      router: {
        ok: true,
        detail: "real router health passed",
        models: ["gpt-5.5"],
      },
      imageProvider: {
        ok: true,
        provider: "SiliconFlow Kolors",
        localPath: "C:\\Users\\Administrator\\Pictures\\CodexBridge\\sample.png",
        durationMs: 1200,
      },
      capabilityProvider: {
        ok: true,
        provider: "Local Chrome Bridge",
        capability: "browser",
        durationMs: 300,
      },
      windowsInstaller: {
        ok: true,
        setupExe: "CodexBridge-Windows-x64-Setup.exe",
        portableZip: "CodexBridge-Windows-x64-Portable.zip",
      },
    }),
    "utf8",
  );

  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/release-preflight.mjs",
    "--data-dir",
    dataDir,
    "--home-dir",
    homeDir,
    "--acceptance-report",
    reportPath,
    "--json",
  ], {
    cwd: process.cwd(),
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  const report = JSON.parse(stdout);
  const acceptanceItem = report.items.find((item) => item.id === "real_environment_acceptance");

  assert.equal(acceptanceItem.status, "pass");
  assert.match(acceptanceItem.detail, /真实 Router/);
  assert.match(acceptanceItem.detail, /都已检查/);
  assert.match(acceptanceItem.detail, /报告时间 2026-07-05T08:10:00\.000Z/);
  assert.equal(report.acceptanceReport.loaded, true);
  assert.equal(report.acceptanceReport.ok, true);
});

test("release preflight CLI explains unreadable real acceptance reports", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-preflight-data-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-preflight-home-"));
  const missingReportPath = path.join(os.tmpdir(), `codexbridge-missing-acceptance-${Date.now()}.json`);

  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/release-preflight.mjs",
    "--data-dir",
    dataDir,
    "--home-dir",
    homeDir,
    "--acceptance-report",
    missingReportPath,
    "--json",
  ], {
    cwd: process.cwd(),
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  const report = JSON.parse(stdout);
  const acceptanceItem = report.items.find((item) => item.id === "real_environment_acceptance");

  assert.equal(acceptanceItem.status, "warn");
  assert.match(acceptanceItem.detail, /正式发包检查还差/);
  assert.match(acceptanceItem.detail, /普通启动.*不受影响/);
  assert.equal(report.acceptanceReport.ok, false);
});

test("release preflight CLI writes a real acceptance report from current evidence", async () => {
  const checkedAt = new Date().toISOString();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-preflight-data-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-preflight-home-"));
  const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-release-dir-"));
  const reportPath = path.join(os.tmpdir(), `codexbridge-written-acceptance-${Date.now()}.json`);
  const configDir = path.join(dataDir, "config");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(releaseDir, "CodexBridge-Windows-x64-Setup.exe"),
    Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
  );
  fs.writeFileSync(
    path.join(releaseDir, "CodexBridge-Windows-x64-Portable.zip"),
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  );
  fs.writeFileSync(
    path.join(configDir, "image-providers.json"),
    JSON.stringify({
      version: 1,
      defaultProviderId: "siliconflow-kolors",
      providers: [
        {
          id: "siliconflow-kolors",
          name: "SiliconFlow Kolors",
          adapter: "siliconflow_images",
          baseUrl: "https://api.siliconflow.cn/v1",
          endpoint: "/images/generations",
          model: "Kwai-Kolors/Kolors",
          apiKeyEnv: "SILICONFLOW_API_KEY",
          lastTest: {
            ok: true,
            checkedAt,
            localPath: "C:\\Users\\Administrator\\Pictures\\CodexBridge\\sample.png",
            durationMs: 1200,
          },
        },
      ],
    }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    path.join(configDir, "capability-providers.json"),
    JSON.stringify({
      version: 1,
      defaults: { browser: "local-browser" },
      providers: [
        {
          id: "local-browser",
          name: "Local Chrome Bridge",
          capability: "browser",
          adapter: "local_browser",
          lastTest: {
            ok: true,
            checkedAt,
            durationMs: 300,
          },
        },
      ],
    }, null, 2),
    "utf8",
  );
  const server = http.createServer((req, res) => {
    if (req.url !== "/health") {
      res.writeHead(404).end("{}");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      models: ["gpt-5.5"],
      unhealthyRoutes: 0,
      routes: [{ id: "gpt-5.5", status: "healthy" }],
    }));
  });
  await listen(server, 0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  fs.writeFileSync(
    path.join(configDir, "router.config.json"),
    JSON.stringify({
      host: "127.0.0.1",
      port,
      authToken: "sk-local-codex-router",
      defaultModel: "deepseek-v4-pro",
      models: [
        {
          id: "deepseek-v4-pro",
          displayName: "DeepSeek V4 Pro",
          api: "chat_completions",
          providerId: "deepseek",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          baseUrl: "https://api.deepseek.com/v1",
          model: "deepseek-v4-pro",
        },
      ],
    }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    path.join(configDir, "secrets.local.json"),
    JSON.stringify({ DEEPSEEK_API_KEY: "sk-test" }, null, 2),
    "utf8",
  );

  try {
    const { stdout } = await execFileAsync(process.execPath, [
      "scripts/release-preflight.mjs",
      "--data-dir",
      dataDir,
      "--home-dir",
      homeDir,
      "--platform",
      "win32",
      "--arch",
      "x64",
      "--release-dir",
      releaseDir,
      "--write-acceptance-report",
      reportPath,
      "--json",
    ], {
      cwd: process.cwd(),
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const report = JSON.parse(stdout);
    const acceptanceItem = report.items.find((item) => item.id === "real_environment_acceptance");
    const written = JSON.parse(fs.readFileSync(reportPath, "utf8"));

    assert.equal(report.acceptanceReport.path, reportPath);
    assert.equal(report.acceptanceReport.written, true);
    assert.equal(report.acceptanceReport.ok, true);
    assert.equal(written.ok, true);
    assert.equal(written.router.ok, true);
    assert.deepEqual(written.router.models, ["gpt-5.5"]);
    assert.equal(written.imageProviders[0].provider, "SiliconFlow Kolors");
    assert.equal(written.imageProviders[0].localPath, "C:\\Users\\Administrator\\Pictures\\CodexBridge\\sample.png");
    assert.equal(written.capabilityProviders[0].provider, "Local Chrome Bridge");
    assert.equal(written.windowsInstaller.ok, true);
    assert.match(written.windowsInstaller.setupExe, /CodexBridge-Windows-x64-Setup\.exe$/);
    assert.match(written.windowsInstaller.portableZip, /CodexBridge-Windows-x64-Portable\.zip$/);
    assert.equal(acceptanceItem.status, "pass");
    assert.match(acceptanceItem.detail, /都已检查/);
    assert.match(acceptanceItem.detail, /报告时间/);
  } finally {
    await closeServer(server);
  }
});

test("release preflight plain report prints acceptance report path", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-preflight-data-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-preflight-home-"));
  const reportPath = path.join(os.tmpdir(), `codexbridge-plain-acceptance-${Date.now()}.json`);
  fs.writeFileSync(
    reportPath,
    JSON.stringify({
      ok: true,
      checkedAt: "2026-07-05T08:30:00.000Z",
      router: { ok: true, detail: "real router health passed", models: ["gpt-5.5"] },
      imageProvider: { ok: true, provider: "SiliconFlow Kolors", durationMs: 1200 },
      capabilityProvider: { ok: true, provider: "Local Chrome Bridge", capability: "browser", durationMs: 300 },
      windowsInstaller: {
        ok: true,
        setupExe: "CodexBridge-Windows-x64-Setup.exe",
        portableZip: "CodexBridge-Windows-x64-Portable.zip",
      },
    }),
    "utf8",
  );

  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/release-preflight.mjs",
    "--data-dir",
    dataDir,
    "--home-dir",
    homeDir,
    "--acceptance-report",
    reportPath,
  ], {
    cwd: process.cwd(),
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });

  assert.match(stdout, /真实检查报告:/);
  assert.match(stdout, /已通过/);
  assert.match(stdout, new RegExp(reportPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("release preflight CLI writes a machine-readable gate report", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-preflight-data-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-preflight-home-"));
  const reportPath = path.join(os.tmpdir(), `codexbridge-release-gate-${Date.now()}.json`);

  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/release-preflight.mjs",
    "--data-dir",
    dataDir,
    "--home-dir",
    homeDir,
    "--write-gate-report",
    reportPath,
    "--json",
  ], {
    cwd: process.cwd(),
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });

  const stdoutReport = JSON.parse(stdout);
  const writtenReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));

  assert.equal(stdoutReport.gateReport.path, reportPath);
  assert.equal(stdoutReport.gateReport.written, true);
  assert.equal(stdoutReport.gateReport.ok, stdoutReport.releaseGate.ok);
  assert.equal(writtenReport.releaseGate.reason, stdoutReport.releaseGate.reason);
  assert.equal(writtenReport.summary.warn, stdoutReport.summary.warn);
  assert.ok(Array.isArray(writtenReport.items));
});

test("GitHub release workflow runs release preflight before packaging", () => {
  const workflow = fs.readFileSync(
    path.join(process.cwd(), ".github", "workflows", "desktop-portable.yml"),
    "utf8",
  );
  const script = fs.readFileSync(path.join(process.cwd(), "scripts", "release-preflight.mjs"), "utf8");
  const windowsPreflightIndex = workflow.indexOf("Run Windows release preflight");
  const windowsPackageIndex = workflow.indexOf("Package Windows portable app");
  const windowsArtifactPreflightIndex = workflow.indexOf("Run Windows release artifact preflight");
  const windowsArtifactIndex = workflow.indexOf("Create Windows release artifacts");
  const windowsSmokeIndex = workflow.indexOf("Smoke test Windows release archive");
  const macPreflightIndex = workflow.indexOf("Run macOS release preflight");
  const macPackageIndex = workflow.indexOf("Package macOS portable app");

  assert.notEqual(windowsPreflightIndex, -1);
  assert.notEqual(windowsArtifactPreflightIndex, -1);
  assert.notEqual(macPreflightIndex, -1);
  assert.ok(windowsPreflightIndex < windowsPackageIndex);
  assert.ok(windowsArtifactIndex < windowsArtifactPreflightIndex);
  assert.ok(windowsArtifactPreflightIndex < windowsSmokeIndex);
  assert.ok(macPreflightIndex < macPackageIndex);
  assert.match(workflow, /node scripts\/release-preflight\.mjs --platform win32 --arch x64/);
  assert.match(workflow, /node scripts\/release-preflight\.mjs --platform win32 --arch x64 --release-dir dist-artifacts/);
  assert.match(workflow, /--write-gate-report windows-release-gate\.json/);
  assert.match(
    workflow,
    /path:\s*\|[\s\S]*dist-artifacts\/CodexBridge-Windows-x64-Setup\.exe[\s\S]*windows-release-gate\.json/,
  );
  assert.match(workflow, /node --check scripts\/release-preflight\.mjs/);
  assert.match(
    workflow,
    /node scripts\/release-preflight\.mjs --platform darwin --arch \$\{\{ matrix\.arch \}\} --write-gate-report macos-\$\{\{ matrix\.arch \}\}-release-gate\.json/,
  );
  assert.match(
    workflow,
    /name: CodexBridge-macOS-\$\{\{ matrix\.arch \}\}-Portable[\s\S]*path:\s*\|[\s\S]*dist-artifacts\/CodexBridge-macOS-\$\{\{ matrix\.arch \}\}-Portable\.zip[\s\S]*macos-\$\{\{ matrix\.arch \}\}-release-gate\.json/,
  );
  assert.match(script, /--release-dir <path>/);
  assert.match(script, /--write-gate-report <path>/);
  assert.match(script, /releaseDir/);
});

test("macOS release archives use formal x64 and arm64 package naming", () => {
  const workflow = fs.readFileSync(
    path.join(process.cwd(), ".github", "workflows", "desktop-portable.yml"),
    "utf8",
  );
  const packager = fs.readFileSync(
    path.join(process.cwd(), "scripts", "package-macos.mjs"),
    "utf8",
  );

  assert.match(workflow, /CodexBridge-macOS-arm64-Portable\.zip/);
  assert.match(workflow, /CodexBridge-macOS-x64-Portable\.zip/);
  assert.match(workflow, /macos-latest/);
  assert.match(workflow, /macos-15-intel/);
  assert.match(workflow, /runner:\s*macos-latest/);
  assert.match(workflow, /runner:\s*macos-15-intel/);
  assert.match(workflow, /CODEXBRIDGE_MAC_ARCH/);
  assert.match(workflow, /releases\/latest\/download\/CodexBridge-macOS-arm64-Portable\.zip/);
  assert.match(workflow, /releases\/latest\/download\/CodexBridge-macOS-x64-Portable\.zip/);
  assert.match(packager, /platform:\s*"darwin"/);
  assert.match(packager, /CodexBridge-macOS-\$\{targetArch\}-Portable-/);
  assert.match(packager, /codexbridge-icon\.icns/);
  assert.match(packager, /\^\\\/\\\.agents/);
  assert.match(packager, /\^\\\/\\\.codex/);
  assert.match(packager, /\^\\\/\\\.superpowers/);
  assert.match(packager, /\^\\\/\\\.tmp/);
});

test("macOS release archives are extracted and checked for Electron Framework", () => {
  const workflow = fs.readFileSync(
    path.join(process.cwd(), ".github", "workflows", "desktop-portable.yml"),
    "utf8",
  );
  const smoke = fs.readFileSync(
    path.join(process.cwd(), "scripts", "smoke-packaged-macos.mjs"),
    "utf8",
  );

  assert.match(workflow, /Smoke test macOS release archive/);
  assert.match(workflow, /ditto -x -k "dist-artifacts\/CodexBridge-macOS-\$\{\{ matrix\.arch \}\}-Portable\.zip"/);
  assert.match(workflow, /Electron Framework\.framework\/Electron Framework/);
  assert.match(workflow, /Electron Framework\.framework\/Versions\/A\/Electron Framework/);
  assert.match(smoke, /Electron Framework\.framework/);
  assert.match(smoke, /Versions",\s*"A",\s*"Electron Framework"/);
  assert.match(smoke, /missing packaged Electron Framework/);
  assert.match(smoke, /missing packaged Electron Framework target/);
});

test("desktop packages include native app icon assets", () => {
  const assetsDir = path.join(process.cwd(), "desktop", "assets");
  const png = fs.readFileSync(path.join(assetsDir, "codexbridge-icon.png"));
  const ico = fs.readFileSync(path.join(assetsDir, "codexbridge-icon.ico"));
  const icns = fs.readFileSync(path.join(assetsDir, "codexbridge-icon.icns"));
  const main = fs.readFileSync(path.join(process.cwd(), "desktop", "main.cjs"), "utf8");

  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
  assert.deepEqual([...ico.subarray(0, 4)], [0, 0, 1, 0]);
  assert.equal(icns.subarray(0, 4).toString("ascii"), "icns");
  assert.match(main, /codexbridge-icon\.png/);
});

test("desktop close button hides to tray instead of quitting", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "desktop", "main.cjs"), "utf8");

  assert.match(main, /\bTray\b/);
  assert.match(main, /\bMenu\b/);
  assert.match(main, /mainWindow\.on\("close"/);
  assert.match(main, /event\.preventDefault\(\)/);
  assert.match(main, /mainWindow\.hide\(\)/);
  assert.match(main, /退出 CodexBridge|Quit CodexBridge/);
});

test("desktop tray exposes quick router, Codex, logs, and profile actions", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "desktop", "main.cjs"), "utf8");

  assert.match(main, /function refreshTrayMenu/);
  assert.match(main, /Router/);
  assert.match(main, /Codex/);
  assert.match(main, /ui:navigate/);
  assert.match(main, /profiles:apply/);
});

test("router checks include the route fidelity and contract matrix suites", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));

  assert.match(pkg.scripts["test:router"], /tests\/route-fidelity-regression\.test\.js/);
  assert.match(pkg.scripts["test:router"], /tests\/route-contract-matrix\.test\.js/);
  assert.match(pkg.scripts["check:syntax"], /src\/route-contract-matrix\.js/);
});

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
