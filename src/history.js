import { cloneJson } from "./json.js";

export class ResponseHistory {
  constructor({
    maxEntries = 200,
    maxEntryBytes = 1_000_000,
    maxTotalBytes = 20_000_000,
  } = {}) {
    this.maxEntries = maxEntries;
    this.maxEntryBytes = maxEntryBytes;
    this.maxTotalBytes = maxTotalBytes;
    this.entries = new Map();
    this.responses = new Map();
    this.responseMeta = new Map();
    this.entrySizes = new Map();
    this.totalEntryBytes = 0;
  }

  get(responseId) {
    if (!responseId || !this.entries.has(responseId)) {
      return [];
    }
    return cloneJson(this.entries.get(responseId));
  }

  record(responseId, chatMessages) {
    if (!responseId) {
      return;
    }
    const withoutSystem = chatMessages.filter((message) => message.role !== "system");
    const bounded = trimChatMessagesToByteLimit(
      cloneJson(withoutSystem),
      this.maxEntryBytes,
    );
    this.setEntry(responseId, bounded);
    this.trim();
  }

  getResponse(responseId) {
    if (!responseId || !this.responses.has(responseId)) {
      return null;
    }
    return cloneJson(this.responses.get(responseId));
  }

  getResponseMeta(responseId) {
    if (!responseId || !this.responseMeta.has(responseId)) {
      return null;
    }
    return cloneJson(this.responseMeta.get(responseId));
  }

  recordResponse(response, meta = {}) {
    if (!response?.id) {
      return;
    }
    this.responses.set(response.id, cloneJson(response));
    this.responseMeta.set(response.id, cloneJson(meta || {}));
    this.trim();
  }

  setEntry(responseId, messages) {
    const previousSize = this.entrySizes.get(responseId) || 0;
    const nextSize = byteSize(messages);
    this.entries.set(responseId, messages);
    this.entrySizes.set(responseId, nextSize);
    this.totalEntryBytes += nextSize - previousSize;
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
