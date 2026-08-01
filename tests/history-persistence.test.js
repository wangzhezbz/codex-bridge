import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { ResponseHistory } from "../src/history.js";
import { proxyImageGenerationFallback } from "../src/image-generation.js";
import { createRouteSnapshot } from "../src/route-snapshot.js";
import { createRouterServer } from "../src/server.js";

test("persistent history reopens WAL data after close", () => {
  const fixture = historyFixture();
  let first;
  let second;
  try {
    first = new ResponseHistory({ historyPath: fixture.historyPath });
    assert.equal(typeof first.recordTurn, "function");
    first.recordTurn(historyTurn("resp_reopen", [
      { role: "user", content: "remember this after restart" },
      { role: "assistant", content: "remembered" },
    ]));
    first.close();
    first = null;

    second = new ResponseHistory({ historyPath: fixture.historyPath });
    assert.equal(second.health().journalMode, "wal");
    const reopened = second.lookup("resp_reopen");
    assert.equal(reopened.source, "sqlite");
    assert.deepEqual(reopened.messages, [
      { role: "user", content: "remember this after restart" },
      { role: "assistant", content: "remembered" },
    ]);
    assert.deepEqual(second.get("resp_reopen"), [
      { role: "user", content: "remember this after restart" },
      { role: "assistant", content: "remembered" },
    ]);
    assert.equal(second.getResponse("resp_reopen")?.id, "resp_reopen");
  } finally {
    first?.close?.();
    second?.close?.();
    cleanupHistoryFixture(fixture);
  }
});

test("persistent route metadata is whitelisted and strips credential variants", () => {
  const fixture = historyFixture();
  let history;
  let db;
  try {
    history = new ResponseHistory({ historyPath: fixture.historyPath });
    history.recordTurn({
      responseId: "resp_sanitized_meta",
      messages: [{ role: "user", content: "safe message" }],
      response: nativeResponse("resp_sanitized_meta", "safe answer"),
      meta: {
        api: "responses",
        routeId: "cb-safe-route",
        upstreamModel: "safe-model",
        upstreamKnown: true,
        parentResponseId: null,
        arbitraryDebugField: "DROP_ARBITRARY_SENTINEL",
        access_token: "DROP_ACCESS_TOKEN_SENTINEL",
        bearerToken: "DROP_BEARER_TOKEN_SENTINEL",
        authorizationHeader: "DROP_AUTH_HEADER_SENTINEL",
        routeSnapshot: {
          version: 1,
          id: "cb-safe-route",
          provider: "openai",
          api: "responses",
          model: "safe-model",
          baseUrl:
            "https://route-user:route-password@example.test/v1" +
            "?safe=kept&api_key=DROP_QUERY_KEY_SENTINEL" +
            "&access_token=DROP_QUERY_ACCESS_SENTINEL" +
            "&bearerToken=DROP_QUERY_BEARER_SENTINEL" +
            "&authorizationHeader=DROP_QUERY_AUTH_SENTINEL",
          authMode: "api_key",
          apiKeyEnv: "SAFE_ENV_NAME_ONLY",
          contextPolicy: {
            version: 1,
            policyId: "codexbridge-context-v1",
            upstreamContextWindow: 128_000,
            contextWindow: 128_000,
            inputBudget: 121_600,
            compactThreshold: 102_400,
            outputReserveTokens: 6_400,
            effectiveContextWindowPercent: 95,
            autoCompactPercent: 80,
            truncationPolicy: { mode: "tokens", limit: 121_600 },
          },
          credentialSource: "environment",
          requiresCustomHeaders: false,
          dropParams: ["parallel_tool_calls"],
          compactContract: {
            mode: "responses-native",
            strategy: "responses-json",
            requiresStream: false,
            retryWithStream: false,
            fallback: "local-summary",
          },
          contextWindow: 128_000,
          apiKey: "DROP_ROUTE_KEY_SENTINEL",
          access_token: "DROP_ROUTE_ACCESS_SENTINEL",
          bearerToken: "DROP_ROUTE_BEARER_SENTINEL",
          authorizationHeader: "DROP_ROUTE_AUTH_SENTINEL",
          extra: "DROP_ROUTE_EXTRA_SENTINEL",
        },
      },
    });
    history.close();
    history = null;

    db = new DatabaseSync(fixture.historyPath, { readOnly: true });
    const row = db.prepare(
      "SELECT meta_gzip FROM response_history WHERE response_id = ?",
    ).get("resp_sanitized_meta");
    const decoded = JSON.parse(
      zlib.gunzipSync(Buffer.from(row.meta_gzip)).toString("utf8"),
    );
    const serialized = JSON.stringify(decoded);

    assert.deepEqual(Object.keys(decoded).sort(), [
      "api",
      "parentResponseId",
      "routeId",
      "routeSnapshot",
      "upstreamKnown",
      "upstreamModel",
    ]);
    assert.deepEqual(Object.keys(decoded.routeSnapshot).sort(), [
      "api",
      "apiKeyEnv",
      "authMode",
      "baseUrl",
      "compactContract",
      "contextPolicy",
      "contextWindow",
      "credentialSource",
      "dropParams",
      "id",
      "model",
      "provider",
      "requiresCustomHeaders",
      "version",
    ]);
    assert.equal(decoded.routeSnapshot.contextPolicy.inputBudget, 121_600);
    assert.equal(decoded.routeSnapshot.credentialSource, "environment");
    assert.equal(decoded.routeSnapshot.requiresCustomHeaders, false);
    assert.deepEqual(decoded.routeSnapshot.dropParams, ["parallel_tool_calls"]);
    assert.equal(
      decoded.routeSnapshot.baseUrl,
      "https://example.test/v1?safe=kept",
    );
    for (const sentinel of [
      "DROP_ARBITRARY_SENTINEL",
      "DROP_ACCESS_TOKEN_SENTINEL",
      "DROP_BEARER_TOKEN_SENTINEL",
      "DROP_AUTH_HEADER_SENTINEL",
      "DROP_QUERY_KEY_SENTINEL",
      "DROP_QUERY_ACCESS_SENTINEL",
      "DROP_QUERY_BEARER_SENTINEL",
      "DROP_QUERY_AUTH_SENTINEL",
      "DROP_ROUTE_KEY_SENTINEL",
      "DROP_ROUTE_ACCESS_SENTINEL",
      "DROP_ROUTE_BEARER_SENTINEL",
      "DROP_ROUTE_AUTH_SENTINEL",
      "DROP_ROUTE_EXTRA_SENTINEL",
      "route-user",
      "route-password",
    ]) {
      assert.doesNotMatch(serialized, new RegExp(sentinel));
    }
  } finally {
    db?.close?.();
    history?.close?.();
    cleanupHistoryFixture(fixture);
  }
});

