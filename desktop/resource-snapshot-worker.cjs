const { parentPort, workerData } = require("node:worker_threads");

(async () => {
  try {
    const settings = await import("./settings.mjs");
    const result = settings.readCodexResourceSnapshots(workerData?.options || {});
    parentPort.postMessage({ ok: true, result });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: error?.stack || error?.message || String(error),
    });
  }
})();
