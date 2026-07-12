import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

const options = JSON.parse(process.argv[2] || "{}");
const executable = String(options.executable || "");
const homeDir = String(options.homeDir || "");
const cwd = String(options.cwd || process.cwd());
const timeoutMs = Math.max(1000, Number(options.timeoutMs || 15000));

if (!executable) {
  process.stdout.write(JSON.stringify({ ok: false, code: "cli_not_found", error: "Codex CLI is missing." }));
  process.exit(0);
}

const child = spawn(executable, ["app-server"], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: {
    ...process.env,
    ...(homeDir ? { CODEX_HOME: path.join(homeDir, ".codex") } : {}),
  },
});
const lines = readline.createInterface({ input: child.stdout });
const responses = new Map();
let finished = false;
let appRetryRequested = false;
let appRetryTimer = null;

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (appRetryTimer) clearTimeout(appRetryTimer);
  try {
    child.stdin.end();
  } catch {
    // The probe may already have closed stdin while exiting.
  }
  if (process.platform === "win32" && Number.isInteger(child.pid)) {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    child.kill("SIGTERM");
  }
  process.stdout.write(JSON.stringify(result));
}

const timer = setTimeout(() => finish({
  ok: false,
  code: "timeout",
  error: `Codex app-server snapshot timed out after ${timeoutMs}ms.`,
}), timeoutMs);

function maybeFinishSnapshot() {
  if (!responses.has(1) || !responses.has(2)) return;
  const initialAppResponse = responses.get(1);
  const initialApps = Array.isArray(initialAppResponse?.result?.data)
    ? initialAppResponse.result.data
    : [];
  if (!initialAppResponse?.error && initialApps.length === 0 && !responses.has(3)) {
    if (!appRetryRequested) {
      appRetryRequested = true;
      appRetryTimer = setTimeout(() => {
        if (!finished) send({ method: "app/list", id: 3, params: { limit: 1000 } });
      }, 500);
    }
    return;
  }
  const appResponse = responses.get(3) || initialAppResponse;
  const skillResponse = responses.get(2);
  const skillGroups = Array.isArray(skillResponse?.result?.data) ? skillResponse.result.data : [];
  finish({
    ok: !appResponse?.error && !skillResponse?.error,
    apps: appResponse?.error
      ? { ok: false, items: [], code: "app_list_failed", error: appResponse.error.message }
      : { ok: true, items: appResponse?.result?.data || [], code: "ok" },
    skills: skillResponse?.error
      ? { ok: false, items: [], code: "skills_list_failed", error: skillResponse.error.message }
      : {
          ok: true,
          items: skillGroups.flatMap((group) => Array.isArray(group?.skills) ? group.skills : []),
          errors: skillGroups.flatMap((group) => Array.isArray(group?.errors) ? group.errors : []),
          code: "ok",
        },
  });
}

lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;
  responses.set(message.id, message);
  if (message.id === 0 && !message.error) {
    send({ method: "initialized", params: {} });
    send({ method: "app/list", id: 1, params: { limit: 1000 } });
    send({ method: "skills/list", id: 2, params: { cwds: [cwd], forceReload: true } });
    return;
  }
  maybeFinishSnapshot();
});

child.on("error", (error) => finish({
  ok: false,
  code: "start_failed",
  error: error.message,
}));

send({
  method: "initialize",
  id: 0,
  params: {
    clientInfo: { name: "codexbridge", title: "CodexBridge", version: "0.3.1" },
    capabilities: { experimentalApi: true },
  },
});
