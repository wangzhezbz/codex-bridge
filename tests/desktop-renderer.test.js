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
});

test("desktop renderer exposes update from sidebar without a dedicated page", () => {
  assert.doesNotMatch(htmlSource, /data-section="updates"/);
  assert.doesNotMatch(htmlSource, /id="updates"/);
  assert.match(htmlSource, /id="appVersion"/);
  assert.match(htmlSource, /id="checkUpdates"/);
  assert.match(htmlSource, /id="openUpdateFolder"/);
  assert.match(htmlSource, /id="updateDialog"/);
  assert.match(htmlSource, /id="confirmUpdate"/);
  assert.match(htmlSource, /id="cancelUpdate"/);
  assert.match(htmlSource, /id="updateProgress"/);
  assert.match(htmlSource, /id="updateProgressBar"/);
  assert.doesNotMatch(htmlSource, /id="installUpdate"/);
  assert.match(preloadSource, /checkForUpdates: \(\) => ipcRenderer\.invoke\("updates:check"\)/);
  assert.match(preloadSource, /installUpdate: \(\) => ipcRenderer\.invoke\("updates:install"\)/);
  assert.match(preloadSource, /onUpdateProgress: \(callback\) =>/);
  assert.match(preloadSource, /onUpdateFinished: \(callback\) =>/);
  assert.match(rendererSource, /bindFolderButton\("#openUpdateFolder", "updates"\)/);
  assert.match(rendererSource, /api\.checkForUpdates\(\)/);
  assert.match(rendererSource, /api\.installUpdate\(\)/);
  assert.match(rendererSource, /api\.onUpdateProgress\?\.\(\(progress\) => renderUpdateProgress\(progress\)\)/);
  assert.match(rendererSource, /api\.onUpdateFinished\?\.\(\(result\) =>/);
  assert.match(rendererSource, /function renderUpdateProgress/);
  assert.match(rendererSource, /result\.installerPath \? "launching" : "ready"/);
  assert.match(rendererSource, /result\.nextStep \|\| result\.message/);
  assert.match(rendererSource, /bytesPerSecond/);
  assert.match(rendererSource, /formatBytes\(details\.bytesPerSecond\)/);
  assert.match(rendererSource, /\}\/s`/);
  assert.match(rendererSource, /els\.appVersion\.textContent = `v\$\{state\.appVersion \|\| "-"\}`;/);
  assert.match(rendererSource, /showUpdateDialog/);
  assert.doesNotMatch(rendererSource, /window\.confirm/);
  assert.doesNotMatch(rendererSource, /Windows Setup installer will be saved|updates folder|manual fallback/);
  assert.doesNotMatch(htmlSource, /Windows Setup installer will be saved|updates folder|manual fallback/);
});

test("desktop renderer opens folder buttons through the shared action handler", () => {
  assert.match(rendererSource, /bindFolderButton\("#openConfigFolder", "config"\)/);
  assert.match(rendererSource, /bindFolderButton\("#openCodexFolder", "codex"\)/);
  assert.match(rendererSource, /bindFolderButton\("#openUpdateFolder", "updates"\)/);
  assert.match(rendererSource, /function bindFolderButton/);
  assert.match(rendererSource, /runAction\(button, async \(\) =>/);
});

test("desktop renderer surfaces route capabilities and real upstream status", () => {
  assert.match(rendererSource, /data-capability-badges/);
  assert.match(rendererSource, /function modelCapabilityBadges/);
  assert.match(rendererSource, /function modelCapabilityHints/);
  assert.match(rendererSource, /Tools/);
  assert.match(rendererSource, /Compact/);
  assert.match(rendererSource, /latest\.upstreamModel/);
  assert.match(rendererSource, /routeProviderName/);
  assert.match(rendererSource, /latest\.api/);
});

test("desktop renderer shows current usage by default without a history banner", () => {
  assert.match(rendererSource, /const current = summary\.current \|\| summary;/);
  assert.match(rendererSource, /const history = summary\.history \|\| emptyUsageSummary\(\);/);
  assert.match(rendererSource, /renderUsageTableStable\(current\.byModel \|\| \[\], events, history\)/);
  assert.doesNotMatch(rendererSource, /hiddenHistoryNote/);
  assert.doesNotMatch(rendererSource, /历史路由已隐藏|鍘嗗彶璺敱宸查殣钘?/);
});
