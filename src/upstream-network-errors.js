import { redactSecretText } from "./redact.js";
import { headerValue } from "./upstream-header-policy.js";

export class UpstreamHttpError extends Error {
  constructor(statusCode, bodyText, upstreamUrl, route = {}, options = {}) {
    super(`Upstream returned HTTP ${statusCode}`);
    this.statusCode = statusCode;
    this.bodyText = bodyText;
    this.upstreamUrl = upstreamUrl;
    this.retryAfter = headerValue(options.headers, "retry-after");
    this.route = routeSnapshot(route);
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
    this.route = routeSnapshot(route);
  }
}

export class UpstreamStreamError extends Error {
  constructor(message, upstreamUrl, route = {}, code = "upstream_stream_error") {
    super(message);
    this.name = "UpstreamStreamError";
    this.statusCode = 502;
    this.code = code;
    this.upstreamUrl = upstreamUrl;
    this.route = routeSnapshot(route);
  }
}

function routeSnapshot(route = {}) {
  return {
    id: route.id || "",
    displayName: route.displayName || "",
    model: route.model || "",
    api: route.api || "",
  };
}

export function isNetworkFetchFailure(error) {
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

export function safeUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(value);
  }
}

export function safeText(value, limit = 240) {
  return redactSecretText(value, limit)
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}
