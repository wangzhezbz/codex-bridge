const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_CHAT_TOOL_TURNS = 2;

const RESPONSES_SAFE_PARAMS = [
  "model",
  "input",
  "messages",
  "instructions",
  "previous_response_id",
  "stream",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "temperature",
  "top_p",
  "max_output_tokens",
  "metadata",
  "store",
  "reasoning",
  "service_tier",
  "user",
];

const CHAT_SAFE_PARAMS = [
  "model",
  "messages",
  "stream",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "temperature",
  "top_p",
  "presence_penalty",
  "frequency_penalty",
  "seed",
  "user",
  "max_tokens",
  "max_completion_tokens",
  "stop",
  "response_format",
  "stream_options",
  "reasoning_split",
  "reasoning",
  "reasoning_effort",
  "thinking",
  "enable_thinking",
  "thinking_budget",
  "extra_body",
];

const CHAT_REASONING_PARAMS = [
  "reasoning",
  "reasoning_effort",
  "thinking",
  "enable_thinking",
  "thinking_budget",
  "extra_body",
];

export function normalizeAdapterProfile(route = {}) {
  const providerFamily = providerFamilyForRoute(route);
  const api = route.api === "responses" ? "responses" : "chat_completions";
  const adapterId = adapterIdForRoute({ ...route, providerFamily, api });
  const customConservative = Boolean(route.custom) || providerFamily === "custom";
  const inputModalities = Array.isArray(route.inputModalities)
    ? route.inputModalities
    : [];
  const supportsImages = imageSupportForRoute(
    route,
    api,
    inputModalities,
    customConservative,
  );
  const contextWindow = positiveNumber(route.contextWindow, 258400);
  const catalogContextWindow = positiveNumber(
    route.catalogContextWindow,
    contextWindow,
  );
  const supportsTools = api === "responses" ? "native" : "chat-functions";
  const supportsMcpNamespaces = true;
  const supportsFiles = api === "responses"
    ? "native"
    : customConservative
      ? "none"
      : "text-placeholder";
  const supportsResponsePreviousId = api === "responses";
  const supportsPromptCaching = route.supportsPromptCaching || "unknown";
  const dropParams = normalizedDropParams(route, {
    api,
    providerFamily,
    customConservative,
  });

  return {
    adapterId,
    providerFamily,
    api,
    contextWindow,
    catalogContextWindow,
    supportsTools,
    supportsMcpNamespaces,
    supportsImages,
    supportsFiles,
    supportsResponsePreviousId,
    supportsPromptCaching,
    capabilities: capabilitiesForRoute(route, {
      api,
      providerFamily,
      contextWindow,
      catalogContextWindow,
      supportsTools,
      supportsMcpNamespaces,
      supportsImages,
      supportsFiles,
      supportsResponsePreviousId,
      supportsPromptCaching,
      inputModalities,
      customConservative,
    }),
    safeParams: api === "responses"
      ? RESPONSES_SAFE_PARAMS
      : CHAT_SAFE_PARAMS,
    dropParams,
    maxToolContinuationTurns: positiveInteger(
      route.maxToolContinuationTurns ?? route.max_tool_continuation_turns,
      api === "chat_completions" ? DEFAULT_CHAT_TOOL_TURNS : 0,
    ),
    upstreamTimeoutMs: positiveInteger(
      route.upstreamTimeoutMs ?? route.upstream_timeout_ms,
      DEFAULT_TIMEOUT_MS,
    ),
    customConservative,
  };
}

function capabilitiesForRoute(route, profile) {
  return {
    api: profile.api,
    providerFamily: profile.providerFamily,
    tools: profile.supportsTools,
    mcpNamespaces: profile.supportsMcpNamespaces,
    images: profile.supportsImages,
    files: profile.supportsFiles,
    audio: audioSupportForRoute(
      profile.api,
      profile.providerFamily,
      profile.inputModalities,
    ),
    reasoning: reasoningCapabilityForRoute(
      route,
      profile.api,
      profile.providerFamily,
      profile.customConservative,
    ),
    compact: compactCapabilityForRoute(route, profile.api),
    promptCache: profile.supportsPromptCaching,
    contextWindow: profile.contextWindow,
    catalogContextWindow: profile.catalogContextWindow,
    previousResponseId: profile.supportsResponsePreviousId,
    parameters: parameterCapabilityForRoute(
      profile.api,
      profile.providerFamily,
      profile.customConservative,
    ),
  };
}

