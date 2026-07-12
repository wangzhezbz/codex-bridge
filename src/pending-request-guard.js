import { createHash, randomUUID } from "node:crypto";

const DEFAULT_CAPACITY = 1_024;
const MAX_DIAGNOSTIC_TEXT_LENGTH = 160;
const FINGERPRINT_NAMESPACE = "codexbridge-pending-request-v1";
const CLIENT_IDENTITY_HEADERS = Object.freeze([
  "x-codex-thread-id",
  "thread-id",
  "x-codex-window-id",
  "x-codex-parent-thread-id",
  "x-codex-installation-id",
  "x-codex-turn-state",
  "x-codex-turn-metadata",
  "x-client-request-id",
  "session-id",
  "chatgpt-session-id",
  "chatgpt-account-id",
]);

export function createPendingRequestGuard(options = {}) {
  const pending = new Map();
  const capacity = normalizedCapacity(options.capacity);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const tokenFactory = typeof options.tokenFactory === "function"
    ? options.tokenFactory
    : randomUUID;

  function begin(input = {}, beginOptions = {}) {
    if (beginOptions.enabled !== true) {
      return {
        status: "disabled",
        protected: false,
        reasonCode: "duplicate_protection_disabled",
      };
    }

    const fingerprint = fingerprintPendingRequest(input);
    const existing = pending.get(fingerprint);
    if (existing) {
      return {
        status: "duplicate",
        protected: true,
        reasonCode: "request_already_pending",
        fingerprint,
        metadata: copyMetadata(existing.metadata),
      };
    }

    const metadata = safeDiagnosticMetadata(input);
    if (pending.size >= capacity) {
      return {
        status: "capacity_bypass",
        protected: false,
        reasonCode: "pending_guard_capacity",
        fingerprint,
        metadata,
      };
    }

    const ownershipToken = normalizedOwnershipToken(tokenFactory());
    const startedAt = normalizedTimestamp(now());
    pending.set(fingerprint, {
      ownershipToken,
      startedAt,
      metadata,
    });

    return {
      status: "owner",
      protected: true,
      fingerprint,
      ownershipToken,
      metadata: copyMetadata(metadata),
    };
  }

  function release(lease = {}) {
    const fingerprint = normalizedText(lease?.fingerprint);
    const ownershipToken = normalizedText(lease?.ownershipToken);
    if (!fingerprint || !ownershipToken) {
      return false;
    }
    const existing = pending.get(fingerprint);
    if (!existing || existing.ownershipToken !== ownershipToken) {
      return false;
    }
    pending.delete(fingerprint);
    return true;
  }

  function size() {
    return pending.size;
  }

  function snapshot() {
    return Array.from(pending, ([fingerprint, entry]) => ({
      fingerprint,
      startedAt: entry.startedAt,
      metadata: copyMetadata(entry.metadata),
    }));
  }

  return Object.freeze({
    begin,
    release,
    size,
    snapshot,
  });
}

export function fingerprintPendingRequest(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const material = {
    version: 1,
    configRevision: normalizedText(source.configRevision),
    requestSurface: normalizedText(source.requestSurface),
    route: routeIdentity(source.route),
    compactKind: normalizedText(source.compactKind),
    clientHeaders: clientIdentityHeaders(source.headers),
    requestBody: source.requestBody,
  };
  return createHash("sha256")
    .update(FINGERPRINT_NAMESPACE)
    .update("\n")
    .update(stableJson(material))
    .digest("hex");
}

function routeIdentity(route = {}) {
  const source = route && typeof route === "object" ? route : {};
  return {
    id: normalizedText(source.id),
    provider: normalizedText(
      source.provider ?? source.providerId ?? source.providerFamily,
    ),
    api: normalizedText(source.api),
    model: normalizedText(source.model),
    baseUrl: safeBaseUrlIdentity(source.baseUrl),
    authMode: normalizedText(source.authMode),
    apiKeyEnv: normalizedText(source.apiKeyEnv ?? source.keyEnv),
  };
}

