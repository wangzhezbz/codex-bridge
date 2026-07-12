import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createRouterRestartBudget } = require("../desktop/router-restart-budget.cjs");

test("a stable watchdog restart resets consecutive crash attempts", () => {
  const timers = [];
  let running = true;
  const budget = createRouterRestartBudget({
    maxAttempts: 3,
    stableWindowMs: 100,
    isRunning: () => running,
    setTimeoutFn: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeoutFn: () => {},
  });

  assert.deepEqual(budget.nextAttempt(), { allowed: true, attempt: 1, maxAttempts: 3 });
  assert.deepEqual(budget.nextAttempt(), { allowed: true, attempt: 2, maxAttempts: 3 });
  budget.markReady({ manual: false });
  assert.equal(timers.length, 1);
  timers[0]();
  assert.equal(budget.snapshot().attempts, 0);
  assert.deepEqual(budget.nextAttempt(), { allowed: true, attempt: 1, maxAttempts: 3 });

  running = false;
});

test("a crash before the stable window preserves the consecutive attempt count", () => {
  const timers = [];
  const budget = createRouterRestartBudget({
    maxAttempts: 3,
    stableWindowMs: 100,
    isRunning: () => false,
    setTimeoutFn: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeoutFn: () => {},
  });

  budget.nextAttempt();
  budget.nextAttempt();
  budget.markReady({ manual: false });
  budget.markExit();
  timers[0]();

  assert.equal(budget.snapshot().attempts, 2);
  assert.deepEqual(budget.nextAttempt(), { allowed: true, attempt: 3, maxAttempts: 3 });
  assert.deepEqual(budget.nextAttempt(), { allowed: false, attempt: 3, maxAttempts: 3 });
});

test("manual start and explicit cancellation reset the restart budget", () => {
  const budget = createRouterRestartBudget({
    maxAttempts: 2,
    stableWindowMs: 100,
    isRunning: () => true,
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });

  budget.nextAttempt();
  budget.markReady({ manual: true });
  assert.equal(budget.snapshot().attempts, 0);
  budget.nextAttempt();
  budget.cancel({ resetAttempts: true });
  assert.equal(budget.snapshot().attempts, 0);
});
