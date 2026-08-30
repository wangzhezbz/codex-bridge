import { isDeepStrictEqual } from "node:util";
import { asArray, stringifyJson } from "./json.js";
import { normalizeAdapterProfile, reasoningParamsForAdapter } from "./adapter-profile.js";
import { contextPolicyForRoute } from "./context-policy.js";
import {
  buildToolContext,
  chatMessageFromToolOutput,
  chatToolCallFromResponseItem,
  isResponseToolCallItem,
  isResponseToolOutputItem,
  namespacedToolName,
  toolDiagnosticsFromContext,
} from "./tools.js";
import {
  attachNativeResponsesHistoryItems,
  hasNativeResponsesHistoryItems,
  routeUsesStatelessDeepSeekResponses,
  withoutNativeResponsesHistoryItems,
} from "./responses-native-history.js";

const MAX_CHAT_DATA_IMAGE_URL_CHARS = 2_000_000;
const OVERSIZED_IMAGE_PLACEHOLDER =
  "[image input omitted because it is too large for this chat provider]";
const MCP_TOOL_GUIDANCE =
  "CodexBridge tool guidance: MCP namespace tools are exposed as flattened function names. " +
  "Only call tools that are present in this request's tools list. " +
  "If an MCP tool call returns unsupported call, do not retry that same tool repeatedly; use another available tool or explain the limitation.";
const INTERACTIVE_CHAT_FALLBACK_GUIDANCE =
  "CodexBridge interactive-tool guidance: Native Chrome and Computer Use plugins require the GPT/OpenAI Responses route. " +
  "On chat-routed models, use any listed shell or command tools to complete browser/app tasks when possible. " +
  "For simple browser requests, open a browser URL by immediately calling the command tool with an OS/browser launch command. " +
  "For Computer Use requests on chat-routed models, use command tools to launch apps or scripts directly. " +
  "Do not call Get-Content or Get-ChildItem to read Browser, Chrome, or Computer Use SKILL.md files first. " +
  "Do not read Browser, Chrome, or Computer Use skill files to bootstrap Node REPL on chat-routed models; those native plugin instructions do not apply here. " +
  "Do not mention Node REPL availability unless the user explicitly asks about it. " +
  "Do not claim all tools are unavailable if another listed tool can do the work.";
const COMMAND_TOOL_GUIDANCE =
  "CodexBridge command guidance: when the user explicitly asks you to run tests, commit, push, or publish " +
  "and a command or shell tool is available, call that tool and report the exact command output. " +
  "For git push, inspect git status and remotes if needed, then run git push with the configured remote. " +
  "Do not claim network, GitHub, sandbox, or approval is unavailable unless an attempted command returns that error.";
const GITHUB_REPOSITORY_COMMAND_GUIDANCE =
  "CodexBridge GitHub repository guidance: when the user asks to inspect or open a GitHub repository " +
  "and a command or shell tool is available, call that tool to open the repository URL or query the GitHub API. " +
  "Do not ask the user to open it themselves unless the attempted command fails.";
const TOOL_RESULT_CONTEXT_HEADER =
  "CodexBridge tool result context: these tool outputs are already completed historical results. " +
  "Do not repeat or re-run these tool calls just because they appear here. " +
  "Use the results as context, continue from the latest user request, and only call a new tool if a genuinely new step is still needed.";
const TOOL_OUTPUT_CONTINUATION_GUIDANCE =
  "CodexBridge tool continuation guidance: the latest user turn contains tool outputs that Codex has already executed. " +
  "If those results satisfy the user's request, return a final concise answer now. " +
  "Do not repeat the same command, restart the same task, or call another tool unless a clearly missing next step remains.";
const ATTACHMENT_GUIDANCE =
  "CodexBridge attachment guidance: Chat-routed providers cannot read native Codex file or audio attachments unless CodexBridge forwards an explicit chat part or extracts text into this request. " +
  "Use only the attachment text, audio parts, or file parts already included here. " +
  "Do not call shell, browser, MCP, or local file tools to retrieve unsupported attachments. " +
  "If needed content is missing, ask the user to switch to a GPT/Responses model or provide text/OCR output.";
const CHAT_COMPATIBILITY_GUIDANCE_PREFIXES = Object.freeze([
  "CodexBridge tool guidance:",
  "CodexBridge interactive-tool guidance:",
  "CodexBridge command guidance:",
  "CodexBridge GitHub repository guidance:",
  "CodexBridge tool continuation guidance:",
  "CodexBridge controlled capability guidance:",
  "CodexBridge attachment guidance:",
]);
const PROTECTED_HISTORICAL_SYSTEM_PREFIXES = Object.freeze([
  "CodexBridge tool result context:",
  "Earlier conversation history was omitted by CodexBridge",
]);
const MAX_EXTRACTABLE_FILE_BYTES = 5_000_000;
const MAX_EXTRACTED_FILE_TEXT_CHARS = 120_000;
const UNNAMED_FILE_NAME = "未命名文件";
const CHAT_PROMPT_CACHE_CONTROL = { type: "ephemeral" };
const MAX_PROMPT_CACHE_BREAKPOINTS = 4;
export const CODEXBRIDGE_CAPABILITY_TOOL_NAME = "codexbridge_capability";

export function responsesToChatRequest(request, route, history, options = {}) {
  const { messages: sourceMessages, messagesForHistory, toolContext } =
    responseRequestToChatSourceMessages(request, route, history, options);
  const contextPolicy = chatContextPolicyForRoute(route);
  const sourceTokens = estimatedMessagesTokens(sourceMessages);
  const normalizedMessages = trimMessagesToRouteContext(sourceMessages, route, {
    contextPolicy,
  });
  const normalizedTokens = estimatedMessagesTokens(normalizedMessages);

  const body = {
    model: route.model,
    messages: normalizedMessages,
    stream: false,
  };
  if (shouldRequestSeparatedReasoning(route)) {
    body.reasoning_split = true;
  }

  let resolvedToolChoice = "";
  if (toolContext.chatTools.length > 0) {
    body.tools = toolContext.chatTools;
    const toolChoice = chatToolChoice(request.tool_choice, toolContext, request);
    resolvedToolChoice = toolChoice || "";
    if (toolChoice) {
      body.tool_choice = toolChoice;
    }
    if (!shouldDrop(route, "parallel_tool_calls")) {
      body.parallel_tool_calls = request.parallel_tool_calls ?? true;
    }
  }

  copyScalar(request, body, "temperature");
  copyScalar(request, body, "top_p");
  copyScalar(request, body, "presence_penalty");
  copyScalar(request, body, "frequency_penalty");
  copyScalar(request, body, "seed");
  copyScalar(request, body, "user");
  if (request.max_output_tokens !== undefined) {
    body.max_tokens = request.max_output_tokens;
  } else {
    copyScalar(request, body, "max_tokens");
    copyScalar(request, body, "max_completion_tokens");
  }
  if (request.stop !== undefined) {
    body.stop = request.stop;
  }
  if (request.response_format !== undefined && !shouldDrop(route, "response_format")) {
    body.response_format = request.response_format;
  }
  Object.assign(body, reasoningParamsForAdapter(request, route, {
    hasTools: toolContext.chatTools.length > 0,
  }));
  applyPromptCacheHints(body, route);

  return {
    body,
    toolContext,
    toolDiagnostics: toolDiagnosticsFromContext(toolContext, resolvedToolChoice),
    wantsStream: Boolean(request.stream),
    messagesForHistory: messagesForHistory || sourceMessages,
    contextDecision: sourceTokens > contextPolicy.inputBudget
      ? {
          event: "context_truncation",
          kind: "chat_payload",
          policyId: contextPolicy.policyId,
          policyVersion: contextPolicy.version,
          inputBudget: contextPolicy.inputBudget,
          beforeTokens: sourceTokens,
          afterTokens: normalizedTokens,
          preservedToolCount: preservedToolBoundaryCount(normalizedMessages),
          outcome: "truncated",
          reasonCode: "input_budget_exceeded",
        }
      : null,
  };
}

export function responseRequestToChatSourceMessages(request, route, history, options = {}) {
  const preserveNativeHistory = routeUsesStatelessDeepSeekResponses(route);
  const toolContext = buildToolContext(responseToolsForChatRequest(request, options), { route });
  const instructions = systemInstructionsFromRequest(request, {
    includeInputMessages: !preserveNativeHistory,
  });
  const storedPriorMessages = history?.get?.(request.previous_response_id) || [];
  const priorMessages = normalizeStoredPriorMessages(storedPriorMessages, instructions);
  const currentMessages = stripExactPersistedHistoryPrefix(
    responseInputToChatMessages(
      request.messages ?? request.input,
      toolContext,
      route,
    ),
    priorMessages,
  );

  const headerMessages = [];
  if (instructions) {
    headerMessages.push({ role: "system", content: instructions });
  }
  if (!preserveNativeHistory) {
    const toolGuidance = toolGuidanceFromContext(toolContext, request);
    if (toolGuidance) {
      headerMessages.push({ role: "system", content: toolGuidance });
    }
    const attachmentGuidance = attachmentGuidanceFromRequest(request);
    if (attachmentGuidance) {
      headerMessages.push({ role: "system", content: attachmentGuidance });
    }
  }
  const historySourceMessages = sanitizeMessagesForRoute(normalizeToolCallPairs([
    ...headerMessages,
    ...priorMessages,
    ...currentMessages,
  ], {
    flattenToolCalls: shouldFlattenToolCallHistory(route),
  }), route);
  const contextSwitchSummary = contextSwitchCompactionMessage(options.contextSwitchCompaction);
  if (contextSwitchSummary && priorMessages.length > 0) {
    const protectedMessages = Array.isArray(options.contextSwitchCompaction?.protectedMessages)
      ? options.contextSwitchCompaction.protectedMessages
      : [];
    const compactedSourceMessages = sanitizeMessagesForRoute(normalizeToolCallPairs([
      ...headerMessages,
      contextSwitchSummary,
      ...protectedMessages,
      ...currentMessages,
    ], {
      flattenToolCalls: shouldFlattenToolCallHistory(route),
    }), route);
    return {
      messages: compactedSourceMessages,
      messagesForHistory: compactedSourceMessages,
      toolContext,
    };
  }
  return { messages: historySourceMessages, toolContext };
}

