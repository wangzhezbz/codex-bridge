import { compareVersions, COMPONENT_IDS } from "../../shared/software-manager/catalog-schema.mjs";

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
  text = text.replace(/\bBearer\s+[^\s,;"']+/giu, "Bearer [REDACTED]");
  text = text.replace(/\b(?:api[-_ ]?key|token|registration[-_ ]?code|credential|password|secret)\b\s*[:=]\s*[^\s,;"']+/giu, (match) => {
    const separator = match.search(/[:=]/u);
    return separator === -1 ? "[REDACTED]" : `${match.slice(0, separator + 1)}[REDACTED]`;
  });
  text = text.replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/giu, (match) => `${match.slice(0, match.indexOf("//") + 2)}[REDACTED]@`);
  text = text.replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/giu, "$1?[REDACTED]");
  text = text.replace(/\b(?:subscription|proxy[-_ ]?subscription|订阅)\b\s*[:=]\s*[^\s,;"']+/giu, (match) => {
    const separator = match.search(/[:=]/u);
    return separator === -1 ? "[REDACTED]" : `${match.slice(0, separator + 1)}[REDACTED]`;
  });
  return text;
}

function sensitiveKey(key) {
  return /(?:authorization|api[-_]?key|token|registration[-_]?code|credential|password|secret|signature)/iu.test(key);
}

function redactValue(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value;
  if (value instanceof Error) {
    if (seen.has(value)) return "[REDACTED:CIRCULAR]";
    seen.add(value);
    const result = {
      name: redactString(value.name),
      message: redactString(value.message),
    };
    if (typeof value.code === "string") result.code = redactString(value.code);
    if (value.cause !== undefined) result.cause = redactValue(value.cause, seen);
    for (const key of Object.keys(value)) {
      if (key === "cause" || key === "code") continue;
      result[key] = sensitiveKey(key) ? "[REDACTED]" : redactValue(value[key], seen);
    }
    return result;
  }
  if (typeof value !== "object") return redactString(String(value));
  if (seen.has(value)) return "[REDACTED:CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, seen));
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = sensitiveKey(key) ? "[REDACTED]" : redactValue(entry, seen);
  }
  return result;
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

function safeAdapterResult(value, fallback) {
  if (!isPlainRecord(value)) return Object.freeze({ ...fallback, status: "failed", message: "software_manager_adapter_result_invalid" });
  const status = ["succeeded", "failed", "skipped"].includes(value.status) ? value.status : "failed";
  return Object.freeze(redactValue({
    componentId: typeof value.componentId === "string" ? value.componentId : fallback.componentId,
    action: typeof value.action === "string" ? value.action : fallback.action,
    status,
    versionBefore: typeof value.versionBefore === "string" ? value.versionBefore : null,
    versionAfter: typeof value.versionAfter === "string" ? value.versionAfter : null,
    message: typeof value.message === "string" ? value.message : `${fallback.componentId}_${fallback.action}_${status}`,
    rollbackAvailable: Boolean(value.rollbackAvailable),
  }));
}

