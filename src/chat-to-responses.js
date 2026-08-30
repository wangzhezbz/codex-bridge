import { randomUUID } from "node:crypto";
import { tryParseJson } from "./json.js";
import {
  createSseBlockAccumulator,
  finishSseBlockAccumulator,
  takeCompleteSseBlocks,
} from "./responses-sse-blocks.js";
import { buildResponsesStreamErrorSse, parseSseEvents } from "./sse.js";
import {
  chatToolCallFromResponseItem,
  isResponseToolCallItem,
  responseToolCallFromChat,
} from "./tools.js";
import {
  attachNativeResponsesHistoryItems,
  isUnsafeIncompleteNativeToolCall,
  responseOutputItemsForNativeHistory,
  routeUsesStatelessDeepSeekResponses,
} from "./responses-native-history.js";

const APPLY_PATCH = "apply_patch";
const CHAT_TOOL_CALL_INDEX = Symbol("chatToolCallIndex");
const CHAT_ANTHROPIC_THINKING_INDEX = Symbol("chatAnthropicThinkingIndex");
const INTERNAL_BRIDGE_DIAGNOSTIC_PREFIXES = [
  "Earlier assistant tool use was summarized for provider compatibility",
  "Do not quote this summary as a new tool call",
  "Assistant requested tool calls",
  "CodexBridge tool result context",
  "Previous completed tool results",
  "Previous tool result ",
];

