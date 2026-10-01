function createKeyedSingleFlight() {
  const flights = new Map();
  return function runSingleFlight(key, action) {
    if (typeof action !== "function") {
      throw new TypeError("Single-flight action must be a function.");
    }
    const normalizedKey = String(key ?? "");
    const existing = flights.get(normalizedKey);
    if (existing) return existing;
    let tracked = Promise.resolve().then(action);
    tracked = tracked.finally(() => {
      if (flights.get(normalizedKey) === tracked) flights.delete(normalizedKey);
    });
    flights.set(normalizedKey, tracked);
    return tracked;
  };
}

module.exports = {
  createKeyedSingleFlight,
};
