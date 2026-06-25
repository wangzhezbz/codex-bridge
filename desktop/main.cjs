const { app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const {
  legacyPortableDataCandidates,
  migrateLegacyPortableData,
  resolveDataRootDir,
} = require("./data-dir.cjs");

if (shouldDisableChromiumSandbox()) {
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("disable-gpu-sandbox");
}

const appRootDir = path.resolve(__dirname, "..");
const appIconPath = path.join(__dirname, "assets", "codexbridge-icon.png");
const trayIconPath = process.platform === "win32"
  ? path.join(__dirname, "assets", "codexbridge-icon.ico")
  : appIconPath;
const dataRootDir = resolveDataRootDir({
  appRootDir,
  env: process.env,
  execPath: process.execPath,
  isPackaged: app.isPackaged,
  platform: process.platform,
});
const legacyDataMigration = app.isPackaged && !process.env.CODEXBRIDGE_DATA_DIR
  ? migrateLegacyPortableData({
      targetDir: dataRootDir,
      legacyDirs: legacyPortableDataCandidates({
        execPath: process.execPath,
        targetDir: dataRootDir,
      }),
    })
  : { copiedFiles: 0, skippedFiles: 0, sourceDirs: [], messages: [] };
const runtimeLogPath = path.join(dataRootDir, "logs", "desktop-runtime.log");
const usageEventsPath = path.join(dataRootDir, "logs", "usage.local.json");
let settingsPromise;
let updaterPromise;
let mainWindow;
let routerProcess = null;
let logLines = [];
let smokeErrors = [];
let usageStore = null;
let lastHealth = null;
let tray = null;
let isQuitting = false;
const launchedAfterUpdate = process.argv.includes("--updated");

function shouldDisableChromiumSandbox() {
  if (process.env.CODEXBRIDGE_CHROMIUM_SANDBOX === "1") {
    return false;
  }
  if (process.env.CODEXBRIDGE_NO_SANDBOX === "0") {
    return false;
  }
  if (process.env.CODEXBRIDGE_NO_SANDBOX === "1") {
    return true;
  }
  return process.platform === "win32";
}

for (const message of legacyDataMigration.messages) {
  appendRuntimeLog(message);
}

import("./usage.mjs")
  .then(({ createUsageStore }) => {
    usageStore = createUsageStore({ initialEvents: readUsageEvents() });
    if (mainWindow && !mainWindow.isDestroyed()) {
      broadcastState().catch((error) => appendRuntimeLog(formatError("usageBroadcast", error)));
    }
  })
  .catch((error) => {
    appendRuntimeLog(formatError("usageStore", error));
  });

if (process.env.CODEXBRIDGE_DESKTOP_SMOKE === "1") {
  app.disableHardwareAcceleration();
}

process.on("uncaughtException", (error) => {
  const message = formatError("uncaughtException", error);
  appendRuntimeLog(message);
  try {
    dialog.showErrorBox("CodexBridge crashed", message);
  } catch {
    // The app may not be ready enough to show a dialog.
  }
  app.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const message = formatError("unhandledRejection", reason);
  appendRuntimeLog(message);
  if (process.env.CODEXBRIDGE_DESKTOP_SMOKE === "1") {
    console.error(message);
    app.exit(1);
  }
});

function loadSettings() {
  if (!settingsPromise) {
    settingsPromise = import("./settings.mjs");
  }
  return settingsPromise;
}

function loadUpdater() {
  if (!updaterPromise) {
    updaterPromise = import("./updater.mjs");
  }
  return updaterPromise;
}

async function loadRouterHealth() {
  return import("./router-health.mjs");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    title: "CodexBridge",
    backgroundColor: "#f5f7f9",
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    recordDesktopError(`Window failed to load ${validatedURL}: ${errorCode} ${errorDescription}`);
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    recordDesktopError(`Renderer process gone: ${details.reason} exitCode=${details.exitCode}`);
  });

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      recordDesktopError(`Renderer console error: ${message} (${sourceId}:${line})`);
    }
  });

  mainWindow.on("close", (event) => {
    if (isQuitting || process.env.CODEXBRIDGE_DESKTOP_SMOKE === "1") {
      return;
    }
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  if (process.platform === "win32") {
    app.setAppUserModelId("com.codexbridge.app");
  }
  if (process.env.CODEXBRIDGE_DESKTOP_SMOKE !== "1") {
    createTray();
  }
  createWindow();
  if (launchedAfterUpdate && process.env.CODEXBRIDGE_DESKTOP_SMOKE !== "1") {
    mainWindow.webContents.once("did-finish-load", () => {
      showMainWindow();
      appendLog(`Updated CodexBridge launched: v${app.getVersion()}`);
      dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "CodexBridge 更新完成",
        message: `CodexBridge 已更新到 v${app.getVersion()}`,
        detail: "窗口已重新打开，配置、密钥和模型选择仍保存在用户数据目录。",
      }).catch((error) => appendRuntimeLog(formatError("updateNotice", error)));
    });
  }
  if (process.env.CODEXBRIDGE_DESKTOP_SMOKE === "1") {
    const timeout = setTimeout(() => {
      console.error("Desktop smoke test timed out.");
      app.exit(1);
    }, 15000);
    mainWindow.webContents.once("did-finish-load", () => {
      clearTimeout(timeout);
      runDesktopSmokeChecks();
    });
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  stopRouter({ silent: true });
});

