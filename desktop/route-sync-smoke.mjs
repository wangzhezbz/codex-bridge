import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MODE_HYBRID,
  buildCodexToml,
  importConfigPackage,
  loadConfigProfiles,
  loadDesktopOptions,
  modelDirectoryPath,
  readRouterConfig,
  readSelection,
  routerConfigPath,
  saveConfigProfile,
  saveDesktopOptions,
  saveProviderOverride,
  saveSelection,
  selectionPath,
  synchronizeRouteState,
} from "./settings.mjs";

export function runDesktopRouteSyncSmoke() {
  const cases = [
    runSmokeCase("provider-save-after-stale-selection", smokeProviderSaveAfterStaleSelection),
    runSmokeCase("auxiliary-task-model-deleted", smokeAuxiliaryTaskModelDeleted),
    runSmokeCase("config-package-import-with-old-model-id", smokeConfigPackageImportWithOldModelId),
    runSmokeCase("config-profile-save-with-old-model-id", smokeConfigProfileSaveWithOldModelId),
    runSmokeCase("codex-model-catalog-refresh-after-route-sync", smokeCodexModelCatalogRefreshAfterRouteSync),
  ];
  const passed = cases.filter((item) => item.ok).length;
  const failed = cases.length - passed;
  return {
    ok: failed === 0,
    summary: {
      total: cases.length,
      passed,
      failed,
    },
    cases,
  };
}

