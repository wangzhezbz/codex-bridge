import test from "node:test";
import assert from "node:assert/strict";
import { createUsageStore, evaluateUsageBudgets, estimateUsageCosts } from "../desktop/usage.mjs";
import { handleResponsesRequest } from "../src/upstream.js";
import { createUsageBudgetGuard } from "../src/usage-budget-guard.js";
import { ResponseHistory } from "../src/history.js";

const oldFlashRoute = "cb-remote-deepseek-deepseek-flash";
const newFlashRoute = "cb-deepseek-v4-1-flash";
const migrationEvent = {
  requestId: "req_migrated", route: oldFlashRoute, codexModel: oldFlashRoute,
  api: "responses", upstreamModel: "deepseek-flash", status: 200,
  startedAt: "2026-09-23T04:00:00.000Z", finishedAt: "2026-09-23T04:00:01.000Z",
  promptTokens: 1000000, freshPromptTokens: 1000000, completionTokens: 1, totalTokens: 1000001,
};
const migratedRoute = { id: newFlashRoute, model: "deepseek-flash", api: "responses", provider: "deepseek" };

test("promoted Flash keeps historical use in current route budgets without rewriting events", () => {
  const store = createUsageStore({ initialEvents: [migrationEvent] });
  const before = structuredClone(store.events());
  const routes = [migratedRoute];
  const summary = store.summary({ routes });
  assert.equal(summary.current.totalCalls, 1);
  assert.equal(summary.current.totalTokens, 1000001);
  assert.equal(summary.byModel[0].isCurrentRoute, true);
  const budgets = { routes: { [newFlashRoute]: { dailyCallLimit: 1, inputCostPerMillion: 10 } }, providers: { deepseek: { dailyCallLimit: 1 } } };
  const options = { routes, now: "2026-09-23T04:00:02.000Z" };
  const alerts = evaluateUsageBudgets(summary, budgets, options);
  assert.deepEqual(alerts.map(alert => alert.scope).sort(), ["provider", "route"]);
  assert.equal(estimateUsageCosts(summary, budgets, options).totalCost, 10);
  assert.deepEqual(store.events(), before);
  assert.equal(summary.current.events[0].route, oldFlashRoute);
});

test("an explicitly configured old Flash slot owns its own history and prices", () => {
  const store = createUsageStore({ initialEvents: [migrationEvent] });
  const routes = [migratedRoute, { ...migratedRoute, id: oldFlashRoute, provider: "explicit-provider" }];
  const summary = store.summary({ routes });
  const budgets = { routes: { [newFlashRoute]: { inputCostPerMillion: 10 }, [oldFlashRoute]: { inputCostPerMillion: 30 } }, providers: { deepseek: { dailyCallLimit: 1 }, "explicit-provider": { dailyCallLimit: 1 } } };
  const options = { routes, now: "2026-09-23T04:00:02.000Z" };
  assert.equal(estimateUsageCosts(summary, budgets, options).totalCost, 30);
  const alerts = evaluateUsageBudgets(summary, budgets, options);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, /explicit-provider/);
});

test("a promoted ID never attributes a different upstream model or API to Flash", () => {
  for (const change of [{ upstreamModel: "deepseek-v4-pro" }, { api: "chat_completions" }]) {
    const store = createUsageStore({ initialEvents: [{ ...migrationEvent, ...change }] });
    const summary = store.summary({ routes: [migratedRoute] });
    assert.equal(summary.current.totalCalls, 0);
    assert.equal(summary.history.totalCalls, 1);
  }
});

