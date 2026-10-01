import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rendererSource = readFileSync(resolve(__dirname, "../desktop/renderer/app.js"), "utf8");
const htmlSource = readFileSync(resolve(__dirname, "../desktop/renderer/index.html"), "utf8");
const cssSource = readFileSync(resolve(__dirname, "../desktop/renderer/styles.css"), "utf8");
const preloadSource = readFileSync(resolve(__dirname, "../desktop/preload.cjs"), "utf8");
const mainSource = readFileSync(resolve(__dirname, "../desktop/main.cjs"), "utf8");
const kimiLogoSource = readFileSync(resolve(__dirname, "../desktop/renderer/assets/providers/kimi.svg"), "utf8");
const defaultLogoSource = readFileSync(resolve(__dirname, "../desktop/renderer/assets/providers/default.svg"), "utf8");

test("an unready owned double-quota process keeps its stop button available", () => {
  const start = rendererSource.indexOf("function renderDoubleQuota(");
  const layer = rendererSource.indexOf("function setDoubleQuotaExtensionLayerState(", start);
  const end = rendererSource.indexOf("\nfunction ", layer + 1);
  assert.ok(start >= 0 && layer > start && end > layer);
  for (const entry of [
    { status: "starting", running: false, ownedProcess: true, canStop: true },
    { status: "running", running: true, ownedProcess: true, canStop: true },
    { status: "stopped", running: false, ownedProcess: false, canStop: false },
    { status: "attached", running: true, ownedProcess: false, externalProcess: true, canStop: true },
    { status: "error", running: false, ownedProcess: false, externalProcess: true, canStop: false },
  ]) {
    const els = Object.fromEntries([
      "doubleQuotaStatus", "doubleQuotaServiceBanner", "doubleQuotaServiceTitle", "doubleQuotaServiceDetail",
      "doubleQuotaUrl", "doubleQuotaServiceVersion", "doubleQuotaProtocolVersion", "doubleQuotaExtensionProtocol",
      "doubleQuotaEmbeddedVersion", "doubleQuotaServiceSource", "doubleQuotaMcpStatus", "doubleQuotaPort",
      "doubleQuotaExtensionPath", "doubleQuotaExtensionDiskState", "doubleQuotaExtensionBrowserState",
      "doubleQuotaExtensionRuntimeState", "doubleQuotaMessage", "startDoubleQuota", "restartDoubleQuota",
      "stopDoubleQuota", "saveDoubleQuotaPort",
    ].map((key) => [key, { textContent: "", value: "", disabled: false, classList: { add() {}, toggle() {} } }]));
    const sandbox = {
      els, document: { activeElement: null }, doubleQuotaExtensionGuideActive: false,
      doubleQuotaState: { ...entry, port: 4317, error: "retained diagnostic" },
    };
    runInNewContext(rendererSource.slice(start, end), sandbox);
    sandbox.renderDoubleQuota();
    assert.equal(els.stopDoubleQuota.disabled, !entry.canStop, entry.status);
    assert.equal(els.stopDoubleQuota.textContent, entry.canStop ? "停止服务" : "服务已停止", entry.status);
    assert.equal(els.doubleQuotaMessage.textContent, "retained diagnostic");
  }
});

function budgetInputHarness(scope = "global", value = 12.5) {
  const budget = { dailyCostLimit: 1.1, inputCostPerMillion: 10, cacheCostPerMillion: 1, cacheWriteCostPerMillion: value };
  const sandbox = {
    usageBudgetDrafts: new Map(), usageBudgetRevision: 0, usageBudgetSaving: false, usageBudgetRenderedKey: null, usageBudgetValidationShown: false,
    state: { models: [{ id: "r", provider: "openai" }], desktopOptions: { usageBudgets: {
      global: { ...budget }, routes: { r: { ...budget } }, providers: { openai: { ...budget } },
    } } },
    els: Object.fromEntries([
      "usageDailyTokenLimit", "usageDailyCallLimit", "usageDailyCostLimit", "usageInputCostPerMillion",
      "usageCacheCostPerMillion", "usageCacheWriteCostPerMillion", "usageOutputCostPerMillion",
    ].map((key) => [key, { id: key, value: "" }])),
    document: { activeElement: null }, escapeHtml: (value) => String(value), providerName: (value) => value,
  };
  sandbox.els.usageBudgetScope = { value: scope };
  sandbox.els.usageBudgetTarget = { value: scope === "route" ? "r" : scope === "provider" ? "openai" : "global" };
  const start = rendererSource.indexOf("function usageBudgetFields(");
  const end = rendererSource.indexOf("function renderUsageBudgetAlerts(", start);
  assert.ok(start >= 0 && end > start);
  runInNewContext(rendererSource.slice(start, end), sandbox);
  return sandbox;
}

test("write-cache rate renders and survives saving global, route and provider budgets including zero", () => {
  for (const scope of ["global", "route", "provider"]) {
    for (const value of [12.5, 0, 0.0000004]) {
      const sandbox = budgetInputHarness(scope, value);
      sandbox.renderUsageBudgetInputs();
      assert.equal(sandbox.els.usageCacheWriteCostPerMillion.value, String(value));
      const result = sandbox.usageBudgetOptionsFromInputs();
      const selected = scope === "global" ? result.global : scope === "route" ? result.routes.r : result.providers.openai;
      assert.equal(selected.cacheWriteCostPerMillion, value);
      assert.equal(selected.dailyCostLimit, 1.1);
      assert.equal(selected.inputCostPerMillion, 10);
      assert.equal(result.providers.openai.cacheWriteCostPerMillion, value);
    }
  }
});

test("clearing the write-cache rate restores defaults without changing other budget scopes", () => {
  const sandbox = budgetInputHarness("route");
  sandbox.renderUsageBudgetInputs();
  sandbox.els.usageCacheWriteCostPerMillion.value = "";
  const result = sandbox.usageBudgetOptionsFromInputs();
  assert.equal(Object.hasOwn(result.routes.r, "cacheWriteCostPerMillion"), false);
  assert.equal(result.global.cacheWriteCostPerMillion, 12.5);
  assert.equal(result.providers.openai.cacheWriteCostPerMillion, 12.5);
  assert.equal(sandbox.state.desktopOptions.usageBudgets.routes.r.cacheWriteCostPerMillion, 12.5);
});

test("live budget rendering does not replace the focused write-cache price draft", () => {
  const sandbox = budgetInputHarness();
  sandbox.els.usageCacheWriteCostPerMillion.value = "2.75";
  sandbox.document.activeElement = sandbox.els.usageCacheWriteCostPerMillion;
  sandbox.renderUsageBudgetInputs();
  assert.equal(sandbox.els.usageCacheWriteCostPerMillion.value, "2.75");
  assert.equal(sandbox.usageBudgetOptionsFromInputs().global.cacheWriteCostPerMillion, 2.75);
});

function editBudget(sandbox, id, value, badInput = false) {
  sandbox.els[id].value = value;
  sandbox.els[id].validity = { badInput };
  sandbox.captureUsageBudgetEdit({target:sandbox.els[id]});
}

function budgetSaveHarness(saveOptions) {
  const sandbox = budgetInputHarness();
  sandbox.api = {saveOptions};
  sandbox.runAction = (_button,action) => action();
  sandbox.adoptStateSnapshot = value => { sandbox.state = value; };
  sandbox.render = () => sandbox.renderUsageBudgetInputs();
  sandbox.showToast = () => {};
  sandbox.render();
  return sandbox;
}

test("invalid budget input stays inline without opening an overlay or submitting settings", async () => {
  let saves = 0, notices = 0, focused = false;
  const sandbox = budgetSaveHarness(async () => { saves++; });
  sandbox.els.usageBudgetError = { hidden: true, textContent: "" };
  sandbox.els.discardUsageBudget = { disabled: true };
  sandbox.els.usageDailyCallLimit.focus = () => { focused = true; };
  sandbox.els.usageDailyCallLimit.scrollIntoView = () => {};
  sandbox.showToast = () => { notices++; };
  editBudget(sandbox, 'usageDailyCallLimit', '', true);
  await sandbox.saveUsageBudgetSettings();
  assert.equal(saves, 0);
  assert.equal(sandbox.els.usageBudgetError.hidden, false);
  assert.match(sandbox.els.usageBudgetError.textContent, /每日请求上限/u);
  assert.equal(sandbox.els.discardUsageBudget.disabled, false);
  assert.equal(focused, true);
  assert.equal(notices, 0);
});

test("budget drafts retain blank and zero edits after focus leaves the field without changing saved values", () => {
  const sandbox = budgetInputHarness();
  sandbox.renderUsageBudgetInputs();
  editBudget(sandbox,'usageDailyCallLimit','123');
  editBudget(sandbox,'usageCacheWriteCostPerMillion','0');
  editBudget(sandbox,'usageDailyCostLimit','');
  sandbox.renderUsageBudgetInputs();
  assert.equal(sandbox.els.usageDailyCallLimit.value,'123');
  assert.equal(sandbox.els.usageCacheWriteCostPerMillion.value,'0');
  assert.equal(sandbox.els.usageDailyCostLimit.value,'');
  assert.equal(sandbox.state.desktopOptions.usageBudgets.global.dailyCostLimit,1.1);
  assert.equal(sandbox.state.desktopOptions.usageBudgets.global.cacheWriteCostPerMillion,12.5);
});

test("budget scopes retain independent drafts and saving options includes only the current scope", () => {
  const sandbox = budgetInputHarness();
  for (const [scope,value] of [['global','123'],['route','7'],['provider','9']]) {
    sandbox.els.usageBudgetScope.value = scope;
    sandbox.renderUsageBudgetInputs({keepTarget:false});
    editBudget(sandbox,'usageDailyCallLimit',value);
  }
  sandbox.els.usageBudgetScope.value = 'route';
  sandbox.renderUsageBudgetInputs({keepTarget:false});
  assert.equal(sandbox.els.usageDailyCallLimit.value,'7');
  const submitted = sandbox.usageBudgetOptionsFromInputs();
  assert.equal(submitted.routes.r.dailyCallLimit,7);
  assert.equal(submitted.global.dailyCallLimit,undefined);
  assert.equal(submitted.providers.openai.dailyCallLimit,undefined);
  sandbox.els.usageBudgetScope.value = 'global';
  sandbox.renderUsageBudgetInputs({keepTarget:false});
  assert.equal(sandbox.els.usageDailyCallLimit.value,'123');
});

test("budget save acknowledges submitted revisions but retains newer edits even when they match old saved values", async () => {
  let finishSave;
  const requests = [];
  const sandbox = budgetSaveHarness(options => { requests.push(options); return new Promise(resolve => { finishSave = resolve; }); });
  editBudget(sandbox,'usageDailyCallLimit','123');
  const saving = sandbox.saveUsageBudgetSettings();
  editBudget(sandbox,'usageDailyCallLimit','');
  sandbox.els.usageBudgetScope.value = 'route';
  sandbox.renderUsageBudgetInputs({keepTarget:false});
  editBudget(sandbox,'usageDailyCallLimit','7');
  await sandbox.saveUsageBudgetSettings();
  assert.equal(requests.length,1);
  finishSave({...sandbox.state,desktopOptions:{usageBudgets:requests[0].usageBudgets}});
  await saving;
  assert.equal(sandbox.usageBudgetSaving,false);
  assert.equal(sandbox.els.usageDailyCallLimit.value,'7');
  sandbox.els.usageBudgetScope.value = 'global';
  sandbox.renderUsageBudgetInputs({keepTarget:false});
  assert.equal(sandbox.els.usageDailyCallLimit.value,'');
  assert.equal(sandbox.state.desktopOptions.usageBudgets.global.dailyCallLimit,123);
});

test("a rejected budget save keeps the draft and allows retry", async () => {
  const sandbox = budgetSaveHarness(async () => { throw new Error('save rejected'); });
  editBudget(sandbox,'usageDailyCallLimit','123');
  await assert.rejects(sandbox.saveUsageBudgetSettings(),/save rejected/);
  assert.equal(sandbox.usageBudgetSaving,false);
  sandbox.renderUsageBudgetInputs();
  assert.equal(sandbox.els.usageDailyCallLimit.value,'123');
  sandbox.api.saveOptions = async options => ({...sandbox.state,desktopOptions:{usageBudgets:options.usageBudgets}});
  await sandbox.saveUsageBudgetSettings();
  assert.equal(sandbox.usageBudgetDrafts.size,0);
  assert.equal(sandbox.state.desktopOptions.usageBudgets.global.dailyCallLimit,123);
});

test("a budget explicitly undone during an unconfirmed save survives the later authoritative refresh", async () => {
  let fail;
  const sandbox=budgetSaveHarness(() => new Promise((_resolve,reject) => {fail=reject;}));
  editBudget(sandbox,'usageDailyCallLimit','123');
  const saving=sandbox.saveUsageBudgetSettings();
  editBudget(sandbox,'usageDailyCallLimit','');
  fail(new Error('save result unavailable'));
  await assert.rejects(saving);
  sandbox.state.desktopOptions.usageBudgets.global.dailyCallLimit=123;
  sandbox.renderUsageBudgetInputs();
  assert.equal(sandbox.els.usageDailyCallLimit.value,'');
});

test("a failed budget snapshot confirmation must not acknowledge the user's draft", async () => {
  for (const response of [null,{}, {stateUnavailable:true,desktopOptions:{}}, {desktopOptions:{}},
    {desktopOptions:{usageBudgets:{global:{dailyCallLimit:5}}}}]) {
    const sandbox = budgetSaveHarness(async () => response);
    editBudget(sandbox,'usageDailyCallLimit','123');
    await assert.rejects(sandbox.saveUsageBudgetSettings());
    assert.equal(sandbox.usageBudgetSaving,false);
    assert.ok(sandbox.usageBudgetDrafts.size > 0);
  }
});

test("budget confirmation follows existing rounding and zero rules without requiring other objects to match", async () => {
  const sandbox = budgetSaveHarness(async options => {
    const budgets = structuredClone(options.usageBudgets);
    budgets.global.dailyCostLimit = 1.234568;
    budgets.routes.r = {dailyCallLimit:999};
    return {...sandbox.state,desktopOptions:{usageBudgets:budgets}};
  });
  editBudget(sandbox,'usageDailyCallLimit','1.9');
  editBudget(sandbox,'usageDailyCostLimit','1.23456789');
  editBudget(sandbox,'usageCacheWriteCostPerMillion','0');
  await sandbox.saveUsageBudgetSettings();
  assert.equal(sandbox.usageBudgetDrafts.size,0);
  assert.equal(sandbox.state.desktopOptions.usageBudgets.global.dailyCallLimit,1);
  assert.equal(sandbox.state.desktopOptions.usageBudgets.global.cacheWriteCostPerMillion,0);
  assert.equal(sandbox.state.desktopOptions.usageBudgets.global.dailyCostLimit,1.234568);
  assert.equal(sandbox.state.desktopOptions.usageBudgets.routes.r.dailyCallLimit,999);
});

