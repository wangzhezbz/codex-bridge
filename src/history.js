import { cloneJson } from "./json.js";
import { HistorySqliteStore } from "./history-sqlite.js";

export class ResponseHistory {
  constructor({
    maxEntries = 200,
    maxEntryBytes = 1_000_000,
    maxTotalBytes = 20_000_000,
    maxPendingPersistentBytes = 256 * 1024 * 1024,
    maxStagedEntries = 8,
    maxStagedBytes = maxPendingPersistentBytes,
    stagedWriteTimeoutMs = 30_000,
    historyPath = "",
    storage = null,
    ...historyOptions
  } = {}) {
    this.maxEntries = maxEntries;
    this.maxEntryBytes = maxEntryBytes;
    this.maxTotalBytes = maxTotalBytes;
    this.maxPendingPersistentBytes = maxPendingPersistentBytes;
    this.maxStagedEntries = positiveInteger(maxStagedEntries, 8);
    this.maxStagedBytes = positiveNumber(maxStagedBytes, maxPendingPersistentBytes);
    this.stagedWriteTimeoutMs = positiveNumber(stagedWriteTimeoutMs, 30_000);
    this.entries = new Map();
    this.responses = new Map();
    this.responseMeta = new Map();
    this.entrySizes = new Map();
    this.totalEntryBytes = 0;
    this.pendingPersistentEntries = new Map();
    this.pendingPersistentEntrySizes = new Map();
    this.totalPendingPersistentBytes = 0;
    this.stagedTurns = new Map();
    this.totalStagedBytes = 0;
    this.storage = storage;
    this.storageError = null;
    if (!this.storage && historyPath) {
      try {
        this.storage = new HistorySqliteStore(historyPath, historyOptions);
      } catch (error) {
        this.storageError = error;
      }
    }
  }

  get(responseId) {
    const staged = this.stagedTurns.get(responseId);
    if (staged?.turn) {
      return cloneJson(Array.isArray(staged.turn.messages) ? staged.turn.messages : []);
    }
    if (!responseId || !this.entries.has(responseId)) {
      const result = this.lookup(responseId);
      return result.state === "available" ? cloneJson(result.messages) : [];
    }
    return cloneJson(this.entries.get(responseId));
  }

  record(responseId, chatMessages) {
    if (!responseId) {
      return;
    }
    const withoutSystem = cloneJson(
      chatMessages.filter((message) => message.role !== "system"),
    );
    if (this.storage) {
      this.setPendingPersistentEntry(responseId, withoutSystem);
    }
    const bounded = trimChatMessagesToByteLimit(
      cloneJson(withoutSystem),
      this.maxEntryBytes,
    );
    this.setEntry(responseId, bounded);
    this.trim();
  }

  getResponse(responseId) {
    const staged = this.stagedTurns.get(responseId);
    if (staged?.turn?.response) {
      return cloneJson(staged.turn.response);
    }
    if (!responseId || !this.responses.has(responseId)) {
      const result = this.lookup(responseId);
      return result.state === "available" ? cloneJson(result.response) : null;
    }
    return cloneJson(this.responses.get(responseId));
  }

  getResponseMeta(responseId) {
    const staged = this.stagedTurns.get(responseId);
    if (staged?.turn) {
      return cloneJson(staged.turn.meta || {});
    }
    if (!responseId || !this.responseMeta.has(responseId)) {
      const result = this.lookup(responseId);
      return result.state === "available" ? cloneJson(result.meta) : null;
    }
    return cloneJson(this.responseMeta.get(responseId));
  }

  recordResponse(response, meta = {}) {
    if (!response?.id) {
      return;
    }
    const clonedResponse = cloneJson(response);
    const clonedMeta = cloneJson(meta || {});
    if (this.storage && this.pendingPersistentEntries.has(response.id)) {
      let pruneResult;
      try {
        pruneResult = this.storage.recordTurn({
          responseId: response.id,
          messages: this.pendingPersistentEntries.get(response.id),
          response: clonedResponse,
          meta: clonedMeta,
        });
      } catch (error) {
        throw this.handleStorageWriteError(error);
      } finally {
        this.deletePendingPersistentEntry(response.id);
      }
      this.applyPruneResult(pruneResult);
    }
    this.responses.set(response.id, clonedResponse);
    this.responseMeta.set(response.id, clonedMeta);
    this.trim();
  }