test("legacy record plus recordResponse persists the untruncated complete turn", () => {
  const fixture = historyFixture();
  const fullText = `${"S".repeat(1_200_000)}:split-write-tail-marker`;
  let first;
  let reopened;
  try {
    first = new ResponseHistory({ historyPath: fixture.historyPath });
    first.record("resp_legacy_split_write", [
      { role: "user", content: fullText },
    ]);
    assert.ok(
      JSON.stringify(first.get("resp_legacy_split_write")).length < fullText.length,
      "memory cache should retain its legacy bounded behavior",
    );
    first.recordResponse(
      nativeResponse("resp_legacy_split_write", "legacy response"),
      { parentResponseId: null },
    );
    first.close();
    first = null;

    reopened = new ResponseHistory({ historyPath: fixture.historyPath });
    const stored = reopened.lookup("resp_legacy_split_write");
    assert.equal(stored.state, "available");
    assert.equal(stored.messages[0].content.length, fullText.length);
    assert.match(stored.messages[0].content, /split-write-tail-marker$/);
  } finally {
    first?.close?.();
    reopened?.close?.();
    cleanupHistoryFixture(fixture);
  }
});

test("an oversized turn is rejected without poisoning later persistent writes", () => {
  const fixture = historyFixture();
  let history;
  try {
    history = new ResponseHistory({
      historyPath: fixture.historyPath,
      maxRecordBytes: 1_024,
    });
    assert.throws(
      () => history.recordTurn(historyTurn("resp_too_large_once", [
        { role: "user", content: "X".repeat(2_000) },
      ])),
      (error) =>
        error?.code === "local_history_storage_unavailable" &&
        error?.statusCode === 503 &&
        error?.localHistoryError === true &&
        error?.internalCode === "history_record_too_large",
    );

    history.recordTurn(historyTurn("resp_small_after_rejection", [
      { role: "user", content: "small retry" },
    ]));
    assert.equal(history.lookup("resp_small_after_rejection").state, "available");
    assert.equal(history.health().ok, true);
  } finally {
    history?.close?.();
    cleanupHistoryFixture(fixture);
  }
});

test("persistent history round trips a complete record larger than one megabyte", () => {
  const fixture = historyFixture();
  const largeText = `large-history:${"x".repeat(1_200_000)}:complete`;
  let first;
  let second;
  try {
    first = new ResponseHistory({ historyPath: fixture.historyPath });
    assert.equal(typeof first.recordTurn, "function");
    first.recordTurn(historyTurn("resp_large_disk", [
      { role: "user", content: largeText },
      { role: "assistant", content: "large record saved" },
    ]));
    first.close();
    first = null;

    second = new ResponseHistory({ historyPath: fixture.historyPath });
    const reopened = second.lookup("resp_large_disk");
    assert.equal(reopened.messages[0].content, largeText);
    assert.ok(reopened.storedBytes < 1_200_000);
    assert.equal(second.get("resp_large_disk")[0].content, largeText);
  } finally {
    first?.close?.();
    second?.close?.();
    cleanupHistoryFixture(fixture);
  }
});

test("persistent history preserves assistant tool calls and tool results", () => {
  const fixture = historyFixture();
  const messages = [
    { role: "user", content: "inspect the workspace" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_history_tool",
          type: "function",
          function: { name: "shell_command", arguments: "{\"command\":\"pwd\"}" },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_history_tool",
      content: "F:\\game_code\\router",
    },
  ];
  let first;
  let second;
  try {
    first = new ResponseHistory({ historyPath: fixture.historyPath });
    assert.equal(typeof first.recordTurn, "function");
    first.recordTurn(historyTurn("resp_tool_disk", messages));
    first.close();
    first = null;

    second = new ResponseHistory({ historyPath: fixture.historyPath });
    assert.deepEqual(second.get("resp_tool_disk"), messages);
    assert.equal(
      second.get("resp_tool_disk")[2].tool_call_id,
      second.get("resp_tool_disk")[1].tool_calls[0].id,
    );
  } finally {
    first?.close?.();
    second?.close?.();
    cleanupHistoryFixture(fixture);
  }
});

test("persistent history lets a rebuilt Router continue a chat route", async () => {
  const fixture = historyFixture();
  const upstreamBodies = [];
  const upstream = http.createServer(async (req, res) => {
    upstreamBodies.push(await readJson(req));
    const call = upstreamBodies.length;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(chatCompletion(`chatcmpl_restart_${call}`, `answer ${call}`)));
  });
  let firstRouter;
  let secondRouter;
  try {
    await listen(upstream);
    const config = chatRouterConfig(serverUrl(upstream));
    firstRouter = createRouterServer(config, { historyPath: fixture.historyPath });
    await listen(firstRouter);
    const first = await postResponses(firstRouter, {
      model: "cb-deepseek-history",
      stream: false,
      input: "restart marker from the first turn",
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.ok(first.body.id);
    await close(firstRouter);
    firstRouter = null;

    secondRouter = createRouterServer(config, { historyPath: fixture.historyPath });
    await listen(secondRouter);
    const second = await postResponses(secondRouter, {
      model: "cb-deepseek-history",
      stream: false,
      previous_response_id: first.body.id,
      input: "continue after Router restart",
    });

    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(upstreamBodies.length, 2);
    const continuedPayload = JSON.stringify(upstreamBodies[1].messages);
    assert.match(continuedPayload, /restart marker from the first turn/);
    assert.match(continuedPayload, /answer 1/);
    assert.match(continuedPayload, /continue after Router restart/);
  } finally {
    await closeIfListening(firstRouter);
    await closeIfListening(secondRouter);
    await closeIfListening(upstream);
    cleanupHistoryFixture(fixture);
  }
});

test("persistent history independently continues a Kimi chat route after restart", async () => {
  const fixture = historyFixture();
  const upstreamBodies = [];
  const upstream = http.createServer(async (req, res) => {
    upstreamBodies.push(await readJson(req));
    const call = upstreamBodies.length;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ...chatCompletion(`chatcmpl_kimi_restart_${call}`, `kimi answer ${call}`),
      model: "kimi-k2.7-code",
    }));
  });
  let firstRouter;
  let secondRouter;
  try {
    await listen(upstream);
    const config = {
      host: "127.0.0.1",
      port: 0,
      authToken: "fake-router-token",
      defaultModel: "cb-kimi-history",
      models: [{
        id: "cb-kimi-history",
        displayName: "Kimi History Test",
        provider: "moonshot",
        api: "chat_completions",
        model: "kimi-k2.7-code",
        baseUrl: `${serverUrl(upstream)}/v1`,
        apiKey: "fake-kimi-key",
        apiKeyEnv: "FAKE_MOONSHOT_KEY",
        contextWindow: 128_000,
      }],
    };
    firstRouter = createRouterServer(config, { historyPath: fixture.historyPath });
    await listen(firstRouter);
    const first = await postResponses(firstRouter, {
      model: "cb-kimi-history",
      stream: false,
      input: "kimi restart marker from the first turn",
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    await close(firstRouter);
    firstRouter = null;

    secondRouter = createRouterServer(config, { historyPath: fixture.historyPath });
    await listen(secondRouter);
    const second = await postResponses(secondRouter, {
      model: "cb-kimi-history",
      stream: false,
      previous_response_id: first.body.id,
      input: "continue Kimi after Router restart",
    });

    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(upstreamBodies.length, 2);
    assert.equal(upstreamBodies[1].model, "kimi-k2.7-code");
    const continuedPayload = JSON.stringify(upstreamBodies[1].messages);
    assert.match(continuedPayload, /kimi restart marker from the first turn/);
    assert.match(continuedPayload, /kimi answer 1/);
    assert.match(continuedPayload, /continue Kimi after Router restart/);
  } finally {
    await closeIfListening(firstRouter);
    await closeIfListening(secondRouter);
    await closeIfListening(upstream);
    cleanupHistoryFixture(fixture);
  }
});

