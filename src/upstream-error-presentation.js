import { jsonResponse, openAiError, tryParseJson } from "./json.js";
import { redactSecretText } from "./redact.js";
import { classifyUpstreamError } from "./route-health.js";
import { buildResponsesStreamErrorSse } from "./sse.js";

export function createUpstreamErrorPresentation({
  UpstreamHttpError,
  UpstreamNetworkError,
  UpstreamStreamError,
  UpstreamTimeoutError,
} = {}) {
  const isHttpError = (error) => isInstanceOf(error, UpstreamHttpError);

  function sendUpstreamError(res, error, options = {}) {
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

    if (isInstanceOf(error, UpstreamNetworkError)) {
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

    if (isHttpError(error)) {
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
      isInstanceOf(error, UpstreamTimeoutError) ||
        isInstanceOf(error, UpstreamStreamError) ||
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

  function streamErrorMessage(error) {
    if (error?.code === "context_switch_compaction_failed") {
      return error.message;
    }
    if (isHttpError(error)) {
      const parsed = tryParseJson(error.bodyText);
      return clientUpstreamErrorMessage(error, parsed);
    }
    return userFacingUpstreamErrorMessage(error);
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
      case "upstream_subscription_quota_exhausted":
        return userFacingErrorSentence(prefix, "ChatGPT / Codex 订阅额度已用完，请等待额度重置或增加额度。", errorInfo);
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
      case "upstream_response_too_large":
        return userFacingErrorSentence(
          prefix,
          "供应商返回内容超过本地安全上限，请缩短输出或调整该路由的响应上限后重试。",
          errorInfo,
        );
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

  function upstreamErrorInfo(error, parsedBody = null, classification = {}) {
    const statusCode = Number(error?.statusCode || classification.statusCode || 0);
    const rawMessage = isHttpError(error)
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

  return {
    sendUpstreamError,
    upstreamBodyMessage,
    upstreamErrorInfo,
  };
}

export function responsesStreamFailureMessage(route = {}, error) {
  return (
    `CodexBridge upstream stream from ${route.displayName || route.id || route.model || "route"} ` +
    `disconnected before response.completed. ${safeText(error?.message || error || "", 300)}`
  ).trim();
}

function isInstanceOf(error, ErrorType) {
  return typeof ErrorType === "function" && error instanceof ErrorType;
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

function safeText(value, limit = 240) {
  return redactSecretText(value, limit)
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
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

function looksLikeHtml(value) {
  return /<!doctype|<html|<\/html>|<head|<body|cloudflare|nginx/i.test(String(value || ""));
}
