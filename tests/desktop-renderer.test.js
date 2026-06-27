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
  assert.match(rendererSource, /bindFolderButton\("#openUpdateFolder", "updates"\)/);
  assert.match(preloadSource, /onUpdateProgress: \(callback\) =>/);
  assert.match(rendererSource, /api\.checkForUpdates\(\)/);
  assert.match(rendererSource, /api\.installUpdate\(\)/);
  assert.match(rendererSource, /api\.onUpdateProgress\?\.\(\(progress\) => renderUpdateProgress\(progress\)\)/);
  assert.match(rendererSource, /function renderUpdateProgress/);
  assert.match(rendererSource, /result\.installerPath \? "launching" : "ready"/);
  assert.match(rendererSource, /安装到用户程序目录/);
  assert.match(rendererSource, /正在启动安装器/);
  assert.match(htmlSource, /Windows 安装器会安装到用户程序目录/);
  assert.match(rendererSource, /bytesPerSecond/);
  assert.match(rendererSource, /formatBytes\(details\.bytesPerSecond\)/);
  assert.match(rendererSource, /\}\/s`/);
  assert.match(rendererSource, /els\.appVersion\.textContent = `v\$\{state\.appVersion \|\| "-"\}`;/);
  assert.match(rendererSource, /showUpdateDialog/);
  assert.doesNotMatch(rendererSource, /window\.confirm/);
  assert.match(rendererSource, /下载更新包/);
  assert.doesNotMatch(rendererSource, /下载并重启/);
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
  assert.match(rendererSource, /上游/);
  assert.match(rendererSource, /latest\.upstreamModel/);
  assert.match(rendererSource, /routeProviderName/);
  assert.match(rendererSource, /latest\.api/);
});