app.on("window-all-closed", () => {
  // Keep CodexBridge alive in the tray after the main window is closed.
});

app.on("activate", () => {
  showMainWindow();
});

function createTray() {
  if (tray) {
    return tray;
  }
  tray = new Tray(trayIconPath);
  tray.setToolTip("CodexBridge");
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: "打开 CodexBridge",
      click: () => showMainWindow(),
    },
    {
      type: "separator",
    },
    {
      label: "退出 CodexBridge",
      click: () => {
        isQuitting = true;
        stopRouter({ silent: true });
        app.quit();
      },
    },
  ]));
  tray.on("click", () => showMainWindow());
  return tray;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  }
  mainWindow.show();
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
}

ipcMain.handle("state:get", async () => {
  const settings = await loadSettings();
  const config = settings.readRouterConfig(dataRootDir);
  const mode = settings.detectModeFromConfig(config);
  const diagnostics = settings.routerConfigDiagnostics(dataRootDir, config);
  return {
    rootDir: dataRootDir,
    appRootDir,
    appVersion: app.getVersion(),
    packaged: app.isPackaged,
    mode,
    routerRunning: Boolean(routerProcess),
    configExists: Boolean(config),
    models: config?.models || [],
    providers: settings.providerCatalog(dataRootDir),
    modelPresets: settings.modelCatalog(dataRootDir),
    selectedModelIds: settings.readSelection(dataRootDir, mode),
    maxModels: settings.CODEX_MODEL_SLOTS?.length || 5,
    modelSlots: settings.CODEX_MODEL_SLOTS || [],
    customModels: settings.readCustomModels(dataRootDir),
    imageGenerationOverrides: settings.readModelImageGenerationOverrides(dataRootDir),
    secretStatus: settings.secretStatus(dataRootDir),
    desktopOptions: settings.loadDesktopOptions(dataRootDir),
    diagnostics,
    lastHealth,
    usageEvents: usageStore?.events() || [],
    usageSummary: usageStore?.summary() || emptyUsageSummary(),
    legacyDataMigration,
    logs: logLines,
  };
});

ipcMain.handle("mode:select", async (_event, mode) => {
  const settings = await loadSettings();
  settings.saveSelection(dataRootDir, settings.defaultSelectedModelIds(mode), mode);
  settings.writeRouterConfigFromSelection(dataRootDir, mode);
  appendLog(`Selected ${mode === settings.MODE_HYBRID ? "Hybrid" : "All API"} mode.`);
  broadcastState();
  return getStatePayload(settings);
});

ipcMain.handle("secrets:save", async (_event, secrets) => {
  const settings = await loadSettings();
  const saved = settings.saveSecrets(dataRootDir, secrets);
  appendLog(`Saved API key settings: ${Object.keys(saved).join(", ") || "none"}.`);
  broadcastState();
  return settings.secretStatus(dataRootDir);
});

ipcMain.handle("secrets:get", async (_event, keyEnv) => {
  const settings = await loadSettings();
  return settings.secretValue(dataRootDir, String(keyEnv || ""));
});

ipcMain.handle("options:save", async (_event, options) => {
  const settings = await loadSettings();
  const saved = settings.saveDesktopOptions(dataRootDir, options || {});
  appendLog(
    saved.bypassSystemProxy
      ? "System proxy bypass enabled for Router process."
      : "System proxy bypass disabled for Router process.",
  );
  broadcastState();
  return getStatePayload(settings);
});

ipcMain.handle("models:saveSelection", async (_event, selectedModelIds) => {
  const settings = await loadSettings();
  const config = settings.readRouterConfig(dataRootDir);
  const mode = settings.detectModeFromConfig(config);
  const saved = settings.saveSelection(dataRootDir, selectedModelIds, mode);
  settings.writeRouterConfigFromSelection(dataRootDir, mode);
  appendLog(`Saved model selection: ${saved.join(", ")}.`);
  broadcastState();
  return getStatePayload(settings);
});

ipcMain.handle("models:saveImageInput", async (_event, payload) => {
  const settings = await loadSettings();
  const presetId = String(payload?.presetId || "");
  const saved = settings.saveModelImageInputOverride(dataRootDir, presetId, Boolean(payload?.imageInput));
  const config = settings.readRouterConfig(dataRootDir);
  const mode = settings.detectModeFromConfig(config);
  settings.writeRouterConfigFromSelection(dataRootDir, mode);
  const catalogResult = await runNodeScript([
    scriptPath("scripts/generate-catalog.js"),
    settings.catalogPath(dataRootDir),
  ]);
  if (!catalogResult.ok) {
    throw new Error(catalogResult.output || "Failed to generate model catalog.");
  }
  appendLog(
    `Updated image upload support: ${saved.presetId} ${saved.imageInput ? "enabled" : "disabled"}.`,
  );
  broadcastState();
  return getStatePayload(settings);
});

