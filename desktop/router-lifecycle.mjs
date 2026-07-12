import { EventEmitter } from "node:events";

const DEFAULT_SPAWN_TIMEOUT_MS = 5000;
const DEFAULT_GRACEFUL_STOP_TIMEOUT_MS = 2000;
const DEFAULT_FORCE_STOP_TIMEOUT_MS = 3000;
const DEFAULT_QUIT_CLEANUP_TIMEOUT_MS = 5000;

export function createRouterLifecycleController(dependencies = {}) {
  const deps = normalizeDependencies(dependencies);
  let queueTail = Promise.resolve();
  let activeProcess = null;
  let phase = "stopped";
  let startPromise = null;
  let startToken = null;
  let quitPromise = null;
  let quitRequested = false;
  let shutdownRequests = 0;
  let lifecycleGeneration = 0;

  function enqueue(operation) {
    const run = queueTail.then(operation, operation);
    queueTail = run.then(() => undefined, () => undefined);
    return run;
  }

  function start(options = {}) {
    if (startPromise) {
      return startPromise;
    }
    if (shutdownRequests > 0 || quitRequested) {
      return Promise.reject(lifecycleError(
        "ROUTER_LIFECYCLE_SHUTDOWN_PENDING",
        "Router cannot start while stop or quit is pending.",
      ));
    }
    if (activeProcess) {
      if (phase === "running") {
        return Promise.resolve({ ok: true, alreadyRunning: true, message: "Router is already running." });
      }
      return Promise.reject(lifecycleError(
        "ROUTER_LIFECYCLE_PROCESS_PRESENT",
        "Router cannot start while a previous child process still requires confirmed shutdown.",
      ));
    }

    const token = { cancelled: false, reason: "" };
    startToken = token;
    const operation = enqueue(() => runStart(token, options));
    const tracked = operation.finally(() => {
      if (startToken === token) {
        startToken = null;
      }
      if (startPromise === tracked) {
        startPromise = null;
      }
    });
    startPromise = tracked;
    return tracked;
  }

  function stop(options = {}) {
    lifecycleGeneration += 1;
    shutdownRequests += 1;
    cancelStart("stop");
    const operation = enqueue(() => runStop(options));
    return operation.finally(() => {
      shutdownRequests = Math.max(0, shutdownRequests - 1);
    });
  }

  function quit(options = {}) {
    if (quitPromise) {
      return quitPromise;
    }
    lifecycleGeneration += 1;
    quitRequested = true;
    shutdownRequests += 1;
    cancelStart("quit");
    safeInvoke(deps.onQuitRequested, options);
    let succeeded = false;
    const operation = enqueue(() => runQuit(options)).then((result) => {
      succeeded = true;
      return result;
    });
    const tracked = operation.finally(() => {
      shutdownRequests = Math.max(0, shutdownRequests - 1);
      if (!succeeded) {
        quitRequested = false;
      }
      if (quitPromise === tracked) {
        quitPromise = null;
      }
    });
    quitPromise = tracked;
    return tracked;
  }

  function cancelStart(reason) {
    if (!startToken) {
      return;
    }
    startToken.cancelled = true;
    startToken.reason = reason;
  }

  async function runBestEffort(callback, phaseName, ...args) {
    try {
      await callback(...args);
    } catch (error) {
      try {
        await deps.onInternalError(error, phaseName);
      } catch {
        // Lifecycle diagnostics must not change the completed lifecycle outcome.
      }
    }
  }

  async function runStart(token, options) {
    let prepared = null;
    let child = null;
    let executorEnsureAttempted = false;
    const executorWasRunning = Boolean(deps.isLocalExecutorRunning());
    let processWatch = null;
    phase = "starting";

    try {
      throwIfCancelled(token, "before_prepare");
      prepared = await deps.prepareStart(options);
      throwIfCancelled(token, "after_prepare");

      executorEnsureAttempted = true;
      const executor = await deps.ensureLocalExecutor(options);
      throwIfCancelled(token, "after_executor");

      child = await deps.spawnRouter({ prepared, executor, options });
      assertChildProcess(child);
      activeProcess = child;
      safeInvoke(deps.onProcessAssigned, child);
      processWatch = watchProcess(child, token);

      const spawnOutcome = await Promise.race([
        Promise.resolve(deps.waitForSpawn(child, options)).then(
          (value) => ({ type: "spawn", value }),
          (error) => ({ type: "error", error }),
        ),
        processWatch.earlyExit.promise.then((details) => ({ type: "exit", details })),
      ]);
      if (spawnOutcome.type === "exit") {
        throw processExitedDuringStart(spawnOutcome.details, "spawn");
      }
      if (spawnOutcome.type === "error") {
        throw spawnOutcome.error;
      }
      throwIfCancelled(token, "after_spawn");

      const healthOutcome = await Promise.race([
        Promise.resolve(deps.checkHealth(prepared, {
          isStillStarting: () => activeProcess === child && !token.cancelled,
          options,
        })).then(
          (health) => ({ type: "health", health }),
          (error) => ({ type: "error", error }),
        ),
        processWatch.earlyExit.promise.then((details) => ({ type: "exit", details })),
      ]);
      if (healthOutcome.type === "exit") {
        throw processExitedDuringStart(healthOutcome.details, "health");
      }
      if (healthOutcome.type === "error") {
        throw healthOutcome.error;
      }
      if (!healthOutcome.health?.ok) {
        const error = lifecycleError(
          "ROUTER_START_HEALTH_FAILED",
          `Router health check failed: ${healthOutcome.health?.message || "unknown error"}`,
        );
        error.health = healthOutcome.health;
        throw error;
      }
      throwIfCancelled(token, "after_health");
      if (activeProcess !== child) {
        throw processExitedDuringStart({ code: child.exitCode, signal: child.signalCode }, "publish");
      }

      await runBestEffort(
        deps.publishReady,
        "publish_ready",
        { prepared, health: healthOutcome.health, process: child, options },
      );
      throwIfCancelled(token, "after_publish");
      if (activeProcess !== child) {
        throw processExitedDuringStart({ code: child.exitCode, signal: child.signalCode }, "published");
      }
      processWatch.markReady();
      phase = "running";
      return {
        ok: true,
        alreadyRunning: false,
        message: options.watchdog ? "Router restarted." : "Router started.",
        health: healthOutcome.health,
        prepared,
      };
    } catch (error) {
      phase = "start_failed";
      const rollbackErrors = [];
      if (child && !hasProcessExited(child)) {
        try {
          await deps.terminateProcess(child, { reason: "start_failed" });
        } catch (stopError) {
          rollbackErrors.push({ phase: "process_stop", error: stopError });
        }
      }
      if (child && hasProcessExited(child)) {
        clearActiveProcess(child);
      }
      if (executorEnsureAttempted && !executorWasRunning) {
        try {
          await deps.stopLocalExecutor({ reason: "start_failed" });
        } catch (executorError) {
          rollbackErrors.push({ phase: "executor_stop", error: executorError });
        }
      }
      if (prepared) {
        try {
          await deps.cleanupManagedConfig({ reason: "start_failed" });
        } catch (cleanupError) {
          rollbackErrors.push({ phase: "managed_cleanup", error: cleanupError });
        }
      }
      phase = activeProcess ? "stop_failed" : "stopped";
      safeInvoke(deps.onStartFailed, error, { rollbackErrors, options });
      if (rollbackErrors.length) {
        const rollbackError = lifecycleError(
          "ROUTER_START_ROLLBACK_FAILED",
          "Router start failed and lifecycle rollback did not complete safely.",
        );
        rollbackError.cause = error;
        rollbackError.rollbackPhases = rollbackErrors.map((item) => item.phase);
        throw rollbackError;
      }
      throw error;
    } finally {
      processWatch?.disposeEarlyListeners();
    }
  }

  async function runStop(options) {
    const previousPhase = phase;
    phase = "stopping";
    try {
      let cleanup;
      let warning = null;
      try {
        cleanup = await deps.cleanupManagedConfig({ reason: options.source || "stop" });
      } catch (error) {
        try {
          await deps.onInternalError(error, "managed_cleanup");
        } catch {
          // Cleanup diagnostics must not block an explicit Router stop.
        }
        cleanup = {
          ok: false,
          removed: false,
          reason: "cleanup_failed",
          causeCode: safeCauseCode(error?.causeCode || error?.code),
        };
        warning = {
          code: "managed_config_cleanup_failed",
          causeCode: cleanup.causeCode,
        };
      }
      const child = activeProcess;
      if (child) {
        await deps.terminateProcess(child, { reason: "stop" });
        if (!hasProcessExited(child)) {
          throw lifecycleError(
            "ROUTER_STOP_UNCONFIRMED",
            "Router termination returned without a confirmed process exit.",
          );
        }
        clearActiveProcess(child);
      }
      await deps.stopLocalExecutor({ reason: "stop" });
      phase = "stopped";
      await runBestEffort(deps.publishStopped, "publish_stopped", { cleanup, warning, options });
      return { ok: true, cleanup, warning };
    } catch (error) {
      phase = activeProcess
        ? previousPhase === "running" ? "running" : "stop_failed"
        : "stopped";
      throw error;
    }
  }

  async function runQuit(options) {
    phase = "quit_cleanup";
    try {
      const cleanupPromise = Promise.resolve().then(() =>
        deps.cleanupManagedConfig({ reason: options.reason || "quit" })
      );
      let cleanup;
      let warning = null;
      try {
        cleanup = await awaitCleanupWithTimeoutNotice(cleanupPromise, options);
      } catch (error) {
        try {
          await deps.onInternalError(error, "managed_cleanup");
        } catch {
          // Cleanup diagnostics must not block an explicit application quit.
        }
        cleanup = {
          ok: false,
          removed: false,
          reason: "cleanup_failed",
          causeCode: safeCauseCode(error?.causeCode || error?.code),
        };
        warning = {
          code: "managed_config_cleanup_failed",
          causeCode: cleanup.causeCode,
        };
      }
      const child = activeProcess;
      if (child) {
        await deps.terminateProcess(child, { reason: "quit" });
        if (!hasProcessExited(child)) {
          throw lifecycleError(
            "ROUTER_QUIT_STOP_UNCONFIRMED",
            "Router did not confirm exit, so application quit was cancelled.",
          );
        }
        clearActiveProcess(child);
      }
      await deps.stopLocalExecutor({ reason: "quit" });
      phase = "quit_ready";
      await deps.onQuitReady({ cleanup, warning, options });
      await deps.quitApp({ cleanup, warning, options });
      return { ok: true, cleanup, warning };
    } catch (error) {
      phase = activeProcess ? "running" : "stopped";
      safeInvoke(deps.onQuitFailed, error, options);
      throw error;
    }
  }

  async function awaitCleanupWithTimeoutNotice(cleanupPromise, options) {
    let timedOut = false;
    const timer = deps.setTimeoutFn(() => {
      timedOut = true;
      safeInvoke(deps.onQuitCleanupTimeout, {
        reason: options.reason || "quit",
        timeoutMs: deps.quitCleanupTimeoutMs,
      });
    }, deps.quitCleanupTimeoutMs);
    timer?.unref?.();
    try {
      const result = await cleanupPromise;
      if (timedOut) {
        safeInvoke(deps.onQuitCleanupLateSuccess, result, options);
      }
      return result;
    } finally {
      deps.clearTimeoutFn(timer);
    }
  }

  function watchProcess(child, token) {
    const earlyExit = deferred();
    const watchedGeneration = lifecycleGeneration;
    let ready = false;
    let disposed = false;
    let exitSeen = false;

    const onExit = (code, signal) => {
      if (exitSeen) {
        return;
      }
      exitSeen = true;
      const details = {
        code,
        signal,
        causeCode: safeChildStartFailureCode(child),
        process: child,
        isCurrent: () =>
          watchedGeneration === lifecycleGeneration &&
          shutdownRequests === 0 &&
          !quitRequested,
      };
      const isCurrent = details.isCurrent();
      clearActiveProcess(child);
      child.removeListener("error", onError);
      if (!ready) {
        if (disposed) {
          phase = "stopped";
        }
        earlyExit.resolve(details);
        return;
      }
      phase = "stopped";
      if (!isCurrent || token.cancelled) {
        return;
      }
      Promise.resolve(deps.onUnexpectedExit(details)).catch((error) => {
        safeInvoke(deps.onInternalError, error, "unexpected_exit");
      });
    };
    const onError = (error) => {
      safeInvoke(deps.onProcessError, error, child);
      if (!ready && !exitSeen) {
        earlyExit.resolve({
          code: null,
          signal: null,
          causeCode: safeChildStartFailureCode(child),
          process: child,
          error,
        });
      }
    };
    child.once("exit", onExit);
    child.on("error", onError);

    return {
      earlyExit,
      markReady() {
        ready = true;
      },
      disposeEarlyListeners() {
        if (disposed) {
          return;
        }
        disposed = true;
        if (exitSeen || (!ready && activeProcess !== child)) {
          child.removeListener("exit", onExit);
          child.removeListener("error", onError);
        }
      },
    };
  }

  function clearActiveProcess(child) {
    if (activeProcess !== child) {
      return;
    }
    activeProcess = null;
    safeInvoke(deps.onProcessCleared, child);
  }

  function snapshot() {
    return Object.freeze({
      phase,
      hasProcess: Boolean(activeProcess),
      startInFlight: Boolean(startPromise),
      shutdownPending: shutdownRequests > 0,
      quitRequested,
    });
  }

  return Object.freeze({ start, stop, quit, snapshot });
}

