import { randomUUID } from "node:crypto";
import {
  chatToolCallFromResponseItem,
  isResponseToolCallItem,
  responseToolCallFromChat,
} from "./tools.js";

const APPLY_PATCH = "apply_patch";

export function chatResponseToResponse(chat, requestedModel, toolContext, options = {}) {
  const choice = chat?.choices?.[0] || {};
  const message = choice.message || {};
  const id = responseIdFromChat(chat?.id);
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const hasRunnableToolCall = toolCalls.some(
    (toolCall) => !isSuppressedToolCall(toolCall, toolContext),
  );
  const output = [];
  let text = visibleMessageText(message, options);
  if (
    isInternalBridgeDiagnosticText(text) ||
    ((hasRunnableToolCall || options.suppressInteractiveDiagnostics) &&
      isInteractiveDiagnosticText(text))
  ) {
    text = "";
  }

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

  for (const toolCall of toolCalls) {
    if (isSuppressedToolCall(toolCall, toolContext)) {
      const suppressedMessage = hasRunnableToolCall
        ? ""
        : suppressedToolCallMessage(toolCall, toolContext, false);
      if (suppressedMessage && !text) {
        text = suppressedMessage;
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
      continue;
    }
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

export function returnedToolDiagnosticsFromChat(chat, toolContext = {}) {
  const message = chat?.choices?.[0]?.message || {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const namespaceNames = new Set();
  const diagnostics = {
    returnedToolCount: toolCalls.length,
    runnableToolCount: 0,
    suppressedToolCount: 0,
    unknownToolCount: 0,
    namespaceCount: 0,
    namespaceNames: [],
    hasNodeRepl: false,
    hasCommandTool: false,
    hasApplyPatch: false,
  };

  for (const toolCall of toolCalls) {
    const chatName = chatToolCallName(toolCall);
    const responseName = responseToolNameForChatCall(chatName, toolContext);
    const namespace = namespaceForReturnedTool(responseName, toolContext);
    if (namespace) {
      namespaceNames.add(namespace);
    }
    if (isSuppressedToolCall(toolCall, toolContext)) {
      diagnostics.suppressedToolCount += 1;
    } else {
      diagnostics.runnableToolCount += 1;
    }
    if (isUnknownChatToolCall(toolCall, toolContext)) {
      diagnostics.unknownToolCount += 1;
    }
    if (responseName === APPLY_PATCH || chatName === APPLY_PATCH) {
      diagnostics.hasApplyPatch = true;
    }
    if (responseName === "mcp__node_repl__js" || responseName.includes("node_repl")) {
      diagnostics.hasNodeRepl = true;
    }
    if (isCommandToolName(responseName) || isCommandToolName(chatName)) {
      diagnostics.hasCommandTool = true;
    }
  }

  diagnostics.namespaceNames = [...namespaceNames].sort();
  diagnostics.namespaceCount = diagnostics.namespaceNames.length;
  return diagnostics;
}

export function returnedToolDiagnosticsLogFields(diagnostics = {}) {
  const namespaceNames = Array.isArray(diagnostics.namespaceNames)
    ? diagnostics.namespaceNames
    : [];
  return [
    `returned_tools=${Number(diagnostics.returnedToolCount || 0)}`,
    `runnable_tools=${Number(diagnostics.runnableToolCount || 0)}`,
    `suppressed_tools=${Number(diagnostics.suppressedToolCount || 0)}`,
    `unknown_tools=${Number(diagnostics.unknownToolCount || 0)}`,
    `namespaces=${Number(diagnostics.namespaceCount || 0)}`,
    `namespace_names=${safeToolDiagnosticsList(namespaceNames)}`,
    `node_repl=${Boolean(diagnostics.hasNodeRepl)}`,
    `command=${Boolean(diagnostics.hasCommandTool)}`,
    `apply_patch=${Boolean(diagnostics.hasApplyPatch)}`,
  ].join(" ");
}

function chatToolCallName(toolCall) {
  return String(toolCall?.function?.name || toolCall?.name || "").trim();
}

function responseToolNameForChatCall(chatName, toolContext = {}) {
  if (!chatName) {
    return "";
  }
  return toolContext?.chatNameToResponseName?.get?.(chatName) || chatName;
}

function namespaceForReturnedTool(responseName, toolContext = {}) {
  if (!responseName) {
    return "";
  }
  const metadata = toolContext?.responseToolMetadata?.get?.(responseName);
  if (metadata?.namespace) {
    return metadata.namespace;
  }
  return namespacePrefixFromToolName(responseName);
}

function namespacePrefixFromToolName(name) {
  const match = String(name || "").match(/^(mcp__[A-Za-z0-9_-]+__)/);
  return match ? match[1] : "";
}

function safeToolDiagnosticsList(values = []) {
  return values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value) => /^[A-Za-z0-9_.:-]+$/.test(value))
    .slice(0, 20)
    .join(",") || "none";
}

function suppressedToolCallMessage(toolCall, toolContext, hasRunnableToolCall = false) {
  if (isInteractivePluginBootstrapRead(toolCall)) {
    return "";
  }

  if (!isUnsupportedNodeReplToolCall(toolCall, toolContext)) {
    return "";
  }
  return "";
}

function isSuppressedToolCall(toolCall, toolContext) {
  return (
    isInteractivePluginBootstrapRead(toolCall) ||
    isUnsupportedNodeReplToolCall(toolCall, toolContext) ||
    isUnknownChatToolCall(toolCall, toolContext)
  );
}

function isUnknownChatToolCall(toolCall, toolContext) {
  const name = toolCall?.function?.name || toolCall?.name || "";
  if (!name) {
    return false;
  }
  return Boolean(toolContext?.chatToolNames) && !toolContext.chatToolNames.has(name);
}

function isUnsupportedNodeReplToolCall(toolCall, toolContext) {
  const name = toolCall?.function?.name || toolCall?.name || "";
  if (name !== "mcp__node_repl__js") {
    return false;
  }
  return !toolContext?.chatToolNames?.has?.(name);
}

function isInteractivePluginBootstrapRead(toolCall) {
  const name = String(toolCall?.function?.name || toolCall?.name || "").toLowerCase();
  if (!isCommandToolName(name)) {
    return false;
  }
  const command = commandTextFromToolCall(toolCall).toLowerCase();
  if (!command) {
    return false;
  }
  const normalized = command.replace(/\//g, "\\");
  return (
    (normalized.includes("\\.codex\\plugins\\cache\\openai-bundled\\") ||
      normalized.includes("\\plugins\\cache\\openai-bundled\\")) &&
    (normalized.includes("\\chrome\\") ||
      normalized.includes("\\browser\\") ||
      normalized.includes("\\computer-use\\")) &&
    (/get-content|get-childitem|skill\.md|browser-client\.mjs|computer-use-client\.mjs/.test(
      normalized,
    ))
  );
}

function isCommandToolName(name) {
  return (
    name === "shell_command" ||
    name === "exec_command" ||
    name === "execute_command" ||
    name.endsWith("__shell_command") ||
    name.endsWith("__exec_command") ||
    name.endsWith("__execute_command")
  );
}

function isInternalBridgeDiagnosticText(text) {
  const value = String(text || "");
  if (!value.trim()) {
    return false;
  }
  return (
    /Earlier assistant tool use was summarized for provider compatibility/i.test(value) ||
    /Do not quote this summary as a new tool call/i.test(value) ||
    /Assistant requested tool calls/i.test(value) ||
    /CodexBridge tool result context/i.test(value) ||
    /Previous completed tool results/i.test(value) ||
    /Previous tool result .* without its matching assistant tool call/i.test(value) ||
    /Previous completed tool results without matching assistant tool calls/i.test(value)
  );
}

function commandTextFromToolCall(toolCall) {
  const args = toolCall?.function?.arguments ?? toolCall?.arguments ?? "";
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === "object") {
        return String(parsed.command || parsed.cmd || parsed.script || parsed.input || "");
      }
    } catch {
      return args;
    }
  }
  if (args && typeof args === "object") {
    return String(args.command || args.cmd || args.script || args.input || "");
  }
  return "";
}

