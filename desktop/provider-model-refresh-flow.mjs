export function createProviderModelRefreshFlow({
  fetchCandidate,
  commitCandidate,
} = {}) {
  if (typeof fetchCandidate !== "function") {
    throw new TypeError("fetchCandidate must be a function.");
  }
  if (typeof commitCandidate !== "function") {
    throw new TypeError("commitCandidate must be a function.");
  }

  const inFlight = new Map();

  return {
    refresh(providerId) {
      const id = String(providerId || "").trim();
      const current = inFlight.get(id);
      if (current) {
        return current;
      }

      const task = (async () => {
        const result = await fetchCandidate(id);
        const committed = result?.ok
          ? await commitCandidate(result)
          : null;
        return { result, committed };
      })();
      inFlight.set(id, task);
      task.finally(() => {
        if (inFlight.get(id) === task) {
          inFlight.delete(id);
        }
      }).catch(() => {});
      return task;
    },
  };
}
