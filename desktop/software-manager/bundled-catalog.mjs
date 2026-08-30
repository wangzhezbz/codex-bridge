import fs from "node:fs";

const CATALOG_FILE = new URL("./bundled-catalog/component-catalog.json", import.meta.url);
const SIGNATURE_FILE = new URL("./bundled-catalog/component-catalog.json.sig", import.meta.url);

export function readBundledCatalogEnvelope({ catalogUrl }) {
  const jsonBytes = fs.readFileSync(CATALOG_FILE);
  const signatureText = fs.readFileSync(SIGNATURE_FILE, "utf8").trim();
  return Object.freeze({ catalogUrl, jsonBytes, signatureText });
}