export function chatResponseToResponse(chat, requestedModel, toolContext, options = {}) {
  const choice = chat?.choices?.[0] || {};
  const message = choice.message || {};
  const id = responseIdFromChat(chat?.id);
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.filter(isUsableChatToolCall)
    : [];
  const hasRunnableToolCall = toolCalls.some(
    (toolCall) => !isSuppressedToolCall(toolCall, toolContext),
  );
  const output = [];
  let text = visibleMessageText(message, options);
  const reasoningItem = options.includeReasoningSummary
    ? reasoningSummaryItem(message.reasoning_content, id)
    : null;
  if (reasoningItem) {
    output.push(reasoningItem);
  }
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
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.filter(isUsableChatToolCall)
    : [];
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

function isUsableChatToolCall(toolCall) {
  const name = toolCall?.function?.name || toolCall?.name || "";
  return Boolean(String(name).trim());
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

function internalBridgeDiagnosticStreamDisposition(text) {
  if (isInternalBridgeDiagnosticText(text)) {
    return "suppress";
  }
  const normalized = String(text || "").trimStart().toLowerCase();
  if (!normalized) {
    return "pending";
  }
  if (
    INTERNAL_BRIDGE_DIAGNOSTIC_PREFIXES.some((prefix) =>
      prefix.toLowerCase().startsWith(normalized)
    )
  ) {
    return "pending";
  }
  if (normalized.startsWith("previous tool result ")) {
    return "pending";
  }
  return "safe";
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
    const usableToolCalls = message.tool_calls.filter(isUsableChatToolCall);
    const toolCalls = toolContext
      ? usableToolCalls.filter((toolCall) => !isSuppressedToolCall(toolCall, toolContext))
      : usableToolCalls;
    if (toolCalls.length > 0) {
      history.tool_calls = toolCalls;
    }
  }
  if (typeof message.reasoning_content === "string" && message.reasoning_content) {
    history.reasoning_content = message.reasoning_content;
  }
  if (Array.isArray(message.anthropic_thinking) && message.anthropic_thinking.length > 0) {
    history.anthropic_thinking = structuredClone(message.anthropic_thinking);
  }
  return history;
}

export function assistantHistoryMessageFromResponse(response, toolContext, route = {}) {
  let history = {
    role: "assistant",
    content: responseHistoryText(response) || null,
  };
  const assistantOutputItems = (Array.isArray(response?.output) ? response.output : [])
    .filter((item) => item?.type === "message" && item?.role === "assistant");
  const outputPhases = assistantOutputItems
    .map((item) => responseAssistantPhase(item))
    .filter(Boolean);
  if (
    outputPhases.length > 0 &&
    outputPhases.length === assistantOutputItems.length &&
    new Set(outputPhases).size === 1
  ) {
    history.responses_phase = outputPhases[0];
  }
  const reasoningContent = responseReasoningText(response);
  if (reasoningContent) {
    history.reasoning_content = reasoningContent;
  }
  const toolCalls = [];
  for (const item of response?.output || []) {
    if (isResponseToolCallItem(item)) {
      if (
        routeUsesStatelessDeepSeekResponses(route) &&
        isUnsafeIncompleteNativeToolCall(response, item)
      ) {
        continue;
      }
      toolCalls.push(chatToolCallFromResponseItem(item, toolContext));
    }
  }
  if (toolCalls.length > 0) {
    history.tool_calls = toolCalls;
  }
  if (routeUsesStatelessDeepSeekResponses(route)) {
    history = attachNativeResponsesHistoryItems(
      history,
      responseOutputItemsForNativeHistory(response),
    );
  }
  return history;
}

function responseAssistantPhase(item) {
  const phase = typeof item?.phase === "string" ? item.phase.trim() : "";
  return ["commentary", "final_answer"].includes(phase) ? phase : "";
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

export function createChatCompletionResponsesStream(
  requestedModel,
  toolContext = null,
  options = {},
) {
  const accumulator = createSseBlockAccumulator();
  const chat = {
    id: "",
    object: "chat.completion",
    created: 0,
    model: "",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "" },
      finish_reason: null,
    }],
    usage: null,
  };
  let sawDone = false;
  let sawFinishReason = false;
  let failed = false;
  let responseStarted = false;
  let streamedText = "";
  let streamedReasoning = "";
  let responseId = "";
  let messageId = "";
  let reasoningId = "";
  let responseCreatedAt = 0;
  let messageStarted = false;
  let reasoningStarted = false;
  let reasoningDone = false;
  let messageOutputIndex = 0;
  let pendingText = "";
  let textIsSafeToStream = false;
  let textIsSuppressed = false;

  return {
    chat,
    get completed() {
      return failed || sawDone || sawFinishReason;
    },
    get sawDone() {
      return sawDone;
    },
    get failed() {
      return failed;
    },
    get responseStarted() {
      return responseStarted;
    },
    push(chunk) {
      const events = [];
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || "");
      for (const block of takeCompleteSseBlocks(accumulator, bytes)) {
        events.push(...consumeBlock(block));
      }
      return events;
    },
    end() {
      const tail = finishSseBlockAccumulator(accumulator);
      return tail ? consumeBlock(tail) : [];
    },
    alignResponse(response) {
      if (!responseStarted) {
        return response;
      }
      return alignStartedChatResponseStream(response, {
        responseId,
        responseCreatedAt,
        messageId,
        streamedText,
        reasoningId,
        streamedReasoning,
        messageStarted,
      });
    },
    finish(response) {
      if (!responseStarted) {
        return responseToSse(response);
      }
      const alignedResponse = alignStartedChatResponseStream(response, {
        responseId,
        responseCreatedAt,
        messageId,
        streamedText,
        reasoningId,
        streamedReasoning,
        messageStarted,
      });
      return finishStartedChatResponseStream(alignedResponse, {
        messageId,
        streamedText,
        messageStarted,
        reasoningId,
        streamedReasoning,
        reasoningStarted,
        reasoningDone,
      });
    },
  };

  function consumeBlock(block) {
    const output = [];
    for (const event of parseSseEvents(block)) {
      if (failed) {
        break;
      }
      const data = event.data.trim();
      if (!data) {
        const keepAlive = chatSseKeepAliveComment(event);
        if (keepAlive) {
          output.push(keepAlive);
        }
        continue;
      }
      if (data === "[DONE]") {
        sawDone = true;
        continue;
      }
      const payload = tryParseJson(data);
      if (!payload || typeof payload !== "object") {
        continue;
      }
      if (sawFinishReason) {
        if (payload.usage && typeof payload.usage === "object") {
          chat.usage = payload.usage;
        }
        continue;
      }
      if (event.event === "error" || payload.error) {
        const error = chatSseError(payload);
        failed = true;
        output.push(buildResponsesStreamErrorSse(error.message, {
          id: responseId || responseIdFromChat(chat.id || payload.id),
          code: error.code,
          model: requestedModel,
        }));
        continue;
      }
      mergeChatCompletionChunk(chat, payload);
      const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
      if (choice?.finish_reason) {
        sawFinishReason = true;
      }
      const delta = choice?.delta ?? choice?.message;
      const reasoningText = chatDeltaReasoningText(delta);
      if (reasoningText && options.emitReasoningDeltas === true) {
        output.push(...ensureResponseStarted(payload));
        if (!reasoningStarted) {
          reasoningId = `rs_${stableFragment(responseId)}`;
          output.push(...startChatReasoningStream({ reasoningId, outputIndex: 0 }));
          reasoningStarted = true;
          messageOutputIndex = 1;
        }
        streamedReasoning += reasoningText;
        output.push(sse("response.reasoning_summary_text.delta", {
          type: "response.reasoning_summary_text.delta",
          item_id: reasoningId,
          output_index: 0,
          summary_index: 0,
          delta: reasoningText,
        }));
      }
      const text = chatDeltaText(delta);
      const streamableText = takeStreamableText(text);
      if (!streamableText) {
        continue;
      }
      output.push(...ensureResponseStarted(payload));
      if (reasoningStarted && !reasoningDone) {
        output.push(...finishChatReasoningStream({
          reasoningId,
          outputIndex: 0,
          text: streamedReasoning,
        }));
        reasoningDone = true;
      }
      if (!messageStarted) {
        output.push(...startChatMessageStream({
          messageId,
          outputIndex: messageOutputIndex,
        }));
        messageStarted = true;
      }
      streamedText += streamableText;
      output.push(sse("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: messageId,
        output_index: messageOutputIndex,
        content_index: 0,
        delta: streamableText,
      }));
    }
    return output;
  }

  function ensureResponseStarted(payload) {
    if (responseStarted) {
      return [];
    }
    responseId = responseIdFromChat(chat.id || payload?.id);
    messageId = `msg_${stableFragment(responseId)}`;
    responseCreatedAt = Math.floor(Date.now() / 1000);
    responseStarted = true;
    return startChatResponseStream({
      responseId,
      model: requestedModel,
      createdAt: responseCreatedAt,
    });
  }

  function takeStreamableText(text) {
    if (!text || options.emitTextDeltas === false || textIsSuppressed) {
      return "";
    }
    if (textIsSafeToStream) {
      return text;
    }
    pendingText += text;
    const disposition = internalBridgeDiagnosticStreamDisposition(pendingText);
    if (disposition === "suppress") {
      pendingText = "";
      textIsSuppressed = true;
      return "";
    }
    if (disposition === "pending") {
      return "";
    }
    const safeText = pendingText;
    pendingText = "";
    textIsSafeToStream = true;
    return safeText;
  }
}

