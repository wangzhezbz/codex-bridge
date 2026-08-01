import assert from "node:assert/strict";
import test from "node:test";

test("history turn metadata replaces stale parent and route snapshot values", async () => {
  const { buildHistoryTurn } = await import("../src/upstream-history-metadata.js");
  const response = { id: "resp_history_turn", object: "response", output: [] };
  const messages = [{ role: "user", content: "preserve this turn" }];
  const route = {
    id: "cb-history-route",
    provider: "openai",
    api: "responses",
    model: "gpt-history",
    baseUrl: "https://example.test/v1",
    authMode: "api_key",
    apiKeyEnv: "HISTORY_API_KEY",
    apiKey: "must-not-be-persisted",
    contextWindow: 128_000,
  };

  const turn = buildHistoryTurn(
    response,
    messages,
    {
      api: "responses",
      parentResponseId: "stale-parent",
      routeSnapshot: { id: "stale-route" },
    },
    {
      requestBody: { previous_response_id: "resp_parent" },
      route,
    },
  );

  assert.equal(turn.responseId, "resp_history_turn");
  assert.equal(turn.response, response);
  assert.equal(turn.messages, messages);
  assert.equal(turn.meta.api, "responses");
  assert.equal(turn.meta.parentResponseId, "resp_parent");
  assert.equal(turn.meta.routeSnapshot.id, "cb-history-route");
  assert.equal(turn.meta.routeSnapshot.apiKeyEnv, "HISTORY_API_KEY");
  assert.equal(turn.meta.routeSnapshot.credentialSource, "inline");
  assert.equal("apiKey" in turn.meta.routeSnapshot, false);
});

test("history turn metadata uses a minimal snapshot for malformed legacy routes", async () => {
  const { buildHistoryTurn } = await import("../src/upstream-history-metadata.js");

  const turn = buildHistoryTurn(
    { id: "resp_legacy", object: "response" },
    [],
    {},
    {
      requestBody: {},
      route: {
        id: "legacy-route",
        api: "chat_completions",
        model: "legacy-model",
        contextWindow: 0,
      },
    },
  );

  assert.equal(turn.meta.parentResponseId, null);
  assert.deepEqual(turn.meta.routeSnapshot, {
    id: "legacy-route",
    api: "chat_completions",
    model: "legacy-model",
  });
});

test("history turn builder rejects responses without an id", async () => {
  const { buildHistoryTurn } = await import("../src/upstream-history-metadata.js");

  assert.equal(buildHistoryTurn({ object: "response" }, [], {}, {}), null);
  assert.equal(buildHistoryTurn(null, [], {}, {}), null);
});
