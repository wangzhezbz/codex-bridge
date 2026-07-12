import test from "node:test";
import assert from "node:assert/strict";
import { createUsageStore, evaluateUsageBudgets, estimateUsageCosts } from "../desktop/usage.mjs";

test("usage store records model route and token usage from router logs", () => {
  const usage = createUsageStore();

  usage.recordLine("[10:15:31] [2026-06-20T18:15:31.858Z] req_1cgogaq0 <- /v1/responses model=gpt-5.4-mini route=gpt-5.4-mini api=chat_completions upstream_model=deepseek-v4-pro stream=false previous_response_id=- client_auth=codex_openai upstream_auth=api_key");
  usage.recordLine("[10:15:31] [2026-06-20T18:15:31.859Z] req_1cgogaq0 -> upstream route=gpt-5.4-mini api=chat_completions upstream_model=deepseek-v4-pro url=https://api.deepseek.com/v1/chat/completions");
  usage.recordLine("[10:15:35] [2026-06-20T18:15:35.184Z] req_1cgogaq0 <- upstream route=gpt-5.4-mini usage prompt=13 completion=222 total=235");

  const events = usage.events();
  assert.equal(events.length, 1);
  assert.equal(events[0].requestId, "req_1cgogaq0");
  assert.equal(events[0].codexModel, "gpt-5.4-mini");
  assert.equal(events[0].route, "gpt-5.4-mini");
  assert.equal(events[0].upstreamModel, "deepseek-v4-pro");
  assert.equal(events[0].promptTokens, 13);
  assert.equal(events[0].completionTokens, 222);
  assert.equal(events[0].totalTokens, 235);

  const summary = usage.summary();
  assert.equal(summary.totalCalls, 1);
  assert.equal(summary.totalTokens, 235);
  assert.equal(summary.byModel[0].route, "gpt-5.4-mini");
  assert.equal(summary.byModel[0].calls, 1);
});

test("usage store attributes auxiliary and automatic route decisions", () => {
  const usage = createUsageStore();
  usage.recordLine("[00:00:00] [2026-07-12T00:00:00.000Z] req_aux123 !! route-plan kind=codex_auxiliary reason=codex_auxiliary_task requested_model=gpt-5.4 route=cb-gpt-5-6-sol");
  usage.recordLine("[00:00:00] [2026-07-12T00:00:00.001Z] req_aux123 <- /v1/responses model=gpt-5.6-sol route=cb-gpt-5-6-sol api=responses upstream_model=gpt-5.6-sol stream=true provider=codex smart_route=codex_auxiliary_task original_route=- compact=- previous_response_id=- client_auth=codex_openai upstream_auth=codex_openai");
  usage.recordLine("[00:00:01] [2026-07-12T00:00:01.000Z] req_aux123 <- upstream route=cb-gpt-5-6-sol usage prompt=10 completion=2 total=12");

  const [event] = usage.events();
  assert.equal(event.requestKind, "codex_auxiliary");
  assert.equal(event.routeReason, "codex_auxiliary_task");
  assert.equal(event.requestedModel, "gpt-5.4");
  assert.equal(event.routeSource, "auxiliary");
});

test("usage store separates fresh input from cache-read tokens", () => {
  const usage = createUsageStore();

  usage.recordLine("[10:15:31] [2026-06-28T18:15:31.858Z] req_cache1 <- /v1/responses model=gpt-5.5 route=gpt-5.5 api=responses upstream_model=gpt-5.5 stream=true previous_response_id=- client_auth=codex_openai upstream_auth=codex_openai");
  usage.recordLine("[10:15:35] [2026-06-28T18:15:35.184Z] req_cache1 <- upstream route=gpt-5.5 usage prompt=16000 cached=15400 fresh=600 completion=20 total=16020");

  const [event] = usage.events();
  assert.equal(event.promptTokens, 16000);
  assert.equal(event.cacheReadTokens, 15400);
  assert.equal(event.freshPromptTokens, 600);
  assert.equal(event.completionTokens, 20);
  assert.equal(event.totalTokens, 16020);

  const summary = usage.summary();
  assert.equal(summary.promptTokens, 16000);
  assert.equal(summary.freshPromptTokens, 600);
  assert.equal(summary.cacheReadTokens, 15400);
  assert.equal(summary.byModel[0].promptTokens, 16000);
  assert.equal(summary.byModel[0].freshPromptTokens, 600);
  assert.equal(summary.byModel[0].cacheReadTokens, 15400);
});

