import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import crypto from "node:crypto";

import { verifyGreenCodexDirectory } from "./chatgpt-green-converter.mjs";
import { removeOwnedTemporaryDirectory } from "../smoke-temp-cleanup.mjs";

const execFileAsync = promisify(execFile);

function smokeError(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function exactAbsolute(value, code) {
  const raw = String(value || "");
  if (!raw || !path.isAbsolute(raw) || path.normalize(raw) !== raw) throw smokeError(code);
  return path.resolve(raw);
}

function samePath(left, right) {
  const a = path.resolve(String(left || ""));
  const b = path.resolve(String(right || ""));
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function exists(filePath) {
  try { fs.lstatSync(filePath); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function normalizeProcesses(value) {
  if (!Array.isArray(value)) throw smokeError("green_smoke_process_output_invalid");
  return value.map((item) => Object.freeze({
    pid: Number(item.pid ?? item.ProcessId),
    parentPid: Number(item.parentPid ?? item.ParentProcessId ?? 0),
    name: String(item.name ?? item.Name ?? ""),
    executablePath: String(item.executablePath ?? item.ExecutablePath ?? ""),
    commandLine: String(item.commandLine ?? item.CommandLine ?? ""),
  })).filter((item) => Number.isSafeInteger(item.pid) && item.pid > 0);
}

function isExistingCodex(item) {
  const executable = path.basename(item.executablePath || item.name).toLocaleLowerCase("en-US");
  return executable === "chatgpt.exe"
    || (executable === "codex.exe" && /(?:^|\s)app-server(?:\s|$)/iu.test(item.commandLine));
}

function findEvidence(processes, root, launchedPid) {
  const entrypoint = path.join(root, "ChatGPT.exe");
  const appServerPath = path.join(root, "resources", "codex.exe");
  const main = processes.find((item) => item.pid === launchedPid && samePath(item.executablePath, entrypoint));
  if (!main) return null;
  const descendants = new Set([launchedPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of processes) {
      if (descendants.has(item.parentPid) && !descendants.has(item.pid)) {
        descendants.add(item.pid);
        changed = true;
      }
    }
  }
  const renderer = processes.find((item) => descendants.has(item.pid) && item.pid !== launchedPid
    && samePath(item.executablePath, entrypoint) && /(?:^|\s)--type=renderer(?:\s|$)/iu.test(item.commandLine));
  const appServer = processes.find((item) => descendants.has(item.pid) && item.pid !== launchedPid
    && samePath(item.executablePath, appServerPath) && /(?:^|\s)app-server(?:\s|$)/iu.test(item.commandLine));
  if (!renderer || !appServer) return null;
  const publicRecord = (item) => Object.freeze({
    pid: item.pid,
    parentPid: item.parentPid,
    name: item.name,
    executablePath: item.executablePath,
  });
  return Object.freeze({
    main: publicRecord(main),
    renderer: publicRecord(renderer),
    appServer: publicRecord(appServer),
  });
}

function validPage(pages) {
  if (!Array.isArray(pages)) throw smokeError("green_smoke_page_output_invalid");
  return pages.find((item) => item && item.type === "page" && typeof item.url === "string"
    && item.url !== "about:blank" && !item.url.startsWith("devtools://"));
}

function publicPageUrl(value) {
  const raw = String(value || "");
  const boundary = [raw.indexOf("?"), raw.indexOf("#")].filter((index) => index >= 0);
  return boundary.length ? raw.slice(0, Math.min(...boundary)) : raw;
}

async function defaultProcessInspector() {
  const command = [
    "$ErrorActionPreference='Stop'",
    "$items=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('ChatGPT.exe','codex.exe') } | ForEach-Object {",
    "@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;name=[string]$_.Name;executablePath=[string]$_.ExecutablePath;commandLine=[string]$_.CommandLine}",
    "})",
    "[Console]::Out.Write(($items | ConvertTo-Json -Compress))",
  ].join(";");
  const powershell = path.join(
    String(process.env.SystemRoot || "C:\\Windows"),
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
  );
  const { stdout } = await execFileAsync(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command,
  ], { env: Object.create(null), windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 });
  const parsed = stdout.trim() ? JSON.parse(stdout) : [];
  return normalizeProcesses(Array.isArray(parsed) ? parsed : [parsed]);
}

async function defaultGetFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function defaultLauncher({ executablePath, args, env }) {
  const child = spawn(executablePath, args, {
    cwd: path.dirname(executablePath), env, windowsHide: true, stdio: "ignore",
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  return Object.freeze({ pid: child.pid });
}

async function defaultPageInspector(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/json/list", timeout: 2_000 }, (response) => {
      if (response.statusCode !== 200) { response.resume(); reject(smokeError("green_smoke_page_http_invalid")); return; }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 256 * 1024) request.destroy(smokeError("green_smoke_page_output_invalid"));
        else chunks.push(chunk);
      });
      response.once("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (error) { reject(smokeError("green_smoke_page_output_invalid", error)); }
      });
    });
    request.once("timeout", () => request.destroy(smokeError("green_smoke_page_timeout")));
    request.once("error", reject);
  });
}

