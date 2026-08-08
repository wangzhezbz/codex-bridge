import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const rootDir = path.resolve(import.meta.dirname, "..");
const moduleSource = fs.readFileSync(path.join(rootDir, "desktop", "renderer", "software-manager-ui.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(rootDir, "desktop", "renderer", "index.html"), "utf8");
const appSource = fs.readFileSync(path.join(rootDir, "desktop", "renderer", "app.js"), "utf8");
const cssSource = fs.readFileSync(path.join(rootDir, "desktop", "renderer", "styles.css"), "utf8");
const preloadSource = fs.readFileSync(path.join(rootDir, "desktop", "preload.cjs"), "utf8");

function loadUi() {
  const context = { window: {} };
  vm.runInNewContext(moduleSource, context, { filename: "software-manager-ui.js" });
  return context.window.CodexBridgeSoftwareManagerUI;
}

function component(id, extra = {}) {
  return {
    id,
    name: id === "chatgpt" ? "ChatGPT" : id === "v2rayn" ? "V2RayN" : "Git",
    version: id === "git" ? "2.51.0" : "26.721.11231.0",
    size: 725_090_304,
    installedVersion: null,
    updateState: "not-installed",
    rollbackAvailable: false,
    ...extra,
  };
}

function snapshot(extra = {}) {
  return {
    platform: "win32",
    enabled: true,
    readOnly: false,
    pendingRecovery: false,
    tabs: ["install", "update", "uninstall"],
    catalog: {
      available: true,
      components: [component("chatgpt"), component("v2rayn"), component("git")],
      skills: [
        { id: "documents", name: "文档处理", description: "创建和编辑文档", version: "1.0.0", size: 1_024 },
        { id: "spreadsheets", name: "表格分析", description: "分析电子表格", version: "1.0.0", size: 2_048 },
      ],
    },
    components: [component("chatgpt"), component("v2rayn"), component("git")],
    skills: [],
    rollback: [],
    defaults: { install: { componentIds: ["chatgpt"], skillIds: [] }, update: { componentIds: [], skillIds: [] } },
    task: null,
    logging: { degraded: false, pendingWrites: 0, error: null, recovery: null },
    logs: [],
    ...extra,
  };
}

function rendered(ui, input = snapshot(), action = null) {
  let state = ui.reduce(ui.createInitialState(), { type: "snapshot", snapshot: input });
  if (action) state = ui.reduce(state, action);
  const root = { innerHTML: "" };
  ui.render(root, state);
  return { html: root.innerHTML, state };
}

test("renderer module exposes the fixed state, rendering, and selection surface", () => {
  const ui = loadUi();
  assert.deepEqual(
    Object.keys(ui).sort(),
    ["createInitialState", "defaultSelection", "readSelection", "reduce", "render", "renderSkillPicker"].sort(),
  );
});

test("install defaults select only ChatGPT and both install and uninstall share the fixed-height Skills picker", () => {
  const ui = loadUi();
  const { html, state } = rendered(ui);
  assert.deepEqual([...state.selectedComponentIds], ["chatgpt"]);
  assert.match(html, /下载安装/u);
  assert.match(html, /data-software-component="chatgpt"[^>]*checked/u);
  assert.match(html, /data-skill-picker-mode="install"/u);

  const uninstall = rendered(ui, snapshot({
    skills: [{ componentId: "documents", versionAfter: "1.0.0", status: "succeeded", name: "文档处理" }],
  }), { type: "tab", tab: "uninstall" }).html;
  assert.match(uninstall, /data-skill-picker-mode="uninstall"/u);
  assert.match(uninstall, /搜索 Skill 名称或用途/u);
  assert.doesNotMatch(uninstall, /同时删除/u);
});

test("rollback navigation is omitted entirely until a real rollback record exists", () => {
  const ui = loadUi();
  assert.doesNotMatch(rendered(ui).html, /data-software-tab="rollback"/u);

  const withRollback = snapshot({
    tabs: ["install", "update", "uninstall", "rollback"],
    rollback: [{ id: "chatgpt", name: "ChatGPT", version: "26.721.11231.0", previousVersion: "26.707.3748.0" }],
  });
  assert.match(rendered(ui, withRollback).html, /data-software-tab="rollback"/u);
});

test("update view distinguishes update, current, and missing components without selecting current versions", () => {
  const ui = loadUi();
  const input = snapshot({
    components: [
      component("chatgpt", { installedVersion: "26.707.3748.0", updateState: "update-available" }),
      component("v2rayn", { installedVersion: "7.2.0", updateState: "current" }),
      component("git", { updateState: "not-installed" }),
    ],
    defaults: { install: { componentIds: ["chatgpt"], skillIds: [] }, update: { componentIds: ["chatgpt"], skillIds: [] } },
  });
  const html = rendered(ui, input, { type: "tab", tab: "update" }).html;
  assert.match(html, /有新版本/u);
  assert.match(html, /已是最新版/u);
  assert.match(html, /尚未安装/u);
  assert.match(html, /data-software-component="v2rayn"[^>]*disabled/u);
});

test("Git ownership, public registration link, replacement warning, and critical cancellation are explicit", () => {
  const ui = loadUi();
  const input = snapshot({
    components: [component("chatgpt"), component("v2rayn"), component("git", {
      installedVersion: "2.50.1",
      ownership: "external",
      installPath: "C:\\Program Files\\Git",
    })],
    task: { taskId: "task-1", kind: "install", phase: "commit", critical: true, cancellable: false },
  });
  let state = ui.reduce(ui.createInitialState(), { type: "snapshot", snapshot: input });
  state = ui.reduce(state, { type: "toggle-skill", skillId: "documents", checked: true });
  state = ui.reduce(state, { type: "confirm-open" });
  const root = { innerHTML: "" };
  ui.render(root, state);
  assert.match(root.innerHTML, /https:\/\/w1\.soxo\.top\/auth\/register\?code=2aEq/u);
  assert.match(root.innerHTML, /外部安装/u);
  assert.match(root.innerHTML, /C:\\Program Files\\Git/u);
  assert.match(root.innerHTML, /同名 Skill 将被替换，原内容不会保留/u);
  assert.match(root.innerHTML, /data-software-cancel[^>]*disabled/u);
});

test("renderer caps displayed logs at the latest 500 lines", () => {
  const ui = loadUi();
  const logs = Array.from({ length: 510 }, (_, index) => `log-${index}`);
  const html = rendered(ui, snapshot({ logs })).html;
  assert.doesNotMatch(html, /log-0</u);
  assert.match(html, /log-509</u);
  assert.equal((html.match(/class="software-log-line"/gu) ?? []).length, 500);
});

test("software-manager markup obeys the desktop CSP without inline style attributes", () => {
  const ui = loadUi();
  const html = rendered(ui, snapshot({
    task: { taskId: "task-1", kind: "install", phase: "download", critical: false, cancellable: true, percent: 37 },
  })).html;
  assert.doesNotMatch(html, /\sstyle=/u);
  assert.match(html, /<progress[^>]*value="37"/u);
});

test("desktop shell contains one lazy Windows-only software-manager entry and isolated renderer root", () => {
  assert.equal((htmlSource.match(/data-section="softwareManager"/gu) ?? []).length, 1);
  assert.match(htmlSource, /data-section="softwareManager"[^>]*hidden/u);
  assert.match(htmlSource, /id="softwareManager"/u);
  assert.match(htmlSource, /id="softwareManagerRoot"/u);
  assert.ok(htmlSource.indexOf("./software-manager-ui.js") < htmlSource.indexOf("./app.js"));
  assert.match(preloadSource, /softwareManagerPlatform:\s*process\.platform/u);
  assert.match(appSource, /sectionId === "softwareManager"[\s\S]*?ensureSoftwareManagerLoaded/u);
  assert.match(appSource, /onSoftwareManagerEvent/u);
});

test("software-manager layout is responsive and Skills scrolling stays inside its picker", () => {
  assert.match(cssSource, /\.software-manager-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/u);
  assert.match(cssSource, /\.software-skill-list\s*\{[\s\S]*?max-height:[\s\S]*?overflow-y:\s*auto/u);
  assert.match(cssSource, /@media \(max-width:\s*980px\)[\s\S]*?\.software-manager-grid\s*\{[\s\S]*?grid-template-columns:\s*1fr/u);
  assert.match(cssSource, /\.software-tab:focus-visible/u);
});
