import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { authModeForRoute, requireApiKey, joinUpstreamUrl } from "./config.js";
import {
  contentToText,
  interactivePluginKindForRequest,
  responseRequestToChatSourceMessages,
} from "./responses-to-chat.js";
import { assistantHistoryMessageFromResponse, responseToSse } from "./chat-to-responses.js";
import { runCapabilityProxy } from "./capability-proxy.js";
import { jsonResponse } from "./json.js";
import { contextPolicyForRoute } from "./context-policy.js";
import { createRouteSnapshot } from "./route-snapshot.js";

const OFFICIAL_IMAGE_GENERATION = {
  enabled: true,
  mode: "official",
  id: "openai-image-generation",
  displayName: "OpenAI Image Generation",
  baseUrl: "https://api.openai.com/v1",
  endpoint: "/images/generations",
  model: "gpt-image-1",
  size: "1024x1024",
  apiKeyEnv: "OPENAI_API_KEY",
};
const INLINE_IMAGE_RESULT_MAX_BYTES = 512 * 1024;

export function shouldUseImageGenerationFallback(requestBody, route) {
  const settings = imageGenerationSettings(route);
  if (!requestBody || !settings.enabled) {
    return false;
  }
  if (interactivePluginKindForRequest(requestBody)) {
    return false;
  }
  if (settings.mode !== "custom") {
    return false;
  }
  if (requestHasInputImages(requestBody)) {
    return false;
  }
  if (requestPromptSuppressesImageGeneration(requestBody)) {
    return false;
  }
  if (
    hasNativeImageGenerationTool(requestBody.tools) &&
    toolChoiceSelectsImageGeneration(requestBody.tool_choice)
  ) {
    return true;
  }
  return route?.api === "chat_completions" && hasExplicitImageGenerationIntent(requestBody);
}

function requestPromptSuppressesImageGeneration(requestBody) {
  const text = promptTextFromRequest(requestBody).trim();
  return Boolean(
    text &&
      (
        isImageUnderstandingPrompt(text) ||
        isInteractiveComputerPrompt(text) ||
        isImageGenerationMetaPrompt(text)
      ),
  );
}

export async function proxyImageGenerationFallback(
  requestBody,
  route,
  history,
  res,
  context = {},
  callJsonUpstream,
) {
  const prompt = imagePromptFromRequest(requestBody);
  const settings = imageGenerationSettings(route);
  const { response } = await generateImageWithSettings(settings, prompt, {
    route,
    requestedModel: requestBody.model || route.id,
    sourceModel: route.id || requestBody.model || "",
    context,
    callJsonUpstream,
  });
  const { messages: sourceMessages } = responseRequestToChatSourceMessages(
    requestBody,
    route,
    history,
  );
  const messages = [
    ...sourceMessages,
    assistantHistoryMessageFromResponse(response),
  ];
  const meta = {
    api: "image_generation",
    routeId: route.id || "",
    upstreamModel: settings.model,
    upstreamKnown: false,
    parentResponseId: requestBody.previous_response_id || null,
    routeSnapshot: imageHistoryRouteSnapshot(route),
  };
  if (typeof history?.recordTurn === "function") {
    history.recordTurn({
      responseId: response.id,
      messages,
      response,
      meta,
    });
  } else {
    history?.record?.(response.id, messages);
    history?.recordResponse?.(response, meta);
  }

  if (requestBody.stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.end(responseToSse(response));
    return response;
  }

  jsonResponse(res, 200, response);
  return response;
}

function imageHistoryRouteSnapshot(route = {}) {
  try {
    return createRouteSnapshot(route, {
      contextPolicy: contextPolicyForRoute(route, {
        defaultContextWindow: 258400,
      }),
    });
  } catch {
    return {
      id: route.id || "",
      api: route.api || "",
      model: route.model || "",
    };
  }
}

export async function generateImageWithSettings(settings, prompt, options = {}) {
  validateImageGenerationSettings(settings);
  if (typeof options.callJsonUpstream !== "function") {
    throw new Error("图片生成上游调用器未配置。");
  }

  const route = options.route || {};
  const requestedModel = options.requestedModel || route.id || settings.id;
  const sourceModel = options.sourceModel || route.id || options.requestedModel || "";
  const result = await runCapabilityProxy({
    capability: "image_generation",
    provider: settings,
    request: {
      prompt,
      requestedModel,
      sourceModel,
      route,
    },
    context: options.context || {},
    execute: async ({ provider, request, context }) => {
      const imageRoute = {
        id: provider.id,
        displayName: provider.displayName,
        api: "images",
        baseUrl: provider.baseUrl,
        model: provider.model,
        authMode: "api_key",
        apiKeyEnv: provider.apiKeyEnv,
        apiKey: provider.apiKey,
        headers: imageGenerationHeaders(provider),
      };
      requireApiKey(imageRoute);

      const upstreamUrl = joinUpstreamUrl(provider.baseUrl, provider.endpoint);
      return options.callJsonUpstream(
        upstreamUrl,
        imageRoute,
        imageGenerationPayload(provider, request.prompt),
        context,
      );
    },
    saveResult: async ({ provider, upstream }) => localImageFromImageResult(upstream, provider),
    buildResponse: ({ provider, request, upstream, savedResult }) => responseFromImageResult(
      upstream,
      request.requestedModel,
      request.route,
      request.prompt,
      provider.model,
      provider.displayName,
      provider.response,
      savedResult,
    ),
    ...(options.captureErrors
      ? {
          buildErrorResponse: ({ provider, request, error, normalizedError, phase }) => responseFromImageError(
            error,
            normalizedError,
            request.requestedModel,
            request.route,
            request.prompt,
            provider.model,
            provider.displayName,
            phase,
          ),
        }
      : {}),
    recordHistory: async ({
      provider,
      request,
      savedResult,
      response,
      durationMs,
      failed,
      normalizedError,
      error,
      errorPhase,
    }) => recordImageGenerationHistoryForSettings(provider, {
      ok: !failed,
      providerId: provider.providerId || provider.id || "",
      providerName: provider.displayName || provider.id || "Image Generation",
      sourceModel: request.sourceModel,
      prompt: request.prompt,
      localPath: savedResult?.localPath || "",
      mimeType: savedResult?.mimeType || "",
      durationMs,
      errorCode: normalizedError?.code || error?.code || "",
      errorMessage: response?.codexbridge_image_generation?.message ||
        normalizedError?.message ||
        error?.message ||
        "",
      errorPhase: errorPhase || "",
    }),
  });
  if (result.failed) {
    const generationFailure = result.response?.codexbridge_image_generation || {};
    return {
      ok: false,
      upstream: result.upstream,
      localImage: result.savedResult,
      response: result.response,
      durationMs: result.durationMs,
      historyItem: result.historyItem,
      error: {
        ...result.error,
        message: generationFailure.message || result.error?.message || "",
        detail: generationFailure.detail || result.error?.detail || "",
      },
      errorPhase: result.errorPhase,
      capabilityTrace: result.trace || [],
    };
  }
  return {
    ok: true,
    upstream: result.upstream,
    localImage: result.savedResult,
    response: result.response,
    durationMs: result.durationMs,
    historyItem: result.historyItem,
    capabilityTrace: result.trace || [],
  };
}

export function friendlyImageGenerationError(error, provider = {}) {
  const statusCode = Number(error?.statusCode || error?.status || 0);
  const detail = errorDetailText(error);
  const haystack = detail.toLowerCase();
  const providerName = provider?.displayName || provider?.name || provider?.id || "图片供应商";
  let message = `${providerName} 生图失败：${detail || "未知错误"}`;

  if (statusCode === 401 || statusCode === 403 || /incorrect api key|invalid api key|unauthori[sz]ed|forbidden|permission|api key/.test(haystack)) {
    message = `${providerName} 的 API Key 不正确或没有权限。请检查 Key 是否填错、是否已保存到本机，以及当前账号是否开通了图片接口。`;
  } else if (statusCode === 402 || /insufficient|balance|quota|credit|payment|billing|余额|额度|欠费/.test(haystack)) {
    message = `${providerName} 的余额或额度不足。请到供应商控制台检查余额、套餐额度或图片接口计费状态。`;
  } else if (statusCode === 429 || /rate.?limit|too many requests|tpm|rpm|限流|频率/.test(haystack)) {
    const retryText = rateLimitRetryText(error);
    message = `${providerName} 暂时限流。${retryText || "请稍后重试，"}或降低并发、换备用图片供应商。`;
  } else if (isImageGenerationGatewayError(haystack, statusCode)) {
    message = `${providerName} 返回了 HTML 网关或网页错误。请检查 Base URL、Endpoint、代理/VPN，或稍后重试供应商服务。`;
  } else if (isImageGenerationModelError(haystack, statusCode)) {
    message = `${providerName} 的图片模型名可能不正确。请核对模型名、接口模式和账号权限。`;
  } else if (isImageGenerationSizeError(haystack)) {
    message = `${providerName} 不支持当前图片尺寸。请换成供应商支持的尺寸，例如 1024x1024 或 1280x1280。`;
  } else if (isImageGenerationPromptLengthError(haystack)) {
    message = `${providerName} 的提示词太长。请缩短描述、减少参考内容，或拆成多次生成后再试。`;
  } else if (isImageGenerationModerationError(haystack)) {
    message = `${providerName} 的内容审核拦截了这次提示词。请换一种更明确、更安全的描述后再试。`;
  } else if (/download failed|result download|保存|下载/.test(haystack)) {
    message = `${providerName} 已返回图片地址，但 CodexBridge 下载或保存图片失败。请检查网络、代理和本地 generated-images 目录权限。`;
  }

  return {
    ok: false,
    message,
    detail: detail || String(error || ""),
    statusCode: statusCode || undefined,
  };
}

