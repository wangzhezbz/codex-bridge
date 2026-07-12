function modelIdSet(items, readId) {
  return new Set((Array.isArray(items) ? items : []).map((item) => String(readId(item))));
}

function hasExactModelIds(routerConfig, health) {
  const expected = modelIdSet(routerConfig?.models, (model) => model?.id);
  const actual = modelIdSet(health?.models, (modelId) => modelId);
  return expected.size === actual.size && [...expected].every((modelId) => actual.has(modelId));
}

function restartLocatorResult(value) {
  if (!value?.found) {
    return {
      found: false,
      launchTarget: "",
      kind: null,
      source: null,
    };
  }
  return {
    found: true,
    launchTarget: String(value.launchTarget || ""),
    kind: value.kind ?? null,
    source: value.source ?? null,
  };
}

export async function runModeSelect({
  settings,
  rootDir,
  homeDir,
  mode,
  routerRunning,
  refreshRouterHealth,
  locateCodexInstall,
  broadcastState,
  getStatePayload,
  appendLog,
} = {}) {
  const selectedModelIds = settings.defaultSelectedModelIds(mode);
  let committedVerificationStarted = false;
  const verifyCommitted = routerRunning
    ? async ({ value } = {}) => {
      committedVerificationStarted = true;
      const routerConfig = value?.routerConfig;
      const health = await refreshRouterHealth(routerConfig);
      if (!health?.ok || !hasExactModelIds(routerConfig, health)) {
        throw new Error("Router health does not match the committed model set.");
      }
    }
    : undefined;

  let committed;
  try {
    committed = await settings.applyModeSwitchTransaction({
      rootDir,
      homeDir,
      mode,
      selectedModelIds,
      verifyCommitted,
    });
  } catch (error) {
    if (routerRunning && committedVerificationStarted) {
      try {
        await refreshRouterHealth(settings.readRouterConfig(rootDir));
      } catch {
        // The transaction has already restored the old files. Health recovery is best-effort.
      }
    }
    throw error;
  }

  let located;
  try {
    located = restartLocatorResult(await locateCodexInstall({ rootDir, homeDir }));
  } catch {
    located = restartLocatorResult(null);
  }
  let state = { stateUnavailable: true };
  try {
    const snapshot = await getStatePayload(settings);
    if (snapshot && typeof snapshot === "object") {
      state = snapshot;
    }
  } catch {
    // A durable mode commit must not become retryable because its UI snapshot failed.
  }
  try {
    appendLog(
      routerRunning
        ? `Selected ${mode === settings.MODE_HYBRID ? "Hybrid" : "All API"} mode with verified Router configuration.`
        : `Selected ${mode === settings.MODE_HYBRID ? "Hybrid" : "All API"} mode; configuration committed atomically while Router is stopped.`,
    );
  } catch {
    // Logging is best effort after the transaction has committed.
  }
  try {
    await broadcastState();
  } catch {
    // Renderer publication is best effort after the transaction has committed.
  }

  const restartRequired = Boolean(
    committed.codexRestartRequired ?? committed.restartRequired ?? true,
  );
  return {
    state,
    transaction: {
      revision: committed.revision ?? committed.configRevision,
      configRevision: committed.configRevision ?? committed.revision,
      restartRequired,
      restartAvailable: restartRequired && located.found,
      routerVerified: Boolean(routerRunning),
      launchTarget: located.launchTarget,
      kind: located.kind,
      source: located.source,
    },
  };
}
