import {
  ClientClosedRequestError,
  UpstreamTimeoutError,
} from "./upstream-response-guard.js";
import { responseUsesEventStream } from "./responses-stream-policy.js";

const DEFAULT_UPSTREAM_TIMEOUT_MS = 600_000;
const DEFAULT_STREAMING_PROXY_HEADER_TIMEOUT_MS = 600_000;

export function streamingProxyFetchOptions(route = {}, options = {}, usedProxy = false) {
  if (!usedProxy || !options.streamingResponse) {
    return options;
  }
  const routeTimeout = upstreamTimeoutMs(route, options);
  const configuredHeaderTimeout = Number(
    options.proxyHeaderTimeoutMs ??
      route.proxyHeaderTimeoutMs ??
      route.proxy_header_timeout_ms,
  );
  const headerTimeout = Number.isFinite(configuredHeaderTimeout) && configuredHeaderTimeout > 0
    ? Math.floor(configuredHeaderTimeout)
    : DEFAULT_STREAMING_PROXY_HEADER_TIMEOUT_MS;
  return {
    ...options,
    timeoutMs: routeTimeout > 0 ? Math.min(routeTimeout, headerTimeout) : headerTimeout,
  };
}

export function createUpstreamRequestLifecycle(
  init = {},
  upstreamUrl = "",
  route = {},
  options = {},
  context = {},
) {
  const controller = new AbortController();
  const cleanup = [];
  let timeoutTriggered = false;
  let clientTriggered = Boolean(context.clientSignal?.aborted);
  const timeoutMs = upstreamTimeoutMs(route, options);
  let clearRequestTimeout = () => {};

  const abort = (reason) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  if (init.signal) {
    if (init.signal.aborted) {
      abort(init.signal.reason);
    } else {
      const onAbort = () => abort(init.signal.reason);
      init.signal.addEventListener("abort", onAbort, { once: true });
      cleanup.push(() => init.signal.removeEventListener("abort", onAbort));
    }
  }

  if (context.clientSignal) {
    if (context.clientSignal.aborted) {
      clientTriggered = true;
      abort(context.clientSignal.reason);
    } else {
      const onClientAbort = () => {
        clientTriggered = true;
        abort(context.clientSignal.reason);
      };
      context.clientSignal.addEventListener("abort", onClientAbort, { once: true });
      cleanup.push(() => context.clientSignal.removeEventListener("abort", onClientAbort));
    }
  }

  if (timeoutMs > 0) {
    const timeout = setTimeout(() => {
      timeoutTriggered = true;
      abort(new Error(`upstream timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    clearRequestTimeout = () => clearTimeout(timeout);
    cleanup.push(clearRequestTimeout);
  }

  const clientAborted = () => clientTriggered || Boolean(context.clientSignal?.aborted);
  const timedOut = () => timeoutTriggered;

  return {
    init: {
      ...init,
      signal: controller.signal,
    },
    timeoutMs,
    clientAborted,
    timedOut,
    errorFor: (error) => {
      if (clientAborted()) {
        return new ClientClosedRequestError();
      }
      if (timedOut()) {
        return new UpstreamTimeoutError(timeoutMs, upstreamUrl, route);
      }
      return error;
    },
    responseStarted: (response) => {
      if (options.streamingResponse && responseUsesEventStream(response)) {
        clearRequestTimeout();
      }
    },
    cleanup: () => {
      for (const fn of cleanup.splice(0)) {
        fn();
      }
    },
  };
}

export function upstreamTimeoutMs(route = {}, options = {}) {
  const value = Number(
    options.timeoutMs ??
      route.upstreamTimeoutMs ??
      route.upstream_timeout_ms ??
      route.requestTimeoutMs ??
      route.request_timeout_ms,
  );
  if (Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return DEFAULT_UPSTREAM_TIMEOUT_MS;
}
