import { normalizeAdapterProfile } from "./adapter-profile.js";
import { cloneJson } from "./json.js";

export const NATIVE_RESPONSES_HISTORY_ITEMS_FIELD =
  "__codexbridge_native_responses_input_items";

export function routeUsesStatelessDeepSeekResponses(route = {}) {
  const profile = normalizeAdapterProfile(route);
  return (
    profile.api === "responses" &&
    profile.providerFamily === "deepseek" &&
    profile.supportsResponsePreviousId === false
  );
}

export function attachNativeResponsesHistoryItems(message, items) {
  if (!message || typeof message !== "object") {
    return message;
  }
  const normalized = normalizeNativeResponsesInputItems(items);
  if (normalized.length === 0) {
    return message;
  }
  return {
    ...message,
    [NATIVE_RESPONSES_HISTORY_ITEMS_FIELD]: normalized,
  };
}

export function nativeResponsesHistoryItems(message) {
  const items = message?.[NATIVE_RESPONSES_HISTORY_ITEMS_FIELD];
  return Array.isArray(items)
    ? normalizeNativeResponsesInputItems(items)
    : [];
}

export function hasNativeResponsesHistoryItems(message) {
  return Array.isArray(message?.[NATIVE_RESPONSES_HISTORY_ITEMS_FIELD]) &&
    message[NATIVE_RESPONSES_HISTORY_ITEMS_FIELD].length > 0;
}

export function withoutNativeResponsesHistoryItems(message) {
  if (!message || typeof message !== "object") {
    return message;
  }
  const { [NATIVE_RESPONSES_HISTORY_ITEMS_FIELD]: _items, ...rest } = message;
  return rest;
}

export function responseOutputItemsForNativeHistory(response = {}) {
  const items = normalizeNativeResponsesInputItems(response?.output);
  if (String(response?.status || "").toLowerCase() !== "incomplete") {
    return items;
  }
  return items.filter((item) => !isUnsafeIncompleteNativeToolCall(response, item));
}

export function isUnsafeIncompleteNativeToolCall(response = {}, item = {}) {
  return (
    String(response?.status || "").toLowerCase() === "incomplete" &&
    typeof item?.type === "string" &&
    item.type.endsWith("_call") &&
    String(item.status || "").toLowerCase() !== "completed"
  );
}

export function normalizeNativeResponsesInputItems(items) {
  const source = Array.isArray(items) ? items : [items];
  const normalized = [];
  for (const item of source) {
    if (typeof item === "string") {
      if (item) {
        normalized.push({ role: "user", content: item });
      }
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    normalized.push(cloneJson(item));
  }
  return normalized;
}
