import { isResponseToolOutputItem } from "./tools.js";

export function responseInputItems(input) {
  if (input === undefined || input === null) {
    return [];
  }
  return Array.isArray(input) ? input : [input];
}

export function responseToolOutputContinuationGroups(input) {
  let groups = 0;
  let inOutputGroup = false;
  for (const item of responseInputItems(input)) {
    if (isResponseToolOutputItem(item)) {
      if (!inOutputGroup) {
        groups += 1;
        inOutputGroup = true;
      }
      continue;
    }
    inOutputGroup = false;
  }
  return groups;
}

export function chatToolContinuationTurns(requestBody, history) {
  const currentTurns = responseToolOutputContinuationGroups(
    requestBody?.messages ?? requestBody?.input,
  );
  if (currentTurns <= 0) {
    return 0;
  }
  const previousMeta = history?.getResponseMeta?.(requestBody?.previous_response_id) || {};
  const previousTurns = Number(previousMeta.toolContinuationTurns || 0);
  return (Number.isFinite(previousTurns) && previousTurns > 0 ? previousTurns : 0) +
    currentTurns;
}
