import {
  COMPONENT_IDS,
  TEST_CATALOG_ORIGIN,
  TEST_CATALOG_PATH,
  catalogError,
  compareVersions,
} from "../../shared/software-manager/catalog-schema.mjs";
import { createTrustedCatalogService, verifyCatalogEnvelope } from "./catalog-trust.mjs";

const FIXED_CATALOG_URL = `${TEST_CATALOG_ORIGIN}${TEST_CATALOG_PATH}`;
const FIXED_SIGNATURE_URL = `${FIXED_CATALOG_URL}.sig`;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const SIGNATURE_WHITESPACE = /[ \t\r\n]/gu;
const SIGNATURE_TEXT_CHARS = /^[A-Za-z0-9+/= \t\r\n]+$/u;
const ENVELOPE_KEYS = Object.freeze(["catalogUrl", "jsonBytes", "signatureText"]);

function positiveSafeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) throw catalogError(code);
  return value;
}

function timeoutError() {
  return catalogError("catalog_fetch_timeout");
}

function decodeSignatureText(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw catalogError("catalog_signature_text_invalid");
  }
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  if (!SIGNATURE_TEXT_CHARS.test(text)) throw catalogError("catalog_signature_text_invalid");
  const compact = text.replace(SIGNATURE_WHITESPACE, "");
  if (!BASE64_PATTERN.test(compact)) throw catalogError("catalog_signature_text_invalid");
  const decoded = Buffer.from(compact, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== compact) {
    throw catalogError("catalog_signature_text_invalid");
  }
  return compact;
}

function exactDataRecordDescriptors(value, keys) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || !ownKeys.every((key) => typeof key === "string" && keys.includes(key))) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return null;
    }
    return descriptors;
  } catch {
    return null;
  }
}

function normalizeCachedEnvelope(value, catalogUrl, maxCatalogBytes, maxSignatureBytes) {
  const descriptors = exactDataRecordDescriptors(value, ENVELOPE_KEYS);
  if (!descriptors) throw catalogError("catalog_cache_envelope_invalid");
  if (descriptors.catalogUrl.value !== catalogUrl) throw catalogError("catalog_cache_url_mismatch");
  const sourceBytes = descriptors.jsonBytes.value;
  const signatureText = descriptors.signatureText.value;
  if (typeof signatureText !== "string" || signatureText.length === 0
    || signatureText.length > maxSignatureBytes || Buffer.byteLength(signatureText, "utf8") > maxSignatureBytes
    || !BASE64_PATTERN.test(signatureText)) {
    throw catalogError("catalog_cache_envelope_invalid");
  }
  let jsonBytes;
  try {
    if (!Buffer.isBuffer(sourceBytes) && !(sourceBytes instanceof Uint8Array)) {
      throw catalogError("catalog_cache_envelope_invalid");
    }
    jsonBytes = Buffer.from(sourceBytes);
    if (jsonBytes.length === 0 || jsonBytes.length > maxCatalogBytes) {
      throw catalogError("catalog_cache_envelope_invalid");
    }
  } catch {
    throw catalogError("catalog_cache_envelope_invalid");
  }
  const decodedSignature = Buffer.from(signatureText, "base64");
  if (decodedSignature.length === 0 || decodedSignature.toString("base64") !== signatureText) {
    throw catalogError("catalog_cache_envelope_invalid");
  }
  return { catalogUrl, jsonBytes, signatureText };
}

function isBehindBundledBaseline(candidate, bundled) {
  if (!candidate || !bundled) return false;
  for (const componentId of COMPONENT_IDS) {
    let bundledEntry;
    try { bundledEntry = bundled.getComponent(componentId); } catch { continue; }
    let candidateEntry;
    try { candidateEntry = candidate.getComponent(componentId); } catch { return true; }
    if (compareVersions(candidateEntry.version, bundledEntry.version) < 0) return true;
  }
  for (const bundledSkill of bundled.listSkills()) {
    let candidateSkill;
    try { candidateSkill = candidate.getSkill(bundledSkill.id); } catch { return true; }
    if (compareVersions(candidateSkill.version, bundledSkill.version) < 0) return true;
  }
  return false;
}

async function raceWithSignal(promise, signal) {
  if (signal.aborted) throw signal.reason ?? timeoutError();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason ?? timeoutError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function cancelBody(response) {
  try {
    if (response?.body && typeof response.body.cancel === "function" && !response.body.locked) {
      void Promise.resolve(response.body.cancel()).catch(() => {});
    }
  } catch {
    // The primary fetch/validation error remains authoritative.
  }
}

async function readBounded(response, maxBytes, signal) {
  if (!response || typeof response.ok !== "boolean" || typeof response.status !== "number") {
    throw catalogError("catalog_fetch_response_invalid");
  }
  if (!response.ok) {
    cancelBody(response);
    throw catalogError("catalog_fetch_status");
  }
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined && declared !== "") {
    const parsed = Number(declared);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      cancelBody(response);
      throw catalogError("catalog_fetch_response_invalid");
    }
    if (parsed > maxBytes) {
      cancelBody(response);
      throw catalogError("catalog_response_too_large");
    }
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw catalogError("catalog_fetch_response_invalid");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  let complete = false;
  try {
    while (true) {
      const result = await raceWithSignal(reader.read(), signal);
      if (!result || typeof result.done !== "boolean") throw catalogError("catalog_fetch_response_invalid");
      if (result.done) {
        complete = true;
        break;
      }
      if (!(result.value instanceof Uint8Array)) throw catalogError("catalog_fetch_response_invalid");
      length += result.value.byteLength;
      if (length > maxBytes) throw catalogError("catalog_response_too_large");
      chunks.push(Buffer.from(result.value));
    }
    return Buffer.concat(chunks, length);
  } finally {
    if (!complete) {
      try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* primary error wins */ }
    }
    try { reader.releaseLock(); } catch { /* already released or invalid reader */ }
  }
}

