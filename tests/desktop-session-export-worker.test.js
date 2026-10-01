import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

test("session export worker builds bounded all-session markdown off Main", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-session-export-"));
  try {
    const message = await runWorker({ action: "all", homeDir, payload: {} });
    assert.equal(message.ok, true, message.error);
    assert.equal(typeof message.result.markdown, "string");
    assert.ok(message.result.markdownBytes > 0);
    assert.equal(message.result.markdownBytes, Buffer.byteLength(message.result.markdown, "utf8"));
    assert.equal(Number(message.result.tree.summary.sessions || 0), 0);
  } finally {
    fs.rmdirSync(homeDir);
  }
});

test("session export worker rejects unknown actions without reading the Codex home", async () => {
  const message = await runWorker({ action: "unknown", homeDir: path.resolve("."), payload: {} });
  assert.equal(message.ok, false);
  assert.equal(message.code, "session_export_request_invalid");
});

test("session export worker rejects oversized identifiers before scanning", async () => {
  const message = await runWorker({
    action: "session",
    homeDir: path.resolve("."),
    payload: { sessionId: "x".repeat(513) },
  });
  assert.equal(message.ok, false);
  assert.equal(message.code, "session_export_request_invalid");
});

test("session export worker routes session, project, loose, all, and filtered exports", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-session-export-actions-"));
  const codexDir = path.join(homeDir, ".codex");
  const sessionsDir = path.join(codexDir, "sessions");
  const yearDir = path.join(sessionsDir, "2026");
  const monthDir = path.join(yearDir, "09");
  const dayDir = path.join(monthDir, "01");
  const projectRollout = path.join(dayDir, "rollout-project.jsonl");
  const looseRollout = path.join(dayDir, "rollout-loose.jsonl");
  const stateDbPath = path.join(codexDir, "state_5.sqlite");
  const globalStatePath = path.join(codexDir, ".codex-global-state.json");
  fs.mkdirSync(dayDir, { recursive: true });
  fs.writeFileSync(projectRollout, rolloutText({
    id: "thread_project",
    cwd: "F:/game_code/router",
    text: "project question",
  }), "utf8");
  fs.writeFileSync(looseRollout, rolloutText({
    id: "thread_loose",
    cwd: "",
    text: "loose question",
  }), "utf8");
  fs.writeFileSync(globalStatePath, JSON.stringify({
    "electron-saved-workspace-roots": ["F:/game_code/router"],
    "sidebar-project-thread-orders": {},
    "projectless-thread-ids": ["thread_loose"],
    "thread-workspace-root-hints": {},
  }), "utf8");
  const db = new DatabaseSync(stateDbPath);
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
    insert.run("thread_project", "Project Session", "openai", "user", "vscode",
      "F:/game_code/router", 0, 1, projectRollout, 1, 2, "main", "project question");
    insert.run("thread_loose", "Loose Session", "openai", "user", "vscode",
      "", 0, 1, looseRollout, 3, 4, "main", "loose question");
  } finally {
    db.close();
  }
  try {
    const session = await runWorker({
      action: "session", homeDir, payload: { sessionId: "thread_project" },
    });
    assert.equal(session.ok, true, session.error);
    assert.equal(session.result.session.id, "thread_project");
    assert.match(session.result.markdown, /project question/u);

    const project = await runWorker({
      action: "project", homeDir, payload: { projectKey: "path:f:/game_code/router" },
    });
    assert.equal(project.ok, true, project.error);
    assert.equal(project.result.project.sessionCount, 1);

    const loose = await runWorker({ action: "loose", homeDir, payload: {} });
    assert.equal(loose.ok, true, loose.error);
    assert.equal(loose.result.group.sessionCount, 1);

    const all = await runWorker({ action: "all", homeDir, payload: {} });
    assert.equal(all.ok, true, all.error);
    assert.equal(all.result.tree.summary.sessions, 2);

    const filtered = await runWorker({
      action: "filtered",
      homeDir,
      payload: { sessionIds: ["thread_loose"], filterText: "loose" },
    });
    assert.equal(filtered.ok, true, filtered.error);
    assert.equal(filtered.result.tree.summary.sessions, 1);
    assert.equal(filtered.result.filterText, "loose");
  } finally {
    fs.unlinkSync(projectRollout);
    fs.unlinkSync(looseRollout);
    fs.unlinkSync(stateDbPath);
    fs.unlinkSync(globalStatePath);
    fs.rmdirSync(dayDir);
    fs.rmdirSync(monthDir);
    fs.rmdirSync(yearDir);
    fs.rmdirSync(sessionsDir);
    fs.rmdirSync(codexDir);
    fs.rmdirSync(homeDir);
  }
});

function rolloutText({ id, cwd, text }) {
  return [
    JSON.stringify({ type: "session_meta", payload: { id, cwd, source: "vscode" } }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    }),
  ].join("\n");
}

function runWorker(workerData) {
  const workerPath = path.resolve("desktop/session-export-worker.cjs");
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`session export worker exited with ${code}`));
    });
  });
}
