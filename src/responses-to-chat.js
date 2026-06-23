import { asArray, stringifyJson } from "./json.js";
import {
  buildToolContext,
  chatMessageFromToolOutput,
  chatToolCallFromResponseItem,
  isResponseToolCallItem,
  isResponseToolOutputItem,
  namespacedToolName,
} from "./tools.js";

const MAX_CHAT_DATA_IMAGE_URL_CHARS = 2_000_000;
const CHAT_CONTEXT_INPUT_PERCENT = 65;
const MIN_CHAT_CONTEXT_INPUT_TOKENS = 128;
const OVERSIZED_IMAGE_PLACEHOLDER =
  "[image input omitted because it is too large for this chat provider]";
const MCP_TOOL_GUIDANCE =
  "CodexBridge tool guidance: MCP namespace tools are exposed as flattened function names. " +
  "If a Codex skill mentions the Node REPL js tool, call mcp__node_repl__js directly and run the plugin bootstrap through that tool; " +
  "empty MCP resource/resource-template lists do not mean the tool is unavailable. " +
  "For Chrome, Browser, and Computer Use tasks, the official Chrome/Computer Use plugin path is the Node REPL bootstrap path. " +
  "For Chrome, follow the skill path that imports scripts/browser-client.mjs through mcp__node_repl__js. " +
  "For Computer Use, follow the skill path that imports scripts/computer-use-client.mjs through mcp__node_repl__js; do not import @oai/sky directly. " +
  "Do not claim Node REPL is unavailable while mcp__node_repl__js is listed, and do not use shell or PowerShell fallbacks unless that tool is absent or the user explicitly asks for a manual fallback.";
const COMMAND_TOOL_GUIDANCE =
  "CodexBridge command guidance: when the user explicitly asks you to run tests, commit, push, or publish " +
  "and a command or shell tool is available, call that tool and report the exact command output. " +
  "For git push, inspect git status and remotes if needed, then run git push with the configured remote. " +
  "Do not claim network, GitHub, sandbox, or approval is unavailable unless an attempted command returns that error.";

export function responsesToChatRequest(request, route, history) {
  const { messages: sourceMessages, toolContext } =
    responseRequestToChatSourceMessages(request, route, history);
  const normalizedMessages = trimMessagesToRouteContext(sourceMessages, route);

  const body = {
    model: route.model,
    messages: normalizedMessages,
    stream: false,
  };
  if (shouldRequestSeparatedReasoning(route)) {
    body.reasoning_split = true;
  }

  if (toolContext.chatTools.length > 0) {
    body.tools = toolContext.chatTools;
    const toolChoice = chatToolChoice(request.tool_choice, toolContext, request);
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

  return {
    body,
    toolContext,
    wantsStream: Boolean(request.stream),
    messagesForHistory: sourceMessages,
  };
}

export function responseRequestToChatSourceMessages(request, route, history) {
  const toolContext = buildToolContext(request.tools || [], { route });
  const priorMessages = history?.get?.(request.previous_response_id) || [];
  const currentMessages = responseInputToChatMessages(
    request.messages ?? request.input,
    toolContext,
  );

  const messages = [];
  const instructions = systemInstructionsFromRequest(request);
  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }
  const toolGuidance = toolGuidanceFromContext(toolContext, request);
  if (toolGuidance) {
    messages.push({ role: "system", content: toolGuidance });
  }
  messages.push(...priorMessages, ...currentMessages);
  const sourceMessages = normalizeToolCallPairs(messages, {
    flattenToolCalls: shouldFlattenToolCallHistory(route),
  });
  return { messages: sourceMessages, toolContext };
}

export function responseInputToChatMessages(input, toolContext) {
  if (input === undefined || input === null) {
    return [];
  }
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }

  const items = Array.isArray(input) ? input : [input];
  const messages = [];
  let pendingToolCalls = [];

  const flushToolCalls = () => {
    if (pendingToolCalls.length === 0) {
      return;
    }
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: pendingToolCalls,
    });
    pendingToolCalls = [];
  };

  for (const item of items) {
    if (isResponseToolCallItem(item)) {
      pendingToolCalls.push(chatToolCallFromResponseItem(item, toolContext));
      continue;
    }

    flushToolCalls();

    if (
      item &&
      typeof item === "object" &&
      ["system", "developer"].includes(item.role)
    ) {
      continue;
    }

    if (isResponseToolOutputItem(item)) {
      messages.push(chatMessageFromToolOutput(item));
      continue;
    }

    const message = responseMessageToChatMessage(item);
    if (message) {
      messages.push(message);
    }
  }

  flushToolCalls();
  return messages;
}

export function responseMessageToChatMessage(item) {
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
    content: contentToChatContent(item.content ?? item.text ?? item.output ?? ""),
  };

  if (Array.isArray(item.tool_calls)) {
    message.tool_calls = item.tool_calls;
    if (!message.content) {
      message.content = null;
    }
  }

  return message;
}

