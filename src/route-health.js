import { tryParseJson } from "./json.js";
import { proxyLogLabel } from "./proxy.js";
import { routeRateLimitStatus } from "./rate-limit.js";
import { redactSecretText } from "./redact.js";

const ERROR_TYPES = {
  authentication: {
    type: "authentication_error",
    code: "upstream_authentication_error",
  },
  billing: {
    type: "billing_error",
    code: "upstream_billing_error",
  },
  subscriptionQuota: {
    type: "subscription_quota_exhausted",
    code: "upstream_subscription_quota_exhausted",
  },
  compact: {
    type: "compact_unsupported",
    code: "upstream_compact_unsupported",
  },
  media: {
    type: "media_unsupported",
    code: "upstream_media_unsupported",
  },
  network: {
    type: "network_error",
    code: "upstream_network_error",
  },
  payload: {
    type: "payload_too_large",
    code: "upstream_payload_too_large",
  },
  parameter: {
    type: "parameter_error",
    code: "upstream_parameter_error",
  },
  provider: {
    type: "provider_error",
    code: "upstream_error",
  },
  providerUnavailable: {
    type: "provider_unavailable",
    code: "upstream_provider_unavailable",
  },
  rateLimit: {
    type: "rate_limit",
    code: "upstream_rate_limit",
  },
  timeout: {
    type: "timeout",
    code: "upstream_timeout",
  },
  router: {
    type: "router_error",
    code: "router_error",
  },
  stream: {
    type: "stream_error",
    code: "upstream_stream_error",
  },
};

export function createRouteHealthStore({
  now = () => Date.now(),
  rateLimitStatus = routeRateLimitStatus,
} = {}) {
  const records = new Map();

  function recordSuccess(route = {}, info = {}) {
    const key = routeHealthKey(route);
    const record = records.get(key) || {};
    record.routeId = route.id || route.model || key;
    record.lastOkAtMs = now();
    record.lastOkAt = new Date(record.lastOkAtMs).toISOString();
    record.lastStatus = Number(info.statusCode || info.status || 200);
    records.set(key, record);
  }

  function recordError(route = {}, error, info = {}) {
    const key = routeHealthKey(route);
    const record = records.get(key) || {};
    const classification = classifyUpstreamError(error, {
      route,
      ...info,
    });
    record.routeId = route.id || route.model || key;
    record.lastErrorAtMs = now();
    record.lastErrorAt = new Date(record.lastErrorAtMs).toISOString();
    record.lastErrorType = classification.type;
    record.lastErrorCode = classification.code;
    record.lastError = classification.message;
    record.lastStatus = classification.statusCode || error?.statusCode || 599;
    records.set(key, record);
    return classification;
  }

  function snapshot(configOrRoutes = {}) {
    const routes = Array.isArray(configOrRoutes)
      ? configOrRoutes
      : Array.isArray(configOrRoutes?.models)
        ? configOrRoutes.models
        : [];
    const routeSnapshots = routes.map((route) => routeSnapshot(route, records.get(routeHealthKey(route)), rateLimitStatus));
    return {
      routes: routeSnapshots,
      unhealthyRoutes: routeSnapshots.filter(isUnhealthyRouteSnapshot).length,
    };
  }

  return {
    recordSuccess,
    recordError,
    snapshot,
  };
}

