// Only verified, same-provider/same-upstream promotions belong here. Never
// guess an alias from a slug or choose the first model of a provider.
const PROMOTED_PRESET_IDS = new Map([
  ["remote-deepseek-deepseek-flash", "deepseek-v4-1-flash"],
  ["remote-openai-gpt-6-1-sol", "openai-gpt-6-1-sol"],
  ["remote-openai-gpt-6-sol", "openai-gpt-6-sol"],
  ["remote-openai-gpt-6-luna", "openai-gpt-6-luna"],
]);

function canonicalModelReference(value) {
  const id = String(value || "").trim();
  const prefix = id.startsWith("cb-") ? "cb-" : "";
  const source = prefix ? id.slice(prefix.length) : id;
  return prefix + (PROMOTED_PRESET_IDS.get(source) || source);
}

function canonicalModelReferenceMap(input = {}) {
  const entries = Object.entries(input || {});
  const migrated = entries.filter(([key]) => canonicalModelReference(key) !== key);
  const current = entries.filter(([key]) => canonicalModelReference(key) === key);
  // Existing canonical records always win, regardless of JSON insertion order.
  return Object.fromEntries([...migrated, ...current].map(([key, value]) => [canonicalModelReference(key), value]));
}

module.exports = { canonicalModelReference, canonicalModelReferenceMap };
