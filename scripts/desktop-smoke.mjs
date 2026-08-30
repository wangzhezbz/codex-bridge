import { spawn } from "node:child_process";
import electronPath from "electron";
import {
  cleanupSourceDesktopSmokeFixture,
  createSourceDesktopSmokeFixture,
} from "./desktop-smoke-fixture.mjs";

const fixture = createSourceDesktopSmokeFixture();

const child = spawn(electronPath, ["desktop/main.cjs"], {
  env: {
    ...process.env,
    CODEXBRIDGE_DESKTOP_SMOKE: "1",
    ...fixture.env,
  },
  stdio: "inherit",
  windowsHide: true,
});

let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  try {
    cleanupSourceDesktopSmokeFixture(fixture);
  } catch (error) {
    console.error(`Desktop smoke fixture cleanup failed: ${error?.message || error}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
}

child.once("error", (error) => {
  console.error(`Desktop smoke launch failed: ${error?.message || error}`);
  finish(1);
});
child.once("exit", finish);
