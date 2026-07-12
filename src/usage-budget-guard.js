export function usageBudgetOptions(config = {}) {
  const source = config.usageBudgets && typeof config.usageBudgets === "object"
    ? config.usageBudgets
    : {};
  const global = normalizeScope(source.global);
  const routes = normalizeScopeMap(source.routes);
  const providers = normalizeScopeMap(source.providers);
  if (!hasLimits(global) && !Object.keys(routes).length && !Object.keys(providers).length) {
    return null;
  }
  return { global, routes, providers };
}

export function createUsageBudgetGuard({ now = () => new Date() } = {}) {
  const counters = new Map();

  function check(config = {}, route = {}) {
    const budgets = usageBudgetOptions(config);
    if (!budgets) {
      return { ok: true };
    }
    const day = localDayKey(now());
    const candidates = budgetCandidates(budgets, route);
    for (const candidate of candidates) {
      const counter = counters.get(counterKey(day, candidate.scope, candidate.id)) || zeroCounter();
      const blocked = blockedByBudget(candidate, counter);
      if (blocked) {
        return {
          ok: false,
          day,
          scope: candidate.scope,
          id: candidate.id,
          label: candidate.label,
          metric: blocked.metric,
          used: blocked.used,
          limit: blocked.limit,
          remaining: blocked.remaining,
          unit: blocked.unit,
          routeId: route.id || route.model || "",
          provider: providerId(route),
        };
      }
    }
    return { ok: true };
  }

  function recordUsage(config = {}, route = {}, usage = {}) {
    const budgets = usageBudgetOptions(config);
    if (!budgets) {
      return;
    }
    const day = localDayKey(now());
    const tokens = usageTokens(usage);
    const candidates = budgetCandidates(budgets, route);
    for (const candidate of candidates) {
      const key = counterKey(day, candidate.scope, candidate.id);
      const counter = counters.get(key) || zeroCounter();
      counter.calls += 1;
      counter.tokens += tokens;
      counter.cost += usageCost(usage, candidate.budget);
      counters.set(key, counter);
    }
  }

  return {
    check,
    recordUsage,
  };
}

function budgetCandidates(budgets, route) {
  const routeId = String(route?.id || route?.model || "").trim();
  const provider = providerId(route);
  const result = [];
  if (hasLimits(budgets.global)) {
    result.push({ scope: "global", id: "global", label: "全部模型", budget: budgets.global });
  }
  if (routeId && budgets.routes[routeId]) {
    result.push({ scope: "route", id: routeId, label: routeId, budget: budgets.routes[routeId] });
  }
  if (provider && budgets.providers[provider]) {
    result.push({ scope: "provider", id: provider, label: provider, budget: budgets.providers[provider] });
  }
  return result;
}

function blockedByBudget(candidate, counter) {
  const budget = candidate.budget || {};
  if (budget.dailyCallLimit && counter.calls >= budget.dailyCallLimit) {
    return {
      metric: "calls",
      used: counter.calls,
      limit: budget.dailyCallLimit,
      remaining: Math.max(0, budget.dailyCallLimit - counter.calls),
      unit: "次请求",
    };
  }
  if (budget.dailyTokenLimit && counter.tokens >= budget.dailyTokenLimit) {
    return {
      metric: "tokens",
      used: counter.tokens,
      limit: budget.dailyTokenLimit,
      remaining: Math.max(0, budget.dailyTokenLimit - counter.tokens),
      unit: "Token",
    };
  }
  if (budget.dailyCostLimit && counter.cost >= budget.dailyCostLimit) {
    return {
      metric: "cost",
      used: roundCost(counter.cost),
      limit: budget.dailyCostLimit,
      remaining: roundCost(Math.max(0, budget.dailyCostLimit - counter.cost)),
      unit: "费用单位",
    };
  }
  return null;
}

function normalizeScopeMap(input = {}) {
  const result = {};
  if (!input || typeof input !== "object") {
    return result;
  }
  for (const [key, value] of Object.entries(input)) {
    const id = String(key || "").trim();
    const scope = normalizeScope(value);
    if (id && hasLimits(scope)) {
      result[id] = scope;
    }
  }
  return result;
}

function normalizeScope(input = {}) {
  return {
    dailyTokenLimit: positiveInteger(input.dailyTokenLimit ?? input.daily_tokens ?? input.tokens),
    dailyCallLimit: positiveInteger(input.dailyCallLimit ?? input.daily_calls ?? input.calls),
    dailyCostLimit: positiveNumber(input.dailyCostLimit ?? input.daily_cost ?? input.cost),
    inputCostPerMillion: positiveNumber(input.inputCostPerMillion ?? input.input_cost_per_million),
    cacheCostPerMillion: positiveNumber(input.cacheCostPerMillion ?? input.cache_cost_per_million),
    outputCostPerMillion: positiveNumber(input.outputCostPerMillion ?? input.output_cost_per_million),
  };
}

function hasLimits(scope = {}) {
  return Boolean(scope.dailyTokenLimit || scope.dailyCallLimit || scope.dailyCostLimit);
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function usageTokens(usage = {}) {
  const value = usage?.total_tokens ?? usage?.totalTokens ?? usage?.total ?? 0;
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function usageCost(usage = {}, budget = {}) {
  const inputRate = Number(budget.inputCostPerMillion || 0);
  const cacheRate = Number(budget.cacheCostPerMillion || inputRate || 0);
  const outputRate = Number(budget.outputCostPerMillion || 0);
  if (inputRate <= 0 && cacheRate <= 0 && outputRate <= 0) {
    return 0;
  }
  const cacheTokens = usageTokenField(usage, [
    "cached_tokens",
    "cache_read_tokens",
    "cacheReadTokens",
    "cached",
  ]);
  const freshTokens = usageTokenField(usage, [
    "fresh_tokens",
    "freshPromptTokens",
    "fresh_prompt_tokens",
    "fresh",
  ]);
  const promptTokens = usageTokenField(usage, [
    "prompt_tokens",
    "promptTokens",
    "prompt",
  ]);
  const completionTokens = usageTokenField(usage, [
    "completion_tokens",
    "completionTokens",
    "completion",
    "output_tokens",
    "outputTokens",
  ]);
  const billableInputTokens = freshTokens || Math.max(0, promptTokens - cacheTokens);
  return roundCost(
    (billableInputTokens * inputRate +
      cacheTokens * cacheRate +
      completionTokens * outputRate) / 1_000_000,
  );
}

function usageTokenField(usage = {}, names = []) {
  for (const name of names) {
    const number = Number(usage?.[name] || 0);
    if (Number.isFinite(number) && number > 0) {
      return number;
    }
  }
  return 0;
}

function roundCost(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 1_000_000_000) / 1_000_000_000 : 0;
}

function zeroCounter() {
  return { calls: 0, tokens: 0, cost: 0 };
}

function counterKey(day, scope, id) {
  return `${day}:${scope}:${id}`;
}

function providerId(route = {}) {
  return String(route.provider || route.providerId || route.provider_id || "").trim();
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