test("usage store records status-only responses for responses api routes", () => {
  const usage = createUsageStore();

  usage.recordLine("[10:20:11] [2026-06-20T18:20:11.250Z] req_be2wdmcg <- /v1/responses model=gpt-5.5 route=gpt-5.5 api=responses upstream_model=gpt-5.5 stream=true previous_response_id=- client_auth=codex_openai upstream_auth=codex_openai");
  usage.recordLine("[10:20:15] [2026-06-20T18:20:15.061Z] req_be2wdmcg <- upstream route=gpt-5.5 status=200");
  usage.recordLine("[10:20:15] [2026-06-20T18:20:15.061Z] req_be2wdmcg <- upstream route=gpt-5.5 usage=(none)");

  const events = usage.events();
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 200);
  assert.equal(events[0].api, "responses");
  assert.equal(events[0].totalTokens, 0);
  assert.equal(usage.summary().statusCounts["200"], 1);
});

test("usage store ignores local replay guards instead of counting them as model calls", () => {
  const usage = createUsageStore();

  usage.recordLine("[10:20:11] [2026-06-27T18:20:11.250Z] req_dup123 <- /v1/responses model=deepseek-v4-pro route=deepseek-v4-pro api=chat_completions upstream_model=deepseek-v4-pro stream=true previous_response_id=- client_auth=local upstream_auth=api_key");
  usage.recordLine("[10:20:11] [2026-06-27T18:20:11.251Z] req_dup123 !! duplicate-request-guard route=deepseek-v4-pro reason=pending");
  usage.recordLine("[10:20:12] [2026-06-27T18:20:12.250Z] req_idle45 <- /v1/responses model=deepseek-v4-pro route=deepseek-v4-pro api=chat_completions upstream_model=deepseek-v4-pro stream=true previous_response_id=resp_1 client_auth=local upstream_auth=api_key");
  usage.recordLine("[10:20:12] [2026-06-27T18:20:12.251Z] req_idle45 !! idle-resume-guard route=deepseek-v4-pro previous_response_id=resp_1");

  assert.equal(usage.events().length, 0);
  assert.equal(usage.summary().totalCalls, 0);
  assert.equal(usage.summary().totalTokens, 0);
});

test("usage summary keeps latest event per model and aggregates errors", () => {
  const usage = createUsageStore();

  usage.recordLine("[10:20:11] [2026-06-20T18:20:11.250Z] req_ok <- /v1/responses model=gpt-5.2 route=gpt-5.2 api=chat_completions upstream_model=kimi-k2.7-code stream=true previous_response_id=- client_auth=codex_openai upstream_auth=api_key");
  usage.recordLine("[10:20:15] [2026-06-20T18:20:15.061Z] req_ok <- upstream route=gpt-5.2 usage prompt=7 completion=8 total=15");
  usage.recordLine("[10:21:11] [2026-06-20T18:21:11.250Z] req_bad <- /v1/responses model=gpt-5.5 route=gpt-5.5 api=responses upstream_model=gpt-5.5 stream=true previous_response_id=- client_auth=codex_openai upstream_auth=codex_openai");
  usage.recordLine("[10:21:15] [2026-06-20T18:21:15.061Z] req_bad <- upstream route=gpt-5.5 status=429");

  const summary = usage.summary();
  assert.equal(summary.totalCalls, 2);
  assert.equal(summary.statusCounts["429"], 1);
  assert.equal(summary.byModel.length, 2);
  assert.equal(summary.byModel.find((item) => item.route === "gpt-5.2").totalTokens, 15);
});

