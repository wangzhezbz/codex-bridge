import test from "node:test";
import assert from "node:assert/strict";
import {
  createUsageBudgetGuard,
  usageBudgetOptions,
} from "../src/usage-budget-guard.js";

test("usageBudgetOptions stays disabled for empty budget config", () => {
  assert.equal(usageBudgetOptions({}), null);
  assert.equal(usageBudgetOptions({ usageBudgets: {} }), null);
});

test("usage budget guard allows by default and blocks when route call limit is spent", () => {
  const guard = createUsageBudgetGuard({ now: () => new Date("2026-07-02T10:00:00.000Z") });
  const config = {
    usageBudgets: {
      routes: {
        "cb-kimi": { dailyCallLimit: 1 },
      },
    },
  };
  const route = { id: "cb-kimi", provider: "kimi" };

  assert.equal(guard.check(config, route).ok, true);
  guard.recordUsage(config, route, null);

  const blocked = guard.check(config, route);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.scope, "route");
  assert.equal(blocked.metric, "calls");
  assert.equal(blocked.used, 1);
  assert.equal(blocked.limit, 1);
  assert.equal(blocked.remaining, 0);
  assert.equal(blocked.unit, "次请求");
});

test("usage budget guard blocks by provider token limit across routes", () => {
  const guard = createUsageBudgetGuard({ now: () => new Date("2026-07-02T10:00:00.000Z") });
  const config = {
    usageBudgets: {
      providers: {
        kimi: { dailyTokenLimit: 100 },
      },
    },
  };

  guard.recordUsage(config, { id: "cb-kimi-a", provider: "kimi" }, { total_tokens: 60 });
  guard.recordUsage(config, { id: "cb-kimi-b", provider: "kimi" }, { total_tokens: 45 });

  const blocked = guard.check(config, { id: "cb-kimi-c", provider: "kimi" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.scope, "provider");
  assert.equal(blocked.metric, "tokens");
  assert.equal(blocked.used, 105);
  assert.equal(blocked.limit, 100);
  assert.equal(blocked.remaining, 0);
  assert.equal(blocked.unit, "Token");
});

test("usage budget guard blocks by daily estimated cost limit", () => {
  const guard = createUsageBudgetGuard({ now: () => new Date("2026-07-02T10:00:00.000Z") });
  const config = {
    usageBudgets: {
      providers: {
        kimi: {
          dailyCostLimit: 0.002,
          inputCostPerMillion: 1,
          cacheCostPerMillion: 0.25,
          outputCostPerMillion: 2,
        },
      },
    },
  };

  guard.recordUsage(config, { id: "cb-kimi-a", provider: "kimi" }, {
    prompt_tokens: 1000,
    cached_tokens: 400,
    fresh_tokens: 600,
    completion_tokens: 500,
    total_tokens: 1500,
  });
  guard.recordUsage(config, { id: "cb-kimi-b", provider: "kimi" }, {
    prompt_tokens: 1000,
    cached_tokens: 0,
    fresh_tokens: 1000,
    completion_tokens: 100,
    total_tokens: 1100,
  });

  const blocked = guard.check(config, { id: "cb-kimi-c", provider: "kimi" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.scope, "provider");
  assert.equal(blocked.metric, "cost");
  assert.equal(blocked.used, 0.0029);
  assert.equal(blocked.limit, 0.002);
  assert.equal(blocked.remaining, 0);
  assert.equal(blocked.unit, "费用单位");
});

test("usage budget guard uses input price for cached tokens when cache price is omitted", () => {
  const guard = createUsageBudgetGuard({ now: () => new Date("2026-07-02T10:00:00.000Z") });
  const config = {
    usageBudgets: {
      routes: {
        "cb-qwen": {
          dailyCostLimit: 0.002,
          inputCostPerMillion: 1,
        },
      },
    },
  };

  guard.recordUsage(config, { id: "cb-qwen", provider: "qwen" }, {
    prompt_tokens: 2000,
    cached_tokens: 1500,
    fresh_tokens: 500,
    completion_tokens: 0,
    total_tokens: 2000,
  });

  const blocked = guard.check(config, { id: "cb-qwen", provider: "qwen" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.metric, "cost");
  assert.equal(blocked.used, 0.002);
});

test("usage budget guard resets daily counters on local day change", () => {
  let current = new Date("2026-07-02T23:59:00");
  const guard = createUsageBudgetGuard({ now: () => current });
  const config = {
    usageBudgets: {
      global: { dailyCallLimit: 1 },
    },
  };
  const route = { id: "cb-chat", provider: "qwen" };

  guard.recordUsage(config, route, null);
  assert.equal(guard.check(config, route).ok, false);

  current = new Date("2026-07-03T00:01:00");
  assert.equal(guard.check(config, route).ok, true);
});

test("usage budget guard reports readable Chinese label for global budget", () => {
  const guard = createUsageBudgetGuard({ now: () => new Date("2026-07-02T10:00:00.000Z") });
  const config = {
    usageBudgets: {
      global: { dailyCallLimit: 1 },
    },
  };
  const route = { id: "cb-chat", provider: "qwen" };

  guard.recordUsage(config, route, null);

  const blocked = guard.check(config, route);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.scope, "global");
  assert.equal(blocked.label, "全部模型");
});