export function imageGenerationHealthChecks(input = {}) {
  const settings = input.settings || input.provider || {};
  const localImage = input.localImage || input.savedResult || null;
  const ok = Boolean(input.ok);
  const errorKind = ok ? "" : imageGenerationErrorKind(input.error);
  const apiKeyReady = Boolean(settings.apiKey || settings.apiKeyEnv);
  const modelReady = Boolean(String(settings.model || "").trim());
  const sizeReady = Boolean(String(settings.size || "").trim());

  return [
    {
      id: "api_key",
      label: "API Key",
      status: ok ? statusFromReady(apiKeyReady) : errorKind === "auth" ? "fail" : apiKeyReady ? "unknown" : "fail",
      detail: ok
        ? apiKeyReady
          ? `Key 已配置：${settings.apiKey ? "本次输入 Key" : settings.apiKeyEnv}`
          : "没有配置图片供应商 Key。"
        : errorKind === "auth"
          ? "供应商拒绝了当前 Key，请检查 Key、权限或图片接口是否开通。"
          : apiKeyReady
            ? "本次失败不像 Key 错误，但仍建议确认 Key 权限。"
            : "缺少图片供应商 Key。",
    },
    {
      id: "account",
      label: "余额 / 权限",
      status: ok ? "pass" : errorKind === "quota" ? "fail" : errorKind === "auth" ? "fail" : "unknown",
      detail: ok
        ? "供应商接受了这次图片请求，当前余额、额度或图片接口权限足够完成一次生成。"
        : errorKind === "quota"
          ? "供应商返回余额、额度或计费相关错误，请到控制台检查套餐、余额和图片接口计费状态。"
          : errorKind === "auth"
            ? "供应商拒绝了当前 Key，可能是 Key 无效、权限不足，或图片接口没有开通。"
            : "本次失败没有直接证明余额或权限错误；可结合供应商控制台再确认。",
    },
    {
      id: "rate_limit",
      label: "频率限制",
      status: ok ? "pass" : errorKind === "rate_limit" ? "fail" : "unknown",
      detail: ok
        ? "本次请求没有触发供应商频率限制。"
        : errorKind === "rate_limit"
          ? `供应商返回限流或频率限制。${rateLimitRetryText(input.error)}请稍后重试，或降低并发、切换备用图片供应商。`
          : "本次失败没有直接证明是限流；如果连续失败，再查看供应商控制台的请求频率和额度。",
    },
    {
      id: "model",
      label: "模型名",
      status: ok ? statusFromReady(modelReady) : errorKind === "model" ? "fail" : modelReady ? "unknown" : "fail",
      detail: ok
        ? modelReady
          ? `模型名已被供应商接受：${settings.model}`
          : "没有填写图片模型名。"
        : errorKind === "model"
          ? `供应商没有接受这个模型名：${settings.model || "未填写"}。`
          : modelReady
            ? `本次失败没有直接证明模型名错误：${settings.model}。`
            : "没有填写图片模型名。",
    },
    {
      id: "size",
      label: "尺寸",
      status: ok ? "pass" : errorKind === "size" ? "fail" : sizeReady ? "unknown" : "unknown",
      detail: ok
        ? sizeReady
          ? `尺寸可用：${settings.size}`
          : "没有填写尺寸，供应商可能使用默认值。"
        : errorKind === "size"
          ? `供应商不支持当前尺寸：${settings.size || "未填写"}。`
          : sizeReady
            ? `本次失败没有直接证明尺寸错误：${settings.size}。`
            : "没有填写尺寸。",
    },
    {
      id: "response",
      label: "返回格式",
      status: ok ? "pass" : "fail",
      detail: ok
        ? "供应商返回了可识别的图片结果。"
        : responseFailureDetail(errorKind),
    },
    {
      id: "local_file",
      label: "本地保存",
      status: ok ? (localImage?.localPath ? "pass" : "warn") : errorKind === "download" ? "fail" : "unknown",
      detail: ok
        ? localImage?.localPath
          ? `图片已保存：${localImage.localPath}`
          : "供应商返回了图片结果，但没有拿到本地文件路径。"
        : errorKind === "download"
          ? "供应商返回了图片地址，但下载或保存到本地失败。"
          : "请求没有走到可保存图片的阶段。",
    },
  ];
}

function statusFromReady(ready) {
  return ready ? "pass" : "fail";
}

function responseFailureDetail(kind) {
  if (kind === "quota") {
    return "供应商返回余额、额度或计费相关错误。";
  }
  if (kind === "rate_limit") {
    return "供应商返回限流或频率限制。";
  }
  if (kind === "moderation") {
    return "供应商内容审核拦截了这次提示词。";
  }
  if (kind === "gateway") {
    return "供应商返回了 HTML 网关或网页错误。请检查 Base URL、Endpoint、代理/VPN，或稍后重试供应商服务。";
  }
  if (kind === "download") {
    return "供应商结果可用性不足，图片下载或保存失败。";
  }
  if (kind === "auth") {
    return "供应商拒绝鉴权，返回格式没有进入正常图片结果。";
  }
  if (kind === "model") {
    return "供应商返回模型不存在或没有权限使用。";
  }
  if (kind === "size") {
    return "供应商返回尺寸不支持。";
  }
  if (kind === "prompt_length") {
    return "供应商返回提示词过长。请缩短描述、减少参考内容，或拆成多次生成。";
  }
  return "供应商没有返回可用的图片结果，请查看错误详情。";
}

function rateLimitRetryText(error) {
  const retryHint = retryAfterHint(error?.retryAfter) || retryAfterHint(errorDetailText(error));
  return retryHint ? `建议等待 ${retryHint} 后再试。` : "";
}

function retryAfterHint(value = "") {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  if (/^\d+$/.test(text)) {
    return `${text}s`;
  }
  const retryMatch = text.match(/retry(?:\s|-)?after[:\s]+([0-9]+(?:\s*(?:ms|s|sec|second|seconds|m|min|minute|minutes))?)/i) ||
    text.match(/([0-9]+(?:\s*(?:ms|s|sec|second|seconds|m|min|minute|minutes)))\s*(?:later|后|之后)/i);
  if (!retryMatch) {
    return "";
  }
  const retryText = retryMatch[1].trim();
  return /^\d+$/.test(retryText) ? `${retryText}s` : retryText;
}

function isImageGenerationModelError(haystack = "", statusCode = 0) {
  return statusCode === 404 ||
    /model(?:_|\s|-)?not(?:_|\s|-)?found/.test(haystack) ||
    /model.*(?:not found|does not exist|unavailable|unsupported|invalid)/.test(haystack) ||
    /(?:invalid|unknown|unsupported|unavailable|no such)\s+model/.test(haystack) ||
    /模型.*(?:不存在|不可用|无效|不支持)|模型名/.test(haystack);
}

function isImageGenerationSizeError(haystack = "") {
  return /unsupported.*(?:size|image_size|resolution)/.test(haystack) ||
    /(?:size|image_size|resolution).*(?:unsupported|invalid|not supported)/.test(haystack) ||
    /invalid\s+(?:size|image_size|resolution)/.test(haystack) ||
    /尺寸|分辨率/.test(haystack);
}

function isImageGenerationPromptLengthError(haystack = "") {
  return /prompt.*(?:too long|exceed|exceeds|exceeded|maximum|max length|length limit|token limit)/.test(haystack) ||
    /(?:input|text|request|content).*(?:too long|exceed|exceeds|exceeded|maximum length|max length|length limit)/.test(haystack) ||
    /(?:too many|maximum).*(?:tokens|characters|chars)/.test(haystack) ||
    /提示词.*(?:过长|太长|超长|超过|超出|限制|上限)/.test(haystack) ||
    /(?:输入|文本|内容|描述).*(?:过长|太长|超长|超过|超出).*(?:长度|限制|上限)?/.test(haystack);
}

function isImageGenerationModerationError(haystack = "") {
  return /content policy|content filter|safety|moderation|sensitive|audit|blocked/.test(haystack) ||
    /prompt rejected|policy violation|not allowed|unsafe/.test(haystack) ||
    /risk[_\s-]?(?:control|check|review|reject|blocked|block)|nsfw|porn|sexual|violent|violence|prohibited/.test(haystack) ||
    /风控|合规|内容|审核|违规|敏感/.test(haystack);
}

function isImageGenerationGatewayError(haystack = "", statusCode = 0) {
  return /html\s*(?:错误页|error)|bad gateway|gateway|base url|endpoint|网关|网页/.test(haystack) ||
    ([500, 502, 503, 504].includes(statusCode) && /html|bad gateway|gateway|网关|网页/.test(haystack));
}