test("usage summary separates the same Codex slot when upstream model changes", () => {
  const usage = createUsageStore();

  usage.recordLine("[10:30:00] [2026-06-27T02:30:00.000Z] req_old <- /v1/responses model=gpt-5.5 route=gpt-5.5 api=chat_completions upstream_model=mimo-v2.5 stream=true previous_response_id=- client_auth=codex_openai upstream_auth=api_key");
  usage.recordLine("[10:30:04] [2026-06-27T02:30:04.000Z] req_old <- upstream route=gpt-5.5 usage prompt=10 completion=2 total=12");
  usage.recordLine("[10:31:00] [2026-06-27T02:31:00.000Z] req_new <- /v1/responses model=gpt-5.5 route=gpt-5.5 api=chat_completions upstream_model=mimo-v2.5-pro stream=true previous_response_id=- client_auth=codex_openai upstream_auth=api_key");
  usage.recordLine("[10:31:03] [2026-06-27T02:31:03.000Z] req_new <- upstream route=gpt-5.5 usage prompt=20 completion=4 total=24");

  const summary = usage.summary();
  assert.equal(summary.byModel.length, 2);
  assert.deepEqual(
    summary.byModel.map((item) => item.upstreamModel).sort(),
    ["mimo-v2.5", "mimo-v2.5-pro"],
  );
  assert.equal(summary.byModel.find((item) => item.upstreamModel === "mimo-v2.5")?.calls, 1);
  assert.equal(summary.byModel.find((item) => item.upstreamModel === "mimo-v2.5-pro")?.calls, 1);
});

test("usage summary marks whether an upstream row is still the current route", () => {
  const usage = createUsageStore();

  usage.recordLine("[10:30:00] [2026-06-27T02:30:00.000Z] req_old <- /v1/responses model=gpt-5.5 route=gpt-5.5 api=chat_completions upstream_model=mimo-v2.5 stream=true previous_response_id=- client_auth=codex_openai upstream_auth=api_key");
  usage.recordLine("[10:30:04] [2026-06-27T02:30:04.000Z] req_old <- upstream route=gpt-5.5 usage prompt=10 completion=2 total=12");
  usage.recordLine("[10:31:00] [2026-06-27T02:31:00.000Z] req_new <- /v1/responses model=gpt-5.5 route=gpt-5.5 api=chat_completions upstream_model=mimo-v2.5-pro stream=true previous_response_id=- client_auth=codex_openai upstream_auth=api_key");
  usage.recordLine("[10:31:03] [2026-06-27T02:31:03.000Z] req_new <- upstream route=gpt-5.5 usage prompt=20 completion=4 total=24");

  const summary = usage.summary({
    routes: [
      {
        id: "gpt-5.5",
        api: "chat_completions",
        model: "mimo-v2.5-pro",
      },
    ],
  });

  assert.equal(summary.byModel.find((item) => item.upstreamModel === "mimo-v2.5-pro")?.isCurrentRoute, true);
  assert.equal(summary.byModel.find((item) => item.upstreamModel === "mimo-v2.5")?.isCurrentRoute, false);
});

test("usage summary exposes current route totals separately from history", () => {
  const usage = createUsageStore();

  usage.recordLine("[10:30:00] [2026-06-27T02:30:00.000Z] req_old <- /v1/responses model=gpt-5.5 route=gpt-5.5 api=chat_completions upstream_model=mimo-v2.5 stream=true previous_response_id=- client_auth=codex_openai upstream_auth=api_key");
  usage.recordLine("[10:30:04] [2026-06-27T02:30:04.000Z] req_old <- upstream route=gpt-5.5 usage prompt=10 completion=2 total=12");
  usage.recordLine("[10:31:00] [2026-06-27T02:31:00.000Z] req_new <- /v1/responses model=gpt-5.5 route=gpt-5.5 api=chat_completions upstream_model=mimo-v2.5-pro stream=true previous_response_id=- client_auth=codex_openai upstream_auth=api_key");
  usage.recordLine("[10:31:03] [2026-06-27T02:31:03.000Z] req_new <- upstream route=gpt-5.5 usage prompt=20 completion=4 total=24");

  const summary = usage.summary({
    routes: [
      {
        id: "gpt-5.5",
        api: "chat_completions",
        model: "mimo-v2.5-pro",
      },
    ],
  });

  assert.equal(summary.totalTokens, 36);
  assert.equal(summary.current.totalCalls, 1);
  assert.equal(summary.current.totalTokens, 24);
  assert.equal(summary.current.byModel.length, 1);
  assert.equal(summary.current.byModel[0].upstreamModel, "mimo-v2.5-pro");
  assert.equal(summary.current.events.length, 1);
  assert.equal(summary.current.latest.upstreamModel, "mimo-v2.5-pro");
  assert.equal(summary.history.totalCalls, 1);
  assert.equal(summary.history.totalTokens, 12);
  assert.equal(summary.history.byModel.length, 1);
  assert.equal(summary.history.byModel[0].upstreamModel, "mimo-v2.5");
});