export function contentToChatContent(content) {
  if (content === undefined || content === null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    const imagePart = imagePartToChat(content);
    if (imagePart) {
      return [imagePart];
    }
    return contentToText(content);
  }

  const textParts = [];
  const chatParts = [];
  let hasImage = false;

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

    const imagePart = imagePartToChat(part);
    if (imagePart) {
      hasImage = true;
      chatParts.push(imagePart);
      continue;
    }

    const text = textFromContentPart(part);
    if (text) {
      textParts.push(text);
      chatParts.push({ type: "text", text });
      continue;
    }

    if (isFilePart(part)) {
      const placeholder = `[file input not forwarded to chat provider: ${filePartName(part)}]`;
      textParts.push(placeholder);
      chatParts.push({ type: "text", text: placeholder });
      continue;
    }

    if (part.type && Object.keys(part).length > 0) {
      const json = stringifyJson(part);
      textParts.push(json);
      chatParts.push({ type: "text", text: json });
    }
  }

  if (hasImage) {
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
    if (isFilePart(content)) {
      return `[file input not forwarded to chat provider: ${filePartName(content)}]`;
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
    } else if (isFilePart(part)) {
      parts.push(`[file input not forwarded to chat provider: ${filePartName(part)}]`);
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

function imagePartToChat(part) {
  if (!isImagePart(part)) {
    return null;
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
    "unnamed file"
  );
}

function systemInstructionsFromRequest(request) {
  const parts = [];
  if (typeof request.instructions === "string" && request.instructions.trim()) {
    parts.push(request.instructions.trim());
  }
  for (const message of asArray(request.input)) {
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
  const needsCommandGuidance =
    names.some(isCommandToolName) && requestMentionsCommandWork(request);
  return [
    needsGuidance ? MCP_TOOL_GUIDANCE : "",
    needsCommandGuidance ? COMMAND_TOOL_GUIDANCE : "",
  ]
    .filter(Boolean)
    .join(" ");
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
  const text = `${request.instructions || ""}\n${requestInputText(request.input ?? request.messages)}`;
  return /git|github|push|publish|commit|test|run tests|推送|发布|提交|测试|运行测试/i.test(text);
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
  return { type: "function", function: { name: chatName } };
}

function preferredToolChoiceForRequest(toolContext, request = {}) {
  if (!requestMentionsInteractivePluginWork(request)) {
    return null;
  }
  const nodeReplChatName = chatNameForTool(toolContext, "mcp__node_repl__js");
  if (!nodeReplChatName) {
    return null;
  }
  return { type: "function", function: { name: nodeReplChatName } };
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
  const text = `${request.instructions || ""}\n${requestInputText(request.input ?? request.messages)}`;
  if (/@chrome\b|computer\s*use|电脑操控|控制电脑/i.test(text)) {
    return true;
  }
  const actionPattern =
    /打开|启动|访问|搜索|点击|关闭|切换|控制|操作|截图|输入|填写|播放|暂停|导航|open|launch|visit|search|click|close|switch|control|operate|screenshot|type|fill|play|navigate/i;
  const targetPattern =
    /chrome|browser|谷歌浏览器|浏览器|youtube|网页|网站|电脑|桌面|窗口|notepad|记事本|画图|mspaint|应用|软件/i;
  return actionPattern.test(text) && targetPattern.test(text);
}

function shouldDrop(route, param) {
  return Array.isArray(route.dropParams) && route.dropParams.includes(param);
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

function trimMessagesToRouteContext(messages, route = {}) {
  const maxTokens = maxChatContextInputTokens(route);
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
  return normalizeToolCallPairs(result);
}

function maxChatContextInputTokens(route = {}) {
  const contextWindow = Number(route.contextWindow || 0);
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return 0;
  }
  const inputTokens = Math.floor(contextWindow * (CHAT_CONTEXT_INPUT_PERCENT / 100));
  return Math.max(MIN_CHAT_CONTEXT_INPUT_TOKENS, inputTokens);
}

function estimatedMessagesTokens(messages) {
  return messages.reduce(
    (total, message) => total + estimatedMessageTokens(message),
    0,
  );
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
      const complete =
        expectedIds.size > 0 &&
        [...expectedIds].every((toolCallId) => actualIds.has(toolCallId));

      if (complete && flattenToolCalls) {
        normalized.push(...flattenToolCallPairAsText(message, toolMessages));
      } else if (complete) {
        normalized.push(message, ...toolMessages);
      } else {
        const textOnly = assistantTextOnlyMessage(message);
        if (textOnly) {
          normalized.push(textOnly);
        }
      }
      index = nextIndex;
      continue;
    }

    if (message?.role === "tool") {
      const orphanToolOutput = orphanToolOutputMessage(message);
      if (orphanToolOutput) {
        normalized.push(orphanToolOutput);
      }
    } else {
      normalized.push(message);
    }
    index += 1;
  }

  return normalized;
}

function flattenToolCallPairAsText(message, toolMessages) {
  const flattened = [];
  const toolCallText = toolCallsToText(message.tool_calls);
  const assistantText = [contentToText(message.content), toolCallText]
    .filter(Boolean)
    .join("\n\n");
  if (assistantText) {
    flattened.push({
      role: "assistant",
      content: assistantText,
    });
  }

  for (const toolMessage of toolMessages) {
    const output = contentToText(toolMessage.content);
    const id = toolMessage?.tool_call_id ? ` ${toolMessage.tool_call_id}` : "";
    flattened.push({
      role: "user",
      content: `[Tool output${id}]\n${output || "[empty output]"}`,
    });
  }
  return flattened;
}

function toolCallsToText(toolCalls) {
  const lines = [];
  for (const toolCall of toolCalls || []) {
    const name = toolCall?.function?.name || toolCall?.name || "tool";
    const args = toolCall?.function?.arguments ?? toolCall?.arguments ?? "{}";
    const id = toolCall?.id ? ` ${toolCall.id}` : "";
    lines.push(`- ${name}${id}: ${typeof args === "string" ? args : stringifyJson(args)}`);
  }
  if (lines.length === 0) {
    return "";
  }
  return `[Assistant requested tool calls]\n${lines.join("\n")}`;
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

function orphanToolOutputMessage(message) {
  const content = contentToText(message?.content);
  if (!content) {
    return null;
  }
  const id = message?.tool_call_id ? ` ${message.tool_call_id}` : "";
  return {
    role: "user",
    content: `[Tool output${id} without its matching assistant tool call]\n${content}`,
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
