import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { compareVersions } from "../../shared/software-manager/catalog-schema.mjs";
import { readCurrentCatalog, replaceCatalogEntry, replaceSignedCatalog } from "./catalog-builder.mjs";
import { createDogeCloudArtifactPublisher } from "./dogecloud-artifact-publisher.mjs";
import { loadPublisherConfig } from "./publisher-config.mjs";
import { inspectGitRelease } from "./sync-git.mjs";
import { inspectV2RayNRelease } from "./sync-v2rayn.mjs";

function componentError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeSyncErrorCode(error) {
  const value = String(error?.code || error?.message || "");
  return /^[a-z0-9_]{1,80}$/u.test(value) ? value : "software_sync_failed";
}

export async function writeSoftwareSyncStatus({ filePath, workRoot, value } = {}) {
  const root = String(workRoot || "");
  const target = String(filePath || "");
  if (!root || !path.isAbsolute(root) || path.normalize(root) !== root
    || target !== path.join(root, "sync-status.json") || !value || typeof value !== "object") {
    throw componentError("software_sync_status_path_invalid");
  }
  await fsPromises.mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const handle = await fsPromises.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await fsPromises.unlink(temporary).catch(() => {});
    throw error;
  }
  await handle.close();
  try {
    await fsPromises.rename(temporary, target);
  } catch (error) {
    await fsPromises.unlink(temporary).catch(() => {});
    throw error;
  }
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function exactRelease(value) {
  if (!value || value.action !== "publish" || !["v2rayn", "git"].includes(value.id)
    || !/^\d+(?:\.\d+){0,3}$/u.test(value.version ?? "")
    || !["zip", "exe"].includes(value.format) || !path.isAbsolute(value.packagePath)
    || !Number.isSafeInteger(value.size) || value.size < 1
    || !/^[a-f0-9]{64}$/u.test(value.sha256 ?? "")
    || !Array.isArray(value.requiredFiles) || !value.requiredFiles.length
    || !Number.isSafeInteger(value.maxRelativePathLength) || value.maxRelativePathLength < 1) {
    throw componentError("software_sync_release_invalid");
  }
  if (value.id === "v2rayn" && (value.format !== "zip" || value.authenticity !== "pgp"
    || value.signingFingerprint !== "A4A69C432C532A5F21D0B6EE14162A209ADA306B")) {
    throw componentError("software_sync_release_authenticity_invalid");
  }
  if (value.id === "git" && (value.format !== "exe" || value.authenticode !== "Valid")) {
    throw componentError("software_sync_release_authenticity_invalid");
  }
  const stat = fs.statSync(value.packagePath);
  if (!stat.isFile() || stat.size !== value.size || hashFile(value.packagePath) !== value.sha256) {
    throw componentError("software_sync_release_binding_invalid");
  }
  return value;
}

function packageName(release) {
  return `${release.id}-${release.version}-x64-${release.sha256.slice(0, 12)}.${release.format}`;
}

function versionFromPackage(name, id, format) {
  const match = new RegExp(`^${id}-(\\d+(?:\\.\\d+){0,3})-x64-[a-f0-9]{12}\\.${format}$`, "u").exec(name);
  return match?.[1] || null;
}

async function retainPackages(directory, release, keepNames) {
  const candidates = (await fsPromises.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && versionFromPackage(entry.name, release.id, release.format))
    .map((entry) => entry.name)
    .sort((left, right) => compareVersions(
      versionFromPackage(right, release.id, release.format),
      versionFromPackage(left, release.id, release.format),
    ));
  const keep = new Set([...keepNames, ...candidates].filter(Boolean).slice(0, 2));
  for (const name of candidates) if (!keep.has(name)) await fsPromises.unlink(path.join(directory, name));
}

