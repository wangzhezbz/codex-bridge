import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ensureBridgeRoutingRules,
  ensureCodexDelegationInstructions
} from "./bridge-routing-rules.js";
import { createSyncJob } from "./sync-store.js";
import { createTask, listTasks } from "./task-store.js";
import { normalizeChatGptPreferences } from "./preference-compat.js";

const CHAT_DIR = "chat";
const MESSAGES_FILE = "messages.ndjson";
const WORKSPACE_FILE = "workspace.json";

function nowIso() {
  return new Date().toISOString();
}

function compactTimestamp(iso) {
  return iso.replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/, "");
}

function messageIdFromDate(date = new Date()) {
  return `msg_${compactTimestamp(date.toISOString())}_${randomBytes(3).toString("hex")}`;
}

function conversationIdFromDate(date = new Date()) {
  return `conv_${compactTimestamp(date.toISOString())}_${randomBytes(3).toString("hex")}`;
}

function workspacePath(storeRoot) {
  return path.join(storeRoot, WORKSPACE_FILE);
}

function chatDir(storeRoot) {
  return path.join(storeRoot, CHAT_DIR);
}

function messagesPath(storeRoot) {
  return path.join(chatDir(storeRoot), MESSAGES_FILE);
}

async function ensureStoreRoot(storeRoot) {
  await mkdir(storeRoot, { recursive: true });
}

