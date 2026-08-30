import { spawnSync } from "node:child_process";

const executable = process.platform === "win32" ? "python" : "python3";
const result = spawnSync(
  executable,
  [
    "-B",
    "-m",
    "unittest",
    "discover",
    "-s",
    "deploy/codexbridge-installer",
    "-p",
    "test_*.py",
  ],
  {
    cwd: process.cwd(),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    stdio: "inherit",
    shell: false,
  },
);

if (result.error) {
  console.error(`installer_python_tests_unavailable: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
