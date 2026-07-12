import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOM_DIR = "room";
const MESSAGES_FILE = "messages.ndjson";
const ROOM_STATE_FILE = "state.json";
const CODEX_TASKS_DIR = "codex-tasks";

function nowIso() {
  return new Date().toISOString();
}

function compactTimestamp(iso) {
  return iso.replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/, "");
}

function idFromDate(prefix, date = new Date()) {
  return `${prefix}_${compactTimestamp(date.toISOString())}_${randomBytes(3).toString("hex")}`;
}

function roomDir(storeRoot) {
  return path.join(storeRoot, ROOM_DIR);
}

function messagesPath(storeRoot) {
  return path.join(roomDir(storeRoot), MESSAGES_FILE);
}

function roomStatePath(storeRoot) {
  return path.join(roomDir(storeRoot), ROOM_STATE_FILE);
}

function codexTasksDir(storeRoot) {
  return path.join(roomDir(storeRoot), CODEX_TASKS_DIR);
}

function codexTaskPath(storeRoot, taskId) {
  return path.join(codexTasksDir(storeRoot), `${taskId}.json`);
}

async function ensureRoomDir(storeRoot) {
  await mkdir(roomDir(storeRoot), { recursive: true });
}

async function ensureCodexTasksDir(storeRoot) {
  await mkdir(codexTasksDir(storeRoot), { recursive: true });
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function conversationKey(conversationId) {
  return conversationId || "__default__";
}

async function readRoomState(storeRoot) {
  try {
    const parsed = JSON.parse(await readFile(roomStatePath(storeRoot), "utf8"));
    return {
      conversations: parsed && typeof parsed.conversations === "object" && parsed.conversations
        ? parsed.conversations
        : {}
    };
  } catch {
    return { conversations: {} };
  }
}

async function writeRoomState(storeRoot, state) {
  await ensureRoomDir(storeRoot);
  await writeJson(roomStatePath(storeRoot), state);
}

function stateForConversation(state, conversationId) {
  return state.conversations[conversationKey(conversationId)] || {};
}

function messageIsVisible(message, state, options = {}) {
  if (options.includeHidden) {
    return true;
  }

  const conversationState = stateForConversation(state, message.conversationId);
  if (Array.isArray(conversationState.hiddenMessageIds) && conversationState.hiddenMessageIds.includes(message.id)) {
    return false;
  }
  if (conversationState.clearedAt && message.createdAt && message.createdAt <= conversationState.clearedAt) {
    return false;
  }
  return true;
}

function normalizeTargets(value) {
  const targets = Array.isArray(value) ? value : [value].filter(Boolean);
  return [...new Set(targets)].filter((target) => ["user", "gpt", "codex"].includes(target));
}

export async function appendRoomMessage(storeRoot, input) {
  await ensureRoomDir(storeRoot);
  const text = input.text?.trim();
  if (!text) {
    throw new Error("Room message text is required");
  }

  const createdAt = nowIso();
  const message = {
    id: idFromDate("roommsg", new Date(createdAt)),
    conversationId: input.conversationId || null,
    from: input.from || "user",
    to: normalizeTargets(input.to || ["gpt"]),
    text,
    metadata: input.metadata || {},
    createdAt
  };

  await writeFile(messagesPath(storeRoot), `${JSON.stringify(message)}\n`, {
    encoding: "utf8",
    flag: "a"
  });
  return message;
}

export async function listRoomMessages(storeRoot, options = {}) {
  try {
    const raw = await readFile(messagesPath(storeRoot), "utf8");
    const state = await readRoomState(storeRoot);
    return raw
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((message) => !options.conversationId || message.conversationId === options.conversationId)
      .filter((message) => messageIsVisible(message, state, options));
  } catch {
    return [];
  }
}

export async function hideRoomMessage(storeRoot, messageId) {
  const messages = await listRoomMessages(storeRoot, { includeHidden: true });
  const message = messages.find((item) => item.id === messageId);
  if (!message) {
    throw new Error("Room message not found");
  }

  const state = await readRoomState(storeRoot);
  const key = conversationKey(message.conversationId);
  const conversationState = state.conversations[key] || {};
  const hiddenMessageIds = new Set(conversationState.hiddenMessageIds || []);
  hiddenMessageIds.add(message.id);
  const hiddenAt = nowIso();
  state.conversations[key] = {
    ...conversationState,
    hiddenMessageIds: [...hiddenMessageIds],
    updatedAt: hiddenAt
  };
  await writeRoomState(storeRoot, state);
  return {
    messageId: message.id,
    conversationId: message.conversationId || null,
    hiddenAt
  };
}

export async function clearRoomMessages(storeRoot, options = {}) {
  const clearedAt = nowIso();
  const conversationId = options.conversationId || null;
  const state = await readRoomState(storeRoot);
  const key = conversationKey(conversationId);
  state.conversations[key] = {
    ...(state.conversations[key] || {}),
    clearedAt,
    updatedAt: clearedAt
  };
  await writeRoomState(storeRoot, state);
  return {
    conversationId,
    clearedAt
  };
}

export async function createCodexTask(storeRoot, input) {
  await ensureCodexTasksDir(storeRoot);
  const promptText = input.promptText?.trim();
  if (!promptText) {
    throw new Error("Codex task promptText is required");
  }

  const createdAt = nowIso();
  const task = {
    id: idFromDate("roomcodex", new Date(createdAt)),
    status: "pending",
    conversationId: input.conversationId || null,
    sourceMessageId: input.sourceMessageId || null,
    currentThreadId: input.currentThreadId || null,
    targetRepo: input.targetRepo || null,
    promptText,
    resultText: null,
    workerId: null,
    error: null,
    createdAt,
    updatedAt: createdAt
  };

  await writeJson(codexTaskPath(storeRoot, task.id), task);
  return task;
}

export async function getCodexTask(storeRoot, taskId) {
  return readJson(codexTaskPath(storeRoot, taskId));
}

async function updateCodexTask(storeRoot, taskId, patch) {
  const existing = await getCodexTask(storeRoot, taskId);
  const updated = {
    ...existing,
    ...patch,
    updatedAt: nowIso()
  };
  await writeJson(codexTaskPath(storeRoot, taskId), updated);
  return updated;
}

export async function listCodexTasks(storeRoot, options = {}) {
  await ensureCodexTasksDir(storeRoot);
  const entries = await readdir(codexTasksDir(storeRoot), { withFileTypes: true });
  const tasks = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    try {
      const task = await readJson(path.join(codexTasksDir(storeRoot), entry.name));
      if (!options.conversationId || task.conversationId === options.conversationId) {
        tasks.push(task);
      }
    } catch {
      // Ignore incomplete task files.
    }
  }

  return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function claimNextCodexTask(storeRoot, input = {}) {
  const tasks = await listCodexTasks(storeRoot);
  const pending = [...tasks]
    .reverse()
    .find(
      (task) =>
        task.status === "pending" &&
        (!input.currentThreadId || !task.currentThreadId || task.currentThreadId === input.currentThreadId)
    );

  if (!pending) {
    return null;
  }

  return updateCodexTask(storeRoot, pending.id, {
    status: "running",
    workerId: input.workerId || "current-codex-thread",
    error: null
  });
}

export async function completeCodexTask(storeRoot, taskId, input = {}) {
  return updateCodexTask(storeRoot, taskId, {
    status: "succeeded",
    resultText: input.resultText?.trim() || "",
    error: null
  });
}

export async function failCodexTask(storeRoot, taskId, input = {}) {
  return updateCodexTask(storeRoot, taskId, {
    status: "failed",
    error: input.error?.trim() || "Codex task failed"
  });
}
