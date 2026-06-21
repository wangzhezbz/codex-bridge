import test from "node:test";
import assert from "node:assert/strict";
import { probeRouterHealth } from "../desktop/router-health.mjs";

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
