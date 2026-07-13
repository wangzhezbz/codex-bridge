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
  CODEXBRIDGE_CAPABILITY_TOOL_NAME,
  contentToText,
  interactiveNodeReplToolNameForRequest,
  interactivePluginKindForRequest,
  estimatedMessagesTokens,
  preservedToolBoundaryCount,
  responseInputToChatMessages,
  responseRequestToChatSourceMessages,
  responsesToChatRequest,
  stripExactPersistedHistoryPrefix,
  trimMessagesToRouteContext,
} from "./responses-to-chat.js";
import {
  assistantHistoryMessageFromResponse,
  assistantHistoryMessageFromChat,
  chatResponseToResponse,
  returnedToolDiagnosticsFromChat,
  returnedToolDiagnosticsLogFields,
  responseToSse,
} from "./chat-to-responses.js";
import {
  buildCompactChatRequest,
  buildCompactResponsesRequest,
  COMPACT_SUMMARY_PREFIX,
  compactKindForResponsesRequest,
  compactResponseFromChat,
  compactResponseFromLocalFallback,
  compactResponseFromResponses,
  compactResponseToSse,
  strictContextSwitchSummaryFromChat,
  strictContextSwitchSummaryFromResponses,
} from "./compact.js";
import { contextPolicyForRoute } from "./context-policy.js";
import {
  createRouteSnapshot,
  resolveRouteSnapshot,
  validateRouteSnapshot,
} from "./route-snapshot.js";
import {
  proxyImageGenerationFallback,
  shouldUseImageGenerationFallback,
} from "./image-generation.js";
import {
  fetchInitWithProxy,
  invalidateProxyAgentForUrl,
  proxyLogLabel,
  refreshFetchInitWithProxy,
} from "./proxy.js";
import { redactSecretText } from "./redact.js";
import { markRouteRateLimited, routeRateLimitStatus, waitForRouteCapacity } from "./rate-limit.js";
import { classifyUpstreamError } from "./route-health.js";
import {
  createRouteTrace,
  recordRouteTraceEvent,
  routeTraceForLog,
} from "./route-trace.js";
import {
  buildResponsesStreamErrorSse,
  extractResponseObjectFromSse,
  extractUsageFromSse,
  parseSseEvents,
  responsesSseStreamComplete,
} from "./sse.js";
import {
  buildToolContext,
  isResponseToolCallItem,
  isResponseToolOutputItem,
  toolDiagnosticsFromContext,
  toolDiagnosticsLogFields,
} from "./tools.js";

const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
// A completed response is persisted both as the provider response and as an
// assistant history message. Keep headroom below the store's 100 MiB turn cap;
// the store remains the final whole-turn limit when source input is also large.
const MAX_RESPONSES_SSE_EVENT_BUFFER_BYTES = 48 * 1024 * 1024;
const MAX_RESPONSES_TERMINAL_BUFFER_BYTES = 48 * 1024 * 1024;
const DEFAULT_CHAT_TOOL_CONTINUATION_TURNS = 5;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 600_000;
const DEFAULT_STREAMING_PROXY_HEADER_TIMEOUT_MS = 600_000;
const INVALID_JSON_VALUE = Symbol("invalid_json_value");

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
  constructor(statusCode, bodyText, upstreamUrl, route = {}, options = {}) {
    super(`Upstream returned HTTP ${statusCode}`);
    this.statusCode = statusCode;
    this.bodyText = bodyText;
    this.upstreamUrl = upstreamUrl;
    this.retryAfter = headerValue(options.headers, "retry-after");
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
  if (shouldServeIdleResumeLocally(requestBody, route, history, context)) {
    return sendIdleResumeResponse(requestBody, route, history, res, context);
  }
  const duplicateContext = compactKind ? { ...context, compactKind } : context;

  const duplicateGuard = beginDuplicateInitialRequestGuard(
    requestBody,
    route,
    res,
    duplicateContext,
  );
  if (duplicateGuard.served) {
    return;
  }
  const guardedContext = duplicateGuard.key
    ? {
        ...duplicateContext,
        pendingRequestLease: duplicateGuard.lease,
      }
    : duplicateContext;
  try {
    const requestContext = await contextWithSwitchCompaction(
      requestBody,
      route,
      history,
      guardedContext,
    );
    if (compactKind && route.api === "chat_completions") {
      return await proxyChatCompact(requestBody, route, history, res, requestContext);
    }
    if (compactKind && route.api === "responses") {
      return await proxyResponsesCompact(requestBody, route, history, res, requestContext);
    }
    if (shouldUseImageGenerationFallback(requestBody, route)) {
      const imageRequestBody = context?.routeSelection?.changed
        ? { ...requestBody, model: route.id || requestBody.model }
        : requestBody;
      const response = await proxyImageGenerationFallback(
          imageRequestBody,
          route,
          history,
          res,
          requestContext,
          callJsonUpstream,
      );
      return response;
    }
    if (route.api === "responses") {
      return await proxyResponsesApi(requestBody, route, history, res, requestContext);
    }
    if (route.api === "chat_completions") {
      return await proxyChatCompletions(requestBody, route, history, res, requestContext);
    }
  } finally {
    releasePendingRequestGuard(guardedContext);
  }
  jsonResponse(res, 500, openAiError(`不支持的路由接口类型：${route.api}`));
}

async function contextWithSwitchCompaction(
  requestBody = {},
  route = {},
  history = null,
  context = {},
) {
  const compaction = await maybeCreateContextSwitchCompaction(
    requestBody,
    route,
    history,
    context,
  );
  return compaction ? { ...context, contextSwitchCompaction: compaction } : context;
}

async function maybeCreateContextSwitchCompaction(
  requestBody = {},
  route = {},
  history = null,
  context = {},
) {
  if (
    context.compactKind ||
    context.contextSwitchCompaction ||
    !requestBody?.previous_response_id ||
    !history?.getResponseMeta ||
    !history?.get
  ) {
    return null;
  }

  const previousMeta = history.getResponseMeta(requestBody.previous_response_id) || {};
  const storedSnapshot = previousMeta.routeSnapshot;
  const previousRouteId = String(storedSnapshot?.id || previousMeta.routeId || "").trim();
  if (!previousRouteId) {
    return null;
  }

  const targetPolicy = contextSwitchPolicyForRoute(route);
  const targetContextWindow = targetPolicy.contextWindow;
  const { messages } = responseRequestToChatSourceMessages(requestBody, route, history);
  const estimatedTokens = estimatedMessagesTokens(messages || []);
  const compactThreshold = targetPolicy.compactThreshold;
  if (previousRouteId === route.id) {
    if (!storedSnapshot) {
      return null;
    }
    const storedValidation = validateRouteSnapshot(storedSnapshot);
    const resolution = storedValidation.ok
      ? resolveRouteSnapshot(
          storedValidation.snapshot,
          context.activeConfig?.models || [route],
          { contextPolicyForRoute: contextSwitchPolicyForRoute },
        )
      : exactUnsafeSameRouteSnapshotMatch(
          storedSnapshot,
          route,
          targetPolicy,
          storedValidation,
        );
    if (!resolution.ok) {
      logContextSwitchCompactionOutcome(context, route, {
        policyId: targetPolicy.policyId,
        policyVersion: targetPolicy.version,
        fromRouteId: previousRouteId,
        toRouteId: route.id || "",
        estimatedTokens,
        inputBudget: targetPolicy.inputBudget,
        compactThreshold,
        preservedToolCount: 0,
        reasonCode: resolution.code,
      }, "failed");
      throw contextSwitchCompactionFailedError();
    }
    return null;
  }
  if (!estimatedTokens || estimatedTokens <= compactThreshold) {
    return null;
  }

  const storedValidation = validateRouteSnapshot(storedSnapshot);
  if (!storedValidation.ok) {
    logContextSwitchCompactionOutcome(context, route, {
      policyId: targetPolicy.policyId,
      policyVersion: targetPolicy.version,
      fromRouteId: previousRouteId,
      toRouteId: route.id || "",
      estimatedTokens,
      compactThreshold,
      preservedToolCount: 0,
      reasonCode: storedValidation.code,
    }, "failed");
    throw contextSwitchCompactionFailedError();
  }
  const previousContextWindow = storedValidation.snapshot.contextPolicy.contextWindow;
  if (!previousContextWindow || !targetContextWindow || previousContextWindow <= targetContextWindow) {
    return null;
  }

  const resolution = resolveRouteSnapshot(
    storedValidation.snapshot,
    context.activeConfig?.models,
    { contextPolicyForRoute: contextSwitchPolicyForRoute },
  );
  if (!resolution.ok) {
    logContextSwitchCompactionOutcome(context, route, {
      policyId: targetPolicy.policyId,
      policyVersion: targetPolicy.version,
      fromRouteId: previousRouteId,
      toRouteId: route.id || "",
      estimatedTokens,
      compactThreshold,
      preservedToolCount: 0,
      reasonCode: resolution.code,
    }, "failed");
    throw contextSwitchCompactionFailedError();
  }
  const previousRoute = resolution.route;

  let sourcePlan;
  try {
    sourcePlan = contextSwitchSourcePlan(
      requestBody,
      history,
      targetPolicy,
      previousRoute,
    );
  } catch (error) {
    logContextSwitchCompactionOutcome(context, route, {
      policyId: targetPolicy.policyId,
      policyVersion: targetPolicy.version,
      fromRouteId: previousRoute.id || "",
      toRouteId: route.id || "",
      estimatedTokens,
      compactThreshold,
      preservedToolCount: Number(error?.preservedToolCount || 0),
      reasonCode: "protected_tool_boundary_invalid",
    }, "failed");
    throw contextSwitchCompactionFailedError();
  }
  const logDetails = {
    policyId: targetPolicy.policyId,
    policyVersion: targetPolicy.version,
    fromRouteId: previousRoute.id || "",
    toRouteId: route.id || "",
    estimatedTokens,
    compactThreshold,
    preservedToolCount: sourcePlan.preservedToolCount,
    reasonCode: "old_route_compacted",
  };
  let summary = "";
  try {
    summary = await createContextSwitchSummary(
      requestBody,
      previousRoute,
      context,
      sourcePlan.summaryMessages,
    );
    if (!summary) {
      throw contextSwitchCompactionFailedError();
    }
  } catch {
    logContextSwitchCompactionOutcome(context, route, {
      ...logDetails,
      reasonCode: "old_route_compaction_failed",
    }, "failed");
    throw contextSwitchCompactionFailedError();
  }

  const compaction = {
    summary,
    fromRouteId: previousRoute.id || "",
    fromDisplayName: previousRoute.displayName || previousRoute.id || previousRoute.model || "",
    fromContextWindow: previousContextWindow,
    toRouteId: route.id || "",
    toDisplayName: route.displayName || route.id || route.model || "",
    toContextWindow: targetContextWindow,
    estimatedTokens,
    targetInputBudget: targetPolicy.inputBudget,
    compactThreshold,
    policyId: targetPolicy.policyId,
    policyVersion: targetPolicy.version,
    protectedMessages: sourcePlan.protectedMessages,
    preservedToolCount: sourcePlan.preservedToolCount,
  };
  if (!contextSwitchCompactedContextIsSafe(
    requestBody,
    route,
    history,
    compaction,
    targetPolicy,
    sourcePlan.protectedToolCallIds,
  )) {
    logContextSwitchCompactionOutcome(context, route, {
      ...logDetails,
      reasonCode: "compacted_context_unsafe",
    }, "failed");
    throw contextSwitchCompactionFailedError();
  }
  recordRouteTraceEvent(
    ensureRouteTrace(context, route),
    "context_switch_compact",
    contextSwitchCompactTraceDetails({ ...compaction, outcome: "succeeded" }),
  );
  logContextSwitchCompactionOutcome(context, route, logDetails, "succeeded");
  return compaction;
}

function exactUnsafeSameRouteSnapshotMatch(
  storedSnapshot,
  route,
  targetPolicy,
  validation,
) {
  if (![
    "route_snapshot_inline_credentials",
    "route_snapshot_credentials_unavailable",
    "route_snapshot_custom_headers_unsupported",
  ].includes(validation?.code)) {
    return validation || { ok: false, code: "route_snapshot_invalid" };
  }
  try {
    const currentSnapshot = createRouteSnapshot(route, {
      contextPolicy: targetPolicy,
    });
    return stableStringify(storedSnapshot) === stableStringify(currentSnapshot)
      ? { ok: true, route, snapshot: storedSnapshot }
      : { ok: false, code: "route_snapshot_same_id_drift" };
  } catch {
    return { ok: false, code: "route_snapshot_same_id_drift" };
  }
}

function contextSwitchCompactTraceDetails(compaction = {}) {
  return {
    policyId: compaction.policyId || "",
    policyVersion: compaction.policyVersion || 0,
    fromRouteId: compaction.fromRouteId || "",
    fromDisplayName: compaction.fromDisplayName || "",
    fromContextWindow: compaction.fromContextWindow || 0,
    toRouteId: compaction.toRouteId || "",
    toDisplayName: compaction.toDisplayName || "",
    toContextWindow: compaction.toContextWindow || 0,
    estimatedTokens: compaction.estimatedTokens || 0,
    targetInputBudget: compaction.targetInputBudget || 0,
    compactThreshold: compaction.compactThreshold || compaction.targetInputBudget || 0,
    preservedToolCount: compaction.preservedToolCount || 0,
    outcome: compaction.outcome || "succeeded",
  };
}

function logContextSwitchCompactionOutcome(context, route, details = {}, outcome) {
  let policy = null;
  try {
    policy = contextSwitchPolicyForRoute(route);
  } catch {
    policy = null;
  }
  const entry = {
    event: "context_switch_compaction",
    policyId: details.policyId || "",
    policyVersion: Number(details.policyVersion || 0),
    fromRouteId: details.fromRouteId || "",
    toRouteId: details.toRouteId || route.id || "",
    estimatedTokens: Number(details.estimatedTokens || 0),
    inputBudget: Number(details.inputBudget || policy?.inputBudget || 0),
    compactThreshold: Number(details.compactThreshold || policy?.compactThreshold || 0),
    preservedToolCount: Number(details.preservedToolCount || 0),
    outcome,
    reasonCode: details.reasonCode || (outcome === "succeeded" ? "old_route_compacted" : "failed"),
  };
  console.warn(
    `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
      `context_switch_compaction ${JSON.stringify(entry)}`,
  );
}

function logContextTruncationDecision(context, route, decision) {
  if (!decision || decision.outcome !== "truncated") {
    return;
  }
  const entry = {
    event: "context_truncation",
    kind: decision.kind || "chat_payload",
    policyId: decision.policyId || "",
    policyVersion: Number(decision.policyVersion || 0),
    routeId: route.id || "",
    inputBudget: Number(decision.inputBudget || 0),
    beforeTokens: Number(decision.beforeTokens || 0),
    afterTokens: Number(decision.afterTokens || 0),
    preservedToolCount: Number(decision.preservedToolCount || 0),
    outcome: "truncated",
    reasonCode: decision.reasonCode || "input_budget_exceeded",
  };
  console.warn(
    `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
      `context_truncation ${JSON.stringify(entry)}`,
  );
}

