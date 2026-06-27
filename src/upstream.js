import { createHash } from "node:crypto";
import { cloneJson, jsonResponse, openAiError, stringifyJson, tryParseJson } from "./json.js";
import {
  authModeForRoute,
  joinOpenAiEndpointUrl,
  joinUpstreamUrl,
  requireApiKey,
} from "./config.js";
import {
  filterPayloadForAdapter,
  normalizeAdapterProfile,
} from "./adapter-profile.js";
import {
  contentToText,
  interactiveNodeReplToolNameForRequest,
  interactivePluginKindForRequest,
  responseRequestToChatSourceMessages,
  responsesToChatRequest,
} from "./responses-to-chat.js";
import {
  assistantHistoryMessageFromResponse,
  assistantHistoryMessageFromChat,
  chatResponseToResponse,
  responseToSse,
} from "./chat-to-responses.js";
import {
  buildCompactChatRequest,
  buildCompactResponsesRequest,
  compactKindForResponsesRequest,
  compactResponseFromChat,
  compactResponseFromLocalFallback,
  compactResponseFromResponses,
  compactResponseToSse,
} from "./compact.js";
import {
  proxyImageGenerationFallback,
  shouldUseImageGenerationFallback,
} from "./image-generation.js";
import { fetchInitWithProxy, proxyLogLabel } from "./proxy.js";
import { markRouteRateLimited, waitForRouteCapacity } from "./rate-limit.js";
import { classifyUpstreamError } from "./route-health.js";
import {
  buildResponsesStreamErrorSse,
  extractResponseObjectFromSse,
  extractUsageFromSse,
  responsesSseStreamComplete,
} from "./sse.js";
import { isResponseToolCallItem, isResponseToolOutputItem } from "./tools.js";

const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const FAILURE_CACHE_MAX_ENTRIES = 200;
const FAILURE_CACHE_FATAL_TTL_MS = 120_000;
const DEFAULT_CHAT_TOOL_CONTINUATION_TURNS = 5;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 300_000;
const INVALID_JSON_VALUE = Symbol("invalid_json_value");

const recentUpstreamFailures = new Map();