ipcMain.handle("models:saveImageGeneration", async (_event, payload) => {
  const settings = await loadSettings();
  const presetId = String(payload?.presetId || "");
  const saved = settings.saveModelImageGenerationOverride(
    dataRootDir,
    presetId,
    payload?.imageGeneration || {},
  );
  const config = settings.readRouterConfig(dataRootDir);
  const mode = settings.detectModeFromConfig(config);
  settings.writeRouterConfigFromSelection(dataRootDir, mode);
  appendLog(
    `Updated image generation provider: ${saved.presetId} -> ${saved.imageGeneration.mode}.`,
  );
  broadcastState();
  return getStatePayload(settings);
});

ipcMain.handle("customModel:save", async (_event, model) => {
  const settings = await loadSettings();
  const saved = settings.saveCustomModel(dataRootDir, model);
  appendLog(`Saved custom model: ${saved.displayName}.`);
  broadcastState();
  return saved;
});

ipcMain.handle("customModel:remove", async (_event, presetId) => {
  const settings = await loadSettings();
  settings.removeCustomModel(dataRootDir, presetId);
  appendLog(`Removed custom model: ${presetId}.`);
  broadcastState();
  return getStatePayload(settings);
});

ipcMain.handle("catalog:generate", async () => {
  const settings = await loadSettings();
  const config = settings.readRouterConfig(dataRootDir);
  const mode = settings.detectModeFromConfig(config);
  settings.writeRouterConfigFromSelection(dataRootDir, mode);
  const result = await runNodeScript([
    scriptPath("scripts/generate-catalog.js"),
    settings.catalogPath(dataRootDir),
  ]);
  appendLog(result.ok ? "Generated model-catalog.json." : `Catalog generation failed: ${result.output}`);
  return result;
});

ipcMain.handle("codex:apply", async () => {
  const settings = await loadSettings();
  let config = settings.readRouterConfig(dataRootDir);
  const mode = settings.detectModeFromConfig(config);
  config = settings.writeRouterConfigFromSelection(dataRootDir, mode);
  const result = settings.applyCodexConfig({
    rootDir: dataRootDir,
    mode,
    port: config?.port || 15722,
  });
  appendLog(`Applied Codex config: ${result.target}`);
  if (result.backup) {
    appendLog(`Backup created: ${result.backup}`);
  }
  appendHistorySyncLog(result.historySync);
  return result;
});

ipcMain.handle("codex:initialize", async () => {
  const settings = await loadSettings();
  let config = settings.readRouterConfig(dataRootDir);
  const mode = settings.detectModeFromConfig(config);
  config = settings.writeRouterConfigFromSelection(dataRootDir, mode);
  const catalogResult = await runNodeScript([
    scriptPath("scripts/generate-catalog.js"),
    settings.catalogPath(dataRootDir),
  ]);
  if (!catalogResult.ok) {
    throw new Error(catalogResult.output || "Failed to generate model catalog.");
  }
  const codexResult = settings.applyCodexConfig({
    rootDir: dataRootDir,
    mode,
    port: config?.port || 15722,
  });
  appendLog(`Initialized Codex config: ${codexResult.target}`);
  if (codexResult.backup) {
    appendLog(`Backup created: ${codexResult.backup}`);
  }
  appendHistorySyncLog(codexResult.historySync);
  broadcastState();
  return {
    ok: true,
    catalog: catalogResult,
    codex: codexResult,
  };
});

ipcMain.handle("codex:restore", async () => {
  const settings = await loadSettings();
  const result = settings.restoreCodexConfig();
  appendLog(`Restored Codex config from backup: ${result.backup}`);
  if (result.currentBackup) {
    appendLog(`Current config backed up before restore: ${result.currentBackup}`);
  }
  broadcastState();
  return result;
});

ipcMain.handle("codex:recover-history", async () => {
  const settings = await loadSettings();
  const result = settings.recoverCodexHistoryAccess();
  appendLog(`Updated Codex history access: ${result.target}`);
  if (result.currentBackup) {
    appendLog(`Current CodexBridge config backed up before history access update: ${result.currentBackup}`);
  }
  appendHistorySyncLog(result.historySync);
  appendLog(result.nextStep);
  broadcastState();
  return result;
});

