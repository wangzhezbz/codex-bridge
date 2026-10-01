import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createConfigWriteCoordinator } from "../desktop/config-write-coordinator.mjs";
import * as settings from "../desktop/settings.mjs";
import { runModeSelect } from "../desktop/mode-switch-handler.mjs";

const API_MODEL_ID = "deepseek-v4-pro";
const API_ROUTE_ID = "cb-deepseek-v4-pro";
const SECRET_VALUE = "test-only-provider-key-must-not-leak";
const ROUTER_AUTH_TOKEN = "cbr_00000000000000000000000000000000";
const noOpPrivateAcl = Object.freeze({
  async securePath() {},
});

const legacyFlashId = "remote-deepseek-deepseek-flash";
const currentFlashId = "deepseek-v4-1-flash";

function legacyModeWorkspace(label) {
  const workspace = makeWorkspace(label);
  fs.writeFileSync(settings.selectionPath(workspace.rootDir), JSON.stringify({ selectedModelIds: [legacyFlashId] }));
  fs.writeFileSync(settings.modelDirectoryPath(workspace.rootDir), JSON.stringify({ version: 1, providers: { deepseek: {
    providerId: "deepseek", providerName: "DeepSeek", baseUrl: "https://api.deepseek.com/v1",
    source: "remote", fetchedAt: "2026-09-22T00:00:00.000Z",
    models: [{ id: "deepseek-v4-pro" }, { id: "deepseek-flash" }],
  } } }));
  fs.writeFileSync(settings.modelCapabilitiesPath(workspace.rootDir), JSON.stringify({ version: 3, overrides: {
    [legacyFlashId]: { contextWindow: 131072, api: "responses", inputModalities: ["text"] },
  } }));
  return workspace;
}

for (const [flag, mode] of [["preserveApiSelection", "all_api"], ["preserveSelection", "all_api"], ["preserveSelection", "hybrid"]]) {
  test(`legacy Flash ${flag} to ${mode} commits through both checks and preserves its settings`, async () => {
    const workspace = legacyModeWorkspace(`legacy-mode-${flag}-${mode}`);
    const coordinator = coordinatorFor(workspace);
    const expected = settings.readSelection(workspace.rootDir, "hybrid");
    assert.deepEqual(expected, [currentFlashId]);
    await runModeSelect({ ...workspace, mode, [flag]: true, expectedSelectedModelIds: expected, routerRunning: false,
      settings: { ...settings, applyModeSwitchTransaction: args => settings.applyModeSwitchTransaction({ ...args, coordinator }) },
      locateCodexInstall: async () => ({ found: false }), getStatePayload: async () => ({}),
      broadcastState: async () => {}, appendLog: () => {},
    });
    const config = settings.readRouterConfig(workspace.rootDir);
    assert.equal(config.mode, mode);
    assert.equal(config.models.length, 1);
    assert.equal(config.models[0].model, "deepseek-flash");
    assert.equal(config.models[0].api, "responses");
    assert.equal(config.models[0].contextWindow, 131072);
    assert.deepEqual(config.models[0].inputModalities, ["text"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(settings.selectionPath(workspace.rootDir))).selectedModelIds, [currentFlashId]);
    assert.match(fs.readFileSync(settings.codexConfigPath(workspace.homeDir), "utf8"), /preserve-byte-for-byte/);
  });
}

test("legacy mode normalization does not hide an intervening selection edit under the transaction lock", async () => {
  const workspace = legacyModeWorkspace("legacy-mode-race");
  const coordinator = coordinatorFor(workspace);
  const routerBefore = fs.readFileSync(settings.routerConfigPath(workspace.rootDir));
  const tomlBefore = fs.readFileSync(settings.codexConfigPath(workspace.homeDir));
  const externalSelection = JSON.stringify({ selectedModelIds: [API_MODEL_ID] });
  let transactionCalls = 0;
  await assert.rejects(runModeSelect({ ...workspace, mode: "all_api", preserveApiSelection: true,
    expectedSelectedModelIds: [currentFlashId], routerRunning: false,
    settings: { ...settings, applyModeSwitchTransaction: async args => {
      transactionCalls += 1;
      fs.writeFileSync(settings.selectionPath(workspace.rootDir), externalSelection);
      return settings.applyModeSwitchTransaction({ ...args, coordinator });
    } },
    locateCodexInstall: async () => ({ found: false }), getStatePayload: async () => ({}),
    broadcastState: async () => {}, appendLog: () => {},
  }), error => error.code === "config_transaction_failed" && error.failurePhase === "planning");
  assert.equal(transactionCalls, 1, "the known alias must pass the first check so the in-lock check is exercised");
  assert.equal(fs.readFileSync(settings.selectionPath(workspace.rootDir), "utf8"), externalSelection);
  assert.deepEqual(fs.readFileSync(settings.routerConfigPath(workspace.rootDir)), routerBefore);
  assert.deepEqual(fs.readFileSync(settings.codexConfigPath(workspace.homeDir)), tomlBefore);
});

test("API recovery checks the latest selection inside the configuration transaction", async () => {
  const {rootDir,homeDir}=makeWorkspace('api-recovery-stale');
  const files=[settings.selectionPath(rootDir),settings.routerConfigPath(rootDir),settings.codexConfigPath(homeDir)];
  const before=files.map(file=>fs.readFileSync(file));
  await assert.rejects(settings.applyModeSwitchTransaction({rootDir,homeDir,mode:settings.MODE_ALL_API,
    selectedModelIds:[API_MODEL_ID],preserveApiSelection:true,expectedSelectedModelIds:['previous-choice'],
    coordinator:coordinatorFor({rootDir,homeDir})}));
  for(const [index,file] of files.entries()) assert.deepEqual(fs.readFileSync(file),before[index]);
});

test("hybrid return rechecks a preserving selection inside the configuration transaction", async () => {
  const {rootDir,homeDir}=makeWorkspace('hybrid-return-stale');
  const files=[settings.selectionPath(rootDir),settings.routerConfigPath(rootDir),settings.codexConfigPath(homeDir)];
  const before=files.map(file=>fs.readFileSync(file));
  await assert.rejects(settings.applyModeSwitchTransaction({rootDir,homeDir,mode:settings.MODE_HYBRID,
    selectedModelIds:[API_MODEL_ID],preserveSelection:true,expectedSelectedModelIds:['previous-choice'],
    coordinator:coordinatorFor({rootDir,homeDir})}));
  for(const [index,file] of files.entries()) assert.deepEqual(fs.readFileSync(file),before[index]);
});

test("exact draft saves refuse stale billing modes and incompatible subscription presets without writes", async () => {
  for (const payload of [
    {selectedModelIds:[API_MODEL_ID],expectedMode:'hybrid'},
    {selectedModelIds:['codex-gpt-6-astra'],expectedMode:'all_api'},
    {selectedModelIds:['missing-custom-api'],expectedMode:'all_api'},
  ]) {
    const {rootDir,homeDir}=makeWorkspace('exact-draft');
    const files=[settings.selectionPath(rootDir),settings.routerConfigPath(rootDir),settings.codexConfigPath(homeDir)];
    const before=files.map(file=>fs.readFileSync(file));
    await assert.rejects(settings.applyConfigMutationTransaction({rootDir,homeDir,operation:'models:saveSelection',
      payload:{...payload,exactSelection:true},coordinator:coordinatorFor({rootDir,homeDir})}));
    for(const [index,file] of files.entries()) assert.deepEqual(fs.readFileSync(file),before[index]);
  }
});

test("exact draft saves commit compatible API IDs without normalizing their order", async () => {
  const {rootDir,homeDir}=makeWorkspace('exact-draft-valid');
  const ids=['deepseek-v4-flash',API_MODEL_ID];
  await settings.applyConfigMutationTransaction({rootDir,homeDir,operation:'models:saveSelection',
    payload:{selectedModelIds:ids,expectedMode:'all_api',exactSelection:true},coordinator:coordinatorFor({rootDir,homeDir})});
  assert.deepEqual(JSON.parse(fs.readFileSync(settings.selectionPath(rootDir),'utf8')).selectedModelIds,ids);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings.routerConfigPath(rootDir),'utf8')).models.map(model=>model.id),['cb-deepseek-v4-flash',API_ROUTE_ID]);
});

