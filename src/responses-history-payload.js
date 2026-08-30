import { stringifyJson } from "./json.js";
import { contentToText } from "./responses-to-chat.js";
import {
  hasNativeResponsesHistoryItems,
  nativeResponsesHistoryItems,
} from "./responses-native-history.js";

export function inlineLocalHistoryForResponsesPayload(payload, sourceMessages, options = {}) {
  const preferNativeHistory = options.preferNativeResponsesHistoryItems === true;
  const systemInstructionParts = sourceMessages
    .filter((message) =>
      message?.role === "system" &&
      !(preferNativeHistory && hasNativeResponsesHistoryItems(message)))
    .map((message) => contentToText(message.content))
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index);
  const existingInstructions =
    typeof payload.instructions === "string" ? payload.instructions : "";
  const missingInstructions = systemInstructionParts.filter((part) =>
    !existingInstructions.includes(part)
  );
  if (missingInstructions.length > 0) {
    payload.instructions = [
      ...missingInstructions,
      existingInstructions,
    ].filter(Boolean).join("\n\n");
  }
  payload.input = chatMessagesToResponsesInput(
    sourceMessages.filter((message) =>
      message?.role !== "system" ||
      (preferNativeHistory && hasNativeResponsesHistoryItems(message))),
    options,
  );
  delete payload.messages;
  delete payload.previous_response_id;
}

export function chatMessagesToResponsesInput(messages, options = {}) {
  return messages
    .flatMap((message) => chatMessageToResponsesInputItems(message, options))
    .filter(Boolean);
}

function chatMessageToResponsesInputItems(message, options = {}) {
  if (!message || typeof message !== "object") {
    return [];
  }
  if (
    options.preferNativeResponsesHistoryItems === true &&
    hasNativeResponsesHistoryItems(message)
  ) {
    return nativeResponsesHistoryItems(message);
  }
  if (message.role === "tool" && message.tool_call_id) {
    return [{
      type: "function_call_output",
      call_id: message.tool_call_id,
      output: contentToText(message.content),
    }];
  }
  if (message.role === "assistant") {
    const items = [];
    if (options.includePlainReasoningContent === true
      && typeof message.reasoning_content === "string"
      && message.reasoning_content) {
      items.push({
        type: "reasoning",
        content: [{ type: "reasoning_text", text: message.reasoning_content }],
      });
    }
    const assistantContent = chatContentToResponsesContent(message.content, "assistant");
    if (assistantContent) {
      const assistant = { role: "assistant", content: assistantContent };
      const phase = responsesAssistantPhase(message);
      if (phase) {
        assistant.phase = phase;
      }
      items.push(assistant);
    }
    for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      const callId = toolCall?.id || toolCall?.call_id || "";
      const name = toolCall?.function?.name || toolCall?.name || "";
      if (!callId || !name) {
        continue;
      }
      const args = toolCall?.function?.arguments ?? toolCall?.arguments ?? "";
      items.push({
        type: "function_call",
        call_id: callId,
        name,
        arguments: typeof args === "string" ? args : JSON.stringify(args || {}),
      });
    }
    return items;
  }
  const role = responsesInputRole(message.role);
  const content = chatContentToResponsesContent(message.content, role);
  if (!content) {
    return [];
  }
  return [{ role, content }];
}

function responsesAssistantPhase(message) {
  const phase = typeof message?.responses_phase === "string"
    ? message.responses_phase.trim()
    : "";
  return ["commentary", "final_answer"].includes(phase) ? phase : "";
}

function responsesInputRole(role) {
  if (role === "assistant") {
    return "assistant";
  }
  return "user";
}

function chatContentToResponsesContent(content, role, fallbackText = "") {
  if (Array.isArray(content)) {
    const parts = [];
    const textParts = [];
    for (const part of content) {
      const converted = chatPartToResponsesPart(part, role);
      if (!converted) {
        continue;
      }
      if (typeof converted === "string") {
        textParts.push(converted);
      } else {
        parts.push(converted);
      }
    }
    if (fallbackText) {
      textParts.push(fallbackText);
    }
    const text = textParts.filter(Boolean).join("\n");
    if (parts.length === 0) {
      return text;
    }
    if (text) {
      parts.unshift(textPartForRole(role, text));
    }
    return parts;
  }

  return [contentToText(content), fallbackText].filter(Boolean).join("\n");
}

function chatPartToResponsesPart(part, role) {
  if (typeof part === "string") {
    return part;
  }
  if (!part || typeof part !== "object") {
    return null;
  }
  if (part.type === "text") {
    return part.text || "";
  }
  if (part.type === "image_url") {
    const rawImageUrl = part.image_url;
    const imageUrl =
      typeof rawImageUrl === "string"
        ? rawImageUrl
        : rawImageUrl?.url || part.url || "";
    if (!imageUrl) {
      return "[image input missing url]";
    }
    const responsePart = {
      type: "input_image",
      image_url: imageUrl,
    };
    const detail = part.detail || rawImageUrl?.detail;
    if (detail) {
      responsePart.detail = detail;
    }
    return responsePart;
  }
  return stringifyJson(part);
}

function textPartForRole(role, text) {
  return {
    type: role === "assistant" ? "output_text" : "input_text",
    text,
  };
}
