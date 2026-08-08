import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runFakeHostTransaction } from "../scripts/software-manager/fake-host-transaction.mjs";

test("fake-host CI transaction stays inside its root and exercises the full lifecycle", async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-sm-ci-"));
  const result = await runFakeHostTransaction({
    env: {
      CODEXBRIDGE_SOFTWARE_MANAGER_FAKE_HOST: "1",
      CODEXBRIDGE_SOFTWARE_MANAGER_TEST_ROOT: testRoot,
    },
  });

  assert.deepEqual(result.lifecycle, [
    "install:1",
    "update:2",
    "update:3",
    "rollback:2",
    "skill:replace",
    "cancel:verified",
    "journal:recovered",
    "uninstall:complete",
  ]);
  assert.deepEqual(result.externalCalls, []);
  assert.equal(result.paths.every((value) => path.relative(testRoot, value)
    && !path.relative(testRoot, value).startsWith(`..${path.sep}`)
    && path.relative(testRoot, value) !== ".."), true);
  assert.equal(result.currentVersion, null);
  assert.equal(result.previousVersion, null);
  assert.equal(result.skillVersion, "2");
  assert.equal(result.cancelledMutationPresent, false);
  assert.equal(result.pendingJournalCount, 0);
});

test("fake-host transaction refuses missing opt-in and an unbounded test root", async () => {
  await assert.rejects(
    runFakeHostTransaction({ env: { CODEXBRIDGE_SOFTWARE_MANAGER_TEST_ROOT: os.tmpdir() } }),
    /software_manager_fake_host_not_enabled/,
  );
  await assert.rejects(
    runFakeHostTransaction({
      env: {
        CODEXBRIDGE_SOFTWARE_MANAGER_FAKE_HOST: "1",
        CODEXBRIDGE_SOFTWARE_MANAGER_TEST_ROOT: path.parse(process.cwd()).root,
      },
    }),
    /software_manager_fake_host_root_rejected/,
  );
});
