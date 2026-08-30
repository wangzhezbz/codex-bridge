const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { parentPort, workerData } = require("node:worker_threads");

async function main() {
  const homeDir = String(workerData?.homeDir || "");
  const env = workerData?.env && typeof workerData.env === "object" && !Array.isArray(workerData.env)
    ? workerData.env
    : {};
  if (!path.isAbsolute(homeDir) || path.normalize(homeDir) !== homeDir) {
    throw new Error("codex_cli_locator_home_invalid");
  }
  const moduleUrl = pathToFileURL(path.join(__dirname, "codex-locator.mjs")).href;
  const { locateCodexCliSync } = await import(moduleUrl);
  const result = locateCodexCliSync({ homeDir, env });
  parentPort.postMessage({ ok: true, cliTarget: String(result?.cliTarget || "") });
}

main().catch((error) => {
  parentPort.postMessage({ ok: false, error: error?.message || String(error) });
});
