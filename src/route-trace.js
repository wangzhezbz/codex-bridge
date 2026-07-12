import { adapterContractForRoute } from "./adapter-profile.js";
import { redactSecretText } from "./redact.js";

const SECRET_KEY_PATTERN = /(?:api[_-]?key|authorization|token|secret|credential|password|bearer)/i;

export function createRouteTrace(options = {}) {
  const route = options.route || {};
  const contract = adapterContractForRoute(route);
  return {
    traceVersion: "route-trace-v1",
    requestId: String(options.requestId || ""),
    requestedModel: String(options.requestedModel || ""),
    route: {
      id: contract.route.id,
      displayName: contract.route.displayName,
    },
    contract,
    events: [],
  };
}

export function recordRouteTraceEvent(trace, phase, details = {}) {
  if (!trace || !Array.isArray(trace.events)) {
    return trace;
  }
  trace.events.push({
    at: new Date().toISOString(),
    phase: String(phase || "event"),
    details: redactTraceValue(details),
  });
  return trace;
}

export function routeTraceForLog(trace) {
  if (!trace || typeof trace !== "object") {
    return {};
  }
  const contract = trace.contract || {};
  return redactTraceValue({
    traceVersion: trace.traceVersion,
    requestId: trace.requestId,
    requestedModel: trace.requestedModel,
    route: trace.route,
    contract: {
      contractVersion: contract.contractVersion,
      route: contract.route,
      upstream: contract.upstream,
      adapter: contract.adapter,
      payload: {
        allowedCount: Array.isArray(contract.payload?.allowedTopLevelParams)
          ? contract.payload.allowedTopLevelParams.length
          : 0,
        droppedTopLevelParams: contract.payload?.droppedTopLevelParams || [],
      },
      runtime: contract.runtime,
    },
    events: trace.events || [],
  });
}

export function routeDecisionSummaryForLog(trace) {
  if (!trace || typeof trace !== "object") {
    return "";
  }
  const events = Array.isArray(trace.events) ? trace.events : [];
  const decision = [...events]
    .reverse()
    .find((event) => event?.phase === "route_decision");
  const details = decision?.details && typeof decision.details === "object"
    ? decision.details
    : null;
  if (!details) {
    return "";
  }

  const requestId = compactTraceText(trace.requestId || details.requestId || "req");
  const reason = compactTraceText(details.reason || "manual_route");
  const requested = compactTraceText(details.requestedModel || trace.requestedModel || "");
  const selected = compactTraceText(details.selectedRoute || trace.route?.id || "");
  const upstream = compactTraceText(details.selectedUpstreamModel || "");
  const api = compactTraceText(details.selectedApi || "");
  const changed = Boolean(details.changed);
  const skipped = routeDecisionSkippedSummary(details.skippedRoutes);
  const contextSwitch = routeContextSwitchSummary(events);
  const routePart = requested && selected && requested !== selected
    ? `${requested} -> ${selected}`
    : selected || requested || "selected-route";

  return [
    `${requestId}:`,
    reason,
    routePart,
    upstream ? `upstream=${upstream}` : "",
    api ? `api=${api}` : "",
    `changed=${changed}`,
    skipped ? `skipped=${skipped}` : "",
    contextSwitch,
  ].filter(Boolean).join(" ");
}

function routeContextSwitchSummary(events = []) {
  const event = [...events]
    .reverse()
    .find((item) => item?.phase === "context_switch_compact");
  const details = event?.details && typeof event.details === "object"
    ? event.details
    : null;
  if (!details) {
    return "";
  }
  const from = compactTraceText(details.fromDisplayName || details.fromRouteId || "");
  const to = compactTraceText(details.toDisplayName || details.toRouteId || "");
  const estimated = positiveTraceNumber(details.estimatedTokens);
  const budget = positiveTraceNumber(details.targetInputBudget);
  const fromContext = positiveTraceNumber(details.fromContextWindow);
  const toContext = positiveTraceNumber(details.toContextWindow);
  const routePart = from && to ? `${from} -> ${to}` : from || to || "route switch";
  return [
    `上下文切换压缩 ${routePart}`,
    estimated ? `estimated=${estimated}` : "",
    budget ? `budget=${budget}` : "",
    fromContext || toContext ? `context=${fromContext || "?"}->${toContext || "?"}` : "",
  ].filter(Boolean).join(" ");
}

function positiveTraceNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function routeDecisionSkippedSummary(skippedRoutes = []) {
  if (!Array.isArray(skippedRoutes) || skippedRoutes.length === 0) {
    return "";
  }
  return skippedRoutes
    .map((item) => {
      const routeId = compactTraceText(item?.routeId || item?.id || "");
      if (!routeId) {
        return "";
      }
      const reason = compactTraceText(item?.reason || "excluded");
      return `${routeId}:${reason}`;
    })
    .filter(Boolean)
    .join(",");
}

function redactTraceValue(value, key = "") {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (SECRET_KEY_PATTERN.test(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return redactSecretText(value, 4000);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactTraceValue(item));
  }
  if (typeof value === "object") {
    const result = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = redactTraceValue(childValue, childKey);
    }
    return result;
  }
  return String(value);
}

function compactTraceText(value) {
  return redactSecretText(String(value || ""), 240)
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replace(/\s+/g, " ")
    .trim();
}
