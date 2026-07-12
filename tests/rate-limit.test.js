import test from "node:test";
import assert from "node:assert/strict";
import {
  __resetRateLimiterForTests,
  __setRateLimitClockForTests,
  markRouteRateLimited,
  routeRateLimitStatus,
  waitForRouteCapacity,
} from "../src/rate-limit.js";

test("provider cooldown is recorded and awaited when local pacing is disabled", async (t) => {
  t.after(() => __resetRateLimiterForTests());
  const sleeps = [];
  let now = 1_000;
  __resetRateLimiterForTests();
  __setRateLimitClockForTests({
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  const route = {
    id: "deepseek-pro",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.example/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    apiKey: "must-not-enter-rate-limit-state",
    localRateLimitEnabled: false,
    rpm: 60,
  };

  markRouteRateLimited(route, { "retry-after": "2" });

  assert.deepEqual(routeRateLimitStatus(route), {
    providerCooldownRemainingMs: 2_000,
    localPacingNextAfterMs: 0,
    cooldownRemainingMs: 2_000,
    nextAfterMs: 0,
  });
  await waitForRouteCapacity(route);
  await waitForRouteCapacity(route);
  assert.deepEqual(sleeps, [2_000]);
  assert.deepEqual(routeRateLimitStatus(route), {
    providerCooldownRemainingMs: 0,
    localPacingNextAfterMs: 0,
    cooldownRemainingMs: 0,
    nextAfterMs: 0,
  });
});

test("provider cooldown and local pacing remain distinct across local switch changes", async (t) => {
  t.after(() => __resetRateLimiterForTests());
  const sleeps = [];
  let now = 0;
  __resetRateLimiterForTests();
  __setRateLimitClockForTests({
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  const enabledRoute = {
    id: "shared-pro",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.example/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    localRateLimitEnabled: true,
    rpm: 60,
  };

  await waitForRouteCapacity(enabledRoute);
  markRouteRateLimited(enabledRoute, { "retry-after": "3" });

  assert.deepEqual(routeRateLimitStatus(enabledRoute), {
    providerCooldownRemainingMs: 3_000,
    localPacingNextAfterMs: 1_000,
    cooldownRemainingMs: 3_000,
    nextAfterMs: 1_000,
  });

  const disabledRoute = {
    ...enabledRoute,
    localRateLimitEnabled: false,
  };
  assert.deepEqual(routeRateLimitStatus(disabledRoute), {
    providerCooldownRemainingMs: 3_000,
    localPacingNextAfterMs: 0,
    cooldownRemainingMs: 3_000,
    nextAfterMs: 0,
  });

  await waitForRouteCapacity(disabledRoute);
  assert.deepEqual(sleeps, [3_000]);
});

test("provider cooldown shares a non-secret provider identity but not a different credential reference", (t) => {
  t.after(() => __resetRateLimiterForTests());
  __resetRateLimiterForTests();
  __setRateLimitClockForTests({
    now: () => 5_000,
    sleep: async () => {},
  });
  const shared = {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.example/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    localRateLimitEnabled: false,
  };
  const first = {
    ...shared,
    id: "deepseek-pro",
    model: "deepseek-pro",
    apiKey: "first-secret-value",
  };
  const sameProviderIdentity = {
    ...shared,
    id: "deepseek-flash",
    model: "deepseek-flash",
    apiKey: "second-secret-value",
  };
  const differentCredentialReference = {
    ...sameProviderIdentity,
    apiKeyEnv: "DEEPSEEK_SECOND_ACCOUNT_API_KEY",
  };

  markRouteRateLimited(first, { "retry-after": "4" });

  assert.equal(
    routeRateLimitStatus(sameProviderIdentity).providerCooldownRemainingMs,
    4_000,
  );
  assert.equal(
    routeRateLimitStatus(differentCredentialReference).providerCooldownRemainingMs,
    0,
  );
});

test("fail-fast provider cooldown is independent from local pacing", async (t) => {
  t.after(() => __resetRateLimiterForTests());
  const sleeps = [];
  __resetRateLimiterForTests();
  __setRateLimitClockForTests({
    now: () => 10_000,
    sleep: async (ms) => sleeps.push(ms),
  });
  const route = {
    id: "provider-only-cooldown",
    provider: "example",
    baseUrl: "https://api.example.test/v1",
    localRateLimitEnabled: false,
  };
  markRouteRateLimited(route, { "retry-after": "5" });

  await assert.rejects(
    waitForRouteCapacity(route, {}, { failFastOnCooldown: true }),
    (error) => {
      assert.equal(error.code, "provider_rate_limited");
      assert.equal(error.retryAfterMs, 5_000);
      return true;
    },
  );
  assert.deepEqual(sleeps, []);
});

test("test reset clears provider cooldown and local pacing state together", async () => {
  let now = 0;
  __resetRateLimiterForTests();
  __setRateLimitClockForTests({
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  const route = {
    id: "reset-route",
    provider: "example",
    baseUrl: "https://api.example.test/v1",
    localRateLimitEnabled: true,
    rpm: 60,
  };
  await waitForRouteCapacity(route);
  markRouteRateLimited(route, { "retry-after": "5" });

  __resetRateLimiterForTests();

  assert.deepEqual(routeRateLimitStatus(route), {
    providerCooldownRemainingMs: 0,
    localPacingNextAfterMs: 0,
    cooldownRemainingMs: 0,
    nextAfterMs: 0,
  });
});
