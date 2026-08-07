import { createOwnershipStore } from "../../desktop/software-manager/state-store.mjs";
import { createWin32FileApi } from "../../desktop/software-manager/win32-file-api.mjs";
import { createWindowsFileCapabilities } from "../../desktop/software-manager/windows-file-capabilities.mjs";

function state(installRoot = null) {
  return {
    schemaVersion: 1, generation: 0, installRoot, components: {}, skills: {}, shortcuts: [], rollback: null,
    activeTask: null, lastTask: null,
  };
}

const [mode, stateDir, label = "child", nonce = "1".repeat(32)] = process.argv.slice(2);
const fsApi = createWindowsFileCapabilities({ nativeApi: createWin32FileApi() });
const store = createOwnershipStore({ stateDir, fsApi });

if (mode === "hold-state") {
  const lock = await fsApi.acquireStateLockNoFollow(stateDir);
  process.send?.({ type: "locked" });
  process.on("message", async (message) => {
    if (message === "release") { await lock.release(); process.exit(0); }
  });
} else if (mode === "responsive-load") {
  const timer = setTimeout(() => process.send?.({ type: "responsive" }), 50);
  try {
    const loaded = await store.load();
    clearTimeout(timer);
    process.send?.({ type: "result", status: "loaded", generation: loaded.generation });
  } catch (error) {
    clearTimeout(timer);
    process.send?.({ type: "result", status: "failed", code: error?.code ?? error?.message });
  } finally { process.exit(0); }
} else if (mode === "hold-operation") {
  const lease = await store.acquireOperationLease({ nonce, scope: "prepare", wait: true });
  const next = state();
  next.activeTask = {
    kind: "component-prepare", taskId: label, componentId: "chatgpt", version: "2.0.0",
    leaseScope: "prepare", leaseNonce: nonce,
  };
  await store.compareAndSwap(0, next);
  process.send?.({ type: "claimed" });
  process.on("message", async (message) => {
    if (message === "release") { await lease.release(); process.exit(0); }
  });
} else if (mode === "probe-operation") {
  const current = await store.load();
  const task = current.activeTask;
  const lease = await store.acquireOperationLease({ nonce: task.leaseNonce, scope: task.leaseScope, wait: false });
  if (lease === null) {
    process.send?.({ type: "result", status: "live", generation: current.generation });
  } else {
    const next = structuredClone(current);
    next.activeTask = null;
    await store.compareAndSwap(current.generation, next);
    await lease.release();
    process.send?.({ type: "result", status: "recovered" });
  }
  process.exit(0);
} else {
  process.send?.({ type: "ready" });
  process.on("message", async (message) => {
    if (message !== "go") return;
    try {
      const saved = await store.compareAndSwap(0, state(`D:\\${label}`));
      process.send?.({ type: "result", status: "saved", generation: saved.generation });
    } catch (error) {
      process.send?.({ type: "result", status: "failed", code: error?.code ?? error?.message });
    } finally { process.exit(0); }
  });
}
