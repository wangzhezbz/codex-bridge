import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeChatGptPreferences } from "./preference-compat.js";
import { assertTextIntegrity } from "./text-integrity.js";

const SYNC_DIR = "sync";
const JOBS_DIR = "jobs";
const SAFE_SYNC_JOB_ID = /^sync_[A-Za-z0-9._-]+$/;
const SYNC_JOB_LOCKS = new Map();
const SYNC_JOB_RECONCILIATION_LOCKS = new Map();
const SYNC_JOB_LOCK_STALE_MS = 30_000;
const SYNC_JOB_LOCK_TIMEOUT_MS = 35_000;
const SYNC_JOB_RECONCILIATION_HEARTBEAT_MS = 5_000;
const ROUTER_RECONCILIATION_MAX_DELAY_MS = 60_000;
const ROUTER_RECONCILIATION_FAILURE_KINDS = new Set([
  "run_missing",
  "router_disabled",
  "exception"
]);
const ABANDONED_SENT_JOB_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TRANSIENT_LOCK_CLEANUP_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function abortError(signal) {
  const reason = signal?.reason;
  const error = new Error(
    reason instanceof Error && reason.message ? reason.message : "Sync store operation aborted"
  );
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  if (reason instanceof Error) {
    error.cause = reason;
  }
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

function attachCleanupErrors(error, cleanupErrors, message) {
  if (!error || cleanupErrors.length === 0) {
    return error;
  }
  error.cleanupErrors = cleanupErrors;
  if (!error.cause) {
    error.cause = cleanupErrors.length === 1
      ? cleanupErrors[0]
      : new AggregateError(cleanupErrors, message);
  }
  return error;
}

async function awaitWithAbort(value, signal) {
  throwIfAborted(signal);
  if (!signal) {
    return value;
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function sleep(ms, signal) {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  return awaitWithAbort(new Promise((resolve) => setTimeout(resolve, ms)), signal);
}

async function unlinkLockWithRetry(filePath, unlinkFile) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await unlinkFile(filePath);
      return;
    } catch (error) {
      if (
        error.code === "ENOENT" ||
        !TRANSIENT_LOCK_CLEANUP_CODES.has(error.code) ||
        attempt >= 2
      ) {
        throw error;
      }
      await sleep(10 * (attempt + 1));
    }
  }
}

