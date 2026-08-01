import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import * as contextPolicyModule from "../src/context-policy.js";
import {
  CONTEXT_POLICY_ID,
  CONTEXT_POLICY_VERSION,
  contextPolicyForRoute,
} from "../src/context-policy.js";
import { buildModelCatalog } from "../src/model-catalog.js";
import { ResponseHistory } from "../src/history.js";
import {
  estimatedMessagesTokens,
  responsesToChatRequest,
} from "../src/responses-to-chat.js";
import { createRouterServer } from "../src/server.js";

test("context policy derives the shared 1M default budgets", () => {
  assert.deepEqual(contextPolicyForRoute({ contextWindow: 1_000_000 }), {
    version: CONTEXT_POLICY_VERSION,
    policyId: CONTEXT_POLICY_ID,
    upstreamContextWindow: 1_000_000,
    contextWindow: 1_000_000,
    inputBudget: 950_000,
    compactThreshold: 800_000,
    outputReserveTokens: 50_000,
    effectiveContextWindowPercent: 95,
    autoCompactPercent: 80,
    truncationPolicy: {
      mode: "tokens",
      limit: 950_000,
    },
  });
});

test("context policy derives the shared 258400 default budgets", () => {
  const policy = contextPolicyForRoute({ contextWindow: 258_400 });

  assert.equal(policy.inputBudget, 245_480);
  assert.equal(policy.compactThreshold, 206_720);
  assert.equal(policy.outputReserveTokens, 12_920);
});

test("context policy never advertises or budgets beyond the upstream window", () => {
  const policy = contextPolicyForRoute({
    contextWindow: 8_192,
    catalogContextWindow: 200_000,
  });

  assert.equal(policy.upstreamContextWindow, 8_192);
  assert.equal(policy.contextWindow, 8_192);
  assert.equal(policy.inputBudget, 7_782);
  assert.equal(policy.compactThreshold, 6_553);
  assert.ok(policy.inputBudget <= policy.upstreamContextWindow);
  assert.ok(policy.compactThreshold <= policy.inputBudget);
});

test("context policy applies configured percentages with safe integer rounding", () => {
  const policy = contextPolicyForRoute(
    { contextWindow: 10_000.9 },
    {
      effectiveContextWindowPercent: 90,
      autoCompactPercent: 75,
    },
  );

  assert.equal(policy.upstreamContextWindow, 10_000);
  assert.equal(policy.contextWindow, 10_000);
  assert.equal(policy.inputBudget, 9_000);
  assert.equal(policy.compactThreshold, 7_500);
  assert.equal(policy.outputReserveTokens, 1_000);
  assert.equal(policy.effectiveContextWindowPercent, 90);
  assert.equal(policy.autoCompactPercent, 75);
});

test("context policy keeps a stricter explicit token truncation limit unified", () => {
  const policy = contextPolicyForRoute({
    contextWindow: 10_000,
    truncationPolicy: {
      mode: "tokens",
      limit: 7_000,
    },
  });

  assert.equal(policy.inputBudget, 7_000);
  assert.equal(policy.compactThreshold, 7_000);
  assert.equal(policy.outputReserveTokens, 3_000);
  assert.deepEqual(policy.truncationPolicy, {
    mode: "tokens",
    limit: 7_000,
  });
});

