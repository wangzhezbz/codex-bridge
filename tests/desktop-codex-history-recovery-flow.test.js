import assert from "node:assert/strict";
import test from "node:test";

import { createCodexHistoryRecoveryFlow } from "../desktop/codex-history-recovery-flow.mjs";

test("history recovery retries after manual exit and reports a verified 128-row migration", async () => {
  const calls = [];
  let runningProcesses = [{ processId: 61772, name: "ChatGPT.exe" }];
  const before = {
    ok: true,
    summary: {
      rawThreads: 147,
      userThreads: 130,
      activeUserThreads: 129,
      subagentThreads: 17,
      archivedThreads: 1,
      catalogThreads: 1,
      sidebarThreads: 1,
      plannedInserts: 128,
      plannedUpdates: 0,
      unrecoverableThreads: 0,
    },
  };
  const flow = createCodexHistoryRecoveryFlow({
    preview: async () => before,
    stopDesktop: async () => ({
      ok: false,
      failedProcessIds: [61772],
      launchTarget: "C:\\Apps\\ChatGPT.exe",
      message: "taskkill failed",
    }),
    listProcesses: async () => runningProcesses,
    probeCatalogWritable: async () => ({ ok: true }),
    apply: async () => {
      calls.push("apply");
      return {
        ok: true,
        backupDir: "C:\\Users\\Administrator\\.codex\\codexbridge-history-recovery\\fixture",
        applied: { inserted: 128, updated: 0 },
        after: { summary: { catalogThreads: 129, sidebarThreads: 129 } },
        verification: {
          expectedActiveUserThreads: 129,
          catalogActiveUserThreads: 129,
          sidebarActiveUserThreads: 129,
          consistent: true,
        },
      };
    },
    backupExists: async () => true,
    restartDesktop: async () => {
      calls.push("restart");
      return { ok: true };
    },
    recoverProjects: async () => {
      calls.push("projects");
      return { ok: true, launched: 1 };
    },
  });

  const plan = await flow.prepare();
  assert.equal(plan.phase, "planned");
  assert.equal(plan.plannedInserts, 128);

  const blocked = await flow.execute({ manualExit: false });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.phase, "awaiting_manual_exit");
  assert.equal(blocked.failureCode, "desktop_stop_failed");
  assert.deepEqual(blocked.runningProcessIds, [61772]);
  assert.deepEqual(calls, []);

  runningProcesses = [];
  const completed = await flow.execute({ manualExit: true });
  assert.equal(completed.ok, true);
  assert.equal(completed.phase, "restarted");
  assert.equal(completed.plannedInserts, 128);
  assert.equal(completed.actualInserted, 128);
  assert.equal(completed.commitStatus, "verified");
  assert.equal(completed.backupExists, true);
  assert.equal(completed.rereadCatalogThreads, 129);
  assert.equal(completed.rereadSidebarThreads, 129);
  assert.deepEqual(calls, ["apply", "restart", "projects"]);
});

test("history recovery refuses migration when the catalog database is still busy", async () => {
  let applyCalls = 0;
  const flow = createCodexHistoryRecoveryFlow({
    preview: async () => ({ ok: true, summary: { plannedInserts: 128 } }),
    stopDesktop: async () => ({ ok: true, launchTarget: "C:\\Apps\\ChatGPT.exe" }),
    listProcesses: async () => [],
    probeCatalogWritable: async () => ({ ok: false, code: "catalog_busy", message: "database is locked" }),
    apply: async () => {
      applyCalls += 1;
      return { ok: true };
    },
    backupExists: async () => false,
    restartDesktop: async () => ({ ok: true }),
    recoverProjects: async () => ({ ok: true }),
  });

  await flow.prepare();
  const result = await flow.execute();
  assert.equal(result.ok, false);
  assert.equal(result.phase, "failed");
  assert.equal(result.failureCode, "catalog_busy");
  assert.equal(applyCalls, 0);
});

test("history recovery resumes a persisted pending plan after Bridge restarts", async () => {
  let durableState = null;
  let previewCalls = 0;
  let inserted = 0;
  const dependencies = {
    preview: async () => {
      previewCalls += 1;
      return {
        ok: true,
        summary: {
          rawThreads: 147,
          activeUserThreads: 129,
          catalogThreads: 1,
          sidebarThreads: 126,
          plannedInserts: 128,
          plannedUpdates: 0,
        },
        threads: [{ id: "thread-1" }],
      };
    },
    stopDesktop: async () => ({
      ok: false,
      launchTarget: "C:\\Apps\\ChatGPT.exe",
      message: "process still running",
    }),
    listProcesses: async () => [{ processId: 61772, name: "ChatGPT.exe" }],
    probeCatalogWritable: async () => ({ ok: true }),
    apply: async () => {
      inserted += 128;
      return {
        ok: true,
        backupDir: "C:\\Users\\Administrator\\.codex\\codexbridge-history-recovery\\fixture",
        applied: { inserted: 128, updated: 0 },
        after: { summary: { catalogThreads: 129, sidebarThreads: 129 } },
        verification: {
          expectedActiveUserThreads: 129,
          catalogActiveUserThreads: 129,
          sidebarActiveUserThreads: 129,
          consistent: true,
        },
      };
    },
    backupExists: async () => true,
    restartDesktop: async () => ({ ok: true }),
    recoverProjects: async () => ({ ok: true }),
    loadState: () => durableState,
    saveState: (state) => {
      durableState = structuredClone(state);
    },
  };

  const firstBridge = createCodexHistoryRecoveryFlow(dependencies);
  await firstBridge.prepare();
  const blocked = await firstBridge.execute();
  assert.equal(blocked.phase, "awaiting_manual_exit");
  assert.equal(durableState.preparedPreview.summary.plannedInserts, 128);
  assert.equal(durableState.launchTarget, "C:\\Apps\\ChatGPT.exe");

  const secondBridge = createCodexHistoryRecoveryFlow({
    ...dependencies,
    listProcesses: async () => [],
  });
  assert.equal(secondBridge.status().phase, "awaiting_manual_exit");
  const completed = await secondBridge.execute({ manualExit: true });
  assert.equal(completed.ok, true);
  assert.equal(completed.actualInserted, 128);
  assert.equal(inserted, 128);
  assert.equal(previewCalls, 1);
  assert.equal(durableState.current.phase, "restarted");
});