test("persistent history rejects a missing local chat chain before any upstream call", async () => {
  const fixture = historyFixture();
  let upstreamCalls = 0;
  const upstream = http.createServer(async (_req, res) => {
    upstreamCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(chatCompletion("chatcmpl_must_not_run", "unexpected")));
  });
  let router;
  try {
    await listen(upstream);
    router = createRouterServer(chatRouterConfig(serverUrl(upstream)), {
      historyPath: fixture.historyPath,
    });
    await listen(router);

    const result = await postResponses(router, {
      model: "cb-deepseek-history",
      stream: false,
      previous_response_id: "resp_missing_local_history",
      input: "must not reach the provider",
    });

    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.error?.code, "local_history_unavailable");
    assert.equal(
      result.body.error?.message,
      "本地模型历史不可恢复，请新建会话后重试。",
    );
    assert.equal(upstreamCalls, 0);
  } finally {
    await closeIfListening(router);
    await closeIfListening(upstream);
    cleanupHistoryFixture(fixture);
  }
});

test("persistent history rejects a missing stateless Responses chain before upstream", async () => {
  const fixture = historyFixture();
  let upstreamCalls = 0;
  const upstream = http.createServer(async (_req, res) => {
    upstreamCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(nativeResponse("resp_must_not_run", "unexpected")));
  });
  let router;
  try {
    await listen(upstream);
    const config = mixedRouterConfig("http://127.0.0.1:1", serverUrl(upstream));
    const route = config.models.find((model) => model.id === "cb-native-history");
    route.provider = "deepseek";
    route.model = "deepseek-v4-flash";
    route.supportsResponsePreviousId = false;
    config.defaultModel = route.id;
    router = createRouterServer(config, { historyPath: fixture.historyPath });
    await listen(router);

    const result = await postResponses(router, {
      model: route.id,
      stream: false,
      previous_response_id: "resp_missing_stateless_history",
      input: "must not lose context silently",
    });

    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.error?.code, "local_history_unavailable");
    assert.equal(upstreamCalls, 0);
  } finally {
    await closeIfListening(router);
    await closeIfListening(upstream);
    cleanupHistoryFixture(fixture);
  }
});

test("persistent history refreshes its sliding TTL on lookup", () => {
  const fixture = historyFixture();
  let now = 10_000;
  let first;
  let second;
  try {
    first = new ResponseHistory({
      historyPath: fixture.historyPath,
      ttlMs: 1_000,
      now: () => now,
    });
    first.recordTurn(historyTurn("resp_sliding_ttl", [
      { role: "user", content: "keep the active chain alive" },
    ]));
    now = 10_900;
    assert.equal(first.lookup("resp_sliding_ttl").state, "available");
    first.close();
    first = null;

    now = 11_500;
    second = new ResponseHistory({
      historyPath: fixture.historyPath,
      ttlMs: 1_000,
      now: () => now,
    });
    assert.equal(second.lookup("resp_sliding_ttl").state, "available");
    second.entries.clear();
    second.responses.clear();
    second.responseMeta.clear();
    now = 13_000;
    assert.equal(second.lookup("resp_sliding_ttl").state, "expired");
  } finally {
    first?.close?.();
    second?.close?.();
    cleanupHistoryFixture(fixture);
  }
});

test("persistent history capacity pruning protects active and current rows and tombstones cold rows", () => {
  const fixture = historyFixture();
  let now = 20_000;
  let history;
  try {
    history = new ResponseHistory({
      historyPath: fixture.historyPath,
      maxBytes: 1,
      protectRecentMs: 60 * 60 * 1000,
      now: () => now,
    });
    history.recordTurn(historyTurn("resp_active", [
      { role: "user", content: "active chain" },
    ]));
    history.recordTurn(historyTurn("resp_cold", [
      { role: "user", content: "cold chain" },
    ]));
    now += 2 * 60 * 60 * 1000;
    assert.equal(history.lookup("resp_active").state, "available");
    history.recordTurn(historyTurn("resp_current", [
      { role: "user", content: "row being written" },
    ]));

    history.entries.clear();
    history.responses.clear();
    history.responseMeta.clear();
    assert.equal(history.lookup("resp_cold").state, "evicted");
    assert.equal(history.lookup("resp_active").state, "available");
    assert.equal(history.lookup("resp_current").state, "available");
  } finally {
    history?.close?.();
    cleanupHistoryFixture(fixture);
  }
});

test("persistent history distinguishes corrupt and unavailable storage", () => {
  const fixture = historyFixture();
  let history;
  try {
    history = new ResponseHistory({ historyPath: fixture.historyPath });
    history.recordTurn(historyTurn("resp_corrupt", [
      { role: "user", content: "this row will be corrupted" },
    ]));
    history.close();
    history = null;
    const db = new DatabaseSync(fixture.historyPath);
    db.prepare(
      "UPDATE response_history SET messages_gzip = ? WHERE response_id = ?",
    ).run(Buffer.from("not-gzip"), "resp_corrupt");
    db.close();

    history = new ResponseHistory({ historyPath: fixture.historyPath });
    assert.equal(history.lookup("resp_corrupt").state, "corrupt");
  } finally {
    history?.close?.();
    cleanupHistoryFixture(fixture);
  }

  const unavailableRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codexbridge-history-unavailable-"),
  );
  const directoryAsDatabase = path.join(unavailableRoot, "response-history.sqlite3");
  fs.mkdirSync(directoryAsDatabase);
  const unavailable = new ResponseHistory({ historyPath: directoryAsDatabase });
  try {
    assert.equal(unavailable.lookup("resp_any").state, "storage_unavailable");
    assert.equal(unavailable.health().ok, false);
  } finally {
    unavailable.close();
    fs.rmdirSync(directoryAsDatabase);
    fs.rmdirSync(unavailableRoot);
  }
});

