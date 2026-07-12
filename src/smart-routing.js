import { apiKeyForRoute, authModeForRoute, routeForModel } from "./config.js";
import { contextPolicyForRoute } from "./context-policy.js";
import { shouldUseImageGenerationFallback } from "./image-generation.js";
import { routeRateLimitStatus } from "./rate-limit.js";

const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const CODE_TASK_PATTERN =
  /\b(code|coding|function|class|script|typescript|javascript|python|node|react|vue|sql|debug|refactor|unit test|api|json)\b|代码|函数|脚本|调试|重构|报错|接口|组件|单元测试/i;
const LONG_CONTEXT_MIN_CHARS = 48000;
const SMART_RULE_KEYS = ["imageGeneration", "code", "longContext", "ordinaryChat"];
const SMART_RULE_MODES = new Set(["auto", "route", "off"]);
const FAILOVER_MODES = new Set(["auto", "ordered", "off"]);

export function selectRouteForRequest(config = {}, requestBody = {}, options = {}) {
  const originalRoute = routeForModel(config, requestBody.model, options.routeOptions || {});
  const smart = smartRoutingOptions(config);
  if (!smart.autoSelectModel) {
    return routeSelection(originalRoute, originalRoute, "manual_route");
  }

  const requestText = requestTextForSmartRouting(requestBody);
  const contextFloor = continuationContextFloor(requestBody, originalRoute);
  if (contextFloor === null) {
    return routeSelection(originalRoute, originalRoute, "manual_route");
  }
  const candidateRoutes = routesMeetingContextFloor(selectableRoutes(config.models || [], {
    excludedRouteIds: options.unhealthyRouteIds,
  }), contextFloor);
  const imageRule = smartRule(smart, "imageGeneration");
  if (imageRule.mode !== "off") {
    const configuredImageRoute = configuredRouteCandidate(imageRule, candidateRoutes, (route) =>
      shouldUseImageGenerationFallback(requestBody, route),
    );
    if (configuredImageRoute) {
      return routeSelection(originalRoute, configuredImageRoute, "image_generation_task_configured");
    }
    const imageGenerationRoute = imageGenerationRouteCandidate(candidateRoutes, requestBody);
    if (imageGenerationRoute) {
      return routeSelection(originalRoute, imageGenerationRoute, "image_generation_task");
    }
  }

  if (CODE_TASK_PATTERN.test(requestText)) {
    const codeRule = smartRule(smart, "code");
    if (codeRule.mode !== "off") {
      const configuredCodeRoute = configuredRouteCandidate(codeRule, candidateRoutes);
      if (configuredCodeRoute) {
        return routeSelection(originalRoute, configuredCodeRoute, "code_task_configured");
      }
      const codeRoute = codeRouteCandidate(candidateRoutes);
      if (codeRoute) {
        if (codeRoute.id === originalRoute.id && !strongCodeRouteCandidate(codeRoute)) {
          return routeSelection(originalRoute, originalRoute, "manual_route");
        }
        return routeSelection(originalRoute, codeRoute, "code_task");
      }
    }
  }

  const longContextRule = smartRule(smart, "longContext");
  if (requestText.length >= LONG_CONTEXT_MIN_CHARS && longContextRule.mode !== "off") {
    const configuredLongContextRoute = configuredRouteCandidate(longContextRule, candidateRoutes);
    if (configuredLongContextRoute) {
      return routeSelection(originalRoute, configuredLongContextRoute, "long_context_task_configured");
    }
    const longContextRoute = largestContextRoute(candidateRoutes);
    if (longContextRoute) {
      return routeSelection(originalRoute, longContextRoute, "long_context_task");
    }
  }

  const ordinaryRule = smartRule(smart, "ordinaryChat");
  if (ordinaryRule.mode !== "off") {
    const configuredOrdinaryRoute = configuredRouteCandidate(ordinaryRule, candidateRoutes);
    if (configuredOrdinaryRoute) {
      return routeSelection(originalRoute, configuredOrdinaryRoute, "ordinary_chat_configured");
    }
    const lowCostChatRoute = lowestCostOrdinaryChatRoute(config, candidateRoutes);
    if (lowCostChatRoute && lowCostChatRoute.id !== originalRoute.id) {
      return routeSelection(originalRoute, lowCostChatRoute, "ordinary_chat_low_cost");
    }

    const ordinaryChatRoute = defaultChatRoute(config, candidateRoutes);
    if (ordinaryChatRoute && ordinaryChatRoute.id !== originalRoute.id) {
      return routeSelection(originalRoute, ordinaryChatRoute, "ordinary_chat");
    }
  }

  return routeSelection(originalRoute, originalRoute, "manual_route");
}

