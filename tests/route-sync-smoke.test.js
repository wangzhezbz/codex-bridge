import test from "node:test";
import assert from "node:assert/strict";

import { runDesktopRouteSyncSmoke } from "../desktop/route-sync-smoke.mjs";

test("desktop route sync smoke covers user-facing stale model recovery chains", () => {
  const report = runDesktopRouteSyncSmoke();

  assert.equal(report.ok, true);
  assert.deepEqual(report.summary, {
    total: 5,
    passed: 5,
    failed: 0,
  });
  assert.deepEqual(
    report.cases.map((item) => [item.id, item.ok, item.selectedModelIds, item.defaultModel]),
    [
      [
        "provider-save-after-stale-selection",
        true,
        ["remote-kimi-kimi-for-coding"],
        "cb-remote-kimi-kimi-for-coding",
      ],
      [
        "auxiliary-task-model-deleted",
        true,
        ["deepseek-v4-pro"],
        "cb-deepseek-v4-pro",
      ],
      [
        "config-package-import-with-old-model-id",
        true,
        ["remote-kimi-kimi-for-coding"],
        "cb-remote-kimi-kimi-for-coding",
      ],
      [
        "config-profile-save-with-old-model-id",
        true,
        ["remote-kimi-kimi-for-coding"],
        "",
      ],
      [
        "codex-model-catalog-refresh-after-route-sync",
        true,
        ["remote-kimi-kimi-for-coding"],
        "cb-remote-kimi-kimi-for-coding",
      ],
    ],
  );
});
