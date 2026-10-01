import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { extractFile, getRawHeader, listPackage } from "@electron/asar";

import { inspectPackageTree } from "./package-inspector.mjs";

const OFFICIAL_IDENTITY = "OpenAI.Codex";
const OFFICIAL_PUBLISHER = "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B";
const OFFICIAL_ENTRYPOINT = "app/ChatGPT.exe";
const CODEX_VERSION = /^\d+(?:\.\d+){3}$/u;
const ELECTRON_VERSION = /^\d+(?:\.\d+){2,3}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_GREEN_MARKER_BYTES = 4 * 1024;
const GREEN_MARKER = ".codexbridge-green-codex.json";
const TEMPLATE_MARKER = ".codexbridge-green-runtime-template.json";
const PORTABLE_PATCH_DISABLE_APP_CONTAINED_CORE = "disable-app-contained-core";
const PORTABLE_OVERRIDE_TARGETS = new Set([
  "resources/native/windows-account.node",
  "resources/native/windows-updater.node",
]);
const PORTABLE_PATCH_IDS = new Set([
  PORTABLE_PATCH_DISABLE_APP_CONTAINED_CORE,
  "replace-windows-account-native",
  "replace-windows-updater-native",
  "rebind-embedded-asar-integrity",
  "bridge-api-quota-compat-v1",
]);

