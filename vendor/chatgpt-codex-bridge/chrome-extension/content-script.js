const BRIDGE_ORIGIN = String(globalThis.CODEX_BRIDGE_CONFIG?.origin || "").replace(/\/+$/, "");
if (!BRIDGE_ORIGIN) {
  throw new Error("Codex GPT Bridge extension is missing bridge-config.js");
}
globalThis.__CODEX_GPT_BRIDGE_CONTENT_SCRIPT_ACTIVE__ = true;
const WORKER_ID = "codex-chatgpt-project-extension-v20260801-adaptive-office-wait";
const POLL_MS = 1500;
const HEARTBEAT_REQUEST_TIMEOUT_MS = 5_000;
const RESPONSE_IDLE_TIMEOUT_MS = 15 * 60_000;
const RESPONSE_HARD_TIMEOUT_MS = 45 * 60_000;
const ACTIVE_JOB_CHECK_INTERVAL_MS = 3000;
const DOWNLOAD_CAPTURE_TIMEOUT_MS = 120000;
const DOWNLOAD_CAPTURE_PROBE_TIMEOUT_MS = 15000;
const PAGE_CONTEXT_FETCH_TIMEOUT_MS = 20000;
const PRE_SEND_TIMEOUT_MS = 30000;
const MAX_UNSENT_CLAIM_AGE_MS = 60_000;
const MAX_TRUSTED_INSERT_TEXT_LENGTH = 4096;
const STREAMING_REPLY_PROBE_MS = 2500;
const ASSISTANT_ACTIVITY_COALESCE_MS = 250;
const PRE_SEND_REFRESH_KEY = "chatgpt-codex-bridge:pre-send-refresh-job";
const HEARTBEAT_RECOVERY_KEY = "chatgpt-codex-bridge:last-heartbeat-recovery";
const CLIENT_ID_KEY = "chatgpt-codex-bridge:client-id";
const EXTENSION_RELOAD_COOLDOWN_KEY = "chatgpt-codex-bridge:extension-reload-requested-at";
const EXTENSION_RELOAD_COOLDOWN_MS = 60_000;
const HEARTBEAT_RECOVERY_COOLDOWN_MS = 60_000;

let busy = false;
let lastHeartbeatPreferenceKey = null;
let failedHeartbeatPreferenceKey = null;
let lastPreferenceStatus = null;
let lastPreferenceAttemptDiagnostic = null;
let lastCaptureStatus = null;
let fallbackClientId = null;
let pollInFlight = false;
let busyHeartbeatInFlight = false;
let cachedBridgeApiToken = String(globalThis.CODEX_BRIDGE_CONFIG?.apiToken || "");
let bridgeApiTokenPromise = null;
let assistantActivityObserver = null;
let assistantActivityNotifyTimer = null;
const assistantActivityWaiters = new Set();

function newBridgeClientId() {
  return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function bridgeClientId() {
  try {
    if (typeof sessionStorage !== "undefined") {
      const existing = sessionStorage.getItem(CLIENT_ID_KEY);
      if (existing) {
        return existing;
      }
      const created = newBridgeClientId();
      sessionStorage.setItem(CLIENT_ID_KEY, created);
      return created;
    }
  } catch {
    // Fall back to an in-memory id when browser storage is unavailable.
  }

  if (!fallbackClientId) {
    fallbackClientId = newBridgeClientId();
  }
  return fallbackClientId;
}

function currentWorkerId() {
  const runtimeState =
    typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function"
      ? "runtime-ok"
      : "runtime-missing";
  return `${WORKER_ID}:${runtimeState}:${bridgeClientId()}`;
}

function lightweightBusyPageStatus() {
  if (isGenerating()) {
    return {
      state: "working",
      code: "active_generation",
      recoveryAction: "wait_for_generation",
      message: "GPT 正在生成当前回复。"
    };
  }
  return {
    state: "working",
    code: "bridge_busy",
    recoveryAction: "wait_for_bridge",
    message: "Bridge is processing the current GPT job."
  };
}

async function sendHeartbeat(options = {}) {
  return bridgeApi("/api/extension/heartbeat", {
    method: "POST",
    bridgeRequestTimeoutMs: HEARTBEAT_REQUEST_TIMEOUT_MS,
    skipBackgroundOnTimeout: true,
    body: JSON.stringify({
      workerId: currentWorkerId(),
      href: location.href,
      title: document.title || "",
      preferenceStatus: lastPreferenceStatus,
      pageStatus: options.lightweight ? lightweightBusyPageStatus() : currentPageStatus(),
      captureStatus: lastCaptureStatus
    })
  });
}

function maybeReloadExtensionFromHeartbeat(heartbeat) {
  if (!heartbeat?.reloadExtension) {
    return false;
  }
  if (typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
    return false;
  }
  try {
    const previous = Number(sessionStorage.getItem(EXTENSION_RELOAD_COOLDOWN_KEY) || 0);
    const now = Date.now();
    if (previous && now - previous < EXTENSION_RELOAD_COOLDOWN_MS) {
      return true;
    }
    sessionStorage.setItem(EXTENSION_RELOAD_COOLDOWN_KEY, String(now));
    chrome.runtime.sendMessage({
      type: "bridge:reloadExtension",
      expectedVersion: heartbeat.expectedExtensionVersion || null
    });
    if (typeof location !== "undefined" && typeof location.reload === "function") {
      setTimeout(() => {
        try {
          location.reload();
        } catch {
          // Reload is a best-effort handoff so the freshly loaded extension injects the new content script.
        }
      }, 750);
    }
    return true;
  } catch {
    return false;
  }
}

async function maybeOpenProjectTabFromHeartbeat(heartbeat) {
  const target = heartbeat?.openTarget;
  if (
    target?.action !== "open_project_tab" ||
    !target.projectUrl ||
    projectUrlMatchesCurrentPage(target.projectUrl) ||
    !canAskBackgroundForDownloads()
  ) {
    return false;
  }
  try {
    const result = await chromeRuntimeMessage(
      {
        type: "bridge:openProjectTab",
        jobId: target.jobId || null,
        projectUrl: target.projectUrl
      },
      {
        timeoutMs: 3000,
        timeoutMessage: "Chrome did not open the pending GPT project tab"
      }
    );
    return Boolean(result?.ok);
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function notifyAssistantActivity() {
  const waiters = [...assistantActivityWaiters];
  assistantActivityWaiters.clear();
  for (const resolve of waiters) {
    resolve(true);
  }
}

function scheduleAssistantActivityNotification() {
  if (assistantActivityWaiters.size === 0 || assistantActivityNotifyTimer !== null) {
    return;
  }
  assistantActivityNotifyTimer = setTimeout(() => {
    assistantActivityNotifyTimer = null;
    notifyAssistantActivity();
  }, ASSISTANT_ACTIVITY_COALESCE_MS);
}

function installAssistantActivityObserver() {
  if (assistantActivityObserver) {
    return true;
  }
  if (typeof MutationObserver !== "function") {
    return false;
  }
  const target = document?.documentElement || document?.body || null;
  if (!target) {
    return false;
  }

  try {
    assistantActivityObserver = new MutationObserver(() => {
      scheduleAssistantActivityNotification();
    });
    assistantActivityObserver.observe(target, {
      childList: true,
      characterData: true,
      subtree: true
    });
    return true;
  } catch {
    assistantActivityObserver = null;
    return false;
  }
}

function waitForAssistantActivity(timeoutMs = 1000) {
  if (!installAssistantActivityObserver()) {
    return sleep(timeoutMs).then(() => false);
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (changed) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      assistantActivityWaiters.delete(onActivity);
      resolve(changed);
    };
    const onActivity = () => finish(true);
    assistantActivityWaiters.add(onActivity);
    timer = setTimeout(() => finish(false), Math.max(0, Number(timeoutMs) || 0));
  });
}

function responseWaitLimits() {
  return {
    idleTimeoutMs: RESPONSE_IDLE_TIMEOUT_MS,
    hardTimeoutMs: RESPONSE_HARD_TIMEOUT_MS
  };
}

function responseWaitExpired({
  startedAt,
  lastActivityAt,
  now = Date.now(),
  pageStillGenerating = false
} = {}) {
  if (now - startedAt >= RESPONSE_HARD_TIMEOUT_MS) {
    return true;
  }
  if (pageStillGenerating) {
    return false;
  }
  return now - lastActivityAt >= RESPONSE_IDLE_TIMEOUT_MS;
}

function preSendTimeoutMs(job = {}) {
  const explicit = Number(job._bridgePreSendTimeoutMs);
  return Number.isFinite(explicit) && explicit > 0 ? explicit : PRE_SEND_TIMEOUT_MS;
}

function unsentClaimAgeMs(job = {}, nowMs = Date.now()) {
  if (job.sentAt || !job.claimedAt) {
    return 0;
  }
  const claimedAtMs = Date.parse(job.claimedAt);
  if (!Number.isFinite(claimedAtMs)) {
    return 0;
  }
  return Math.max(0, nowMs - claimedAtMs);
}

function preSendClaimExpired(job = {}, nowMs = Date.now()) {
  return !job.sentAt && Boolean(job.claimedAt) && unsentClaimAgeMs(job, nowMs) >= MAX_UNSENT_CLAIM_AGE_MS;
}

function preSendExpiredError() {
  return bridgeClassifiedError(
    "G某T 任务已被扩展领取，但 60 秒内没有真正发送。Bridge 已终止本次发送并释放队列，请重试。",
    {
      errorCode: "pre_send_expired",
      recoveryAction: "retry"
    }
  );
}

async function withPreSendTimeout(job, operation) {
  let timeoutId = null;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          const error = new Error("GPT 页面准备发送超时，Bridge 会刷新绑定会话后重试。");
          error.errorCode = "pre_send_timeout";
          reject(error);
        }, preSendTimeoutMs(job));
      })
    ]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

function bridgeMutationMethod(method = "GET") {
  return ["POST", "PATCH", "PUT", "DELETE"].includes(String(method || "GET").toUpperCase());
}

async function fetchBridgeApi(url, options = {}, timeoutMs = 0) {
  const boundedTimeoutMs = Number(timeoutMs);
  if (!(boundedTimeoutMs > 0) || typeof AbortController !== "function" || options.signal) {
    return fetch(url, options);
  }

  const controller = new AbortController();
  let timeoutId = null;
  let timedOut = false;
  try {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, boundedTimeoutMs);
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (timedOut) {
      const timeoutError = new Error(`Bridge API request timed out after ${boundedTimeoutMs}ms`);
      timeoutError.errorCode = "bridge_api_timeout";
      timeoutError.recoveryAction = "retry";
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

async function loadBridgeApiToken(force = false, timeoutMs = 0) {
  if (!force && cachedBridgeApiToken) {
    return cachedBridgeApiToken;
  }
  if (!force && bridgeApiTokenPromise) {
    return bridgeApiTokenPromise;
  }
  bridgeApiTokenPromise = fetchBridgeApi(`${BRIDGE_ORIGIN}/api/config`, {
    headers: {
      "Content-Type": "application/json"
    },
    cache: "no-store"
  }, timeoutMs)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Bridge API token bootstrap failed with status ${response.status}`);
      }
      const config = await response.json();
      const token = String(config?.apiToken || "");
      if (!token) {
        throw new Error("Bridge API token bootstrap returned no token");
      }
      cachedBridgeApiToken = token;
      return token;
    })
    .finally(() => {
      bridgeApiTokenPromise = null;
    });
  return bridgeApiTokenPromise;
}

async function bridgeApi(path, options = {}) {
  const {
    bridgeRequestTimeoutMs = 0,
    skipBackgroundOnTimeout = false,
    ...fetchOptions
  } = options;
  const mutation = bridgeMutationMethod(fetchOptions.method);
  const token = cachedBridgeApiToken;
  const request = (requestToken) => fetchBridgeApi(`${BRIDGE_ORIGIN}${path}`, {
    ...fetchOptions,
    headers: {
      "Content-Type": "application/json",
      ...(requestToken ? { "X-Bridge-Token": requestToken } : {}),
      ...(fetchOptions.headers || {})
    }
  }, bridgeRequestTimeoutMs);
  let response = null;
  try {
    response = await request(token);
  } catch (error) {
    if ((skipBackgroundOnTimeout && error?.errorCode === "bridge_api_timeout") || !canAskBackgroundForDownloads()) {
      throw error;
    }
    response = await bridgeApiThroughBackground(path, fetchOptions);
  }
  if (response.status === 403 && canAskBackgroundForDownloads()) {
    response = await bridgeApiThroughBackground(path, fetchOptions);
  }
  if (mutation && response.status === 401) {
    try {
      response = await request(await loadBridgeApiToken(true, bridgeRequestTimeoutMs));
    } catch (error) {
      if ((skipBackgroundOnTimeout && error?.errorCode === "bridge_api_timeout") || !canAskBackgroundForDownloads()) {
        throw error;
      }
      response = await bridgeApiThroughBackground(path, fetchOptions);
    }
  }

  if (!response.ok) {
    const responseText = await response.text();
    let responseBody = null;
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      // Keep non-JSON Bridge errors as plain text.
    }
    const error = new Error(responseBody?.error || responseText);
    error.status = response.status;
    error.errorCode = responseBody?.code || responseBody?.errorCode || null;
    error.recoveryAction = responseBody?.recoveryAction || null;
    throw error;
  }

  return response.json();
}

async function bridgeApiThroughBackground(path, options = {}) {
  const result = await chromeRuntimeMessage(
    {
      type: "bridge:api",
      bridgeOrigin: BRIDGE_ORIGIN,
      path,
      options: {
        method: options.method || "GET",
        body: options.body,
        cache: options.cache,
        headers: options.headers
      }
    },
    {
      timeoutMs: 15_000,
      timeoutMessage: "Bridge background API proxy timed out"
    }
  );
  if (!result?.ok || !result.response) {
    throw new Error(result?.error || "Bridge background API proxy failed");
  }
  const bodyText = String(result.response.bodyText || "");
  return {
    ok: Boolean(result.response.ok),
    status: Number(result.response.status || 0),
    async text() {
      return bodyText;
    },
    async json() {
      return bodyText ? JSON.parse(bodyText) : {};
    }
  };
}

function isRetryableCompletionApiError(error = {}) {
  return ["empty_chatgpt_reply", "interim_chatgpt_reply"].includes(error.errorCode);
}

function bridgeUrl(pathOrUrl = "") {
  if (/^https?:\/\//i.test(pathOrUrl)) {
    return pathOrUrl;
  }
  return `${BRIDGE_ORIGIN}${pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`}`;
}

function findComposer() {
  return (
    document.querySelector("#prompt-textarea") ||
    document.querySelector('[contenteditable="true"][data-testid="prompt-textarea"]') ||
    document.querySelector("textarea")
  );
}

async function waitForComposer(timeoutMs = 60000) {
  const started = Date.now();
  const observesPageChanges = installAssistantActivityObserver();
  let pageBlockerScanNeeded = true;
  while (Date.now() - started < timeoutMs) {
    if (pageBlockerScanNeeded) {
      assertNoChatGptBlocker();
      pageBlockerScanNeeded = false;
    }
    const composer = findComposer();
    if (composer) {
      return composer;
    }
    const pageChanged = await waitForAssistantActivity(500);
    pageBlockerScanNeeded = !observesPageChanges || pageChanged || pageBlockerScanNeeded;
  }
  if (isChatGptLoadingShell()) {
    throw new Error("GPT 页面仍在加载，输入框还没有出现。");
  }
  throw new Error("GPT 输入框没有找到。");
}

function pageTextSnapshot() {
  return normalizeText(
    document.body?.innerText ||
      document.body?.textContent ||
      document.documentElement?.innerText ||
      document.documentElement?.textContent ||
      document.title ||
      ""
  );
}

function pageBodyTextSnapshot() {
  return normalizeText(
    document.body?.innerText ||
      document.body?.textContent ||
      document.documentElement?.innerText ||
      document.documentElement?.textContent ||
      ""
  );
}

function hasVisibleComposerForBlockerCheck() {
  const composer = findComposer();
  if (composer && isVisibleElement(composer)) {
    return true;
  }

  return visibleElements('textarea, [contenteditable="true"], [contenteditable=\'true\'], #prompt-textarea').length > 0;
}

function pageLooksClientBlocked(text = pageTextSnapshot()) {
  const normalized = normalizeText(text);
  if (!/err_blocked_by_client|blocked by client|chrome.*blocked|\u5df2\u88ab\u5c4f\u853d|\u88ab\s*chrome\s*\u5c4f\u853d/i.test(normalized)) {
    return false;
  }

  return !hasVisibleComposerForBlockerCheck();
}

function isAccountSelectionBlockerText(text = "") {
  const normalized = normalizeText(text);
  return (
    /welcome back.{0,120}(?:choose|select|account|continue)|choose an account|select an account|log in to another account|create account/i.test(normalized) ||
    /\u6b22\u8fce\u56de\u6765.{0,120}(?:\u9009\u62e9|\u8d26\u53f7|\u8d26\u6237|\u7ee7\u7eed|\u767b\u5f55|\u521b\u5efa)/i.test(normalized) ||
    /\u9009\u62e9.{0,20}(?:\u8d26\u53f7|\u8d26\u6237).{0,60}(?:\u7ee7\u7eed|\u767b\u5f55)/i.test(normalized)
  );
}

function elementTextSnapshot(element) {
  return normalizeText([element?.innerText, element?.textContent].filter(Boolean).join(" "));
}

function visibleElements(selector) {
  try {
    return [...document.querySelectorAll(selector)].filter(isVisibleElement);
  } catch {
    return [];
  }
}

function visibleDialogLikeElements() {
  return visibleElements(
    [
      "[role='dialog']",
      '[role="dialog"]',
      "[aria-modal='true']",
      '[aria-modal="true"]',
      "[data-testid*='modal']",
      '[data-testid*="modal"]',
      "[data-testid*='account']",
      '[data-testid*="account"]'
    ].join(",")
  );
}

function hasVisibleAccountSelectionDialog() {
  return visibleDialogLikeElements().some((element) => isAccountSelectionBlockerText(elementTextSnapshot(element)));
}

function pageLooksUnavailableWithoutComposer(text = pageTextSnapshot()) {
  return (
    !findComposer() &&
    /not found|could not be found|content unavailable|conversation not found|\u5185\u5bb9\u4e0d\u53ef\u7528|\u672a\u627e\u5230/i.test(text)
  );
}

function pageLooksAccountSelectionWithoutComposer(text = pageTextSnapshot()) {
  return !findComposer() && isAccountSelectionBlockerText(text);
}

function generationFailureBlocker() {
  return {
    code: "generation_failed",
    recoveryAction: "retry_or_new_chat",
    message: "GPT 这次生成失败，请重试或换一个会话后再发送。"
  };
}

function hasGenerationFailureText(value = "") {
  return /something went wrong while generating the response|something seems to have gone wrong|\u751f\u6210\u56de\u590d\u65f6\u51fa\u9519|\u751f\u6210\u5931\u8d25/i.test(
    normalizeText(value)
  );
}

function detectScopedGenerationFailure(options = {}) {
  if (options.afterUserText) {
    const turns = assistantTurnsAfterUserText(options.afterUserText);
    const lastTurn = turns[turns.length - 1];
    if (lastTurn && hasGenerationFailureText(lastTurn.textContent || "")) {
      return generationFailureBlocker();
    }
    return null;
  }

  if (options.includeGenerationFailure && hasGenerationFailureText(pageTextSnapshot())) {
    return generationFailureBlocker();
  }

  return null;
}

function detectChatGptBlocker(options = {}) {
  const text = options.pageText ?? pageTextSnapshot();
  if (!text) {
    return null;
  }

  if (pageLooksClientBlocked(text)) {
    return {
      code: "client_blocked",
      recoveryAction: "disable_client_blocker",
      message: "GPT \u9875\u9762\u88ab Chrome \u6216\u5176\u5b83\u6269\u5c55\u62e6\u622a\u4e86\u3002\u8bf7\u5173\u95ed\u62e6\u622a chatgpt.com \u7684\u6269\u5c55\u6216\u52a0\u5165\u767d\u540d\u5355\u540e\uff0c\u53ea\u5237\u65b0\u7ed1\u5b9a\u4f1a\u8bdd\u3002"
    };
  }

  if (/cloudflare|verify you are human|\u8bf7\u9a8c\u8bc1\u60a8\u662f\u771f\u4eba|\u771f\u4eba\u9a8c\u8bc1/i.test(text)) {
    return {
      code: "human_verification",
      recoveryAction: "manual_verification",
      message: "GPT \u6b63\u5728\u8981\u6c42\u771f\u4eba\u9a8c\u8bc1\u3002\u8bf7\u5728 GPT \u9875\u9762\u624b\u52a8\u5b8c\u6210\u9a8c\u8bc1\uff0cBridge \u4e0d\u4f1a\u7ed5\u8fc7\u9a8c\u8bc1\u3002"
    };
  }

  if (pageLooksUnavailableWithoutComposer(text)) {
    return {
      code: "conversation_unavailable",
      recoveryAction: "rebind_conversation",
      message: "\u7ed1\u5b9a\u7684 GPT \u4f1a\u8bdd\u4e0d\u53ef\u7528\u6216\u627e\u4e0d\u5230\u3002\u8bf7\u91cd\u65b0\u7ed1\u5b9a\u4e00\u4e2a\u80fd\u6253\u5f00\u7684\u4f1a\u8bdd\u3002"
    };
  }

  const scopedGenerationFailure = detectScopedGenerationFailure(options);
  if (scopedGenerationFailure) {
    return scopedGenerationFailure;
  }

  if (hasVisibleAccountSelectionDialog() || pageLooksAccountSelectionWithoutComposer(text)) {
    return {
      code: "account_selection",
      recoveryAction: "manual_account_confirmation",
      message: "GPT 停在账号选择或登录确认页。请手动确认当前账号后重试。"
    };
  }

  return null;
}

function currentPageStatus() {
  const composer = findComposer();
  const artifactPreview = isArtifactPreviewPage();
  const pageGenerating = isGenerating();
  if (composer && !artifactPreview && !pageGenerating && !hasVisibleAccountSelectionDialog()) {
    return {
      state: "ready",
      code: "ready",
      message: "GPT 页面已就绪。"
    };
  }

  const pageText = pageTextSnapshot();
  const blocker = detectChatGptBlocker({ pageText });
  if (blocker) {
    return {
      state: "blocked",
      code: blocker.code,
      recoveryAction: blocker.recoveryAction,
      message: blocker.message
    };
  }

  if (isChatGptLoadingShell()) {
    return {
      state: "working",
      code: "loading_shell",
      recoveryAction: "wait_or_refresh_bound_page",
      message: "GPT \u9875\u9762\u4ecd\u5728\u52a0\u8f7d\uff0c\u6682\u65f6\u4e0d\u80fd\u63a5\u6536 Bridge \u4efb\u52a1\u3002"
    };
  }

  if (isChatGptStartPage(pageText)) {
    return {
      state: "blocked",
      code: "start_page",
      recoveryAction: "rebind_conversation",
      message: "GPT 当前停在新聊天首页，不是绑定会话。"
    };
  }

  if (artifactPreview) {
    return {
      state: "working",
      code: "artifact_preview",
      recoveryAction: "close_preview",
      message: "GPT 正在显示文件预览，Bridge 会先回到绑定会话。"
    };
  }

  if (pageGenerating) {
    return {
      state: "working",
      code: "active_generation",
      recoveryAction: "wait_for_generation",
      message: "GPT 正在生成上一条回复，Bridge 会等它结束后继续。"
    };
  }

  if (!findComposer()) {
    return {
      state: "warning",
      code: "composer_missing",
      recoveryAction: "refresh_bound_page",
      message: "GPT 输入框暂时不可用，可能页面仍在加载或被弹窗阻挡。"
    };
  }

  return {
    state: "ready",
    code: "ready",
    message: "GPT 页面已就绪。"
  };
}

function isChatGptStartPage(text = pageTextSnapshot()) {
  return /what can i help with|where should we begin|\u6211\u4eec\u5148\u4ece\u54ea\u91cc\u5f00\u59cb|\u6211\u80fd\u5e2e\u4ec0\u4e48/i.test(text);
}

function isChatGptLoadingShell() {
  const title = normalizeText(document.title || "");
  return /闂佽崵濮村ú顓⑺夐幘璇茬厽闁靛繈鍊曠壕瑙勪繆缂併垺顫沷ading|loading|please wait|just a moment/i.test(title) && !findComposer() && !pageBodyTextSnapshot();
}

function assertNoChatGptBlocker(options = {}) {
  const blocker = detectChatGptBlocker(options);
  if (blocker) {
    throw bridgeClassifiedError(blocker.message, {
      errorCode: blocker.code,
      recoveryAction: blocker.recoveryAction
    });
  }
}

function bridgeClassifiedError(message, details = {}) {
  const error = new Error(message);
  if (details.errorCode) {
    error.errorCode = details.errorCode;
  }
  if (details.recoveryAction) {
    error.recoveryAction = details.recoveryAction;
  }
  return error;
}

function bridgeFailurePayload(error = {}) {
  const message = error?.message || String(error || "GPT 同步失败");
  let errorCode = error.errorCode || null;
  let recoveryAction = error.recoveryAction || null;
  if (!errorCode && /attachment did not appear|GPT \u9644\u4ef6\u6ca1\u6709\u51fa\u73b0\u5728\u8f93\u5165\u6846|file input not found|\u6587\u4ef6\u8f93\u5165\u63a7\u4ef6\u6ca1\u6709\u627e\u5230/i.test(message)) {
    errorCode = "attachment_upload_failed";
    recoveryAction = "refresh_bound_page";
  } else if (!errorCode && /Timed out waiting for (?:ChatGPT|GPT) reply|\u7b49\u5f85\s*GPT\s*\u56de\u590d\u8d85\u65f6/i.test(message)) {
    errorCode = "reply_timeout";
    recoveryAction = "refresh_bound_page";
  } else if (!errorCode && /start page|new chat|wrong page|\u65b0\u804a\u5929\u9996\u9875/i.test(message)) {
    errorCode = "start_page";
    recoveryAction = "rebind_conversation";
  }
  return {
    error: message,
    ...(errorCode ? { errorCode } : {}),
    ...(recoveryAction ? { recoveryAction } : {}),
    ...(error.details && typeof error.details === "object" ? { failureDetails: error.details } : {})
  };
}

function syncJobMutationBody(input = {}) {
  return {
    ...input,
    workerId: currentWorkerId()
  };
}

function updateCaptureStatus(job, state, details = {}) {
  lastCaptureStatus = {
    jobId: job?.id || null,
    state,
    ...details,
    updatedAt: new Date().toISOString()
  };
  return lastCaptureStatus;
}

function recordCompletionCaptureStatus(job, completion = null, details = {}) {
  const completedJob = completion?.job || null;
  if (completedJob?.status && completedJob.status !== "succeeded") {
    updateCaptureStatus(job, completedJob.status === "failed" ? "completion_failed" : "completion_pending", {
      completionStatus: completedJob.status,
      errorCode: completedJob.errorCode || null,
      error: completedJob.error || null
    });
    return false;
  }
  updateCaptureStatus(job, "captured", details);
  return true;
}

function ensureExpectedChatGptPage(job = {}) {
  assertNoChatGptBlocker();

  if (job.projectUrl && normalizeNavigationUrl(location.href) !== normalizeNavigationUrl(job.projectUrl)) {
    if (refreshBeforeSending(job, { force: true })) {
      return false;
    }
    throw new Error("当前 GPT 页面不是绑定会话。请重新绑定一个能打开的 GPT 会话。");
  }

  if (isChatGptStartPage()) {
    throw new Error("当前 GPT 页面是新聊天首页，Bridge 已阻止发送；请重新打开或绑定目标 GPT 会话。");
  }

  return true;
}

function setComposerText(composer, text) {
  composer.focus();

  if (composer.tagName === "TEXTAREA" || composer.tagName === "INPUT") {
    composer.value = text;
    composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    return;
  }

  // Keep the fallback asynchronous-DOM-safe. Synchronous execCommand over a
  // long conversation can block the page before Bridge records the send.
  composer.textContent = "";
  composer.innerText = "";
  composer.textContent = text;
  composer.innerText = text;
  composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
}

async function fillComposerText(composer, text) {
  const value = String(text || "");
  const isTextInput = composer.tagName === "TEXTAREA" || composer.tagName === "INPUT";
  if (!isTextInput && value) {
    composer.focus();
    if (value.length <= MAX_TRUSTED_INSERT_TEXT_LENGTH && canAskBackgroundForDownloads()) {
      try {
        const inserted = await chromeRuntimeMessage(
          {
            type: "bridge:trustedInsertText",
            text: value
          },
          {
            timeoutMs: 8000,
            timeoutMessage: "trusted text insertion timed out"
          }
        );
        if (inserted?.ok) {
          return;
        }
      } catch {
        // Fall through to a direct DOM update without the synchronous execCommand path.
      }
    }

    composer.textContent = value;
    composer.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: null
      })
    );
    return;
  }

  setComposerText(composer, value);
}

