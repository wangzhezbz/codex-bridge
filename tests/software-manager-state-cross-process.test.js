import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createOwnershipStore } from "../desktop/software-manager/state-store.mjs";
import { createTestStateFs } from "./helpers/software-manager-test-state-fs.mjs";

const childPath = fileURLToPath(new URL("./fixtures/software-manager-state-child.mjs", import.meta.url));
const skipHostedWindowsIntegration = process.env.CODEXBRIDGE_SKIP_WINDOWS_HOSTED_RUNNER_INTEGRATION === "1";

function child(mode, stateDir, label, nonce) {
  return fork(childPath, [mode, stateDir, label, ...(nonce ? [nonce] : [])], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
}

function waitMessage(processHandle, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`child_timeout:${type}`)), 10_000);
    processHandle.on("message", (message) => {
      if (message?.type !== type) return;
      clearTimeout(timeout);
      resolve(message);
    });
    processHandle.once("error", reject);
  });
}

async function cleanupStateDir(stateDir) {
  for (const name of ["ownership.json.tmp", "ownership.json.bak", "ownership.json", ".codexbridge-ownership.lock"]) {
    await fs.unlink(path.join(stateDir, name)).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  }
  const lockDir = path.join(stateDir, ".ownership-test-lock");
  await fs.unlink(path.join(lockDir, "owner.json")).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  await fs.rmdir(lockDir).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  await fs.rmdir(stateDir).catch((error) => { if (error?.code !== "ENOENT") throw error; });
}

test("two real Node processes crossing one CAS barrier allow exactly one generation-zero commit", {
  skip: skipHostedWindowsIntegration,
}, async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cb-state-cas-"));
  try {
    const first = child("cas", stateDir, "First");
    const second = child("cas", stateDir, "Second");
    await Promise.all([waitMessage(first, "ready"), waitMessage(second, "ready")]);
    const firstResult = waitMessage(first, "result");
    const secondResult = waitMessage(second, "result");
    first.send("go"); second.send("go");
    const results = await Promise.all([firstResult, secondResult]);
    assert.equal(results.filter((item) => item.status === "saved").length, 1, JSON.stringify(results));
    assert.equal(results.filter((item) => item.code === "ownership_generation_conflict").length, 1, JSON.stringify(results));
  } finally { await cleanupStateDir(stateDir); }
});

test("one transient Windows rename denial does not turn a committed CAS into an EPERM failure", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cb-state-rename-retry-"));
  let attempts = 0;
  const flakyFs = {
    ...fs,
    async rename(source, destination) {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("transient rename denial"), { code: "EPERM", syscall: "rename" });
      return fs.rename(source, destination);
    },
  };
  try {
    const store = createOwnershipStore({ stateDir, fsApi: createTestStateFs({ fsImpl: flakyFs }) });
    const saved = await store.compareAndSwap(0, {
      schemaVersion: 1, generation: 0, installRoot: "D:\\Retry", components: {}, skills: {}, shortcuts: [],
      rollback: null, activeTask: null, lastTask: null,
    });
    assert.equal(saved.generation, 1);
    assert.equal(attempts, 2);
  } finally {
    await cleanupStateDir(stateDir);
  }
});

test("one transient Windows lock-file denial is retried before releasing a completed CAS", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cb-state-release-retry-"));
  let ownerUnlinkAttempts = 0;
  const flakyFs = {
    ...fs,
    async unlink(target) {
      if (path.basename(target) === "owner.json") {
        ownerUnlinkAttempts += 1;
        if (ownerUnlinkAttempts === 1) {
          throw Object.assign(new Error("transient owner denial"), { code: "EPERM", syscall: "unlink" });
        }
      }
      return fs.unlink(target);
    },
  };
  try {
    const store = createOwnershipStore({ stateDir, fsApi: createTestStateFs({ fsImpl: flakyFs }) });
    const saved = await store.compareAndSwap(0, {
      schemaVersion: 1, generation: 0, installRoot: "D:\\ReleaseRetry", components: {}, skills: {}, shortcuts: [],
      rollback: null, activeTask: null, lastTask: null,
    });
    assert.equal(saved.generation, 1);
    assert.equal(ownerUnlinkAttempts, 2);
  } finally {
    await cleanupStateDir(stateDir);
  }
});

test("a crashed lock owner is recovered by the next real Node process", {
  skip: skipHostedWindowsIntegration,
}, async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cb-state-crash-"));
  try {
    const holder = child("hold", stateDir, "holder");
    await waitMessage(holder, "locked");
    holder.kill("SIGKILL");
    await new Promise((resolve) => holder.once("exit", resolve));
    const contender = child("cas", stateDir, "Recovered");
    await waitMessage(contender, "ready");
    const result = waitMessage(contender, "result");
    contender.send("go");
    assert.equal((await result).status, "saved");
  } finally { await cleanupStateDir(stateDir); }
});

test("a lock in one state directory does not block a real process using another directory", {
  skip: skipHostedWindowsIntegration,
}, async () => {
  const firstDir = await fs.mkdtemp(path.join(os.tmpdir(), "cb-state-a-"));
  const secondDir = await fs.mkdtemp(path.join(os.tmpdir(), "cb-state-b-"));
  let holder;
  try {
    holder = child("hold", firstDir, "holder");
    await waitMessage(holder, "locked");
    const contender = child("cas", secondDir, "Independent");
    await waitMessage(contender, "ready");
    const result = waitMessage(contender, "result");
    contender.send("go");
    assert.equal((await result).status, "saved");
  } finally {
    if (holder?.connected) holder.send("release");
    if (holder) await new Promise((resolve) => holder.once("exit", resolve));
    await cleanupStateDir(firstDir);
    await cleanupStateDir(secondDir);
  }
});

test("a real child operation lease prevents cross-process claim recovery until its owner is killed", {
  skip: skipHostedWindowsIntegration,
}, async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cb-operation-lease-"));
  const nonce = "a".repeat(32);
  let holder;
  try {
    holder = child("hold-operation", stateDir, "live-download", nonce);
    await waitMessage(holder, "claimed");
    const liveProbe = child("probe-operation", stateDir, "probe", nonce);
    assert.equal((await waitMessage(liveProbe, "result")).status, "live");
    assert.equal(JSON.parse(await fs.readFile(path.join(stateDir, "ownership.json"), "utf8")).activeTask.taskId, "live-download");

    holder.kill("SIGKILL");
    await new Promise((resolve) => holder.once("exit", resolve));
    holder = null;
    const recovery = child("probe-operation", stateDir, "recovery", nonce);
    assert.equal((await waitMessage(recovery, "result")).status, "recovered");
    assert.equal(JSON.parse(await fs.readFile(path.join(stateDir, "ownership.json"), "utf8")).activeTask, null);
  } finally {
    if (holder) holder.kill("SIGKILL");
    await cleanupStateDir(stateDir);
  }
});