  recordTurn(turn = {}) {
    const responseId = String(turn.responseId || turn.response?.id || "").trim();
    if (!responseId) {
      return;
    }
    const messages = cloneJson(Array.isArray(turn.messages) ? turn.messages : []);
    const response = cloneJson(turn.response || null);
    const meta = cloneJson(turn.meta || {});
    this.deletePendingPersistentEntry(responseId);
    if (this.storageError) {
      throw this.storageUnavailableError();
    }
    let pruneResult;
    try {
      pruneResult = this.storage?.recordTurn({ responseId, messages, response, meta });
    } catch (error) {
      throw this.handleStorageWriteError(error);
    }
    this.setEntry(responseId, messages);
    if (response) {
      this.responses.set(responseId, response);
    }
    this.responseMeta.set(responseId, meta);
    this.trim();
    this.applyPruneResult(pruneResult);
  }

  async recordTurnAsync(turn = {}) {
    if (!this.storage?.recordTurnAsync) {
      return this.recordTurn(turn);
    }
    const responseId = String(turn.responseId || turn.response?.id || "").trim();
    if (!responseId) {
      return;
    }
    this.deletePendingPersistentEntry(responseId);
    if (this.storageError) {
      throw this.storageUnavailableError();
    }
    let pruneResult;
    try {
      pruneResult = await this.storage.recordTurnAsync(turn);
    } catch (error) {
      throw this.handleStorageWriteError(error);
    }
    const messages = Array.isArray(turn.messages) ? turn.messages : [];
    const response = turn.response || null;
    const meta = turn.meta || {};
    this.setEntry(
      responseId,
      messages,
      Number(pruneResult?.recordBytes?.messages),
    );
    if (response) {
      this.responses.set(responseId, response);
    }
    this.responseMeta.set(responseId, meta);
    this.trim();
    this.applyPruneResult(pruneResult);
  }

  stageTurn(turn = {}) {
    const responseId = String(turn.responseId || turn.response?.id || "").trim();
    if (!responseId) {
      return "";
    }
    const existing = this.stagedTurns.get(responseId);
    if (existing) {
      return responseId;
    }
    const estimatedBytes = boundedValueBytes(turn, this.maxStagedBytes + 1);
    if (
      this.stagedTurns.size >= this.maxStagedEntries ||
      this.totalStagedBytes + estimatedBytes > this.maxStagedBytes
    ) {
      throw stagedHistoryError(
        "history_stage_budget_exceeded",
        "Pending response history exceeds its bounded staging budget.",
      );
    }
    this.stagedTurns.set(responseId, {
      turn,
      promise: null,
      writePromise: null,
      error: null,
      estimatedBytes,
    });
    this.totalStagedBytes += estimatedBytes;
    return responseId;
  }

  persistStagedTurnAsync(responseId) {
    const staged = this.stagedTurns.get(responseId);
    if (!staged) {
      return Promise.resolve();
    }
    if (staged.promise) {
      return staged.promise;
    }
    // Defer only to the microtask boundary: the HTTP terminal is written by the
    // caller in the current stack, while persistence is handed to the worker
    // before a later shutdown signal or I/O turn can overtake it.
    const writePromise = Promise.resolve()
      .then(() => this.recordTurnAsync(staged.turn));
    staged.writePromise = writePromise;
    let timeoutId;
    const monitoredWrite = new Promise((resolve, reject) => {
      timeoutId = setTimeout(() => reject(stagedHistoryError(
        "history_write_timeout",
        "Response history persistence exceeded its bounded time budget.",
      )), this.stagedWriteTimeoutMs);
      writePromise.then(resolve, reject);
    }).finally(() => clearTimeout(timeoutId));
    staged.promise = monitoredWrite
      .then((result) => {
        this.deleteStagedTurn(responseId);
        return result;
      })
      .catch((error) => {
        staged.error = error;
        throw error;
      });
    writePromise.then(
      () => {
        if (staged.error?.internalCode === "history_write_timeout") {
          this.deleteStagedTurn(responseId);
        }
      },
      () => {},
    );
    return staged.promise;
  }

  lookup(responseId) {
    if (!responseId) {
      return unavailableResult("missing", "memory");
    }
    const staged = this.stagedTurns.get(responseId);
    if (staged?.turn) {
      return {
        state: "available",
        messages: cloneJson(Array.isArray(staged.turn.messages) ? staged.turn.messages : []),
        response: cloneJson(staged.turn.response || null),
        meta: cloneJson(staged.turn.meta || {}),
        source: "memory",
        pendingPersistence: !staged.error,
      };
    }
    if (
      this.entries.has(responseId) ||
      this.responses.has(responseId) ||
      this.responseMeta.has(responseId)
    ) {
      const touch = this.storage?.touch?.(responseId);
      if (touch && !["available", "missing"].includes(touch.state)) {
        this.deleteEntry(responseId);
        return cloneJson(touch);
      }
      return {
        state: "available",
        messages: cloneJson(this.entries.get(responseId) || []),
        response: cloneJson(this.responses.get(responseId) || null),
        meta: this.responseMeta.has(responseId)
          ? cloneJson(this.responseMeta.get(responseId))
          : null,
        source: "memory",
      };
    }
    if (this.storageError) {
      return {
        ...unavailableResult("storage_unavailable", "sqlite"),
        error: this.storageError?.message || String(this.storageError),
      };
    }
    if (!this.storage) {
      return unavailableResult("missing", "memory");
    }
    const result = this.storage.lookup(responseId);
    if (result.state === "available") {
      this.setEntry(responseId, cloneJson(result.messages || []));
      if (result.response) {
        this.responses.set(responseId, cloneJson(result.response));
      }
      this.responseMeta.set(responseId, cloneJson(result.meta || {}));
      this.trim();
    }
    return cloneJson(result);
  }

