import { createServer } from "node:http";
import { copyFile, readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  createChatTurn,
  appendChatMessage,
  getWorkspaceBinding,
  importChatGptReply,
  listChatMessages,
  updateWorkspaceBinding
} from "./conversation-store.js";
import {
  bindCurrentSessionProject,
  createProject,
  deleteProject,
  ensureProjectForWorkspace,
  listProjects,
  selectProject,
  updateProject
} from "./project-store.js";
import {
  claimNextSyncJob,
  completeSyncJob,
  createSyncJob,
  failSyncJob,
  getSyncJob,
  listSyncJobs,
  markSyncJobPreSendRefresh,
  markSyncJobRecoveryIssued,
  markSyncJobSent
} from "./sync-store.js";
import {
  getArtifact,
  listArtifacts,
  readArtifactText,
  saveArtifactFromBase64,
  saveArtifactFromLocalFile,
  saveArtifactToProject
} from "./artifact-store.js";
import { buildArtifactPreview } from "./artifact-preview.js";
import {
  claimNextInboxItem,
  completeInboxItem,
  createInboxItem,
  failInboxItem,
  getInboxItem,
  listInboxItems
} from "./codex-inbox-store.js";
import {
  createTask,
  getTask,
  listTasks,
  readTaskEvents,
  readTaskResult
} from "./task-store.js";
import { runTask } from "./codex-runner.js";
import {
  appendRoomMessage,
  claimNextCodexTask,
  clearRoomMessages,
  createCodexTask,
  failCodexTask,
  hideRoomMessage,
  listRoomMessages
} from "./room-store.js";
import { completeRoomCodexTaskWithMessage } from "./room-codex-completion.js";
import { relayCodexTaskToThread } from "./codex-app-relay.js";
import { buildAcceptanceReport, buildAcceptanceStatus } from "./acceptance-status.js";
import {
  buildGptFileAnalysisCacheKey,
  findReusableGptFileAnalysis,
  waitForSyncJobResult
} from "./gpt-file-analysis.js";
import { createBridgeTools } from "./bridge-tools.js";
import {
  getExtensionHeartbeat,
  listExtensionHeartbeats,
  saveExtensionHeartbeat
} from "./extension-heartbeat-store.js";
import { decideRoomRoute } from "./room-routing-policy.js";
import { normalizeChatGptPreferences } from "./preference-compat.js";
import { assertTextIntegrity } from "./text-integrity.js";
import { renderRealBrowserAcceptanceRecord } from "./user-package.js";
import { resolveBridgeDataDir, resolveBridgeExtensionDir } from "./runtime-config.js";
import {
  EXTENSION_PROTOCOL_VERSION,
  healthPayload,
  versionPayload
} from "./service-metadata.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const DEFAULT_CHROME_EXTENSION_DIR = path.resolve(PACKAGE_ROOT, "chrome-extension");
const execFileAsync = promisify(execFile);

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"]
]);
const PENDING_EXTENSION_STALE_MS = 20000;
const UNSENT_RUNNING_SYNC_STALE_MS = 60 * 1000;
const READY_PAGE_SENT_SYNC_STALE_MS = 90 * 1000;
const RUNNING_SYNC_STALE_MS = 6 * 60 * 1000;
const READY_PAGE_IMAGE_SENT_SYNC_STALE_MS = RUNNING_SYNC_STALE_MS;
const MANUAL_CANCEL_STOP_RECOVERY_MS = 10 * 60 * 1000;
const ORPHAN_GENERATION_STOP_RECOVERY_MS = 30 * 60 * 1000;
const EXPECTED_EXTENSION_VERSION = EXTENSION_PROTOCOL_VERSION;
const COMPATIBLE_EXTENSION_VERSIONS = new Set([
  EXPECTED_EXTENSION_VERSION
]);

function normalizedChatgptPageUrl(value = "") {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function chatgptUrlsMatch(expected = "", actual = "") {
  const expectedUrl = normalizedChatgptPageUrl(expected);
  const actualUrl = normalizedChatgptPageUrl(actual);
  if (!expectedUrl || !actualUrl) {
    return false;
  }
  return actualUrl === expectedUrl || actualUrl.startsWith(`${expectedUrl}/`) || expectedUrl.startsWith(`${actualUrl}/`);
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS"
  });
  response.end(JSON.stringify(value, null, 2));
}

function sendText(response, status, text, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS"
  });
  response.end(text);
}

function sendBinary(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    ...headers
  });
  response.end(body);
}

function asciiFallbackFilename(filename = "download") {
  const sanitized = String(filename || "download")
    .replaceAll("\\", "_")
    .replaceAll("/", "_")
    .replaceAll('"', "_")
    .replace(/[^\x20-\x7E]/g, "_")
    .trim();
  return sanitized || "download";
}

function contentDisposition(disposition, filename = "download") {
  const fallback = asciiFallbackFilename(filename);
  const encoded = encodeURIComponent(String(filename || "download"));
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function saveArtifactWithNativeDialog(artifact) {
  if (process.platform !== "win32") {
    throw new Error("Native save dialog is only supported on Windows.");
  }

  const script = `
& {
  param([string]$SuggestedName)
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $dialog = New-Object System.Windows.Forms.SaveFileDialog
  $dialog.FileName = $SuggestedName
  $dialog.Filter = "All files (*.*)|*.*"
  $dialog.OverwritePrompt = $true
  $dialog.RestoreDirectory = $true
  $owner = New-Object System.Windows.Forms.Form
  $owner.TopMost = $true
  $owner.ShowInTaskbar = $false
  $owner.StartPosition = "CenterScreen"
  $owner.Size = New-Object System.Drawing.Size(1, 1)
  $owner.Opacity = 0
  $owner.Show()
  $owner.Activate()
  try {
    $result = $dialog.ShowDialog($owner)
  } finally {
    $owner.Close()
    $owner.Dispose()
  }
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Write($dialog.FileName)
  }
}
`;
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-Sta", "-ExecutionPolicy", "Bypass", "-Command", script, artifact.filename || "download"],
    {
      encoding: "utf8",
      timeout: 10 * 60 * 1000,
      windowsHide: false
    }
  );
  const selectedPath = stdout.trim();
  if (!selectedPath) {
    return {
      saved: false,
      cancelled: true
    };
  }

  await copyFile(artifact.filePath, selectedPath);
  return {
    saved: true,
    path: selectedPath,
    filename: path.basename(selectedPath)
  };
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {};
  }
  return JSON.parse(raw);
}

function stripChatGptReplyWrapper(text = "") {
  return String(text || "")
    .trim()
    .replace(/^\s*#{1,6}\s*ChatGPT\s*(?:says|\u8bf4)?\s*[:\uff1a]?\s*/i, "")
    .replace(/^\s*ChatGPT\s*(?:says|\u8bf4)?\s*[:\uff1a]?\s*/i, "")
    .trim();
}

function looksLikeInterruptedChatGptReply(text = "") {
  const cleaned = stripChatGptReplyWrapper(text);
  const concise = cleaned.replace(/\s+/g, " ").trim();
  return concise.length <= 220 &&
    /\u8fde\u63a5.{0,10}(?:\u4e2d\u65ad|\u65ad\u5f00|\u5df2\u65ad)|(?:\u7b49\u5f85|\u6b63\u5728\u7b49\u5f85).{0,16}(?:\u5b8c\u6574\u56de\u590d|\u5b8c\u6574\u7b54\u590d|\u5b8c\u6574\u54cd\u5e94)|connection.{0,20}(?:interrupted|lost|disconnected)|waiting.{0,20}(?:complete|full).{0,16}(?:reply|response)/i.test(
      concise
    );
}

function looksLikeInterimChatGptReply(text = "") {
  const cleaned = stripChatGptReplyWrapper(text);
  if (looksLikeInterruptedChatGptReply(cleaned)) {
    return true;
  }
  const concise = cleaned.replace(/\s+/g, " ").trim();
  if (
    concise.length <= 220 &&
    (
      /^(?:Pro\s*)?[\u601d\u02fc][\s\S]{0,20}$/u.test(concise) ||
      /(?:^|\s)(?:Pro\s*)?(?:\u601d\u8003\u4e2d|\u6b63\u5728(?:\u601d\u8003|\u751f\u6210|\u5904\u7406|\u521b\u5efa|\u8bfb\u53d6|\u5206\u6790|\u89e3\u6790|\u6253\u5f00|\u68c0\u7d22|\u67e5\u770b|\u68c0\u67e5))(?:\s|$|[\u3002\uff0c\uff01\uff1f,.!?])/u.test(
        concise
      )
    )
  ) {
    return true;
  }
  return concise.length <= 220 &&
    /(?:reading|analyzing|parsing|processing|thinking|generating|creating|please wait|hang tight|not return a usable reply|\u8bf7\u7a0d\u7b49)/i.test(
      concise
    );
}

function sanitizeChatGptReferenceForCodex(text = "") {
  const trimmed = stripChatGptReplyWrapper(text);
  if (!trimmed) {
    return "GPT 没有返回可用回复。";
  }

  if (looksLikeInterimChatGptReply(trimmed)) {
    return "GPT 还没有返回最终可用结果。不要把临时状态当成事实，请等待或重试获取最终回复。";
  }

  if (/(Created:|download\s+[\w.-]+|已(?:生成|创建|写入|保存)|下载\s*[\w.-]+)/i.test(trimmed)) {
    return "GPT 声称已经完成了文件操作。不要把这个说法当成事实；Bridge 必须捕获真实文件，Codex 再使用本地文件结果。";
  }

  return trimmed;
}

function sanitizeVisibleChatGptReply(text = "", job = {}) {
  const trimmed = stripChatGptReplyWrapper(text);
  if (looksLikeInterimChatGptReply(trimmed)) {
    return "GPT 还在处理这次请求，Bridge 没有拿到最终可用回复。请稍后刷新验收或重试。";
  }

  if (
    (job.kind === "user_request" || job.kind === "chat_message") &&
    /(Created:|download\s+[\w.-]+|已(?:生成|创建|写入|保存)|下载\s*[\w.-]+)/i.test(trimmed)
  ) {
    return "这看起来像文件操作声明。Bridge 会继续以真实捕获到的文件为准。";
  }

  return trimmed || "GPT 没有返回可用回复。";
}

function isPreviewOnlyReply(text = "") {
  return /^(?:\u9884\u89c8|\u9810\u89bd|preview)$/iu.test(String(text || "").trim());
}

function isGenericImageReply(text = "") {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return true;
  }
  if (isPreviewOnlyReply(normalized)) {
    return true;
  }
  return /^(?:(?:\u5df2)?\u751f\u6210(?:\u4e86)?(?:\s*(?:\d+|[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u4e24]+))?\s*\u5f20?\s*(?:\u56fe\u7247|\u56fe\u50cf)|(?:generated|created)(?:\s+(?:a|one|\d+))?\s+(?:images?|pictures?))[\u3002.!]*$/iu.test(
    normalized
  );
}

function isImageArtifactLike(artifact = {}) {
  const contentType = String(artifact.contentType || artifact.mimeType || "").toLowerCase();
  const filename = String(artifact.filename || "").toLowerCase();
  return contentType.startsWith("image/") || /\.(?:png|jpe?g|webp|gif|svg)$/.test(filename);
}

function isArchiveArtifactLike(artifact = {}) {
  const contentType = String(artifact.contentType || artifact.mimeType || "").toLowerCase();
  const filename = String(artifact.filename || "").toLowerCase();
  return /(?:zip|x-zip-compressed|x-7z-compressed|x-rar-compressed|gzip|tar)/.test(contentType) ||
    /\.(?:zip|7z|rar|tar|gz|tgz)$/.test(filename);
}

const IMAGE_FILE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "tif", "tiff", "heic", "psd"]);

function normalizedArtifactContentType(input = {}) {
  return String(input.contentType || input.mimeType || "").toLowerCase().split(";")[0].trim();
}

function artifactInputExtension(input = {}) {
  return path.extname(String(input.filename || "")).replace(/^\./, "").toLowerCase();
}

function validateCapturedArtifactInput(input = {}) {
  const extension = artifactInputExtension(input);
  const contentType = normalizedArtifactContentType(input);
  const originalUrl = String(input.originalUrl || "").trim().toLowerCase();
  const hasImagePayload = contentType.startsWith("image/") || originalUrl.startsWith("data:image/");

  if (!extension || IMAGE_FILE_EXTENSIONS.has(extension) || !hasImagePayload) {
    return;
  }

  throw new Error(
    `Captured artifact content type ${contentType || "unknown"} does not match .${extension} download`
  );
}

function jobRequestedImageOutput(job = {}) {
  const text = `${job.payloadText || ""} ${job.userText || ""}`;
  return /image|picture|photo|poster|cover|illustration|\u6d77\u62a5|\u5c01\u9762|\u751f\u56fe|\u56fe\u7247|\u56fe\u50cf|\u7167\u7247|\u63d2\u753b|\u751f\u6210.{0,16}\u56fe/iu.test(text);
}

