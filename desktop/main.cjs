const { app, BrowserWindow, Menu, Tray, clipboard, desktopCapturer, dialog, ipcMain, screen, shell } = require("electron");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { Worker } = require("node:worker_threads");
const { resolveDataRootDir } = require("./data-dir.cjs");
const { createDesktopLocalCapabilityExecutor } = require("./local-capabilities.cjs");
const {
  DESKTOP_APP_IMAGE_NAMES,
  authorizeOpenAIDesktopProcesses,
  buildOpenAIDesktopRestartPlan,
  canonicalSavedOpenAIDesktopTarget,
  classifyOpenAIDesktopProcess,
  isOpenAIDesktopExecutablePath,
  isOpenAIDesktopLaunchTarget,
  isOpenAIDesktopShellTarget,
  isOpenAIDesktopShortcutName,
  isKnownMacOpenAIDesktopApp,
  macOpenAIDesktopCommandPlan,
  macOpenAIDesktopCandidates,
  openAIDesktopLaunchKind,
  openAIDesktopStorePackageFamily,
  openAIDesktopTargetFromShortcutResolution,
  openAIDesktopBrand,
  prioritizeOpenAIDesktopCandidates,
  recoverOpenAIProjectsSequentially,
  runCommandCaptureWithTimeout,
  selectMacOpenAIDesktopApp,
  spawnDetachedWithConfirmation,
  summarizeOpenAIDesktopStopResults,
  validatedOpenAIDesktopTargetFromShortcutResolution,
  windowsShortcutResolverInvocation,
} = require("./openai-desktop-compat.cjs");
const { appendBoundedLog } = require("./runtime-log.cjs");
const { createResilientStateReader } = require("./resilient-state.cjs");
const { createRouterRestartBudget } = require("./router-restart-budget.cjs");
const { classifyRouterProcessOutput } = require("./router-start-diagnostics.cjs");
const { runRouterStartForIpc } = require("./router-start-result.cjs");
const { readBoundedRegularUtf8File } = require("./safe-import-file.cjs");
const { createChatgptBridgeService } = require("./chatgpt-bridge-service.cjs");
const {
  recoverConfigTransactionsAtStartup,
  summarizeConfigRecoveryError,
} = require("./config-recovery-startup.cjs");
const {
  hasCodexResourceAuthority,
  retainCodexResourceSnapshots,
} = require("./resource-snapshot-retention.cjs");

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
const runtimeLogPath = path.join(dataRootDir, "logs", "desktop-runtime.log");
const usageEventsPath = path.join(dataRootDir, "logs", "usage.local.json");
const historyRecoveryStatePath = path.join(dataRootDir, "state", "codex-history-recovery.json");
let settingsPromise;
let configRecoveryPromise;
let configRecoveryComplete = false;
let updaterPromise;
let mainWindow;
let routerProcess = null;
let chatgptBridgeService = null;
let routerLifecyclePromise = null;
let codexHistoryRecoveryFlowPromise = null;
let statePayloadReader = null;
let logLines = [];
let smokeErrors = [];
let usageStore = null;
let usageStorePromise = null;
let evaluateUsageBudgets = () => [];
let estimateUsageCosts = () => emptyUsageCostEstimate();
let usageBudgets = {};
let usageRoutes = [];
let lastHealth = null;
let tray = null;
let isQuitting = false;
let managedQuitReady = false;
let routerRestartTimer = null;
let launchedUpdateLoadHookRegistered = false;
let desktopSmokeLoadHookRegistered = false;
let localExecutorServer = null;
let localExecutorUrl = "";
let localExecutorToken = "";
let deferredStartupScheduled = false;
let legacyDataMigration = { copiedFiles: 0, skippedFiles: 0, sourceDirs: [], messages: [] };
let legacyDataMigrationPromise = null;
let lastCodexResourceSnapshots = null;
let legacyDataMigrationFinished = !app.isPackaged || Boolean(process.env.CODEXBRIDGE_DATA_DIR);
const startupStartedAt = Date.now();
const startupMarkers = new Set();
const ROUTER_RESTART_MAX_ATTEMPTS = 12;
const ROUTER_RESTART_BASE_DELAY_MS = 1500;
const ROUTER_RESTART_MAX_DELAY_MS = 30000;
const ROUTER_RESTART_STABLE_WINDOW_MS = 60000;
const ROUTER_SPAWN_TIMEOUT_MS = 5000;
const ROUTER_GRACEFUL_STOP_TIMEOUT_MS = 2000;
const ROUTER_FORCE_STOP_TIMEOUT_MS = 3000;
const MANAGED_QUIT_CLEANUP_TIMEOUT_MS = 5000;
const SHORTCUT_SCAN_MAX_CANDIDATES = 24;
const SHORTCUT_SCAN_MAX_OPERATIONS = 128;
const SHORTCUT_SCAN_MAX_DURATION_MS = 350;
const SHORTCUT_RESOLVE_MAX_DURATION_MS = 6000;
const SHORTCUT_RESOLVE_COMMAND_TIMEOUT_MS = 3000;
const SESSION_CENTER_LIMIT = 500;
const launchedAfterUpdate = process.argv.includes("--updated");
const executeDesktopLocalCapability = createDesktopLocalCapabilityExecutor({
  openExternal: (url) => shell.openExternal(url),
  fetchImpl: typeof fetch === "function" ? fetch.bind(globalThis) : null,
  capturePageScreenshot,
  captureDesktopScreenshot,
});
const routerRestartBudget = createRouterRestartBudget({
  maxAttempts: ROUTER_RESTART_MAX_ATTEMPTS,
  stableWindowMs: ROUTER_RESTART_STABLE_WINDOW_MS,
  isRunning: () => Boolean(routerProcess) && !isQuitting,
});

function desktopHomeDir() {
  const smokeHome = process.env.CODEXBRIDGE_DESKTOP_SMOKE === "1"
    ? String(process.env.CODEXBRIDGE_DESKTOP_SMOKE_HOME || "").trim()
    : "";
  return smokeHome && path.isAbsolute(smokeHome)
    ? path.resolve(smokeHome)
    : os.homedir();
}

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

async function capturePageScreenshot({ url = "", viewport = "desktop", fullPage = false } = {}) {
  const size = screenshotViewportSize(viewport);
  const captureWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  try {
    await loadHiddenPage(captureWindow, url);
    if (fullPage) {
      await resizeWindowForFullPage(captureWindow, size);
    }
    const image = await captureWindow.webContents.capturePage();
    return image.toPNG();
  } finally {
    if (!captureWindow.isDestroyed()) {
      captureWindow.destroy();
    }
  }
}

async function captureDesktopScreenshot({ displayId = "" } = {}) {
  const normalizedDisplayId = String(displayId || "").trim();
  const displays = typeof screen.getAllDisplays === "function" ? screen.getAllDisplays() : [];
  const targetDisplay = normalizedDisplayId
    ? displays.find((display) => String(display.id) === normalizedDisplayId)
    : (typeof screen.getPrimaryDisplay === "function" ? screen.getPrimaryDisplay() : displays[0]);
  const size = targetDisplay?.size || { width: 1440, height: 900 };
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: clampScreenshotSize(Number(size.width), 1440, 3840),
      height: clampScreenshotSize(Number(size.height), 900, 2160),
    },
  });
  const source = normalizedDisplayId
    ? sources.find((item) =>
        String(item.display_id || "") === normalizedDisplayId ||
        String(item.id || "").includes(normalizedDisplayId),
      )
    : sources[0];
  if (!source) {
    throw new Error("没有找到可截图的屏幕。");
  }
  const image = source.thumbnail;
  const png = image && typeof image.toPNG === "function" ? image.toPNG() : null;
  if (!png?.length) {
    throw new Error("屏幕截图为空。");
  }
  return png;
}

function screenshotViewportSize(viewport = "") {
  return String(viewport || "").toLowerCase() === "mobile"
    ? { width: 390, height: 844 }
    : { width: 1440, height: 900 };
}

function loadHiddenPage(win, url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("网页加载超时"));
    }, 30000);
    const cleanup = () => {
      clearTimeout(timer);
      win.webContents.removeListener("did-finish-load", onFinish);
      win.webContents.removeListener("did-fail-load", onFail);
    };
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const onFail = (_event, errorCode, errorDescription) => {
      cleanup();
      reject(new Error(errorDescription || `网页加载失败：${errorCode}`));
    };
    win.webContents.once("did-finish-load", onFinish);
    win.webContents.once("did-fail-load", onFail);
    win.loadURL(url).catch((error) => {
      cleanup();
      reject(error);
    });
  });
}

async function resizeWindowForFullPage(win, fallbackSize) {
  const dimensions = await win.webContents.executeJavaScript(
    `(() => {
      const body = document.body || {};
      const doc = document.documentElement || {};
      return {
        width: Math.max(doc.scrollWidth || 0, body.scrollWidth || 0, doc.clientWidth || 0),
        height: Math.max(doc.scrollHeight || 0, body.scrollHeight || 0, doc.clientHeight || 0)
      };
    })()`,
    true,
  ).catch(() => null);
  const width = clampScreenshotSize(Number(dimensions?.width || fallbackSize.width), fallbackSize.width, 2400);
  const height = clampScreenshotSize(Number(dimensions?.height || fallbackSize.height), fallbackSize.height, 12000);
  win.setContentSize(width, height);
}

function clampScreenshotSize(value, fallback, max) {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.round(value), max));
}

function stoppedRouterHealth() {
  return {
    ok: false,
    status: 0,
    models: [],
    message: "Router is stopped.",
    checkedAt: new Date().toISOString(),
  };
}

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

async function loadCodexHistoryRecoveryFlow() {
  if (!codexHistoryRecoveryFlowPromise) {
    codexHistoryRecoveryFlowPromise = Promise.all([
      loadSettings(),
      import("./codex-history-recovery-flow.mjs"),
    ]).then(([settings, { createCodexHistoryRecoveryFlow }]) => {
      const homeDir = desktopHomeDir();
      const historyRecoveryE2E = process.env.CODEXBRIDGE_DESKTOP_SMOKE_HISTORY_RECOVERY === "1";
      let historyRecoveryE2EProcessChecks = 0;
      return createCodexHistoryRecoveryFlow({
        preview: async () => settings.previewCodexThreadCatalogRecovery({ homeDir }),
        stopDesktop: historyRecoveryE2E
          ? async () => ({
              ok: false,
              code: "desktop_process_still_running",
              message: "未能完全退出 ChatGPT / Codex（PID 61772）；为防止状态被覆盖，未执行会话恢复。",
              launchTarget: "history-recovery-e2e",
            })
          : async () => stopOpenAIDesktopForSidebarRecovery(settings),
        listProcesses: historyRecoveryE2E
          ? async () => {
              historyRecoveryE2EProcessChecks += 1;
              return historyRecoveryE2EProcessChecks === 1
                ? [{ pid: 61772, name: "ChatGPT.exe", path: "C:/Program Files/ChatGPT/ChatGPT.exe" }]
                : [];
            }
          : async () => listRunningCodexDesktopProcesses(),
        probeCatalogWritable: async () => settings.probeCodexThreadCatalogWritable({ homeDir }),
        apply: async () => {
          const historyAccess = await settings.recoverCodexHistoryAccess({ homeDir });
          const migration = settings.applyCodexThreadCatalogRecovery({
            homeDir,
            codexStopped: true,
            onPhase: (phase, details) => appendHistoryRecoveryWorkerPhase(phase, details),
          });
          return { ...migration, historyAccess };
        },
        backupExists: async (backupDir) => Boolean(backupDir && fs.existsSync(backupDir)),
        restartDesktop: async ({ launchTarget = "" } = {}) => {
          if (historyRecoveryE2E) {
            return { ok: true, launchTarget: launchTarget || "history-recovery-e2e", simulated: true };
          }
          if (!launchTarget) {
            throw new Error("没有保存可验证的 ChatGPT / Codex 启动项，迁移已完成但无法自动重启。");
          }
          await launchCodexDesktopTarget(launchTarget);
          return { ok: true, launchTarget };
        },
        recoverProjects: async () => {
          if (historyRecoveryE2E) {
            return { ok: true, launchedRoots: [], missingRoots: [], simulated: true };
          }
          const plan = settings.codexProjectRecoveryPlan({
            homeDir,
            limit: SESSION_CENTER_LIMIT,
          });
          return recoverCodexProjectsFromPlan(plan);
        },
        loadState: () => readHistoryRecoveryState(),
        saveState: (state) => writeHistoryRecoveryState(state),
        recordPhase: (phase, details) => appendHistoryRecoveryWorkerPhase(phase, details),
      });
    });
  }
  return codexHistoryRecoveryFlowPromise;
}

async function loadRouterLifecycleController() {
  if (!routerLifecyclePromise) {
    routerLifecyclePromise = Promise.all([
      loadSettings(),
      import("./router-lifecycle.mjs"),
    ]).then(([settings, {
      createRouterLifecycleController,
      terminateChildProcess,
      waitForChildSpawn,
    }]) => createRouterLifecycleController({
      prepareStart: async (options = {}) => {
        cancelRouterRestartTimer({ resetAttempts: !options.watchdog });
        const config = settings.readRouterConfig(dataRootDir);
        const mode = settings.detectModeFromConfig(config);
        appendDiagnosticsLog(settings.routerConfigDiagnostics(dataRootDir, config));
        const committed = await commitConfigMutation(
          settings,
          "router:start",
          { mode },
          { publish: false },
        );
        const prepared = {
          config: committed.routerConfig,
          codex: {
            target: settings.codexConfigPath(desktopHomeDir()),
            unchanged: false,
            backup: null,
          },
        };
        appendLog(`Updated Codex config before Router ${options.watchdog ? "restart" : "start"}: ${prepared.codex.target}`);
        return prepared;
      },
      ensureLocalExecutor: () => ensureLocalExecutorServer(),
      isLocalExecutorRunning: () => Boolean(localExecutorServer && localExecutorUrl && localExecutorToken),
      stopLocalExecutor: () => stopLocalExecutorServer(),
      spawnRouter: ({ prepared, executor }) => {
        const nodePath = nodeExecutable();
        const child = spawn(nodePath, [scriptPath("src/server.js")], {
          cwd: appRootDir,
          env: runtimeEnv(settings, executor),
          windowsHide: true,
        });
        child.stdout?.on("data", (chunk) => appendLog(chunk.toString("utf8").trimEnd()));
        child.stderr?.on("data", (chunk) => {
          const text = chunk.toString("utf8");
          child.codexBridgeStartFailureCode ||= classifyRouterProcessOutput(text);
          appendLog(text.trimEnd());
        });
        appendLog(`Starting router with ${nodePath}; revision=${prepared.config?.revision || "unknown"}.`);
        return child;
      },
      waitForSpawn: (child) => waitForChildSpawn(child, {
        timeoutMs: ROUTER_SPAWN_TIMEOUT_MS,
      }),
      checkHealth: async (prepared) => {
        lastHealth = {
          ok: false,
          status: 0,
          models: [],
          message: "Router is starting; waiting for health check...",
          checkedAt: new Date().toISOString(),
          starting: true,
        };
        return refreshRouterHealth(prepared.config);
      },
      cleanupManagedConfig: async ({ reason }) => {
        const cleanup = await settings.removeManagedCodexConfigTransaction({
          homeDir: desktopHomeDir(),
        });
        appendLog(cleanup.removed
          ? `Removed only the CodexBridge managed config for Router lifecycle (${reason}).`
          : `CodexBridge managed config cleanup skipped (${reason}): ${cleanup.reason}.`);
        return cleanup;
      },
      terminateProcess: (child) => terminateChildProcess(child, {
        gracefulTimeoutMs: ROUTER_GRACEFUL_STOP_TIMEOUT_MS,
        forceTimeoutMs: ROUTER_FORCE_STOP_TIMEOUT_MS,
      }),
      publishReady: async ({ options }) => {
        routerRestartBudget.markReady({ manual: !options.watchdog });
        void broadcastState();
        refreshTrayMenu().catch((error) => appendRuntimeLog(formatError("refreshTrayMenu", error)));
      },
      publishStopped: async ({ cleanup, warning }) => {
        lastHealth = stoppedRouterHealth();
        if (warning?.code === "managed_config_cleanup_failed") {
          appendLog(
            `Router stop confirmed, but managed configuration cleanup failed; cause=${warning.causeCode || cleanup?.causeCode || "operation_failed"}.`,
          );
        } else {
          appendLog("Router stop confirmed after managed configuration cleanup.");
        }
        void broadcastState();
        refreshTrayMenu().catch((error) => appendRuntimeLog(formatError("refreshTrayMenu", error)));
      },
      onProcessAssigned: (child) => {
        routerProcess = child;
        refreshTrayMenu().catch((error) => appendRuntimeLog(formatError("refreshTrayMenu", error)));
      },
      onProcessCleared: (child) => {
        if (routerProcess === child) {
          routerProcess = null;
        }
        refreshTrayMenu().catch((error) => appendRuntimeLog(formatError("refreshTrayMenu", error)));
      },
      onProcessError: (error) => appendRuntimeLog(formatError("routerProcess", error)),
      onStartFailed: (error) => {
        lastHealth = {
          ok: false,
          status: 0,
          models: [],
          message: `Router start failed: ${error?.message || error}`,
          checkedAt: new Date().toISOString(),
        };
      },
      onUnexpectedExit: async ({ code, isCurrent }) => {
        routerRestartBudget.markExit();
        appendLog(`Router stopped unexpectedly with code ${code ?? "unknown"}.`);
        lastHealth = {
          ok: false,
          status: 0,
          models: [],
          message: `Router stopped with code ${code ?? "unknown"}.`,
          checkedAt: new Date().toISOString(),
        };
        await broadcastState();
        if (!isCurrent()) {
          return;
        }
        scheduleRouterRestart(code);
      },
      onQuitRequested: () => {
        isQuitting = true;
      },
      onQuitCleanupTimeout: ({ timeoutMs, reason }) => {
        appendLog(`Quit cleanup is still pending after ${timeoutMs} ms (${reason}); Router remains running until cleanup finishes.`);
      },
      onQuitCleanupLateSuccess: () => {
        appendRuntimeLog("managed quit cleanup completed after timeout; continuing confirmed Router stop and quit");
      },
      onQuitFailed: (error) => {
        isQuitting = false;
        appendRuntimeLog(formatError("managedQuit", error));
      },
      onQuitReady: () => {
        cancelRouterRestartTimer();
        managedQuitReady = true;
      },
      quitApp: () => app.quit(),
      onInternalError: (error, phase) => appendRuntimeLog(formatError(`routerLifecycle:${phase}`, error)),
      quitCleanupTimeoutMs: MANAGED_QUIT_CLEANUP_TIMEOUT_MS,
    }));
  }
  return routerLifecyclePromise;
}

function recoverPendingConfigTransactions() {
  if (!configRecoveryPromise) {
    configRecoveryPromise = loadSettings().then((settings) =>
      recoverConfigTransactionsAtStartup({
        recover: () => settings.recoverSharedConfigTransactions({
          rootDir: dataRootDir,
          homeDir: os.homedir(),
        }),
        onRetry: ({ attempt, delayMs, code }) => {
          appendRuntimeLog(
            `config-recovery retry attempt=${attempt} delayMs=${delayMs} code=${code}`,
          );
        },
      }),
    );
  }
  return configRecoveryPromise;
}