  prune() {
    return this.storage?.prune?.() || { ok: true };
  }

  health() {
    if (this.storageError) {
      return {
        ok: false,
        persistent: true,
        state: "storage_unavailable",
        error: this.storageError?.message || String(this.storageError),
      };
    }
    try {
      return this.storage?.health?.() || { ok: true, persistent: false };
    } catch (error) {
      return {
        ok: false,
        persistent: Boolean(this.storage),
        state: "storage_unavailable",
        error: error?.message || String(error),
      };
    }
  }

  close() {
    this.storage?.close?.();
    this.pendingPersistentEntries.clear();
    this.pendingPersistentEntrySizes.clear();
    this.totalPendingPersistentBytes = 0;
    this.stagedTurns.clear();
    this.totalStagedBytes = 0;
  }

  storageUnavailableError(cause = this.storageError) {
    const error = new Error(
      cause?.message || "Local response history storage is unavailable.",
    );
    error.code = "local_history_storage_unavailable";
    error.statusCode = 503;
    error.localHistoryError = true;
    if (cause) {
      error.cause = cause;
      error.internalCode = cause.code || cause.errcode || "";
    }
    return error;
  }

  handleStorageWriteError(error) {
    if (isPersistentStorageFailure(error)) {
      this.storageError = error;
    }
    return this.storageUnavailableError(error);
  }

  applyPruneResult(result = {}) {
    for (const responseId of [
      ...(result?.expiredIds || []),
      ...(result?.evictedIds || []),
    ]) {
      this.deleteEntry(responseId);
    }
  }

  setEntry(responseId, messages, knownSize = NaN) {
    const previousSize = this.entrySizes.get(responseId) || 0;
    const nextSize = Number.isFinite(knownSize) && knownSize >= 0
      ? knownSize
      : byteSize(messages);
    this.entries.set(responseId, messages);
    this.entrySizes.set(responseId, nextSize);
    this.totalEntryBytes += nextSize - previousSize;
  }

  setPendingPersistentEntry(responseId, messages) {
    const previousSize = this.pendingPersistentEntrySizes.get(responseId) || 0;
    const nextSize = byteSize(messages);
    const nextTotal = this.totalPendingPersistentBytes - previousSize + nextSize;
    if (
      (!this.pendingPersistentEntries.has(responseId) &&
        this.pendingPersistentEntries.size >= this.maxEntries) ||
      nextTotal > this.maxPendingPersistentBytes
    ) {
      const error = new Error(
        "Pending persistent response history exceeds its bounded memory budget.",
      );
      error.code = "local_history_storage_unavailable";
      error.statusCode = 503;
      error.localHistoryError = true;
      throw error;
    }
    this.pendingPersistentEntries.set(responseId, messages);
    this.pendingPersistentEntrySizes.set(responseId, nextSize);
    this.totalPendingPersistentBytes = nextTotal;
  }

  deletePendingPersistentEntry(responseId) {
    this.pendingPersistentEntries.delete(responseId);
    this.totalPendingPersistentBytes -=
      this.pendingPersistentEntrySizes.get(responseId) || 0;
    this.pendingPersistentEntrySizes.delete(responseId);
  }

  deleteEntry(responseId) {
    this.entries.delete(responseId);
    this.responses.delete(responseId);
    this.responseMeta.delete(responseId);
    this.totalEntryBytes -= this.entrySizes.get(responseId) || 0;
    this.entrySizes.delete(responseId);
    this.deleteStagedTurn(responseId);
  }

  deleteResponse(responseId) {
    this.responses.delete(responseId);
    this.responseMeta.delete(responseId);
    if (this.entries.has(responseId)) {
      this.entries.delete(responseId);
      this.totalEntryBytes -= this.entrySizes.get(responseId) || 0;
      this.entrySizes.delete(responseId);
    }
    this.deleteStagedTurn(responseId);
  }

