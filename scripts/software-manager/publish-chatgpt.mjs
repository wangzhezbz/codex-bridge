import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { compareVersions } from "../../shared/software-manager/catalog-schema.mjs";
import { replaceCatalogEntry, readCurrentCatalog, replaceSignedCatalog } from "./catalog-builder.mjs";
import { createDogeCloudArtifactPublisher } from "./dogecloud-artifact-publisher.mjs";
import { inspectPackageTree, writeImmutableStoredZip } from "./package-inspector.mjs";
import { loadPublisherConfig } from "./publisher-config.mjs";

const execFileAsync = promisify(execFile);
const VERSION = /^\d+(?:\.\d+){0,3}$/u;

function publishError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function exactInput(value) {
  const raw = String(value || "");
  const inputPath = path.resolve(raw);
  if (!raw || !path.isAbsolute(raw) || path.normalize(raw) !== raw) {
    throw publishError("publisher_chatgpt_input_invalid");
  }
  return inputPath;
}

async function defaultVersionInspector(entrypoint) {
  const command = [
    "$ErrorActionPreference='Stop'",
    "$item=Get-Item -LiteralPath $env:CBI_CHATGPT_ENTRYPOINT",
    "[Console]::Out.Write($item.VersionInfo.FileVersion)",
  ].join(";");
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command,
  ], {
    env: { ...process.env, CBI_CHATGPT_ENTRYPOINT: entrypoint },
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 64 * 1024,
  });
  return String(stdout).trim();
}

function validPublishedAt(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function packageVersion(name) {
  const match = /^chatgpt-(\d+(?:\.\d+){0,3})-x64\.zip$/u.exec(name);
  return match?.[1] || null;
}

async function retainChatGPTPackages(directory, keepNames) {
  const candidates = (await fsPromises.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && packageVersion(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => compareVersions(packageVersion(right), packageVersion(left)));
  const keep = new Set([...keepNames, ...candidates].filter(Boolean).slice(0, 2));
  for (const name of candidates) {
    if (!keep.has(name)) await fsPromises.unlink(path.join(directory, name));
  }
}

export async function publishChatGPT({
  config = loadPublisherConfig(process.env),
  inputPath,
  version = "",
  publishedAt = new Date().toISOString(),
  versionInspector = defaultVersionInspector,
  artifactPublisher = null,
} = {}) {
  const source = exactInput(inputPath);
  const tree = inspectPackageTree(source);
  if (!tree.files.includes("ChatGPT.exe")) throw publishError("publisher_chatgpt_entrypoint_missing");
  const inspectedVersion = String(await versionInspector(path.join(source, "ChatGPT.exe"))).trim();
  const selectedVersion = String(version || inspectedVersion).trim();
  if (!VERSION.test(selectedVersion) || inspectedVersion !== selectedVersion) {
    throw publishError("publisher_chatgpt_version_invalid");
  }
  if (!validPublishedAt(publishedAt)) throw publishError("publisher_published_at_invalid");
  const packageDirectory = path.join(config.publicRoot, "packages");
  const packageName = `chatgpt-${selectedVersion}-x64.zip`;
  const packagePath = path.join(packageDirectory, packageName);
  await writeImmutableStoredZip({ tree, destination: packagePath });
  const size = fs.statSync(packagePath).size;
  const sha256 = sha256File(packagePath);
  const events = ["package_verified"];
  const stored = await (artifactPublisher ?? createDogeCloudArtifactPublisher({
    packageBaseUrl: config.packageBaseUrl,
  })).publish({
    sourcePath: packagePath,
    relativePath: packageName,
    expectedSize: size,
    expectedSha256: sha256,
  });
  if (stored.action !== "local") events.push("object_verified");
  const current = readCurrentCatalog(config.publicRoot, { signingKeyFile: config.signingKeyFile });
  const previousName = path.basename(current.components.find((item) => item.id === "chatgpt")?.assetUrl || "");
  const component = {
    id: "chatgpt",
    name: "ChatGPT",
    version: selectedVersion,
    architecture: "x64",
    format: "zip",
    assetUrl: stored.url,
    size,
    sha256,
    entrypoint: "ChatGPT.exe",
    requiredFiles: [...tree.files],
    maxRelativePathLength: tree.maxRelativePathLength,
    publishedAt: new Date(publishedAt).toISOString(),
    supportsRollback: true,
  };
  try {
    const result = await replaceSignedCatalog({
      config,
      catalog: replaceCatalogEntry(current, { component }),
      events,
    });
    await retainChatGPTPackages(packageDirectory, [packageName, previousName]);
    return Object.freeze({ ...result, packagePath, component: Object.freeze(component) });
  } catch (error) {
    await fsPromises.unlink(packagePath).catch((failure) => {
      if (failure?.code !== "ENOENT") throw failure;
    });
    throw error;
  }
}

function args(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--input") result.inputPath = values[++index];
    else if (values[index] === "--version") result.version = values[++index];
    else if (values[index] === "--published-at") result.publishedAt = values[++index];
    else throw publishError("publisher_argument_invalid");
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await publishChatGPT(args(process.argv.slice(2)));
  console.log(JSON.stringify({ packagePath: result.packagePath, catalogPath: result.catalogPath }, null, 2));
}
