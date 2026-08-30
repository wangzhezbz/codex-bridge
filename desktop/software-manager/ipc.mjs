const CHANNELS = Object.freeze({
  getSnapshot: "softwareManager:getSnapshot",
  selectInstallRoot: "softwareManager:selectInstallRoot",
  refresh: "softwareManager:refresh",
  startTask: "softwareManager:startTask",
  cancelTask: "softwareManager:cancelTask",
});

const COMPONENT_IDS = new Set(["chatgpt", "v2rayn", "git"]);
const TASK_KINDS = new Set(["install", "update", "uninstall", "rollback"]);
const START_KEYS = new Set(["kind", "componentIds", "skillIds", "installRootToken"]);
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{16,128}$/u;
const MAX_SELECTION = 64;

function ipcError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requireWindows(platform) {
  if (platform !== "win32") throw ipcError("software_manager_platform_disabled");
}

function rejectPayload() {
  throw ipcError("software_manager_payload_rejected");
}

function exactZeroArguments(args) {
  if (args.length !== 0) rejectPayload();
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateIdList(value, allowed) {
  if (!Array.isArray(value) || value.length > MAX_SELECTION) rejectPayload();
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== "string" || !ID.test(id) || !allowed.has(id) || seen.has(id)) rejectPayload();
    seen.add(id);
  }
  return [...value];
}

function snapshotSkillIds(snapshot) {
  const ids = new Set();
  for (const entry of snapshot?.catalog?.skills ?? []) {
    if (typeof entry?.id === "string" && ID.test(entry.id)) ids.add(entry.id);
  }
  for (const entry of snapshot?.skills ?? []) {
    const id = typeof entry?.componentId === "string" ? entry.componentId : entry?.id;
    if (typeof id === "string" && ID.test(id)) ids.add(id);
  }
  return ids;
}

function validateStartRequest(value, allowedSkills) {
  if (!isPlainRecord(value)) rejectPayload();
  const keys = Object.keys(value);
  if (!keys.every((key) => START_KEYS.has(key))
    || !["kind", "componentIds", "skillIds"].every((key) => Object.hasOwn(value, key))
    || !TASK_KINDS.has(value.kind)) rejectPayload();
  const request = {
    kind: value.kind,
    componentIds: validateIdList(value.componentIds, COMPONENT_IDS),
    skillIds: validateIdList(value.skillIds, allowedSkills),
  };
  if (Object.hasOwn(value, "installRootToken")) {
    if (typeof value.installRootToken !== "string" || !OPAQUE_TOKEN.test(value.installRootToken)) rejectPayload();
    request.installRootToken = value.installRootToken;
  }
  return Object.freeze(request);
}

function requireRegistrar(value) {
  if (!value || typeof value.handle !== "function") throw new TypeError("trusted ipc registrar required");
  return value;
}

function validateRootSelection(value) {
  if (!isPlainRecord(value)) throw ipcError("software_manager_response_invalid");
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "cancelled" && value.cancelled === true) {
    return Object.freeze({ cancelled: true });
  }
  if (keys.length === 1 && keys[0] === "installRootToken"
    && typeof value.installRootToken === "string" && OPAQUE_TOKEN.test(value.installRootToken)) {
    return Object.freeze({ installRootToken: value.installRootToken });
  }
  throw ipcError("software_manager_response_invalid");
}

export function registerSoftwareManagerIpc({
  ipcMain,
  platform = process.platform,
  getService,
  selectInstallRoot,
  sendEvent = () => {},
  cancelExternalTask = () => null,
} = {}) {
  const registrar = requireRegistrar(ipcMain);
  if (typeof getService !== "function" || typeof selectInstallRoot !== "function"
    || typeof sendEvent !== "function" || typeof cancelExternalTask !== "function") {
    throw new TypeError("software manager IPC dependencies are required");
  }

  let servicePromise = null;
  let subscribedService = null;
  const service = async () => {
    requireWindows(platform);
    if (!servicePromise) {
      servicePromise = Promise.resolve().then(getService).catch((error) => {
        servicePromise = null;
        throw error;
      });
    }
    const value = await servicePromise;
    if (!value || typeof value.subscribe !== "function") throw ipcError("software_manager_service_unavailable");
    if (subscribedService !== value) {
      value.subscribe((event) => sendEvent(event));
      subscribedService = value;
    }
    return value;
  };

  registrar.handle(CHANNELS.getSnapshot, async (_event, ...args) => {
    requireWindows(platform);
    exactZeroArguments(args);
    return (await service()).getSnapshot();
  });
  registrar.handle(CHANNELS.selectInstallRoot, async (_event, ...args) => {
    requireWindows(platform);
    exactZeroArguments(args);
    return validateRootSelection(await selectInstallRoot(await service()));
  });
  registrar.handle(CHANNELS.refresh, async (_event, ...args) => {
    requireWindows(platform);
    exactZeroArguments(args);
    return (await service()).refresh();
  });
  registrar.handle(CHANNELS.startTask, async (_event, ...args) => {
    requireWindows(platform);
    if (args.length !== 1) rejectPayload();
    const current = await service();
    const currentSnapshot = await current.getSnapshot();
    return current.startTask(validateStartRequest(args[0], snapshotSkillIds(currentSnapshot)));
  });
  registrar.handle(CHANNELS.cancelTask, async (_event, ...args) => {
    requireWindows(platform);
    exactZeroArguments(args);
    const external = cancelExternalTask();
    if (external && typeof external === "object") return external;
    return (await service()).cancelTask();
  });

  return Object.freeze({ channels: CHANNELS });
}

async function defaultWaitForTask(service, { timeoutMs = 30_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await service.getSnapshot();
    if (!snapshot?.task) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw ipcError("software_manager_cancel_timeout");
}

export async function prepareSoftwareManagerQuit({
  platform = process.platform,
  getService,
  showCritical = async () => {},
  confirmRunning = async () => "background",
  waitForTask = defaultWaitForTask,
} = {}) {
  if (platform !== "win32") return { allowQuit: true };
  if (typeof getService !== "function") throw new TypeError("software manager service provider required");
  const service = await getService();
  if (typeof service.beginQuit !== "function" || typeof service.releaseQuit !== "function"
    || typeof service.refreshQuit !== "function") {
    throw ipcError("software_manager_quit_contract_invalid");
  }
  const decision = await service.beginQuit();
  const reservation = decision?.reservation;
  let held = true;
  const releaseReservation = () => {
    if (!held) return false;
    held = false;
    return service.releaseQuit(reservation);
  };
  try {
    if (decision?.allowQuit === true) return { allowQuit: true, releaseReservation };
    if (decision?.reason !== "running" || decision.canCancel !== true) {
      await showCritical(decision?.reason ?? "critical");
      releaseReservation();
      return { allowQuit: false, reason: decision?.reason ?? "critical" };
    }

    const choice = await confirmRunning();
    if (choice !== "cancel-and-quit") {
      releaseReservation();
      return { allowQuit: false, reason: "background" };
    }
    const cancelled = service.cancelTask();
    if (cancelled?.cancelled !== true) {
      await showCritical(cancelled?.reason ?? "critical");
      releaseReservation();
      return { allowQuit: false, reason: cancelled?.reason ?? "critical" };
    }
    await waitForTask(service);
    const afterCancel = await service.refreshQuit(reservation);
    if (afterCancel?.allowQuit === true) return { allowQuit: true, releaseReservation };
    await showCritical(afterCancel?.reason ?? "critical");
    releaseReservation();
    return { allowQuit: false, reason: afterCancel?.reason ?? "critical" };
  } catch (error) {
    releaseReservation();
    throw error;
  }
}
