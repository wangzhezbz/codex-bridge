import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRouterServer } from "../src/server.js";
import { createRouteSnapshot } from "../src/route-snapshot.js";

test("persisted route snapshot uses the exact old large route for compaction after Router restart", async () => {
  const fixture = historyFixture();
  const calls = [];
  const keyEnv = "CODEXBRIDGE_TEST_TASK4_RESTART_KEY";
  const previousKey = process.env[keyEnv];
  process.env[keyEnv] = "fake-task4-restart-key";
  const upstream = http.createServer(async (req, res) => {
    const body = await readJson(req);
    calls.push(body);
    const compact = /CONTEXT CHECKPOINT COMPACTION/.test(JSON.stringify(body.messages || []));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(chatCompletion(
      compact ? "chatcmpl_restart_compact" : `chatcmpl_restart_${calls.length}`,
      compact ? "Summary: persisted old route compacted after restart." : `answer:${body.model}`,
    )));
  });
  let firstRouter;
  let secondRouter;
  try {
    await listen(upstream);
    const config = switchConfig(serverUrl(upstream), { keyEnv });
    firstRouter = createRouterServer(config, { historyPath: fixture.historyPath });
    await listen(firstRouter);
    const first = await postResponses(firstRouter, {
      model: "cb-large",
      input: "persisted old large context marker ".repeat(4_000),
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    await close(firstRouter);
    firstRouter = null;

    secondRouter = createRouterServer(switchConfig(serverUrl(upstream), { keyEnv }), {
      historyPath: fixture.historyPath,
    });
    await listen(secondRouter);
    const second = await postResponses(secondRouter, {
      model: "cb-small",
      previous_response_id: first.body.id,
      input: "continue after Router restart on the smaller model",
    });

    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.deepEqual(calls.map((body) => body.model), [
      "large-model",
      "large-model",
      "small-model",
    ]);
    assert.match(JSON.stringify(calls[1].messages), /CONTEXT CHECKPOINT COMPACTION/);
    assert.doesNotMatch(
      JSON.stringify(calls[1].messages),
      /continue after Router restart on the smaller model/,
    );
    const targetPayload = JSON.stringify(calls[2].messages);
    assert.match(targetPayload, /persisted old route compacted after restart/);
    assert.doesNotMatch(targetPayload, /persisted old large context marker persisted old large context marker/);

    const third = await postResponses(secondRouter, {
      model: "cb-small",
      previous_response_id: second.body.id,
      input: "continue once more on the already switched route",
    });
    assert.equal(third.status, 200, JSON.stringify(third.body));
    assert.deepEqual(calls.map((body) => body.model), [
      "large-model",
      "large-model",
      "small-model",
      "small-model",
    ]);
    const persistedCompactedPayload = JSON.stringify(calls[3].messages);
    assert.match(persistedCompactedPayload, /persisted old route compacted after restart/);
    assert.match(persistedCompactedPayload, /continue after Router restart on the smaller model/);
    assert.doesNotMatch(
      persistedCompactedPayload,
      /persisted old large context marker persisted old large context marker/,
    );
  } finally {
    await closeIfListening(firstRouter);
    await closeIfListening(secondRouter);
    await closeIfListening(upstream);
    restoreEnv(keyEnv, previousKey);
    cleanupHistoryFixture(fixture);
  }
});

test("missing target contextWindow uses the adapter contract fallback for switch policy", async () => {
  const calls = [];
  const keyEnv = "CODEXBRIDGE_TEST_TASK4_ADAPTER_WINDOW_KEY";
  const previousKey = process.env[keyEnv];
  process.env[keyEnv] = "fake-task4-adapter-window-key";
  const upstream = http.createServer(async (req, res) => {
    const body = await readJson(req);
    const compact = /CONTEXT CHECKPOINT COMPACTION/.test(JSON.stringify(body.messages || []));
    calls.push({ model: body.model, compact });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(chatCompletion(
      `chatcmpl_adapter_window_${calls.length}`,
      compact ? "Summary: adapter contract fallback compacted." : `answer:${body.model}`,
    )));
  });
  let router;
  try {
    await listen(upstream);
    router = createRouterServer(switchConfig(serverUrl(upstream), {
      keyEnv,
      omitTargetContextWindow: true,
    }));
    await listen(router);
    const first = await postResponses(router, {
      model: "cb-large",
      input: "adapter fallback large context marker ".repeat(40_000),
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));

    const second = await postResponses(router, {
      model: "cb-small",
      previous_response_id: first.body.id,
      input: "switch using the adapter fallback window",
    });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.deepEqual(calls, [
      { model: "large-model", compact: false },
      { model: "large-model", compact: true },
      { model: "small-model", compact: false },
    ]);
  } finally {
    await closeIfListening(router);
    await closeIfListening(upstream);
    restoreEnv(keyEnv, previousKey);
  }
});

