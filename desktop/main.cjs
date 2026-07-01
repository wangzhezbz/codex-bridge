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

const hasSingleInstanceLock = process.env.CODEXBRIDGE_DESKTOP_SMOKE === "1" ||
  app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });
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
let usageRoutes = [];
let lastHealth = null;
let tray = null;
let isQuitting = false;
let routerStopRequested = false;
let routerRestartTimer = null;
let routerRestartAttempts = 0;
let launchedUpdateLoadHookRegistered = false;
let desktopSmokeLoadHookRegistered = false;
const ROUTER_RESTART_MAX_ATTEMPTS = 12;
const ROUTER_RESTART_BASE_DELAY_MS = 1500;
const ROUTER_RESTART_MAX_DELAY_MS = 30000;
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

  registerWindowLoadHooks();
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function registerWindowLoadHooks() {
  if (launchedAfterUpdate && process.env.CODEXBRIDGE_DESKTOP_SMOKE !== "1" && !launchedUpdateLoadHookRegistered) {
    launchedUpdateLoadHookRegistered = true;
    mainWindow.webContents.once("did-finish-load", () => {
      showMainWindow();
      appendLog(`Updated CodexBridge launched: v${app.getVersion()}`);
      sendToRenderer("updates:finished", {
        version: app.getVersion(),
        message: `CodexBridge 已更新到 v${app.getVersion()}，配置、密钥和模型选择仍保存在用户数据目录。`,
      });
    });
  }

  if (process.env.CODEXBRIDGE_DESKTOP_SMOKE === "1" && !desktopSmokeLoadHookRegistered) {
    desktopSmokeLoadHookRegistered = true;
    const timeout = setTimeout(() => {
      console.error("Desktop smoke test timed out.");
      app.exit(1);
    }, 15000);
    mainWindow.webContents.once("did-finish-load", () => {
      clearTimeout(timeout);
      runDesktopSmokeChecks();
    });
  }
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) {
    return;
  }
  if (process.platform === "win32") {
    app.setAppUserModelId("com.codexbridge.app");
  }
  if (process.env.CODEXBRIDGE_DESKTOP_SMOKE !== "1") {
    createTray();
  }
  createWindow();
  cleanupUpdateArtifactsOnStartup().catch((error) => {
    appendRuntimeLog(formatError("cleanupUpdates", error));
  });
  if (launchedAfterUpdate && process.env.CODEXBRIDGE_DESKTOP_SMOKE !== "1" && !launchedUpdateLoadHookRegistered) {
    mainWindow.webContents.once("did-finish-load", () => {
      showMainWindow();
      appendLog(`Updated CodexBridge launched: v${app.getVersion()}`);
      sendToRenderer("updates:finished", {
        version: app.getVersion(),
        message: `CodexBridge 已更新到 v${app.getVersion()}，配置、密钥和模型选择仍保存在用户数据目录。`,
      });
    });
  }
  if (process.env.CODEXBRIDGE_DESKTOP_SMOKE === "1" && !desktopSmokeLoadHookRegistered) {
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
  refreshTrayMenu();
  tray.on("click", () => showMainWindow());
  return tray;
}

async function refreshTrayMenu() {
  if (!tray) {
    return;
  }
  let profiles = [];
  try {
    const settings = await loadSettings();
    profiles = settings.loadConfigProfiles(dataRootDir).slice(0, 5);
  } catch (error) {
    appendRuntimeLog(formatError("refreshTrayMenu", error));
  }
  const profileSubmenu = profiles.length
    ? profiles.map((profile) => ({
        label: profile.name,
        click: () => applyProfileFromTray(profile.id),
      }))
    : [{
        label: "暂无配置档",
        enabled: false,
      }];
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: "打开 CodexBridge",
      click: () => showMainWindow(),
    },
    {
      label: routerProcess ? "停止 Router" : "启动 Router",
      click: () => {
        if (routerProcess) {
          stopRouterFromTray();
        } else {
          startRouterProcess();
        }
      },
    },
    {
      label: "重启 Codex",
      click: () => restartCodexDesktop().catch((error) => appendLog(`Restart Codex failed: ${error?.message || error}`)),
    },
    {
      label: "打开日志",
      click: () => navigateRenderer("logs"),
    },
    {
      label: "配置档",
      submenu: profileSubmenu,
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
}

async function stopRouterFromTray() {
  stopRouter();
  try {
    const settings = await loadSettings();
    const result = settings.restoreCodexConfig();
    appendLog(result?.backup
      ? `Restored Codex config after Router stop: ${result.backup}`
      : "Codex config restored after Router stop.");
  } catch (error) {
    appendLog(`Codex config restore after Router stop skipped: ${error?.message || error}`);
  }
  await broadcastState();
  refreshTrayMenu();
}

async function applyProfileFromTray(profileId) {
  try {
    const settings = await loadSettings();
    const profile = settings.loadConfigProfiles(dataRootDir).find((item) => item.id === String(profileId || ""));
    if (!profile) {
      throw new Error("Config profile not found.");
    }
    settings.saveSelection(dataRootDir, profile.selectedModelIds || [], profile.mode);
    settings.saveDesktopOptions(dataRootDir, profile.desktopOptions || {});
    settings.writeRouterConfigFromSelection(dataRootDir, profile.mode);
    appendLog(`Applied config profile from tray: ${profile.name}.`);
    await broadcastState();
    navigateRenderer("settings");
  } catch (error) {
    appendLog(`Apply config profile from tray failed: ${error?.message || error}`);
  } finally {
    refreshTrayMenu();
  }
}

