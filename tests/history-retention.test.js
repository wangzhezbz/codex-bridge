import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ResponseHistory } from "../src/history.js";

test("history churn bounds tombstones and SQLite pages while preserving active and current rows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-retention-"));
  const historyPath = path.join(dir, "response-history.sqlite3");
  let now = 50_000;
  const history = new ResponseHistory({
    historyPath,
    now: () => now,
    maxBytes: 1,
    protectRecentMs: 50,
    tombstoneTtlMs: 100,
    maxTombstones: 12,
    maxTombstoneBytes: 12 * 1024,
    incrementalVacuumPages: 64,
  });
  try {
    history.recordTurn(turn("resp_active_chain", "active"));
    let currentId = "";
    for (let index = 0; index < 600; index += 1) {
      now += 2;
      assert.equal(history.lookup("resp_active_chain").state, "available");
      currentId = `resp_churn_${String(index).padStart(4, "0")}_${"x".repeat(512)}`;
      history.recordTurn(turn(currentId, `value-${index}`));
    }

    history.entries.clear();
    history.responses.clear();
    history.responseMeta.clear();
    assert.equal(history.lookup("resp_active_chain").state, "available");
    assert.equal(history.lookup(currentId).state, "available");

    const bounded = history.health();
    assert.equal(bounded.ok, true);
    assert.equal(bounded.autoVacuum, "incremental");
    assert.ok(bounded.tombstoneCount <= 12, JSON.stringify(bounded));
    assert.ok(bounded.tombstoneBytes <= 12 * 1024, JSON.stringify(bounded));
    assert.ok(bounded.pageCount > 0, JSON.stringify(bounded));
    assert.ok(bounded.pageSize >= 512, JSON.stringify(bounded));
    assert.equal(bounded.databaseBytes, bounded.pageCount * bounded.pageSize);
    assert.ok(bounded.freelistCount >= 0, JSON.stringify(bounded));
    assert.ok(bounded.databaseFileBytes <= 768 * 1024, JSON.stringify(bounded));
    assert.ok(bounded.sqliteFileBytes <= 1024 * 1024, JSON.stringify(bounded));

    now += 1_000;
    history.prune();
    // The first prune creates bounded tombstones for rows that just expired.
    // A later maintenance pass must age those tombstones out as well.
    now += 1_000;
    history.prune();
    const expired = history.health();
    assert.equal(expired.tombstoneCount, 0, JSON.stringify(expired));
    assert.ok(expired.databaseFileBytes <= 768 * 1024, JSON.stringify(expired));
  } finally {
    history.close();
    for (const filePath of [
      historyPath,
      `${historyPath}-wal`,
      `${historyPath}-shm`,
      `${historyPath}-journal`,
    ]) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    fs.rmdirSync(dir);
  }
});

function turn(responseId, content) {
  return {
    responseId,
    messages: [{ role: "user", content }],
    response: {
      id: responseId,
      object: "response",
      status: "completed",
      output: [],
    },
    meta: { parentResponseId: null },
  };
}
