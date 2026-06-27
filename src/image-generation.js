import { randomUUID } from "node:crypto";
import { requireApiKey, joinUpstreamUrl } from "./config.js";
import {
  contentToText,
  interactivePluginKindForRequest,
  responseRequestToChatSourceMessages,
} from "./responses-to-chat.js";
import { assistantHistoryMessageFromResponse, responseToSse } from "./chat-to-responses.js";
import { jsonResponse } from "./json.js";

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
  return (
    hasNativeImageGenerationTool(requestBody.tools) &&
    toolChoiceSelectsImageGeneration(requestBody.tool_choice)
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
  validateImageGenerationSettings(settings);
  const imageRoute = {
    id: settings.id,
    displayName: settings.displayName,
    api: "images",
    baseUrl: settings.baseUrl,
    model: settings.model,
    authMode: "api_key",
    apiKeyEnv: settings.apiKeyEnv,
    apiKey: settings.apiKey,
  };
  requireApiKey(imageRoute);

  const upstreamUrl = joinUpstreamUrl(settings.baseUrl, settings.endpoint);
  const upstream = await callJsonUpstream(
    upstreamUrl,
    imageRoute,
    {
      model: settings.model,
      prompt,
      n: 1,
      size: settings.size,
    },
    context,
  );

  const response = responseFromImageResult(
    upstream,
    requestBody.model || route.id,
    route,
    prompt,
    settings.model,
    settings.displayName,
  );
  const { messages: sourceMessages } = responseRequestToChatSourceMessages(
    requestBody,
    route,
    history,
  );
  history?.record?.(response.id, [
    ...sourceMessages,
    assistantHistoryMessageFromResponse(response),
  ]);
  history?.recordResponse?.(response, {
    api: "image_generation",
    routeId: route.id || "",
    upstreamModel: settings.model,
    upstreamKnown: false,
  });

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

export function responseFromImageResult(
  result,
  requestedModel,
  route,
  prompt,
  upstreamModel = imageModel(),
  upstreamProvider = "OpenAI Image Generation",
) {
  const image = Array.isArray(result?.data) ? result.data[0] : null;
  const b64 = typeof image?.b64_json === "string" ? image.b64_json : "";
  const url = typeof image?.url === "string" ? image.url : "";
  const revisedPrompt =
    typeof image?.revised_prompt === "string" && image.revised_prompt.trim()
      ? image.revised_prompt.trim()
      : prompt;
  const id = `resp_img_${randomUUID()}`;
  const messageText = b64
    ? `Image generated via ${upstreamProvider}.`
    : url
      ? `Image generated via ${upstreamProvider}: ${url}`
      : `${upstreamProvider} returned a result, but it did not include displayable image data.`;
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
    };
  }

  return {
    enabled: true,
    mode: official ? "official" : "custom",
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
    size: raw.size || imageSize(),
    apiKeyEnv:
      raw.apiKeyEnv ||
      (official ? OFFICIAL_IMAGE_GENERATION.apiKeyEnv : "IMAGE_GENERATION_API_KEY"),
    apiKey: raw.apiKey,
  };
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
  const userParts = [];
  for (const item of items) {
    if (typeof item === "string") {
      userParts.push(item);
      continue;
    }
    if (!item || typeof item !== "object") {
      continue;
    }
    const role = String(item.role || "").toLowerCase();
    if (role && !["user", "input"].includes(role)) {
      continue;
    }
    userParts.push(contentToText(item.content ?? item.text ?? item.output ?? ""));
  }
  return userParts.filter(Boolean).join("\n");
}

function isGenericImagePrompt(text) {
  const value = String(text || "");
  return (
    value.length < 24 ||
    /什么内容都可以|随便.*图|anything is fine|any image/i.test(value)
  );
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

function stableFragment(value) {
  return String(value).replace(/[^A-Za-z0-9]/g, "").slice(-16) || "image";
}
