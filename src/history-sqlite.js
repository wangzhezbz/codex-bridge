import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

const SCHEMA_VERSION = 1;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// A Responses request may legally approach the Router's 100 MiB request limit,
// and one durable turn also contains the provider response plus its replayable
// assistant history. Keep enough headroom so a successful upstream response is
// not rejected only because the local durable representation is larger.
const DEFAULT_MAX_RECORD_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_PROTECT_RECENT_MS = 60 * 60 * 1000;
const DEFAULT_TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TOMBSTONES = 10_000;
const DEFAULT_MAX_TOMBSTONE_BYTES = 16 * 1024 * 1024;
const DEFAULT_INCREMENTAL_VACUUM_PAGES = 128;
const DEFAULT_WAL_AUTOCHECKPOINT_PAGES = 64;
const DEFAULT_JOURNAL_SIZE_LIMIT_BYTES = 512 * 1024;
const SAFE_META_KEYS = new Set([
  "api",
  "routeId",
  "upstreamModel",
  "upstreamKnown",
  "userInputSignatures",
  "userInputCount",
  "hasOpaqueUserInput",
  "toolContinuationTurns",
  "noProgressToolLoopTurns",
  "toolCallSignatures",
  "toolResultSignatures",
  "localFallback",
  "parentResponseId",
  "routeSnapshot",
]);
const SAFE_ROUTE_SNAPSHOT_KEYS = new Set([
  "version",
  "id",
  "provider",
  "api",
  "model",
  "baseUrl",
  "authMode",
  "apiKeyEnv",
  "contextPolicy",
  "credentialSource",
  "requiresCustomHeaders",
  "dropParams",
  "compactContract",
  // Legacy Task 2 snapshots remain readable, but the Task 4 resolver rejects
  // them for cross-route compaction because they have no snapshot version.
  "contextWindow",
]);
const SAFE_CONTEXT_POLICY_KEYS = new Set([
  "version",
  "policyId",
  "upstreamContextWindow",
  "contextWindow",
  "inputBudget",
  "compactThreshold",
  "outputReserveTokens",
  "effectiveContextWindowPercent",
  "autoCompactPercent",
  "truncationPolicy",
]);
const SAFE_TRUNCATION_POLICY_KEYS = new Set(["mode", "limit"]);
const SAFE_COMPACT_CONTRACT_KEYS = new Set([
  "version",
  "contractId",
  "mode",
  "strategy",
  "requiresStream",
  "retryWithStream",
  "fallback",
]);

