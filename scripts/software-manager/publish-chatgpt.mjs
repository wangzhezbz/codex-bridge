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
import { createGreenCodexDirectory, verifyGreenCodexDirectory } from "./chatgpt-green-converter.mjs";
import { hashPackageTree } from "./chatgpt-green-metadata.mjs";
import { inspectPackageTree, writeImmutableStoredZip } from "./package-inspector.mjs";
import { loadPublisherConfig } from "./publisher-config.mjs";
import { removeOwnedTemporaryDirectory } from "../smoke-temp-cleanup.mjs";

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

function exists(filePath) {
  try { fs.lstatSync(filePath); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function readSmokeReport(reportPath, built) {
  if (!reportPath) throw publishError("publisher_green_smoke_required");
  const target = exactInput(reportPath);
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) { throw publishError("publisher_green_smoke_required", error); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 256 * 1024) {
    throw publishError("publisher_green_smoke_invalid");
  }
  let value;
  try { value = JSON.parse(fs.readFileSync(target, "utf8")); }
  catch (error) { throw publishError("publisher_green_smoke_invalid", error); }
  const expectedKeys = [
    "schemaVersion", "ok", "checkedAt", "officialVersion", "contentTreeSha256",
    "shellTemplateSha256", "processEvidence", "pageEvidence", "cleanupEvidence",
  ];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== expectedKeys.sort().join("\0")
    || value.schemaVersion !== 1 || value.ok !== true || !Number.isFinite(Date.parse(value.checkedAt ?? ""))
    || value.officialVersion !== built.officialVersion
    || value.contentTreeSha256 !== built.contentTreeSha256
    || value.shellTemplateSha256 !== built.owlTemplateSha256
    || value.cleanupEvidence?.processTreeExited !== true
    || value.cleanupEvidence?.userDataRemoved !== true) {
    throw publishError("publisher_green_smoke_mismatch");
  }
  return value;
}

