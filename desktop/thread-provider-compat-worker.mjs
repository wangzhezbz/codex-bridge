import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import decoderModule from "./bounded-line-decoder.cjs";
import diagnostics from "./thread-provider-diagnostics.cjs";
import boundedFiles from "../shared/bounded-local-file.cjs";
import { locateCodexCliSync } from "./codex-locator.mjs";
import { codexBridgeProviderIdForMode, planThreadProviderCompatibility, repairThreadProviderCompatibility } from "./codex-provider.mjs";

const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;
const RECEIPT_CHECKPOINT_INTERVAL = 25;
const MAX_COMPATIBILITY_SESSIONS = 10000;
const MAX_CONFIGURATION_BYTES = 2 * 1024 * 1024;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validReceipt(value) {
  return value?.version === 2 && record(value.profiles) && Object.entries(value.profiles).every(([key, profile]) =>
    /^[a-f0-9]{64}$/.test(key) && record(profile) && record(profile.completed) &&
    Object.entries(profile.completed).every(([id, item]) =>
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) && record(item) &&
      ["openai", "codexbridge"].includes(item.provider) && typeof item.model === "string" &&
      item.model.trim() && item.model.length <= 256 && !/[\r\n\0]/.test(item.model)));
}

function databaseDirectories(codexHome, env) {
  return env.CODEX_SQLITE_HOME ? [path.resolve(env.CODEX_SQLITE_HOME)] : [codexHome, path.join(codexHome, "sqlite")];
}

function stateDatabaseNames(directory) {
  const files = [];
  for (const name of fs.readdirSync(directory)) {
    const match = /^state(?:_(\d+))?\.sqlite$/.exec(name);
    if (match) files.push({ name, version: match[1] === undefined ? -1n : BigInt(match[1]) });
  }
  files.sort((left, right) => left.version !== right.version
    ? left.version > right.version ? -1 : 1
    : left.name === right.name ? 0 : left.name > right.name ? -1 : 1);
  return files.map(({ name }) => name);
}

function compatibilityProfileKey(codexHome, env) {
  const identities = [process.platform];
  const identify = (file) => {
    if (!fs.existsSync(file)) { identities.push(path.resolve(file), "missing"); return; }
    const actual = fs.realpathSync(file), stat = fs.statSync(actual, { bigint: true });
    identities.push(process.platform === "win32" ? actual.toLowerCase() : actual, stat.dev, stat.ino, stat.birthtimeNs);
  };
  identify(codexHome);
  for (const directory of databaseDirectories(codexHome, env)) {
    identify(directory);
    if (fs.existsSync(directory)) for (const name of stateDatabaseNames(directory)) identify(path.join(directory, name));
  }
  return createHash("sha256").update(identities.join("\0")).digest("hex");
}

function loadCompatibilityReceipt(file) {
  const empty = () => ({ data: { version: 2, profiles: {} }, writeAllowed: true });
  let stat;
  try { stat = fs.lstatSync(file, { bigint: true }); }
  catch (error) {
    return error?.code === "ENOENT" ? empty() : { ...empty(), writeAllowed: false, cacheWarning: "receipt_unavailable" };
  }
  // A derived cache must not make us move a directory or follow a link.
  if (!stat.isFile()) return { ...empty(), writeAllowed: false, cacheWarning: "receipt_unavailable" };
  try {
    if (stat.size <= MAX_RECEIPT_BYTES) {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (validReceipt(data)) return { data, writeAllowed: true };
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) return { ...empty(), writeAllowed: false, cacheWarning: "receipt_unavailable" };
  }
  const backup = `${file}.backup-${randomUUID()}.json`;
  try {
    const current = fs.lstatSync(file, { bigint: true });
    if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size) throw new Error("receipt_changed");
    fs.renameSync(file, backup);
    return { ...empty(), cacheRecovered: true, cacheBackupPath: backup };
  } catch { return { ...empty(), writeAllowed: false, cacheWarning: "receipt_backup_failed" }; }
}

function writeCompatibilityReceipt(file, data) {
  const bytes = Buffer.from(JSON.stringify(data));
  if (bytes.length > MAX_RECEIPT_BYTES) throw new Error("receipt_too_large");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd = null, identity = null, renamed = false;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    identity = fs.fstatSync(fd, { bigint: true });
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    fs.renameSync(temporary, file); renamed = true;
  } finally {
    if (fd !== null) fs.closeSync(fd);
    if (!renamed && identity) {
      try {
        const current = fs.lstatSync(temporary, { bigint: true });
        if (current.isFile() && current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(temporary);
      } catch { /* Only this invocation's known temporary file may be removed. */ }
    }
  }
}

