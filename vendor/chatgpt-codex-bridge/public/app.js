import {
  createProjectRefreshCoordinator,
  displayProjectConversationUrl,
  projectIdFromPageUrl,
  restoreProjectConversationUrl,
  runProjectRefresh,
  saveProjectBindingForScope,
  selectProjectForScope,
  withProjectIdInPageUrl
} from "./project-binding-client.js";
import {
  installVisibleBrandingGuard,
  maskVisibleBrandName
} from "./visible-branding.js";
import { createBridgeApiClient } from "./bridge-api-client.js";

installVisibleBrandingGuard();
const PAGE_QUERY = new URLSearchParams(window.location.search);
const PAGE_SCOPE_TOKEN = String(PAGE_QUERY.get("scope") || "");
const PAGE_PROJECT_ID = projectIdFromPageUrl(window.location.href);
const bridgeApiClient = createBridgeApiClient({
  scopeToken: PAGE_SCOPE_TOKEN
});

const MODE_PREFERENCES = new Set(["fast", "balanced", "advanced", "high", "pro"]);
const MODEL_PREFERENCES = new Set(["gpt-5.6-sol", "gpt-5.5", "gpt-5.4", "gpt-5.3", "o3"]);
const MODEL_MODE_PREFERENCES = {
  "gpt-5.6-sol": ["fast", "balanced", "advanced", "high", "pro"],
  "gpt-5.5": ["fast", "balanced", "advanced", "high", "pro"],
  "gpt-5.4": ["fast", "balanced", "advanced", "high", "pro"],
  "gpt-5.3": ["fast"],
  o3: []
};
const DEFAULT_MODE_LABELS = {
  default: "默认",
  fast: "极速 5.5",
  balanced: "中",
  advanced: "高",
  high: "极高",
  pro: "Pro"
};
const MODE_LABELS_BY_MODEL = {
  "gpt-5.6-sol": { fast: "极速 5.5", pro: "Pro" },
  "gpt-5.5": { fast: "极速", pro: "Pro 深度模式" },
  "gpt-5.4": { fast: "极速", pro: "专业" },
  "gpt-5.3": { fast: "极速" }
};
const ACCEPTANCE_MODE = PAGE_QUERY.get("qa") === "1";
const TEXT_PREVIEW_EXTENSIONS = new Set(["txt", "md", "json", "html", "css", "js", "ts", "py", "log", "xml", "yaml", "yml"]);
const INLINE_PREVIEW_EXTENSIONS = new Set(["xlsx", "csv", "pptx", "pdf", "docx", "zip", "psd"]);
const TEXT_ENCODING_LOSS_MESSAGE = "文本看起来已经乱码，里面出现大量问号。请重新输入后再发送。";
const HIDDEN_ENCODING_LOSS_MESSAGE = "这条消息疑似在发送前已经乱码，已隐藏原文。";

function modelSupportsModePreference(modelPreference) {
  return modePreferencesForModel(modelPreference).length > 0;
}

function modePreferencesForModel(modelPreference) {
  return MODEL_MODE_PREFERENCES[modelPreference] || [];
}

function compatibleModePreference(modelPreference, modePreference) {
  const allowedModes = modePreferencesForModel(modelPreference);
  if (!allowedModes.length) {
    return null;
  }
  return allowedModes.includes(modePreference) ? modePreference : allowedModes[0];
}

function modeLabelForModel(modePreference, modelPreference) {
  return MODE_LABELS_BY_MODEL[modelPreference]?.[modePreference] || DEFAULT_MODE_LABELS[modePreference] || modePreference;
}

function syncModeOptionLabels() {
  if (!els.modeSelect) return;
  const modelPreference = selectedModelPreference();
  for (const option of els.modeSelect.options) {
    option.textContent = modeLabelForModel(option.value, modelPreference);
  }
}

const els = {
  appShell: document.querySelector(".app-shell"),
  backToProjectsButton: document.querySelector("#backToProjectsButton"),
  activeProjectTitle: document.querySelector("#activeProjectTitle"),
  bindingState: document.querySelector("#bindingState"),
  syncModeText: document.querySelector("#syncModeText"),
  routingRuleState: document.querySelector("#routingRuleState"),
  themeToggle: document.querySelector("#themeToggle"),
  selfCheckButton: document.querySelector("#selfCheckButton"),
  clearMessagesButton: document.querySelector("#clearMessagesButton"),
  settingsButton: document.querySelector("#settingsButton"),
  refreshButton: document.querySelector("#refreshButton"),
  projectView: document.querySelector("#projectView"),
  onboardingGuide: document.querySelector("#onboardingGuide"),
  projectList: document.querySelector("#projectList"),
  newProjectForm: document.querySelector("#newProjectForm"),
  newProjectSubmitButton: document.querySelector("#newProjectSubmitButton"),
  projectNameInput: document.querySelector("#projectNameInput"),
  projectUrlInput: document.querySelector("#projectUrlInput"),
  targetRepoInput: document.querySelector("#targetRepoInput"),
  chatView: document.querySelector("#chatView"),
  acceptancePanel: document.querySelector("#acceptancePanel"),
  acceptanceSummary: document.querySelector("#acceptanceSummary"),
  acceptanceList: document.querySelector("#acceptanceList"),
  acceptanceRefreshButton: document.querySelector("#acceptanceRefreshButton"),
  acceptanceSendNextButton: document.querySelector("#acceptanceSendNextButton"),
  acceptanceReportButton: document.querySelector("#acceptanceReportButton"),
  acceptanceRecordButton: document.querySelector("#acceptanceRecordButton"),
  workflowBanner: document.querySelector("#workflowBanner"),
  workflowTitle: document.querySelector("#workflowTitle"),
  workflowDetail: document.querySelector("#workflowDetail"),
  workflowNextStep: document.querySelector("#workflowNextStep"),
  workflowActions: document.querySelector("#workflowActions"),
  workflowOpenBoundChatButton: document.querySelector("#workflowOpenBoundChatButton"),
  workflowOpenExtensionsButton: document.querySelector("#workflowOpenExtensionsButton"),
  workflowApplyPreferencesButton: document.querySelector("#workflowApplyPreferencesButton"),
  workflowCopyStepsButton: document.querySelector("#workflowCopyStepsButton"),
  workflowRecheckButton: document.querySelector("#workflowRecheckButton"),
  selfCheckPanel: document.querySelector("#selfCheckPanel"),
  selfCheckTitle: document.querySelector("#selfCheckTitle"),
  selfCheckDetail: document.querySelector("#selfCheckDetail"),
  selfCheckNextStep: document.querySelector("#selfCheckNextStep"),
  chainStatusPanel: document.querySelector("#chainStatusPanel"),
  chainSummaryValue: document.querySelector("#chainSummaryValue"),
  chainUpdatedValue: document.querySelector("#chainUpdatedValue"),
  chainRouteValue: document.querySelector("#chainRouteValue"),
  chainSavingsValue: document.querySelector("#chainSavingsValue"),
  chainRuleValue: document.querySelector("#chainRuleValue"),
  chainErrorValue: document.querySelector("#chainErrorValue"),
  chainCopyStatusButton: document.querySelector("#chainCopyStatusButton"),
  chainCopyAcceptanceRecordButton: document.querySelector("#chainCopyAcceptanceRecordButton"),
  chatMessages: document.querySelector("#chatMessages"),
  outputDrawer: document.querySelector("#outputDrawer"),
  outputSummary: document.querySelector("#outputSummary"),
  artifactImportInput: document.querySelector("#artifactImportInput"),
  artifactList: document.querySelector("#artifactList"),
  chatForm: document.querySelector("#chatForm"),
  composerBox: document.querySelector("#composerBox"),
  attachmentTray: document.querySelector("#attachmentTray"),
  composerFileInput: document.querySelector("#composerFileInput"),
  composerBlockHint: document.querySelector("#composerBlockHint"),
  modeSelect: document.querySelector("#modeSelect"),
  modelSelect: document.querySelector("#modelSelect"),
  chatInput: document.querySelector("#chatInput"),
  sendButton: document.querySelector("#sendButton"),
  settingsDialog: document.querySelector("#settingsDialog"),
  bindingForm: document.querySelector("#bindingForm"),
  settingsProjectUrlInput: document.querySelector("#settingsProjectUrlInput"),
  settingsTargetRepoInput: document.querySelector("#settingsTargetRepoInput"),
  previewDialog: document.querySelector("#previewDialog"),
  previewTitle: document.querySelector("#previewTitle"),
  previewDownloadButton: document.querySelector("#previewDownloadButton"),
  previewBody: document.querySelector("#previewBody"),
  acceptanceRecordDialog: document.querySelector("#acceptanceRecordDialog"),
  acceptanceRecordBody: document.querySelector("#acceptanceRecordBody"),
  acceptanceRecordCopyButton: document.querySelector("#acceptanceRecordCopyButton"),
  acceptanceRecordDownloadButton: document.querySelector("#acceptanceRecordDownloadButton"),
  imageDialog: document.querySelector("#imageDialog"),
  imagePreviewTitle: document.querySelector("#imagePreviewTitle"),
  imagePreviewCounter: document.querySelector("#imagePreviewCounter"),
  imagePreviewDownloadButton: document.querySelector("#imagePreviewDownloadButton"),
  imagePreviewPrev: document.querySelector("#imagePreviewPrev"),
  imagePreviewNext: document.querySelector("#imagePreviewNext"),
  imagePreview: document.querySelector("#imagePreview"),
  toast: document.querySelector("#toast")
};

const state = {
  projects: [],
  otherProjects: [],
  activeProjectId: null,
  activeProject: null,
  workspace: null,
  status: null,
  artifacts: [],
  artifactCache: new Map(),
  previewCache: new Map(),
  stablePreviewNodes: new Map(),
  imageGallerySelection: new Map(),
  imagePreviewArtifacts: [],
  imagePreviewIndex: 0,
  imagePreviewOnChange: null,
  previewArtifactForDownload: null,
  messages: [],
  expandedLongTextKeys: new Set(),
  longTextScrollPositions: new Map(),
  readingLongTextUntil: 0,
  initialBottomScrollUntil: 0,
  cancellingSyncJobIds: new Set(),
  pendingFiles: [],
  acceptanceStatus: null,
  acceptanceRecordText: "",
  gptPreflight: null,
  currentCodexThreadId: null,
  modePreference: "balanced",
  modelPreference: "gpt-5.6-sol",
  theme: window.localStorage.getItem("bridge-theme") || "dark",
  loading: false
};

let preferenceSyncTimer = null;
const projectRefreshCoordinator = createProjectRefreshCoordinator();

document.documentElement.dataset.theme = state.theme;

function normalizeVisibleGptText(input = "") {
  const text = String(input?.message || input || "").trim();
  if (!text) return "";
  const normalized = text
    .replace(/ChatGPT page cannot receive messages yet/gi, "GPT 页面暂时不能接收任务")
    .replace(
      /ChatGPT is still generating\. Bridge will wait for the current reply to finish\./gi,
      "GPT 正在生成上一条回复，Bridge 会等它结束后继续。"
    )
    .replace(
      /Keep this page open\. Bridge will continue after the page recovers\./gi,
      "保持绑定的 GPT 页面打开，页面恢复后 Bridge 会继续。"
    )
    .replace(
      /ChatGPT composer is not available yet, possibly because the page is still rendering or blocked by a dialog\./gi,
      "GPT 输入框暂时不可用，可能页面仍在加载或被弹窗阻挡。"
    )
    .replace(/ChatGPT page is ready to receive Bridge messages\./gi, "GPT 页面已就绪。")
    .replace(
      /ChatGPT is still loading and cannot receive Bridge messages yet\./gi,
      "GPT 页面仍在加载，暂时不能接收任务。"
    )
    .replace(
      /ChatGPT generation failed\. Retry or switch to another conversation\./gi,
      "GPT 生成失败。可以重试；连续失败时请换一个会话。"
    )
    .replace(
      /ChatGPT is asking for human verification\. Complete it manually on the ChatGPT page; Bridge will not bypass it\./gi,
      "GPT 需要真人验证。请在绑定页面手动完成，Bridge 不会绕过验证。"
    )
    .replace(
      /ChatGPT is on an account selection or login confirmation screen\. Confirm the current account manually, then retry\./gi,
      "GPT 页面停在账号选择或登录确认，请手动确认当前账号后重试。"
    )
    .replace(
      /The bound ChatGPT conversation is unavailable or not found\. Rebind a conversation that can be opened\./gi,
      "绑定的 GPT 会话不可用或找不到，请重新绑定一个能打开的会话。"
    )
    .replace(/ChatGPT is on the new chat page instead of the bound conversation\./gi, "当前 GPT 页面不是绑定会话。")
    .replace(
      /ChatGPT is showing a file preview\. Bridge will return to the bound conversation first\./gi,
      "GPT 正在显示文件预览，Bridge 会先回到绑定会话。"
    )
    .replace(/\bChatGPT Project\b/g, "GPT 会话")
    .replace(/\bChatGPT\b/g, "GPT");
  return maskVisibleBrandName(normalized);
}

function friendlyErrorMessage(input = "") {
  const message = normalizeVisibleGptText(input);
  if (!message) return "";
  const lower = message.toLowerCase();
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "连接没有建立成功，请确认 Bridge 服务和绑定的 GPT 页面都打开后重试。";
  }
  if (/timed out waiting for (?:chatgpt|gpt) to stop the previous response|previous response/i.test(lower)) {
    return "GPT 上一条回复还没结束，请在绑定会话停止当前回复或刷新后重试。";
  }
  if (/timed out waiting for (?:chatgpt|gpt) reply|reply timeout/i.test(lower)) {
    return "GPT 这次回复超时，请确认绑定会话没有卡住后重试。";
  }
  if (/something went wrong while generating the response|generation failed|generating the response/i.test(lower)) {
    return "GPT 这次生成失败，可以重试；连续失败时请换一个会话再发。";
  }
  if (/download.*timed out|download was interrupted|chrome download|下载任务|下载失败/i.test(message)) {
    return "文件下载没有被浏览器成功捕获，请关闭下载弹窗后在 GPT 文件卡片上重新触发。";
  }
  if (/err_blocked_by_client|blocked by client|chrome.*blocked|被屏蔽/i.test(message)) {
    return "GPT 页面被 Chrome 或其它扩展拦截。请关闭拦截 chatgpt.com 的扩展或加入白名单后，只刷新绑定会话。";
  }
  if (/account selection|login confirmation|sign in|log in|账号选择|登录确认/i.test(message)) {
    return "GPT 需要确认账号，请在绑定的 GPT 页面确认当前账号后重试。";
  }
  if (/human verification|cloudflare|verify you are human|真人验证/i.test(message)) {
    return "GPT 需要真人验证，请先在绑定页面完成验证后重试。";
  }
  return message;
}

function looksLikeQuestionMarkEncodingLoss(value = "") {
  const text = String(value || "").trim();
  if (!text) return false;
  const nonSpaceText = text.replace(/\s/g, "");
  const questionMarks = (text.match(/\?/g) || []).length;
  const hasCjk = /[\u3400-\u9fff\uf900-\ufaff]/u.test(text);
  const hasMeaningfulAscii = /[a-z0-9]/iu.test(text);
  const hasEnoughQuestionMarksToStandAlone = questionMarks >= 8;
  return (
    !hasCjk &&
    (hasMeaningfulAscii || hasEnoughQuestionMarksToStandAlone) &&
    /\?{3,}/.test(text) &&
    questionMarks >= 5 &&
    questionMarks / Math.max(nonSpaceText.length, 1) >= 0.35
  );
}

function friendlySyncStatusReason(reason = "", syncStatus = "") {
  const message = normalizeVisibleGptText(reason);
  if (!message) return "";
  const normalized = friendlyErrorMessage(message);
  if (normalized !== message) return normalized;
  if (syncStatus === "failed" && /error|exception|timeout|failed/i.test(message)) {
    return "GPT 同步失败，请确认绑定会话状态后重试。";
  }
  return message;
}

async function api(path, options = {}) {
  const response = await bridgeApiClient.fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      message = JSON.parse(text)?.error || text;
    } catch {
      // Keep the server's plain-text response.
    }
    throw new Error(friendlyErrorMessage(message || `请求失败：${response.status}`));
  }

  return response.json();
}

