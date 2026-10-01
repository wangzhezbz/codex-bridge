import test from "node:test";
import assert from "node:assert/strict";
import singleFlight from "../desktop/keyed-single-flight.cjs";

const { createKeyedSingleFlight } = singleFlight;

test("same-key work shares one in-flight action and result", async () => {
  const run = createKeyedSingleFlight();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = run("resources", async () => {
    calls += 1;
    await gate;
    return { ok: true };
  });
  const second = run("resources", async () => {
    calls += 1;
    return { ok: false };
  });
  assert.equal(first, second);
  release();
  assert.deepEqual(await first, { ok: true });
  assert.equal(calls, 1);
});

test("different keys remain independent", async () => {
  const run = createKeyedSingleFlight();
  const results = await Promise.all([
    run("resources", async () => "resources"),
    run("sessions", async () => "sessions"),
  ]);
  assert.deepEqual(results, ["resources", "sessions"]);
});

test("failed work releases its key for a later retry", async () => {
  const run = createKeyedSingleFlight();
  let calls = 0;
  await assert.rejects(run("resources", async () => {
    calls += 1;
    throw new Error("first failed");
  }), /first failed/u);
  assert.equal(await run("resources", async () => {
    calls += 1;
    return "retried";
  }), "retried");
  assert.equal(calls, 2);
});