test("context policy rejects unknown or invalid windows instead of returning zero", () => {
  for (const route of [
    null,
    {},
    { contextWindow: 0 },
    { contextWindow: -1 },
    { contextWindow: "not-a-number" },
    { contextWindow: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(
      () => contextPolicyForRoute(route),
      (error) =>
        error instanceof TypeError && error.code === "context_window_unknown",
    );
  }
});

test("context policy accepts an explicit default but never masks an invalid route value", () => {
  assert.equal(
    contextPolicyForRoute({}, { defaultContextWindow: 258_400 }).contextWindow,
    258_400,
  );
  assert.throws(
    () =>
      contextPolicyForRoute(
        { contextWindow: 0 },
        { defaultContextWindow: 258_400 },
      ),
    (error) => error?.code === "context_window_unknown",
  );
});

test("model catalog publishes the same policy budgets used by the core", () => {
  const route = {
    id: "cb-large-chat",
    api: "chat_completions",
    model: "large-chat",
    contextWindow: 1_000_000,
  };
  const expected = contextPolicyForRoute(route);
  const entry = buildModelCatalog({ models: [route] }).models[0];

  assert.equal(entry.context_window, expected.contextWindow);
  assert.equal(entry.max_context_window, expected.contextWindow);
  assert.equal(entry.truncation_policy.limit, expected.inputBudget);
  assert.equal(entry.auto_compact_token_limit, expected.compactThreshold);
  assert.equal(
    entry.effective_context_window_percent,
    expected.effectiveContextWindowPercent,
  );
});

test("context config normalization safely applies explicit catalog defaults without mutating route overrides", () => {
  const normalizeContextPolicyConfig =
    contextPolicyModule.normalizeContextPolicyConfig;
  assert.equal(typeof normalizeContextPolicyConfig, "function");

  const inheritedRoute = { id: "inherited", api: "chat_completions" };
  const overriddenRoute = {
    id: "overridden",
    api: "chat_completions",
    contextWindow: 2_000,
    effectiveContextWindowPercent: 85,
    autoCompactPercent: 65,
  };
  const nullishPercentRoute = {
    id: "nullish-percent",
    api: "chat_completions",
    contextWindow: 3_000,
    effectiveContextWindowPercent: undefined,
    autoCompactPercent: null,
  };
  const config = {
    catalog: {
      contextWindow: 1_000,
      effectiveContextWindowPercent: 90,
      autoCompactPercent: 70,
    },
    models: [inheritedRoute, overriddenRoute, nullishPercentRoute],
  };

  const normalized = normalizeContextPolicyConfig(config);

  assert.deepEqual(normalized.models[0], {
    ...inheritedRoute,
    contextWindow: 1_000,
    effectiveContextWindowPercent: 90,
    autoCompactPercent: 70,
  });
  assert.deepEqual(normalized.models[1], overriddenRoute);
  assert.deepEqual(normalized.models[2], {
    ...nullishPercentRoute,
    effectiveContextWindowPercent: 90,
    autoCompactPercent: 70,
  });
  assert.equal(Object.hasOwn(inheritedRoute, "contextWindow"), false);
  assert.notEqual(normalized, config);
  assert.notEqual(normalized.models, config.models);
});

test("server runtime inherits the same explicit 90/70 catalog policy it publishes", async () => {
  let upstreamBody = null;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    upstreamBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl_catalog_policy",
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  await listen(upstream);

  const route = {
    id: "catalog-policy-chat",
    provider: "custom",
    api: "chat_completions",
    baseUrl: `${serverUrl(upstream)}/v1`,
    model: "catalog-policy-chat",
    apiKey: "test-upstream-key",
  };
  const config = {
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    defaultModel: route.id,
    catalog: {
      contextWindow: 1_000,
      effectiveContextWindowPercent: 90,
      autoCompactPercent: 70,
    },
    models: [route],
  };
  const router = createRouterServer(config);
  await listen(router);

  try {
    const catalogResponse = await fetch(`${serverUrl(router)}/model-catalog.json`);
    assert.equal(catalogResponse.ok, true);
    const catalog = await catalogResponse.json();
    assert.equal(catalog.models[0].truncation_policy.limit, 900);
    assert.equal(catalog.models[0].auto_compact_token_limit, 700);

    const response = await fetch(`${serverUrl(router)}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: route.id,
        input: `catalog runtime sentinel ${"oversized context ".repeat(1_000)}`,
      }),
    });
    assert.equal(response.ok, true, await response.text());
    assert.ok(upstreamBody);
    assert.ok(
      estimatedMessagesTokens(upstreamBody.messages) <= 900,
      `runtime input exceeded catalog budget: ${estimatedMessagesTokens(upstreamBody.messages)}`,
    );
  } finally {
    await close(router);
    await close(upstream);
  }
});

test("chat conversion uses the shared 95 percent input budget instead of the old 65 percent cap", () => {
  const history = new ResponseHistory();
  const contextBetweenOldAndNewBudgets = `sentinel ${"word ".repeat(600)}`;
  history.record("resp_shared_budget", [
    { role: "user", content: contextBetweenOldAndNewBudgets },
  ]);

  const converted = responsesToChatRequest(
    {
      previous_response_id: "resp_shared_budget",
      input: "current question",
    },
    {
      id: "cb-shared-budget",
      api: "chat_completions",
      model: "shared-budget-chat",
      contextWindow: 1_000,
    },
    history,
  );
  const text = JSON.stringify(converted.body.messages);

  assert.match(text, /sentinel/);
  assert.doesNotMatch(text, /Earlier conversation history was omitted/);
});

test("chat conversion reports a secret-free structured truncation decision", () => {
  const converted = responsesToChatRequest(
    { input: `PRIVATE_BODY_MARKER ${"oversized context ".repeat(2_000)}` },
    {
      id: "cb-truncation-log",
      api: "chat_completions",
      model: "small-chat",
      contextWindow: 1_000,
    },
    new ResponseHistory(),
  );

  assert.deepEqual(
    Object.keys(converted.contextDecision).sort(),
    [
      "afterTokens",
      "beforeTokens",
      "event",
      "inputBudget",
      "kind",
      "outcome",
      "policyId",
      "policyVersion",
      "preservedToolCount",
      "reasonCode",
    ],
  );
  assert.equal(converted.contextDecision.event, "context_truncation");
  assert.equal(converted.contextDecision.policyId, "codexbridge-context-v1");
  assert.equal(converted.contextDecision.inputBudget, 950);
  assert.ok(converted.contextDecision.beforeTokens > converted.contextDecision.inputBudget);
  assert.ok(converted.contextDecision.afterTokens <= converted.contextDecision.inputBudget);
  assert.equal(converted.contextDecision.preservedToolCount, 0);
  assert.doesNotMatch(JSON.stringify(converted.contextDecision), /PRIVATE_BODY_MARKER/);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function serverUrl(server) {
  const address = server.address();
  return `http://${address.address}:${address.port}`;
}