function scopedProjectPath(path, projectId = state.activeProjectId) {
  if (!projectId) {
    return path;
  }
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}projectId=${encodeURIComponent(projectId)}`;
}

function showToast(message) {
  els.toast.textContent = friendlyErrorMessage(message);
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    els.toast.textContent = "";
  }, 2800);
}

function formatTime(value) {
  if (!value) return "刚刚";
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatMessageTime(value) {
  if (!value) return "刚刚";
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function formatDateTime(value) {
  if (!value) return "没有记录";
  return new Date(value).toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatBytes(value = 0) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatDurationMs(value) {
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1000) return "不到 1 秒";
  if (value < 60_000) return `${Math.round(value / 1000)} 秒`;
  if (value < 60 * 60_000) return `${Math.round(value / 60_000)} 分钟`;
  return `${Math.round(value / (60 * 60_000))} 小时`;
}

function reliableGptThoughtMs(durations = {}) {
  const thoughtMs = Number(durations.gptThoughtMs);
  if (!Number.isFinite(thoughtMs) || thoughtMs < 0) return null;
  const responseMs = Number(durations.responseMs);
  if (Number.isFinite(responseMs) && thoughtMs > responseMs + 5000) return null;
  return thoughtMs;
}

function formatSyncProgressDuration(progress = null) {
  const durations = progress?.durations || {};
  if (progress?.stage === "queued" && Number.isFinite(durations.queueMs)) {
    return `已等 ${formatDurationMs(durations.queueMs)}`;
  }
  if (progress?.stage === "sending" && Number.isFinite(durations.preSendMs)) {
    return `发送准备 ${formatDurationMs(durations.preSendMs)}`;
  }
  if (progress?.stage === "waiting_reply" && Number.isFinite(durations.responseMs)) {
    return `GPT 已处理 ${formatDurationMs(durations.responseMs)}`;
  }
  if (progress?.stage === "completed") {
    const thoughtMs = reliableGptThoughtMs(durations);
    const parts = [];
    if (Number.isFinite(thoughtMs)) parts.push(`GPT 用时 ${formatDurationMs(thoughtMs)}`);
    if (Number.isFinite(durations.responseMs)) parts.push(`Bridge 捕获 ${formatDurationMs(durations.responseMs)}`);
    return parts.join(" · ");
  }
  if (progress?.stage === "failed" && Number.isFinite(durations.totalMs)) {
    return `总耗时 ${formatDurationMs(durations.totalMs)}`;
  }
  return "";
}

function shortId(value = "") {
  return value ? value.slice(-8) : "未连接";
}

function compactText(value = "", maxLength = 96) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}...`;
}

function hashString(value = "") {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function longTextKey(baseKey = "message", index = 0, text = "") {
  return `${baseKey}:long:${index}:${hashString(text)}`;
}

function rememberLongTextScroll(key, element) {
  if (!key || !element) return;
  state.longTextScrollPositions.set(key, element.scrollTop);
}

function markLongTextReadingIntent(durationMs = 30000) {
  state.readingLongTextUntil = Math.max(state.readingLongTextUntil || 0, Date.now() + durationMs);
}

function isLongTextReadingActive() {
  return Date.now() < (state.readingLongTextUntil || 0);
}

function restoreLongTextScroll(key, element) {
  if (!key || !element || !state.expandedLongTextKeys.has(key)) return;
  const scrollTop = state.longTextScrollPositions.get(key);
  if (!Number.isFinite(scrollTop) || scrollTop <= 0) return;
  window.requestAnimationFrame(() => {
    element.scrollTop = Math.min(scrollTop, Math.max(0, element.scrollHeight - element.clientHeight));
  });
}

function composerTargets() {
  return ["auto"];
}

function selectedModePreference() {
  return compatibleModePreference(selectedModelPreference(), els.modeSelect?.value || state.modePreference);
}

function selectedModelPreference() {
  return MODEL_PREFERENCES.has(els.modelSelect?.value) ? els.modelSelect.value : state.modelPreference || "gpt-5.6-sol";
}

function setModePreference(value) {
  state.modePreference = MODE_PREFERENCES.has(value) ? value : state.modePreference || "balanced";
  const visibleMode = compatibleModePreference(selectedModelPreference(), state.modePreference) || "default";
  if (els.modeSelect && els.modeSelect.value !== visibleMode) {
    els.modeSelect.value = visibleMode;
  }
  syncPreferenceControls();
}

function syncPreferenceControls() {
  if (!els.modeSelect) return;
  syncModeOptionLabels();
  const allowedModes = modePreferencesForModel(selectedModelPreference());
  const supportsModes = allowedModes.length > 0;
  els.modeSelect.disabled = !supportsModes;
  for (const option of els.modeSelect.options) {
    if (option.value === "default") {
      option.hidden = supportsModes;
      option.disabled = supportsModes;
    } else {
      const supported = allowedModes.includes(option.value);
      option.hidden = supportsModes && !supported;
      option.disabled = supportsModes ? !supported : true;
    }
  }
  els.modeSelect.title = supportsModes ? "GPT 模式" : "当前模型不支持模式选择";
  if (!supportsModes) {
    els.modeSelect.value = "default";
  } else if (!allowedModes.includes(els.modeSelect.value)) {
    els.modeSelect.value = compatibleModePreference(selectedModelPreference(), state.modePreference);
  }
}

function setModelPreference(value) {
  state.modelPreference = MODEL_PREFERENCES.has(value) ? value : "gpt-5.6-sol";
  if (els.modelSelect && els.modelSelect.value !== state.modelPreference) {
    els.modelSelect.value = state.modelPreference;
  }
  syncPreferenceControls();
}

function queuePreferenceSync() {
  window.clearTimeout(preferenceSyncTimer);
  preferenceSyncTimer = window.setTimeout(syncPreferencesToChatGpt, 120);
}

async function syncPreferencesToChatGpt({ successToast = "已发送同步请求" } = {}) {
  try {
    const result = await api(scopedProjectPath("/api/preferences/sync"), {
      method: "POST",
      body: JSON.stringify({
        projectId: state.activeProjectId,
        modePreference: selectedModePreference(),
        modelPreference: selectedModelPreference()
      })
    });
    state.workspace = result.workspace || state.workspace;
    showToast(successToast);
    return result;
  } catch (error) {
    if (/(?:ChatGPT Project|GPT 会话) is not bound|409/i.test(error.message || "")) {
      showToast("先绑定 GPT 会话");
      return null;
    }
    showToast(error.message);
    return null;
  }
}

function targetLabel(targets = []) {
  return targets
    .map((target) => {
      if (target === "gpt") return "GPT";
      if (target === "codex") return "Codex";
      if (target === "auto") return "自动";
      return "你";
    })
    .join(" + ");
}

function roleLabel(message) {
  if (isAcceptanceMessage(message)) return "Codex 验收";
  if (message.from === "gpt" || message.role === "chatgpt") return "GPT";
  if (message.from === "codex" || message.role === "assistant") return "Codex";
  return "你";
}

function visualMessageFrom(message) {
  if (isAcceptanceMessage(message)) return "codex";
  return message.from || message.role || "user";
}

function looksLikeAcceptancePrompt(message) {
  const text = message.text || "";
  return (
    (message.from || message.role) === "user" &&
    Array.isArray(message.to) &&
    message.to.includes("gpt") &&
    [
      "用于测试 Bridge 是否能读取 GPT 文本回复",
      "800 字左右的中文长文",
      "Markdown JavaScript 代码块",
      "请用 GPT 自带图片生成功能生成 1 张图片",
      "请用 GPT 自带图片生成功能生成 3 张",
      "请生成一个可下载的 xlsx 文件",
      "请生成一个可下载的 pptx 文件",
      "请生成一个可下载的 PDF 文件",
      "请生成一个很小的可下载 zip 文件"
    ].some((pattern) => text.includes(pattern))
  );
}

function isAcceptanceMessage(message) {
  return (
    (message.metadata?.origin === "acceptance" && message.metadata?.actor === "codex") ||
    looksLikeAcceptancePrompt(message)
  );
}

function setTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  window.localStorage.setItem("bridge-theme", theme);
  els.themeToggle.dataset.theme = theme;
  els.themeToggle.title = theme === "dark" ? "切换到白色主题" : "切换到黑色主题";
  els.themeToggle.setAttribute("aria-label", els.themeToggle.title);
}

function isImageArtifact(artifact = {}) {
  const filename = artifact.filename || "";
  const contentType = artifact.contentType || "";
  const extension = filename.split(".").pop()?.toLowerCase() || "";
  if (extension === "psd") return false;
  return contentType.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(extension);
}

function artifactExtension(artifact = {}) {
  return (artifact.filename || "").split(".").pop()?.toLowerCase() || "";
}

function isTextPreviewArtifact(artifact = {}) {
  const contentType = (artifact.contentType || "").toLowerCase();
  return contentType.startsWith("text/") || TEXT_PREVIEW_EXTENSIONS.has(artifactExtension(artifact));
}

function canPreviewArtifact(artifact = {}) {
  const extension = artifactExtension(artifact);
  return (
    isImageArtifact(artifact) ||
    isTextPreviewArtifact(artifact) ||
    INLINE_PREVIEW_EXTENSIONS.has(extension) ||
    extension === "csv"
  );
}

function canInlinePreviewArtifact(artifact = {}) {
  return isTextPreviewArtifact(artifact) || INLINE_PREVIEW_EXTENSIONS.has(artifactExtension(artifact));
}

function artifactKind(artifact = {}) {
  const extension = artifactExtension(artifact);
  if (isImageArtifact(artifact)) return "图片";
  if (["xlsx", "xls", "csv"].includes(extension)) return "表格";
  if (["pptx", "ppt"].includes(extension)) return "演示";
  if (["docx", "doc"].includes(extension)) return "文档";
  if (extension === "pdf") return "PDF";
  if (extension === "zip") return "ZIP";
  if (TEXT_PREVIEW_EXTENSIONS.has(extension)) {
    return "文本";
  }
  if (extension === "psd") return "PSD";
  return "文件";
}

function artifactInitial(artifact = {}) {
  const kind = artifactKind(artifact);
  if (kind === "图片") return "IMG";
  if (kind === "表格") return "XLS";
  if (kind === "演示") return "PPT";
  if (kind === "文档") return "DOC";
  return kind.toUpperCase();
}

function artifactDownloadUrl(artifactOrId) {
  const id = typeof artifactOrId === "string" ? artifactOrId : artifactOrId.id;
  return `/api/artifacts/${encodeURIComponent(id)}/download`;
}

function artifactViewUrl(artifactOrId) {
  const id = typeof artifactOrId === "string" ? artifactOrId : artifactOrId.id;
  return `/api/artifacts/${encodeURIComponent(id)}/view`;
}

function artifactDownloadFilename(artifactOrId) {
  if (typeof artifactOrId === "string") {
    return state.artifactCache.get(artifactOrId)?.filename || "download";
  }
  return artifactOrId?.filename || "download";
}

async function downloadArtifactToDevice(artifactOrId) {
  if (!artifactOrId) return;
  const filename = artifactDownloadFilename(artifactOrId);
  const link = document.createElement("a");
  link.href = artifactDownloadUrl(artifactOrId);
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  showToast("下载已开始");
}

