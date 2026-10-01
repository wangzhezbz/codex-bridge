const DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES = 64 * 1024 * 1024;
const DEFAULT_UPSTREAM_RESPONSE_IDLE_TIMEOUT_MS = 600_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

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
    const onDrainTimeout = () => settle(() => {
      // The peer can still be connected while never draining. Rejecting alone
      // leaves that socket open and the client waiting for an unfinished SSE.
      try { res.destroy?.(); } catch { /* Preserve the termination error below. */ }
      reject(new ClientClosedRequestError());
    });

    res.once?.("drain", onDrain);
    res.once?.("close", onClose);
    res.once?.("error", onError);
    context.clientSignal?.addEventListener("abort", onAbort, { once: true });
    const configuredDrainTimeoutMs = Number(context.downstreamDrainTimeoutMs);
    const drainTimeoutMs =
      Number.isFinite(configuredDrainTimeoutMs) && configuredDrainTimeoutMs >= 0
        ? Math.min(Math.floor(configuredDrainTimeoutMs), MAX_TIMER_DELAY_MS)
        : DEFAULT_UPSTREAM_RESPONSE_IDLE_TIMEOUT_MS;
    if (drainTimeoutMs > 0) {
      drainTimeout = setTimeout(onDrainTimeout, drainTimeoutMs);
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
    await cancelUpstreamResponse(upstream);
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
      if (context.clientSignal?.aborted) {
        throw new ClientClosedRequestError();
      }
      const result = await readUpstreamChunk(
        reader,
        context.clientSignal,
        idleTimeoutMs,
        upstreamUrl,
        route,
      );
      if (context.clientSignal?.aborted) {
        throw new ClientClosedRequestError();
      }
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
        cancelReaderBestEffort(reader, error);
        throw error;
      }
      yield chunk;
    }
  } finally {
    if (!completed) {
      cancelReaderBestEffort(reader, new ClientClosedRequestError());
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
  const wholeBytes = Math.floor(value);
  if (Number.isFinite(wholeBytes) && wholeBytes > 0) {
    return wholeBytes;
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
    return Math.min(Math.floor(value), MAX_TIMER_DELAY_MS);
  }
  return DEFAULT_UPSTREAM_RESPONSE_IDLE_TIMEOUT_MS;
}

export function isClientClosedStreamWrite(context = {}, res = {}, error) {
  // Our writer can terminate a stalled client before its close/abort event is
  // delivered. Do not retry writing an upstream-error event to that response.
  if (error instanceof ClientClosedRequestError) return true;
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
    cancelReaderBestEffort(response?.body);
  } catch {
    // The next response path is authoritative; cancellation is best-effort cleanup.
  }
}

function cancelReaderBestEffort(reader, reason) {
  try {
    // A stream can close while its underlying cancellation never settles. Cleanup
    // must not delay a timeout, size rejection, or client cancellation.
    Promise.resolve(reader?.cancel?.(reason)).catch(() => {});
  } catch {
    // The stream error or client cancellation remains authoritative.
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
        void cancelReaderBestEffort(reader, error);
      }, idleTimeoutMs);
    }));
  }
  if (clientSignal) {
    guards.push(new Promise((_, reject) => {
      abortHandler = () => {
        const error = new ClientClosedRequestError();
        reject(error);
        void cancelReaderBestEffort(reader, clientSignal.reason);
      };
      clientSignal.addEventListener("abort", abortHandler, { once: true });
    }));
  }

  // Even a synchronous read fault must attach handlers to the armed guards and
  // reach cleanup. Keep normal read promises and invocation timing unchanged.
  let pendingRead;
  try {
    pendingRead = reader.read();
  } catch (error) {
    pendingRead = Promise.reject(error);
  }
  return Promise.race([pendingRead, ...guards]).finally(() => {
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