function summarizeVisibleReplyWithArtifacts(replyText, artifacts = [], rawReplyText = replyText, job = {}) {
  const imageCount = artifacts.filter(isImageArtifactLike).length;
  if (
    imageCount > 0 &&
    imageCount === artifacts.length &&
    (jobRequestedImageOutput(job) ||
      isGenericImageReply(replyText) ||
      isGenericImageReply(rawReplyText) ||
      looksLikeInterimChatGptReply(rawReplyText))
  ) {
    return `\u5df2\u6355\u83b7 ${imageCount} \u5f20\u56fe\u7247`;
  }

  if (
    artifacts.length > 0 &&
    (looksLikeInterimChatGptReply(rawReplyText) ||
      looksLikeInterimChatGptReply(replyText) ||
      /(?:\/mnt\/data|path\.write_text|write_text\s*\(|print\s*\(\s*f?["']Created:|```(?:python|py)|STDOUT\/STDERR|Created:)/i.test(
        String(rawReplyText || "")
      ))
  ) {
    return `\u5df2\u6355\u83b7 ${artifacts.length} \u4e2a\u6587\u4ef6`;
  }

  return replyText;
}

function filterArtifactErrorsForCapturedArtifacts(artifactErrors = [], capturedArtifacts = []) {
  if (!artifactErrors.length || !capturedArtifacts.length) {
    return artifactErrors;
  }

  const capturedFilenames = new Set(
    capturedArtifacts
      .map((artifact) => artifact?.filename)
      .filter(Boolean)
      .map((filename) => filename.toLowerCase())
  );
  const hasCapturedArchive = capturedArtifacts.some(isArchiveArtifactLike);

  return artifactErrors.filter((error) => {
    const filename = String(error?.filename || "").toLowerCase();
    if (filename && capturedFilenames.has(filename)) {
      return false;
    }
    if (
      hasCapturedArchive &&
      filename &&
      !/\.(?:zip|7z|rar|tar|gz|tgz)$/i.test(filename) &&
      /(?:timed out|timeout|chrome download|download)/i.test(String(error?.error || ""))
    ) {
      return false;
    }
    return true;
  });
}

async function loadArtifactsByIds(storeRoot, artifactIds = []) {
  const artifacts = [];
  for (const artifactId of artifactIds) {
    try {
      const artifact = await getArtifact(storeRoot, artifactId);
      const fileStats = await stat(artifact.filePath);
      if (fileStats.isFile() && fileStats.size > 0) {
        artifacts.push(artifact);
      }
    } catch {
      // Ignore invalid references. Completion only exposes artifacts backed by a real local file.
    }
  }
  return artifacts;
}

async function artifactProjectCopyById(storeRoot) {
  const projectCopyByArtifactId = new Map();
  for (const job of await listSyncJobs(storeRoot)) {
    for (const projectArtifact of job.projectArtifacts || []) {
      const artifactId = projectArtifact?.artifact?.id;
      if (artifactId && !projectCopyByArtifactId.has(artifactId)) {
        projectCopyByArtifactId.set(artifactId, projectArtifact);
      }
    }
  }
  return projectCopyByArtifactId;
}

async function withProjectCopyMetadata(storeRoot, artifacts = []) {
  if (!artifacts.length) {
    return artifacts;
  }
  const projectCopyByArtifactId = await artifactProjectCopyById(storeRoot);
  return artifacts.map((artifact) => {
    const projectArtifact = projectCopyByArtifactId.get(artifact.id) || null;
    return {
      ...artifact,
      projectArtifact,
      projectSavedPath: projectArtifact?.savedPath || null,
      projectRelativePath: projectArtifact?.relativePath || null,
      projectRoot: projectArtifact?.projectRoot || null
    };
  });
}

async function targetProjectDirectoryExists(targetRepo) {
  if (!targetRepo) {
    return false;
  }
  const projectRoot = path.resolve(targetRepo);
  if (projectRoot === path.parse(projectRoot).root) {
    return false;
  }
  try {
    return (await stat(projectRoot)).isDirectory();
  } catch {
    return false;
  }
}

async function saveCapturedArtifactsToProject(storeRoot, artifactIds = [], targetRepo) {
  const projectArtifacts = [];
  const projectArtifactErrors = [];
  const uniqueArtifactIds = [...new Set(artifactIds.filter(Boolean))];
  if (uniqueArtifactIds.length === 0) {
    return { projectArtifacts, projectArtifactErrors };
  }
  if (!targetRepo) {
    return { projectArtifacts, projectArtifactErrors };
  }
  if (!(await targetProjectDirectoryExists(targetRepo))) {
    return {
      projectArtifacts,
      projectArtifactErrors: [
        {
          targetRepo,
          error: "Bound project directory was not found"
        }
      ]
    };
  }

  for (const artifactId of uniqueArtifactIds) {
    try {
      projectArtifacts.push(await saveArtifactToProject(storeRoot, artifactId, targetRepo));
    } catch (error) {
      projectArtifactErrors.push({
        artifactId,
        targetRepo,
        error: error.message
      });
    }
  }
  return { projectArtifacts, projectArtifactErrors };
}

async function collectImageBatchArtifactIds(storeRoot, job = {}, currentArtifactIds = []) {
  const requestedTotal =
    Number(job._bridgeImageBatchTotal) || parseRequestedImageCount(job._bridgeImageBatchOriginalText || job.userText || job.payloadText || "");
  if (!requestedTotal || !job._bridgeImageBatchParentJobId || currentArtifactIds.length === 0) {
    return [];
  }

  const parentJobs = [];
  const seenJobIds = new Set([job.id]);
  let parentJobId = job._bridgeImageBatchParentJobId;
  while (parentJobId && !seenJobIds.has(parentJobId) && parentJobs.length < requestedTotal) {
    seenJobIds.add(parentJobId);
    try {
      const parent = await getSyncJob(storeRoot, parentJobId);
      parentJobs.unshift(parent);
      parentJobId = parent._bridgeImageBatchParentJobId;
    } catch {
      break;
    }
  }

  const orderedIds = [];
  const seenArtifactIds = new Set();
  for (const id of [...parentJobs.flatMap((parent) => parent.artifactIds || []), ...currentArtifactIds]) {
    if (typeof id === "string" && id.trim() && !seenArtifactIds.has(id)) {
      seenArtifactIds.add(id);
      orderedIds.push(id);
    }
  }
  return orderedIds;
}

function mentionedArtifactFilenames(text = "") {
  const extensionPattern = "txt|md|csv|json|pdf|docx?|xlsx?|pptx?|zip|png|jpe?g|webp|gif|html?|psd|ai|fig|svg";
  const filenames = [];
  const seen = new Set();
  const add = (filename) => {
    const clean = String(filename || "").trim();
    const key = clean.toLowerCase();
    if (clean && !seen.has(key)) {
      seen.add(key);
      filenames.push(clean);
    }
  };
  const tokenPattern = new RegExp(
    `(?:^|[\\s"'<>()[\\]{}:,/\\\\\\uFF1A\\uFF0C\\u3001\\u3002\\uFF1B;])([^\\s"'<>|:*?/\\\\:,\\uFF1A\\uFF0C\\u3001\\u3002\\uFF1B;()[\\]{}]+\\.(${extensionPattern}))(?=$|[\\s"'<>),\\]\\}:,.\\uFF1A\\uFF0C\\u3001\\u3002\\uFF1B;])`,
    "giu"
  );
  for (const match of String(text || "").matchAll(tokenPattern)) {
    add(match[1]);
  }
  const looseAsciiPattern = new RegExp(
    `(?:^|[^A-Za-z0-9._-])([A-Za-z0-9][A-Za-z0-9._-]{0,150}\\.(${extensionPattern}))(?=$|[^A-Za-z0-9_-])`,
    "giu"
  );
  for (const match of String(text || "").matchAll(looseAsciiPattern)) {
    add(match[1]);
  }
  return filenames;
}

function hasNegativeArtifactSignal(text = "") {
  return (
    /\b(?:only an example|example filename|no file was generated|no downloadable file|not a real file|not generated|do not (?:generate|create|make) (?:a |any )?files?|don't (?:generate|create|make) (?:a |any )?files?|without (?:generating|creating|making) (?:a |any )?files?)\b/i.test(
      text
    ) || /\u4e0d\u8981\u751f\u6210\u6587\u4ef6|\u4e0d\u751f\u6210\u6587\u4ef6|\u4e0d\u8981\u521b\u5efa\u6587\u4ef6|\u4e0d\u521b\u5efa\u6587\u4ef6|\u6ca1\u6709\u751f\u6210\u6587\u4ef6|\u6ca1\u6709\u53ef\u4e0b\u8f7d\u6587\u4ef6|\u4e0d\u662f\u53ef\u4e0b\u8f7d\u6587\u4ef6/.test(text)
  );
}

function hasArtifactReplySignal(text = "") {
  return (
    /\b(?:generated|created|attached|download|downloadable|saved|file card|here is)\b/i.test(text) ||
    /\u5df2\u751f\u6210|\u751f\u6210\u4e86|\u5df2\u521b\u5efa|\u521b\u5efa\u4e86|\u53ef\u4e0b\u8f7d|\u4e0b\u8f7d|\u9644\u4ef6|\u6587\u4ef6\u5361\u7247|\u6587\u4ef6/.test(text)
  );
}

function hasArtifactRequestSignal(job = {}) {
  const text = `${job.userText || ""} ${job.payloadText || ""}`;
  const hasActionSignal =
    /\b(?:generate|create|make|download|downloadable|export|save)\b/i.test(text) ||
    /(?:\u751f\u6210|\u521b\u5efa|\u5236\u4f5c|\u5bfc\u51fa|\u4fdd\u5b58|\u53ef\u4e0b\u8f7d|\u771f\u5b9e\u53ef\u4e0b\u8f7d|\u70b9\u51fb\u4e0b\u8f7d|\u63d0\u4f9b\u4e0b\u8f7d)/u.test(text);
  const hasFileSignal =
    /\.(?:txt|md|csv|json|pdf|docx?|xlsx?|pptx?|zip|png|jpe?g|webp|gif|html?|psd|ai|fig|svg)\b/i.test(text) ||
    /\b(?:txt|md|csv|json|pdf|docx?|xlsx?|pptx?|zip|png|jpe?g|webp|gif|html?|psd|ai|fig|svg)\b/i.test(text);
  return hasActionSignal && hasFileSignal;
}

function requestedArtifactFilenames(job = {}) {
  if (!hasArtifactRequestSignal(job)) {
    return [];
  }

  return mentionedArtifactFilenames(`${job.userText || ""} ${job.payloadText || ""}`);
}

function inferMissingArtifactErrors(replyText, artifactIds = [], artifactErrors = [], job = {}) {
  if (artifactIds.length > 0) {
    return [];
  }

  const requiresImageArtifact = job.kind === "image_request";
  const jobText = `${job.userText || ""} ${job.payloadText || ""}`;
  if (
    job.kind === "codex_file_analysis" &&
    Array.isArray(job.inputArtifacts) &&
    job.inputArtifacts.length > 0 &&
    (hasNegativeArtifactSignal(jobText) || !hasArtifactRequestSignal(job))
  ) {
    return [];
  }

  if (hasNegativeArtifactSignal(replyText) && !requiresImageArtifact) {
    return [];
  }

  if (!requiresImageArtifact && !hasArtifactReplySignal(replyText) && !hasArtifactRequestSignal(job)) {
    return [];
  }

  const existingFilenames = new Set(
    artifactErrors
      .map((error) => error?.filename)
      .filter(Boolean)
      .map((filename) => filename.toLowerCase())
  );
  const inputFilenames = new Set(
    Array.isArray(job.inputArtifacts)
      ? job.inputArtifacts
          .map((artifact) => artifact?.filename)
          .filter(Boolean)
          .map((filename) => filename.toLowerCase())
      : []
  );

  const requestedFilenames = requestedArtifactFilenames(job);
  const replyFilenames = requestedFilenames.length > 0 ? [] : mentionedArtifactFilenames(replyText);

  const missingArtifacts = [...new Set([...replyFilenames, ...requestedFilenames])]
    .filter((filename) => !existingFilenames.has(filename.toLowerCase()))
    .filter((filename) => !inputFilenames.has(filename.toLowerCase()))
    .map((filename) => ({
      code: "missing_download",
      filename,
      originalUrl: null,
      error: "GPT 提到了生成文件，但 Bridge 没有捕获到真实可下载文件。GPT 文件卡片可能损坏或不可用。"
    }));
  if (missingArtifacts.length === 0 && requiresImageArtifact) {
    missingArtifacts.push({
      code: "missing_download",
      filename: null,
      originalUrl: null,
      error: "GPT 图片任务没有捕获到真实图片文件。图片可能仍在生成，或页面资源尚未可用。"
    });
  }
  return missingArtifacts;
}

function shouldFailForMissingArtifactCapture(job = {}, replyText = "", artifactIds = [], artifactErrors = []) {
  return (
    artifactIds.length === 0 &&
    artifactErrors.some((error) => error?.code === "missing_download" || error?.error) &&
    (job.kind === "image_request" || hasArtifactRequestSignal(job) || hasArtifactReplySignal(replyText))
  );
}

function missingArtifactFailureMessage(artifactErrors = []) {
  const filenames = artifactErrors
    .map((error) => error?.filename)
    .filter(Boolean)
    .slice(0, 3);
  const suffix = filenames.length > 0 ? `: ${filenames.join(", ")}` : "";
  return `GPT 提到了可下载文件，但 Bridge 没有捕获到真实文件${suffix}`;
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

function isImageGenerationText(text = "") {
  return /(?:\u751f\u6210|\u753b|\u7ed8\u5236|create|generate|make|draw|paint).{0,30}(?:\u56fe|\u56fe\u7247|\u56fe\u50cf|\u7167\u7247|image|picture|photo)|(?:\u56fe|\u56fe\u7247|\u56fe\u50cf|\u7167\u7247|image|picture|photo).{0,30}(?:\u751f\u6210|\u753b|\u7ed8\u5236|create|generate|make|draw|paint)/iu.test(
    text
  );
}

function parseRequestedImageCount(text = "") {
  if (!isImageGenerationText(text)) {
    return null;
  }

  const normalized = String(text);
  const digitMatch =
    normalized.match(/(\d{1,2})\s*(?:\u5f20|\u5f35|\u4e2a)?\s*(?:\u56fe|\u56fe\u7247|\u56fe\u50cf|\u7167\u7247|images?|pictures?|photos?)/iu) ||
    normalized.match(/(?:\u56fe|\u56fe\u7247|\u56fe\u50cf|\u7167\u7247|images?|pictures?|photos?)\s*(?:\u5171|\u603b\u5171|\u4e00\u5171|\u6570\u91cf|count|total|:|\uff1a)?\s*(\d{1,2})\s*(?:\u5f20|\u5f35|\u4e2a)?/iu);
  if (digitMatch) {
    const count = Number(digitMatch[1]);
    return count >= 2 && count <= 10 ? count : null;
  }

  const chineseMatch =
    normalized.match(/([\u4e00\u4e8c\u4e24\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341])\s*(?:\u5f20|\u5f35|\u4e2a)?\s*(?:\u56fe|\u56fe\u7247|\u56fe\u50cf|\u7167\u7247)/u) ||
    normalized.match(/(?:\u56fe|\u56fe\u7247|\u56fe\u50cf|\u7167\u7247)\s*(?:\u5171|\u603b\u5171|\u4e00\u5171|\u6570\u91cf|:|\uff1a)?\s*([\u4e00\u4e8c\u4e24\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341])\s*(?:\u5f20|\u5f35|\u4e2a)?/u);
  if (chineseMatch) {
    const count = CHINESE_SMALL_NUMBERS.get(chineseMatch[1]);
    return count >= 2 && count <= 10 ? count : null;
  }

  return null;
}

function buildImageBatchContinuation(before, artifactIds = []) {
  const requestedTotal =
    Number(before._bridgeImageBatchTotal) || parseRequestedImageCount(before._bridgeImageBatchOriginalText || before.userText || before.payloadText || "");
  if (!requestedTotal || requestedTotal < 2) {
    return null;
  }

  const previousCaptured = Number(before._bridgeImageBatchCaptured || 0);
  const currentCaptured = Array.isArray(artifactIds) ? artifactIds.length : 0;
  if (currentCaptured <= 0) {
    return null;
  }
  const capturedTotal = previousCaptured + currentCaptured;
  const remaining = requestedTotal - capturedTotal;
  const attempt = Number(before._bridgeImageBatchAttempt || 0);
  if (remaining <= 0 || attempt >= requestedTotal) {
    return null;
  }

  return {
    requestedTotal,
    capturedTotal,
    remaining,
    attempt: attempt + 1,
    originalText: before._bridgeImageBatchOriginalText || before.userText || before.payloadText || "",
    promptText: [
      "继续生成剩余 " + remaining + " 张图片。",
      "延续上一条主题和要求，每张画面风格不同。",
      "直接使用 GPT 自带图片生成功能生成图片，不要写代码，不要生成 zip。"
    ].join("\n")
  };
}

function isClientBlockedError(error = "", errorCode = null) {
  const message = String(error || "");
  return (
    errorCode === "client_blocked" ||
    /err_blocked_by_client|blocked by client|chrome.*blocked|宸茶灞忚斀|琚玕s*chrome\s*灞忚斀/i.test(message)
  );
}

function normalizeSyncFailureBody(body = {}) {
  if (isClientBlockedError(body.error, body.errorCode)) {
    return {
      ...body,
      errorCode: "client_blocked",
      recoveryAction: body.recoveryAction || "disable_client_blocker"
    };
  }
  return body;
}

function conciseSyncFailureReason(error = "", errorCode = null) {
  const message = String(error || "").trim();
  if (errorCode === "manual_cancelled") {
    return "已手动停止这次 GPT 任务。";
  }
  if (isClientBlockedError(message, errorCode)) {
    return "Chrome 或其他扩展拦截了 GPT 页面。Bridge 已停止自动恢复，请关闭拦截或把 chatgpt.com 加入白名单后，只刷新绑定会话。";
  }
  if (errorCode === "human_verification" || /human verification|cloudflare|verify you are human/i.test(message)) {
    return "GPT 需要真人验证。请先在绑定的 GPT 页面完成验证。";
  }
  if (errorCode === "account_selection" || /account selection|login|log in|sign in/i.test(message)) {
    return "GPT 需要确认当前账号。请先在绑定的 GPT 页面确认账号。";
  }
  if (errorCode === "conversation_unavailable" || errorCode === "start_page") {
    return "绑定的 GPT 会话不可用。请重新绑定一个能打开的会话。";
  }
  if (errorCode === "generation_failed" || /generation failed|generating the response|something went wrong/i.test(message)) {
    return "GPT 网页端生成失败。请重试，连续失败时换一个会话后再发送。";
  }
  if (errorCode === "attachment_upload_failed" || /attachment upload/i.test(message)) {
    return "附件上传失败。请刷新绑定会话后重试。";
  }
  if (
    errorCode === "reply_timeout" ||
    /timed out waiting for (?:chatgpt|gpt) reply|reply timeout/i.test(message)
  ) {
    return "GPT 卡住了。请只刷新绑定的 GPT 页面后重试。";
  }
  if (/previous response|stop the previous response/i.test(message)) {
    return "GPT 上一次回复还没结束。请停止或刷新绑定会话后重试。";
  }
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "网络或附件上传失败。请确认 Bridge 和绑定的 GPT 页面都已打开后重试。";
  }
  if (errorCode === "missing_download" || /missing_download/i.test(message)) {
    return "GPT 提到了文件，但 Bridge 没有捕获到真实可下载文件。请让 GPT 重新生成。";
  }
  return "GPT 同步失败。请刷新绑定的 GPT 页面后重试。";
}

function visibleSyncFailureText(error = "", errorCode = null) {
  const message = String(error || "").trim();
  if (isClientBlockedError(message, errorCode)) {
    return [
      "GPT 页面被 Chrome 拦截",
      "",
      "这不是 GPT 的正常回复，而是本机浏览器或扩展阻止了 chatgpt.com。Bridge 已停止自动刷新和发送，避免反复触发错误页。",
      "",
      "请关闭拦截 chatgpt.com 的扩展或把 chatgpt.com 加入白名单，然后只刷新绑定的 GPT 会话。"
    ].join("\n");
  }
  if (/failed to fetch|networkerror|load failed/i.test(message) || errorCode === "attachment_upload_failed") {
    return [
      "附件上传失败",
      "",
      "Bridge 没有成功把文件交给 GPT。请确认本地服务和绑定的 GPT 页面都已打开，然后重试。"
    ].join("\n");
  }
  if (/attachment upload/i.test(message)) {
    return [
      "附件上传失败",
      "",
      "文件没有出现在 GPT 页面里。请刷新绑定会话后重试。"
    ].join("\n");
  }
  if (errorCode === "reply_timeout" || /timed out waiting for (?:chatgpt|gpt) reply/i.test(message)) {
    return [
      "GPT 卡住了",
      "",
      "GPT 长时间没有返回结果。请只刷新绑定的 GPT 页面后重试。"
    ].join("\n");
  }

  if (errorCode === "human_verification" || /human verification|cloudflare|verify you are human/i.test(message)) {
    return ["GPT 需要真人验证", "", "请在绑定的 GPT 页面完成验证，然后重试。"].join("\n");
  }
  if (errorCode === "account_selection" || /account selection|login|log in|sign in/i.test(message)) {
    return ["GPT 需要账号确认", "", "请在绑定的 GPT 页面确认当前账号，然后重试。"].join("\n");
  }
  if (errorCode === "conversation_unavailable" || errorCode === "start_page") {
    return ["绑定的 GPT 会话不可用", "", "请重新绑定一个能打开的 GPT 会话，然后再发送。"].join("\n");
  }
  if (errorCode === "generation_failed" || /generation failed|generating the response|something went wrong/i.test(message)) {
    return ["GPT 生成失败", "", "可以点击重试；如果连续失败，请换一个会话。"].join("\n");
  }
  if (errorCode === "missing_download" || /missing_download/i.test(message)) {
    return [
      "文件没有捕获成功",
      "",
      "GPT 提到了文件，但 Bridge 没有捕获到真实可下载文件。请让 GPT 重新生成文件。"
    ].join("\n");
  }
  if (/previous response|stop the previous response/i.test(message)) {
    return ["GPT 上一次回复还没结束", "", "请停止当前回复，或刷新绑定的 GPT 页面后重试。"].join("\n");
  }
  return ["GPT 同步失败", "", "请刷新绑定的 GPT 页面后重试。"].join("\n");
}

function gptVisibleText(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  return text
    .replace(
      /ChatGPT page cannot receive messages yet/gi,
      "GPT 页面暂时不能接收任务"
    )
    .replace(
      /Keep this page open\. Bridge will continue after the page recovers\./gi,
      "保持绑定的 GPT 页面打开，页面恢复后 Bridge 会继续。"
    )
    .replace(
      /ChatGPT is still generating\. Bridge will wait for the current reply to finish\./gi,
      "GPT 正在生成上一条回复，Bridge 会等它结束后继续。"
    )
    .replace(
      /ChatGPT composer is not available yet, possibly because the page is still rendering or blocked by a dialog\./gi,
      "GPT 输入框暂时不可用，可能页面仍在加载或被弹窗阻挡。"
    )
    .replace(
      /ChatGPT page is ready to receive Bridge messages\./gi,
      "GPT 页面已就绪。"
    )
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
    .replace(
      /GPT page was blocked by Chrome or another extension\./gi,
      "GPT 页面被 Chrome 或其他扩展拦截。"
    )
    .replace(
      /ChatGPT is on the new chat page instead of the bound conversation\./gi,
      "当前 GPT 页面不是绑定会话。"
    )
    .replace(
      /ChatGPT is showing a file preview\. Bridge will return to the bound conversation first\./gi,
      "GPT 正在显示文件预览，Bridge 会先回到绑定会话。"
    )
    .replace(/ERR_BLOCKED_BY_CLIENT/gi, "页面被客户端拦截")
    .replace(/\bChatGPT Project\b/g, "GPT 会话")
    .replace(/\bChatGPT\b/g, "GPT");
}

function extensionVersionFromWorkerId(workerId = "") {
  const value = workerId || "";
  const match = value.match(/(clean-capture-\d+|v\d{8}[-\w]*)/i);
  return match?.[1] || value || null;
}

function hasExplicitExtensionVersion(workerId = "") {
  return /(clean-capture-\d+|v\d{8}[-\w]*)/i.test(workerId || "");
}

function extensionNeedsReload(version) {
  return Boolean(version && version !== EXPECTED_EXTENSION_VERSION);
}

function isExpectedExtensionVersion(workerId = "") {
  return extensionVersionFromWorkerId(workerId) === EXPECTED_EXTENSION_VERSION;
}

function isCompatibleExtensionVersion(workerId = "") {
  const version = extensionVersionFromWorkerId(workerId);
  if (!hasExplicitExtensionVersion(workerId)) {
    return true;
  }
  return COMPATIBLE_EXTENSION_VERSIONS.has(version);
}

function extensionCompatibilityState(version) {
  if (!version) {
    return "blocked";
  }
  if (version === EXPECTED_EXTENSION_VERSION) {
    return "passed";
  }
  return COMPATIBLE_EXTENSION_VERSIONS.has(version) ? "warning" : "blocked";
}

function selectExtensionHeartbeat(heartbeats = [], workspace = null) {
  const connected = heartbeats.filter((heartbeat) => heartbeat.connected);
  const workspaceMatch = (heartbeat) => extensionProjectMatches(workspace, heartbeat) === true;
  const expected = (heartbeat) => isExpectedExtensionVersion(heartbeat?.workerId || "");
  const compatible = (heartbeat) => isCompatibleExtensionVersion(heartbeat?.workerId || "");
  return (
    connected.find((heartbeat) => workspaceMatch(heartbeat) && expected(heartbeat)) ||
    connected.find((heartbeat) => workspaceMatch(heartbeat) && compatible(heartbeat)) ||
    heartbeats.find((heartbeat) => workspaceMatch(heartbeat) && expected(heartbeat)) ||
    heartbeats.find((heartbeat) => workspaceMatch(heartbeat) && compatible(heartbeat)) ||
    connected.find(expected) ||
    connected.find(compatible) ||
    connected[0] ||
    heartbeats.find(expected) ||
    heartbeats.find(compatible) ||
    heartbeats[0] ||
    null
  );
}

function selectExtensionReloadEvidenceHeartbeat(heartbeats = [], workspace = null) {
  return (
    heartbeats.find((heartbeat) => {
      const workerId = heartbeat?.workerId || "";
      const version = extensionVersionFromWorkerId(workerId);
      const matchesWorkspace = extensionProjectMatches(workspace, heartbeat);
      return hasExplicitExtensionVersion(workerId) && extensionNeedsReload(version) && matchesWorkspace !== false;
    }) || null
  );
}

function heartbeatPageCanReceive(heartbeat = null) {
  const state = heartbeat?.pageStatus?.state || null;
  return !state || state === "ready" || state === "warning";
}

function selectExtensionRecoveryEvidenceHeartbeat(heartbeats = [], workspace = null) {
  return (
    heartbeats.find((heartbeat) => {
      const matchesWorkspace = extensionProjectMatches(workspace, heartbeat);
      return (
        isExpectedExtensionVersion(heartbeat?.workerId || "") &&
        heartbeatPageCanReceive(heartbeat) &&
        matchesWorkspace !== false
      );
    }) ||
    null
  );
}

function buildAcceptanceExtensionSnapshot({ heartbeats = [], heartbeat = null, workerId = null, workspace = null }) {
  const reloadHeartbeat = selectExtensionReloadEvidenceHeartbeat(heartbeats, workspace);
  const recoveryHeartbeat = selectExtensionRecoveryEvidenceHeartbeat(heartbeats, workspace);
  const evidenceWorkerId = reloadHeartbeat?.workerId || workerId;
  const evidenceVersion = extensionVersionFromWorkerId(evidenceWorkerId);
  const currentVersion = extensionVersionFromWorkerId(workerId);
  const currentNeedsReload = hasExplicitExtensionVersion(workerId) && extensionNeedsReload(currentVersion);
  const recoveredVersion = extensionVersionFromWorkerId(recoveryHeartbeat?.workerId || "");

  return {
    workerId: evidenceWorkerId,
    version: evidenceVersion,
    expectedVersion: EXPECTED_EXTENSION_VERSION,
    needsReload: Boolean(reloadHeartbeat) || currentNeedsReload,
    currentWorkerId: workerId,
    currentVersion,
    currentConnected: Boolean(heartbeat?.connected),
    currentHref: heartbeat?.href || null,
    currentTitle: heartbeat?.title || null,
    currentPageStatus: heartbeat?.pageStatus || null,
    currentUpdatedAt: heartbeat?.updatedAt || null,
    recoveredWorkerId: recoveryHeartbeat?.workerId || null,
    recoveredVersion,
    recoveredHref: recoveryHeartbeat?.href || null,
    recoveredTitle: recoveryHeartbeat?.title || null,
    recoveredPageStatus: recoveryHeartbeat?.pageStatus || null,
    recoveredAt: recoveryHeartbeat?.updatedAt || null
  };
}

function visibleSyncJobs(syncJobs = []) {
  return syncJobs.filter((job) => job.kind !== "preference_sync");
}

function syncJobMatchesWorkspace(job = {}, workspace = null) {
  if (!job) {
    return false;
  }
  if (!workspace?.conversationId && !workspace?.chatgptProjectUrl) {
    return true;
  }
  if (workspace?.conversationId && job.conversationId) {
    return job.conversationId === workspace.conversationId;
  }
  if (workspace?.chatgptProjectUrl && job.projectUrl) {
    return chatgptUrlsMatch(workspace.chatgptProjectUrl, job.projectUrl);
  }
  return false;
}

function syncJobsForWorkspace(syncJobs = [], workspace = null) {
  return syncJobs.filter((job) => syncJobMatchesWorkspace(job, workspace));
}

function extensionProjectMatches(workspace = null, heartbeat = null) {
  if (!workspace?.chatgptProjectUrl || !heartbeat?.href) {
    return null;
  }
  return chatgptUrlsMatch(workspace.chatgptProjectUrl, heartbeat.href);
}

function heartbeatCanControlWorkspace(heartbeat = null, workspace = null) {
  return Boolean(isCompatibleExtensionVersion(heartbeat?.workerId) && extensionProjectMatches(workspace, heartbeat));
}

function shortChatgptPath(value = "") {
  try {
    const url = new URL(value);
    return url.hostname + url.pathname;
  } catch {
    return value || "";
  }
}

function preferenceStatusMatchesWorkspace(preferenceStatus = null, workspace = null) {
  if (!preferenceStatus || !workspace) {
    return false;
  }
  const preferenceUpdatedAt = workspace.preferenceUpdatedAt || workspace.updatedAt || null;
  if (preferenceUpdatedAt && preferenceStatus.updatedAt !== preferenceUpdatedAt) {
    return false;
  }
  return (
    (preferenceStatus.modePreference || null) === (workspace.modePreference || null) &&
    (preferenceStatus.modelPreference || null) === (workspace.modelPreference || null)
  );
}

function currentWorkspacePreferenceStatus(heartbeat = null, workspace = null) {
  return preferenceStatusMatchesWorkspace(heartbeat?.preferenceStatus, workspace) ? heartbeat.preferenceStatus : null;
}

function preferenceStatusAppliedForWorkspace(preferenceStatus = null, workspace = null) {
  return preferenceStatus?.state === "applied" && preferenceStatusMatchesWorkspace(preferenceStatus, workspace);
}

function formatAge(ageMs) {
  if (!Number.isFinite(ageMs)) {
    return "时间未知";
  }
  if (ageMs < 60_000) {
    return Math.max(1, Math.round(ageMs / 1000)) + " 秒前";
  }
  if (ageMs < 60 * 60_000) {
    return Math.round(ageMs / 60_000) + " 分钟前";
  }
  return Math.round(ageMs / (60 * 60_000)) + " 小时前";
}

function heartbeatConnectionDetail(heartbeat = null) {
  if (heartbeat?.connected) {
    return shortChatgptPath(heartbeat.href);
  }
  if (heartbeat?.href) {
    return "绑定页面心跳已过期（" + formatAge(heartbeat.ageMs) + "）：" + shortChatgptPath(heartbeat.href);
  }
  return "还没有收到绑定页面的心跳";
}

function pageStatusConnectionState(pageStatus = null) {
  if (!pageStatus) {
    return "passed";
  }
  if (pageStatus.state === "blocked") {
    return "blocked";
  }
  if (pageStatus.state === "working") {
    return "working";
  }
  if (pageStatus.state === "warning") {
    return "warning";
  }
  return "passed";
}

function pageStatusDetail(pageStatus = null) {
  if (pageStatus?.code === "client_blocked" || isClientBlockedError(pageStatus?.message, pageStatus?.code)) {
    return "Chrome 或其他扩展拦截了 GPT 页面。Bridge 已停止自动恢复，请关闭拦截或把 chatgpt.com 加入白名单后，只刷新绑定会话。";
  }
  const message = gptVisibleText(pageStatus?.message);
  if (message === "GPT 页面已就绪。") return "GPT 页面已就绪。";
  return message || "GPT 页面已就绪。";
}

function connectionPageStateCheck(pageStatus = null, extensionVersionState = "blocked", { activeSyncJob = null } = {}) {
  if (extensionVersionState === "blocked") {
    return {
      state: "passed",
      detail: "扩展版本过旧，暂不采用旧脚本上报的页面状态。"
    };
  }
  if (pageStatus?.state === "working" && pageStatus.code === "active_generation" && !activeSyncJob) {
    return {
      state: "passed",
      detail: "GPT page reports generation, but Bridge has no active task for this project."
    };
  }
  return {
    state: pageStatusConnectionState(pageStatus),
    detail: pageStatusDetail(pageStatus)
  };
}

function buildConnectionStatus({ workspace, heartbeat, extensionVersion, projectMatches, activeSyncJob }) {
  const preferenceStatus = currentWorkspacePreferenceStatus(heartbeat, workspace);
  const pageStatus = heartbeat?.connected ? heartbeat.pageStatus : null;
  const extensionVersionState = extensionCompatibilityState(extensionVersion);
  const pageStateCheck = connectionPageStateCheck(pageStatus, extensionVersionState, { activeSyncJob });
  const staleActiveSync =
    isRunningSyncStale(activeSyncJob) ||
    isReadyPageSentSyncStale(activeSyncJob, heartbeat) ||
    isUnsentRunningSyncStale(activeSyncJob);
  const checks = [
    {
      id: "project-bound",
      label: "GPT 会话",
      state: workspace?.chatgptProjectUrl ? "passed" : "blocked",
      detail: workspace?.chatgptProjectUrl ? shortChatgptPath(workspace.chatgptProjectUrl) : "还没有绑定 GPT 会话"
    },
    {
      id: "extension-connected",
      label: "Bridge 扩展",
      state: heartbeat?.connected ? "passed" : "blocked",
      detail: heartbeatConnectionDetail(heartbeat)
    },
    {
      id: "extension-version",
      label: "扩展版本",
      state: extensionVersionState,
      detail: extensionVersion ? "当前 " + extensionVersion : "需要 " + EXPECTED_EXTENSION_VERSION
    },
    {
      id: "bound-page",
      label: "\u7ed1\u5b9a\u9875\u9762",
      state: projectMatches === false ? "blocked" : "passed",
      detail: projectMatches === false ? "\u5f53\u524d GPT \u9875\u9762\u4e0d\u662f\u8fd9\u4e2a\u9879\u76ee\u7ed1\u5b9a\u7684\u4f1a\u8bdd\u3002" : "\u53ea\u63a7\u5236\u5f53\u524d\u9879\u76ee\u7ed1\u5b9a\u7684 GPT \u9875\u9762\u3002"
    },
    {
      id: "page-state",
      label: "页面状态",
      state: pageStateCheck.state,
      detail: pageStateCheck.detail
    },
    {
      id: "active-sync",
      label: "同步任务",
      state: activeSyncJob ? (staleActiveSync ? "warning" : "working") : "passed",
      detail: activeSyncJob ? syncStatusReason(activeSyncJob, { heartbeat, workspace }) : "当前项目没有阻塞中的 GPT 任务。"
    },
    {
      id: "preferences",
      label: "模型偏好",
      state: preferenceStatus?.state === "failed" ? "warning" : "passed",
      detail:
        preferenceStatus?.state === "failed"
          ? gptVisibleText(preferenceStatus.error) || "GPT 没有确认模型或模式已应用。"
          : preferenceStatus?.state === "applied"
            ? "模型和模式已经应用。"
            : "没有需要处理的模型偏好问题。"
    }
  ];
  const blockers = checks.filter((check) => check.state === "blocked").map((check) => check.label);
  const warnings = checks.filter((check) => check.state === "warning").map((check) => check.label);
  const visibleWarnings = checks
    .filter((check) => check.state === "warning" && check.id !== "preferences")
    .map((check) => check.label);
  const working = checks.filter((check) => check.state === "working").map((check) => check.label);
  const ready = blockers.length === 0 && working.length === 0;
  let label = "连接就绪";
  if (blockers.length) {
    if (extensionVersionState === "blocked") label = "扩展需重载";
    else if (!workspace?.chatgptProjectUrl) label = "未绑定";
    else if (!heartbeat?.connected) label = "等待扩展";
    else if (projectMatches === false) label = "页面不匹配";
    else if (pageStateCheck.state === "blocked") {
      if (pageStatus?.code === "client_blocked") label = "页面被拦截";
      else if (["human_verification", "account_selection"].includes(pageStatus?.code)) label = "需要确认";
      else if (["conversation_unavailable", "start_page"].includes(pageStatus?.code)) label = "需要重新绑定";
      else label = "页面需处理";
    } else {
      label = "需要处理";
    }
  } else if (working.length) {
    label = "GPT 忙碌";
  } else if (visibleWarnings.length) {
    label = "有警告";
  }

  return {
    scope: "bound-chatgpt-page",
    ready,
    canSendToGpt: ready,
    level: blockers.length ? "blocked" : working.length ? "working" : visibleWarnings.length ? "warning" : "ready",
    label,
    blockers,
    warnings,
    working,
    checks
  };
}

function buildDataCoverageStatus(input = {}) {
  const acceptance = buildAcceptanceStatus(input);
  const summary = acceptance.groupSummaries?.data || acceptance.summary || {
    total: 0,
    passed: 0,
    missing: 0,
    failed: 0
  };

  return {
    ...acceptance,
    summary,
    checks: acceptance.groups?.find((group) => group.id === "data")?.checks || acceptance.checks,
    label: "数据读取 " + summary.passed + "/" + summary.total
  };
}

function buildRouteCoverageStatus(input = {}) {
  const acceptance = buildAcceptanceStatus(input);
  const summary = acceptance.groupSummaries?.routing || {
    total: 0,
    passed: 0,
    missing: 0,
    failed: 0
  };

  return {
    workspace: acceptance.workspace,
    summary,
    checks: acceptance.groups?.find((group) => group.id === "routing")?.checks || [],
    label: "自动路由 " + summary.passed + "/" + summary.total
  };
}

function latestStructuredFailureWorkflowStatus(latestSyncJob = null) {
  if (latestSyncJob?.status !== "failed" || !latestSyncJob.errorCode) {
    return null;
  }
  const detail = syncStatusReason(latestSyncJob);
  if (["human_verification", "account_selection"].includes(latestSyncJob.errorCode)) {
    return {
      level: "blocked",
      label: "需要处理",
      title: "GPT 页面需要你处理",
      detail,
      nextStep: "处理 GPT 页面上的提示后，再重试失败消息。"
    };
  }
  if (latestSyncJob.errorCode === "client_blocked") {
    return {
      level: "blocked",
      label: "页面被拦截",
      title: "GPT 页面被 Chrome 拦截",
      detail,
      nextStep: "关闭拦截 chatgpt.com 的扩展或把 chatgpt.com 加入白名单，然后只刷新绑定会话。"
    };
  }
  if (["conversation_unavailable", "start_page"].includes(latestSyncJob.errorCode)) {
    return {
      level: "blocked",
      label: "需要重新绑定",
      title: "绑定的 GPT 会话不可用",
      detail,
      nextStep: "重新绑定一个能打开的 GPT 会话，然后再发送。"
    };
  }
  if (["generation_failed", "attachment_upload_failed", "reply_timeout"].includes(latestSyncJob.errorCode)) {
    return {
      level: "warning",
      label: "可重试",
      title: "GPT 没有完成",
      detail,
      nextStep: "从失败消息处重试；如果连续失败，请换一个会话。"
    };
  }
  return null;
}

function workflowStatusFromPageStatus(pageStatus = null, { activeSyncJob = null } = {}) {
  if (!pageStatus || pageStatus.state === "ready") {
    return null;
  }
  const detail = pageStatusDetail(pageStatus);
  if (["human_verification", "account_selection"].includes(pageStatus.code)) {
    return {
      level: "blocked",
      label: "需要处理",
      title: "GPT 页面需要你处理",
      detail,
      nextStep: "处理 GPT 页面上的提示后，再重试或重新发送。"
    };
  }
  if (pageStatus.code === "client_blocked") {
    return {
      level: "blocked",
      label: "页面被拦截",
      title: "GPT 页面被 Chrome 拦截",
      detail,
      nextStep: "关闭拦截 chatgpt.com 的扩展或把 chatgpt.com 加入白名单，然后只刷新绑定会话。"
    };
  }
  if (["conversation_unavailable", "start_page"].includes(pageStatus.code)) {
    return {
      level: "blocked",
      label: "需要重新绑定",
      title: "绑定的 GPT 会话不可用",
      detail,
      nextStep: "重新绑定一个能打开的 GPT 会话，然后再发送。"
    };
  }
  if (pageStatus.code === "generation_failed") {
    return {
      level: "warning",
      label: "可重试",
      title: "GPT 生成失败",
      detail,
      nextStep: "从失败消息处重试；如果连续失败，请换一个会话。"
    };
  }
  if (pageStatus.state === "working") {
    if (pageStatus.code === "active_generation" && !activeSyncJob) {
      return null;
    }
    return {
      level: "working",
      label: "GPT 页面恢复中",
      title: "GPT 页面暂时不能接收任务",
      detail,
      nextStep: "保持绑定的 GPT 页面打开，页面恢复后 Bridge 会继续。"
    };
  }
  if (pageStatus.state === "warning") {
    return {
      level: "warning",
      label: "页面需检查",
      title: "GPT 页面状态不稳定",
      detail,
      nextStep: "如果发送失败，只刷新绑定的 GPT 页面后重试。"
    };
  }
  return null;
}

function staleActiveSyncWorkflowStatus(job = null, { heartbeat = null, workspace = null } = {}) {
  if (
    !job ||
    (!isRunningSyncStale(job) && !isReadyPageSentSyncStale(job, heartbeat) && !isUnsentRunningSyncStale(job))
  ) {
    return null;
  }
  const sent = Boolean(job.sentAt);
  return {
    level: "warning",
    label: sent ? "捕获卡住" : "发送卡住",
    title: sent ? "GPT 回复捕获卡住" : "GPT 消息发送卡住",
    detail: syncStatusReason(job, { heartbeat, workspace }),
    nextStep: sent
      ? "刷新验收或重试这条消息；如果 GPT 页面已经有最终结果，Bridge 应该继续捕获而不是一直等待。"
      : "只刷新绑定的 GPT 页面，然后重试这条消息。"
  };
}

function buildWorkflowStatus({ workspace, heartbeat, extensionVersion, projectMatches, activeSyncJob, latestSyncJob }) {
  const preferenceStatus = currentWorkspacePreferenceStatus(heartbeat, workspace);
  const pageStatus = heartbeat?.connected ? heartbeat.pageStatus : null;
  const extensionVersionState = extensionCompatibilityState(extensionVersion);

  if (!workspace?.chatgptProjectUrl) {
    return {
      level: "setup",
      label: "GPT 未绑定",
      title: "先绑定 GPT 会话",
      detail: "Bridge 还不知道要同步到哪个 GPT 会话。",
      nextStep: "打开设置，填入一个可以访问的 GPT 会话地址。"
    };
  }

  if (extensionVersionState === "blocked") {
    return {
      level: "blocked",
      label: "扩展需重载",
      title: "Bridge 扩展版本过旧",
      detail: "当前扩展 " + (extensionVersion || "unknown") + "，服务端需要 " + EXPECTED_EXTENSION_VERSION + "。",
      nextStep: "请在 Chrome 扩展管理页重载 Bridge 扩展，然后刷新 Bridge 页面。"
    };
  }

  if (!heartbeat?.connected) {
    if (heartbeat && projectMatches === true) {
      return {
        level: "blocked",
        label: "绑定页断开",
        title: "绑定的 GPT 页面已断开",
        detail: gptVisibleText(heartbeatConnectionDetail(heartbeat)) + "。如果页面显示“已被屏蔽”或“页面被客户端拦截”，说明 Chrome 或其它扩展拦截了 chatgpt.com。",
        nextStep: "先关闭拦截 chatgpt.com 的扩展或加入白名单，然后只刷新这个绑定的 GPT 会话。Bridge 不会继续自动刷新。"
      };
    }
    return {
      level: "blocked",
      label: "等待扩展",
      title: "Bridge 扩展未连接",
      detail: "本地服务已运行，但还没有收到 Chrome 扩展心跳。",
      nextStep: "打开绑定的 GPT 页面，或在 Chrome 扩展管理页重载 Bridge 扩展。"
    };
  }

  if (projectMatches === false) {
    return {
      level: "blocked",
      label: "页面不匹配",
      title: "当前 GPT 页面不是绑定会话",
      detail: "Bridge 正在等待绑定的 GPT 会话：" + shortChatgptPath(workspace.chatgptProjectUrl),
      nextStep: "发送前先打开或切回绑定的 GPT 会话。"
    };
  }

  const pageWorkflowStatus = workflowStatusFromPageStatus(pageStatus, { activeSyncJob });
  if (pageWorkflowStatus) {
    return pageWorkflowStatus;
  }

  if (activeSyncJob?.status === "pending") {
    return {
      level: "working",
      label: "等待 GPT",
      title: "消息已排队",
      detail: "Bridge 正在等待绑定的 GPT 页面接收这条消息。",
      nextStep: "保持绑定的 GPT 页面打开；如果长时间没有变化，再重试。"
    };
  }

  const staleActiveSyncStatus = staleActiveSyncWorkflowStatus(activeSyncJob, { heartbeat, workspace });
  if (staleActiveSyncStatus) {
    return staleActiveSyncStatus;
  }

  if (activeSyncJob?.status === "running") {
    return {
      level: "working",
      label: activeSyncJob.sentAt ? "GPT \u5904\u7406\u4e2d" : "\u6269\u5c55\u51c6\u5907\u4e2d",
      title: activeSyncJob.sentAt ? "GPT \u6b63\u5728\u5904\u7406" : "\u6269\u5c55\u6b63\u5728\u51c6\u5907\u53d1\u9001",
      detail: syncStatusReason(activeSyncJob, { heartbeat, workspace }),
      nextStep: "\u7b49\u5f85 GPT \u8fd4\u56de\uff1b\u5982\u679c\u7f51\u9875\u62a5\u9519\uff0cBridge \u4f1a\u663e\u793a\u5728\u804a\u5929\u91cc\u3002"
    };
  }

  const structuredFailure =
    pageStatus?.state === "ready" ? null : latestStructuredFailureWorkflowStatus(latestSyncJob);
  if (structuredFailure) {
    return structuredFailure;
  }

  if (extensionVersionState === "warning") {
    return {
      level: "warning",
      label: "建议重载",
      title: "Bridge 扩展可用，但不是最新版本",
      detail: "当前扩展 " + extensionVersion + "；重载到 " + EXPECTED_EXTENSION_VERSION + " 后会更稳定。",
      nextStep: "可以继续发送消息，方便时重载 Bridge 扩展。"
    };
  }

  if (preferenceStatus?.state === "applied") {
    return {
      level: "ready",
      label: "连接就绪",
      title: "Bridge 已连接",
      detail: "GPT 会话、Bridge 扩展和当前模型偏好已经对齐。",
      nextStep: "可以直接发送消息或拖入文件。"
    };
  }

  return {
    level: "ready",
    label: "同步就绪",
    title: "Bridge 已连接",
    detail: "GPT 会话和扩展已连接。",
    nextStep: "可以直接发送消息或拖入文件。"
  };
}

function syncJobAgeMs(job) {
  const timestamp = Date.parse(job?.updatedAt || job?.createdAt || "");
  if (!Number.isFinite(timestamp)) {
    return 0;
  }
  return Math.max(0, Date.now() - timestamp);
}

function syncJobSentAgeMs(job) {
  const timestamp = Date.parse(job?.sentAt || job?.updatedAt || job?.createdAt || "");
  if (!Number.isFinite(timestamp)) {
    return 0;
  }
  return Math.max(0, Date.now() - timestamp);
}

function isRunningSyncStale(job) {
  return job?.status === "running" && Boolean(job.sentAt) && syncJobSentAgeMs(job) >= RUNNING_SYNC_STALE_MS;
}

function isReadyPageSentSyncStale(job, heartbeat = null) {
  const pageStatus = heartbeat?.pageStatus || null;
  const pageReady = pageStatus?.state === "ready" || pageStatus?.code === "ready";
  const staleMs = isImageGenerationSyncJob(job) ? READY_PAGE_IMAGE_SENT_SYNC_STALE_MS : READY_PAGE_SENT_SYNC_STALE_MS;
  return (
    pageReady &&
    job?.status === "running" &&
    Boolean(job.sentAt) &&
    syncJobSentAgeMs(job) >= staleMs
  );
}

function isRetryableSyncJob(job, { heartbeat = null } = {}) {
  return job?.status === "failed" || isRunningSyncStale(job) || isReadyPageSentSyncStale(job, heartbeat);
}

function isImageGenerationSyncJob(job = null) {
  if (!job) {
    return false;
  }
  return (
    Boolean(job._bridgeImageBatchTotal) ||
    isImageGenerationText(job.payloadText || "") ||
    isImageGenerationText(job.userText || "")
  );
}

function isUnsentRunningSyncStale(job) {
  if (job?.status !== "running" || job.sentAt) {
    return false;
  }
  const claimedAtMs = timestampMs(job.claimedAt);
  if (claimedAtMs === null) {
    return syncJobAgeMs(job) >= UNSENT_RUNNING_SYNC_STALE_MS;
  }
  return Math.max(0, Date.now() - claimedAtMs) >= UNSENT_RUNNING_SYNC_STALE_MS;
}

function normalizeMessageSender(value, fallback = "user") {
  const sender = String(value || fallback || "user").trim().toLowerCase();
  return ["user", "codex"].includes(sender) ? sender : "user";
}

function isRoomMessageId(value = "") {
  return String(value || "").startsWith("roommsg_");
}

function roomRouteLabel(kind = "") {
  if (kind === "gpt_only") return "GPT";
  if (kind === "codex_only") return "Codex";
  if (kind === "gpt_then_codex") return "先 GPT，后 Codex";
  return "自动判断";
}

function publicRoomRoutePolicy(policy = null) {
  if (!policy || typeof policy !== "object") {
    return null;
  }
  return {
    id: policy.id || null,
    workType: policy.workType || null,
    primaryActor: policy.primaryActor || null,
    summary: policy.summary || "",
    principle: policy.principle || "",
    codexUsesGptResult: Boolean(policy.codexUsesGptResult),
    codexMayReanalyzeGptWork: Boolean(policy.codexMayReanalyzeGptWork),
    requiresLocalRepo: Boolean(policy.requiresLocalRepo),
    hasLocalRepo: Boolean(policy.hasLocalRepo),
    stages: Array.isArray(policy.stages)
      ? policy.stages.map((stage) => ({
          actor: stage.actor || "",
          title: stage.title || "",
          responsibility: stage.responsibility || ""
        }))
      : []
  };
}

function publicRoomRoutePreview(route = {}) {
  const targets = Array.isArray(route.targets) ? route.targets : [];
  return {
    kind: route.kind || "gpt_only",
    targets,
    syncKind: route.syncKind || null,
    label: roomRouteLabel(route.kind),
    reason: route.reason || "",
    policy: publicRoomRoutePolicy(route.policy),
    willUseGpt: targets.includes("gpt"),
    willUseCodex: targets.includes("codex") || route.kind === "gpt_then_codex"
  };
}

function publicSequentialPlan(plan = null) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.stages)) {
    return null;
  }
  return {
    id: plan.id || null,
    summary: plan.summary || "",
    currentStageIndex: Number.isFinite(Number(plan.currentStageIndex)) ? Number(plan.currentStageIndex) : 0,
    nextActionText: plan.nextActionText || null,
    stages: plan.stages.map((stage, index) => ({
      id: stage.id || "stage_" + (index + 1),
      title: stage.title || "",
      payloadText: stage.payloadText || null,
      dependsOn: stage.dependsOn || null,
      instruction: stage.instruction || null
    }))
  };
}