function chatSseKeepAliveComment(event = {}) {
  const lines = String(event.raw || "")
    .split("\n")
    .filter(Boolean);
  if (lines.length === 0 || lines.some((line) => !line.startsWith(":"))) {
    return "";
  }
  return `${lines.join("\n")}\n\n`;
}

function mergeChatCompletionChunk(chat, chunk) {
  if (chunk.id) {
    chat.id = chunk.id;
  }
  if (chunk.object) {
    chat.object = chunk.object === "chat.completion.chunk"
      ? "chat.completion"
      : chunk.object;
  }
  if (Number.isFinite(Number(chunk.created))) {
    chat.created = Number(chunk.created);
  }
  if (chunk.model) {
    chat.model = chunk.model;
  }
  if (chunk.usage && typeof chunk.usage === "object") {
    chat.usage = chunk.usage;
  }

  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
  if (!choice || typeof choice !== "object") {
    return;
  }
  const target = chat.choices[0];
  const delta = choice.delta ?? choice.message ?? {};
  if (delta.role) {
    target.message.role = delta.role;
  }
  mergeAnthropicThinkingBlock(target.message, delta.anthropic_thinking_block);
  const content = chatDeltaText(delta);
  if (content) {
    target.message.content += content;
  }
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
    target.message.reasoning_content =
      String(target.message.reasoning_content || "") + delta.reasoning_content;
    const thinkingIndex = normalizeAnthropicThinkingIndex(delta.anthropic_thinking_index);
    const thinking = thinkingIndex === null
      ? lastAnthropicThinkingBlock(target.message)
      : ensureAnthropicThinkingBlock(target.message, thinkingIndex);
    if (thinking?.type === "thinking") {
      thinking.thinking = String(thinking.thinking || "") + delta.reasoning_content;
    }
  }
  if (
    typeof delta.anthropic_thinking_signature === "string" &&
    delta.anthropic_thinking_signature
  ) {
    const thinkingIndex = normalizeAnthropicThinkingIndex(delta.anthropic_thinking_index);
    const thinking = thinkingIndex === null
      ? ensureTrailingAnthropicThinkingBlock(target.message)
      : ensureAnthropicThinkingBlock(target.message, thinkingIndex);
    thinking.signature =
      String(thinking.signature || "") + delta.anthropic_thinking_signature;
  }
  mergeChatToolCallDeltas(target.message, delta.tool_calls);
  if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
    target.finish_reason = choice.finish_reason;
  }
  if (choice.logprobs !== undefined) {
    target.logprobs = choice.logprobs;
  }
}

