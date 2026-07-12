import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import {
  applyCodexThreadCatalogRecovery,
  previewCodexThreadCatalogRecovery,
  probeCodexThreadCatalogWritable,
  restoreCodexThreadCatalogRecoveryBackup,
} from "../desktop/codex-thread-catalog-recovery.mjs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

test("preview classifies the 147-thread catalog gap without filtering providers", () => {
  const fixture = createRecoveryFixture({ users: 130, subagents: 17, catalogUsers: 1 });

  const preview = previewCodexThreadCatalogRecovery({ homeDir: fixture.homeDir });

  assert.equal(preview.ok, true);
  assert.equal(preview.summary.sessionFiles, 129);
  assert.equal(preview.summary.archivedSessionFiles, 1);
  assert.equal(preview.summary.stateThreads, 147);
  assert.equal(preview.summary.rawThreads, 147);
  assert.equal(preview.summary.userThreads, 130);
  assert.equal(preview.summary.activeUserThreads, 129);
  assert.equal(preview.summary.subagentThreads, 17);
  assert.equal(preview.summary.internalThreads, 0);
  assert.equal(preview.summary.archivedThreads, 1);
  assert.equal(preview.summary.catalogThreads, 1);
  assert.equal(preview.summary.plannedInserts, 128);
  assert.equal(preview.summary.plannedUpdates, 0);
  assert.equal(preview.summary.existingThreads, 1);
  assert.equal(preview.summary.unrecoverableThreads, 0);
  assert.deepEqual(new Set(preview.threads.filter((item) => item.userFacing).map((item) => item.modelProvider)), new Set([
    "openai",
    "codexbridge",
    "custom",
  ]));
});

test("preview deduplicates state rollout and sidebar IDs and reports missing rollouts", () => {
  const fixture = createRecoveryFixture({ users: 4, subagents: 1, catalogUsers: 1, missingRolloutIds: ["user-002"] });
  const state = readGlobalState(fixture.homeDir);
  state["sidebar-project-thread-orders"] = {
    [fixture.projectPath]: ["user-000", "user-001", "user-001"],
  };
  state["projectless-thread-ids"] = ["user-002", "user-002"];
  writeGlobalState(fixture.homeDir, state);

  const preview = previewCodexThreadCatalogRecovery({ homeDir: fixture.homeDir });

  assert.equal(preview.summary.rawThreads, 5);
  assert.equal(preview.summary.userThreads, 4);
  assert.equal(preview.summary.subagentThreads, 1);
  assert.equal(preview.summary.sidebarThreads, 3);
  assert.equal(preview.summary.unrecoverableThreads, 1);
  assert.equal(preview.unrecoverable[0].id, "user-002");
  assert.equal(preview.unrecoverable[0].reason, "rollout_missing");
  assert.equal(preview.threads.filter((item) => item.id === "user-001").length, 1);
});

test("preview classifies a user-source thread without any user event as internal", () => {
  const fixture = createRecoveryFixture({ users: 3, subagents: 0, catalogUsers: 1 });
  const target = fixture.rows.find((row) => row.id === "user-001");
  fs.unlinkSync(target.rolloutPath);
  const db = new DatabaseSync(path.join(fixture.codexDir, "state_5.sqlite"));
  try {
    db.prepare("UPDATE threads SET has_user_event = 0, rollout_path = '', first_user_message = '' WHERE id = ?").run(target.id);
  } finally {
    db.close();
  }

  const preview = previewCodexThreadCatalogRecovery({ homeDir: fixture.homeDir });

  assert.equal(preview.summary.userThreads, 2);
  assert.equal(preview.summary.internalThreads, 1);
  assert.equal(preview.threads.find((item) => item.id === target.id).recoveryReason, "no_user_event");
});

test("apply refuses to write while Codex has not been confirmed stopped", () => {
  const fixture = createRecoveryFixture({ users: 3, subagents: 0, catalogUsers: 1 });

  assert.throws(
    () => applyCodexThreadCatalogRecovery({ homeDir: fixture.homeDir, codexStopped: false }),
    /完全退出|stopped/i,
  );
  assert.equal(catalogCount(fixture.homeDir), 1);
});

