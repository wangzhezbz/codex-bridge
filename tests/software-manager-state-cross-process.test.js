import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const childPath = fileURLToPath(new URL("./fixtures/software-manager-state-child.mjs", import.meta.url));

function child(mode, stateDir, label) {
  return fork(childPath, [mode, stateDir, label], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
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

test("two real Node processes crossing one CAS barrier allow exactly one generation-zero commit", async () => {
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

test("a crashed lock owner is recovered by the next real Node process", async () => {
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

test("a lock in one state directory does not block a real process using another directory", async () => {
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
