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

test("double quota is a dedicated desktop page backed by narrow IPC methods", () => {
  assert.match(htmlSource, /data-section="doubleQuota">双倍额度<\/button>/);
  assert.match(htmlSource, /<section class="section-panel hidden" id="doubleQuota">/);
  const sectionStart = htmlSource.indexOf('id="doubleQuota"');
  const sectionEnd = htmlSource.indexOf("</section>", sectionStart);
  const section = htmlSource.slice(sectionStart, sectionEnd);
  assert.match(section, /<h2>双倍额度<\/h2>/);
  assert.doesNotMatch(section, /GPT Bridge/i);
  for (const id of [
    "doubleQuotaStatus",
    "doubleQuotaServiceBanner",
    "doubleQuotaServiceTitle",
    "doubleQuotaServiceDetail",
    "doubleQuotaExtensionState",
    "doubleQuotaPort",
    "saveDoubleQuotaPort",
    "startDoubleQuota",
    "stopDoubleQuota",
    "openDoubleQuota",
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
    ["stopDoubleQuota", "doubleQuota:stop"],
    ["openDoubleQuota", "doubleQuota:open"],
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
  assert.match(rendererSource, /api\.startDoubleQuota\(\)/);
  assert.match(rendererSource, /api\.stopDoubleQuota\(\)/);
  assert.match(rendererSource, /api\.repairDoubleQuotaMcp\(\)/);
  assert.match(rendererSource, /extensionProtocolVersion/);
  assert.match(rendererSource, /extensionAction\.label/);
  assert.match(rendererSource, /api\.manageDoubleQuotaExtension\(\)/);
  assert.match(rendererSource, /extensionLoadedDirs\?\.\[0\]/);
  assert.match(rendererSource, /doubleQuotaServiceBanner\.classList\.toggle\("running"/);
  assert.match(rendererSource, /doubleQuotaServiceTitle\.textContent/);
  assert.match(rendererSource, /doubleQuotaServiceDetail\.textContent/);
  assert.match(rendererSource, /extensionDeployment\?\.verified/);
  assert.match(rendererSource, /doubleQuotaExtensionState\.textContent[\s\S]*?"新版已连接"/);
  assert.match(rendererSource, /doubleQuotaExtensionState\.textContent[\s\S]*?"旧版未生效"/);
  assert.match(rendererSource, /current\.extensionDisplayVersion/);
  assert.doesNotMatch(rendererSource, /管理链路|extensionManagerRevision/);
  assert.doesNotMatch(rendererSource, /extensionDeployment\.updatedAt/);
  assert.match(rendererSource, /api\.openDoubleQuotaExtensionManager\(\)/);
  assert.doesNotMatch(htmlSource, /class="grid two double-quota-grid"/);
  const extensionUpdateHandler = rendererSource.slice(
    rendererSource.indexOf('els.manageDoubleQuotaExtension?.addEventListener'),
    rendererSource.indexOf('els.openDoubleQuotaExtensionManager?.addEventListener'),
  );
  assert.match(extensionUpdateHandler, /requestedAction === "reinstall"[\s\S]*api\.copyText\(doubleQuotaState\.extensionDir\)/);
  assert.match(extensionUpdateHandler, /requestedAction === "reinstall"[\s\S]*api\.openDoubleQuotaExtensionManager\(\)/);
  assert.match(extensionUpdateHandler, /extensionUpdate\?\.status === "failed"[\s\S]*throw new Error/);
  assert.match(mainSource, /App Paths\\\\chrome\.exe/);
  assert.match(mainSource, /\["--new-window", "chrome:\/\/extensions\/"\]/);
  assert.match(mainSource, /clipboard\.writeText\("chrome:\/\/extensions\/"\)/);
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
    "模式已切换且Router已确认；请点击“重启 ChatGPT / Codex”使鉴权生效。",
  );
  assert.equal(
    modeSwitchToastMessage({ ...transaction, restartAvailable: false }),
    "模式已切换且Router已确认；未定位到 ChatGPT / Codex 启动项，请完全退出 ChatGPT / Codex 后重新打开，使鉴权生效。",
  );
  assert.equal(
    modeSwitchToastMessage({ ...transaction, routerVerified: false }),
    "模式已切换，配置已原子写入（Router当前未运行）；请点击“重启 ChatGPT / Codex”使鉴权生效。",
  );
  assert.equal(
    modeSwitchToastMessage({ ...transaction, routerVerified: false, restartAvailable: false }),
    "模式已切换，配置已原子写入（Router当前未运行）；未定位到 ChatGPT / Codex 启动项，请完全退出 ChatGPT / Codex 后重新打开，使鉴权生效。",
  );

  assert.equal(
    (rendererSource.match(/normalizeModeSelectionResult\(await api\.selectMode\(/g) || []).length,
    2,
  );
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

test("desktop renderer resource refresh bypasses the resource snapshot cache", () => {
  assert.match(
    rendererSource,
    /els\.refreshResources\?\.addEventListener\("click",[\s\S]*?await refresh\(\{ lite: false, forceResourceRefresh: true \}\);/,
  );
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
  assert.match(rendererSource, /result\.relaunching \? "restarting" : result\.installerPath \? "launching" : "ready"/);
  assert.match(rendererSource, /result\.nextStep \|\| result\.message/);
  assert.match(rendererSource, /bytesPerSecond/);
  assert.match(rendererSource, /formatBytes\(details\.bytesPerSecond\)/);
  assert.match(rendererSource, /\}\/s`/);
  assert.match(rendererSource, /els\.appVersion\.textContent = `v\$\{state\.appVersion \|\| "-"\}`;/);
  assert.match(rendererSource, /showUpdateDialog/);
  assert.match(rendererSource, /phase === "restarting"/);
  assert.doesNotMatch(rendererSource, /window\.confirm/);
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
  assert.match(rendererSource, /data-provider-api/);
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

test("desktop renderer gates remote provider actions behind API keys", () => {
  assert.match(rendererSource, /providerCanRefreshModels/);
  assert.match(rendererSource, /providerHasSavedApiKey/);
  assert.match(rendererSource, /data-provider-refresh-disabled/);
  assert.match(rendererSource, /先填写并保存 API Key/);
  assert.match(rendererSource, /saveProviderSettingsFromCard/);
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
  assert.match(inlineContextSave, /capabilities:\s*{\s*contextWindow,\s*}/s);
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
    /els\.duplicateRequestProtection\.checked = state\.desktopOptions\?\.duplicateRequestProtection === true/,
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
  assert.match(mainSource, /stateDetailLoaded: !lite/);
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
  assert.match(mainSource, /lite \? null : settings\.listCodexSessionTree/);
  assert.match(mainSource, /const codexResourceSnapshots = lite[\s\S]*?: await readCodexResourceSnapshotsRetained\(\{[\s\S]*?forceRefresh: Boolean\(options\.forceResourceRefresh\),[\s\S]*?\}\);/);
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
  assert.match(mainSource, /const includeSettingsDetail = !lite \|\| Boolean\(options\.settingsDetail\);/);
  assert.match(mainSource, /settingsDetailLoaded: includeSettingsDetail/);
  assert.match(mainSource, /codexBackups: includeSettingsDetail \? settings\.listCodexBackups\(\) : \[\]/);
  assert.match(rendererSource, /capability-model-details/);
  assert.match(rendererSource, /<details class="capability-matrix-row capability-model-details">/);
  assert.match(rendererSource, /<details class="resource-diagnostics">/);
  assert.match(rendererSource, /<details class="session-diagnostics">/);
  assert.match(rendererSource, /check-passed-details/);
  assert.match(rendererSource, /startupCheckSummaryFromItems\(items,\s*summary\)/);
  assert.match(rendererSource, /visibleSummary\.warn/);
  assert.match(cssSource, /\.capability-model-details > summary/);
  assert.match(cssSource, /\.resource-diagnostics/);
  assert.match(cssSource, /\.session-diagnostics/);
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
  for (const item of [refreshResources, copyDiagnostics, exportDiagnostics]) {
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
  assert.match(rendererSource, /App Server 暂不可用，使用最近有效缓存/);
  assert.match(rendererSource, /最后有效读取/);
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
  assert.match(preloadSource, /exportSessionMarkdown: \(sessionId\) => ipcRenderer\.invoke\("sessions:export", sessionId\)/);
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
  assert.match(rendererSource, /查看归类依据/);
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
  assert.match(mainSource, /settings\.listCodexSessions\(\{ homeDir, limit: SESSION_CENTER_LIMIT \}\)/);
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
  assert.match(body, /const nextState = await api\.saveModelSelection\(draftSelection\);/);
  assert.match(body, /state = mergeStateWithRetainedDetailSlices\(state, nextState\);/);
  assert.doesNotMatch(body, /state = await api\.saveModelSelection\(draftSelection\);/);
});
