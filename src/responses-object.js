export function normalizeResponsesObject(value) {
  if (!value || typeof value !== "object" || typeof value.id !== "string" || !value.id) {
    return null;
  }
  if (value.object === "response") {
    return value;
  }
  if (
    value.status ||
    value.output ||
    typeof value.output_text === "string" ||
    value.usage
  ) {
    return { object: "response", ...value };
  }
  return null;
}

export function isResponsesObject(value) {
  return Boolean(normalizeResponsesObject(value));
}

export function isCompletedResponsesObject(value) {
  const response = normalizeResponsesObject(value);
  return Boolean(response && response.status === "completed" && !response.error);
}
