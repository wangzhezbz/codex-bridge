import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  resolveCatalogAssetUrl,
  TEST_CATALOG_ORIGIN,
  TEST_CATALOG_PATH,
  TEST_COS_PACKAGE_ORIGIN,
  TEST_COS_PACKAGE_PATH,
  TEST_DOGECLOUD_PACKAGE_ORIGIN,
  TEST_DOGECLOUD_PACKAGE_PATH,
  TEST_PACKAGE_PATH,
} from "../../shared/software-manager/catalog-schema.mjs";
import { readCurrentCatalog, replaceSignedCatalog } from "./catalog-builder.mjs";
import { createDogeCloudArtifactPublisher } from "./dogecloud-artifact-publisher.mjs";
import { loadPublisherConfig } from "./publisher-config.mjs";

function migrationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function localAsset(config, assetUrl) {
  const resolved = new URL(resolveCatalogAssetUrl(`${TEST_CATALOG_ORIGIN}${TEST_CATALOG_PATH}`, assetUrl));
  const prefix = resolved.origin === TEST_CATALOG_ORIGIN
    ? TEST_PACKAGE_PATH
    : resolved.origin === TEST_COS_PACKAGE_ORIGIN ? TEST_COS_PACKAGE_PATH
      : resolved.origin === TEST_DOGECLOUD_PACKAGE_ORIGIN ? TEST_DOGECLOUD_PACKAGE_PATH : null;
  if (prefix === null || !resolved.pathname.startsWith(prefix)) throw migrationError("dogecloud_migration_asset_invalid");
  const relativePath = decodeURIComponent(resolved.pathname.slice(prefix.length));
  const parts = relativePath.split("/");
  if (!relativePath || relativePath.includes("\\") || parts.some((part) => !part || part === "." || part === "..")) {
    throw migrationError("dogecloud_migration_asset_invalid");
  }
  const packageRoot = path.resolve(config.publicRoot, "packages");
  const sourcePath = path.resolve(packageRoot, ...parts);
  if (!sourcePath.startsWith(`${packageRoot}${path.sep}`) || !fs.statSync(sourcePath).isFile()) {
    throw migrationError("dogecloud_migration_asset_missing");
  }
  return { relativePath, sourcePath };
}

export async function migrateCatalogToDogeCloud({
  config = loadPublisherConfig(process.env),
  artifactPublisher = null,
} = {}) {
  const current = readCurrentCatalog(config.publicRoot, { signingKeyFile: config.signingKeyFile });
  const entries = [...current.components, ...current.skills];
  if (!entries.length) throw migrationError("dogecloud_migration_catalog_empty");
  const publisher = artifactPublisher ?? createDogeCloudArtifactPublisher({
    packageBaseUrl: config.packageBaseUrl,
  });
  const migrated = new Map();
  for (const entry of entries) {
    const local = localAsset(config, entry.assetUrl);
    const object = await publisher.publish({
      ...local,
      expectedSize: entry.size,
      expectedSha256: entry.sha256,
    });
    if (object.action === "local") throw migrationError("dogecloud_migration_publisher_disabled");
    migrated.set(entry, Object.freeze({ ...entry, assetUrl: object.url }));
  }
  const catalog = {
    schemaVersion: 1,
    components: current.components.map((entry) => migrated.get(entry)),
    skills: current.skills.map((entry) => migrated.get(entry)),
  };
  return replaceSignedCatalog({
    config,
    catalog,
    events: ["package_verified", "object_verified"],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw migrationError("publisher_argument_invalid");
  const result = await migrateCatalogToDogeCloud();
  console.log(JSON.stringify({ catalogPath: result.catalogPath, events: result.events }, null, 2));
}