ipcMain.handle("router:start", async () => {
  if (routerProcess) {
    return { ok: true, message: "Router is already running." };
  }

  const settings = await loadSettings();
  const config = settings.readRouterConfig(dataRootDir);
  const mode = settings.detectModeFromConfig(config);
  appendDiagnosticsLog(settings.routerConfigDiagnostics(dataRootDir, config));
  const prepared = settings.prepareRouterStartConfig({
    rootDir: dataRootDir,
    mode,
  });
  appendLog(
    prepared.codex.unchanged
      ? `Codex config already current: ${prepared.codex.target}`
      : `Updated Codex config before Router start: ${prepared.codex.target}`,
  );
  if (prepared.codex.backup) {
    appendLog(`Backup created: ${prepared.codex.backup}`);
  }
  appendHistorySyncLog(prepared.codex.historySync);
  const catalogResult = await runNodeScript([
    scriptPath("scripts/generate-catalog.js"),
    settings.catalogPath(dataRootDir),
  ]);
  if (!catalogResult.ok) {
    throw new Error(catalogResult.output || "Failed to generate model catalog.");
  }
  const nodePath = nodeExecutable();
  routerProcess = spawn(nodePath, [scriptPath("src/server.js")], {
    cwd: appRootDir,
    env: runtimeEnv(settings),
    windowsHide: true,
  });

  appendLog(`Starting router with ${nodePath}.`);
  routerProcess.stdout.on("data", (chunk) => appendLog(chunk.toString("utf8").trimEnd()));
  routerProcess.stderr.on("data", (chunk) => appendLog(chunk.toString("utf8").trimEnd()));
  routerProcess.on("exit", (code) => {
    if (isQuitting) {
      routerProcess = null;
      return;
    }
    appendLog(`Router stopped with code ${code ?? "unknown"}.`);
    routerProcess = null;
    lastHealth = {
      ok: false,
      status: 0,
      models: [],
      message: `Router stopped with code ${code ?? "unknown"}.`,
      checkedAt: new Date().toISOString(),
    };
    broadcastState();
  });

  lastHealth = {
    ok: false,
    status: 0,
    models: [],
    message: "Router is starting; waiting for health check...",
    checkedAt: new Date().toISOString(),
    starting: true,
  };
  broadcastState();
  await refreshRouterHealth(prepared.config);
  broadcastState();
  return { ok: true, message: "Router started." };
});

ipcMain.handle("router:stop", async () => {
  stopRouter();
  appendLog("Router stop requested.");
  lastHealth = {
    ok: false,
    status: 0,
    models: [],
    message: "Router is stopped.",
    checkedAt: new Date().toISOString(),
  };
  broadcastState();
  return { ok: true };
});

ipcMain.handle("diagnostics:copy", async () => {
  const settings = await loadSettings();
  const config = settings.readRouterConfig(dataRootDir);
  const diagnostics = settings.supportDiagnostics(dataRootDir, {
    appVersion: app.getVersion(),
    routerRunning: Boolean(routerProcess),
    lastHealth,
    usageSummary: usageStore?.summary() || emptyUsageSummary(),
    updateDir: portableUpdatesDir(),
    proxyEnv: process.env,
    config,
    logs: logLines,
  });
  clipboard.writeText(diagnostics.text);
  appendLog("Copied sanitized diagnostics to clipboard.");
  broadcastState();
  return diagnostics.summary;
});

ipcMain.handle("updates:check", async () => {
  const updater = await loadUpdater();
  const release = await updater.fetchLatestRelease();
  const plan = updater.planReleaseUpdate({
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    release,
  });
  appendLog(`Update check: ${plan.message}`);
  broadcastState();
  return {
    ...plan,
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
  };
});

ipcMain.handle("updates:install", async () => {
  if (!app.isPackaged) {
    throw new Error("开发模式不能直接替换程序目录，请使用打包版测试更新。");
  }
  emitUpdateProgress({
    phase: "checking",
    downloadedBytes: 0,
    totalBytes: 0,
    percent: 0,
  });
  const updater = await loadUpdater();
  const release = await updater.fetchLatestRelease();
  const plan = updater.planReleaseUpdate({
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    release,
  });
  if (!plan.ok) {
    throw new Error(plan.message || "当前平台无法更新。");
  }
  if (!plan.updateAvailable) {
    throw new Error("当前已经是最新版本。");
  }
  if (plan.asset?.kind === "installer") {
    const prepared = await prepareInstallerUpdate(updater, plan, emitUpdateProgress);
    appendLog(`Update installer downloaded: ${prepared.installerPath}`);
    emitUpdateProgress({
      phase: "launching",
      downloadedBytes: plan.asset?.size || 0,
      totalBytes: plan.asset?.size || 0,
      percent: 100,
      message: "Update installer downloaded; launching installer.",
    });
    const openError = await shell.openPath(prepared.installerPath);
    if (openError) {
      appendRuntimeLog(`openUpdateInstaller: ${openError}`);
      try {
        shell.showItemInFolder(prepared.installerPath);
      } catch (error) {
        appendRuntimeLog(formatError("showUpdateInstaller", error));
      }
      throw new Error(`Unable to launch update installer: ${openError}`);
    }
    return {
      ok: true,
      message: `Downloaded CodexBridge ${plan.latestVersion} installer. Follow the installer to finish updating; the current app may stay open until the installer launches the new version.`,
      latestVersion: plan.latestVersion,
      installerPath: prepared.installerPath,
    };
  }
  const prepared = await preparePortableUpdate(updater, plan, emitUpdateProgress);
  appendLog(`Update package downloaded: ${prepared.downloadPath}`);
  appendLog(`Update package ready for manual install: ${prepared.downloadPath}`);
  appendLog(`Manual update instructions: ${prepared.manualNotePath}`);
  emitUpdateProgress({
    phase: "ready",
    downloadedBytes: plan.asset?.size || 0,
    totalBytes: plan.asset?.size || 0,
    percent: 100,
    message: "更新包已下载到 updates 目录；当前程序保持运行。",
  });
  try {
    shell.showItemInFolder(prepared.downloadPath);
  } catch (error) {
    appendRuntimeLog(formatError("showUpdatePackage", error));
    const openError = await shell.openPath(path.dirname(prepared.downloadPath));
    if (openError) {
      appendRuntimeLog(`openUpdateFolder: ${openError}`);
    }
  }
  return {
    ok: true,
    message: `已下载 ${plan.latestVersion}，更新包已放到 updates 目录。当前程序不会自动退出；如需立即升级，请退出 CodexBridge 后从 updates 目录打开新版。`,
    latestVersion: plan.latestVersion,
    downloadPath: prepared.downloadPath,
    manualNotePath: prepared.manualNotePath,
    scriptPath: prepared.scriptPath,
  };
});

