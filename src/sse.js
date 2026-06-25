import { tryParseJson } from "./json.js";

const RESPONSES_TERMINAL_TYPES = new Set([
  "response.completed",
  "response.failed",
  "response.incomplete",
  "response.cancelled",
]);

const RESPONSES_TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "incomplete",
  "cancelled",
]);

export function parseSseEvents(text = "") {
  const normalized = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const events = [];
  for (const rawEvent of normalized.split(/\n\n+/)) {
    if (!rawEvent.trim()) {
      continue;
    }
    const event = {
      event: "",
      data: "",
      id: "",
      retry: undefined,
      raw: rawEvent,
    };
    const dataLines = [];
    for (const line of rawEvent.split("\n")) {
      if (!line || line.startsWith(":")) {
        continue;
      }
      const colonIndex = line.indexOf(":");
      const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
      let value = colonIndex === -1 ? "" : line.slice(colonIndex + 1);
      if (value.startsWith(" ")) {
        value = value.slice(1);
      }
      if (field === "event") {
        event.event = value;
      } else if (field === "data") {
        dataLines.push(value);
      } else if (field === "id") {
        event.id = value;
      } else if (field === "retry") {
        event.retry = Number(value);
      }
    }
    event.data = dataLines.join("\n");
    events.push(event);
  }
  return events;
}

export function extractUsageFromSse(text = "") {
  const direct = usageObjectFromValue(tryParseJson(text));
  if (direct) {
    return direct;
  }

  let latest = null;
  for (const payload of parseSseJsonPayloads(text)) {
    const usage = usageObjectFromValue(payload);
    if (usage) {
      latest = usage;
    }
  }
  return latest;
}

export function extractResponseObjectFromSse(text = "") {
  const direct = normalizeResponsesObject(tryParseJson(text));
  if (direct) {
    return direct;
  }

  let latest = null;
  for (const payload of parseSseJsonPayloads(text)) {
    const response =
      normalizeResponsesObject(payload) ||
      normalizeResponsesObject(payload?.response) ||
      normalizeResponsesObject(payload?.data) ||
      normalizeResponsesObject(payload?.result);
    if (response) {
      latest = response;
    }
  }
  return latest;
}

export function responsesSseStreamComplete(text = "") {
  const events = parseSseEvents(text);
  if (events.length === 0) {
    return false;
  }
  for (const event of events) {
    const data = event.data.trim();
    if (data === "[DONE]") {
      return true;
    }
    if (RESPONSES_TERMINAL_TYPES.has(event.event)) {
      return true;
    }
    const payload = tryParseJson(data);
    if (isResponsesTerminalPayload(payload)) {
      return true;
    }
  }
  return false;
}

export function buildResponsesStreamErrorSse(message, options = {}) {
  const response = {
    id: options.id || `resp_stream_error_${Date.now()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "failed",
    model: options.model || null,
    output: [],
    output_text: "",
    parallel_tool_calls: true,
    error: {
      code: "upstream_stream_truncated",
      message: String(message || "Upstream stream ended before completion."),
    },
    incomplete_details: null,
    usage: null,
  };
  return [
    sse("response.failed", {
      type: "response.failed",
      sequence_number: options.sequenceNumber ?? 0,
      response,
    }),
    "data: [DONE]\n\n",
  ].join("");
}

function parseSseJsonPayloads(text) {
  const payloads = [];
  for (const event of parseSseEvents(text)) {
    const data = event.data.trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    const parsed = tryParseJson(data);
    if (parsed && typeof parsed === "object") {
      payloads.push(parsed);
    }
  }
  return payloads;
}

function isResponsesTerminalPayload(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (RESPONSES_TERMINAL_TYPES.has(value.type)) {
    return true;
  }
  const status = value.response?.status || value.status;
  return RESPONSES_TERMINAL_STATUSES.has(String(status || ""));
}

function usageObjectFromValue(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidates = [
    value.usage,
    value.response?.usage,
    value.data?.usage,
    value.result?.usage,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") {
      return candidate;
    }
  }
  return null;
}

function normalizeResponsesObject(value) {
  if (!value || typeof value !== "object" || typeof value.id !== "string" || !value.id) {
    return null;
  }
  if (value.object === "response") {
    return value;
  }
  if (
    value.status ||
    value.output ||
    typeof value.output_text === "string" ||
    value.usage
  ) {
    return { object: "response", ...value };
  }
  return null;
}

function sse(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}