test("usage summary treats all records as current when no active routes are available", () => {
  const usage = createUsageStore();

  usage.recordLine("[10:30:00] [2026-06-27T02:30:00.000Z] req_only <- /v1/responses model=gpt-5.5 route=gpt-5.5 api=responses upstream_model=gpt-5.5 stream=true previous_response_id=- client_auth=codex_openai upstream_auth=codex_openai");
  usage.recordLine("[10:30:04] [2026-06-27T02:30:04.000Z] req_only <- upstream route=gpt-5.5 usage prompt=10 completion=2 total=12");

  const summary = usage.summary();

  assert.equal(summary.current.totalCalls, 1);
  assert.equal(summary.current.totalTokens, 12);
  assert.equal(summary.history.totalCalls, 0);
  assert.equal(summary.history.totalTokens, 0);
});

test("usage store records request-scoped upstream errors", () => {
  const usage = createUsageStore();

  usage.recordLine("[06:05:54] [2026-06-20T22:05:54.426Z] req_pbarion <- /v1/responses model=gpt-5.5 route=gpt-5.5 api=responses upstream_model=gpt-5.5 stream=true previous_response_id=- client_auth=codex_openai upstream_auth=codex_openai");
  usage.recordLine("[06:05:54] [2026-06-20T22:05:54.426Z] req_pbarion -> upstream route=gpt-5.5 api=responses upstream_model=gpt-5.5 url=https://api.openai.com/v1/responses");
  usage.recordLine("[06:05:54] [2026-06-20T22:05:54.960Z] req_pbarion !! upstream route=gpt-5.5 status=599 error=TypeError: fetch failed cause=UND_ERR_CONNECT_TIMEOUT");

  const events = usage.events();
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 599);
  assert.equal(events[0].error, "TypeError: fetch failed");
  assert.equal(events[0].errorCause, "UND_ERR_CONNECT_TIMEOUT");
  assert.equal(usage.summary().byModel[0].errors, 1);
});

test("usage store records upstream error categories from router logs", () => {
  const usage = createUsageStore();

  usage.recordLine("[06:06:54] [2026-06-20T22:06:54.426Z] req_limit42 <- /v1/responses model=deepseek-v4-pro route=deepseek-v4-pro api=chat_completions upstream_model=deepseek-v4-pro stream=true previous_response_id=- client_auth=local upstream_auth=api_key");
  usage.recordLine("[06:06:55] [2026-06-20T22:06:55.960Z] req_limit42 !! upstream route=deepseek-v4-pro status=429 error=Upstream returned HTTP 429 error_type=rate_limit cause=provider_rate_limited");

  const events = usage.events();
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 429);
  assert.equal(events[0].error, "Upstream returned HTTP 429");
  assert.equal(events[0].errorType, "rate_limit");
  assert.equal(events[0].errorCause, "provider_rate_limited");
  assert.equal(usage.summary().byModel[0].lastErrorType, "rate_limit");
});

test("usage store preserves smart routing exclusion diagnostics on request events", () => {
  const usage = createUsageStore();

  usage.recordLine("[10:23:10] [2026-07-05T10:23:10.100Z] req_smart42 !! smart-route-exclusions phase=auto-select excluded=cb-code:budget,cb-old:health+budget");
  usage.recordLine("[10:23:10] [2026-07-05T10:23:10.101Z] req_smart42 <- /v1/responses model=cb-chat route=cb-chat api=chat_completions upstream_model=qwen-plus stream=true previous_response_id=- client_auth=local upstream_auth=api_key");
  usage.recordLine("[10:23:10] [2026-07-05T10:23:10.150Z] req_smart42 -> upstream route=cb-chat api=chat_completions upstream_model=qwen-plus url=https://api.example.test/v1/chat/completions");
  usage.recordLine("[10:23:11] [2026-07-05T10:23:11.200Z] req_smart42 <- upstream route=cb-chat usage prompt=12 completion=6 total=18");

  const events = usage.events();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].smartRouteExclusions, [
    { phase: "auto-select", route: "cb-code", reasons: ["budget"] },
    { phase: "auto-select", route: "cb-old", reasons: ["health", "budget"] },
  ]);
});