function downloadTextFile(filename, text, contentType = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: contentType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function createButton(label, className, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

const ICONS = {
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v10m0 0 4-4m-4 4-4-4M5 17v2h14v-2"/></svg>',
  expand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg>'
};

function createIconButton(label, icon, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "artifact-icon-button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = ICONS[icon] || "";
  button.addEventListener("click", onClick);
  return button;
}

function createIconDownloadButton(artifact) {
  return createIconButton("下载", "download", async () => {
    try {
      await downloadArtifactToDevice(artifact);
    } catch (error) {
      showToast(error.message);
    }
  });
}

function setImageActionArtifact(actions, artifact) {
  const previousDownload = actions.querySelector('[data-image-action="download"]');
  const previousExpand = actions.querySelector('[data-image-action="expand"]');

  if (previousDownload) {
    const download = createIconDownloadButton(artifact);
    download.dataset.imageAction = "download";
    previousDownload.replaceWith(download);
  }

  if (previousExpand) {
    const expand = createIconButton("放大", "expand", () => openImagePreview(artifact));
    expand.dataset.imageAction = "expand";
    previousExpand.replaceWith(expand);
  }
}

function setImageGalleryActionArtifacts(actions, artifacts, index = 0, options = {}) {
  const artifact = artifacts[index];
  const previousDownload = actions.querySelector('[data-image-action="download"]');
  const previousExpand = actions.querySelector('[data-image-action="expand"]');

  if (previousDownload) {
    const download = createIconDownloadButton(artifact);
    download.dataset.imageAction = "download";
    previousDownload.replaceWith(download);
  }

  if (previousExpand) {
    const expand = createIconButton("放大", "expand", () => openImagePreview(artifacts, index, options));
    expand.dataset.imageAction = "expand";
    previousExpand.replaceWith(expand);
  }
}

function createImageActions(artifact) {
  const actions = document.createElement("span");
  actions.className = "image-actions";

  const download = createIconDownloadButton(artifact);
  download.dataset.imageAction = "download";
  const expand = createIconButton("放大", "expand", () => openImagePreview(artifact));
  expand.dataset.imageAction = "expand";

  actions.append(download, expand);
  return actions;
}

function replacePageProjectId(projectId) {
  const pageUrl = withProjectIdInPageUrl(window.location.href, projectId);
  if (pageUrl !== window.location.href) {
    window.history.replaceState({}, "", pageUrl);
  }
}

function showProjects() {
  replacePageProjectId(null);
  document.body.classList.add("project-mode");
  els.projectView.classList.remove("is-hidden");
  els.chatView.classList.add("is-hidden");
  els.backToProjectsButton.classList.add("is-hidden");
  els.settingsButton.disabled = true;
  els.activeProjectTitle.textContent = "选择项目";
  if (els.newProjectSubmitButton) {
    els.newProjectSubmitButton.textContent = state.currentCodexThreadId ? "绑定当前会话并进入" : "创建项目并进入";
  }
}

function showChat() {
  replacePageProjectId(state.activeProjectId);
  document.body.classList.remove("project-mode");
  els.projectView.classList.add("is-hidden");
  els.chatView.classList.remove("is-hidden");
  els.backToProjectsButton.classList.remove("is-hidden");
  els.settingsButton.disabled = false;
  els.activeProjectTitle.textContent = state.activeProject?.name || "当前项目";
  startInitialBottomScrollSettle();
}

function projectSubtitle(project) {
  const repo = project.targetRepo || "未设置本地目录";
  const gpt = project.chatgptProjectUrl ? "GPT 已绑定" : "GPT 未绑定";
  const codex = project.currentCodexThreadId ? `Codex ${shortId(project.currentCodexThreadId)}` : "Codex 待绑定";
  return `${gpt} / ${codex} / ${repo}`;
}

function renderProjectList() {
  els.projectList.replaceChildren();
  renderOnboardingGuide();

  if (state.projects.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "还没有项目。先创建一个，把 GPT 会话和本地目录绑在一起。";
    els.projectList.append(empty);
    return;
  }

  for (const project of state.projects) {
    const card = document.createElement("article");
    card.className = "project-card";
    if (project.id === state.activeProjectId) {
      card.classList.add("is-active");
    }

    const meta = document.createElement("div");
    meta.className = "project-card-main";
    const title = document.createElement("h2");
    title.textContent = project.name || "未命名项目";
    const subtitle = document.createElement("p");
    subtitle.textContent = projectSubtitle(project);
    const updated = document.createElement("small");
    updated.textContent = `更新于 ${formatDateTime(project.updatedAt)}`;
    meta.append(title, subtitle, updated);

    const actions = document.createElement("div");
    actions.className = "project-card-actions";
    const enter = createButton("进入", "project-enter", () => selectProject(project.id));
    const remove = createButton("删除", "project-delete", (event) => {
      event.stopPropagation();
      deleteProject(project.id);
    });
    actions.append(enter, remove);
    card.append(meta, actions);
    card.addEventListener("dblclick", () => selectProject(project.id));
    els.projectList.append(card);
  }
}

function renderOnboardingGuide() {
  if (!els.onboardingGuide) return;
  els.onboardingGuide.dataset.hasProjects = state.projects.length > 0 ? "true" : "false";
}

async function loadProjects({ autoEnter = false, preferredProjectId = null } = {}) {
  const payload = await api("/api/projects");
  state.projects = payload.projects || [];
  state.otherProjects = payload.otherProjects || [];
  const preferredProject = state.projects.find((project) => project.id === preferredProjectId);
  state.activeProjectId = preferredProject?.id || payload.activeProjectId || state.projects[0]?.id || null;
  state.activeProject = state.projects.find((project) => project.id === state.activeProjectId) || null;
  renderProjectList();

  const canAutoEnter = autoEnter && state.activeProject && (!preferredProjectId || preferredProject);
  if (canAutoEnter) {
    showChat();
    await refreshWorkspaceSurface({ scrollToBottom: true });
  } else {
    showProjects();
  }
}

async function selectProject(projectId) {
  try {
    const payload = await selectProjectForScope({
      api,
      projectId,
      currentCodexThreadId: state.currentCodexThreadId
    });
    projectRefreshCoordinator.invalidate();
    state.workspace = null;
    state.status = null;
    state.artifacts = [];
    state.messages = [];
    renderMessages([]);
    renderArtifacts([]);
    state.activeProjectId = payload.activeProjectId;
    state.activeProject = payload.project;
    await loadProjects({ autoEnter: false });
    state.activeProjectId = payload.activeProjectId;
    state.activeProject = payload.project;
    showChat();
    await refreshWorkspaceSurface({ scrollToBottom: true });
    showToast("已进入项目");
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteProject(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!projectId) return;
  const name = project?.name || "这个项目";
  const confirmed = window.confirm(`删除“${name}”？只会从 Bridge 项目列表隐藏，不会删除本地文件。`);
  if (!confirmed) return;

  try {
    await api(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: "DELETE"
    });
    await loadProjects({ autoEnter: false });
    showProjects();
    showToast("项目已删除");
  } catch (error) {
    showToast(error.message);
  }
}

function preferenceStatusMatchesWorkspace(preferenceStatus, workspace) {
  if (!preferenceStatus || !workspace) return false;
  const preferenceUpdatedAt = workspace.preferenceUpdatedAt || workspace.updatedAt;
  if (preferenceUpdatedAt && preferenceStatus.updatedAt !== preferenceUpdatedAt) {
    return false;
  }
  return (
    (preferenceStatus.modePreference || null) === (workspace.modePreference || null) &&
    (preferenceStatus.modelPreference || null) === (workspace.modelPreference || null)
  );
}

function syncLabel(status) {
  const connection = status?.connection;
  if (connection?.label) return connection.label;
  if (status?.extension?.needsReload) return "扩展需重载";
  if (status?.extension?.projectMatches === false) return "GPT 页不匹配";
  const workspace = status?.workspace || state.workspace || {};
  const preferenceStatus = status?.extension?.heartbeat?.preferenceStatus;
  const currentPreferenceStatus = preferenceStatusMatchesWorkspace(preferenceStatus, workspace) ? preferenceStatus : null;
  if (currentPreferenceStatus?.state === "failed") return "偏好未应用";
  if (currentPreferenceStatus?.state === "applied") return "偏好已应用";
  const active = status?.activeSyncJob;
  if (!active) {
    return status?.extension?.connected ? "同步就绪" : "等待扩展";
  }
  if (active.progress?.shortLabel) return active.progress.shortLabel;
  if (active.status === "running") return active.sentAt ? "等待 GPT" : "扩展处理中";
  if (active.status === "pending") return "等待扩展";
  return "等待扩展";
}

function connectionChipLevel(status) {
  const connection = status?.connection || null;
  if (connection?.level === "ready" || connection?.canSendToGpt !== false) return "ok";
  if (connection?.level === "working" || status?.activeSyncJob) return "working";
  if (status?.extension?.connected === false || !status?.extension?.connected) return "waiting";
  return "error";
}

function connectionChipLabel(status) {
  const level = connectionChipLevel(status);
  if (level === "ok") return "连接就绪";
  if (level === "working") return "处理中";
  if (level === "waiting") return "等待扩展";
  return status?.workflowStatus?.label || status?.connection?.label || "需要处理";
}

function routingRuleLabel(workspace = {}) {
  if (workspace.bridgeRulesPath) {
    return {
      label: "规则已写入",
      className: "status-pill routing-rule-state is-ok",
      title: `${workspace.bridgeRulesPath} · 默认交给 GPT；明确说让 Codex 做时才覆盖`
    };
  }
  if (workspace.targetRepo) {
    return {
      label: "规则待写入",
      className: "status-pill routing-rule-state",
      title: "保存绑定或首次通过插件调用后，会自动写入 BRIDGE.md"
    };
  }
  return {
    label: "未绑定目录",
    className: "status-pill routing-rule-state",
    title: "绑定本地项目目录后，会自动写入 BRIDGE.md 分工规则"
  };
}

function latestChainMessage(messages = []) {
  return [...messages]
    .reverse()
    .find((message) => {
      const targets = Array.isArray(message.to) ? message.to : [];
      return targets.includes("gpt") || targets.includes("codex") || message.metadata?.routingKind;
    });
}

function routeLabelForChainPanel(syncJob = null, message = null) {
  const routingKind = message?.metadata?.routingKind || syncJob?.routingKind || null;
  if (routingKind === "gpt_only") return "GPT";
  if (routingKind === "codex_only") return "Codex";
  if (routingKind === "gpt_then_codex") return "GPT -> Codex";
  if (!syncJob && !message) return "未开始";

  const kind = syncJob?.kind || "";
  if (kind === "codex_file_analysis") return "Codex -> GPT";
  if (kind === "codex_result") return "Codex 结果同步";
  if (kind === "codex_consultation") return "Codex 咨询 GPT";
  if (kind === "chatgpt_reply") return "GPT 回复";

  const targets = Array.isArray(message?.to) ? message.to : [];
  if (targets.includes("gpt") && message?.from === "codex") return "Codex -> GPT";
  if (targets.includes("gpt")) return "你 -> GPT";
  if (targets.includes("codex")) return "你 -> Codex";
  return "GPT";
}

function savingsLabelForChainPanel(syncJob = null, message = null) {
  const routingKind = message?.metadata?.routingKind || syncJob?.routingKind || null;
  const kind = syncJob?.kind || "";
  if (!syncJob && !message) return "未触发";
  if (routingKind === "codex_only" || kind === "codex_result") return "Codex 本地";
  if (routingKind === "gpt_only" || routingKind === "gpt_then_codex") return "已交给 GPT";
  if (["chat_message", "user_request", "codex_file_analysis", "codex_consultation"].includes(kind)) {
    return "已交给 GPT";
  }
  const targets = Array.isArray(message?.to) ? message.to : [];
  return targets.includes("gpt") ? "已交给 GPT" : "Codex 本地";
}

function ruleLabelForChainPanel(workspace = {}) {
  if (workspace.bridgeRulesPath) return "已写入";
  if (workspace.targetRepo) return "待写入";
  return "未绑定目录";
}

function errorLabelForChainPanel(syncJob = null) {
  if (!syncJob) return { label: "无", level: "ok" };
  if (syncJob.status === "failed") {
    if (syncJob.errorCode === "manual_cancelled") {
      return { label: "已停止", level: "ok" };
    }
    return {
      label: compactText(syncJob.progress?.message || "同步失败", 56),
      level: "error"
    };
  }
  if (syncJob.status === "pending") return { label: "等待扩展", level: "working" };
  if (syncJob.status === "running") return { label: syncJob.sentAt ? "等待 GPT" : "准备发送", level: "working" };
  return { label: "无", level: "ok" };
}

function summaryLabelForChainPanel(errorState, syncJob = null, message = null) {
  if (syncJob?.status === "failed" && syncJob.errorCode === "manual_cancelled") return "已停止";
  if (errorState.level === "error") return "需要处理";
  if (errorState.level === "working") return "处理中";
  if (!syncJob && !message) return "链路待命";
  return "链路正常";
}

function renderChainStatusPanel() {
  if (!els.chainStatusPanel) return;
  const syncJob = state.status?.activeSyncJob || state.status?.latestSyncJob || null;
  const message = latestChainMessage(state.messages);
  const workspace = state.status?.workspace || state.workspace || {};
  const errorState = errorLabelForChainPanel(syncJob);

  const summary = summaryLabelForChainPanel(errorState, syncJob, message);
  els.chainSummaryValue.textContent = summary;
  els.chainRouteValue.textContent = routeLabelForChainPanel(syncJob, message);
  els.chainSavingsValue.textContent = savingsLabelForChainPanel(syncJob, message);
  els.chainRuleValue.textContent = ruleLabelForChainPanel(workspace);
  els.chainErrorValue.textContent = errorState.label;
  els.chainErrorValue.classList.toggle("is-error", errorState.level === "error");
  els.chainErrorValue.classList.toggle("is-working", errorState.level === "working");
  els.chainUpdatedValue.textContent = syncJob?.updatedAt
    ? `更新 ${formatMessageTime(syncJob.updatedAt)}`
    : message?.createdAt
      ? `更新 ${formatMessageTime(message.createdAt)}`
      : "等待数据";
  els.chainStatusPanel.dataset.state = errorState.level;
  els.chainStatusPanel.title = `${summary} · ${els.chainRouteValue.textContent} · ${els.chainSavingsValue.textContent} · 规则 ${els.chainRuleValue.textContent}`;
}

function shortChatgptPath(value = "") {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return value || "";
  }
}

function preferenceStatusDetail(preferenceStatus = null) {
  if (!preferenceStatus) return "";
  const mode = preferenceStatus.modePreference
    ? modeLabelForModel(preferenceStatus.modePreference, preferenceStatus.modelPreference || selectedModelPreference())
    : "未设置模式";
  const model = preferenceStatus.modelPreference || "未设置模型";
  if (preferenceStatus.state === "applied") {
    return `${mode} / ${model} 已应用到 GPT 页面`;
  }
  const failed = [
    preferenceStatus.modeSynced === false ? "模式" : null,
    preferenceStatus.modelSynced === false ? "模型" : null
  ].filter(Boolean).join("、");
  return `${failed || "偏好"}未应用：${preferenceStatus.error || `${mode} / ${model}`}`;
}

function workflowRepairText(status = state.status) {
  const workflowStatus = status?.workflowStatus || {};
  const extension = status?.extension || {};
  const lines = [
    "Bridge 修复步骤",
    workflowStatus.title ? `状态：${workflowStatus.title}` : "",
    workflowStatus.detail ? `原因：${workflowStatus.detail}` : "",
    workflowStatus.nextStep ? `下一步：${workflowStatus.nextStep}` : "",
    extension.version ? `当前扩展：${extension.version}` : "",
    extension.expectedVersion ? `需要扩展：${extension.expectedVersion}` : "",
    extension.sourceDir ? `扩展目录：${extension.sourceDir}` : "",
    extension.needsReload
      ? "重载方式：打开 chrome://extensions/，找到 Bridge 扩展，点击重新加载。若扩展不存在，选择“加载已解压的扩展”并选择上面的扩展目录。"
      : "",
    extension.projectMatches === false ? "绑定页不匹配：请打开当前项目绑定的 GPT 页面。" : ""
  ];
  return lines.filter(Boolean).join("\n");
}

function bridgeStatusCopyText(status = state.status) {
  const syncJob = status?.activeSyncJob || status?.latestSyncJob || null;
  const message = latestChainMessage(state.messages);
  const workspace = status?.workspace || state.workspace || {};
  const selfCheck = selfCheckResult(status);
  const errorState = errorLabelForChainPanel(syncJob);
  const summary = summaryLabelForChainPanel(errorState, syncJob, message);
  const route = routeLabelForChainPanel(syncJob, message);
  const savings = savingsLabelForChainPanel(syncJob, message);
  const rule = ruleLabelForChainPanel(workspace);
  const error = errorState.level === "ok" ? "无" : errorState.label;
  const connection = status?.connection?.label || connectionChipLabel(status);
  const nextStep = selfCheck.nextStep || status?.workflowStatus?.nextStep || "继续使用";
  return `Bridge 状态：${summary}；连接：${connection}；链路：${route}；省额度：${savings}；规则：${rule}；错误：${error}；下一步：${nextStep}。`;
}

async function openExtensionManager(status = state.status) {
  const target = "chrome://extensions/";
  const extension = status?.extension || {};
  const copyText = extension.sourceDir || target;
  const opened = window.open(target, "_blank", "noopener");
  let copied = false;
  try {
    await navigator.clipboard.writeText(copyText);
    copied = true;
  } catch {
    copied = false;
  }

  if (opened && copied && extension.sourceDir) {
    showToast("已打开扩展管理页，并复制扩展目录");
    return;
  }
  if (opened) {
    showToast(extension.sourceDir ? "已打开扩展管理页；扩展目录复制失败" : "已打开扩展管理页");
    return;
  }
  if (copied && extension.sourceDir) {
    showToast("已复制扩展目录；请打开 chrome://extensions/");
    return;
  }
  if (copied) {
    showToast("浏览器拦截了打开动作，已复制扩展管理地址");
    return;
  }
  throw new Error("浏览器拦截了打开动作，扩展目录也复制失败。请手动打开 chrome://extensions/");
}

async function openBoundChatPage(status = state.status) {
  const target = status?.workspace?.chatgptProjectUrl || status?.extension?.expectedHref || "";
  if (!target) {
    throw new Error("当前项目还没有绑定 GPT 会话。");
  }
  const opened = window.open(target, "_blank", "noopener");
  if (opened) {
    showToast("已打开绑定的 GPT 会话");
    return;
  }

  try {
    await navigator.clipboard.writeText(target);
    showToast("浏览器拦截了打开动作，已复制绑定会话地址");
  } catch {
    throw new Error("浏览器拦截了打开动作，请从项目设置里复制绑定会话地址后手动打开。");
  }
}

async function applyWorkflowPreferences() {
  els.workflowApplyPreferencesButton.disabled = true;
  try {
    const result = await syncPreferencesToChatGpt({ successToast: "已重新应用模型和模式" });
    if (result) {
      await refreshWorkspaceSurface({ scrollToBottom: false });
    }
  } finally {
    els.workflowApplyPreferencesButton.disabled = false;
  }
}

function syncWorkflowActionButtons(status, shouldShow) {
  const workflowStatus = status?.workflowStatus || {};
  const extension = status?.extension || {};
  const connection = status?.connection || {};
  const preferenceStatus = preferenceStatusMatchesWorkspace(extension.heartbeat?.preferenceStatus, status?.workspace)
    ? extension.heartbeat?.preferenceStatus
    : null;
  const workflowText = [
    workflowStatus.label,
    workflowStatus.title,
    workflowStatus.detail,
    workflowStatus.nextStep
  ].filter(Boolean).join(" ");

  const extensionVersionCheck = connection.checks?.find((check) => check.id === "extension-version");
  const showBoundChatAction = Boolean(
    shouldShow &&
      status?.workspace?.chatgptProjectUrl &&
      (extension.projectMatches === false ||
        workflowStatus.label === "页面不匹配" ||
        /当前 (?:ChatGPT|GPT) 页面不是绑定项目|打开或切回绑定的 (?:ChatGPT|GPT) 会话/.test(workflowText))
  );
  const showExtensionAction = Boolean(
    shouldShow &&
      !showBoundChatAction &&
      ((extension.needsReload && extensionVersionCheck?.state === "blocked") ||
        extension.connected === false ||
        /扩展未连接|扩展版本过旧|重载 Bridge 扩展/.test(workflowText))
  );
  const showPreferenceAction = Boolean(
    shouldShow &&
      (preferenceStatus?.state === "failed" ||
        workflowStatus.label === "偏好未应用" ||
        /模型|模式|偏好/.test(workflowText))
  );
  const showCopyStepsAction = Boolean(
    shouldShow &&
      !showBoundChatAction &&
      workflowStatus.level === "blocked" &&
      (/人工处理|重新绑定|生成失败|扩展|登录|真人验证/.test(workflowText) || showExtensionAction)
  );

  els.workflowActions.hidden = !shouldShow;
  els.workflowOpenBoundChatButton.hidden = !showBoundChatAction;
  els.workflowOpenExtensionsButton.hidden = !showExtensionAction;
  els.workflowApplyPreferencesButton.hidden = !showPreferenceAction;
  els.workflowRecheckButton.hidden = !shouldShow;
  els.workflowCopyStepsButton.hidden = !showCopyStepsAction;
}

function renderWorkflowStatus(status) {
  const workflowStatus = status ? status.workflowStatus : null;
  if (!els.workflowBanner || !workflowStatus) return;

  const shouldShow = workflowStatus.level && workflowStatus.level !== "ready";
  els.workflowBanner.hidden = !shouldShow;
  els.workflowBanner.dataset.level = workflowStatus.level || "ready";
  els.workflowTitle.textContent = normalizeVisibleGptText(workflowStatus.title || workflowStatus.label || "Bridge 状态");
  els.workflowDetail.textContent = normalizeVisibleGptText(workflowStatus.detail || "");
  els.workflowNextStep.textContent = normalizeVisibleGptText(workflowStatus.nextStep || "");
  syncWorkflowActionButtons(status, shouldShow);
}

function selfCheckResult(status = state.status) {
  const workspace = status?.workspace || state.workspace || {};
  const workflowStatus = status?.workflowStatus || null;
  const connection = status?.connection || null;
  const extension = status?.extension || {};
  const heartbeat = extension.heartbeat || null;

  if (!workspace.chatgptProjectUrl) {
    return {
      level: "setup",
      title: "还没绑定 GPT 会话",
      detail: "先在项目设置里填入要协同的 GPT 会话地址。",
      nextStep: "绑定会话"
    };
  }

  if (extension.connected === false && !heartbeat) {
    return {
      level: "blocked",
      title: "扩展还没连上",
      detail: "打开绑定的 GPT 页面，并确认 Bridge 扩展已启用。",
      nextStep: "确认扩展"
    };
  }

  if (workflowStatus?.level && workflowStatus.level !== "ready") {
    return {
      level: workflowStatus.level,
      title: workflowStatus.title || workflowStatus.label || "需要处理",
      detail: workflowStatus.detail || "Bridge 已发现当前链路还有一步没完成。",
      nextStep: workflowStatus.nextStep || "处理后重新自检"
    };
  }

  if (connection?.canSendToGpt === false) {
    return {
      level: "blocked",
      title: connection.label || "暂时不能发送给 GPT",
      detail: currentGptActionBlockMessage(status) || "当前 GPT 链路没有准备好。",
      nextStep: "处理后重新自检"
    };
  }

  if (!workspace.bridgeRulesPath) {
    return {
      level: "warning",
      title: "规则还没写入",
      detail: "可以聊天，但首次使用建议先写入协同规则，避免 Codex 把该交给 GPT 的任务自己做掉。",
      nextStep: "写入规则"
    };
  }

  return {
    level: "ready",
    title: "可以开始使用",
    detail: "本地服务、绑定会话、扩展连接和协同规则都已就绪。",
    nextStep: "发送消息或拖入文件"
  };
}

function renderSelfCheckPanel(result = selfCheckResult()) {
  if (!els.selfCheckPanel) return;
  els.selfCheckPanel.hidden = false;
  els.selfCheckPanel.dataset.level = result.level || "ready";
  els.selfCheckTitle.textContent = result.title || "自检完成";
  els.selfCheckDetail.textContent = result.detail || "";
  els.selfCheckNextStep.textContent = result.nextStep || "";
}

async function runSelfCheck() {
  if (!els.selfCheckButton) return;
  els.selfCheckButton.disabled = true;
  if (els.chainStatusPanel) {
    els.chainStatusPanel.open = true;
  }
  renderSelfCheckPanel({
    level: "working",
    title: "正在自检",
    detail: "正在检查本地服务、扩展、绑定会话和协同规则。",
    nextStep: "请稍等"
  });

  try {
    await refreshWorkspaceSurface({ scrollToBottom: false });
    const result = selfCheckResult(state.status);
    renderSelfCheckPanel(result);
    showToast(result.title);
  } catch (error) {
    renderSelfCheckPanel({
      level: "blocked",
      title: "自检失败",
      detail: error.message || "本地服务暂时没有返回状态。",
      nextStep: "稍后重试"
    });
    showToast(error.message);
  } finally {
    els.selfCheckButton.disabled = false;
  }
}

function autoRouteLikelyNeedsGpt(text = "") {
  const value = String(text || "").trim();
  if (state.pendingFiles.length > 0) {
    return true;
  }

  const localExecution =
    /本地|项目|代码|源码|文件|目录|仓库|终端|命令|运行|测试|验证|调试|报错|错误|修复|修改|实现|接入|部署|构建|重构|安装|配置|提交|登录模块/i.test(value) ||
    /\b(local|repo|repository|code|file|directory|terminal|command|run|test|debug|fix|change|implement|build|refactor|install|deploy)\b/i.test(value);
  const gptWork =
    /生图|生成.{0,12}(图|图片|PPT|PowerPoint|Excel|xlsx|表格)|配图|海报|图标|logo|插画|视觉|设计|方案|文案|长文|小说|调研|头脑风暴|排版|审美|风格|素材/i.test(value) ||
    /\b(image|images|picture|photo|poster|icon|logo|illustration|design|copy|article|slides?|deck|spreadsheet|brainstorm|research|style)\b/i.test(value);

  return !(localExecution && !gptWork);
}

function targetsMayUseGpt(targets = [], text = "") {
  if (targets.includes("gpt")) return true;
  if (!targets.includes("auto")) return false;
  return autoRouteLikelyNeedsGpt(text || els.chatInput?.value || "");
}

function composerHasDraft() {
  return Boolean((els.chatInput?.value || "").trim() || state.pendingFiles.length > 0);
}

function workflowBlocksGptSend(workflowStatus = null, connection = null) {
  if (connection?.canSendToGpt === false) return true;
  if (!workflowStatus) return false;
  return ["setup", "blocked", "working"].includes(workflowStatus.level);
}

function workflowBlockMessage(workflowStatus = null, connection = null) {
  if (connection?.canSendToGpt === false) {
    const failedCheck = connection.checks?.find((check) => ["blocked", "working"].includes(check.state));
    const detail =
      failedCheck?.detail ||
      workflowStatus?.nextStep ||
      workflowStatus?.detail ||
      "请先确认绑定的 GPT 页面和 Bridge 扩展状态。";
    return `${connection.label || "GPT 暂时不可用"}：${detail}`;
  }
  const title = workflowStatus?.title || workflowStatus?.label || "GPT 暂时不可用";
  const nextStep = workflowStatus?.nextStep || workflowStatus?.detail || "请先确认绑定的 GPT 页面和 Bridge 扩展状态。";
  return `${title}：${nextStep}`;
}

async function loadGptPreflight() {
  const preflight = await api("/api/gpt/preflight");
  state.gptPreflight = preflight;
  if (preflight?.workflowStatus || preflight?.connection) {
    state.status = {
      ...(state.status || {}),
      workflowStatus: preflight.workflowStatus || state.status?.workflowStatus,
      connection: preflight.connection || state.status?.connection,
      extension: preflight.extension || state.status?.extension,
      activeSyncJob: preflight.activeSyncJob || state.status?.activeSyncJob
    };
    updateStatusLine(state.status);
  }
  return preflight;
}

function gptPreflightBlocksSend(preflight = null) {
  return preflight?.canSend === false;
}

function gptPreflightBlockMessage(preflight = null) {
  return (
    preflight?.message ||
    workflowBlockMessage(preflight?.workflowStatus, preflight?.connection) ||
    "GPT 暂时不可用，请先确认绑定页面和 Bridge 扩展状态。"
  );
}

async function ensureGptSendReady(targets = [], text = "") {
  if (!targetsMayUseGpt(targets, text)) return true;
  const preflight = await loadGptPreflight();
  if (gptPreflightBlocksSend(preflight)) {
    throw new Error(gptPreflightBlockMessage(preflight));
  }
  return true;
}

async function ensureGptActionReady() {
  return ensureGptSendReady(["gpt"]);
}

function currentGptActionBlockMessage(status = state.status) {
  const workflowStatus = status?.workflowStatus || null;
  const connection = status?.connection || null;
  return workflowBlocksGptSend(workflowStatus, connection) ? workflowBlockMessage(workflowStatus, connection) : "";
}

function syncGptActionControl(control) {
  const blockMessage = currentGptActionBlockMessage();
  const blocked = Boolean(blockMessage);
  control.dataset.gptBlocked = blocked ? "true" : "false";
  control.setAttribute("aria-disabled", blocked ? "true" : "false");

  if (blocked) {
    control.title = blockMessage;
  } else {
    const originalTitle = control.dataset.gptOriginalTitle || "";
    if (originalTitle) {
      control.title = originalTitle;
    } else {
      control.removeAttribute("title");
    }
  }
}

function syncGptActionControls() {
  document.querySelectorAll("[data-gpt-action-control]").forEach(syncGptActionControl);
}

function markGptActionControl(control) {
  control.dataset.gptActionControl = "true";
  control.dataset.gptOriginalTitle = control.title || "";
  control.addEventListener(
    "click",
    (event) => {
      const blockMessage = currentGptActionBlockMessage();
      if (!blockMessage) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      showToast(blockMessage);
    },
    { capture: true }
  );
  syncGptActionControl(control);
  return control;
}

function currentComposerBlockMessage() {
  const text = els.chatInput?.value || "";
  if (!text.trim() && state.pendingFiles.length === 0) return "";
  if (looksLikeQuestionMarkEncodingLoss(text)) return TEXT_ENCODING_LOSS_MESSAGE;
  if (!targetsMayUseGpt(composerTargets(), text)) return "";
  return currentGptActionBlockMessage();
}

function syncComposerSendControl() {
  const blockMessage = currentComposerBlockMessage();
  const blocked = Boolean(blockMessage);
  els.sendButton.dataset.composerBlocked = blocked ? "true" : "false";
  els.sendButton.setAttribute("aria-disabled", blocked ? "true" : "false");
  els.sendButton.title = blocked ? blockMessage : "";
  els.composerBox.dataset.composerBlocked = blocked ? "true" : "false";
  syncComposerBlockHint(blockMessage);
}

function syncComposerBlockHint(blockMessage = "") {
  if (!els.composerBlockHint) return;
  els.composerBlockHint.hidden = !blockMessage;
  els.composerBlockHint.textContent = blockMessage;
}

function updateStatusLine(status) {
  const workspace = status?.workspace || state.workspace || {};
  const extension = status?.extension || {};
  const heartbeat = extension.heartbeat || null;
  const connection = status?.connection || null;
  const dataCoverage = status ? status.dataCoverage || null : null;
  const routeCoverage = status?.routeCoverage || null;
  const preferenceStatus = preferenceStatusMatchesWorkspace(heartbeat?.preferenceStatus, workspace) ? heartbeat?.preferenceStatus : null;
  els.bindingState.textContent = workspace.chatgptProjectUrl ? "GPT 已绑定" : "GPT 未绑定";
  els.bindingState.className = workspace.chatgptProjectUrl ? "status-pill is-ok" : "status-pill";
  const connectionLevel = connectionChipLevel(status);
  els.syncModeText.textContent = connectionChipLabel(status);
  els.syncModeText.className =
    connectionLevel === "ok"
      ? "status-pill is-ok"
      : connectionLevel === "working"
        ? "status-pill is-working"
        : connectionLevel === "error"
          ? "status-pill is-error"
          : "status-pill";
  const routingRules = routingRuleLabel(workspace);
  els.routingRuleState.textContent = routingRules.label;
  els.routingRuleState.className = routingRules.className;
  els.routingRuleState.title = routingRules.title;
  const dataCoverageLabel = dataCoverage ? dataCoverage.label : "";
  const routeCoverageLabel = routeCoverage ? routeCoverage.label : "";
  els.syncModeText.title = [connection?.label, dataCoverageLabel, routeCoverageLabel].filter(Boolean).join(" · ");
  renderWorkflowStatus(status);
  const selfCheck = selfCheckResult(status);
  if (els.selfCheckButton) {
    els.selfCheckButton.dataset.level = selfCheck.level || "ready";
    els.selfCheckButton.title = `一键自检：${selfCheck.title}`;
    els.selfCheckButton.hidden = selfCheck.level === "ready";
  }
  if (els.selfCheckPanel && !els.selfCheckPanel.hidden) {
    renderSelfCheckPanel(selfCheck);
  }
  renderChainStatusPanel();
  els.outputSummary.textContent = `${state.artifacts.length} 个文件`;
  syncGptActionControls();
  syncComposerSendControl();
}

function updateSettingsFields() {
  const workspace = state.workspace || {};
  els.settingsProjectUrlInput.value = displayProjectConversationUrl(
    workspace.chatgptProjectUrl || state.activeProject?.chatgptProjectUrl || ""
  );
  els.settingsTargetRepoInput.value = workspace.targetRepo || state.activeProject?.targetRepo || "";
}

function renderPlainText(text) {
  const wrapper = document.createElement("div");
  wrapper.className = "rich-text";
  const paragraphs = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) {
    const p = document.createElement("p");
    p.textContent = "";
    wrapper.append(p);
    return wrapper;
  }

  for (const paragraph of paragraphs) {
    const p = document.createElement("p");
    p.textContent = paragraph;
    wrapper.append(p);
  }
  return wrapper;
}