function publicRoomRouteResponse(route = {}) {
  return {
    ...publicRoomRoutePreview(route),
    gptPayloadText: route.gptPayloadText || null,
    sequentialPlan: publicSequentialPlan(route.sequentialPlan)
  };
}

function routeMetadataForMessage(route = {}, originalText = "", payloadText = "") {
  const sequentialPlan = publicSequentialPlan(route.sequentialPlan);
  const firstStage = sequentialPlan?.stages?.[sequentialPlan.currentStageIndex || 0] || null;
  return {
    routeKind: sequentialPlan ? "creative_sequential" : route.kind,
    routeReason: route.reason,
    routePolicy: publicRoomRoutePolicy(route.policy),
    ...(payloadText && payloadText !== originalText
      ? {
          originalRequestText: originalText,
          displayedSyncPayloadText: true
        }
      : {}),
    ...(sequentialPlan
      ? {
          sequentialPlan,
          sequentialStageId: firstStage?.id || null,
          sequentialStageIndex: sequentialPlan.currentStageIndex || 0
        }
      : {})
  };
}

function buildSequentialContinuationPayload({ plan, nextStageIndex, previousReplyText, originalRequestText, projectArtifacts = [] }) {
  const nextStage = plan?.stages?.[nextStageIndex];
  if (!nextStage) {
    return null;
  }
  const previousResult = sanitizeChatGptReferenceForCodex(previousReplyText);
  const localArtifactLines = Array.isArray(projectArtifacts) && projectArtifacts.length > 0
    ? [
        "",
        "# 上一步生成文件本地路径",
        "",
        ...projectArtifacts.map((item, index) => (index + 1) + ". " + (item.filename || "artifact") + ": " + (item.savedPath || item.projectSavedPath || ""))
      ]
    : [];
  const stageTitle = nextStage.title || "第 " + (nextStageIndex + 1) + " 步";
  const isPosterStage = /poster|cover|image|\u6d77\u62a5|\u5c01\u9762|\u751f\u6210|pic|picture/i.test(
    [nextStage.id || "", nextStage.title || "", nextStage.instruction || ""].join(" ")
  );
  const stageRules = isPosterStage
    ? [
        "- 只生成一张小说海报或封面图。",
        "- 不要重写大纲或章节正文。",
        "- 如果生成了图片，请返回真实可下载的图片。"
      ]
    : [
        "- 只完成这个阶段的文字内容。",
        "- 不要生成海报、封面或图片。",
        "- 不要提前执行后续阶段。"
      ];

  return [
    "请只完成第 " + (nextStageIndex + 1) + " 步：" + stageTitle + "。",
    "",
    "# 链路上下文",
    "",
    "用户原始需求已经由 Bridge 拆成多个阶段。当前只执行本阶段，不要重复已经完成的阶段，也不要提前处理后续阶段。",
    "",
    "# 上一步 GPT 结果",
    "",
    previousResult,
    ...localArtifactLines,
    "",
    "# 本阶段要求",
    "",
    nextStage.instruction || stageTitle,
    ...stageRules
  ]
    .filter((line) => line !== null && line !== undefined)
    .join("\n");
}