export async function waitForChildSpawn(child, {
  timeoutMs = DEFAULT_SPAWN_TIMEOUT_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  assertChildProcess(child);
  if (Number.isInteger(child.pid) && child.pid > 0) {
    return true;
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeoutFn(timer);
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      callback(value);
    };
    const onSpawn = () => finish(resolve, true);
    const onError = (error) => finish(reject, error);
    const onExit = (code, signal) => finish(
      reject,
      processExitedDuringStart({
        code,
        signal,
        causeCode: safeChildStartFailureCode(child),
      }, "spawn"),
    );
    const timer = setTimeoutFn(() => finish(
      reject,
      lifecycleError(
        "ROUTER_SPAWN_TIMEOUT",
        `Router process did not report spawn within ${timeoutMs} ms.`,
      ),
    ), timeoutMs);
    timer?.unref?.();
    child.once("spawn", onSpawn);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

export async function terminateChildProcess(child, {
  gracefulTimeoutMs = DEFAULT_GRACEFUL_STOP_TIMEOUT_MS,
  forceTimeoutMs = DEFAULT_FORCE_STOP_TIMEOUT_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  assertChildProcess(child);
  if (hasProcessExited(child)) {
    return { exited: true, forced: false, alreadyExited: true };
  }

  const watcher = createExitWatcher(child);
  try {
    const gracefulAccepted = requestKill(child, undefined, "ROUTER_STOP_SIGNAL_REJECTED");
    if (!gracefulAccepted && !hasProcessExited(child)) {
      throw lifecycleError(
        "ROUTER_STOP_SIGNAL_REJECTED",
        "Router process rejected the graceful stop signal.",
      );
    }
    if (hasProcessExited(child)) {
      return { exited: true, forced: false, alreadyExited: false };
    }
    const gracefulExit = await waitForOutcomeOrTimeout(
      watcher.promise,
      gracefulTimeoutMs,
      setTimeoutFn,
      clearTimeoutFn,
    );
    if (gracefulExit.exited) {
      return { exited: true, forced: false, details: gracefulExit.details };
    }

    const forceAccepted = requestKill(child, "SIGKILL", "ROUTER_FORCE_STOP_SIGNAL_REJECTED");
    if (!forceAccepted && !hasProcessExited(child)) {
      throw lifecycleError(
        "ROUTER_FORCE_STOP_SIGNAL_REJECTED",
        "Router process rejected the forced stop signal.",
      );
    }
    if (hasProcessExited(child)) {
      return { exited: true, forced: true };
    }
    const forcedExit = await waitForOutcomeOrTimeout(
      watcher.promise,
      forceTimeoutMs,
      setTimeoutFn,
      clearTimeoutFn,
    );
    if (!forcedExit.exited) {
      throw lifecycleError(
        "ROUTER_STOP_TIMEOUT",
        `Router did not exit after graceful and forced stop timeouts (${gracefulTimeoutMs + forceTimeoutMs} ms).`,
      );
    }
    return { exited: true, forced: true, details: forcedExit.details };
  } finally {
    watcher.dispose();
  }
}

function normalizeDependencies(dependencies) {
  const required = [
    "prepareStart",
    "ensureLocalExecutor",
    "spawnRouter",
    "checkHealth",
    "cleanupManagedConfig",
    "publishReady",
    "publishStopped",
  ];
  for (const name of required) {
    if (typeof dependencies[name] !== "function") {
      throw new TypeError(`Router lifecycle dependency ${name} must be a function.`);
    }
  }
  return {
    ...dependencies,
    waitForSpawn: dependencies.waitForSpawn || ((child) => waitForChildSpawn(child)),
    terminateProcess: dependencies.terminateProcess || ((child) => terminateChildProcess(child)),
    isLocalExecutorRunning: dependencies.isLocalExecutorRunning || (() => false),
    stopLocalExecutor: dependencies.stopLocalExecutor || (async () => {}),
    onUnexpectedExit: dependencies.onUnexpectedExit || (async () => {}),
    onStartFailed: dependencies.onStartFailed || (() => {}),
    onProcessAssigned: dependencies.onProcessAssigned || (() => {}),
    onProcessCleared: dependencies.onProcessCleared || (() => {}),
    onProcessError: dependencies.onProcessError || (() => {}),
    onQuitRequested: dependencies.onQuitRequested || (() => {}),
    onQuitCleanupTimeout: dependencies.onQuitCleanupTimeout || (() => {}),
    onQuitCleanupLateSuccess: dependencies.onQuitCleanupLateSuccess || (() => {}),
    onQuitFailed: dependencies.onQuitFailed || (() => {}),
    onQuitReady: dependencies.onQuitReady || (async () => {}),
    quitApp: dependencies.quitApp || (async () => {}),
    onInternalError: dependencies.onInternalError || (() => {}),
    quitCleanupTimeoutMs: positiveInteger(
      dependencies.quitCleanupTimeoutMs,
      DEFAULT_QUIT_CLEANUP_TIMEOUT_MS,
    ),
    setTimeoutFn: dependencies.setTimeoutFn || setTimeout,
    clearTimeoutFn: dependencies.clearTimeoutFn || clearTimeout,
  };
}

function createExitWatcher(child) {
  let disposed = false;
  let resolveExit;
  const promise = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const onExit = (code, signal) => {
    resolveExit({ code, signal, causeCode: safeChildStartFailureCode(child) });
  };
  const onClose = (code, signal) => {
    resolveExit({ code, signal, causeCode: safeChildStartFailureCode(child) });
  };
  child.once("exit", onExit);
  child.once("close", onClose);
  return {
    promise,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
    },
  };
}

function safeChildStartFailureCode(child) {
  const value = child?.codexBridgeStartFailureCode;
  return typeof value === "string" && /^[a-z0-9_]{1,96}$/u.test(value)
    ? value
    : "";
}

function waitForOutcomeOrTimeout(promise, timeoutMs, setTimeoutFn, clearTimeoutFn) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeoutFn(() => resolve({ exited: false }), timeoutMs);
    timer?.unref?.();
  });
  return Promise.race([
    promise.then((details) => ({ exited: true, details })),
    timeout,
  ]).finally(() => clearTimeoutFn(timer));
}