function renderLongText(text, key = longTextKey("message", 0, text)) {
  const card = document.createElement("div");
  card.className = "document-preview";
  if (state.expandedLongTextKeys.has(key)) {
    card.classList.add("is-expanded");
  }

  const header = document.createElement("div");
  header.className = "document-preview-header";
  const title = document.createElement("strong");
  title.textContent = text.split(/\r?\n/).find((line) => line.trim())?.replace(/^#+\s*/, "") || "长文";
  const actions = document.createElement("div");
  actions.className = "inline-actions";
  actions.append(
    createButton("复制", "ghost-button", async () => {
      await navigator.clipboard?.writeText(text);
      showToast("已复制");
    }),
    createButton("展开", "ghost-button", () => {
      clearBottomScrollSettle();
      markLongTextReadingIntent();
      const willExpand = !state.expandedLongTextKeys.has(key);
      if (willExpand) {
        state.expandedLongTextKeys.add(key);
      } else {
        state.expandedLongTextKeys.delete(key);
        state.longTextScrollPositions.delete(key);
        body.scrollTop = 0;
      }
      card.classList.toggle("is-expanded", willExpand);
      if (willExpand) {
        restoreLongTextScroll(key, body);
      }
      actions.lastElementChild.textContent = willExpand ? "收起" : "展开";
    })
  );
  actions.lastElementChild.textContent = state.expandedLongTextKeys.has(key) ? "收起" : "展开";
  header.append(title, actions);

  const body = document.createElement("div");
  body.className = "document-preview-body";
  body.addEventListener(
    "scroll",
    () => {
      clearBottomScrollSettle();
      markLongTextReadingIntent();
      rememberLongTextScroll(key, body);
    },
    { passive: true }
  );
  body.append(renderPlainText(text));
  restoreLongTextScroll(key, body);
  card.append(header, body);
  return card;
}

function renderCodeBlock(language, code) {
  const block = document.createElement("section");
  block.className = "code-block";

  const header = document.createElement("header");
  const lang = document.createElement("span");
  lang.textContent = language || "代码";
  const copy = createButton("复制", "code-copy", async () => {
    await navigator.clipboard?.writeText(code);
    showToast("代码已复制");
  });
  header.append(lang, copy);

  const pre = document.createElement("pre");
  const codeNode = document.createElement("code");
  codeNode.textContent = code;
  pre.append(codeNode);
  block.append(header, pre);
  return block;
}

function renderCodeBlocks(text = "", baseKey = "message") {
  const fragment = document.createDocumentFragment();
  const regex = /```([A-Za-z0-9_-]*)\s*\n([\s\S]*?)```/g;
  let cursor = 0;
  let match;
  let longIndex = 0;

  while ((match = regex.exec(text))) {
    const before = text.slice(cursor, match.index).trim();
    if (before) {
      fragment.append(
        before.length > 1200 ? renderLongText(before, longTextKey(baseKey, longIndex++, before)) : renderPlainText(before)
      );
    }
    fragment.append(renderCodeBlock(match[1], match[2].trimEnd()));
    cursor = match.index + match[0].length;
  }

  const rest = text.slice(cursor).trim();
  if (rest) {
    fragment.append(
      rest.length > 1200 ? renderLongText(rest, longTextKey(baseKey, longIndex++, rest)) : renderPlainText(rest)
    );
  }

  if (!fragment.childNodes.length) {
    fragment.append(renderPlainText(text));
  }
  return fragment;
}

function renderImagePreviewDialog(artifacts, index = 0) {
  const images = (Array.isArray(artifacts) ? artifacts : [artifacts]).filter(Boolean);
  if (!images.length) return;
  const safeIndex = Math.min(Math.max(Number(index) || 0, 0), images.length - 1);
  const artifact = images[safeIndex];

  state.imagePreviewArtifacts = images;
  state.imagePreviewIndex = safeIndex;
  els.imagePreviewTitle.textContent = artifact.filename || "图片";
  els.imagePreviewCounter.textContent = images.length > 1 ? `${safeIndex + 1}/${images.length}` : "";
  els.imagePreview.src = artifactDownloadUrl(artifact);
  els.imagePreview.alt = artifact.filename || "图片预览";
  if (els.imagePreviewDownloadButton) {
    els.imagePreviewDownloadButton.disabled = false;
  }
  els.imagePreviewPrev.hidden = images.length < 2;
  els.imagePreviewNext.hidden = images.length < 2;
  syncImagePreviewSelection(safeIndex, artifact);
}

function syncImagePreviewSelection(safeIndex, artifact) {
  if (typeof state.imagePreviewOnChange === "function") {
    state.imagePreviewOnChange(safeIndex, artifact);
  }
}

function moveImagePreview(delta) {
  const images = state.imagePreviewArtifacts || [];
  if (images.length < 2) return;
  const nextIndex = (state.imagePreviewIndex + delta + images.length) % images.length;
  renderImagePreviewDialog(images, nextIndex);
}

function openImagePreview(artifacts, index = 0) {
  const options = arguments[2] || {};
  state.imagePreviewOnChange = typeof options.onChange === "function" ? options.onChange : null;
  renderImagePreviewDialog(artifacts, index);
  els.imageDialog.showModal();
}

function renderImageGrid(artifacts = []) {
  const images = artifacts.filter(Boolean);
  if (images.length === 0) return null;

  if (images.length === 1) {
    const artifact = images[0];
    const figure = document.createElement("figure");
    figure.className = "image-card";
    const img = document.createElement("img");
    img.src = artifactDownloadUrl(artifact);
    img.alt = artifact.filename || "GPT 生成图片";
    img.addEventListener("click", () => openImagePreview(artifact));

    const overlay = document.createElement("figcaption");
    const name = document.createElement("span");
    name.textContent = compactText(artifact.filename || "图片", 48);
    overlay.append(name, createImageActions(artifact));
    figure.append(img, overlay);
    return figure;
  }

  const galleryKey = images.map((artifact) => artifact.id || artifact.filename || "").join("|");
  const rememberedIndex = Number(state.imageGallerySelection.get(galleryKey));
  const initialIndex = Number.isInteger(rememberedIndex)
    ? Math.min(Math.max(rememberedIndex, 0), images.length - 1)
    : 0;
  const gallery = document.createElement("div");
  gallery.className = "image-gallery";
  gallery.dataset.imageCount = String(images.length);
  const main = document.createElement("figure");
  main.className = "image-gallery-main";
  const mainImage = document.createElement("img");
  const mainCounter = document.createElement("span");
  mainCounter.className = "image-gallery-count";
  const mainCaption = document.createElement("figcaption");
  const mainLabel = document.createElement("span");
  mainLabel.className = "image-gallery-label";
  const mainName = document.createElement("span");
  const mainActions = createImageActions(images[0]);
  mainLabel.append(mainCounter, mainName);
  mainCaption.append(mainLabel, mainActions);
  main.append(mainImage, mainCaption);

  const railShell = document.createElement("aside");
  railShell.className = "image-gallery-strip";
  const railHeader = document.createElement("div");
  railHeader.className = "image-gallery-strip-header";
  railHeader.textContent = `${images.length} 张图片`;
  const rail = document.createElement("div");
  rail.className = "image-gallery-rail";

  function setActive(artifact, thumb, index = 0) {
    state.imageGallerySelection.set(galleryKey, index);
    mainImage.src = artifactDownloadUrl(artifact);
    mainImage.alt = artifact.filename || "GPT 生成图片";
    mainName.textContent = compactText(artifact.filename || "图片", 54);
    mainCounter.textContent = `${index + 1}/${images.length}`;
    setImageGalleryActionArtifacts(mainActions, images, index, {
      onChange: (nextIndex) => setActive(images[nextIndex], thumbs[nextIndex], nextIndex)
    });
    mainImage.onclick = () =>
      openImagePreview(images, index, {
        onChange: (nextIndex) => setActive(images[nextIndex], thumbs[nextIndex], nextIndex)
      });
    rail.querySelectorAll("button").forEach((button) => button.classList.remove("is-active"));
    thumb?.classList.add("is-active");
  }

  const thumbs = [];
  images.forEach((artifact, index) => {
    const thumb = document.createElement("button");
    thumb.type = "button";
    thumb.className = "image-thumb";
    thumb.setAttribute("aria-label", `查看第 ${index + 1} 张图片`);
    thumb.title = `查看第 ${index + 1} 张图片`;
    const img = document.createElement("img");
    img.src = artifactDownloadUrl(artifact);
    img.alt = artifact.filename || `图片 ${index + 1}`;
    thumb.append(img);
    thumb.addEventListener("click", () => setActive(artifact, thumb, index));
    rail.append(thumb);
    thumbs.push(thumb);
  });
  setActive(images[initialIndex], thumbs[initialIndex], initialIndex);

  railShell.append(railHeader, rail);
  gallery.append(main, railShell);
  if (initialIndex > 0) {
    const restoredScrollTop = Math.max(0, initialIndex * 84 - 16);
    rail.scrollTop = restoredScrollTop;
    window.requestAnimationFrame(() => {
      rail.scrollTop = restoredScrollTop;
    });
  }
  return gallery;
}

async function loadArtifactPreview(artifactId, options = {}) {
  const full = Boolean(options.full);
  const cacheKey = `${artifactId}:${full ? "full" : "compact"}`;
  if (state.previewCache.has(cacheKey)) {
    return state.previewCache.get(cacheKey);
  }

  const previewPromise = api(`/api/artifacts/${encodeURIComponent(artifactId)}/preview${full ? "?full=1" : ""}`).catch((error) => {
    state.previewCache.delete(cacheKey);
    throw error;
  });
  state.previewCache.set(cacheKey, previewPromise);
  return previewPromise;
}

function renderPreviewScopeNote() {
  const note = document.createElement("p");
  note.className = "file-preview-meta file-preview-scope-note";
  note.textContent = "Bridge 只展示摘要/节选，完整文件已交给 GPT；需要细看时请放大或下载查看。";
  return note;
}

function previewReaderSummary(preview) {
  const details = preview.preview || {};
  if (preview.kind === "spreadsheet") {
    return `${details.rowCount || 0} rows / ${details.columnCount || 0} columns`;
  }
  if (preview.kind === "presentation") {
    return `${details.slideCount || 0} slides`;
  }
  if (preview.kind === "document") {
    return `${details.paragraphCount || 0} paragraphs`;
  }
  if (preview.kind === "archive") {
    return `${details.entryCount || 0} items`;
  }
  if (preview.kind === "pdf") {
    return `${details.pageCount || 0} pages`;
  }
  return "Full preview";
}

function renderPreviewReader(preview, body, options = {}) {
  if (options.compact) return body;

  const reader = document.createElement("section");
  reader.className = `preview-reader preview-reader-${preview.kind}`;

  const toolbar = document.createElement("div");
  toolbar.className = "preview-reader-toolbar";
  const title = document.createElement("strong");
  title.textContent = preview.title || preview.artifact?.filename || "File preview";
  const summary = document.createElement("span");
  summary.textContent = previewReaderSummary(preview);
  toolbar.append(title, summary);

  const bodyWrap = document.createElement("div");
  bodyWrap.className = "preview-reader-body";
  bodyWrap.append(body);

  reader.append(toolbar, bodyWrap);
  return reader;
}

function renderSpreadsheetPreview(preview, options = {}) {
  const wrap = document.createElement("div");
  wrap.className = "sheet-preview";
  const tableScroll = document.createElement("div");
  tableScroll.className = "sheet-preview-scroll";
  tableScroll.tabIndex = 0;
  const table = document.createElement("table");
  table.className = "sheet-preview-table";
  const rows = preview.preview?.rows || [];

  rows.forEach((row, rowIndex) => {
    const tr = document.createElement("tr");
    row.forEach((cell) => {
      const node = document.createElement(rowIndex === 0 ? "th" : "td");
      node.textContent = cell;
      tr.append(node);
    });
    table.append(tr);
  });

  const meta = document.createElement("p");
  meta.className = "file-preview-meta";
  meta.textContent = `${preview.preview?.rowCount || rows.length} 行 · ${preview.preview?.columnCount || 0} 列`;
  tableScroll.append(table);
  wrap.append(tableScroll, meta);
  if (preview.preview?.truncated) {
    wrap.append(renderPreviewScopeNote());
  }
  return renderPreviewReader(preview, wrap, options);
}

function renderPresentationPreview(preview, options = {}) {
  const wrap = document.createElement("div");
  wrap.className = ["presentation-preview", options.compact ? "is-compact" : "is-expanded"].join(" ");
  const slides = preview.preview?.slides || [];
  const visibleSlides = options.compact ? slides.slice(0, 1) : slides;
  for (const slide of visibleSlides) {
    const item = document.createElement("section");
    item.className = "presentation-slide-frame";
    const canvas = document.createElement("div");
    canvas.className = "presentation-slide-canvas";
    const index = document.createElement("span");
    index.className = "presentation-slide-index";
    index.textContent = `${slide.index}`;
    const title = document.createElement("strong");
    title.textContent = slide.title || `第 ${slide.index} 页`;
    const body = document.createElement("p");
    body.textContent = slide.body || "这一页没有提取到正文。";
    canvas.append(index, title, body);
    item.append(canvas);
    wrap.append(item);
  }
  const meta = document.createElement("p");
  meta.className = "file-preview-meta";
  const slideCount = preview.preview?.slideCount || slides.length;
  meta.textContent = options.compact && slideCount > 1 ? `${slideCount} 页 · 放大查看全部` : `${slideCount} 页`;
  wrap.append(meta);
  if (preview.preview?.truncated) {
    wrap.append(renderPreviewScopeNote());
  }
  return wrap;
}

function textPreviewLanguage(preview) {
  const extension = artifactExtension(preview.artifact || {});
  const languages = {
    txt: "TXT",
    md: "Markdown",
    json: "JSON",
    html: "HTML",
    css: "CSS",
    js: "JavaScript",
    ts: "TypeScript",
    py: "Python",
    csv: "CSV",
    log: "Log",
    xml: "XML",
    yaml: "YAML",
    yml: "YAML"
  };
  return languages[extension] || "文本";
}

function formatTextPreview(preview) {
  const text = preview.preview?.truncated
    ? `${preview.preview.text}\n\n[内容过长，已截断显示]`
    : preview.preview?.text || "";
  if (artifactExtension(preview.artifact || {}) !== "json") return text;

  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function isLongformTextPreview(preview) {
  const extension = artifactExtension(preview.artifact || {});
  const contentType = (preview.artifact?.contentType || "").toLowerCase();
  return ["txt", "md"].includes(extension) || contentType.includes("markdown");
}

function longformTitle(preview, text) {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const title = firstLine?.replace(/^#{1,6}\s*/, "") || preview.title || preview.artifact?.filename || "长文";
  return compactText(title, 72);
}

function longformStats(preview, text) {
  const charCount = preview.preview?.charCount || text.length;
  const lineCount = preview.preview?.lineCount || text.split(/\r?\n/).length;
  const extension = artifactExtension(preview.artifact || {});
  const type = extension === "md" ? "Markdown" : "长文";
  const suffix = preview.preview?.truncated ? " · 已截断" : "";
  return `${type} · ${charCount} 字符 · ${lineCount} 行${suffix}`;
}

function renderPlainLongform(text) {
  const body = document.createElement("div");
  body.className = "longform-reader-body";
  const blocks = text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  for (const block of blocks) {
    const paragraph = document.createElement("p");
    paragraph.textContent = block;
    body.append(paragraph);
  }
  return body;
}

function renderMarkdownLongform(text) {
  const body = document.createElement("div");
  body.className = "longform-reader-body";
  const blocks = text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);

  for (const block of blocks) {
    const codeBlock = block.match(/^```([A-Za-z0-9_-]*)\s*\n([\s\S]*?)```$/);
    if (codeBlock) {
      body.append(renderCodeBlock(codeBlock[1], codeBlock[2].trimEnd()));
      continue;
    }

    const heading = block.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 4);
      const node = document.createElement(`h${level}`);
      node.textContent = heading[2].trim();
      body.append(node);
      continue;
    }

    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length && lines.every((line) => /^[-*]\s+/.test(line))) {
      const list = document.createElement("ul");
      for (const line of lines) {
        const item = document.createElement("li");
        item.textContent = line.replace(/^[-*]\s+/, "");
        list.append(item);
      }
      body.append(list);
      continue;
    }

    if (lines.length && lines.every((line) => /^\d+\.\s+/.test(line))) {
      const list = document.createElement("ol");
      for (const line of lines) {
        const item = document.createElement("li");
        item.textContent = line.replace(/^\d+\.\s+/, "");
        list.append(item);
      }
      body.append(list);
      continue;
    }

    if (lines.length && lines.every((line) => /^>\s?/.test(line))) {
      const quote = document.createElement("blockquote");
      quote.textContent = lines.map((line) => line.replace(/^>\s?/, "")).join("\n");
      body.append(quote);
      continue;
    }

    const paragraph = document.createElement("p");
    paragraph.textContent = block;
    body.append(paragraph);
  }

  return body;
}