export function adapterIdForRoute(route = {}) {
  const providerFamily = route.providerFamily || providerFamilyForRoute(route);
  if (route.api === "responses") {
    return "responses-native";
  }
  if (providerFamily === "deepseek") return "chat-deepseek";
  if (providerFamily === "kimi") return "chat-kimi";
  if (providerFamily === "minimax") return "chat-minimax";
  if (providerFamily === "doubao") return "chat-doubao";
  if (providerFamily === "qwen") return "chat-qwen";
  if (providerFamily === "gemini") return "chat-gemini";
  if (providerFamily === "custom") return "custom-conservative";
  return "chat-openai-compatible";
}

export function filterPayloadForAdapter(payload = {}, profileOrRoute = {}, options = {}) {
  const profile = profileOrRoute.safeParams
    ? profileOrRoute
    : normalizeAdapterProfile({
        ...profileOrRoute,
        api: options.api || profileOrRoute.api,
      });
  const allowed = new Set(profile.safeParams || []);
  const dropped = new Set(profile.dropParams || []);
  const result = {};

  for (const [key, value] of Object.entries(payload || {})) {
    if (allowed.has(key) && !dropped.has(key)) {
      result[key] = value;
    }
  }

  applyRouteSpecificPayloadDefaults(result, profile, dropped);
  return result;
}

function applyRouteSpecificPayloadDefaults(payload, profile, dropped) {
  if (
    profile.api !== "chat_completions" ||
    payload.stream !== true ||
    dropped.has("stream_options")
  ) {
    return;
  }
  const streamOptions =
    payload.stream_options && typeof payload.stream_options === "object"
      ? payload.stream_options
      : {};
  payload.stream_options = {
    ...streamOptions,
    include_usage: true,
  };
}

export function reasoningParamsForAdapter(request = {}, route = {}, options = {}) {
  const profile = normalizeAdapterProfile(route);
  if (profile.api !== "chat_completions" || !hasReasoningControls(request)) {
    return {};
  }
  if (profile.customConservative) {
    return rawReasoningParams(request);
  }

  const hasTools = Boolean(
    options.hasTools ??
      (Array.isArray(request.tools) && request.tools.length > 0),
  );

  if (supportsDeepSeekThinkingParams(route, profile.providerFamily)) {
    return deepSeekReasoningParams(request);
  }
  if (supportsKimiThinkingParams(route, profile.providerFamily)) {
    return kimiReasoningParams(request);
  }
  if (profile.providerFamily === "qwen" || profile.providerFamily === "zhipu") {
    return enableThinkingParams(request, { hasTools });
  }
  if (profile.providerFamily === "openrouter") {
    return openRouterReasoningParams(request);
  }
  if (profile.providerFamily === "siliconflow") {
    if (siliconFlowUsesDeepSeekThinking(route)) {
      return deepSeekReasoningParams(request);
    }
    if (siliconFlowUsesEnableThinking(route)) {
      return enableThinkingParams(request, { hasTools });
    }
  }
  return {};
}

function providerFamilyForRoute(route = {}) {
  const raw = String(
    route.providerFamily ||
      route.provider ||
      route.providerId ||
      route.sourcePresetId ||
      route.baseUrl ||
      route.model ||
      "",
  ).toLowerCase();

  if (route.custom || raw.includes("custom")) return "custom";
  if (raw.includes("codex") || raw.includes("openai") || raw.includes("chatgpt.com")) {
    return "openai";
  }
  if (raw.includes("deepseek")) return "deepseek";
  if (raw.includes("kimi") || raw.includes("moonshot")) return "kimi";
  if (raw.includes("minimax")) return "minimax";
  if (raw.includes("volc") || raw.includes("doubao") || raw.includes("ark.cn")) return "doubao";
  if (raw.includes("qwen") || raw.includes("dashscope")) return "qwen";
  if (raw.includes("zhipu") || raw.includes("bigmodel") || raw.includes("glm-")) return "zhipu";
  if (raw.includes("openrouter")) return "openrouter";
  if (raw.includes("siliconflow")) return "siliconflow";
  if (raw.includes("gemini") || raw.includes("google")) return "gemini";
  if (raw.includes("baidu") || raw.includes("qianfan")) return "baidu";
  return "openai-compatible";
}