function composerText(composer) {
  if (!composer) {
    return "";
  }
  if (composer.tagName === "TEXTAREA" || composer.tagName === "INPUT") {
    return composer.value || "";
  }
  return composer.innerText || composer.textContent || "";
}

function composerContainsBridgeDraft(composer, draft = "") {
  const current = normalizeText(composerText(composer));
  const expected = normalizeText(draft);
  return Boolean(current && expected && current === expected);
}

function truncateDiagnosticText(value = "", maxLength = 220) {
  const text = normalizeText(String(value || ""));
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function buttonDiagnosticInfo(button) {
  if (!button) {
    return null;
  }
  const label = `${button.getAttribute?.("aria-label") || ""} ${button.title || ""} ${button.textContent || ""}`;
  return {
    label: truncateDiagnosticText(label, 120),
    disabled: isDisabledButton(button),
    visible: isVisibleElement(button)
  };
}

function visibleButtonDiagnostics(limit = 8) {
  return [...document.querySelectorAll("button")]
    .filter(isVisibleElement)
    .map(buttonDiagnosticInfo)
    .filter(Boolean)
    .filter((button) => button.label)
    .slice(-limit);
}

function sendConfirmationError(job, context = {}) {
  const error = new Error("GPT 点击发送后没有显示已提交的提示。");
  error.errorCode = "send_not_confirmed";
  error.recoveryAction = "manual_send_or_refresh";
  const composer = context.composer || null;
  error.details = {
    reason: "send_not_confirmed",
    href: location.href,
    promptLength: String(job?.payloadText || "").length,
    composerTextAfterSend: truncateDiagnosticText(composerText(composer)),
    composerStillContainsDraft: Boolean(composer && job?.payloadText && composerContainsBridgeDraft(composer, job.payloadText)),
    sendButton: buttonDiagnosticInfo(context.sendButton),
    sendAttempt: context.sendAttempt || null
  };
  return error;
}

function sendButtonNotReadyError(job, context = {}) {
  const error = new Error("GPT 发送按钮还没有准备好。");
  error.errorCode = "send_button_not_ready";
  error.recoveryAction = "wait_or_refresh_bound_page";
  const composer = context.composer || null;
  error.details = {
    reason: "send_button_not_ready",
    href: location.href,
    promptLength: String(job?.payloadText || "").length,
    composerTextBeforeSend: truncateDiagnosticText(composerText(composer)),
    composerContainsDraft: Boolean(composer && job?.payloadText && composerContainsBridgeDraft(composer, job.payloadText)),
    visibleButtons: visibleButtonDiagnostics()
  };
  return error;
}

function clearComposerText(composer) {
  if (!composer) {
    return;
  }
  setComposerText(composer, "");
}

function clearBridgeDraftIfPresent(composer, draft = "") {
  if (composerContainsBridgeDraft(composer, draft)) {
    clearComposerText(composer);
    return true;
  }
  return false;
}

function modeLabelsForPreference(preference = "", modelPreference = "") {
  const model = String(modelPreference || "").trim();
  const labels = {
    fast: model === "gpt-5.6-sol" ? ["极速 5.5", "\u6781\u901f"] : ["\u6781\u901f", "极速 5.5"],
    balanced: ["中", "\u5747\u8861"],
    advanced: ["高", "\u9ad8\u7ea7"],
    high: ["极高", "\u8d85\u9ad8"],
    pro:
      model === "gpt-5.5"
        ? ["Pro 深度模式", "Pro", "Pro \u6269\u5c55", "\u4e13\u4e1a"]
        : model === "gpt-5.4"
        ? ["Pro", "\u4e13\u4e1a", "Pro \u6269\u5c55"]
        : ["Pro", "Pro \u6269\u5c55", "\u4e13\u4e1a"]
  };
  return labels[String(preference || "").trim()] || [];
}

function modeLabelForPreference(preference = "", modelPreference = "") {
  return modeLabelsForPreference(preference, modelPreference)[0] || null;
}

function modePreferencesForModel(modelPreference) {
  const preferences = {
    "gpt-5.6-sol": ["fast", "balanced", "advanced", "high", "pro"],
    "gpt-5.5": ["fast", "balanced", "advanced", "high", "pro"],
    "gpt-5.4": ["fast", "balanced", "advanced", "high", "pro"],
    "gpt-5.3": ["fast"],
    o3: []
  };
  return preferences[String(modelPreference || "").trim()] || [];
}

function compatibleModePreference(modelPreference, modePreference) {
  const mode = String(modePreference || "").trim();
  const allowedModes = modePreferencesForModel(modelPreference);
  if (!allowedModes.length) {
    return modelPreference ? null : modeLabelForPreference(mode) ? mode : null;
  }
  if (!modeLabelForPreference(mode)) {
    return null;
  }
  return allowedModes.includes(mode) ? mode : allowedModes[0];
}

function modelLabelsForPreference(preference = "") {
  const labels = {
    "gpt-5.6-sol": ["GPT-5.6 Sol", "5.6 Sol"],
    "gpt-5.5": ["GPT-5.5", "5.5"],
    "gpt-5.4": ["GPT-5.4", "5.4"],
    "gpt-5.3": ["GPT-5.3", "5.3"],
    o3: ["o3"]
  };
  return labels[String(preference || "").trim()] || [];
}

function modelLabelForPreference(preference = "") {
  return modelLabelsForPreference(preference)[0] || null;
}

function modelSupportsModePreference(modelPreference) {
  const model = String(modelPreference || "").trim();
  return modePreferencesForModel(model).length > 0;
}

function normalizeChatGptPreferences(preferences = {}) {
  const modelPreference = modelLabelForPreference(preferences.modelPreference) ? String(preferences.modelPreference || "").trim() : null;
  const modePreference = modeLabelForPreference(preferences.modePreference) ? String(preferences.modePreference || "").trim() : null;
  return {
    ...preferences,
    modePreference: modelPreference ? compatibleModePreference(modelPreference, modePreference) : modePreference,
    modelPreference
  };
}

function modelControlText(element) {
  return normalizeText(
    `${element?.textContent || ""} ${element?.getAttribute?.("aria-label") || ""} ${element?.title || ""}`
  );
}

function looksLikeModelControl(element) {
  const text = modelControlText(element);
  return /閺嬩線鈧劜閸у洩銆€|妤傛楠噟鐡掑懘鐝畖娑撴挷绗焲Pro 閹碘晛鐫峾闁哄绶氶埀鐟嬮柛褍娲﹟濡ゅ倹顭囨鍣熼悺鎺戞嚇閻濈晼濞戞挻鎸风粭鐒睵ro 闁圭鏅涢惈宄鹃柡鍛寸細閸忔GPT-5|o3|model/i.test(text);
}

function looksLikeModelControlClean(element) {
  const text = modelControlText(element);
  return /閺嬩線鈧劜閸у洩銆€|妤傛楠噟鐡掑懘鐝畖娑撴挷绗焲Pro 閹碘晛鐫峾闁哄绶氶埀鐟嬮柛褍娲﹟濡ゅ倹顭囨鍣熼悺鎺戞嚇閻濈晼濞戞挻鎸风粭鐒睵ro 闁圭鏅涢惈宄鹃柡鍛寸細閸忔GPT-5|o3|model/i.test(text);
}

function findModelControl() {
  return [...document.querySelectorAll("button,[role='button']")].filter(isVisibleElement).find(looksLikeModelControlClean);
}

function knownModeLabels() {
  return ["fast", "balanced", "advanced", "high", "pro"].flatMap(modeLabelsForPreference).filter(Boolean);
}

function knownModelLabels() {
  return ["gpt-5.6-sol", "gpt-5.5", "gpt-5.4", "gpt-5.3", "o3"].flatMap(modelLabelsForPreference).filter(Boolean);
}

function looksLikeSpecificModeControl(element) {
  const text = modelControlText(element);
  return knownModeLabels().some((label) => text.includes(label)) && !knownModelLabels().some((label) => text.includes(label));
}

function looksLikeSpecificModelControl(element) {
  const text = modelControlText(element);
  return knownModelLabels().some((label) => text.includes(label)) || /\bmodel\b/i.test(text);
}

function isConversationTurnElement(element) {
  return Boolean(element?.closest?.('[data-testid^="conversation-turn-"]'));
}

function preferenceControlScopes() {
  const composer = findComposer();
  const scopes = [];
  const addScope = (scope) => {
    if (scope && !scopes.includes(scope)) {
      scopes.push(scope);
    }
  };

  if (composer) {
    addScope(composer.closest?.("form"));
    addScope(composer.closest?.('[data-testid*="composer"]'));

    let parent = composer.parentElement;
    for (let index = 0; parent && index < 5; index += 1) {
      addScope(parent);
      parent = parent.parentElement;
    }
  }

  addScope(document);
  return scopes;
}

function preferenceControlsFromScope(scope) {
  return [...(scope.querySelectorAll?.("button,[role='button']") || [])]
    .filter(isVisibleElement)
    .filter((element) => !isConversationTurnElement(element));
}

function preferenceLabels(labelOrLabels) {
  return (Array.isArray(labelOrLabels) ? labelOrLabels : [labelOrLabels]).filter(Boolean);
}

function textContainsPreferenceLabel(text, label) {
  if (!label) {
    return false;
  }
  if (/^\p{Script=Han}$/u.test(label)) {
    return new RegExp(`(^|[^\\p{Script=Han}])${escapeRegExp(label)}([^\\p{Script=Han}]|$)`, "u").test(text);
  }
  return text.includes(label);
}

function elementContainsAnyPreferenceLabel(element, labelOrLabels) {
  const labels = preferenceLabels(labelOrLabels);
  if (!labels.length) {
    return false;
  }
  const text = modelControlText(element);
  return labels.some((label) => textContainsPreferenceLabel(text, label));
}

function controlsContainPreference(controls, kind, labelOrLabels) {
  if (controls.some((element) => elementContainsAnyPreferenceLabel(element, labelOrLabels))) {
    return true;
  }

  if (kind === "mode") {
    return (
      controls.some(looksLikeSpecificModeControl) ||
      controls.some(looksLikeSpecificModelControl) ||
      controls.some(looksLikeModelControlClean)
    );
  }

  if (kind === "model") {
    return (
      controls.some(looksLikeSpecificModelControl) ||
      controls.some(looksLikeSpecificModeControl) ||
      controls.some(looksLikeModelControlClean)
    );
  }

  return controls.some(looksLikeSpecificModeControl) || controls.some(looksLikeSpecificModelControl) || controls.some(looksLikeModelControlClean);
}

function preferenceControlCandidates(kind, labelOrLabels) {
  let firstNonEmptyScopeControls = null;
  for (const scope of preferenceControlScopes()) {
    const scopedControls = preferenceControlsFromScope(scope);
    if (!firstNonEmptyScopeControls && scopedControls.length > 0) {
      firstNonEmptyScopeControls = scopedControls;
    }
    if (controlsContainPreference(scopedControls, kind, labelOrLabels)) {
      return scopedControls;
    }
  }

  if (firstNonEmptyScopeControls) {
    return firstNonEmptyScopeControls;
  }

  return [...document.querySelectorAll("button,[role='button']")]
    .filter(isVisibleElement)
    .filter((element) => !isConversationTurnElement(element));
}

function findPreferenceControl(kind, labelOrLabels) {
  const controls = preferenceControlCandidates(kind, labelOrLabels);
  const predicate = kind === "mode" ? looksLikeSpecificModeControl : looksLikeSpecificModelControl;
  const specific = controls.find(predicate) || controls.find((element) => elementContainsAnyPreferenceLabel(element, labelOrLabels));
  if (specific) {
    return specific;
  }
  if (kind === "model") {
    return controls.find(looksLikeSpecificModeControl) || controls.find(looksLikeModelControlClean);
  }
  if (kind === "mode") {
    return controls.find(looksLikeSpecificModelControl) || controls.find(looksLikeModelControlClean);
  }
  return null;
}

function findModelOption(labelOrLabels) {
  return bestMenuCandidate(labelOrLabels);
}

function preferenceElementDiagnostic(element) {
  return {
    text: modelControlText(element),
    tagName: String(element?.tagName || "").toLowerCase() || null,
    role: element?.getAttribute?.("role") || null,
    testId: element?.getAttribute?.("data-testid") || null,
    ariaLabel: element?.getAttribute?.("aria-label") || null
  };
}

function visiblePreferenceOptionDiagnostics() {
  const seen = new Set();
  return menuCandidateElements()
    .map(preferenceElementDiagnostic)
    .filter((item) => item.text && item.text.length <= 120)
    .filter((item) => {
      const key = `${item.tagName}|${item.role}|${item.testId}|${item.text}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 40);
}

function menuCandidateElements() {
  return [
    ...document.querySelectorAll("[role='menuitem'],[role='option'],button,div"),
    ...document.querySelectorAll("[role='menuitemradio']")
  ]
    .filter(isVisibleElement)
    .filter((element) => !isConversationTurnElement(element));
}

function knownPreferenceLabelCount(text) {
  return [...knownModeLabels(), ...knownModelLabels()].filter((label) => label && text.includes(label)).length;
}

function menuCandidateScore(element, label) {
  const text = modelControlText(element);
  if (!label || !text.includes(label)) {
    return -Infinity;
  }

  const role = String(element?.getAttribute?.("role") || "").toLowerCase();
  const tagName = String(element?.tagName || "").toLowerCase();
  const labelCount = knownPreferenceLabelCount(text);
  let score = 0;

  if (text === label) {
    score += 80;
  } else if (new RegExp(`(^|\\s)${escapeRegExp(label)}(\\s|$)`).test(text)) {
    score += 35;
  }

  if (role === "menuitem" || role === "menuitemradio" || role === "option") {
    score += 70;
  } else if (role === "button" || tagName === "button") {
    score += 45;
  }

  if (element?.getAttribute?.("aria-checked") === "true" || element?.getAttribute?.("aria-selected") === "true") {
    score += 8;
  }

  if (labelCount > 1) {
    score -= (labelCount - 1) * 45;
  }

  score -= Math.min(text.length, 300) / 60;
  return score;
}

function bestMenuCandidate(labelOrLabels) {
  const labels = preferenceLabels(labelOrLabels);
  const elements = menuCandidateElements();
  return labels
    .flatMap((label) => elements.map((element, index) => ({
      element,
      index,
      score: menuCandidateScore(element, label),
      textLength: modelControlText(element).length
    })))
    .filter((item) => item.score > -Infinity)
    .sort((a, b) => b.score - a.score || a.textLength - b.textLength || a.index - b.index)[0]?.element || null;
}

function findModelSubmenuTrigger(targetLabel) {
  const candidates = knownModelLabels()
    .filter((label) => label !== targetLabel)
    .map((label) => bestMenuCandidate(label))
    .filter(Boolean);
  return candidates[0] || null;
}

async function openModelSubmenu(targetLabel) {
  const trigger = findModelSubmenuTrigger(targetLabel);
  if (!trigger) {
    return false;
  }

  openPreferenceTrigger(trigger);
  await sleep(300);
  return true;
}

function dispatchPreferenceEvent(element, EventClass, type, init = {}) {
  if (typeof EventClass !== "function" || typeof element?.dispatchEvent !== "function") {
    return false;
  }

  try {
    element.dispatchEvent(new EventClass(type, { bubbles: true, cancelable: true, ...init }));
    return true;
  } catch {
    return false;
  }
}

function openPreferenceTrigger(element) {
  if (!element) {
    return;
  }

  if (typeof element.focus === "function") {
    element.focus();
  }

  dispatchPreferenceEvent(element, typeof PointerEvent === "function" ? PointerEvent : null, "pointerover", {
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true
  });
  dispatchPreferenceEvent(element, typeof MouseEvent === "function" ? MouseEvent : null, "mouseenter");
  dispatchPreferenceEvent(element, typeof PointerEvent === "function" ? PointerEvent : null, "pointermove", {
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true
  });
  dispatchPreferenceEvent(element, typeof MouseEvent === "function" ? MouseEvent : null, "mousemove");
  dispatchPreferenceEvent(element, typeof PointerEvent === "function" ? PointerEvent : null, "pointerdown", {
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: 1
  });
  dispatchPreferenceEvent(element, typeof MouseEvent === "function" ? MouseEvent : null, "mousedown", {
    button: 0,
    buttons: 1
  });
}

function activatePreferenceOption(element) {
  openPreferenceTrigger(element);
  dispatchPreferenceEvent(element, typeof PointerEvent === "function" ? PointerEvent : null, "pointerup", {
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: 0
  });
  dispatchPreferenceEvent(element, typeof MouseEvent === "function" ? MouseEvent : null, "mouseup", {
    button: 0,
    buttons: 0
  });
  if (typeof element?.click === "function") {
    element.click();
  } else {
    dispatchPreferenceEvent(element, typeof MouseEvent === "function" ? MouseEvent : null, "click", {
      button: 0,
      buttons: 0
    });
  }
}

function dismissOpenMenus() {
  const EventClass = typeof KeyboardEvent === "function" ? KeyboardEvent : null;
  dispatchPreferenceEvent(document, EventClass, "keydown", { key: "Escape", code: "Escape" });
  dispatchPreferenceEvent(document, EventClass, "keyup", { key: "Escape", code: "Escape" });
}

async function chooseMenuPreferenceOnce(labelOrLabels, kind = "model") {
  const labels = preferenceLabels(labelOrLabels);
  const current = findPreferenceControl(kind, labels);
  if (!current) {
    lastPreferenceAttemptDiagnostic = {
      kind,
      labels,
      currentControl: null,
      visibleOptions: visiblePreferenceOptionDiagnostics()
    };
    return false;
  }

  openPreferenceTrigger(current);
  await sleep(300);
  lastPreferenceAttemptDiagnostic = {
    kind,
    labels,
    currentControl: preferenceElementDiagnostic(current),
    visibleOptions: visiblePreferenceOptionDiagnostics()
  };
  let option = findModelOption(labels);
  if (!option && typeof current.click === "function") {
    current.click();
    await sleep(300);
    lastPreferenceAttemptDiagnostic.visibleOptions = visiblePreferenceOptionDiagnostics();
    option = findModelOption(labels);
  }
  if (!option && kind === "model" && await openModelSubmenu(labels[0])) {
    option = findModelOption(labels);
  }
  if (!option) {
    dismissOpenMenus();
    return false;
  }

  lastPreferenceAttemptDiagnostic.selectedOption = preferenceElementDiagnostic(option);

  activatePreferenceOption(option);
  await sleep(300);
  dismissOpenMenus();
  return true;
}

function preferenceApplied(kind, labelOrLabels) {
  const current = findPreferenceControl(kind, labelOrLabels);
  return Boolean(current && elementContainsAnyPreferenceLabel(current, labelOrLabels));
}

function preferenceCanConfirmSelection(kind, labelOrLabels) {
  const current = findPreferenceControl(kind, labelOrLabels);
  if (!current) {
    return false;
  }

  if (kind === "model" && looksLikeSpecificModeControl(current) && !looksLikeSpecificModelControl(current)) {
    return false;
  }

  return true;
}

async function selectMenuPreference(labelOrLabels, kind = "model") {
  const labels = preferenceLabels(labelOrLabels);
  lastPreferenceAttemptDiagnostic = null;
  if (!labels.length) {
    return false;
  }

  if (preferenceApplied(kind, labels)) {
    return true;
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const selected = await chooseMenuPreferenceOnce(labels, kind);
    if (selected && (preferenceApplied(kind, labels) || !preferenceCanConfirmSelection(kind, labels))) {
      return true;
    }
    if (attempt < 3) {
      await sleep(300);
    }
  }

  return false;
}

async function selectModePreference(job = {}) {
  return selectMenuPreference(modeLabelsForPreference(job.modePreference, job.modelPreference), "mode");
}

async function selectModelPreference(job = {}) {
  return selectMenuPreference(modelLabelsForPreference(job.modelPreference), "model");
}

function findFileInput() {
  return document.querySelector('input[type="file"]');
}

async function fetchInputArtifactFile(artifact) {
  const url = bridgeUrl(inputArtifactUploadUrl(artifact));
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Could not fetch ${artifact.filename || artifact.id}: ${response.status}`);
      }
      const bytes = await response.arrayBuffer();
      return new File([bytes], artifact.filename || "artifact", {
        type: artifact.contentType || response.headers?.get("content-type") || "application/octet-stream"
      });
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await sleep(300);
      }
    }
  }
  throw lastError;
}