ipcMain.handle("folder:open", async (_event, target) => {
  const settings = await loadSettings();
  const folder = ensureFolderForOpen(
    target === "codex"
      ? path.dirname(settings.codexConfigPath())
      : target === "config"
        ? path.join(dataRootDir, "config")
        : target === "updates"
          ? portableUpdatesDir()
        : dataRootDir,
  );
  const openError = await shell.openPath(folder);
  if (openError) {
    throw new Error(`Unable to open folder: ${folder}. ${openError}`);
  }
  return { ok: true, folder };
});

function ensureFolderForOpen(folder) {
  const resolvedFolder = path.resolve(folder);
  fs.mkdirSync(resolvedFolder, { recursive: true });
  return resolvedFolder;
}

ipcMain.handle("github:open", async () => {
  await shell.openExternal("https://github.com/wangzhezbz/codex-bridge");
  return { ok: true };
});

ipcMain.handle("external:open", async (_event, url) => {
  const target = String(url || "");
  if (!/^https?:\/\//i.test(target)) {
    throw new Error("Only http(s) links can be opened.");
  }
  await shell.openExternal(target);
  return { ok: true };
});

ipcMain.handle("dialog:error", async (_event, message) => {
  dialog.showErrorBox("CodexBridge", String(message || "Unknown error"));
});

function stopRouter(options = {}) {
  if (!routerProcess) {
    return;
  }
  if (options.silent) {
    routerProcess.removeAllListeners("exit");
  }
  routerProcess.kill();
  routerProcess = null;
}

