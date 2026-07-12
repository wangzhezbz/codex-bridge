function createResilientStateReader({
  readSnapshot,
  createFallbackSnapshot = () => ({}),
  reportFailure = () => {},
} = {}) {
  if (typeof readSnapshot !== "function") {
    throw new TypeError("readSnapshot must be a function");
  }
  if (typeof createFallbackSnapshot !== "function") {
    throw new TypeError("createFallbackSnapshot must be a function");
  }
  if (typeof reportFailure !== "function") {
    throw new TypeError("reportFailure must be a function");
  }

  let lastCompleteSnapshot = null;

  return async function readResilientState(options = {}) {
    try {
      const snapshot = await readSnapshot(options);
      if (!isPlainSnapshot(snapshot)) {
        throw new TypeError("State snapshot must be a plain object");
      }
      const completeSnapshot = {
        ...snapshot,
        stateUnavailable: false,
      };
      lastCompleteSnapshot = completeSnapshot;
      return completeSnapshot;
    } catch (error) {
      try {
        reportFailure(error);
      } catch {
        // Diagnostics are best effort after a failed state refresh.
      }

      let fallback = lastCompleteSnapshot;
      if (!fallback) {
        try {
          const candidate = createFallbackSnapshot(options);
          fallback = isPlainSnapshot(candidate) ? candidate : {};
        } catch {
          fallback = {};
        }
      }
      return {
        ...fallback,
        stateUnavailable: true,
      };
    }
  };
}

function isPlainSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

module.exports = {
  createResilientStateReader,
};
