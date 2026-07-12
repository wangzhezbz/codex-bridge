const { parentPort, workerData } = require("node:worker_threads");
const {
  legacyPortableDataCandidates,
  migrateLegacyPortableData,
} = require("./data-dir.cjs");

try {
  const targetDir = String(workerData?.targetDir || "").trim();
  const execPath = String(workerData?.execPath || process.execPath).trim();
  const result = migrateLegacyPortableData({
    targetDir,
    legacyDirs: legacyPortableDataCandidates({ execPath, targetDir }),
  });
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error?.stack || error?.message || String(error),
  });
}
