import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROLLOUT_READ_LIMIT_BYTES = 4 * 1024 * 1024;
const CATALOG_REQUIRED_COLUMNS = new Set(["thread_id"]);
const CATALOG_VALUE_COLUMNS = new Set([
  "host_id",
  "thread_id",
  "display_title",
  "source_created_at",
  "source_updated_at",
  "cwd",
  "source_kind",
  "source_detail",
  "model_provider",
  "git_branch",
  "observation_sequence",
  "missing_candidate",
]);

export function previewCodexThreadCatalogRecovery({ homeDir = os.homedir() } = {}) {
  const DatabaseSync = databaseSync();
  const codexDir = path.join(homeDir, ".codex");
  const statePath = path.join(codexDir, ".codex-global-state.json");
  const catalogPath = path.join(codexDir, "sqlite", "codex-dev.db");
  const globalState = readJsonObject(statePath);
  const sidebar = sidebarSnapshot(globalState);
  const stateScan = scanStateDatabases(codexDir, DatabaseSync);
  const rolloutScan = scanRolloutFiles(codexDir, stateScan.threads);
  const catalogScan = scanCatalog(catalogPath, DatabaseSync);
  const merged = mergeThreadSources(stateScan.threads, rolloutScan.threads);
  const catalogById = new Map(catalogScan.rows.map((row) => [normalizeId(row.threadId), row]));
  const threads = [];
  const unrecoverable = [];

  for (const sourceThread of merged.values()) {
    const thread = classifyThread(sourceThread, sidebar);
    const catalogRow = catalogById.get(normalizeId(thread.id)) || null;
    const catalogState = catalogRow
      ? catalogRowNeedsUpdate(catalogRow, thread) ? "update" : "existing"
      : "insert";
    const recoverable = thread.userFacing && !thread.archived && thread.rolloutExists;
    let recoveryState = "excluded";
    let recoveryReason = "";
    if (recoverable) {
      recoveryState = catalogState;
    } else if (thread.userFacing && !thread.archived) {
      recoveryState = "unrecoverable";
      recoveryReason = "rollout_missing";
      unrecoverable.push({ id: thread.id, reason: recoveryReason });
    } else if (thread.archived) {
      recoveryReason = "archived";
    } else if (thread.subagent) {
      recoveryReason = "subagent";
    } else {
      recoveryReason = "no_user_event";
    }
    threads.push({
      ...thread,
      inCatalog: Boolean(catalogRow),
      recoveryState,
      recoveryReason,
    });
  }

  threads.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  const activeUserThreads = threads.filter((thread) => thread.userFacing && !thread.archived);
  const plannedInserts = threads.filter((thread) => thread.recoveryState === "insert").length;
  const plannedUpdates = threads.filter((thread) => thread.recoveryState === "update").length;
  const existingThreads = threads.filter((thread) => thread.recoveryState === "existing").length;
  const catalogActiveUserThreads = activeUserThreads.filter((thread) => thread.inCatalog).length;
  const recoverableThreads = plannedInserts + plannedUpdates;

  return {
    ok: catalogScan.ok && stateScan.ok,
    version: 1,
    paths: {
      codexDir,
      statePath,
      catalogPath,
      stateDatabases: stateScan.paths,
    },
    summary: {
      sessionFiles: rolloutScan.sessionFiles,
      archivedSessionFiles: rolloutScan.archivedSessionFiles,
      stateThreads: stateScan.rowCount,
      rawThreads: threads.length,
      userThreads: threads.filter((thread) => thread.userFacing).length,
      activeUserThreads: activeUserThreads.length,
      subagentThreads: threads.filter((thread) => thread.subagent).length,
      internalThreads: threads.filter((thread) => thread.internal).length,
      archivedThreads: threads.filter((thread) => thread.archived).length,
      catalogThreads: catalogScan.rows.length,
      catalogActiveUserThreads,
      sidebarThreads: sidebar.threadIds.size,
      recoverableThreads,
      plannedInserts,
      plannedUpdates,
      existingThreads,
      unrecoverableThreads: unrecoverable.length,
    },
    schema: catalogScan.schema,
    threads,
    unrecoverable,
    diagnostics: [
      ...stateScan.diagnostics,
      ...rolloutScan.diagnostics,
      ...catalogScan.diagnostics,
    ],
  };
}

