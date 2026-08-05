import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const modulePath = resolve(import.meta.dirname, "../desktop/tray-icon.cjs");
const trayIconModule = existsSync(modulePath) ? require(modulePath) : {};

test("macOS tray icon is resized to a 16px template image", () => {
  assert.equal(
    typeof trayIconModule.createTrayIcon,
    "function",
    "desktop/tray-icon.cjs must export createTrayIcon",
  );

  const calls = { paths: [], resize: [], template: [] };
  const resizedImage = {
    setTemplateImage(value) {
      calls.template.push(value);
    },
  };
  const nativeImage = {
    createFromPath(iconPath) {
      calls.paths.push(iconPath);
      return {
        resize(options) {
          calls.resize.push(options);
          return resizedImage;
        },
      };
    },
  };

  const result = trayIconModule.createTrayIcon({
    platform: "darwin",
    iconPath: "/app/codexbridge-icon.png",
    nativeImage,
  });

  assert.equal(result, resizedImage);
  assert.deepEqual(calls.paths, ["/app/codexbridge-icon.png"]);
  assert.deepEqual(calls.resize, [{ width: 16, height: 16, quality: "best" }]);
  assert.deepEqual(calls.template, [true]);
});

test("non-macOS tray icon keeps the platform asset path", () => {
  assert.equal(
    typeof trayIconModule.createTrayIcon,
    "function",
    "desktop/tray-icon.cjs must export createTrayIcon",
  );

  const result = trayIconModule.createTrayIcon({
    platform: "win32",
    iconPath: "C:\\app\\codexbridge-icon.ico",
    nativeImage: {
      createFromPath() {
        throw new Error("Windows must not convert the ICO through nativeImage");
      },
    },
  });

  assert.equal(result, "C:\\app\\codexbridge-icon.ico");
});
