import { cloneJson, jsonResponse, openAiError, tryParseJson } from "./json.js";
import { authModeForRoute, joinUpstreamUrl, requireApiKey } from "./config.js";
import { responsesToChatRequest } from "./responses-to-chat.js";
import {
  assistantHistoryMessageFromChat,
  chatResponseToResponse,
  responseToSse,
} from "./chat-to-responses.js";
import { fetchInitWithProxy, proxyLogLabel } from "./proxy.js";

const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

const CODEX_PASSTHROUGH_HEADERS = [
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

export async function handleResponsesRequest(
  requestBody,
  route,
  history,
  res,
  context = {},
) {
  if (route.api === "responses") {
    return proxyResponsesApi(requestBody, route, res, context);
  }
  if (route.api === "chat_completions") {
    return proxyChatCompletions(requestBody, route, history, res, context);
  }
  jsonResponse(res, 500, openAiError(`Unsupported route api: ${route.api}`));
}

export async function proxyResponsesApi(requestBody, route, res, context = {}) {
  const payload = cloneJson(requestBody);
  payload.model = route.model;

  const upstreamUrl = joinUpstreamUrl(responsesBaseUrlForRoute(route), "/responses");
  logRoute(context, route, upstreamUrl);
  const upstream = await fetchUpstream(upstreamUrl, {
    method: "POST",
    headers: upstreamHeaders(route, context, {
      acceptEventStream: Boolean(payload.stream),
    }),
    body: JSON.stringify(payload),
  }, context, route);
  logStatus(context, route, upstream.status);

  if (!upstream.ok) {
    const bodyText = await upstream.text();
    throw new UpstreamHttpError(upstream.status, bodyText, upstreamUrl, route);
  }

  res.writeHead(upstream.status, filteredHeaders(upstream.headers));
  if (!upstream.body) {
    logUsage(context, route, null);
    res.end();
    return;
  }
  const decoder = new TextDecoder();
  let responseTail = "";
  for await (const chunk of upstream.body) {
    const buffer = Buffer.from(chunk);
    responseTail += decoder.decode(buffer, { stream: true });
    if (responseTail.length > 2_000_000) {
      responseTail = responseTail.slice(-2_000_000);
    }
    res.write(buffer);
  }
  responseTail += decoder.decode();
  res.end();
  logUsage(context, route, extractResponsesUsage(responseTail));
}

export async function proxyChatCompletions(
  requestBody,
  route,
  history,
  res,
  context = {},
) {
  const converted = responsesToChatRequest(requestBody, route, history);
  const upstreamUrl = joinUpstreamUrl(route.baseUrl, "/chat/completions");
  logRoute(context, route, upstreamUrl);
  const upstream = await callJsonUpstream(upstreamUrl, route, converted.body, context);
  logUsage(context, route, upstream.usage);
  const response = chatResponseToResponse(
    upstream,
    requestBody.model || route.id,
    converted.toolContext,
    { stripReasoningTags: shouldStripReasoningTags(route) },
  );

  history.record(response.id, [
    ...converted.messagesForHistory,
    assistantHistoryMessageFromChat(upstream),
  ]);

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

export async function callJsonUpstream(upstreamUrl, route, payload, context = {}) {
  const upstream = await fetchUpstream(upstreamUrl, {
    method: "POST",
    headers: upstreamHeaders(route, context),
    body: JSON.stringify(payload),
  }, context, route);
  const text = await upstream.text();
  if (!upstream.ok) {
    throw new UpstreamHttpError(upstream.status, text, upstreamUrl, route);
  }
  const parsed = tryParseJson(text);
  if (!parsed) {
    throw new UpstreamHttpError(
      502,
      `Upstream returned non-JSON body: ${text.slice(0, 500)}`,
      upstreamUrl,
      route,
    );
  }
  return parsed;
}

export function sendUpstreamError(res, error) {
  if (error instanceof UpstreamNetworkError) {
    jsonResponse(
      res,
      error.statusCode,
      openAiError(error.message, error.statusCode, error.code),
    );
    return;
  }

  if (error instanceof UpstreamHttpError) {
    const parsed = tryParseJson(error.bodyText);
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
        "upstream_error",
      ),
    );
    return;
  }

  const statusCode = error.statusCode || 500;
  jsonResponse(res, statusCode, openAiError(error.message, statusCode, error.code || "router_error"));
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
  return (
    `CodexBridge upstream error` +
    (routeLabel ? ` from ${routeLabel}` : "") +
    `${model}${api}: HTTP ${error.statusCode}` +
    (upstreamMessage ? ` - ${upstreamMessage}` : "")
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
  for (const name of CODEX_PASSTHROUGH_HEADERS) {
    const value = headerValue(source, name);
    if (value) {
      target[name] = value;
    }
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

function logRoute(context, route, upstreamUrl) {
  const requestId = context.requestId || "req";
  const proxy = proxyLogLabel(upstreamUrl);
  console.log(
    `[${new Date().toISOString()}] ${requestId} -> upstream ` +
      `route=${route.id} api=${route.api} upstream_model=${route.model} ` +
      `url=${safeUrl(upstreamUrl)}` +
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

async function fetchUpstream(upstreamUrl, init, context = {}, route = {}) {
  const proxiedInit = fetchInitWithProxy(upstreamUrl, init);
  const usedProxy = Boolean(proxiedInit.dispatcher);
  const proxyLabel = proxyLogLabel(upstreamUrl);
  try {
    return await fetch(upstreamUrl, proxiedInit);
  } catch (error) {
    if (!usedProxy || !isNetworkFetchFailure(error)) {
      throw isNetworkFetchFailure(error)
        ? new UpstreamNetworkError(error, upstreamUrl, route, proxyLabel)
        : error;
    }
    logProxyFallback(context, route, error);
    try {
      return await fetch(upstreamUrl, init);
    } catch (directError) {
      throw isNetworkFetchFailure(directError)
        ? new UpstreamNetworkError(directError, upstreamUrl, route, proxyLabel)
        : directError;
    }
  }
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
  const direct = extractUsageObject(tryParseJson(text));
  if (direct) {
    return direct;
  }

  let latest = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    const parsed = tryParseJson(data);
    const usage = extractUsageObject(parsed);
    if (usage) {
      latest = usage;
    }
  }
  return latest;
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