function inputArtifactUploadUrl(artifact = {}) {
  if (artifact.uploadUrl) {
    return normalizeInputArtifactUploadUrl(artifact.uploadUrl);
  }
  if (artifact.rawUrl) {
    return normalizeInputArtifactUploadUrl(artifact.rawUrl);
  }
  if (artifact.viewUrl) {
    return normalizeInputArtifactUploadUrl(artifact.viewUrl);
  }
  const downloadUrl = artifact.downloadUrl || "";
  return normalizeInputArtifactUploadUrl(downloadUrl);
}

function normalizeInputArtifactUploadUrl(value = "") {
  const url = String(value || "").trim();
  return /\/download(?=$|\?)/.test(url) ? url.replace(/\/download(?=$|\?)/, "/raw") : url;
}

function uploadPreviewLabel(element) {
  return normalizeText(
    [
      element?.textContent,
      element?.innerText,
      element?.getAttribute?.("aria-label"),
      element?.getAttribute?.("title"),
      element?.getAttribute?.("alt"),
      element?.getAttribute?.("data-testid")
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function isInsideElement(element, container) {
  if (!element || !container) {
    return false;
  }
  if (element === container) {
    return true;
  }
  if (typeof container.contains === "function") {
    return container.contains(element);
  }
  let current = element.parentElement || element.parentNode || null;
  while (current) {
    if (current === container) {
      return true;
    }
    current = current.parentElement || current.parentNode || null;
  }
  return false;
}

function uploadPreviewElements() {
  const composer = findComposer();
  return [...document.querySelectorAll("img,[data-testid],[aria-label],[title],a,button,div,span,p")]
    .filter(isVisibleElement)
    .filter((element) => {
      if (isInsideElement(element, composer)) {
        return false;
      }
      if (element.closest?.('[data-testid^="conversation-turn-"]')) {
        return false;
      }
      return true;
    });
}

function inputArtifactAppearsUploaded(artifact = {}, previewElements = null) {
  const filename = String(artifact.filename || "").trim();
  const isImage = /^image\//i.test(artifact.contentType || "") || /\.(png|jpe?g|webp|gif|svg)$/i.test(filename);
  const candidates = Array.isArray(previewElements) ? previewElements : uploadPreviewElements();
  return candidates.some((element) => {
    const label = uploadPreviewLabel(element);
    if (filename && label.includes(filename)) {
      return true;
    }
    return isImage && String(element.tagName || "").toLowerCase() === "img";
  });
}

async function waitForInputArtifactsVisible(inputArtifacts = [], timeoutMs = 60000) {
  const started = Date.now();
  const observesPageChanges = installAssistantActivityObserver();
  let pageScanNeeded = true;
  while (Date.now() - started <= timeoutMs) {
    if (pageScanNeeded) {
      assertNoChatGptBlocker();
      const previewElements = uploadPreviewElements();
      if (inputArtifacts.every((artifact) => inputArtifactAppearsUploaded(artifact, previewElements))) {
        return;
      }
      pageScanNeeded = false;
    }
    const pageChanged = await waitForAssistantActivity(500);
    pageScanNeeded = !observesPageChanges || pageChanged || pageScanNeeded;
  }

  const previewElements = uploadPreviewElements();
  const missing = inputArtifacts
    .filter((artifact) => !inputArtifactAppearsUploaded(artifact, previewElements))
    .map((artifact) => artifact.filename || artifact.id || "artifact")
    .join(", ");
  throw new Error("GPT 附件没有出现在输入框里：" + missing);
}

async function uploadInputArtifacts(job = {}, options = {}) {
  const inputArtifacts = Array.isArray(job.inputArtifacts) ? job.inputArtifacts : [];
  if (inputArtifacts.length === 0) {
    return [];
  }

  const fileInput = findFileInput();
  if (!fileInput) {
    throw new Error("GPT 文件输入控件没有找到。");
  }

  const transfer = new DataTransfer();
  const files = [];
  for (const artifact of inputArtifacts) {
    const file = await fetchInputArtifactFile(artifact);
    transfer.items.add(file);
    files.push(file);
  }

  fileInput.files = transfer.files;
  fileInput.dispatchEvent(new Event("change", { bubbles: true }));
  await waitForInputArtifactsVisible(inputArtifacts, options.attachmentTimeoutMs ?? 60000);
  return files;
}

function findSendButton() {
  const direct =
    document.querySelector('button[data-testid="send-button"]') ||
    document.querySelector('button[data-testid="composer-submit-button"]') ||
    document.querySelector('button[aria-label="Send prompt"]') ||
    document.querySelector('button[aria-label="Send message"]') ||
    document.querySelector('button[aria-label="发送"]');

  if (direct && isVisibleElement(direct)) {
    return direct;
  }

  return [...document.querySelectorAll("button")]
    .filter(isVisibleElement)
    .find((button) => {
      const label = `${button.getAttribute("aria-label") || ""} ${button.title || ""} ${button.textContent || ""}`;
      return /send|\u53d1\u9001/i.test(label);
    });
}

function isDisabledButton(button) {
  return Boolean(
    button?.disabled ||
      button?.getAttribute?.("disabled") !== null ||
      button?.getAttribute?.("aria-disabled") === "true"
  );
}

async function waitForReadySendButton(timeoutMs = 60000) {
  const started = Date.now();
  const observesPageChanges = installAssistantActivityObserver();
  let pageBlockerScanNeeded = true;
  while (Date.now() - started < timeoutMs) {
    if (pageBlockerScanNeeded) {
      assertNoChatGptBlocker();
      pageBlockerScanNeeded = false;
    }
    const sendButton = findSendButton();
    if (sendButton && !isDisabledButton(sendButton)) {
      return sendButton;
    }
    const pageChanged = await waitForAssistantActivity(500);
    pageBlockerScanNeeded = !observesPageChanges || pageChanged || pageBlockerScanNeeded;
  }
  throw new Error("GPT 发送按钮还没有准备好。");
}

function normalizeNavigationUrl(value = "") {
  try {
    const url = new URL(value, location.href);
    url.search = "";
    url.hash = "";
    return url.href.replace(/\/+$/, "");
  } catch {
    return String(value || "").replace(/\/+$/, "");
  }
}

function isArtifactPreviewPage() {
  const href = String(location?.href || "");
  if (/\/backend-api\/estuary\/content(?:[/?#]|$)/i.test(href)) {
    return true;
  }
  const titleLooksLikeArtifact = /\.(png|jpe?g|webp|gif|svg|pdf|xlsx?|pptx?|docx?|zip)$/i.test(
    (document.title || "").trim()
  );
  return titleLooksLikeArtifact && !findComposer();
}

function findArtifactPreviewCloseButton() {
  return [...document.querySelectorAll("button")].filter(isVisibleElement).find((button) => {
    const label = normalizeText(
      `${button.getAttribute("aria-label") || ""} ${button.title || ""} ${button.textContent || ""}`
    );
    return /\b(?:close|dismiss)\b/i.test(label) || label.includes("关闭") || /^(?:x|×|✕|✖)$/i.test(label);
  });
}

async function dismissArtifactPreviewIfNeeded(timeoutMs = 5000) {
  if (!isArtifactPreviewPage()) {
    return;
  }

  const closeButton = findArtifactPreviewCloseButton();
  if (!closeButton) {
    const error = new Error("GPT 文件预览没有可用的关闭按钮。");
    error.errorCode = "artifact_preview_stuck";
    error.recoveryAction = "refresh_bound_page";
    throw error;
  }

  closeButton.click();
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (findComposer() || !isArtifactPreviewPage()) {
      return;
    }
    await waitForAssistantActivity(250);
  }
  const error = new Error("GPT 文件预览没有关闭。");
  error.errorCode = "artifact_preview_stuck";
  error.recoveryAction = "refresh_bound_page";
  throw error;
}

function assistantMessages() {
  const preferred = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
  if (preferred.length > 0) {
    return preferred;
  }

  return [...document.querySelectorAll("article, main [role='presentation'], main div")]
    .filter((node) => {
      const text = node.textContent?.trim() || "";
      const label = node.getAttribute("aria-label") || "";
      if (/window\.__oai_|requestAnimationFrame|__oai_SSR/i.test(text)) {
        return false;
      }
      return /ChatGPT|assistant/i.test(label) || (node.matches?.("article") && text.length > 80);
    });
}

function normalizeText(value = "") {
  return value.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value = "") {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function promptNeedle(value = "") {
  return promptNeedles(value)[0] || "";
}

function uniqueNonEmptyStrings(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = normalizeText(String(value || ""));
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    result.push(text);
  }
  return result;
}

function promptNeedles(value = "") {
  const normalized = normalizeText(value);
  const rendered = normalizeText(
    String(value || "")
      .replace(/(^|\n)\s{0,3}(?:[-*+]|\d+[.)])\s+/g, "$1")
      .replace(/(^|\s)(?:[-*+]|\d+[.)])\s+/g, "$1")
  );
  return uniqueNonEmptyStrings([
    ...filenamesFromText(value),
    normalized.slice(0, 80),
    rendered.slice(0, 80)
  ]);
}

function promptTextCandidates(...values) {
  return uniqueNonEmptyStrings(values.flat().filter(Boolean));
}

function promptCandidatesForJob(job = {}) {
  return promptTextCandidates(
    job.payloadText,
    job.userText,
    (job.inputArtifacts || []).map((artifact) => artifact?.filename)
  );
}

function conversationTurns() {
  return [...document.querySelectorAll('[data-testid^="conversation-turn-"]')];
}

function isAssistantLikeTurn(turn) {
  if (!turn) {
    return false;
  }

  if (turn.querySelector?.('[data-message-author-role="assistant"]')) {
    return true;
  }

  if (imageCandidates(turn).length > 0) {
    return true;
  }

  return Boolean(normalizeText(turn.textContent || "") && !turn.querySelector?.('[data-message-author-role="user"]'));
}

function isUserLikeTurn(turn) {
  if (!turn) {
    return false;
  }

  if (turn.querySelector?.('[data-message-author-role="user"]')) {
    return true;
  }

  if (turn.querySelector?.('[data-message-author-role="assistant"]') || imageCandidates(turn).length > 0) {
    return false;
  }

  return Boolean(normalizeText(turn.textContent || ""));
}

function latestUserPromptTurnInfo(userTexts = [], options = {}) {
  const needles = uniqueNonEmptyStrings(promptTextCandidates(userTexts).flatMap((text) => promptNeedles(text)));
  if (needles.length === 0) {
    return null;
  }

  const afterTurnIndex = Number.isInteger(options.afterTurnIndex) ? options.afterTurnIndex : -1;
  const turns = Array.isArray(options.turns) ? options.turns : conversationTurns();
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (index <= afterTurnIndex) {
      break;
    }
    const turnText = normalizeText(turns[index].textContent || "");
    const matchingNeedle = needles.find((needle) => turnText.includes(needle));
    if (matchingNeedle && isUserLikeTurn(turns[index])) {
      return { index, turn: turns[index], needle: matchingNeedle };
    }
  }

  return null;
}

function assistantTurnsAfterTurnIndex(turnIndex, turnsSnapshot = null) {
  const index = Number(turnIndex);
  if (!Number.isInteger(index) || index < 0) {
    return [];
  }

  const turns = Array.isArray(turnsSnapshot) ? turnsSnapshot : conversationTurns();
  if (index >= turns.length) {
    return [];
  }

  return turns.slice(index + 1).filter(isAssistantLikeTurn);
}

function assistantTurnsAfterUserTexts(userTexts = [], turnsSnapshot = null) {
  const turns = Array.isArray(turnsSnapshot) ? turnsSnapshot : conversationTurns();
  const promptInfo = latestUserPromptTurnInfo(userTexts, { turns });
  if (!promptInfo) {
    return [];
  }

  return assistantTurnsAfterTurnIndex(promptInfo.index, turns);
}

function assistantTurnsAfterUserText(userText = "", turnsSnapshot = null) {
  return assistantTurnsAfterUserTexts([userText], turnsSnapshot);
}

function assistantMessagesForReplyScope(afterUserTurnIndex, afterUserTexts = [], turnsSnapshot = null) {
  const indexedMessages = Number.isInteger(afterUserTurnIndex)
    ? assistantTurnsAfterTurnIndex(afterUserTurnIndex, turnsSnapshot)
    : [];
  if (indexedMessages.length > 0) {
    return indexedMessages;
  }
  return afterUserTexts.length > 0 ? assistantTurnsAfterUserTexts(afterUserTexts, turnsSnapshot) : [];
}

function userPromptTurnExists(userText = "") {
  return userPromptTurnExistsAny([userText]);
}

function userPromptTurnExistsAny(userTexts = []) {
  const needles = uniqueNonEmptyStrings(promptTextCandidates(userTexts).flatMap((text) => promptNeedles(text)));
  if (needles.length === 0) {
    return false;
  }
  if (
    conversationTurns().some(
      (turn) =>
        isUserLikeTurn(turn) &&
        needles.some((needle) => normalizeText(turn.textContent || "").includes(needle))
    )
  ) {
    return true;
  }

  return [...document.querySelectorAll('[data-message-author-role="user"]')].some((node) =>
    needles.some((needle) => normalizeText(node.textContent || "").includes(needle))
  );
}

function directUserPromptNodes() {
  return [...document.querySelectorAll('[data-message-author-role="user"]')];
}

function latestDirectUserPromptInfo(userTexts = [], options = {}) {
  if (!Number.isInteger(options.afterUserMessageCount)) {
    return null;
  }
  const needles = uniqueNonEmptyStrings(promptTextCandidates(userTexts).flatMap((text) => promptNeedles(text)));
  if (needles.length === 0) {
    return null;
  }
  const afterUserMessageCount = options.afterUserMessageCount;
  const nodes = directUserPromptNodes();
  for (let index = nodes.length - 1; index >= afterUserMessageCount; index -= 1) {
    const nodeText = normalizeText(nodes[index].textContent || "");
    const needle = needles.find((candidate) => nodeText.includes(candidate));
    if (needle) {
      return {
        index: null,
        turn: nodes[index],
        needle,
        fallback: "direct_user_message"
      };
    }
  }
  return null;
}

function nodeTagName(node) {
  return String(node?.tagName || node?.nodeName || "").toLowerCase();
}

function nodeChildren(node) {
  return [...(node?.childNodes || [])];
}

function nodePlainText(node) {
  return String(node?.innerText ?? node?.textContent ?? "");
}

function assistantReplyRoot(messageNode) {
  if (!messageNode) {
    return null;
  }

  if (messageNode.matches?.('[data-message-author-role="assistant"]')) {
    return messageNode;
  }

  const roleNode = messageNode.querySelector?.('[data-message-author-role="assistant"]');
  if (roleNode && (nodePlainText(roleNode).trim() || nodeChildren(roleNode).length > 0)) {
    return roleNode;
  }

  return messageNode;
}

function joinMarkdownBlocks(parts) {
  return parts
    .map((part) => String(part || "").replace(/[ \t]+\n/g, "\n").trim())
    .filter(Boolean)
    .join("\n\n");
}

function isIgnoredReplyElement(node) {
  const tag = nodeTagName(node);
  return ["button", "svg", "img", "style", "script", "noscript"].includes(tag);
}

function inlineMarkdownFromNode(node) {
  if (!node) {
    return "";
  }

  if (node.nodeType === 3) {
    return node.textContent || "";
  }

  const tag = nodeTagName(node);
  if (isIgnoredReplyElement(node)) {
    return "";
  }
  if (tag === "br") {
    return "\n";
  }
  if (tag === "code" && nodeTagName(node.parentElement || node.parentNode) !== "pre") {
    const code = nodeChildren(node).length > 0 ? nodeChildren(node).map(inlineMarkdownFromNode).join("") : nodePlainText(node);
    return code ? `\`${code}\`` : "";
  }
  if (nodeChildren(node).length === 0) {
    return nodePlainText(node);
  }

  return nodeChildren(node).map(inlineMarkdownFromNode).join("");
}

function findFirstDescendantByTag(node, wantedTag) {
  for (const child of nodeChildren(node)) {
    if (nodeTagName(child) === wantedTag) {
      return child;
    }
    const nested = findFirstDescendantByTag(child, wantedTag);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function codeLanguageFromNode(codeNode) {
  const value = `${codeNode?.className || ""} ${codeNode?.getAttribute?.("class") || ""} ${codeNode?.getAttribute?.("data-language") || ""}`;
  const match = value.match(/language-([a-z0-9_-]+)/i) || value.match(/\b(js|javascript|ts|typescript|html|css|json|python|py|bash|sh|mermaid)\b/i);
  if (!match) {
    return "";
  }
  const language = match[1].toLowerCase();
  if (language === "javascript") return "js";
  if (language === "typescript") return "ts";
  if (language === "python") return "py";
  return language;
}

function codeBlockMarkdown(node) {
  const codeNode = findFirstDescendantByTag(node, "code") || node;
  const language = codeLanguageFromNode(codeNode);
  let code = nodePlainText(codeNode).replace(/\r\n/g, "\n").trimEnd();
  if (language) {
    const firstLine = code.split("\n")[0]?.trim().toLowerCase();
    if (firstLine === language || (language === "js" && firstLine === "javascript")) {
      code = code.split("\n").slice(1).join("\n").trimEnd();
    }
  }
  return `\`\`\`${language}\n${code}\n\`\`\``;
}

function tableMarkdown(node) {
  const rows = [...(node.querySelectorAll?.("tr") || [])];
  if (rows.length === 0) {
    return inlineMarkdownFromNode(node).trim();
  }

  const renderedRows = rows
    .map((row) => [...(row.querySelectorAll?.("th,td") || [])].map((cell) => inlineMarkdownFromNode(cell).trim()))
    .filter((cells) => cells.length > 0);
  if (renderedRows.length === 0) {
    return inlineMarkdownFromNode(node).trim();
  }

  const header = renderedRows[0];
  const separator = header.map(() => "---");
  return [header, separator, ...renderedRows.slice(1)]
    .map((cells) => `| ${cells.join(" | ")} |`)
    .join("\n");
}

function listItemText(node) {
  const checkbox = node.querySelector?.('input[type="checkbox"]');
  const checked = checkbox ? Boolean(checkbox.checked || checkbox.getAttribute?.("checked") !== null) : null;
  const prefix = checked === null ? "" : checked ? "[x] " : "[ ] ";
  return `${prefix}${inlineMarkdownFromNode(node).trim()}`;
}

function markdownFromNode(node) {
  if (!node) {
    return "";
  }

  if (node.nodeType === 3) {
    return node.textContent || "";
  }

  if (isIgnoredReplyElement(node)) {
    return "";
  }

  const tag = nodeTagName(node);
  if (nodeChildren(node).length === 0 && tag !== "table") {
    return nodePlainText(node);
  }

  if (/^h[1-6]$/.test(tag)) {
    return `${"#".repeat(Number(tag[1]))} ${inlineMarkdownFromNode(node).trim()}`;
  }
  if (tag === "p") {
    return inlineMarkdownFromNode(node).trim();
  }
  if (tag === "pre") {
    return codeBlockMarkdown(node);
  }
  if (tag === "blockquote") {
    return joinMarkdownBlocks(nodeChildren(node).map(markdownFromNode))
      .split("\n")
      .map((line) => `> ${line}`.trimEnd())
      .join("\n");
  }
  if (tag === "ul") {
    return nodeChildren(node)
      .filter((child) => nodeTagName(child) === "li")
      .map((child) => `- ${listItemText(child)}`)
      .join("\n");
  }
  if (tag === "ol") {
    return nodeChildren(node)
      .filter((child) => nodeTagName(child) === "li")
      .map((child, index) => `${index + 1}. ${listItemText(child)}`)
      .join("\n");
  }
  if (tag === "li") {
    return listItemText(node);
  }
  if (tag === "table") {
    return tableMarkdown(node);
  }
  if (tag === "br") {
    return "\n";
  }

  const childBlocks = joinMarkdownBlocks(nodeChildren(node).map(markdownFromNode));
  return childBlocks || nodePlainText(node);
}

function cleanChatGptReplyText(value = "") {
  let text = String(value || "").replace(/\r\n/g, "\n").trim();
  for (let index = 0; index < 3; index += 1) {
    text = text.replace(/^\s*#{1,6}\s*ChatGPT\s*(?:\u8bf4|said|says)?\s*[:\uff1a]\s*/i, "");
    text = text.replace(/^\s*ChatGPT\s*(?:\u8bf4|said|says)?\s*[:\uff1a]\s*/i, "");
    text = text.replace(
      /^\s*(?:\u5df2\u601d\u8003\s*(?:\u51e0\u79d2|(?:\d+\s*(?:ms|s|sec|secs|seconds|m|min|mins|h|\u79d2|\u5206|\u5206\u949f|\u5c0f\u65f6)\s*)+)|Thought for\s*(?:\d+\s*(?:ms|s|sec|secs|seconds|m|min|mins|h)\s*)+)\s*/i,
      ""
    );
  }
  text = text.replace(/(?:^|\n)\s*(?:Edit|\u7f16\u8f91)\s*(?=\n|$)/gi, "\n");
  text = text.replace(/\n?\s*(?:Sources?|\u6765\u6e90)\s*$/i, "");
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function parseThoughtDurationMs(value = "") {
  const text = String(value || "");
  const match = text.match(
    /(?:\u5df2\u601d\u8003|Thought for)\s*((?:\d+\s*(?:ms|s|sec|secs|seconds|m|min|mins|h|\u79d2|\u5206|\u5206\u949f|\u5c0f\u65f6)\s*)+)/i
  );
  if (!match) return null;

  let totalMs = 0;
  const unitPattern = /(\d+)\s*(ms|s|sec|secs|seconds|m|min|mins|h|\u79d2|\u5206|\u5206\u949f|\u5c0f\u65f6)/gi;
  let unitMatch = null;
  while ((unitMatch = unitPattern.exec(match[1]))) {
    const amount = Number(unitMatch[1]);
    const unit = unitMatch[2].toLowerCase();
    if (!Number.isFinite(amount)) continue;
    if (unit === "ms") totalMs += amount;
    else if (["s", "sec", "secs", "seconds", "\u79d2"].includes(unit)) totalMs += amount * 1000;
    else if (["m", "min", "mins", "\u5206", "\u5206\u949f"].includes(unit)) totalMs += amount * 60_000;
    else if (["h", "\u5c0f\u65f6"].includes(unit)) totalMs += amount * 60 * 60_000;
  }
  return totalMs > 0 ? totalMs : null;
}

function assistantThoughtDurationMs(messageNode) {
  if (!messageNode) return null;
  return parseThoughtDurationMs(markdownFromNode(messageNode) || nodePlainText(messageNode));
}

function unwrapSingleCodeBlock(text = "") {
  const match = text.match(/^```[a-z0-9_-]*\n([\s\S]*?)\n```$/i);
  return match ? match[1].trimEnd() : null;
}

function extractAssistantReplyText(messageNode) {
  const root = assistantReplyRoot(messageNode);
  const structured = cleanChatGptReplyText(markdownFromNode(root) || nodePlainText(root));
  return unwrapSingleCodeBlock(structured) || structured;
}

function lastAssistantText(options = {}) {
  const last = lastAssistantMessage(options);
  return extractAssistantReplyText(last);
}

function lastAssistantMessage(options = {}) {
  let requiredScopeMissed = false;
  const turnsSnapshot = Array.isArray(options.turns) ? options.turns : null;
  if (Number.isInteger(options.afterUserTurnIndex)) {
    const scoped = assistantTurnsAfterTurnIndex(options.afterUserTurnIndex, turnsSnapshot);
    if (scoped.length > 0) {
      return scoped[scoped.length - 1];
    }
    if (options.requireAfterUserText && (turnsSnapshot || conversationTurns()).length > 0) {
      requiredScopeMissed = true;
    }
  }

  const afterUserTexts = promptTextCandidates(options.afterUserTexts || [], options.afterUserText);
  if (afterUserTexts.length > 0) {
    const scoped = assistantTurnsAfterUserTexts(afterUserTexts, turnsSnapshot);
    if (scoped.length > 0) {
      return scoped[scoped.length - 1];
    }
    if (options.requireAfterUserText && (turnsSnapshot || conversationTurns()).length > 0) {
      requiredScopeMissed = true;
    }
  }

  if (requiredScopeMissed) {
    return null;
  }
  const messages = assistantMessages();
  return messages[messages.length - 1] || null;
}

function latestChangedAssistantMessage(previousText = "") {
  const messages = assistantMessages();
  const latest = messages[messages.length - 1] || null;
  if (!latest) {
    return null;
  }
  const text = extractAssistantReplyText(latest);
  return hasUsableAssistantText(text, previousText) ? latest : null;
}

function assistantDownloadScope(messageNode) {
  return messageNode?.closest?.('[data-testid^="conversation-turn-"]') || messageNode;
}

function hasUsableAssistantText(current, previousText, options = {}) {
  const text = cleanChatGptReplyText(current || "");
  return Boolean(
    text &&
      (options.allowRepeatedText || text !== previousText) &&
      !hasGenerationFailureText(text) &&
      !isImagePlanningAssistantText(text) &&
      !isInterimAssistantText(text)
  );
}

function isImagePlanningAssistantText(value = "") {
  const text = normalizeText(value);
  if (/planning[\s\S]{0,120}image\s+generation|i['鈥橾?ll\s+go\s+for\s+a\s+[\d:]+\s+aspect\s+ratio|\u6b63\u5728.{0,40}(?:\u89c4\u5212|\u51c6\u5907|\u751f\u6210|\u521b\u5efa).{0,40}(?:\u56fe\u7247|\u56fe\u50cf|\u7167\u7247)/i.test(text)) {
    return true;
  }
  return text.length <= 180 && /\u6b63\u5728(?:\u751f\u6210|\u521b\u5efa)|\u8bf7\u7a0d\u7b49/i.test(text);
}

function isInterruptedAssistantText(value = "") {
  const text = normalizeText(value);
  return text.length <= 220 &&
    /\u8fde\u63a5.{0,10}(?:\u4e2d\u65ad|\u65ad\u5f00|\u5df2\u65ad)|(?:\u7b49\u5f85|\u6b63\u5728\u7b49\u5f85).{0,16}(?:\u5b8c\u6574\u56de\u590d|\u5b8c\u6574\u7b54\u590d|\u5b8c\u6574\u54cd\u5e94)|connection.{0,20}(?:interrupted|lost|disconnected)|waiting.{0,20}(?:complete|full).{0,16}(?:reply|response)/i.test(
      text
    );
}

function isInterimAssistantText(value = "") {
  const text = normalizeText(value);
  if (isInterruptedAssistantText(text)) {
    return true;
  }
  const isShortStatus = text.length <= 220;
  if (
    isShortStatus &&
    (
      /(?:PPT|PDF|Excel|CSV|ZIP|PSD|Word|DOCX|XLSX|PPTX).{0,48}(?:related|skill|instruction|lookup|checking|searching)/i.test(text) ||
      /(?:looking up|checking|searching|reading).{0,36}(?:image|file|document|table|code|archive|PPT|PDF|Excel|CSV|ZIP|PSD|Word)/i.test(text) ||
      /(?:\u67e5\u770b|\u67e5\u627e|\u8bfb\u53d6|\u5206\u6790).{0,36}(?:\u56fe\u7247|\u6587\u4ef6|\u6587\u6863|\u8868\u683c|PPT|PDF|Excel|CSV|ZIP|PSD|Word)/i.test(text) ||
      /(?:Pro\s*)?(?:thinking|processing|\u601d\u8003\u4e2d)/i.test(text)
    )
  ) {
    return true;
  }
  if (
    isShortStatus &&
    (
      /(?:\u6211(?:\u6765|\u4f1a|\u5c06)|\u73b0\u5728|\u6b63\u5728).{0,32}(?:\u751f\u6210|\u521b\u5efa|\u5236\u4f5c|\u5bfc\u51fa).{0,64}(?:DOCX|Word|XLSX|Excel|PPTX|PPT|PDF|ZIP|CSV|TXT|\u6587\u4ef6).{0,64}(?:\u4e0b\u8f7d\u94fe\u63a5|\u53ef\u4e0b\u8f7d|\u7ed9\u4f60\u4e0b\u8f7d|\u63d0\u4f9b\u4e0b\u8f7d|\u7a0d\u540e)/i.test(text) ||
      /(?:i(?:'|\u2019)?ll|i will|let me|i am going to|i'm going to).{0,32}(?:generate|create|make|export).{0,64}(?:docx|word|xlsx|excel|pptx|ppt|pdf|zip|csv|txt|file).{0,64}(?:download|link|shortly|provide)/i.test(text)
    )
  ) {
    return true;
  }
  const transientStatus = /(?:reading|analyzing|parsing|processing|thinking|generating|creating|please wait|hang tight|\u8bf7\u7a0d\u7b49|(?:\u6700\u540e)?\u5fae\u8c03\u4e00\u4e0b|(?:\u6b63\u5728|\u7ee7\u7eed).{0,24}(?:\u601d\u8003|\u751f\u6210|\u521b\u5efa|\u5904\u7406|\u5206\u6790|\u8bfb\u53d6|\u67e5\u770b|\u67e5\u627e|\u641c\u7d22|\u4e0a\u4f20|\u4e0b\u8f7d|\u51c6\u5907|\u6574\u7406|\u5b8c\u5584|\u4f18\u5316))/i;
  return isShortStatus && transientStatus.test(text);
}

function hasGeneratedImage(messageNode) {
  return imageCandidates(assistantDownloadScope(messageNode)).length > 0;
}

function hasDownloadableArtifact(messageNode) {
  return downloadButtonCandidates(assistantDownloadScope(messageNode)).length > 0;
}

function hasUsableAssistantContent(messageNode, previousText, options = {}) {
  if (!messageNode) {
    return false;
  }

  const text = Object.prototype.hasOwnProperty.call(options, "replyText")
    ? options.replyText
    : extractAssistantReplyText(messageNode);
  const generatedImagePresent = Object.prototype.hasOwnProperty.call(options, "generatedImageCount")
    ? Number(options.generatedImageCount || 0) > 0
    : hasGeneratedImage(messageNode);
  if (generatedImagePresent && imageReplyStillProcessingText(text)) {
    return false;
  }

  if (hasUsableAssistantText(text, previousText, options) || generatedImagePresent) {
    return true;
  }
  return Object.prototype.hasOwnProperty.call(options, "hasDownloadableArtifact")
    ? Boolean(options.hasDownloadableArtifact)
    : hasDownloadableArtifact(messageNode);
}

function looksLikePossiblyStreamingReply(value = "") {
  const text = normalizeText(value);
  if (!text) {
    return false;
  }
  if (/```[^`]*$/m.test(text)) {
    return true;
  }
  return !/[.\u3002\uFF1F\uFF01!?~\u2026;\uFF1B\]\}"'\u201D\u2019\uFF09\)]$/.test(text);
}

function assistantReplyStableTarget(text = "", options = {}) {
  let target = 3;
  if (Number(options.inputArtifactCount || 0) > 0) {
    target = 6;
  }
  if (looksLikePossiblyStreamingReply(text)) {
    target = Math.max(target, normalizeText(text).length < 80 ? 12 : 8);
  }
  return target;
}

function shouldAcceptStableTextDuringGlobalGeneration(text = "", options = {}) {
  if (!text || options.generatedImageCount > 0 || options.hasDownloadableArtifact) {
    return false;
  }
  if (isImagePlanningAssistantText(text) || isInterimAssistantText(text) || looksLikePossiblyStreamingReply(text)) {
    return false;
  }
  return true;
}

function effectiveStableTarget(text = "", options = {}) {
  const target = assistantReplyStableTarget(text, options);
  if (options.pageStillGenerating && shouldAcceptStableTextDuringGlobalGeneration(text, options)) {
    return Math.max(target, 8);
  }
  return target;
}

function imageReplyStillProcessingText(text = "") {
  const cleaned = cleanChatGptReplyText(text || "");
  return Boolean(
    cleaned &&
      (isImagePlanningAssistantText(cleaned) ||
        isInterimAssistantText(cleaned) ||
        /\u8fd8\u5728\u5904\u7406|\u6ca1\u6709\u62ff\u5230\u6700\u7ec8\u53ef\u7528\u56de\u590d|\u6b63\u5728\u751f\u6210|\u6b63\u5728\u521b\u5efa|\u8bf7\u7a0d\u7b49|still processing|generating|creating|please wait|hang tight/i.test(
          cleaned
        ))
  );
}

function visibleReplyTextFromAssistant(messageNode, previousText, options = {}) {
  const text = Object.prototype.hasOwnProperty.call(options, "replyText")
    ? options.replyText
    : extractAssistantReplyText(messageNode);
  const generatedImagePresent = messageNode && (
    Object.prototype.hasOwnProperty.call(options, "generatedImageCount")
      ? Number(options.generatedImageCount || 0) > 0
      : hasGeneratedImage(messageNode)
  );
  if (generatedImagePresent && imageReplyStillProcessingText(text)) {
    return "\u5df2\u751f\u6210\u56fe\u7247\u3002";
  }
  if (text && (options.allowRepeatedText || text !== previousText)) {
    return text;
  }
  if (generatedImagePresent) {
    if (text) {
      return text;
    }
    return "GPT generated an image.";
  }
  return text || "GPT did not return a usable reply.";
}

function jobPromptText(job = {}) {
  return `${job.payloadText || ""} ${job.userText || ""}`;
}

function hasFileOutputRequestSignal(text = "") {
  return (
    /(?:\b(?:generate|create|make|download|downloadable|export|save)\b|鐢熸垚|鍒涘缓|鍒朵綔|瀵煎嚭|涓嬭浇|鍙笅杞絴淇濆瓨)/iu.test(text) &&
    /\.(?:txt|md|csv|json|pdf|docx?|xlsx?|pptx?|zip|png|jpe?g|webp|gif|html?|psd|ai|fig|svg)\b/i.test(text)
  );
}

function hasImageOutputRequestSignal(text = "") {
  return /(?:\u751f\u56fe|\u56fe\u7247\u751f\u6210|\u751f\u6210.{0,24}(?:\u56fe|\u56fe\u7247|\u56fe\u50cf|\u7167\u7247|image|picture|photo)|(?:draw|paint|illustrate|generate|create|make).{0,24}(?:image|picture|photo)|\u753b.{0,24}(?:\u56fe|\u56fe\u7247|\u56fe\u50cf)|\u7ed8\u5236.{0,24}(?:\u56fe|\u56fe\u7247|\u56fe\u50cf)|\u6d77\u62a5|\u5c01\u9762|\u63d2\u753b)/iu.test(
    text
  );
}

const CHINESE_SMALL_NUMBERS = new Map([
  ["\u4e00", 1],
  ["\u4e8c", 2],
  ["\u4e24", 2],
  ["\u4e09", 3],
  ["\u56db", 4],
  ["\u4e94", 5],
  ["\u516d", 6],
  ["\u4e03", 7],
  ["\u516b", 8],
  ["\u4e5d", 9],
  ["\u5341", 10]
]);

function requestedImageCount(job = {}) {
  const text = jobPromptText(job);
  if (
    hasNegativeArtifactSignal(text) ||
    (job.kind !== "image_request" && !hasImageOutputRequestSignal(text))
  ) {
    return 0;
  }

  const numericMatch =
    text.match(/(?:\u751f\u6210|\u5236\u4f5c|\u753b|\u7ed8\u5236|create|generate|make)\s*(\d{1,2})\s*(?:\u5f20|\u4e2a|\u5f35|images?|pictures?|photos?)/iu) ||
    text.match(/(\d{1,2})\s*(?:\u5f20|\u4e2a|\u5f35|images?|pictures?|photos?)/iu);
  if (numericMatch) {
    const count = Number(numericMatch[1]);
    return Number.isFinite(count) && count > 0 ? Math.min(count, 20) : 1;
  }

  const chineseMatch = text.match(/(?:\u751f\u6210|\u5236\u4f5c|\u753b|\u7ed8\u5236)?\s*([\u4e00\u4e8c\u4e24\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341])\s*(?:\u5f20|\u4e2a|\u5f35)/u);
  if (chineseMatch) {
    const count = CHINESE_SMALL_NUMBERS.get(chineseMatch[1]);
    return count && count > 0 ? count : 1;
  }

  return 1;
}

function hasOutputArtifactRequestSignal(job = {}) {
  const text = jobPromptText(job);
  return job.kind === "image_request" || hasFileOutputRequestSignal(text) || hasImageOutputRequestSignal(text);
}

function expectsImageArtifact(job = {}) {
  const text = jobPromptText(job);
  if (hasNegativeArtifactSignal(text)) {
    return false;
  }
  return job.kind === "image_request" || hasImageOutputRequestSignal(text) || (hasOutputArtifactRequestSignal(job) && /\.(png|jpe?g|webp|gif|svg)\b/i.test(text));
}

function hasExplicitNoImageSignal(value = "") {
  const clauses = String(value || "").split(/[，。！？!?；;\n]+/u);
  return clauses.some((clause) => {
    const chineseNoImage =
      /(?:(?:不要|别|无需|不需要|禁止|避免)\s*|不\s*(?=(?:再|提前)?(?:生成|制作|创建|绘制|画|设计)))(?:再|提前)?\s*(?:(?:生成|制作|创建|绘制|画|设计)\s*)?(?:任何|任意|新的?)?\s*(?:生图|配图|图片|图像|照片|海报|封面|图标|logo|插画|视觉)/iu.test(
        clause
      );
    const englishNoImage =
      /\b(?:do not|don't|without|no need to|avoid)\s+(?:(?:generate|create|draw|make|design)\s+)?(?:any\s+|a\s+|an\s+|new\s+)?(?:images?|pictures?|photos?|posters?|covers?|icons?|logos?|illustrations?)\b/iu.test(
        clause
      );
    return chineseNoImage || englishNoImage;
  });
}

function hasNegativeArtifactSignal(value = "") {
  return (
    hasExplicitNoImageSignal(value) ||
    /(?:only an example|example filename|no file was generated|no downloadable file|not a real file|do not generate (?:files?|images?|pictures?|posters?)|don't generate (?:files?|images?|pictures?|posters?)|without generating (?:files?|images?|pictures?|posters?)|\u4e0d\u8981\u751f\u6210(?:\u6587\u4ef6|\u56fe|\u56fe\u7247|\u56fe\u50cf|\u6d77\u62a5|\u5c01\u9762|\u63d2\u753b)|\u4e0d\u751f\u6210(?:\u6587\u4ef6|\u56fe|\u56fe\u7247|\u56fe\u50cf|\u6d77\u62a5|\u5c01\u9762|\u63d2\u753b)|\u65e0\u9700\u751f\u6210(?:\u6587\u4ef6|\u56fe|\u56fe\u7247|\u56fe\u50cf|\u6d77\u62a5|\u5c01\u9762|\u63d2\u753b)|\u4e0d\u8981\u6dfb\u52a0\u94fe\u63a5)/i.test(
      value || ""
    )
  );
}

function shouldSkipArtifactCapture(job = {}, replyText = "") {
  if (hasNegativeArtifactSignal(jobPromptText(job)) || hasNegativeArtifactSignal(replyText)) {
    return true;
  }

  if (job.kind === "codex_file_analysis" && Array.isArray(job.inputArtifacts) && job.inputArtifacts.length > 0) {
    return !hasOutputArtifactRequestSignal(job);
  }

  return false;
}

function requestedImageFilename(job = {}) {
  return requestedImageFilenames(job)[0] || null;
}

function requestedImageFilenames(job = {}) {
  return filenamesFromText(`${job.payloadText || ""} ${job.userText || ""}`).filter((filename) =>
    /\.(png|jpe?g|webp|gif|svg)$/i.test(filename || "")
  );
}

function isVisibleElement(element) {
  if (!element || element.disabled) {
    return false;
  }

  if (typeof element.getClientRects === "function") {
    return element.getClientRects().length > 0;
  }

  return true;
}

function stopCandidateElements() {
  const selectors = ["button", '[role="button"]', '[data-testid*="stop"]'];
  const seen = new Set();
  const elements = [];
  for (const selector of selectors) {
    let matches = [];
    try {
      matches = [...document.querySelectorAll(selector)];
    } catch {
      matches = [];
    }
    for (const element of matches) {
      if (!seen.has(element)) {
        seen.add(element);
        elements.push(element);
      }
    }
  }
  return elements;
}

function stopCandidateLabel(element) {
  return [
    element?.getAttribute?.("aria-label") || "",
    element?.getAttribute?.("data-testid") || "",
    element?.title || "",
    element?.textContent || ""
  ].join(" ");
}

function isStoppedStatusLabel(label = "") {
  return /(?:宸插仠姝宸插彇娑坾stopped|cancel(?:led|ed))\s*(?:鎬濊€億鐢熸垚|鍥炵瓟|鍥炲|thinking|generating|response)?/i.test(
    label
  );
}

function isGenerating() {
  const candidates = stopCandidateElements();
  if (findStopGeneratingButton(candidates)) {
    return true;
  }
  return candidates.some((button) => {
    if (!isVisibleElement(button)) {
      return false;
    }

    const label = stopCandidateLabel(button);
    if (isStoppedStatusLabel(label)) {
      return false;
    }
    return /stop\s*(?:generating|response)?|鍋滄\s*(?:鐢熸垚|鍥炵瓟|鍥炲)?/i.test(label);
  });
}

function findStopGeneratingButton(candidates = null) {
  return (candidates || stopCandidateElements()).filter(isVisibleElement).find((button) => {
    const label = stopCandidateLabel(button);
    if (isStoppedStatusLabel(label)) {
      return false;
    }
    return /stop generating|stop response|stop|鍋滄鐢熸垚|鍋滄鍥炵瓟|鍋滄鍥炲/i.test(label);
  });
}

async function stopActiveGenerationIfPossible(timeoutMs = 15000) {
  if (!isGenerating()) {
    return true;
  }

  const stopButton = findStopGeneratingButton();
  if (!stopButton) {
    return false;
  }

  stopButton.click();

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isGenerating()) {
      return true;
    }
    await sleep(300);
  }

  return !isGenerating();
}

async function stopStaleGenerationIfNeeded() {
  if (!isGenerating()) {
    return;
  }

  if (!findStopGeneratingButton()) {
    throw new Error("GPT 仍在生成，但没有找到停止按钮");
  }

  const stopped = await stopActiveGenerationIfPossible();
  if (stopped && findSendButton()) {
    return;
  }

  throw new Error("等待 GPT 停止上一条回复超时。");
}

function elementLabel(element) {
  return `${element.download || ""} ${element.getAttribute?.("aria-label") || ""} ${element.title || ""} ${element.textContent || ""}`;
}

function filenameFromContentDisposition(value) {
  const header = value || "";
  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) {
    return decodeURIComponent(utf8Match[1].trim().replace(/^"|"$/g, ""));
  }

  const plainMatch = header.match(/filename="?([^";]+)"?/i);
  return plainMatch?.[1]?.trim() || null;
}

function filenameFromUrl(value) {
  try {
    const url = new URL(value, location.href);
    const last = url.pathname.split("/").filter(Boolean).at(-1);
    return last ? decodeURIComponent(last) : null;
  } catch {
    return null;
  }
}

const FILENAME_EXTENSIONS = "txt|md|csv|json|pdf|docx?|xlsx?|pptx?|zip|png|jpe?g|webp|gif|html?|psd|ai|fig|svg";
const IMAGE_ARTIFACT_FILENAME_RE = /\.(?:png|jpe?g|webp|gif)$/i;

function filenamesFromText(value = "") {
  const text = String(value || "")
    .replace(/\u9286\u4e75/g, "\u3001m")
    .replace(/\u95b5\u55d5\u6c9f/g, "\u3001m")
    .replace(/\u6896/g, "f")
    .replace(/\u7f01\u612d\ue57b/g, "f")
    .replace(/\u3001/g, ",")
    .replace(/\uFF0C/g, ",")
    .replace(/\uFF1B/g, ";");
  const filenames = [];
  const seen = new Set();
  const add = (filename) => {
    let clean = filename?.trim();
    const parts = clean?.split(/[\u3001\uFF0C,;\uFF1B\n\r]+/g).map((part) => part.trim()).filter(Boolean) || [];
    const filenameOnlyPattern = new RegExp(`^[^<>|:*?/\\\\]+\\.(${FILENAME_EXTENSIONS})$`, "iu");
    if (parts.length > 1 && parts.every((part) => filenameOnlyPattern.test(part))) {
      for (const part of parts) {
        add(part);
      }
      return;
    }
    if (clean && /[^\x00-\x7F]/.test(clean)) {
      const asciiTail = clean.match(new RegExp(`([A-Za-z0-9][A-Za-z0-9._-]{0,150}\\.(${FILENAME_EXTENSIONS}))$`, "iu"));
      if (asciiTail) {
        clean = asciiTail[1];
      }
    }
    const thinkingSecondsPrefix = clean?.match(
      new RegExp(`^\\d+(?:\\.\\d+)?s(?=([A-Za-z][A-Za-z0-9._-]{0,150}\\.(${FILENAME_EXTENSIONS}))$)`, "iu")
    );
    if (thinkingSecondsPrefix) {
      clean = clean.slice(thinkingSecondsPrefix[0].length);
    }
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      filenames.push(clean);
    }
  };

  const quotedPattern = new RegExp(
    `["'\\u201c\\u201d\\u2018\\u2019]([^"'\\u201c\\u201d\\u2018\\u2019<>|:*?/\\\\]{1,160}\\.(${FILENAME_EXTENSIONS}))["'\\u201c\\u201d\\u2018\\u2019]`,
    "giu"
  );
  for (const match of text.matchAll(quotedPattern)) {
    add(match[1]);
  }

  const tokenPattern = new RegExp(
    `(^|[\\s"'<>()[\\]{}:,/\\\\\\uFF1A\\uFF0C\\u3001\\u3002\\uFF1B;])([^\\s"'<>|:*?/\\\\:,\\uFF1A\\uFF0C\\u3001\\u3002\\uFF1B;()[\\]{}]+\\.(${FILENAME_EXTENSIONS}))(?=$|[\\s"'<>),\\]\\}:,\\uFF1A\\uFF0C\\u3001\\u3002\\uFF1B;])`,
    "giu"
  );
  for (const match of text.matchAll(tokenPattern)) {
    add(match[2]);
  }

  const looseAsciiPattern = new RegExp(
    `(?:^|[^A-Za-z0-9._-])([A-Za-z0-9][A-Za-z0-9._-]{0,150}\\.(${FILENAME_EXTENSIONS}))(?=$|[^A-Za-z0-9._-])`,
    "giu"
  );
  for (const match of text.matchAll(looseAsciiPattern)) {
    add(match[1]);
  }

  return filenames.sort((left, right) => {
    const leftIndex = text.indexOf(left);
    const rightIndex = text.indexOf(right);
    if (leftIndex === rightIndex) {
      return 0;
    }
    if (leftIndex < 0) {
      return 1;
    }
    if (rightIndex < 0) {
      return -1;
    }
    return leftIndex - rightIndex;
  });
}

