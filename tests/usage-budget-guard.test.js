import test from "node:test";
import assert from "node:assert/strict";
import {
  createUsageBudgetGuard,
  usageBudgetOptions,
} from "../src/usage-budget-guard.js";
import { normalizeUsage } from "../src/upstream-usage.js";

test("small nonzero write-cache charges accumulate instead of being rounded away per request", () => {
  const guard = createUsageBudgetGuard({ now: () => new Date("2026-09-06T12:00:00Z") });
  const config = { usageBudgets: { global: {
    dailyCostLimit: 0.00000001,
    cacheWriteCostPerMillion: 0.0000004,
  } } };
  const route = { id: "low-priced-cache", provider: "custom" };
  const usage = { prompt_tokens: 1000, cache_creation_tokens: 1000, fresh_prompt_tokens: 0, total_tokens: 1000 };
  for (let index = 0; index < 100; index += 1) guard.recordUsage(config, route, usage);
  const status = guard.check(config, route);
  assert.equal(status.ok, false);
  assert.equal(status.metric, "cost");
  assert.ok(Math.abs(status.used - 0.00000004) < 1e-20);
});

test("a sub-nanounit budget violation still reports a nonzero used amount", () => {
  const guard = createUsageBudgetGuard();
  const config = { usageBudgets: { global: { dailyCostLimit: 1e-10, cacheWriteCostPerMillion: 4e-7 } } };
  guard.recordUsage(config, { id: "small-charge" }, { prompt_tokens: 1000, cache_creation_tokens: 1000, total_tokens: 1000 });
  const status = guard.check(config, { id: "small-charge" });
  assert.equal(status.ok, false);
  assert.equal(status.used, 4e-10);
});

test("decimal fees stop exactly at the cost cap in global route and provider scopes", () => {
  const route = { id: "decimal-route", provider: "decimal-provider" };
  const budget = { dailyCostLimit: 1, inputCostPerMillion: 100 };
  for (const scope of ["global", "route", "provider"]) {
    const guard = createUsageBudgetGuard();
    const usageBudgets = scope === "global" ? { global: budget }
      : scope === "route" ? { routes: { [route.id]: budget } }
        : { providers: { [route.provider]: budget } };
    const config = { usageBudgets };
    for (let index = 0; index < 10; index += 1) {
      assert.equal(guard.check(config, route).ok, true);
      guard.recordUsage(config, route, { prompt_tokens: 1000, total_tokens: 1000 });
    }
    const result = guard.check(config, route);
    assert.equal(result.ok, false, `${scope}: ten charges of 0.1 must reach a limit of 1`);
    assert.equal(result.scope, scope);
    assert.equal(result.used, 1);
    assert.equal(result.remaining, 0);
  }
});

test("many small decimal fees reach their exact cap without rounding each request", () => {
  const guard = createUsageBudgetGuard();
  const config = { usageBudgets: { global: { dailyCostLimit: 0.1, inputCostPerMillion: 0.01 } } };
  const route = { id: "many-small-charges" };
  for (let index = 0; index < 9999; index += 1) guard.recordUsage(config, route, { prompt_tokens: 1000 });
  assert.equal(guard.check(config, route).ok, true);
  guard.recordUsage(config, route, { prompt_tokens: 1000 });
  assert.equal(guard.check(config, route).ok, false);
  assert.equal(guard.check(config, route).used, 0.1);
});

test("decimal cost boundaries agree with independently scaled cents across common prices", () => {
  for (let cents = 1; cents <= 50; cents += 1) {
    for (const count of [3, 5, 10, 100]) {
      // 1,000 input tokens at cents/100 per million cost cents/100,000.
      const limit = cents * count / 100000;
      const guard = createUsageBudgetGuard();
      const route = { id: "decimal-cent-grid" };
      const config = { usageBudgets: { global: { dailyCostLimit: limit, inputCostPerMillion: cents / 100 } } };
      for (let index = 0; index < count; index += 1) {
        assert.equal(guard.check(config, route).ok, true, "a request below the cap remains allowed");
        guard.recordUsage(config, route, { prompt_tokens: 1000 });
      }
      assert.equal(guard.check(config, route).ok, false, `${cents} cents, ${count} requests must reach ${limit}`);
      assert.equal(guard.check(config, route).used, limit);
    }
  }
});

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

