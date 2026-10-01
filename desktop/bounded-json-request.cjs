function readBoundedJsonRequest(req, {
  limitBytes = 1024 * 1024,
  timeoutMs = 30_000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const byteLimit = Number.isSafeInteger(limitBytes) && limitBytes > 0
    ? limitBytes
    : 1024 * 1024;
  const deadlineMs = Number.isSafeInteger(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : 30_000;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer !== null) clearTimeoutFn(timer);
      req.removeListener("data", onData);
      req.removeListener("error", onError);
      req.removeListener("end", onEnd);
      req.removeListener("aborted", onAborted);
      req.removeListener("close", onClose);
    };
    const finish = (callback, value, { destroy = false } = {}) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (destroy && typeof req.destroy === "function" && !req.destroyed) {
        const ignoreLateError = () => {};
        const releaseGuard = () => req.removeListener("error", ignoreLateError);
        req.once("error", ignoreLateError);
        req.once("close", releaseGuard);
        try { req.destroy(); } catch {}
      }
      callback(value);
    };
    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > byteLimit) {
        finish(reject, requestError(
          "local_executor_request_too_large",
          "本地能力执行器请求体过大，请减少输入内容后重试。",
        ), { destroy: true });
        return;
      }
      chunks.push(bytes);
    };
    const onError = (error) => finish(reject, error);
    const onAborted = () => finish(reject, requestError(
      "local_executor_request_aborted",
      "本地能力执行器请求已取消。",
    ));
    const onClose = () => {
      if (!settled) {
        finish(reject, requestError(
          "local_executor_request_aborted",
          "本地能力执行器请求在传输完成前关闭。",
        ));
      }
    };
    const onEnd = () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        finish(resolve, text.trim() ? JSON.parse(text) : {});
      } catch {
        finish(reject, requestError(
          "local_executor_invalid_json",
          "本地能力执行器请求不是有效的 JSON。",
        ));
      }
    };

    req.on("data", onData);
    req.on("error", onError);
    req.on("end", onEnd);
    req.on("aborted", onAborted);
    req.on("close", onClose);
    timer = setTimeoutFn(() => finish(reject, requestError(
      "local_executor_request_timeout",
      `本地能力执行器请求体超过 ${Math.ceil(deadlineMs / 1000)} 秒仍未传输完成。`,
    ), { destroy: true }), deadlineMs);
    timer?.unref?.();
  });
}

function requestError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  readBoundedJsonRequest,
};
