function retainedAuthority(previous, fresh, fallbackCode = "refresh_unavailable") {
  if (previous?.ok !== true) {
    return fresh;
  }
  return {
    ...previous,
    cached: true,
    stale: true,
    refreshError: {
      code: String(fresh?.code || fallbackCode),
      error: String(fresh?.error || "Codex resource refresh is temporarily unavailable."),
    },
  };
}

function retainCodexResourceSnapshots(fresh = {}, previous = null) {
  if (!previous) {
    return fresh;
  }
  const freshCli = fresh.codexCliSnapshot || {};
  const previousCli = previous.codexCliSnapshot || {};
  const cliPlugins = freshCli.plugins?.ok === true
    ? freshCli.plugins
    : retainedAuthority(previousCli.plugins, freshCli.plugins, "plugins_unavailable");
  const cliMcpServers = freshCli.mcpServers?.ok === true
    ? freshCli.mcpServers
    : retainedAuthority(previousCli.mcpServers, freshCli.mcpServers, "mcp_unavailable");
  const prompt = fresh.codexPromptInputSnapshot?.ok === true
    ? fresh.codexPromptInputSnapshot
    : retainedAuthority(
        previous.codexPromptInputSnapshot,
        fresh.codexPromptInputSnapshot,
        "prompt_unavailable",
      );

  const freshApp = fresh.codexAppServerSnapshot || {};
  const previousApp = previous.codexAppServerSnapshot || {};
  const appKinds = {};
  let retainedAppKind = false;
  for (const kind of ["plugins", "apps", "skills"]) {
    const freshItems = Array.isArray(freshApp?.[kind]?.items) ? freshApp[kind].items : [];
    const previousItems = Array.isArray(previousApp?.[kind]?.items) ? previousApp[kind].items : [];
    const transientEmptyApps = kind === "apps" && freshApp?.[kind]?.ok === true && freshItems.length === 0 && previousItems.length > 0;
    if (freshApp?.[kind]?.ok === true && !transientEmptyApps) {
      appKinds[kind] = freshApp[kind];
      continue;
    }
    appKinds[kind] = retainedAuthority(
      previousApp[kind],
      transientEmptyApps
        ? { code: "empty_not_ready", error: "Codex app-server returned an empty app list before it was ready." }
        : freshApp[kind],
      `${kind}_unavailable`,
    );
    retainedAppKind ||= appKinds[kind]?.stale === true;
  }
  const appServer = {
    ...freshApp,
    ...appKinds,
  };
  if (retainedAppKind) {
    appServer.ok = true;
    appServer.cached = true;
    appServer.stale = true;
    appServer.snapshotSource = "last_authoritative_cache";
    appServer.authoritativeRefreshedAt = previousApp.authoritativeRefreshedAt || previousApp.refreshedAt || null;
  }

  return {
    ...fresh,
    executable: fresh.executable || previous.executable || freshCli.executable || previousCli.executable || "",
    codexCliSnapshot: {
      ...freshCli,
      executable: freshCli.executable || previousCli.executable || previous.executable || "",
      plugins: cliPlugins,
      mcpServers: cliMcpServers,
    },
    codexPromptInputSnapshot: prompt,
    codexAppServerSnapshot: appServer,
  };
}

function hasCodexResourceAuthority(snapshot = {}) {
  return snapshot.codexCliSnapshot?.plugins?.ok === true ||
    snapshot.codexCliSnapshot?.mcpServers?.ok === true ||
    snapshot.codexPromptInputSnapshot?.ok === true ||
    ["plugins", "apps", "skills"].some((kind) => snapshot.codexAppServerSnapshot?.[kind]?.ok === true);
}

module.exports = {
  hasCodexResourceAuthority,
  retainCodexResourceSnapshots,
};
