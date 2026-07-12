import { normalizeAdapterProfile } from "./adapter-profile.js";

export const ROUTE_CAPABILITY_MATRIX_VERSION = "route-capability-matrix-v1";

export function routeCapabilityMatrix(route = {}) {
  const profile = normalizeAdapterProfile(route);
  const capabilities = profile.capabilities || {};
  const compact = capabilities.compact || {};
  const imageGeneration = route.imageGeneration && typeof route.imageGeneration === "object"
    ? route.imageGeneration
    : {};
  const hasImageProxy = imageGeneration.mode === "proxy" && Boolean(imageGeneration.providerId);
  return {
    version: ROUTE_CAPABILITY_MATRIX_VERSION,
    routeId: String(route.id || route.model || ""),
    api: profile.api,
    providerFamily: profile.providerFamily,
    items: [
      matrixItem("image_input", "图片输入", imageInputState(capabilities.images), imageInputDetail(capabilities.images)),
      matrixItem("tools", "工具调用", toolsState(capabilities.tools), toolsDetail(capabilities.tools)),
      matrixItem("mcp", "MCP", capabilities.mcpNamespaces === true ? "native" : "unavailable", capabilities.mcpNamespaces === true ? "保留 Codex MCP 命名空间。" : "不会转发 MCP 命名空间。"),
      matrixItem("files", "文件", fileState(capabilities.files), fileDetail(capabilities.files)),
      matrixItem("audio", "音频", audioState(capabilities.audio), audioDetail(capabilities.audio)),
      matrixItem("compact", "上下文压缩", compactState(compact), compactDetail(compact)),
      matrixItem("long_context", "长上下文", contextState(capabilities.contextWindow), `上下文窗口 ${formatContextWindow(capabilities.contextWindow)}。`),
      matrixItem("image_generation", "生图代理", hasImageProxy ? "proxy" : "unavailable", hasImageProxy ? `生图请求转给 ${imageGeneration.providerId}。` : "没有配置生图代理。"),
    ],
  };
}

export function routeCapabilitySummary(route = {}) {
  const matrix = routeCapabilityMatrix(route);
  const normal = matrix.items.filter((item) =>
    item.state === "native" ||
      item.state === "compatible" ||
      item.state === "proxy",
  ).length;
  const degraded = matrix.items.filter((item) => item.state === "degraded").length;
  const unavailable = matrix.items.filter((item) => item.state === "unavailable").length;
  return {
    version: matrix.version,
    normal,
    degraded,
    unavailable,
  };
}

function matrixItem(key, label, state, detail) {
  return {
    key,
    label,
    state,
    stateLabel: stateLabel(state),
    detail,
  };
}

function imageInputState(value) {
  if (value === "native") {
    return "native";
  }
  if (value === "chat-image-url") {
    return "compatible";
  }
  return "unavailable";
}

function imageInputDetail(value) {
  if (value === "native") {
    return "Responses 原生图片输入。";
  }
  if (value === "chat-image-url") {
    return "会转成 OpenAI-compatible 图片 URL。";
  }
  return "只按文本处理图片。";
}

function toolsState(value) {
  if (value === "native") {
    return "native";
  }
  if (value === "chat-functions") {
    return "compatible";
  }
  return "unavailable";
}

function toolsDetail(value) {
  if (value === "native") {
    return "保留 Responses 原生工具结构。";
  }
  if (value === "chat-functions") {
    return "会转成 Chat Completions function 调用。";
  }
  return "不会发送工具调用。";
}

function fileState(value) {
  if (value === "native") {
    return "native";
  }
  if (value === "text-placeholder") {
    return "degraded";
  }
  return "unavailable";
}

function fileDetail(value) {
  if (value === "native") {
    return "保留原生文件输入。";
  }
  if (value === "text-placeholder") {
    return "会转成文本摘要或占位说明。";
  }
  return "不接收文件输入。";
}

function audioState(value) {
  return value === "native" ? "native" : "unavailable";
}

function audioDetail(value) {
  return value === "native" ? "可接收音频输入。" : "不接收音频输入。";
}

function compactState(compact = {}) {
  if (compact.mode === "responses-native") {
    return "native";
  }
  if (compact.mode === "chat-summary") {
    return "compatible";
  }
  return "degraded";
}

function compactDetail(compact = {}) {
  if (compact.mode === "responses-native") {
    return "使用 Responses 压缩链路。";
  }
  if (compact.mode === "chat-summary") {
    return "使用本地摘要加 Chat JSON 兜底。";
  }
  return compact.fallback ? `使用 ${compact.fallback} 兜底。` : "使用本地兜底。";
}

function contextState(value) {
  const contextWindow = Number(value || 0);
  return contextWindow >= 128000 ? "native" : "compatible";
}

function formatContextWindow(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) {
    return "未知";
  }
  if (number >= 1000000) {
    return `${Math.round(number / 100000) / 10}M`;
  }
  if (number >= 1000) {
    return `${Math.round(number / 1000)}K`;
  }
  return String(Math.floor(number));
}

function stateLabel(state) {
  return {
    native: "原生",
    compatible: "兼容",
    proxy: "代理",
    degraded: "降级",
    unavailable: "不可用",
  }[state] || "未知";
}
