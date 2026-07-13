const DEFAULT_SELECTION_TTL_MS = 2 * 60 * 1000;

export function createCodexModelSelectionState(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const ttlMs = positiveNumber(options.ttlMs, DEFAULT_SELECTION_TTL_MS);
  const latestModelByScope = new Map();
  const selectionByScope = new Map();

  function recordModelSetting({
    headers,
    pathname = "",
    body = {},
    previousModel: previousModelHint = "",
  } = {}) {
    const selectedModel = normalizedText(body?.model);
    if (!selectedModel) {
      return { recorded: false, reason: "missing_model" };
    }
    const keys = modelSettingScopeKeys(headers, pathname);
    if (keys.length === 0) {
      return { recorded: false, reason: "missing_scope" };
    }
    const timestamp = now();
    for (const key of keys) {
      const previousSelection = freshSelection(selectionByScope.get(key), timestamp, ttlMs);
      const latestModel = normalizedText(latestModelByScope.get(key)?.model);
      const previousModel = normalizedText(
        (latestModel && latestModel !== selectedModel ? latestModel : "") ||
          (previousSelection?.selectedModel &&
          previousSelection.selectedModel !== selectedModel
            ? previousSelection.selectedModel
            : "") ||
          previousSelection?.previousModel ||
          previousModelHint,
      );
      selectionByScope.set(key, {
        selectedModel,
        previousModel: previousModel && previousModel !== selectedModel ? previousModel : "",
        updatedAt: timestamp,
      });
      latestModelByScope.set(key, { model: selectedModel, seenAt: timestamp });
    }
    pruneExpired(selectionByScope, latestModelByScope, timestamp, ttlMs);
    return {
      recorded: true,
      selectedModel,
      scope: keys[0],
      previousModel:
        selectionByScope.get(keys[0])?.previousModel || "",
    };
  }

  function applyToRequest({ headers, body = {}, configuredModelIds = [] } = {}) {
    const requestedModel = normalizedText(body?.model);
    const keys = requestScopeKeys(headers, body);
    const timestamp = now();
    const selection = newestFreshSelection(keys, selectionByScope, timestamp, ttlMs);
    if (!selection) {
      observeRequest(keys, requestedModel, timestamp, latestModelByScope);
      return { changed: false, requestedModel };
    }

    const selectedModel = normalizedText(selection.value.selectedModel);
    const configured = new Set(
      Array.from(configuredModelIds || [], (value) => normalizedText(value)).filter(Boolean),
    );
    if (!selectedModel || (configured.size > 0 && !configured.has(selectedModel))) {
      observeRequest(keys, requestedModel, timestamp, latestModelByScope);
      return {
        changed: false,
        requestedModel,
        reason: "selected_model_not_configured",
      };
    }

    if (requestedModel === selectedModel) {
      observeRequest(keys, selectedModel, timestamp, latestModelByScope);
      return { changed: false, requestedModel, selectedModel, scope: selection.key };
    }

    const previousModel = normalizedText(selection.value.previousModel);
    const reconnect = Boolean(
      normalizedText(body?.previous_response_id) ||
      headerValue(headers, "x-codex-turn-state"),
    );
    if (requestedModel && requestedModel === previousModel && reconnect) {
      body.model = selectedModel;
      observeRequest(keys, selectedModel, timestamp, latestModelByScope);
      return {
        changed: true,
        requestedModel,
        selectedModel,
        previousModel,
        scope: selection.key,
        reason: "stale_reconnect_after_model_setting_change",
      };
    }

    observeRequest(keys, requestedModel, timestamp, latestModelByScope);
    return {
      changed: false,
      requestedModel,
      selectedModel,
      previousModel,
      scope: selection.key,
      reason: "request_is_not_stale_reconnect",
    };
  }

  return Object.freeze({
    recordModelSetting,
    applyToRequest,
  });
}

function modelSettingScopeKeys(headers, pathname) {
  return uniqueScopeKeys([
    ...clientScopeKeys(headers),
    responseScopeKey(modelSettingsResponseId(pathname)),
  ]);
}

function requestScopeKeys(headers, body) {
  return uniqueScopeKeys([
    ...clientScopeKeys(headers),
    responseScopeKey(body?.previous_response_id),
  ]);
}

function clientScopeKeys(headers) {
  return [
    scopeKey("thread", headerValue(headers, "x-codex-thread-id")),
    scopeKey("window", headerValue(headers, "x-codex-window-id")),
    scopeKey("installation", headerValue(headers, "x-codex-installation-id")),
  ];
}

function modelSettingsResponseId(pathname) {
  const match = String(pathname || "").match(
    /^\/(?:v1\/)?responses\/([^/]+)(?:\/model_settings)?$/,
  );
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

function responseScopeKey(responseId) {
  return scopeKey("response", responseId);
}

function scopeKey(kind, value) {
  const text = normalizedText(value);
  return text ? `${kind}:${text}` : "";
}

function uniqueScopeKeys(keys) {
  return [...new Set(keys.filter(Boolean))];
}

function newestFreshSelection(keys, selections, timestamp, ttlMs) {
  let newest = null;
  for (const key of keys) {
    const value = freshSelection(selections.get(key), timestamp, ttlMs);
    if (!value) {
      selections.delete(key);
      continue;
    }
    if (!newest || value.updatedAt > newest.value.updatedAt) {
      newest = { key, value };
    }
  }
  return newest;
}

function freshSelection(value, timestamp, ttlMs) {
  if (!value || timestamp - Number(value.updatedAt || 0) > ttlMs) {
    return null;
  }
  return value;
}

function observeRequest(keys, model, timestamp, latestModels) {
  if (!model) {
    return;
  }
  for (const key of keys) {
    latestModels.set(key, { model, seenAt: timestamp });
  }
}

function pruneExpired(selections, latestModels, timestamp, ttlMs) {
  for (const [key, value] of selections) {
    if (!freshSelection(value, timestamp, ttlMs)) {
      selections.delete(key);
    }
  }
  for (const [key, value] of latestModels) {
    if (timestamp - Number(value?.seenAt || 0) > ttlMs) {
      latestModels.delete(key);
    }
  }
}

function headerValue(headers, name) {
  if (!headers) {
    return "";
  }
  if (typeof headers.get === "function") {
    return normalizedText(headers.get(name));
  }
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  const value = key ? headers[key] : "";
  return Array.isArray(value)
    ? value.map((item) => normalizedText(item)).filter(Boolean).join(",")
    : normalizedText(value);
}

function normalizedText(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
