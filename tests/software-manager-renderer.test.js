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
    [
      "buildTaskReport", "combineTaskResults", "createInitialState", "defaultSelection", "readSelection", "reduce", "render",
      "renderSkillPicker", "taskResultFeedback",
    ].sort(),
  );
});

test("task completion feedback never reports failed or partial work as completed", () => {
  const ui = loadUi();
  assert.deepEqual({ ...ui.taskResultFeedback({ status: "succeeded" }) }, {
    message: "软件管理任务已完成。", tone: "success",
  });
  assert.deepEqual({ ...ui.taskResultFeedback({ status: "partial" }) }, {
    message: "部分项目处理失败，请查看任务报告。", tone: "error",
  });
  assert.deepEqual({ ...ui.taskResultFeedback({ status: "failed" }) }, {
    message: "软件管理任务失败，请查看任务报告。", tone: "error",
  });
  assert.deepEqual({ ...ui.taskResultFeedback({ status: "cancelled" }) }, {
    message: "软件管理任务已取消。", tone: "info",
  });
});

test("plugin outcomes are included in reports and shortcut warnings stay visible", () => {
  const ui = loadUi();
  const warning = ui.taskResultFeedback({
    status: "succeeded",
    components: [{ componentId: "chatgpt", status: "succeeded", message: "component_shortcut_warning" }],
  });
  assert.equal(warning.tone, "error");

  const report = ui.buildTaskReport({
    snapshot: snapshot({ curatedPlugins: [{ id: "claude-mem", name: "Claude-Mem" }] }),
    lastResult: {
      taskId: "plugin-report",
      kind: "install",
      status: "partial",
      components: [],
      skills: [],
      plugins: [{ componentId: "claude-mem", status: "failed", message: "plugin_install_failed" }],
    },
  });
  assert.match(report, /Claude-Mem/u);
  assert.match(report, /plugin_install_failed/u);
});

test("combined plugin results preserve base failures and cancellations", () => {
  const ui = loadUi();
  const pluginSuccess = [{ componentId: "cowart", status: "succeeded" }];
  assert.equal(ui.combineTaskResults({ status: "failed", components: [], skills: [] }, pluginSuccess, "install").status, "partial");
  assert.equal(ui.combineTaskResults({ status: "cancelled", components: [], skills: [] }, [], "install").status, "cancelled");
  assert.equal(ui.combineTaskResults(null, [{ componentId: "cowart", status: "failed" }], "install").status, "failed");
});

test("software manager restores the agreed 2x2 ChatGPT, V2RayN, Git, and Skills layout", () => {
  const ui = loadUi();
  const { html, state } = rendered(ui);
  assert.deepEqual([...state.selectedComponentIds], ["chatgpt"]);
  assert.match(html, /下载安装/u);
  assert.match(html, /data-software-component="chatgpt"[^>]*checked/u);
  assert.match(html, /<strong>ChatGPT<\/strong>/u);
  assert.match(html, /<strong>V2RayN<\/strong>/u);
  assert.match(html, /<strong>Git<\/strong>/u);
  assert.match(html, /<strong>Skills<\/strong>/u);
  assert.match(html, /data-software-toggle-skills/u);
  assert.doesNotMatch(html, /data-skill-picker-mode="install"/u);

  const expanded = rendered(ui, snapshot(), { type: "toggle-skills" }).html;
  assert.match(expanded, /data-skill-picker-mode="install"/u);
  assert.match(expanded, /搜索 Skill 名称或用途/u);

  let uninstallState = ui.reduce(ui.createInitialState(), { type: "snapshot", snapshot: snapshot({
    skills: [{ componentId: "documents", versionAfter: "1.0.0", status: "succeeded", name: "文档处理" }],
  }) });
  uninstallState = ui.reduce(uninstallState, { type: "tab", tab: "uninstall" });
  uninstallState = ui.reduce(uninstallState, { type: "toggle-skills" });
  const root = { innerHTML: "" };
  ui.render(root, uninstallState);
  const uninstall = root.innerHTML;

  assert.match(uninstall, /data-skill-picker-mode="uninstall"/u);
  assert.match(uninstall, /搜索 Skill 名称或用途/u);
  assert.doesNotMatch(uninstall, /同时删除/u);
});

