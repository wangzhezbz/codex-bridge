const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function createDesktopLocalCapabilityExecutor(deps = {}) {
  return async function executeDesktopLocalCapability(payload = {}) {
    return executeDesktopLocalCapabilityWithDeps(payload, deps);
  };
}

async function executeDesktopLocalCapabilityWithDeps(payload = {}, deps = {}) {
  const adapter = normalizeText(payload.adapter);
  const capability = normalizeText(payload.capability);
  if (adapter === "local_browser" || capability === "browser") {
    return executeDesktopLocalBrowserCapability(payload, deps);
  }
  if (adapter === "local_computer_use" || capability === "computer_use") {
    return executeDesktopLocalComputerUseCapability(payload, deps);
  }
  if (adapter === "local_file" || capability === "file_processing") {
    return executeDesktopLocalFileCapability(payload, deps);
  }
  throwLocalError("local_executor_not_configured", "这个本地能力还没有桌面执行器。");
}

async function executeDesktopLocalFileCapability(payload = {}, _deps = {}) {
  const provider = plainObject(payload.provider);
  const request = plainObject(payload.request);
  const input = localCapabilityInput(request);
  const action = normalizeText(input.action || input.type || "extract_text");

  if (isDiagnoseFileAction(action)) {
    return {
      text: "本地文件处理执行器已接入：inspect_file、extract_text。只会读取请求里明确提供的本地文本文件路径。",
      action: "diagnose",
      providerId: provider.id || "",
      handledBy: "desktop_local_file",
      supportedActions: ["diagnose", "inspect_file", "extract_text"],
      canReadLocalTextFiles: true,
    };
  }

  if (!isInspectFileAction(action) && !isExtractFileTextAction(action)) {
    throwLocalError(
      "local_action_unsupported",
      "本地文件处理目前只支持 inspect_file 和 extract_text，并且需要请求输入里明确提供本地文本文件路径。",
    );
  }

  const filePath = localFilePathFromInput(input);
  if (!filePath) {
    throwLocalError("local_file_missing_path", "本地文件处理需要提供 path、filePath 或 localPath。");
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throwLocalError("local_file_not_found", `本地文件不存在或不可访问：${filePath}`);
  }
  if (!stat.isFile()) {
    throwLocalError("local_file_not_file", `本地文件处理只能读取明确的文件路径：${filePath}`);
  }

  const maxBytes = positiveInteger(input.maxBytes || input.max_bytes, 1024 * 1024);
  if (stat.size > maxBytes) {
    throwLocalError("local_file_too_large", `本地文件过大：${stat.size} bytes，当前上限 ${maxBytes} bytes。`);
  }

  const buffer = fs.readFileSync(filePath);
  if (looksBinary(buffer)) {
    throwLocalError("local_file_binary_unsupported", "本地文件处理目前只支持文本文件，暂不读取明显的二进制文件。");
  }

  const content = buffer.toString("utf8").replace(/\u0000/g, "");
  const excerptLimit = positiveInteger(input.maxCharacters || input.max_chars || input.limit, 6000);
  const excerpt = content.slice(0, excerptLimit);
  const truncated = content.length > excerpt.length;
  const fileName = path.basename(filePath);
  if (isInspectFileAction(action)) {
    const previewLimit = positiveInteger(input.maxCharacters || input.max_chars || input.limit, 2000);
    const preview = content.slice(0, previewLimit);
    const previewTruncated = content.length > preview.length;
    const mimeType = localTextMimeType(filePath);
    const extension = path.extname(filePath).toLowerCase();
    return {
      text: [
        `文件检查：${fileName}`,
        filePath,
        `类型：${mimeType}`,
        `大小：${stat.size} bytes`,
        `行数：${countTextLines(content)}`,
        "",
        preview,
        previewTruncated ? "\n（预览较长，已截取前半部分。）" : "",
      ].join("\n").trim(),
      action: "inspect_file",
      filePath,
      fileName,
      extension,
      mimeType,
      encoding: "utf8",
      sizeBytes: stat.size,
      lineCount: countTextLines(content),
      preview,
      truncated: previewTruncated,
      providerId: provider.id || "",
      handledBy: "desktop_local_file",
    };
  }
  return {
    text: `已读取本地文件：${fileName}\n${filePath}\n\n${excerpt}${truncated ? "\n\n（内容较长，已截取前半部分。）" : ""}`,
    action: "extract_text",
    filePath,
    fileName,
    mimeType: localTextMimeType(filePath),
    sizeBytes: stat.size,
    excerpt,
    truncated,
    providerId: provider.id || "",
    handledBy: "desktop_local_file",
  };
}

