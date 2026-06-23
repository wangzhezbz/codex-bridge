import { createHash } from "node:crypto";
import { stringifyJson, tryParseJson } from "./json.js";

const APPLY_PATCH = "apply_patch";
const VALID_CHAT_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const HOSTED_OUTPUT_CALL_TYPES = new Set([
  "image_generation_call",
  "web_search_call",
  "web_search_preview_call",
]);

export function buildToolContext(responseTools = [], options = {}) {
  const context = {
    chatTools: [],
    customToolNames: new Set(),
    specialToolTypes: new Map(),
    responseToolMetadata: new Map(),
    chatToolNames: new Set(),
    chatNameToResponseName: new Map(),
    responseNameToChatName: new Map(),
    route: options.route || {},
  };

  for (const tool of responseTools || []) {
    appendResponseTool(context, tool);
  }

  return context;
}

export function responseToolCallFromChat(call, context) {
  const chatName = call?.function?.name || call?.name || "";
  const responseName = context.chatNameToResponseName.get(chatName) || chatName;
  const callId = call?.id || `call_${stableSuffix(responseName + Date.now())}`;
  const args = call?.function?.arguments ?? call?.arguments ?? "";
  const specialType = context.specialToolTypes.get(responseName);
  const metadata = context.responseToolMetadata.get(responseName) || {};
  const responseCallName = metadata.name || responseName;

  if (specialType === "tool_search_call") {
    return {
      id: `ts_${stableSuffix(callId)}`,
      type: "tool_search_call",
      call_id: callId,
      arguments: stringifyJson(args),
      status: "completed",
    };
  }

  if (specialType === "computer_call") {
    return withNamespace(metadata, {
      id: `cc_${stableSuffix(callId)}`,
      type: "computer_call",
      call_id: callId,
      name: responseCallName,
      arguments: argumentsObject(args),
      status: "completed",
    });
  }

  if (responseName === APPLY_PATCH || context.customToolNames.has(responseName)) {
    return withNamespace(metadata, {
      id: `ctc_${stableSuffix(callId)}`,
      type: "custom_tool_call",
      call_id: callId,
      name: responseCallName,
      input: customInputFromArguments(args),
      status: "completed",
    });
  }

  const functionCall = {
    id: `fc_${stableSuffix(callId)}`,
    type: "function_call",
    call_id: callId,
    name: metadata.namespace ? responseName : responseCallName,
    arguments: stringifyJson(args),
    status: "completed",
  };
  return metadata.namespace ? functionCall : withNamespace(metadata, functionCall);
}

export function chatToolCallFromResponseItem(item, context) {
  const responseName = namespacedToolName(item.name || item.type || "tool", item.namespace);
  const chatName = chatNameForResponseName(context, responseName);

  if (item.type === "custom_tool_call") {
    return {
      id: item.call_id || item.id,
      type: "function",
      function: {
        name: chatName,
        arguments: JSON.stringify({ input: item.input || "" }),
      },
    };
  }

  if (item.type === "tool_search_call") {
    return {
      id: item.call_id || item.id,
      type: "function",
      function: {
        name: chatNameForResponseName(context, "tool_search"),
        arguments: stringifyJson(item.arguments || "{}"),
      },
    };
  }

  return {
    id: item.call_id || item.id,
    type: "function",
    function: {
      name: chatName,
      arguments: stringifyJson(item.arguments ?? item.action ?? item.input ?? "{}"),
    },
  };
}

export function chatMessageFromToolOutput(item) {
  return {
    role: "tool",
    tool_call_id: item.call_id || item.id,
    content: stringifyJson(item.output ?? item.result ?? ""),
  };
}

export function isResponseToolCallItem(item) {
  if (!item || typeof item !== "object") {
    return false;
  }
  if (HOSTED_OUTPUT_CALL_TYPES.has(item.type)) {
    return false;
  }
  if (["function_call", "custom_tool_call", "tool_search_call"].includes(item.type)) {
    return true;
  }
  return typeof item.type === "string" && item.type.endsWith("_call");
}

export function isResponseToolOutputItem(item) {
  if (!item || typeof item !== "object") {
    return false;
  }
  if (
    [
      "function_call_output",
      "custom_tool_call_output",
      "tool_search_call_output",
      "tool_result",
    ].includes(item.type)
  ) {
    return true;
  }
  return typeof item.type === "string" && item.type.endsWith("_call_output");
}

