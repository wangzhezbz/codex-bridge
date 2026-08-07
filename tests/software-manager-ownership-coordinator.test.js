import assert from "node:assert/strict";
import test from "node:test";

import { getOwnershipCoordinator } from "../desktop/software-manager/ownership-coordinator.mjs";

function state(generation = 0) {
  return {
    schemaVersion: 1, generation, installRoot: null, components: {}, skills: {}, shortcuts: [],
    rollback: null, activeTask: null, lastTask: null,
  };
}

function storeFixture(initial = state()) {
  let persisted = structuredClone(initial);
  return {
    async load() { return structuredClone(persisted); },
    async compareAndSwap(expectedGeneration, next) {
      if (persisted.generation !== expectedGeneration) throw Object.assign(new Error("ownership_generation_conflict"), { code: "ownership_generation_conflict" });
      persisted = { ...structuredClone(next), generation: expectedGeneration + 1 };
      return structuredClone(persisted);
    },
    value() { return structuredClone(persisted); },
  };
}

test("one shared coordinator serializes simultaneous null-claim readers and CAS grants exactly one claim", async () => {
  const store = storeFixture();
  const first = getOwnershipCoordinator(store);
  const second = getOwnershipCoordinator(store);
  assert.equal(first, second);
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const observed = [];
  const claim = (taskId, wait) => first.runExclusive(async (ownership) => {
    const before = await ownership.load();
    observed.push([taskId, before.activeTask]);
    if (wait) await gate;
    if (before.activeTask !== null) return false;
    const reserved = structuredClone(before);
    reserved.activeTask = { kind: "test", taskId };
    await ownership.save(reserved);
    return true;
  });
  const a = claim("a", true);
  await new Promise((resolve) => setImmediate(resolve));
  const b = claim("b", false);
  releaseFirst();
  assert.deepEqual(await Promise.all([a, b]), [true, false]);
  assert.deepEqual(observed, [["a", null], ["b", { kind: "test", taskId: "a" }]]);
  assert.equal(store.value().generation, 1);
});

test("coordinators for different ownership stores do not block each other", async () => {
  const first = getOwnershipCoordinator(storeFixture());
  const second = getOwnershipCoordinator(storeFixture());
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const blocked = first.runExclusive(() => gate);
  let completed = false;
  await second.runExclusive(async () => { completed = true; });
  assert.equal(completed, true);
  release();
  await blocked;
});

test("a persisted claim is visible to a newly acquired coordinator transaction after restart", async () => {
  const store = storeFixture();
  await getOwnershipCoordinator(store).runExclusive(async (ownership) => {
    const next = await ownership.load();
    next.activeTask = { kind: "git-install", taskId: "persisted" };
    await ownership.save(next);
  });
  const recovered = await getOwnershipCoordinator(store).runExclusive((ownership) => ownership.load());
  assert.deepEqual(recovered.activeTask, { kind: "git-install", taskId: "persisted" });
  assert.equal(recovered.generation, 1);
});

test("a detached promise cannot use the expired transaction store after the outer callback returns", async () => {
  const store = storeFixture();
  const coordinator = getOwnershipCoordinator(store);
  let detached;
  await coordinator.runExclusive(async (transactionStore) => {
    detached = Promise.resolve().then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return transactionStore.load();
    });
  });
  await assert.rejects(detached, /ownership_transaction_required/u);
});

test("a detached timer reentry queues behind the next live transaction instead of inheriting the old lease", async () => {
  const store = storeFixture();
  const coordinator = getOwnershipCoordinator(store);
  let triggerTimer;
  let detached;
  await coordinator.runExclusive(async () => {
    detached = new Promise((resolve) => { triggerTimer = () => setTimeout(resolve, 0); })
      .then(() => coordinator.runExclusive(async () => "detached-entered"));
  });
  let releaseSecond;
  const second = coordinator.runExclusive(async () => {
    await new Promise((resolve) => { releaseSecond = resolve; });
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  triggerTimer();
  let detachedEntered = false;
  detached.then(() => { detachedEntered = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(detachedEntered, false);
  releaseSecond();
  await second;
  assert.equal(await detached, "detached-entered");
});

test("a captured progress callback invoked after release also queues behind the current transaction", async () => {
  const store = storeFixture();
  const coordinator = getOwnershipCoordinator(store);
  let progress;
  await coordinator.runExclusive(async () => {
    progress = () => coordinator.runExclusive(async () => "progress-entered");
  });
  let releaseSecond;
  const second = coordinator.runExclusive(async () => {
    await new Promise((resolve) => { releaseSecond = resolve; });
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const progressResult = progress();
  let entered = false;
  progressResult.then(() => { entered = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(entered, false);
  releaseSecond();
  await second;
  assert.equal(await progressResult, "progress-entered");
});
