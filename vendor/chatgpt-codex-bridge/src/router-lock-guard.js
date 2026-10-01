import {createHash} from "node:crypto";
import {realpath} from "node:fs/promises";
import net from "node:net";
import path from "node:path";

export const ROUTER_LOCK_PROTOCOL = "kernel-v1";

function aborted(signal) {
  const error = new Error(signal?.reason?.message || "Router lock wait aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(aborted(signal)); return; }
    const finish = error => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve();
    };
    const onAbort = () => finish(aborted(signal));
    const timer = setTimeout(() => finish(), ms);
    signal?.addEventListener("abort", onAbort, {once:true});
  });
}

async function endpointFor(lockPath) {
  const absolute = path.resolve(lockPath);
  const parent = await realpath(path.dirname(absolute));
  let canonical = path.join(parent, path.basename(absolute));
  if (process.platform === "win32") canonical = canonical.toLowerCase();
  const hash = createHash("sha256").update(`router-lock-guard-v1\0${canonical}`).digest("hex");
  if (process.platform === "win32") return `\\\\.\\pipe\\codex-bridge-router-${hash}`;
  if (process.platform === "linux") {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 20 || (major === 20 && minor < 8)) throw new Error("Router kernel locks on Linux require Node.js >=20.8");
    return `\0codex-bridge-router-${hash}`;
  }
  // No stale socket unlink: on other Unix platforms a crashed listener must
  // be investigated offline, rather than risking another owner's endpoint.
  // Must not depend on per-process TMPDIR, or two clients could bypass one another.
  return path.join("/tmp", `cbrg-${hash.slice(0,32)}.sock`);
}

function tryListen(endpoint) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(socket => socket.destroy());
    const onError = error => {
      if (error.code === "EADDRINUSE") resolve(null);
      else reject(error);
    };
    server.once("error", onError);
    server.listen(endpoint, () => {
      server.removeListener("error", onError);
      resolve(server);
    });
  });
}

/** Only closes our own bound listener. Never removes a competing owner's file. */
export async function acquireRouterLockGuard(lockPath, {signal, timeoutMs = 35_000} = {}) {
  if (signal?.aborted) throw aborted(signal);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError("Router lock timeout must be finite and nonnegative");
  const deadline = Date.now() + timeoutMs;
  const timeout = () => Object.assign(new Error(`Timed out waiting for Router kernel lock: ${path.basename(lockPath)}`), {code:"ROUTER_LOCK_TIMEOUT"});
  const endpoint = await endpointFor(lockPath);
  for (;;) {
    if (signal?.aborted) throw aborted(signal);
    if (Date.now() >= deadline) throw timeout();
    const server = await tryListen(endpoint);
    if (server) {
      let closing;
      const release = () => closing ||= new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
      if (signal?.aborted) { await release(); throw aborted(signal); }
      if (Date.now() >= deadline) { await release(); throw timeout(); }
      return release;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw timeout();
    }
    await pause(Math.min(20, remaining), signal);
  }
}