export function classifyUpstreamError(error, context = {}) {
  const statusCode = Number(error?.statusCode || error?.status || 0);
  const parsedBody = tryParseJson(error?.bodyText || "");
  const upstreamMessage = upstreamBodyMessage(error?.bodyText, parsedBody);
  const message = safeText(
    upstreamMessage ||
      error?.message ||
      error?.code ||
      String(error || "unknown upstream error"),
    800,
  );
  const haystack = [
    error?.name,
    error?.code,
    error?.message,
    error?.cause?.code,
    error?.cause?.message,
    parsedBody?.error?.type,
    parsedBody?.error?.code,
    parsedBody?.error?.message,
    parsedBody?.message,
    error?.bodyText,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const base = classifyBase({ error, statusCode, haystack, context });
  return {
    ...base,
    statusCode: statusCode || defaultStatusForCode(base.code, error),
    message,
  };
}

function classifyBase({ error, statusCode, haystack, context }) {
  if (isSubscriptionQuotaExhausted(statusCode, haystack)) {
    return ERROR_TYPES.subscriptionQuota;
  }
  if (error?.code === "provider_rate_limited" || statusCode === 429) {
    return ERROR_TYPES.rateLimit;
  }
  if (error?.code === "upstream_network_error" || error?.name === "UpstreamNetworkError") {
    return ERROR_TYPES.network;
  }
  if (
    error?.code === "upstream_response_too_large" ||
    error?.name === "UpstreamResponseTooLargeError"
  ) {
    return {
      type: "upstream_response_too_large",
      code: "upstream_response_too_large",
    };
  }
  if (isProviderUnavailableError(statusCode, haystack)) {
    return ERROR_TYPES.providerUnavailable;
  }
  if (error?.code === "upstream_timeout" || error?.name === "UpstreamTimeoutError" || /timed out|timeout/.test(haystack)) {
    return ERROR_TYPES.timeout;
  }
  if (
    error?.name === "UpstreamStreamError" ||
    error?.code === "upstream_stream_error" ||
    error?.code === "upstream_stream_truncated" ||
    /stream.*(truncated|disconnected|closed|ended before response\.completed)/.test(haystack)
  ) {
    return {
      ...ERROR_TYPES.stream,
      code: String(error?.code || ERROR_TYPES.stream.code),
    };
  }
  if (isCompactError(statusCode, haystack, context)) {
    return ERROR_TYPES.compact;
  }
  if (isPayloadTooLargeError(statusCode, haystack)) {
    return ERROR_TYPES.payload;
  }
  if (isMediaError(statusCode, haystack)) {
    return ERROR_TYPES.media;
  }
  if (isBillingError(statusCode, haystack)) {
    return ERROR_TYPES.billing;
  }
  if (statusCode === 401 || statusCode === 403 || /unauthori[sz]ed|invalid api key|api key|forbidden|permission/.test(haystack)) {
    return ERROR_TYPES.authentication;
  }
  if (/rate.?limit|too many requests/.test(haystack)) {
    return ERROR_TYPES.rateLimit;
  }
  if (statusCode === 400 || statusCode === 404 || statusCode === 409 || statusCode === 422 || /invalid_request|invalid request|bad request|missing field|unknown parameter|unsupported parameter|must be set/.test(haystack)) {
    return ERROR_TYPES.parameter;
  }
  if (statusCode >= 500) {
    return ERROR_TYPES.provider;
  }
  if (error?.code) {
    return {
      type: String(error.code || "router_error"),
      code: String(error.code || "router_error"),
    };
  }
  return ERROR_TYPES.router;
}

function isCompactError(statusCode, haystack, context = {}) {
  if (!context.compactKind) {
    return false;
  }
  return (
    [400, 404, 409, 422].includes(statusCode) ||
    /compact|compaction|stream.*true|output item/.test(haystack)
  );
}

function isPayloadTooLargeError(statusCode, haystack) {
  return (
    statusCode === 413 ||
    /payload too large|request body|entity too large|body size|client_max_body_size|max body|content length/i.test(haystack)
  );
}

function isMediaError(statusCode, haystack) {
  return (
    [400, 413, 415, 422].includes(statusCode) &&
    /image|vision|multi.?modal|input_image|image_url|audio|input_audio|file|input_file|unsupported media|media type|payload too large/.test(haystack)
  );
}

function isBillingError(statusCode, haystack) {
  return (
    statusCode === 402 ||
    /insufficient (balance|quota|credit)|balance insufficient|quota exceeded|quota exhausted|credit exhausted|balance exhausted|insufficient_balance|insufficient_quota|billing|payment required|余额不足|额度不足|欠费/.test(haystack)
  );
}

function isSubscriptionQuotaExhausted(statusCode, haystack) {
  return (
    [402, 403, 429].includes(statusCode) &&
    /the usage limit has been reached|codex and work usage (?:limit|quota)|usage (?:limit|quota) (?:has been )?(?:reached|exhausted)/.test(haystack)
  );
}

function isProviderUnavailableError(statusCode, haystack) {
  return (
    statusCode === 503 ||
    ([502, 504].includes(statusCode) && /bad gateway|gateway timeout|cloudflare|nginx|html/.test(haystack)) ||
    /no available (channel|provider)|service unavailable|temporarily unavailable|capacity|overloaded|upstream unavailable|model unavailable|distributor|bad gateway|gateway timeout/.test(haystack)
  );
}

function routeSnapshot(route = {}, record = {}, rateLimitStatus) {
  const limits = typeof rateLimitStatus === "function"
    ? rateLimitStatus(route)
    : {};
  const cooldownRemainingMs = Math.max(0, Number(limits?.cooldownRemainingMs || 0));
  const nextAfterMs = Math.max(0, Number(limits?.nextAfterMs || 0));
  const lastOkAtMs = Number(record?.lastOkAtMs || 0);
  const lastErrorAtMs = Number(record?.lastErrorAtMs || 0);
  let status = "unknown";
  if (route?.enabled === false) {
    status = "disabled";
  } else if (cooldownRemainingMs > 0) {
    status = "rate_limited";
  } else if (lastErrorAtMs > lastOkAtMs) {
    status = "degraded";
  } else if (lastOkAtMs > 0) {
    status = "healthy";
  }
  const availability = routeAvailabilityStatus({
    status,
    record,
    cooldownRemainingMs,
    nextAfterMs,
  });

  return {
    id: String(route.id || route.model || ""),
    displayName: String(route.displayName || route.id || route.model || ""),
    provider: String(route.provider || route.providerId || "custom"),
    api: String(route.api || ""),
    model: String(route.model || ""),
    proxy: proxyLogLabel(route.baseUrl || ""),
    status,
    circuitState: availability.circuitState,
    availability,
    lastStatus: Number.isFinite(Number(record?.lastStatus)) ? Number(record.lastStatus) : null,
    lastOkAt: String(record?.lastOkAt || ""),
    lastErrorAt: String(record?.lastErrorAt || ""),
    lastErrorType: String(record?.lastErrorType || ""),
    lastErrorCode: String(record?.lastErrorCode || ""),
    lastError: String(record?.lastError || ""),
    cooldownRemainingMs,
    nextAfterMs,
    rateLimit: {
      cooldownRemainingMs,
      nextAfterMs,
    },
  };
}

function routeAvailabilityStatus({
  status = "unknown",
  record = {},
  cooldownRemainingMs = 0,
  nextAfterMs = 0,
} = {}) {
  if (status === "disabled") {
    return {
      state: "disabled",
      reason: "route_disabled",
      circuitState: "disabled",
      canUseForManual: false,
      canUseForAutomatic: false,
      canUseForFailover: false,
      retryAfterMs: 0,
      nextAfterMs,
    };
  }
  if (status === "rate_limited") {
    return {
      state: "limited",
      reason: "cooldown_active",
      circuitState: "open",
      canUseForManual: false,
      canUseForAutomatic: false,
      canUseForFailover: false,
      retryAfterMs: cooldownRemainingMs,
      nextAfterMs,
    };
  }
  if (status === "degraded") {
    const lastErrorType = String(record?.lastErrorType || "");
    return {
      state: "degraded",
      reason: lastErrorType ? `last_error:${lastErrorType}` : "last_error",
      circuitState: "half_open",
      canUseForManual: true,
      canUseForAutomatic: false,
      canUseForFailover: false,
      retryAfterMs: 0,
      nextAfterMs,
    };
  }
  if (status === "healthy") {
    return {
      state: nextAfterMs > 0 ? "paced" : "available",
      reason: nextAfterMs > 0 ? "pacing_active" : "last_success",
      circuitState: "closed",
      canUseForManual: true,
      canUseForAutomatic: true,
      canUseForFailover: true,
      retryAfterMs: 0,
      nextAfterMs,
    };
  }
  return {
    state: "untested",
    reason: "no_probe_yet",
    circuitState: "closed",
    canUseForManual: true,
    canUseForAutomatic: true,
    canUseForFailover: true,
    retryAfterMs: 0,
    nextAfterMs,
  };
}

function isUnhealthyRouteSnapshot(route = {}) {
  return route?.status === "degraded" || route?.status === "rate_limited";
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

function routeHealthKey(route = {}) {
  return String(route.id || route.model || route.baseUrl || "unknown");
}

function defaultStatusForCode(code, error) {
  if (code === "upstream_network_error") {
    return 502;
  }
  if (code === "upstream_timeout") {
    return 504;
  }
  return Number(error?.statusCode || 500);
}

function safeText(value, limit = 240) {
  return redactSecretText(value, limit)
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}
