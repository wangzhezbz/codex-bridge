import { normalizeAdapterProfile } from "./adapter-profile.js";
import { contextPolicyForRoute } from "./context-policy.js";
import { routeCapabilityMatrix, routeCapabilitySummary } from "./route-capability-matrix.js";

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
  const entries = activeCatalogModels(config)
    .slice()
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
    .map((model, index) => modelCatalogEntry(model, defaults, index));

  return { models: entries };
}

export function modelCatalogEntry(model, defaults = {}, index = 0) {
  const contextPolicy = contextPolicyForRoute(model, {
    defaultContextWindow: Object.hasOwn(defaults, "contextWindow")
      ? defaults.contextWindow
      : 258400,
    effectiveContextWindowPercent: defaults.effectiveContextWindowPercent,
    autoCompactPercent: defaults.autoCompactPercent,
  });
  const {
    upstreamContextWindow,
    contextWindow,
    effectiveContextWindowPercent,
    compactThreshold: autoCompactTokenLimit,
  } = contextPolicy;
  const inputModalities = inputModalitiesForModel(model);
  const profile = normalizeAdapterProfile(model);
  const capabilities = profile.capabilities || {};
  const capabilityMatrix = routeCapabilityMatrix(model);
  const capabilitySummary = routeCapabilitySummary(model);
  const toolMode = capabilities.tools || profile.supportsTools || "unknown";
  const mcpNamespaceMode = capabilityMode(capabilities.mcpNamespaces);
  const displayName = model.displayName || model.id;
  const provider = model.provider || capabilities.providerFamily || profile.providerFamily || "codex-router";
  const upstreamModel = model.model || model.id;

  const entry = {
    slug: model.id,
    id: model.id,
    object: "model",
    name: displayName,
    title: displayName,
    display_name: displayName,
    owned_by: provider,
    provider,
    model: upstreamModel,
    description: model.description || displayName,
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: model.priority ?? index,
    additional_speed_tiers: model.additionalSpeedTiers || [],
    service_tiers: model.serviceTiers || [],
    availability_nux: null,
    upgrade: null,
    base_instructions: model.baseInstructions || DEFAULT_BASE_INSTRUCTIONS,
    supports_reasoning_summaries: Boolean(model.supportsReasoningSummaries),
    default_reasoning_summary: model.defaultReasoningSummary || "auto",
    support_verbosity: Boolean(model.supportVerbosity),
    default_verbosity: model.defaultVerbosity || null,
    apply_patch_tool_type: "freeform",
    web_search_tool_type: model.webSearchToolType || "text",
    truncation_policy: contextPolicy.truncationPolicy,
    supports_parallel_tool_calls: true,
    supports_image_detail_original: inputModalities.includes("image"),
    context_window: contextWindow,
    max_context_window: contextWindow,
    effective_context_window_percent: effectiveContextWindowPercent,
    auto_compact_token_limit: autoCompactTokenLimit,
    experimental_supported_tools: [],
    input_modalities: inputModalities,
    supports_search_tool: false,
    use_responses_lite: Boolean(model.useResponsesLite),
    tool_mode: model.toolMode || null,
    multi_agent_version: model.multiAgentVersion || null,
    supports_tools: toolMode,
    supports_mcp_namespaces: capabilities.mcpNamespaces === true,
    codexbridge_capabilities: {
      provider_family: capabilities.providerFamily || profile.providerFamily,
      api: capabilities.api || profile.api,
      upstream_model: upstreamModel,
      tools: toolMode,
      mcp_namespaces: mcpNamespaceMode,
      images: capabilities.images || "unknown",
      files: capabilities.files || "unknown",
      audio: capabilities.audio || "unknown",
      reasoning: capabilityReasoningMode(capabilities.reasoning),
      compact: capabilityCompactMode(capabilities.compact),
      compact_strategy: capabilities.compact?.strategy || "unknown",
      prompt_cache: capabilities.promptCache || "unknown",
      context_window: upstreamContextWindow,
      catalog_context_window: contextWindow,
      previous_response_id: capabilities.previousResponseId === true,
      matrix: capabilityMatrix,
      summary: capabilitySummary,
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
    data: activeCatalogModels(config).map((model, index) => {
      const catalogEntry = modelCatalogEntry(model, defaults, index);
      return {
        ...catalogEntry,
        id: catalogEntry.id,
        object: "model",
        created: 0,
        owned_by: catalogEntry.owned_by,
        name: catalogEntry.name,
        display_name: catalogEntry.display_name,
        description: catalogEntry.description,
      };
    }),
  };
}

function activeCatalogModels(config = {}) {
  return Array.isArray(config.models)
    ? config.models.filter((model) => model && model.enabled !== false)
    : [];
}

function reasoningSpecForModel(model) {
  return { defaultLevel: "medium", levels: REASONING_LEVELS };
}
