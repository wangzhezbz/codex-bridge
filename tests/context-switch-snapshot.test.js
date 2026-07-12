import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRouterServer } from "../src/server.js";

const ROUTER_TOKEN = "fake-context-snapshot-router-token";

test("same-ID route drift fails locally before the mutated route is called after restart", async () => {
  const fixture = historyFixture("same-id-route-drift");
  const keyEnv = "CODEXBRIDGE_TEST_CONTEXT_SNAPSHOT_SAME_ID_KEY";
  const previousKey = process.env[keyEnv];
  process.env[keyEnv] = "fake-context-snapshot-same-id-key";
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    const body = await readJson(req);
    calls.push({ path: req.url, model: body.model });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(chatCompletion(
      `chatcmpl_same_id_drift_${calls.length}`,
      `answer:${body.model}`,
    )));
  });
  let firstRouter;
  let secondRouter;
  try {
    await listen(upstream);
    const upstreamUrl = serverUrl(upstream);
    firstRouter = createRouterServer(routerConfig([
      chatRoute({
        id: "cb-same-route",
        provider: "deepseek",
        model: "old-one-million-model",
        upstreamUrl,
        keyEnv,
        contextWindow: 1_000_000,
      }),
    ], "cb-same-route"), { historyPath: fixture.historyPath });
    await listen(firstRouter);

    const first = await postResponses(firstRouter, {
      model: "cb-same-route",
      input: "SAME_ID_OLD_CONTEXT_旧上下文".repeat(2_000),
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    await close(firstRouter);
    firstRouter = null;

    calls.length = 0;
    secondRouter = createRouterServer(routerConfig([
      chatRoute({
        id: "cb-same-route",
        provider: "openai",
        model: "mutated-small-model",
        upstreamUrl,
        keyEnv,
        contextWindow: 2_048,
      }),
    ], "cb-same-route"), { historyPath: fixture.historyPath });
    await listen(secondRouter);

    const second = await postResponses(secondRouter, {
      model: "cb-same-route",
      previous_response_id: first.body.id,
      input: "continue after the same route id changed",
    });

    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(second.body?.error?.code, "context_switch_compaction_failed");
    assert.deepEqual(calls, [], "the mutated same-ID route must receive zero calls");
  } finally {
    await closeIfListening(firstRouter);
    await closeIfListening(secondRouter);
    await closeIfListening(upstream);
    restoreEnv(keyEnv, previousKey);
    cleanupHistoryFixture(fixture);
  }
});

test("deleted persisted old route fails locally before target or failover after restart", async () => {
  const fixture = historyFixture("deleted-route");
  const keyEnv = "CODEXBRIDGE_TEST_CONTEXT_SNAPSHOT_DELETED_KEY";
  const previousKey = process.env[keyEnv];
  process.env[keyEnv] = "fake-context-snapshot-deleted-key";
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    const body = await readJson(req);
    calls.push({ path: req.url, model: body.model });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(chatCompletion(
      `chatcmpl_deleted_route_${calls.length}`,
      `answer:${body.model}`,
    )));
  });
  let firstRouter;
  let secondRouter;
  try {
    await listen(upstream);
    const upstreamUrl = serverUrl(upstream);
    firstRouter = createRouterServer(routerConfig([
      chatRoute({
        id: "cb-old-one-million",
        provider: "deepseek",
        model: "old-one-million-model",
        upstreamUrl,
        keyEnv,
        contextWindow: 1_000_000,
      }),
    ], "cb-old-one-million"), { historyPath: fixture.historyPath });
    await listen(firstRouter);

    const oldBoundary = "SNAPSHOT_OLD_BOUNDARY_旧上下文";
    const first = await postResponses(firstRouter, {
      model: "cb-old-one-million",
      input: oldBoundary.repeat(25_000),
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    await close(firstRouter);
    firstRouter = null;

    calls.length = 0;
    secondRouter = createRouterServer(routerConfig([
      chatRoute({
        id: "cb-target-258k",
        provider: "openai",
        model: "target-258k-model",
        upstreamUrl,
        keyEnv,
        contextWindow: 258_400,
      }),
      chatRoute({
        id: "cb-forbidden-failover",
        provider: "qwen",
        model: "forbidden-failover-model",
        upstreamUrl,
        keyEnv,
        contextWindow: 8_192,
      }),
    ], "cb-target-258k", { autoFailover: true }), {
      historyPath: fixture.historyPath,
    });
    await listen(secondRouter);

    const second = await postResponses(secondRouter, {
      model: "cb-target-258k",
      previous_response_id: first.body.id,
      input: "continue only if the exact persisted old route can compact this history",
    });

    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(second.body?.error?.code, "context_switch_compaction_failed");
    assert.deepEqual(calls, [], "target and failover must receive zero calls");
  } finally {
    await closeIfListening(firstRouter);
    await closeIfListening(secondRouter);
    await closeIfListening(upstream);
    restoreEnv(keyEnv, previousKey);
    cleanupHistoryFixture(fixture);
  }
});

