export async function commitThenPublishConfigMutation({
  commit,
  onCommitted,
  publish,
  onPostCommitError,
} = {}) {
  if (typeof commit !== "function") {
    throw new TypeError("commit must be a function");
  }
  if (onCommitted !== undefined && typeof onCommitted !== "function") {
    throw new TypeError("onCommitted must be a function");
  }
  if (publish !== undefined && typeof publish !== "function") {
    throw new TypeError("publish must be a function");
  }
  if (onPostCommitError !== undefined && typeof onPostCommitError !== "function") {
    throw new TypeError("onPostCommitError must be a function");
  }

  const committed = await commit();
  if (onCommitted) {
    try {
      await onCommitted(committed);
    } catch (error) {
      await reportPostCommitError(onPostCommitError, error, "onCommitted");
    }
  }
  if (publish) {
    try {
      await publish(committed);
    } catch (error) {
      await reportPostCommitError(onPostCommitError, error, "publish");
    }
  }
  return committed;
}

async function reportPostCommitError(handler, error, phase) {
  if (!handler) {
    return;
  }
  try {
    await handler(error, phase);
  } catch {
    // A durable commit must never be reported as failed by diagnostics hooks.
  }
}
