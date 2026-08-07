import { AsyncLocalStorage } from "node:async_hooks";

const COORDINATORS = new WeakMap();
const TRANSACTION_CONTEXT = new AsyncLocalStorage();

function coordinatorError(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function validGeneration(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function getOwnershipCoordinator(ownershipStore) {
  if (!ownershipStore || typeof ownershipStore.load !== "function"
    || typeof ownershipStore.compareAndSwap !== "function") {
    throw coordinatorError("ownership_coordinator_store_invalid");
  }
  const existing = COORDINATORS.get(ownershipStore);
  if (existing) return existing;

  let queue = Promise.resolve();
  let coordinator;
  const transactionStore = Object.freeze({
    async load() {
      const context = TRANSACTION_CONTEXT.getStore();
      if (context?.coordinator !== coordinator) throw coordinatorError("ownership_transaction_required");
      return structuredClone(context.state);
    },
    async save(next) {
      const context = TRANSACTION_CONTEXT.getStore();
      if (context?.coordinator !== coordinator) throw coordinatorError("ownership_transaction_required");
      if (!next || typeof next !== "object" || Array.isArray(next)) {
        throw coordinatorError("ownership_transaction_state_invalid");
      }
      const saved = await ownershipStore.compareAndSwap(context.state.generation, {
        ...structuredClone(next), generation: context.state.generation + 1,
      });
      if (!validGeneration(saved?.generation) || saved.generation !== context.state.generation + 1) {
        throw coordinatorError("ownership_generation_commit_invalid");
      }
      context.state = structuredClone(saved);
      return structuredClone(saved);
    },
  });

  async function runExclusive(action) {
    if (typeof action !== "function") throw coordinatorError("ownership_transaction_action_invalid");
    const inherited = TRANSACTION_CONTEXT.getStore();
    if (inherited?.coordinator === coordinator) return action(transactionStore);
    const previous = queue;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    queue = previous.then(() => gate, () => gate);
    await previous.catch(() => {});
    try {
      const loaded = await ownershipStore.load();
      if (!validGeneration(loaded?.generation)) throw coordinatorError("ownership_generation_invalid");
      return await TRANSACTION_CONTEXT.run(
        { coordinator, state: structuredClone(loaded) },
        () => action(transactionStore),
      );
    } finally {
      release();
    }
  }

  coordinator = Object.freeze({ runExclusive, store: transactionStore });
  COORDINATORS.set(ownershipStore, coordinator);
  return coordinator;
}