export function probeCodexThreadCatalogWritable({
  homeDir = os.homedir(),
  busyTimeoutMs = 1000,
} = {}) {
  const catalogPath = path.join(homeDir, ".codex", "sqlite", "codex-dev.db");
  if (!fs.existsSync(catalogPath)) {
    return {
      ok: false,
      code: "catalog_missing",
      catalogPath,
      message: "新版 Codex 会话目录数据库不存在。",
    };
  }
  const DatabaseSync = databaseSync();
  let db;
  let transactionOpen = false;
  try {
    db = new DatabaseSync(catalogPath);
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.min(5000, Number(busyTimeoutMs) || 0))}`);
    if (!hasTable(db, "local_thread_catalog")) {
      return {
        ok: false,
        code: "catalog_table_missing",
        catalogPath,
        message: "新版 Codex 数据库缺少 local_thread_catalog 表。",
      };
    }
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    db.prepare("SELECT COUNT(*) AS count FROM local_thread_catalog").get();
    db.exec("ROLLBACK");
    transactionOpen = false;
    return {
      ok: true,
      code: "writable",
      catalogPath,
      message: "新版会话目录数据库已释放，可以安全迁移。",
    };
  } catch (error) {
    return {
      ok: false,
      code: /busy|locked/i.test(String(error?.message || "")) ? "catalog_busy" : "catalog_unwritable",
      catalogPath,
      message: `新版会话目录数据库仍被占用或不可写：${error?.message || error}`,
    };
  } finally {
    if (transactionOpen) {
      try {
        db?.exec("ROLLBACK");
      } catch {
        // The probe result remains authoritative.
      }
    }
    db?.close();
  }
}

export function applyCodexThreadCatalogRecovery({
  homeDir = os.homedir(),
  codexStopped = false,
  failpoint = "",
  onPhase = () => {},
} = {}) {
  if (!codexStopped) {
    throw new Error("必须先确认 ChatGPT / Codex 已完全退出（stopped），才能写入新版会话目录。");
  }
  const before = previewCodexThreadCatalogRecovery({ homeDir });
  validateWritablePreview(before);
  const backup = createRecoveryBackup(before.paths);
  emitRecoveryPhase(onPhase, "backup_created", { backupDir: backup.backupDir, files: backup.files.length });
  const DatabaseSync = databaseSync();
  const db = new DatabaseSync(before.paths.catalogPath);
  let transactionOpen = false;
  let stateWritten = false;
  let inserted = 0;
  let updated = 0;
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    emitRecoveryPhase(onPhase, "transaction_started", { catalogPath: before.paths.catalogPath });
    ensureLocalCatalogHost(db);
    let observationSequence = currentObservationSequence(db);
    for (const thread of before.threads) {
      if (thread.recoveryState !== "insert" && thread.recoveryState !== "update") {
        continue;
      }
      observationSequence += 1;
      const values = catalogValues(thread, observationSequence);
      if (thread.recoveryState === "insert") {
        insertCatalogRow(db, before.schema.columns, values);
        inserted += 1;
      } else {
        updateCatalogRow(db, before.schema.columns, values);
        updated += 1;
      }
    }
    emitRecoveryPhase(onPhase, "inserted", { inserted, updated });
    updateCatalogBookkeeping(db, before.threads, observationSequence);
    const nextState = synchronizedGlobalState(
      readJsonObject(before.paths.statePath),
      before.threads.filter((thread) =>
        thread.userFacing && !thread.archived && thread.rolloutExists
      ),
    );
    writeJsonAtomic(before.paths.statePath, nextState);
    stateWritten = true;
    if (failpoint === "after_state_write") {
      throw new Error("Injected recovery failure after_state_write");
    }
    db.exec("COMMIT");
    transactionOpen = false;
    emitRecoveryPhase(onPhase, "committed", { inserted, updated });
  } catch (error) {
    if (transactionOpen) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The original error remains authoritative.
      }
    }
    db.close();
    if (stateWritten) {
      restoreSingleBackupFile(
        path.join(backup.backupDir, ".codex-global-state.json"),
        before.paths.statePath,
      );
    }
    throw error;
  }
  db.close();

  if (failpoint === "after_commit") {
    restoreCodexThreadCatalogRecoveryBackup({
      homeDir,
      backupDir: backup.backupDir,
      codexStopped: true,
    });
    throw new Error("Injected recovery failure after_commit; backup restored");
  }

  let after;
  let activeRecoverableIds;
  let catalogActiveUserThreads;
  let sidebarActiveUserThreads;
  let consistent;
  try {
    after = previewCodexThreadCatalogRecovery({ homeDir });
    activeRecoverableIds = new Set(after.threads
      .filter((thread) => thread.userFacing && !thread.archived && thread.rolloutExists)
      .map((thread) => normalizeId(thread.id)));
    const catalogIds = new Set(after.threads.filter((thread) => thread.inCatalog).map((thread) => normalizeId(thread.id)));
    const sidebarState = sidebarSnapshot(readJsonObject(after.paths.statePath));
    catalogActiveUserThreads = countIntersection(activeRecoverableIds, catalogIds);
    sidebarActiveUserThreads = countIntersection(activeRecoverableIds, sidebarState.threadIds);
    consistent = catalogActiveUserThreads === activeRecoverableIds.size
      && sidebarActiveUserThreads === activeRecoverableIds.size;
    if (!consistent) {
      throw new Error(
        `恢复后回读验证失败：可恢复用户会话 ${activeRecoverableIds.size}，目录 ${catalogActiveUserThreads}，侧栏 ${sidebarActiveUserThreads}。`,
      );
    }
    emitRecoveryPhase(onPhase, "verified", {
      expectedActiveUserThreads: activeRecoverableIds.size,
      catalogActiveUserThreads,
      sidebarActiveUserThreads,
    });
  } catch (error) {
    restoreCodexThreadCatalogRecoveryBackup({
      homeDir,
      backupDir: backup.backupDir,
      codexStopped: true,
    });
    throw new Error(`${error.message} 已自动恢复迁移前备份。`, { cause: error });
  }
  return {
    ok: true,
    before,
    after,
    backupDir: backup.backupDir,
    backupFiles: backup.files,
    applied: { inserted, updated },
    verification: {
      expectedActiveUserThreads: activeRecoverableIds.size,
      catalogActiveUserThreads,
      sidebarActiveUserThreads,
      consistent,
    },
    message: `已把 ${inserted} 条会话新增到新版目录，更新 ${updated} 条，并完成目录与侧栏回读验证。`,
  };
}

export function restoreCodexThreadCatalogRecoveryBackup({
  homeDir = os.homedir(),
  backupDir = "",
  codexStopped = false,
} = {}) {
  if (!codexStopped) {
    throw new Error("必须先确认 ChatGPT / Codex 已完全退出（stopped），才能恢复会话目录备份。");
  }
  const codexDir = path.join(homeDir, ".codex");
  const recoveryRoot = path.resolve(codexDir, "codexbridge-history-recovery");
  const resolvedBackup = path.resolve(String(backupDir || ""));
  if (!resolvedBackup.startsWith(`${recoveryRoot}${path.sep}`) || !fs.existsSync(resolvedBackup)) {
    throw new Error("所选目录不是当前 Codex 用户的历史恢复备份。");
  }
  const targets = [
    ["codex-dev.db", path.join(codexDir, "sqlite", "codex-dev.db")],
    ["codex-dev.db-wal", path.join(codexDir, "sqlite", "codex-dev.db-wal")],
    ["codex-dev.db-shm", path.join(codexDir, "sqlite", "codex-dev.db-shm")],
    [".codex-global-state.json", path.join(codexDir, ".codex-global-state.json")],
  ];
  const restoredFiles = [];
  const clearedSidecars = [];
  for (const [name, target] of targets) {
    const source = path.join(resolvedBackup, name);
    if (!fs.existsSync(source)) {
      if ((name.endsWith("-wal") || name.endsWith("-shm")) && fs.existsSync(target)) {
        fs.unlinkSync(target);
        clearedSidecars.push(target);
      }
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    restoredFiles.push(target);
  }
  return {
    ok: true,
    backupDir: resolvedBackup,
    restoredFiles,
    clearedSidecars,
    message: `已从备份恢复 ${restoredFiles.length} 个会话目录文件。`,
  };
}

function databaseSync() {
  try {
    return require("node:sqlite").DatabaseSync;
  } catch (error) {
    throw new Error(`当前运行环境不支持安全恢复 Codex 会话目录：${error.message}`);
  }
}

function scanStateDatabases(codexDir, DatabaseSync) {
  const paths = fs.existsSync(codexDir)
    ? fs.readdirSync(codexDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^state(?:_\d+)?\.sqlite$/.test(entry.name))
      .map((entry) => path.join(codexDir, entry.name))
      .sort()
    : [];
  const byId = new Map();
  const diagnostics = [];
  let rowCount = 0;
  for (const dbPath of paths) {
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec("PRAGMA query_only = ON");
      db.exec("PRAGMA busy_timeout = 1500");
      if (!hasTable(db, "threads")) {
        diagnostics.push({ source: dbPath, reason: "threads_table_missing" });
        continue;
      }
      const columns = tableColumnNames(db, "threads");
      if (!columns.includes("id")) {
        diagnostics.push({ source: dbPath, reason: "thread_id_column_missing" });
        continue;
      }
      const rows = db.prepare(`SELECT ${stateSelectColumns(columns)} FROM threads`).all();
      rowCount += rows.length;
      for (const row of rows) {
        const normalized = normalizeStateThread(row, dbPath);
        const id = normalizeId(normalized.id);
        if (!id) {
          continue;
        }
        const existing = byId.get(id);
        if (!existing || normalized.updatedAt >= existing.updatedAt) {
          byId.set(id, normalized);
        }
      }
    } catch (error) {
      diagnostics.push({ source: dbPath, reason: "state_database_unreadable", detail: error.message });
    } finally {
      db?.close();
    }
  }
  return { ok: paths.length > 0, paths, rowCount, threads: [...byId.values()], diagnostics };
}

function scanRolloutFiles(codexDir, stateThreads = []) {
  const roots = [
    { dir: path.join(codexDir, "sessions"), archived: false },
    { dir: path.join(codexDir, "archived_sessions"), archived: true },
  ];
  const byId = new Map();
  const stateByRolloutPath = new Map(
    stateThreads
      .filter((thread) => normalizePath(thread.rolloutPath))
      .map((thread) => [canonicalPath(thread.rolloutPath), thread]),
  );
  const diagnostics = [];
  let sessionFiles = 0;
  let archivedSessionFiles = 0;
  for (const root of roots) {
    for (const filePath of recursiveJsonlFiles(root.dir)) {
      if (root.archived) {
        archivedSessionFiles += 1;
      } else {
        sessionFiles += 1;
      }
      try {
        const stateThread = stateByRolloutPath.get(canonicalPath(filePath));
        const metadata = stateThread && rolloutMetadataAlreadyKnown(stateThread)
          ? {
              ...stateThread,
              archived: Boolean(stateThread.archived || root.archived),
              rolloutPath: filePath,
            }
          : readRolloutMetadata(filePath, root.archived);
        if (!metadata.id) {
          diagnostics.push({ source: filePath, reason: "rollout_thread_id_missing" });
          continue;
        }
        const key = normalizeId(metadata.id);
        const existing = byId.get(key);
        if (!existing || metadata.updatedAt >= existing.updatedAt) {
          byId.set(key, metadata);
        }
      } catch (error) {
        diagnostics.push({ source: filePath, reason: "rollout_unreadable", detail: error.message });
      }
    }
  }
  return { threads: [...byId.values()], sessionFiles, archivedSessionFiles, diagnostics };
}

function rolloutMetadataAlreadyKnown(thread = {}) {
  const threadSource = String(thread.threadSource || "").trim().toLowerCase();
  if (threadSource === "subagent") {
    return true;
  }
  return Boolean(
    thread.id
    && threadSource
    && thread.hasUserEvent
    && thread.title
    && thread.cwd,
  );
}

function scanCatalog(catalogPath, DatabaseSync) {
  if (!fs.existsSync(catalogPath)) {
    return {
      ok: false,
      rows: [],
      schema: { exists: false, columns: [], details: [] },
      diagnostics: [{ source: catalogPath, reason: "catalog_database_missing" }],
    };
  }
  let db;
  try {
    db = new DatabaseSync(catalogPath, { readOnly: true });
    db.exec("PRAGMA query_only = ON");
    db.exec("PRAGMA busy_timeout = 1500");
    if (!hasTable(db, "local_thread_catalog")) {
      return {
        ok: false,
        rows: [],
        schema: { exists: false, columns: [], details: [] },
        diagnostics: [{ source: catalogPath, reason: "catalog_table_missing" }],
      };
    }
    const details = tableColumnDetails(db, "local_thread_catalog");
    const columns = details.map((column) => column.name);
    if (!columns.includes("thread_id")) {
      return {
        ok: false,
        rows: [],
        schema: { exists: true, columns, details },
        diagnostics: [{ source: catalogPath, reason: "catalog_thread_id_column_missing" }],
      };
    }
    const select = [
      columns.includes("host_id") ? "host_id" : "'local' AS host_id",
      "thread_id",
      columns.includes("display_title") ? "display_title" : "thread_id AS display_title",
      columns.includes("source_created_at") ? "source_created_at" : "0 AS source_created_at",
      columns.includes("source_updated_at") ? "source_updated_at" : "0 AS source_updated_at",
      columns.includes("cwd") ? "cwd" : "'' AS cwd",
      columns.includes("source_kind") ? "source_kind" : "'' AS source_kind",
      columns.includes("source_detail") ? "source_detail" : "NULL AS source_detail",
      columns.includes("model_provider") ? "model_provider" : "'' AS model_provider",
      columns.includes("git_branch") ? "git_branch" : "NULL AS git_branch",
      columns.includes("observation_sequence") ? "observation_sequence" : "0 AS observation_sequence",
      columns.includes("missing_candidate") ? "missing_candidate" : "0 AS missing_candidate",
    ].join(", ");
    const where = columns.includes("host_id") ? " WHERE host_id = 'local'" : "";
    const rows = db.prepare(`SELECT ${select} FROM local_thread_catalog${where}`).all().map((row) => ({
      hostId: String(row.host_id || "local"),
      threadId: String(row.thread_id || ""),
      displayTitle: String(row.display_title || row.thread_id || ""),
      createdAt: normalizeTime(row.source_created_at),
      updatedAt: normalizeTime(row.source_updated_at),
      cwd: normalizePath(row.cwd),
      sourceKind: String(row.source_kind || ""),
      sourceDetail: row.source_detail ?? null,
      modelProvider: String(row.model_provider || ""),
      gitBranch: String(row.git_branch || ""),
      observationSequence: Number(row.observation_sequence || 0),
      missingCandidate: Number(row.missing_candidate || 0),
    }));
    return { ok: true, rows, schema: { exists: true, columns, details }, diagnostics: [] };
  } catch (error) {
    return {
      ok: false,
      rows: [],
      schema: { exists: false, columns: [], details: [] },
      diagnostics: [{ source: catalogPath, reason: "catalog_database_unreadable", detail: error.message }],
    };
  } finally {
    db?.close();
  }
}

function mergeThreadSources(stateThreads, rolloutThreads) {
  const merged = new Map();
  for (const thread of stateThreads) {
    merged.set(normalizeId(thread.id), { ...thread });
  }
  for (const rollout of rolloutThreads) {
    const key = normalizeId(rollout.id);
    const current = merged.get(key);
    merged.set(key, current ? mergeThread(current, rollout) : { ...rollout });
  }
  return merged;
}

function mergeThread(primary, supplemental) {
  return {
    ...supplemental,
    ...primary,
    id: primary.id || supplemental.id,
    title: primary.title || supplemental.title,
    modelProvider: primary.modelProvider || supplemental.modelProvider,
    threadSource: primary.threadSource || supplemental.threadSource,
    source: primary.source || supplemental.source,
    cwd: primary.cwd || supplemental.cwd,
    archived: Boolean(primary.archived || supplemental.archived),
    hasUserEvent: Boolean(primary.hasUserEvent || supplemental.hasUserEvent),
    rolloutPath: existingFile(primary.rolloutPath) ? primary.rolloutPath : supplemental.rolloutPath,
    createdAt: primary.createdAt || supplemental.createdAt,
    updatedAt: Math.max(primary.updatedAt || 0, supplemental.updatedAt || 0),
    gitBranch: primary.gitBranch || supplemental.gitBranch,
  };
}

function classifyThread(thread, sidebar) {
  const idKey = normalizeId(thread.id);
  const sourceText = String(thread.source || "");
  const threadSource = String(thread.threadSource || "").trim().toLowerCase();
  const subagent = threadSource === "subagent"
    || /\bsubagent\b|thread_spawn/i.test(sourceText);
  const archived = Boolean(thread.archived);
  const hasUserEvent = Boolean(thread.hasUserEvent);
  const userFacing = !subagent && hasUserEvent && (
    threadSource === "user"
    || !threadSource
  );
  const internal = !subagent && !userFacing;
  const projectPath = sidebar.projectByThread.get(idKey)
    || sidebar.workspaceHints.get(idKey)
    || normalizePath(thread.cwd);
  const rolloutPath = normalizePath(thread.rolloutPath);
  return {
    id: String(thread.id || ""),
    title: String(thread.title || thread.firstUserMessage || thread.id || "Untitled conversation"),
    modelProvider: String(thread.modelProvider || "openai"),
    threadSource,
    source: sourceText,
    sourceKind: normalizeSourceKind(sourceText),
    sourceDetail: sourceDetail(sourceText),
    cwd: projectPath,
    projectPath,
    archived,
    hasUserEvent,
    subagent,
    userFacing,
    internal,
    rolloutPath,
    rolloutExists: existingFile(rolloutPath),
    createdAt: normalizeTime(thread.createdAt),
    updatedAt: normalizeTime(thread.updatedAt || thread.createdAt),
    gitBranch: String(thread.gitBranch || ""),
  };
}

function stateSelectColumns(columns) {
  const select = (names, fallback, alias) => {
    const name = names.find((candidate) => columns.includes(candidate));
    return name ? `${quoteIdentifier(name)} AS ${quoteIdentifier(alias)}` : `${fallback} AS ${quoteIdentifier(alias)}`;
  };
  return [
    "id",
    select(["title"], "''", "title"),
    select(["model_provider"], "''", "model_provider"),
    select(["thread_source"], "''", "thread_source"),
    select(["source"], "''", "source"),
    select(["project_path", "cwd", "working_directory", "workspace", "workspace_path", "root_dir"], "''", "cwd"),
    select(["archived"], "0", "archived"),
    select(["has_user_event"], "0", "has_user_event"),
    select(["rollout_path"], "''", "rollout_path"),
    select(["created_at_ms", "created_at"], "0", "created_at"),
    select(["recency_at_ms", "updated_at_ms", "updated_at", "recency_at"], "0", "updated_at"),
    select(["git_branch"], "''", "git_branch"),
    select(["first_user_message", "preview"], "''", "first_user_message"),
  ].join(", ");
}

function normalizeStateThread(row, databasePath) {
  return {
    id: String(row.id || ""),
    title: String(row.title || row.first_user_message || row.id || ""),
    modelProvider: String(row.model_provider || ""),
    threadSource: String(row.thread_source || ""),
    source: String(row.source || ""),
    cwd: normalizePath(row.cwd),
    archived: Number(row.archived || 0) !== 0,
    hasUserEvent: Number(row.has_user_event || 0) !== 0,
    rolloutPath: normalizePath(row.rollout_path),
    createdAt: normalizeTime(row.created_at),
    updatedAt: normalizeTime(row.updated_at || row.created_at),
    gitBranch: String(row.git_branch || ""),
    firstUserMessage: String(row.first_user_message || ""),
    databasePath,
  };
}

function readRolloutMetadata(filePath, archived) {
  const stat = fs.statSync(filePath);
  const text = readUtf8Prefix(filePath, ROLLOUT_READ_LIMIT_BYTES);
  let id = "";
  let cwd = "";
  let source = "";
  let title = "";
  let hasUserEvent = false;
  let modelProvider = "";
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === "session_meta") {
      const payload = event.payload || {};
      id ||= String(payload.id || payload.thread_id || "");
      cwd ||= normalizePath(payload.cwd || payload.project_path || payload.workspace_path);
      source ||= typeof payload.source === "string" ? payload.source : JSON.stringify(payload.source || "");
      modelProvider ||= String(payload.model_provider || "");
    }
    const payload = event?.payload || {};
    if (payload?.type === "message" && payload?.role === "user") {
      hasUserEvent = true;
      title ||= messageText(payload.content).slice(0, 200);
    }
  }
  return {
    id,
    title,
    modelProvider,
    threadSource: /\bsubagent\b|thread_spawn/i.test(source) ? "subagent" : hasUserEvent ? "user" : "",
    source,
    cwd,
    archived,
    hasUserEvent,
    rolloutPath: filePath,
    createdAt: Math.floor(stat.birthtimeMs || stat.ctimeMs || 0),
    updatedAt: Math.floor(stat.mtimeMs || 0),
    gitBranch: "",
  };
}

function messageText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map((item) => String(item?.text || item?.input_text || item?.output_text || "")).filter(Boolean).join("\n");
}

function recursiveJsonlFiles(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(target);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
        files.push(target);
      }
    }
  }
  return files.sort();
}

function readUtf8Prefix(filePath, limit) {
  const handle = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(handle);
    const length = Math.min(stat.size, limit);
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, 0);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(handle);
  }
}

function sidebarSnapshot(state) {
  const projectByThread = new Map();
  const threadIds = new Set();
  const orders = state?.["sidebar-project-thread-orders"];
  if (orders && typeof orders === "object" && !Array.isArray(orders)) {
    for (const [root, ids] of Object.entries(orders)) {
      for (const id of Array.isArray(ids) ? ids : []) {
        const key = normalizeId(id);
        if (!key) {
          continue;
        }
        threadIds.add(key);
        if (!projectByThread.has(key)) {
          projectByThread.set(key, normalizePath(root));
        }
      }
    }
  }
  for (const id of Array.isArray(state?.["projectless-thread-ids"]) ? state["projectless-thread-ids"] : []) {
    const key = normalizeId(id);
    if (key) {
      threadIds.add(key);
    }
  }
  const workspaceHints = new Map();
  const hints = state?.["thread-workspace-root-hints"];
  if (hints && typeof hints === "object" && !Array.isArray(hints)) {
    for (const [id, root] of Object.entries(hints)) {
      const key = normalizeId(id);
      if (key && normalizePath(root)) {
        workspaceHints.set(key, normalizePath(root));
      }
    }
  }
  return { projectByThread, workspaceHints, threadIds };
}

function catalogRowNeedsUpdate(row, thread) {
  return row.missingCandidate !== 0
    || (!row.displayTitle && Boolean(thread.title))
    || (!row.cwd && Boolean(thread.cwd))
    || (!row.modelProvider && Boolean(thread.modelProvider));
}

function validateWritablePreview(preview) {
  if (!preview.paths.catalogPath || !fs.existsSync(preview.paths.catalogPath)) {
    throw new Error("没有找到新版 Codex 会话目录数据库 codex-dev.db。");
  }
  if (!preview.schema.exists) {
    throw new Error("新版 Codex 数据库缺少 local_thread_catalog，已停止恢复。");
  }
  const columns = new Set(preview.schema.columns);
  for (const required of CATALOG_REQUIRED_COLUMNS) {
    if (!columns.has(required)) {
      throw new Error(`local_thread_catalog 缺少必需字段 ${required}，已停止恢复。`);
    }
  }
  for (const detail of preview.schema.details || []) {
    if (detail.notnull && detail.dflt_value === null && !CATALOG_VALUE_COLUMNS.has(detail.name)) {
      throw new Error(`local_thread_catalog 出现无法安全构造的必填字段 ${detail.name}，已停止恢复。`);
    }
  }
  if (!fs.existsSync(preview.paths.statePath)) {
    throw new Error("没有找到 .codex-global-state.json，已停止恢复。");
  }
}

function createRecoveryBackup(paths) {
  const root = path.join(paths.codexDir, "codexbridge-history-recovery");
  const backupDir = path.join(root, backupTimestamp());
  fs.mkdirSync(backupDir, { recursive: true });
  const candidates = [
    paths.catalogPath,
    `${paths.catalogPath}-wal`,
    `${paths.catalogPath}-shm`,
    paths.statePath,
  ];
  const files = [];
  for (const source of candidates) {
    if (!fs.existsSync(source)) {
      continue;
    }
    const target = path.join(backupDir, path.basename(source));
    fs.copyFileSync(source, target);
    files.push({ source, target });
  }
  fs.writeFileSync(path.join(backupDir, "manifest.json"), JSON.stringify({
    version: 1,
    createdAt: new Date().toISOString(),
    files,
  }, null, 2), "utf8");
  return { backupDir, files };
}

function catalogValues(thread, observationSequence) {
  return {
    host_id: "local",
    thread_id: thread.id,
    display_title: thread.title || thread.id,
    source_created_at: sqliteSeconds(thread.createdAt),
    source_updated_at: sqliteSeconds(thread.updatedAt || thread.createdAt),
    cwd: thread.cwd || "",
    source_kind: thread.sourceKind || "vscode",
    source_detail: thread.sourceDetail,
    model_provider: thread.modelProvider || "openai",
    git_branch: thread.gitBranch || null,
    observation_sequence: observationSequence,
    missing_candidate: 0,
  };
}

function insertCatalogRow(db, columns, values) {
  const names = columns.filter((name) => CATALOG_VALUE_COLUMNS.has(name));
  db.prepare(
    `INSERT INTO local_thread_catalog (${names.map(quoteIdentifier).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
  ).run(...names.map((name) => values[name]));
}

