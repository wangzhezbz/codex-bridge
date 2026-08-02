import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authModeForRoute, joinUpstreamUrl, loadConfig } from "./config.js";
import { ResponseHistory } from "./history.js";
import {
  jsonResponse,
  openAiError,
  readImageEditRequest,
  readJsonRequest,
  readJsonRequestWithMetadata,
  requestBodyTooLargeError,
} from "./json.js";
import { buildModelCatalog, openAiModelsList } from "./model-catalog.js";
import { isResponsesCompactPath, requestHasCompactionTrigger } from "./compact.js";
import { responseToSse } from "./chat-to-responses.js";
import {
  handleResponsesRequest,
  callJsonUpstream,
  proxyDirectChatCompletions,
  proxyResponsesApi,
  responsesBaseUrlForRoute,
  sendUpstreamError,
  upstreamErrorLogPreview,
} from "./upstream.js";
import { classifyUpstreamError, createRouteHealthStore } from "./route-health.js";
import { normalizeAdapterProfile } from "./adapter-profile.js";
import { selectFailoverRoute, smartRoutingOptions } from "./smart-routing.js";
import { createRoutePlan, routePlanProblemMessage } from "./route-plan.js";
import { createUsageBudgetGuard } from "./usage-budget-guard.js";
import { resolveResponseHistoryPath } from "./router-data-dir.js";
import {
  createCapabilityProviderRegistry,
  runCapabilityProxy,
} from "./capability-proxy.js";
import { saveCapabilityAssetResult } from "./capability-assets.js";
import { normalizeContextPolicyConfig } from "./context-policy.js";
import { createPendingRequestGuard } from "./pending-request-guard.js";
import { createCodexModelSelectionState } from "./codex-model-selection.js";

const DEFAULT_JSON_BODY_LIMIT_BYTES = 25 * 1024 * 1024;
const DEFAULT_RESPONSES_BODY_LIMIT_BYTES = 100 * 1024 * 1024;
const DEFAULT_RESPONSES_COMPACT_BODY_LIMIT_BYTES = 200 * 1024 * 1024;
const DEFAULT_CAPABILITY_PROVIDER_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const BENIGN_ROUTER_PROCESS_ERROR_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ECONNABORTED",
  "ETIMEDOUT",
  "UND_ERR_ABORTED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_PREMATURE_CLOSE",
]);
let routerProcessGuardsInstalled = false;

export function isBenignRouterProcessError(error) {
  const candidates = [
    error?.code,
    error?.errno,
    error?.cause?.code,
    error?.cause?.errno,
  ]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value));
  if (candidates.some((code) => BENIGN_ROUTER_PROCESS_ERROR_CODES.has(code))) {
    return true;
  }
  const message = String(error?.message || error || "");
  return [...BENIGN_ROUTER_PROCESS_ERROR_CODES].some((code) => message.includes(code));
}

export function installRouterProcessGuards(processLike = process) {
  if (routerProcessGuardsInstalled || !processLike?.on) {
    return;
  }
  routerProcessGuardsInstalled = true;
  const handleProcessError = (label, error) => {
    if (isBenignRouterProcessError(error)) {
      console.warn(
        `[${new Date().toISOString()}] router ${label}: ignored benign network/socket error: ` +
          safeLogValue(error?.stack || error?.message || error),
      );
      return;
    }
    console.error(
      `[${new Date().toISOString()}] router ${label}: fatal error: ` +
        (error?.stack || error?.message || error),
    );
    processLike.exitCode = 1;
    if (typeof processLike.exit === "function") {
      processLike.exit(1);
    }
  };
  processLike.on("uncaughtException", (error) => {
    handleProcessError("uncaughtException", error);
  });
  processLike.on("unhandledRejection", (reason) => {
    handleProcessError("unhandledRejection", reason);
  });
}

