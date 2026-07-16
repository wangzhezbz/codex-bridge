import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rendererSource = readFileSync(resolve(__dirname, "../desktop/renderer/app.js"), "utf8");
const htmlSource = readFileSync(resolve(__dirname, "../desktop/renderer/index.html"), "utf8");
const preloadSource = readFileSync(resolve(__dirname, "../desktop/preload.cjs"), "utf8");

test("desktop renderer keeps starting health state out of failed styling", () => {
  assert.match(rendererSource, /const isStarting = Boolean\(health\?\.starting\);/);
  assert.match(
    rendererSource,
    /classList\.toggle\("bad", Boolean\(health && !health\.ok && !isStarting\)\);/,
  );
  assert.match(rendererSource, /Router 正在启动/);
});

test("desktop renderer exposes update from sidebar without a dedicated page", () => {
  assert.doesNotMatch(htmlSource, /data-section="updates"/);
  assert.doesNotMatch(htmlSource, /id="updates"/);
  assert.match(htmlSource, /id="checkUpdates"/);
  assert.doesNotMatch(htmlSource, /id="installUpdate"/);
  assert.match(preloadSource, /checkForUpdates: \(\) => ipcRenderer\.invoke\("updates:check"\)/);
  assert.match(preloadSource, /installUpdate: \(\) => ipcRenderer\.invoke\("updates:install"\)/);
  assert.match(rendererSource, /api\.checkForUpdates\(\)/);
  assert.match(rendererSource, /api\.installUpdate\(\)/);
  assert.match(rendererSource, /window\.confirm/);
});

test("desktop renderer wires Kimi provider baseUrl override UI", () => {
  assert.match(preloadSource, /setProviderBaseUrl: \(payload\) => ipcRenderer\.invoke\("providers:setBaseUrl", payload\)/);
  assert.match(preloadSource, /resetProviderBaseUrl: \(payload\) => ipcRenderer\.invoke\("providers:resetBaseUrl", payload\)/);
  assert.match(rendererSource, /data-save-provider-base-url/);
  assert.match(rendererSource, /data-reset-provider-base-url/);
  assert.match(rendererSource, /api\.setProviderBaseUrl\(/);
  assert.match(rendererSource, /api\.resetProviderBaseUrl\(/);
  assert.match(rendererSource, /supportsBaseUrlOverride/);
  assert.match(rendererSource, /isLikelyHttpUrl/);
});
