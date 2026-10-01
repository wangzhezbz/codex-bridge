const { Worker } = require("node:worker_threads");

function runWorkerForMessage({
  workerPath = "",
  workerData = undefined,
  timeoutMs = 0,
  label = "Worker",
  createWorker = (file, options) => new Worker(file, options),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const taskLabel = String(label || "Worker").trim() || "Worker";
  const boundedTimeoutMs = Number.isSafeInteger(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : 0;
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = createWorker(workerPath, { workerData });
    } catch (error) {
      reject(error);
      return;
    }
    if (!worker || typeof worker.once !== "function" || typeof worker.removeListener !== "function") {
      try {
        Promise.resolve(worker?.terminate?.()).catch(() => {});
      } catch {
        // Invalid worker cleanup is best effort.
      }
      reject(workerTaskError(
        "WORKER_TASK_INVALID",
        `${taskLabel} did not return an EventEmitter-compatible worker.`,
      ));
      return;
    }

    let settled = false;
    let timer = null;
    const guardLateWorkerError = () => {
      const ignoreLateError = () => {};
      const releaseGuard = () => worker.removeListener("error", ignoreLateError);
      worker.once("error", ignoreLateError);
      worker.once("exit", releaseGuard);
    };
    const cleanup = () => {
      if (timer !== null) clearTimeoutFn(timer);
      worker.removeListener("message", onMessage);
      worker.removeListener("error", onError);
      worker.removeListener("exit", onExit);
    };
    const terminate = () => {
      if (typeof worker.terminate !== "function") return;
      try {
        Promise.resolve(worker.terminate()).catch(() => {});
      } catch {
        // The task result is already settled; termination is best-effort cleanup.
      }
    };
    const finish = (callback, value, { terminateWorker = false } = {}) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminateWorker) {
        guardLateWorkerError();
        terminate();
      }
      callback(value);
    };
    const onMessage = (message) => finish(resolve, message, { terminateWorker: true });
    const onError = (error) => finish(reject, error);
    const onExit = (code) => finish(
      reject,
      workerTaskError(
        "WORKER_TASK_EXITED_WITHOUT_RESULT",
        `${taskLabel} exited with code ${Number.isInteger(code) ? code : "unknown"} before reporting a result.`,
      ),
    );

    worker.once("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
    if (boundedTimeoutMs > 0) {
      timer = setTimeoutFn(() => finish(
        reject,
        workerTaskError(
          "WORKER_TASK_TIMEOUT",
          `${taskLabel} did not report a result within ${boundedTimeoutMs} ms.`,
        ),
        { terminateWorker: true },
      ), boundedTimeoutMs);
      timer?.unref?.();
    }
  });
}

function workerTaskError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  runWorkerForMessage,
};