async function executeDesktopLocalComputerUseCapability(payload = {}, deps = {}) {
  const provider = plainObject(payload.provider);
  const request = plainObject(payload.request);
  const input = localCapabilityInput(request);
  const action = normalizeText(input.action || input.type || "diagnose");

  if (isDiagnoseComputerUseAction(action)) {
    const canScreenshot = typeof deps.captureDesktopScreenshot === "function";
    return {
      text: canScreenshot
        ? "本地 Computer Use 安全能力已接入：list_apps、open_app、screenshot_desktop。不会执行鼠标、键盘或任意命令；需要完整原生 Computer Use 时，请使用 GPT / OpenAI Responses 路由。"
        : "本地 Computer Use 当前是安全诊断入口：已识别配置，但没有开放鼠标、键盘或桌面截图执行。需要原生 Computer Use 时，请使用 GPT / OpenAI Responses 路由。",
      action: "diagnose",
      providerId: provider.id || "",
      handledBy: "desktop_local_computer_use",
      supportedActions: canScreenshot
        ? ["diagnose", "list_apps", "open_app", "screenshot_desktop"]
        : ["diagnose", "list_apps", "open_app"],
      canControlDesktop: false,
      canScreenshot,
      allowedApps: publicComputerUseAllowedApps(deps.platform || process.platform),
      requiresGptResponses: true,
    };
  }

  if (isListComputerUseAppsAction(action)) {
    return listComputerUseAllowedApps({ provider, deps });
  }

  if (isOpenComputerUseAppAction(action)) {
    return launchComputerUseApp({ input, provider, deps });
  }

  if (isScreenshotComputerUseAction(action)) {
    return captureComputerUseDesktopScreenshot({ input, provider, deps });
  }

  throwLocalError(
    "local_action_unsupported",
    "本地 Computer Use 目前只开放安全诊断、白名单启动应用和受控桌面截图，不会自动执行鼠标或键盘动作。请切回 GPT / OpenAI Responses 路由使用原生 Computer Use。",
  );
}

function listComputerUseAllowedApps({ provider = {}, deps = {} } = {}) {
  const allowedApps = publicComputerUseAllowedApps(deps.platform || process.platform);
  return {
    text: allowedApps.length
      ? `本地 Computer Use 只允许打开这些应用：${allowedApps.map((app) => app.id).join("、")}。不会执行鼠标、键盘、路径、脚本或任意命令。`
      : "当前平台没有可打开的本地 Computer Use 白名单应用。",
    action: "list_apps",
    providerId: provider.id || "",
    handledBy: "desktop_local_computer_use",
    supportedActions: ["diagnose", "list_apps", "open_app", "screenshot_desktop"],
    canControlDesktop: false,
    allowedApps,
  };
}

async function captureComputerUseDesktopScreenshot({ input = {}, provider = {}, deps = {} } = {}) {
  const captureDesktopScreenshot = typeof deps.captureDesktopScreenshot === "function"
    ? deps.captureDesktopScreenshot
    : null;
  if (!captureDesktopScreenshot) {
    throwLocalError("local_executor_not_configured", "本地桌面截图能力还没有接入桌面执行器。");
  }

  let bytes;
  try {
    bytes = await captureDesktopScreenshot({
      displayId: String(input.displayId || input.display_id || "").trim(),
    });
  } catch (error) {
    throwLocalError("local_desktop_screenshot_failed", `桌面截图失败：${error?.message || "截图执行失败"}`);
  }
  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : bytes instanceof Uint8Array
      ? Buffer.from(bytes)
      : typeof bytes === "string"
        ? Buffer.from(bytes, "base64")
        : null;
  if (!buffer?.length) {
    throwLocalError("local_desktop_screenshot_failed", "桌面截图失败：桌面执行器没有返回图片内容。");
  }
  return {
    text: "桌面截图已生成。这不是完整 Computer Use，不会自动点击、输入或操作窗口。",
    action: "screenshot_desktop",
    mimeType: "image/png",
    screenshotBase64: buffer.toString("base64"),
    providerId: provider.id || "",
    handledBy: "desktop_local_computer_use",
    canControlDesktop: false,
    canScreenshot: true,
  };
}

