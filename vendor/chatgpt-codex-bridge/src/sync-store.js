import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeChatGptPreferences } from "./preference-compat.js";
import { assertTextIntegrity } from "./text-integrity.js";

const SYNC_DIR = "sync";
const JOBS_DIR = "jobs";
const SAFE_SYNC_JOB_ID = /^sync_[A-Za-z0-9._-]+$/;
const SYNC_JOB_LOCKS = new Map();
const SYNC_JOB_LOCK_STALE_MS = 30_000;
const SYNC_JOB_LOCK_TIMEOUT_MS = 35_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withSyncJobFileLock(jobPath, operation) {
  const lockPath = `${jobPath}.lock`;
  const startedAt = Date.now();
  let lockHandle = null;
  while (!lockHandle) {
    try {
      lockHandle = await open(lockPath, "wx");
      await lockHandle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf8");
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > SYNC_JOB_LOCK_STALE_MS) {
          await unlink(lockPath);
          continue;
        }
      } catch (lockError) {
        if (lockError.code !== "ENOENT") {
          throw lockError;
        }
        continue;
      }
      if (Date.now() - startedAt > SYNC_JOB_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for sync job lock: ${path.basename(jobPath)}`);
      }
      await sleep(20);
    }
  }

  try {
    return await operation();
  } finally {
    await lockHandle.close();
    try {
      await unlink(lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

async function withSyncJobLock(key, operation) {
  const previous = SYNC_JOB_LOCKS.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  SYNC_JOB_LOCKS.set(key, current);
  await previous.catch(() => {});
  try {
    return await withSyncJobFileLock(key, operation);
  } finally {
    release();
    if (SYNC_JOB_LOCKS.get(key) === current) {
      SYNC_JOB_LOCKS.delete(key);
    }
  }
}

function nowIso() {
  return new Date().toISOString();
}

function compactTimestamp(iso) {
  return iso.replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/, "");
}

function syncJobIdFromDate(date = new Date()) {
  return `sync_${compactTimestamp(date.toISOString())}_${randomBytes(3).toString("hex")}`;
}

function syncJobsDir(storeRoot) {
  return path.join(storeRoot, SYNC_DIR, JOBS_DIR);
}

function normalizeSyncJobId(value) {
  const id = String(value || "").trim();
  if (!SAFE_SYNC_JOB_ID.test(id) || id === "sync_..") {
    throw new Error(`Invalid sync job id: ${id || "missing"}`);
  }
  return id;
}

function syncJobPath(storeRoot, jobId) {
  return path.join(syncJobsDir(storeRoot), `${normalizeSyncJobId(jobId)}.json`);
}

async function ensureSyncJobsDir(storeRoot) {
  await mkdir(syncJobsDir(storeRoot), { recursive: true });
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
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

async function writeJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

function normalizeUrl(value) {
  const raw = value?.trim();
  if (!raw) {
    return null;
  }
  try {
    const url = new URL(raw);
    url.search = "";
    url.hash = "";
    return url.href.replace(/\/+$/, "");
  } catch {
    return raw.replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

function inputArtifactUploadUrl(artifact = {}) {
  const uploadUrl = String(artifact.uploadUrl || artifact.rawUrl || artifact.viewUrl || "").trim();
  if (uploadUrl) {
    return /\/download(?=$|\?)/.test(uploadUrl) ? uploadUrl.replace(/\/download(?=$|\?)/, "/raw") : uploadUrl;
  }

  const downloadUrl = inputArtifactDownloadUrl(artifact);
  return /\/download(?=$|\?)/.test(downloadUrl) ? downloadUrl.replace(/\/download(?=$|\?)/, "/raw") : "";
}

function inputArtifactDownloadUrl(artifact = {}) {
  const downloadUrl = String(artifact.downloadUrl || "").trim();
  if (downloadUrl) {
    return downloadUrl;
  }

  const id = String(artifact.id || "").trim();
  return id ? `/api/artifacts/${encodeURIComponent(id)}/download` : "";
}

function isOriginOnlyUrl(value) {
  try {
    const url = new URL(value);
    return url.pathname === "/" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function normalizeInputArtifacts(value = []) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((artifact) => artifact && typeof artifact === "object")
    .map((artifact) => ({
      id: String(artifact.id || "").trim(),
      filename: String(artifact.filename || "artifact").trim() || "artifact",
      contentType: String(artifact.contentType || "application/octet-stream").trim(),
      sizeBytes: Number.isFinite(Number(artifact.sizeBytes)) ? Number(artifact.sizeBytes) : 0,
      contentHashSha256: String(artifact.contentHashSha256 || "").trim() || null,
      downloadUrl: inputArtifactDownloadUrl(artifact),
      uploadUrl: inputArtifactUploadUrl(artifact)
    }))
    .filter((artifact) => artifact.id && artifact.downloadUrl);
}

function normalizeSyncJob(job = {}) {
  if (!job || typeof job !== "object") {
    return job;
  }
  return {
    ...job,
    inputArtifacts: normalizeInputArtifacts(job.inputArtifacts)
  };
}

function normalizeFailureDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function urlsMatchProject(jobUrl, activeUrl) {
  const job = normalizeUrl(jobUrl);
  const active = normalizeUrl(activeUrl);
  if (!job || !active) {
    return false;
  }
  if (isOriginOnlyUrl(active) && !isOriginOnlyUrl(job)) {
    return false;
  }
  return active === job || active.startsWith(`${job}/`) || job.startsWith(`${active}/`);
}

async function createSyncJobUnlocked(storeRoot, input) {
  await ensureSyncJobsDir(storeRoot);
  const payloadText = input.payloadText?.trim();
  if (!payloadText) {
    throw new Error("Sync job payloadText is required");
  }
  assertTextIntegrity(payloadText);

  const explicitId = input.id ? normalizeSyncJobId(input.id) : null;
  if (explicitId) {
    try {
      const existing = await getSyncJob(storeRoot, explicitId);
      const sameRequest =
        existing.kind === (input.kind || "user_request") &&
        existing.projectUrl === normalizeUrl(input.projectUrl) &&
        existing.conversationId === (input.conversationId || null) &&
        existing.payloadText === payloadText;
      if (!sameRequest) {
        throw new Error(`Sync job ${explicitId} already exists with a different payload`);
      }
      return existing;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  const createdAt = nowIso();
  const preferences = normalizeChatGptPreferences({
    modePreference: input.modePreference,
    modelPreference: input.modelPreference
  });
  const job = {
    id: explicitId || syncJobIdFromDate(new Date(createdAt)),
    kind: input.kind || "user_request",
    status: "pending",
    projectUrl: normalizeUrl(input.projectUrl),
    targetRepo: input.targetRepo || null,
    conversationId: input.conversationId || null,
    userText: input.userText || null,
    payloadText,
    resultCacheKey: input.resultCacheKey || null,
    modePreference: preferences.modePreference,
    modelPreference: preferences.modelPreference,
    inputArtifacts: normalizeInputArtifacts(input.inputArtifacts),
    replyText: null,
    artifactIds: [],
    artifactErrors: [],
    sourceMessageId: input.sourceMessageId || null,
    taskId: input.taskId || null,
    workerId: null,
    claimedAt: null,
    sentAt: null,
    completedAt: null,
    previousAssistantText: null,
    error: null,
    errorCode: null,
    recoveryAction: null,
    failureDetails: null,
    _bridgeImageBatchTotal: Number.isFinite(Number(input._bridgeImageBatchTotal))
      ? Number(input._bridgeImageBatchTotal)
      : null,
    _bridgeImageBatchCaptured: Number.isFinite(Number(input._bridgeImageBatchCaptured))
      ? Number(input._bridgeImageBatchCaptured)
      : 0,
    _bridgeImageBatchAttempt: Number.isFinite(Number(input._bridgeImageBatchAttempt))
      ? Number(input._bridgeImageBatchAttempt)
      : 0,
    _bridgeImageBatchOriginalText: input._bridgeImageBatchOriginalText || null,
    _bridgeImageBatchParentJobId: input._bridgeImageBatchParentJobId || null,
    createdAt,
    updatedAt: createdAt
  };

  await writeJson(syncJobPath(storeRoot, job.id), job);
  return job;
}

export async function createSyncJob(storeRoot, input) {
  const explicitId = input?.id ? normalizeSyncJobId(input.id) : null;
  if (!explicitId) {
    return createSyncJobUnlocked(storeRoot, input);
  }
  await ensureSyncJobsDir(storeRoot);
  return withSyncJobLock(syncJobPath(storeRoot, explicitId), () =>
    createSyncJobUnlocked(storeRoot, { ...input, id: explicitId })
  );
}

export async function getSyncJob(storeRoot, jobId) {
  return normalizeSyncJob(await readJson(syncJobPath(storeRoot, jobId)));
}

async function updateSyncJob(storeRoot, jobId, patchOrUpdater) {
  const jobPath = syncJobPath(storeRoot, jobId);
  return withSyncJobLock(jobPath, async () => {
    const existing = await getSyncJob(storeRoot, jobId);
    const patch =
      typeof patchOrUpdater === "function"
        ? await patchOrUpdater(existing)
        : patchOrUpdater;
    if (patch == null) {
      return existing;
    }
    const updated = {
      ...existing,
      ...(patch || {}),
      id: existing.id,
      updatedAt: nowIso()
    };
    await writeJson(jobPath, updated);
    return updated;
  });
}

export async function listSyncJobs(storeRoot) {
  await ensureSyncJobsDir(storeRoot);
  const entries = await readdir(syncJobsDir(storeRoot), { withFileTypes: true });
  const jobs = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    try {
      jobs.push(normalizeSyncJob(await readJson(path.join(syncJobsDir(storeRoot), entry.name))));
    } catch {
      // Ignore incomplete sync job files.
    }
  }

  return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function claimNextSyncJob(storeRoot, input = {}) {
  const jobs = await listSyncJobs(storeRoot);
  const claimableJobs = jobs.filter((job) => job.kind !== "preference_sync");
  async function tryClaim(candidates, matchesCurrent, patchCurrent, resume = false) {
    for (const candidate of candidates) {
      let claimed = false;
      const updated = await updateSyncJob(storeRoot, candidate.id, (current) => {
        if (
          current.kind === "preference_sync" ||
          !urlsMatchProject(current.projectUrl, input.projectUrl) ||
          !matchesCurrent(current)
        ) {
          return null;
        }
        claimed = true;
        return patchCurrent(current);
      });
      if (claimed) {
        return resume ? { ...updated, resume: true } : updated;
      }
    }
    return null;
  }

  const oldestFirst = [...claimableJobs].reverse();
  const resumable = await tryClaim(
    oldestFirst.filter((job) => job.status === "running" && job.sentAt),
    (job) => job.status === "running" && Boolean(job.sentAt),
    (job) => ({
      workerId: input.workerId || job.workerId || "unknown",
      claimedAt: job.claimedAt || nowIso(),
      error: null
    }),
    true
  );
  if (resumable) {
    return resumable;
  }

  const unsentRunning = await tryClaim(
    oldestFirst.filter((job) => job.status === "running" && !job.sentAt),
    (job) => job.status === "running" && !job.sentAt,
    (job) => ({
      workerId: input.workerId || job.workerId || "unknown",
      claimedAt: job.claimedAt || nowIso(),
      error: null
    })
  );
  if (unsentRunning) {
    return unsentRunning;
  }

  return tryClaim(
    oldestFirst.filter((job) => job.status === "pending"),
    (job) => job.status === "pending",
    (job) => ({
      status: "running",
      workerId: input.workerId || "unknown",
      claimedAt: job.claimedAt || nowIso(),
      ...(input.forcePreSendRefresh ? { _bridgeNeedsPreSendRefresh: true } : {}),
      error: null
    })
  );
}

export async function markSyncJobSent(storeRoot, jobId, input = {}) {
  return updateSyncJob(storeRoot, jobId, (existing) => {
    if (existing.status === "succeeded" || existing.status === "failed") {
      return null;
    }
    const sentAt = existing.sentAt && !input.refreshSentAt ? existing.sentAt : nowIso();
    return {
      status: "running",
      workerId: input.workerId || existing.workerId || "unknown",
      claimedAt: existing.claimedAt || nowIso(),
      sentAt,
      previousAssistantText: input.previousAssistantText ?? existing.previousAssistantText ?? null,
      error: null,
      errorCode: null,
      recoveryAction: null,
      failureDetails: null
    };
  });
}

export async function markSyncJobPreSendRefresh(storeRoot, jobId, input = {}) {
  return updateSyncJob(storeRoot, jobId, (existing) => {
    if (existing.status === "succeeded" || existing.status === "failed") {
      return null;
    }
    const currentAttempts = Number(existing._bridgeRefreshAttempts || 0);
    const refreshAttempts = Number.isFinite(currentAttempts) ? currentAttempts : 0;
    if (existing._bridgePreSendRefresh && refreshAttempts >= 1) {
      return {
        workerId: input.workerId || existing.workerId || "unknown",
        _bridgeNeedsPreSendRefresh: false,
        error: null,
        errorCode: null,
        recoveryAction: null
      };
    }
    return {
      status: "running",
      workerId: input.workerId || existing.workerId || "unknown",
      claimedAt: existing.claimedAt || nowIso(),
      _bridgeNeedsPreSendRefresh: false,
      _bridgePreSendRefresh: true,
      _bridgePreSendRefreshAt: nowIso(),
      _bridgeRefreshAttempts: refreshAttempts + 1,
      error: null,
      errorCode: null,
      recoveryAction: null,
      failureDetails: null
    };
  });
}

export async function completeSyncJob(storeRoot, jobId, input = {}) {
  const completedAt = nowIso();
  const thoughtDurationMs = Number.isFinite(Number(input.thoughtDurationMs)) && Number(input.thoughtDurationMs) > 0
    ? Number(input.thoughtDurationMs)
    : null;
  return updateSyncJob(storeRoot, jobId, (existing) => {
    if (existing.status === "failed" && /cancel/i.test(existing.errorCode || "")) {
      return null;
    }
    return {
      status: "succeeded",
      replyText: input.replyText?.trim() || "",
      artifactIds: input.artifactIds || [],
      artifactErrors: input.artifactErrors || [],
      projectArtifacts: input.projectArtifacts || [],
      projectArtifactErrors: input.projectArtifactErrors || [],
      thoughtDurationMs,
      completedAt,
      error: null,
      errorCode: null,
      recoveryAction: null,
      failureDetails: null
    };
  });
}

export async function failSyncJob(storeRoot, jobId, input = {}) {
  return updateSyncJob(storeRoot, jobId, (existing) => {
    if (existing.status === "succeeded" || existing.status === "failed") {
      return null;
    }
    const completedAt = nowIso();
    const thoughtDurationMs =
      Number.isFinite(Number(input.thoughtDurationMs)) && Number(input.thoughtDurationMs) > 0
        ? Number(input.thoughtDurationMs)
        : existing.thoughtDurationMs || null;
    return {
      status: "failed",
      replyText: input.replyText?.trim() || existing.replyText || "",
      artifactIds: input.artifactIds || existing.artifactIds || [],
      artifactErrors: input.artifactErrors || existing.artifactErrors || [],
      thoughtDurationMs,
      error: input.error?.trim() || "Sync job failed",
      errorCode: input.errorCode?.trim() || null,
      recoveryAction: input.recoveryAction?.trim() || null,
      failureDetails: normalizeFailureDetails(input.failureDetails),
      completedAt
    };
  });
}

export async function markSyncJobRecoveryIssued(storeRoot, jobId, input = {}) {
  return updateSyncJob(storeRoot, jobId, (existing) => {
    if (existing.status === "succeeded" || existing.status === "failed") {
      return null;
    }
    return {
      _bridgeRecoveryIssued: true,
      _bridgeRecoveryIssuedAt: nowIso(),
      _bridgeRecoveryAction: input.action?.trim() || existing._bridgeRecoveryAction || "reload"
    };
  });
}
