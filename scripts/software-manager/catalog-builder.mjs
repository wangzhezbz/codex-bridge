import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

import { parseCatalog } from "../../shared/software-manager/catalog-schema.mjs";

function catalogPublisherError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}

export function buildCatalogBytes(value) {
  return Buffer.from(`${JSON.stringify(sortValue(value))}\n`, "utf8");
}

export function readCurrentCatalog(publicRoot, { signingKeyFile = "" } = {}) {
  const catalogPath = path.join(publicRoot, "component-catalog.json");
  if (!fs.existsSync(catalogPath)) return { schemaVersion: 1, components: [], skills: [] };
  try {
    const jsonBytes = fs.readFileSync(catalogPath);
    const signatureText = fs.readFileSync(`${catalogPath}.sig`, "utf8");
    if (!/^[A-Za-z0-9+/]+={0,2}\r?\n?$/u.test(signatureText)
      || !signingKeyFile || !fs.existsSync(signingKeyFile)) {
      throw catalogPublisherError("publisher_existing_catalog_signature_invalid");
    }
    const privateKey = crypto.createPrivateKey(fs.readFileSync(signingKeyFile, "utf8"));
    const publicKey = crypto.createPublicKey(privateKey);
    const signature = Buffer.from(signatureText.trim(), "base64");
    if (!crypto.verify("RSA-SHA256", jsonBytes, publicKey, signature)) {
      throw catalogPublisherError("publisher_existing_catalog_signature_invalid");
    }
    return parseCatalog(JSON.parse(jsonBytes.toString("utf8")));
  } catch (error) {
    if (error?.code === "publisher_existing_catalog_signature_invalid") throw error;
    throw catalogPublisherError("publisher_existing_catalog_invalid");
  }
}

export async function atomicReplacePublicFile(filePath, bytes) {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.part`;
  let created = false;
  try {
    const handle = await fsPromises.open(temporary, "wx", 0o644);
    created = true;
    try {
      await handle.writeFile(bytes);
      await handle.chmod(0o644);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsPromises.rename(temporary, filePath);
    created = false;
  } catch (error) {
    if (created) await fsPromises.unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function replaceSignedCatalog({ config, catalog, events = [] }) {
  const parsed = parseCatalog(catalog);
  const bytes = buildCatalogBytes(parsed);
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(fs.readFileSync(config.signingKeyFile, "utf8"));
  } catch {
    throw catalogPublisherError("publisher_signing_key_invalid");
  }
  const signature = `${crypto.sign("RSA-SHA256", bytes, privateKey).toString("base64")}\n`;
  const signaturePath = path.join(config.publicRoot, "component-catalog.json.sig");
  const catalogPath = path.join(config.publicRoot, "component-catalog.json");
  await atomicReplacePublicFile(signaturePath, signature);
  events.push("signature_written");
  await atomicReplacePublicFile(catalogPath, bytes);
  events.push("catalog_replaced");
  return Object.freeze({ catalogPath, signaturePath, catalog: parsed, events: Object.freeze([...events]) });
}

export function replaceCatalogEntry(current, { component = null, skills = null } = {}) {
  const components = [...current.components].filter((item) => item.id !== component?.id);
  if (component) components.push(component);
  components.sort((left, right) => left.id.localeCompare(right.id, "en"));
  const skillMap = new Map(current.skills.map((item) => [item.id, item]));
  for (const skill of skills ?? []) skillMap.set(skill.id, skill);
  return {
    schemaVersion: 1,
    components,
    skills: [...skillMap.values()].sort((left, right) => left.id.localeCompare(right.id, "en")),
  };
}