test("clearing a budget requires an explicit saved budget container and retains other scopes if confirmation is missing", async () => {
  const sandbox = budgetSaveHarness(async () => ({desktopOptions:{}}));
  for (const {id} of sandbox.usageBudgetFields()) editBudget(sandbox,id,'');
  await assert.rejects(sandbox.saveUsageBudgetSettings());
  assert.ok(sandbox.usageBudgetDrafts.size > 0);
  assert.equal(sandbox.state.desktopOptions.usageBudgets.routes.r.cacheWriteCostPerMillion,12.5);
  sandbox.api.saveOptions = async options => ({...sandbox.state,desktopOptions:{usageBudgets:options.usageBudgets}});
  await sandbox.saveUsageBudgetSettings();
  assert.equal(sandbox.usageBudgetDrafts.size,0);
  assert.equal(sandbox.state.desktopOptions.usageBudgets.global,undefined);
  assert.equal(sandbox.state.desktopOptions.usageBudgets.routes.r.cacheWriteCostPerMillion,12.5);
});

test("a negative-zero cache-write price confirms against its persisted JSON zero", async () => {
  const sandbox = budgetSaveHarness(async options => JSON.parse(JSON.stringify({...sandbox.state,desktopOptions:{usageBudgets:options.usageBudgets}})));
  editBudget(sandbox,'usageCacheWriteCostPerMillion','-0');
  await sandbox.saveUsageBudgetSettings();
  assert.equal(sandbox.usageBudgetDrafts.size,0);
  assert.equal(sandbox.state.desktopOptions.usageBudgets.global.cacheWriteCostPerMillion,0);
});

test("a missing budget target does not silently retarget an edit to another model", () => {
  const sandbox = budgetInputHarness('route');
  sandbox.renderUsageBudgetInputs();
  editBudget(sandbox,'usageDailyCallLimit','7');
  sandbox.state.models = [{id:'replacement',provider:'openai'}];
  sandbox.renderUsageBudgetInputs();
  assert.equal(sandbox.els.usageBudgetTarget.value,'r');
  assert.equal(sandbox.els.usageDailyCallLimit.value,'7');
  assert.equal(sandbox.usageBudgetInputError().control,sandbox.els.usageBudgetTarget);
});

test("a draft for a removed budget target remains reachable after visiting another scope", () => {
  const sandbox = budgetInputHarness('route');
  sandbox.renderUsageBudgetInputs();
  editBudget(sandbox,'usageDailyCallLimit','7');
  sandbox.els.usageBudgetScope.value='global';
  sandbox.renderUsageBudgetInputs({keepTarget:false});
  sandbox.state.models=[{id:'replacement',provider:'openai'}];
  sandbox.els.usageBudgetScope.value='route';
  sandbox.renderUsageBudgetInputs({keepTarget:false});
  assert.match(sandbox.els.usageBudgetTarget.innerHTML,/value="r"/);
  sandbox.els.usageBudgetTarget.value='r';
  sandbox.renderUsageBudgetInputs();
  assert.equal(sandbox.els.usageDailyCallLimit.value,'7');
  assert.equal(sandbox.usageBudgetInputError().control,sandbox.els.usageBudgetTarget);
});

test("budget validation rejects invalid numbers and incomplete native input without rejecting tiny valid prices", () => {
  const sandbox = budgetInputHarness();
  sandbox.renderUsageBudgetInputs();
  for (const value of ['','0','0.0000004','1e-8','123']) {
    editBudget(sandbox,'usageCacheWriteCostPerMillion',value);
    assert.equal(sandbox.usageBudgetInputError(),null,value);
  }
  for (const value of ['-1','Infinity','invalid']) {
    editBudget(sandbox,'usageCacheWriteCostPerMillion',value);
    assert.equal(sandbox.usageBudgetInputError().control,sandbox.els.usageCacheWriteCostPerMillion,value);
  }
  editBudget(sandbox,'usageCacheWriteCostPerMillion','',true);
  sandbox.renderUsageBudgetInputs();
  assert.equal(sandbox.usageBudgetInputError().control,sandbox.els.usageCacheWriteCostPerMillion);
});

test("cost breakdown distinguishes cache reads from cache writes", () => {
  const output = { innerHTML: "", classList: { toggle() {} } };
  const sandbox = {
    state: { usageCostEstimate: { hasRates: true, inputCost: 1, cacheReadCost: 2, cacheWriteCost: 3, cacheCost: 5, outputCost: 4, totalCost: 10 } },
    els: { usageCostEstimate: output }, formatCostValue: String, escapeHtml: String,
  };
  const start = rendererSource.indexOf("function renderUsageCostEstimate(");
  const end = rendererSource.indexOf("function usageBudgetScopeLabel(", start);
  runInNewContext(rendererSource.slice(start, end), sandbox);
  sandbox.renderUsageCostEstimate();
  assert.match(output.innerHTML, /缓存读取 2/);
  assert.match(output.innerHTML, /缓存写入 3/);
});

test("cost labels and breakdown preserve nonzero amounts below the decimal display precision", () => {
  const output = { innerHTML: "", classList: { toggle() {} } };
  const sandbox = {
    state: { usageCostEstimate: { hasRates: true, cacheWriteCost: 4e-10, totalCost: 4e-10 } },
    els: { usageCostEstimate: output }, escapeHtml: String,
  };
  const formatStart = rendererSource.indexOf("function formatCostValue(");
  const formatEnd = rendererSource.indexOf("function formatCompactContext(", formatStart);
  runInNewContext(rendererSource.slice(formatStart, formatEnd), sandbox);
  for (const amount of [4e-10, 5e-7, Number.MIN_VALUE]) {
    const label = sandbox.formatCostValue(amount);
    assert.equal(Number(label), amount);
    assert.ok(label.length <= 18, "tiny amounts must not create hundreds of leading zeroes");
  }
  assert.equal(sandbox.formatCostValue(0), "0");
  assert.equal(sandbox.formatCostValue(0.0022), "0.0022");
  assert.equal(sandbox.formatCostValue(1234.5), "1,234.50");
  const start = rendererSource.indexOf("function renderUsageCostEstimate(");
  const end = rendererSource.indexOf("function usageBudgetScopeLabel(", start);
  runInNewContext(rendererSource.slice(start, end), sandbox);
  sandbox.renderUsageCostEstimate();
  assert.match(output.innerHTML, /缓存写入 4e-10/);
});

test("sidebar navigation keeps the existing order while separating workbench, management, and service groups", () => {
  assert.match(htmlSource, /id="navGroupWorkbench">工作台<\/div>[\s\S]*?data-section="dashboard"[\s\S]*?data-section="stats"/u);
  assert.match(htmlSource, /id="navGroupManagement">管理<\/div>[\s\S]*?data-section="softwareManager"[\s\S]*?data-section="resources"/u);
  assert.match(htmlSource, /id="navGroupTools">工具与服务<\/div>[\s\S]*?data-section="sessions"[\s\S]*?data-section="vvip"/u);
});

test("model cards show a dedicated user description when a preset provides one", () => {
  assert.match(rendererSource, /function modelFriendlySummary\(model\)[\s\S]*?model\.userDescription/);
  assert.match(rendererSource, /function modelCatalogSummary\(model\)[\s\S]*?model\.userDescription/);
});

