import { fileURLToPath } from "node:url";

import { createHttpServer } from "./http-server.js";
import { createGracefulShutdown } from "./service-lifecycle.js";

export function startHttpService(options = {}) {
  const env = options.env || process.env;
  const processRef = options.processRef || process;
  const logger = options.logger || console;
  const host = options.host || env.BRIDGE_HOST || "127.0.0.1";
  const port = Number.parseInt(String(options.port ?? env.BRIDGE_PORT ?? "4317"), 10);
  const server = options.server || createHttpServer({ ...options, env });
  const lifecycle = createGracefulShutdown({
    server,
    processRef,
    logger,
    timeoutMs: options.shutdownTimeoutMs
  });
  lifecycle.install();

  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    logger.log(`GPT Codex Bridge listening at http://${host}:${actualPort}`);
    logger.log(`Runner mode: ${env.BRIDGE_RUNNER || "manual"}`);
  });

  server.once("error", (error) => {
    processRef.exitCode = 1;
    logger.error(error);
  });
  return { lifecycle, server };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startHttpService();
}