test("full Codex plugins use the same selectable Skills list while keeping their dedicated execution path", () => {
  const ui = loadUi();
  const plugins = [
    {
      id: "claude-mem", name: "Claude-Mem", description: "旧版冗长介绍", installed: false, managed: false,
      capabilities: ["Skills", "MCP", "Hooks", "Local Worker"],
    },
    {
      id: "cowart", name: "Cowart", description: "旧版冗长介绍", installed: true, managed: false, version: "0.1.25",
      capabilities: ["3 Skills", "MCP", "Canvas Widget"],
    },
  ];
  const install = rendered(ui, snapshot({ curatedPlugins: plugins }), { type: "toggle-skills" }).html;
  assert.match(install, /data-software-plugin="claude-mem"/u);
  assert.doesNotMatch(install, /data-software-plugin="claude-mem"[^>]*disabled/u);
  assert.match(install, /为 Codex 增加跨会话记忆能力。/u);
  assert.match(install, /为 Codex 增加图像生成和画布创作能力。/u);
  assert.doesNotMatch(install, /Skills · MCP · Hooks · Local Worker/u);
  assert.doesNotMatch(install, /3 Skills · MCP · Canvas Widget/u);
  assert.doesNotMatch(install, /data-software-plugin="cowart"[^>]*disabled/u);
  assert.doesNotMatch(install, /旧版冗长介绍/u);
  assert.doesNotMatch(install, /<strong>完整插件<\/strong>/u);
  assert.doesNotMatch(install, /software-plugin-group/u);

  let updateState = ui.reduce(ui.createInitialState(), { type: "snapshot", snapshot: snapshot({ curatedPlugins: plugins }) });
  updateState = ui.reduce(updateState, { type: "tab", tab: "update" });
  const updateRoot = { innerHTML: "" };
  ui.render(updateRoot, updateState);
  const update = updateRoot.innerHTML;
  assert.doesNotMatch(update, /<strong>Skills<\/strong>/u);
  assert.doesNotMatch(update, /data-software-toggle-skills/u);
  assert.doesNotMatch(update, /data-software-plugin/u);

  let uninstallState = ui.reduce(ui.createInitialState(), { type: "snapshot", snapshot: snapshot({
    curatedPlugins: plugins.map((plugin) => plugin.id === "claude-mem" ? { ...plugin, installed: true, managed: true } : plugin),
  }) });
  uninstallState = ui.reduce(uninstallState, { type: "tab", tab: "uninstall" });
  uninstallState = ui.reduce(uninstallState, { type: "toggle-skills" });
  const uninstallRoot = { innerHTML: "" };
  ui.render(uninstallRoot, uninstallState);
  const uninstall = uninstallRoot.innerHTML;
  assert.match(uninstall, /data-software-plugin="claude-mem"/u);
  assert.match(uninstall, /data-software-plugin="cowart"/u);
});

test("stale cached catalog hides every removed Skill and uses concise Chinese descriptions", () => {
  const ui = loadUi();
  const removedIds = [
    "brainstorming", "executing-plans", "finishing-a-development-branch", "hyperframes", "pdf",
    "playwright", "playwright-interactive", "ppt-master", "receiving-code-review", "remotion",
    "requesting-code-review", "systematic-debugging", "test-driven-development", "using-git-worktrees",
    "using-superpowers", "verification-before-completion", "writing-plans",
  ];
  const current = [
    { id: "agent-reach", name: "Agent Reach", description: "old long English description", version: "1.0.0", size: 1 },
    { id: "video-use", name: "Video Use", description: "old long English description", version: "1.0.0", size: 1 },
  ];
  const old = removedIds.map((id) => ({ id, name: id, description: "old English description", version: "1.0.0", size: 1 }));
  const input = snapshot({ catalog: { ...snapshot().catalog, skills: [...old, ...current] } });
  const html = rendered(ui, input, { type: "toggle-skills" }).html;
  for (const id of removedIds) assert.doesNotMatch(html, new RegExp(`data-software-skill="${id}"`, "u"));
  assert.match(html, /帮助跨网页、社交和视频平台检索信息。/u);
  assert.match(html, /帮助完成视频检索、转写、剪辑和渲染。/u);
  assert.doesNotMatch(html, /old long English description/u);
});