test("catalog write probe reports a busy database without changing any rows", () => {
  const fixture = createRecoveryFixture({ users: 3, subagents: 0, catalogUsers: 1 });
  const catalogPath = path.join(fixture.codexDir, "sqlite", "codex-dev.db");
  const locker = new DatabaseSync(catalogPath);
  try {
    locker.exec("BEGIN IMMEDIATE");
    const result = probeCodexThreadCatalogWritable({ homeDir: fixture.homeDir, busyTimeoutMs: 25 });
    assert.equal(result.ok, false);
    assert.equal(result.code, "catalog_busy");
    assert.equal(catalogCount(fixture.homeDir), 1);
  } finally {
    locker.exec("ROLLBACK");
    locker.close();
  }
});

test("apply migrates only active user threads and synchronizes sidebar state", () => {
  const fixture = createRecoveryFixture({ users: 8, subagents: 2, catalogUsers: 2 });
  const phases = [];

  const result = applyCodexThreadCatalogRecovery({
    homeDir: fixture.homeDir,
    codexStopped: true,
    onPhase: (phase, details) => phases.push({ phase, details }),
  });
  const rows = catalogRows(fixture.homeDir);
  const state = readGlobalState(fixture.homeDir);
  const sidebarIds = uniqueSidebarIds(state);

  assert.equal(result.ok, true);
  assert.equal(result.before.summary.activeUserThreads, 7);
  assert.equal(result.applied.inserted, 5);
  assert.equal(rows.length, 7);
  assert.deepEqual(new Set(rows.map((row) => row.model_provider)), new Set(["openai", "codexbridge", "custom"]));
  assert.equal(rows.some((row) => row.thread_id === "user-007"), false, "archived user must remain archived");
  assert.equal(rows.some((row) => row.thread_id.startsWith("subagent-")), false);
  assert.equal(sidebarIds.size, 7);
  assert.ok(Array.isArray(state["electron-saved-workspace-roots"]));
  assert.ok(state["electron-saved-workspace-roots"].includes(fixture.projectPath));
  assert.equal(result.verification.catalogActiveUserThreads, 7);
  assert.equal(result.verification.sidebarActiveUserThreads, 7);
  assert.equal(result.verification.consistent, true);
  assert.ok(result.backupDir && fs.existsSync(result.backupDir));
  assert.ok(fs.existsSync(path.join(result.backupDir, "codex-dev.db")));
  assert.ok(fs.existsSync(path.join(result.backupDir, ".codex-global-state.json")));
  assert.deepEqual(phases.map((item) => item.phase), [
    "backup_created",
    "transaction_started",
    "inserted",
    "committed",
    "verified",
  ]);
  assert.equal(phases.find((item) => item.phase === "inserted")?.details?.inserted, 5);
});

test("apply supports a catalog schema without optional columns", () => {
  const fixture = createRecoveryFixture({ users: 4, subagents: 0, catalogUsers: 0, minimalCatalog: true });

  const result = applyCodexThreadCatalogRecovery({ homeDir: fixture.homeDir, codexStopped: true });

  assert.equal(result.ok, true);
  assert.equal(result.applied.inserted, 3);
  assert.equal(catalogCount(fixture.homeDir), 3);
});

test("apply rolls the SQLite transaction and global state back when migration is interrupted", () => {
  const fixture = createRecoveryFixture({ users: 5, subagents: 0, catalogUsers: 1 });
  const stateBefore = fs.readFileSync(globalStatePath(fixture.homeDir));

  assert.throws(
    () => applyCodexThreadCatalogRecovery({
      homeDir: fixture.homeDir,
      codexStopped: true,
      failpoint: "after_state_write",
    }),
    /injected recovery failure/i,
  );

  assert.equal(catalogCount(fixture.homeDir), 1);
  assert.deepEqual(fs.readFileSync(globalStatePath(fixture.homeDir)), stateBefore);
});

test("apply restores the full backup when failure happens after commit", () => {
  const fixture = createRecoveryFixture({ users: 5, subagents: 0, catalogUsers: 1 });
  const stateBefore = fs.readFileSync(globalStatePath(fixture.homeDir));

  assert.throws(
    () => applyCodexThreadCatalogRecovery({
      homeDir: fixture.homeDir,
      codexStopped: true,
      failpoint: "after_commit",
    }),
    /injected recovery failure/i,
  );

  assert.equal(catalogCount(fixture.homeDir), 1);
  assert.deepEqual(fs.readFileSync(globalStatePath(fixture.homeDir)), stateBefore);
});