function isChatCompatibilityGuidanceMessage(message) {
  if (message?.role !== "system") {
    return false;
  }
  const text = contentToText(message.content).trim();
  return CHAT_COMPATIBILITY_GUIDANCE_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function normalizeStoredPriorMessages(messages, currentInstructions) {
  const filtered = (Array.isArray(messages) ? messages : [])
    .filter((message) => !isChatCompatibilityGuidanceMessage(message));
  let leadingInstructionCount = 0;
  while (leadingInstructionCount < filtered.length) {
    const message = filtered[leadingInstructionCount];
    if (
      message?.role !== "system" ||
      isProtectedHistoricalSystemMessage(message)
    ) {
      break;
    }
    leadingInstructionCount += 1;
  }
  if (leadingInstructionCount === 0) {
    return filtered;
  }
  const retained = currentInstructions
    ? []
    : deduplicateLeadingInstructionMessages(filtered.slice(0, leadingInstructionCount));
  return [
    ...retained,
    ...filtered.slice(leadingInstructionCount),
  ];
}

function deduplicateLeadingInstructionMessages(messages) {
  const retained = [];
  for (const message of messages) {
    const duplicate = retained.some((existing) => {
      if (
        hasNativeResponsesHistoryItems(existing) ||
        hasNativeResponsesHistoryItems(message)
      ) {
        return isDeepStrictEqual(existing, message);
      }
      return contentToText(existing?.content).trim() ===
        contentToText(message?.content).trim();
    });
    if (!duplicate) {
      retained.push(message);
    }
  }
  return retained;
}

function isProtectedHistoricalSystemMessage(message) {
  const text = contentToText(message?.content).trim();
  return PROTECTED_HISTORICAL_SYSTEM_PREFIXES.some((prefix) => text.startsWith(prefix));
}

export function stripExactPersistedHistoryPrefix(currentMessages, priorMessages) {
  if (
    !Array.isArray(currentMessages) ||
    !Array.isArray(priorMessages)
  ) {
    return currentMessages;
  }
  const comparablePriorMessages = priorMessages.slice(
    firstNonSystemMessageIndex(priorMessages),
  );
  if (
    comparablePriorMessages.length === 0 ||
    currentMessages.length < comparablePriorMessages.length
  ) {
    return currentMessages;
  }
  for (let index = 0; index < comparablePriorMessages.length; index += 1) {
    if (!isDeepStrictEqual(currentMessages[index], comparablePriorMessages[index])) {
      return currentMessages;
    }
  }
  return currentMessages.slice(comparablePriorMessages.length);
}

function firstNonSystemMessageIndex(messages) {
  let index = 0;
  while (index < messages.length && messages[index]?.role === "system") {
    index += 1;
  }
  return index;
}

function contextSwitchCompactionMessage(compaction = null) {
  const text = String(compaction?.summary || "").trim();
  if (!text) {
    return null;
  }
  return {
    role: "user",
    content: text,
  };
}

export function responseInputToChatMessages(input, toolContext, route = {}) {
  if (input === undefined || input === null) {
    return [];
  }
  if (typeof input === "string") {
    const message = { role: "user", content: input };
    return [routeUsesStatelessDeepSeekResponses(route)
      ? attachNativeResponsesHistoryItems(message, [{ role: "user", content: input }])
      : message];
  }

  const items = Array.isArray(input) ? input : [input];
  const preserveNativeHistory = routeUsesStatelessDeepSeekResponses(route);
  const messages = [];
  let pendingToolCalls = [];
  let pendingReasoningContent = "";
  let pendingAssistantMessage = null;
  let pendingNativeItems = [];

  const flushAssistant = () => {
    const embeddedToolCalls = Array.isArray(pendingAssistantMessage?.tool_calls)
      ? pendingAssistantMessage.tool_calls
      : [];
    const toolCalls = [...embeddedToolCalls, ...pendingToolCalls];
    if (
      !pendingAssistantMessage &&
      toolCalls.length === 0 &&
      pendingNativeItems.length === 0
    ) {
      pendingReasoningContent = "";
      return false;
    }
    const assistant = pendingAssistantMessage
      ? { ...pendingAssistantMessage }
      : { role: "assistant", content: null };
    if (toolCalls.length > 0) {
      assistant.tool_calls = toolCalls;
      if (!messageHasContent(assistant)) {
        assistant.content = null;
      }
    }
    if (toolCalls.length > 0 && pendingReasoningContent) {
      assistant.reasoning_content = pendingReasoningContent;
    }
    messages.push(preserveNativeHistory
      ? attachNativeResponsesHistoryItems(assistant, pendingNativeItems)
      : assistant);
    pendingToolCalls = [];
    pendingReasoningContent = "";
    pendingAssistantMessage = null;
    pendingNativeItems = [];
    return true;
  };

  for (const item of items) {
    if (item?.type === "reasoning") {
      if (preserveNativeHistory) {
        pendingNativeItems.push(item);
      }
      const reasoningContent = responseReasoningContentForToolCall(item, route);
      if (reasoningContent) {
        pendingReasoningContent += reasoningContent;
      }
      continue;
    }

    if (isResponseToolCallItem(item)) {
      if (preserveNativeHistory) {
        pendingNativeItems.push(item);
      }
      if (shouldOmitResponseToolCallFromChatHistory(item, toolContext)) {
        continue;
      }
      pendingToolCalls.push(chatToolCallFromResponseItem(item, toolContext));
      continue;
    }

    if (
      item &&
      typeof item === "object" &&
      ["system", "developer"].includes(item.role)
    ) {
      flushAssistant();
      if (preserveNativeHistory) {
        const systemMessage = responseMessageToChatMessage(item, route) || {
          role: "system",
          content: contentToText(item.content),
        };
        messages.push(attachNativeResponsesHistoryItems(systemMessage, [item]));
      }
      continue;
    }

    if (preserveNativeHistory && item?.type === "web_search_call") {
      flushAssistant();
      messages.push(attachNativeResponsesHistoryItems(
        { role: "assistant", content: null },
        [item],
      ));
      continue;
    }

    const message = responseMessageToChatMessage(item, route);
    if (message?.role === "assistant") {
      if (pendingAssistantMessage) {
        flushAssistant();
      }
      pendingAssistantMessage = message;
      if (preserveNativeHistory) {
        pendingNativeItems.push(item);
      }
      continue;
    }

    flushAssistant();

    if (isResponseToolOutputItem(item)) {
      const toolMessage = chatMessageFromToolOutput(item);
      messages.push(preserveNativeHistory
        ? attachNativeResponsesHistoryItems(toolMessage, [item])
        : toolMessage);
      continue;
    }

    if (isCompactionItem(item)) {
      const summary = compactionText(item);
      if (summary) {
        messages.push({ role: "user", content: summary });
      }
      continue;
    }

    if (item?.type === "compaction_trigger") {
      continue;
    }

    if (message) {
      messages.push(preserveNativeHistory
        ? attachNativeResponsesHistoryItems(message, [item])
        : message);
    }
  }

  flushAssistant();
  return messages;
}

function responseReasoningContentForToolCall(item, route = {}) {
  if (item?.type !== "reasoning" || !routeSupportsReasoningContent(route)) {
    return "";
  }
  if (typeof item.reasoning_content === "string" && item.reasoning_content) {
    return item.reasoning_content;
  }
  if (Array.isArray(item.content)) {
    const content = item.content
      .map((part) => part?.type === "reasoning_text"
        ? String(part.text || "")
        : String(part?.reasoning_text || ""))
      .join("");
    if (content) {
      return content;
    }
  }
  if (!Array.isArray(item.summary)) {
    return "";
  }
  return item.summary
    .map((part) => typeof part === "string" ? part : String(part?.text || ""))
    .join("");
}

function isCompactionItem(item) {
  return item?.type === "compaction" || item?.type === "context_compaction";
}

function compactionText(item) {
  if (typeof item?.encrypted_content === "string") {
    return item.encrypted_content;
  }
  return contentToText(item?.content ?? item?.text ?? item?.output ?? "");
}

function shouldOmitResponseToolCallFromChatHistory(item, toolContext) {
  if (item?.type !== "computer_call") {
    return false;
  }
  const responseName = namespacedToolName(item.name || item.type || "tool", item.namespace);
  return !toolContext.responseNameToChatName.has(responseName);
}

export function responseMessageToChatMessage(item, route = {}) {
  if (typeof item === "string") {
    return { role: "user", content: item };
  }
  if (!item || typeof item !== "object") {
    return null;
  }

  if (item.type === "reasoning") {
    return null;
  }

  const role = normalizeRole(item.role || roleFromType(item.type));
  if (!role) {
    return null;
  }

  const message = {
    role,
    content: contentToChatContent(item.content ?? item.text ?? item.output ?? "", route),
  };

  const phase = responseAssistantPhase(item);
  if (role === "assistant" && phase) {
    message.responses_phase = phase;
  }

  if (Array.isArray(item.tool_calls)) {
    message.tool_calls = item.tool_calls;
    if (!message.content) {
      message.content = null;
    }
  }
  if (role === "tool") {
    const toolCallId = item.tool_call_id || item.call_id || item.id;
    if (toolCallId) {
      message.tool_call_id = toolCallId;
    }
  }

  return message;
}

function responseAssistantPhase(item) {
  const phase = typeof item?.phase === "string" ? item.phase.trim() : "";
  return ["commentary", "final_answer"].includes(phase) ? phase : "";
}

export function contentToChatContent(content, route = {}) {
  if (content === undefined || content === null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    const imagePart = imagePartToChat(content, route);
    if (imagePart) {
      return [imagePart];
    }
    const audioPart = audioPartToChat(content, route);
    if (audioPart) {
      return [audioPart];
    }
    if (isFilePart(content)) {
      const filePart = filePartToChat(content, route);
      return filePart.chatPart ? [filePart.chatPart] : filePart.text;
    }
    return contentToText(content);
  }

  const textParts = [];
  const chatParts = [];
  let hasNonTextPart = false;

  for (const part of content) {
    if (typeof part === "string") {
      if (part) {
        textParts.push(part);
        chatParts.push({ type: "text", text: part });
      }
      continue;
    }
    if (!part || typeof part !== "object") {
      continue;
    }

    const imagePart = imagePartToChat(part, route);
    if (imagePart) {
      hasNonTextPart = true;
      chatParts.push(imagePart);
      continue;
    }

    const audioPart = audioPartToChat(part, route);
    if (audioPart) {
      if (audioPart.type !== "text") {
        hasNonTextPart = true;
      } else {
        textParts.push(audioPart.text);
      }
      chatParts.push(audioPart);
      continue;
    }

    if (isFilePart(part)) {
      const filePart = filePartToChat(part, route);
      if (filePart.chatPart) {
        hasNonTextPart = true;
        chatParts.push(filePart.chatPart);
        continue;
      }
      if (filePart.text) {
        textParts.push(filePart.text);
        chatParts.push({ type: "text", text: filePart.text });
      }
      continue;
    }

    const text = textFromContentPart(part);
    if (text) {
      textParts.push(text);
      chatParts.push({ type: "text", text });
      continue;
    }

    if (part.type && Object.keys(part).length > 0) {
      const json = stringifyJson(part);
      textParts.push(json);
      chatParts.push({ type: "text", text: json });
    }
  }

  if (hasNonTextPart) {
    return chatParts;
  }
  return textParts.filter(Boolean).join("\n");
}

export function contentToText(content) {
  if (content === undefined || content === null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    const text = textFromContentPart(content);
    if (text) {
      return text;
    }
    if (isImagePart(content)) {
      return "[image input not forwarded in text-only context]";
    }
    if (isAudioPart(content)) {
      return unavailableAudioText(content);
    }
    if (isFilePart(content)) {
      return filePartToChat(content).text;
    }
    return stringifyJson(content);
  }

  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!part || typeof part !== "object") {
      continue;
    }
    const text = textFromContentPart(part);
    if (text) {
      parts.push(text);
    } else if (isImagePart(part)) {
      parts.push("[image input not forwarded in text-only context]");
    } else if (isAudioPart(part)) {
      parts.push(unavailableAudioText(part));
    } else if (isFilePart(part)) {
      parts.push(filePartToChat(part).text);
    } else if (part.type && Object.keys(part).length > 0) {
      parts.push(stringifyJson(part));
    }
  }
  return parts.filter(Boolean).join("\n");
}

function textFromContentPart(part) {
  if (typeof part?.text === "string") {
    return part.text;
  }
  if (typeof part?.output_text === "string") {
    return part.output_text;
  }
  return "";
}