function updateCatalogRow(db, columns, values) {
  const names = columns.filter((name) => CATALOG_VALUE_COLUMNS.has(name) && !["host_id", "thread_id"].includes(name));
  if (!names.length) {
    return;
  }
  const where = columns.includes("host_id")
    ? "host_id = ? AND thread_id = ?"
    : "thread_id = ?";
  const whereValues = columns.includes("host_id")
    ? [values.host_id, values.thread_id]
    : [values.thread_id];
  db.prepare(
    `UPDATE local_thread_catalog SET ${names.map((name) => `${quoteIdentifier(name)} = ?`).join(", ")} WHERE ${where}`,
  ).run(...names.map((name) => values[name]), ...whereValues);
}

function ensureLocalCatalogHost(db) {
  if (!hasTable(db, "local_thread_catalog_hosts")) {
    return;
  }
  const columns = tableColumnNames(db, "local_thread_catalog_hosts");
  if (columns.includes("host_id") && columns.includes("host_kind")) {
    db.prepare("INSERT OR IGNORE INTO local_thread_catalog_hosts (host_id, host_kind) VALUES ('local', 'local')").run();
  }
}

function currentObservationSequence(db) {
  if (!tableColumnNames(db, "local_thread_catalog").includes("observation_sequence")) {
    return 0;
  }
  const row = db.prepare("SELECT COALESCE(MAX(observation_sequence), 0) AS value FROM local_thread_catalog").get();
  return Number(row?.value || 0);
}