test("plugin selection is counted and returned independently from ordinary Skills", () => {
  const ui = loadUi();
  let state = ui.reduce(ui.createInitialState(), { type: "snapshot", snapshot: snapshot({
    curatedPlugins: [{ id: "claude-mem", name: "Claude-Mem", managed: true }],
  }) });
  state = ui.reduce(state, { type: "toggle-plugin", pluginId: "claude-mem", checked: true });
  state = ui.reduce(state, { type: "confirm-open" });
  const root = { innerHTML: "" };
  ui.render(root, state);
  assert.match(root.innerHTML, /已选择 2 项/u);
  assert.match(root.innerHTML, /ChatGPT、Claude-Mem/u);

  const selection = ui.readSelection({
    querySelectorAll(selector) {
      if (selector.includes("data-software-component")) return [];
      if (selector.includes("data-software-skill")) return [{ dataset: { softwareSkill: "documents" } }];
      if (selector.includes("data-software-plugin")) return [{ dataset: { softwarePlugin: "claude-mem" } }];
      return [];
    },
  });
  assert.deepEqual([...selection.skillIds], ["documents"]);
  assert.deepEqual([...selection.pluginIds], ["claude-mem"]);
});

test("late curated-plugin detection preserves the user's open list and current selections", () => {
  const ui = loadUi();
  let state = ui.reduce(ui.createInitialState(), { type: "snapshot", snapshot: snapshot() });
  state = ui.reduce(state, { type: "toggle-skills" });
  state = ui.reduce(state, { type: "toggle-skill", skillId: "documents", checked: true });
  state = ui.reduce(state, { type: "skill-query", query: "文档" });
  state = ui.reduce(state, {
    type: "curated-plugins",
    plugins: [{ id: "claude-mem", name: "Claude-Mem", installed: false }],
  });
  assert.equal(state.skillsExpanded, true);
  assert.equal(state.skillQuery, "文档");
  assert.deepEqual([...state.selectedSkillIds], ["documents"]);
  assert.deepEqual([...state.snapshot.curatedPlugins.map(({ id }) => id)], ["claude-mem"]);
});