function imageGenerationErrorKind(error) {
  const statusCode = Number(error?.statusCode || error?.status || 0);
  const detail = errorDetailText(error);
  const haystack = detail.toLowerCase();
  if (statusCode === 401 || statusCode === 403 || /incorrect api key|invalid api key|unauthori[sz]ed|forbidden|permission|api key/.test(haystack)) {
    return "auth";
  }
  if (statusCode === 402 || /insufficient|balance|quota|credit|payment|billing|余额|额度|欠费/.test(haystack)) {
    return "quota";
  }
  if (statusCode === 429 || /rate.?limit|too many requests|tpm|rpm|限流|频率/.test(haystack)) {
    return "rate_limit";
  }
  if (isImageGenerationGatewayError(haystack, statusCode)) {
    return "gateway";
  }
  if (isImageGenerationModelError(haystack, statusCode)) {
    return "model";
  }
  if (isImageGenerationSizeError(haystack)) {
    return "size";
  }
  if (isImageGenerationPromptLengthError(haystack)) {
    return "prompt_length";
  }
  if (isImageGenerationModerationError(haystack)) {
    return "moderation";
  }
  if (/download failed|result download|保存|下载/.test(haystack)) {
    return "download";
  }
  return "provider";
}

function errorDetailText(error) {
  if (!error) {
    return "";
  }
  const parts = [
    error.message,
    error.bodyText,
    error.body,
    error.responseText,
    error.detail,
  ];
  for (const part of parts) {
    if (typeof part === "string" && part.trim()) {
      return cleanErrorDetailText(part.trim(), error).slice(0, 1200);
    }
  }
  try {
    return cleanErrorDetailText(JSON.stringify(error), error).slice(0, 1200);
  } catch {
    return cleanErrorDetailText(String(error), error).slice(0, 1200);
  }
}

function cleanErrorDetailText(text = "", error = {}) {
  const clean = String(text || "").trim();
  if (!clean) {
    return "";
  }
  if (!looksLikeHtmlError(clean)) {
    return clean;
  }
  const statusCode = Number(error?.statusCode || error?.status || 0);
  const title = stripHtmlTags((clean.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "")
    .replace(/\s+/g, " ")
    .trim();
  const status = statusCode ? `HTTP ${statusCode}` : "上游";
  const titleText = title ? `，页面标题：${title}` : "";
  return `${status} 返回了 HTML 错误页${titleText}。通常是 Base URL / Endpoint 不正确、供应商网关暂时不可用，或代理把请求转到了网页而不是 API。`;
}

function looksLikeHtmlError(text = "") {
  return /<!doctype|<html\b|<head\b|<body\b|<title\b/i.test(String(text || ""));
}

function stripHtmlTags(text = "") {
  return String(text || "").replace(/<[^>]*>/g, " ");
}

async function recordImageGenerationHistoryForSettings(settings = {}, item = {}) {
  const historyPath = String(settings.historyPath || "").trim();
  const ok = item.ok !== false;
  const localPath = String(item.localPath || "").trim();
  if (!historyPath || (ok && !localPath)) {
    return null;
  }
  const record = {
    id: `img_${randomUUID()}`,
    ok,
    providerId: String(item.providerId || "").trim(),
    providerName: String(item.providerName || "Image Generation").trim(),
    sourceModel: String(item.sourceModel || "").trim(),
    prompt: String(item.prompt || "").trim(),
    localPath,
    mimeType: String(item.mimeType || "image/png").trim(),
    durationMs: Number.isFinite(Number(item.durationMs)) ? Math.max(0, Math.round(Number(item.durationMs))) : 0,
    errorCode: String(item.errorCode || "").trim(),
    errorMessage: String(item.errorMessage || "").trim(),
    errorPhase: String(item.errorPhase || "").trim(),
    createdAt: new Date().toISOString(),
  };
  let existing = { version: 1, items: [] };
  try {
    const parsed = JSON.parse(await fs.readFile(historyPath, "utf8"));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.items)) {
      existing = parsed;
    }
  } catch {
    existing = { version: 1, items: [] };
  }
  const items = [
    record,
    ...existing.items.filter((entry) => entry && entry.localPath !== record.localPath),
  ].slice(0, 120);
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  await fs.writeFile(historyPath, `${JSON.stringify({ version: 1, items }, null, 2)}\n`, "utf8");
  return record;
}

function validateImageGenerationSettings(settings) {
  const missing = [];
  if (!settings.baseUrl) {
    missing.push("baseUrl");
  }
  if (!settings.model) {
    missing.push("model");
  }
  if (!settings.apiKeyEnv && !settings.apiKey) {
    missing.push("apiKeyEnv");
  }
  if (missing.length === 0) {
    return;
  }
  const error = new Error(
    `Image generation provider is incomplete. Missing ${missing.join(", ")}.`,
  );
  error.statusCode = 400;
  error.code = "invalid_image_generation_provider";
  throw error;
}

function imageGenerationPayload(settings, prompt) {
  const defaults = plainObject(settings.defaults);
  const adapter = String(settings.adapter || "openai_images").toLowerCase();
  if (adapter === "generic_template") {
    const template = plainObject(settings.request?.template) ||
      plainObject(settings.requestTemplate);
    if (Object.keys(template).length) {
      return renderImageTemplate(template, imageTemplateVars(settings, prompt));
    }
  }
  if (adapter === "siliconflow_images") {
    const payload = {
      model: settings.model,
      prompt,
      ...defaults,
    };
    if (settings.size) {
      payload.image_size = settings.size;
    }
    return payload;
  }
  if (adapter === "zai_images") {
    const payload = {
      model: settings.model,
      prompt,
      ...defaults,
    };
    if (settings.size) {
      payload.size = settings.size;
    }
    return payload;
  }
  const payload = {
    model: settings.model,
    prompt,
    n: 1,
    ...defaults,
  };
  if (settings.size) {
    payload.size = settings.size;
  }
  return payload;
}

function imageGenerationHeaders(settings = {}) {
  const headers = plainObject(settings.headers);
  if (!Object.keys(headers).length) {
    return {};
  }
  return renderImageTemplate(headers, imageTemplateVars(settings, ""));
}

function imageTemplateVars(settings = {}, prompt = "") {
  return {
    prompt,
    model: settings.model || "",
    size: settings.size || "",
    apiKey: requireApiKey({
      id: settings.id || "image-generation",
      authMode: "api_key",
      apiKeyEnv: settings.apiKeyEnv,
      apiKey: settings.apiKey,
    }),
  };
}

export function responseFromImageResult(
  result,
  requestedModel,
  route,
  prompt,
  upstreamModel = imageModel(),
  upstreamProvider = "OpenAI Image Generation",
  responsePaths = {},
  localImage = null,
) {
  const image = Array.isArray(result?.data) ? result.data[0] : null;
  const configuredB64 = readJsonPath(result, responsePaths.imageBase64Path);
  const configuredUrl = readJsonPath(result, responsePaths.imageUrlPath);
  const b64 = localImage?.localPath
    ? typeof localImage?.base64 === "string" && localImage.base64
      ? localImage.base64
      : ""
    : typeof configuredB64 === "string"
      ? configuredB64
      : typeof image?.b64_json === "string"
        ? image.b64_json
        : "";
  const url = typeof configuredUrl === "string"
    ? configuredUrl
    : typeof image?.url === "string"
      ? image.url
      : Array.isArray(result?.images) && typeof result.images[0]?.url === "string"
        ? result.images[0].url
        : Array.isArray(result?.output) && typeof result.output[0] === "string"
          ? result.output[0]
          : "";
  const revisedPrompt =
    typeof image?.revised_prompt === "string" && image.revised_prompt.trim()
      ? image.revised_prompt.trim()
      : prompt;
  const id = `resp_img_${randomUUID()}`;
  const messageText = localImage?.localPath
    ? [
        `已通过 ${upstreamProvider} 生成图片，已保存到本地并可直接查看。`,
        localImagePreviewMarkdown(localImage.localPath),
        `本地路径：${localImage.localPath}`,
      ].filter(Boolean).join("\n\n")
    : b64
      ? `已通过 ${upstreamProvider} 生成图片。`
    : url
      ? `已通过 ${upstreamProvider} 生成图片：${url}`
      : `${upstreamProvider} 返回了结果，但没有包含可展示的图片数据。`;
  const output = [
    {
      id: `msg_${stableFragment(id)}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: messageText,
          annotations: [],
        },
      ],
    },
  ];

  if (b64) {
    output.push({
      id: `ig_${stableFragment(id)}`,
      type: "image_generation_call",
      status: "completed",
      result: b64,
      revised_prompt: revisedPrompt,
    });
  }

  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestedModel,
    output,
    output_text: messageText,
    parallel_tool_calls: true,
    error: null,
    incomplete_details: null,
    usage: imageUsage(result?.usage),
    codexbridge_image_generation: {
      route: route?.id || "",
      provider: upstreamProvider,
      upstream_model: upstreamModel,
      ...(localImage?.localPath ? { local_path: localImage.localPath } : {}),
      ...(localImage?.mimeType ? { mime_type: localImage.mimeType } : {}),
    },
  };
}

function localImagePreviewMarkdown(localPath = "") {
  const normalized = String(localPath || "").trim();
  if (!normalized) {
    return "";
  }
  const markdownPath = normalized
    .replace(/\\/g, "/")
    .split("/")
    .map((segment, index) => {
      if (index === 0 && /^[A-Za-z]:$/.test(segment)) {
        return segment;
      }
      return encodeURIComponent(segment)
        .replace(/\(/g, "%28")
        .replace(/\)/g, "%29");
    })
    .join("/");
  return `![生成图片](${markdownPath})`;
}

function responseFromImageError(
  error,
  normalizedError,
  requestedModel,
  route,
  prompt,
  upstreamModel = imageModel(),
  upstreamProvider = "OpenAI Image Generation",
  phase = "execute",
) {
  const friendly = friendlyImageGenerationError(error, {
    displayName: upstreamProvider,
    model: upstreamModel,
  });
  const id = `resp_img_error_${randomUUID()}`;
  const statusCode = Number(friendly.statusCode || normalizedError?.statusCode || 0);
  const code = String(normalizedError?.code || error?.code || "").trim();
  const messageText = friendly.message;

  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestedModel,
    output: [
      {
        id: `msg_${stableFragment(id)}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: messageText,
            annotations: [],
          },
        ],
      },
    ],
    output_text: messageText,
    parallel_tool_calls: true,
    error: null,
    incomplete_details: null,
    usage: imageUsage({}),
    codexbridge_image_generation: {
      ok: false,
      route: route?.id || "",
      provider: upstreamProvider,
      upstream_model: upstreamModel,
      prompt,
      error_phase: phase,
      message: messageText,
      detail: friendly.detail || normalizedError?.detail || "",
      ...(statusCode ? { status_code: statusCode } : {}),
      ...(code ? { code } : {}),
    },
  };
}