test("old-route compaction failure returns local 409 and calls neither target nor failover", async () => {
  const calls = [];
  const keyEnv = "CODEXBRIDGE_TEST_TASK4_FAILURE_KEY";
  const previousKey = process.env[keyEnv];
  process.env[keyEnv] = "fake-task4-failure-key";
  const upstream = http.createServer(async (req, res) => {
    const body = await readJson(req);
    const compact = /CONTEXT CHECKPOINT COMPACTION/.test(JSON.stringify(body.messages || []));
    calls.push({ model: body.model, compact });
    if (body.model === "large-model" && compact) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "SECRET_INTERNAL_COMPACT_FAILURE" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(chatCompletion(
      `chatcmpl_failure_${calls.length}`,
      `answer:${body.model}`,
    )));
  });
  let router;
  try {
    await listen(upstream);
    const config = switchConfig(serverUrl(upstream), {
      keyEnv,
      includeFallback: true,
      autoFailover: true,
    });
    router = createRouterServer(config);
    await listen(router);
    const first = await postResponses(router, {
      model: "cb-large",
      input: "context that must not cross an untrusted compact failure ".repeat(4_000),
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));

    const second = await postResponses(router, {
      model: "cb-small",
      previous_response_id: first.body.id,
      input: "switch only if the old model creates a real summary",
    });

    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(second.body?.error?.code, "context_switch_compaction_failed");
    assert.match(second.body?.error?.message || "", /旧模型|原模型|上一模型/);
    assert.doesNotMatch(JSON.stringify(second.body), /SECRET_INTERNAL_COMPACT_FAILURE/);

    const retry = await postResponses(router, {
      model: "cb-small",
      previous_response_id: first.body.id,
      input: "switch only if the old model creates a real summary",
    });
    assert.equal(retry.status, 409, JSON.stringify(retry.body));
    assert.equal(retry.body?.error?.code, "context_switch_compaction_failed");
    assert.deepEqual(calls, [
      { model: "large-model", compact: false },
      { model: "large-model", compact: true },
      { model: "large-model", compact: true },
    ]);
  } finally {
    await closeIfListening(router);
    await closeIfListening(upstream);
    restoreEnv(keyEnv, previousKey);
  }
});

test("old-route compaction with an empty summary fails closed before target routing", async () => {
  const calls = [];
  const keyEnv = "CODEXBRIDGE_TEST_TASK4_EMPTY_SUMMARY_KEY";
  const previousKey = process.env[keyEnv];
  process.env[keyEnv] = "fake-task4-empty-summary-key";
  const upstream = http.createServer(async (req, res) => {
    const body = await readJson(req);
    const compact = /CONTEXT CHECKPOINT COMPACTION/.test(JSON.stringify(body.messages || []));
    calls.push({ model: body.model, compact });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(chatCompletion(
      `chatcmpl_empty_${calls.length}`,
      compact ? "   \n\t" : `answer:${body.model}`,
    )));
  });
  let router;
  try {
    await listen(upstream);
    router = createRouterServer(switchConfig(serverUrl(upstream), {
      keyEnv,
      includeFallback: true,
      autoFailover: true,
    }));
    await listen(router);
    const first = await postResponses(router, {
      model: "cb-large",
      input: "context that requires a real compact summary ".repeat(4_000),
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));

    const second = await postResponses(router, {
      model: "cb-small",
      previous_response_id: first.body.id,
      input: "do not switch on an empty compact summary",
    });

    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(second.body?.error?.code, "context_switch_compaction_failed");
    assert.deepEqual(calls, [
      { model: "large-model", compact: false },
      { model: "large-model", compact: true },
    ]);
  } finally {
    await closeIfListening(router);
    await closeIfListening(upstream);
    restoreEnv(keyEnv, previousKey);
  }
});

