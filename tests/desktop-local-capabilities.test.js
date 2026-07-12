import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

test("local browser capability can open a safe http URL through the desktop shell", async () => {
  const { createDesktopLocalCapabilityExecutor } = require("../desktop/local-capabilities.cjs");
  const opened = [];
  const execute = createDesktopLocalCapabilityExecutor({
    openExternal: async (url) => {
      opened.push(url);
    },
    fetchImpl: async () => {
      throw new Error("open_url should not fetch the page");
    },
  });

  const result = await execute({
    adapter: "local_browser",
    capability: "browser",
    provider: { id: "local-browser" },
    request: {
      input: {
        action: "open_url",
        url: "https://example.com/docs",
      },
    },
  });

  assert.deepEqual(opened, ["https://example.com/docs"]);
  assert.equal(result.action, "open_url");
  assert.equal(result.url, "https://example.com/docs");
  assert.equal(result.providerId, "local-browser");
  assert.match(result.text, /已请求系统浏览器打开/);
});

test("local browser capability can diagnose connected desktop actions without network", async () => {
  const { createDesktopLocalCapabilityExecutor } = require("../desktop/local-capabilities.cjs");
  const execute = createDesktopLocalCapabilityExecutor({
    openExternal: async () => {
      throw new Error("diagnose should not open the browser");
    },
    fetchImpl: async () => {
      throw new Error("diagnose should not fetch");
    },
    capturePageScreenshot: async () => {
      throw new Error("diagnose should not capture");
    },
  });

  const result = await execute({
    adapter: "local_browser",
    capability: "browser",
    provider: { id: "local-browser" },
    request: {
      input: {
        action: "diagnose",
      },
    },
  });

  assert.equal(result.action, "diagnose");
  assert.equal(result.providerId, "local-browser");
  assert.equal(result.handledBy, "desktop_local_browser");
  assert.deepEqual(result.supportedActions, ["open_url", "read_url", "screenshot_url"]);
  assert.equal(result.canOpenUrl, true);
  assert.equal(result.canReadUrl, true);
  assert.equal(result.canScreenshotUrl, true);
  assert.match(result.text, /本地浏览器执行器已接入/);
});

test("local browser capability does not advertise screenshots without a screenshot executor", async () => {
  const { createDesktopLocalCapabilityExecutor } = require("../desktop/local-capabilities.cjs");
  const execute = createDesktopLocalCapabilityExecutor({
    openExternal: async () => {},
    fetchImpl: async () => {
      throw new Error("diagnose should not fetch");
    },
  });

  const result = await execute({
    adapter: "local_browser",
    capability: "browser",
    provider: { id: "local-browser" },
    request: {
      input: {
        action: "diagnose",
      },
    },
  });

  assert.equal(result.canOpenUrl, true);
  assert.equal(result.canReadUrl, true);
  assert.equal(result.canScreenshotUrl, false);
  assert.deepEqual(result.supportedActions, ["open_url", "read_url"]);
  assert.doesNotMatch(result.text, /screenshot_url/);
});

test("local browser capability can read a safe http page into clean text", async () => {
  const { createDesktopLocalCapabilityExecutor } = require("../desktop/local-capabilities.cjs");
  const opened = [];
  const fetched = [];
  const execute = createDesktopLocalCapabilityExecutor({
    openExternal: async (url) => {
      opened.push(url);
    },
    fetchImpl: async (url, options) => {
      fetched.push({ url, options });
      return {
        ok: true,
        status: 200,
        headers: new Map([["content-type", "text/html; charset=utf-8"]]),
        text: async () => `
          <!doctype html>
          <html>
            <head>
              <title>Example Docs</title>
              <style>.hidden { display: none; }</style>
              <script>window.secret = "do not include";</script>
            </head>
            <body>
              <main>
                <h1>CodexBridge Browser Bridge</h1>
                <p>Bridge can read public docs for a non GPT model.</p>
              </main>
            </body>
          </html>
        `,
      };
    },
  });

  const result = await execute({
    adapter: "local_browser",
    capability: "browser",
    provider: { id: "local-browser" },
    request: {
      input: {
        action: "read_url",
        url: "https://example.com/docs",
      },
    },
  });

  assert.deepEqual(opened, []);
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].url, "https://example.com/docs");
  assert.equal(result.action, "read_url");
  assert.equal(result.url, "https://example.com/docs");
  assert.equal(result.title, "Example Docs");
  assert.equal(result.status, 200);
  assert.match(result.text, /已读取网页：Example Docs/);
  assert.match(result.text, /CodexBridge Browser Bridge/);
  assert.match(result.text, /non GPT model/);
  assert.doesNotMatch(result.text, /do not include/);
  assert.doesNotMatch(result.text, /display: none/);
});

