import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createOwnershipStore } from "../desktop/software-manager/state-store.mjs";

function state(installRoot = "C:\\Tools\\CodexBridge") {
  return {
    schemaVersion: 1,
    installRoot,
    components: {},
    skills: {},
    shortcuts: [],
    rollback: null,
    activeTask: null,
    lastTask: null,
  };
}

async function tempStateDir(t) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "codexbridge-state-test-"));
  t.after(async () => {
    for (const name of ["ownership.json.tmp", "ownership.json", "ownership.json.bak"]) {
      await fs.unlink(path.join(stateDir, name)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await fs.rmdir(stateDir);
  });
  return stateDir;
}

test("missing or corrupt ownership state falls back to an empty schema", async (t) => {
  const stateDir = await tempStateDir(t);
  const store = createOwnershipStore({ stateDir, fsApi: fs });
  const empty = state(null);
  assert.deepEqual(await store.load(), empty);

  await fs.writeFile(path.join(stateDir, "ownership.json"), "{broken", "utf8");
  assert.deepEqual(await store.load(), empty);
});

test("save flushes ownership.json.tmp and atomically renames it", async (t) => {
  const stateDir = await tempStateDir(t);
  const calls = [];
  const fsApi = {
    ...fs,
    async open(...args) {
      calls.push(["open", ...args]);
      const handle = await fs.open(...args);
      return {
        async writeFile(...writeArgs) { calls.push(["writeFile"]); return handle.writeFile(...writeArgs); },
        async sync() { calls.push(["sync"]); return handle.sync(); },
        async close() { calls.push(["close"]); return handle.close(); },
      };
    },
    async rename(from, to) {
      calls.push(["rename", path.basename(from), path.basename(to)]);
      return fs.rename(from, to);
    },
  };
  const store = createOwnershipStore({ stateDir, fsApi });
  const next = state();

  await store.save(next);

  assert.deepEqual(await store.load(), next);
  assert.ok(calls.find(([operation]) => operation === "sync"));
  assert.ok(calls.find((call) => call[0] === "rename" && call[1] === "ownership.json.tmp" && call[2] === "ownership.json"));
});

test("a validated previous state is retained as ownership.json.bak", async (t) => {
  const stateDir = await tempStateDir(t);
  const store = createOwnershipStore({ stateDir, fsApi: fs });
  const previous = state("C:\\Previous");
  const next = state("C:\\Next");
  await store.save(previous);
  await store.save(next);

  assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateDir, "ownership.json.bak"), "utf8")), previous);
  assert.deepEqual(await store.load(), next);
});

test("load falls back to a validated backup after interrupted atomic rename", async (t) => {
  const stateDir = await tempStateDir(t);
  const previous = state("C:\\Previous");
  const setupStore = createOwnershipStore({ stateDir, fsApi: fs });
  await setupStore.save(previous);

  const interruptedFs = {
    ...fs,
    async rename(from, to) {
      if (path.basename(from) === "ownership.json.tmp" && path.basename(to) === "ownership.json") {
        throw Object.assign(new Error("interrupted"), { code: "EIO" });
      }
      return fs.rename(from, to);
    },
  };
  const store = createOwnershipStore({ stateDir, fsApi: interruptedFs });
  await assert.rejects(store.save(state("C:\\Next")), /interrupted/);

  assert.deepEqual(await store.load(), previous);
});

test("state files that are links or reparse points are never followed", async () => {
  const touched = [];
  const fsApi = {
    async lstat(target) {
      touched.push(["lstat", target]);
      return { isSymbolicLink: () => true, isReparsePoint: () => false };
    },
    async readFile(target) { touched.push(["readFile", target]); throw new Error("must not read link"); },
  };
  const store = createOwnershipStore({ stateDir: path.resolve("state"), fsApi });
  assert.deepEqual(await store.load(), state(null));
  assert.equal(touched.some(([operation]) => operation === "readFile"), false);
});

test("save rejects malformed state before writing", async () => {
  let touched = false;
  const store = createOwnershipStore({
    stateDir: path.resolve("state"),
    fsApi: { async open() { touched = true; } },
  });
  await assert.rejects(store.save({ schemaVersion: 1 }), { code: "ownership_state_invalid" });
  assert.equal(touched, false);
});
