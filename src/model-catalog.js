import { normalizeAdapterProfile } from "./adapter-profile.js";

const DEFAULT_BASE_INSTRUCTIONS =
  "You are Codex, a coding agent. Follow the developer and user instructions in the current session.";

const REASONING_LEVELS = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balanced speed and reasoning depth" },
  { effort: "high", description: "Greater reasoning depth for complex tasks" },
  { effort: "xhigh", description: "Extra high reasoning depth for complex tasks" },
];

export function buildModelCatalog(config) {
  const defaults = config.catalog || {};
  const entries = config.models
    .slice()
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
    .map((model, index) => modelCatalogEntry(model, defaults, index));

  return { models: entries };
}

export function modelCatalogEntry(model, defaults = {}, index = 0) {
  const upstreamContextWindow = Number(
    model.contextWindow || defaults.contextWindow || 258400,
  );
  const configuredCatalogContextWindow = Number(
    model.catalogContextWindow ||
      defaults.catalogContextWindow ||
      defaults.contextWindow ||
      0,
  );
  const contextWindow = Number(
    configuredCatalogContextWindow || upstreamContextWindow,
  );
  const effectiveContextWindowPercent = Number(
    model.effectiveContextWindowPercent ||
      defaults.effectiveContextWindowPercent ||
      95,
  );
  const autoCompactPercent = Number(defaults.autoCompactPercent || 80);
  const autoCompactTokenLimit = Math.floor(
    contextWindow * (autoCompactPercent / 100),
  );
  const truncationTokenLimit = Math.min(
    contextWindow,
    Math.floor(contextWindow * (effectiveContextWindowPercent / 100)),
  );
  const inputModalities = inputModalitiesForModel(model);
  const profile = normalizeAdapterProfile(model);
  const capabilities = profile.capabilities || {};
  const toolMode = capabilities.tools || profile.supportsTools || "unknown";
  const mcpNamespaceMode = capabilityMode(capabilities.mcpNamespaces);

  const entry = {
    slug: model.id,
    display_name: model.displayName,
    description: model.description || model.displayName,
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: model.priority ?? index,
    additional_speed_tiers: model.additionalSpeedTiers || [],
    service_tiers: model.serviceTiers || [],
    availability_nux: null,
    upgrade: null,
    base_instructions: model.baseInstructions || DEFAULT_BASE_INSTRUCTIONS,
    supports_reasoning_summaries: false,
    default_reasoning_summary: "auto",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text",
    truncation_policy: model.truncationPolicy || {
      mode: "tokens",
      limit: truncationTokenLimit,
    },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: inputModalities.includes("image"),
    context_window: contextWindow,
    max_context_window: contextWindow,
    effective_context_window_percent: effectiveContextWindowPercent,
    auto_compact_token_limit: autoCompactTokenLimit,
    experimental_supported_tools: [],
    input_modalities: inputModalities,
    supports_search_tool: false,
    supports_tools: toolMode,
    supports_mcp_namespaces: capabilities.mcpNamespaces === true,
    codexbridge_capabilities: {
      provider_family: capabilities.providerFamily || profile.providerFamily,
      api: capabilities.api || profile.api,
      upstream_model: model.model || model.id,
      tools: toolMode,
      mcp_namespaces: mcpNamespaceMode,
      images: capabilities.images || "unknown",
      files: capabilities.files || "unknown",
      audio: capabilities.audio || "unknown",
      reasoning: capabilityReasoningMode(capabilities.reasoning),
      compact: capabilityCompactMode(capabilities.compact),
      compact_strategy: capabilities.compact?.strategy || "unknown",
      prompt_cache: capabilities.promptCache || "unknown",
      context_window: capabilities.contextWindow || contextWindow,
      catalog_context_window: capabilities.catalogContextWindow || contextWindow,
      previous_response_id: capabilities.previousResponseId === true,
    },
  };

  const reasoning = reasoningSpecForModel(model);
  entry.default_reasoning_level = model.defaultReasoningLevel || reasoning.defaultLevel;
  entry.supported_reasoning_levels =
    model.supportedReasoningLevels || reasoning.levels;

  return entry;
}

function capabilityMode(value) {
  if (value === true) return "native";
  if (value === false || value == null) return "none";
  return String(value);
}

function capabilityReasoningMode(reasoning) {
  if (!reasoning || typeof reasoning !== "object") {
    return "unknown";
  }
  return reasoning.mode || "unknown";
}

function capabilityCompactMode(compact) {
  if (!compact || typeof compact !== "object") {
    return "unknown";
  }
  return compact.mode || "unknown";
}

function inputModalitiesForModel(model) {
  if (Array.isArray(model.inputModalities) && model.inputModalities.length > 0) {
    return model.inputModalities;
  }
  if (model.api === "responses") {
    return ["text", "image"];
  }
  return ["text"];
}

export function openAiModelsList(config) {
  const defaults = config.catalog || {};
  return {
    object: "list",
    data: config.models.map((model, index) => {
      const catalogEntry = modelCatalogEntry(model, defaults, index);
      return {
        ...catalogEntry,
        id: model.id,
        object: "model",
        created: 0,
        owned_by: model.provider || "codex-router",
        name: model.displayName || model.id,
        display_name: model.displayName || model.id,
        description: model.description || model.displayName || model.id,
      };
    }),
  };
}

function reasoningSpecForModel(model) {
  return { defaultLevel: "medium", levels: REASONING_LEVELS };
}