function requestKill(child, signal, code) {
  try {
    return child.kill(signal);
  } catch (error) {
    const wrapped = lifecycleError(code, `Router process stop signal failed: ${error?.message || error}`);
    wrapped.cause = error;
    throw wrapped;
  }
}

function hasProcessExited(child) {
  return child?.exitCode !== null && child?.exitCode !== undefined ||
    child?.signalCode !== null && child?.signalCode !== undefined;
}

function assertChildProcess(child) {
  if (!(child instanceof EventEmitter) || typeof child.kill !== "function") {
    throw new TypeError("Router lifecycle requires an EventEmitter-compatible child process.");
  }
}

function throwIfCancelled(token, stage) {
  if (!token.cancelled) {
    return;
  }
  const error = lifecycleError(
    "ROUTER_START_CANCELLED",
    `Router start was cancelled by ${token.reason || "lifecycle"} during ${stage}.`,
  );
  error.stage = stage;
  throw error;
}

function processExitedDuringStart(details = {}, stage = "start") {
  const error = lifecycleError(
    "ROUTER_PROCESS_EXITED_DURING_START",
    `Router process exited during ${stage} before healthy state publication.`,
  );
  error.exitCode = details.code ?? null;
  error.signal = details.signal ?? null;
  if (typeof details.causeCode === "string" && /^[a-z0-9_]{1,96}$/u.test(details.causeCode)) {
    error.causeCode = details.causeCode;
  }
  if (details.error) {
    error.cause = details.error;
  }
  return error;
}

function lifecycleError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeCauseCode(value) {
  const code = String(value || "").trim().toLowerCase();
  return /^[a-z0-9_]{1,96}$/u.test(code) ? code : "operation_failed";
}

function safeInvoke(callback, ...args) {
  try {
    return callback(...args);
  } catch {
    return undefined;
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}