const CODEX_EXACT_PASSTHROUGH_HEADERS = [
  "user-agent",
  "chatgpt-account-id",
  "x-openai-fedramp",
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-codex-beta-features",
  "x-codex-turn-state",
  "x-codex-turn-metadata",
  "x-codex-parent-thread-id",
  "x-codex-window-id",
  "x-codex-installation-id",
  "x-oai-attestation",
  "x-responsesapi-include-timing-metrics",
  "x-openai-internal-codex-responses-lite",
  "openai-beta",
  "openai-organization",
  "openai-project",
];
const CODEX_PASSTHROUGH_HEADER_PREFIXES = [
  "chatgpt-",
  "openai-",
  "x-codex-",
  "x-oai-",
  "x-openai-",
];
const CODEX_PASSTHROUGH_BLOCKED_HEADERS = new Set([
  "accept",
  "authorization",
  "connection",
  "content-encoding",
  "content-length",
  "content-type",
  "host",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export class UpstreamHttpError extends Error {
  constructor(statusCode, bodyText, upstreamUrl, route = {}) {
    super(`Upstream returned HTTP ${statusCode}`);
    this.statusCode = statusCode;
    this.bodyText = bodyText;
    this.upstreamUrl = upstreamUrl;
    this.route = {
      id: route.id || "",
      displayName: route.displayName || "",
      model: route.model || "",
      api: route.api || "",
    };
  }
}

export class UpstreamNetworkError extends Error {
  constructor(cause, upstreamUrl, route = {}, proxyLabel = "") {
    super(networkErrorMessage(cause, upstreamUrl, route, proxyLabel));
    this.name = "UpstreamNetworkError";
    this.statusCode = 502;
    this.code = "upstream_network_error";
    this.cause = cause;
    this.upstreamUrl = upstreamUrl;
    this.proxyLabel = proxyLabel;
    this.route = {
      id: route.id || "",
      displayName: route.displayName || "",
      model: route.model || "",
      api: route.api || "",
    };
  }
}

export class UpstreamTimeoutError extends Error {
  constructor(timeoutMs, upstreamUrl, route = {}) {
    super(
      `CodexBridge upstream request timed out after ${timeoutMs}ms` +
        (route.displayName || route.id ? ` from ${route.displayName || route.id}` : "") +
        `. url=${safeUrl(upstreamUrl)}`,
    );
    this.name = "UpstreamTimeoutError";
    this.statusCode = 504;
    this.code = "upstream_timeout";
    this.timeoutMs = timeoutMs;
    this.upstreamUrl = upstreamUrl;
    this.route = {
      id: route.id || "",
      displayName: route.displayName || "",
      model: route.model || "",
      api: route.api || "",
    };
  }
}

export class UpstreamStreamError extends Error {
  constructor(message, upstreamUrl, route = {}, code = "upstream_stream_error") {
    super(message);
    this.name = "UpstreamStreamError";
    this.statusCode = 502;
    this.code = code;
    this.upstreamUrl = upstreamUrl;
    this.route = {
      id: route.id || "",
      displayName: route.displayName || "",
      model: route.model || "",
      api: route.api || "",
    };
  }
}

export class ClientClosedRequestError extends Error {
  constructor() {
    super("CodexBridge client connection closed before the upstream response completed.");
    this.name = "ClientClosedRequestError";
    this.statusCode = 499;
    this.code = "client_closed_request";
  }
}

export async function handleResponsesRequest(
  requestBody,
  route,
  history,
  res,
  context = {},
) {
  const compactKind = compactKindForResponsesRequest(requestBody, context);
  if (compactKind && route.api === "chat_completions") {
    return proxyChatCompact(requestBody, route, history, res, {
      ...context,
      compactKind,
    });
  }
  if (compactKind && route.api === "responses") {
    return proxyResponsesCompact(requestBody, route, history, res, {
      ...context,
      compactKind,
    });
  }
  if (shouldUseImageGenerationFallback(requestBody, route)) {
    return proxyImageGenerationFallback(
      requestBody,
      route,
      history,
      res,
      context,
      callJsonUpstream,
    );
  }
  if (route.api === "responses") {
    return proxyResponsesApi(requestBody, route, history, res, context);
  }
  if (route.api === "chat_completions") {
    return proxyChatCompletions(requestBody, route, history, res, context);
  }
  jsonResponse(res, 500, openAiError(`Unsupported route api: ${route.api}`));
}

export async function proxyResponsesApi(
  requestBody,
  route,
  history,
  res,
  context = {},
) {
  if (!history || typeof history.get !== "function") {
    context = res || {};
    res = history;
    history = null;
  }
  const payload = cloneJson(requestBody);
  payload.model = route.model;
  const { messages: sourceMessages, toolContext } = responseRequestToChatSourceMessages(
    requestBody,
    route,
    history,
  );
  if (shouldInlineLocalHistoryForResponses(requestBody, history)) {
    inlineLocalHistoryForResponsesPayload(payload, sourceMessages);
  }

  const upstreamPayload = filterPayloadForUpstream(
    payload,
    route,
    context,
    { api: "responses" },
  );
  const upstreamPath = context.compactKind === "v1" ? "/responses/compact" : "/responses";
  const upstreamUrl = joinOpenAiEndpointUrl(responsesBaseUrlForRoute(route), upstreamPath);
  let activeUpstreamUrl = upstreamUrl;
  throwIfRecentUpstreamFailure(route, upstreamUrl, upstreamPayload, context);
  logRoute(context, route, upstreamUrl);
  let upstream;
  try {
    const upstreamInit = {
      method: "POST",
      headers: upstreamHeaders(route, context, {
        acceptEventStream: Boolean(upstreamPayload.stream),
      }),
      body: JSON.stringify(upstreamPayload),
    };
    upstream = await fetchUpstream(activeUpstreamUrl, upstreamInit, context, route);
    logStatus(context, route, upstream.status);
    const fallbackUrl = responsesV1FallbackUrl(route, activeUpstreamUrl, upstreamPath);
    if (fallbackUrl && upstreamResponseLooksHtml(upstream)) {
      console.warn(
        `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
          `!! upstream route=${route.id} returned HTML at root responses endpoint; ` +
          `retrying ${safeUrl(fallbackUrl)}`,
      );
      activeUpstreamUrl = fallbackUrl;
      logRoute(context, route, activeUpstreamUrl);
      upstream = await fetchUpstream(activeUpstreamUrl, upstreamInit, context, route, {
        cacheFailures: false,
      });
      logStatus(context, route, upstream.status);
    }
  } catch (error) {
    rememberUpstreamFailure(route, activeUpstreamUrl, upstreamPayload, error);
    throw error;
  }

  if (!upstream.ok) {
    const bodyText = await upstream.text();
    const error = new UpstreamHttpError(upstream.status, bodyText, activeUpstreamUrl, route);
    rememberUpstreamFailure(route, activeUpstreamUrl, upstreamPayload, error);
    throw error;
  }

  if (shouldAggregateForcedResponsesStream(requestBody, upstreamPayload, route)) {
    const responseText = upstream.body ? await upstream.text() : "";
    const completedResponse = extractResponsesObject(responseText);
    if (!responsesSseStreamComplete(responseText) && looksLikeSseResponse(responseText)) {
      const message =
        `CodexBridge upstream stream from ${route.displayName || route.id || route.model || "route"} ` +
        "ended before response.completed or [DONE].";
      logUsage(context, route, extractResponsesUsage(responseText));
      throw new UpstreamStreamError(message, activeUpstreamUrl, route, "upstream_stream_truncated");
    }
    if (!completedResponse) {
      throw new UpstreamHttpError(
        502,
        `Upstream returned a forced stream without a response object: ${responseText.slice(0, 500)}`,
        activeUpstreamUrl,
        route,
      );
    }
    recordResponsesHistory(history, completedResponse, sourceMessages, toolContext);
    logUsage(context, route, extractUsageObject(completedResponse) || extractResponsesUsage(responseText));
    jsonResponse(res, upstream.status, completedResponse);
    return;
  }

  res.writeHead(upstream.status, filteredHeaders(upstream.headers));
  if (!upstream.body) {
    logUsage(context, route, null);
    res.end();
    return;
  }
  const decoder = new TextDecoder();
  let responseTail = "";
  let streamError = null;
  try {
    for await (const chunk of upstream.body) {
      const buffer = Buffer.from(chunk);
      responseTail += decoder.decode(buffer, { stream: true });
      if (responseTail.length > 2_000_000) {
        responseTail = responseTail.slice(-2_000_000);
      }
      res.write(buffer);
    }
  } catch (error) {
    streamError = error;
  }
  responseTail += decoder.decode();
  const completedResponse = extractResponsesObject(responseTail);
  const usage = extractUsageObject(completedResponse) || extractResponsesUsage(responseTail);
  if (streamError) {
    if (isClientClosedStreamWrite(context, res, streamError)) {
      logUsage(context, route, usage);
      throw new ClientClosedRequestError();
    }
    if (!upstreamPayload.stream) {
      throw streamError;
    }
    const message = responsesStreamFailureMessage(route, streamError);
    console.warn(
      `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
        `!! upstream route=${route.id} errored responses stream: ${safeText(streamError.message || streamError, 240)}`,
    );
    if (!res.destroyed && !res.writableEnded) {
      res.write(buildResponsesStreamErrorSse(message, {
        model: requestBody.model || route.id || route.model || null,
      }));
      res.end();
    }
    logUsage(context, route, usage);
    throw new UpstreamStreamError(message, activeUpstreamUrl, route, "upstream_stream_error");
  }
  if (upstreamPayload.stream && !responsesSseStreamComplete(responseTail)) {
    const message =
      `CodexBridge upstream stream from ${route.displayName || route.id || route.model || "route"} ` +
      "ended before response.completed or [DONE].";
    console.warn(
      `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
        `!! upstream route=${route.id} truncated responses stream`,
    );
    res.write(buildResponsesStreamErrorSse(message, {
      model: requestBody.model || route.id || route.model || null,
    }));
    res.end();
    logUsage(context, route, usage);
    throw new UpstreamStreamError(message, activeUpstreamUrl, route, "upstream_stream_truncated");
  }

  res.end();
  recordResponsesHistory(history, completedResponse, sourceMessages, toolContext);
  logUsage(context, route, usage);
}

function shouldAggregateForcedResponsesStream(requestBody = {}, upstreamPayload = {}, route = {}) {
  return (
    route.api === "responses" &&
    authModeForRoute(route) === "codex_openai" &&
    requestBody.stream !== true &&
    upstreamPayload.stream === true
  );
}

function looksLikeSseResponse(text = "") {
  const trimmed = String(text || "").trimStart();
  return trimmed.startsWith("data:") || trimmed.startsWith("event:") || /\n(?:data|event):/.test(trimmed);
}

function responsesStreamFailureMessage(route = {}, error) {
  return (
    `CodexBridge upstream stream from ${route.displayName || route.id || route.model || "route"} ` +
    `disconnected before response.completed. ${safeText(error?.message || error || "", 300)}`
  ).trim();
}

function isClientClosedStreamWrite(context = {}, res = {}, error) {
  if (!context.clientSignal?.aborted) {
    return false;
  }
  const code = String(error?.code || "");
  const message = String(error?.message || error || "");
  return (
    Boolean(res.destroyed) ||
    code === "ERR_STREAM_DESTROYED" ||
    /write after end|stream.*destroyed|client connection closed/i.test(message)
  );
}

function shouldInlineLocalHistoryForResponses(requestBody, history) {
  if (!requestBody?.previous_response_id || !history?.getResponseMeta) {
    return false;
  }
  const previousResponseId = requestBody.previous_response_id;
  const meta = history.getResponseMeta(previousResponseId);
  if (meta) {
    return meta.upstreamKnown === false;
  }
  const localHistory = history.get?.(previousResponseId);
  return (
    isLikelyLocalChatResponseId(previousResponseId) &&
    Array.isArray(localHistory) &&
    localHistory.length > 0
  );
}

function isLikelyLocalChatResponseId(responseId) {
  return /^resp_chatcmpl[_-]/.test(String(responseId || ""));
}

function inlineLocalHistoryForResponsesPayload(payload, sourceMessages) {
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

function chatMessagesToResponsesInput(messages) {
  return messages.map(chatMessageToResponsesInput).filter(Boolean);
}

function chatMessageToResponsesInput(message) {
  if (!message || typeof message !== "object") {
    return null;
  }
  const role = responsesInputRole(message.role);
  const content = chatContentToResponsesContent(
    message.content,
    role,
    toolCallsToHandoffText(message.tool_calls),
  );
  if (!content) {
    return null;
  }
  return { role, content };
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

  const text = [contentToText(content), fallbackText].filter(Boolean).join("\n");
  return text;
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

function toolCallsToHandoffText(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return "";
  }
  const names = toolCalls
    .map((toolCall) => toolCall?.function?.name || toolCall?.name || toolCall?.id)
    .filter(Boolean);
  return `[assistant tool calls omitted during provider handoff${
    names.length ? `: ${names.join(", ")}` : ""
  }]`;
}

export async function proxyChatCompletions(
  requestBody,
  route,
  history,
  res,
  context = {},
) {
  const converted = responsesToChatRequest(requestBody, route, history);
  const toolContinuationTurns = chatToolContinuationTurns(requestBody, history);
  const upstreamUrl = joinOpenAiEndpointUrl(route.baseUrl, "/chat/completions");
  logRoute(context, route, upstreamUrl);
  let messagesForHistory = converted.messagesForHistory;
  let upstream;
  try {
    upstream = await callChatCompletionsUpstream(
      upstreamUrl,
      route,
      converted.body,
      context,
    );
  } catch (error) {
    if (isRateLimitError(error)) {
      return sendLocalRateLimitedResponse({
        requestBody,
        route,
        history,
        res,
        context,
        converted,
        messagesForHistory,
        error,
      });
    }
    if (!shouldRetryChatWithoutImages(error, converted.body)) {
      throw error;
    }
    console.warn(
      `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
        `!! upstream route=${route.id} image rejected; retrying without images`,
    );
    const textOnlyBody = chatBodyWithoutImages(converted.body);
    messagesForHistory = chatMessagesWithoutImages(converted.messagesForHistory);
    try {
      upstream = await callChatCompletionsUpstream(
        upstreamUrl,
        route,
        textOnlyBody,
        context,
        { trackRateLimit: false },
      );
    } catch (retryError) {
      console.warn(
        `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
          `!! upstream route=${route.id} image retry failed; isolating failed image turn`,
      );
      return sendLocalImageRejectedResponse({
        requestBody,
        route,
        history,
        res,
        context,
        converted,
        messagesForHistory,
        retryError,
      });
    }
  }
  const adjustedUpstream = enforceInteractivePluginBootstrap(
    upstream,
    requestBody,
    converted,
    context,
  );
  logUsage(context, route, adjustedUpstream.usage);
  let chatForHistory = adjustedUpstream;
  let response = chatResponseToResponse(
    adjustedUpstream,
    requestBody.model || route.id,
    converted.toolContext,
    {
      stripReasoningTags: shouldStripReasoningTags(route),
      suppressInteractiveDiagnostics: Boolean(interactivePluginKindForRequest(requestBody)),
    },
  );
  let localFallback = "";
  const toolCallSignatures = responseToolCallSignatures(response);
  const toolResultSignatures = latestToolResultSignaturesFromInput(
    requestBody?.messages ?? requestBody?.input,
  );
  const repeatsPreviousToolCall = responseRepeatsPreviousToolCall(
    toolCallSignatures,
    requestBody,
    history,
  );
  const toolResultHasNoProgress = repeatedToolResultHasNoProgress(
    toolResultSignatures,
    requestBody,
    history,
  );
  const noProgressToolLoopTurns = repeatedNoProgressToolLoopTurns(
    requestBody,
    history,
    repeatsPreviousToolCall,
    toolResultHasNoProgress,
  );
  if (
    shouldStopChatToolContinuation(
      response,
      route,
      noProgressToolLoopTurns,
    )
  ) {
    console.warn(
      `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
        `!! tool-loop-guard route=${route.id} turns=${toolContinuationTurns} ` +
        `repeat_no_progress=${noProgressToolLoopTurns} ` +
        `max=${maxChatToolContinuationTurns(route)}`,
    );
    chatForHistory = localToolLoopGuardChat(route, toolContinuationTurns);
    response = chatResponseToResponse(
      chatForHistory,
      requestBody.model || route.id,
      converted.toolContext,
      { stripReasoningTags: false },
    );
    localFallback = "tool_loop_guard";
  }

  history.record(response.id, [
    ...messagesForHistory,
    assistantHistoryMessageFromChat(chatForHistory, converted.toolContext),
  ]);
  history.recordResponse(response, {
    api: "chat_completions",
    routeId: route.id || "",
    upstreamModel: route.model || "",
    upstreamKnown: false,
    toolContinuationTurns: responseHasRunnableToolCall(response)
      ? toolContinuationTurns
      : 0,
    noProgressToolLoopTurns: responseHasRunnableToolCall(response)
      ? noProgressToolLoopTurns
      : 0,
    toolCallSignatures: responseHasRunnableToolCall(response)
      ? toolCallSignatures
      : [],
    toolResultSignatures,
    ...(localFallback ? { localFallback } : {}),
  });

  if (converted.wantsStream) {
    const payload = responseToSse(response);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.end(payload);
    return;
  }

  jsonResponse(res, 200, response);
}

async function proxyChatCompact(requestBody, route, history, res, context = {}) {
  const converted = buildCompactChatRequest(requestBody, route, history);
  const upstreamUrl = joinOpenAiEndpointUrl(route.baseUrl, "/chat/completions");
  logRoute(context, route, upstreamUrl);
  let upstream = null;
  let response = null;
  let localFallback = "";
  try {
    upstream = await callChatCompletionsUpstream(
      upstreamUrl,
      route,
      converted.body,
      context,
    );
    logUsage(context, route, upstream.usage);
    response = compactResponseFromChat(upstream, requestBody.model || route.id, {
      messages: converted.messagesForHistory,
      requestBody,
    });
  } catch (error) {
    localFallback = "compact_local_fallback";
    console.warn(
      `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
        `!! compact-local-fallback route=${route.id} reason=${safeText(compactFallbackReason(error), 300)}`,
    );
    logUsage(context, route, null);
    response = compactResponseFromLocalFallback(requestBody.model || route.id, {
      messages: converted.messagesForHistory,
      requestBody,
      reason: compactFallbackReason(error),
    });
  }
  history.record(response.id, [
    ...converted.messagesForHistory,
    {
      role: "assistant",
      content: response.output[0]?.encrypted_content || null,
    },
  ]);
  history.recordResponse(response, {
    api: "chat_completions",
    routeId: route.id || "",
    upstreamModel: route.model || "",
    upstreamKnown: false,
    localFallback: localFallback || "compact",
  });

  if (context.compactKind === "v2") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.end(compactResponseToSse(response));
    return;
  }

  jsonResponse(res, 200, response);
}

async function callChatCompletionsUpstream(
  upstreamUrl,
  route,
  payload,
  context = {},
  options = {},
) {
  try {
    return await callJsonUpstream(upstreamUrl, route, payload, context, options);
  } catch (error) {
    const fallbackUrl = chatCompletionsV1FallbackUrl(route, upstreamUrl, error);
    if (!fallbackUrl) {
      throw error;
    }
    console.warn(
      `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
        `!! upstream route=${route.id} returned HTML at root chat endpoint; ` +
        `retrying ${safeUrl(fallbackUrl)}`,
    );
    logRoute(context, route, fallbackUrl);
    return callJsonUpstream(fallbackUrl, route, payload, context, {
      ...options,
      cacheFailures: false,
    });
  }
}

function chatCompletionsV1FallbackUrl(route, upstreamUrl, error) {
  if (!isHtmlNonJsonError(error) || !isRootBaseUrl(route?.baseUrl)) {
    return "";
  }
  const fallbackBaseUrl = baseUrlWithV1Path(route.baseUrl);
  if (!fallbackBaseUrl) {
    return "";
  }
  const fallbackUrl = joinUpstreamUrl(fallbackBaseUrl, "/chat/completions");
  return fallbackUrl === upstreamUrl ? "" : fallbackUrl;
}

function responsesV1FallbackUrl(route, upstreamUrl, upstreamPath = "/responses") {
  if (!isRootBaseUrl(route?.baseUrl)) {
    return "";
  }
  const fallbackBaseUrl = baseUrlWithV1Path(route.baseUrl);
  if (!fallbackBaseUrl) {
    return "";
  }
  const fallbackUrl = joinUpstreamUrl(fallbackBaseUrl, upstreamPath);
  return fallbackUrl === upstreamUrl ? "" : fallbackUrl;
}

function upstreamResponseLooksHtml(response) {
  return /(?:^|;|\s)text\/html(?:;|\s|$)/i.test(
    response?.headers?.get?.("content-type") || "",
  );
}

function isHtmlNonJsonError(error) {
  return (
    error instanceof UpstreamHttpError &&
    error.statusCode === 502 &&
    /Upstream returned non-JSON body:/i.test(error.bodyText || "") &&
    /<(!doctype\s+html|html|head|body)(\s|>|$)/i.test(error.bodyText || "")
  );
}

function isRootBaseUrl(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    return parsed.pathname === "" || parsed.pathname === "/";
  } catch {
    return false;
  }
}

function baseUrlWithV1Path(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    parsed.pathname = "/v1";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

async function proxyResponsesCompact(requestBody, route, history, res, context = {}) {
  const compactBody = buildCompactResponsesRequest(requestBody, {
    stream: shouldStreamResponsesCompact(route),
    omitMaxOutputTokens: shouldOmitResponsesCompactMaxOutputTokens(route),
  });
  compactBody.model = route.model;
  const { messages: sourceMessages, toolContext } = responseRequestToChatSourceMessages(
    compactBody,
    route,
    history,
  );
  if (shouldInlineLocalHistoryForResponses(compactBody, history)) {
    inlineLocalHistoryForResponsesPayload(compactBody, sourceMessages);
  }

  const upstreamUrl = joinOpenAiEndpointUrl(responsesBaseUrlForRoute(route), "/responses");
  logRoute(context, route, upstreamUrl);
  let upstream = null;
  let compactFallbackReasonText = "";
  try {
    upstream = await callResponsesCompactUpstream(upstreamUrl, route, compactBody, context);
  } catch (error) {
    if (compactBody.stream || !isStreamRequiredError(error)) {
      compactFallbackReasonText = compactFallbackReason(error);
      console.warn(
        `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
          `!! compact-local-fallback route=${route.id} reason=${safeText(compactFallbackReasonText, 300)}`,
      );
    } else {
      const streamCompactBody = buildCompactResponsesRequest(requestBody, {
        stream: true,
        omitMaxOutputTokens: shouldOmitResponsesCompactMaxOutputTokens(route),
      });
      streamCompactBody.model = route.model;
      if (shouldInlineLocalHistoryForResponses(streamCompactBody, history)) {
        inlineLocalHistoryForResponsesPayload(streamCompactBody, sourceMessages);
      }
      console.warn(
        `[${new Date().toISOString()}] ${context.requestId || "req"} !! upstream ` +
          `route=${route.id} compact requires stream=true; retrying compact request as event stream`,
      );
      try {
        upstream = await callResponsesCompactUpstream(
          upstreamUrl,
          route,
          streamCompactBody,
          context,
          { cacheFailures: false },
        );
      } catch (retryError) {
        compactFallbackReasonText = compactFallbackReason(retryError);
        console.warn(
          `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
            `!! compact-local-fallback route=${route.id} reason=${safeText(compactFallbackReasonText, 300)}`,
        );
      }
    }
  }
  logUsage(context, route, extractUsageObject(upstream));

  const response = upstream
    ? compactResponseFromResponses(upstream, requestBody.model || route.id, {
        messages: sourceMessages,
        requestBody,
      })
    : compactResponseFromLocalFallback(requestBody.model || route.id, {
        messages: sourceMessages,
        requestBody,
        reason: compactFallbackReasonText,
      });
  history.record(response.id, [
    ...sourceMessages,
    {
      role: "assistant",
      content: response.output[0]?.encrypted_content || null,
    },
  ]);
  history.recordResponse(response, {
    api: "responses",
    routeId: route.id || "",
    upstreamModel: route.model || "",
    upstreamKnown: false,
    localFallback: upstream ? "compact" : "compact_local_fallback",
  });

  if (context.compactKind === "v2") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.end(compactResponseToSse(response));
    return;
  }

  jsonResponse(res, 200, response);
}

async function callResponsesCompactUpstream(
  upstreamUrl,
  route,
  payload,
  context = {},
  options = {},
) {
  const upstreamPayload = filterPayloadForUpstream(payload, route, context);
  throwIfRecentUpstreamFailure(route, upstreamUrl, upstreamPayload, context);
  let upstream;
  try {
    upstream = await fetchUpstream(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders(route, context, {
        acceptEventStream: Boolean(upstreamPayload.stream),
      }),
      body: JSON.stringify(upstreamPayload),
    }, context, route, options);
  } catch (error) {
    rememberUpstreamFailure(route, upstreamUrl, upstreamPayload, error, options);
    throw error;
  }
  const text = await upstream.text();
  if (!upstream.ok) {
    const error = new UpstreamHttpError(upstream.status, text, upstreamUrl, route);
    rememberUpstreamFailure(route, upstreamUrl, upstreamPayload, error, options);
    throw error;
  }
  const parsed = tryParseJson(text);
  if (parsed) {
    return parsed;
  }
  const response = extractResponsesObject(text);
  if (response) {
    return response;
  }
  const error = new UpstreamHttpError(
    502,
    `Upstream returned non-JSON compact body: ${text.slice(0, 500)}`,
    upstreamUrl,
    route,
  );
  rememberUpstreamFailure(route, upstreamUrl, upstreamPayload, error, options);
  throw error;
}

function shouldStreamResponsesCompact(route = {}) {
  return authModeForRoute(route) === "codex_openai";
}

function shouldOmitResponsesCompactMaxOutputTokens(route = {}) {
  return authModeForRoute(route) === "codex_openai";
}

function isStreamRequiredError(error) {
  if (!(error instanceof UpstreamHttpError)) {
    return false;
  }
  const parsed = tryParseJson(error.bodyText);
  const message = [
    parsed?.detail,
    parsed?.message,
    parsed?.error?.message,
    error.bodyText,
  ]
    .filter(Boolean)
    .join(" ");
  return /stream\b.*\btrue/i.test(message);
}

function compactFallbackReason(error) {
  if (error instanceof UpstreamHttpError) {
    return upstreamBodyMessage(error.bodyText, tryParseJson(error.bodyText)) ||
      `HTTP ${error.statusCode}`;
  }
  return error?.message || String(error || "remote compact failed");
}

function chatToolContinuationTurns(requestBody, history) {
  const currentTurns = responseToolOutputContinuationGroups(
    requestBody?.messages ?? requestBody?.input,
  );
  if (currentTurns <= 0) {
    return 0;
  }
  const previousMeta = history?.getResponseMeta?.(requestBody?.previous_response_id) || {};
  const previousTurns = Number(previousMeta.toolContinuationTurns || 0);
  return (Number.isFinite(previousTurns) && previousTurns > 0 ? previousTurns : 0) +
    currentTurns;
}

function requestHasResponseToolOutput(requestBody = {}) {
  return responseToolOutputContinuationGroups(
    requestBody.messages ?? requestBody.input,
  ) > 0;
}

function responseToolOutputContinuationGroups(input) {
  let groups = 0;
  let inOutputGroup = false;
  for (const item of responseInputItems(input)) {
    if (isResponseToolOutputItem(item)) {
      if (!inOutputGroup) {
        groups += 1;
        inOutputGroup = true;
      }
      continue;
    }
    inOutputGroup = false;
  }
  return groups;
}

function responseInputItems(input) {
  if (input === undefined || input === null) {
    return [];
  }
  return Array.isArray(input) ? input : [input];
}

function shouldStopChatToolContinuation(
  response,
  route,
  noProgressToolLoopTurns,
) {
  return (
    responseHasRunnableToolCall(response) &&
    noProgressToolLoopTurns > 0 &&
    noProgressToolLoopTurns >= maxChatToolContinuationTurns(route)
  );
}

function maxChatToolContinuationTurns(route = {}) {
  const value = Number(
    route.maxToolContinuationTurns ?? route.max_tool_continuation_turns,
  );
  if (Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return DEFAULT_CHAT_TOOL_CONTINUATION_TURNS;
}

function responseHasRunnableToolCall(response) {
  return Array.isArray(response?.output) && response.output.some(isResponseToolCallItem);
}

function responseRepeatsPreviousToolCall(signatures, requestBody, history) {
  if (!Array.isArray(signatures) || signatures.length === 0) {
    return false;
  }
  const previousMeta = history?.getResponseMeta?.(requestBody?.previous_response_id) || {};
  const previousSignatures = Array.isArray(previousMeta.toolCallSignatures)
    ? previousMeta.toolCallSignatures
    : latestToolCallSignaturesFromInput(requestBody?.messages ?? requestBody?.input);
  return sameStringArray(signatures, previousSignatures);
}

function repeatedToolResultHasNoProgress(signatures, requestBody, history) {
  if (!Array.isArray(signatures) || signatures.length === 0) {
    return false;
  }
  const previousMeta = history?.getResponseMeta?.(requestBody?.previous_response_id) || {};
  const previousSignatures = Array.isArray(previousMeta.toolResultSignatures)
    ? previousMeta.toolResultSignatures
    : previousToolResultSignaturesFromInput(requestBody?.messages ?? requestBody?.input);
  return sameStringArray(signatures, previousSignatures);
}

function repeatedNoProgressToolLoopTurns(
  requestBody,
  history,
  repeatsPreviousToolCall,
  toolResultHasNoProgress,
) {
  if (!repeatsPreviousToolCall || !toolResultHasNoProgress) {
    return 0;
  }
  const previousMeta = history?.getResponseMeta?.(requestBody?.previous_response_id) || {};
  const previousTurns = Number(previousMeta.noProgressToolLoopTurns || 0);
  if (Number.isFinite(previousTurns) && previousTurns > 0) {
    return previousTurns + 1;
  }

  const inputTurns = responseToolOutputContinuationGroups(
    requestBody?.messages ?? requestBody?.input,
  );
  return Math.max(1, inputTurns - 1);
}

function latestToolCallSignaturesFromInput(input) {
  let latest = [];
  let currentGroup = [];
  for (const item of responseInputItems(input)) {
    const signature = toolCallSignature(item);
    if (signature) {
      currentGroup.push(signature);
      latest = [...currentGroup].sort();
      continue;
    }
    currentGroup = [];
  }
  return latest;
}

function responseToolCallSignatures(response) {
  if (!Array.isArray(response?.output)) {
    return [];
  }
  return response.output
    .map((item) => toolCallSignature(item))
    .filter(Boolean)
    .sort();
}

function latestToolResultSignaturesFromInput(input) {
  const groups = toolResultSignatureGroupsFromInput(input);
  return groups.at(-1) || [];
}

function previousToolResultSignaturesFromInput(input) {
  const groups = toolResultSignatureGroupsFromInput(input);
  return groups.length >= 2 ? groups[groups.length - 2] : [];
}

function toolResultSignatureGroupsFromInput(input) {
  const groups = [];
  let currentGroup = [];
  for (const item of responseInputItems(input)) {
    const signature = toolResultSignature(item);
    if (signature) {
      currentGroup.push(signature);
      continue;
    }
    if (currentGroup.length > 0) {
      groups.push([...currentGroup].sort());
      currentGroup = [];
    }
  }
  if (currentGroup.length > 0) {
    groups.push([...currentGroup].sort());
  }
  return groups;
}

function toolCallSignature(item) {
  if (!item || typeof item !== "object") {
    return "";
  }
  if (isResponseToolCallItem(item)) {
    return `${item.type || "tool"}:${item.name || ""}:${canonicalToolArguments(
      item.arguments ?? item.input ?? item.action ?? "",
    )}`;
  }
  const toolCalls = Array.isArray(item.tool_calls) ? item.tool_calls : [];
  if (toolCalls.length === 0) {
    return "";
  }
  return toolCalls
    .map((toolCall) => {
      const name = toolCall?.function?.name || toolCall?.name || "";
      const args = toolCall?.function?.arguments ?? toolCall?.arguments ?? "";
      return `chat:${name}:${canonicalToolArguments(args)}`;
    })
    .sort()
    .join("|");
}

function canonicalToolArguments(value) {
  if (typeof value === "string") {
    const parsed = tryParseJson(value, INVALID_JSON_VALUE);
    return stringifyJson(parsed === INVALID_JSON_VALUE ? value : parsed);
  }
  return stringifyJson(value ?? "");
}

function toolResultSignature(item) {
  if (!item || typeof item !== "object" || !isResponseToolOutputItem(item)) {
    return "";
  }
  return `${item.type || "tool_output"}:${canonicalToolResult(
    item.output ?? item.result ?? item.content ?? "",
  )}`;
}

function canonicalToolResult(value) {
  if (typeof value === "string") {
    const parsed = tryParseJson(value, INVALID_JSON_VALUE);
    return boundedSignatureText(
      parsed === INVALID_JSON_VALUE ? value : stableStringify(parsed),
    );
  }
  return boundedSignatureText(stableStringify(value ?? ""));
}

function boundedSignatureText(value) {
  const text = String(value ?? "");
  if (text.length <= 2000) {
    return text;
  }
  const digest = createHash("sha256").update(text).digest("hex");
  return `${text.length}:${digest}`;
}

function sameStringArray(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function localToolLoopGuardChat(route, toolContinuationTurns) {
  const displayName = route.displayName || route.id || "the current model";
  return {
    id: `chatcmpl_tool_loop_guard_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    object: "chat.completion",
    choices: [
      {
        message: {
          role: "assistant",
          content:
            `CodexBridge stopped repeated tool loop：已停止 ${displayName} 的重复工具调用。连续 ` +
            `${toolContinuationTurns} 轮工具结果后，模型仍要求继续调用工具。` +
            "最新工具结果已保留，但本轮不会再继续请求上游，避免重复调用和浪费 token。 " +
            "请发送一个明确的下一步继续。",
        },
      },
    ],
    usage: null,
  };
}

function enforceInteractivePluginBootstrap(upstream, requestBody, converted, context = {}) {
  const kind = interactivePluginKindForRequest(requestBody);
  if (!kind) {
    return upstream;
  }
  const nodeReplToolName = interactiveNodeReplToolNameForRequest(
    converted.toolContext,
    requestBody,
  );
  if (!nodeReplToolName) {
    return upstream;
  }

  const message = upstream?.choices?.[0]?.message;
  if (messageHasToolCall(message, nodeReplToolName)) {
    return upstream;
  }

  const adjusted = cloneJson(upstream);
  if (!Array.isArray(adjusted.choices) || adjusted.choices.length === 0) {
    adjusted.choices = [{ index: 0, finish_reason: "tool_calls", message: {} }];
  }
  adjusted.choices[0].finish_reason = "tool_calls";
  adjusted.choices[0].message = {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: `call_codexbridge_${kind}_bootstrap`,
        type: "function",
        function: {
          name: nodeReplToolName,
          arguments: JSON.stringify({
            code: interactivePluginBootstrapCode(kind),
          }),
        },
      },
    ],
  };

  console.warn(
    `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
      `!! interactive ${kind} request forced through ${nodeReplToolName}`,
  );
  return adjusted;
}

function messageHasToolCall(message, toolName) {
  return (message?.tool_calls || []).some((toolCall) => {
    const name = toolCall?.function?.name || toolCall?.name || "";
    return name === toolName;
  });
}

function interactivePluginBootstrapCode(kind) {
  const scriptName =
    kind === "computer" ? "computer-use-client.mjs" : "browser-client.mjs";
  const pluginName = kind === "computer" ? "computer-use" : "chrome";
  const setupImport =
    kind === "computer"
      ? "const { setupComputerUseRuntime } = await import(pluginScriptUrl('computer-use', 'computer-use-client.mjs'));"
      : "const { setupBrowserRuntime } = await import(pluginScriptUrl('chrome', 'browser-client.mjs'));";
  const setupCall =
    kind === "computer"
      ? [
          "await setupComputerUseRuntime({ globals: globalThis });",
          "const apps = await sky.list_apps();",
          "nodeRepl.write(JSON.stringify({ ready: true, plugin: 'computer-use', apps }, null, 2));",
        ].join("\n")
      : [
          "await setupBrowserRuntime({ globals: globalThis });",
          "globalThis.browser = await agent.browsers.get('extension');",
          "nodeRepl.write(await browser.documentation());",
        ].join("\n");

  return [
    "const fs = await import('node:fs');",
    "const path = await import('node:path');",
    "const { pathToFileURL } = await import('node:url');",
    "function pluginScriptUrl(pluginName, scriptName) {",
    "  const root = path.join(nodeRepl.homeDir, '.codex', 'plugins', 'cache', 'openai-bundled', pluginName);",
    "  const versions = fs.existsSync(root)",
    "    ? fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()",
    "    : [];",
    "  for (const version of versions.reverse()) {",
    "    const scriptPath = path.join(root, version, 'scripts', scriptName);",
    "    if (fs.existsSync(scriptPath)) return pathToFileURL(scriptPath).href;",
    "  }",
    "  throw new Error(`CodexBridge could not find ${scriptName} under ${root}`);",
    "}",
    `// CodexBridge official ${pluginName} bootstrap via ${scriptName}.`,
    setupImport,
    setupCall,
  ].join("\n");
}

const IMAGE_REJECTED_PLACEHOLDER =
  "[image input omitted because upstream rejected image content]";

function sendLocalRateLimitedResponse({
  requestBody,
  route,
  history,
  res,
  context,
  converted,
  messagesForHistory,
  error,
}) {
  const localChat = localRateLimitedChat(route, error);
  const response = chatResponseToResponse(
    localChat,
    requestBody.model || route.id,
    converted.toolContext,
    { stripReasoningTags: false },
  );

  history.record(response.id, [
    ...messagesForHistory,
    assistantHistoryMessageFromChat(localChat),
  ]);
  history.recordResponse(response, {
    api: "chat_completions",
    routeId: route.id || "",
    upstreamModel: route.model || "",
    upstreamKnown: false,
    localFallback: "provider_rate_limited",
  });
  logUsage(context, route, null);

  if (converted.wantsStream) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.end(responseToSse(response));
    return;
  }

  jsonResponse(res, 200, response);
}

function localRateLimitedChat(route, error) {
  const retryAfterMs = Number(error?.retryAfterMs || 0);
  const waitSeconds = Math.ceil(Math.max(0, retryAfterMs) / 1000);
  const waitText =
    waitSeconds > 0
      ? `Please wait about ${waitSeconds}s, then retry or switch to another model.`
      : "Please wait a moment, then retry or switch to another model.";
  const displayName = route.displayName || route.id || "the current model";
  return {
    id: `chatcmpl_rate_limited_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    object: "chat.completion",
    choices: [
      {
        message: {
          role: "assistant",
          content:
            `CodexBridge stopped sending requests to ${displayName} because the provider is rate limited. ` +
            "This turn was handled locally to avoid repeated upstream calls and token waste. " +
            waitText,
        },
      },
    ],
    usage: null,
  };
}

function sendLocalImageRejectedResponse({
  requestBody,
  route,
  history,
  res,
  context,
  converted,
  messagesForHistory,
  retryError,
}) {
  const localChat = localImageRejectedChat(route, retryError);
  const response = chatResponseToResponse(
    localChat,
    requestBody.model || route.id,
    converted.toolContext,
    { stripReasoningTags: false },
  );

  history.record(response.id, [
    ...messagesForHistory,
    assistantHistoryMessageFromChat(localChat),
  ]);
  history.recordResponse(response, {
    api: "chat_completions",
    routeId: route.id || "",
    upstreamModel: route.model || "",
    upstreamKnown: false,
    localFallback: "image_rejected",
  });
  logUsage(context, route, null);

  if (converted.wantsStream) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.end(responseToSse(response));
    return;
  }

  jsonResponse(res, 200, response);
}

function isRateLimitError(error) {
  return Number(error?.statusCode || 0) === 429;
}

function localImageRejectedChat(route, retryError) {
  const status = retryError?.statusCode ? `HTTP ${retryError.statusCode}` : "";
  const parsed = retryError instanceof UpstreamHttpError
    ? tryParseJson(retryError.bodyText)
    : null;
  const upstreamMessage = retryError instanceof UpstreamHttpError
    ? upstreamBodyMessage(retryError.bodyText, parsed)
    : safeText(retryError?.message || "", 300);
  const retryDetail = [status, upstreamMessage].filter(Boolean).join(" - ");
  const displayName = route.displayName || route.id || "当前模型";
  const content =
    `这次消息里的图片没有继续发送给 ${displayName}：上游模型拒绝了图片输入。` +
    "CodexBridge 已经把本轮历史改成文本占位，后续会话可以继续。" +
    (retryDetail ? ` 去掉图片后上游仍返回：${retryDetail}。` : "") +
    "建议关闭这个模型的“图片上传”开关后重试，或切换到真正支持图片的模型。";

  return {
    id: `chatcmpl_image_omitted_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    object: "chat.completion",
    choices: [
      {
        message: {
          role: "assistant",
          content,
        },
      },
    ],
    usage: null,
  };
}

function shouldRetryChatWithoutImages(error, body) {
  if (!(error instanceof UpstreamHttpError)) {
    return false;
  }
  if (!chatBodyHasImages(body)) {
    return false;
  }
  const statusCode = Number(error.statusCode);
  if (![400, 415, 422].includes(statusCode)) {
    return false;
  }
  const upstreamText = `${error.bodyText || ""} ${error.message || ""}`.toLowerCase();
  return (
    !upstreamText ||
    /image|vision|multi[-\s]?modal|image_url|input_image|unsupported media|content|part|invalid request/.test(
      upstreamText,
    )
  );
}

function chatBodyHasImages(body) {
  return Array.isArray(body?.messages) && body.messages.some(chatMessageHasImage);
}

function chatMessageHasImage(message) {
  return chatContentHasImage(message?.content);
}

function chatContentHasImage(content) {
  if (!content) {
    return false;
  }
  if (Array.isArray(content)) {
    return content.some(chatPartHasImage);
  }
  return chatPartHasImage(content);
}

function chatPartHasImage(part) {
  if (!part || typeof part !== "object") {
    return false;
  }
  const type = String(part.type || "").toLowerCase();
  return type === "image_url" || type.includes("image") || Boolean(part.image_url);
}

function chatBodyWithoutImages(body) {
  const sanitized = cloneJson(body);
  sanitized.messages = chatMessagesWithoutImages(sanitized.messages);
  return sanitized;
}

function chatMessagesWithoutImages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages.map((message) => ({
    ...message,
    content: chatContentWithoutImages(message?.content),
  }));
}

function chatContentWithoutImages(content) {
  if (!content) {
    return content;
  }
  if (!Array.isArray(content)) {
    return chatPartHasImage(content) ? IMAGE_REJECTED_PLACEHOLDER : content;
  }
  const sanitizedParts = [];
  for (const part of content) {
    if (chatPartHasImage(part)) {
      sanitizedParts.push({ type: "text", text: IMAGE_REJECTED_PLACEHOLDER });
      continue;
    }
    sanitizedParts.push(part);
  }
  return sanitizedParts;
}

export async function callJsonUpstream(
  upstreamUrl,
  route,
  payload,
  context = {},
  options = {},
) {
  const upstreamPayload =
    route?.api === "responses" || route?.api === "chat_completions"
      ? filterPayloadForUpstream(payload, route, context)
      : payload;
  throwIfRecentUpstreamFailure(route, upstreamUrl, upstreamPayload, context);
  let upstream;
  try {
    upstream = await fetchUpstream(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders(route, context),
      body: JSON.stringify(upstreamPayload),
    }, context, route, options);
  } catch (error) {
    rememberUpstreamFailure(route, upstreamUrl, upstreamPayload, error, options);
    throw error;
  }
  const text = await upstream.text();
  if (!upstream.ok) {
    const error = new UpstreamHttpError(upstream.status, text, upstreamUrl, route);
    rememberUpstreamFailure(route, upstreamUrl, upstreamPayload, error, options);
    throw error;
  }
  const parsed = tryParseJson(text);
  if (!parsed) {
    const error = new UpstreamHttpError(
      502,
      `Upstream returned non-JSON body: ${text.slice(0, 500)}`,
      upstreamUrl,
      route,
    );
    rememberUpstreamFailure(route, upstreamUrl, upstreamPayload, error, options);
    throw error;
  }
  return parsed;
}

