function createRouterRestartBudget({
  maxAttempts,
  stableWindowMs,
  isRunning,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const attemptLimit = positiveInteger(maxAttempts, "maxAttempts");
  const stableDelayMs = positiveInteger(stableWindowMs, "stableWindowMs");
  if (typeof isRunning !== "function") {
    throw new TypeError("isRunning must be a function");
  }
  if (typeof setTimeoutFn !== "function" || typeof clearTimeoutFn !== "function") {
    throw new TypeError("restart budget timer functions are required");
  }

  let attempts = 0;
  let generation = 0;
  let stableTimer = null;

  function nextAttempt() {
    if (attempts >= attemptLimit) {
      return Object.freeze({ allowed: false, attempt: attempts, maxAttempts: attemptLimit });
    }
    attempts += 1;
    return Object.freeze({ allowed: true, attempt: attempts, maxAttempts: attemptLimit });
  }

  function markReady({ manual = false } = {}) {
    invalidateStableTimer();
    if (manual) {
      attempts = 0;
    }
    const readyGeneration = generation;
    const timer = setTimeoutFn(() => {
      if (stableTimer !== timer || readyGeneration !== generation) {
        return;
      }
      stableTimer = null;
      if (safeIsRunning()) {
        attempts = 0;
      }
    }, stableDelayMs);
    stableTimer = timer;
    timer?.unref?.();
  }

  function markExit() {
    invalidateStableTimer();
  }

  function cancel({ resetAttempts = false } = {}) {
    invalidateStableTimer();
    if (resetAttempts) {
      attempts = 0;
    }
  }

  function invalidateStableTimer() {
    generation += 1;
    if (stableTimer !== null) {
      clearTimeoutFn(stableTimer);
      stableTimer = null;
    }
  }

  function safeIsRunning() {
    try {
      return Boolean(isRunning());
    } catch {
      return false;
    }
  }

  function snapshot() {
    return Object.freeze({
      attempts,
      maxAttempts: attemptLimit,
      stableTimerPending: stableTimer !== null,
    });
  }

  return Object.freeze({
    nextAttempt,
    markReady,
    markExit,
    cancel,
    snapshot,
  });
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return parsed;
}

module.exports = {
  createRouterRestartBudget,
};
