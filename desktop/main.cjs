const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
let settingsPromise;
let mainWindow;
let routerProcess = null;
let logLines = [];

if (process.env.CODEXBRIDGE_DESKTOP_SMOKE === "1") {
  app.disableHardwareAcceleration();
}

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
  const config = settings.readRouterConfig(rootDir);
  const mode = settings.detectModeFromConfig(config);
  return {
    rootDir,
    mode,
    routerRunning: Boolean(routerProcess),
    configExists: Boolean(config),
    models: config?.models || [],
    secretStatus: settings.secretStatus(rootDir),
    logs: logLines,
  };
});

ipcMain.handle("mode:select", async (_event, mode) => {
  const settings = await loadSettings();
  settings.ensureRouterConfig(rootDir, mode);
  appendLog(`Selected ${mode === settings.MODE_HYBRID ? "Hybrid" : "All API"} mode.`);
  return ipcMain.emit ? getStatePayload(settings) : null;
});

ipcMain.handle("secrets:save", async (_event, secrets) => {
  const settings = await loadSettings();
  const saved = settings.saveSecrets(rootDir, secrets);
  appendLog(`Saved API key settings: ${Object.keys(saved).join(", ") || "none"}.`);
  return settings.secretStatus(rootDir);
});

ipcMain.handle("catalog:generate", async () => {
  const result = await runNodeScript(["scripts/generate-catalog.js"]);
  appendLog(result.ok ? "Generated model-catalog.json." : `Catalog generation failed: ${result.output}`);
  return result;
});

ipcMain.handle("codex:apply", async () => {
  const settings = await loadSettings();
  const config = settings.readRouterConfig(rootDir);
  const mode = settings.detectModeFromConfig(config);
  const result = settings.applyCodexConfig({
    rootDir,
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
  routerProcess = spawn(nodePath, ["src/server.js"], {
    cwd: rootDir,
    env: settings.envWithSecrets(rootDir, process.env),
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
        ? path.join(rootDir, "config")
        : rootDir;
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
      cwd: rootDir,
      env: settings.envWithSecrets(rootDir, process.env),
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
  return process.env.npm_node_execpath || "node";
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

async function broadcastState() {
  const settings = await loadSettings();
  mainWindow?.webContents.send("state:update", await getStatePayload(settings));
}

async function getStatePayload(settings) {
  const config = settings.readRouterConfig(rootDir);
  return {
    rootDir,
    mode: settings.detectModeFromConfig(config),
    routerRunning: Boolean(routerProcess),
    configExists: Boolean(config),
    models: config?.models || [],
    secretStatus: settings.secretStatus(rootDir),
    logs: logLines,
  };
}
