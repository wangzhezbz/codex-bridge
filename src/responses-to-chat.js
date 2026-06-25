import { asArray, stringifyJson } from "./json.js";
import { reasoningParamsForAdapter } from "./adapter-profile.js";
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
const TOOL_RESULT_CONTEXT_HEADER =
  "CodexBridge tool result context: these tool outputs are already completed historical results. " +
  "Do not repeat or re-run these tool calls just because they appear here. " +
  "Use the results as context, continue from the latest user request, and only call a new tool if a genuinely new step is still needed.";
const TOOL_OUTPUT_CONTINUATION_GUIDANCE =
  "CodexBridge tool continuation guidance: the latest user turn contains tool outputs that Codex has already executed. " +
  "If those results satisfy the user's request, return a final concise answer now. " +
  "Do not repeat the same command, restart the same task, or call another tool unless a clearly missing next step remains.";
const ATTACHMENT_GUIDANCE =
  "CodexBridge attachment guidance: Chat-routed providers cannot read native Codex file attachments unless CodexBridge forwards an explicit chat file part or extracts text into this request. " +
  "Use only the attachment text or file parts already included here. " +
  "Do not call shell, browser, MCP, or local file tools to retrieve unsupported attachments. " +
  "If needed content is missing, ask the user to switch to a GPT/Responses model or provide text/OCR output.";
const MAX_EXTRACTABLE_FILE_BYTES = 5_000_000;
const MAX_EXTRACTED_FILE_TEXT_CHARS = 120_000;

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
  Object.assign(body, reasoningParamsForAdapter(request, route, {
    hasTools: toolContext.chatTools.length > 0,
  }));

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
    route,
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
  const attachmentGuidance = attachmentGuidanceFromRequest(request);
  if (attachmentGuidance) {
    messages.push({ role: "system", content: attachmentGuidance });
  }
  messages.push(...priorMessages, ...currentMessages);
  const sourceMessages = sanitizeMessagesForRoute(normalizeToolCallPairs(messages, {
    flattenToolCalls: shouldFlattenToolCallHistory(route),
  }), route);
  return { messages: sourceMessages, toolContext };
}

export function responseInputToChatMessages(input, toolContext, route = {}) {
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
      if (shouldOmitResponseToolCallFromChatHistory(item, toolContext)) {
        continue;
      }
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

    const message = responseMessageToChatMessage(item, route);
    if (message) {
      messages.push(message);
    }
  }

  flushToolCalls();
  return messages;
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

  if (Array.isArray(item.tool_calls)) {
    message.tool_calls = item.tool_calls;
    if (!message.content) {
      message.content = null;
    }
  }

  return message;
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

function filePartToChat(part, route = {}) {
  if (shouldForwardFilesToChat(route)) {
    const file = {};
    const filename = filePartName(part);
    if (filename && filename !== "unnamed file") {
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
    ? "PDF attachment"
    : "File attachment";
  return `${type} unavailable to this chat provider: ${name}. CodexBridge did not forward or extract readable text. Ask the user to switch to a GPT/Responses model or provide text/OCR output.`;
}

function attachmentGuidanceFromRequest(request = {}) {
  return requestHasFileInput(request.messages ?? request.input) ? ATTACHMENT_GUIDANCE : "";
}

function requestHasFileInput(input) {
  if (input === undefined || input === null) {
    return false;
  }
  if (Array.isArray(input)) {
    return input.some(requestHasFileInput);
  }
  if (typeof input !== "object") {
    return false;
  }
  if (isFilePart(input)) {
    return true;
  }
  return requestHasFileInput(input.content ?? input.input ?? input.output);
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
  const needsInteractiveFallbackGuidance =
    requestMentionsInteractivePluginWork(request) &&
    !chatNameForTool(toolContext, "mcp__node_repl__js");
  const needsCommandGuidance =
    names.some(isCommandToolName) && requestMentionsCommandWork(request);
  const needsToolOutputContinuationGuidance = requestHasResponseToolOutput(request);
  return [
    needsGuidance ? MCP_TOOL_GUIDANCE : "",
    needsInteractiveFallbackGuidance ? INTERACTIVE_CHAT_FALLBACK_GUIDANCE : "",
    needsCommandGuidance ? COMMAND_TOOL_GUIDANCE : "",
    needsToolOutputContinuationGuidance ? TOOL_OUTPUT_CONTINUATION_GUIDANCE : "",
  ]
    .filter(Boolean)
    .join(" ");
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
  if (!requestMentionsInteractivePluginWork(request)) {
    return null;
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
  if (routeSupportsReasoningContent(route)) {
    return messages;
  }
  return messages.map((message) => {
    if (!message || typeof message !== "object" || !("reasoning_content" in message)) {
      return message;
    }
    const { reasoning_content, ...rest } = message;
    return rest;
  });
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
  return normalizeToolCallPairs(result, {
    flattenToolCalls: shouldFlattenToolCallHistory(route),
  });
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