function isInteractiveDiagnosticText(text) {
  const value = String(text || "");
  if (!value.trim()) {
    return false;
  }
  return (
    /node\s*repl/i.test(value) ||
    /unsupported\s+call/i.test(value) ||
    /SKILL\.md/i.test(value) ||
    /bootstrap.*(chrome|browser|computer use)/i.test(value) ||
    /(chrome|browser|computer use).*bootstrap/i.test(value) ||
    /chrome\/computer use/i.test(value) ||
    /插件.*(环境|初始化|不可用|失败)/.test(value) ||
    /工具.*(暂时不可用|不可用|被拒绝)/.test(value)
  );
}

export function assistantHistoryMessageFromChat(chat, toolContext = null) {
  const message = chat?.choices?.[0]?.message || {};
  const history = {
    role: "assistant",
    content: messageText(message) || null,
  };
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    const toolCalls = toolContext
      ? message.tool_calls.filter((toolCall) => !isSuppressedToolCall(toolCall, toolContext))
      : message.tool_calls;
    if (toolCalls.length > 0) {
      history.tool_calls = toolCalls;
    }
  }
  if (typeof message.reasoning_content === "string" && message.reasoning_content) {
    history.reasoning_content = message.reasoning_content;
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
    events.push(...toolCallArgumentSseEvents(item, outputIndex));
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

function toolCallArgumentSseEvents(item, outputIndex) {
  if (!item || typeof item !== "object") {
    return [];
  }
  if (item.type === "function_call") {
    const argumentsText = toolPayloadText(item.arguments);
    return [
      sse("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: item.id,
        output_index: outputIndex,
        delta: argumentsText,
      }),
      sse("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: item.id,
        output_index: outputIndex,
        arguments: argumentsText,
      }),
    ];
  }
  if (item.type === "custom_tool_call") {
    const inputText = toolPayloadText(item.input);
    return [
      sse("response.custom_tool_call_input.delta", {
        type: "response.custom_tool_call_input.delta",
        item_id: item.id,
        output_index: outputIndex,
        delta: inputText,
      }),
      sse("response.custom_tool_call_input.done", {
        type: "response.custom_tool_call_input.done",
        item_id: item.id,
        output_index: outputIndex,
        input: inputText,
      }),
    ];
  }
  return [];
}

function toolPayloadText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function responseUsage(usage = {}) {
  usage ||= {};
  const inputTokens = tokenNumber(usage.prompt_tokens, usage.input_tokens);
  const outputTokens = tokenNumber(usage.completion_tokens, usage.output_tokens);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: tokenNumber(usage.total_tokens, inputTokens + outputTokens),
    input_tokens_details: {
      cached_tokens: cachedInputTokens(usage),
    },
    output_tokens_details: {
      reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0,
    },
  };
}

function cachedInputTokens(usage = {}) {
  return tokenNumber(
    usage.prompt_cache_hit_tokens,
    usage.cache_read_input_tokens,
    usage.cache_read_tokens,
    usage.prompt_tokens_details?.cached_tokens,
    usage.input_tokens_details?.cached_tokens,
  );
}

function tokenNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) {
      return number;
    }
  }
  return 0;
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
