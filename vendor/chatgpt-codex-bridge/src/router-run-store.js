import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveBridgeDataDir } from "./runtime-config.js";

const ROUTER_RUNS_DIR = "router-runs";
const RUN_STATUSES = new Set(["pending", "queued", "running", "succeeded", "failed", "cancelled"]);
const STAGE_STATUSES = new Set(["pending", "queued", "running", "succeeded", "failed", "cancelled"]);
const SUBMISSION_STATES = new Set(["prepared", "submitted"]);
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const SCOPE_FIELDS = ["projectId", "conversationId", "codexThreadId"];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FILE_LOCKS = new Map();
const RUN_LOCK_STALE_MS = 30_000;
const RUN_LOCK_TIMEOUT_MS = 35_000;
const RUN_LOCK_HEARTBEAT_MS = 5_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function withFileLock(lockPath, operation) {
  const canonicalLockPath = path.resolve(lockPath);
  const previous = FILE_LOCKS.get(canonicalLockPath) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  FILE_LOCKS.set(canonicalLockPath, current);
  await previous.catch(() => {});
  let handle = null;
  let heartbeat = null;
  const ownerToken = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const startedAt = Date.now();
  try {
    while (!handle) {
      try {
        handle = await open(canonicalLockPath, "wx");
        await handle.writeFile(`${ownerToken} ${new Date().toISOString()}\n`, "utf8");
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
        await sleep(20);
      }
    }
    return await operation();
  } finally {
    let cleanupError = null;
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        cleanupError = error;
      }
      try {
        const lockOwner = await readFile(canonicalLockPath, "utf8");
        if (lockOwner.startsWith(`${ownerToken} `)) {
          await unlink(canonicalLockPath);
        }
      } catch (error) {
        if (error.code !== "ENOENT") {
          cleanupError ||= error;
        }
      }
    }
    release();
    if (FILE_LOCKS.get(canonicalLockPath) === current) {
      FILE_LOCKS.delete(canonicalLockPath);
    }
    if (cleanupError) {
      throw cleanupError;
    }
  }
}

function withRunFileLock(runPath, operation) {
  return withFileLock(`${path.resolve(runPath)}.lock`, operation);
}

function withRunOperationLock(runPath, operation) {
  return withFileLock(`${path.resolve(runPath)}.operation.lock`, operation);
}

function withRunSubmissionLock(runPath, operation) {
  return withFileLock(`${path.resolve(runPath)}.submission.lock`, operation);
}

function withRunFinalizationLock(runPath, operation) {
  return withFileLock(`${path.resolve(runPath)}.finalization.lock`, operation);
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
    originalRequestText: requiredText(input.originalRequestText, "originalRequestText"),
    targetRepo: input.targetRepo ? path.resolve(input.targetRepo) : null,
    chatgptProjectUrl: optionalText(input.chatgptProjectUrl),
    modePreference: optionalText(input.modePreference),
    modelPreference: optionalText(input.modelPreference),
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
  const runsDir = path.join(storeRoot, ROUTER_RUNS_DIR);

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
    });
  }

  async function get(runId, scope) {
    return assertRouterRunScope(await readRun(runId), scope);
  }

  async function update(runId, scope, updaterOrPatch) {
    const targetPath = runPath(runId);
    return withRunFileLock(targetPath, async () => {
      const existing = await get(runId, scope);
      const immutableId = existing.id;
      const immutableCreatedAt = existing.createdAt;
      const updaterInput = JSON.parse(JSON.stringify(existing));
      const changed =
        typeof updaterOrPatch === "function"
          ? await updaterOrPatch(updaterInput)
          : { ...existing, ...(updaterOrPatch || {}) };
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
      return writeRun(updated);
    });
  }

  async function withRunLease(runId, scope, operation) {
    if (typeof operation !== "function") {
      throw new Error("Router run lease requires an operation function");
    }
    await ensureRunsDir();
    const targetPath = runPath(runId);
    return withRunOperationLock(targetPath, async () => {
      const run = await get(runId, scope);
      return operation(run);
    });
  }

  async function withSubmissionLease(runId, scope, operation) {
    if (typeof operation !== "function") {
      throw new Error("Router run submission lease requires an operation function");
    }
    await ensureRunsDir();
    const targetPath = runPath(runId);
    return withRunSubmissionLock(targetPath, async () => {
      const run = await get(runId, scope);
      return operation(run);
    });
  }

  async function withFinalizationLease(runId, scope, operation) {
    if (typeof operation !== "function") {
      throw new Error("Router run finalization lease requires an operation function");
    }
    await ensureRunsDir();
    const targetPath = runPath(runId);
    return withRunFinalizationLock(targetPath, async () => {
      const run = await get(runId, scope);
      return operation(run);
    });
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

  return {
    create,
    get,
    update,
    withRunLease,
    withSubmissionLease,
    withFinalizationLease,
    list,
    assertScope: assertRouterRunScope
  };
}
