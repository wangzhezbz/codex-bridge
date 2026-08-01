import { authModeForRoute } from "./config.js";

export function responseUsesEventStream(response) {
  return /text\/event-stream/i.test(String(response?.headers?.get?.("content-type") || ""));
}

export function shouldAggregateForcedResponsesStream(
  requestBody = {},
  upstreamPayload = {},
  route = {},
) {
  return (
    route.api === "responses" &&
    authModeForRoute(route) === "codex_openai" &&
    requestBody.stream !== true &&
    upstreamPayload.stream === true
  );
}

export function looksLikeSseResponse(text = "") {
  const trimmed = String(text || "").trimStart();
  return trimmed.startsWith("data:") ||
    trimmed.startsWith("event:") ||
    /\n(?:data|event):/.test(trimmed);
}
