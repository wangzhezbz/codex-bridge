import test from "node:test";
import assert from "node:assert/strict";
import snapshotConsistency from "../desktop/consistent-state-snapshot.cjs";

const { buildConsistentStateSnapshot } = snapshotConsistency;

test("consistent state snapshot publishes a stable first attempt", async () => {
  let builds = 0;
  const result = await buildConsistentStateSnapshot({
    readRevision: () => "revision-a",
    buildSnapshot: async () => ({ build: ++builds }),
  });
  assert.deepEqual(result, { build: 1 });
  assert.equal(builds, 1);
});

test("consistent state snapshot retries when a mutation commits during slow discovery", async () => {
  let revision = "revision-a";
  let builds = 0;
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const pending = buildConsistentStateSnapshot({
    readRevision: () => revision,
    buildSnapshot: async ({ attempt }) => {
      builds += 1;
      const captured = revision;
      if (attempt === 1) await firstBlocked;
      return { captured, attempt };
    },
  });

  revision = "revision-b";
  releaseFirst();
  assert.deepEqual(await pending, { captured: "revision-b", attempt: 2 });
  assert.equal(builds, 2);
});

test("consistent state snapshot fails closed after bounded continuous churn", async () => {
  let revision = 0;
  await assert.rejects(buildConsistentStateSnapshot({
    maxAttempts: 3,
    readRevision: () => String(revision),
    buildSnapshot: async () => {
      revision += 1;
      return { revision };
    },
  }), (error) => {
    assert.equal(error.code, "STATE_SNAPSHOT_CHANGED_DURING_READ");
    assert.equal(error.attempts, 3);
    return true;
  });
});

test("consistent state snapshot preserves builder failures", async () => {
  const expected = new Error("snapshot build failed");
  await assert.rejects(buildConsistentStateSnapshot({
    readRevision: () => "revision-a",
    buildSnapshot: async () => { throw expected; },
  }), expected);
});
