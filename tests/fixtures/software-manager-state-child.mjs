import { createOwnershipStore } from "../../desktop/software-manager/state-store.mjs";
import { acquireTestStateLock, createTestStateFs } from "../helpers/software-manager-test-state-fs.mjs";

function state(installRoot = null) {
  return {
    schemaVersion: 1, generation: 0, installRoot, components: {}, skills: {}, shortcuts: [], rollback: null,
    activeTask: null, lastTask: null,
  };
}

const [mode, stateDir, label = "child"] = process.argv.slice(2);

if (mode === "hold") {
  const lock = await acquireTestStateLock(stateDir);
  process.send?.({ type: "locked" });
  process.on("message", async (message) => {
    if (message === "release") { await lock.release(); process.exit(0); }
  });
} else {
  const store = createOwnershipStore({ stateDir, fsApi: createTestStateFs() });
  process.send?.({ type: "ready" });
  process.on("message", async (message) => {
    if (message !== "go") return;
    try {
      const saved = await store.compareAndSwap(0, state(`D:\\${label}`));
      process.send?.({ type: "result", status: "saved", generation: saved.generation });
    } catch (error) {
      process.send?.({ type: "result", status: "failed", code: error?.code ?? error?.message });
    } finally {
      process.exit(0);
    }
  });
}
