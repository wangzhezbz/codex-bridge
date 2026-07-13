import test from "node:test";
import assert from "node:assert/strict";

import { createCodexModelSelectionState } from "../src/codex-model-selection.js";

test("explicit model settings repair only stale reconnects in the same Codex thread", () => {
  const state = createCodexModelSelectionState();
  const firstHeaders = {
    "x-codex-thread-id": "thread-first",
    "x-codex-window-id": "window-first",
    "x-codex-turn-state": "reconnecting",
  };
  const otherHeaders = {
    "x-codex-thread-id": "thread-other",
    "x-codex-window-id": "window-other",
    "x-codex-turn-state": "reconnecting",
  };
  const configuredModelIds = ["kimi-k2-6", "gpt-5.6-sol"];

  state.applyToRequest({
    headers: firstHeaders,
    body: { model: "kimi-k2-6" },
    configuredModelIds,
  });
  const setting = state.recordModelSetting({
    headers: firstHeaders,
    pathname: "/v1/responses",
    body: { model: "gpt-5.6-sol" },
  });
  assert.equal(setting.recorded, true);
  assert.equal(setting.previousModel, "kimi-k2-6");
  const repeatedSetting = state.recordModelSetting({
    headers: firstHeaders,
    pathname: "/v1/responses",
    body: { model: "gpt-5.6-sol" },
  });
  assert.equal(repeatedSetting.previousModel, "kimi-k2-6");

  const staleReconnectBody = {
    model: "kimi-k2-6",
    previous_response_id: "resp_kimi_failed",
  };
  const repaired = state.applyToRequest({
    headers: firstHeaders,
    body: staleReconnectBody,
    configuredModelIds,
  });
  assert.equal(repaired.changed, true);
  assert.equal(staleReconnectBody.model, "gpt-5.6-sol");

  const otherThreadBody = {
    model: "kimi-k2-6",
    previous_response_id: "resp_other",
  };
  const isolated = state.applyToRequest({
    headers: otherHeaders,
    body: otherThreadBody,
    configuredModelIds,
  });
  assert.equal(isolated.changed, false);
  assert.equal(otherThreadBody.model, "kimi-k2-6");
});

test("explicit model settings do not rewrite a normal new request", () => {
  const state = createCodexModelSelectionState();
  const headers = { "x-codex-thread-id": "thread-normal-new-request" };
  const configuredModelIds = ["kimi-k2-6", "gpt-5.6-sol"];

  state.applyToRequest({
    headers,
    body: { model: "kimi-k2-6" },
    configuredModelIds,
  });
  state.recordModelSetting({
    headers,
    pathname: "/v1/responses",
    body: { model: "gpt-5.6-sol" },
  });

  const newRequestBody = { model: "kimi-k2-6" };
  const result = state.applyToRequest({
    headers,
    body: newRequestBody,
    configuredModelIds,
  });
  assert.equal(result.changed, false);
  assert.equal(newRequestBody.model, "kimi-k2-6");
});

test("per-response model settings use durable history as the previous model hint", () => {
  const state = createCodexModelSelectionState();
  const configuredModelIds = ["kimi-k2-6", "gpt-5.6-sol"];

  const setting = state.recordModelSetting({
    pathname: "/v1/responses/resp_kimi/model_settings",
    body: { model: "gpt-5.6-sol" },
    previousModel: "kimi-k2-6",
  });
  assert.equal(setting.recorded, true);
  assert.equal(setting.previousModel, "kimi-k2-6");

  const reconnectBody = {
    model: "kimi-k2-6",
    previous_response_id: "resp_kimi",
  };
  const result = state.applyToRequest({
    body: reconnectBody,
    configuredModelIds,
  });
  assert.equal(result.changed, true);
  assert.equal(reconnectBody.model, "gpt-5.6-sol");
});
