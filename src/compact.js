import { randomUUID } from "node:crypto";
import { cloneJson } from "./json.js";
import { contentToText, responsesToChatRequest } from "./responses-to-chat.js";

export const COMPACT_SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process. " +
  "You also have access to the state of the tools that were used by that language model. " +
  "Use this to build on the work that has already been done and avoid duplicating work. " +
  "Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

const COMPACT_SUMMARIZATION_PROMPT =
  "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\n\n" +
  "Include:\n" +
  "- Current progress and key decisions made\n" +
  "- Important context, constraints, or user preferences\n" +
  "- What remains to be done (clear next steps)\n" +
  "- Any critical data, examples, or references needed to continue\n" +
  "- All user messages so far, verbatim or near-verbatim, in chronological order\n" +
  "- Next Step: the immediate next action aligned with the user's most recent explicit request. Include a verbatim direct quote from the most recent user message showing exactly where you left off.\n\n" +
  "Be concise, structured, and focused on helping the next LLM seamlessly continue the work. Do not call tools. Return only the summary text.";

const COMPACT_MAX_OUTPUT_TOKENS = 20_000;
const COMPACT_CHAT_MESSAGES_MAX_BYTES = 120 * 1024;
const COMPACT_MESSAGE_MAX_CHARS = 8_000;
const LOCAL_COMPACT_FALLBACK_MAX_CHARS = 60_000;

export function isResponsesCompactPath(pathname) {
  return /^\/(?:v1\/)?responses\/compact$/.test(String(pathname || ""));
}

export function compactKindForResponsesRequest(requestBody, context = {}) {
  if (context.compactKind) {
    return context.compactKind;
  }
  return requestHasCompactionTrigger(requestBody) ? "v2" : "";
}

export function requestHasCompactionTrigger(requestBody = {}) {
  return responseItems(requestBody.messages ?? requestBody.input).some(
    (item) => item?.type === "compaction_trigger",
  );
}

export function buildCompactChatRequest(requestBody, route, history) {
  const compactBody = compactRequestBody(requestBody);
  const converted = responsesToChatRequest(compactBody, route, history);
  converted.body.stream = false;
  converted.body.max_tokens = COMPACT_MAX_OUTPUT_TOKENS;
  delete converted.body.tools;
  delete converted.body.tool_choice;
  delete converted.body.parallel_tool_calls;
  converted.body.messages = trimMessagesToCompactBudget(converted.body.messages || []);
  return converted;
}

export function buildCompactResponsesRequest(requestBody, options = {}) {
  return compactRequestBody(requestBody, options);
}

export function compactResponseFromChat(chat, requestedModel, fallbackContext = {}) {
  const id = responseIdFromCompactUpstream(chat?.id);
  const summary = extractChatSummaryText(chat);
  if (!summary) {
    return compactResponseFromLocalFallback(requestedModel, {
      ...fallbackContext,
      id,
      reason:
        fallbackContext.reason ||
        "upstream model returned no summary text during context compaction.",
      usage: responseUsage(chat?.usage),
    });
  }
  return compactResponseFromSummary(id, summary, requestedModel, responseUsage(chat?.usage));
}

export function compactResponseFromResponses(response, requestedModel, fallbackContext = {}) {
  const id = responseIdFromCompactUpstream(response?.id);
  const summary = extractResponsesSummaryText(response);
  if (!summary) {
    return compactResponseFromLocalFallback(requestedModel, {
      ...fallbackContext,
      id,
      reason:
        fallbackContext.reason ||
        "upstream model returned no summary text during context compaction.",
      usage: responseUsage(response?.usage),
    });
  }
  return compactResponseFromSummary(id, summary, requestedModel, responseUsage(response?.usage));
}

export function compactResponseFromLocalFallback(requestedModel, options = {}) {
  return compactResponseFromSummary(
    options.id || `resp_compact_local_${randomUUID()}`,
    localCompactFallbackSummary(options),
    requestedModel,
    options.usage || null,
  );
}

function compactResponseFromSummary(id, summary, requestedModel, usage) {
  const item = {
    id: `cmp_${stableFragment(id)}`,
    type: "compaction",
    encrypted_content: `${COMPACT_SUMMARY_PREFIX}\n${summary}`,
  };

  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestedModel || null,
    output: [item],
    output_text: "",
    parallel_tool_calls: true,
    error: null,
    incomplete_details: null,
    usage,
  };
}

export function compactResponseToSse(response) {
  const inProgress = {
    ...response,
    status: "in_progress",
    output: [],
  };
  const events = [
    sse("response.created", {
      type: "response.created",
      sequence_number: 0,
      response: inProgress,
    }),
    sse("response.output_item.added", {
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: response.output[0],
    }),
    sse("response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: 2,
      output_index: 0,
      item: response.output[0],
    }),
    sse("response.completed", {
      type: "response.completed",
      sequence_number: 3,
      response,
    }),
    "data: [DONE]\n\n",
  ];
  return events.join("");
}

function compactRequestBody(requestBody, options = {}) {
  const body = cloneJson(requestBody) || {};
  body.input = appendCompactPrompt(stripCompactionTrigger(body.input));
  if (body.messages !== undefined) {
    body.messages = appendCompactPrompt(stripCompactionTrigger(body.messages));
  }
  body.stream = Boolean(options.stream);
  if (!options.omitMaxOutputTokens) {
    body.max_output_tokens = COMPACT_MAX_OUTPUT_TOKENS;
  }
  delete body.instructions;
  delete body.tools;
  delete body.tool_choice;
  delete body.parallel_tool_calls;
  delete body.response_format;
  return body;
}