function filenameFromText(value = "") {
  return filenamesFromText(value)[0] || null;
}

function downloadFilenamesFromMessage(messageNode) {
  const filenames = [];
  const seen = new Set();
  const add = (filename) => {
    const clean = filename?.trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      filenames.push(clean);
    }
  };

  for (const filename of filenamesFromText(messageNode?.textContent || "")) {
    add(filename);
  }
  for (const button of messageNode?.querySelectorAll?.("button") || []) {
    for (const filename of filenamesFromText(elementLabel(button))) {
      add(filename);
    }
  }
  for (const anchor of messageNode?.querySelectorAll?.("a[href]") || []) {
    for (const filename of filenamesFromText(`${elementLabel(anchor)} ${anchor.href || anchor.getAttribute?.("href") || ""}`)) {
      add(filename);
    }
  }

  return filenames;
}

function hasExplicitNonImageDownloadFilename(messageNode) {
  return downloadFilenamesFromMessage(messageNode).some((filename) => !IMAGE_ARTIFACT_FILENAME_RE.test(filename));
}

function filenameFromAnchor(anchor, response) {
  return (
    anchor.download ||
    filenameFromContentDisposition(response?.headers?.get("content-disposition")) ||
    filenameFromUrl(anchor.href || anchor.getAttribute?.("href")) ||
    "chatgpt-artifact"
  );
}

