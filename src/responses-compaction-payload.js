import { COMPACT_SUMMARY_PREFIX } from "./compact.js";

export function normalizeBridgePlainCompactionPayload(payload, route = {}, context = {}) {
  if (route.api !== "responses") {
    return;
  }
  const normalizedInput = normalizeBridgeCompactionInput(payload.input, context);
  if (normalizedInput !== payload.input) {
    payload.input = normalizedInput;
  }
  if (payload.messages !== undefined) {
    const normalizedMessages = normalizeBridgeCompactionInput(payload.messages, context);
    if (normalizedMessages !== payload.messages) {
      payload.messages = normalizedMessages;
    }
  }
}

function normalizeBridgeCompactionInput(input, context = {}) {
  if (!Array.isArray(input)) {
    return input;
  }
  let changed = false;
  const normalized = input.map((item) => {
    if (!isBridgePlainCompactionItem(item)) {
      return item;
    }
    changed = true;
    const text = String(item.encrypted_content || "");
    console.warn(
      `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
        "!! compact-plaintext-context normalized bridge compaction for responses upstream",
    );
    return {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text,
        },
      ],
    };
  });
  return changed ? normalized : input;
}

function isBridgePlainCompactionItem(item) {
  return (
    (item?.type === "compaction" || item?.type === "context_compaction") &&
    typeof item.encrypted_content === "string" &&
    item.encrypted_content.startsWith(COMPACT_SUMMARY_PREFIX)
  );
}