test("local browser capability normalizes bare domain inputs to https", async () => {
  const { createDesktopLocalCapabilityExecutor } = require("../desktop/local-capabilities.cjs");
  const fetched = [];
  const execute = createDesktopLocalCapabilityExecutor({
    fetchImpl: async (url) => {
      fetched.push(url);
      return {
        ok: true,
        status: 200,
        headers: new Map([["content-type", "text/plain"]]),
        text: async () => "Bare domain was read safely.",
      };
    },
  });

  const result = await execute({
    adapter: "local_browser",
    capability: "browser",
    provider: { id: "local-browser" },
    request: {
      input: {
        action: "read_url",
        url: "docs.example.com/path?q=1",
      },
    },
  });

  assert.deepEqual(fetched, ["https://docs.example.com/path?q=1"]);
  assert.equal(result.url, "https://docs.example.com/path?q=1");
  assert.match(result.text, /Bare domain/);
});

test("local browser capability rejects oversized read responses before reading the body", async () => {
  const { createDesktopLocalCapabilityExecutor } = require("../desktop/local-capabilities.cjs");
  const execute = createDesktopLocalCapabilityExecutor({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Map([
        ["content-type", "text/html; charset=utf-8"],
        ["content-length", "2048"],
      ]),
      text: async () => {
        throw new Error("oversized body should not be read");
      },
    }),
  });

  await assert.rejects(
    execute({
      adapter: "local_browser",
      capability: "browser",
      provider: { id: "local-browser" },
      request: {
        input: {
          action: "read_url",
          url: "https://example.com/huge",
          maxBytes: 1024,
        },
      },
    }),
    (error) => {
      assert.equal(error.code, "local_browser_response_too_large");
      assert.match(error.message, /2048 bytes/);
      return true;
    },
  );
});

test("local browser capability can capture a safe http page screenshot", async () => {
  const { createDesktopLocalCapabilityExecutor } = require("../desktop/local-capabilities.cjs");
  const captured = [];
  const execute = createDesktopLocalCapabilityExecutor({
    openExternal: async () => {
      throw new Error("screenshot_url should not open the browser");
    },
    fetchImpl: async () => {
      throw new Error("screenshot_url should not fetch text");
    },
    capturePageScreenshot: async (payload) => {
      captured.push(payload);
      return Buffer.from("fake-local-screenshot");
    },
  });

  const result = await execute({
    adapter: "local_browser",
    capability: "webpage_screenshot",
    provider: { id: "local-browser-screenshot" },
    request: {
      input: {
        action: "screenshot_url",
        url: "https://example.com/dashboard",
        viewport: "mobile",
        fullPage: true,
      },
    },
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, "https://example.com/dashboard");
  assert.equal(captured[0].viewport, "mobile");
  assert.equal(captured[0].fullPage, true);
  assert.equal(result.action, "screenshot_url");
  assert.equal(result.url, "https://example.com/dashboard");
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.screenshotBase64, Buffer.from("fake-local-screenshot").toString("base64"));
  assert.match(result.text, /网页截图已生成/);
});

test("local browser capability rejects unsafe URLs before opening or fetching", async () => {
  const { createDesktopLocalCapabilityExecutor } = require("../desktop/local-capabilities.cjs");
  const execute = createDesktopLocalCapabilityExecutor({
    openExternal: async () => {
      throw new Error("unsafe URL should not open");
    },
    fetchImpl: async () => {
      throw new Error("unsafe URL should not fetch");
    },
  });

  await assert.rejects(
    execute({
      adapter: "local_browser",
      capability: "browser",
      request: {
        input: {
          action: "read_url",
          url: "file:///C:/Users/Administrator/.ssh/id_rsa",
        },
      },
    }),
    (error) => {
      assert.equal(error.code, "local_action_unsupported");
      assert.match(error.message, /http\/https/);
      return true;
    },
  );
});

