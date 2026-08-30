import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

import {
  prepareSoftwareManagerQuit,
  registerSoftwareManagerIpc,
} from "../desktop/software-manager/ipc.mjs";

const require = createRequire(import.meta.url);
const { createTrustedIpcRegistrar } = require("../desktop/window-security.cjs");

function snapshot() {
  return {
    platform: "win32",
    catalog: { skills: [{ id: "documents" }, { id: "spreadsheets" }] },
    skills: [{ componentId: "legacy-skill" }],
  };
}

function fixture({
  platform = "win32",
  decision = { allowQuit: true },
  selectResult = { installRootToken: "opaque_root_123456" },
  externalCancelResult = null,
} = {}) {
  const handlers = new Map();
  const trustedWebContents = { sendCalls: [], send(...args) { this.sendCalls.push(args); } };
  const registrar = createTrustedIpcRegistrar({
    handle(channel, handler) { handlers.set(channel, handler); },
  }, () => ({
    trustedWebContents,
    trustedRendererUrl: "file:///C:/CodexBridge/desktop/renderer/index.html",
  }));
  const calls = [];
  let listener;
  const quitReservation = {};
  const service = {
    getSnapshot: async () => { calls.push(["getSnapshot"]); return snapshot(); },
    refresh: async () => { calls.push(["refresh"]); return snapshot(); },
    startTask: async (request) => { calls.push(["startTask", request]); return { ok: true }; },
    cancelTask: () => { calls.push(["cancelTask"]); return { cancelled: true }; },
    prepareForQuit: () => { calls.push(["prepareForQuit"]); return decision; },
    beginQuit: async () => { calls.push(["beginQuit"]); return { ...decision, reservation: quitReservation }; },
    refreshQuit: async (reservation) => {
      calls.push(["refreshQuit", reservation]);
      return reservation === quitReservation ? { allowQuit: true } : { allowQuit: false, reason: "critical" };
    },
    releaseQuit: (reservation) => {
      calls.push(["releaseQuit", reservation]);
      return reservation === quitReservation;
    },
    subscribe: (next) => { listener = next; return () => { listener = null; }; },
  };
  let serviceLoads = 0;
  registerSoftwareManagerIpc({
    ipcMain: registrar,
    platform,
    getService: async () => { serviceLoads += 1; return service; },
    selectInstallRoot: async (selectedService) => {
      assert.equal(selectedService, service);
      calls.push(["selectInstallRoot"]);
      return selectResult;
    },
    sendEvent: (event) => trustedWebContents.send("softwareManager:event", event),
    cancelExternalTask: () => {
      calls.push(["cancelExternalTask"]);
      return externalCancelResult;
    },
  });
  const trustedEvent = {
    sender: trustedWebContents,
    senderFrame: { url: "file:///C:/CodexBridge/desktop/renderer/index.html#software-manager" },
  };
  const invoke = (channel, ...args) => handlers.get(channel)(trustedEvent, ...args);
  return {
    handlers, invoke, calls, service, trustedWebContents,
    get listener() { return listener; },
    get serviceLoads() { return serviceLoads; },
  };
}

test("registers only the fixed software-manager IPC surface and forwards events", async () => {
  const value = fixture();
  assert.deepEqual([...value.handlers.keys()].sort(), [
    "softwareManager:cancelTask",
    "softwareManager:getSnapshot",
    "softwareManager:refresh",
    "softwareManager:selectInstallRoot",
    "softwareManager:startTask",
  ]);
  assert.deepEqual(await value.invoke("softwareManager:getSnapshot"), snapshot());
  assert.deepEqual(await value.invoke("softwareManager:selectInstallRoot"), { installRootToken: "opaque_root_123456" });
  assert.deepEqual(await value.invoke("softwareManager:refresh"), snapshot());
  assert.deepEqual(await value.invoke("softwareManager:cancelTask"), { cancelled: true });
  value.listener({ type: "progress", percent: 30 });
  assert.deepEqual(value.trustedWebContents.sendCalls, [[
    "softwareManager:event", { type: "progress", percent: 30 },
  ]]);
});

