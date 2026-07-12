import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const HEARTBEAT_DIR = "extension";
const HEARTBEAT_FILE = "heartbeat.json";

function heartbeatPath(storeRoot) {
  return path.join(storeRoot, HEARTBEAT_DIR, HEARTBEAT_FILE);
}

export async function saveExtensionHeartbeat(storeRoot, heartbeat = {}) {
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
    updatedAt: now
  };
  const records = [
    record,
    ...existing.filter((item) => item.workerId !== record.workerId)
  ].slice(0, 10);
  await mkdir(path.dirname(heartbeatPath(storeRoot)), { recursive: true });
  await writeFile(heartbeatPath(storeRoot), `${JSON.stringify({ records }, null, 2)}\n`, "utf8");
  return record;
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