test("a canonical budget still prices an active legacy route before Router regeneration", () => {
  const store = createUsageStore({ initialEvents: [migrationEvent] });
  const legacyRoute = { id: oldFlashRoute, model: "deepseek-flash", api: "responses", provider: "deepseek" };
  const routes = [legacyRoute];
  const summary = store.summary({ routes });
  const budgets = { routes: { [newFlashRoute]: { dailyCallLimit: 1, inputCostPerMillion: 10 } } };
  const options = { routes, now: "2026-09-23T04:00:02.000Z" };
  assert.equal(summary.current.totalCalls, 1);
  assert.equal(estimateUsageCosts(summary, budgets, options).totalCost, 10);
  const alerts = evaluateUsageBudgets(summary, budgets, options);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].scope, "route");
  assert.equal(alerts[0].label, newFlashRoute);
  assert.equal(store.events()[0].route, oldFlashRoute);
});

test("transitional budget matching keeps explicit old and new route slots separate", () => {
  const canonicalEvent = { ...migrationEvent, requestId: "req_new_slot", route: newFlashRoute, codexModel: newFlashRoute };
  const store = createUsageStore({ initialEvents: [migrationEvent, canonicalEvent] });
  const routes = [
    { id: oldFlashRoute, model: "deepseek-flash", api: "responses", provider: "old-provider" },
    { id: newFlashRoute, model: "deepseek-flash", api: "responses", provider: "new-provider" },
  ];
  const summary = store.summary({ routes });
  const budgets = { routes: {
    [oldFlashRoute]: { inputCostPerMillion: 30 },
    [newFlashRoute]: { inputCostPerMillion: 10 },
  } };
  const estimate = estimateUsageCosts(summary, budgets, { routes, now: "2026-09-23T04:00:02.000Z" });
  assert.equal(estimate.totalCost, 40);
  assert.deepEqual(estimate.routes.map(item => [item.label, item.totalCost]).sort(), [
    [newFlashRoute, 10], [oldFlashRoute, 30],
  ].sort());
});

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

test("usage store bounds abandoned pending requests and evicts the oldest metadata", () => {
  const usage = createUsageStore({ maxPending: 2, pruneInterval: 1_000 });
  for (const suffix of ["a", "b", "c"]) {
    usage.recordLine(`[2026-08-01T00:00:00.000Z] req_${suffix} <- /v1/responses model=slot-${suffix} route=route-${suffix} api=responses upstream_model=model-${suffix} stream=true`);
  }
  usage.recordLine("[2026-08-01T00:00:01.000Z] req_b <- upstream route=route-b usage prompt=1 completion=1 total=2");
  usage.recordLine("[2026-08-01T00:00:01.000Z] req_a <- upstream route=route-a usage prompt=1 completion=1 total=2");
  const byId = new Map(usage.events().map((event) => [event.requestId, event]));
  assert.equal(byId.get("req_b").codexModel, "slot-b");
  assert.equal(byId.get("req_a").codexModel, "route-a");
  assert.equal(Object.hasOwn(byId.get("req_a"), "_pendingTouchedAt"), false);
});

