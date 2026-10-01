const http = require("node:http");

const DEFAULT_MAX_BYTES = 256 * 1024;
const HARD_MAX_BYTES = 1024 * 1024;
const HARD_MAX_TIMEOUT_MS = 30_000;

function requestBoundedJsonOverHttp(url, {
  timeoutMs = 1200,
  maxBytes = DEFAULT_MAX_BYTES,
  headers = {},
  httpImpl = http,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const deadlineMs = Math.min(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1200,
    HARD_MAX_TIMEOUT_MS,
  );
  const byteLimit = Math.min(
    Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES,
    HARD_MAX_BYTES,
  );
  return new Promise((resolve) => {
    let request = null;
    let response = null;
    let timer = null;
    let settled = false;
    let total = 0;
    const chunks = [];
    const cleanup = () => {
      if (timer !== null) clearTimeoutFn(timer);
      request?.removeListener?.("error", onRequestError);
      request?.removeListener?.("close", onRequestClose);
      response?.removeListener?.("data", onData);
      response?.removeListener?.("end", onEnd);
      response?.removeListener?.("error", onResponseFailure);
      response?.removeListener?.("aborted", onResponseFailure);
      response?.removeListener?.("close", onResponseClose);
    };
    const finish = (value, { destroy = false } = {}) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (destroy) {
        guardLateError(response);
        guardLateError(request);
        try { response?.destroy?.(); } catch {}
        try { request?.destroy?.(); } catch {}
      }
      resolve(value);
    };
    const guardLateError = (target) => {
      if (!target?.once || !target?.removeListener) return;
      const ignoreLateError = () => {};
      const releaseGuard = () => target.removeListener("error", ignoreLateError);
      target.once("error", ignoreLateError);
      target.once("close", releaseGuard);
    };
    const onRequestError = () => finish(null);
    const onRequestClose = () => {
      if (!response) finish(null);
    };
    const onResponseFailure = () => finish(null);
    const onResponseClose = () => {
      if (!settled) finish(null);
    };
    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > byteLimit) {
        finish(null, { destroy: true });
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => {
      if (response.statusCode !== 200) {
        finish(null);
        return;
      }
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        finish(null);
      }
    };
    const onResponse = (incoming) => {
      response = incoming;
      const contentLength = Number.parseInt(String(incoming.headers?.["content-length"] || ""), 10);
      if (incoming.statusCode !== 200 ||
          (Number.isFinite(contentLength) && contentLength > byteLimit)) {
        finish(null, { destroy: true });
        return;
      }
      incoming.on("data", onData);
      incoming.once("end", onEnd);
      incoming.once("error", onResponseFailure);
      incoming.once("aborted", onResponseFailure);
      incoming.once("close", onResponseClose);
    };

    try {
      request = httpImpl.get(url, { headers }, onResponse);
      request.once("error", onRequestError);
      request.once("close", onRequestClose);
    } catch {
      finish(null);
      return;
    }
    if (!settled) {
      timer = setTimeoutFn(() => finish(null, { destroy: true }), deadlineMs);
      timer?.unref?.();
    }
  });
}

module.exports = {
  requestBoundedJsonOverHttp,
};
