import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as settings from "../desktop/settings.mjs";
import {
  createConfigWriteCoordinator as createProductionConfigWriteCoordinator,
} from "../desktop/config-write-coordinator.mjs";

const API_MODEL_ID = "deepseek-v4-pro";
const API_ROUTE_ID = "cb-deepseek-v4-pro";
const SUBSCRIPTION_MODEL_ID = "codex-gpt-5-5";
const SUBSCRIPTION_ROUTE_ID = "cb-gpt-5-5";
const ROUTER_AUTH_TOKEN = "cbr_00000000000000000000000000000000";
const noOpPrivateAcl = Object.freeze({
  async securePath() {},
});

function createConfigWriteCoordinator(options = {}) {
  return createProductionConfigWriteCoordinator({
    privateAcl: noOpPrivateAcl,
    ...options,
  });
}

function makeWorkspace(label) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `codexbridge-mode-${label}-root-`));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `codexbridge-mode-${label}-home-`));
  return {
    rootDir,
    homeDir,
    targets: {
      selectionPath: settings.selectionPath(rootDir),
      routerConfigPath: settings.routerConfigPath(rootDir),
      codexCatalogPath: settings.codexCatalogPath(homeDir),
      codexConfigPath: settings.codexConfigPath(homeDir),
    },
  };
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function routeIdForPreset(presetId) {
  if (presetId === API_MODEL_ID) {
    return API_ROUTE_ID;
  }
  if (presetId === SUBSCRIPTION_MODEL_ID) {
    return SUBSCRIPTION_ROUTE_ID;
  }
  throw new Error(`Missing route fixture for ${presetId}`);
}

function seedCommittedState(workspace, {
  mode = settings.MODE_HYBRID,
  selectedModelIds = [SUBSCRIPTION_MODEL_ID],
  revision = "seed-revision",
} = {}) {
  const { rootDir, homeDir, targets } = workspace;
  fs.mkdirSync(path.dirname(targets.selectionPath), { recursive: true });
  fs.mkdirSync(path.dirname(targets.codexConfigPath), { recursive: true });

  const routeIds = selectedModelIds.map(routeIdForPreset);
  fs.writeFileSync(targets.selectionPath, jsonText({ mode, selectedModelIds }), "utf8");
  fs.writeFileSync(targets.routerConfigPath, jsonText({
    mode,
    configRevision: revision,
    authToken: ROUTER_AUTH_TOKEN,
    defaultModel: routeIds[0],
    models: selectedModelIds.map((sourcePresetId, index) => ({
      id: routeIds[index],
      sourcePresetId,
    })),
  }), "utf8");
  fs.writeFileSync(targets.codexCatalogPath, jsonText({
    models: routeIds.map((slug) => ({ slug })),
  }), "utf8");

  const bridgeToml = settings.buildCodexToml({
    rootDir,
    homeDir,
    mode,
    model: routeIds[0],
    authToken: ROUTER_AUTH_TOKEN,
  });
  fs.writeFileSync(
    targets.codexConfigPath,
    [
      'user_note = "keep-this-setting"',
      "",
      bridgeToml.trimEnd(),
      "",
      "[mcp_servers.keep_me]",
      'command = "keep-me"',
      "",
    ].join("\n"),
    "utf8",
  );
}

function readCommittedState(workspace) {
  const { targets } = workspace;
  return {
    selection: JSON.parse(fs.readFileSync(targets.selectionPath, "utf8")),
    routerConfig: JSON.parse(fs.readFileSync(targets.routerConfigPath, "utf8")),
    catalog: JSON.parse(fs.readFileSync(targets.codexCatalogPath, "utf8")),
    toml: fs.readFileSync(targets.codexConfigPath, "utf8"),
  };
}

function targetBytes(workspace) {
  return Object.fromEntries(
    Object.entries(workspace.targets).map(([key, target]) => [key, fs.readFileSync(target)]),
  );
}

function assertTargetBytes(workspace, expected) {
  for (const [key, target] of Object.entries(workspace.targets)) {
    assert.deepEqual(fs.readFileSync(target), expected[key], key);
  }
}

