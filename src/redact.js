export function redactSecretText(value, limit = 1000) {
  return String(value || "")
    .replace(/:\/\/[^/?#\s]+@/g, "://[REDACTED]@")
    .replace(
      /([?&](?:api[_-]?key|token|access_token|secret|key)=)[^&#\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ak)-[A-Za-z0-9._-]{6,}\b/gi, (match) => {
      const prefix = match.slice(0, 2).toLowerCase();
      return `${prefix}-[REDACTED]`;
    })
    .replace(/<\s*(ak)-[A-Za-z0-9._-]{6,}\s*>/gi, "<ak-[REDACTED]>")
    .replace(/\b(?:org|proj)-[A-Za-z0-9._-]{8,}\b/gi, (match) => {
      const prefix = match.split("-")[0].toLowerCase();
      return `${prefix}-[REDACTED]`;
    })
    .replace(/((?:api[_-]?key|authorization|token|secret|key)["'\s:=]+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[REDACTED]")
    .slice(0, limit);
}
