import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const LEGACY_PROVIDER = "codex-bridge";
const CURRENT_PROVIDER = "codexbridge";
const STATE_DATABASE_NAME = /^state(?:_\d+)?\.sqlite$/;

export function previewCodexStateProviderMigration({ codexDir, stateDbPath } = {}) {
  const selection = validateStateDatabaseSelection({ codexDir, stateDbPath });
  const state = readDatabaseState(selection.stateDbPath, selection.stateDbPath);
  return {
    codexDir: selection.codexDir,
    stateDbPath: selection.stateDbPath,
    fromProvider: LEGACY_PROVIDER,
    toProvider: CURRENT_PROVIDER,
    totalThreads: state.totalThreads,
    migratableThreads: state.migratableThreads,
    providerCounts: state.providerCounts,
    confirmationFingerprint: state.confirmationFingerprint,
  };
}

export async function migrateCodexStateProvider({
  codexDir,
  stateDbPath,
  confirmationFingerprint,
} = {}, {
  backupImpl = backup,
  normalizeSnapshotImpl = normalizeSnapshot,
} = {}) {
  const confirmation = String(confirmationFingerprint || "").trim();
  if (!confirmation) {
    throw new Error("A confirmation fingerprint from a read-only preview is required.");
  }

  const selection = validateStateDatabaseSelection({ codexDir, stateDbPath });
  const preview = readDatabaseState(selection.stateDbPath, selection.stateDbPath);
  assertCurrentConfirmation(preview.confirmationFingerprint, confirmation);

  const snapshotPath = nextSnapshotPath(
    selection.stateDbPath,
    preview.confirmationFingerprint,
  );
  let committed = false;
  let db;

  try {
    await createConsistentSnapshot(selection.stateDbPath, snapshotPath, {
      backupImpl,
      normalizeSnapshotImpl,
    });

    const snapshotState = readDatabaseState(snapshotPath, selection.stateDbPath);
    assertCurrentConfirmation(snapshotState.confirmationFingerprint, confirmation);
    assertReadableSnapshot(snapshotPath);

    db = new DatabaseSync(selection.stateDbPath);
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");

    const lockedState = databaseState(db, selection.stateDbPath);
    assertCurrentConfirmation(lockedState.confirmationFingerprint, confirmation);

    const update = db
      .prepare(
        "UPDATE threads SET model_provider = ? " +
          "WHERE model_provider COLLATE BINARY = ?",
      )
      .run(CURRENT_PROVIDER, LEGACY_PROVIDER);
    db.exec("COMMIT");
    committed = true;

    return {
      codexDir: selection.codexDir,
      stateDbPath: selection.stateDbPath,
      snapshotPath,
      fromProvider: LEGACY_PROVIDER,
      toProvider: CURRENT_PROVIDER,
      updatedThreads: Number(update.changes || 0),
      confirmationFingerprint: confirmation,
    };
  } catch (error) {
    if (db) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // No active transaction remains after a successful commit.
      }
    }
    if (!committed) {
      removeOwnedSnapshotFiles(snapshotPath);
    }
    throw error;
  } finally {
    if (db) {
      db.close();
    }
  }
}

function validateStateDatabaseSelection({ codexDir, stateDbPath } = {}) {
  if (!codexDir || !stateDbPath) {
    throw new Error("Both a selected .codex directory and an explicit state*.sqlite path are required.");
  }

  const resolvedCodexDir = path.resolve(String(codexDir));
  const resolvedStateDbPath = path.resolve(String(stateDbPath));
  if (path.basename(resolvedCodexDir).toLowerCase() !== ".codex") {
    throw new Error("codexDir must be an explicitly selected .codex directory.");
  }
  if (!fs.existsSync(resolvedCodexDir) || !fs.statSync(resolvedCodexDir).isDirectory()) {
    throw new Error("The selected .codex directory does not exist.");
  }
  if (
    !STATE_DATABASE_NAME.test(path.basename(resolvedStateDbPath)) ||
    !samePath(path.dirname(resolvedStateDbPath), resolvedCodexDir)
  ) {
    throw new Error("stateDbPath must be a state*.sqlite file inside the selected .codex directory.");
  }
  if (!fs.existsSync(resolvedStateDbPath) || !fs.statSync(resolvedStateDbPath).isFile()) {
    throw new Error("The selected state*.sqlite file does not exist.");
  }

  const realCodexDir = fs.realpathSync(resolvedCodexDir);
  const realStateDbPath = fs.realpathSync(resolvedStateDbPath);
  if (!samePath(path.dirname(realStateDbPath), realCodexDir)) {
    throw new Error("stateDbPath resolves outside the selected .codex directory.");
  }
  assertSqliteHeader(realStateDbPath);
  return {
    codexDir: realCodexDir,
    stateDbPath: realStateDbPath,
  };
}

