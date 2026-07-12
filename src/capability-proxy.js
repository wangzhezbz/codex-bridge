export async function runCapabilityProxy(options = {}) {
  const capability = normalizeText(options.capability) || "capability";
  const providers = plainObjectArray(options.providers);
  let provider = plainObject(options.provider);
  let request = plainObject(options.request);
  const context = plainObject(options.context);
  const clock = typeof options.clock === "function" ? options.clock : Date.now;
  const startedAt = safeTimestamp(clock);
  const trace = [];
  let phase = "detectRequest";
  let upstream = null;
  let savedResult = null;
  let response = null;
  let historyItem = null;

  try {
    const runPhase = (name, fn) => {
      phase = name;
      return runTracedPhase(trace, name, fn);
    };

    if (typeof options.detectRequest === "function") {
      const detected = await runPhase("detectRequest", () => options.detectRequest({
        capability,
        provider,
        providers,
        request,
        context,
      }));
      if (!isDetectedRequest(detected)) {
        const reason = detectionReason(detected);
        markLastTraceSkipped(trace, reason);
        return skippedResult({
          capability,
          request,
          reason,
          startedAt,
          clock,
          trace,
        });
      }
      if (detected && typeof detected === "object" && !Array.isArray(detected)) {
        request = plainObject(detected);
      }
    }

    if (typeof options.selectProvider === "function") {
      provider = await runPhase("selectProvider", async () => {
        const selectedProvider = await options.selectProvider({
          capability,
          provider,
          providers,
          request,
          context,
        });
        const normalizedProvider = plainObject(selectedProvider);
        if (!Object.keys(normalizedProvider).length) {
          throw missingCapabilityProviderError(capability);
        }
        return normalizedProvider;
      });
    }

    const execute = options.execute;
    const buildResponse = options.buildResponse;

    if (typeof execute !== "function") {
      throw new Error(`${capabilityDisplayName(capability)} 能力代理缺少执行器配置。`);
    }
    if (typeof buildResponse !== "function") {
      throw new Error(`${capabilityDisplayName(capability)} 能力代理缺少响应构造器配置。`);
    }

    upstream = await runPhase("execute", () => execute({
      capability,
      provider,
      providers,
      request,
      context,
    }));
    savedResult = typeof options.saveResult === "function"
      ? await runPhase("saveResult", () => options.saveResult({
        capability,
        provider,
        request,
        context,
        upstream,
      }))
      : null;
    const durationMs = Math.max(0, Math.round(safeTimestamp(clock) - startedAt));
    response = await runPhase("buildResponse", () => buildResponse({
      capability,
      provider,
      request,
      context,
      upstream,
      savedResult,
      durationMs,
    }));
    historyItem = typeof options.recordHistory === "function"
      ? await runPhase("recordHistory", () => options.recordHistory({
        capability,
        provider,
        request,
        context,
        upstream,
        savedResult,
        response,
        durationMs,
      }))
      : null;
    return {
      handled: true,
      skipped: false,
      failed: false,
      capability,
      providerId: normalizeText(provider.id || provider.providerId),
      providerName: normalizeText(provider.displayName || provider.name || provider.id),
      request,
      upstream,
      savedResult,
      response,
      durationMs,
      historyItem,
      trace,
    };
  } catch (error) {
    return handleCapabilityFailure(error, {
      options,
      phase,
      capability,
      provider,
      providers,
      request,
      context,
      upstream,
      savedResult,
      startedAt,
      clock,
      trace,
    });
  }
}

export function createCapabilityProviderRegistry(providers = [], options = {}) {
  const defaultCapability = normalizeText(options.capability || options.defaultCapability);
  const normalizedProviders = plainObjectArray(providers)
    .map((provider, index) => normalizeCapabilityProvider(provider, { defaultCapability, index }))
    .filter(Boolean);
  const providersById = new Map();
  for (const provider of normalizedProviders) {
    if (!providersById.has(provider.id)) {
      providersById.set(provider.id, provider);
    }
  }
  const orderedProviders = [...providersById.values()].sort(compareCapabilityProviders);

  const registry = {
    providers: orderedProviders,
    list(capability = "", listOptions = {}) {
      const targetCapability = normalizeText(capability);
      const includeDisabled = Boolean(listOptions.includeDisabled);
      return orderedProviders
        .filter((provider) => {
          if (!includeDisabled && !provider.enabled) {
            return false;
          }
          return providerSupportsCapability(provider, targetCapability);
        })
        .sort((left, right) => compareCapabilityProvidersForCapability(left, right, targetCapability));
    },
    byId(providerId, capability = "") {
      const provider = providersById.get(normalizeText(providerId));
      if (!provider || !provider.enabled) {
        return null;
      }
      return providerSupportsCapability(provider, normalizeText(capability)) ? provider : null;
    },
    select(capability = "", request = {}) {
      const targetCapability = normalizeText(capability);
      const requested = plainObject(request);
      const preferredProviderId = normalizeText(
        requested.providerId ||
          requested.preferredProviderId ||
          requested.capabilityProviderId,
      );
      if (preferredProviderId) {
        return registry.byId(preferredProviderId, targetCapability);
      }
      const candidates = registry.list(targetCapability);
      return candidates.find((provider) => providerIsDefaultForCapability(provider, targetCapability)) ||
        candidates[0] ||
        null;
    },
    summary() {
      const capabilities = {};
      for (const provider of orderedProviders) {
        if (!provider.enabled) {
          continue;
        }
        for (const capability of provider.capabilities) {
          capabilities[capability] = (capabilities[capability] || 0) + 1;
        }
      }
      return {
        total: orderedProviders.filter((provider) => provider.enabled).length,
        capabilities,
      };
    },
    groups(groupOptions = {}) {
      return groupCapabilityProviders(orderedProviders, groupOptions);
    },
  };
  return registry;
}

