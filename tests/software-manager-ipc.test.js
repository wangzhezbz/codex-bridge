import assert from "node:assert/strict";
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
  const service = {
    getSnapshot: async () => { calls.push(["getSnapshot"]); return snapshot(); },
    refresh: async () => { calls.push(["refresh"]); return snapshot(); },
    startTask: async (request) => { calls.push(["startTask", request]); return { ok: true }; },
    cancelTask: () => { calls.push(["cancelTask"]); return { cancelled: true }; },
    prepareForQuit: () => { calls.push(["prepareForQuit"]); return decision; },
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

test("true quit awaits the service refresh/recovery gate before synchronous prepareForQuit", async () => {
  const order = [];
  const service = {
    getSnapshot: async () => { order.push("gate:start"); await Promise.resolve(); order.push("gate:end"); },
    prepareForQuit: () => { order.push("prepare"); return { allowQuit: true }; },
  };
  assert.deepEqual(await prepareSoftwareManagerQuit({ platform: "win32", getService: async () => service }), {
    allowQuit: true,
  });
  assert.deepEqual(order, ["gate:start", "gate:end", "prepare"]);
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

  const background = fixture({ decision: { allowQuit: false, reason: "running", canCancel: true } });
  assert.deepEqual(await prepareSoftwareManagerQuit({
    platform: "win32",
    getService: async () => background.service,
    confirmRunning: async () => "background",
  }), { allowQuit: false, reason: "background" });
  assert.equal(background.calls.some(([name]) => name === "cancelTask"), false);

  let prepared = 0;
  const cancellableService = {
    getSnapshot: async () => ({}),
    prepareForQuit: () => (++prepared === 1
      ? { allowQuit: false, reason: "running", canCancel: true }
      : { allowQuit: true }),
    cancelTask: () => ({ cancelled: true }),
  };
  assert.deepEqual(await prepareSoftwareManagerQuit({
    platform: "win32",
    getService: async () => cancellableService,
    confirmRunning: async () => "cancel-and-quit",
    waitForTask: async () => {},
  }), { allowQuit: true });
});

test("closing a window remains hide-to-tray and does not become a task cancellation path", () => {
  const mainSource = require("node:fs").readFileSync(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  const closeHandler = mainSource.match(/mainWindow\.on\("close",[\s\S]*?\n  \}\);/u)?.[0] ?? "";
  assert.match(closeHandler, /event\.preventDefault\(\)/u);
  assert.match(closeHandler, /mainWindow\.hide\(\)/u);
  assert.doesNotMatch(closeHandler, /cancelTask|softwareManager/u);
});

test("production bootstrap is explicitly offline and not provisioned instead of faking task success", () => {
  const mainSource = require("node:fs").readFileSync(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  const runtime = mainSource.match(/async function createSoftwareManagerRuntimeService\(\)[\s\S]*?\n\}/u)?.[0] ?? "";
  assert.match(mainSource, /software_manager_runtime_not_provisioned/u);
  assert.match(runtime, /getCurrent:\s*async \(\) => null/u);
  assert.match(runtime, /refresh:\s*async \(\) => null/u);
  assert.doesNotMatch(runtime, /status:\s*["']succeeded["']/u);
  const startupRecovery = mainSource.indexOf("getSoftwareManagerService()).recoverPending()");
  const createWindow = mainSource.indexOf("createWindow();", startupRecovery);
  assert.equal(startupRecovery > 0 && createWindow > startupRecovery, true);
});
