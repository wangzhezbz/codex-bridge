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

const CUSTOM_CONSERVATIVE_CHAT_SAFE_PARAMS = CHAT_SAFE_PARAMS.filter(
  (param) =>
    !["parallel_tool_calls", "response_format"].includes(param),
);

const DEFAULT_CHAT_DROP_PARAMS = ["parallel_tool_calls", "response_format"];
const CUSTOM_CONSERVATIVE_CHAT_DROP_PARAMS = DEFAULT_CHAT_DROP_PARAMS;

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
  const dropParams = normalizedDropParams(route, api, customConservative);

  return {
    adapterId,
    providerFamily,
    api,
    contextWindow: positiveNumber(route.contextWindow, 258400),
    catalogContextWindow: positiveNumber(
      route.catalogContextWindow,
      positiveNumber(route.contextWindow, 258400),
    ),
    supportsTools: api === "responses"
      ? "native"
      : "chat-functions",
    supportsMcpNamespaces: true,
    supportsImages,
    supportsFiles:
      api === "responses"
        ? "native"
        : customConservative
          ? "none"
          : "text-placeholder",
    supportsResponsePreviousId: api === "responses",
    supportsPromptCaching: route.supportsPromptCaching || "unknown",
    safeParams: api === "responses"
      ? RESPONSES_SAFE_PARAMS
      : customConservative
        ? CUSTOM_CONSERVATIVE_CHAT_SAFE_PARAMS
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

function normalizedDropParams(route, api, customConservative) {
  const configured = Array.isArray(route.dropParams) ? route.dropParams : [];
  const defaults = api === "chat_completions" && customConservative
    ? CUSTOM_CONSERVATIVE_CHAT_DROP_PARAMS
    : [];
  return [...new Set([...configured, ...defaults])].sort();
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}
