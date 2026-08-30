const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_CHAT_TOOL_TURNS = 5;

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
  "text",
  "max_output_tokens",
  "include",
  "metadata",
  "store",
  "reasoning",
  "service_tier",
  "user",
];

const CODEX_OPENAI_RESPONSES_SAFE_PARAMS = [
  ...RESPONSES_SAFE_PARAMS,
  "prompt_cache_key",
  "client_metadata",
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

const ANTHROPIC_MESSAGES_SAFE_PARAMS = [
  "model",
  "messages",
  "system",
  "max_tokens",
  "stream",
  "tools",
  "tool_choice",
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
  "metadata",
  "service_tier",
  "thinking",
];

const CHAT_REASONING_PARAMS = [
  "reasoning",
  "reasoning_effort",
  "thinking",
  "enable_thinking",
  "thinking_budget",
  "extra_body",
];

const OMIT_VALUE = Symbol("codexbridge_omit_payload_value");

export function normalizeAdapterProfile(route = {}) {
  const providerFamily = providerFamilyForRoute(route);
  const api = route.api === "responses"
    ? "responses"
    : route.api === "anthropic_messages"
      ? "anthropic_messages"
      : "chat_completions";
  const authMode = String(route.authMode || route.auth_mode || "");
  const adapterId = adapterIdForRoute({ ...route, providerFamily, api });
  const customConservative = providerFamily === "custom";
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
  const supportsTools = api === "responses" || api === "anthropic_messages"
    ? "native"
    : "chat-functions";
  const supportsMcpNamespaces = true;
  const supportsFiles = route.supportsFiles || route.fileSupport || (
    api === "responses"
      ? "native"
      : customConservative
        ? "none"
        : "text-placeholder"
  );
  const supportsResponsePreviousId =
    api === "responses" && route.supportsResponsePreviousId !== false;
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
    authMode,
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
      ? authMode === "codex_openai"
        ? CODEX_OPENAI_RESPONSES_SAFE_PARAMS
        : RESPONSES_SAFE_PARAMS
      : api === "anthropic_messages"
        ? ANTHROPIC_MESSAGES_SAFE_PARAMS
        : CHAT_SAFE_PARAMS,
    dropParams,
    maxToolContinuationTurns: positiveInteger(
      route.maxToolContinuationTurns ?? route.max_tool_continuation_turns,
      api === "chat_completions" || api === "anthropic_messages"
        ? DEFAULT_CHAT_TOOL_TURNS
        : 0,
    ),
    upstreamTimeoutMs: positiveInteger(
      route.upstreamTimeoutMs ?? route.upstream_timeout_ms,
      DEFAULT_TIMEOUT_MS,
    ),
    customConservative,
  };
}

export function adapterContractForRoute(route = {}) {
  const profile = normalizeAdapterProfile(route);
  return {
    contractVersion: "adapter-contract-v1",
    route: {
      id: String(route.id || route.model || ""),
      displayName: String(route.displayName || route.name || route.id || route.model || ""),
      custom: Boolean(route.custom),
    },
    upstream: {
      api: profile.api,
      providerFamily: profile.providerFamily,
      model: String(route.model || route.upstreamModel || route.id || ""),
      baseUrl: String(route.baseUrl || route.base_url || ""),
      authMode: profile.authMode || "api_key",
    },
    adapter: {
      id: profile.adapterId,
    },
    payload: {
      allowedTopLevelParams: [...profile.safeParams],
      droppedTopLevelParams: [...profile.dropParams],
    },
    capabilities: profile.capabilities,
    runtime: {
      timeoutMs: profile.upstreamTimeoutMs,
      maxToolContinuationTurns: profile.maxToolContinuationTurns,
    },
  };
}