function appendResponseTool(context, tool, namespace = "") {
  if (!tool || typeof tool !== "object") {
    return;
  }

  if (tool.type === "namespace") {
    const nestedNamespace = namespaceToolPrefix(tool.name || namespace);
    for (const inner of tool.tools || []) {
      appendResponseTool(context, inner, nestedNamespace);
    }
    return;
  }

  if (tool.type === "web_search" || tool.type === "web_search_preview") {
    return;
  }

  if (tool.type === "tool_search") {
    const name = namespacedToolName(tool.name || "tool_search", namespace);
    const chatName = chatNameForResponseName(context, name);
    context.specialToolTypes.set(name, "tool_search_call");
    setResponseToolMetadata(context, name, tool.name || "tool_search", namespace);
    appendChatTool(context, chatName, {
      type: "function",
      function: {
        name: chatName,
        description: tool.description || "Search for deferred local tools.",
        parameters: chatToolParameters(context, tool.parameters || {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        }),
      },
    });
    return;
  }

  if (tool.type === "custom") {
    const name = namespacedToolName(tool.name || "custom_tool", namespace);
    const chatName = chatNameForResponseName(context, name);
    context.customToolNames.add(name);
    setResponseToolMetadata(context, name, tool.name || "custom_tool", namespace);
    appendChatTool(context, chatName, {
      type: "function",
      function: {
        name: chatName,
        description: customToolDescription(name, tool.description),
        parameters: {
          type: "object",
          properties: {
            input: {
              type: "string",
              description:
                name === APPLY_PATCH
                  ? "Exact V4A patch text beginning with *** Begin Patch and ending with *** End Patch."
                  : "Free-form input passed verbatim to the tool.",
            },
          },
          required: ["input"],
        },
      },
    });
    return;
  }

  const fn = normalizeFunctionTool(tool);
  if (!fn?.name) {
    return;
  }
  const responseName = namespacedToolName(fn.name, namespace);
  const chatName = chatNameForResponseName(context, responseName);
  if (tool.type === "computer_use") {
    context.specialToolTypes.set(responseName, "computer_call");
  }
  setResponseToolMetadata(context, responseName, fn.name, namespace);
  appendChatTool(context, chatName, {
    type: "function",
    function: {
      name: chatName,
      description: fn.description || "",
      parameters: chatToolParameters(context, fn.parameters || {
        type: "object",
        properties: {},
      }),
    },
  });
}

function chatToolParameters(context, parameters) {
  if (!shouldUseMoonshotSchemaFlavor(context.route)) {
    return parameters;
  }
  return normalizeMoonshotJsonSchema(parameters);
}

function appendChatTool(context, chatName, chatTool) {
  if (context.chatToolNames.has(chatName)) {
    return;
  }
  context.chatToolNames.add(chatName);
  context.chatTools.push(chatTool);
}

function namespaceToolPrefix(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  return raw.endsWith("__") ? raw : `${raw}__`;
}

export function namespacedToolName(name, namespace) {
  const rawName = String(name || "").trim();
  if (!namespace || !rawName) {
    return rawName;
  }
  return rawName.startsWith(namespace) ? rawName : `${namespace}${rawName}`;
}

function setResponseToolMetadata(context, responseName, originalName, namespace = "") {
  if (!responseName || context.responseToolMetadata.has(responseName)) {
    return;
  }
  context.responseToolMetadata.set(responseName, {
    name: originalName || responseName,
    namespace: namespace || undefined,
  });
}

function withNamespace(metadata, item) {
  if (metadata?.namespace) {
    return {
      ...item,
      namespace: metadata.namespace,
    };
  }
  return item;
}

function argumentsObject(args) {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return args;
  }
  const parsed = tryParseJson(args);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed;
  }
  return {};
}

function normalizeFunctionTool(tool) {
  if (tool.type === "function" && tool.function) {
    return tool.function;
  }
  if (tool.type === "function") {
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    };
  }
  if (tool.name && (tool.parameters || tool.description)) {
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    };
  }
  return null;
}

function shouldUseMoonshotSchemaFlavor(route = {}) {
  if (["kimi", "moonshot"].includes(String(route.provider || "").toLowerCase())) {
    return true;
  }
  if (/kimi|moonshot/i.test(route.model || "")) {
    return true;
  }
  try {
    const hostname = new URL(route.baseUrl || "").hostname.toLowerCase();
    return hostname.includes("moonshot") || hostname.includes("kimi");
  } catch {
    return false;
  }
}

function normalizeMoonshotJsonSchema(value) {
  return normalizeMoonshotJsonSchemaValue(value, value, new Set());
}