async function launchComputerUseApp({ input = {}, provider = {}, deps = {} } = {}) {
  const app = computerUseAllowedApp(input, deps.platform || process.platform);
  if (!app) {
    throwLocalError(
      "local_action_unsupported",
      "本地 Computer Use 只允许启动白名单应用：记事本、计算器、画图。不会执行任意命令、路径或脚本。",
    );
  }
  const launchApp = typeof deps.launchApp === "function" ? deps.launchApp : defaultLaunchApp;
  try {
    await launchApp(app.command, app.args || [], { appId: app.id, label: app.label });
  } catch (error) {
    throwLocalError("local_app_launch_failed", `白名单应用启动失败：${error?.message || app.label}`);
  }
  return {
    text: `已请求打开白名单应用：${app.label}。这不是完整 Computer Use，只是受控启动本地应用；不会自动点击、输入或截图。`,
    action: "open_app",
    appId: app.id,
    appLabel: app.label,
    command: app.command,
    args: app.args || [],
    providerId: provider.id || "",
    handledBy: "desktop_local_computer_use",
    canControlDesktop: false,
    canScreenshot: false,
  };
}

async function executeDesktopLocalBrowserCapability(payload = {}, deps = {}) {
  const provider = plainObject(payload.provider);
  const request = plainObject(payload.request);
  const input = localCapabilityInput(request);
  const action = normalizeBrowserAction(input.action || input.type);

  if (isDiagnoseBrowserAction(action)) {
    return diagnoseBrowserCapability({ provider, deps });
  }

  const url = localBrowserUrlFromInput(input);

  if (!url) {
    throwLocalError(
      "local_action_unsupported",
      "本地浏览器能力只允许访问 http/https URL，不能读取本地文件或其他协议。",
    );
  }

  if (isOpenBrowserAction(action)) {
    const openExternal = typeof deps.openExternal === "function"
      ? deps.openExternal
      : deps.shell && typeof deps.shell.openExternal === "function"
        ? deps.shell.openExternal.bind(deps.shell)
        : null;
    if (!openExternal) {
      throwLocalError("local_executor_not_configured", "本地浏览器打开能力还没有接入桌面执行器。");
    }
    await openExternal(url);
    return {
      text: `已请求系统浏览器打开：${url}`,
      action: "open_url",
      url,
      providerId: provider.id || "",
      handledBy: "desktop_local_browser",
    };
  }

  if (isReadBrowserAction(action)) {
    return readBrowserUrl({
      url,
      provider,
      input,
      fetchImpl: deps.fetchImpl || globalThis.fetch,
    });
  }

  if (isScreenshotBrowserAction(action)) {
    return captureBrowserScreenshot({
      url,
      provider,
      input,
      capturePageScreenshot: deps.capturePageScreenshot,
    });
  }

  throwLocalError(
    "local_action_unsupported",
    "本地浏览器能力目前支持 open_url、read_url 和 screenshot_url，并且输入 JSON 里必须提供 http/https 的 url。",
  );
}

