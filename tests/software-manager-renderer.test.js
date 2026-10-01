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

test("rollback failure feedback explains the missing backup and carries a copyable diagnostic report", () => {
  const ui = loadUi();
  const outcome = { taskId: "software-rollback-missing", kind: "rollback", status: "failed", components: [{
    componentId: "chatgpt", action: "rollback", status: "failed", message: "rollback_slot_missing",
    versionBefore: "26.917.9434.0", versionAfter: null, rollbackAvailable: false,
  }], skills: [] };
  const feedback = ui.taskResultFeedback(outcome, { lastResult: outcome, snapshot: snapshot() });
  assert.match(feedback.message, /上一版本.*(缺失|不存在|找不到)/u);
  assert.match(feedback.copyText, /software-rollback-missing/u);
  assert.match(feedback.copyText, /rollback_slot_missing/u);
  assert.match(feedback.copyText, /26\.917\.9434\.0/u);
});

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

test("all software-management tabs expose only the Codex component", () => {
  const ui = loadUi();
  const data = snapshot({ components: [component("chatgpt", { installedVersion: "1.0.0", updateState: "update-available" }), component("git"), component("v2rayn")], curatedPlugins: [{ id: "cowart", name: "Cowart", installed: true }] });
  for (const tab of ["install", "update", "uninstall"]) {
    const { html } = rendered(ui, data, { type: "tab", tab });
    assert.deepEqual([...html.matchAll(/data-software-component="([^"]+)"/gu)].map(match => match[1]), ["chatgpt"]);
    assert.match(html, /<strong>Codex<\/strong>/u);
    assert.doesNotMatch(html, /V2RayN|VPN|\bGit\b|Skills|Skill 列表|Cowart|data-software-skill|data-software-plugin/u);
  }
});

test("legacy snapshot selections cannot retain retired software, Skills or plugins", () => {
  const ui = loadUi();
  let state = rendered(ui).state;
  state = { ...state, selectedComponentIds: ["chatgpt", "git", "v2rayn"], selectedSkillIds: ["documents"], selectedPluginIds: ["cowart"], skillsExpanded: true };
  state = ui.reduce(state, { type: "snapshot", snapshot: snapshot({ curatedPlugins: [{ id: "cowart", installed: true }] }) });
  assert.deepEqual([...state.selectedComponentIds], ["chatgpt"]);
  assert.deepEqual([...state.selectedSkillIds], []);assert.deepEqual([...state.selectedPluginIds], []);
  state = ui.reduce(state, { type: "toggle-plugin", pluginId: "cowart", checked: true });
  state = ui.reduce(state, { type: "toggle-skill", skillId: "documents", checked: true });
  state = ui.reduce(state, { type: "toggle-component", componentId: "git", checked: true });
  assert.deepEqual([...state.selectedComponentIds], ["chatgpt"]);
  assert.deepEqual([...state.selectedSkillIds], []);assert.deepEqual([...state.selectedPluginIds], []);
});

test("confirmation reads only Codex even if stale retired checkboxes remain in the DOM", () => {
  const ui = loadUi();
  const root = { querySelectorAll(selector) { return selector.startsWith("[data-software-component]")
    ? [{ dataset: { softwareComponent: "chatgpt" } }, { dataset: { softwareComponent: "git" } }]
    : selector.startsWith("[data-software-skill]") ? [{ dataset: { softwareSkill: "documents" } }]
      : [{ dataset: { softwarePlugin: "cowart" } }]; } };
  const selected = ui.readSelection(root, rendered(ui).state);
  assert.deepEqual([...selected.componentIds], ["chatgpt"]);
  assert.deepEqual([...selected.skillIds], []);assert.deepEqual([...selected.pluginIds], []);
});

function appFunction(name) {
  const found = new RegExp(`^(?:async )?function ${name}\\(`, "mu").exec(appSource);
  if (!found) return "";
  return appSource.slice(found.index, appSource.indexOf("\n}", found.index) + 2);
}

function codexSubmissionHarness(componentIds = ["chatgpt", "git"]) {
  const ui = loadUi(), calls = [];
  const context = {
    softwareManagerUi: ui,
    softwareManagerState: { ...rendered(ui).state, selectedComponentIds: componentIds, selectedSkillIds: ["documents"], selectedPluginIds: ["cowart"] },
    api: {
      startSoftwareManagerTask: async request => { calls.push({ type: "managed", request }); return { taskId: "codex-test", kind: request.kind, status: "succeeded", components: [{ componentId: "chatgpt", status: "succeeded" }], skills: [] }; },
      runCuratedCodexPluginTask: async () => { calls.push({ type: "plugin" }); return { plugins: [{ componentId: "cowart", status: "succeeded" }] }; },
    },
    refreshSoftwareManager: async () => {}, showToast: () => {},
    updateSoftwareManager: action => { context.softwareManagerState = ui.reduce(context.softwareManagerState, action); },
  };
  vm.runInNewContext(`${appFunction("startConfirmedSoftwareManagerTask")}\nthis.start = startConfirmedSoftwareManagerTask;`, context);
  return { context, calls };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function completedTask(taskId = "task-a", status = "succeeded") {
  return { taskId, kind: "install", status, components: [{ componentId: "chatgpt", status, message: "component_committed" }], skills: [] };
}

function startEnabled(ui, state) {
  const root = { innerHTML: "" }; ui.render(root, state);
  const button = root.innerHTML.match(/<button[^>]*data-software-start[^>]*>/u)?.[0];
  return Boolean(button && !/\sdisabled(?:\s|=|>)/u.test(button));
}

function raceHarness() {
  const value = codexSubmissionHarness(["chatgpt"]);
  Object.assign(value.context, {
    softwareManagerLoaded: true, softwareManagerLoading: false,
    softwareManagerRefreshPromise: null, softwareManagerEventUnsubscribe: null,
  });
  const notices = [];
  value.context.showToast = (message, tone) => notices.push({ message, tone });
  value.context.api.refreshSoftwareManager = async () => snapshot();
  value.context.api.getSoftwareManagerSnapshot = async () => snapshot();
  value.context.api.softwareManagerPlatform = "win32";
  value.context.api.onSoftwareManagerEvent = listener => { value.event = listener; return () => {}; };
  vm.runInNewContext(`${appFunction("refreshSoftwareManager")}\n${appFunction("ensureSoftwareManagerLoaded")}`, value.context);
  return { ...value, notices };
}

test("task races: an older refresh cannot clear a pending submission or permit duplicate clicks", async () => {
  const { context, calls } = raceHarness();
  const old = deferred(), install = deferred(); let reads = 0;
  context.api.refreshSoftwareManager = () => ++reads === 1 ? old.promise : Promise.resolve(snapshot());
  context.api.startSoftwareManagerTask = request => { calls.push(request); return install.promise; };
  const refresh = context.refreshSoftwareManager();
  const running = context.start();
  assert.equal(context.softwareManagerState.snapshot.task.phase, "starting");
  try {
    old.resolve(snapshot()); await refresh;
    assert.equal(startEnabled(context.softwareManagerUi, context.softwareManagerState), false);
    assert.equal(context.softwareManagerState.snapshot.task.phase, "starting");
    for (let index = 0; index < 10; index++) void context.start();
    assert.equal(calls.length, 1);
  } finally { install.resolve(completedTask()); await running; }
});

test("task races: a rejected older refresh cannot replace the current task with an error", async () => {
  const { context } = raceHarness(); const old = deferred(), install = deferred(); let reads = 0;
  context.api.refreshSoftwareManager = () => ++reads === 1 ? old.promise : Promise.resolve(snapshot());
  context.api.startSoftwareManagerTask = () => install.promise;
  const refresh = context.refreshSoftwareManager(); const running = context.start();
  try {
    old.reject(new Error("stale refresh error")); await refresh;
    assert.equal(context.softwareManagerState.error, null);
    assert.equal(context.softwareManagerState.snapshot.task.phase, "starting");
  } finally { install.resolve(completedTask()); await running; }
});

test("task races: finishing during an older refresh obtains a fresh installed version", async () => {
  const { context } = raceHarness(); const old = deferred(); let reads = 0;
  context.api.refreshSoftwareManager = () => ++reads === 1 ? old.promise : Promise.resolve(snapshot({
    components: [component("chatgpt", { installedVersion: "2.0.0", updateState: "current" })],
  }));
  const refreshing = context.refreshSoftwareManager();
  const running = context.start(); await new Promise(resolve => setImmediate(resolve));
  old.resolve(snapshot()); await Promise.all([refreshing, running]);
  assert.equal(context.softwareManagerState.snapshot.components[0].installedVersion, "2.0.0");
  assert.equal(context.softwareManagerState.lastResult.status, "succeeded");
  assert.equal(reads, 2);
});

test("task races: old progress, completion and RPC results cannot affect the next task", () => {
  const ui = loadUi();
  for (const bound of [false, true]) {
    let state = ui.reduce(rendered(ui).state, { type: "task-result", result: completedTask() });
    state = ui.reduce(state, { type: "task-starting", taskId: "starting-b", kind: "install", componentId: "chatgpt" });
    if (bound) state = ui.reduce(state, { type: "task-event", event: { type: "progress", taskId: "task-b", componentId: "chatgpt", phase: "download", percent: 25, cancellable: true } });
    for (const action of [
      { type: "task-event", event: { type: "finished", taskId: "task-a", result: completedTask() } },
      { type: "task-event", event: { type: "progress", taskId: "task-a", phase: "commit", critical: true, message: "old log" } },
      { type: "task-result", result: completedTask() },
    ]) {
      const next = ui.reduce(state, action);
      assert.equal(next, state, `${bound}: ${action.event?.type || action.type}`);
      assert.equal(startEnabled(ui, next), false);
    }
  }
});

test("task races: completed tasks cannot be resurrected by stale progress or snapshots", () => {
  const ui = loadUi();
  const state = ui.reduce(rendered(ui).state, { type: "task-result", result: completedTask() });
  for (const action of [
    { type: "task-event", event: { type: "progress", taskId: "task-a", phase: "download" } },
    { type: "snapshot", snapshot: snapshot({ task: { taskId: "task-a", phase: "download" } }) },
  ]) {
    const next = ui.reduce(state, action);
    assert.equal(next.snapshot.task, null);
    assert.equal(next.lastResult.taskId, "task-a");
  }
});

test("task races: a matching finish stays non-interactive until its own IPC settles", async () => {
  const { context, calls } = raceHarness(); const install = deferred();
  context.api.startSoftwareManagerTask = request => { calls.push(request); return install.promise; };
  const running = context.start();
  try {
    context.updateSoftwareManager({ type: "task-event", event: { type: "progress", taskId: "task-a", phase: "download", cancellable: true } });
    context.updateSoftwareManager({ type: "task-event", event: { type: "finished", taskId: "task-a", result: completedTask() } });
    assert.equal(startEnabled(context.softwareManagerUi, context.softwareManagerState), false);
    assert.equal(context.softwareManagerState.snapshot.task.phase, "finishing");
    for (let index = 0; index < 10; index++) void context.start();
    assert.equal(calls.length, 1);
  } finally { install.resolve(completedTask()); await running; }
  assert.equal(context.softwareManagerState.snapshot.task, null);
  assert.equal(context.softwareManagerState.lastResult.status, "succeeded");
});

test("task races: an unbound finish cannot settle a local submission before its reply", async () => {
  const { context } = raceHarness(); const install = deferred();
  context.api.startSoftwareManagerTask = () => install.promise;
  const running = context.start();
  try {
    context.updateSoftwareManager({ type: "task-event", event: { type: "finished", taskId: "unrelated-task", result: completedTask("unrelated-task") } });
    assert.equal(context.softwareManagerState.snapshot.task.phase, "starting");
    assert.equal(context.softwareManagerState.lastResult, null);
  } finally { install.resolve(completedTask("task-b")); await running; }
  assert.equal(context.softwareManagerState.lastResult.taskId, "task-b");
});

test("task races: accepted completion is preserved when the matching IPC rejects", async () => {
  const { context } = raceHarness(); const install = deferred();
  context.api.startSoftwareManagerTask = () => install.promise;
  const running = context.start();
  context.updateSoftwareManager({ type: "task-event", event: { type: "progress", taskId: "task-a", phase: "commit", critical: true } });
  context.updateSoftwareManager({ type: "task-event", event: { type: "finished", taskId: "task-a", result: completedTask() } });
  install.reject(new Error("IPC reply failed"));
  const outcome = await running;
  assert.equal(outcome.status, "succeeded");
  assert.equal(context.softwareManagerState.lastResult.status, "succeeded");
  assert.equal(context.softwareManagerState.snapshot.task, null);
});

test("task races: a delayed snapshot cannot downgrade running progress or erase its log", () => {
  const ui = loadUi();
  const state = ui.reduce(rendered(ui).state, { type: "task-event", event: { type: "progress", taskId: "task-b", phase: "download", percent: 65, message: "current download", cancellable: true } });
  for (const task of [null, { taskId: "task-b", phase: "prepare" }, { taskId: "old-task", phase: "commit" }]) {
    const next = ui.reduce(state, { type: "task-event", event: { type: "snapshot", snapshot: snapshot({ task }) } });
    assert.equal(next.snapshot.task.taskId, "task-b");
    assert.equal(next.snapshot.task.percent, 65);
    assert.equal(next.snapshot.logs.at(-1), "current download");
  }
});

test("task races: a presentation failure still refreshes the confirmed installation", async () => {
  const { context } = raceHarness(); let notices = 0;
  context.showToast = () => { if (++notices === 1) throw new Error("toast failed"); };
  context.api.refreshSoftwareManager = async () => snapshot({ components: [component("chatgpt", { installedVersion: "2.0.0" })] });
  const outcome = await context.start();
  assert.equal(outcome.status, "succeeded");
  assert.equal(context.softwareManagerState.lastResult.status, "succeeded");
  assert.equal(context.softwareManagerState.snapshot.components[0].installedVersion, "2.0.0");
});

test("task races: a result from another local submission cannot settle the current one", () => {
  const ui = loadUi();
  let state = ui.reduce(rendered(ui).state, { type: "task-starting", taskId: "starting-b", submissionId: "submission-b" });
  const next = ui.reduce(state, { type: "task-result", submissionId: "submission-a", result: completedTask() });
  assert.equal(next, state);
  state = ui.reduce(state, { type: "task-result", submissionId: "submission-b", result: completedTask("task-b") });
  assert.equal(state.snapshot.task, null);
  assert.equal(state.submissionId, null);
  assert.equal(state.lastResult.taskId, "task-b");
});

test("task races: matching failure and cancellation replies release controls for retry", async () => {
  for (const status of ["succeeded", "failed", "cancelled"]) {
    const { context } = raceHarness();
    context.api.startSoftwareManagerTask = async () => completedTask("task-a", status);
    await context.start();
    assert.equal(context.softwareManagerState.snapshot.task, null);
    assert.equal(context.softwareManagerState.submissionId, null);
    assert.equal(context.softwareManagerState.lastResult.status, status);
    assert.equal(startEnabled(context.softwareManagerUi, context.softwareManagerState), true);
  }
});

test("task races: the initial background refresh cannot unlock a just-submitted install", async () => {
  const { context } = raceHarness(); const old = deferred(), install = deferred(); let reads = 0;
  context.softwareManagerLoaded = false;
  context.softwareManagerState = context.softwareManagerUi.createInitialState();
  context.api.refreshSoftwareManager = () => ++reads === 1 ? old.promise : Promise.resolve(snapshot());
  context.api.startSoftwareManagerTask = () => install.promise;
  const loading = context.ensureSoftwareManagerLoaded();
  await new Promise(resolve => setImmediate(resolve));
  const running = context.start();
  try {
    old.resolve(snapshot()); await loading;
    assert.equal(context.softwareManagerState.snapshot.task.phase, "starting");
    assert.equal(startEnabled(context.softwareManagerUi, context.softwareManagerState), false);
  } finally { install.resolve(completedTask()); await running; }
  assert.equal(context.softwareManagerState.snapshot.task, null);
});

test("task races: ignored completion events do not launch another background refresh", async () => {
  const { context } = raceHarness(); let listener, reads = 0;
  context.softwareManagerLoaded = false;
  context.api.onSoftwareManagerEvent = handler => { listener = handler; return () => {}; };
  context.api.refreshSoftwareManager = async () => { reads++; return snapshot(); };
  await context.ensureSoftwareManagerLoaded();
  context.updateSoftwareManager({ type: "task-result", result: completedTask() });
  context.updateSoftwareManager({ type: "task-starting", taskId: "starting-b", kind: "install" });
  const before = context.softwareManagerState;
  listener({ type: "finished", taskId: "task-a", result: completedTask() });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.softwareManagerState, before);
  assert.equal(reads, 1);
});

test("task races: a fresh read recovers an observed task whose completion event was missed", async () => {
  const { context } = raceHarness();
  context.softwareManagerState = rendered(context.softwareManagerUi, snapshot({ task: { taskId: "observed-a", phase: "download", kind: "install", cancellable: true } })).state;
  context.api.refreshSoftwareManager = async () => snapshot({ components: [component("chatgpt", { installedVersion: "2.0.0" })] });
  await context.refreshSoftwareManager();
  assert.equal(context.softwareManagerState.snapshot.task, null);
  assert.equal(context.softwareManagerState.snapshot.components[0].installedVersion, "2.0.0");
  context.updateSoftwareManager({ type: "task-event", event: { type: "progress", taskId: "observed-a", phase: "download" } });
  assert.equal(context.softwareManagerState.snapshot.task, null);
});

test("task races: a fresh read never downgrades progress for the same observed task", async () => {
  const { context } = raceHarness();
  context.updateSoftwareManager({ type: "task-event", event: { type: "progress", taskId: "observed-a", phase: "download", percent: 80, cancellable: true } });
  context.api.refreshSoftwareManager = async () => snapshot({ task: { taskId: "observed-a", phase: "prepare", kind: "install" } });
  await context.refreshSoftwareManager();
  assert.equal(context.softwareManagerState.snapshot.task.phase, "download");
  assert.equal(context.softwareManagerState.snapshot.task.percent, 80);
});

test("task races: a reconciled task may receive its first late result while no newer task exists", () => {
  const ui = loadUi();
  let state = rendered(ui, snapshot({ task: { taskId: "observed-a", phase: "download", kind: "install" } })).state;
  state = ui.reduce(state, { type: "snapshot", expectedTaskRevision: state.taskRevision, snapshot: snapshot() });
  assert.equal(state.snapshot.task, null);
  const failure = { ...completedTask("observed-a", "failed"), components: [{ componentId: "chatgpt", status: "failed", message: "disk_full" }] };
  const finished = { type: "task-event", event: { type: "finished", taskId: "observed-a", result: failure } };
  state = ui.reduce(state, finished);
  assert.equal(state.lastResult?.status, "failed");
  assert.equal(state.lastResult?.components[0].message, "disk_full");
  assert.equal(ui.reduce(state, finished), state);
});

test("task races: late results from a reconciled task cannot replace a newer task result", () => {
  const ui = loadUi();
  let state = rendered(ui, snapshot({ task: { taskId: "observed-a", phase: "download" } })).state;
  state = ui.reduce(state, { type: "snapshot", expectedTaskRevision: state.taskRevision, snapshot: snapshot() });
  state = ui.reduce(state, { type: "task-starting", taskId: "starting-b", submissionId: "submission-b" });
  state = ui.reduce(state, { type: "task-result", submissionId: "submission-b", result: completedTask("task-b") });
  const next = ui.reduce(state, { type: "task-event", event: { type: "finished", taskId: "observed-a", result: completedTask("observed-a", "failed") } });
  assert.equal(next, state);
  assert.equal(next.lastResult.taskId, "task-b");
});

test("Codex submission strips stale retired choices and never invokes the plugin task path", async () => {
  const { context, calls } = codexSubmissionHarness();
  const result = await context.start();
  assert.equal(result.status, "succeeded");
  assert.equal(calls.filter(call => call.type === "plugin").length, 0);
  const requests = calls.filter(call => call.type === "managed");
  assert.equal(requests.length, 1);
  assert.deepEqual([...requests[0].request.componentIds], ["chatgpt"]);
  assert.deepEqual([...requests[0].request.skillIds], []);
});

test("retired-only stale selections cannot submit a task", async () => {
  const { context, calls } = codexSubmissionHarness(["git"]);
  await context.start();
  assert.deepEqual(calls, []);
  assert.equal(context.softwareManagerState.snapshot.task, null);
});

test("opening software management does not perform plugin discovery", async () => {
  const ui = loadUi();let pluginLookups = 0;
  const context = {
    softwareManagerUi: ui, softwareManagerState: ui.createInitialState(),
    softwareManagerLoaded: false, softwareManagerLoading: false, softwareManagerEventUnsubscribe: null,
    api: { softwareManagerPlatform: "win32", getSoftwareManagerSnapshot: async () => snapshot(), refreshSoftwareManager: async () => snapshot(), onSoftwareManagerEvent: () => () => {}, listCuratedCodexPlugins: async () => { pluginLookups++;return []; } },
    updateSoftwareManager: action => { context.softwareManagerState = ui.reduce(context.softwareManagerState, action); },
    refreshSoftwareManager: async () => {},
  };
  vm.runInNewContext(`${appFunction("ensureSoftwareManagerLoaded")}\nthis.load = ensureSoftwareManagerLoaded;`, context);
  await context.load();
  assert.equal(pluginLookups, 0);assert.equal(context.softwareManagerLoaded, true);
});

test("task outcome summary accounts for cancelled and skipped components, skills and plugins", () => {
  const ui = loadUi();
  for (const statuses of [['cancelled','cancelled'], ['skipped','skipped'], ['succeeded','failed','cancelled','skipped']]) {
    const entries = statuses.map((status,index) => ({componentId:`item-${index}`,status,message:status}));
    const {html,state} = rendered(ui, snapshot(), {type:'task-result',result:{taskId:'summary-test',kind:'install',status:'partial',
      components:entries.slice(0,2),skills:entries.slice(2,3),plugins:entries.slice(3)}});
    const summary = html.match(/<div class="software-result-summary[^"]*"[^>]*>([\s\S]*?)<\/div>/u)?.[1] || '';
    for (const [status,label] of [['succeeded','成功'],['failed','失败'],['cancelled','已取消'],['skipped','无需处理']]) {
      const count = statuses.filter(value => value === status).length;
      if (count) assert.ok(summary.includes(`${count} 项${label}`), status);
    }
    assert.doesNotMatch(summary, /0 项(?:成功|失败)/u);
    assert.equal(state.lastResult.status, 'partial', 'presentation must not change the authoritative task status');
  }
});

test("installation location exposes the complete escaped path in its tooltip", () => {
  const html = rendered(loadUi(), snapshot({installRootPath:'D:\\Tools & Models\\CBApps'})).html;
  assert.ok(html.includes('class="software-install-root-value" title="D:\\Tools &amp; Models\\CBApps"'));
});

test("renderer module exposes the fixed state, rendering, and selection surface", () => {
  const ui = loadUi();
  assert.deepEqual(
    Object.keys(ui).sort(),
    [
      "buildTaskReport", "combineTaskResults", "createInitialState", "defaultSelection", "readSelection", "reduce", "render",
      "taskResultFeedback",
    ].sort(),
  );
});

test("task completion feedback never reports failed or partial work as completed", () => {
  const ui = loadUi();
  assert.deepEqual({ ...ui.taskResultFeedback({ status: "succeeded" }) }, {
    message: "软件管理任务已完成。", tone: "success",
  });
  const { copyText: partialReport, ...partialFeedback } = ui.taskResultFeedback({ status: "partial" });
  assert.match(partialReport, /部分失败/u);
  assert.deepEqual(partialFeedback, {
    message: "部分项目处理失败，请查看任务报告。", tone: "error",
  });
  const { copyText: failureReport, ...failureFeedback } = ui.taskResultFeedback({ status: "failed" });
  assert.match(failureReport, /状态：失败/u);
  assert.deepEqual(failureFeedback, {
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

test("Codex uses the entire software-management grid without an empty companion card", () => {
  const ui = loadUi();
  const { html, state } = rendered(ui);
  assert.deepEqual([...state.selectedComponentIds], ["chatgpt"]);
  assert.match(html, /software-manager-grid software-manager-codex-only/u);
  assert.equal((html.match(/class="software-component-card/gu) ?? []).length, 1);
  assert.match(html, /data-software-component="chatgpt"[^>]*checked/u);
  assert.doesNotMatch(html, /data-software-toggle-skills|software-skills-drawer|data-software-register/u);
});

test("confirmation honors visible Codex deselection and does not mutate the draft", () => {
  const ui = loadUi();
  const state = { ...rendered(ui).state, selectedSkillIds: ["documents"], selectedPluginIds: ["cowart"] };
  const before = JSON.stringify(state);
  for (const checked of [true, false]) {
    const root = { querySelectorAll: () => checked ? [{ dataset: { softwareComponent: "chatgpt" } }] : [] };
    const selection = ui.readSelection(root, state);
    assert.deepEqual([...selection.componentIds], checked ? ["chatgpt"] : []);
    assert.deepEqual([...selection.skillIds], []);
    assert.deepEqual([...selection.pluginIds], []);
    assert.equal(JSON.stringify(state), before);
  }
});

test("confirmation cannot open without Codex or while operations are unavailable", () => {
  const ui = loadUi();
  const empty = { ...ui.createInitialState(), snapshot: snapshot() };
  const ready = { ...empty, selectedComponentIds: ["chatgpt"] };
  for (const state of [ui.createInitialState(), empty,
    { ...empty, selectedComponentIds: ["git"], selectedSkillIds: ["documents"], selectedPluginIds: ["cowart"] },
    { ...ready, snapshot: { ...ready.snapshot, readOnly: true } },
    { ...ready, snapshot: { ...ready.snapshot, task: { taskId: "running" } } },
  ]) assert.equal(ui.reduce(state, { type: "confirm-open" }).confirmationPending, false);
  assert.equal(ui.reduce(ready, { type: "confirm-open" }).confirmationPending, true);
});

test("background state changes preserve Codex focus only within the active management page", () => {
  for (const section of ["softwareManager", "logs"]) {
    for (const focused of [false, true]) {
      const ui = loadUi();
      let renders = 0, focusCalls = 0;
      const active = { matches: () => focused };
      const context = {
        softwareManagerUi: ui, softwareManagerState: rendered(ui).state,
        softwareManagerRoot: { contains: () => true, querySelector: () => ({ focus: () => focusCalls++ }) },
        document: { activeElement: active }, currentSectionId: () => section,
        renderSoftwareManager: () => renders++,
      };
      vm.runInNewContext(appFunction("updateSoftwareManager"), context);
      context.updateSoftwareManager({ type: "install-root", token: "new-root" });
      assert.equal(context.softwareManagerState.installRootToken, "new-root");
      assert.equal(renders, section === "softwareManager" ? 1 : 0);
      assert.equal(focusCalls, section === "softwareManager" && focused ? 1 : 0);
    }
  }
});

test("task submission immediately publishes a local starting state that blocks duplicate clicks", () => {
  const ui = loadUi();
  let state = ui.reduce(ui.createInitialState(), { type: "snapshot", snapshot: snapshot() });
  state = ui.reduce(state, {
    type: "task-starting",
    taskId: "software-starting-test",
    kind: "install",
    componentId: "chatgpt",
  });
  assert.deepEqual({ ...state.snapshot.task }, {
    taskId: "software-starting-test",
    kind: "install",
    phase: "starting",
    componentId: "chatgpt",
    percent: null,
    critical: false,
    cancellable: false,
    downloadedBytes: null,
    totalBytes: null,
    bytesPerSecond: null,
  });
  const root = { innerHTML: "" };
  ui.render(root, state);
  assert.match(root.innerHTML, /正在启动/u);
  const startButton = root.innerHTML.match(/<button[^>]*data-software-start[^>]*>/u);
  assert.ok(!startButton || /\sdisabled(?:\s|=|>)/u.test(startButton[0]), "a running task must not expose an enabled start action");
  const duplicate = ui.reduce(state, { type: "task-starting", taskId: "duplicate" });
  assert.equal(duplicate, state);
});

test("late legacy plugin discovery cannot reopen removed controls or select Codex as a dependency", () => {
  const ui = loadUi();
  let state = rendered(ui).state;
  state = ui.reduce(state, { type: "toggle-component", componentId: "chatgpt", checked: false });
  state = ui.reduce(state, { type: "toggle-plugin", pluginId: "cowart", checked: true });
  state = ui.reduce(state, { type: "toggle-skills" });
  state = ui.reduce(state, { type: "skill-query", query: "cowart" });
  state = ui.reduce(state, { type: "curated-plugins", plugins: [{ id: "cowart", name: "Cowart", installed: true }] });
  assert.deepEqual([...state.selectedComponentIds], []);
  assert.deepEqual([...state.selectedSkillIds], []);
  assert.deepEqual([...state.selectedPluginIds], []);
  assert.equal(state.skillsExpanded, false);
  assert.equal(state.skillQuery, "");
  const root = { innerHTML: "" }; ui.render(root, state);
  assert.doesNotMatch(root.innerHTML, /Cowart|data-software-plugin|data-software-skill/u);
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

test("legacy rollback records cannot expose a retired-component rollback tab", () => {
  const ui = loadUi();
  const input = snapshot({ tabs: ["install", "update", "uninstall", "rollback"], rollback: [{ id: "v2rayn", version: "2", previousVersion: "1" }] });
  const { html, state } = rendered(ui, input, { type: "tab", tab: "rollback" });
  assert.doesNotMatch(html, /data-software-tab="rollback"/u);
  assert.equal(state.activeTab, "install");
});

test("read-only recovery failures still show only the Codex card", () => {
  const html = rendered(loadUi(), snapshot({
    readOnly: true, pendingRecovery: true, unavailableReason: "software_manager_startup_failed",
    catalog: { available: false, components: [], skills: [] }, components: [],
  })).html;
  assert.match(html, /当前仅可查看/u);
  assert.match(html, /<strong>Codex<\/strong>/u);
  assert.equal((html.match(/class="software-component-card/gu) ?? []).length, 1);
  assert.doesNotMatch(html, /V2RayN|\bGit\b|Skills|data-software-plugin/u);
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

test("Codex update view handles newer, current and missing installations", () => {
  const ui = loadUi();
  for (const [updateState, installedVersion, label, disabled] of [
    ["update-available", "26.707.3748.0", "有新版本", false],
    ["current", "26.721.11231.0", "已是最新版", true],
    ["not-installed", null, "尚未安装", false],
  ]) {
    const input = snapshot({
      components: [component("chatgpt", { installedVersion, updateState })],
      defaults: { install: { componentIds: ["chatgpt"], skillIds: [] }, update: { componentIds: disabled ? [] : ["chatgpt"], skillIds: [] } },
    });
    const { html, state } = rendered(ui, input, { type: "tab", tab: "update" });
    assert.ok(html.includes(label), updateState);
    const checkbox = html.match(/<input[^>]*data-software-component="chatgpt"[^>]*>/u)?.[0];
    assert.ok(checkbox);
    assert.equal(/\sdisabled(?:\s|=|>)/u.test(checkbox), disabled, updateState);
    assert.deepEqual([...state.selectedComponentIds], disabled ? [] : ["chatgpt"]);
    assert.match(html, /data-software-choose-root/u);
    assert.match(html, /未安装时使用此位置；已安装的 Codex 在原位置更新/u);
  }
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
assert.match(report, /Codex：失败/u);
  assert.match(report, /network_failed/u);
  assert.match(root.innerHTML, /software-result-summary failed/u);
  assert.match(root.innerHTML, /1 项失败/u);
  assert.doesNotMatch(root.innerHTML, /0 项成功/u);
  assert.match(root.innerHTML, /network_failed/u);
});

test("known timeout failures are explained in Chinese while retaining their diagnostic code", () => {
  const ui = loadUi();
  let state = ui.reduce(ui.createInitialState(), { type: "snapshot", snapshot: snapshot() });
  state = ui.reduce(state, {
    type: "task-result",
    result: {
      taskId: "timeout-task",
      kind: "install",
      status: "failed",
      components: [{ componentId: "chatgpt", status: "failed", message: "download_stalled" }],
      skills: [],
    },
  });
  const root = { innerHTML: "" };
  ui.render(root, state);
  const report = ui.buildTaskReport(state);
  assert.match(root.innerHTML, /下载长时间没有收到新数据/u);
  assert.match(root.innerHTML, /download_stalled/u);
  assert.match(report, /下载长时间没有收到新数据/u);
  assert.match(report, /download_stalled/u);
});

test("disk space failures explain recovery steps in the page and copied report without disabling location selection", () => {
  const ui = loadUi();
  for (const [code, explanation] of [
    ["component_disk_space_insufficient", "安装磁盘空间不足"],
    ["ENOSPC", "磁盘空间已用尽"],
  ]) {
    for (const kind of ["install", "update"]) {
      let state = ui.reduce(ui.createInitialState(), { type: "snapshot", snapshot: snapshot() });
      state = ui.reduce(state, {
        type: "task-result",
        result: {
          taskId: "disk-space-task", kind, status: "failed",
          components: [{ componentId: "chatgpt", status: "failed", message: code }],
          skills: kind === "install" ? [{ componentId: "documents", status: "failed", message: code }] : [],
        },
      });
      const root = { innerHTML: "" };
      ui.render(root, state);
      const expectedResults = kind === "install" ? 2 : 1;
      for (const text of [root.innerHTML, ui.buildTaskReport(state)]) {
        assert.ok(text.split(explanation).length - 1 >= expectedResults, "each failed item needs a readable disk-space reason");
        assert.ok(text.includes(code), "retain the diagnostic code");
        assert.match(text, /释放空间/u);
        if (code === "component_disk_space_insufficient") assert.match(text, /更换安装位置/u);
      }
      assert.doesNotMatch(root.innerHTML, /data-software-choose-root disabled/u);
    }
  }
});

test("renderer distinguishes a non-cancellable cleanup from a truly critical mutation", () => {
  const ui = loadUi();
  let state = ui.reduce(ui.createInitialState(), { type: "snapshot", snapshot: snapshot() });
  state = ui.reduce(state, {
    type: "task-event",
    event: {
      type: "progress", taskId: "task-cleanup", componentId: "chatgpt", phase: "cancelling",
      percent: null, cancellable: false, critical: false, message: "software_manager_cancelled",
    },
  });
  assert.equal(state.snapshot.task.cancellable, false);
  assert.equal(state.snapshot.task.critical, false);
  state = ui.reduce(state, {
    type: "task-event",
    event: {
      type: "progress", taskId: "task-cleanup", componentId: "chatgpt", phase: "commit",
      percent: null, cancellable: false, critical: true, message: "software_manager_critical_operation",
    },
  });
  assert.equal(state.snapshot.task.critical, true);
  const root = { innerHTML: "" };
  ui.render(root, state);
  assert.match(root.innerHTML, /software-progress indeterminate/u);
  assert.match(root.innerHTML, /正在安全应用更改，完成前不会提前报告成功。/u);
  assert.doesNotMatch(root.innerHTML, /value="100"/u);
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
  assert.match(root.innerHTML, /1 项成功/u);
  assert.doesNotMatch(root.innerHTML, /0 项失败/u);
  assert.match(root.innerHTML, /C:\\CBApps\\c/u);
assert.match(appFunction("startConfirmedSoftwareManagerTask"), /startSoftwareManagerTask\(request\)[\s\S]*?task-result/u);
});

test("snapshot events refresh installation path while keeping only the Codex selection", () => {
  const ui = loadUi();
  let state = rendered(ui, snapshot({ installRootPath: "C:\\Old" })).state;
  state = { ...state, selectedComponentIds: ["chatgpt", "v2rayn"], selectedSkillIds: ["documents"], selectedPluginIds: ["cowart"], skillsExpanded: true };
  state = ui.reduce(state, { type: "task-event", event: { type: "snapshot", snapshot: snapshot({ installRootPath: "D:\\New" }) } });
  assert.equal(state.snapshot.installRootPath, "D:\\New");
  assert.deepEqual([...state.selectedComponentIds], ["chatgpt"]);
  assert.deepEqual([...state.selectedSkillIds], []);
  assert.deepEqual([...state.selectedPluginIds], []);
  assert.equal(state.skillsExpanded, false);
});

test("snapshot refresh removes a Codex selection when it becomes unavailable", () => {
  const ui = loadUi();
  let state = rendered(ui).state;
  state = ui.reduce(state, { type: "snapshot", snapshot: snapshot({ components: [component("chatgpt", { selectable: false })] }) });
  assert.deepEqual([...state.selectedComponentIds], []);
  assert.deepEqual([...state.selectedSkillIds], []);
  assert.deepEqual([...state.selectedPluginIds], []);
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

test("Codex uninstall retains user data and critical tasks cannot queue another confirmation", () => {
  const ui = loadUi();
  const input = snapshot({
    components: [component("chatgpt", { installedVersion: "1.0.0" })],
    task: { taskId: "task-1", kind: "install", phase: "commit", critical: true, cancellable: false },
  });
  let state = ui.reduce(rendered(ui, input).state, { type: "confirm-open" });
  const root = { innerHTML: "" }; ui.render(root, state);
  assert.match(root.innerHTML, /data-software-cancel[^>]*disabled/u);
  assert.doesNotMatch(root.innerHTML, /data-software-confirm(?:\s|>)/u);
  assert.equal(state.confirmationPending, false);
  state = ui.reduce(state, { type: "task-event", event: { type: "finished", taskId: "task-1" } });
  ui.render(root, state);
  assert.doesNotMatch(root.innerHTML, /data-software-confirm(?:\s|>)/u);
  state = ui.reduce(state, { type: "tab", tab: "uninstall" });
  state = ui.reduce(state, { type: "toggle-component", componentId: "chatgpt", checked: true });
  state = ui.reduce(state, { type: "confirm-open" });
  ui.render(root, state);
  assert.match(root.innerHTML, /data-software-confirm(?:\s|>)/u);
  assert.match(root.innerHTML, /保留登录、配置和聊天历史/u);
  assert.doesNotMatch(root.innerHTML, /Skill 将被替换|data-software-register|V2RayN/u);
});

test("renderer keeps the task DOM bounded while copied reports retain the latest 500 lines", () => {
  const ui = loadUi();
  const logs = Array.from({ length: 510 }, (_, index) => `log-${index}`);
  const { html, state } = rendered(ui, snapshot({ logs }));
  const report = ui.buildTaskReport(state);
  assert.doesNotMatch(html, /log-389</u);
  assert.match(html, /log-390</u);
  assert.match(html, /log-509</u);
  assert.equal((html.match(/class="software-log-line"/gu) ?? []).length, 120);
  assert.match(report, /log-10/u);
  assert.match(report, /log-509/u);
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
  assert.match(htmlSource, /id="softwareManagerRoot"/u);
  assert.ok(htmlSource.indexOf("./software-manager-ui.js") < htmlSource.indexOf("./app.js"));
  assert.match(preloadSource, /softwareManagerPlatform:\s*process\.platform/u);
  assert.ok(/sectionId === "softwareManager"[\s\S]*?ensureSoftwareManagerLoaded/u.test(appSource));
  assert.ok(/mainScroller\.scrollTop\s*=\s*0/u.test(appSource));
  const ensureSource = appFunction("ensureSoftwareManagerLoaded");
  assert.match(ensureSource, /getSoftwareManagerSnapshot/u);
  assert.match(ensureSource, /onSoftwareManagerEvent/u);
  assert.match(ensureSource, /await refreshSoftwareManager\(\)/u);
  assert.doesNotMatch(ensureSource, /listCuratedCodexPlugins|refreshSoftwareManagerCuratedPlugins/u);
  assert.ok(ensureSource.indexOf("getSoftwareManagerSnapshot()") < ensureSource.indexOf("await refreshSoftwareManager()"));
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

test("install, update and uninstall finish without a secondary plugin task", async () => {
  for (const kind of ["install", "update", "uninstall", "rollback"]) {
    const { context, calls } = codexSubmissionHarness(["chatgpt"]);
    context.softwareManagerState.activeTab = kind;
    await context.start();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].request.kind, kind);
    assert.equal(context.softwareManagerState.snapshot.task, null);
    assert.equal(context.softwareManagerState.lastResult.status, "succeeded");
  }
});

test("invalid Codex task responses fail visibly and release the starting state", async () => {
  for (const response of [undefined, {}, { status: "succeeded", components: [] },
    { status: "succeeded", components: [{ componentId: "git" }] }]) {
    const { context } = codexSubmissionHarness(["chatgpt"]);
    context.api.startSoftwareManagerTask = async () => response;
    const result = await context.start();
    assert.equal(result.status, "failed");
    assert.match(result.components[0].message, /无效结果/u);
    assert.equal(context.softwareManagerState.snapshot.task, null);
  }
});

test("presentation failures cannot replace a successful Codex installation with a failed result", async () => {
  const { context } = codexSubmissionHarness(["chatgpt"]);
  let notices = 0;
  context.showToast = () => { if (++notices === 1) throw new Error("toast failed"); };
  const result = await context.start();
  assert.equal(result.status, "succeeded");
  assert.equal(context.softwareManagerState.lastResult.status, "succeeded");
  assert.equal(context.softwareManagerState.snapshot.task, null);
});

test("Codex card stays full width and keyboard focus survives state updates", () => {
  assert.match(cssSource, /\.software-manager-grid\.software-manager-codex-only\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/u);
  assert.match(cssSource, /\.software-tab:focus-visible/u);
  assert.match(cssSource, /\.software-progress\.indeterminate::after/u);
  const updateSource = appFunction("updateSoftwareManager");
  assert.match(updateSource, /currentSectionId\(\) !== "softwareManager"[\s\S]*?softwareManagerUi\.reduce\(softwareManagerState, action\)[\s\S]*?return;/u);
  assert.match(updateSource, /data-software-component="chatgpt"/u);
  assert.match(updateSource, /focus\?\.\(\{ preventScroll: true \}\)/u);
  assert.doesNotMatch(updateSource, /software-skill|software-plugin/u);
});
