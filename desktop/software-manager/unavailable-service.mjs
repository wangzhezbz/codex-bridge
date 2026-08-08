const ALLOWED_REASONS = new Set(["software_manager_startup_failed"]);

function unavailableError() {
  const error = new Error("software_manager_startup_unavailable");
  error.code = "software_manager_startup_unavailable";
  return error;
}

function snapshotValue(platform, reason) {
  return Object.freeze({
    platform,
    enabled: true,
    readOnly: true,
    pendingRecovery: true,
    unavailableReason: reason,
    tabs: Object.freeze(["install", "update", "uninstall"]),
    catalog: Object.freeze({ available: false, components: Object.freeze([]), skills: Object.freeze([]) }),
    components: Object.freeze([]),
    skills: Object.freeze([]),
    rollback: Object.freeze([]),
    defaults: Object.freeze({
      install: Object.freeze({ componentIds: Object.freeze([]), skillIds: Object.freeze([]) }),
      update: Object.freeze({ componentIds: Object.freeze([]), skillIds: Object.freeze([]) }),
    }),
    task: null,
    logging: Object.freeze({ degraded: false, pendingWrites: 0, error: null, recovery: null }),
    logs: Object.freeze([]),
  });
}

export function createUnavailableSoftwareManagerService({
  platform = process.platform,
  reason = "software_manager_startup_failed",
} = {}) {
  if (platform !== "win32" || !ALLOWED_REASONS.has(reason)) {
    throw new TypeError("software_manager_unavailable_service_invalid");
  }
  const snapshot = snapshotValue(platform, reason);
  const reject = async () => { throw unavailableError(); };
  return Object.freeze({
    getSnapshot: async () => snapshot,
    refresh: async () => snapshot,
    chooseInstallRoot: reject,
    startTask: reject,
    cancelTask: reject,
    subscribe() { return () => {}; },
    beginQuit: async () => Object.freeze({ allowQuit: true, reservation: null }),
    refreshQuit: async () => Object.freeze({ allowQuit: true, reservation: null }),
    releaseQuit: () => false,
  });
}