async function readBrowserUrl({ url = "", provider = {}, input = {}, fetchImpl = null } = {}) {
  if (typeof fetchImpl !== "function") {
    throwLocalError("local_executor_not_configured", "本地浏览器读取能力还没有可用的网络执行器。");
  }
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "text/html,text/plain,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "user-agent": "CodexBridge Local Browser Reader",
      },
    });
  } catch (error) {
    throwLocalError("local_browser_fetch_failed", `网页读取失败：${error?.message || "网络请求失败"}`);
  }

  const status = Number(response?.status || 0);
  if (!response || response.ok === false) {
    throwLocalError("local_browser_fetch_failed", `网页读取失败：HTTP ${status || "unknown"}`);
  }

  const contentType = responseHeader(response, "content-type");
  const maxBytes = positiveInteger(input.maxBytes || input.max_bytes || input.maxBodyBytes || input.max_body_bytes, 2 * 1024 * 1024);
  const contentLength = Number.parseInt(responseHeader(response, "content-length"), 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throwLocalError(
      "local_browser_response_too_large",
      `网页内容过大：${contentLength} bytes，当前上限 ${maxBytes} bytes。请调小页面范围或提高 maxBytes。`,
    );
  }
  const body = typeof response.text === "function" ? await response.text() : "";
  const bodyBytes = Buffer.byteLength(String(body || ""), "utf8");
  if (bodyBytes > maxBytes) {
    throwLocalError(
      "local_browser_response_too_large",
      `网页内容过大：${bodyBytes} bytes，当前上限 ${maxBytes} bytes。请调小页面范围或提高 maxBytes。`,
    );
  }
  const title = contentType.includes("html") ? extractHtmlTitle(body) : "";
  const excerptLimit = positiveInteger(input.maxCharacters || input.max_chars || input.limit, 6000);
  const fullText = contentType.includes("html") ? htmlToReadableText(body) : collapseWhitespace(String(body || ""));
  const excerpt = fullText.slice(0, excerptLimit);
  const truncated = fullText.length > excerpt.length;
  const heading = title ? `已读取网页：${title}` : `已读取网页：${url}`;
  const text = `${heading}\n${url}\n\n${excerpt}${truncated ? "\n\n（内容较长，已截取前半部分。）" : ""}`;

  return {
    text,
    action: "read_url",
    url,
    title,
    status,
    contentType,
    excerpt,
    truncated,
    providerId: provider.id || "",
    handledBy: "desktop_local_browser",
  };
}

async function captureBrowserScreenshot({
  url = "",
  provider = {},
  input = {},
  capturePageScreenshot = null,
} = {}) {
  if (typeof capturePageScreenshot !== "function") {
    throwLocalError("local_executor_not_configured", "本地网页截图能力还没有接入桌面执行器。");
  }
  let bytes;
  try {
    bytes = await capturePageScreenshot({
      url,
      viewport: normalizeViewport(input.viewport),
      fullPage: Boolean(input.fullPage || input.full_page),
    });
  } catch (error) {
    throwLocalError("local_browser_screenshot_failed", `网页截图失败：${error?.message || "截图执行失败"}`);
  }
  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : bytes instanceof Uint8Array
      ? Buffer.from(bytes)
      : typeof bytes === "string"
        ? Buffer.from(bytes, "base64")
        : null;
  if (!buffer?.length) {
    throwLocalError("local_browser_screenshot_failed", "网页截图失败：桌面执行器没有返回图片内容。");
  }
  return {
    text: `网页截图已生成：${url}`,
    action: "screenshot_url",
    url,
    viewport: normalizeViewport(input.viewport),
    fullPage: Boolean(input.fullPage || input.full_page),
    mimeType: "image/png",
    screenshotBase64: buffer.toString("base64"),
    providerId: provider.id || "",
    handledBy: "desktop_local_browser",
  };
}

function localCapabilityInput(request = {}) {
  const input = request?.input;
  if (typeof input === "string") {
    return { url: input };
  }
  return input && typeof input === "object" && !Array.isArray(input) ? input : {};
}

function localBrowserUrlFromInput(input = {}) {
  const raw = String(input.url || input.href || input.link || "").trim();
  return normalizeLocalHttpUrl(raw);
}

function normalizeLocalHttpUrl(raw = "") {
  const value = String(raw || "").trim();
  if (!value || /[\u0000-\u001f\s]/.test(value) || value.includes("\\") || value.includes("@")) {
    return "";
  }
  const parsedDirect = parseAllowedLocalHttpUrl(value);
  if (parsedDirect) {
    return parsedDirect;
  }
  if (!looksLikeBareLocalHttpUrl(value)) {
    return "";
  }
  return parseAllowedLocalHttpUrl(`https://${value}`);
}