function capabilitiesForRoute(route, profile) {
  const reasoning = reasoningCapabilityForRoute(
    route,
    profile.api,
    profile.providerFamily,
    profile.customConservative,
  );
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
    reasoning: applyManualReasoningCapabilityOverride(route, reasoning),
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

function applyManualReasoningCapabilityOverride(route = {}, reasoning = {}) {
  const manual = route.capabilityOverrides?.reasoning || route.reasoningCapabilityOverride;
  const mode = typeof manual === "string"
    ? manual.trim()
    : typeof manual?.mode === "string"
      ? manual.mode.trim()
      : "";
  if (!mode) {
    return reasoning;
  }
  return {
    ...reasoning,
    mode,
    manualOverride: true,
    note: typeof manual?.note === "string" ? manual.note : undefined,
  };
}

export function adapterIdForRoute(route = {}) {
  const providerFamily = route.providerFamily || providerFamilyForRoute(route);
  if (route.api === "responses") {
    return "responses-native";
  }
  if (route.api === "anthropic_messages" || providerFamily === "anthropic") {
    return "messages-anthropic";
  }
  if (providerFamily === "deepseek") return "chat-deepseek";
  if (providerFamily === "kimi") return "chat-kimi";
  if (providerFamily === "minimax") return "chat-minimax";
  if (providerFamily === "doubao") return "chat-doubao";
  if (providerFamily === "qwen") return "chat-qwen";
  if (providerFamily === "gemini") return "chat-gemini";
  if (providerFamily === "xai") return "chat-xai";
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
  const onDrop = typeof options.onDrop === "function" ? options.onDrop : null;

  for (const [key, value] of Object.entries(payload || {})) {
    if (!allowed.has(key)) {
      reportPayloadDrop(onDrop, key, "unsupported_top_level_param", profile, key);
      continue;
    }
    if (dropped.has(key)) {
      reportPayloadDrop(onDrop, key, "route_dropped_param", profile, key);
      continue;
    }
    const sanitized = sanitizePayloadValue(value, {
      path: key,
      key,
      onDrop,
      profile,
    });
    if (sanitized !== OMIT_VALUE) {
      result[key] = sanitized;
    }
  }

  applyRouteSpecificPayloadDefaults(result, profile, dropped);
  return result;
}

function sanitizePayloadValue(value, context) {
  const valueType = typeof value;
  if (
    value === undefined ||
    valueType === "function" ||
    valueType === "symbol" ||
    valueType === "bigint"
  ) {
    reportPayloadDrop(
      context.onDrop,
      context.path,
      "non_json_value",
      context.profile,
      context.key,
    );
    return OMIT_VALUE;
  }
  if (value === null || valueType === "string" || valueType === "boolean") {
    return value;
  }
  if (valueType === "number") {
    if (Number.isFinite(value)) {
      return value;
    }
    reportPayloadDrop(
      context.onDrop,
      context.path,
      "non_json_value",
      context.profile,
      context.key,
    );
    return OMIT_VALUE;
  }
  if (Array.isArray(value)) {
    const result = [];
    for (let index = 0; index < value.length; index += 1) {
      const sanitized = sanitizePayloadValue(value[index], {
        ...context,
        path: `${context.path}[${index}]`,
        key: String(index),
      });
      if (sanitized !== OMIT_VALUE) {
        result.push(sanitized);
      }
    }
    return result;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (valueType === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      const sanitized = sanitizePayloadValue(child, {
        ...context,
        path: appendPayloadPath(context.path, key),
        key,
      });
      if (sanitized !== OMIT_VALUE) {
        result[key] = sanitized;
      }
    }
    return result;
  }
  return value;
}

function appendPayloadPath(parent, key) {
  if (/^[A-Za-z_$][\w$]*$/.test(key)) {
    return parent ? `${parent}.${key}` : key;
  }
  return `${parent || ""}[${JSON.stringify(key)}]`;
}

function reportPayloadDrop(onDrop, path, reason, profile, key) {
  if (!onDrop) {
    return;
  }
  onDrop({
    path,
    key,
    reason,
    adapterId: profile.adapterId,
    api: profile.api,
    providerFamily: profile.providerFamily,
  });
}

function applyRouteSpecificPayloadDefaults(payload, profile, dropped) {
  if (
    profile.api !== "chat_completions" ||
    payload.stream !== true ||
    dropped.has("stream_options")
  ) {
    applyCodexOpenAiResponsesContract(payload, profile);
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
  applyCodexOpenAiResponsesContract(payload, profile);
}

function applyCodexOpenAiResponsesContract(payload, profile) {
  if (profile.api !== "responses" || profile.authMode !== "codex_openai") {
    return;
  }

  payload.stream = true;
  payload.store = payload.store ?? true;
  delete payload.max_output_tokens;
  delete payload.temperature;
  delete payload.top_p;

  const include = Array.isArray(payload.include) ? payload.include : [];
  if (!include.includes("reasoning.encrypted_content")) {
    include.push("reasoning.encrypted_content");
  }
  payload.include = include;
  sanitizeCodexOpenAiInput(payload);
}

function sanitizeCodexOpenAiInput(payload) {
  if (!Array.isArray(payload.input)) {
    return;
  }
  payload.input = portableCodexOpenAiInputItems(payload.input, {
    store: payload.store,
  });
}

export function codexOpenAiPortableHistoryRetryPayload(payload = {}) {
  const retryPayload = { ...payload };
  delete retryPayload.previous_response_id;
  if (Array.isArray(retryPayload.input)) {
    retryPayload.input = portableCodexOpenAiInputItems(retryPayload.input, {
      store: retryPayload.store,
      forcePortable: true,
    });
  }
  return retryPayload;
}

function portableCodexOpenAiInputItems(input, options = {}) {
  const portableItems = input.flatMap((item) =>
    portableCodexOpenAiInputItem(item, options)
  );
  if (options.forcePortable !== true) {
    return portableItems;
  }
  const availableCallIds = new Set(
    portableItems
      .filter((item) => ["function_call", "custom_tool_call"].includes(item?.type))
      .map((item) => String(item.call_id || "").trim())
      .filter(Boolean),
  );
  return portableItems.filter((item) => {
    if (!["function_call_output", "custom_tool_call_output"].includes(item?.type)) {
      return true;
    }
    return availableCallIds.has(String(item.call_id || "").trim());
  });
}

function portableCodexOpenAiInputItem(item, options = {}) {
  if (!item || typeof item !== "object") {
    return [item];
  }

  if (item.type === "reasoning") {
    if (typeof item.encrypted_content === "string" && item.encrypted_content) {
      return [item];
    }
    if (options.forcePortable === true || options.store === false) {
      return [];
    }
    const id = String(item.id || "").trim();
    return id ? [{ id, type: "reasoning" }] : [];
  }

  if (isAssistantOutputMessage(item)) {
    const text = portableAssistantMessageText(item.content);
    if (text !== null) {
      return text ? [portableAssistantMessage(item, text)] : [];
    }
  }

  if (options.forcePortable !== true) {
    return [item];
  }

  if (item.role === "assistant") {
    if (Array.isArray(item.content)) {
      const text = portableAssistantMessageText(item.content, { ignoreUnknown: true });
      return text ? [portableAssistantMessage(item, text)] : [];
    }
    if (typeof item.content === "string") {
      return item.content ? [portableAssistantMessage(item, item.content)] : [];
    }
    if (typeof item.encrypted_content === "string" && item.encrypted_content) {
      return [item];
    }
    return [];
  }
  if (item.type === "function_call") {
    return portableFunctionCallItem(item);
  }
  if (item.type === "custom_tool_call") {
    return portableCustomToolCallItem(item);
  }
  if (item.type === "custom_tool_call_output") {
    return portableToolOutputItem(item, "custom_tool_call_output");
  }
  if (item.type === "function_call_output") {
    return portableToolOutputItem(item, "function_call_output");
  }
  const itemType = String(item.type || "");
  if (itemType.endsWith("_call")) {
    return portableFunctionCallItem(item);
  }
  if (itemType.endsWith("_call_output") || itemType === "tool_result") {
    return portableToolOutputItem(item, "function_call_output");
  }
  if (item.type === "item_reference") {
    return [];
  }
  return [item];
}

function portableAssistantMessage(item, content) {
  const message = { role: "assistant", content };
  const phase = typeof item.phase === "string" ? item.phase.trim() : "";
  if (["commentary", "final_answer"].includes(phase)) {
    message.phase = phase;
  }
  return message;
}

function isAssistantOutputMessage(item) {
  if (item.role !== "assistant" || !Array.isArray(item.content) || item.content.length === 0) {
    return false;
  }
  return item.content.some((part) =>
    part &&
    typeof part === "object" &&
    ["output_text", "refusal"].includes(String(part.type || "")),
  );
}

function portableAssistantMessageText(content, options = {}) {
  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!part || typeof part !== "object") {
      return null;
    }
    if (part.type === "output_text" || part.type === "input_text") {
      parts.push(String(part.text || ""));
      continue;
    }
    if (part.type === "refusal") {
      parts.push(String(part.refusal || part.text || ""));
      continue;
    }
    if (options.ignoreUnknown === true) {
      continue;
    }
    return null;
  }
  return parts.filter(Boolean).join("\n");
}

