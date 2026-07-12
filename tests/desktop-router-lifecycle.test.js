import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  createRouterLifecycleController,
  terminateChildProcess,
} from "../desktop/router-lifecycle.mjs";

test("duplicate starts share one promise and a concurrent stop cancels before spawn", async () => {
  const prepared = deferred();
  const events = [];
  let prepareCalled = false;
  const harness = createHarness({
    prepareStart: () => {
      prepareCalled = true;
      return prepared.promise;
    },
    spawnRouter: () => {
      events.push("spawn");
      return new FakeChild();
    },
    cleanupManagedConfig: async () => {
      events.push("cleanup");
      return { removed: true };
    },
    publishStopped: async () => events.push("stopped"),
  });

  const first = harness.controller.start();
  const duplicate = harness.controller.start();
  assert.strictEqual(duplicate, first);
  await waitUntil(() => prepareCalled);
  const stopping = harness.controller.stop({ source: "test" });
  prepared.resolve({ config: {} });

  await assert.rejects(first, { code: "ROUTER_START_CANCELLED" });
  await stopping;
  assert.deepEqual(events, ["cleanup", "cleanup", "stopped"]);
  assert.equal(harness.controller.snapshot().hasProcess, false);
});

test("process exit before health is final rejects start without publish or watchdog", async () => {
  const child = new FakeChild();
  child.codexBridgeStartFailureCode = "router_port_in_use";
  const health = deferred();
  const events = [];
  const harness = createHarness({
    spawnRouter: () => child,
    checkHealth: () => health.promise,
    cleanupManagedConfig: async () => {
      events.push("cleanup");
      return { removed: true };
    },
    publishReady: async () => events.push("ready"),
    onUnexpectedExit: async () => events.push("watchdog"),
  });

  const starting = harness.controller.start();
  await waitUntil(() => harness.controller.snapshot().hasProcess);
  child.exitNow(17);

  await assert.rejects(starting, (error) => {
    assert.equal(error.code, "ROUTER_PROCESS_EXITED_DURING_START");
    assert.equal(error.causeCode, "router_port_in_use");
    return true;
  });
  assert.deepEqual(events, ["cleanup"]);
  assert.equal(harness.controller.snapshot().hasProcess, false);
  health.resolve({ ok: true });
});

test("stop cleanup failure cannot block confirmed Router shutdown", async () => {
  const child = new FakeChild({
    onKill: (target) => queueMicrotask(() => target.exitNow(0)),
  });
  let publishStopped = 0;
  const internalErrors = [];
  const harness = createHarness({
    spawnRouter: () => child,
    cleanupManagedConfig: async () => {
      throw Object.assign(new Error("Configuration transaction failed"), {
        name: "ConfigTransactionError",
        code: "config_transaction_failed",
        causeCode: "ebusy",
      });
    },
    publishStopped: async () => {
      publishStopped += 1;
    },
    onInternalError: (error, phase) => internalErrors.push(`${phase}:${error.code}`),
  });

  await harness.controller.start();
  const stopped = await harness.controller.stop({ source: "test" });

  assert.equal(stopped.ok, true);
  assert.equal(stopped.cleanup.ok, false);
  assert.equal(stopped.cleanup.causeCode, "ebusy");
  assert.equal(stopped.warning.code, "managed_config_cleanup_failed");
  assert.equal(child.killCalls.length, 1);
  assert.equal(publishStopped, 1);
  assert.equal(harness.controller.snapshot().hasProcess, false);
  assert.deepEqual(internalErrors, ["managed_cleanup:config_transaction_failed"]);
});

test("stop does not clear or publish until child exit confirms termination", async () => {
  const child = new FakeChild({ killResult: true });
  const events = [];
  const harness = createHarness({
    spawnRouter: () => child,
    cleanupManagedConfig: async () => {
      events.push("cleanup");
      return { removed: true };
    },
    publishStopped: async () => events.push("stopped"),
  });

  await harness.controller.start();
  let settled = false;
  const stopping = harness.controller.stop({ source: "test" }).finally(() => {
    settled = true;
  });
  await waitUntil(() => child.killCalls.length === 1);
  assert.equal(settled, false);
  assert.equal(harness.controller.snapshot().hasProcess, true);
  assert.deepEqual(events, ["cleanup"]);

  child.exitNow(0);
  await stopping;
  assert.equal(harness.controller.snapshot().hasProcess, false);
  assert.deepEqual(events, ["cleanup", "stopped"]);
});