function smokeProviderSaveAfterStaleSelection() {
  const rootDir = makeTempProject("provider-save");
  seedSyncedKimiDirectory(rootDir);
  fs.writeFileSync(
    routerConfigPath(rootDir),
    JSON.stringify({ mode: MODE_HYBRID, models: [{ id: "cb-kimi-k2-7-code" }] }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    selectionPath(rootDir),
    JSON.stringify({ selectedModelIds: ["kimi-k2-7-code"] }, null, 2),
    "utf8",
  );

  saveProviderOverride(rootDir, "deepseek", {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    api: "chat_completions",
  });
  const sync = synchronizeRouteState(rootDir, {
    mode: MODE_HYBRID,
    refreshCodexCache: false,
  });

  return assertSmokeState(rootDir, sync, {
    selectedModelIds: ["remote-kimi-kimi-for-coding"],
    defaultModel: "cb-remote-kimi-kimi-for-coding",
  });
}

function smokeAuxiliaryTaskModelDeleted() {
  const rootDir = makeTempProject("auxiliary-deleted");
  saveSelection(rootDir, ["deepseek-v4-pro"], MODE_HYBRID);
  saveDesktopOptions(rootDir, {
    interceptCodexAuxiliaryTasks: false,
    codexAuxiliaryModelId: "cb-deleted-helper",
    smartRouting: {
      autoSelectRules: {
        code: { mode: "route", routeId: "cb-deleted-helper" },
      },
      failover: {
        mode: "ordered",
        routeIds: ["cb-deleted-helper"],
      },
    },
  });

  const sync = synchronizeRouteState(rootDir, {
    mode: MODE_HYBRID,
    refreshCodexCache: false,
  });

  return assertSmokeState(rootDir, sync, {
    selectedModelIds: ["deepseek-v4-pro"],
    defaultModel: "cb-deepseek-v4-pro",
    auxiliaryRouteId: "cb-deepseek-v4-pro",
  });
}

function smokeConfigPackageImportWithOldModelId() {
  const rootDir = makeTempProject("package-old-model");
  seedSyncedKimiDirectory(rootDir);
  const packageWithOldKimiId = {
    schema: "codexbridge.config-package",
    version: 1,
    includesSecrets: false,
    selection: {
      mode: MODE_HYBRID,
      selectedModelIds: ["kimi-k2-7-code"],
    },
    desktopOptions: {
      codexAuxiliaryModelId: "cb-kimi-k2-7-code",
      smartRouting: {
        autoSelectRules: {
          code: { mode: "route", routeId: "cb-kimi-k2-7-code" },
        },
        failover: {
          mode: "ordered",
          routeIds: ["cb-kimi-k2-7-code"],
        },
      },
    },
  };

  importConfigPackage(rootDir, packageWithOldKimiId);
  const sync = synchronizeRouteState(rootDir, {
    mode: MODE_HYBRID,
    refreshCodexCache: false,
  });

  return assertSmokeState(rootDir, sync, {
    selectedModelIds: ["remote-kimi-kimi-for-coding"],
    defaultModel: "cb-remote-kimi-kimi-for-coding",
    auxiliaryRouteId: "cb-remote-kimi-kimi-for-coding",
  });
}

function smokeConfigProfileSaveWithOldModelId() {
  const rootDir = makeTempProject("profile-old-model");
  seedSyncedKimiDirectory(rootDir);

  const saved = saveConfigProfile(rootDir, {
    id: "old-kimi-profile",
    name: "Old Kimi",
    mode: MODE_HYBRID,
    selectedModelIds: ["kimi-k2-7-code"],
    desktopOptions: {
      codexAuxiliaryModelId: "cb-kimi-k2-7-code",
      smartRouting: {
        autoSelectRules: {
          code: { mode: "route", routeId: "cb-kimi-k2-7-code" },
        },
        failover: {
          mode: "ordered",
          routeIds: ["cb-kimi-k2-7-code"],
        },
      },
    },
  });
  const [profile] = loadConfigProfiles(rootDir);

  assertArrayEqual(saved.selectedModelIds, ["remote-kimi-kimi-for-coding"], "saved.selectedModelIds");
  assertEqual(saved.desktopOptions.codexAuxiliaryModelId, "cb-remote-kimi-kimi-for-coding", "saved.desktopOptions.codexAuxiliaryModelId");
  assertArrayEqual(profile.selectedModelIds, ["remote-kimi-kimi-for-coding"], "profile.selectedModelIds");
  return {
    selectedModelIds: saved.selectedModelIds,
    defaultModel: "",
    auxiliaryRouteId: saved.desktopOptions.codexAuxiliaryModelId,
    beforeIssueCount: 1,
    afterIssueCount: 0,
  };
}

function smokeCodexModelCatalogRefreshAfterRouteSync() {
  const rootDir = makeTempProject("catalog-refresh");
  seedSyncedKimiDirectory(rootDir);
  fs.writeFileSync(
    routerConfigPath(rootDir),
    JSON.stringify({ mode: MODE_HYBRID, models: [{ id: "cb-kimi-k2-7-code" }] }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    selectionPath(rootDir),
    JSON.stringify({ selectedModelIds: ["kimi-k2-7-code"] }, null, 2),
    "utf8",
  );
  saveDesktopOptions(rootDir, {
    codexAuxiliaryModelId: "cb-kimi-k2-7-code",
  });
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-route-sync-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    buildCodexToml({ rootDir, mode: MODE_HYBRID, homeDir, model: "cb-kimi-k2-7-code" }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(codexDir, "models_cache.json"),
    JSON.stringify({
      models: [
        { slug: "cb-kimi-k2-7-code", display_name: "Old Kimi", codexbridge_cache_entry: true },
      ],
    }, null, 2),
    "utf8",
  );

  const sync = synchronizeRouteState(rootDir, {
    mode: MODE_HYBRID,
    homeDir,
  });
  const catalog = JSON.parse(fs.readFileSync(path.join(codexDir, "codexbridge-model-catalog.json"), "utf8"));
  const cache = JSON.parse(fs.readFileSync(path.join(codexDir, "models_cache.json"), "utf8"));
  const catalogSlugs = catalog.models.map((model) => model.slug);
  const cacheSlugs = cache.models.map((model) => model.slug);

  assertEqual(sync.catalog?.skipped, false, "sync.catalog.skipped");
  assertEqual(catalogSlugs.includes("cb-remote-kimi-kimi-for-coding"), true, "catalog includes repaired model");
  assertEqual(catalogSlugs.includes("cb-kimi-k2-7-code"), false, "catalog removes stale model");
  assertEqual(cacheSlugs.includes("cb-kimi-k2-7-code"), true, "native Codex cache remains untouched");
  return assertSmokeState(rootDir, sync, {
    selectedModelIds: ["remote-kimi-kimi-for-coding"],
    defaultModel: "cb-remote-kimi-kimi-for-coding",
    auxiliaryRouteId: "cb-remote-kimi-kimi-for-coding",
  });
}

function runSmokeCase(id, fn) {
  try {
    return {
      id,
      ok: true,
      ...fn(),
    };
  } catch (error) {
    return {
      id,
      ok: false,
      selectedModelIds: [],
      defaultModel: "",
      error: error?.message || String(error),
    };
  }
}

function assertSmokeState(rootDir, sync, expected) {
  const config = readRouterConfig(rootDir);
  const desktopOptions = loadDesktopOptions(rootDir);
  const selectedModelIds = readSelection(rootDir, MODE_HYBRID);
  assertArrayEqual(selectedModelIds, expected.selectedModelIds, "selectedModelIds");
  assertEqual(config.defaultModel, expected.defaultModel, "defaultModel");
  assertEqual(sync.afterStatus?.ok, true, "afterStatus.ok");
  if (expected.auxiliaryRouteId) {
    assertEqual(desktopOptions.codexAuxiliaryModelId, expected.auxiliaryRouteId, "desktopOptions.codexAuxiliaryModelId");
    assertEqual(config.codexAuxiliaryTasks?.routeId, expected.auxiliaryRouteId, "config.codexAuxiliaryTasks.routeId");
  }
  return {
    selectedModelIds,
    defaultModel: config.defaultModel,
    auxiliaryRouteId: config.codexAuxiliaryTasks?.routeId || "",
    beforeIssueCount: sync.beforeStatus?.issueCount || 0,
    afterIssueCount: sync.afterStatus?.issueCount || 0,
  };
}

function seedSyncedKimiDirectory(rootDir) {
  fs.mkdirSync(path.dirname(modelDirectoryPath(rootDir)), { recursive: true });
  fs.writeFileSync(
    modelDirectoryPath(rootDir),
    JSON.stringify({
      version: 1,
      providers: {
        kimi: {
          providerId: "kimi",
          providerName: "Kimi",
          baseUrl: "https://api.kimi.com/coding/v1",
          models: [{ id: "kimi-for-coding", displayName: "Kimicode" }],
        },
      },
    }, null, 2),
    "utf8",
  );
}

function makeTempProject(label) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `codexbridge-route-sync-${label}-`));
  fs.mkdirSync(path.join(rootDir, "config"), { recursive: true });
  return rootDir;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assertArrayEqual(actual, expected, label) {
  const left = JSON.stringify(actual || []);
  const right = JSON.stringify(expected || []);
  if (left !== right) {
    throw new Error(`${label}: expected ${right}, got ${left}`);
  }
}
