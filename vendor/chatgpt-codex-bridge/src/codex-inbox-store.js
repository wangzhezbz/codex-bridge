import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const INBOX_DIR = "codex-inbox";
const ITEMS_DIR = "items";

function nowIso() {
  return new Date().toISOString();
}

function compactTimestamp(iso) {
  return iso.replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/, "");
}

function inboxItemIdFromDate(date = new Date()) {
  return `inbox_${compactTimestamp(date.toISOString())}_${randomBytes(3).toString("hex")}`;
}

function inboxItemsDir(storeRoot) {
  return path.join(storeRoot, INBOX_DIR, ITEMS_DIR);
}

function inboxItemPath(storeRoot, itemId) {
  return path.join(inboxItemsDir(storeRoot), `${itemId}.json`);
}

async function ensureInboxItemsDir(storeRoot) {
  await mkdir(inboxItemsDir(storeRoot), { recursive: true });
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeOptionalText(value) {
  const text = value?.trim();
  return text || null;
}

export async function createInboxItem(storeRoot, input = {}) {
  await ensureInboxItemsDir(storeRoot);
  const promptText = input.promptText?.trim();
  if (!promptText) {
    throw new Error("Inbox item promptText is required");
  }

  const createdAt = nowIso();
  const item = {
    id: inboxItemIdFromDate(new Date(createdAt)),
    status: "pending",
    source: input.source || "local",
    projectUrl: normalizeOptionalText(input.projectUrl),
    targetRepo: normalizeOptionalText(input.targetRepo),
    conversationId: input.conversationId || null,
    syncJobId: input.syncJobId || null,
    sourceMessageId: input.sourceMessageId || null,
    promptText,
    resultText: null,
    workerId: null,
    error: null,
    createdAt,
    updatedAt: createdAt
  };

  await writeJson(inboxItemPath(storeRoot, item.id), item);
  return item;
}

export async function getInboxItem(storeRoot, itemId) {
  return readJson(inboxItemPath(storeRoot, itemId));
}

async function updateInboxItem(storeRoot, itemId, patch) {
  const existing = await getInboxItem(storeRoot, itemId);
  const updated = {
    ...existing,
    ...patch,
    updatedAt: nowIso()
  };
  await writeJson(inboxItemPath(storeRoot, itemId), updated);
  return updated;
}

export async function listInboxItems(storeRoot) {
  await ensureInboxItemsDir(storeRoot);
  const entries = await readdir(inboxItemsDir(storeRoot), { withFileTypes: true });
  const items = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    try {
      items.push(await readJson(path.join(inboxItemsDir(storeRoot), entry.name)));
    } catch {
      // Ignore incomplete inbox item files.
    }
  }

  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function claimNextInboxItem(storeRoot, input = {}) {
  const items = await listInboxItems(storeRoot);
  const pending = [...items].reverse().find((item) => item.status === "pending");

  if (!pending) {
    return null;
  }

  return updateInboxItem(storeRoot, pending.id, {
    status: "running",
    workerId: input.workerId || "current-codex-thread",
    error: null
  });
}

export async function completeInboxItem(storeRoot, itemId, input = {}) {
  return updateInboxItem(storeRoot, itemId, {
    status: "succeeded",
    resultText: input.resultText?.trim() || "",
    error: null
  });
}

export async function failInboxItem(storeRoot, itemId, input = {}) {
  return updateInboxItem(storeRoot, itemId, {
    status: "failed",
    error: input.error?.trim() || "Codex inbox item failed"
  });
}
