import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("desktop disables Chromium sandbox before app startup on Windows", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "desktop", "main.cjs"), "utf8");
  const sandboxSwitchIndex = main.indexOf('app.commandLine.appendSwitch("no-sandbox")');
  const readyIndex = main.indexOf("app.whenReady()");

  assert.notEqual(sandboxSwitchIndex, -1);
  assert.notEqual(readyIndex, -1);
  assert.ok(
    sandboxSwitchIndex < readyIndex,
    "Chromium sandbox must be disabled before app.whenReady() for affected Windows machines",
  );
  assert.match(main, /CODEXBRIDGE_CHROMIUM_SANDBOX/);
});

test("desktop quit path does not send renderer updates after the window is destroyed", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "desktop", "main.cjs"), "utf8");

  assert.match(main, /function sendToRenderer/);
  assert.match(main, /webContents\.isDestroyed\(\)/);
  assert.match(main, /stopRouter\(\{\s*silent:\s*true\s*\}\)/);
  assert.match(main, /if \(isQuitting\)/);
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
  assert.match(main, /launchDownloadedInstaller\(prepared\.installerPath\)/);
  assert.match(main, /spawn\(installerPath,\s*\["\/S"\]/);
  assert.match(main, /phase:\s*"launching"/);
  assert.match(main, /quitAfterUpdateLaunch\(\)/);
  assert.match(main, /installerPath:\s*prepared\.installerPath/);
  assert.match(main, /installerNotePath:\s*prepared\.installerNotePath/);
  assert.match(main, /updateFolder:\s*prepared\.updatesDir/);
  assert.match(main, /nextStep:/);
  assert.match(main, /preparePortableUpdate/);
  assert.match(main, /launchPortableUpdateScript\(prepared\.scriptPath\)/);
  assert.match(main, /phase:\s*"restarting"/);
  assert.match(main, /relaunching:\s*true/);
  assert.match(main, /downloadPath:\s*prepared\.downloadPath/);
  assert.match(main, /manualNotePath:\s*prepared\.manualNotePath/);
  assert.match(main, /writeInstallerUpdateInstructions/);
  assert.match(main, /Windows Setup installer update/);
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
  assert.match(main, /Portable update fallback instructions/);
  assert.match(main, /Automatic update should launch the helper script/);
  assert.match(main, /If automatic update does not restart/);
  assert.doesNotMatch(main, /The automatic updater normally backs up/);
  assert.doesNotMatch(main, /path\.join\(updatesDir, "downloads"\)/);
});

test("desktop update completion uses in-app notification instead of a native message box", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "desktop", "main.cjs"), "utf8");

  assert.match(main, /updates:finished/);
  assert.doesNotMatch(main, /dialog\.showMessageBox\(mainWindow/);
});

test("desktop cleans old managed update artifacts and previous installed apps after update", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "desktop", "main.cjs"), "utf8");

  assert.match(main, /cleanupUpdateArtifactsOnStartup/);
  assert.match(main, /cleanupManagedUpdateArtifacts\?\.\(portableUpdatesDir\(\),\s*\{\s*keepPackages:\s*launchedAfterUpdate \? 0 : 1\s*\}\)/);
  assert.match(main, /cleanupInstalledAppVersionsAfterUpdate/);
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

test("desktop restart finds Codex across common install locations and shortcuts", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "desktop", "main.cjs"), "utf8");

  assert.match(main, /async function codexDesktopLaunchCandidates/);
  assert.match(main, /codexDesktopShortcutTargets/);
  assert.match(main, /resolveWindowsShortcutTarget/);
  assert.match(main, /where\.exe/);
  assert.match(main, /CODEX_DESKTOP_EXE/);
  assert.match(main, /settings\.loadDesktopOptions\(dataRootDir\)/);
  assert.match(main, /desktopOptions\?\.codexDesktopExe/);
  assert.match(main, /desktopOptions\?\.codexDesktopLaunchTarget/);
  assert.match(main, /codex:select-exe/);
  assert.match(main, /Choose Codex\.exe or shortcut/);
  assert.match(main, /findCodexDesktopShortcuts/);
  assert.match(main, /launchCodexDesktopTarget/);
  assert.match(main, /explorer\.exe/);
});

test("desktop router watchdog restarts crashed routers unless the user stopped it", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "desktop", "main.cjs"), "utf8");

  assert.match(main, /ROUTER_RESTART_MAX_ATTEMPTS/);
  assert.match(main, /scheduleRouterRestart\(code\)/);
  assert.match(main, /routerStopRequested/);
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
  const workflow = fs.readFileSync(
    path.join(process.cwd(), ".github", "workflows", "desktop-portable.yml"),
    "utf8",
  );
  const packager = fs.readFileSync(
    path.join(process.cwd(), "scripts", "package-windows.mjs"),
    "utf8",
  );

  assert.match(workflow, /CodexBridge-Windows-x64-Portable\.zip/);
  assert.match(workflow, /CodexBridge-Windows-x64-Setup\.exe/);
  assert.match(workflow, /releases\/latest\/download\/CodexBridge-Windows-x64-Portable\.zip/);
  assert.match(workflow, /releases\/latest\/download\/CodexBridge-Windows-x64-Setup\.exe/);
  assert.match(workflow, /choco install nsis -y/);
  assert.match(workflow, /makensis/);
  assert.match(workflow, /CodexBridge\.nsi/);
  assert.match(workflow, /Smoke test Windows release archive/);
  assert.match(workflow, /CodexBridge\.exe/);
  assert.match(workflow, /Join-Path \$appPath\.FullName "\*"/);
  assert.doesNotMatch(workflow, /Compress-Archive -Path "release\/\*"/);
  assert.match(workflow, /prerelease: false/);
  assert.doesNotMatch(workflow, /CodexBridge-windows-portable/);
  assert.match(workflow, /files: dist-artifacts\/\*/);
  assert.match(packager, /CODEXBRIDGE_RELEASE_VERSION/);
  assert.match(packager, /CodexBridge-Windows-x64-Portable-/);
  assert.match(packager, /codexbridge-icon\.ico/);
  assert.match(packager, /\^\\\/\\\.agents/);
  assert.match(packager, /\^\\\/\\\.codex/);
  assert.match(packager, /\^\\\/\\\.superpowers/);
  assert.match(packager, /\^\\\/\\\.tmp/);
});

test("Windows installer script installs a versioned app and does not batch-delete", () => {
  const installer = fs.readFileSync(
    path.join(process.cwd(), "scripts", "installer", "windows", "CodexBridge.nsi"),
    "utf8",
  );

  assert.match(installer, /InstallDir "\$LOCALAPPDATA\\Programs\\CodexBridge"/);
  assert.match(installer, /SetOutPath "\$INSTDIR\\app-\$\{VERSION\}"/);
  assert.match(installer, /File \/r "\$\{APP_DIR\}\\\*\.\*"/);
  assert.match(installer, /CreateShortCut/);
  assert.match(installer, /WriteRegStr HKCU "Software\\CodexBridge" "CurrentVersion"/);
  assert.match(installer, /ExecShell "" "\$INSTDIR\\app-\$\{VERSION\}\\CodexBridge\.exe" "--updated"/);
  assert.doesNotMatch(installer, /RMDir\s+\/r|Delete\s+\/REBOOTOK|Remove-Item\s+-Recurse|rm\s+-rf|rmdir\s+\/s|rd\s+\/s|del\s+\/s/i);
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

test("router checks include the route fidelity regression suite", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));

  assert.match(pkg.scripts["test:router"], /tests\/route-fidelity-regression\.test\.js/);
});