async function fetchBounded(fetchImpl, url, maxBytes, signal) {
  let response;
  try {
    response = await raceWithSignal(fetchImpl(url, { redirect: "error", signal }), signal);
    return await readBounded(response, maxBytes, signal);
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? timeoutError();
    throw error;
  }
}

export function createCachedCatalogProvider({
  catalogUrl,
  signatureUrl,
  publicKeyPem,
  fetchImpl,
  cache,
  bundledEnvelope = null,
  timeoutMs = 15_000,
  maxCatalogBytes = 2_000_000,
  maxSignatureBytes = 16_384,
} = {}) {
  if (catalogUrl !== FIXED_CATALOG_URL || signatureUrl !== FIXED_SIGNATURE_URL) {
    throw catalogError("catalog_provider_url_rejected");
  }
  if (publicKeyPem !== null && typeof publicKeyPem !== "string") {
    throw catalogError("catalog_provider_key_invalid");
  }
  if (typeof fetchImpl !== "function" || !cache || typeof cache.readEnvelope !== "function"
    || typeof cache.replaceEnvelope !== "function") {
    throw catalogError("catalog_provider_dependency_invalid");
  }
  positiveSafeInteger(timeoutMs, "catalog_provider_timeout_invalid");
  positiveSafeInteger(maxCatalogBytes, "catalog_provider_limit_invalid");
  positiveSafeInteger(maxSignatureBytes, "catalog_provider_limit_invalid");
  const metadata = new WeakMap();
  const catalogPublishedAt = (service) => {
    const dates = [];
    for (const id of COMPONENT_IDS) {
      try { dates.push(service.getComponent(id).publishedAt); } catch {}
    }
    try { dates.push(...service.listSkills().map((entry) => entry.publishedAt)); } catch {}
    return dates.filter((value) => Number.isFinite(Date.parse(value)))
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
  };
  const mark = (service, source, refreshedAt = null) => {
    if (service) metadata.set(service, Object.freeze({
      source,
      publishedAt: catalogPublishedAt(service),
      refreshedAt,
    }));
    return service;
  };
  const bundledService = bundledEnvelope === null || publicKeyPem === null
    ? null
    : mark(createTrustedCatalogService(verifyCatalogEnvelope({
      ...normalizeCachedEnvelope(bundledEnvelope, catalogUrl, maxCatalogBytes, maxSignatureBytes),
      publicKeyPem,
    })), "bundled");
  const offlineRefresh = Promise.resolve(null);
  let refreshInFlight = null;

  async function getCurrent() {
    if (publicKeyPem === null) return null;
    try {
      const cached = await cache.readEnvelope();
      if (cached === null) return bundledService;
      const envelope = normalizeCachedEnvelope(cached, catalogUrl, maxCatalogBytes, maxSignatureBytes);
      const catalog = verifyCatalogEnvelope({ ...envelope, publicKeyPem });
      const cachedService = mark(createTrustedCatalogService(catalog), "cache");
      return isBehindBundledBaseline(cachedService, bundledService) ? bundledService : cachedService;
    } catch (error) {
      if (bundledService) return bundledService;
      throw error;
    }
  }

  async function performRefresh() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(timeoutError()), timeoutMs);
    timer.unref?.();
    try {
      const jsonBytes = await fetchBounded(fetchImpl, catalogUrl, maxCatalogBytes, controller.signal);
      const signatureBytes = await fetchBounded(fetchImpl, signatureUrl, maxSignatureBytes, controller.signal);
      const signatureText = decodeSignatureText(signatureBytes);
      const envelope = { catalogUrl, jsonBytes, signatureText };
      const catalog = verifyCatalogEnvelope({ ...envelope, publicKeyPem });
      const service = mark(createTrustedCatalogService(catalog), "remote", new Date().toISOString());
      await cache.replaceEnvelope(envelope);
      return service;
    } finally {
      clearTimeout(timer);
    }
  }

  function refresh() {
    if (publicKeyPem === null) return offlineRefresh;
    if (refreshInFlight !== null) return refreshInFlight;
    const operation = Promise.resolve().then(performRefresh);
    refreshInFlight = operation;
    const release = () => {
      if (refreshInFlight === operation) refreshInFlight = null;
    };
    operation.then(release, release);
    return operation;
  }

  function describe(service) {
    return metadata.get(service) ?? Object.freeze({ source: "unknown", publishedAt: null, refreshedAt: null });
  }

  return Object.freeze({ getCurrent, refresh, describe });
}