export function __resetUpstreamFailureCacheForTests() {
  recentUpstreamFailures.clear();
}

export function sendUpstreamError(res, error, options = {}) {
  if (options.asResponsesStream) {
    sendResponsesStreamFailure(res, streamErrorMessage(error), {
      model: options.model || error?.route?.model || null,
    });
    return;
  }

  if (res.headersSent) {
    res.end();
    return;
  }

  if (error instanceof UpstreamNetworkError) {
    const classification = classifyUpstreamError(error);
    jsonResponse(
      res,
      error.statusCode,
      openAiError(error.message, error.statusCode, classification.code),
    );
    return;
  }

  if (error?.code === "request_body_too_large") {
    const limitMb = bytesToMegabytes(error.limitBytes);
    const actualMb = bytesToMegabytes(error.actualBytes);
    jsonResponse(
      res,
      error.statusCode || 413,
      openAiError(
        `CodexBridge local request body is too large${actualMb ? ` (${actualMb} MB)` : ""}. ` +
          `The local router limit is ${limitMb || "configured"} MB. ` +
          "Run /compact, remove large pasted logs or inline images, or raise requestBodyLimitBytes if you intentionally need a larger local request.",
        error.statusCode || 413,
        "request_body_too_large",
      ),
    );
    return;
  }

  if (error instanceof UpstreamHttpError) {
    const parsed = tryParseJson(error.bodyText);
    const classification = classifyUpstreamError(error);
    if (isMissingResponsesWriteScope(parsed, error.bodyText)) {
      jsonResponse(
        res,
        error.statusCode,
        openAiError(
          "Codex 登录态不能作为 OpenAI API Key 使用：上游返回缺少 api.responses.write 权限，说明请求仍然打到了 public OpenAI API，或上游把 Codex 登录态当成 Platform API Key 校验。请更新 CodexBridge 配置，让 GPT 订阅模型走 ChatGPT Codex backend。",
          error.statusCode,
          "codex_subscription_missing_api_scope",
        ),
      );
      return;
    }
    jsonResponse(
      res,
      error.statusCode,
      openAiError(
        clientUpstreamErrorMessage(error, parsed),
        error.statusCode,
        classification.code,
      ),
    );
    return;
  }

  const statusCode = error.statusCode || 500;
  jsonResponse(res, statusCode, openAiError(error.message, statusCode, error.code || "router_error"));
}

function bytesToMegabytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "";
  }
  return (bytes / 1024 / 1024).toFixed(bytes >= 1024 * 1024 ? 1 : 3);
}

function sendResponsesStreamFailure(res, message, options = {}) {
  if (!res.headersSent) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
  }
  if (!res.writableEnded) {
    res.end(buildResponsesStreamErrorSse(message, options));
  }
}

function streamErrorMessage(error) {
  if (error instanceof UpstreamHttpError) {
    const parsed = tryParseJson(error.bodyText);
    return clientUpstreamErrorMessage(error, parsed);
  }
  return error?.message || String(error || "Upstream stream failed.");
}

function isMissingResponsesWriteScope(parsedBody, rawBody) {
  const message = [
    parsedBody?.error?.message,
    parsedBody?.message,
    rawBody,
  ]
    .filter(Boolean)
    .join(" ");
  return /missing scopes?:\s*api\.responses\.write/i.test(message);
}

function clientUpstreamErrorMessage(error, parsedBody) {
  const routeLabel = [error.route?.displayName, error.route?.id]
    .filter(Boolean)
    .join(" / ");
  const model = error.route?.model ? ` upstream_model=${error.route.model}` : "";
  const api = error.route?.api ? ` api=${error.route.api}` : "";
  const upstreamMessage = upstreamBodyMessage(error.bodyText, parsedBody);
  if (Number(error.statusCode) === 413) {
    return payloadTooLargeClientMessage({
      routeLabel,
      model,
      api,
      statusCode: error.statusCode,
      upstreamMessage,
    });
  }
  return (
    `CodexBridge upstream error` +
    (routeLabel ? ` from ${routeLabel}` : "") +
    `${model}${api}: HTTP ${error.statusCode}` +
    (upstreamMessage ? ` - ${upstreamMessage}` : "")
  );
}