export function imageGenerationSettings(route = {}) {
  const raw = route?.imageGeneration && typeof route.imageGeneration === "object"
    ? route.imageGeneration
    : {};
  const mode = String(raw.mode || defaultImageGenerationMode(route)).toLowerCase();
  if (raw.enabled === false || mode === "off" || mode === "disabled") {
    return {
      enabled: false,
      mode: "off",
      id: raw.id || `${route?.id || "route"}-image-generation-off`,
      displayName: raw.displayName || "Image Generation Disabled",
      baseUrl: "",
      endpoint: raw.endpoint || OFFICIAL_IMAGE_GENERATION.endpoint,
      model: "",
      size: raw.size || imageSize(),
      apiKeyEnv: raw.apiKeyEnv || "",
      apiKey: raw.apiKey,
      adapter: raw.adapter || "",
      defaults: plainObject(raw.defaults),
      response: plainObject(raw.response),
      request: normalizeImageGenerationRequest(raw.request),
      headers: normalizeImageGenerationHeaders(raw.headers),
      outputDir: raw.outputDir || "",
      historyPath: raw.historyPath || "",
    };
  }

  const officialAllowed = defaultImageGenerationMode(route) === OFFICIAL_IMAGE_GENERATION.mode;
  const official = mode !== "custom" && officialAllowed;
  if (mode !== "custom" && !officialAllowed) {
    return {
      enabled: false,
      mode: "off",
      id: raw.id || `${route?.id || "route"}-image-generation-off`,
      displayName: raw.displayName || "Image Generation Disabled",
      baseUrl: "",
      endpoint: raw.endpoint || OFFICIAL_IMAGE_GENERATION.endpoint,
      model: "",
      size: raw.size || imageSize(),
      apiKeyEnv: "",
      apiKey: raw.apiKey,
      adapter: raw.adapter || "",
      defaults: plainObject(raw.defaults),
      response: plainObject(raw.response),
      request: normalizeImageGenerationRequest(raw.request),
      headers: normalizeImageGenerationHeaders(raw.headers),
      outputDir: raw.outputDir || "",
      historyPath: raw.historyPath || "",
    };
  }

  return {
    enabled: true,
    mode: official ? "official" : "custom",
    providerId: raw.providerId || "",
    adapter: raw.adapter || (official ? "openai_images" : "openai_images"),
    id:
      raw.id ||
      (official
        ? OFFICIAL_IMAGE_GENERATION.id
        : `${route?.id || "route"}-custom-image-generation`),
    displayName:
      raw.displayName ||
      (official ? OFFICIAL_IMAGE_GENERATION.displayName : "Custom Image Generation"),
    baseUrl:
      raw.baseUrl ||
      (official ? imageBaseUrl() : ""),
    endpoint: raw.endpoint || OFFICIAL_IMAGE_GENERATION.endpoint,
    model:
      raw.model ||
      (official ? imageModel() : ""),
    size: Object.prototype.hasOwnProperty.call(raw, "size") ? String(raw.size || "").trim() : imageSize(),
    apiKeyEnv:
      raw.apiKeyEnv ||
      (official ? OFFICIAL_IMAGE_GENERATION.apiKeyEnv : "IMAGE_GENERATION_API_KEY"),
    apiKey: raw.apiKey,
    defaults: plainObject(raw.defaults),
    response: plainObject(raw.response),
    request: normalizeImageGenerationRequest(raw.request),
    headers: normalizeImageGenerationHeaders(raw.headers),
    outputDir: raw.outputDir || process.env.CODEXBRIDGE_IMAGE_OUTPUT_DIR || "",
    historyPath: raw.historyPath || process.env.CODEXBRIDGE_IMAGE_HISTORY_PATH || "",
  };
}

function normalizeImageGenerationRequest(value = {}) {
  const request = plainObject(value);
  const template = plainObject(request.template);
  return Object.keys(template).length ? { template } : {};
}

function normalizeImageGenerationHeaders(value = {}) {
  const headers = plainObject(value);
  const result = {};
  for (const [key, val] of Object.entries(headers)) {
    const name = String(key || "").trim();
    if (!name || val === undefined || val === null) {
      continue;
    }
    result[name] = String(val);
  }
  return result;
}

async function localImageFromImageResult(result, settings = {}) {
  const responsePaths = plainObject(settings.response);
  const source = imagePayloadFromResult(result, responsePaths);
  if (!source) {
    return null;
  }
  const outputDir = settings.outputDir || process.env.CODEXBRIDGE_IMAGE_OUTPUT_DIR || "";
  if (!String(outputDir || "").trim()) {
    return null;
  }

  let image = null;
  try {
    image = await readImagePayload(source);
  } catch (error) {
    throw imageResultDownloadError(error);
  }
  if (!image?.bytes?.length) {
    return null;
  }
  let localPath = "";
  try {
    localPath = await writeLocalImage(image.bytes, {
      outputDir,
      mimeType: image.mimeType,
      sourceUrl: source.url,
    });
  } catch (error) {
    throw imageResultDownloadError(error);
  }
  const shouldInline = image.bytes.length <= INLINE_IMAGE_RESULT_MAX_BYTES &&
    String(image.mimeType || "").toLowerCase().startsWith("image/");
  return {
    ...(shouldInline ? { base64: image.bytes.toString("base64") } : {}),
    mimeType: image.mimeType,
    sourceUrl: source.url || "",
    localPath: localPath || "",
    bytes: image.bytes.length,
  };
}

function imageResultDownloadError(error) {
  const wrapped = new Error(`图片生成结果下载失败：${error?.message || String(error)}`);
  wrapped.code = "image_result_download_failed";
  wrapped.statusCode = error?.statusCode || error?.status || 0;
  wrapped.cause = error;
  return wrapped;
}

function imagePayloadFromResult(result, responsePaths = {}) {
  const image = Array.isArray(result?.data) ? result.data[0] : null;
  const configuredB64 = readJsonPath(result, responsePaths.imageBase64Path);
  if (typeof configuredB64 === "string" && configuredB64.trim()) {
    return { base64: configuredB64.trim() };
  }
  if (typeof image?.b64_json === "string" && image.b64_json.trim()) {
    return { base64: image.b64_json.trim() };
  }

  const configuredUrl = readJsonPath(result, responsePaths.imageUrlPath);
  const url = typeof configuredUrl === "string" && configuredUrl.trim()
    ? configuredUrl.trim()
    : typeof image?.url === "string" && image.url.trim()
      ? image.url.trim()
      : Array.isArray(result?.images) && typeof result.images[0]?.url === "string"
        ? result.images[0].url.trim()
        : Array.isArray(result?.output) && typeof result.output[0] === "string"
          ? result.output[0].trim()
          : "";
  return url ? { url } : null;
}

async function readImagePayload(source) {
  if (source.base64) {
    const parsed = parseBase64Image(source.base64);
    return {
      bytes: Buffer.from(parsed.base64, "base64"),
      mimeType: parsed.mimeType || "image/png",
    };
  }
  if (!source.url) {
    return null;
  }
  if (source.url.startsWith("data:")) {
    const parsed = parseDataUrl(source.url);
    return {
      bytes: Buffer.from(parsed.base64, "base64"),
      mimeType: parsed.mimeType || "image/png",
    };
  }
  const parsedUrl = new URL(source.url);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return null;
  }
  const response = await fetch(source.url);
  if (!response.ok) {
    throw new Error(`图片生成结果下载失败：HTTP ${response.status}`);
  }
  const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim();
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    bytes,
    mimeType: contentType || mimeTypeFromUrl(source.url) || "image/png",
  };
}

function parseBase64Image(value) {
  if (String(value || "").startsWith("data:")) {
    return parseDataUrl(value);
  }
  return { base64: String(value || ""), mimeType: "" };
}

function parseDataUrl(value) {
  const match = String(value || "").match(/^data:([^;,]+)?;base64,(.+)$/s);
  if (!match) {
    throw new Error("Image generation provider returned an invalid data URL.");
  }
  return {
    mimeType: match[1] || "image/png",
    base64: match[2],
  };
}

async function writeLocalImage(bytes, { outputDir = "", mimeType = "", sourceUrl = "" } = {}) {
  const targetDir = String(outputDir || "").trim();
  if (!targetDir) {
    return "";
  }
  const ext = imageExtension(mimeType, sourceUrl);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const fileName = `codexbridge-image-${Date.now()}-${hash}${ext}`;
  const target = path.resolve(targetDir, fileName);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
  return target;
}

