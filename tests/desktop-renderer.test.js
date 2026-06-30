import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rendererSource = readFileSync(resolve(__dirname, "../desktop/renderer/app.js"), "utf8");
const htmlSource = readFileSync(resolve(__dirname, "../desktop/renderer/index.html"), "utf8");
const cssSource = readFileSync(resolve(__dirname, "../desktop/renderer/styles.css"), "utf8");
const preloadSource = readFileSync(resolve(__dirname, "../desktop/preload.cjs"), "utf8");
const mainSource = readFileSync(resolve(__dirname, "../desktop/main.cjs"), "utf8");
const kimiLogoSource = readFileSync(resolve(__dirname, "../desktop/renderer/assets/providers/kimi.svg"), "utf8");
const defaultLogoSource = readFileSync(resolve(__dirname, "../desktop/renderer/assets/providers/default.svg"), "utf8");

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
  assert.match(htmlSource, /选择 Codex 启动项/);
  assert.match(htmlSource, /id="codexDesktopPath"/);
  assert.match(preloadSource, /restartCodex: \(\) => ipcRenderer\.invoke\("codex:restart"\)/);
  assert.match(preloadSource, /selectCodexDesktopExe: \(\) => ipcRenderer\.invoke\("codex:select-exe"\)/);
  assert.match(rendererSource, /api\.restartCodex\(\)/);
  assert.match(rendererSource, /api\.selectCodexDesktopExe\(\)/);
  assert.match(rendererSource, /state\.desktopOptions\?\.codexDesktopLaunchTarget/);
  assert.match(mainSource, /ipcMain\.handle\("codex:select-exe"/);
  assert.match(mainSource, /codexDesktopExe/);
  assert.match(mainSource, /codexDesktopLaunchTarget/);
  assert.match(mainSource, /extensions:\s*\["exe", "lnk"\]/);
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
  assert.match(rendererSource, /data-test-provider-connection/);
  assert.doesNotMatch(rendererSource, /data-provider-logo-url/);
  assert.doesNotMatch(rendererSource, /模型数量/);
  assert.match(rendererSource, /api\.saveProvider/);
  assert.match(rendererSource, /api\.testProviderConnection/);
  assert.match(rendererSource, /api\.selectLocalLogo/);
  assert.match(preloadSource, /saveProvider: \(payload\) => ipcRenderer\.invoke\("providers:save", payload\)/);
  assert.match(preloadSource, /testProviderConnection: \(payload\) => ipcRenderer\.invoke\("providers:testConnection", payload\)/);
  assert.match(preloadSource, /selectLocalLogo: \(payload\) => ipcRenderer\.invoke\("logos:select", payload\)/);
  assert.match(mainSource, /ipcMain\.handle\("providers:save"/);
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
  assert.match(cssSource, /\.model-context-inline\s*{[\s\S]*grid-template-columns: auto minmax\(110px, 150px\) auto/);
  assert.match(cssSource, /\.model-context-inline label\s*{[\s\S]*display: contents/s);
});

test("desktop renderer balances provider model quick controls", () => {
  assert.match(cssSource, /\.provider-model-controls\s*{[\s\S]*grid-template-columns:\s*minmax\(140px, 160px\) minmax\(320px, 380px\)/);
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

test("desktop renderer exposes structured settings for router port, proxy, and lifecycle", () => {
  assert.match(htmlSource, /data-section="settings"/);
  assert.match(htmlSource, /id="settings"/);
  assert.match(htmlSource, /id="routerPort"/);
  assert.match(htmlSource, /id="saveDesktopOptions"/);
  assert.doesNotMatch(htmlSource, /settings-summary-grid/);
  assert.doesNotMatch(htmlSource, /settings-card/);
  assert.match(htmlSource, /settings-actions/);
  assert.match(cssSource, /\.settings-actions/);
  assert.match(rendererSource, /routerPort: Number\(els\.routerPort\.value \|\| 15722\)/);
  assert.match(rendererSource, /state\.desktopOptions\?\.routerPort/);
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
  assert.match(rendererSource, /function renderSessions/);
  assert.match(rendererSource, /function groupSessionsByProject/);
  assert.match(rendererSource, /function canonicalProjectPathKey/);
  assert.match(rendererSource, /项目文件夹/);
  assert.match(rendererSource, /无项目会话/);
  assert.match(rendererSource, /data-session-project/);
  assert.match(rendererSource, /data-resource-expand/);
  assert.match(rendererSource, /resourceExpandedKeys/);
  assert.match(rendererSource, /展开全部/);
  assert.match(rendererSource, /收起/);
  assert.match(rendererSource, /当前可用/);
  assert.match(rendererSource, /本地诊断/);
  assert.match(rendererSource, /discoveredSummary/);
  assert.match(rendererSource, /resources\.discovered/);
  assert.match(rendererSource, /未启用/);
  assert.doesNotMatch(rendererSource, /还有 \$\{formatNumber\(list\.length - visible\.length\)\} 项未展开/);
  assert.match(rendererSource, /Codex 本地安装/);
  assert.match(rendererSource, /本机配置目录/);
  assert.match(rendererSource, /内置运行能力/);
  assert.match(rendererSource, /插件内置/);
  assert.match(rendererSource, /data-rename-profile/);
  assert.match(rendererSource, /function profileModeLabel/);
  assert.match(rendererSource, /function sessionProjectLabel/);
  assert.match(mainSource, /settings\.listCodexSessions\(\{ limit: 50 \}\)/);
  assert.match(cssSource, /\.backup-list[\s\S]*max-height/);
  assert.match(cssSource, /\.check-list[\s\S]*margin-top:\s*18px/);
  assert.match(cssSource, /\.resource-layout/);
  assert.match(cssSource, /\.resource-more-button/);
  assert.match(cssSource, /\.session-project/);
  assert.match(cssSource, /\.session-project-list/);
  assert.match(cssSource, /\.session-project-toggle/);
  assert.doesNotMatch(htmlSource, /id="recoverHistoryAccess"/);
  assert.match(htmlSource, /id="recoverHistoryAccessSessions"/);
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