function imagePartToChat(part, route = {}) {
  if (!isImagePart(part)) {
    return null;
  }
  if (!shouldForwardImagesToChat(route)) {
    return { type: "text", text: "[image input not forwarded in text-only context]" };
  }
  const rawImageUrl = part.image_url ?? part.imageUrl ?? part.url;
  const url =
    typeof rawImageUrl === "string"
      ? rawImageUrl
      : rawImageUrl?.url || part.url;
  if (!url) {
    return { type: "text", text: "[image input missing url]" };
  }
  if (isOversizedDataImageUrl(url)) {
    return { type: "text", text: OVERSIZED_IMAGE_PLACEHOLDER };
  }
  const imageUrl = { url };
  const detail = part.detail || rawImageUrl?.detail;
  if (detail) {
    imageUrl.detail = detail;
  }
  return { type: "image_url", image_url: imageUrl };
}

function shouldForwardImagesToChat(route = {}) {
  if (!route || Object.keys(route).length === 0) {
    return true;
  }
  if (route.api === "responses") {
    return true;
  }
  return Array.isArray(route.inputModalities) && route.inputModalities.includes("image");
}

function isOversizedDataImageUrl(value) {
  return (
    typeof value === "string" &&
    value.length > MAX_CHAT_DATA_IMAGE_URL_CHARS &&
    /^data:image\//i.test(value)
  );
}

function isImagePart(part) {
  const type = String(part?.type || "").toLowerCase();
  return type === "image_url" || type.includes("image");
}

function audioPartToChat(part, route = {}) {
  if (!isAudioPart(part)) {
    return null;
  }
  if (!shouldForwardAudioToChat(route)) {
    return { type: "text", text: unavailableAudioText(part) };
  }
  const inputAudio = normalizedInputAudio(part);
  if (!inputAudio.data) {
    return { type: "text", text: "[audio input missing data]" };
  }
  return {
    type: "input_audio",
    input_audio: inputAudio,
  };
}

function shouldForwardAudioToChat(route = {}) {
  if (route?.api === "responses") {
    return true;
  }
  const modalities = Array.isArray(route?.inputModalities)
    ? route.inputModalities.map((item) => String(item || "").toLowerCase())
    : [];
  return modalities.includes("audio");
}

function isAudioPart(part) {
  if (!part || typeof part !== "object") {
    return false;
  }
  const type = String(part.type || "").toLowerCase();
  return (
    type === "input_audio" ||
    type === "audio" ||
    type.includes("audio") ||
    Boolean(part.input_audio) ||
    Boolean(part.inputAudio)
  );
}

function normalizedInputAudio(part) {
  const raw =
    (part.input_audio && typeof part.input_audio === "object" ? part.input_audio : null) ||
    (part.inputAudio && typeof part.inputAudio === "object" ? part.inputAudio : null) ||
    (part.audio && typeof part.audio === "object" ? part.audio : null) ||
    part;
  const data = raw.data || raw.audio_data || raw.audioData || "";
  const format = raw.format || part.format || audioFormatFromMime(raw.mime_type || raw.mimeType || part.mime_type || part.mimeType);
  const inputAudio = {};
  if (typeof data === "string" && data) {
    inputAudio.data = data;
  }
  if (typeof format === "string" && format) {
    inputAudio.format = format;
  }
  return inputAudio;
}

function unavailableAudioText(part) {
  const inputAudio = normalizedInputAudio(part);
  const description = inputAudio.format ? `${inputAudio.format} 音频` : "音频";
  return `[CodexBridge 当前不会把音频直接转发给这个 Chat 模型：${description}。请先提供文字转录后再继续。]`;
}

function audioFormatFromMime(mime) {
  const value = String(mime || "").toLowerCase();
  if (value.includes("wav")) return "wav";
  if (value.includes("mpeg") || value.includes("mp3")) return "mp3";
  if (value.includes("ogg")) return "ogg";
  if (value.includes("webm")) return "webm";
  if (value.includes("mp4") || value.includes("m4a")) return "mp4";
  return "";
}

function isFilePart(part) {
  const type = String(part?.type || "").toLowerCase();
  return (
    type.includes("file") ||
    type.includes("pdf") ||
    type.includes("document")
  );
}

function filePartName(part) {
  return (
    part.filename ||
    part.file_name ||
    part.name ||
    part.file_id ||
    part.id ||
    UNNAMED_FILE_NAME
  );
}

function filePartToChat(part, route = {}) {
  if (shouldForwardFilesToChat(route)) {
    const file = {};
    const filename = filePartName(part);
    if (filename && filename !== UNNAMED_FILE_NAME) {
      file.filename = filename;
    }
    if (typeof part.file_id === "string" && part.file_id) {
      file.file_id = part.file_id;
    }
    const fileData = part.file_data ?? part.fileData;
    if (typeof fileData === "string" && fileData) {
      file.file_data = fileData;
    }
    if (file.file_id || file.file_data) {
      return { chatPart: { type: "file", file } };
    }
  }

  const extractedText = extractedFileText(part);
  if (extractedText) {
    return { text: extractedText };
  }
  return { text: unavailableFileText(part) };
}

function shouldForwardFilesToChat(route = {}) {
  if (route?.api === "responses") {
    return true;
  }
  if (route?.forwardFilesToChat === true) {
    return true;
  }
  const modalities = Array.isArray(route?.inputModalities)
    ? route.inputModalities.map((item) => String(item || "").toLowerCase())
    : [];
  return modalities.some((modality) =>
    ["file", "pdf", "document"].includes(modality),
  );
}

function extractedFileText(part) {
  const fileData = part?.file_data ?? part?.fileData;
  if (typeof fileData !== "string" || !fileData) {
    return "";
  }
  const parsed = parseDataUrl(fileData);
  if (!parsed) {
    return "";
  }
  const name = filePartName(part);
  const mime = (parsed.mime || mimeFromFileName(name)).toLowerCase();
  let text = "";
  if (isTextFileMime(mime, name)) {
    text = parsed.buffer.toString("utf8");
    if (!looksReadableText(text)) {
      text = "";
    }
  } else if (isPdfFile(mime, name)) {
    text = extractSimplePdfText(parsed.buffer);
  }
  text = normalizeExtractedText(text);
  if (!text) {
    return "";
  }
  return `[file: ${name} extracted by CodexBridge]\n${text}\n[/file]`;
}

function parseDataUrl(value) {
  const match = String(value).match(/^data:([^,]*),(.*)$/is);
  if (!match) {
    return null;
  }
  const meta = match[1] || "";
  const payload = match[2] || "";
  const mime = meta.split(";")[0] || "";
  try {
    const estimatedBytes = meta.toLowerCase().includes(";base64")
      ? Math.floor((payload.length * 3) / 4)
      : payload.length;
    if (estimatedBytes > MAX_EXTRACTABLE_FILE_BYTES) {
      return null;
    }
    const buffer = meta.toLowerCase().includes(";base64")
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
    if (!buffer.length) {
      return null;
    }
    return { mime, buffer };
  } catch {
    return null;
  }
}

function isTextFileMime(mime, name) {
  return (
    mime.startsWith("text/") ||
    [
      "application/json",
      "application/xml",
      "application/javascript",
      "application/x-javascript",
      "application/yaml",
      "application/x-yaml",
      "application/toml",
    ].includes(mime) ||
    /\.(txt|md|markdown|json|jsonl|csv|tsv|xml|html|css|js|jsx|ts|tsx|mjs|cjs|py|ps1|sh|bat|cmd|toml|yaml|yml|ini|log)$/i.test(name)
  );
}

function isPdfFile(mime, name) {
  return mime === "application/pdf" || /\.pdf$/i.test(name);
}

function mimeFromFileName(name) {
  if (/\.pdf$/i.test(name)) {
    return "application/pdf";
  }
  if (/\.(txt|md|markdown|json|jsonl|csv|tsv|xml|html|css|js|jsx|ts|tsx|mjs|cjs|py|ps1|sh|bat|cmd|toml|yaml|yml|ini|log)$/i.test(name)) {
    return "text/plain";
  }
  return "";
}

function looksReadableText(value) {
  const text = String(value || "");
  const sample = text.slice(0, 4096);
  if (!sample.trim()) {
    return false;
  }
  const replacementChars = (sample.match(/\uFFFD/g) || []).length;
  if (replacementChars / sample.length > 0.02) {
    return false;
  }
  const controlChars = (sample.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
  return controlChars / sample.length <= 0.02;
}

function extractSimplePdfText(buffer) {
  const raw = buffer.toString("latin1");
  if (!/%PDF-\d\.\d/.test(raw) && !/\bBT\b[\s\S]*\bET\b/.test(raw)) {
    return "";
  }
  const parts = [];
  const streams = raw.match(/stream\r?\n?[\s\S]*?\r?\n?endstream/g) || [raw];
  for (const stream of streams) {
    for (const match of stream.matchAll(/\(((?:\\.|[^\\()])*)\)\s*(?:Tj|'|")/g)) {
      const text = decodePdfLiteral(match[1]);
      if (text) {
        parts.push(text);
      }
    }
    for (const match of stream.matchAll(/\[((?:\s*\((?:\\.|[^\\()])*\)\s*)+)\]\s*TJ/g)) {
      for (const inner of match[1].matchAll(/\((?:\\.|[^\\()])*\)/g)) {
        const literal = inner[0].slice(1, -1);
        const text = decodePdfLiteral(literal);
        if (text) {
          parts.push(text);
        }
      }
    }
    for (const match of stream.matchAll(/<([0-9A-Fa-f\s]{4,})>\s*Tj/g)) {
      const text = decodePdfHexString(match[1]);
      if (text) {
        parts.push(text);
      }
    }
  }
  return parts.join("\n");
}

function decodePdfLiteral(value) {
  return String(value || "").replace(/\\([nrtbf()\\]|[0-7]{1,3}|.)/g, (_match, escaped) => {
    if (escaped === "n") return "\n";
    if (escaped === "r") return "\r";
    if (escaped === "t") return "\t";
    if (escaped === "b") return "\b";
    if (escaped === "f") return "\f";
    if (escaped === "(") return "(";
    if (escaped === ")") return ")";
    if (escaped === "\\") return "\\";
    if (/^[0-7]{1,3}$/.test(escaped)) {
      return String.fromCharCode(parseInt(escaped, 8));
    }
    return escaped;
  });
}

function decodePdfHexString(value) {
  const hex = String(value || "").replace(/\s+/g, "");
  if (!hex || hex.length % 2 !== 0) {
    return "";
  }
  try {
    const buffer = Buffer.from(hex, "hex");
    if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
      return buffer.subarray(2).toString("utf16le");
    }
    return buffer.toString("utf8");
  } catch {
    return "";
  }
}

function normalizeExtractedText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]+/g, " ")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim()
    .slice(0, MAX_EXTRACTED_FILE_TEXT_CHARS);
}

function unavailableFileText(part) {
  const name = filePartName(part);
  const type = isPdfFile(
    String(part?.mime_type || part?.mimeType || ""),
    name,
  )
    ? "PDF 附件"
    : "文件附件";
  return `${type}当前 Chat 模型不可用：${name}。CodexBridge 没有转发该文件，也没有提取到可读文本。请切换到 GPT/Responses 模型，或提供文本/OCR 内容。`;
}

function attachmentGuidanceFromRequest(request = {}) {
  return requestHasAttachmentInput(request.messages ?? request.input)
    ? ATTACHMENT_GUIDANCE
    : "";
}