function mergeAnthropicThinkingBlock(message, source) {
  if (!source || typeof source !== "object") {
    return null;
  }
  const index = normalizeAnthropicThinkingIndex(source.index);
  if (index === null) {
    return null;
  }
  message.anthropic_thinking ||= [];
  const existing = anthropicThinkingBlockByIndex(message, index);
  if (existing) {
    return existing;
  }
  let block = null;
  if (source.type === "thinking") {
    block = { type: "thinking", thinking: "", signature: "" };
  } else if (source.type === "redacted_thinking" && typeof source.data === "string") {
    block = { type: "redacted_thinking", data: source.data };
  }
  if (!block) {
    return null;
  }
  Object.defineProperty(block, CHAT_ANTHROPIC_THINKING_INDEX, {
    value: index,
    enumerable: false,
  });
  message.anthropic_thinking.push(block);
  return block;
}

function ensureAnthropicThinkingBlock(message, index) {
  return anthropicThinkingBlockByIndex(message, index) ||
    mergeAnthropicThinkingBlock(message, { index, type: "thinking" });
}

function ensureTrailingAnthropicThinkingBlock(message) {
  const trailing = lastAnthropicThinkingBlock(message);
  if (trailing?.type === "thinking") {
    return trailing;
  }
  message.anthropic_thinking ||= [];
  const block = {
    type: "thinking",
    thinking: String(message.reasoning_content || ""),
    signature: "",
  };
  message.anthropic_thinking.push(block);
  return block;
}

function lastAnthropicThinkingBlock(message) {
  return Array.isArray(message?.anthropic_thinking)
    ? message.anthropic_thinking.at(-1)
    : null;
}

function anthropicThinkingBlockByIndex(message, index) {
  if (!Array.isArray(message?.anthropic_thinking)) {
    return null;
  }
  return message.anthropic_thinking.find(
    (block) => block?.[CHAT_ANTHROPIC_THINKING_INDEX] === index,
  ) || null;
}

function normalizeAnthropicThinkingIndex(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

function mergeChatToolCallDeltas(message, toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return;
  }
  message.tool_calls ||= [];
  for (let position = 0; position < toolCalls.length; position += 1) {
    const delta = toolCalls[position] || {};
    const index = Number.isInteger(delta.index) ? delta.index : position;
    let target = message.tool_calls.find((toolCall) => toolCall?.[CHAT_TOOL_CALL_INDEX] === index);
    if (!target) {
      target = {
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
        [CHAT_TOOL_CALL_INDEX]: index,
      };
      message.tool_calls.push(target);
      message.tool_calls.sort(
        (left, right) =>
          Number(left?.[CHAT_TOOL_CALL_INDEX] ?? 0) - Number(right?.[CHAT_TOOL_CALL_INDEX] ?? 0),
      );
    }
    if (delta.id) {
      target.id = delta.id;
    }
    if (delta.type) {
      target.type = delta.type;
    }
    const functionDelta = delta.function || {};
    if (functionDelta.name) {
      target.function.name += functionDelta.name;
    }
    if (functionDelta.arguments !== undefined && functionDelta.arguments !== null) {
      target.function.arguments += typeof functionDelta.arguments === "string"
        ? functionDelta.arguments
        : JSON.stringify(functionDelta.arguments);
    }
  }
}

