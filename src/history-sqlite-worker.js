import { parentPort, workerData } from "node:worker_threads";
import { HistorySqliteStore } from "./history-sqlite.js";

const store = new HistorySqliteStore(workerData.historyPath, workerData.options);

parentPort.on("message", (message = {}) => {
  if (message.type === "record_turn") {
    try {
      const result = store.recordTurn(message.turn, message.now);
      parentPort.postMessage({
        type: "record_turn_result",
        requestId: message.requestId,
        ok: true,
        result,
      });
    } catch (error) {
      parentPort.postMessage({
        type: "record_turn_result",
        requestId: message.requestId,
        ok: false,
        error: serializeError(error),
      });
    }
    return;
  }
  if (message.type === "close") {
    try {
      store.close();
    } finally {
      if (message.signal) {
        Atomics.store(message.signal, 0, 1);
        Atomics.notify(message.signal, 0);
      }
      parentPort.close();
    }
  }
});

function serializeError(error) {
  const serialized = {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack || "",
  };
  for (const key of [
    "code",
    "errcode",
    "sqliteCode",
    "statusCode",
    "localHistoryError",
    "internalCode",
  ]) {
    if (error?.[key] !== undefined) {
      serialized[key] = error[key];
    }
  }
  return serialized;
}