test("local file capability can extract text from an explicit local text file", async () => {
  const { createDesktopLocalCapabilityExecutor } = require("../desktop/local-capabilities.cjs");
  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-local-file-"));
  const filePath = path.join(fileDir, "notes.txt");
  fs.writeFileSync(filePath, "CodexBridge local file text.\nSecond line for extraction.", "utf8");
  const execute = createDesktopLocalCapabilityExecutor({});

  const result = await execute({
    adapter: "local_file",
    capability: "file_processing",
    provider: { id: "local-file" },
    request: {
      input: {
        action: "extract_text",
        path: filePath,
        maxCharacters: 32,
      },
    },
  });

  assert.equal(result.action, "extract_text");
  assert.equal(result.providerId, "local-file");
  assert.equal(result.handledBy, "desktop_local_file");
  assert.equal(result.filePath, filePath);
  assert.equal(result.mimeType, "text/plain");
  assert.equal(result.truncated, true);
  assert.match(result.excerpt, /CodexBridge local file text/);
  assert.match(result.text, /notes\.txt/);
  assert.match(result.text, /CodexBridge local file text/);
});

test("local file capability can inspect an explicit local data file before reading it", async () => {
  const { createDesktopLocalCapabilityExecutor } = require("../desktop/local-capabilities.cjs");
  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-local-file-inspect-"));
  const filePath = path.join(fileDir, "models.json");
  fs.writeFileSync(filePath, JSON.stringify({ provider: "CodexBridge", models: ["alpha", "beta"] }, null, 2), "utf8");
  const execute = createDesktopLocalCapabilityExecutor({});

  const result = await execute({
    adapter: "local_file",
    capability: "file_processing",
    provider: { id: "local-file" },
    request: {
      input: {
        action: "inspect_file",
        path: filePath,
        maxCharacters: 48,
      },
    },
  });

  assert.equal(result.action, "inspect_file");
  assert.equal(result.providerId, "local-file");
  assert.equal(result.handledBy, "desktop_local_file");
  assert.equal(result.filePath, filePath);
  assert.equal(result.fileName, "models.json");
  assert.equal(result.extension, ".json");
  assert.equal(result.mimeType, "application/json");
  assert.equal(result.encoding, "utf8");
  assert.equal(result.lineCount, 7);
  assert.equal(result.truncated, true);
  assert.match(result.preview, /CodexBridge/);
  assert.match(result.text, /文件检查/);
  assert.match(result.text, /models\.json/);
  assert.match(result.text, /application\/json/);
});

test("local file capability rejects directories instead of scanning them", async () => {
  const { createDesktopLocalCapabilityExecutor } = require("../desktop/local-capabilities.cjs");
  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-local-file-dir-"));
  const execute = createDesktopLocalCapabilityExecutor({});

  await assert.rejects(
    execute({
      adapter: "local_file",
      capability: "file_processing",
      provider: { id: "local-file" },
      request: {
        input: {
          action: "extract_text",
          path: fileDir,
        },
      },
    }),
    (error) => {
      assert.equal(error.code, "local_file_not_file");
      assert.match(error.message, /文件路径/);
      return true;
    },
  );
});

test("local computer use capability reports a safe diagnostic-only status", async () => {
  const { createDesktopLocalCapabilityExecutor } = require("../desktop/local-capabilities.cjs");
  const execute = createDesktopLocalCapabilityExecutor({
    openExternal: async () => {
      throw new Error("computer use should not open URLs");
    },
    fetchImpl: async () => {
      throw new Error("computer use should not fetch");
    },
  });

  const result = await execute({
    adapter: "local_computer_use",
    capability: "computer_use",
    provider: { id: "local-computer-use" },
    request: {
      input: {
        action: "diagnose",
      },
    },
  });

  assert.equal(result.action, "diagnose");
  assert.equal(result.providerId, "local-computer-use");
  assert.equal(result.handledBy, "desktop_local_computer_use");
  assert.deepEqual(result.supportedActions, ["diagnose", "list_apps", "open_app"]);
  assert.equal(result.canControlDesktop, false);
  assert.equal(result.canScreenshot, false);
  assert.deepEqual(result.allowedApps.map((app) => app.id), ["notepad", "calculator", "paint"]);
  assert.equal(result.allowedApps[0].command, undefined);
  assert.equal(result.requiresGptResponses, true);
  assert.match(result.text, /Computer Use/);
});