function requestHasAttachmentInput(input) {
  if (input === undefined || input === null) {
    return false;
  }
  if (Array.isArray(input)) {
    return input.some(requestHasAttachmentInput);
  }
  if (typeof input !== "object") {
    return false;
  }
  if (isFilePart(input) || isAudioPart(input)) {
    return true;
  }
  return requestHasAttachmentInput(input.content ?? input.input ?? input.output);
}

function systemInstructionsFromRequest(request, options = {}) {
  const parts = [];
  if (typeof request.instructions === "string" && request.instructions.trim()) {
    parts.push(request.instructions.trim());
  }
  const requestMessages = request.messages ?? request.input;
  for (const message of options.includeInputMessages === false ? [] : asArray(requestMessages)) {
    if (
      message &&
      typeof message === "object" &&
      ["system", "developer"].includes(message.role)
    ) {
      const text = contentToText(message.content);
      if (text) {
        parts.push(text);
      }
    }
  }
  return parts.join("\n\n");
}

function toolGuidanceFromContext(toolContext, request = {}) {
  if (!toolContext?.chatTools?.length) {
    return "";
  }
  const names = toolContext.chatTools
    .map((tool) => tool?.function?.name || "")
    .filter(Boolean);
  const needsGuidance = names.some((name) =>
    name.startsWith("mcp__") ||
    name.includes("computer") ||
    name.includes("browser") ||
    name.includes("chrome")
  );
  const interactiveKind = interactivePluginKindForRequest(request);
  const hasControlledBrowserBridge =
    interactiveKind === "chrome" && Boolean(controlledBrowserCapabilityChatName(toolContext));
  const needsBridgeCapabilityGuidance = names.includes(CODEXBRIDGE_CAPABILITY_TOOL_NAME);
  const needsInteractiveFallbackGuidance =
    Boolean(interactiveKind) &&
    !hasControlledBrowserBridge &&
    !needsBridgeCapabilityGuidance &&
    !chatNameForTool(toolContext, "mcp__node_repl__js");
  const needsCommandGuidance =
    names.some(isCommandToolName) && requestMentionsCommandWork(request);
  const needsGitHubRepositoryGuidance =
    names.some(isCommandToolName) && requestMentionsGitHubRepositoryInspection(request);
  const needsToolOutputContinuationGuidance = requestHasResponseToolOutput(request);
  return [
    needsBridgeCapabilityGuidance ? bridgeCapabilityGuidanceFromContext(toolContext) : "",
    needsGuidance ? MCP_TOOL_GUIDANCE : "",
    needsInteractiveFallbackGuidance ? INTERACTIVE_CHAT_FALLBACK_GUIDANCE : "",
    needsCommandGuidance ? COMMAND_TOOL_GUIDANCE : "",
    needsGitHubRepositoryGuidance ? GITHUB_REPOSITORY_COMMAND_GUIDANCE : "",
    needsToolOutputContinuationGuidance ? TOOL_OUTPUT_CONTINUATION_GUIDANCE : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function bridgeCapabilityGuidanceFromContext(toolContext = {}) {
  const bridgeTool = toolContext.chatTools?.find((tool) =>
    tool?.function?.name === CODEXBRIDGE_CAPABILITY_TOOL_NAME
  );
  const properties = bridgeTool?.function?.parameters?.properties || {};
  const capabilities = new Set(asArray(properties.capability?.enum).map((item) => String(item || "")));
  const actions = new Set(asArray(properties.action?.enum).map((item) => String(item || "")));
  const descriptions = [];
  if (capabilities.has("browser") && actions.has("read_url")) {
    descriptions.push("browser/read_url for reading an http or https webpage or safe bare domains");
  }
  if (capabilities.has("browser") && actions.has("open_url")) {
    descriptions.push("browser/open_url for opening an http or https URL or safe bare domains in the system browser");
  }
  if (capabilities.has("web_search") && actions.has("search")) {
    descriptions.push("web_search/search for searching the web through a configured search provider");
  }
  if (capabilities.has("webpage_screenshot") && actions.has("screenshot_url")) {
    descriptions.push("webpage_screenshot/screenshot_url for capturing an http or https webpage or safe bare domains through a configured screenshot provider");
  }
  if (capabilities.has("ocr") && actions.has("extract_text")) {
    descriptions.push("ocr/extract_text for extracting text from an http or https image URL or safe bare domains through a configured OCR provider");
  }
  if (capabilities.has("file_processing") && actions.has("extract_text")) {
    descriptions.push("file_processing/extract_text for extracting text from an http or https file URL or explicit local file path through a configured file provider");
  }
  if (capabilities.has("file_processing") && actions.has("inspect_file")) {
    descriptions.push("file_processing/inspect_file for inspecting metadata and a short preview of an explicit local text file path through a local_file provider");
  }
  if (capabilities.has("speech") && actions.has("synthesize")) {
    descriptions.push("speech/synthesize for turning text into speech through a configured speech provider");
  }
  if (capabilities.has("video") && actions.has("generate")) {
    descriptions.push("video/generate for generating video through a configured video provider");
  }
  if (capabilities.has("computer_use") && actions.has("list_apps")) {
    descriptions.push("computer_use/list_apps for listing safe allowlisted local apps");
  }
  if (capabilities.has("computer_use") && actions.has("open_app")) {
    descriptions.push("computer_use/open_app for opening an allowlisted local app by name");
  }
  if (capabilities.has("computer_use") && actions.has("screenshot_desktop")) {
    descriptions.push("computer_use/screenshot_desktop for taking a safe desktop screenshot when the desktop executor is connected");
  }
  const available = descriptions.length > 0
    ? descriptions.join(", ")
    : "the capability/action pairs listed in this request's codexbridge_capability tool schema";
  const filePathGuidance = capabilities.has("file_processing")
    ? " For local_file file_processing providers, use path/filePath/localPath only for an explicit local file path provided in the current user request; never send local paths to remote file providers."
    : "";
  return `CodexBridge controlled capability guidance: use codexbridge_capability only for allowed tasks: ${available}.` +
    filePathGuidance +
    " Do not use shell commands for these controlled capability tasks or unsupported actions.";
}

function responseToolsForChatRequest(request = {}, options = {}) {
  const tools = [...(request.tools || [])];
  const requestedCapabilities = requestedBridgeCapabilitiesForRequest(request);
  const requestedActions = requestedBridgeActionsForRequest(request, requestedCapabilities);
  const bridgeTool = requestedCapabilities === null || requestedCapabilities.length > 0
    ? bridgeCapabilityToolFromProviders(options.capabilityProviders, {
      capabilities: requestedCapabilities,
      actions: requestedActions,
    })
    : null;
  if (bridgeTool) {
    tools.push(bridgeTool);
  }
  return tools;
}

function requestWantsBridgeCapability(request = {}) {
  if (bridgeToolChoiceSelected(request.tool_choice)) {
    return true;
  }
  return requestedBridgeCapabilitiesForRequest(request).length > 0;
}

function requestedBridgeCapabilitiesForRequest(request = {}) {
  if (bridgeToolChoiceSelected(request.tool_choice)) {
    return null;
  }
  const text = requestCurrentUserText(request);
  if (!text || isBridgeCapabilitySetupOrUiTask(text)) {
    return [];
  }
  const capabilities = [];
  if (requestMentionsInteractivePluginWork(request)) {
    capabilities.push("computer_use", "browser");
  }
  if (textMentionsDesktopScreenshotWork(text)) {
    capabilities.push("computer_use");
  }
  if (textMentionsWebSearchWork(text)) {
    capabilities.push("web_search");
  }
  if (textMentionsBrowserWork(text) || textMentionsReadSearchResultWork(text)) {
    capabilities.push("browser");
  }
  if (textMentionsWebpageScreenshotWork(text)) {
    capabilities.push("webpage_screenshot");
  }
  if (textMentionsOcrWork(text)) {
    capabilities.push("ocr");
  }
  if (textMentionsFileProcessingWork(text)) {
    capabilities.push("file_processing");
  }
  if (textMentionsSpeechWork(text)) {
    capabilities.push("speech");
  }
  if (textMentionsVideoWork(text)) {
    capabilities.push("video");
  }
  return uniqueBridgeCapabilityValues(capabilities);
}

function requestedBridgeActionsForRequest(request = {}, capabilities = []) {
  if (bridgeToolChoiceSelected(request.tool_choice)) {
    return null;
  }
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    return null;
  }
  const text = requestCurrentUserText(request);
  const actions = [];
  const scopedCapabilities = new Set();
  if (capabilities.includes("browser")) {
    const browserActions = [];
    if (textMentionsBrowserReadWork(text) || textMentionsReadSearchResultWork(text)) {
      browserActions.push("read_url");
    }
    if (textMentionsBrowserOpenWork(text)) {
      browserActions.push("open_url");
    }
    if (browserActions.length > 0) {
      scopedCapabilities.add("browser");
      actions.push(...browserActions);
    }
  }
  if (capabilities.includes("computer_use")) {
    const computerActions = [];
    if (textMentionsComputerAppLaunchWork(text)) {
      computerActions.push("list_apps", "open_app");
    }
    if (textMentionsDesktopScreenshotWork(text)) {
      computerActions.push("screenshot_desktop");
    }
    if (computerActions.length > 0) {
      scopedCapabilities.add("computer_use");
      actions.push(...computerActions);
    }
  }
  if (capabilities.includes("file_processing")) {
    const fileActions = [];
    if (textMentionsFileInspectWork(text)) {
      fileActions.push("inspect_file");
    } else if (textMentionsFileProcessingWork(text)) {
      fileActions.push("extract_text");
    }
    if (fileActions.length > 0) {
      scopedCapabilities.add("file_processing");
      actions.push(...fileActions);
    }
  }
  if (scopedCapabilities.size === 0) {
    return null;
  }
  for (const capability of capabilities) {
    if (scopedCapabilities.has(capability)) {
      continue;
    }
    const defaultActions = defaultBridgeActionsForUnscopedCapability(capability);
    actions.push(...defaultActions);
  }
  return uniqueBridgeCapabilityValues(actions);
}

function defaultBridgeActionsForUnscopedCapability(capability = "") {
  switch (capability) {
    case "web_search":
      return ["search"];
    case "webpage_screenshot":
      return ["screenshot_url"];
    case "ocr":
    case "file_processing":
      return ["extract_text"];
    case "speech":
      return ["synthesize"];
    case "video":
      return ["generate"];
    default:
      return [];
  }
}

function bridgeToolChoiceSelected(toolChoice) {
  if (!toolChoice) {
    return false;
  }
  if (typeof toolChoice === "string") {
    return toolChoice === CODEXBRIDGE_CAPABILITY_TOOL_NAME;
  }
  if (typeof toolChoice !== "object") {
    return false;
  }
  const name = String(toolChoice.name || toolChoice.function?.name || "").trim();
  return name === CODEXBRIDGE_CAPABILITY_TOOL_NAME;
}

function isBridgeCapabilitySetupOrUiTask(text = "") {
  const value = String(text || "");
  const englishAction = "\\b(?:build|create|make|write|draft|implement|design|add|fix|configure|document)\\b";
  const englishCapability = "\\b(?:browser|webpage|screenshot|search|ocr|file|speech|video|computer\\s*use)\\b";
  const englishArtifact = "\\b(?:component|button|panel|page|screen|modal|form|toolbar|settings?|config|configuration|docs?|documentation|setup|provider|integration|api|schema|ui|ux|copy|wording|guide|workflow)\\b";
  if (new RegExp(`${englishAction}.{0,32}${englishCapability}.{0,36}${englishArtifact}|${englishAction}.{0,32}${englishArtifact}.{0,36}${englishCapability}`, "i").test(value)) {
    return true;
  }
  const chineseAction = "(?:帮我|给我|请|做|写|生成|创建|实现|开发|设计|添加|修复|配置|接入|优化)";
  const chineseCapability = "(?:浏览器|网页|网站|截图|截屏|搜索|OCR|ocr|文件|语音|视频|Computer Use|电脑)";
  const chineseArtifact = "(?:组件|按钮|面板|页面|弹窗|表单|设置|配置|文档|说明|供应商|接入|接口|功能|流程|方案|规范|文案)";
  return new RegExp(`${chineseAction}.{0,24}${chineseCapability}.{0,28}${chineseArtifact}|${chineseAction}.{0,24}${chineseArtifact}.{0,28}${chineseCapability}`, "iu").test(value);
}

function textMentionsWebSearchWork(text = "") {
  return /(?:\b(?:search|web\s*search|look\s*up|google|find\s+(?:online|on\s+the\s+web|latest))\b|搜索|搜一下|查一下|联网查|全网查|网上查)/i.test(String(text || ""));
}

function textMentionsBrowserWork(text = "") {
  const value = String(text || "");
  const hasUrl = textContainsUrlLikeTarget(value);
  return /(?:\b(?:open|visit|browse|read)\b|打开|访问|浏览|读取).{0,32}(?:browser|webpage|web\s*page|site|website|url|link|网页|网站|链接|网址|浏览器)/i.test(value) ||
    (hasUrl && /(?:\b(?:open|visit|browse|read)\b|打开|访问|浏览|读取)/i.test(value));
}

function textContainsUrlLikeTarget(text = "") {
  return /https?:\/\/|www\.|(?:^|[\s，。；:：,.;:])[\w.-]+\.[a-z]{2,}(?:[\/\s，。；:：,.;:]|$)/i.test(String(text || ""));
}

function textMentionsReadSearchResultWork(text = "") {
  const value = String(text || "");
  return textMentionsWebSearchWork(value) &&
    /\b(?:read|open|visit|browse)\b.{0,24}\b(?:best|top|first|result|results|page|article)\b/i.test(value);
}

function textMentionsBrowserReadWork(text = "") {
  const value = String(text || "");
  return /(?:\b(?:read|fetch|inspect|summarize|summarise)\b.{0,32}(?:browser|webpage|web\s*page|site|website|url|link|page|article)|(?:读取|阅读|查看|总结|概括).{0,32}(?:网页|网站|链接|网址|页面|文章))/i.test(value) ||
    (textContainsUrlLikeTarget(value) && /\b(?:read|fetch|inspect|summarize|summarise)\b|读取|阅读|查看|总结|概括/i.test(value));
}

function textMentionsBrowserOpenWork(text = "") {
  const value = String(text || "");
  return /(?:\b(?:open|visit|browse)\b.{0,32}(?:browser|webpage|web\s*page|site|website|url|link|page)|(?:打开|访问|浏览).{0,32}(?:浏览器|网页|网站|链接|网址|页面))/i.test(value) ||
    (textContainsUrlLikeTarget(value) && /\b(?:open|visit|browse)\b|打开|访问|浏览/i.test(value));
}

function textMentionsWebpageScreenshotWork(text = "") {
  const value = String(text || "");
  return /(?:\b(?:take|capture|get)\b.{0,24}\bscreenshot\b|\bscreenshot\b.{0,24}\b(?:of|for|from)\b|网页截图|网页截屏|页面截图|网站截图|截取.{0,12}(?:网页|页面|网站|截图|截屏))/i.test(value);
}

function textMentionsDesktopScreenshotWork(text = "") {
  return /(?:\b(?:take|capture|get)\b.{0,24}\b(?:desktop|screen|display)\s+screenshot\b|\b(?:desktop|screen|display)\s+screenshot\b|桌面截图|屏幕截图|截取.{0,12}(?:桌面|屏幕|显示器))/i.test(String(text || ""));
}

function textMentionsComputerAppLaunchWork(text = "") {
  const value = String(text || "");
  return /(?:\b(?:open|launch|start|run)\b.{0,24}\b(?:app|application|notepad|calculator|paint|mspaint)\b|打开.{0,16}(?:应用|软件|记事本|计算器|画图)|启动.{0,16}(?:应用|软件|记事本|计算器|画图))/i.test(value);
}

function textMentionsOcrWork(text = "") {
  return /(?:\bocr\b|extract.{0,24}text.{0,24}(?:image|screenshot|photo)|read.{0,24}text.{0,24}(?:image|screenshot|photo)|识别.{0,16}(?:图片|图像|截图|照片).{0,16}(?:文字|文本)|(?:图片|图像|截图|照片).{0,16}(?:文字|文本).{0,16}(?:识别|提取|读取))/i.test(String(text || ""));
}

function textMentionsFileProcessingWork(text = "") {
  const value = String(text || "");
  const hasLocalPath = /[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+|\.(?:txt|md|json|csv|log|pdf|docx?|xlsx?|pptx?)\b/i.test(value);
  return /(?:extract|read|inspect|parse).{0,24}(?:text|content|metadata)?.{0,24}(?:file|pdf|docx?|xlsx?|pptx?|report|url)/i.test(value) ||
    /(?:读取|提取|检查|解析|查看).{0,24}(?:文件|PDF|报告|文档|表格|本地路径)/i.test(value) ||
    hasLocalPath;
}

function textMentionsFileInspectWork(text = "") {
  const value = String(text || "");
  return /(?:\b(?:inspect|preview|stat)\b.{0,36}\b(?:file|metadata|info|path)\b|\b(?:file|metadata|info|path)\b.{0,36}\b(?:metadata|inspect|preview|stat|details?)\b|检查.{0,24}(?:文件|元数据|信息|路径)|预览.{0,24}(?:文件|内容)|查看.{0,24}(?:文件信息|文件元数据|文件属性))/i.test(value);
}

function textMentionsSpeechWork(text = "") {
  return /(?:text\s*to\s*speech|tts|synthesize.{0,16}speech|read.{0,16}aloud|\bnarrate\b|\bvoice\s*over\b|语音合成|文字转语音|朗读)/i.test(String(text || ""));
}

function textMentionsVideoWork(text = "") {
  const value = String(text || "");
  if (/\b(?:component|button|panel|page|docs?|workflow|plan|script|copy)\b/i.test(value)) {
    return false;
  }
  return /(?:generate|create|make|produce).{0,24}(?:video|clip|animation)|(?:生成|制作|做|创建).{0,24}(?:视频|动画|短片)/i.test(value);
}

function bridgeCapabilityToolFromProviders(providers = [], requestedScope = null) {
  const allowedCapabilities = requestedBridgeCapabilitySet(requestedScope);
  const allowedActions = requestedBridgeActionSet(requestedScope);
  const support = bridgeCapabilitySupportFromProviders(providers, allowedCapabilities, allowedActions);
  if (support.actions.length === 0) {
    return null;
  }
  const inputProperties = bridgeCapabilityInputProperties(support);
  return {
    type: "function",
    name: CODEXBRIDGE_CAPABILITY_TOOL_NAME,
    description:
      "Run a controlled CodexBridge capability through a local safe whitelist. " +
      "Supported actions are browser/read_url, browser/open_url, web_search/search, webpage_screenshot/screenshot_url, ocr/extract_text, file_processing/extract_text, file_processing/inspect_file, speech/synthesize, video/generate, computer_use/list_apps, computer_use/open_app, and computer_use/screenshot_desktop when providers are configured.",
    parameters: {
      type: "object",
      properties: {
        capability: {
          type: "string",
          enum: support.capabilities,
        },
        action: {
          type: "string",
          enum: support.actions,
        },
        input: {
          type: "object",
          properties: inputProperties,
        },
        providerId: {
          type: "string",
          description: "Optional CodexBridge capability provider id.",
        },
      },
      required: ["capability", "action", "input"],
    },
  };
}

function bridgeCapabilityInputProperties(support = {}) {
  const capabilities = new Set(asArray(support.capabilities));
  const actions = new Set(asArray(support.actions));
  const properties = {};
  if (
    (capabilities.has("browser") && (actions.has("read_url") || actions.has("open_url"))) ||
    (capabilities.has("webpage_screenshot") && actions.has("screenshot_url"))
  ) {
    properties.url = {
      type: "string",
      description: "The http or https URL to read, open, or capture. browser/read_url, browser/open_url, and webpage_screenshot/screenshot_url also accept safe bare domains, which CodexBridge normalizes to https.",
    };
  }
  if (capabilities.has("web_search") && actions.has("search")) {
    properties.query = {
      type: "string",
      description: "The search query to send to the configured web_search/search provider.",
    };
  }
  if (capabilities.has("ocr") && actions.has("extract_text")) {
    properties.imageUrl = {
      type: "string",
      description: "The http or https image URL to send to the configured ocr/extract_text provider. Safe bare domains are normalized to https.",
    };
  }
  const hasFileProcessingAction = capabilities.has("file_processing") &&
    (actions.has("extract_text") || actions.has("inspect_file"));
  if (hasFileProcessingAction && support.remoteFileProcessing && actions.has("extract_text")) {
    properties.fileUrl = {
      type: "string",
      description: "The http or https file URL to send to the configured file_processing/extract_text provider. Safe bare domains are normalized to https.",
    };
  }
  if (hasFileProcessingAction && support.localFileProcessing) {
    const fileActionLabel = actions.has("inspect_file") && !actions.has("extract_text")
      ? "file_processing/inspect_file"
      : "local_file file_processing provider";
    properties.path = {
      type: "string",
      description: `An explicit local file path for a ${fileActionLabel}. Use only when the current user request includes that local path; never send local paths to remote file providers.`,
    };
    properties.filePath = {
      type: "string",
      description: `Alias for path when using a ${fileActionLabel} with an explicit local file path.`,
    };
    properties.localPath = {
      type: "string",
      description: `Alias for path when using a ${fileActionLabel} with an explicit local file path.`,
    };
  }
  if (capabilities.has("speech") && actions.has("synthesize")) {
    properties.text = {
      type: "string",
      description: "The text to send to the configured speech/synthesize provider.",
    };
  }
  if (capabilities.has("video") && actions.has("generate")) {
    properties.prompt = {
      type: "string",
      description: "The prompt to send to the configured video/generate provider.",
    };
  }
  if (capabilities.has("computer_use") && actions.has("open_app")) {
    properties.app = {
      type: "string",
      description: "The allowlisted local app name for computer_use/open_app, such as notepad, calculator, or paint.",
    };
  }
  if (capabilities.has("computer_use") && actions.has("screenshot_desktop")) {
    properties.displayId = {
      type: "string",
      description: "Optional desktop display id for computer_use/screenshot_desktop.",
    };
  }
  return properties;
}

function bridgeCapabilitySupportFromProviders(providers = [], allowedCapabilities = null, allowedActions = null) {
  const definitions = [
    {
      capability: "browser",
      action: "read_url",
      supported: providerSupportsBridgeBrowserRead,
    },
    {
      capability: "browser",
      action: "open_url",
      supported: providerSupportsBridgeBrowserRead,
    },
    {
      capability: "web_search",
      action: "search",
      supported: providerSupportsBridgeWebSearch,
    },
    {
      capability: "webpage_screenshot",
      action: "screenshot_url",
      supported: providerSupportsBridgeWebpageScreenshot,
    },
    {
      capability: "ocr",
      action: "extract_text",
      supported: providerSupportsBridgeOcr,
    },
    {
      capability: "file_processing",
      action: "extract_text",
      supported: providerSupportsBridgeFileProcessing,
    },
    {
      capability: "file_processing",
      action: "inspect_file",
      supported: providerSupportsBridgeFileInspect,
    },
    {
      capability: "speech",
      action: "synthesize",
      supported: providerSupportsBridgeSpeech,
    },
    {
      capability: "video",
      action: "generate",
      supported: providerSupportsBridgeVideo,
    },
    {
      capability: "computer_use",
      action: "list_apps",
      supported: providerSupportsBridgeComputerUseOpenApp,
    },
    {
      capability: "computer_use",
      action: "open_app",
      supported: providerSupportsBridgeComputerUseOpenApp,
    },
    {
      capability: "computer_use",
      action: "screenshot_desktop",
      supported: providerSupportsBridgeComputerUseScreenshot,
    },
  ];
  const supported = definitions.filter((definition) => {
    if (allowedCapabilities?.size > 0 && !allowedCapabilities.has(definition.capability)) {
      return false;
    }
    if (allowedActions?.size > 0 && !allowedActions.has(definition.action)) {
      return false;
    }
    return asArray(providers).some((provider) => definition.supported(provider));
  });
  return {
    capabilities: uniqueBridgeCapabilityValues(supported.map((definition) => definition.capability)),
    actions: uniqueBridgeCapabilityValues(supported.map((definition) => definition.action)),
    localFileProcessing: asArray(providers).some(providerSupportsBridgeLocalFileProcessing),
    remoteFileProcessing: asArray(providers).some(providerSupportsBridgeRemoteFileProcessing),
  };
}

function requestedBridgeCapabilitySet(capabilities = null) {
  const values = Array.isArray(capabilities) ? capabilities : capabilities?.capabilities;
  if (!Array.isArray(values)) {
    return null;
  }
  return new Set(values.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean));
}

function requestedBridgeActionSet(scope = null) {
  const values = scope?.actions;
  if (!Array.isArray(values)) {
    return null;
  }
  return new Set(values.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean));
}