test("usage store expires abandoned pending metadata after its TTL", () => {
  let timestamp = 0;
  const usage = createUsageStore({
    maxPending: 10,
    pendingTtlMs: 50,
    pruneInterval: 1,
    now: () => timestamp,
  });
  usage.recordLine("[2026-08-01T00:00:00.000Z] req_old <- /v1/responses model=old-slot route=old-route api=responses upstream_model=old-model stream=true");
  timestamp = 100;
  usage.recordLine("[2026-08-01T00:00:00.100Z] req_new <- /v1/responses model=new-slot route=new-route api=responses upstream_model=new-model stream=true");
  usage.recordLine("[2026-08-01T00:00:01.000Z] req_old <- upstream route=old-route usage prompt=1 completion=1 total=2");
  assert.equal(usage.events()[0].codexModel, "old-route");
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
  assert.equal(alerts.find((item) => item.scope === "provider")?.status, "exceeded");
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

test("desktop budgets report reached limits consistently for calls tokens and cost", () => {
  const usage = createUsageStore();
  const routes = [{ id: "cap-route", provider: "cap-provider" }];
  const options = { routes, now: "2026-09-06T12:00:00.000Z" };
  for (let index = 0; index < 10; index += 1) {
    usage.recordLine(`[2026-09-06T10:00:00.000Z] req_cap${index} <- upstream route=cap-route usage prompt=1000 cached=0 fresh=1000 completion=0 total=1000`);
  }
  for (const budget of [
    { dailyCallLimit: 10 },
    { dailyTokenLimit: 10000 },
    { dailyCostLimit: 1, inputCostPerMillion: 100 },
  ]) {
    const alerts = evaluateUsageBudgets(usage.summary({ routes }), {
      global: budget, routes: { "cap-route": budget }, providers: { "cap-provider": budget },
    }, options);
    assert.equal(alerts.length, 3);
    for (const alert of alerts) {
      assert.equal(alert.ratio, 1);
      assert.equal(alert.remaining, 0);
      assert.equal(alert.status, "exceeded");
      assert.doesNotMatch(alert.message, /接近上限/);
    }
  }
});

test("desktop cost alerts retain small nonzero amounts in every budget scope", () => {
  const usage = createUsageStore();
  usage.recordLine("[2026-09-06T10:00:00.000Z] req_smallbudget <- upstream route=cb-small usage prompt=1000 cached=0 fresh=0 cache_write=1000 completion=0 total=1000");
  const routes = [{ id: "cb-small", provider: "custom" }];
  const options = { routes, now: "2026-09-06T12:00:00.000Z" };
  for (const { limit, status, remaining } of [
    { limit: 1e-10, status: "exceeded", remaining: 0 },
    { limit: 4.5e-10, status: "warning", remaining: 5e-11 },
    { limit: 5e-10, status: "warning", remaining: 1e-10 },
  ]) {
    const rates = { dailyCostLimit: limit, cacheWriteCostPerMillion: 4e-7 };
    const alerts = evaluateUsageBudgets(usage.summary({ routes }), {
      global: rates, routes: { "cb-small": rates }, providers: { custom: rates },
    }, options);
    assert.deepEqual(alerts.map((alert) => alert.scope).sort(), ["global", "provider", "route"]);
    for (const alert of alerts) {
      assert.equal(alert.status, status);
      assert.equal(alert.used, 4e-10);
      assert.equal(alert.limit, limit);
      assert.equal(alert.remaining, remaining);
      assert.doesNotMatch(alert.message, /已用 0 \/ 0/);
    }
  }
});

test("desktop estimates separate ordinary input cache reads and configured cache writes", () => {
  const usage = createUsageStore();
  usage.recordLine("[2026-09-06T10:00:00.000Z] req_writecost <- upstream route=cb-astra usage prompt=200000 cached=80000 fresh=20000 cache_write=100000 completion=2000 total=202000");
  const options = { now: "2026-09-06T12:00:00.000Z" };
  for (const [cacheWriteCostPerMillion, expectedWriteCost, expectedTotal] of [[12.5, 1.25, 1.65], [0, 0, 0.4]]) {
    const budgets = { global: {
      dailyCostLimit: 0.3,
      inputCostPerMillion: 10,
      cacheCostPerMillion: 2,
      cache_write_cost_per_million: cacheWriteCostPerMillion,
      outputCostPerMillion: 20,
    } };
    const estimate = estimateUsageCosts(usage.summary(), budgets, options);
    assert.equal(estimate.global.inputCost, 0.2);
    assert.equal(estimate.global.cacheReadCost, 0.16);
    assert.equal(estimate.global.cacheWriteCost, expectedWriteCost);
    assert.equal(roundCost(estimate.global.totalCost), expectedTotal);
    assert.equal(evaluateUsageBudgets(usage.summary(), budgets, options)[0].used, expectedTotal);
    assert.equal(usage.summary().totalTokens, 202_000);
    assert.equal(usage.summary().cacheCreationTokens, 100_000);
  }
});

test("desktop mixed default write prices survive logs saved events and scope aggregation", () => {
  const usage = createUsageStore();
  usage.recordLine("[2026-09-06T10:00:00.000Z] req_officialwrite <- upstream route=cb-astra usage prompt=100000 cached=0 fresh=0 cache_write=100000 cache_write_rate=openai completion=0 total=100000");
  usage.recordLine("[2026-09-06T10:01:00.000Z] req_otherwrite <- upstream route=cb-astra usage prompt=100000 cached=0 fresh=0 cache_write=100000 cache_write_rate=input completion=0 total=100000");
  usage.recordLine("[2026-09-06T10:02:00.000Z] req_legacywrite <- upstream route=cb-astra usage prompt=100000 cached=0 fresh=0 cache_write=100000 completion=0 total=100000");
  const restored = createUsageStore({ initialEvents: usage.events() });
  const rates = { inputCostPerMillion: 10, cacheCostPerMillion: 1 };
  const estimate = estimateUsageCosts(restored.summary(), {
    global: rates,
    routes: { "cb-astra": rates },
    providers: { openai: rates },
  }, { routes: [{ id: "cb-astra", provider: "openai" }], now: "2026-09-06T12:00:00.000Z" });
  assert.equal(restored.events().length, 3);
  for (const scope of [estimate.global, estimate.routes[0], estimate.providers[0]]) {
    assert.equal(roundCost(scope.totalCost), 2.35);
    assert.equal(roundCost(scope.cacheWriteCost), 2.35);
    assert.equal(scope.inputCost, 0);
    assert.equal(scope.cacheReadCost, 0);
  }
  assert.equal(roundCost(estimate.cacheWriteCost), 2.35);
});

test("stored write usage without an explicit fresh count is not billed twice", () => {
  const usage = createUsageStore({ initialEvents: [{
    requestId: "req_restoredwrite",
    route: "cb-astra",
    startedAt: "2026-09-06T10:00:00.000Z",
    promptTokens: 100_000,
    cacheCreationTokens: 100_000,
    cacheWriteRateKind: "openai",
    totalTokens: 100_000,
  }] });
  const estimate = estimateUsageCosts(usage.summary(), { global: { inputCostPerMillion: 10 } }, {
    now: "2026-09-06T12:00:00.000Z",
  });
  assert.equal(usage.events()[0].freshPromptTokens, 0);
  assert.equal(estimate.inputCost, 0);
  assert.equal(estimate.totalCost, 1.25);
});

test("Responses cache writes reach both the real log consumer and budget guard", async (t) => {
  const usage = createUsageStore();
  const guard = createUsageBudgetGuard();
  const config = { usageBudgets: { global: { dailyCostLimit: 1.1, inputCostPerMillion: 10, cacheCostPerMillion: 1 } } };
  const route = {
    id: "cb-astra",
    provider: "openai",
    api: "responses",
    model: "gpt-6-astra",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "test-key",
    authMode: "api_key",
  };
  t.mock.method(console, "log", (line) => usage.recordLine(line));
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    id: "resp_cache_write",
    object: "response",
    status: "completed",
    output: [],
    usage: { input_tokens: 100_000, output_tokens: 0, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 100_000 } },
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const response = { writeHead() {}, write() { return true; }, end() {} };
  await handleResponsesRequest({ model: "gpt-6-astra", input: "hello", stream: false }, route, new ResponseHistory(), response, {
    requestId: "req_writepath",
    onUpstreamUsage: (upstreamRoute, normalized) => guard.recordUsage(config, upstreamRoute, normalized),
  });
  const [event] = usage.events();
  assert.equal(event.cacheCreationTokens, 100_000);
  assert.equal(event.freshPromptTokens, 0);
  assert.equal(event.cacheWriteRateKind, "openai");
  const estimate = estimateUsageCosts(usage.summary(), config.usageBudgets);
  assert.equal(estimate.totalCost, 1.25);
  assert.equal(guard.check(config, route).ok, false);
  assert.equal(guard.check(config, route).used, 1.25);
});
