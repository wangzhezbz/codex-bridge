import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

const TASKS_DIR = "tasks";

function nowIso() {
  return new Date().toISOString();
}
function compactTimestamp(iso) {
  return iso.replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/, "");
}

function taskIdFromDate(date = new Date()) {
  return `task_${compactTimestamp(date.toISOString())}_${randomBytes(3).toString("hex")}`;
}

function bridgeTasksDir(storeRoot) {
  return path.join(storeRoot, TASKS_DIR);
}

function taskDir(storeRoot, taskId) {
  return path.join(bridgeTasksDir(storeRoot), taskId);
}

function taskJsonPath(storeRoot, taskId) {
  return path.join(taskDir(storeRoot, taskId), "task.json");
}

function eventsPath(storeRoot, taskId) {
  return path.join(taskDir(storeRoot, taskId), "events.ndjson");
}

export function pathsForTask(storeRoot, taskId) {
  const dir = taskDir(storeRoot, taskId);
  return {
    dir,
    taskPath: path.join(dir, "task.json"),
    promptPath: path.join(dir, "PROMPT.md"),
    resultPath: path.join(dir, "RESULT.md"),
    eventsPath: path.join(dir, "events.ndjson")
  };
}

async function ensureTasksDir(storeRoot) {
  await mkdir(bridgeTasksDir(storeRoot), { recursive: true });
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function createTask(storeRoot, input) {
  await ensureTasksDir(storeRoot);

  const createdAt = nowIso();
  const id = taskIdFromDate(new Date(createdAt));
  const paths = pathsForTask(storeRoot, id);
  const title = input.title?.trim() || "Untitled task";
  const prompt = input.prompt?.trim();

  if (!prompt) {
    throw new Error("Task prompt is required");
  }

  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.promptPath, `${prompt}\n`, "utf8");

  const task = {
    id,
    title,
    status: "queued",
    targetRepo: input.targetRepo || null,
    source: input.source || "local",
    createdAt,
    updatedAt: createdAt,
    promptPath: paths.promptPath,
    resultPath: null
  };

  await writeJson(paths.taskPath, task);
  await appendEvent(storeRoot, id, {
    type: "task.created",
    taskId: id,
    title
  });

  return task;
}

export async function getTask(storeRoot, taskId) {
  return readJson(taskJsonPath(storeRoot, taskId));
}

export async function listTasks(storeRoot) {
  await ensureTasksDir(storeRoot);
  const entries = await readdir(bridgeTasksDir(storeRoot), { withFileTypes: true });
  const tasks = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      tasks.push(await getTask(storeRoot, entry.name));
    } catch {
      // Ignore incomplete task folders so one bad task cannot break the board.
    }
  }

  return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function appendEvent(storeRoot, taskId, event) {
  const timestamp = nowIso();
  const line = JSON.stringify({
    timestamp,
    taskId,
    ...event
  });
  await writeFile(eventsPath(storeRoot, taskId), `${line}\n`, { encoding: "utf8", flag: "a" });
}

export async function updateTask(storeRoot, taskId, patch) {
  const existing = await getTask(storeRoot, taskId);
  const updated = {
    ...existing,
    ...patch,
    updatedAt: nowIso()
  };
  await writeJson(taskJsonPath(storeRoot, taskId), updated);
  return updated;
}

export async function writeResult(storeRoot, taskId, text, options = {}) {
  const paths = pathsForTask(storeRoot, taskId);
  const resultText = text.endsWith("\n") ? text : `${text}\n`;
  await writeFile(paths.resultPath, resultText, "utf8");
  await updateTask(storeRoot, taskId, {
    status: options.status || "succeeded",
    resultPath: paths.resultPath
  });
  await appendEvent(storeRoot, taskId, {
    type: "task.result_written",
    status: options.status || "succeeded"
  });
  return paths.resultPath;
}

export async function readTaskResult(storeRoot, taskId) {
  const task = await getTask(storeRoot, taskId);
  if (!task.resultPath) {
    return "";
  }
  return readFile(task.resultPath, "utf8");
}

export async function readTaskEvents(storeRoot, taskId) {
  try {
    const raw = await readFile(eventsPath(storeRoot, taskId), "utf8");
    return raw
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
