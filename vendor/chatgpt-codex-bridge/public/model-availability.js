const originalLabels = new WeakMap();

function conversationUrl(value) {
  try {
    const url = new URL(value);
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch { return null; }
}

export function applyModelAvailability(select, extension, workspace) {
  if (!select) return;
  const heartbeat = extension?.heartbeat;
  const evidence = heartbeat?.preferenceStatus;
  const target = conversationUrl(workspace?.chatgptProjectUrl);
  const scoped = target && extension?.connected === true && extension.projectMatches === true &&
    conversationUrl(heartbeat?.href) === target && conversationUrl(evidence?.pageUrl) === target;
  const available = scoped && Array.isArray(evidence?.availableModels) ? new Set(evidence.availableModels) : null;
  for (const option of select.options) {
    if (!originalLabels.has(option)) originalLabels.set(option, option.textContent);
    const missing = available !== null && !available.has(option.value);
    option.disabled = missing;
    option.hidden = missing && option.value !== select.value;
    option.textContent = originalLabels.get(option) + (missing && option.value === select.value ? "（网页不可用）" : "");
  }
}