function loadUpdater() {
  if (!updaterPromise) {
    updaterPromise = import("./updater.mjs");
  }
  return updaterPromise;
}

function markStartupOnce(label) {
  const marker = String(label || "").trim();
  if (!marker || startupMarkers.has(marker)) {
    return;
  }
  startupMarkers.add(marker);
  appendRuntimeLog(`startup ${marker} +${Date.now() - startupStartedAt}ms`);
}

function scheduleDeferredStartupWork() {
  if (deferredStartupScheduled) {
    return;
  }
  deferredStartupScheduled = true;
  setTimeout(() => {
    markStartupOnce("deferred-scan-start");
    initUsageStore().catch((error) => appendRuntimeLog(formatError("usageStore", error)));
    repairManagedCodexCompatibilityOnStartup().catch((error) =>
      appendRuntimeLog(formatError("codexCompatibilityRepair", error)),
    );
    resumePendingCodexHistoryRecoveryOnStartup().catch((error) =>
      appendRuntimeLog(formatError("codexHistoryRecoveryWorker", error)),
    );
    runLegacyDataMigration().catch((error) => appendRuntimeLog(formatError("legacyMigration", error)));
  }, 600);
}

async function resumePendingCodexHistoryRecoveryOnStartup() {
  const flow = await loadCodexHistoryRecoveryFlow();
  let pending = flow.status();
  if (!["waiting_for_exit", "awaiting_manual_exit", "migrating"].includes(pending.phase)) {
    return { ok: true, skipped: true, reason: "no_pending_recovery" };
  }
  for (let attempt = 0; attempt < 300; attempt += 1) {
    appendHistoryRecoveryWorkerPhase("process_check", pending);
    const result = await flow.execute({ manualExit: true });
    appendHistoryRecoveryStatus(result);
    await broadcastState();
    if (result.phase !== "awaiting_manual_exit") {
      return result;
    }
    await delay(2000);
    pending = flow.status();
  }
  return flow.status();
}

async function repairManagedCodexCompatibilityOnStartup() {
  const settings = await loadSettings();
  const plan = settings.managedCodexConfigCompatibilityPlan({ homeDir: os.homedir() });
  if (!plan.needsRepair) {
    return { repaired: false, skipped: true, reason: plan.reason, target: plan.target };
  }
  const result = await commitConfigMutation(settings, "startup:repair", {}, { publish: false });
  if (result?.codexConfigUpdated) {
    appendRuntimeLog(
      `codex compatibility repaired provider=codexbridge revision=${result.configRevision}`,
    );
  }
  return { ...result, repaired: true, skipped: false, reason: "legacy_provider_migrated" };
}

async function runLegacyDataMigration() {
  if (legacyDataMigrationFinished) {
    return legacyDataMigration;
  }
  if (legacyDataMigrationPromise) {
    return legacyDataMigrationPromise;
  }
  legacyDataMigrationPromise = Promise.resolve()
    .then(async () => {
      markStartupOnce("legacy-migration-start");
      const settings = await loadSettings();
      const result = await settings.runSharedConfigExclusive(() =>
        runLegacyDataMigrationWorker({
          targetDir: dataRootDir,
          execPath: process.execPath,
        }),
      );
      legacyDataMigration = result;
      legacyDataMigrationFinished = true;
      for (const message of result.messages || []) {
        appendRuntimeLog(message);
      }
      markStartupOnce("legacy-migration-done");
      return result;
    })
    .then(async (result) => {
      if (Number(result?.copiedFiles || 0) > 0 && mainWindow && !mainWindow.isDestroyed()) {
        await broadcastState();
      }
      return result;
    })
    .finally(() => {
      legacyDataMigrationPromise = null;
    });
  return legacyDataMigrationPromise;
}

function runLegacyDataMigrationWorker({ targetDir, execPath } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "legacy-migration-worker.cjs"), {
      workerData: { targetDir, execPath },
    });
    let settled = false;
    worker.once("message", (message) => {
      settled = true;
      if (message?.ok) {
        resolve(message.result || { copiedFiles: 0, skippedFiles: 0, sourceDirs: [], messages: [] });
        return;
      }
      reject(new Error(message?.error || "Legacy data migration worker failed"));
    });
    worker.once("error", (error) => {
      settled = true;
      reject(error);
    });
    worker.once("exit", (code) => {
      if (!settled && code !== 0) {
        reject(new Error(`Legacy data migration worker exited with code ${code}`));
      }
    });
  });
}

function runCodexResourceSnapshotWorker(options = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "resource-snapshot-worker.cjs"), {
      workerData: { options },
    });
    let settled = false;
    worker.once("message", (message) => {
      settled = true;
      if (message?.ok) {
        resolve(message.result || {});
        return;
      }
      reject(new Error(message?.error || "Codex resource snapshot worker failed"));
    });
    worker.once("error", (error) => {
      settled = true;
      reject(error);
    });
    worker.once("exit", (code) => {
      if (!settled && code !== 0) {
        reject(new Error(`Codex resource snapshot worker exited with code ${code}`));
      }
    });
  });
}

async function readCodexResourceSnapshotsRetained(options = {}) {
  let fresh = await runCodexResourceSnapshotWorker(options);
  if (!lastCodexResourceSnapshots && !hasCodexResourceAuthority(fresh)) {
    await delay(350);
    fresh = await runCodexResourceSnapshotWorker(options);
  }
  const retained = retainCodexResourceSnapshots(fresh, lastCodexResourceSnapshots);
  if (hasCodexResourceAuthority(retained)) {
    lastCodexResourceSnapshots = retained;
  }
  return retained;
}

async function initUsageStore() {
  if (usageStore) {
    return usageStore;
  }
  if (usageStorePromise) {
    return usageStorePromise;
  }
  usageStorePromise = import("./usage.mjs")
    .then(({ createUsageStore, evaluateUsageBudgets: evaluateBudgets, estimateUsageCosts: estimateCosts }) => {
      usageStore = createUsageStore({ initialEvents: readUsageEvents() });
      evaluateUsageBudgets = typeof evaluateBudgets === "function" ? evaluateBudgets : evaluateUsageBudgets;
      estimateUsageCosts = typeof estimateCosts === "function" ? estimateCosts : estimateUsageCosts;
      if (mainWindow && !mainWindow.isDestroyed()) {
        broadcastState().catch((error) => appendRuntimeLog(formatError("usageBroadcast", error)));
      }
      return usageStore;
    })
    .catch((error) => {
      appendRuntimeLog(formatError("usageStore", error));
      return null;
    })
    .finally(() => {
      usageStorePromise = null;
    });
  return usageStorePromise;
}

function releaseAssetsForDesktopPreflight(settings, { logErrors = false } = {}) {
  const desktopOptions = settings.loadDesktopOptions(dataRootDir);
  const releaseDir = desktopOptions.acceptanceReleaseDir;
  if (!releaseDir) {
    return null;
  }
  try {
    const releaseAssets = settings.releaseAssetsFromDirectory(releaseDir);
    return releaseAssets.length ? releaseAssets : null;
  } catch (error) {
    if (logErrors) {
      appendLog(`Release artifact directory scan skipped: ${error?.message || error}`);
    }
    return null;
  }
}

async function loadRouterHealth() {
  return import("./router-health.mjs");
}

function createWindow() {
  if (!configRecoveryComplete) {
    return null;
  }
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
  mainWindow.webContents.once("did-finish-load", () => {
    markStartupOnce("window-ready");
    scheduleDeferredStartupWork();
  });

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
    }, 30000);
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
  try {
    await recoverPendingConfigTransactions();
    configRecoveryComplete = true;
  } catch (error) {
    appendRuntimeLog(formatError("configRecovery", error));
    dialog.showErrorBox(
      "CodexBridge 配置恢复未完成",
      summarizeConfigRecoveryError(error),
    );
    managedQuitReady = true;
    isQuitting = true;
    app.quit();
    return;
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
    }, 30000);
    mainWindow.webContents.once("did-finish-load", () => {
      clearTimeout(timeout);
      runDesktopSmokeChecks();
    });
  }
});

app.on("before-quit", (event) => {
  if (managedQuitReady) {
    isQuitting = true;
    return;
  }
  event.preventDefault();
  requestManagedAppQuit("before-quit").catch((error) => {
    reportManagedQuitFailure("before-quit", error);
  });
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
  try {
    tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: "打开 CodexBridge",
      click: () => showMainWindow(),
    },
    {
      label: routerProcess ? "停止 Router" : "启动 Router",
      click: () => {
        if (routerProcess) {
          stopRouterFromTray().catch((error) => {
            appendLog(`Router stop from tray failed before process shutdown: ${error?.message || error}`);
            dialog.showErrorBox("CodexBridge", "Router 配置清理失败，Router 已保持运行。请检查日志后重试。");
          });
        } else {
          startRouterProcess().catch((error) => {
            appendLog(`Router start from tray failed: ${error?.message || error}`);
          });
        }
      },
    },
    {
      label: "重启 ChatGPT / Codex",
      click: () => restartCodexDesktop().catch((error) => appendLog(`Restart ChatGPT / Codex failed: ${error?.message || error}`)),
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
        requestManagedAppQuit("tray").catch((error) => {
          reportManagedQuitFailure("tray", error);
        });
      },
    },
    ]));
  } catch {
    appendRuntimeLog("Tray menu publication failed; the committed operation remains successful.");
  }
}

async function stopRouterFromTray() {
  return stopRouterWithManagedConfigCleanup({ source: "tray" });
}

async function applyProfileFromTray(profileId) {
  try {
    const settings = await loadSettings();
    const committed = await commitConfigMutation(settings, "profiles:apply", {
      profileId: String(profileId || ""),
    });
    const profile = committed.result.profile;
    appendLog(`Applied config profile from tray: ${profile.name}.`);
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
  if (!configRecoveryComplete) {
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  }
  mainWindow.show();
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
}

async function commitConfigMutation(settings, operation, payload = {}, options = {}) {
  const { commitThenPublishConfigMutation } = await import("./config-mutation-handler.mjs");
  try {
    return await commitThenPublishConfigMutation({
      commit: () => settings.applyConfigMutationTransaction({
        rootDir: dataRootDir,
        homeDir: desktopHomeDir(),
        operation,
        payload,
        verifyCommitted: options.verifyCommitted,
      }),
      onCommitted: (result) => {
        appendRuntimeLog(
          `config-transaction operation=${operation} revision=${result.configRevision} mode=${result.mode}`,
        );
      },
      publish: options.publish === false ? undefined : () => broadcastState(),
      onPostCommitError: (error, phase) => {
        appendRuntimeLog(formatError(`configTransactionPostCommit:${phase}`, error));
      },
    });
  } catch (error) {
    const failurePhase = safeConfigDiagnostic(error?.failurePhase, "unknown");
    const causeCode = safeConfigDiagnostic(error?.causeCode || error?.code, "operation_failed");
    appendRuntimeLog(
      `config-transaction-failed operation=${operation} phase=${failurePhase} cause=${causeCode}`,
    );
    throw describeConfigMutationFailure(error, operation, failurePhase, causeCode);
  }
}

function safeConfigDiagnostic(value, fallback) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[a-z0-9_-]{1,80}$/.test(normalized) ? normalized : fallback;
}

function describeConfigMutationFailure(error, operation, failurePhase, causeCode) {
  const described = new Error(
    `配置保存失败（操作：${operation}；阶段：${failurePhase}；诊断码：${causeCode}）。请复制诊断信息后重试。`,
  );
  described.name = error?.name || "ConfigTransactionError";
  described.code = error?.code || "config_transaction_failed";
  described.failurePhase = failurePhase;
  described.causeCode = causeCode;
  return described;
}

ipcMain.handle("state:get", async (_event, options = {}) => {
  const settings = await loadSettings();
  if (!options?.lite) {
    markStartupOnce("deferred-scan-start");
  }
  const payload = getStatePayload(settings, options || {});
  if (options?.lite) {
    markStartupOnce("core-state-loaded");
  }
  return payload;
});

ipcMain.handle("mode:select", async (_event, mode) => {
  const settings = await loadSettings();
  const [{ runModeSelect }, { locateCodexInstall }] = await Promise.all([
    import("./mode-switch-handler.mjs"),
    import("./codex-locator.mjs"),
  ]);
  return runModeSelect({
    settings,
    rootDir: dataRootDir,
    homeDir: os.homedir(),
    mode,
    routerRunning: Boolean(routerProcess),
    refreshRouterHealth,
    locateCodexInstall: () => locateCodexRestartTarget(settings, locateCodexInstall),
    broadcastState,
    getStatePayload,
    appendLog,
  });
});

ipcMain.handle("secrets:save", async (_event, secrets) => {
  const settings = await loadSettings();
  const committed = await commitConfigMutation(settings, "secrets:save", { secrets });
  appendLog(`Saved API key settings: ${committed.result.savedKeys.join(", ") || "none"}.`);
  return committed.result.secretStatus;
});

ipcMain.handle("secrets:get", async (_event, keyEnv) => {
  const settings = await loadSettings();
  return settings.secretValue(dataRootDir, String(keyEnv || ""));
});

ipcMain.handle("options:save", async (_event, options) => {
  const settings = await loadSettings();
  const committed = await commitConfigMutation(settings, "options:save", { options: options || {} });
  const saved = committed.result.saved;
  usageBudgets = saved.usageBudgets || {};
  appendLog(
    saved.bypassSystemProxy
      ? "System proxy bypass enabled for Router process."
      : "System proxy bypass disabled for Router process.",
  );
  appendLog(`Router port configured: ${committed.routerConfig.port}. Restart Router for port changes to take effect.`);
  return getStatePayload(settings);
});

ipcMain.handle("startup:check", async () => {
  const settings = await loadSettings();
  const config = settings.readRouterConfig(dataRootDir);
  const desktopOptions = settings.loadDesktopOptions(dataRootDir);
  const { codexCliSnapshot, codexPromptInputSnapshot } =
    settings.readCodexResourceSnapshots({ desktopOptions });
  const check = settings.buildStartupCheck(dataRootDir, {
    appVersion: app.getVersion(),
    routerRunning: Boolean(routerProcess),
    lastHealth,
    config,
    codexCliSnapshot,
    codexPromptInputSnapshot,
    releaseAssets: releaseAssetsForDesktopPreflight(settings, { logErrors: true }),
  });
  appendLog(`Startup check: pass=${check.summary.pass} warn=${check.summary.warn} fail=${check.summary.fail}.`);
  return check;
});

ipcMain.handle("models:saveSelection", async (_event, selectedModelIds) => {
  const settings = await loadSettings();
  const committed = await commitConfigMutation(settings, "models:saveSelection", {
    selectedModelIds,
  }, { publish: false });
  const saved = committed.selectedModelIds;
  appendLog(`Saved model selection: ${saved.join(", ")}.`);
  return getStatePayload(settings, { lite: true });
});

ipcMain.handle("models:saveImageInput", async (_event, payload) => {
  const settings = await loadSettings();
  const presetId = String(payload?.presetId || "");
  const committed = await commitConfigMutation(settings, "models:saveImageInput", {
    presetId,
    imageInput: Boolean(payload?.imageInput),
  });
  const saved = committed.result.saved;
  appendLog(
    `Updated image upload support: ${saved.presetId} ${saved.imageInput ? "enabled" : "disabled"}.`,
  );
  return getStatePayload(settings);
});

ipcMain.handle("models:saveImageGeneration", async (_event, payload) => {
  const settings = await loadSettings();
  const presetId = String(payload?.presetId || "");
  const committed = await commitConfigMutation(settings, "models:saveImageGeneration", {
    presetId,
    imageGeneration: payload?.imageGeneration || {},
  });
  const saved = committed.result.saved;
  appendLog(
    `Updated image generation provider: ${saved.presetId} -> ${saved.imageGeneration.mode}.`,
  );
  return getStatePayload(settings);
});