function clientIdentityHeaders(headers) {
  const result = {};
  for (const name of CLIENT_IDENTITY_HEADERS) {
    const value = headerValue(headers, name);
    if (value !== "") {
      result[name] = value;
    }
  }
  return result;
}

function headerValue(headers, name) {
  if (!headers) {
    return "";
  }
  if (typeof headers.get === "function") {
    return normalizedHeaderValue(headers.get(name));
  }
  if (typeof headers !== "object") {
    return "";
  }
  const matchingName = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name,
  );
  return matchingName ? normalizedHeaderValue(headers[matchingName]) : "";
}

function normalizedHeaderValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizedText(item)).join(",");
  }
  return normalizedText(value);
}

function safeBaseUrlIdentity(value) {
  const text = normalizedText(value);
  if (!text) {
    return "";
  }
  try {
    const url = new URL(text);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const name of Array.from(url.searchParams.keys())) {
      if (isSecretQueryParameter(name)) {
        url.searchParams.delete(name);
      }
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return "invalid-base-url";
  }
}

function isSecretQueryParameter(name) {
  const normalized = String(name || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
  const words = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  if (
    words.some((word) =>
      [
        "auth",
        "authorization",
        "bearer",
        "credential",
        "key",
        "password",
        "secret",
        "sig",
        "signature",
        "token",
      ].includes(word),
    )
  ) {
    return true;
  }
  return /^(?:accesstoken|apikey|authorization|clientsecret|subscriptionkey)$/.test(
    words.join(""),
  );
}

function safeDiagnosticMetadata(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const route = source.route && typeof source.route === "object" ? source.route : {};
  return {
    configRevision: boundedDiagnosticText(source.configRevision),
    routeId: boundedDiagnosticText(route.id),
    provider: boundedDiagnosticText(
      route.provider ?? route.providerId ?? route.providerFamily,
    ),
    api: boundedDiagnosticText(route.api),
    model: boundedDiagnosticText(route.model),
    compactKind: boundedDiagnosticText(source.compactKind),
  };
}

function copyMetadata(metadata = {}) {
  return {
    configRevision: metadata.configRevision || "",
    routeId: metadata.routeId || "",
    provider: metadata.provider || "",
    api: metadata.api || "",
    model: metadata.model || "",
    compactKind: metadata.compactKind || "",
  };
}

function boundedDiagnosticText(value) {
  return normalizedText(value).slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH);
}

function normalizedText(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function normalizedCapacity(value) {
  if (value === undefined) {
    return DEFAULT_CAPACITY;
  }
  const capacity = Number(value);
  return Number.isFinite(capacity) && capacity >= 0
    ? Math.floor(capacity)
    : DEFAULT_CAPACITY;
}

function normalizedTimestamp(value) {
  const timestamp = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizedOwnershipToken(value) {
  const token = normalizedText(value);
  if (!token) {
    throw new TypeError("pending request ownership token must be non-empty");
  }
  return token;
}

function stableJson(value) {
  return stableJsonValue(value, new Set(), false);
}

function stableJsonValue(value, ancestors, arrayMember) {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (typeof value === "bigint") {
    throw new TypeError("request body cannot contain BigInt values");
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return arrayMember ? "null" : undefined;
  }
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (ancestors.has(value)) {
    throw new TypeError("request body cannot contain circular values");
  }

  ancestors.add(value);
  let serialized;
  if (Array.isArray(value)) {
    serialized = `[${value
      .map((item) => stableJsonValue(item, ancestors, true) ?? "null")
      .join(",")}]`;
  } else {
    const fields = [];
    for (const key of Object.keys(value).sort()) {
      const field = stableJsonValue(value[key], ancestors, false);
      if (field !== undefined) {
        fields.push(`${JSON.stringify(key)}:${field}`);
      }
    }
    serialized = `{${fields.join(",")}}`;
  }
  ancestors.delete(value);
  return serialized;
}