async function buildSequentialContinuation(storeRoot, before, sourceMessage, replyText, projectArtifacts = []) {
  const metadata = sourceMessage?.metadata || {};
  const plan = publicSequentialPlan(metadata.sequentialPlan);
  const currentStageIndex = Number.isFinite(Number(metadata.sequentialStageIndex))
    ? Number(metadata.sequentialStageIndex)
    : Number.isFinite(Number(plan?.currentStageIndex))
      ? Number(plan.currentStageIndex)
      : null;
  if (!plan || currentStageIndex === null) {
    return null;
  }
  const nextStageIndex = currentStageIndex + 1;
  const nextStage = plan.stages[nextStageIndex];
  if (!nextStage) {
    return null;
  }
  const originalRequestText =
    metadata.originalRequestText ||
    before.userText ||
    sourceMessage?.text ||
    before.payloadText ||
    "";
  const payloadText = buildSequentialContinuationPayload({
    plan,
    nextStageIndex,
    previousReplyText: replyText,
    originalRequestText,
    projectArtifacts
  });
  if (!payloadText) {
    return null;
  }
  const updatedPlan = {
    ...plan,
    currentStageIndex: nextStageIndex,
    nextActionText: plan.stages[nextStageIndex + 1]?.instruction || null
  };
  const message = await appendRoomMessage(storeRoot, {
    conversationId: before.conversationId,
    from: "codex",
    to: ["gpt"],
    text: payloadText,
    metadata: {
      source: "sequential_creative_chain",
      parentSyncJobId: before.id,
      parentSourceMessageId: before.sourceMessageId || null,
      originalRequestText,
      displayedSyncPayloadText: true,
      routeKind: "creative_sequential",
      sequentialPlan: updatedPlan,
      sequentialStageId: nextStage.id || null,
      sequentialStageIndex: nextStageIndex,
      sequentialPreviousStageId: metadata.sequentialStageId || null
    }
  });
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl: before.projectUrl,
    targetRepo: before.targetRepo || null,
    conversationId: before.conversationId,
    sourceMessageId: message.id,
    userText: originalRequestText,
    payloadText,
    modePreference: before.modePreference,
    modelPreference: before.modelPreference
  });
  return { message, job };
}

async function getScopedWorkspaceBinding(storeRoot, currentCodexThreadId = null) {
  const workspace = await getWorkspaceBinding(storeRoot);
  if (!currentCodexThreadId || !workspace.projectId) {
    return { workspace, scopedOut: false, outOfScopeProjectId: null };
  }

  const { projects } = await listProjects(storeRoot, { currentCodexThreadId });
  if (projects.some((project) => project.id === workspace.projectId)) {
    return { workspace, scopedOut: false, outOfScopeProjectId: null };
  }

  return {
    workspace: {
      ...workspace,
      projectId: null,
      chatgptProjectUrl: null,
      targetRepo: null,
      conversationId: null
    },
    scopedOut: true,
    outOfScopeProjectId: workspace.projectId
  };
}

function currentSessionNotBoundPayload(scopedWorkspace = {}) {
  return {
    error: "The current Codex session is not bound to this Bridge project. Bind this session before sending.",
    code: "current_session_not_bound",
    outOfScopeProjectId: scopedWorkspace.outOfScopeProjectId || null
  };
}

function isWorkspaceReadyForRoom(workspace = {}) {
  return Boolean(workspace.conversationId);
}

function artifactBelongsToWorkspace(artifact = {}, workspace = {}) {
  return Boolean(workspace.conversationId && artifact.conversationId === workspace.conversationId);
}

function artifactNotInCurrentRoomPayload() {
  return {
    error: "这个文件不属于当前 Bridge 会话。请切回对应会话或重新上传。",
    code: "artifact_not_in_current_room"
  };
}

async function getCurrentRoomArtifact(storeRoot, artifactId, workspace) {
  const artifact = await getArtifact(storeRoot, artifactId);
  if (!artifactBelongsToWorkspace(artifact, workspace)) {
    const error = new Error("Artifact does not belong to the current Bridge room");
    error.code = "artifact_not_in_current_room";
    throw error;
  }
  return artifact;
}

function syncStatusReason(job, { heartbeat = null, workspace = null } = {}) {
  if (!job) {
    return "还没有同步记录。";
  }
  if (job.status === "failed") {
    return conciseSyncFailureReason(job.error, job.errorCode);
  }
  if (Array.isArray(job.artifactErrors) && job.artifactErrors.length > 0) {
    return "有文件没有捕获成功，请让 GPT 重新生成或重新上传。";
  }
  if (job.status === "succeeded") {
    return "最近一次同步成功。";
  }
  if (job.status === "running") {
    if (isUnsentRunningSyncStale(job)) {
      return "扩展领取后一直没有发出，页面可能卡住；请刷新绑定的 GPT 页面后重试。";
    }
    if (isRunningSyncStale(job) || isReadyPageSentSyncStale(job, heartbeat)) {
      return "GPT 长时间没有返回，页面可能卡住；请刷新绑定的 GPT 页面后重试。";
    }
    return job.sentAt ? "\u5df2\u53d1\u9001\u7ed9 GPT\uff0c\u7b49\u5f85\u8fd4\u56de" : "\u6269\u5c55\u5df2\u9886\u53d6\u4efb\u52a1\uff0c\u51c6\u5907\u53d1\u9001";
  }
  if (job.status === "pending" && syncJobAgeMs(job) >= PENDING_EXTENSION_STALE_MS) {
    if (heartbeat?.connected) {
      const boundUrl = normalizedChatgptPageUrl(workspace?.chatgptProjectUrl || job.projectUrl);
      const activeUrl = normalizedChatgptPageUrl(heartbeat.href);
      if (boundUrl && activeUrl && boundUrl !== activeUrl) {
        return "扩展在线，但当前 GPT 页面不是绑定会话：" + activeUrl;
      }
      return "扩展在线，但还没有领取任务；请刷新绑定的 GPT 页面或重新加载 Bridge 扩展。";
    }
    return "扩展未连接：请打开或刷新绑定的 GPT 页面，或在 Chrome 扩展页面重新加载 Bridge 扩展。";
  }
  return "等待扩展领取任务";
}

function timestampMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function durationBetweenMs(start, end) {
  const startMs = timestampMs(start);
  const endMs = timestampMs(end);
  if (startMs === null || endMs === null || endMs < startMs) {
    return null;
  }
  return endMs - startMs;
}

function syncCompletionTime(job = {}) {
  if (!["succeeded", "failed"].includes(job.status)) {
    return null;
  }
  return job.completedAt || job.updatedAt || null;
}

function syncProgressStage(job = {}) {
  if (job.status === "succeeded") {
    return "completed";
  }
  if (job.status === "failed") {
    return "failed";
  }
  if (job.status === "running") {
    return job.sentAt ? "waiting_reply" : "sending";
  }
  return "queued";
}

function syncProgress(job, options = {}) {
  if (!job) {
    return null;
  }

  const stage = syncProgressStage(job);
  const completedAt = syncCompletionTime(job);
  const timeline = {
    createdAt: job.createdAt || null,
    claimedAt: job.claimedAt || null,
    sentAt: job.sentAt || null,
    completedAt
  };
  const durations = {
    queueMs: durationBetweenMs(timeline.createdAt, timeline.claimedAt),
    preSendMs: durationBetweenMs(timeline.claimedAt, timeline.sentAt),
    responseMs: durationBetweenMs(timeline.sentAt, timeline.completedAt),
    totalMs: durationBetweenMs(timeline.createdAt, timeline.completedAt),
    gptThoughtMs: Number.isFinite(Number(job.thoughtDurationMs)) && Number(job.thoughtDurationMs) > 0
      ? Number(job.thoughtDurationMs)
      : null
  };

  if (durations.queueMs === null && timeline.createdAt && stage === "queued") {
    durations.queueMs = durationBetweenMs(timeline.createdAt, new Date().toISOString());
  }
  if (durations.preSendMs === null && timeline.claimedAt && stage === "sending") {
    durations.preSendMs = durationBetweenMs(timeline.claimedAt, new Date().toISOString());
  }
  if (durations.responseMs === null && timeline.sentAt && stage === "waiting_reply") {
    durations.responseMs = durationBetweenMs(timeline.sentAt, new Date().toISOString());
  }

  const reason = syncStatusReason(job, options);
  const inputArtifactCount = Array.isArray(job.inputArtifacts) ? job.inputArtifacts.length : 0;
  const artifactUnitZh = inputArtifactCount > 0 ? inputArtifactCount + " 个附件" : null;
  const defaultQueuedReason = reason === "等待扩展领取任务";
  const staleSending = isUnsentRunningSyncStale(job);
  const staleWaitingReply = isRunningSyncStale(job);
  const stageCopy = {
    queued: {
      label: "等待接收",
      shortLabel: "等待 GPT 接收",
      message: !defaultQueuedReason && reason ? reason : artifactUnitZh ? "等待 GPT 页面接收 " + artifactUnitZh : "等待 GPT 页面接收任务"
    },
    sending: {
      label: "准备发送",
      shortLabel: "正在发送",
      message: staleSending && reason ? reason : artifactUnitZh ? "正在把 " + artifactUnitZh + " 交给 GPT" : "扩展已领取，正在把消息发给 GPT"
    },
    waiting_reply: {
      label: "等待回复",
      shortLabel: "等待 GPT 回复",
      message: staleWaitingReply && reason ? reason : artifactUnitZh ? "GPT 已接收 " + artifactUnitZh + "，等待分析结果" : "已发送给 GPT，等待 GPT 回复"
    },
    completed: {
      label: "已完成",
      shortLabel: "同步完成",
      message: artifactUnitZh ? "GPT 已分析 " + artifactUnitZh : "GPT 已返回，Bridge 已捕获结果"
    },
    failed: {
      label: "同步失败",
      shortLabel: "同步失败",
      message: reason || "GPT 同步失败"
    }
  }[stage];

  return {
    stage,
    ...stageCopy,
    timeline,
    durations
  };
}

function decorateSyncJob(job = null, options = {}) {
  if (!job) {
    return null;
  }
  return {
    ...job,
    progress: syncProgress(job, options)
  };
}

function syncInputArtifacts(job = {}) {
  return Array.isArray(job.inputArtifacts) ? job.inputArtifacts : [];
}

function syncInputArtifactStatus(job = {}) {
  const inputArtifacts = syncInputArtifacts(job);
  if (inputArtifacts.length === 0) {
    return null;
  }
  if (job.status === "failed") {
    return "failed";
  }
  if (job.status === "pending") {
    return "pending";
  }
  if (job.status === "running") {
    return job.sentAt ? "uploaded" : "uploading";
  }
  if (job.status === "succeeded") {
    return "analyzed";
  }
  return "pending";
}

function syncInputArtifactReason(job = {}) {
  const inputArtifacts = syncInputArtifacts(job);
  const count = inputArtifacts.length;
  if (count === 0) {
    return syncStatusReason(job);
  }
  const unit = count + " 个附件";
  const status = syncInputArtifactStatus(job);
  if (status === "failed") {
    return syncStatusReason(job) || unit + " 上传或分析失败";
  }
  if (status === "pending") {
    return "等待 GPT 页面接收 " + unit;
  }
  if (status === "uploading") {
    return "正在把 " + unit + " 交给 GPT";
  }
  if (status === "uploaded") {
    return "GPT 已接收 " + unit + "，等待分析结果";
  }
  if (status === "analyzed") {
    return "GPT 已分析 " + unit;
  }
  return syncStatusReason(job);
}

