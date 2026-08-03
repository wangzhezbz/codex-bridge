import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveBridgeDataDir } from "./runtime-config.js";

const ROUTER_RUNS_DIR = "router-runs";
const RUN_STATUSES = new Set(["pending", "queued", "running", "succeeded", "failed", "cancelled"]);
const STAGE_STATUSES = new Set(["pending", "queued", "running", "succeeded", "failed", "cancelled"]);
const SUBMISSION_STATES = new Set(["prepared", "submitting", "submitted"]);
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const SCOPE_FIELDS = ["projectId", "conversationId", "codexThreadId"];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FILE_LOCKS = new Map();
const RUN_LOCK_STALE_MS = 30_000;
const RUN_LOCK_TIMEOUT_MS = 35_000;
const RUN_LOCK_HEARTBEAT_MS = 5_000;
const TRANSIENT_LOCK_CLEANUP_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function abortError(signal) {
  const reason = signal?.reason;
  const error = new Error(
    reason instanceof Error && reason.message ? reason.message : "Router run store operation aborted"
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

function commitPointReached(option) {
  return typeof option === "function" ? option() === true : option === true;
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

async function reclaimStaleLock(lockPath) {
  let ownerText = "";
  try {
    ownerText = await readFile(lockPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return true;
    }
    throw error;
  }
  if (processIsAlive(lockOwnerPid(ownerText))) {
    return false;
  }

  const quarantine = `${lockPath}.stale.${process.pid}.${randomBytes(6).toString("hex")}`;
  try {
    await rename(lockPath, quarantine);
  } catch (error) {
    if (error.code === "ENOENT") {
      return true;
    }
    throw error;
  }
  try {
    await unlink(quarantine);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  return true;
}

async function withFileLock(lockPath, operation, options = {}) {
  const signal = options.signal;
  const lockOpen = options.lockOperations?.open || open;
  const lockReadFile = options.lockOperations?.readFile || readFile;
  const lockUnlink = options.lockOperations?.unlink || unlink;
  throwIfAborted(signal);
  const canonicalLockPath = path.resolve(lockPath);
  const previous = FILE_LOCKS.get(canonicalLockPath) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  FILE_LOCKS.set(canonicalLockPath, current);
  let handle = null;
  let heartbeat = null;
  const ownerToken = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const startedAt = Date.now();
  let result;
  let primaryError = null;
  try {
    await awaitWithAbort(previous.catch(() => {}), signal);
    throwIfAborted(signal);
    while (!handle) {
      throwIfAborted(signal);
      try {
        handle = await lockOpen(canonicalLockPath, "wx");
        await handle.writeFile(`${ownerToken} ${new Date().toISOString()}\n`, "utf8");
        throwIfAborted(signal);
        heartbeat = setInterval(() => {
          const heartbeatAt = new Date();
          void utimes(canonicalLockPath, heartbeatAt, heartbeatAt).catch(() => {});
        }, RUN_LOCK_HEARTBEAT_MS);
        heartbeat.unref?.();
      } catch (error) {
        if (error.code !== "EEXIST") {
          throw error;
        }
        try {
          const lockStat = await stat(canonicalLockPath);
          if (Date.now() - lockStat.mtimeMs > RUN_LOCK_STALE_MS) {
            if (await reclaimStaleLock(canonicalLockPath)) {
              continue;
            }
          }
        } catch (lockError) {
          if (lockError.code !== "ENOENT") {
            throw lockError;
          }
          continue;
        }
        if (Date.now() - startedAt > RUN_LOCK_TIMEOUT_MS) {
          throw new Error(
            `Timed out waiting for Router run lock: ${path.basename(canonicalLockPath)}`
          );
        }
        await sleep(20, signal);
      }
    }
    throwIfAborted(signal);
    result = await operation();
    if (!commitPointReached(options.commitOnOperationReturn)) {
      throwIfAborted(signal);
    }
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors = [];
  try {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        const lockOwner = await lockReadFile(canonicalLockPath, "utf8");
        if (lockOwner.startsWith(`${ownerToken} `)) {
          await unlinkLockWithRetry(canonicalLockPath, lockUnlink);
        }
      } catch (error) {
        if (error.code !== "ENOENT") {
          cleanupErrors.push(error);
        }
      }
    }
  } finally {
    release();
    if (FILE_LOCKS.get(canonicalLockPath) === current) {
      FILE_LOCKS.delete(canonicalLockPath);
    }
  }
  if (primaryError) {
    throw attachCleanupErrors(
      primaryError,
      cleanupErrors,
      "Router run lock cleanup failed"
    );
  }
  if (cleanupErrors.length === 1) {
    throw cleanupErrors[0];
  }
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "Router run lock cleanup failed");
  }
  return result;
}

function withRunFileLock(runPath, operation, options = {}) {
  return withFileLock(`${path.resolve(runPath)}.lock`, operation, options);
}

function withRunOperationLock(runPath, operation, options = {}) {
  return withFileLock(`${path.resolve(runPath)}.operation.lock`, operation, options);
}

function withRunSubmissionLock(runPath, operation, options = {}) {
  return withFileLock(`${path.resolve(runPath)}.submission.lock`, operation, options);
}

function withRunFinalizationLock(runPath, operation, options = {}) {
  return withFileLock(`${path.resolve(runPath)}.finalization.lock`, operation, options);
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

function nowIso(clock) {
  const value = clock();
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "number") {
    return new Date(value).toISOString();
  }
  return String(value);
}

function compactTimestamp(iso) {
  return iso.replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/, "");
}

