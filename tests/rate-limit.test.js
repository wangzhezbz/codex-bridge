import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  __rateLimiterStateSizesForTests,
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

test("explicit Retry-After delays are not shortened by fallback cooldown limits", async (t) => {
  t.after(() => __resetRateLimiterForTests());
  const startedAt = Date.parse("Sun, 06 Sep 2026 00:00:00 GMT");
  for (const item of [
    { header: "180", waitMs: 180_000 },
    { header: "0.01", waitMs: 10 },
    { header: "Sun, 06 Sep 2026 00:03:00 GMT", waitMs: 180_000 },
    { header: "0", waitMs: 0 },
    { header: "Sat, 05 Sep 2026 23:59:59 GMT", waitMs: 0 },
  ]) {
    for (const limit of [{}, { maxCooldownMs: 1000 }]) {
      __resetRateLimiterForTests();
      let now = startedAt;
      const sleeps = [];
      __setRateLimitClockForTests({
        now: () => now,
        sleep: async (ms) => { sleeps.push(ms); now += ms; },
      });
      const route = { id: "explicit-retry-after", localRateLimitEnabled: false, ...limit };
      markRouteRateLimited(route, { "retry-after": item.header });
      assert.equal(routeRateLimitStatus(route).providerCooldownRemainingMs, item.waitMs, item.header);
      await waitForRouteCapacity(route);
      assert.deepEqual(sleeps, item.waitMs ? [item.waitMs] : []);
    }
  }
});

test("explicit Retry-After deadlines longer than a day wait in bounded cancellable slices", async (t) => {
  t.after(() => __resetRateLimiterForTests());
  __resetRateLimiterForTests();
  const dayMs = 24 * 60 * 60_000;
  let now = 0;
  const sleeps = [];
  __setRateLimitClockForTests({
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
  });
  const route = { id: "multi-day-retry-after", localRateLimitEnabled: false };
  markRouteRateLimited(route, { "retry-after": "172801" });
  assert.equal(routeRateLimitStatus(route).providerCooldownRemainingMs, 172_801_000);
  await waitForRouteCapacity(route);
  assert.deepEqual(sleeps, [dayMs, dayMs, 1000]);

  markRouteRateLimited(route, { "retry-after": "172801" });
  __setRateLimitClockForTests({ sleep: () => new Promise(() => {}) });
  const controller = new AbortController();
  const reason = new Error("cancel long server cooldown");
  const pending = waitForRouteCapacity(route, { clientSignal: controller.signal });
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
});