test("tool continuation compacts only older complete turns and preserves the active call/result pair", async () => {
  const calls = [];
  const keyEnv = "CODEXBRIDGE_TEST_TASK4_TOOL_KEY";
  const previousKey = process.env[keyEnv];
  process.env[keyEnv] = "fake-task4-tool-key";
  const upstream = http.createServer(async (req, res) => {
    const body = await readJson(req);
    const compact = /CONTEXT CHECKPOINT COMPACTION/.test(JSON.stringify(body.messages || []));
    calls.push({ body, compact });
    res.writeHead(200, { "content-type": "application/json" });
    if (body.model === "large-model" && calls.length === 1) {
      res.end(JSON.stringify({
        id: "chatcmpl_active_tool",
        object: "chat.completion",
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_active_lookup",
              type: "function",
              function: { name: "lookup", arguments: "{\"query\":\"active\"}" },
            }],
          },
        }],
      }));
      return;
    }
    res.end(JSON.stringify(chatCompletion(
      compact ? "chatcmpl_tool_compact" : "chatcmpl_tool_target",
      compact ? "Summary: older complete turns only." : "tool continuation accepted",
    )));
  });
  let router;
  try {
    await listen(upstream);
    router = createRouterServer(switchConfig(serverUrl(upstream), { keyEnv }));
    await listen(router);
    const tool = {
      type: "function",
      name: "lookup",
      description: "Look up a fixture.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    };
    const first = await postResponses(router, {
      model: "cb-large",
      input: "older complete context marker ".repeat(4_000),
      tools: [tool],
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.output?.[0]?.type, "function_call");

    const second = await postResponses(router, {
      model: "cb-small",
      previous_response_id: first.body.id,
      input: [{
        type: "function_call_output",
        call_id: "call_active_lookup",
        output: "active lookup result",
      }],
      tools: [tool],
    });

    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.deepEqual(calls.map(({ body }) => body.model), [
      "large-model",
      "large-model",
      "small-model",
    ]);
    assert.equal(calls[1].compact, true);
    const targetMessages = calls[2].body.messages || [];
    const activeCall = targetMessages.find((message) =>
      message?.role === "assistant" &&
      message.tool_calls?.some((call) => call.id === "call_active_lookup"));
    const activeResult = targetMessages.find((message) =>
      message?.role === "tool" && message.tool_call_id === "call_active_lookup");
    assert.ok(activeCall, JSON.stringify(targetMessages));
    assert.equal(activeResult?.content, "active lookup result");
    const targetPayload = JSON.stringify(targetMessages);
    assert.match(targetPayload, /older complete turns only/);
    assert.doesNotMatch(targetPayload, /older complete context marker older complete context marker/);
  } finally {
    await closeIfListening(router);
    await closeIfListening(upstream);
    restoreEnv(keyEnv, previousKey);
  }
});

