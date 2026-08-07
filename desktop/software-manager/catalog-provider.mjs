import {
  TEST_CATALOG_ORIGIN,
  TEST_CATALOG_PATH,
  catalogError,
} from "../../shared/software-manager/catalog-schema.mjs";
import { createTrustedCatalogService, verifyCatalogEnvelope } from "./catalog-trust.mjs";

const FIXED_CATALOG_URL = `${TEST_CATALOG_ORIGIN}${TEST_CATALOG_PATH}`;
const FIXED_SIGNATURE_URL = `${FIXED_CATALOG_URL}.sig`;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const SIGNATURE_WHITESPACE = /[ \t\r\n]/gu;
const SIGNATURE_TEXT_CHARS = /^[A-Za-z0-9+/= \t\r\n]+$/u;

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

  async function getCurrent() {
    if (publicKeyPem === null) return null;
    const envelope = await cache.readEnvelope();
    if (envelope === null) return null;
    if (envelope.catalogUrl !== catalogUrl) throw catalogError("catalog_cache_url_mismatch");
    const catalog = verifyCatalogEnvelope({ ...envelope, publicKeyPem });
    return createTrustedCatalogService(catalog);
  }

  async function refresh() {
    if (publicKeyPem === null) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(timeoutError()), timeoutMs);
    timer.unref?.();
    try {
      const jsonBytes = await fetchBounded(fetchImpl, catalogUrl, maxCatalogBytes, controller.signal);
      const signatureBytes = await fetchBounded(fetchImpl, signatureUrl, maxSignatureBytes, controller.signal);
      const signatureText = decodeSignatureText(signatureBytes);
      const envelope = { catalogUrl, jsonBytes, signatureText };
      const catalog = verifyCatalogEnvelope({ ...envelope, publicKeyPem });
      const service = createTrustedCatalogService(catalog);
      await cache.replaceEnvelope(envelope);
      return service;
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({ getCurrent, refresh });
}