function logContextCompactionOutcome(context, route, details = {}) {
  let policy = null;
  try {
    policy = contextSwitchPolicyForRoute(route);
  } catch {
    policy = null;
  }
  const entry = {
    event: "context_compaction",
    kind: details.kind || context.compactKind || "explicit",
    policyId: policy?.policyId || "unknown",
    policyVersion: Number(policy?.version || 0),
    routeId: route.id || "",
    fromRouteId: details.fromRouteId || route.id || "",
    toRouteId: details.toRouteId || route.id || "",
    estimatedTokens: Number(details.estimatedTokens || details.beforeTokens || 0),
    inputBudget: Number(details.inputBudget || policy?.inputBudget || 0),
    compactThreshold: Number(details.compactThreshold || policy?.compactThreshold || 0),
    preservedToolCount: Number(details.preservedToolCount || 0),
    outcome: details.outcome || "completed",
    reasonCode: details.reasonCode || "remote_summary_completed",
  };
  console.warn(
    `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
      `context_compaction ${JSON.stringify(entry)}`,
  );
}

async function createContextSwitchSummary(
  requestBody = {},
  compactRoute = {},
  context = {},
  sourceMessages = [],
) {
  const compactContext = {
    ...context,
    contextSwitchCompactRoute: compactRoute.id || compactRoute.model || "",
  };
  if (compactRoute.api === "chat_completions") {
    const converted = buildCompactChatRequest(requestBody, compactRoute, null, {
      sourceMessages,
    });
    logContextTruncationDecision(compactContext, compactRoute, converted.contextDecision);
    const upstreamUrl = joinOpenAiEndpointUrl(compactRoute.baseUrl, "/chat/completions");
    logRoute(compactContext, compactRoute, upstreamUrl);
    const upstream = await callChatCompletionsUpstream(
      upstreamUrl,
      compactRoute,
      converted.body,
      compactContext,
      { trackRateLimit: false },
    );
    logUsage(compactContext, compactRoute, upstream.usage);
    return strictContextSwitchSummaryFromChat(upstream);
  }

  if (compactRoute.api === "responses") {
    const sourceRequest = cloneJson(requestBody) || {};
    sourceRequest.input = chatMessagesToResponsesInput(sourceMessages);
    delete sourceRequest.messages;
    delete sourceRequest.previous_response_id;
    const compactBody = buildCompactResponsesRequest(sourceRequest, {
      stream: shouldStreamResponsesCompact(compactRoute),
      omitMaxOutputTokens: shouldOmitResponsesCompactMaxOutputTokens(compactRoute),
    });
    compactBody.model = compactRoute.model;
    const budgeted = budgetResponsesCompactPayload(compactBody, compactRoute, null);
    logContextTruncationDecision(compactContext, compactRoute, budgeted.contextDecision);
    const upstreamUrl = joinOpenAiEndpointUrl(responsesBaseUrlForRoute(compactRoute), "/responses");
    logRoute(compactContext, compactRoute, upstreamUrl);
    const upstream = await callResponsesCompactUpstream(
      upstreamUrl,
      compactRoute,
      compactBody,
      compactContext,
      {},
    );
    logUsage(compactContext, compactRoute, extractUsageObject(upstream));
    return strictContextSwitchSummaryFromResponses(upstream);
  }
  return "";
}

function contextSwitchSourcePlan(
  requestBody = {},
  history = null,
  targetPolicy = {},
  previousRoute = {},
) {
  const priorMessages = history?.get?.(requestBody.previous_response_id) || [];
  const toolContext = buildToolContext(requestBody.tools || [], { route: previousRoute });
  const currentMessages = stripExactPersistedHistoryPrefix(
    responseInputToChatMessages(
      requestBody.messages ?? requestBody.input,
      toolContext,
      previousRoute,
    ),
    priorMessages,
  );
  const lastPriorMessage = priorMessages.at(-1);
  const activeToolCalls =
    lastPriorMessage?.role === "assistant" &&
    Array.isArray(lastPriorMessage.tool_calls) &&
    lastPriorMessage.tool_calls.length > 0
      ? lastPriorMessage.tool_calls
      : [];
  const deltaHasToolProtocol = currentMessages.some((message) =>
    message?.role === "tool" ||
    (
      message?.role === "assistant" &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length > 0
    )
  );
  if (!deltaHasToolProtocol) {
    if (activeToolCalls.length > 0) {
      throw contextSwitchCompactionFailedError({
        preservedToolCount: activeToolCalls.length,
      });
    }
    return {
      summaryMessages: priorMessages,
      protectedMessages: [],
      protectedToolCallIds: [],
      preservedToolCount: 0,
    };
  }

  if (
    currentMessages.length === 0 ||
    currentMessages.some((message) => message?.role !== "tool")
  ) {
    throw contextSwitchCompactionFailedError();
  }

  if (activeToolCalls.length === 0) {
    throw contextSwitchCompactionFailedError();
  }

  const activeCallIndex = priorMessages.length - 1;
  const activeCall = lastPriorMessage;
  const toolCalls = activeToolCalls;
  const protectedToolCallIds = toolCalls.map((toolCall) => toolCall?.id || toolCall?.call_id || "");
  if (
    protectedToolCallIds.some((id) => !id) ||
    new Set(protectedToolCallIds).size !== protectedToolCallIds.length ||
    toolCalls.some((toolCall) => !validProtectedToolCall(toolCall))
  ) {
    throw contextSwitchCompactionFailedError({
      preservedToolCount: protectedToolCallIds.filter(Boolean).length,
    });
  }

  const toolOutputs = currentMessages;
  const outputIds = toolOutputs.map((message) => message.tool_call_id || "");
  if (
    currentMessages.length !== toolOutputs.length ||
    outputIds.some((id) => !id) ||
    new Set(outputIds).size !== outputIds.length ||
    outputIds.length !== protectedToolCallIds.length ||
    protectedToolCallIds.some((id) => !outputIds.includes(id))
  ) {
    throw contextSwitchCompactionFailedError({
      preservedToolCount: protectedToolCallIds.length,
    });
  }

  const protectedSuffix = [activeCall, ...toolOutputs];
  if (estimatedMessagesTokens(protectedSuffix) > Number(targetPolicy.inputBudget || 0)) {
    throw contextSwitchCompactionFailedError({
      preservedToolCount: protectedToolCallIds.length,
    });
  }
  return {
    summaryMessages: priorMessages.slice(0, activeCallIndex),
    protectedMessages: [activeCall],
    protectedToolCallIds,
    preservedToolCount: protectedToolCallIds.length,
  };
}

function validProtectedToolCall(toolCall = {}) {
  return Boolean(
    (toolCall.id || toolCall.call_id) &&
    toolCall.function?.name &&
    typeof toolCall.function?.arguments === "string"
  );
}

function contextSwitchCompactedContextIsSafe(
  requestBody,
  route,
  history,
  compaction,
  targetPolicy,
  protectedToolCallIds = [],
) {
  const { messages } = responseRequestToChatSourceMessages(
    requestBody,
    route,
    history,
    { contextSwitchCompaction: compaction },
  );
  if (estimatedMessagesTokens(messages) > Number(targetPolicy.inputBudget || 0)) {
    return false;
  }
  if (protectedToolCallIds.length === 0) {
    return true;
  }
  return contextMessagesContainProtectedToolPair(messages, protectedToolCallIds);
}

function contextMessagesContainProtectedToolPair(messages = [], expectedIds = []) {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) {
      continue;
    }
    const callIds = message.tool_calls.map((toolCall) => toolCall?.id || toolCall?.call_id || "");
    if (
      callIds.length !== expectedIds.length ||
      expectedIds.some((id) => !callIds.includes(id))
    ) {
      continue;
    }
    const outputIds = [];
    for (let next = index + 1; next < messages.length && messages[next]?.role === "tool"; next += 1) {
      outputIds.push(messages[next].tool_call_id || "");
    }
    return (
      outputIds.length === expectedIds.length &&
      expectedIds.every((id) => outputIds.includes(id))
    );
  }
  return false;
}

function contextSwitchCompactionFailedError(options = {}) {
  const error = new Error("旧模型上下文压缩失败，已取消本次模型切换。");
  error.statusCode = 409;
  error.code = "context_switch_compaction_failed";
  error.localContextSwitchError = true;
  error.preservedToolCount = Number(options.preservedToolCount || 0);
  return error;
}

function contextSwitchPolicyForRoute(route = {}) {
  return contextPolicyForRoute(route, {
    defaultContextWindow: normalizeAdapterProfile(route).contextWindow,
  });
}

function shouldServeIdleResumeLocally(
  requestBody = {},
  route = {},
  history = null,
  context = {},
) {
  return (
    ["chat_completions", "responses"].includes(route.api) &&
    Boolean(requestBody.previous_response_id) &&
    !requestHasFreshInput(requestBody)
  );
}

function requestHasFreshInput(requestBody = {}) {
  return hasFreshInputValue(requestBody.messages) || hasFreshInputValue(requestBody.input);
}

function requestRepeatsPreviousUserContext(requestBody = {}, route = {}, history = null) {
  if (requestHasCurrentToolProtocolContinuation(requestBody, history)) {
    return false;
  }
  const previousId = requestBody.previous_response_id;
  const previousMeta = history?.getResponseMeta?.(previousId) || {};
  const previousUsers = previousUserInputSignatures(history, previousId, previousMeta);
  const currentUsers = userInputSignatures(requestBody.messages ?? requestBody.input);
  if (currentUsers.length === 0) {
    return true;
  }
  if (previousUsers.length === 0) {
    return false;
  }
  if (sameStringArray(currentUsers, previousUsers)) {
    return true;
  }
  const previousRouteId = previousMeta.routeId || "";
  const routeChanged = Boolean(previousRouteId && route.id && previousRouteId !== route.id);
  const previousUserCount = Number(previousMeta.userInputCount || previousUsers.length);
  const currentHasOpaqueUserInput = inputHasOpaqueUserInput(
    requestBody.messages ?? requestBody.input,
  );
  return (
    routeChanged &&
    Number.isFinite(previousUserCount) &&
    currentUsers.length <= previousUserCount &&
    Boolean(previousMeta.hasOpaqueUserInput || currentHasOpaqueUserInput)
  );
}

function requestHasCurrentToolProtocolContinuation(requestBody = {}, history = null) {
  if (!requestHasToolProtocolInput(requestBody)) {
    return false;
  }
  const previousId = requestBody.previous_response_id;
  if (!previousId || !history) {
    return true;
  }
  const previousResponse = history.getResponse?.(previousId);
  if (previousResponse) {
    return responseHasRunnableToolCall(previousResponse);
  }
  const previousMeta = history.getResponseMeta?.(previousId) || {};
  if (
    Array.isArray(previousMeta.toolCallSignatures) &&
    previousMeta.toolCallSignatures.length > 0
  ) {
    return true;
  }
  return !previousMeta.routeId;
}

function previousUserInputSignatures(history, previousId, previousMeta = {}) {
  if (Array.isArray(previousMeta.userInputSignatures)) {
    return previousMeta.userInputSignatures.filter(Boolean);
  }
  return userInputSignatures(history?.get?.(previousId) || []);
}

function hasFreshInputValue(value) {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.some(hasFreshInputValue);
  }
  if (typeof value !== "object") {
    return Boolean(value);
  }
  if (value.type === "compaction_trigger") {
    return false;
  }
  const text = contentToText(value.content ?? value.text ?? value.output ?? "");
  if (text.trim()) {
    return true;
  }
  return Boolean(
    isResponseToolCallItem(value) ||
      isResponseToolOutputItem(value) ||
      value.role ||
      value.type,
  );
}

function sendIdleResumeResponse(requestBody, route, history, res, context = {}) {
  const previousId = requestBody.previous_response_id;
  const stored = history?.getResponse?.(previousId);
  const response = stored && !responseHasRunnableToolCall(stored)
    ? stored
    : idleResumeNoopResponse(requestBody.model || route.id || route.model);
  console.warn(
    `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
      `!! idle-resume-guard route=${route.id || "-"} previous_response_id=${previousId}`,
  );
  if (requestBody.stream) {
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

function idleResumeNoopResponse(model) {
  const id = `resp_idle_resume_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const text =
    "检测到这次自动恢复请求没有新的用户输入，因此没有重复请求上游，避免额外消耗 token。请发送一条新消息继续当前任务。";
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: model || null,
    output: [
      {
        id: `msg_${id}`,
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
      },
    ],
    output_text: text,
    parallel_tool_calls: true,
    error: null,
    incomplete_details: null,
    usage: null,
  };
}

function beginDuplicateInitialRequestGuard(
  requestBody = {},
  route = {},
  res,
  context = {},
) {
  const guard = context.pendingRequestGuard;
  if (!guard || typeof guard.begin !== "function") {
    return { key: "", lease: null, served: false };
  }
  const result = guard.begin(
    {
      configRevision: context.configRevision || "",
      requestSurface: context.requestSurface || "responses",
      route,
      compactKind: context.compactKind || "",
      headers: context.clientHeaders || {},
      requestBody,
    },
    { enabled: context.duplicateRequestProtection === true },
  );
  if (result.status === "duplicate") {
    serveDuplicateInitialResponse(
      duplicateInitialRequestPendingResponse(requestBody, route, context),
      requestBody,
      route,
      res,
      context,
      "pending_exact",
    );
    return { key: result.fingerprint, lease: null, served: true };
  }
  if (result.status === "capacity_bypass") {
    console.warn(
      `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
        `!! duplicate-request-guard route=${route.id || "-"} reason=pending_guard_capacity`,
    );
  }
  if (result.status !== "owner") {
    return { key: "", lease: null, served: false };
  }
  return {
    key: result.fingerprint,
    lease: {
      fingerprint: result.fingerprint,
      ownershipToken: result.ownershipToken,
    },
    served: false,
  };
}

