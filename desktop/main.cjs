const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const appRootDir = path.resolve(__dirname, "..");
const dataRootDir = app.isPackaged
  ? path.join(path.dirname(process.execPath), "CodexBridgeData")
  : appRootDir;
const runtimeLogPath = path.join(dataRootDir, "logs", "desktop-runtime.log");
let settingsPromise;
let mainWindow;
let routerProcess = null;
let logLines = [];
let smokeErrors = [];

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
      if (smokeErrors.length) {
        console.error(`CodexBridge desktop smoke saw ${smokeErrors.length} renderer error(s).`);
        for (const error of smokeErrors) {
          console.error(error);
        }
        app.exit(1);
        return;
      }
      console.log("CodexBridge desktop smoke loaded.");
      app.quit();
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
  return {
    rootDir: dataRootDir,
    appRootDir,
    packaged: app.isPackaged,
    mode,
    routerRunning: Boolean(routerProcess),
    configExists: Boolean(config),
    models: config?.models || [],
    secretStatus: settings.secretStatus(dataRootDir),
    logs: logLines,
  };
});

ipcMain.handle("mode:select", async (_event, mode) => {
  const settings = await loadSettings();
  settings.ensureRouterConfig(dataRootDir, mode, appRootDir);
  appendLog(`Selected ${mode === settings.MODE_HYBRID ? "Hybrid" : "All API"} mode.`);
  return ipcMain.emit ? getStatePayload(settings) : null;
});

ipcMain.handle("secrets:save", async (_event, secrets) => {
  const settings = await loadSettings();
  const saved = settings.saveSecrets(dataRootDir, secrets);
  appendLog(`Saved API key settings: ${Object.keys(saved).join(", ") || "none"}.`);
  return settings.secretStatus(dataRootDir);
});

ipcMain.handle("catalog:generate", async () => {
  const settings = await loadSettings();
  const result = await runNodeScript([
    scriptPath("scripts/generate-catalog.js"),
    settings.catalogPath(dataRootDir),
  ]);
  appendLog(result.ok ? "Generated model-catalog.json." : `Catalog generation failed: ${result.output}`);
  return result;
});

ipcMain.handle("codex:apply", async () => {
  const settings = await loadSettings();
  const config = settings.readRouterConfig(dataRootDir);
  const mode = settings.detectModeFromConfig(config);
  const result = settings.applyCodexConfig({
    rootDir: dataRootDir,
    mode,
    port: config?.port || 15722,
  });
  appendLog(`Applied Codex config: ${result.target}`);
  if (result.backup) {
    appendLog(`Backup created: ${result.backup}`);
  }
  return result;
});

ipcMain.handle("router:start", async () => {
  if (routerProcess) {
    return { ok: true, message: "Router is already running." };
  }

  const settings = await loadSettings();
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
    broadcastState();
  });

  broadcastState();
  return { ok: true, message: "Router started." };
});

ipcMain.handle("router:stop", async () => {
  stopRouter();
  appendLog("Router stop requested.");
  broadcastState();
  return { ok: true };
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
  const env = settings.envWithSecrets(dataRootDir, {
    ...process.env,
    ROUTER_CONFIG: settings.routerConfigPath(dataRootDir),
  });
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
    logLines.push(`[${new Date().toLocaleTimeString()}] ${entry}`);
  }
  logLines = logLines.slice(-300);
  mainWindow?.webContents.send("logs:update", logLines);
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
  return {
    rootDir: dataRootDir,
    appRootDir,
    packaged: app.isPackaged,
    mode: settings.detectModeFromConfig(config),
    routerRunning: Boolean(routerProcess),
    configExists: Boolean(config),
    models: config?.models || [],
    secretStatus: settings.secretStatus(dataRootDir),
    logs: logLines,
  };
}
