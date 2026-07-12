import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { createConfigWriteCoordinator } from "../desktop/config-write-coordinator.mjs";
import {
  MODE_HYBRID,
  applyCodexConfig,
  buildCodexToml,
  listCodexSessions,
  prepareRouterStartConfig,
  recoverCodexHistoryAccess,
  repairManagedCodexConfigCompatibility,
  saveSelection,
  supportDiagnostics,
} from "../desktop/settings.mjs";

test("current Codex config application leaves legacy state rows unchanged", () => {
  const { rootDir, homeDir, codexDir } = makeFixture();
  applyCodexConfig({ rootDir, mode: MODE_HYBRID, homeDir });
  const dbPath = createStateDatabase(codexDir, providerRows());
  const before = readThreads(dbPath);

  const result = applyCodexConfig({ rootDir, mode: MODE_HYBRID, homeDir });

  assert.equal(result.unchanged, true);
  assert.deepEqual(readThreads(dbPath), before);
  assert.equal(Object.hasOwn(result, "historySync"), false);
});

test("changed Codex config application leaves every state provider unchanged", () => {
  const { rootDir, homeDir, codexDir } = makeFixture();
  const dbPath = createStateDatabase(codexDir, providerRows());
  const before = readThreads(dbPath);
  fs.writeFileSync(path.join(codexDir, "config.toml"), 'model = "user-owned"\n', "utf8");

  const result = applyCodexConfig({ rootDir, mode: MODE_HYBRID, homeDir });

  assert.equal(result.unchanged, false);
  assert.deepEqual(readThreads(dbPath), before);
  assert.equal(Object.hasOwn(result, "historySync"), false);
});

test("prepareRouterStartConfig leaves Codex state rows unchanged", () => {
  const { rootDir, homeDir, codexDir } = makeFixture();
  const dbPath = createStateDatabase(codexDir, providerRows());
  const before = readThreads(dbPath);

  prepareRouterStartConfig({ rootDir, mode: MODE_HYBRID, homeDir });

  assert.deepEqual(readThreads(dbPath), before);
});

test("startup compatibility repair leaves Codex state rows unchanged", () => {
  const { rootDir, homeDir, codexDir } = makeFixture();
  const dbPath = createStateDatabase(codexDir, providerRows());
  const before = readThreads(dbPath);
  const legacyConfig = buildCodexToml({ rootDir, mode: MODE_HYBRID, homeDir })
    .replace('model_provider = "openai"', 'model_provider = "codex-bridge"');
  fs.writeFileSync(path.join(codexDir, "config.toml"), legacyConfig, "utf8");

  const result = repairManagedCodexConfigCompatibility({
    rootDir,
    mode: MODE_HYBRID,
    homeDir,
  });

  assert.equal(result.repaired, true);
  assert.deepEqual(readThreads(dbPath), before);
});

test("automatic config application never restores backup-only deleted threads", () => {
  const { rootDir, homeDir, codexDir } = makeFixture();
  applyCodexConfig({ rootDir, mode: MODE_HYBRID, homeDir });
  const dbPath = createStateDatabase(codexDir, [
    { id: "current", provider: "openai", title: "Current" },
  ]);
  createStateDatabase(codexDir, [
    { id: "current", provider: "openai", title: "Current" },
    { id: "deleted", provider: "codex-bridge", title: "Deleted" },
  ], `${dbPath}.codexbridge-history.2026-07-10-010000000.bak`);

  applyCodexConfig({ rootDir, mode: MODE_HYBRID, homeDir });

  assert.deepEqual(readThreads(dbPath).map((row) => row.id), ["current"]);
});

test("provider migration preview is read-only", async () => {
  const migration = await loadMigrationApi();
  const { codexDir } = makeFixture();
  const dbPath = createStateDatabase(codexDir, providerRows());
  const beforeHash = hashFile(dbPath);
  const beforeFiles = fs.readdirSync(codexDir).sort();

  const preview = migration.previewCodexStateProviderMigration({
    codexDir,
    stateDbPath: dbPath,
  });

  assert.equal(preview.migratableThreads, 1);
  assert.match(preview.confirmationFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(hashFile(dbPath), beforeHash);
  assert.deepEqual(fs.readdirSync(codexDir).sort(), beforeFiles);
  assert.deepEqual(
    readThreads(dbPath),
    providerRows().map(normalizeExpectedRow).sort((left, right) => left.id.localeCompare(right.id)),
  );
});

test("provider migration rejects absent and stale confirmations", async () => {
  const migration = await loadMigrationApi();
  const { codexDir } = makeFixture();
  const dbPath = createStateDatabase(codexDir, providerRows());
  const preview = migration.previewCodexStateProviderMigration({
    codexDir,
    stateDbPath: dbPath,
  });

  await assert.rejects(
    migration.migrateCodexStateProvider({ codexDir, stateDbPath: dbPath }),
    /confirmation/i,
  );

  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("UPDATE threads SET title = ? WHERE id = ?").run("Changed after preview", "legacy");
  } finally {
    db.close();
  }

  await assert.rejects(
    migration.migrateCodexStateProvider({
      codexDir,
      stateDbPath: dbPath,
      confirmationFingerprint: preview.confirmationFingerprint,
    }),
    /stale|fingerprint/i,
  );
  assert.equal(providerFor(dbPath, "legacy"), "codex-bridge");
});

