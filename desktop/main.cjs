const { app, BrowserWindow, clipboard, dialog, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  legacyPortableDataCandidates,
  migrateLegacyPortableData,
  resolveDataRootDir,
} = require("./data-dir.cjs");

const appRootDir = path.resolve(__dirname, "..");
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
let mainWindow;
let routerProcess = null;
let logLines = [];
let smokeErrors = [];
let usageStore = null;
let lastHealth = null;

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

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  createWindow();
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

app.on("window-all-closed", () => {
  stopRouter();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

ipcMain.handle("state:get", async () => {
  const settings = await loadSettings();
  const config = settings.readRouterConfig(dataRootDir);
  const mode = settings.detectModeFromConfig(config);
  const diagnostics = settings.routerConfigDiagnostics(dataRootDir, config);
  return {
    rootDir: dataRootDir,
    appRootDir,
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
    config,
    logs: logLines,
  });
  clipboard.writeText(diagnostics.text);
  appendLog("Copied sanitized diagnostics to clipboard.");
  broadcastState();
  return diagnostics.summary;
});

ipcMain.handle("folder:open", async (_event, target) => {
  const settings = await loadSettings();
  const folder =
    target === "codex"
      ? path.dirname(settings.codexConfigPath())
      : target === "config"
        ? path.join(dataRootDir, "config")
        : dataRootDir;
  await shell.openPath(folder);
  return { ok: true };
});

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

function stopRouter() {
  if (!routerProcess) {
    return;
  }
  routerProcess.kill();
  routerProcess = null;
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
  mainWindow?.webContents.send("logs:update", logLines);
  mainWindow?.webContents.send("usage:update", usagePayload());
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
  mainWindow?.webContents.send("state:update", await getStatePayload(settings));
}

async function getStatePayload(settings) {
  const config = settings.readRouterConfig(dataRootDir);
  const mode = settings.detectModeFromConfig(config);
  const diagnostics = settings.routerConfigDiagnostics(dataRootDir, config);
  return {
    rootDir: dataRootDir,
    appRootDir,
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
  const { probeRouterHealth } = await loadRouterHealth();
  const host = config?.host || "127.0.0.1";
  const port = config?.port || 15722;
  const origin = `http://${host}:${port}`;
  let result = null;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    result = await probeRouterHealth({ origin, timeoutMs: 1200 });
    if (result.ok) {
      break;
    }
    await delay(250);
  }
  lastHealth = result;
  appendLog(
    result.ok
      ? `Health OK: ${result.models.join(", ") || "no models listed"}.`
      : `Health failed: ${result.message}`,
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
          "#copyDiagnostics"
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