function defaultRunIdFactory({ createdAt }) {
  return `router_run_${compactTimestamp(createdAt)}_${randomBytes(3).toString("hex")}`;
}

function requiredText(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new Error(`${field} is required`);
  }
  return text;
}

function optionalText(value) {
  if (value == null) {
    return null;
  }
  const text = String(value).trim();
  return text || null;
}

function assertSafeId(value, label) {
  const id = requiredText(value, label);
  if (!SAFE_ID.test(id) || id === "." || id === "..") {
    throw new Error(`Invalid ${label}: ${id}`);
  }
  return id;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => item != null).map((item) => String(item));
}

function normalizeAbsolutePaths(value) {
  return normalizeStringArray(value).map((item) => path.resolve(item));
}

function normalizeJsonArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new Error("Router stage inputArtifacts must be JSON serializable");
  }
}

function normalizeJsonObject(value, field) {
  if (value == null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a JSON object`);
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new Error(`${field} must be JSON serializable`);
  }
}

function normalizeOptionalPid(value, field) {
  if (value == null) {
    return null;
  }
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return pid;
}

function normalizeOptionalSafeId(value, field) {
  const normalized = optionalText(value);
  return normalized ? assertSafeId(normalized, field) : null;
}

function normalizeTargetRepoForComparison(value) {
  const resolved = path.resolve(requiredText(value, "transport terminal targetRepo"));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizeStage(stage = {}) {
  const id = assertSafeId(stage.id, "router stage id");
  const status = stage.status || "pending";
  if (!STAGE_STATUSES.has(status)) {
    throw new Error(`Invalid router stage status: ${status}`);
  }
  const submissionState = optionalText(stage.submissionState);
  if (submissionState && !SUBMISSION_STATES.has(submissionState)) {
    throw new Error(`Invalid router stage submissionState: ${submissionState}`);
  }
  return {
    id,
    title: optionalText(stage.title) || id,
    status,
    payloadText: stage.payloadText == null ? "" : String(stage.payloadText),
    dependsOn: optionalText(stage.dependsOn),
    instruction: optionalText(stage.instruction),
    replyText: stage.replyText == null ? null : String(stage.replyText),
    artifactIds: normalizeStringArray(stage.artifactIds),
    transportRequestId: optionalText(stage.transportRequestId),
    submissionState,
    submissionOwnerPid: normalizeOptionalPid(
      stage.submissionOwnerPid,
      "Router stage submissionOwnerPid"
    ),
    submissionOwnerToken: normalizeOptionalSafeId(
      stage.submissionOwnerToken,
      "Router stage submissionOwnerToken"
    ),
    cancelRequestedAt: optionalText(stage.cancelRequestedAt),
    cancelReason: optionalText(stage.cancelReason),
    inputArtifacts: normalizeJsonArray(stage.inputArtifacts),
    projectArtifactPaths: normalizeAbsolutePaths(stage.projectArtifactPaths),
    startedAt: optionalText(stage.startedAt),
    completedAt: optionalText(stage.completedAt),
    error: optionalText(stage.error)
  };
}

function normalizeStages(value) {
  if (!Array.isArray(value)) {
    throw new Error("Router run stages must be an array");
  }
  const stages = value.map(normalizeStage);
  const ids = new Set();
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index];
    if (ids.has(stage.id)) {
      throw new Error(`Duplicate router stage id: ${stage.id}`);
    }
    if (stage.dependsOn && !ids.has(stage.dependsOn)) {
      throw new Error(
        `Router stage dependency must reference an earlier stage: ${stage.id} -> ${stage.dependsOn}`
      );
    }
    ids.add(stage.id);
  }
  return stages;
}

function normalizeRun(input = {}, timestamps = {}) {
  const status = input.status || "pending";
  if (!RUN_STATUSES.has(status)) {
    throw new Error(`Invalid router run status: ${status}`);
  }
  const stages = normalizeStages(input.stages || []);
  const defaultStageIndex = stages.length > 0 ? 0 : -1;
  const currentStageIndex = Number.isInteger(input.currentStageIndex)
    ? input.currentStageIndex
    : defaultStageIndex;
  if (currentStageIndex < -1 || currentStageIndex >= stages.length) {
    throw new Error(`Invalid router run currentStageIndex: ${currentStageIndex}`);
  }

  return {
    id: assertSafeId(input.id, "router run id"),
    version: 2,
    status,
    routeKind: requiredText(input.routeKind, "routeKind"),
    syncKind: optionalText(input.syncKind),
    currentStageIndex,
    projectId: requiredText(input.projectId, "projectId"),
    conversationId: requiredText(input.conversationId, "conversationId"),
    codexThreadId: requiredText(input.codexThreadId, "codexThreadId"),
    transportId: requiredText(input.transportId, "transportId"),
    autoAdvanceOnTransportTerminal: input.autoAdvanceOnTransportTerminal === true,
    originalRequestText: requiredText(input.originalRequestText, "originalRequestText"),
    targetRepo: input.targetRepo ? path.resolve(input.targetRepo) : null,
    chatgptProjectUrl: optionalText(input.chatgptProjectUrl),
    modePreference: optionalText(input.modePreference),
    modelPreference: optionalText(input.modelPreference),
    routingDecision: normalizeJsonObject(input.routingDecision, "Router run routingDecision"),
    stages,
    projectArtifactPaths: normalizeAbsolutePaths(input.projectArtifactPaths),
    error: optionalText(input.error),
    createdAt: timestamps.createdAt || requiredText(input.createdAt, "createdAt"),
    updatedAt: timestamps.updatedAt || requiredText(input.updatedAt, "updatedAt")
  };
}

function assertTerminalStateIsImmutable(existing, candidate) {
  if (TERMINAL_STATUSES.has(existing.status) && candidate.status !== existing.status) {
    throw new Error(`Router run terminal status is immutable: ${existing.status}`);
  }
  for (let index = 0; index < existing.stages.length; index += 1) {
    const existingStage = existing.stages[index];
    const candidateStage = candidate.stages?.[index];
    if (
      existingStage.submissionOwnerToken &&
      candidateStage?.submissionOwnerToken !== existingStage.submissionOwnerToken
    ) {
      throw new Error(`Router stage submission owner token is immutable: ${existingStage.id}`);
    }
    if (
      TERMINAL_STATUSES.has(existingStage.status) &&
      (candidateStage?.status !== existingStage.status ||
        JSON.stringify(candidateStage) !== JSON.stringify(existingStage))
    ) {
      throw new Error(
        `Router stage terminal status is immutable: ${existingStage.id} (${existingStage.status})`
      );
    }
  }
}

export function assertRouterRunScope(run, scope = {}) {
  for (const field of SCOPE_FIELDS) {
    const value = typeof scope[field] === "string" ? scope[field].trim() : "";
    if (!value) {
      throw new Error(`Router run scope requires ${field}`);
    }
    if (run[field] !== value) {
      throw new Error(`Router run scope mismatch: ${field}`);
    }
  }
  return run;
}

export function createRouterRunStore(options = {}) {
  const storeRoot = resolveBridgeDataDir({
    storeRoot: options.storeRoot,
    env: options.env || process.env,
    cwd: options.cwd || process.cwd()
  });
  const clock = options.clock || (() => new Date());
  const runIdFactory = options.runIdFactory || defaultRunIdFactory;
  const lockOperations = options.lockOperations;
  const runsDir = path.join(storeRoot, ROUTER_RUNS_DIR);
  const lockOptions = (extra = {}) => ({ ...extra, lockOperations });

  async function ensureRunsDir() {
    await mkdir(runsDir, { recursive: true });
  }

  function runPath(runId) {
    return path.join(runsDir, `${assertSafeId(runId, "router run id")}.json`);
  }

  async function readRun(runId) {
    return JSON.parse(await readFile(runPath(runId), "utf8"));
  }

  async function writeRun(run) {
    await ensureRunsDir();
    const destination = runPath(run.id);
    const temporary = `${destination}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, "utf8");
      await renameWithRetry(temporary, destination);
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
    return run;
  }

  async function create(input = {}) {
    const createdAt = nowIso(clock);
    const id = assertSafeId(input.id || runIdFactory({ createdAt, input }), "router run id");
    const run = normalizeRun(
      {
        ...input,
        id
      },
      {
        createdAt,
        updatedAt: createdAt
      }
    );
    await ensureRunsDir();
    return withRunFileLock(runPath(id), async () => {
      try {
        await readRun(id);
        throw new Error(`Router run already exists: ${id}`);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
      return writeRun(run);
    }, lockOptions());
  }

  async function get(runId, scope) {
    return assertRouterRunScope(await readRun(runId), scope);
  }

  async function update(runId, scope, updaterOrPatch, options = {}) {
    const signal = options.signal;
    throwIfAborted(signal);
    const targetPath = runPath(runId);
    return withRunFileLock(targetPath, async () => {
      throwIfAborted(signal);
      const existing = await get(runId, scope);
      throwIfAborted(signal);
      const immutableId = existing.id;
      const immutableCreatedAt = existing.createdAt;
      const updaterInput = JSON.parse(JSON.stringify(existing));
      throwIfAborted(signal);
      const changed =
        typeof updaterOrPatch === "function"
          ? await updaterOrPatch(updaterInput)
          : { ...existing, ...(updaterOrPatch || {}) };
      throwIfAborted(signal);
      if (!changed || typeof changed !== "object") {
        throw new Error("Router run updater must return an object");
      }
      const candidate = {
        ...existing,
        ...changed,
        id: immutableId,
        version: 2,
        createdAt: immutableCreatedAt
      };
      assertRouterRunScope(candidate, scope);
      assertTerminalStateIsImmutable(existing, candidate);
      const updated = normalizeRun(candidate, {
        createdAt: immutableCreatedAt,
        updatedAt: nowIso(clock)
      });
      throwIfAborted(signal);
      return writeRun(updated);
    }, lockOptions({ signal, commitOnOperationReturn: true }));
  }

  async function reopenFailedStageForSucceededTransport(
    runId,
    scope,
    { transportRequestId, signal } = {}
  ) {
    throwIfAborted(signal);
    const requestId = requiredText(transportRequestId, "transportRequestId");
    const targetPath = runPath(runId);
    return withRunFileLock(targetPath, async () => {
      throwIfAborted(signal);
      const existing = await get(runId, scope);
      throwIfAborted(signal);
      if (existing.status !== "failed") {
        return existing;
      }
      const stageIndex = existing.stages.findIndex(
        (stage) =>
          stage.status === "failed" &&
          stage.submissionState === "submitted" &&
          stage.transportRequestId === requestId
      );
      if (stageIndex === -1) {
        return existing;
      }
      if (existing.stages.slice(stageIndex + 1).some((stage) => stage.status !== "pending")) {
        throw new Error("Router run cannot recover a failed stage after a later stage has started");
      }
      const candidate = {
        ...existing,
        status: "running",
        currentStageIndex: stageIndex,
        error: null,
        stages: existing.stages.map((stage, index) =>
          index === stageIndex
            ? {
                ...stage,
                status: "running",
                completedAt: null,
                error: null
              }
            : stage
        )
      };
      const updated = normalizeRun(candidate, {
        createdAt: existing.createdAt,
        updatedAt: nowIso(clock)
      });
      throwIfAborted(signal);
      return writeRun(updated);
    }, lockOptions({ signal, commitOnOperationReturn: true }));
  }

  async function withRunLease(runId, scope, operation, options = {}) {
    if (typeof operation !== "function") {
      throw new Error("Router run lease requires an operation function");
    }
    const signal = options.signal;
    throwIfAborted(signal);
    await ensureRunsDir();
    throwIfAborted(signal);
    const targetPath = runPath(runId);
    return withRunOperationLock(targetPath, async () => {
      throwIfAborted(signal);
      const run = await get(runId, scope);
      throwIfAborted(signal);
      const result = await operation(run);
      if (!commitPointReached(options.commitOnOperationReturn)) {
        throwIfAborted(signal);
      }
      return result;
    }, lockOptions({
      signal,
      commitOnOperationReturn: options.commitOnOperationReturn
    }));
  }

  async function withSubmissionLease(runId, scope, operation, options = {}) {
    if (typeof operation !== "function") {
      throw new Error("Router run submission lease requires an operation function");
    }
    const signal = options.signal;
    throwIfAborted(signal);
    await ensureRunsDir();
    throwIfAborted(signal);
    const targetPath = runPath(runId);
    return withRunSubmissionLock(targetPath, async () => {
      throwIfAborted(signal);
      const run = await get(runId, scope);
      throwIfAborted(signal);
      const result = await operation(run);
      if (!commitPointReached(options.commitOnOperationReturn)) {
        throwIfAborted(signal);
      }
      return result;
    }, lockOptions({
      signal,
      commitOnOperationReturn: options.commitOnOperationReturn
    }));
  }

  async function withFinalizationLease(runId, scope, operation, options = {}) {
    if (typeof operation !== "function") {
      throw new Error("Router run finalization lease requires an operation function");
    }
    const signal = options.signal;
    throwIfAborted(signal);
    await ensureRunsDir();
    throwIfAborted(signal);
    const targetPath = runPath(runId);
    return withRunFinalizationLock(targetPath, async () => {
      throwIfAborted(signal);
      const run = await get(runId, scope);
      throwIfAborted(signal);
      const result = await operation(run);
      if (!commitPointReached(options.commitOnOperationReturn)) {
        throwIfAborted(signal);
      }
      return result;
    }, lockOptions({
      signal,
      commitOnOperationReturn: options.commitOnOperationReturn
    }));
  }

  async function list(scope) {
    await ensureRunsDir();
    const entries = await readdir(runsDir, { withFileTypes: true });
    const runs = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      try {
        const run = JSON.parse(await readFile(path.join(runsDir, entry.name), "utf8"));
        assertRouterRunScope(run, scope);
        runs.push(run);
      } catch (error) {
        if (/scope mismatch/i.test(error.message)) {
          continue;
        }
        throw error;
      }
    }
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function findByTransportRequestId(requestId, guard = {}) {
    const expectedRequestId = requiredText(requestId, "transportRequestId");
    const expectedConversationId = requiredText(
      guard.conversationId,
      "transport terminal conversationId"
    );
    const expectedTargetRepo = normalizeTargetRepoForComparison(guard.targetRepo);
    await ensureRunsDir();
    const entries = await readdir(runsDir, { withFileTypes: true });
    const matches = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const run = JSON.parse(await readFile(path.join(runsDir, entry.name), "utf8"));
      const stageIndex = Array.isArray(run.stages)
        ? run.stages.findIndex((stage) => stage.transportRequestId === expectedRequestId)
        : -1;
      if (stageIndex === -1) {
        continue;
      }
      if (
        run.conversationId !== expectedConversationId ||
        !run.targetRepo ||
        normalizeTargetRepoForComparison(run.targetRepo) !== expectedTargetRepo
      ) {
        continue;
      }
      matches.push({ run, stageIndex });
    }
    if (matches.length > 1) {
      throw new Error(
        `Router transport request is ambiguous across scoped runs: ${expectedRequestId}`
      );
    }
    return matches[0] || null;
  }

  async function findByRunIdAndTransportRequestId(runId, requestId, guard = {}) {
    const expectedRequestId = requiredText(requestId, "transportRequestId");
    const expectedTargetRepo = normalizeTargetRepoForComparison(guard.targetRepo);
    let run;
    try {
      run = await get(runId, {
        projectId: guard.projectId,
        conversationId: guard.conversationId,
        codexThreadId: guard.codexThreadId
      });
    } catch (error) {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
    if (
      !run.targetRepo ||
      normalizeTargetRepoForComparison(run.targetRepo) !== expectedTargetRepo
    ) {
      return null;
    }
    const stageIndex = Array.isArray(run.stages)
      ? run.stages.findIndex((stage) => stage.transportRequestId === expectedRequestId)
      : -1;
    return stageIndex === -1 ? null : { run, stageIndex };
  }

  return {
    create,
    get,
    update,
    reopenFailedStageForSucceededTransport,
    withRunLease,
    withSubmissionLease,
    withFinalizationLease,
    list,
    findByRunIdAndTransportRequestId,
    findByTransportRequestId,
    assertScope: assertRouterRunScope
  };
}