test("persistent history refuses a newer SQLite schema", () => {
  const fixture = historyFixture();
  const db = new DatabaseSync(fixture.historyPath);
  db.exec("PRAGMA user_version = 2");
  db.close();
  const history = new ResponseHistory({ historyPath: fixture.historyPath });
  try {
    assert.equal(history.health().ok, false);
    assert.equal(history.lookup("resp_unknown").state, "storage_unavailable");
    assert.throws(
      () => history.recordTurn(historyTurn("resp_refused", [])),
      (error) => error?.code === "local_history_storage_unavailable",
    );
  } finally {
    history.close();
    cleanupHistoryFixture(fixture);
  }
});

test("persistent history storage failure returns 503 before upstream or failover", async () => {
  const unavailableRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codexbridge-history-503-"),
  );
  const directoryAsDatabase = path.join(unavailableRoot, "response-history.sqlite3");
  fs.mkdirSync(directoryAsDatabase);
  let upstreamCalls = 0;
  const upstream = http.createServer(async (_req, res) => {
    upstreamCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(chatCompletion("chatcmpl_unexpected_503", "unexpected")));
  });
  let router;
  try {
    await listen(upstream);
    router = createRouterServer(chatRouterConfig(serverUrl(upstream)), {
      historyPath: directoryAsDatabase,
    });
    await listen(router);
    const result = await postResponses(router, {
      model: "cb-deepseek-history",
      previous_response_id: "resp_storage_down",
      input: "must remain local",
    });
    assert.equal(result.status, 503, JSON.stringify(result.body));
    assert.equal(result.body.error?.code, "local_history_storage_unavailable");
    assert.equal(upstreamCalls, 0);
  } finally {
    await closeIfListening(router);
    await closeIfListening(upstream);
    fs.rmdirSync(directoryAsDatabase);
    fs.rmdirSync(unavailableRoot);
  }
});