test("apply is idempotent and the second run does not duplicate catalog rows", () => {
  const fixture = createRecoveryFixture({ users: 6, subagents: 1, catalogUsers: 1 });

  const first = applyCodexThreadCatalogRecovery({ homeDir: fixture.homeDir, codexStopped: true });
  const second = applyCodexThreadCatalogRecovery({ homeDir: fixture.homeDir, codexStopped: true });

  assert.equal(first.applied.inserted, 4);
  assert.equal(second.applied.inserted, 0);
  assert.equal(second.before.summary.existingThreads, 5);
  assert.equal(catalogCount(fixture.homeDir), 5);
  assert.equal(second.verification.consistent, true);
});

test("a created backup can explicitly restore the catalog and global state", () => {
  const fixture = createRecoveryFixture({ users: 4, subagents: 0, catalogUsers: 1 });
  const result = applyCodexThreadCatalogRecovery({ homeDir: fixture.homeDir, codexStopped: true });
  assert.equal(catalogCount(fixture.homeDir), 3);
  const staleWal = path.join(fixture.codexDir, "sqlite", "codex-dev.db-wal");
  fs.writeFileSync(staleWal, "stale post-migration wal", "utf8");

  const restored = restoreCodexThreadCatalogRecoveryBackup({
    homeDir: fixture.homeDir,
    backupDir: result.backupDir,
    codexStopped: true,
  });

  assert.equal(restored.ok, true);
  assert.equal(fs.existsSync(staleWal), false);
  assert.equal(catalogCount(fixture.homeDir), 1);
});

function createRecoveryFixture({
  users,
  subagents,
  catalogUsers,
  missingRolloutIds = [],
  minimalCatalog = false,
}) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-thread-recovery-"));
  const codexDir = path.join(homeDir, ".codex");
  const projectPath = "F:/game_code/router";
  fs.mkdirSync(codexDir, { recursive: true });
  writeGlobalState(homeDir, {
    "electron-saved-workspace-roots": [projectPath],
    "sidebar-project-thread-orders": {
      [projectPath]: catalogUsers ? ["user-000"] : [],
    },
    "projectless-thread-ids": [],
    "thread-workspace-root-hints": {},
    "unrelated-setting": true,
  });

  const rows = [];
  for (let index = 0; index < users; index += 1) {
    const id = `user-${String(index).padStart(3, "0")}`;
    const provider = index % 9 === 0 ? "custom" : index % 3 === 0 ? "codexbridge" : "openai";
    const archived = index === users - 1 ? 1 : 0;
    const rolloutPath = path.join(
      codexDir,
      archived ? "archived_sessions" : "sessions",
      "2026",
      "07",
      "12",
      `rollout-${id}.jsonl`,
    );
    if (!missingRolloutIds.includes(id)) {
      writeRollout(rolloutPath, {
        id,
        cwd: index % 2 === 0 ? projectPath : "",
        userText: `question ${index}`,
        source: "vscode",
      });
    }
    rows.push({
      id,
      title: `User ${index}`,
      modelProvider: provider,
      threadSource: "user",
      source: "vscode",
      cwd: index % 2 === 0 ? projectPath : "",
      archived,
      hasUserEvent: 1,
      rolloutPath,
      createdAt: 1000 + index,
      updatedAt: 2000 + index,
      gitBranch: "main",
    });
  }
  for (let index = 0; index < subagents; index += 1) {
    rows.push({
      id: `subagent-${String(index).padStart(3, "0")}`,
      title: `Subagent ${index}`,
      modelProvider: "openai",
      threadSource: "subagent",
      source: '{"subagent":{"thread_spawn":{}}}',
      cwd: projectPath,
      archived: 0,
      hasUserEvent: 0,
      rolloutPath: "",
      createdAt: 3000 + index,
      updatedAt: 4000 + index,
      gitBranch: "main",
    });
  }
  createStateDb(codexDir, rows);
  createCatalogDb(codexDir, rows.slice(0, catalogUsers), { minimal: minimalCatalog });
  return { homeDir, codexDir, projectPath, rows };
}

