import {
  TEST_CATALOG_ORIGIN,
  TEST_CATALOG_PATH,
  catalogError,
} from "../../shared/software-manager/catalog-schema.mjs";

const CATALOG_URL = `${TEST_CATALOG_ORIGIN}${TEST_CATALOG_PATH}`;
const MAX_CATALOG_BYTES = 2_000_000;
const MAX_SIGNATURE_BYTES = 16_384;
const RECORD_KEYS = Object.freeze(["catalogUrl", "jsonBase64", "signatureText"]);
const ENVELOPE_KEYS = Object.freeze(["catalogUrl", "jsonBytes", "signatureText"]);
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function exactPlainRecord(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function invalid() {
  throw catalogError("catalog_cache_invalid");
}

function isCanonicalBase64(value, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength
    || !BASE64_PATTERN.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length > 0 && decoded.toString("base64") === value;
}

function decodeRecord(record) {
  if (!exactPlainRecord(record, RECORD_KEYS) || record.catalogUrl !== CATALOG_URL
    || typeof record.jsonBase64 !== "string" || record.jsonBase64.length > Math.ceil(MAX_CATALOG_BYTES / 3) * 4
    || !BASE64_PATTERN.test(record.jsonBase64)
    || !isCanonicalBase64(record.signatureText, MAX_SIGNATURE_BYTES)
    || Buffer.byteLength(record.signatureText, "utf8") > MAX_SIGNATURE_BYTES) invalid();
  const jsonBytes = Buffer.from(record.jsonBase64, "base64");
  if (jsonBytes.length === 0 || jsonBytes.length > MAX_CATALOG_BYTES
    || jsonBytes.toString("base64") !== record.jsonBase64) invalid();
  return { catalogUrl: record.catalogUrl, jsonBytes, signatureText: record.signatureText };
}

function encodeEnvelope(envelope) {
  if (!exactPlainRecord(envelope, ENVELOPE_KEYS) || envelope.catalogUrl !== CATALOG_URL
    || (!Buffer.isBuffer(envelope.jsonBytes) && !(envelope.jsonBytes instanceof Uint8Array))
    || !isCanonicalBase64(envelope.signatureText, MAX_SIGNATURE_BYTES)
    || Buffer.byteLength(envelope.signatureText, "utf8") > MAX_SIGNATURE_BYTES) invalid();
  const jsonBytes = Buffer.from(envelope.jsonBytes);
  if (jsonBytes.length === 0 || jsonBytes.length > MAX_CATALOG_BYTES) invalid();
  return {
    catalogUrl: envelope.catalogUrl,
    jsonBase64: jsonBytes.toString("base64"),
    signatureText: envelope.signatureText,
  };
}

export function createCatalogCache({ cacheStore } = {}) {
  if (!cacheStore || typeof cacheStore.read !== "function" || typeof cacheStore.replace !== "function") {
    throw catalogError("catalog_cache_store_invalid");
  }
  return Object.freeze({
    async readEnvelope() {
      const record = await cacheStore.read();
      return record === null ? null : decodeRecord(record);
    },
    async replaceEnvelope(envelope) {
      await cacheStore.replace(encodeEnvelope(envelope));
    },
  });
}