export class HistorySqliteStore {
  constructor(historyPath, options = {}) {
    this.path = path.resolve(historyPath);
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.ttlMs = positiveNumber(options.ttlMs, DEFAULT_TTL_MS);
    this.maxRecordBytes = positiveNumber(
      options.maxRecordBytes,
      DEFAULT_MAX_RECORD_BYTES,
    );
    this.maxBytes = positiveNumber(
      options.maxBytes ?? options.maxDiskBytes,
      DEFAULT_MAX_BYTES,
    );
    this.protectRecentMs = positiveNumber(
      options.protectRecentMs,
      DEFAULT_PROTECT_RECENT_MS,
    );
    this.tombstoneTtlMs = positiveNumber(
      options.tombstoneTtlMs,
      DEFAULT_TOMBSTONE_TTL_MS,
    );
    this.maxTombstones = positiveInteger(
      options.maxTombstones,
      DEFAULT_MAX_TOMBSTONES,
    );
    this.maxTombstoneBytes = positiveNumber(
      options.maxTombstoneBytes,
      DEFAULT_MAX_TOMBSTONE_BYTES,
    );
    this.incrementalVacuumPages = positiveInteger(
      options.incrementalVacuumPages,
      DEFAULT_INCREMENTAL_VACUUM_PAGES,
    );
    this.walAutocheckpointPages = positiveInteger(
      options.walAutocheckpointPages,
      DEFAULT_WAL_AUTOCHECKPOINT_PAGES,
    );
    this.journalSizeLimitBytes = positiveNumber(
      options.journalSizeLimitBytes,
      DEFAULT_JOURNAL_SIZE_LIMIT_BYTES,
    );
    this.writer = null;
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path, { timeout: 5000 });
    try {
      this.db.exec("PRAGMA busy_timeout = 5000");
      const version = Number(this.db.prepare("PRAGMA user_version").get().user_version || 0);
      if (version > SCHEMA_VERSION) {
        throw historyStorageError(
          "unsupported_history_schema",
          `Response history schema ${version} is newer than supported version ${SCHEMA_VERSION}.`,
        );
      }
      if (version === 0) {
        this.db.exec("PRAGMA auto_vacuum = INCREMENTAL");
      }
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
      this.db.exec(`PRAGMA wal_autocheckpoint = ${this.walAutocheckpointPages}`);
      this.db.exec(`PRAGMA journal_size_limit = ${this.journalSizeLimitBytes}`);
      if (version === 0) {
        this.db.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE IF NOT EXISTS response_history (
            response_id TEXT PRIMARY KEY,
            messages_gzip BLOB NOT NULL,
            response_gzip BLOB NOT NULL,
            meta_gzip BLOB NOT NULL,
            uncompressed_bytes INTEGER NOT NULL,
            stored_bytes INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            accessed_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS response_history_expiry
            ON response_history(expires_at, accessed_at);
          CREATE TABLE IF NOT EXISTS response_history_tombstones (
            response_id TEXT PRIMARY KEY,
            reason TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );
          PRAGMA user_version = 1;
          COMMIT;
        `);
      }
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      this.db.close();
      this.db = null;
      throw error;
    }
  }

  recordTurn(turn = {}, nowOverride = NaN) {
    const responseId = String(turn.responseId || turn.response?.id || "").trim();
    if (!responseId) {
      return;
    }
    const messages = encodeJson(turn.messages || []);
    const response = encodeJson(turn.response || null);
    const meta = encodeJson(sanitizeMeta(turn.meta || {}));
    const uncompressedBytes =
      messages.uncompressedBytes + response.uncompressedBytes + meta.uncompressedBytes;
    if (uncompressedBytes > this.maxRecordBytes) {
      throw historyStorageError(
        "history_record_too_large",
        `Response history record exceeds ${this.maxRecordBytes} bytes.`,
      );
    }
    const storedBytes = messages.buffer.length + response.buffer.length + meta.buffer.length;
    const now = Number.isFinite(nowOverride)
      ? Number(nowOverride)
      : Number(this.now());
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO response_history (
          response_id, messages_gzip, response_gzip, meta_gzip,
          uncompressed_bytes, stored_bytes,
          created_at, updated_at, accessed_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(response_id) DO UPDATE SET
          messages_gzip = excluded.messages_gzip,
          response_gzip = excluded.response_gzip,
          meta_gzip = excluded.meta_gzip,
          uncompressed_bytes = excluded.uncompressed_bytes,
          stored_bytes = excluded.stored_bytes,
          updated_at = excluded.updated_at,
          accessed_at = excluded.accessed_at,
          expires_at = excluded.expires_at
      `).run(
        responseId,
        messages.buffer,
        response.buffer,
        meta.buffer,
        uncompressedBytes,
        storedBytes,
        now,
        now,
        now,
        now + this.ttlMs,
      );
      const tombstoneDelete = this.db.prepare(
        "DELETE FROM response_history_tombstones WHERE response_id = ?",
      ).run(responseId);
      const pruneResult = this.pruneInTransaction(responseId, now);
      this.db.exec("COMMIT");
      this.maintainAfterPrune({
        ...pruneResult,
        tombstonesDeleted:
          pruneResult.tombstonesDeleted + Number(tombstoneDelete.changes || 0),
      });
      return {
        ...pruneResult,
        recordBytes: {
          messages: messages.uncompressedBytes,
          response: response.uncompressedBytes,
          meta: meta.uncompressedBytes,
        },
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordTurnAsync(turn = {}) {
    if (!this.db) {
      return Promise.reject(historyStorageError(
        "history_storage_closed",
        "Response history database is not open.",
      ));
    }
    if (!this.writer) {
      this.writer = new HistorySqliteWriter(this.path, {
        ttlMs: this.ttlMs,
        maxRecordBytes: this.maxRecordBytes,
        maxBytes: this.maxBytes,
        protectRecentMs: this.protectRecentMs,
        tombstoneTtlMs: this.tombstoneTtlMs,
        maxTombstones: this.maxTombstones,
        maxTombstoneBytes: this.maxTombstoneBytes,
        incrementalVacuumPages: this.incrementalVacuumPages,
        walAutocheckpointPages: this.walAutocheckpointPages,
        journalSizeLimitBytes: this.journalSizeLimitBytes,
      });
    }
    return this.writer.recordTurn(turn, Number(this.now()));
  }

  lookup(responseId) {
    if (!responseId) {
      return missingResult("missing");
    }
    try {
      const row = this.db.prepare(
        "SELECT * FROM response_history WHERE response_id = ?",
      ).get(responseId);
      if (!row) {
        const tombstone = this.db.prepare(
          "SELECT reason FROM response_history_tombstones WHERE response_id = ?",
        ).get(responseId);
        return missingResult(tombstone?.reason || "missing");
      }
      const now = Number(this.now());
      if (Number(row.expires_at) <= now) {
        this.db.exec("BEGIN IMMEDIATE");
        let pruneResult;
        try {
          this.deleteWithTombstone(responseId, "expired", now);
          pruneResult = this.pruneTombstonesInTransaction(now);
          this.db.exec("COMMIT");
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
        this.maintainAfterPrune({
          expiredIds: [responseId],
          evictedIds: [],
          ...pruneResult,
        });
        return missingResult("expired");
      }
      let messages;
      let response;
      let meta;
      try {
        messages = decodeJson(row.messages_gzip);
        response = decodeJson(row.response_gzip);
        meta = decodeJson(row.meta_gzip);
      } catch {
        return missingResult("corrupt");
      }
      this.db.prepare(`
        UPDATE response_history
        SET accessed_at = ?, expires_at = ?
        WHERE response_id = ?
      `).run(now, now + this.ttlMs, responseId);
      return {
        state: "available",
        messages,
        response,
        meta,
        source: "sqlite",
        uncompressedBytes: Number(row.uncompressed_bytes),
        storedBytes: Number(row.stored_bytes),
      };
    } catch (error) {
      return {
        ...missingResult("storage_unavailable"),
        error: error?.message || String(error),
      };
    }
  }

  touch(responseId) {
    if (!responseId) {
      return missingResult("missing");
    }
    try {
      const row = this.db.prepare(
        "SELECT expires_at FROM response_history WHERE response_id = ?",
      ).get(responseId);
      if (!row) {
        const tombstone = this.db.prepare(
          "SELECT reason FROM response_history_tombstones WHERE response_id = ?",
        ).get(responseId);
        return missingResult(tombstone?.reason || "missing");
      }
      const now = Number(this.now());
      if (Number(row.expires_at) <= now) {
        this.db.exec("BEGIN IMMEDIATE");
        let pruneResult;
        try {
          this.deleteWithTombstone(responseId, "expired", now);
          pruneResult = this.pruneTombstonesInTransaction(now);
          this.db.exec("COMMIT");
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
        this.maintainAfterPrune({
          expiredIds: [responseId],
          evictedIds: [],
          ...pruneResult,
        });
        return missingResult("expired");
      }
      this.db.prepare(`
        UPDATE response_history SET accessed_at = ?, expires_at = ? WHERE response_id = ?
      `).run(now, now + this.ttlMs, responseId);
      return { state: "available", source: "sqlite" };
    } catch (error) {
      return {
        ...missingResult("storage_unavailable"),
        error: error?.message || String(error),
      };
    }
  }

  prune() {
    const now = Number(this.now());
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.pruneInTransaction("", now);
      this.db.exec("COMMIT");
      this.maintainAfterPrune(result);
      return { ok: true, ...result };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  health() {
    if (!this.db) {
      return { ok: false, closed: true };
    }
    try {
      const pageCount = pragmaNumber(this.db, "page_count");
      const pageSize = pragmaNumber(this.db, "page_size");
      const freelistCount = pragmaNumber(this.db, "freelist_count");
      const autoVacuumValue = pragmaNumber(this.db, "auto_vacuum");
      const tombstones = this.tombstoneMetrics();
      const databaseFileBytes = fileSize(this.path);
      const walFileBytes = fileSize(`${this.path}-wal`);
      const shmFileBytes = fileSize(`${this.path}-shm`);
      return {
        ok: true,
        persistent: true,
        path: this.path,
        schemaVersion: Number(this.db.prepare("PRAGMA user_version").get().user_version || 0),
        journalMode: String(this.db.prepare("PRAGMA journal_mode").get().journal_mode || ""),
        autoVacuum: autoVacuumName(autoVacuumValue),
        pageCount,
        pageSize,
        freelistCount,
        databaseBytes: pageCount * pageSize,
        livePageBytes: Math.max(0, pageCount - freelistCount) * pageSize,
        databaseFileBytes,
        walFileBytes,
        shmFileBytes,
        sqliteFileBytes: databaseFileBytes + walFileBytes + shmFileBytes,
        tombstoneCount: tombstones.count,
        tombstoneBytes: tombstones.bytes,
        maxTombstones: this.maxTombstones,
        maxTombstoneBytes: this.maxTombstoneBytes,
        storedBytes: Number(
          this.db.prepare(
            "SELECT COALESCE(SUM(stored_bytes), 0) AS total FROM response_history",
          ).get().total || 0,
        ),
        maxBytes: this.maxBytes,
      };
    } catch (error) {
      return {
        ok: false,
        persistent: true,
        state: "storage_unavailable",
        error: error?.message || String(error),
      };
    }
  }

  close() {
    this.writer?.close();
    this.writer = null;
    if (!this.db) {
      return;
    }
    this.db.close();
    this.db = null;
  }

  pruneInTransaction(protectedResponseId, now) {
    const expiredIds = [];
    const evictedIds = [];
    const expired = this.db.prepare(`
      SELECT response_id FROM response_history
      WHERE expires_at <= ? AND response_id <> ?
      ORDER BY expires_at ASC
    `).all(now, protectedResponseId);
    for (const row of expired) {
      const responseId = String(row.response_id);
      this.deleteWithTombstone(responseId, "expired", now);
      expiredIds.push(responseId);
    }
    let storedBytes = Number(
      this.db.prepare(
        "SELECT COALESCE(SUM(stored_bytes), 0) AS total FROM response_history",
      ).get().total || 0,
    );
    if (storedBytes > this.maxBytes) {
      const coldRows = this.db.prepare(`
        SELECT response_id, stored_bytes FROM response_history
        WHERE response_id <> ? AND accessed_at < ?
        ORDER BY accessed_at ASC, updated_at ASC
      `).all(protectedResponseId, now - this.protectRecentMs);
      for (const row of coldRows) {
        if (storedBytes <= this.maxBytes) {
          break;
        }
        const responseId = String(row.response_id);
        this.deleteWithTombstone(responseId, "evicted", now);
        storedBytes -= Number(row.stored_bytes || 0);
        evictedIds.push(responseId);
      }
    }
    const tombstones = this.pruneTombstonesInTransaction(now);
    return {
      expiredIds,
      evictedIds,
      storedBytes,
      softOverflowBytes: Math.max(0, storedBytes - this.maxBytes),
      ...tombstones,
    };
  }

  pruneTombstonesInTransaction(now) {
    let tombstonesDeleted = Number(this.db.prepare(`
      DELETE FROM response_history_tombstones
      WHERE created_at <= ?
    `).run(now - this.tombstoneTtlMs).changes || 0);
    const rows = this.db.prepare(`
      SELECT
        response_id,
        length(CAST(response_id AS BLOB))
          + length(CAST(reason AS BLOB)) + 16 AS estimated_bytes
      FROM response_history_tombstones
      ORDER BY created_at ASC, response_id ASC
    `).all();
    let count = rows.length;
    let bytes = rows.reduce(
      (total, row) => total + Number(row.estimated_bytes || 0),
      0,
    );
    const deleteTombstone = this.db.prepare(
      "DELETE FROM response_history_tombstones WHERE response_id = ?",
    );
    for (const row of rows) {
      if (count <= this.maxTombstones && bytes <= this.maxTombstoneBytes) {
        break;
      }
      deleteTombstone.run(row.response_id);
      count -= 1;
      bytes -= Number(row.estimated_bytes || 0);
      tombstonesDeleted += 1;
    }
    return {
      tombstonesDeleted,
      tombstoneCount: count,
      tombstoneBytes: Math.max(0, bytes),
    };
  }

  tombstoneMetrics() {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS count,
        COALESCE(SUM(
          length(CAST(response_id AS BLOB))
            + length(CAST(reason AS BLOB)) + 16
        ), 0) AS bytes
      FROM response_history_tombstones
    `).get();
    return {
      count: Number(row.count || 0),
      bytes: Number(row.bytes || 0),
    };
  }

  maintainAfterPrune(result = {}) {
    const deletedRows =
      (result.expiredIds?.length || 0) + (result.evictedIds?.length || 0);
    if (deletedRows === 0 && Number(result.tombstonesDeleted || 0) === 0) {
      return;
    }
    try {
      this.db.exec(`PRAGMA incremental_vacuum(${this.incrementalVacuumPages})`);
      this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
      if (fileSize(`${this.path}-wal`) > this.journalSizeLimitBytes) {
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      }
    } catch {
      // Reclamation is best-effort. Row and tombstone bounds were committed above.
    }
  }

  deleteWithTombstone(responseId, reason, now) {
    this.db.prepare("DELETE FROM response_history WHERE response_id = ?").run(responseId);
    this.db.prepare(`
      INSERT INTO response_history_tombstones(response_id, reason, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(response_id) DO UPDATE SET
        reason = excluded.reason,
        created_at = excluded.created_at
    `).run(responseId, reason, now);
  }
}

class HistorySqliteWriter {
  constructor(historyPath, options) {
    this.nextRequestId = 1;
    this.pending = new Map();
    this.closed = false;
    this.closing = false;
    this.worker = new Worker(new URL("./history-sqlite-worker.js", import.meta.url), {
      workerData: { historyPath, options },
    });
    this.worker.on("message", (message) => this.handleMessage(message));
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", (code) => {
      if (!this.closing) {
        this.fail(new Error(`Response history writer exited with code ${code}.`));
      }
    });
  }

  recordTurn(turn, now) {
    if (this.closed) {
      return Promise.reject(historyStorageError(
        "history_storage_closed",
        "Response history writer is closed.",
      ));
    }
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      try {
        this.worker.postMessage({ type: "record_turn", requestId, turn, now });
      } catch (error) {
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  handleMessage(message = {}) {
    if (message.type !== "record_turn_result") {
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) {
      return;
    }
    this.pending.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(historyWorkerError(message.error));
  }

  fail(error) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closing = true;
    const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    try {
      this.worker.postMessage({ type: "close", signal });
      Atomics.wait(signal, 0, 0, 5_000);
    } catch {}
    void this.worker.terminate();
    const error = historyStorageError(
      "history_storage_closed",
      "Response history writer closed before the write completed.",
    );
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function historyWorkerError(value = {}) {
  const error = new Error(value.message || "Response history worker failed.");
  for (const key of [
    "name",
    "code",
    "errcode",
    "sqliteCode",
    "statusCode",
    "localHistoryError",
    "internalCode",
  ]) {
    if (value[key] !== undefined) {
      error[key] = value[key];
    }
  }
  if (value.stack) {
    error.stack = value.stack;
  }
  return error;
}

function encodeJson(value) {
  const json = JSON.stringify(value ?? null);
  return {
    buffer: zlib.gzipSync(Buffer.from(json, "utf8")),
    uncompressedBytes: Buffer.byteLength(json, "utf8"),
  };
}

function decodeJson(value) {
  return JSON.parse(zlib.gunzipSync(Buffer.from(value)).toString("utf8"));
}

function sanitizeMeta(value) {
  if (!value || typeof value !== "object") {
    return {};
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!SAFE_META_KEYS.has(key)) {
      continue;
    }
    result[key] = key === "routeSnapshot"
      ? sanitizeRouteSnapshot(item)
      : sanitizeMetaValue(item);
  }
  return result;
}

function sanitizeRouteSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      !SAFE_ROUTE_SNAPSHOT_KEYS.has(key) ||
      (key !== "credentialSource" && isSecretMetadataKey(key))
    ) {
      continue;
    }
    if (key === "baseUrl" && typeof item === "string") {
      result[key] = sanitizeBaseUrl(item);
      continue;
    }
    if (key === "contextPolicy") {
      result[key] = sanitizeContextPolicy(item);
      continue;
    }
    if (key === "compactContract") {
      result[key] = sanitizeAllowedObject(item, SAFE_COMPACT_CONTRACT_KEYS);
      continue;
    }
    if (key === "credentialSource") {
      result[key] = ["environment", "codex_client_auth", "inline", "url", "unavailable"]
        .includes(item) ? item : "unavailable";
      continue;
    }
    result[key] = sanitizeMetaValue(item);
  }
  return result;
}

function sanitizeContextPolicy(value) {
  const result = sanitizeAllowedObject(value, SAFE_CONTEXT_POLICY_KEYS, {
    truncationPolicy: (item) => sanitizeAllowedObject(
      item,
      SAFE_TRUNCATION_POLICY_KEYS,
    ),
  });
  return result;
}

function sanitizeAllowedObject(value, allowedKeys, handlers = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowedKeys.has(key)) {
      continue;
    }
    result[key] = typeof handlers[key] === "function"
      ? handlers[key](item)
      : sanitizeMetaValue(item);
  }
  return result;
}

function sanitizeMetaValue(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeMetaValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSecretMetadataKey(key)) {
      continue;
    }
    result[key] = key.toLowerCase() === "baseurl" && typeof item === "string"
      ? sanitizeBaseUrl(item)
      : sanitizeMetaValue(item);
  }
  return result;
}

function isSecretMetadataKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (["apikeyenv", "authmode"].includes(normalized)) {
    return false;
  }
  return normalized === "key" ||
    /apikey|accesstoken|bearertoken|authorization|credential|password|secret|token/.test(
      normalized,
    );
}

function sanitizeBaseUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (isSecretMetadataKey(key)) {
        url.searchParams.delete(key);
      }
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return String(value).replace(/\/\/[^/@\s]+@/, "//").split("?")[0];
  }
}

function missingResult(state) {
  return {
    state,
    messages: [],
    response: null,
    meta: null,
    source: "sqlite",
  };
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function pragmaNumber(db, name) {
  const row = db.prepare(`PRAGMA ${name}`).get() || {};
  return Number(row[name] || 0);
}

function autoVacuumName(value) {
  if (value === 2) {
    return "incremental";
  }
  if (value === 1) {
    return "full";
  }
  return "none";
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function historyStorageError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
