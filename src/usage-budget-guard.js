import { normalizeUsage } from "./upstream-usage.js";
import { estimateUsageTokenCosts, normalizeUsageCostRates } from "../shared/usage-cost.cjs";

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
  let activeDay = "";

  function synchronizeDay(day) {
    if (day !== activeDay) {
      counters.clear();
      activeDay = day;
    }
  }

  function check(config = {}, route = {}) {
    const budgets = usageBudgetOptions(config);
    if (!budgets) {
      return { ok: true };
    }
    const day = localDayKey(now());
    synchronizeDay(day);
    const candidates = budgetCandidates(budgets, route);
    for (const candidate of candidates) {
      const counter = counters.get(counterKey(candidate.scope, candidate.id)) || zeroCounter();
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
    synchronizeDay(day);
    const normalizedUsage = normalizeUsage(usage, route);
    const tokens = usageTokens(normalizedUsage);
    const candidates = budgetCandidates(budgets, route);
    for (const candidate of candidates) {
      const key = counterKey(candidate.scope, candidate.id);
      const counter = counters.get(key) || zeroCounter();
      counter.calls += 1;
      counter.tokens += tokens;
      // Compensate summation error instead of rounding individual charges:
      // ten 0.1 charges must reach 1, and tiny charges must still accumulate.
      const adjustedCost = usageCost(normalizedUsage, candidate.budget) - counter.costCorrection;
      const nextCost = counter.cost + adjustedCost;
      counter.costCorrection = Number.isFinite(nextCost) ? (nextCost - counter.cost) - adjustedCost : 0;
      counter.cost = nextCost;
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
  // Compare with the same significant precision used by published budget
  // amounts, so a one-ulp calculation difference cannot bypass an exact cap.
  const comparableCost = Number.isFinite(counter.cost) ? roundCost(counter.cost) : counter.cost;
  const comparableLimit = roundCost(budget.dailyCostLimit);
  if (budget.dailyCostLimit && comparableCost >= comparableLimit) {
    return {
      metric: "cost",
      used: roundCost(counter.cost),
      limit: budget.dailyCostLimit,
      remaining: roundCost(Math.max(0, comparableLimit - comparableCost)),
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
    ...normalizeUsageCostRates(input),
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
  // Preserve each nonzero charge while accumulating; rounding belongs to the
  // presented totals, otherwise many individually small charges become free.
  return positiveNumber(estimateUsageTokenCosts({
    freshPromptTokens: usage.fresh_prompt_tokens,
    cacheReadTokens: usage.cache_read_tokens,
    cacheCreationTokens: usage.cache_creation_tokens,
    openaiCacheWriteTokens: usage.cache_write_rate_kind === "openai" ? usage.cache_creation_tokens : 0,
    inputCacheWriteTokens: usage.cache_write_rate_kind === "input" ? usage.cache_creation_tokens : 0,
    completionTokens: usage.completion_tokens,
  }, budget).totalCost);
}

function roundCost(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Number(number.toPrecision(15)) : 0;
}

function zeroCounter() {
  return { calls: 0, tokens: 0, cost: 0, costCorrection: 0 };
}

function counterKey(scope, id) {
  return `${scope}:${id}`;
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