test("ready process exit publishes one unexpected terminal event", async () => {
  const child = new FakeChild();
  const exits = [];
  const harness = createHarness({
    spawnRouter: () => child,
    onUnexpectedExit: async (details) => exits.push(details.code),
  });

  await harness.controller.start();
  child.exitNow(23);
  await waitUntil(() => exits.length === 1);
  assert.deepEqual(exits, [23]);
  assert.equal(harness.controller.snapshot().hasProcess, false);
});

test("an explicit stop invalidates an unexpected-exit callback that is still awaiting publication", async () => {
  const child = new FakeChild();
  const callbackStarted = deferred();
  const releasePublication = deferred();
  let isCurrent = null;
  let restartRequests = 0;
  const harness = createHarness({
    spawnRouter: () => child,
    onUnexpectedExit: async (details) => {
      isCurrent = details.isCurrent;
      callbackStarted.resolve();
      await releasePublication.promise;
      if (isCurrent()) {
        restartRequests += 1;
      }
    },
  });

  await harness.controller.start();
  child.exitNow(29);
  await callbackStarted.promise;
  assert.equal(typeof isCurrent, "function");

  await harness.controller.stop({ source: "explicit-stop" });
  releasePublication.resolve();
  await flush();

  assert.equal(isCurrent(), false);
  assert.equal(restartRequests, 0);
});

test("ready publication failure cannot tear down a healthy Router", async () => {
  const child = new FakeChild();
  const internalErrors = [];
  const harness = createHarness({
    spawnRouter: () => child,
    publishReady: async () => {
      throw new Error("injected ready publication failure");
    },
    onInternalError: (error, phase) => internalErrors.push(`${phase}:${error.message}`),
  });

  const result = await harness.controller.start();

  assert.equal(result.ok, true);
  assert.equal(harness.controller.snapshot().phase, "running");
  assert.equal(harness.controller.snapshot().hasProcess, true);
  assert.equal(child.killCalls.length, 0);
  assert.deepEqual(internalErrors, ["publish_ready:injected ready publication failure"]);
});

test("a failed start rollback cannot spawn a second Router while the first child is still alive", async () => {
  const child = new FakeChild();
  let spawnCalls = 0;
  const harness = createHarness({
    spawnRouter: () => {
      spawnCalls += 1;
      return child;
    },
    checkHealth: async () => ({ ok: false, message: "injected unhealthy child" }),
    terminateProcess: async () => {
      throw new Error("injected termination failure");
    },
  });

  await assert.rejects(harness.controller.start(), { code: "ROUTER_START_ROLLBACK_FAILED" });
  assert.equal(harness.controller.snapshot().phase, "stop_failed");
  assert.equal(harness.controller.snapshot().hasProcess, true);
  await assert.rejects(harness.controller.start(), { code: "ROUTER_LIFECYCLE_PROCESS_PRESENT" });
  assert.equal(spawnCalls, 1);
  assert.equal(child.killCalls.length, 0);

  await assert.rejects(
    harness.controller.stop({ source: "retry-confirmed-stop" }),
    /injected termination failure/,
  );
  assert.equal(harness.controller.snapshot().phase, "stop_failed");
  await assert.rejects(harness.controller.start(), { code: "ROUTER_LIFECYCLE_PROCESS_PRESENT" });
  assert.equal(spawnCalls, 1);
});

test("a failed explicit stop keeps the delayed child exit expected and never restarts it", async () => {
  const child = new FakeChild();
  const unexpectedExits = [];
  const harness = createHarness({
    spawnRouter: () => child,
    terminateProcess: async () => {
      throw new Error("injected termination failure");
    },
    onUnexpectedExit: async (details) => unexpectedExits.push(details.code),
  });

  await harness.controller.start();
  await assert.rejects(
    harness.controller.stop({ source: "explicit-stop" }),
    /injected termination failure/,
  );
  assert.equal(harness.controller.snapshot().hasProcess, true);

  child.exitNow(31);
  await waitUntil(() => !harness.controller.snapshot().hasProcess);
  await flush();

  assert.equal(harness.controller.snapshot().phase, "stopped");
  assert.deepEqual(unexpectedExits, []);
});

