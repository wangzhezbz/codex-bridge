import crypto from "node:crypto";

import { CATALOG_PUBLIC_KEY_SPKI } from "./catalog-public-key.mjs";
import {
  COMPONENT_IDS,
  TEST_CATALOG_ORIGIN,
  TEST_CATALOG_PATH,
  catalogError,
  parseCatalog,
  resolveCatalogAssetUrl,
} from "../../shared/software-manager/catalog-schema.mjs";

const VERIFIED_CATALOGS = new WeakMap();
const TRUSTED_SERVICES = new WeakSet();

export function createTrustedCatalogService(catalog) {
  const metadata = VERIFIED_CATALOGS.get(catalog);
  if (!metadata) throw catalogError("catalog_not_verified");
  const componentMap = new Map(catalog.components.map((entry) => [entry.id, trustedEntry(entry, metadata.catalogUrl)]));
  const skillMap = new Map(catalog.skills.map((entry) => [entry.id, trustedEntry(entry, metadata.catalogUrl)]));
  const service = Object.freeze({
    getComponent(componentId) {
      if (!COMPONENT_IDS.includes(componentId)) throw catalogError("catalog_component_id_invalid");
      const entry = componentMap.get(componentId);
      if (!entry) throw catalogError("catalog_component_entry_missing");
      return entry;
    },
    getSkill(skillId) {
      if (typeof skillId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(skillId)) {
        throw catalogError("catalog_skill_id_invalid");
      }
      const entry = skillMap.get(skillId);
      if (!entry) throw catalogError("catalog_skill_entry_missing");
      return entry;
    },
    listSkills() {
      return Object.freeze([...skillMap.values()]);
    },
  });
  TRUSTED_SERVICES.add(service);
  return service;
}

export function isTrustedCatalogService(value) {
  return value !== null && typeof value === "object" && TRUSTED_SERVICES.has(value);
}

function trustedEntry(entry, catalogUrl) {
  return Object.freeze({
    ...entry,
    assetUrl: resolveCatalogAssetUrl(catalogUrl, entry.assetUrl),
  });
}

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
    const catalog = parseCatalog(JSON.parse(Buffer.from(jsonBytes).toString("utf8")));
    VERIFIED_CATALOGS.set(catalog, { catalogUrl: url.href });
    return catalog;
  } catch (error) {
    if (error?.code) throw error;
    throw catalogError("catalog_json_invalid");
  }
}
