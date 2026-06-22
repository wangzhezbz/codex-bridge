import { randomUUID } from "node:crypto";
import {
  chatToolCallFromResponseItem,
  isResponseToolCallItem,
  responseToolCallFromChat,
} from "./tools.js";

export function chatResponseToResponse(chat, requestedModel, toolContext, options = {}) {
  const choice = chat?.choices?.[0] || {};
  const message = choice.message || {};
  const id = responseIdFromChat(chat?.id);
  const output = [];
  const text = visibleMessageText(message, options);

  if (text) {
    output.push({
      id: `msg_${stableFragment(id)}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text,
          annotations: [],
        },
      ],
    });
  }

  for (const toolCall of message.tool_calls || []) {
    output.push(responseToolCallFromChat(toolCall, toolContext));
  }

  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestedModel,
    output,
    output_text: text,
    parallel_tool_calls: true,
    error: null,
    incomplete_details: null,
    usage: responseUsage(chat?.usage),
  };
}

export function assistantHistoryMessageFromChat(chat) {
  const message = chat?.choices?.[0]?.message || {};
  const history = {
    role: "assistant",
    content: messageText(message) || null,
  };
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    history.tool_calls = message.tool_calls;
  }
  return history;
}

export function assistantHistoryMessageFromResponse(response, toolContext) {
  const history = {
    role: "assistant",
    content: responseHistoryText(response) || null,
  };
  const toolCalls = [];
  for (const item of response?.output || []) {
    if (isResponseToolCallItem(item)) {
      toolCalls.push(chatToolCallFromResponseItem(item, toolContext));
    }
  }
  if (toolCalls.length > 0) {
    history.tool_calls = toolCalls;
  }
  return history;
}

export function responseToSse(response) {
  const events = [];
  const inProgress = {
    ...response,
    status: "in_progress",
    output: [],
  };

  events.push(sse("response.created", { type: "response.created", response: inProgress }));
  events.push(
    sse("response.in_progress", {
      type: "response.in_progress",
      response: inProgress,
    }),
  );

  response.output.forEach((item, outputIndex) => {
    if (item.type === "message") {
      const text = item.content?.[0]?.text || "";
      const addedItem = { ...item, status: "in_progress", content: [] };
      const part = { type: "output_text", text: "", annotations: [] };
      const donePart = { type: "output_text", text, annotations: [] };

      events.push(
        sse("response.output_item.added", {
          type: "response.output_item.added",
          output_index: outputIndex,
          item: addedItem,
        }),
      );
      events.push(
        sse("response.content_part.added", {
          type: "response.content_part.added",
          item_id: item.id,
          output_index: outputIndex,
          content_index: 0,
          part,
        }),
      );
      if (text) {
        events.push(
          sse("response.output_text.delta", {
            type: "response.output_text.delta",
            item_id: item.id,
            output_index: outputIndex,
            content_index: 0,
            delta: text,
          }),
        );
      }
      events.push(
        sse("response.output_text.done", {
          type: "response.output_text.done",
          item_id: item.id,
          output_index: outputIndex,
          content_index: 0,
          text,
        }),
      );
      events.push(
        sse("response.content_part.done", {
          type: "response.content_part.done",
          item_id: item.id,
          output_index: outputIndex,
          content_index: 0,
          part: donePart,
        }),
      );
      events.push(
        sse("response.output_item.done", {
          type: "response.output_item.done",
          output_index: outputIndex,
          item,
        }),
      );
      return;
    }

    events.push(
      sse("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item,
      }),
    );
    events.push(
      sse("response.output_item.done", {
        type: "response.output_item.done",
        output_index: outputIndex,
        item,
      }),
    );
  });

  events.push(
    sse("response.completed", {
      type: "response.completed",
      response,
    }),
  );
  events.push("data: [DONE]\n\n");
  return events.join("");
}

function responseUsage(usage = {}) {
  const inputTokens = usage.prompt_tokens || 0;
  const outputTokens = usage.completion_tokens || 0;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: usage.total_tokens || inputTokens + outputTokens,
    input_tokens_details: {
      cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0,
    },
    output_tokens_details: {
      reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0,
    },
  };
}

function responseHistoryText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }
  const parts = [];
  for (const item of response?.output || []) {
    if (item?.type !== "message" || item.role !== "assistant") {
      continue;
    }
    for (const part of item.content || []) {
      const text = part?.text || part?.output_text;
      if (typeof text === "string" && text) {
        parts.push(text);
      }
    }
  }
  return parts.join("\n");
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        return part?.text || "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function visibleMessageText(message, options = {}) {
  const text = messageText(message);
  if (!options.stripReasoningTags) {
    return text;
  }
  return stripReasoningTags(text);
}

function stripReasoningTags(text) {
  return String(text || "")
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
    .trimStart();
}

function responseIdFromChat(chatId) {
  if (!chatId) {
    return `resp_${randomUUID()}`;
  }
  return chatId.startsWith("resp_") ? chatId : `resp_${chatId}`;
}

function stableFragment(value) {
  return String(value).replace(/[^A-Za-z0-9]/g, "").slice(-16) || "message";
}

function sse(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}