function makeWorkspace(label) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `codexbridge-config-${label}-root-`));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `codexbridge-config-${label}-home-`));
  const configDir = path.join(rootDir, "config");
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    settings.selectionPath(rootDir),
    `${JSON.stringify({ mode: settings.MODE_ALL_API, selectedModelIds: [API_MODEL_ID] }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    settings.routerConfigPath(rootDir),
    `${JSON.stringify({
      mode: settings.MODE_ALL_API,
      authToken: ROUTER_AUTH_TOKEN,
      models: [],
    }, null, 2)}\n`,
    "utf8",
  );
  const managed = settings.buildCodexToml({
    rootDir,
    homeDir,
    mode: settings.MODE_ALL_API,
    model: API_ROUTE_ID,
    authToken: ROUTER_AUTH_TOKEN,
  });
  fs.writeFileSync(
    settings.codexConfigPath(homeDir),
    `# 用户自己的注释\r\nuser_setting = "preserve-byte-for-byte"\r\n\r\n${managed.replaceAll("\n", "\r\n")}\r\n`,
    "utf8",
  );
  return { rootDir, homeDir };
}

function coordinatorFor({ rootDir, homeDir, fileOps } = {}) {
  const journalDir = path.join(rootDir, ".config-transactions");
  const coordinator = createConfigWriteCoordinator({
    fileOps,
    privateAcl: noOpPrivateAcl,
  });
  if (typeof coordinator.configure === "function") {
    coordinator.configure({ allowedRoots: [rootDir, homeDir], journalDir });
  }
  return coordinator;
}

function codexRestoreCoordinatorFor(homeDir, fileOps) {
  const codexDir = path.join(homeDir, ".codex");
  const coordinator = createConfigWriteCoordinator({
    fileOps,
    privateAcl: noOpPrivateAcl,
  });
  coordinator.configure({
    allowedRoots: [codexDir],
    journalDir: path.join(codexDir, ".restore-transactions"),
  });
  return coordinator;
}

function transactionTargets({ rootDir, homeDir }) {
  return [
    settings.providerOverridesPath(rootDir),
    settings.secretsPath(rootDir),
    settings.configProfilesPath(rootDir),
    settings.customModelsPath(rootDir),
    settings.modelCapabilitiesPath(rootDir),
    settings.modelDirectoryPath(rootDir),
    settings.capabilityProvidersPath(rootDir),
    settings.imageProvidersPath(rootDir),
    settings.modelImageGenerationPath(rootDir),
    settings.selectionPath(rootDir),
    settings.desktopOptionsPath(rootDir),
    settings.routerConfigPath(rootDir),
    settings.catalogPath(rootDir),
    settings.codexCatalogPath(homeDir),
    settings.codexConfigPath(homeDir),
  ];
}

function snapshotTargets(workspace) {
  return new Map(transactionTargets(workspace).map((target) => [
    target,
    fs.existsSync(target) ? fs.readFileSync(target) : null,
  ]));
}

function assertTargetsEqual(snapshot) {
  for (const [target, expected] of snapshot) {
    if (expected === null) {
      assert.equal(fs.existsSync(target), false, target);
    } else {
      assert.deepEqual(fs.readFileSync(target), expected, target);
    }
  }
}

function assertSecretAbsentFromNonSecretTargets(workspace, secret) {
  for (const target of transactionTargets(workspace)) {
    if (path.resolve(target) === path.resolve(settings.secretsPath(workspace.rootDir))) {
      continue;
    }
    if (fs.existsSync(target)) {
      assert.equal(fs.readFileSync(target).includes(Buffer.from(secret, "utf8")), false, target);
    }
  }
}