test("tool continuation switched to Responses preserves native function call and output items", async () => {
  const calls = [];
  const keyEnv = "CODEXBRIDGE_TEST_TASK4_NATIVE_TOOL_KEY";
  const previousKey = process.env[keyEnv];
  process.env[keyEnv] = "fake-task4-native-tool-key";
  const upstream = http.createServer(async (req, res) => {
    const body = await readJson(req);
    const compact = /CONTEXT CHECKPOINT COMPACTION/.test(JSON.stringify(
      body.messages || body.input || [],
    ));
    calls.push({ body, compact, path: req.url });
    res.writeHead(200, { "content-type": "application/json" });
    if (body.model === "large-model" && calls.length === 1) {
      res.end(JSON.stringify({
        id: "chatcmpl_native_active_tool",
        object: "chat.completion",
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_native_lookup",
              type: "function",
              function: { name: "lookup", arguments: "{\"query\":\"native\"}" },
            }],
          },
        }],
      }));
      return;
    }
    if (body.model === "large-model" && compact) {
      res.end(JSON.stringify(chatCompletion(
        "chatcmpl_native_compact",
        "Summary: native tool prefix compacted.",
      )));
      return;
    }
    res.end(JSON.stringify(responsesCompletion(
      "resp_native_target",
      "small-model",
      "native continuation accepted",
    )));
  });
  let router;
  try {
    await listen(upstream);
    router = createRouterServer(switchConfig(serverUrl(upstream), {
      keyEnv,
      targetApi: "responses",
    }));
    await listen(router);
    const tool = {
      type: "function",
      name: "lookup",
      description: "Look up a fixture.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    };
    const oldContext = "older native tool context marker ".repeat(4_000);
    const first = await postResponses(router, {
      model: "cb-large",
      input: oldContext,
      tools: [tool],
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));

    const second = await postResponses(router, {
      model: "cb-small",
      previous_response_id: first.body.id,
      input: [
        { role: "user", content: oldContext },
        {
          type: "function_call",
          call_id: "call_native_lookup",
          name: "lookup",
          arguments: "{\"query\":\"native\"}",
        },
        {
          type: "function_call_output",
          call_id: "call_native_lookup",
          output: "native lookup result",
        },
      ],
      tools: [tool],
    });

    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.deepEqual(calls.map(({ body }) => body.model), [
      "large-model",
      "large-model",
      "small-model",
    ]);
    const targetInput = calls[2].body.input || [];
    assert.ok(targetInput.some((item) =>
      item?.type === "function_call" &&
      item.call_id === "call_native_lookup" &&
      item.name === "lookup" &&
      item.arguments === "{\"query\":\"native\"}"));
    assert.ok(targetInput.some((item) =>
      item?.type === "function_call_output" &&
      item.call_id === "call_native_lookup" &&
      item.output === "native lookup result"));
    assert.doesNotMatch(JSON.stringify(targetInput), /assistant tool calls omitted/);
  } finally {
    await closeIfListening(router);
    await closeIfListening(upstream);
    restoreEnv(keyEnv, previousKey);
  }
});

test("full prior with a completed tool pair keeps a fresh user delta after exact prefix stripping", async () => {
  const calls = [];
  const keyEnv = "CODEXBRIDGE_TEST_TASK4_COMPLETED_TOOL_PREFIX_KEY";
  const previousKey = process.env[keyEnv];
  process.env[keyEnv] = "fake-task4-completed-tool-prefix-key";
  let priorRouteSnapshot = null;
  const oldContext = "completed tool prefix context marker ".repeat(4_000);
  const priorMessages = [
    { role: "system", content: "internal persisted tool guidance" },
    { role: "user", content: oldContext },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_completed_lookup",
        type: "function",
        function: { name: "lookup", arguments: "{\"query\":\"completed\"}" },
      }],
    },
    {
      role: "tool",
      tool_call_id: "call_completed_lookup",
      content: "completed lookup result",
    },
    { role: "assistant", content: "completed old tool turn" },
  ];
  const history = {
    get: () => priorMessages,
    getResponseMeta: () => ({
      routeId: "cb-large",
      routeSnapshot: priorRouteSnapshot,
    }),
    getResponse: () => null,
    health: () => ({ persistent: false }),
    recordTurn: () => {},
    record: () => {},
    recordResponse: () => {},
  };
  const upstream = http.createServer(async (req, res) => {
    const body = await readJson(req);
    const compact = /CONTEXT CHECKPOINT COMPACTION/.test(JSON.stringify(body.messages || []));
    calls.push({ body, compact });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(chatCompletion(
      `chatcmpl_completed_prefix_${calls.length}`,
      compact ? "Summary: completed tool history compacted." : `answer:${body.model}`,
    )));
  });
  let router;
  try {
    await listen(upstream);
    const config = switchConfig(serverUrl(upstream), { keyEnv });
    priorRouteSnapshot = createRouteSnapshot(config.models[0]);
    router = createRouterServer(config, { history });
    await listen(router);
    const response = await postResponses(router, {
      model: "cb-small",
      previous_response_id: "resp_completed_tool_prefix",
      input: [
        { role: "user", content: oldContext },
        {
          type: "function_call",
          call_id: "call_completed_lookup",
          name: "lookup",
          arguments: "{\"query\":\"completed\"}",
        },
        {
          type: "function_call_output",
          call_id: "call_completed_lookup",
          output: "completed lookup result",
        },
        { role: "assistant", content: "completed old tool turn" },
        { role: "user", content: "fresh user delta after completed tools" },
      ],
      tools: [{
        type: "function",
        name: "lookup",
        description: "Look up a fixture.",
        parameters: { type: "object", properties: {} },
      }],
    });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(calls.map(({ body }) => body.model), ["large-model", "small-model"]);
    const compactPayload = JSON.stringify(calls[0].body.messages || []);
    assert.doesNotMatch(compactPayload, /fresh user delta after completed tools/);
    const targetPayload = JSON.stringify(calls[1].body.messages || []);
    assert.match(targetPayload, /completed tool history compacted/);
    assert.match(targetPayload, /fresh user delta after completed tools/);
    assert.doesNotMatch(targetPayload, /completed tool prefix context marker completed tool prefix/);
  } finally {
    await closeIfListening(router);
    await closeIfListening(upstream);
    restoreEnv(keyEnv, previousKey);
  }
});

