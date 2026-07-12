export function createGracefulShutdown(options = {}) {
  const server = options.server;
  const processRef = options.processRef || process;
  const logger = options.logger || console;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 5_000;
  const signals = options.signals || ["SIGTERM", "SIGINT"];
  let installed = false;
  let shutdownPromise = null;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const handlers = new Map();

  function shutdown(reason = "manual") {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    logger.log?.(`Bridge shutdown requested: ${reason}`);
    shutdownPromise = new Promise((resolve) => {
      let settled = false;
      const finish = (error = null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (error) {
          processRef.exitCode = 1;
          logger.error?.(`Bridge shutdown failed: ${error.message || error}`);
        } else {
          processRef.exitCode = 0;
          logger.log?.("Bridge shutdown complete");
        }
        resolveClosed({ error });
        resolve({ error });
      };
      const timer = setTimeout(() => {
        server.closeAllConnections?.();
        finish(new Error(`Bridge shutdown timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      try {
        server.close((error) => finish(error || null));
        server.closeIdleConnections?.();
      } catch (error) {
        if (error?.code === "ERR_SERVER_NOT_RUNNING") {
          finish();
        } else {
          finish(error);
        }
      }
    });
    return shutdownPromise;
  }

  function install() {
    if (installed) {
      return;
    }
    installed = true;
    for (const signal of signals) {
      const handler = () => void shutdown(signal);
      handlers.set(signal, handler);
      processRef.on(signal, handler);
    }
  }

  function dispose() {
    for (const [signal, handler] of handlers) {
      processRef.off(signal, handler);
    }
    handlers.clear();
    installed = false;
  }

  return { closed, dispose, install, shutdown };
}
