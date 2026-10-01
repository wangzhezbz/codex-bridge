import { canonicalModelReference } from "../shared/model-preset-aliases.cjs";

const DEFAULT_SELECTION_TTL_MS = 2 * 60 * 1000;
const DEFAULT_SELECTION_CAPACITY = 4_096;
const DEFAULT_PRUNE_INTERVAL = 128;
const MAX_SCOPE_VALUE_CHARS = 512;

export function createCodexModelSelectionState(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const ttlMs = positiveNumber(options.ttlMs, DEFAULT_SELECTION_TTL_MS);
  const capacity = positiveInteger(options.capacity, DEFAULT_SELECTION_CAPACITY);
  const pruneInterval = positiveInteger(options.pruneInterval, DEFAULT_PRUNE_INTERVAL);
  const latestModelByScope = new Map();
  const selectionByScope = new Map();
  let operationsSincePrune = 0;

  function maintain(timestamp, force = false) {
    operationsSincePrune += 1;
    if (force || operationsSincePrune >= pruneInterval) {
      pruneExpired(selectionByScope, latestModelByScope, timestamp, ttlMs);
      operationsSincePrune = 0;
    }
    trimOldest(selectionByScope, capacity);
    trimOldest(latestModelByScope, capacity);
  }

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
      setRecent(selectionByScope, key, {
        selectedModel,
        previousModel: previousModel && previousModel !== selectedModel ? previousModel : "",
        updatedAt: timestamp,
      }, capacity);
      setRecent(latestModelByScope, key, { model: selectedModel, seenAt: timestamp }, capacity);
    }
    maintain(timestamp, true);
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
    maintain(timestamp);
    const selection = newestFreshSelection(keys, selectionByScope, timestamp, ttlMs);
    if (!selection) {
      observeRequest(keys, requestedModel, timestamp, latestModelByScope, capacity);
      return { changed: false, requestedModel };
    }
    setRecent(selectionByScope, selection.key, selection.value, capacity);

    const selectedModel = normalizedText(selection.value.selectedModel);
    const configured = new Set(
      Array.from(configuredModelIds || [], (value) => normalizedText(value)).filter(Boolean),
    );
    if (!selectedModel || (configured.size > 0 && !configured.has(selectedModel) &&
        !configured.has(canonicalModelReference(selectedModel)))) {
      observeRequest(keys, requestedModel, timestamp, latestModelByScope, capacity);
      return {
        changed: false,
        requestedModel,
        reason: "selected_model_not_configured",
      };
    }

    if (requestedModel === selectedModel) {
      observeRequest(keys, selectedModel, timestamp, latestModelByScope, capacity);
      return { changed: false, requestedModel, selectedModel, scope: selection.key };
    }

    const previousModel = normalizedText(selection.value.previousModel);
    const reconnect = Boolean(
      normalizedText(body?.previous_response_id) ||
      headerValue(headers, "x-codex-turn-state"),
    );
    if (requestedModel && requestedModel === previousModel && reconnect) {
      body.model = selectedModel;
      observeRequest(keys, selectedModel, timestamp, latestModelByScope, capacity);
      return {
        changed: true,
        requestedModel,
        selectedModel,
        previousModel,
        scope: selection.key,
        reason: "stale_reconnect_after_model_setting_change",
      };
    }

    observeRequest(keys, requestedModel, timestamp, latestModelByScope, capacity);
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
  const thread = scopeKey("thread", headerValue(headers, "x-codex-thread-id"));
  if (thread) {
    return [thread];
  }
  const window = scopeKey("window", headerValue(headers, "x-codex-window-id"));
  return window ? [window] : [];
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
  return text && text.length <= MAX_SCOPE_VALUE_CHARS ? `${kind}:${text}` : "";
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

function observeRequest(keys, model, timestamp, latestModels, capacity) {
  if (!model) {
    return;
  }
  for (const key of keys) {
    setRecent(latestModels, key, { model, seenAt: timestamp }, capacity);
  }
}

function setRecent(map, key, value, capacity) {
  map.delete(key);
  map.set(key, value);
  trimOldest(map, capacity);
}

function trimOldest(map, capacity) {
  while (map.size > capacity) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
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

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}