export function readCompatibilitySessions(codexHome, env = process.env) {
  const directories = databaseDirectories(codexHome, env);
  const sessions = new Map();
  for (const directory of directories) {
    if (!fs.existsSync(directory)) continue;
    const files = stateDatabaseNames(directory);
    for (const name of files) {
      const db = new DatabaseSync(path.join(directory, name), { readOnly: true });
      try {
        db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 1000");
        const columns = new Set(db.prepare("PRAGMA table_info(threads)").all().map((column) => column.name));
        if (!["id", "model", "model_provider", "source", "archived", "has_user_event"].every((key) => columns.has(key))) continue;
        const rows = db.prepare(`SELECT id, model, model_provider, source, archived, has_user_event, ${columns.has("thread_source") ? "thread_source" : "NULL AS thread_source"} FROM threads WHERE archived = 0 AND (has_user_event = 1${columns.has("thread_source") ? " OR thread_source = 'user'" : ""}) LIMIT ${MAX_COMPATIBILITY_SESSIONS + 1}`).all();
        if (rows.length > MAX_COMPATIBILITY_SESSIONS) throw new Error("thread_compatibility_scan_limit");
        for (const row of rows) {
          if (sessions.has(row.id)) continue;
          if (sessions.size >= MAX_COMPATIBILITY_SESSIONS) throw new Error("thread_compatibility_scan_limit");
          sessions.set(row.id, {
            id: row.id, model: row.model, modelProvider: row.model_provider, source: row.source,
            archived: Boolean(row.archived), hasUserEvent: Boolean(row.has_user_event), threadSource: row.thread_source,
          });
        }
      } finally { db.close(); }
    }
  }
  return [...sessions.values()];
}

function readCompatibilityConfiguration(configPath) {
  try {
    // Preserve linked configurations while retaining bounded, identity-checked file reads.
    return boundedFiles.readBoundedLocalFileSync(fs.realpathSync(configPath), { maxBytes: MAX_CONFIGURATION_BYTES }).buffer;
  } catch (error) {
    if (error?.code === "bounded_local_file_too_large") throw new Error("codex_configuration_too_large");
    if (error?.code === "bounded_local_file_changed") throw new Error("codex_configuration_changed");
    throw error;
  }
}