function parseAllowedLocalHttpUrl(value = "") {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function looksLikeBareLocalHttpUrl(value = "") {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("/") || value.startsWith("//")) {
    return false;
  }
  const host = String(value).split(/[/?#]/, 1)[0];
  if (!host || host.includes("..")) {
    return false;
  }
  const hostname = host.split(":", 1)[0];
  if (hostname === "localhost" || isLocalIpv4(hostname)) {
    return true;
  }
  return hostname.includes(".") && hostname
    .split(".")
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function isLocalIpv4(value = "") {
  const parts = String(value).split(".");
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }
    const numeric = Number(part);
    return numeric >= 0 && numeric <= 255;
  });
}

function normalizeBrowserAction(value = "") {
  const action = normalizeText(value || "open_url");
  if (!action) {
    return "open_url";
  }
  return action;
}

function diagnoseBrowserCapability({ provider = {}, deps = {} } = {}) {
  const openExternal = typeof deps.openExternal === "function"
    ? deps.openExternal
    : deps.shell && typeof deps.shell.openExternal === "function"
      ? deps.shell.openExternal.bind(deps.shell)
      : null;
  const canReadUrl = typeof (deps.fetchImpl || globalThis.fetch) === "function";
  const canScreenshotUrl = typeof deps.capturePageScreenshot === "function";
  const supportedActions = [];
  if (openExternal) {
    supportedActions.push("open_url");
  }
  if (canReadUrl) {
    supportedActions.push("read_url");
  }
  if (canScreenshotUrl) {
    supportedActions.push("screenshot_url");
  }
  return {
    text: canScreenshotUrl
      ? "本地浏览器执行器已接入：open_url、read_url、screenshot_url。"
      : `本地浏览器执行器已接入：${supportedActions.join("、") || "暂无可执行动作"}；网页截图需要桌面截图执行器。`,
    action: "diagnose",
    providerId: provider.id || "",
    handledBy: "desktop_local_browser",
    supportedActions,
    canOpenUrl: Boolean(openExternal),
    canReadUrl,
    canScreenshotUrl,
  };
}

function isDiagnoseBrowserAction(action = "") {
  return ["diagnose", "health", "health_check", "test"].includes(normalizeText(action));
}

function isDiagnoseComputerUseAction(action = "") {
  return ["diagnose", "health", "health_check", "test", "status"].includes(normalizeText(action));
}

function isListComputerUseAppsAction(action = "") {
  return ["list_apps", "list_app", "allowed_apps", "apps", "capabilities"].includes(normalizeText(action));
}

function isDiagnoseFileAction(action = "") {
  return ["diagnose", "health", "health_check", "test", "status"].includes(normalizeText(action));
}

function isInspectFileAction(action = "") {
  return ["inspect_file", "inspect", "preview_file", "file_info", "stat_file"].includes(normalizeText(action));
}

function isExtractFileTextAction(action = "") {
  return ["extract_text", "read_file", "read_text", "text", "read"].includes(normalizeText(action));
}

function isOpenComputerUseAppAction(action = "") {
  return ["open_app", "launch_app", "start_app", "open_application"].includes(normalizeText(action));
}

function isScreenshotComputerUseAction(action = "") {
  return ["screenshot_desktop", "desktop_screenshot", "screenshot", "capture_desktop", "screen_capture"].includes(
    normalizeText(action),
  );
}

function isOpenBrowserAction(action = "") {
  return ["open_url", "open", "navigate"].includes(normalizeText(action));
}

function isReadBrowserAction(action = "") {
  return ["read_url", "read", "fetch_url", "extract_text"].includes(normalizeText(action));
}

function isScreenshotBrowserAction(action = "") {
  return ["screenshot_url", "screenshot", "capture_url", "capture_page"].includes(normalizeText(action));
}

