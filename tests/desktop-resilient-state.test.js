import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createResilientStateReader } = require("../desktop/resilient-state.cjs");

test("a failed refresh returns the last complete snapshot without rejecting", async () => {
  const failures = [];
  let shouldFail = false;
  const readState = createResilientStateReader({
    async readSnapshot(options) {
      if (shouldFail) {
        throw new Error("injected state read failure");
      }
      return { generation: 7, lite: Boolean(options?.lite) };
    },
    createFallbackSnapshot: () => ({ generation: 0 }),
    reportFailure(error) {
      failures.push(error.message);
      throw new Error("diagnostic reporting also failed");
    },
  });

  assert.deepEqual(await readState({ lite: true }), {
    generation: 7,
    lite: true,
    stateUnavailable: false,
  });

  shouldFail = true;
  assert.deepEqual(await readState({ lite: false }), {
    generation: 7,
    lite: true,
    stateUnavailable: true,
  });
  assert.deepEqual(failures, ["injected state read failure"]);
});

test("the first failed refresh returns the safe fallback and never throws", async () => {
  const readState = createResilientStateReader({
    readSnapshot: async () => {
      throw new Error("injected first read failure");
    },
    createFallbackSnapshot: () => ({ mode: null, models: [] }),
    reportFailure: () => {},
  });

  assert.deepEqual(await readState(), {
    mode: null,
    models: [],
    stateUnavailable: true,
  });
});

test("invalid snapshots and a broken fallback still resolve to a minimal safe state", async () => {
  const readState = createResilientStateReader({
    readSnapshot: async () => null,
    createFallbackSnapshot() {
      throw new Error("injected fallback failure");
    },
    reportFailure() {
      throw new Error("injected reporter failure");
    },
  });

  assert.deepEqual(await readState(), { stateUnavailable: true });
});
