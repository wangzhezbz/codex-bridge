import { compareVersions, COMPONENT_IDS } from "../../shared/software-manager/catalog-schema.mjs";
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
  text = text.replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/giu, (match) => `${match.split(/\s/u, 1)[0]} [REDACTED]`);
  text = text.replace(/\b(?:sk|ghp|github_pat)-?[A-Za-z0-9_]{16,}\b/giu, "[REDACTED]");
  text = text.replace(/["']?\b(?:api[-_ ]?key|token|registration[-_ ]?code|credential|password|secret|注册码)\b["']?\s*[:=]\s*["']?[^\s,;"'}]+["']?/giu, (match) => {
    const separator = match.search(/[:=]/u);
    return separator === -1 ? "[REDACTED]" : `${match.slice(0, separator + 1)}[REDACTED]`;
  });
  text = text.replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/giu, (match) => `${match.slice(0, match.indexOf("//") + 2)}[REDACTED]@`);
  text = text.replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/giu, "$1?[REDACTED]");
  text = text.replace(/\b(?:subscription|proxy[-_ ]?subscription|订阅)\b\s*[:=]\s*[^\s,;"']+/giu, (match) => {
    const separator = match.search(/[:=]/u);
    return separator === -1 ? "[REDACTED]" : `${match.slice(0, separator + 1)}[REDACTED]`;
  });
  text = text.replace(/\b[A-Za-z]:\\(?:[^\s"'<>|]+\\)*[^\s"'<>|]*/gu, "[REDACTED_PATH]");
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

function validAdapterResult(value, fallback) {
  const keys = isPlainRecord(value) ? Object.keys(value) : [];
  return isPlainRecord(value)
    && keys.length === RESULT_KEYS.length && keys.every((key) => RESULT_KEY_SET.has(key))
    && value.componentId === fallback.componentId && value.action === fallback.action
    && RESULT_STATUSES.has(value.status)
    && (value.versionBefore === null || typeof value.versionBefore === "string")
    && (value.versionAfter === null || typeof value.versionAfter === "string")
    && typeof value.message === "string" && typeof value.rollbackAvailable === "boolean";
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
  const succeeded = all.filter(({ status }) => status === "succeeded").length;
  if (succeeded === all.length && all.length > 0) return "succeeded";
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
} = {}) {
  if (!catalogProvider && !initialCatalogService) throw serviceError("software_manager_catalog_provider_required");
  if (!fixedAdapters && typeof adapterFactory !== "function") throw serviceError("software_manager_adapters_required");
  const loadOwnership = requireMethod(ownershipStore, "load", "software_manager_ownership_store_required");
  if (typeof recoverTransactions !== "function") throw serviceError("software_manager_recovery_required");
  if (!installRootResolver || typeof installRootResolver.resolve !== "function"
    || typeof installRootResolver.choose !== "function" || typeof installRootResolver.getCurrentToken !== "function") {
    throw serviceError("software_manager_install_root_resolver_required");
  }
  if (!clock || typeof clock.now !== "function" || typeof taskIdFactory !== "function") {
    throw serviceError("software_manager_clock_invalid");
  }
  if (!Number.isSafeInteger(maxPendingLogWrites) || maxPendingLogWrites < 1 || maxPendingLogWrites > 1024) {
    throw serviceError("software_manager_log_limit_invalid");
  }

  const listeners = new Map();
  const uiLogs = [];
  let pendingLogWrites = 0;
  let logTail = Promise.resolve();
  const logSubmissions = new Set();
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
  let entryTail = Promise.resolve();
  const issuedTaskIds = new Set();
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
    if (typeof candidate !== "string" || !TASK_ID.test(candidate) || issuedTaskIds.has(candidate)) {
      do { candidate = `software-${randomUUID()}`; } while (issuedTaskIds.has(candidate));
    }
    issuedTaskIds.add(candidate);
    return candidate;
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

  function writeLog(raw) {
    const entry = memoryLog(raw);
    if (typeof logSink?.write !== "function" || loggingDegraded) return Promise.resolve();
    pendingLogWrites += 1;
    const write = logTail.then(() => logSink.write(entry)).catch((error) => {
      if (!loggingDegraded) {
        loggingDegraded = true;
        loggingFailure = redactValue(error);
        memoryLog({ level: "error", phase: "logging", message: "software_manager_log_sink_degraded", details: error });
      }
    }).finally(() => { pendingLogWrites -= 1; });
    logTail = write.catch(() => {});
    logSubmissions.add(write);
    write.finally(() => logSubmissions.delete(write)).catch(() => {});
    return pendingLogWrites >= maxPendingLogWrites ? write : Promise.resolve();
  }

  async function drainLogs() {
    while (logSubmissions.size > 0) await Promise.allSettled([...logSubmissions]);
    await logTail;
  }

  function emit(rawEvent) {
    const event = deepFreeze(redactValue(rawEvent));
    for (const record of listeners.values()) {
      record.chain = record.chain
        .then(() => record.active ? record.listener(event) : undefined)
        .catch(() => {});
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
      const before = await loadOwnership();
      if (before?.activeTask) {
        externalTask = deepFreeze(redactValue({
          ...before.activeTask,
          external: true,
          critical: true,
          cancellable: false,
        }));
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
      externalTask = state?.activeTask ? deepFreeze(redactValue({
        ...state.activeTask,
        external: true,
        critical: true,
        cancellable: false,
      })) : null;
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
      recoveryPromise = withEntryGate(() => runRecovery()).finally(() => { recoveryPromise = null; });
    }
    return recoveryPromise;
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
    return callOne(adapters, id, "commit", { taskId: task.taskId });
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
    const nonce = beginCancellable(task, "prepare");
    await progress("skills", "prepare", 0, true, "software_manager_preparing_skills", undefined, false, task);
    const prepared = await callSkills(adapters, "prepare", {
      ...cancellableContext("skills", task, nonce),
      skillIds: ids,
    }, ids);
    endCancellable(task, nonce);
    await drainLogs();
    if (task.acceptedCancel) {
      return ids.map((id) => failedResult(id, "prepare", serviceError("software_manager_cancelled")));
    }
    const ready = prepared.filter(({ status }) => status === "succeeded").map(({ componentId }) => componentId);
    if (ready.length === 0) return prepared;
    await enterCritical(task, "skills", "commit");
    const committed = await callSkills(adapters, "commit", { taskId: task.taskId, skillIds: ready }, ready);
    const committedById = new Map(committed.map((entry) => [entry.componentId, entry]));
    return prepared.map((entry) => entry.status === "succeeded" ? committedById.get(entry.componentId) ?? entry : entry);
  }

  async function runCriticalComponent(adapters, id, action) {
    const task = currentTask;
    await enterCritical(task, id, action);
    return callOne(adapters, id, action, { taskId: task.taskId, selected: true });
  }

  async function runCriticalSkills(adapters, ids, action) {
    if (ids.length === 0) return [];
    const task = currentTask;
    await enterCritical(task, "skills", action);
    return callSkills(adapters, action, { taskId: task.taskId, skillIds: ids }, ids);
  }

  async function startTask(rawRequest) {
    if (platform !== "win32") throw serviceError("software_manager_platform_disabled");
    if (startReserved || currentTask) throw serviceError("software_manager_task_running");
    startReserved = true;
    return withEntryGate(async () => {
      try {
        const recovered = await runRecovery();
        if (recovered.pending || recoveryFailure || externalTask) {
          throw serviceError("software_manager_pending_recovery", recoveryFailure ?? undefined);
        }
        const service = await currentCatalog();
        if (!service) throw serviceError("software_manager_catalog_unavailable");
        const state = await loadOwnership();
        if (state?.activeTask) {
          externalTask = deepFreeze(redactValue({
            ...state.activeTask,
            external: true,
            critical: true,
            cancellable: false,
          }));
          recoveryFailure = serviceError("software_manager_pending_recovery");
          throw recoveryFailure;
        }
        const request = validateRequest(rawRequest, service, state);
        const adapters = await resolveAdapters(service, request.installRootToken);
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

  async function buildSnapshot({ inspect = true } = {}) {
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
        logging: { degraded: loggingDegraded, pendingWrites: pendingLogWrites, error: loggingFailure ? "software_manager_log_sink_degraded" : null },
        logs: [...uiLogs],
      });
    }
    const service = externalTask || recoveryFailure ? catalogService : await currentCatalog();
    const entries = catalogEntries(service);
    if (service && !catalogFailure && inspect && !currentTask && !externalTask && (fixedAdapters || selectedInstallRootToken)) {
      try {
        const ownership = await loadOwnership();
        lastInspection = await inspectAll(await resolveAdapters(service), entries, Object.keys(ownership?.skills ?? {}));
      }
      catch (error) { recoveryFailure = serviceError("software_manager_snapshot_failed", error); }
    }
    const inspected = lastInspection ?? { components: [], skills: [] };
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
      logging: { degraded: loggingDegraded, pendingWrites: pendingLogWrites, error: loggingFailure ? "software_manager_log_sink_degraded" : null },
      logs: [...uiLogs],
    });
  }

  async function getSnapshot() {
    if (platform !== "win32") return buildSnapshot({ inspect: false });
    if (currentTask || startReserved) return buildSnapshot({ inspect: false });
    return withEntryGate(async () => {
      if (!recoveryComplete) await runRecovery();
      return buildSnapshot();
    });
  }

  async function refresh() {
    if (platform !== "win32") return buildSnapshot({ inspect: false });
    if (currentTask || startReserved) throw serviceError("software_manager_task_running");
    if (externalTask || recoveryFailure) throw serviceError("software_manager_pending_recovery", recoveryFailure ?? undefined);
    return withEntryGate(async () => {
      const recovered = await runRecovery();
      if (recovered.pending || externalTask || recoveryFailure) {
        throw serviceError("software_manager_pending_recovery", recoveryFailure ?? undefined);
      }
      try {
        catalogService = typeof catalogProvider?.refresh === "function"
          ? await catalogProvider.refresh()
          : await currentCatalog();
        catalogFailure = catalogService ? null : serviceError("software_manager_catalog_unavailable");
      } catch (error) {
        catalogService = null;
        catalogFailure = serviceError("software_manager_catalog_unavailable", error);
      }
      const snapshot = await buildSnapshot();
      emit({ type: "snapshot", snapshot });
      return snapshot;
    });
  }

  async function chooseInstallRoot(candidate) {
    if (platform !== "win32") throw serviceError("software_manager_platform_disabled");
    if (currentTask || startReserved) throw serviceError("software_manager_task_running");
    if (externalTask || recoveryFailure) throw serviceError("software_manager_pending_recovery", recoveryFailure ?? undefined);
    return withEntryGate(async () => {
      const recovered = await runRecovery();
      if (recovered.pending || externalTask || recoveryFailure) {
        throw serviceError("software_manager_pending_recovery", recoveryFailure ?? undefined);
      }
      const chosen = await installRootResolver.choose(candidate);
      const token = typeof chosen === "string" ? chosen : chosen?.token;
      if (typeof token !== "string" || !OPAQUE_TOKEN.test(token)) throw serviceError("software_manager_install_root_invalid");
      selectedInstallRootToken = token;
      const snapshot = await buildSnapshot();
      emit({ type: "snapshot", snapshot });
      return Object.freeze({ installRootToken: token });
    });
  }

  function cancelTask() {
    if (!currentTask) return externalTask
      ? { cancelled: false, reason: "critical" }
      : { cancelled: false, reason: "idle" };
    if (!currentTask.cancellable || currentTask.critical) return { cancelled: false, reason: "critical" };
    currentTask.acceptedCancel = true;
    currentTask.activePhaseNonce = null;
    currentTask.cancellable = false;
    if (!currentTask.controller.signal.aborted) currentTask.controller.abort(serviceError("software_manager_cancelled"));
    void progress(null, "cancelling", null, false, "software_manager_cancelled", undefined, false, currentTask).catch(() => {});
    return { cancelled: true };
  }

  function hasCriticalTask() {
    return Boolean(currentTask?.critical || externalTask);
  }

  function prepareForQuit() {
    if (externalTask) return { allowQuit: false, reason: "critical" };
    if (!currentTask) return { allowQuit: true };
    if (currentTask.critical) return { allowQuit: false, reason: "critical" };
    return { allowQuit: false, reason: "running", canCancel: true };
  }

  function subscribe(listener) {
    if (typeof listener !== "function") throw serviceError("software_manager_listener_invalid");
    if (listeners.size >= MAX_LISTENERS) throw serviceError("software_manager_listener_limit");
    const record = { listener, active: true, chain: Promise.resolve() };
    listeners.set(listener, record);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      record.active = false;
      listeners.delete(listener);
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
    subscribe,
  });
}
