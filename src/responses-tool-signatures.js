import { createHash } from "node:crypto";

import { stringifyJson, tryParseJson } from "./json.js";
import { responseInputItems } from "./responses-tool-continuation.js";
import { stableStringify } from "./stable-json.js";
import { isResponseToolCallItem, isResponseToolOutputItem } from "./tools.js";

const INVALID_JSON_VALUE = Symbol("invalid_json_value");

export function latestToolCallSignaturesFromInput(input) {
  let latest = [];
  let currentGroup = [];
  for (const item of responseInputItems(input)) {
    const signature = toolCallSignature(item);
    if (signature) {
      currentGroup.push(signature);
      latest = [...currentGroup].sort();
      continue;
    }
    currentGroup = [];
  }
  return latest;
}

export function responseToolCallSignatures(response) {
  if (!Array.isArray(response?.output)) {
    return [];
  }
  return response.output
    .map((item) => toolCallSignature(item))
    .filter(Boolean)
    .sort();
}

export function latestToolResultSignaturesFromInput(input) {
  const groups = toolResultSignatureGroupsFromInput(input);
  return groups.at(-1) || [];
}

export function previousToolResultSignaturesFromInput(input) {
  const groups = toolResultSignatureGroupsFromInput(input);
  return groups.length >= 2 ? groups[groups.length - 2] : [];
}

function toolResultSignatureGroupsFromInput(input) {
  const groups = [];
  let currentGroup = [];
  for (const item of responseInputItems(input)) {
    const signature = toolResultSignature(item);
    if (signature) {
      currentGroup.push(signature);
      continue;
    }
    if (currentGroup.length > 0) {
      groups.push([...currentGroup].sort());
      currentGroup = [];
    }
  }
  if (currentGroup.length > 0) {
    groups.push([...currentGroup].sort());
  }
  return groups;
}

function toolCallSignature(item) {
  if (!item || typeof item !== "object") {
    return "";
  }
  if (isResponseToolCallItem(item)) {
    return `${item.type || "tool"}:${item.name || ""}:${canonicalToolArguments(
      item.arguments ?? item.input ?? item.action ?? "",
    )}`;
  }
  const toolCalls = Array.isArray(item.tool_calls) ? item.tool_calls : [];
  if (toolCalls.length === 0) {
    return "";
  }
  return toolCalls
    .map((toolCall) => {
      const name = toolCall?.function?.name || toolCall?.name || "";
      const args = toolCall?.function?.arguments ?? toolCall?.arguments ?? "";
      return `chat:${name}:${canonicalToolArguments(args)}`;
    })
    .sort()
    .join("|");
}

function canonicalToolArguments(value) {
  if (typeof value === "string") {
    const parsed = tryParseJson(value, INVALID_JSON_VALUE);
    return stringifyJson(parsed === INVALID_JSON_VALUE ? value : parsed);
  }
  return stringifyJson(value ?? "");
}

function toolResultSignature(item) {
  if (!item || typeof item !== "object" || !isResponseToolOutputItem(item)) {
    return "";
  }
  return `${item.type || "tool_output"}:${canonicalToolResult(
    item.output ?? item.result ?? item.content ?? "",
  )}`;
}

function canonicalToolResult(value) {
  if (typeof value === "string") {
    const parsed = tryParseJson(value, INVALID_JSON_VALUE);
    return boundedSignatureText(
      parsed === INVALID_JSON_VALUE ? value : stableStringify(parsed),
    );
  }
  return boundedSignatureText(stableStringify(value ?? ""));
}

export function boundedSignatureText(value) {
  const text = String(value ?? "");
  if (text.length <= 2000) {
    return text;
  }
  const digest = createHash("sha256").update(text).digest("hex");
  return `${text.length}:${digest}`;
}