function updateCatalogBookkeeping(db, threads, observationSequence) {
  const maxUpdatedAt = Math.max(0, ...threads.map((thread) => sqliteSeconds(thread.updatedAt)));
  if (hasTable(db, "local_thread_catalog_metadata")) {
    const columns = tableColumnNames(db, "local_thread_catalog_metadata");
    if (columns.includes("id") && columns.includes("catalog_revision")) {
      db.prepare("INSERT INTO local_thread_catalog_metadata (id, catalog_revision) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET catalog_revision = catalog_revision + 1").run();
    }
  }
  if (hasTable(db, "local_thread_catalog_sync_state")) {
    const columns = tableColumnNames(db, "local_thread_catalog_sync_state");
    if (["host_id", "watermark_updated_at", "initial_build_complete", "observation_sequence"].every((name) => columns.includes(name))) {
      db.prepare([
        "INSERT INTO local_thread_catalog_sync_state",
        "(host_id, watermark_updated_at, initial_build_complete, observation_sequence)",
        "VALUES ('local', ?, 1, ?)",
        "ON CONFLICT(host_id) DO UPDATE SET",
        "watermark_updated_at = MAX(COALESCE(watermark_updated_at, 0), excluded.watermark_updated_at),",
        "initial_build_complete = 1, observation_sequence = MAX(observation_sequence, excluded.observation_sequence)",
      ].join(" ")).run(maxUpdatedAt, observationSequence);
    }
  }
}

