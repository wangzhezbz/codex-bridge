const DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES = 64 * 1024 * 1024;
const DEFAULT_UPSTREAM_RESPONSE_IDLE_TIMEOUT_MS = 600_000;

export class UpstreamTimeoutError extends Error {
  constructor(timeoutMs, upstreamUrl, route = {}) {
    super(
      `CodexBridge upstream request timed out after ${timeoutMs}ms` +
        (route.displayName || route.id ? ` from ${route.displayName || route.id}` : "") +
        `. url=${safeUrl(upstreamUrl)}`,
    );
    this.name = "UpstreamTimeoutError";
    this.statusCode = 504;
    this.code = "upstream_timeout";
    this.timeoutMs = timeoutMs;
    this.upstreamUrl = upstreamUrl;
    this.route = {
      id: route.id || "",
      displayName: route.displayName || "",
      model: route.model || "",
      api: route.api || "",
    };
  }
}

export class UpstreamResponseTooLargeError extends Error {
  constructor(limitBytes, actualBytes, upstreamUrl, route = {}) {
    super(
      `CodexBridge upstream response exceeded ${limitBytes} bytes` +
        (Number.isFinite(actualBytes) ? ` (received at least ${actualBytes} bytes)` : "") +
        (route.displayName || route.id ? ` from ${route.displayName || route.id}` : "") +
        `. url=${safeUrl(upstreamUrl)}`,
    );
    this.name = "UpstreamResponseTooLargeError";
    this.statusCode = 502;
    this.code = "upstream_response_too_large";
    this.limitBytes = limitBytes;
    this.actualBytes = actualBytes;
    this.upstreamUrl = upstreamUrl;
    this.route = {
      id: route.id || "",
      displayName: route.displayName || "",
      model: route.model || "",
      api: route.api || "",
    };
  }
}

export class ClientClosedRequestError extends Error {
  constructor() {
    super("CodexBridge client connection closed before the upstream response completed.");
    this.name = "ClientClosedRequestError";
    this.statusCode = 499;
    this.code = "client_closed_request";
  }
}

export async function writeResponseChunk(res, chunk, context = {}) {
  if (res.destroyed || res.writableEnded || context.clientSignal?.aborted) {
    throw new ClientClosedRequestError();
  }

  let accepted;
  try {
    accepted = res.write(chunk);
  } catch (error) {
    if (isClientClosedStreamWrite(context, res, error)) {
      throw new ClientClosedRequestError();
    }
    throw error;
  }
  if (accepted !== false) {
    return;
  }

  await new Promise((resolve, reject) => {
    let settled = false;
    let drainTimeout = null;
    const cleanup = () => {
      if (drainTimeout) {
        clearTimeout(drainTimeout);
      }
      res.removeListener?.("drain", onDrain);
      res.removeListener?.("close", onClose);
      res.removeListener?.("error", onError);
      context.clientSignal?.removeEventListener("abort", onAbort);
    };
    const settle = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const onDrain = () => settle(resolve);
    const onClose = () => settle(() => reject(new ClientClosedRequestError()));
    const onError = (error) => settle(() => reject(error));
    const onAbort = () => settle(() => reject(new ClientClosedRequestError()));

    res.once?.("drain", onDrain);
    res.once?.("close", onClose);
    res.once?.("error", onError);
    context.clientSignal?.addEventListener("abort", onAbort, { once: true });
    const configuredDrainTimeoutMs = Number(context.downstreamDrainTimeoutMs);
    const drainTimeoutMs =
      Number.isFinite(configuredDrainTimeoutMs) && configuredDrainTimeoutMs >= 0
        ? Math.floor(configuredDrainTimeoutMs)
        : DEFAULT_UPSTREAM_RESPONSE_IDLE_TIMEOUT_MS;
    if (drainTimeoutMs > 0) {
      drainTimeout = setTimeout(onClose, drainTimeoutMs);
    }

    if (res.destroyed || res.writableEnded || context.clientSignal?.aborted) {
      onClose();
    }
  });
}