function chatSseError(payload) {
  const error = payload?.error ?? payload;
  if (typeof error === "string") {
    return { message: error, code: "upstream_stream_error" };
  }
  const message = String(error?.message || error?.detail || "Upstream stream failed.");
  const code = String(error?.code || error?.type || "upstream_stream_error");
  return { message, code };
}

function chatDeltaText(delta) {
  if (typeof delta?.content === "string") {
    return delta.content;
  }
  if (!Array.isArray(delta?.content)) {
    return "";
  }
  return delta.content
    .map((part) => typeof part === "string" ? part : part?.text || "")
    .filter(Boolean)
    .join("");
}

function chatDeltaReasoningText(delta) {
  if (typeof delta?.reasoning_content === "string") {
    return delta.reasoning_content;
  }
  if (typeof delta?.reasoning === "string") {
    return delta.reasoning;
  }
  return "";
}

function reasoningSummaryItem(text, responseId, itemId = "") {
  const value = String(text || "");
  if (!value) {
    return null;
  }
  return {
    id: itemId || `rs_${stableFragment(responseId)}`,
    type: "reasoning",
    summary: [{ type: "summary_text", text: value }],
  };
}

function startChatResponseStream({ responseId, model, createdAt }) {
  const inProgress = {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status: "in_progress",
    model,
    output: [],
    output_text: "",
    parallel_tool_calls: true,
    error: null,
    incomplete_details: null,
    usage: null,
  };
  return [
    sse("response.created", { type: "response.created", response: inProgress }),
    sse("response.in_progress", { type: "response.in_progress", response: inProgress }),
  ];
}

function startChatMessageStream({ messageId, outputIndex }) {
  const item = {
    id: messageId,
    type: "message",
    role: "assistant",
    status: "in_progress",
    content: [],
  };
  return [
    sse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item,
    }),
    sse("response.content_part.added", {
      type: "response.content_part.added",
      item_id: messageId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    }),
  ];
}

function startChatReasoningStream({ reasoningId, outputIndex }) {
  return [
    sse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { id: reasoningId, type: "reasoning", summary: [] },
    }),
    sse("response.reasoning_summary_part.added", {
      type: "response.reasoning_summary_part.added",
      item_id: reasoningId,
      output_index: outputIndex,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    }),
  ];
}

function finishChatReasoningStream({ reasoningId, outputIndex, text }) {
  const item = reasoningSummaryItem(text, reasoningId, reasoningId);
  return [
    sse("response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done",
      item_id: reasoningId,
      output_index: outputIndex,
      summary_index: 0,
      text,
    }),
    sse("response.reasoning_summary_part.done", {
      type: "response.reasoning_summary_part.done",
      item_id: reasoningId,
      output_index: outputIndex,
      summary_index: 0,
      part: { type: "summary_text", text },
    }),
    sse("response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    }),
  ];
}