function synchronizedGlobalState(state, threads) {
  const next = { ...state };
  const orders = state["sidebar-project-thread-orders"] && typeof state["sidebar-project-thread-orders"] === "object" && !Array.isArray(state["sidebar-project-thread-orders"])
    ? Object.fromEntries(Object.entries(state["sidebar-project-thread-orders"]).map(([root, ids]) => [root, orderedUnique(ids)]))
    : {};
  const hints = state["thread-workspace-root-hints"] && typeof state["thread-workspace-root-hints"] === "object" && !Array.isArray(state["thread-workspace-root-hints"])
    ? { ...state["thread-workspace-root-hints"] }
    : {};
  const projectless = orderedUnique(state["projectless-thread-ids"]);
  const projectlessKeys = new Set(projectless.map(normalizeId));
  const savedRoots = orderedUnique(state["electron-saved-workspace-roots"]);
  const savedRootKeys = new Set(savedRoots.map(canonicalPath));
  const existingOrderKeys = new Map(Object.keys(orders).map((root) => [canonicalPath(root), root]));
  for (const thread of threads) {
    const root = normalizePath(thread.projectPath || thread.cwd);
    if (root) {
      const rootKey = canonicalPath(root);
      const orderKey = existingOrderKeys.get(rootKey) || root;
      orders[orderKey] = orderedUnique([...(orders[orderKey] || []), thread.id]);
      existingOrderKeys.set(rootKey, orderKey);
      hints[thread.id] = root;
      if (!savedRootKeys.has(rootKey)) {
        savedRoots.push(root);
        savedRootKeys.add(rootKey);
      }
    } else if (!projectlessKeys.has(normalizeId(thread.id))) {
      projectless.push(thread.id);
      projectlessKeys.add(normalizeId(thread.id));
    }
  }
  next["sidebar-project-thread-orders"] = orders;
  next["projectless-thread-ids"] = projectless;
  next["thread-workspace-root-hints"] = hints;
  next["electron-saved-workspace-roots"] = savedRoots;
  return next;
}