test("software-manager cancel reaches a tracked external plugin task before the component service", async () => {
  const value = fixture({ externalCancelResult: { cancelled: true } });
  assert.deepEqual(await value.invoke("softwareManager:cancelTask"), { cancelled: true });
  assert.deepEqual(value.calls, [["cancelExternalTask"]]);
});

test("non-Windows rejects every software-manager IPC before creating the service", async () => {
  const value = fixture({ platform: "darwin" });
  for (const channel of value.handlers.keys()) {
    const args = channel === "softwareManager:startTask"
      ? [{ kind: "install", componentIds: ["chatgpt"], skillIds: [] }]
      : [];
    await assert.rejects(value.invoke(channel, ...args), /software_manager_platform_disabled/);
  }
  assert.equal(value.serviceLoads, 0);
});

test("trusted registrar rejects an untrusted software-manager sender", async () => {
  const value = fixture();
  const handler = value.handlers.get("softwareManager:getSnapshot");
  await assert.rejects(async () => handler({
    sender: {},
    senderFrame: { url: "file:///C:/CodexBridge/desktop/renderer/index.html" },
  }), /Untrusted IPC sender/);
  assert.equal(value.serviceLoads, 0);
});

test("startTask accepts only exact, bounded, duplicate-free ID payloads", async () => {
  const value = fixture();
  const valid = {
    kind: "install",
    componentIds: ["chatgpt", "v2rayn"],
    skillIds: ["documents", "legacy-skill"],
    installRootToken: "opaque_root_123456",
  };
  assert.deepEqual(await value.invoke("softwareManager:startTask", valid), { ok: true });
  assert.deepEqual(value.calls.at(-1), ["startTask", valid]);

  const invalid = [
    null,
    { kind: "execute", componentIds: ["chatgpt"], skillIds: [] },
    { kind: "install", componentIds: ["unknown"], skillIds: [] },
    { kind: "install", componentIds: ["chatgpt", "chatgpt"], skillIds: [] },
    { kind: "install", componentIds: [], skillIds: ["documents", "documents"] },
    { kind: "install", componentIds: [], skillIds: ["unknown-skill"] },
    { kind: "install", componentIds: ["chatgpt"], skillIds: [], installRoot: "C:\\attacker" },
    { kind: "install", componentIds: ["chatgpt"], skillIds: [], url: "https://attacker.example" },
    { kind: "install", componentIds: ["chatgpt"], skillIds: [], command: "calc.exe" },
    { kind: "install", componentIds: ["chatgpt"], skillIds: [], installRootToken: "C:\\raw-path" },
    { kind: "install", componentIds: Array.from({ length: 65 }, (_, i) => i % 3 === 0 ? "chatgpt" : i % 3 === 1 ? "v2rayn" : "git"), skillIds: [] },
    { kind: "install", componentIds: [], skillIds: Array.from({ length: 65 }, (_, i) => `skill-${i}`) },
  ];
  for (const payload of invalid) {
    await assert.rejects(value.invoke("softwareManager:startTask", payload), /software_manager_payload_rejected/);
  }
});

test("zero-argument IPC rejects renderer payload smuggling", async () => {
  const value = fixture();
  for (const channel of [
    "softwareManager:getSnapshot", "softwareManager:selectInstallRoot",
    "softwareManager:refresh", "softwareManager:cancelTask",
  ]) {
    await assert.rejects(value.invoke(channel, { path: "C:\\attacker" }), /software_manager_payload_rejected/);
  }
});

test("directory selection returns only a cancelled flag or one opaque token", async () => {
  const leaked = fixture({
    selectResult: { installRootToken: "opaque_root_123456", path: "C:\\leaked" },
  });
  await assert.rejects(
    leaked.invoke("softwareManager:selectInstallRoot"),
    /software_manager_response_invalid/,
  );
  const cancelled = fixture({ selectResult: { cancelled: true } });
  assert.deepEqual(await cancelled.invoke("softwareManager:selectInstallRoot"), { cancelled: true });
});

