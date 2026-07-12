export const CONTEXT_POLICY_VERSION = 1;
export const CONTEXT_POLICY_ID = "codexbridge-context-v1";

const DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT = 95;
const DEFAULT_AUTO_COMPACT_PERCENT = 80;
const CONFIG_POLICY_FIELDS = [
  "contextWindow",
  "effectiveContextWindowPercent",
  "autoCompactPercent",
];

export function normalizeContextPolicyConfig(config = {}) {
  if (!plainObject(config) || !Array.isArray(config.models)) {
    return config;
  }
  const catalog = plainObject(config.catalog) ? config.catalog : {};
  const inheritedFields = CONFIG_POLICY_FIELDS.filter((field) =>
    Object.hasOwn(catalog, field)
  );
  if (inheritedFields.length === 0) {
    return config;
  }

  return {
    ...config,
    models: config.models.map((route) => {
      if (!plainObject(route)) {
        return route;
      }
      const missingFields = inheritedFields.filter(
        (field) =>
          !Object.hasOwn(route, field) ||
          (field !== "contextWindow" && route[field] == null),
      );
      if (missingFields.length === 0) {
        return route;
      }
      const normalized = { ...route };
      for (const field of missingFields) {
        normalized[field] = catalog[field];
      }
      return normalized;
    }),
  };
}

export function contextPolicyForRoute(route = {}, options = {}) {
  route = route && typeof route === "object" ? route : {};
  options = options && typeof options === "object" ? options : {};
  const upstreamContextWindow = contextWindowForRoute(route, options);
  const configuredContextWindow = Object.hasOwn(route, "catalogContextWindow")
    ? positiveSafeInteger(route.catalogContextWindow)
    : upstreamContextWindow;

  if (!configuredContextWindow) {
    throw contextWindowError();
  }

  const contextWindow = Math.min(
    upstreamContextWindow,
    configuredContextWindow,
  );
  const effectiveContextWindowPercent = policyPercent(
    route.effectiveContextWindowPercent,
    options.effectiveContextWindowPercent,
    DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT,
  );
  const autoCompactPercent = policyPercent(
    route.autoCompactPercent,
    options.autoCompactPercent,
    DEFAULT_AUTO_COMPACT_PERCENT,
  );
  const percentageInputBudget = boundedPercentTokens(
    contextWindow,
    effectiveContextWindowPercent,
  );
  const truncationPolicy = truncationPolicyForRoute(
    route.truncationPolicy,
    percentageInputBudget,
  );
  const inputBudget = truncationPolicy.limit;
  const compactThreshold = Math.min(
    inputBudget,
    boundedPercentTokens(contextWindow, autoCompactPercent),
  );

  return {
    version: CONTEXT_POLICY_VERSION,
    policyId: CONTEXT_POLICY_ID,
    upstreamContextWindow,
    contextWindow,
    inputBudget,
    compactThreshold,
    outputReserveTokens: contextWindow - inputBudget,
    effectiveContextWindowPercent,
    autoCompactPercent,
    truncationPolicy,
  };
}

function contextWindowForRoute(route, options) {
  if (Object.hasOwn(route, "contextWindow")) {
    const configured = positiveSafeInteger(route.contextWindow);
    if (!configured) {
      throw contextWindowError();
    }
    return configured;
  }

  const fallback = positiveSafeInteger(options.defaultContextWindow);
  if (!fallback) {
    throw contextWindowError();
  }
  return fallback;
}

function positiveSafeInteger(value) {
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    typeof value === "boolean"
  ) {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }
  const integer = Math.floor(number);
  return Number.isSafeInteger(integer) && integer > 0 ? integer : null;
}

function policyPercent(routeValue, optionValue, fallback) {
  const value = routeValue ?? optionValue ?? fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 100) {
    throw contextPolicyError("Invalid context policy percentage.");
  }
  return number;
}

function boundedPercentTokens(contextWindow, percent) {
  return Math.min(
    contextWindow,
    Math.max(1, Math.floor(contextWindow * (percent / 100))),
  );
}

function truncationPolicyForRoute(configured, percentageInputBudget) {
  if (configured === undefined || configured === null) {
    return {
      mode: "tokens",
      limit: percentageInputBudget,
    };
  }
  if (
    typeof configured !== "object" ||
    Array.isArray(configured) ||
    (configured.mode !== undefined && configured.mode !== "tokens")
  ) {
    throw contextPolicyError("Invalid token truncation policy.");
  }
  const configuredLimit = positiveSafeInteger(configured.limit);
  if (!configuredLimit) {
    throw contextPolicyError("Invalid token truncation policy.");
  }
  return {
    mode: "tokens",
    limit: Math.min(percentageInputBudget, configuredLimit),
  };
}

function contextWindowError() {
  const error = new TypeError("Route context window is unknown or invalid.");
  error.code = "context_window_unknown";
  return error;
}

function contextPolicyError(message) {
  const error = new TypeError(message);
  error.code = "context_policy_invalid";
  return error;
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
