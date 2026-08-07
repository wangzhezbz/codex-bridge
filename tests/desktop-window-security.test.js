import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
import fs from "node:fs";

const require = createRequire(import.meta.url);
let security = {};
try {
  security = require("../desktop/window-security.cjs");
} catch (error) {
  if (error?.code !== "MODULE_NOT_FOUND") {
    throw error;
  }
}

test("Chromium sandbox stays enabled unless the operator explicitly disables it", () => {
  assert.equal(typeof security.shouldDisableChromiumSandbox, "function");

  assert.equal(
    security.shouldDisableChromiumSandbox({ env: {}, platform: "win32" }),
    false,
  );
  assert.equal(
    security.shouldDisableChromiumSandbox({
      env: { CODEXBRIDGE_NO_SANDBOX: "1" },
      platform: "win32",
    }),
    true,
  );
  assert.equal(
    security.shouldDisableChromiumSandbox({
      env: {
        CODEXBRIDGE_NO_SANDBOX: "1",
        CODEXBRIDGE_CHROMIUM_SANDBOX: "1",
      },
      platform: "win32",
    }),
    false,
  );
});

test("main-window navigation permits only the renderer document and denies every popup", () => {
  assert.equal(typeof security.installRendererNavigationGuards, "function");

  const webContents = new EventEmitter();
  webContents.setWindowOpenHandler = (handler) => {
    webContents.windowOpenHandler = handler;
  };
  const blocked = [];
  security.installRendererNavigationGuards(webContents, {
    trustedRendererUrl: "file:///C:/CodexBridge/desktop/renderer/index.html",
    onBlocked: (details) => blocked.push(details),
  });

  const trustedEvent = {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  webContents.emit(
    "will-navigate",
    trustedEvent,
    "file:///C:/CodexBridge/desktop/renderer/index.html#settings",
  );
  assert.equal(trustedEvent.prevented, false);

  const externalEvent = {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  webContents.emit("will-navigate", externalEvent, "https://attacker.example/");
  assert.equal(externalEvent.prevented, true);

  const siblingFileEvent = {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  webContents.emit(
    "will-redirect",
    siblingFileEvent,
    "file:///C:/CodexBridge/desktop/renderer/other.html",
  );
  assert.equal(siblingFileEvent.prevented, true);
  assert.deepEqual(webContents.windowOpenHandler({ url: "https://example.com/" }), {
    action: "deny",
  });
  assert.deepEqual(
    blocked.map((item) => item.kind),
    ["navigation", "redirect", "window-open"],
  );
});

test("IPC handlers accept only the trusted main renderer and reject every other sender", async () => {
  assert.equal(typeof security.createTrustedIpcRegistrar, "function");

  const registered = new Map();
  const rawIpcMain = {
    handle(channel, handler) {
      registered.set(channel, handler);
    },
  };
  const trustedWebContents = {};
  const ipcMain = security.createTrustedIpcRegistrar(rawIpcMain, () => ({
    trustedWebContents,
    trustedRendererUrl: "file:///C:/CodexBridge/desktop/renderer/index.html",
  }));
  ipcMain.handle("secrets:get", (_event, key) => `secret:${key}`);
  const handler = registered.get("secrets:get");

  assert.equal(
    await handler({
      sender: trustedWebContents,
      senderFrame: {
        url: "file:///C:/CodexBridge/desktop/renderer/index.html#settings",
      },
    }, "OPENAI_API_KEY"),
    "secret:OPENAI_API_KEY",
  );

  await assert.rejects(
    async () => handler({
      sender: {},
      senderFrame: {
        url: "file:///C:/CodexBridge/desktop/renderer/index.html",
      },
    }, "OPENAI_API_KEY"),
    /Untrusted IPC sender/,
  );
  await assert.rejects(
    async () => handler({
      sender: trustedWebContents,
      senderFrame: { url: "https://attacker.example/" },
    }, "OPENAI_API_KEY"),
    /Untrusted IPC sender/,
  );
});

test("preload exposes only narrow software-manager methods and no generic invoke bridge", () => {
  const source = fs.readFileSync(new URL("../desktop/preload.cjs", import.meta.url), "utf8");
  for (const method of [
    "getSoftwareManagerSnapshot",
    "selectSoftwareManagerInstallRoot",
    "refreshSoftwareManager",
    "startSoftwareManagerTask",
    "cancelSoftwareManagerTask",
    "onSoftwareManagerEvent",
  ]) assert.match(source, new RegExp(`\\b${method}\\b`, "u"));
  assert.match(
    source,
    /onSoftwareManagerEvent:[\s\S]*?return \(\) => ipcRenderer\.removeListener\("softwareManager:event", listener\)/u,
  );
  assert.doesNotMatch(source, /\bgenericInvoke\b|ipcRenderer:\s*ipcRenderer|invoke:\s*ipcRenderer\.invoke/u);
});