test("true quit awaits the atomic service quit reservation before returning allow", async () => {
  const order = [];
  const reservation = {};
  const service = {
    beginQuit: async () => {
      order.push("gate:start"); await Promise.resolve(); order.push("gate:end");
      return { allowQuit: true, reservation };
    },
    refreshQuit: async () => ({ allowQuit: true }),
    releaseQuit: (value) => { order.push("release"); return value === reservation; },
  };
  const result = await prepareSoftwareManagerQuit({ platform: "win32", getService: async () => service });
  assert.equal(result.allowQuit, true);
  assert.equal(typeof result.releaseReservation, "function");
  assert.deepEqual(order, ["gate:start", "gate:end"]);
  assert.equal(result.releaseReservation(), true);
  assert.deepEqual(order, ["gate:start", "gate:end", "release"]);
});

test("critical true quit is blocked and cancellable true quit has explicit background/cancel choices", async () => {
  const notices = [];
  const critical = fixture({ decision: { allowQuit: false, reason: "critical" } });
  assert.deepEqual(await prepareSoftwareManagerQuit({
    platform: "win32",
    getService: async () => critical.service,
    showCritical: async (reason) => { notices.push(reason); },
  }), { allowQuit: false, reason: "critical" });
  assert.deepEqual(notices, ["critical"]);
  assert.equal(critical.calls.some(([name]) => name === "releaseQuit"), true);

  const background = fixture({ decision: { allowQuit: false, reason: "running", canCancel: true } });
  assert.deepEqual(await prepareSoftwareManagerQuit({
    platform: "win32",
    getService: async () => background.service,
    confirmRunning: async () => "background",
  }), { allowQuit: false, reason: "background" });
  assert.equal(background.calls.some(([name]) => name === "cancelTask"), false);
  assert.equal(background.calls.some(([name]) => name === "releaseQuit"), true);

  const cancellableService = {
    getSnapshot: async () => ({}),
    beginQuit: async () => ({
      allowQuit: false, reason: "running", canCancel: true, reservation: cancellableService.reservation,
    }),
    refreshQuit: async () => ({ allowQuit: true }),
    cancelTask: () => ({ cancelled: true }),
    reservation: {},
    releaseQuit: () => true,
  };
  const cancelled = await prepareSoftwareManagerQuit({
    platform: "win32",
    getService: async () => cancellableService,
    confirmRunning: async () => "cancel-and-quit",
    waitForTask: async () => {},
  });
  assert.equal(cancelled.allowQuit, true);
  assert.equal(typeof cancelled.releaseReservation, "function");
});

test("quit UI failures release the atomic reservation instead of permanently blocking tasks", async () => {
  const value = fixture({ decision: { allowQuit: false, reason: "critical" } });
  await assert.rejects(
    prepareSoftwareManagerQuit({
      platform: "win32",
      getService: async () => value.service,
      showCritical: async () => { throw new Error("dialog failed"); },
    }),
    /dialog failed/,
  );
  assert.equal(value.calls.filter(([name]) => name === "releaseQuit").length, 1);
});

test("main coalesces the entire software decision and Router quit and preserves watchdog on blocked exits", () => {
  const mainSource = require("node:fs").readFileSync(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  const request = mainSource.match(/function requestManagedAppQuit\([^)]*\)[\s\S]*?\n\}/u)?.[0] ?? "";
  const run = mainSource.match(/async function runManagedAppQuit\([^)]*\)[\s\S]*?\n\}/u)?.[0] ?? "";
  assert.match(mainSource, /let managedAppQuitPromise = null/u);
  assert.match(request, /if \(managedAppQuitPromise\)\s*\{\s*return managedAppQuitPromise/u);
  assert.match(request, /managedAppQuitPromise = tracked/u);
  assert.match(request, /finally/u);
  const decisionIndex = run.indexOf("softwareDecision.allowQuit");
  const timerIndex = run.lastIndexOf("cancelRouterRestartTimer()");
  const routerIndex = run.indexOf("loadRouterLifecycleController");
  assert.equal(decisionIndex >= 0 && timerIndex > decisionIndex && routerIndex > timerIndex, true);
  assert.match(run, /releaseReservation/u);
});