function providerSupportsBridgeBrowserRead(provider = {}) {
  if (!provider || typeof provider !== "object" || provider.enabled === false) {
    return false;
  }
  const adapter = String(provider.adapter || "").trim().toLowerCase();
  if (adapter !== "local_browser") {
    return false;
  }
  return providerBridgeCapabilities(provider).includes("browser");
}

function providerSupportsBridgeWebSearch(provider = {}) {
  if (!provider || typeof provider !== "object" || provider.enabled === false) {
    return false;
  }
  const adapter = String(provider.adapter || "generic_http").trim().toLowerCase();
  if (adapter !== "generic_http") {
    return false;
  }
  if (!providerHasBridgeCapability(provider, "web_search")) {
    return false;
  }
  const baseUrl = String(provider.baseUrl || "").trim();
  const endpoint = String(provider.endpoint || "").trim();
  return /^https?:\/\//i.test(baseUrl) && Boolean(endpoint);
}

function providerSupportsBridgeWebpageScreenshot(provider = {}) {
  if (!provider || typeof provider !== "object" || provider.enabled === false) {
    return false;
  }
  const adapter = String(provider.adapter || "generic_http").trim().toLowerCase();
  if (adapter === "local_browser") {
    return providerHasBridgeCapability(provider, "webpage_screenshot");
  }
  if (adapter !== "generic_http") {
    return false;
  }
  if (!providerHasBridgeCapability(provider, "webpage_screenshot")) {
    return false;
  }
  const baseUrl = String(provider.baseUrl || "").trim();
  const endpoint = String(provider.endpoint || "").trim();
  return /^https?:\/\//i.test(baseUrl) && Boolean(endpoint);
}