function assertNoTransactionArtifacts(workspace) {
  for (const directory of [
    path.dirname(workspace.targets.selectionPath),
    path.dirname(workspace.targets.codexConfigPath),
  ]) {
    const artifacts = fs.readdirSync(directory).filter((name) =>
      name.includes(".candidate.") || name.includes(".rollback."),
    );
    assert.deepEqual(artifacts, [], directory);
  }
}

function assertCommittedConsistency(workspace, {
  mode,
  selectedModelIds,
  routeIds,
  revision,
}) {
  const state = readCommittedState(workspace);
  assert.equal(state.selection.mode, mode);
  assert.deepEqual(state.selection.selectedModelIds, selectedModelIds);
  assert.equal(state.routerConfig.mode, mode);
  assert.equal(state.routerConfig.configRevision, revision);
  assert.deepEqual(
    state.routerConfig.models.map((model) => model.sourcePresetId),
    selectedModelIds,
  );
  assert.deepEqual(state.routerConfig.models.map((model) => model.id), routeIds);
  assert.deepEqual(state.catalog.models.map((model) => model.slug), routeIds);
  const tomlModel = state.toml.match(/^model = "([^"]+)"$/m)?.[1] || "";
  assert.ok(routeIds.includes(tomlModel), tomlModel);
  assert.match(state.toml, /user_note = "keep-this-setting"/);
  assert.match(state.toml, /\[mcp_servers\.keep_me]/);
  assert.match(state.toml, /command = "keep-me"/);
  return { ...state, tomlModel };
}

async function applyModeSwitchTransaction(options) {
  assert.equal(
    typeof settings.applyModeSwitchTransaction,
    "function",
    "desktop/settings.mjs must export applyModeSwitchTransaction",
  );
  const coordinator = options.coordinator || createConfigWriteCoordinator();
  coordinator.configure?.({
    allowedRoots: [options.rootDir, options.homeDir],
    journalDir: path.join(options.rootDir, ".config-transactions"),
  });
  return settings.applyModeSwitchTransaction({ ...options, coordinator });
}

test("hybrid to all-api commits four consistent targets with one published revision", async () => {
  const workspace = makeWorkspace("all-api");
  seedCommittedState(workspace);

  const result = await applyModeSwitchTransaction({
    rootDir: workspace.rootDir,
    homeDir: workspace.homeDir,
    mode: settings.MODE_ALL_API,
    selectedModelIds: [SUBSCRIPTION_MODEL_ID, API_MODEL_ID, API_MODEL_ID],
  });

  assert.equal(result.mode, settings.MODE_ALL_API);
  assert.deepEqual(result.selectedModelIds, [API_MODEL_ID]);
  assert.equal(typeof result.revision, "string");
  assert.ok(result.revision.length > 0);
  assert.equal(result.configRevision, result.revision);
  assert.equal(result.routerConfig.configRevision, result.revision);
  assert.deepEqual(result.targets, workspace.targets);
  assert.equal(result.restartRequired, true);
  const state = assertCommittedConsistency(workspace, {
    mode: settings.MODE_ALL_API,
    selectedModelIds: [API_MODEL_ID],
    routeIds: [API_ROUTE_ID],
    revision: result.revision,
  });
  assert.match(state.toml, /model_providers\.codexbridge\.requires_openai_auth = false/);
  assert.match(state.routerConfig.authToken, /^cbr_[a-f0-9]{32}$/);
  assert.match(
    state.toml,
    new RegExp(
      `model_providers\\.codexbridge\\.http_headers = \\{ Authorization = "Bearer ${state.routerConfig.authToken}" \\}`,
    ),
  );
  assert.doesNotMatch(state.toml, /sk-local-codex-router/);
});