async function prepareChatGPTSource({
  source, runtimeTemplatePath, verifyAuthenticode, version, versionInspector, workRoot,
}) {
  const markerPath = path.join(source, ".codexbridge-green-codex.json");
  if (exists(markerPath)) {
    const built = await verifyGreenCodexDirectory({ inputPath: source });
    if (version && version !== built.officialVersion) throw publishError("publisher_chatgpt_version_invalid");
    return Object.freeze({ root: source, built, version: built.officialVersion, modern: true, converted: false });
  }
  if (exists(path.join(source, "AppxManifest.xml"))) {
    if (!runtimeTemplatePath) throw publishError("publisher_green_template_required");
    const workingDirectory = exactInput(workRoot);
    fs.mkdirSync(workingDirectory, { recursive: true });
    const workStat = fs.lstatSync(workingDirectory);
    if (!workStat.isDirectory() || workStat.isSymbolicLink()) {
      throw publishError("publisher_green_work_root_invalid");
    }
    const temporaryRoot = path.join(workingDirectory, `.codex-green-publish-${crypto.randomUUID()}`);
    const built = await createGreenCodexDirectory({
      inputPath: source,
      runtimeTemplatePath: exactInput(runtimeTemplatePath),
      outputPath: temporaryRoot,
      verifyAuthenticode,
    });
    if (version && version !== built.officialVersion) {
      removeOwnedTemporaryDirectory(temporaryRoot, {
        parentDirectory: workingDirectory, requiredPrefix: ".codex-green-publish-",
      });
      throw publishError("publisher_chatgpt_version_invalid");
    }
    return Object.freeze({
      root: temporaryRoot,
      workRoot: workingDirectory,
      built,
      version: built.officialVersion,
      modern: true,
      converted: true,
    });
  }

  const tree = inspectPackageTree(source);
  if (!tree.files.includes("ChatGPT.exe")) throw publishError("publisher_chatgpt_entrypoint_missing");
  const inspectedVersion = String(await versionInspector(path.join(source, "ChatGPT.exe"))).trim();
  const selectedVersion = String(version || inspectedVersion).trim();
  if (!VERSION.test(selectedVersion) || inspectedVersion !== selectedVersion) {
    throw publishError("publisher_chatgpt_version_invalid");
  }
  return Object.freeze({
    root: source,
    tree,
    version: selectedVersion,
    modern: false,
    converted: false,
    built: Object.freeze({
      officialVersion: selectedVersion,
      contentTreeSha256: hashPackageTree(source),
      owlTemplateSha256: sha256File(path.join(source, "ChatGPT.exe")),
    }),
  });
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
  runtimeTemplatePath = "",
  smokeReportPath = "",
  verifyAuthenticode,
  workRoot = "",
  artifactPublisher = null,
} = {}) {
  const source = exactInput(inputPath);
  if (!validPublishedAt(publishedAt)) throw publishError("publisher_published_at_invalid");
  const prepared = await prepareChatGPTSource({
    source,
    runtimeTemplatePath,
    verifyAuthenticode,
    version,
    versionInspector,
    workRoot: workRoot ? exactInput(workRoot) : path.join(config.publicRoot, ".green-work"),
  });
  let packagePath = "";
  let packageCreated = false;
  try {
    const events = [];
    if (prepared.converted) events.push("green_converted");
    if (prepared.modern) {
      events.push("green_verified");
      readSmokeReport(smokeReportPath, prepared.built);
      events.push("green_smoke_verified");
    }
    const tree = prepared.tree ?? inspectPackageTree(prepared.root);
    const packageDirectory = path.join(config.publicRoot, "packages");
    const packageName = `chatgpt-${prepared.version}-x64.zip`;
    packagePath = path.join(packageDirectory, packageName);
    await writeImmutableStoredZip({ tree, destination: packagePath });
    packageCreated = true;
    const size = fs.statSync(packagePath).size;
    const sha256 = sha256File(packagePath);
    events.push("package_verified");
    const stored = await (artifactPublisher ?? createDogeCloudArtifactPublisher({
      packageBaseUrl: config.packageBaseUrl,
    })).publish({
      sourcePath: packagePath,
      relativePath: packageName,
      expectedSize: size,
      expectedSha256: sha256,
    });
    if (!stored || stored.size !== size || stored.sha256 !== sha256
      || typeof stored.url !== "string" || !stored.url) {
      throw publishError("publisher_object_verification_failed");
    }
    if (prepared.modern || stored.action !== "local") events.push("object_verified");
    const current = readCurrentCatalog(config.publicRoot, { signingKeyFile: config.signingKeyFile });
    const previousName = path.basename(current.components.find((item) => item.id === "chatgpt")?.assetUrl || "");
    const component = {
      id: "chatgpt",
      name: "ChatGPT",
      version: prepared.version,
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
    const result = await replaceSignedCatalog({
      config,
      catalog: replaceCatalogEntry(current, { component }),
      events,
    });
    await retainChatGPTPackages(packageDirectory, [packageName, previousName]);
    return Object.freeze({ ...result, packagePath, component: Object.freeze(component) });
  } catch (error) {
    if (packageCreated) await fsPromises.unlink(packagePath).catch((failure) => {
      if (failure?.code !== "ENOENT") throw failure;
    });
    throw error;
  } finally {
    if (prepared.converted && exists(prepared.root)) {
      removeOwnedTemporaryDirectory(prepared.root, {
        parentDirectory: prepared.workRoot, requiredPrefix: ".codex-green-publish-",
      });
    }
  }
}

function args(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--input") result.inputPath = values[++index];
    else if (values[index] === "--version") result.version = values[++index];
    else if (values[index] === "--runtime-template") result.runtimeTemplatePath = values[++index];
    else if (values[index] === "--smoke-report") result.smokeReportPath = values[++index];
    else if (values[index] === "--published-at") result.publishedAt = values[++index];
    else throw publishError("publisher_argument_invalid");
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await publishChatGPT(args(process.argv.slice(2)));
  console.log(JSON.stringify({ packagePath: result.packagePath, catalogPath: result.catalogPath }, null, 2));
}