export function createRouterServer(
  config = loadConfig(),
  { history: injectedHistory = null, historyPath = "", historyOptions = {} } = {},
) {
  const ownsHistory = !injectedHistory;
  const history = injectedHistory || new ResponseHistory({
    ...historyOptions,
    historyPath,
  });
  const routeHealth = createRouteHealthStore();
  const usageBudgetGuard = createUsageBudgetGuard();
  const pendingRequestGuard = createPendingRequestGuard();
  const codexModelSelection = createCodexModelSelectionState();
  const socketsWithErrorHandler = new WeakSet();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      logAccess(req, url);
      const activeConfig = currentConfig(config);
      const originPolicy = requestOriginPolicy(req, activeConfig);
      if (!originPolicy.ok) {
        jsonResponse(
          res,
          403,
          openAiError(
            "Browser origin is not allowed to access CodexBridge Router.",
            403,
            "origin_not_allowed",
          ),
        );
        return;
      }
      if (originPolicy.origin) {
        applyCorsResponseHeaders(res, originPolicy.origin);
      }

      if (req.method === "OPTIONS") {
        writeCors(res);
        return;
      }

      if (isUpgradeRequest(req) && isResponsesCollection(url.pathname)) {
        jsonResponse(
          res,
          426,
          openAiError(
            `CodexBridge Router does not support WebSocket on ${url.pathname}. Use HTTP streaming for Responses requests.`,
            426,
            "websocket_not_supported",
          ),
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        const health = routeHealth.snapshot(activeConfig);
        jsonResponse(res, 200, {
          ok: true,
          config: activeConfig.__path || null,
          models: activeConfig.models.map((model) => model.id),
          routes: health.routes,
          unhealthyRoutes: health.unhealthyRoutes,
        });
        return;
      }

      if (
        req.method === "GET" &&
        ["/v1/models", "/models"].includes(url.pathname)
      ) {
        jsonResponse(res, 200, openAiModelsList(activeConfig));
        return;
      }

      if (
        req.method === "GET" &&
        ["/model-catalog.json", "/v1/model-catalog.json"].includes(url.pathname)
      ) {
        jsonResponse(res, 200, buildModelCatalog(activeConfig));
        return;
      }

      if (req.method === "GET" && isResponsesCollection(url.pathname)) {
        jsonResponse(res, 200, {
          object: "list",
          data: [],
          has_more: false,
        });
        return;
      }

      const responseItemId = responseIdFromItemPath(url.pathname);
      if (req.method === "GET" && responseItemId) {
        jsonResponse(
          res,
          200,
          history.getResponse(responseItemId) ||
            placeholderResponse(responseItemId, activeConfig.defaultModel),
        );
        return;
      }

      const responseCancelId = responseIdFromCancelPath(url.pathname);
      if (req.method === "POST" && responseCancelId) {
        jsonResponse(
          res,
          200,
          placeholderResponse(responseCancelId, activeConfig.defaultModel, "cancelled"),
        );
        return;
      }

      if (
        ["PATCH", "PUT"].includes(req.method || "") &&
        isModelSettingsPath(url.pathname)
      ) {
        const body = await readJsonRequest(req, requestBodyLimitBytes(activeConfig, url.pathname));
        const modelSettingResponseId = responseIdFromModelSettingsPath(url.pathname);
        const previousResponse = modelSettingResponseId
          ? history.getResponse(modelSettingResponseId)
          : null;
        const previousResponseMeta = modelSettingResponseId
          ? history.getResponseMeta(modelSettingResponseId)
          : null;
        const modelSetting = codexModelSelection.recordModelSetting({
          headers: req.headers,
          pathname: url.pathname,
          body,
          previousModel:
            previousResponseMeta?.routeId ||
            previousResponseMeta?.routeSnapshot?.id ||
            previousResponse?.model ||
            "",
        });
        if (modelSetting.recorded) {
          console.log(
            `[${new Date().toISOString()}] model-setting selected_model=${safeLogValue(modelSetting.selectedModel)} ` +
              `previous_model=${safeLogValue(modelSetting.previousModel || "-")} ` +
              `scope=${safeLogValue(modelSetting.scope)}`,
          );
        }
        jsonResponse(res, 200, {
          ok: true,
          object: "codexbridge.model_settings",
          model: body.model || activeConfig.defaultModel || null,
          model_reasoning_effort:
            body.model_reasoning_effort || body.reasoning_effort || null,
        });
        return;
      }

      if (
        req.method === "POST" &&
        isResponsesPostPath(url.pathname)
      ) {
        const ordinaryBodyLimitBytes = requestBodyLimitBytes(activeConfig, url.pathname);
        const compactBodyLimitBytes = responsesCompactRequestBodyLimitBytes(
          activeConfig,
          url.pathname,
        );
        const { body, decodedBytes } = await readJsonRequestWithMetadata(
          req,
          compactBodyLimitBytes,
        );
        const compactKind = compactKindForRequest(url.pathname, body);
        if (!compactKind && decodedBytes > ordinaryBodyLimitBytes) {
          throw requestBodyTooLargeError(ordinaryBodyLimitBytes, decodedBytes);
        }
        const modelSetting = codexModelSelection.applyToRequest({
          headers: req.headers,
          body,
          configuredModelIds: activeConfig.models
            .filter((model) => model.enabled !== false)
            .map((model) => model.id),
        });
        if (modelSetting.changed) {
          console.warn(
            `[${new Date().toISOString()}] model-setting-reconnect ` +
              `stale_model=${safeLogValue(modelSetting.requestedModel)} ` +
              `selected_model=${safeLogValue(modelSetting.selectedModel)} ` +
              `scope=${safeLogValue(modelSetting.scope)}`,
          );
        }
        const requestedModel = body.model || "";
        const requestId = makeRequestId();
        const isCodexClient = isCodexClientRequest(req);
        let route;
        let routeSelection;
        let routePlan;
        try {
          const health = routeHealth.snapshot(activeConfig);
          const routeExclusions = automaticRouteExclusions(
            activeConfig,
            health,
            usageBudgetGuard,
          );
          if (smartRoutingOptions(activeConfig).autoSelectModel) {
            logAutomaticRouteExclusions(requestId, "auto-select", routeExclusions);
          }
          routePlan = createRoutePlan(activeConfig, body, {
            isCodexClient,
            compactKind,
            routeExclusions,
            routeOptions: {
              exactModelIdOnly: isCodexClient,
            },
          });
          route = routePlan.route;
          routeSelection = routePlan.routeSelection;
          if (routePlan.rewriteModel) {
            body.model = routePlan.rewriteModel;
          }
          if (routePlan.changed) {
            console.warn(
              `[${new Date().toISOString()}] ${requestId} !! route-plan ` +
                `kind=${routePlan.requestKind} reason=${routePlan.reason} ` +
                `requested_model=${routePlan.requestedModel || "(default)"} ` +
                `route=${route?.id || "(none)"}`,
            );
          }
        } catch (error) {
          if (isCodexClient && error?.code === "auxiliary_route_not_available") {
            console.warn(
              `[${new Date().toISOString()}] ${requestId} !! route-plan-guard ` +
                `model=${body.model || "(default)"} reason=${error.code} ` +
                `configured_route=${error.details?.configuredRouteId || "(none)"}`,
            );
            sendLocalCompletedResponse(res, body, routePlanProblemLocalResponse(body.model, error));
            return;
          }
          if (isCodexClient && error?.code === "model_not_configured") {
            console.warn(
              `[${new Date().toISOString()}] ${requestId} !! local-model-guard ` +
                `model=${body.model || "(default)"} reason=model_not_configured`,
            );
            sendLocalCompletedResponse(res, body, modelNotConfiguredLocalResponse(body.model, error));
            return;
          }
          {
            throw error;
          }
        }
        const clientAuth = authorizeClient(req, activeConfig, route);
        if (!clientAuth.ok) {
          jsonResponse(
            res,
            401,
            openAiError(
              "CodexBridge Router token mismatch. 请在 CodexBridge 关闭并重新开启 Router，配置会自动刷新，然后重试。",
              401,
              "invalid_router_token",
            ),
          );
          return;
        }
        const localHistoryProblem = localChatHistoryProblem(body, route, history);
        if (localHistoryProblem) {
          jsonResponse(
            res,
            localHistoryProblem.statusCode,
            openAiError(
              localHistoryProblem.message,
              localHistoryProblem.statusCode,
              localHistoryProblem.code,
            ),
          );
          return;
        }
        const capabilityRequest = explicitCapabilityRequestFromBody(body);
        if (capabilityRequest) {
          const pendingRequest = beginServerPendingRequest({
            guard: pendingRequestGuard,
            config: activeConfig,
            route,
            compactKind,
            headers: req.headers,
            requestBody: body,
            requestId,
            responseKind: "responses",
            res,
          });
          if (pendingRequest.served) {
            return;
          }
          try {
            console.log(
              `[${new Date().toISOString()}] ${requestId} <- /v1/responses ` +
                `model=${body.model || "(default)"} route=${route.id} ` +
                `capability=${capabilityRequest.capability} ` +
                `provider=${capabilityRequest.providerId || "(default)"} ` +
                `client_auth=${clientAuth.kind}`,
            );
            const result = await executeServerCapabilityRequest(activeConfig, capabilityRequest, {
              sourceModel: body.model || route.id || "",
            });
            sendLocalCompletedResponse(
              res,
              body,
              capabilityLocalResponse(body, result),
            );
          } finally {
            releaseServerPendingRequest(pendingRequestGuard, pendingRequest.lease);
          }
          return;
        }
        const budgetCheck = usageBudgetGuard.check(activeConfig, route);
        if (!budgetCheck.ok) {
          console.warn(
            `[${new Date().toISOString()}] ${requestId} !! usage-budget-guard ` +
              `route=${route.id} scope=${budgetCheck.scope} id=${budgetCheck.id} ` +
              `metric=${budgetCheck.metric} used=${budgetCheck.used} limit=${budgetCheck.limit} ` +
              `remaining=${budgetCheck.remaining} unit=${budgetCheck.unit || "-"}`,
          );
          sendLocalCompletedResponse(
            res,
            body,
            usageBudgetLocalResponse(body.model || route.id, budgetCheck),
          );
          return;
        }
        const clientAbort = clientAbortContext(req, res);
        const onUpstreamUsage = (usageRoute, usage) => {
          usageBudgetGuard.recordUsage(activeConfig, usageRoute, usage);
        };
        console.log(
          `[${new Date().toISOString()}] ${requestId} <- /v1/responses ` +
            `model=${body.model || "(default)"} route=${route.id} ` +
            `api=${route.api} upstream_model=${route.model} stream=${Boolean(body.stream)} ` +
            `provider=${providerLogLabel(route)} ` +
            smartRouteLogPart(routeSelection) +
            `compact=${compactKind || "-"} ` +
            `previous_response_id=${body.previous_response_id || "-"} ` +
            `client_auth=${clientAuth.kind} upstream_auth=${authModeForRoute(route)}`,
        );
        try {
          await handleResponsesRequest(body, route, history, res, {
            requestId,
            requestedModel,
            clientAuth,
            clientHeaders: req.headers,
            clientSignal: clientAbort.signal,
            activeConfig,
            configRevision: activeConfig.configRevision || "",
            requestSurface: "responses",
            duplicateRequestProtection: activeConfig.duplicateRequestProtection === true,
            pendingRequestGuard,
            compactKind,
            capabilityProviders: activeConfig.capabilityProviders,
            routePlan,
            routeSelection,
            executeCapabilityRequest: (capabilityRequest) =>
              executeServerCapabilityRequest(activeConfig, capabilityRequest, {
                sourceModel: body.model || route.id || "",
              }),
            onUpstreamUsage,
            deferLocalRateLimitResponse: Boolean(
              selectFailoverRoute(activeConfig, route, { statusCode: 429 }, {
                excludedRouteIds: automaticRouteExclusionIds(
                  activeConfig,
                  routeHealth.snapshot(activeConfig),
                  usageBudgetGuard,
                ),
              }),
            ),
          });
          routeHealth.recordSuccess(route);
        } catch (error) {
          if (error?.code === "client_closed_request") {
            console.warn(
              `[${new Date().toISOString()}] ${requestId} !! client closed request before upstream completed`,
            );
            return;
          }
          if (error?.code === "context_switch_compaction_failed") {
            console.error(requestErrorLine(requestId, route, error, { compactKind }));
            if (!res.destroyed && !res.writableEnded) {
              sendUpstreamError(res, error, {
                asResponsesStream: Boolean(body.stream),
                model: body.model || route.id || route.model || null,
              });
            }
            return;
          }
          if (isLocalHistoryError(error)) {
            console.error(requestErrorLine(requestId, route, error, { compactKind }));
            if (!res.destroyed && !res.writableEnded) {
              sendUpstreamError(res, error, {
                asResponsesStream: Boolean(body.stream),
                model: body.model || route.id || route.model || null,
              });
            }
            return;
          }
          routeHealth.recordError(route, error, { compactKind });
          console.error(requestErrorLine(requestId, route, error, { compactKind }));
          let responseError = error;
          let responseRoute = route;
          const failoverExclusions = automaticRouteExclusions(
            activeConfig,
            routeHealth.snapshot(activeConfig),
            usageBudgetGuard,
          );
          logAutomaticRouteExclusions(requestId, "failover", failoverExclusions);
          const failoverSelection = selectFailoverRoute(activeConfig, route, error, {
            excludedRouteIds: failoverExclusions.ids,
          });
          if (canTrySmartFailover(res, failoverSelection)) {
            console.warn(
              `[${new Date().toISOString()}] ${requestId} !! smart-failover ` +
                `route=${route.id} fallback_route=${failoverSelection.route.id} ` +
                `reason=${failoverSelection.reason}`,
            );
            try {
              await handleResponsesRequest(body, failoverSelection.route, history, res, {
                requestId,
                requestedModel,
                clientAuth,
                clientHeaders: req.headers,
                clientSignal: clientAbort.signal,
                activeConfig,
                configRevision: activeConfig.configRevision || "",
                requestSurface: "responses",
                duplicateRequestProtection: activeConfig.duplicateRequestProtection === true,
                pendingRequestGuard,
                compactKind,
                capabilityProviders: activeConfig.capabilityProviders,
                routePlan,
                routeSelection: failoverSelection,
                executeCapabilityRequest: (capabilityRequest) =>
                  executeServerCapabilityRequest(activeConfig, capabilityRequest, {
                    sourceModel: body.model || failoverSelection.route.id || "",
                  }),
                onUpstreamUsage,
                deferLocalRateLimitResponse: false,
                failoverFromRoute: route.id,
                failoverFromModel: route.model || "",
                failoverFromDisplayName: route.displayName || route.id || route.model || "",
                smartFailoverReason: failoverSelection.reason,
              });
              routeHealth.recordSuccess(failoverSelection.route, {
                failoverFromRoute: route.id,
              });
              return;
            } catch (failoverError) {
              if (failoverError?.code === "client_closed_request") {
                console.warn(
                  `[${new Date().toISOString()}] ${requestId} !! client closed request before failover completed`,
                );
                return;
              }
              routeHealth.recordError(failoverSelection.route, failoverError, {
                compactKind,
                failoverFromRoute: route.id,
              });
              console.error(requestErrorLine(requestId, failoverSelection.route, failoverError, {
                compactKind,
                failoverFromRoute: route.id,
              }));
              responseError = failoverError;
              responseRoute = failoverSelection.route;
            }
          }
          if (!res.destroyed && !res.writableEnded) {
            sendUpstreamError(res, responseError, {
              asResponsesStream: Boolean(body.stream),
              model: body.model || responseRoute.id || responseRoute.model || null,
            });
          }
        } finally {
          clientAbort.cleanup();
        }
        return;
      }

      if (
        req.method === "POST" &&
        (isImageGenerationsPostPath(url.pathname) || isImageEditsPostPath(url.pathname))
      ) {
        const isImageEdit = isImageEditsPostPath(url.pathname);
        const body = isImageEdit
          ? await readImageEditRequest(req, requestBodyLimitBytes(activeConfig, url.pathname))
          : await readJsonRequest(req, requestBodyLimitBytes(activeConfig, url.pathname));
        const route = defaultEnabledRoute(activeConfig);
        if (!route) {
          jsonResponse(
            res,
            404,
            openAiError(`No enabled model route is available for image ${isImageEdit ? "editing" : "generation"}.`, 404),
          );
          return;
        }
        const clientAuth = authorizeClient(req, activeConfig, route);
        if (!clientAuth.ok) {
          jsonResponse(res, 401, openAiError("CodexBridge Router token mismatch.", 401, "invalid_router_token"));
          return;
        }
        const requestId = makeRequestId();
        const clientAbort = clientAbortContext(req, res);
        console.log(
          `[${new Date().toISOString()}] ${requestId} <- ${url.pathname} ` +
          `model=${body.model || "(default)"} route=${route.id} provider=${providerLogLabel(route)} ` +
          `client_auth=${clientAuth.kind} upstream_auth=${authModeForRoute(route)}`,
        );
        try {
          const requestContext = {
              requestId,
              clientAuth,
              clientHeaders: req.headers,
              clientSignal: clientAbort.signal,
              activeConfig,
          };
          const upstream = isNativeCodexImageRoute(route)
            ? await proxyNativeCodexImageRequest(body, route, history, requestContext, {
                action: isImageEdit ? "edit" : "generate",
              })
            : await callJsonUpstream(
                joinUpstreamUrl(
                  responsesBaseUrlForRoute(route),
                  isImageEdit ? "/images/edits" : "/images/generations",
                ),
                { ...route, api: "images" },
                body,
                requestContext,
              );
          jsonResponse(res, 200, upstream);
        } catch (error) {
          console.error(requestErrorLine(requestId, route, error));
          if (!res.destroyed && !res.writableEnded) {
            sendUpstreamError(res, error, { model: body.model || null });
          }
        } finally {
          clientAbort.cleanup();
        }
        return;
      }

      if (
        req.method === "POST" &&
        isChatCompletionsPostPath(url.pathname)
      ) {
        const body = await readJsonRequest(req, requestBodyLimitBytes(activeConfig, url.pathname));
        const requestedModel = body.model || "";
        const requestId = makeRequestId();
        const isCodexClient = isCodexClientRequest(req);
        let route;
        let routeSelection;
        let routePlan;
        try {
          const health = routeHealth.snapshot(activeConfig);
          const routeExclusions = automaticRouteExclusions(
            activeConfig,
            health,
            usageBudgetGuard,
          );
          if (smartRoutingOptions(activeConfig).autoSelectModel) {
            logAutomaticRouteExclusions(requestId, "auto-select", routeExclusions);
          }
          routePlan = createRoutePlan(activeConfig, body, {
            isCodexClient,
            routeExclusions,
            routeOptions: {
              exactModelIdOnly: isCodexClient,
            },
          });
          route = routePlan.route;
          routeSelection = routePlan.routeSelection;
          if (routePlan.rewriteModel) {
            body.model = routePlan.rewriteModel;
          }
          if (routePlan.changed) {
            console.warn(
              `[${new Date().toISOString()}] ${requestId} !! route-plan ` +
                `kind=${routePlan.requestKind} reason=${routePlan.reason} ` +
                `requested_model=${routePlan.requestedModel || "(default)"} ` +
                `route=${route?.id || "(none)"}`,
            );
          }
          if (route.api !== "chat_completions") {
            const error = new Error(
              `${route.displayName || route.id || route.model || "当前模型"} 使用的是 ${route.api || "未知"} 接口，` +
                "不能直接处理 Chat Completions 请求。请改选 Chat Completions 模型，或让客户端调用 /v1/responses。",
            );
            error.statusCode = 400;
            error.code = "route_api_mismatch";
            throw error;
          }
        } catch (error) {
          sendUpstreamError(res, error);
          return;
        }
        const clientAuth = authorizeClient(req, activeConfig, route);
        if (!clientAuth.ok) {
          jsonResponse(
            res,
            401,
            openAiError(
              "CodexBridge Router token mismatch. 请在 CodexBridge 关闭并重新开启 Router，配置会自动刷新，然后重试。",
              401,
              "invalid_router_token",
            ),
          );
          return;
        }
        const budgetCheck = usageBudgetGuard.check(activeConfig, route);
        if (!budgetCheck.ok) {
          console.warn(
            `[${new Date().toISOString()}] ${requestId} !! usage-budget-guard ` +
              `route=${route.id} scope=${budgetCheck.scope} id=${budgetCheck.id} ` +
              `metric=${budgetCheck.metric} used=${budgetCheck.used} limit=${budgetCheck.limit} ` +
              `remaining=${budgetCheck.remaining} unit=${budgetCheck.unit || "-"}`,
          );
          sendUpstreamError(res, usageBudgetChatError(route, budgetCheck));
          return;
        }
        const clientAbort = clientAbortContext(req, res);
        const pendingRequest = beginServerPendingRequest({
          guard: pendingRequestGuard,
          config: activeConfig,
          route,
          headers: req.headers,
          requestBody: body,
          requestId,
          responseKind: "chat_completions",
          res,
        });
        if (pendingRequest.served) {
          clientAbort.cleanup();
          return;
        }
        const onUpstreamUsage = (usageRoute, usage) => {
          usageBudgetGuard.recordUsage(activeConfig, usageRoute, usage);
        };
        console.log(
          `[${new Date().toISOString()}] ${requestId} <- /v1/chat/completions ` +
            `model=${body.model || "(default)"} route=${route.id} ` +
            `api=${route.api} upstream_model=${route.model} stream=${Boolean(body.stream)} ` +
            `provider=${providerLogLabel(route)} ` +
            smartRouteLogPart(routeSelection) +
            `client_auth=${clientAuth.kind} upstream_auth=${authModeForRoute(route)}`,
        );
        try {
          await proxyDirectChatCompletions(body, route, res, {
            requestId,
            requestedModel,
            clientAuth,
            clientHeaders: req.headers,
            clientSignal: clientAbort.signal,
            activeConfig,
            routePlan,
            routeSelection,
            onUpstreamUsage,
          });
          routeHealth.recordSuccess(route);
        } catch (error) {
          if (error?.code === "client_closed_request") {
            console.warn(
              `[${new Date().toISOString()}] ${requestId} !! client closed request before upstream completed`,
            );
            return;
          }
          routeHealth.recordError(route, error);
          console.error(requestErrorLine(requestId, route, error));
          let responseError = error;
          let responseRoute = route;
          const failoverExclusions = automaticRouteExclusions(
            activeConfig,
            routeHealth.snapshot(activeConfig),
            usageBudgetGuard,
          );
          logAutomaticRouteExclusions(requestId, "failover", failoverExclusions);
          const failoverSelection = selectFailoverRoute(activeConfig, route, error, {
            excludedRouteIds: failoverExclusions.ids,
          });
          if (
            canTrySmartFailover(res, failoverSelection) &&
            failoverSelection.route.api === "chat_completions"
          ) {
            console.warn(
              `[${new Date().toISOString()}] ${requestId} !! smart-failover ` +
                `route=${route.id} fallback_route=${failoverSelection.route.id} ` +
                `reason=${failoverSelection.reason}`,
            );
            try {
              await proxyDirectChatCompletions(body, failoverSelection.route, res, {
                requestId,
                requestedModel,
                clientAuth,
                clientHeaders: req.headers,
                clientSignal: clientAbort.signal,
                activeConfig,
                routePlan,
                routeSelection: failoverSelection,
                onUpstreamUsage,
                failoverFromRoute: route.id,
                failoverFromModel: route.model || "",
                failoverFromDisplayName: route.displayName || route.id || route.model || "",
                smartFailoverReason: failoverSelection.reason,
              });
              routeHealth.recordSuccess(failoverSelection.route, {
                failoverFromRoute: route.id,
              });
              return;
            } catch (failoverError) {
              if (failoverError?.code === "client_closed_request") {
                console.warn(
                  `[${new Date().toISOString()}] ${requestId} !! client closed request before failover completed`,
                );
                return;
              }
              routeHealth.recordError(failoverSelection.route, failoverError, {
                failoverFromRoute: route.id,
              });
              console.error(requestErrorLine(requestId, failoverSelection.route, failoverError, {
                failoverFromRoute: route.id,
              }));
              responseError = failoverError;
              responseRoute = failoverSelection.route;
            }
          }
          if (!res.destroyed && !res.writableEnded) {
            sendUpstreamError(res, responseError, {
              model: body.model || responseRoute.id || responseRoute.model || null,
            });
          }
        } finally {
          clientAbort.cleanup();
          releaseServerPendingRequest(pendingRequestGuard, pendingRequest.lease);
        }
        return;
      }

      jsonResponse(res, 404, openAiError(`No route for ${req.method} ${url.pathname}`, 404));
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] router error: ${error.stack || error.message}`,
      );
      if (!res.destroyed && !res.writableEnded) {
        sendUpstreamError(res, error);
      }
    }
  });
  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (isResponsesCollection(url.pathname)) {
      writeUpgradeRejected(socket, url.pathname);
      return;
    }
    socket.destroy();
  });
  server.on("connection", (socket) => {
    attachClientSocketErrorHandler(socket, socketsWithErrorHandler);
  });
  server.on("clientError", (error, socket) => {
    handleClientSocketError(error, socket);
  });
  if (ownsHistory) {
    server.once("close", () => history.close());
  }
  return server;
}

function localChatHistoryProblem(body, route, history) {
  if (!body?.previous_response_id) {
    return null;
  }
  if (route?.api === "responses" && route?.supportsResponsePreviousId !== false) {
    return null;
  }
  const historyHealth = history?.health?.();
  if (historyHealth?.persistent !== true) {
    return null;
  }
  const lookup = history?.lookup?.(body.previous_response_id);
  if (!lookup || lookup.state === "available") {
    return null;
  }
  if (lookup.state === "storage_unavailable") {
    return {
      statusCode: 503,
      code: "local_history_storage_unavailable",
      message: "本地模型历史存储暂时不可用，请稍后重试。",
    };
  }
  return {
    statusCode: 409,
    code: "local_history_unavailable",
    message: "本地模型历史不可恢复，请新建会话后重试。",
  };
}

function isLocalHistoryError(error) {
  return Boolean(
    error?.localHistoryError ||
      [
        "local_history_unavailable",
        "local_history_storage_unavailable",
      ].includes(error?.code),
  );
}

function smartRouteLogPart(selection) {
  if (!selection?.changed) {
    return "smart_route=- ";
  }
  return `smart_route=${selection.reason || "selected"} ` +
    `original_route=${selection.originalRoute?.id || "-"} `;
}

function unhealthyRouteIdsFromHealthSnapshot(snapshot = {}) {
  const routes = Array.isArray(snapshot.routes) ? snapshot.routes : [];
  return routes
    .filter((route) => route?.status === "degraded" || route?.status === "rate_limited")
    .map((route) => String(route.id || "").trim())
    .filter(Boolean);
}

function automaticRouteExclusionIds(config = {}, healthSnapshot = {}, usageBudgetGuard) {
  return automaticRouteExclusions(config, healthSnapshot, usageBudgetGuard).ids;
}

function automaticRouteExclusions(config = {}, healthSnapshot = {}, usageBudgetGuard) {
  const reasons = new Map();
  for (const id of unhealthyRouteIdsFromHealthSnapshot(healthSnapshot)) {
    addAutomaticRouteExclusionReason(reasons, id, "health");
  }
  if (!usageBudgetGuard || typeof usageBudgetGuard.check !== "function") {
    return automaticRouteExclusionResult(reasons);
  }
  for (const route of Array.isArray(config.models) ? config.models : []) {
    const id = String(route?.id || route?.model || "").trim();
    if (!id) {
      continue;
    }
    const budgetCheck = usageBudgetGuard.check(config, route);
    if (!budgetCheck.ok) {
      addAutomaticRouteExclusionReason(reasons, id, "budget");
    }
  }
  return automaticRouteExclusionResult(reasons);
}

function addAutomaticRouteExclusionReason(reasons, id, reason) {
  if (!id || !reason) {
    return;
  }
  const existing = reasons.get(id) || new Set();
  existing.add(reason);
  reasons.set(id, existing);
}

function automaticRouteExclusionResult(reasons) {
  const ids = [...reasons.keys()];
  const details = ids.map((id) => `${id}:${[...reasons.get(id)].join("+")}`);
  return { ids, details };
}

function logAutomaticRouteExclusions(requestId, phase, exclusions = {}) {
  if (!Array.isArray(exclusions.details) || !exclusions.details.length) {
    return;
  }
  console.warn(
    `[${new Date().toISOString()}] ${requestId} !! smart-route-exclusions ` +
      `phase=${phase || "-"} excluded=${exclusions.details.join(",")}`,
  );
}

function canTrySmartFailover(res, selection) {
  return Boolean(
    selection?.changed &&
      selection.route &&
      !res.destroyed &&
      !res.writableEnded &&
      !res.headersSent
  );
}

function beginServerPendingRequest({
  guard,
  config = {},
  route = {},
  compactKind = "",
  headers = {},
  requestBody = {},
  requestId = "",
  responseKind = "responses",
  res,
} = {}) {
  const result = guard.begin(
    {
      configRevision: config.configRevision || "",
      requestSurface: responseKind,
      route,
      compactKind,
      headers,
      requestBody,
    },
    { enabled: config.duplicateRequestProtection === true },
  );
  if (result.status === "duplicate") {
    console.warn(
      `[${new Date().toISOString()}] ${requestId || "req"} ` +
        `!! duplicate-request-guard route=${route.id || "-"} reason=pending_exact`,
    );
    if (responseKind === "chat_completions") {
      sendPendingDuplicateChatResponse(res, requestBody, route);
    } else {
      sendLocalCompletedResponse(
        res,
        requestBody,
        pendingDuplicateResponsesResponse(requestBody, route),
      );
    }
    return { served: true, lease: null };
  }
  if (result.status === "capacity_bypass") {
    console.warn(
      `[${new Date().toISOString()}] ${requestId || "req"} ` +
        `!! duplicate-request-guard route=${route.id || "-"} reason=pending_guard_capacity`,
    );
    return { served: false, lease: null };
  }
  if (result.status !== "owner") {
    return { served: false, lease: null };
  }

  return {
    served: false,
    lease: {
      fingerprint: result.fingerprint,
      ownershipToken: result.ownershipToken,
    },
  };
}

function releaseServerPendingRequest(guard, lease) {
  return guard.release(lease);
}

function pendingDuplicateResponsesResponse(requestBody = {}, route = {}) {
  const id = `resp_pending_request_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const text = pendingDuplicateMessage();
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestBody.model || route.id || route.model || null,
    output: [
      {
        id: `msg_${id}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    output_text: text,
    parallel_tool_calls: true,
    error: null,
    incomplete_details: null,
    usage: null,
  };
}

function sendPendingDuplicateChatResponse(res, requestBody = {}, route = {}) {
  const id = `chatcmpl_pending_request_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const model = requestBody.model || route.id || route.model || null;
  const text = pendingDuplicateMessage();
  if (requestBody.stream) {
    const created = Math.floor(Date.now() / 1000);
    const first = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: null,
        },
      ],
    };
    const last = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.end(`data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`);
    return;
  }
  jsonResponse(res, 200, {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: null,
  });
}