function imageExtension(mimeType = "", sourceUrl = "") {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.includes("jpeg") || mime.includes("jpg")) {
    return ".jpg";
  }
  if (mime.includes("webp")) {
    return ".webp";
  }
  if (mime.includes("gif")) {
    return ".gif";
  }
  const fromUrl = String(sourceUrl || "").split("?")[0].match(/\.(png|jpe?g|webp|gif)$/i)?.[0];
  return fromUrl ? fromUrl.toLowerCase().replace(".jpeg", ".jpg") : ".png";
}

function mimeTypeFromUrl(sourceUrl = "") {
  const ext = String(sourceUrl || "").split("?")[0].match(/\.(png|jpe?g|webp|gif)$/i)?.[1]?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") {
    return "image/jpeg";
  }
  if (ext === "webp") {
    return "image/webp";
  }
  if (ext === "gif") {
    return "image/gif";
  }
  if (ext === "png") {
    return "image/png";
  }
  return "";
}

function defaultImageGenerationMode(route = {}) {
  const provider = String(route.provider || route.providerId || "").toLowerCase();
  const authMode = String(route.authMode || "").toLowerCase();
  if (provider === "codex" || provider === "openai" || authMode === "codex_openai") {
    return OFFICIAL_IMAGE_GENERATION.mode;
  }
  return "off";
}

function hasNativeImageGenerationTool(tools = []) {
  return (tools || []).some((tool) => {
    if (!tool || typeof tool !== "object") {
      return false;
    }
    if (tool.type === "image_generation") {
      return true;
    }
    if (tool.type === "namespace") {
      return hasNativeImageGenerationTool(tool.tools || []);
    }
    return false;
  });
}

function toolChoiceSelectsImageGeneration(toolChoice) {
  if (!toolChoice) {
    return false;
  }
  if (typeof toolChoice === "string") {
    return /image[_\s-]?generation|image[_\s-]?gen/i.test(toolChoice);
  }
  if (typeof toolChoice !== "object") {
    return false;
  }
  const type = String(toolChoice.type || "").toLowerCase();
  const name = String(toolChoice.name || toolChoice.function?.name || "").toLowerCase();
  return (
    type === "image_generation" ||
    type === "image_generation_call" ||
    /image[_\s-]?generation|image[_\s-]?gen/.test(name)
  );
}

function requestHasInputImages(requestBody) {
  const input = requestBody?.messages ?? requestBody?.input;
  return valueHasInputImage(input);
}

function valueHasInputImage(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => valueHasInputImage(item, depth + 1));
  }
  if (typeof value !== "object") {
    return false;
  }

  const type = String(value.type || "").toLowerCase();
  if (type === "input_image" || type === "image_url") {
    return true;
  }
  if (
    value.image_url !== undefined ||
    value.imageUrl !== undefined ||
    value.image !== undefined
  ) {
    return true;
  }
  if (value.content !== undefined) {
    return valueHasInputImage(value.content, depth + 1);
  }
  return false;
}

function hasExplicitImageGenerationIntent(requestBody) {
  const text = promptTextFromRequest(requestBody).trim();
  if (
    !text ||
    isImageUnderstandingPrompt(text) ||
    isInteractiveComputerPrompt(text) ||
    isImageGenerationMetaPrompt(text)
  ) {
    return false;
  }
  return hasChineseImageGenerationIntent(text) ||
    hasStandaloneDrawingIntent(text) ||
    hasColloquialImageGenerationIntent(text) ||
    /(?:generate|create|draw|paint|make)\s+(?:an?\s+)?(?:image|picture|illustration|icon|poster|logo|avatar|thumbnail|banner|wallpaper|meme|sticker|cover\s+art|book\s+cover|album\s+cover)/i.test(text) ||
    /(?:生成|创建|画|绘制|做|制作).{0,40}(?:图片|图像|图标|海报|插画|头像|封面|壁纸|表情包|贴纸|横幅|产品图|logo|banner)/i.test(text) ||
    /(?:图片|图像|图标|海报|插画|头像|封面|壁纸|表情包|贴纸|横幅|产品图|logo|banner).{0,40}(?:生成|画|绘制|制作|生图)/i.test(text) ||
    /(?:帮我|给我|请|我要|想要|需要).{0,18}(?:文生图|生图|image\s*gen(?:eration)?)/i.test(text) ||
    /(?:文生图|生图|image\s*gen(?:eration)?)[：:，,]\s*\S+/i.test(text);
}

function hasChineseImageGenerationIntent(text) {
  const value = String(text || "");
  return /(?:\u7528|\u4f7f\u7528|\u901a\u8fc7|\u5e2e\u6211|\u7ed9\u6211|\u8bf7|\u6211\u8981|\u60f3\u8981|\u9700\u8981).{0,24}(?:\u751f\u56fe|\u6587\u751f\u56fe).{0,40}\S/u.test(value) ||
    /(?:\u751f\u56fe|\u6587\u751f\u56fe).{0,24}(?:\u751f\u6210|\u753b|\u7ed8\u5236|\u5236\u4f5c|\u505a).{0,40}\S/u.test(value);
}

function hasStandaloneDrawingIntent(text) {
  const value = String(text || "");
  if (isDrawingNonVisualPrompt(value)) {
    return false;
  }
  const chineseDrawing = /(?:^|[\s，。！？、；;])(?:帮我|给我|请|麻烦|我要|想要|需要)?\s*(?:画|绘制)(?:一下|下)?\s*(?:一张|一幅|一个|一只|一位|一条|一些|一组|张|幅|个|只|位)?\s*\S{2,}/u;
  const englishDrawing = /\b(?:draw|paint|illustrate)\s+(?:an?\s+|the\s+)?\S.{2,}/i;
  return chineseDrawing.test(value) || englishDrawing.test(value);
}

function hasColloquialImageGenerationIntent(text) {
  const value = String(text || "");
  const chineseUnit = "(?:\\u4e00\\u5f20|\\u4e00\\u5e45|\\u4e00\\u4e2a|\\u4e00\\u53ea|\\u4e00\\u4f4d|\\u4e00\\u6761|\\u4e00\\u7ec4|\\u5f20|\\u5e45|\\u4e2a|\\u53ea|\\u4f4d)";
  const chinesePunctuation = "[\\s\\u3002\\uff0c\\uff1b\\uff1a\\uff01\\uff1f\\u3001;:]";
  const chineseEditorialImage = hasChineseEditorialImageIntent(value, {
    chinesePunctuation,
    chineseUnit,
  });
  if (isDrawingNonVisualPrompt(value) && !chineseEditorialImage) {
    return false;
  }
  const chineseSubjectRequest = new RegExp(
    `(?:^|${chinesePunctuation})(?:\\u5e2e\\u6211|\\u7ed9\\u6211|\\u8bf7|\\u9ebb\\u70e6|\\u6211\\u8981|\\u60f3\\u8981|\\u9700\\u8981)?\\s*` +
      `(?:\\u751f\\u6210|\\u753b|\\u7ed8\\u5236|\\u5236\\u4f5c|\\u505a|\\u51fa)\\s*` +
      `(?:\\u4e00|\\u4e24|\\u4e09|\\u51e0)?(?:\\u5f20|\\u5e45|\\u53ea|\\u4f4d|\\u6761|\\u7ec4)\\s*` +
      `(?!\\u8868\\u683c|\\u62a5\\u8868|\\u62a5\\u544a|\\u6587\\u6863|\\u6587\\u4ef6|\\u4ee3\\u7801|\\u811a\\u672c|\\u9875\\u9762|\\u7f51\\u9875|\\u7ec4\\u4ef6|\\u63a5\\u53e3|\\u6e05\\u5355|\\u5217\\u8868|\\u8ba1\\u5212|\\u65b9\\u6848|\\u89c6\\u9891|\\u52a8\\u753b)\\S{1,24}(?:$|${chinesePunctuation})`,
    "iu",
  );
  const chineseVisualTarget = "(?:\\u56fe\\u7247|\\u56fe\\u50cf|\\u56fe\\u6807|\\u56fe|\\u914d\\u56fe|\\u9996\\u56fe|\\u5206\\u4eab\\u56fe|\\u5206\\u4eab\\u5361\\u7247|\\u4e3b\\u89c6\\u89c9|KV\\s*\\u56fe|\\u6d77\\u62a5|\\u63d2\\u753b|\\u5934\\u50cf|\\u5c01\\u9762|\\u5c01\\u9762\\u56fe|\\u58c1\\u7eb8|\\u8868\\u60c5\\u5305|\\u8d34\\u7eb8|\\u6a2a\\u5e45|\\u4ea7\\u54c1\\u56fe|logo|banner)";
  const chineseRequest = new RegExp(
    `(?:^|${chinesePunctuation})(?:\\u5e2e\\u6211|\\u7ed9\\u6211|\\u8bf7|\\u9ebb\\u70e6)?\\s*(?:\\u6765|\\u6574|\\u641e|\\u51fa|\\u5f04|\\u8bbe\\u8ba1)(?:${chineseUnit})?.{0,24}${chineseVisualTarget}`,
    "iu",
  );
  const chineseNeedRequest = new RegExp(
    `(?:^|${chinesePunctuation})(?:\\u7ed9\\u6211|\\u6211\\u8981|\\u60f3\\u8981|\\u9700\\u8981)\\s*(?:${chineseUnit})?.{0,24}${chineseVisualTarget}`,
    "iu",
  );
  const chineseOutput = /(?:^|[\s\u3002\uff0c\uff1b\uff1a\uff01\uff1f\u3001;:])\u51fa\u56fe[\uff1a:]\s*\S{2,}/u;
  const chineseShortImage = new RegExp(
    `(?:^|${chinesePunctuation})(?:\\u5e2e\\u6211|\\u7ed9\\u6211|\\u8bf7|\\u9ebb\\u70e6)?\\s*(?:\\u51fa|\\u753b|\\u7ed8\\u5236|\\u505a|\\u751f\\u6210|\\u5f04|\\u8bbe\\u8ba1)(?:${chineseUnit})?.{1,24}\\u56fe(?:$|${chinesePunctuation})`,
    "iu",
  );
  const englishVisualTarget = "(?:image|picture|illustration|icon|poster|logo|avatar|thumbnail|banner|wallpaper|meme|sticker|social\\s+share\\s+card|share\\s+card|featured\\s+image|hero\\s+image|cover\\s+art|book\\s+cover|album\\s+cover)";
  const englishRequest = new RegExp(
    `\\b(?:make|produce|create|generate)\\b\\s+(?:me\\s+|us\\s+)?(?:an?\\s+|the\\s+)?(?:[\\w-]+\\s+){0,8}${englishVisualTarget}\\b`,
    "i",
  );
  const englishNeedRequest = new RegExp(
    `\\b(?:i\\s+(?:need|want|would\\s+like)|need|want|give\\s+me|get\\s+me)\\b\\s+(?:an?\\s+|the\\s+)?(?:[\\w-]+\\s+){0,8}${englishVisualTarget}\\b`,
    "i",
  );
  return chineseSubjectRequest.test(value) || chineseRequest.test(value) || chineseNeedRequest.test(value) || chineseOutput.test(value) || chineseShortImage.test(value) || chineseEditorialImage || englishRequest.test(value) || englishNeedRequest.test(value);
}

