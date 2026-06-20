import { spawn } from "node:child_process";
import electronPath from "electron";

const child = spawn(electronPath, ["desktop/main.cjs"], {
  env: {
    ...process.env,
    CODEXBRIDGE_DESKTOP_SMOKE: "1",
  },
  stdio: "inherit",
  windowsHide: true,
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});

