import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

test("session snapshot worker reads an empty Codex home without blocking Main", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-session-worker-"));
  const workerPath = path.resolve("desktop/session-snapshot-worker.cjs");
  try {
    const message = await new Promise((resolve, reject) => {
      const worker = new Worker(workerPath, { workerData: { homeDir, limit: 25 } });
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0) reject(new Error(`session worker exited with ${code}`));
      });
    });
    assert.equal(message.ok, true, message.error);
    assert.deepEqual(message.result.codexSessions, []);
    assert.deepEqual(message.result.codexSessionTree.sessions, []);
    assert.equal(Array.isArray(message.result.codexProjectRecoveryPlan.roots), true);
  } finally {
    fs.rmdirSync(homeDir);
  }
});
