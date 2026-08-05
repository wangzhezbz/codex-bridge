import { cloneJson, jsonResponse, openAiError, stringifyJson, tryParseJson } from "./json.js";
import { bridgeCapabilityToolContent } from "./bridge-capability-result.js";
import { parseBridgeCapabilityToolCall } from "./bridge-capability-request.js";
import { stableStringify } from "./stable-json.js";
import {
  authModeForRoute,
  joinOpenAiEndpointUrl,
  joinUpstreamUrl,
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
  createChatCompletionResponsesStream,
  returnedToolDiagnosticsFromChat,
  returnedToolDiagnosticsLogFields,
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
import { markRouteRateLimited, waitForRouteCapacity } from "./rate-limit.js";
import { annotateSmartFailoverResponse } from "./smart-failover-response.js";
import {
  createRouteTrace,
  recordRouteTraceEvent,
  routeTraceForLog,
} from "./route-trace.js";
import { routeDecisionTraceDetails } from "./route-decision-trace.js";
import {
  buildResponsesStreamErrorSse,
  extractResponseObjectFromSse,
  responsesSseStreamComplete,
} from "./sse.js";
import {
  buildToolContext,
  isResponseToolCallItem,
  isResponseToolOutputItem,
  toolDiagnosticsFromContext,
  toolDiagnosticsLogFields,
} from "./tools.js";
import {
  anthropicMessageToChatCompletion,
  chatRequestToAnthropicMessages,
  createAnthropicChatCompletionStreamTranslator,
} from "./anthropic-messages.js";
import {
  cancelUpstreamResponse,
  ClientClosedRequestError,
  isClientClosedStreamWrite,
  readUpstreamBody,
  readUpstreamText,
  UpstreamResponseTooLargeError,
  UpstreamTimeoutError,
  upstreamResponseIdleTimeoutMs,
  upstreamResponseLimitBytes,
  writeResponseChunk,
} from "./upstream-response-guard.js";
import {
  createUpstreamRequestLifecycle,
  streamingProxyFetchOptions,
  upstreamTimeoutMs,
} from "./upstream-request-lifecycle.js";
import {
  isNetworkFetchFailure,
  safeText,
  safeUrl,
  UpstreamHttpError,
  UpstreamNetworkError,
  UpstreamStreamError,
  upstreamErrorLogPreview,
} from "./upstream-network-errors.js";
import {
  createUpstreamErrorPresentation,
  responsesStreamFailureMessage,
} from "./upstream-error-presentation.js";
import { filteredHeaders, upstreamHeaders } from "./upstream-header-policy.js";
import {
  chatBodyWithoutImages,
  chatMessagesWithoutImages,
  createUpstreamImageRetryPolicy,
  imageRejectedFallbackChat,
} from "./upstream-image-retry-policy.js";
import { createUpstreamUrlFallbackPolicy } from "./upstream-url-fallback.js";
import {
  extractResponsesUsage,
  extractUsageObject,
  normalizeUsage,
} from "./upstream-usage.js";
import { buildHistoryTurn } from "./upstream-history-metadata.js";
import { shouldInlineLocalHistoryForResponses } from "./responses-history-policy.js";
import {
  chatMessagesToResponsesInput,
  inlineLocalHistoryForResponsesPayload,
} from "./responses-history-payload.js";
import { normalizeBridgePlainCompactionPayload } from "./responses-compaction-payload.js";
import { responsesCompactRequestOptions } from "./responses-compact-request-policy.js";
import { responsesBaseUrlForRoute } from "./responses-upstream-url.js";
import { chatToolContinuationTurns } from "./responses-tool-continuation.js";
import {
  latestToolResultSignaturesFromInput,
  responseToolCallSignatures,
} from "./responses-tool-signatures.js";
import {
  localToolLoopGuardChat,
  maxChatToolContinuationTurns,
  repeatedNoProgressToolLoopTurns,
  repeatedToolResultHasNoProgress,
  requestHasResponseToolOutput,
  responseHasRunnableToolCall,
  responseRepeatsPreviousToolCall,
  shouldStopChatToolContinuation,
} from "./responses-tool-loop-guard.js";
import {
  inputHasOpaqueUserInput,
  userInputSignatures,
} from "./responses-input-analysis.js";
import {
  isCompletedResponsesObject,
  isResponsesObject,
} from "./responses-object.js";
import { hydrateStreamedImageGenerationResults } from "./responses-image-results.js";
import {
  isPassThroughNonSuccessTerminal,
  responsesTerminalKind,
} from "./responses-stream-status.js";
import {
  createSseBlockAccumulator,
  finishSseBlockAccumulator,
  takeCompleteSseBlocks,
} from "./responses-sse-blocks.js";
import {
  appendDiagnosticTail,
  appendTerminalText,
  createTextBuffer,
  textBufferValue,
} from "./responses-stream-text.js";
import {
  looksLikeSseResponse,
  responseUsesEventStream,
  shouldAggregateForcedResponsesStream,
} from "./responses-stream-policy.js";

export {
  ClientClosedRequestError,
  UpstreamResponseTooLargeError,
  UpstreamTimeoutError,
  upstreamResponseIdleTimeoutMs,
  upstreamResponseLimitBytes,
} from "./upstream-response-guard.js";
export {
  streamingProxyFetchOptions,
  upstreamTimeoutMs,
} from "./upstream-request-lifecycle.js";
export {
  UpstreamHttpError,
  UpstreamNetworkError,
  UpstreamStreamError,
  upstreamErrorLogPreview,
};
export { responsesBaseUrlForRoute };

// A completed response is persisted both as the provider response and as an
// assistant history message. Keep headroom below the store's 100 MiB turn cap;
// the store remains the final whole-turn limit when source input is also large.
const { shouldRetryChatWithoutImages } = createUpstreamImageRetryPolicy({
  UpstreamHttpError,
});
const {
  chatCompletionsRootFallbackUrl,
  chatCompletionsV1FallbackUrl,
  responsesV1FallbackUrl,
  upstreamResponseLooksHtml,
} = createUpstreamUrlFallbackPolicy({ UpstreamHttpError });

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
    if (
      compactKind &&
      route.api === "responses" &&
      authModeForRoute(route) === "codex_openai"
    ) {
      return await proxyResponsesApi(requestBody, route, history, res, requestContext);
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
    if (route.api === "chat_completions" || route.api === "anthropic_messages") {
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
    const compactBody = buildCompactResponsesRequest(
      sourceRequest,
      responsesCompactRequestOptions(compactRoute),
    );
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
    ["chat_completions", "anthropic_messages", "responses"].includes(route.api) &&
    Boolean(requestBody.previous_response_id) &&
    !requestHasFreshInput(requestBody)
  );
}

function requestHasFreshInput(requestBody = {}) {
  return hasFreshInputValue(requestBody.messages) || hasFreshInputValue(requestBody.input);
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
  if (
    context.contextSwitchCompaction ||
    shouldInlineLocalHistoryForResponses(requestBody, history, route)
  ) {
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
    const bodyText = await readUpstreamText(upstream, context, route, activeUpstreamUrl);
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
      await recordResponsesHistory(history, completedResponse, sourceMessages, toolContext, {
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
      await recordResponsesHistory(history, completedResponse, sourceMessages, toolContext, {
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
    const responseText = upstream.body
      ? await readUpstreamText(upstream, context, route, activeUpstreamUrl)
      : "";
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
    await recordResponsesHistory(history, completedResponse, sourceMessages, toolContext, {
      requestBody,
      route,
    });
    logUsage(context, route, extractUsageObject(completedResponse) || extractResponsesUsage(responseText));
    jsonResponse(res, upstream.status, completedResponse);
    return;
  }

  if (!upstreamPayload.stream || !responseUsesEventStream(upstream)) {
    const responseText = upstream.body
      ? await readUpstreamText(upstream, context, route, activeUpstreamUrl)
      : "";
    const completedResponse = extractResponsesObject(responseText);
    const mislabeledResponsesStream =
      upstreamPayload.stream === true &&
      looksLikeSseResponse(responseText);
    if (mislabeledResponsesStream) {
      const headers = filteredHeaders(upstream.headers);
      headers["content-type"] = "text/event-stream; charset=utf-8";
      headers["cache-control"] = "no-cache";
      res.writeHead(upstream.status, headers);
      await writeResponseChunk(res, responseText, context);

      const terminalKind = responsesTerminalKind(responseText);
      if (isPassThroughNonSuccessTerminal(terminalKind, completedResponse)) {
        logUsage(
          context,
          route,
          extractUsageObject(completedResponse) || extractResponsesUsage(responseText),
        );
        res.end();
        return;
      }
      if (isCompletedResponsesObject(completedResponse)) {
        await recordResponsesHistory(history, completedResponse, sourceMessages, toolContext, {
          requestBody,
          route,
        });
        logUsage(
          context,
          route,
          extractUsageObject(completedResponse) || extractResponsesUsage(responseText),
        );
        res.end();
        return;
      }

      const message =
        `CodexBridge upstream stream from ${route.displayName || route.id || route.model || "route"} ` +
        "ended before response.completed or [DONE].";
      console.warn(
        `[${new Date().toISOString()}] ${context.requestId || "req"} ` +
          `!! upstream route=${route.id} mislabeled truncated responses stream ` +
          `content_type=${safeText(upstream.headers.get("content-type") || "missing", 80)} ` +
          `terminal=${terminalKind || "missing"} bytes=${Buffer.byteLength(responseText, "utf8")}`,
      );
      if (!/(\r?\n){2}$/.test(responseText)) {
        await writeResponseChunk(res, "\n\n", context);
      }
      await writeResponseChunk(res, buildResponsesStreamErrorSse(message, {
        code: "upstream_stream_truncated",
        model: requestBody.model || route.id || route.model || null,
      }), context);
      res.end();
      logUsage(
        context,
        route,
        extractUsageObject(completedResponse) || extractResponsesUsage(responseText),
      );
      throw new UpstreamStreamError(
        message,
        activeUpstreamUrl,
        route,
        "upstream_stream_truncated",
      );
    }
    if (!isCompletedResponsesObject(completedResponse)) {
      throw new UpstreamHttpError(
        502,
        `Upstream returned HTTP ${upstream.status} without a completed response: ` +
          responseText.slice(0, 500),
        activeUpstreamUrl,
        route,
      );
    }
    await recordResponsesHistory(history, completedResponse, sourceMessages, toolContext, {
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
  let terminalComplete = false;
  let streamError = null;
  try {
    upstreamRead:
    for await (const chunk of readUpstreamBody(
      upstream,
      context,
      route,
      activeUpstreamUrl,
      { streamingResponse: true },
    )) {
      const blocks = takeCompleteSseBlocks(pendingEvent, Buffer.from(chunk));
      for (const block of blocks) {
        if (terminalStarted || responsesSseStreamComplete(block)) {
          terminalStarted = true;
          appendTerminalText(terminalBuffer, block);
          terminalComplete = responsesSseStreamComplete(textBufferValue(terminalBuffer));
          continue;
        }
        diagnosticTail = appendDiagnosticTail(diagnosticTail, block);
        await writeResponseChunk(res, block, context);
      }
      if (terminalComplete) {
        break upstreamRead;
      }
    }
    const pendingText = finishSseBlockAccumulator(pendingEvent);
    if (pendingText) {
      if (terminalStarted || responsesSseStreamComplete(pendingText)) {
        terminalStarted = true;
        appendTerminalText(terminalBuffer, pendingText);
      } else {
        diagnosticTail = appendDiagnosticTail(diagnosticTail, pendingText);
        await writeResponseChunk(res, pendingText, context);
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
        await writeResponseChunk(res, buildResponsesStreamErrorSse("上游流式响应超时，请稍后重试。", {
          code: "upstream_timeout",
          model: requestBody.model || route.id || route.model || null,
        }), context);
        res.end();
      }
      logUsage(context, route, usage);
      throw streamError;
    }
    if (streamError instanceof UpstreamResponseTooLargeError) {
      const message =
        `CodexBridge stopped the upstream stream after it exceeded ` +
        `${streamError.limitBytes} bytes.`;
      if (!res.destroyed && !res.writableEnded) {
        await writeResponseChunk(res, buildResponsesStreamErrorSse(message, {
          code: "upstream_response_too_large",
          model: requestBody.model || route.id || route.model || null,
        }), context);
        res.end();
      }
      logUsage(context, route, usage);
      throw streamError;
    }
    if (streamError?.localHistoryError) {
      const localError = asLocalHistoryStorageError(streamError);
      const message = "本地模型历史保存失败，请新建会话后重试。";
      if (!res.destroyed && !res.writableEnded) {
        await writeResponseChunk(res, buildResponsesStreamErrorSse(message, {
          code: "local_history_storage_unavailable",
          model: requestBody.model || route.id || route.model || null,
        }), context);
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
      await writeResponseChunk(res, buildResponsesStreamErrorSse(message, {
        model: requestBody.model || route.id || route.model || null,
      }), context);
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
    await writeResponseChunk(res, buildResponsesStreamErrorSse(message, {
      model: requestBody.model || route.id || route.model || null,
    }), context);
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
    await recordResponsesHistory(history, completedResponse, sourceMessages, toolContext, {
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

  const upstreamUrl = route.api === "anthropic_messages"
    ? joinUpstreamUrl(route.baseUrl, "/messages")
    : joinOpenAiEndpointUrl(route.baseUrl, "/chat/completions");
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
  if (route.api === "anthropic_messages") {
    const upstreamUrl = joinUpstreamUrl(route.baseUrl, "/messages");
    logRoute(context, route, upstreamUrl);
    const anthropicPayload = chatRequestToAnthropicMessages(
      { ...payload, stream: true },
      route,
    );
    const upstream = await fetchUpstream(
      upstreamUrl,
      {
        method: "POST",
        headers: upstreamHeaders(route, context, {
          acceptEventStream: true,
        }),
        body: JSON.stringify(anthropicPayload),
      },
      context,
      route,
      { streamingResponse: true },
    );
    logStatus(context, route, upstream.status);
    if (!upstream.ok) {
      const bodyText = await readUpstreamText(upstream, context, route, upstreamUrl);
      throw new UpstreamHttpError(upstream.status, bodyText, upstreamUrl, route, {
        headers: upstream.headers,
      });
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const translator = createAnthropicChatCompletionStreamTranslator(route);
    const decoder = new TextDecoder();
    if (upstream.body) {
      for await (const chunk of readUpstreamBody(
        upstream,
        context,
        route,
        upstreamUrl,
        { streamingResponse: true },
      )) {
        for (const event of translator.push(decoder.decode(chunk, { stream: true }))) {
          await writeResponseChunk(res, event, context);
        }
      }
    }
    for (const event of translator.push(decoder.decode())) {
      await writeResponseChunk(res, event, context);
    }
    for (const event of translator.end()) {
      await writeResponseChunk(res, event, context);
    }
    if (!translator.completed) {
      throw new UpstreamStreamError(
        `CodexBridge upstream Anthropic stream from ${route.displayName || route.id || route.model || "route"} ended before message_stop.`,
        upstreamUrl,
        route,
        "upstream_stream_truncated",
      );
    }
    logUsage(context, route, translator.usage);
    res.end();
    return;
  }

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
    const bodyText = await readUpstreamText(upstream, context, route, activeUpstreamUrl);
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
    for await (const chunk of readUpstreamBody(
      upstream,
      context,
      route,
      activeUpstreamUrl,
      { streamingResponse: true },
    )) {
      await writeResponseChunk(res, chunk, context);
    }
    logUsage(context, route, null);
    res.end();
  } catch (error) {
    if (
      error instanceof ClientClosedRequestError ||
      error instanceof UpstreamTimeoutError ||
      error instanceof UpstreamResponseTooLargeError
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
  const upstreamUrl = route.api === "anthropic_messages"
    ? joinUpstreamUrl(route.baseUrl, "/messages")
    : joinOpenAiEndpointUrl(route.baseUrl, "/chat/completions");
  logRoute(context, route, upstreamUrl);
  let messagesForHistory = converted.messagesForHistory;
  let upstream;
  let chatResponseStream = null;
  try {
    if (converted.wantsStream && route.api === "chat_completions") {
      const streamed = await callChatCompletionsResponsesStreamUpstream(
        upstreamUrl,
        route,
        converted.body,
        requestBody.model || route.id,
        res,
        context,
        {
          emitTextDeltas: shouldEmitChatResponseTextDeltas(
            requestBody,
            route,
            context,
            converted,
          ),
          emitReasoningDeltas: shouldEmitChatResponseReasoningDeltas(
            requestBody,
            route,
            context,
            converted,
          ),
        },
      );
      upstream = streamed.chat;
      chatResponseStream = streamed.stream;
      if (chatResponseStream?.failed) {
        if (!res.writableEnded) {
          res.end();
        }
        return;
      }
    } else {
      upstream = await callChatCompletionsUpstream(
        upstreamUrl,
        route,
        converted.body,
        context,
      );
    }
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
      if (converted.wantsStream && route.api === "chat_completions") {
        const streamed = await callChatCompletionsResponsesStreamUpstream(
          upstreamUrl,
          route,
          textOnlyBody,
          requestBody.model || route.id,
          res,
          context,
          {
            trackRateLimit: false,
            emitTextDeltas: shouldEmitChatResponseTextDeltas(
              requestBody,
              route,
              context,
              converted,
            ),
            emitReasoningDeltas: shouldEmitChatResponseReasoningDeltas(
              requestBody,
              route,
              context,
              converted,
            ),
          },
        );
        upstream = streamed.chat;
        chatResponseStream = streamed.stream;
        if (chatResponseStream?.failed) {
          if (!res.writableEnded) {
            res.end();
          }
          return;
        }
      } else {
        upstream = await callChatCompletionsUpstream(
          upstreamUrl,
          route,
          textOnlyBody,
          context,
          { trackRateLimit: false },
        );
      }
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
      includeReasoningSummary: shouldExposeChatReasoningSummary(route),
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
  if (chatResponseStream?.responseStarted) {
    response = chatResponseStream.alignResponse(response);
  }

  await recordHistoryTurn(
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
    const payload = chatResponseStream
      ? chatResponseStream.finish(response)
      : responseToSse(response);
    if (!chatResponseStream || !chatResponseStream.responseStarted) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
    }
    res.end(payload);
    return;
  }

  jsonResponse(res, 200, response);
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
  await recordHistoryTurn(
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
  if (route.api === "anthropic_messages") {
    const anthropicPayload = chatRequestToAnthropicMessages(payload, route);
    const anthropicResponse = await callJsonUpstream(
      upstreamUrl,
      route,
      anthropicPayload,
      context,
      options,
    );
    return anthropicMessageToChatCompletion(anthropicResponse, route);
  }
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

async function callChatCompletionsResponsesStreamUpstream(
  upstreamUrl,
  route,
  payload,
  requestedModel,
  res,
  context = {},
  options = {},
) {
  const {
    emitTextDeltas = true,
    emitReasoningDeltas = false,
    ...fetchOptions
  } = options;
  const upstreamPayload = filterPayloadForUpstream(
    { ...payload, stream: true },
    route,
    context,
    { api: "chat_completions" },
  );
  let activeUpstreamUrl = upstreamUrl;
  const upstreamInit = {
    method: "POST",
    headers: upstreamHeaders(route, context, { acceptEventStream: true }),
    body: JSON.stringify(upstreamPayload),
  };
  let upstream = await fetchUpstream(
    activeUpstreamUrl,
    upstreamInit,
    context,
    route,
    { ...fetchOptions, streamingResponse: true },
  );
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
    upstream = await fetchUpstream(
      activeUpstreamUrl,
      upstreamInit,
      context,
      route,
      { ...fetchOptions, streamingResponse: true },
    );
    logStatus(context, route, upstream.status);
  }

  if (!upstream.ok) {
    const bodyText = await readUpstreamText(upstream, context, route, activeUpstreamUrl);
    throw new UpstreamHttpError(upstream.status, bodyText, activeUpstreamUrl, route, {
      headers: upstream.headers,
    });
  }

  const stream = createChatCompletionResponsesStream(
    requestedModel || route.id || route.model,
    null,
    { emitTextDeltas, emitReasoningDeltas },
  );
  let detectedEventStream = responseUsesEventStream(upstream);
  let bufferedChunks = [];
  let downstreamHeadersSent = false;
  const writeStreamEvents = async (events) => {
    if (events.length > 0 && !downstreamHeadersSent) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      downstreamHeadersSent = true;
    }
    for (const event of events) {
      await writeResponseChunk(res, event, context);
    }
  };
  if (upstream.body) {
    for await (const chunk of readUpstreamBody(
      upstream,
      context,
      route,
      activeUpstreamUrl,
      { streamingResponse: true },
    )) {
      if (!detectedEventStream) {
        bufferedChunks.push(chunk);
        const bufferedText = Buffer.concat(bufferedChunks).toString("utf8");
        if (!looksLikeSseResponse(bufferedText)) {
          continue;
        }
        detectedEventStream = true;
        for (const bufferedChunk of bufferedChunks) {
          await writeStreamEvents(stream.push(bufferedChunk));
          if (stream.sawDone) {
            break;
          }
        }
        bufferedChunks = [];
        if (stream.sawDone) {
          break;
        }
        continue;
      }
      await writeStreamEvents(stream.push(chunk));
      if (stream.sawDone) {
        break;
      }
    }
  }
  if (!detectedEventStream) {
    const bodyText = Buffer.concat(bufferedChunks).toString("utf8");
    const chat = tryParseJson(bodyText);
    if (chat) {
      return { chat, stream: null };
    }
    throw new UpstreamHttpError(
      502,
      `Upstream returned non-JSON body: ${bodyText.slice(0, 500)}`,
      activeUpstreamUrl,
      route,
    );
  }
  await writeStreamEvents(stream.end());
  if (!stream.completed) {
    const message =
      `CodexBridge upstream chat stream from ${route.displayName || route.id || route.model || "route"} ` +
      "ended before finish_reason or [DONE].";
    const error = new UpstreamStreamError(
      message,
      activeUpstreamUrl,
      route,
      "upstream_stream_truncated",
    );
    if (stream.responseStarted && !res.destroyed && !res.writableEnded) {
      res.end(buildResponsesStreamErrorSse(message, {
        code: "upstream_stream_truncated",
        model: requestedModel || route.id || route.model || null,
      }));
    }
    throw error;
  }
  return { chat: stream.chat, stream };
}

async function proxyResponsesCompact(requestBody, route, history, res, context = {}) {
  const compactBody = buildCompactResponsesRequest(
    requestBody,
    responsesCompactRequestOptions(route),
  );
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
  await recordHistoryTurn(
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
  const text = await readUpstreamText(upstream, context, route, upstreamUrl, options);
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

async function sendLocalImageRejectedResponse({
  requestBody,
  route,
  history,
  res,
  context,
  converted,
  messagesForHistory,
  retryError,
}) {
  const status = retryError?.statusCode ? `HTTP ${retryError.statusCode}` : "";
  const parsed = retryError instanceof UpstreamHttpError
    ? tryParseJson(retryError.bodyText)
    : null;
  const upstreamMessage = retryError instanceof UpstreamHttpError
    ? upstreamBodyMessage(retryError.bodyText, parsed)
    : safeText(retryError?.message || "", 300);
  const retryDetail = [status, upstreamMessage].filter(Boolean).join(" - ");
  const localChat = imageRejectedFallbackChat(route, retryDetail);
  const response = chatResponseToResponse(
    localChat,
    requestBody.model || route.id,
    converted.toolContext,
    { stripReasoningTags: false },
  );

  await recordHistoryTurn(
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
  const text = await readUpstreamText(upstream, context, route, upstreamUrl, options);
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

export function __resetUpstreamFailureCacheForTests() {
  // Compatibility hook retained for callers while the old payload failure cache is removed.
}

const {
  sendUpstreamError: sendUpstreamErrorInternal,
  upstreamBodyMessage,
} = createUpstreamErrorPresentation({
  UpstreamHttpError,
  UpstreamNetworkError,
  UpstreamStreamError,
  UpstreamTimeoutError,
});

export const sendUpstreamError = sendUpstreamErrorInternal;

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

async function fetchAndTrackRateLimit(upstreamUrl, init, route, options = {}, context = {}) {
  const abortable = createUpstreamRequestLifecycle(
    init,
    upstreamUrl,
    route,
    options,
    context,
  );
  try {
    const response = await fetch(upstreamUrl, abortable.init);
    if (response.status === 429 && options.trackRateLimit !== false) {
      markRouteRateLimited(route, response.headers);
    }
    abortable.responseStarted(response);
    return responseWithAbortLifecycle(response, abortable, upstreamUrl, route);
  } catch (error) {
    abortable.cleanup();
    throw abortable.errorFor(error);
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
        controller.error(abortable.errorFor(error));
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

function extractResponsesObject(text) {
  return hydrateStreamedImageGenerationResults(
    extractResponseObjectFromSse(text),
    text,
  );
}

async function recordResponsesHistory(
  history,
  response,
  sourceMessages,
  toolContext,
  { requestBody = {}, route = {} } = {},
) {
  if (!history || !isResponsesObject(response)) {
    return;
  }
  await recordHistoryTurn(
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

async function recordHistoryTurn(
  history,
  response,
  messages,
  meta = {},
  { requestBody = {}, route = {} } = {},
) {
  if (!history) {
    return;
  }
  const turn = buildHistoryTurn(response, messages, meta, { requestBody, route });
  if (!turn) {
    return;
  }
  try {
    if (typeof history.recordTurnAsync === "function") {
      await history.recordTurnAsync(turn);
      return;
    }
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

function shouldEmitChatResponseTextDeltas(
  requestBody = {},
  route = {},
  context = {},
  converted = {},
) {
  return (
    !shouldStripReasoningTags(route) &&
    !interactivePluginKindForRequest(requestBody) &&
    !context.failoverFromRoute &&
    !mayContinueWithBridgeCapability(converted, context)
  );
}

function shouldEmitChatResponseReasoningDeltas(
  requestBody = {},
  route = {},
  context = {},
  converted = {},
) {
  return (
    shouldExposeChatReasoningSummary(route) &&
    shouldEmitChatResponseTextDeltas(requestBody, route, context, converted)
  );
}

function shouldExposeChatReasoningSummary(route = {}) {
  if (route.api !== "chat_completions") {
    return false;
  }
  const provider = String(route.provider || route.providerId || "").toLowerCase();
  const model = String(route.model || route.id || "").toLowerCase();
  if (provider === "deepseek") {
    return model.includes("deepseek-v4") || model.includes("deepseek-reasoner");
  }
  try {
    const hostname = new URL(route.baseUrl || "").hostname.toLowerCase();
    return hostname.includes("deepseek") &&
      (model.includes("deepseek-v4") || model.includes("deepseek-reasoner"));
  } catch {
    return false;
  }
}

function mayContinueWithBridgeCapability(converted = {}, context = {}) {
  if (typeof context.executeCapabilityRequest !== "function") {
    return false;
  }
  return (converted?.body?.tools || []).some(
    (tool) => tool?.function?.name === CODEXBRIDGE_CAPABILITY_TOOL_NAME,
  );
}