function imageSupportForRoute(route, api, inputModalities, customConservative) {
  if (!inputModalities.includes("image")) {
    return "none";
  }
  if (api === "responses") {
    return "native";
  }
  return "chat-image-url";
}

function audioSupportForRoute(api, providerFamily, inputModalities) {
  if (!inputModalities.includes("audio")) {
    return "none";
  }
  if (api === "responses") {
    return "native";
  }
  if (providerFamily === "custom" || providerFamily === "openai-compatible") {
    return "chat-input-audio";
  }
  return "none";
}

function reasoningCapabilityForRoute(route, api, providerFamily, customConservative) {
  const params = reasoningParameterAllowList(route, {
    api,
    providerFamily,
    customConservative,
  });
  if (api === "responses") {
    return { mode: "responses-native", params };
  }
  if (supportsDeepSeekThinkingParams(route, providerFamily)) {
    return { mode: "deepseek-thinking", params };
  }
  if (providerFamily === "deepseek") {
    return { mode: "deepseek-reasoner-no-replay", params };
  }
  if (supportsKimiThinkingParams(route, providerFamily)) {
    return { mode: "kimi-thinking-request", params };
  }
  if (providerFamily === "kimi") {
    return { mode: "kimi-preserved-thinking", params };
  }
  if (providerFamily === "minimax") {
    return { mode: "minimax-reasoning-split", params };
  }
  if (providerFamily === "qwen") {
    return { mode: "dashscope-enable-thinking", params };
  }
  if (providerFamily === "zhipu") {
    return { mode: "zhipu-enable-thinking", params };
  }
  if (providerFamily === "openrouter") {
    return { mode: "openrouter-reasoning", params };
  }
  if (providerFamily === "siliconflow") {
    return { mode: "siliconflow-reasoning", params };
  }
  if (customConservative) {
    return { mode: "openai-compatible-passthrough", params };
  }
  return { mode: "openai-compatible", params };
}

function compactCapabilityForRoute(route, api) {
  if (api === "responses") {
    return {
      mode: "responses-native",
      requiresStream: route.authMode === "codex_openai",
    };
  }
  return {
    mode: "chat-summary",
    requiresStream: false,
  };
}

function parameterCapabilityForRoute(api, providerFamily, customConservative) {
  if (api === "responses") {
    return { mode: "responses-native" };
  }
  if (customConservative) {
    return { mode: "openai-compatible-passthrough" };
  }
  if (providerFamily === "openai-compatible") {
    return { mode: "openai-compatible" };
  }
  return { mode: "route-specific-safe-list" };
}

function normalizedDropParams(route, context = {}) {
  const configured = Array.isArray(route.dropParams) ? route.dropParams : [];
  const allowedReasoningParams = new Set(reasoningParameterAllowList(route, context));
  const unsupportedReasoningParams = context.api === "chat_completions"
    ? CHAT_REASONING_PARAMS.filter((param) => !allowedReasoningParams.has(param))
    : [];
  return [...new Set([...configured, ...unsupportedReasoningParams])].sort();
}

function reasoningParameterAllowList(route, context = {}) {
  if (context.api === "responses") {
    return ["reasoning"];
  }
  if (context.customConservative) {
    return CHAT_REASONING_PARAMS;
  }
  if (supportsDeepSeekThinkingParams(route, context.providerFamily)) {
    return ["reasoning_effort", "thinking"];
  }
  if (supportsKimiThinkingParams(route, context.providerFamily)) {
    return ["thinking"];
  }
  if (context.providerFamily === "qwen" || context.providerFamily === "zhipu") {
    return ["enable_thinking", "thinking_budget"];
  }
  if (context.providerFamily === "openrouter") {
    return ["reasoning", "reasoning_effort"];
  }
  if (context.providerFamily === "siliconflow") {
    if (siliconFlowUsesDeepSeekThinking(route)) {
      return ["reasoning_effort", "thinking"];
    }
    if (siliconFlowUsesEnableThinking(route)) {
      return ["enable_thinking", "thinking_budget"];
    }
  }
  return [];
}

