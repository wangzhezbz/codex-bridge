import { stringifyJson } from "./json.js";
import { contentToText } from "./responses-to-chat.js";

export function inlineLocalHistoryForResponsesPayload(payload, sourceMessages) {
  const systemInstructions = sourceMessages
    .filter((message) => message?.role === "system")
    .map((message) => contentToText(message.content))
    .filter(Boolean)
    .join("\n\n");
  const existingInstructions =
    typeof payload.instructions === "string" ? payload.instructions : "";
  if (systemInstructions && !existingInstructions) {
    payload.instructions = systemInstructions;
  } else if (
    systemInstructions &&
    !existingInstructions.includes(systemInstructions)
  ) {
    payload.instructions = `${systemInstructions}\n\n${payload.instructions}`;
  }
  payload.input = chatMessagesToResponsesInput(
    sourceMessages.filter((message) => message?.role !== "system"),
  );
  delete payload.messages;
  delete payload.previous_response_id;
}

export function chatMessagesToResponsesInput(messages) {
  return messages.flatMap(chatMessageToResponsesInputItems).filter(Boolean);
}

function chatMessageToResponsesInputItems(message) {
  if (!message || typeof message !== "object") {
    return [];
  }
  if (message.role === "tool" && message.tool_call_id) {
    return [{
      type: "function_call_output",
      call_id: message.tool_call_id,
      output: contentToText(message.content),
    }];
  }
  if (
    message.role === "assistant" &&
    Array.isArray(message.tool_calls) &&
    message.tool_calls.length > 0
  ) {
    const items = [];
    const assistantContent = chatContentToResponsesContent(message.content, "assistant");
    if (assistantContent) {
      items.push({ role: "assistant", content: assistantContent });
    }
    for (const toolCall of message.tool_calls) {
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
