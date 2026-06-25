import test from "node:test";
import assert from "node:assert/strict";
import { probeRouterHealth, waitForRouterHealth } from "../desktop/router-health.mjs";

test("probeRouterHealth reports healthy router model list", async () => {
  const result = await probeRouterHealth({
    origin: "http://127.0.0.1:15722",
    fetchImpl: async (url) => {
      assert.equal(url, "http://127.0.0.1:15722/health");
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, models: ["gpt-5.5", "gpt-5.2"] }),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.models, ["gpt-5.5", "gpt-5.2"]);
  assert.match(result.message, /2 models/);
});

test("probeRouterHealth preserves upstream route health diagnostics", async () => {
  const result = await probeRouterHealth({
    origin: "http://127.0.0.1:15722",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        models: ["gpt-5.5", "deepseek-v4-pro"],
        unhealthyRoutes: 1,
        routes: [
          {
            id: "gpt-5.5",
            status: "healthy",
            lastErrorType: "",
          },
          {
            id: "deepseek-v4-pro",
            status: "rate_limited",
            lastErrorType: "rate_limit",
            cooldownRemainingMs: 12000,
          },
        ],
      }),
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.unhealthyRoutes, 1);
  assert.equal(result.routes.length, 2);
  assert.equal(result.routes[1].status, "rate_limited");
  assert.match(result.message, /1 route/);
});

test("probeRouterHealth reports failed router health with concrete reason", async () => {
  const result = await probeRouterHealth({
    origin: "http://127.0.0.1:15722",
    fetchImpl: async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:15722"), {
        cause: { code: "ECONNREFUSED" },
      });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.match(result.message, /ECONNREFUSED/);
});

test("waitForRouterHealth keeps polling while router is still starting", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await waitForRouterHealth({
    origin: "http://127.0.0.1:15722",
    timeoutMs: 10,
    maxWaitMs: 5000,
    intervalMs: 25,
    sleepImpl: async (ms) => sleeps.push(ms),
    fetchImpl: async () => {
      calls += 1;
      if (calls < 4) {
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:15722"), {
          cause: { code: "ECONNREFUSED" },
        });
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, models: ["gpt-5.5"] }),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 4);
  assert.deepEqual(result.models, ["gpt-5.5"]);
  assert.equal(sleeps.length, 3);
});

test("waitForRouterHealth stops polling when the router process exits", async () => {
  let calls = 0;
  const result = await waitForRouterHealth({
    origin: "http://127.0.0.1:15722",
    timeoutMs: 10,
    maxWaitMs: 5000,
    intervalMs: 25,
    sleepImpl: async () => {},
    isStillStarting: () => calls < 2,
    fetchImpl: async () => {
      calls += 1;
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:15722"), {
        cause: { code: "ECONNREFUSED" },
      });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
  assert.match(result.message, /process exited/);
});