function rawReasoningParams(request) {
  const result = {};
  copyIfPresent(request, result, "reasoning");
  copyIfPresent(request, result, "reasoning_effort");
  copyIfPresent(request, result, "thinking");
  copyIfPresent(request, result, "enable_thinking");
  copyIfPresent(request, result, "thinking_budget");
  copyIfPresent(request, result, "extra_body");
  return result;
}

function deepSeekReasoningParams(request) {
  const result = {};
  const effort = deepSeekReasoningEffort(request);
  if (effort) {
    result.reasoning_effort = effort;
  }
  if (reasoningWantsThinking(request)) {
    result.thinking = { type: "enabled" };
  }
  return result;
}

function kimiReasoningParams(request) {
  if (!reasoningWantsThinking(request)) {
    return {};
  }
  return { thinking: { type: "enabled", keep: "all" } };
}

function enableThinkingParams(request, options = {}) {
  const shouldEnable = !options.hasTools && reasoningWantsThinking(request);
  const result = { enable_thinking: shouldEnable };
  const budget = reasoningBudget(request);
  if (shouldEnable && budget) {
    result.thinking_budget = budget;
  }
  return result;
}

function openRouterReasoningParams(request) {
  const reasoning = {};
  const effort = openRouterReasoningEffort(request);
  if (effort) {
    reasoning.effort = effort;
  }
  const budget = reasoningBudget(request);
  if (budget) {
    reasoning.max_tokens = budget;
  }
  const rawReasoning = request.reasoning;
  if (rawReasoning && typeof rawReasoning === "object") {
    if (typeof rawReasoning.exclude === "boolean") {
      reasoning.exclude = rawReasoning.exclude;
    }
    if (typeof rawReasoning.enabled === "boolean") {
      reasoning.enabled = rawReasoning.enabled;
    }
  }
  return Object.keys(reasoning).length > 0 ? { reasoning } : {};
}

function hasReasoningControls(request) {
  return CHAT_REASONING_PARAMS.some((param) => request[param] !== undefined) ||
    request.model_reasoning_effort !== undefined;
}

function reasoningWantsThinking(request) {
  const effort = reasoningEffort(request);
  if (!effort && request.reasoning === undefined && request.thinking === undefined) {
    return false;
  }
  return !["none", "off", "disabled", "minimal"].includes(effort);
}

function reasoningEffort(request) {
  const value =
    request.reasoning_effort ??
    request.model_reasoning_effort ??
    (request.reasoning && typeof request.reasoning === "object"
      ? request.reasoning.effort
      : undefined);
  return String(value || "").trim().toLowerCase();
}

function deepSeekReasoningEffort(request) {
  const effort = reasoningEffort(request);
  if (["xhigh", "max", "maximum"].includes(effort)) {
    return "max";
  }
  if (["low", "medium", "high"].includes(effort)) {
    return "high";
  }
  return "";
}

function openRouterReasoningEffort(request) {
  const effort = reasoningEffort(request);
  if (["low", "medium", "high"].includes(effort)) {
    return effort;
  }
  if (["xhigh", "max", "maximum"].includes(effort)) {
    return "high";
  }
  return "";
}

function reasoningBudget(request) {
  const value =
    request.thinking_budget ??
    (request.reasoning && typeof request.reasoning === "object"
      ? request.reasoning.max_tokens ?? request.reasoning.budget_tokens
      : undefined);
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function supportsDeepSeekThinkingParams(route, providerFamily) {
  if (providerFamily !== "deepseek") {
    return false;
  }
  return /deepseek-v4/i.test(String(route.model || route.id || ""));
}

function supportsKimiThinkingParams(route, providerFamily) {
  if (providerFamily !== "kimi") {
    return false;
  }
  return /kimi-k2\.[56]/i.test(String(route.model || route.id || ""));
}

function siliconFlowUsesDeepSeekThinking(route) {
  return /deepseek-v4/i.test(String(route.model || route.id || ""));
}

function siliconFlowUsesEnableThinking(route) {
  return /(qwen|glm)/i.test(String(route.model || route.id || ""));
}

function copyIfPresent(source, target, key) {
  if (source[key] !== undefined) {
    target[key] = source[key];
  }
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}