function providerSupportsBridgeOcr(provider = {}) {
  if (!provider || typeof provider !== "object" || provider.enabled === false) {
    return false;
  }
  const adapter = String(provider.adapter || "generic_http").trim().toLowerCase();
  if (adapter !== "generic_http") {
    return false;
  }
  if (!providerHasBridgeCapability(provider, "ocr")) {
    return false;
  }
  const baseUrl = String(provider.baseUrl || "").trim();
  const endpoint = String(provider.endpoint || "").trim();
  return /^https?:\/\//i.test(baseUrl) && Boolean(endpoint);
}

function providerSupportsBridgeFileProcessing(provider = {}) {
  if (!provider || typeof provider !== "object" || provider.enabled === false) {
    return false;
  }
  const adapter = String(provider.adapter || "generic_http").trim().toLowerCase();
  if (adapter === "local_file") {
    return providerSupportsBridgeLocalFileProcessing(provider);
  }
  if (adapter !== "generic_http") {
    return false;
  }
  return providerSupportsBridgeRemoteFileProcessing(provider);
}

function providerSupportsBridgeFileInspect(provider = {}) {
  return providerSupportsBridgeLocalFileProcessing(provider);
}

function providerSupportsBridgeLocalFileProcessing(provider = {}) {
  if (!provider || typeof provider !== "object" || provider.enabled === false) {
    return false;
  }
  const adapter = String(provider.adapter || "generic_http").trim().toLowerCase();
  return adapter === "local_file" && providerHasBridgeCapability(provider, "file_processing");
}

function providerSupportsBridgeRemoteFileProcessing(provider = {}) {
  if (!provider || typeof provider !== "object" || provider.enabled === false) {
    return false;
  }
  const adapter = String(provider.adapter || "generic_http").trim().toLowerCase();
  if (adapter !== "generic_http") {
    return false;
  }
  if (!providerHasBridgeCapability(provider, "file_processing")) {
    return false;
  }
  const baseUrl = String(provider.baseUrl || "").trim();
  const endpoint = String(provider.endpoint || "").trim();
  return /^https?:\/\//i.test(baseUrl) && Boolean(endpoint);
}

function providerSupportsBridgeSpeech(provider = {}) {
  if (!provider || typeof provider !== "object" || provider.enabled === false) {
    return false;
  }
  const adapter = String(provider.adapter || "generic_http").trim().toLowerCase();
  if (adapter !== "generic_http") {
    return false;
  }
  if (!providerHasBridgeCapability(provider, "speech")) {
    return false;
  }
  const baseUrl = String(provider.baseUrl || "").trim();
  const endpoint = String(provider.endpoint || "").trim();
  return /^https?:\/\//i.test(baseUrl) && Boolean(endpoint);
}

function providerSupportsBridgeVideo(provider = {}) {
  if (!provider || typeof provider !== "object" || provider.enabled === false) {
    return false;
  }
  const adapter = String(provider.adapter || "generic_http").trim().toLowerCase();
  if (adapter !== "generic_http") {
    return false;
  }
  if (!providerHasBridgeCapability(provider, "video")) {
    return false;
  }
  const baseUrl = String(provider.baseUrl || "").trim();
  const endpoint = String(provider.endpoint || "").trim();
  return /^https?:\/\//i.test(baseUrl) && Boolean(endpoint);
}

function providerSupportsBridgeComputerUseOpenApp(provider = {}) {
  if (!provider || typeof provider !== "object" || provider.enabled === false) {
    return false;
  }
  const adapter = String(provider.adapter || "").trim().toLowerCase();
  return adapter === "local_computer_use" && providerHasBridgeCapability(provider, "computer_use");
}

function providerSupportsBridgeComputerUseScreenshot(provider = {}) {
  return providerSupportsBridgeComputerUseOpenApp(provider);
}

function providerHasBridgeCapability(provider = {}, capability = "") {
  const target = String(capability || "").trim().toLowerCase();
  return providerBridgeCapabilities(provider).includes(target);
}

function providerBridgeCapabilities(provider = {}) {
  return [
    provider.capability,
    ...(Array.isArray(provider.capabilities) ? provider.capabilities : []),
    ...(Array.isArray(provider.supports) ? provider.supports : []),
  ]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
}