test("tool continuation fails closed when the protected call/result suffix exceeds target budget", async () => {
  const calls = [];
  const keyEnv = "CODEXBRIDGE_TEST_TASK4_TOOL_BUDGET_KEY";
  const previousKey = process.env[keyEnv];
  process.env[keyEnv] = "fake-task4-tool-budget-key";
  const upstream = http.createServer(async (req, res) => {
    const body = await readJson(req);
    calls.push(body.model);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl_over_budget_tool",
      object: "chat.completion",
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_over_budget",
            type: "function",
            function: { name: "lookup", arguments: "{\"query\":\"large\"}" },
          }],
        },
      }],
    }));
  });
  let router;
  try {
    await listen(upstream);
    router = createRouterServer(switchConfig(serverUrl(upstream), {
      keyEnv,
      includeFallback: true,
      autoFailover: true,
    }));
    await listen(router);
    const tool = {
      type: "function",
      name: "lookup",
      description: "Look up a fixture.",
      parameters: { type: "object", properties: {} },
    };
    const first = await postResponses(router, {
      model: "cb-large",
      input: "older protected suffix context ".repeat(4_000),
      tools: [tool],
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));

    const second = await postResponses(router, {
      model: "cb-small",
      previous_response_id: first.body.id,
      input: [{
        type: "function_call_output",
        call_id: "call_over_budget",
        output: "oversized protected tool output ".repeat(2_000),
      }],
      tools: [tool],
    });

    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(second.body?.error?.code, "context_switch_compaction_failed");
    assert.deepEqual(calls, ["large-model"]);
  } finally {
    await closeIfListening(router);
    await closeIfListening(upstream);
    restoreEnv(keyEnv, previousKey);
  }
});

test("switch fails closed when an active tool call is abandoned by a fresh user turn", async () => {
  const calls = [];
  const keyEnv = "CODEXBRIDGE_TEST_TASK4_ABANDONED_TOOL_KEY";
  const previousKey = process.env[keyEnv];
  process.env[keyEnv] = "fake-task4-abandoned-tool-key";
  const upstream = http.createServer(async (req, res) => {
    const body = await readJson(req);
    calls.push(body.model);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl_abandoned_tool",
      object: "chat.completion",
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_abandoned",
            type: "function",
            function: { name: "lookup", arguments: "{\"query\":\"abandoned\"}" },
          }],
        },
      }],
    }));
  });
  let router;
  try {
    await listen(upstream);
    router = createRouterServer(switchConfig(serverUrl(upstream), {
      keyEnv,
      includeFallback: true,
      autoFailover: true,
    }));
    await listen(router);
    const first = await postResponses(router, {
      model: "cb-large",
      input: "older abandoned tool context ".repeat(4_000),
      tools: [{
        type: "function",
        name: "lookup",
        description: "Look up a fixture.",
        parameters: { type: "object", properties: {} },
      }],
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));

    const second = await postResponses(router, {
      model: "cb-small",
      previous_response_id: first.body.id,
      input: "ignore that tool call and start a normal user turn",
    });

    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(second.body?.error?.code, "context_switch_compaction_failed");
    assert.deepEqual(calls, ["large-model"]);
  } finally {
    await closeIfListening(router);
    await closeIfListening(upstream);
    restoreEnv(keyEnv, previousKey);
  }
});