test("usage summary flags zero-token fast failures separately from token usage", () => {
  const usage = createUsageStore();

  usage.recordLine("[10:20:11] [2026-06-27T15:27:32.000Z] req_fast503 <- /v1/responses model=gpt-5.5 route=gpt-5.5 api=responses upstream_model=gpt-5.5 stream=true previous_response_id=- client_auth=codex_openai upstream_auth=codex_openai");
  usage.recordLine("[10:20:11] [2026-06-27T15:27:32.006Z] req_fast503 !! upstream route=gpt-5.5 status=503 error=Upstream returned HTTP 503 error_type=provider_unavailable cause=no_available_channel");

  const summary = usage.summary();
  assert.equal(summary.totalCalls, 1);
  assert.equal(summary.totalTokens, 0);
  assert.equal(summary.byModel[0].errors, 1);
  assert.equal(summary.byModel[0].fastZeroTokenErrors, 1);
});

test("usage store keeps response route metadata when status arrives before usage", () => {
  const usage = createUsageStore();

  usage.recordLine("[10:22:11] [2026-06-20T18:22:11.250Z] req_gpt55 <- /v1/responses model=gpt-5.5 route=gpt-5.5 api=responses upstream_model=gpt-5.5 stream=true previous_response_id=- client_auth=codex_openai upstream_auth=codex_openai");
  usage.recordLine("[10:22:11] [2026-06-20T18:22:11.260Z] req_gpt55 -> upstream route=gpt-5.5 api=responses upstream_model=gpt-5.5 url=https://chatgpt.com/backend-api/codex/responses");
  usage.recordLine("[10:22:12] [2026-06-20T18:22:12.061Z] req_gpt55 <- upstream route=gpt-5.5 status=200");
  usage.recordLine("[10:22:12] [2026-06-20T18:22:12.062Z] req_gpt55 <- upstream route=gpt-5.5 usage prompt=12 completion=34 total=46");

  const events = usage.events();
  assert.equal(events.length, 1);
  assert.equal(events[0].codexModel, "gpt-5.5");
  assert.equal(events[0].api, "responses");
  assert.equal(events[0].upstreamModel, "gpt-5.5");
  assert.equal(events[0].promptTokens, 12);
  assert.equal(events[0].completionTokens, 34);
  assert.equal(events[0].totalTokens, 46);
});

test("usage store can rebuild summary from saved events", () => {
  const usage = createUsageStore({
    initialEvents: [
      {
        requestId: "req_saved",
        startedAt: "2026-06-20T18:20:11.250Z",
        finishedAt: "2026-06-20T18:20:15.061Z",
        codexModel: "gpt-5.3-codex",
        route: "gpt-5.3-codex",
        api: "chat_completions",
        upstreamModel: "deepseek-v4-flash",
        status: 200,
        promptTokens: 2,
        completionTokens: 3,
        totalTokens: 5,
      },
    ],
  });

  assert.equal(usage.events().length, 1);
  assert.equal(usage.summary().totalTokens, 5);
  assert.equal(usage.summary().byModel[0].upstreamModel, "deepseek-v4-flash");
});