test("usage budget guard charges configured cache writes instead of ordinary input", () => {
  const guard = createUsageBudgetGuard({ now: () => new Date("2026-09-06T10:00:00.000Z") });
  const config = {
    usageBudgets: { global: {
      dailyCostLimit: 1.1,
      inputCostPerMillion: 10,
      cacheCostPerMillion: 1,
      cacheWriteCostPerMillion: 12.5,
    } },
  };
  const route = { id: "cb-astra", provider: "openai" };
  guard.recordUsage(config, route, normalizeUsage({
    input_tokens: 100_000,
    output_tokens: 0,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 100_000 },
  }));
  const blocked = guard.check(config, route);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.metric, "cost");
  assert.equal(blocked.used, 1.25);
  assert.equal(blocked.limit, 1.1);
});

test("usage budget guard supports explicit zero and snake-case cache-write prices", () => {
  const now = () => new Date("2026-09-06T10:00:00.000Z");
  const route = { id: "cb-astra", provider: "openai" };
  for (const [cacheWriteCostPerMillion, expectedUsed] of [[0, 0.4], [12.5, 1.65]]) {
    const guard = createUsageBudgetGuard({ now });
    const config = {
      usageBudgets: { global: {
        dailyCostLimit: 0.3,
        inputCostPerMillion: 10,
        cacheCostPerMillion: 2,
        cache_write_cost_per_million: cacheWriteCostPerMillion,
        outputCostPerMillion: 20,
      } },
    };
    guard.recordUsage(config, route, {
      prompt_tokens: 200_000,
      fresh_prompt_tokens: 20_000,
      cache_read_tokens: 80_000,
      cache_creation_tokens: 100_000,
      completion_tokens: 2_000,
      total_tokens: 202_000,
    });
    assert.equal(guard.check(config, route).used, expectedUsed);
    assert.equal(usageBudgetOptions(config).global.cacheWriteCostPerMillion, cacheWriteCostPerMillion);
  }
});

test("official modern cache writes use the configured input-rate multiplier by default", () => {
  const guard = createUsageBudgetGuard();
  const config = { usageBudgets: { global: { dailyCostLimit: 1.1, inputCostPerMillion: 10, cacheCostPerMillion: 1 } } };
  const route = { id: "cb-astra", model: "gpt-6-astra", baseUrl: "https://api.openai.com/v1", authMode: "api_key" };
  guard.recordUsage(config, route, { input_tokens: 100_000, input_tokens_details: { cache_write_tokens: 100_000 } });
  assert.equal(guard.check(config, route).ok, false);
  assert.equal(guard.check(config, route).used, 1.25);
});

test("modern third-party and legacy write tokens keep distinct default prices", () => {
  const cases = [
    [{ input_tokens: 100_000, input_tokens_details: { cache_write_tokens: 100_000 } }, 1],
    [{ prompt_tokens: 100_000, cache_creation_tokens: 100_000 }, 0.1],
    [{ input_tokens: 0, cache_creation_input_tokens: 100_000 }, 0.1],
  ];
  for (const [usage, expected] of cases) {
    const guard = createUsageBudgetGuard();
    const config = { usageBudgets: { global: { dailyCostLimit: 0.01, inputCostPerMillion: 10, cacheCostPerMillion: 1 } } };
    const route = { id: "third-party", model: "gpt-6-astra", baseUrl: "https://proxy.example/v1" };
    guard.recordUsage(config, route, usage);
    assert.equal(guard.check(config, route).used, expected);
  }
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