test("two simultaneous main quit requests execute one shared software and Router flow", async () => {
  const mainSource = require("node:fs").readFileSync(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  const request = mainSource.match(/function requestManagedAppQuit\([^)]*\)[\s\S]*?\n\}/u)?.[0] ?? "";
  let resolveRun;
  let runs = 0;
  const runManagedAppQuit = async () => {
    runs += 1;
    await new Promise((resolve) => { resolveRun = resolve; });
    return { ok: true };
  };
  const create = new Function(
    "runManagedAppQuit",
    `let managedAppQuitPromise = null; ${request}; return requestManagedAppQuit;`,
  );
  const requestQuit = create(runManagedAppQuit);
  const first = requestQuit("tray");
  const second = requestQuit("before-quit");
  assert.equal(first, second);
  assert.equal(runs, 1);
  resolveRun();
  await first;
  const third = requestQuit("update");
  assert.equal(runs, 2);
  resolveRun();
  await third;
});

test("closing a window remains hide-to-tray and does not become a task cancellation path", () => {
  const mainSource = require("node:fs").readFileSync(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  const closeHandler = mainSource.match(/mainWindow\.on\("close",[\s\S]*?\n  \}\);/u)?.[0] ?? "";
  assert.match(closeHandler, /event\.preventDefault\(\)/u);
  assert.match(closeHandler, /mainWindow\.hide\(\)/u);
  assert.doesNotMatch(closeHandler, /cancelTask|softwareManager/u);
});

