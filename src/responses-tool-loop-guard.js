import { responseToolOutputContinuationGroups } from "./responses-tool-continuation.js";
import {
  latestToolCallSignaturesFromInput,
  previousToolResultSignaturesFromInput,
} from "./responses-tool-signatures.js";
import { isResponseToolCallItem } from "./tools.js";

const DEFAULT_CHAT_TOOL_CONTINUATION_TURNS = 5;

export function requestHasResponseToolOutput(requestBody = {}) {
  return responseToolOutputContinuationGroups(
    requestBody.messages ?? requestBody.input,
  ) > 0;
}

export function shouldStopChatToolContinuation(
  response,
  route,
  noProgressToolLoopTurns,
) {
  return (
    responseHasRunnableToolCall(response) &&
    noProgressToolLoopTurns > 0 &&
    noProgressToolLoopTurns >= maxChatToolContinuationTurns(route)
  );
}

export function maxChatToolContinuationTurns(route = {}) {
  const value = Number(
    route.maxToolContinuationTurns ?? route.max_tool_continuation_turns,
  );
  if (Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return DEFAULT_CHAT_TOOL_CONTINUATION_TURNS;
}

export function responseHasRunnableToolCall(response) {
  return Array.isArray(response?.output) && response.output.some(isResponseToolCallItem);
}

export function responseRepeatsPreviousToolCall(signatures, requestBody, history) {
  if (!Array.isArray(signatures) || signatures.length === 0) {
    return false;
  }
  const previousMeta = history?.getResponseMeta?.(requestBody?.previous_response_id) || {};
  const previousSignatures = Array.isArray(previousMeta.toolCallSignatures)
    ? previousMeta.toolCallSignatures
    : latestToolCallSignaturesFromInput(requestBody?.messages ?? requestBody?.input);
  return sameStringArray(signatures, previousSignatures);
}

export function repeatedToolResultHasNoProgress(signatures, requestBody, history) {
  if (!Array.isArray(signatures) || signatures.length === 0) {
    return false;
  }
  const previousMeta = history?.getResponseMeta?.(requestBody?.previous_response_id) || {};
  const previousSignatures = Array.isArray(previousMeta.toolResultSignatures)
    ? previousMeta.toolResultSignatures
    : previousToolResultSignaturesFromInput(requestBody?.messages ?? requestBody?.input);
  return sameStringArray(signatures, previousSignatures);
}

export function repeatedNoProgressToolLoopTurns(
  requestBody,
  history,
  repeatsPreviousToolCall,
  toolResultHasNoProgress,
) {
  if (!repeatsPreviousToolCall || !toolResultHasNoProgress) {
    return 0;
  }
  const previousMeta = history?.getResponseMeta?.(requestBody?.previous_response_id) || {};
  const previousTurns = Number(previousMeta.noProgressToolLoopTurns || 0);
  if (Number.isFinite(previousTurns) && previousTurns > 0) {
    return previousTurns + 1;
  }

  const inputTurns = responseToolOutputContinuationGroups(
    requestBody?.messages ?? requestBody?.input,
  );
  return Math.max(1, inputTurns - 1);
}

export function sameStringArray(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

export function localToolLoopGuardChat(route, toolContinuationTurns) {
  const displayName = route.displayName || route.id || "当前模型";
  const turnCount = Math.max(1, Number(toolContinuationTurns) || 1);
  return {
    id: `chatcmpl_tool_loop_guard_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    object: "chat.completion",
    choices: [
      {
        message: {
          role: "assistant",
          content: `模型一直重复调用工具，没有返回最终回答。报错信息：${displayName} 连续 ${turnCount} 轮工具结果后仍请求新工具调用。`,
        },
      },
    ],
    usage: null,
  };
}