export async function publishComponentReleases({
  config,
  currentCatalog,
  releases,
  publishedAt = new Date().toISOString(),
  artifactPublisher = null,
} = {}) {
  if (!Array.isArray(releases) || !releases.length || !Number.isFinite(Date.parse(publishedAt))) {
    throw componentError("software_sync_release_batch_invalid");
  }
  const packageDirectory = path.join(config.publicRoot, "packages");
  await fsPromises.mkdir(packageDirectory, { recursive: true });
  const created = [];
  try {
    const packagePublisher = artifactPublisher ?? createDogeCloudArtifactPublisher({
      packageBaseUrl: config.packageBaseUrl,
    });
    for (const raw of releases) {
      const release = exactRelease(raw);
      const name = packageName(release);
      const destination = path.join(packageDirectory, name);
      try {
        await fsPromises.copyFile(release.packagePath, destination, fs.constants.COPYFILE_EXCL);
      } catch (error) {
        if (error?.code === "EEXIST") throw componentError("publisher_immutable_object_exists");
        throw error;
      }
      if (fs.statSync(destination).size !== release.size || hashFile(destination) !== release.sha256) {
        await fsPromises.unlink(destination);
        throw componentError("software_sync_published_asset_invalid");
      }
      const object = await packagePublisher.publish({
        sourcePath: destination,
        relativePath: name,
        expectedSize: release.size,
        expectedSha256: release.sha256,
      });
      created.push({ release, name, destination, object });
    }
    let next = currentCatalog;
    const previous = new Map();
    for (const item of created) {
      previous.set(item.release.id, path.basename(next.components.find((entry) => entry.id === item.release.id)?.assetUrl || ""));
      const displayName = item.release.id === "git" ? "Git" : "V2RayN";
      next = replaceCatalogEntry(next, { component: {
        id: item.release.id,
        name: displayName,
        version: item.release.version,
        architecture: "x64",
        format: item.release.format,
        assetUrl: item.object.url,
        size: item.release.size,
        sha256: item.release.sha256,
        entrypoint: item.release.entrypoint,
        requiredFiles: [...item.release.requiredFiles],
        maxRelativePathLength: item.release.maxRelativePathLength,
        publishedAt: new Date(publishedAt).toISOString(),
        supportsRollback: true,
      } });
    }
    const events = ["package_verified"];
    if (created.some(({ object }) => object.action !== "local")) events.push("object_verified");
    const result = await replaceSignedCatalog({ config, catalog: next, events });
    for (const item of created) {
      await retainPackages(packageDirectory, item.release, [item.name, previous.get(item.release.id)]);
    }
    return Object.freeze({
      ...result,
      packagePaths: Object.freeze(created.map((item) => item.destination)),
    });
  } catch (error) {
    for (const item of created) {
      await fsPromises.unlink(item.destination).catch((failure) => {
        if (failure?.code !== "ENOENT") throw failure;
      });
    }
    throw error;
  }
}

export async function syncComponents({
  config = null,
  currentCatalog = null,
  workRoot = process.env.CBI_SYNC_WORK_ROOT,
  sources = null,
  publisher = null,
  publishedAt = new Date().toISOString(),
  onProgress = null,
} = {}) {
  const resolvedConfig = config ?? (publisher ? null : loadPublisherConfig(process.env));
  const catalog = currentCatalog ?? readCurrentCatalog(resolvedConfig.publicRoot, {
    signingKeyFile: resolvedConfig.signingKeyFile,
  });
  const progress = onProgress ?? (process.env.CBI_SYNC_PROGRESS === "1" ? (event) => {
    if (event.downloadedBytes === event.totalBytes || event.downloadedBytes % (8 * 1024 * 1024) === 0) {
      process.stderr.write(`[software-sync] ${event.componentId} ${event.downloadedBytes}/${event.totalBytes}\n`);
    }
  } : null);
  const sourceSet = sources ?? {
    v2rayn: () => inspectV2RayNRelease({
      currentCatalog: catalog, workRoot: path.join(workRoot, "v2rayn"), onProgress: progress,
    }),
    git: () => inspectGitRelease({
      currentCatalog: catalog, workRoot: path.join(workRoot, "git"), onProgress: progress,
    }),
  };
  if (typeof sourceSet.v2rayn !== "function" || typeof sourceSet.git !== "function") {
    throw componentError("software_sync_sources_invalid");
  }
  const inspected = [];
  try {
    inspected.push(await sourceSet.v2rayn());
    inspected.push(await sourceSet.git());
    const releases = inspected.filter((item) => item?.action === "publish");
    if (!releases.length) return Object.freeze({ action: "noop", releases: Object.freeze(inspected) });
    const publish = publisher ?? ((input) => publishComponentReleases(input));
    const result = await publish({ config: resolvedConfig, currentCatalog: catalog, releases, publishedAt });
    return Object.freeze({ action: "published", releases: Object.freeze(inspected), result });
  } finally {
    for (const item of inspected) {
      if (typeof item?.packagePath === "string") await fsPromises.unlink(item.packagePath).catch(() => {});
      if (typeof item?.signaturePath === "string") await fsPromises.unlink(item.signaturePath).catch(() => {});
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const startedAt = new Date().toISOString();
  const statusFile = process.env.CBI_SYNC_STATUS_FILE;
  const writeStatus = async (value) => {
    if (!statusFile) return;
    try {
      await writeSoftwareSyncStatus({ filePath: statusFile, workRoot: process.env.CBI_SYNC_WORK_ROOT, value });
    } catch {
      process.stderr.write("[software-sync] status_file_write_failed\n");
    }
  };
  await writeStatus({ schemaVersion: 1, status: "running", startedAt });
  try {
    const result = await syncComponents();
    const releases = result.releases.map((item) => ({
      id: item.id, action: item.action, version: item.version, sha256: item.sha256,
    }));
    await writeStatus({
      schemaVersion: 1,
      status: "succeeded",
      startedAt,
      finishedAt: new Date().toISOString(),
      action: result.action,
      releases,
    });
    console.log(JSON.stringify({ action: result.action, releases }, null, 2));
  } catch (error) {
    await writeStatus({
      schemaVersion: 1,
      status: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      errorCode: safeSyncErrorCode(error),
    });
    throw error;
  }
}
