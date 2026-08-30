import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { removeOwnedTemporaryDirectory } from "./smoke-temp-cleanup.mjs";

const CHECK_SCRIPTS = Object.freeze([
  "check:history-worker",
  "check:responses-native-history",
  "check:model-selection",
  "check:software-manager-catalog",
  "check:software-manager-win32",
  "test:software-manager",
  "test:installer-python",
  "check:syntax",
  "check:chrome-extension-manager",
  "check:anthropic",
  "test:router",
  "test:desktop",
  "test:recovery",
]);

const npmCli = path.resolve(String(process.env.npm_execpath || ""));
if (!process.env.npm_execpath || !fs.existsSync(npmCli)) {
  throw new Error("Project check must be started through npm so npm_execpath is available.");
}
const parentTemp = path.resolve(os.tmpdir());
const checkTemp = fs.mkdtempSync(path.join(parentTemp, "cbcheck-"));
const childEnv = {
  ...process.env,
  TEMP: checkTemp,
  TMP: checkTemp,
  TMPDIR: checkTemp,
  CODEXBRIDGE_PROJECT_CHECK_TEMP: checkTemp,
};
let commandError = null;
let cleanupError = null;

try {
  for (const scriptName of CHECK_SCRIPTS) {
    const result = spawnSync(process.execPath, [npmCli, "run", scriptName], {
      cwd: process.cwd(),
      env: childEnv,
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const error = new Error(`Project check step failed: ${scriptName} (exit ${result.status})`);
      error.code = "project_check_step_failed";
      throw error;
    }
  }
} catch (error) {
  commandError = error;
} finally {
  try {
    removeOwnedTemporaryDirectory(checkTemp, {
      parentDirectory: parentTemp,
      requiredPrefix: "cbcheck-",
    });
  } catch (error) {
    cleanupError = error;
  }
}

if (commandError && cleanupError) {
  throw new AggregateError([commandError, cleanupError], "Project check and temporary cleanup both failed.");
}
if (commandError) throw commandError;
if (cleanupError) throw cleanupError;

console.log(`Project checks passed and temporary workspace was removed: ${checkTemp}`);