function portableFunctionCallItem(item) {
  const callId = String(item.call_id || item.id || "").trim();
  const name = String(item.name || item.function?.name || item.tool_name || "").trim();
  if (!callId || !name) {
    return [];
  }
  const args = item.arguments ?? item.function?.arguments ?? item.action ?? item.input ?? {};
  return [{
    type: "function_call",
    call_id: callId,
    name,
    arguments:
      typeof args === "string"
        ? args
        : JSON.stringify(args || {}),
  }];
}

function portableCustomToolCallItem(item) {
  const callId = String(item.call_id || "").trim();
  const name = String(item.name || "").trim();
  if (!callId || !name) {
    return [];
  }
  return [{
    type: "custom_tool_call",
    call_id: callId,
    name,
    input: typeof item.input === "string" ? item.input : String(item.input || ""),
  }];
}

function portableToolOutputItem(item, type) {
  const callId = String(item.call_id || item.tool_call_id || "").trim();
  if (!callId) {
    return [];
  }
  return [{
    type,
    call_id: callId,
    output: item.output ?? item.result ?? "",
  }];
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
  const explicitProviderFamily = String(route.providerFamily || "").trim().toLowerCase();
  if (explicitProviderFamily) {
    return explicitProviderFamily;
  }
  const api = String(route.api || "").trim().toLowerCase();
  const authMode = String(route.authMode || route.auth_mode || "").trim().toLowerCase();
  if (api === "anthropic_messages" || authMode === "anthropic_api_key") {
    return "anthropic";
  }
  const raw = String(
    route.provider ||
      route.providerId ||
      route.sourcePresetId ||
      route.baseUrl ||
      route.model ||
      "",
  ).toLowerCase();

  if (raw.includes("codex") || raw.includes("openai") || raw.includes("chatgpt.com")) {
    return "openai";
  }
  if (raw.includes("anthropic") || raw.includes("claude")) return "anthropic";
  if (raw.includes("xai") || raw.includes("grok")) return "xai";
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
  if (route.custom || raw.includes("custom")) return "custom";
  return "openai-compatible";
}

function imageSupportForRoute(route, api, inputModalities, customConservative) {
  if (!inputModalities.includes("image")) {
    return "none";
  }
  if (api === "responses" || api === "anthropic_messages") {
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
  if (api === "anthropic_messages") {
    return { mode: "anthropic-messages", params };
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
    const requiresStream = route.authMode === "codex_openai";
    return {
      mode: "responses-native",
      strategy: requiresStream ? "responses-stream" : "responses-json",
      requiresStream,
      retryWithStream: !requiresStream,
      fallback: "local-summary",
    };
  }
  return {
    mode: "chat-summary",
    strategy: "chat-json",
    requiresStream: false,
    retryWithStream: false,
    fallback: "local-summary",
  };
}

function parameterCapabilityForRoute(api, providerFamily, customConservative) {
  if (api === "responses") {
    return { mode: "responses-native" };
  }
  if (api === "anthropic_messages") {
    return { mode: "anthropic-messages" };
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
  if (context.api === "anthropic_messages") {
    return ["thinking"];
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