function syncInputArtifactMetadata(job = {}) {
  const inputArtifacts = syncInputArtifacts(job);
  if (inputArtifacts.length === 0) {
    return {};
  }
  return {
    syncInputArtifactCount: inputArtifacts.length,
    syncInputArtifactNames: inputArtifacts.map((artifact) => artifact.filename || artifact.id || "artifact"),
    syncInputArtifactStatus: syncInputArtifactStatus(job)
  };
}

function selectActiveSyncJob(syncJobs = []) {
  const visibleJobs = visibleSyncJobs(syncJobs);
  return (
    visibleJobs.find((job) => job.status === "running") ||
    visibleJobs.find((job) => job.status === "pending") ||
    null
  );
}

function selectRecentManualCancelledSyncJob(syncJobs = []) {
  const now = Date.now();
  return (
    syncJobs
      .filter((job) => {
        if (!job || job.status !== "failed" || job.errorCode !== "manual_cancelled") {
          return false;
        }
        if (job._bridgeRecoveryIssued) {
          return false;
        }
        const userStoppedBeforeClaim = job.errorCode === "manual_cancelled" && job.recoveryAction === "manual_stop";
        if (!job.claimedAt && !job.sentAt && !userStoppedBeforeClaim) {
          return false;
        }
        const updatedAtMs = timestampMs(job.updatedAt || job.completedAt);
        return updatedAtMs !== null && now - updatedAtMs <= MANUAL_CANCEL_STOP_RECOVERY_MS;
      })
      .sort((a, b) => (timestampMs(b.updatedAt || b.completedAt) || 0) - (timestampMs(a.updatedAt || a.completedAt) || 0))[0] ||
    null
  );
}

function selectRecentFailedBridgeSyncJob(syncJobs = []) {
  const now = Date.now();
  const recoverableErrorCodes = new Set(["manual_cancelled", "reply_timeout", "send_not_confirmed", "missing_download"]);
  return (
    syncJobs
      .filter((job) => {
        if (!job || job.status !== "failed" || !recoverableErrorCodes.has(job.errorCode)) {
          return false;
        }
        if (!job.claimedAt && !job.sentAt) {
          return false;
        }
        const updatedAtMs = timestampMs(job.updatedAt || job.completedAt);
        return updatedAtMs !== null && now - updatedAtMs <= ORPHAN_GENERATION_STOP_RECOVERY_MS;
      })
      .sort((a, b) => (timestampMs(b.updatedAt || b.completedAt) || 0) - (timestampMs(a.updatedAt || a.completedAt) || 0))[0] ||
    null
  );
}

function heartbeatShowsActiveGeneration(heartbeat = null) {
  const pageStatus = heartbeat?.pageStatus || null;
  return pageStatus?.code === "active_generation" || pageStatus?.recoveryAction === "wait_for_generation";
}

function buildWorkspacePreferences(workspace = null) {
  const preferences = normalizeChatGptPreferences(workspace || {});
  if (!workspace?.chatgptProjectUrl || (!preferences.modePreference && !preferences.modelPreference)) {
    return null;
  }
  return {
    projectUrl: workspace.chatgptProjectUrl,
    modePreference: preferences.modePreference,
    modelPreference: preferences.modelPreference,
    updatedAt: workspace.preferenceUpdatedAt || workspace.updatedAt || null
  };
}

function buildExtensionRecovery(syncJobs = [], heartbeat = null, workspace = null) {
  const job = selectActiveSyncJob(syncJobs);
  const manualCancelledJob = selectRecentManualCancelledSyncJob(syncJobs);
  const orphanFailedJob = heartbeatShowsActiveGeneration(heartbeat) && !job
    ? selectRecentFailedBridgeSyncJob(syncJobs)
    : null;
  if (!job && !manualCancelledJob && !orphanFailedJob) {
    return null;
  }

  const recoveryJob = job || manualCancelledJob || orphanFailedJob;
  const projectUrl = recoveryJob.projectUrl || workspace?.chatgptProjectUrl || null;
  if (!projectUrl) {
    return null;
  }

  if (!chatgptUrlsMatch(projectUrl, heartbeat?.href || "")) {
    return null;
  }

  if (recoveryJob._bridgeRecoveryIssued) {
    return null;
  }

  if (manualCancelledJob && heartbeatShowsActiveGeneration(heartbeat) && (!job || job.status === "pending")) {
    return {
      action: "stop_generation",
      reason: "User stopped the previous GPT job",
      projectUrl,
      job: manualCancelledJob
    };
  }

  if (manualCancelledJob && !job) {
    return {
      action: "stop_generation",
      reason: "User stopped this GPT job",
      projectUrl,
      job: manualCancelledJob
    };
  }

  if (orphanFailedJob) {
    return {
      action: "stop_generation",
      reason: "GPT page is still generating after the Bridge job ended",
      projectUrl,
      job: orphanFailedJob
    };
  }

  if (isRunningSyncStale(job) || isReadyPageSentSyncStale(job, heartbeat) || isUnsentRunningSyncStale(job)) {
    return {
      action: "reload",
      reason: job.sentAt
        ? "GPT has not returned after receiving the job"
        : "GPT page did not submit the claimed job",
      projectUrl,
      job,
      resendIfPromptMissing: !job.sentAt || !isExpectedExtensionVersion(heartbeat?.workerId || "")
    };
  }

  return null;
}

async function buildExtensionRecoveryForHeartbeat(storeRoot, syncJobs = [], heartbeat = null, workspace = null) {
  const recovery = buildExtensionRecovery(syncJobs, heartbeat, workspace);
  if (recovery?.job?.id && recovery.action === "reload") {
    await markSyncJobRecoveryIssued(storeRoot, recovery.job.id, { action: recovery.action });
    recovery.job = {
      ...recovery.job,
      _bridgeRecoveryIssued: true
    };
  }
  return recovery;
}

function withBridgeRecoveryNonce(projectUrl = "") {
  try {
    const url = new URL(projectUrl);
    url.searchParams.set("bridge_recover", String(Date.now()));
    return url.href;
  } catch {
    const separator = projectUrl.includes("?") ? "&" : "?";
    return projectUrl + separator + "bridge_recover=" + Date.now();
  }
}

function buildLegacyClaimRecoveryJob(syncJobs = [], activeUrl = "", workerId = "") {
  const job = selectActiveSyncJob(syncJobs);
  if (!job || job.status === "succeeded" || job.status === "failed") {
    return null;
  }
  if (job._bridgeRecoveryIssued || isExpectedExtensionVersion(workerId)) {
    return null;
  }

  const projectUrl = job.projectUrl || null;
  if (!projectUrl) {
    return null;
  }

  const wrongPage = !chatgptUrlsMatch(projectUrl, activeUrl);
  const staleSentJob = job.status === "running" && Boolean(job.sentAt) && isRunningSyncStale(job);
  const staleUnsentJob = isUnsentRunningSyncStale(job);
  if (wrongPage) {
    return null;
  }
  if (!wrongPage && !staleSentJob && !staleUnsentJob) {
    return null;
  }

  return {
    ...job,
    projectUrl: withBridgeRecoveryNonce(projectUrl),
    sentAt: null,
    resume: false,
    error: null,
    _bridgeRecoveryAction: "reload",
    _bridgeResendIfPromptMissing: true
  };
}

function gptVisibleStatusObject(status) {
  if (!status || typeof status !== "object") {
    return status || null;
  }
  return {
    ...status,
    label: gptVisibleText(status.label),
    title: gptVisibleText(status.title),
    detail: gptVisibleText(status.detail),
    nextStep: gptVisibleText(status.nextStep),
    message: gptVisibleText(status.message),
    reason: gptVisibleText(status.reason)
  };
}

function gptVisibleHeartbeat(heartbeat) {
  if (!heartbeat || typeof heartbeat !== "object") {
    return heartbeat || null;
  }
  return {
    ...heartbeat,
    pageStatus: gptVisibleStatusObject(heartbeat.pageStatus)
  };
}

async function buildDiagnosticsSnapshot({
  storeRoot,
  runnerMode,
  currentCodexThreadId,
  extensionSourceDir = DEFAULT_CHROME_EXTENSION_DIR
}) {
  const workspace = await getWorkspaceBinding(storeRoot);
  const syncJobs = await listSyncJobs(storeRoot);
  const workspaceSyncJobs = syncJobsForWorkspace(syncJobs, workspace);
  const userVisibleSyncJobs = visibleSyncJobs(workspaceSyncJobs);
  const artifacts = await listArtifacts(storeRoot);
  const messages = await listRoomMessages(storeRoot, {
    conversationId: workspace.conversationId
  });
  const heartbeats = await listExtensionHeartbeats(storeRoot, { includeDisconnected: true });
  const heartbeat = selectExtensionHeartbeat(heartbeats, workspace) || (await getExtensionHeartbeat(storeRoot));
  const latestSyncJob = userVisibleSyncJobs[0] || null;
  const activeSyncJob = selectActiveSyncJob(workspaceSyncJobs);
  const latestArtifact = artifacts[0] || null;
  const workerId = heartbeat?.workerId || activeSyncJob?.workerId || latestSyncJob?.workerId || null;
  const extensionVersion = extensionVersionFromWorkerId(workerId);
  const projectMatches = extensionProjectMatches(workspace, heartbeat);
  const workflowStatus = buildWorkflowStatus({
    workspace,
    heartbeat,
    extensionVersion,
    projectMatches,
    activeSyncJob,
    latestSyncJob
  });
  const connection = buildConnectionStatus({
    workspace,
    heartbeat,
    extensionVersion,
    projectMatches,
    activeSyncJob
  });
  const dataCoverage = buildDataCoverageStatus({
    workspace,
    syncJobs: workspaceSyncJobs,
    artifacts,
    messages
  });
  const routeCoverage = buildRouteCoverageStatus({
    workspace,
    syncJobs: workspaceSyncJobs,
    artifacts,
    messages
  });
  const syncCounts = workspaceSyncJobs.reduce(
    (counts, job) => ({
      ...counts,
      [job.status]: (counts[job.status] || 0) + 1
    }),
    {}
  );

  const latestSyncJobWithProgress = decorateSyncJob(latestSyncJob, { heartbeat, workspace });
  const activeSyncJobWithProgress = decorateSyncJob(activeSyncJob, { heartbeat, workspace });
  const visibleWorkflowStatus = gptVisibleStatusObject(workflowStatus);
  const visibleHeartbeat = gptVisibleHeartbeat(heartbeat);
  const idleStatus =
    visibleWorkflowStatus?.level === "blocked"
      ? {
          state: "blocked",
          reason:
            [visibleWorkflowStatus.title, visibleWorkflowStatus.detail].filter(Boolean).join("; ") ||
            visibleWorkflowStatus.label
        }
      : {
          state: "idle",
          reason: "暂无同步记录。"
        };

  return {
    workspace,
    runnerMode,
    currentCodexThreadId,
    latestSyncJob: latestSyncJobWithProgress,
    activeSyncJob: activeSyncJobWithProgress,
    latestArtifact,
    artifactCount: artifacts.length,
    syncCounts,
    workflowStatus: visibleWorkflowStatus,
    connection,
    dataCoverage,
    routeCoverage,
    extension: {
      workerId,
      version: extensionVersion,
      expectedVersion: EXPECTED_EXTENSION_VERSION,
      sourceDir: extensionSourceDir,
      needsReload: extensionNeedsReload(extensionVersion),
      projectMatches,
      expectedHref: workspace?.chatgptProjectUrl || null,
      heartbeat: visibleHeartbeat,
      pageStatus: visibleHeartbeat?.pageStatus || null,
      connected: Boolean(visibleHeartbeat?.connected),
      href: visibleHeartbeat?.href || null,
      title: visibleHeartbeat?.title || null
    },
    status: {
      state: activeSyncJob?.status || idleStatus.state,
      reason: gptVisibleText(
        activeSyncJobWithProgress?.progress?.message ||
          (activeSyncJob
            ? syncStatusReason(activeSyncJob, {
                heartbeat,
                workspace
              })
            : null) ||
          idleStatus.reason
      )
    }
  };
}

function gptPreflightAction(snapshot = {}) {
  const { workflowStatus = {}, connection = {}, extension = {}, activeSyncJob = null } = snapshot;
  const extensionVersionCheck = connection.checks?.find((check) => check.id === "extension-version");
  if (connection.canSendToGpt !== false) {
    return workflowStatus.level === "warning" ? "send_allowed_with_warning" : "send";
  }
  if (!snapshot.workspace?.chatgptProjectUrl) {
    return "bind_chatgpt_project";
  }
  if (extension.needsReload && extensionVersionCheck?.state === "blocked") {
    return "reload_extension";
  }
  if (extension.projectMatches === false || workflowStatus.id === "page-mismatch" || workflowStatus.label === "Page mismatch") {
    return "open_bound_chat";
  }
  if (["human_verification", "account_selection"].includes(extension.pageStatus?.code)) {
    return "manual_chatgpt_action";
  }
  if (extension.pageStatus?.code === "client_blocked") {
    return "disable_client_blocker";
  }
  if (["conversation_unavailable", "start_page"].includes(extension.pageStatus?.code)) {
    return "rebind_chatgpt_project";
  }
  if (extension.pageStatus?.code === "generation_failed") {
    return "retry_or_new_chat";
  }
  if (activeSyncJob) {
    return "wait_active_sync";
  }
  if (extension.connected === false) {
    return "open_bound_chat";
  }
  return "check_bridge_status";
}

function buildGptPreflight(snapshot = {}) {
  const workflowStatus = snapshot.workflowStatus || {};
  const connection = snapshot.connection || {};
  const canSend = connection.canSendToGpt !== false;
  const action = gptPreflightAction(snapshot);
  const title = gptVisibleText(workflowStatus.title || connection.label || "GPT 状态");
  const detail = gptVisibleText(workflowStatus.detail || connection.checks?.find((check) => check.state !== "passed")?.detail || "");
  const nextStep = gptVisibleText(workflowStatus.nextStep || "");
  const message = canSend
    ? workflowStatus.level === "warning"
      ? (title + "；允许发送。" + (nextStep || "")).trim()
      : "GPT 已就绪，可以发送。"
    : title + "；" + (nextStep || detail || "请先处理 GPT 页面或 Bridge 扩展状态。");

  return {
    canSend,
    level: canSend && workflowStatus.level === "warning" ? "warning" : canSend ? "ready" : "blocked",
    action,
    message,
    detail,
    nextStep,
    workflowStatus,
    connection,
    extension: snapshot.extension || null,
    activeSyncJob: snapshot.activeSyncJob || null
  };
}

function buildGptSendBlock(snapshot = {}) {
  const connection = snapshot.connection || {};
  const extension = snapshot.extension || {};
  const workflowStatus = snapshot.workflowStatus || {};
  const checks = Array.isArray(connection.checks) ? connection.checks : [];
  const checkById = (id) => checks.find((check) => check.id === id);
  const extensionVersionCheck = checkById("extension-version");
  const boundPageCheck = checkById("bound-page");
  const pageStateCheck = checkById("page-state");

  if (extensionVersionCheck?.state === "blocked" && hasExplicitExtensionVersion(extension.workerId || "")) {
    return {
      status: 409,
      code: "extension_needs_reload",
      error: "Bridge 扩展版本过旧，请先在 Chrome 扩展管理页重新加载 Bridge 扩展。",
      action: "reload_extension",
      workflowStatus,
      connection
    };
  }

  if (boundPageCheck?.state === "blocked" || extension.projectMatches === false) {
    return {
      status: 409,
      code: "bound_chat_mismatch",
      error: "当前 GPT 页面不是这个项目绑定的会话，请先切回绑定会话。",
      action: "open_bound_chat",
      workflowStatus,
      connection
    };
  }

  if (pageStateCheck?.state === "blocked") {
    return {
      status: 409,
      code: extension.pageStatus?.code || "chatgpt_page_not_ready",
      error: gptVisibleText(workflowStatus.detail || pageStateCheck.detail) || "GPT 页面当前不能接收任务，请先处理页面状态。",
      action: gptPreflightAction(snapshot),
      workflowStatus,
      connection
    };
  }

  return null;
}

function decorateRoomMessagesWithSyncState(messages = [], syncJobs = [], options = {}) {
  const jobsBySourceMessage = new Map();
  for (const job of syncJobs) {
    if (job.sourceMessageId && !jobsBySourceMessage.has(job.sourceMessageId)) {
      jobsBySourceMessage.set(job.sourceMessageId, job);
    }
  }

  return messages.map((message) => {
    const job = jobsBySourceMessage.get(message.id);
    if (!job) return message;
    const progress = syncProgress(job);
    const shouldDisplayPayload =
      job.payloadText &&
      job.payloadText !== message.text &&
      (message.from === "codex" ||
        message.metadata?.source === "current_codex_thread" ||
        message.metadata?.source === "image_batch_continuation" ||
        message.metadata?.routeKind === "creative_sequential" ||
        message.metadata?.routeKind === "gpt_then_codex" ||
        message.metadata?.routePolicy?.workType === "sequential_creative_chain");
    return {
      ...message,
      text: shouldDisplayPayload ? job.payloadText : message.text,
      metadata: {
        ...(message.metadata || {}),
        ...(shouldDisplayPayload
          ? {
              originalRequestText: message.metadata?.originalRequestText || message.text,
              displayedSyncPayloadText: true
            }
          : {}),
        syncJobId: job.id,
        syncStatus: job.status,
        syncReason: progress?.message || syncInputArtifactReason(job),
        syncProgress: progress,
        syncDurationTotalMs: progress?.durations?.totalMs ?? null,
        syncCanRetry: isRetryableSyncJob(job, options),
        syncCanCancel: job.status === "pending" || job.status === "running",
        syncSentAt: job.sentAt,
        syncUpdatedAt: job.updatedAt,
        syncErrorCode: job.errorCode || null,
        syncRecoveryAction: job.recoveryAction || null,
        ...syncInputArtifactMetadata(job)
      }
    };
  });
}

function normalizeInputArtifactIds(value = []) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
}

async function loadInputArtifacts(storeRoot, artifactIds = [], workspace = null) {
  const artifacts = [];
  for (const artifactId of artifactIds) {
    const artifact = workspace
      ? await getCurrentRoomArtifact(storeRoot, artifactId, workspace)
      : await getArtifact(storeRoot, artifactId);
    artifacts.push(buildInputArtifactDescriptor(artifact));
  }
  return artifacts;
}

function buildInputArtifactDescriptor(artifact) {
  const encodedId = encodeURIComponent(artifact.id);
  return {
    id: artifact.id,
    filename: artifact.filename,
    contentType: artifact.contentType || "application/octet-stream",
    sizeBytes: artifact.sizeBytes || 0,
    contentHashSha256: artifact.contentHashSha256 || null,
    downloadUrl: "/api/artifacts/" + encodedId + "/download",
    uploadUrl: "/api/artifacts/" + encodedId + "/raw"
  };
}

function buildComposerAttachmentPayload(text = "", inputArtifacts = []) {
  const trimmedText = String(text || "").trim() || "Please analyze the uploaded attachment.";
  if (!inputArtifacts.length) {
    return trimmedText;
  }

  return [
    trimmedText,
    "",
    attachmentGroundingInstruction(),
    "",
    "Attachments:",
    ...inputArtifacts.map(
      (artifact, index) =>
        (index + 1) + ". " + artifact.filename + " (" + (artifact.contentType || "application/octet-stream") + ", " + (artifact.sizeBytes || 0) + " bytes)"
    )
  ].join("\n");
}

function attachmentGroundingInstruction() {
  return "Judge only from the attachment itself. Do not treat the prompt or extra requirements as observed facts. If something is unclear or uncertain, say so explicitly.";
}