ipcMain.handle("models:repairReferences", async () => {
  const settings = await loadSettings();
  const result = await commitConfigMutation(settings, "models:repairReferences");
  appendLog(`Repaired model references: ${result.selectedModelIds.length} selected route(s).`);
  return {
    result,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("imageProviders:save", async (_event, provider) => {
  const settings = await loadSettings();
  const committed = await commitConfigMutation(settings, "imageProviders:save", {
    provider: provider || {},
  });
  const saved = committed.result.saved;
  appendLog(`Saved image generation provider: ${saved.name}.`);
  return {
    saved,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("imageProviders:remove", async (_event, providerId) => {
  const settings = await loadSettings();
  const removedId = String(providerId || "").trim();
  const committed = await commitConfigMutation(settings, "imageProviders:remove", {
    providerId: removedId,
  });
  const config = committed.result.config;
  appendLog(`Removed image generation provider: ${removedId || "unknown"}.`);
  return {
    config,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("capabilityProviders:save", async (_event, provider) => {
  const settings = await loadSettings();
  const committed = await commitConfigMutation(settings, "capabilityProviders:save", {
    provider: provider || {},
  });
  const saved = committed.result.saved;
  appendLog(`Saved capability provider: ${saved?.name || saved?.id || "unknown"}.`);
  return {
    saved,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("capabilityProviders:remove", async (_event, providerId) => {
  const settings = await loadSettings();
  const removedId = String(providerId || "").trim();
  const committed = await commitConfigMutation(settings, "capabilityProviders:remove", {
    providerId: removedId,
  });
  const config = committed.result.config;
  appendLog(`Removed capability provider: ${removedId || "unknown"}.`);
  return {
    config,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("capabilityProviders:test", async (_event, payload) => {
  const settings = await loadSettings();
  const provider = payload?.provider || payload || {};
  const result = await settings.testCapabilityProviderConnection(dataRootDir, provider, {
    localCapabilityExecutor: executeDesktopLocalCapability,
  });
  const providerId = result.providerId || provider.providerId || provider.id || "";
  if (providerId) {
    await settings.runSharedConfigExclusive(() =>
      settings.saveCapabilityProviderTestResult(dataRootDir, providerId, result),
    );
  }
  appendLog(
    `Capability provider test ${result.ok ? "OK" : "failed"}: ${providerId || "unsaved"} ${result.durationMs || 0}ms ${result.message || ""}`.trim(),
  );
  broadcastState();
  return {
    ...result,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("capabilityProviders:execute", async (_event, payload) => {
  const settings = await loadSettings();
  const result = await settings.executeCapabilityProvider(dataRootDir, payload || {}, {
    localCapabilityExecutor: executeDesktopLocalCapability,
  });
  appendLog(
    `Capability provider execute ${result.ok ? "OK" : "failed"}: ${result.providerId || "unknown"} ${result.durationMs || 0}ms ${result.response?.output_text || result.error?.message || ""}`.trim(),
  );
  broadcastState();
  return {
    ...result,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("capabilityHistory:clear", async (_event, payload) => {
  const settings = await loadSettings();
  const result = settings.clearCapabilityExecutionHistory(dataRootDir, {
    olderThanDays: Number(payload?.olderThanDays || 0),
    keepLatest: Number(payload?.keepLatest || 0),
    deleteFiles: Boolean(payload?.deleteFiles),
  });
  appendLog(
    `Cleared capability execution history: records=${result.removedRecords} files=${result.removedFiles}.`,
  );
  broadcastState();
  return {
    ...result,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("imageProviders:test", async (_event, payload) => {
  const imageProviderTestStartedAt = Date.now();
  const settings = await loadSettings();
  const imageGeneration = await import("../src/image-generation.js");
  const upstream = await import("../src/upstream.js");
  let generationSettings = null;
  try {
    const provider = payload?.provider || payload || {};
    generationSettings = settings.imageGenerationSettingsForProvider(dataRootDir, provider);
    if (!generationSettings.apiKey && generationSettings.apiKeyEnv) {
      generationSettings = {
        ...generationSettings,
        apiKey: settings.secretValue(dataRootDir, generationSettings.apiKeyEnv),
      };
    }
    const prompt = String(payload?.prompt || "").trim() || "画一张 CodexBridge 多模型路由控制台的小图标";
    const result = await imageGeneration.generateImageWithSettings(generationSettings, prompt, {
      route: {
        id: "desktop-image-provider-test",
        displayName: "图片供应商测试",
      },
      requestedModel: "image-provider-test",
      sourceModel: "设置页测试",
      context: { requestId: `desktop_image_test_${Date.now()}` },
      captureErrors: true,
      callJsonUpstream: upstream.callJsonUpstream,
    });
    if (result.ok === false) {
      const checks = imageGeneration.imageGenerationHealthChecks({
        ok: false,
        settings: generationSettings,
        error: result.error,
      });
      await settings.runSharedConfigExclusive(() => settings.saveImageProviderTestResult(dataRootDir, generationSettings.providerId || generationSettings.id, {
        ok: false,
        message: result.error?.message || "测试生图失败。",
        durationMs: result.durationMs,
        checks,
        capabilityTrace: result.capabilityTrace || [],
      }));
      appendLog(`Image provider test failed: ${result.error?.message || "unknown error"}`);
      broadcastState();
      return {
        ok: false,
        error: result.error,
        response: result.response,
        durationMs: result.durationMs,
        checks,
        capabilityTrace: result.capabilityTrace || [],
        state: await getStatePayload(settings),
      };
    }
    appendLog(
      `Image provider test OK: ${generationSettings.displayName} ${result.durationMs}ms ${result.localImage?.localPath || ""}`.trim(),
    );
    const checks = imageGeneration.imageGenerationHealthChecks({
      ok: true,
      settings: generationSettings,
      upstream: result.upstream,
      localImage: result.localImage,
    });
    await settings.runSharedConfigExclusive(() => settings.saveImageProviderTestResult(dataRootDir, generationSettings.providerId || generationSettings.id, {
      ok: true,
      durationMs: result.durationMs,
      localPath: result.localImage?.localPath || "",
      checks,
      capabilityTrace: result.capabilityTrace || [],
    }));
    broadcastState();
    return {
      ok: true,
      message: `${generationSettings.displayName} 测试成功。`,
      durationMs: result.durationMs,
      localPath: result.localImage?.localPath || "",
      imageDataUrl: result.localImage?.base64
        ? `data:${result.localImage?.mimeType || "image/png"};base64,${result.localImage.base64}`
        : "",
      checks,
      capabilityTrace: result.capabilityTrace || [],
      historyItem: result.historyItem,
      state: await getStatePayload(settings),
    };
  } catch (error) {
    const friendly = imageGeneration.friendlyImageGenerationError(
      error,
      generationSettings || payload?.provider || payload || {},
    );
    appendLog(`Image provider test failed: ${friendly.message}`);
    const checks = imageGeneration.imageGenerationHealthChecks({
      ok: false,
      settings: generationSettings || payload?.provider || payload || {},
      error,
    });
    await settings.runSharedConfigExclusive(() => settings.saveImageProviderTestResult(
      dataRootDir,
      generationSettings?.providerId || generationSettings?.id || payload?.provider?.id || payload?.id,
      {
        ok: false,
        message: friendly.message,
        durationMs: Date.now() - imageProviderTestStartedAt,
        checks,
        capabilityTrace: [],
      },
    ));
    broadcastState();
    return {
      ok: false,
      error: friendly,
      durationMs: Date.now() - imageProviderTestStartedAt,
      checks,
      capabilityTrace: [],
      state: await getStatePayload(settings),
    };
  }
});

ipcMain.handle("imageHistory:clear", async (_event, payload) => {
  const settings = await loadSettings();
  const result = settings.clearImageGenerationHistory(dataRootDir, {
    olderThanDays: Number(payload?.olderThanDays || 0),
    keepLatest: Number(payload?.keepLatest || 0),
    deleteFiles: Boolean(payload?.deleteFiles),
  });
  appendLog(
    `Image generation history cleared: records=${result.removedRecords} files=${result.removedFiles}.`,
  );
  broadcastState();
  return {
    ...result,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("models:saveCapabilities", async (_event, payload) => {
  const settings = await loadSettings();
  const presetId = String(payload?.presetId || "");
  const committed = await commitConfigMutation(settings, "models:saveCapabilities", {
    presetId,
    capabilities: payload?.capabilities || {},
  });
  const saved = committed.result.saved;
  appendLog(`Updated model capabilities: ${presetId}.`);
  return {
    saved,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("models:resetCapabilities", async (_event, presetId) => {
  const settings = await loadSettings();
  const committed = await commitConfigMutation(settings, "models:resetCapabilities", {
    presetId: String(presetId || ""),
  });
  const reset = committed.result.reset;
  appendLog(`Reset model capabilities: ${reset.presetId}.`);
  return {
    reset,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("providers:refreshModels", async (_event, providerId) => {
  const settings = await loadSettings();
  const result = await settings.fetchProviderModelDirectoryCandidate(
    dataRootDir,
    String(providerId || ""),
  );
  let committed = null;
  if (result.ok) {
    committed = await commitConfigMutation(settings, "providers:refreshModels", {
      refreshResult: result,
    });
  }
  appendLog(
    result.ok
      ? `Refreshed model directory: ${result.providerId} (${result.count || 0} models).`
      : `Model directory refresh failed: ${result.providerId} ${result.error || "unknown error"}.`,
  );
  const { providerFingerprint: _providerFingerprint, ...publicResult } = result;
  return {
    result: publicResult,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("providers:save", async (_event, provider) => {
  const settings = await loadSettings();
  const providerId = String(provider?.providerId || provider?.id || "").trim();
  const committed = await commitConfigMutation(settings, "providers:save", {
    provider: { ...(provider || {}), id: providerId },
  });
  const saved = committed.result.saved;
  appendLog(`Saved provider settings: ${saved.name || providerId}.`);
  return {
    saved,
    sync: committed,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("providers:reset", async (_event, providerId) => {
  const settings = await loadSettings();
  const id = String(providerId || "").trim();
  const committed = await commitConfigMutation(settings, "providers:reset", { providerId: id });
  const providerName = committed.result.providerName;
  appendLog(`Reset provider settings: ${providerName}.`);
  return {
    result: committed.result,
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
  const logo = settings.buildProviderLogoCandidate(dataRootDir, ownerId, result.filePaths[0]);
  const committed = await commitConfigMutation(settings, "logos:select", {
    providerId,
    applyToProvider: Boolean(payload?.applyToProvider && providerId),
    logoTarget: logo.target,
    logoUrl: logo.logoUrl,
    logoBytes: logo.bytes,
  });
  const saved = committed.result.saved;
  if (payload?.applyToProvider && providerId) {
    appendLog(`Updated provider logo: ${providerId}.`);
    return {
      ...saved,
      state: await getStatePayload(settings),
    };
  }
  return saved;
});

async function saveCustomModelFromIpc(model) {
  const settings = await loadSettings();
  const committed = await commitConfigMutation(settings, "customModel:save", { model });
  const saved = committed.result.saved;
  appendLog(`Saved custom model: ${saved.displayName}.`);
  return saved;
}

ipcMain.handle("customModel:save", async (_event, model) => saveCustomModelFromIpc(model));
ipcMain.handle("customModels:save", async (_event, model) => saveCustomModelFromIpc(model));

ipcMain.handle("customModel:remove", async (_event, presetId) => {
  const settings = await loadSettings();
  await commitConfigMutation(settings, "customModel:remove", { presetId });
  appendLog(`Removed custom model: ${presetId}.`);
  return getStatePayload(settings);
});

ipcMain.handle("profiles:save", async (_event, profile) => {
  const settings = await loadSettings();
  const committed = await commitConfigMutation(settings, "profiles:save", { profile: {
    ...(profile || {}),
    id: profile?.id,
    name: profile?.name || `配置档 ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    note: profile?.note || "",
    createdAt: profile?.createdAt,
  } });
  const saved = committed.result.saved;
  appendLog(`Saved config profile: ${saved.name}.`);
  return {
    saved,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("profiles:apply", async (_event, profileId) => {
  const settings = await loadSettings();
  const committed = await commitConfigMutation(settings, "profiles:apply", {
    profileId: String(profileId || ""),
  });
  const profile = committed.result.profile;
  appendLog(`Applied config profile: ${profile.name}.`);
  refreshTrayMenu();
  return getStatePayload(settings);
});

ipcMain.handle("configPackage:export", async () => {
  const settings = await loadSettings();
  const pkg = await settings.runSharedConfigExclusive(() => {
    const resourceSnapshotOptions = { desktopOptions: settings.loadDesktopOptions(dataRootDir) };
    const { codexCliSnapshot, codexPromptInputSnapshot } =
      settings.readCodexResourceSnapshots(resourceSnapshotOptions);
    return settings.exportConfigPackage(dataRootDir, {
      codexCliSnapshot,
      includeCodexCliSnapshot: true,
      codexPromptInputSnapshot,
      includeCodexPromptInputSnapshot: true,
    });
  });
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "导出 CodexBridge 配置包",
    defaultPath: path.join(
      app.getPath("documents"),
      `CodexBridge-config-${fileTimestamp()}.json`,
    ),
    filters: [{ name: "CodexBridge 配置包", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }
  fs.writeFileSync(result.filePath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  appendLog(`Exported config package: ${result.filePath}`);
  return {
    canceled: false,
    filePath: result.filePath,
    includesSecrets: false,
    selectedModelCount: pkg.selection?.selectedModelIds?.length || 0,
    providerCount: Object.keys(pkg.providerOverrides || {}).length,
    capabilityProviderCount: pkg.capabilityProviders?.providers?.length || 0,
    imageProviderCount: pkg.imageProviders?.providers?.length || 0,
    codexResourceCount: settings.configPackageCodexResourceCount(pkg.codexResources),
    codexResourceReadStatus: pkg.codexResources?.readStatus || null,
    embeddedLogoCount: pkg.embeddedLogoCount || 0,
    requiredSecretKeyCount: pkg.requiredSecretKeys?.length || 0,
  };
});

ipcMain.handle("configPackage:exportToSyncDir", async () => {
  const settings = await loadSettings();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择 CodexBridge 配置包同步目录",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths?.[0]) {
    return { canceled: true };
  }
  const exported = await settings.runSharedConfigExclusive(() => {
    const resourceSnapshotOptions = { desktopOptions: settings.loadDesktopOptions(dataRootDir) };
    const { codexCliSnapshot, codexPromptInputSnapshot } =
      settings.readCodexResourceSnapshots(resourceSnapshotOptions);
    return settings.exportConfigPackageToDirectory(dataRootDir, result.filePaths[0], {
      codexCliSnapshot,
      includeCodexCliSnapshot: true,
      codexPromptInputSnapshot,
      includeCodexPromptInputSnapshot: true,
    });
  });
  appendLog(`Exported config package to sync directory: ${exported.filePath}`);
  await broadcastState();
  return exported;
});

ipcMain.handle("configPackage:importLatestFromSyncDir", async () => {
  const settings = await loadSettings();
  const packagePath = settings.latestConfigPackageSyncPackagePath(dataRootDir);
  if (!packagePath) {
    throw new Error("还没有可从同步目录导入的配置包。请先导出到同步目录，或手动导入配置包文件。");
  }
  const fileName = path.basename(packagePath);
  const fileContent = readBoundedRegularUtf8File(packagePath);
  const candidate = settings.parseConfigPackageImportCandidate(fileContent);
  const preview = settings.previewConfigPackageImport(dataRootDir, candidate);
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: "question",
    buttons: ["从同步目录导入", "取消"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: "确认从同步目录导入配置包",
    message: "将用上次同步目录里的配置包覆盖当前 CodexBridge 配置。",
    detail: [`配置包：${fileName}`, configPackageImportPreviewDetail(preview)].join("\n\n"),
  });
  if (confirmation.response !== 0) {
    appendLog(`Canceled config package sync import after preview: ${fileName}`);
    return { canceled: true, fileName, preview };
  }
  const committed = await commitConfigMutation(settings, "configPackage:import", {
    candidate,
  });
  const imported = committed.result;
  appendLog(`Imported config package from sync directory: ${fileName}`);
  refreshTrayMenu();
  return {
    canceled: false,
    ...imported,
    sourcePath: packagePath,
    sourceFileName: fileName,
    mode: committed.mode,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("configPackage:import", async () => {
  const settings = await loadSettings();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "导入 CodexBridge 配置包",
    properties: ["openFile"],
    filters: [{ name: "CodexBridge 配置包", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePaths?.[0]) {
    return { canceled: true };
  }
  const filePath = result.filePaths[0];
  const fileContent = readBoundedRegularUtf8File(filePath);
  const candidate = settings.parseConfigPackageImportCandidate(fileContent);
  const preview = settings.previewConfigPackageImport(dataRootDir, candidate);
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: "question",
    buttons: ["导入配置包", "取消"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: "确认导入配置包",
    message: "导入会覆盖当前 CodexBridge 模型、供应商、能力和配置档设置。",
    detail: configPackageImportPreviewDetail(preview),
  });
  if (confirmation.response !== 0) {
    appendLog(`Canceled config package import after preview: ${filePath}`);
    return { canceled: true, preview };
  }
  const committed = await commitConfigMutation(settings, "configPackage:import", {
    candidate,
  });
  const imported = committed.result;
  appendLog(`Imported config package: ${filePath}`);
  refreshTrayMenu();
  return {
    canceled: false,
    filePath,
    ...imported,
    mode: committed.mode,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("configPackage:restoreLatestImportBackup", async () => {
  const settings = await loadSettings();
  const backupPath = settings.latestConfigPackageImportBackupPath(dataRootDir);
  if (!backupPath) {
    throw new Error("还没有可恢复的导入前备份。");
  }
  const backupFileName = path.basename(backupPath);
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: "question",
    buttons: ["恢复最近备份", "取消"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: "确认恢复导入前备份",
    message: "将用最近的导入前备份覆盖当前 CodexBridge 配置。",
    detail: [
      `备份文件：${backupFileName}`,
      "恢复前会再次备份当前配置，API Key 不会写入备份包。",
      "恢复后请检查模型、供应商、能力代理和预算设置是否符合预期。",
    ].join("\n"),
  });
  if (confirmation.response !== 0) {
    appendLog(`Canceled config package import backup restore: ${backupFileName}`);
    return { canceled: true, backupFileName };
  }
  const backupContent = readBoundedRegularUtf8File(backupPath);
  const candidate = settings.parseConfigPackageImportCandidate(backupContent);
  const committed = await commitConfigMutation(
    settings,
    "configPackage:restoreLatestImportBackup",
    { candidate },
  );
  const restored = {
    ...committed.result,
    restoredBackupFileName: backupFileName,
    mode: committed.mode,
  };
  appendLog(`Restored config package import backup: ${restored.restoredBackupFileName}`);
  refreshTrayMenu();
  return {
    canceled: false,
    ...restored,
    state: await getStatePayload(settings),
  };
});

function configPackageImportPreviewResourceCount(preview = {}) {
  const readStatus = preview?.codexResourceReadStatus ||
    preview?.codexResources?.readStatus ||
    preview?.readStatus ||
    null;
  if (
    readStatus &&
    ["plugins", "mcpServers", "skills", "marketplaces"]
      .some((key) => readStatus[key]?.ok === false || (
        readStatus[key]?.state && String(readStatus[key].state).toLowerCase() !== "ok"
      ))
  ) {
    return "无法读取";
  }
  const value = preview?.codexResourceCount;
  if (value === null || value === undefined || value === "") {
    return "未知";
  }
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? `${Math.round(count)} 项` : "未知";
}

function configPackageImportPreviewDetail(preview = {}) {
  const counts = [
    `模型选择 ${preview.selectedModelCount || 0} 个`,
    `自定义模型 ${preview.customModelCount || 0} 个`,
    `供应商设置 ${preview.providerOverrideCount || 0} 个`,
    `图片供应商 ${preview.imageProviderCount || 0} 个`,
    `能力供应商 ${preview.capabilityProviderCount || 0} 个`,
    `配置档 ${preview.profileCount || 0} 个`,
    `用量预算 ${preview.usageBudgetCount || 0} 组`,
    `Codex 资源清单 ${configPackageImportPreviewResourceCount(preview)}`,
  ].join("；");
  const imported = Array.isArray(preview.imported) && preview.imported.length
    ? preview.imported.join("、")
    : "没有可导入项";
  const keyText = Array.isArray(preview.missingSecretKeys) && preview.missingSecretKeys.length
    ? `导入后需要在本机重填 Key：${preview.missingSecretKeys.join("、")}。`
    : "配置包不导入 API Key；本机已有需要的 Key 或这份包不需要 Key。";
  const resourceText = preview.resourceManifestIncluded
    ? "Codex 资源清单只作为迁移参考导入，不会自动启用 MCP、插件、Skills、提示词或 AGENTS。"
    : "未包含 Codex 资源迁移清单。";
  return [
    `将导入：${imported}。`,
    counts,
    keyText,
    resourceText,
    "确认后会先把当前本机配置备份成不含 API Key 的配置包，再导入新配置。",
  ].join("\n");
}

ipcMain.handle("resource:setEnabled", async (_event, payload) => {
  const settings = await loadSettings();
  const result = await settings.setCodexResourceEnabledTransaction(payload || {});
  appendLog(
    `Set Codex resource ${result.kind}:${result.id} enabled=${result.enabled}${result.backup ? ` backup=${result.backup}` : ""}.`,
  );
  await broadcastState();
  return {
    ...result,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("resource:update", async (_event, payload) => {
  const settings = await loadSettings();
  const kind = String(payload?.kind || "plugin").trim();
  if (kind !== "plugin") {
    throw new Error("当前只支持更新 Codex 插件资源。");
  }
  const result = await settings.runSharedConfigExclusive(() =>
    settings.updateCodexPluginResource(payload || {}),
  );
  appendLog(`Updated Codex plugin resource ${result.id} from marketplace ${result.marketplace}.`);
  await broadcastState();
  return {
    ...result,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("resource:remove", async (_event, payload) => {
  const settings = await loadSettings();
  const kind = String(payload?.kind || "plugin").trim();
  if (kind !== "plugin") {
    throw new Error("当前只支持卸载 Codex 插件资源。");
  }
  const result = await settings.runSharedConfigExclusive(() =>
    settings.removeCodexPluginResource(payload || {}),
  );
  appendLog(`Removed Codex plugin resource ${result.id} from marketplace ${result.marketplace}.`);
  await broadcastState();
  return {
    ...result,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("resource:refreshMarketplaces", async () => {
  const settings = await loadSettings();
  const result = await settings.runSharedConfigExclusive(() =>
    settings.refreshCodexPluginMarketplaces(),
  );
  appendLog(`Refreshed Codex plugin marketplaces: ${result.marketplace}.`);
  await broadcastState();
  return {
    ...result,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("backups:restore", async (_event, backupPath) => {
  const settings = await loadSettings();
  const result = await settings.restoreCodexConfigFromBackup(
    String(backupPath || ""),
    { homeDir: os.homedir() },
  );
  appendLog(`Restored Codex config from selected backup: ${result.backup}`);
  if (result.currentBackup) {
    appendLog(`Current config backed up before selected restore: ${result.currentBackup}`);
  }
  await broadcastState();
  return {
    result,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("sessions:export", async (_event, sessionId) => {
  const settings = await loadSettings();
  const exported = settings.exportCodexSessionMarkdown(String(sessionId || ""));
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "导出 Codex 会话 Markdown",
    defaultPath: path.join(
      app.getPath("documents"),
      `${safeMarkdownFileName(exported.session?.title || exported.session?.id || "Codex-session")}-${fileTimestamp()}.md`,
    ),
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (result.canceled || !result.filePath) {
    return { ok: false, canceled: true };
  }
  fs.writeFileSync(result.filePath, exported.markdown, "utf8");
  clipboard.writeText(exported.markdown);
  appendLog(`Exported Codex session markdown: ${exported.session?.id || sessionId} -> ${result.filePath}.`);
  return {
    ok: true,
    canceled: false,
    filePath: result.filePath,
    session: exported.session,
    databasePath: exported.databasePath,
    markdownLength: exported.markdown.length,
  };
});

ipcMain.handle("sessions:exportProject", async (_event, projectKey) => {
  const settings = await loadSettings();
  const exported = settings.exportCodexProjectMarkdown(String(projectKey || ""));
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "导出 Codex 项目 Markdown",
    defaultPath: path.join(
      app.getPath("documents"),
      `${safeMarkdownFileName(exported.project?.name || "Codex-project")}-${fileTimestamp()}.md`,
    ),
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (result.canceled || !result.filePath) {
    return { ok: false, canceled: true };
  }
  fs.writeFileSync(result.filePath, exported.markdown, "utf8");
  clipboard.writeText(exported.markdown);
  appendLog(`Exported Codex project markdown: ${exported.project?.key || projectKey} -> ${result.filePath}.`);
  return {
    ok: true,
    canceled: false,
    filePath: result.filePath,
    project: exported.project,
    markdownLength: exported.markdown.length,
  };
});

ipcMain.handle("sessions:exportLoose", async () => {
  const settings = await loadSettings();
  const exported = settings.exportCodexLooseSessionsMarkdown();
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "导出 Codex 无项目会话 Markdown",
    defaultPath: path.join(
      app.getPath("documents"),
      `Codex-no-project-sessions-${fileTimestamp()}.md`,
    ),
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (result.canceled || !result.filePath) {
    return { ok: false, canceled: true };
  }
  fs.writeFileSync(result.filePath, exported.markdown, "utf8");
  clipboard.writeText(exported.markdown);
  appendLog(`Exported Codex no-project sessions markdown: ${exported.group?.sessions?.length || 0} sessions -> ${result.filePath}.`);
  return {
    ok: true,
    canceled: false,
    filePath: result.filePath,
    group: exported.group,
    markdownLength: exported.markdown.length,
  };
});

ipcMain.handle("sessions:exportAll", async () => {
  const settings = await loadSettings();
  const exported = settings.exportCodexSessionTreeMarkdown();
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "导出全部 Codex 会话与项目 Markdown",
    defaultPath: path.join(
      app.getPath("documents"),
      `Codex-sessions-and-projects-${fileTimestamp()}.md`,
    ),
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (result.canceled || !result.filePath) {
    return { ok: false, canceled: true };
  }
  fs.writeFileSync(result.filePath, exported.markdown, "utf8");
  clipboard.writeText(exported.markdown);
  appendLog(`Exported all Codex sessions markdown: ${exported.tree?.summary?.sessions || 0} sessions -> ${result.filePath}.`);
  return {
    ok: true,
    canceled: false,
    filePath: result.filePath,
    tree: exported.tree,
    markdownLength: exported.markdown.length,
  };
});

ipcMain.handle("sessions:exportFiltered", async (_event, payload = {}) => {
  const settings = await loadSettings();
  const exported = settings.exportCodexFilteredSessionsMarkdown({
    sessionIds: Array.isArray(payload?.sessionIds) ? payload.sessionIds : [],
    filterText: String(payload?.filterText || ""),
  });
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "导出当前筛选 Codex 会话 Markdown",
    defaultPath: path.join(
      app.getPath("documents"),
      `Codex-filtered-sessions-${fileTimestamp()}.md`,
    ),
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (result.canceled || !result.filePath) {
    return { ok: false, canceled: true };
  }
  fs.writeFileSync(result.filePath, exported.markdown, "utf8");
  clipboard.writeText(exported.markdown);
  appendLog(`Exported filtered Codex sessions markdown: ${exported.tree?.summary?.sessions || 0} sessions -> ${result.filePath}.`);
  return {
    ok: true,
    canceled: false,
    filePath: result.filePath,
    tree: exported.tree,
    filterText: exported.filterText,
    markdownLength: exported.markdown.length,
  };
});

ipcMain.handle("catalog:generate", async () => {
  const settings = await loadSettings();
  const committed = await commitConfigMutation(settings, "catalog:generate");
  appendLog("Generated model-catalog.json in the shared configuration transaction.");
  return { ok: true, output: settings.catalogPath(dataRootDir), revision: committed.configRevision };
});

ipcMain.handle("codex:apply", async () => {
  const settings = await loadSettings();
  const committed = await commitConfigMutation(settings, "codex:apply");
  const result = {
    target: settings.codexConfigPath(os.homedir()),
    modelCatalog: settings.codexCatalogPath(os.homedir()),
    unchanged: false,
    backup: null,
    revision: committed.configRevision,
  };
  appendLog(`Applied Codex config transaction: ${result.target}`);
  return result;
});

ipcMain.handle("codex:initialize", async () => {
  const settings = await loadSettings();
  const committed = await commitConfigMutation(settings, "codex:initialize");
  const catalogResult = {
    ok: true,
    output: settings.catalogPath(dataRootDir),
    revision: committed.configRevision,
  };
  const codexResult = {
    target: settings.codexConfigPath(os.homedir()),
    modelCatalog: settings.codexCatalogPath(os.homedir()),
    backup: null,
    revision: committed.configRevision,
  };
  appendLog(`Initialized Codex config transaction: ${codexResult.target}`);
  return {
    ok: true,
    catalog: catalogResult,
    codex: codexResult,
  };
});

ipcMain.handle("codex:restore", async () => {
  const settings = await loadSettings();
  const result = await settings.restoreCodexConfig({ homeDir: os.homedir() });
  appendLog(`Restored Codex config from backup: ${result.backup}`);
  if (result.currentBackup) {
    appendLog(`Current config backed up before restore: ${result.currentBackup}`);
  }
  await broadcastState();
  return result;
});

ipcMain.handle("codex:restart", async () => {
  const result = await restartCodexDesktop();
  appendLog(result.message);
  broadcastState();
  return result;
});

ipcMain.handle("codex:select-exe", async () => {
  const selectingMacApp = process.platform === "darwin";
  const result = await dialog.showOpenDialog(mainWindow, {
    title: selectingMacApp
      ? "Choose ChatGPT.app or Codex.app"
      : "Choose ChatGPT.exe, Codex.exe, or a compatible shortcut",
    properties: ["openFile"],
    filters: [
      {
        name: "ChatGPT / Codex Desktop",
        extensions: selectingMacApp ? ["app"] : ["exe", "lnk"],
      },
    ],
  });
  if (result.canceled || !result.filePaths?.[0]) {
    return { canceled: true };
  }
  const selectedPath = result.filePaths[0];
  if (!isOpenAIDesktopLaunchTarget(selectedPath)) {
    throw new Error("Please choose ChatGPT.exe, Codex.exe, or a compatible ChatGPT / Codex shortcut (not ChatGPT Classic or CodexBridge).");
  }
  if (!fs.existsSync(selectedPath)) {
    throw new Error(`ChatGPT / Codex Desktop launch target does not exist: ${selectedPath}`);
  }
  if (/\.lnk$/i.test(selectedPath)) {
    const resolution = await resolveWindowsShortcutTarget(selectedPath);
    if (!(await verifiedOpenAIDesktopShortcutLaunchTarget(resolution))) {
      throw new Error("The selected shortcut does not resolve to ChatGPT / Codex Desktop or a compatible Store app entry.");
    }
  }
  const settings = await loadSettings();
  const savePayload = /\.exe$/i.test(selectedPath)
    ? { codexDesktopExe: selectedPath, codexDesktopLaunchTarget: selectedPath }
    : { codexDesktopLaunchTarget: selectedPath };
  const committed = await commitConfigMutation(settings, "options:save", { options: savePayload });
  const saved = committed.result.saved;
  appendLog(`Saved ChatGPT / Codex Desktop launch target: ${saved.codexDesktopLaunchTarget || saved.codexDesktopExe}`);
  return {
    ok: true,
    path: saved.codexDesktopLaunchTarget || saved.codexDesktopExe,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("codex:history-recovery-preview", async () => {
  const flow = await loadCodexHistoryRecoveryFlow();
  const status = await flow.prepare();
  appendHistoryRecoveryStatus(status);
  return status;
});

ipcMain.handle("codex:recover-history", async (_event, options = {}) => {
  const flow = await loadCodexHistoryRecoveryFlow();
  const status = await flow.execute({ manualExit: options?.manualExit === true });
  appendHistoryRecoveryStatus(status);
  await broadcastState();
  return status;
});

ipcMain.handle("codex:history-recovery-status", async () => {
  const flow = await loadCodexHistoryRecoveryFlow();
  return flow.status();
});

ipcMain.handle("codex:recover-projects", async () => {
  const settings = await loadSettings();
  const plan = settings.codexProjectRecoveryPlan({ limit: SESSION_CENTER_LIMIT });
  const result = await recoverCodexProjectsFromPlan(plan);
  appendLog(result.message);
  for (const root of result.launchedRoots || []) {
    appendLog(`Requested Codex project restore: ${root.path}`);
  }
  for (const root of result.missingRoots || []) {
    appendLog(`Skipped missing Codex project root: ${root.path}`);
  }
  broadcastState();
  return result;
});

ipcMain.handle("router:start", () => {
  return runRouterStartForIpc(
    () => startRouterProcess(),
    ({ failurePhase, causeCode }) => {
      appendRuntimeLog(
        `router:start failed phase=${failurePhase} cause=${causeCode}`,
      );
      appendLog(`Router start failed phase=${failurePhase} cause=${causeCode}`);
    },
  );
});

async function startRouterProcess(options = {}) {
  return (await loadRouterLifecycleController()).start(options);
}
ipcMain.handle("router:stop", async () => {
  return stopRouterWithManagedConfigCleanup({ source: "ipc" });
});

function getChatgptBridgeService() {
  if (!chatgptBridgeService) {
    chatgptBridgeService = createChatgptBridgeService({
      appRootDir,
      dataRootDir,
      execPath: process.execPath,
      homeDir: desktopHomeDir(),
      log: (message) => appendLog(message),
    });
  }
  return chatgptBridgeService;
}

ipcMain.handle("doubleQuota:getState", async () => {
  return getChatgptBridgeService().getState();
});

ipcMain.handle("doubleQuota:savePort", async (_event, port) => {
  const result = await getChatgptBridgeService().savePort(port);
  appendLog(`双倍额度端口已保存：${result.port}`);
  return result;
});

ipcMain.handle("doubleQuota:start", async () => {
  const result = await getChatgptBridgeService().start();
  appendLog(result.ownedProcess
    ? `双倍额度服务已启动：${result.url}`
    : `已连接外部双倍额度服务：${result.url}`);
  return result;
});

ipcMain.handle("doubleQuota:stop", async () => {
  const result = await getChatgptBridgeService().stop();
  appendLog(result.externalProcess
    ? "双倍额度服务由外部程序管理，未执行关闭。"
    : "双倍额度服务已停止。");
  return result;
});

ipcMain.handle("doubleQuota:open", async () => {
  const state = await getChatgptBridgeService().getState();
  if (!state.running) {
    throw new Error("请先启动双倍额度服务。");
  }
  await shell.openExternal(state.url);
  return state;
});

ipcMain.handle("doubleQuota:prepareExtension", async () => {
  const result = await getChatgptBridgeService().prepareExtension();
  appendLog(`双倍额度扩展已准备：${result.extensionDir}`);
  return result;
});

ipcMain.handle("doubleQuota:manageExtension", async () => {
  const result = await getChatgptBridgeService().manageExtension();
  appendLog(result.extensionUpdate?.status === "failed"
    ? `双倍额度扩展更新失败：${result.extensionUpdate.error || "unknown"}`
    : result.extensionUpdate?.completed
      ? `双倍额度扩展已更新并连接：${result.extensionDir}`
      : `双倍额度扩展文件已更新，等待 Chrome 手动重新加载：${result.extensionDir}`);
  return result;
});

ipcMain.handle("doubleQuota:openExtensionManager", async () => {
  clipboard.writeText("chrome://extensions/");
  const chromePath = await findChromeExecutablePath();
  if (!chromePath) {
    throw new Error("未找到 Chrome 安装位置。请在 Chrome 地址栏手动输入 chrome://extensions/。");
  }
  await spawnDetachedWithConfirmation(chromePath, ["--new-window", "chrome://extensions/"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  return getChatgptBridgeService().getState();
});

async function findChromeExecutablePath() {
  const commonPath = firstExistingPath([
    path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  ]);
  if (commonPath) {
    return commonPath;
  }
  for (const key of [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
  ]) {
    const result = await runCommandCapture("reg.exe", ["query", key, "/ve"]);
    if (!result.ok) {
      continue;
    }
    const candidate = registryDefaultStringValue(result.stdout);
    if (candidate && safeExists(candidate) && path.basename(candidate).toLowerCase() === "chrome.exe") {
      return path.resolve(candidate);
    }
  }
  return "";
}

function registryDefaultStringValue(output) {
  return String(output || "").match(/^\s*(?:.+?\s+)?REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/im)?.[1]?.trim() || "";
}

ipcMain.handle("doubleQuota:repairMcp", async () => {
  const result = await getChatgptBridgeService().installOrRepairMcp();
  appendLog(`双倍额度 MCP 已安装或修复：${result.codexConfigPath}`);
  return result;
});

async function stopRouterWithManagedConfigCleanup({ source = "unknown" } = {}) {
  cancelRouterRestartTimer();
  return (await loadRouterLifecycleController()).stop({ source });
}

ipcMain.handle("diagnostics:copy", async () => {
  const settings = await loadSettings();
  const config = settings.readRouterConfig(dataRootDir);
  const resourceSnapshotOptions = { desktopOptions: settings.loadDesktopOptions(dataRootDir) };
  const { codexCliSnapshot, codexPromptInputSnapshot } =
    settings.readCodexResourceSnapshots(resourceSnapshotOptions);
  const diagnostics = settings.supportDiagnostics(dataRootDir, {
    appVersion: app.getVersion(),
    routerRunning: Boolean(routerProcess),
    lastHealth,
    usageSummary: usageStore?.summary({ routes: config?.models || [] }) || emptyUsageSummary(),
    updateDir: portableUpdatesDir(),
    proxyEnv: process.env,
    config,
    logs: logLines,
    codexCliSnapshot,
    codexPromptInputSnapshot,
  });
  clipboard.writeText(diagnostics.text);
  appendLog("Copied sanitized diagnostics to clipboard.");
  broadcastState();
  return diagnostics.summary;
});

ipcMain.handle("diagnostics:save", async () => {
  const settings = await loadSettings();
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "保存 CodexBridge 体检报告",
    defaultPath: path.join(
      app.getPath("documents"),
      `CodexBridge-diagnostics-${fileTimestamp()}.txt`,
    ),
    filters: [{ name: "CodexBridge 体检报告", extensions: ["txt"] }],
  });
  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }
  const config = settings.readRouterConfig(dataRootDir);
  const resourceSnapshotOptions = { desktopOptions: settings.loadDesktopOptions(dataRootDir) };
  const { codexCliSnapshot, codexPromptInputSnapshot } =
    settings.readCodexResourceSnapshots(resourceSnapshotOptions);
  const diagnostics = settings.supportDiagnostics(dataRootDir, {
    appVersion: app.getVersion(),
    routerRunning: Boolean(routerProcess),
    lastHealth,
    usageSummary: usageStore?.summary({ routes: config?.models || [] }) || emptyUsageSummary(),
    updateDir: portableUpdatesDir(),
    proxyEnv: process.env,
    config,
    logs: logLines,
    codexCliSnapshot,
    codexPromptInputSnapshot,
  });
  fs.writeFileSync(result.filePath, diagnostics.text, "utf8");
  appendLog(`Saved sanitized diagnostics report: ${result.filePath}`);
  broadcastState();
  return {
    ...diagnostics.summary,
    canceled: false,
    filePath: result.filePath,
  };
});

ipcMain.handle("releaseGate:save", async () => {
  const settings = await loadSettings();
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "保存 CodexBridge 发布门禁报告",
    defaultPath: path.join(
      app.getPath("documents"),
      `CodexBridge-release-gate-${fileTimestamp()}.json`,
    ),
    filters: [{ name: "CodexBridge 发布门禁报告", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }
  const config = settings.readRouterConfig(dataRootDir);
  const resourceSnapshotOptions = { desktopOptions: settings.loadDesktopOptions(dataRootDir) };
  const { codexCliSnapshot, codexPromptInputSnapshot } =
    settings.readCodexResourceSnapshots(resourceSnapshotOptions);
  const releaseAssets = releaseAssetsForDesktopPreflight(settings, { logErrors: true });
  const reportResult = settings.saveReleaseGateReport(dataRootDir, result.filePath, {
    appVersion: app.getVersion(),
    routerRunning: Boolean(routerProcess),
    lastHealth,
    config,
    releaseAssets,
    codexCliSnapshot,
    codexPromptInputSnapshot,
    strictWarnings: true,
    platform: process.platform,
    arch: process.arch,
  });
  appendLog(`Saved release gate report: ${result.filePath}`);
  broadcastState();
  return {
    ...reportResult,
    canceled: false,
    filePath: result.filePath,
  };
});

ipcMain.handle("acceptance:select-release-dir", async () => {
  const settings = await loadSettings();
  const desktopOptions = settings.loadDesktopOptions(dataRootDir);
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择 CodexBridge 发布目录",
    defaultPath: desktopOptions.acceptanceReleaseDir || app.getPath("documents"),
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths?.[0]) {
    return { canceled: true };
  }
  const releaseDir = result.filePaths[0];
  const committed = await commitConfigMutation(settings, "options:save", {
    options: { acceptanceReleaseDir: releaseDir },
  });
  const saved = committed.result.saved;
  appendLog(`Saved release artifact directory for acceptance reports: ${releaseDir}`);
  return {
    ok: true,
    path: saved.acceptanceReleaseDir,
    state: await getStatePayload(settings),
  };
});

ipcMain.handle("acceptance:save", async () => {
  const settings = await loadSettings();
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "保存 CodexBridge 检查报告",
    defaultPath: path.join(
      app.getPath("documents"),
      `CodexBridge-acceptance-${fileTimestamp()}.json`,
    ),
    filters: [{ name: "CodexBridge 检查报告", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }
  const releaseAssets = releaseAssetsForDesktopPreflight(settings, { logErrors: true });
  const reportResult = settings.saveRealAcceptanceReport(dataRootDir, result.filePath, {
    routerRunning: Boolean(routerProcess),
    lastHealth,
    releaseAssets,
    platform: process.platform,
    arch: process.arch,
  });
  appendLog(`Saved real acceptance report: ${result.filePath}`);
  broadcastState();
  return {
    ...reportResult,
    canceled: false,
    filePath: result.filePath,
  };
});

ipcMain.handle("clipboard:write", async (_event, text) => {
  const value = String(text || "");
  clipboard.writeText(value);
  return { ok: true, length: value.length };
});

ipcMain.handle("updates:check", async () => {
  const updater = await loadUpdater();
  const release = await updater.fetchLatestRelease();
  const plan = updater.planReleaseUpdate({
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    installKind: await currentInstallKind(),
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
    installKind: await currentInstallKind(),
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
  appendLog(`已写入免安装更新兜底说明：${prepared.manualNotePath}`);
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
  const folder = ensureFolderForOpen(resolveFolderTarget(target, settings));
  const openError = await shell.openPath(folder);
  if (openError) {
    throw new Error(`Unable to open folder: ${folder}. ${openError}`);
  }
  return { ok: true, folder };
});

ipcMain.handle("file:reveal", async (_event, target) => {
  const value = String(target || "").trim();
  if (!value) {
    throw new Error("Unable to locate file: empty path.");
  }
  const filePath = path.resolve(value);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Unable to locate file: ${target || ""}`);
  }
  shell.showItemInFolder(filePath);
  return { ok: true, filePath };
});

function resolveFolderTarget(target, settings) {
  const value = String(target || "").trim();
  if (value === "codex") {
    return path.dirname(settings.codexConfigPath());
  }
  if (value === "config") {
    return path.join(dataRootDir, "config");
  }
  if (value === "updates") {
    return portableUpdatesDir();
  }
  if (value === "config-sync") {
    const directory = settings.configPackageSyncDirectory(dataRootDir);
    if (!directory) {
      throw new Error("还没有同步目录导出记录。");
    }
    return directory;
  }
  if (value === "config-import-backups") {
    return settings.configPackageImportBackupDir(dataRootDir);
  }
  return value || dataRootDir;
}

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

async function ensureLocalExecutorServer() {
  if (localExecutorServer && localExecutorUrl && localExecutorToken) {
    return { url: localExecutorUrl, token: localExecutorToken };
  }
  localExecutorToken = crypto.randomBytes(32).toString("hex");
  localExecutorServer = http.createServer(handleLocalExecutorRequest);
  await new Promise((resolve, reject) => {
    localExecutorServer.once("error", reject);
    localExecutorServer.listen(0, "127.0.0.1", () => {
      localExecutorServer.off("error", reject);
      resolve();
    });
  });
  localExecutorServer.on("error", (error) => appendRuntimeLog(formatError("localExecutorServer", error)));
  const address = localExecutorServer.address();
  localExecutorUrl = `http://127.0.0.1:${address.port}/local-capability/execute`;
  appendLog(`Local capability executor listening on ${localExecutorUrl}.`);
  return { url: localExecutorUrl, token: localExecutorToken };
}

function stopLocalExecutorServer() {
  if (!localExecutorServer) {
    return;
  }
  try {
    localExecutorServer.close();
  } catch (error) {
    appendRuntimeLog(formatError("localExecutorClose", error));
  }
  localExecutorServer = null;
  localExecutorUrl = "";
  localExecutorToken = "";
}

async function handleLocalExecutorRequest(req, res) {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method !== "POST" || url.pathname !== "/local-capability/execute") {
      writeLocalExecutorJson(res, 404, {
        ok: false,
        error: { code: "not_found", message: "本地能力执行器没有这个接口。" },
      });
      return;
    }
    if (req.headers.authorization !== `Bearer ${localExecutorToken}`) {
      writeLocalExecutorJson(res, 401, {
        ok: false,
        error: { code: "unauthorized", message: "本地能力执行器鉴权失败，请重启 Router 或重新启动 CodexBridge。" },
      });
      return;
    }
    const payload = await readLocalExecutorJson(req);
    if (!isAllowedLocalExecutorPayload(payload)) {
      writeLocalExecutorJson(res, 400, {
        ok: false,
        error: {
          code: "unsupported_local_executor_payload",
          message:
            "本地能力执行器只接受浏览器、网页截图、文件处理或 Computer Use 的受控请求。请检查能力类型和接口模式。",
        },
      });
      return;
    }
    const result = await executeDesktopLocalCapability(payload);
    writeLocalExecutorJson(res, 200, { ok: true, result });
  } catch (error) {
    writeLocalExecutorJson(res, 500, {
      ok: false,
      error: {
        code: error?.code || "local_executor_failed",
        message: error?.message || String(error),
      },
    });
  }
}

function isAllowedLocalExecutorPayload(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const adapter = String(payload.adapter || "").trim();
  const capability = String(payload.capability || "").trim();
  return (
    ["local_browser", "local_file", "local_computer_use"].includes(adapter) &&
    ["browser", "webpage_screenshot", "file_processing", "computer_use"].includes(capability)
  );
}

function readLocalExecutorJson(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error("本地能力执行器请求体过大，请减少输入内容后重试。"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text.trim() ? JSON.parse(text) : {});
      } catch (error) {
        reject(new Error("本地能力执行器请求不是有效的 JSON。"));
      }
    });
  });
}

function writeLocalExecutorJson(res, statusCode, body) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function requestManagedAppQuit(reason = "application") {
  cancelRouterRestartTimer();
  if (managedQuitReady) {
    app.quit();
    return { ok: true, alreadyReady: true };
  }
  if (chatgptBridgeService) {
    try {
      await chatgptBridgeService.stop();
    } catch (error) {
      appendRuntimeLog(formatError("doubleQuotaStopOnQuit", error));
    }
  }
  return (await loadRouterLifecycleController()).quit({ reason });
}

function reportManagedQuitFailure(reason, error) {
  appendLog(`Quit cancelled (${reason}); Router remains running: ${error?.message || error}`);
  dialog.showErrorBox(
    "CodexBridge",
    "配置清理失败，Router 已保持运行，CodexBridge 未退出。请检查日志后重试。",
  );
}
async function restartCodexDesktop() {
  if (process.platform === "win32") {
    return restartCodexDesktopWindows();
  }
  if (process.platform === "darwin") {
    const settings = await loadSettings();
    const desktopOptions = settings.loadDesktopOptions(dataRootDir);
    const desktopApp = await locateMacOpenAIDesktopApp(desktopOptions);
    if (!desktopApp) {
      throw new Error("没有找到 ChatGPT 或 Codex Desktop；请先安装其中一个桌面应用后再重试。");
    }
    const commandPlan = macOpenAIDesktopCommandPlan(desktopApp);
    if (!commandPlan) {
      throw new Error("ChatGPT / Codex Desktop 启动路径无效，已停止重启。");
    }
    const quitResult = await runCommandCapture(commandPlan.quit.command, commandPlan.quit.args);
    if (!quitResult.ok) {
      throw new Error(
        quitResult.timedOut
          ? `${desktopApp.appName} 退出操作超时，已取消重新启动。请手动完全退出应用后重试。`
          : `${desktopApp.appName} 未能安全退出，已取消重新启动。请手动完全退出应用后重试。`,
      );
    }
    await delay(500);
    const launchResult = await runCommandCapture(commandPlan.launch.command, commandPlan.launch.args);
    if (!launchResult.ok) {
      throw new Error(
        launchResult.timedOut
          ? `${desktopApp.appName} 启动请求超时；没有报告重启成功，请手动打开 ${desktopApp.appPath}。`
          : `${desktopApp.appName} 启动失败；没有报告重启成功，请手动打开 ${desktopApp.appPath}。`,
      );
    }
    return {
      ok: true,
      appName: desktopApp.appName,
      message: `${desktopApp.appName} restart requested with macOS quit + open ${desktopApp.appPath}.`,
    };
  }
  throw new Error("Restart ChatGPT / Codex is currently supported on Windows and macOS only.");
}

async function locateMacOpenAIDesktopApp(desktopOptions = {}) {
  const homeDir = os.homedir();
  const installed = selectMacOpenAIDesktopApp({
    homeDir,
    preferredTargets: [canonicalSavedOpenAIDesktopTarget(desktopOptions)],
    exists: safeExists,
  });
  if (installed) {
    return installed;
  }
  const appNames = [...new Set(macOpenAIDesktopCandidates(homeDir).map((candidate) => candidate.appName))];
  for (const appName of appNames) {
    const result = await runCommandCapture("open", ["-Ra", appName]);
    if (result.ok) {
      const candidate = {
        appName,
        appPath: result.stdout.trim().split(/\r?\n/)[0] || "",
      };
      if (isKnownMacOpenAIDesktopApp(candidate, homeDir) && macOpenAIDesktopCommandPlan(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

async function recoverCodexProjectsFromPlan(plan = {}, options = {}) {
  const launchRoots = Array.isArray(plan.launchRoots) ? plan.launchRoots : [];
  const missingRoots = Array.isArray(plan.missingRoots) ? plan.missingRoots : [];
  if (!launchRoots.length) {
    return {
      ok: false,
      launched: 0,
      launchedRoots: [],
      missingRoots,
      plan,
      message: missingRoots.length
        ? `没有可直接恢复的项目；${missingRoots.length} 个项目目录不存在。`
        : "没有找到可恢复的 Codex 项目。",
    };
  }
  if (process.platform === "darwin") {
    const settings = await loadSettings();
    const desktopOptions = settings.loadDesktopOptions(dataRootDir);
    const desktopApp = await locateMacOpenAIDesktopApp(desktopOptions);
    if (!desktopApp) {
      throw new Error("没有找到 ChatGPT 或 Codex Desktop，暂时无法恢复项目列表。");
    }
    for (const root of launchRoots) {
      const launchResult = await runCommandCapture(
        "open",
        [desktopApp.appPath, "--args", "--open-project", root.path],
      );
      if (!launchResult.ok) {
        throw new Error(`无法通过 ${desktopApp.appName} 打开项目：${root.path}`);
      }
      await delay(350);
    }
    return {
      ok: true,
      launched: launchRoots.length,
      launchedRoots: launchRoots,
      missingRoots,
      plan,
      appName: desktopApp.appName,
      message: `已请求 ${desktopApp.appName} 恢复 ${launchRoots.length} 个项目；打开应用后会逐步刷新项目列表。`,
    };
  }
  if (process.platform !== "win32") {
    throw new Error("恢复 Codex 项目列表目前仅支持 Windows 和 macOS。");
  }
  const settings = await loadSettings();
  const desktopOptions = settings.loadDesktopOptions(dataRootDir);
  const launchPath = firstExistingPath(await codexDesktopOpenProjectCandidates(desktopOptions));
  if (!launchPath) {
    throw new Error("没有找到可传入 --open-project 的 ChatGPT.exe 或 Codex.exe；请先在设置里选择兼容启动项或正常安装桌面应用。");
  }
  const recovery = await recoverOpenAIProjectsSequentially(launchRoots, {
    launchRoot: (root) => spawnDetachedWithConfirmation(launchPath, ["--open-project", root.path], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    }),
    waitForRootActive: options.waitForActivation
      ? (root) => waitForCodexProjectRootActive(settings, root)
      : async () => delay(350),
  });
  return {
    ok: true,
    launched: recovery.launched,
    launchedRoots: recovery.launchedRoots,
    missingRoots,
    launchPath,
    plan,
    message: `已通过 ${path.basename(launchPath)} 请求恢复 ${launchRoots.length} 个项目；打开 ChatGPT / Codex 后会逐步刷新项目列表。`,
  };
}

async function waitForCodexProjectRootActive(settings, root, {
  timeoutMs = 8000,
  pollMs = 400,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const wanted = path.resolve(String(root?.path || "")).toLowerCase();
  while (Date.now() < deadline) {
    const plan = settings.codexProjectRecoveryPlan({
      homeDir: desktopHomeDir(),
      limit: SESSION_CENTER_LIMIT,
    });
    const active = (plan.roots || []).some((item) =>
      item.active && path.resolve(String(item.path || "")).toLowerCase() === wanted
    );
    if (active) {
      return true;
    }
    await delay(pollMs);
  }
  return false;
}

async function stopOpenAIDesktopForSidebarRecovery(settings) {
  if (process.platform !== "win32") {
    throw new Error("完整会话侧栏恢复目前仅支持 Windows。");
  }
  const desktopOptions = settings.loadDesktopOptions(dataRootDir);
  const candidateEntries = await codexDesktopLaunchCandidateEntries(desktopOptions);
  const restartPlan = buildOpenAIDesktopRestartPlan(
    await listRunningCodexDesktopProcesses(),
    candidateEntries,
    { isLaunchable: isLaunchableCodexDesktopTarget },
  );
  if (!restartPlan.launchTarget) {
    return {
      ok: false,
      stopped: 0,
      launchTarget: "",
      failureCode: "launch_target_missing",
      message: "没有找到可验证的 ChatGPT / Codex 启动项；为保护历史数据，未写入会话目录。",
    };
  }
  const stopResult = await stopCodexDesktopProcesses(restartPlan.processesToStop);
  if (!stopResult.ok) {
    return {
      ...stopResult,
      launchTarget: restartPlan.launchTarget,
      appName: restartPlan.brand || "ChatGPT / Codex",
      failureCode: "desktop_stop_failed",
      message: `未能完全退出 ChatGPT / Codex（PID ${stopResult.failedProcessIds?.join(", ") || "unknown"}）；为防止状态被覆盖，尚未执行会话迁移。`,
    };
  }
  if (stopResult.stopped > 0) {
    await delay(900);
  }
  return {
    ...stopResult,
    launchTarget: restartPlan.launchTarget,
    appName: restartPlan.brand || "ChatGPT / Codex",
  };
}

async function restartCodexDesktopWindows() {
  const settings = await loadSettings();
  const desktopOptions = settings.loadDesktopOptions(dataRootDir);
  const candidateEntries = await codexDesktopLaunchCandidateEntries(desktopOptions);
  const restartPlan = buildOpenAIDesktopRestartPlan(
    await listRunningCodexDesktopProcesses(),
    candidateEntries,
    { isLaunchable: isLaunchableCodexDesktopTarget },
  );
  const launchPath = restartPlan.launchTarget;
  if (!launchPath) {
    throw new Error(
      "Could not find ChatGPT / Codex Desktop. Choose ChatGPT.exe, Codex.exe, or a compatible shortcut in CodexBridge, install the desktop app normally, or set CHATGPT_DESKTOP_EXE / CODEX_DESKTOP_EXE and try again.",
    );
  }

  const appName = restartPlan.brand || "ChatGPT / Codex";
  const stopResult = await stopCodexDesktopProcesses(restartPlan.processesToStop);
  if (!stopResult.ok) {
    if (stopResult.reasons?.includes("taskkill_failed")) {
      throw new Error(
        `未能结束 ChatGPT / Codex 进程（PID ${stopResult.failedProcessIds?.join(", ") || "unknown"}），已取消重新启动，避免同时运行两个实例。`,
      );
    }
    throw new Error(
      `检测到正在运行的 ChatGPT，但其身份或路径无法唯一匹配已验证启动项（${stopResult.reasons?.join(", ") || "unknown"}），无法安全排除 ChatGPT Classic。为避免误关其他应用，请手动完全退出 ChatGPT 后再点击“重启 ChatGPT / Codex”。`,
    );
  }
  if (stopResult.stopped > 0) {
    await delay(900);
  }
  await launchCodexDesktopTarget(launchPath);
  return {
    ok: true,
    appName,
    message: stopResult.stopped > 0
      ? `${appName} restarted: ${launchPath}`
      : `${appName} started: ${launchPath}`,
  };
}

async function locateCodexRestartTarget(settings, locateCodexInstall) {
  const homeDir = os.homedir();
  const desktopOptions = settings.loadDesktopOptions(dataRootDir);
  const canonicalSavedTarget = canonicalSavedOpenAIDesktopTarget(desktopOptions);
  const candidateEntries = process.platform === "win32"
    ? await codexDesktopLaunchCandidateEntries(desktopOptions)
    : prioritizeOpenAIDesktopCandidates([
      ...(openAIDesktopLaunchKind(canonicalSavedTarget) === "mac_app" && safeExists(canonicalSavedTarget)
        ? [{ target: canonicalSavedTarget, source: "saved" }]
        : []),
      ...macOpenAIDesktopCandidates(homeDir).map((candidate) => ({
        target: candidate.appPath,
        source: "common",
      })),
    ]);
  const validatedTargets = new Set(candidateEntries.map((entry) => entry.target.toLowerCase()));
  const savedExecutable = String(desktopOptions?.codexDesktopExe || "").trim();
  const compatibleDesktopOptions = {
    ...desktopOptions,
    codexDesktopLaunchTarget: validatedTargets.has(canonicalSavedTarget.toLowerCase())
      ? canonicalSavedTarget
      : "",
    codexDesktopExe: canonicalSavedTarget === savedExecutable &&
      validatedTargets.has(savedExecutable.toLowerCase()) &&
      isOpenAIDesktopExecutablePath(savedExecutable)
      ? savedExecutable
      : "",
  };
  const locatorEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      !["codex_desktop_exe", "chatgpt_desktop_exe"].includes(key.toLowerCase()),
    ),
  );
  for (const envName of ["CHATGPT_DESKTOP_EXE", "CODEX_DESKTOP_EXE"]) {
    const configuredDesktopExe = envValue(process.env, envName);
    locatorEnv[envName] = validatedTargets.has(configuredDesktopExe.toLowerCase())
      ? configuredDesktopExe
      : "";
  }
  const running = process.platform === "win32"
    ? authorizeOpenAIDesktopProcesses(await listRunningCodexDesktopProcesses(), candidateEntries)
    : [];
  const preferredTargets = process.platform === "win32"
    ? prioritizeOpenAIDesktopCandidates(
      running.filter((item) => item.safeToStop).map((item) => ({
        target: item.executablePath,
        source: "running",
      })),
    )
    : [];
  const commonCandidates = candidateEntries
    .filter((entry) => entry.source === "common")
    .map((entry) => entry.target);
  const shortcutCandidates = candidateEntries
    .filter((entry) => openAIDesktopLaunchKind(entry.target) === "shortcut")
    .map((entry) => entry.target);
  const shellAppCandidates = candidateEntries
    .filter((entry) => entry.source === "shell" && openAIDesktopLaunchKind(entry.target) === "shell")
    .map((entry) => entry.target);
  const pathCandidates = candidateEntries
    .filter((entry) => ["restricted", "path"].includes(entry.source))
    .map((entry) => entry.target);
  return locateCodexInstall({
    platform: process.platform,
    desktopOptions: compatibleDesktopOptions,
    env: locatorEnv,
    homeDir,
    preferredTargets,
    commonCandidates,
    shortcutCandidates,
    resolveShortcut: process.platform === "win32" ? resolveWindowsShortcutTarget : undefined,
    shellAppCandidates,
    pathCandidates,
  });
}

async function codexDesktopOpenProjectCandidates(desktopOptions = {}) {
  const entries = await codexDesktopLaunchCandidateEntries(desktopOptions);
  const storeExecutableEntries = process.platform === "win32"
    ? (await codexDesktopStoreExecutableCandidates(
      entries.filter((entry) => openAIDesktopLaunchKind(entry.target) === "shell").map((entry) => entry.target),
    )).map((target) => ({ target, source: "shortcut_target" }))
    : [];
  const runningEntries = process.platform === "win32"
    ? authorizeOpenAIDesktopProcesses(await listRunningCodexDesktopProcesses(), entries)
      .filter((item) => item.safeToStop && item.executablePath)
      .map((item) => ({ target: item.executablePath, source: "running" }))
    : [];
  return prioritizeOpenAIDesktopCandidates([...runningEntries, ...storeExecutableEntries, ...entries])
    .filter((entry) => openAIDesktopLaunchKind(entry.target) === "executable")
    .map((entry) => entry.target);
}

async function codexDesktopStoreExecutableCandidates(
  shellTargets = [],
  { timeoutMs = 5000 } = {},
) {
  const packageFamilies = [...new Set((Array.isArray(shellTargets) ? shellTargets : [])
    .map((target) => openAIDesktopStorePackageFamily(target))
    .filter(Boolean))];
  const candidates = [];
  for (const packageFamily of packageFamilies) {
    const result = await runCommandCapture("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "$f=[Environment]::GetEnvironmentVariable('CODEXBRIDGE_PACKAGE_FAMILY','Process'); $p=Get-AppxPackage | Where-Object { $_.PackageFamilyName -eq $f } | Select-Object -First 1; if ($p) { @((Join-Path $p.InstallLocation 'ChatGPT.exe'),(Join-Path $p.InstallLocation 'Codex.exe'),(Join-Path $p.InstallLocation 'app\\ChatGPT.exe'),(Join-Path $p.InstallLocation 'app\\Codex.exe')) | Where-Object { Test-Path -LiteralPath $_ } }",
    ], {
      env: {
        ...process.env,
        CODEXBRIDGE_PACKAGE_FAMILY: packageFamily,
      },
      timeoutMs,
    });
    if (!result.ok) {
      continue;
    }
    candidates.push(...result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => isOpenAIDesktopExecutablePath(line)));
  }
  return [...new Set(candidates)];
}

async function launchCodexDesktopTarget(launchPath) {
  const launchKind = openAIDesktopLaunchKind(launchPath);
  if (!launchKind) {
    throw new Error(`Unsupported ChatGPT / Codex launch target: ${launchPath}`);
  }
  const isShortcut = launchKind === "shortcut";
  const isShellTarget = launchKind === "shell";
  if (isShortcut || isShellTarget) {
    await spawnDetachedWithConfirmation("explorer.exe", [launchPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
    return;
  }
  await spawnDetachedWithConfirmation(launchPath, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
}

async function listRunningCodexDesktopProcesses() {
  const providers = [
    listCodexDesktopProcessesWithPowerShell,
    listCodexDesktopProcessesWithWmic,
    listCodexDesktopProcessesWithTasklist,
  ];
  for (const provider of providers) {
    const result = await provider();
    if (result.available) {
      return result.processes;
    }
  }
  return [];
}

async function listCodexDesktopProcessesWithPowerShell() {
  const result = await runCommandCapture("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::UTF8; @(Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe' OR Name='Codex.exe'\" | Select-Object Name,ProcessId,ExecutablePath,CommandLine) | ConvertTo-Json -Compress",
  ]);
  if (!result.ok) {
    return { available: false, processes: [] };
  }
  try {
    const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : [];
    const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    return {
      available: true,
      processes: rows
        .map((row) => classifyOpenAIDesktopProcess({
          name: row?.Name,
          processId: row?.ProcessId,
          executablePath: row?.ExecutablePath,
          commandLine: row?.CommandLine,
        }))
        .filter((item) => item.recognized),
    };
  } catch {
    return { available: false, processes: [] };
  }
}

async function listCodexDesktopProcessesWithWmic() {
  const result = await runCommandCapture("wmic.exe", [
    "process",
    "where",
    "name='ChatGPT.exe' or name='Codex.exe'",
    "get",
    "Name,ProcessId,ExecutablePath,CommandLine",
    "/format:csv",
  ]);
  if (!result.ok) {
    return { available: false, processes: [] };
  }
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const headerIndex = lines.findIndex((line) => /(?:^|,)ProcessId(?:,|$)/i.test(line));
  if (headerIndex === -1) {
    return { available: true, processes: [] };
  }
  const headers = parseCsvLine(lines[headerIndex]).map((column) => column.trim().toLowerCase());
  const processes = lines.slice(headerIndex + 1)
    .map((line) => {
      const values = parseCsvLine(line);
      const row = Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
      return classifyOpenAIDesktopProcess({
        name: row.name,
        processId: row.processid,
        executablePath: row.executablepath,
        commandLine: row.commandline,
      });
    })
    .filter((item) => item.recognized);
  return { available: true, processes };
}

async function listCodexDesktopProcessesWithTasklist() {
  const results = await Promise.all(DESKTOP_APP_IMAGE_NAMES.map(async (imageName) => ({
    imageName,
    result: await runCommandCapture("tasklist.exe", [
      "/FI",
      `IMAGENAME eq ${imageName}`,
      "/FO",
      "CSV",
      "/NH",
    ]),
  })));
  if (!results.some(({ result }) => result.ok)) {
    return { available: false, processes: [] };
  }
  const processes = results.flatMap(({ imageName, result }) => {
    if (!result.ok || !result.stdout.trim() || /No tasks are running/i.test(result.stdout)) {
      return [];
    }
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const columns = parseCsvLine(line);
        return classifyOpenAIDesktopProcess({
          name: columns[0] || imageName,
          processId: columns[1],
        });
      })
      .filter((item) => item.recognized);
  });
  return { available: true, processes };
}

async function stopCodexDesktopProcesses(running) {
  if (!running.length) {
    return { ok: true, stopped: 0, skipped: 0 };
  }
  const unsafeProcesses = running.filter((item) => item.recognized && !item.safeToStop);
  if (unsafeProcesses.length) {
    return {
      ok: false,
      stopped: 0,
      skipped: unsafeProcesses.length,
      reasons: [...new Set(unsafeProcesses.map((item) => item.reason).filter(Boolean))],
    };
  }
  const processIds = [...new Set(running
    .filter((item) => item.safeToStop)
    .map((item) => item.processId)
    .filter((processId) => Number.isInteger(processId) && processId > 0))];
  const commandResults = await Promise.all(
    processIds.map((processId) => runCommandQuiet("taskkill.exe", ["/PID", String(processId), "/F"])),
  );
  const summary = summarizeOpenAIDesktopStopResults(processIds, commandResults);
  return {
    ...summary,
    skipped: summary.skipped + Math.max(0, running.length - processIds.length),
  };
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

function codexDesktopCandidates(desktopOptions = {}, env = process.env, homeDir = os.homedir()) {
  return codexDesktopCandidateEntries(desktopOptions, env, homeDir).map((entry) => entry.target);
}

function codexDesktopCandidateEntries(desktopOptions = {}, env = process.env, homeDir = os.homedir()) {
  const defaults = windowsCodexDesktopEnvDefaults(env, homeDir);
  const localAppData = envValue(env, "LOCALAPPDATA") || defaults.localAppData;
  const appData = envValue(env, "APPDATA") || defaults.appData;
  const userProfile = envValue(env, "USERPROFILE") || defaults.userProfile;
  const programFiles = envValue(env, "ProgramFiles", "PROGRAMFILES") || defaults.programFiles;
  const programFilesX86 = envValue(env, "ProgramFiles(x86)", "PROGRAMFILES(X86)") || defaults.programFilesX86;
  const entries = [
    { target: canonicalSavedOpenAIDesktopTarget(desktopOptions), source: "saved" },
    { target: envValue(env, "CHATGPT_DESKTOP_EXE"), source: "env" },
    { target: envValue(env, "CODEX_DESKTOP_EXE"), source: "env" },
    ...[
      joinIfRoot(localAppData, "OpenAI", "ChatGPT", "ChatGPT.exe"),
      joinIfRoot(localAppData, "OpenAI", "ChatGPT", "app", "ChatGPT.exe"),
      joinIfRoot(localAppData, "Programs", "ChatGPT", "ChatGPT.exe"),
      joinIfRoot(localAppData, "Programs", "ChatGPT", "app", "ChatGPT.exe"),
      joinIfRoot(localAppData, "Programs", "ChatGPT Desktop", "ChatGPT.exe"),
      joinIfRoot(localAppData, "Programs", "OpenAI ChatGPT", "ChatGPT.exe"),
      joinIfRoot(localAppData, "Programs", "OpenAI", "ChatGPT", "ChatGPT.exe"),
      joinIfRoot(appData, "ChatGPT", "ChatGPT.exe"),
      joinIfRoot(userProfile, "AppData", "Local", "OpenAI", "ChatGPT", "ChatGPT.exe"),
      joinIfRoot(userProfile, "AppData", "Local", "Programs", "ChatGPT", "ChatGPT.exe"),
      joinIfRoot(programFiles, "ChatGPT", "ChatGPT.exe"),
      joinIfRoot(programFiles, "OpenAI ChatGPT", "ChatGPT.exe"),
      joinIfRoot(programFiles, "OpenAI", "ChatGPT", "ChatGPT.exe"),
      joinIfRoot(programFilesX86, "ChatGPT", "ChatGPT.exe"),
      joinIfRoot(programFilesX86, "OpenAI ChatGPT", "ChatGPT.exe"),
      joinIfRoot(programFilesX86, "OpenAI", "ChatGPT", "ChatGPT.exe"),
      joinIfRoot(localAppData, "OpenAI", "Codex", "Codex.exe"),
      joinIfRoot(localAppData, "OpenAI", "Codex", "app", "Codex.exe"),
      joinIfRoot(localAppData, "OpenAI", "Codex", "app", "app", "Codex.exe"),
      joinIfRoot(localAppData, "Programs", "Codex", "app", "Codex.exe"),
      joinIfRoot(localAppData, "Programs", "Codex", "Codex.exe"),
      joinIfRoot(localAppData, "Programs", "Codex Desktop", "Codex.exe"),
      joinIfRoot(localAppData, "Programs", "OpenAI Codex", "Codex.exe"),
      joinIfRoot(localAppData, "Programs", "OpenAI", "Codex.exe"),
      joinIfRoot(localAppData, "Programs", "OpenAI", "Codex", "Codex.exe"),
      joinIfRoot(localAppData, "Codex", "Codex.exe"),
      joinIfRoot(appData, "Codex", "Codex.exe"),
      joinIfRoot(userProfile, "AppData", "Local", "OpenAI", "Codex", "Codex.exe"),
      joinIfRoot(userProfile, "AppData", "Local", "Programs", "Codex", "Codex.exe"),
      joinIfRoot(programFiles, "Codex", "Codex.exe"),
      joinIfRoot(programFiles, "OpenAI Codex", "Codex.exe"),
      joinIfRoot(programFiles, "OpenAI", "Codex", "Codex.exe"),
      joinIfRoot(programFilesX86, "Codex", "Codex.exe"),
      joinIfRoot(programFilesX86, "OpenAI Codex", "Codex.exe"),
      joinIfRoot(programFilesX86, "OpenAI", "Codex", "Codex.exe"),
    ].map((target) => ({ target, source: "common" })),
    ...[
      joinIfRoot(localAppData, "Microsoft", "WindowsApps", "ChatGPT.exe"),
      joinIfRoot(localAppData, "Microsoft", "WindowsApps", "Codex.exe"),
    ].map((target) => ({ target, source: "restricted" })),
  ];
  return prioritizeOpenAIDesktopCandidates(entries)
    .filter((entry) => openAIDesktopLaunchKind(entry.target) !== "shortcut");
}

async function codexDesktopLaunchCandidates(desktopOptions = {}) {
  return (await codexDesktopLaunchCandidateEntries(desktopOptions)).map((entry) => entry.target);
}

async function codexDesktopLaunchCandidateEntries(desktopOptions = {}) {
  if (process.platform !== "win32") {
    return codexDesktopCandidateEntries(desktopOptions);
  }
  const canonicalSavedTarget = canonicalSavedOpenAIDesktopTarget(desktopOptions);
  const savedShortcutCandidates = openAIDesktopLaunchKind(canonicalSavedTarget) === "shortcut"
    ? [canonicalSavedTarget]
    : [];
  const shortcutCandidates = [
    ...savedShortcutCandidates,
    ...codexDesktopShortcutCandidates(),
  ];
  const savedShortcutSet = new Set(savedShortcutCandidates.map((target) => target.toLowerCase()));
  const resolvedShortcuts = await resolveOpenAIDesktopShortcutCandidates(shortcutCandidates);
  const entries = [
    ...codexDesktopCandidateEntries(desktopOptions),
    ...resolvedShortcuts.map((item) => ({
      target: item.shortcutPath,
      source: savedShortcutSet.has(item.shortcutPath.toLowerCase()) ? "saved" : "shortcut",
    })),
    ...resolvedShortcuts.map((item) => ({
      target: item.launchTarget,
      source: openAIDesktopLaunchKind(item.launchTarget) === "shell" ? "shell" : "shortcut_target",
    })),
    ...(await codexDesktopShellAppCandidates()).map((target) => ({ target, source: "shell" })),
    ...(await codexDesktopWhereCandidates()).map((target) => ({ target, source: "path" })),
  ];
  return prioritizeOpenAIDesktopCandidates(entries);
}

function codexDesktopShortcutCandidates(env = process.env, homeDir = os.homedir()) {
  const defaults = windowsCodexDesktopEnvDefaults(env, homeDir);
  const appData = envValue(env, "APPDATA") || defaults.appData;
  const programData = envValue(env, "ProgramData", "PROGRAMDATA") || defaults.programData;
  const userProfile = envValue(env, "USERPROFILE") || defaults.userProfile;
  const publicProfile = envValue(env, "PUBLIC") || defaults.publicProfile;
  const startMenuRoots = [
    joinIfRoot(appData, "Microsoft", "Windows", "Start Menu", "Programs"),
    joinIfRoot(programData, "Microsoft", "Windows", "Start Menu", "Programs"),
    joinIfRoot(userProfile, "Desktop"),
    joinIfRoot(publicProfile, "Desktop"),
  ].filter(Boolean);
  const shortcutNames = [
    "ChatGPT.lnk",
    "ChatGPT Desktop.lnk",
    "OpenAI ChatGPT.lnk",
    "Codex.lnk",
    "Codex Desktop.lnk",
    "OpenAI Codex.lnk",
  ];
  const fixedRoots = [
    joinIfRoot(appData, "Microsoft", "Windows", "Start Menu", "Programs"),
    joinIfRoot(programData, "Microsoft", "Windows", "Start Menu", "Programs"),
    joinIfRoot(userProfile, "Desktop"),
    joinIfRoot(publicProfile, "Desktop"),
  ].filter(Boolean);
  const fixed = fixedRoots.flatMap((root) => shortcutNames.map((name) => path.join(root, name)));
  const scanBudget = { startedAt: Date.now(), operations: 0, found: 0 };
  return prioritizeOpenAIDesktopCandidates([
    ...fixed.map((target) => ({ target, source: "shortcut" })),
    ...startMenuRoots
      .flatMap((root) => findCodexDesktopShortcuts(root, 3, scanBudget))
      .map((target) => ({ target, source: "shortcut" })),
  ]).map((entry) => entry.target);
}

function findCodexDesktopShortcuts(
  rootDir,
  maxDepth = 3,
  budget = { startedAt: Date.now(), operations: 0, found: 0 },
) {
  const found = [];
  const stack = [{ dir: rootDir, depth: 0 }];
  const withinBudget = () =>
    budget.operations < SHORTCUT_SCAN_MAX_OPERATIONS &&
    budget.found < SHORTCUT_SCAN_MAX_CANDIDATES &&
    Date.now() - budget.startedAt <= SHORTCUT_SCAN_MAX_DURATION_MS;
  while (stack.length && withinBudget()) {
    const current = stack.pop();
    try {
      budget.operations += 1;
      for (const entry of fs.readdirSync(current.dir, { withFileTypes: true })) {
        budget.operations += 1;
        if (!withinBudget()) {
          break;
        }
        const entryPath = path.join(current.dir, entry.name);
        if (entry.isDirectory() && current.depth < maxDepth) {
          stack.push({ dir: entryPath, depth: current.depth + 1 });
          continue;
        }
        if (entry.isFile() && isOpenAIDesktopShortcutName(entry.name)) {
          found.push(entryPath);
          budget.found += 1;
        }
      }
    } catch {
      // Some shell folders can be unavailable or permission-protected.
    }
  }
  return found;
}

function windowsCodexDesktopEnvDefaults(env = process.env, homeDir = os.homedir()) {
  const explicitHome = String(homeDir || "").trim();
  const envHome = envValue(env, "USERPROFILE");
  const userProfile = envHome || explicitHome || os.homedir();
  const root = path.parse(userProfile || process.cwd()).root || "C:\\";
  const driveRoot = /^[A-Za-z]:[\\/]?$/.test(root) ? root : "C:\\";
  return {
    userProfile,
    appData: userProfile ? path.join(userProfile, "AppData", "Roaming") : "",
    localAppData: userProfile ? path.join(userProfile, "AppData", "Local") : "",
    programData: path.join(envValue(env, "SystemDrive", "SYSTEMDRIVE") || driveRoot.replace(/[\\/]$/, ""), "ProgramData"),
    publicProfile: path.join(path.dirname(userProfile || driveRoot), "Public"),
    programFiles: path.join(driveRoot, "Program Files"),
    programFilesX86: path.join(driveRoot, "Program Files (x86)"),
  };
}

async function codexDesktopShortcutTargets(shortcutCandidates = codexDesktopShortcutCandidates()) {
  const resolved = await resolveOpenAIDesktopShortcutCandidates(shortcutCandidates);
  return resolved
    .map((item) => item.launchTarget)
    .filter((target) => openAIDesktopLaunchKind(target) === "executable");
}

async function codexDesktopValidatedShortcutCandidates(shortcutCandidates = codexDesktopShortcutCandidates()) {
  return (await resolveOpenAIDesktopShortcutCandidates(shortcutCandidates))
    .map((item) => item.shortcutPath);
}

async function resolveOpenAIDesktopShortcutCandidates(shortcutCandidates = []) {
  const uniqueCandidates = [...new Set((Array.isArray(shortcutCandidates) ? shortcutCandidates : [])
    .map((candidate) => String(candidate || "").trim())
    .filter((candidate) => isOpenAIDesktopShortcutName(candidate) && safeExists(candidate)))];
  const resolved = [];
  const startedAt = Date.now();
  for (const shortcutPath of uniqueCandidates) {
    const remainingMs = SHORTCUT_RESOLVE_MAX_DURATION_MS - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }
    const resolution = await resolveWindowsShortcutTarget(shortcutPath, {
      timeoutMs: Math.min(SHORTCUT_RESOLVE_COMMAND_TIMEOUT_MS, remainingMs),
    });
    const launchTarget = await verifiedOpenAIDesktopShortcutLaunchTarget(resolution, {
      timeoutMs: Math.max(1, remainingMs - (Date.now() - startedAt)),
    });
    if (launchTarget) {
      resolved.push({ shortcutPath, launchTarget, resolution });
    }
  }
  return resolved;
}

async function verifiedOpenAIDesktopShortcutLaunchTarget(
  resolution,
  { timeoutMs = 5000 } = {},
) {
  const parsedTarget = openAIDesktopTargetFromShortcutResolution(resolution);
  if (!parsedTarget) {
    return "";
  }
  if (isOpenAIDesktopShellTarget(parsedTarget)) {
    const installedExecutables = await codexDesktopStoreExecutableCandidates(
      [parsedTarget],
      { timeoutMs },
    );
    return validatedOpenAIDesktopTargetFromShortcutResolution(resolution, {
      storeInstalled: installedExecutables.length > 0,
    });
  }
  return validatedOpenAIDesktopTargetFromShortcutResolution(resolution, { exists: safeExists });
}

async function codexDesktopShellAppCandidates() {
  const result = await runCommandCapture("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::UTF8; Get-StartApps | Where-Object { $_.Name -match 'ChatGPT|Codex' -or $_.AppID -match 'ChatGPT|Codex' } | ForEach-Object { '{0}`t{1}' -f $_.Name, $_.AppID }",
  ]);
  if (!result.ok || !result.stdout.trim()) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("\t");
      return separator === -1
        ? { name: "", appId: line }
        : { name: line.slice(0, separator), appId: line.slice(separator + 1) };
    })
    .filter((entry) => openAIDesktopBrand(`${entry.name} ${entry.appId}`))
    .map((entry) => `shell:AppsFolder\\${entry.appId}`)
    .filter((target) => isOpenAIDesktopShellTarget(target));
}

async function resolveWindowsShortcutTarget(
  shortcutPath,
  { timeoutMs = SHORTCUT_RESOLVE_COMMAND_TIMEOUT_MS } = {},
) {
  const invocation = windowsShortcutResolverInvocation(shortcutPath, process.env);
  const result = await runCommandCapture("powershell.exe", invocation.args, {
    env: invocation.env,
    timeoutMs,
  });
  if (!result.ok || !result.stdout.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout.trim());
    return {
      targetPath: String(parsed?.targetPath || "").trim(),
      arguments: String(parsed?.arguments || "").trim(),
    };
  } catch {
    return null;
  }
}

async function codexDesktopWhereCandidates() {
  const results = await Promise.all([
    runCommandCapture("where.exe", ["ChatGPT.exe"]),
    runCommandCapture("where.exe", ["Codex.exe"]),
  ]);
  return results.flatMap((result) => result.ok
    ? result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => isOpenAIDesktopExecutablePath(line))
    : []);
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

function firstLaunchableCodexDesktopTarget(candidates) {
  return candidates.find((candidate) => isLaunchableCodexDesktopTarget(candidate));
}

function isLaunchableCodexDesktopTarget(candidate) {
  const target = String(candidate || "").trim();
  if (!isOpenAIDesktopLaunchTarget(target)) {
    return false;
  }
  if (isOpenAIDesktopShellTarget(target)) {
    return true;
  }
  return safeExists(target);
}

function safeExists(targetPath) {
  try {
    return Boolean(targetPath && fs.existsSync(targetPath));
  } catch {
    return false;
  }
}

function envValue(env = process.env, ...names) {
  for (const name of names) {
    if (env[name]) {
      return env[name];
    }
  }
  const entries = Object.entries(env || {});
  for (const name of names) {
    const found = entries.find(([key]) => key.toLowerCase() === String(name).toLowerCase());
    if (found?.[1]) {
      return found[1];
    }
  }
  return "";
}

function joinIfRoot(root, ...parts) {
  return root ? path.join(root, ...parts) : "";
}

function runCommandCapture(command, args, options = {}) {
  return runCommandCaptureWithTimeout(command, args, {
    ...options,
    spawnImpl: spawn,
  });
}

function runCommandQuiet(command, args) {
  return runCommandCaptureWithTimeout(command, args, {
    spawnImpl: spawn,
    stdio: "ignore",
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
      cleanupInstallerPackageAfterUpdate(0);
      await cleanupInstalledAppVersionsAfterUpdate(updater);
    }
  } catch (error) {
    appendRuntimeLog(formatError("cleanupUpdates", error));
  }
}

function cleanupInstallerPackageAfterUpdate(attempt = 0) {
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
    if (attempt < 5) {
      setTimeout(() => cleanupInstallerPackageAfterUpdate(attempt + 1), 3000);
    }
  }
}

async function cleanupInstalledAppVersionsAfterUpdate(updater) {
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

  let targets = [];
  let legacyTargets = [];
  try {
    targets = await updater.installedAppVersionCleanupTargets?.({
      installedRoots: roots,
      currentAppDir,
    }) || [];
    legacyTargets = await updater.installedLegacyAppCleanupTargets?.({
      installedRoots: roots,
      currentAppDir,
    }) || [];
  } catch (error) {
    appendRuntimeLog(formatError("cleanupInstalledApps", error));
    return;
  }

  for (const targetDir of targets) {
    const installedRoot = roots.find((root) => isPathInsideOrEqual(targetDir, root));
    if (!installedRoot) {
      appendRuntimeLog(`Skipped installed app cleanup outside known roots: ${targetDir}`);
      continue;
    }
    try {
      removeDirectoryTreeSafeSync(targetDir, installedRoot);
      appendRuntimeLog(`Removed previous CodexBridge app directory: ${targetDir}`);
    } catch (error) {
      appendRuntimeLog(formatError("cleanupInstalledAppVersion", error));
    }
  }
  for (const target of legacyTargets) {
    const targetPath = normalizeFsPath(target?.path);
    const installedRoot = roots.find((root) => isPathInsideOrEqual(targetPath, root));
    if (!installedRoot) {
      appendRuntimeLog(`Skipped legacy installed app cleanup outside known roots: ${targetPath}`);
      continue;
    }
    try {
      removeInstalledCleanupTargetSafeSync(target, installedRoot);
      appendRuntimeLog(`Removed previous CodexBridge legacy app item: ${targetPath}`);
    } catch (error) {
      appendRuntimeLog(formatError("cleanupLegacyInstalledApp", error));
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

function removeInstalledCleanupTargetSafeSync(target, allowedRoot) {
  const targetPath = normalizeFsPath(target?.path || target);
  const kind = target?.kind === "directory" ? "directory" : "file";
  if (kind === "directory") {
    removeDirectoryTreeSafeSync(targetPath, allowedRoot);
    return;
  }
  removeFileSafeSync(targetPath, allowedRoot);
}

function removeFileSafeSync(filePath, allowedRoot) {
  const target = normalizeFsPath(filePath);
  const root = normalizeFsPath(allowedRoot);
  if (!target || !root || samePath(target, root) || !isPathInsideOrEqual(target, root)) {
    throw new Error(`Refusing to remove file outside allowed root: ${filePath}`);
  }
  if (!fs.existsSync(target)) {
    return;
  }
  const stats = fs.statSync(target);
  if (!stats.isFile()) {
    throw new Error(`Refusing to remove non-file as file: ${filePath}`);
  }
  fs.rmSync(target, { force: true });
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
  if (isQuitting || routerProcess || routerRestartTimer) {
    return;
  }
  const attempt = routerRestartBudget.nextAttempt();
  if (!attempt.allowed) {
    appendLog(`Router watchdog stopped after ${attempt.maxAttempts} consecutive unstable restart attempts.`);
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
  const delayMs = Math.min(ROUTER_RESTART_BASE_DELAY_MS * attempt.attempt, ROUTER_RESTART_MAX_DELAY_MS);
  appendLog(
    `Router watchdog will restart in ${delayMs} ms ` +
      `(attempt ${attempt.attempt}/${attempt.maxAttempts}, last code ${exitCode ?? "unknown"}).`,
  );
  routerRestartTimer = setTimeout(async () => {
    routerRestartTimer = null;
    if (isQuitting || routerProcess) {
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

function cancelRouterRestartTimer({ resetAttempts = true } = {}) {
  if (routerRestartTimer) {
    clearTimeout(routerRestartTimer);
    routerRestartTimer = null;
  }
  routerRestartBudget.cancel({ resetAttempts });
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
  updater.validateDownloadedReleaseAsset?.(installerPath, plan.asset);
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
  updater.validateDownloadedReleaseAsset?.(downloadPath, plan.asset);

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

async function currentInstallKind() {
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
  const updater = await loadUpdater();
  const appDir = path.dirname(process.execPath);
  const registryRoot = await installedRootFromRegistry();
  return updater.inferUpdateInstallKind?.({
    forcedInstallKind: forced,
    appIsPackaged: app.isPackaged,
    platform: process.platform,
    execPath: process.execPath,
    localAppData: process.env.LOCALAPPDATA,
    registryRoot,
    portableMarkerFound: windowsPortableMarkerFound(appDir),
  }) || "installed";
}

function windowsPortableMarkerFound(appDir) {
  if (process.platform !== "win32") {
    return false;
  }
  const resolvedAppDir = path.resolve(appDir || "");
  const candidates = [
    path.join(resolvedAppDir, ".codexbridge-portable"),
    path.join(path.dirname(resolvedAppDir), ".codexbridge-portable"),
  ];
  return candidates.some((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
}

async function installedRootFromRegistry() {
  if (process.platform !== "win32") {
    return "";
  }
  const result = await runCommandCapture("reg.exe", [
    "query",
    "HKCU\\Software\\CodexBridge",
    "/v",
    "InstallRoot",
  ]);
  if (!result.ok) {
    return "";
  }
  const root = registryStringValue(result.stdout, "InstallRoot");
  return root ? path.resolve(root) : "";
}

function registryStringValue(output, name) {
  const pattern = new RegExp(`^\\s*${escapeRegExp(name)}\\s+REG_\\w+\\s+(.+?)\\s*$`, "im");
  return String(output || "").match(pattern)?.[1]?.trim() || "";
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function quitAfterUpdateLaunch() {
  const timer = setTimeout(() => {
    requestManagedAppQuit("update").catch((error) => {
      reportManagedQuitFailure("update", error);
    });
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
    "CodexBridge Windows 安装器更新说明",
    "",
    `已下载安装器：${installerPath}`,
    `更新目录：${updatesDir}`,
    "",
    "接下来会发生什么：",
    "1. 下载完成后，CodexBridge 会打开交互式安装窗口。",
    "2. 如果不想使用默认用户程序目录，可以在安装器里选择安装位置。",
    "3. 安装器默认创建桌面图标，安装完成后启动新版 CodexBridge，并把清理信息交给新版。",
    "4. 新版会清理刚下载的安装包和旧的受管 app-* 版本目录。",
    "5. 你的配置、Key、模型选择、统计和日志都保存在用户数据目录，不会因为安装位置变化而丢失。",
    "",
    "当前正在运行的旧版不会被静默覆盖。",
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
    "CodexBridge 免安装更新兜底说明",
    "",
    `已下载更新包：${packagePath}`,
    `当前程序目录：${currentAppDir}`,
    "自动更新通常会在下载后启动辅助脚本，并自动重启 CodexBridge。",
    "如果自动更新没有重启，请按下面的兜底步骤处理。",
    "",
  ];
  if (platform === "win32") {
    lines.push(
      "手动更新步骤：",
      "1. 从托盘图标完全退出 CodexBridge。",
      "2. 在这个 updates 文件夹里解压已下载的更新包。",
      "3. 打开解压出来的 CodexBridge-win32-x64 文件夹。",
      "4. 运行里面的 CodexBridge.exe。",
      "",
      "你的配置、Key、模型选择、统计和日志都保存在用户数据目录，不在这个更新包文件夹里。",
    );
  } else if (platform === "darwin") {
    lines.push(
      "手动更新步骤：",
      "1. 完全退出 CodexBridge。",
      "2. 在这个 updates 文件夹里解压已下载的更新包。",
      "3. 打开解压出来的 CodexBridge.app。",
      "",
      "你的配置、Key、模型选择、统计和日志都保存在用户数据目录，不在这个更新包文件夹里。",
    );
  } else {
    lines.push("当前系统暂不支持自动更新。");
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

function runtimeEnv(settings, localExecutor = {}) {
  const env = settings.routerRuntimeEnv(dataRootDir, process.env);
  if (localExecutor.url && localExecutor.token) {
    env.CODEXBRIDGE_LOCAL_EXECUTOR_URL = localExecutor.url;
    env.CODEXBRIDGE_LOCAL_EXECUTOR_TOKEN = localExecutor.token;
  }
  if (app.isPackaged) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  return env;
}

function scriptPath(relativePath) {
  return path.join(appRootDir, relativePath);
}

function safeMarkdownFileName(value = "") {
  const clean = String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return clean || "Codex-session";
}

function fileTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function appendHistoryRecoveryStatus(status = {}) {
  appendLog(
    `History recovery phase=${status.phase || "unknown"} ` +
    `planned=${Number(status.plannedInserts || 0)} ` +
    `inserted=${Number(status.actualInserted || 0)} ` +
    `commit=${status.commitStatus || "not_started"} ` +
    `catalog=${Number(status.rereadCatalogThreads || 0)} ` +
    `sidebar=${Number(status.rereadSidebarThreads || 0)} ` +
    `backup=${status.backupDir || "none"} ` +
    `failure=${status.failureCode || "none"}`,
  );
  if (status.failureReason) {
    appendLog(`History recovery failed: ${status.failureReason}`);
  }
}

function appendLog(line) {
  try {
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
  } catch {
    appendRuntimeLog("appendLog failed; the diagnostic entry was dropped.");
  }
}

function sendToRenderer(channel, payload) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    const { webContents } = mainWindow;
    if (!webContents || webContents.isDestroyed()) {
      return;
    }
    webContents.send(channel, payload);
  } catch {
    appendRuntimeLog("Renderer publication failed; the committed operation remains successful.");
  }
}

function emitUpdateProgress(progress) {
  sendToRenderer("updates:progress", {
    ...progress,
    updatedAt: new Date().toISOString(),
  });
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
    appendBoundedLog(runtimeLogPath, `[${new Date().toISOString()}] ${line}`);
  } catch {
    // Logging must never crash the desktop app.
  }
}

function readHistoryRecoveryState() {
  try {
    if (!fs.existsSync(historyRecoveryStatePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(historyRecoveryStatePath, "utf8"));
  } catch (error) {
    appendRuntimeLog(formatError("historyRecoveryStateRead", error));
    return null;
  }
}

function writeHistoryRecoveryState(state) {
  fs.mkdirSync(path.dirname(historyRecoveryStatePath), { recursive: true });
  const temporaryPath = `${historyRecoveryStatePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(temporaryPath, historyRecoveryStatePath);
  } catch (error) {
    if (!fs.existsSync(historyRecoveryStatePath)) {
      throw error;
    }
    fs.unlinkSync(historyRecoveryStatePath);
    fs.renameSync(temporaryPath, historyRecoveryStatePath);
  }
}

function appendHistoryRecoveryWorkerPhase(phase, details = {}) {
  const safeDetails = {
    plannedInserts: Number(details?.plannedInserts || details?.summary?.plannedInserts || 0),
    actualInserted: Number(details?.actualInserted || details?.inserted || 0),
    actualUpdated: Number(details?.actualUpdated || details?.updated || 0),
    catalogThreads: Number(details?.rereadCatalogThreads || details?.catalogActiveUserThreads || 0),
    sidebarThreads: Number(details?.rereadSidebarThreads || details?.sidebarActiveUserThreads || 0),
    backupDir: String(details?.backupDir || ""),
    failureCode: String(details?.failureCode || ""),
  };
  appendRuntimeLog(`history_recovery phase=${phase} ${JSON.stringify(safeDetails)}`);
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
  try {
    const settings = await loadSettings();
    const payload = await getStatePayload(settings, { lite: true });
    sendToRenderer("state:update", payload);
  } catch {
    appendRuntimeLog("State broadcast failed; the committed operation remains successful.");
  }
}

async function getStatePayload(settings, options = {}) {
  if (!statePayloadReader) {
    statePayloadReader = createResilientStateReader({
      readSnapshot: (options = {}) => buildStatePayload(settings, options),
      createFallbackSnapshot: buildStateUnavailablePayload,
      reportFailure: () => {
        appendRuntimeLog("State snapshot unavailable; serving the last complete snapshot.");
      },
    });
  }
  const payload = await statePayloadReader(options);
  if (options.forceResourceRefresh && payload?.codexResources?.pluginPage) {
    appendRuntimeLog(
      `[resource-flow] stage=getStatePayload apps=${payload.codexResources.pluginPage.summary?.apps ?? "unavailable"} app_ids=${(payload.codexResources.pluginPage.apps || []).map((item) => item.id).join(",")} snapshot=${payload.codexResources.pluginPage.snapshot?.state || "unknown"}`,
    );
  }
  return payload;
}

function buildStateUnavailablePayload() {
  return {
    rootDir: dataRootDir,
    appRootDir,
    appVersion: "",
    packaged: Boolean(app.isPackaged),
    mode: null,
    routerRunning: Boolean(routerProcess),
    configExists: false,
    models: [],
    providers: [],
    modelPresets: [],
    modelDirectory: { version: 1, providers: {} },
    modelCapabilityOverrides: {},
    selectedModelIds: [],
    modelReferenceStatus: {},
    customModels: [],
    imageGenerationOverrides: {},
    capabilityProviderConfig: {},
    imageProviderConfig: {},
    capabilityProviders: [],
    capabilityProviderGroups: [],
    stateDetailLoaded: false,
    capabilityExecutionHistory: [],
    imageGenerationHistory: [],
    configPackageSyncStatus: null,
    configPackageImportBackupStatus: null,
    secretStatus: {},
    desktopOptions: {},
    diagnostics: null,
    startupCheck: null,
    settingsDetailLoaded: false,
    configProfiles: [],
    codexBackups: [],
    codexResources: null,
    codexSessions: [],
    codexSessionTree: null,
    codexProjectRecoveryPlan: null,
    lastHealth,
    usageEvents: [],
    usageSummary: emptyUsageSummary(),
    usageBudgetAlerts: [],
    usageCostEstimate: emptyUsageCostEstimate(),
    legacyDataMigration,
    logs: logLines.slice(-300),
  };
}

async function buildStatePayload(settings, options = {}) {
  const lite = Boolean(options.lite);
  const includeSettingsDetail = !lite || Boolean(options.settingsDetail);
  const config = settings.readRouterConfig(dataRootDir);
  usageRoutes = config?.models || [];
  const desktopOptions = settings.loadDesktopOptions(dataRootDir);
  usageBudgets = desktopOptions.usageBudgets || {};
  const usageSummary = usageStore?.summary({ routes: config?.models || [] }) || emptyUsageSummary();
  const mode = settings.detectModeFromConfig(config);
  const diagnostics = settings.routerConfigDiagnostics(dataRootDir, config);
  const homeDir = desktopHomeDir();
  const codexSessionTree = lite ? null : settings.listCodexSessionTree({ homeDir, limit: SESSION_CENTER_LIMIT });
  const codexSessions = Array.isArray(codexSessionTree?.sessions)
    ? codexSessionTree.sessions
    : lite ? [] : settings.listCodexSessions({ homeDir, limit: SESSION_CENTER_LIMIT });
  const smokeResourceSnapshotPath = process.env.CODEXBRIDGE_DESKTOP_SMOKE === "1"
    ? String(process.env.CODEXBRIDGE_DESKTOP_SMOKE_RESOURCE_SNAPSHOT || "").trim()
    : "";
  const codexResourceSnapshots = lite
    ? null
    : smokeResourceSnapshotPath
      ? JSON.parse(fs.readFileSync(smokeResourceSnapshotPath, "utf8"))
      : await readCodexResourceSnapshotsRetained({
          forceRefresh: Boolean(options.forceResourceRefresh),
          desktopOptions,
          homeDir,
          rootDir: appRootDir,
        });
  const codexCliSnapshot = codexResourceSnapshots?.codexCliSnapshot || null;
  const codexPromptInputSnapshot = codexResourceSnapshots?.codexPromptInputSnapshot || null;
  const codexAppServerSnapshot = codexResourceSnapshots?.codexAppServerSnapshot || null;
  const codexResources = lite
    ? null
    : settings.listCodexResources({
        rootDir: appRootDir,
        homeDir,
        codexCliSnapshot,
        includeCodexCliSnapshot: true,
        codexPromptInputSnapshot,
        includeCodexPromptInputSnapshot: true,
        codexAppServerSnapshot,
        includeCodexAppServerSnapshot: true,
      });
  if (!lite && options.forceResourceRefresh) {
    const appItems = codexAppServerSnapshot?.apps?.items || [];
    appendRuntimeLog(
      `[resource-flow] stage=readCodexResourceSnapshots apps=${appItems.length} app_ids=${appItems.map((item) => item.id).join(",")} source=${codexAppServerSnapshot?.snapshotSource || "unavailable"} cached=${codexAppServerSnapshot?.cached === true} refreshed_at=${codexAppServerSnapshot?.authoritativeRefreshedAt || codexAppServerSnapshot?.refreshedAt || "unknown"}`,
    );
    appendRuntimeLog(
      `[resource-flow] stage=listCodexResources plugins=${codexResources?.pluginPage?.summary?.plugins ?? "unavailable"} apps=${codexResources?.pluginPage?.summary?.apps ?? "unavailable"} app_ids=${(codexResources?.pluginPage?.apps || []).map((item) => item.id).join(",")} mcp=${codexResources?.pluginPage?.summary?.mcpServers ?? "unavailable"} skills=${codexResources?.pluginPage?.summary?.skills ?? "unavailable"}`,
    );
  }
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
    modelReferenceStatus: settings.modelReferenceStatus(dataRootDir, mode),
    customModels: settings.readCustomModels(dataRootDir),
    imageGenerationOverrides: settings.readModelImageGenerationOverrides(dataRootDir),
    capabilityProviderConfig: settings.readCapabilityProviderConfig(dataRootDir),
    imageProviderConfig: settings.readImageProviderConfig(dataRootDir),
    capabilityProviders: settings.readCapabilityProviders(dataRootDir),
    capabilityProviderGroups: settings.readCapabilityProviderGroups(dataRootDir),
    stateDetailLoaded: !lite,
    capabilityExecutionHistory: lite
      ? []
      : settings.readCapabilityExecutionHistory(dataRootDir, { includeThumbnails: true }),
    imageGenerationHistory: lite
      ? []
      : settings.readImageGenerationHistory(dataRootDir, { includeThumbnails: true }),
    configPackageSyncStatus: settings.readConfigPackageSyncStatus(dataRootDir),
    configPackageImportBackupStatus: settings.readConfigPackageImportBackupStatus(dataRootDir),
    secretStatus: settings.secretStatus(dataRootDir),
    desktopOptions,
    diagnostics,
    startupCheck: lite
      ? null
      : settings.buildStartupCheck(dataRootDir, {
        appVersion: app.getVersion(),
        routerRunning: Boolean(routerProcess),
        lastHealth,
        config,
        releaseAssets: releaseAssetsForDesktopPreflight(settings),
        codexCliSnapshot,
        codexPromptInputSnapshot,
      }),
    settingsDetailLoaded: includeSettingsDetail,
    configProfiles: settings.loadConfigProfiles(dataRootDir),
    codexBackups: includeSettingsDetail ? settings.listCodexBackups() : [],
    codexResources,
    codexSessions,
    codexSessionTree,
    codexProjectRecoveryPlan: lite ? null : settings.codexProjectRecoveryPlan({ limit: SESSION_CENTER_LIMIT }),
    lastHealth,
    usageEvents: usageStore?.events() || [],
    usageSummary,
    usageBudgetAlerts: evaluateUsageBudgets(usageSummary, usageBudgets, { routes: config?.models || [] }),
    usageCostEstimate: estimateUsageCosts(usageSummary, usageBudgets, { routes: config?.models || [] }),
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
  const usageSummary = usageStore?.summary({ routes: usageRoutes }) || emptyUsageSummary();
  return {
    usageEvents: usageStore?.events() || [],
    usageSummary,
    usageBudgetAlerts: evaluateUsageBudgets(usageSummary, usageBudgets, { routes: usageRoutes }),
    usageCostEstimate: estimateUsageCosts(usageSummary, usageBudgets, { routes: usageRoutes }),
  };
}

function emptyUsageCostEstimate() {
  return {
    hasRates: false,
    calls: 0,
    tokens: 0,
    inputCost: 0,
    cacheCost: 0,
    outputCost: 0,
    totalCost: 0,
    global: null,
    routes: [],
    providers: [],
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
          "#capabilities",
          "#capabilitySummary",
          "#capabilityDiagnostics",
          "#capabilityProviderForm",
          "#stats",
          "#settings",
          "#routerPort",
          "#saveDesktopOptions",
          "#bypassSystemProxy",
          "#imageProviderForm",
          "#testImageProvider",
          "#imageProviderTestPrompt",
          "#imageGenerationHistory",
          "#exportConfigPackage",
          "#importConfigPackage",
          "#usageRange",
          "#usageChart",
          "#usageBudgetScope",
          "#usageBudgetTarget",
          "#resourceSummary",
          "#resourceList",
          "#resourceSearch",
          "#resourceStatusFilter",
          "#sessionList",
          "#recoverCodexProjects",
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
        const waitFor = (fn, timeoutMs = 5000, label = "UI render") => new Promise((resolve, reject) => {
          const started = Date.now();
          const timer = setInterval(() => {
            if (fn()) {
              clearInterval(timer);
              resolve(true);
              return;
            }
            if (Date.now() - started > timeoutMs) {
              clearInterval(timer);
              reject(new Error("Timed out waiting for " + label));
            }
          }, 80);
        });
        document.querySelector('[data-section="models"]').click();
        if (document.querySelector("#models").classList.contains("hidden")) {
          throw new Error("Models nav did not activate");
        }
        await waitFor(
          () => document.querySelectorAll("[data-provider-preview]").length >= 3,
          5000,
          "provider preview render"
        );
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
        if (!document.querySelector("#imageProviderForm")) {
          throw new Error("Image provider settings form missing");
        }
        if (!document.querySelector("#testImageProvider")) {
          throw new Error("Image provider test button missing");
        }
        if (!document.querySelector("#imageGenerationHistory")) {
          throw new Error("Image generation history panel missing");
        }
        if (!document.querySelector("#exportConfigPackage") || !document.querySelector("#importConfigPackage")) {
          throw new Error("Config package import/export controls missing");
        }
        document.querySelector('[data-section="capabilities"]').click();
        if (document.querySelector("#capabilities").classList.contains("hidden")) {
          throw new Error("Capabilities nav did not activate");
        }
        if (!document.querySelector("#capabilityDiagnostics")) {
          throw new Error("Capability diagnostics panel missing");
        }
        document.querySelector('[data-section="preflight"]').click();
        if (document.querySelector("#preflight").classList.contains("hidden")) {
          throw new Error("Preflight nav did not activate");
        }
        document.querySelector('[data-section="resources"]').click();
        if (document.querySelector("#resources").classList.contains("hidden")) {
          throw new Error("Resources nav did not activate");
        }
        if (!document.querySelector("#resourceSearch") || !document.querySelector("#resourceStatusFilter")) {
          throw new Error("Resource search or filter controls missing");
        }
        await waitFor(
          () => document.querySelectorAll("#resourceSummary article strong").length >= 5,
          60000,
          "resource summary initial render",
        );
        const resourceState = await window.codexBridge.getState({ lite: false });
        const rawResources = resourceState?.codexResources || {};
        const expectedResourceSummary = {
          ...(rawResources.summary || {}),
          ...(rawResources.pluginPage?.summary || {}),
        };
        const expectedResourceReadStatus = {
          ...(rawResources.readStatus || {}),
          ...(rawResources.pluginPage?.readStatus || {}),
        };
        const expectedResourceValues = ["plugins", "apps", "mcpServers", "skills", "marketplaces"].map((key) => {
          const value = expectedResourceSummary[key];
          const status = expectedResourceReadStatus[key];
          const readState = String(status?.state || "").trim().toLowerCase();
          if (
            value === null ||
            value === undefined ||
            status?.ok === false ||
            (readState && readState !== "ok")
          ) {
            return "无法读取";
          }
          const count = Number(value);
          return Number.isFinite(count) && count >= 0 ? String(count) : "无法读取";
        });
        try {
          await waitFor(() => {
            const values = Array.from(document.querySelectorAll("#resourceSummary article strong"))
              .map((node) => String(node.textContent || "").replace(/,/g, "").trim());
            return values.length >= 5 &&
              expectedResourceValues.every((expected, index) => values[index] === expected);
          }, 15000, "resource summary render");
        } catch (error) {
          const values = Array.from(document.querySelectorAll("#resourceSummary article strong"))
            .map((node) => String(node.textContent || "").replace(/,/g, "").trim());
          throw new Error(
            String(error?.message || "Resource summary did not render") +
            "; expected=" + expectedResourceValues.join("/") +
            " actual=" + values.join("/"),
          );
        }
        const resourceValues = Array.from(document.querySelectorAll("#resourceSummary article strong"))
          .slice(0, 5)
          .map((node) => String(node.textContent || "").replace(/,/g, "").trim());
        document.querySelector('[data-section="sessions"]').click();
        if (document.querySelector("#sessions").classList.contains("hidden")) {
          throw new Error("Sessions nav did not activate");
        }
        const allSessionsExportAttribute = "data-export-all-sessions";
        if (
          document.querySelector("#sessionList .session-overview") &&
          !document.querySelector("[" + allSessionsExportAttribute + "]")
        ) {
          throw new Error("All-session export control missing");
        }
        document.querySelector('[data-section="stats"]').click();
        if (document.querySelector("#stats").classList.contains("hidden")) {
          throw new Error("Stats nav did not activate");
        }
        if (!document.querySelector("#usageBudgetScope") || !document.querySelector("#usageBudgetTarget")) {
          throw new Error("Usage budget controls missing");
        }
        return {
          providers: document.querySelectorAll("[data-provider-preview]").length,
          resources: resourceValues.join("/"),
          resourceSummary: {
            plugins: resourceValues[0],
            apps: resourceValues[1],
            mcpServers: resourceValues[2],
            skills: resourceValues[3],
            marketplaces: resourceValues[4],
          },
          pluginIds: (rawResources.pluginPage?.plugins || []).map((item) => item.id),
          bundledPlugins: (rawResources.pluginPage?.plugins || []).filter((item) => item.pluginSource === "openai-bundled").length,
          remoteInstalledPlugins: (rawResources.pluginPage?.plugins || []).filter((item) => item.availability === "remote_installed").length,
          nav: document.querySelector(".nav-item.active")?.textContent?.trim()
        };
      })()
    `);
    const resourceScreenshotPath = String(process.env.CODEXBRIDGE_DESKTOP_SMOKE_RESOURCE_SCREENSHOT || "").trim();
    if (resourceScreenshotPath) {
      await mainWindow.webContents.executeJavaScript(`
        (async () => {
          document.querySelector('[data-section="resources"]').click();
          const deadline = Date.now() + 30000;
          while (Date.now() < deadline) {
            const values = Array.from(document.querySelectorAll("#resourceSummary article strong"))
              .slice(0, 4)
              .map((node) => String(node.textContent || "").replace(/,/g, "").trim());
            if (values.join("/") === ${JSON.stringify(result.resources.split("/").slice(0, 4).join("/"))}) {
              return true;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          throw new Error("Timed out waiting for resource screenshot summary");
        })()
      `);
      fs.mkdirSync(path.dirname(resourceScreenshotPath), { recursive: true });
      const image = await mainWindow.webContents.capturePage();
      fs.writeFileSync(resourceScreenshotPath, image.toPNG());
    }
    let historyRecoverySmoke = null;
    if (process.env.CODEXBRIDGE_DESKTOP_SMOKE_HISTORY_RECOVERY === "1") {
      historyRecoverySmoke = await mainWindow.webContents.executeJavaScript(`
        (async () => {
          const waitFor = (fn, timeoutMs = 30000, label = "history recovery") => new Promise((resolve, reject) => {
            const started = Date.now();
            const timer = setInterval(async () => {
              if (await fn()) {
                clearInterval(timer);
                resolve(true);
                return;
              }
              if (Date.now() - started > timeoutMs) {
                clearInterval(timer);
                reject(new Error("Timed out waiting for " + label));
              }
            }, 80);
          });
          document.querySelector('[data-section="sessions"]').click();
          document.querySelector("#recoverHistoryAccessSessions").click();
          await waitFor(
            () => Boolean(document.querySelector("[data-confirm-ok]")),
            30000,
            "history recovery confirmation",
          );
          document.querySelector("[data-confirm-ok]").click();
          let blocked = null;
          await waitFor(
            async () => {
              blocked = await window.codexBridge.historyRecoveryStatus();
              return blocked?.phase === "awaiting_manual_exit";
            },
            30000,
            "manual-exit state",
          );
          document.querySelector("#retryHistoryRecovery").click();
          let completed = null;
          await waitFor(
            async () => {
              completed = await window.codexBridge.historyRecoveryStatus();
              return completed?.phase === "restarted";
            },
            60000,
            "verified restart state",
          );
          await waitFor(
            () => document.querySelector("#historyRecoveryStatusPanel")?.classList?.contains("is-success") &&
              document.querySelector("#historyRecoveryInserted")?.textContent?.replace(/,/g, "").trim() === "128" &&
              document.querySelector("#historyRecoveryCatalog")?.textContent?.replace(/,/g, "").trim() === "129",
            30000,
            "verified recovery UI",
          );
          const directState = await window.codexBridge.getState({ lite: false });
          await waitFor(
            () => {
              const values = Array.from(document.querySelectorAll("#sessionList .session-overview span"))
                .slice(0, 4)
                .map((node) => String(node.textContent || "").replace(/[^0-9]/g, ""));
              return values[0] === "147" && values[1] === "129" && values[2] === "129" && values[3] === "129";
            },
            30000,
            "refreshed session summary",
          );
          const sessionSummaryValues = Array.from(document.querySelectorAll("#sessionList .session-overview span"))
            .slice(0, 4)
            .map((node) => String(node.textContent || "").replace(/[^0-9]/g, ""));
          return {
            blocked,
            completed,
            phaseText: document.querySelector("#historyRecoveryPhase")?.textContent || "",
            plannedText: document.querySelector("#historyRecoveryPlanned")?.textContent || "",
            insertedText: document.querySelector("#historyRecoveryInserted")?.textContent || "",
            catalogText: document.querySelector("#historyRecoveryCatalog")?.textContent || "",
            sidebarText: document.querySelector("#historyRecoverySidebar")?.textContent || "",
            backupText: document.querySelector("#historyRecoveryBackup")?.textContent || "",
            directSessionSummary: directState?.codexSessionTree?.summary || null,
            renderedSessionSummary: sessionSummaryValues,
            toastClass: document.querySelector("#toast")?.className || "",
          };
        })()
      `);
      const screenshotPath = String(process.env.CODEXBRIDGE_DESKTOP_SMOKE_SCREENSHOT || "").trim();
      if (screenshotPath) {
        fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
        const image = await mainWindow.webContents.capturePage();
        fs.writeFileSync(screenshotPath, image.toPNG());
      }
      console.log(`History recovery smoke passed: ${JSON.stringify(historyRecoverySmoke)}`);
    }
    let routerLifecycleSmoke = false;
    if (process.env.CODEXBRIDGE_DESKTOP_SMOKE_START_ROUTER === "1") {
      routerLifecycleSmoke = await mainWindow.webContents.executeJavaScript(`
        (async () => {
          const initial = await window.codexBridge.getState({ lite: true });
          if (initial?.desktopOptions?.duplicateRequestProtection !== false) {
            throw new Error("Legacy duplicate request protection was not migrated off");
          }
          let started = false;
          try {
            const startResult = await window.codexBridge.startRouter();
            if (startResult?.ok !== true) {
              const code = String(startResult?.error?.causeCode || "operation_failed");
              throw new Error("Router lifecycle smoke start failed: " + code);
            }
            started = true;
            const running = await window.codexBridge.getState({ lite: true });
            if (running?.routerRunning !== true) {
              throw new Error("Router lifecycle smoke did not publish running state");
            }
            return true;
          } finally {
            if (started) {
              await window.codexBridge.stopRouter();
              const stopped = await window.codexBridge.getState({ lite: true });
              if (stopped?.routerRunning !== false) {
                throw new Error("Router lifecycle smoke did not publish stopped state");
              }
            }
          }
        })()
      `);
    }
    if (smokeErrors.length) {
      console.error(`CodexBridge desktop smoke saw ${smokeErrors.length} renderer error(s).`);
      for (const error of smokeErrors) {
        console.error(error);
      }
      app.exit(1);
      return;
    }
    console.log(`CodexBridge desktop smoke loaded. providers=${result.providers} resources=${result.resources} nav=${result.nav}`);
    console.log(`Packaged resource smoke passed: ${JSON.stringify({
      resourceSummary: result.resourceSummary,
      pluginIds: result.pluginIds,
      bundledPlugins: result.bundledPlugins,
      remoteInstalledPlugins: result.remoteInstalledPlugins,
    })}`);
    if (routerLifecycleSmoke) {
      console.log("Router lifecycle smoke passed.");
    }
    app.quit();
  } catch (error) {
    console.error(formatError("Desktop smoke interaction failed", error));
    app.exit(1);
  }
}