function renderLongformTextPreview(preview) {
  const text = formatTextPreview(preview);
  const wrap = document.createElement("article");
  wrap.className = "longform-preview";

  const header = document.createElement("header");
  header.className = "longform-preview-header";
  const title = document.createElement("div");
  title.className = "longform-preview-title";
  const heading = document.createElement("strong");
  heading.textContent = longformTitle(preview, text);
  const meta = document.createElement("small");
  meta.textContent = longformStats(preview, text);
  title.append(heading, meta);
  const copy = createButton("复制", "ghost-button", async () => {
    await navigator.clipboard?.writeText(text);
    showToast("长文已复制");
  });
  header.append(title, copy);

  const extension = artifactExtension(preview.artifact || {});
  const body = extension === "md" ? renderMarkdownLongform(text) : renderPlainLongform(text);
  wrap.append(header);
  if (preview.preview?.truncated) {
    wrap.append(renderPreviewScopeNote());
  }
  wrap.append(body);
  return wrap;
}

function renderTextPreview(preview) {
  if (isLongformTextPreview(preview)) {
    return renderLongformTextPreview(preview);
  }

  const text = formatTextPreview(preview);
  const wrap = document.createElement("section");
  wrap.className = "code-file-preview";

  const header = document.createElement("header");
  header.className = "code-file-preview-header";
  const title = document.createElement("div");
  title.className = "code-file-title";
  const language = document.createElement("span");
  language.textContent = textPreviewLanguage(preview);
  const filename = document.createElement("small");
  filename.textContent = preview.title || preview.artifact?.filename || "文本文件";
  title.append(language, filename);
  const copy = createButton("复制", "code-copy", async () => {
    await navigator.clipboard?.writeText(text);
    showToast("内容已复制");
  });
  header.append(title, copy);

  const pre = document.createElement("pre");
  pre.className = "text-preview";
  const code = document.createElement("code");
  code.textContent = text;
  pre.append(code);
  wrap.append(header, pre);
  if (preview.preview?.truncated) {
    wrap.append(renderPreviewScopeNote());
  }
  return wrap;
}

function renderPdfPreview(preview) {
  const wrap = document.createElement("div");
  wrap.className = "pdf-preview";
  const artifact = preview.artifact;
  if (artifact?.id) {
    const frame = document.createElement("iframe");
    frame.src = `${artifactViewUrl(artifact)}#toolbar=0&navpanes=0&view=FitH`;
    frame.title = preview.title || artifact.filename || "PDF 预览";
    frame.loading = "lazy";
    wrap.append(frame);
  }

  const meta = document.createElement("p");
  meta.className = "file-preview-meta";
  const pageCount = preview.preview?.pageCount || 0;
  meta.textContent = pageCount > 0 ? `${pageCount} 页 · 可放大查看` : "PDF 已捕获，可放大查看或下载。";
  wrap.append(meta);
  return wrap;
}

function renderDocumentPreview(preview, options = {}) {
  const wrap = document.createElement("div");
  wrap.className = "document-preview";
  const body = document.createElement("div");
  body.className = "document-preview-body";
  const paragraphs = preview.preview?.paragraphs || [];

  if (paragraphs.length === 0) {
    const empty = document.createElement("p");
    empty.className = "file-preview-meta";
    empty.textContent = "这个 Word 文档暂时没有提取到正文。";
    body.append(empty);
  } else {
    for (const paragraph of paragraphs) {
      const item = document.createElement("p");
      item.textContent = paragraph;
      body.append(item);
    }
  }
  wrap.append(body);

  const meta = document.createElement("p");
  meta.className = "file-preview-meta";
  const suffix = preview.preview?.truncated ? " · 已截断显示" : "";
  meta.textContent = `${preview.preview?.paragraphCount || paragraphs.length} 段${suffix}`;
  wrap.append(meta);
  if (preview.preview?.truncated) {
    wrap.append(renderPreviewScopeNote());
  }
  return renderPreviewReader(preview, wrap, options);
}

function renderArchivePreview(preview, options = {}) {
  const wrap = document.createElement("div");
  wrap.className = "archive-preview";
  const entries = preview.preview?.entries || [];
  const list = document.createElement("div");
  list.className = "archive-entry-list";

  if (!options.compact && entries.length > 8) {
    const filter = document.createElement("input");
    filter.className = "archive-filter-input";
    filter.type = "search";
    filter.placeholder = "Filter filenames";
    filter.addEventListener("input", () => {
      const query = filter.value.trim().toLowerCase();
      for (const item of list.querySelectorAll(".archive-entry")) {
        const name = item.dataset.entryName || "";
        item.hidden = Boolean(query) && !name.includes(query);
      }
    });
    wrap.append(filter);
  }

  for (const entry of entries) {
    const item = document.createElement("div");
    item.className = "archive-entry";
    item.dataset.entryName = String(entry.name || "").toLowerCase();
    const name = document.createElement("span");
    name.textContent = entry.directory ? `${entry.name}/`.replace(/\/+$/, "/") : entry.name;
    const size = document.createElement("span");
    size.textContent = entry.directory ? "文件夹" : formatBytes(entry.size || 0);
    item.append(name, size);
    list.append(item);
  }

  const meta = document.createElement("p");
  meta.className = "file-preview-meta";
  const suffix = preview.preview?.truncated ? " · 仅显示前 50 项" : "";
  meta.textContent = `${preview.preview?.entryCount || entries.length} 个条目${suffix}`;
  wrap.append(list, meta);
  if (preview.preview?.truncated) {
    wrap.append(renderPreviewScopeNote());
  }
  return renderPreviewReader(preview, wrap, options);
}

function renderPsdPreview(preview) {
  const wrap = document.createElement("div");
  wrap.className = "psd-preview";
  const details = preview.preview || {};
  if (!details.readable) {
    const message = document.createElement("p");
    message.className = "file-preview-meta";
    message.textContent = details.message || "PSD 已捕获，但无法读取头信息。";
    wrap.append(message);
    return wrap;
  }

  const grid = document.createElement("dl");
  grid.className = "psd-preview-grid";
  const rows = [
    ["尺寸", `${details.width} x ${details.height}`],
    ["颜色", details.colorMode],
    ["通道", `${details.channels}`],
    ["位深", `${details.depth} bit`],
    ["版本", `${details.version}`]
  ];

  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    grid.append(dt, dd);
  }

  const meta = document.createElement("p");
  meta.className = "file-preview-meta";
  meta.textContent = "PSD 图层内容需要在 Photoshop 等设计软件中打开。";
  wrap.append(grid, meta);
  return wrap;
}

function renderArtifactPreviewContent(preview, options = {}) {
  if (preview.kind === "spreadsheet") return renderSpreadsheetPreview(preview, options);
  if (preview.kind === "presentation") return renderPresentationPreview(preview, options);
  if (preview.kind === "pdf") return renderPdfPreview(preview);
  if (preview.kind === "document") return renderDocumentPreview(preview, options);
  if (preview.kind === "archive") return renderArchivePreview(preview, options);
  if (preview.kind === "psd") return renderPsdPreview(preview);
  if (preview.kind === "text") {
    return renderTextPreview(preview);
  }

  const fallback = document.createElement("p");
  fallback.className = "file-preview-meta";
  fallback.textContent = preview.preview?.message || "文件已捕获，Codex 后续处理可直接读取。";
  return fallback;
}

function formatPreviewAsText(preview) {
  if (preview.kind === "spreadsheet") {
    const rows = preview.preview?.rows || [];
    const table = rows.map((row) => row.join("\t")).join("\n");
    return [`${preview.title}`, `${preview.preview?.rowCount || rows.length} 行`, "", table].join("\n");
  }

  if (preview.kind === "presentation") {
    const slides = preview.preview?.slides || [];
    const body = slides
      .map((slide) => [`第 ${slide.index} 页：${slide.title}`, slide.body].filter(Boolean).join("\n"))
      .join("\n\n");
    return [`${preview.title}`, `${preview.preview?.slideCount || slides.length} 页`, "", body].join("\n");
  }

  if (preview.kind === "text") {
    return preview.preview?.truncated
      ? `${preview.preview.text}\n\n[内容过长，已截断显示]`
      : preview.preview?.text || "";
  }

  if (preview.kind === "document") {
    return (preview.preview?.paragraphs || []).join("\n\n");
  }

  if (preview.kind === "archive") {
    return (preview.preview?.entries || [])
      .map((entry) => `${entry.directory ? "目录" : "文件"}\t${entry.name}\t${formatBytes(entry.size || 0)}`)
      .join("\n");
  }

  if (preview.kind === "psd") {
    const details = preview.preview || {};
    return details.readable
      ? `${details.width} x ${details.height}\n${details.colorMode}\n${details.channels} 通道\n${details.depth} bit`
      : details.message || "PSD 已捕获。";
  }

  if (preview.kind === "pdf") {
    const pageCount = preview.preview?.pageCount || 0;
    return pageCount > 0 ? `${preview.title}\n${pageCount} 页` : `${preview.title}\nPDF 已捕获。`;
  }

  return preview.preview?.message || "文件已捕获，Codex 后续处理可直接读取。";
}