async function queueArtifactForGptAnalysis(storeRoot, { workspace, artifact, note, modePreference, modelPreference, from }) {
  const trimmedNote = note?.trim();
  const sender = normalizeMessageSender(from);
  const reusableJob = await findReusableGptFileAnalysis(storeRoot, { artifact, note: trimmedNote });
  const messageText = [
    "Ask GPT to analyze file: " + artifact.filename,
    trimmedNote ? "Additional requirement: " + trimmedNote : null
  ]
    .filter(Boolean)
    .join("\n");
  const message = await appendRoomMessage(storeRoot, {
    conversationId: workspace.conversationId,
    from: sender,
    to: ["gpt"],
    text: messageText,
    metadata: {
      artifactId: artifact.id,
      inputArtifactIds: [artifact.id],
      source: "local_file",
      initiatedBy: sender,
      ...(reusableJob
        ? {
            syncStatus: "succeeded",
            syncReason: "已复用 GPT 已有分析结果",
            syncJobId: reusableJob.id,
            syncCanRetry: false
          }
        : {})
    }
  });
  if (reusableJob) {
    return {
      message,
      syncJob: reusableJob,
      cached: true,
      reusedSyncJobId: reusableJob.id,
      finalJob: reusableJob,
      timedOut: false,
      replyText: sanitizeVisibleChatGptReply(reusableJob.replyText, reusableJob)
    };
  }

  const inputArtifacts = [buildInputArtifactDescriptor(artifact)];
  const syncJob = await createSyncJob(storeRoot, {
    kind: "codex_file_analysis",
    projectUrl: workspace.chatgptProjectUrl,
    targetRepo: workspace.targetRepo,
    conversationId: workspace.conversationId,
    userText: messageText,
    payloadText: [
      "Please analyze the uploaded file.",
      "File name: " + artifact.filename,
      "File type: " + (artifact.contentType || "application/octet-stream"),
      "File size: " + (artifact.sizeBytes || 0) + " bytes",
      attachmentGroundingInstruction(),
      "",
      trimmedNote || "Summarize the file content, assess quality, and suggest the next step."
    ].join("\n"),
    resultCacheKey: buildGptFileAnalysisCacheKey({ artifact, note: trimmedNote }),
    modePreference,
    modelPreference,
    sourceMessageId: message.id,
    inputArtifacts
  });

  return {
    message,
    syncJob,
    cached: false,
    reusedSyncJobId: null
  };
}

async function queueLocalFileForGptAnalysis(storeRoot, body, workspace) {
  const artifactInput = {
    filename: body.filename,
    contentType: body.contentType,
    originalUrl: body.originalUrl || "codex-local-file",
    syncJobId: null,
    conversationId: body.conversationId || workspace.conversationId || null,
    sourceMessageId: body.sourceMessageId || null
  };
  const artifact = body.base64Data
    ? await saveArtifactFromBase64(storeRoot, {
        ...artifactInput,
        base64Data: body.base64Data
      })
    : await saveArtifactFromLocalFile(storeRoot, {
        ...artifactInput,
        localPath: body.localPath
      });
  const queued = await queueArtifactForGptAnalysis(storeRoot, {
    workspace,
    artifact,
    note: body.note,
    modePreference: body.modePreference,
    modelPreference: body.modelPreference,
    from: body.from || body.actor
  });

  return {
    artifact,
    ...queued
  };
}

function staticPathFor(urlPath) {
  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const resolved = path.resolve(PUBLIC_DIR, relative);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    return null;
  }
  return resolved;
}

async function serveStatic(requestUrl, response) {
  const filePath = staticPathFor(requestUrl.pathname);
  if (!filePath) {
    sendText(response, 403, "Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    const contentType = MIME_TYPES.get(path.extname(filePath)) || "application/octet-stream";
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store"
    });
    response.end(body);
  } catch {
    sendText(response, 404, "Not found");
  }
}

