function listenServerWithDeadline(server, {
  port = 0,
  host = "127.0.0.1",
  timeoutMs = 5_000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (!server || typeof server.listen !== "function" || typeof server.once !== "function") {
    throw new TypeError("A listenable server is required.");
  }
  const deadlineMs = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5_000;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer !== null) clearTimeoutFn(timer);
      server.removeListener("error", onError);
      server.removeListener("close", onClose);
    };
    const finish = (callback, value, { close = false } = {}) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (close) {
        const ignoreLateError = () => {};
        const releaseGuard = () => server.removeListener("error", ignoreLateError);
        server.once("error", ignoreLateError);
        server.once("close", releaseGuard);
        try { server.close(); } catch {}
      }
      callback(value);
    };
    const onError = (error) => finish(reject, error, { close: true });
    const onClose = () => finish(
      reject,
      listenError("SERVER_LISTEN_CLOSED", "Local server closed before listening."),
    );
    server.once("error", onError);
    server.once("close", onClose);
    timer = setTimeoutFn(() => finish(
      reject,
      listenError("SERVER_LISTEN_TIMEOUT", `Local server did not listen within ${deadlineMs} ms.`),
      { close: true },
    ), deadlineMs);
    timer?.unref?.();
    try {
      server.listen(port, host, () => finish(resolve, server.address?.() || null));
    } catch (error) {
      finish(reject, error, { close: true });
    }
  });
}

function listenError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  listenServerWithDeadline,
};