function releasePendingRequestGuard(context = {}) {
  return context.pendingRequestGuard?.release?.(context.pendingRequestLease) || false;
}

function serveDuplicateInitialResponse(response, requestBody, route, res, context = {}, reason = "duplicate") {
  console.warn(
    `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
      `!! duplicate-request-guard route=${route.id || "-"} reason=${reason}`,
  );
  if (requestBody.stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.end(
      context.compactKind === "v2"
        ? compactResponseToSse(response)
        : responseToSse(response),
    );
    return;
  }
  jsonResponse(res, 200, response);
}

function duplicateInitialRequestNoopResponse(model, text) {
  const id = `resp_duplicate_request_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const outputText = text ||
    "检测到重复的自动请求重放，因此没有重复请求上游，避免额外消耗 token。请发送一条新消息继续当前任务。";
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: model || null,
    output: [
      {
        id: `msg_${id}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: outputText,
            annotations: [],
          },
        ],
      },
    ],
    output_text: outputText,
    parallel_tool_calls: true,
    error: null,
    incomplete_details: null,
    usage: null,
  };
}

function duplicateInitialRequestPendingResponse(requestBody = {}, route = {}, context = {}) {
  if (context.compactKind) {
    return compactResponseFromLocalFallback(requestBody.model || route.id || route.model, {
      requestBody,
      reason:
        "上一次上下文压缩仍在进行，本次自动重放没有重复请求上游。请稍等上一轮请求完成，或发送新消息继续。",
    });
  }
  return duplicateInitialRequestNoopResponse(requestBody.model || route.id || route.model);
}

function requestHasToolProtocolInput(requestBody = {}) {
  return responseInputItems(requestBody.messages ?? requestBody.input).some((item) =>
    inputItemContainsToolProtocol(item),
  );
}

function inputItemContainsToolProtocol(item) {
  if (!item || typeof item !== "object") {
    return false;
  }
  if (isResponseToolCallItem(item) || isResponseToolOutputItem(item)) {
    return true;
  }
  if (Array.isArray(item.tool_calls) && item.tool_calls.length > 0) {
    return true;
  }
  if (String(item.role || "").toLowerCase() === "tool") {
    return true;
  }
  if (Array.isArray(item.content)) {
    return item.content.some(inputItemContainsToolProtocol);
  }
  return false;
}

function userInputSignatures(input) {
  return responseInputItems(input)
    .map((item) => normalizeUserInputSignature(userInputText(item)))
    .filter(Boolean);
}

function userInputText(item) {
  if (typeof item === "string") {
    return item;
  }
  if (!item || typeof item !== "object") {
    return "";
  }
  if (item.type === "input_text") {
    return item.text || "";
  }
  const role = String(item.role || "").toLowerCase();
  if (role !== "user" && !(item.type === "message" && role === "user")) {
    return "";
  }
  return contentToText(
    item.content ?? item.text ?? item.output ?? item.encrypted_content ?? "",
  );
}

function normalizeUserInputSignature(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text ? boundedSignatureText(text) : "";
}

function inputHasOpaqueUserInput(input) {
  return opaqueUserInputProfile(input).hasOpaqueUserInput;
}

function opaqueUserInputProfile(input) {
  const items = responseInputItems(input);
  const profile = {
    itemCount: items.length,
    userInputCount: 0,
    opaqueUserInputCount: 0,
    visibleUserInputCount: 0,
    latestUserIndex: -1,
    hasOpaqueUserInput: false,
  };
  items.forEach((item, index) => {
    if (!item || typeof item !== "object") {
      if (typeof item === "string" && item.trim()) {
        profile.userInputCount += 1;
        profile.visibleUserInputCount += 1;
        profile.latestUserIndex = index;
      }
      return;
    }
    const role = String(item.role || "").toLowerCase();
    if (role !== "user" && !(item.type === "message" && role === "user")) {
      return;
    }
    profile.userInputCount += 1;
    profile.latestUserIndex = index;
    const visibleText = contentToText(item.content ?? item.text ?? item.output ?? "");
    if (visibleText.trim()) {
      profile.visibleUserInputCount += 1;
    }
    if (
      typeof item.encrypted_content === "string" &&
      item.encrypted_content.trim().length > 0
    ) {
      profile.opaqueUserInputCount += 1;
      profile.hasOpaqueUserInput = true;
    }
  });
  return profile;
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
    {
      contextSwitchCompaction: context.contextSwitchCompaction,
    },
  );
  logToolDiagnostics(
    context,
    route,
    toolDiagnosticsFromContext(toolContext, requestBody.tool_choice || ""),
    "responses-native",
  );
  if (context.contextSwitchCompaction || shouldInlineLocalHistoryForResponses(requestBody, history)) {
    inlineLocalHistoryForResponsesPayload(payload, sourceMessages);
  }
  normalizeBridgePlainCompactionPayload(payload, route, context);

  const upstreamPayload = filterPayloadForUpstream(
    payload,
    route,
    context,
    { api: "responses" },
  );
  const upstreamPath = context.compactKind === "v1" ? "/responses/compact" : "/responses";
  const upstreamUrl = joinOpenAiEndpointUrl(responsesBaseUrlForRoute(route), upstreamPath);
  let activeUpstreamUrl = upstreamUrl;
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
    upstream = await fetchUpstream(activeUpstreamUrl, upstreamInit, context, route, {
      streamingResponse: Boolean(upstreamPayload.stream),
    });
    logStatus(context, route, upstream.status);
    const fallbackUrl = responsesV1FallbackUrl(route, activeUpstreamUrl, upstreamPath);
    if (fallbackUrl && upstreamResponseLooksHtml(upstream)) {
      console.warn(
        `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
          `!! upstream route=${route.id} returned HTML at root responses endpoint; ` +
          `retrying ${safeUrl(fallbackUrl)}`,
      );
      await cancelUpstreamResponse(upstream);
      activeUpstreamUrl = fallbackUrl;
      logRoute(context, route, activeUpstreamUrl);
      upstream = await fetchUpstream(activeUpstreamUrl, upstreamInit, context, route, {
        streamingResponse: Boolean(upstreamPayload.stream),
      });
      logStatus(context, route, upstream.status);
    }
  } catch (error) {
    throw error;
  }

  if (!upstream.ok) {
    const bodyText = await upstream.text();
    const completedResponse = extractResponsesObject(bodyText);
    if (
      upstreamPayload.stream &&
      looksLikeSseResponse(bodyText) &&
      responsesSseStreamComplete(bodyText) &&
      isCompletedResponsesObject(completedResponse)
    ) {
      console.warn(
        `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
          `!! upstream route=${route.id} returned HTTP ${upstream.status} with completed Responses SSE; ` +
          "treating stream as completed for compatibility",
      );
      recordResponsesHistory(history, completedResponse, sourceMessages, toolContext, {
        requestBody,
        route,
      });
      logUsage(context, route, extractUsageObject(completedResponse) || extractResponsesUsage(bodyText));
      res.writeHead(200, {
        ...filteredHeaders(upstream.headers),
        "content-type": "text/event-stream; charset=utf-8",
      });
      res.end(bodyText);
      return;
    }
    if (
      !upstreamPayload.stream &&
      looksLikeSseResponse(bodyText) &&
      responsesSseStreamComplete(bodyText) &&
      isCompletedResponsesObject(completedResponse)
    ) {
      console.warn(
        `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
          `!! upstream route=${route.id} returned HTTP ${upstream.status} with completed Responses SSE; ` +
          "returning completed response JSON for compatibility",
      );
      recordResponsesHistory(history, completedResponse, sourceMessages, toolContext, {
        requestBody,
        route,
      });
      logUsage(context, route, extractUsageObject(completedResponse) || extractResponsesUsage(bodyText));
      jsonResponse(res, 200, completedResponse);
      return;
    }
    const error = new UpstreamHttpError(upstream.status, bodyText, activeUpstreamUrl, route, {
      headers: upstream.headers,
    });
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
    if (!isCompletedResponsesObject(completedResponse)) {
      throw new UpstreamHttpError(
        502,
        `Upstream returned a forced stream without a completed response: ${responseText.slice(0, 500)}`,
        activeUpstreamUrl,
        route,
      );
    }
    recordResponsesHistory(history, completedResponse, sourceMessages, toolContext, {
      requestBody,
      route,
    });
    logUsage(context, route, extractUsageObject(completedResponse) || extractResponsesUsage(responseText));
    jsonResponse(res, upstream.status, completedResponse);
    return;
  }

  if (!upstreamPayload.stream || !responseUsesEventStream(upstream)) {
    const responseText = upstream.body ? await upstream.text() : "";
    const completedResponse = extractResponsesObject(responseText);
    if (!isCompletedResponsesObject(completedResponse)) {
      throw new UpstreamHttpError(
        502,
        `Upstream returned HTTP ${upstream.status} without a completed response: ` +
          responseText.slice(0, 500),
        activeUpstreamUrl,
        route,
      );
    }
    recordResponsesHistory(history, completedResponse, sourceMessages, toolContext, {
      requestBody,
      route,
    });
    logUsage(
      context,
      route,
      extractUsageObject(completedResponse) || extractResponsesUsage(responseText),
    );
    res.writeHead(upstream.status, filteredHeaders(upstream.headers));
    res.end(responseText);
    return;
  }

  res.writeHead(upstream.status, filteredHeaders(upstream.headers));
  if (!upstream.body) {
    const message =
      `CodexBridge upstream stream from ${route.displayName || route.id || route.model || "route"} ` +
      "ended without a response body.";
    res.end(buildResponsesStreamErrorSse(message, {
      model: requestBody.model || route.id || route.model || null,
    }));
    throw new UpstreamStreamError(message, activeUpstreamUrl, route, "upstream_stream_truncated");
  }
  const pendingEvent = createSseBlockAccumulator();
  let diagnosticTail = "";
  const terminalBuffer = createTextBuffer();
  let terminalStarted = false;
  let streamError = null;
  try {
    for await (const chunk of upstream.body) {
      const blocks = takeCompleteSseBlocks(pendingEvent, Buffer.from(chunk));
      for (const block of blocks) {
        if (terminalStarted || responsesSseStreamComplete(block)) {
          terminalStarted = true;
          appendTerminalText(terminalBuffer, block);
          continue;
        }
        diagnosticTail = appendDiagnosticTail(diagnosticTail, block);
        res.write(block);
      }
    }
    const pendingText = finishSseBlockAccumulator(pendingEvent);
    if (pendingText) {
      if (terminalStarted || responsesSseStreamComplete(pendingText)) {
        terminalStarted = true;
        appendTerminalText(terminalBuffer, pendingText);
      } else {
        diagnosticTail = appendDiagnosticTail(diagnosticTail, pendingText);
        res.write(pendingText);
      }
    }
  } catch (error) {
    streamError = error;
  }
  const terminalText = textBufferValue(terminalBuffer);
  const completedResponse = extractResponsesObject(`${diagnosticTail}${terminalText}`);
  const usage = extractUsageObject(completedResponse) ||
    extractResponsesUsage(`${diagnosticTail}${terminalText}`);
  if (streamError) {
    if (isClientClosedStreamWrite(context, res, streamError)) {
      logUsage(context, route, usage);
      throw new ClientClosedRequestError();
    }
    if (streamError instanceof UpstreamTimeoutError) {
      if (!res.destroyed && !res.writableEnded) {
        res.write(buildResponsesStreamErrorSse("上游流式响应超时，请稍后重试。", {
          code: "upstream_timeout",
          model: requestBody.model || route.id || route.model || null,
        }));
        res.end();
      }
      logUsage(context, route, usage);
      throw streamError;
    }
    if (streamError?.localHistoryError) {
      const localError = asLocalHistoryStorageError(streamError);
      const message = "本地模型历史保存失败，请新建会话后重试。";
      if (!res.destroyed && !res.writableEnded) {
        res.write(buildResponsesStreamErrorSse(message, {
          code: "local_history_storage_unavailable",
          model: requestBody.model || route.id || route.model || null,
        }));
        res.end();
      }
      logUsage(context, route, usage);
      throw localError;
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
  if (!terminalStarted || !responsesSseStreamComplete(terminalText)) {
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

  const terminalKind = responsesTerminalKind(terminalText);
  if (isPassThroughNonSuccessTerminal(terminalKind, completedResponse)) {
    res.end(terminalText);
    logUsage(context, route, usage);
    return;
  }
  if (!isCompletedResponsesObject(completedResponse)) {
    const message =
      `CodexBridge upstream stream from ${route.displayName || route.id || route.model || "route"} ` +
      "ended with an invalid terminal event and no completed response.";
    if (!res.destroyed && !res.writableEnded) {
      res.end(buildResponsesStreamErrorSse(message, {
        code: "upstream_stream_invalid_terminal",
        model: requestBody.model || route.id || route.model || null,
      }));
    }
    logUsage(context, route, usage);
    throw new UpstreamStreamError(
      message,
      activeUpstreamUrl,
      route,
      "upstream_stream_invalid_terminal",
    );
  }

  try {
    recordResponsesHistory(history, completedResponse, sourceMessages, toolContext, {
      requestBody,
      route,
    });
  } catch (error) {
    const localError = asLocalHistoryStorageError(error);
    const message = "本地模型历史保存失败，请新建会话后重试。";
    if (!res.destroyed && !res.writableEnded) {
      res.end(buildResponsesStreamErrorSse(message, {
        code: "local_history_storage_unavailable",
        model: requestBody.model || route.id || route.model || null,
      }));
    }
    logUsage(context, route, usage);
    throw localError;
  }
  logUsage(context, route, usage);
  res.end(terminalText);
}

function responseUsesEventStream(response) {
  return /text\/event-stream/i.test(String(response?.headers?.get?.("content-type") || ""));
}

function responsesTerminalKind(text = "") {
  for (const event of parseSseEvents(text)) {
    const data = event.data.trim();
    if (data === "[DONE]") {
      return "done";
    }
    const type = event.event || tryParseJson(data)?.type || "";
    if ([
      "response.completed",
      "response.failed",
      "response.incomplete",
      "response.cancelled",
    ].includes(type)) {
      return type;
    }
  }
  return "";
}

function isPassThroughNonSuccessTerminal(kind, response) {
  const expectedStatus = {
    "response.failed": "failed",
    "response.incomplete": "incomplete",
    "response.cancelled": "cancelled",
  }[kind];
  return Boolean(
    expectedStatus &&
      isResponsesObject(response) &&
      String(response.status || "").toLowerCase() === expectedStatus,
  );
}

function createSseBlockAccumulator() {
  return {
    parts: [],
    byteLength: 0,
    separatorTail: [],
  };
}

function takeCompleteSseBlocks(state, chunk) {
  const blocks = [];
  let segmentStart = 0;
  for (let index = 0; index < chunk.length; index += 1) {
    state.separatorTail.push(chunk[index]);
    if (state.separatorTail.length > 4) {
      state.separatorTail.shift();
    }
    assertSseEventBufferSize(state.byteLength + index - segmentStart + 1);
    if (!sseSeparatorEndsTail(state.separatorTail)) {
      continue;
    }
    addSseAccumulatorPart(state, chunk.subarray(segmentStart, index + 1));
    blocks.push(Buffer.concat(state.parts, state.byteLength).toString("utf8"));
    state.parts = [];
    state.byteLength = 0;
    state.separatorTail = [];
    segmentStart = index + 1;
  }
  addSseAccumulatorPart(state, chunk.subarray(segmentStart));
  return blocks;
}

function finishSseBlockAccumulator(state) {
  if (state.byteLength === 0) {
    return "";
  }
  const value = Buffer.concat(state.parts, state.byteLength).toString("utf8");
  state.parts = [];
  state.byteLength = 0;
  state.separatorTail = [];
  return value;
}

function addSseAccumulatorPart(state, part) {
  if (!part?.length) {
    return;
  }
  assertSseEventBufferSize(state.byteLength + part.length);
  state.parts.push(part);
  state.byteLength += part.length;
}

function assertSseEventBufferSize(byteLength) {
  if (byteLength > MAX_RESPONSES_SSE_EVENT_BUFFER_BYTES) {
    throw localHistoryBufferError(
      `Responses SSE event exceeds ${MAX_RESPONSES_SSE_EVENT_BUFFER_BYTES} bytes.`,
    );
  }
}

function sseSeparatorEndsTail(tail) {
  const length = tail.length;
  if (
    length >= 4 &&
    tail[length - 4] === 13 &&
    tail[length - 3] === 10 &&
    tail[length - 2] === 13 &&
    tail[length - 1] === 10
  ) {
    return true;
  }
  return length >= 2 && (
    (tail[length - 2] === 10 && tail[length - 1] === 10) ||
    (tail[length - 2] === 13 && tail[length - 1] === 13)
  );
}

function createTextBuffer() {
  return { parts: [], byteLength: 0 };
}

function appendTerminalText(state, value) {
  const byteLength = Buffer.byteLength(value, "utf8");
  if (state.byteLength + byteLength > MAX_RESPONSES_TERMINAL_BUFFER_BYTES) {
    throw localHistoryBufferError(
      `Responses terminal event exceeds ${MAX_RESPONSES_TERMINAL_BUFFER_BYTES} bytes.`,
    );
  }
  state.parts.push(value);
  state.byteLength += byteLength;
}

function textBufferValue(state) {
  return state.parts.join("");
}

function localHistoryBufferError(message) {
  const error = new Error(message);
  error.statusCode = 503;
  error.code = "local_history_storage_unavailable";
  error.localHistoryError = true;
  return error;
}

function appendDiagnosticTail(current, value) {
  const next = `${current}${value}`;
  return next.length > 2_000_000 ? next.slice(-2_000_000) : next;
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
    code === "client_closed_request" ||
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

export async function proxyDirectChatCompletions(
  requestBody,
  route,
  res,
  context = {},
) {
  const payload = cloneJson(requestBody);
  payload.model = route.model;

  if (payload.stream) {
    return proxyDirectChatCompletionsStream(payload, route, res, context);
  }

  const upstreamUrl = joinOpenAiEndpointUrl(route.baseUrl, "/chat/completions");
  logRoute(context, route, upstreamUrl);
  const upstream = await callChatCompletionsUpstream(
    upstreamUrl,
    route,
    payload,
    context,
  );
  logUsage(context, route, upstream.usage);
  jsonResponse(res, 200, upstream);
}

async function proxyDirectChatCompletionsStream(
  payload,
  route,
  res,
  context = {},
) {
  const upstreamPayload = filterPayloadForUpstream(
    payload,
    route,
    context,
    { api: "chat_completions" },
  );
  const upstreamUrl = joinOpenAiEndpointUrl(route.baseUrl, "/chat/completions");
  let activeUpstreamUrl = upstreamUrl;
  logRoute(context, route, upstreamUrl);

  let upstream;
  try {
    const upstreamInit = {
      method: "POST",
      headers: upstreamHeaders(route, context, {
        acceptEventStream: true,
      }),
      body: JSON.stringify(upstreamPayload),
    };
    upstream = await fetchUpstream(activeUpstreamUrl, upstreamInit, context, route, {
      streamingResponse: Boolean(payload.stream),
    });
    logStatus(context, route, upstream.status);

    const fallbackUrl = chatCompletionsRootFallbackUrl(route, activeUpstreamUrl);
    if (fallbackUrl && upstreamResponseLooksHtml(upstream)) {
      console.warn(
        `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
          `!! upstream route=${route.id} returned HTML at root chat endpoint; ` +
          `retrying ${safeUrl(fallbackUrl)}`,
      );
      await cancelUpstreamResponse(upstream);
      activeUpstreamUrl = fallbackUrl;
      logRoute(context, route, activeUpstreamUrl);
      upstream = await fetchUpstream(activeUpstreamUrl, upstreamInit, context, route, {
        streamingResponse: Boolean(payload.stream),
      });
      logStatus(context, route, upstream.status);
    }
  } catch (error) {
    throw error;
  }

  if (!upstream.ok) {
    const bodyText = await upstream.text();
    const error = new UpstreamHttpError(upstream.status, bodyText, activeUpstreamUrl, route, {
      headers: upstream.headers,
    });
    throw error;
  }

  res.writeHead(upstream.status, {
    ...filteredHeaders(upstream.headers),
    "content-type":
      upstream.headers.get("content-type") || "text/event-stream; charset=utf-8",
  });
  if (!upstream.body) {
    logUsage(context, route, null);
    res.end();
    return;
  }

  try {
    for await (const chunk of upstream.body) {
      res.write(Buffer.from(chunk));
    }
    logUsage(context, route, null);
    res.end();
  } catch (error) {
    if (
      error instanceof ClientClosedRequestError ||
      error instanceof UpstreamTimeoutError
    ) {
      throw error;
    }
    throw new UpstreamStreamError(
      `CodexBridge upstream chat stream from ${route.displayName || route.id || route.model || "route"} disconnected before completion.`,
      activeUpstreamUrl,
      route,
      "upstream_stream_truncated",
    );
  }
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

function budgetResponsesCompactPayload(payload, route, history) {
  const { messages: sourceMessages, toolContext } = responseRequestToChatSourceMessages(
    payload,
    route,
    history,
  );
  const contextPolicy = contextSwitchPolicyForRoute(route);
  const beforeTokens = estimatedMessagesTokens(sourceMessages);
  const budgetedMessages = trimMessagesToRouteContext(sourceMessages, route, {
    contextPolicy,
  });
  const afterTokens = estimatedMessagesTokens(budgetedMessages);
  const preservedToolCount = preservedToolBoundaryCount(budgetedMessages);
  inlineLocalHistoryForResponsesPayload(payload, budgetedMessages);
  const contextMetrics = {
    policyId: contextPolicy.policyId,
    policyVersion: contextPolicy.version,
    inputBudget: contextPolicy.inputBudget,
    compactThreshold: contextPolicy.compactThreshold,
    estimatedTokens: beforeTokens,
    beforeTokens,
    afterTokens,
    preservedToolCount,
  };
  return {
    sourceMessages,
    budgetedMessages,
    toolContext,
    contextMetrics,
    contextDecision: beforeTokens > contextPolicy.inputBudget
      ? {
          event: "context_truncation",
          kind: "compact_payload",
          policyId: contextPolicy.policyId,
          policyVersion: contextPolicy.version,
          inputBudget: contextPolicy.inputBudget,
          beforeTokens,
          afterTokens,
          preservedToolCount,
          outcome: "truncated",
          reasonCode: "compact_input_budget_exceeded",
        }
      : null,
  };
}

function normalizeBridgePlainCompactionPayload(payload, route = {}, context = {}) {
  if (route.api !== "responses") {
    return;
  }
  const normalizedInput = normalizeBridgeCompactionInput(payload.input, context);
  if (normalizedInput !== payload.input) {
    payload.input = normalizedInput;
  }
  if (payload.messages !== undefined) {
    const normalizedMessages = normalizeBridgeCompactionInput(payload.messages, context);
    if (normalizedMessages !== payload.messages) {
      payload.messages = normalizedMessages;
    }
  }
}

function normalizeBridgeCompactionInput(input, context = {}) {
  if (!Array.isArray(input)) {
    return input;
  }
  let changed = false;
  const normalized = input.map((item) => {
    if (!isBridgePlainCompactionItem(item)) {
      return item;
    }
    changed = true;
    const text = String(item.encrypted_content || "");
    console.warn(
      `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
        "!! compact-plaintext-context normalized bridge compaction for responses upstream",
    );
    return {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text,
        },
      ],
    };
  });
  return changed ? normalized : input;
}

function isBridgePlainCompactionItem(item) {
  return (
    (item?.type === "compaction" || item?.type === "context_compaction") &&
    typeof item.encrypted_content === "string" &&
    item.encrypted_content.startsWith(COMPACT_SUMMARY_PREFIX)
  );
}

function chatMessagesToResponsesInput(messages) {
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
  const content = chatContentToResponsesContent(
    message.content,
    role,
  );
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

export async function proxyChatCompletions(
  requestBody,
  route,
  history,
  res,
  context = {},
) {
  const converted = responsesToChatRequest(requestBody, route, history, {
    capabilityProviders: context.capabilityProviders,
    contextSwitchCompaction: context.contextSwitchCompaction,
  });
  logContextTruncationDecision(context, route, converted.contextDecision);
  logToolDiagnostics(context, route, converted.toolDiagnostics, "chat-compat");
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
      throw error;
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
  let adjustedUpstream = enforceInteractivePluginBootstrap(
    upstream,
    requestBody,
    converted,
    context,
  );
  const bridgeContinuation = await continueChatWithBridgeCapability({
    upstreamUrl,
    adjustedUpstream,
    converted,
    route,
    context,
  });
  if (bridgeContinuation) {
    logReturnedToolDiagnostics(
      context,
      route,
      returnedToolDiagnosticsFromChat(adjustedUpstream, converted.toolContext),
      "chat-compat",
    );
    logUsage(context, route, adjustedUpstream.usage);
    messagesForHistory = [
      ...messagesForHistory,
      bridgeContinuation.assistantMessage,
      ...bridgeContinuation.toolMessages,
    ];
    adjustedUpstream = enforceInteractivePluginBootstrap(
      bridgeContinuation.upstream,
      requestBody,
      converted,
      context,
    );
  }
  adjustedUpstream = blockCommandFallbackForControlledCapability(
    adjustedUpstream,
    requestBody,
    converted,
    context,
  );
  logReturnedToolDiagnostics(
    context,
    route,
    returnedToolDiagnosticsFromChat(adjustedUpstream, converted.toolContext),
    "chat-compat",
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
  response = annotateSmartFailoverResponse(response, route, context);

  recordHistoryTurn(
    history,
    response,
    [
      ...messagesForHistory,
      assistantHistoryMessageFromChat(chatForHistory, converted.toolContext),
    ],
    {
      api: "chat_completions",
      routeId: route.id || "",
      upstreamModel: route.model || "",
      upstreamKnown: false,
      ...responseRequestUserMeta(requestBody),
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
    },
    { requestBody, route },
  );
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

function annotateSmartFailoverResponse(response = {}, route = {}, context = {}) {
  const fromRoute = safeText(context.failoverFromRoute || "", 120);
  const reason = safeText(context.smartFailoverReason || "", 120);
  if (!fromRoute || !reason || !response || typeof response !== "object") {
    return response;
  }
  const metadata = {
    fromRoute,
    fromModel: safeText(context.failoverFromModel || "", 160),
    toRoute: safeText(route.id || "", 120),
    toModel: safeText(route.model || "", 160),
    reason,
  };
  response.codexbridge_smart_failover = metadata;
  const note = smartFailoverNotice(metadata, {
    fromDisplayName: context.failoverFromDisplayName,
    toDisplayName: route.displayName || route.id || route.model,
  });
  if (note) {
    prependResponseOutputText(response, note);
  }
  return response;
}

function smartFailoverNotice(metadata = {}, labels = {}) {
  const fromLabel = labels.fromDisplayName || metadata.fromModel || metadata.fromRoute || "原模型";
  const toLabel = labels.toDisplayName || metadata.toModel || metadata.toRoute || "备用模型";
  const reason = smartFailoverReasonLabel(metadata.reason);
  return `已自动切换模型：${fromLabel} -> ${toLabel}。原因：${reason}。`;
}

function smartFailoverReasonLabel(reason = "") {
  const labels = {
    rate_limited: "原供应商限流",
    quota_or_balance: "原供应商余额或额度不足",
    upstream_unavailable: "原供应商暂时不可用",
  };
  return labels[reason] || reason || "原供应商请求失败";
}

function prependResponseOutputText(response = {}, note = "") {
  const cleanNote = String(note || "").trim();
  if (!cleanNote) {
    return;
  }
  const oldText = String(response.output_text || "").trim();
  response.output_text = oldText ? `${cleanNote}\n\n${oldText}` : cleanNote;
  const output = Array.isArray(response.output) ? response.output : [];
  for (const item of output) {
    if (!item || item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    const textPart = item.content.find((part) => part?.type === "output_text" && typeof part.text === "string");
    if (textPart) {
      const text = textPart.text.trim();
      textPart.text = text ? `${cleanNote}\n\n${text}` : cleanNote;
      return;
    }
  }
  if (!output.length) {
    response.output = [
      {
        id: `msg_${response.id || Date.now().toString(36)}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: response.output_text,
            annotations: [],
          },
        ],
      },
    ];
  }
}

async function continueChatWithBridgeCapability({
  upstreamUrl,
  adjustedUpstream,
  converted,
  route,
  context = {},
}) {
  const toolCalls = chatMessageToolCalls(adjustedUpstream);
  if (toolCalls.length === 0 || typeof context.executeCapabilityRequest !== "function") {
    return null;
  }
  const bridgeCalls = toolCalls.filter(isBridgeCapabilityToolCall);
  if (bridgeCalls.length === 0 || bridgeCalls.length !== toolCalls.length) {
    return null;
  }

  const assistantMessage = {
    role: "assistant",
    content: adjustedUpstream?.choices?.[0]?.message?.content ?? null,
    tool_calls: bridgeCalls,
  };
  const toolMessages = [];
  for (const toolCall of bridgeCalls) {
    toolMessages.push(await bridgeCapabilityToolMessage(toolCall, context));
  }
  const body = {
    ...converted.body,
    messages: [
      ...converted.body.messages,
      assistantMessage,
      ...toolMessages,
    ],
    stream: false,
  };
  delete body.tools;
  delete body.tool_choice;
  delete body.parallel_tool_calls;

  console.log(
    `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
      `codexbridge_capability_continue route=${route.id} calls=${bridgeCalls.length}`,
  );
  logRoute(context, route, upstreamUrl);
  const upstream = await callChatCompletionsUpstream(
    upstreamUrl,
    route,
    body,
    context,
    { trackRateLimit: false },
  );
  return { upstream, assistantMessage, toolMessages };
}

function chatMessageToolCalls(chat = {}) {
  const toolCalls = chat?.choices?.[0]?.message?.tool_calls;
  return Array.isArray(toolCalls) ? toolCalls : [];
}

function isBridgeCapabilityToolCall(toolCall = {}) {
  const name = toolCall?.function?.name || toolCall?.name || "";
  return name === CODEXBRIDGE_CAPABILITY_TOOL_NAME;
}

async function bridgeCapabilityToolMessage(toolCall = {}, context = {}) {
  const parsed = parseBridgeCapabilityToolCall(toolCall);
  if (!parsed.ok) {
    return bridgeCapabilityErrorToolMessage(toolCall, parsed.error);
  }
  try {
    const result = await context.executeCapabilityRequest(parsed.request);
    return {
      role: "tool",
      tool_call_id: bridgeToolCallId(toolCall),
      content: bridgeCapabilityToolContent(result),
    };
  } catch (error) {
    return bridgeCapabilityErrorToolMessage(toolCall, error);
  }
}

function parseBridgeCapabilityToolCall(toolCall = {}) {
  const rawArgs = toolCall?.function?.arguments ?? toolCall?.arguments ?? {};
  const args = typeof rawArgs === "string" ? tryParseJson(rawArgs) : rawArgs;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {
      ok: false,
      error: new Error("codexbridge_capability arguments must be a JSON object."),
    };
  }
  const capability = String(args.capability || "").trim().toLowerCase();
  const action = String(args.action || args.input?.action || "").trim().toLowerCase();
  const input = args.input && typeof args.input === "object" && !Array.isArray(args.input)
    ? { ...args.input }
    : {};
  if (capability === "browser" && action === "read_url") {
    const url = normalizeBridgeHttpUrl(input.url || args.url || "");
    if (!url) {
      return {
        ok: false,
        error: new Error("browser/read_url only accepts http/https URLs or safe bare domains."),
      };
    }
    input.url = url;
    input.action = "read_url";
    return {
      ok: true,
      request: {
        capability: "browser",
        providerId: String(args.providerId || args.provider_id || "").trim(),
        input,
      },
    };
  }
  if (capability === "browser" && action === "open_url") {
    const url = normalizeBridgeHttpUrl(input.url || args.url || "");
    if (!url) {
      return {
        ok: false,
        error: new Error("browser/open_url only accepts http/https URLs or safe bare domains."),
      };
    }
    input.url = url;
    input.action = "open_url";
    return {
      ok: true,
      request: {
        capability: "browser",
        providerId: String(args.providerId || args.provider_id || "").trim(),
        input,
      },
    };
  }
  if (capability === "computer_use" && action === "list_apps") {
    input.action = "list_apps";
    return {
      ok: true,
      request: {
        capability: "computer_use",
        providerId: String(args.providerId || args.provider_id || "").trim(),
        input,
      },
    };
  }
  if (capability === "computer_use" && action === "open_app") {
    const app = String(
      input.app ||
        input.application ||
        input.appId ||
        input.app_id ||
        input.name ||
        input.target ||
        args.app ||
        args.application ||
        args.appId ||
        args.app_id ||
        args.name ||
        args.target ||
        "",
    ).trim();
    if (!app) {
      return {
        ok: false,
        error: new Error("computer_use/open_app requires an allowlisted app name."),
      };
    }
    input.app = app;
    input.action = "open_app";
    return {
      ok: true,
      request: {
        capability: "computer_use",
        providerId: String(args.providerId || args.provider_id || "").trim(),
        input,
      },
    };
  }
  if (capability === "computer_use" && action === "screenshot_desktop") {
    const displayId = String(input.displayId || input.display_id || args.displayId || args.display_id || "").trim();
    input.action = "screenshot_desktop";
    if (displayId) {
      input.displayId = displayId;
    }
    return {
      ok: true,
      request: {
        capability: "computer_use",
        providerId: String(args.providerId || args.provider_id || "").trim(),
        input,
      },
    };
  }
  if (capability === "web_search" && action === "search") {
    const query = String(input.query || args.query || "").trim();
    if (!query) {
      return {
        ok: false,
        error: new Error("web_search/search requires a non-empty query."),
      };
    }
    input.query = query;
    input.action = "search";
    return {
      ok: true,
      request: {
        capability: "web_search",
        providerId: String(args.providerId || args.provider_id || "").trim(),
        input,
      },
    };
  }
  if (capability === "webpage_screenshot" && action === "screenshot_url") {
    const url = normalizeBridgeHttpUrl(input.url || args.url || "");
    if (!url) {
      return {
        ok: false,
        error: new Error("webpage_screenshot/screenshot_url only accepts http/https URLs or safe bare domains."),
      };
    }
    input.url = url;
    input.action = "screenshot_url";
    return {
      ok: true,
      request: {
        capability: "webpage_screenshot",
        providerId: String(args.providerId || args.provider_id || "").trim(),
        input,
      },
    };
  }
  if (capability === "ocr" && action === "extract_text") {
    const imageUrl = normalizeBridgeHttpUrl(
      input.imageUrl ||
        input.image_url ||
        input.url ||
        args.imageUrl ||
        args.image_url ||
        args.url ||
        "",
    );
    if (!imageUrl) {
      return {
        ok: false,
        error: new Error("ocr/extract_text only accepts http/https image URLs or safe bare domains."),
      };
    }
    input.imageUrl = imageUrl;
    input.action = "extract_text";
    return {
      ok: true,
      request: {
        capability: "ocr",
        providerId: String(args.providerId || args.provider_id || "").trim(),
        input,
      },
    };
  }
  if (capability === "file_processing" && (action === "extract_text" || action === "inspect_file")) {
    const rawFileUrl =
      input.fileUrl ||
      input.file_url ||
      input.url ||
      args.fileUrl ||
      args.file_url ||
      args.url ||
      "";
    const fileUrl = normalizeBridgeHttpUrl(
      rawFileUrl,
    );
    const localPath = String(
      input.path ||
        input.filePath ||
        input.file_path ||
        input.localPath ||
        input.local_path ||
        args.path ||
        args.filePath ||
        args.file_path ||
        args.localPath ||
        args.local_path ||
        "",
    ).trim();
    if (localPath && !fileUrl) {
      input.path = localPath;
      input.action = action;
      return {
        ok: true,
        request: {
          capability: "file_processing",
          providerId: String(args.providerId || args.provider_id || "").trim(),
          input,
        },
      };
    }
    if (String(rawFileUrl || "").trim() && !fileUrl) {
      return {
        ok: false,
        error: new Error(`file_processing/${action} only accepts http/https file URLs or safe bare domains.`),
      };
    }
    if (!fileUrl) {
      return {
        ok: false,
        error: new Error(
          `file_processing/${action} only accepts http/https file URLs, safe bare domains, or an explicit local file path for a local_file provider.`,
        ),
      };
    }
    input.fileUrl = fileUrl;
    input.action = action;
    return {
      ok: true,
      request: {
        capability: "file_processing",
        providerId: String(args.providerId || args.provider_id || "").trim(),
        input,
      },
    };
  }
  if (capability === "speech" && action === "synthesize") {
    const text = String(input.text || input.prompt || args.text || args.prompt || "").trim();
    if (!text) {
      return {
        ok: false,
        error: new Error("speech/synthesize requires non-empty text."),
      };
    }
    input.text = text;
    input.action = "synthesize";
    return {
      ok: true,
      request: {
        capability: "speech",
        providerId: String(args.providerId || args.provider_id || "").trim(),
        input,
      },
    };
  }
  if (capability === "video" && action === "generate") {
    const prompt = String(input.prompt || input.text || args.prompt || args.text || "").trim();
    if (!prompt) {
      return {
        ok: false,
        error: new Error("video/generate requires a non-empty prompt."),
      };
    }
    input.prompt = prompt;
    input.action = "generate";
    return {
      ok: true,
      request: {
        capability: "video",
        providerId: String(args.providerId || args.provider_id || "").trim(),
        input,
      },
    };
  }
  if (capability === "computer_use") {
    return {
      ok: false,
      error: new Error(
        "本地 Computer Use 的 CodexBridge 中转层目前只支持 computer_use/list_apps 查看白名单、computer_use/open_app 打开白名单应用，" +
          "以及 computer_use/screenshot_desktop 获取桌面截图；不会执行点击、键盘输入、拖拽、任意命令或脚本。 " +
          "如果需要完整的原生 Computer Use，请切换到 GPT/OpenAI Responses 路由。",
      ),
    };
  }
  return {
    ok: false,
    error: new Error(
      "codexbridge_capability only supports browser/read_url, browser/open_url, computer_use/list_apps, computer_use/open_app, computer_use/screenshot_desktop, web_search/search, webpage_screenshot/screenshot_url, ocr/extract_text, file_processing/extract_text, file_processing/inspect_file, speech/synthesize, and video/generate.",
    ),
  };
}

function normalizeBridgeHttpUrl(raw = "") {
  const value = String(raw || "").trim();
  if (!value || /[\u0000-\u001f\s]/.test(value) || value.includes("\\") || value.includes("@")) {
    return "";
  }
  const parsedDirect = parseAllowedBridgeHttpUrl(value);
  if (parsedDirect) {
    return parsedDirect;
  }
  if (!looksLikeBareBridgeHttpUrl(value)) {
    return "";
  }
  return parseAllowedBridgeHttpUrl(`https://${value}`);
}

function parseAllowedBridgeHttpUrl(value = "") {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function looksLikeBareBridgeHttpUrl(value = "") {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("/") || value.startsWith("//")) {
    return false;
  }
  const host = String(value).split(/[/?#]/, 1)[0];
  if (!host || host.includes("..")) {
    return false;
  }
  const hostname = host.split(":", 1)[0];
  if (hostname === "localhost" || isBridgeIpv4(hostname)) {
    return true;
  }
  return hostname.includes(".") && hostname
    .split(".")
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function isBridgeIpv4(value = "") {
  const parts = String(value).split(".");
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }
    const numeric = Number(part);
    return numeric >= 0 && numeric <= 255;
  });
}

function bridgeCapabilityToolContent(result = {}) {
  const response = result?.response && typeof result.response === "object"
    ? result.response
    : result;
  const data = response?.data || result?.upstream || {};
  const text = response?.output_text || response?.text || data?.text || "";
  const structuredData = bridgeCapabilityResultData(data);
  if (response?.localPath || result?.localPath) {
    structuredData.localPath = response.localPath || result.localPath || "";
  }
  if (response?.mimeType || result?.mimeType) {
    structuredData.mimeType = response.mimeType || result.mimeType || "";
  }
  if (response?.sourceUrl || result?.sourceUrl) {
    structuredData.sourceUrl = response.sourceUrl || result.sourceUrl || "";
  }
  return stringifyJson({
    ok: Boolean(result?.handled && !result?.skipped && !result?.failed),
    capability: response?.capability || result?.capability || "capability",
    providerId: response?.providerId || result?.providerId || "",
    providerName: response?.providerName || result?.providerName || "",
    output_text: text,
    data: structuredData,
  });
}

function bridgeCapabilityResultData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {};
  }
  return {
    action: data.action || "",
    url: data.url || "",
    query: data.query || "",
    fileUrl: data.fileUrl || data.file_url || "",
    fileName: data.fileName || data.file_name || data.filename || "",
    imageUrl: data.imageUrl || data.image_url || data.screenshotUrl || data.screenshot_url || "",
    audioUrl: data.audioUrl || data.audio_url || data.speechUrl || data.speech_url || "",
    videoUrl: data.videoUrl || data.video_url || "",
    localPath: data.localPath || data.local_path || "",
    mimeType: data.mimeType || data.mime_type || "",
    sourceUrl: data.sourceUrl || data.source_url || "",
    text: data.text || "",
    prompt: data.prompt || "",
    title: data.title || "",
    status: data.status || "",
    contentType: data.contentType || "",
    answer: data.answer || data.output_text || data.summary || "",
    sources: Array.isArray(data.sources) ? data.sources.slice(0, 5) : [],
    excerpt: data.excerpt || data.text || "",
    truncated: Boolean(data.truncated),
  };
}

function bridgeCapabilityErrorToolMessage(toolCall = {}, error) {
  return {
    role: "tool",
    tool_call_id: bridgeToolCallId(toolCall),
    content: stringifyJson({
      ok: false,
      error: safeText(error?.message || error || "CodexBridge 能力执行失败。", 600),
    }),
  };
}

function bridgeToolCallId(toolCall = {}) {
  return toolCall.id || toolCall.call_id || `call_${CODEXBRIDGE_CAPABILITY_TOOL_NAME}`;
}

async function proxyChatCompact(requestBody, route, history, res, context = {}) {
  const converted = buildCompactChatRequest(requestBody, route, history);
  logContextTruncationDecision(context, route, converted.contextDecision);
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
  logContextCompactionOutcome(context, route, {
    ...converted.contextMetrics,
    outcome: localFallback ? "local_fallback" : "completed",
    reasonCode: localFallback || "remote_summary_completed",
  });
  recordHistoryTurn(
    history,
    response,
    [
      ...converted.messagesForHistory,
      {
        role: "assistant",
        content: response.output[0]?.encrypted_content || null,
      },
    ],
    {
      api: "chat_completions",
      routeId: route.id || "",
      upstreamModel: route.model || "",
      upstreamKnown: false,
      ...responseRequestUserMeta(requestBody),
      localFallback: localFallback || "compact",
    },
    { requestBody, route },
  );
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
    return callJsonUpstream(fallbackUrl, route, payload, context, options);
  }
}

function chatCompletionsV1FallbackUrl(route, upstreamUrl, error) {
  if (!isHtmlNonJsonError(error) || !isRootBaseUrl(route?.baseUrl)) {
    return "";
  }
  return chatCompletionsRootFallbackUrl(route, upstreamUrl);
}

function chatCompletionsRootFallbackUrl(route, upstreamUrl) {
  if (!isRootBaseUrl(route?.baseUrl)) {
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
  const budgeted = budgetResponsesCompactPayload(compactBody, route, history);
  const { sourceMessages, toolContext } = budgeted;
  logContextTruncationDecision(context, route, budgeted.contextDecision);
  normalizeBridgePlainCompactionPayload(compactBody, route, context);

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
      const streamCompactBody = cloneJson(compactBody) || {};
      streamCompactBody.stream = true;
      normalizeBridgePlainCompactionPayload(streamCompactBody, route, context);
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
          {},
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
  logContextCompactionOutcome(context, route, {
    ...budgeted.contextMetrics,
    outcome: upstream ? "completed" : "local_fallback",
    reasonCode: upstream ? "remote_summary_completed" : "compact_local_fallback",
  });
  recordHistoryTurn(
    history,
    response,
    [
      ...sourceMessages,
      {
        role: "assistant",
        content: response.output[0]?.encrypted_content || null,
      },
    ],
    {
      api: "responses",
      routeId: route.id || "",
      upstreamModel: route.model || "",
      upstreamKnown: false,
      ...responseRequestUserMeta(requestBody),
      localFallback: upstream ? "compact" : "compact_local_fallback",
    },
    { requestBody, route },
  );
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
    throw error;
  }
  const text = await readUpstreamText(upstream, context);
  if (!upstream.ok) {
    const error = new UpstreamHttpError(upstream.status, text, upstreamUrl, route, {
      headers: upstream.headers,
    });
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
    const bodyMessage = upstreamBodyMessage(error.bodyText, tryParseJson(error.bodyText));
    return bodyMessage
      ? `HTTP ${error.statusCode} - ${bodyMessage}`
      : `HTTP ${error.statusCode}`;
  }
  return safeText(error?.message || String(error || "remote compact failed"), 800);
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
  const displayName = route.displayName || route.id || "当前模型";
  const turnCount = Math.max(1, Number(toolContinuationTurns) || 1);
  return {
    id: `chatcmpl_tool_loop_guard_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    object: "chat.completion",
    choices: [
      {
        message: {
          role: "assistant",
          content: `模型一直重复调用工具，没有返回最终回答。报错信息：${displayName} 连续 ${turnCount} 轮工具结果后仍请求新工具调用。`,
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

function blockCommandFallbackForControlledCapability(upstream, requestBody, converted, context = {}) {
  const kind = interactivePluginKindForRequest(requestBody);
  const controlledCapability = controlledCapabilityForInteractiveKind(kind);
  if (!controlledCapability) {
    return upstream;
  }
  if (!toolContextSupportsBridgeCapability(converted?.toolContext, controlledCapability)) {
    return upstream;
  }
  const commandCalls = chatMessageToolCalls(upstream).filter(isCommandToolCall);
  if (commandCalls.length === 0) {
    return upstream;
  }

  const adjusted = cloneJson(upstream);
  if (!Array.isArray(adjusted.choices) || adjusted.choices.length === 0) {
    adjusted.choices = [{ index: 0, finish_reason: "stop", message: {} }];
  }
  adjusted.choices[0].finish_reason = "stop";
  adjusted.choices[0].message = {
    role: "assistant",
    content: controlledCapabilityShellBlockMessage(
      controlledCapability,
      bridgeActionsForCapability(converted?.toolContext, controlledCapability),
    ),
  };
  console.warn(
    `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
      `!! controlled-capability-shell-block capability=${controlledCapability} calls=${commandCalls.length}`,
  );
  return adjusted;
}

function controlledCapabilityForInteractiveKind(kind) {
  if (kind === "computer") {
    return "computer_use";
  }
  if (kind === "chrome") {
    return "browser";
  }
  return "";
}

function toolContextSupportsBridgeCapability(toolContext, capability) {
  const target = String(capability || "").trim();
  if (!target) {
    return false;
  }
  const bridgeTool = bridgeCapabilityToolFromContext(toolContext);
  const capabilities = bridgeTool?.function?.parameters?.properties?.capability?.enum;
  return Array.isArray(capabilities) && capabilities.includes(target);
}

function bridgeCapabilityToolFromContext(toolContext) {
  const bridgeName =
    toolContext?.responseNameToChatName?.get?.(CODEXBRIDGE_CAPABILITY_TOOL_NAME) ||
    CODEXBRIDGE_CAPABILITY_TOOL_NAME;
  return (toolContext?.chatTools || []).find((tool) =>
    tool?.function?.name === bridgeName || tool?.function?.name === CODEXBRIDGE_CAPABILITY_TOOL_NAME
  );
}

function bridgeActionsForCapability(toolContext, capability) {
  const bridgeTool = bridgeCapabilityToolFromContext(toolContext);
  const actionEnum = bridgeTool?.function?.parameters?.properties?.action?.enum;
  if (!Array.isArray(actionEnum)) {
    return [];
  }
  const supported = defaultActionsForControlledCapability(capability);
  return actionEnum.filter((action) => supported.includes(action));
}

function defaultActionsForControlledCapability(capability) {
  if (capability === "computer_use") {
    return ["list_apps", "open_app", "screenshot_desktop"];
  }
  if (capability === "browser") {
    return ["read_url", "open_url"];
  }
  return [];
}

function isCommandToolCall(toolCall) {
  const name = String(toolCall?.function?.name || toolCall?.name || "").trim();
  return isCommandToolName(name);
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

function controlledCapabilityShellBlockMessage(capability, actions = []) {
  const safeActions = actions.length > 0 ? actions : defaultActionsForControlledCapability(capability);
  const qualifiedActions = safeActions.map((action) => `${capability}/${action}`);
  const actionText = formatChineseList(qualifiedActions);
  if (capability === "computer_use") {
    return (
      "出于安全限制，这次受控 Computer Use 请求里的 shell 命令没有执行任何本地动作。 " +
      `聊天模型必须改用 codexbridge_capability，并且只能调用 ${actionText}，` +
      "这样动作才会被限制在安全白名单里。"
    );
  }
  return (
    "出于安全限制，这次受控浏览器请求里的 shell 命令没有执行任何本地动作。 " +
    `聊天模型必须改用 codexbridge_capability，并且只能调用 ${actionText}。`
  );
}

function formatChineseList(items = []) {
  const values = items.map((item) => String(item || "").trim()).filter(Boolean);
  if (values.length <= 1) {
    return values[0] || "";
  }
  if (values.length === 2) {
    return `${values[0]} 或 ${values[1]}`;
  }
  return `${values.slice(0, -1).join("、")} 或 ${values.at(-1)}`;
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

  recordHistoryTurn(
    history,
    response,
    [...messagesForHistory, assistantHistoryMessageFromChat(localChat)],
    {
      api: "chat_completions",
      routeId: route.id || "",
      upstreamModel: route.model || "",
      upstreamKnown: false,
      ...responseRequestUserMeta(requestBody),
      localFallback: "provider_rate_limited",
    },
    { requestBody, route },
  );
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
  const retryAfterMs = Number(error?.retryAfterMs || routeRateLimitStatus(route).cooldownRemainingMs || 0);
  const waitSeconds = Math.ceil(Math.max(0, retryAfterMs) / 1000);
  const localCooldown = error?.code === "provider_rate_limited";
  const upstream429 = Number(error?.statusCode || 0) === 429;
  const displayName = route.displayName || route.id || "当前模型";
  const reasonText = `${displayName} 的供应商限流，请稍后再试或切换备用模型。`;
  const errorInfo = upstream429
    ? upstreamErrorInfo(error, null, classifyUpstreamError(error))
    : localCooldown && waitSeconds > 0
      ? `供应商冷却中，剩余约 ${waitSeconds}s`
      : "供应商当前处于限流状态";
  return {
    id: `chatcmpl_rate_limited_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    object: "chat.completion",
    choices: [
      {
        message: {
          role: "assistant",
          content: `${reasonText}报错信息：${errorInfo}`,
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

  recordHistoryTurn(
    history,
    response,
    [...messagesForHistory, assistantHistoryMessageFromChat(localChat)],
    {
      api: "chat_completions",
      routeId: route.id || "",
      upstreamModel: route.model || "",
      upstreamKnown: false,
      ...responseRequestUserMeta(requestBody),
      localFallback: "image_rejected",
    },
    { requestBody, route },
  );
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
    "本轮历史已经改成文本占位，后续会话可以继续。" +
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
  let upstream;
  try {
    upstream = await fetchUpstream(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders(route, context),
      body: JSON.stringify(upstreamPayload),
    }, context, route, options);
  } catch (error) {
    throw error;
  }
  const text = await readUpstreamText(upstream, context);
  if (!upstream.ok) {
    const error = new UpstreamHttpError(upstream.status, text, upstreamUrl, route, {
      headers: upstream.headers,
    });
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
    throw error;
  }
  return parsed;
}

async function readUpstreamText(upstream, context = {}) {
  if (!context.clientSignal || !upstream?.body) {
    return upstream.text();
  }
  if (context.clientSignal.aborted) {
    throw new ClientClosedRequestError();
  }

  const reader = upstream.body.getReader();
  const chunks = [];
  let abortHandler;
  const abortPromise = new Promise((_, reject) => {
    abortHandler = () => {
      reader.cancel(context.clientSignal.reason).catch(() => {});
      reject(new ClientClosedRequestError());
    };
    context.clientSignal.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    while (true) {
      const result = await Promise.race([reader.read(), abortPromise]);
      if (result.done) {
        break;
      }
      chunks.push(Buffer.from(result.value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (context.clientSignal.aborted || error?.code === "client_closed_request") {
      throw new ClientClosedRequestError();
    }
    throw error;
  } finally {
    if (abortHandler) {
      context.clientSignal.removeEventListener("abort", abortHandler);
    }
    reader.releaseLock();
  }
}

export function __resetUpstreamFailureCacheForTests() {
  // Compatibility hook retained for callers while the old payload failure cache is removed.
}

export function sendUpstreamError(res, error, options = {}) {
  if (options.asResponsesStream) {
    const localHistoryError = Boolean(
      error?.localHistoryError || error?.code === "local_history_storage_unavailable",
    );
    const contextSwitchError = error?.code === "context_switch_compaction_failed";
    sendResponsesStreamFailure(res, streamErrorMessage(error), {
      model: options.model || error?.route?.model || null,
      ...(localHistoryError
        ? {
            statusCode: error.statusCode || 503,
            code: "local_history_storage_unavailable",
          }
        : {}),
      ...(contextSwitchError
        ? {
            statusCode: error.statusCode || 409,
            code: "context_switch_compaction_failed",
          }
        : {}),
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
      openAiError(
        userFacingUpstreamErrorMessage(error),
        error.statusCode,
        classification.code,
      ),
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
        `本次请求内容太大${actualMb ? `（约 ${actualMb} MB）` : ""}，本地 Router 没有继续发送给供应商。` +
          `当前本地上限是 ${limitMb || "已配置"} MB。请先压缩上下文、开启新会话，或移除大段日志/内联图片后再试。`,
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
  const classification = classifyUpstreamError(error);
  const isUpstreamError = Boolean(
    error instanceof UpstreamTimeoutError ||
      error instanceof UpstreamStreamError ||
      String(error?.name || "").startsWith("Upstream") ||
      String(error?.code || "").startsWith("upstream_"),
  );
  const message = isUpstreamError
    ? userFacingUpstreamErrorMessage(error)
    : error.message;
  const code = isUpstreamError
    ? classification.code
    : error.code || classification.code || "router_error";
  jsonResponse(
    res,
    statusCode,
    openAiError(message, statusCode, code),
  );
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
    res.writeHead(options.statusCode || 200, {
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
  if (error?.code === "context_switch_compaction_failed") {
    return error.message;
  }
  if (error instanceof UpstreamHttpError) {
    const parsed = tryParseJson(error.bodyText);
    return clientUpstreamErrorMessage(error, parsed);
  }
  return userFacingUpstreamErrorMessage(error);
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
  return userFacingUpstreamErrorMessage(error, parsedBody);
}

function userFacingUpstreamErrorMessage(error, parsedBody = null) {
  const classification = classifyUpstreamError(error);
  const routeLabel = userFacingRouteLabel(error?.route);
  const statusCode = Number(error?.statusCode || classification.statusCode || 0);
  const prefix = routeLabel ? `${routeLabel}：` : "";
  const errorInfo = upstreamErrorInfo(error, parsedBody, classification);

  if (Number(error?.statusCode) === 413) {
    return payloadTooLargeClientMessage({
      routeLabel,
      statusCode,
      errorInfo,
    });
  }

  switch (classification.code) {
    case "upstream_authentication_error":
      return userFacingErrorSentence(prefix, "API Key 无效或没有权限，请检查当前供应商 Key。", errorInfo);
    case "upstream_billing_error":
      return userFacingErrorSentence(prefix, "供应商账户余额不足，请充值或更换 Key。", errorInfo);
    case "upstream_rate_limit":
      return userFacingErrorSentence(prefix, `供应商限流，请稍后再试或切换备用模型。${retryAfterAdvice(error?.retryAfter)}`, errorInfo);
    case "upstream_provider_unavailable":
      return userFacingErrorSentence(prefix, "供应商服务暂时不可用或网关异常，请稍后重试。", errorInfo);
    case "upstream_payload_too_large":
      return payloadTooLargeClientMessage({ routeLabel, statusCode, errorInfo });
    case "upstream_media_unsupported":
      return userFacingErrorSentence(prefix, "供应商不支持这次附件或多模态输入，请换支持附件的模型或转成文字后重试。", errorInfo);
    case "upstream_parameter_error":
      return userFacingErrorSentence(prefix, "供应商拒绝了请求参数，请检查模型名、接口类型、Base URL 或请求参数。", errorInfo);
    case "upstream_compact_unsupported":
      return userFacingErrorSentence(prefix, "供应商不支持这次上下文压缩请求，请换模型或开启新会话继续。", errorInfo);
    case "upstream_network_error":
      return userFacingErrorSentence(prefix, "连接供应商失败，请检查网络、代理/VPN 或 Base URL。", errorInfo);
    case "upstream_timeout":
      return userFacingErrorSentence(prefix, "请求供应商超时，请稍后重试或切换更稳定的模型/代理。", errorInfo);
    case "upstream_stream_error":
    case "upstream_stream_truncated":
      return userFacingErrorSentence(prefix, "供应商流式响应中断，当前回复没有完整返回。", errorInfo);
    default:
      if (String(classification.code || "").startsWith("upstream_")) {
        return userFacingErrorSentence(prefix, "供应商返回错误，请稍后重试或检查供应商配置。", errorInfo);
      }
      return error?.message || "请求处理失败。";
  }
}

function payloadTooLargeClientMessage({
  routeLabel,
  statusCode,
  errorInfo,
}) {
  const prefix = routeLabel ? `${routeLabel}：` : "";
  const detail = errorInfo || (statusCode ? `HTTP ${statusCode}` : "请求内容超过限制");
  return userFacingErrorSentence(
    prefix,
    "请求内容太大，供应商拒绝接收这次上下文。请先压缩上下文、开启新会话，或减少大段日志、文件、图片后再重试。",
    detail,
  );
}

function upstreamBodyMessage(rawBody, parsedBody) {
  return safeText(rawUpstreamBodyMessage(rawBody, parsedBody), 800);
}

function rawUpstreamBodyMessage(rawBody, parsedBody) {
  return (
    parsedBody?.error?.message ||
    parsedBody?.message ||
    parsedBody?.error ||
    rawBody ||
    ""
  );
}

function userFacingErrorSentence(prefix, summary, errorInfo) {
  const message = String(summary || "请求处理失败。").trim();
  const sentence = /[。！？；]$/.test(message) ? message : `${message}。`;
  const info = safeErrorInfoText(errorInfo || "未返回详细信息", 320) || "未返回详细信息";
  return `${prefix}${sentence}报错信息：${info}`;
}

function upstreamErrorInfo(error, parsedBody = null, classification = {}) {
  const statusCode = Number(error?.statusCode || classification.statusCode || 0);
  const rawMessage = error instanceof UpstreamHttpError
    ? rawUpstreamBodyMessage(error.bodyText, parsedBody)
    : error?.message || String(error || "");
  const detail = readableUpstreamErrorDetail(rawMessage);
  if (statusCode && detail) {
    return `HTTP ${statusCode} - ${detail}`;
  }
  if (statusCode) {
    return `HTTP ${statusCode}`;
  }
  return detail || classification.code || "未返回详细信息";
}

function readableUpstreamErrorDetail(value) {
  const raw = String(value || "");
  const title = htmlTitleText(raw);
  const text = title || raw;
  return safeErrorInfoText(
    text
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    240,
  );
}

function htmlTitleText(value) {
  if (!looksLikeHtml(value)) {
    return "";
  }
  const match = String(value || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) {
    return "";
  }
  return decodeBasicHtmlEntities(match[1])
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeBasicHtmlEntities(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function safeErrorInfoText(value, limit = 240) {
  return redactErrorInfoSecretText(value)
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function redactErrorInfoSecretText(value) {
  return String(value || "")
    .replace(/:\/\/[^/?#\s]+@/g, "://[REDACTED]@")
    .replace(
      /([?&](?:api[_-]?key|token|access_token|secret|key)=)[^&#\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ak)-[A-Za-z0-9._-]{6,}\b/gi, (match) => {
      const prefix = match.slice(0, 2).toLowerCase();
      return `${prefix}-[REDACTED]`;
    })
    .replace(/<\s*(ak)-[A-Za-z0-9._-]{6,}\s*>/gi, "<ak-[REDACTED]>")
    .replace(/\b(?:org|proj)-[A-Za-z0-9._-]{8,}\b/gi, (match) => {
      const prefix = match.split("-")[0].toLowerCase();
      return `${prefix}-[REDACTED]`;
    })
    .replace(
      /((?:api[_-]?key|authorization|token|secret|key)["'\s]*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{8,}/gi,
      "$1[REDACTED]",
    );
}

function userFacingRouteLabel(route = {}) {
  return route?.displayName || route?.id || route?.model || "";
}

function retryAfterAdvice(value) {
  if (!value) {
    return "";
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return `建议约 ${formatDuration(seconds)} 后再试；`;
  }
  const retryAtMs = Date.parse(value);
  if (Number.isFinite(retryAtMs)) {
    const waitSeconds = Math.ceil((retryAtMs - Date.now()) / 1000);
    if (waitSeconds > 0) {
      return `建议约 ${formatDuration(waitSeconds)} 后再试；`;
    }
  }
  return "";
}

function formatDuration(seconds) {
  if (seconds < 60) {
    return `${Math.ceil(seconds)} 秒`;
  }
  if (seconds < 3600) {
    return `${Math.ceil(seconds / 60)} 分钟`;
  }
  return `${Math.ceil(seconds / 3600)} 小时`;
}

function userFacingUpstreamDetail(value, classification = {}) {
  const text = safeText(value, 240)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || looksLikeHtml(value)) {
    return "";
  }
  if (shouldHideCommonEnglishDetail(text, classification)) {
    return "";
  }
  return text;
}

function looksLikeHtml(value) {
  return /<!doctype|<html|<\/html>|<head|<body|cloudflare|nginx/i.test(String(value || ""));
}

function shouldHideCommonEnglishDetail(text, classification = {}) {
  const haystack = text.toLowerCase();
  if (
    /incorrect api key|invalid api key|too many requests|rate.?limit|insufficient balance|insufficient quota|payment required|payload too large|bad gateway|gateway timeout|service unavailable/.test(haystack)
  ) {
    return true;
  }
  return [
    "upstream_authentication_error",
    "upstream_billing_error",
    "upstream_rate_limit",
    "upstream_provider_unavailable",
    "upstream_payload_too_large",
  ].includes(classification.code);
}

function upstreamHeaders(route, context = {}, options = {}) {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${upstreamBearerToken(route, context)}`,
  };

  const customHeaders = route?.headers && typeof route.headers === "object" && !Array.isArray(route.headers)
    ? route.headers
    : {};
  for (const [name, value] of Object.entries(customHeaders)) {
    const key = String(name || "").trim();
    const headerValue = String(value ?? "").trim();
    if (!key || !headerValue || blockedCustomUpstreamHeader(key)) {
      continue;
    }
    headers[key] = headerValue;
  }

  if (options.acceptEventStream) {
    headers.accept = "text/event-stream";
  }

  if (authModeForRoute(route) === "codex_openai") {
    addCodexPassthroughHeaders(headers, context.clientHeaders);
  }

  return headers;
}

function blockedCustomUpstreamHeader(name = "") {
  const normalized = String(name || "").trim().toLowerCase();
  return [
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ].includes(normalized);
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

export function responsesBaseUrlForRoute(route) {
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
  if (!headers || !name) {
    return "";
  }
  if (typeof headers.get === "function") {
    return String(headers.get(name) || headers.get(name.toLowerCase()) || headers.get(name.toUpperCase()) || "").trim();
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
  const trace = ensureRouteTrace(context, route);
  const requestId = context.requestId || "req";
  const routeId = route.id || route.model || route.adapterId || "unknown";
  for (const drop of drops) {
    recordRouteTraceEvent(trace, "payload_drop", drop);
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
  const trace = ensureRouteTrace(context, route);
  recordRouteTraceEvent(trace, "upstream_request", {
    url: safeUrl(upstreamUrl),
    api: route.api,
    upstreamModel: route.model,
    provider: providerLogLabel(route),
    proxy: proxy || undefined,
  });
  console.log(
    `[${new Date().toISOString()}] ${requestId} -> upstream ` +
      `route=${route.id} api=${route.api} upstream_model=${route.model} ` +
      `url=${safeUrl(upstreamUrl)} provider=${providerLogLabel(route)}` +
      (proxy ? ` proxy=${proxy}` : ""),
  );
  console.log(
    `[${new Date().toISOString()}] ${requestId} route_trace ` +
      JSON.stringify(routeTraceForLog(trace)),
  );
}

function logToolDiagnostics(context, route, diagnostics = {}, mode = "") {
  const requested = Number(diagnostics.requestedToolCount || 0);
  const namespaces = Number(diagnostics.namespaceCount || 0);
  const suppressed = Number(diagnostics.suppressedToolCount || 0);
  if (requested <= 0 && namespaces <= 0 && suppressed <= 0) {
    return;
  }
  const requestId = context.requestId || "req";
  console.log(
    `[${new Date().toISOString()}] ${requestId} tool_diag ` +
      `route=${safeLogValue(route.id || route.model || "unknown")} ` +
      `mode=${safeLogValue(mode || route.api || "unknown")} ` +
      toolDiagnosticsLogFields(diagnostics),
  );
}

function logReturnedToolDiagnostics(context, route, diagnostics = {}, mode = "") {
  const returned = Number(diagnostics.returnedToolCount || 0);
  const suppressed = Number(diagnostics.suppressedToolCount || 0);
  const unknown = Number(diagnostics.unknownToolCount || 0);
  if (returned <= 0 && suppressed <= 0 && unknown <= 0) {
    return;
  }
  const requestId = context.requestId || "req";
  console.log(
    `[${new Date().toISOString()}] ${requestId} tool_return_diag ` +
      `route=${safeLogValue(route.id || route.model || "unknown")} ` +
      `mode=${safeLogValue(mode || route.api || "unknown")} ` +
      returnedToolDiagnosticsLogFields(diagnostics),
  );
}

function logStatus(context, route, status) {
  const requestId = context.requestId || "req";
  recordRouteTraceEvent(ensureRouteTrace(context, route), "upstream_status", {
    status,
  });
  console.log(
    `[${new Date().toISOString()}] ${requestId} <- upstream ` +
      `route=${route.id} status=${status}`,
  );
}

function logUsage(context, route, usage) {
  const requestId = context.requestId || "req";
  if (!usage) {
    notifyUpstreamUsage(context, route, null);
    recordRouteTraceEvent(ensureRouteTrace(context, route), "upstream_usage", {
      usage: null,
    });
    console.log(
      `[${new Date().toISOString()}] ${requestId} <- upstream ` +
        `route=${route.id} usage=(none)`,
    );
    return;
  }
  const normalized = normalizeUsage(usage);
  notifyUpstreamUsage(context, route, normalized);
  recordRouteTraceEvent(ensureRouteTrace(context, route), "upstream_usage", {
    usage: normalized,
  });
  console.log(
    `[${new Date().toISOString()}] ${requestId} <- upstream ` +
      `route=${route.id} usage prompt=${normalized.prompt_tokens} ` +
      `cached=${normalized.cache_read_tokens} fresh=${normalized.fresh_prompt_tokens} ` +
      `completion=${normalized.completion_tokens} total=${normalized.total_tokens}`,
  );
}

function ensureRouteTrace(context = {}, route = {}) {
  if (context.routeTrace) {
    recordRouteDecisionTraceEvent(context, route);
    return context.routeTrace;
  }
  context.routeTrace = createRouteTrace({
    requestId: context.requestId || "req",
    requestedModel: context.requestedModel || route.id || route.model || "",
    route,
  });
  recordRouteDecisionTraceEvent(context, route);
  return context.routeTrace;
}

function recordRouteDecisionTraceEvent(context = {}, route = {}) {
  if (!context.routeTrace || context.routeDecisionTraceRecorded) {
    return;
  }
  const details = routeDecisionTraceDetails(context, route);
  if (!details) {
    return;
  }
  recordRouteTraceEvent(context.routeTrace, "route_decision", details);
  context.routeDecisionTraceRecorded = true;
}

function routeDecisionTraceDetails(context = {}, route = {}) {
  if (context.failoverFromRoute || context.smartFailoverReason) {
    return {
      reason: "smart_failover",
      failoverReason: safeTraceText(context.smartFailoverReason || ""),
      requestedModel: safeTraceText(context.requestedModel || route.id || route.model || ""),
      originalRoute: safeTraceText(context.failoverFromRoute || ""),
      originalDisplayName: safeTraceText(context.failoverFromDisplayName || ""),
      originalUpstreamModel: safeTraceText(context.failoverFromModel || ""),
      selectedRoute: safeTraceText(route.id || ""),
      selectedDisplayName: safeTraceText(route.displayName || route.id || route.model || ""),
      selectedUpstreamModel: safeTraceText(route.model || route.id || ""),
      selectedApi: safeTraceText(route.api || ""),
      changed: true,
    };
  }

  const decision = context.routePlan?.decision &&
    typeof context.routePlan.decision === "object" &&
    !Array.isArray(context.routePlan.decision)
    ? context.routePlan.decision
    : null;
  if (decision) {
    return routeDecisionTraceDetailsFromDecision(decision, route, context);
  }

  const selection = context.routeSelection &&
    typeof context.routeSelection === "object" &&
    !Array.isArray(context.routeSelection)
    ? context.routeSelection
    : null;
  if (!selection) {
    return {
      reason: "manual_route",
      requestedModel: safeTraceText(context.requestedModel || route.id || route.model || ""),
      originalRoute: safeTraceText(route.id || ""),
      originalDisplayName: safeTraceText(route.displayName || route.id || route.model || ""),
      originalUpstreamModel: safeTraceText(route.model || route.id || ""),
      selectedRoute: safeTraceText(route.id || ""),
      selectedDisplayName: safeTraceText(route.displayName || route.id || route.model || ""),
      selectedUpstreamModel: safeTraceText(route.model || route.id || ""),
      selectedApi: safeTraceText(route.api || ""),
      changed: false,
    };
  }

  const originalRoute = selection.originalRoute || {};
  const selectedRoute = selection.route || route || {};
  return {
    reason: safeTraceText(selection.reason || "manual_route"),
    requestedModel: safeTraceText(context.requestedModel || selectedRoute.id || selectedRoute.model || ""),
    originalRoute: safeTraceText(originalRoute.id || ""),
    originalDisplayName: safeTraceText(
      originalRoute.displayName || originalRoute.id || originalRoute.model || "",
    ),
    originalUpstreamModel: safeTraceText(originalRoute.model || originalRoute.id || ""),
    selectedRoute: safeTraceText(selectedRoute.id || route.id || ""),
    selectedDisplayName: safeTraceText(
      selectedRoute.displayName || selectedRoute.id || selectedRoute.model || route.displayName || "",
    ),
    selectedUpstreamModel: safeTraceText(selectedRoute.model || route.model || selectedRoute.id || ""),
    selectedApi: safeTraceText(selectedRoute.api || route.api || ""),
    changed: Boolean(selection.changed),
  };
}

function routeDecisionTraceDetailsFromDecision(decision = {}, route = {}, context = {}) {
  const originalRoute = decision.originalRoute || {};
  const selectedRoute = decision.selectedRoute || {};
  return {
    decisionVersion: safeTraceText(decision.version || ""),
    requestKind: safeTraceText(decision.requestKind || ""),
    reason: safeTraceText(decision.reason || "manual_route"),
    requestedModel: safeTraceText(
      decision.requestedModel || context.requestedModel || selectedRoute.id || selectedRoute.upstreamModel || "",
    ),
    originalRoute: safeTraceText(originalRoute.id || ""),
    originalDisplayName: safeTraceText(
      originalRoute.displayName || originalRoute.id || originalRoute.upstreamModel || "",
    ),
    originalUpstreamModel: safeTraceText(originalRoute.upstreamModel || originalRoute.id || ""),
    selectedRoute: safeTraceText(selectedRoute.id || route.id || ""),
    selectedDisplayName: safeTraceText(
      selectedRoute.displayName || selectedRoute.id || selectedRoute.upstreamModel || route.displayName || "",
    ),
    selectedUpstreamModel: safeTraceText(selectedRoute.upstreamModel || route.model || selectedRoute.id || ""),
    selectedApi: safeTraceText(selectedRoute.api || route.api || ""),
    changed: Boolean(decision.changed),
    rewriteModel: safeTraceText(decision.rewriteModel || ""),
    skippedRoutes: routeDecisionTraceSkippedRoutes(decision.skippedRoutes),
    userMessage: safeTraceText(decision.userMessage || ""),
  };
}

function routeDecisionTraceSkippedRoutes(skippedRoutes = []) {
  if (!Array.isArray(skippedRoutes)) {
    return [];
  }
  return skippedRoutes
    .map((item) => ({
      routeId: safeTraceText(item?.routeId || item?.id || ""),
      reason: safeTraceText(item?.reason || "excluded"),
      detail: safeTraceText(item?.detail || ""),
    }))
    .filter((item) => item.routeId);
}

function safeTraceText(value) {
  return String(value || "")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function notifyUpstreamUsage(context = {}, route = {}, usage = null) {
  if (typeof context.onUpstreamUsage !== "function") {
    return;
  }
  try {
    context.onUpstreamUsage(route, usage);
  } catch (error) {
    console.warn(
      `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
        `!! usage-budget-record route=${route.id || "(unknown)"} ` +
        `error=${safeText(error?.message || error, 240)}`,
    );
  }
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
  const proxiedOptions = streamingProxyFetchOptions(route, options, usedProxy);
  const proxyLabel = proxyLogLabel(upstreamUrl);
  try {
    return await fetchAndTrackRateLimit(upstreamUrl, proxiedInit, route, proxiedOptions, context);
  } catch (initialError) {
    let error = initialError;
    if (
      usedProxy &&
      options.streamingResponse &&
      error instanceof UpstreamTimeoutError &&
      invalidateProxyAgentForUrl(upstreamUrl)
    ) {
      const refreshedInit = fetchInitWithProxy(upstreamUrl, init);
      if (refreshedInit.dispatcher && refreshedInit.dispatcher !== proxiedInit.dispatcher) {
        console.warn(
          `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
            `!! proxy route=${route.id || "-"} streaming_headers_timeout ` +
            `action=refresh_dispatcher retry_timeout_ms=${proxiedOptions.timeoutMs}`,
        );
        try {
          return await fetchAndTrackRateLimit(
            upstreamUrl,
            refreshedInit,
            route,
            proxiedOptions,
            context,
          );
        } catch (refreshedError) {
          error = refreshedError;
        }
      }
    }
    if (usedProxy && isNetworkFetchFailure(error)) {
      const refreshedInit = refreshFetchInitWithProxy(upstreamUrl, init);
      if (refreshedInit.dispatcher) {
        console.warn(
          `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
            `!! proxy route=${route.id || "-"} network_failure ` +
            "action=refresh_system_proxy retry=proxy",
        );
        try {
          return await fetchAndTrackRateLimit(
            upstreamUrl,
            refreshedInit,
            route,
            proxiedOptions,
            context,
          );
        } catch (refreshedError) {
          error = refreshedError;
        }
      }
    }
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

export function streamingProxyFetchOptions(route = {}, options = {}, usedProxy = false) {
  if (!usedProxy || !options.streamingResponse) {
    return options;
  }
  const routeTimeout = upstreamTimeoutMs(route, options);
  const configuredHeaderTimeout = Number(
    options.proxyHeaderTimeoutMs ??
      route.proxyHeaderTimeoutMs ??
      route.proxy_header_timeout_ms,
  );
  const headerTimeout = Number.isFinite(configuredHeaderTimeout) && configuredHeaderTimeout > 0
    ? Math.floor(configuredHeaderTimeout)
    : DEFAULT_STREAMING_PROXY_HEADER_TIMEOUT_MS;
  return {
    ...options,
    timeoutMs: routeTimeout > 0 ? Math.min(routeTimeout, headerTimeout) : headerTimeout,
  };
}

async function fetchAndTrackRateLimit(upstreamUrl, init, route, options = {}, context = {}) {
  const abortable = abortableFetchInit(init, upstreamUrl, route, options, context);
  try {
    const response = await fetch(upstreamUrl, abortable.init);
    if (response.status === 429 && options.trackRateLimit !== false) {
      markRouteRateLimited(route, response.headers);
    }
    abortable.responseStarted(response);
    return responseWithAbortLifecycle(response, abortable, upstreamUrl, route);
  } catch (error) {
    abortable.cleanup();
    throw abortLifecycleError(error, abortable, upstreamUrl, route);
  }
}

function responseWithAbortLifecycle(response, abortable, upstreamUrl, route) {
  if (!response?.body) {
    abortable.cleanup();
    return response;
  }
  const reader = response.body.getReader();
  let settled = false;
  const settle = () => {
    if (settled) {
      return;
    }
    settled = true;
    abortable.cleanup();
  };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          settle();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        settle();
        controller.error(abortLifecycleError(error, abortable, upstreamUrl, route));
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        settle();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function abortLifecycleError(error, abortable, upstreamUrl, route) {
  if (abortable.clientAborted()) {
    return new ClientClosedRequestError();
  }
  if (abortable.timedOut()) {
    return new UpstreamTimeoutError(abortable.timeoutMs, upstreamUrl, route);
  }
  return error;
}

async function cancelUpstreamResponse(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // The fallback request is authoritative; cancellation is best-effort cleanup.
  }
}

function abortableFetchInit(init = {}, upstreamUrl, route = {}, options = {}, context = {}) {
  const controller = new AbortController();
  const cleanup = [];
  let timeoutTriggered = false;
  let clientTriggered = Boolean(context.clientSignal?.aborted);
  const timeoutMs = upstreamTimeoutMs(route, options);
  let clearRequestTimeout = () => {};

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
    clearRequestTimeout = () => clearTimeout(timeout);
    cleanup.push(clearRequestTimeout);
  }

  return {
    init: {
      ...init,
      signal: controller.signal,
    },
    timeoutMs,
    clientAborted: () => clientTriggered || Boolean(context.clientSignal?.aborted),
    timedOut: () => timeoutTriggered,
    responseStarted: (response) => {
      if (options.streamingResponse && responseUsesEventStream(response)) {
        clearRequestTimeout();
      }
    },
    cleanup: () => {
      for (const fn of cleanup.splice(0)) {
        fn();
      }
    },
  };
}

export function upstreamTimeoutMs(route = {}, options = {}) {
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
  return hydrateStreamedImageGenerationResults(
    extractResponseObjectFromSse(text),
    text,
  );
}

function hydrateStreamedImageGenerationResults(response, text = "") {
  if (!response || !Array.isArray(response.output)) {
    return response;
  }
  const byItemId = new Map();
  const byOutputIndex = new Map();
  for (const event of parseSseEvents(text)) {
    const data = tryParseJson(String(event?.data || "").trim());
    const outputItem = data?.type === "response.output_item.done" &&
      data?.item?.type === "image_generation_call"
      ? data.item
      : null;
    const result = outputItem
      ? (typeof outputItem.result === "string" ? outputItem.result.trim() : "")
      : data?.type === "response.image_generation_call.partial_image"
        ? (typeof data.partial_image_b64 === "string" ? data.partial_image_b64.trim() : "")
        : "";
    if (!result) {
      continue;
    }
    const candidate = {
      result,
      partialImageIndex: Number(data.partial_image_index || 0),
      revisedPrompt: typeof outputItem?.revised_prompt === "string"
        ? outputItem.revised_prompt
        : "",
      itemId: outputItem?.id || data.item_id || "",
      outputIndex: Number.isInteger(data.output_index) ? data.output_index : -1,
      outputItem,
    };
    const itemId = outputItem?.id || data.item_id;
    if (typeof itemId === "string" && itemId) {
      byItemId.set(itemId, candidate);
    }
    if (Number.isInteger(data.output_index) && data.output_index >= 0) {
      byOutputIndex.set(data.output_index, candidate);
    }
  }
  const appliedCandidates = new Set();
  response.output.forEach((item, outputIndex) => {
    if (
      item?.type !== "image_generation_call" ||
      (typeof item.result === "string" && item.result.trim())
    ) {
      return;
    }
    const candidate = byItemId.get(item.id) || byOutputIndex.get(outputIndex);
    if (candidate?.result) {
      appliedCandidates.add(candidate);
      item.result = candidate.result;
      if (!item.revised_prompt && candidate.revisedPrompt) {
        item.revised_prompt = candidate.revisedPrompt;
      }
    }
  });
  const streamedCandidates = [...new Set([
    ...byOutputIndex.values(),
    ...byItemId.values(),
  ])]
    .filter((candidate) => candidate?.result && !appliedCandidates.has(candidate))
    .sort((left, right) => left.outputIndex - right.outputIndex);
  for (const candidate of streamedCandidates) {
    response.output.push({
      ...(candidate.outputItem || {}),
      id: candidate.itemId || candidate.outputItem?.id || `image_generation_${response.output.length}`,
      type: "image_generation_call",
      status: candidate.outputItem?.status || "completed",
      result: candidate.result,
      ...(candidate.revisedPrompt ? { revised_prompt: candidate.revisedPrompt } : {}),
    });
  }
  return response;
}

function isResponsesObject(value) {
  return Boolean(normalizeResponsesObject(value));
}

function isCompletedResponsesObject(value) {
  const response = normalizeResponsesObject(value);
  return Boolean(response && response.status === "completed" && !response.error);
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

function recordResponsesHistory(
  history,
  response,
  sourceMessages,
  toolContext,
  { requestBody = {}, route = {} } = {},
) {
  if (!history || !isResponsesObject(response)) {
    return;
  }
  recordHistoryTurn(
    history,
    response,
    [
      ...sourceMessages,
      assistantHistoryMessageFromResponse(response, toolContext),
    ],
    {
      api: "responses",
      routeId: route.id || "",
      upstreamModel: route.model || "",
      upstreamKnown: true,
      ...responseRequestUserMeta(requestBody),
    },
    { requestBody, route },
  );
}

function recordHistoryTurn(
  history,
  response,
  messages,
  meta = {},
  { requestBody = {}, route = {} } = {},
) {
  if (!history || !response?.id) {
    return;
  }
  const turn = {
    responseId: response.id,
    messages,
    response,
    meta: {
      ...meta,
      parentResponseId: requestBody.previous_response_id || null,
      routeSnapshot: routeSnapshotForHistory(route),
    },
  };
  try {
    if (typeof history.recordTurn === "function") {
      history.recordTurn(turn);
      return;
    }
    history.record?.(response.id, messages);
    history.recordResponse?.(response, turn.meta);
  } catch (error) {
    throw asLocalHistoryStorageError(error);
  }
}

function routeSnapshotForHistory(route = {}) {
  try {
    return createRouteSnapshot(route, {
      contextPolicy: contextSwitchPolicyForRoute(route),
    });
  } catch {
    // Keep the response durable even when a malformed legacy route cannot
    // produce a trusted snapshot. A later cross-route switch will fail closed.
    return {
      id: route.id || "",
      api: route.api || "",
      model: route.model || "",
    };
  }
}

function asLocalHistoryStorageError(error) {
  if (
    error?.localHistoryError ||
    error?.code === "local_history_storage_unavailable"
  ) {
    return error;
  }
  const wrapped = new Error(
    `Local response history storage failed: ${error?.message || String(error)}`,
  );
  wrapped.statusCode = 503;
  wrapped.code = "local_history_storage_unavailable";
  wrapped.localHistoryError = true;
  wrapped.cause = error;
  return wrapped;
}

function responseRequestUserMeta(requestBody = {}) {
  const input = requestBody.messages ?? requestBody.input;
  const signatures = userInputSignatures(input);
  return {
    userInputSignatures: signatures,
    userInputCount: signatures.length,
    hasOpaqueUserInput: inputHasOpaqueUserInput(input),
  };
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
  const cacheReadTokens = tokenNumber(
    usage.prompt_cache_hit_tokens,
    usage.cache_read_input_tokens,
    usage.cache_read_tokens,
    usage.prompt_tokens_details?.cached_tokens,
    usage.input_tokens_details?.cached_tokens,
    usage.promptTokensDetails?.cachedTokens,
    usage.inputTokensDetails?.cachedTokens,
  );
  const cacheCreationTokens = tokenNumber(
    usage.cache_creation_input_tokens,
    usage.cache_creation_tokens,
    usage.cache_write_input_tokens,
    usage.cache_write_tokens,
  );
  const cacheMissTokens = tokenNumber(
    usage.prompt_cache_miss_tokens,
    usage.cache_miss_input_tokens,
    usage.cache_miss_tokens,
  );
  const freshPromptTokens =
    cacheMissTokens > 0
      ? cacheMissTokens
      : Math.max(0, promptTokens - cacheReadTokens);
  const totalTokens = tokenNumber(
    usage.total_tokens,
    usage.totalTokens,
    promptTokens + completionTokens,
  );
  return {
    prompt_tokens: promptTokens,
    fresh_prompt_tokens: freshPromptTokens,
    cache_read_tokens: cacheReadTokens,
    cache_creation_tokens: cacheCreationTokens,
    cache_miss_tokens: cacheMissTokens,
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
  return redactSecretText(value, limit)
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