function uniqueBridgeCapabilityValues(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function requestHasResponseToolOutput(request = {}) {
  return chatRequestInputItems(request.messages ?? request.input).some(
    isResponseToolOutputItem,
  );
}

function chatRequestInputItems(input) {
  if (input === undefined || input === null) {
    return [];
  }
  return Array.isArray(input) ? input : [input];
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

function requestMentionsCommandWork(request = {}) {
  const text = requestCurrentUserText(request);
  return /git|github|push|publish|commit|test|run tests|推送|发布|提交|测试|运行测试/i.test(text);
}

function requestCurrentUserText(request = {}) {
  return currentInputText(request.input ?? request.messages);
}

function requestMentionsGitHubRepositoryInspection(request = {}) {
  return textMentionsGitHubRepositoryInspection(requestCurrentUserText(request));
}

function textMentionsGitHubRepositoryInspection(text = "") {
  const value = String(text || "");
  if (!/github|repository|repo|仓库/i.test(value)) {
    return false;
  }
  return /(?:https?:\/\/github\.com\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/.test(value);
}

function currentInputText(input) {
  if (input === undefined || input === null) {
    return "";
  }
  if (typeof input === "string") {
    return input;
  }
  if (Array.isArray(input)) {
    for (let index = input.length - 1; index >= 0; index -= 1) {
      const item = input[index];
      if (
        item &&
        typeof item === "object" &&
        ["system", "developer"].includes(item.role)
      ) {
        continue;
      }
      return currentInputText(item);
    }
    return "";
  }
  if (typeof input !== "object") {
    return "";
  }
  if (isResponseToolOutputItem(input) || isResponseToolCallItem(input)) {
    return "";
  }
  const role = normalizeRole(input.role || roleFromType(input.type));
  if (role && role !== "user") {
    return "";
  }
  return requestInputText(input);
}

function requestInputText(input) {
  if (input === undefined || input === null) {
    return "";
  }
  if (typeof input === "string") {
    return input;
  }
  if (Array.isArray(input)) {
    return input.map(requestInputText).join("\n");
  }
  if (typeof input === "object") {
    if (typeof input.text === "string") {
      return input.text;
    }
    if (typeof input.content === "string") {
      return input.content;
    }
    if (Array.isArray(input.content)) {
      return input.content.map(requestInputText).join("\n");
    }
  }
  return "";
}

function roleFromType(type) {
  if (type === "message") {
    return "user";
  }
  return null;
}

function normalizeRole(role) {
  if (role === "developer") {
    return "system";
  }
  if (["system", "user", "assistant", "tool"].includes(role)) {
    return role;
  }
  return null;
}

function chatToolChoice(toolChoice, toolContext, request = {}) {
  if (!toolChoice) {
    return preferredToolChoiceForRequest(toolContext, request) || "auto";
  }
  if (typeof toolChoice === "string") {
    return toolChoice;
  }
  const name = toolChoice.name || toolChoice.function?.name;
  if (!name) {
    return "auto";
  }
  const responseName = namespacedToolName(
    name,
    toolChoice.namespace || toolChoice.function?.namespace,
  );
  const chatName = toolContext.responseNameToChatName.get(responseName) || responseName;
  if (!toolContext.chatToolNames.has(chatName)) {
    return "auto";
  }
  return { type: "function", function: { name: chatName } };
}

function preferredToolChoiceForRequest(toolContext, request = {}) {
  const interactiveKind = interactivePluginKindForRequest(request);
  if (!interactiveKind) {
    return null;
  }
  if (interactiveKind === "chrome") {
    const controlledBrowserName = controlledBrowserCapabilityChatName(toolContext);
    if (controlledBrowserName) {
      return { type: "function", function: { name: controlledBrowserName } };
    }
  }
  if (interactiveKind === "computer") {
    const controlledComputerName = controlledComputerCapabilityChatName(toolContext);
    if (controlledComputerName) {
      return { type: "function", function: { name: controlledComputerName } };
    }
  }
  const nodeReplChatName = chatNameForTool(toolContext, "mcp__node_repl__js");
  if (nodeReplChatName) {
    return { type: "function", function: { name: nodeReplChatName } };
  }
  const commandChatName = commandChatNameForToolContext(toolContext);
  if (commandChatName) {
    return { type: "function", function: { name: commandChatName } };
  }
  return null;
}

function controlledBrowserCapabilityChatName(toolContext) {
  const bridgeName = chatNameForTool(toolContext, CODEXBRIDGE_CAPABILITY_TOOL_NAME);
  if (!bridgeName) {
    return "";
  }
  const bridgeTool = toolContext.chatTools.find((tool) =>
    tool?.function?.name === bridgeName ||
      toolContext.responseNameToChatName.get(CODEXBRIDGE_CAPABILITY_TOOL_NAME) === tool?.function?.name
  );
  if (!bridgeToolSupportsEnum(bridgeTool, "capability", "browser")) {
    return "";
  }
  if (!bridgeToolSupportsEnum(bridgeTool, "action", "open_url")) {
    return "";
  }
  return bridgeName;
}

function controlledComputerCapabilityChatName(toolContext) {
  const bridgeName = chatNameForTool(toolContext, CODEXBRIDGE_CAPABILITY_TOOL_NAME);
  if (!bridgeName) {
    return "";
  }
  const bridgeTool = toolContext.chatTools.find((tool) =>
    tool?.function?.name === bridgeName ||
      toolContext.responseNameToChatName.get(CODEXBRIDGE_CAPABILITY_TOOL_NAME) === tool?.function?.name
  );
  if (!bridgeToolSupportsEnum(bridgeTool, "capability", "computer_use")) {
    return "";
  }
  if (
    !bridgeToolSupportsEnum(bridgeTool, "action", "list_apps") &&
    !bridgeToolSupportsEnum(bridgeTool, "action", "open_app") &&
    !bridgeToolSupportsEnum(bridgeTool, "action", "screenshot_desktop")
  ) {
    return "";
  }
  return bridgeName;
}

function bridgeToolSupportsEnum(tool, propertyName, expectedValue) {
  const values = tool?.function?.parameters?.properties?.[propertyName]?.enum;
  return Array.isArray(values) && values.includes(expectedValue);
}

function commandChatNameForToolContext(toolContext) {
  for (const name of toolContext?.chatToolNames || []) {
    if (isCommandToolName(name)) {
      return name;
    }
  }
  return "";
}

export function interactiveNodeReplToolNameForRequest(toolContext, request = {}) {
  if (!interactivePluginKindForRequest(request)) {
    return "";
  }
  return chatNameForTool(toolContext, "mcp__node_repl__js");
}

function chatNameForTool(toolContext, responseName) {
  const mapped = toolContext.responseNameToChatName.get(responseName);
  if (mapped) {
    return mapped;
  }
  const hasExactTool = toolContext.chatTools.some(
    (tool) => tool?.function?.name === responseName,
  );
  return hasExactTool ? responseName : "";
}

function requestMentionsInteractivePluginWork(request = {}) {
  return Boolean(interactivePluginKindForRequest(request));
}

export function interactivePluginKindForRequest(request = {}) {
  const text = requestCurrentUserText(request);
  if (textMentionsGitHubRepositoryInspection(text)) {
    return "chrome";
  }
  if (/@chrome\b|control[-_\s]?chrome|chrome\s*:/i.test(text)) {
    return "chrome";
  }
  if (/computer\s*use|@computer\b|电脑操控|控制电脑/i.test(text)) {
    return "computer";
  }
  const actionPattern =
    /打开|启动|访问|搜索|点击|关闭|切换|控制|操作|截图|输入|填写|播放|暂停|导航|写入|写个|写一段|画|open|launch|visit|search|click|close|switch|control|operate|screenshot|type|fill|play|navigate/i;
  if (!actionPattern.test(text)) {
    return "";
  }
  const computerTargetPattern =
    /电脑|桌面|窗口|notepad|记事本|画图|mspaint|应用|软件/i;
  if (computerTargetPattern.test(text)) {
    return "computer";
  }
  const chromeTargetPattern =
    /chrome|browser|谷歌浏览器|浏览器|youtube|网页|网站/i;
  if (chromeTargetPattern.test(text)) {
    return "chrome";
  }
  return "";
}

function sanitizeMessagesForRoute(messages, route = {}) {
  const preserveNativeHistory = routeUsesStatelessDeepSeekResponses(route);
  const preserveReasoningContent = routeSupportsReasoningContent(route);
  const preserveAnthropicThinking = route.api === "anthropic_messages";
  const preserveResponsesPhase = route.api === "responses";
  return messages
    .map((message) => {
      if (!message || typeof message !== "object") {
        return message;
      }
      let next = preserveNativeHistory
        ? message
        : withoutNativeResponsesHistoryItems(message);
      if (!preserveReasoningContent && "reasoning_content" in next) {
        const { reasoning_content: _reasoningContent, ...rest } = next;
        next = rest;
      }
      if (!preserveAnthropicThinking && "anthropic_thinking" in next) {
        const { anthropic_thinking: _anthropicThinking, ...rest } = next;
        next = rest;
      }
      if (!preserveResponsesPhase && "responses_phase" in next) {
        const { responses_phase: _responsesPhase, ...rest } = next;
        next = rest;
      }
      if (
        !preserveNativeHistory &&
        hasNativeResponsesHistoryItems(message) &&
        next.role === "assistant" &&
        !messageHasContent(next) &&
        !hasToolCalls(next)
      ) {
        return null;
      }
      return next;
    })
    .filter(Boolean);
}

function routeSupportsReasoningContent(route = {}) {
  const provider = String(route.provider || route.providerId || "").toLowerCase();
  const model = String(route.model || route.id || "").toLowerCase();
  if (
    (provider.includes("kimi") || provider.includes("moonshot")) &&
    /^kimi-k2\.[67]/i.test(model)
  ) {
    return true;
  }
  if (provider.includes("deepseek") && /deepseek-v4/i.test(model)) {
    return true;
  }
  try {
    const hostname = new URL(route.baseUrl || "").hostname.toLowerCase();
    if (hostname.includes("moonshot") && /^kimi-k2\.[67]/i.test(model)) {
      return true;
    }
    return hostname.includes("deepseek") && /deepseek-v4/i.test(model);
  } catch {
    return false;
  }
}

function shouldDrop(route, param) {
  return Array.isArray(route.dropParams) && route.dropParams.includes(param);
}

function applyPromptCacheHints(body, route = {}) {
  if (!shouldInjectChatCacheControl(route)) {
    return;
  }
  let breakpoints = 0;
  const mark = (target) => {
    if (breakpoints >= MAX_PROMPT_CACHE_BREAKPOINTS || !target) {
      return false;
    }
    if (markCacheTarget(target)) {
      breakpoints += 1;
      return true;
    }
    return false;
  };

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    mark(body.tools.at(-1));
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemIndex = findLastIndex(messages, (message) => message?.role === "system");
  if (systemIndex >= 0) {
    mark(messages[systemIndex]);
  }

  const latestConversationIndex = findLastIndex(
    messages,
    (message) => message?.role !== "system",
  );
  for (let index = latestConversationIndex - 1; index >= 0; index -= 1) {
    if (breakpoints >= MAX_PROMPT_CACHE_BREAKPOINTS) {
      break;
    }
    if (isCacheableHistoryMessage(messages[index])) {
      mark(messages[index]);
    }
  }
}

function shouldInjectChatCacheControl(route = {}) {
  const profile = normalizeAdapterProfile(route);
  if (profile.api !== "chat_completions") {
    return false;
  }
  const mode = String(profile.capabilities?.promptCache || "").toLowerCase();
  return ["cache_control", "cache-control", "anthropic", "anthropic-ephemeral", "ephemeral"].includes(mode);
}

function markCacheTarget(target) {
  if (!target || typeof target !== "object" || target.cache_control) {
    return false;
  }
  if (target.function) {
    target.cache_control = { ...CHAT_PROMPT_CACHE_CONTROL };
    return true;
  }
  if (canMarkMessageContent(target)) {
    const nextContent = contentWithCacheControl(target.content);
    if (nextContent !== target.content) {
      target.content = nextContent;
      return true;
    }
  }
  if (isCacheableHistoryMessage(target)) {
    target.cache_control = { ...CHAT_PROMPT_CACHE_CONTROL };
    return true;
  }
  return false;
}

function canMarkMessageContent(message) {
  return (
    message?.role === "system" &&
    message.content !== undefined &&
    !message.reasoning_content
  );
}

function contentWithCacheControl(content) {
  if (typeof content === "string") {
    return [
      {
        type: "text",
        text: content,
        cache_control: { ...CHAT_PROMPT_CACHE_CONTROL },
      },
    ];
  }
  if (!Array.isArray(content)) {
    return content;
  }
  const result = content.map((part) =>
    part && typeof part === "object" ? { ...part } : part,
  );
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const part = result[index];
    if (isCacheableContentPart(part)) {
      result[index] = {
        ...part,
        cache_control: { ...CHAT_PROMPT_CACHE_CONTROL },
      };
      return result;
    }
  }
  return content;
}

function isCacheableContentPart(part) {
  if (!part || typeof part !== "object" || part.cache_control) {
    return false;
  }
  const type = String(part.type || "").toLowerCase();
  return (
    (!type || type === "text" || type === "input_text") &&
    !["reasoning", "thinking", "reasoning_content"].includes(type)
  );
}

function isCacheableHistoryMessage(message) {
  return (
    message &&
    typeof message === "object" &&
    (message.role === "user" || message.role === "assistant") &&
    !message.reasoning_content &&
    !Array.isArray(message.tool_calls) &&
    message.content !== undefined &&
    !containsReasoningContentPart(message.content) &&
    !message.cache_control
  );
}

function containsReasoningContentPart(content) {
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((part) => {
    const type = String(part?.type || "").toLowerCase();
    return ["reasoning", "thinking", "reasoning_content"].includes(type);
  });
}

function findLastIndex(items, predicate) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index], index)) {
      return index;
    }
  }
  return -1;
}

function copyScalar(source, target, key) {
  if (source[key] !== undefined) {
    target[key] = source[key];
  }
}

function shouldRequestSeparatedReasoning(route = {}) {
  if (route.provider === "minimax") {
    return true;
  }
  if (/^minimax-/i.test(route.model || "")) {
    return true;
  }
  try {
    const hostname = new URL(route.baseUrl || "").hostname.toLowerCase();
    return hostname.includes("minimaxi.com") || hostname.includes("minimax.io");
  } catch {
    return false;
  }
}