function payloadTooLargeClientMessage({
  routeLabel,
  model,
  api,
  statusCode,
  upstreamMessage,
}) {
  return (
    `CodexBridge upstream request is too large` +
    (routeLabel ? ` from ${routeLabel}` : "") +
    `${model}${api}: HTTP ${statusCode}. ` +
    "The upstream provider rejected the request body. " +
    "Recover by running /compact, starting a new thread, removing large pasted logs/files/inline images, " +
    "or asking the provider to raise its request body limit." +
    (upstreamMessage ? ` Upstream detail: ${upstreamMessage}` : "")
  );
}

function upstreamBodyMessage(rawBody, parsedBody) {
  const message =
    parsedBody?.error?.message ||
    parsedBody?.message ||
    parsedBody?.error ||
    rawBody ||
    "";
  return safeText(message, 800);
}

function upstreamHeaders(route, context = {}, options = {}) {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${upstreamBearerToken(route, context)}`,
  };

  if (options.acceptEventStream) {
    headers.accept = "text/event-stream";
  }

  if (authModeForRoute(route) === "codex_openai") {
    addCodexPassthroughHeaders(headers, context.clientHeaders);
  }

  return headers;
}

function upstreamBearerToken(route, context = {}) {
  if (authModeForRoute(route) === "codex_openai") {
    if (context.clientAuth?.kind === "codex_openai" && context.clientAuth.bearerToken) {
      return context.clientAuth.bearerToken;
    }
    const error = new Error(
      `Route ${route.id} requires Codex/OpenAI bearer authentication.`,
    );
    error.statusCode = 401;
    throw error;
  }
  return requireApiKey(route);
}

function filteredHeaders(headers) {
  const result = {};
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    if (
      [
        "content-encoding",
        "content-length",
        "connection",
        "keep-alive",
        "transfer-encoding",
      ].includes(lower)
    ) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

function responsesBaseUrlForRoute(route) {
  if (
    authModeForRoute(route) === "codex_openai" &&
    isPublicOpenAiApiBaseUrl(route.baseUrl)
  ) {
    return process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL || CHATGPT_CODEX_BASE_URL;
  }
  return route.baseUrl;
}

function isPublicOpenAiApiBaseUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

function addCodexPassthroughHeaders(target, source) {
  for (const name of CODEX_EXACT_PASSTHROUGH_HEADERS) {
    setCodexPassthroughHeader(target, name, headerValue(source, name));
  }
  for (const [rawName, rawValue] of Object.entries(source || {})) {
    const name = String(rawName || "").toLowerCase();
    if (!shouldPassthroughCodexHeader(name)) {
      continue;
    }
    setCodexPassthroughHeader(target, name, headerValue({ [name]: rawValue }, name));
  }
}

function shouldPassthroughCodexHeader(name) {
  return (
    !CODEX_PASSTHROUGH_BLOCKED_HEADERS.has(name) &&
    (
      CODEX_EXACT_PASSTHROUGH_HEADERS.includes(name) ||
      CODEX_PASSTHROUGH_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))
    )
  );
}

function setCodexPassthroughHeader(target, name, value) {
  if (value && !CODEX_PASSTHROUGH_BLOCKED_HEADERS.has(name)) {
    target[name] = value;
  }
}

function headerValue(headers, name) {
  if (!headers) {
    return "";
  }
  const value = headers[name] || headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value.find(Boolean) || "";
  }
  return typeof value === "string" ? value : "";
}

function filterPayloadForUpstream(payload, route, context = {}, options = {}) {
  const drops = [];
  const upstreamPayload = filterPayloadForAdapter(payload, route, {
    ...options,
    onDrop: (drop) => drops.push(drop),
  });
  logPayloadDrops(context, route, drops);
  return upstreamPayload;
}

function logPayloadDrops(context, route, drops) {
  if (!drops.length) {
    return;
  }
  const requestId = context.requestId || "req";
  const routeId = route.id || route.model || route.adapterId || "unknown";
  for (const drop of drops) {
    console.log(
      `[${new Date().toISOString()}] ${requestId} !! payload_drop ` +
        `route=${safeLogValue(routeId)} path=${safeLogValue(drop.path)} ` +
        `reason=${safeLogValue(drop.reason)}`,
    );
  }
}

function safeLogValue(value) {
  return String(value || "")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function providerLogLabel(route = {}) {
  const explicitProvider = route.provider || route.providerFamily || route.providerId;
  if (explicitProvider) {
    return explicitProvider;
  }
  try {
    const profile = normalizeAdapterProfile({
      ...route,
      baseUrl: "",
      provider: route.model || route.sourcePresetId || route.id || route.baseUrl,
    });
    return profile.providerFamily || "-";
  } catch {
    return "-";
  }
}

function logRoute(context, route, upstreamUrl) {
  const requestId = context.requestId || "req";
  const proxy = proxyLogLabel(upstreamUrl);
  console.log(
    `[${new Date().toISOString()}] ${requestId} -> upstream ` +
      `route=${route.id} api=${route.api} upstream_model=${route.model} ` +
      `url=${safeUrl(upstreamUrl)} provider=${providerLogLabel(route)}` +
      (proxy ? ` proxy=${proxy}` : ""),
  );
}

function logStatus(context, route, status) {
  const requestId = context.requestId || "req";
  console.log(
    `[${new Date().toISOString()}] ${requestId} <- upstream ` +
      `route=${route.id} status=${status}`,
  );
}

function logUsage(context, route, usage) {
  const requestId = context.requestId || "req";
  if (!usage) {
    console.log(
      `[${new Date().toISOString()}] ${requestId} <- upstream ` +
        `route=${route.id} usage=(none)`,
    );
    return;
  }
  const normalized = normalizeUsage(usage);
  console.log(
    `[${new Date().toISOString()}] ${requestId} <- upstream ` +
      `route=${route.id} usage prompt=${normalized.prompt_tokens} ` +
      `completion=${normalized.completion_tokens} total=${normalized.total_tokens}`,
  );
}

function throwIfRecentUpstreamFailure(route, upstreamUrl, payload, context = {}) {
  const key = upstreamFailureKey(route, upstreamUrl, payload);
  const cached = recentUpstreamFailures.get(key);
  if (!cached) {
    return;
  }
  const now = Date.now();
  if (cached.expiresAt <= now) {
    recentUpstreamFailures.delete(key);
    return;
  }

  cached.hits += 1;
  const remainingMs = Math.max(0, cached.expiresAt - now);
  const requestId = context.requestId || "req";
  console.warn(
    `[${new Date().toISOString()}] ${requestId} !! upstream ` +
      `route=${route.id || route.model || "unknown"} cached_failure ` +
      `status=${cached.statusCode} remaining_ms=${remainingMs}`,
  );

  const error = new UpstreamHttpError(
    cached.statusCode,
    cached.bodyText,
    upstreamUrl,
    route,
  );
  error.cachedUpstreamFailure = true;
  throw error;
}

function rememberUpstreamFailure(route, upstreamUrl, payload, error, options = {}) {
  if (
    options.cacheFailures === false ||
    error?.cachedUpstreamFailure ||
    error?.code === "client_closed_request" ||
    error?.code === "provider_rate_limited"
  ) {
    return;
  }
  const statusCode = Number(error?.statusCode || 500);
  const ttlMs = upstreamFailureTtlMs(statusCode, route);
  if (ttlMs <= 0) {
    return;
  }
  trimUpstreamFailureCache();
  recentUpstreamFailures.set(upstreamFailureKey(route, upstreamUrl, payload), {
    statusCode,
    bodyText: upstreamFailureBodyText(error),
    expiresAt: Date.now() + ttlMs,
    hits: 0,
  });
}

function upstreamFailureTtlMs(statusCode, route = {}) {
  if (statusCode === 401 || statusCode === 429) {
    return 0;
  }
  if ([400, 413, 415, 422].includes(statusCode)) {
    return FAILURE_CACHE_FATAL_TTL_MS;
  }
  return 0;
}

function upstreamFailureBodyText(error) {
  if (error instanceof UpstreamHttpError) {
    return error.bodyText || error.message || "Upstream request failed";
  }
  return error?.message || String(error || "Upstream request failed");
}

function trimUpstreamFailureCache() {
  const now = Date.now();
  for (const [key, value] of recentUpstreamFailures) {
    if (value.expiresAt <= now) {
      recentUpstreamFailures.delete(key);
    }
  }
  while (recentUpstreamFailures.size >= FAILURE_CACHE_MAX_ENTRIES) {
    const oldestKey = recentUpstreamFailures.keys().next().value;
    recentUpstreamFailures.delete(oldestKey);
  }
}

function upstreamFailureKey(route, upstreamUrl, payload) {
  const material = stableStringify({
    route: {
      id: route.id || "",
      provider: route.provider || route.providerId || "",
      api: route.api || "",
      model: route.model || "",
      baseUrl: route.baseUrl || "",
      authMode: authModeForRoute(route),
      apiKeyEnv: route.apiKeyEnv || route.keyEnv || "",
      inlineApiKeyPresent: Boolean(route.apiKey),
    },
    upstreamUrl: safeUrl(upstreamUrl),
    payload,
  });
  return createHash("sha256").update(material).digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

async function fetchUpstream(upstreamUrl, init, context = {}, route = {}, options = {}) {
  await waitForRouteCapacity(route, context, options);
  const proxiedInit = fetchInitWithProxy(upstreamUrl, init);
  const usedProxy = Boolean(proxiedInit.dispatcher);
  const proxyLabel = proxyLogLabel(upstreamUrl);
  try {
    return await fetchAndTrackRateLimit(upstreamUrl, proxiedInit, route, options, context);
  } catch (error) {
    if (!usedProxy || !isNetworkFetchFailure(error)) {
      throw isNetworkFetchFailure(error)
        ? new UpstreamNetworkError(error, upstreamUrl, route, proxyLabel)
        : error;
    }
    logProxyFallback(context, route, error);
    try {
      return await fetchAndTrackRateLimit(upstreamUrl, init, route, options, context);
    } catch (directError) {
      throw isNetworkFetchFailure(directError)
        ? new UpstreamNetworkError(directError, upstreamUrl, route, proxyLabel)
        : directError;
    }
  }
}

async function fetchAndTrackRateLimit(upstreamUrl, init, route, options = {}, context = {}) {
  const abortable = abortableFetchInit(init, upstreamUrl, route, options, context);
  try {
    const response = await fetch(upstreamUrl, abortable.init);
    if (response.status === 429 && options.trackRateLimit !== false) {
      markRouteRateLimited(route, response.headers);
    }
    return response;
  } catch (error) {
    if (abortable.clientAborted()) {
      throw new ClientClosedRequestError();
    }
    if (abortable.timedOut()) {
      throw new UpstreamTimeoutError(abortable.timeoutMs, upstreamUrl, route);
    }
    throw error;
  } finally {
    abortable.cleanup();
  }
}

function abortableFetchInit(init = {}, upstreamUrl, route = {}, options = {}, context = {}) {
  const controller = new AbortController();
  const cleanup = [];
  let timeoutTriggered = false;
  let clientTriggered = Boolean(context.clientSignal?.aborted);
  const timeoutMs = upstreamTimeoutMs(route, options);

  const abort = (reason) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  if (init.signal) {
    if (init.signal.aborted) {
      abort(init.signal.reason);
    } else {
      const onAbort = () => abort(init.signal.reason);
      init.signal.addEventListener("abort", onAbort, { once: true });
      cleanup.push(() => init.signal.removeEventListener("abort", onAbort));
    }
  }

  if (context.clientSignal) {
    if (context.clientSignal.aborted) {
      clientTriggered = true;
      abort(context.clientSignal.reason);
    } else {
      const onClientAbort = () => {
        clientTriggered = true;
        abort(context.clientSignal.reason);
      };
      context.clientSignal.addEventListener("abort", onClientAbort, { once: true });
      cleanup.push(() => context.clientSignal.removeEventListener("abort", onClientAbort));
    }
  }

  if (timeoutMs > 0) {
    const timeout = setTimeout(() => {
      timeoutTriggered = true;
      abort(new Error(`upstream timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    cleanup.push(() => clearTimeout(timeout));
  }

  return {
    init: {
      ...init,
      signal: controller.signal,
    },
    timeoutMs,
    clientAborted: () => clientTriggered || Boolean(context.clientSignal?.aborted),
    timedOut: () => timeoutTriggered,
    cleanup: () => {
      for (const fn of cleanup.splice(0)) {
        fn();
      }
    },
  };
}

