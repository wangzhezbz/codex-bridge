import { authModeForRoute } from "./config.js";

export function responsesCompactRequestOptions(route = {}) {
  const requiresStream = authModeForRoute(route) === "codex_openai";
  return {
    stream: requiresStream,
    omitMaxOutputTokens: requiresStream,
  };
}
