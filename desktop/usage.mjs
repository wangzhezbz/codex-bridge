const START_RE =
  /\[(?<iso>\d{4}-\d\d-\d\dT[^\]]+)] (?<requestId>req_[a-z0-9]+) <- \/v1\/responses model=(?<codexModel>\S+) route=(?<route>\S+) api=(?<api>\S+) upstream_model=(?<upstreamModel>\S+) stream=(?<stream>\S+)/i;
const UPSTREAM_RE =
  /\[(?<iso>\d{4}-\d\d-\d\dT[^\]]+)] (?<requestId>req_[a-z0-9]+) -> upstream route=(?<route>\S+) api=(?<api>\S+) upstream_model=(?<upstreamModel>\S+) url=(?<url>\S+)/i;
const USAGE_RE =
  /\[(?<iso>\d{4}-\d\d-\d\dT[^\]]+)] (?<requestId>req_[a-z0-9]+) <- upstream route=(?<route>\S+) usage prompt=(?<promptTokens>\d+)(?: cached=(?<cacheReadTokens>\d+) fresh=(?<freshPromptTokens>\d+))?(?: cache_write=(?<cacheCreationTokens>\d+))? completion=(?<completionTokens>\d+) total=(?<totalTokens>\d+)/i;
const NO_USAGE_RE =
  /\[(?<iso>\d{4}-\d\d-\d\dT[^\]]+)] (?<requestId>req_[a-z0-9]+) <- upstream route=(?<route>\S+) usage=\(none\)/i;
const STATUS_RE =
  /\[(?<iso>\d{4}-\d\d-\d\dT[^\]]+)] (?<requestId>req_[a-z0-9]+) <- upstream route=(?<route>\S+) status=(?<status>\d+)/i;
const ERROR_RE =
  /\[(?<iso>\d{4}-\d\d-\d\dT[^\]]+)] (?<requestId>req_[a-z0-9]+) !! upstream route=(?<route>\S+) status=(?<status>\d+) error=(?<error>.*?)(?: error_type=(?<errorType>\S+))?(?: cause=(?<cause>.*?))?(?: body=.*)?$/i;
const LOCAL_GUARD_RE =
  /\[(?<iso>\d{4}-\d\d-\d\dT[^\]]+)] (?<requestId>req_[a-z0-9]+) !! (?:duplicate-request-guard|idle-resume-guard) route=(?<route>\S+)/i;