function renderArtifactPreviewShell(artifact) {
  const shell = document.createElement("div");
  shell.className = "file-preview-shell is-loading";
  shell.textContent = "正在读取预览...";

  loadArtifactPreview(artifact.id)
    .then((preview) => {
      shell.classList.remove("is-loading");
      shell.replaceChildren(renderArtifactPreviewContent(preview, { compact: true }));
    })
    .catch((error) => {
      shell.classList.remove("is-loading");
      shell.classList.add("is-unavailable");
      shell.textContent = error.message || "预览读取失败，仍可下载文件。";
    });

  return shell;
}

function stablePreviewKey(artifact = {}) {
  return [
    artifact.id || "",
    artifact.filename || "",
    artifact.sizeBytes || "",
    artifact.createdAt || ""
  ].join(":");
}

function renderStableArtifactPreviewShell(artifact) {
  const key = stablePreviewKey(artifact);
  if (key && state.stablePreviewNodes.has(key)) {
    return state.stablePreviewNodes.get(key);
  }

  const shell = renderArtifactPreviewShell(artifact);
  if (key) {
    state.stablePreviewNodes.set(key, shell);
  }
  return shell;
}

function collectStablePreviewKeys(messages = []) {
  const keys = new Set();
  for (const message of messages) {
    const metadata = message.metadata || {};
    const artifactIds = [
      ...(Array.isArray(metadata.artifactIds) ? metadata.artifactIds : []),
      ...(Array.isArray(metadata.inputArtifactIds) ? metadata.inputArtifactIds : [])
    ];
    for (const artifactId of artifactIds) {
      const artifact = state.artifactCache.get(artifactId);
      if (artifact && canInlinePreviewArtifact(artifact)) {
        keys.add(stablePreviewKey(artifact));
      }
    }
  }
  return keys;
}

function pruneStablePreviewNodes(visiblePreviewKeys) {
  for (const key of state.stablePreviewNodes.keys()) {
    if (!visiblePreviewKeys.has(key)) {
      state.stablePreviewNodes.delete(key);
    }
  }
}

function renderFileCard(artifact, options = {}) {
  const card = document.createElement("article");
  card.className = [
    "file-card",
    options.compact ? "is-compact" : "",
    options.context === "message" ? "is-message-artifact" : ""
  ]
    .filter(Boolean)
    .join(" ");

  const icon = document.createElement("span");
  icon.className = `file-icon file-${artifactKind(artifact).toLowerCase()}`;
  icon.textContent = artifactInitial(artifact);

  const info = document.createElement("div");
  info.className = "file-info";
  const title = document.createElement("strong");
  title.textContent = compactText(artifact.filename || "未命名文件", 72);
  title.title = artifact.filename || "";
  const meta = document.createElement("small");
  meta.textContent = `${artifactKind(artifact)} / ${formatBytes(artifact.sizeBytes)} / ${formatTime(artifact.createdAt)}`;
  info.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "file-actions";
  actions.append(createIconDownloadButton(artifact));
  if (canPreviewArtifact(artifact)) {
    actions.append(createIconButton("放大", "expand", () => previewArtifact(artifact.id)));
  }

  card.append(icon, info);
  if (actions.childElementCount > 0) {
    card.append(actions);
  }
  if (!options.compact && canInlinePreviewArtifact(artifact)) {
    card.append(options.context === "message" ? renderStableArtifactPreviewShell(artifact) : renderArtifactPreviewShell(artifact));
  }
  return card;
}

function renderArtifactErrors(errors = []) {
  if (!errors.length) return null;
  const wrap = document.createElement("div");
  wrap.className = "artifact-errors";
  for (const error of errors) {
    const item = document.createElement("div");
    item.className = "artifact-error";
    const filename = error.filename || "未知文件";
    item.textContent =
      error.code === "missing_download"
        ? `GPT 提到了 ${filename}，但没有抓到真实可下载文件。需要在 GPT 页面重新生成或手动下载。`
        : `${filename} 获取失败：${error.error || "未知错误"}`;
    wrap.append(item);
  }
  return wrap;
}

function renderMessageArtifacts(message) {
  const metadata = message.metadata || {};
  const outputArtifactIds = Array.isArray(metadata.artifactIds) ? metadata.artifactIds : [];
  const inputArtifactIds = Array.isArray(metadata.inputArtifactIds) ? metadata.inputArtifactIds : [];
  const artifactIds = [...new Set([...outputArtifactIds, ...inputArtifactIds])];
  const artifacts = artifactIds.map((id) => state.artifactCache.get(id)).filter(Boolean);
  const images = artifacts.filter(isImageArtifact);
  const files = artifacts.filter((artifact) => !isImageArtifact(artifact));
  const errors = Array.isArray(metadata.artifactErrors) ? metadata.artifactErrors : [];

  if (images.length === 0 && files.length === 0 && errors.length === 0) return null;

  const wrap = document.createElement("div");
  wrap.className = "message-attachments";
  const imageGrid = renderImageGrid(images);
  if (imageGrid) wrap.append(imageGrid);
  for (const artifact of files) {
    wrap.append(renderFileCard(artifact, { compact: false, context: "message" }));
  }
  const errorBlock = renderArtifactErrors(errors);
  if (errorBlock) wrap.append(errorBlock);
  return wrap;
}

function syncArtifactSummary(metadata = {}) {
  const count = Number(metadata.syncInputArtifactCount || 0);
  if (count <= 0) return "";
  const names = Array.isArray(metadata.syncInputArtifactNames) ? metadata.syncInputArtifactNames.filter(Boolean) : [];
  if (names.length === 1) return names[0];
  return `${count} 个附件`;
}

function syncStatusSummary(metadata = {}, progress = null) {
  const artifactText = syncArtifactSummary(metadata);
  const normalizedReason = friendlySyncStatusReason(metadata.syncReason, metadata.syncStatus);
  const base =
    progress?.shortLabel ||
    (metadata.syncStatus === "pending"
      ? "等待 GPT 接收"
      : metadata.syncStatus === "running"
        ? "等待 GPT 回复"
        : metadata.syncStatus === "succeeded"
          ? "同步完成"
          : "同步失败");
  const action = normalizeVisibleGptText(
    progress?.message ||
    (metadata.syncStatus === "succeeded" && artifactText
      ? `GPT 已分析 ${artifactText}`
      : normalizedReason || base)
  );
  const durationText = formatSyncProgressDuration(progress);
  return durationText ? `${action} · ${durationText}` : action;
}

function appendSyncDetailItem(parent, label, value, className = "") {
  if (!value) return;
  const item = document.createElement("div");
  item.className = `message-status-item${className ? ` ${className}` : ""}`;
  const title = document.createElement("span");
  title.textContent = label;
  const detail = document.createElement("strong");
  detail.className = "message-status-value";
  detail.textContent = value;
  item.append(title, detail);
  parent.append(item);
}

function renderSyncTimeline(progress = null) {
  const timeline = progress?.timeline || {};
  const rows = [
    ["创建", timeline.createdAt],
    ["领取", timeline.claimedAt],
    ["发给 GPT", timeline.sentAt],
    ["完成", timeline.completedAt]
  ].filter(([, value]) => value);
  if (!rows.length) return null;

  const list = document.createElement("div");
  list.className = "message-status-timeline";
  for (const [label, value] of rows) {
    const row = document.createElement("span");
    row.textContent = `${label} ${formatMessageTime(value)}`;
    list.append(row);
  }
  return list;
}

function renderSyncStatusDetail(metadata = {}, progress = null) {
  const detail = document.createElement("div");
  detail.className = "message-status-detail";
  const grid = document.createElement("div");
  grid.className = "message-status-grid";
  const artifactText = syncArtifactSummary(metadata) || "无";
  const normalizedReason = friendlySyncStatusReason(metadata.syncReason, metadata.syncStatus);

  appendSyncDetailItem(grid, "阶段", progress?.label || metadata.syncStatus);
  appendSyncDetailItem(grid, "附件", artifactText);
  appendSyncDetailItem(grid, "耗时", formatSyncProgressDuration(progress) || "未完成");
  appendSyncDetailItem(grid, "状态", normalizedReason || normalizeVisibleGptText(progress?.message) || "正常");
  detail.append(grid);

  const timeline = renderSyncTimeline(progress);
  if (timeline) detail.append(timeline);
  return detail;
}

function renderMessageStatus(message) {
  const metadata = message.metadata || {};
  if (!metadata.syncStatus || !Array.isArray(message.to) || !message.to.includes("gpt")) return null;
  if (!["pending", "running", "failed", "succeeded"].includes(metadata.syncStatus)) return null;

  const status = document.createElement("details");
  status.className = `message-status message-status-strip is-${metadata.syncStatus}`;
  const summary = document.createElement("summary");
  summary.className = "message-status-summary";
  const dot = document.createElement("span");
  dot.className = "message-status-dot";
  const text = document.createElement("span");
  const progress = metadata.syncProgress || null;
  const normalizedReason = friendlySyncStatusReason(metadata.syncReason, metadata.syncStatus);
  text.textContent = syncStatusSummary({ ...metadata, syncReason: normalizedReason || metadata.syncReason }, progress);
  summary.append(dot, text);
  status.append(summary, renderSyncStatusDetail(metadata, progress));
  return status;
}

function renderSyncActions(message) {
  const metadata = message.metadata || {};
  if (!metadata.syncJobId || (!metadata.syncCanRetry && !metadata.syncCanCancel)) return null;

  const actions = document.createElement("div");
  actions.className = "message-actions";
  if (metadata.syncCanCancel) {
    const cancelButton = createButton("停止", "button-like message-action-button", () => cancelSyncJob(metadata.syncJobId));
    cancelButton.setAttribute("data-sync-cancel-control", metadata.syncJobId);
    if (state.cancellingSyncJobIds.has(metadata.syncJobId)) {
      cancelButton.disabled = true;
      cancelButton.textContent = "停止中";
    }
    actions.append(cancelButton);
  }
  if (metadata.syncCanRetry) {
    actions.append(markGptActionControl(createButton("重试", "button-like message-action-button", () => retrySyncJob(metadata.syncJobId))));
  }
  return actions;
}

async function deleteRoomMessage(messageId) {
  if (!messageId) return;
  const confirmed = window.confirm("删除这条消息？只会从当前 Bridge 房间隐藏。");
  if (!confirmed) return;
  try {
    await api(`/api/room/messages/${encodeURIComponent(messageId)}`, {
      method: "DELETE"
    });
    await refreshWorkspaceSurface({ scrollToBottom: false });
    showToast("消息已删除");
  } catch (error) {
    showToast(error.message);
  }
}

async function clearRoomConversation() {
  const confirmed = window.confirm("清空当前对话？只会清空 Bridge 当前房间视图，不会删除本地文件。");
  if (!confirmed) return;
  try {
    await api(scopedProjectPath("/api/room/messages"), {
      method: "DELETE"
    });
    state.expandedLongTextKeys.clear();
    await refreshWorkspaceSurface({ scrollToBottom: true });
    showToast("对话已清空");
  } catch (error) {
    showToast(error.message);
  }
}

function createMessageDeleteButton(messageId) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "message-delete-button";
  button.textContent = "×";
  button.setAttribute("aria-label", "删除这条消息");
  button.title = "删除这条消息";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    deleteRoomMessage(messageId);
  });
  return button;
}

function renderMessage(message) {
  const article = document.createElement("article");
  const from = message.from || message.role || "user";
  article.className = `message-row message-${visualMessageFrom(message)}`;
  article.dataset.messageId = message.id || "";
  if (message.metadata?.syncStatus === "failed") {
    article.classList.add("message-failed");
  }

  const header = document.createElement("header");
  const sentTo =
    (from === "user" || from === "codex" || message.metadata?.origin === "acceptance") && message.to?.length
      ? ` -> ${targetLabel(message.to)}`
      : "";
  const role = document.createElement("span");
  role.className = "message-role";
  role.textContent = `${roleLabel(message)}${sentTo}`;
  const time = document.createElement("time");
  time.dateTime = message.createdAt || "";
  time.textContent = formatMessageTime(message.createdAt);
  header.append(role, time);
  if (message.id) {
    const headerActions = document.createElement("span");
    headerActions.className = "message-header-actions";
    headerActions.append(createMessageDeleteButton(message.id));
    header.append(headerActions);
  }

  const body = document.createElement("div");
  body.className = "message-content";
  body.append(renderCodeBlocks(displayTextForMessage(message), message.id || message.createdAt || from));

  article.append(header, body);
  const status = renderMessageStatus(message);
  if (status) article.append(status);
  const syncActions = renderSyncActions(message);
  if (syncActions) article.append(syncActions);
  const attachments = renderMessageArtifacts(message);
  if (attachments) article.append(attachments);
  return article;
}

function displayTextForMessage(message = {}) {
  const metadata = message.metadata || {};
  const artifactIds = Array.isArray(metadata.artifactIds) ? metadata.artifactIds : [];
  const artifactImages = artifactIds.map((id) => state.artifactCache.get(id)).filter(isImageArtifact);
  const text = message.text || "";
  if (artifactImages.length >= 1 && /还在处理|没有拿到最终可用回复|still processing|not return a usable reply/i.test(text)) {
    return `已捕获 ${artifactImages.length} 张图片`;
  }
  if (artifactImages.length >= 2 && /生成了?一张图片|生成一张图片|one image|single image/i.test(text)) {
    return `已捕获 ${artifactImages.length} 张图片`;
  }
  if (looksLikeQuestionMarkEncodingLoss(text)) {
    return HIDDEN_ENCODING_LOSS_MESSAGE;
  }
  return normalizeVisibleGptText(text);
}

function isVisibleRoomMessage(message = {}) {
  return message.metadata?.source !== "image_batch_continuation";
}

function visibleRoomMessages(messages = state.messages) {
  return messages.filter(isVisibleRoomMessage);
}

function latestVisibleMessageId(messages = state.messages) {
  const visibleMessages = visibleRoomMessages(messages);
  return visibleMessages.at(-1)?.id || null;
}

function messageDomKey(message = {}, index = 0) {
  return message.id || [message.createdAt || "", message.from || message.role || "", index].join(":");
}

function messageDomSignature(message = {}) {
  return JSON.stringify({
    from: message.from || "",
    role: message.role || "",
    to: Array.isArray(message.to) ? message.to : [],
    text: message.text || "",
    createdAt: message.createdAt || "",
    metadata: message.metadata || {}
  });
}

function renderMessages(messages = []) {
  const visibleMessages = visibleRoomMessages(messages);
  pruneStablePreviewNodes(collectStablePreviewKeys(visibleMessages));

  if (!visibleMessages.length) {
    const empty = document.createElement("div");
    empty.className = "chat-empty";
    empty.innerHTML = "<strong>这个房间还没有消息。</strong><span>像平时聊天一样输入，消息会发送给绑定的 GPT 会话。</span>";
    els.chatMessages.replaceChildren(empty);
    return;
  }

  const existingByKey = new Map();
  for (const child of els.chatMessages.children) {
    if (child.dataset?.messageKey) {
      existingByKey.set(child.dataset.messageKey, child);
    }
  }

  const nextNodes = visibleMessages.map((message, index) => {
    const key = messageDomKey(message, index);
    const signature = messageDomSignature(message);
    const existing = existingByKey.get(key);
    if (existing && existing.dataset.messageSignature === signature) {
      return existing;
    }

    const node = renderMessage(message);
    node.dataset.messageKey = key;
    node.dataset.messageSignature = signature;
    return node;
  });

  const currentNodes = Array.from(els.chatMessages.children);
  const sameNodes =
    currentNodes.length === nextNodes.length && nextNodes.every((node, index) => node === currentNodes[index]);

  if (!sameNodes) {
    els.chatMessages.replaceChildren(...nextNodes);
  }
  syncGptActionControls();
}

function acceptanceStatusLabel(status) {
  if (status === "passed") return "已通过";
  if (status === "failed") return "需处理";
  return "待测试";
}