export function groupCapabilityProviders(providers = [], options = {}) {
  const defaultCapability = normalizeText(options.capability || options.defaultCapability);
  const normalizedProviders = plainObjectArray(providers)
    .map((provider, index) => normalizeCapabilityProvider(provider, { defaultCapability, index }))
    .filter(Boolean)
    .sort(compareCapabilityProviders);
  const capabilityOrder = uniqueTextValues([
    ...(Array.isArray(options.knownCapabilities) ? options.knownCapabilities : []),
    ...normalizedProviders.flatMap((provider) => provider.capabilities),
  ]);
  const includeEmpty = Boolean(options.includeEmpty);
  const includeDisabled = Boolean(options.includeDisabled);
  const groups = [];

  for (const capability of capabilityOrder) {
    const capabilityProviders = normalizedProviders.filter((provider) =>
      providerSupportsCapability(provider, capability),
    ).sort((left, right) => compareCapabilityProvidersForCapability(left, right, capability));
    const visibleProviders = includeDisabled
      ? capabilityProviders
      : capabilityProviders.filter((provider) => provider.enabled);
    if (!includeEmpty && !visibleProviders.length) {
      continue;
    }
    const enabledProviders = capabilityProviders.filter((provider) => provider.enabled);
    const defaultProvider = enabledProviders.find((provider) =>
      providerIsDefaultForCapability(provider, capability),
    ) || null;
    groups.push({
      capability,
      providers: visibleProviders,
      enabledCount: enabledProviders.length,
      disabledCount: capabilityProviders.length - enabledProviders.length,
      defaultProviderId: defaultProvider?.id || "",
      backupCount: Math.max(0, enabledProviders.length - (defaultProvider ? 1 : 0)),
    });
  }

  return groups;
}

export function normalizeCapabilityProvider(provider = {}, options = {}) {
  const source = plainObject(provider);
  const id = normalizeText(source.id || source.providerId);
  if (!id) {
    return null;
  }
  const capabilities = uniqueTextValues([
    source.capability,
    ...(Array.isArray(source.capabilities) ? source.capabilities : []),
    ...(Array.isArray(source.supports) ? source.supports : []),
    options.defaultCapability,
  ]);
  if (!capabilities.length) {
    return null;
  }
  const priority = Number(source.priority);
  const defaultCapabilities = uniqueTextValues([
    ...(Array.isArray(source.defaultCapabilities) ? source.defaultCapabilities : []),
    ...(Array.isArray(source.defaultFor) ? source.defaultFor : []),
  ]).filter((capability) => capabilities.includes(capability));
  return {
    ...source,
    id,
    providerId: normalizeText(source.providerId || id),
    displayName: normalizeText(source.displayName || source.name || id),
    name: normalizeText(source.name || source.displayName || id),
    capability: capabilities[0],
    capabilities,
    enabled: source.enabled !== false,
    default: Boolean(source.default || source.isDefault || defaultCapabilities.length),
    defaultCapabilities,
    priority: Number.isFinite(priority) ? priority : 0,
    index: Number.isFinite(Number(options.index)) ? Number(options.index) : 0,
  };
}

async function handleCapabilityFailure(error, {
  options,
  phase,
  capability,
  provider,
  providers,
  request,
  context,
  upstream,
  savedResult,
  startedAt,
  clock,
  trace = [],
}) {
  if (typeof options.buildErrorResponse !== "function") {
    throw error;
  }
  const durationMs = Math.max(0, Math.round(safeTimestamp(clock) - startedAt));
  const normalizedError = normalizeCapabilityError(error);
  const response = await runTracedPhase(trace, "buildErrorResponse", () => options.buildErrorResponse({
    capability,
    provider,
    providers,
    request,
    context,
    upstream,
    savedResult,
    error,
    normalizedError,
    phase,
    durationMs,
  }));
  const historyItem = typeof options.recordHistory === "function"
    ? await runTracedPhase(trace, "recordHistory", () => options.recordHistory({
      capability,
      provider,
      request,
      context,
      upstream,
      savedResult,
      response,
      error,
      normalizedError,
      failed: true,
      errorPhase: phase,
      durationMs,
    }))
    : null;

  return {
    handled: true,
    skipped: false,
    failed: true,
    capability,
    providerId: normalizeText(provider.id || provider.providerId),
    providerName: normalizeText(provider.displayName || provider.name || provider.id),
    request,
    upstream,
    savedResult,
    response,
    durationMs,
    historyItem,
    errorPhase: phase,
    error: normalizedError,
    trace,
  };
}