function hasChineseEditorialImageIntent(value, { chinesePunctuation, chineseUnit } = {}) {
  const boundary = chinesePunctuation || "[\\s\\u3002\\uff0c\\uff1b\\uff1a\\uff01\\uff1f\\u3001;:]";
  const unit = chineseUnit || "(?:\\u4e00\\u5f20|\\u4e00\\u4e2a|\\u5f20|\\u4e2a)";
  const contentTarget = "(?:\\u6587\\u7ae0|\\u6587\\u6848|\\u5185\\u5bb9|\\u63a8\\u6587|\\u5e16\\u5b50|\\u7b14\\u8bb0|\\u516c\\u4f17\\u53f7|\\u5c0f\\u7ea2\\u4e66|\\u670b\\u53cb\\u5708|\\u535a\\u5ba2|\\u65b0\\u95fb|\\u6d3b\\u52a8)";
  const editorialVisualTarget = "(?:\\u914d\\u56fe|\\u9996\\u56fe|\\u5c01\\u9762\\u56fe|\\u5206\\u4eab\\u56fe|\\u5206\\u4eab\\u5361\\u7247|\\u4e3b\\u89c6\\u89c9|KV\\s*\\u56fe|\\u56fe)";
  const contextualRequest = new RegExp(
    `(?:^|${boundary})(?:\\u7ed9|\\u4e3a).{0,20}${contentTarget}.{0,8}(?:\\u914d|\\u505a|\\u51fa|\\u751f\\u6210|\\u8bbe\\u8ba1)(?:${unit})?.{0,8}${editorialVisualTarget}(?:$|${boundary})`,
    "iu",
  );
  const directRequest = new RegExp(
    `(?:^|${boundary})(?:\\u5e2e\\u6211|\\u7ed9\\u6211|\\u8bf7|\\u9ebb\\u70e6)?\\s*(?:\\u51fa|\\u505a|\\u751f\\u6210|\\u8bbe\\u8ba1)(?:${unit})?.{0,12}(?:\\u914d\\u56fe|\\u9996\\u56fe|\\u5206\\u4eab\\u56fe|\\u5206\\u4eab\\u5361\\u7247|\\u4e3b\\u89c6\\u89c9|KV\\s*\\u56fe)(?:$|${boundary})`,
    "iu",
  );
  return contextualRequest.test(value) || directRequest.test(value);
}

function isDrawingNonVisualPrompt(text) {
  const value = String(text || "");
  return /(?:代码|组件|函数|脚本|调用关系|关系图|流程图|架构图|类图|时序图|图表|表格|文档|报告|说明|描述|文案|清单|大纲|接口|配置|控件|页面|按钮|工具|解析器|下载器|压缩|方案|建议|计划|思路|策略|规则|规范|mermaid|markdown|readme|react|vue|html|css|json)/i.test(value) ||
    /\b(?:component|react|vue|html|css|code|function|mermaid|diagram|flowchart|architecture|chart|table|docs?|markdown|readme|report|description|caption|alt\s*text|list|parser|script|tool|utility|json|schema|config|configuration|conclusion|in\s+words|difference|compare|explain)\b/i.test(value);
}

