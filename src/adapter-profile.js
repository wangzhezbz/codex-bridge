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
  "reasoning_split",
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
  const dropParams = normalizedDropParams(route);
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

  return result;
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

function reasoningCapabilityForRoute(api, providerFamily, customConservative) {
  if (api === "responses") {
    return { mode: "responses-native" };
  }
  if (providerFamily === "deepseek") {
    return { mode: "deepseek-reasoning-content" };
  }
  if (providerFamily === "minimax") {
    return { mode: "minimax-reasoning-split" };
  }
  if (customConservative) {
    return { mode: "openai-compatible-passthrough" };
  }
  return { mode: "openai-compatible" };
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

function normalizedDropParams(route) {
  const configured = Array.isArray(route.dropParams) ? route.dropParams : [];
  return [...new Set(configured)].sort();
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}