test("a rollback failure retains terminal cleanup until the delayed child exit", async () => {
  const firstChild = new FakeChild();
  const secondChild = new FakeChild();
  const unexpectedExits = [];
  let spawnCalls = 0;
  const harness = createHarness({
    spawnRouter: () => {
      spawnCalls += 1;
      return spawnCalls === 1 ? firstChild : secondChild;
    },
    checkHealth: async () => spawnCalls === 1
      ? { ok: false, message: "injected unhealthy child" }
      : { ok: true, message: "ok" },
    terminateProcess: async (child) => {
      if (child === firstChild) {
        throw new Error("injected rollback termination failure");
      }
      child.exitNow(0);
    },
    onUnexpectedExit: async (details) => unexpectedExits.push(details.code),
  });

  await assert.rejects(harness.controller.start(), { code: "ROUTER_START_ROLLBACK_FAILED" });
  assert.equal(harness.controller.snapshot().hasProcess, true);
  assert.equal(harness.controller.snapshot().phase, "stop_failed");

  firstChild.exitNow(32);
  await waitUntil(() => !harness.controller.snapshot().hasProcess);
  assert.equal(harness.controller.snapshot().phase, "stopped");
  assert.deepEqual(unexpectedExits, []);

  const restarted = await harness.controller.start();
  assert.equal(restarted.ok, true);
  assert.equal(spawnCalls, 2);
});

test("stopped publication failure cannot turn a confirmed stop into a retryable failure", async () => {
  const child = new FakeChild({
    onKill: (target) => queueMicrotask(() => target.exitNow(0)),
  });
  const internalErrors = [];
  const harness = createHarness({
    spawnRouter: () => child,
    publishStopped: async () => {
      throw new Error("injected stopped publication failure");
    },
    onInternalError: (error, phase) => internalErrors.push(`${phase}:${error.message}`),
  });

  const started = await harness.controller.start();
  assert.equal(started.ok, true);
  const stopped = await harness.controller.stop({ source: "test" });

  assert.equal(stopped.ok, true);
  assert.equal(harness.controller.snapshot().phase, "stopped");
  assert.equal(harness.controller.snapshot().hasProcess, false);
  assert.deepEqual(internalErrors, ["publish_stopped:injected stopped publication failure"]);
});

test("quit timeout keeps Router alive, then late cleanup success completes stop and quit", async () => {
  const child = new FakeChild({
    killResult: true,
    onKill: (target) => queueMicrotask(() => target.exitNow(0)),
  });
  const cleanup = deferred();
  const timeoutCallbacks = [];
  const events = [];
  const harness = createHarness({
    spawnRouter: () => child,
    cleanupManagedConfig: () => cleanup.promise,
    setTimeoutFn: (callback) => {
      timeoutCallbacks.push(callback);
      return timeoutCallbacks.length;
    },
    clearTimeoutFn: () => {},
    onQuitCleanupTimeout: () => events.push("timeout"),
    onQuitReady: () => events.push("ready-to-quit"),
    quitApp: () => events.push("quit"),
  });

  await harness.controller.start();
  let settled = false;
  const quitting = harness.controller.quit({ reason: "test" }).finally(() => {
    settled = true;
  });
  await waitUntil(() => timeoutCallbacks.length === 1);
  timeoutCallbacks[0]();
  await flush();
  assert.equal(settled, false);
  assert.equal(child.killCalls.length, 0);
  assert.equal(harness.controller.snapshot().hasProcess, true);
  assert.deepEqual(events, ["timeout"]);

  cleanup.resolve({ removed: true });
  await quitting;
  assert.equal(harness.controller.snapshot().hasProcess, false);
  assert.deepEqual(events, ["timeout", "ready-to-quit", "quit"]);
});

test("quit cleanup rejection becomes a warning and still terminates Router and exits", async () => {
  const child = new FakeChild({
    onKill: (target) => queueMicrotask(() => target.exitNow(0)),
  });
  const events = [];
  const failure = Object.assign(new Error("cleanup rejected"), { code: "CLEANUP_REJECTED" });
  const harness = createHarness({
    spawnRouter: () => child,
    cleanupManagedConfig: async () => {
      throw failure;
    },
    onInternalError: (error, phase) => events.push(`${phase}:${error.code}`),
    onQuitFailed: (error) => events.push(`failed:${error.code}`),
    onQuitReady: ({ warning }) => events.push(`ready:${warning.code}:${warning.causeCode}`),
    quitApp: () => events.push("quit"),
  });

  await harness.controller.start();
  const result = await harness.controller.quit({ reason: "test" });
  assert.equal(result.ok, true);
  assert.equal(result.cleanup.ok, false);
  assert.equal(result.warning.code, "managed_config_cleanup_failed");
  assert.equal(result.warning.causeCode, "cleanup_rejected");
  assert.equal(child.killCalls.length, 1);
  assert.equal(harness.controller.snapshot().hasProcess, false);
  assert.deepEqual(events, [
    "managed_cleanup:CLEANUP_REJECTED",
    "ready:managed_config_cleanup_failed:cleanup_rejected",
    "quit",
  ]);
});

