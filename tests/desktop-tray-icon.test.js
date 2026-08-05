import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const modulePath = resolve(import.meta.dirname, "../desktop/tray-icon.cjs");
const trayIconModule = existsSync(modulePath) ? require(modulePath) : {};

test("macOS tray icon uses a transparent CB template bitmap instead of app artwork", () => {
  assert.equal(
    typeof trayIconModule.createTrayIcon,
    "function",
    "desktop/tray-icon.cjs must export createTrayIcon",
  );

  const calls = { bitmap: [], representations: [], template: [] };
  const templateImage = {
    addRepresentation(options) {
      calls.representations.push(options);
    },
    setTemplateImage(value) {
      calls.template.push(value);
    },
  };
  const nativeImage = {
    createFromBitmap(buffer, options) {
      calls.bitmap.push({ buffer, options });
      return templateImage;
    },
    createFromPath() {
      throw new Error("macOS must not use the opaque application artwork as a template mask");
    },
  };

  const result = trayIconModule.createTrayIcon({
    platform: "darwin",
    iconPath: "/app/codexbridge-icon.png",
    nativeImage,
  });

  assert.equal(result, templateImage);
  assert.equal(calls.bitmap.length, 1);
  assert.deepEqual(calls.bitmap[0].options, { width: 16, height: 16, scaleFactor: 1 });
  assert.equal(calls.bitmap[0].buffer.length, 16 * 16 * 4);
  const alpha = Array.from(calls.bitmap[0].buffer.subarray(3).filter((_, index) => index % 4 === 0));
  assert.equal(alpha[0], 0, "top-left background must remain transparent");
  assert.equal(alpha.at(-1), 0, "bottom-right background must remain transparent");
  assert.ok(alpha.some((value) => value === 255), "the CB mark must contain opaque pixels");
  assert.ok(
    alpha.filter((value) => value === 255).length < alpha.length / 2,
    "the template mask must not collapse into another solid square",
  );
  assert.equal(calls.representations.length, 1);
  assert.deepEqual(
    { ...calls.representations[0], buffer: undefined },
    { scaleFactor: 2, width: 32, height: 32, buffer: undefined },
  );
  assert.equal(calls.representations[0].buffer.length, 32 * 32 * 4);
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