  deleteStagedTurn(responseId) {
    const staged = this.stagedTurns.get(responseId);
    if (!staged) {
      return false;
    }
    this.stagedTurns.delete(responseId);
    this.totalStagedBytes = Math.max(
      0,
      this.totalStagedBytes - Number(staged.estimatedBytes || 0),
    );
    return true;
  }

  trim() {
    while (this.entries.size > this.maxEntries || this.totalEntryBytes > this.maxTotalBytes) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) {
        break;
      }
      this.deleteEntry(oldest);
    }
    while (this.responses.size > this.maxEntries) {
      const oldest = this.responses.keys().next().value;
      if (!oldest) {
        break;
      }
      this.deleteResponse(oldest);
    }
    while (this.responseMeta.size > this.maxEntries) {
      const oldest = this.responseMeta.keys().next().value;
      if (!oldest) {
        break;
      }
      this.responseMeta.delete(oldest);
    }
  }
}

function unavailableResult(state, source) {
  return {
    state,
    messages: [],
    response: null,
    meta: null,
    source,
  };
}

function trimChatMessagesToByteLimit(messages, maxBytes) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return messages;
  }
  const result = Array.isArray(messages) ? messages : [];
  while (result.length > 1 && byteSize(result) > maxBytes) {
    result.shift();
  }
  if (byteSize(result) <= maxBytes) {
    return result;
  }
  return result.map((message) => trimMessageToByteLimit(message, maxBytes));
}

function trimMessageToByteLimit(message, maxBytes) {
  const trimmed = cloneJson(message);
  const budget = Math.max(64, Math.floor(maxBytes / 2));
  trimContentFields(trimmed, budget);
  return byteSize([trimmed]) <= maxBytes
    ? trimmed
    : {
        role: trimmed.role || "assistant",
        content: "[CodexBridge omitted oversized history message]",
      };
}

function trimContentFields(value, maxChars) {
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string" && raw.length > maxChars) {
      value[key] = `${raw.slice(0, Math.floor(maxChars / 2))}\n[CodexBridge omitted oversized history content]\n${raw.slice(-Math.floor(maxChars / 2))}`;
      continue;
    }
    if (Array.isArray(raw)) {
      raw.forEach((item) => trimContentFields(item, maxChars));
      continue;
    }
    if (raw && typeof raw === "object") {
      trimContentFields(raw, maxChars);
    }
  }
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function positiveInteger(value, fallback) {
  return Math.max(1, Math.floor(positiveNumber(value, fallback)));
}

function stagedHistoryError(internalCode, message) {
  const error = new Error(message);
  error.code = "local_history_storage_unavailable";
  error.internalCode = internalCode;
  error.statusCode = 503;
  error.localHistoryError = true;
  return error;
}

function boundedValueBytes(value, limit, seen = new WeakSet()) {
  let total = 0;
  const add = (bytes) => {
    total = Math.min(limit, total + Math.max(0, Number(bytes) || 0));
  };
  const visit = (item) => {
    if (total >= limit) {
      return;
    }
    if (item === null || item === undefined) {
      add(4);
      return;
    }
    if (typeof item === "string") {
      add(Buffer.byteLength(item, "utf8") + 2);
      return;
    }
    if (typeof item === "number" || typeof item === "bigint") {
      add(24);
      return;
    }
    if (typeof item === "boolean") {
      add(5);
      return;
    }
    if (typeof item !== "object") {
      add(8);
      return;
    }
    if (seen.has(item)) {
      return;
    }
    seen.add(item);
    add(2);
    if (Array.isArray(item)) {
      for (const entry of item) {
        visit(entry);
        add(1);
        if (total >= limit) break;
      }
      return;
    }
    for (const [key, entry] of Object.entries(item)) {
      add(Buffer.byteLength(key, "utf8") + 3);
      visit(entry);
      add(1);
      if (total >= limit) break;
    }
  };
  visit(value);
  return total;
}

function byteSize(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

function isPersistentStorageFailure(error) {
  if (
    error?.localHistoryError ||
    [
      "local_history_storage_unavailable",
      "unsupported_history_schema",
      "history_storage_corrupt",
    ].includes(error?.code)
  ) {
    return true;
  }
  const text = [
    error?.code,
    error?.errcode,
    error?.sqliteCode,
    error?.message || error,
  ].filter(Boolean).join(" ");
  return /SQLITE_(?:FULL|CORRUPT|NOTADB|IOERR|CANTOPEN|READONLY)|database disk image is malformed|not a database|database is not open|database or disk is full|disk I\/O error|readonly database/i.test(
    text,
  );
}