test("chat routing records messages response and safe route metadata in one turn", async () => {
  const turns = [];
  let legacyWrites = 0;
  let injectedCloseCalls = 0;
  const injectedHistory = {
    lookup(responseId) {
      return {
        state: "available",
        messages: [
          { role: "user", content: "parent request" },
          { role: "assistant", content: "parent answer" },
        ],
        response: { id: responseId, object: "response", output: [] },
        meta: {},
        source: "memory",
      };
    },
    get() {
      return [
        { role: "user", content: "parent request" },
        { role: "assistant", content: "parent answer" },
      ];
    },
    getResponseMeta() {
      return {};
    },
    record() {
      legacyWrites += 1;
    },
    recordResponse() {
      legacyWrites += 1;
    },
    recordTurn(turn) {
      turns.push(turn);
    },
    close() {
      injectedCloseCalls += 1;
    },
  };
  const upstream = http.createServer(async (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(chatCompletion("chatcmpl_atomic_turn", "atomic answer")));
  });
  let router;
  try {
    await listen(upstream);
    const config = chatRouterConfig(serverUrl(upstream));
    router = createRouterServer(config, { history: injectedHistory });
    await listen(router);
    const result = await postResponses(router, {
      model: "cb-deepseek-history",
      previous_response_id: "resp_atomic_parent",
      input: "record this atomically",
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(turns.length, 1);
    assert.equal(legacyWrites, 0);
    assert.equal(turns[0].responseId, result.body.id);
    assert.equal(turns[0].meta.parentResponseId, "resp_atomic_parent");
    assert.deepEqual(
      turns[0].meta.routeSnapshot,
      createRouteSnapshot(config.models[0]),
    );
    assert.equal("apiKey" in turns[0].meta.routeSnapshot, false);
  } finally {
    await closeIfListening(router);
    await closeIfListening(upstream);
  }
  assert.equal(injectedCloseCalls, 0);
});

test("image generation records its completed response in one atomic turn", async () => {
  const turns = [];
  let legacyWrites = 0;
  const history = {
    get() {
      return [];
    },
    record() {
      legacyWrites += 1;
    },
    recordResponse() {
      legacyWrites += 1;
    },
    recordTurn(turn) {
      turns.push(turn);
    },
  };
  const route = {
    id: "cb-image-history",
    api: "chat_completions",
    model: "chat-model",
    baseUrl: "http://127.0.0.1/model/v1",
    apiKey: "fake-chat-key",
    apiKeyEnv: "FAKE_CHAT_KEY",
    contextWindow: 64_000,
    imageGeneration: {
      enabled: true,
      mode: "custom",
      id: "fake-image-provider",
      displayName: "Fake Image Provider",
      baseUrl: "http://127.0.0.1/images/v1",
      endpoint: "/images/generations",
      model: "fake-image-model",
      apiKey: "fake-image-key",
      apiKeyEnv: "FAKE_IMAGE_KEY",
    },
  };
  let statusCode = 0;
  let responseBody = null;
  const res = {
    writeHead(status) {
      statusCode = status;
    },
    end(payload) {
      responseBody = JSON.parse(payload);
    },
  };

  await proxyImageGenerationFallback(
    {
      model: route.id,
      stream: false,
      input: "generate a blue square",
    },
    route,
    history,
    res,
    {},
    async () => ({
      created: 1_700_000_000,
      data: [{ b64_json: Buffer.from("fake-image-bytes").toString("base64") }],
    }),
  );

  assert.equal(statusCode, 200);
  assert.ok(responseBody?.id);
  assert.equal(turns.length, 1);
  assert.equal(legacyWrites, 0);
  assert.equal(turns[0].response.id, responseBody.id);
  assert.equal(turns[0].meta.parentResponseId, null);
  assert.equal(turns[0].meta.routeSnapshot.id, route.id);
  assert.equal("apiKey" in turns[0].meta.routeSnapshot, false);
});

test("persistent history continues a tool call after Router restart", async () => {
  const fixture = historyFixture();
  const upstreamBodies = [];
  const upstream = http.createServer(async (req, res) => {
    upstreamBodies.push(await readJson(req));
    const payload = upstreamBodies.length === 1
      ? chatCompletionWithToolCall("chatcmpl_restart_tool", "call_restart_tool")
      : chatCompletion("chatcmpl_restart_tool_done", "tool result accepted");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  let firstRouter;
  let secondRouter;
  try {
    await listen(upstream);
    const config = chatRouterConfig(serverUrl(upstream));
    firstRouter = createRouterServer(config, { historyPath: fixture.historyPath });
    await listen(firstRouter);
    const first = await postResponses(firstRouter, {
      model: "cb-deepseek-history",
      input: "inspect the workspace with a tool",
      tools: [
        {
          type: "function",
          name: "shell_command",
          description: "Run a fake command.",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.match(JSON.stringify(first.body.output), /call_restart_tool/);
    await close(firstRouter);
    firstRouter = null;

    secondRouter = createRouterServer(config, { historyPath: fixture.historyPath });
    await listen(secondRouter);
    const second = await postResponses(secondRouter, {
      model: "cb-deepseek-history",
      previous_response_id: first.body.id,
      input: [
        {
          type: "function_call_output",
          call_id: "call_restart_tool",
          output: "F:\\game_code\\router",
        },
      ],
      tools: [
        {
          type: "function",
          name: "shell_command",
          description: "Run a fake command.",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
    });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(upstreamBodies.length, 2);
    const continuedMessages = JSON.stringify(upstreamBodies[1].messages);
    assert.match(continuedMessages, /call_restart_tool/);
    assert.match(continuedMessages, /F:\\\\game_code\\\\router/);
  } finally {
    await closeIfListening(firstRouter);
    await closeIfListening(secondRouter);
    await closeIfListening(upstream);
    cleanupHistoryFixture(fixture);
  }
});

test("persistent Chat history can continue on a native Responses route after restart", async () => {
  const fixture = historyFixture();
  const nativeBodies = [];
  const chatUpstream = http.createServer(async (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(chatCompletion("chatcmpl_chat_to_responses", "chat-side answer")));
  });
  const nativeUpstream = http.createServer(async (req, res) => {
    nativeBodies.push(await readJson(req));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(nativeResponse("resp_native_after_restart", "native answer")));
  });
  let firstRouter;
  let secondRouter;
  try {
    await listen(chatUpstream);
    await listen(nativeUpstream);
    const config = mixedRouterConfig(serverUrl(chatUpstream), serverUrl(nativeUpstream));
    firstRouter = createRouterServer(config, { historyPath: fixture.historyPath });
    await listen(firstRouter);
    const first = await postResponses(firstRouter, {
      model: "cb-chat-history",
      input: "chat history marker before restart",
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    await close(firstRouter);
    firstRouter = null;

    secondRouter = createRouterServer(config, { historyPath: fixture.historyPath });
    await listen(secondRouter);
    const second = await postResponses(secondRouter, {
      model: "cb-native-history",
      previous_response_id: first.body.id,
      input: "continue through native Responses",
    });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(nativeBodies.length, 1);
    assert.equal(nativeBodies[0].previous_response_id, undefined);
    const expandedInput = JSON.stringify(nativeBodies[0].input);
    assert.match(expandedInput, /chat history marker before restart/);
    assert.match(expandedInput, /chat-side answer/);
    assert.match(expandedInput, /continue through native Responses/);
  } finally {
    await closeIfListening(firstRouter);
    await closeIfListening(secondRouter);
    await closeIfListening(chatUpstream);
    await closeIfListening(nativeUpstream);
    cleanupHistoryFixture(fixture);
  }
});

test("native Responses routes may forward an unknown provider-owned response id", async () => {
  const fixture = historyFixture();
  const nativeBodies = [];
  const nativeUpstream = http.createServer(async (req, res) => {
    nativeBodies.push(await readJson(req));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(nativeResponse("resp_native_unknown_ok", "native continuation")));
  });
  let router;
  try {
    await listen(nativeUpstream);
    const config = mixedRouterConfig("http://127.0.0.1:1", serverUrl(nativeUpstream));
    router = createRouterServer(config, { historyPath: fixture.historyPath });
    await listen(router);
    const result = await postResponses(router, {
      model: "cb-native-history",
      previous_response_id: "resp_owned_by_native_provider",
      input: "provider should resolve this id",
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(nativeBodies.length, 1);
    assert.equal(nativeBodies[0].previous_response_id, "resp_owned_by_native_provider");
  } finally {
    await closeIfListening(router);
    await closeIfListening(nativeUpstream);
    cleanupHistoryFixture(fixture);
  }
});

test("history write failures return 503 without smart failover", async () => {
  const upstreamBodies = [];
  const upstream = http.createServer(async (req, res) => {
    upstreamBodies.push(await readJson(req));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(chatCompletion(`chatcmpl_${upstreamBodies.length}`, "upstream success")));
  });
  const history = {
    get() {
      return [];
    },
    getResponseMeta() {
      return null;
    },
    recordTurn() {
      const error = new Error("simulated Bridge history write failure");
      error.statusCode = 503;
      error.code = "local_history_storage_unavailable";
      error.localHistoryError = true;
      throw error;
    },
  };
  let router;
  try {
    await listen(upstream);
    const upstreamUrl = `${serverUrl(upstream)}/v1`;
    router = createRouterServer({
      host: "127.0.0.1",
      port: 0,
      authToken: "fake-router-token",
      defaultModel: "cb-history-primary",
      smartRouting: {
        autoSelectModel: false,
        autoFailover: true,
        failover: { mode: "ordered", routeIds: ["cb-history-backup"] },
      },
      models: [
        {
          id: "cb-history-primary",
          displayName: "History Primary",
          provider: "qwen",
          api: "chat_completions",
          baseUrl: upstreamUrl,
          model: "qwen-plus",
          apiKey: "fake-primary-key",
        },
        {
          id: "cb-history-backup",
          displayName: "History Backup",
          provider: "deepseek",
          api: "chat_completions",
          baseUrl: upstreamUrl,
          model: "deepseek-chat",
          apiKey: "fake-backup-key",
        },
      ],
    }, { history });
    await listen(router);
    const result = await postResponses(router, {
      model: "cb-history-primary",
      input: "history storage must fail locally",
    });

    assert.equal(result.status, 503, JSON.stringify(result.body));
    assert.equal(result.body.error?.code, "local_history_storage_unavailable");
    assert.deepEqual(upstreamBodies.map((body) => body.model), ["qwen-plus"]);
  } finally {
    await closeIfListening(router);
    await closeIfListening(upstream);
  }
});

for (const scenario of [
  { code: "history_record_too_large", stream: false, recoverable: true },
  { code: "SQLITE_BUSY", stream: true, recoverable: true },
  { code: "SQLITE_FULL", stream: false, recoverable: false },
]) {
  test(`raw ${scenario.code} history writes return local 503 without image failover`, async () => {
    const imageBodies = [];
    const imageUpstream = http.createServer(async (req, res) => {
      imageBodies.push(await readJson(req));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        data: [{ b64_json: Buffer.from("fake-image-bytes").toString("base64") }],
      }));
    });
    let storageWrites = 0;
    const storage = {
      recordTurn() {
        storageWrites += 1;
        if (storageWrites === 1) {
          const error = new Error(`simulated ${scenario.code} write`);
          error.code = scenario.code;
          throw error;
        }
        return { expiredIds: [], evictedIds: [] };
      },
      health() {
        return { ok: true, persistent: true };
      },
    };
    const history = new ResponseHistory({ storage });
    let router;
    try {
      await listen(imageUpstream);
      router = createRouterServer(imageHistoryFailoverConfig(serverUrl(imageUpstream)), {
        history,
      });
      await listen(router);
      const firstResponse = await fetch(`${serverUrl(router)}/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer fake-router-token",
        },
        body: JSON.stringify(imageGenerationRequest({
          stream: scenario.stream,
          input: `generate the ${scenario.code} failure image`,
        })),
      });
      const firstText = await firstResponse.text();

      assert.equal(firstResponse.status, 503, firstText);
      assert.deepEqual(imageBodies.map((body) => body.model), ["primary-image-model"]);
      assert.equal(storageWrites, 1);
      if (scenario.stream) {
        assert.match(firstText, /event: response\.failed/);
        assert.match(firstText, /local_history_storage_unavailable/);
        assert.doesNotMatch(firstText, /event: response\.completed/);
      } else {
        assert.equal(
          JSON.parse(firstText).error?.code,
          "local_history_storage_unavailable",
        );
      }

      if (scenario.recoverable) {
        assert.equal(history.health().ok, true);
        const recovered = await postResponses(router, imageGenerationRequest({
          stream: false,
          input: `generate the recovered ${scenario.code} image`,
        }));
        assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
        assert.deepEqual(
          imageBodies.map((body) => body.model),
          ["primary-image-model", "primary-image-model"],
        );
        assert.equal(storageWrites, 2);
      } else {
        assert.equal(history.health().ok, false);
      }
    } finally {
      await closeIfListening(router);
      await closeIfListening(imageUpstream);
      history.close();
    }
  });
}

test("native non-stream history write failure returns 503 before response headers and without failover", async () => {
  const upstreamBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const body = await readJson(req);
    upstreamBodies.push(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(nativeResponse(`resp_${body.model}`, "native success")));
  });
  const history = failingHistoryStore();
  let router;
  try {
    await listen(upstream);
    router = createRouterServer(nativeFailoverConfig(serverUrl(upstream)), { history });
    await listen(router);
    const result = await postResponses(router, {
      model: "cb-native-primary",
      stream: false,
      input: "native history must persist before success",
    });

    assert.equal(result.status, 503, JSON.stringify(result.body));
    assert.equal(result.body.error?.code, "local_history_storage_unavailable");
    assert.deepEqual(upstreamBodies.map((body) => body.model), ["native-primary"]);
  } finally {
    await closeIfListening(router);
    await closeIfListening(upstream);
  }
});

test("native non-stream success requires a completed response before sending 200", async () => {
  const upstreamBodies = [];
  const upstream = http.createServer(async (req, res) => {
    upstreamBodies.push(await readJson(req));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "resp_not_completed",
      object: "response",
      status: "in_progress",
      output: [],
    }));
  });
  let router;
  try {
    await listen(upstream);
    const config = nativeFailoverConfig(serverUrl(upstream));
    config.smartRouting.autoFailover = false;
    router = createRouterServer(config, { history: new ResponseHistory() });
    await listen(router);
    const result = await postResponses(router, {
      model: "cb-native-primary",
      stream: false,
      input: "reject an unfinished non-stream response",
    });

    assert.equal(result.status, 502, JSON.stringify(result.body));
    assert.match(result.body.error?.message || "", /completed response/i);
    assert.equal(upstreamBodies.length, 1);
  } finally {
    await closeIfListening(router);
    await closeIfListening(upstream);
  }
});

test("native streaming history write failure withholds completed and emits failed", async () => {
  const upstreamBodies = [];
  const upstream = http.createServer(async (req, res) => {
    upstreamBodies.push(await readJson(req));
    const completed = nativeResponse("resp_stream_history_failure", "must not be completed");
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.write(`event: response.created\ndata: ${JSON.stringify({
      type: "response.created",
      response: { ...completed, status: "in_progress", output: [] },
    })}\n\n`);
    res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({
      type: "response.output_text.delta",
      delta: "partial text",
    })}\n\n`);
    res.end(`event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: completed,
    })}\n\ndata: [DONE]\n\n`);
  });
  let router;
  try {
    await listen(upstream);
    router = createRouterServer(nativeFailoverConfig(serverUrl(upstream)), {
      history: failingHistoryStore(),
    });
    await listen(router);
    const response = await fetch(`${serverUrl(router)}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer fake-router-token",
      },
      body: JSON.stringify({
        model: "cb-native-primary",
        stream: true,
        input: "stream without false completed",
      }),
    });
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.doesNotMatch(text, /event: response\.completed/);
    assert.match(text, /event: response\.failed/);
    assert.match(text, /本地模型历史保存失败/);
    assert.match(text, /local_history_storage_unavailable/);
    assert.equal(upstreamBodies.length, 1);
  } finally {
    await closeIfListening(router);
    await closeIfListening(upstream);
  }
});

test("native streaming history gates a CRLF terminal split across chunks", async () => {
  const fixture = historyFixture();
  const completed = nativeResponse("resp_chunked_crlf_terminal", "chunked terminal");
  const upstream = http.createServer(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    const pieces = [
      `event: response.created\r\ndata: ${JSON.stringify({
        type: "response.created",
        response: { ...completed, status: "in_progress", output: [] },
      })}\r`,
      "\n\r",
      "\n",
      `event: response.completed\r\ndata: ${JSON.stringify({
        type: "response.completed",
        response: completed,
      })}\r\n\r`,
      "\n",
      "data: [DONE]\r\n\r",
      "\n",
    ];
    for (const piece of pieces) {
      res.write(piece);
      await new Promise((resolve) => setImmediate(resolve));
    }
    res.end();
  });
  let router;
  let reopened;
  try {
    await listen(upstream);
    const config = nativeFailoverConfig(serverUrl(upstream));
    config.smartRouting.autoFailover = false;
    router = createRouterServer(config, { historyPath: fixture.historyPath });
    await listen(router);
    const response = await fetch(`${serverUrl(router)}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer fake-router-token",
      },
      body: JSON.stringify({
        model: "cb-native-primary",
        stream: true,
        input: "split every CRLF boundary",
      }),
    });
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.match(text, /event: response\.completed/);
    await close(router);
    router = null;
    reopened = new ResponseHistory({ historyPath: fixture.historyPath });
    assert.equal(reopened.lookup(completed.id).state, "available");
  } finally {
    reopened?.close?.();
    await closeIfListening(router);
    await closeIfListening(upstream);
    cleanupHistoryFixture(fixture);
  }
});

test("native failed terminal passes through unchanged without recording history", async () => {
  let recordCalls = 0;
  const failed = {
    id: "resp_upstream_failed_terminal",
    object: "response",
    status: "failed",
    output: [],
    error: { code: "provider_failed", message: "provider marker" },
  };
  const upstream = http.createServer(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.end(`event: response.failed\ndata: ${JSON.stringify({
      type: "response.failed",
      response: failed,
    })}\n\ndata: [DONE]\n\n`);
  });
  const history = {
    get() {
      return [];
    },
    getResponseMeta() {
      return null;
    },
    recordTurn() {
      recordCalls += 1;
      throw new Error("must not record a failed response");
    },
  };
  let router;
  try {
    await listen(upstream);
    const config = nativeFailoverConfig(serverUrl(upstream));
    config.smartRouting.autoFailover = false;
    router = createRouterServer(config, { history });
    await listen(router);
    const response = await fetch(`${serverUrl(router)}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer fake-router-token",
      },
      body: JSON.stringify({
        model: "cb-native-primary",
        stream: true,
        input: "pass provider failure through",
      }),
    });
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.match(text, /provider marker/);
    assert.match(text, /event: response\.failed/);
    assert.doesNotMatch(text, /local_history_storage_unavailable/);
    assert.equal(recordCalls, 0);
  } finally {
    await closeIfListening(router);
    await closeIfListening(upstream);
  }
});

for (const scenario of [
  {
    name: "malformed completed",
    terminal: (response) =>
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: { ...response, status: "in_progress" },
      })}\n\ndata: [DONE]\n\n`,
  },
  {
    name: "DONE-only",
    terminal: () => "data: [DONE]\n\n",
  },
]) {
  test(`native ${scenario.name} terminal becomes failed without failover`, async () => {
    const upstreamBodies = [];
    const response = {
      ...nativeResponse(`resp_${scenario.name.replace(/\W+/g, "_")}`, "invalid terminal"),
      status: "in_progress",
    };
    const upstream = http.createServer(async (req, res) => {
      upstreamBodies.push(await readJson(req));
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      res.write(`event: response.created\ndata: ${JSON.stringify({
        type: "response.created",
        response: { ...response, output: [] },
      })}\n\n`);
      res.end(scenario.terminal(response));
    });
    let router;
    try {
      await listen(upstream);
      router = createRouterServer(nativeFailoverConfig(serverUrl(upstream)), {
        history: new ResponseHistory(),
      });
      await listen(router);
      const result = await fetch(`${serverUrl(router)}/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer fake-router-token",
        },
        body: JSON.stringify({
          model: "cb-native-primary",
          stream: true,
          input: `reject ${scenario.name}`,
        }),
      });
      const text = await result.text();

      assert.equal(result.status, 200);
      assert.match(text, /event: response\.failed/);
      assert.match(text, /upstream_stream_invalid_terminal/);
      assert.doesNotMatch(text, /event: response\.completed/);
      assert.equal(upstreamBodies.length, 1);
    } finally {
      await closeIfListening(router);
      await closeIfListening(upstream);
    }
  });
}

test("native incomplete terminal passes through unchanged without recording history", async () => {
  let recordCalls = 0;
  const incomplete = {
    ...nativeResponse("resp_upstream_incomplete_terminal", "partial provider output"),
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
  };
  const upstream = http.createServer(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.end(`event: response.incomplete\ndata: ${JSON.stringify({
      type: "response.incomplete",
      response: incomplete,
    })}\n\ndata: [DONE]\n\n`);
  });
  const history = {
    get() {
      return [];
    },
    getResponseMeta() {
      return null;
    },
    recordTurn() {
      recordCalls += 1;
      throw new Error("must not record an incomplete response");
    },
  };
  let router;
  try {
    await listen(upstream);
    const config = nativeFailoverConfig(serverUrl(upstream));
    config.smartRouting.autoFailover = false;
    router = createRouterServer(config, { history });
    await listen(router);
    const result = await fetch(`${serverUrl(router)}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer fake-router-token",
      },
      body: JSON.stringify({
        model: "cb-native-primary",
        stream: true,
        input: "pass provider incomplete through",
      }),
    });
    const text = await result.text();

    assert.equal(result.status, 200);
    assert.match(text, /event: response\.incomplete/);
    assert.match(text, /max_output_tokens/);
    assert.doesNotMatch(text, /upstream_stream_invalid_terminal/);
    assert.equal(recordCalls, 0);
  } finally {
    await closeIfListening(router);
    await closeIfListening(upstream);
  }
});

test("native terminal response larger than two megabytes persists and crosses to chat after restart", async () => {
  const fixture = historyFixture();
  const largeText = `${"L".repeat(2_200_000)}:large-terminal-tail-marker`;
  const chatBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const body = await readJson(req);
    if (req.url === "/v1/responses") {
      const completed = {
        ...nativeResponse("resp_large_native_terminal", largeText),
        output_text: largeText,
      };
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      res.write(`event: response.created\ndata: ${JSON.stringify({
        type: "response.created",
        response: { ...completed, status: "in_progress", output: [], output_text: "" },
      })}\n\n`);
      res.end(`event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: completed,
      })}\n\ndata: [DONE]\n\n`);
      return;
    }
    chatBodies.push(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(chatCompletion("chatcmpl_after_large_native", "continued")));
  });
  let firstRouter;
  let secondRouter;
  let reopened;
  try {
    await listen(upstream);
    const config = largeNativeToChatConfig(serverUrl(upstream));
    firstRouter = createRouterServer(config, { historyPath: fixture.historyPath });
    await listen(firstRouter);
    const firstResponse = await fetch(`${serverUrl(firstRouter)}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer fake-router-token",
      },
      body: JSON.stringify({
        model: "cb-native-large",
        stream: true,
        input: "produce a large terminal response",
      }),
    });
    const firstText = await firstResponse.text();
    assert.equal(firstResponse.status, 200);
    assert.match(firstText, /event: response\.completed/);
    await close(firstRouter);
    firstRouter = null;

    reopened = new ResponseHistory({ historyPath: fixture.historyPath });
    const stored = reopened.lookup("resp_large_native_terminal");
    assert.equal(stored.state, "available");
    assert.equal(stored.response.output_text.length, largeText.length);
    assert.match(stored.response.output_text, /large-terminal-tail-marker$/);
    reopened.close();
    reopened = null;

    secondRouter = createRouterServer(config, { historyPath: fixture.historyPath });
    await listen(secondRouter);
    const second = await postResponses(secondRouter, {
      model: "cb-chat-after-native",
      stream: false,
      previous_response_id: "resp_large_native_terminal",
      input: "continue on chat after restart",
    });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(chatBodies.length, 1);
    assert.match(JSON.stringify(chatBodies[0].messages), /large-terminal-tail-marker/);
  } finally {
    reopened?.close?.();
    await closeIfListening(firstRouter);
    await closeIfListening(secondRouter);
    await closeIfListening(upstream);
    cleanupHistoryFixture(fixture);
  }
});

function historyTurn(responseId, messages) {
  return {
    responseId,
    messages,
    response: {
      id: responseId,
      object: "response",
      status: "completed",
      output: [],
    },
    meta: {
      parentResponseId: null,
      routeSnapshot: {
        id: "cb-deepseek-history",
        api: "chat_completions",
        model: "deepseek-chat",
        baseUrl: "http://127.0.0.1/mock/v1",
        authMode: "api_key",
        apiKeyEnv: "FAKE_DEEPSEEK_KEY",
        contextWindow: 128000,
      },
    },
  };
}

function historyFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-history-"));
  return {
    dir,
    historyPath: path.join(dir, "response-history.sqlite3"),
  };
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

function chatRouterConfig(upstreamUrl) {
  return {
    host: "127.0.0.1",
    port: 0,
    authToken: "fake-router-token",
    defaultModel: "cb-deepseek-history",
    models: [
      {
        id: "cb-deepseek-history",
        displayName: "DeepSeek History Test",
        provider: "deepseek",
        api: "chat_completions",
        model: "deepseek-chat",
        baseUrl: `${upstreamUrl}/v1`,
        apiKey: "fake-upstream-key",
        apiKeyEnv: "FAKE_DEEPSEEK_KEY",
        contextWindow: 128000,
      },
    ],
  };
}

function chatCompletion(id, content) {
  return {
    id,
    object: "chat.completion",
    created: 1_700_000_000,
    model: "deepseek-chat",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };
}

function chatCompletionWithToolCall(id, callId) {
  return {
    id,
    object: "chat.completion",
    created: 1_700_000_000,
    model: "deepseek-chat",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: callId,
              type: "function",
              function: { name: "shell_command", arguments: "{\"command\":\"pwd\"}" },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };
}

function mixedRouterConfig(chatUpstreamUrl, nativeUpstreamUrl) {
  return {
    host: "127.0.0.1",
    port: 0,
    authToken: "fake-router-token",
    defaultModel: "cb-chat-history",
    models: [
      {
        id: "cb-chat-history",
        displayName: "Chat History Test",
        provider: "deepseek",
        api: "chat_completions",
        model: "deepseek-chat",
        baseUrl: `${chatUpstreamUrl}/v1`,
        apiKey: "fake-chat-key",
        apiKeyEnv: "FAKE_CHAT_KEY",
        contextWindow: 128000,
      },
      {
        id: "cb-native-history",
        displayName: "Native History Test",
        provider: "openai",
        api: "responses",
        model: "gpt-native-test",
        baseUrl: `${nativeUpstreamUrl}/v1`,
        apiKey: "fake-native-key",
        apiKeyEnv: "FAKE_NATIVE_KEY",
        contextWindow: 128000,
      },
    ],
  };
}

function nativeResponse(id, text) {
  return {
    id,
    object: "response",
    created_at: 1_700_000_000,
    status: "completed",
    model: "gpt-native-test",
    output: [
      {
        id: `${id}_message`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

function failingHistoryStore() {
  return {
    get() {
      return [];
    },
    getResponseMeta() {
      return null;
    },
    recordTurn() {
      const error = new Error("simulated native history write failure");
      error.statusCode = 503;
      error.code = "local_history_storage_unavailable";
      error.localHistoryError = true;
      throw error;
    },
  };
}

function nativeFailoverConfig(upstreamUrl) {
  return {
    host: "127.0.0.1",
    port: 0,
    authToken: "fake-router-token",
    defaultModel: "cb-native-primary",
    smartRouting: {
      autoSelectModel: false,
      autoFailover: true,
      failover: { mode: "ordered", routeIds: ["cb-native-backup"] },
    },
    models: [
      {
        id: "cb-native-primary",
        provider: "openai",
        api: "responses",
        model: "native-primary",
        baseUrl: `${upstreamUrl}/v1`,
        apiKey: "fake-native-primary-key",
      },
      {
        id: "cb-native-backup",
        provider: "openai",
        api: "responses",
        model: "native-backup",
        baseUrl: `${upstreamUrl}/v1`,
        apiKey: "fake-native-backup-key",
      },
    ],
  };
}

function imageHistoryFailoverConfig(upstreamUrl) {
  const route = (id, imageModel) => ({
    id,
    displayName: id,
    provider: "deepseek",
    api: "chat_completions",
    model: `${id}-chat-model`,
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: `fake-${id}-key`,
    imageGeneration: {
      enabled: true,
      mode: "custom",
      displayName: `${id} image provider`,
      baseUrl: `${upstreamUrl}/v1`,
      endpoint: "/images/generations",
      model: imageModel,
      apiKey: `fake-${id}-image-key`,
    },
  });
  return {
    host: "127.0.0.1",
    port: 0,
    authToken: "fake-router-token",
    defaultModel: "cb-image-history-primary",
    smartRouting: {
      autoSelectModel: false,
      autoFailover: true,
      failover: {
        mode: "ordered",
        routeIds: ["cb-image-history-backup"],
      },
    },
    models: [
      route("cb-image-history-primary", "primary-image-model"),
      route("cb-image-history-backup", "backup-image-model"),
    ],
  };
}

function imageGenerationRequest({ stream, input }) {
  return {
    model: "cb-image-history-primary",
    stream,
    input,
    tools: [{ type: "image_generation" }],
    tool_choice: { type: "image_generation" },
  };
}

function largeNativeToChatConfig(upstreamUrl) {
  return {
    host: "127.0.0.1",
    port: 0,
    authToken: "fake-router-token",
    defaultModel: "cb-native-large",
    models: [
      {
        id: "cb-native-large",
        provider: "openai",
        api: "responses",
        model: "native-large",
        baseUrl: `${upstreamUrl}/v1`,
        apiKey: "fake-native-large-key",
        contextWindow: 5_000_000,
      },
      {
        id: "cb-chat-after-native",
        provider: "deepseek",
        api: "chat_completions",
        model: "deepseek-chat",
        baseUrl: `${upstreamUrl}/v1`,
        apiKey: "fake-chat-key",
        contextWindow: 5_000_000,
      },
    ],
  };
}

async function postResponses(server, body) {
  const response = await fetch(`${serverUrl(server)}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer fake-router-token",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : {},
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
