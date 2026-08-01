const RECORDED_LEVELS = new Set(["warning", "error"]);

function formatRendererConsoleError(details = {}) {
  if (!RECORDED_LEVELS.has(details.level)) {
    return null;
  }
  const message = String(details.message || "");
  const sourceId = String(details.sourceId || "unknown");
  const lineNumber = Number.isFinite(details.lineNumber) ? details.lineNumber : 0;
  return `Renderer console error: ${message} (${sourceId}:${lineNumber})`;
}

module.exports = {
  formatRendererConsoleError,
};