function filenameFromImage(image, boundary, index = 0, options = {}) {
  const src = imageSourceUrl(image);
  const requestedFilename = options.requestedFilenames?.[index] || options.requestedFilename;
  return (
    requestedFilename ||
    filenameFromText(elementLabel(image)) ||
    filenameFromText(boundary?.textContent || "") ||
    (src.startsWith("data:") ? null : filenameFromUrl(src)) ||
    `chatgpt-image-${index + 1}.png`
  );
}

function hasDownloadLikeExtension(value) {
  return /\.(txt|md|csv|json|pdf|docx?|xlsx?|pptx?|zip|png|jpe?g|webp|gif|html?|psd|ai|fig|svg)($|[?#])/i.test(value || "");
}

function isDownloadCandidate(anchor) {
  const href = anchor.href || anchor.getAttribute?.("href") || "";
  const label = elementLabel(anchor);
  return Boolean(
    href &&
      (anchor.download ||
        href.startsWith("blob:") ||
        /download|attachment|file|\u4e0b\u8f7d|\u9644\u4ef6|\u6587\u4ef6/i.test(label) ||
        hasDownloadLikeExtension(href) ||
        hasDownloadLikeExtension(label))
  );
}

function filenameFromInterpreterDownloadUrl(value = "") {
  try {
    const parsed = new URL(value, location.href);
    if (!/\/interpreter\/download/i.test(parsed.pathname)) {
      return null;
    }
    const sandboxPath = parsed.searchParams.get("sandbox_path") || "";
    return filenameFromUrl(sandboxPath) || filenameFromText(sandboxPath);
  } catch {
    return null;
  }
}

function interpreterDownloadResourcesForFilenames(filenames = []) {
  const wanted = new Set(filenames.filter(Boolean));
  if (wanted.size === 0) {
    return [];
  }
  const seen = new Set();
  const entries =
    typeof performance !== "undefined" && typeof performance.getEntriesByType === "function"
      ? performance.getEntriesByType("resource")
      : [];

  return entries
    .map((entry) => entry.name || "")
    .map((url) => ({ url, filename: filenameFromInterpreterDownloadUrl(url) }))
    .filter(({ url, filename }) => {
      if (!url || !filename || seen.has(url)) {
        return false;
      }
      if (wanted.size > 0 && !wanted.has(filename)) {
        return false;
      }
      seen.add(url);
      return true;
    });
}

async function waitForInterpreterDownloadResources(filenames = [], timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const resources = interpreterDownloadResourcesForFilenames(filenames);
    if (resources.length > 0) {
      return resources;
    }
    await sleep(150);
  }
  return [];
}

function isExpansionLikeButton(button) {
  const label = elementLabel(button);
  return /open|expand|fullscreen|full screen|preview|view|\u6253\u5f00|\u653e\u5927|\u9884\u89c8|\u67e5\u770b/i.test(label);
}

function textNearElement(element, boundary) {
  let current = element;
  for (let depth = 0; current && depth < 6; depth += 1) {
    const text = current.textContent || "";
    if (filenameFromText(text)) {
      return text;
    }
    if (current === boundary) {
      break;
    }
    current = current.parentElement || current.parentNode;
  }

  return boundary?.textContent || "";
}

function closestFileCard(element, boundary) {
  let current = element;
  for (let depth = 0; current && depth < 6; depth += 1) {
    const text = current.textContent || "";
    const buttons = current.querySelectorAll?.("button") || [];
    if (filenameFromText(text) && buttons.length > 0) {
      return current;
    }
    if (current === boundary) {
      break;
    }
    current = current.parentElement || current.parentNode;
  }

  return null;
}

function expectedFilenameForButton(button, boundary) {
  const label = elementLabel(button);
  if (/zip/i.test(label) || shouldUseTrustedClick(button)) {
    const filenames = filenamesFromText(`${label} ${textNearElement(button, boundary)}`);
    const zipFilename = filenames.find((filename) => /\.zip$/i.test(filename));
    if (zipFilename || /zip/i.test(label)) {
      return zipFilename || null;
    }
  }

  return filenameFromText(elementLabel(button)) || filenameFromText(textNearElement(button, boundary));
}

function isLikelyFileDownloadButton(button, boundary) {
  if (!isVisibleElement(button)) {
    return false;
  }

  const label = elementLabel(button);
  const className = typeof button?.className === "string" ? button.className : button?.className?.baseVal || "";
  if (/download|\u4e0b\u8f7d/i.test(label)) {
    return Boolean(expectedFilenameForButton(button, boundary) || /download|\u4e0b\u8f7d/i.test(label));
  }
  if (/\bbehavior-btn\b/.test(className) && expectedFilenameForButton(button, boundary) && !isExpansionLikeButton(button)) {
    return true;
  }

  const card = closestFileCard(button, boundary);
  if (!card || !expectedFilenameForButton(button, boundary) || isExpansionLikeButton(button)) {
    return false;
  }

  const cardButtons = [...(card.querySelectorAll?.("button") || [])].filter(isVisibleElement);
  return cardButtons[0] === button;
}

function isInterpreterFileReferenceButton(button, boundary) {
  const className = typeof button?.className === "string" ? button.className : button?.className?.baseVal || "";
  const label = elementLabel(button);
  const card = closestFileCard(button, boundary);
  const hasExplicitDownloadSibling = [...(card?.querySelectorAll?.("button") || [])].some((candidate) =>
    candidate !== button && /download|\u4e0b\u8f7d/i.test(elementLabel(candidate))
  );
  return (
    /\bbehavior-btn\b/.test(className) &&
    hasDownloadLikeExtension(label) &&
    !hasExplicitDownloadSibling &&
    !/zip/i.test(label)
  );
}

function downloadButtonCandidates(messageNode) {
  return [...(messageNode?.querySelectorAll?.("button") || [])].filter((button) =>
    isLikelyFileDownloadButton(button, messageNode)
  );
}

function cssBackgroundImageUrl(element) {
  const inline = element?.style?.backgroundImage || "";
  const computed =
    !inline && typeof getComputedStyle === "function" ? getComputedStyle(element)?.backgroundImage || "" : inline;
  const value = inline || computed || "";
  const match = value.match(/url\((['"]?)(.*?)\1\)/i);
  return match?.[2] || "";
}

function imageSourceUrl(image) {
  return (
    image?.currentSrc ||
    image?.src ||
    image?.getAttribute?.("src") ||
    image?.getAttribute?.("data-src") ||
    cssBackgroundImageUrl(image)
  );
}

function elementRect(element) {
  const rect = element?.getBoundingClientRect?.() || element?.getClientRects?.()?.[0] || null;
  if (!rect || !Number.isFinite(Number(rect.width)) || !Number.isFinite(Number(rect.height))) {
    return null;
  }
  return {
    top: Number(rect.top || 0),
    bottom: Number(rect.bottom || 0),
    left: Number(rect.left || 0),
    right: Number(rect.right || 0),
    width: Number(rect.width || 0),
    height: Number(rect.height || 0)
  };
}

function isNearMessageImageRail(candidate, messageNode) {
  const messageRect = elementRect(messageNode);
  const candidateRect = elementRect(candidate);
  if (!messageRect || !candidateRect) {
    return true;
  }

  const verticalMargin = Math.max(160, messageRect.height * 0.2);
  const horizontalMargin = Math.max(360, messageRect.width * 0.45);
  const verticallyNear = candidateRect.bottom >= messageRect.top - verticalMargin && candidateRect.top <= messageRect.bottom + verticalMargin;
  const horizontallyNear =
    candidateRect.right >= messageRect.left - horizontalMargin && candidateRect.left <= messageRect.right + horizontalMargin;
  return verticallyNear && horizontallyNear;
}

function isLikelyGeneratedImage(image) {
  if (!isVisibleElement(image)) {
    return false;
  }

  const src = imageSourceUrl(image);
  if (!src || /^data:image\/svg/i.test(src)) {
    return false;
  }

  const width = image.naturalWidth || image.width || 0;
  const height = image.naturalHeight || image.height || 0;
  const maxDimension = Math.max(width, height);
  const looksLikeGeneratedAsset =
    src.startsWith("blob:") ||
    /chatgpt\.com\/backend-api\/(?:estuary\/)?content|oaiusercontent|oaidalle/i.test(src);
  const isSmallGeneratedThumbnail = looksLikeGeneratedAsset && maxDimension >= 48;
  if (width && height && maxDimension < 180 && !isSmallGeneratedThumbnail) {
    return false;
  }

  return (
    looksLikeGeneratedAsset ||
    src.startsWith("data:image/") ||
    /chatgpt\.com|openai|oaiusercontent|oaidalle/i.test(src) ||
    maxDimension >= 180
  );
}

function rawImageCandidates(scope) {
  return [
    ...(scope?.querySelectorAll?.("img") || []),
    ...(scope?.querySelectorAll?.("[style*='background-image'], [style*=\"background-image\"]") || [])
  ];
}

function documentImageRailCandidates(messageNode) {
  if (typeof document === "undefined") {
    return [];
  }
  return rawImageCandidates(document).filter((candidate) => {
    if (messageNode?.contains?.(candidate)) {
      return false;
    }
    return isNearMessageImageRail(candidate, messageNode);
  });
}

function uniqueImageCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (!isLikelyGeneratedImage(candidate)) {
      return false;
    }
    const key = imageCandidateKey(candidate);
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function imageCandidates(messageNode, options = {}) {
  const requestedCount = Number(options.expectedImageCount || 0);
  const excludedKeys = new Set(
    (Array.isArray(options.excludeImageKeys) ? options.excludeImageKeys : [])
      .map((key) => canonicalImageUrlKey(String(key || "")))
      .filter(Boolean)
  );
  const candidates = [
    ...rawImageCandidates(messageNode)
  ];
  const keepCurrentJobImage = (candidate) => !excludedKeys.has(imageCandidateKey(candidate));
  const scoped = uniqueImageCandidates(candidates).filter(keepCurrentJobImage);
  if (options.includePageGallery || (requestedCount > 1 && scoped.length > 0 && scoped.length < requestedCount)) {
    return uniqueImageCandidates([...scoped, ...documentImageRailCandidates(messageNode)]).filter(keepCurrentJobImage);
  }
  return scoped;
}

function generatedImageBaselineKeys(scope = document) {
  return uniqueImageCandidates(rawImageCandidates(scope))
    .map(imageCandidateKey)
    .filter(Boolean);
}

function canonicalImageUrlKey(src) {
  try {
    const url = new URL(src, location.href);
    const keptParams = new URLSearchParams();
    const volatileParams = new Set([
      "sig",
      "signature",
      "token",
      "expires",
      "expiry",
      "authorization",
      "x-amz-signature",
      "x-amz-expires",
      "x-amz-credential",
      "x-amz-date",
      "x-amz-security-token"
    ]);
    for (const [key, value] of url.searchParams.entries()) {
      if (!volatileParams.has(key.toLowerCase())) {
        keptParams.append(key, value);
      }
    }
    url.search = keptParams.toString();
    url.hash = "";
    return url.href;
  } catch {
    return src;
  }
}

function imageCandidateKey(image) {
  const src = imageSourceUrl(image);
  if (!src) {
    return "";
  }

  return canonicalImageUrlKey(src);
}

function visibleRect(element) {
  const rect = element?.getClientRects?.()?.[0] || element?.getBoundingClientRect?.() || null;
  return rect || null;
}

function hasNestedGeneratedImage(element) {
  return [...(element?.querySelectorAll?.("img") || [])].some(isLikelyGeneratedImage);
}

function isExcludedImageGalleryControl(button) {
  const label = elementLabel(button);
  return /download|\u4e0b\u8f7d|edit|\u7f16\u8f91|share|\u5206\u4eab|retry|\u91cd\u8bd5|open|expand|fullscreen|preview|view|\u6253\u5f00|\u653e\u5927|\u9884\u89c8|\u67e5\u770b|stop|send|copy|\u590d\u5236|\u66f4\u591a|more/i.test(
    label
  );
}

function imageGalleryControlCandidates(messageNode) {
  if (imageCandidates(messageNode).length === 0) {
    return [];
  }

  const controls = [
    ...(messageNode?.querySelectorAll?.("button,[role='button']") || []),
    ...(messageNode?.querySelectorAll?.("button") || [])
  ];
  const uniqueControls = controls.filter((control, index) => controls.indexOf(control) === index);
  const usableControls = uniqueControls.filter((control) => isVisibleElement(control) && !isExcludedImageGalleryControl(control));
  const taggedControls = usableControls.filter((control) => {
    const label = elementLabel(control);
    return (
      Boolean(cssBackgroundImageUrl(control)) ||
      hasNestedGeneratedImage(control) ||
      /image|photo|picture|thumbnail|\u56fe\u7247|\u7b2c\s*\d/i.test(label)
    );
  });
  if (taggedControls.length > 0) {
    return taggedControls;
  }

  const smallControls = usableControls.filter((control) => {
    const rect = visibleRect(control);
    return rect && rect.width > 0 && rect.height > 0 && rect.width <= 140 && rect.height <= 140;
  });
  return smallControls.length > 1 ? smallControls : [];
}

function uniqueGeneratedImageCount(messageNode, options = {}) {
  const seen = new Set();
  for (const image of imageCandidates(assistantDownloadScope(messageNode), options)) {
    const key = imageCandidateKey(image);
    if (key) {
      seen.add(key);
    }
  }
  return seen.size;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
  }
  return btoa(binary);
}

function utf8StringToBase64(value = "") {
  if (typeof TextEncoder !== "function") {
    return btoa(unescape(encodeURIComponent(String(value))));
  }
  const bytes = new TextEncoder().encode(String(value));
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
  }
  return btoa(binary);
}

function utf8Bytes(value = "") {
  if (typeof TextEncoder === "function") {
    return new TextEncoder().encode(String(value));
  }
  const binary = unescape(encodeURIComponent(String(value)));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
  }
  return btoa(binary);
}

function decodeSimpleStringLiteral(value = "") {
  return String(value)
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'");
}

function generatedTextArtifactsFromMessage(messageNode) {
  const text = String(messageNode?.textContent || "");
  const filenames = downloadFilenamesFromMessage(messageNode).filter((filename) => /\.(txt|md|csv|json|html?|css|js|ts|py|log|xml|ya?ml)$/i.test(filename));
  if (!text || filenames.length === 0 || !/write_text\s*\(/i.test(text)) {
    return [];
  }

  const writeMatch = text.match(/write_text\s*\(\s*(["'])([\s\S]*?)\1\s*,\s*encoding\s*=\s*(["'])utf-?8\3/i);
  if (!writeMatch) {
    return [];
  }

  const artifacts = [];
  const content = decodeSimpleStringLiteral(writeMatch[2]);
  for (const filename of filenames) {
    const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pathPattern = new RegExp(`/mnt/data/${escaped}(?=["'\\s)\\\\])`, "i");
    if (!pathPattern.test(text)) {
      continue;
    }
    artifacts.push({
      filename,
      contentType: "text/plain; charset=utf-8",
      originalUrl: null,
      base64Data: utf8StringToBase64(content)
    });
  }
  return artifacts;
}

const ZIP_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = ZIP_CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function writeUint16LE(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32LE(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function zipBytes(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const names = Object.keys(entries);

  for (const filename of names) {
    const nameBytes = utf8Bytes(filename);
    const dataBytes = utf8Bytes(entries[filename]);
    const checksum = crc32(dataBytes);

    const local = new Uint8Array(30);
    writeUint32LE(local, 0, 0x04034b50);
    writeUint16LE(local, 4, 20);
    writeUint16LE(local, 6, 0x0800);
    writeUint16LE(local, 8, 0);
    writeUint32LE(local, 10, 0);
    writeUint32LE(local, 14, checksum);
    writeUint32LE(local, 18, dataBytes.length);
    writeUint32LE(local, 22, dataBytes.length);
    writeUint16LE(local, 26, nameBytes.length);
    writeUint16LE(local, 28, 0);
    localParts.push(local, nameBytes, dataBytes);

    const central = new Uint8Array(46);
    writeUint32LE(central, 0, 0x02014b50);
    writeUint16LE(central, 4, 20);
    writeUint16LE(central, 6, 20);
    writeUint16LE(central, 8, 0x0800);
    writeUint16LE(central, 10, 0);
    writeUint32LE(central, 12, 0);
    writeUint32LE(central, 16, checksum);
    writeUint32LE(central, 20, dataBytes.length);
    writeUint32LE(central, 24, dataBytes.length);
    writeUint16LE(central, 28, nameBytes.length);
    writeUint16LE(central, 30, 0);
    writeUint16LE(central, 32, 0);
    writeUint16LE(central, 34, 0);
    writeUint16LE(central, 36, 0);
    writeUint32LE(central, 38, 0);
    writeUint32LE(central, 42, offset);
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + dataBytes.length;
  }

  const centralDirectory = concatBytes(centralParts);
  const end = new Uint8Array(22);
  writeUint32LE(end, 0, 0x06054b50);
  writeUint16LE(end, 4, 0);
  writeUint16LE(end, 6, 0);
  writeUint16LE(end, 8, names.length);
  writeUint16LE(end, 10, names.length);
  writeUint32LE(end, 12, centralDirectory.length);
  writeUint32LE(end, 16, offset);
  writeUint16LE(end, 20, 0);

  return concatBytes([...localParts, centralDirectory, end]);
}

function xmlEscape(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function spreadsheetColumnName(index) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function xlsxBytesFromValues(values = [], sheetName = "Sheet1") {
  const normalizedRows = values.map((row) => (Array.isArray(row) ? row : [row]));
  const sharedStrings = [];
  const sharedIndex = new Map();
  const sharedStringIndex = (value) => {
    const text = String(value ?? "");
    if (!sharedIndex.has(text)) {
      sharedIndex.set(text, sharedStrings.length);
      sharedStrings.push(text);
    }
    return sharedIndex.get(text);
  };

  const rowsXml = normalizedRows
    .map((row, rowIndex) => {
      const rowNumber = rowIndex + 1;
      const cells = row
        .map((value, columnIndex) => {
          const cellRef = `${spreadsheetColumnName(columnIndex)}${rowNumber}`;
          return `<c r="${cellRef}" t="s"><v>${sharedStringIndex(value)}</v></c>`;
        })
        .join("");
      return `<row r="${rowNumber}">${cells}</row>`;
    })
    .join("");

  const safeSheetName = xmlEscape(String(sheetName || "Sheet1").slice(0, 31) || "Sheet1");
  const sharedXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">`,
    sharedStrings.map((value) => `<si><t>${xmlEscape(value)}</t></si>`).join(""),
    "</sst>"
  ].join("");

  return zipBytes({
    "[Content_Types].xml": [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
      '<Default Extension="xml" ContentType="application/xml"/>',
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
      '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>',
      "</Types>"
    ].join(""),
    "_rels/.rels": [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
      "</Relationships>"
    ].join(""),
    "xl/workbook.xml": [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
      `<sheets><sheet name="${safeSheetName}" sheetId="1" r:id="rId1"/></sheets>`,
      "</workbook>"
    ].join(""),
    "xl/_rels/workbook.xml.rels": [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>',
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>',
      "</Relationships>"
    ].join(""),
    "xl/sharedStrings.xml": sharedXml,
    "xl/worksheets/sheet1.xml": [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
      `<sheetData>${rowsXml}</sheetData>`,
      "</worksheet>"
    ].join("")
  });
}

function jsonObjectCandidatesFromText(text = "") {
  const candidates = [];
  const source = String(text || "");
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }
    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(source.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function embeddedSpreadsheetTablesFromMessage(messageNode) {
  const blocks = [messageNode?.textContent || ""];
  for (const node of messageNode?.querySelectorAll?.("pre, code") || []) {
    blocks.push(node?.textContent || "");
  }

  const tables = [];
  for (const block of blocks) {
    for (const candidate of jsonObjectCandidatesFromText(block)) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed?.kind === "table" && Array.isArray(parsed.values) && parsed.values.length > 0) {
          tables.push({
            sheetName: parsed.sheet || "Sheet1",
            values: parsed.values
          });
        }
      } catch {
        // Ignore non-JSON code blocks; ChatGPT often mixes Python and outputs.
      }
    }
  }
  return tables;
}

function generatedSpreadsheetArtifactsFromMessage(messageNode) {
  const filenames = downloadFilenamesFromMessage(messageNode).filter((filename) => /\.xlsx$/i.test(filename));
  if (filenames.length === 0) {
    return [];
  }

  const tables = embeddedSpreadsheetTablesFromMessage(messageNode);
  if (tables.length === 0) {
    return [];
  }

  return filenames.map((filename, index) => {
    const table = tables[Math.min(index, tables.length - 1)];
    return {
      filename,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      originalUrl: null,
      base64Data: bytesToBase64(xlsxBytesFromValues(table.values, table.sheetName))
    };
  });
}

async function downloadArtifactFromAnchor(anchor) {
  const originalUrl = anchor.href || anchor.getAttribute?.("href");
  const response = await fetch(originalUrl, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Download failed with status ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  return {
    filename: filenameFromAnchor(anchor, response),
    contentType: response.headers?.get("content-type") || "application/octet-stream",
    originalUrl: response.url || originalUrl,
    base64Data: arrayBufferToBase64(buffer)
  };
}

function canUsePageContextFetch() {
  const parent = document?.documentElement || document?.head || document?.body;
  return Boolean(
    typeof window !== "undefined" &&
      typeof window.addEventListener === "function" &&
      typeof window.removeEventListener === "function" &&
      typeof window.postMessage === "function" &&
      typeof document?.createElement === "function" &&
      parent &&
      typeof parent.appendChild === "function"
  );
}

async function downloadArtifactFromPageContextUrl(originalUrl, options = {}) {
  if (!canUsePageContextFetch()) {
    throw new Error("Page context fetch is unavailable");
  }

  const requestId = `bridge_page_fetch_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const parent = document.documentElement || document.head || document.body;
  const script = document.createElement("script");

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      try {
        script.remove?.();
      } catch {
        // Ignore cleanup errors; the request result has already been settled.
      }
    };
    const settle = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      cleanup();
      fn(value);
    };
    const onMessage = (event) => {
      const data = event.data || {};
      if (data.source !== "codex-bridge-page-fetch" || data.requestId !== requestId) {
        return;
      }
      if (!data.ok) {
        settle(reject, new Error(data.error || `Download failed with status ${data.status || "unknown"}`));
        return;
      }
      settle(resolve, {
        filename:
          options.filename ||
          filenameFromContentDisposition(data.contentDisposition || "") ||
          filenameFromUrl(data.url || originalUrl) ||
          "chatgpt-artifact",
        contentType: data.contentType || options.contentType || "application/octet-stream",
        originalUrl: data.url || originalUrl,
        base64Data: data.base64Data
      });
    };
    const timer = setTimeout(() => {
      settle(reject, new Error("Page context fetch timed out"));
    }, options.timeoutMs || PAGE_CONTEXT_FETCH_TIMEOUT_MS);

    window.addEventListener("message", onMessage);
    script.textContent = `(() => {
      const request = ${JSON.stringify({ requestId, url: originalUrl })};
      const toBase64 = (buffer) => {
        const bytes = new Uint8Array(buffer);
        const chunkSize = 0x8000;
        let binary = "";
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
        }
        return btoa(binary);
      };
      fetch(request.url, { credentials: "include" }).then(async (response) => {
        if (!response.ok) {
          window.postMessage({
            source: "codex-bridge-page-fetch",
            requestId: request.requestId,
            ok: false,
            status: response.status,
            error: "Download failed with status " + response.status
          }, "*");
          return;
        }
        window.postMessage({
          source: "codex-bridge-page-fetch",
          requestId: request.requestId,
          ok: true,
          url: response.url || request.url,
          contentType: response.headers.get("content-type") || "",
          contentDisposition: response.headers.get("content-disposition") || "",
          base64Data: toBase64(await response.arrayBuffer())
        }, "*");
      }).catch((error) => {
        window.postMessage({
          source: "codex-bridge-page-fetch",
          requestId: request.requestId,
          ok: false,
          error: error && error.message ? error.message : String(error)
        }, "*");
      });
    })();`;

    try {
      parent.appendChild(script);
    } catch (error) {
      settle(reject, error);
    }
  });
}

async function downloadArtifactFromUrl(originalUrl, options = {}) {
  let response;
  try {
    response = await fetch(originalUrl, { credentials: "include" });
  } catch (error) {
    try {
      return await downloadArtifactFromPageContextUrl(originalUrl, options);
    } catch {
      throw error;
    }
  }
  if (!response.ok) {
    const error = new Error(`Download failed with status ${response.status}`);
    try {
      return await downloadArtifactFromPageContextUrl(originalUrl, options);
    } catch {
      throw error;
    }
  }

  const buffer = await response.arrayBuffer();
  return {
    filename:
      options.filename ||
      filenameFromContentDisposition(response.headers?.get("content-disposition")) ||
      filenameFromUrl(response.url || originalUrl) ||
      "chatgpt-artifact",
    contentType: response.headers?.get("content-type") || options.contentType || "application/octet-stream",
    originalUrl: response.url || originalUrl,
    base64Data: arrayBufferToBase64(buffer)
  };
}

async function downloadArtifactFromImage(image, options = {}) {
  const originalUrl = imageSourceUrl(image);
  const response = await fetch(originalUrl, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Image download failed with status ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  return {
    filename: filenameFromImage(image, options.messageNode, options.index, options),
    contentType: response.headers?.get("content-type") || "image/png",
    originalUrl: response.url || originalUrl,
    base64Data: arrayBufferToBase64(buffer)
  };
}

function canAskBackgroundForDownloads() {
  return typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function";
}

function chromeRuntimeMessage(payload, options = {}) {
  return new Promise((resolve, reject) => {
    if (!canAskBackgroundForDownloads()) {
      reject(new Error("Chrome extension download bridge is unavailable"));
      return;
    }

    let settled = false;
    let timeoutId = null;
    const settle = (fn, value) => {
      if (!settled) {
        settled = true;
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
        fn(value);
      }
    };

    const timeoutMs = Number(options.timeoutMs);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        const error = new Error(options.timeoutMessage || "Chrome extension message timed out");
        error.errorCode = "chrome_runtime_message_timeout";
        settle(reject, error);
      }, timeoutMs);
    }

    const callback = (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        settle(reject, new Error(lastError.message));
        return;
      }
      settle(resolve, response);
    };

    const maybePromise = chrome.runtime.sendMessage(payload, callback);
    if (maybePromise && typeof maybePromise.then === "function") {
      maybePromise.then((response) => settle(resolve, response), (error) => settle(reject, error));
    }
  });
}

function shouldUseTrustedClick(button) {
  const className = typeof button?.className === "string" ? button.className : button?.className?.baseVal || "";
  const label = elementLabel(button);
  return /\bbehavior-btn\b/.test(className) || /zip|\u4e0b\u8f7d\u6253\u5305/i.test(label);
}

function clickCoordinates(button) {
  const rect = button?.getBoundingClientRect?.() || button?.getClientRects?.()?.[0];
  if (!rect) {
    return null;
  }
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2
  };
}

async function scrollElementIntoClickView(element) {
  if (typeof element?.scrollIntoView === "function") {
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    await sleep(100);
  }
}

async function triggerDownloadButton(button) {
  if (canAskBackgroundForDownloads()) {
    try {
      await scrollElementIntoClickView(button);
      const point = clickCoordinates(button);
      if (point) {
        const clicked = await chromeRuntimeMessage({
          type: "bridge:trustedClick",
          x: point.x,
          y: point.y
        });
        if (clicked?.ok) {
          return;
        }
      }
    } catch {
      // Fall back to a DOM click when debugger-backed trusted clicks are unavailable.
    }
  }

  button.click();
}

async function triggerSendButton(button, options = {}) {
  await scrollElementIntoClickView(button);
  const point = clickCoordinates(button);
  const attempt = {
    hadPoint: Boolean(point),
    usedTrustedClick: false,
    trustedClickOk: false,
    fallbackDomClick: false,
    buttonBefore: buttonDiagnosticInfo(button)
  };
  if (point && canAskBackgroundForDownloads()) {
    try {
      const clicked = await chromeRuntimeMessage({
        type: "bridge:trustedClick",
        x: point.x,
        y: point.y
      }, {
        timeoutMs: Number(options.runtimeTimeoutMs) || 1500,
        timeoutMessage: "trusted click timed out"
      });
      attempt.usedTrustedClick = true;
      attempt.trustedClickOk = Boolean(clicked?.ok);
      if (!clicked?.ok && clicked?.error) {
        attempt.trustedClickError = truncateDiagnosticText(clicked.error, 160);
      }
      if (clicked?.ok) {
        attempt.buttonAfter = buttonDiagnosticInfo(button);
        return attempt;
      }
    } catch (error) {
      attempt.usedTrustedClick = true;
      attempt.trustedClickError =
        error?.errorCode === "chrome_runtime_message_timeout"
          ? "trusted click timed out"
          : "trusted click threw";
      // Fall back to DOM click when Chrome debugger clicks are unavailable.
    }
  }

  button.click();
  attempt.fallbackDomClick = true;
  attempt.buttonAfter = buttonDiagnosticInfo(button);
  return attempt;
}

function dispatchEnterSubmit(composer) {
  if (typeof KeyboardEvent !== "function") {
    return false;
  }

  let dispatched = false;
  for (const type of ["keydown", "keypress", "keyup"]) {
    const event = new KeyboardEvent(type, {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true
    });
    composer?.dispatchEvent?.(event);
    dispatched = true;
  }
  return dispatched;
}

async function retryUnsentComposerDraft(job, context = {}) {
  const composer = context.composer || null;
  const sendButton = context.sendButton || null;
  const attempt = {
    reason: "draft_still_in_composer",
    domClick: false,
    formSubmit: false,
    enterSubmit: false,
    buttonBefore: buttonDiagnosticInfo(sendButton)
  };

  if (!composer || !composerContainsBridgeDraft(composer, job?.payloadText)) {
    attempt.skipped = "draft_not_present";
    return attempt;
  }

  composer.focus?.();
  await sleep(150);

  if (sendButton && !isDisabledButton(sendButton)) {
    sendButton.click?.();
    attempt.domClick = true;
    await sleep(700);
  }

  if (composerContainsBridgeDraft(composer, job?.payloadText)) {
    const form = composer.closest?.("form") || sendButton?.closest?.("form") || null;
    if (form?.requestSubmit) {
      try {
        form.requestSubmit(sendButton || undefined);
        attempt.formSubmit = true;
        await sleep(700);
      } catch {
        attempt.formSubmitError = "requestSubmit failed";
      }
    }
  }

  if (composerContainsBridgeDraft(composer, job?.payloadText)) {
    composer.focus?.();
    attempt.enterSubmit = dispatchEnterSubmit(composer);
    await sleep(700);
  }

  attempt.buttonAfter = buttonDiagnosticInfo(sendButton);
  attempt.composerStillContainsDraft = Boolean(composerContainsBridgeDraft(composer, job?.payloadText));
  return attempt;
}

function isDownloadTimeoutError(error) {
  return /Timed out waiting for Chrome download/i.test(String(error?.message || error || ""));
}

async function captureArtifactFromDownloadButtonAttempt(button, options = {}) {
  const expectedFilename = expectedFilenameForButton(button, options.messageNode) || null;
  const watch = await chromeRuntimeMessage({
    type: "bridge:startDownloadWatch",
    bridgeOrigin: BRIDGE_ORIGIN,
    bridgeApiToken: cachedBridgeApiToken || null,
    syncJobId: options.syncJobId || null,
    expectedFilename,
    timeoutMs: options.timeoutMs || DOWNLOAD_CAPTURE_TIMEOUT_MS
  });

  if (!watch?.ok || !watch.watchId) {
    throw new Error(watch?.error || "Could not start Chrome download watch");
  }

  if (options.domClickOnly) {
    button.click?.();
  } else {
    await triggerDownloadButton(button);
  }

  const captured = await chromeRuntimeMessage({
    type: "bridge:awaitDownloadWatch",
    bridgeOrigin: BRIDGE_ORIGIN,
    watchId: watch.watchId
  });

  if (!captured?.ok || !captured.artifact?.id) {
    throw new Error(captured?.error || "Chrome download was not captured");
  }

  return captured.artifact;
}

async function captureArtifactFromDownloadButton(button, options = {}) {
  const expectedFilename = expectedFilenameForButton(button, options.messageNode) || null;
  const shouldProbeThenRetry = expectedFilename && !/\.zip$/i.test(expectedFilename);
  try {
    return await captureArtifactFromDownloadButtonAttempt(button, {
      ...options,
      timeoutMs: shouldProbeThenRetry ? DOWNLOAD_CAPTURE_PROBE_TIMEOUT_MS : DOWNLOAD_CAPTURE_TIMEOUT_MS
    });
  } catch (error) {
    if (!shouldProbeThenRetry || !isDownloadTimeoutError(error)) {
      throw error;
    }
    return captureArtifactFromDownloadButtonAttempt(button, {
      ...options,
      domClickOnly: true,
      timeoutMs: DOWNLOAD_CAPTURE_TIMEOUT_MS
    });
  }
}

async function captureArtifactFromDownloadUrl(resource, options = {}) {
  const captured = await chromeRuntimeMessage({
    type: "bridge:downloadUrl",
    bridgeOrigin: BRIDGE_ORIGIN,
    bridgeApiToken: cachedBridgeApiToken || null,
    syncJobId: options.syncJobId || null,
    url: resource.url,
    filename: resource.filename || filenameFromUrl(resource.url) || null,
    timeoutMs: DOWNLOAD_CAPTURE_TIMEOUT_MS,
    quietOnly: options.quietOnly === true
  });

  if (!captured?.ok || !captured.artifact?.id) {
    throw new Error(captured?.error || "Chrome URL download was not captured");
  }

  return captured.artifact;
}

async function recoverArtifactIdsForSyncJob(syncJobId, expectedFilenames = []) {
  if (!syncJobId) {
    return [];
  }
  try {
    const result = await bridgeApi(`/api/artifacts?syncJobId=${encodeURIComponent(syncJobId)}`);
    const artifacts = Array.isArray(result?.artifacts) ? result.artifacts : [];
    const wanted = new Set(expectedFilenames.filter(Boolean));
    return artifacts
      .filter((artifact) => artifact?.id && (!wanted.size || wanted.has(artifact.filename)))
      .map((artifact) => artifact.id);
  } catch {
    return [];
  }
}

async function collectImageArtifacts(messageNode, errors = [], options = {}) {
  const artifacts = [];
  const imageSeen = options.imageSeen || new Set();
  const configuredLimit = Number(options.maxArtifacts ?? options.expectedImageCount);
  const maxArtifacts =
    Number.isFinite(configuredLimit) && configuredLimit > 0
      ? Math.floor(configuredLimit)
      : Number.POSITIVE_INFINITY;
  let artifactIndex = Number.isFinite(Number(options.startIndex)) ? Number(options.startIndex) : 0;
  const images = imageCandidates(messageNode, options);
  const requestedFilenames =
    options.requestedFilenames ||
    filenamesFromText(messageNode?.textContent || "").filter((filename) => /\.(png|jpe?g|webp|gif|svg)$/i.test(filename));
  for (const image of images) {
    if (artifacts.length >= maxArtifacts) {
      break;
    }
    const src = imageSourceUrl(image);
    const key = imageCandidateKey(image);
    if (!src || !key || imageSeen.has(key)) {
      continue;
    }
    imageSeen.add(key);

    const currentIndex = artifactIndex;
    artifactIndex += 1;
    try {
      artifacts.push(
        await downloadArtifactFromImage(image, {
          messageNode,
          index: currentIndex,
          requestedFilename: options.requestedFilename,
          requestedFilenames
        })
      );
    } catch (error) {
      errors.push({
        filename: filenameFromImage(image, messageNode, currentIndex, { ...options, requestedFilenames }),
        originalUrl: src,
        error: error.message
      });
    }
  }
  return artifacts;
}

async function collectInteractiveImageGalleryArtifacts(messageNode, errors = [], options = {}) {
  const artifacts = [];
  const configuredLimit = Number(options.maxArtifacts ?? options.expectedImageCount);
  const maxArtifacts =
    Number.isFinite(configuredLimit) && configuredLimit > 0
      ? Math.floor(configuredLimit)
      : Number.POSITIVE_INFINITY;
  const controls = imageGalleryControlCandidates(messageNode);
  for (const control of controls) {
    if (artifacts.length >= maxArtifacts) {
      break;
    }
    try {
      control.click?.();
      await sleep(150);
      const captured = await collectImageArtifacts(messageNode, errors, {
        ...options,
        startIndex: (options.startIndex || 0) + artifacts.length,
        maxArtifacts: maxArtifacts - artifacts.length
      });
      artifacts.push(...captured);
    } catch (error) {
      errors.push({
        filename: null,
        originalUrl: null,
        error: error.message
      });
    }
  }
  return artifacts;
}

async function collectInterpreterDownloadArtifacts(messageNode, errors = [], options = {}) {
  const artifacts = [];
  const artifactIds = [];
  const seen = new Set();
  const filenames = downloadFilenamesFromMessage(messageNode);
  const resources = interpreterDownloadResourcesForFilenames(filenames);

  for (const resource of resources) {
    if (seen.has(resource.url)) {
      continue;
    }
    seen.add(resource.url);

    try {
      let backgroundError = null;
      let directError = null;

      if (canAskBackgroundForDownloads()) {
        try {
          const artifact = await captureArtifactFromDownloadUrl(resource, {
            syncJobId: options.syncJobId || null,
            quietOnly: true
          });
          artifactIds.push(artifact.id);
          continue;
        } catch (error) {
          backgroundError = error;
        }
      }

      try {
        artifacts.push(await downloadArtifactFromUrl(resource.url, { filename: resource.filename }));
        continue;
      } catch (error) {
        directError = error;
      }

      throw directError || backgroundError || new Error("Interpreter download was not captured");
    } catch (error) {
      errors.push({
        filename: resource.filename || null,
        originalUrl: resource.url,
        error: error.message
      });
    }
  }

  return { artifacts, artifactIds };
}

async function revealInterpreterDownloadResources(messageNode) {
  const filenames = new Set(downloadFilenamesFromMessage(messageNode));
  const seen = new Set();
  const buttons = [...(messageNode?.querySelectorAll?.("button") || [])].filter((button) => {
    const filename = filenameFromText(elementLabel(button));
    if (!filename || seen.has(filename) || !filenames.has(filename) || !isInterpreterFileReferenceButton(button, messageNode)) {
      return false;
    }
    seen.add(filename);
    return true;
  });

  for (const button of buttons) {
    try {
      await triggerDownloadButton(button);
      await sleep(250);
    } catch {
      button.click?.();
      await sleep(250);
    }
  }
}

function hasZipArtifactMention(messageNode) {
  return downloadFilenamesFromMessage(messageNode).some((filename) => /\.zip$/i.test(filename));
}

function hasExplicitDownloadSurface(messageNode) {
  const anchors = [...(messageNode?.querySelectorAll?.("a[href]") || [])].filter(isDownloadCandidate);
  if (anchors.length > 0) {
    return true;
  }
  return downloadButtonCandidates(messageNode).length > 0;
}

function isPreviewOnlyPresentationMessage(messageNode) {
  const filenames = downloadFilenamesFromMessage(messageNode);
  if (!filenames.some((filename) => /\.pptx?$/i.test(filename))) {
    return false;
  }
  if (hasExplicitDownloadSurface(messageNode)) {
    return false;
  }

  const text = messageNode?.textContent || "";
  const buttons = [...(messageNode?.querySelectorAll?.("button") || [])].filter(isVisibleElement);
  const buttonText = buttons.map((button) => elementLabel(button)).join(" ");
  const hasPresentationPreviewSignal =
    /presentation|slide deck|slides?|\u6f14\u793a\u6587\u7a3f|\u5e7b\u706f\u7247|PowerPoint|PPT/i.test(
      `${text} ${buttonText}`
    ) && buttons.some(isExpansionLikeButton);

  return hasPresentationPreviewSignal;
}

function interpreterResourceWaitTimeoutForMessage(messageNode) {
  const hasOfficePreviewFilename = downloadFilenamesFromMessage(messageNode).some((filename) =>
    /\.(?:docx?|xlsx?|pdf)$/i.test(filename)
  );
  if (
    hasOfficePreviewFilename &&
    !hasExplicitDownloadSurface(messageNode) &&
    imageCandidates(messageNode).length > 0
  ) {
    return 750;
  }
  return 5000;
}

async function collectAnchorAndButtonArtifacts(messageNode, errors = [], options = {}) {
  const artifacts = [];
  const artifactIds = [];
  const seen = new Set();
  const anchors = [...(messageNode?.querySelectorAll?.("a[href]") || [])].filter(isDownloadCandidate);

  for (const anchor of anchors) {
    const href = anchor.href || anchor.getAttribute?.("href");
    if (!href || seen.has(href)) {
      continue;
    }
    seen.add(href);

    try {
      artifacts.push(await downloadArtifactFromAnchor(anchor));
    } catch (error) {
      errors.push({
        filename: anchor.download || filenameFromUrl(href) || null,
        originalUrl: href,
        error: error.message
      });
    }
  }

  const attemptedButtonElements = new Set();
  const attemptedNonZipButtonKeys = new Set();
  const buttons = downloadButtonCandidates(messageNode).filter(
    (button) => options.includeInterpreterButtons || !isInterpreterFileReferenceButton(button, messageNode)
  );
  for (const button of buttons) {
    if (attemptedButtonElements.has(button)) {
      continue;
    }
    attemptedButtonElements.add(button);

    const expectedFilename = expectedFilenameForButton(button, messageNode) || elementLabel(button);
    const buttonKey = expectedFilename || elementLabel(button) || `button-${attemptedButtonElements.size}`;
    const allowSameFilenameRetry = /\.zip$/i.test(expectedFilename || "");
    if (!allowSameFilenameRetry && attemptedNonZipButtonKeys.has(buttonKey)) {
      continue;
    }
    if (!allowSameFilenameRetry) {
      attemptedNonZipButtonKeys.add(buttonKey);
    }
    const existingErrorIndex = errors.findIndex((entry) => entry.filename === expectedFilename);
    const errorIndex = existingErrorIndex >= 0 ? existingErrorIndex : errors.length;

    try {
      const artifact = await captureArtifactFromDownloadButton(button, {
        messageNode,
        syncJobId: options.syncJobId || null
      });
      errors.splice(errorIndex);
      artifactIds.push(artifact.id);
    } catch (error) {
      const recoveredArtifactIds = await recoverArtifactIdsForSyncJob(options.syncJobId, [expectedFilename]);
      if (recoveredArtifactIds.length > 0) {
        errors.splice(errorIndex);
        artifactIds.push(...recoveredArtifactIds);
        continue;
      }
      errors.push({
        filename: expectedFilename || null,
        originalUrl: null,
        error: error.message
      });
    }
  }

  return { artifacts, artifactIds };
}

async function collectDownloadArtifacts(messageNode, options = {}) {
  const artifacts = [];
  const artifactIds = [];
  const errors = [];

  if (options.preferImages && imageCandidates(messageNode, options).length > 0) {
    const imageSeen = new Set();
    artifacts.push(...(await collectImageArtifacts(messageNode, errors, { ...options, imageSeen })));
    const expectedImageCount = Number(options.expectedImageCount || 0);
    if (expectedImageCount > 0 && artifacts.length >= expectedImageCount) {
      return { artifacts, artifactIds, errors };
    }
    artifacts.push(
      ...(await collectInteractiveImageGalleryArtifacts(messageNode, errors, {
        ...options,
        imageSeen,
        startIndex: artifacts.length,
        maxArtifacts:
          expectedImageCount > 0
            ? expectedImageCount - artifacts.length
            : undefined
      }))
    );
    return { artifacts, artifactIds, errors };
  }

  const earlyRebuiltTextArtifacts = generatedTextArtifactsFromMessage(messageNode);
  if (earlyRebuiltTextArtifacts.length > 0) {
    artifacts.push(...earlyRebuiltTextArtifacts);
    return { artifacts, artifactIds, errors };
  }

  const visibleImageFilenames = downloadFilenamesFromMessage(messageNode);
  if (
    visibleImageFilenames.length > 0 &&
    visibleImageFilenames.every((filename) => IMAGE_ARTIFACT_FILENAME_RE.test(filename)) &&
    !hasExplicitDownloadSurface(messageNode) &&
    imageCandidates(messageNode, options).length > 0
  ) {
    artifacts.push(...(await collectImageArtifacts(messageNode, errors, options)));
    return { artifacts, artifactIds, errors };
  }

  let skipFinalDirectArtifacts = false;
  let suppressErrorsFrom = null;
  let triedInterpreterResources = false;
  const interpreterFilenames = downloadFilenamesFromMessage(messageNode);
  const skipInterpreterResources =
    interpreterFilenames.length === 0 || isPreviewOnlyPresentationMessage(messageNode);
  if (hasZipArtifactMention(messageNode)) {
    const zipResources = interpreterDownloadResourcesForFilenames(filenamesFromText(messageNode?.textContent || ""));
    if (zipResources.length > 0) {
      triedInterpreterResources = true;
      const zipErrorCount = errors.length;
      const zipInterpreterArtifacts = await collectInterpreterDownloadArtifacts(messageNode, errors, options);
      artifacts.push(...zipInterpreterArtifacts.artifacts);
      artifactIds.push(...zipInterpreterArtifacts.artifactIds);
      if (artifacts.length > 0 || artifactIds.length > 0) {
        return { artifacts, artifactIds, errors };
      }
      if (errors.length > zipErrorCount) {
        skipFinalDirectArtifacts = true;
      }
    } else {
      const zipErrorCount = errors.length;
      const directArtifacts = await collectAnchorAndButtonArtifacts(messageNode, errors, options);
      artifacts.push(...directArtifacts.artifacts);
      artifactIds.push(...directArtifacts.artifactIds);
      if (artifacts.length > 0 || artifactIds.length > 0) {
        return { artifacts, artifactIds, errors };
      }
      if (errors.length > zipErrorCount) {
        skipFinalDirectArtifacts = true;
        suppressErrorsFrom = zipErrorCount;
      }
    }
  }

  if (!hasZipArtifactMention(messageNode) && hasExplicitDownloadSurface(messageNode)) {
    const directErrorCount = errors.length;
    const immediateDirectArtifacts = await collectAnchorAndButtonArtifacts(messageNode, errors, options);
    artifacts.push(...immediateDirectArtifacts.artifacts);
    artifactIds.push(...immediateDirectArtifacts.artifactIds);
    if (artifacts.length > 0 || artifactIds.length > 0) {
      return { artifacts, artifactIds, errors };
    }
    if (errors.length > directErrorCount && suppressErrorsFrom === null) {
      suppressErrorsFrom = directErrorCount;
    }
  }

  let interpreterArtifacts = { artifacts: [], artifactIds: [] };
  if (!triedInterpreterResources && !skipInterpreterResources) {
    const interpreterErrorCount = errors.length;
    interpreterArtifacts = await collectInterpreterDownloadArtifacts(messageNode, errors, options);
    artifacts.push(...interpreterArtifacts.artifacts);
    artifactIds.push(...interpreterArtifacts.artifactIds);
    if (artifacts.length === 0 && artifactIds.length === 0 && errors.length > interpreterErrorCount) {
      triedInterpreterResources = true;
    }
  }
  if (
    artifacts.length === 0 &&
    artifactIds.length === 0 &&
    !skipFinalDirectArtifacts &&
    !skipInterpreterResources &&
    !triedInterpreterResources
  ) {
    await revealInterpreterDownloadResources(messageNode);
    await waitForInterpreterDownloadResources(
      interpreterFilenames,
      interpreterResourceWaitTimeoutForMessage(messageNode)
    );
    interpreterArtifacts = await collectInterpreterDownloadArtifacts(messageNode, errors, options);
    artifacts.push(...interpreterArtifacts.artifacts);
    artifactIds.push(...interpreterArtifacts.artifactIds);
  }
  if (artifacts.length > 0 || artifactIds.length > 0) {
    if (suppressErrorsFrom !== null) {
      errors.splice(suppressErrorsFrom);
    }
    return { artifacts, artifactIds, errors };
  }
  if (skipFinalDirectArtifacts) {
    return { artifacts, artifactIds, errors };
  }

  const directArtifacts = await collectAnchorAndButtonArtifacts(messageNode, errors, {
    ...options,
    includeInterpreterButtons: true
  });
  artifacts.push(...directArtifacts.artifacts);
  artifactIds.push(...directArtifacts.artifactIds);

  if (artifacts.length === 0 && artifactIds.length === 0) {
    const rebuiltTextArtifacts = generatedTextArtifactsFromMessage(messageNode);
    if (rebuiltTextArtifacts.length > 0) {
      artifacts.push(...rebuiltTextArtifacts);
      errors.splice(0);
      return { artifacts, artifactIds, errors };
    }
    const rebuiltSpreadsheetArtifacts = generatedSpreadsheetArtifactsFromMessage(messageNode);
    if (rebuiltSpreadsheetArtifacts.length > 0) {
      artifacts.push(...rebuiltSpreadsheetArtifacts);
      errors.splice(0);
      return { artifacts, artifactIds, errors };
    }
    if (!hasExplicitNonImageDownloadFilename(messageNode)) {
      artifacts.push(...(await collectImageArtifacts(messageNode, errors, options)));
    }
  }

  return { artifacts, artifactIds, errors };
}

async function waitForAssistantReply(previousText, options = {}) {
  const started = Date.now();
  let lastActivityAt = started;
  let lastActivitySignature = "";
  let lastActiveCheckAt = started;
  let stableText = "";
  let stableCount = 0;
  let pendingArtifactText = "";
  let pendingArtifactMessage = null;
  let streamingProbeText = "";
  let streamingStableCount = 0;
  let pageBlockerScanNeeded = true;
  const expectedImageCount = Number(options.expectedImageCount || 0);
  const afterUserTexts = promptTextCandidates(options.afterUserTexts || [], options.afterUserText, options.alternateUserTexts || []);
  const assertNoBlockerAfterPageChange = (blockerOptions = {}) => {
    if (!pageBlockerScanNeeded) {
      return;
    }
    assertNoChatGptBlocker(blockerOptions);
    pageBlockerScanNeeded = false;
  };

  while (true) {
    const now = Date.now();
    if (options.job && now - lastActiveCheckAt >= ACTIVE_JOB_CHECK_INTERVAL_MS && !(await syncJobStillActive(options.job))) {
      lastActiveCheckAt = now;
      const stoppedError = new Error("Bridge sync job stopped.");
      stoppedError.bridgeJobStopped = true;
      throw stoppedError;
    }
    lastActiveCheckAt = options.job && now - lastActiveCheckAt >= ACTIVE_JOB_CHECK_INTERVAL_MS ? now : lastActiveCheckAt;
    const turnsSnapshot =
      Number.isInteger(options.afterUserTurnIndex) || afterUserTexts.length > 0
        ? conversationTurns()
        : null;
    const requiresScopedReply = Number.isInteger(options.afterUserTurnIndex) || afterUserTexts.length > 0;
    const hasScopedTurnSnapshot = Array.isArray(turnsSnapshot) && turnsSnapshot.length > 0;
    const scopedMessages = assistantMessagesForReplyScope(
      options.afterUserTurnIndex,
      afterUserTexts,
      turnsSnapshot
    );
    const scopedCurrentMessage =
      scopedMessages[scopedMessages.length - 1] ||
      (!requiresScopedReply || !hasScopedTurnSnapshot
        ? lastAssistantMessage({
            afterUserTurnIndex: options.afterUserTurnIndex,
            afterUserTexts,
            afterUserText: options.afterUserText,
            turns: turnsSnapshot,
            requireAfterUserText: false
          })
        : null);
       const currentMessage =
      scopedCurrentMessage ||
      (Number.isInteger(options.afterUserTurnIndex)
        ? latestChangedAssistantMessage(previousText)
        : null);
       const pageStillGenerating = isGenerating();
    const activityText = cleanChatGptReplyText(
      assistantReplyRoot(currentMessage)?.textContent || ""
    );
    const activityImageCount = uniqueGeneratedImageCount(currentMessage, {
      expectedImageCount,
      excludeImageKeys: options.excludeImageKeys
    });
    const activityHasDownload = hasDownloadableArtifact(currentMessage);
    const activitySignature = `${activityText}\nimages:${activityImageCount}\ndownload:${activityHasDownload}`;
    if (pageStillGenerating || activitySignature !== lastActivitySignature) {
      lastActivityAt = now;
      lastActivitySignature = activitySignature;
    }
    if (responseWaitExpired({ startedAt: started, lastActivityAt, now, pageStillGenerating })) {
      break;
    }
    if (pageStillGenerating) {
      const streamingText = activityText;
      if (hasGenerationFailureText(streamingText)) {
        const blocker = generationFailureBlocker();
        throw bridgeClassifiedError(blocker.message, {
          errorCode: blocker.code,
          recoveryAction: blocker.recoveryAction
        });
      }
      if (streamingText === streamingProbeText) {
        streamingStableCount += 1;
      } else {
        streamingProbeText = streamingText;
        streamingStableCount = streamingText ? 1 : 0;
      }
      const streamingImageCount = activityImageCount;
      const streamingDownloadableArtifact = activityHasDownload;
      if (streamingImageCount > 0 || streamingDownloadableArtifact) {
        pendingArtifactText = streamingText || "\u5df2\u751f\u6210\u56fe\u7247\u3002";
        pendingArtifactMessage = currentMessage;
      }
      const streamingOptions = {
        ...options,
        generatedImageCount: streamingImageCount,
        hasDownloadableArtifact: streamingDownloadableArtifact,
        pageStillGenerating: true
      };
      if (
        streamingStableCount >= effectiveStableTarget(streamingText, streamingOptions) &&
        shouldAcceptStableTextDuringGlobalGeneration(streamingText, streamingOptions)
      ) {
        const stableReply = visibleReplyTextFromAssistant(currentMessage, previousText, {
          allowRepeatedText: scopedMessages.length > 0,
          generatedImageCount: activityImageCount
        });
        if (hasUsableAssistantText(stableReply, previousText, {
          allowRepeatedText: scopedMessages.length > 0
        })) {
          return stableReply;
        }
      }
      pageBlockerScanNeeded = (await waitForAssistantActivity(STREAMING_REPLY_PROBE_MS)) || pageBlockerScanNeeded;
      continue;
    }
    if (
      options.requireFreshUnscopedReply &&
      scopedMessages.length === 0 &&
      !Number.isInteger(options.afterUserTurnIndex) &&
      afterUserTexts.length === 0 &&
      normalizeText(extractAssistantReplyText(currentMessage)) === normalizeText(previousText)
    ) {
      assertNoBlockerAfterPageChange({ afterUserText: options.afterUserText });
      pageBlockerScanNeeded = (await waitForAssistantActivity(1000)) || pageBlockerScanNeeded;
      continue;
    }
    const allowRepeatedText = scopedMessages.length > 0;
    const rawCurrentText = extractAssistantReplyText(currentMessage);
    const hasUsableContent = hasUsableAssistantContent(currentMessage, previousText, {
      allowRepeatedText,
      replyText: rawCurrentText,
      generatedImageCount: activityImageCount,
      hasDownloadableArtifact: activityHasDownload
    });
    if (hasUsableContent) {
      const current = visibleReplyTextFromAssistant(currentMessage, previousText, {
        allowRepeatedText,
        replyText: rawCurrentText,
        generatedImageCount: activityImageCount
      });
      const generatedImageCount = activityImageCount;
      const downloadableArtifactPresent = activityHasDownload;
      if (generatedImageCount > 0 || downloadableArtifactPresent) {
        pendingArtifactText = current;
        pendingArtifactMessage = currentMessage;
      }

      if (
        expectedImageCount > 0 &&
        generatedImageCount < expectedImageCount &&
        !downloadableArtifactPresent
      ) {
        assertNoBlockerAfterPageChange({ afterUserText: options.afterUserText });
        pageBlockerScanNeeded = (await waitForAssistantActivity(1000)) || pageBlockerScanNeeded;
        continue;
      }

      if (current === stableText) {
        stableCount += 1;
      } else {
        stableText = current;
        stableCount = 1;
      }

      const stableTarget = effectiveStableTarget(current, {
        ...options,
        generatedImageCount,
        hasDownloadableArtifact: downloadableArtifactPresent,
        pageStillGenerating
      });
      const imageNeedsSettling =
        generatedImageCount > 0 &&
        (imageReplyStillProcessingText(rawCurrentText) || (!downloadableArtifactPresent && expectedImageCount > 0));
      if (imageNeedsSettling && stableCount < (downloadableArtifactPresent ? 5 : 10)) {
        assertNoBlockerAfterPageChange({ afterUserText: afterUserTexts[0] || options.afterUserText });
        pageBlockerScanNeeded = (await waitForAssistantActivity(1000)) || pageBlockerScanNeeded;
        continue;
      }
      if (
        stableCount >= stableTarget &&
        (!pageStillGenerating ||
          shouldAcceptStableTextDuringGlobalGeneration(current, {
            ...options,
            generatedImageCount,
            hasDownloadableArtifact: downloadableArtifactPresent
          }))
      ) {
        return current;
      }
    } else {
      assertNoBlockerAfterPageChange({ afterUserText: afterUserTexts[0] || options.afterUserText });
    }

    pageBlockerScanNeeded = (await waitForAssistantActivity(1000)) || pageBlockerScanNeeded;
  }

  if (pendingArtifactMessage) {
    await stopActiveGenerationIfPossible();
    return pendingArtifactText;
  }

  throw new Error("等待 GPT 回复超时。");
}

async function markJobSent(job, previousAssistantText, submittedPromptInfo = null) {
  await bridgeApi(`/api/sync/jobs/${job.id}/sent`, {
    method: "POST",
    body: JSON.stringify(syncJobMutationBody({
      previousAssistantText,
      submittedPromptTurnIndex: Number.isInteger(submittedPromptInfo?.index)
        ? submittedPromptInfo.index
        : null,
      artifactBaselineImageKeys: job.artifactBaselineImageKeys || [],
      refreshSentAt: !job.sentAt
    }))
  });
}

async function waitForSubmittedPrompt(job, timeoutMs = 15000, contextOrComposer = null) {
  const started = Date.now();
  const promptCandidates = promptCandidatesForJob(job);
  let pageBlockerScanNeeded = true;
  const hasContextOptions =
    contextOrComposer &&
    typeof contextOrComposer === "object" &&
    ("composer" in contextOrComposer || "afterTurnIndex" in contextOrComposer);
  const context = hasContextOptions ? contextOrComposer : { composer: contextOrComposer || null };
  const composer = context.composer || null;
  while (Date.now() - started < timeoutMs) {
    const promptInfo = latestUserPromptTurnInfo(promptCandidates, {
      afterTurnIndex: context.afterTurnIndex
    });
    if (promptInfo) {
      return promptInfo;
    }
    const directPromptInfo = latestDirectUserPromptInfo(promptCandidates, {
      afterUserMessageCount: context.afterUserMessageCount
    });
    if (directPromptInfo) {
      return directPromptInfo;
    }
    if (
      Number.isInteger(context.afterTurnIndex) &&
      composer &&
      !composerContainsBridgeDraft(composer, job?.payloadText) &&
      isGenerating()
    ) {
      return {
        index: context.afterTurnIndex,
        turn: null,
        needle: "",
        fallback: "composer_cleared"
      };
    }
    if (!Number.isInteger(context.afterTurnIndex) && userPromptTurnExistsAny(promptCandidates)) {
      return null;
    }
    if (pageBlockerScanNeeded) {
      assertNoChatGptBlocker();
      pageBlockerScanNeeded = false;
    }
    pageBlockerScanNeeded = (await waitForAssistantActivity(500)) || pageBlockerScanNeeded;
  }
  throw sendConfirmationError(job, context);
}

async function markJobPreSendRefresh(job) {
  if (!job?.id) {
    return null;
  }
  return bridgeApi(`/api/sync/jobs/${job.id}/pre-send-refresh`, {
    method: "POST",
    body: JSON.stringify(syncJobMutationBody())
  });
}

function takePreSendRefreshJob() {
  try {
    const raw = sessionStorage.getItem(PRE_SEND_REFRESH_KEY);
    if (!raw) {
      return null;
    }
    sessionStorage.removeItem(PRE_SEND_REFRESH_KEY);
    const parsed = JSON.parse(raw);
    return parsed?.job || null;
  } catch {
    return null;
  }
}

function storePreSendRefreshJob(job) {
  sessionStorage.setItem(
    PRE_SEND_REFRESH_KEY,
    JSON.stringify({
      job,
      createdAt: new Date().toISOString()
    })
  );
}

async function resolvePreSendRefreshJob(job) {
  if (!job?.id) {
    return { job: job || null, retryLater: false };
  }

  try {
    const latest = (await bridgeApi(`/api/sync/jobs/${encodeURIComponent(job.id)}`))?.job || null;
    if (!latest || latest.status === "succeeded" || latest.status === "failed") {
      return { job: null, retryLater: false };
    }
    const latestProjectUrl = latest.projectUrl || job.projectUrl || "";
    if (
      latestProjectUrl &&
      job.projectUrl &&
      normalizeNavigationUrl(latestProjectUrl) !== normalizeNavigationUrl(job.projectUrl)
    ) {
      return { job: null, retryLater: false };
    }
    return {
      job: {
        ...job,
        ...latest,
        _bridgePreSendRefresh: latest._bridgePreSendRefresh ?? job._bridgePreSendRefresh,
        _bridgeRefreshAttempts: latest._bridgeRefreshAttempts ?? job._bridgeRefreshAttempts
      },
      retryLater: false
    };
  } catch {
    storePreSendRefreshJob(job);
    return { job: null, retryLater: true };
  }
}

function syncJobNeedsActiveCheck(job) {
  return Boolean(
    job?.id &&
      (job.status === "pending" ||
        job.status === "running" ||
        job.claimedAt)
  );
}

function syncJobIsTerminal(job) {
  return !job || job.status === "succeeded" || job.status === "failed";
}

async function syncJobStillActive(job) {
  if (!syncJobNeedsActiveCheck(job)) {
    return true;
  }

  try {
    const result = await bridgeApi(`/api/sync/jobs/${encodeURIComponent(job.id)}`);
    if (result && Object.prototype.hasOwnProperty.call(result, "job")) {
      return !syncJobIsTerminal(result.job);
    }
  } catch {
    return true;
  }
  return true;
}

function refreshBeforeSending(job, options = {}) {
  if (!job) {
    return false;
  }

  const force = Boolean(options.force);
  if (!job.sentAt && preSendClaimExpired(job)) {
    return false;
  }
  if (job.sentAt && !force) {
    return false;
  }

  const parsedAttempts = Number(job._bridgeRefreshAttempts || 0);
  const attempts = Number.isFinite(parsedAttempts) ? parsedAttempts : 0;
  const maxAttempts = options.maxAttempts ?? 1;
  if (force && attempts >= maxAttempts) {
    return false;
  }

  const jobForRefresh = {
    ...job,
    ...(options.jobPatch || {}),
    _bridgeRefreshAttempts: force ? attempts + 1 : attempts
  };
  const shouldNavigateToProject =
    jobForRefresh.projectUrl && normalizeNavigationUrl(location.href) !== normalizeNavigationUrl(jobForRefresh.projectUrl);
  if (!force && !shouldNavigateToProject) {
    return false;
  }

  try {
    storePreSendRefreshJob(jobForRefresh);
    if (shouldNavigateToProject && typeof location.replace === "function") {
      location.replace(jobForRefresh.projectUrl);
    } else if (shouldNavigateToProject) {
      location.href = jobForRefresh.projectUrl;
    } else if (typeof location.reload === "function") {
      location.reload();
    } else if (jobForRefresh.projectUrl) {
      location.href = jobForRefresh.projectUrl;
    } else {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function heartbeatRecoverySignature(recovery = null) {
  if (!recovery?.action) {
    return null;
  }
  return [
    recovery.action,
    normalizeNavigationUrl(recovery.projectUrl || recovery.job?.projectUrl || ""),
    recovery.job?.id || "",
    recovery.job?.sentAt || "",
    recovery.job?.updatedAt || "",
    recovery.resendIfPromptMissing ? "resend" : "no-resend"
  ].join("|");
}

function heartbeatRecoveryRecentlyHandled(signature) {
  if (!signature) {
    return false;
  }
  try {
    const raw = sessionStorage.getItem(HEARTBEAT_RECOVERY_KEY);
    if (!raw) {
      return false;
    }
    const parsed = JSON.parse(raw);
    return parsed?.signature === signature && Date.now() - Number(parsed?.handledAt || 0) < HEARTBEAT_RECOVERY_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function rememberHeartbeatRecovery(signature) {
  if (!signature) {
    return;
  }
  try {
    sessionStorage.setItem(
      HEARTBEAT_RECOVERY_KEY,
      JSON.stringify({
        signature,
        handledAt: Date.now()
      })
    );
  } catch {
    // Session storage can be unavailable on special pages.
  }
}

async function handleHeartbeatRecovery(recovery) {
  if (
    !recovery ||
    !["navigate", "reload", "stop_generation", "capture_existing_reply"].includes(recovery.action)
  ) {
    return false;
  }
  if (!recoveryMatchesCurrentPage(recovery)) {
    return false;
  }
  if ((recovery.job?.workerId || recovery.workerId) && !recoveryBelongsToCurrentWorker(recovery)) {
    return false;
  }

  const signature = heartbeatRecoverySignature(recovery);
  if (heartbeatRecoveryRecentlyHandled(signature)) {
    return false;
  }

  if (recovery.action === "stop_generation") {
    const stopped = await stopActiveGenerationIfPossible();
    if (stopped) {
      rememberHeartbeatRecovery(signature);
    }
    return stopped;
  }

  if (recovery.action === "capture_existing_reply") {
    const captured = await captureExistingReply(recovery.job);
    if (captured) {
      rememberHeartbeatRecovery(signature);
    }
    return captured;
  }

  if (!recovery.job && recovery.action === "navigate" && recovery.projectUrl) {
    try {
      if (typeof location.replace === "function") {
        location.replace(recovery.projectUrl);
      } else {
        location.href = recovery.projectUrl;
      }
      rememberHeartbeatRecovery(signature);
      return true;
    } catch {
      return false;
    }
  }

  if (!recovery.job) {
    return false;
  }

  const refreshed = refreshBeforeSending(recovery.job, {
    force: true,
    jobPatch: {
      _bridgeRecoveryAction: recovery.action,
      _bridgeResendIfPromptMissing: Boolean(recovery.resendIfPromptMissing && !recovery.job.sentAt)
    }
  });
  if (refreshed) {
    rememberHeartbeatRecovery(signature);
  }
  return refreshed;
}

function heartbeatPreferenceKey(preferences = null) {
  if (!preferences?.updatedAt) {
    return null;
  }
  return [
    normalizeNavigationUrl(preferences.projectUrl || ""),
    preferences.modePreference || "",
    preferences.modelPreference || "",
    preferences.updatedAt
  ].join("|");
}

function preferenceSyncIsThrottled(key) {
  return Boolean(key && key === failedHeartbeatPreferenceKey);
}

function rememberPreferenceSyncFailure(key) {
  failedHeartbeatPreferenceKey = key;
}

function rememberPreferenceSyncSuccess(key) {
  lastHeartbeatPreferenceKey = key;
  failedHeartbeatPreferenceKey = null;
}

function preferencesMatchCurrentPage(preferences = null) {
  return projectUrlMatchesCurrentPage(preferences?.projectUrl);
}

function projectUrlMatchesCurrentPage(projectUrl = "") {
  if (!projectUrl) {
    return false;
  }
  const normalizedProjectUrl = normalizeNavigationUrl(projectUrl);
  const activeUrl = normalizeNavigationUrl(location.href);
  return activeUrl === normalizedProjectUrl || activeUrl.startsWith(`${normalizedProjectUrl}/`);
}

function recoveryMatchesCurrentPage(recovery = null) {
  return projectUrlMatchesCurrentPage(recovery?.projectUrl || recovery?.job?.projectUrl);
}

function recoveryBelongsToCurrentWorker(recovery = null) {
  const workerId =
    recovery?.workerId ||
    recovery?.job?._bridgeRecoveryWorkerId ||
    recovery?.job?.workerId ||
    "";
  return Boolean(workerId && workerId === currentWorkerId());
}

function heartbeatMatchesCurrentPage(heartbeat = null) {
  return Boolean(
    heartbeat?.controlsCurrentPage ||
      projectUrlMatchesCurrentPage(heartbeat?.projectUrl) ||
      preferencesMatchCurrentPage(heartbeat?.preferences) ||
      recoveryMatchesCurrentPage(heartbeat?.recovery)
  );
}

function preferenceStatusError(modeSynced, modelSynced, preferences = {}) {
  if (!modeSynced && preferences.modePreference && !modelSynced && preferences.modelPreference) {
    return "mode and model preferences were not applied";
  }
  if (!modeSynced && preferences.modePreference) {
    return "mode preference was not applied";
  }
  if (!modelSynced && preferences.modelPreference) {
    return "model preference was not applied";
  }
  return "preference was not applied";
}

function setPreferenceStatus(preferences = {}, result = {}) {
  lastPreferenceStatus = {
    state: result.state || "failed",
    modePreference: preferences.modePreference || null,
    modelPreference: preferences.modelPreference || null,
    updatedAt: preferences.updatedAt || null,
    modeSynced: Boolean(result.modeSynced),
    modelSynced: Boolean(result.modelSynced),
    ...(result.error ? { error: result.error } : {}),
    ...(result.diagnostics ? { diagnostics: result.diagnostics } : {})
  };
}

function preferencesAlreadyApplied(preferences = {}) {
  const normalizedPreferences = normalizeChatGptPreferences(preferences || {});
  const needsModel = Boolean(normalizedPreferences.modelPreference);
  const needsMode = Boolean(normalizedPreferences.modePreference);
  if (!needsModel && !needsMode) {
    return true;
  }
  if (lastPreferenceStatus?.state !== "applied") {
    return false;
  }
  return (
    (!needsModel ||
      (lastPreferenceStatus.modelSynced !== false &&
        lastPreferenceStatus.modelPreference === normalizedPreferences.modelPreference)) &&
    (!needsMode ||
      (lastPreferenceStatus.modeSynced !== false &&
        lastPreferenceStatus.modePreference === normalizedPreferences.modePreference))
  );
}

function visiblePreferenceSyncStatus(preferences = {}) {
  const normalizedPreferences = normalizeChatGptPreferences(preferences || {});
  const modelSynced = normalizedPreferences.modelPreference
    ? preferenceApplied("model", modelLabelsForPreference(normalizedPreferences.modelPreference))
    : true;
  const modeSynced = normalizedPreferences.modePreference
    ? preferenceApplied("mode", modeLabelsForPreference(normalizedPreferences.modePreference, normalizedPreferences.modelPreference))
    : true;
  return {
    modeSynced,
    modelSynced,
    applied: modeSynced && modelSynced
  };
}

async function applyHeartbeatPreferences(preferences = null) {
  const normalizedPreferences = normalizeChatGptPreferences(preferences || {});
  const key = heartbeatPreferenceKey(normalizedPreferences);
  if (
    !key ||
    !preferencesMatchCurrentPage(normalizedPreferences)
  ) {
    return false;
  }

  try {
    assertNoChatGptBlocker();
    await waitForComposer();
  } catch (error) {
    setPreferenceStatus(normalizedPreferences, {
      state: "failed",
      modeSynced: !normalizedPreferences?.modePreference,
      modelSynced: !normalizedPreferences?.modelPreference,
      error: error.message || "preference prerequisites were not ready"
    });
    rememberPreferenceSyncFailure(key);
    throw error;
  }

  const visibleStatus = visiblePreferenceSyncStatus(normalizedPreferences);
  if (visibleStatus.applied) {
    rememberPreferenceSyncSuccess(key);
    setPreferenceStatus(normalizedPreferences, {
      state: "applied",
      modeSynced: visibleStatus.modeSynced,
      modelSynced: visibleStatus.modelSynced
    });
    return true;
  }

  if (preferenceSyncIsThrottled(key)) {
    return false;
  }

  const modelSynced = normalizedPreferences.modelPreference ? await selectModelPreference(normalizedPreferences).catch((error) => {
    console.warn("Bridge model sync skipped:", error);
    return false;
  }) : true;
  const modeSynced = normalizedPreferences.modePreference ? await selectModePreference(normalizedPreferences).catch((error) => {
    console.warn("Bridge mode sync skipped:", error);
    return false;
  }) : true;
  if (!modeSynced || !modelSynced) {
    rememberPreferenceSyncFailure(key);
    setPreferenceStatus(normalizedPreferences, {
      state: "failed",
      modeSynced,
      modelSynced,
      error: preferenceStatusError(modeSynced, modelSynced, normalizedPreferences),
      diagnostics: lastPreferenceAttemptDiagnostic
    });
    return false;
  }
  rememberPreferenceSyncSuccess(key);
  setPreferenceStatus(normalizedPreferences, {
    state: "applied",
    modeSynced,
    modelSynced
  });
  return true;
}

async function processPreferenceSyncJob(job) {
  if (!ensureExpectedChatGptPage(job)) {
    return;
  }
  await waitForComposer();
  const normalizedJob = normalizeChatGptPreferences(job);

  const modelSynced = normalizedJob.modelPreference ? await selectModelPreference(normalizedJob).catch((error) => {
    console.warn("Bridge model sync skipped:", error);
    return false;
  }) : true;
  const modeSynced = normalizedJob.modePreference ? await selectModePreference(normalizedJob).catch((error) => {
    console.warn("Bridge mode sync skipped:", error);
    return false;
  }) : true;

  await bridgeApi(`/api/sync/jobs/${job.id}/complete`, {
    method: "POST",
    body: JSON.stringify(syncJobMutationBody({
      replyText: "GPT 偏好已同步",
      artifacts: [],
      artifactIds: [],
      artifactErrors: [
        ...(!modeSynced && normalizedJob.modePreference ? [{ error: `Mode preference was not found: ${normalizedJob.modePreference}` }] : []),
        ...(!modelSynced && normalizedJob.modelPreference ? [{ error: `Model preference was not found: ${normalizedJob.modelPreference}` }] : [])
      ]
    }))
  });
}

async function processJob(job, options = {}) {
  if (job.kind === "preference_sync") {
    await processPreferenceSyncJob(job);
    return;
  }
  if (!(await syncJobStillActive(job))) {
    return;
  }

  const promptCandidates = promptCandidatesForJob(job);
  const isResume = Boolean(options.resume || job.resume || job.sentAt);
  if (!isResume && preSendClaimExpired(job)) {
    throw preSendExpiredError();
  }
  if (
    !isResume &&
    job.projectUrl &&
    job._bridgeNeedsPreSendRefresh &&
    !options.afterPreSendRefresh &&
    !job._bridgePreSendRefresh
  ) {
    const marked = await markJobPreSendRefresh(job).catch(() => null);
    const refreshJob = marked?.job || marked || job;
    if (refreshBeforeSending(refreshJob, { force: true, maxAttempts: 2 })) {
      return;
    }
  }
  const previous = job.previousAssistantText || lastAssistantText();
  let submittedPromptInfo = Number.isInteger(job.submittedPromptTurnIndex)
    ? { index: job.submittedPromptTurnIndex }
    : null;

  if (!isResume) {
    let preSendShouldReturn = false;
    try {
      // Do not race the mutating send path against an outer timer. A timed-out
      // Promise.race does not cancel DOM work, so the abandoned branch could
      // click Send after Bridge had already classified the job as unsent.
      await (async () => {
    if (!ensureExpectedChatGptPage(job)) {
      preSendShouldReturn = true;
      return;
    }
    try {
      await stopStaleGenerationIfNeeded();
    } catch (error) {
      if (refreshBeforeSending(job, { force: true })) {
        preSendShouldReturn = true;
        return;
      }
      throw error;
    }
    try {
      await dismissArtifactPreviewIfNeeded();
    } catch (error) {
      if (error?.errorCode === "artifact_preview_stuck" && refreshBeforeSending(job, { force: true })) {
        preSendShouldReturn = true;
        return;
      }
      throw error;
    }

    let composer = null;
    try {
      composer = await waitForComposer();
    } catch (error) {
      if (/composer not found|no composer appeared|\u8f93\u5165\u6846\u6ca1\u6709\u627e\u5230|\u8f93\u5165\u6846\u8fd8\u6ca1\u6709\u51fa\u73b0|\u4ecd\u5728\u52a0\u8f7d|loading/i.test(error.message || "") && refreshBeforeSending(job, { force: true })) {
        preSendShouldReturn = true;
        return;
      }
      throw error;
    }

    const normalizedJob = normalizeChatGptPreferences(job);
    if (!preferencesAlreadyApplied(normalizedJob)) {
      await selectModelPreference(normalizedJob).catch((error) => {
        console.warn("Bridge model sync skipped:", error);
      });
      if (normalizedJob.modePreference) {
        await selectModePreference(normalizedJob).catch((error) => {
          console.warn("Bridge mode sync skipped:", error);
        });
      }
    }
    await fillComposerText(composer, job.payloadText);
    await sleep(300);
    try {
      await uploadInputArtifacts(job);
      await sleep(700);
      let sendButton = null;
      try {
        sendButton = await waitForReadySendButton();
      } catch (error) {
        if (/send button not ready|\u53d1\u9001\u6309\u94ae\u8fd8\u6ca1(?:\u6709)?\u51c6\u5907\u597d/i.test(error.message || "")) {
          throw sendButtonNotReadyError(job, { composer });
        }
        throw error;
      }

      const lastTurnIndexBeforeSend = conversationTurns().length - 1;
      const userMessageCountBeforeSend = directUserPromptNodes().length;
      job.artifactBaselineImageKeys = generatedImageBaselineKeys();
      const sendAttempt = await triggerSendButton(sendButton);
      try {
        submittedPromptInfo = await waitForSubmittedPrompt(job, 4000, {
          composer,
            sendButton,
            sendAttempt,
            afterTurnIndex: lastTurnIndexBeforeSend,
            afterUserMessageCount: userMessageCountBeforeSend
        });
      } catch (error) {
        if (error?.errorCode !== "send_not_confirmed" || !composerContainsBridgeDraft(composer, job.payloadText)) {
          throw error;
        }

        sendAttempt.retry = await retryUnsentComposerDraft(job, { composer, sendButton });
        submittedPromptInfo = await waitForSubmittedPrompt(job, 12000, {
          composer,
            sendButton,
            sendAttempt,
            afterTurnIndex: lastTurnIndexBeforeSend,
            afterUserMessageCount: userMessageCountBeforeSend
        });
      }
      await markJobSent(job, previous, submittedPromptInfo);
    } catch (error) {
      const promptWasSubmitted = Boolean(job.payloadText && userPromptTurnExistsAny(promptCandidates));
      if (!promptWasSubmitted) {
        clearBridgeDraftIfPresent(composer, job.payloadText);
      }
      if (/attachment did not appear|file input not found|\u9644\u4ef6\u6ca1\u6709\u51fa\u73b0\u5728\u8f93\u5165\u6846|\u6587\u4ef6\u8f93\u5165\u63a7\u4ef6\u6ca1\u6709\u627e\u5230/i.test(error.message || "") && refreshBeforeSending(job, { force: true })) {
        preSendShouldReturn = true;
        return;
      }
      throw error;
    }
      })();
      if (preSendShouldReturn) {
        return;
      }
    } catch (error) {
      if (error?.errorCode === "pre_send_timeout") {
        if (preSendClaimExpired(job)) {
          throw preSendExpiredError();
        }
        if (refreshBeforeSending(job, { force: true, maxAttempts: 2 })) {
          return;
        }
      }
      throw error;
    }
  }

  let replyText = "";
  try {
    if (!(await syncJobStillActive(job))) {
      return;
    }
    const promptFallback = submittedPromptInfo?.fallback === "composer_cleared";
    replyText = await waitForAssistantReply(previous, {
      job,
      afterUserTurnIndex: Number.isInteger(submittedPromptInfo?.index) ? submittedPromptInfo.index : undefined,
      afterUserText: promptFallback ? "" : job.payloadText,
      afterUserTexts: promptFallback ? [] : promptCandidates,
      expectedImageCount: requestedImageCount(job),
      inputArtifactCount: job.inputArtifacts?.length || 0,
      excludeImageKeys: job.artifactBaselineImageKeys || []
    });
  } catch (error) {
    if (error?.bridgeJobStopped) {
      return;
    }
    if (
      /Timed out waiting for (?:ChatGPT|GPT) reply|\u7b49\u5f85\s*GPT\s*\u56de\u590d\u8d85\u65f6/i.test(error.message || "") &&
      refreshBeforeSending(job, {
        force: true,
        jobPatch: {
          sentAt: job.sentAt || new Date().toISOString(),
          previousAssistantText: job.previousAssistantText || previous,
          _bridgeResendIfPromptMissing: false
        }
      })
    ) {
      return;
    }
    throw error;
  }
  if (!(await syncJobStillActive(job))) {
    return;
  }
  const assistantMessage =
    lastAssistantMessage({
      afterUserTurnIndex: Number.isInteger(submittedPromptInfo?.index) ? submittedPromptInfo.index : undefined,
      afterUserTexts: submittedPromptInfo?.fallback === "composer_cleared" ? [] : promptCandidates,
      afterUserText: submittedPromptInfo?.fallback === "composer_cleared" ? "" : job.payloadText,
      requireAfterUserText: submittedPromptInfo?.fallback === "composer_cleared" ? false : Boolean(job.payloadText)
    }) || lastAssistantMessage();
  const downloaded = shouldSkipArtifactCapture(job, replyText)
    ? { artifacts: [], artifactIds: [], errors: [] }
    : await collectDownloadArtifacts(assistantDownloadScope(assistantMessage), {
        syncJobId: job.id,
        preferImages: expectsImageArtifact(job),
        expectedImageCount: requestedImageCount(job),
        excludeImageKeys: job.artifactBaselineImageKeys || [],
        requestedFilename: requestedImageFilename(job),
        requestedFilenames: requestedImageFilenames(job)
      });

  if (!(await syncJobStillActive(job))) {
    return;
  }
  const completion = await bridgeApi(`/api/sync/jobs/${job.id}/complete`, {
    method: "POST",
    body: JSON.stringify(syncJobMutationBody({
      replyText,
      artifacts: downloaded.artifacts,
      artifactIds: downloaded.artifactIds,
      artifactErrors: downloaded.errors,
      thoughtDurationMs: assistantThoughtDurationMs(assistantMessage)
    }))
  });
  recordCompletionCaptureStatus(job, completion, {
    replyLength: replyText.length,
    artifactCount: downloaded.artifacts.length + downloaded.artifactIds.length
  });
}

async function captureExistingReply(job) {
  if (!job?.id || !job.sentAt) {
    updateCaptureStatus(job, "invalid_job");
    return false;
  }
  if (isGenerating()) {
    updateCaptureStatus(job, "page_generating");
    return false;
  }
  if (!(await syncJobStillActive(job))) {
    if (lastCaptureStatus?.jobId === job.id && lastCaptureStatus.state === "captured") {
      return true;
    }
    updateCaptureStatus(job, "job_inactive");
    return false;
  }

  const promptCandidates = promptCandidatesForJob(job);
  const promptInfo = latestUserPromptTurnInfo(promptCandidates);
  const assistantMessage = lastAssistantMessage({
    afterUserTexts: promptCandidates,
    afterUserText: job.payloadText,
    requireAfterUserText: true
  });
  if (!promptInfo) {
    updateCaptureStatus(job, "prompt_not_found", {
      promptCandidateCount: promptCandidates.length
    });
    return false;
  }
  if (!assistantMessage) {
    updateCaptureStatus(job, "assistant_not_found", {
      promptTurnIndex: promptInfo.index
    });
    return false;
  }
  const usable = hasUsableAssistantContent(
    assistantMessage,
    job.previousAssistantText || "",
    { allowRepeatedText: true }
  );
  if (!usable) {
    updateCaptureStatus(job, "assistant_not_usable", {
      promptTurnIndex: promptInfo.index
    });
    return false;
  }

  const imageArtifactReady =
    expectsImageArtifact(job) &&
    imageCandidates(assistantDownloadScope(assistantMessage), {
      expectedImageCount: requestedImageCount(job),
      includePageGallery: true,
      excludeImageKeys: job.artifactBaselineImageKeys || []
    }).length > 0;
  const downloadableArtifactReady =
    hasOutputArtifactRequestSignal(job) &&
    hasDownloadableArtifact(assistantMessage);
  let replyText = visibleReplyTextFromAssistant(
    assistantMessage,
    job.previousAssistantText || "",
    { allowRepeatedText: true }
  );
  if (
    imageArtifactReady &&
    (!replyText || isInterimAssistantText(replyText) || imageReplyStillProcessingText(replyText))
  ) {
    replyText = "\u5df2\u751f\u6210\u56fe\u7247\u3002";
  }
  if (
    !replyText ||
    isInterimAssistantText(replyText) ||
    (
      looksLikePossiblyStreamingReply(replyText) &&
      !imageArtifactReady &&
      !downloadableArtifactReady
    )
  ) {
    updateCaptureStatus(job, "reply_not_final", {
      replyLength: replyText?.length || 0,
      interim: isInterimAssistantText(replyText),
      possiblyStreaming: looksLikePossiblyStreamingReply(replyText),
      imageArtifactReady,
      downloadableArtifactReady
    });
    return false;
  }

  const downloaded = shouldSkipArtifactCapture(job, replyText)
    ? { artifacts: [], artifactIds: [], errors: [] }
    : await collectDownloadArtifacts(assistantDownloadScope(assistantMessage), {
        syncJobId: job.id,
        preferImages: expectsImageArtifact(job),
        expectedImageCount: requestedImageCount(job),
        includePageGallery: expectsImageArtifact(job),
        excludeImageKeys: job.artifactBaselineImageKeys || [],
        requestedFilename: requestedImageFilename(job),
        requestedFilenames: requestedImageFilenames(job)
      });
  if (!(await syncJobStillActive(job))) {
    if (lastCaptureStatus?.jobId === job.id && lastCaptureStatus.state === "captured") {
      return true;
    }
    updateCaptureStatus(job, "job_ended_during_capture");
    return false;
  }

  try {
    const completion = await bridgeApi(`/api/sync/jobs/${job.id}/complete`, {
      method: "POST",
      body: JSON.stringify(syncJobMutationBody({
        replyText,
        artifacts: downloaded.artifacts,
        artifactIds: downloaded.artifactIds,
        artifactErrors: downloaded.errors,
        thoughtDurationMs: assistantThoughtDurationMs(assistantMessage)
      }))
    });
    return recordCompletionCaptureStatus(job, completion, {
      replyLength: replyText.length,
      artifactCount: downloaded.artifacts.length + downloaded.artifactIds.length
    });
  } catch (error) {
    updateCaptureStatus(job, "completion_rejected", {
      errorCode: error?.errorCode || null,
      error: error?.message || String(error || "")
    });
    if (isRetryableCompletionApiError(error)) {
      return false;
    }
    throw error;
  }
}

async function runPollCycle() {
  if (!location.hostname.endsWith("chatgpt.com")) {
    return;
  }

  let heartbeat = null;
  try {
    heartbeat = await sendHeartbeat({ lightweight: busy });
  } catch {
    // The bridge may be stopped; keep polling quietly.
  }

  if (maybeReloadExtensionFromHeartbeat(heartbeat)) {
    return;
  }
  await maybeOpenProjectTabFromHeartbeat(heartbeat);

  let preSendRefreshJob = takePreSendRefreshJob();
  const controlsCurrentPage = heartbeatMatchesCurrentPage(heartbeat);
  if (busy) {
    if (preSendRefreshJob) {
      storePreSendRefreshJob(preSendRefreshJob);
    } else if (controlsCurrentPage) {
      await handleHeartbeatRecovery(heartbeat?.recovery);
    }
    return;
  }

  if (preSendRefreshJob) {
    const resolved = await resolvePreSendRefreshJob(preSendRefreshJob);
    if (resolved.retryLater) {
      return;
    }
    preSendRefreshJob = resolved.job;
  }

  if (!preSendRefreshJob && controlsCurrentPage && await handleHeartbeatRecovery(heartbeat?.recovery)) {
    return;
  }

  if (!preSendRefreshJob && controlsCurrentPage && isGenerating()) {
    return;
  }

  if (!preSendRefreshJob && controlsCurrentPage && heartbeat?.preferences) {
    try {
      if (await applyHeartbeatPreferences(heartbeat.preferences)) {
        return;
      }
    } catch (error) {
      console.warn("Bridge preference heartbeat skipped:", error);
    }
  }

  busy = true;
  try {
    if (preSendRefreshJob) {
      await processJobAndReportFailure(preSendRefreshJob, { afterPreSendRefresh: true });
      return;
    }

    if (!controlsCurrentPage) {
      return;
    }

    const claimed = await bridgeApi("/api/sync/jobs/claim", {
      method: "POST",
      body: JSON.stringify({
        projectUrl: location.href,
        workerId: currentWorkerId()
      })
    });

    if (claimed.job) {
      await processJobAndReportFailure(claimed.job, { resume: claimed.resume });
    }
  } catch {
    // The bridge may be stopped; keep polling quietly.
  } finally {
    busy = false;
  }
}

async function poll() {
  if (busy) {
    if (busyHeartbeatInFlight) {
      return;
    }
    busyHeartbeatInFlight = true;
    try {
      await runPollCycle();
    } finally {
      busyHeartbeatInFlight = false;
    }
    return;
  }
  if (pollInFlight) {
    return;
  }
  pollInFlight = true;
  try {
    await runPollCycle();
  } finally {
    pollInFlight = false;
  }
}

async function processJobAndReportFailure(job, options = {}) {
  try {
    await processJob(job, options);
    return true;
  } catch (error) {
    if (isRetryableCompletionApiError(error)) {
      return false;
    }
    await bridgeApi(`/api/sync/jobs/${job.id}/fail`, {
      method: "POST",
      body: JSON.stringify(syncJobMutationBody(bridgeFailurePayload(error)))
    });
    return false;
  }
}

setInterval(poll, POLL_MS);
installAssistantActivityObserver();
poll();
