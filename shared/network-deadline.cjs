"use strict";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

async function runWithNetworkDeadline(operation, options = {}) {
  if (typeof operation !== "function") {
    throw new TypeError("network deadline operation must be a function");
  }
  const timeoutMs = positiveTimeout(options.timeoutMs, 30_000);
  const parentSignal = options.signal;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer = null;
  let parentAbortHandler = null;
  let rejectGuard = null;
  let guardSettled = false;
  let guardError = null;

  const guard = new Promise((_resolve, reject) => {
    rejectGuard = reject;
  });
  const fail = (error) => {
    if (guardSettled) {
      return;
    }
    guardError = error;
    guardSettled = true;
    try {
      controller?.abort(error);
    } catch {
      // The deadline rejection remains authoritative.
    }
    rejectGuard(error);
  };

  if (parentSignal) {
    parentAbortHandler = () => fail(parentAbortError(parentSignal));
    if (parentSignal.aborted) {
      parentAbortHandler();
    } else {
      parentSignal.addEventListener("abort", parentAbortHandler, { once: true });
    }
  }
  timer = setTimeout(() => {
    let error;
    try {
      error = networkTimeoutError(options, timeoutMs);
    } catch (factoryError) {
      // Error construction must reject the task, not escape the timer callback.
      error = factoryError;
    }
    fail(error);
  }, timeoutMs);

  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        // Only mandatory cleanup opts in to starting after cancellation;
        // ordinary work must not start with an already-aborted signal.
        if (guardSettled && options.allowAbortedStart !== true) throw guardError;
        return operation(controller?.signal);
      }),
      guard,
    ]);
  } finally {
    guardSettled = true;
    if (timer) {
      clearTimeout(timer);
    }
    if (parentAbortHandler) {
      parentSignal.removeEventListener("abort", parentAbortHandler);
    }
  }
}

function networkTimeoutError(options, timeoutMs) {
  if (typeof options.createTimeoutError === "function") {
    const error = options.createTimeoutError({ timeoutMs });
    if (error instanceof Error) {
      return error;
    }
  }
  const error = new Error(`Network operation timed out after ${timeoutMs}ms.`);
  error.code = "network_timeout";
  error.timeoutMs = timeoutMs;
  return error;
}

function parentAbortError(signal) {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("Network operation was aborted.");
  error.name = "AbortError";
  return error;
}

function positiveTimeout(value, fallback) {
  const number = Number(value);
  const integer = Math.floor(number);
  // Node turns an overflowing timer delay into 1ms, reversing a long deadline.
  return Number.isFinite(number) && integer > 0
    ? Math.min(integer, MAX_TIMER_DELAY_MS)
    : fallback;
}

module.exports = {
  runWithNetworkDeadline,
};