test("main delegates Windows runtime construction and recovers offline before renderer creation", () => {
  const mainSource = require("node:fs").readFileSync(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  const runtime = mainSource.match(/async function createSoftwareManagerRuntimeService\(\)[\s\S]*?\n\}/u)?.[0] ?? "";
  assert.match(runtime, /process\.platform !== "win32"[\s\S]*?import\("\.\/software-manager\/runtime-factory\.mjs"\)/u);
  assert.match(runtime, /createProductionSoftwareManagerService\(\{/u);
  for (const dependency of [
    "platform", "dataRoot", "homeDir", "defaultInstallRoot", "getDesktopPath", "env", "electronShell",
    "fetchImpl", "execFile", "spawn", "publicKeyPem", "koffi",
  ]) assert.match(runtime, new RegExp(`\\b${dependency}\\s*:`, "u"));
  assert.match(runtime, /const softwareHomeDir = desktopHomeDir\(\)/u);
  assert.match(runtime, /homeDir:\s*softwareHomeDir/u);
  assert.match(runtime, /defaultInstallRoot:\s*smokeDefaultInstallRoot\s*\|\|\s*path\.join\(localAppData, "CBApps"\)/u);
  assert.match(runtime, /CODEXBRIDGE_DESKTOP_SMOKE_SOFTWARE_MANAGER_OFFLINE/u);
  assert.doesNotMatch(mainSource, /softwareManagerUnavailableAdapter|software_manager_runtime_not_provisioned/u);
  const startupRecovery = mainSource.indexOf("runtime.recoverOffline()");
  const createWindow = mainSource.indexOf("createWindow();", startupRecovery);
  assert.equal(startupRecovery > 0 && createWindow > startupRecovery, true);
});

test("software-manager runtime failure degrades only that feature and recovery remains retryable", () => {
  const mainSource = require("node:fs").readFileSync(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  const startup = mainSource.match(/app\.whenReady\(\)\.then\(async \(\) => \{[\s\S]*?\n\}\);\n\napp\.on\("before-quit"/u)?.[0] ?? "";
  const recovery = startup.indexOf("runtime.recoverOffline()");
  const construction = startup.lastIndexOf("runtime = await getSoftwareManagerRuntime()", recovery);
  const constructionCatch = startup.indexOf("catch (error)", construction);
  const constructionCatchEnd = startup.indexOf("\n    }", constructionCatch);
  const recoveryCatch = startup.indexOf("catch (error)", recovery);
  const recoveryComplete = startup.indexOf("configRecoveryComplete = true;", recovery);
  const createWindow = startup.indexOf("createWindow();", recovery);
  assert.equal(
    construction >= 0 && constructionCatch > construction && recovery >= 0
      && recoveryCatch > recovery && recoveryComplete > recoveryCatch && createWindow > recoveryComplete,
    true,
  );
  const recoveryCatchEnd = startup.indexOf("\n    }", recoveryCatch);
  const constructionCatchBody = startup.slice(constructionCatch, constructionCatchEnd);
  const catchBody = startup.slice(recoveryCatch, recoveryCatchEnd);
  assert.match(constructionCatchBody, /appendRuntimeLog\(formatError\("softwareManagerStartup", error\)\)/u);
  assert.match(constructionCatchBody, /softwareManagerStartupFailure\s*=\s*error/u);
  assert.match(catchBody, /appendRuntimeLog\(formatError\("softwareManagerRecovery", error\)\)/u);
  assert.doesNotMatch(catchBody, /softwareManagerStartupFailure\s*=\s*error/u);
  assert.doesNotMatch(catchBody, /app\.quit\(\)|return;/u);
  assert.doesNotMatch(catchBody, /configRecoveryComplete = true/u);
  assert.equal((startup.match(/configRecoveryComplete = true;/gu) ?? []).length, 1);
  assert.doesNotMatch(startup.slice(recovery, createWindow), /\.refresh\(|\bfetch\s*\(/u);
});

test("main process spawn adapter exposes bounded start, completion, and cancellation evidence", async () => {
  const mainSource = require("node:fs").readFileSync(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  const adapterSource = mainSource.match(/function spawnSoftwareManagerProcess\([^)]*\) \{[\s\S]*?\n\}/u)?.[0] ?? "";
  const child = new EventEmitter();
  Object.assign(child, {
    pid: 321,
    exitCode: null,
    killed: false,
    stdout: { pipe() {} },
    stderr: { async *[Symbol.asyncIterator]() {} },
    kill() { this.killed = true; },
    unref() {},
  });
  const create = new Function("spawn", `${adapterSource}; return spawnSoftwareManagerProcess;`);
  const spawnProcess = create(() => child);
  const handle = spawnProcess("C:\\Program Files\\App\\app.exe", [], {});
  assert.equal(handle, child);
  assert.equal(typeof handle.started?.then, "function");
  assert.equal(typeof handle.completed?.then, "function");
  assert.equal(typeof handle.cancel, "function");
  child.emit("spawn");
  await handle.started;
  handle.cancel();
  assert.equal(child.killed, true);
  child.emit("close", 0, null);
  assert.deepEqual(await handle.completed, { exitCode: 0, signal: null });

  const failedChild = new EventEmitter();
  Object.assign(failedChild, {
    pid: 654,
    exitCode: null,
    killed: false,
    stdout: { pipe() {} },
    stderr: { async *[Symbol.asyncIterator]() {} },
    kill() { this.killed = true; },
    unref() {},
  });
  const spawnFailedProcess = create(() => failedChild);
  const failedHandle = spawnFailedProcess("C:\\Program Files\\App\\app.exe", [], {});
  const processError = new Error("spawn aborted");
  let completionSettled = false;
  failedHandle.completed.then(
    () => { completionSettled = true; },
    () => { completionSettled = true; },
  );
  failedChild.emit("error", processError);
  await assert.rejects(failedHandle.started, (error) => error === processError);
  await Promise.resolve();
  assert.equal(completionSettled, false);
  failedChild.emit("close", null, "SIGTERM");
  await assert.rejects(failedHandle.completed, (error) => error === processError);
  assert.equal(completionSettled, true);
  assert.match(adapterSource, /started\.catch\(\(\) => \{\}\)/u);
  assert.match(adapterSource, /completed\.catch\(\(\) => \{\}\)/u);
});

test("main execFile adapter adds an explicit success exit code and preserves failures", async () => {
  const mainSource = require("node:fs").readFileSync(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  const adapterSource = mainSource.match(/function execSoftwareManagerFile\([^)]*\) \{[\s\S]*?\n\}/u)?.[0] ?? "";
  let callback;
  const execFileCallback = (_file, _args, _options, done) => { callback = done; };
  const create = new Function("execFileCallback", `${adapterSource}; return execSoftwareManagerFile;`);
  const execFile = create(execFileCallback);

  const succeeded = execFile("C:\\Program Files\\App\\app.exe", ["--version"], {});
  callback(null, "version 1.2.3", "");
  assert.deepEqual(await succeeded, { exitCode: 0, stdout: "version 1.2.3", stderr: "" });

  const failure = Object.assign(new Error("failed"), { code: 7, stdout: "", stderr: "bad" });
  const rejected = execFile("C:\\Program Files\\App\\app.exe", [], {});
  callback(failure, "", "bad");
  await assert.rejects(rejected, (error) => error === failure && error.exitCode === 7);
});