test("fresh-machine plugin selection carries ChatGPT as a required dependency", () => {
  const ui = loadUi();
  let state = ui.reduce(ui.createInitialState(), { type: "snapshot", snapshot: snapshot({
    curatedPlugins: [{ id: "claude-mem", name: "Claude-Mem", installed: false }],
  }) });
  state = ui.reduce(state, { type: "toggle-component", componentId: "chatgpt", checked: false });
  assert.deepEqual([...state.selectedComponentIds], []);
  state = ui.reduce(state, { type: "toggle-plugin", pluginId: "claude-mem", checked: true });
  assert.deepEqual([...state.selectedComponentIds], ["chatgpt"]);
  assert.deepEqual([...state.selectedPluginIds], ["claude-mem"]);

  state = ui.reduce(state, { type: "toggle-component", componentId: "chatgpt", checked: false });
  assert.deepEqual([...state.selectedComponentIds], []);
  assert.deepEqual([...state.selectedPluginIds], []);

  let installed = ui.reduce(ui.createInitialState(), { type: "snapshot", snapshot: snapshot({
    components: [component("chatgpt", { installedVersion: "26.814.5517.0" }), component("v2rayn"), component("git")],
    curatedPlugins: [{ id: "claude-mem", name: "Claude-Mem", installed: false }],
  }) });
  installed = ui.reduce(installed, { type: "toggle-component", componentId: "chatgpt", checked: false });
  installed = ui.reduce(installed, { type: "toggle-plugin", pluginId: "claude-mem", checked: true });
  assert.deepEqual([...installed.selectedComponentIds], []);
  assert.deepEqual([...installed.selectedPluginIds], ["claude-mem"]);
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

test("read-only recovery failures still show all four agreed cards instead of a plugin-only page", () => {
  const ui = loadUi();
  const html = rendered(ui, snapshot({
    readOnly: true,
    pendingRecovery: true,
    unavailableReason: "software_manager_startup_failed",
    catalog: { available: false, components: [], skills: [] },
    components: [],
  })).html;
  assert.match(html, /当前仅可查看/u);
  assert.match(html, /<strong>ChatGPT<\/strong>/u);
  assert.match(html, /<strong>V2RayN<\/strong>/u);
  assert.match(html, /<strong>Git<\/strong>/u);
  assert.match(html, /<strong>Skills<\/strong>/u);
});

test("trusted offline catalogs stay usable but are never presented as freshly online", () => {
  const ui = loadUi();
  const bundled = rendered(ui, snapshot({
    catalog: {
      ...snapshot().catalog,
      source: "bundled",
      publishedAt: "2026-08-20T00:00:00.000Z",
      refreshedAt: null,
      refreshError: null,
    },
  })).html;
  assert.match(bundled, /使用内置清单/u);
  assert.match(bundled, /离线清单/u);
  assert.doesNotMatch(bundled, /在线清单已更新/u);
  assert.doesNotMatch(bundled, /当前仅可查看/u);

  const failedRefresh = rendered(ui, snapshot({
    catalog: {
      ...snapshot().catalog,
      source: "cache",
      publishedAt: "2026-08-20T00:00:00.000Z",
      refreshedAt: null,
      refreshError: "catalog_fetch_timeout",
    },
  })).html;
  assert.match(failedRefresh, /在线刷新失败/u);
  assert.match(failedRefresh, /继续使用已验证的本地清单/u);
});

test("local detection failures stay internal without blocking install controls", () => {
  const ui = loadUi();
  const { html } = rendered(ui, snapshot({
    readOnly: false,
    pendingRecovery: true,
  }));

  assert.match(html, /安装服务可用/u);
  assert.doesNotMatch(html, /仍可安装和更新/u);
  assert.doesNotMatch(html, /部分本机状态/u);
  assert.doesNotMatch(html, /当前仅可查看/u);
  assert.doesNotMatch(html, /data-software-component="chatgpt"[^>]* disabled/u);
  assert.doesNotMatch(html, /data-software-choose-root disabled/u);
  assert.doesNotMatch(html, /data-software-start disabled/u);
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
  assert.match(html, /data-software-choose-root/u);
  assert.match(html, /未安装的软件会安装到这里/u);
});

test("progress events render localized transfer details and task reports remain copyable", () => {
  const ui = loadUi();
  let state = ui.reduce(ui.createInitialState(), { type: "snapshot", snapshot: snapshot() });
  state = ui.reduce(state, {
    type: "task-event",
    event: {
      type: "progress", taskId: "task-1", componentId: "chatgpt", phase: "download", percent: 50,
      cancellable: true, message: "software_manager_downloading", downloadedBytes: 50, totalBytes: 100,
      bytesPerSecond: 10,
    },
  });
  const root = { innerHTML: "" };
  ui.render(root, state);
  assert.match(root.innerHTML, /正在下载安装包/u);
  assert.match(root.innerHTML, /50 B \/ 100 B/u);
  assert.match(root.innerHTML, /10 B\/s/u);
  assert.doesNotMatch(root.innerHTML, /software_manager_downloading/u);
  assert.match(root.innerHTML, /data-software-copy-report/u);

  state = ui.reduce(state, {
    type: "task-event",
    event: {
      type: "finished",
      result: {
        taskId: "task-1", kind: "install", status: "failed",
        components: [{ componentId: "chatgpt", status: "failed", message: "network_failed", versionAfter: null }],
        skills: [],
      },
    },
  });
  const report = ui.buildTaskReport(state);
  ui.render(root, state);
  assert.match(report, /软件管理任务报告/u);
  assert.match(report, /状态：失败/u);
  assert.match(report, /ChatGPT：失败/u);
  assert.match(report, /network_failed/u);
  assert.match(root.innerHTML, /software-result-summary failed/u);
  assert.match(root.innerHTML, /0 项成功 · 1 项失败/u);
  assert.match(root.innerHTML, /network_failed/u);
});

test("returned task results are persisted even if the asynchronous finished event is delayed", () => {
  const ui = loadUi();
  let state = ui.reduce(ui.createInitialState(), { type: "snapshot", snapshot: snapshot({
    task: { taskId: "task-2", kind: "install", phase: "commit", cancellable: false, critical: true },
  }) });
  state = ui.reduce(state, {
    type: "task-result",
    result: {
      taskId: "task-2", kind: "install", status: "succeeded",
      components: [{
        componentId: "chatgpt", status: "succeeded", versionAfter: "26.721.11231.0",
        details: { installPath: "C:\\CBApps\\c" },
      }],
      skills: [],
    },
  });
  const root = { innerHTML: "" };
  ui.render(root, state);
  assert.equal(state.snapshot.task, null);
  assert.match(root.innerHTML, /安装成功/u);
  assert.match(root.innerHTML, /1 项成功 · 0 项失败/u);
  assert.match(root.innerHTML, /C:\\CBApps\\c/u);
  assert.match(appSource, /startSoftwareManagerTask\(request\)[\s\S]*?task-result/u);
});

test("snapshot events refresh the selected installation path without dropping curated plugins", () => {
  const ui = loadUi();
  const curatedPlugins = [{ id: "claude-mem", name: "Claude-Mem" }];
  let state = ui.reduce(ui.createInitialState(), {
    type: "snapshot",
    snapshot: snapshot({ installRootPath: "C:\\Old", curatedPlugins }),
  });
  state = ui.reduce(state, {
    type: "task-event",
    event: { type: "snapshot", snapshot: snapshot({ installRootPath: "D:\\New" }) },
  });

  assert.equal(state.snapshot.installRootPath, "D:\\New");
  assert.deepEqual(state.snapshot.curatedPlugins, curatedPlugins);
});

test("installed components expose a trusted open-folder action", () => {
  const ui = loadUi();
  const input = snapshot({
    components: [
      component("chatgpt", { installedVersion: "26.721.11231.0", installPath: "D:\\CBApps\\c" }),
      component("v2rayn"), component("git"),
    ],
  });
  const html = rendered(ui, input).html;
  assert.match(html, /data-software-open-folder="D:\\CBApps\\c"/u);
  assert.match(html, /打开安装目录/u);
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

  const indeterminate = rendered(ui, snapshot({
    task: { taskId: "task-2", kind: "install", phase: "extract", critical: false, cancellable: true, percent: null },
  })).html;
  assert.match(indeterminate, /software-progress indeterminate/u);
  assert.match(indeterminate, /<progress max="100" aria-label="任务正在进行"/u);
  assert.doesNotMatch(indeterminate, /<progress[^>]*value=/u);
  assert.match(indeterminate, /较大的安装包可能需要数分钟/u);
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
  assert.match(appSource, /data-software-toggle-skills[\s\S]*?toggle-skills/u);
  assert.match(appSource, /mainScroller\.scrollTop\s*=\s*0/u);
  const ensureStart = appSource.indexOf("async function ensureSoftwareManagerLoaded");
  const ensureEnd = appSource.indexOf("async function startConfirmedSoftwareManagerTask", ensureStart);
  const ensureSource = appSource.slice(ensureStart, ensureEnd);
  assert.match(ensureSource, /getSoftwareManagerSnapshot/u);
  assert.ok(ensureSource.indexOf('type: "snapshot"') < ensureSource.indexOf("refreshSoftwareManagerCuratedPlugins()"));
  assert.match(ensureSource, /api\.refreshSoftwareManager\(\)/u);
  assert.ok(ensureSource.indexOf("api.refreshSoftwareManager()") < ensureSource.indexOf("if (!snapshot?.catalog?.available)"));
});

test("unrelated desktop state broadcasts do not rebuild an active software-manager interaction subtree", () => {
  const activeStart = appSource.indexOf("function renderActiveSection");
  const activeEnd = appSource.indexOf("\nfunction renderDoubleQuota", activeStart);
  const activeSource = appSource.slice(activeStart, activeEnd);
  assert.match(
    activeSource,
    /sectionId === "softwareManager"[\s\S]*?if \(!softwareManagerLoaded && !softwareManagerLoading\) \{[\s\S]*?renderSoftwareManager\(\);[\s\S]*?\}/u,
  );
  assert.doesNotMatch(
    activeSource,
    /sectionId === "softwareManager"\) \{\s*renderSoftwareManager\(\);/u,
  );
});

test("managed results stay pending until selected curated plugins finish", () => {
  assert.match(appSource, /let softwareManagerPendingPluginIds = \[\];/u);
  assert.match(appSource, /let softwareManagerCombinedResultPending = false;/u);
  assert.match(appSource, /const softwareManagerCombinedTaskIds = new Set\(\);/u);
  assert.match(
    appSource,
    /event\?\.type === "finished" && softwareManagerCombinedResultPending[\s\S]*?softwareManagerPendingPluginIds\.length > 0 \? "plugin" : "finishing"[\s\S]*?"正在准备完整插件"/u,
  );
  const start = appSource.indexOf("async function startConfirmedSoftwareManagerTask");
  const end = appSource.indexOf("\nsoftwareManagerRoot?.addEventListener", start);
  const operation = appSource.slice(start, end);
  assert.ok(operation.indexOf("softwareManagerPendingPluginIds = [...pluginIds]") < operation.indexOf("api.startSoftwareManagerTask(request)"));
  assert.match(operation, /softwareManagerCombinedTaskIds\.add\(combined\.taskId\)/u);
  assert.match(operation, /api\.runCuratedCodexPluginTask\(\{[\s\S]*?kind: request\.kind,[\s\S]*?pluginIds/u);
  assert.match(operation, /if \(request\.kind === "uninstall"\) await runSelectedPlugins\(\);[\s\S]*?!pluginTaskBlockedCore[\s\S]*?result = await api\.startSoftwareManagerTask\(request\);[\s\S]*?request\.kind !== "uninstall" && !managedTaskCancelled/u);
  assert.match(operation, /software_manager_blocked_by_plugin_failure/u);
  assert.ok(operation.indexOf("softwareManagerPendingPluginIds = []") < operation.indexOf('type: "task-result"'));
});

test("software-manager layout is responsive and Skills scrolling stays inside its picker", () => {
  assert.match(cssSource, /\.software-manager-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/u);
  assert.match(cssSource, /\.software-skill-list\s*\{[\s\S]*?max-height:[\s\S]*?overflow-y:\s*auto/u);
  assert.match(cssSource, /@media \(max-width:\s*980px\)[\s\S]*?\.software-manager-grid\s*\{[\s\S]*?grid-template-columns:\s*1fr/u);
  assert.match(cssSource, /\.software-tab:focus-visible/u);
  assert.match(cssSource, /\.software-progress\.indeterminate::after/u);
  const updateStart = appSource.indexOf("function updateSoftwareManager");
  const updateEnd = appSource.indexOf("\nasync function refreshSoftwareManagerCuratedPlugins", updateStart);
  const updateSource = appSource.slice(updateStart, updateEnd);
  assert.match(updateSource, /priorSkillScrollTop/u);
  assert.match(updateSource, /nextSkillList\.scrollTop = priorSkillScrollTop/u);
  assert.match(updateSource, /focus\?\.\(\{ preventScroll: true \}\)/u);
});