export async function readUpstreamText(
  upstream,
  context = {},
  route = {},
  upstreamUrl = "",
  options = {},
) {
  if (!upstream?.body) {
    return "";
  }
  const chunks = [];
  for await (const chunk of readUpstreamBody(
    upstream,
    context,
    route,
    upstreamUrl,
    options,
  )) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function* readUpstreamBody(
  upstream,
  context = {},
  route = {},
  upstreamUrl = "",
  options = {},
) {
  if (!upstream?.body) {
    return;
  }
  if (context.clientSignal?.aborted) {
    throw new ClientClosedRequestError();
  }

  const limitBytes = upstreamResponseLimitBytes(route, options);
  const declaredBytes = parseContentLength(upstream.headers?.get?.("content-length"));
  if (limitBytes > 0 && declaredBytes !== null && declaredBytes > limitBytes) {
    await cancelUpstreamResponse(upstream);
    throw new UpstreamResponseTooLargeError(
      limitBytes,
      declaredBytes,
      upstreamUrl,
      route,
    );
  }

  const idleTimeoutMs = upstreamResponseIdleTimeoutMs(route, options);
  const reader = upstream.body.getReader();
  let actualBytes = 0;
  let completed = false;
  try {
    while (true) {
      const result = await readUpstreamChunk(
        reader,
        context.clientSignal,
        idleTimeoutMs,
        upstreamUrl,
        route,
      );
      if (result.done) {
        completed = true;
        break;
      }
      const chunk = Buffer.from(result.value);
      actualBytes += chunk.byteLength;
      if (limitBytes > 0 && actualBytes > limitBytes) {
        const error = new UpstreamResponseTooLargeError(
          limitBytes,
          actualBytes,
          upstreamUrl,
          route,
        );
        await reader.cancel(error).catch(() => {});
        throw error;
      }
      yield chunk;
    }
  } finally {
    if (!completed) {
      await reader.cancel(new ClientClosedRequestError()).catch(() => {});
    }
    reader.releaseLock();
  }
}

export function upstreamResponseLimitBytes(route = {}, options = {}) {
  const value = Number(
    options.maxResponseBytes ??
      route.maxUpstreamResponseBytes ??
      route.max_upstream_response_bytes,
  );
  if (Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES;
}

export function upstreamResponseIdleTimeoutMs(route = {}, options = {}) {
  const value = Number(
    options.responseIdleTimeoutMs ??
      route.upstreamResponseIdleTimeoutMs ??
      route.upstream_response_idle_timeout_ms,
  );
  if (Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return DEFAULT_UPSTREAM_RESPONSE_IDLE_TIMEOUT_MS;
}

export function isClientClosedStreamWrite(context = {}, res = {}, error) {
  if (!context.clientSignal?.aborted) {
    return false;
  }
  const code = String(error?.code || "");
  const message = String(error?.message || error || "");
  return (
    Boolean(res.destroyed) ||
    code === "client_closed_request" ||
    code === "ERR_STREAM_DESTROYED" ||
    /write after end|stream.*destroyed|client connection closed/i.test(message)
  );
}

export async function cancelUpstreamResponse(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // The next response path is authoritative; cancellation is best-effort cleanup.
  }
}

function readUpstreamChunk(reader, clientSignal, idleTimeoutMs, upstreamUrl, route) {
  let timeout = null;
  let abortHandler = null;
  const guards = [];
  if (idleTimeoutMs > 0) {
    guards.push(new Promise((_, reject) => {
      timeout = setTimeout(() => {
        const error = new UpstreamTimeoutError(idleTimeoutMs, upstreamUrl, route);
        reject(error);
        reader.cancel(error).catch(() => {});
      }, idleTimeoutMs);
    }));
  }
  if (clientSignal) {
    guards.push(new Promise((_, reject) => {
      abortHandler = () => {
        const error = new ClientClosedRequestError();
        reject(error);
        reader.cancel(clientSignal.reason).catch(() => {});
      };
      clientSignal.addEventListener("abort", abortHandler, { once: true });
    }));
  }

  return Promise.race([reader.read(), ...guards]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
    if (abortHandler) {
      clientSignal.removeEventListener("abort", abortHandler);
    }
  });
}

function parseContentLength(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(value);
  }
}