test("local computer use capability can list allowlisted apps without launching them", async () => {
  const { createDesktopLocalCapabilityExecutor } = require("../desktop/local-capabilities.cjs");
  const execute = createDesktopLocalCapabilityExecutor({
    platform: "win32",
    launchApp: async () => {
      throw new Error("list_apps must not launch an app");
    },
  });

  const result = await execute({
    adapter: "local_computer_use",
    capability: "computer_use",
    provider: { id: "local-computer-use" },
    request: {
      input: {
        action: "list_apps",
      },
    },
  });

  assert.equal(result.action, "list_apps");
  assert.equal(result.handledBy, "desktop_local_computer_use");
  assert.equal(result.canControlDesktop, false);
  assert.deepEqual(result.allowedApps.map((app) => app.id), ["notepad", "calculator", "paint"]);
  assert.equal(result.allowedApps[0].command, undefined);
  assert.match(result.text, /notepad/);
});

test("local computer use capability can launch an allowlisted app", async () => {
  const { createDesktopLocalCapabilityExecutor } = require("../desktop/local-capabilities.cjs");
  const launches = [];
  const execute = createDesktopLocalCapabilityExecutor({
    platform: "win32",
    launchApp: async (command, args, metadata) => {
      launches.push({ command, args, metadata });
    },
  });

  const result = await execute({
    adapter: "local_computer_use",
    capability: "computer_use",
    provider: { id: "local-computer-use" },
    request: {
      input: {
        action: "open_app",
        app: "notepad",
      },
    },
  });

  assert.equal(result.action, "open_app");
  assert.equal(result.appId, "notepad");
  assert.equal(result.command, "notepad.exe");
  assert.equal(result.handledBy, "desktop_local_computer_use");
  assert.equal(result.canControlDesktop, false);
  assert.deepEqual(launches, [
    {
      command: "notepad.exe",
      args: [],
      metadata: { appId: "notepad", label: "记事本" },
    },
  ]);
  assert.match(result.text, /记事本/);
});

test("local computer use capability can capture a desktop screenshot without mouse or keyboard control", async () => {
  const { createDesktopLocalCapabilityExecutor } = require("../desktop/local-capabilities.cjs");
  const captures = [];
  const screenshotBytes = Buffer.from("fake-desktop-screenshot");
  const execute = createDesktopLocalCapabilityExecutor({
    captureDesktopScreenshot: async (payload) => {
      captures.push(payload);
      return screenshotBytes;
    },
    launchApp: async () => {
      throw new Error("desktop screenshot should not launch apps");
    },
  });

  const result = await execute({
    adapter: "local_computer_use",
    capability: "computer_use",
    provider: { id: "local-computer-use" },
    request: {
      input: {
        action: "screenshot_desktop",
      },
    },
  });

  assert.deepEqual(captures, [{ displayId: "" }]);
  assert.equal(result.action, "screenshot_desktop");
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.screenshotBase64, screenshotBytes.toString("base64"));
  assert.equal(result.canControlDesktop, false);
  assert.equal(result.canScreenshot, true);
  assert.match(result.text, /桌面截图已生成/);
});

test("local computer use capability rejects apps outside the allowlist", async () => {
  const { createDesktopLocalCapabilityExecutor } = require("../desktop/local-capabilities.cjs");
  const execute = createDesktopLocalCapabilityExecutor({
    platform: "win32",
    launchApp: async () => {
      throw new Error("non-allowlisted app should not launch");
    },
  });

  await assert.rejects(
    execute({
      adapter: "local_computer_use",
      capability: "computer_use",
      provider: { id: "local-computer-use" },
      request: {
        input: {
          action: "open_app",
          app: "powershell",
        },
      },
    }),
    (error) => {
      assert.equal(error.code, "local_action_unsupported");
      assert.match(error.message, /白名单/);
      return true;
    },
  );
});

test("local computer use capability rejects desktop-control actions", async () => {
  const { createDesktopLocalCapabilityExecutor } = require("../desktop/local-capabilities.cjs");
  const execute = createDesktopLocalCapabilityExecutor({});

  await assert.rejects(
    execute({
      adapter: "local_computer_use",
      capability: "computer_use",
      provider: { id: "local-computer-use" },
      request: {
        input: {
          action: "click",
          x: 100,
          y: 100,
        },
      },
    }),
    (error) => {
      assert.equal(error.code, "local_action_unsupported");
      assert.match(error.message, /Computer Use/);
      return true;
    },
  );
});