function alignStartedChatResponseStream(
  response,
  {
    responseId,
    responseCreatedAt,
    messageId,
    streamedText,
    reasoningId,
    streamedReasoning,
    messageStarted,
  },
) {
  const originalOutput = Array.isArray(response?.output) ? response.output : [];
  const originalMessage = originalOutput.find((item) => item?.type === "message");
  const finalText = originalMessage?.content
    ?.find((part) => part?.type === "output_text")?.text || "";
  const coherentText = finalText.startsWith(streamedText)
    ? finalText
    : streamedText + finalText;
  const originalContent = Array.isArray(originalMessage?.content)
    ? originalMessage.content
    : [];
  const contentWithoutOutputText = originalContent.filter((part) => part?.type !== "output_text");
  const message = originalMessage || messageStarted
    ? {
        ...(originalMessage || {}),
        id: messageId,
        type: "message",
        role: originalMessage?.role || "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: coherentText, annotations: [] },
          ...contentWithoutOutputText,
        ],
      }
    : null;
  const originalReasoning = originalOutput.find((item) => item?.type === "reasoning");
  const finalReasoningText = originalReasoning?.summary?.[0]?.text || "";
  const coherentReasoning = finalReasoningText.startsWith(streamedReasoning)
    ? finalReasoningText
    : streamedReasoning + finalReasoningText;
  const reasoning = coherentReasoning
    ? reasoningSummaryItem(coherentReasoning, responseId, reasoningId)
    : null;
  let output = originalOutput.map((item) => {
    if (item === originalMessage && message) {
      return message;
    }
    if (item === originalReasoning && reasoning) {
      return reasoning;
    }
    return item;
  });
  if (reasoning && !originalReasoning) {
    output = [reasoning, ...output];
  }
  if (message && !originalMessage) {
    output.push(message);
  }
  return {
    ...response,
    id: responseId,
    created_at: responseCreatedAt,
    output,
    output_text: coherentText,
  };
}

function finishStartedChatResponseStream(
  response,
  {
    messageId,
    streamedText,
    messageStarted,
    reasoningId,
    streamedReasoning,
    reasoningStarted,
    reasoningDone,
  },
) {
  const events = [];
  const output = Array.isArray(response?.output) ? response.output : [];
  const reasoning = output.find((item) => item?.type === "reasoning");
  const reasoningIndex = reasoning ? output.indexOf(reasoning) : 0;
  if (reasoningStarted && !reasoningDone) {
    events.push(...finishChatReasoningStream({
      reasoningId,
      outputIndex: reasoningIndex,
      text: streamedReasoning,
    }));
  }
  const message = output.find((item) => item?.type === "message");
  const messageIndex = message ? output.indexOf(message) : 0;
  const finalText = message?.content?.find((part) => part?.type === "output_text")?.text || "";
  if (
    messageStarted &&
    finalText.startsWith(streamedText) &&
    finalText.length > streamedText.length
  ) {
    events.push(sse("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: messageId,
      output_index: messageIndex,
      content_index: 0,
      delta: finalText.slice(streamedText.length),
    }));
  }
  const completedMessage = message || {
    id: messageId,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: finalText, annotations: [] }],
  };
  if (messageStarted) {
    events.push(
      sse("response.output_text.done", {
        type: "response.output_text.done",
        item_id: messageId,
        output_index: messageIndex,
        content_index: 0,
        text: finalText,
      }),
      sse("response.content_part.done", {
        type: "response.content_part.done",
        item_id: messageId,
        output_index: messageIndex,
        content_index: 0,
        part: { type: "output_text", text: finalText, annotations: [] },
      }),
      sse("response.output_item.done", {
        type: "response.output_item.done",
        output_index: messageIndex,
        item: completedMessage,
      }),
    );
  }
  output.forEach((item, outputIndex) => {
    if ((messageStarted && item === message) || (reasoningStarted && item === reasoning)) {
      return;
    }
    events.push(
      sse("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item,
      }),
      ...toolCallArgumentSseEvents(item, outputIndex),
      sse("response.output_item.done", {
        type: "response.output_item.done",
        output_index: outputIndex,
        item,
      }),
    );
  });
  events.push(
    sse("response.completed", { type: "response.completed", response }),
    "data: [DONE]\n\n",
  );
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

function responseReasoningText(response) {
  const parts = [];
  for (const item of response?.output || []) {
    if (item?.type !== "reasoning") {
      continue;
    }
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      const text = part?.type === "reasoning_text"
        ? part.text
        : part?.reasoning_text;
      if (typeof text === "string" && text) {
        parts.push(text);
      }
    }
    if (content.length === 0 && Array.isArray(item.summary)) {
      for (const summary of item.summary) {
        if (typeof summary?.text === "string" && summary.text) {
          parts.push(summary.text);
        }
      }
    }
  }
  return parts.join("");
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
