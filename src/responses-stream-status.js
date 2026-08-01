import { isResponsesObject } from "./responses-object.js";
import { parseSseEvents } from "./sse.js";
import { tryParseJson } from "./json.js";

const RESPONSES_TERMINAL_TYPES = new Set([
  "response.completed",
  "response.failed",
  "response.incomplete",
  "response.cancelled",
]);

const NON_SUCCESS_STATUS_BY_TERMINAL = {
  "response.failed": "failed",
  "response.incomplete": "incomplete",
  "response.cancelled": "cancelled",
};

export function responsesTerminalKind(text = "") {
  for (const event of parseSseEvents(text)) {
    const data = event.data.trim();
    if (data === "[DONE]") {
      return "done";
    }
    const type = event.event || tryParseJson(data)?.type || "";
    if (RESPONSES_TERMINAL_TYPES.has(type)) {
      return type;
    }
  }
  return "";
}

export function isPassThroughNonSuccessTerminal(kind, response) {
  const expectedStatus = NON_SUCCESS_STATUS_BY_TERMINAL[kind];
  return Boolean(
    expectedStatus &&
      isResponsesObject(response) &&
      String(response.status || "").toLowerCase() === expectedStatus,
  );
}
