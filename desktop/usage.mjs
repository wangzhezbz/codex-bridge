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
const SMART_ROUTE_EXCLUSIONS_RE =
  /\[(?<iso>\d{4}-\d\d-\d\dT[^\]]+)] (?<requestId>req_[a-z0-9]+) !! smart-route-exclusions phase=(?<phase>\S+) excluded=(?<excluded>.*)$/i;
const ROUTE_PLAN_RE =
  /\[(?<iso>\d{4}-\d\d-\d\dT[^\]]+)] (?<requestId>req_[a-z0-9]+) !! route-plan kind=(?<requestKind>\S+) reason=(?<routeReason>\S+) requested_model=(?<requestedModel>\S+) route=(?<route>\S+)/i;

export function createUsageStore({ maxEvents = 800, initialEvents = [] } = {}) {
  const pending = new Map();
  let records = Array.isArray(initialEvents)
    ? initialEvents.map(normalizeEvent).filter(Boolean).slice(-maxEvents)
    : [];

  function recordLine(line) {
    const text = String(line || "");
    const routePlan = ROUTE_PLAN_RE.exec(text)?.groups;
    if (routePlan) {
      const item = ensurePending(routePlan.requestId, routePlan.iso, routePlan.route);
      item.requestKind = routePlan.requestKind;
      item.routeReason = routePlan.routeReason;
      item.requestedModel = routePlan.requestedModel === "(default)" ? "" : routePlan.requestedModel;
      item.routeSource = routePlan.requestKind === "codex_auxiliary"
        ? "auxiliary"
        : routePlan.routeReason && routePlan.routeReason !== "manual_route"
          ? "automatic"
          : "manual";
      return;
    }
    const start = START_RE.exec(text)?.groups;
    if (start) {
      const previous = pending.get(start.requestId) || {};
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
        smartRouteExclusions: Array.isArray(previous.smartRouteExclusions)
          ? previous.smartRouteExclusions
          : [],
        requestKind: previous.requestKind || "normal",
        routeReason: previous.routeReason || "manual_route",
        requestedModel: previous.requestedModel || start.codexModel,
        routeSource: previous.routeSource || "manual",
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
      return;
    }

    const smartRouteExclusions = SMART_ROUTE_EXCLUSIONS_RE.exec(text)?.groups;
    if (smartRouteExclusions) {
      const item = ensurePending(
        smartRouteExclusions.requestId,
        smartRouteExclusions.iso,
        "",
      );
      item.smartRouteExclusions = [
        ...(Array.isArray(item.smartRouteExclusions) ? item.smartRouteExclusions : []),
        ...parseSmartRouteExclusions(
          smartRouteExclusions.excluded,
          smartRouteExclusions.phase,
        ),
      ];
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
        smartRouteExclusions: [],
        requestKind: "normal",
        routeReason: "manual_route",
        requestedModel: "",
        routeSource: "manual",
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

export function evaluateUsageBudgets(summary = {}, budgets = {}, { routes = [], now = new Date() } = {}) {
  const budgetConfig = normalizeBudgetConfig(budgets);
  if (!budgetConfig) {
    return [];
  }
  const routeProviders = routeProviderMap(routes);
  const events = todayUsageEvents(summary, now);
  const globalMetrics = usageMetrics(events);
  const alerts = [];
  const globalAlert = budgetAlert("global", "全部模型", globalMetrics, budgetConfig.global);
  if (globalAlert) {
    alerts.push(globalAlert);
  }

  const eventsByRoute = groupEvents(events, (event) => event.route || event.codexModel || "");
  for (const [route, routeBudget] of Object.entries(budgetConfig.routes)) {
    const alert = budgetAlert("route", route, usageMetrics(eventsByRoute.get(route) || []), routeBudget);
    if (alert) {
      alerts.push(alert);
    }
  }

  const eventsByProvider = groupEvents(events, (event) => {
    const route = event.route || event.codexModel || "";
    return routeProviders.get(route) || "";
  });
  for (const [provider, providerBudget] of Object.entries(budgetConfig.providers)) {
    const alert = budgetAlert("provider", provider, usageMetrics(eventsByProvider.get(provider) || []), providerBudget);
    if (alert) {
      alerts.push(alert);
    }
  }

  return alerts.sort((left, right) => severityRank(right.status) - severityRank(left.status));
}

export function estimateUsageCosts(summary = {}, budgets = {}, { routes = [], now = new Date() } = {}) {
  const budgetConfig = normalizeBudgetConfig(budgets);
  if (!budgetConfig) {
    return emptyCostEstimate();
  }
  const routeProviders = routeProviderMap(routes);
  const events = todayUsageEvents(summary, now);
  const global = costEstimate("global", "全部模型", usageMetrics(events), budgetConfig.global);
  const routeEstimates = [];
  const providerEstimates = [];

  const eventsByRoute = groupEvents(events, (event) => event.route || event.codexModel || "");
  for (const [route, routeBudget] of Object.entries(budgetConfig.routes)) {
    const estimate = costEstimate("route", route, usageMetrics(eventsByRoute.get(route) || []), routeBudget);
    if (estimate) {
      routeEstimates.push(estimate);
    }
  }

  const eventsByProvider = groupEvents(events, (event) => {
    const route = event.route || event.codexModel || "";
    return routeProviders.get(route) || "";
  });
  for (const [provider, providerBudget] of Object.entries(budgetConfig.providers)) {
    const estimate = costEstimate("provider", provider, usageMetrics(eventsByProvider.get(provider) || []), providerBudget);
    if (estimate) {
      providerEstimates.push(estimate);
    }
  }

  const explicitTotal = routeEstimates.length
    ? sumCostEstimates(routeEstimates)
    : providerEstimates.length
      ? sumCostEstimates(providerEstimates)
      : global || emptyCostEstimate();

  return {
    ...explicitTotal,
    hasRates: Boolean(global || routeEstimates.length || providerEstimates.length),
    global,
    routes: routeEstimates.sort((left, right) => right.totalCost - left.totalCost),
    providers: providerEstimates.sort((left, right) => right.totalCost - left.totalCost),
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

function routeProviderMap(routes = []) {
  const result = new Map();
  if (!Array.isArray(routes)) {
    return result;
  }
  for (const route of routes) {
    if (!route || typeof route !== "object") {
      continue;
    }
    const id = String(route.id || route.model || "");
    const provider = String(route.provider || route.providerId || route.provider_id || "").trim();
    if (id && provider) {
      result.set(id, provider);
    }
  }
  return result;
}

function normalizeBudgetConfig(input) {
  if (!input || typeof input !== "object") {
    return null;
  }
  const global = normalizeBudgetScope(input.global || {});
  const routes = normalizeBudgetScopes(input.routes);
  const providers = normalizeBudgetScopes(input.providers);
  if (!hasBudgetSettings(global) && !Object.keys(routes).length && !Object.keys(providers).length) {
    return null;
  }
  return { global, routes, providers };
}

function normalizeBudgetScopes(input) {
  const result = {};
  if (!input || typeof input !== "object") {
    return result;
  }
  for (const [key, value] of Object.entries(input)) {
    const scope = normalizeBudgetScope(value);
    if (key && hasBudgetSettings(scope)) {
      result[String(key)] = scope;
    }
  }
  return result;
}

function normalizeBudgetScope(input = {}) {
  return {
    dailyTokenLimit: positiveNumber(input.dailyTokenLimit ?? input.daily_tokens ?? input.tokens),
    dailyCallLimit: positiveNumber(input.dailyCallLimit ?? input.daily_calls ?? input.calls),
    dailyCostLimit: positiveNumber(input.dailyCostLimit ?? input.daily_cost_limit ?? input.daily_cost ?? input.cost),
    inputCostPerMillion: positiveNumber(input.inputCostPerMillion ?? input.input_cost_per_million),
    cacheCostPerMillion: positiveNumber(input.cacheCostPerMillion ?? input.cache_cost_per_million),
    outputCostPerMillion: positiveNumber(input.outputCostPerMillion ?? input.output_cost_per_million),
  };
}

function hasBudgetLimits(scope = {}) {
  return Boolean(scope.dailyTokenLimit || scope.dailyCallLimit || scope.dailyCostLimit);
}

function hasCostRates(scope = {}) {
  return Boolean(scope.inputCostPerMillion || scope.cacheCostPerMillion || scope.outputCostPerMillion);
}

function hasBudgetSettings(scope = {}) {
  return hasBudgetLimits(scope) || hasCostRates(scope);
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function todayUsageEvents(summary = {}, now = new Date()) {
  const events = Array.isArray(summary?.current?.events)
    ? summary.current.events
    : Array.isArray(summary.events)
      ? summary.events
      : [];
  const today = localDayKey(now);
  if (!today) {
    return events;
  }
  return events.filter((event) => localDayKey(event.finishedAt || event.startedAt) === today);
}

function localDayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function usageMetrics(events = []) {
  return {
    calls: events.length,
    tokens: events.reduce((sum, event) => sum + Number(event.totalTokens || 0), 0),
    freshPromptTokens: events.reduce((sum, event) => sum + Number(event.freshPromptTokens ?? event.promptTokens ?? 0), 0),
    cacheReadTokens: events.reduce((sum, event) => sum + Number(event.cacheReadTokens || 0), 0),
    cacheCreationTokens: events.reduce((sum, event) => sum + Number(event.cacheCreationTokens || 0), 0),
    completionTokens: events.reduce((sum, event) => sum + Number(event.completionTokens || 0), 0),
  };
}

function groupEvents(events = [], keyFn) {
  const groups = new Map();
  for (const event of events) {
    const key = String(keyFn(event) || "");
    if (!key) {
      continue;
    }
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(event);
  }
  return groups;
}

function budgetAlert(scope, label, metrics = {}, budget = {}) {
  if (!hasBudgetLimits(budget)) {
    return null;
  }
  const checks = [
    budgetMetricAlert("tokens", "Token", metrics.tokens || 0, budget.dailyTokenLimit),
    budgetMetricAlert("calls", "请求", metrics.calls || 0, budget.dailyCallLimit),
    budgetCostAlert(metrics, budget),
  ].filter(Boolean);
  const active = checks
    .filter((check) => check.status)
    .sort((left, right) => severityRank(right.status) - severityRank(left.status))[0];
  if (!active) {
    return null;
  }
  return {
    scope,
    label,
    status: active.status,
    metric: active.metric,
    used: active.used,
    limit: active.limit,
    remaining: active.remaining,
    ratio: active.ratio,
    message: `${label} 今日${active.name}已用 ${active.used} / ${active.limit}，已用比例 ${formatBudgetRatio(active.ratio)}，剩余 ${active.remaining} ${active.unit}，${active.status === "exceeded" ? "已超限" : "接近上限"}。`,
  };
}

function formatBudgetRatio(ratio) {
  const number = Number(ratio || 0);
  if (!Number.isFinite(number) || number <= 0) {
    return "0%";
  }
  return `${Math.round(number * 100)}%`;
}

function budgetMetricAlert(metric, name, used, limit) {
  if (!limit) {
    return null;
  }
  const ratio = used / limit;
  const remaining = Math.max(0, limit - used);
  const unit = metric === "calls" ? "次请求" : metric === "cost" ? "费用单位" : "Token";
  const normalizedUsed = metric === "cost" ? roundBudgetCost(used) : used;
  const normalizedLimit = metric === "cost" ? roundBudgetCost(limit) : limit;
  const normalizedRemaining = metric === "cost" ? roundBudgetCost(remaining) : remaining;
  if (ratio > 1) {
    return {
      metric,
      name,
      used: normalizedUsed,
      limit: normalizedLimit,
      remaining: normalizedRemaining,
      unit,
      ratio,
      status: "exceeded",
    };
  }
  if (ratio >= 0.8) {
    return {
      metric,
      name,
      used: normalizedUsed,
      limit: normalizedLimit,
      remaining: normalizedRemaining,
      unit,
      ratio,
      status: "warning",
    };
  }
  return null;
}

function budgetCostAlert(metrics = {}, budget = {}) {
  if (!budget.dailyCostLimit || !hasCostRates(budget)) {
    return null;
  }
  const estimate = costEstimate("scope", "label", metrics, budget);
  return budgetMetricAlert("cost", "费用", estimate?.totalCost || 0, budget.dailyCostLimit);
}

function costEstimate(scope, label, metrics = {}, rates = {}) {
  if (!hasCostRates(rates)) {
    return null;
  }
  const inputCost = costForTokens(metrics.freshPromptTokens, rates.inputCostPerMillion);
  const cacheTokens = Number(metrics.cacheReadTokens || 0) + Number(metrics.cacheCreationTokens || 0);
  const cacheRate = rates.cacheCostPerMillion || rates.inputCostPerMillion || 0;
  const cacheCost = costForTokens(cacheTokens, cacheRate);
  const outputCost = costForTokens(metrics.completionTokens, rates.outputCostPerMillion);
  return {
    scope,
    label,
    calls: Number(metrics.calls || 0),
    tokens: Number(metrics.tokens || 0),
    inputCost,
    cacheCost,
    outputCost,
    totalCost: inputCost + cacheCost + outputCost,
  };
}

function costForTokens(tokens, costPerMillion) {
  return (Number(tokens || 0) / 1_000_000) * Number(costPerMillion || 0);
}

function roundBudgetCost(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 1_000_000) / 1_000_000 : 0;
}

function sumCostEstimates(estimates = []) {
  return estimates.reduce((total, item) => ({
    calls: total.calls + Number(item.calls || 0),
    tokens: total.tokens + Number(item.tokens || 0),
    inputCost: total.inputCost + Number(item.inputCost || 0),
    cacheCost: total.cacheCost + Number(item.cacheCost || 0),
    outputCost: total.outputCost + Number(item.outputCost || 0),
    totalCost: total.totalCost + Number(item.totalCost || 0),
  }), emptyCostEstimate());
}

function emptyCostEstimate() {
  return {
    hasRates: false,
    calls: 0,
    tokens: 0,
    inputCost: 0,
    cacheCost: 0,
    outputCost: 0,
    totalCost: 0,
    global: null,
    routes: [],
    providers: [],
  };
}

function severityRank(status) {
  if (status === "exceeded") {
    return 2;
  }
  if (status === "warning") {
    return 1;
  }
  return 0;
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
    smartRouteExclusions: normalizeSmartRouteExclusions(event.smartRouteExclusions),
    source: String(event.source || "router"),
  };
}

function parseSmartRouteExclusions(excluded, phase) {
  const normalizedPhase = String(phase || "").trim();
  return String(excluded || "")
    .split(",")
    .map((entry) => {
      const [routePart, reasonsPart = ""] = String(entry || "").split(":");
      const route = routePart.trim();
      if (!route) {
        return null;
      }
      return {
        phase: normalizedPhase,
        route,
        reasons: reasonsPart
          .split("+")
          .map((reason) => reason.trim())
          .filter(Boolean),
      };
    })
    .filter(Boolean);
}

function normalizeSmartRouteExclusions(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      const route = String(item?.route || "").trim();
      if (!route) {
        return null;
      }
      return {
        phase: String(item?.phase || "").trim(),
        route,
        reasons: Array.isArray(item?.reasons)
          ? item.reasons.map((reason) => String(reason || "").trim()).filter(Boolean)
          : [],
      };
    })
    .filter(Boolean);
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