test("provider and typed key commit with one revision across sources, Router, catalogs, and managed TOML", async () => {
  const workspace = makeWorkspace("provider-key-success");
  const result = await settings.applyConfigMutationTransaction({
    ...workspace,
    coordinator: coordinatorFor(workspace),
    operation: "providers:save",
    payload: {
      provider: {
        id: "deepseek",
        name: "DeepSeek Atomic",
        baseUrl: "https://atomic.example/v1",
        api: "chat_completions",
        keyEnv: "DEEPSEEK_API_KEY",
        apiKey: SECRET_VALUE,
      },
    },
  });

  assert.equal(result.operation, "providers:save");
  assert.equal(result.configRevision, result.revision);
  assert.equal(result.routerConfig.configRevision, result.revision);
  assert.equal(result.result.saved.id, "deepseek");
  assert.equal(settings.loadSecrets(workspace.rootDir).DEEPSEEK_API_KEY, SECRET_VALUE);
  assert.equal(settings.readProviderOverrides(workspace.rootDir).deepseek.name, "DeepSeek Atomic");

  const router = settings.readRouterConfig(workspace.rootDir);
  const route = router.models.find((item) => item.id === API_ROUTE_ID);
  assert.equal(route.baseUrl, "https://atomic.example/v1");
  assert.equal(route.apiKeyEnv, "DEEPSEEK_API_KEY");
  const rootCatalog = JSON.parse(fs.readFileSync(settings.catalogPath(workspace.rootDir), "utf8"));
  const codexCatalog = JSON.parse(fs.readFileSync(settings.codexCatalogPath(workspace.homeDir), "utf8"));
  assert.deepEqual(
    rootCatalog.models.map((model) => model.slug),
    codexCatalog.models.map((model) => model.slug),
  );
  assert.deepEqual(rootCatalog.models.map((model) => model.slug), [API_ROUTE_ID]);
  const toml = fs.readFileSync(settings.codexConfigPath(workspace.homeDir), "utf8");
  assert.match(toml, /# 用户自己的注释\r\nuser_setting = "preserve-byte-for-byte"\r\n/);
  assert.match(toml, new RegExp(`model = "${API_ROUTE_ID}"`));
  assertSecretAbsentFromNonSecretTargets(workspace, SECRET_VALUE);
});

test("legacy Kimi Code endpoint migration copies its old key once without changing Moonshot defaults", async () => {
  const workspace = makeWorkspace("legacy-kimi-code-provider");
  const legacyKimiCodeKey = "legacy-kimi-code-key";
  fs.writeFileSync(
    settings.providerOverridesPath(workspace.rootDir),
    `${JSON.stringify({
      version: 1,
      providers: {
        kimi: {
          id: "kimi",
          name: "Kimi",
          baseUrl: "https://api.kimi.com/coding/v1",
          keyEnv: "MOONSHOT_API_KEY",
          keyLabel: "Kimi API Key",
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    settings.secretsPath(workspace.rootDir),
    `${JSON.stringify({
      DEEPSEEK_API_KEY: SECRET_VALUE,
      MOONSHOT_API_KEY: legacyKimiCodeKey,
    }, null, 2)}\n`,
    "utf8",
  );

  await settings.applyConfigMutationTransaction({
    ...workspace,
    coordinator: coordinatorFor(workspace),
    operation: "providers:save",
    payload: {
      provider: {
        id: "deepseek",
        baseUrl: "https://api.deepseek.com/v1",
        keyEnv: "DEEPSEEK_API_KEY",
      },
    },
  });

  const providers = settings.providerCatalog(workspace.rootDir);
  const secrets = settings.loadSecrets(workspace.rootDir);
  const overrides = settings.readProviderOverrides(workspace.rootDir);
  assert.equal(overrides.kimi, undefined);
  assert.equal(overrides["kimi-code"].baseUrl, "https://api.kimi.com/coding/v1");
  assert.equal(secrets.MOONSHOT_API_KEY, legacyKimiCodeKey);
  assert.equal(secrets.KIMI_CODE_API_KEY, legacyKimiCodeKey);
  assert.equal(
    providers.find((provider) => provider.id === "kimi").baseUrl,
    "https://api.moonshot.cn/v1",
  );
  assert.equal(
    providers.find((provider) => provider.id === "kimi-code").keyEnv,
    "KIMI_CODE_API_KEY",
  );
});

test("legacy Kimi Code migration preserves an existing dedicated Kimi Code key", async () => {
  const workspace = makeWorkspace("legacy-kimi-code-existing-key");
  fs.writeFileSync(
    settings.providerOverridesPath(workspace.rootDir),
    `${JSON.stringify({
      version: 1,
      providers: {
        kimi: {
          id: "kimi",
          name: "Kimi",
          baseUrl: "https://api.kimi.com/coding/v1",
          keyEnv: "MOONSHOT_API_KEY",
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    settings.secretsPath(workspace.rootDir),
    `${JSON.stringify({
      DEEPSEEK_API_KEY: SECRET_VALUE,
      MOONSHOT_API_KEY: "legacy-key",
      KIMI_CODE_API_KEY: "dedicated-key",
    }, null, 2)}\n`,
    "utf8",
  );

  await settings.applyConfigMutationTransaction({
    ...workspace,
    coordinator: coordinatorFor(workspace),
    operation: "providers:save",
    payload: {
      provider: {
        id: "deepseek",
        baseUrl: "https://api.deepseek.com/v1",
        keyEnv: "DEEPSEEK_API_KEY",
      },
    },
  });

  const secrets = settings.loadSecrets(workspace.rootDir);
  assert.equal(secrets.MOONSHOT_API_KEY, "legacy-key");
  assert.equal(secrets.KIMI_CODE_API_KEY, "dedicated-key");
});

test("a custom API-key model using the codex provider id does not collide with the native subscription route", async () => {
  const workspace = makeWorkspace("custom-codex-provider-route-id");
  fs.writeFileSync(
    settings.selectionPath(workspace.rootDir),
    `${JSON.stringify({ mode: settings.MODE_HYBRID, selectedModelIds: ["codex-gpt-5-6-sol"] }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    settings.routerConfigPath(workspace.rootDir),
    `${JSON.stringify({ mode: settings.MODE_HYBRID, models: [] }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    settings.codexConfigPath(workspace.homeDir),
    settings.buildCodexToml({
      ...workspace,
      mode: settings.MODE_HYBRID,
      model: "cb-gpt-5-6-sol",
    }),
    "utf8",
  );
  const custom = settings.saveCustomModel(workspace.rootDir, {
    providerId: "codex",
    providerName: "GPT Custom Relay",
    displayName: "Custom GPT-5.6 Sol",
    model: "gpt-5.6-sol",
    baseUrl: "https://relay.example/v1",
    api: "responses",
    keyEnv: "GPT_API_KEY",
  });

  const committed = await settings.applyConfigMutationTransaction({
    ...workspace,
    coordinator: coordinatorFor(workspace),
    operation: "models:saveSelection",
    payload: {
      selectedModelIds: ["codex-gpt-5-6-sol", custom.presetId],
    },
  });

  assert.deepEqual(committed.selectedModelIds, ["codex-gpt-5-6-sol", custom.presetId]);
  assert.deepEqual(
    committed.routerConfig.models.map((model) => model.id),
    ["cb-gpt-5-6-sol", `cb-${custom.presetId}`],
  );
  assert.equal(new Set(committed.routerConfig.models.map((model) => model.id)).size, 2);
  const customRoute = committed.routerConfig.models.find((model) => model.sourcePresetId === custom.presetId);
  assert.equal(customRoute.authMode, "api_key");
  assert.equal(customRoute.baseUrl, "https://relay.example/v1");
  assert.equal(customRoute.apiKeyEnv, "GPT_API_KEY");
});

test("provider save retries a transient half-written managed TOML snapshot", async () => {
  const workspace = makeWorkspace("provider-transient-managed-toml");
  const target = settings.codexConfigPath(workspace.homeDir);
  const validConfig = fs.readFileSync(target);
  fs.writeFileSync(target, '# 用户自己的注释\n# >>> CodexBridge managed config\nmodel = "partial"\n', "utf8");
  let retryCount = 0;

  const result = await settings.applyConfigMutationTransaction({
    ...workspace,
    coordinator: coordinatorFor(workspace),
    operation: "providers:save",
    payload: {
      provider: {
        id: "deepseek",
        name: "DeepSeek Retry",
        baseUrl: "https://retry.example/v1",
        api: "chat_completions",
        keyEnv: "DEEPSEEK_API_KEY",
      },
    },
    waitForManagedTomlRetry: async () => {
      retryCount += 1;
      fs.writeFileSync(target, validConfig);
    },
  });

  assert.equal(retryCount, 1);
  assert.equal(result.result.saved.name, "DeepSeek Retry");
  assert.match(fs.readFileSync(target, "utf8"), /# >>> CodexBridge managed config/);
});

test("provider save does not overwrite a persistently malformed managed TOML block", async () => {
  const workspace = makeWorkspace("provider-persistent-invalid-managed-toml");
  const target = settings.codexConfigPath(workspace.homeDir);
  const malformed = '# 用户自己的注释\n# >>> CodexBridge managed config\nmodel = "partial"\n';
  fs.writeFileSync(target, malformed, "utf8");
  let retryCount = 0;

  await assert.rejects(
    settings.applyConfigMutationTransaction({
      ...workspace,
      coordinator: coordinatorFor(workspace),
      operation: "providers:save",
      payload: {
        provider: {
          id: "deepseek",
          name: "DeepSeek Persistent Invalid",
          baseUrl: "https://persistent-invalid.example/v1",
          api: "chat_completions",
          keyEnv: "DEEPSEEK_API_KEY",
        },
      },
      managedTomlRetryDelays: [0, 0, 0],
      waitForManagedTomlRetry: async () => {
        retryCount += 1;
      },
    }),
    (error) => {
      assert.equal(error.code, "config_transaction_failed");
      assert.equal(error.causeCode, "managed_toml_invalid");
      return true;
    },
  );

  assert.equal(retryCount, 3);
  assert.equal(fs.readFileSync(target, "utf8"), malformed);
});

test("Router start repairs a persistent malformed managed block, keeps a forensic backup, and stop restores valid user TOML", async () => {
  const workspace = makeWorkspace("router-start-repairs-invalid-managed-toml");
  const target = settings.codexConfigPath(workspace.homeDir);
  const malformed = Buffer.from([
    "# user comment",
    'model = "gpt-5.5"',
    'sandbox_mode = "workspace-write"',
    "# >>> CodexBridge managed config",
    'model = "cb-stale"',
    'openai_base_url = "http://127.0.0.1:15722/v1"',
    "",
    '[plugins."keep@openai-curated"]',
    "enabled = true",
    "",
  ].join("\r\n"), "utf8");
  fs.writeFileSync(target, malformed);
  const coordinator = coordinatorFor(workspace);

  await settings.applyConfigMutationTransaction({
    ...workspace,
    coordinator,
    operation: "router:start",
    managedTomlRetryDelays: [],
  });

  const running = fs.readFileSync(target, "utf8");
  assert.equal((running.match(/# >>> CodexBridge managed config/g) || []).length, 1);
  assert.match(running, /\[plugins\."keep@openai-curated"\]/);
  assert.equal((running.match(/127\.0\.0\.1:15722\/v1/g) || []).length, 1);

  const originalBackup = fs.readFileSync(settings.codexRouterOriginalPath(workspace.homeDir), "utf8");
  assert.doesNotMatch(originalBackup, /CodexBridge managed config|openai_base_url/);
  assert.match(originalBackup, /^model\s*=\s*"gpt-5\.5"$/m);
  assert.match(originalBackup, /^sandbox_mode\s*=\s*"workspace-write"$/m);
  assert.match(originalBackup, /\[plugins\."keep@openai-curated"\]/);

  const forensicBackups = fs.readdirSync(path.dirname(target))
    .filter((name) => /^config\.toml\.managed-invalid\..+\.bak$/.test(name));
  assert.equal(forensicBackups.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(target), forensicBackups[0])), malformed);

  const stopped = await settings.removeManagedCodexConfigTransaction({
    homeDir: workspace.homeDir,
    coordinator,
  });
  assert.equal(stopped.reason, "router_original_restored");
  assert.equal(fs.readFileSync(target, "utf8"), originalBackup);
  assert.doesNotMatch(fs.readFileSync(target, "utf8"), /CodexBridge managed config/);
  assert.match(fs.readFileSync(target, "utf8"), /^model\s*=\s*"gpt-5\.5"$/m);
});

test("post-commit IPC metadata is frozen into the transaction result", async () => {
  const workspace = makeWorkspace("postcommit-metadata");
  const coordinator = coordinatorFor(workspace);
  const saved = await settings.applyConfigMutationTransaction({
    ...workspace,
    coordinator,
    operation: "providers:save",
    payload: {
      provider: {
        id: "deepseek",
        name: "DeepSeek Frozen Name",
        baseUrl: "https://api.deepseek.com/v1",
        api: "chat_completions",
        keyEnv: "DEEPSEEK_API_KEY",
      },
    },
  });
  assert.equal(saved.result.saved.name, "DeepSeek Frozen Name");

  const secretCommit = await settings.applyConfigMutationTransaction({
    ...workspace,
    coordinator,
    operation: "secrets:save",
    payload: { secrets: { DEEPSEEK_API_KEY: SECRET_VALUE } },
  });
  assert.equal(secretCommit.result.secretStatus.DEEPSEEK_API_KEY, true);
  assert.equal(JSON.stringify(secretCommit.result).includes(SECRET_VALUE), false);

  const reset = await settings.applyConfigMutationTransaction({
    ...workspace,
    coordinator,
    operation: "providers:reset",
    payload: { providerId: "deepseek" },
  });
  assert.equal(reset.result.providerName, "DeepSeek Frozen Name");
});

test("provider mutations reject embedded credentials and never persist them outside the secret source", async () => {
  const workspace = makeWorkspace("embedded-provider-credentials");
  const coordinator = coordinatorFor(workspace);
  const before = snapshotTargets(workspace);
  const cases = [
    {
      operation: "imageProviders:save",
      marker: "embedded-image-secret",
      payload: { provider: {
        id: "unsafe-image",
        name: "Unsafe Image",
        adapter: "generic_template",
        baseUrl: "https://images.example/v1",
        endpoint: "/generate",
        model: "unsafe-image-v1",
        apiKeyEnv: "UNSAFE_IMAGE_API_KEY",
        headers: { "x-auth-token": "embedded-image-secret" },
      } },
    },
    {
      operation: "capabilityProviders:save",
      marker: "embedded-capability-secret",
      payload: { provider: {
        id: "unsafe-ocr",
        name: "Unsafe OCR",
        capability: "ocr",
        adapter: "generic_http",
        baseUrl: "https://ocr.example/v1",
        apiKeyEnv: "UNSAFE_OCR_API_KEY",
        defaults: { databasePassword: "embedded-capability-secret" },
      } },
    },
    {
      operation: "models:saveImageGeneration",
      marker: "embedded-model-secret",
      payload: {
        presetId: API_MODEL_ID,
        imageGeneration: {
          mode: "custom",
          baseUrl: "https://images.example/v1",
          model: "unsafe-model-image-v1",
          apiKeyEnv: "UNSAFE_MODEL_IMAGE_API_KEY",
          headers: { serviceCredential: "embedded-model-secret" },
        },
      },
    },
  ];

  for (const item of cases) {
    await assert.rejects(
      settings.applyConfigMutationTransaction({
        ...workspace,
        coordinator,
        operation: item.operation,
        payload: item.payload,
      }),
      (error) => {
        assert.equal(error.code, "config_transaction_failed");
        assert.doesNotMatch(JSON.stringify(error), new RegExp(item.marker));
        return true;
      },
    );
    assertTargetsEqual(before);
  }
});

test("late derived-catalog commit failure restores provider, key, selection, Router, and both catalogs without leaking the key", async () => {
  const workspace = makeWorkspace("provider-key-rollback");
  const before = snapshotTargets(workspace);
  let injected = false;
  const coordinator = coordinatorFor({
    ...workspace,
    fileOps: {
      async rename(source, target) {
        if (
          !injected &&
          path.resolve(target) === path.resolve(settings.codexCatalogPath(workspace.homeDir)) &&
          path.basename(source).includes(".candidate.")
        ) {
          injected = true;
          const error = new Error("injected late derived-catalog failure");
          error.code = "EACCES";
          throw error;
        }
        return fs.promises.rename(source, target);
      },
    },
  });

  let caught;
  try {
    await settings.applyConfigMutationTransaction({
      ...workspace,
      coordinator,
      operation: "providers:save",
      payload: {
        provider: {
          id: "deepseek",
          name: "DeepSeek Rollback",
          baseUrl: "https://rollback.example/v1",
          keyEnv: "DEEPSEEK_API_KEY",
          apiKey: SECRET_VALUE,
        },
      },
    });
  } catch (error) {
    caught = error;
  }

  assert.equal(injected, true);
  assert.equal(caught?.code, "config_transaction_failed");
  assert.doesNotMatch(
    JSON.stringify(Object.fromEntries(Object.getOwnPropertyNames(caught).map((key) => [key, caught[key]]))),
    new RegExp(SECRET_VALUE),
  );
  assertTargetsEqual(before);
});

test("provider plus key rollback is whole at the secret source and final TOML commit points", async () => {
  const failureTargets = [
    { label: "secret-source", resolve: (workspace) => settings.secretsPath(workspace.rootDir) },
    { label: "final-toml", resolve: (workspace) => settings.codexConfigPath(workspace.homeDir) },
  ];

  for (const failureTarget of failureTargets) {
    const workspace = makeWorkspace(`provider-key-rollback-${failureTarget.label}`);
    if (failureTarget.label === "final-toml") {
      const tomlTarget = settings.codexConfigPath(workspace.homeDir);
      fs.writeFileSync(
        tomlTarget,
        fs.readFileSync(tomlTarget, "utf8").replace(
          `model = "${API_ROUTE_ID}"`,
          'model = "cb-missing-model"',
        ),
        "utf8",
      );
    }
    const before = snapshotTargets(workspace);
    const target = path.resolve(failureTarget.resolve(workspace));
    let injected = false;
    const coordinator = coordinatorFor({
      ...workspace,
      fileOps: {
        async rename(source, destination) {
          if (
            !injected &&
            path.resolve(destination) === target &&
            path.basename(source).includes(".candidate.")
          ) {
            injected = true;
            const error = new Error("injected provider transaction commit failure");
            error.code = "EACCES";
            throw error;
          }
          return fs.promises.rename(source, destination);
        },
      },
    });

    let caught;
    try {
      await settings.applyConfigMutationTransaction({
        ...workspace,
        coordinator,
        operation: "providers:save",
        payload: { provider: {
          id: "deepseek",
          name: "DeepSeek Rollback Coverage",
          baseUrl: "https://rollback-coverage.example/v1",
          keyEnv: "DEEPSEEK_API_KEY",
          apiKey: SECRET_VALUE,
        } },
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, failureTarget.label);
    assert.equal(caught.code, "config_transaction_failed");
    assert.doesNotMatch(JSON.stringify(caught), new RegExp(SECRET_VALUE));
    assert.equal(injected, true);
    assertTargetsEqual(before);
  }
});

test("heterogeneous selection and options saves use the same queue and publish only whole generations", async () => {
  const workspace = makeWorkspace("heterogeneous-queue");
  const coordinator = coordinatorFor(workspace);
  let releaseFirst;
  const holdFirst = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let firstEntered;
  const entered = new Promise((resolve) => {
    firstEntered = resolve;
  });
  let secondVerified = false;

  const first = settings.applyConfigMutationTransaction({
    ...workspace,
    coordinator,
    operation: "options:save",
    payload: { options: { routerPort: 17777 } },
    verifyCommitted: async ({ value }) => {
      assert.equal(value.routerConfig.port, 17777);
      firstEntered();
      await holdFirst;
      assert.equal(settings.readRouterConfig(workspace.rootDir).port, 17777);
    },
  });
  await entered;

  const second = settings.applyConfigMutationTransaction({
    ...workspace,
    coordinator,
    operation: "models:saveSelection",
    payload: { selectedModelIds: [API_MODEL_ID] },
    verifyCommitted: async ({ value }) => {
      secondVerified = true;
      assert.deepEqual(value.selectedModelIds, [API_MODEL_ID]);
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(secondVerified, false);
  releaseFirst();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.notEqual(firstResult.revision, secondResult.revision);
  const router = settings.readRouterConfig(workspace.rootDir);
  assert.equal(router.configRevision, secondResult.revision);
  assert.equal(router.port, 17777);
  assert.deepEqual(router.models.map((model) => model.sourcePresetId), [API_MODEL_ID]);
});

test("a queued selection save cannot replay a stale caller mode over a committed mode switch", async () => {
  const workspace = makeWorkspace("selection-stale-mode");
  const coordinator = coordinatorFor(workspace);
  let releaseModeSwitch;
  const holdModeSwitch = new Promise((resolve) => {
    releaseModeSwitch = resolve;
  });
  let modeSwitchCommitted;
  const enteredVerification = new Promise((resolve) => {
    modeSwitchCommitted = resolve;
  });

  const modeSwitch = settings.applyModeSwitchTransaction({
    ...workspace,
    coordinator,
    mode: settings.MODE_HYBRID,
    selectedModelIds: [API_MODEL_ID],
    verifyCommitted: async () => {
      modeSwitchCommitted();
      await holdModeSwitch;
    },
  });
  await enteredVerification;

  const selectionSave = settings.applyConfigMutationTransaction({
    ...workspace,
    coordinator,
    operation: "models:saveSelection",
    payload: {
      selectedModelIds: [API_MODEL_ID],
      mode: settings.MODE_ALL_API,
    },
  });
  releaseModeSwitch();

  await Promise.all([modeSwitch, selectionSave]);
  const persistedSelection = JSON.parse(
    fs.readFileSync(settings.selectionPath(workspace.rootDir), "utf8"),
  );
  assert.equal(persistedSelection.mode, settings.MODE_HYBRID);
  assert.equal(settings.readRouterConfig(workspace.rootDir).mode, settings.MODE_HYBRID);
});

test("a queued profile save fills omitted fields from its in-lease configuration snapshot", async () => {
  const workspace = makeWorkspace("profile-snapshot");
  const coordinator = coordinatorFor(workspace);
  let releaseOptions;
  const holdOptions = new Promise((resolve) => {
    releaseOptions = resolve;
  });
  let optionsCommitted;
  const enteredVerification = new Promise((resolve) => {
    optionsCommitted = resolve;
  });

  const optionsSave = settings.applyConfigMutationTransaction({
    ...workspace,
    coordinator,
    operation: "options:save",
    payload: { options: { routerPort: 18888 } },
    verifyCommitted: async () => {
      optionsCommitted();
      await holdOptions;
    },
  });
  await enteredVerification;

  const profileSave = settings.applyConfigMutationTransaction({
    ...workspace,
    coordinator,
    operation: "profiles:save",
    payload: { profile: { id: "snapshot-profile", name: "Snapshot Profile" } },
  });
  releaseOptions();

  const [, saved] = await Promise.all([optionsSave, profileSave]);
  assert.equal(saved.result.saved.mode, settings.MODE_ALL_API);
  assert.deepEqual(saved.result.saved.selectedModelIds, [API_MODEL_ID]);
  assert.equal(saved.result.saved.desktopOptions.routerPort, 18888);
});

test("invalid config-package input creates no backup, candidate artifact, or target change", async () => {
  const workspace = makeWorkspace("invalid-import");
  const before = snapshotTargets(workspace);
  const invalidPackage = {
    schema: "codexbridge.config-package",
    version: 1,
    includesSecrets: false,
    mode: settings.MODE_ALL_API,
    selection: { mode: settings.MODE_ALL_API, selectedModelIds: [API_MODEL_ID] },
    customModels: [{
      presetId: "custom-invalid",
      providerId: "custom-invalid",
      providerName: "Invalid",
      displayName: "Invalid",
      model: "invalid",
      baseUrl: "https://example.com/v1",
      keyEnv: "INVALID_API_KEY",
      apiKey: "must-not-appear-anywhere",
    }],
  };

  await assert.rejects(
    settings.applyConfigMutationTransaction({
      ...workspace,
      coordinator: coordinatorFor(workspace),
      operation: "configPackage:import",
      payload: { input: invalidPackage },
    }),
    (error) => {
      assert.equal(error.code, "config_transaction_failed");
      assert.doesNotMatch(JSON.stringify(error), /must-not-appear-anywhere/);
      return true;
    },
  );

  assertTargetsEqual(before);
  assert.equal(fs.existsSync(settings.configPackageImportBackupDir(workspace.rootDir)), false);
  for (const directory of [
    path.join(workspace.rootDir, "config"),
    path.join(workspace.homeDir, ".codex"),
  ]) {
    assert.deepEqual(
      fs.readdirSync(directory).filter((name) => /\.(?:candidate|rollback|restore|hold)\./.test(name)),
      [],
    );
  }
});

test("strict imports reject prospective model, provider, and route references before backup", async () => {
  const basePackage = {
    schema: "codexbridge.config-package",
    version: 1,
    includesSecrets: false,
  };
  const cases = [
    {
      ...basePackage,
      mode: settings.MODE_ALL_API,
      selection: {
        mode: settings.MODE_ALL_API,
        selectedModelIds: ["missing-imported-model"],
      },
    },
    {
      ...basePackage,
      desktopOptions: {
        smartRouting: {
          autoSelectRules: {
            code: { mode: "route", routeId: "cb-missing-imported-route" },
          },
        },
      },
    },
    {
      ...basePackage,
      modelCapabilities: {
        imageInput: { "missing-imported-model": true },
        overrides: {},
      },
    },
    {
      ...basePackage,
      modelImageGeneration: {
        [API_MODEL_ID]: {
          enabled: true,
          mode: "provider",
          providerId: "missing-image-provider",
        },
      },
    },
    {
      ...basePackage,
      profiles: [{
        id: "invalid-reference-profile",
        name: "Invalid Reference Profile",
        mode: settings.MODE_ALL_API,
        selectedModelIds: ["missing-imported-model"],
        desktopOptions: { routerPort: 15722 },
      }],
    },
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const workspace = makeWorkspace(`invalid-import-reference-${index}`);
    const before = snapshotTargets(workspace);
    await assert.rejects(
      settings.applyConfigMutationTransaction({
        ...workspace,
        coordinator: coordinatorFor(workspace),
        operation: "configPackage:import",
        payload: { input: cases[index] },
      }),
      (error) => error?.code === "config_transaction_failed",
    );
    assertTargetsEqual(before);
    assert.equal(fs.existsSync(settings.configPackageImportBackupDir(workspace.rootDir)), false);
  }
});

test("a validated config package commits every section, derived output, and secret-free backup together", async () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-config-import-source-"));
  settings.saveSelection(sourceRoot, [API_MODEL_ID], settings.MODE_ALL_API);
  settings.saveProviderOverride(sourceRoot, "deepseek", {
    name: "Imported Atomic Provider",
    baseUrl: "https://imported.example/v1",
  });
  settings.saveDesktopOptions(sourceRoot, { routerPort: 18888 });
  settings.writeRouterConfigFromSelection(sourceRoot, settings.MODE_ALL_API);
  const pkg = settings.exportConfigPackage(sourceRoot, { includeCodexResources: false });
  const candidate = settings.parseConfigPackageImportCandidate(pkg);

  const workspace = makeWorkspace("valid-import");
  settings.saveSecrets(workspace.rootDir, { DEEPSEEK_API_KEY: SECRET_VALUE });
  const committed = await settings.applyConfigMutationTransaction({
    ...workspace,
    coordinator: coordinatorFor(workspace),
    operation: "configPackage:import",
    payload: { candidate },
  });

  assert.equal(committed.mode, settings.MODE_ALL_API);
  assert.deepEqual(committed.selectedModelIds, [API_MODEL_ID]);
  assert.equal(settings.readProviderOverrides(workspace.rootDir).deepseek.name, "Imported Atomic Provider");
  assert.equal(settings.readRouterConfig(workspace.rootDir).port, 18888);
  assert.equal(settings.loadSecrets(workspace.rootDir).DEEPSEEK_API_KEY, SECRET_VALUE);
  assert.equal(fs.existsSync(committed.result.backupPath), true);
  const backup = JSON.parse(fs.readFileSync(committed.result.backupPath, "utf8"));
  assert.equal(backup.includesSecrets, false);
  assert.doesNotMatch(JSON.stringify(backup), new RegExp(SECRET_VALUE));
  assert.equal(backup.backupReason, "before_config_package_import");
  assert.equal(
    JSON.parse(fs.readFileSync(settings.catalogPath(workspace.rootDir), "utf8")).models[0].slug,
    API_ROUTE_ID,
  );
});

test("a partial config package without mode or selection preserves the current mode", async () => {
  const workspace = makeWorkspace("partial-import-mode");
  const result = await settings.applyConfigMutationTransaction({
    ...workspace,
    coordinator: coordinatorFor(workspace),
    operation: "configPackage:import",
    payload: { input: {
      schema: "codexbridge.config-package",
      version: 1,
      includesSecrets: false,
      desktopOptions: { routerPort: 19191 },
    } },
  });

  assert.equal(result.mode, settings.MODE_ALL_API);
  assert.equal(settings.readRouterConfig(workspace.rootDir).mode, settings.MODE_ALL_API);
  assert.equal(settings.loadDesktopOptions(workspace.rootDir).routerPort, 19191);
});

test("automatic Router stop removes only the managed block and preserves user TOML bytes", async () => {
  const workspace = makeWorkspace("router-stop-managed-only");
  const target = settings.codexConfigPath(workspace.homeDir);
  const before = fs.readFileSync(target);
  const markerStart = before.indexOf(Buffer.from("# >>> CodexBridge managed config", "utf8"));
  const markerEndText = Buffer.from("# <<< CodexBridge managed config", "utf8");
  const markerEnd = before.indexOf(markerEndText) + markerEndText.length;
  const expected = Buffer.concat([before.subarray(0, markerStart), before.subarray(markerEnd)]);
  const coordinator = coordinatorFor(workspace);

  const result = await settings.removeManagedCodexConfigTransaction({
    homeDir: workspace.homeDir,
    coordinator,
  });

  assert.equal(result.removed, true);
  assert.deepEqual(fs.readFileSync(target), expected);
  assert.match(fs.readFileSync(target, "utf8"), /用户自己的注释/);
  assert.doesNotMatch(fs.readFileSync(target, "utf8"), /CodexBridge managed config/);
});

test("Router start safely takes over a normal unmanaged Codex config and stop restores exact bytes", async () => {
  const workspace = makeWorkspace("router-start-normal-unmanaged");
  const target = settings.codexConfigPath(workspace.homeDir);
  const original = Buffer.from([
    'sandbox_mode = "workspace-write"',
    'model = "gpt-5.5"',
    'model_reasoning_effort = "high"',
    'approval_policy = "on-request"',
    '',
    '[plugins."keep@openai-curated"]',
    'enabled = true',
    '',
  ].join("\r\n"), "utf8");
  fs.writeFileSync(target, original);
  const coordinator = coordinatorFor(workspace);

  await settings.applyConfigMutationTransaction({
    ...workspace,
    coordinator,
    operation: "router:start",
  });

  const running = fs.readFileSync(target, "utf8");
  assert.match(running, /# >>> CodexBridge managed config/);
  assert.match(running, /\[plugins\."keep@openai-curated"\]/);
  assert.equal((running.match(/^model\s*=/gm) || []).length, 1);
  assert.equal((running.match(/^sandbox_mode\s*=/gm) || []).length, 1);
  assert.deepEqual(fs.readFileSync(settings.codexRouterOriginalPath(workspace.homeDir)), original);

  const stopped = await settings.removeManagedCodexConfigTransaction({
    homeDir: workspace.homeDir,
    coordinator,
  });

  assert.equal(stopped.removed, true);
  assert.equal(stopped.reason, "router_original_restored");
  assert.deepEqual(fs.readFileSync(target), original);
});

test("Router stop restores the original config and preserves changes appended while Router was running", async () => {
  const workspace = makeWorkspace("router-stop-concurrent-append");
  const target = settings.codexConfigPath(workspace.homeDir);
  const original = Buffer.from([
    'sandbox_mode = "workspace-write"',
    'model = "gpt-5.5"',
    'approval_policy = "on-request"',
    '',
    '[plugins."keep@openai-curated"]',
    'enabled = true',
    '',
  ].join("\r\n"), "utf8");
  fs.writeFileSync(target, original);
  const coordinator = coordinatorFor(workspace);

  await settings.applyConfigMutationTransaction({
    ...workspace,
    coordinator,
    operation: "router:start",
  });
  fs.appendFileSync(
    target,
    '\r\n[plugins."added-while-running@openai-curated"]\r\nenabled = true\r\n',
    "utf8",
  );

  const stopped = await settings.removeManagedCodexConfigTransaction({
    homeDir: workspace.homeDir,
    coordinator,
  });
  const restored = fs.readFileSync(target, "utf8");

  assert.equal(stopped.removed, true);
  assert.equal(stopped.reason, "router_original_restored_with_concurrent_changes");
  assert.match(restored, /model = "gpt-5\.5"/);
  assert.match(restored, /added-while-running@openai-curated/);
  assert.doesNotMatch(restored, /CodexBridge managed config/);
});

test("resource toggle and mode switch share one FIFO and both survive in final TOML", async () => {
  const workspace = makeWorkspace("resource-mode-fifo");
  const target = settings.codexConfigPath(workspace.homeDir);
  fs.appendFileSync(
    target,
    '\r\n[plugins."github@openai-curated-remote"]\r\nenabled = true\r\n',
    "utf8",
  );
  const coordinator = coordinatorFor(workspace);
  let releaseMode;
  const holdMode = new Promise((resolve) => {
    releaseMode = resolve;
  });
  let modeEntered;
  const modeVerifying = new Promise((resolve) => {
    modeEntered = resolve;
  });
  let resourceFinished = false;

  const modeSwitch = settings.applyModeSwitchTransaction({
    ...workspace,
    coordinator,
    mode: settings.MODE_HYBRID,
    selectedModelIds: [API_MODEL_ID],
    verifyCommitted: async () => {
      modeEntered();
      await holdMode;
    },
  });
  await modeVerifying;
  const resourceToggle = settings.setCodexResourceEnabledTransaction({
    homeDir: workspace.homeDir,
    coordinator,
    kind: "plugin",
    id: "github@openai-curated-remote",
    enabled: false,
  }).then((result) => {
    resourceFinished = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(resourceFinished, false);
  releaseMode();

  await Promise.all([modeSwitch, resourceToggle]);
  const toml = fs.readFileSync(target, "utf8");
  assert.match(toml, /# >>> CodexBridge managed config/);
  assert.match(toml, /model_provider = "openai"/);
  assert.match(toml, /openai_base_url = "http:\/\/127\.0\.0\.1:15722\/v1"/);
  assert.match(toml, /\[plugins\."github@openai-curated-remote"\]\r\nenabled = false/);
});

test("resource toggles replace only the target boolean and preserve BOM, CRLF, Unicode, and tail bytes", async () => {
  const workspace = makeWorkspace("resource-byte-preservation");
  const target = settings.codexConfigPath(workspace.homeDir);
  const original = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(
      '# 用户注释\r\n[plugins."github@openai-curated-remote"]\r\n  enabled = true # 保留尾注\r\n\r\n  ',
      "utf8",
    ),
  ]);
  fs.writeFileSync(target, original);

  await settings.setCodexResourceEnabledTransaction({
    homeDir: workspace.homeDir,
    coordinator: coordinatorFor(workspace),
    kind: "plugin",
    id: "github@openai-curated-remote",
    enabled: false,
  });

  const expected = Buffer.from(original.toString("utf8").replace(
    "  enabled = true # 保留尾注",
    "  enabled = false # 保留尾注",
  ));
  assert.deepEqual(fs.readFileSync(target), expected);
});

test("a stale remote model refresh cannot resurrect an edited provider", async () => {
  const workspace = makeWorkspace("stale-provider-refresh");
  const coordinator = coordinatorFor(workspace);
  await settings.applyConfigMutationTransaction({
    ...workspace,
    coordinator,
    operation: "providers:save",
    payload: {
      provider: {
        id: "deepseek",
        baseUrl: "https://before-refresh.example/v1",
        keyEnv: "DEEPSEEK_API_KEY",
        apiKey: SECRET_VALUE,
      },
    },
  });
  const staleRefresh = await settings.fetchProviderModelDirectoryCandidate(
    workspace.rootDir,
    "deepseek",
    {
      fetchImpl: async () => new Response(JSON.stringify({
        data: [{ id: "deepseek-stale-model" }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      now: () => "2026-07-11T00:00:00.000Z",
    },
  );
  assert.equal(staleRefresh.ok, true);

  await settings.applyConfigMutationTransaction({
    ...workspace,
    coordinator,
    operation: "providers:save",
    payload: {
      provider: {
        id: "deepseek",
        baseUrl: "https://edited-after-refresh.example/v1",
        keyEnv: "DEEPSEEK_API_KEY",
      },
    },
  });
  await assert.rejects(
    settings.applyConfigMutationTransaction({
      ...workspace,
      coordinator,
      operation: "providers:refreshModels",
      payload: { refreshResult: staleRefresh },
    }),
    (error) => error?.code === "config_transaction_failed",
  );

  assert.equal(
    settings.readProviderOverrides(workspace.rootDir).deepseek.baseUrl,
    "https://edited-after-refresh.example/v1",
  );
  assert.equal(
    settings.readModelDirectory(workspace.rootDir).providers.deepseek,
    undefined,
  );
});

test("a current remote model refresh commits through the shared config transaction", async () => {
  const workspace = makeWorkspace("current-provider-refresh");
  const coordinator = coordinatorFor(workspace);
  await settings.applyConfigMutationTransaction({
    ...workspace,
    coordinator,
    operation: "providers:save",
    payload: {
      provider: {
        id: "deepseek",
        baseUrl: "https://current-refresh.example/v1",
        keyEnv: "DEEPSEEK_API_KEY",
        apiKey: SECRET_VALUE,
      },
    },
  });
  const refresh = await settings.fetchProviderModelDirectoryCandidate(
    workspace.rootDir,
    "deepseek",
    {
      fetchImpl: async () => new Response(JSON.stringify({
        data: [{ id: "deepseek-current-model" }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      now: () => "2026-07-11T00:00:00.000Z",
    },
  );
  assert.equal(refresh.ok, true);

  const committed = await settings.applyConfigMutationTransaction({
    ...workspace,
    coordinator,
    operation: "providers:refreshModels",
    payload: { refreshResult: refresh },
  });

  assert.equal(committed.result.refresh.ok, true);
  assert.equal(committed.result.refresh.count, 1);
  assert.equal(
    settings.readModelDirectory(workspace.rootDir).providers.deepseek.models[0].id,
    "deepseek-current-model",
  );
});

async function addPortableRemoteModel(workspace, modelId = "deepseek-portable-fixture-model") {
  settings.saveSecrets(workspace.rootDir, { DEEPSEEK_API_KEY: SECRET_VALUE });
  const refresh = await settings.fetchProviderModelDirectoryCandidate(workspace.rootDir, "deepseek", {
    fetchImpl: async () => new Response(JSON.stringify({ data: [
      { id: modelId, display_name: "Portable fixture model", context_window: 131072 },
      { id: "deepseek-unselected-fixture-model" },
    ] }), { status: 200, headers: { "content-type": "application/json" } }),
    now: () => "2026-09-23T00:00:00.000Z",
  });
  await settings.applyConfigMutationTransaction({
    ...workspace, coordinator: coordinatorFor(workspace), operation: "providers:refreshModels",
    payload: { refreshResult: refresh },
  });
  const model = settings.modelCatalog(workspace.rootDir).find(item => item.model === modelId);
  assert.ok(model?.presetId.startsWith("remote-deepseek-"));
  await settings.applyConfigMutationTransaction({
    ...workspace, coordinator: coordinatorFor(workspace), operation: "models:saveSelection",
    payload: { selectedModelIds: [model.presetId], expectedMode: settings.MODE_ALL_API, exactSelection: true },
  });
  return model;
}

for (const preRefreshTarget of [false, true]) {
  test(`exported remote directory model imports on a ${preRefreshTarget ? "pre-refreshed" : "clean"} target without substitution`, async () => {
    const source = makeWorkspace(`portable-remote-source-${preRefreshTarget}`);
    const sourceModel = await addPortableRemoteModel(source);
    const pkg = settings.exportConfigPackage(source.rootDir, { includeCodexResources: false });
    assert.deepEqual(pkg.selection.selectedModelIds, [sourceModel.presetId]);
    assert.equal(pkg.customModels.some(model => model.model === "deepseek-portable-fixture-model" && model.portableRemote === true), true);
    assert.equal(pkg.customModels.some(model => model.model === "deepseek-unselected-fixture-model"), false);
    assert.doesNotMatch(JSON.stringify(pkg), new RegExp(SECRET_VALUE));
    assert.doesNotThrow(() => settings.parseConfigPackageImportCandidate(pkg));

    const target = makeWorkspace(`portable-remote-target-${preRefreshTarget}`);
    settings.saveSecrets(target.rootDir, { DEEPSEEK_API_KEY: SECRET_VALUE });
    if (preRefreshTarget) await addPortableRemoteModel(target);
    const committed = await settings.applyConfigMutationTransaction({
      ...target, coordinator: coordinatorFor(target), operation: "configPackage:import",
      payload: { candidate: settings.parseConfigPackageImportCandidate(pkg) },
    });
    assert.deepEqual(committed.selectedModelIds, [sourceModel.presetId]);
    const routes = settings.readRouterConfig(target.rootDir).models;
    assert.equal(routes.length, 1);
    assert.equal(routes[0].model, "deepseek-portable-fixture-model");
    assert.equal(routes[0].api, sourceModel.api);
    assert.equal(routes[0].contextWindow, sourceModel.contextWindow);
    assert.equal(routes[0].apiKeyEnv, "DEEPSEEK_API_KEY");
    assert.equal(settings.modelCatalog(target.rootDir).filter(model => model.presetId === sourceModel.presetId).length, 1);
    const savedPortable = settings.readCustomModels(target.rootDir).find(model => model.presetId === sourceModel.presetId);
    assert.equal(savedPortable?.portableRemote, true);
    const reexported = settings.exportConfigPackage(target.rootDir, { includeCodexResources: false });
    assert.equal(reexported.customModels.filter(model => model.presetId === sourceModel.presetId).length, 1);
    assert.equal(reexported.customModels.find(model => model.presetId === sourceModel.presetId)?.portableRemote, true);
    assert.doesNotMatch(JSON.stringify(reexported), new RegExp(SECRET_VALUE));
  });
}

test("a selected remote model from a custom intermediary provider imports on a clean target", async () => {
  const source = makeWorkspace("portable-custom-provider-source");
  settings.saveCustomModel(source.rootDir, {
    providerId: "custom-portable-relay", providerName: "Portable Relay",
    displayName: "Relay Seed", model: "relay-seed", baseUrl: "https://relay.example.invalid/v1",
    api: "responses", keyEnv: "CUSTOM_PORTABLE_RELAY_KEY",
  });
  settings.saveSecrets(source.rootDir, { CUSTOM_PORTABLE_RELAY_KEY: SECRET_VALUE });
  const refresh = await settings.fetchProviderModelDirectoryCandidate(source.rootDir, "custom-portable-relay", {
    fetchImpl: async () => new Response(JSON.stringify({ data: [
      { id: "relay-seed" }, { id: "relay-portable-remote" },
    ] }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  await settings.applyConfigMutationTransaction({
    ...source, coordinator: coordinatorFor(source), operation: "providers:refreshModels",
    payload: { refreshResult: refresh },
  });
  const remote = settings.modelCatalog(source.rootDir).find(model => model.model === "relay-portable-remote");
  await settings.applyConfigMutationTransaction({
    ...source, coordinator: coordinatorFor(source), operation: "models:saveSelection",
    payload: { selectedModelIds: [remote.presetId], expectedMode: settings.MODE_ALL_API, exactSelection: true },
  });
  const pkg = settings.exportConfigPackage(source.rootDir, { includeCodexResources: false });
  assert.equal(pkg.customModels.some(model => model.model === "relay-portable-remote" && model.portableRemote === true), true);
  assert.doesNotMatch(JSON.stringify(pkg), new RegExp(SECRET_VALUE));

  const target = makeWorkspace("portable-custom-provider-target");
  settings.saveSecrets(target.rootDir, { CUSTOM_PORTABLE_RELAY_KEY: SECRET_VALUE });
  const committed = await settings.applyConfigMutationTransaction({
    ...target, coordinator: coordinatorFor(target), operation: "configPackage:import",
    payload: { candidate: settings.parseConfigPackageImportCandidate(pkg) },
  });
  assert.deepEqual(committed.selectedModelIds, [remote.presetId]);
  const [route] = settings.readRouterConfig(target.rootDir).models;
  assert.equal(route.model, "relay-portable-remote");
  assert.equal(route.baseUrl, "https://relay.example.invalid/v1");
  assert.equal(route.apiKeyEnv, "CUSTOM_PORTABLE_RELAY_KEY");
});

test("a current custom intermediary model refresh commits through the shared config transaction", async () => {
  const workspace = makeWorkspace("current-custom-provider-refresh");
  const coordinator = coordinatorFor(workspace);
  await settings.applyConfigMutationTransaction({
    ...workspace,
    coordinator,
    operation: "customModel:save",
    payload: {
      model: {
        providerId: "custom-refresh-relay",
        providerName: "Custom Refresh Relay",
        displayName: "Relay Seed",
        model: "relay-seed",
        baseUrl: "https://relay-refresh.example/v1",
        api: "responses",
        keyEnv: "CUSTOM_REFRESH_RELAY_KEY",
        apiKey: SECRET_VALUE,
      },
    },
  });
  const refresh = await settings.fetchProviderModelDirectoryCandidate(
    workspace.rootDir,
    "custom-refresh-relay",
    {
      fetchImpl: async () => new Response(JSON.stringify({
        data: [
          { id: "relay-current-model-a" },
          { id: "relay-current-model-b" },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      now: () => "2026-07-11T00:00:00.000Z",
    },
  );
  assert.equal(refresh.ok, true);

  const committed = await settings.applyConfigMutationTransaction({
    ...workspace,
    coordinator,
    operation: "providers:refreshModels",
    payload: { refreshResult: refresh },
  });

  assert.equal(committed.result.refresh.ok, true);
  assert.equal(committed.result.refresh.count, 2);
  assert.deepEqual(
    settings.readModelDirectory(workspace.rootDir)
      .providers["custom-refresh-relay"]
      .models
      .map((model) => model.id),
    ["relay-current-model-a", "relay-current-model-b"],
  );
});

test("image, capability, custom-model, profile, capability override, and logo mutations use the same transaction API", async () => {
  const workspace = makeWorkspace("remaining-mutation-surfaces");
  const coordinator = coordinatorFor(workspace);
  const mutate = async (options) => {
    try {
      return await settings.applyConfigMutationTransaction(options);
    } catch (error) {
      error.message = `${options.operation}: ${error.message}`;
      throw error;
    }
  };

  await mutate({
    ...workspace,
    coordinator,
    operation: "imageProviders:save",
    payload: { provider: {
      id: "atomic-image",
      name: "Atomic Image",
      adapter: "generic_template",
      baseUrl: "https://image.example/v1",
      endpoint: "/images/generations",
      model: "image-v1",
      apiKeyEnv: "ATOMIC_IMAGE_KEY",
      apiKey: "test-only-image-key",
      headers: { Authorization: "Bearer {{apiKey}}" },
      makeDefault: true,
    } },
  });
  await mutate({
    ...workspace,
    coordinator,
    operation: "capabilityProviders:save",
    payload: { provider: {
      id: "atomic-ocr",
      name: "Atomic OCR",
      capability: "ocr",
      adapter: "generic_http",
      baseUrl: "https://ocr.example/v1",
      endpoint: "/ocr",
      apiKeyEnv: "ATOMIC_OCR_KEY",
      apiKey: "test-only-ocr-key",
      makeDefault: true,
    } },
  });
  await mutate({
    ...workspace,
    coordinator,
    operation: "customModel:save",
    payload: { model: {
      providerId: "atomic-custom",
      providerName: "Atomic Custom",
      displayName: "Atomic Custom Model",
      model: "atomic-model-v1",
      baseUrl: "https://custom.example/v1",
      keyEnv: "ATOMIC_CUSTOM_KEY",
      apiKey: "test-only-custom-key",
    } },
  });
  await mutate({
    ...workspace,
    coordinator,
    operation: "models:saveCapabilities",
    payload: {
      presetId: API_MODEL_ID,
      capabilities: { inputModalities: ["text", "image"], supportsTools: true },
    },
  });
  const savedProfile = await mutate({
    ...workspace,
    coordinator,
    operation: "profiles:save",
    payload: { profile: {
      id: "atomic-profile",
      name: "Atomic Profile",
      mode: settings.MODE_ALL_API,
      selectedModelIds: [API_MODEL_ID],
      desktopOptions: { routerPort: 19999 },
    } },
    now: "2026-07-11T01:02:03.000Z",
  });
  await mutate({
    ...workspace,
    coordinator,
    operation: "profiles:apply",
    payload: { profileId: savedProfile.result.saved.id },
  });
  const logoSource = path.join(workspace.rootDir, "atomic-logo.png");
  fs.writeFileSync(logoSource, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const logo = settings.buildProviderLogoCandidate(workspace.rootDir, "deepseek", logoSource);
  await mutate({
    ...workspace,
    coordinator,
    operation: "logos:select",
    payload: {
      providerId: "deepseek",
      applyToProvider: true,
      logoTarget: logo.target,
      logoUrl: logo.logoUrl,
      logoBytes: logo.bytes,
    },
  });

  const secrets = settings.loadSecrets(workspace.rootDir);
  assert.equal(secrets.ATOMIC_IMAGE_KEY, "test-only-image-key");
  assert.equal(secrets.ATOMIC_OCR_KEY, "test-only-ocr-key");
  assert.equal(secrets.ATOMIC_CUSTOM_KEY, "test-only-custom-key");
  assert.equal(settings.readImageProviderConfig(workspace.rootDir).defaultProviderId, "atomic-image");
  assert.equal(settings.readCapabilityProviderConfig(workspace.rootDir).defaults.ocr, "atomic-ocr");
  assert.equal(settings.readCustomModels(workspace.rootDir)[0].model, "atomic-model-v1");
  assert.deepEqual(
    settings.readModelCapabilityOverrides(workspace.rootDir)[API_MODEL_ID].inputModalities,
    ["text", "image"],
  );
  assert.equal(settings.loadDesktopOptions(workspace.rootDir).routerPort, 19999);
  assert.equal(fs.existsSync(logo.target), true);
  assert.equal(settings.readProviderOverrides(workspace.rootDir).deepseek.logoUrl, logo.logoUrl);
  for (const secret of ["test-only-image-key", "test-only-ocr-key", "test-only-custom-key"]) {
    assertSecretAbsentFromNonSecretTargets(workspace, secret);
  }
});

test("selected Codex restore rolls back its explicit backup when the target commit fails", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-selected-restore-rollback-home-"));
  const codexDir = path.join(homeDir, ".codex");
  const target = settings.codexConfigPath(homeDir);
  const selectedBackup = `${target}.codexbridge.2026-07-11-010101000.bak`;
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(target, 'model = "current-before-failure"\n', "utf8");
  fs.writeFileSync(selectedBackup, 'model = "selected-backup"\n', "utf8");
  const beforeNames = new Set(fs.readdirSync(codexDir));
  let injected = false;
  const coordinator = codexRestoreCoordinatorFor(homeDir, {
    async rename(source, destination) {
      if (
        !injected &&
        path.resolve(destination) === path.resolve(target) &&
        path.basename(source).includes(".candidate.")
      ) {
        injected = true;
        const error = new Error("injected selected restore target failure");
        error.code = "EACCES";
        throw error;
      }
      return fs.promises.rename(source, destination);
    },
  });

  await assert.rejects(
    async () => settings.restoreCodexConfigFromBackup(selectedBackup, { homeDir, coordinator }),
    (error) => error?.code === "config_transaction_failed",
  );

  assert.equal(injected, true);
  assert.equal(fs.readFileSync(target, "utf8"), 'model = "current-before-failure"\n');
  assert.deepEqual(
    new Set(fs.readdirSync(codexDir).filter((name) => name !== ".restore-transactions")),
    beforeNames,
  );
  assert.deepEqual(fs.readdirSync(path.join(codexDir, ".restore-transactions")), []);
});

test("selected Codex restore CAS rejects a target changed after transaction preparation", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-selected-restore-cas-home-"));
  const codexDir = path.join(homeDir, ".codex");
  const target = settings.codexConfigPath(homeDir);
  const selectedBackup = `${target}.codexbridge.2026-07-11-020202000.bak`;
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(target, 'model = "snapshot-at-prepare"\n', "utf8");
  fs.writeFileSync(selectedBackup, 'model = "selected-backup"\n', "utf8");
  const actualCoordinator = codexRestoreCoordinatorFor(homeDir);
  const coordinator = {
    runTransaction(transaction) {
      return actualCoordinator.runTransaction({
        ...transaction,
        prepare: async (context) => {
          const prepared = await transaction.prepare(context);
          fs.writeFileSync(target, 'model = "external-editor-won"\n', "utf8");
          return prepared;
        },
      });
    },
  };

  await assert.rejects(
    async () => settings.restoreCodexConfigFromBackup(selectedBackup, { homeDir, coordinator }),
    (error) => error?.code === "config_transaction_failed",
  );

  assert.equal(fs.readFileSync(target, "utf8"), 'model = "external-editor-won"\n');
  assert.equal(
    fs.readdirSync(codexDir).some((name) => name.includes(".before-restore.")),
    false,
  );
});

test("Codex history recovery validates candidates and commits target plus backup as private files", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-history-transaction-root-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-history-transaction-home-"));
  const codexDir = path.join(homeDir, ".codex");
  const target = settings.codexConfigPath(homeDir);
  fs.mkdirSync(codexDir, { recursive: true });
  const original = `${settings.buildCodexToml({
    rootDir,
    homeDir,
    mode: settings.MODE_HYBRID,
  }).trimEnd()}\ndisable_response_storage = true\n`;
  fs.writeFileSync(target, original, "utf8");

  const result = await settings.recoverCodexHistoryAccess({
    homeDir,
    coordinator: codexRestoreCoordinatorFor(homeDir),
  });

  assert.equal(typeof result.configRevision, "string");
  assert.ok(result.configRevision.length > 0);
  assert.equal(fs.readFileSync(result.currentBackup, "utf8"), original);
  assert.doesNotMatch(fs.readFileSync(target, "utf8"), /disable_response_storage/);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(fs.statSync(result.currentBackup).mode & 0o777, 0o600);
  }
});

test("Codex restore candidate validation rejects content altered after preparation", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-restore-candidate-home-"));
  const codexDir = path.join(homeDir, ".codex");
  const target = settings.codexConfigPath(homeDir);
  const selectedBackup = `${target}.codexbridge.2026-07-11-030303000.bak`;
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(target, 'model = "current"\n', "utf8");
  fs.writeFileSync(selectedBackup, 'model = "validated-backup"\n', "utf8");
  const actualCoordinator = codexRestoreCoordinatorFor(homeDir);
  const coordinator = {
    runTransaction(transaction) {
      return actualCoordinator.runTransaction({
        ...transaction,
        prepare: async (context) => {
          const prepared = await transaction.prepare(context);
          const targetEntry = prepared.entries.find((entry) => entry.target === target);
          targetEntry.content = Buffer.from('model = "tampered-candidate"\n', "utf8");
          return prepared;
        },
      });
    },
  };

  await assert.rejects(
    async () => settings.restoreCodexConfigFromBackup(selectedBackup, { homeDir, coordinator }),
    (error) => error?.code === "config_transaction_failed",
  );
  assert.equal(fs.readFileSync(target, "utf8"), 'model = "current"\n');
});
