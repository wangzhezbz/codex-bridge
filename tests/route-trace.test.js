import test from "node:test";
import assert from "node:assert/strict";
import {
  createRouteTrace,
  recordRouteTraceEvent,
  routeDecisionSummaryForLog,
  routeTraceForLog,
} from "../src/route-trace.js";

test("route trace records stable adapter and upstream routing facts", () => {
  const trace = createRouteTrace({
    requestId: "req_trace_1",
    requestedModel: "gpt-5.4-mini",
    route: {
      id: "deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
      provider: "deepseek",
      api: "chat_completions",
      model: "deepseek-v4-pro",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-should-never-log",
      dropParams: ["response_format", "parallel_tool_calls"],
    },
  });

  assert.equal(trace.requestId, "req_trace_1");
  assert.equal(trace.requestedModel, "gpt-5.4-mini");
  assert.equal(trace.route.id, "deepseek-v4-pro");
  assert.equal(trace.contract.contractVersion, "adapter-contract-v1");
  assert.equal(trace.contract.adapter.id, "chat-deepseek");
  assert.equal(trace.contract.upstream.model, "deepseek-v4-pro");
});

test("route trace redacts secrets before log serialization", () => {
  const trace = createRouteTrace({
    requestId: "req_trace_2",
    requestedModel: "cb-kimi",
    route: {
      id: "cb-kimi",
      displayName: "Kimi",
      provider: "kimi",
      api: "chat_completions",
      model: "kimi-k2",
      baseUrl: "https://api.moonshot.cn/v1",
      apiKey: "sk-kimi-real-secret",
    },
  });

  recordRouteTraceEvent(trace, "upstream_request", {
    authorization: "Bearer sk-live-token",
    url: "https://api.moonshot.cn/v1/chat/completions",
    headers: {
      "x-api-key": "ak-hidden",
      harmless: "kept",
    },
  });

  const serialized = JSON.stringify(routeTraceForLog(trace));

  assert.equal(serialized.includes("sk-kimi-real-secret"), false);
  assert.equal(serialized.includes("sk-live-token"), false);
  assert.equal(serialized.includes("ak-hidden"), false);
  assert.equal(serialized.includes("kept"), true);
  assert.equal(serialized.includes("[REDACTED]"), true);
});

test("route trace exposes a compact route decision summary", () => {
  const trace = createRouteTrace({
    requestId: "req_decision_summary",
    requestedModel: "cb-chat",
    route: {
      id: "cb-code",
      displayName: "GPT Code",
      provider: "openai",
      api: "chat_completions",
      model: "gpt-code",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-should-never-log",
    },
  });

  recordRouteTraceEvent(trace, "route_decision", {
    decisionVersion: "route-decision-v2",
    requestKind: "normal",
    reason: "code_task",
    requestedModel: "cb-chat",
    originalRoute: "cb-chat",
    originalDisplayName: "GPT Chat",
    selectedRoute: "cb-code",
    selectedDisplayName: "GPT Code",
    selectedUpstreamModel: "gpt-code",
    selectedApi: "chat_completions",
    changed: true,
    skippedRoutes: [
      { routeId: "cb-slow", reason: "rate_limited", detail: "sk-secret-token" },
    ],
    userMessage: "Code task route: GPT Chat -> GPT Code.",
  });

  const summary = routeDecisionSummaryForLog(trace);

  assert.equal(
    summary,
    "req_decision_summary: code_task cb-chat -> cb-code upstream=gpt-code api=chat_completions changed=true skipped=cb-slow:rate_limited",
  );
  assert.doesNotMatch(summary, /sk-secret-token/);
});

test("route trace summary includes readable context switch compaction facts", () => {
  const trace = createRouteTrace({
    requestId: "req_context_switch",
    requestedModel: "cb-small",
    route: {
      id: "cb-small",
      displayName: "GPT Small",
      provider: "openai",
      api: "responses",
      model: "gpt-small",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-should-never-log",
    },
  });

  recordRouteTraceEvent(trace, "route_decision", {
    decisionVersion: "route-decision-v2",
    requestKind: "normal",
    reason: "manual_route",
    requestedModel: "cb-small",
    originalRoute: "cb-small",
    selectedRoute: "cb-small",
    selectedDisplayName: "GPT Small",
    selectedUpstreamModel: "gpt-small",
    selectedApi: "responses",
    changed: false,
  });
  recordRouteTraceEvent(trace, "context_switch_compact", {
    fromRouteId: "cb-large",
    fromDisplayName: "DeepSeek Long",
    toRouteId: "cb-small",
    toDisplayName: "GPT Small",
    estimatedTokens: 66044,
    targetInputBudget: 1331,
    fromContextWindow: 1000000,
    toContextWindow: 2048,
  });

  const summary = routeDecisionSummaryForLog(trace);

  assert.match(
    summary,
    /上下文切换压缩 DeepSeek Long -> GPT Small estimated=66044 budget=1331 context=1000000->2048/,
  );
  assert.doesNotMatch(summary, /sk-should-never-log/);
});