test("double quota is a dedicated desktop page backed by narrow IPC methods", () => {
  assert.match(htmlSource, /data-section="doubleQuota">双倍额度<\/button>/);
  assert.match(htmlSource, /<section class="section-panel hidden" id="doubleQuota">/);
  const sectionStart = htmlSource.indexOf('id="doubleQuota"');
  const sectionEnd = htmlSource.indexOf("</section>", sectionStart);
  const section = htmlSource.slice(sectionStart, sectionEnd);
  assert.match(section, /<h2>双倍额度<\/h2>/);
  assert.doesNotMatch(section, /GPT Bridge/i);
  assert.match(section, /ChatGPT/);
  assert.doesNotMatch(section, /G某T/);
  for (const id of [
    "doubleQuotaStatus",
    "doubleQuotaServiceBanner",
    "doubleQuotaServiceTitle",
    "doubleQuotaServiceDetail",
    "doubleQuotaExtensionState",
    "doubleQuotaExtensionDiskState",
    "doubleQuotaExtensionBrowserState",
    "doubleQuotaExtensionRuntimeState",
    "doubleQuotaPort",
    "doubleQuotaServiceVersion",
    "doubleQuotaProtocolVersion",
    "doubleQuotaExtensionProtocol",
    "doubleQuotaEmbeddedVersion",
    "doubleQuotaServiceSource",
    "saveDoubleQuotaPort",
    "startDoubleQuota",
    "restartDoubleQuota",
    "stopDoubleQuota",
    "manageDoubleQuotaExtension",
    "openDoubleQuotaExtensionManager",
    "refreshDoubleQuotaExtension",
    "repairDoubleQuotaMcp",
  ]) {
    assert.match(section, new RegExp(`id="${id}"`));
  }

  for (const [method, channel] of [
    ["getDoubleQuotaState", "doubleQuota:getState"],
    ["saveDoubleQuotaPort", "doubleQuota:savePort"],
    ["startDoubleQuota", "doubleQuota:start"],
    ["restartDoubleQuota", "doubleQuota:restart"],
    ["stopDoubleQuota", "doubleQuota:stop"],
    ["prepareDoubleQuotaExtension", "doubleQuota:prepareExtension"],
    ["manageDoubleQuotaExtension", "doubleQuota:manageExtension"],
    ["openDoubleQuotaExtensionManager", "doubleQuota:openExtensionManager"],
    ["repairDoubleQuotaMcp", "doubleQuota:repairMcp"],
  ]) {
    assert.match(preloadSource, new RegExp(`${method}:.*ipcRenderer\\.invoke\\("${channel}"`));
    assert.match(mainSource, new RegExp(`ipcMain\\.handle\\("${channel}"`));
  }

  assert.match(rendererSource, /async function refreshDoubleQuotaState\b/);
  assert.match(rendererSource, /sectionId === "doubleQuota"[\s\S]*refreshDoubleQuotaState/);
  assert.equal(
    (rendererSource.match(/api\.getDoubleQuotaState\(\)/g) || []).length,
    1,
    "double quota detection must stay lazy and only run through the page activation refresh",
  );
  assert.match(rendererSource, /api\.startDoubleQuota\(\)/);
  assert.match(rendererSource, /api\.restartDoubleQuota\(\)/);
  assert.match(rendererSource, /api\.stopDoubleQuota\(\)/);
  assert.match(rendererSource, /api\.repairDoubleQuotaMcp\(\)/);
  assert.match(rendererSource, /extensionProtocolVersion/);
  assert.match(rendererSource, /extensionAction\.label/);
  assert.match(rendererSource, /api\.manageDoubleQuotaExtension\(\)/);
  assert.match(rendererSource, /current\.extensionDisk/);
  assert.match(rendererSource, /current\.extensionBrowser/);
  assert.match(rendererSource, /current\.extensionRuntime/);
  assert.match(rendererSource, /current\.extensionInstallation/);
  assert.match(rendererSource, /doubleQuotaServiceBanner\.classList\.toggle\("running"/);
  assert.match(rendererSource, /doubleQuotaServiceTitle\.textContent/);
  assert.match(rendererSource, /doubleQuotaServiceDetail\.textContent/);
  assert.match(rendererSource, /extensionDeployment\?\.verified/);
  assert.match(rendererSource, /doubleQuotaExtensionState\.textContent[\s\S]*?"已连接"/);
  assert.match(rendererSource, /doubleQuotaExtensionState\.textContent[\s\S]*?"已安装"/);
  assert.match(rendererSource, /current\.extensionDisplayVersion/);
  assert.doesNotMatch(rendererSource, /管理链路|extensionManagerRevision/);
  assert.doesNotMatch(rendererSource, /extensionDeployment\.updatedAt/);
  assert.match(rendererSource, /api\.openDoubleQuotaExtensionManager\(\)/);
  assert.doesNotMatch(section, /打开使用页面/);
  assert.doesNotMatch(section, /打开扩展目录/);
  assert.match(mainSource, /getChatgptBridgeService\(\)\.assertMaintenanceSafe\("更新"\)/);
  assert.doesNotMatch(htmlSource, /class="grid two double-quota-grid"/);
  const extensionUpdateHandler = rendererSource.slice(
    rendererSource.indexOf('els.manageDoubleQuotaExtension?.addEventListener'),
    rendererSource.indexOf('els.openDoubleQuotaExtensionManager?.addEventListener'),
  );
  assert.doesNotMatch(extensionUpdateHandler, /api\.copyText\(/);
  assert.match(extensionUpdateHandler, /api\.openDoubleQuotaExtensionManager\(\)/);
  assert.match(extensionUpdateHandler, /请手动复制上方扩展目录/);
  assert.doesNotMatch(extensionUpdateHandler, /requestedAction === "reinstall"/);
  assert.match(extensionUpdateHandler, /extensionUpdate\?\.status === "failed"[\s\S]*throw new Error/);
  assert.match(mainSource, /App Paths\\\\chrome\.exe/);
  assert.match(mainSource, /chromeExtensionManagerPlan/);
  assert.doesNotMatch(mainSource, /const chromeArgs = \["chrome:\/\/extensions\/"\]/);
  assert.match(mainSource, /clipboard\.writeText\("chrome:\/\/extensions\/"\)/);
  assert.match(section, /id="doubleQuotaExtensionGuide"/);
  assert.match(section, /加载已解压的扩展程序/);
  assert.match(section, /请手动选中并复制上方“固定安装目录”中的完整路径/);
  assert.match(section, /将路径粘贴到选择窗口并确认/);
  assert.doesNotMatch(section, /扩展目录已经复制|可直接粘贴选择/);
  assert.match(
    rendererSource,
    /STATE_UNAVAILABLE_READ_ONLY_API_METHODS = new Set\(\[[\s\S]*?"getDoubleQuotaState"/,
  );
});

test("packaging retains the audited double quota vendor runtime and host dependencies", () => {
  const packageJson = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8"));
  assert.equal(typeof packageJson.dependencies?.["@modelcontextprotocol/sdk"], "string");
  assert.equal(typeof packageJson.dependencies?.zod, "string");
  for (const relativePath of [
    "vendor/chatgpt-codex-bridge/embedded-manifest.json",
    "vendor/chatgpt-codex-bridge/src/index.js",
    "vendor/chatgpt-codex-bridge/src/mcp-server.js",
    "vendor/chatgpt-codex-bridge/chrome-extension/manifest.json",
  ]) {
    assert.equal(existsSync(resolve(__dirname, "..", relativePath)), true, relativePath);
  }
  assert.match(packageJson.scripts?.["test:desktop"] || "", /desktop-chatgpt-bridge-service\.test\.js/);
  assert.match(packageJson.scripts?.["check:syntax"] || "", /desktop\/chatgpt-bridge-service\.cjs/);
});

test("live Router logs remain in renderer state when the log page is opened later", () => {
  assert.match(
    rendererSource,
    /api\.onLogs\(\(logs\)\s*=>\s*\{[\s\S]*?state\s*=\s*\{\s*\.\.\.state,\s*logs:\s*\[\.\.\.logs\],?\s*\};[\s\S]*?renderLogs\(logs\);[\s\S]*?\}\);/,
  );
});

test("desktop renderer parses mode transaction results and gives verified restart guidance", () => {
  const helperSource = rendererSource.slice(0, rendererSource.indexOf("const api = createStateUnavailableGuardedApi"));
  const sandbox = {};
  runInNewContext(
    `${helperSource}\nglobalThis.modeHelpers = { normalizeModeSelectionResult, modeSwitchToastMessage };`,
    sandbox,
  );
  const { normalizeModeSelectionResult, modeSwitchToastMessage } = sandbox.modeHelpers;
  const nextState = { mode: "all_api", selectedModelIds: ["model-a"] };
  const transaction = {
    revision: "committed-r1",
    restartRequired: true,
    restartAvailable: true,
    routerVerified: true,
  };

  const wrapped = normalizeModeSelectionResult({ state: nextState, transaction });
  assert.equal(wrapped.state, nextState);
  assert.equal(wrapped.transaction, transaction);
  const legacy = normalizeModeSelectionResult(nextState);
  assert.equal(legacy.state, nextState);
  assert.equal(legacy.transaction, null);

  assert.equal(
    modeSwitchToastMessage(transaction),
    "模式已切换且Router已确认；请点击本应用的“重启 ChatGPT / Codex”使鉴权生效，并兼容 Windows 旧任务。",
  );
  assert.equal(
    modeSwitchToastMessage({ ...transaction, restartAvailable: false }),
    "模式已切换且Router已确认；未定位到 ChatGPT / Codex 启动项，请完全退出 ChatGPT / Codex 后重新打开，使鉴权生效。",
  );
  assert.equal(
    modeSwitchToastMessage({ ...transaction, routerVerified: false }),
    "模式已切换，配置已原子写入（Router当前未运行）；请点击本应用的“重启 ChatGPT / Codex”使鉴权生效，并兼容 Windows 旧任务。",
  );
  assert.equal(
    modeSwitchToastMessage({ ...transaction, routerVerified: false, restartAvailable: false }),
    "模式已切换，配置已原子写入（Router当前未运行）；未定位到 ChatGPT / Codex 启动项，请完全退出 ChatGPT / Codex 后重新打开，使鉴权生效。",
  );

  assert.equal(normalizeModeSelectionResult({ state: nextState, transaction: null }).transaction, null);
});

test("Router start IPC failures become a local Chinese Error before the success toast", () => {
  const start = rendererSource.indexOf("els.routerToggle.addEventListener");
  const end = rendererSource.indexOf("els.restartCodex.addEventListener", start);
  const body = rendererSource.slice(start, end);

  assert.match(
    body,
    /const response = await api\.startRouter\(\);[\s\S]*?if \(response\.ok === false\) \{[\s\S]*?throw new Error\(response\.error\.message\);[\s\S]*?if \(response\.ok === true\) \{[\s\S]*?showToast\("Router 已启动。"\);/,
  );
  assert.ok(
    body.indexOf("throw new Error(response.error.message)") <
      body.indexOf('showToast("Router 已启动。")'),
  );
});

test("Router toggle refreshes only lightweight state after confirmed start or stop", () => {
  const start = rendererSource.indexOf("els.routerToggle.addEventListener");
  const end = rendererSource.indexOf("els.restartCodex.addEventListener", start);
  const body = rendererSource.slice(start, end);

  assert.match(body, /await refresh\(\{ lite: true \}\);/);
  assert.doesNotMatch(body, /await refresh\(\);/);
});

test("Router stop reports configuration cleanup warnings without hiding confirmed shutdown", () => {
  const start = rendererSource.indexOf("els.routerToggle.addEventListener");
  const end = rendererSource.indexOf("els.restartCodex.addEventListener", start);
  const body = rendererSource.slice(start, end);

  assert.match(body, /const response = await api\.stopRouter\(\);/);
  assert.match(body, /response\?\.warning\?\.code === "managed_config_cleanup_failed"/);
  assert.match(body, /Router 已关闭，但 ChatGPT \/ Codex 原配置恢复失败/);
  assert.match(body, /showToast\("Router 已关闭。"\)/);
});

test("desktop renderer keeps successful empty resource counts distinct from unreadable snapshots", () => {
  const helperSource = rendererSource.slice(0, rendererSource.indexOf("const api = createStateUnavailableGuardedApi"));
  const formattedValues = [];
  const sandbox = {
    formatNumber(value) {
      formattedValues.push(value);
      return `formatted:${value}`;
    },
  };
  runInNewContext(
    `${helperSource}\nglobalThis.resourceSummaryHelpers = { resourceSummaryCount, resourceSummaryDisplay };`,
    sandbox,
  );
  const { resourceSummaryCount, resourceSummaryDisplay } = sandbox.resourceSummaryHelpers;

  const successfulEmpty = {
    summary: { plugins: 0 },
    readStatus: { plugins: { ok: true, state: "ok", code: "ok" } },
  };
  assert.equal(resourceSummaryCount(successfulEmpty, "plugins"), 0);
  assert.equal(resourceSummaryDisplay(successfulEmpty, "plugins"), "formatted:0");
  assert.deepEqual(formattedValues, [0]);

  const resourceFixtures = {
    plugins: ["plugin-alpha", "plugin-beta", "plugin-gamma"],
    mcpServers: ["mcp-alpha", "mcp-beta", "mcp-gamma", "mcp-delta"],
    skills: ["skill-alpha", "skill-beta", "skill-gamma", "skill-delta", "skill-epsilon"],
    marketplaces: ["market-alpha"],
    prompts: ["prompt-alpha", "prompt-beta", "prompt-gamma"],
    agentFiles: ["agents-alpha", "agents-beta"],
  };
  const authorityKeys = ["plugins", "mcpServers", "skills", "marketplaces"];
  const successfulCount = {
    summary: Object.fromEntries(
      Object.entries(resourceFixtures).map(([key, items]) => [key, items.length]),
    ),
    readStatus: Object.fromEntries(
      authorityKeys.map((key) => [key, { ok: true, state: "ok", code: "ok" }]),
    ),
  };
  for (const [key, items] of Object.entries(resourceFixtures)) {
    assert.equal(resourceSummaryCount(successfulCount, key), items.length);
    assert.equal(resourceSummaryDisplay(successfulCount, key), `formatted:${items.length}`);
  }

  for (const status of [
    { ok: false, state: "unavailable", code: "unavailable" },
    { ok: false, state: "unavailable", code: "timeout" },
    { ok: false, state: "unavailable", code: "partial" },
    { ok: false, state: "unavailable", code: "unsupported_schema" },
  ]) {
    const unreadable = {
      summary: { plugins: resourceFixtures.plugins.length },
      readStatus: { plugins: status },
    };
    assert.equal(resourceSummaryCount(unreadable, "plugins"), null);
    assert.equal(resourceSummaryDisplay(unreadable, "plugins"), "无法读取");
  }

  assert.equal(
    resourceSummaryDisplay(
      {
        summary: { mcpServers: null },
        readStatus: { mcpServers: { ok: true, state: "ok", code: "ok" } },
      },
      "mcpServers",
    ),
    "无法读取",
  );
  assert.equal(resourceSummaryDisplay({ summary: { marketplaces: "not-a-count" } }, "marketplaces"), "无法读取");
  assert.equal(resourceSummaryDisplay({ summary: { marketplaces: "" } }, "marketplaces"), "无法读取");
  assert.deepEqual(formattedValues, [
    0,
    ...Object.values(resourceFixtures).map((items) => items.length),
  ]);
});

test("statistics explain whether each request was manual auxiliary or automatic", () => {
  assert.match(rendererSource, /function usageRequestSourceLabel\b/);
  assert.match(rendererSource, /usageRequestSourceLabel\(event\)/);
  assert.match(rendererSource, /\["请求来源",\s*usageRequestSourceLabel\(event\)\]/);
});

test("statistics do not describe saved request history as models currently running", () => {
  assert.match(rendererSource, /历史请求，不代表模型正在后台运行/);
  assert.match(rendererSource, /return "当前配置"/);
});

test("desktop renderer resource blocks do not turn unreadable authorities into empty lists", () => {
  const helperSource = rendererSource.slice(0, rendererSource.indexOf("const api = createStateUnavailableGuardedApi"));
  const blockStart = rendererSource.indexOf("function resourceBlock(");
  const blockEnd = rendererSource.indexOf("\nfunction resourceItem(", blockStart);
  const resourceBlockSource = rendererSource.slice(blockStart, blockEnd);
  const sandbox = {
    resourceExpandedKeys: new Set(),
    resourceShortLabel: (item) => item?.name || "-",
    resourceItem: (item) => `<li>${item?.name || "-"}</li>`,
    escapeHtml: (value) => String(value ?? ""),
    formatNumber: (value) => String(value),
  };
  runInNewContext(
    `${helperSource}\n${resourceBlockSource}\nglobalThis.resourceBlockHelpers = { resourceBlock, resourceSummaryReadStatus };`,
    sandbox,
  );
  const { resourceBlock, resourceSummaryReadStatus } = sandbox.resourceBlockHelpers;

  const unavailableHtml = resourceBlock(
    "已安装插件",
    [],
    sandbox.resourceShortLabel,
    "plugins",
    { ok: false, state: "unavailable", code: "timeout" },
  );
  assert.match(unavailableHtml, /<span>无法读取<\/span>/);
  assert.match(unavailableHtml, /<li class="muted">无法读取<\/li>/);
  assert.doesNotMatch(unavailableHtml, /暂无|<span>0<\/span>/);

  const successfulEmptyHtml = resourceBlock(
    "已安装插件",
    [],
    sandbox.resourceShortLabel,
    "plugins",
    { ok: true, state: "ok", code: "ok" },
  );
  assert.match(successfulEmptyHtml, /<span>0<\/span>/);
  assert.match(successfulEmptyHtml, /<li class="muted">暂无<\/li>/);
  assert.equal(resourceBlock("已安装插件", [], sandbox.resourceShortLabel, "plugins", {ok: true, state: "ok"}, true), "");
  assert.match(resourceBlock("已安装插件", [], sandbox.resourceShortLabel, "plugins", {ok: false, state: "unavailable"}, true), /无法读取/);
  assert.match(resourceBlock("已安装插件", [], sandbox.resourceShortLabel, "plugins", resourceSummaryReadStatus({summary:{plugins:null}}, "plugins"), true), /无法读取/);

  const missingStatusHtml = resourceBlock(
    "已安装插件",
    [],
    sandbox.resourceShortLabel,
    "plugins",
    resourceSummaryReadStatus({ summary: { plugins: null } }, "plugins"),
  );
  assert.match(missingStatusHtml, /<span>无法读取<\/span>/);
  assert.doesNotMatch(missingStatusHtml, /暂无|<span>0<\/span>/);
});

test("resource summary mirrors the ChatGPT plugin-page apps count", () => {
  assert.match(rendererSource, /<span>应用<\/span><strong>\$\{resourceSummaryDisplay\(resources, "apps"\)\}<\/strong>/);
  assert.match(rendererSource, /resourceBlock\("应用", filteredResources\.apps/);
});

test("desktop renderer keeps unknown Codex resource totals out of config package summaries", () => {
  const helperSource = rendererSource.slice(0, rendererSource.indexOf("const api = createStateUnavailableGuardedApi"));
  const summaryStart = rendererSource.indexOf("function configPackageExportSummary(");
  const summaryEnd = rendererSource.indexOf("\nels.copyResourceDiagnostics", summaryStart);
  const configPackageSummarySource = rendererSource.slice(summaryStart, summaryEnd);
  const sandbox = {
    formatNumber: (value) => String(value),
  };
  runInNewContext(
    `${helperSource}\n${configPackageSummarySource}\nglobalThis.configPackageHelpers = { configPackageExportSummary, codexResourceCountLabel };`,
    sandbox,
  );
  const { configPackageExportSummary, codexResourceCountLabel } = sandbox.configPackageHelpers;
  const successfulEmpty = {
    codexResourceCount: 0,
    codexResourceReadStatus: {
      plugins: { ok: true, state: "ok" },
      mcpServers: { ok: true, state: "ok" },
      skills: { ok: true, state: "ok" },
      marketplaces: { ok: true, state: "ok" },
    },
  };
  const unavailable = {
    codexResourceCount: 0,
    codexResourceReadStatus: {
      ...successfulEmpty.codexResourceReadStatus,
      plugins: { ok: false, state: "unavailable", code: "timeout" },
    },
  };

  assert.equal(codexResourceCountLabel(successfulEmpty, " 项"), "0 项");
  assert.equal(codexResourceCountLabel(unavailable, " 项"), "无法读取");
  assert.equal(codexResourceCountLabel({}, " 项"), "未知");
  assert.match(configPackageExportSummary(successfulEmpty), /Codex 资源清单 0 项/);
  assert.match(configPackageExportSummary(unavailable), /Codex 资源清单 无法读取/);
  assert.doesNotMatch(configPackageExportSummary(unavailable), /Codex 资源清单 0 项/);
  assert.match(rendererSource, /`Codex 资源 \$\{codexResourceCountLabel\(status\)\}`/);
});

test("manual resource refresh shares the deduplicated loader and announces only a successful read", async () => {
  const start = rendererSource.indexOf('els.refreshResources?.addEventListener("click"');
  const end = rendererSource.indexOf('els.refreshPluginMarketplaces?.addEventListener', start);
  let clickHandler;
  let readSucceeded = false;
  const requests = [];
  const toasts = [];
  runInNewContext(rendererSource.slice(start,end), {
    els:{refreshResources:{addEventListener:(_event,handler) => { clickHandler = handler; }}},
    runAction:(_button,action) => action(),
    ensureDetailedStateForSection:async (section,options) => { requests.push({section,...options}); return readSucceeded; },
    showToast:message => toasts.push(message),
  });
  await clickHandler();
  assert.deepEqual(toasts, []);
  readSucceeded = true;
  await clickHandler();
  assert.deepEqual(requests, [{section:'resources',refreshCore:true},{section:'resources',refreshCore:true}]);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /已刷新/);
});

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
  assert.match(rendererSource, /progress\.percent === null \|\| progress\.percent === undefined \|\| progress\.percent === ""/u);
  assert.match(rendererSource, /result\.relaunching \? "restarting" : result\.installerPath \? "launching" : "ready"/);
  assert.match(rendererSource, /result\.nextStep \|\| result\.message/);
  assert.match(rendererSource, /bytesPerSecond/);
  assert.match(rendererSource, /formatBytes\(details\.bytesPerSecond\)/);
  assert.match(rendererSource, /\}\/s`/);
  assert.match(rendererSource, /els\.appVersion\.textContent = `v\$\{state\.appVersion \|\| "-"\}`;/);
  assert.match(rendererSource, /showUpdateDialog/);
  assert.match(rendererSource, /phase === "restarting"/);
  const updateFlowSource = rendererSource.slice(
    rendererSource.indexOf("function runUpdateCheck"),
    rendererSource.indexOf("function resetUpdateProgress"),
  );
  assert.doesNotMatch(updateFlowSource, /window\.confirm/);
  assert.doesNotMatch(rendererSource, /Windows Setup installer will be saved|updates folder|manual fallback/);
  assert.doesNotMatch(htmlSource, /Windows Setup installer will be saved|updates folder|manual fallback/);
});

test("desktop renderer opens folder buttons through the shared action handler", () => {
  assert.match(rendererSource, /bindFolderButton\("#openConfigFolder", "config"\)/);
  assert.match(rendererSource, /bindFolderButton\("#openUpdateFolder", "updates"\)/);
  assert.match(rendererSource, /function bindFolderButton/);
  assert.match(rendererSource, /runAction\(button, async \(\) =>/);
});

test("desktop renderer keeps Codex config writes behind router lifecycle", () => {
  assert.doesNotMatch(htmlSource, /id="initializeCodex"/);
  assert.doesNotMatch(htmlSource, /id="restoreCodexConfig"/);
  assert.doesNotMatch(htmlSource, /data-section="codex"/);
  assert.doesNotMatch(htmlSource, /id="codex"/);
  assert.match(htmlSource, /id="restartCodex"/);
  assert.match(htmlSource, /id="selectCodexDesktopExe"/);
  assert.match(htmlSource, /id="restartCodex">重启 ChatGPT \/ Codex</);
  assert.match(htmlSource, /选择 ChatGPT \/ Codex 启动项/);
  assert.match(htmlSource, /ChatGPT \/ Codex 路径/);
  assert.match(htmlSource, /id="codexDesktopPath"/);
  assert.match(preloadSource, /restartCodex: \(\) => ipcRenderer\.invoke\("codex:restart"\)/);
  assert.match(preloadSource, /selectCodexDesktopExe: \(\) => ipcRenderer\.invoke\("codex:select-exe"\)/);
  assert.match(rendererSource, /api\.restartCodex\(\)/);
  assert.match(rendererSource, /api\.selectCodexDesktopExe\(\)/);
  assert.match(rendererSource, /state\.desktopOptions\?\.codexDesktopLaunchTarget/);
  assert.match(rendererSource, /CHATGPT_DESKTOP_EXE \/ CODEX_DESKTOP_EXE/);
  assert.match(mainSource, /ipcMain\.handle\("codex:select-exe"/);
  assert.match(mainSource, /codexDesktopExe/);
  assert.match(mainSource, /codexDesktopLaunchTarget/);
  assert.match(mainSource, /extensions:\s*selectingMacApp\s*\?\s*\["app"\]\s*:\s*\["exe", "lnk"\]/);
  assert.match(mainSource, /Choose ChatGPT\.app or Codex\.app/);
  assert.match(mainSource, /Choose ChatGPT\.exe, Codex\.exe, or a compatible shortcut/);
});

test("desktop main can restart ChatGPT or Codex from Windows Start Menu app entries", () => {
  assert.match(mainSource, /firstLaunchableCodexDesktopTarget/);
  assert.match(mainSource, /isLaunchableCodexDesktopTarget/);
  assert.match(mainSource, /codexDesktopShellAppCandidates/);
  assert.match(mainSource, /Get-StartApps/);
  assert.match(mainSource, /shell:AppsFolder/);
  assert.match(mainSource, /isOpenAIDesktopShortcutName/);
  assert.match(mainSource, /Microsoft[\s\S]*WindowsApps[\s\S]*ChatGPT\.exe/);
  assert.match(mainSource, /Microsoft[\s\S]*WindowsApps[\s\S]*Codex\.exe/);
});

test("desktop renderer keeps provider details behind dedicated edit views", () => {
  assert.doesNotMatch(htmlSource, /data-section="modelConfig"/);
  assert.match(htmlSource, /id="modelConfig"/);
  assert.match(rendererSource, /function prepareRendererLayout/);
  assert.match(rendererSource, /provider-editor-panel/);
  assert.match(rendererSource, /custom-editor-panel/);
  assert.match(rendererSource, /providerPreview/);
  assert.match(rendererSource, /renderModelCardGroups\(els\.modelPool, selected, false\)/);
  assert.doesNotMatch(rendererSource, /renderModelCardGroups\(els\.modelConfigPool, selected, true\)/);
  assert.match(rendererSource, /data-refresh-provider-models/);
  assert.match(rendererSource, /data-provider-edit/);
  assert.match(rendererSource, /data-open-custom-editor/);
});

test("desktop renderer exposes editable provider settings and connection tests", () => {
  assert.match(rendererSource, /data-provider-name/);
  assert.match(rendererSource, /data-provider-short-name/);
  assert.match(rendererSource, /data-provider-base-url/);
  assert.doesNotMatch(rendererSource, /data-provider-api/);
  assert.match(rendererSource, /data-provider-key-url/);
  assert.match(rendererSource, /data-provider-docs-url/);
  assert.match(rendererSource, /data-provider-logo-upload/);
  assert.match(rendererSource, /data-save-provider-settings/);
  assert.match(rendererSource, /data-reset-provider-settings/);
  assert.match(rendererSource, /data-test-provider-connection/);
  assert.doesNotMatch(rendererSource, /data-provider-logo-url/);
  assert.doesNotMatch(rendererSource, /模型数量/);
  assert.match(rendererSource, /api\.saveProvider/);
  assert.match(rendererSource, /api\.resetProvider/);
  assert.match(rendererSource, /api\.testProviderConnection/);
  assert.match(rendererSource, /api\.selectLocalLogo/);
  assert.match(preloadSource, /saveProvider: \(payload\) => ipcRenderer\.invoke\("providers:save", payload\)/);
  assert.match(preloadSource, /resetProvider: \(providerId\) => ipcRenderer\.invoke\("providers:reset", providerId\)/);
  assert.match(preloadSource, /testProviderConnection: \(payload\) => ipcRenderer\.invoke\("providers:testConnection", payload\)/);
  assert.match(preloadSource, /selectLocalLogo: \(payload\) => ipcRenderer\.invoke\("logos:select", payload\)/);
  assert.match(mainSource, /ipcMain\.handle\("providers:save"/);
  assert.match(mainSource, /ipcMain\.handle\("providers:reset"/);
  assert.match(mainSource, /ipcMain\.handle\("providers:testConnection"/);
  assert.match(mainSource, /ipcMain\.handle\("logos:select"/);
});

test("desktop renderer exposes API editing on every model instead of the provider", () => {
  assert.match(rendererSource, /编辑模型/);
  assert.match(rendererSource, /data-model-api=/);
  assert.match(rendererSource, /data-model-api-save=/);
  assert.match(rendererSource, /saveInlineModelApi/);
});

test("inline model API and context saves preserve the model's other manual overrides", () => {
  const contextStart = rendererSource.indexOf("function saveInlineModelContext");
  const apiStart = rendererSource.indexOf("function saveInlineModelApi");
  const summaryStart = rendererSource.indexOf("function modelCapabilitySummary");
  const contextHandler = rendererSource.slice(contextStart, apiStart);
  const apiHandler = rendererSource.slice(apiStart, summaryStart);

  assert.notEqual(contextStart, -1);
  assert.notEqual(apiStart, -1);
  assert.match(contextHandler, /\.\.\.model\.capabilityOverrides/);
  assert.match(apiHandler, /\.\.\.model\.capabilityOverrides/);
});

test("desktop renderer gates remote provider actions behind API keys", () => {
  assert.match(rendererSource, /providerCanRefreshModels/);
  assert.match(rendererSource, /providerHasSavedApiKey/);
  assert.match(rendererSource, /data-provider-refresh-disabled/);
  assert.match(rendererSource, /先填写并保存 API Key/);
  assert.match(rendererSource, /saveProviderSettingsFromCard/);
});

test("provider model refresh saves edited custom intermediary settings even when the key is already stored", () => {
  const start = rendererSource.indexOf("async function saveProviderSettingsBeforeRemoteAction");
  const end = rendererSource.indexOf("\nfunction renderProviderEditor", start);
  const handler = rendererSource.slice(start, end);

  assert.notEqual(start, -1);
  assert.doesNotMatch(handler, /!apiKey/);
  assert.match(handler, /if \(!card\)/);
  assert.match(handler, /return saveProviderSettingsFromCard\(card\)/);
});

test("desktop renderer gives custom providers the same key, context, and test controls", () => {
  assert.match(htmlSource, /id="customApiKey"/);
  assert.match(htmlSource, /id="customContextWindow"/);
  assert.match(htmlSource, /id="customDocsUrl"/);
  assert.match(htmlSource, /id="customLogoUpload"/);
  assert.doesNotMatch(htmlSource, /Logo URL/);
  assert.match(htmlSource, /id="testCustomConnection"/);
  assert.match(rendererSource, /apiKey: value\("#customApiKey"\)/);
  assert.match(rendererSource, /contextWindow: Number\(value\("#customContextWindow"\) \|\| 258400\)/);
  assert.match(rendererSource, /customProviderPayload/);
  assert.match(rendererSource, /api\.testProviderConnection\(customProviderPayload/);
});

test("desktop renderer uses real provider logos with a visible default fallback", () => {
  assert.match(rendererSource, /text\.includes\("xiaomi"\)/);
  assert.match(rendererSource, /provider-logo-add/);
  assert.match(rendererSource, /provider\?\.id === "__custom__"/);
  assert.match(rendererSource, /custom: "default\.svg"/);
  assert.match(rendererSource, /default: "default\.svg"/);
  assert.equal(existsSync(resolve(__dirname, "../desktop/renderer/assets/providers/default.svg")), true);
  assert.doesNotMatch(kimiLogoSource, /fill="#fff"/i);
  assert.match(defaultLogoSource, />AI</);
});

test("Claude, Gemini, and Grok render their own bundled brand logos", () => {
  const logoStart = rendererSource.indexOf("function providerLogo(");
  const logoEnd = rendererSource.indexOf("function renderModelPool(", logoStart);
  const sandbox = { escapeHtml: (value) => String(value) };
  runInNewContext(
    `${rendererSource.slice(logoStart, logoEnd)}\n` +
      "globalThis.providerLogoForTest = providerLogo;",
    sandbox,
  );

  const cases = [
    [{ id: "anthropic", shortName: "Claude" }, "claude.svg"],
    [{ id: "gemini", shortName: "Gemini" }, "gemini.svg"],
    [{ id: "xai", shortName: "Grok" }, "grok.ico"],
  ];
  for (const [provider, filename] of cases) {
    const markup = sandbox.providerLogoForTest(provider);
    assert.match(markup, new RegExp(`assets/providers/${filename}`));
    assert.doesNotMatch(markup, /assets\/providers\/default\.svg/);
    assert.equal(existsSync(resolve(__dirname, "../desktop/renderer/assets/providers", filename)), true);
  }
});

test("desktop renderer enlarges the default AI provider logo", () => {
  assert.match(defaultLogoSource, /rect x="3" y="3" width="18" height="18"/);
  assert.match(defaultLogoSource, /font-size="7\.2"/);
  assert.match(cssSource, /\.provider-logo-default img\s*{[\s\S]*width:\s*34px;[\s\S]*height:\s*34px;/);
});

test("desktop renderer places provider custom model creation near the model list", () => {
  assert.match(rendererSource, /data-open-provider-custom-model/);
  assert.match(rendererSource, /添加自定义模型/);
  assert.match(rendererSource, /openProviderCustomModelEditor/);
  assert.match(rendererSource, /customReturnView/);
  assert.match(rendererSource, /returnFromCustomEditor/);
});

test("desktop renderer lets users remove unavailable selected model slots", () => {
  assert.match(rendererSource, /data-remove-selected-slot/);
  assert.match(rendererSource, /removeDraftSelectionAt/);
  assert.match(rendererSource, /模型不可用/);
  assert.match(rendererSource, /移除这个模型/);
  assert.match(cssSource, /\.slot-remove/);
});

test("desktop renderer exposes bulk cleanup and default restore for broken model selections", () => {
  assert.match(htmlSource, /id="cleanUnavailableModels"/);
  assert.match(htmlSource, /清理不可用模型/);
  assert.match(htmlSource, /id="restoreDefaultModels"/);
  assert.match(htmlSource, /恢复默认选择/);
  assert.match(rendererSource, /cleanUnavailableSelectedModels/);
  assert.match(rendererSource, /restoreDefaultModelSelection/);
  assert.match(rendererSource, /data-unavailable-model-id/);
  assert.match(cssSource, /\.selection-tools/);
});

test("desktop renderer has a provider-scoped custom model form", () => {
  assert.match(htmlSource, /data-custom-provider-field/);
  assert.match(htmlSource, /data-custom-global-field/);
  assert.match(rendererSource, /scopedCustomProviderId/);
  assert.match(rendererSource, /customModelFromProvider/);
  assert.match(rendererSource, /els\.customModelForm\.classList\.toggle\("provider-scoped"/);
  assert.match(cssSource, /\.custom-form\.provider-scoped \[data-custom-provider-field\]/);
  assert.match(cssSource, /\.custom-form\.provider-scoped \[data-custom-global-field\]/);
});

test("desktop renderer exposes direct per-model context editing", () => {
  assert.match(rendererSource, /data-inline-context/);
  assert.match(rendererSource, /data-model-context-save/);
  assert.match(rendererSource, /saveInlineModelContext/);
  const inlineContextSave = rendererSource.slice(
    rendererSource.indexOf("function saveInlineModelContext"),
    rendererSource.indexOf("function modelCapabilitySummary"),
  );
  assert.match(inlineContextSave, /capabilities:\s*{\s*\.\.\.model\.capabilityOverrides,\s*contextWindow,\s*}/s);
  assert.doesNotMatch(inlineContextSave, /inputModalities/);
  assert.doesNotMatch(inlineContextSave, /reasoning/);
  assert.match(cssSource, /\.provider-model-controls\s*{\s*display: grid/s);
  assert.match(cssSource, /\.model-context-inline\s*{[\s\S]*grid-template-columns: auto minmax\(130px, 1fr\) auto/);
  assert.match(cssSource, /\.model-context-inline label\s*{[\s\S]*display: contents/s);
});

test("desktop renderer balances provider model quick controls", () => {
  assert.match(cssSource, /\.provider-model-controls\s*{[\s\S]*grid-template-columns:\s*minmax\(140px, 160px\) minmax\(300px, 1fr\)/);
  assert.match(cssSource, /\.provider-model-controls \.capability-toggle\s*{[\s\S]*height:\s*46px/);
  assert.match(cssSource, /\.model-context-inline\s*{[\s\S]*height:\s*46px/);
  assert.match(cssSource, /\.model-context-inline span\s*{[\s\S]*font-weight:\s*700;[\s\S]*align-self:\s*center;/);
  assert.match(cssSource, /\.model-context-inline input\s*{[\s\S]*min-height:\s*32px/);
});

test("desktop renderer hides risky advanced model controls and exposes a reset path", () => {
  const modelControls = rendererSource.slice(
    rendererSource.indexOf("function modelConfigControls"),
    rendererSource.indexOf("function inlineModelContextControl"),
  );
  assert.doesNotMatch(modelControls, /capabilityOverrideControl\(model\)/);
  assert.doesNotMatch(modelControls, /imageGenerationControl\(model\)/);
  assert.match(rendererSource, /modelCapabilityResetControl/);
  assert.match(rendererSource, /data-reset-model-capabilities/);
  assert.match(preloadSource, /resetModelCapabilities: \(presetId\) => ipcRenderer\.invoke\("models:resetCapabilities", presetId\)/);
  assert.match(mainSource, /ipcMain\.handle\("models:resetCapabilities"/);
});

test("desktop renderer treats missing duplicate protection as default off and explains both guards", () => {
  assert.match(htmlSource, /data-section="settings"/);
  assert.match(htmlSource, /id="settings"/);
  assert.match(htmlSource, /id="routerPort"/);
  assert.match(htmlSource, /id="duplicateRequestProtection"/);
  assert.match(
    htmlSource,
    /本地请求节奏（默认关闭）：开启后按路由配置的 RPM 间隔排队；供应商 429 冷却始终生效。/,
  );
  assert.match(
    htmlSource,
    /重复请求保护（默认关闭）：只拦截仍在执行中的完全相同请求，命中后返回本地结果；建议仅在客户端反复重连时开启。/,
  );
  assert.match(htmlSource, /id="smartCodeMode"/);
  assert.match(htmlSource, /id="smartCodeRoute"/);
  assert.match(htmlSource, /id="smartLongContextMode"/);
  assert.match(htmlSource, /id="smartLongContextRoute"/);
  assert.match(htmlSource, /id="smartImageGenerationMode"/);
  assert.match(htmlSource, /id="smartImageGenerationRoute"/);
  assert.match(htmlSource, /id="smartOrdinaryChatMode"/);
  assert.match(htmlSource, /id="smartOrdinaryChatRoute"/);
  assert.match(htmlSource, /id="smartFailoverMode"/);
  assert.match(htmlSource, /id="smartFailoverRoute1"/);
  assert.match(htmlSource, /id="smartFailoverRoute2"/);
  assert.match(htmlSource, /id="smartFailoverRoute3"/);
  assert.match(htmlSource, /id="saveDesktopOptions"/);
  assert.match(htmlSource, /id="repairModelReferences"/);
  assert.match(htmlSource, /id="modelReferenceStatus"/);
  assert.match(htmlSource, /下面的规则只有在上方“自动选模型”或“失败自动切换”开启时才生效/);
  assert.doesNotMatch(htmlSource, /settings-summary-grid/);
  assert.doesNotMatch(htmlSource, /settings-card/);
  assert.match(htmlSource, /settings-actions/);
  assert.match(cssSource, /\.smart-routing-policy/);
  assert.match(cssSource, /\.model-reference-status/);
  assert.match(cssSource, /\.settings-actions/);
  assert.match(rendererSource, /routerPort: Number\(els\.routerPort\.value \|\| 15722\)/);
  assert.match(
    rendererSource,
    /duplicateRequestProtection: els\.duplicateRequestProtection\.checked/,
  );
  assert.match(
    rendererSource,
    /els\.duplicateRequestProtection\.checked = desktopSettingsDraftValue\("duplicateRequestProtection", state\.desktopOptions\?\.duplicateRequestProtection === true\)/,
  );
  assert.match(rendererSource, /api\.repairModelReferences/);
  assert.match(rendererSource, /function renderModelReferenceStatus/);
  assert.match(rendererSource, /state\.modelReferenceStatus/);
  assert.match(preloadSource, /repairModelReferences: \(\) => ipcRenderer\.invoke\("models:repairReferences"\)/);
  assert.match(mainSource, /ipcMain\.handle\("models:repairReferences"/);
  assert.match(mainSource, /modelReferenceStatus: settings\.modelReferenceStatus/);
  assert.match(rendererSource, /smartRouting: smartRoutingOptionsFromInputs\(\)/);
  assert.match(rendererSource, /function renderSmartRoutingSettings/);
  assert.match(rendererSource, /function smartRoutingOptionsFromInputs/);
  assert.match(rendererSource, /function smartRoutingRouteOptions/);
  assert.match(rendererSource, /state\.desktopOptions\?\.routerPort/);
  assert.match(rendererSource, /state\.desktopOptions\?\.smartRouting/);
});

test("desktop renderer gives stale model references direct repair actions", () => {
  assert.match(rendererSource, /data-repair-stale-model-reference/);
  assert.match(rendererSource, /data-remove-stale-model-reference/);
  assert.match(rendererSource, /function bindModelReferenceIssueActions/);
  assert.match(rendererSource, /function repairStaleModelReferences/);
  assert.match(rendererSource, /function removeStaleModelReference/);
  assert.match(rendererSource, /function modelReferenceRepairToast/);
  assert.match(rendererSource, /function providerSaveRepairToast/);
  assert.match(rendererSource, /失效引用/);
  assert.doesNotMatch(rendererSource, /detail: "当前配置"/);
  assert.match(mainSource, /const committed = await commitConfigMutation\(settings, "providers:save", \{/);
  assert.match(mainSource, /return \{\s+saved,\s+sync: committed,/);
  assert.doesNotMatch(mainSource, /syncRouteStateAfterMutation/);
});

test("smart routing options compare saved route ids against current route ids", () => {
  const start = rendererSource.indexOf("function smartRoutingRouteOptions");
  const end = rendererSource.indexOf("function populateSmartRoutingRouteSelect", start);
  const body = rendererSource.slice(start, end);
  assert.match(body, /state\?\.models/);
  assert.match(body, /model\.id/);
  assert.doesNotMatch(body, /state\?\.modelPresets/);
  assert.doesNotMatch(body, /model\.presetId/);
});

test("desktop renderer sends an image-generation key with the same save mutation", () => {
  const start = rendererSource.indexOf("function saveImageGenerationSettings");
  const end = rendererSource.indexOf("function imageGenerationPayload", start);
  const body = rendererSource.slice(start, end);
  assert.match(body, /imageGeneration\.apiKey = apiKey/);
  assert.match(body, /api\.saveModelImageGeneration\s*\(/);
  assert.doesNotMatch(body, /api\.saveSecrets\s*\(/);
});

test("desktop renderer lets users configure Codex auxiliary task handling", () => {
  assert.match(htmlSource, /id="interceptCodexAuxiliaryTasks"/);
  assert.match(htmlSource, /id="codexAuxiliaryModelId"/);
  assert.match(htmlSource, /拦截 Codex 辅助任务/);
  assert.match(rendererSource, /interceptCodexAuxiliaryTasks: els\.interceptCodexAuxiliaryTasks\?\.checked \|\| false/);
  assert.match(rendererSource, /codexAuxiliaryModelId: String\(els\.codexAuxiliaryModelId\?\.value \|\| ""\)\.trim\(\)/);
  assert.match(rendererSource, /function renderCodexAuxiliaryTaskSettings/);
  assert.match(rendererSource, /function codexAuxiliaryRouteOptions/);
  assert.match(rendererSource, /Array\.isArray\(state\?\.models\) \? state\.models : \[\]/);
});

test("desktop renderer surfaces route capabilities and real upstream status", () => {
  assert.match(rendererSource, /data-capability-badges/);
  assert.match(rendererSource, /function modelCapabilityBadges/);
  assert.match(rendererSource, /function modelCapabilityHints/);
  assert.match(rendererSource, /Tools/);
  assert.match(rendererSource, /\["MCP", status\.mcpNamespaces/);
  assert.match(rendererSource, /Compact/);
  assert.match(rendererSource, /latest\.upstreamModel/);
  assert.match(rendererSource, /routeProviderName/);
  assert.match(rendererSource, /latest\.api/);
});

test("desktop renderer keeps heavy startup data lazy and dense pages folded", () => {
  assert.match(preloadSource, /getState: \(options\) => ipcRenderer\.invoke\("state:get", options \|\| \{\}\)/);
  assert.match(mainSource, /ipcMain\.handle\("state:get", async \(_event, options = \{\}\) =>/);
  assert.match(mainSource, /const lite = Boolean\(options\.lite\);/);
  assert.match(mainSource, /stateDetailLoaded: fullDetail/);
  assert.doesNotMatch(mainSource, /rendererNeedsDetailedState/);
  assert.match(mainSource, /function initUsageStore\(\)/);
  assert.match(mainSource, /scheduleDeferredStartupWork\(\)/);
  assert.match(mainSource, /let legacyDataMigrationFinished = !app\.isPackaged \|\| Boolean\(process\.env\.CODEXBRIDGE_DATA_DIR\);/);
  assert.match(mainSource, /runLegacyDataMigration\(\)\.catch/);
  assert.doesNotMatch(mainSource, /const legacyDataMigration = app\.isPackaged/);
  assert.match(mainSource, /markStartupOnce\("window-ready"\)/);
  assert.match(mainSource, /markStartupOnce\("core-state-loaded"\)/);
  assert.match(mainSource, /markStartupOnce\("deferred-scan-start"\)/);
  assert.match(mainSource, /getStatePayload\(settings, \{ lite: true \}\)/);
  assert.match(mainSource, /let codexSessionSnapshot = null;[\s\S]*?if \(includeSessionDetail\)[\s\S]*?await runCodexSessionSnapshotWorker/);
  assert.doesNotMatch(mainSource, /const codexSessionTree = includeSessionDetail[\s\S]*?settings\.listCodexSessionTree/);
  assert.match(mainSource, /let codexResourceSnapshots = null;[\s\S]*?if \(includeResourceSnapshots\)[\s\S]*?await readCodexResourceSnapshotsRetained\(\{[\s\S]*?forceRefresh: Boolean\(options\.forceResourceRefresh\),[\s\S]*?\}\)/);
  assert.match(mainSource, /const codexCliSnapshot = codexResourceSnapshots\?\.codexCliSnapshot \|\| null;/);
  assert.match(mainSource, /const codexPromptInputSnapshot = codexResourceSnapshots\?\.codexPromptInputSnapshot \|\| null;/);
  assert.match(rendererSource, /refresh\(\{ lite: true \}\)/);
  assert.match(rendererSource, /const DETAIL_STATE_SECTIONS = new Set\(\["preflight", "capabilities", "resources", "sessions"\]\)/);
  assert.match(rendererSource, /const SETTINGS_DETAIL_SECTIONS = new Set\(\["settings"\]\)/);
  assert.match(rendererSource, /ensureDetailedStateForSection/);
  assert.match(rendererSource, /ensureSettingsDetailForSection/);
  assert.match(rendererSource, /renderDetailLoading/);
  assert.match(rendererSource, /function currentSectionId\(\)/);
  assert.match(rendererSource, /function renderActiveSection\(sectionId = currentSectionId\(\)\)/);
  assert.match(rendererSource, /function mergeStateWithRetainedDetailSlices\(previousState, nextState\)/);
  assert.match(rendererSource, /state = mergeStateWithRetainedDetailSlices\(state, nextState\)/);
  const renderBody = rendererSource.slice(
    rendererSource.indexOf("function render()"),
    rendererSource.indexOf("function renderActiveSection"),
  );
  assert.match(renderBody, /renderActiveSection\(currentSectionId\(\)\)/);
  assert.doesNotMatch(renderBody, /renderResources\(\);/);
  assert.doesNotMatch(renderBody, /renderSessions\(\);/);
  assert.doesNotMatch(renderBody, /renderCapabilityDiagnostics\(\);/);
  assert.doesNotMatch(renderBody, /renderModelPool\(\);/);
  assert.match(mainSource, /const includeSettingsDetail = fullDetail \|\| Boolean\(options\.settingsDetail\);/);
  assert.match(mainSource, /settingsDetailLoaded: settingsDetailAvailable/);
  assert.match(mainSource, /let codexBackups = \[\];[\s\S]*?if \(includeSettingsDetail\)[\s\S]*?settings\.listCodexBackups\(\)/);
  assert.match(rendererSource, /capability-model-details/);
  assert.match(rendererSource, /<details class="capability-matrix-row capability-model-details">/);
  assert.match(rendererSource, /<details class="resource-diagnostics"/);
  assert.match(rendererSource, /<details class="session-diagnostics"/);
  assert.match(rendererSource, /check-passed-details/);
  assert.match(rendererSource, /startupCheckSummaryFromItems\(items,\s*summary\)/);
  assert.match(rendererSource, /visibleSummary\.warn/);
  assert.match(cssSource, /\.capability-model-details > summary/);
  assert.match(cssSource, /\.resource-diagnostics/);
  assert.match(cssSource, /\.session-diagnostics/);
});

test("detailed pages request only their own expensive state slices", () => {
  assert.match(rendererSource, /detailSection:\s*sectionId/u);
  assert.match(rendererSource, /const loadedDetailSections = new Set\(\)/u);
  assert.match(rendererSource, /const loadingDetailSections = new Set\(\)/u);
  assert.match(mainSource, /const includeResourceDetail = fullDetail \|\| detailSection === "resources"/u);
  assert.match(mainSource, /const includeSessionDetail = fullDetail \|\| detailSection === "sessions"/u);
  assert.match(mainSource, /const includeCapabilityDetail = fullDetail \|\| detailSection === "capabilities"/u);
  assert.match(mainSource, /const includePreflightDetail = fullDetail \|\| detailSection === "preflight"/u);
});

test("partial detail snapshots replace only their own slice and retain the others", () => {
  const start = rendererSource.indexOf("const RETAINED_DETAIL_SLICE_KEYS");
  const end = rendererSource.indexOf("\nfunction render()", start);
  assert.ok(start >= 0 && end > start);
  const sandbox = {
    stateDetailLoaded: false,
    settingsDetailLoaded: false,
    DETAIL_STATE_SECTIONS: new Set(["preflight", "capabilities", "resources", "sessions"]),
  };
  runInNewContext(
    `${rendererSource.slice(start, end)}\n` +
      "globalThis.mergeState = mergeStateWithRetainedDetailSlices;",
    sandbox,
  );
  const previous = {
    stateDetailLoaded: false,
    detailSectionsLoaded: ["resources", "sessions", "capabilities"],
    codexResources: { marker: "old-resources" },
    codexSessionTree: { marker: "old-sessions" },
    capabilityExecutionHistory: [{ id: "old-history" }],
    imageGenerationHistory: [{ id: "old-image" }],
  };
  const resources = sandbox.mergeState(previous, {
    stateDetailLoaded: false,
    detailSectionsLoaded: ["resources"],
    codexResources: { marker: "new-resources" },
    codexSessionTree: null,
    capabilityExecutionHistory: [],
    imageGenerationHistory: [],
  });
  assert.equal(resources.codexResources.marker, "new-resources");
  assert.equal(resources.codexSessionTree.marker, "old-sessions");
  assert.equal(resources.capabilityExecutionHistory[0].id, "old-history");

  const capabilities = sandbox.mergeState(resources, {
    stateDetailLoaded: false,
    detailSectionsLoaded: ["capabilities"],
    codexResources: null,
    codexSessionTree: null,
    capabilityExecutionHistory: [],
    imageGenerationHistory: [],
  });
  assert.equal(capabilities.codexResources.marker, "new-resources");
  assert.equal(capabilities.codexSessionTree.marker, "old-sessions");
  assert.equal(capabilities.capabilityExecutionHistory.length, 0);
  assert.equal(capabilities.imageGenerationHistory.length, 0);
});

test("a failed optional detail read preserves writable core state and clears on retry", () => {
  const start = rendererSource.indexOf("const RETAINED_DETAIL_SLICE_KEYS");
  const end = rendererSource.indexOf("\nfunction render()", start);
  const sandbox = {
    stateDetailLoaded: false,
    settingsDetailLoaded: false,
    DETAIL_STATE_SECTIONS: new Set(["preflight", "capabilities", "resources", "sessions"]),
  };
  runInNewContext(
    `${rendererSource.slice(start, end)}\n` +
      "globalThis.mergeState = mergeStateWithRetainedDetailSlices;",
    sandbox,
  );
  const previous = {
    stateUnavailable: false,
    models: [{ id: "old" }],
    stateDetailLoaded: false,
    detailSectionsLoaded: ["sessions"],
    detailSectionErrors: {},
    codexSessionTree: { marker: "last-good" },
  };
  const failed = sandbox.mergeState(previous, {
    stateUnavailable: false,
    models: [{ id: "new" }],
    stateDetailLoaded: false,
    detailSectionsLoaded: [],
    detailSectionErrors: {
      sessions: { code: "worker_task_timeout", message: "会话读取失败" },
    },
    codexSessionTree: null,
  });
  assert.equal(failed.stateUnavailable, false);
  assert.equal(failed.models[0].id, "new");
  assert.equal(failed.codexSessionTree.marker, "last-good");
  assert.equal(failed.detailSectionErrors.sessions.code, "worker_task_timeout");
  assert.equal(failed.detailSectionsLoaded.includes("sessions"), false);
  assert.equal(failed.stateDetailLoaded, false);

  const recovered = sandbox.mergeState(failed, {
    stateUnavailable: false,
    models: [{ id: "new" }],
    stateDetailLoaded: false,
    detailSectionsLoaded: ["sessions"],
    detailSectionErrors: {},
    codexSessionTree: { marker: "recovered" },
  });
  assert.equal(recovered.codexSessionTree.marker, "recovered");
  assert.equal(recovered.detailSectionErrors.sessions, undefined);
  assert.equal(recovered.detailSectionsLoaded.includes("sessions"), true);
});

test("lightweight mutation responses retain already loaded detail slices", () => {
  assert.match(rendererSource, /function adoptStateSnapshot\(nextState\)/u);
  assert.match(rendererSource, /adoptStateSnapshot\(await api\.saveModelImageGeneration\(/u);
  assert.match(
    rendererSource,
    /adoptStateSnapshot\(response\?\.state \|\| await api\.getState\(\)\)/u,
  );
  assert.doesNotMatch(
    rendererSource,
    /state\s*=\s*await api\.(?:saveOptions|saveModelImageInput|saveModelImageGeneration|removeCustomModel|applyConfigProfile)\(/u,
  );
});

test("a budget save's lightweight snapshot retains previously loaded resources and sessions", async () => {
  const sandbox = budgetSaveHarness(async options => detailStateSnapshot({desktopOptions:{usageBudgets:options.usageBudgets}}));
  const detail = createDetailStateHarness(detailStateSnapshot({
    desktopOptions:sandbox.state.desktopOptions,
    detailSectionsLoaded:['resources','sessions'],codexResources:{marker:'retained-resources'},codexSessions:[{id:'retained-session'}],
  }));
  sandbox.state = detail.snapshot();
  sandbox.adoptStateSnapshot = next => { detail.adopt(next); sandbox.state = detail.snapshot(); };
  editBudget(sandbox,'usageDailyCallLimit','123');
  await sandbox.saveUsageBudgetSettings();
  assert.equal(sandbox.state.desktopOptions.usageBudgets.global.dailyCallLimit,123);
  assert.equal(sandbox.state.codexResources.marker,'retained-resources');
  assert.equal(sandbox.state.codexSessions[0].id,'retained-session');
});

function detailStateSnapshot(overrides = {}) {
  return {
    stateConfigRevision: "config-before",
    stateUnavailable: false,
    models: [{ id: "model-before" }],
    selectedModelIds: ["model-before"],
    routerRunning: false,
    stateDetailLoaded: false,
    detailSectionsLoaded: [],
    settingsDetailLoaded: false,
    detailSectionErrors: {},
    startupCheck: null,
    codexResources: null,
    codexSessions: [],
    codexSessionTree: null,
    codexProjectRecoveryPlan: null,
    capabilityExecutionHistory: [],
    imageGenerationHistory: [],
    codexBackups: [],
    usageEvents: [],
    usageSummary: {},
    usageBudgetAlerts: [],
    usageCostEstimate: {},
    logs: [],
    ...overrides,
  };
}

function createDetailStateHarness(initialState = detailStateSnapshot()) {
  const helperEnd = rendererSource.indexOf("const api = createStateUnavailableGuardedApi");
  const detailDeclarationsStart = rendererSource.indexOf("let stateDetailLoaded = false;");
  const detailDeclarationsEnd = rendererSource.indexOf("const LOCAL_CAPABILITY_ADAPTERS", detailDeclarationsStart);
  const subscriptionsStart = rendererSource.indexOf("api.onLogs((logs) => {");
  const subscriptionsEnd = rendererSource.indexOf("\nrefresh({ lite: true });", subscriptionsStart);
  const detailFunctionsStart = rendererSource.indexOf("async function refresh(options = {})");
  const detailFunctionsEnd = rendererSource.indexOf("\nfunction render()", detailFunctionsStart);
  const pending = [];
  const listeners = {};
  const renders = [];
  const toasts = [];
  const sandbox = {
    bridge: {
      getState(options) {
        return new Promise((resolve, reject) => pending.push({ options, resolve, reject }));
      },
      onState(callback) { listeners.state = callback; },
      onUsage(callback) { listeners.usage = callback; },
      onLogs(callback) { listeners.logs = callback; },
      saveOptions() { return "write-ok"; },
    },
    els: { sessionList: { innerHTML: "" }, backupList: { innerHTML: "" } },
    console: { info() {}, error() {} },
    showToast(message, type) { toasts.push({ message, type }); },
    render() { renders.push("all"); },
    renderActiveSection(section) { renders.push(section); },
    renderLogs() {},
    renderUsage() {},
    renderUsageBudgetAlerts() {},
    renderUsageCostEstimate() {},
    renderOverviewUsage() {},
  };
  runInNewContext(
    `${rendererSource.slice(0, helperEnd)}\n` +
      "const api = createStateUnavailableGuardedApi(bridge, () => state);\nlet draftSelection = [];\nconst modelSelectionDraftsToKeep = new WeakSet();\nconst modeSwitchDraftsToKeep = new WeakSet();\nlet pendingModeSwitch = null;\nlet unresolvedModeSwitch = null;\n" +
      `${rendererSource.slice(detailDeclarationsStart, detailDeclarationsEnd)}\n` +
      `${rendererSource.slice(subscriptionsStart, subscriptionsEnd)}\n` +
      `${rendererSource.slice(detailFunctionsStart, detailFunctionsEnd)}\n` +
      "globalThis.detailHarness = {\n" +
      "  adopt: adoptStateSnapshot,\n" +
      "  load(section, options) { return section === 'settings' ? ensureSettingsDetailForSection(section) : ensureDetailedStateForSection(section, options); },\n" +
      "  snapshot() { return state; },\n" +
      "  draft() { return draftSelection; },\n" +
      "  setDraft(ids) { draftSelection = [...ids]; },\n" +
      "  loaded(section) { return section === 'settings' ? settingsDetailLoaded : loadedDetailSections.has(section); },\n" +
      "  loading(section) { return section === 'settings' ? settingsDetailLoading : loadingDetailSections.has(section); },\n" +
      "  saveOptions() { return api.saveOptions({ routerPort: 15722 }); },\n" +
      "};",
    sandbox,
  );
  const harness = { ...sandbox.detailHarness, pending, listeners, renders, toasts };
  harness.adopt(initialState);
  return harness;
}

for (const section of ["sessions", "settings"]) {
  test(`late ${section} detail cannot roll back a newer saved or broadcast snapshot`, async () => {
    for (const arrival of ["save", "broadcast"]) {
      const harness = createDetailStateHarness();
      const loading = harness.load(section);
      const latest = detailStateSnapshot({
        stateConfigRevision: "config-after",
        models: [{ id: "model-after" }],
        selectedModelIds: ["model-after"],
        routerRunning: true,
      });
      if (arrival === "save") harness.adopt(latest);
      else harness.listeners.state(latest);
      harness.setDraft(["unsaved-selection"]);
      harness.pending[0].resolve(detailStateSnapshot({
        detailSectionsLoaded: section === "sessions" ? ["sessions"] : [],
        settingsDetailLoaded: section === "settings",
        codexSessionTree: { marker: "stale-sessions" },
        codexBackups: [{ name: "stale-backup" }],
      }));
      await loading;

      assert.equal(harness.snapshot().stateConfigRevision, "config-after", arrival);
      assert.equal(harness.snapshot().models[0].id, "model-after", arrival);
      assert.deepEqual([...harness.snapshot().selectedModelIds], ["model-after"], arrival);
      assert.equal(harness.snapshot().routerRunning, true, arrival);
      assert.deepEqual([...harness.draft()], ["unsaved-selection"], arrival);
      assert.equal(harness.loaded(section), false, "stale detail must remain retryable");
      assert.equal(harness.loading(section), false, "the stale request must release its loading flag");

      const retry = harness.load(section);
      assert.equal(harness.pending.length, 2);
      harness.pending[1].resolve(detailStateSnapshot({
        ...latest,
        detailSectionsLoaded: section === "sessions" ? ["sessions"] : [],
        settingsDetailLoaded: section === "settings",
        codexSessionTree: { marker: "fresh-sessions" },
        codexBackups: [{ name: "fresh-backup" }],
      }));
      await retry;
      assert.equal(harness.loaded(section), true);
      assert.equal(harness.loading(section), false);
    }
  });

  test(`late unavailable ${section} detail cannot relock recovered core state`, async () => {
    const harness = createDetailStateHarness(detailStateSnapshot({ stateUnavailable: true }));
    const loading = harness.load(section);
    harness.listeners.state(detailStateSnapshot({ routerRunning: true }));
    harness.pending[0].resolve(detailStateSnapshot({ stateUnavailable: true }));
    await loading;

    assert.equal(harness.snapshot().stateUnavailable, false);
    assert.equal(harness.snapshot().routerRunning, true);
    assert.equal(harness.saveOptions(), "write-ok");
    assert.equal(harness.loaded(section), false);
    assert.equal(harness.loading(section), false);
  });

  test(`rejected ${section} detail clears its loading display and allows retry`, async () => {
    const harness = createDetailStateHarness();
    const loading = harness.load(section);
    const rendersBeforeFailure = harness.renders.length;
    harness.pending[0].reject(new Error("detail transport unavailable"));
    await loading;

    assert.equal(harness.loading(section), false);
    assert.equal(harness.loaded(section), false);
    assert.ok(harness.renders.length > rendersBeforeFailure, "replace the pending loading display after rejection");
    assert.equal(harness.saveOptions(), "write-ok");
    const retry = harness.load(section);
    harness.pending[1].resolve(detailStateSnapshot({
      detailSectionsLoaded: section === "sessions" ? ["sessions"] : [],
      settingsDetailLoaded: section === "settings",
      codexSessionTree: { marker: "retry" },
      codexBackups: [{ name: "retry" }],
    }));
    await retry;
    assert.equal(harness.loaded(section), true);
  });
}

test("concurrent detail loads retain each slice without replacing newer core or live telemetry", async () => {
  const harness = createDetailStateHarness();
  const sessions = harness.load("sessions");
  const resources = harness.load("resources");
  const settings = harness.load("settings");
  harness.listeners.state(detailStateSnapshot({ routerRunning: true }));
  harness.listeners.usage({
    usageEvents: [{ id: "live-event" }],
    usageSummary: { requests: 10 },
    usageBudgetAlerts: [{ id: "live-alert" }],
    usageCostEstimate: { cost: 12 },
  });
  harness.listeners.logs(["live-log"]);
  harness.setDraft(["draft-after-navigation"]);

  harness.pending[1].resolve(detailStateSnapshot({
    detailSectionsLoaded: ["resources"],
    codexResources: { marker: "loaded-resources" },
  }));
  await resources;
  harness.pending[2].resolve(detailStateSnapshot({
    settingsDetailLoaded: true,
    codexBackups: [{ name: "loaded-backup" }],
  }));
  await settings;
  harness.pending[0].resolve(detailStateSnapshot({
    detailSectionsLoaded: ["sessions"],
    codexSessions: [{ id: "loaded-session" }],
    codexSessionTree: { marker: "loaded-sessions" },
    codexProjectRecoveryPlan: { marker: "loaded-recovery" },
  }));
  await sessions;

  const actual = harness.snapshot();
  assert.equal(actual.routerRunning, true);
  assert.equal(actual.usageEvents[0].id, "live-event");
  assert.equal(actual.usageSummary.requests, 10);
  assert.equal(actual.usageBudgetAlerts[0].id, "live-alert");
  assert.equal(actual.usageCostEstimate.cost, 12);
  assert.deepEqual([...actual.logs], ["live-log"]);
  assert.deepEqual([...harness.draft()], ["draft-after-navigation"]);
  assert.equal(actual.codexResources.marker, "loaded-resources");
  assert.equal(actual.codexBackups[0].name, "loaded-backup");
  assert.equal(actual.codexSessions[0].id, "loaded-session");
  assert.equal(actual.codexSessionTree.marker, "loaded-sessions");
  assert.equal(actual.codexProjectRecoveryPlan.marker, "loaded-recovery");
  for (const section of ["sessions", "resources", "settings"]) {
    assert.equal(harness.loaded(section), true, section);
    assert.equal(harness.loading(section), false, section);
  }
  await harness.load("sessions");
  await harness.load("settings");
  assert.equal(harness.pending.length, 3, "completed lazy sections must not request again");
});

for (const section of ["resources", "settings"]) {
  test(`${section} detail errors retain last-good data and clear after a successful retry`, async () => {
    const harness = createDetailStateHarness(detailStateSnapshot({
      detailSectionsLoaded: section === "resources" ? ["resources"] : [],
      codexResources: { marker: "last-good-resources" },
      codexBackups: [{ name: "last-good-backup" }],
    }));
    const loading = harness.load(section);
    harness.pending[0].resolve(detailStateSnapshot({
      detailSectionErrors: { [section]: { code: "detail_timeout", message: "detail read failed" } },
    }));
    await loading;
    assert.equal(harness.snapshot().detailSectionErrors[section].code, "detail_timeout");
    assert.equal(harness.loaded(section), false);
    assert.equal(
      section === "resources" ? harness.snapshot().codexResources.marker : harness.snapshot().codexBackups[0]?.name,
      section === "resources" ? "last-good-resources" : "last-good-backup",
    );

    const retry = harness.load(section);
    harness.pending[1].resolve(detailStateSnapshot({
      detailSectionsLoaded: section === "resources" ? ["resources"] : [],
      settingsDetailLoaded: section === "settings",
      codexResources: { marker: "retried-resources" },
      codexBackups: [{ name: "retried-backup" }],
    }));
    await retry;
    assert.equal(harness.snapshot().detailSectionErrors[section], undefined);
    assert.equal(harness.loaded(section), true);
    assert.equal(
      section === "resources" ? harness.snapshot().codexResources.marker : harness.snapshot().codexBackups[0]?.name,
      section === "resources" ? "retried-resources" : "retried-backup",
    );
  });
}

test("resource refresh reports success only for a current authoritative snapshot and remains retryable", async () => {
  const harness = createDetailStateHarness(detailStateSnapshot({
    detailSectionsLoaded: ["resources"],
    codexResources: { marker: "last-good", snapshot: { state: "authoritative" } },
  }));
  const cases = [
    { response: { codexResources: { snapshot: { state: "cached" } }, detailSectionsLoaded: ["resources"] }, want: false },
    { response: { detailSectionErrors: { resources: { message: "read failed" } } }, want: false },
    { response: { stateUnavailable: true }, want: false },
    { response: { stateConfigRevision: "stale-revision" }, want: false },
    { rejected: true, want: false },
    { response: { codexResources: { snapshot: { state: "authoritative" }, pluginPage: { snapshot: { state: "cached" } } }, detailSectionsLoaded: ["resources"] }, want: false },
    { response: { codexResources: { snapshot: { state: "authoritative" } }, detailSectionsLoaded: ["resources"] }, want: true },
  ];
  for (const [index, scenario] of cases.entries()) {
    const refreshing = harness.load("resources");
    await harness.load("resources");
    assert.equal(harness.pending.length, index + 1, "a pending refresh must be deduplicated");
    assert.equal(harness.pending[index].options.forceResourceRefresh, true);
    if (scenario.rejected) harness.pending[index].reject(new Error("resource transport failed"));
    else harness.pending[index].resolve(detailStateSnapshot(scenario.response));
    assert.equal(await refreshing, scenario.want);
    assert.equal(harness.loading("resources"), false);
    assert.equal(harness.snapshot().stateConfigRevision, "config-before");
  }
});

test("manual resource refresh can recover unavailable core state without overwriting a newer broadcast", async () => {
  const harness = createDetailStateHarness(detailStateSnapshot({ stateUnavailable: true }));
  const recovered = detailStateSnapshot({stateConfigRevision:"config-recovered",detailSectionsLoaded:["resources"],
    codexResources:{snapshot:{state:"authoritative"}}});
  const recovering = harness.load("resources", { refreshCore: true });
  harness.pending[0].resolve(recovered);
  assert.equal(await recovering, true);
  assert.equal(harness.snapshot().stateUnavailable, false);
  assert.equal(harness.snapshot().stateConfigRevision, "config-recovered");
  const refreshing = harness.load("resources", { refreshCore: true });
  harness.listeners.state({...recovered,stateConfigRevision:"config-newer",routerRunning:true});
  harness.pending[1].resolve(recovered);
  assert.equal(await refreshing, false);
  assert.equal(harness.snapshot().stateConfigRevision, "config-newer");
  assert.equal(harness.snapshot().routerRunning, true);
});

test("desktop renderer labels a resilient fallback as an unavailable cached snapshot", () => {
  const renderBody = rendererSource.slice(
    rendererSource.indexOf("function render()"),
    rendererSource.indexOf("function renderActiveSection"),
  );
  assert.match(renderBody, /stateUnavailable/);
  assert.match(renderBody, /状态暂不可用/);
  assert.match(renderBody, /上次快照/);
});

test("desktop renderer fails closed for every write while cached state is unavailable and unlocks after recovery", async () => {
  assert.match(rendererSource, /function createStateUnavailableGuardedApi\(/);
  assert.match(rendererSource, /function applyStateUnavailableWriteGuard\(/);
  assert.match(rendererSource, /function stateUnavailableControlEventGuard\(/);
  assert.match(rendererSource, /const api = createStateUnavailableGuardedApi\(window\.codexBridge, \(\) => state\);/);

  const helperSource = rendererSource.slice(0, rendererSource.indexOf("const api = "));
  const runActionStart = rendererSource.indexOf("async function runAction(");
  const runActionEnd = rendererSource.indexOf("\nfunction bindFolderButton(", runActionStart);
  const runActionSource = rendererSource.slice(runActionStart, runActionEnd);
  const toasts = [];
  const sandbox = {
    showToast(message, type) {
      toasts.push({ message, type });
    },
    console: { error() {} },
  };
  runInNewContext(
    `${helperSource}\n${runActionSource}\n` +
      "globalThis.stateGuardHelpers = { createStateUnavailableGuardedApi, applyStateUnavailableWriteGuard, stateUnavailableControlEventGuard, runAction, setState(next) { state = next; } };",
    sandbox,
  );
  const {
    createStateUnavailableGuardedApi,
    applyStateUnavailableWriteGuard,
    stateUnavailableControlEventGuard,
    runAction,
    setState,
  } = sandbox.stateGuardHelpers;

  let currentState = { stateUnavailable: true };
  const calls = [];
  const bridge = new Proxy({}, {
    get(_target, method) {
      return (...args) => {
        calls.push({ method: String(method), args });
        return String(method);
      };
    },
  });
  const guardedApi = createStateUnavailableGuardedApi(bridge, () => currentState);
  for (const method of [
    "saveOptions",
    "saveModelSelection",
    "saveProvider",
    "setCodexResourceEnabled",
    "importConfigPackage",
    "restoreCodexBackup",
    "startRouter",
    "restartCodex",
    "futureMutationNotYetKnown",
  ]) {
    assert.throws(() => guardedApi[method]({ id: "fixture" }), /状态暂不可用/);
  }
  assert.deepEqual(calls, []);

  assert.equal(guardedApi.getState({ lite: true }), "getState");
  assert.equal(guardedApi.copyDiagnostics(), "copyDiagnostics");
  assert.equal(guardedApi.saveDiagnostics(), "saveDiagnostics");
  assert.deepEqual(calls.map((entry) => entry.method), ["getState", "copyDiagnostics", "saveDiagnostics"]);

  currentState = { stateUnavailable: false };
  assert.equal(guardedApi.saveOptions({ routerPort: 15722 }), "saveOptions");
  assert.equal(calls.at(-1).method, "saveOptions");

  const frozenCalls = [];
  const frozenBridge = Object.freeze({
    saveOptions(payload) {
      frozenCalls.push(payload);
      return "frozen-save";
    },
  });
  const guardedFrozenApi = createStateUnavailableGuardedApi(frozenBridge, () => currentState);
  assert.equal(guardedFrozenApi.saveOptions({ routerPort: 15723 }), "frozen-save");
  assert.deepEqual(frozenCalls, [{ routerPort: 15723 }]);

  function control(id, { disabled = false, draggable = false } = {}) {
    return {
      id,
      disabled,
      draggable,
      dataset: {},
      attributes: {},
      classList: { add() {}, remove() {} },
      matches(selector) {
        return selector.split(",").map((part) => part.trim()).includes(`#${id}`);
      },
      closest() {
        return this;
      },
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
      removeAttribute(name) {
        delete this.attributes[name];
      },
    };
  }

  const routerToggle = control("routerToggle");
  const saveOptions = control("saveDesktopOptions");
  const importConfig = control("importConfigPackage");
  const providerSave = control("providerSave");
  const refreshResources = control("refreshResources");
  const copyDiagnostics = control("copyDiagnostics");
  const resumeLogFollow = control("resumeLogFollow");
  const exportDiagnostics = control("savePreflightDiagnostics");
  const independentlyDisabled = control("providerRefreshWithoutKey", { disabled: true });
  const selectedModelSlot = control("selectedModelSlot", { draggable: true });
  const controls = [
    routerToggle,
    saveOptions,
    importConfig,
    providerSave,
    refreshResources,
    copyDiagnostics,
    resumeLogFollow,
    exportDiagnostics,
    independentlyDisabled,
    selectedModelSlot,
  ];
  const root = { querySelectorAll: () => controls };

  applyStateUnavailableWriteGuard(root, true);
  for (const item of [routerToggle, saveOptions, importConfig, providerSave]) {
    assert.equal(item.disabled, true, `${item.id} should be locked`);
    assert.equal(item.dataset.stateUnavailableLocked, "true");
  }
  for (const item of [refreshResources, copyDiagnostics, resumeLogFollow, exportDiagnostics]) {
    assert.equal(item.disabled, false, `${item.id} should stay read-only available`);
  }
  assert.equal(independentlyDisabled.disabled, true);
  assert.equal(independentlyDisabled.dataset.stateUnavailableLocked, undefined);
  assert.equal(selectedModelSlot.draggable, false);

  let prevented = 0;
  let stopped = 0;
  assert.equal(stateUnavailableControlEventGuard({
    target: providerSave,
    preventDefault() { prevented += 1; },
    stopImmediatePropagation() { stopped += 1; },
  }, { stateUnavailable: true }), true);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
  assert.equal(stateUnavailableControlEventGuard({ target: copyDiagnostics }, { stateUnavailable: true }), false);
  assert.equal(stateUnavailableControlEventGuard({ target: resumeLogFollow }, { stateUnavailable: true }), false);

  setState({ stateUnavailable: true });
  let actionRuns = 0;
  await runAction(providerSave, async () => { actionRuns += 1; });
  assert.equal(actionRuns, 0);
  assert.match(toasts.at(-1).message, /状态暂不可用/);
  await runAction(copyDiagnostics, async () => { actionRuns += 1; });
  assert.equal(actionRuns, 1);

  applyStateUnavailableWriteGuard(root, false);
  for (const item of [routerToggle, saveOptions, importConfig, providerSave]) {
    assert.equal(item.disabled, false, `${item.id} should unlock`);
    assert.equal(item.dataset.stateUnavailableLocked, undefined);
  }
  assert.equal(independentlyDisabled.disabled, true);
  assert.equal(selectedModelSlot.draggable, true);
  setState({ stateUnavailable: false });
  await runAction(providerSave, async () => { actionRuns += 1; });
  assert.equal(actionRuns, 2);

  const renderBody = rendererSource.slice(
    rendererSource.indexOf("function render()"),
    rendererSource.indexOf("function renderActiveSection"),
  );
  assert.match(renderBody, /renderActiveSection\(currentSectionId\(\)\);[\s\S]*applyStateUnavailableWriteGuard\(document, stateUnavailable\);/);
  assert.match(rendererSource, /new MutationObserver\([\s\S]*applyStateUnavailableWriteGuard\(document, true\)/);
});

test("desktop renderer keeps release, capability, resource, and session copy concise", () => {
  assert.doesNotMatch(htmlSource, /发版验收/);
  assert.doesNotMatch(htmlSource, /导出验收记录|导出发版门禁|发版验收目录|选择验收目录/);
  assert.match(htmlSource, /只看 API Key、Router、路由健康、自动更新和备份状态。/);
  assert.doesNotMatch(htmlSource, /发版工具/);
  assert.doesNotMatch(htmlSource, /真实接入状态/);
  assert.doesNotMatch(htmlSource, /模型缺的能力，按默认供应商补齐/);
  assert.match(htmlSource, /实验能力供应商/);
  assert.match(htmlSource, /实验能力供应商仅用于手动试运行，不会改变模型路由。/);
  assert.match(htmlSource, /设为所选能力默认试运行供应商/);
  assert.match(htmlSource, /已接管能力：图片生成/);
  assert.match(htmlSource, /图片生成是当前已接入自动代理的能力/);
  assert.match(htmlSource, /火山方舟/);
  assert.match(htmlSource, /尺寸，可选/);
  assert.match(rendererSource, /generic:\s*{[\s\S]*?size:\s*""/);
  assert.match(rendererSource, /if \(adapter === "generic_template"\) {\s*return "IMAGE_GENERATION_API_KEY";\s*}/);
  assert.match(htmlSource, /id="imageProviderHeaders"/);
  assert.match(htmlSource, /id="imageProviderRequestTemplate"/);
  assert.match(rendererSource, /headers: imageProviderHeadersFromForm/);
  assert.match(rendererSource, /request: imageProviderRequestFromForm/);
  assert.match(htmlSource, /插件、应用和插件 MCP 对应当前 Codex 插件页/);
  assert.match(htmlSource, /用户技能来自 Codex app-server skills\/list/);
  assert.match(htmlSource, /id="resourceRefreshStatus"/);
  assert.match(rendererSource, /暂时无法刷新，显示上次读取的资源/);
  assert.match(rendererSource, /最后更新/);
  assert.match(htmlSource, /用户技能来自 Codex app-server skills\/list/);
  assert.match(htmlSource, /manifest 声明、磁盘技能文件/);
  assert.doesNotMatch(htmlSource, /当前会话技能/);
  assert.match(htmlSource, /按项目查看本机 Codex 会话，也可以导出 Markdown。/);
  assert.doesNotMatch(htmlSource, /Markdown 导出用于跨机器留档、迁移参考或人工恢复/);
  assert.doesNotMatch(htmlSource, /项目数量只按 Codex 当前项目列表计算/);
  assert.doesNotMatch(htmlSource, /<details class="capability-experimental-panel"/);
  assert.match(htmlSource, /<section class="capability-provider-manager capability-experimental-panel"/);
  assert.match(rendererSource, /配置图片服务后可直接生成并保存图片/);
  assert.match(rendererSource, /实验能力/);
  assert.match(rendererSource, /providerHasCapability\(provider,\s*"image_generation"\)/);
  assert.doesNotMatch(rendererSource, /capabilityProviderMarketHtml\(\)\s*}/);
  assert.match(rendererSource, /resourceShortLabel/);
  assert.doesNotMatch(rendererSource, /resource-inline-details/);
  assert.doesNotMatch(rendererSource, /更多信息/);
  assert.match(rendererSource, /USER_VISIBLE_STARTUP_CHECK_IDS/);
  assert.match(rendererSource, /"api_keys"/);
  assert.match(rendererSource, /"model_references"/);
  assert.match(rendererSource, /"route_health"/);
  assert.match(rendererSource, /实验供应商/);
  assert.match(rendererSource, /不支持原生附件；只会把可读内容转成文字给模型。/);
  assert.match(cssSource, /\.capability-experimental-panel/);
  assert.match(cssSource, /\.resource-primary-meta/);
});

test("capability hierarchy puts diagnostics and image settings before experimental capability", () => {
  const capabilitySummary = htmlSource.indexOf('id="capabilitySummary"');
  const capabilityDiagnostics = htmlSource.indexOf('id="capabilityDiagnostics"');
  const imageProviderSettings = htmlSource.indexOf('class="panel image-provider-settings"');
  const imageHistory = htmlSource.indexOf('id="imageGenerationHistory"');
  const experimentalProvider = htmlSource.indexOf('class="capability-provider-manager capability-experimental-panel"');
  const experimentalHistory = htmlSource.indexOf('id="capabilityExecutionHistory"');

  for (const [name, index] of Object.entries({
    capabilitySummary,
    capabilityDiagnostics,
    imageProviderSettings,
    imageHistory,
    experimentalProvider,
    experimentalHistory,
  })) {
    assert.notEqual(index, -1, `expected ${name} in the capability page`);
  }
  assert.ok(capabilitySummary < capabilityDiagnostics);
  assert.ok(capabilityDiagnostics < imageProviderSettings);
  assert.ok(imageProviderSettings < imageHistory);
  assert.ok(imageHistory < experimentalProvider);
  assert.ok(experimentalProvider < experimentalHistory);
});

test("experimental capability is not appended to the top capability summary", () => {
  const renderStart = rendererSource.indexOf("function renderCapabilityDiagnostics()");
  const renderEnd = rendererSource.indexOf("function capabilityProviderMarketHtml()", renderStart);
  assert.ok(renderStart >= 0 && renderEnd > renderStart, "expected capability summary renderer");
  const summaryRenderSource = rendererSource.slice(renderStart, renderEnd);
  assert.doesNotMatch(summaryRenderSource, /capabilityProviderSummaryCards\s*\(/);
  assert.doesNotMatch(rendererSource, /function capabilityProviderSummaryCards\s*\(/);
});

test("capability summary explains user outcomes instead of implementation details", () => {
  const renderStart = rendererSource.indexOf("function renderCapabilityDiagnostics()");
  const renderEnd = rendererSource.indexOf("function capabilityProviderMarketHtml()", renderStart);
  assert.ok(renderStart >= 0 && renderEnd > renderStart, "expected capability summary renderer");
  const summaryRenderSource = rendererSource.slice(renderStart, renderEnd);

  assert.doesNotMatch(
    summaryRenderSource,
    /Router 配置|兼容函数调用|原生文件输入|文本降级|128K|自动接管|扩展能力/,
  );
  assert.match(summaryRenderSource, /已选择并可使用的模型/);
  assert.match(summaryRenderSource, /可直接识别你上传的截图、照片和图片链接/);
  assert.match(summaryRenderSource, /工具协作/);
  assert.match(summaryRenderSource, /可配合已启用的工具完成更多操作/);
  assert.match(summaryRenderSource, /可直接读取你上传的文件/);
  assert.match(summaryRenderSource, /适合处理很长的对话和文档/);
  assert.match(summaryRenderSource, /配置图片服务后可直接生成并保存图片/);
});

test("experimental capability copy avoids relative positioning", () => {
  const capabilityCopy = `${htmlSource}\n${rendererSource}`;
  assert.doesNotMatch(capabilityCopy, /上方手动试运行|上方可配置试运行/);
  assert.match(capabilityCopy, /实验能力供应商仅用于手动试运行，不会改变模型路由。/);
});

test("user-facing startup omits the release-only update flow", () => {
  const idsStart = rendererSource.indexOf("const USER_VISIBLE_STARTUP_CHECK_IDS");
  const idsEnd = rendererSource.indexOf("]);", idsStart);
  assert.ok(idsStart >= 0 && idsEnd > idsStart, "expected visible startup item allowlist");
  const visibleStartupIdsSource = rendererSource.slice(idsStart, idsEnd + 3);
  assert.doesNotMatch(visibleStartupIdsSource, /"update_flow"/);
});

test("usage table uses header column resizers instead of cell resize controls", () => {
  assert.match(rendererSource, /function usageHeaderCell/);
  assert.match(rendererSource, /class="usage-resizer"/);
  assert.match(rendererSource, /bindUsageColumnResizers/);
  assert.match(cssSource, /\.usage-resizer/);
  assert.doesNotMatch(cssSource, /\.usage-table-block \.usage-row span \{[^}]*resize: horizontal/s);
});

test("desktop renderer shows current usage by default without a history banner", () => {
  assert.match(rendererSource, /const current = summary\.current \|\| summary;/);
  assert.match(rendererSource, /const history = summary\.history \|\| emptyUsageSummary\(\);/);
  assert.match(rendererSource, /filterUsageEvents\(current\.events \|\| state\.usageEvents \|\| \[\], usageRangeDays\)/);
  assert.match(rendererSource, /summarizeUsageEvents\(events, current\)/);
  assert.match(rendererSource, /renderUsageTableStable\(ranged\.byModel \|\| \[\], events, history\)/);
  assert.match(rendererSource, /formatCacheTokens/);
  assert.match(htmlSource, /id="statCache"/);
  assert.doesNotMatch(rendererSource, /hiddenHistoryNote/);
  assert.doesNotMatch(rendererSource, /历史路由已隐藏|鍘嗗彶璺敱宸查殣钘?/);
});

test("desktop renderer centers statistic summary cards", () => {
  assert.match(cssSource, /\.stat-summary \.metric\s*{[\s\S]*display:\s*grid;[\s\S]*place-items:\s*center;[\s\S]*text-align:\s*center;/);
  assert.match(cssSource, /\.stat-summary \.metric-label\s*{[\s\S]*font-size:\s*15px;[\s\S]*font-weight:\s*700;/);
  assert.match(cssSource, /\.stat-summary \.metric strong\s*{[\s\S]*font-size:\s*18px;/);
});

test("desktop renderer exposes a polished VVIP prank section", () => {
  assert.match(htmlSource, /data-section="vvip"/);
  assert.match(htmlSource, /id="vvip"/);
  assert.match(htmlSource, /VVIP功能/);
  for (const label of ["收购OPEN AI", "免费洗脚", "送房送车", "接入Claude", "免费GPT", "长生不老", "送媳妇", "Computer Use", "免费生图", "一键起飞", "牛了个逼", "无限额度"]) {
    assert.match(htmlSource, new RegExp(label));
  }
  assert.match(htmlSource, /id="vvipDialog"/);
  assert.match(rendererSource, /function showVvipDialog/);
  assert.match(rendererSource, /data-vvip-feature/);
  assert.match(rendererSource, /const VVIP_PRANK_MESSAGES = new Map/);
  assert.match(rendererSource, /预算暂缺 7 万亿/);
  assert.match(rendererSource, /水温默认 42 度/);
  assert.match(rendererSource, /Claude 正在门口换鞋/);
  assert.match(rendererSource, /function vvipPrankFor/);
  assert.match(rendererSource, /任务排期：3000年，敬请期待。。。/);
  assert.match(cssSource, /\.vvip-grid/);
  assert.match(cssSource, /\.vvip-dialog/);
});

test("desktop renderer exposes startup checks, profiles, backups, resources, and sessions", () => {
  assert.match(htmlSource, /data-section="preflight"/);
  assert.match(htmlSource, /id="preflight"/);
  assert.match(htmlSource, /id="startupCheckList"/);
  assert.match(htmlSource, /id="runStartupCheck"/);
  assert.match(htmlSource, /id="profileList"/);
  assert.match(htmlSource, /id="saveConfigProfile"/);
  assert.match(htmlSource, /id="backupList"/);
  assert.match(htmlSource, /data-section="resources"/);
  assert.match(htmlSource, /id="resources"/);
  assert.match(htmlSource, /id="resourceSummary"/);
  assert.match(htmlSource, /data-section="sessions"/);
  assert.match(htmlSource, /id="sessions"/);
  assert.match(htmlSource, /id="sessionList"/);
  assert.match(preloadSource, /runStartupCheck: \(\) => ipcRenderer\.invoke\("startup:check"\)/);
  assert.match(preloadSource, /saveConfigProfile: \(payload\) => ipcRenderer\.invoke\("profiles:save", payload\)/);
  assert.match(preloadSource, /applyConfigProfile: \(profileId\) => ipcRenderer\.invoke\("profiles:apply", profileId\)/);
  assert.match(preloadSource, /restoreCodexBackup: \(backupPath\) => ipcRenderer\.invoke\("backups:restore", backupPath\)/);
  assert.match(preloadSource, /exportSessionMarkdown: \(sessionId\) => ipcRenderer\.invoke\("sessions:export", String\(sessionId \|\| ""\)\.slice\(0, 512\)\)/);
  assert.match(preloadSource, /exportFilteredSessionsMarkdown:[\s\S]*?\.slice\(0, 1000\)[\s\S]*?\.slice\(0, 512\)/u);
  assert.match(mainSource, /ipcMain\.handle\("startup:check"/);
  assert.match(mainSource, /ipcMain\.handle\("profiles:save"/);
  assert.match(mainSource, /ipcMain\.handle\("profiles:apply"/);
  assert.match(mainSource, /ipcMain\.handle\("backups:restore"/);
  assert.match(mainSource, /ipcMain\.handle\("sessions:export"/);
  assert.match(rendererSource, /function renderStartupCheck/);
  assert.match(rendererSource, /function renderProfiles/);
  assert.match(rendererSource, /function renderBackups/);
  assert.match(rendererSource, /function renderResources/);
  assert.match(rendererSource, /rawResources\.pluginPage/);
  assert.match(rendererSource, /插件 MCP/);
  assert.match(rendererSource, /return "用户技能"/);
  assert.match(rendererSource, /发现的 App manifest 声明/);
  assert.match(rendererSource, /发现的插件技能文件/);
  assert.match(rendererSource, /function renderSessions/);
  assert.match(rendererSource, /function groupSessionsByProject/);
  assert.match(rendererSource, /function canonicalProjectPathKey/);
  assert.match(rendererSource, /项目文件夹/);
  assert.match(rendererSource, /无项目会话/);
  assert.match(rendererSource, /查看索引与归类依据/);
  assert.doesNotMatch(rendererSource, /class="session-reason"/);
  assert.match(rendererSource, /data-session-project/);
  assert.match(rendererSource, /data-resource-expand/);
  assert.match(rendererSource, /resourceExpandedKeys/);
  assert.match(rendererSource, /展开全部/);
  assert.match(rendererSource, /收起/);
  assert.match(rendererSource, /当前可用/);
  assert.match(rendererSource, /管理边界/);
  assert.match(rendererSource, /discoveredSummary/);
  assert.match(rendererSource, /resources\.discovered/);
  assert.match(rendererSource, /未启用/);
  assert.doesNotMatch(rendererSource, /还有 \$\{formatNumber\(list\.length - visible\.length\)\} 项未展开/);
  assert.match(rendererSource, /本地缓存/);
  assert.match(rendererSource, /Agents 配置目录/);
  assert.match(rendererSource, /内置运行能力/);
  assert.match(rendererSource, /插件内置/);
  assert.match(rendererSource, /data-rename-profile/);
  assert.match(rendererSource, /function profileModeLabel/);
  assert.match(rendererSource, /function sessionProjectLabel/);
  assert.match(mainSource, /runCodexSessionSnapshotWorker\(\{[\s\S]*?homeDir,[\s\S]*?limit: SESSION_CENTER_LIMIT,[\s\S]*?\}\)/);
  assert.doesNotMatch(mainSource, /settings\.listCodexSessions\(\{ homeDir, limit: SESSION_CENTER_LIMIT \}\)/);
  assert.match(cssSource, /\.backup-list[\s\S]*max-height/);
  assert.match(cssSource, /\.check-list[\s\S]*margin-top:\s*18px/);
  assert.match(cssSource, /\.resource-layout/);
  assert.match(cssSource, /\.resource-more-button/);
  assert.match(cssSource, /\.session-project/);
  assert.match(cssSource, /\.session-project-list/);
  assert.match(cssSource, /\.session-project-toggle/);
  assert.doesNotMatch(cssSource, /\.session-reason/);
  assert.doesNotMatch(htmlSource, /id="recoverHistoryAccess"/);
  assert.match(htmlSource, /id="recoverHistoryAccessSessions"/);
});

test("session export copy explains when large markdown is intentionally not copied", () => {
  assert.match(rendererSource, /function sessionExportClipboardNote\(response = \{\}\)/u);
  assert.match(rendererSource, /response\.clipboardCopied/u);
  assert.match(rendererSource, /内容较大，未复制到剪贴板/u);
  assert.match(rendererSource, /response\?\.group\?\.sessionCount/u);
});

test("session center treats every scanned history row as recoverable sidebar state", () => {
  assert.match(rendererSource, /原始线程总数/);
  assert.match(rendererSource, /Codex 当前目录/);
  assert.match(rendererSource, /Codex 当前侧栏索引/);
  assert.match(rendererSource, /仅可恢复/);
  assert.match(rendererSource, /恢复前会预览、退出 ChatGPT/);
  assert.match(rendererSource, /title: "恢复全部历史会话"/);
  assert.match(rendererSource, /lastProjectRecoveryResult = result\?\.projectRecovery \|\| null/);
  assert.doesNotMatch(rendererSource, /ChatGPT 侧栏默认只展开最近一部分会话/);
  assert.doesNotMatch(rendererSource, /<span>项目内会话 /);
});

test("history recovery shows current catalog counts before confirmation", () => {
  assert.match(preloadSource, /previewHistoryRecovery:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("codex:history-recovery-preview"\)/);
  assert.match(rendererSource, /api\.previewHistoryRecovery\(\)/);
  assert.match(rendererSource, /计划新增/);
  assert.match(rendererSource, /当前新版目录/);
  assert.match(rendererSource, /仅可恢复/);
});

test("session page keeps a visible two-phase recovery result and manual-exit retry", () => {
  for (const id of [
    "historyRecoveryStatusPanel",
    "historyRecoveryPlanned",
    "historyRecoveryInserted",
    "historyRecoveryCommit",
    "historyRecoveryBackup",
    "historyRecoveryCatalog",
    "historyRecoverySidebar",
    "historyRecoveryFailure",
    "retryHistoryRecovery",
  ]) {
    assert.match(htmlSource, new RegExp(`id="${id}"`));
  }
  assert.match(htmlSource, /我已手动退出，重新检测/);
  assert.match(preloadSource, /historyRecoveryStatus:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("codex:history-recovery-status"\)/);
  assert.match(rendererSource, /function renderHistoryRecoveryStatus\b/);
  assert.match(rendererSource, /phase === "awaiting_manual_exit"/);
  assert.match(rendererSource, /recoverHistoryAccess\(\{\s*manualExit:\s*true\s*\}\)/);
  assert.match(rendererSource, /showToast\([^)]*,\s*"error"\)/);
  assert.match(rendererSource, /let refreshRequestSequence = 0/);
  assert.match(rendererSource, /let historyRecoveryActionSequence = 0/);
  assert.match(rendererSource, /if \(requestSequence !== refreshRequestSequence\) \{\s*return false;/);
  assert.match(rendererSource, /if \(actionSequence !== historyRecoveryActionSequence\) \{\s*return;/);
  assert.match(rendererSource, /if \(historyRecoveryStatus\?\.phase !== result\?\.phase\) \{\s*return;/);
  assert.match(rendererSource, /function refreshAfterHistoryRecovery\b/);
  assert.match(rendererSource, /function applyVerifiedHistoryRecoverySummary\b/);
  assert.match(rendererSource, /catalogThreads:\s*Number\(result\.rereadCatalogThreads/);
  assert.match(rendererSource, /const sessionSummary = verifiedRecovery/);
  assert.match(rendererSource, /formatNumber\(sessionSummary\?\.catalogThreads/);
  assert.match(rendererSource, /const latestStatus = await api\.historyRecoveryStatus\(\)/);
  assert.match(rendererSource, /phase === "completed"/);
  assert.match(rendererSource, /completed: "迁移成功，请手动打开 ChatGPT \/ Codex"/);
});

test("desktop renderer provides request detail drilldown from usage events", () => {
  assert.match(htmlSource, /id="requestDetailDialog"/);
  assert.match(htmlSource, /id="requestDetailBody"/);
  assert.match(rendererSource, /data-request-detail/);
  assert.match(rendererSource, /function bindRequestDetailButtons/);
  assert.match(rendererSource, /function showRequestDetail/);
  assert.match(rendererSource, /upstreamUrl/);
  assert.match(rendererSource, /\(\?:sk\|ak\)-/);
  assert.match(rendererSource, /\(\?:org\|proj\)-/);
  assert.match(cssSource, /\.request-detail-grid/);
});

test("model selection save merges the lightweight response without discarding loaded detail", () => {
  const start = rendererSource.indexOf("function saveModelSelection(button)");
  const end = rendererSource.indexOf("function startCustomModelEdit", start);
  const body = rendererSource.slice(start, end);
  assert.match(body, /const submitted = \[\.\.\.draftSelection\];/);
  assert.match(body, /nextState = await api\.saveModelSelection\(submitted\);/);
  assert.match(body, /state = mergeStateWithRetainedDetailSlices\(state, nextState\);/);
  assert.doesNotMatch(body, /state = await api\.saveModelSelection\(draftSelection\);/);
});