function normalizeViewport(value = "") {
  const normalized = normalizeText(value);
  return ["mobile", "desktop"].includes(normalized) ? normalized : "desktop";
}

function localFilePathFromInput(input = {}) {
  const raw = String(
    input.path || input.filePath || input.file_path || input.localPath || input.local_path || "",
  ).trim();
  if (!raw) {
    return "";
  }
  return path.resolve(raw);
}

function localTextMimeType(filePath = "") {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".json") {
    return "application/json";
  }
  if (ext === ".csv") {
    return "text/csv";
  }
  if (ext === ".htm" || ext === ".html") {
    return "text/html";
  }
  if (ext === ".md" || ext === ".markdown") {
    return "text/markdown";
  }
  if (ext === ".xml") {
    return "application/xml";
  }
  return "text/plain";
}

function countTextLines(text = "") {
  if (!text) {
    return 0;
  }
  return text.split(/\r\n|\n|\r/).length;
}

function looksBinary(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    return false;
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }
  }
  return false;
}

function computerUseAllowedApp(input = {}, platform = process.platform) {
  const requested = normalizeComputerUseAppId(input.app || input.application || input.name || input.target);
  if (!requested) {
    return null;
  }
  return computerUseAllowedApps(platform).find((app) =>
    app.aliases.some((alias) => normalizeComputerUseAppId(alias) === requested),
  ) || null;
}

function computerUseAllowedApps(platform = process.platform) {
  if (platform === "darwin") {
    return [
      { id: "textedit", label: "TextEdit", command: "open", args: ["-a", "TextEdit"], aliases: ["textedit", "文本编辑"] },
      { id: "calculator", label: "Calculator", command: "open", args: ["-a", "Calculator"], aliases: ["calculator", "calc", "计算器"] },
    ];
  }
  if (platform === "win32") {
    return [
      { id: "notepad", label: "记事本", command: "notepad.exe", args: [], aliases: ["notepad", "记事本", "notes"] },
      { id: "calculator", label: "计算器", command: "calc.exe", args: [], aliases: ["calculator", "calc", "计算器"] },
      { id: "paint", label: "画图", command: "mspaint.exe", args: [], aliases: ["paint", "mspaint", "画图"] },
    ];
  }
  return [];
}

function publicComputerUseAllowedApps(platform = process.platform) {
  return computerUseAllowedApps(platform).map((app) => ({
    id: app.id,
    label: app.label,
    aliases: [...(app.aliases || [])],
  }));
}

function normalizeComputerUseAppId(value = "") {
  return normalizeText(value).replace(/[\s_-]+/g, "");
}

function defaultLaunchApp(command = "", args = []) {
  return new Promise((resolve, reject) => {
    if (!command) {
      reject(new Error("missing command"));
      return;
    }
    const child = spawn(command, Array.isArray(args) ? args : [], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function extractHtmlTitle(html = "") {
  const match = String(html || "").match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? collapseWhitespace(decodeHtmlEntities(match[1])) : "";
}

function htmlToReadableText(html = "") {
  return collapseWhitespace(
    decodeHtmlEntities(
      String(html || "")
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<\/(p|div|section|article|main|header|footer|li|h[1-6]|tr|br)\s*>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    ),
  );
}

function decodeHtmlEntities(value = "") {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : " ";
    })
    .replace(/&#(\d+);/g, (_match, digits) => {
      const code = Number.parseInt(digits, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : " ";
    });
}

function responseHeader(response = {}, name = "") {
  const headers = response.headers;
  if (!headers) {
    return "";
  }
  if (typeof headers.get === "function") {
    return String(headers.get(name) || "").toLowerCase();
  }
  return String(headers[name] || headers[name.toLowerCase()] || "").toLowerCase();
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeText(value = "") {
  return String(value || "").trim().toLowerCase();
}

function collapseWhitespace(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function throwLocalError(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

module.exports = {
  createDesktopLocalCapabilityExecutor,
  executeDesktopLocalCapability: executeDesktopLocalCapabilityWithDeps,
  executeDesktopLocalBrowserCapability,
  executeDesktopLocalComputerUseCapability,
  executeDesktopLocalFileCapability,
};