function isImageUnderstandingPrompt(text) {
  const value = String(text || "");
  return /(?:分析|识别|看看|看一下|描述).{0,16}(?:这张|这个|这幅)?(?:图|图片|图像|照片|截图)/i.test(value) ||
    /(?:这张|这个|这幅).{0,8}(?:图|图片|图像|照片|截图).{0,28}(?:效果|怎么样|哪里|改进|问题|能不能|是否|怎么|如何)/i.test(value) ||
    /(?:根据|基于|参考|看|看下|看一下)?(?:这张|这个|这幅)?.{0,8}(?:图|图片|图像|照片|截图).{0,40}(?:生成|给出|输出|整理|写).{0,12}(?:优化|修改|改进|分析)?(?:建议|方案|意见|思路|清单|说明|报告)/i.test(value) ||
    /(?:what'?s|describe|analy[sz]e|look at|inspect|review).{0,24}(?:image|picture|screenshot)/i.test(value);
}

function isInteractiveComputerPrompt(text) {
  return /(?:computer use|@computer|chrome|@chrome|浏览器|电脑|打开).{0,30}(?:画图|paint|notepad|记事本|youtube|网页|网站)/i.test(String(text || ""));
}

function isImageGenerationMetaPrompt(text) {
  const value = String(text || "");
  if (isImageGenerationSuppressedPrompt(value)) {
    return true;
  }
  if (isImageGenerationPromptAuthoringPrompt(value)) {
    return true;
  }
  if (isImageGenerationNonVisualArtifactPrompt(value)) {
    return true;
  }
  if (isImageTextArtifactPrompt(value)) {
    return true;
  }
  if (isImageGenerationManagementPrompt(value)) {
    return true;
  }
  if (isChineseVisualPlanningPrompt(value)) {
    return true;
  }
  if (isImageOperationPlanningPrompt(value)) {
    return true;
  }
  if (isImageGenerationProductOrSetupPrompt(value)) {
    return true;
  }
  return /(?:prompt|提示词|怎么|如何|配置|api|接口|文档|失败|报错|错误|为什么|支持|教程|示例|测试|计费|费用|价格|余额|额度|尺寸|限制|区别|了解|讨论|介绍|原理).{0,30}(?:生图|文生图|生成图片|图片生成|image\s*gen(?:eration)?)|(?:生图|文生图|生成图片|图片生成|image\s*gen(?:eration)?).{0,30}(?:prompt|提示词|怎么|如何|配置|api|接口|文档|失败|报错|错误|为什么|支持|教程|示例|测试|计费|费用|价格|余额|额度|尺寸|限制|区别|了解|讨论|介绍|原理)|(?:先|暂时|不要|不用|别).{0,12}(?:画图|生成图片|生图|draw|generate)|(?:文生图|生图|图片生成).{0,20}(?:模型|普通聊天模型)/i.test(value);
}

function isImageGenerationManagementPrompt(text) {
  const value = String(text || "");
  const imageGenerationWords = "(?:\\u751f\\u56fe|\\u6587\\u751f\\u56fe|\\u751f\\u6210\\u56fe\\u7247|\\u56fe\\u7247\\u751f\\u6210|image\\s*gen(?:eration)?)";
  const managementWords = "(?:\\u8bb0\\u5f55|\\u5386\\u53f2|\\u7f29\\u7565\\u56fe|\\u672c\\u5730\\u8def\\u5f84|\\u6253\\u5f00\\u6587\\u4ef6\\u5939|\\u9519\\u8bef\\u63d0\\u793a|\\u63a5\\u53e3|\\u6a21\\u677f|\\u6309\\u94ae|\\u4f9b\\u5e94\\u5546|\\u914d\\u7f6e\\u9875|\\u6e05\\u7406|history|records?|panel|thumbnail|local\\s+paths?|folder|error\\s+messages?|api|providers?|templates?|buttons?|settings?)";
  if (new RegExp(`${imageGenerationWords}.{0,36}${managementWords}|${managementWords}.{0,36}${imageGenerationWords}`, "iu").test(value)) {
    return true;
  }
  return /(?:image\s+provider|image\s+supplier).{0,36}(?:template|button|settings?|panel)|(?:template|button|settings?|panel).{0,36}(?:image\s+provider|image\s+supplier)/i.test(value) ||
    /(?:\u56fe\u7247\u4f9b\u5e94\u5546|\u751f\u56fe\u4f9b\u5e94\u5546).{0,36}(?:\u6a21\u677f|\u6309\u94ae|\u914d\u7f6e|\u9875\u9762)|(?:\u6a21\u677f|\u6309\u94ae|\u914d\u7f6e|\u9875\u9762).{0,36}(?:\u56fe\u7247\u4f9b\u5e94\u5546|\u751f\u56fe\u4f9b\u5e94\u5546)/u.test(value);
}

function isImageGenerationSuppressedPrompt(text) {
  const value = String(text || "");
  const spacer = "[\\s\\u3000\\uff0c,\\.\\u3002\\u3001\\uff1b;:\\uff1a]{0,2}";
  const negative = "(?:\\u4e0d\\u8981|\\u4e0d\\u7528|\\u4e0d\\u5fc5|\\u4e0d\\u9700\\u8981|\\u65e0\\u9700|\\u522b)";
  const delayedNegative = `(?:\\u6682\\u65f6|\\u5148)?${spacer}${negative}`;
  const imageGeneration = "(?:\\u751f\\u56fe|\\u56fe\\u7247\\u751f\\u6210|\\u751f\\u6210\\u56fe\\u7247|\\u751f\\u6210\\u56fe|\\u51fa\\u56fe|\\u753b\\u56fe|\\u7ed8\\u56fe)";
  const imageSubject = "(?:\\u56fe\\u7247|\\u56fe\\u50cf|\\u56fe)";
  const action = "(?:\\u7528|\\u8d70|\\u8c03|\\u8c03\\u7528)";

  return new RegExp(`${negative}${spacer}(?:\\u771f\\u7684${spacer})?(?:${action}${spacer})?${imageGeneration}`, "u").test(value) ||
    new RegExp(`${imageSubject}${spacer}${negative}${spacer}(?:\\u751f\\u6210|\\u51fa|\\u753b|\\u7ed8)`, "u").test(value) ||
    new RegExp(`(?:\\u751f\\u56fe|\\u56fe\\u7247\\u751f\\u6210)${spacer}${delayedNegative}`, "u").test(value) ||
    new RegExp(`(?:\\u751f\\u56fe|\\u56fe\\u7247\\u751f\\u6210)${spacer}${negative}${spacer}${action}`, "u").test(value);
}

function isChineseVisualPlanningPrompt(text) {
  const value = String(text || "");
  const authoringWords = "(?:帮我|给我|请|生成|创建|做|制作|写|输出|起草)";
  const visualWords = "(?:图片|图像|图标|头像|海报|插画|封面|封面图|配图|首图|分享图|分享卡片|主视觉|KV\\s*图|壁纸|表情包|贴纸|横幅|产品图|logo|banner)";
  const artifactWords = "(?:设计方案|方案|规范|配色方案|命名规则|风格指南|需求(?:清单)?|大纲|文案|说明|尺寸说明|审核清单|描述)";
  return new RegExp(`${authoringWords}.{0,24}${visualWords}.{0,24}${artifactWords}|${authoringWords}.{0,24}${artifactWords}.{0,24}${visualWords}`, "iu").test(value);
}

function isImageOperationPlanningPrompt(text) {
  const value = String(text || "");
  const chineseAuthoringWords = "(?:\\u5e2e\\u6211|\\u7ed9\\u6211|\\u8bf7|\\u751f\\u6210|\\u521b\\u5efa|\\u505a|\\u5236\\u4f5c|\\u5199|\\u8f93\\u51fa|\\u8d77\\u8349|\\u8bbe\\u8ba1)";
  const chineseVisualWords = "(?:\\u56fe\\u7247|\\u56fe\\u50cf|\\u56fe\\u6807|\\u5934\\u50cf|\\u6d77\\u62a5|\\u63d2\\u753b|\\u5c01\\u9762|\\u58c1\\u7eb8|\\u8868\\u60c5\\u5305|\\u8d34\\u7eb8|\\u6a2a\\u5e45|\\u4ea7\\u54c1\\u56fe|logo|banner)";
  const chineseOperationWords = "(?:\\u7f13\\u5b58|\\u4e0a\\u4f20|\\u5ba1\\u6838|\\u53d1\\u5e03|\\u6295\\u653e|\\u8fd0\\u8425|\\u547d\\u540d|\\u5206\\u7c7b|\\u538b\\u7f29|\\u88c1\\u526a|\\u6c34\\u5370|\\u6743\\u9650|\\u5b89\\u5168|\\u8def\\u7531|\\u4ee3\\u7406|\\u964d\\u7ea7|\\u91cd\\u8bd5|\\u5bb9\\u707e|\\u5b58\\u50a8|\\u4e0b\\u8f7d|\\u7ba1\\u7406)";
  const chineseArtifactWords = "(?:\\u7b56\\u7565|\\u89c4\\u5219|\\u8ba1\\u5212|\\u6d41\\u7a0b|SOP|\\u6e05\\u5355|\\u8868\\u683c|\\u6587\\u6863|\\u8bf4\\u660e|\\u65b9\\u6848)";
  if (new RegExp(`${chineseAuthoringWords}.{0,28}${chineseVisualWords}.{0,24}${chineseOperationWords}.{0,12}${chineseArtifactWords}`, "iu").test(value)) {
    return true;
  }

  const authoringWords = "(?:generate|create|make|build|write|draft|produce|design)";
  const visualWords = "(?:image|picture|illustration|poster|icon|logo|avatar|thumbnail|banner|wallpaper|meme|sticker|cover\\s+art|book\\s+cover|album\\s+cover)";
  const operationWords = "(?:cache|caching|upload|review|moderation|publishing|publish|delivery|cdn|permission|security|storage|download|routing|proxy|fallback|retry|watermark|crop|compression|governance)";
  const artifactWords = "(?:strateg(?:y|ies)|polic(?:y|ies)|workflow|plan|rules?|checklist|docs?|document|guide|process|pipeline)";
  return new RegExp(
    `\\b${authoringWords}\\b.{0,28}\\b${visualWords}\\b(?!\\s+(?:of|about|with|featuring)\\b).{0,36}\\b${operationWords}\\b.{0,16}\\b${artifactWords}\\b`,
    "i",
  ).test(value);
}

function isImageGenerationProductOrSetupPrompt(text) {
  if (isVisualSubjectPrompt(text)) {
    return false;
  }

  const imageGenerationWords = "(?:生图|文生图|生成图片|图片生成|image\\s*gen(?:eration)?)";
  const productWords = "(?:功能|组件|控件|按钮|页面|表单|上传|设置页|配置页|列表|模型栏|代理|供应商|能力|路由|开关|下拉|选项|接入|配置|开发|代码|实现|修复|优化|改造|build|implement|fix|configure|setting|button|feature|proxy|provider)";
  if (new RegExp(`${imageGenerationWords}.{0,30}${productWords}|${productWords}.{0,30}${imageGenerationWords}`, "i").test(text)) {
    return true;
  }

  const authoringWords = "(?:生成|创建|写|输出|帮我|给我|做|制作|create|generate|write|draft|make|build)";
  const imageWords = "(?:图片|图像|图标|头像|海报|插画|封面|壁纸|表情包|贴纸|横幅|产品图|logo|banner|image|picture|icon|avatar|poster|illustration|thumbnail|wallpaper|meme|sticker|cover\\s+art|book\\s+cover|album\\s+cover)";
  const artifactWords = "(?:接口|api|配置|文档|json|示例|schema|payload|按钮|页面|上传|代理|控件|表单|config|docs|button|page|upload|proxy|provider)";
  return new RegExp(`${authoringWords}.{0,30}${imageWords}.{0,30}${artifactWords}|${authoringWords}.{0,30}${artifactWords}.{0,30}${imageWords}`, "i").test(text);
}

function isVisualSubjectPrompt(text) {
  const value = String(text || "");
  const visualWords = "(?:图片|图像|图标|头像|海报|插画|封面|壁纸|表情包|贴纸|横幅|产品图|logo|banner|image|picture|icon|avatar|poster|illustration|thumbnail|wallpaper|meme|sticker|cover\\s+art|book\\s+cover|album\\s+cover)";
  const subjectWords = "(?:主题是|主题为|内容是|内容为|关于|about|featuring|with)";
  return new RegExp(`${visualWords}.{0,16}${subjectWords}|${subjectWords}.{0,16}${visualWords}`, "i").test(value);
}

function isImageGenerationNonVisualArtifactPrompt(text) {
  const value = String(text || "");
  const chineseAuthoringWords = "(?:\\u751f\\u6210|\\u521b\\u5efa|\\u5199|\\u8f93\\u51fa|\\u5e2e\\u6211|\\u7ed9\\u6211|\\u8bf7|\\u505a|\\u5236\\u4f5c|\\u6784\\u5efa|\\u5b9e\\u73b0|\\u8bbe\\u8ba1)";
  const chineseVisualWords = "(?:\\u56fe\\u7247|\\u56fe\\u50cf|\\u56fe\\u6807|\\u56fe|\\u5934\\u50cf|\\u6d77\\u62a5|\\u63d2\\u753b|\\u7f29\\u7565\\u56fe|\\u5c01\\u9762|\\u58c1\\u7eb8|\\u8868\\u60c5\\u5305|\\u8d34\\u7eb8|logo|banner)";
  const chineseArtifactWords = "(?:SVG|React|Vue|HTML|CSS|JSON|\\u7ec4\\u4ef6|\\u63a7\\u4ef6|\\u9875\\u9762|\\u8868\\u5355|\\u4e0a\\u4f20|\\u9884\\u89c8|\\u5f39\\u7a97|\\u6a21\\u6001\\u6846|\\u5de5\\u5177\\u680f|\\u7f51\\u683c|\\u5e03\\u5c40|\\u753b\\u5eca|\\u8f6e\\u64ad|\\u67e5\\u770b\\u5668|\\u88c1\\u526a\\u5668|\\u7f16\\u8f91\\u5668|\\u9009\\u62e9\\u5668|\\u9009\\u62e9\\u63a7\\u4ef6|\\u89e3\\u6790\\u5668|\\u4e0b\\u8f7d\\u5668|\\u538b\\u7f29\\u5668|\\u914d\\u7f6e|\\u63a5\\u53e3|\\u793a\\u4f8b|\\u6587\\u6863|\\u6e05\\u5355|\\u547d\\u540d\\u89c4\\u5219|\\u89c4\\u8303)";
  const chineseNonVisualArtifact = new RegExp(
    `${chineseAuthoringWords}.{0,30}${chineseVisualWords}.{0,36}${chineseArtifactWords}|${chineseAuthoringWords}.{0,30}${chineseArtifactWords}.{0,36}${chineseVisualWords}`,
    "iu",
  );
  if (chineseNonVisualArtifact.test(value)) {
    return true;
  }
  const authoringWords = "(?:generate|create|make|build|write|draft|produce|draw|paint|design)";
  const visualWords = "(?:image|picture|illustration|poster|icon|logo|avatar|thumbnail|banner|wallpaper|meme|sticker|cover\\s+art|book\\s+cover|album\\s+cover)";
  const artifactWords = "(?:component|react|vue|html|css|code|copy|deck|outline|brief|requirements?|specs?|spec(?:ification)?|guidelines?|design\\s*spec|style\\s*guide|naming\\s*convention|checklist|review\\s*checklist|manifest|sprite\\s*sheet|test\\s*cases?|in\\s+words|file(?:\\s*name)?|file\\s*names?|filenames?|name\\s*list|list|document|docs|json|payload|schema|configuration|config|api|url|uri|parser|compression|compressor|script|markdown|readme|downloader|tool|utility|helper|metadata|endpoint|route|picker|modal|dialog|toolbar|grid|layout|gallery|carousel|viewer|cropper|uploader|upload|form|interface|ui|page|screen|mockup|wireframe|widget|control|selector|badge|flow\\s*diagram|diagram)";
  return new RegExp(
    `\\b${authoringWords}\\b.{0,24}\\b${visualWords}\\b(?!\\s+(?:of|about|with|featuring)\\b).{0,48}\\b${artifactWords}\\b`,
    "i",
  ).test(value);
}

function isImageTextArtifactPrompt(text) {
  const value = String(text || "");
  const chineseAuthoringWords = "(?:生成|创建|写|输出|帮我|给我|做|制作|起草|润色)";
  const chineseImageWords = "(?:图片|图像|截图|产品图|海报|插画|封面|壁纸|表情包|贴纸|横幅)";
  const chineseTextArtifacts = "(?:分析报告|评估报告|报告|说明文字|说明|描述|文案|标题|替代文本|alt\\s*text)";
  const chinesePlanningArtifacts = "(?:\\u5927\\u7eb2|\\u9700\\u6c42(?:\\u6e05\\u5355)?|\\u98ce\\u683c\\u6307\\u5357|\\u6d4b\\u8bd5\\u7528\\u4f8b)";
  const chineseTextOrPlanningArtifacts = `(?:${chineseTextArtifacts}|${chinesePlanningArtifacts})`;
  if (new RegExp(`${chineseAuthoringWords}.{0,20}${chineseImageWords}.{0,20}${chineseTextOrPlanningArtifacts}`, "i").test(value)) {
    return true;
  }
  if (new RegExp(`${chineseAuthoringWords}.{0,20}${chineseTextOrPlanningArtifacts}.{0,20}${chineseImageWords}`, "i").test(value)) {
    return true;
  }

  const englishAuthoringWords = "(?:generate|create|make|write|draft|produce)";
  const englishImageWords = "(?:image|picture|screenshot|photo|poster|illustration|icon|logo|avatar|thumbnail|banner|wallpaper|meme|sticker|cover\\s+art|book\\s+cover|album\\s+cover)";
  const englishTextArtifacts = "(?:analysis\\s+report|review\\s+report|report|alt\\s*text|captions?|description|copy|taglines?|labels?|seo\\s+title(?:\\s+ideas?)?|title(?:\\s+ideas?)?|hashtags?|tags?|file\\s*names?)";
  return new RegExp(`\\b${englishAuthoringWords}\\b.{0,24}\\b${englishImageWords}\\b\\s+${englishTextArtifacts}\\b`, "i").test(value) ||
    new RegExp(`\\b${englishAuthoringWords}\\b.{0,24}\\b${englishTextArtifacts}\\b\\s+(?:for|of)\\s+(?:the\\s+|this\\s+)?\\b${englishImageWords}\\b`, "i").test(value);
}

function isImageGenerationPromptAuthoringPrompt(text) {
  const imageTarget = "(?:图片|图像|图标|海报|插画|头像|封面|壁纸|表情包|贴纸|横幅|产品图|logo|banner|image|picture|illustration|poster|icon|avatar|thumbnail|wallpaper|meme|sticker|cover\\s+art|book\\s+cover|album\\s+cover)";
  const generationVerb = "(?:生成|画|绘制|制作|create|generate|draw|paint|make)";
  const promptWord = "(?:prompt|提示词)";
  return new RegExp(`${promptWord}.{0,80}${generationVerb}.{0,50}${imageTarget}`, "i").test(text) ||
    new RegExp(`${generationVerb}.{0,50}${imageTarget}.{0,50}${promptWord}`, "i").test(text) ||
    new RegExp(`(?:写|生成|创建|给我|帮我|优化|改写|翻译|润色|compose|write|draft|improve).{0,30}${promptWord}`, "i").test(text);
}

function imagePromptFromRequest(requestBody) {
  const text = promptTextFromRequest(requestBody).trim();
  if (!text || isGenericImagePrompt(text)) {
    return "A clean modern illustration of a bridge connecting several AI model nodes, friendly, polished app style.";
  }
  return text.slice(0, 4000);
}

function promptTextFromRequest(requestBody) {
  const input = requestBody?.messages ?? requestBody?.input;
  if (input === undefined || input === null) {
    return "";
  }
  if (typeof input === "string") {
    return input;
  }
  const items = Array.isArray(input) ? input : [input];
  const looseParts = [];
  let latestUserParts = [];
  for (const item of items) {
    if (typeof item === "string") {
      looseParts.push(item);
      continue;
    }
    if (!item || typeof item !== "object") {
      continue;
    }
    const role = String(item.role || "").toLowerCase();
    if (role && !["user", "input"].includes(role)) {
      continue;
    }
    const text = contentToText(item.content ?? item.text ?? item.output ?? "");
    if (!text) {
      continue;
    }
    if (role) {
      latestUserParts = [text];
    } else {
      looseParts.push(text);
    }
  }
  return latestUserParts.length ? latestUserParts.join("\n") : looseParts.filter(Boolean).join("\n");
}

function isGenericImagePrompt(text) {
  const value = String(text || "");
  return /什么内容都可以|随便.*图|anything is fine|any image/i.test(value);
}

function imageUsage(usage = {}) {
  const inputTokens = usage.input_tokens || usage.prompt_tokens || 0;
  const outputTokens = usage.output_tokens || usage.completion_tokens || 0;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: usage.total_tokens || inputTokens + outputTokens,
    input_tokens_details: {
      cached_tokens: usage.input_tokens_details?.cached_tokens || 0,
    },
    output_tokens_details: {
      reasoning_tokens: usage.output_tokens_details?.reasoning_tokens || 0,
    },
  };
}

