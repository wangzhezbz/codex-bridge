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

function exactPlainDataRecord(value, keys) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || !ownKeys.every((key) => typeof key === "string" && keys.includes(key))) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (!keys.every((key) => descriptors[key]?.enumerable && Object.hasOwn(descriptors[key], "value"))) return null;
    return descriptors;
  } catch {
    return null;
  }
}

function invalid() {
  throw catalogError("catalog_cache_invalid");
}

function isCanonicalBase64(value, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength
    || !BASE64_PATTERN.test(value)) return false;
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.length > 0 && decoded.toString("base64") === value;
  } catch {
    return false;
  }
}

function cloneBoundedBytes(value, maxBytes) {
  try {
    if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) return null;
    const bytes = Buffer.from(value);
    return bytes.length > 0 && bytes.length <= maxBytes ? bytes : null;
  } catch {
    return null;
  }
}

function decodeBoundedBase64(value, maxBytes) {
  try {
    const bytes = Buffer.from(value, "base64");
    return bytes.length > 0 && bytes.length <= maxBytes && bytes.toString("base64") === value ? bytes : null;
  } catch {
    return null;
  }
}

function decodeRecord(record) {
  const descriptors = exactPlainDataRecord(record, RECORD_KEYS);
  if (!descriptors) invalid();
  const catalogUrl = descriptors.catalogUrl.value;
  const jsonBase64 = descriptors.jsonBase64.value;
  const signatureText = descriptors.signatureText.value;
  if (catalogUrl !== CATALOG_URL
    || typeof jsonBase64 !== "string" || jsonBase64.length > Math.ceil(MAX_CATALOG_BYTES / 3) * 4
    || !BASE64_PATTERN.test(jsonBase64)
    || !isCanonicalBase64(signatureText, MAX_SIGNATURE_BYTES)
    || Buffer.byteLength(signatureText, "utf8") > MAX_SIGNATURE_BYTES) invalid();
  const jsonBytes = decodeBoundedBase64(jsonBase64, MAX_CATALOG_BYTES);
  if (!jsonBytes) invalid();
  return { catalogUrl, jsonBytes, signatureText };
}

function encodeEnvelope(envelope) {
  const descriptors = exactPlainDataRecord(envelope, ENVELOPE_KEYS);
  if (!descriptors) invalid();
  const catalogUrl = descriptors.catalogUrl.value;
  const sourceBytes = descriptors.jsonBytes.value;
  const signatureText = descriptors.signatureText.value;
  if (catalogUrl !== CATALOG_URL
    || !isCanonicalBase64(signatureText, MAX_SIGNATURE_BYTES)
    || Buffer.byteLength(signatureText, "utf8") > MAX_SIGNATURE_BYTES) invalid();
  const jsonBytes = cloneBoundedBytes(sourceBytes, MAX_CATALOG_BYTES);
  if (!jsonBytes) invalid();
  return {
    catalogUrl,
    jsonBase64: jsonBytes.toString("base64"),
    signatureText,
  };
}

export function createCatalogCache({ cacheStore } = {}) {
  if (!cacheStore || typeof cacheStore.read !== "function" || typeof cacheStore.replaceAtomic !== "function") {
    throw catalogError("catalog_cache_store_invalid");
  }
  return Object.freeze({
    async readEnvelope() {
      const record = await cacheStore.read();
      return record === null ? null : decodeRecord(record);
    },
    async replaceEnvelope(envelope) {
      await cacheStore.replaceAtomic(encodeEnvelope(envelope));
    },
  });
}