export function selectFailoverRoute(config = {}, currentRoute = {}, error = {}, options = {}) {
  const smart = smartRoutingOptions(config);
  if (!smart.autoFailover) {
    return null;
  }
  const reason = retryableErrorReason(error);
  if (!reason) {
    return null;
  }
  if (smart.failover.mode === "off") {
    return null;
  }
  const contextFloor = routeContextWindow(currentRoute);
  if (contextFloor === null) {
    return null;
  }
  const failoverOptions = {
    ...options,
    contextFloor,
  };
  const fallback = configuredFailoverCandidate(config, currentRoute, smart.failover, failoverOptions) ||
    failoverCandidate(config, currentRoute, reason, failoverOptions);
  if (!fallback) {
    return null;
  }
  return {
    route: fallback,
    originalRoute: currentRoute,
    changed: fallback.id !== currentRoute.id,
    reason,
  };
}

export function smartRoutingOptions(config = {}) {
  const source = config.smartRouting && typeof config.smartRouting === "object"
    ? config.smartRouting
    : {};
  return {
    autoSelectModel: source.autoSelectModel === true,
    autoFailover: source.autoFailover === true,
    autoSelectRules: normalizeAutoSelectRules(source.autoSelectRules),
    failover: normalizeFailoverOptions(source.failover),
  };
}

function routeSelection(originalRoute, route, reason) {
  return {
    route,
    originalRoute,
    changed: route?.id !== originalRoute?.id,
    reason,
  };
}

function requestTextForSmartRouting(requestBody = {}) {
  const parts = [];
  collectText(requestBody.input, parts);
  collectText(requestBody.messages, parts);
  collectText(requestBody.prompt, parts);
  collectText(requestBody.instructions, parts);
  return parts.join("\n").trim();
}

function collectText(value, parts) {
  if (typeof value === "string") {
    parts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectText(item, parts);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const key of ["text", "content", "input_text", "summary", "message"]) {
    if (typeof value[key] === "string") {
      parts.push(value[key]);
    }
  }
  for (const key of ["content", "input", "messages"]) {
    if (Array.isArray(value[key])) {
      collectText(value[key], parts);
    }
  }
}

function selectableRoutes(routes = [], options = {}) {
  const excludedRouteIds = new Set(
    (Array.isArray(options.excludedRouteIds) ? options.excludedRouteIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean),
  );
  return routes.filter((route) =>
    route &&
      route.enabled !== false &&
      !excludedRouteIds.has(String(route.id || "").trim()) &&
      routeUsableForAutomaticRouting(route),
  );
}

function routesMeetingContextFloor(routes = [], contextFloor = 0) {
  if (contextFloor === null) {
    return [];
  }
  const floor = Number(contextFloor || 0);
  if (!Number.isFinite(floor) || floor <= 0) {
    return routes;
  }
  return routes.filter((route) => routeMeetsContextFloor(route, floor));
}

function routeMeetsContextFloor(route = {}, contextFloor = 0) {
  if (contextFloor === null) {
    return false;
  }
  const floor = Number(contextFloor || 0);
  if (!Number.isFinite(floor) || floor <= 0) {
    return true;
  }
  const contextWindow = routeContextWindow(route);
  return contextWindow !== null && contextWindow >= floor;
}

function continuationContextFloor(requestBody = {}, originalRoute = {}) {
  if (!isContinuingContextRequest(requestBody)) {
    return 0;
  }
  return routeContextWindow(originalRoute);
}

function isContinuingContextRequest(requestBody = {}) {
  if (requestBody?.previous_response_id) {
    return true;
  }
  const input = Array.isArray(requestBody?.input) ? requestBody.input : [];
  return input.some((item) =>
    item &&
      typeof item === "object" &&
      ["compaction", "context_compaction"].includes(String(item.type || "")),
  );
}

function largestContextRoute(routes = []) {
  return routes
    .map((route, index) => ({ route, index, contextWindow: routeContextWindow(route) }))
    .filter((item) => item.route && item.contextWindow !== null)
    .sort((left, right) => right.contextWindow - left.contextWindow || left.index - right.index)[0]?.route || null;
}

function defaultChatRoute(config = {}, routes = []) {
  const defaultModel = String(config.defaultModel || "").trim();
  if (!defaultModel) {
    return null;
  }
  return routes.find((route) =>
    route &&
      (route.id === defaultModel || route.model === defaultModel),
  ) || null;
}