function renderAcceptancePanel(payload) {
  if (!ACCEPTANCE_MODE || !els.acceptancePanel) return;
  state.acceptanceStatus = payload;
  const summary = payload?.summary || { total: 0, passed: 0, missing: 0, failed: 0 };
  els.acceptancePanel.hidden = false;
  els.acceptanceSummary.textContent = `${summary.passed}/${summary.total} 已通过 · ${summary.missing} 项待测试 · ${summary.failed} 项需处理`;
  els.acceptanceList.replaceChildren();

  for (const group of payload?.groups || [{ id: "data", label: "GPT 数据读取", summary, checks: payload?.checks || [] }]) {
    const groupSection = document.createElement("section");
    groupSection.className = "acceptance-group";
    groupSection.dataset.group = group.id || "data";

    const groupHead = document.createElement("div");
    groupHead.className = "acceptance-group-head";
    const groupTitle = document.createElement("strong");
    groupTitle.textContent = group.label || "验收项";
    const groupSummary = document.createElement("span");
    const scopedSummary = group.summary || { total: group.checks?.length || 0, passed: 0, missing: 0, failed: 0 };
    groupSummary.textContent = `${scopedSummary.passed}/${scopedSummary.total} 通过`;
    groupHead.append(groupTitle, groupSummary);

    const list = document.createElement("div");
    list.className = "acceptance-list";

    for (const check of group.checks || []) {
      const item = document.createElement("article");
      item.className = `acceptance-item is-${check.status || "missing"}`;

      const marker = document.createElement("span");
      marker.className = "acceptance-marker";
      marker.textContent = check.status === "passed" ? "✓" : check.status === "failed" ? "!" : "·";

      const content = document.createElement("div");
      content.className = "acceptance-content";
      const title = document.createElement("strong");
      title.textContent = check.label;
      const evidence = document.createElement("span");
      evidence.textContent = `${acceptanceStatusLabel(check.status)} · ${check.evidence || "暂无证据"}`;
      content.append(title, evidence);

      const actions = document.createElement("div");
      actions.className = "acceptance-item-actions";
      if (check.action === "route_probe") {
        const routeBadge = document.createElement("span");
        routeBadge.className = "acceptance-route-badge";
        routeBadge.textContent = check.actualRouteLabel || check.actualRoute || check.expectedRouteLabel || check.expectedRoute || "route";
        actions.append(routeBadge);
      } else {
        actions.append(markGptActionControl(createButton("发送", "button-like acceptance-send", () => queueAcceptancePrompt(check))));
      }

      item.append(marker, content, actions);
      list.append(item);
    }

    groupSection.append(groupHead, list);
    els.acceptanceList.append(groupSection);
  }
  syncGptActionControls();
}

async function loadAcceptanceStatus(projectId = state.activeProjectId) {
  if (!ACCEPTANCE_MODE || !els.acceptancePanel) return null;
  const payload = await api(scopedProjectPath("/api/acceptance/status", projectId));
  renderAcceptancePanel(payload);
  return payload;
}

async function copyAcceptanceReport() {
  if (!ACCEPTANCE_MODE) return;
  const response = await fetch("/api/acceptance/report");
  if (!response.ok) {
    throw new Error(await response.text() || `请求失败：${response.status}`);
  }
  const report = await response.text();
  await navigator.clipboard.writeText(report);
  showToast("验收报告已复制");
}

async function loadAcceptanceRecordText() {
  const response = await fetch("/api/acceptance/real-browser-record");
  if (!response.ok) {
    throw new Error(friendlyErrorMessage(await response.text() || `请求失败：${response.status}`));
  }
  return response.text();
}

async function openAcceptanceRecordPreview() {
  const record = await loadAcceptanceRecordText();
  state.acceptanceRecordText = record;
  els.acceptanceRecordBody.textContent = record;
  els.acceptanceRecordDialog.showModal();
}

async function copyAcceptanceRecordFromDialog() {
  const record = state.acceptanceRecordText || await loadAcceptanceRecordText();
  state.acceptanceRecordText = record;
  try {
    await navigator.clipboard.writeText(record);
    showToast("已复制验收记录");
  } catch {
    showToast("复制失败，请点下载保存验收记录");
  }
}

async function downloadAcceptanceRecordFromDialog() {
  const record = state.acceptanceRecordText || await loadAcceptanceRecordText();
  state.acceptanceRecordText = record;
  downloadTextFile("CodexBridge-真实验收记录.md", record, "text/markdown;charset=utf-8");
  showToast("已下载验收记录");
}

async function downloadAcceptanceRecord() {
  if (!ACCEPTANCE_MODE) return;
  const record = await loadAcceptanceRecordText();
  downloadTextFile("CodexBridge-真实验收记录.md", record, "text/markdown;charset=utf-8");
  showToast("真实体验记录已下载");
}

function firstIncompleteAcceptanceCheck() {
  return state.acceptanceStatus?.checks?.find((check) => check.status !== "passed" && check.action !== "route_probe") || null;
}

async function queueAcceptancePrompt(check) {
  if (!check?.prompt) return;

  if (["local-file-to-gpt", "failed-retry"].includes(check.id)) {
    els.chatInput.value = check.prompt;
    syncComposerSendControl();
    els.chatInput.focus();
    showToast("已填入输入框，请按提示完成这项验收");
    return;
  }

  await ensureGptActionReady();
  await sendMessage(check.prompt, ["gpt"], {
    metadata: {
      origin: "acceptance",
      actor: "codex",
      acceptanceCheckId: check.id
    }
  });
  await refreshWorkspaceSurface({ scrollToBottom: true });
  showToast(`已发送验收项：${check.label}`);
}

async function queueNextAcceptancePrompt() {
  const check = firstIncompleteAcceptanceCheck();
  if (!check) {
    showToast("验收项已经全部通过");
    return;
  }
  await queueAcceptancePrompt(check);
}

function renderArtifacts(artifacts = []) {
  state.artifacts = artifacts;
  state.artifactCache = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  els.outputSummary.textContent = `${artifacts.length} 个文件`;
  els.artifactList.replaceChildren();

  if (artifacts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "GPT 生成的图片、PPT、Excel、ZIP 和其他文件会收在这里。";
    els.artifactList.append(empty);
    return;
  }

  const imageArtifacts = artifacts.filter(isImageArtifact).slice(0, 10);
  if (imageArtifacts.length) {
    const strip = document.createElement("section");
    strip.className = "artifact-image-strip";
    const title = document.createElement("h3");
    title.textContent = "图片";
    strip.append(title, renderImageGrid(imageArtifacts));
    els.artifactList.append(strip);
  }

  const fileArtifacts = artifacts.filter((artifact) => !isImageArtifact(artifact));
  for (const artifact of fileArtifacts.slice(0, 24)) {
    els.artifactList.append(renderFileCard(artifact, { compact: true }));
  }

  if (artifacts.length > 24) {
    const more = document.createElement("div");
    more.className = "empty-state";
    more.textContent = `只展示最近 24 个文件，共 ${artifacts.length} 个。`;
    els.artifactList.append(more);
  }
}

function applyWorkspacePreferences(workspace = {}) {
  const modelPreference = MODEL_PREFERENCES.has(workspace.modelPreference)
    ? workspace.modelPreference
    : "gpt-5.6-sol";
  const modePreference =
    compatibleModePreference(modelPreference, workspace.modePreference) ||
    modePreferencesForModel(modelPreference)[0] ||
    "balanced";
  setModelPreference(modelPreference);
  setModePreference(modePreference);
}

async function loadWorkspaceSurface(projectId) {
  const [workspace, status, artifactsPayload, messagesPayload, acceptancePayload] = await Promise.all([
    api(scopedProjectPath("/api/workspace", projectId)),
    api(scopedProjectPath("/api/diagnostics/status", projectId)),
    api(scopedProjectPath("/api/artifacts", projectId)),
    api(scopedProjectPath("/api/room/messages", projectId)),
    ACCEPTANCE_MODE && els.acceptancePanel
      ? api(scopedProjectPath("/api/acceptance/status", projectId))
      : Promise.resolve(null)
  ]);
  return {
    workspace,
    status,
    artifacts: artifactsPayload.artifacts || [],
    messages: messagesPayload.messages || messagesPayload || [],
    acceptance: acceptancePayload
  };
}

function applyWorkspaceSurface(surface) {
  state.workspace = surface.workspace;
  state.status = surface.status;
  state.messages = surface.messages;
  applyWorkspacePreferences(surface.workspace);
  updateSettingsFields();
  updateStatusLine(surface.status);
  renderArtifacts(surface.artifacts);
  renderMessages(surface.messages);
  renderChainStatusPanel();
  if (surface.acceptance) {
    renderAcceptancePanel(surface.acceptance);
  }
}

async function refreshWorkspaceSurface({ scrollToBottom = false } = {}) {
  const projectId = state.activeProjectId;
  if (!projectId) return false;
  const chatScrollState = captureChatScrollState();
  const previousLastMessageId = latestVisibleMessageId();
  const applied = await runProjectRefresh({
    coordinator: projectRefreshCoordinator,
    projectId,
    getActiveProjectId: () => state.activeProjectId,
    load: loadWorkspaceSurface,
    apply: applyWorkspaceSurface
  });
  if (!applied) return false;
  updateStatusLine(state.status);
  updateSettingsFields();
  const nextLastMessageId = latestVisibleMessageId();
  const receivedNewVisibleMessage = previousLastMessageId !== nextLastMessageId;
  if (
    !chatScrollState.readingLongText &&
    (scrollToBottom || shouldForceInitialBottomScroll() || (chatScrollState.nearBottom && receivedNewVisibleMessage))
  ) {
    scrollToComposer();
  } else if (chatScrollState.readingLongText) {
    clearBottomScrollSettle();
  } else {
    clearBottomScrollSettle();
    restoreChatScrollState(chatScrollState);
  }
  return true;
}

async function previewArtifact(artifactId) {
  const artifact = state.artifactCache.get(artifactId);
  if (artifact && isImageArtifact(artifact)) {
    openImagePreview(artifact);
    return;
  }

  state.previewArtifactForDownload = artifact || artifactId;
  if (els.previewDownloadButton) {
    els.previewDownloadButton.disabled = false;
    els.previewDownloadButton.classList.remove("is-hidden");
  }

  try {
    const preview = await loadArtifactPreview(artifactId, { full: true });
    els.previewTitle.textContent = preview.title || preview.artifact?.filename || "文件预览";
    els.previewBody.replaceChildren(renderArtifactPreviewContent(preview, { compact: false, expanded: true }));
  } catch (error) {
    els.previewTitle.textContent = artifact?.filename || "文件预览";
    const fallback = document.createElement("p");
    fallback.className = "file-preview-meta";
    fallback.textContent = error.message || "这个文件暂时不能直接预览。";
    els.previewBody.replaceChildren(fallback);
  }
  els.previewDialog.showModal();
}

async function saveArtifact(artifactId) {
  const saved = await api(`/api/artifacts/${encodeURIComponent(artifactId)}/save-to-project`, {
    method: "POST",
    body: JSON.stringify({
      targetRepo: state.workspace?.targetRepo
    })
  });
  showToast(`已保存到 ${saved.relativePath}`);
  await refreshWorkspaceSurface();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",").at(-1) : result);
    });
    reader.addEventListener("error", () => reject(reader.error || new Error("文件读取失败")));
    reader.readAsDataURL(file);
  });
}

async function importArtifactFile(file) {
  const base64Data = await fileToBase64(file);
  return api("/api/artifacts/import", {
    method: "POST",
    body: JSON.stringify({
      filename: file.name || "artifact",
      contentType: file.type || "application/octet-stream",
      base64Data
    })
  });
}

async function importSelectedArtifacts(event) {
  const files = [...(event.target.files || [])];
  if (!files.length) return;

  try {
    for (const file of files) {
      await importArtifactFile(file);
    }
    showToast(`已添加 ${files.length} 个文件`);
    await refreshWorkspaceSurface();
  } catch (error) {
    showToast(error.message);
  } finally {
    event.target.value = "";
  }
}

function fallbackFileExtension(contentType = "") {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("jpeg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("pdf")) return "pdf";
  return "bin";
}

function namedComposerFile(file, index = 0) {
  if (file.name) return file;
  if (typeof File !== "function") return file;
  const extension = fallbackFileExtension(file.type || "");
  return new File([file], `pasted-file-${Date.now()}-${index + 1}.${extension}`, {
    type: file.type || "application/octet-stream",
    lastModified: file.lastModified || Date.now()
  });
}

function normalizeComposerFiles(files = []) {
  return [...files].filter(Boolean).map((file, index) => namedComposerFile(file, index));
}

function renderPendingAttachments() {
  els.attachmentTray.replaceChildren();
  els.attachmentTray.hidden = state.pendingFiles.length === 0;

  for (const item of state.pendingFiles) {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";

    const name = document.createElement("span");
    name.textContent = `${item.file.name || "artifact"} · ${formatBytes(item.file.size || 0)}`;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", "移除附件");
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.pendingFiles = state.pendingFiles.filter((pending) => pending.id !== item.id);
      renderPendingAttachments();
    });

    chip.append(name, remove);
    els.attachmentTray.append(chip);
  }
  syncComposerSendControl();
}

function stageComposerFiles(files = []) {
  const normalized = normalizeComposerFiles(files);
  if (!normalized.length) return;

  for (const file of normalized) {
    state.pendingFiles.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      file
    });
  }

  renderPendingAttachments();
  els.chatInput.focus();
  showToast(`已添加 ${normalized.length} 个附件`);
}

function dataTransferHasFiles(dataTransfer) {
  return Boolean(
    dataTransfer?.files?.length ||
      Array.from(dataTransfer?.items || []).some((item) => item.kind === "file") ||
      Array.from(dataTransfer?.types || []).includes("Files")
  );
}

function filesFromDataTransfer(dataTransfer) {
  const files = dataTransfer?.files?.length
    ? Array.from(dataTransfer.files)
    : Array.from(dataTransfer?.items || [])
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter(Boolean);
  return normalizeComposerFiles(files);
}

function handleComposerDrop(event) {
  if (!dataTransferHasFiles(event.dataTransfer)) return;
  event.preventDefault();
  els.composerBox.classList.remove("is-dragging-files");
  stageComposerFiles(filesFromDataTransfer(event.dataTransfer));
}