function navigateRenderer(section) {
  showMainWindow();
  sendToRenderer("ui:navigate", { section });
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
  usageRoutes = config?.models || [];
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
    modelDirectory: settings.readModelDirectory(dataRootDir),
    modelCapabilityOverrides: settings.readModelCapabilityOverrides(dataRootDir),
    selectedModelIds: settings.readSelection(dataRootDir, mode),
    customModels: settings.readCustomModels(dataRootDir),
    imageGenerationOverrides: settings.readModelImageGenerationOverrides(dataRootDir),
    secretStatus: settings.secretStatus(dataRootDir),
    desktopOptions: settings.loadDesktopOptions(dataRootDir),
    diagnostics,
    startupCheck: settings.buildStartupCheck(dataRootDir, {
      appVersion: app.getVersion(),
      routerRunning: Boolean(routerProcess),
      lastHealth,
      config,
    }),
    configProfiles: settings.loadConfigProfiles(dataRootDir),
    codexBackups: settings.listCodexBackups(),
    codexResources: settings.listCodexResources({ rootDir: appRootDir }),
    codexSessions: settings.listCodexSessions({ limit: 50 }),
    lastHealth,
    usageEvents: usageStore?.events() || [],
    usageSummary: usageStore?.summary({ routes: config?.models || [] }) || emptyUsageSummary(),
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
  try {
    const config = settings.writeRouterConfigFromSelection(
      dataRootDir,
      settings.detectModeFromConfig(settings.readRouterConfig(dataRootDir)),
    );
    appendLog(`Router port configured: ${config.port}. Restart Router for port changes to take effect.`);
  } catch (error) {
    appendLog(`Router config refresh after options save skipped: ${error?.message || error}`);
  }
  broadcastState();
  return getStatePayload(settings);
});