test("all-api to hybrid preserves the OpenAI history namespace and proxies its base URL", async () => {
  const workspace = makeWorkspace("hybrid");
  seedCommittedState(workspace, {
    mode: settings.MODE_ALL_API,
    selectedModelIds: [API_MODEL_ID],
  });

  const result = await applyModeSwitchTransaction({
    rootDir: workspace.rootDir,
    homeDir: workspace.homeDir,
    mode: settings.MODE_HYBRID,
    selectedModelIds: [SUBSCRIPTION_MODEL_ID, API_MODEL_ID],
  });

  const state = assertCommittedConsistency(workspace, {
    mode: settings.MODE_HYBRID,
    selectedModelIds: [SUBSCRIPTION_MODEL_ID, API_MODEL_ID],
    routeIds: [SUBSCRIPTION_ROUTE_ID, API_ROUTE_ID],
    revision: result.revision,
  });
  assert.equal(state.tomlModel, API_ROUTE_ID);
  assert.match(state.toml, /model_provider = "openai"/);
  assert.match(state.toml, /openai_base_url = "http:\/\/127\.0\.0\.1:15722\/v1"/);
  assert.doesNotMatch(state.toml, /model_providers\.codexbridge/);
  assert.doesNotMatch(state.toml, /model_providers\.codexbridge\.http_headers/);
  assert.doesNotMatch(state.toml, /Bearer sk-local-codex-router/);
});

test("all-api succeeds in an empty home without reading or creating auth.json", async () => {
  const workspace = makeWorkspace("empty-home");
  const authPath = path.join(workspace.homeDir, ".codex", "auth.json");

  const result = await applyModeSwitchTransaction({
    rootDir: workspace.rootDir,
    homeDir: workspace.homeDir,
    mode: settings.MODE_ALL_API,
    selectedModelIds: [API_MODEL_ID],
  });

  assert.equal(result.mode, settings.MODE_ALL_API);
  assert.equal(fs.existsSync(authPath), false);
  assert.equal(fs.existsSync(workspace.targets.codexCatalogPath), true);
  assert.equal(fs.existsSync(workspace.targets.codexConfigPath), true);
});

test("candidate construction performs zero writes", () => {
  const workspace = makeWorkspace("candidate-only");
  assert.equal(
    typeof settings.buildModeSwitchCandidates,
    "function",
    "desktop/settings.mjs must export the pure candidate builder",
  );

  const candidate = settings.buildModeSwitchCandidates({
    rootDir: workspace.rootDir,
    homeDir: workspace.homeDir,
    mode: settings.MODE_ALL_API,
    selectedModelIds: [API_MODEL_ID],
    configRevision: "candidate-only-revision",
  });

  assert.equal(candidate.routerConfig.configRevision, "candidate-only-revision");
  assert.equal(candidate.entries.length, 4);
  assert.deepEqual(fs.readdirSync(workspace.rootDir), []);
  assert.deepEqual(fs.readdirSync(workspace.homeDir), []);
});

test("a last TOML rename failure restores all four targets byte-for-byte and cleans temps", async () => {
  const workspace = makeWorkspace("rename-failure");
  seedCommittedState(workspace);
  const before = targetBytes(workspace);
  let injected = false;
  const coordinator = createConfigWriteCoordinator({
    nextRevision: () => "draft-late-rename",
    fileOps: {
      rename: async (source, target) => {
        if (
          !injected &&
          path.resolve(target) === path.resolve(workspace.targets.codexConfigPath) &&
          path.basename(source).includes(".candidate.")
        ) {
          injected = true;
          const error = new Error("injected final TOML rename failure");
          error.code = "EACCES";
          throw error;
        }
        return fs.promises.rename(source, target);
      },
    },
  });

  await assert.rejects(
    () => applyModeSwitchTransaction({
      rootDir: workspace.rootDir,
      homeDir: workspace.homeDir,
      mode: settings.MODE_ALL_API,
      selectedModelIds: [API_MODEL_ID],
      coordinator,
    }),
    (error) => {
      assert.equal(error.code, "config_transaction_failed");
      assert.equal(error.configRevision, undefined);
      assert.equal(error.rollbackComplete, true);
      return true;
    },
  );

  assert.equal(injected, true);
  assertTargetBytes(workspace, before);
  assertNoTransactionArtifacts(workspace);
});

