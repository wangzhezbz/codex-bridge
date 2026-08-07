import { compareVersions, COMPONENT_IDS } from "../../shared/software-manager/catalog-schema.mjs";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const KINDS = new Set(["install", "update", "uninstall", "rollback"]);
const COMPONENT_SET = new Set(COMPONENT_IDS);
const REQUEST_KEYS = new Set(["kind", "componentIds", "skillIds", "installRootToken"]);
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{16,128}$/u;
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const VERSION = /^\d+(?:\.\d+){0,3}$/u;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const MAX_SELECTION = 64;
const MAX_UI_LOG_LINES = 500;
const DEFAULT_MAX_PENDING_LOG_WRITES = 32;
const DEFAULT_LOG_WRITE_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_LISTENER_QUEUE = 64;
const MAX_LISTENERS = 32;
const MAX_REDACT_DEPTH = 8;
const MAX_REDACT_KEYS = 64;
const MAX_REDACT_ARRAY = 128;
const MAX_REDACT_STRING = 4096;
const RESULT_KEYS = Object.freeze([
  "componentId", "action", "status", "versionBefore", "versionAfter", "message", "rollbackAvailable",
]);
const RESULT_KEY_SET = new Set(RESULT_KEYS);
const RESULT_STATUSES = new Set(["succeeded", "failed", "skipped"]);
const PUBLIC_EXTERNAL_KINDS = new Set([
  "component-prepare", "component-shortcut", "component-uninstall",
  "git-external-install", "git-install", "git-install-cleanup", "git-uninstall", "git-rollback", "git-rollback-cleanup",
  "skill-prepare", "skill-replace", "skill-uninstall",
  "software-version-slot", "version-promote", "version-rollback",
]);

