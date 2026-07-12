import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

export function createHistoryRecoveryE2EFixture(homeDir, {
  users = 130,
  subagents = 17,
  catalogUsers = 1,
  projectPath = "F:/game_code/router",
} = {}) {
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, ".codex-global-state.json"), JSON.stringify({
    "electron-saved-workspace-roots": [projectPath],
    "sidebar-project-thread-orders": {
      [projectPath]: catalogUsers ? ["user-000"] : [],
    },
    "projectless-thread-ids": [],
    "thread-workspace-root-hints": {},
  }, null, 2), "utf8");

  const rows = [];
  for (let index = 0; index < users; index += 1) {
    const id = `user-${String(index).padStart(3, "0")}`;
    const archived = index === users - 1 ? 1 : 0;
    const cwd = index % 2 === 0 ? projectPath : "";
    const rolloutPath = path.join(
      codexDir,
      archived ? "archived_sessions" : "sessions",
      "2026", "07", "12", `rollout-${id}.jsonl`,
    );
    writeRollout(rolloutPath, { id, cwd, userText: `question ${index}` });
    rows.push({
      id,
      title: `User ${index}`,
      modelProvider: index % 9 === 0 ? "custom" : index % 3 === 0 ? "codexbridge" : "openai",
      threadSource: "user",
      source: "vscode",
      cwd,
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
  createCatalogDb(codexDir, rows.slice(0, catalogUsers));
  return { homeDir, codexDir, projectPath, rows };
}

export function historyRecoveryFixtureCounts(homeDir) {
  const codexDir = path.join(homeDir, ".codex");
  const db = new DatabaseSync(path.join(codexDir, "sqlite", "codex-dev.db"), { readOnly: true });
  let catalogThreads = 0;
  try {
    catalogThreads = Number(db.prepare("SELECT COUNT(*) AS count FROM local_thread_catalog").get()?.count || 0);
  } finally {
    db.close();
  }
  const state = JSON.parse(fs.readFileSync(path.join(codexDir, ".codex-global-state.json"), "utf8"));
  const sidebarIds = new Set([
    ...Object.values(state["sidebar-project-thread-orders"] || {}).flat(),
    ...(state["projectless-thread-ids"] || []),
  ]);
  return { catalogThreads, sidebarThreads: sidebarIds.size };
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

function createCatalogDb(codexDir, rows) {
  const dir = path.join(codexDir, "sqlite");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "codex-dev.db"));
  try {
    db.exec([
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
    const insert = db.prepare([
      "INSERT INTO local_thread_catalog",
      "(host_id,thread_id,display_title,source_created_at,source_updated_at,cwd,source_kind,source_detail,model_provider,git_branch,observation_sequence,missing_candidate)",
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    ].join(" "));
    rows.forEach((row, index) => insert.run(
      "local", row.id, row.title, row.createdAt, row.updatedAt, row.cwd, "vscode", null,
      row.modelProvider, row.gitBranch, index + 1, 0,
    ));
  } finally {
    db.close();
  }
}

function writeRollout(target, { id, cwd, userText }) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, [
    JSON.stringify({ type: "session_meta", payload: { id, cwd, source: "vscode" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: userText }] } }),
  ].join("\n"), "utf8");
}