test("provider migration rejects a state path outside the selected .codex directory", async () => {
  const migration = await loadMigrationApi();
  const { homeDir, codexDir } = makeFixture();
  const outsideDir = path.join(homeDir, "outside");
  fs.mkdirSync(outsideDir, { recursive: true });
  const outsidePath = createStateDatabase(outsideDir, providerRows(), path.join(outsideDir, "state.sqlite"));

  assert.throws(
    () => migration.previewCodexStateProviderMigration({
      codexDir,
      stateDbPath: outsidePath,
    }),
    /selected.*\.codex|outside/i,
  );
  await assert.rejects(
    migration.migrateCodexStateProvider({
      codexDir,
      stateDbPath: outsidePath,
      confirmationFingerprint: "0".repeat(64),
    }),
    /selected.*\.codex|outside/i,
  );
});

test("confirmed provider migration updates only exact legacy rows and creates one consistent snapshot", async () => {
  const migration = await loadMigrationApi();
  const { codexDir } = makeFixture();
  const dbPath = path.join(codexDir, "state_5.sqlite");
  const writer = new DatabaseSync(dbPath);
  try {
    writer.exec("PRAGMA journal_mode = WAL");
    createThreadsSchema(writer);
    insertRows(writer, providerRows());
    writer.exec("PRAGMA wal_autocheckpoint = 0");

    createStateDatabase(codexDir, [
      { id: "deleted", provider: "codex-bridge", title: "Deleted backup row" },
    ], `${dbPath}.codexbridge-history.2026-07-10-020000000.bak`);

    const before = readThreads(dbPath);
    const preview = migration.previewCodexStateProviderMigration({
      codexDir,
      stateDbPath: dbPath,
    });
    const result = await migration.migrateCodexStateProvider({
      codexDir,
      stateDbPath: dbPath,
      confirmationFingerprint: preview.confirmationFingerprint,
    });

    assert.equal(result.updatedThreads, 1);
    assert.equal(result.snapshotPath.startsWith(`${dbPath}.codexbridge-provider-migration.`), true);
    assert.equal(fs.existsSync(result.snapshotPath), true);
    assert.equal(fs.existsSync(`${result.snapshotPath}-wal`), false);
    assert.equal(fs.existsSync(`${result.snapshotPath}-shm`), false);
    assert.equal(sqliteQuickCheck(result.snapshotPath), "ok");
    assert.deepEqual(readThreads(result.snapshotPath), before);

    const after = readThreads(dbPath);
    assert.equal(after.some((row) => row.id === "deleted"), false);
    assert.equal(providerForRows(after, "legacy"), "codexbridge");
    for (const provider of [
      "codexbridge",
      "custom",
      "deepseek",
      "kimi",
      "litellm",
      "unknown",
      "openai",
    ]) {
      assert.equal(providerForRows(after, provider), provider);
    }
    assert.equal(providerForRows(after, "legacy-spaced"), "codex-bridge ");
    assert.equal(providerForRows(after, "legacy-case"), "Codex-Bridge");
  } finally {
    writer.close();
  }
});

test("provider migration stays byte-exact when model_provider is declared COLLATE NOCASE", async () => {
  const migration = await loadMigrationApi();
  const { codexDir } = makeFixture();
  const dbPath = createStateDatabase(codexDir, [
    { id: "exact", provider: "codex-bridge" },
    { id: "case", provider: "Codex-Bridge" },
    { id: "current", provider: "codexbridge" },
  ], path.join(codexDir, "state_5.sqlite"), { providerCollation: "NOCASE" });
  const preview = migration.previewCodexStateProviderMigration({ codexDir, stateDbPath: dbPath });

  assert.equal(preview.migratableThreads, 1);
  await migration.migrateCodexStateProvider({
    codexDir,
    stateDbPath: dbPath,
    confirmationFingerprint: preview.confirmationFingerprint,
  });

  assert.equal(providerFor(dbPath, "exact"), "codexbridge");
  assert.equal(providerFor(dbPath, "case"), "Codex-Bridge");
  assert.equal(providerFor(dbPath, "current"), "codexbridge");
});

