import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWin32FileApi } from "../desktop/software-manager/win32-file-api.mjs";
import { createWindowsFileCapabilities } from "../desktop/software-manager/windows-file-capabilities.mjs";

const childPath = fileURLToPath(new URL("./fixtures/software-manager-win32-state-child.mjs", import.meta.url));
const windowsOnly = process.platform !== "win32" ? "requires production Win32 handles" : false;

test("production Win32 handles accept a real 8.3 parent alias without disabling local recovery", { skip: windowsOnly }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexbridge-short-alias-"));
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir);
  try {
    const longRoot = await fs.realpath(root);
    if (longRoot.toLowerCase() === root.toLowerCase()) {
      t.skip("host temp path does not expose an 8.3 alias");
      return;
    }
    const fileCapabilities = createWindowsFileCapabilities({ nativeApi: createWin32FileApi() });
    const lock = await fileCapabilities.acquireStateLockNoFollow(stateDir);
    await lock.release();
  } finally {
    await fs.unlink(path.join(stateDir, ".codexbridge-ownership.lock")).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await fs.rmdir(stateDir);
    await fs.rmdir(root);
  }
});

test("production Win32 bootstrap creates fixed runtime directories and can enumerate an empty journal", { skip: windowsOnly }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexbridge-runtime-dirs-"));
  const capabilities = createWindowsFileCapabilities({ nativeApi: createWin32FileApi() });
  try {
    await capabilities.ensureManagedDirectoriesNoFollow(root, ["state", "journal"]);
    const journal = await capabilities.openJournalDirectoryNoFollow(path.join(root, "journal"));
    try {
      assert.deepEqual(await journal.listFileNamesNoFollow(), []);
    } finally {
      await journal.close();
    }
  } finally {
    await fs.rmdir(path.join(root, "journal"));
    await fs.rmdir(path.join(root, "state"));
    await fs.rmdir(root);
  }
});

function child(mode, stateDir, label, nonce) {
  return fork(childPath, [mode, stateDir, label, ...(nonce ? [nonce] : [])], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
}

function waitMessage(processHandle, type, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`child_timeout:${type}`)), timeoutMs);
    processHandle.on("message", (message) => {
      if (message?.type !== type) return;
      clearTimeout(timeout);
      resolve(message);
    });
    processHandle.once("error", reject);
  });
}

async function createStateDir(label) {
  return fs.mkdtemp(path.join(process.cwd(), `.tmp-win32-${label}-`));
}

async function cleanupStateDir(stateDir, operationNonce = null) {
  const names = [
    "ownership.json.tmp", "ownership.json.bak", "ownership.json", ".codexbridge-ownership.lock",
    ...(operationNonce ? [`.codexbridge-operation-prepare-${operationNonce}.lock`] : []),
    "attack-target.txt", "attack-hardlink.lock", "attack-reparse.lock",
  ];
  for (const name of names) {
    await fs.unlink(path.join(stateDir, name)).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  await fs.rmdir(stateDir).catch((error) => { if (error?.code !== "ENOENT") throw error; });
}

test("production Win32 child CAS allows exactly one generation-zero writer", { skip: windowsOnly }, async () => {
  const stateDir = await createStateDir("cas");
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

test("production Win32 locks recover after SIGKILL and operation claims stay live until then", { skip: windowsOnly }, async () => {
  const stateDir = await createStateDir("crash");
  const nonce = "a".repeat(32);
  let holder;
  try {
    holder = child("hold-operation", stateDir, "live-download", nonce);
    await waitMessage(holder, "claimed");
    const liveProbe = child("probe-operation", stateDir, "live", nonce);
    assert.equal((await waitMessage(liveProbe, "result")).status, "live");
    holder.kill("SIGKILL");
    await new Promise((resolve) => holder.once("exit", resolve));
    holder = null;
    const recovery = child("probe-operation", stateDir, "recovery", nonce);
    assert.equal((await waitMessage(recovery, "result")).status, "recovered");
    await assert.rejects(
      fs.access(path.join(stateDir, `.codexbridge-operation-prepare-${nonce}.lock`)),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    if (holder) holder.kill("SIGKILL");
    await cleanupStateDir(stateDir, nonce);
  }
});

test("production Win32 delete-on-close removes a lease killed before its claim is persisted", { skip: windowsOnly }, async () => {
  const stateDir = await createStateDir("lease-preclaim-crash");
  const nonce = "b".repeat(32);
  const leasePath = path.join(stateDir, `.codexbridge-operation-prepare-${nonce}.lock`);
  let holder;
  try {
    holder = child("hold-operation-before-claim", stateDir, "preclaim", nonce);
    await waitMessage(holder, "leased");
    await fs.access(leasePath);
    holder.kill("SIGKILL");
    await new Promise((resolve) => holder.once("exit", resolve));
    holder = null;
    await assert.rejects(fs.access(leasePath), (error) => error?.code === "ENOENT");
  } finally {
    if (holder) holder.kill("SIGKILL");
    await cleanupStateDir(stateDir, nonce);
  }
});

test("production Win32 rejects hard-link and reparse-point lock substitution", { skip: windowsOnly }, async () => {
  const stateDir = await createStateDir("attacks");
  const nativeApi = createWin32FileApi();
  const capabilities = createWindowsFileCapabilities({ nativeApi });
  const target = path.join(stateDir, "attack-target.txt");
  const stateLock = path.join(stateDir, ".codexbridge-ownership.lock");
  try {
    await fs.writeFile(target, "attacker-controlled");
    await fs.link(target, stateLock);
    await assert.rejects(capabilities.acquireStateLockNoFollow(stateDir), /windows_hard_link_rejected/u);
    await fs.unlink(stateLock);
    await fs.symlink(target, stateLock, "file");
    await assert.rejects(capabilities.acquireStateLockNoFollow(stateDir), /windows_reparse_point_rejected/u);
  } finally { await cleanupStateDir(stateDir); }
});

test("production Win32 state locks are directory-scoped and waiting keeps the child event loop responsive", { skip: windowsOnly }, async () => {
  const firstDir = await createStateDir("scope-a");
  const secondDir = await createStateDir("scope-b");
  let holder;
  try {
    holder = child("hold-state", firstDir, "holder");
    await waitMessage(holder, "locked");

    const independent = child("cas", secondDir, "Independent");
    await waitMessage(independent, "ready");
    const independentResult = waitMessage(independent, "result");
    independent.send("go");
    assert.equal((await independentResult).status, "saved");

    const waiting = child("responsive-load", firstDir, "waiting");
    await waitMessage(waiting, "responsive", 2_000);
    const waitingResult = waitMessage(waiting, "result");
    holder.send("release");
    await new Promise((resolve) => holder.once("exit", resolve));
    holder = null;
    assert.equal((await waitingResult).status, "loaded");
  } finally {
    if (holder?.connected) holder.send("release");
    if (holder) await new Promise((resolve) => holder.once("exit", resolve));
    await cleanupStateDir(firstDir);
    await cleanupStateDir(secondDir);
  }
});
