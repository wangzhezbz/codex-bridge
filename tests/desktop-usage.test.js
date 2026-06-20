import test from "node:test";
import assert from "node:assert/strict";
import { createUsageStore } from "../desktop/usage.mjs";

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

test("usage store records status-only responses for responses api routes", () => {
  const usage = createUsageStore();

  usage.recordLine("[10:20:11] [2026-06-20T18:20:11.250Z] req_be2wdmcg <- /v1/responses model=gpt-5.5 route=gpt-5.5 api=responses upstream_model=gpt-5.5 stream=true previous_response_id=- client_auth=codex_openai upstream_auth=codex_openai");
  usage.recordLine("[10:20:15] [2026-06-20T18:20:15.061Z] req_be2wdmcg <- upstream route=gpt-5.5 status=200");

  const events = usage.events();
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 200);
  assert.equal(events[0].api, "responses");
  assert.equal(events[0].totalTokens, 0);
  assert.equal(usage.summary().statusCounts["200"], 1);
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
