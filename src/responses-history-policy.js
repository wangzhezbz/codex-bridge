export function shouldInlineLocalHistoryForResponses(requestBody, history, route = {}) {
  if (!requestBody?.previous_response_id || !history?.getResponseMeta) {
    return false;
  }
  const previousResponseId = requestBody.previous_response_id;
  if (route.supportsResponsePreviousId === false) {
    const localHistory = history.get?.(previousResponseId);
    return Array.isArray(localHistory) && localHistory.length > 0;
  }
  const meta = history.getResponseMeta(previousResponseId);
  if (meta) {
    return meta.upstreamKnown === false;
  }
  const localHistory = history.get?.(previousResponseId);
  return (
    isLikelyLocalChatResponseId(previousResponseId) &&
    Array.isArray(localHistory) &&
    localHistory.length > 0
  );
}

function isLikelyLocalChatResponseId(responseId) {
  return /^resp_chatcmpl[_-]/.test(String(responseId || ""));
}