test("usage budget evaluation is empty by default and reports global route and provider alerts", () => {
  const usage = createUsageStore();

  usage.recordLine("[10:15:31] [2026-07-01T18:15:31.858Z] req_budget1 <- /v1/responses model=gpt-5.2 route=cb-kimi-k2-7-code api=chat_completions upstream_model=kimi-k2.7-code stream=true previous_response_id=- client_auth=local upstream_auth=api_key");
  usage.recordLine("[10:15:35] [2026-07-01T18:15:35.184Z] req_budget1 <- upstream route=cb-kimi-k2-7-code usage prompt=80 cached=20 fresh=60 completion=25 total=105");
  usage.recordLine("[10:16:31] [2026-07-01T18:16:31.858Z] req_budget2 <- /v1/responses model=gpt-5.4-mini route=cb-deepseek-v4-pro api=chat_completions upstream_model=deepseek-v4-pro stream=true previous_response_id=- client_auth=local upstream_auth=api_key");
  usage.recordLine("[10:16:35] [2026-07-01T18:16:35.184Z] req_budget2 <- upstream route=cb-deepseek-v4-pro usage prompt=30 completion=10 total=40");

  const routes = [
    { id: "cb-kimi-k2-7-code", model: "kimi-k2.7-code", api: "chat_completions", provider: "kimi" },
    { id: "cb-deepseek-v4-pro", model: "deepseek-v4-pro", api: "chat_completions", provider: "deepseek" },
  ];
  const summary = usage.summary({ routes });

  assert.deepEqual(evaluateUsageBudgets(summary, undefined, { routes, now: "2026-07-01T23:00:00.000Z" }), []);

  const alerts = evaluateUsageBudgets(
    summary,
    {
      global: { dailyTokenLimit: 120, dailyCallLimit: 3 },
      routes: { "cb-kimi-k2-7-code": { dailyTokenLimit: 100 } },
      providers: { deepseek: { dailyCallLimit: 1 } },
    },
    { routes, now: "2026-07-01T23:00:00.000Z" },
  );

  assert.equal(summary.byModel.length, 2);
  assert.equal(alerts.find((item) => item.scope === "global")?.status, "exceeded");
  assert.equal(alerts.find((item) => item.scope === "route")?.label, "cb-kimi-k2-7-code");
  assert.equal(alerts.find((item) => item.scope === "route")?.status, "exceeded");
  assert.equal(alerts.find((item) => item.scope === "provider")?.label, "deepseek");
  assert.equal(alerts.find((item) => item.scope === "provider")?.status, "warning");
  assert.equal(alerts.find((item) => item.scope === "provider")?.remaining, 0);
  assert.match(alerts.find((item) => item.scope === "provider")?.message || "", /剩余 0 次请求/);
  assert.match(alerts.find((item) => item.scope === "global")?.message || "", /已用比例 121%/);
  assert.match(alerts.find((item) => item.scope === "route")?.message || "", /已用比例 105%/);
  assert.match(alerts.find((item) => item.scope === "provider")?.message || "", /已用比例 100%/);
});

test("usage cost estimation uses configured global route and provider token prices", () => {
  const usage = createUsageStore();

  usage.recordLine("[10:15:31] [2026-07-01T18:15:31.858Z] req_cost1 <- /v1/responses model=gpt-5.2 route=cb-kimi-k2-7-code api=chat_completions upstream_model=kimi-k2.7-code stream=true previous_response_id=- client_auth=local upstream_auth=api_key");
  usage.recordLine("[10:15:35] [2026-07-01T18:15:35.184Z] req_cost1 <- upstream route=cb-kimi-k2-7-code usage prompt=1000 cached=200 fresh=800 completion=300 total=1300");
  usage.recordLine("[10:16:31] [2026-07-01T18:16:31.858Z] req_cost2 <- /v1/responses model=gpt-5.4-mini route=cb-deepseek-v4-pro api=chat_completions upstream_model=deepseek-v4-pro stream=true previous_response_id=- client_auth=local upstream_auth=api_key");
  usage.recordLine("[10:16:35] [2026-07-01T18:16:35.184Z] req_cost2 <- upstream route=cb-deepseek-v4-pro usage prompt=500 completion=100 total=600");

  const routes = [
    { id: "cb-kimi-k2-7-code", model: "kimi-k2.7-code", api: "chat_completions", provider: "kimi" },
    { id: "cb-deepseek-v4-pro", model: "deepseek-v4-pro", api: "chat_completions", provider: "deepseek" },
  ];
  const summary = usage.summary({ routes });

  assert.equal(estimateUsageCosts(summary, {}, { routes, now: "2026-07-01T23:00:00.000Z" }).hasRates, false);

  const estimate = estimateUsageCosts(
    summary,
    {
      global: { inputCostPerMillion: 1, cacheCostPerMillion: 0.5, outputCostPerMillion: 2 },
      routes: { "cb-kimi-k2-7-code": { inputCostPerMillion: 10, cacheCostPerMillion: 1, outputCostPerMillion: 20 } },
      providers: { deepseek: { inputCostPerMillion: 2, outputCostPerMillion: 4 } },
    },
    { routes, now: "2026-07-01T23:00:00.000Z" },
  );

  assert.equal(estimate.hasRates, true);
  assert.equal(roundCost(estimate.global.totalCost), 0.0022);
  assert.equal(estimate.routes[0].label, "cb-kimi-k2-7-code");
  assert.equal(roundCost(estimate.routes[0].totalCost), 0.0142);
  assert.equal(estimate.providers[0].label, "deepseek");
  assert.equal(roundCost(estimate.providers[0].totalCost), 0.0014);
  assert.equal(roundCost(estimate.totalCost), 0.0142);
});