function pendingDuplicateMessage() {
  return "检测到完全相同的请求仍在执行，本次没有重复请求上游。请等待上一请求完成后再继续。";
}

function sendLocalCompletedResponse(res, requestBody = {}, response) {
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

function modelNotConfiguredLocalResponse(requestedModel, error) {
  const id = `resp_model_not_configured_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const requested = requestedModel || "(default)";
  const detail = error?.message ? `\n\n技术细节：${error.message}` : "";
  const outputText =
    `检测到旧模型槽位请求：${requested}。\n` +
    "这通常来自旧对话或旧 Codex 模型槽位重放。本次没有请求任何上游 provider，也没有消耗上游模型 token。\n" +
    "请在当前对话的模型下拉里重新选择 CodexBridge 的 cb-* 模型，或点击 CodexBridge「初始化 Codex 配置」后新开会话再继续。" +
    detail;
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestedModel || null,
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

function routePlanProblemLocalResponse(requestedModel, error) {
  const id = `resp_route_plan_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const requested = requestedModel || "(default)";
  const outputText =
    `${routePlanProblemMessage(error)}\n` +
    `本次没有请求上游模型，也没有消耗供应商 token。请求模型：${requested}`;
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestedModel || null,
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

function usageBudgetLocalResponse(requestedModel, budgetCheck = {}) {
  const id = `resp_usage_budget_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const metricLabel = usageBudgetMetricLabel(budgetCheck.metric);
  const remaining = Number.isFinite(Number(budgetCheck.remaining))
    ? Number(budgetCheck.remaining)
    : Math.max(0, Number(budgetCheck.limit || 0) - Number(budgetCheck.used || 0));
  const remainingUnit = budgetCheck.unit || usageBudgetMetricUnit(budgetCheck.metric);
  const scopeLabel = usageBudgetScopeLabel(budgetCheck);
  const outputText =
    `已达到本地每日预算上限：${scopeLabel} 今日${metricLabel}已用 ` +
    `${usageBudgetValueText(budgetCheck.used)} / ${usageBudgetValueText(
      budgetCheck.limit,
    )}，剩余 ${usageBudgetValueText(remaining)} ${remainingUnit}，已达到每日上限。\n` +
    "这次没有请求任何上游模型，也没有消耗上游 token。\n" +
    "你可以提高预算、切换模型或供应商，或者等到明天本地计数自动重置后再继续。";
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestedModel || null,
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

function usageBudgetChatError(route = {}, budgetCheck = {}) {
  const metricLabel = usageBudgetMetricLabel(budgetCheck.metric);
  const scopeLabel = usageBudgetScopeLabel(budgetCheck);
  const error = new Error(
    `已达到本地每日预算上限：${scopeLabel} 今日${metricLabel}已用 ` +
      `${usageBudgetValueText(budgetCheck.used)} / ${usageBudgetValueText(budgetCheck.limit)}。` +
      "这次没有请求任何上游模型，也没有消耗上游 token。",
  );
  error.statusCode = 429;
  error.code = "usage_budget_exceeded";
  error.route = {
    id: route.id || "",
    displayName: route.displayName || "",
    model: route.model || "",
    api: route.api || "",
  };
  return error;
}

function usageBudgetMetricLabel(metric = "") {
  if (metric === "tokens") {
    return "Token";
  }
  if (metric === "cost") {
    return "费用";
  }
  return "请求次数";
}

function usageBudgetMetricUnit(metric = "") {
  if (metric === "tokens") {
    return "Token";
  }
  if (metric === "cost") {
    return "费用单位";
  }
  return "次请求";
}

function usageBudgetValueText(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return String(value ?? "0");
  }
  return String(Math.round(numericValue * 1_000_000_000) / 1_000_000_000);
}

function usageBudgetScopeLabel(budgetCheck = {}) {
  if (budgetCheck.scope === "global") {
    return "全部模型";
  }
  if (budgetCheck.scope === "provider") {
    return `供应商 ${budgetCheck.id || budgetCheck.provider || "(unknown)"}`;
  }
  return `模型 ${budgetCheck.id || budgetCheck.routeId || "(unknown)"}`;
}

function explicitCapabilityRequestFromBody(body = {}) {
  const source = plainObject(body.codexbridge_capability) || plainObject(body.codexbridgeCapability);
  if (!source) {
    return null;
  }
  const capability = nonEmptyString(source.capability || source.type || source.name);
  if (!capability) {
    return null;
  }
  return {
    capability,
    input: Object.prototype.hasOwnProperty.call(source, "input")
      ? source.input
      : capabilityFallbackInput(body, source),
    providerId: nonEmptyString(
      source.providerId ||
        source.provider_id ||
        source.capabilityProviderId ||
        source.capability_provider_id ||
        source.preferredProviderId,
    ),
  };
}

function capabilityFallbackInput(body = {}, source = {}) {
  for (const key of ["prompt", "query", "text", "url", "file", "files", "image"]) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      return source[key];
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, "input")) {
    return body.input;
  }
  return {};
}

async function executeServerCapabilityRequest(config = {}, request = {}, options = {}) {
  const capability = nonEmptyString(request.capability);
  const providers = Array.isArray(config.capabilityProviders) ? config.capabilityProviders : [];
  const providerId = nonEmptyString(request.providerId);
  if (!providerId) {
    const registry = createCapabilityProviderRegistry(providers);
    const candidates = registry.list(capability);
    if (candidates.length > 1) {
      let lastResult = null;
      for (const provider of candidates) {
        const result = await executeServerCapabilityRequestWithProvider(config, request, options, provider);
        if (capabilityProxySucceeded(result)) {
          return capabilityProxyWithFallbackInfo(result, lastResult);
        }
        lastResult = result;
        if (!capabilityProxyCanTryBackup(result)) {
          return result;
        }
      }
      if (lastResult) {
        return lastResult;
      }
    }
  }
  return executeServerCapabilityRequestWithProvider(config, request, options);
}

async function executeServerCapabilityRequestWithProvider(config = {}, request = {}, options = {}, fixedProvider = null) {
  const capability = nonEmptyString(request.capability);
  const providers = Array.isArray(config.capabilityProviders) ? config.capabilityProviders : [];
  return runCapabilityProxy({
    capability,
    providers,
    request,
    context: {
      sourceModel: options.sourceModel || "",
    },
    selectProvider: ({ capability: targetCapability, providers: availableProviders, request: currentRequest }) => {
      if (fixedProvider) {
        return fixedProvider;
      }
      const registry = createCapabilityProviderRegistry(availableProviders);
      const provider = registry.select(targetCapability, currentRequest);
      if (!provider) {
        throw capabilityServerError(
          "provider_not_configured",
          `没有为 ${capabilityNameForMessage(targetCapability)} 配置已启用的能力供应商。`,
        );
      }
      return provider;
    },
    execute: ({ capability: targetCapability, provider, request: currentRequest }) =>
      executeGenericServerCapabilityProvider(provider, currentRequest, targetCapability, config),
    saveResult: ({ capability: targetCapability, provider, upstream }) =>
      saveCapabilityAssetResult({
        capability: targetCapability,
        provider,
        upstream,
        config,
      }),
    buildResponse: ({ capability: targetCapability, provider, upstream, savedResult, durationMs }) => ({
      ok: true,
      capability: targetCapability,
      providerId: provider.id,
      providerName: provider.displayName || provider.name || provider.id,
      endpoint: serverCapabilityProviderEndpoint(provider),
      durationMs,
      output_text: capabilityResultText(upstream, savedResult),
      data: upstream,
      ...(savedResult?.localPath ? { localPath: savedResult.localPath } : {}),
      ...(savedResult?.mimeType ? { mimeType: savedResult.mimeType } : {}),
      ...(savedResult?.sourceUrl ? { sourceUrl: savedResult.sourceUrl } : {}),
    }),
    buildErrorResponse: ({ capability: targetCapability, provider, normalizedError, phase, durationMs }) => ({
      ok: false,
      capability: targetCapability,
      providerId: provider?.id || "",
      providerName: provider?.displayName || provider?.name || provider?.id || "",
      endpoint: provider ? serverCapabilityProviderEndpoint(provider) : "",
      durationMs,
      errorPhase: phase,
      output_text: capabilityFailureText(normalizedError, provider, targetCapability),
      error: normalizedError,
    }),
  });
}

function capabilityProxySucceeded(result = {}) {
  return Boolean(result?.handled && !result.failed && result.response?.ok !== false);
}

function capabilityProxyCanTryBackup(result = {}) {
  if (!result?.failed) {
    return false;
  }
  const error = result.error || result.response?.error || {};
  const code = nonEmptyString(error.code);
  if (!code) {
    return false;
  }
  return [
    "provider_http_error",
    "asset_download_failed",
    "invalid_response_format",
    "fetch_unavailable",
  ].includes(code);
}

function capabilityProxyWithFallbackInfo(result = {}, previousResult = null) {
  if (!previousResult?.providerId) {
    return result;
  }
  const providerName = previousResult.providerName || previousResult.providerId || "";
  const backupName = result.providerName || result.providerId || "";
  const response = result.response && typeof result.response === "object" ? result.response : {};
  return {
    ...result,
    fallbackFromProviderId: previousResult.providerId,
    fallbackFromProviderName: providerName,
    response: {
      ...response,
      fallbackFromProviderId: previousResult.providerId,
      fallbackFromProviderName: providerName,
      fallbackToProviderId: result.providerId || response.providerId || "",
      fallbackToProviderName: backupName,
      output_text: [
        `已切换到备用能力供应商：${providerName} -> ${backupName}。`,
        response.output_text || "",
      ].filter(Boolean).join("\n\n"),
    },
  };
}

async function executeGenericServerCapabilityProvider(provider = {}, request = {}, capability = "", config = {}) {
  const adapter = nonEmptyString(provider.adapter || "generic_http");
  if (adapter === "local_browser") {
    return executeServerLocalBrowserProvider(provider, request, capability, config);
  }
  if (adapter === "local_computer_use") {
    return executeServerLocalComputerUseProvider(provider, request, capability, config);
  }
  if (adapter === "local_file") {
    return executeServerLocalFileProvider(provider, request, capability, config);
  }
  if (adapter !== "generic_http") {
    throw capabilityServerError(
      "unsupported_adapter",
      `Router 暂不支持自动执行这个能力供应商模式：${adapter}。`,
    );
  }
  validateRemoteServerCapabilityInput(provider, request, capability);
  const endpoint = serverCapabilityProviderEndpoint(provider);
  if (!endpoint) {
    throw capabilityServerError("invalid_endpoint", "能力供应商的 Base URL 或 Endpoint 无效，请检查配置。");
  }
  if (typeof fetch !== "function") {
    throw capabilityServerError("fetch_unavailable", "当前运行环境不能发送能力供应商请求，请升级运行环境或改用桌面端内置执行。");
  }

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const apiKey = capabilityProviderApiKey(provider);
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(serverCapabilityPayload(provider, request, capability)),
  });
  const body = await readCapabilityResponseBody(response, {
    maxBytes: capabilityProviderResponseMaxBytes(provider),
  });
  if (!response.ok) {
    throw capabilityServerError(
      "provider_http_error",
      `Capability provider returned HTTP ${response.status}.`,
      {
        statusCode: response.status,
        bodyText: body.text,
        retryAfter: providerRetryAfterHeader(response),
      },
    );
  }
  if (!body.json || typeof body.json !== "object" || Array.isArray(body.json)) {
    throw capabilityServerError(
      "invalid_response_format",
      body.parseError || "Capability provider did not return a JSON object.",
      { bodyText: body.text },
    );
  }
  return body.json;
}

async function executeServerLocalFileProvider(provider = {}, request = {}, capability = "") {
  const input = serverLocalFileInput(request);
  const action = normalizeServerFileAction(input.action || input.type, capability);
  if (isServerFileDiagnoseAction(action)) {
    return {
      text: "Router 本地文件处理已接入：inspect_file、extract_text。只读取请求里明确提供的本地文本文件路径。",
      action: "diagnose",
      providerId: provider.id || "",
      handledBy: "router_local_file",
      supportedActions: ["diagnose", "inspect_file", "extract_text"],
      canReadLocalTextFiles: true,
    };
  }
  if (!isServerFileInspectAction(action) && !isServerFileExtractTextAction(action)) {
    throw capabilityServerError(
      "unsupported_local_action",
      "Router 本地文件处理目前只支持 inspect_file 和 extract_text，并且请求输入里需要提供明确的本地文本文件路径。",
    );
  }

  const filePath = serverLocalFilePath(input);
  if (!filePath) {
    throw capabilityServerError("local_file_missing_path", "本地文件处理需要提供 path、filePath 或 localPath。");
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw capabilityServerError("local_file_not_found", `本地文件不存在或不可访问：${filePath}`);
  }
  if (!stat.isFile()) {
    throw capabilityServerError("local_file_not_file", `本地文件处理只能读取明确的文件路径：${filePath}`);
  }

  const maxBytes = serverPositiveInteger(input.maxBytes || input.max_bytes, 1024 * 1024);
  if (stat.size > maxBytes) {
    throw capabilityServerError("local_file_too_large", `本地文件过大：${stat.size} bytes，当前上限 ${maxBytes} bytes。`);
  }

  const buffer = fs.readFileSync(filePath);
  if (serverLooksBinary(buffer)) {
    throw capabilityServerError("local_file_binary_unsupported", "本地文件处理目前只支持文本文件，暂不读取明显的二进制文件。");
  }

  const content = buffer.toString("utf8").replace(/\u0000/g, "");
  const excerptLimit = serverPositiveInteger(input.maxCharacters || input.max_chars || input.limit, 6000);
  const excerpt = content.slice(0, excerptLimit);
  const truncated = content.length > excerpt.length;
  const fileName = path.basename(filePath);
  if (isServerFileInspectAction(action)) {
    const mimeType = serverLocalTextMimeType(filePath);
    const preview = excerpt;
    const extension = path.extname(filePath).toLowerCase();
    return {
      text: [
        `文件检查：${fileName}`,
        filePath,
        `类型：${mimeType}`,
        `大小：${stat.size} bytes`,
        `行数：${serverCountTextLines(content)}`,
        "",
        preview,
        truncated ? "\n（预览较长，已截取前半部分。）" : "",
      ].join("\n").trim(),
      action: "inspect_file",
      filePath,
      fileName,
      extension,
      mimeType,
      encoding: "utf8",
      sizeBytes: stat.size,
      lineCount: serverCountTextLines(content),
      preview,
      truncated,
      providerId: provider.id || "",
      handledBy: "router_local_file",
    };
  }
  return {
    text: `已读取本地文件：${fileName}\n${filePath}\n\n${excerpt}${truncated ? "\n\n（内容较长，已截取前半部分。）" : ""}`,
    action: "extract_text",
    filePath,
    fileName,
    mimeType: serverLocalTextMimeType(filePath),
    sizeBytes: stat.size,
    excerpt,
    truncated,
    providerId: provider.id || "",
    handledBy: "router_local_file",
  };
}

async function executeServerLocalComputerUseProvider(provider = {}, request = {}, capability = "", config = {}) {
  const input = serverLocalComputerUseInput(request);
  const action = normalizeServerComputerUseAction(input.action || input.type, capability);
  const canScreenshot = typeof config.captureDesktopScreenshot === "function" || serverCanUseLocalExecutorBridge(config);
  if (isServerComputerUseDiagnoseAction(action)) {
    return {
      text: canScreenshot
        ? "Router 本地 Computer Use 已接入受控模式：支持 list_apps、open_app 和 screenshot_desktop。不会执行鼠标、键盘、任意命令或脚本。"
        : "Router 本地 Computer Use 已接入受控白名单模式：目前支持 list_apps 查看白名单和 open_app 打开允许的本地应用；桌面截图需要桌面端执行器桥接。",
      action: "diagnose",
      providerId: provider.id || "",
      handledBy: "router_local_computer_use",
      supportedActions: canScreenshot
        ? ["diagnose", "list_apps", "open_app", "screenshot_desktop"]
        : ["diagnose", "list_apps", "open_app"],
      canControlDesktop: false,
      canScreenshot,
      allowedApps: serverComputerUseAllowedApps(config.platform || process.platform).map((app) => app.id),
    };
  }
  if (isServerComputerUseListAppsAction(action)) {
    const allowedApps = publicServerComputerUseAllowedApps(config.platform || process.platform);
    return {
      text: allowedApps.length
        ? `本地 Computer Use 只允许打开这些应用：${allowedApps.map((app) => app.id).join("、")}。不会执行鼠标、键盘、路径、脚本或任意命令。`
        : "当前平台没有可打开的本地 Computer Use 白名单应用。",
      action: "list_apps",
      providerId: provider.id || "",
      handledBy: "router_local_computer_use",
      supportedActions: canScreenshot
        ? ["diagnose", "list_apps", "open_app", "screenshot_desktop"]
        : ["diagnose", "list_apps", "open_app"],
      canControlDesktop: false,
      canScreenshot,
      allowedApps,
    };
  }
  if (isServerComputerUseScreenshotAction(action)) {
    return executeServerLocalComputerUseScreenshot(input, provider, config);
  }
  if (!isServerComputerUseOpenAppAction(action)) {
    throw capabilityServerError(
      "unsupported_local_action",
      "本地 Computer Use 目前只支持受控的 list_apps 白名单查看、open_app 白名单应用启动和 screenshot_desktop 桌面截图；不会执行任意命令、路径、脚本、鼠标或键盘控制。",
    );
  }
  const app = serverComputerUseAllowedApp(input, config.platform || process.platform);
  if (!app) {
    throw capabilityServerError(
      "unsupported_local_action",
      "本地 Computer Use 当前只允许打开白名单应用：notepad、calculator、paint。",
    );
  }
  await serverLaunchLocalApp(app, config);
  return {
    text: `已打开白名单应用：${app.label}。这是受控启动，不是完整 Computer Use；不会点击、输入或截图。`,
    action: "open_app",
    appId: app.id,
    appLabel: app.label,
    command: app.command,
    args: app.args,
    providerId: provider.id || "",
    handledBy: "router_local_computer_use",
    canControlDesktop: false,
    canScreenshot: false,
  };
}

async function executeServerLocalComputerUseScreenshot(input = {}, provider = {}, config = {}) {
  const captureDesktopScreenshot = typeof config.captureDesktopScreenshot === "function"
    ? config.captureDesktopScreenshot
    : null;
  if (!captureDesktopScreenshot) {
    const bridgeResult = await executeServerLocalCapabilityBridge({
      adapter: "local_computer_use",
      capability: "computer_use",
      provider,
      request: { capability: "computer_use", input },
      config,
    });
    if (bridgeResult) {
      return bridgeResult;
    }
    throw capabilityServerError(
      "local_executor_not_configured",
      "本地桌面截图需要桌面端执行器桥接；当前 Router 只能直接执行 open_app。请在桌面端能力页测试，或启用桌面执行器通道后再试。",
    );
  }

  const displayId = nonEmptyString(input.displayId || input.display_id);
  let screenshot;
  try {
    screenshot = await captureDesktopScreenshot({ displayId });
  } catch (error) {
    throw capabilityServerError(
      "local_desktop_screenshot_failed",
      `桌面截图失败：${error?.message || error || "桌面执行器返回错误。"}`,
    );
  }

  const buffer = serverLocalPngBuffer(screenshot);
  if (!buffer?.length) {
    throw capabilityServerError(
      "local_desktop_screenshot_failed",
      "桌面截图失败：桌面执行器没有返回图片内容。",
    );
  }

  return {
    text: "桌面截图已生成。这是受控截图，不会自动点击、输入或操作窗口。",
    action: "screenshot_desktop",
    displayId,
    mimeType: "image/png",
    screenshotBase64: buffer.toString("base64"),
    providerId: provider.id || "",
    handledBy: "router_local_computer_use",
    canControlDesktop: false,
    canScreenshot: true,
  };
}

async function executeServerLocalBrowserProvider(provider = {}, request = {}, capability = "", config = {}) {
  const input = serverLocalBrowserInput(request);
  const action = normalizeServerBrowserAction(input.action || input.type, capability);
  const canScreenshot = typeof config.capturePageScreenshot === "function" || serverCanUseLocalExecutorBridge(config);
  if (isServerBrowserDiagnoseAction(action)) {
    return {
      text: canScreenshot
        ? "Router 本地浏览器能力已接入：read_url、open_url、screenshot_url。"
        : "Router 本地浏览器读取能力已接入：read_url、open_url；网页截图需要桌面端执行器桥接。",
      action: "diagnose",
      providerId: provider.id || "",
      handledBy: "router_local_browser",
      supportedActions: canScreenshot ? ["read_url", "open_url", "screenshot_url"] : ["read_url", "open_url"],
      canOpenUrl: serverCanOpenUrl(config),
      canReadUrl: typeof fetch === "function",
      canScreenshot,
    };
  }
  if (isServerBrowserScreenshotAction(action)) {
    return executeServerLocalBrowserScreenshot(input, provider, config);
  }
  if (!isServerBrowserReadAction(action) && !isServerBrowserOpenAction(action)) {
    throw capabilityServerError(
      "unsupported_local_action",
      "Router 本地浏览器能力目前只支持 read_url、open_url、screenshot_url；本地文件动作必须由桌面端文件执行器处理。",
    );
  }
  const url = serverLocalBrowserUrl(input);
  if (isServerBrowserOpenAction(action) && url) {
    try {
      await serverOpenExternalUrl(url, config);
    } catch (error) {
      throw capabilityServerError(
        "local_browser_open_failed",
        `浏览器打开失败：${error?.message || "打开失败"}`,
      );
    }
    return {
      text: `已请求系统浏览器打开：${url}`,
      action: "open_url",
      url,
      providerId: provider.id || "",
      handledBy: "router_local_browser",
    };
  }
  if (!url) {
    throw capabilityServerError(
      "invalid_local_browser_url",
      "本地浏览器读取只允许 http/https URL，不能读取本地文件或其他协议。",
    );
  }
  if (typeof fetch !== "function") {
    throw capabilityServerError("fetch_unavailable", "当前 Router 运行环境不能读取网页 URL。");
  }

  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "text/html,text/plain,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "user-agent": "CodexBridge Router Local Browser Reader",
      },
    });
  } catch (error) {
    throw capabilityServerError(
      "local_browser_fetch_failed",
      `网页读取失败：${error?.message || "网络请求失败"}`,
    );
  }

  const status = Number(response?.status || 0);
  if (!response?.ok) {
    throw capabilityServerError(
      "local_browser_fetch_failed",
      `网页读取失败：HTTP ${status || "unknown"}`,
      { statusCode: status },
    );
  }

  const contentType = serverResponseHeader(response, "content-type");
  const maxBytes = serverPositiveInteger(
    input.maxBytes || input.max_bytes || input.maxBodyBytes || input.max_body_bytes,
    2 * 1024 * 1024,
  );
  const contentLength = Number.parseInt(serverResponseHeader(response, "content-length"), 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw capabilityServerError(
      "local_browser_response_too_large",
      `网页内容过大：${contentLength} bytes，当前上限 ${maxBytes} bytes。请调小页面范围或提高 maxBytes。`,
    );
  }
  const body = typeof response.text === "function" ? await response.text() : "";
  const bodyBytes = Buffer.byteLength(String(body || ""), "utf8");
  if (bodyBytes > maxBytes) {
    throw capabilityServerError(
      "local_browser_response_too_large",
      `网页内容过大：${bodyBytes} bytes，当前上限 ${maxBytes} bytes。请调小页面范围或提高 maxBytes。`,
    );
  }
  const isHtml = /html/i.test(contentType);
  const title = isHtml ? serverExtractHtmlTitle(body) : "";
  const fullText = isHtml ? serverHtmlToReadableText(body) : serverCollapseWhitespace(body);
  const excerptLimit = serverPositiveInteger(input.maxCharacters || input.max_chars || input.limit, 6000);
  const excerpt = fullText.slice(0, excerptLimit);
  const truncated = fullText.length > excerpt.length;
  const heading = title ? `已读取网页：${title}` : `已读取网页：${url}`;
  return {
    text: `${heading}\n${url}\n\n${excerpt}${truncated ? "\n\n（内容较长，已截取前半部分。）" : ""}`,
    action: "read_url",
    url,
    title,
    status,
    contentType,
    excerpt,
    truncated,
    providerId: provider.id || "",
    handledBy: "router_local_browser",
  };
}

async function executeServerLocalBrowserScreenshot(input = {}, provider = {}, config = {}) {
  const url = serverLocalBrowserUrl(input);
  if (!url) {
    throw capabilityServerError(
      "invalid_local_browser_url",
      "本地网页截图只允许 http/https URL，不能读取本地文件或其他协议。",
    );
  }
  const capturePageScreenshot = typeof config.capturePageScreenshot === "function"
    ? config.capturePageScreenshot
    : null;
  if (!capturePageScreenshot) {
    const bridgeResult = await executeServerLocalCapabilityBridge({
      adapter: "local_browser",
      capability: "webpage_screenshot",
      provider,
      request: { capability: "webpage_screenshot", input },
      config,
    });
    if (bridgeResult) {
      return bridgeResult;
    }
    throw capabilityServerError(
      "local_executor_not_configured",
      "本地网页截图需要桌面端执行器桥接；当前 Router 只能直接执行 read_url 和 open_url。请在桌面端能力页测试，或启用桌面执行器通道后再试。",
    );
  }

  const viewport = nonEmptyString(input.viewport) || "desktop";
  const fullPage = serverBooleanFlag(input.fullPage ?? input.full_page, false);
  let screenshot;
  try {
    screenshot = await capturePageScreenshot({ url, viewport, fullPage });
  } catch (error) {
    throw capabilityServerError(
      "local_browser_screenshot_failed",
      `网页截图失败：${error?.message || error || "桌面执行器返回错误。"}`,
    );
  }

  const buffer = serverLocalPngBuffer(screenshot);
  if (!buffer?.length) {
    throw capabilityServerError(
      "local_browser_screenshot_failed",
      "网页截图失败：桌面执行器没有返回图片内容。",
    );
  }

  return {
    text: `网页截图已生成：${url}`,
    action: "screenshot_url",
    url,
    viewport,
    fullPage,
    mimeType: "image/png",
    screenshotBase64: buffer.toString("base64"),
    providerId: provider.id || "",
    handledBy: "router_local_browser",
  };
}

async function executeServerLocalCapabilityBridge({ adapter = "", capability = "", provider = {}, request = {}, config = {} } = {}) {
  const endpoint = serverLocalExecutorBridgeEndpoint(config);
  const token = serverLocalExecutorBridgeToken(config);
  if (!endpoint || !token) {
    return null;
  }
  if (typeof fetch !== "function") {
    throw capabilityServerError(
      "local_executor_bridge_unavailable",
      "当前 Router 运行环境无法连接桌面端执行器通道。",
    );
  }

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        adapter,
        capability,
        provider: serverLocalBridgeProvider(provider),
        request,
      }),
    });
  } catch (error) {
    throw capabilityServerError(
      "local_executor_bridge_failed",
      `桌面端执行器通道连接失败：${error?.message || error || "请求失败。"}`,
    );
  }

  const { text, json } = await readCapabilityResponseBody(response);
  if (!response.ok) {
    throw capabilityServerError(
      "local_executor_bridge_failed",
      `桌面端执行器通道返回 HTTP ${response.status || "unknown"}。${capabilityShortErrorDetail(text)}`,
      { statusCode: response.status || 502, bodyText: text },
    );
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw capabilityServerError(
      "local_executor_bridge_failed",
      "桌面端执行器通道返回了无效格式。",
    );
  }
  if (json.ok === false) {
    const error = json.error && typeof json.error === "object" ? json.error : {};
    throw capabilityServerError(
      error.code || "local_executor_bridge_failed",
      error.message || "桌面端执行器执行失败。",
    );
  }
  const result = plainObject(json.result) || plainObject(json.data);
  if (!result) {
    throw capabilityServerError(
      "local_executor_bridge_failed",
      "桌面端执行器没有返回能力结果。",
    );
  }
  return result;
}

function serverLocalBridgeProvider(provider = {}) {
  return {
    id: nonEmptyString(provider.id),
    name: nonEmptyString(provider.name || provider.displayName),
    capability: nonEmptyString(provider.capability),
    capabilities: Array.isArray(provider.capabilities) ? provider.capabilities : [],
    adapter: nonEmptyString(provider.adapter),
  };
}

function serverLocalExecutorBridgeEndpoint(config = {}) {
  const raw = nonEmptyString(
    config.localExecutorUrl ||
      config.local_executor_url ||
      process.env.CODEXBRIDGE_LOCAL_EXECUTOR_URL,
  );
  if (!raw) {
    return "";
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }
  if (url.protocol !== "http:") {
    return "";
  }
  const hostname = url.hostname.toLowerCase();
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname)) {
    return "";
  }
  return url.toString();
}

function serverLocalExecutorBridgeToken(config = {}) {
  return nonEmptyString(
    config.localExecutorToken ||
      config.local_executor_token ||
      process.env.CODEXBRIDGE_LOCAL_EXECUTOR_TOKEN,
  );
}

function serverCanUseLocalExecutorBridge(config = {}) {
  return Boolean(serverLocalExecutorBridgeEndpoint(config) && serverLocalExecutorBridgeToken(config));
}

function serverCapabilityPayload(provider = {}, request = {}, capability = "") {
  const payload = {
    ...plainObject(provider.defaults),
    capability,
    input: Object.prototype.hasOwnProperty.call(request, "input") ? request.input : {},
  };
  if (provider.model) {
    payload.model = provider.model;
  }
  if (request.options && typeof request.options === "object" && !Array.isArray(request.options)) {
    payload.options = request.options;
  }
  return payload;
}

function validateRemoteServerCapabilityInput(_provider = {}, request = {}, capability = "") {
  if (capability !== "file_processing") {
    return;
  }
  const input = Object.prototype.hasOwnProperty.call(request, "input") ? request.input : {};
  const objectInput = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const localPath = nonEmptyString(
    objectInput.path || objectInput.filePath || objectInput.file_path || objectInput.localPath || objectInput.local_path,
  );
  if (localPath) {
    throw capabilityServerError(
      "remote_file_local_path_rejected",
      "远程文件处理供应商不能接收本地文件路径。请改用 local_file 本地文件供应商，或提供 http/https fileUrl。",
    );
  }
}

function serverLocalComputerUseInput(request = {}) {
  const input = Object.prototype.hasOwnProperty.call(request, "input") ? request.input : {};
  if (typeof input === "string") {
    return { app: input };
  }
  return input && typeof input === "object" && !Array.isArray(input) ? input : {};
}

function serverLocalFileInput(request = {}) {
  const input = Object.prototype.hasOwnProperty.call(request, "input") ? request.input : {};
  if (typeof input === "string") {
    return { path: input };
  }
  return input && typeof input === "object" && !Array.isArray(input) ? input : {};
}

function normalizeServerFileAction(value = "", capability = "") {
  const action = nonEmptyString(value).toLowerCase();
  if (action) {
    return action;
  }
  return capability === "file_processing" ? "extract_text" : "diagnose";
}

function isServerFileDiagnoseAction(action = "") {
  return ["diagnose", "health", "health_check", "test", "status"].includes(nonEmptyString(action).toLowerCase());
}

function isServerFileInspectAction(action = "") {
  return ["inspect_file", "inspect", "preview_file", "file_info", "stat_file"].includes(
    nonEmptyString(action).toLowerCase(),
  );
}

function isServerFileExtractTextAction(action = "") {
  return ["extract_text", "read_file", "read_text", "text", "read"].includes(nonEmptyString(action).toLowerCase());
}

function serverLocalFilePath(input = {}) {
  const raw = nonEmptyString(
    input.path || input.filePath || input.file_path || input.localPath || input.local_path,
  );
  return raw ? path.resolve(raw) : "";
}

function serverLocalTextMimeType(filePath = "") {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".json") {
    return "application/json";
  }
  if (ext === ".csv") {
    return "text/csv";
  }
  if (ext === ".htm" || ext === ".html") {
    return "text/html";
  }
  if (ext === ".md" || ext === ".markdown") {
    return "text/markdown";
  }
  if (ext === ".xml") {
    return "application/xml";
  }
  return "text/plain";
}

function serverCountTextLines(text = "") {
  if (!text) {
    return 0;
  }
  return text.split(/\r\n|\n|\r/).length;
}

function serverLooksBinary(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    return false;
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }
  }
  return false;
}

function normalizeServerComputerUseAction(value = "", capability = "") {
  const action = nonEmptyString(value).toLowerCase();
  if (action) {
    return action;
  }
  return capability === "computer_use" ? "open_app" : "diagnose";
}

function isServerComputerUseDiagnoseAction(action = "") {
  return ["diagnose", "health", "health_check", "test"].includes(nonEmptyString(action).toLowerCase());
}

function isServerComputerUseListAppsAction(action = "") {
  return ["list_apps", "list_app", "allowed_apps", "apps", "capabilities"].includes(
    nonEmptyString(action).toLowerCase(),
  );
}

function isServerComputerUseOpenAppAction(action = "") {
  return ["open_app", "launch_app", "start_app", "open_application"].includes(nonEmptyString(action).toLowerCase());
}

function isServerComputerUseScreenshotAction(action = "") {
  return ["screenshot_desktop", "desktop_screenshot", "screenshot", "capture_desktop", "screen_capture"].includes(
    nonEmptyString(action).toLowerCase(),
  );
}

function serverLocalPngBuffer(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (typeof value === "string" && value.trim()) {
    return Buffer.from(value.trim(), "base64");
  }
  if (value && typeof value === "object") {
    return serverLocalPngBuffer(
      value.buffer || value.bytes || value.imageBase64 || value.screenshotBase64 || value.base64 || value.data,
    );
  }
  return null;
}

function serverComputerUseAllowedApp(input = {}, platform = process.platform) {
  const wanted = normalizeServerComputerUseAppId(
    input.app || input.application || input.appId || input.app_id || input.name || input.target,
  );
  if (!wanted) {
    return null;
  }
  return serverComputerUseAllowedApps(platform).find((app) =>
    [app.id, app.label, ...(app.aliases || [])].map(normalizeServerComputerUseAppId).includes(wanted),
  ) || null;
}

function serverComputerUseAllowedApps(platform = process.platform) {
  if (platform === "win32") {
    return [
      {
        id: "notepad",
        label: "\u8bb0\u4e8b\u672c",
        command: "notepad.exe",
        args: [],
        aliases: ["notepad", "notes", "\u8bb0\u4e8b\u672c"],
      },
      {
        id: "calculator",
        label: "\u8ba1\u7b97\u5668",
        command: "calc.exe",
        args: [],
        aliases: ["calculator", "calc", "\u8ba1\u7b97\u5668"],
      },
      {
        id: "paint",
        label: "\u753b\u56fe",
        command: "mspaint.exe",
        args: [],
        aliases: ["paint", "mspaint", "\u753b\u56fe"],
      },
    ];
  }
  if (platform === "darwin") {
    return [
      {
        id: "textedit",
        label: "TextEdit",
        command: "open",
        args: ["-a", "TextEdit"],
        aliases: ["textedit", "notes"],
      },
      {
        id: "calculator",
        label: "Calculator",
        command: "open",
        args: ["-a", "Calculator"],
        aliases: ["calculator", "calc"],
      },
    ];
  }
  return [];
}

function publicServerComputerUseAllowedApps(platform = process.platform) {
  return serverComputerUseAllowedApps(platform).map((app) => ({
    id: app.id,
    label: app.label,
    aliases: [...(app.aliases || [])],
  }));
}

function normalizeServerComputerUseAppId(value = "") {
  return nonEmptyString(value).toLowerCase().replace(/[\s_-]+/g, "");
}

async function serverLaunchLocalApp(app = {}, config = {}) {
  const args = Array.isArray(app.args) ? app.args : [];
  const metadata = { appId: app.id, label: app.label };
  if (typeof config.launchLocalApp === "function") {
    await config.launchLocalApp(app.command, args, metadata);
    return;
  }
  await spawnDetachedProcess(app.command, args);
}

function serverLocalBrowserInput(request = {}) {
  const input = Object.prototype.hasOwnProperty.call(request, "input") ? request.input : {};
  if (typeof input === "string") {
    return { url: input };
  }
  return input && typeof input === "object" && !Array.isArray(input) ? input : {};
}

function normalizeServerBrowserAction(value = "", capability = "") {
  const action = nonEmptyString(value).toLowerCase();
  if (action) {
    return action;
  }
  return capability === "webpage_screenshot" ? "screenshot_url" : "read_url";
}

function isServerBrowserDiagnoseAction(action = "") {
  return ["diagnose", "health", "health_check", "test"].includes(nonEmptyString(action).toLowerCase());
}

function isServerBrowserReadAction(action = "") {
  return ["read_url", "read", "fetch_url", "extract_text"].includes(nonEmptyString(action).toLowerCase());
}

function isServerBrowserOpenAction(action = "") {
  return ["open_url", "open", "navigate"].includes(nonEmptyString(action).toLowerCase());
}

function isServerBrowserScreenshotAction(action = "") {
  return ["screenshot_url", "screenshot", "capture_url", "capture_page"].includes(
    nonEmptyString(action).toLowerCase(),
  );
}

function serverBooleanFlag(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value !== 0;
  }
  return fallback;
}

function serverCanOpenUrl(config = {}) {
  return typeof config.openExternalUrl === "function" || Boolean(serverOpenUrlCommand("https://example.com"));
}

async function serverOpenExternalUrl(url = "", config = {}) {
  if (typeof config.openExternalUrl === "function") {
    await config.openExternalUrl(url);
    return;
  }
  const command = serverOpenUrlCommand(url, process.platform);
  if (!command) {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }
  await spawnDetachedProcess(command.command, command.args);
}

function serverOpenUrlCommand(url = "", platform = process.platform) {
  if (platform === "win32") {
    return {
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    };
  }
  if (platform === "darwin") {
    return {
      command: "open",
      args: [url],
    };
  }
  return {
    command: "xdg-open",
    args: [url],
  };
}

function spawnDetachedProcess(command = "", args = []) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    const settle = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      callback(value);
    };
    child.once("error", (error) => settle(reject, error));
    child.once("spawn", () => {
      if (typeof child.unref === "function") {
        child.unref();
      }
      settle(resolve);
    });
  });
}

function serverLocalBrowserUrl(input = {}) {
  const raw = nonEmptyString(input.url || input.href || input.link);
  return normalizeServerHttpUrl(raw);
}

function normalizeServerHttpUrl(raw = "") {
  const value = nonEmptyString(raw);
  if (!value || /[\u0000-\u001f\s]/.test(value) || value.includes("\\") || value.includes("@")) {
    return "";
  }
  const parsedDirect = parseAllowedServerHttpUrl(value);
  if (parsedDirect) {
    return parsedDirect;
  }
  if (!looksLikeBareServerHttpUrl(value)) {
    return "";
  }
  return parseAllowedServerHttpUrl(`https://${value}`);
}

function parseAllowedServerHttpUrl(value = "") {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function looksLikeBareServerHttpUrl(value = "") {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("/") || value.startsWith("//")) {
    return false;
  }
  const host = String(value).split(/[/?#]/, 1)[0];
  if (!host || host.includes("..")) {
    return false;
  }
  const hostname = host.split(":", 1)[0];
  if (hostname === "localhost" || isServerIpv4(hostname)) {
    return true;
  }
  return hostname.includes(".") && hostname
    .split(".")
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function isServerIpv4(value = "") {
  const parts = String(value).split(".");
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }
    const numeric = Number(part);
    return numeric >= 0 && numeric <= 255;
  });
}

function serverResponseHeader(response, name = "") {
  const headers = response?.headers;
  if (!headers) {
    return "";
  }
  if (typeof headers.get === "function") {
    return nonEmptyString(headers.get(name));
  }
  return nonEmptyString(headers[name] || headers[String(name).toLowerCase()]);
}

function serverExtractHtmlTitle(html = "") {
  const match = String(html || "").match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? serverCollapseWhitespace(serverDecodeHtmlEntities(match[1])) : "";
}

function serverHtmlToReadableText(html = "") {
  return serverCollapseWhitespace(
    serverDecodeHtmlEntities(
      String(html || "")
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<\/(p|div|section|article|main|header|footer|li|h[1-6]|tr|br)\s*>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    ),
  );
}

function serverDecodeHtmlEntities(value = "") {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function serverCollapseWhitespace(value = "") {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function serverPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function capabilityLocalResponse(requestBody = {}, result = {}) {
  const response = result.response || {};
  const outputText = response.output_text || capabilityResultText(response.data || result.upstream) ||
    capabilityFailureText(result.error, { id: result.providerId, name: result.providerName }, result.capability);
  const id = `resp_capability_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const output = [
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
  ];
  const displayAsset = capabilityDisplayAsset(result);
  if (displayAsset) {
    output.push({
      id: `cap_img_${id}`,
      type: "image_generation_call",
      status: "completed",
      result: displayAsset.base64,
      revised_prompt: capabilityDisplayPrompt(result),
    });
  }
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestBody.model || null,
    output,
    output_text: outputText,
    parallel_tool_calls: true,
    error: null,
    incomplete_details: null,
    usage: null,
    codexbridge_capability: {
      ok: Boolean(result.handled && !result.skipped && !result.failed),
      capability: result.capability || response.capability || "",
      providerId: result.providerId || response.providerId || "",
      providerName: result.providerName || response.providerName || "",
      durationMs: Number(result.durationMs || response.durationMs || 0),
      ...(response.fallbackFromProviderId ? {
        fallbackFromProviderId: response.fallbackFromProviderId,
        fallbackFromProviderName: response.fallbackFromProviderName || "",
        fallbackToProviderId: response.fallbackToProviderId || "",
        fallbackToProviderName: response.fallbackToProviderName || "",
      } : {}),
      ...(response.endpoint ? { endpoint: response.endpoint } : {}),
      ...(response.localPath ? { localPath: response.localPath } : {}),
      ...(response.mimeType ? { mimeType: response.mimeType } : {}),
      ...(response.sourceUrl ? { sourceUrl: response.sourceUrl } : {}),
      ...(response.data ? { data: response.data } : {}),
      ...(result.error ? { error: result.error, errorPhase: result.errorPhase || "" } : {}),
    },
  };
}

function capabilityDisplayAsset(result = {}) {
  const saved = result.savedResult || {};
  const base64 = nonEmptyString(saved.base64);
  const mimeType = nonEmptyString(saved.mimeType);
  if (!base64 || !mimeType.toLowerCase().startsWith("image/")) {
    return null;
  }
  return { base64, mimeType };
}

function capabilityDisplayPrompt(result = {}) {
  const request = plainObject(result.request) || {};
  const input = Object.prototype.hasOwnProperty.call(request, "input") ? request.input : request.prompt;
  if (typeof input === "string" && input.trim()) {
    return input.trim().slice(0, 500);
  }
  const capability = nonEmptyString(result.capability || request.capability);
  const provider = nonEmptyString(result.providerName || result.providerId);
  return [capability || "capability", provider || "provider"].join(" via ");
}

function serverCapabilityProviderEndpoint(provider = {}) {
  const baseUrl = nonEmptyString(provider.baseUrl).replace(/\/+$/, "");
  const endpoint = normalizeCapabilityEndpoint(provider.endpoint || "");
  if (!baseUrl || !endpoint || !/^https?:\/\//i.test(baseUrl)) {
    return "";
  }
  try {
    return new URL(`${baseUrl}${endpoint}`).toString();
  } catch {
    return "";
  }
}

function normalizeCapabilityEndpoint(value = "") {
  const endpoint = nonEmptyString(value);
  if (!endpoint) {
    return "";
  }
  return endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
}

function capabilityProviderApiKey(provider = {}) {
  const inlineKey = nonEmptyString(provider.apiKey);
  if (inlineKey) {
    return inlineKey;
  }
  const keyEnv = nonEmptyString(provider.apiKeyEnv || provider.keyEnv);
  return keyEnv ? nonEmptyString(process.env[keyEnv]) : "";
}

async function readCapabilityResponseBody(response, options = {}) {
  const maxBytes = serverPositiveInteger(options.maxBytes, DEFAULT_CAPABILITY_PROVIDER_RESPONSE_MAX_BYTES);
  const contentLength = Number.parseInt(serverResponseHeader(response, "content-length"), 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw capabilityServerError(
      "provider_response_too_large",
      `Capability provider response is too large: ${contentLength} bytes; limit ${maxBytes} bytes.`,
    );
  }
  const text = await response.text();
  const bodyBytes = Buffer.byteLength(String(text || ""), "utf8");
  if (bodyBytes > maxBytes) {
    throw capabilityServerError(
      "provider_response_too_large",
      `Capability provider response is too large: ${bodyBytes} bytes; limit ${maxBytes} bytes.`,
    );
  }
  if (!text.trim()) {
    return { text, json: {} };
  }
  try {
    return { text, json: JSON.parse(text) };
  } catch (error) {
    return {
      text,
      json: null,
      parseError: error?.message || "Response body is not valid JSON.",
    };
  }
}

function capabilityProviderResponseMaxBytes(provider = {}) {
  return serverPositiveInteger(
    provider.maxResponseBytes ||
      provider.max_response_bytes ||
      provider.responseMaxBytes ||
      provider.response_max_bytes,
    DEFAULT_CAPABILITY_PROVIDER_RESPONSE_MAX_BYTES,
  );
}

function capabilityResultText(value, savedResult = null) {
  const baseText = capabilityResultTextValue(value);
  if (savedResult?.localPath) {
    return `${baseText || "能力结果已保存。"}\n\n本地文件：${savedResult.localPath}`;
  }
  return baseText;
}

function capabilityResultTextValue(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value == null ? "" : String(value);
  }
  for (const key of ["output_text", "text", "result", "answer", "content", "summary"]) {
    const item = value[key];
    if (typeof item === "string" && item.trim()) {
      return item.trim();
    }
  }
  return JSON.stringify(value, null, 2);
}

function capabilityProviderHttpFailureText(error = {}, providerName = "", capabilityName = "") {
  const statusCode = Number(error?.statusCode || 0);
  const detail = nonEmptyString(error?.detail || error?.message);
  const haystack = detail.toLowerCase();

  if (
    statusCode === 401 ||
    statusCode === 403 ||
    /api[_ -]?key|invalid[_ -]?key|unauthorized|forbidden|permission|auth/.test(haystack)
  ) {
    return `${providerName} 的 API Key 不正确或没有权限使用 ${capabilityName} 能力。请检查 Key、权限和该能力是否已开通。`;
  }
  if (statusCode === 402 || /balance|quota|credit|insufficient|余额|额度|欠费/.test(haystack)) {
    return `${providerName} 的余额或额度不足，暂时不能执行 ${capabilityName} 能力。请检查账户余额、套餐额度或计费状态。`;
  }
  if (statusCode === 429 || /rate limit|too many requests|throttle|限流|频率/.test(haystack)) {
    const retryHint = capabilityRetryAfterHint(error?.retryAfter || detail);
    const retryText = retryHint ? `供应商建议等待 ${retryHint} 后再试。` : "请稍后再试。";
    return `${providerName} 当前请求过快，被供应商限流了。${retryText}也可以换一个可用的 ${capabilityName} 供应商。`;
  }
  if (statusCode === 404 || /model.*not.*found|unknown model|invalid model|模型.*不存在|模型名/.test(haystack)) {
    return `${providerName} 的模型名或接口地址不正确。请检查模型名、Base URL 和 Endpoint。`;
  }
  if (statusCode === 413 || /size|resolution|dimension|too large|payload|尺寸|分辨率|过大/.test(haystack)) {
    return `${providerName} 不支持当前请求的尺寸或内容大小。请换一个尺寸，或调小输入内容后重试。`;
  }
  if (/moderation|safety|policy|blocked|content_filter|审核|安全|违规/.test(haystack)) {
    return `${providerName} 的内容审核拦截了这次 ${capabilityName} 请求。请换一个更安全、明确的提示词后再试。`;
  }

  const shortDetail = capabilityShortErrorDetail(detail);
  return `${providerName} 执行 ${capabilityName} 能力失败。${shortDetail}`.trim();
}

function capabilityRetryAfterHint(value = "") {
  const text = nonEmptyString(value);
  const match = text.match(/retry[_\s-]*after["'\s:=]*(\d+\s*(?:ms|s|sec|secs|second|seconds|秒|分钟|min|mins|minute|minutes)?)/i) ||
    text.match(/(\d+\s*(?:ms|s|sec|secs|second|seconds|秒|分钟|min|mins|minute|minutes))\s*(?:后|later|retry)/i);
  if (match) {
    return capabilityRetryAfterText(match[1]);
  }
  return /^\d+$/.test(text) ? capabilityRetryAfterText(text) : "";
}

function capabilityRetryAfterText(value = "") {
  const text = nonEmptyString(value).replace(/\s+/g, "");
  return /^\d+$/.test(text) ? `${text}s` : text;
}

function providerRetryAfterHeader(response = {}) {
  const headers = response?.headers;
  if (!headers || typeof headers.get !== "function") {
    return "";
  }
  return nonEmptyString(headers.get("retry-after") || headers.get("Retry-After"));
}

function capabilityShortErrorDetail(value = "") {
  const text = nonEmptyString(value);
  if (!text) {
    return "请稍后重试，或检查该能力供应商配置。";
  }
  const withoutMarkup = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return withoutMarkup.length > 160 ? `${withoutMarkup.slice(0, 160)}...` : withoutMarkup;
}

function capabilityFailureText(error = {}, provider = {}, capability = "") {
  const providerName = provider?.displayName || provider?.name || provider?.id || "能力供应商";
  const capabilityName = capabilityNameForMessage(capability);
  if (error?.code === "provider_not_configured") {
    return `没有找到可用的 ${capabilityName} 能力供应商。请先在“能力”页添加并启用一个供应商，或把已有供应商设为默认。`;
  }
  if (error?.code === "invalid_endpoint") {
    return `${providerName} 的 Base URL 或 Endpoint 无效，请检查能力供应商地址。`;
  }
  if (error?.code === "provider_http_error") {
    return capabilityProviderHttpFailureText(error, providerName, capabilityName);
  }
  if (error?.code === "provider_response_too_large") {
    return `${providerName} 返回的${capabilityName}响应过大，已停止读取，避免卡住或把异常页面写进结果。请调小返回内容、改用文件链接，或提高该能力供应商的 maxResponseBytes 上限。`;
  }
  if (error?.code === "asset_download_failed") {
    const status = Number(error?.statusCode || 0);
    const statusText = status ? `（HTTP ${status}）` : "";
    const assetName = capabilityAssetNameForMessage(capability);
    return `${providerName} 已返回 ${capabilityName} 结果，但结果文件下载失败${statusText}。请检查${assetName}链接是否过期、是否需要权限，或稍后重试。`;
  }
  if (error?.code === "asset_too_large") {
    return `${providerName} 已返回 ${capabilityName} 结果，但结果文件过大，已停止下载，避免占用过多内存或磁盘。请调小图片、音频或视频尺寸，改用更小的结果，或提高该能力供应商的 maxAssetBytes 上限。`;
  }
  if (error?.code === "invalid_asset_data") {
    return `${providerName} 已返回 ${capabilityName} 结果，但结果文件格式无效，当前无法保存展示。请检查供应商返回格式。`;
  }
  if (error?.code === "invalid_response_format") {
    return `${providerName} 已响应，但返回格式不是 CodexBridge 可解析的 JSON 对象。`;
  }
  if (error?.code === "unsupported_adapter") {
    return `${providerName} 的能力模式当前还不能由 Router 自动执行，请换成通用 HTTP 接口或等待本地执行器接入。`;
  }
  if (error?.code === "local_executor_not_configured") {
    return `${providerName} 执行 ${capabilityName} 能力需要桌面端执行器桥接。${error?.message || ""}`.trim();
  }
  return `${providerName} 执行 ${capabilityName} 能力失败。${error?.message || ""}`.trim();
}

function capabilityNameForMessage(capability = "") {
  const value = nonEmptyString(capability);
  return {
    image_generation: "图片生成",
    ocr: "OCR",
    web_search: "搜索",
    browser: "浏览器",
    computer_use: "Computer Use",
    file_processing: "文件处理",
    webpage_screenshot: "网页截图",
    speech: "语音",
    video: "视频",
  }[value] || value || "当前";
}

function capabilityAssetNameForMessage(capability = "") {
  const value = nonEmptyString(capability);
  return {
    image_generation: "图片",
    webpage_screenshot: "图片",
    ocr: "图片",
    speech: "音频",
    video: "视频",
    file_processing: "文件",
  }[value] || "结果文件";
}

function capabilityServerError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  if (extra.statusCode) {
    error.statusCode = extra.statusCode;
  }
  if (extra.bodyText) {
    error.bodyText = extra.bodyText;
  }
  if (extra.retryAfter) {
    error.retryAfter = extra.retryAfter;
  }
  return error;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function nonEmptyString(value) {
  return String(value || "").trim();
}

function attachClientSocketErrorHandler(socket, socketsWithErrorHandler) {
  if (!socket || socketsWithErrorHandler.has(socket)) {
    return;
  }
  socketsWithErrorHandler.add(socket);
  socket.on?.("error", (error) => {
    handleClientSocketError(error, socket);
  });
}

function requestBodyLimitBytes(config = {}, pathname = "") {
  const isImageEdit = isImageEditsPostPath(pathname);
  const isResponsesRequest = isResponsesPostPath(pathname);
  const configured = isImageEdit
    ? Number(
        config.imageEditRequestBodyLimitBytes ??
          config.image_edit_request_body_limit_bytes ??
          config.responsesRequestBodyLimitBytes ??
          config.responses_request_body_limit_bytes ??
          config.requestBodyLimitBytes ??
          config.request_body_limit_bytes,
      )
    : isResponsesRequest
      ? Number(
          config.responsesRequestBodyLimitBytes ??
            config.responses_request_body_limit_bytes ??
            config.requestBodyLimitBytes ??
            config.request_body_limit_bytes,
        )
    : Number(config.requestBodyLimitBytes ?? config.request_body_limit_bytes);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  if (isImageEdit || isResponsesRequest) {
    return DEFAULT_RESPONSES_BODY_LIMIT_BYTES;
  }
  return DEFAULT_JSON_BODY_LIMIT_BYTES;
}

function responsesCompactRequestBodyLimitBytes(config = {}, pathname = "") {
  const ordinaryLimit = requestBodyLimitBytes(config, pathname);
  const configured = Number(
    config.responsesCompactRequestBodyLimitBytes ??
      config.responses_compact_request_body_limit_bytes,
  );
  const compactLimit = Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_RESPONSES_COMPACT_BODY_LIMIT_BYTES;
  return Math.max(ordinaryLimit, compactLimit);
}

export function startServer(config = loadConfig()) {
  const server = createRouterServer(config, {
    historyPath: resolveResponseHistoryPath(),
  });
  const host = config.host || "127.0.0.1";
  const port = Number(config.port || 15722);
  server.listen(port, host, () => {
    console.log(`codex-multi-router listening on http://${host}:${port}`);
    console.log(`loaded config: ${config.__path || "(inline)"}`);
    console.log(`models: ${config.models.map((model) => model.id).join(", ")}`);
  });
  return server;
}

function logAccess(req, url) {
  console.log(
    `[${new Date().toISOString()}] access ${req.method || "GET"} ${url.pathname} ` +
      `host=${safeLogValue(req.headers.host || "-")} ` +
      `ua=${safeLogValue(req.headers["user-agent"] || "-")}`,
  );
}

function authorizeClient(req, config, route) {
  const bearerToken = bearerTokenFromHeader(req.headers.authorization);
  if (!config.authToken) {
    if (config.clientAuth?.allowUnauthenticatedLoopback === true) {
      return { ok: true, kind: bearerToken ? "codex_openai" : "none", bearerToken };
    }
    if (
      bearerToken &&
      (
        authModeForRoute(route) === "codex_openai" ||
        (config.mode !== "all_api" && config.clientAuth?.allowOpenAiBearer)
      )
    ) {
      return { ok: true, kind: "codex_openai", bearerToken };
    }
    return { ok: false, kind: "missing" };
  }
  if (bearerToken && bearerToken === config.authToken) {
    return { ok: true, kind: "local", bearerToken };
  }
  if (
    bearerToken &&
    (
      authModeForRoute(route) === "codex_openai" ||
      (config.mode !== "all_api" && config.clientAuth?.allowOpenAiBearer)
    )
  ) {
    return { ok: true, kind: "codex_openai", bearerToken };
  }
  return { ok: false, kind: "invalid" };
}

function currentConfig(config) {
  const loadedConfig = config.__path ? loadConfig(config.__path) : config;
  return applyGlobalRateLimitConfig(
    normalizeContextPolicyConfig(resolveRouterAuthToken(loadedConfig)),
  );
}

function resolveRouterAuthToken(config = {}) {
  const authTokenEnv = nonEmptyString(config.authTokenEnv);
  if (!authTokenEnv) {
    return config;
  }
  return {
    ...config,
    authToken: nonEmptyString(process.env[authTokenEnv]),
  };
}

function applyGlobalRateLimitConfig(config = {}) {
  if (typeof config.rateLimit?.enabled !== "boolean" || !Array.isArray(config.models)) {
    return config;
  }
  const enabled = config.rateLimit.enabled;
  return {
    ...config,
    models: config.models.map((route) => {
      if (
        route.localRateLimitEnabled !== undefined ||
        route.rateLimit?.enabled !== undefined
      ) {
        return route;
      }
      return {
        ...route,
        localRateLimitEnabled: enabled,
      };
    }),
  };
}

function bearerTokenFromHeader(value) {
  if (!value || typeof value !== "string") {
    return "";
  }
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function clientAbortContext(req, res) {
  const controller = new AbortController();
  const abort = (reason) => {
    if (!res.writableEnded && !controller.signal.aborted) {
      const message = reason?.message || "client connection closed";
      controller.abort(new Error(message));
    }
  };
  const socketError = (error) => {
    abort(error);
  };
  req.once("aborted", abort);
  res.once("close", abort);
  req.socket?.once?.("close", abort);
  req.socket?.once?.("error", socketError);
  return {
    signal: controller.signal,
    cleanup() {
      req.off("aborted", abort);
      res.off("close", abort);
      req.socket?.off?.("close", abort);
      req.socket?.off?.("error", socketError);
    },
  };
}

function handleClientSocketError(error, socket) {
  const code = String(error?.code || "");
  const message = safeLogValue(error?.message || error || "unknown client socket error");
  console.warn(`[${new Date().toISOString()}] client socket error${code ? ` code=${code}` : ""}: ${message}`);
  if (!socket || socket.destroyed) {
    return;
  }
  if (code === "ECONNRESET" || code === "EPIPE") {
    socket.destroy();
    return;
  }
  try {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
  } catch {
    // Fall through to destroy; socket cleanup must not crash the router.
  }
  socket.destroy();
}

function requestOriginPolicy(req, config = {}) {
  const rawOrigin = String(req.headers.origin || "").trim();
  if (!rawOrigin) {
    return { ok: true, origin: "" };
  }
  const origin = normalizedWebOrigin(rawOrigin);
  if (!origin) {
    return { ok: false, origin: "" };
  }
  const allowedOrigins = Array.isArray(config.clientAuth?.allowedOrigins)
    ? config.clientAuth.allowedOrigins
        .map((value) => normalizedWebOrigin(value))
        .filter(Boolean)
    : [];
  return {
    ok: allowedOrigins.includes(origin),
    origin,
  };
}

function normalizedWebOrigin(value) {
  try {
    const origin = new URL(String(value || "").trim()).origin;
    return origin === "null" ? "" : origin;
  } catch {
    return "";
  }
}

function applyCorsResponseHeaders(res, origin) {
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "Origin");
}

function writeCors(res) {
  res.writeHead(204, {
    "access-control-allow-methods": "GET,POST,PATCH,PUT,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
  });
  res.end();
}

function isUpgradeRequest(req) {
  const connectionTokens = String(req.headers.connection || "")
    .toLowerCase()
    .split(",")
    .map((item) => item.trim());
  return (
    String(req.headers.upgrade || "").toLowerCase() === "websocket" ||
    connectionTokens.includes("upgrade")
  );
}

function writeUpgradeRejected(socket, pathname) {
  const body = JSON.stringify(
    openAiError(
      `CodexBridge Router does not support WebSocket on ${pathname}. Use HTTP streaming for Responses requests.`,
      426,
      "websocket_not_supported",
    ),
  );
  socket.write(
    [
      "HTTP/1.1 426 Upgrade Required",
      "Connection: close",
      "Content-Type: application/json; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "",
      body,
    ].join("\r\n"),
  );
  socket.end();
}

function isResponsesCollection(pathname) {
  return ["/v1/responses", "/responses"].includes(pathname);
}

function isResponsesPostPath(pathname) {
  return isResponsesCollection(pathname) || isResponsesCompactPath(pathname);
}

function isChatCompletionsPostPath(pathname) {
  return ["/v1/chat/completions", "/chat/completions"].includes(pathname);
}

function isImageGenerationsPostPath(pathname) {
  return ["/v1/images/generations", "/images/generations"].includes(pathname);
}

function isImageEditsPostPath(pathname) {
  return ["/v1/images/edits", "/images/edits"].includes(pathname);
}

function defaultEnabledRoute(config = {}) {
  const models = Array.isArray(config.models) ? config.models.filter((model) => model?.enabled !== false) : [];
  return models.find((model) => model.id === config.defaultModel) || models[0] || null;
}

function isNativeCodexImageRoute(route = {}) {
  return route.api === "responses" && authModeForRoute(route) === "codex_openai";
}

async function proxyNativeCodexImageRequest(body, route, history, context, options = {}) {
  const action = options.action === "edit" ? "edit" : "generate";
  const content = [{ type: "input_text", text: String(body?.prompt || "") }];
  if (action === "edit") {
    content.push(...nativeImageEditInputs(body));
  }
  const buffered = createBufferedResponse();
  await proxyResponsesApi(
    {
      model: route.id || route.model,
      input: [{
        role: "user",
        content,
      }],
      tools: [{ type: "image_generation", action, partial_images: 1 }],
      store: false,
      stream: false,
    },
    route,
    history,
    buffered,
    context,
  );
  const response = buffered.json();
  const data = (Array.isArray(response?.output) ? response.output : [])
    .filter((item) => item?.type === "image_generation_call" && typeof item.result === "string")
    .map((item) => ({
      b64_json: item.result,
      ...(item.revised_prompt ? { revised_prompt: item.revised_prompt } : {}),
    }));
  if (!data.length) {
    const error = new Error("Native ChatGPT image_gen returned no image output.");
    error.statusCode = 502;
    error.code = "native_image_generation_no_output";
    throw error;
  }
  return {
    created: Math.floor(Date.now() / 1000),
    data,
  };
}

function nativeImageEditInputs(body = {}) {
  if (body.mask !== undefined && body.mask !== null && body.mask !== "") {
    const error = new Error("Native ChatGPT image editing does not support mask inputs through the Responses image_generation tool.");
    error.statusCode = 400;
    error.code = "native_image_edit_mask_unsupported";
    throw error;
  }

  const candidates = Array.isArray(body.images)
    ? body.images
    : body.image === undefined
      ? []
      : Array.isArray(body.image)
        ? body.image
        : [body.image];
  const inputs = candidates.flatMap((candidate) => {
    if (typeof candidate === "string" && candidate.trim()) {
      return [{ type: "input_image", image_url: candidate.trim() }];
    }
    if (typeof candidate?.image_url === "string" && candidate.image_url.trim()) {
      return [{ type: "input_image", image_url: candidate.image_url.trim() }];
    }
    if (typeof candidate?.file_id === "string" && candidate.file_id.trim()) {
      return [{ type: "input_image", file_id: candidate.file_id.trim() }];
    }
    return [];
  });
  if (!inputs.length) {
    const error = new Error("Image edits require at least one reference image.");
    error.statusCode = 400;
    error.code = "image_edit_reference_required";
    throw error;
  }
  return inputs;
}

function createBufferedResponse() {
  const chunks = [];
  return {
    destroyed: false,
    headersSent: false,
    writableEnded: false,
    statusCode: 200,
    writeHead(statusCode) {
      this.statusCode = statusCode;
      this.headersSent = true;
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) {
        chunks.push(Buffer.from(chunk));
      }
      this.writableEnded = true;
    },
    json() {
      return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    },
  };
}

function compactKindForPath(pathname) {
  return isResponsesCompactPath(pathname) ? "v1" : "";
}

function compactKindForRequest(pathname, body) {
  return compactKindForPath(pathname) || (requestHasCompactionTrigger(body) ? "v2" : "");
}

function isModelSettingsPath(pathname) {
  if (isResponsesCollection(pathname)) {
    return true;
  }
  return /^\/(?:v1\/)?responses\/[^/]+(?:\/model_settings)?$/.test(pathname);
}

function responseIdFromItemPath(pathname) {
  const match = pathname.match(/^\/(?:v1\/)?responses\/([^/]+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

function responseIdFromModelSettingsPath(pathname) {
  const match = pathname.match(
    /^\/(?:v1\/)?responses\/([^/]+)(?:\/model_settings)?$/,
  );
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

function responseIdFromCancelPath(pathname) {
  const match = pathname.match(/^\/(?:v1\/)?responses\/([^/]+)\/cancel$/);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

function placeholderResponse(id, model, status = "completed") {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: model || null,
    output: [],
    output_text: "",
    parallel_tool_calls: true,
    error: null,
    incomplete_details: null,
    usage: null,
  };
}

function makeRequestId() {
  return `req_${Math.random().toString(36).slice(2, 10)}`;
}

function requestErrorLine(requestId, route, error, context = {}) {
  const status = error?.statusCode || 599;
  const cause = error?.cause?.code || error?.cause?.message || "";
  const classification = classifyUpstreamError(error, { route, ...context });
  return (
    `[${new Date().toISOString()}] ${requestId} !! upstream ` +
    `route=${route.id} status=${status} error=${safeLogValue(error?.message || String(error))}` +
    ` error_type=${classification.type}` +
    (cause ? ` cause=${safeLogValue(cause)}` : "") +
    upstreamErrorLogPreview(error)
  );
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

function isCodexClientRequest(req = {}) {
  const headers = req.headers || {};
  const userAgent = String(headers["user-agent"] || "").toLowerCase();
  return (
    userAgent.includes("codex") ||
    Boolean(headers["x-codex-thread-id"]) ||
    Boolean(headers["x-codex-window-id"]) ||
    Boolean(headers["x-codex-installation-id"])
  );
}

function safeLogValue(value) {
  return String(value || "")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

const thisFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (path.resolve(thisFile) === invokedFile) {
  installRouterProcessGuards();
  startServer();
}