async function withSyncJobFileLock(jobPath, operation, options = {}) {
  const lockPath = `${jobPath}.lock`;
  const lockOpen = options.lockOperations?.open || open;
  const lockUnlink = options.lockOperations?.unlink || unlink;
  const startedAt = Date.now();
  let lockHandle = null;
  while (!lockHandle) {
    try {
      lockHandle = await lockOpen(lockPath, "wx");
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

  let result;
  let primaryError = null;
  try {
    result = await operation();
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors = [];
  try {
    await lockHandle.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await unlinkLockWithRetry(lockPath, lockUnlink);
  } catch (error) {
    if (error.code !== "ENOENT") {
      cleanupErrors.push(error);
    }
  }
  if (primaryError) {
    throw attachCleanupErrors(primaryError, cleanupErrors, "Sync job lock cleanup failed");
  }
  if (cleanupErrors.length === 1) {
    throw cleanupErrors[0];
  }
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "Sync job lock cleanup failed");
  }
  return result;
}

async function withSyncJobLock(key, operation, options = {}) {
  const previous = SYNC_JOB_LOCKS.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  SYNC_JOB_LOCKS.set(key, current);
  await previous.catch(() => {});
  try {
    return await withSyncJobFileLock(key, operation, options);
  } finally {
    release();
    if (SYNC_JOB_LOCKS.get(key) === current) {
      SYNC_JOB_LOCKS.delete(key);
    }
  }
}

function lockOwnerPid(value = "") {
  const match = String(value).match(/^(\d+)-[a-f0-9]+\s/i);
  return match ? Number(match[1]) : null;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function withSyncJobReconciliationFileLock(jobPath, operation, options = {}) {
  const signal = options.signal;
  const lockOpen = options.lockOperations?.open || open;
  const lockReadFile = options.lockOperations?.readFile || readFile;
  const lockUnlink = options.lockOperations?.unlink || unlink;
  throwIfAborted(signal);
  const lockPath = `${path.resolve(jobPath)}.reconcile.lock`;
  const previous = SYNC_JOB_RECONCILIATION_LOCKS.get(lockPath) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  SYNC_JOB_RECONCILIATION_LOCKS.set(lockPath, current);

  const ownerToken = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const startedAt = Date.now();
  let lockHandle = null;
  let heartbeat = null;
  let result;
  let primaryError = null;
  try {
    await awaitWithAbort(previous.catch(() => {}), signal);
    throwIfAborted(signal);
    while (!lockHandle) {
      throwIfAborted(signal);
      try {
        lockHandle = await lockOpen(lockPath, "wx");
        await lockHandle.writeFile(`${ownerToken} ${new Date().toISOString()}\n`, "utf8");
        throwIfAborted(signal);
        heartbeat = setInterval(() => {
          const now = new Date();
          void utimes(lockPath, now, now).catch(() => {});
        }, SYNC_JOB_RECONCILIATION_HEARTBEAT_MS);
        heartbeat.unref?.();
      } catch (error) {
        if (error.code !== "EEXIST") {
          throw error;
        }
        try {
          const [lockStat, ownerText] = await Promise.all([
            stat(lockPath),
            readFile(lockPath, "utf8")
          ]);
          if (
            Date.now() - lockStat.mtimeMs > SYNC_JOB_LOCK_STALE_MS &&
            !processIsAlive(lockOwnerPid(ownerText))
          ) {
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
          throw new Error(
            `Timed out waiting for Router reconciliation lease: ${path.basename(jobPath)}`
          );
        }
        await sleep(20, signal);
      }
    }
    throwIfAborted(signal);
    result = await operation();
    throwIfAborted(signal);
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors = [];
  try {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    if (lockHandle) {
      try {
        await lockHandle.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        const ownerText = await lockReadFile(lockPath, "utf8");
        if (ownerText.startsWith(`${ownerToken} `)) {
          await unlinkLockWithRetry(lockPath, lockUnlink);
        }
      } catch (error) {
        if (error.code !== "ENOENT") {
          cleanupErrors.push(error);
        }
      }
    }
  } finally {
    release();
    if (SYNC_JOB_RECONCILIATION_LOCKS.get(lockPath) === current) {
      SYNC_JOB_RECONCILIATION_LOCKS.delete(lockPath);
    }
  }
  if (primaryError) {
    throw attachCleanupErrors(
      primaryError,
      cleanupErrors,
      "Sync reconciliation lock cleanup failed"
    );
  }
  if (cleanupErrors.length === 1) {
    throw cleanupErrors[0];
  }
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "Sync reconciliation lock cleanup failed");
  }
  return result;
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

function routerTerminalSignalRequired(job = {}) {
  return (
    job.routerTerminalSignalRequired === true ||
    Boolean(String(job.routerRunId || "").trim()) ||
    (!Object.prototype.hasOwnProperty.call(job, "routerTerminalSignalRequired") &&
      /^sync_router_/.test(String(job.id || "")))
  );
}

function normalizeOptionalIsoTimestamp(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeRouterReconciliationFailureKind(job = {}) {
  const explicit = String(job.routerTerminalReconciliationFailureKind || "").trim();
  if (ROUTER_RECONCILIATION_FAILURE_KINDS.has(explicit)) {
    return explicit;
  }
  if (Object.prototype.hasOwnProperty.call(job, "routerTerminalReconciliationFailureKind")) {
    return null;
  }
  const legacyError = String(job.routerTerminalReconciliationLastError || "").trim();
  if (legacyError === "router_run_not_found") {
    return "run_missing";
  }
  if (legacyError === "router_v2_disabled") {
    return "router_disabled";
  }
  return legacyError ? "exception" : null;
}

function normalizeTargetRepo(value) {
  const targetRepo = String(value || "").trim();
  if (!targetRepo) {
    return null;
  }
  const resolved = path.resolve(targetRepo);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function syncJobPath(storeRoot, jobId) {
  return path.join(syncJobsDir(storeRoot), `${normalizeSyncJobId(jobId)}.json`);
}

function syncClaimLockPath(storeRoot, projectUrl) {
  const projectKey = normalizeUrl(projectUrl) || "missing-project";
  const digest = createHash("sha256").update(projectKey).digest("hex").slice(0, 24);
  return path.join(syncJobsDir(storeRoot), `.claim-${digest}`);
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

function normalizeArtifactBaselineImageKeys(value = []) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .map((entry) => String(entry || "").trim())
        .filter(Boolean)
        .slice(0, 500)
    )
  ];
}

function normalizeSyncJob(job = {}) {
  if (!job || typeof job !== "object") {
    return job;
  }
  return {
    ...job,
    routerTerminalSignalRequired: routerTerminalSignalRequired(job),
    routerRunId: String(job.routerRunId || "").trim() || null,
    projectId: String(job.projectId || "").trim() || null,
    codexThreadId: String(job.codexThreadId || "").trim() || null,
    routerTerminalScopeVersion: Number(job.routerTerminalScopeVersion) === 1 ? 1 : null,
    routerTerminalReconciliationErrorCount:
      Number.isInteger(job.routerTerminalReconciliationErrorCount) &&
      job.routerTerminalReconciliationErrorCount >= 0
        ? job.routerTerminalReconciliationErrorCount
        : 0,
    routerTerminalReconciliationLastError:
      String(job.routerTerminalReconciliationLastError || "").trim() || null,
    routerTerminalReconciliationFailureKind:
      normalizeRouterReconciliationFailureKind(job),
    routerTerminalReconciliationNextAttemptAt:
      normalizeOptionalIsoTimestamp(job.routerTerminalReconciliationNextAttemptAt),
    routerTerminalReconciliationQuarantinedAt:
      normalizeOptionalIsoTimestamp(job.routerTerminalReconciliationQuarantinedAt),
    inputArtifacts: normalizeInputArtifacts(job.inputArtifacts),
    artifactBaselineImageKeys: normalizeArtifactBaselineImageKeys(job.artifactBaselineImageKeys)
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
  const requestedRouterRunId = String(input.routerRunId || "").trim() || null;
  const requestedProjectId = String(input.projectId || "").trim() || null;
  const requestedCodexThreadId = String(input.codexThreadId || "").trim() || null;
  const requiresRouterTerminalSignal =
    input.routerTerminalSignalRequired === true ||
    Boolean(requestedRouterRunId);
  if (requiresRouterTerminalSignal) {
    const missingScopeFields = [
      ["routerRunId", requestedRouterRunId],
      ["projectId", requestedProjectId],
      ["conversationId", String(input.conversationId || "").trim()],
      ["codexThreadId", requestedCodexThreadId],
      ["targetRepo", normalizeTargetRepo(input.targetRepo)]
    ]
      .filter(([, value]) => !value)
      .map(([field]) => field);
    if (missingScopeFields.length > 0) {
      throw new Error(
        `Router terminal scope requires ${missingScopeFields.join(", ")}`
      );
    }
  }
  if (explicitId) {
    try {
      const existing = await getSyncJob(storeRoot, explicitId);
      const sameRequest =
        existing.kind === (input.kind || "user_request") &&
        existing.projectUrl === normalizeUrl(input.projectUrl) &&
        existing.conversationId === (input.conversationId || null) &&
        normalizeTargetRepo(existing.targetRepo) === normalizeTargetRepo(input.targetRepo) &&
        existing.payloadText === payloadText;
      if (!sameRequest) {
        throw new Error(`Sync job ${explicitId} already exists with a different payload`);
      }
      if (
        existing.routerRunId &&
        requestedRouterRunId &&
        existing.routerRunId !== requestedRouterRunId
      ) {
        throw new Error(
          `Sync job ${explicitId} already belongs to a different Router run`
        );
      }
      for (const [field, requestedValue] of [
        ["projectId", requestedProjectId],
        ["codexThreadId", requestedCodexThreadId]
      ]) {
        if (existing[field] && requestedValue && existing[field] !== requestedValue) {
          throw new Error(`Sync job ${explicitId} already belongs to a different ${field}`);
        }
      }
      const markerPromoted =
        existing.routerTerminalSignalRequired !== true && requiresRouterTerminalSignal;
      const terminalOwnershipPromoted =
        markerPromoted && ["succeeded", "failed"].includes(existing.status);
      const promoted = {
        ...existing,
        routerTerminalSignalRequired:
          existing.routerTerminalSignalRequired === true || requiresRouterTerminalSignal,
        routerRunId: existing.routerRunId || requestedRouterRunId,
        projectId: existing.projectId || requestedProjectId,
        codexThreadId: existing.codexThreadId || requestedCodexThreadId,
        routerTerminalScopeVersion:
          existing.routerTerminalScopeVersion || (requiresRouterTerminalSignal ? 1 : null),
        routerTerminalSignalPending: terminalOwnershipPromoted
          ? true
          : existing.routerTerminalSignalPending,
        routerTerminalReconciledAt: terminalOwnershipPromoted
          ? null
          : existing.routerTerminalReconciledAt,
        routerTerminalReconciliationErrorCount: terminalOwnershipPromoted
          ? 0
          : existing.routerTerminalReconciliationErrorCount,
        routerTerminalReconciliationLastError: terminalOwnershipPromoted
          ? null
          : existing.routerTerminalReconciliationLastError,
        routerTerminalReconciliationFailureKind: terminalOwnershipPromoted
          ? null
          : existing.routerTerminalReconciliationFailureKind,
        routerTerminalReconciliationNextAttemptAt: terminalOwnershipPromoted
          ? null
          : existing.routerTerminalReconciliationNextAttemptAt,
        routerTerminalReconciliationQuarantinedAt: terminalOwnershipPromoted
          ? null
          : existing.routerTerminalReconciliationQuarantinedAt
      };
      if (
        promoted.routerTerminalSignalRequired !== existing.routerTerminalSignalRequired ||
        promoted.routerRunId !== existing.routerRunId ||
        promoted.projectId !== existing.projectId ||
        promoted.codexThreadId !== existing.codexThreadId ||
        promoted.routerTerminalScopeVersion !== existing.routerTerminalScopeVersion ||
        promoted.routerTerminalSignalPending !== existing.routerTerminalSignalPending ||
        promoted.routerTerminalReconciledAt !== existing.routerTerminalReconciledAt
      ) {
        promoted.updatedAt = nowIso();
        await writeJson(syncJobPath(storeRoot, explicitId), promoted);
      }
      return normalizeSyncJob(promoted);
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
    projectId: requestedProjectId,
    codexThreadId: requestedCodexThreadId,
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
    routerTerminalSignalRequired: requiresRouterTerminalSignal,
    routerRunId: requestedRouterRunId,
    routerTerminalScopeVersion: requiresRouterTerminalSignal ? 1 : null,
    routerTerminalSignalPending: false,
    routerTerminalReconciledAt: null,
    routerTerminalReconciliationErrorCount: 0,
    routerTerminalReconciliationLastError: null,
    routerTerminalReconciliationFailureKind: null,
    routerTerminalReconciliationNextAttemptAt: null,
    routerTerminalReconciliationQuarantinedAt: null,
    terminalMessageProjectionPending: false,
    terminalMessageProjectedAt: null,
    previousAssistantText: null,
    artifactBaselineImageKeys: [],
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

export async function createSyncJob(storeRoot, input, options = {}) {
  const explicitId = input?.id ? normalizeSyncJobId(input.id) : null;
  if (!explicitId) {
    return createSyncJobUnlocked(storeRoot, input);
  }
  await ensureSyncJobsDir(storeRoot);
  return withSyncJobLock(
    syncJobPath(storeRoot, explicitId),
    () => createSyncJobUnlocked(storeRoot, { ...input, id: explicitId }),
    options
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

export async function withSyncJobRouterTerminalReconciliationLease(
  storeRoot,
  jobId,
  operation,
  options = {}
) {
  if (typeof operation !== "function") {
    throw new Error("Router reconciliation lease requires an operation function");
  }
  const signal = options.signal;
  throwIfAborted(signal);
  await ensureSyncJobsDir(storeRoot);
  throwIfAborted(signal);
  return withSyncJobReconciliationFileLock(
    syncJobPath(storeRoot, normalizeSyncJobId(jobId)),
    operation,
    { signal, lockOperations: options.lockOperations }
  );
}

async function claimNextSyncJobUnlocked(storeRoot, input = {}) {
  const jobs = await listSyncJobs(storeRoot);
  const expiredJobIds = new Set();
  for (const job of jobs) {
    if (
      job.kind === "preference_sync" ||
      job.status !== "running" ||
      !job.sentAt ||
      !urlsMatchProject(job.projectUrl, input.projectUrl)
    ) {
      continue;
    }
    const activityAt = job.sentAt;
    const activityMs = Date.parse(activityAt || "");
    if (
      !Number.isFinite(activityMs) ||
      Date.now() - activityMs < ABANDONED_SENT_JOB_MAX_AGE_MS
    ) {
      continue;
    }
    let expired = false;
    await updateSyncJob(storeRoot, job.id, (current) => {
      if (current.status !== "running") {
        return null;
      }
      if (!current.sentAt) {
        return null;
      }
      const currentActivityAt = current.sentAt;
      const currentActivityMs = Date.parse(currentActivityAt || "");
      if (
        !Number.isFinite(currentActivityMs) ||
        Date.now() - currentActivityMs < ABANDONED_SENT_JOB_MAX_AGE_MS
      ) {
        return null;
      }
      expired = true;
      return {
        status: "failed",
        completedAt: nowIso(),
        error: "Bridge expired an abandoned running GPT job so newer work can continue.",
        errorCode: "abandoned_running_job",
        recoveryAction: "start_next_job",
        failureDetails: {
          reason: "running_job_exceeded_resume_window",
          activityAt: currentActivityAt,
          maxAgeMs: ABANDONED_SENT_JOB_MAX_AGE_MS
        }
      };
    });
    if (expired) {
      expiredJobIds.add(job.id);
    }
  }
  const claimableJobs = jobs.filter(
    (job) => job.kind !== "preference_sync" && !expiredJobIds.has(job.id)
  );
  function workerClientId(workerId = "") {
    const segment = String(workerId || "").split(":").at(-1) || "";
    return /^tab_[a-z0-9_-]+$/i.test(segment) ? segment : "";
  }
  function sameWorkerController(leftWorkerId, rightWorkerId) {
    if (!leftWorkerId || !rightWorkerId) {
      return false;
    }
    if (leftWorkerId === rightWorkerId) {
      return true;
    }
    const leftClientId = workerClientId(leftWorkerId);
    return Boolean(leftClientId && leftClientId === workerClientId(rightWorkerId));
  }
  function clearRecoveryForWorkerChange(job, nextWorkerId) {
    if (!job._bridgeRecoveryIssued || !nextWorkerId) {
      return {};
    }
    const recoveryWorkerId = job._bridgeRecoveryWorkerId || job.workerId || "";
    if (recoveryWorkerId === nextWorkerId) {
      return {};
    }
    return {
      _bridgeRecoveryIssued: false,
      _bridgeRecoveryIssuedAt: null,
      _bridgeRecoveryAction: null,
      _bridgeRecoveryAttempts: 0,
      _bridgeRecoveryWorkerId: null
    };
  }
  function workerCanResumeSentJob(job) {
    const nextWorkerId = input.workerId || "";
    if (!nextWorkerId || !job.workerId || sameWorkerController(job.workerId, nextWorkerId)) {
      return true;
    }
    return Boolean(
      job._bridgeRecoveryIssued &&
      job._bridgeRecoveryWorkerId &&
      sameWorkerController(job._bridgeRecoveryWorkerId, nextWorkerId)
    );
  }
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
    (job) => job.status === "running" && Boolean(job.sentAt) && workerCanResumeSentJob(job),
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
    (job) => job.status === "running" && !job.sentAt && workerCanResumeSentJob(job),
    (job) => {
      const workerId = input.workerId || job.workerId || "unknown";
      return {
        workerId,
        claimedAt: job.claimedAt || nowIso(),
        ...clearRecoveryForWorkerChange(job, workerId),
        error: null
      };
    }
  );
  if (unsentRunning) {
    return unsentRunning;
  }

  const activeProjectJob = (await listSyncJobs(storeRoot)).some(
    (job) =>
      job.kind !== "preference_sync" &&
      job.status === "running" &&
      urlsMatchProject(job.projectUrl, input.projectUrl)
  );
  if (activeProjectJob) {
    return null;
  }

  return tryClaim(
    oldestFirst.filter((job) => job.status === "pending"),
    (job) => job.status === "pending",
    (job) => {
      const workerId = input.workerId || "unknown";
      return {
        status: "running",
        workerId,
        claimedAt: job.claimedAt || nowIso(),
        ...clearRecoveryForWorkerChange(job, workerId),
        ...(input.forcePreSendRefresh ? { _bridgeNeedsPreSendRefresh: true } : {}),
        error: null
      };
    }
  );
}

export async function claimNextSyncJob(storeRoot, input = {}) {
  await ensureSyncJobsDir(storeRoot);
  return withSyncJobLock(syncClaimLockPath(storeRoot, input.projectUrl), () =>
    claimNextSyncJobUnlocked(storeRoot, input)
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
      submittedPromptTurnIndex: Number.isInteger(input.submittedPromptTurnIndex)
        ? input.submittedPromptTurnIndex
        : existing.submittedPromptTurnIndex ?? null,
      artifactBaselineImageKeys: Array.isArray(input.artifactBaselineImageKeys)
        ? normalizeArtifactBaselineImageKeys(input.artifactBaselineImageKeys)
        : normalizeArtifactBaselineImageKeys(existing.artifactBaselineImageKeys),
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
      routerTerminalSignalPending: routerTerminalSignalRequired(existing),
      routerTerminalReconciledAt: null,
      routerTerminalReconciliationErrorCount: 0,
      routerTerminalReconciliationLastError: null,
      routerTerminalReconciliationFailureKind: null,
      routerTerminalReconciliationNextAttemptAt: null,
      routerTerminalReconciliationQuarantinedAt: null,
      terminalMessageProjectionPending:
        existing.kind !== "preference_sync" && Boolean(existing.conversationId),
      terminalMessageProjectedAt: null,
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
    const errorCode = input.errorCode?.trim() || null;
    return {
      status: "failed",
      replyText: input.replyText?.trim() || existing.replyText || "",
      artifactIds: input.artifactIds || existing.artifactIds || [],
      artifactErrors: input.artifactErrors || existing.artifactErrors || [],
      thoughtDurationMs,
      error: input.error?.trim() || "Sync job failed",
      errorCode,
      recoveryAction: input.recoveryAction?.trim() || null,
      failureDetails: normalizeFailureDetails(input.failureDetails),
      routerTerminalSignalPending: routerTerminalSignalRequired(existing),
      routerTerminalReconciledAt: null,
      routerTerminalReconciliationErrorCount: 0,
      routerTerminalReconciliationLastError: null,
      routerTerminalReconciliationFailureKind: null,
      routerTerminalReconciliationNextAttemptAt: null,
      routerTerminalReconciliationQuarantinedAt: null,
      terminalMessageProjectionPending:
        existing.kind !== "preference_sync" &&
        errorCode !== "manual_cancelled" &&
        Boolean(existing.conversationId),
      terminalMessageProjectedAt: null,
      completedAt
    };
  });
}

export async function markSyncJobRouterTerminalReconciled(storeRoot, jobId) {
  return updateSyncJob(storeRoot, jobId, (existing) => {
    if (existing.status !== "succeeded" && existing.status !== "failed") {
      return null;
    }
    return {
      routerTerminalSignalPending: false,
      routerTerminalReconciledAt: existing.routerTerminalReconciledAt || nowIso(),
      routerTerminalReconciliationErrorCount: 0,
      routerTerminalReconciliationLastError: null,
      routerTerminalReconciliationFailureKind: null,
      routerTerminalReconciliationNextAttemptAt: null,
      routerTerminalReconciliationQuarantinedAt: null
    };
  });
}

export async function backfillSyncJobRouterScope(storeRoot, jobId, scope = {}) {
  const expectedRouterRunId = String(scope.routerRunId || "").trim();
  const expectedProjectId = String(scope.projectId || "").trim();
  const expectedConversationId = String(scope.conversationId || "").trim();
  const expectedCodexThreadId = String(scope.codexThreadId || "").trim();
  const expectedTargetRepo = normalizeTargetRepo(scope.targetRepo);
  if (
    !expectedRouterRunId ||
    !expectedProjectId ||
    !expectedConversationId ||
    !expectedCodexThreadId ||
    !expectedTargetRepo
  ) {
    throw new Error("Router scope backfill requires complete ownership");
  }
  return updateSyncJob(storeRoot, jobId, (existing) => {
    if (
      existing.routerRunId !== expectedRouterRunId ||
      existing.conversationId !== expectedConversationId ||
      normalizeTargetRepo(existing.targetRepo) !== expectedTargetRepo
    ) {
      throw new Error("Router scope backfill mismatch: strict terminal guard failed");
    }
    if (existing.projectId && existing.projectId !== expectedProjectId) {
      throw new Error("Router scope backfill mismatch: projectId");
    }
    if (existing.codexThreadId && existing.codexThreadId !== expectedCodexThreadId) {
      throw new Error("Router scope backfill mismatch: codexThreadId");
    }
    return {
      projectId: expectedProjectId,
      codexThreadId: expectedCodexThreadId,
      routerTerminalScopeVersion: 1
    };
  });
}

export async function recordSyncJobRouterTerminalReconciliationFailure(
  storeRoot,
  jobId,
  input = {}
) {
  const requestedMaxAttempts = Number(input.maxAttempts);
  const requestedBaseDelayMs = Number(input.baseDelayMs);
  const requestedMaxDelayMs = Number(input.maxDelayMs);
  if (input.baseDelayMs != null && (!Number.isFinite(requestedBaseDelayMs) || requestedBaseDelayMs <= 0)) {
    throw new Error("routerTerminalReconciliation baseDelayMs must be positive");
  }
  if (input.maxDelayMs != null && (!Number.isFinite(requestedMaxDelayMs) || requestedMaxDelayMs <= 0)) {
    throw new Error("routerTerminalReconciliation maxDelayMs must be positive");
  }
  if (
    input.maxAttempts != null &&
    (!Number.isInteger(requestedMaxAttempts) ||
      requestedMaxAttempts < 1 ||
      requestedMaxAttempts > 100)
  ) {
    throw new Error(
      "routerTerminalReconciliation maxAttempts must be an integer between 1 and 100"
    );
  }
  const maxAttempts = Number.isFinite(requestedMaxAttempts)
    ? Math.floor(requestedMaxAttempts)
    : 5;
  const baseDelayMs = Number.isFinite(requestedBaseDelayMs)
    ? Math.min(requestedBaseDelayMs, ROUTER_RECONCILIATION_MAX_DELAY_MS)
    : 1_000;
  const maxDelayMs = Number.isFinite(requestedMaxDelayMs)
    ? Math.min(
        ROUTER_RECONCILIATION_MAX_DELAY_MS,
        Math.max(baseDelayMs, requestedMaxDelayMs)
      )
    : ROUTER_RECONCILIATION_MAX_DELAY_MS;
  const nowDate = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
  if (Number.isNaN(nowDate.getTime())) {
    throw new Error("Router terminal reconciliation failure requires a valid now value");
  }
  const failureAt = nowDate.toISOString();
  const errorText = String(input.error?.message || input.error || "Router terminal reconciliation failed")
    .trim()
    .slice(0, 2_000);
  const requestedFailureKind = String(input.failureKind || "").trim();
  if (requestedFailureKind && !ROUTER_RECONCILIATION_FAILURE_KINDS.has(requestedFailureKind)) {
    throw new Error("Invalid Router terminal reconciliation failureKind");
  }
  const failureKind = requestedFailureKind || "exception";
  return updateSyncJob(storeRoot, jobId, (existing) => {
    if (
      existing.routerTerminalSignalRequired !== true ||
      existing.routerTerminalSignalPending !== true ||
      !["succeeded", "failed"].includes(existing.status)
    ) {
      return null;
    }
    const errorCount =
      (Number.isInteger(existing.routerTerminalReconciliationErrorCount)
        ? existing.routerTerminalReconciliationErrorCount
        : 0) + 1;
    const recoverable = failureKind === "run_missing" || failureKind === "router_disabled";
    const quarantined = !recoverable && errorCount >= maxAttempts;
    const delayMs = Math.min(
      maxDelayMs,
      baseDelayMs * (2 ** Math.min(errorCount - 1, 30))
    );
    return {
      routerTerminalReconciliationErrorCount: errorCount,
      routerTerminalReconciliationLastError: errorText || "Router terminal reconciliation failed",
      routerTerminalReconciliationFailureKind: failureKind,
      routerTerminalReconciliationNextAttemptAt: quarantined
        ? null
        : new Date(nowDate.getTime() + delayMs).toISOString(),
      routerTerminalReconciliationQuarantinedAt: quarantined ? failureAt : null,
      routerTerminalSignalPending: true,
      routerTerminalReconciledAt: null
    };
  });
}

export async function markSyncJobTerminalMessageProjected(storeRoot, jobId, expectedStatus) {
  return updateSyncJob(storeRoot, jobId, (existing) => {
    if (
      (expectedStatus !== "succeeded" && expectedStatus !== "failed") ||
      existing.status !== expectedStatus
    ) {
      return null;
    }
    return {
      terminalMessageProjectionPending: false,
      terminalMessageProjectedAt: existing.terminalMessageProjectedAt || nowIso()
    };
  });
}

export async function reopenFailedSyncJobForCapture(storeRoot, jobId) {
  return updateSyncJob(storeRoot, jobId, (existing) => {
    const sentReplyTimeout = Boolean(existing.sentAt && existing.errorCode === "reply_timeout");
    const generationStartedBeforeConfirmation = existing.errorCode === "pre_send_expired";
    if (existing.status !== "failed" || (!sentReplyTimeout && !generationStartedBeforeConfirmation)) {
      return null;
    }
    return {
      status: "running",
      sentAt: existing.sentAt || existing.claimedAt || existing.updatedAt || new Date().toISOString(),
      completedAt: null,
      routerTerminalSignalPending: false,
      routerTerminalReconciledAt: null,
      routerTerminalReconciliationErrorCount: 0,
      routerTerminalReconciliationLastError: null,
      routerTerminalReconciliationFailureKind: null,
      routerTerminalReconciliationNextAttemptAt: null,
      routerTerminalReconciliationQuarantinedAt: null,
      terminalMessageProjectionPending: false,
      terminalMessageProjectedAt: null,
      error: null,
      errorCode: null,
      recoveryAction: null,
      failureDetails: null,
      _bridgeRecoveryIssued: false,
      _bridgeRecoveryIssuedAt: null,
      _bridgeRecoveryAction: null,
      _bridgeRecoveryAttempts: 0,
      _bridgeRecoveryWorkerId: null
    };
  });
}

export async function reopenFailedSyncJobForResend(storeRoot, jobId, options = {}) {
  return updateSyncJob(storeRoot, jobId, (existing) => {
    const allowedErrorCodes = ["send_not_confirmed", "prompt_not_found"];
    if (options.allowPreSendExpired === true) {
      allowedErrorCodes.push("pre_send_expired");
    }
    if (
      existing.status !== "failed" ||
      !allowedErrorCodes.includes(existing.errorCode || "")
    ) {
      return null;
    }
    return {
      status: "pending",
      workerId: null,
      claimedAt: null,
      sentAt: null,
      submittedPromptTurnIndex: null,
      artifactBaselineImageKeys: [],
      completedAt: null,
      routerTerminalSignalPending: false,
      routerTerminalReconciledAt: null,
      routerTerminalReconciliationErrorCount: 0,
      routerTerminalReconciliationLastError: null,
      routerTerminalReconciliationFailureKind: null,
      routerTerminalReconciliationNextAttemptAt: null,
      routerTerminalReconciliationQuarantinedAt: null,
      terminalMessageProjectionPending: false,
      terminalMessageProjectedAt: null,
      error: null,
      errorCode: null,
      recoveryAction: null,
      failureDetails: null,
      _bridgeNeedsPreSendRefresh: false,
      _bridgePreSendRefresh: false,
      _bridgeRecoveryIssued: false,
      _bridgeRecoveryIssuedAt: null,
      _bridgeRecoveryAction: null,
      _bridgeRecoveryAttempts: 0,
      _bridgeRecoveryWorkerId: null
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
      _bridgeRecoveryAction: input.action?.trim() || existing._bridgeRecoveryAction || "reload",
      _bridgeRecoveryWorkerId:
        input.workerId?.trim() ||
        existing._bridgeRecoveryWorkerId ||
        existing.workerId ||
        null,
      _bridgeRecoveryAttempts:
        Math.max(existing._bridgeRecoveryIssued ? 1 : 0, Number(existing._bridgeRecoveryAttempts || 0)) + 1
    };
  });
}