async function defaultTerminateProcessTree(pid) {
  await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    windowsHide: true, timeout: 20_000, maxBuffer: 256 * 1024,
  }).catch((error) => {
    if (!/not found|no running instance/iu.test(`${error?.stdout || ""}\n${error?.stderr || ""}`)) throw error;
  });
}

async function defaultWaitForExit(pid, processInspector, sleep) {
  const deadline = Date.now() + 20_000;
  while (Date.now() <= deadline) {
    if (!(await processInspector()).some((item) => Number(item.pid ?? item.ProcessId) === pid)) return true;
    await sleep(100);
  }
  return false;
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function writeReport(reportPath, report) {
  if (!reportPath) return;
  const target = exactAbsolute(reportPath, "green_smoke_report_path_invalid");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try { fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); }
  catch (error) {
    if (error?.code === "EEXIST") throw smokeError("green_smoke_report_exists", error);
    throw error;
  }
}

export async function smokeGreenCodex({
  inputPath,
  reportPath,
  verifyDirectory = verifyGreenCodexDirectory,
  processInspector = defaultProcessInspector,
  getFreePort = defaultGetFreePort,
  launcher = defaultLauncher,
  pageInspector = defaultPageInspector,
  terminateProcessTree = defaultTerminateProcessTree,
  waitForExit,
  sleep = defaultSleep,
  timeoutMs = 45_000,
  pollIntervalMs = 250,
  now = () => new Date().toISOString(),
} = {}) {
  const root = exactAbsolute(inputPath, "green_smoke_input_invalid");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 5_000) {
    throw smokeError("green_smoke_timeout_invalid");
  }
  const before = await verifyDirectory({ inputPath: root });
  const initial = normalizeProcesses(await processInspector());
  if (initial.some(isExistingCodex)) throw smokeError("green_smoke_existing_instance");

  const smokeParent = os.tmpdir();
  const userDataPath = path.join(smokeParent, `codex-green-smoke-${crypto.randomUUID()}`);
  fs.mkdirSync(userDataPath, { recursive: false });
  const port = await getFreePort();
  let launchedPid = 0;
  let processEvidence = null;
  let pageEvidence = null;
  let processTreeExited = false;
  let primaryError = null;
  try {
    const launched = await launcher({
      executablePath: path.join(root, "ChatGPT.exe"),
      args: [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"],
      env: { ...process.env, CODEX_ELECTRON_USER_DATA_PATH: userDataPath },
    });
    launchedPid = Number(launched?.pid);
    if (!Number.isSafeInteger(launchedPid) || launchedPid < 1) throw smokeError("green_smoke_launch_invalid");
    const deadline = Date.now() + timeoutMs;
    do {
      const processes = normalizeProcesses(await processInspector());
      processEvidence = findEvidence(processes, root, launchedPid) ?? processEvidence;
      try { pageEvidence = validPage(await pageInspector(port)) ?? pageEvidence; } catch { /* retry */ }
      if (processEvidence && pageEvidence) break;
      await sleep(pollIntervalMs);
    } while (Date.now() <= deadline);
    if (!processEvidence) throw smokeError("green_smoke_process_incomplete");
    if (!pageEvidence) throw smokeError("green_smoke_page_missing");
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors = [];
  if (launchedPid > 0) {
    try {
      await terminateProcessTree(launchedPid);
      processTreeExited = waitForExit
        ? await waitForExit(launchedPid)
        : await defaultWaitForExit(launchedPid, processInspector, sleep);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (exists(userDataPath)) {
    try {
      removeOwnedTemporaryDirectory(userDataPath, {
        parentDirectory: smokeParent,
        requiredPrefix: "codex-green-smoke-",
      });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryError && cleanupErrors.length) {
    throw new AggregateError([primaryError, ...cleanupErrors], primaryError.message, { cause: primaryError });
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "green_smoke_cleanup_failed");
  if (!processTreeExited) throw smokeError("green_smoke_cleanup_failed");
  const after = await verifyDirectory({ inputPath: root });
  if (after.contentTreeSha256 !== before.contentTreeSha256
    || after.officialVersion !== before.officialVersion
    || after.owlTemplateSha256 !== before.owlTemplateSha256) {
    throw smokeError("green_smoke_source_changed");
  }
  const report = Object.freeze({
    schemaVersion: 1,
    ok: true,
    checkedAt: new Date(now()).toISOString(),
    officialVersion: before.officialVersion,
    contentTreeSha256: before.contentTreeSha256,
    shellTemplateSha256: before.owlTemplateSha256,
    processEvidence,
    pageEvidence: Object.freeze({
      id: String(pageEvidence.id ?? ""), type: pageEvidence.type,
      url: publicPageUrl(pageEvidence.url), title: String(pageEvidence.title ?? ""),
    }),
    cleanupEvidence: Object.freeze({
      processTreeExited: true,
      userDataRemoved: !exists(userDataPath),
      userDataPath,
    }),
  });
  writeReport(reportPath, report);
  return report;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--input" && !values.inputPath) values.inputPath = argv[++index];
    else if (argv[index] === "--report" && !values.reportPath) values.reportPath = argv[++index];
    else throw smokeError("green_smoke_argument_invalid");
  }
  if (!values.inputPath || !values.reportPath) throw smokeError("green_smoke_argument_invalid");
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await smokeGreenCodex(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(report));
}