async function ensureChatDir(storeRoot) {
  await mkdir(chatDir(storeRoot), { recursive: true });
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeOptionalText(value) {
  const text = value?.trim();
  return text || null;
}

function defaultBinding() {
  return {
    projectId: null,
    chatgptProjectUrl: null,
    targetRepo: null,
    conversationId: null,
    syncMode: "manual",
    modePreference: null,
    modelPreference: null,
    preferenceUpdatedAt: null,
    bridgeRulesPath: null,
    bridgeRulesUpdatedAt: null,
    codexDelegationPath: null,
    codexDelegationUpdatedAt: null,
    updatedAt: null
  };
}

function normalizeWorkspaceBinding(binding) {
  const preferences = normalizeChatGptPreferences(binding);
  const hasPreferences = Boolean(preferences.modePreference || preferences.modelPreference);
  return {
    ...binding,
    modePreference: preferences.modePreference,
    modelPreference: preferences.modelPreference,
    preferenceUpdatedAt: binding.preferenceUpdatedAt || (hasPreferences ? binding.updatedAt || null : null)
  };
}

export async function getWorkspaceBinding(storeRoot) {
  try {
    return normalizeWorkspaceBinding({
      ...defaultBinding(),
      ...JSON.parse(await readFile(workspacePath(storeRoot), "utf8"))
    });
  } catch {
    return defaultBinding();
  }
}

export async function updateWorkspaceBinding(storeRoot, input = {}) {
  await ensureStoreRoot(storeRoot);
  const existing = await getWorkspaceBinding(storeRoot);
  const updatedAt = nowIso();
  const updated = {
    ...existing,
    updatedAt
  };
  const previousProjectUrl = existing.chatgptProjectUrl;
  const previousTargetRepo = existing.targetRepo;

  if (Object.hasOwn(input, "chatgptProjectUrl")) {
    updated.chatgptProjectUrl = normalizeOptionalText(input.chatgptProjectUrl);
  }
  if (Object.hasOwn(input, "targetRepo")) {
    updated.targetRepo = normalizeOptionalText(input.targetRepo);
  }
  if (Object.hasOwn(input, "syncMode")) {
    updated.syncMode = normalizeOptionalText(input.syncMode) || "manual";
  }
  if (Object.hasOwn(input, "modePreference")) {
    updated.modePreference = normalizeOptionalText(input.modePreference);
  }
  if (Object.hasOwn(input, "modelPreference")) {
    updated.modelPreference = normalizeOptionalText(input.modelPreference);
  }
  if (Object.hasOwn(input, "modePreference") || Object.hasOwn(input, "modelPreference")) {
    const beforeModePreference = existing.modePreference;
    const beforeModelPreference = existing.modelPreference;
    const preferences = normalizeChatGptPreferences({
      modePreference: updated.modePreference,
      modelPreference: updated.modelPreference
    });
    updated.modePreference = preferences.modePreference;
    updated.modelPreference = preferences.modelPreference;
    if (
      !existing.preferenceUpdatedAt ||
      updated.modePreference !== beforeModePreference ||
      updated.modelPreference !== beforeModelPreference
    ) {
      updated.preferenceUpdatedAt = updatedAt;
    }
  }
  if (Object.hasOwn(input, "projectId")) {
    updated.projectId = normalizeOptionalText(input.projectId);
  }
  if (Object.hasOwn(input, "conversationId")) {
    updated.conversationId = normalizeOptionalText(input.conversationId);
  }
  if (
    !Object.hasOwn(input, "conversationId") &&
    (input.resetConversation ||
      !updated.conversationId ||
      updated.chatgptProjectUrl !== previousProjectUrl ||
      updated.targetRepo !== previousTargetRepo)
  ) {
    updated.conversationId = conversationIdFromDate(new Date(updatedAt));
  }

  if (updated.targetRepo) {
    const rules = await ensureBridgeRoutingRules({
      targetRepo: updated.targetRepo,
      chatgptProjectUrl: updated.chatgptProjectUrl,
      conversationId: updated.conversationId
    });
    const delegation = await ensureCodexDelegationInstructions({
      targetRepo: updated.targetRepo,
      chatgptProjectUrl: updated.chatgptProjectUrl,
      conversationId: updated.conversationId
    });
    updated.bridgeRulesPath = rules.path;
    if (rules.created || rules.updated) {
      updated.bridgeRulesUpdatedAt = updatedAt;
    }
    updated.codexDelegationPath = delegation.path;
    if (delegation.created || delegation.updated) {
      updated.codexDelegationUpdatedAt = updatedAt;
    }
  } else {
    updated.bridgeRulesPath = null;
    updated.bridgeRulesUpdatedAt = null;
    updated.codexDelegationPath = null;
    updated.codexDelegationUpdatedAt = null;
  }

  await writeJson(workspacePath(storeRoot), updated);
  return updated;
}

export async function appendChatMessage(storeRoot, input) {
  await ensureChatDir(storeRoot);
  const text = input.text?.trim();
  if (!text) {
    throw new Error("Chat message text is required");
  }

  const createdAt = nowIso();
  const workspace = await getWorkspaceBinding(storeRoot);
  const conversationId =
    input.conversationId || input.metadata?.conversationId || workspace.conversationId || null;
  const message = {
    id: messageIdFromDate(new Date(createdAt)),
    role: input.role || "user",
    kind: input.kind || "message",
    text,
    conversationId,
    metadata: {
      ...(input.metadata || {}),
      conversationId
    },
    createdAt
  };

  await writeFile(messagesPath(storeRoot), `${JSON.stringify(message)}\n`, {
    encoding: "utf8",
    flag: "a"
  });
  return message;
}

export async function listChatMessages(storeRoot, options = {}) {
  try {
    const workspace = await getWorkspaceBinding(storeRoot);
    const conversationId = Object.hasOwn(options, "conversationId")
      ? options.conversationId
      : workspace.conversationId;
    if (!conversationId) {
      return [];
    }
    const raw = await readFile(messagesPath(storeRoot), "utf8");
    return raw
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(
        (message) =>
          message.conversationId === conversationId ||
          message.metadata?.conversationId === conversationId
      );
  } catch {
    return [];
  }
}

function formatRecentTasks(tasks) {
  if (tasks.length === 0) {
    return "- 暂无 Codex 任务";
  }

  return tasks
    .slice(0, 5)
    .map((task) => `- ${task.title}：${task.status}${task.targetRepo ? `，项目 ${task.targetRepo}` : ""}`)
    .join("\n");
}

export function classifyChatIntent(text = "") {
  const normalized = text.trim().toLowerCase();
  if (isImageGenerationRequest(normalized)) {
    return "image_request";
  }
  const compact = normalized.replace(/[\s，。！？!?,.、~～]+/g, "");
  const greetings = new Set([
    "你好",
    "您好",
    "嗨",
    "哈喽",
    "在吗",
    "hi",
    "hello",
    "hey",
    "早",
    "早上好",
    "晚上好"
  ]);

  if (greetings.has(compact)) {
    return "chat_message";
  }

  const actionPattern =
    /(检查|排查|修复|修改|怎么修|该怎么修|规划|改一下|改成|生成|创建|新建|写一个|写一份|实现|开发|运行|测试|验证|调试|报错|错误|失败|优化|重构|安装|配置|部署|提交|执行|整理|分析|看看|查一下|\bfix\b|\bchange\b|\bcheck\b|\binspect\b|\bdebug\b|\brun\b|\btest\b|\bcreate\b|\bgenerate\b|\bwrite\b|\bimplement\b|\bbuild\b|\brefactor\b|\boptimize\b|\binstall\b|\bconfigure\b|\bdeploy\b|\berror\b|\bbug\b)/i;

  return actionPattern.test(normalized) ? "user_request" : "chat_message";
}

function isImageGenerationRequest(text = "") {
  return /(\u751f\u56fe|\u56fe\u7247|\u751f\u6210.{0,12}\u56fe|image|picture|photo|illustration|generate.{0,20}images?)/i.test(
    text
  );
}

function taskTitleFromChat(text) {
  const compact = text.trim().replace(/\s+/g, " ");
  const title = compact.length > 26 ? `${compact.slice(0, 26)}...` : compact;
  return `聊天任务：${title || "未命名请求"}`;
}

function buildCodexPromptFromChat({ workspace, userText }) {
  return [
    "# 来自工作台聊天窗口的任务",
    "",
    userText.trim(),
    "",
    "# Codex 执行要求",
    `目标项目目录：${workspace.targetRepo || "未指定"}`,
    "",
    "请直接判断这个请求是否需要修改本地项目。如果需要，请检查相关文件、做最小必要修改、运行合适的验证命令，并在结果中说明改了什么和怎么验证。如果不需要改文件，请输出清晰结论。"
  ].join("\n");
}

export function buildChatGptProjectSyncDraft({
  workspace,
  userText,
  recentTasks = [],
  intent = "chat_message"
}) {
  if (intent === "image_request") {
    return userText.trim();
  }

  const actionGuidance =
    intent === "user_request"
      ? "如果用户是在要求处理本地项目，请像正常助手一样简洁说明你的理解、建议做法和需要确认的问题。不要使用固定栏目，不要暴露任何内部交接格式或模板化标题。不要声称已经创建、生成、下载或修改了本地文件；这些动作只能由 Codex 在本地执行。"
      : "如果用户只是寒暄或普通聊天，请自然、简短地回应。不要把普通聊天解释成本地项目任务。";

  return [
    "你正在和用户正常聊天。下面的项目绑定信息只作为背景，不要在回复里暴露这些内部说明。",
    actionGuidance,
    "",
    "背景：",
    `- GPT 会话：${workspace.chatgptProjectUrl || "尚未绑定"}`,
    `- 本地项目目录：${workspace.targetRepo || "尚未填写"}`,
    `- 最近 Codex 执行现场：${formatRecentTasks(recentTasks)}`,
    "",
    `用户说：${userText.trim()}`
  ].join("\n");
}

function cleanFormatRecentTasks(tasks) {
  if (tasks.length === 0) {
    return "- 暂无 Codex 任务";
  }

  return tasks
    .slice(0, 5)
    .map((task) => `- ${task.title}：${task.status}${task.targetRepo ? `，项目 ${task.targetRepo}` : ""}`)
    .join("\n");
}

function cleanClassifyChatIntent(text = "") {
  const normalized = text.trim().toLowerCase();
  if (isImageGenerationRequest(normalized)) {
    return "image_request";
  }

  const compact = normalized.replace(/[\s，。！？,.、~]+/g, "");
  if (["你好", "您好", "嗨", "哈喽", "在吗", "测试", "hi", "hello", "hey", "test", "早", "早上好", "晚上好"].includes(compact)) {
    return "chat_message";
  }

  const actionPattern =
    /(检查|排查|修复|修改|怎么修|应该怎么修|规划|改一个|改成|生成|创建|新建|写一个|写一份|实现|开发|运行|测试|验证|调试|报错|错误|失败|优化|重构|安装|配置|部署|提交|执行|整理|分析|看看|查一下|\bfix\b|\bchange\b|\bcheck\b|\binspect\b|\bdebug\b|\brun\b|\btest\b|\bcreate\b|\bgenerate\b|\bwrite\b|\bimplement\b|\bbuild\b|\brefactor\b|\boptimize\b|\binstall\b|\bconfigure\b|\bdeploy\b|\berror\b|\bbug\b)/i;

  return actionPattern.test(normalized) ? "user_request" : "chat_message";
}

function cleanBuildChatGptProjectSyncDraft({
  workspace,
  userText,
  recentTasks = [],
  intent = "chat_message"
}) {
  if (intent === "image_request") {
    return userText.trim();
  }

  const actionGuidance =
    intent === "user_request"
      ? "如果用户是在要求处理本地项目，请像正常助手一样简洁说明你的理解、建议做法和需要确认的问题。不要使用固定栏目，不要暴露内部交接格式或模板化标题。不要声称已经创建、生成、下载或修改了本地文件；这些动作只能由 Codex 在本地执行。"
      : "如果用户只是寒暄或普通聊天，请自然、简短地回应。不要把普通聊天解释成本地项目任务。";

  return [
    "你正在和用户正常聊天。下面的项目绑定信息只作为背景，不要在回复里暴露这些内部说明。",
    actionGuidance,
    "",
    "背景：",
    `- GPT 会话：${workspace.chatgptProjectUrl || "尚未绑定"}`,
    `- 本地项目目录：${workspace.targetRepo || "尚未填写"}`,
    `- 最近 Codex 执行现场：${cleanFormatRecentTasks(recentTasks)}`,
    "",
    `用户说：${userText.trim()}`
  ].join("\n");
}

export async function createChatTurn(storeRoot, input) {
  if (Object.hasOwn(input, "chatgptProjectUrl") || Object.hasOwn(input, "targetRepo")) {
    await updateWorkspaceBinding(storeRoot, {
      chatgptProjectUrl: input.chatgptProjectUrl,
      targetRepo: input.targetRepo
    });
  }

  const workspace = await getWorkspaceBinding(storeRoot);
  const user = await appendChatMessage(storeRoot, {
    role: "user",
    text: input.text
  });
  const recentTasks = await listTasks(storeRoot);
  const intent = cleanClassifyChatIntent(input.text);
  const hiddenChatGptSyncDraft = cleanBuildChatGptProjectSyncDraft({
    workspace,
    userText: input.text,
    recentTasks,
    intent
  });

  if (workspace.chatgptProjectUrl) {
    const syncJob = await createSyncJob(storeRoot, {
      kind: intent,
      projectUrl: workspace.chatgptProjectUrl,
      targetRepo: workspace.targetRepo,
      conversationId: workspace.conversationId,
      userText: input.text,
      payloadText: hiddenChatGptSyncDraft,
      sourceMessageId: user.id
    });

    return {
      user,
      assistant: null,
      syncJob,
      task: null
    };
  }

  const task = await createTask(storeRoot, {
    title: input.title?.trim() || taskTitleFromChat(input.text),
    targetRepo: input.targetRepo || workspace.targetRepo,
    source: "chat",
    prompt: buildCodexPromptFromChat({
      workspace,
      userText: input.text
    })
  });
  const assistant = await appendChatMessage(storeRoot, {
    role: "assistant",
    kind: "codex_task",
    text: [
      "收到，Codex 正在后台处理。",
      workspace.chatgptProjectUrl ? "同一条上下文也会进入绑定的 GPT 会话同步通道。" : "绑定 GPT 会话后，同步通道会自动带上这条上下文。"
    ].join("\n"),
    metadata: {
      taskId: task.id,
      status: task.status,
      chatgptProjectUrl: workspace.chatgptProjectUrl,
      targetRepo: workspace.targetRepo,
      hiddenChatGptSyncDraft
    }
  });

  return {
    user,
    assistant,
    syncJob: null,
    task
  };
}

export async function importChatGptReply(storeRoot, input) {
  const workspace = await getWorkspaceBinding(storeRoot);
  const message = await appendChatMessage(storeRoot, {
    role: "chatgpt",
    kind: "message",
    text: input.text,
    metadata: {
      source: "chatgpt_project"
    }
  });

  let task = null;
  if (input.createTask) {
    task = await createTask(storeRoot, {
      title: input.title?.trim() || "GPT 规划执行",
      targetRepo: input.targetRepo || workspace.targetRepo,
      source: "chatgpt_project",
      prompt: [
        "# 来自 GPT 会话的规划",
        "",
        input.text.trim(),
        "",
        "# Codex 执行要求",
        "请根据上面的规划在目标项目中执行。先快速检查相关文件，再做最小必要修改；完成后运行合适的验证命令，并在结果中说明改了什么、怎么验证。"
      ].join("\n")
    });
  }

  return {
    message,
    task
  };
}