ipcMain.handle("startup:check", async () => {
  const settings = await loadSettings();
  const config = settings.readRouterConfig(dataRootDir);
  const check = settings.buildStartupCheck(dataRootDir, {
    appVersion: app.getVersion(),
    routerRunning: Boolean(routerProcess),
    lastHealth,
    config,
  });
  appendLog(`Startup check: pass=${check.summary.pass} warn=${check.summary.warn} fail=${check.summary.fail}.`);
  broadcastState();
  return check;
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

ipcMain.handle("models:saveCapabilities", async (_event, payload) => {
  const settings = await loadSettings();
  const presetId = String(payload?.presetId || "");
  const saved = settings.saveModelCapabilityOverride(
    dataRootDir,
    presetId,
    payload?.capabilities || {},
  );
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
  appendLog(`Updated model capabilities: ${presetId}.`);
  broadcastState();
  return {
    saved,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("models:resetCapabilities", async (_event, presetId) => {
  const settings = await loadSettings();
  const reset = settings.resetModelCapabilityOverride(dataRootDir, String(presetId || ""));
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
  appendLog(`Reset model capabilities: ${reset.presetId}.`);
  broadcastState();
  return {
    reset,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("providers:refreshModels", async (_event, providerId) => {
  const settings = await loadSettings();
  const result = await settings.refreshProviderModelDirectory(dataRootDir, String(providerId || ""));
  appendLog(
    result.ok
      ? `Refreshed model directory: ${result.providerId} (${result.count || 0} models).`
      : `Model directory refresh failed: ${result.providerId} ${result.error || "unknown error"}.`,
  );
  broadcastState();
  return {
    result,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("providers:save", async (_event, provider) => {
  const settings = await loadSettings();
  const providerId = String(provider?.providerId || provider?.id || "").trim();
  const saved = settings.saveProviderOverride(dataRootDir, providerId, provider || {});
  const current = settings.providerCatalog(dataRootDir).find((item) => item.id === providerId);
  const apiKey = typeof provider?.apiKey === "string" ? provider.apiKey.trim() : "";
  const keyEnv = saved.keyEnv || current?.keyEnv || "";
  if (apiKey && keyEnv) {
    settings.saveSecrets(dataRootDir, { [keyEnv]: apiKey });
  }
  appendLog(`Saved provider settings: ${saved.name || providerId}.`);
  broadcastState();
  return {
    saved,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("providers:testConnection", async (_event, provider) => {
  const settings = await loadSettings();
  const result = await settings.testProviderConnection(dataRootDir, provider);
  appendLog(
    result.ok
      ? `Provider connection OK: ${result.providerId} (${result.status || 0}).`
      : `Provider connection failed: ${result.providerId || "unknown"} ${result.error || result.message || "unknown error"}.`,
  );
  return result;
});

ipcMain.handle("logos:select", async (_event, payload = {}) => {
  const providerId = String(payload?.providerId || payload?.ownerId || "").trim();
  const ownerId = providerId || String(payload?.ownerId || "provider").trim();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择本地图标",
    properties: ["openFile"],
    filters: [
      { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "svg", "ico"] },
    ],
  });
  if (result.canceled || !result.filePaths?.[0]) {
    return { canceled: true };
  }
  const settings = await loadSettings();
  const saved = settings.saveProviderLogo(dataRootDir, ownerId, result.filePaths[0]);
  if (payload?.applyToProvider && providerId) {
    settings.saveProviderOverride(dataRootDir, providerId, { logoUrl: saved.logoUrl });
    appendLog(`Updated provider logo: ${providerId}.`);
    broadcastState();
    return {
      ...saved,
      state: await getStatePayload(settings),
    };
  }
  return saved;
});

ipcMain.handle("customModel:save", async (_event, model) => {
  const settings = await loadSettings();
  const saved = settings.saveCustomModel(dataRootDir, model);
  const apiKey = typeof model?.apiKey === "string" ? model.apiKey.trim() : "";
  if (apiKey && saved.keyEnv) {
    settings.saveSecrets(dataRootDir, { [saved.keyEnv]: apiKey });
  }
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

ipcMain.handle("profiles:save", async (_event, profile) => {
  const settings = await loadSettings();
  const config = settings.readRouterConfig(dataRootDir);
  const mode = settings.detectModeFromConfig(config);
  const saved = settings.saveConfigProfile(dataRootDir, {
    id: profile?.id,
    name: profile?.name || `配置档 ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    mode: profile?.mode || mode,
    selectedModelIds: Array.isArray(profile?.selectedModelIds)
      ? profile.selectedModelIds
      : settings.readSelection(dataRootDir, mode),
    desktopOptions: profile?.desktopOptions || settings.loadDesktopOptions(dataRootDir),
    note: profile?.note || "",
    createdAt: profile?.createdAt,
  });
  appendLog(`Saved config profile: ${saved.name}.`);
  broadcastState();
  return {
    saved,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("profiles:apply", async (_event, profileId) => {
  const settings = await loadSettings();
  const profile = settings.loadConfigProfiles(dataRootDir).find((item) => item.id === String(profileId || ""));
  if (!profile) {
    throw new Error("Config profile not found.");
  }
  settings.saveSelection(dataRootDir, profile.selectedModelIds || [], profile.mode);
  settings.saveDesktopOptions(dataRootDir, profile.desktopOptions || {});
  settings.writeRouterConfigFromSelection(dataRootDir, profile.mode);
  appendLog(`Applied config profile: ${profile.name}.`);
  broadcastState();
  refreshTrayMenu();
  return getStatePayload(settings);
});

ipcMain.handle("backups:restore", async (_event, backupPath) => {
  const settings = await loadSettings();
  const result = settings.restoreCodexConfigFromBackup(String(backupPath || ""));
  appendLog(`Restored Codex config from selected backup: ${result.backup}`);
  if (result.currentBackup) {
    appendLog(`Current config backed up before selected restore: ${result.currentBackup}`);
  }
  broadcastState();
  return {
    result,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("sessions:export", async (_event, sessionId) => {
  const settings = await loadSettings();
  const exported = settings.exportCodexSessionMarkdown(String(sessionId || ""));
  clipboard.writeText(exported.markdown);
  appendLog(`Exported Codex session markdown: ${exported.session?.id || sessionId}.`);
  return {
    ok: true,
    session: exported.session,
    databasePath: exported.databasePath,
    markdownLength: exported.markdown.length,
  };
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
    model: config?.defaultModel,
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
    model: config?.defaultModel,
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

ipcMain.handle("codex:restart", async () => {
  const result = await restartCodexDesktop();
  appendLog(result.message);
  broadcastState();
  return result;
});

ipcMain.handle("codex:select-exe", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose Codex.exe or shortcut",
    properties: ["openFile"],
    filters: [
      { name: "Codex Desktop", extensions: ["exe", "lnk"] },
    ],
  });
  if (result.canceled || !result.filePaths?.[0]) {
    return { canceled: true };
  }
  const selectedPath = result.filePaths[0];
  if (!/\.(?:exe|lnk)$/i.test(selectedPath)) {
    throw new Error("Please choose Codex.exe or a Codex shortcut.");
  }
  if (!fs.existsSync(selectedPath)) {
    throw new Error(`Codex Desktop launch target does not exist: ${selectedPath}`);
  }
  const settings = await loadSettings();
  const savePayload = /\.exe$/i.test(selectedPath)
    ? { codexDesktopExe: selectedPath, codexDesktopLaunchTarget: selectedPath }
    : { codexDesktopLaunchTarget: selectedPath };
  const saved = settings.saveDesktopOptions(dataRootDir, savePayload);
  appendLog(`Saved Codex Desktop launch target: ${saved.codexDesktopLaunchTarget || saved.codexDesktopExe}`);
  broadcastState();
  return {
    ok: true,
    path: saved.codexDesktopLaunchTarget || saved.codexDesktopExe,
    state: await getStatePayload(settings),
  };
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

ipcMain.handle("router:start", async () => startRouterProcess());

async function startRouterProcess(options = {}) {
  if (routerProcess) {
    return { ok: true, message: "Router is already running." };
  }

  if (routerRestartTimer) {
    clearTimeout(routerRestartTimer);
    routerRestartTimer = null;
  }
  routerStopRequested = false;
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
  refreshTrayMenu();

  appendLog(`Starting router with ${nodePath}.`);
  routerProcess.stdout.on("data", (chunk) => appendLog(chunk.toString("utf8").trimEnd()));
  routerProcess.stderr.on("data", (chunk) => appendLog(chunk.toString("utf8").trimEnd()));
  routerProcess.on("exit", (code) => {
    const stoppedByRequest = routerStopRequested;
    if (isQuitting) {
      routerProcess = null;
      refreshTrayMenu();
      return;
    }
    appendLog(`Router stopped with code ${code ?? "unknown"}.`);
    routerProcess = null;
    refreshTrayMenu();
    if (stoppedByRequest) {
      routerStopRequested = false;
      lastHealth = {
        ok: false,
        status: 0,
        models: [],
        message: "Router is stopped.",
        checkedAt: new Date().toISOString(),
      };
      broadcastState();
      return;
    }
    lastHealth = {
      ok: false,
      status: 0,
      models: [],
      message: `Router stopped with code ${code ?? "unknown"}.`,
      checkedAt: new Date().toISOString(),
    };
    broadcastState();
    scheduleRouterRestart(code);
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
  if (!options.watchdog) {
    routerRestartAttempts = 0;
  }
  return { ok: true, message: options.watchdog ? "Router restarted." : "Router started." };
}

ipcMain.handle("router:stop", async () => {
  stopRouter();
  appendLog("Router stop requested.");
  try {
    const settings = await loadSettings();
    const result = settings.restoreCodexConfig();
    appendLog(result?.backup
      ? `Restored Codex config after Router stop: ${result.backup}`
      : "Codex config restored after Router stop.");
  } catch (error) {
    appendLog(`Codex config restore after Router stop skipped: ${error?.message || error}`);
  }
  lastHealth = {
    ok: false,
    status: 0,
    models: [],
    message: "Router is stopped.",
    checkedAt: new Date().toISOString(),
  };
  broadcastState();
  refreshTrayMenu();
  return { ok: true };
});

ipcMain.handle("diagnostics:copy", async () => {
  const settings = await loadSettings();
  const config = settings.readRouterConfig(dataRootDir);
  const diagnostics = settings.supportDiagnostics(dataRootDir, {
    appVersion: app.getVersion(),
    routerRunning: Boolean(routerProcess),
    lastHealth,
    usageSummary: usageStore?.summary({ routes: config?.models || [] }) || emptyUsageSummary(),
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
    installKind: currentInstallKind(),
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
    installKind: currentInstallKind(),
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
      message: "Update installer downloaded; opening installer window.",
    });
    try {
      await launchDownloadedInstaller(prepared.installerPath);
    } catch (error) {
      appendRuntimeLog(formatError("launchUpdateInstaller", error));
      try {
        shell.showItemInFolder(prepared.installerPath);
      } catch (folderError) {
        appendRuntimeLog(formatError("showUpdateInstaller", folderError));
      }
      throw new Error(`Unable to launch update installer: ${error?.message || error}`);
    }
    quitAfterUpdateLaunch();
    return {
      ok: true,
      message: `Downloaded CodexBridge ${plan.latestVersion} installer.`,
      nextStep: `安装窗口已打开：${prepared.installerPath}。你可以选择安装位置；当前 CodexBridge 会退出，安装完成后会启动新版并清理旧版和安装包。`,
      latestVersion: plan.latestVersion,
      installerPath: prepared.installerPath,
      installerNotePath: prepared.installerNotePath,
      updateFolder: prepared.updatesDir,
    };
  }
  const prepared = await preparePortableUpdate(updater, plan, emitUpdateProgress);
  appendLog(`Update package downloaded: ${prepared.downloadPath}`);
  appendLog(`Portable update script ready: ${prepared.scriptPath}`);
  appendLog(`Portable update fallback instructions: ${prepared.manualNotePath}`);
  emitUpdateProgress({
    phase: "restarting",
    downloadedBytes: plan.asset?.size || 0,
    totalBytes: plan.asset?.size || 0,
    percent: 100,
    message: "Update package downloaded; restarting into the new version.",
  });
  try {
    launchPortableUpdateScript(prepared.scriptPath);
  } catch (error) {
    appendRuntimeLog(formatError("launchPortableUpdateScript", error));
    try {
      showDownloadedUpdatePackage(prepared.downloadPath);
    } catch (folderError) {
      appendRuntimeLog(formatError("showUpdatePackage", folderError));
    }
    throw new Error(`Unable to launch portable update script: ${error?.message || error}`);
  }
  quitAfterUpdateLaunch();
  return {
    ok: true,
    message: `Downloaded CodexBridge ${plan.latestVersion} portable update.`,
    nextStep: "正在关闭旧版并启动新版；更新完成后会自动清理安装包和旧版备份。",
    latestVersion: plan.latestVersion,
    relaunching: true,
    downloadPath: prepared.downloadPath,
    manualNotePath: prepared.manualNotePath,
    scriptPath: prepared.scriptPath,
    updateFolder: path.dirname(prepared.downloadPath),
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

function showDownloadedUpdatePackage(packagePath) {
  shell.showItemInFolder(packagePath);
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
  routerStopRequested = true;
  if (routerRestartTimer) {
    clearTimeout(routerRestartTimer);
    routerRestartTimer = null;
  }
  if (options.silent) {
    routerProcess.removeAllListeners("exit");
  }
  routerProcess.kill();
  routerProcess = null;
}

async function restartCodexDesktop() {
  if (process.platform === "win32") {
    return restartCodexDesktopWindows();
  }
  if (process.platform === "darwin") {
    const child = spawn("open", ["-a", "Codex"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return { ok: true, message: "Codex restart requested with macOS open -a Codex." };
  }
  throw new Error("Restart Codex is currently supported on Windows and macOS only.");
}

async function restartCodexDesktopWindows() {
  const settings = await loadSettings();
  const desktopOptions = settings.loadDesktopOptions(dataRootDir);
  const running = await listRunningCodexDesktopProcesses();
  const launchPath = firstExistingPath([
    ...running.map((item) => item.executablePath),
    ...(await codexDesktopLaunchCandidates(desktopOptions)),
  ]);
  if (!launchPath) {
    throw new Error(
      "Could not find Codex Desktop. Click Choose Codex.exe in CodexBridge, install Codex Desktop normally, or set CODEX_DESKTOP_EXE to Codex.exe and try again.",
    );
  }

  await stopCodexDesktopProcesses(running);
  if (running.length) {
    await delay(900);
  }
  launchCodexDesktopTarget(launchPath);
  return {
    ok: true,
    message: running.length
      ? `Codex restarted: ${launchPath}`
      : `Codex started: ${launchPath}`,
  };
}

function launchCodexDesktopTarget(launchPath) {
  const isShortcut = /\.lnk$/i.test(launchPath);
  const isShellTarget = /^shell:/i.test(launchPath);
  const child = isShortcut || isShellTarget
    ? spawn("explorer.exe", [launchPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      })
    : spawn(launchPath, [], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
  child.unref();
}

async function listRunningCodexDesktopProcesses() {
  const wmicRows = await listCodexDesktopProcessesWithWmic();
  if (wmicRows.length) {
    return wmicRows;
  }
  return listCodexDesktopProcessesWithTasklist();
}

async function listCodexDesktopProcessesWithWmic() {
  const result = await runCommandCapture("wmic.exe", [
    "process",
    "where",
    "name='Codex.exe'",
    "get",
    "ProcessId,ExecutablePath",
    "/format:csv",
  ]);
  if (!result.ok || !result.stdout.trim()) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^Node,ExecutablePath,ProcessId$/i.test(line))
    .map((line) => {
      const parts = line.split(",");
      const processId = Number(parts.pop());
      const executablePath = parts.slice(1).join(",").trim();
      return { processId, executablePath };
    })
    .filter((item) => Number.isInteger(item.processId) && item.executablePath && !/CodexBridge/i.test(item.executablePath));
}

async function listCodexDesktopProcessesWithTasklist() {
  const result = await runCommandCapture("tasklist.exe", [
    "/FI",
    "IMAGENAME eq Codex.exe",
    "/FO",
    "CSV",
    "/NH",
  ]);
  if (!result.ok || !result.stdout.trim() || /No tasks are running/i.test(result.stdout)) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const columns = parseCsvLine(line);
      return {
        processId: Number(columns[1]),
        executablePath: "",
      };
    })
    .filter((item) => Number.isInteger(item.processId));
}

async function stopCodexDesktopProcesses(running) {
  if (!running.length) {
    return;
  }
  const processIds = running
    .map((item) => item.processId)
    .filter((processId) => Number.isInteger(processId));
  if (processIds.length) {
    await Promise.all(processIds.map((processId) => runCommandQuiet("taskkill.exe", ["/PID", String(processId), "/F"])));
    return;
  }
  await runCommandQuiet("taskkill.exe", ["/IM", "Codex.exe", "/F"]);
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function codexDesktopCandidates(desktopOptions = {}) {
  const localAppData = process.env.LOCALAPPDATA || "";
  const appData = process.env.APPDATA || "";
  const userProfile = process.env.USERPROFILE || "";
  const programFiles = process.env.ProgramFiles || "";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "";
  const candidates = [
    desktopOptions?.codexDesktopLaunchTarget,
    desktopOptions?.codexDesktopExe,
    process.env.CODEX_DESKTOP_EXE,
    path.join(localAppData, "OpenAI", "Codex", "Codex.exe"),
    path.join(localAppData, "OpenAI", "Codex", "app", "Codex.exe"),
    path.join(localAppData, "OpenAI", "Codex", "app", "app", "Codex.exe"),
    path.join(localAppData, "Programs", "Codex", "app", "Codex.exe"),
    path.join(localAppData, "Programs", "Codex", "Codex.exe"),
    path.join(localAppData, "Programs", "Codex Desktop", "Codex.exe"),
    path.join(localAppData, "Programs", "OpenAI Codex", "Codex.exe"),
    path.join(localAppData, "Programs", "OpenAI", "Codex.exe"),
    path.join(localAppData, "Programs", "OpenAI", "Codex", "Codex.exe"),
    path.join(localAppData, "Codex", "Codex.exe"),
    path.join(appData, "Codex", "Codex.exe"),
    path.join(userProfile, "AppData", "Local", "OpenAI", "Codex", "Codex.exe"),
    path.join(userProfile, "AppData", "Local", "Programs", "Codex", "Codex.exe"),
    path.join(programFiles, "Codex", "Codex.exe"),
    path.join(programFiles, "OpenAI Codex", "Codex.exe"),
    path.join(programFiles, "OpenAI", "Codex", "Codex.exe"),
    path.join(programFilesX86, "Codex", "Codex.exe"),
    path.join(programFilesX86, "OpenAI Codex", "Codex.exe"),
    path.join(programFilesX86, "OpenAI", "Codex", "Codex.exe"),
  ];
  return [...new Set(candidates.filter(Boolean))];
}

async function codexDesktopLaunchCandidates(desktopOptions = {}) {
  if (process.platform !== "win32") {
    return codexDesktopCandidates(desktopOptions);
  }
  const shortcutCandidates = codexDesktopShortcutCandidates();
  const candidates = [
    ...codexDesktopCandidates(desktopOptions),
    ...shortcutCandidates,
    ...(await codexDesktopShortcutTargets(shortcutCandidates)),
    ...(await codexDesktopWhereCandidates()),
  ];
  return [...new Set(candidates.filter(Boolean))];
}

function codexDesktopShortcutCandidates() {
  const appData = process.env.APPDATA || "";
  const programData = process.env.ProgramData || "";
  const userProfile = process.env.USERPROFILE || "";
  const startMenuRoots = [
    path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs"),
    path.join(programData, "Microsoft", "Windows", "Start Menu", "Programs"),
    path.join(userProfile, "Desktop"),
    path.join(process.env.PUBLIC || "", "Desktop"),
  ].filter(Boolean);
  const fixed = [
    path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Codex.lnk"),
    path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Codex Desktop.lnk"),
    path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "OpenAI Codex.lnk"),
    path.join(programData, "Microsoft", "Windows", "Start Menu", "Programs", "Codex.lnk"),
    path.join(programData, "Microsoft", "Windows", "Start Menu", "Programs", "Codex Desktop.lnk"),
    path.join(programData, "Microsoft", "Windows", "Start Menu", "Programs", "OpenAI Codex.lnk"),
    path.join(userProfile, "Desktop", "Codex.lnk"),
    path.join(userProfile, "Desktop", "Codex Desktop.lnk"),
    path.join(userProfile, "Desktop", "OpenAI Codex.lnk"),
  ].filter(Boolean);
  return [
    ...fixed,
    ...startMenuRoots.flatMap((root) => findCodexDesktopShortcuts(root)),
  ].filter(Boolean);
}

function findCodexDesktopShortcuts(rootDir, maxDepth = 3) {
  const found = [];
  const stack = [{ dir: rootDir, depth: 0 }];
  while (stack.length) {
    const current = stack.pop();
    try {
      for (const entry of fs.readdirSync(current.dir, { withFileTypes: true })) {
        const entryPath = path.join(current.dir, entry.name);
        if (entry.isDirectory() && current.depth < maxDepth) {
          stack.push({ dir: entryPath, depth: current.depth + 1 });
          continue;
        }
        if (entry.isFile() && /\.lnk$/i.test(entry.name) && /codex/i.test(entry.name)) {
          found.push(entryPath);
        }
      }
    } catch {
      // Some shell folders can be unavailable or permission-protected.
    }
  }
  return found;
}

async function codexDesktopShortcutTargets(shortcutCandidates = codexDesktopShortcutCandidates()) {
  const existingShortcuts = shortcutCandidates.filter((candidate) => safeExists(candidate));
  const targets = [];
  for (const shortcutPath of existingShortcuts) {
    const target = await resolveWindowsShortcutTarget(shortcutPath);
    if (target && /codex\.exe$/i.test(target)) {
      targets.push(target);
    }
  }
  return targets;
}

async function resolveWindowsShortcutTarget(shortcutPath) {
  const result = await runCommandCapture("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($args[0]); [Console]::OutputEncoding=[Text.UTF8Encoding]::UTF8; $s.TargetPath",
    shortcutPath,
  ]);
  if (!result.ok) {
    return "";
  }
  return result.stdout.trim().split(/\r?\n/)[0] || "";
}

async function codexDesktopWhereCandidates() {
  const result = await runCommandCapture("where.exe", ["Codex.exe"]);
  if (!result.ok) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /codex\.exe$/i.test(line));
}

function firstExistingPath(candidates) {
  return candidates.find((candidate) => {
    try {
      return candidate && fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
}

function safeExists(targetPath) {
  try {
    return Boolean(targetPath && fs.existsSync(targetPath));
  } catch {
    return false;
  }
}

function runCommandCapture(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.on("exit", (code) => resolve({ ok: code === 0, stdout }));
    child.on("error", () => resolve({ ok: false, stdout: "" }));
  });
}

function runCommandQuiet(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: "ignore",
    });
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupUpdateArtifactsOnStartup() {
  if (process.env.CODEXBRIDGE_DESKTOP_SMOKE === "1") {
    return;
  }
  try {
    const updater = await loadUpdater();
    fs.mkdirSync(portableUpdatesDir(), { recursive: true });
    await updater.cleanupManagedUpdateArtifacts?.(portableUpdatesDir(), { keepPackages: launchedAfterUpdate ? 0 : 1 });
    if (launchedAfterUpdate) {
      cleanupInstallerPackageAfterUpdate();
      cleanupInstalledAppVersionsAfterUpdate();
    }
  } catch (error) {
    appendRuntimeLog(formatError("cleanupUpdates", error));
  }
}

function cleanupInstallerPackageAfterUpdate() {
  const installerPath = updateCleanupInstallerPath();
  if (!installerPath) {
    return;
  }
  const updatesDir = portableUpdatesDir();
  if (!isPathInsideOrEqual(installerPath, updatesDir)) {
    appendRuntimeLog(`Skipped update installer cleanup outside managed updates folder: ${installerPath}`);
    return;
  }
  if (!/CodexBridge-Windows-x64-Setup\.exe$/i.test(path.basename(installerPath))) {
    appendRuntimeLog(`Skipped update installer cleanup for unexpected file: ${installerPath}`);
    return;
  }
  try {
    fs.rmSync(installerPath, { force: true });
    appendRuntimeLog(`Removed update installer package: ${installerPath}`);
  } catch (error) {
    appendRuntimeLog(formatError("cleanupUpdateInstaller", error));
  }
}

function cleanupInstalledAppVersionsAfterUpdate() {
  if (process.platform !== "win32" || !app.isPackaged) {
    return;
  }
  const currentAppDir = path.resolve(path.dirname(process.execPath));
  const roots = uniquePaths([
    installedRootForVersionedAppDir(currentAppDir),
    updatePreviousInstallDir(),
  ].filter(Boolean));
  if (!roots.length) {
    return;
  }

  for (const installedRoot of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(installedRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        appendRuntimeLog(formatError("cleanupInstalledApps", error));
      }
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^app-/i.test(entry.name)) {
        continue;
      }
      const targetDir = path.resolve(installedRoot, entry.name);
      if (samePath(targetDir, currentAppDir)) {
        continue;
      }
      try {
        removeDirectoryTreeSafeSync(targetDir, installedRoot);
        appendRuntimeLog(`Removed previous CodexBridge app directory: ${targetDir}`);
      } catch (error) {
        appendRuntimeLog(formatError("cleanupInstalledAppVersion", error));
      }
    }
  }
}

function installedRootForVersionedAppDir(appDir) {
  const resolvedAppDir = path.resolve(appDir || "");
  if (!/^app-/i.test(path.basename(resolvedAppDir))) {
    return "";
  }
  return path.dirname(resolvedAppDir);
}

function updatePreviousInstallDir() {
  const value = commandLineOptionValue("--previous-install-dir");
  if (!value) {
    return "";
  }
  const resolved = path.resolve(value);
  return /^app-/i.test(path.basename(resolved)) ? path.dirname(resolved) : resolved;
}

function updateCleanupInstallerPath() {
  const value = commandLineOptionValue("--cleanup-installer");
  return value ? path.resolve(value) : "";
}

function commandLineOptionValue(name) {
  const args = process.argv || [];
  const prefix = `${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || "");
    if (arg === name) {
      const nextArg = String(args[index + 1] || "");
      return nextArg && !nextArg.startsWith("--") ? nextArg : "";
    }
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return "";
}

function uniquePaths(paths) {
  const seen = new Set();
  const result = [];
  for (const item of paths) {
    const resolved = path.resolve(item);
    const key = normalizeFsPath(resolved).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(resolved);
    }
  }
  return result;
}

function removeDirectoryTreeSafeSync(targetDir, allowedRoot) {
  const target = normalizeFsPath(targetDir);
  const root = normalizeFsPath(allowedRoot);
  if (!target || !root || samePath(target, root) || !isPathInsideOrEqual(target, root)) {
    throw new Error(`Refusing to remove directory outside allowed root: ${targetDir}`);
  }
  if (!fs.existsSync(target)) {
    return;
  }
  const removeEntries = [];
  const collect = (folder) => {
    const children = fs.readdirSync(folder, { withFileTypes: true });
    for (const child of children) {
      const childPath = path.resolve(folder, child.name);
      if (!isPathInsideOrEqual(childPath, target)) {
        throw new Error(`Refusing to remove item outside target directory: ${childPath}`);
      }
      if (child.isDirectory() && !child.isSymbolicLink()) {
        collect(childPath);
        removeEntries.push({ path: childPath, directory: true });
      } else {
        removeEntries.push({ path: childPath, directory: false });
      }
    }
  };
  collect(target);
  for (const entry of removeEntries) {
    if (entry.directory) {
      fs.rmdirSync(entry.path);
    } else {
      fs.rmSync(entry.path, { force: true });
    }
  }
  fs.rmdirSync(target);
}

function isPathInsideOrEqual(candidate, root) {
  const candidatePath = normalizeFsPath(candidate);
  const rootPath = normalizeFsPath(root);
  if (!candidatePath || !rootPath) {
    return false;
  }
  if (samePath(candidatePath, rootPath)) {
    return true;
  }
  return candidatePath.toLowerCase().startsWith(`${rootPath.toLowerCase()}${path.sep}`);
}

function samePath(left, right) {
  return normalizeFsPath(left).toLowerCase() === normalizeFsPath(right).toLowerCase();
}

function normalizeFsPath(value) {
  if (!value) {
    return "";
  }
  return path.resolve(String(value)).replace(/[\\/]+$/, "");
}

function scheduleRouterRestart(exitCode) {
  if (isQuitting || routerStopRequested || routerRestartTimer) {
    return;
  }
  if (routerRestartAttempts >= ROUTER_RESTART_MAX_ATTEMPTS) {
    appendLog(`Router watchdog stopped after ${ROUTER_RESTART_MAX_ATTEMPTS} failed restart attempts.`);
    lastHealth = {
      ok: false,
      status: 0,
      models: [],
      message: "Router stopped and automatic restart attempts were exhausted.",
      checkedAt: new Date().toISOString(),
    };
    broadcastState();
    return;
  }
  routerRestartAttempts += 1;
  const delayMs = Math.min(ROUTER_RESTART_BASE_DELAY_MS * routerRestartAttempts, ROUTER_RESTART_MAX_DELAY_MS);
  appendLog(
    `Router watchdog will restart in ${delayMs} ms ` +
      `(attempt ${routerRestartAttempts}/${ROUTER_RESTART_MAX_ATTEMPTS}, last code ${exitCode ?? "unknown"}).`,
  );
  routerRestartTimer = setTimeout(async () => {
    routerRestartTimer = null;
    if (isQuitting || routerStopRequested || routerProcess) {
      return;
    }
    try {
      appendLog("Router watchdog restarting Router.");
      await startRouterProcess({ watchdog: true });
    } catch (error) {
      appendLog(formatError("routerWatchdog", error));
      lastHealth = {
        ok: false,
        status: 0,
        models: [],
        message: `Router watchdog restart failed: ${error?.message || error}`,
        checkedAt: new Date().toISOString(),
      };
      broadcastState();
      scheduleRouterRestart(exitCode);
    }
  }, delayMs);
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
  const installerNotePath = path.join(updatesDir, `install-update-${stamp}.txt`);
  writeInstallerUpdateInstructions({
    installerNotePath,
    installerPath,
    updatesDir,
  });
  await updater.cleanupManagedUpdateArtifacts?.(updatesDir, { keepPackages: 1 });
  return { installerPath, installerNotePath, updatesDir };
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
    await updater.cleanupManagedUpdateArtifacts?.(updatesDir, { keepPackages: 1 });
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
    await updater.cleanupManagedUpdateArtifacts?.(updatesDir, { keepPackages: 1 });
    return { downloadPath, scriptPath: scriptFile, manualNotePath };
  }
  throw new Error(`当前系统暂不支持应用内更新：${process.platform} ${process.arch}`);
}

function portableUpdatesDir() {
  return path.join(dataRootDir, "updates");
}

function currentInstallKind() {
  const forced = String(process.env.CODEXBRIDGE_INSTALL_KIND || "").toLowerCase();
  if (forced === "installed" || forced === "portable") {
    return forced;
  }
  if (!app.isPackaged) {
    return "portable";
  }
  if (process.platform !== "win32") {
    return "portable";
  }
  const versionedInstallRoot = installedRootForVersionedAppDir(path.dirname(process.execPath));
  if (versionedInstallRoot) {
    return "installed";
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    return "portable";
  }
  const installedRoot = path.resolve(localAppData, "Programs", "CodexBridge").toLowerCase();
  const exePath = path.resolve(process.execPath).toLowerCase();
  return exePath === installedRoot || exePath.startsWith(`${installedRoot}${path.sep}`)
    ? "installed"
    : "portable";
}

function quitAfterUpdateLaunch() {
  const timer = setTimeout(() => {
    isQuitting = true;
    stopRouter({ silent: true });
    app.quit();
    const forceExitTimer = setTimeout(() => app.exit(0), 3000);
    forceExitTimer.unref?.();
  }, 700);
  timer.unref?.();
}

async function launchDownloadedInstaller(installerPath) {
  if (!installerPath) {
    throw new Error("Missing update installer path.");
  }
  if (process.platform === "win32") {
    const openError = await shell.openPath(installerPath);
    if (openError) {
      throw new Error(openError);
    }
    return;
  }
  const child = spawn(installerPath, [], {
    detached: true,
    stdio: "ignore",
  });
  child.unref?.();
}

function launchPortableUpdateScript(scriptPath) {
  if (!scriptPath) {
    throw new Error("Missing portable update script path.");
  }
  const child = process.platform === "win32"
    ? spawn("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
      ], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      })
    : spawn("/bin/sh", [scriptPath], {
        detached: true,
        stdio: "ignore",
      });
  child.unref?.();
}

function writeInstallerUpdateInstructions({
  installerNotePath,
  installerPath,
  updatesDir,
}) {
  const lines = [
    "CodexBridge Windows Setup installer update",
    "",
    `Downloaded installer: ${installerPath}`,
    `Updates folder: ${updatesDir}`,
    "",
    "What happens next:",
    "1. CodexBridge opens the interactive installer window after the download finishes.",
    "2. Choose an install location in the installer if you do not want the default user Programs folder.",
    "3. The installer creates a desktop shortcut by default, launches the new CodexBridge, and passes cleanup information to it.",
    "4. The new app removes the downloaded installer package and previous managed app-* version folders.",
    "5. Your configuration, keys, model selection, statistics, and logs are stored in the user data directory.",
    "",
    "The current app is not silently replaced while it is running.",
  ];
  fs.writeFileSync(installerNotePath, `${lines.join("\n")}\n`, "utf8");
}

function writeManualUpdateInstructions({
  manualNotePath,
  packagePath,
  currentAppDir,
  platform,
}) {
  const lines = [
    "CodexBridge Portable update fallback instructions",
    "",
    `Downloaded package: ${packagePath}`,
    `Current app directory: ${currentAppDir}`,
    "Automatic update should launch the helper script and restart CodexBridge after download.",
    "If automatic update does not restart, use the fallback steps below.",
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
  usageRoutes = config?.models || [];
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
    modelDirectory: settings.readModelDirectory(dataRootDir),
    modelCapabilityOverrides: settings.readModelCapabilityOverrides(dataRootDir),
    selectedModelIds: settings.readSelection(dataRootDir, mode),
    customModels: settings.readCustomModels(dataRootDir),
    imageGenerationOverrides: settings.readModelImageGenerationOverrides(dataRootDir),
    secretStatus: settings.secretStatus(dataRootDir),
    desktopOptions: settings.loadDesktopOptions(dataRootDir),
    diagnostics,
    startupCheck: settings.buildStartupCheck(dataRootDir, {
      appVersion: app.getVersion(),
      routerRunning: Boolean(routerProcess),
      lastHealth,
      config,
    }),
    configProfiles: settings.loadConfigProfiles(dataRootDir),
    codexBackups: settings.listCodexBackups(),
    codexResources: settings.listCodexResources({ rootDir: appRootDir }),
    codexSessions: settings.listCodexSessions({ limit: 50 }),
    lastHealth,
    usageEvents: usageStore?.events() || [],
    usageSummary: usageStore?.summary({ routes: config?.models || [] }) || emptyUsageSummary(),
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

function usagePayload() {
  return {
    usageEvents: usageStore?.events() || [],
    usageSummary: usageStore?.summary({ routes: usageRoutes }) || emptyUsageSummary(),
  };
}

function emptyUsageSummary() {
  return {
    totalCalls: 0,
    totalTokens: 0,
    promptTokens: 0,
    freshPromptTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    completionTokens: 0,
    statusCounts: {},
    byModel: [],
    latest: null,
    current: {
      totalCalls: 0,
      totalTokens: 0,
      promptTokens: 0,
      freshPromptTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      completionTokens: 0,
      statusCounts: {},
      byModel: [],
      events: [],
      latest: null,
    },
    history: {
      totalCalls: 0,
      totalTokens: 0,
      promptTokens: 0,
      freshPromptTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      completionTokens: 0,
      statusCounts: {},
      byModel: [],
      events: [],
      latest: null,
    },
  };
}

async function runDesktopSmokeChecks() {
  try {
    const result = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const required = [
          "#runStartupCheck",
          "#routerToggle",
          "#restartCodex",
          "#healthStatus",
          "#saveModelSelectionPanel",
          "#providerGrid",
          "#providerPreview",
          "#modelConfigPool",
          "#stats",
          "#settings",
          "#routerPort",
          "#saveDesktopOptions",
          "#bypassSystemProxy",
          "#usageRange",
          "#usageChart",
          "#resourceSummary",
          "#resourceList",
          "#sessionList",
          "#recoverHistoryAccessSessions",
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
        await waitFor(() => document.querySelectorAll("[data-provider-preview]").length >= 3);
        document.querySelector('[data-section="models"]').click();
        if (document.querySelector("#models").classList.contains("hidden")) {
          throw new Error("Models nav did not activate");
        }
        if (!document.querySelector("[data-provider-preview]")) {
          throw new Error("Provider preview did not render");
        }
        if (!document.querySelector("[data-provider-edit]")) {
          throw new Error("Provider edit button missing");
        }
        if (!document.querySelector("[data-open-custom-editor]")) {
          throw new Error("Custom model entry missing");
        }
        if (!document.querySelector("#modelPool .model-card")) {
          throw new Error("Model pool did not render");
        }
        document.querySelector('[data-section="settings"]').click();
        if (document.querySelector("#settings").classList.contains("hidden")) {
          throw new Error("Settings nav did not activate");
        }
        document.querySelector('[data-section="preflight"]').click();
        if (document.querySelector("#preflight").classList.contains("hidden")) {
          throw new Error("Preflight nav did not activate");
        }
        document.querySelector('[data-section="resources"]').click();
        if (document.querySelector("#resources").classList.contains("hidden")) {
          throw new Error("Resources nav did not activate");
        }
        document.querySelector('[data-section="sessions"]').click();
        if (document.querySelector("#sessions").classList.contains("hidden")) {
          throw new Error("Sessions nav did not activate");
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