function greenError(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function plainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  return plainRecord(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function absoluteDirectory(value, code) {
  const raw = String(value || "");
  const resolved = path.resolve(raw);
  if (!raw || !path.isAbsolute(raw) || path.normalize(raw) !== raw) throw greenError(code);
  let stat;
  try { stat = fs.lstatSync(resolved); } catch (error) { throw greenError(code, error); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw greenError(code);
  return resolved;
}

function safeRelative(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096
    && !value.includes("\\") && !value.startsWith("/")
    && value.split("/").every((part) => part && part !== "." && part !== "..");
}

function exactFile(root, relativePath, code) {
  if (!safeRelative(relativePath)) throw greenError(code);
  const filePath = path.join(root, ...relativePath.split("/"));
  let stat;
  try { stat = fs.lstatSync(filePath); } catch (error) { throw greenError(code, error); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw greenError(code);
  return filePath;
}

function exactDirectory(root, relativePath, code) {
  if (!safeRelative(relativePath)) throw greenError(code);
  const directoryPath = path.join(root, ...relativePath.split("/"));
  let stat;
  try { stat = fs.lstatSync(directoryPath); } catch (error) { throw greenError(code, error); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw greenError(code);
  return directoryPath;
}

function readBounded(filePath, maximum, code) {
  let stat;
  try { stat = fs.lstatSync(filePath); } catch (error) { throw greenError(code, error); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximum) {
    throw greenError(code);
  }
  try { return fs.readFileSync(filePath); } catch (error) { throw greenError(code, error); }
}

function parseJsonFile(filePath, maximum, code) {
  try {
    const value = JSON.parse(readBounded(filePath, maximum, code).toString("utf8"));
    if (!plainRecord(value)) throw greenError(code);
    return value;
  } catch (error) {
    if (error?.code === code) throw error;
    throw greenError(code, error);
  }
}

function attributes(source, code) {
  const result = Object.create(null);
  const expression = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
  for (const match of source.matchAll(expression)) {
    if (Object.hasOwn(result, match[1])) throw greenError(code);
    result[match[1]] = match[2] ?? match[3] ?? "";
  }
  return result;
}

function singleTag(xml, localName, code, predicate = () => true) {
  const expression = new RegExp(`<(?:(?:[A-Za-z_][\\w.-]*):)?${localName}\\b([^>]*)\\/?\\s*>`, "gu");
  const matches = [...xml.matchAll(expression)]
    .map((match) => attributes(match[1], code))
    .filter(predicate);
  if (matches.length !== 1) throw greenError(code);
  return matches[0];
}

function parseOfficialManifest(filePath) {
  const xml = readBounded(filePath, MAX_MANIFEST_BYTES, "green_official_manifest_invalid").toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) throw greenError("green_official_manifest_invalid");
  const identity = singleTag(xml, "Identity", "green_official_manifest_invalid");
  const family = singleTag(
    xml,
    "TargetDeviceFamily",
    "green_official_manifest_invalid",
    (value) => value.Name === "Windows.Desktop",
  );
  const application = singleTag(
    xml,
    "Application",
    "green_official_manifest_invalid",
    (value) => value.Id === "App",
  );
  if (identity.Name !== OFFICIAL_IDENTITY || identity.Publisher !== OFFICIAL_PUBLISHER
    || !CODEX_VERSION.test(identity.Version ?? "")) throw greenError("green_official_identity_invalid");
  if (identity.ProcessorArchitecture !== "x64") throw greenError("green_official_architecture_invalid");
  if (application.Executable?.replaceAll("\\", "/") !== OFFICIAL_ENTRYPOINT
    || application.EntryPoint !== "Windows.FullTrustApplication") {
    throw greenError("green_official_manifest_invalid");
  }
  if (!CODEX_VERSION.test(family.MinVersion ?? "")) throw greenError("green_official_manifest_invalid");
  return Object.freeze({ identity, family, application });
}

function signatureStatus(value) {
  return typeof value === "string" ? value : value?.status;
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function readAsarPackage(appAsarPath, code) {
  try {
    const value = JSON.parse(extractFile(appAsarPath, "package.json").toString("utf8"));
    if (!plainRecord(value)) throw greenError(code);
    const electronVersion = value.devDependencies?.electron ?? value.dependencies?.electron;
    if (!ELECTRON_VERSION.test(electronVersion ?? "")) throw greenError(code);
    const appContainedCore = value.codexWindowsAppContainedCore;
    if (appContainedCore !== undefined && !["0", "1"].includes(appContainedCore)) throw greenError(code);
    return Object.freeze({ value, electronVersion, appContainedCore: appContainedCore ?? null });
  } catch (error) {
    if (error?.code === code) throw error;
    throw greenError(code, error);
  }
}

export function collectOwlAppApiSurface(appAsarPath) {
  const result = new Set();
  let files;
  try { files = listPackage(appAsarPath); } catch (error) { throw greenError("green_app_asar_invalid", error); }
  for (const archivePath of files.filter((item) => /^\\?\.vite\\build\\.*\.js$/iu.test(item))) {
    let source;
    try { source = extractFile(appAsarPath, archivePath.replace(/^\\/u, "")).toString("utf8"); }
    catch (error) { throw greenError("green_app_asar_invalid", error); }
    for (const match of source.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*\.app\.([A-Za-z_$][A-Za-z0-9_$]*)/gu)) {
      result.add(match[1]);
    }
  }
  return Object.freeze([...result].sort());
}

export function hashPackageTree(rootPath, { exclude = [] } = {}) {
  const tree = inspectPackageTree(rootPath);
  const excluded = new Set(exclude.map((item) => String(item).toLocaleLowerCase("en-US")));
  const hash = crypto.createHash("sha256");
  for (const entry of tree.entries) {
    if (excluded.has(entry.path.toLocaleLowerCase("en-US"))) continue;
    hash.update(entry.path, "utf8");
    hash.update("\0");
    hash.update(String(entry.size), "utf8");
    hash.update("\0");
    hash.update(sha256File(entry.absolute), "ascii");
    hash.update("\n");
  }
  return hash.digest("hex");
}

function looksLikeOfficialRoot(root) {
  try {
    return fs.lstatSync(path.join(root, "AppxManifest.xml")).isFile()
      && fs.lstatSync(path.join(root, "app", "ChatGPT.exe")).isFile();
  } catch {
    return false;
  }
}

export function resolveOfficialCodexRoot(inputPath) {
  const root = absoluteDirectory(inputPath, "green_official_root_invalid");
  if (looksLikeOfficialRoot(root)) return root;
  const candidates = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => path.join(root, entry.name))
    .filter(looksLikeOfficialRoot);
  if (candidates.length > 1) throw greenError("green_official_root_ambiguous");
  if (candidates.length !== 1) throw greenError("green_official_root_missing");
  return candidates[0];
}

export async function inspectOfficialCodexPackage({ inputPath, verifyAuthenticode } = {}) {
  if (typeof verifyAuthenticode !== "function") throw greenError("green_signature_verifier_required");
  const packageRoot = resolveOfficialCodexRoot(inputPath);
  const appxManifestPath = exactFile(packageRoot, "AppxManifest.xml", "green_official_layout_invalid");
  const appxSignaturePath = exactFile(packageRoot, "AppxSignature.p7x", "green_official_layout_invalid");
  const entrypointPath = exactFile(packageRoot, OFFICIAL_ENTRYPOINT, "green_official_layout_invalid");
  const resourcesRoot = exactDirectory(packageRoot, "app/resources", "green_official_layout_invalid");
  const appAsarPath = exactFile(packageRoot, "app/resources/app.asar", "green_official_layout_invalid");
  exactDirectory(packageRoot, "app/resources/app.asar.unpacked", "green_official_layout_invalid");
  exactFile(packageRoot, "app/resources/codex.exe", "green_official_layout_invalid");
  const [signature, entrypointSignature] = await Promise.all([
    verifyAuthenticode(appxSignaturePath),
    verifyAuthenticode(entrypointPath),
  ]);
  if (signatureStatus(signature) !== "Valid" || signatureStatus(entrypointSignature) !== "Valid") {
    throw greenError("green_official_signature_invalid");
  }
  const manifest = parseOfficialManifest(appxManifestPath);
  const { electronVersion, appContainedCore } = readAsarPackage(appAsarPath, "green_official_app_asar_invalid");
  return Object.freeze({
    packageRoot,
    officialVersion: manifest.identity.Version,
    packageIdentity: manifest.identity.Name,
    packagePublisher: manifest.identity.Publisher,
    architecture: manifest.identity.ProcessorArchitecture,
    appId: manifest.application.Id,
    entrypointRelative: OFFICIAL_ENTRYPOINT,
    resourcesRoot,
    appAsarPath,
    electronVersion,
    portablePatchIds: Object.freeze(appContainedCore === "1"
      ? [PORTABLE_PATCH_DISABLE_APP_CONTAINED_CORE]
      : []),
    owlAppApis: collectOwlAppApiSurface(appAsarPath),
    sourceTreeSha256: hashPackageTree(packageRoot),
  });
}

function validateTemplateDescriptor(value) {
  const versionOneKeys = [
    "schemaVersion", "templateVersion", "architecture", "electronVersion", "minimumWindowsBuild",
    "supportedOwlAppApis", "requiredShellFiles", "acceptanceId",
  ];
  const versionTwoKeys = [...versionOneKeys, "resourceOverrides"];
  const versionThreeKeys = [...versionTwoKeys, "embeddedAsarIntegrity"];
  const schemaValid = value.schemaVersion === 1
    ? exactKeys(value, versionOneKeys)
    : value.schemaVersion === 2 && exactKeys(value, versionTwoKeys)
      && Array.isArray(value.resourceOverrides);
  const schemaThreeValid = value.schemaVersion === 3
    && exactKeys(value, versionThreeKeys)
    && Array.isArray(value.resourceOverrides)
    && value.embeddedAsarIntegrity === false;
  if (!(schemaValid || schemaThreeValid) || !CODEX_VERSION.test(value.templateVersion ?? "")
    || value.architecture !== "x64" || !ELECTRON_VERSION.test(value.electronVersion ?? "")
    || !Number.isSafeInteger(value.minimumWindowsBuild) || value.minimumWindowsBuild < 1
    || !Array.isArray(value.supportedOwlAppApis) || value.supportedOwlAppApis.some((item) => typeof item !== "string")
    || [...new Set(value.supportedOwlAppApis)].sort().join("\0") !== [...value.supportedOwlAppApis].sort().join("\0")
    || !Array.isArray(value.requiredShellFiles) || value.requiredShellFiles.length === 0
    || typeof value.acceptanceId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.acceptanceId)) {
    throw greenError("green_template_descriptor_invalid");
  }
  for (const file of value.requiredShellFiles) {
    if (!exactKeys(file, ["relativePath", "sha256"]) || !safeRelative(file.relativePath)
      || file.relativePath.toLocaleLowerCase("en-US").startsWith("resources/") || !SHA256.test(file.sha256 ?? "")) {
      throw greenError("green_template_descriptor_invalid");
    }
  }
  const foldedFiles = value.requiredShellFiles.map((file) => file.relativePath.toLocaleLowerCase("en-US"));
  if (new Set(foldedFiles).size !== foldedFiles.length) throw greenError("green_template_descriptor_invalid");
  const overrides = value.schemaVersion >= 2 ? value.resourceOverrides : [];
  const overrideSources = new Set();
  const overrideTargets = new Set();
  for (const item of overrides) {
    if (!exactKeys(item, ["sourceRelativePath", "targetRelativePath"])
      || !safeRelative(item.sourceRelativePath) || !safeRelative(item.targetRelativePath)
      || !item.sourceRelativePath.toLocaleLowerCase("en-US").startsWith("portable-overrides/")
      || !PORTABLE_OVERRIDE_TARGETS.has(item.targetRelativePath)
      || !foldedFiles.includes(item.sourceRelativePath.toLocaleLowerCase("en-US"))) {
      throw greenError("green_template_descriptor_invalid");
    }
    overrideSources.add(item.sourceRelativePath.toLocaleLowerCase("en-US"));
    overrideTargets.add(item.targetRelativePath.toLocaleLowerCase("en-US"));
  }
  if (overrideSources.size !== overrides.length || overrideTargets.size !== overrides.length) {
    throw greenError("green_template_descriptor_invalid");
  }
  return value;
}

function digestNamedFiles(root, files) {
  const hash = crypto.createHash("sha256");
  for (const item of [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"))) {
    hash.update(item.relativePath, "utf8");
    hash.update("\0");
    hash.update(item.sha256, "ascii");
    hash.update("\n");
  }
  return hash.digest("hex");
}

export async function inspectGreenRuntimeTemplate({ templatePath, verifyAuthenticode } = {}) {
  if (typeof verifyAuthenticode !== "function") throw greenError("green_signature_verifier_required");
  const templateRoot = absoluteDirectory(templatePath, "green_template_root_invalid");
  const descriptor = validateTemplateDescriptor(parseJsonFile(
    exactFile(templateRoot, TEMPLATE_MARKER, "green_template_descriptor_invalid"),
    MAX_JSON_BYTES,
    "green_template_descriptor_invalid",
  ));
  const declaredFiles = new Set(descriptor.requiredShellFiles.map(
    (item) => item.relativePath.toLocaleLowerCase("en-US"),
  ));
  const copiedShellFiles = inspectPackageTree(templateRoot).entries
    .map((entry) => entry.path)
    .filter((relativePath) => {
      const folded = relativePath.toLocaleLowerCase("en-US");
      return folded !== TEMPLATE_MARKER.toLocaleLowerCase("en-US")
        && folded !== GREEN_MARKER.toLocaleLowerCase("en-US")
        && folded !== ".codexbridge-chatgpt-version.json"
        && !folded.startsWith("resources/");
    });
  if (copiedShellFiles.length !== declaredFiles.size
    || copiedShellFiles.some((relativePath) => !declaredFiles.has(relativePath.toLocaleLowerCase("en-US")))) {
    throw greenError("green_template_unpinned_file");
  }
  for (const item of descriptor.requiredShellFiles) {
    const filePath = exactFile(templateRoot, item.relativePath, "green_template_layout_invalid");
    if (sha256File(filePath) !== item.sha256) throw greenError("green_template_hash_mismatch");
  }
  for (const required of ["ChatGPT.exe", "chrome.dll", "owl-shell-runtime.json"]) {
    if (!descriptor.requiredShellFiles.some((item) => item.relativePath === required)) {
      throw greenError("green_template_layout_invalid");
    }
  }
  if (signatureStatus(await verifyAuthenticode(path.join(templateRoot, "ChatGPT.exe"))) !== "Valid") {
    throw greenError("green_template_signature_invalid");
  }
  const resourceOverrides = descriptor.schemaVersion >= 2 ? descriptor.resourceOverrides : [];
  for (const item of resourceOverrides) {
    if (signatureStatus(await verifyAuthenticode(path.join(
      templateRoot, ...item.sourceRelativePath.split("/"),
    ))) !== "Valid") {
      throw greenError("green_template_signature_invalid");
    }
  }
  const baselineAsar = exactFile(templateRoot, "resources/app.asar", "green_template_layout_invalid");
  const { electronVersion } = readAsarPackage(baselineAsar, "green_template_app_asar_invalid");
  if (electronVersion !== descriptor.electronVersion) throw greenError("green_template_electron_mismatch");
  const appAsarHeaderSha256 = crypto.createHash("sha256")
    .update(getRawHeader(baselineAsar).headerString).digest("hex");
  const shellBytes = readBounded(
    path.join(templateRoot, "ChatGPT.exe"),
    32 * 1024 * 1024,
    "green_template_integrity_binding_invalid",
  );
  const embedded = Buffer.from(appAsarHeaderSha256, "ascii");
  const embeddedAt = shellBytes.indexOf(embedded);
  const requiresEmbeddedAsarRebind = descriptor.schemaVersion < 3;
  if ((requiresEmbeddedAsarRebind
    && (embeddedAt < 0 || shellBytes.indexOf(embedded, embeddedAt + 1) >= 0))
    || (!requiresEmbeddedAsarRebind && embeddedAt >= 0)) {
    throw greenError("green_template_integrity_binding_invalid");
  }
  return Object.freeze({
    templateRoot,
    templateVersion: descriptor.templateVersion,
    architecture: descriptor.architecture,
    electronVersion: descriptor.electronVersion,
    appAsarHeaderSha256,
    requiresEmbeddedAsarRebind,
    minimumWindowsBuild: descriptor.minimumWindowsBuild,
    supportedOwlAppApis: Object.freeze([...descriptor.supportedOwlAppApis].sort()),
    shellTreeSha256: digestNamedFiles(templateRoot, descriptor.requiredShellFiles),
    requiredShellFiles: Object.freeze(descriptor.requiredShellFiles.map((item) => Object.freeze({ ...item }))),
    resourceOverrides: Object.freeze(resourceOverrides.map((item) => Object.freeze({ ...item }))),
    acceptanceId: descriptor.acceptanceId,
  });
}

export function assertGreenRuntimeCompatible(official, template) {
  if (!plainRecord(official) || !plainRecord(template)) throw greenError("green_compatibility_input_invalid");
  if (official.architecture !== template.architecture) throw greenError("green_architecture_unsupported");
  if (official.electronVersion !== template.electronVersion) throw greenError("green_electron_version_unsupported");
  if (official.officialVersion !== template.templateVersion) throw greenError("green_template_version_mismatch");
  const supported = new Set(template.supportedOwlAppApis);
  if (official.owlAppApis.some((item) => !supported.has(item))) throw greenError("green_owl_api_unsupported");
  if (official.portablePatchIds.includes(PORTABLE_PATCH_DISABLE_APP_CONTAINED_CORE)) {
    const targets = new Set(template.resourceOverrides.map((item) => item.targetRelativePath));
    if ([...PORTABLE_OVERRIDE_TARGETS].some((target) => !targets.has(target))) {
      throw greenError("green_portable_override_required");
    }
  }
  return Object.freeze({ compatible: true, electronVersion: official.electronVersion });
}

export function readGreenCodexMarker(rootPath) {
  const root = absoluteDirectory(rootPath, "green_marker_root_invalid");
  const value = parseJsonFile(
    exactFile(root, GREEN_MARKER, "green_marker_invalid"),
    MAX_GREEN_MARKER_BYTES,
    "green_marker_invalid",
  );
  const versionOneKeys = [
    "schemaVersion", "formatVersion", "componentId", "officialVersion", "electronVersion",
    "officialResourceTreeSha256", "owlTemplateVersion", "owlTemplateSha256", "contentTreeSha256", "generatedAt",
  ];
  const versionTwoKeys = [
    ...versionOneKeys,
    "portableResourceTreeSha256", "portablePatchIds",
  ];
  const formatValid = value.formatVersion === 1
    ? exactKeys(value, versionOneKeys)
    : value.formatVersion === 2 && exactKeys(value, versionTwoKeys)
      && SHA256.test(value.portableResourceTreeSha256 ?? "")
      && Array.isArray(value.portablePatchIds)
      && value.portablePatchIds.every((item) => PORTABLE_PATCH_IDS.has(item))
      && new Set(value.portablePatchIds).size === value.portablePatchIds.length;
  if (!formatValid || value.schemaVersion !== 1
    || value.componentId !== "chatgpt" || !CODEX_VERSION.test(value.officialVersion ?? "")
    || !ELECTRON_VERSION.test(value.electronVersion ?? "") || !CODEX_VERSION.test(value.owlTemplateVersion ?? "")
    || !SHA256.test(value.officialResourceTreeSha256 ?? "") || !SHA256.test(value.owlTemplateSha256 ?? "")
    || !SHA256.test(value.contentTreeSha256 ?? "") || !Number.isFinite(Date.parse(value.generatedAt ?? ""))) {
    throw greenError("green_marker_invalid");
  }
  return Object.freeze({ ...value });
}
