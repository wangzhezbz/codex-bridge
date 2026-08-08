import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  parseCatalog,
  resolveCatalogAssetUrl,
  TEST_CATALOG_ORIGIN,
  TEST_CATALOG_PATH,
  TEST_COS_PACKAGE_ORIGIN,
  TEST_COS_PACKAGE_PATH,
  TEST_PACKAGE_PATH,
} from "../../shared/software-manager/catalog-schema.mjs";
import { readCurrentCatalog, replaceCatalogEntry, replaceSignedCatalog } from "./catalog-builder.mjs";
import { loadPublisherConfig } from "./publisher-config.mjs";

function importError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function sha256File(filePath) {
  const digest = crypto.createHash("sha256");
  const handle = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const read = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (!read) break;
      digest.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(handle);
  }
  return digest.digest("hex");
}

function exactMetadata(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== 2 || !value.component || !Array.isArray(value.skills)) {
    throw importError("publisher_import_metadata_invalid");
  }
  return parseCatalog({ schemaVersion: 1, components: [value.component], skills: value.skills });
}

function localAssetPath(config, assetUrl) {
  const resolved = new URL(resolveCatalogAssetUrl(`${TEST_CATALOG_ORIGIN}${TEST_CATALOG_PATH}`, assetUrl));
  const packagePath = resolved.origin === TEST_CATALOG_ORIGIN
    ? TEST_PACKAGE_PATH
    : resolved.origin === TEST_COS_PACKAGE_ORIGIN ? TEST_COS_PACKAGE_PATH : null;
  if (packagePath === null || !resolved.pathname.startsWith(packagePath)) {
    throw importError("publisher_import_asset_url_invalid");
  }
  const relative = decodeURIComponent(resolved.pathname.slice(packagePath.length));
  if (!relative || relative.includes("\\") || relative.split("/").some((part) => !part || part === "." || part === "..")) {
    throw importError("publisher_import_asset_url_invalid");
  }
  const packageRoot = path.resolve(config.publicRoot, "packages");
  const candidate = path.resolve(packageRoot, ...relative.split("/"));
  if (!candidate.startsWith(`${packageRoot}${path.sep}`)) throw importError("publisher_import_asset_url_invalid");
  return candidate;
}

function verifyAsset(config, entry) {
  const filePath = localAssetPath(config, entry.assetUrl);
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size !== entry.size || sha256File(filePath) !== entry.sha256) {
    throw importError("publisher_import_asset_verification_failed");
  }
}

export async function publishImportedAssets({
  config = loadPublisherConfig(process.env),
  metadataPath,
} = {}) {
  const raw = String(metadataPath || "");
  if (!raw || !path.isAbsolute(raw) || path.normalize(raw) !== raw) {
    throw importError("publisher_import_metadata_path_invalid");
  }
  let imported;
  try {
    imported = exactMetadata(JSON.parse(fs.readFileSync(raw, "utf8")));
  } catch (error) {
    if (error?.code?.startsWith("publisher_import_")) throw error;
    throw importError("publisher_import_metadata_invalid");
  }
  for (const entry of [...imported.components, ...imported.skills]) verifyAsset(config, entry);
  const current = readCurrentCatalog(config.publicRoot, { signingKeyFile: config.signingKeyFile });
  const catalog = replaceCatalogEntry(current, {
    component: imported.components[0],
    skills: imported.skills,
  });
  return replaceSignedCatalog({ config, catalog, events: ["imported_assets_verified"] });
}

function args(values) {
  if (values.length !== 2 || values[0] !== "--metadata") throw importError("publisher_argument_invalid");
  return { metadataPath: values[1] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await publishImportedAssets(args(process.argv.slice(2)));
  console.log(JSON.stringify({ catalogPath: result.catalogPath, events: result.events }, null, 2));
}
