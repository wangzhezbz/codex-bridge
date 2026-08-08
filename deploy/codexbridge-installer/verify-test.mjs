import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

import { CATALOG_PUBLIC_KEY_SPKI } from "../../desktop/software-manager/catalog-public-key.mjs";
import { verifyCatalogEnvelope } from "../../desktop/software-manager/catalog-trust.mjs";

const CATALOG_URL = "https://shanhaiyouling.com/codexbridge-install-test/component-catalog.json";
const SIGNATURE_URL = `${CATALOG_URL}.sig`;

function verifyError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function requiredResponse(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, {
    redirect: "error",
    cache: "no-store",
    ...options,
    headers: { "cache-control": "no-cache", pragma: "no-cache", ...(options.headers || {}) },
  });
  if (!response?.ok) throw verifyError("software_catalog_remote_request_failed");
  return response;
}

async function verifyAsset(fetchImpl, item) {
  const head = await requiredResponse(fetchImpl, item.assetUrl, { method: "HEAD" });
  const length = Number(head.headers?.get?.("content-length"));
  if (!Number.isSafeInteger(length) || length !== item.size) throw verifyError("software_catalog_remote_size_mismatch");
  const response = await requiredResponse(fetchImpl, item.assetUrl);
  if (!response.body?.getReader) throw verifyError("software_catalog_remote_stream_required");
  const reader = response.body.getReader();
  const hash = crypto.createHash("sha256");
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    size += chunk.length;
    if (size > item.size) throw verifyError("software_catalog_remote_size_mismatch");
    hash.update(chunk);
  }
  const sha256 = hash.digest("hex");
  if (size !== item.size || sha256 !== item.sha256) throw verifyError("software_catalog_remote_hash_mismatch");
  return Object.freeze({ id: item.id, version: item.version, url: item.assetUrl, size, sha256 });
}

export async function verifyTestEndpoint({
  fetchImpl = globalThis.fetch,
  publicKeyPem = CATALOG_PUBLIC_KEY_SPKI,
  checkedAt = new Date().toISOString(),
} = {}) {
  if (typeof publicKeyPem !== "string" || !publicKeyPem.trim()) throw verifyError("catalog_trust_not_provisioned");
  const [catalogResponse, signatureResponse] = await Promise.all([
    requiredResponse(fetchImpl, CATALOG_URL),
    requiredResponse(fetchImpl, SIGNATURE_URL),
  ]);
  const jsonBytes = Buffer.from(await catalogResponse.arrayBuffer());
  const signatureText = await signatureResponse.text();
  const catalog = verifyCatalogEnvelope({ jsonBytes, signatureText, publicKeyPem, catalogUrl: CATALOG_URL });
  const assets = [];
  for (const item of [...catalog.components, ...catalog.skills]) assets.push(await verifyAsset(fetchImpl, item));
  return Object.freeze({
    ok: true,
    endpoint: CATALOG_URL,
    checkedAt,
    catalogSha256: crypto.createHash("sha256").update(jsonBytes).digest("hex"),
    assets: Object.freeze(assets),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await verifyTestEndpoint(), null, 2));
}