export async function runThreadProviderCompatibility({ codexHome, markerPath, mode, desktopTarget, executable, env = process.env, timeoutMs = 55000 } = {}) {
  if (!path.isAbsolute(codexHome || "") || !path.isAbsolute(markerPath || "")) throw new Error("invalid_compatibility_paths");
  const configPath = path.join(codexHome, "config.toml");
  const initialConfiguration = readCompatibilityConfiguration(configPath);
  const configuredProvider = initialConfiguration.toString("utf8").match(/^\s*model_provider\s*=\s*"([^"\r\n]+)"/m)?.[1];
  if (configuredProvider !== codexBridgeProviderIdForMode(mode)) throw new Error("codex_configuration_mode_mismatch");
  const originalConfigHash = createHash("sha256").update(initialConfiguration).digest("hex");
  const configHash = () => createHash("sha256").update(readCompatibilityConfiguration(configPath)).digest("hex");
  const profileKey = compatibilityProfileKey(codexHome, env);
  const receipt = loadCompatibilityReceipt(markerPath);
  const completed = { ...receipt.data.profiles[profileKey]?.completed };
  const cacheStatus = () => ({
    ...(receipt.cacheRecovered ? { cacheRecovered: true, cacheBackupPath: receipt.cacheBackupPath } : {}),
    ...(receipt.cacheWarning ? { cacheWarning: receipt.cacheWarning } : {}),
  });
  let unsaved = 0;
  const flushReceipt = () => {
    if (!unsaved) return;
    if (receipt.writeAllowed) {
      receipt.data.profiles[profileKey] = { completed };
      try { writeCompatibilityReceipt(markerPath, receipt.data); }
      catch { receipt.writeAllowed = false; receipt.cacheWarning = "receipt_write_failed"; }
    }
    unsaved = 0;
  };
  const candidates = planThreadProviderCompatibility(readCompatibilitySessions(codexHome, env), { mode, completed });
  if (!candidates.length) return { ok: true, updated: [], failed: [], planned: 0, ...cacheStatus() };
  const cliTarget = executable || locateCodexCliSync({ homeDir: path.dirname(codexHome), preferredTargets: desktopTarget ? [desktopTarget] : [], env: { ...env, CODEX_CLI_PATH: "" }, maxDurationMs: 8000 }).cliTarget;
  if (!cliTarget) return { ok: false, updated: [], failed: [], planned: candidates.length, code: "codex_cli_not_found", ...cacheStatus() };
  const child = spawn(cliTarget, ["app-server"], { cwd: codexHome, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...env, CODEX_HOME: codexHome } });
  child.stderr.resume();
  let sequence = 0, ended = false, terminalCode = "native_connection_closed";
  const deadline = Date.now() + Math.max(1000, Math.min(55000, timeoutMs));
  const pending = new Map();
  const rejectPending = (code) => { if (!ended) terminalCode = code; ended = true; for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Object.assign(new Error(terminalCode), { code: terminalCode })); } pending.clear(); };
  const decoder = decoderModule.createBoundedLineDecoder({ maxLineBytes: 2 * 1024 * 1024,
    onLine(line) {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (!record(message)) { rejectPending("native_response_invalid"); return; }
      if (message.method && message.id !== undefined) {
        child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "Background compatibility repair cannot approve or execute interactive requests." } }) + "\n");
        return;
      }
      const entry = pending.get(message.id); if (!entry) return;
      const hasResult = Object.hasOwn(message, "result"), hasError = Object.hasOwn(message, "error");
      if (hasResult === hasError || (hasError && !record(message.error))) {
        rejectPending("native_response_invalid");
        return;
      }
      pending.delete(message.id); clearTimeout(entry.timer);
      if (hasError) entry.reject(Object.assign(new Error("native_client_rejected_request"), { code: message.error.code }));
      else entry.resolve(message.result);
    }, onError: () => rejectPending("native_response_invalid"),
  });
  child.stdout.on("data", (chunk) => decoder.push(chunk));
  child.stdout.on("error", () => rejectPending("native_stdout_failed"));
  child.stdin.on("error", () => rejectPending("native_stdin_failed"));
  child.on("error", () => rejectPending("native_start_failed"));
  child.on("exit", () => rejectPending("native_process_exited"));
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (ended) return reject(Object.assign(new Error(terminalCode), { code: terminalCode }));
    if (Date.now() >= deadline) return reject(new Error("native_compatibility_timeout"));
    if (configHash() !== originalConfigHash) return reject(new Error("codex_configuration_changed"));
    const id = ++sequence;
    const timer = setTimeout(() => { rejectPending("native_request_timeout"); }, Math.max(1, Math.min(10000, deadline - Date.now())));
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ method, params, id }) + "\n");
  });
  try {
    await rpc("initialize", { clientInfo: { name: "codexbridge-provider-compatibility", version: "1" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    const activeIds = new Set(), cursors = new Set(), remainingIds = new Set(candidates.map((item) => item.id));
    let cursor = null;
    do {
      const page = await rpc("thread/list", { modelProviders: ["openai", "codexbridge", "codex-bridge"], sourceKinds: ["vscode", "cli"], archived: false, limit: 100, cursor });
      if (!Array.isArray(page?.data)) throw new Error("native_thread_list_invalid");
      for (const thread of page.data) if (typeof thread.id === "string") { activeIds.add(thread.id); remainingIds.delete(thread.id); }
      if (remainingIds.size === 0) break;
      cursor = page.nextCursor || null;
      if (activeIds.size > 10000 || (cursor && cursors.has(cursor))) throw new Error("native_thread_list_limit");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const result = await repairThreadProviderCompatibility({ rpc, candidates: candidates.filter((item) => activeIds.has(item.id)), onUpdated(candidate) {
      completed[candidate.id] = { provider: candidate.provider, model: candidate.model };
      unsaved += 1;
      if (unsaved >= RECEIPT_CHECKPOINT_INTERVAL) flushReceipt();
    } });
    flushReceipt();
    const unconfirmed = candidates.filter((item) => !activeIds.has(item.id)).map(({ id }) => ({ id, code: "thread_not_in_active_catalog" }));
    return { ...result, ok: result.ok && unconfirmed.length === 0, failed: [...result.failed, ...unconfirmed], planned: candidates.length, ...cacheStatus() };
  } finally {
    decoder.close(); rejectPending("native_connection_closed"); child.stdin.end();
    const exitDeadline = Date.now() + 1500;
    while (child.exitCode === null && child.signalCode === null && Date.now() < exitDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      if (process.platform === "win32") await new Promise((resolve) => execFile(path.win32.join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }, () => resolve()));
      else child.kill("SIGTERM");
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await runThreadProviderCompatibility(JSON.parse(process.argv[2] || "{}")); process.stdout.write(JSON.stringify({ ...result, updated: result.updated.map(({ id }) => ({ id })) })); }
  catch (error) { process.stdout.write(JSON.stringify({ ok: false, updated: [], failed: [], code: diagnostics.compatibilityFailureCode(error) })); process.exitCode = 1; }
}
