export function routeDecisionTraceDetails(context = {}, route = {}) {
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
