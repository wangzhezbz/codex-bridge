async function buildConsistentStateSnapshot({
  readRevision,
  buildSnapshot,
  maxAttempts = 3,
} = {}) {
  if (typeof readRevision !== "function" || typeof buildSnapshot !== "function") {
    throw new TypeError("Consistent state snapshots require revision and builder functions.");
  }
  const attempts = Number.isSafeInteger(maxAttempts) && maxAttempts > 0
    ? Math.min(maxAttempts, 8)
    : 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const before = normalizeRevision(readRevision());
    const snapshot = await buildSnapshot({ attempt, revision: before });
    const after = normalizeRevision(readRevision());
    if (before === after) {
      return snapshot;
    }
  }
  const error = new Error(
    `Desktop state changed during ${attempts} consecutive snapshot attempts.`,
  );
  error.code = "STATE_SNAPSHOT_CHANGED_DURING_READ";
  error.attempts = attempts;
  throw error;
}

function normalizeRevision(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

module.exports = {
  buildConsistentStateSnapshot,
};
