import {
  routeUsableForAutomaticRouting,
  selectRouteForRequest,
} from "./smart-routing.js";

export const ROUTE_PLAN_VERSION = "route-plan-v1";
export const ROUTE_DECISION_VERSION = "route-decision-v2";

export const CODEX_AUXILIARY_MODEL_IDS = new Set([
  "gpt-5.4-mini",
  "gpt-5.4",
  "gpt-5.3-codex",
]);

export function createRoutePlan(config = {}, requestBody = {}, options = {}) {
  const requestedModel = String(requestBody?.model || "").trim();
  try {
    const selection = selectRouteForRequest(config, requestBody, {
      routeOptions: options.routeOptions || {},
      unhealthyRouteIds: routeExclusionIds(options),
    });
    return routePlanFromSelection(selection, {
      requestKind: "normal",
      requestedModel,
      reason: selection.reason || "model_match",
      routeExclusions: options.routeExclusions,
    });
  } catch (error) {
    if (!options.isCodexClient || error?.code !== "model_not_configured") {
      throw error;
    }

    const auxiliaryPlan = codexAuxiliaryRoutePlan(config, requestBody, options, error);
    if (auxiliaryPlan) {
      return auxiliaryPlan;
    }

    const stalePlan = staleCodexModelRoutePlan(config, requestBody, options, error);
    if (stalePlan) {
      return stalePlan;
    }

    throw error;
  }
}

export function isCodexAuxiliaryTaskRequest(body = {}, compactKind = "") {
  if (compactKind) {
    return true;
  }
  const requested = String(body?.model || "").trim().toLowerCase();
  return CODEX_AUXILIARY_MODEL_IDS.has(requested);
}

export function codexAuxiliaryTaskOptions(config = {}) {
  const source = config.codexAuxiliaryTasks &&
    typeof config.codexAuxiliaryTasks === "object" &&
    !Array.isArray(config.codexAuxiliaryTasks)
    ? config.codexAuxiliaryTasks
    : {};
  return {
    configured: Boolean(config.codexAuxiliaryTasks),
    intercept: Boolean(source.intercept),
    routeId: String(source.routeId || "").trim(),
  };
}

export function routePlanProblemMessage(error) {
  if (error?.code === "auxiliary_route_not_available") {
    const configuredRoute = error.details?.configuredRouteId || "(未选择)";
    return `辅助任务模型不可用：${configuredRoute} 不在当前模型列表里。请在设置里重新选择辅助任务模型，或关闭辅助任务转发后保存。`;
  }
  return "路由计划不可用：当前配置无法为这次请求选择模型。";
}

function codexAuxiliaryRoutePlan(config = {}, body = {}, options = {}, cause) {
  if (!isCodexAuxiliaryTaskRequest(body, options.compactKind)) {
    return null;
  }

  const auxiliaryOptions = codexAuxiliaryTaskOptions(config);
  if (!auxiliaryOptions.configured || auxiliaryOptions.intercept) {
    return null;
  }

  const routes = normalizedUsableRoutes(config, options);
  const requestedModel = String(body?.model || "").trim();
  if (auxiliaryOptions.routeId) {
    const route = routeById(routes, auxiliaryOptions.routeId);
    if (!route) {
      throw routePlanError("auxiliary_route_not_available", {
        requestedModel,
        configuredRouteId: auxiliaryOptions.routeId,
        availableRouteIds: availableRouteIds(routes),
        cause,
      });
    }
    return routePlanForRoute(route, {
      requestKind: "codex_auxiliary",
      requestedModel,
      changed: true,
      reason: "codex_auxiliary_task",
      rewriteModel: route.model || route.id,
      skippedRoutes: routeSkippedRoutes(options.routeExclusions),
      diagnostics: [
        `Codex auxiliary task ${requestedModel || "(default)"} routed to ${route.id}.`,
      ],
    });
  }

  const route = routes[0] || null;
  if (!route) {
    throw routePlanError("auxiliary_route_not_available", {
      requestedModel,
      configuredRouteId: "",
      availableRouteIds: [],
      cause,
    });
  }

  return routePlanForRoute(route, {
    requestKind: "codex_auxiliary",
    requestedModel,
    changed: true,
    reason: "codex_auxiliary_task",
    rewriteModel: route.model || route.id,
    skippedRoutes: routeSkippedRoutes(options.routeExclusions),
    diagnostics: [
      `Codex auxiliary task ${requestedModel || "(default)"} routed to default ${route.id}.`,
    ],
  });
}

