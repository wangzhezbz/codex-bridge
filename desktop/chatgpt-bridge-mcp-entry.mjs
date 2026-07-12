import path from "node:path";
import { fileURLToPath } from "node:url";

export function bridgeMcpEnvironment(env = process.env) {
  const explicitThreadId = String(env.BRIDGE_CURRENT_CODEX_THREAD_ID || "").trim();
  const codexThreadId = String(env.CODEX_THREAD_ID || "").trim();
  return {
    ...env,
    BRIDGE_CURRENT_CODEX_THREAD_ID: explicitThreadId || codexThreadId,
  };
}

export async function startBridgeMcp() {
  Object.assign(process.env, bridgeMcpEnvironment(process.env));
  const { startMcpServer } = await import("../vendor/chatgpt-codex-bridge/src/mcp-server.js");
  return startMcpServer();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startBridgeMcp().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