function stripCompactionTrigger(input) {
  if (!Array.isArray(input)) {
    return input;
  }
  return input.filter((item) => item?.type !== "compaction_trigger");
}

function appendCompactPrompt(input) {
  const promptItem = {
    type: "message",
    role: "user",
    content: COMPACT_SUMMARIZATION_PROMPT,
  };
  if (input === undefined || input === null || input === "") {
    return [promptItem];
  }
  if (Array.isArray(input)) {
    return [...input, promptItem];
  }
  return [input, promptItem];
}

function trimMessagesToCompactBudget(messages) {
  if (jsonBytes(messages) <= COMPACT_CHAT_MESSAGES_MAX_BYTES) {
    return messages;
  }

  const prompt = messages.at(-1);
  const preserved = prompt ? [prompt] : [];
  let trimmed = false;

  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const candidate = messages[index];
    const next = [trimNotice(), candidate, ...preserved];
    if (jsonBytes(next) <= COMPACT_CHAT_MESSAGES_MAX_BYTES) {
      preserved.unshift(candidate);
      continue;
    }

    const shortened = shortenCompactMessage(candidate);
    const nextShort = [trimNotice(), shortened, ...preserved];
    if (jsonBytes(nextShort) <= COMPACT_CHAT_MESSAGES_MAX_BYTES) {
      preserved.unshift(shortened);
    }
    trimmed = true;
  }

  return trimmed ? [trimNotice(), ...preserved] : preserved;
}

function shortenCompactMessage(message) {
  const text = contentToText(message?.content);
  const shortened = middleExcerpt(text, COMPACT_MESSAGE_MAX_CHARS);
  const result = {
    role: message?.role || "user",
    content: shortened || "[message omitted during context compaction]",
  };
  if (message?.name) {
    result.name = message.name;
  }
  return result;
}

function trimNotice() {
  return {
    role: "system",
    content:
      "Earlier conversation history was omitted by CodexBridge during context compaction to fit the upstream model context window.",
  };
}

function localCompactFallbackSummary(options = {}) {
  const reason = safeCompactText(
    options.reason || "remote compaction did not return a usable summary",
    1_000,
  );
  const context = localCompactContextText(options);
  return [
    "CodexBridge local compact fallback: remote context compaction did not return a usable summary.",
    `Reason: ${reason}`,
    "Recent context excerpt:",
    context || "[no compactable conversation text was available]",
  ].join("\n\n");
}

function localCompactContextText(options = {}) {
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const parts = messages
    .map(localCompactMessageText)
    .filter(Boolean);
  if (parts.length === 0) {
    parts.push(...responseItems(options.requestBody?.messages ?? options.requestBody?.input)
      .map(localCompactResponseItemText)
      .filter(Boolean));
  }
  return middleExcerpt(parts.join("\n\n"), LOCAL_COMPACT_FALLBACK_MAX_CHARS);
}

function localCompactMessageText(message) {
  if (!message || typeof message !== "object") {
    return "";
  }
  const text = contentToText(message.content ?? message.text ?? message.output ?? "").trim();
  if (!text || /CONTEXT CHECKPOINT COMPACTION/.test(text)) {
    return "";
  }
  return `${message.role || "message"}: ${safeCompactText(text, COMPACT_MESSAGE_MAX_CHARS)}`;
}

function localCompactResponseItemText(item) {
  if (!item || typeof item !== "object" || item.type === "compaction_trigger") {
    return "";
  }
  const role = item.role || item.type || "item";
  const text = contentToText(item.content ?? item.text ?? item.output ?? "").trim();
  if (!text || /CONTEXT CHECKPOINT COMPACTION/.test(text)) {
    return "";
  }
  return `${role}: ${safeCompactText(text, COMPACT_MESSAGE_MAX_CHARS)}`;
}

function safeCompactText(value, maxChars) {
  const text = String(value || "");
  return middleExcerpt(text, maxChars);
}

function middleExcerpt(text, maxChars) {
  const value = String(text || "");
  if (value.length <= maxChars) {
    return value;
  }
  const head = Math.floor(maxChars * 0.65);
  const tail = Math.max(0, maxChars - head);
  return `${value.slice(0, head)}\n[message truncated during context compaction]\n${value.slice(-tail)}`;
}

function extractChatSummaryText(chat) {
  const message = chat?.choices?.[0]?.message || {};
  return contentToText(message.content || message.reasoning_content || "").trim();
}

function extractResponsesSummaryText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }
  const parts = [];
  for (const item of response?.output || []) {
    if (item?.type !== "message" && item?.role !== "assistant") {
      continue;
    }
    const text = contentToText(item.content ?? item.text ?? item.output_text ?? "");
    if (text) {
      parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

function responseUsage(usage = {}) {
  usage ||= {};
  const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
  const outputTokens = usage.completion_tokens || usage.output_tokens || 0;
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

function responseItems(input) {
  if (input === undefined || input === null) {
    return [];
  }
  return Array.isArray(input) ? input : [input];
}

function responseIdFromCompactUpstream(upstreamId) {
  if (upstreamId) {
    return upstreamId.startsWith("resp_") ? upstreamId : `resp_${upstreamId}`;
  }
  return `resp_compact_${randomUUID()}`;
}

function stableFragment(value) {
  return String(value).replace(/[^A-Za-z0-9]/g, "").slice(-16) || "compact";
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value || []), "utf8");
}

function sse(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}