async function prepareInstallerUpdate(updater, plan, onProgress) {
  const updatesDir = portableUpdatesDir();
  fs.mkdirSync(updatesDir, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replaceAll(":", "")
    .replaceAll(".", "")
    .replace("T", "-")
    .replace("Z", "");
  const installerPath = path.join(updatesDir, `${stamp}-${plan.asset.name}`);
  const proxyLabel = updater.updateDownloadProxyLabel?.(plan.asset.downloadUrl) || "";
  appendLog(
    proxyLabel
      ? `Update installer download using proxy ${proxyLabel}.`
      : "Update installer download using direct GitHub connection.",
  );
  await downloadFile(plan.asset.downloadUrl, installerPath, {
    expectedBytes: plan.asset.size,
    fetchInitForDownload: updater.fetchInitForUpdateDownload,
    onProgress,
  });
  return { installerPath };
}

async function preparePortableUpdate(updater, plan, onProgress) {
  const updatesDir = portableUpdatesDir();
  fs.mkdirSync(updatesDir, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replaceAll(":", "")
    .replaceAll(".", "")
    .replace("T", "-")
    .replace("Z", "");
  const downloadPath = path.join(updatesDir, `${stamp}-${plan.asset.name}`);
  const proxyLabel = updater.updateDownloadProxyLabel?.(plan.asset.downloadUrl) || "";
  appendLog(
    proxyLabel
      ? `Update download using proxy ${proxyLabel}.`
      : "Update download using direct GitHub connection.",
  );
  await downloadFile(plan.asset.downloadUrl, downloadPath, {
    expectedBytes: plan.asset.size,
    fetchInitForDownload: updater.fetchInitForUpdateDownload,
    onProgress,
  });

  const currentAppDir = path.dirname(process.execPath);
  const manualNotePath = path.join(updatesDir, `manual-update-${stamp}.txt`);
  writeManualUpdateInstructions({
    manualNotePath,
    packagePath: downloadPath,
    currentAppDir,
    platform: process.platform,
  });

  const logPath = path.join(updatesDir, "update.log");
  if (process.platform === "win32") {
    const scriptFile = path.join(updatesDir, `apply-update-${stamp}.ps1`);
    const script = updater.generateWindowsPortableUpdateScript({
      parentPid: process.pid,
      blockingPids: [routerProcess?.pid].filter(Boolean),
      zipPath: downloadPath,
      currentAppDir,
      exeName: path.basename(process.execPath),
      workDir: updatesDir,
      logPath,
    });
    fs.writeFileSync(scriptFile, script, "utf8");
    return { downloadPath, scriptPath: scriptFile, manualNotePath };
  }
  if (process.platform === "darwin") {
    const scriptFile = path.join(updatesDir, `apply-update-${stamp}.sh`);
    const script = updater.generateMacPortableUpdateScript({
      parentPid: process.pid,
      blockingPids: [routerProcess?.pid].filter(Boolean),
      zipPath: downloadPath,
      currentAppBundle: currentMacAppBundle(),
      workDir: updatesDir,
      logPath,
    });
    fs.writeFileSync(scriptFile, script, { encoding: "utf8", mode: 0o755 });
    return { downloadPath, scriptPath: scriptFile, manualNotePath };
  }
  throw new Error(`当前系统暂不支持应用内更新：${process.platform} ${process.arch}`);
}

function portableUpdatesDir() {
  if (app.isPackaged && process.platform === "win32") {
    return path.resolve(path.dirname(process.execPath), "..", "updates");
  }
  if (app.isPackaged && process.platform === "darwin") {
    return path.join(path.dirname(currentMacAppBundle()), "updates");
  }
  return path.join(dataRootDir, "updates");
}

function writeManualUpdateInstructions({
  manualNotePath,
  packagePath,
  currentAppDir,
  platform,
}) {
  const lines = [
    "CodexBridge download-only portable update",
    "",
    `Downloaded package: ${packagePath}`,
    `Current app directory: ${currentAppDir}`,
    "This portable build keeps the current app running after download.",
    "",
  ];
  if (platform === "win32") {
    lines.push(
      "To update manually:",
      "1. Fully exit CodexBridge from the tray icon.",
      "2. Unzip the downloaded package in this updates folder.",
      "3. Open the extracted CodexBridge-win32-x64 folder.",
      "4. Run CodexBridge.exe from the extracted folder.",
      "",
      "Your configuration, keys, model selection, statistics, and logs are stored in the user data directory, not inside this package folder.",
    );
  } else if (platform === "darwin") {
    lines.push(
      "To update manually:",
      "1. Fully quit CodexBridge.",
      "2. Unzip the downloaded package in this updates folder.",
      "3. Open the extracted CodexBridge.app.",
      "",
      "Your configuration, keys, model selection, statistics, and logs are stored in the user data directory, not inside this package folder.",
    );
  } else {
    lines.push("Automatic update is not supported on this platform.");
  }
  fs.writeFileSync(manualNotePath, `${lines.join("\n")}\n`, "utf8");
}

async function downloadFile(url, targetPath, {
  expectedBytes = 0,
  fetchInitForDownload,
  onProgress,
} = {}) {
  const baseInit = {
    headers: {
      "user-agent": "CodexBridge",
    },
  };
  const response = await fetch(
    url,
    typeof fetchInitForDownload === "function"
      ? fetchInitForDownload(url, baseInit)
      : baseInit,
  );
  if (!response.ok) {
    throw new Error(`更新包下载失败：HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("更新包下载失败：响应体为空。");
  }
  const contentLength = Number(response.headers.get("content-length") || 0);
  const totalBytes = Number.isFinite(contentLength) && contentLength > 0
    ? contentLength
    : Number(expectedBytes || 0);
  let downloadedBytes = 0;
  const startedAt = Date.now();
  let lastEmitAt = 0;
  let lastPercent = -1;
  const emit = (force = false) => {
    if (typeof onProgress !== "function") {
      return;
    }
    const percent = totalBytes > 0
      ? Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100))
      : 0;
    const now = Date.now();
    if (!force && now - lastEmitAt < 200 && percent === lastPercent) {
      return;
    }
    lastEmitAt = now;
    lastPercent = percent;
    const elapsedSeconds = Math.max(0.001, (now - startedAt) / 1000);
    onProgress({
      phase: "downloading",
      downloadedBytes,
      totalBytes,
      percent,
      bytesPerSecond: Math.floor(downloadedBytes / elapsedSeconds),
    });
  };
  emit(true);
  const progressStream = new Transform({
    transform(chunk, _encoding, callback) {
      downloadedBytes += chunk.length;
      emit(false);
      callback(null, chunk);
    },
    flush(callback) {
      emit(true);
      callback();
    },
  });
  await pipeline(Readable.fromWeb(response.body), progressStream, fs.createWriteStream(targetPath));
  emit(true);
  const expectedFinalBytes = Number(expectedBytes || totalBytes || 0);
  if (expectedFinalBytes > 0) {
    const finalBytes = fs.statSync(targetPath).size;
    if (finalBytes !== expectedFinalBytes) {
      throw new Error(`更新包下载不完整：expected ${expectedFinalBytes} bytes, got ${finalBytes} bytes`);
    }
  }
}

function currentMacAppBundle() {
  let current = process.execPath;
  while (current && current !== path.dirname(current)) {
    if (current.endsWith(".app")) {
      return current;
    }
    current = path.dirname(current);
  }
  throw new Error("无法定位当前 CodexBridge.app。");
}

async function runNodeScript(args) {
  const settings = await loadSettings();
  const nodePath = nodeExecutable();
  return new Promise((resolve) => {
    const child = spawn(nodePath, args, {
      cwd: appRootDir,
      env: runtimeEnv(settings),
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      output += text;
      appendLog(text.trimEnd());
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      output += text;
      appendLog(text.trimEnd());
    });
    child.on("exit", (code) => {
      resolve({ ok: code === 0, code, output: output.trim() });
    });
  });
}

function nodeExecutable() {
  if (app.isPackaged) {
    return process.execPath;
  }
  return process.env.npm_node_execpath || "node";
}

function runtimeEnv(settings) {
  const env = settings.routerRuntimeEnv(dataRootDir, process.env);
  if (app.isPackaged) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  return env;
}

function scriptPath(relativePath) {
  return path.join(appRootDir, relativePath);
}

function appendLog(line) {
  if (!line) {
    return;
  }
  for (const entry of String(line).split(/\r?\n/)) {
    usageStore?.recordLine(entry);
    logLines.push(`[${new Date().toLocaleTimeString()}] ${entry}`);
  }
  persistUsageEvents();
  logLines = logLines.slice(-300);
  sendToRenderer("logs:update", logLines);
  sendToRenderer("usage:update", usagePayload());
}

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  const { webContents } = mainWindow;
  if (!webContents || webContents.isDestroyed()) {
    return;
  }
  webContents.send(channel, payload);
}

function emitUpdateProgress(progress) {
  sendToRenderer("updates:progress", {
    ...progress,
    updatedAt: new Date().toISOString(),
  });
}

function appendHistorySyncLog(historySync) {
  if (!historySync) {
    return;
  }
  const hasHistoryChanges = (
    historySync.totalImportedThreads > 0 ||
    historySync.totalUpdatedThreads > 0 ||
    historySync.totalNormalizedThreads > 0
  );
  if (historySync.totalImportedThreads > 0) {
    appendLog(
      `Merged Codex history: ${historySync.totalImportedThreads} missing conversation(s) restored from Codex state backups.`,
    );
  }
  if (historySync.totalUpdatedThreads > 0) {
    appendLog(
      `Merged Codex history: ${historySync.totalUpdatedThreads} legacy CodexBridge conversation(s) moved into the built-in OpenAI history provider.`,
    );
  }
  if (historySync.totalNormalizedThreads > 0) {
    appendLog(
      `Merged Codex history: ${historySync.totalNormalizedThreads} conversation metadata record(s) normalized for Codex visibility.`,
    );
  }
  if (!hasHistoryChanges) {
    if (historySync.skipped && historySync.reason) {
      appendLog(`Codex history sync skipped: ${historySync.reason}.`);
    } else {
      appendLog("Codex history sync checked: no legacy CodexBridge conversations found.");
    }
  }
  for (const database of historySync.databases || []) {
    if (database.backup) {
      appendLog(`Codex history database backup created: ${database.backup}`);
    }
    if (!database.ok && database.error) {
      appendLog(`Codex history sync warning: ${database.path}: ${database.error}`);
    }
  }
}

function appendDiagnosticsLog(diagnostics) {
  if (!diagnostics) {
    return;
  }
  if (diagnostics.ok) {
    appendLog("Preflight OK: selected model keys and base URLs are ready.");
    return;
  }
  if (diagnostics.invalidBaseUrls?.length) {
    appendLog(
      `Preflight invalid base URLs: ${diagnostics.invalidBaseUrls
        .map((item) => `${item.displayName || item.id} -> ${item.baseUrl || "(empty)"}`)
        .join("; ")}`,
    );
  }
  if (diagnostics.missingApiKeys?.length) {
    appendLog(
      `Preflight missing API keys: ${diagnostics.missingApiKeys
        .map((item) => `${item.displayName || item.id} -> ${item.apiKeyEnv || "API Key"}`)
        .join("; ")}`,
    );
  }
}

function recordDesktopError(message) {
  const line = String(message || "Unknown desktop error");
  appendRuntimeLog(line);
  appendLog(line);
  smokeErrors.push(line);
}

function appendRuntimeLog(line) {
  try {
    fs.mkdirSync(path.dirname(runtimeLogPath), { recursive: true });
    fs.appendFileSync(runtimeLogPath, `[${new Date().toISOString()}] ${line}\n`, "utf8");
  } catch {
    // Logging must never crash the desktop app.
  }
}

function readUsageEvents() {
  try {
    if (!fs.existsSync(usageEventsPath)) {
      return [];
    }
    const parsed = JSON.parse(fs.readFileSync(usageEventsPath, "utf8"));
    return Array.isArray(parsed?.events) ? parsed.events : [];
  } catch (error) {
    appendRuntimeLog(formatError("readUsageEvents", error));
    return [];
  }
}

function persistUsageEvents() {
  if (!usageStore) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(usageEventsPath), { recursive: true });
    const events = usageStore.events().slice().reverse();
    fs.writeFileSync(
      usageEventsPath,
      `${JSON.stringify({ version: 1, events }, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    appendRuntimeLog(formatError("persistUsageEvents", error));
  }
}

function formatError(prefix, error) {
  const details = error?.stack || error?.message || String(error);
  return `${prefix}: ${details}`;
}

async function broadcastState() {
  const settings = await loadSettings();
  sendToRenderer("state:update", await getStatePayload(settings));
}

async function getStatePayload(settings) {
  const config = settings.readRouterConfig(dataRootDir);
  const mode = settings.detectModeFromConfig(config);
  const diagnostics = settings.routerConfigDiagnostics(dataRootDir, config);
  return {
    rootDir: dataRootDir,
    appRootDir,
    appVersion: app.getVersion(),
    packaged: app.isPackaged,
    mode,
    routerRunning: Boolean(routerProcess),
    configExists: Boolean(config),
    models: config?.models || [],
    providers: settings.providerCatalog(dataRootDir),
    modelPresets: settings.modelCatalog(dataRootDir),
    selectedModelIds: settings.readSelection(dataRootDir, mode),
    maxModels: settings.CODEX_MODEL_SLOTS?.length || 5,
    modelSlots: settings.CODEX_MODEL_SLOTS || [],
    customModels: settings.readCustomModels(dataRootDir),
    imageGenerationOverrides: settings.readModelImageGenerationOverrides(dataRootDir),
    secretStatus: settings.secretStatus(dataRootDir),
    desktopOptions: settings.loadDesktopOptions(dataRootDir),
    diagnostics,
    lastHealth,
    usageEvents: usageStore?.events() || [],
    usageSummary: usageStore?.summary() || emptyUsageSummary(),
    legacyDataMigration,
    logs: logLines,
  };
}

async function refreshRouterHealth(config) {
  const { waitForRouterHealth } = await loadRouterHealth();
  const host = config?.host || "127.0.0.1";
  const port = config?.port || 15722;
  const origin = `http://${host}:${port}`;
  const result = await waitForRouterHealth({
    origin,
    timeoutMs: 1500,
    maxWaitMs: 20000,
    intervalMs: 500,
    isStillStarting: () => Boolean(routerProcess),
  });
  lastHealth = result;
  appendLog(
    result.ok
      ? `Health OK: ${result.models.join(", ") || "no models listed"}.`
      : `Health failed after ${result.attempts || 1} attempt(s): ${result.message}`,
  );
  return result;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usagePayload() {
  return {
    usageEvents: usageStore?.events() || [],
    usageSummary: usageStore?.summary() || emptyUsageSummary(),
  };
}

function emptyUsageSummary() {
  return {
    totalCalls: 0,
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    statusCounts: {},
    byModel: [],
    latest: null,
  };
}

async function runDesktopSmokeChecks() {
  try {
    const result = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const required = [
          "#initializeCodex",
          "#restoreCodexConfig",
          "#recoverHistoryAccess",
          "#routerToggle",
          "#healthStatus",
          "#bypassSystemProxy",
          "#saveModelSelectionPanel",
          "#providerGrid",
          "#stats",
          "#usageChart",
          "#copyDiagnostics",
          "#checkUpdates",
          "#openUpdateFolder"
        ];
        for (const selector of required) {
          if (!document.querySelector(selector)) {
            throw new Error("Missing UI element: " + selector);
          }
        }
        const waitFor = (fn) => new Promise((resolve, reject) => {
          const started = Date.now();
          const timer = setInterval(() => {
            if (fn()) {
              clearInterval(timer);
              resolve(true);
              return;
            }
            if (Date.now() - started > 5000) {
              clearInterval(timer);
              reject(new Error("Timed out waiting for UI render"));
            }
          }, 80);
        });
        await waitFor(() => document.querySelectorAll(".provider-card").length >= 3);
        document.querySelector('[data-section="providers"]').click();
        if (document.querySelector("#providers").classList.contains("hidden")) {
          throw new Error("Providers nav did not activate");
        }
        if (!document.querySelector("[data-save-provider]")) {
          throw new Error("Provider save button missing");
        }
        if (!document.querySelector("[data-toggle-secret]")) {
          throw new Error("Provider reveal button missing");
        }
        document.querySelector('[data-section="stats"]').click();
        if (document.querySelector("#stats").classList.contains("hidden")) {
          throw new Error("Stats nav did not activate");
        }
        return {
          providers: document.querySelectorAll(".provider-card").length,
          nav: document.querySelector(".nav-item.active")?.textContent?.trim()
        };
      })()
    `);
    if (smokeErrors.length) {
      console.error(`CodexBridge desktop smoke saw ${smokeErrors.length} renderer error(s).`);
      for (const error of smokeErrors) {
        console.error(error);
      }
      app.exit(1);
      return;
    }
    console.log(`CodexBridge desktop smoke loaded. providers=${result.providers} nav=${result.nav}`);
    app.quit();
  } catch (error) {
    console.error(formatError("Desktop smoke interaction failed", error));
    app.exit(1);
  }
}
