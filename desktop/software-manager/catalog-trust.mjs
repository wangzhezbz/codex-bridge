import crypto from "node:crypto";

import { CATALOG_PUBLIC_KEY_SPKI } from "./catalog-public-key.mjs";
import { TEST_CATALOG_ORIGIN, TEST_CATALOG_PATH, catalogError, parseCatalog } from "../../shared/software-manager/catalog-schema.mjs";

export function verifyCatalogEnvelope({ jsonBytes, signatureText, publicKeyPem = CATALOG_PUBLIC_KEY_SPKI, catalogUrl }) {
  if (!publicKeyPem) throw catalogError("catalog_trust_not_provisioned");
  let url;
  try {
    url = new URL(catalogUrl);
  } catch {
    throw catalogError("catalog_origin_rejected");
  }
  if (url.protocol !== "https:" || url.origin !== TEST_CATALOG_ORIGIN || url.pathname !== TEST_CATALOG_PATH) {
    throw catalogError("catalog_origin_rejected");
  }
  if (!Buffer.isBuffer(jsonBytes) && !(jsonBytes instanceof Uint8Array)) throw catalogError("catalog_json_invalid");
  const signature = Buffer.from(String(signatureText).replace(/^\uFEFF/, "").replace(/\s+/g, ""), "base64");
  if (!crypto.verify("RSA-SHA256", jsonBytes, publicKeyPem, signature)) throw catalogError("catalog_signature_invalid");
  try {
    return parseCatalog(JSON.parse(Buffer.from(jsonBytes).toString("utf8")));
  } catch (error) {
    if (error?.code) throw error;
    throw catalogError("catalog_json_invalid");
  }
}