test("chat truncation emits a structured secret-free context policy log", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  const keyEnv = "CODEXBRIDGE_TEST_TASK4_TRUNCATION_LOG_KEY";
  const previousKey = process.env[keyEnv];
  process.env[keyEnv] = "fake-task4-truncation-log-key";
  const privateMarker = "PRIVATE_TRUNCATION_BODY_MARKER";
  const upstream = http.createServer(async (req, res) => {
    await readJson(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(chatCompletion(
      "chatcmpl_truncation_log",
      "truncation accepted",
    )));
  });
  let router;
  try {
    await listen(upstream);
    router = createRouterServer(switchConfig(serverUrl(upstream), { keyEnv }));
    await listen(router);
    const response = await postResponses(router, {
      model: "cb-small",
      input: `${privateMarker} ${"oversized chat input ".repeat(4_000)}`,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));

    const line = warnings.find((item) => item.includes("context_truncation {"));
    assert.ok(line, warnings.join("\n"));
    const entry = JSON.parse(
      line.slice(line.indexOf("context_truncation ") + "context_truncation ".length),
    );
    assert.equal(entry.event, "context_truncation");
    assert.equal(entry.policyId, "codexbridge-context-v1");
    assert.equal(entry.policyVersion, 1);
    assert.equal(entry.routeId, "cb-small");
    assert.ok(entry.beforeTokens > entry.inputBudget);
    assert.ok(entry.afterTokens <= entry.inputBudget);
    assert.equal(entry.preservedToolCount, 0);
    assert.equal(entry.outcome, "truncated");
    assert.equal(entry.reasonCode, "input_budget_exceeded");
    assert.doesNotMatch(JSON.stringify(entry), new RegExp(privateMarker));
  } finally {
    console.warn = originalWarn;
    await closeIfListening(router);
    await closeIfListening(upstream);
    restoreEnv(keyEnv, previousKey);
  }
});

function switchConfig(upstreamUrl, options = {}) {
  const models = [
    {
      id: "cb-large",
      displayName: "Old Large Model",
      provider: "deepseek",
      api: "chat_completions",
      baseUrl: `${upstreamUrl}/v1`,
      model: "large-model",
      apiKeyEnv: options.keyEnv,
      contextWindow: 1_000_000,
    },
    {
      id: "cb-small",
      displayName: "New Small Model",
      provider: "openai",
      api: options.targetApi || "chat_completions",
      baseUrl: `${upstreamUrl}/v1`,
      model: "small-model",
      apiKeyEnv: options.keyEnv,
      ...(options.omitTargetContextWindow ? {} : { contextWindow: 2_048 }),
    },
  ];
  if (options.includeFallback) {
    models.push({
      id: "cb-fallback",
      displayName: "Forbidden Failover",
      provider: "qwen",
      api: "chat_completions",
      baseUrl: `${upstreamUrl}/v1`,
      model: "fallback-model",
      apiKeyEnv: options.keyEnv,
      contextWindow: 2_048,
    });
  }
  return {
    host: "127.0.0.1",
    port: 0,
    authToken: "fake-router-token",
    defaultModel: "cb-large",
    smartRouting: {
      autoSelectModel: false,
      autoFailover: Boolean(options.autoFailover),
    },
    models,
  };
}

function chatCompletion(id, content) {
  return {
    id,
    object: "chat.completion",
    choices: [{ message: { role: "assistant", content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function responsesCompletion(id, model, content) {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output: [{
      id: `msg_${id}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: content, annotations: [] }],
    }],
    output_text: content,
    parallel_tool_calls: true,
    error: null,
    incomplete_details: null,
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
}

async function postResponses(server, body) {
  const response = await fetch(`${serverUrl(server)}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer fake-router-token",
      "user-agent": "Codex Desktop/Task4-Test",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function historyFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-context-switch-"));
  return { dir, historyPath: path.join(dir, "response-history.sqlite3") };
}

function cleanupHistoryFixture({ dir, historyPath }) {
  for (const filePath of [
    historyPath,
    `${historyPath}-wal`,
    `${historyPath}-shm`,
    `${historyPath}-journal`,
  ]) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
  if (fs.existsSync(dir)) {
    fs.rmdirSync(dir);
  }
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function closeIfListening(server) {
  if (server?.listening) {
    await close(server);
  }
}

function serverUrl(server) {
  const address = server.address();
  return `http://${address.address}:${address.port}`;
}