function lowestCostOrdinaryChatRoute(config = {}, routes = []) {
  const priced = routes
    .map((route, index) => ({ route, index, cost: routeEstimatedChatCost(config, route) }))
    .filter((item) =>
      item.cost > 0 &&
        !routeLooksSpecializedForCode(item.route) &&
        !routeLooksSpecializedForLongContext(item.route),
    );
  if (priced.length < 2) {
    return null;
  }
  return priced.sort((left, right) => left.cost - right.cost || left.index - right.index)[0]?.route || null;
}

function codeRouteCandidate(routes = []) {
  return routes
    .map((route, index) => ({ route, index, score: routeCodeScore(route) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.route || null;
}

function imageGenerationRouteCandidate(routes = [], requestBody = {}) {
  return routes.find((route) => shouldUseImageGenerationFallback(requestBody, route)) || null;
}

function smartRule(smart = {}, key = "") {
  return smart.autoSelectRules?.[key] || normalizeSmartRule();
}

function configuredRouteCandidate(rule = {}, routes = [], predicate = null) {
  if (rule.mode !== "route" || !rule.routeId) {
    return null;
  }
  const route = routes.find((candidate) => routeMatchesId(candidate, rule.routeId));
  if (!route) {
    return null;
  }
  if (typeof predicate === "function" && !predicate(route)) {
    return null;
  }
  return route;
}

function configuredFailoverCandidate(config = {}, currentRoute = {}, failover = {}, options = {}) {
  if (failover.mode !== "ordered" || !failover.routeIds.length) {
    return null;
  }
  const candidates = selectableRoutes(config.models || [], {
    excludedRouteIds: options.excludedRouteIds,
  }).filter((route) =>
    route &&
      route.id !== currentRoute.id &&
      routeMeetsContextFloor(route, options.contextFloor),
  );
  for (const routeId of failover.routeIds) {
    const candidate = candidates.find((route) => routeMatchesId(route, routeId));
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

function routeMatchesId(route = {}, routeId = "") {
  const normalized = String(routeId || "").trim();
  return Boolean(
    normalized &&
      (String(route.id || "").trim() === normalized ||
        String(route.model || "").trim() === normalized ||
        String(route.sourcePresetId || "").trim() === normalized),
  );
}

function normalizeAutoSelectRules(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const rules = {};
  for (const key of SMART_RULE_KEYS) {
    rules[key] = normalizeSmartRule(source[key]);
  }
  return rules;
}

function normalizeSmartRule(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const requestedMode = String(source.mode || "").trim();
  const mode = SMART_RULE_MODES.has(requestedMode) ? requestedMode : "auto";
  const routeId = String(source.routeId || source.modelId || "").trim();
  return { mode, routeId };
}

function normalizeFailoverOptions(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const requestedMode = String(source.mode || "").trim();
  const mode = FAILOVER_MODES.has(requestedMode) ? requestedMode : "auto";
  const routeIds = Array.isArray(source.routeIds)
    ? source.routeIds
    : typeof source.routeIds === "string"
      ? source.routeIds.split(",")
      : [];
  return {
    mode,
    routeIds: routeIds.map((item) => String(item || "").trim()).filter(Boolean),
  };
}

function routeCodeScore(route = {}) {
  const text = [
    route.id,
    route.displayName,
    route.model,
    route.provider,
    route.providerId,
  ].filter(Boolean).join(" ").toLowerCase();
  let score = 0;
  if (/code|coder|coding/.test(text)) {
    score += 60;
  }
  if (/gpt/.test(text) || route.api === "responses") {
    score += 35;
  }
  if (/deepseek|kimi|qwen/.test(text)) {
    score += 15;
  }
  return score;
}

function strongCodeRouteCandidate(route = {}) {
  return routeLooksSpecializedForCode(route) || routeCodeScore(route) >= 35;
}

function routeContextWindow(route = {}) {
  try {
    return contextPolicyForRoute(route).contextWindow;
  } catch (error) {
    if (["context_window_unknown", "context_policy_invalid"].includes(error?.code)) {
      return null;
    }
    throw error;
  }
}

function routeLooksSpecializedForCode(route = {}) {
  const text = [
    route.id,
    route.displayName,
    route.model,
  ].filter(Boolean).join(" ").toLowerCase();
  return /code|coder|coding|代码|编程/.test(text);
}

function routeLooksSpecializedForLongContext(route = {}) {
  const text = [
    route.id,
    route.displayName,
    route.model,
  ].filter(Boolean).join(" ").toLowerCase();
  return /long|context|上下文|长文本|长上下文/.test(text);
}

function routeEstimatedChatCost(config = {}, route = {}) {
  const budget = routeBudgetForPricing(config, route);
  if (!budget) {
    return 0;
  }
  const input = positiveCostNumber(budget.inputCostPerMillion ?? budget.input_cost_per_million);
  const output = positiveCostNumber(budget.outputCostPerMillion ?? budget.output_cost_per_million);
  const cache = positiveCostNumber(budget.cacheCostPerMillion ?? budget.cache_cost_per_million);
  return input + output + (cache ? cache * 0.25 : 0);
}

function routeBudgetForPricing(config = {}, route = {}) {
  const budgets = config.usageBudgets && typeof config.usageBudgets === "object"
    ? config.usageBudgets
    : {};
  const routeId = String(route.id || route.model || "").trim();
  const provider = String(route.provider || route.providerId || route.provider_id || "").trim();
  const routeBudget = routeId && budgets.routes && typeof budgets.routes === "object"
    ? budgets.routes[routeId]
    : null;
  if (routeBudget && typeof routeBudget === "object") {
    return routeBudget;
  }
  const providerBudget = provider && budgets.providers && typeof budgets.providers === "object"
    ? budgets.providers[provider]
    : null;
  if (providerBudget && typeof providerBudget === "object") {
    return providerBudget;
  }
  return null;
}

function positiveCostNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function retryableErrorReason(error = {}) {
  const status = Number(error.statusCode || error.status || error.response?.status || 0);
  const message = String(error.message || error.bodyText || error.body || "").toLowerCase();
  if (status === 429 || /rate.?limit|too many requests|限流/.test(message)) {
    return "rate_limited";
  }
  if (status === 402 || /quota|balance|余额|额度|insufficient/.test(message)) {
    return "quota_or_balance";
  }
  if (RETRYABLE_STATUS_CODES.has(status) || /timeout|econnreset|fetch failed|bad gateway|service unavailable/.test(message)) {
    return "upstream_unavailable";
  }
  return "";
}

function failoverCandidate(config = {}, currentRoute = {}, reason = "", options = {}) {
  const candidates = selectableRoutes(config.models || [], {
    excludedRouteIds: options.excludedRouteIds,
  }).filter((route) =>
    route &&
      route.id !== currentRoute.id &&
      routeMeetsContextFloor(route, options.contextFloor),
  );
  const preferredCandidates = isProviderScopedFailoverReason(reason)
    ? preferDifferentProviderCandidates(candidates, currentRoute)
    : candidates;
  const compatibleCandidates = preferredCandidates.filter((route) =>
    route &&
      route.api === currentRoute.api,
  );
  return lowestCostPricedRoute(config, compatibleCandidates) ||
    compatibleCandidates[0] ||
    lowestCostPricedRoute(config, preferredCandidates) ||
    preferredCandidates.find((route) =>
    route &&
      route.id !== currentRoute.id,
  ) || null;
}

function lowestCostPricedRoute(config = {}, routes = []) {
  const priced = routes
    .map((route, index) => ({ route, index, cost: routeEstimatedChatCost(config, route) }))
    .filter((item) => item.cost > 0);
  if (priced.length < 2) {
    return null;
  }
  return priced.sort((left, right) => left.cost - right.cost || left.index - right.index)[0]?.route || null;
}

function isProviderScopedFailoverReason(reason = "") {
  return reason === "rate_limited" || reason === "quota_or_balance";
}

function preferDifferentProviderCandidates(candidates = [], currentRoute = {}) {
  const differentProvider = candidates.filter((route) => !sameProviderFamily(route, currentRoute));
  return differentProvider.length ? differentProvider : candidates;
}

function sameProviderFamily(left = {}, right = {}) {
  const leftMarkers = routeProviderMarkers(left);
  const rightMarkers = routeProviderMarkers(right);
  if (!leftMarkers.size || !rightMarkers.size) {
    return false;
  }
  for (const marker of leftMarkers) {
    if (rightMarkers.has(marker)) {
      return true;
    }
  }
  return false;
}

function routeProviderMarkers(route = {}) {
  const markers = new Set();
  const provider = normalizedRouteText(route.providerId || route.provider);
  if (provider) {
    markers.add(`provider:${provider}`);
  }
  const host = normalizedBaseUrlHost(route.baseUrl);
  if (host) {
    markers.add(`host:${host}`);
  }
  const keyEnv = normalizedRouteText(route.apiKeyEnv);
  if (keyEnv) {
    markers.add(`key:${keyEnv}`);
  }
  return markers;
}

function normalizedRouteText(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizedBaseUrlHost(baseUrl = "") {
  const value = String(baseUrl || "").trim();
  if (!value) {
    return "";
  }
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return "";
  }
}

export function routeUsableForAutomaticRouting(route = {}) {
  if (routeRateLimitStatus(route).cooldownRemainingMs > 0) {
    return false;
  }
  if (authModeForRoute(route) === "codex_openai") {
    return true;
  }
  return Boolean(apiKeyForRoute(route));
}