test("partial SQLite backup failure removes only this migration's unique snapshot path", async () => {
  const migration = await loadMigrationApi();
  const { codexDir } = makeFixture();
  const dbPath = createStateDatabase(codexDir, providerRows());
  const preview = migration.previewCodexStateProviderMigration({ codexDir, stateDbPath: dbPath });
  const keepPath = path.join(codexDir, "keep.snapshot.sqlite");
  fs.writeFileSync(keepPath, "keep", "utf8");
  let partialPath = "";

  await assert.rejects(
    migration.migrateCodexStateProvider({
      codexDir,
      stateDbPath: dbPath,
      confirmationFingerprint: preview.confirmationFingerprint,
    }, {
      backupImpl: async (_source, snapshotPath) => {
        partialPath = snapshotPath;
        fs.writeFileSync(snapshotPath, "partial", "utf8");
        throw new Error("injected backup failure");
      },
    }),
    /injected backup failure/,
  );

  assert.ok(partialPath);
  assert.equal(fs.existsSync(partialPath), false);
  assert.equal(fs.readFileSync(keepPath, "utf8"), "keep");
  assert.equal(providerFor(dbPath, "legacy"), "codex-bridge");
});

test("snapshot normalization failure removes the completed temporary snapshot", async () => {
  const migration = await loadMigrationApi();
  const { codexDir } = makeFixture();
  const dbPath = createStateDatabase(codexDir, providerRows());
  const preview = migration.previewCodexStateProviderMigration({ codexDir, stateDbPath: dbPath });
  let snapshotPath = "";

  await assert.rejects(
    migration.migrateCodexStateProvider({
      codexDir,
      stateDbPath: dbPath,
      confirmationFingerprint: preview.confirmationFingerprint,
    }, {
      backupImpl: async (source, target) => {
        snapshotPath = target;
        return sqliteBackup(source, target);
      },
      normalizeSnapshotImpl: () => {
        throw new Error("injected normalization failure");
      },
    }),
    /injected normalization failure/,
  );

  assert.ok(snapshotPath);
  assert.equal(fs.existsSync(snapshotPath), false);
  assert.equal(providerFor(dbPath, "legacy"), "codex-bridge");
});

test("two concurrent confirmed migrations use unique owned snapshots", async () => {
  const migration = await loadMigrationApi();
  const { codexDir } = makeFixture();
  const dbPath = createStateDatabase(codexDir, providerRows());
  const preview = migration.previewCodexStateProviderMigration({ codexDir, stateDbPath: dbPath });
  let ready = 0;
  let releaseBackups;
  const backupsReady = new Promise((resolve) => {
    releaseBackups = resolve;
  });
  const backupImpl = async (source, target) => {
    await sqliteBackup(source, target);
    ready += 1;
    if (ready === 2) releaseBackups();
    await backupsReady;
  };
  const input = {
    codexDir,
    stateDbPath: dbPath,
    confirmationFingerprint: preview.confirmationFingerprint,
  };

  const settled = await Promise.allSettled([
    migration.migrateCodexStateProvider(input, { backupImpl }),
    migration.migrateCodexStateProvider(input, { backupImpl }),
  ]);
  const successes = settled.filter((item) => item.status === "fulfilled");
  const failures = settled.filter((item) => item.status === "rejected");

  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  assert.match(failures[0].reason.message, /stale|fingerprint/i);
  assert.match(
    path.basename(successes[0].value.snapshotPath),
    /codexbridge-provider-migration\.[0-9a-f]{8}-[0-9a-f-]{27}\.snapshot\.sqlite$/i,
  );
  const snapshots = fs.readdirSync(codexDir)
    .filter((name) => name.includes("codexbridge-provider-migration"));
  assert.deepEqual(snapshots, [path.basename(successes[0].value.snapshotPath)]);
});

test("support diagnostics does not enumerate backups or mutate state database files", () => {
  const fixture = makeStateScanFixture();
  try {
    const before = stateFileSnapshot(fixture.codexDir);
    const mainHash = hashFile(fixture.dbPath);
    const diagnostics = supportDiagnostics(fixture.rootDir, {
      homeDir: fixture.homeDir,
      config: { port: 15722, models: [] },
      codexCliSnapshot: { ok: true, plugins: [], mcpServers: [] },
      codexPromptInputSnapshot: { ok: true, skills: [] },
    });

    assert.equal(hashFile(fixture.dbPath), mainHash);
    assert.deepEqual(stateFileSnapshot(fixture.codexDir), before);
    assert.doesNotMatch(diagnostics.text, /backups=|hiddenBackupRefs=/);
  } finally {
    fixture.backupWriter.close();
  }
});

test("ordinary session scans leave state database files and sidecars unchanged", () => {
  const fixture = makeStateScanFixture();
  try {
    const before = stateFileSnapshot(fixture.codexDir);
    listCodexSessions({ homeDir: fixture.homeDir, limit: 10 });
    assert.deepEqual(stateFileSnapshot(fixture.codexDir), before);
  } finally {
    fixture.backupWriter.close();
  }
});