function handleComposerDrag(event) {
  if (!dataTransferHasFiles(event.dataTransfer)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  els.composerBox.classList.add("is-dragging-files");
}

function handleComposerDragLeave(event) {
  if (event.relatedTarget && els.composerBox.contains(event.relatedTarget)) return;
  els.composerBox.classList.remove("is-dragging-files");
}

function handleComposerPaste(event) {
  const files = filesFromDataTransfer(event.clipboardData);
  if (!files.length) return;
  event.preventDefault();
  stageComposerFiles(files);
}

async function sendLocalFileToGpt(file, note) {
  await ensureGptSendReady(["gpt"], note || "");
  const base64Data = await fileToBase64(file);
  return api("/api/local-files/analyze-with-gpt", {
    method: "POST",
    body: JSON.stringify({
      filename: file.name || "artifact",
      contentType: file.type || "application/octet-stream",
      base64Data,
      note: note?.trim() || "请分析这个本机文件的内容、质量和下一步建议。",
      modePreference: selectedModePreference(),
      modelPreference: selectedModelPreference()
    })
  });
}

async function queueArtifactForCodex(artifactId, note) {
  return api(`/api/artifacts/${encodeURIComponent(artifactId)}/analyze-with-codex`, {
    method: "POST",
    body: JSON.stringify({
      note: note?.trim() || "请分析这个本机文件的内容、质量和下一步建议。"
    })
  });
}

async function sendLocalFileToCodex(file, note) {
  const imported = await importArtifactFile(file);
  await queueArtifactForCodex(imported.artifact.id, note);
  return imported;
}

function autoTargetsForLocalFile(note = "") {
  const text = note.trim();
  if (/Codex|本地|项目|代码|源码|保存|放进|放到|修改|修复|实现|运行|测试|验证|终端|命令|repo|code|run|test|fix|implement/i.test(text)) {
    return ["codex"];
  }
  return ["gpt"];
}

async function sendLocalFileToTargets(file, targets, note) {
  if (targets.includes("auto")) {
    return sendLocalFileToTargets(file, autoTargetsForLocalFile(note), note);
  }
  if (targets.includes("gpt") && targets.includes("codex")) {
    const queued = await sendLocalFileToGpt(file, note);
    await queueArtifactForCodex(queued.artifact.id, note);
    return queued;
  }
  if (targets.includes("gpt")) {
    return sendLocalFileToGpt(file, note);
  }
  return sendLocalFileToCodex(file, note);
}

async function sendSelectedLocalFiles(event) {
  const files = [...(event.target.files || [])];
  stageComposerFiles(files);
  event.target.value = "";
}

async function analyzeArtifactWithGpt(artifactId) {
  await ensureGptActionReady();
  await api(`/api/artifacts/${encodeURIComponent(artifactId)}/analyze-with-gpt`, {
    method: "POST",
    body: JSON.stringify({
      note: "请分析这个文件的内容、质量和下一步建议。",
      modePreference: selectedModePreference(),
      modelPreference: selectedModelPreference()
    })
  });
  showToast("已发给 GPT");
  await refreshWorkspaceSurface({ scrollToBottom: true });
}

async function analyzeArtifact(artifactId) {
  await api(`/api/artifacts/${encodeURIComponent(artifactId)}/analyze-with-codex`, {
    method: "POST",
    body: JSON.stringify({
      note: "请判断这个 GPT 输出文件的类型、内容质量和后续可处理动作。"
    })
  });
  showToast("已交给 Codex");
  await refreshWorkspaceSurface({ scrollToBottom: true });
}

async function retrySyncJob(syncJobId) {
  await ensureGptActionReady();
  await api(`/api/sync/jobs/${encodeURIComponent(syncJobId)}/retry`, {
    method: "POST"
  });
  showToast("已重新发送给 GPT");
  await refreshWorkspaceSurface({ scrollToBottom: true });
}

function syncCancelControls(syncJobId, cancelling) {
  for (const button of document.querySelectorAll("[data-sync-cancel-control]")) {
    if (button.dataset.syncCancelControl !== syncJobId) continue;
    button.disabled = cancelling;
    button.textContent = cancelling ? "停止中" : "停止";
  }
}

async function cancelSyncJob(syncJobId) {
  if (state.cancellingSyncJobIds.has(syncJobId)) return;
  state.cancellingSyncJobIds.add(syncJobId);
  syncCancelControls(syncJobId, true);
  try {
    await api(`/api/sync/jobs/${encodeURIComponent(syncJobId)}/cancel`, {
      method: "POST"
    });
    showToast("已停止这次 GPT 任务");
    await refreshWorkspaceSurface({ scrollToBottom: false });
  } catch (error) {
    showToast(error.message);
  } finally {
    state.cancellingSyncJobIds.delete(syncJobId);
    syncCancelControls(syncJobId, false);
  }
}

const BOTTOM_SCROLL_SETTLE_DELAYS_MS = [80, 240, 600, 1200, 2200, 4200, 7600, 12000, 20000];
const INITIAL_BOTTOM_SCROLL_WINDOW_MS = 30000;
let bottomScrollSettleTimers = [];
let bottomScrollResizeObserver = null;
let bottomScrollLoadHandler = null;

function clearBottomScrollSettle() {
  for (const timer of bottomScrollSettleTimers) {
    window.clearTimeout(timer);
  }
  bottomScrollSettleTimers = [];
  if (bottomScrollResizeObserver) {
    bottomScrollResizeObserver.disconnect();
    bottomScrollResizeObserver = null;
  }
  if (bottomScrollLoadHandler && els.chatMessages) {
    els.chatMessages.removeEventListener("load", bottomScrollLoadHandler, true);
    els.chatMessages.removeEventListener("transitionend", bottomScrollLoadHandler, true);
    bottomScrollLoadHandler = null;
  }
}

function observeBottomScrollSettle(scroll) {
  if (!("ResizeObserver" in window) || !els.chatMessages) return;
  bottomScrollResizeObserver = new ResizeObserver(scroll);
  bottomScrollResizeObserver.observe(els.chatMessages);
  for (const row of els.chatMessages.querySelectorAll(".message-row")) {
    bottomScrollResizeObserver.observe(row);
  }
  bottomScrollLoadHandler = () => {
    if (shouldForceInitialBottomScroll()) {
      scroll();
    }
  };
  els.chatMessages.addEventListener("load", bottomScrollLoadHandler, true);
  els.chatMessages.addEventListener("transitionend", bottomScrollLoadHandler, true);
}

function forceElementToBottom(element) {
  if (!element) return;
  const top = Math.max(0, element.scrollHeight - element.clientHeight);
  if (typeof element.scrollTo === "function") {
    element.scrollTo({ top, behavior: "auto" });
  }
  element.scrollTop = top;
}

function forceChatToBottom() {
  forceElementToBottom(els.chatMessages);
  forceLatestMessageIntoView();
  forceElementToBottom(document.scrollingElement || document.documentElement || document.body);
}

function latestMessageAnchor() {
  if (!els.chatMessages) return null;
  const rows = els.chatMessages.querySelectorAll(".message-row");
  return rows[rows.length - 1] || els.chatMessages.lastElementChild || null;
}

function forceLatestMessageIntoView() {
  const anchor = latestMessageAnchor();
  if (!anchor || !els.chatMessages) return;
  const listRect = els.chatMessages.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const bottomDelta = anchorRect.bottom - listRect.bottom + 24;
  if (Number.isFinite(bottomDelta) && bottomDelta > 0) {
    els.chatMessages.scrollTop += bottomDelta;
  }
}

function scrollToComposer() {
  if (els.chatView.classList.contains("is-hidden")) return;
  clearBottomScrollSettle();
  const scroll = () => forceChatToBottom();
  window.requestAnimationFrame(() => {
    scroll();
    window.requestAnimationFrame(scroll);
    observeBottomScrollSettle(scroll);
    for (const delay of BOTTOM_SCROLL_SETTLE_DELAYS_MS) {
      bottomScrollSettleTimers.push(window.setTimeout(scroll, delay));
    }
    bottomScrollSettleTimers.push(
      window.setTimeout(clearBottomScrollSettle, BOTTOM_SCROLL_SETTLE_DELAYS_MS.at(-1) + 200)
    );
  });
}

function startInitialBottomScrollSettle() {
  state.initialBottomScrollUntil = Date.now() + INITIAL_BOTTOM_SCROLL_WINDOW_MS;
  scrollToComposer();
}

function shouldForceInitialBottomScroll() {
  return Date.now() < state.initialBottomScrollUntil;
}

function cancelBottomScrollSettleOnUserIntent() {
  state.initialBottomScrollUntil = 0;
  clearBottomScrollSettle();
  if (els.chatView && !els.chatView.classList.contains("is-hidden")) {
    state.readingLongTextUntil = Math.max(state.readingLongTextUntil || 0, Date.now() + 2000);
  }
}

function captureChatScrollState() {
  if (els.chatView.classList.contains("is-hidden")) {
    return { nearBottom: true, bottomOffset: 0, pageBottomOffset: 0, readingLongText: false };
  }

  const pageScroller = document.scrollingElement || document.documentElement || document.body;
  const bottomOffset = Math.max(
    0,
    els.chatMessages.scrollHeight - els.chatMessages.clientHeight - els.chatMessages.scrollTop
  );
  const pageBottomOffset = Math.max(
    0,
    pageScroller.scrollHeight - pageScroller.clientHeight - pageScroller.scrollTop
  );
  return {
    bottomOffset,
    pageBottomOffset,
    readingLongText: isLongTextReadingActive(),
    nearBottom: bottomOffset <= 96 && pageBottomOffset <= 96
  };
}

function restoreChatScrollState(chatScrollState) {
  if (els.chatView.classList.contains("is-hidden")) return;
  window.requestAnimationFrame(() => {
    const pageScroller = document.scrollingElement || document.documentElement || document.body;
    els.chatMessages.scrollTop = Math.max(
      0,
      els.chatMessages.scrollHeight - els.chatMessages.clientHeight - chatScrollState.bottomOffset
    );
    if (Number.isFinite(chatScrollState.pageBottomOffset)) {
      pageScroller.scrollTop = Math.max(
        0,
        pageScroller.scrollHeight - pageScroller.clientHeight - chatScrollState.pageBottomOffset
      );
    }
  });
}

async function sendMessage(text, targets, options = {}) {
  return api(scopedProjectPath("/api/room/messages"), {
    method: "POST",
    body: JSON.stringify({
      projectId: state.activeProjectId,
      text,
      to: targets,
      inputArtifactIds: options.inputArtifactIds || undefined,
      modePreference: selectedModePreference(),
      modelPreference: selectedModelPreference(),
      metadata: options.metadata || undefined
    })
  });
}

async function importPendingComposerFiles(files = []) {
  const imported = [];
  for (const file of files) {
    const result = await importArtifactFile(file);
    imported.push(result.artifact);
  }
  return imported;
}

async function sendComposerPayload(text, targets) {
  const files = state.pendingFiles.map((item) => item.file);
  if (!text && files.length === 0) return false;

  if (files.length === 0) {
    return sendMessage(text, targets);
  }

  const importedArtifacts = await importPendingComposerFiles(files);
  const result = await sendMessage(text, targets, {
    inputArtifactIds: importedArtifacts.map((artifact) => artifact.id)
  });
  state.pendingFiles = [];
  renderPendingAttachments();
  return result || true;
}

els.themeToggle.addEventListener("click", () => {
  setTheme(state.theme === "dark" ? "light" : "dark");
});

els.selfCheckButton.addEventListener("click", runSelfCheck);
els.clearMessagesButton.addEventListener("click", clearRoomConversation);

els.backToProjectsButton.addEventListener("click", () => {
  showProjects();
  renderProjectList();
});

els.settingsButton.addEventListener("click", () => {
  updateSettingsFields();
  els.settingsDialog.showModal();
});

els.refreshButton.addEventListener("click", async () => {
  try {
    await refreshWorkspaceSurface();
    showToast("已刷新");
  } catch (error) {
    showToast(error.message);
  }
});

els.workflowRecheckButton.addEventListener("click", async () => {
  try {
    await refreshWorkspaceSurface({ scrollToBottom: false });
    showToast("已重新检测 Bridge 状态");
  } catch (error) {
    showToast(error.message);
  }
});

els.workflowOpenExtensionsButton.addEventListener("click", async () => {
  try {
    await openExtensionManager(state.status);
  } catch (error) {
    showToast(error.message);
  }
});

els.workflowOpenBoundChatButton.addEventListener("click", async () => {
  try {
    await openBoundChatPage(state.status);
  } catch (error) {
    showToast(error.message);
  }
});

els.workflowApplyPreferencesButton.addEventListener("click", applyWorkflowPreferences);

els.workflowCopyStepsButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(workflowRepairText(state.status));
    showToast("已复制修复步骤");
  } catch (error) {
    showToast(workflowRepairText(state.status));
  }
});

if (els.chainCopyStatusButton) {
  els.chainCopyStatusButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(bridgeStatusCopyText());
      showToast("已复制 Bridge 状态");
    } catch {
      showToast(bridgeStatusCopyText());
    }
  });
}

if (els.chainCopyAcceptanceRecordButton) {
  els.chainCopyAcceptanceRecordButton.addEventListener("click", async () => {
    els.chainCopyAcceptanceRecordButton.disabled = true;
    try {
      await openAcceptanceRecordPreview();
    } catch (error) {
      showToast(error.message);
    } finally {
      els.chainCopyAcceptanceRecordButton.disabled = false;
    }
  });
}

if (els.acceptanceRecordCopyButton) {
  els.acceptanceRecordCopyButton.addEventListener("click", async () => {
    els.acceptanceRecordCopyButton.disabled = true;
    try {
      await copyAcceptanceRecordFromDialog();
    } catch (error) {
      showToast(error.message);
    } finally {
      els.acceptanceRecordCopyButton.disabled = false;
    }
  });
}

if (els.acceptanceRecordDownloadButton) {
  els.acceptanceRecordDownloadButton.addEventListener("click", async () => {
    els.acceptanceRecordDownloadButton.disabled = true;
    try {
      await downloadAcceptanceRecordFromDialog();
    } catch (error) {
      showToast(error.message);
    } finally {
      els.acceptanceRecordDownloadButton.disabled = false;
    }
  });
}

els.acceptanceRefreshButton?.addEventListener("click", async () => {
  try {
    await loadAcceptanceStatus();
    showToast("验收状态已刷新");
  } catch (error) {
    showToast(error.message);
  }
});

els.acceptanceSendNextButton?.addEventListener("click", async () => {
  els.acceptanceSendNextButton.disabled = true;
  try {
    await queueNextAcceptancePrompt();
  } catch (error) {
    showToast(error.message);
  } finally {
    els.acceptanceSendNextButton.disabled = false;
  }
});

els.acceptanceReportButton?.addEventListener("click", async () => {
  els.acceptanceReportButton.disabled = true;
  try {
    await copyAcceptanceReport();
  } catch (error) {
    showToast(error.message);
  } finally {
    els.acceptanceReportButton.disabled = false;
  }
});

els.acceptanceRecordButton?.addEventListener("click", async () => {
  els.acceptanceRecordButton.disabled = true;
  try {
    await downloadAcceptanceRecord();
  } catch (error) {
    showToast(error.message);
  } finally {
    els.acceptanceRecordButton.disabled = false;
  }
});

els.newProjectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.newProjectSubmitButton.disabled = true;
  try {
    const projectPath = state.currentCodexThreadId ? "/api/projects/current-session" : "/api/projects";
    const created = await api(projectPath, {
      method: "POST",
      body: JSON.stringify({
        name: els.projectNameInput.value,
        chatgptProjectUrl: restoreProjectConversationUrl(els.projectUrlInput.value),
        targetRepo: els.targetRepoInput.value
      })
    });
    const project = created.project;
    const bound = state.currentCodexThreadId
      ? created
      : await api(`/api/projects/${encodeURIComponent(project.id)}/select`, {
          method: "POST",
          body: JSON.stringify({})
        });
    els.newProjectForm.reset();
    state.activeProjectId = created.activeProjectId || project.id;
    state.activeProject = project;
    await loadProjects({ autoEnter: false });
    state.activeProjectId = created.activeProjectId || project.id;
    state.activeProject = project;
    showChat();
    await refreshWorkspaceSurface({ scrollToBottom: true });
    showToast(state.currentCodexThreadId ? "已绑定当前会话" : "项目已创建");
  } catch (error) {
    showToast(error.message);
  } finally {
    els.newProjectSubmitButton.disabled = false;
  }
});

els.bindingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = event.submitter;
  if (submitButton) submitButton.disabled = true;
  const patch = {
    chatgptProjectUrl: restoreProjectConversationUrl(els.settingsProjectUrlInput.value),
    targetRepo: els.settingsTargetRepoInput.value
  };

  try {
    const bound = await saveProjectBindingForScope({
      api,
      currentCodexThreadId: state.currentCodexThreadId,
      activeProjectId: state.activeProjectId,
      activeProjectName: state.activeProject?.name,
      patch
    });
    state.activeProject = bound.project;
    state.activeProjectId = bound.activeProjectId;

    await loadProjects({ autoEnter: false });
    state.activeProject = bound.project;
    state.activeProjectId = bound.activeProjectId;
    showChat();
    await refreshWorkspaceSurface({ scrollToBottom: true });
    showToast("已保存");
    els.settingsDialog.close();
  } catch (error) {
    showToast(error.message);
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
});

els.artifactImportInput.addEventListener("change", importSelectedArtifacts);
els.composerFileInput.addEventListener("change", sendSelectedLocalFiles);
els.modeSelect.addEventListener("change", () => {
  setModePreference(els.modeSelect.value);
  queuePreferenceSync();
});
els.modelSelect.addEventListener("change", () => {
  setModelPreference(els.modelSelect.value);
  queuePreferenceSync();
});
els.composerBox.addEventListener("dragenter", handleComposerDrag);
els.composerBox.addEventListener("dragover", handleComposerDrag);
els.composerBox.addEventListener("dragleave", handleComposerDragLeave);
els.composerBox.addEventListener("drop", handleComposerDrop);
els.chatMessages.addEventListener("dragenter", handleComposerDrag);
els.chatMessages.addEventListener("dragover", handleComposerDrag);
els.chatMessages.addEventListener("drop", handleComposerDrop);
els.chatMessages.addEventListener("wheel", cancelBottomScrollSettleOnUserIntent, { passive: true });
els.chatMessages.addEventListener("touchmove", cancelBottomScrollSettleOnUserIntent, { passive: true });
window.addEventListener("wheel", cancelBottomScrollSettleOnUserIntent, { passive: true });
window.addEventListener("touchmove", cancelBottomScrollSettleOnUserIntent, { passive: true });
els.composerBox.addEventListener("paste", handleComposerPaste);
els.imageDialog.addEventListener("close", () => {
  state.imagePreviewOnChange = null;
});
els.previewDownloadButton.addEventListener("click", async () => {
  try {
    await downloadArtifactToDevice(state.previewArtifactForDownload);
  } catch (error) {
    showToast(error.message);
  }
});
els.imagePreviewDownloadButton.addEventListener("click", async () => {
  const artifact = state.imagePreviewArtifacts?.[state.imagePreviewIndex];
  try {
    await downloadArtifactToDevice(artifact);
  } catch (error) {
    showToast(error.message);
  }
});
els.imagePreviewPrev.addEventListener("click", () => moveImagePreview(-1));
els.imagePreviewNext.addEventListener("click", () => moveImagePreview(1));
els.imageDialog.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    els.imageDialog.close();
    return;
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    moveImagePreview(-1);
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    moveImagePreview(1);
  }
});

els.chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = els.chatInput.value.trim();
  if (!text && state.pendingFiles.length === 0) return;
  const blockMessage = currentComposerBlockMessage();
  if (blockMessage) {
    showToast(blockMessage);
    syncComposerSendControl();
    return;
  }

  const targets = composerTargets();
  els.sendButton.disabled = true;
  try {
    await ensureGptSendReady(targets, text);
    const result = await sendComposerPayload(text, targets);
    els.chatInput.value = "";
    syncComposerSendControl();
    await refreshWorkspaceSurface({ scrollToBottom: true });
    showToast(`已发送给 ${targetLabel(result?.message?.to || targets)}`);
  } catch (error) {
    showToast(error.message);
  } finally {
    els.sendButton.disabled = false;
  }
});

els.chatInput.addEventListener("input", () => {
  syncComposerSendControl();
});

els.chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    els.chatForm.requestSubmit();
  }
});

setTheme(state.theme);
setModePreference(state.modePreference);
setModelPreference(state.modelPreference);
syncComposerSendControl();
api("/api/config")
  .then((config) => {
    state.currentCodexThreadId = config.currentCodexThreadId || null;
    return loadProjects({
      autoEnter: Boolean(PAGE_PROJECT_ID),
      preferredProjectId: PAGE_PROJECT_ID
    });
  })
  .catch((error) => {
    showProjects();
    showToast(error.message);
  });

window.setInterval(() => {
  if (!els.chatView.classList.contains("is-hidden")) {
    refreshWorkspaceSurface({ scrollToBottom: false }).catch(() => {});
  }
}, 4000);