function failedResult(componentId, action, error) {
  return safeAdapterResult({
    componentId,
    action,
    status: "failed",
    message: stringError(error),
    rollbackAvailable: false,
  }, { componentId, action });
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
  const completed = all.length - failed;
  if (failed === 0) return "succeeded";
  return completed > 0 ? "partial" : "failed";
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
  taskIdFactory = () => `software-${Date.now().toString(36)}`,
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

  const listeners = new Set();
  const uiLogs = [];
  let pendingLogWrites = 0;
  let catalogService = initialCatalogService;
  let recoveryPromise = null;
  let recoveryComplete = false;
  let recoveryFailure = null;
  let catalogFailure = null;
  let externalTask = null;
  let currentTask = null;
  let startReserved = false;
  let selectedInstallRootToken = installRootResolver.getCurrentToken() ?? null;
  let lastInspection = null;

  function now() {
    const value = clock.now();
    if (!Number.isSafeInteger(value) || value < 0) throw serviceError("software_manager_clock_invalid");
    return value;
  }

  function writeLog(raw) {
    const entry = Object.freeze(redactValue({ timestamp: now(), level: "info", ...raw }));
    uiLogs.push(entry);
    if (uiLogs.length > MAX_UI_LOG_LINES) uiLogs.splice(0, uiLogs.length - MAX_UI_LOG_LINES);
    if (typeof logSink?.write === "function" && pendingLogWrites < maxPendingLogWrites) {
      pendingLogWrites += 1;
      Promise.resolve()
        .then(() => logSink.write(entry))
        .catch(() => {})
        .finally(() => { pendingLogWrites -= 1; });
    }
    return entry;
  }

  function emit(rawEvent) {
    const event = Object.freeze(redactValue(rawEvent));
    for (const listener of [...listeners]) {
      try { listener(event); } catch { /* one renderer listener cannot break service state */ }
    }
  }

  function progress(componentId, phase, percent, cancellable, message, details, critical = false) {
    if (!currentTask) return;
    currentTask.phase = phase;
    currentTask.cancellable = Boolean(cancellable);
    currentTask.critical = Boolean(critical);
    const event = {
      type: "progress",
      taskId: currentTask.taskId,
      componentId,
      phase,
      percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
      cancellable: Boolean(cancellable),
      message: typeof message === "string" ? message : phase,
    };
    writeLog({ taskId: currentTask.taskId, componentId, phase, message: event.message, details });
    emit(event);
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
      skills = Array.isArray(result)
        ? result.map((entry, index) => safeAdapterResult(entry, { componentId: skillIds[index] ?? "skills", action: "inspect" }))
        : [failedResult("skills", "inspect", serviceError("software_manager_adapter_result_invalid"))];
    } catch (error) {
      skills = [failedResult("skills", "inspect", error)];
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
      const service = await currentCatalog();
      const entries = catalogEntries(service);
      const before = await loadOwnership();
      if (service && (fixedAdapters || selectedInstallRootToken)) {
        const adapters = await resolveAdapters(service);
        lastInspection = await inspectAll(adapters, entries, Object.keys(before?.skills ?? {}));
      }
      const state = await loadOwnership();
      externalTask = state?.activeTask ? redactValue({ ...state.activeTask, external: true }) : null;
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
    if (!recoveryPromise) recoveryPromise = runRecovery().finally(() => { recoveryPromise = null; });
    return recoveryPromise;
  }

  async function ensureRecovered() {
    if (!recoveryComplete || recoveryFailure || externalTask) await recoverPending();
    if (recoveryFailure || externalTask) throw serviceError("software_manager_pending_recovery", recoveryFailure ?? undefined);
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

  async function callOne(adapters, id, action, context) {
    try {
      const value = await adapterMethod(adapters, id, action)(context);
      return safeAdapterResult(value, { componentId: id, action });
    } catch (error) {
      writeLog({ level: "error", taskId: currentTask?.taskId, componentId: id, phase: action, message: stringError(error), details: error });
      return failedResult(id, action, error);
    }
  }

  async function callSkills(adapters, action, context, requestedIds) {
    try {
      const values = await adapterMethod(adapters, "skills", action)(context);
      if (!Array.isArray(values)) throw serviceError("software_manager_adapter_result_invalid");
      const byId = new Map(values.map((value) => [value?.componentId, value]));
      return requestedIds.map((id) => safeAdapterResult(byId.get(id), { componentId: id, action }));
    } catch (error) {
      writeLog({ level: "error", taskId: currentTask?.taskId, componentId: "skills", phase: action, message: stringError(error), details: error });
      return requestedIds.map((id) => failedResult(id, action, error));
    }
  }

  function cancellableContext(componentId) {
    const signal = currentTask.controller.signal;
    return {
      taskId: currentTask.taskId,
      signal,
      onProgress(raw) {
        if (!isPlainRecord(raw)) return;
        progress(
          componentId,
          typeof raw.phase === "string" ? raw.phase : "prepare",
          raw.percent,
          !signal.aborted,
          typeof raw.message === "string" ? raw.message : "software_manager_preparing",
          raw,
          false,
        );
      },
    };
  }

  async function runPreparedComponent(adapters, id) {
    progress(id, "prepare", 0, true, "software_manager_preparing");
    const prepared = await callOne(adapters, id, "prepare", cancellableContext(id));
    if (currentTask.controller.signal.aborted) return failedResult(id, "prepare", serviceError("software_manager_cancelled"));
    if (prepared.status !== "succeeded") return prepared;
    progress(id, "commit", 100, false, "software_manager_critical_operation", undefined, true);
    return callOne(adapters, id, "commit", { taskId: currentTask.taskId });
  }

  async function runUpdateComponent(adapters, service, id) {
    progress(id, "inspect", 0, true, "software_manager_inspecting");
    const inspected = await callOne(adapters, id, "inspectInstalled", {
      signal: currentTask.controller.signal,
    });
    if (currentTask.controller.signal.aborted) {
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
    progress("skills", "prepare", 0, true, "software_manager_preparing_skills");
    const prepared = await callSkills(adapters, "prepare", {
      ...cancellableContext("skills"),
      skillIds: ids,
    }, ids);
    if (currentTask.controller.signal.aborted) {
      return ids.map((id) => failedResult(id, "prepare", serviceError("software_manager_cancelled")));
    }
    const ready = prepared.filter(({ status }) => status === "succeeded").map(({ componentId }) => componentId);
    if (ready.length === 0) return prepared;
    progress("skills", "commit", 100, false, "software_manager_critical_operation", undefined, true);
    const committed = await callSkills(adapters, "commit", { taskId: currentTask.taskId, skillIds: ready }, ready);
    const committedById = new Map(committed.map((entry) => [entry.componentId, entry]));
    return prepared.map((entry) => entry.status === "succeeded" ? committedById.get(entry.componentId) ?? entry : entry);
  }

  async function runCriticalComponent(adapters, id, action) {
    progress(id, action, 0, false, "software_manager_critical_operation", undefined, true);
    return callOne(adapters, id, action, { taskId: currentTask.taskId, selected: true });
  }

  async function runCriticalSkills(adapters, ids, action) {
    if (ids.length === 0) return [];
    progress("skills", action, 0, false, "software_manager_critical_operation", undefined, true);
    return callSkills(adapters, action, { taskId: currentTask.taskId, skillIds: ids }, ids);
  }

  async function startTask(rawRequest) {
    if (platform !== "win32") throw serviceError("software_manager_platform_disabled");
    if (startReserved || currentTask) throw serviceError("software_manager_task_running");
    startReserved = true;
    let result;
    try {
      const taskId = taskIdFactory();
      if (typeof taskId !== "string" || !TASK_ID.test(taskId)) throw serviceError("software_manager_task_id_invalid");
      const startedAt = now();
      currentTask = {
        taskId,
        kind: typeof rawRequest?.kind === "string" ? rawRequest.kind : "pending",
        phase: "starting",
        cancellable: true,
        critical: false,
        controller: new AbortController(),
      };
      startReserved = false;
      const service = await currentCatalog();
      if (!service) throw serviceError("software_manager_catalog_unavailable");
      await ensureRecovered();
      const state = await loadOwnership();
      if (state?.activeTask) {
        externalTask = redactValue({ ...state.activeTask, external: true });
        recoveryFailure = serviceError("software_manager_pending_recovery");
        throw recoveryFailure;
      }
      const request = validateRequest(rawRequest, service, state);
      const adapters = await resolveAdapters(service, request.installRootToken);
      currentTask.kind = request.kind;
      const components = [];
      let skills = [];
      if (request.kind === "install" || request.kind === "update") {
        for (const id of request.componentIds) {
          if (currentTask.controller.signal.aborted) break;
          components.push(request.kind === "update"
            ? await runUpdateComponent(adapters, service, id)
            : await runPreparedComponent(adapters, id));
        }
        if (!currentTask.controller.signal.aborted) skills = await runPreparedSkills(adapters, request.skillIds);
      } else {
        for (const id of request.componentIds) components.push(await runCriticalComponent(adapters, id, request.kind));
        skills = await runCriticalSkills(adapters, request.skillIds, request.kind);
      }
      const cancelled = currentTask.controller.signal.aborted;
      result = Object.freeze(redactValue({
        taskId,
        kind: request.kind,
        status: summarizeStatus(components, skills, cancelled),
        components,
        skills,
        startedAt,
        finishedAt: now(),
      }));
      writeLog({ taskId, phase: "finished", message: `software_manager_task_${result.status}` });
      emit({ type: "finished", taskId, result });
      return result;
    } finally {
      startReserved = false;
      currentTask = null;
    }
  }

  async function buildSnapshot({ inspect = true } = {}) {
    if (platform !== "win32") {
      return Object.freeze({
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
        logs: [...uiLogs],
      });
    }
    if (!recoveryComplete && !currentTask) await recoverPending();
    const service = await currentCatalog();
    const entries = catalogEntries(service);
    if (service && inspect && !currentTask && !externalTask && (fixedAdapters || selectedInstallRootToken)) {
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
        ? { external: true, critical: !String(externalTask.kind ?? "").includes("prepare"), cancellable: false, phase: externalTask.phase ?? externalTask.kind }
        : null;
    return Object.freeze(redactValue({
      platform,
      enabled: true,
      readOnly: !service || Boolean(recoveryFailure) || Boolean(catalogFailure),
      pendingRecovery: Boolean(externalTask || recoveryFailure),
      tabs,
      catalog: { available: Boolean(service), components: entries.components, skills: entries.skills },
      components,
      skills: inspected.skills,
      rollback,
      defaults: {
        install: { componentIds: service ? ["chatgpt"] : [], skillIds: [] },
        update: { componentIds: components.filter(({ updateState }) => updateState === "update-available").map(({ id }) => id), skillIds: [] },
      },
      task,
      logs: [...uiLogs],
    }));
  }

  async function getSnapshot() {
    return buildSnapshot();
  }

  async function refresh() {
    if (platform !== "win32") return buildSnapshot({ inspect: false });
    if (currentTask || startReserved) throw serviceError("software_manager_task_running");
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
  }

  async function chooseInstallRoot(candidate) {
    if (platform !== "win32") throw serviceError("software_manager_platform_disabled");
    if (currentTask || startReserved) throw serviceError("software_manager_task_running");
    const chosen = await installRootResolver.choose(candidate);
    const token = typeof chosen === "string" ? chosen : chosen?.token;
    if (typeof token !== "string" || !OPAQUE_TOKEN.test(token)) throw serviceError("software_manager_install_root_invalid");
    selectedInstallRootToken = token;
    const snapshot = await buildSnapshot();
    emit({ type: "snapshot", snapshot });
    return Object.freeze({ installRootToken: token });
  }

  function cancelTask() {
    if (!currentTask) return { cancelled: false, reason: "idle" };
    if (!currentTask.cancellable || currentTask.critical) return { cancelled: false, reason: "critical" };
    if (!currentTask.controller.signal.aborted) currentTask.controller.abort(serviceError("software_manager_cancelled"));
    return { cancelled: true };
  }

  function hasCriticalTask() {
    return Boolean(currentTask?.critical);
  }

  function prepareForQuit() {
    if (!currentTask) return { allowQuit: true };
    if (currentTask.critical) return { allowQuit: false, reason: "critical" };
    return { allowQuit: false, reason: "running", canCancel: true };
  }

  function subscribe(listener) {
    if (typeof listener !== "function") throw serviceError("software_manager_listener_invalid");
    listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
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