for (const fixture of [
  { timezone: "Etc/GMT-8", expectedOffsetMinutes: -480 },
  { timezone: "Etc/GMT+8", expectedOffsetMinutes: 480 },
]) {
  test(`HTTP-date Retry-After uses UTC for every wire format in ${fixture.timezone}`, () => {
    const moduleUrl = new URL("../src/rate-limit.js", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      import {
        __resetRateLimiterForTests, __setRateLimitClockForTests,
        markRouteRateLimited, parseRetryAfter, routeRateLimitStatus, waitForRouteCapacity,
      } from ${JSON.stringify(moduleUrl)};
      const startedAt = Date.parse("2026-09-06T00:00:00Z");
      const headers = [
        "Sun, 06 Sep 2026 01:00:00 GMT",
        "Sunday, 06-Sep-26 01:00:00 GMT",
        "Sun Sep  6 01:00:00 2026",
      ];
      const results = [];
      for (const header of headers) {
        __resetRateLimiterForTests();
        let now = startedAt;
        const sleeps = [];
        __setRateLimitClockForTests({
          now: () => now,
          sleep: async (ms) => { sleeps.push(ms); now += ms; },
        });
        const route = { id: "timezone-cooldown", localRateLimitEnabled: false };
        markRouteRateLimited(route, { "retry-after": header });
        const remainingMs = routeRateLimitStatus(route).providerCooldownRemainingMs;
        await waitForRouteCapacity(route);
        results.push({ hint: parseRetryAfter(header, startedAt), remainingMs, sleeps });
      }
      console.log(JSON.stringify({
        offsetMinutes: new Date(startedAt).getTimezoneOffset(), results,
      }));
    `], {
      env: { ...process.env, TZ: fixture.timezone },
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    const observed = JSON.parse(child.stdout);
    assert.equal(observed.offsetMinutes, fixture.expectedOffsetMinutes, "child must use the requested timezone");
    assert.deepEqual(observed.results, [
      "Sun, 06 Sep 2026 01:00:00 GMT",
      "Sunday, 06-Sep-26 01:00:00 GMT",
      "Sun Sep  6 01:00:00 2026",
    ].map((value) => ({
      hint: { value, delayMs: 3_600_000 },
      remainingMs: 3_600_000,
      sleeps: [3_600_000],
    })));
  });
}

test("absent and malformed Retry-After keep the bounded legacy fallback", async (t) => {
  t.after(() => __resetRateLimiterForTests());
  for (const header of [undefined, "", "-1", "1.5.2", "Infinity", "later", "60\r\nx-secret: leak"]) {
    __resetRateLimiterForTests();
    __setRateLimitClockForTests({ now: () => 0 });
    const route = { id: "fallback-retry-after", cooldownMs: 300_000 };
    markRouteRateLimited(route, { "retry-after": header });
    assert.equal(routeRateLimitStatus(route).providerCooldownRemainingMs, 120_000, String(header));
  }
  __resetRateLimiterForTests();
  __setRateLimitClockForTests({ now: () => 0 });
  const route = { id: "default-cooldown" };
  markRouteRateLimited(route);
  assert.equal(routeRateLimitStatus(route).providerCooldownRemainingMs, 30_000);
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

test("provider cooldown releases immediately when the client disconnects", async (t) => {
  t.after(() => __resetRateLimiterForTests());
  __resetRateLimiterForTests();
  __setRateLimitClockForTests({
    now: () => 1_000,
    sleep: () => new Promise(() => {}),
  });
  const route = {
    id: "abortable-cooldown",
    provider: "example",
    baseUrl: "https://api.example.test/v1",
    apiKeyEnv: "EXAMPLE_API_KEY",
  };
  markRouteRateLimited(route, { "retry-after": "30" });
  const controller = new AbortController();
  const reason = Object.assign(new Error("client left"), { code: "client_closed_request" });
  const pending = waitForRouteCapacity(route, { clientSignal: controller.signal });
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
});

test("already cancelled capacity requests do not reserve a pacing slot", async (t) => {
  t.after(() => __resetRateLimiterForTests());
  __resetRateLimiterForTests();
  __setRateLimitClockForTests({ now: () => 0, sleep: async () => {} });
  const controller = new AbortController();
  const reason = new Error("request already cancelled");
  controller.abort(reason);
  for (const enabled of [false, true]) {
    await assert.rejects(waitForRouteCapacity({
      id: "cancelled-before-queue", rpm: 60, localRateLimitEnabled: enabled,
    }, { clientSignal: controller.signal }), (error) => error === reason);
  }
  assert.equal(__rateLimiterStateSizesForTests().localPacingStates, 0);
});

test("cancelling a queued capacity request settles before the head and does not spend another slot", async (t) => {
  __resetRateLimiterForTests();
  const route = { id: "cancel-queued", rpm: 60, localRateLimitEnabled: true };
  let now = 0;
  let headStarted;
  const started = new Promise((resolve) => { headStarted = resolve; });
  __setRateLimitClockForTests({
    now: () => now,
    sleep: () => { headStarted(); return new Promise(() => {}); },
  });
  await waitForRouteCapacity(route);
  const headController = new AbortController();
  let headSettled = false;
  const head = waitForRouteCapacity(route, { clientSignal: headController.signal })
    .catch(() => {}).finally(() => { headSettled = true; });
  const queuedController = new AbortController();
  const laterController = new AbortController();
  let cancelled;
  let survivor;
  t.after(async () => {
    headController.abort();
    queuedController.abort();
    laterController.abort();
    await Promise.allSettled([head, cancelled, survivor]);
    __resetRateLimiterForTests();
  });
  await started;
  let outcome = null;
  cancelled = waitForRouteCapacity(route, { clientSignal: queuedController.signal })
    .then(() => { outcome = "granted"; }, (error) => { outcome = error; });
  survivor = waitForRouteCapacity(route, { clientSignal: laterController.signal });
  survivor.catch(() => {});
  await nextTurn();
  const reason = new Error("queued request cancelled");
  queuedController.abort(reason);
  await nextTurn();
  assert.equal(outcome, reason);
  assert.equal(headSettled, false);
  __setRateLimitClockForTests({ sleep: async (ms) => { now += ms; } });
  headController.abort();
  await Promise.all([head, cancelled, survivor]);
  assert.equal(now, 1000);
  assert.equal(routeRateLimitStatus(route).localPacingNextAfterMs, 1000);
});

test("capacity admission observes a new provider cooldown that arrived during pacing", async (t) => {
  t.after(() => __resetRateLimiterForTests());
  __resetRateLimiterForTests();
  const route = { id: "cooldown-while-queued", rpm: 60, localRateLimitEnabled: true };
  const sleeps = [];
  let now = 0;
  __setRateLimitClockForTests({
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      sleeps.push(ms);
      if (sleeps.length === 1) markRouteRateLimited(route, { "retry-after": "3" });
    },
  });
  await waitForRouteCapacity(route);
  await waitForRouteCapacity(route);
  assert.deepEqual(sleeps, [1000, 3000]);
  assert.equal(now, 4000);
  assert.equal(routeRateLimitStatus(route).providerCooldownRemainingMs, 0);
  assert.equal(routeRateLimitStatus(route).localPacingNextAfterMs, 1000);
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

test("fallback rate-limit waits and retained route states have hard bounds", async (t) => {
  t.after(() => __resetRateLimiterForTests());
  let now = 0;
  const sleeps = [];
  __resetRateLimiterForTests();
  __setRateLimitClockForTests({
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  const extreme = {
    id: "extreme-rate",
    provider: "extreme",
    baseUrl: "https://extreme.example/v1",
    maxCooldownMs: Number.MAX_SAFE_INTEGER,
    cooldownMs: Number.MAX_SAFE_INTEGER,
    localRateLimitEnabled: true,
    rpm: Number.MIN_VALUE,
  };
  markRouteRateLimited(extreme);
  assert.equal(routeRateLimitStatus(extreme).providerCooldownRemainingMs, 24 * 60 * 60_000);
  await waitForRouteCapacity(extreme);
  await waitForRouteCapacity(extreme);
  assert.ok(sleeps.every((ms) => ms <= 24 * 60 * 60_000));

  __resetRateLimiterForTests();
  for (let index = 0; index < 2_100; index += 1) {
    markRouteRateLimited({
      id: `cooldown-${index}`,
      provider: `provider-${index}`,
      baseUrl: `https://provider-${index}.example/v1`,
    }, { "retry-after": "1" });
  }
  assert.equal(__rateLimiterStateSizesForTests().providerCooldowns, 2_048);

  __resetRateLimiterForTests();
  for (let index = 0; index < 2_100; index += 1) {
    await waitForRouteCapacity({
      id: `paced-${index}`,
      provider: `paced-provider-${index}`,
      baseUrl: `https://paced-${index}.example/v1`,
      localRateLimitEnabled: true,
      rpm: 60,
    });
  }
  assert.equal(__rateLimiterStateSizesForTests().localPacingStates, 2_048);
});
