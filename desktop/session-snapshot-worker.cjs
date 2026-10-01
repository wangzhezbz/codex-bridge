const { parentPort, workerData } = require("node:worker_threads");

(async () => {
  try {
    const settings = await import("./settings.mjs");
    const homeDir = String(workerData?.homeDir || "").trim();
    const rawLimit = Number(workerData?.limit || 500);
    const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, 1000)
      : 500;
    const codexSessionTree = settings.listCodexSessionTree({ homeDir, limit });
    const codexSessions = Array.isArray(codexSessionTree?.sessions)
      ? codexSessionTree.sessions
      : settings.listCodexSessions({ homeDir, limit });
    const codexProjectRecoveryPlan = settings.codexProjectRecoveryPlan({
      homeDir,
      limit,
      sessionTree: codexSessionTree,
    });
    parentPort.postMessage({
      ok: true,
      result: {
        codexSessionTree,
        codexSessions,
        codexProjectRecoveryPlan,
      },
    });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: error?.stack || error?.message || String(error),
    });
  }
})();
