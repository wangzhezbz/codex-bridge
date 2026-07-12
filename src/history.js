import { cloneJson } from "./json.js";
import { HistorySqliteStore } from "./history-sqlite.js";

export class ResponseHistory {
  constructor({
    maxEntries = 200,
    maxEntryBytes = 1_000_000,
    maxTotalBytes = 20_000_000,
    maxPendingPersistentBytes = 100 * 1024 * 1024,
    historyPath = "",
    storage = null,
    ...historyOptions
  } = {}) {
    this.maxEntries = maxEntries;
    this.maxEntryBytes = maxEntryBytes;
    this.maxTotalBytes = maxTotalBytes;
    this.maxPendingPersistentBytes = maxPendingPersistentBytes;
    this.entries = new Map();
    this.responses = new Map();
    this.responseMeta = new Map();
    this.entrySizes = new Map();
    this.totalEntryBytes = 0;
    this.pendingPersistentEntries = new Map();
    this.pendingPersistentEntrySizes = new Map();
    this.totalPendingPersistentBytes = 0;
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
    if (!responseId || !this.responses.has(responseId)) {
      const result = this.lookup(responseId);
      return result.state === "available" ? cloneJson(result.response) : null;
    }
    return cloneJson(this.responses.get(responseId));
  }

  getResponseMeta(responseId) {
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

  lookup(responseId) {
    if (!responseId) {
      return unavailableResult("missing", "memory");
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

  setEntry(responseId, messages) {
    const previousSize = this.entrySizes.get(responseId) || 0;
    const nextSize = byteSize(messages);
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
  }

  deleteResponse(responseId) {
    this.responses.delete(responseId);
    this.responseMeta.delete(responseId);
    if (this.entries.has(responseId)) {
      this.entries.delete(responseId);
      this.totalEntryBytes -= this.entrySizes.get(responseId) || 0;
      this.entrySizes.delete(responseId);
    }
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
