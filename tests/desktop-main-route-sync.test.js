import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainSource = fs.readFileSync(path.join(repoRoot, "desktop", "main.cjs"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const require = createRequire(import.meta.url);
const desktopCompatPath = path.join(repoRoot, "desktop", "openai-desktop-compat.cjs");

const ROUTE_MUTATION_HANDLERS = [
  "options:save",
  "models:saveSelection",
  "models:saveImageInput",
  "models:saveImageGeneration",
  "imageProviders:save",
  "imageProviders:remove",
  "capabilityProviders:save",
  "capabilityProviders:remove",
  "models:saveCapabilities",
  "models:resetCapabilities",
  "providers:refreshModels",
  "providers:save",
  "providers:reset",
  "logos:select",
  "customModel:save",
  "customModel:remove",
  "profiles:apply",
  "catalog:generate",
  "codex:apply",
  "codex:initialize",
  "configPackage:import",
  "configPackage:restoreLatestImportBackup",
];

test("mode selection delegates the verified transaction without legacy writes or direct publish", () => {
  const body = ipcHandlerBody("mode:select");
  assert.match(body, /\brunModeSelect\s*\(/);
  assert.match(body, /routerRunning:\s*Boolean\(routerProcess\)/);
  assert.match(body, /\brefreshRouterHealth\b/);
  assert.match(body, /\blocateCodexInstall\b/);
  assert.match(body, /\bgetStatePayload\b/);
  assert.match(body, /\bappendLog\b/);
  assert.match(
    mainSource,
    /preferredTargets[\s\S]*?target:\s*item\.executablePath,\s*source:\s*"running"/,
  );
  assert.doesNotMatch(body, /\bsaveSelection\s*\(/);
  assert.doesNotMatch(body, /\bsyncRouteStateAfterMutation\s*\(/);
  assert.doesNotMatch(body, /\bbroadcastState\s*\(/);
});

test("model and route mutation IPC handlers converge through one shared configuration transaction", () => {
  assert.match(mainSource, /async function commitConfigMutation\b/);

  for (const handlerName of ROUTE_MUTATION_HANDLERS) {
    const body = ipcHandlerBody(handlerName);
    if (handlerName === "customModel:save") {
      assert.match(body, /saveCustomModelFromIpc\s*\(/);
      continue;
    }
    assert.match(
      body,
      /\bcommitConfigMutation\s*\(/,
      `${handlerName} must call commitConfigMutation() for one staged commit`,
    );
    assert.doesNotMatch(body, /\bsyncRouteStateAfterMutation\s*\(/);
    assert.doesNotMatch(
      body,
      /\bbroadcastState\s*\(/,
      `${handlerName} must publish only through commitThenPublishConfigMutation`,
    );
  }
  assert.doesNotMatch(mainSource, /async function syncRouteStateAfterMutation\b/);
  assert.match(functionBody("saveCustomModelFromIpc"), /\bcommitConfigMutation\s*\(/);
  assert.match(mainSource, /commitThenPublishConfigMutation\s*\(/);
  assert.match(mainSource, /publish: options\.publish === false \? undefined : \(\) => broadcastState\(\)/);
});

test("model selection derives the current mode only after entering the shared transaction", () => {
  const body = ipcHandlerBody("models:saveSelection");
  assert.doesNotMatch(body, /readRouterConfig\s*\(/);
  assert.doesNotMatch(body, /detectModeFromConfig\s*\(/);
  assert.doesNotMatch(body, /selectedModelIds\s*,\s*mode\s*[,}]/);
});

test("model selection save returns one lightweight snapshot instead of blocking on full desktop scans", () => {
  const body = ipcHandlerBody("models:saveSelection");
  assert.match(
    body,
    /commitConfigMutation\([\s\S]*?"models:saveSelection"[\s\S]*?\{\s*publish:\s*false\s*\}/,
  );
  assert.match(body, /return getStatePayload\(settings, \{ lite: true \}\);/);
  assert.doesNotMatch(body, /return getStatePayload\(settings\);/);
});

test("custom model saves accept the legacy plural IPC channel", () => {
  assert.match(mainSource, /ipcMain\.handle\("customModels:save"/);
  const currentBody = ipcHandlerBody("customModel:save");
  const legacyBody = ipcHandlerBody("customModels:save");
  assert.match(currentBody, /saveCustomModelFromIpc\s*\(/);
  assert.match(legacyBody, /saveCustomModelFromIpc\s*\(/);
});

test("configuration mutation failures preserve phase and cause diagnostics across IPC", () => {
  const body = functionBody("commitConfigMutation");
  assert.match(body, /describeConfigMutationFailure/);
  assert.match(body, /failurePhase/);
  assert.match(body, /causeCode/);
});

test("config package exports capture resource snapshots and config under one exclusive lease", () => {
  for (const handlerName of ["configPackage:export", "configPackage:exportToSyncDir"]) {
    const body = ipcHandlerBody(handlerName);
    assert.match(
      body,
      /runSharedConfigExclusive\s*\(\s*\(\)\s*=>\s*\{[\s\S]*?loadDesktopOptions\(dataRootDir\)[\s\S]*?readCodexResourceSnapshots[\s\S]*?exportConfigPackage/,
      handlerName,
    );
  }
});

test("every config package import checks a bounded stable regular file before reading", () => {
  assert.match(mainSource, /require\("\.\/safe-import-file\.cjs"\)/);
  for (const handlerName of [
    "configPackage:importLatestFromSyncDir",
    "configPackage:import",
    "configPackage:restoreLatestImportBackup",
  ]) {
    const body = ipcHandlerBody(handlerName);
    assert.match(body, /readBoundedRegularUtf8File\s*\(/, handlerName);
    assert.doesNotMatch(body, /fs\.readFileSync\s*\(/, handlerName);
  }
});

test("profile saves defer configuration defaults to the transaction snapshot", () => {
  const body = ipcHandlerBody("profiles:save");
  assert.doesNotMatch(body, /readRouterConfig\s*\(/);
  assert.doesNotMatch(body, /detectModeFromConfig\s*\(/);
  assert.doesNotMatch(body, /readSelection\s*\(/);
  assert.doesNotMatch(body, /loadDesktopOptions\s*\(/);
});

test("deferred startup repairs managed Codex provider compatibility", () => {
  assert.match(mainSource, /repairManagedCodexCompatibilityOnStartup\(\)/);
  assert.match(
    mainSource,
    /settings\.managedCodexConfigCompatibilityPlan\s*\(/,
  );
  assert.match(
    mainSource,
    /commitConfigMutation\(settings, "startup:repair", \{\}, \{ publish: false \}\)/,
  );
});

test("pending configuration journals recover before the desktop window exposes mutation IPC", () => {
  assert.match(mainSource, /await recoverPendingConfigTransactions\(\)/);
  assert.match(mainSource, /recoverConfigTransactionsAtStartup\s*\(\s*\{/);
  assert.match(mainSource, /summarizeConfigRecoveryError\(error\)/);
  assert.match(mainSource, /config-recovery retry attempt=/);
  const recoveryIndex = mainSource.indexOf("await recoverPendingConfigTransactions()");
  const createWindowIndex = mainSource.indexOf("createWindow();", recoveryIndex);
  assert.ok(recoveryIndex >= 0 && createWindowIndex > recoveryIndex);
  assert.match(mainSource, /let configRecoveryComplete\s*=\s*false/);
  assert.match(
    mainSource,
    /await recoverPendingConfigTransactions\(\);[\s\S]*?configRecoveryComplete\s*=\s*true;[\s\S]*?createWindow\(\);/,
  );
  assert.match(
    mainSource,
    /function createWindow\(\)\s*\{\s*if \(!configRecoveryComplete\)\s*\{\s*return null;\s*\}/,
  );
  assert.match(
    mainSource,
    /function showMainWindow\(\)\s*\{\s*if \(!configRecoveryComplete\)\s*\{\s*return;\s*\}/,
  );
});

test("state snapshots keep slow desktop discovery outside the configuration transaction queue", () => {
  assert.match(
    mainSource,
    /createResilientStateReader\s*\(/,
  );
  assert.match(mainSource, /readSnapshot:\s*\(options = \{\}\) => buildStatePayload\(settings, options\)/);
  assert.doesNotMatch(
    mainSource,
    /readSnapshot:[\s\S]*?settings\.runSharedConfigExclusive\(\(\) =>[\s\S]*?buildStatePayload\(settings, options\)/,
  );
  assert.match(mainSource, /await runCodexResourceSnapshotWorker\s*\(/);
  assert.match(mainSource, /createFallbackSnapshot:\s*buildStateUnavailablePayload/);
  assert.match(mainSource, /reportFailure:[\s\S]*?appendRuntimeLog\(/);
  assert.match(mainSource, /async function buildStatePayload\(settings, options = \{\}\)/);
  assert.match(
    mainSource,
    /async function broadcastState\(\)[\s\S]*?await getStatePayload\(settings, \{ lite: true \}\)/,
  );
});

test("post-commit logging cannot turn a durable mutation into an IPC failure", () => {
  const body = functionBody("appendLog");
  assert.match(body, /try\s*\{/);
  assert.match(body, /catch\s*\{/);
  assert.match(body, /appendRuntimeLog\(/);
  assert.match(functionBody("sendToRenderer"), /try\s*\{[\s\S]*?catch\s*\{/);
  assert.match(functionBody("broadcastState"), /try\s*\{[\s\S]*?catch\s*\{/);
  assert.match(functionBody("refreshTrayMenu"), /try\s*\{[\s\S]*?tray\.setContextMenu[\s\S]*?catch\s*\{/);
  const secretsBody = ipcHandlerBody("secrets:save");
  assert.match(secretsBody, /return committed\.result\.secretStatus/);
  assert.doesNotMatch(secretsBody, /settings\.secretStatus\s*\(/);
  const providerResetBody = ipcHandlerBody("providers:reset");
  assert.match(providerResetBody, /committed\.result\.providerName/);
  assert.doesNotMatch(providerResetBody, /settings\.providerCatalog\s*\(/);
});

test("provider model refresh keeps its CAS fingerprint inside Main", () => {
  const body = ipcHandlerBody("providers:refreshModels");
  assert.match(body, /providerFingerprint:\s*_providerFingerprint/);
  assert.match(body, /result:\s*publicResult/);
  assert.doesNotMatch(body, /return\s*\{\s*result\s*,/);
});

test("resource mutations and automatic Router stop share the coordinator without whole-file restore", () => {
  assert.match(ipcHandlerBody("resource:setEnabled"), /setCodexResourceEnabledTransaction\s*\(/);
  for (const handlerName of [
    "resource:update",
    "resource:remove",
    "resource:refreshMarketplaces",
  ]) {
    assert.match(ipcHandlerBody(handlerName), /runSharedConfigExclusive\s*\(/, handlerName);
  }
  for (const [handlerName, operation] of [
    ["backups:restore", "restoreCodexConfigFromBackup"],
    ["codex:restore", "restoreCodexConfig"],
  ]) {
    const body = ipcHandlerBody(handlerName);
    assert.match(body, new RegExp(`await settings\\.${operation}\\s*\\(`), handlerName);
    assert.doesNotMatch(body, /runSharedConfigExclusive\s*\(/, handlerName);
  }
  const stopBody = ipcHandlerBody("router:stop");
  assert.match(stopBody, /stopRouterWithManagedConfigCleanup\s*\(/);
  assert.doesNotMatch(stopBody, /restoreCodexConfig\s*\(/);
  assert.match(mainSource, /async function stopRouterFromTray[\s\S]*?stopRouterWithManagedConfigCleanup\s*\(/);
});

test("history recovery IPC delegates a retryable two-phase coordinator", () => {
  const body = ipcHandlerBody("codex:recover-history");
  assert.match(mainSource, /import\("\.\/codex-history-recovery-flow\.mjs"\)/);
  assert.match(mainSource, /function loadCodexHistoryRecoveryFlow\b/);
  assert.match(body, /flow\.execute\s*\(\s*\{\s*manualExit/);
  assert.doesNotMatch(body, /applyCodexThreadCatalogRecovery|recoverCodexProjectsFromPlan/);
  assert.match(mainSource, /ipcMain\.handle\("codex:history-recovery-status"/);
  assert.match(mainSource, /state["'],\s*["']codex-history-recovery\.json/);
  assert.match(mainSource, /loadState:\s*\(\)\s*=>\s*readHistoryRecoveryState\(\)/);
  assert.match(mainSource, /saveState:\s*\(state\)\s*=>\s*writeHistoryRecoveryState\(state\)/);
});

test("history recovery exposes a read-only current-catalog preview IPC", () => {
  const body = ipcHandlerBody("codex:history-recovery-preview");
  assert.match(body, /flow\.prepare\s*\(/);
  assert.doesNotMatch(body, /stopOpenAIDesktopForSidebarRecovery|applyCodexThreadCatalogRecovery/);
});

test("Router start delegates one injectable lifecycle controller and publishes only final health", () => {
  assert.match(mainSource, /import\("\.\/router-lifecycle\.mjs"\)/);
  const controllerBody = functionBody("loadRouterLifecycleController");
  assert.match(controllerBody, /createRouterLifecycleController\s*\(/);
  assert.match(
    controllerBody,
    /commitConfigMutation\(\s*settings,\s*"router:start",\s*\{ mode \},\s*\{ publish: false \},?\s*\)/,
  );
  assert.match(controllerBody, /spawnRouter:\s*\(/);
  assert.match(controllerBody, /checkHealth:[\s\S]*?refreshRouterHealth\(/);
  assert.match(controllerBody, /publishReady:[\s\S]*?void broadcastState\(\)/);
  const publishReadyBody = controllerBody.slice(
    controllerBody.indexOf("publishReady:"),
    controllerBody.indexOf("publishStopped:"),
  );
  assert.doesNotMatch(publishReadyBody, /await broadcastState\(\)/);
  assert.match(controllerBody, /cleanupManagedConfig:[\s\S]*?removeManagedCodexConfigTransaction\(/);
  assert.match(controllerBody, /terminateProcess:[\s\S]*?terminateChildProcess\(/);
  assert.match(controllerBody, /onUnexpectedExit:[\s\S]*?scheduleRouterRestart\(/);

  const body = functionBody("startRouterProcess");
  assert.match(body, /return \(await loadRouterLifecycleController\(\)\)\.start\(options\);/);
  assert.doesNotMatch(body, /\bspawn\s*\(/);
  assert.doesNotMatch(body, /\bbroadcastState\s*\(/);
  assert.doesNotMatch(mainSource, /function waitForRouterProcessSpawn\b/);
});

test("Router start IPC returns a safe envelope and reports only bounded failure metadata", () => {
  assert.match(
    mainSource,
    /const \{ runRouterStartForIpc \} = require\("\.\/router-start-result\.cjs"\);/,
  );
  assert.match(
    mainSource,
    /const \{ classifyRouterProcessOutput \} = require\("\.\/router-start-diagnostics\.cjs"\);/,
  );
  const body = ipcHandlerBody("router:start");
  assert.match(
    body,
    /return runRouterStartForIpc\(\s*\(\) => startRouterProcess\(\),/,
  );
  assert.match(body, /\(\{ failurePhase, causeCode \}\) =>/);
  assert.match(body, /appendRuntimeLog\(/);
  assert.match(
    body,
    /appendLog\(`Router start failed phase=\$\{failurePhase\} cause=\$\{causeCode\}`\)/,
  );
  assert.doesNotMatch(body, /async \(\) => startRouterProcess\(\)/);
  assert.match(packageJson.scripts["test:desktop"], /tests\/desktop-router-start-result\.test\.js/);
  assert.match(packageJson.scripts["check:syntax"], /desktop\/router-start-result\.cjs/);
  assert.match(packageJson.scripts["check:syntax"], /tests\/desktop-router-start-result\.test\.js/);
  assert.match(mainSource, /child\.codexBridgeStartFailureCode\s*\|\|=\s*classifyRouterProcessOutput/);
});

test("IPC and tray Router stop delegate cleanup-first confirmed lifecycle stop", () => {
  const lifecycleBody = functionBody("stopRouterWithManagedConfigCleanup");
  assert.match(
    lifecycleBody,
    /cancelRouterRestartTimer\(\);[\s\S]*?return \(await loadRouterLifecycleController\(\)\)\.stop\(\{ source \}\);/,
  );
  assert.doesNotMatch(lifecycleBody, /\bkill\s*\(/);
  assert.match(ipcHandlerBody("router:stop"), /return stopRouterWithManagedConfigCleanup\(/);
  assert.match(functionBody("stopRouterFromTray"), /return stopRouterWithManagedConfigCleanup\(/);
});

test("confirmed Router stop logs managed configuration cleanup failures as warnings", () => {
  const controllerBody = functionBody("loadRouterLifecycleController");
  assert.match(controllerBody, /publishStopped:\s*async \(\{ cleanup, warning \}\) =>/);
  assert.match(controllerBody, /warning\?\.code === "managed_config_cleanup_failed"/);
  assert.match(controllerBody, /Router stop confirmed, but managed configuration cleanup failed/);
  assert.match(controllerBody, /publishStopped:[\s\S]*?void broadcastState\(\)/);
});

test("normal tray and update quit delegate late-safe cleanup without before-quit recursion", () => {
  const beforeQuit = eventListenerBody("before-quit");
  assert.match(beforeQuit, /if \(managedQuitReady\)/);
  assert.match(beforeQuit, /event\.preventDefault\(\)/);
  assert.match(beforeQuit, /requestManagedAppQuit\("before-quit"\)/);

  const quitBody = functionBody("requestManagedAppQuit");
  assert.match(quitBody, /^function requestManagedAppQuit\([^)]*\)\s*\{\s*cancelRouterRestartTimer\(\);/);
  assert.match(quitBody, /return \(await loadRouterLifecycleController\(\)\)\.quit\(\{ reason \}\);/);
  assert.doesNotMatch(quitBody, /\bkill\s*\(/);

  const controllerBody = functionBody("loadRouterLifecycleController");
  assert.match(controllerBody, /quitCleanupTimeoutMs:\s*MANAGED_QUIT_CLEANUP_TIMEOUT_MS/);
  assert.match(controllerBody, /onQuitCleanupTimeout:/);
  assert.match(controllerBody, /onQuitCleanupLateSuccess:/);
  assert.match(controllerBody, /onQuitReady:[\s\S]*?managedQuitReady = true/);
  assert.match(controllerBody, /quitApp:[\s\S]*?app\.quit\(\)/);

  const trayMenu = functionBody("refreshTrayMenu");
  assert.match(trayMenu, /label: "[^"]*CodexBridge"[\s\S]*?requestManagedAppQuit\("tray"\)/);
  const updateQuitBody = functionBody("quitAfterUpdateLaunch");
  assert.match(updateQuitBody, /requestManagedAppQuit\("update"\)/);
  assert.doesNotMatch(updateQuitBody, /app\.exit\s*\(/);
  assert.doesNotMatch(mainSource, /MANAGED_QUIT_FORCE_EXIT_MS/);
  assert.doesNotMatch(mainSource, /function awaitManagedQuitCleanup\b|function stopRouter\b/);
});

test("Router watchdog uses declared lifecycle state and every explicit shutdown cancels pending restart", () => {
  const watchdogBody = functionBody("scheduleRouterRestart");
  const controllerBody = functionBody("loadRouterLifecycleController");
  assert.doesNotMatch(mainSource, /\brouterStopRequested\b/);
  assert.match(watchdogBody, /if \(isQuitting \|\| routerProcess \|\| routerRestartTimer\)/);
  assert.match(watchdogBody, /if \(isQuitting \|\| routerProcess\)/);
  assert.match(
    controllerBody,
    /onUnexpectedExit:\s*async\s*\(\{ code, isCurrent \}\)[\s\S]*?await broadcastState\(\);[\s\S]*?if \(!isCurrent\(\)\)[\s\S]*?scheduleRouterRestart\(code\)/,
  );
  assert.match(functionBody("stopRouterWithManagedConfigCleanup"), /cancelRouterRestartTimer\(\)/);
  assert.match(functionBody("requestManagedAppQuit"), /cancelRouterRestartTimer\(\)/);
});

test("Router lifecycle publishes a defined stopped health snapshot", () => {
  const body = functionBody("stoppedRouterHealth");
  assert.match(body, /ok:\s*false/);
  assert.match(body, /status:\s*0/);
  assert.match(body, /models:\s*\[\]/);
  assert.match(body, /checkedAt:\s*new Date\(\)\.toISOString\(\)/);
});

test("desktop startup resumes a durable pending history recovery worker", () => {
  const startupBody = functionBody("scheduleDeferredStartupWork");
  assert.match(startupBody, /resumePendingCodexHistoryRecoveryOnStartup\(\)/);
  const workerBody = functionBody("resumePendingCodexHistoryRecoveryOnStartup");
  assert.match(workerBody, /flow\.status\(\)/);
  assert.match(workerBody, /awaiting_manual_exit/);
  assert.match(workerBody, /flow\.execute\(\{ manualExit: true \}\)/);
});

test("desktop scripts cover the Router lifecycle helper and its contract test", () => {
  assert.match(packageJson.scripts["test:desktop"], /tests\/desktop-router-lifecycle\.test\.js/);
  assert.match(packageJson.scripts["check:syntax"], /desktop\/router-lifecycle\.mjs/);
  assert.match(packageJson.scripts["check:syntax"], /tests\/desktop-router-lifecycle\.test\.js/);
});

test("desktop scripts keep bounded import reads inside the fixed verification gates", () => {
  assert.match(packageJson.scripts["test:desktop"], /tests\/desktop-safe-import-file\.test\.js/);
  assert.match(packageJson.scripts["check:syntax"], /desktop\/safe-import-file\.cjs/);
  assert.match(packageJson.scripts["check:syntax"], /tests\/desktop-safe-import-file\.test\.js/);
});

test("desktop main has no dead destructive Codex history sync logging path", () => {
  assert.doesNotMatch(mainSource, /appendHistorySyncLog/);
  assert.doesNotMatch(mainSource, /restored from Codex state backups/);
  assert.doesNotMatch(mainSource, /built-in OpenAI history provider/);
});

test("detailed resource refresh bypasses only the Codex resource snapshot cache", () => {
  assert.match(
    mainSource,
    /readCodexResourceSnapshotsRetained\s*\(\s*\{\s*forceRefresh:\s*Boolean\(options\.forceResourceRefresh\)[\s\S]*?desktopOptions/,
  );
  assert.match(mainSource, /retainCodexResourceSnapshots\(fresh, lastCodexResourceSnapshots\)/);
  assert.doesNotMatch(mainSource, /readCodex(?:CliResource|PromptInput)Snapshot\s*\(\s*\)/);
});

test("desktop verification includes the resource snapshot worker", () => {
  assert.match(packageJson.scripts["check:syntax"], /desktop\/resource-snapshot-worker\.cjs/);
});

test("desktop automatically refreshes ChatGPT resources when the resource page opens", () => {
  const rendererSource = fs.readFileSync(path.join(repoRoot, "desktop", "renderer", "app.js"), "utf8");
  assert.match(
    rendererSource,
    /ensureDetailedStateForSection[\s\S]*?sectionId === "resources"[\s\S]*?forceResourceRefresh:\s*true/,
  );
});

test("deferred startup never auto-launches ChatGPT projects or polls the session database", () => {
  const body = functionBody("scheduleDeferredStartupWork");
  assert.doesNotMatch(body, /autoRecoverCodexProjectsOnStartup\(\)/);
  assert.doesNotMatch(mainSource, /async function autoRecoverCodexProjectsOnStartup\b/);
  assert.doesNotMatch(mainSource, /let autoProjectRecoveryFinished\b/);
});

test("startup check reuses one shared CLI and prompt-input resource snapshot", () => {
  const body = ipcHandlerBody("startup:check");
  assert.match(body, /loadDesktopOptions\(dataRootDir\)/);
  assert.match(
    body,
    /readCodexResourceSnapshots\s*\(\s*\{\s*desktopOptions\s*\}\s*\)/,
  );
  assert.match(body, /codexCliSnapshot\s*,/);
  assert.match(body, /codexPromptInputSnapshot\s*,/);
  assert.doesNotMatch(body, /readCodex(?:CliResource|PromptInput)Snapshot\s*\(/);
  assert.doesNotMatch(body, /\bbroadcastState\s*\(/);
});

test("desktop smoke treats unreadable resource authorities as unknown instead of zero", () => {
  assert.match(mainSource, /rawResources\s*=\s*resourceState\?\.codexResources\s*\|\|\s*\{\}/);
  assert.match(mainSource, /expectedResourceReadStatus\s*=\s*\{[\s\S]*rawResources\.readStatus[\s\S]*rawResources\.pluginPage\?\.readStatus/);
  assert.match(mainSource, /return\s+"无法读取"/);
  assert.doesNotMatch(mainSource, /Number\(expectedResourceSummary\.(?:plugins|mcpServers|skills|marketplaces)\s*\|\|\s*0\)/);
});

test("desktop smoke verifies the ChatGPT plugin-page application count in rendered order", () => {
  assert.match(
    mainSource,
    /\["plugins",\s*"apps",\s*"mcpServers",\s*"skills",\s*"marketplaces"\]\.map/,
  );
  assert.match(mainSource, /values\.length\s*>=\s*5/);
  assert.match(mainSource, /\.slice\(0,\s*5\)/);
});

test("config package export and import preview preserve unknown Codex resource counts", () => {
  const exportBody = ipcHandlerBody("configPackage:export");
  assert.match(exportBody, /settings\.configPackageCodexResourceCount\(pkg\.codexResources\)/);
  assert.match(exportBody, /codexResourceReadStatus:\s*pkg\.codexResources\?\.readStatus/);
  assert.doesNotMatch(mainSource, /function configPackageCodexResourceCount\b/);
  assert.match(mainSource, /function configPackageImportPreviewResourceCount\b/);
  assert.doesNotMatch(mainSource, /preview\.codexResourceCount\s*\|\|\s*0/);
});

test("desktop restart safely classifies Codex, ChatGPT, Classic, and Bridge processes", () => {
  assert.equal(
    fs.existsSync(desktopCompatPath),
    true,
    "desktop restart compatibility must live in an executable pure helper",
  );
  const {
    DESKTOP_APP_IMAGE_NAMES,
    classifyOpenAIDesktopProcess,
  } = require(desktopCompatPath);

  assert.deepEqual(DESKTOP_APP_IMAGE_NAMES, ["ChatGPT.exe", "Codex.exe"]);
  assert.deepEqual(
    classifyOpenAIDesktopProcess({
      name: "ChatGPT.exe",
      processId: 41,
      executablePath: "C:\\Program Files\\OpenAI\\ChatGPT\\ChatGPT.exe",
      commandLine: '"C:\\Program Files\\OpenAI\\ChatGPT\\ChatGPT.exe" --type=browser',
    }),
    {
      brand: "ChatGPT",
      processId: 41,
      executablePath: "C:\\Program Files\\OpenAI\\ChatGPT\\ChatGPT.exe",
      commandLine: '"C:\\Program Files\\OpenAI\\ChatGPT\\ChatGPT.exe" --type=browser',
      recognized: true,
      safeToStop: true,
      reason: "verified_path",
    },
  );
  assert.equal(
    classifyOpenAIDesktopProcess({
      name: "ChatGPT.exe",
      processId: 42,
      executablePath: "C:\\Program Files\\ChatGPT Classic\\ChatGPT.exe",
      commandLine: '"C:\\Program Files\\ChatGPT Classic\\ChatGPT.exe"',
    }).reason,
    "excluded_variant",
  );
  assert.equal(
    classifyOpenAIDesktopProcess({
      name: "ChatGPT.exe",
      processId: 421,
      executablePath: "C:\\Program Files\\ChatGPT\\Classic\\ChatGPT.exe",
      commandLine: '"C:\\Program Files\\ChatGPT\\Classic\\ChatGPT.exe"',
    }).reason,
    "excluded_variant",
    "Classic remains excluded when its product words are split by path separators",
  );
  assert.equal(
    classifyOpenAIDesktopProcess({
      name: "CodexBridge.exe",
      processId: 43,
      executablePath: "C:\\Tools\\CodexBridge.exe",
    }).recognized,
    false,
  );
  assert.deepEqual(
    classifyOpenAIDesktopProcess({ name: "ChatGPT.exe", processId: 44 }),
    {
      brand: "ChatGPT",
      processId: 44,
      executablePath: "",
      commandLine: "",
      recognized: true,
      safeToStop: false,
      reason: "ambiguous_name_only",
    },
  );
  assert.equal(
    classifyOpenAIDesktopProcess({
      name: "ChatGPT.exe",
      processId: 441,
      commandLine: 'helper.exe --target "C:\\Program Files\\OpenAI\\ChatGPT\\ChatGPT.exe"',
    }).safeToStop,
    false,
    "an executable mentioned only in later arguments cannot verify process identity",
  );
  assert.equal(
    classifyOpenAIDesktopProcess({
      name: "ChatGPT.exe",
      processId: 442,
      commandLine: '"C:\\Program Files\\OpenAI\\ChatGPT\\ChatGPT.exe" --type=browser',
    }).safeToStop,
    true,
    "the first executable token can verify process identity",
  );
  assert.deepEqual(
    classifyOpenAIDesktopProcess({ name: "Codex.exe", processId: 45 }),
    {
      brand: "Codex",
      processId: 45,
      executablePath: "",
      commandLine: "",
      recognized: true,
      safeToStop: false,
      reason: "ambiguous_name_only",
    },
    "a numeric PID plus a generic Codex.exe image name is not enough to authorize termination",
  );
});

test("desktop launch target compatibility keeps explicit priority and excludes Classic and Bridge", () => {
  assert.equal(fs.existsSync(desktopCompatPath), true);
  const {
    canonicalSavedOpenAIDesktopTarget,
    isOpenAIDesktopLaunchTarget,
    openAIDesktopLaunchKind,
    openAIDesktopStorePackageFamily,
    openAIDesktopTargetFromShortcutResolution,
    prioritizeOpenAIDesktopCandidates,
    validatedOpenAIDesktopTargetFromShortcutResolution,
    windowsShortcutResolverInvocation,
  } = require(desktopCompatPath);
  assert.equal(typeof canonicalSavedOpenAIDesktopTarget, "function");
  assert.equal(typeof openAIDesktopLaunchKind, "function");
  assert.equal(typeof openAIDesktopStorePackageFamily, "function");
  assert.equal(typeof openAIDesktopTargetFromShortcutResolution, "function");
  assert.equal(typeof validatedOpenAIDesktopTargetFromShortcutResolution, "function");
  assert.equal(typeof windowsShortcutResolverInvocation, "function");

  assert.equal(isOpenAIDesktopLaunchTarget("C:\\Apps\\ChatGPT\\ChatGPT.exe"), true);
  assert.equal(isOpenAIDesktopLaunchTarget("C:\\Apps\\Codex\\Codex.exe"), true);
  assert.equal(
    isOpenAIDesktopLaunchTarget("C:\\Apps\\ChatGPT\\app\\resources\\codex.exe"),
    false,
    "the ChatGPT-bundled codex app-server helper is not a desktop launch target",
  );
  assert.equal(isOpenAIDesktopLaunchTarget("C:\\Menu\\ChatGPT.lnk"), true);
  assert.equal(isOpenAIDesktopLaunchTarget("shell:AppsFolder\\OpenAI.ChatGPT_2p2nqsd0c76g0!App"), true);
  assert.equal(isOpenAIDesktopLaunchTarget("shell:AppsFolder\\OpenAI.ChatGPT_untrusted!App"), false);
  assert.equal(isOpenAIDesktopLaunchTarget("shell:AppsFolder\\Evil.ChatGPT_evil!App"), false);
  assert.equal(isOpenAIDesktopLaunchTarget("C:\\Apps\\ChatGPT Classic\\ChatGPT.exe"), false);
  assert.equal(isOpenAIDesktopLaunchTarget("C:\\Apps\\ChatGPT\\Classic\\ChatGPT.exe"), false);
  assert.equal(isOpenAIDesktopLaunchTarget("C:\\Apps\\CodexBridge\\CodexBridge.exe"), false);
  assert.equal(isOpenAIDesktopLaunchTarget("C:\\Menu\\ChatGPT Classic.lnk"), false);
  assert.equal(isOpenAIDesktopLaunchTarget("shell:AppsFolder\\OpenAI.ChatGPT.Classic_123!App"), false);
  assert.equal(
    openAIDesktopStorePackageFamily("shell:AppsFolder\\OpenAI.ChatGPT_2p2nqsd0c76g0!App"),
    "OpenAI.ChatGPT_2p2nqsd0c76g0",
  );
  assert.equal(
    openAIDesktopStorePackageFamily("shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App"),
    "OpenAI.Codex_2p2nqsd0c76g0",
  );
  assert.equal(openAIDesktopStorePackageFamily("shell:AppsFolder\\Evil.ChatGPT_evil!App"), "");
  assert.equal(
    canonicalSavedOpenAIDesktopTarget({
      codexDesktopLaunchTarget: "C:\\Menu\\Codex.lnk",
      codexDesktopExe: "C:\\Old\\ChatGPT.exe",
    }),
    "C:\\Menu\\Codex.lnk",
    "the latest explicit launch target is canonical over a stale legacy exe field",
  );
  assert.equal(
    openAIDesktopTargetFromShortcutResolution({
      targetPath: "C:\\Program Files\\OpenAI\\ChatGPT\\ChatGPT.exe",
      arguments: "--background",
    }),
    "C:\\Program Files\\OpenAI\\ChatGPT\\ChatGPT.exe",
  );
  assert.equal(
    openAIDesktopTargetFromShortcutResolution({
      targetPath: "C:\\Windows\\explorer.exe",
      arguments: "shell:AppsFolder\\OpenAI.ChatGPT_2p2nqsd0c76g0!App",
    }),
    "shell:AppsFolder\\OpenAI.ChatGPT_2p2nqsd0c76g0!App",
  );
  assert.equal(
    openAIDesktopLaunchKind(openAIDesktopTargetFromShortcutResolution({
      targetPath: "C:\\Windows\\explorer.exe",
      arguments: "shell:AppsFolder\\OpenAI.ChatGPT_2p2nqsd0c76g0!App",
    })),
    "shell",
  );
  assert.equal(
    openAIDesktopLaunchKind(openAIDesktopTargetFromShortcutResolution({
      targetPath: "C:\\Program Files\\OpenAI\\ChatGPT\\ChatGPT.exe",
    })),
    "executable",
  );
  assert.equal(
    openAIDesktopTargetFromShortcutResolution({
      targetPath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      arguments: "https://chatgpt.com",
    }),
    "",
    "a Learn ChatGPT shortcut cannot become an app restart target",
  );
  assert.equal(
    openAIDesktopTargetFromShortcutResolution({
      targetPath: "C:\\Windows\\explorer.exe",
      arguments: "shell:AppsFolder\\OpenAI.ChatGPT.Classic_123!App",
    }),
    "",
  );
  const resolvedExecutable = "C:\\Program Files\\OpenAI\\ChatGPT\\ChatGPT.exe";
  assert.equal(
    validatedOpenAIDesktopTargetFromShortcutResolution(
      { targetPath: resolvedExecutable },
      { exists: (candidate) => candidate === resolvedExecutable },
    ),
    resolvedExecutable,
  );
  assert.equal(
    validatedOpenAIDesktopTargetFromShortcutResolution(
      { targetPath: "C:\\Missing\\ChatGPT.exe" },
      { exists: () => false },
    ),
    "",
    "a shortcut whose resolved executable was removed must not remain launchable",
  );
  assert.equal(
    validatedOpenAIDesktopTargetFromShortcutResolution({
      targetPath: "C:\\Windows\\explorer.exe",
      arguments: "shell:AppsFolder\\OpenAI.ChatGPT_2p2nqsd0c76g0!App",
    }),
    "",
    "an official Store identity is still stale until the package installation is confirmed",
  );
  assert.equal(
    validatedOpenAIDesktopTargetFromShortcutResolution(
      {
        targetPath: "C:\\Windows\\explorer.exe",
        arguments: "shell:AppsFolder\\OpenAI.ChatGPT_2p2nqsd0c76g0!App",
      },
      { storeInstalled: true },
    ),
    "shell:AppsFolder\\OpenAI.ChatGPT_2p2nqsd0c76g0!App",
    "an installed official Store shell target does not require a direct filesystem launch path",
  );
  for (const shortcutPath of [
    "C:\\Users\\Test User\\Start Menu\\ChatGPT.lnk",
    "C:\\用户\\桌面\\ChatGPT.lnk",
    "C:\\Users\\O'Brien\\Desktop\\Codex.lnk",
  ]) {
    const invocation = windowsShortcutResolverInvocation(shortcutPath, { SYSTEMROOT: "C:\\Windows" });
    assert.equal(invocation.env.CODEXBRIDGE_SHORTCUT_PATH, shortcutPath);
    assert.equal(invocation.args.includes(shortcutPath), false);
    assert.match(invocation.args.join(" "), /GetEnvironmentVariable/);
  }

  const ordered = prioritizeOpenAIDesktopCandidates([
    { target: "C:\\Path\\Codex.exe", source: "path" },
    { target: "shell:AppsFolder\\OpenAI.ChatGPT_2p2nqsd0c76g0!App", source: "shell" },
    { target: "C:\\Common\\Codex.exe", source: "common" },
    { target: "C:\\Common\\ChatGPT.exe", source: "common" },
    { target: "C:\\WindowsApps\\ChatGPT.exe", source: "restricted" },
    { target: "C:\\Saved\\Codex.exe", source: "saved" },
    { target: "C:\\Running\\Codex.exe", source: "running" },
    { target: "C:\\Running\\ChatGPT.exe", source: "running" },
    { target: "C:\\Menu\\ChatGPT.lnk", source: "shortcut" },
    { target: "C:\\Common\\ChatGPT.exe", source: "path" },
  ]);
  assert.deepEqual(
    ordered.map(({ target, source }) => [target, source]),
    [
      ["C:\\Saved\\Codex.exe", "saved"],
      ["C:\\Running\\ChatGPT.exe", "running"],
      ["C:\\Common\\ChatGPT.exe", "common"],
      ["C:\\Menu\\ChatGPT.lnk", "shortcut"],
      ["shell:AppsFolder\\OpenAI.ChatGPT_2p2nqsd0c76g0!App", "shell"],
      ["C:\\WindowsApps\\ChatGPT.exe", "restricted"],
      ["C:\\Running\\Codex.exe", "running"],
      ["C:\\Common\\Codex.exe", "common"],
      ["C:\\Path\\Codex.exe", "path"],
    ],
  );
  assert.equal(
    prioritizeOpenAIDesktopCandidates([
      { target: "C:\\Running\\Codex.exe", source: "running" },
      { target: "C:\\Common\\ChatGPT.exe", source: "common" },
    ])[0].target,
    "C:\\Common\\ChatGPT.exe",
    "automatic discovery must prefer the current ChatGPT product over a running legacy Codex",
  );
});

test("Windows shortcut resolver safely preserves spaces, Chinese, and apostrophes", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows shortcut fixture");
    return;
  }
  const { windowsShortcutResolverInvocation } = require(desktopCompatPath);
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-快捷方式-O'Brien-"));
  const targetPath = path.join(fixtureDir, "ChatGPT.exe");
  const shortcutPath = path.join(fixtureDir, "新版 ChatGPT's shortcut.lnk");
  t.after(() => {
    for (const filePath of [shortcutPath, targetPath]) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // The explicit fixture file may not have been created if setup failed.
      }
    }
    try {
      fs.rmdirSync(fixtureDir);
    } catch {
      // Keep the explicit fixture directory if it is unexpectedly non-empty.
    }
  });
  fs.writeFileSync(targetPath, "fixture", "utf8");
  execFileSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "$l=[Environment]::GetEnvironmentVariable('CODEXBRIDGE_TEST_LINK','Process'); $t=[Environment]::GetEnvironmentVariable('CODEXBRIDGE_TEST_TARGET','Process'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut($l); $s.TargetPath=$t; $s.Arguments='--background'; $s.Save()",
  ], {
    env: {
      ...process.env,
      CODEXBRIDGE_TEST_LINK: shortcutPath,
      CODEXBRIDGE_TEST_TARGET: targetPath,
    },
    windowsHide: true,
    stdio: "ignore",
  });
  const invocation = windowsShortcutResolverInvocation(shortcutPath, process.env);
  const output = execFileSync("powershell.exe", invocation.args, {
    env: invocation.env,
    encoding: "utf8",
    windowsHide: true,
  });
  const resolved = JSON.parse(output);
  assert.equal(fs.existsSync(resolved.targetPath), true);
  assert.equal(path.basename(resolved.targetPath), path.basename(targetPath));
  assert.equal(path.basename(path.dirname(resolved.targetPath)), path.basename(fixtureDir));
  assert.equal(resolved.arguments, "--background");
});

test("desktop command capture times out and terminates a stalled helper", async () => {
  assert.equal(fs.existsSync(desktopCompatPath), true);
  const { runCommandCaptureWithTimeout } = require(desktopCompatPath);
  assert.equal(typeof runCommandCaptureWithTimeout, "function");

  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  let killedWith = "";
  child.kill = (signal) => {
    killedWith = signal;
    return true;
  };
  const resultPromise = runCommandCaptureWithTimeout("powershell.exe", ["-NoProfile"], {
    spawnImpl: () => child,
    timeoutMs: 15,
  });
  child.stdout.emit("data", Buffer.from("partial", "utf8"));

  assert.deepEqual(await resultPromise, {
    ok: false,
    stdout: "partial",
    timedOut: true,
    exitCode: null,
  });
  assert.equal(killedWith, "SIGKILL");
});

test("detached desktop launch waits for spawn success and rejects startup errors", async () => {
  assert.equal(fs.existsSync(desktopCompatPath), true);
  const { spawnDetachedWithConfirmation } = require(desktopCompatPath);
  assert.equal(typeof spawnDetachedWithConfirmation, "function");

  const launchedChild = new EventEmitter();
  let unrefCount = 0;
  launchedChild.unref = () => {
    unrefCount += 1;
  };
  const launched = spawnDetachedWithConfirmation("ChatGPT.exe", [], {}, {
    spawnImpl: () => launchedChild,
  });
  launchedChild.emit("spawn");
  assert.deepEqual(await launched, { ok: true });
  assert.equal(unrefCount, 1);

  const failedChild = new EventEmitter();
  failedChild.unref = () => {};
  const failed = spawnDetachedWithConfirmation("ChatGPT.exe", [], {}, {
    spawnImpl: () => failedChild,
  });
  failedChild.emit("error", new Error("ENOENT"));
  await assert.rejects(failed, /ENOENT/);
  await assert.rejects(
    spawnDetachedWithConfirmation("ChatGPT.exe", [], {}, {
      spawnImpl: () => {
        throw new Error("EACCES");
      },
    }),
    /EACCES/,
  );
});

test("automatic project recovery waits for each ChatGPT project before launching the next", async () => {
  const { recoverOpenAIProjectsSequentially } = require(desktopCompatPath);
  assert.equal(typeof recoverOpenAIProjectsSequentially, "function");
  const launched = [];
  let releaseFirst;
  const firstActivated = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const recovery = recoverOpenAIProjectsSequentially([
    { path: "F:/one" },
    { path: "F:/two" },
  ], {
    launchRoot: async (root) => {
      launched.push(root.path);
    },
    waitForRootActive: async (root) => {
      if (root.path === "F:/one") {
        await firstActivated;
      }
      return true;
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(launched, ["F:/one"]);
  releaseFirst();
  const result = await recovery;
  assert.deepEqual(launched, ["F:/one", "F:/two"]);
  assert.equal(result.launched, 2);
});

test("desktop process stop summaries reject partial taskkill failures", () => {
  assert.equal(fs.existsSync(desktopCompatPath), true);
  const { summarizeOpenAIDesktopStopResults } = require(desktopCompatPath);
  assert.equal(typeof summarizeOpenAIDesktopStopResults, "function");
  assert.deepEqual(
    summarizeOpenAIDesktopStopResults(
      [61, 62],
      [{ ok: true, exitCode: 0 }, { ok: false, exitCode: 5 }],
    ),
    {
      ok: false,
      stopped: 1,
      skipped: 1,
      failedProcessIds: [62],
      reasons: ["taskkill_failed"],
    },
  );
});

test("desktop process stopping requires an exact trusted target and rejects multiple paths", () => {
  assert.equal(fs.existsSync(desktopCompatPath), true);
  const {
    authorizeOpenAIDesktopProcesses,
    classifyOpenAIDesktopProcess,
  } = require(desktopCompatPath);
  assert.equal(typeof authorizeOpenAIDesktopProcesses, "function");
  const modern = classifyOpenAIDesktopProcess({
    name: "ChatGPT.exe",
    processId: 51,
    executablePath: "C:\\Modern\\ChatGPT.exe",
  });
  assert.deepEqual(
    classifyOpenAIDesktopProcess({
      name: "codex.exe",
      processId: 50,
      executablePath: "C:\\Apps\\ChatGPT\\app\\resources\\codex.exe",
      commandLine: '"C:\\Apps\\ChatGPT\\app\\resources\\codex.exe" app-server',
    }),
    {
      brand: "Codex",
      processId: 50,
      executablePath: "C:\\Apps\\ChatGPT\\app\\resources\\codex.exe",
      commandLine: '"C:\\Apps\\ChatGPT\\app\\resources\\codex.exe" app-server',
      recognized: false,
      safeToStop: false,
      reason: "excluded_variant",
    },
  );
  const other = classifyOpenAIDesktopProcess({
    name: "ChatGPT.exe",
    processId: 52,
    executablePath: "D:\\Other\\ChatGPT.exe",
  });
  const store = classifyOpenAIDesktopProcess({
    name: "ChatGPT.exe",
    processId: 53,
    executablePath: "C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT_2.0.0.0_x64__2p2nqsd0c76g0\\ChatGPT.exe",
  });

  assert.equal(
    authorizeOpenAIDesktopProcesses([modern], [
      { target: "C:\\Modern\\ChatGPT.exe", source: "common" },
    ])[0].safeToStop,
    true,
  );
  const legacyCodex = classifyOpenAIDesktopProcess({
    name: "Codex.exe",
    processId: 55,
    executablePath: "C:\\Legacy\\Codex.exe",
  });
  assert.equal(
    authorizeOpenAIDesktopProcesses([legacyCodex], [
      { target: "C:\\Legacy\\Codex.exe", source: "saved" },
    ])[0].safeToStop,
    true,
  );
  assert.deepEqual(
    authorizeOpenAIDesktopProcesses([legacyCodex], [
      { target: "D:\\Other\\Codex.exe", source: "saved" },
    ])[0],
    {
      ...legacyCodex,
      safeToStop: false,
      reason: "untrusted_codex_path",
    },
  );
  assert.deepEqual(
    authorizeOpenAIDesktopProcesses([other], [
      { target: "C:\\Modern\\ChatGPT.exe", source: "common" },
    ])[0],
    {
      ...other,
      safeToStop: false,
      reason: "untrusted_chatgpt_path",
    },
  );
  assert.deepEqual(
    authorizeOpenAIDesktopProcesses([modern, other], [
      { target: "C:\\Modern\\ChatGPT.exe", source: "common" },
      { target: "D:\\Other\\ChatGPT.exe", source: "saved" },
    ]).map((item) => [item.safeToStop, item.reason]),
    [
      [true, "verified_path"],
      [true, "verified_path"],
    ],
    "multiple exact trusted upgrade paths are safe to stop; untrusted paths still fail below",
  );
  assert.equal(
    authorizeOpenAIDesktopProcesses([store], [
      { target: "shell:AppsFolder\\OpenAI.ChatGPT_2p2nqsd0c76g0!App", source: "shell" },
    ])[0].safeToStop,
    true,
    "a validated modern ChatGPT Store app entry can authorize its WindowsApps process path",
  );
  const fakeStore = classifyOpenAIDesktopProcess({
    name: "ChatGPT.exe",
    processId: 54,
    executablePath: "C:\\Program Files\\WindowsApps\\Evil.ChatGPT_2.0.0.0_x64__evil\\ChatGPT.exe",
  });
  assert.equal(
    authorizeOpenAIDesktopProcesses([fakeStore], [
      { target: "shell:AppsFolder\\Evil.ChatGPT_evil!App", source: "shell" },
    ])[0].safeToStop,
    false,
    "lookalike Store package families cannot authorize ChatGPT process termination",
  );
});

test("desktop process stopping trusts a structurally verified current ChatGPT unpacked release", () => {
  const {
    authorizeOpenAIDesktopProcesses,
    classifyOpenAIDesktopProcess,
  } = require(desktopCompatPath);
  const executablePath = "D:\\codex\\OpenAI.Codex_26.707.3748.0_x64\\OpenAI.Codex_26.707.3748.0_x64\\app\\ChatGPT.exe";
  const process = classifyOpenAIDesktopProcess({
    name: "ChatGPT.exe",
    processId: 56,
    executablePath,
  });
  const existing = new Set([
    executablePath.toLowerCase(),
    "D:\\codex\\OpenAI.Codex_26.707.3748.0_x64\\OpenAI.Codex_26.707.3748.0_x64\\app\\resources\\codex.exe".toLowerCase(),
    "D:\\codex\\OpenAI.Codex_26.707.3748.0_x64\\OpenAI.Codex_26.707.3748.0_x64\\app\\resources\\app.asar".toLowerCase(),
  ]);

  const [authorized] = authorizeOpenAIDesktopProcesses([process], [], {
    exists: (target) => existing.has(String(target).toLowerCase()),
  });

  assert.equal(authorized.safeToStop, true);
  assert.equal(authorized.reason, "verified_openai_codex_release");
});

test("restart planning stops only the selected desktop brand and ignores a stale other-brand process", () => {
  assert.equal(fs.existsSync(desktopCompatPath), true);
  const {
    buildOpenAIDesktopRestartPlan,
    classifyOpenAIDesktopProcess,
  } = require(desktopCompatPath);
  assert.equal(typeof buildOpenAIDesktopRestartPlan, "function");
  const processes = [
    classifyOpenAIDesktopProcess({
      name: "Codex.exe",
      processId: 71,
      executablePath: "C:\\Apps\\Codex\\Codex.exe",
    }),
    classifyOpenAIDesktopProcess({
      name: "ChatGPT.exe",
      processId: 72,
      executablePath: "C:\\Apps\\ChatGPT\\ChatGPT.exe",
    }),
  ];
  const plan = buildOpenAIDesktopRestartPlan(
    processes,
    [
      { target: "C:\\Apps\\Codex\\Codex.exe", source: "common" },
      { target: "C:\\Apps\\ChatGPT\\ChatGPT.exe", source: "common" },
    ],
    { isLaunchable: () => true },
  );

  assert.equal(plan.launchTarget, "C:\\Apps\\ChatGPT\\ChatGPT.exe");
  assert.equal(plan.brand, "ChatGPT");
  assert.deepEqual(plan.processesToStop.map((item) => item.processId), [72]);
  assert.deepEqual(plan.blockedReasons, []);
});

test("restart planning activates a trusted Store app through its shell target instead of the protected executable", () => {
  const {
    buildOpenAIDesktopRestartPlan,
    classifyOpenAIDesktopProcess,
  } = require(desktopCompatPath);
  const executablePath = "C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT_2.0.0.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe";
  const shellTarget = "shell:AppsFolder\\OpenAI.ChatGPT_2p2nqsd0c76g0!App";
  const process = classifyOpenAIDesktopProcess({
    name: "ChatGPT.exe",
    processId: 73,
    executablePath,
  });

  const plan = buildOpenAIDesktopRestartPlan(
    [process],
    [{ target: shellTarget, source: "shell" }],
    { isLaunchable: () => true },
  );

  assert.equal(plan.launchTarget, shellTarget);
  assert.equal(plan.brand, "ChatGPT");
  assert.deepEqual(plan.processesToStop.map((item) => item.processId), [73]);
});

test("restart planning never launches a protected Store executable directly when shell activation is unavailable", () => {
  const { buildOpenAIDesktopRestartPlan } = require(desktopCompatPath);
  const executablePath = "C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT_2.0.0.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe";

  const plan = buildOpenAIDesktopRestartPlan(
    [],
    [{ target: executablePath, source: "restricted" }],
    { isLaunchable: () => true },
  );

  assert.equal(plan.launchTarget, "");
  assert.equal(plan.brand, "");
});

test("mac desktop compatibility prefers ChatGPT and falls back to legacy Codex", () => {
  assert.equal(fs.existsSync(desktopCompatPath), true);
  const {
    macOpenAIDesktopCommandPlan,
    macOpenAIDesktopCandidates,
    isKnownMacOpenAIDesktopApp,
    selectMacOpenAIDesktopApp,
  } = require(desktopCompatPath);
  assert.equal(typeof macOpenAIDesktopCommandPlan, "function");
  assert.equal(typeof isKnownMacOpenAIDesktopApp, "function");
  const candidates = macOpenAIDesktopCandidates("/Users/tester");
  assert.deepEqual(
    candidates.map(({ appName, appPath }) => [appName, appPath]),
    [
      ["ChatGPT", "/Applications/ChatGPT.app"],
      ["ChatGPT", "/Users/tester/Applications/ChatGPT.app"],
      ["Codex", "/Applications/Codex.app"],
      ["Codex", "/Users/tester/Applications/Codex.app"],
    ],
  );
  assert.equal(
    selectMacOpenAIDesktopApp({
      homeDir: "/Users/tester",
      exists: (candidate) => candidate === "/Applications/ChatGPT.app" || candidate === "/Applications/Codex.app",
    }).appName,
    "ChatGPT",
  );
  assert.equal(
    selectMacOpenAIDesktopApp({
      homeDir: "/Users/tester",
      exists: (candidate) => candidate === "/Applications/Codex.app",
    }).appName,
    "Codex",
  );
  assert.deepEqual(
    selectMacOpenAIDesktopApp({
      homeDir: "/Users/tester",
      preferredTargets: ["/Volumes/Tools/ChatGPT.app"],
      exists: (candidate) => candidate === "/Volumes/Tools/ChatGPT.app",
    }),
    { appName: "ChatGPT", appPath: "/Volumes/Tools/ChatGPT.app" },
    "an explicitly selected non-standard app bundle remains restartable",
  );
  assert.equal(
    isKnownMacOpenAIDesktopApp(
      { appName: "ChatGPT", appPath: "/Applications/ChatGPT.app" },
      "/Users/tester",
    ),
    true,
  );
  assert.equal(
    isKnownMacOpenAIDesktopApp(
      { appName: "Codex", appPath: "/Users/tester/Applications/Codex.app" },
      "/Users/tester",
    ),
    true,
  );
  assert.equal(
    isKnownMacOpenAIDesktopApp(
      { appName: "ChatGPT", appPath: "/tmp/ChatGPT.app" },
      "/Users/tester",
    ),
    false,
  );
  assert.deepEqual(
    macOpenAIDesktopCommandPlan({ appName: "ChatGPT", appPath: "/Applications/ChatGPT.app" }),
    {
      quit: {
        command: "osascript",
        args: [
          "-e",
          'tell application "System Events" to set openAIDesktopIsRunning to exists process "ChatGPT"',
          "-e",
          'if openAIDesktopIsRunning then tell application "ChatGPT" to quit',
        ],
      },
      launch: { command: "open", args: ["/Applications/ChatGPT.app"] },
    },
  );
});

test("desktop main wires safe dual-brand restart without image-name killing", () => {
  assert.match(mainSource, /require\("\.\/openai-desktop-compat\.cjs"\)/);
  assert.match(mainSource, /Get-CimInstance Win32_Process/);
  assert.match(mainSource, /ChatGPT\.exe/);
  assert.match(mainSource, /Codex\.exe/);
  assert.match(mainSource, /item\.recognized && !item\.safeToStop/);
  assert.match(mainSource, /runCommandQuiet\("taskkill\.exe", \["\/PID", String\(processId\), "\/F"\]\)/);
  assert.doesNotMatch(mainSource, /taskkill\.exe[\s\S]{0,120}"\/IM"[\s\S]{0,120}"ChatGPT\.exe"/);
  assert.match(
    mainSource,
    /codexDesktopOpenProjectCandidates[\s\S]*?codexDesktopLaunchCandidateEntries[\s\S]*?openAIDesktopLaunchKind\(entry\.target\) === "executable"/,
  );
  assert.match(mainSource, /selectMacOpenAIDesktopApp/);
  assert.match(mainSource, /macOpenAIDesktopCommandPlan/);
  assert.match(mainSource, /runCommandCapture\(commandPlan\.quit\.command, commandPlan\.quit\.args\)/);
  assert.match(mainSource, /desktopApp\.appPath/);
  assert.match(mainSource, /validatedOpenAIDesktopTargetFromShortcutResolution/);
  assert.match(mainSource, /verifiedOpenAIDesktopShortcutLaunchTarget/);
  assert.match(mainSource, /authorizeOpenAIDesktopProcesses/);
  assert.match(mainSource, /buildOpenAIDesktopRestartPlan\([\s\S]*?isLaunchable:\s*isLaunchableCodexDesktopTarget/);
  assert.match(mainSource, /summarizeOpenAIDesktopStopResults/);
  assert.match(mainSource, /SHORTCUT_SCAN_MAX_(?:CANDIDATES|OPERATIONS|DURATION_MS)/);
  assert.match(mainSource, /SHORTCUT_RESOLVE_MAX_DURATION_MS/);
  assert.match(mainSource, /timeoutMs:\s*Math\.min\(SHORTCUT_RESOLVE_COMMAND_TIMEOUT_MS, remainingMs\)/);
  assert.match(mainSource, /codexDesktopStoreExecutableCandidates/);
  assert.match(mainSource, /CODEXBRIDGE_PACKAGE_FAMILY/);
  assert.match(mainSource, /Get-AppxPackage/);
  assert.match(mainSource, /openAIDesktopLaunchKind\(canonicalSavedTarget\) === "mac_app" && safeExists\(canonicalSavedTarget\)/);
  assert.match(mainSource, /launchCodexDesktopTarget/);
  assert.match(mainSource, /isShortcut \|\| isShellTarget[\s\S]*?explorer\.exe/);
  assert.match(
    mainSource,
    /const quitResult = await runCommandCapture\([\s\S]*?if \(!quitResult\.ok\)[\s\S]*?throw new Error[\s\S]*?const launchResult = await runCommandCapture\(commandPlan\.launch\.command[\s\S]*?if \(!launchResult\.ok\)/,
  );
});

function ipcHandlerBody(handlerName) {
  const marker = `ipcMain.handle("${handlerName}"`;
  const start = mainSource.indexOf(marker);
  assert.notEqual(start, -1, `${handlerName} handler not found`);
  const next = mainSource.indexOf("\nipcMain.handle(", start + marker.length);
  return mainSource.slice(start, next === -1 ? mainSource.length : next);
}

function functionBody(functionName) {
  const marker = `function ${functionName}(`;
  const start = mainSource.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} function not found`);
  const parametersEnd = mainSource.indexOf(")", start + marker.length);
  assert.notEqual(parametersEnd, -1, `${functionName} parameters not closed`);
  return balancedBlockFrom(start, mainSource.indexOf("{", parametersEnd));
}

function eventListenerBody(eventName) {
  const marker = `app.on("${eventName}"`;
  const start = mainSource.indexOf(marker);
  assert.notEqual(start, -1, `${eventName} listener not found`);
  return balancedBlockFrom(start);
}

function balancedBlockFrom(start, explicitOpen = -1) {
  const open = explicitOpen >= 0 ? explicitOpen : mainSource.indexOf("{", start);
  assert.notEqual(open, -1, "source block opening brace not found");
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = open; index < mainSource.length; index += 1) {
    const char = mainSource[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return mainSource.slice(start, index + 1);
      }
    }
  }
  assert.fail("source block closing brace not found");
}
