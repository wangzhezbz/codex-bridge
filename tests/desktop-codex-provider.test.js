import test from "node:test";
import assert from "node:assert/strict";

import * as codexProvider from "../desktop/codex-provider.mjs";

const {
  CODEX_BRIDGE_PROVIDER_ID,
  codexBridgeProviderTomlLines,
} = codexProvider;

function providerTomlForMode(options) {
  assert.equal(typeof codexProvider.codexBridgeProviderTomlLinesForMode, "function");
  return codexProvider.codexBridgeProviderTomlLinesForMode(options).join("\n");
}

test("CodexBridge provider TOML keeps all-api mode independent from ChatGPT login", () => {
  const lines = codexBridgeProviderTomlLines({
    port: 15722,
    requiresOpenAiAuth: false,
    authToken: "cbr_test_token",
  });
  const toml = lines.join("\n");

  assert.equal(CODEX_BRIDGE_PROVIDER_ID, "codexbridge");
  assert.match(toml, /model_providers\.codexbridge\.base_url = "http:\/\/127\.0\.0\.1:15722\/v1"/);
  assert.match(toml, /model_providers\.codexbridge\.wire_api = "responses"/);
  assert.match(toml, /model_providers\.codexbridge\.requires_openai_auth = false/);
  assert.match(toml, /Authorization = "Bearer cbr_test_token"/);
  assert.match(toml, /stream_idle_timeout_ms = 600000/);
});

test("CodexBridge provider TOML passes Codex login through only in hybrid mode", () => {
  const toml = codexBridgeProviderTomlLines({ port: 17722, requiresOpenAiAuth: true }).join("\n");

  assert.match(toml, /base_url = "http:\/\/127\.0\.0\.1:17722\/v1"/);
  assert.match(toml, /requires_openai_auth = true/);
  assert.doesNotMatch(toml, /http_headers|sk-local-codex-router/);
});

test("strict provider mode mapping preserves OpenAI history scope for hybrid", () => {
  const toml = providerTomlForMode({ port: 16722, mode: "hybrid" });

  assert.match(toml, /openai_base_url = "http:\/\/127\.0\.0\.1:16722\/v1"/);
  assert.doesNotMatch(toml, /model_providers\.codexbridge|requires_openai_auth/);
  assert.doesNotMatch(toml, /http_headers|Authorization|sk-local-codex-router/);
});

test("strict provider mode mapping uses the supplied Router header for all_api", () => {
  const toml = providerTomlForMode({
    port: 18722,
    mode: "all_api",
    authToken: "cbr_test_token",
  });

  assert.match(toml, /base_url = "http:\/\/127\.0\.0\.1:18722\/v1"/);
  assert.match(toml, /requires_openai_auth = false/);
  assert.match(
    toml,
    /http_headers = \{ Authorization = "Bearer cbr_test_token" \}/,
  );
});

test("all-api provider generation fails closed without a local Router token", () => {
  assert.throws(
    () => providerTomlForMode({ port: 18722, mode: "all_api" }),
    /authToken is required/,
  );
});

test("strict provider mode mapping rejects unknown and empty modes", () => {
  for (const mode of [undefined, "", "login_only"]) {
    assert.throws(
      () => providerTomlForMode({ port: 15722, mode }),
      /Unsupported CodexBridge provider mode.*Expected "hybrid" or "all_api"/,
    );
  }
});

const oldFlash = "remote-deepseek-deepseek-flash";
const newFlash = "deepseek-v4-1-flash";
const migrationModels = [
  { presetId: "subscription", authMode: "codex_openai" },
  { presetId: newFlash, authMode: "api_key" },
  { presetId: "other-api", authMode: "api_key" },
];

for (const mode of ["all_api", "hybrid"]) {
  test(`preserving ${mode} selection compares verified legacy identities without changing order`, () => {
    const current = ["other-api", oldFlash, "subscription"];
    const expected = ["other-api", newFlash, "subscription"];
    const selected = codexProvider.selectedModelsForModeSwitch(current, expected, migrationModels, mode);
    assert.deepEqual(selected, mode === "all_api" ? ["other-api", newFlash] : ["other-api", newFlash, "subscription"]);
    assert.deepEqual(current, ["other-api", oldFlash, "subscription"]);
    assert.deepEqual(expected, ["other-api", newFlash, "subscription"]);
    assert.deepEqual(codexProvider.selectedModelsForModeSwitch(expected, current, migrationModels, mode), selected);
  });
}

test("mode migration still rejects actual changes, order changes and unverified aliases", () => {
  for (const [current, expected] of [
    [[oldFlash], ["other-api"]],
    [[oldFlash, "other-api"], ["other-api", newFlash]],
    [[oldFlash], [newFlash, "other-api"]],
    [[`${oldFlash}-2`], [newFlash]],
    [[oldFlash], [{}]],
  ]) {
    assert.throws(() => codexProvider.selectedModelsForModeSwitch(current, expected, migrationModels, "all_api"), /变化/);
  }
  assert.throws(() => codexProvider.selectedModelsForModeSwitch([oldFlash], [newFlash], [migrationModels[0]], "all_api"), /未选择 API/);
});

test("an explicitly configured legacy slot is not mistaken for a different canonical slot", () => {
  const models = [...migrationModels, { presetId: oldFlash, authMode: "api_key" }];
  assert.deepEqual(codexProvider.selectedModelsForModeSwitch([oldFlash], [oldFlash], models, "all_api"), [oldFlash]);
  assert.throws(() => codexProvider.selectedModelsForModeSwitch([oldFlash], [newFlash], models, "all_api"), /变化/);
});