async function handleApi(request, response, options) {
  const requestUrl = new URL(request.url, "http://127.0.0.1");
  const parts = requestUrl.pathname.split("/").filter(Boolean);
  const storeRoot = options.storeRoot;
  const currentCodexThreadId = options.currentCodexThreadId || null;
  const extensionSourceDir = options.extensionSourceDir || DEFAULT_CHROME_EXTENSION_DIR;

  if (request.method === "GET" && requestUrl.pathname === "/api/config") {
    sendJson(response, 200, {
      runnerMode: options.runnerMode,
      autoExecutesCodex: options.runnerMode === "codex",
      currentCodexThreadId,
      expectedExtensionVersion: EXPECTED_EXTENSION_VERSION,
      extensionSourceDir,
      storeRoot
    });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/local-files/analyze-with-gpt") {
    const body = await readJsonBody(request);
    const workspace = await getWorkspaceBinding(storeRoot);
    if (!workspace.chatgptProjectUrl) {
      sendJson(response, 409, {
        error: "GPT 会话未绑定。"
      });
      return;
    }

    sendJson(response, 201, await queueLocalFileForGptAnalysis(storeRoot, body, workspace));
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/local-files/analyze-with-gpt-and-wait") {
    const body = await readJsonBody(request);
    const workspace = await getWorkspaceBinding(storeRoot);
    if (!workspace.chatgptProjectUrl) {
      sendJson(response, 409, {
        error: "GPT 会话未绑定。"
      });
      return;
    }

    const queued = await queueLocalFileForGptAnalysis(storeRoot, body, workspace);
    const waited = await waitForSyncJobResult(storeRoot, queued.syncJob.id, {
      timeoutMs: body.timeoutMs,
      pollMs: body.pollMs,
      timeoutGraceMs: body.timeoutGraceMs ?? body.graceMs,
      failOnTimeout: body.failOnTimeout ?? true
    });

    sendJson(response, 201, {
      ...queued,
      ...waited
    });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/delegate/current-request") {
    const body = await readJsonBody(request);
    const tools = createBridgeTools({
      storeRoot,
      runnerMode: options.runnerMode,
      currentCodexThreadId
    });
    sendJson(
      response,
      201,
      await tools.delegateCurrentRequest({
        waitForGpt: false,
        ...body
      })
    );
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/extension/heartbeat") {
    const body = await readJsonBody(request);
    const heartbeat = await saveExtensionHeartbeat(storeRoot, body);
    const [workspace, syncJobs] = await Promise.all([getWorkspaceBinding(storeRoot), listSyncJobs(storeRoot)]);
    const workspaceSyncJobs = syncJobsForWorkspace(syncJobs, workspace);
    const currentVersion = extensionVersionFromWorkerId(heartbeat.workerId);
    const pageMatchesWorkspace = extensionProjectMatches(workspace, heartbeat);
    const canControlPage = heartbeatCanControlWorkspace(heartbeat, workspace);
    const shouldAskExtensionReload =
      hasExplicitExtensionVersion(heartbeat.workerId) && extensionNeedsReload(currentVersion) && pageMatchesWorkspace !== false;
    const shouldSendPreferences =
      canControlPage && !preferenceStatusAppliedForWorkspace(heartbeat.preferenceStatus, workspace);
    sendJson(response, 200, {
      heartbeat,
      controlsCurrentPage: canControlPage,
      projectUrl: canControlPage ? workspace.chatgptProjectUrl : null,
      expectedExtensionVersion: EXPECTED_EXTENSION_VERSION,
      reloadExtension: shouldAskExtensionReload,
      preferences: shouldSendPreferences ? buildWorkspacePreferences(workspace) : null,
      recovery: canControlPage ? await buildExtensionRecoveryForHeartbeat(storeRoot, workspaceSyncJobs, heartbeat, workspace) : null
    });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/diagnostics/status") {
    sendJson(
      response,
      200,
      await buildDiagnosticsSnapshot({
        storeRoot,
        runnerMode: options.runnerMode,
        currentCodexThreadId,
        extensionSourceDir
      })
    );
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/gpt/preflight") {
    const snapshot = await buildDiagnosticsSnapshot({
      storeRoot,
      runnerMode: options.runnerMode,
      currentCodexThreadId,
      extensionSourceDir
    });
    sendJson(response, 200, buildGptPreflight(snapshot));
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/acceptance/status") {
    const workspace = await getWorkspaceBinding(storeRoot);
    const [syncJobs, artifacts, messages, heartbeats] = await Promise.all([
      listSyncJobs(storeRoot),
      listArtifacts(storeRoot),
      listRoomMessages(storeRoot, {
        conversationId: workspace.conversationId
      }),
      listExtensionHeartbeats(storeRoot, { includeDisconnected: true })
    ]);
    const heartbeat = selectExtensionHeartbeat(heartbeats, workspace) || (await getExtensionHeartbeat(storeRoot));
    const workerId = heartbeat?.workerId || syncJobsForWorkspace(syncJobs, workspace)[0]?.workerId || null;
    const acceptanceExtension = buildAcceptanceExtensionSnapshot({
      heartbeats,
      heartbeat,
      workerId,
      workspace
    });

    sendJson(
      response,
      200,
      buildAcceptanceStatus({
        workspace,
        syncJobs,
        artifacts,
        messages,
        extension: acceptanceExtension
      })
    );
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/acceptance/report") {
    const workspace = await getWorkspaceBinding(storeRoot);
    const [syncJobs, artifacts, messages, heartbeats] = await Promise.all([
      listSyncJobs(storeRoot),
      listArtifacts(storeRoot),
      listRoomMessages(storeRoot, {
        conversationId: workspace.conversationId
      }),
      listExtensionHeartbeats(storeRoot, { includeDisconnected: true })
    ]);
    const heartbeat = selectExtensionHeartbeat(heartbeats, workspace) || (await getExtensionHeartbeat(storeRoot));
    const workerId = heartbeat?.workerId || syncJobsForWorkspace(syncJobs, workspace)[0]?.workerId || null;
    const acceptanceExtension = buildAcceptanceExtensionSnapshot({
      heartbeats,
      heartbeat,
      workerId,
      workspace
    });
    const acceptance = buildAcceptanceStatus({
      workspace,
      syncJobs,
      artifacts,
      messages,
      extension: acceptanceExtension
    });

    sendText(response, 200, buildAcceptanceReport(acceptance), "text/markdown; charset=utf-8");
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/acceptance/real-browser-record") {
    const workspace = await getWorkspaceBinding(storeRoot);
    const [syncJobs, artifacts, messages, heartbeats] = await Promise.all([
      listSyncJobs(storeRoot),
      listArtifacts(storeRoot),
      listRoomMessages(storeRoot, {
        conversationId: workspace.conversationId
      }),
      listExtensionHeartbeats(storeRoot, { includeDisconnected: true })
    ]);
    const heartbeat = selectExtensionHeartbeat(heartbeats, workspace) || (await getExtensionHeartbeat(storeRoot));
    const workerId = heartbeat?.workerId || syncJobsForWorkspace(syncJobs, workspace)[0]?.workerId || null;
    const acceptanceExtension = buildAcceptanceExtensionSnapshot({
      heartbeats,
      heartbeat,
      workerId,
      workspace
    });
    const acceptance = buildAcceptanceStatus({
      workspace,
      syncJobs,
      artifacts,
      messages,
      extension: acceptanceExtension
    });

    sendText(
      response,
      200,
      renderRealBrowserAcceptanceRecord({
        acceptance,
        workspace,
        syncJobs,
        artifacts,
        messages,
        generatedAt: new Date().toISOString(),
        bridgeUrl: "http://" + (request.headers.host || "127.0.0.1:4317") + "/"
      }),
      "text/markdown; charset=utf-8"
    );
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/workspace") {
    sendJson(response, 200, await getWorkspaceBinding(storeRoot));
    return;
  }

  if (request.method === "PATCH" && requestUrl.pathname === "/api/workspace") {
    const body = await readJsonBody(request);
    sendJson(response, 200, await updateWorkspaceBinding(storeRoot, body));
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/preferences/sync") {
    const body = await readJsonBody(request);
    const workspace = await updateWorkspaceBinding(storeRoot, {
      modePreference: body.modePreference,
      modelPreference: body.modelPreference
    });

    if (!workspace.chatgptProjectUrl) {
      sendJson(response, 409, {
        error: "GPT 会话未绑定。"
      });
      return;
    }

    sendJson(response, 201, {
      workspace,
      preferences: buildWorkspacePreferences(workspace),
      syncJob: null
    });
    return;
  }

  if (parts[0] === "api" && parts[1] === "projects") {
    if (request.method === "GET" && parts.length === 2) {
      const workspace = await getWorkspaceBinding(storeRoot);
      const importedProject = await ensureProjectForWorkspace(storeRoot, workspace, { currentCodexThreadId });
      if (importedProject && workspace.projectId !== importedProject.id) {
        await updateWorkspaceBinding(storeRoot, {
          projectId: importedProject.id,
          chatgptProjectUrl: importedProject.chatgptProjectUrl,
          targetRepo: importedProject.targetRepo,
          conversationId: importedProject.conversationId
        });
      }
      sendJson(response, 200, await listProjects(storeRoot, { currentCodexThreadId }));
      return;
    }

    if (request.method === "POST" && parts.length === 2) {
      const body = await readJsonBody(request);
      const project = await createProject(storeRoot, {
        ...body,
        currentCodexThreadId: body.currentCodexThreadId || currentCodexThreadId
      });
      sendJson(response, 201, { project });
      return;
    }

    if (request.method === "POST" && parts[2] === "current-session" && parts.length === 3) {
      if (!currentCodexThreadId) {
        sendJson(response, 409, {
          error: "Current Codex thread id is required to bind this session"
        });
        return;
      }
      const body = await readJsonBody(request);
      const bound = await bindCurrentSessionProject(
        storeRoot,
        {
          ...body,
          currentCodexThreadId
        },
        {
          currentCodexThreadId
        }
      );
      sendJson(response, bound.created ? 201 : 200, bound);
      return;
    }

    if (request.method === "PATCH" && parts[2] && parts.length === 3) {
      const body = await readJsonBody(request);
      sendJson(response, 200, {
        project: await updateProject(storeRoot, parts[2], body)
      });
      return;
    }

    if (request.method === "DELETE" && parts[2] && parts.length === 3) {
      sendJson(response, 200, await deleteProject(storeRoot, parts[2]));
      return;
    }

    if (request.method === "POST" && parts[2] && parts[3] === "select") {
      sendJson(response, 200, await selectProject(storeRoot, parts[2]));
      return;
    }
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/chat/messages") {
    sendJson(response, 200, await listChatMessages(storeRoot));
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/room/route-preview") {
    const body = await readJsonBody(request);
    const { workspace } = await getScopedWorkspaceBinding(storeRoot, currentCodexThreadId);
    const messageText = String(body.text || "").trim();
    const attachmentCount = Number.isFinite(Number(body.attachmentCount)) ? Number(body.attachmentCount) : 0;
    const routeDecision = decideRoomRoute({
      text: messageText,
      workspace,
      attachmentCount
    });
    sendJson(response, 200, publicRoomRoutePreview(routeDecision));
    return;
  }

  if (parts[0] === "api" && parts[1] === "room" && parts[2] === "messages") {
    const scopedWorkspace = await getScopedWorkspaceBinding(storeRoot, currentCodexThreadId);
    const workspace = scopedWorkspace.workspace;

    if (request.method === "GET") {
      const [syncJobs, heartbeats] = await Promise.all([
        listSyncJobs(storeRoot),
        listExtensionHeartbeats(storeRoot, { includeDisconnected: true })
      ]);
      if (scopedWorkspace.scopedOut || !workspace.conversationId) {
        sendJson(response, 200, { messages: [] });
        return;
      }
      const heartbeat = selectExtensionHeartbeat(heartbeats, workspace);
      const messages = await listRoomMessages(storeRoot, {
        conversationId: workspace.conversationId
      });
      sendJson(response, 200, {
        messages: decorateRoomMessagesWithSyncState(messages, syncJobs, { heartbeat })
      });
      return;
    }

    if (request.method === "DELETE" && parts[3] && parts.length === 4) {
      sendJson(response, 200, await hideRoomMessage(storeRoot, parts[3]));
      return;
    }

    if (request.method === "DELETE" && parts.length === 3) {
      sendJson(response, 200, await clearRoomMessages(storeRoot, {
        conversationId: workspace.conversationId
      }));
      return;
    }

    if (request.method === "POST") {
      if (scopedWorkspace.scopedOut) {
        sendJson(response, 409, {
          error: "The current Codex session is not bound to this Bridge project. Bind this session before sending.",
          code: "current_session_not_bound",
          outOfScopeProjectId: scopedWorkspace.outOfScopeProjectId
        });
        return;
      }
      const body = await readJsonBody(request);
      let inputArtifacts = [];
      try {
        inputArtifacts = await loadInputArtifacts(storeRoot, normalizeInputArtifactIds(body.inputArtifactIds), workspace);
      } catch (error) {
        if (error.code === "artifact_not_in_current_room") {
          sendJson(response, 409, artifactNotInCurrentRoomPayload());
          return;
        }
        throw error;
      }
      const messageText = String(body.text || "").trim() || (inputArtifacts.length ? "Please analyze the uploaded attachment." : "");
      try {
        assertTextIntegrity(messageText);
      } catch (error) {
        sendJson(response, 400, {
          error: error.message,
          code: error.code || "text_integrity_failed"
        });
        return;
      }
      const requestedTargets = Array.isArray(body.to) ? body.to : [body.to || "auto"];
      const useAutoRoute = requestedTargets.length === 0 || requestedTargets.includes("auto");
      const routeDecision = useAutoRoute
        ? decideRoomRoute({
            text: messageText,
            workspace,
            attachmentCount: inputArtifacts.length
          })
        : {
            kind: "manual",
            targets: requestedTargets.filter((target) => ["gpt", "codex"].includes(target)),
            syncKind: inputArtifacts.length ? "codex_file_analysis" : "chat_message",
            gptPayloadText: messageText,
            codexPromptText: null,
            reason: "The user manually selected the target."
          };
      const to = routeDecision.targets.length > 0 ? routeDecision.targets : ["gpt"];
      const clientMetadata =
        body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata) ? body.metadata : {};
      const gptPayloadText = inputArtifacts.length
        ? buildComposerAttachmentPayload(routeDecision.gptPayloadText || messageText, inputArtifacts)
        : routeDecision.gptPayloadText || messageText;
      if (to.includes("gpt") && workspace.chatgptProjectUrl) {
        const gptSnapshot = await buildDiagnosticsSnapshot({
          storeRoot,
          runnerMode: options.runnerMode,
          currentCodexThreadId,
          extensionSourceDir
        });
        const gptBlock = buildGptSendBlock(gptSnapshot);
        if (gptBlock) {
          sendJson(response, gptBlock.status, gptBlock);
          return;
        }
      }
      const message = await appendRoomMessage(storeRoot, {
        conversationId: workspace.conversationId,
        from: "user",
        to,
        text: messageText,
        metadata: {
          ...clientMetadata,
          ...(inputArtifacts.length
            ? {
                inputArtifactIds: inputArtifacts.map((artifact) => artifact.id),
                inputArtifactNames: inputArtifacts.map((artifact) => artifact.filename),
                source: clientMetadata.source || "composer_attachments"
              }
            : {}),
          targetRepo: workspace.targetRepo,
          chatgptProjectUrl: workspace.chatgptProjectUrl,
          ...routeMetadataForMessage(routeDecision, messageText, gptPayloadText)
        }
      });

      let syncJob = null;
      if (to.includes("gpt") && workspace.chatgptProjectUrl) {
        syncJob = await createSyncJob(storeRoot, {
          kind: inputArtifacts.length ? "codex_file_analysis" : routeDecision.syncKind || "chat_message",
          projectUrl: workspace.chatgptProjectUrl,
          targetRepo: workspace.targetRepo,
          conversationId: workspace.conversationId,
          userText: messageText,
          payloadText: gptPayloadText,
          modePreference: body.modePreference,
          modelPreference: body.modelPreference,
          sourceMessageId: message.id,
          inputArtifacts
        });
      }

      let codexTask = null;
      let codexRelay = null;
      let codexRelayMessage = null;
      if (to.includes("codex")) {
        codexTask = await createCodexTask(storeRoot, {
          conversationId: workspace.conversationId,
          sourceMessageId: message.id,
          currentThreadId: body.currentCodexThreadId || currentCodexThreadId,
          targetRepo: workspace.targetRepo,
          promptText: routeDecision.codexPromptText || [
            "# User message from the room",
            "",
            messageText,
            "",
            "# Execution context for Codex",
            "Target project directory: " + (workspace.targetRepo || "not specified"),
            "",
            "You are the Codex member in this room. Handle this message in the current Codex thread. If files need to be changed or commands need to be run, do it directly, then write the result back to the room."
          ].join("\n")
        });

        const relay = options.codexRelay;
        if (relay) {
          try {
            codexRelay = await relay.relayCodexTask(codexTask);
          } catch (error) {
            codexRelay = {
              status: "failed",
              error: error.message
            };
          }

          if (codexRelay?.status !== "sent") {
            codexRelayMessage = await appendRoomMessage(storeRoot, {
              conversationId: workspace.conversationId,
              from: "codex",
              to: ["user"],
              text: [
                "Codex 连接失败，消息已经保存在本地待处理队列里。",
                "",
                "原因：" + (codexRelay?.error || codexRelay?.reason || "未知错误"),
                "",
                "请确认 Codex app-server relay 正在运行后再试。"
              ].join("\n"),
              metadata: {
                codexTaskId: codexTask.id,
                relayStatus: codexRelay?.status || "unknown"
              }
            });
          }
        }
      }

      sendJson(response, 201, {
        message,
        route: publicRoomRouteResponse(routeDecision),
        syncJob,
        codexTask,
        codexRelay,
        codexRelayMessage
      });
      return;
    }
  }

  if (parts[0] === "api" && parts[1] === "current-codex") {
    if (request.method === "POST" && parts[2] === "claim") {
      const body = await readJsonBody(request);
      sendJson(response, 200, {
        task: await claimNextCodexTask(storeRoot, {
          currentThreadId: body.currentThreadId || currentCodexThreadId,
          workerId: body.workerId || "current-codex-thread"
        })
      });
      return;
    }

    if (request.method === "POST" && parts[2] && parts[3] === "complete") {
      const body = await readJsonBody(request);
      sendJson(response, 200, {
        ...(await completeRoomCodexTaskWithMessage(storeRoot, parts[2], body))
      });
      return;
    }

    if (request.method === "POST" && parts[2] && parts[3] === "fail") {
      const body = await readJsonBody(request);
      sendJson(response, 200, {
        task: await failCodexTask(storeRoot, parts[2], body)
      });
      return;
    }
  }

  if (parts[0] === "api" && parts[1] === "artifacts") {
    const scopedWorkspace = await getScopedWorkspaceBinding(storeRoot, currentCodexThreadId);
    const workspace = scopedWorkspace.workspace;
    const allowUnscopedArtifactAccess = !currentCodexThreadId && !workspace.conversationId;

    if (request.method === "GET" && parts.length === 2) {
      if (scopedWorkspace.scopedOut || (!isWorkspaceReadyForRoom(workspace) && !allowUnscopedArtifactAccess)) {
        sendJson(response, 200, { artifacts: [] });
        return;
      }
      const artifacts = await listArtifacts(storeRoot, {
        syncJobId: requestUrl.searchParams.get("syncJobId") || undefined,
        conversationId: workspace.conversationId || requestUrl.searchParams.get("conversationId") || undefined
      });
      sendJson(response, 200, {
        artifacts: await withProjectCopyMetadata(storeRoot, artifacts)
      });
      return;
    }

    if (request.method === "POST" && parts[2] === "import" && parts.length === 3) {
      if (scopedWorkspace.scopedOut || (!isWorkspaceReadyForRoom(workspace) && !allowUnscopedArtifactAccess)) {
        sendJson(response, 409, currentSessionNotBoundPayload(scopedWorkspace));
        return;
      }
      const body = await readJsonBody(request);
      const artifactInput = {
        filename: body.filename,
        contentType: body.contentType,
        originalUrl: body.originalUrl || "codex-local-file",
        syncJobId: body.syncJobId || null,
        conversationId: workspace.conversationId || body.conversationId || null,
        sourceMessageId: body.sourceMessageId || null
      };
      const artifact = body.base64Data
        ? await saveArtifactFromBase64(storeRoot, {
            ...artifactInput,
            base64Data: body.base64Data
          })
        : await saveArtifactFromLocalFile(storeRoot, {
            ...artifactInput,
            localPath: body.localPath
          });

      sendJson(response, 201, { artifact });
      return;
    }

    async function currentArtifact() {
      if (allowUnscopedArtifactAccess) {
        return getArtifact(storeRoot, parts[2]);
      }
      return getCurrentRoomArtifact(storeRoot, parts[2], workspace);
    }

    async function withCurrentArtifact(fn) {
      if (scopedWorkspace.scopedOut || (!isWorkspaceReadyForRoom(workspace) && !allowUnscopedArtifactAccess)) {
        sendJson(response, 409, currentSessionNotBoundPayload(scopedWorkspace));
        return true;
      }
      try {
        await fn(await currentArtifact());
      } catch (error) {
        if (error.code === "artifact_not_in_current_room") {
          sendJson(response, 409, artifactNotInCurrentRoomPayload());
          return true;
        }
        throw error;
      }
      return true;
    }

    if (request.method === "GET" && parts[2] && parts.length === 3) {
      await withCurrentArtifact(async (artifact) => {
        const [artifactWithMetadata] = await withProjectCopyMetadata(storeRoot, [artifact]);
        sendJson(response, 200, artifactWithMetadata);
      });
      return;
    }

    if (request.method === "GET" && parts[2] && parts[3] === "text") {
      await withCurrentArtifact(async () => {
        const maxChars = Number.parseInt(requestUrl.searchParams.get("maxChars") || "200000", 10);
        sendJson(
          response,
          200,
          await readArtifactText(storeRoot, parts[2], {
            maxChars: Number.isFinite(maxChars) ? maxChars : 200_000
          })
        );
      });
      return;
    }

    if (request.method === "GET" && parts[2] && parts[3] === "preview") {
      await withCurrentArtifact(async (artifact) => {
        const full = requestUrl.searchParams.get("full") === "1";
        sendJson(response, 200, await buildArtifactPreview(artifact, { full }));
      });
      return;
    }

    if (request.method === "POST" && parts[2] && parts[3] === "save-as") {
      await withCurrentArtifact(async (artifact) => {
        const saveAs = options.saveArtifactAs || saveArtifactWithNativeDialog;
        sendJson(response, 200, await saveAs(artifact));
      });
      return;
    }

    if (request.method === "GET" && parts[2] && parts[3] === "view") {
      await withCurrentArtifact(async (artifact) => {
        const body = await readFile(artifact.filePath);
        sendBinary(response, 200, body, {
          "Content-Type": artifact.contentType || "application/octet-stream",
          "Content-Disposition": contentDisposition("inline", artifact.filename || "download")
        });
      });
      return;
    }

    if (request.method === "GET" && parts[2] && parts[3] === "raw") {
      await withCurrentArtifact(async (artifact) => {
        const body = await readFile(artifact.filePath);
        sendBinary(response, 200, body, {
          "Content-Type": artifact.contentType || "application/octet-stream"
        });
      });
      return;
    }

    if (request.method === "GET" && parts[2] && parts[3] === "download") {
      await withCurrentArtifact(async (artifact) => {
        const body = await readFile(artifact.filePath);
        sendBinary(response, 200, body, {
          "Content-Type": artifact.contentType || "application/octet-stream",
          "Content-Disposition": contentDisposition("attachment", artifact.filename || "download")
        });
      });
      return;
    }

    if (request.method === "POST" && parts[2] && parts[3] === "save-to-project") {
      const body = await readJsonBody(request);
      await withCurrentArtifact(async () => {
        const saved = await saveArtifactToProject(
          storeRoot,
          parts[2],
          body.targetRepo || workspace.targetRepo
        );
        sendJson(response, 200, saved);
      });
      return;
    }

    if (request.method === "POST" && parts[2] && parts[3] === "analyze-with-gpt") {
      const body = await readJsonBody(request);
      if (!workspace.chatgptProjectUrl) {
        sendJson(response, 409, {
          error: "GPT 会话未绑定。"
        });
        return;
      }

      await withCurrentArtifact(async (artifact) => {
        const note = body.note?.trim();
        const messageText = [
          "请 GPT 分析文件：" + artifact.filename,
          note ? "补充要求：" + note : null
        ]
          .filter(Boolean)
          .join("\n");
        const message = await appendRoomMessage(storeRoot, {
          conversationId: workspace.conversationId,
          from: "user",
          to: ["gpt"],
          text: messageText,
          metadata: {
            artifactId: artifact.id,
            inputArtifactIds: [artifact.id],
            source: "artifact_library"
          }
        });
        const inputArtifacts = [buildInputArtifactDescriptor(artifact)];
        const syncJob = await createSyncJob(storeRoot, {
          kind: "codex_file_analysis",
          projectUrl: workspace.chatgptProjectUrl,
          targetRepo: workspace.targetRepo,
          conversationId: workspace.conversationId,
          userText: messageText,
          payloadText: [
            "请分析我上传的文件。",
            "文件名：" + artifact.filename,
            "文件类型：" + (artifact.contentType || "application/octet-stream"),
            "文件大小：" + (artifact.sizeBytes || 0) + " bytes",
            attachmentGroundingInstruction(),
            "",
            note ? "补充要求：" + note : "请总结文件内容，判断质量，并建议下一步。"
          ].join("\n"),
          modePreference: body.modePreference,
          modelPreference: body.modelPreference,
          sourceMessageId: message.id,
          inputArtifacts
        });

        sendJson(response, 201, {
          message,
          syncJob
        });
      });
      return;
    }

    if (request.method === "POST" && parts[2] && parts[3] === "analyze-with-codex") {
      const body = await readJsonBody(request);
      await withCurrentArtifact(async (artifact) => {
        const note = body.note?.trim();
        const messageText = [
          "请 Codex 分析 GPT 文件：" + artifact.filename,
          "文件路径：" + artifact.filePath,
          note ? "补充要求：" + note : null
        ]
          .filter(Boolean)
          .join("\n");
        const message = await appendRoomMessage(storeRoot, {
          conversationId: workspace.conversationId,
          from: "user",
          to: ["codex"],
          text: messageText,
          metadata: {
            artifactId: artifact.id,
            targetRepo: workspace.targetRepo,
            source: "artifact_library"
          }
        });
        const codexTask = await createCodexTask(storeRoot, {
          conversationId: workspace.conversationId,
          sourceMessageId: message.id,
          currentThreadId: body.currentCodexThreadId || currentCodexThreadId,
          targetRepo: workspace.targetRepo,
          promptText: [
            "# Codex 文件分析任务",
            "",
            "文件名：" + artifact.filename,
            "文件路径：" + artifact.filePath,
            "文件类型：" + (artifact.contentType || "application/octet-stream"),
            "文件大小：" + (artifact.sizeBytes || 0) + " bytes",
            "目标项目目录：" + (workspace.targetRepo || "未指定"),
            "",
            note ? "用户补充要求：" + note : "用户补充要求：无",
            "",
            "请读取并分析这个 GPT 生成的文件。需要时可以打开或检查文件，并给出后处理建议。除非用户明确要求，不要修改项目文件。最后把结论写回 Bridge 房间。"
          ].join("\n")
        });

        let codexRelay = null;
        let codexRelayMessage = null;
        const relay = options.codexRelay;
        if (relay) {
          try {
            codexRelay = await relay.relayCodexTask(codexTask);
          } catch (error) {
            codexRelay = {
              status: "failed",
              error: error.message
            };
          }

          if (codexRelay?.status !== "sent") {
            codexRelayMessage = await appendRoomMessage(storeRoot, {
              conversationId: workspace.conversationId,
              from: "codex",
              to: ["user"],
              text: [
                "Codex 连接失败，文件分析任务已经保存在本地待处理队列里。",
                "",
                "原因：" + (codexRelay?.error || codexRelay?.reason || "未知错误")
              ].join("\n"),
              metadata: {
                codexTaskId: codexTask.id,
                artifactId: artifact.id,
                relayStatus: codexRelay?.status || "unknown"
              }
            });
          }
        }

        sendJson(response, 201, {
          message,
          codexTask,
          codexRelay,
          codexRelayMessage
        });
      });
      return;
    }
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/downloads/import") {
    const body = await readJsonBody(request);
    const syncJob = body.syncJobId ? await getSyncJob(storeRoot, body.syncJobId) : null;
    const artifactInput = {
      filename: body.filename,
      contentType: body.contentType,
      originalUrl: body.originalUrl,
      syncJobId: syncJob?.id || body.syncJobId || null,
      conversationId: syncJob?.conversationId || body.conversationId || null,
      sourceMessageId: syncJob?.sourceMessageId || body.sourceMessageId || null
    };
    const artifact = body.base64Data
      ? await saveArtifactFromBase64(storeRoot, {
          ...artifactInput,
          base64Data: body.base64Data
        })
      : await saveArtifactFromLocalFile(storeRoot, {
          ...artifactInput,
          localPath: body.localPath
        });

    sendJson(response, 201, { artifact });
    return;
  }

  if (parts[0] === "api" && parts[1] === "codex-inbox") {
    if (request.method === "GET" && parts.length === 2) {
      sendJson(response, 200, await listInboxItems(storeRoot));
      return;
    }

    if (request.method === "POST" && parts.length === 2) {
      const body = await readJsonBody(request);
      sendJson(response, 201, {
        item: await createInboxItem(storeRoot, body)
      });
      return;
    }

    if (request.method === "POST" && parts[2] === "next") {
      const body = await readJsonBody(request);
      sendJson(response, 200, {
        item: await claimNextInboxItem(storeRoot, body)
      });
      return;
    }

    if (parts[2] && request.method === "POST" && parts[3] === "complete") {
      const body = await readJsonBody(request);
      const before = await getInboxItem(storeRoot, parts[2]);
      const item = await completeInboxItem(storeRoot, parts[2], body);
      const resultMessage = await appendChatMessage(storeRoot, {
        role: "assistant",
        kind: "codex_result",
        text: [
          "Completed.",
          "",
          body.resultText?.trim() || "No execution result was provided."
        ].join("\n"),
        metadata: {
          conversationId: before.conversationId,
          inboxItemId: item.id,
          source: "current_codex_thread"
        }
      });

      let resultSyncJob = null;
      if (body.syncToChatGpt && before.projectUrl) {
        resultSyncJob = await createSyncJob(storeRoot, {
          kind: "codex_result",
          projectUrl: before.projectUrl,
          conversationId: before.conversationId,
          taskId: before.taskId || null,
          sourceMessageId: resultMessage.id,
          payloadText: [
            "# Codex execution result",
            "",
            body.resultText?.trim() || "Codex did not provide an execution result.",
            "",
            "Analyze whether this execution completed the goal. If more work is needed, give the next Codex instruction."
          ].join("\n")
        });
      }

      sendJson(response, 200, {
        item,
        resultMessage,
        resultSyncJob
      });
      return;
    }

    if (parts[2] && request.method === "POST" && parts[3] === "fail") {
      const body = await readJsonBody(request);
      sendJson(response, 200, {
        item: await failInboxItem(storeRoot, parts[2], body)
      });
      return;
    }
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/sync/jobs/claim") {
    const body = await readJsonBody(request);
    if (hasExplicitExtensionVersion(body.workerId) && !isCompatibleExtensionVersion(body.workerId)) {
      sendJson(response, 200, {
        job: null,
        resume: false,
        error: "Bridge extension needs reload"
      });
      return;
    }
    const claimedJob = await claimNextSyncJob(storeRoot, body);
    const activeUrl = body.projectUrl || body.href || "";
    const job =
      buildLegacyClaimRecoveryJob(claimedJob ? [claimedJob] : [], activeUrl, body.workerId) ||
      claimedJob ||
      buildLegacyClaimRecoveryJob(await listSyncJobs(storeRoot), activeUrl, body.workerId);
    sendJson(response, 200, {
      job,
      resume: Boolean(job?.resume)
    });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/chat/turns") {
    const body = await readJsonBody(request);
    const turn = await createChatTurn(storeRoot, body);

    if (body.run !== false && turn.task) {
      await runTask(storeRoot, turn.task.id, {
        runnerMode: options.runnerMode
      });
      turn.task = await getTask(storeRoot, turn.task.id);
      const resultText = await readTaskResult(storeRoot, turn.task.id);
      turn.resultMessage = await appendChatMessage(storeRoot, {
        role: "assistant",
        kind: "codex_result",
        text: [
          "Codex 执行状态：" + turn.task.status,
          "",
          resultText.trim() ? resultText.trim().slice(0, 1600) : "暂时还没有执行结果。"
        ].join("\n"),
        metadata: {
          taskId: turn.task.id,
          status: turn.task.status
        }
      });
    }

    sendJson(response, 201, turn);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/chat/replies") {
    const body = await readJsonBody(request);
    const imported = await importChatGptReply(storeRoot, body);

    if (body.run && imported.task) {
      await runTask(storeRoot, imported.task.id, {
        runnerMode: options.runnerMode
      });
      imported.task = await getTask(storeRoot, imported.task.id);
    }

    sendJson(response, 201, imported);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/tasks") {
    sendJson(response, 200, await listTasks(storeRoot));
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/tasks") {
    const body = await readJsonBody(request);
    const task = await createTask(storeRoot, {
      title: body.title,
      prompt: body.prompt,
      targetRepo: body.targetRepo,
      source: body.source || "api"
    });

    if (body.run) {
      await runTask(storeRoot, task.id, {
        runnerMode: options.runnerMode
      });
      sendJson(response, 201, await getTask(storeRoot, task.id));
      return;
    }

    sendJson(response, 201, task);
    return;
  }

  if (parts[0] === "api" && parts[1] === "tasks" && parts[2]) {
    const taskId = parts[2];

    if (request.method === "GET" && parts.length === 3) {
      const task = await getTask(storeRoot, taskId);
      const events = await readTaskEvents(storeRoot, taskId);
      const promptText = await readFile(task.promptPath, "utf8");
      sendJson(response, 200, { ...task, promptText, events });
      return;
    }

    if (request.method === "GET" && parts[3] === "result") {
      sendJson(response, 200, {
        taskId,
        text: await readTaskResult(storeRoot, taskId)
      });
      return;
    }

    if (request.method === "POST" && parts[3] === "run") {
      const result = await runTask(storeRoot, taskId, {
        runnerMode: options.runnerMode
      });
      sendJson(response, 200, {
        task: await getTask(storeRoot, taskId),
        result
      });
      return;
    }

    if (request.method === "POST" && parts[3] === "revisions") {
      const original = await getTask(storeRoot, taskId);
      const body = await readJsonBody(request);
      const revision = await createTask(storeRoot, {
        title: "修订：" + original.title,
        prompt: [
          "修订之前的 Bridge 任务：" + original.id,
          "",
          body.prompt?.trim() || "请检查上一次结果，并提出下一步稳妥修改。"
        ].join("\n"),
        targetRepo: original.targetRepo,
        source: "revision"
      });
      sendJson(response, 201, revision);
      return;
    }
  }

  if (parts[0] === "api" && parts[1] === "sync" && parts[2] === "jobs" && parts[3]) {
    const jobId = parts[3];
    const workspace = await getWorkspaceBinding(storeRoot);

    if (request.method === "GET" && !parts[4]) {
      sendJson(response, 200, {
        job: await getSyncJob(storeRoot, jobId)
      });
      return;
    }

    if (request.method === "POST" && parts[4] === "cancel") {
      const before = await getSyncJob(storeRoot, jobId);
      if (!syncJobMatchesWorkspace(before, workspace)) {
        sendJson(response, 404, {
          error: "Sync job not found in the current workspace"
        });
        return;
      }
      if (before.status === "succeeded" || before.status === "failed") {
        sendJson(response, 409, {
          error: "Only pending or running GPT sync jobs can be cancelled"
        });
        return;
      }

      const job = await failSyncJob(storeRoot, jobId, {
        error: "Stopped manually by user",
        errorCode: "manual_cancelled",
        recoveryAction: "manual_stop"
      });
      sendJson(response, 200, {
        job
      });
      return;
    }

    if (request.method === "POST" && parts[4] === "sent") {
      const body = await readJsonBody(request);
      sendJson(response, 200, {
        job: await markSyncJobSent(storeRoot, jobId, body)
      });
      return;
    }

    if (request.method === "POST" && parts[4] === "pre-send-refresh") {
      const body = await readJsonBody(request);
      sendJson(response, 200, {
        job: await markSyncJobPreSendRefresh(storeRoot, jobId, body)
      });
      return;
    }

    if (request.method === "POST" && parts[4] === "complete") {
      const body = await readJsonBody(request);
      const before = await getSyncJob(storeRoot, jobId);
      if (before.status === "succeeded" || before.status === "failed") {
        sendJson(response, 409, {
          error: "GPT sync job is no longer active",
          code: "sync_job_not_active",
          job: before
        });
        return;
      }
      const artifacts = [];
      const importedArtifactIds = Array.isArray(body.artifactIds)
        ? body.artifactIds.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim())
        : [];
      let artifactErrors = Array.isArray(body.artifactErrors) ? [...body.artifactErrors] : [];
      if (Array.isArray(body.artifacts)) {
        for (const artifactInput of body.artifacts) {
          try {
            validateCapturedArtifactInput(artifactInput);
            artifacts.push(
              await saveArtifactFromBase64(storeRoot, {
                ...artifactInput,
                syncJobId: before.id,
                conversationId: before.conversationId,
                sourceMessageId: before.sourceMessageId
              })
            );
          } catch (error) {
            artifactErrors.push({
              filename: artifactInput?.filename || null,
              originalUrl: artifactInput?.originalUrl || null,
              code: "invalid_artifact_capture",
              error: error.message
            });
          }
        }
      }
      const requestedArtifactIds = [...new Set([...importedArtifactIds, ...artifacts.map((artifact) => artifact.id)])];
      const currentArtifacts = requestedArtifactIds.length > artifacts.length
        ? await loadArtifactsByIds(storeRoot, requestedArtifactIds)
        : artifacts;
      const artifactIds = currentArtifacts.map((artifact) => artifact.id);
      const resolvedArtifactIdSet = new Set(artifactIds);
      for (const artifactId of importedArtifactIds) {
        if (!resolvedArtifactIdSet.has(artifactId)) {
          artifactErrors.push({
            artifactId,
            filename: null,
            originalUrl: null,
            code: "invalid_artifact_reference",
            error: "Bridge 收到的 artifactId 不存在，或没有对应的真实本地文件。"
          });
        }
      }
      artifactErrors = filterArtifactErrorsForCapturedArtifacts(artifactErrors, currentArtifacts);
      const requirementArtifactIds = before.kind === "image_request"
        ? currentArtifacts.filter(isImageArtifactLike).map((artifact) => artifact.id)
        : artifactIds;
      artifactErrors.push(...inferMissingArtifactErrors(body.replyText || "", requirementArtifactIds, artifactErrors, before));
      if (shouldFailForMissingArtifactCapture(before, body.replyText || "", requirementArtifactIds, artifactErrors)) {
        const error = missingArtifactFailureMessage(artifactErrors);
        const visibleErrorText = visibleSyncFailureText(error, "missing_download");
        const job = await failSyncJob(storeRoot, jobId, {
          error,
          errorCode: "missing_download",
          replyText: body.replyText,
          artifactIds,
          artifactErrors,
          thoughtDurationMs: body.thoughtDurationMs,
          failureDetails: {
            artifactErrors
          }
        });
        const chatgptMessage = await appendChatMessage(storeRoot, {
          role: "chatgpt",
          kind: "chatgpt_error",
          text: visibleErrorText,
          metadata: {
            conversationId: before.conversationId,
            syncJobId: job.id,
            syncStatus: "failed",
            error: job.error,
            syncErrorCode: job.errorCode || null,
            artifactErrors,
            source: "chatgpt_project"
          }
        });
        let roomMessage = null;
        if (before.kind === "chat_message" || before.sourceMessageId) {
          roomMessage = await appendRoomMessage(storeRoot, {
            conversationId: before.conversationId,
            from: "gpt",
            to: ["user"],
            text: visibleErrorText,
            metadata: {
              syncJobId: job.id,
              syncStatus: "failed",
              error: job.error,
              syncErrorCode: job.errorCode || null,
              artifactIds,
              artifactErrors,
              sourceMessageId: before.sourceMessageId || null,
              source: "chatgpt_project"
            }
          });
        }
        sendJson(response, 200, {
          job,
          chatgptMessage,
          task: null,
          resultMessage: null,
          resultSyncJob: null,
          inboxItem: null,
          roomMessage,
          artifacts
        });
        return;
      }
      const cleanedReplyText = stripChatGptReplyWrapper(body.replyText || "");
      const isImageBatchContinuation =
        before._bridgeImageBatchParentJobId ||
        Number(before._bridgeImageBatchAttempt || 0) > 0;
      if (before.kind !== "preference_sync" && !cleanedReplyText && artifactIds.length === 0 && artifactErrors.length === 0) {
        sendJson(response, 409, {
          error: "GPT reply is empty or still streaming",
          code: "empty_chatgpt_reply"
        });
        return;
      }
      if (
        before.kind !== "preference_sync" &&
        cleanedReplyText &&
        artifactIds.length === 0 &&
        artifactErrors.length === 0 &&
        !isImageBatchContinuation &&
        looksLikeInterimChatGptReply(cleanedReplyText)
      ) {
        sendJson(response, 409, {
          error: "GPT reply is still streaming or interrupted",
          code: "interim_chatgpt_reply"
        });
        return;
      }
      const imageBatchArtifactIds = await collectImageBatchArtifactIds(storeRoot, before, artifactIds);
      const visibleArtifactIds = imageBatchArtifactIds.length > 0 ? imageBatchArtifactIds : artifactIds;
      const visibleArtifacts = imageBatchArtifactIds.length > 0 ? await loadArtifactsByIds(storeRoot, imageBatchArtifactIds) : currentArtifacts;
      const projectArtifactSave = await saveCapturedArtifactsToProject(
        storeRoot,
        visibleArtifactIds,
        before.targetRepo || workspace.targetRepo
      );
      const job = await completeSyncJob(storeRoot, jobId, {
        replyText: body.replyText,
        artifactIds: visibleArtifactIds,
        artifactErrors,
        projectArtifacts: projectArtifactSave.projectArtifacts,
        projectArtifactErrors: projectArtifactSave.projectArtifactErrors,
        thoughtDurationMs: body.thoughtDurationMs
      });
      if (before.kind === "preference_sync") {
        sendJson(response, 200, {
          job,
          chatgptMessage: null,
          task: null,
          resultMessage: null,
          resultSyncJob: null,
          inboxItem: null,
          roomMessage: null,
          artifacts
        });
        return;
      }
      const visibleReplyText =
        imageBatchArtifactIds.length > 0 && visibleArtifacts.length === imageBatchArtifactIds.length && visibleArtifacts.every(isImageArtifactLike)
          ? "已捕获 " + visibleArtifacts.length + " 张图片"
          : summarizeVisibleReplyWithArtifacts(sanitizeVisibleChatGptReply(body.replyText, before), visibleArtifacts, body.replyText, before);
      const chatgptMessage = await appendChatMessage(storeRoot, {
        role: "chatgpt",
        kind: "chatgpt_reply",
        text: visibleReplyText,
        metadata: {
          conversationId: before.conversationId,
          syncJobId: job.id,
          source: "chatgpt_project",
          artifactIds: visibleArtifactIds,
          projectArtifacts: projectArtifactSave.projectArtifacts,
          projectArtifactErrors: projectArtifactSave.projectArtifactErrors
        }
      });
      let roomMessage = null;
      if (before.kind === "chat_message" || before.sourceMessageId) {
        roomMessage = await appendRoomMessage(storeRoot, {
          conversationId: before.conversationId,
          from: "gpt",
          to: ["user"],
          text: visibleReplyText,
          metadata: {
            syncJobId: job.id,
            artifactIds: visibleArtifactIds,
            artifactErrors,
            projectArtifacts: projectArtifactSave.projectArtifacts,
            projectArtifactErrors: projectArtifactSave.projectArtifactErrors,
            sourceMessageId: before.sourceMessageId || null,
            source: "chatgpt_project",
            imageBatchParentJobId: before._bridgeImageBatchParentJobId || null,
            imageBatchCapturedTotal: imageBatchArtifactIds.length || null
          }
        });
      }

      const sourceRoomMessages = before.sourceMessageId
        ? await listRoomMessages(storeRoot, {
            conversationId: before.conversationId || workspace.conversationId,
            includeHidden: true
          })
        : [];
      const sourceRoomMessage = sourceRoomMessages.find((message) => message.id === before.sourceMessageId);
      const sequentialContinuation = before.projectUrl && sourceRoomMessage
        ? await buildSequentialContinuation(
            storeRoot,
            before,
            sourceRoomMessage,
            body.replyText,
            projectArtifactSave.projectArtifacts
          )
        : null;
      const sequentialContinuationMessage = sequentialContinuation?.message || null;
      const sequentialContinuationJob = sequentialContinuation?.job || null;

      let imageContinuationMessage = null;
      let imageContinuationJob = null;
      const imageContinuation = buildImageBatchContinuation(before, artifactIds);
      if (imageContinuation && before.projectUrl) {
        imageContinuationMessage = await appendRoomMessage(storeRoot, {
          conversationId: before.conversationId,
          from: "codex",
          to: ["gpt"],
          text: imageContinuation.promptText,
          metadata: {
            source: "image_batch_continuation",
            parentSyncJobId: before.id,
            requestedTotal: imageContinuation.requestedTotal,
            capturedTotal: imageContinuation.capturedTotal,
            remaining: imageContinuation.remaining
          }
        });
        imageContinuationJob = await createSyncJob(storeRoot, {
          kind: "chat_message",
          projectUrl: before.projectUrl,
          targetRepo: before.targetRepo || null,
          conversationId: before.conversationId,
          sourceMessageId: imageContinuationMessage.id,
          userText: imageContinuation.promptText,
          payloadText: imageContinuation.promptText,
          modePreference: before.modePreference,
          modelPreference: before.modelPreference,
          _bridgeImageBatchTotal: imageContinuation.requestedTotal,
          _bridgeImageBatchCaptured: imageContinuation.capturedTotal,
          _bridgeImageBatchAttempt: imageContinuation.attempt,
          _bridgeImageBatchOriginalText: imageContinuation.originalText,
          _bridgeImageBatchParentJobId: before.id
        });
      }

      let task = null;
      let resultMessage = null;
      let resultSyncJob = null;
      let inboxItem = null;
      let codexRelay = null;
      let codexRelayMessage = null;

      if (before.kind === "user_request") {
        const codexInstruction = before.userText || body.replyText.trim();
        const chatGptReference = sanitizeChatGptReferenceForCodex(body.replyText);
        const localArtifactLines = projectArtifactSave.projectArtifacts.length > 0
          ? [
              "",
              "# GPT 生成文件本地路径",
              "",
              ...projectArtifactSave.projectArtifacts.map((item, index) => (index + 1) + ". " + item.filename + ": " + item.savedPath)
            ]
          : [];
        const codexHandoffPrompt = [
          "# 用户原始请求",
          "",
          codexInstruction,
          "",
          "# GPT 上游结果",
          "",
          chatGptReference,
          ...localArtifactLines,
          "",
          "# GPT 结果消费规则",
          "",
          "默认使用 GPT 的分析、设计、文案、图片或文件生成结果。不要重新看图、重写文案或重做设计判断来复核 GPT。",
          "只做低成本验收：确认附件或文件存在、格式可打开、路径和关键约束匹配，必要时运行本地验证命令。",
          "只有 GPT 输出缺失、文件损坏、明显违背用户要求，或用户明确要求复核时，才二次分析。",
          "",
          "# Codex 执行要求",
          "目标项目目录：" + (before.targetRepo || "未指定"),
          "",
          "请由当前 Codex 对话线程按用户原始请求执行。对于本地文件、命令、项目修改或运行结果，不要相信 GPT 声称已经完成本地文件操作；需要你实际检查、创建、修改或验证。完成后把实际修改、验证命令、剩余风险写回本地桥；只有用户确认时才同步给 GPT。"
        ].join("\n");

        inboxItem = await createInboxItem(storeRoot, {
          source: "chatgpt_project",
          projectUrl: before.projectUrl,
          targetRepo: before.targetRepo || null,
          syncJobId: before.id,
          conversationId: before.conversationId,
          sourceMessageId: chatgptMessage.id,
          promptText: codexHandoffPrompt
        });

        if (isRoomMessageId(before.sourceMessageId) && roomMessage) {
          task = await createCodexTask(storeRoot, {
            conversationId: before.conversationId,
            sourceMessageId: roomMessage.id,
            currentThreadId: currentCodexThreadId,
            targetRepo: before.targetRepo || null,
            promptText: codexHandoffPrompt
          });

          const relay = options.codexRelay;
          if (relay) {
            try {
              codexRelay = await relay.relayCodexTask(task);
            } catch (error) {
              codexRelay = {
                status: "failed",
                error: error.message
              };
            }

            if (codexRelay?.status !== "sent") {
              codexRelayMessage = await appendRoomMessage(storeRoot, {
                conversationId: before.conversationId,
                from: "codex",
                to: ["user"],
                text: [
                  "Codex 连接失败，GPT 结果已经保存为本地待处理任务。",
                  "",
                  "原因：" + (codexRelay?.error || codexRelay?.reason || "未知错误"),
                  "",
                  "请确认当前 Codex 线程 relay 正在运行后再试。"
                ].join("\n"),
                metadata: {
                  codexTaskId: task.id,
                  syncJobId: before.id,
                  relayStatus: codexRelay?.status || "unknown",
                  source: "gpt_then_codex_handoff"
                }
              });
            }
          }
        }
      }

      sendJson(response, 200, {
        job,
        chatgptMessage,
        task,
        resultMessage,
        resultSyncJob,
        inboxItem,
        codexRelay,
        codexRelayMessage,
        roomMessage,
        sequentialContinuationMessage,
        sequentialContinuationJob,
        imageContinuationMessage,
        imageContinuationJob,
        artifacts
      });
      return;
    }

    if (request.method === "POST" && parts[4] === "fail") {
      const body = normalizeSyncFailureBody(await readJsonBody(request));
      const before = await getSyncJob(storeRoot, jobId);
      const visibleErrorText = visibleSyncFailureText(body.error, body.errorCode);
      const job = await failSyncJob(storeRoot, jobId, body);
      if (job.status !== "failed") {
        sendJson(response, 200, {
          job,
          chatgptMessage: null,
          roomMessage: null
        });
        return;
      }
      const chatgptMessage = await appendChatMessage(storeRoot, {
        role: "chatgpt",
        kind: "chatgpt_error",
        text: visibleErrorText,
        metadata: {
          conversationId: before.conversationId,
          syncJobId: job.id,
          syncStatus: "failed",
          error: job.error,
          syncErrorCode: job.errorCode || null,
          syncRecoveryAction: job.recoveryAction || null,
          source: "chatgpt_project"
        }
      });
      let roomMessage = null;
      if (before.kind === "chat_message" || before.sourceMessageId) {
        roomMessage = await appendRoomMessage(storeRoot, {
          conversationId: before.conversationId,
          from: "gpt",
          to: ["user"],
          text: visibleErrorText,
          metadata: {
            syncJobId: job.id,
            syncStatus: "failed",
            error: job.error,
            syncErrorCode: job.errorCode || null,
            syncRecoveryAction: job.recoveryAction || null,
            sourceMessageId: before.sourceMessageId || null,
            source: "chatgpt_project"
          }
        });
      }

      sendJson(response, 200, {
        job,
        chatgptMessage,
        roomMessage
      });
      return;
    }

    if (request.method === "POST" && parts[4] === "retry") {
      const body = await readJsonBody(request);
      const before = await getSyncJob(storeRoot, jobId);
      const gptSnapshot = await buildDiagnosticsSnapshot({
        storeRoot,
        runnerMode: options.runnerMode,
        currentCodexThreadId,
        extensionSourceDir
      });
      if (!isRetryableSyncJob(before, { heartbeat: gptSnapshot.extension?.heartbeat })) {
        sendJson(response, 409, {
          error: "Only failed or stale GPT sync jobs can be retried"
        });
        return;
      }

      if (!before.projectUrl && !workspace.chatgptProjectUrl) {
        sendJson(response, 409, {
          error: "GPT 会话未绑定。"
        });
        return;
      }

      const gptBlock = buildGptSendBlock(gptSnapshot);
      if (gptBlock) {
        sendJson(response, gptBlock.status, gptBlock);
        return;
      }

      const retryText = before.userText || before.payloadText;
      const sourceMessages = before.sourceMessageId
        ? await listRoomMessages(storeRoot, {
            conversationId: before.conversationId || workspace.conversationId
          })
        : [];
      const sourceMessage = sourceMessages.find((message) => message.id === before.sourceMessageId);
      const retryFrom = normalizeMessageSender(sourceMessage?.from);
      const retryMetadata = {
        targetRepo: before.targetRepo || workspace.targetRepo,
        chatgptProjectUrl: before.projectUrl || workspace.chatgptProjectUrl,
        retryOfSyncJobId: before.id
      };
      if (Array.isArray(before.inputArtifacts) && before.inputArtifacts.length > 0) {
        retryMetadata.inputArtifactIds = before.inputArtifacts.map((artifact) => artifact.id).filter(Boolean);
      }
      if (before.kind === "codex_file_analysis") {
        retryMetadata.source = "local_file";
      }
      if (retryFrom !== "user") {
        retryMetadata.initiatedBy = retryFrom;
      }
      if (before.status !== "failed") {
        await failSyncJob(storeRoot, before.id, {
          error: "Retried after GPT stopped responding"
        });
      }
      const message = await appendRoomMessage(storeRoot, {
        conversationId: before.conversationId || workspace.conversationId,
        from: retryFrom,
        to: ["gpt"],
        text: retryText,
        metadata: retryMetadata
      });

      const syncJob = await createSyncJob(storeRoot, {
        kind: before.kind || "chat_message",
        projectUrl: before.projectUrl || workspace.chatgptProjectUrl,
        targetRepo: before.targetRepo || workspace.targetRepo,
        conversationId: before.conversationId || workspace.conversationId,
        userText: before.userText || retryText,
        payloadText: before.payloadText,
        modePreference: body.modePreference || before.modePreference,
        modelPreference: body.modelPreference || before.modelPreference,
        inputArtifacts: before.inputArtifacts,
        sourceMessageId: message.id,
        taskId: before.taskId || null
      });

      sendJson(response, 201, {
        message,
        syncJob,
        retriedSyncJobId: before.id
      });
      return;
    }
  }

  sendJson(response, 404, { error: "API route not found" });
}