test("quit requested during start cancels the attempt and cannot leave an orphan", async () => {
  const prepared = deferred();
  const child = new FakeChild();
  const events = [];
  let prepareCalled = false;
  const harness = createHarness({
    prepareStart: () => {
      prepareCalled = true;
      return prepared.promise;
    },
    spawnRouter: () => {
      events.push("spawn");
      return child;
    },
    cleanupManagedConfig: async () => {
      events.push("cleanup");
      return { removed: true };
    },
    onQuitReady: () => events.push("ready"),
    quitApp: () => events.push("quit"),
  });

  const starting = harness.controller.start();
  await waitUntil(() => prepareCalled);
  const quitting = harness.controller.quit({ reason: "test" });
  prepared.resolve({ config: {} });

  await assert.rejects(starting, { code: "ROUTER_START_CANCELLED" });
  await quitting;
  assert.deepEqual(events, ["cleanup", "cleanup", "ready", "quit"]);
  assert.equal(child.killCalls.length, 0);
  assert.equal(harness.controller.snapshot().hasProcess, false);
});

test("terminateChildProcess rejects kill=false without claiming exit", async () => {
  const child = new FakeChild({ killResult: false });
  await assert.rejects(
    terminateChildProcess(child, { gracefulTimeoutMs: 5, forceTimeoutMs: 5 }),
    { code: "ROUTER_STOP_SIGNAL_REJECTED" },
  );
  assert.equal(child.exitCode, null);
});

test("terminateChildProcess escalates after timeout and awaits forced exit", async () => {
  const child = new FakeChild({
    killResult: true,
    onKill: (target, signal) => {
      if (signal === "SIGKILL") {
        queueMicrotask(() => target.exitNow(null, "SIGKILL"));
      }
    },
  });

  const result = await terminateChildProcess(child, {
    gracefulTimeoutMs: 2,
    forceTimeoutMs: 20,
  });
  assert.equal(result.forced, true);
  assert.deepEqual(child.killCalls, [undefined, "SIGKILL"]);
});

function createHarness(overrides = {}) {
  const assigned = [];
  const cleared = [];
  const dependencies = {
    prepareStart: async () => ({ config: {} }),
    ensureLocalExecutor: async () => ({ url: "http://127.0.0.1:1", token: "test" }),
    isLocalExecutorRunning: () => false,
    stopLocalExecutor: () => {},
    spawnRouter: () => new FakeChild(),
    waitForSpawn: async () => true,
    checkHealth: async () => ({ ok: true, message: "ok" }),
    cleanupManagedConfig: async () => ({ removed: true }),
    publishReady: async () => {},
    publishStopped: async () => {},
    onUnexpectedExit: async () => {},
    onStartFailed: () => {},
    onProcessAssigned: (child) => assigned.push(child),
    onProcessCleared: (child) => cleared.push(child),
    onProcessError: () => {},
    onQuitRequested: () => {},
    onQuitCleanupTimeout: () => {},
    onQuitFailed: () => {},
    onQuitReady: () => {},
    quitApp: () => {},
    quitCleanupTimeoutMs: 5000,
    ...overrides,
  };
  return {
    controller: createRouterLifecycleController(dependencies),
    assigned,
    cleared,
  };
}

class FakeChild extends EventEmitter {
  constructor({ killResult = true, onKill = null } = {}) {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.killCalls = [];
    this.killResult = killResult;
    this.onKill = onKill;
  }

  kill(signal) {
    this.killCalls.push(signal);
    this.killed = this.killResult !== false;
    this.onKill?.(this, signal);
    return this.killResult;
  }

  exitNow(code = 0, signal = null) {
    if (this.exitCode !== null || this.signalCode !== null) {
      return;
    }
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for lifecycle condition");
    }
    await flush();
  }
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}
