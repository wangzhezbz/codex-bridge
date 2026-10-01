import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import workerTask from "../desktop/bounded-worker-task.cjs";

const { runWorkerForMessage } = workerTask;

test("bounded worker resolves the first reported message and removes lifecycle listeners", async () => {
  const worker = fakeWorker();
  const task = runWorkerForMessage({
    workerPath: "worker.cjs",
    workerData: { marker: true },
    createWorker(file, options) {
      assert.equal(file, "worker.cjs");
      assert.deepEqual(options.workerData, { marker: true });
      return worker;
    },
  });

  const message = { ok: true, result: { value: 1 } };
  worker.emit("message", message);
  assert.equal(await task, message);
  assert.equal(worker.terminateCalls, 1);
  assert.equal(worker.listenerCount("message"), 0);
  assert.equal(worker.listenerCount("error"), 0);
  assert.equal(worker.listenerCount("exit"), 0);
});

test("bounded worker rejects a clean exit that never reported a result", async () => {
  const worker = fakeWorker();
  const task = runWorkerForMessage({
    workerPath: "worker.cjs",
    label: "Resource worker",
    createWorker: () => worker,
  });

  worker.emit("exit", 0);
  await assert.rejects(task, (error) => {
    assert.equal(error.code, "WORKER_TASK_EXITED_WITHOUT_RESULT");
    assert.match(error.message, /Resource worker exited with code 0/u);
    return true;
  });
});

test("bounded worker timeout rejects promptly and terminates the read-only worker", async () => {
  const worker = fakeWorker();
  let fireTimeout;
  let cleared = false;
  const timer = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  const task = runWorkerForMessage({
    workerPath: "worker.cjs",
    timeoutMs: 90_000,
    label: "Resource worker",
    createWorker: () => worker,
    setTimeoutFn(callback, timeoutMs) {
      assert.equal(timeoutMs, 90_000);
      fireTimeout = callback;
      return timer;
    },
    clearTimeoutFn(value) {
      assert.equal(value, timer);
      cleared = true;
    },
  });

  assert.equal(timer.unrefCalled, true);
  fireTimeout();
  await assert.rejects(task, (error) => {
    assert.equal(error.code, "WORKER_TASK_TIMEOUT");
    assert.match(error.message, /within 90000 ms/u);
    return true;
  });
  assert.equal(cleared, true);
  assert.equal(worker.terminateCalls, 1);
});

test("bounded worker maps constructor failures without leaving a pending task", async () => {
  const expected = new Error("worker construction failed");
  await assert.rejects(runWorkerForMessage({
    workerPath: "worker.cjs",
    createWorker() {
      throw expected;
    },
  }), expected);
});

test("bounded worker terminates an invalid worker-like result before rejecting", async () => {
  let terminateCalls = 0;
  await assert.rejects(runWorkerForMessage({
    workerPath: "worker.cjs",
    createWorker() {
      return {
        terminate() {
          terminateCalls += 1;
          return Promise.resolve(0);
        },
      };
    },
  }), (error) => error?.code === "WORKER_TASK_INVALID");
  assert.equal(terminateCalls, 1);
});

function fakeWorker() {
  const worker = new EventEmitter();
  worker.terminateCalls = 0;
  worker.terminate = () => {
    worker.terminateCalls += 1;
    worker.emit("exit", 1);
    return Promise.resolve(0);
  };
  return worker;
}