function writeJsonAtomic(target, value) {
  const temp = `${target}.codexbridge-history-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, target);
}

function restoreSingleBackupFile(source, target) {
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, target);
  }
}

function readJsonObject(target) {
  if (!fs.existsSync(target)) {
    return {};
  }
  const value = JSON.parse(fs.readFileSync(target, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${target} 不是有效的 JSON 对象。`);
  }
  return value;
}

function hasTable(db, tableName) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function tableColumnNames(db, tableName) {
  return tableColumnDetails(db, tableName).map((column) => column.name);
}

function tableColumnDetails(db, tableName) {
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all();
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function normalizeSourceKind(source) {
  const value = String(source || "").trim();
  if (!value) {
    return "vscode";
  }
  if (!value.startsWith("{")) {
    return value;
  }
  try {
    const parsed = JSON.parse(value);
    return String(parsed.kind || parsed.type || Object.keys(parsed)[0] || "vscode");
  } catch {
    return "vscode";
  }
}

function sourceDetail(source) {
  const value = String(source || "").trim();
  return value.startsWith("{") ? value : null;
}

function normalizeId(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePath(value) {
  return String(value || "").replace(/^\\\\\?\\/, "").trim();
}

function canonicalPath(value) {
  return normalizePath(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function existingFile(value) {
  const target = normalizePath(value);
  if (!target) {
    return false;
  }
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function normalizeTime(value) {
  if (value === null || value === undefined || value === "") {
    return 0;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function sqliteSeconds(value) {
  const numeric = normalizeTime(value);
  return numeric > 10_000_000_000 ? numeric / 1000 : numeric;
}

function orderedUnique(values) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || "").trim();
    const key = normalizeId(text);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(text);
  }
  return result;
}

function countIntersection(left, right) {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) {
      count += 1;
    }
  }
  return count;
}

function backupTimestamp() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
}

function emitRecoveryPhase(onPhase, phase, details = {}) {
  try {
    onPhase(phase, details);
  } catch {
    // Recovery correctness must not depend on diagnostic log publication.
  }
}
