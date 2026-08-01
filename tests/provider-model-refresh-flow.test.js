import assert from "node:assert/strict";
import test from "node:test";

import { createProviderModelRefreshFlow } from "../desktop/provider-model-refresh-flow.mjs";

test("overlapping refreshes for one provider share one fetch and one commit", async () => {
  let releaseFetch;
  const fetchGate = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  let fetchCalls = 0;
  let commitCalls = 0;
  const flow = createProviderModelRefreshFlow({
    fetchCandidate: async (providerId) => {
      fetchCalls += 1;
      await fetchGate;
      return {
        ok: true,
        providerId,
        count: 2,
        models: [{ id: "model-a" }, { id: "model-b" }],
      };
    },
    commitCandidate: async (candidate) => {
      commitCalls += 1;
      return { result: { refresh: candidate } };
    },
  });

  const first = flow.refresh("deepseek");
  const second = flow.refresh("deepseek");
  releaseFetch();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(fetchCalls, 1);
  assert.equal(commitCalls, 1);
  assert.deepEqual(firstResult, secondResult);
  assert.equal(firstResult.result.providerId, "deepseek");
  assert.equal(firstResult.committed.result.refresh.count, 2);
});

test("different providers can refresh independently", async () => {
  const started = [];
  const flow = createProviderModelRefreshFlow({
    fetchCandidate: async (providerId) => {
      started.push(providerId);
      return { ok: true, providerId, count: 1, models: [{ id: `${providerId}-model` }] };
    },
    commitCandidate: async (candidate) => ({ result: { refresh: candidate } }),
  });

  const [deepseek, kimi] = await Promise.all([
    flow.refresh("deepseek"),
    flow.refresh("kimi"),
  ]);

  assert.deepEqual(started.sort(), ["deepseek", "kimi"]);
  assert.equal(deepseek.result.providerId, "deepseek");
  assert.equal(kimi.result.providerId, "kimi");
});

test("a failed refresh is released so the next retry performs new work", async () => {
  let attempts = 0;
  const flow = createProviderModelRefreshFlow({
    fetchCandidate: async (providerId) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("temporary failure");
      }
      return { ok: true, providerId, count: 1, models: [{ id: "recovered" }] };
    },
    commitCandidate: async (candidate) => ({ result: { refresh: candidate } }),
  });

  await assert.rejects(flow.refresh("deepseek"), /temporary failure/);
  const recovered = await flow.refresh("deepseek");

  assert.equal(attempts, 2);
  assert.equal(recovered.result.models[0].id, "recovered");
});
