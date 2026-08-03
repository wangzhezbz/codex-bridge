import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const HEARTBEAT_DIR = "extension";
const HEARTBEAT_FILE = "heartbeat.json";
const HEARTBEAT_WRITE_LOCKS = new Map();

function heartbeatPath(storeRoot) {
  return path.join(storeRoot, HEARTBEAT_DIR, HEARTBEAT_FILE);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameWithRetry(source, destination) {
  const startedAt = Date.now();
  while (true) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (
        !["EPERM", "EBUSY", "EACCES"].includes(error.code) ||
        Date.now() - startedAt > 2_000
      ) {
        throw error;
      }
      await sleep(10);
    }
  }
}

async function writeHeartbeatSnapshot(filePath, records) {
  const temporary = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ records }, null, 2)}\n`, "utf8");
    await renameWithRetry(temporary, filePath);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") {
        error.cleanupError = cleanupError;
      }
    }
    throw error;
  }
}

async function withHeartbeatWriteLock(storeRoot, operation) {
  const key = path.resolve(heartbeatPath(storeRoot));
  const previous = HEARTBEAT_WRITE_LOCKS.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  HEARTBEAT_WRITE_LOCKS.set(key, current);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (HEARTBEAT_WRITE_LOCKS.get(key) === current) {
      HEARTBEAT_WRITE_LOCKS.delete(key);
    }
  }
}

export async function saveExtensionHeartbeat(storeRoot, heartbeat = {}) {
  return withHeartbeatWriteLock(storeRoot, async () => {
    const now = new Date().toISOString();
    const existing = await listExtensionHeartbeats(storeRoot, { includeDisconnected: true });
    const existingRecord = existing.find((item) => item.workerId === (heartbeat.workerId || null));
    const record = {
      workerId: heartbeat.workerId || null,
      href: heartbeat.href || null,
      title: heartbeat.title || null,
      preferenceStatus:
        heartbeat.preferenceStatus && typeof heartbeat.preferenceStatus === "object"
          ? heartbeat.preferenceStatus
          : existingRecord?.preferenceStatus || null,
      pageStatus:
        heartbeat.pageStatus && typeof heartbeat.pageStatus === "object"
          ? heartbeat.pageStatus
          : null,
      captureStatus:
        heartbeat.captureStatus && typeof heartbeat.captureStatus === "object"
          ? heartbeat.captureStatus
          : existingRecord?.captureStatus || null,
      updatedAt: now
    };
    const records = [
      record,
      ...existing.filter((item) => item.workerId !== record.workerId)
    ].slice(0, 10);
    const filePath = heartbeatPath(storeRoot);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeHeartbeatSnapshot(filePath, records);
    return record;
  });
}

export async function listExtensionHeartbeats(storeRoot, { includeDisconnected = false } = {}) {
  try {
    const parsed = JSON.parse(await readFile(heartbeatPath(storeRoot), "utf8"));
    const rawRecords = Array.isArray(parsed?.records) ? parsed.records : parsed?.workerId ? [parsed] : [];
    const records = rawRecords
      .map((record) => {
        const timestamp = Date.parse(record.updatedAt || "");
        const ageMs = Number.isFinite(timestamp) ? Math.max(0, Date.now() - timestamp) : null;
        return {
          ...record,
          ageMs,
          connected: Number.isFinite(ageMs) && ageMs < 15000
        };
      })
      .filter((record) => includeDisconnected || record.connected);
    return records.sort((a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""));
  } catch {
    return [];
  }
}

export async function getExtensionHeartbeat(storeRoot) {
  return (await listExtensionHeartbeats(storeRoot))[0] || null;
}