function staleCodexModelRoutePlan(config = {}, body = {}, options = {}, cause) {
  const requestedModel = String(body?.model || "").trim();
  if (!requestedModel.toLowerCase().startsWith("cb-")) {
    return null;
  }

  const routes = normalizedUsableRoutes(config, options);
  const route = routeById(routes, config.defaultModel) || routes[0] || null;
  if (!route) {
    throw cause;
  }

  return routePlanForRoute(route, {
    requestKind: "stale_codex_model",
    requestedModel,
    changed: true,
    reason: "stale_model_fallback",
    skippedRoutes: routeSkippedRoutes(options.routeExclusions),
    diagnostics: [
      `Stale CodexBridge model ${requestedModel} routed to ${route.id}.`,
    ],
  });
}

function routePlanFromSelection(selection = {}, overrides = {}) {
  return routePlanForRoute(selection.route, {
    originalRoute: selection.originalRoute || null,
    changed: Boolean(selection.changed),
    reason: selection.reason || overrides.reason || "model_match",
    skippedRoutes: routeSkippedRoutes(overrides.routeExclusions),
    ...overrides,
  });
}

function routePlanForRoute(route, options = {}) {
  return {
    version: ROUTE_PLAN_VERSION,
    requestKind: options.requestKind || "normal",
    requestedModel: options.requestedModel || "",
    route,
    routeSelection: {
      route,
      originalRoute: options.originalRoute || null,
      changed: Boolean(options.changed),
      reason: options.reason || "model_match",
    },
    changed: Boolean(options.changed),
    reason: options.reason || "model_match",
    rewriteModel: options.rewriteModel || "",
    diagnostics: Array.isArray(options.diagnostics) ? options.diagnostics : [],
    decision: routeDecisionForRoute(route, options),
  };
}

function routeDecisionForRoute(route = {}, options = {}) {
  const reason = options.reason || "model_match";
  const selectedRoute = routeDecisionRoute(route);
  const originalRoute = options.originalRoute
    ? routeDecisionRoute(options.originalRoute)
    : emptyRouteDecisionRoute();
  return {
    version: ROUTE_DECISION_VERSION,
    requestKind: options.requestKind || "normal",
    requestedModel: options.requestedModel || "",
    reason,
    changed: Boolean(options.changed),
    rewriteModel: options.rewriteModel || "",
    originalRoute,
    selectedRoute,
    skippedRoutes: routeSkippedRoutes(options.skippedRoutes || []),
    diagnostics: Array.isArray(options.diagnostics) ? options.diagnostics : [],
    userMessage: routeDecisionUserMessage({
      reason,
      changed: Boolean(options.changed),
      originalRoute,
      selectedRoute,
      requestKind: options.requestKind || "normal",
    }),
  };
}

function routeDecisionRoute(route = {}) {
  if (!route || typeof route !== "object") {
    return emptyRouteDecisionRoute();
  }
  return {
    id: String(route.id || "").trim(),
    displayName: String(route.displayName || route.name || "").trim(),
    provider: String(route.provider || "").trim(),
    api: String(route.api || "").trim(),
    upstreamModel: String(route.model || "").trim(),
  };
}

function emptyRouteDecisionRoute() {
  return {
    id: "",
    displayName: "",
    provider: "",
    api: "",
    upstreamModel: "",
  };
}

function routeDecisionUserMessage({
  reason = "",
  changed = false,
  originalRoute = {},
  selectedRoute = {},
  requestKind = "",
} = {}) {
  const selected = routeDecisionRouteLabel(selectedRoute);
  const original = routeDecisionRouteLabel(originalRoute);
  if (reason === "codex_auxiliary_task") {
    return `Codex auxiliary task routed to ${selected}.`;
  }
  if (reason === "stale_model_fallback") {
    return `Saved CodexBridge model is unavailable; routed to ${selected}.`;
  }
  if (changed && original) {
    return `${routeDecisionReasonLabel(reason, requestKind)}: ${original} -> ${selected}.`;
  }
  return `Using ${selected}.`;
}