function upstreamTimeoutMs(route = {}, options = {}) {
  const value = Number(
    options.timeoutMs ??
      route.upstreamTimeoutMs ??
      route.upstream_timeout_ms ??
      route.requestTimeoutMs ??
      route.request_timeout_ms,
  );
  if (Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return DEFAULT_UPSTREAM_TIMEOUT_MS;
}

function logProxyFallback(context, route, error) {
  const requestId = context.requestId || "req";
  const cause = error?.cause?.code || error?.cause?.message || "";
  console.warn(
    `[${new Date().toISOString()}] ${requestId} !! proxy route=${route.id || "-"} ` +
      `error=${safeText(error?.message || String(error))}` +
      (cause ? ` cause=${safeText(cause)}` : "") +
      " retry=direct",
  );
}

function isNetworkFetchFailure(error) {
  const message = String(error?.message || "");
  const cause = String(error?.cause?.code || error?.cause?.message || "");
  return (
    /fetch failed/i.test(message) ||
    /^UND_ERR_/i.test(cause) ||
    /ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(cause)
  );
}

export function upstreamErrorLogPreview(error) {
  if (!(error instanceof UpstreamHttpError) || !error.bodyText) {
    return "";
  }
  return ` body=${safeText(error.bodyText, 500)}`;
}

function networkErrorMessage(cause, upstreamUrl, route = {}, proxyLabel = "") {
  const routeLabel = [route.displayName, route.id].filter(Boolean).join(" / ");
  const model = route.model ? ` upstream_model=${route.model}` : "";
  const api = route.api ? ` api=${route.api}` : "";
  const causeLabel =
    cause?.cause?.code ||
    cause?.cause?.message ||
    cause?.message ||
    String(cause || "unknown network error");
  return (
    `CodexBridge network error` +
    (routeLabel ? ` from ${routeLabel}` : "") +
    `${model}${api}: ${safeText(causeLabel, 200)}. ` +
    "Check network, provider Base URL, API proxy/VPN, and whether the provider is reachable." +
    (proxyLabel ? ` proxy=${proxyLabel}` : "") +
    ` url=${safeUrl(upstreamUrl)}`
  );
}

function extractResponsesUsage(text) {
  return extractUsageFromSse(text);
}

function extractResponsesObject(text) {
  return extractResponseObjectFromSse(text);
}

function isResponsesObject(value) {
  return Boolean(normalizeResponsesObject(value));
}

function normalizeResponsesObject(value) {
  if (!value || typeof value !== "object" || typeof value.id !== "string" || !value.id) {
    return null;
  }
  if (value.object === "response") {
    return value;
  }
  if (
    value.status ||
    value.output ||
    typeof value.output_text === "string" ||
    value.usage
  ) {
    return { object: "response", ...value };
  }
  return null;
}

function recordResponsesHistory(history, response, sourceMessages, toolContext) {
  if (!history || !isResponsesObject(response)) {
    return;
  }
  history.record(response.id, [
    ...sourceMessages,
    assistantHistoryMessageFromResponse(response, toolContext),
  ]);
  history.recordResponse(response, {
    api: "responses",
    upstreamKnown: true,
  });
}

function extractUsageObject(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidates = [
    value.usage,
    value.response?.usage,
    value.data?.usage,
    value.result?.usage,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") {
      return candidate;
    }
  }
  return null;
}

function normalizeUsage(usage = {}) {
  const promptTokens = tokenNumber(
    usage.prompt_tokens,
    usage.input_tokens,
    usage.promptTokens,
    usage.inputTokens,
  );
  const completionTokens = tokenNumber(
    usage.completion_tokens,
    usage.output_tokens,
    usage.completionTokens,
    usage.outputTokens,
  );
  const totalTokens = tokenNumber(
    usage.total_tokens,
    usage.totalTokens,
    promptTokens + completionTokens,
  );
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
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

function safeUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(value);
  }
}

function safeText(value, limit = 240) {
  return String(value || "")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function shouldStripReasoningTags(route = {}) {
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