export function createUsageStore({ maxEvents = 800, initialEvents = [] } = {}) {
  const pending = new Map();
  let records = Array.isArray(initialEvents)
    ? initialEvents.map(normalizeEvent).filter(Boolean).slice(-maxEvents)
    : [];

  function recordLine(line) {
    const text = String(line || "");
    const start = START_RE.exec(text)?.groups;
    if (start) {
      pending.set(start.requestId, {
        requestId: start.requestId,
        startedAt: start.iso,
        finishedAt: "",
        codexModel: start.codexModel,
        route: start.route,
        api: start.api,
        upstreamModel: start.upstreamModel,
        upstreamUrl: "",
        stream: start.stream === "true",
        status: null,
        promptTokens: 0,
        freshPromptTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        error: "",
        errorType: "",
        errorCause: "",
        source: "router",
      });
      return;
    }

    const upstream = UPSTREAM_RE.exec(text)?.groups;
    if (upstream) {
      const item = ensurePending(upstream.requestId, upstream.iso, upstream.route);
      item.api = upstream.api || item.api;
      item.upstreamModel = upstream.upstreamModel || item.upstreamModel;
      item.upstreamUrl = upstream.url || item.upstreamUrl;
      return;
    }

    const usage = USAGE_RE.exec(text)?.groups;
    if (usage) {
      const item = ensurePending(usage.requestId, usage.iso, usage.route);
      item.finishedAt = usage.iso;
      item.status = item.status || 200;
      item.promptTokens = Number(usage.promptTokens || 0);
      item.cacheReadTokens = Number(usage.cacheReadTokens || 0);
      item.cacheCreationTokens = Number(usage.cacheCreationTokens || 0);
      item.freshPromptTokens = Number(
        usage.freshPromptTokens ?? Math.max(0, item.promptTokens - item.cacheReadTokens),
      );
      item.completionTokens = Number(usage.completionTokens || 0);
      item.totalTokens = Number(usage.totalTokens || 0);
      finalize(item);
      return;
    }

    const noUsage = NO_USAGE_RE.exec(text)?.groups;
    if (noUsage) {
      const item = ensurePending(noUsage.requestId, noUsage.iso, noUsage.route);
      item.finishedAt = noUsage.iso;
      item.status = item.status || 200;
      finalize(item);
      return;
    }

    const status = STATUS_RE.exec(text)?.groups;
    if (status) {
      const item = ensurePending(status.requestId, status.iso, status.route);
      item.finishedAt = status.iso;
      item.status = Number(status.status);
      if (Number(status.status) >= 400) {
        finalize(item);
      }
      return;
    }

    const error = ERROR_RE.exec(text)?.groups;
    if (error) {
      const item = ensurePending(error.requestId, error.iso, error.route);
      item.finishedAt = error.iso;
      item.status = Number(error.status || 599);
      item.error = error.error || "Unknown upstream error";
      item.errorType = error.errorType || "";
      item.errorCause = error.cause || "";
      finalize(item);
      return;
    }

    const localGuard = LOCAL_GUARD_RE.exec(text)?.groups;
    if (localGuard) {
      pending.delete(localGuard.requestId);
    }
  }

  function events() {
    return records.slice().reverse();
  }

  function summary(options = {}) {
    const activeRoutes = activeRouteMap(options.routes || options.models || []);
    const hasActiveRoutes = activeRoutes.size > 0;
    const byModelMap = new Map();
    const statusCounts = {};
    let totalTokens = 0;
    let promptTokens = 0;
    let freshPromptTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let completionTokens = 0;

    for (const event of records) {
      totalTokens += event.totalTokens || 0;
      promptTokens += event.promptTokens || 0;
      freshPromptTokens += event.freshPromptTokens ?? event.promptTokens ?? 0;
      cacheReadTokens += event.cacheReadTokens || 0;
      cacheCreationTokens += event.cacheCreationTokens || 0;
      completionTokens += event.completionTokens || 0;
      const statusKey = String(event.status || "unknown");
      statusCounts[statusKey] = (statusCounts[statusKey] || 0) + 1;

      const routeKey = event.route || event.codexModel || event.upstreamModel || "unknown";
      const upstreamKey = event.upstreamModel || "";
      const apiKey = event.api || "";
      const key = [routeKey, upstreamKey, apiKey].join("\u0000");
      if (!byModelMap.has(key)) {
        byModelMap.set(key, {
          route: event.route || routeKey,
          codexModel: event.codexModel || "",
          upstreamModel: event.upstreamModel || "",
          api: event.api || "",
          calls: 0,
          totalTokens: 0,
          promptTokens: 0,
          freshPromptTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          completionTokens: 0,
          errors: 0,
          fastZeroTokenErrors: 0,
          lastError: "",
          lastErrorType: "",
          lastErrorCause: "",
          lastAt: "",
          lastStatus: null,
        });
      }
      const item = byModelMap.get(key);
      item.calls += 1;
      item.totalTokens += event.totalTokens || 0;
      item.promptTokens += event.promptTokens || 0;
      item.freshPromptTokens += event.freshPromptTokens ?? event.promptTokens ?? 0;
      item.cacheReadTokens += event.cacheReadTokens || 0;
      item.cacheCreationTokens += event.cacheCreationTokens || 0;
      item.completionTokens += event.completionTokens || 0;
      item.errors += event.status && event.status >= 400 ? 1 : 0;
      item.fastZeroTokenErrors += isFastZeroTokenError(event) ? 1 : 0;
      item.lastError = event.error || item.lastError;
      item.lastErrorType = event.errorType || item.lastErrorType;
      item.lastErrorCause = event.errorCause || item.lastErrorCause;
      item.lastAt = event.finishedAt || event.startedAt || item.lastAt;
      item.lastStatus = event.status || item.lastStatus;
      item.codexModel = event.codexModel || item.codexModel;
      item.upstreamModel = event.upstreamModel || item.upstreamModel;
      item.api = event.api || item.api;
    }

    const byModel = [...byModelMap.values()].map((item) => {
      const active = activeRoutes.get(item.route) || activeRoutes.get(item.codexModel);
      const routeMatches =
        !hasActiveRoutes ||
        Boolean(
          active &&
            (!active.model || active.model === item.upstreamModel) &&
            (!active.api || active.api === item.api),
        );
      return {
        ...item,
        isCurrentRoute: hasActiveRoutes ? routeMatches : null,
        currentUpstreamModel: active?.model || "",
        currentApi: active?.api || "",
      };
    }).sort((a, b) => {
      if (a.isCurrentRoute !== b.isCurrentRoute) {
        return a.isCurrentRoute === true ? -1 : 1;
      }
      if (b.totalTokens !== a.totalTokens) {
        return b.totalTokens - a.totalTokens;
      }
      return b.calls - a.calls;
    });
    const currentByModel = byModel.filter((item) => item.isCurrentRoute !== false);
    const historyByModel = byModel.filter((item) => item.isCurrentRoute === false);
    const currentEvents = [];
    const historyEvents = [];
    for (const event of records) {
      if (eventMatchesActiveRoute(event, activeRoutes, hasActiveRoutes)) {
        currentEvents.push(event);
      } else {
        historyEvents.push(event);
      }
    }
    const current = {
      ...totalsForEvents(currentEvents),
      byModel: currentByModel,
      events: currentEvents.slice().reverse(),
    };
    const history = {
      ...totalsForEvents(historyEvents),
      byModel: historyByModel,
      events: historyEvents.slice().reverse(),
    };

    return {
      totalCalls: records.length,
      totalTokens,
      promptTokens,
      freshPromptTokens,
      cacheReadTokens,
      cacheCreationTokens,
      completionTokens,
      statusCounts,
      byModel,
      latest: records.at(-1) || null,
      current,
      history,
    };
  }

  function ensurePending(requestId, iso, route) {
    if (!pending.has(requestId)) {
      pending.set(requestId, {
        requestId,
        startedAt: iso,
        finishedAt: "",
        codexModel: route || "",
        route: route || "",
        api: "",
        upstreamModel: "",
        upstreamUrl: "",
        stream: false,
        status: null,
        promptTokens: 0,
        completionTokens: 0,
        freshPromptTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 0,
        error: "",
        errorType: "",
        errorCause: "",
        source: "router",
      });
    }
    return pending.get(requestId);
  }

  function finalize(item) {
    const record = {
      ...item,
      durationMs: durationMs(item.startedAt, item.finishedAt),
    };
    records = records.filter((event) => event.requestId !== record.requestId);
    records.push(record);
    records = records.slice(-maxEvents);
    pending.delete(record.requestId);
  }

  return {
    recordLine,
    events,
    summary,
  };
}

