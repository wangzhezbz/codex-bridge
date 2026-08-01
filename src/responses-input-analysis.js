import { contentToText } from "./responses-to-chat.js";
import { responseInputItems } from "./responses-tool-continuation.js";
import { boundedSignatureText } from "./responses-tool-signatures.js";
import { isResponseToolCallItem, isResponseToolOutputItem } from "./tools.js";

export function requestHasToolProtocolInput(requestBody = {}) {
  return responseInputItems(requestBody.messages ?? requestBody.input).some((item) =>
    inputItemContainsToolProtocol(item),
  );
}

function inputItemContainsToolProtocol(item) {
  if (!item || typeof item !== "object") {
    return false;
  }
  if (isResponseToolCallItem(item) || isResponseToolOutputItem(item)) {
    return true;
  }
  if (Array.isArray(item.tool_calls) && item.tool_calls.length > 0) {
    return true;
  }
  if (String(item.role || "").toLowerCase() === "tool") {
    return true;
  }
  if (Array.isArray(item.content)) {
    return item.content.some(inputItemContainsToolProtocol);
  }
  return false;
}

export function userInputSignatures(input) {
  return responseInputItems(input)
    .map((item) => normalizeUserInputSignature(userInputText(item)))
    .filter(Boolean);
}

function userInputText(item) {
  if (typeof item === "string") {
    return item;
  }
  if (!item || typeof item !== "object") {
    return "";
  }
  if (item.type === "input_text") {
    return item.text || "";
  }
  const role = String(item.role || "").toLowerCase();
  if (role !== "user" && !(item.type === "message" && role === "user")) {
    return "";
  }
  return contentToText(
    item.content ?? item.text ?? item.output ?? item.encrypted_content ?? "",
  );
}

function normalizeUserInputSignature(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text ? boundedSignatureText(text) : "";
}

export function inputHasOpaqueUserInput(input) {
  return opaqueUserInputProfile(input).hasOpaqueUserInput;
}

function opaqueUserInputProfile(input) {
  const items = responseInputItems(input);
  const profile = {
    itemCount: items.length,
    userInputCount: 0,
    opaqueUserInputCount: 0,
    visibleUserInputCount: 0,
    latestUserIndex: -1,
    hasOpaqueUserInput: false,
  };
  items.forEach((item, index) => {
    if (!item || typeof item !== "object") {
      if (typeof item === "string" && item.trim()) {
        profile.userInputCount += 1;
        profile.visibleUserInputCount += 1;
        profile.latestUserIndex = index;
      }
      return;
    }
    const role = String(item.role || "").toLowerCase();
    if (role !== "user" && !(item.type === "message" && role === "user")) {
      return;
    }
    profile.userInputCount += 1;
    profile.latestUserIndex = index;
    const visibleText = contentToText(item.content ?? item.text ?? item.output ?? "");
    if (visibleText.trim()) {
      profile.visibleUserInputCount += 1;
    }
    if (
      typeof item.encrypted_content === "string" &&
      item.encrypted_content.trim().length > 0
    ) {
      profile.opaqueUserInputCount += 1;
      profile.hasOpaqueUserInput = true;
    }
  });
  return profile;
}