function readDatabaseState(dbPath, identityPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let transactionOpen = false;
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA query_only = ON");
    db.exec("BEGIN");
    transactionOpen = true;
    const state = databaseState(db, identityPath);
    db.exec("COMMIT");
    transactionOpen = false;
    return state;
  } catch (error) {
    if (transactionOpen) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original preview failure.
      }
    }
    throw error;
  } finally {
    db.close();
  }
}

function databaseState(db, identityPath) {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'threads'")
    .get();
  if (!table) {
    throw new Error("The selected state database does not contain a threads table.");
  }
  const columns = db.prepare("PRAGMA table_info(threads)").all().map((column) => column.name);
  if (!columns.includes("id") || !columns.includes("model_provider")) {
    throw new Error("The selected threads table must contain id and model_provider columns.");
  }

  const selectedColumns = columns.map(quoteIdentifier).join(", ");
  const rows = db
    .prepare(`SELECT ${selectedColumns} FROM threads ORDER BY ${quoteIdentifier("id")}`)
    .all();
  const providerCounts = db
    .prepare(
      "SELECT model_provider AS provider, COUNT(*) AS count " +
        "FROM threads " +
        "GROUP BY model_provider COLLATE BINARY " +
        "ORDER BY model_provider COLLATE BINARY",
    )
    .all()
    .map((row) => ({
      provider: row.provider ?? null,
      count: Number(row.count || 0),
    }));
  const migratableThreads = providerCounts
    .find((item) => item.provider === LEGACY_PROVIDER)?.count || 0;
  const confirmationFingerprint = createHash("sha256")
    .update(JSON.stringify({
      version: 1,
      stateDbPath: comparablePath(identityPath),
      tableSql: table.sql || "",
      columns,
      rows: rows.map((row) => columns.map((column) => fingerprintValue(row[column]))),
    }))
    .digest("hex");

  return {
    totalThreads: rows.length,
    migratableThreads,
    providerCounts,
    confirmationFingerprint,
  };
}

async function createConsistentSnapshot(stateDbPath, snapshotPath, {
  backupImpl,
  normalizeSnapshotImpl,
}) {
  const source = new DatabaseSync(stateDbPath, { readOnly: true });
  try {
    source.exec("PRAGMA busy_timeout = 5000");
    source.exec("PRAGMA query_only = ON");
    await backupImpl(source, snapshotPath);
  } finally {
    source.close();
  }

  await normalizeSnapshotImpl(snapshotPath);
}

function normalizeSnapshot(snapshotPath) {
  const snapshot = new DatabaseSync(snapshotPath);
  try {
    const result = snapshot.prepare("PRAGMA journal_mode = DELETE").get();
    if (String(result?.journal_mode || "").toLowerCase() !== "delete") {
      throw new Error("The SQLite migration snapshot could not be normalized to one file.");
    }
  } finally {
    snapshot.close();
  }
}

function assertReadableSnapshot(snapshotPath) {
  const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    const result = snapshot.prepare("PRAGMA quick_check").get();
    if (result?.quick_check !== "ok") {
      throw new Error("The SQLite migration snapshot failed its integrity check.");
    }
  } finally {
    snapshot.close();
  }
}

function assertCurrentConfirmation(actual, confirmation) {
  if (actual !== confirmation) {
    throw new Error("The confirmation fingerprint is stale; run a new read-only preview.");
  }
}

function nextSnapshotPath(stateDbPath, fingerprint) {
  void fingerprint;
  let candidate = `${stateDbPath}.codexbridge-provider-migration.${randomUUID()}.snapshot.sqlite`;
  while (fs.existsSync(candidate)) {
    candidate = `${stateDbPath}.codexbridge-provider-migration.${randomUUID()}.snapshot.sqlite`;
  }
  return candidate;
}

function removeOwnedSnapshotFiles(snapshotPath) {
  removeFileIfExists(snapshotPath);
  removeFileIfExists(`${snapshotPath}-wal`);
  removeFileIfExists(`${snapshotPath}-shm`);
}

function removeFileIfExists(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function fingerprintValue(value) {
  if (typeof value === "bigint") {
    return { bigint: value.toString() };
  }
  if (value instanceof Uint8Array) {
    return { bytes: Buffer.from(value).toString("base64") };
  }
  return value;
}

function assertSqliteHeader(filePath) {
  const handle = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(16);
    const bytesRead = fs.readSync(handle, header, 0, header.length, 0);
    if (bytesRead !== header.length || header.toString("utf8") !== "SQLite format 3\0") {
      throw new Error("The selected state*.sqlite file is not a SQLite database.");
    }
  } finally {
    fs.closeSync(handle);
  }
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function comparablePath(value) {
  const normalized = path.normalize(path.resolve(String(value || "")));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return comparablePath(left) === comparablePath(right);
}