test("verification runs after all four commits and a mismatch rolls all four back", async () => {
  const workspace = makeWorkspace("verify-failure");
  seedCommittedState(workspace);
  const before = targetBytes(workspace);
  const coordinator = createConfigWriteCoordinator({
    nextRevision: () => "draft-health-mismatch",
  });
  let verificationCalls = 0;

  await assert.rejects(
    () => applyModeSwitchTransaction({
      rootDir: workspace.rootDir,
      homeDir: workspace.homeDir,
      mode: settings.MODE_ALL_API,
      selectedModelIds: [API_MODEL_ID],
      coordinator,
      verifyCommitted: async ({ configRevision, entries, value }) => {
        verificationCalls += 1;
        assert.equal(configRevision, "draft-health-mismatch");
        assert.equal(entries.length, 4);
        assert.equal(value.mode, settings.MODE_ALL_API);
        assertCommittedConsistency(workspace, {
          mode: settings.MODE_ALL_API,
          selectedModelIds: [API_MODEL_ID],
          routeIds: [API_ROUTE_ID],
          revision: configRevision,
        });
        throw new Error("injected Router health model mismatch");
      },
    }),
    (error) => {
      assert.equal(error.code, "config_transaction_failed");
      assert.equal(error.configRevision, undefined);
      return true;
    },
  );

  assert.equal(verificationCalls, 1);
  assertTargetBytes(workspace, before);
  assertNoTransactionArtifacts(workspace);
});

test("two concurrent mode transactions are serialized and cannot publish mixed files", async () => {
  const workspace = makeWorkspace("concurrent");
  const coordinator = createConfigWriteCoordinator();
  seedCommittedState(workspace, {
    mode: settings.MODE_ALL_API,
    selectedModelIds: [API_MODEL_ID],
  });

  let enterFirstVerification;
  const firstVerificationEntered = new Promise((resolve) => {
    enterFirstVerification = resolve;
  });
  let releaseFirstVerification;
  const holdFirstVerification = new Promise((resolve) => {
    releaseFirstVerification = resolve;
  });
  let enterSecondVerification;
  const secondVerificationEntered = new Promise((resolve) => {
    enterSecondVerification = resolve;
  });

  const first = applyModeSwitchTransaction({
    rootDir: workspace.rootDir,
    homeDir: workspace.homeDir,
    coordinator,
    mode: settings.MODE_HYBRID,
    selectedModelIds: [SUBSCRIPTION_MODEL_ID],
    verifyCommitted: async ({ configRevision }) => {
      assertCommittedConsistency(workspace, {
        mode: settings.MODE_HYBRID,
        selectedModelIds: [SUBSCRIPTION_MODEL_ID],
        routeIds: [SUBSCRIPTION_ROUTE_ID],
        revision: configRevision,
      });
      enterFirstVerification();
      await holdFirstVerification;
      assertCommittedConsistency(workspace, {
        mode: settings.MODE_HYBRID,
        selectedModelIds: [SUBSCRIPTION_MODEL_ID],
        routeIds: [SUBSCRIPTION_ROUTE_ID],
        revision: configRevision,
      });
    },
  });

  await firstVerificationEntered;
  const second = applyModeSwitchTransaction({
    rootDir: workspace.rootDir,
    homeDir: workspace.homeDir,
    coordinator,
    mode: settings.MODE_ALL_API,
    selectedModelIds: [API_MODEL_ID],
    verifyCommitted: async () => {
      enterSecondVerification();
    },
  });

  const secondInterleaved = await Promise.race([
    secondVerificationEntered.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 50)),
  ]);
  try {
    assert.equal(secondInterleaved, false);
  } finally {
    releaseFirstVerification();
  }

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.notEqual(firstResult.revision, secondResult.revision);
  assertCommittedConsistency(workspace, {
    mode: settings.MODE_ALL_API,
    selectedModelIds: [API_MODEL_ID],
    routeIds: [API_ROUTE_ID],
    revision: secondResult.revision,
  });
});
