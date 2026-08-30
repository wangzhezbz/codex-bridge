function pluginError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function frozenPlugin(value) {
  return Object.freeze({ ...value, capabilities: Object.freeze([...value.capabilities]) });
}

export const CURATED_CODEX_PLUGINS = Object.freeze([
  frozenPlugin({
    id: "claude-mem",
    name: "Claude-Mem",
    description: "为 Codex 增加跨会话记忆能力。",
    repo: "thedotmack/claude-mem",
    commit: "4702c337d85aa12e8ab7f845264a78885676261f",
    marketplace: "claude-mem-local",
    selector: "claude-mem@claude-mem-local",
    capabilities: ["Skills", "MCP", "Hooks", "Local Worker"],
  }),
  frozenPlugin({
    id: "cowart",
    name: "Cowart",
    description: "为 Codex 增加图像生成和画布创作能力。",
    repo: "zhongerxin/cowart",
    commit: "6a338f016dee21fd97346c5fd8fe1bd81b1a7522",
    marketplace: "cowart-github",
    selector: "cowart@cowart-github",
    capabilities: ["3 Skills", "MCP", "Canvas Widget"],
  }),
]);

export function curatedPluginDefinition(id) {
  const plugin = CURATED_CODEX_PLUGINS.find((item) => item.id === String(id || ""));
  if (!plugin) throw pluginError("curated_plugin_not_allowed");
  return plugin;
}

export function buildCuratedPluginInstallPlan({ id, installedMarketplaces = [] } = {}) {
  const plugin = curatedPluginDefinition(id);
  const installed = new Set((Array.isArray(installedMarketplaces) ? installedMarketplaces : []).map(String));
  return Object.freeze([
    ...(installed.has(plugin.marketplace)
      ? [Object.freeze(["plugin", "marketplace", "remove", plugin.marketplace, "--json"])]
      : []),
    Object.freeze(["plugin", "marketplace", "add", plugin.repo, "--ref", plugin.commit, "--json"]),
    Object.freeze(["plugin", "add", plugin.selector, "--json"]),
  ]);
}

export function buildCuratedPluginRemovePlan({ id } = {}) {
  const plugin = curatedPluginDefinition(id);
  return Object.freeze([
    Object.freeze(["plugin", "remove", plugin.selector, "--json"]),
    Object.freeze(["plugin", "marketplace", "remove", plugin.marketplace, "--json"]),
  ]);
}