export function createHttpServer(options = {}) {
  const env = options.env || process.env;
  const storeRoot = resolveBridgeDataDir({
    storeRoot: options.storeRoot,
    env,
    cwd: options.cwd || process.cwd()
  });
  const extensionSourceDir = resolveBridgeExtensionDir({
    extensionSourceDir: options.extensionSourceDir,
    env,
    packageRoot: PACKAGE_ROOT
  });
  const runnerMode = options.runnerMode || env.BRIDGE_RUNNER || "manual";
  const currentCodexThreadId =
    options.currentCodexThreadId || env.BRIDGE_CURRENT_CODEX_THREAD_ID || null;
  const codexRelay =
    options.codexRelay ||
    (env.BRIDGE_CODEX_APP_RELAY === "1"
      ? {
          relayCodexTask: (task) =>
            relayCodexTaskToThread(task, {
              appServerUrl: env.BRIDGE_CODEX_APP_SERVER_URL || "ws://127.0.0.1:43219",
              bridgeBaseUrl:
                env.BRIDGE_BASE_URL ||
                "http://" + (env.BRIDGE_HOST || "127.0.0.1") + ":" + (env.BRIDGE_PORT || "4317")
            })
        }
      : null);

  return createServer(async (request, response) => {
    try {
      if (request.method === "OPTIONS") {
        sendText(response, 204, "");
        return;
      }
      const requestUrl = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && requestUrl.pathname === "/health") {
        sendJson(response, 200, healthPayload());
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/version") {
        sendJson(response, 200, versionPayload());
        return;
      }
      if (requestUrl.pathname.startsWith("/api/")) {
        await handleApi(request, response, {
          storeRoot,
          runnerMode,
          currentCodexThreadId,
          extensionSourceDir,
          codexRelay,
          saveArtifactAs: options.saveArtifactAs
        });
        return;
      }
      await serveStatic(requestUrl, response);
    } catch (error) {
      sendJson(response, 500, {
        error: error.message
      });
    }
  });
}