test("usage budget evaluation reports daily estimated cost alerts", () => {
  const usage = createUsageStore();

  usage.recordLine("[10:15:31] [2026-07-01T18:15:31.858Z] req_costbudget1 <- /v1/responses model=gpt-5.2 route=cb-kimi-k2-7-code api=chat_completions upstream_model=kimi-k2.7-code stream=true previous_response_id=- client_auth=local upstream_auth=api_key");
  usage.recordLine("[10:15:35] [2026-07-01T18:15:35.184Z] req_costbudget1 <- upstream route=cb-kimi-k2-7-code usage prompt=1000 cached=200 fresh=800 completion=300 total=1300");
  usage.recordLine("[10:16:31] [2026-07-01T18:16:31.858Z] req_costbudget2 <- /v1/responses model=gpt-5.4-mini route=cb-deepseek-v4-pro api=chat_completions upstream_model=deepseek-v4-pro stream=true previous_response_id=- client_auth=local upstream_auth=api_key");
  usage.recordLine("[10:16:35] [2026-07-01T18:16:35.184Z] req_costbudget2 <- upstream route=cb-deepseek-v4-pro usage prompt=500 completion=100 total=600");

  const routes = [
    { id: "cb-kimi-k2-7-code", model: "kimi-k2.7-code", api: "chat_completions", provider: "kimi" },
    { id: "cb-deepseek-v4-pro", model: "deepseek-v4-pro", api: "chat_completions", provider: "deepseek" },
  ];
  const alerts = evaluateUsageBudgets(
    usage.summary({ routes }),
    {
      global: {
        dailyCostLimit: 0.002,
        inputCostPerMillion: 1,
        cacheCostPerMillion: 0.5,
        outputCostPerMillion: 2,
      },
      routes: {
        "cb-kimi-k2-7-code": {
          dailyCostLimit: 0.01,
          inputCostPerMillion: 10,
          cacheCostPerMillion: 1,
          outputCostPerMillion: 20,
        },
      },
      providers: {
        deepseek: {
          dailyCostLimit: 0.0015,
          inputCostPerMillion: 2,
          outputCostPerMillion: 4,
        },
      },
    },
    { routes, now: "2026-07-01T23:00:00.000Z" },
  );

  const globalAlert = alerts.find((item) => item.scope === "global");
  const routeAlert = alerts.find((item) => item.scope === "route");
  const providerAlert = alerts.find((item) => item.scope === "provider");
  assert.equal(globalAlert?.metric, "cost");
  assert.equal(globalAlert?.status, "exceeded");
  assert.equal(roundCost(globalAlert?.used), 0.0022);
  assert.match(globalAlert?.message || "", /今日费用/);
  assert.equal(routeAlert?.status, "exceeded");
  assert.equal(roundCost(routeAlert?.used), 0.0142);
  assert.equal(providerAlert?.status, "warning");
  assert.equal(roundCost(providerAlert?.used), 0.0014);
  assert.match(providerAlert?.message || "", /剩余 0\.0001 费用单位/);
});

function roundCost(value) {
  return Number(Number(value || 0).toFixed(6));
}