function imageModel() {
  return process.env.CODEXBRIDGE_IMAGE_MODEL || OFFICIAL_IMAGE_GENERATION.model;
}

function imageBaseUrl() {
  return process.env.CODEXBRIDGE_IMAGE_BASE_URL || OFFICIAL_IMAGE_GENERATION.baseUrl;
}

function imageSize() {
  return process.env.CODEXBRIDGE_IMAGE_SIZE || OFFICIAL_IMAGE_GENERATION.size;
}

function readJsonPath(value, path) {
  const normalized = String(path || "").trim();
  if (!normalized) {
    return undefined;
  }
  const parts = normalized
    .replace(/\[(\d+)]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let current = value;
  for (const part of parts) {
    if (current === undefined || current === null) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return JSON.parse(JSON.stringify(value));
}

const IMAGE_TEMPLATE_OMIT = Symbol("image_template_omit");

function renderImageTemplate(value, vars = {}) {
  if (Array.isArray(value)) {
    return value
      .map((item) => renderImageTemplate(item, vars))
      .filter((item) => item !== IMAGE_TEMPLATE_OMIT);
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      const rendered = renderImageTemplate(child, vars);
      if (rendered !== IMAGE_TEMPLATE_OMIT) {
        result[key] = rendered;
      }
    }
    return result;
  }
  if (typeof value !== "string") {
    return value;
  }
  const exact = value.match(/^{{\s*(prompt|model|size|apiKey)\s*}}$/);
  if (exact) {
    const replacement = String(vars[exact[1]] ?? "");
    return replacement ? replacement : IMAGE_TEMPLATE_OMIT;
  }
  return value.replace(/{{\s*(prompt|model|size|apiKey)\s*}}/g, (_match, key) =>
    String(vars[key] ?? ""),
  );
}

function stableFragment(value) {
  return String(value).replace(/[^A-Za-z0-9]/g, "").slice(-16) || "image";
}