function routeDecisionRouteLabel(route = {}) {
  return route.displayName || route.id || route.upstreamModel || "selected route";
}

function routeDecisionReasonLabel(reason = "", requestKind = "") {
  const labels = {
    code_task: "Code task route",
    code_task_configured: "Configured code task route",
    image_generation_task: "Image generation route",
    image_generation_task_configured: "Configured image generation route",
    long_context_task: "Long context route",
    long_context_task_configured: "Configured long context route",
    ordinary_chat: "Ordinary chat route",
    ordinary_chat_configured: "Configured ordinary chat route",
    ordinary_chat_low_cost: "Low-cost chat route",
    manual_route: "Manual route",
    model_match: "Model match",
  };
  if (requestKind === "codex_auxiliary") {
    return "Codex auxiliary task route";
  }
  return labels[reason] || reason || "Route decision";
}

function routePlanError(code, details = {}) {
  const error = new Error(routePlanProblemMessage({ code, details }));
  error.code = code;
  error.statusCode = 200;
  error.details = details;
  if (details.cause) {
    error.cause = details.cause;
  }
  return error;
}

function normalizedRoutes(config = {}) {
  return Array.isArray(config.models) ? config.models.filter(Boolean) : [];
}

function normalizedUsableRoutes(config = {}, options = {}) {
  const excludedRouteIds = routeExclusionIdSet(options);
  return normalizedRoutes(config).filter((route) =>
    route &&
      route.enabled !== false &&
      !excludedRouteIds.has(String(route.id || "").trim()) &&
      routeUsableForAutomaticRouting(route),
  );
}

function routeById(routes = [], routeId = "") {
  const wanted = String(routeId || "").trim();
  if (!wanted) {
    return null;
  }
  return routes.find((route) => route?.id === wanted) || null;
}

function availableRouteIds(routes = []) {
  return routes.map((route) => route?.id).filter(Boolean);
}

function routeExclusionIds(options = {}) {
  if (Array.isArray(options.unhealthyRouteIds)) {
    return options.unhealthyRouteIds;
  }
  return routeSkippedRoutes(options.routeExclusions).map((item) => item.routeId);
}

function routeExclusionIdSet(options = {}) {
  return new Set(
    routeExclusionIds(options)
      .map((id) => String(id || "").trim())
      .filter(Boolean),
  );
}

function routeSkippedRoutes(routeExclusions = {}) {
  const source = routeExclusions &&
    typeof routeExclusions === "object" &&
    !Array.isArray(routeExclusions)
    ? routeExclusions
    : {};
  const items = [];
  if (Array.isArray(routeExclusions)) {
    for (const item of routeExclusions) {
      addSkippedRoute(items, item);
    }
  }
  if (Array.isArray(source.items)) {
    for (const item of source.items) {
      addSkippedRoute(items, item);
    }
  }
  if (Array.isArray(source.details)) {
    for (const detail of source.details) {
      addSkippedRoute(items, skippedRouteFromDetail(detail));
    }
  }
  if (Array.isArray(source.ids)) {
    for (const id of source.ids) {
      addSkippedRoute(items, {
        routeId: id,
        reason: "excluded",
      });
    }
  }
  return dedupeSkippedRoutes(items);
}

function addSkippedRoute(items, item) {
  if (!item) {
    return;
  }
  if (typeof item === "string") {
    item = { routeId: item, reason: "excluded" };
  }
  const routeId = String(item.routeId || item.id || "").trim();
  if (!routeId) {
    return;
  }
  const skipped = {
    routeId,
    reason: String(item.reason || "excluded").trim() || "excluded",
  };
  const detail = String(item.detail || "").trim();
  if (detail) {
    skipped.detail = detail;
  }
  items.push(skipped);
}

function skippedRouteFromDetail(detail = "") {
  const text = String(detail || "").trim();
  if (!text) {
    return null;
  }
  const separator = text.indexOf(":");
  if (separator < 0) {
    return {
      routeId: text,
      reason: "excluded",
    };
  }
  return {
    routeId: text.slice(0, separator),
    reason: text.slice(separator + 1) || "excluded",
  };
}

function dedupeSkippedRoutes(items = []) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = `${item.routeId}:${item.reason}:${item.detail || ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}