function serviceError(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireMethod(owner, name, code) {
  if (typeof owner?.[name] !== "function") throw serviceError(code);
  return owner[name].bind(owner);
}

function stringError(error) {
  if (typeof error?.code === "string" && error.code) return error.code;
  if (typeof error?.message === "string" && error.message) return error.message;
  return "software_manager_operation_failed";
}

function decodePercent(value) {
  let decoded = value;
  for (let index = 0; index < 2 && /%[0-9a-f]{2}/iu.test(decoded); index += 1) {
    try { decoded = decodeURIComponent(decoded); } catch { break; }
  }
  return decoded;
}

function redactString(value) {
  let text = decodePercent(String(value));
  text = text.replace(/\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s,;"']+/giu, "[REDACTED_URL]");
  text = text.replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/giu, (match) => `${match.split(/\s/u, 1)[0]} [REDACTED]`);
  text = text.replace(/\b(?:sk-(?:proj|svcacct|ant)-|xai-|pplx-|gsk_|hf_|ghp_|github_pat_)[A-Za-z0-9_-]{12,}\b/giu, "[REDACTED]");
  text = text.replace(/\bAIza[A-Za-z0-9_-]{20,}\b/gu, "[REDACTED]");
  text = text.replace(/\bsk-[A-Za-z0-9_]{16,}\b/giu, "[REDACTED]");
  text = text.replace(/["']?\b(?:api[-_ ]?key|token|registration[-_ ]?code|credential|password|secret|注册码)\b["']?\s*[:=]\s*["']?[^\s,;"'}]+["']?/giu, (match) => {
    const separator = match.search(/[:=]/u);
    return separator === -1 ? "[REDACTED]" : `${match.slice(0, separator + 1)}[REDACTED]`;
  });
  text = text.replace(/\b(?:subscription|proxy[-_ ]?subscription|订阅)\b\s*[:=]\s*[^\s,;"']+/giu, (match) => {
    const separator = match.search(/[:=]/u);
    return separator === -1 ? "[REDACTED]" : `${match.slice(0, separator + 1)}[REDACTED]`;
  });
  text = text.replace(/\b[A-Za-z]:\\(?:[^\s"'<>|]+\\)*[^\s"'<>|]*/gu, "[REDACTED_PATH]");
  text = text.replace(/\\\\[^\s"'<>|]+\\[^\s"'<>|]+(?:\\[^\s"'<>|]+)*/gu, "[REDACTED_PATH]");
  if (text.length > MAX_REDACT_STRING) text = `${text.slice(0, MAX_REDACT_STRING)}[TRUNCATED]`;
  return text;
}

function sensitiveKey(key) {
  return /^(?:__proto__|constructor|prototype)$/u.test(key)
    || /(?:authorization|api[-_]?key|token|nonce|registration[-_]?code|credential|password|secret|signature)/iu.test(key);
}

function redactValue(value, seen = new WeakSet(), depth = 0) {
  if (depth > MAX_REDACT_DEPTH) return "[TRUNCATED_DEPTH]";
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value;
  if (value instanceof Error) {
    if (seen.has(value)) return "[REDACTED:CIRCULAR]";
    seen.add(value);
    const result = Object.create(null);
    result.name = redactString(value.name);
    result.message = redactString(value.message);
    if (typeof value.code === "string") result.code = redactString(value.code);
    if (typeof value.stack === "string") result.stack = redactString(value.stack);
    if (value.cause !== undefined) result.cause = redactValue(value.cause, seen, depth + 1);
    for (const key of Object.keys(value).slice(0, MAX_REDACT_KEYS)) {
      if (key === "cause" || key === "code") continue;
      result[key] = sensitiveKey(key) ? "[REDACTED]" : redactValue(value[key], seen, depth + 1);
    }
    return result;
  }
  if (typeof value !== "object") return redactString(String(value));
  if (seen.has(value)) return "[REDACTED:CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, MAX_REDACT_ARRAY).map((entry) => redactValue(entry, seen, depth + 1));
  if (value instanceof Map) {
    const result = Object.create(null);
    for (const [key, entry] of [...value.entries()].slice(0, MAX_REDACT_KEYS)) {
      const name = redactString(String(key));
      result[name] = sensitiveKey(name) ? "[REDACTED]" : redactValue(entry, seen, depth + 1);
    }
    return result;
  }
  const result = Object.create(null);
  for (const [key, entry] of Object.entries(value).slice(0, MAX_REDACT_KEYS)) {
    const safeKey = redactString(key);
    result[safeKey] = sensitiveKey(key) ? "[REDACTED]" : redactValue(entry, seen, depth + 1);
  }
  return result;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function publicCatalogEntry(entry, kind) {
  if (!isPlainRecord(entry)) throw serviceError("software_manager_catalog_entry_invalid");
  if (kind === "component") {
    if (!COMPONENT_SET.has(entry.id) || typeof entry.name !== "string" || entry.name.length === 0
      || !VERSION.test(entry.version ?? "") || !Number.isSafeInteger(entry.size) || entry.size <= 0
      || typeof entry.supportsRollback !== "boolean") {
      throw serviceError("software_manager_catalog_entry_invalid");
    }
    return Object.freeze({
      id: entry.id,
      name: entry.name,
      version: entry.version,
      size: entry.size,
      supportsRollback: Boolean(entry.supportsRollback),
    });
  }
  if (!SKILL_ID.test(entry.id ?? "") || typeof entry.name !== "string" || entry.name.length === 0
    || typeof entry.description !== "string" || entry.description.length === 0
    || !VERSION.test(entry.version ?? "") || !Number.isSafeInteger(entry.size) || entry.size <= 0) {
    throw serviceError("software_manager_catalog_entry_invalid");
  }
  return Object.freeze({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    version: entry.version,
    size: entry.size,
  });
}

function validVersion(value) {
  if (typeof value !== "string" || !VERSION.test(value)) return false;
  return value.split(".").every((segment) => Number.isSafeInteger(Number(segment)));
}

function validAdapterResult(value, fallback) {
  const keys = isPlainRecord(value) ? Object.keys(value) : [];
  const structurallyValid = isPlainRecord(value)
    && keys.length === RESULT_KEYS.length && keys.every((key) => RESULT_KEY_SET.has(key))
    && value.componentId === fallback.componentId && value.action === fallback.action
    && RESULT_STATUSES.has(value.status)
    && (value.versionBefore === null || validVersion(value.versionBefore))
    && (value.versionAfter === null || validVersion(value.versionAfter))
    && typeof value.message === "string" && typeof value.rollbackAvailable === "boolean";
  if (!structurallyValid) return false;
  if (value.versionAfter === null && value.rollbackAvailable) return false;
  if (value.status !== "succeeded") return true;
  if (fallback.action === "uninstall") return value.versionAfter === null;
  return value.versionAfter !== null;
}

function safeAdapterResult(value, fallback) {
  if (!validAdapterResult(value, fallback)) {
    return failedResult(fallback.componentId, fallback.action, serviceError("software_manager_adapter_result_invalid"));
  }
  return deepFreeze(redactValue(value));
}

function failedResult(componentId, action, error) {
  return deepFreeze(redactValue({
    componentId,
    action,
    status: "failed",
    message: stringError(error),
    rollbackAvailable: false,
    versionBefore: null,
    versionAfter: null,
  }));
}

function publicExternalTask(value) {
  const kind = PUBLIC_EXTERNAL_KINDS.has(value?.kind) ? value.kind : "external-operation";
  let componentId = null;
  if (kind.startsWith("git-")) componentId = "git";
  else if (kind.startsWith("skill-")) {
    componentId = typeof value?.skillId === "string" && SKILL_ID.test(value.skillId) ? value.skillId : null;
  } else if (kind.startsWith("component-") || kind === "software-version-slot"
    || kind === "version-promote" || kind === "version-rollback") {
    componentId = COMPONENT_SET.has(value?.componentId) ? value.componentId : null;
  }
  return deepFreeze(redactValue({
    external: true,
    critical: true,
    cancellable: false,
    taskId: typeof value?.taskId === "string" && TASK_ID.test(value.taskId) ? value.taskId : "external-task",
    kind,
    phase: kind,
    componentId,
  }));
}

function safeSkillBatch(values, requestedIds, action) {
  const invalid = serviceError("software_manager_adapter_result_invalid");
  if (!Array.isArray(values) || values.length !== requestedIds.length) {
    return requestedIds.map((id) => failedResult(id, action, invalid));
  }
  const requested = new Set(requestedIds);
  const seen = new Set();
  const normalized = new Map();
  for (const value of values) {
    const id = value?.componentId;
    if (typeof id !== "string" || !requested.has(id) || seen.has(id)) {
      return requestedIds.map((requestedId) => failedResult(requestedId, action, invalid));
    }
    seen.add(id);
    if (!validAdapterResult(value, { componentId: id, action })) {
      return requestedIds.map((requestedId) => failedResult(requestedId, action, invalid));
    }
    normalized.set(id, safeAdapterResult(value, { componentId: id, action }));
  }
  if (seen.size !== requested.size) return requestedIds.map((id) => failedResult(id, action, invalid));
  return requestedIds.map((id) => normalized.get(id));
}

function validateIds(values, { allowed, pattern, code }) {
  if (!Array.isArray(values) || values.length > MAX_SELECTION) throw serviceError(code);
  const seen = new Set();
  for (const id of values) {
    if (typeof id !== "string" || (pattern && !pattern.test(id)) || (allowed && !allowed.has(id)) || seen.has(id)) {
      throw serviceError(code);
    }
    seen.add(id);
  }
  return [...values];
}

function summarizeStatus(components, skills, cancelled) {
  if (cancelled) return "cancelled";
  const all = [...components, ...skills];
  const failed = all.filter(({ status }) => status === "failed").length;
  const succeeded = all.filter(({ status }) => status === "succeeded").length;
  if (failed === 0) return "succeeded";
  return succeeded > 0 ? "partial" : "failed";
}

export function createSoftwareManagerService({
  platform = process.platform,
  catalogProvider,
  catalogService: initialCatalogService = null,
  adapters: fixedAdapters = null,
  adapterFactory = null,
  ownershipStore,
  recoverTransactions = async () => [],
  installRootResolver,
  logSink = null,
  clock = { now: () => Date.now() },
  taskIdFactory = () => `software-${randomUUID()}`,
  maxPendingLogWrites = DEFAULT_MAX_PENDING_LOG_WRITES,
  logWriteTimeoutMs = DEFAULT_LOG_WRITE_TIMEOUT_MS,
  maxListenerQueue = DEFAULT_MAX_LISTENER_QUEUE,
} = {}) {
  if (!catalogProvider && !initialCatalogService) throw serviceError("software_manager_catalog_provider_required");
  if (!fixedAdapters && typeof adapterFactory !== "function") throw serviceError("software_manager_adapters_required");
  const loadOwnership = requireMethod(ownershipStore, "load", "software_manager_ownership_store_required");
  if (typeof recoverTransactions !== "function") throw serviceError("software_manager_recovery_required");
  if (!installRootResolver || typeof installRootResolver.resolve !== "function"
    || typeof installRootResolver.choose !== "function" || typeof installRootResolver.getCurrentToken !== "function"
    || typeof installRootResolver.adopt !== "function" || typeof installRootResolver.discard !== "function") {
    throw serviceError("software_manager_install_root_resolver_required");
  }
  if (!clock || typeof clock.now !== "function" || typeof taskIdFactory !== "function") {
    throw serviceError("software_manager_clock_invalid");
  }
  if (!Number.isSafeInteger(maxPendingLogWrites) || maxPendingLogWrites < 1 || maxPendingLogWrites > 1024) {
    throw serviceError("software_manager_log_limit_invalid");
  }
  if (!Number.isSafeInteger(logWriteTimeoutMs) || logWriteTimeoutMs < 10 || logWriteTimeoutMs > 30_000) {
    throw serviceError("software_manager_log_timeout_invalid");
  }
  if (!Number.isSafeInteger(maxListenerQueue) || maxListenerQueue < 4 || maxListenerQueue > 256) {
    throw serviceError("software_manager_listener_queue_invalid");
  }

  const listeners = new Map();
  const listenerContext = new AsyncLocalStorage();
  const uiLogs = [];
  let pendingLogWrites = 0;
  const logQueue = [];
  let logWorker = null;
  let logWriteActive = false;
  let loggingDegraded = false;
  let loggingFailure = null;
  let catalogService = initialCatalogService;
  let recoveryPromise = null;
  let recoveryComplete = false;
  let recoveryFailure = null;
  let catalogFailure = null;
  let externalTask = null;
  let currentTask = null;
  let startReserved = false;
  let quitReservation = null;
  let entryTail = Promise.resolve();
  let taskSequence = 0;
  let taskNamespace = randomUUID().replaceAll("-", "").slice(0, 24);
  let selectedInstallRootToken = installRootResolver.getCurrentToken() ?? null;
  let lastInspection = null;

  function now() {
    const value = clock.now();
    if (!Number.isSafeInteger(value) || value < 0) throw serviceError("software_manager_clock_invalid");
    return value;
  }

  function snapshotValue(raw) {
    const { logs: _ignored, ...withoutLogs } = raw;
    const safe = redactValue(withoutLogs);
    safe.logs = Object.freeze([...uiLogs]);
    return deepFreeze(safe);
  }

  function withEntryGate(operation) {
    const previous = entryTail;
    let release;
    const occupied = new Promise((resolve) => { release = resolve; });
    entryTail = previous.then(() => occupied);
    return previous.then(operation).finally(release);
  }

  function issueTaskId() {
    let candidate;
    try { candidate = taskIdFactory(); } catch { candidate = null; }
    taskSequence += 1;
    if (taskSequence === 1 && typeof candidate === "string" && TASK_ID.test(candidate)) return candidate;
    if (!Number.isSafeInteger(taskSequence)) {
      taskSequence = 1;
      taskNamespace = randomUUID().replaceAll("-", "").slice(0, 24);
    }
    return `software-${taskNamespace}-${taskSequence.toString(36)}`;
  }

  function memoryLog(raw) {
    let entry = deepFreeze(redactValue({ timestamp: now(), level: "info", ...raw }));
    let serialized = JSON.stringify(entry);
    if (serialized.length > 16_384) {
      entry = deepFreeze(redactValue({
        timestamp: entry.timestamp,
        level: entry.level,
        taskId: entry.taskId,
        componentId: entry.componentId,
        phase: entry.phase,
        message: entry.message,
        details: "[TRUNCATED_ENTRY]",
      }));
      serialized = JSON.stringify(entry);
    }
    uiLogs.push(entry);
    if (uiLogs.length > MAX_UI_LOG_LINES) uiLogs.splice(0, uiLogs.length - MAX_UI_LOG_LINES);
    return entry;
  }

  function updatePendingLogWrites() {
    pendingLogWrites = logQueue.length + (logWriteActive ? 1 : 0);
  }

  function settleLogItem(item) {
    item.resolve();
  }

  function degradeLogging(error) {
    if (loggingDegraded) return;
    loggingDegraded = true;
    loggingFailure = redactValue(error);
    memoryLog({ level: "error", phase: "logging", message: "software_manager_log_sink_degraded", details: error });
    for (const item of logQueue.splice(0)) settleLogItem(item);
    updatePendingLogWrites();
  }

  function writeSinkWithDeadline(entry) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const timer = setTimeout(
        () => finish(reject, serviceError("software_manager_log_sink_timeout")),
        logWriteTimeoutMs,
      );
      Promise.resolve()
        .then(() => logSink.write(entry))
        .then(() => finish(resolve), (error) => finish(reject, error));
    });
  }

  function startLogWorker() {
    if (logWorker || loggingDegraded || logQueue.length === 0) return;
    logWorker = (async () => {
      while (!loggingDegraded && logQueue.length > 0) {
        const item = logQueue.shift();
        logWriteActive = true;
        updatePendingLogWrites();
        try { await writeSinkWithDeadline(item.entry); }
        catch (error) { degradeLogging(error); }
        finally {
          logWriteActive = false;
          settleLogItem(item);
          updatePendingLogWrites();
        }
      }
    })().finally(() => {
      logWorker = null;
      updatePendingLogWrites();
      if (!loggingDegraded && logQueue.length > 0) startLogWorker();
    });
  }

  function writeLog(raw) {
    const entry = memoryLog(raw);
    if (typeof logSink?.write !== "function" || loggingDegraded) return Promise.resolve();
    const important = raw?.level === "error" || raw?.phase === "finished" || raw?.phase === "logging";
    const coalesceKey = important
      ? null
      : `${raw?.taskId ?? "service"}:${raw?.componentId ?? "service"}:${raw?.phase ?? "progress"}`;
    const capacityUsed = logQueue.length + (logWriteActive ? 1 : 0);
    if (capacityUsed >= maxPendingLogWrites) {
      const replaceable = coalesceKey === null
        ? logQueue.find((item) => item.coalesceKey !== null)
        : logQueue.findLast((item) => item.coalesceKey === coalesceKey);
      if (replaceable) {
        replaceable.entry = entry;
        replaceable.important = replaceable.important || important;
        if (important) replaceable.coalesceKey = null;
        return replaceable.completion;
      }
      if (!important) return Promise.resolve();
      degradeLogging(serviceError("software_manager_log_queue_saturated"));
      return Promise.resolve();
    }
    let resolveWrite;
    const completion = new Promise((resolve) => { resolveWrite = resolve; });
    logQueue.push({ entry, important, coalesceKey, completion, resolve: resolveWrite });
    updatePendingLogWrites();
    startLogWorker();
    return pendingLogWrites >= maxPendingLogWrites ? completion : Promise.resolve();
  }

  async function drainLogs() {
    while (logWorker) await logWorker;
  }

  function listenerEventKey(event) {
    if (event.type === "snapshot") return "snapshot";
    if (event.type === "progress") return `progress:${event.componentId ?? "service"}:${event.phase ?? "progress"}`;
    return null;
  }

  function disconnectListener(token, record) {
    record.active = false;
    record.queue.length = 0;
    listeners.delete(token);
  }

  function startListenerWorker(token, record) {
    if (record.running || !record.active) return;
    record.running = true;
    void Promise.resolve().then(async () => {
      while (record.active && record.queue.length > 0) {
        const { event, causes } = record.queue.shift();
        const lease = { active: true };
        const context = { token, causes: new Set([...causes, token]), lease };
        try { await listenerContext.run(context, () => record.listener(event)); }
        catch { /* listener failures stay isolated */ }
        finally { lease.active = false; }
      }
    }).finally(() => {
      record.running = false;
      if (record.active && record.queue.length > 0) startListenerWorker(token, record);
    });
  }

  function enqueueListenerEvent(token, record, event, causes) {
    if (!record.active) return;
    const key = listenerEventKey(event);
    if (key !== null) {
      const existing = record.queue.find((item) => item.key === key);
      if (existing) {
        existing.event = event;
        existing.causes = new Set(causes);
        return;
      }
    }
    if (record.queue.length >= maxListenerQueue) {
      const replaceableIndex = event.type === "finished" || event.type === "error"
        ? record.queue.findIndex((item) => item.key !== null)
        : -1;
      if (replaceableIndex >= 0) record.queue.splice(replaceableIndex, 1);
      else {
        disconnectListener(token, record);
        return;
      }
    }
    record.queue.push({ event, key, causes: new Set(causes) });
    startListenerWorker(token, record);
  }

  function emit(rawEvent) {
    const event = deepFreeze(redactValue(rawEvent));
    const source = listenerContext.getStore();
    const sourceActive = Boolean(source?.lease?.active && listeners.get(source.token)?.active);
    const causes = sourceActive ? source.causes : new Set();
    for (const [token, record] of listeners) {
      if (causes.has(token)) continue;
      enqueueListenerEvent(token, record, event, causes);
    }
  }

  function progress(componentId, phase, percent, cancellable, message, details, critical = false, task = currentTask) {
    if (!task || currentTask !== task) return Promise.resolve();
    task.phase = phase;
    task.critical = task.critical || Boolean(critical);
    task.cancellable = !task.critical && Boolean(cancellable) && !task.acceptedCancel;
    const event = {
      type: "progress",
      taskId: task.taskId,
      componentId,
      phase,
      percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
      cancellable: task.cancellable,
      message: typeof message === "string" ? message : phase,
    };
    const logged = writeLog({ taskId: task.taskId, componentId, phase, message: event.message, details });
    emit(event);
    return logged;
  }

  async function currentCatalog() {
    if (catalogService) return catalogService;
    if (typeof catalogProvider?.getCurrent === "function") {
      try {
        catalogService = await catalogProvider.getCurrent();
        catalogFailure = catalogService ? null : serviceError("software_manager_catalog_unavailable");
      } catch (error) {
        catalogService = null;
        catalogFailure = serviceError("software_manager_catalog_unavailable", error);
      }
    }
    return catalogService ?? null;
  }

  function catalogEntries(service) {
    if (!service) return { components: [], skills: [] };
    try {
      const entries = {
        components: COMPONENT_IDS.map((id) => publicCatalogEntry(service.getComponent(id), "component")),
        skills: service.listSkills().map((entry) => publicCatalogEntry(entry, "skill")),
      };
      if (new Set(entries.components.map(({ id }) => id)).size !== COMPONENT_IDS.length
        || new Set(entries.skills.map(({ id }) => id)).size !== entries.skills.length) {
        throw serviceError("software_manager_catalog_entry_invalid");
      }
      catalogFailure = null;
      return entries;
    } catch (error) {
      catalogFailure = serviceError("software_manager_catalog_unavailable", error);
      return { components: [], skills: [] };
    }
  }

  async function resolveAdapters(service, token = selectedInstallRootToken) {
    if (fixedAdapters) return fixedAdapters;
    if (typeof token !== "string" || !OPAQUE_TOKEN.test(token)) throw serviceError("software_manager_install_root_required");
    const installRootCapability = await installRootResolver.resolve(token);
    if (!installRootCapability || typeof installRootCapability !== "object") {
      throw serviceError("software_manager_install_root_invalid");
    }
    const value = await adapterFactory({ catalogService: service, installRootCapability });
    if (!value || typeof value !== "object") throw serviceError("software_manager_adapters_invalid");
    return value;
  }

  function adapterMethod(adapters, id, name) {
    const adapter = adapters?.[id];
    if (typeof adapter?.[name] !== "function") throw serviceError("software_manager_adapter_invalid");
    return adapter[name].bind(adapter);
  }

  async function inspectAll(adapters, entries, additionalSkillIds = []) {
    const components = [];
    for (const entry of entries.components) {
      try {
        const result = await adapterMethod(adapters, entry.id, "inspectInstalled")({});
        components.push(safeAdapterResult(result, { componentId: entry.id, action: "inspect" }));
      } catch (error) {
        components.push(failedResult(entry.id, "inspect", error));
      }
    }
    let skills = [];
    const skillIds = [...new Set([...entries.skills.map(({ id }) => id), ...additionalSkillIds])];
    try {
      const result = await adapterMethod(adapters, "skills", "inspectInstalled")({ skillIds });
      skills = safeSkillBatch(result, skillIds, "inspect");
    } catch (error) {
      skills = skillIds.map((id) => failedResult(id, "inspect", error));
    }
    return { components, skills };
  }

  async function runRecovery() {
    if (platform !== "win32") {
      recoveryComplete = true;
      return { recovered: true, pending: false };
    }
    try {
      await recoverTransactions();
      selectedInstallRootToken = installRootResolver.getCurrentToken() ?? selectedInstallRootToken;
      const before = await loadOwnership();
      if (before?.activeTask) {
        externalTask = publicExternalTask(before.activeTask);
        recoveryFailure = serviceError("software_manager_pending_recovery");
        recoveryComplete = true;
        return { recovered: false, pending: true };
      }
      externalTask = null;
      recoveryFailure = null;
      const service = await currentCatalog();
      const entries = catalogEntries(service);
      if (service && !catalogFailure && (fixedAdapters || selectedInstallRootToken)) {
        const adapters = await resolveAdapters(service);
        lastInspection = await inspectAll(adapters, entries, Object.keys(before?.skills ?? {}));
      }
      const state = await loadOwnership();
      externalTask = state?.activeTask ? publicExternalTask(state.activeTask) : null;
      recoveryFailure = externalTask ? serviceError("software_manager_pending_recovery") : null;
      recoveryComplete = true;
      return { recovered: externalTask === null, pending: externalTask !== null };
    } catch (error) {
      recoveryFailure = error?.code === "software_manager_pending_recovery"
        ? error
        : serviceError("software_manager_recovery_failed", error);
      recoveryComplete = true;
      return { recovered: false, pending: true };
    }
  }

  async function recoverPending() {
    if (currentTask || startReserved) throw serviceError("software_manager_task_running");
    if (!recoveryPromise) {
      recoveryPromise = withEntryGate(() => refreshRecoveryStateInGate()).finally(() => { recoveryPromise = null; });
    }
    return recoveryPromise;
  }

  async function refreshRecoveryStateInGate() {
    let state;
    try { state = await loadOwnership(); }
    catch (error) {
      externalTask = null;
      recoveryFailure = serviceError("software_manager_recovery_failed", error);
      recoveryComplete = true;
      return { recovered: false, pending: true };
    }
    if (state?.activeTask) {
      externalTask = publicExternalTask(state.activeTask);
      recoveryFailure = serviceError("software_manager_pending_recovery");
      return runRecovery();
    }
    if (!recoveryComplete || recoveryFailure || externalTask) return runRecovery();
    return { recovered: true, pending: false };
  }

  async function ensureRecoveryInGate() {
    const outcome = await refreshRecoveryStateInGate();
    if (outcome.pending || recoveryFailure || externalTask) {
      throw serviceError("software_manager_pending_recovery", recoveryFailure ?? undefined);
    }
    return outcome;
  }

  function requestCatalogIds(service) {
    const entries = catalogEntries(service);
    return { entries, skillIds: new Set(entries.skills.map(({ id }) => id)) };
  }

  function validateRequest(request, service, ownership) {
    if (!isPlainRecord(request)) throw serviceError("software_manager_request_invalid");
    const keys = Object.keys(request);
    if (!keys.every((key) => REQUEST_KEYS.has(key)) || !["kind", "componentIds", "skillIds"].every((key) => Object.hasOwn(request, key))) {
      throw serviceError("software_manager_request_invalid");
    }
    if (!KINDS.has(request.kind)) throw serviceError("software_manager_request_invalid");
    const { skillIds: catalogSkillIds } = requestCatalogIds(service);
    for (const id of Object.keys(ownership?.skills ?? {})) {
      if (SKILL_ID.test(id)) catalogSkillIds.add(id);
    }
    const componentIds = validateIds(request.componentIds, {
      allowed: COMPONENT_SET,
      code: "software_manager_request_invalid",
    });
    const skillIds = validateIds(request.skillIds, {
      allowed: catalogSkillIds,
      pattern: SKILL_ID,
      code: "software_manager_request_invalid",
    });
    if (componentIds.length === 0 && skillIds.length === 0) throw serviceError("software_manager_request_invalid");
    if ((request.kind === "update" || request.kind === "rollback") && skillIds.length > 0) {
      throw serviceError("software_manager_request_invalid");
    }
    if (catalogFailure) throw serviceError("software_manager_catalog_unavailable", catalogFailure);
    if (Object.hasOwn(request, "installRootToken")
      && (typeof request.installRootToken !== "string" || !OPAQUE_TOKEN.test(request.installRootToken))) {
      throw serviceError("software_manager_request_invalid");
    }
    return Object.freeze({
      kind: request.kind,
      componentIds: Object.freeze(componentIds),
      skillIds: Object.freeze(skillIds),
      installRootToken: request.installRootToken ?? selectedInstallRootToken,
    });
  }

  async function callOne(adapters, id, method, context, resultAction = method) {
    try {
      const value = await adapterMethod(adapters, id, method)(context);
      return safeAdapterResult(value, { componentId: id, action: resultAction });
    } catch (error) {
      writeLog({ level: "error", taskId: currentTask?.taskId, componentId: id, phase: resultAction, message: stringError(error), details: error });
      return failedResult(id, resultAction, error);
    }
  }

  async function callSkills(adapters, action, context, requestedIds) {
    try {
      const values = await adapterMethod(adapters, "skills", action)(context);
      return safeSkillBatch(values, requestedIds, action);
    } catch (error) {
      writeLog({ level: "error", taskId: currentTask?.taskId, componentId: "skills", phase: action, message: stringError(error), details: error });
      return requestedIds.map((id) => failedResult(id, action, error));
    }
  }

  function beginCancellable(task, phase) {
    task.phaseNonce += 1;
    task.activePhaseNonce = task.phaseNonce;
    task.phase = phase;
    task.cancellable = !task.critical && !task.acceptedCancel;
    return task.activePhaseNonce;
  }

  function endCancellable(task, nonce) {
    if (currentTask === task && task.activePhaseNonce === nonce) {
      task.activePhaseNonce = null;
      task.cancellable = false;
    }
  }

  async function enterCritical(task, componentId, phase) {
    task.activePhaseNonce = null;
    task.cancellable = false;
    task.critical = true;
    await progress(componentId, phase, 100, false, "software_manager_critical_operation", undefined, true, task);
    await drainLogs();
  }

  function exitCritical(task) {
    if (currentTask !== task) return;
    task.critical = false;
    task.cancellable = false;
    task.activePhaseNonce = null;
  }

  function cancellableContext(componentId, task, nonce) {
    const signal = task.controller.signal;
    return {
      taskId: task.taskId,
      signal,
      onProgress(raw) {
        if (!isPlainRecord(raw) || currentTask !== task || task.activePhaseNonce !== nonce || task.critical) {
          return Promise.resolve();
        }
        return progress(
          componentId,
          typeof raw.phase === "string" ? raw.phase : "prepare",
          raw.percent,
          !signal.aborted && !task.acceptedCancel,
          typeof raw.message === "string" ? raw.message : "software_manager_preparing",
          raw,
          false,
          task,
        );
      },
    };
  }

  async function runPreparedComponent(adapters, id) {
    const task = currentTask;
    const nonce = beginCancellable(task, "prepare");
    await progress(id, "prepare", 0, true, "software_manager_preparing", undefined, false, task);
    const prepared = await callOne(adapters, id, "prepare", cancellableContext(id, task, nonce));
    endCancellable(task, nonce);
    await drainLogs();
    if (task.acceptedCancel) return failedResult(id, "prepare", serviceError("software_manager_cancelled"));
    if (prepared.status !== "succeeded") return prepared;
    await enterCritical(task, id, "commit");
    try { return await callOne(adapters, id, "commit", { taskId: task.taskId }); }
    finally { exitCritical(task); }
  }

  async function runUpdateComponent(adapters, service, id) {
    const task = currentTask;
    const nonce = beginCancellable(task, "inspect");
    await progress(id, "inspect", 0, true, "software_manager_inspecting", undefined, false, task);
    const inspected = await callOne(adapters, id, "inspectInstalled", {
      signal: task.controller.signal,
    }, "inspect");
    endCancellable(task, nonce);
    if (task.acceptedCancel) {
      return failedResult(id, "inspect", serviceError("software_manager_cancelled"));
    }
    if (inspected.status === "failed") return inspected;
    if (inspected.status === "succeeded" && inspected.versionAfter) {
      let comparison;
      try { comparison = compareVersions(service.getComponent(id).version, inspected.versionAfter); }
      catch (error) { return failedResult(id, "inspect", error); }
      if (comparison <= 0) {
        return safeAdapterResult({
          ...inspected,
          action: "update",
          status: "skipped",
          message: "software_manager_already_current",
        }, { componentId: id, action: "update" });
      }
    }
    return runPreparedComponent(adapters, id);
  }

  async function runPreparedSkills(adapters, ids) {
    if (ids.length === 0) return [];
    const task = currentTask;
    const discard = () => adapterMethod(adapters, "skills", "discardPrepared")({
      taskId: task.taskId, skillIds: ids,
    });
    try {
      const nonce = beginCancellable(task, "prepare");
      await progress("skills", "prepare", 0, true, "software_manager_preparing_skills", undefined, false, task);
      const prepared = await callSkills(adapters, "prepare", {
        ...cancellableContext("skills", task, nonce),
        skillIds: ids,
      }, ids);
      endCancellable(task, nonce);
      await drainLogs();
      if (task.acceptedCancel) {
        try {
          await discard();
        } catch (error) {
          return ids.map((id) => failedResult(id, "prepare", error));
        }
        return ids.map((id) => failedResult(id, "prepare", serviceError("software_manager_cancelled")));
      }
      const ready = prepared.filter(({ status }) => status === "succeeded").map(({ componentId }) => componentId);
      if (ready.length === 0) {
        await discard();
        return prepared;
      }
      let criticalEntered = false;
      let committed;
      try {
        await enterCritical(task, "skills", "commit");
        criticalEntered = true;
        committed = await callSkills(adapters, "commit", { taskId: task.taskId, skillIds: ready }, ready);
      } finally {
        if (criticalEntered) exitCritical(task);
        await discard().catch(() => {});
      }
      const committedById = new Map(committed.map((entry) => [entry.componentId, entry]));
      return prepared.map((entry) => entry.status === "succeeded" ? committedById.get(entry.componentId) ?? entry : entry);
    } catch (error) {
      await discard().catch(() => {});
      throw error;
    }
  }

  async function runCriticalComponent(adapters, id, action) {
    const task = currentTask;
    await enterCritical(task, id, action);
    try { return await callOne(adapters, id, action, { taskId: task.taskId, selected: true }); }
    finally { exitCritical(task); }
  }

  async function runCriticalSkills(adapters, ids, action) {
    if (ids.length === 0) return [];
    const task = currentTask;
    await enterCritical(task, "skills", action);
    try { return await callSkills(adapters, action, { taskId: task.taskId, skillIds: ids }, ids); }
    finally { exitCritical(task); }
  }

  async function startTask(rawRequest) {
    if (platform !== "win32") throw serviceError("software_manager_platform_disabled");
    if (quitReservation) throw serviceError("software_manager_quit_reserved");
    if (startReserved || currentTask) throw serviceError("software_manager_task_running");
    startReserved = true;
    return withEntryGate(async () => {
      try {
        if (quitReservation) throw serviceError("software_manager_quit_reserved");
        await ensureRecoveryInGate();
        if (quitReservation) throw serviceError("software_manager_quit_reserved");
        const service = await currentCatalog();
        if (!service) throw serviceError("software_manager_catalog_unavailable");
        const state = await loadOwnership();
        if (state?.activeTask) {
          externalTask = publicExternalTask(state.activeTask);
          recoveryFailure = serviceError("software_manager_pending_recovery");
          throw recoveryFailure;
        }
        const request = validateRequest(rawRequest, service, state);
        const adapters = await resolveAdapters(service, request.installRootToken);
        if (quitReservation) throw serviceError("software_manager_quit_reserved");
        await ensureRecoveryInGate();
        if (quitReservation) throw serviceError("software_manager_quit_reserved");
        const taskId = issueTaskId();
        const startedAt = now();
        const task = {
          taskId,
          kind: request.kind,
          phase: "starting",
          cancellable: true,
          critical: false,
          acceptedCancel: false,
          phaseNonce: 0,
          activePhaseNonce: null,
          controller: new AbortController(),
        };
        currentTask = task;
        startReserved = false;
        const components = [];
        let skills = [];
        if (request.kind === "install" || request.kind === "update") {
          for (const id of request.componentIds) {
            if (task.acceptedCancel) break;
            components.push(request.kind === "update"
              ? await runUpdateComponent(adapters, service, id)
              : await runPreparedComponent(adapters, id));
          }
          if (!task.acceptedCancel) skills = await runPreparedSkills(adapters, request.skillIds);
        } else {
          for (const id of request.componentIds) components.push(await runCriticalComponent(adapters, id, request.kind));
          skills = await runCriticalSkills(adapters, request.skillIds, request.kind);
        }
        task.phase = "finishing";
        task.cancellable = false;
        task.critical = false;
        task.activePhaseNonce = null;
        const result = deepFreeze(redactValue({
          taskId,
          kind: request.kind,
          status: summarizeStatus(components, skills, task.acceptedCancel),
          components,
          skills,
          startedAt,
          finishedAt: now(),
        }));
        await writeLog({ taskId, phase: "finished", message: `software_manager_task_${result.status}` });
        await drainLogs();
        emit({ type: "finished", taskId, result });
        return result;
      } finally {
        startReserved = false;
        currentTask = null;
      }
    });
  }

  async function buildSnapshot({ inspect = true, inspectionOverride = null } = {}) {
    if (platform !== "win32") {
      return snapshotValue({
        platform,
        enabled: false,
        readOnly: true,
        pendingRecovery: false,
        tabs: [],
        catalog: { available: false, components: [], skills: [] },
        components: [],
        skills: [],
        rollback: [],
        defaults: { install: { componentIds: [], skillIds: [] }, update: { componentIds: [], skillIds: [] } },
        task: null,
        logging: {
          degraded: loggingDegraded,
          pendingWrites: pendingLogWrites,
          error: loggingFailure ? "software_manager_log_sink_degraded" : null,
          recovery: loggingDegraded ? "restart-service" : null,
        },
        logs: [...uiLogs],
      });
    }
    const service = externalTask || recoveryFailure ? catalogService : await currentCatalog();
    const entries = catalogEntries(service);
    let inspected = inspectionOverride ?? lastInspection ?? { components: [], skills: [] };
    if (service && !catalogFailure && inspect && !currentTask && !externalTask && (fixedAdapters || selectedInstallRootToken)) {
      try {
        const ownership = await loadOwnership();
        inspected = await inspectAll(await resolveAdapters(service), entries, Object.keys(ownership?.skills ?? {}));
        lastInspection = inspected;
      }
      catch (error) { recoveryFailure = serviceError("software_manager_snapshot_failed", error); }
    }
    const inspectById = new Map(inspected.components.map((entry) => [entry.componentId, entry]));
    const components = entries.components.map((entry) => {
      const installed = inspectById.get(entry.id);
      let updateState = "not-installed";
      if (installed?.status === "failed") updateState = "error";
      else if (installed?.status === "succeeded" && installed.versionAfter) {
        try { updateState = compareVersions(entry.version, installed.versionAfter) > 0 ? "update-available" : "current"; }
        catch { updateState = "error"; }
      }
      return Object.freeze({
        ...entry,
        installedVersion: installed?.status === "succeeded" ? installed.versionAfter : null,
        updateState,
        rollbackAvailable: Boolean(installed?.rollbackAvailable),
      });
    });
    const rollback = components.filter(({ rollbackAvailable }) => rollbackAvailable)
      .map(({ id, name, installedVersion }) => Object.freeze({ id, name, version: installedVersion }));
    const tabs = ["install", "update", "uninstall"];
    if (rollback.length > 0) tabs.push("rollback");
    const task = currentTask
      ? { taskId: currentTask.taskId, kind: currentTask.kind, phase: currentTask.phase, cancellable: currentTask.cancellable, critical: currentTask.critical, external: false }
      : externalTask
        ? { ...externalTask, external: true, critical: true, cancellable: false, phase: externalTask.phase ?? externalTask.kind }
        : null;
    return snapshotValue({
      platform,
      enabled: true,
      readOnly: !service || Boolean(recoveryFailure) || Boolean(catalogFailure),
      pendingRecovery: Boolean(externalTask || recoveryFailure),
      tabs,
      catalog: { available: Boolean(service && !catalogFailure), components: entries.components, skills: entries.skills },
      components,
      skills: inspected.skills,
      rollback,
      defaults: {
        install: { componentIds: service && !catalogFailure ? ["chatgpt"] : [], skillIds: [] },
        update: { componentIds: components.filter(({ updateState }) => updateState === "update-available").map(({ id }) => id), skillIds: [] },
      },
      task,
      logging: {
        degraded: loggingDegraded,
        pendingWrites: pendingLogWrites,
        error: loggingFailure ? "software_manager_log_sink_degraded" : null,
        recovery: loggingDegraded ? "restart-service" : null,
      },
      logs: [...uiLogs],
    });
  }

  async function getSnapshot() {
    if (platform !== "win32") return buildSnapshot({ inspect: false });
    if (currentTask || startReserved) return buildSnapshot({ inspect: false });
    return withEntryGate(async () => {
      const before = await refreshRecoveryStateInGate();
      if (before.pending) return buildSnapshot({ inspect: false });
      await buildSnapshot();
      await refreshRecoveryStateInGate();
      return buildSnapshot({ inspect: false });
    });
  }

  async function refresh() {
    if (platform !== "win32") return buildSnapshot({ inspect: false });
    if (quitReservation) throw serviceError("software_manager_quit_reserved");
    return withEntryGate(async () => {
      if (quitReservation) throw serviceError("software_manager_quit_reserved");
      if (currentTask) throw serviceError("software_manager_task_running");
      await ensureRecoveryInGate();
      try {
        catalogService = typeof catalogProvider?.refresh === "function"
          ? await catalogProvider.refresh()
          : await currentCatalog();
        catalogFailure = catalogService ? null : serviceError("software_manager_catalog_unavailable");
      } catch (error) {
        catalogService = null;
        catalogFailure = serviceError("software_manager_catalog_unavailable", error);
      }
      await ensureRecoveryInGate();
      const snapshot = await buildSnapshot();
      await ensureRecoveryInGate();
      emit({ type: "snapshot", snapshot });
      return snapshot;
    });
  }

  async function chooseInstallRoot(candidate) {
    if (platform !== "win32") throw serviceError("software_manager_platform_disabled");
    if (quitReservation) throw serviceError("software_manager_quit_reserved");
    return withEntryGate(async () => {
      if (quitReservation) throw serviceError("software_manager_quit_reserved");
      if (currentTask) throw serviceError("software_manager_task_running");
      await ensureRecoveryInGate();
      let token = null;
      let adopted = false;
      try {
        const chosen = await installRootResolver.choose(candidate);
        token = typeof chosen === "string" ? chosen : chosen?.token;
        if (typeof token !== "string" || !OPAQUE_TOKEN.test(token)) {
          throw serviceError("software_manager_install_root_invalid");
        }
        await ensureRecoveryInGate();
        const service = await currentCatalog();
        const entries = catalogEntries(service);
        if (!service || catalogFailure) {
          throw serviceError("software_manager_catalog_unavailable", catalogFailure ?? undefined);
        }
        const ownership = await loadOwnership();
        const candidateInspection = await inspectAll(
          await resolveAdapters(service, token),
          entries,
          Object.keys(ownership?.skills ?? {}),
        );
        if ([...candidateInspection.components, ...candidateInspection.skills].some(({ status }) => status === "failed")) {
          throw serviceError("software_manager_snapshot_failed");
        }
        const snapshot = await buildSnapshot({ inspect: false, inspectionOverride: candidateInspection });
        await ensureRecoveryInGate();
        await installRootResolver.adopt(token);
        adopted = true;
        selectedInstallRootToken = token;
        lastInspection = candidateInspection;
        emit({ type: "snapshot", snapshot });
        return Object.freeze({ installRootToken: token });
      } catch (error) {
        if (!adopted && typeof token === "string" && token !== selectedInstallRootToken) {
          try {
            await installRootResolver.discard(token);
          } catch (discardError) {
            throw new AggregateError([error, discardError], error?.message || "software_manager_install_root_failed", {
              cause: error,
            });
          }
        }
        if (error?.code) throw error;
        throw serviceError("software_manager_snapshot_failed", error);
      }
    });
  }

  function cancelTask() {
    if (!currentTask) return externalTask
      ? { cancelled: false, reason: "critical" }
      : { cancelled: false, reason: "idle" };
    if (currentTask.acceptedCancel) return { cancelled: false, reason: "already_cancelled" };
    if (currentTask.critical) return { cancelled: false, reason: "critical" };
    if (!currentTask.cancellable) return { cancelled: false, reason: "not_cancellable" };
    currentTask.acceptedCancel = true;
    currentTask.activePhaseNonce = null;
    currentTask.cancellable = false;
    if (!currentTask.controller.signal.aborted) currentTask.controller.abort(serviceError("software_manager_cancelled"));
    void progress(null, "cancelling", null, false, "software_manager_cancelled", undefined, false, currentTask).catch(() => {});
    return { cancelled: true };
  }

  function hasCriticalTask() {
    return Boolean(currentTask?.critical || externalTask || recoveryFailure);
  }

  function prepareForQuit() {
    // beginQuit() owns the async recovery/entry gate. This remains synchronous
    // so the caller cannot accidentally await across a state transition.
    if (externalTask || recoveryFailure) return { allowQuit: false, reason: "critical" };
    if (!currentTask) return { allowQuit: true };
    if (currentTask.acceptedCancel) return { allowQuit: false, reason: "cancelling", canCancel: false };
    if (currentTask.critical) return { allowQuit: false, reason: "critical" };
    return { allowQuit: false, reason: "running", canCancel: Boolean(currentTask.cancellable) };
  }

  async function beginQuit() {
    if (quitReservation) throw serviceError("software_manager_quit_reserved");
    const reservation = Object.freeze(Object.create(null));
    quitReservation = reservation;
    try {
      if (currentTask) {
        // startTask already owns the entry gate for its full execution. The
        // synchronously published reservation blocks every later acceptance,
        // while this snapshot lets Main offer cancellation without waiting for
        // the running task to finish.
        await Promise.resolve();
        return Object.freeze({ ...prepareForQuit(), reservation });
      }
      const decision = await withEntryGate(async () => {
        await refreshRecoveryStateInGate();
        return prepareForQuit();
      });
      return Object.freeze({ ...decision, reservation });
    } catch (error) {
      if (quitReservation === reservation) quitReservation = null;
      throw error;
    }
  }

  function releaseQuit(reservation) {
    if (!reservation || quitReservation !== reservation) return false;
    quitReservation = null;
    return true;
  }

  async function refreshQuit(reservation) {
    if (!reservation || quitReservation !== reservation) {
      throw serviceError("software_manager_quit_reservation_invalid");
    }
    return withEntryGate(async () => {
      if (quitReservation !== reservation) throw serviceError("software_manager_quit_reservation_invalid");
      await refreshRecoveryStateInGate();
      return prepareForQuit();
    });
  }

  function subscribe(listener) {
    if (typeof listener !== "function") throw serviceError("software_manager_listener_invalid");
    if (listeners.size >= MAX_LISTENERS) throw serviceError("software_manager_listener_limit");
    const token = Symbol("software-manager-listener");
    const record = { listener, active: true, running: false, queue: [] };
    listeners.set(token, record);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      disconnectListener(token, record);
    };
  }

  return Object.freeze({
    getSnapshot,
    chooseInstallRoot,
    refresh,
    startTask,
    cancelTask,
    recoverPending,
    hasCriticalTask,
    prepareForQuit,
    beginQuit,
    refreshQuit,
    releaseQuit,
    subscribe,
  });
}