function shouldFlattenToolCallHistory(route = {}) {
  const provider = String(route.provider || route.providerId || "").toLowerCase();
  if (provider.includes("gemini") || provider.includes("google")) {
    return true;
  }
  const model = String(route.model || "").toLowerCase();
  if (model.startsWith("gemini-") || model.includes("/gemini-")) {
    return true;
  }
  try {
    const hostname = new URL(route.baseUrl || "").hostname.toLowerCase();
    return (
      hostname.includes("generativelanguage.googleapis.com") ||
      hostname.includes("aiplatform.googleapis.com")
    );
  } catch {
    return false;
  }
}

export function trimMessagesToRouteContext(messages, route = {}, options = {}) {
  const maxTokens = options.contextPolicy?.inputBudget || maxChatContextInputTokens(route);
  if (!maxTokens || estimatedMessagesTokens(messages) <= maxTokens) {
    return messages;
  }

  let systemMessages = [];
  const conversationMessages = [];
  for (const message of messages) {
    if (message?.role === "system") {
      systemMessages.push(message);
    } else {
      conversationMessages.push(message);
    }
  }

  const trimNotice = {
    role: "system",
    content:
      "Earlier conversation history was omitted by CodexBridge to fit the upstream model context window.",
  };
  const latestFallbackTokens = Math.min(
    maxTokens,
    Math.max(128, Math.floor(maxTokens * 0.25)),
  );
  const noticeTokens = estimatedMessageTokens(trimNotice);
  const systemBudget = Math.max(0, maxTokens - noticeTokens - latestFallbackTokens);
  const originalSystemTokens = estimatedMessagesTokens(systemMessages);
  systemMessages = trimSystemMessagesToTokens(systemMessages, systemBudget);
  const systemTrimmed = estimatedMessagesTokens(systemMessages) < originalSystemTokens;

  const preserved = [];
  let usedTokens = estimatedMessagesTokens(systemMessages) + noticeTokens;

  for (let index = conversationMessages.length - 1; index >= 0; index -= 1) {
    const message = conversationMessages[index];
    const messageTokens = estimatedMessageTokens(message);
    const remaining = maxTokens - usedTokens;

    if (remaining <= 0) {
      if (preserved.length === 0 && index === conversationMessages.length - 1) {
        const keptMessage = trimMessageContentToTokens(message, latestFallbackTokens);
        preserved.push(keptMessage);
        usedTokens += estimatedMessageTokens(keptMessage);
      }
      continue;
    }

    if (messageTokens <= remaining || preserved.length === 0) {
      const keptMessage =
        messageTokens <= remaining
          ? message
          : trimMessageContentToTokens(message, remaining);
      preserved.push(keptMessage);
      usedTokens += estimatedMessageTokens(keptMessage);
    }
  }

  const trimmed = systemTrimmed || preserved.length < conversationMessages.length;
  const result = [
    ...systemMessages,
    ...(trimmed ? [trimNotice] : []),
    ...preserved.reverse(),
  ];
  return normalizeToolCallPairs(result, {
    flattenToolCalls: shouldFlattenToolCallHistory(route),
  });
}

function maxChatContextInputTokens(route = {}) {
  return chatContextPolicyForRoute(route).inputBudget;
}

function chatContextPolicyForRoute(route = {}) {
  return contextPolicyForRoute(route, {
    defaultContextWindow: 258400,
  });
}

export function estimatedMessagesTokens(messages) {
  return messages.reduce(
    (total, message) => total + estimatedMessageTokens(message),
    0,
  );
}

export function preservedToolBoundaryCount(messages = []) {
  const outputIds = new Set(
    (Array.isArray(messages) ? messages : [])
      .filter((message) => message?.role === "tool" && message.tool_call_id)
      .map((message) => String(message.tool_call_id)),
  );
  let count = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) {
      continue;
    }
    count += message.tool_calls.filter((toolCall) =>
      outputIds.has(String(toolCall?.id || toolCall?.call_id || ""))
    ).length;
  }
  return count;
}

function estimatedMessageTokens(message) {
  if (!message || typeof message !== "object") {
    return estimatedValueTokens(message);
  }
  let tokens = 8 + estimatedTextTokens(message.role || "");
  tokens += estimatedValueTokens(message.content);
  if (Array.isArray(message.tool_calls)) {
    tokens += estimatedValueTokens(message.tool_calls);
  }
  if (message.tool_call_id) {
    tokens += estimatedTextTokens(message.tool_call_id) + 4;
  }
  return tokens;
}

function estimatedValueTokens(value) {
  if (value === undefined || value === null) {
    return 0;
  }
  if (typeof value === "string") {
    return estimatedTextTokens(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return 1;
  }
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + estimatedValueTokens(item) + 2, 4);
  }
  if (typeof value === "object") {
    return Object.entries(value).reduce(
      (total, [key, entryValue]) =>
        total + estimatedTextTokens(key) + estimatedValueTokens(entryValue) + 3,
      6,
    );
  }
  return estimatedTextTokens(String(value));
}

function estimatedTextTokens(value) {
  const text = String(value || "");
  if (!text) {
    return 0;
  }
  let ascii = 0;
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    if (isCjkCodePoint(code)) {
      cjk += 1;
    } else if (code <= 0x7f) {
      ascii += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(ascii / 4) + cjk + Math.ceil(other / 2);
}

function isCjkCodePoint(code) {
  return (
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

function trimSystemMessagesToTokens(messages, maxTokens) {
  if (estimatedMessagesTokens(messages) <= maxTokens) {
    return messages;
  }

  const preserved = [];
  let usedTokens = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const messageTokens = estimatedMessageTokens(message);
    const remaining = maxTokens - usedTokens;
    if (remaining <= 0) {
      break;
    }
    if (messageTokens <= remaining || preserved.length === 0) {
      const keptMessage =
        messageTokens <= remaining
          ? message
          : trimMessageContentToTokens(message, remaining);
      preserved.push(keptMessage);
      usedTokens += estimatedMessageTokens(keptMessage);
    }
  }
  return preserved.reverse();
}

function trimMessageContentToTokens(message, maxTokens) {
  const trimmed = { ...message };
  delete trimmed.tool_calls;
  trimmed.content = trimTextForContextTokens(
    contentToText(message?.content),
    Math.max(0, maxTokens - 12),
  );
  if (message?.role === "assistant" && !trimmed.content) {
    trimmed.content = "[assistant message omitted to fit context]";
  }
  return trimmed;
}

function trimTextForContextTokens(text, maxTokens) {
  const value = String(text || "");
  if (estimatedTextTokens(value) <= maxTokens) {
    return value;
  }
  const marker = "[message truncated to fit context]\n";
  if (maxTokens <= estimatedTextTokens(marker) + 1) {
    return "[message omitted to fit context]";
  }

  let low = 0;
  let high = value.length;
  let best = "";
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = `${marker}${value.slice(-mid)}`;
    if (estimatedTextTokens(candidate) <= maxTokens) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best || "[message omitted to fit context]";
}

function normalizeToolCallPairs(messages, options = {}) {
  const normalized = [];
  const flattenToolCalls = Boolean(options.flattenToolCalls);

  for (let index = 0; index < messages.length;) {
    const message = messages[index];
    if (hasToolCalls(message)) {
      const expectedIds = new Set(
        message.tool_calls
          .map((toolCall) => toolCall?.id)
          .filter(Boolean),
      );
      const toolMessages = [];
      let nextIndex = index + 1;
      while (nextIndex < messages.length && messages[nextIndex]?.role === "tool") {
        toolMessages.push(messages[nextIndex]);
        nextIndex += 1;
      }

      const actualIds = new Set(
        toolMessages
          .map((toolMessage) => toolMessage.tool_call_id)
          .filter(Boolean),
      );
      const matchedToolMessages = [];
      const extraToolMessages = [];
      const matchedIds = new Set();
      for (const toolMessage of toolMessages) {
        const toolCallId = toolMessage?.tool_call_id;
        if (toolCallId && expectedIds.has(toolCallId) && !matchedIds.has(toolCallId)) {
          matchedToolMessages.push(toolMessage);
          matchedIds.add(toolCallId);
        } else {
          extraToolMessages.push(toolMessage);
        }
      }
      const complete =
        expectedIds.size > 0 &&
        [...expectedIds].every((toolCallId) => actualIds.has(toolCallId));

      if (complete && flattenToolCalls) {
        normalized.push(...flattenToolCallPairAsText(message, matchedToolMessages));
        const extraToolOutput = orphanToolOutputsMessage(extraToolMessages);
        if (extraToolOutput) {
          normalized.push(extraToolOutput);
        }
      } else if (complete) {
        normalized.push(message, ...matchedToolMessages);
        const extraToolOutput = orphanToolOutputsMessage(extraToolMessages);
        if (extraToolOutput) {
          normalized.push(extraToolOutput);
        }
      } else {
        const textOnly = assistantTextOnlyMessage(message);
        if (textOnly) {
          normalized.push(textOnly);
        }
        const orphanToolOutput = orphanToolOutputsMessage(toolMessages);
        if (orphanToolOutput) {
          normalized.push(orphanToolOutput);
        }
      }
      index = nextIndex;
      continue;
    }

    if (message?.role === "tool") {
      const orphanToolMessages = [];
      let nextIndex = index;
      while (nextIndex < messages.length && messages[nextIndex]?.role === "tool") {
        orphanToolMessages.push(messages[nextIndex]);
        nextIndex += 1;
      }
      const orphanToolOutput = orphanToolOutputsMessage(orphanToolMessages);
      if (orphanToolOutput) {
        normalized.push(orphanToolOutput);
      }
      index = nextIndex;
      continue;
    } else {
      normalized.push(message);
    }
    index += 1;
  }

  return normalized;
}

function flattenToolCallPairAsText(message, toolMessages) {
  const flattened = [];
  const assistantText = contentToText(message.content);
  if (assistantText) {
    flattened.push({
      role: "assistant",
      content: assistantText,
    });
  }

  const toolResults = [];
  for (const toolMessage of toolMessages) {
    const output = contentToText(toolMessage.content);
    const id = toolMessage?.tool_call_id ? ` ${toolMessage.tool_call_id}` : "";
    toolResults.push(`Result${id}:\n${output || "[empty output]"}`);
  }
  if (toolResults.length > 0) {
    flattened.push({
      role: "system",
      content: `${TOOL_RESULT_CONTEXT_HEADER}\n\n${toolResults.join("\n\n")}`,
    });
  }
  return flattened;
}

function hasToolCalls(message) {
  return (
    message?.role === "assistant" &&
    Array.isArray(message.tool_calls) &&
    message.tool_calls.length > 0
  );
}

function assistantTextOnlyMessage(message) {
  if (!messageHasContent(message)) {
    return null;
  }
  const { tool_calls, ...textOnly } = message;
  return textOnly;
}

function orphanToolOutputsMessage(messages) {
  const toolResults = [];
  for (const message of messages) {
    const content = contentToText(message?.content);
    if (!content) {
      continue;
    }
    const id = message?.tool_call_id ? ` ${message.tool_call_id}` : "";
    toolResults.push(`Result${id}:\n${content}`);
  }
  if (toolResults.length === 0) {
    return null;
  }
  return {
    role: "system",
    content: `${TOOL_RESULT_CONTEXT_HEADER}\n\n${toolResults.join("\n\n")}`,
  };
}

function messageHasContent(message) {
  if (typeof message?.content === "string") {
    return message.content.trim().length > 0;
  }
  if (Array.isArray(message?.content)) {
    return message.content.length > 0;
  }
  return Boolean(message?.content);
}