function createStateDb(codexDir, rows) {
  const db = new DatabaseSync(path.join(codexDir, "state_5.sqlite"));
  try {
    db.exec([
      "CREATE TABLE threads (",
      "id TEXT PRIMARY KEY, title TEXT, model_provider TEXT, thread_source TEXT, source TEXT,",
      "cwd TEXT, archived INTEGER, has_user_event INTEGER, rollout_path TEXT,",
      "created_at REAL, updated_at REAL, git_branch TEXT, first_user_message TEXT",
      ")",
    ].join(" "));
    const insert = db.prepare([
      "INSERT INTO threads",
      "(id,title,model_provider,thread_source,source,cwd,archived,has_user_event,rollout_path,created_at,updated_at,git_branch,first_user_message)",
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ].join(" "));
    for (const row of rows) {
      insert.run(
        row.id, row.title, row.modelProvider, row.threadSource, row.source, row.cwd,
        row.archived, row.hasUserEvent, row.rolloutPath, row.createdAt, row.updatedAt,
        row.gitBranch, row.threadSource === "user" ? `question for ${row.id}` : "",
      );
    }
  } finally {
    db.close();
  }
}

function createCatalogDb(codexDir, rows, { minimal = false } = {}) {
  const dir = path.join(codexDir, "sqlite");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "codex-dev.db"));
  try {
    db.exec(minimal
      ? [
          "CREATE TABLE local_thread_catalog (",
          "thread_id TEXT PRIMARY KEY, display_title TEXT NOT NULL,",
          "source_updated_at REAL NOT NULL, cwd TEXT NOT NULL",
          ")",
        ].join(" ")
      : [
          "CREATE TABLE local_thread_catalog (",
          "host_id TEXT NOT NULL, thread_id TEXT NOT NULL, display_title TEXT NOT NULL,",
          "source_created_at REAL NOT NULL, source_updated_at REAL NOT NULL, cwd TEXT NOT NULL,",
          "source_kind TEXT NOT NULL, source_detail TEXT, model_provider TEXT NOT NULL, git_branch TEXT,",
          "observation_sequence INTEGER NOT NULL, missing_candidate INTEGER NOT NULL DEFAULT 0,",
          "PRIMARY KEY (host_id, thread_id))",
          "; CREATE TABLE local_thread_catalog_hosts (host_id TEXT PRIMARY KEY, host_kind TEXT NOT NULL)",
          "; CREATE TABLE local_thread_catalog_metadata (id INTEGER PRIMARY KEY, catalog_revision INTEGER NOT NULL DEFAULT 0)",
          "; INSERT INTO local_thread_catalog_metadata (id,catalog_revision) VALUES (1,0)",
          "; CREATE TABLE local_thread_catalog_sync_state (host_id TEXT PRIMARY KEY, watermark_updated_at REAL, initial_build_complete INTEGER NOT NULL DEFAULT 0, observation_sequence INTEGER NOT NULL DEFAULT 0)",
        ].join(" "));
    const columns = tableColumns(db, "local_thread_catalog");
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const values = {
        host_id: "local",
        thread_id: row.id,
        display_title: row.title,
        source_created_at: row.createdAt,
        source_updated_at: row.updatedAt,
        cwd: row.cwd,
        source_kind: "vscode",
        source_detail: null,
        model_provider: row.modelProvider,
        git_branch: row.gitBranch,
        observation_sequence: index + 1,
        missing_candidate: 0,
      };
      const names = columns.filter((name) => Object.hasOwn(values, name));
      db.prepare(`INSERT INTO local_thread_catalog (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
        .run(...names.map((name) => values[name]));
    }
  } finally {
    db.close();
  }
}

function writeRollout(target, { id, cwd, userText, source }) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, [
    JSON.stringify({ type: "session_meta", payload: { id, cwd, source } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: userText }] } }),
  ].join("\n"), "utf8");
}

function tableColumns(db, name) {
  return db.prepare(`PRAGMA table_info(${name})`).all().map((row) => row.name);
}

function globalStatePath(homeDir) {
  return path.join(homeDir, ".codex", ".codex-global-state.json");
}

function readGlobalState(homeDir) {
  return JSON.parse(fs.readFileSync(globalStatePath(homeDir), "utf8"));
}

function writeGlobalState(homeDir, value) {
  fs.writeFileSync(globalStatePath(homeDir), JSON.stringify(value, null, 2), "utf8");
}

function catalogRows(homeDir) {
  const db = new DatabaseSync(path.join(homeDir, ".codex", "sqlite", "codex-dev.db"), { readOnly: true });
  try {
    return db.prepare("SELECT * FROM local_thread_catalog ORDER BY thread_id").all();
  } finally {
    db.close();
  }
}

function catalogCount(homeDir) {
  return catalogRows(homeDir).length;
}

function uniqueSidebarIds(state) {
  return new Set([
    ...Object.values(state["sidebar-project-thread-orders"] || {}).flat(),
    ...(state["projectless-thread-ids"] || []),
  ]);
}