test("history recovery leaves state files unchanged and does not promise built-in OpenAI grouping", async () => {
  const fixture = makeStateScanFixture();
  try {
    applyCodexConfig({ rootDir: fixture.rootDir, mode: MODE_HYBRID, homeDir: fixture.homeDir });
    const before = stateFileSnapshot(fixture.codexDir);
    const coordinator = createConfigWriteCoordinator();
    coordinator.configure({
      allowedRoots: [fixture.codexDir],
      journalDir: path.join(fixture.codexDir, ".restore-transactions"),
    });
    const result = await recoverCodexHistoryAccess({
      homeDir: fixture.homeDir,
      coordinator,
    });
    assert.deepEqual(stateFileSnapshot(fixture.codexDir), before);
    assert.doesNotMatch(result.nextStep, /内置 OpenAI|built-in OpenAI/i);
  } finally {
    fixture.backupWriter.close();
  }
});

test("package Node engine includes node:sqlite backup support", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.engines.node, ">=22.16.0");
});

async function loadMigrationApi() {
  const migration = await import("../desktop/codex-state-migration.mjs").catch(() => null);
  assert.ok(migration, "desktop/codex-state-migration.mjs must provide the explicit migration API");
  return migration;
}

function makeFixture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-state-root-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-state-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  saveSelection(rootDir, ["codex-gpt-5-5"], MODE_HYBRID);
  return { rootDir, homeDir, codexDir };
}

function providerRows() {
  return [
    { id: "legacy", provider: "codex-bridge", title: "Legacy" },
    { id: "legacy-spaced", provider: "codex-bridge ", title: "Legacy spaced" },
    { id: "legacy-case", provider: "Codex-Bridge", title: "Legacy case" },
    { id: "codexbridge", provider: "codexbridge", title: "Current" },
    { id: "custom", provider: "custom", title: "Custom" },
    { id: "deepseek", provider: "deepseek", title: "DeepSeek" },
    { id: "kimi", provider: "kimi", title: "Kimi" },
    { id: "litellm", provider: "litellm", title: "LiteLLM" },
    { id: "unknown", provider: "unknown", title: "Unknown" },
    { id: "openai", provider: "openai", title: "OpenAI" },
  ];
}

function createStateDatabase(
  codexDir,
  rows,
  dbPath = path.join(codexDir, "state_5.sqlite"),
  options = {},
) {
  const db = new DatabaseSync(dbPath);
  try {
    createThreadsSchema(db, options);
    insertRows(db, rows);
  } finally {
    db.close();
  }
  return dbPath;
}

function createThreadsSchema(db, { providerCollation = "" } = {}) {
  const collation = providerCollation ? ` COLLATE ${providerCollation}` : "";
  db.exec(
    `CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT${collation}, model TEXT, title TEXT)`,
  );
}

function insertRows(db, rows) {
  const insert = db.prepare(
    "INSERT INTO threads (id, model_provider, model, title) VALUES (?, ?, ?, ?)",
  );
  for (const row of rows) {
    insert.run(row.id, row.provider, row.model || "test-model", row.title || row.id);
  }
}

function readThreads(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT id, model_provider, model, title FROM threads ORDER BY id")
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

function normalizeExpectedRow(row) {
  return {
    id: row.id,
    model_provider: row.provider,
    model: row.model || "test-model",
    title: row.title || row.id,
  };
}

function providerFor(dbPath, id) {
  return providerForRows(readThreads(dbPath), id);
}

function providerForRows(rows, id) {
  return rows.find((row) => row.id === id)?.model_provider;
}

function sqliteQuickCheck(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("PRAGMA quick_check").get().quick_check;
  } finally {
    db.close();
  }
}

function hashFile(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function makeStateScanFixture() {
  const fixture = makeFixture();
  const dbPath = createStateDatabase(fixture.codexDir, providerRows());
  const backupPath = `${dbPath}.codexbridge-history.review.bak`;
  const backupWriter = new DatabaseSync(backupPath);
  backupWriter.exec("PRAGMA journal_mode = WAL");
  createThreadsSchema(backupWriter);
  insertRows(backupWriter, [{ id: "backup-only", provider: "codex-bridge" }]);
  backupWriter.exec("PRAGMA wal_autocheckpoint = 0");
  return { ...fixture, dbPath, backupPath, backupWriter };
}

function stateFileSnapshot(codexDir) {
  return Object.fromEntries(
    fs.readdirSync(codexDir)
      .filter((name) => name.startsWith("state"))
      .sort()
      .map((name) => [name, hashFile(path.join(codexDir, name))]),
  );
}