function activeRouteMap(routes = []) {
  const result = new Map();
  if (!Array.isArray(routes)) {
    return result;
  }
  for (const route of routes) {
    if (!route || typeof route !== "object") {
      continue;
    }
    const item = {
      id: String(route.id || route.model || ""),
      model: String(route.model || ""),
      api: String(route.api || ""),
    };
    if (item.id) {
      result.set(item.id, item);
    }
  }
  return result;
}

function normalizeEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }
  return {
    requestId: String(event.requestId || ""),
    startedAt: String(event.startedAt || event.finishedAt || ""),
    finishedAt: String(event.finishedAt || event.startedAt || ""),
    codexModel: String(event.codexModel || ""),
    route: String(event.route || event.codexModel || ""),
    api: String(event.api || ""),
    upstreamModel: String(event.upstreamModel || ""),
    upstreamUrl: String(event.upstreamUrl || ""),
    stream: Boolean(event.stream),
    status: Number.isFinite(Number(event.status)) ? Number(event.status) : null,
    promptTokens: Number(event.promptTokens || 0),
    freshPromptTokens: Number(event.freshPromptTokens ?? event.promptTokens ?? 0),
    cacheReadTokens: Number(event.cacheReadTokens || 0),
    cacheCreationTokens: Number(event.cacheCreationTokens || 0),
    completionTokens: Number(event.completionTokens || 0),
    totalTokens: Number(event.totalTokens || 0),
    durationMs: Number.isFinite(Number(event.durationMs)) ? Number(event.durationMs) : null,
    error: String(event.error || ""),
    errorType: String(event.errorType || ""),
    errorCause: String(event.errorCause || ""),
    source: String(event.source || "router"),
  };
}

function eventMatchesActiveRoute(event, activeRoutes, hasActiveRoutes) {
  if (!hasActiveRoutes) {
    return true;
  }
  const active = activeRoutes.get(event.route) || activeRoutes.get(event.codexModel);
  return Boolean(
    active &&
      (!active.model || active.model === event.upstreamModel) &&
      (!active.api || active.api === event.api),
  );
}

function totalsForEvents(events = []) {
  const statusCounts = {};
  let totalTokens = 0;
  let promptTokens = 0;
  let freshPromptTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let completionTokens = 0;
  for (const event of events) {
    totalTokens += event.totalTokens || 0;
    promptTokens += event.promptTokens || 0;
    freshPromptTokens += event.freshPromptTokens ?? event.promptTokens ?? 0;
    cacheReadTokens += event.cacheReadTokens || 0;
    cacheCreationTokens += event.cacheCreationTokens || 0;
    completionTokens += event.completionTokens || 0;
    const statusKey = String(event.status || "unknown");
    statusCounts[statusKey] = (statusCounts[statusKey] || 0) + 1;
  }
  return {
    totalCalls: events.length,
    totalTokens,
    promptTokens,
    freshPromptTokens,
    cacheReadTokens,
    cacheCreationTokens,
    completionTokens,
    statusCounts,
    latest: events.at(-1) || null,
  };
}

function durationMs(startedAt, finishedAt) {
  const start = Date.parse(startedAt);
  const finish = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish)) {
    return null;
  }
  return Math.max(0, finish - start);
}

function isFastZeroTokenError(event = {}) {
  return (
    Number(event.status || 0) >= 400 &&
    Number(event.totalTokens || 0) === 0 &&
    Number.isFinite(Number(event.durationMs)) &&
    Number(event.durationMs) < 1000
  );
}