test("persisted old Responses route budgets old history before compacting to a Chat target after restart", async () => {
  const fixture = historyFixture("responses-to-chat");
  const keyEnv = "CODEXBRIDGE_TEST_CONTEXT_SNAPSHOT_RESPONSES_KEY";
  const previousKey = process.env[keyEnv];
  process.env[keyEnv] = "fake-context-snapshot-responses-key";
  const calls = [];
  const summary = "Summary: persisted native Responses history survived the restart boundary.";
  const earlyBoundary = "RESPONSES_RESTART_EARLY_DROPPED_旧历史";
  const oldBoundary = "RESPONSES_RESTART_OLD_BOUNDARY_旧历史";
  const continuation = "continue on the small Chat route after restart";
  const upstream = http.createServer(async (req, res) => {
    const body = await readJson(req);
    const serialized = JSON.stringify(body);
    const compact = serialized.includes("CONTEXT CHECKPOINT COMPACTION");
    calls.push({ path: req.url, body, compact });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/v1/responses") {
      res.end(JSON.stringify(responsesCompletion({
        id: compact ? "resp_native_restart_compact" : "resp_native_restart_seed",
        model: body.model,
        text: compact ? summary : "native Responses seed accepted",
      })));
      return;
    }
    assert.equal(req.url, "/v1/chat/completions");
    res.end(JSON.stringify(chatCompletion(
      "chatcmpl_native_restart_target",
      "small Chat target accepted the compacted context",
    )));
  });
  let firstRouter;
  let secondRouter;
  try {
    await listen(upstream);
    const upstreamUrl = serverUrl(upstream);
    const oldRoute = responsesRoute({
      id: "cb-old-native-responses",
      provider: "openai",
      model: "old-native-responses-model",
      upstreamUrl,
      keyEnv,
      contextWindow: 16_384,
    });
    firstRouter = createRouterServer(routerConfig([
      oldRoute,
    ], oldRoute.id), { historyPath: fixture.historyPath });
    await listen(firstRouter);

    const first = await postResponses(firstRouter, {
      model: oldRoute.id,
      input: [
        {
          type: "message",
          role: "user",
          content: `${earlyBoundary} ${"old native history ".repeat(8_000)}`,
        },
        {
          type: "message",
          role: "user",
          content: oldBoundary,
        },
      ],
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    await close(firstRouter);
    firstRouter = null;

    const targetRoute = chatRoute({
      id: "cb-new-small-chat",
      provider: "deepseek",
      model: "new-small-chat-model",
      upstreamUrl,
      keyEnv,
      contextWindow: 8_192,
    });
    secondRouter = createRouterServer(routerConfig([
      oldRoute,
      targetRoute,
    ], targetRoute.id), { historyPath: fixture.historyPath });
    await listen(secondRouter);

    const second = await postResponses(secondRouter, {
      model: targetRoute.id,
      previous_response_id: first.body.id,
      input: continuation,
    });

    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(calls.length, 3, JSON.stringify(calls.map(callSummary)));
    assert.deepEqual(calls.map(callSummary), [
      { path: "/v1/responses", model: "old-native-responses-model", compact: false },
      { path: "/v1/responses", model: "old-native-responses-model", compact: true },
      { path: "/v1/chat/completions", model: "new-small-chat-model", compact: false },
    ]);

    const compactPayload = JSON.stringify(calls[1].body);
    assert.match(compactPayload, /RESPONSES_RESTART_OLD_BOUNDARY_/);
    assert.doesNotMatch(compactPayload, /RESPONSES_RESTART_EARLY_DROPPED_/);
    assert.doesNotMatch(compactPayload, new RegExp(escapeRegExp(continuation)));
    assert.equal(calls[1].body.previous_response_id, undefined);

    const targetPayload = JSON.stringify(calls[2].body.messages || []);
    assert.match(targetPayload, new RegExp(escapeRegExp(summary)));
    assert.match(targetPayload, new RegExp(escapeRegExp(continuation)));
    assert.doesNotMatch(targetPayload, /RESPONSES_RESTART_OLD_BOUNDARY_/);
  } finally {
    await closeIfListening(firstRouter);
    await closeIfListening(secondRouter);
    await closeIfListening(upstream);
    restoreEnv(keyEnv, previousKey);
    cleanupHistoryFixture(fixture);
  }
});

function routerConfig(models, defaultModel, { autoFailover = false } = {}) {
  return {
    host: "127.0.0.1",
    port: 0,
    authToken: ROUTER_TOKEN,
    defaultModel,
    smartRouting: {
      autoSelectModel: false,
      autoFailover,
    },
    models,
  };
}

function chatRoute({ id, provider, model, upstreamUrl, keyEnv, contextWindow }) {
  return {
    id,
    displayName: id,
    provider,
    api: "chat_completions",
    baseUrl: `${upstreamUrl}/v1`,
    model,
    apiKeyEnv: keyEnv,
    contextWindow,
  };
}

function responsesRoute({ id, provider, model, upstreamUrl, keyEnv, contextWindow }) {
  return {
    id,
    displayName: id,
    provider,
    api: "responses",
    baseUrl: `${upstreamUrl}/v1`,
    model,
    apiKeyEnv: keyEnv,
    contextWindow,
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

function responsesCompletion({ id, model, text }) {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1_000),
    status: "completed",
    model,
    output: [{
      id: `msg_${id}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }],
    output_text: text,
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
      authorization: `Bearer ${ROUTER_TOKEN}`,
      "user-agent": "Codex Desktop/Task4-Snapshot-Test",
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

function historyFixture(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `codexbridge-${label}-`));
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

function callSummary(call) {
  return {
    path: call.path,
    model: call.body.model,
    compact: call.compact,
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