function isDetectedRequest(value) {
  if (value === false || value == null) {
    return false;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value.handled !== false && value.detected !== false;
  }
  return true;
}

function detectionReason(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return normalizeText(value.reason) || "not_detected";
  }
  return "not_detected";
}

function skippedResult({ capability, request, reason, startedAt, clock, trace = [] }) {
  return {
    handled: false,
    skipped: true,
    reason,
    capability,
    providerId: "",
    providerName: "",
    request,
    upstream: null,
    savedResult: null,
    response: null,
    durationMs: Math.max(0, Math.round(safeTimestamp(clock) - startedAt)),
    historyItem: null,
    trace,
  };
}

async function runTracedPhase(trace, phase, fn) {
  const startedAt = Date.now();
  try {
    const value = await fn();
    trace.push({
      phase,
      status: "ok",
      startedAt,
      durationMs: Math.max(0, Date.now() - startedAt),
    });
    return value;
  } catch (error) {
    trace.push({
      phase,
      status: "failed",
      startedAt,
      durationMs: Math.max(0, Date.now() - startedAt),
      error: normalizeCapabilityError(error),
    });
    throw error;
  }
}

function markLastTraceSkipped(trace, reason) {
  const last = trace[trace.length - 1];
  if (!last) {
    return;
  }
  last.status = "skipped";
  last.reason = reason;
}

function safeTimestamp(clock) {
  const value = Number(clock());
  return Number.isFinite(value) ? value : Date.now();
}

function normalizeText(value) {
  return String(value || "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function plainObjectArray(value) {
  return Array.isArray(value) ? value.map(plainObject).filter((item) => Object.keys(item).length) : [];
}

function providerSupportsCapability(provider = {}, capability = "") {
  const targetCapability = normalizeText(capability);
  if (!targetCapability) {
    return true;
  }
  return Array.isArray(provider.capabilities) && provider.capabilities.includes(targetCapability);
}

function providerIsDefaultForCapability(provider = {}, capability = "") {
  const targetCapability = normalizeText(capability);
  const defaults = Array.isArray(provider.defaultCapabilities)
    ? provider.defaultCapabilities.map(normalizeText).filter(Boolean)
    : [];
  if (defaults.length) {
    return defaults.includes(targetCapability);
  }
  return Boolean(provider.default);
}

function compareCapabilityProviders(left, right) {
  if (Boolean(left.default) !== Boolean(right.default)) {
    return left.default ? -1 : 1;
  }
  if (Number(left.priority || 0) !== Number(right.priority || 0)) {
    return Number(right.priority || 0) - Number(left.priority || 0);
  }
  return Number(left.index || 0) - Number(right.index || 0);
}

function compareCapabilityProvidersForCapability(left, right, capability = "") {
  const leftDefault = providerIsDefaultForCapability(left, capability);
  const rightDefault = providerIsDefaultForCapability(right, capability);
  if (leftDefault !== rightDefault) {
    return leftDefault ? -1 : 1;
  }
  if (Number(left.priority || 0) !== Number(right.priority || 0)) {
    return Number(right.priority || 0) - Number(left.priority || 0);
  }
  return Number(left.index || 0) - Number(right.index || 0);
}

function uniqueTextValues(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = normalizeText(value);
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    result.push(text);
  }
  return result;
}

function normalizeCapabilityError(error) {
  const statusCode = Number(error?.statusCode || error?.status || 0);
  const code = normalizeText(error?.code || error?.errorCode || error?.type);
  const message = normalizeText(error?.message) || "能力执行失败。";
  const detail = normalizeText(error?.bodyText || error?.body || error?.responseText || error?.detail);
  const retryAfter = normalizeText(error?.retryAfter || error?.retry_after);
  return {
    message,
    ...(statusCode ? { statusCode } : {}),
    ...(code ? { code } : {}),
    ...(detail ? { detail } : {}),
    ...(retryAfter ? { retryAfter } : {}),
  };
}

function missingCapabilityProviderError(capability) {
  const label = capabilityDisplayName(capability);
  const error = new Error(
    `没有可用的 ${label} 能力供应商。请先在能力页添加并启用供应商，或检查本次请求指定的供应商是否仍然可用。`,
  );
  error.code = "missing_capability_provider";
  return error;
}

function capabilityDisplayName(capability) {
  const normalized = normalizeText(capability);
  return {
    image_generation: "图片生成",
    ocr: "OCR",
    web_search: "搜索",
    browser: "浏览器",
    webpage_screenshot: "网页截图",
    computer_use: "Computer Use",
    file_processing: "文件处理",
    speech: "语音",
    video: "视频",
  }[normalized] || normalized || "当前";
}