function normalizeMoonshotJsonSchemaValue(value, root, seenRefs) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeMoonshotJsonSchemaValue(item, root, seenRefs));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  if (typeof value.$ref === "string") {
    const rewrittenRef = moonshotRef(value.$ref);
    const resolved = rewrittenRef.startsWith("#/$defs/")
      ? null
      : resolveJsonPointer(root, value.$ref);
    if (resolved && resolved !== value && !seenRefs.has(value.$ref)) {
      const nextSeenRefs = new Set(seenRefs);
      nextSeenRefs.add(value.$ref);
      const normalizedResolved = normalizeMoonshotJsonSchemaValue(
        resolved,
        root,
        nextSeenRefs,
      );
      const siblingEntries = Object.entries(value).filter(([key]) => key !== "$ref");
      if (siblingEntries.length === 0 || !isPlainObject(normalizedResolved)) {
        return normalizedResolved;
      }
      const normalizedSiblings = {};
      for (const [key, raw] of siblingEntries) {
        normalizedSiblings[key] = normalizeMoonshotJsonSchemaValue(raw, root, seenRefs);
      }
      return { ...normalizedResolved, ...normalizedSiblings };
    }
  }

  const result = {};
  let legacyDefinitions;
  let componentSchemas;

  for (const [key, raw] of Object.entries(value)) {
    if (key === "definitions") {
      legacyDefinitions = normalizeMoonshotJsonSchemaValue(raw, root, seenRefs);
      continue;
    }
    if (key === "components" && raw && typeof raw === "object" && raw.schemas) {
      const { schemas, ...rest } = raw;
      componentSchemas = normalizeMoonshotJsonSchemaValue(schemas, root, seenRefs);
      if (Object.keys(rest).length > 0) {
        result.components = normalizeMoonshotJsonSchemaValue(rest, root, seenRefs);
      }
      continue;
    }
    if (key === "$ref" && typeof raw === "string") {
      result.$ref = moonshotRef(raw);
      continue;
    }
    result[key] = normalizeMoonshotJsonSchemaValue(raw, root, seenRefs);
  }

  if (legacyDefinitions !== undefined) {
    result.$defs = mergeSchemaDefinitions(legacyDefinitions, result.$defs);
  }
  if (componentSchemas !== undefined) {
    result.$defs = mergeSchemaDefinitions(componentSchemas, result.$defs);
  }

  return result;
}

function resolveJsonPointer(root, ref) {
  if (!root || typeof ref !== "string" || !ref.startsWith("#/")) {
    return null;
  }
  let current = root;
  for (const segment of ref.slice(2).split("/")) {
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!current || typeof current !== "object" || !(key in current)) {
      return null;
    }
    current = current[key];
  }
  return current;
}

function moonshotRef(value) {
  return String(value)
    .replace(/^#\/definitions\//, "#/$defs/")
    .replace(/^#\/components\/schemas\//, "#/$defs/");
}

function mergeSchemaDefinitions(incoming, existing) {
  if (existing === undefined) {
    return incoming;
  }
  if (isPlainObject(incoming) && isPlainObject(existing)) {
    return { ...incoming, ...existing };
  }
  return existing;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function chatNameForResponseName(context, responseName) {
  if (context.responseNameToChatName.has(responseName)) {
    return context.responseNameToChatName.get(responseName);
  }

  let chatName = responseName;
  if (!VALID_CHAT_TOOL_NAME.test(chatName)) {
    const safe = chatName.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 52);
    chatName = `${safe}_${stableSuffix(responseName)}`.slice(0, 64);
  }

  context.responseNameToChatName.set(responseName, chatName);
  context.chatNameToResponseName.set(chatName, responseName);
  return chatName;
}

function customInputFromArguments(args) {
  if (typeof args !== "string") {
    return stringifyJson(args);
  }
  const parsed = tryParseJson(args);
  if (parsed && typeof parsed === "object" && typeof parsed.input === "string") {
    return parsed.input;
  }
  return args;
}

function customToolDescription(name, description = "") {
  if (name !== APPLY_PATCH) {
    return description || "Run a Codex custom tool.";
  }
  return [
    "Edit files by returning a V4A apply_patch payload.",
    "Call this function with input set to the exact patch text.",
    "The input must not be JSON inside the string; it must start with *** Begin Patch.",
  ].join(" ");
}

function stableSuffix(value) {
  return createHash("sha1").update(String(value)).digest("hex").slice(0, 10);
}
