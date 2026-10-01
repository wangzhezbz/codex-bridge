import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { extractFile, getRawHeader, uncacheAll } from "@electron/asar";

import {
  assertGreenRuntimeCompatible,
  hashPackageTree,
  inspectGreenRuntimeTemplate,
  inspectOfficialCodexPackage,
  readGreenCodexMarker,
} from "./chatgpt-green-metadata.mjs";
import { inspectPackageTree } from "./package-inspector.mjs";
import { removeOwnedTemporaryDirectory } from "../smoke-temp-cleanup.mjs";

const LEGACY_MARKER = ".codexbridge-chatgpt-version.json";
const GREEN_MARKER = ".codexbridge-green-codex.json";
const TEMPLATE_MARKER = ".codexbridge-green-runtime-template.json";
const MARKERS = Object.freeze([LEGACY_MARKER, GREEN_MARKER]);
const VERSION = /^\d+(?:\.\d+){3}$/u;
const PORTABLE_PATCH_DISABLE_APP_CONTAINED_CORE = "disable-app-contained-core";
const PORTABLE_OVERRIDE_PATCH_IDS = Object.freeze({
  "resources/native/windows-account.node": "replace-windows-account-native",
  "resources/native/windows-updater.node": "replace-windows-updater-native",
});
const PORTABLE_PATCH_REBIND_ASAR_INTEGRITY = "rebind-embedded-asar-integrity";

function greenError(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function absolutePath(value, code) {
  const raw = String(value || "");
  if (!raw || !path.isAbsolute(raw) || path.normalize(raw) !== raw) throw greenError(code);
  return path.resolve(raw);
}

function pathExists(value) {
  try { fs.lstatSync(value); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function boundedJson(filePath, maximum, code) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximum) throw greenError(code);
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw greenError(code);
    return value;
  } catch (error) {
    if (error?.code === code) throw error;
    throw greenError(code, error);
  }
}

function exactKeys(value, keys) {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function assertRealFile(filePath, code) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw greenError(code);
  } catch (error) {
    if (error?.code === code) throw error;
    throw greenError(code, error);
  }
}

function assertRealDirectory(directoryPath, code) {
  try {
    const stat = fs.lstatSync(directoryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw greenError(code);
  } catch (error) {
    if (error?.code === code) throw error;
    throw greenError(code, error);
  }
}

function copyEntries(tree, destination, include) {
  for (const entry of tree.entries) {
    if (!include(entry.path)) continue;
    const destinationPath = path.join(destination, ...entry.path.split("/"));
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(entry.absolute, destinationPath, fs.constants.COPYFILE_EXCL);
  }
}

function writeNewJson(filePath, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const descriptor = fs.openSync(filePath, "wx", 0o644);
  try { fs.writeFileSync(descriptor, serialized, "utf8"); } finally { fs.closeSync(descriptor); }
}

function sha256Bytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function patchAppContainedCore(appAsarPath) {
  uncacheAll();
  const rawHeader = getRawHeader(appAsarPath);
  const entry = rawHeader.header?.files?.["package.json"];
  if (!entry || entry.unpacked || !Number.isSafeInteger(entry.size) || entry.size < 1
    || typeof entry.offset !== "string" || !/^\d+$/u.test(entry.offset)
    || entry.integrity?.algorithm !== "SHA256" || !Array.isArray(entry.integrity.blocks)) {
    throw greenError("green_portable_patch_asar_invalid");
  }
  const original = extractFile(appAsarPath, "package.json");
  let packageJson;
  try { packageJson = JSON.parse(original.toString("utf8")); } catch (error) {
    throw greenError("green_portable_patch_asar_invalid", error);
  }
  const source = original.toString("utf8");
  const matches = [...source.matchAll(/"codexWindowsAppContainedCore"\s*:\s*"1"/gu)];
  if (packageJson.codexWindowsAppContainedCore !== "1" || matches.length !== 1) {
    throw greenError("green_portable_patch_contract_missing");
  }
  const patched = Buffer.from(original);
  const valueAt = matches[0].index + matches[0][0].lastIndexOf('"1"') + 1;
  patched[valueAt] = "0".charCodeAt(0);
  const oldHash = sha256Bytes(original);
  const newHash = sha256Bytes(patched);
  if (entry.integrity.hash !== oldHash || entry.integrity.blocks.length !== 1
    || entry.integrity.blocks[0] !== oldHash) {
    throw greenError("green_portable_patch_integrity_invalid");
  }
  entry.integrity.hash = newHash;
  entry.integrity.blocks = [newHash];
  const newHeaderString = JSON.stringify(rawHeader.header);
  const oldHeaderBytes = Buffer.from(rawHeader.headerString, "utf8");
  const newHeaderBytes = Buffer.from(newHeaderString, "utf8");
  if (newHeaderBytes.length !== oldHeaderBytes.length || patched.length !== original.length) {
    throw greenError("green_portable_patch_size_changed");
  }
  const descriptor = fs.openSync(appAsarPath, "r+");
  try {
    const headerRegion = Buffer.allocUnsafe(8 + rawHeader.headerSize);
    if (fs.readSync(descriptor, headerRegion, 0, headerRegion.length, 0) !== headerRegion.length) {
      throw greenError("green_portable_patch_asar_invalid");
    }
    const headerAt = headerRegion.indexOf(oldHeaderBytes);
    if (headerAt < 0 || headerRegion.indexOf(oldHeaderBytes, headerAt + 1) >= 0) {
      throw greenError("green_portable_patch_header_invalid");
    }
    fs.writeSync(descriptor, newHeaderBytes, 0, newHeaderBytes.length, headerAt);
    const dataAt = 8 + rawHeader.headerSize + Number(entry.offset);
    fs.writeSync(descriptor, patched, 0, patched.length, dataAt);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  uncacheAll();
  const verified = JSON.parse(extractFile(appAsarPath, "package.json").toString("utf8"));
  const verifiedHeader = getRawHeader(appAsarPath).header.files["package.json"];
  if (verified.codexWindowsAppContainedCore !== "0"
    || verifiedHeader.integrity.hash !== newHash || verifiedHeader.integrity.blocks?.[0] !== newHash) {
    throw greenError("green_portable_patch_verification_failed");
  }
}

function applyPortablePatches(resourcesRoot, patchIds) {
  for (const patchId of patchIds) {
    if (patchId === PORTABLE_PATCH_DISABLE_APP_CONTAINED_CORE) {
      patchAppContainedCore(path.join(resourcesRoot, "app.asar"));
    } else {
      throw greenError("green_portable_patch_unknown");
    }
  }
}

function applyPortableOverrides(stagingRoot, template) {
  const patchIds = [];
  for (const item of template.resourceOverrides) {
    const source = path.join(template.templateRoot, ...item.sourceRelativePath.split("/"));
    const target = path.join(stagingRoot, ...item.targetRelativePath.split("/"));
    assertRealFile(source, "green_portable_override_source_invalid");
    assertRealFile(target, "green_portable_override_target_invalid");
    fs.unlinkSync(target);
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    const patchId = PORTABLE_OVERRIDE_PATCH_IDS[item.targetRelativePath];
    if (!patchId) throw greenError("green_portable_override_unknown");
    patchIds.push(patchId);
  }
  return patchIds;
}

function rebindEmbeddedAsarIntegrity(executablePath, fromSha256, toSha256) {
  const original = Buffer.from(fromSha256, "ascii");
  const replacement = Buffer.from(toSha256, "ascii");
  if (!/^[a-f0-9]{64}$/u.test(fromSha256) || !/^[a-f0-9]{64}$/u.test(toSha256)
    || original.length !== replacement.length) {
    throw greenError("green_shell_integrity_binding_invalid");
  }
  const descriptor = fs.openSync(executablePath, "r+");
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size < replacement.length || stat.size > 32 * 1024 * 1024) {
      throw greenError("green_shell_integrity_binding_invalid");
    }
    const bytes = Buffer.allocUnsafe(stat.size);
    if (fs.readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length) {
      throw greenError("green_shell_integrity_binding_invalid");
    }
    const at = bytes.indexOf(original);
    if (at < 0 || bytes.indexOf(original, at + 1) >= 0) {
      throw greenError("green_shell_integrity_binding_missing");
    }
    fs.writeSync(descriptor, replacement, 0, replacement.length, at);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  const verified = fs.readFileSync(executablePath);
  if (verified.indexOf(replacement) < 0 || verified.indexOf(original) >= 0) {
    throw greenError("green_shell_integrity_binding_failed");
  }
}

function summarizeVerified(root, marker, tree) {
  return Object.freeze({
    outputPath: root,
    officialVersion: marker.officialVersion,
    electronVersion: marker.electronVersion,
    officialResourceTreeSha256: marker.officialResourceTreeSha256,
    portableResourceTreeSha256: marker.formatVersion === 2
      ? marker.portableResourceTreeSha256
      : marker.officialResourceTreeSha256,
    portablePatchIds: Object.freeze(marker.formatVersion === 2 ? [...marker.portablePatchIds] : []),
    owlTemplateVersion: marker.owlTemplateVersion,
    owlTemplateSha256: marker.owlTemplateSha256,
    contentTreeSha256: marker.contentTreeSha256,
    generatedAt: marker.generatedAt,
    fileCount: tree.entries.length,
    totalBytes: tree.entries.reduce((sum, entry) => sum + entry.size, 0),
  });
}

export async function verifyGreenCodexDirectory({ inputPath } = {}) {
  const root = absolutePath(inputPath, "green_input_invalid");
  assertRealDirectory(root, "green_input_invalid");
  const markerPath = path.join(root, GREEN_MARKER);
  const legacyPath = path.join(root, LEGACY_MARKER);
  if (!pathExists(markerPath) || !pathExists(legacyPath)) throw greenError("green_marker_missing");
  const marker = readGreenCodexMarker(root);
  const legacy = boundedJson(legacyPath, 4 * 1024, "green_legacy_marker_invalid");
  if (!exactKeys(legacy, ["schemaVersion", "componentId", "version"])
    || legacy.schemaVersion !== 1 || legacy.componentId !== "chatgpt"
    || !VERSION.test(legacy.version ?? "")) throw greenError("green_legacy_marker_invalid");
  if (legacy.version !== marker.officialVersion) throw greenError("green_marker_version_mismatch");

  assertRealFile(path.join(root, "ChatGPT.exe"), "green_layout_invalid");
  assertRealDirectory(path.join(root, "resources"), "green_layout_invalid");
  assertRealFile(path.join(root, "resources", "app.asar"), "green_layout_invalid");
  assertRealDirectory(path.join(root, "resources", "app.asar.unpacked"), "green_layout_invalid");
  assertRealFile(path.join(root, "resources", "codex.exe"), "green_layout_invalid");
  const tree = inspectPackageTree(root);
  const contentTreeSha256 = hashPackageTree(root, { exclude: MARKERS });
  if (contentTreeSha256 !== marker.contentTreeSha256) throw greenError("green_content_hash_mismatch");
  const portableResourceTreeSha256 = hashPackageTree(path.join(root, "resources"));
  const expectedResourceTreeSha256 = marker.formatVersion === 2
    ? marker.portableResourceTreeSha256
    : marker.officialResourceTreeSha256;
  if (portableResourceTreeSha256 !== expectedResourceTreeSha256) {
    throw greenError("green_resource_hash_mismatch");
  }
  if (marker.portablePatchIds.includes(PORTABLE_PATCH_REBIND_ASAR_INTEGRITY)) {
    const headerSha256 = crypto.createHash("sha256")
      .update(getRawHeader(path.join(root, "resources", "app.asar")).headerString).digest("hex");
    if (!fs.readFileSync(path.join(root, "ChatGPT.exe")).includes(Buffer.from(headerSha256, "ascii"))) {
      throw greenError("green_shell_integrity_binding_mismatch");
    }
  }
  return summarizeVerified(root, marker, tree);
}

export async function createGreenCodexDirectory({
  inputPath,
  runtimeTemplatePath,
  outputPath,
  verifyAuthenticode,
  generatedAt = new Date().toISOString(),
  beforeCommit,
} = {}) {
  const output = absolutePath(outputPath, "green_output_invalid");
  if (pathExists(output)) throw greenError("green_output_exists");
  if (!Number.isFinite(Date.parse(generatedAt))) throw greenError("green_generated_at_invalid");
  if (beforeCommit !== undefined && typeof beforeCommit !== "function") throw greenError("green_hook_invalid");

  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true });
  assertRealDirectory(parent, "green_output_parent_invalid");
  const staging = path.join(parent, `.codex-green-${path.basename(output)}-${crypto.randomUUID()}.part`);
  let stagingCreated = false;
  try {
    fs.mkdirSync(staging, { recursive: false });
    stagingCreated = true;
    const official = await inspectOfficialCodexPackage({ inputPath, verifyAuthenticode });
    const template = await inspectGreenRuntimeTemplate({ templatePath: runtimeTemplatePath, verifyAuthenticode });
    assertGreenRuntimeCompatible(official, template);
    const officialTreeBefore = official.sourceTreeSha256;
    const templateTreeBefore = hashPackageTree(template.templateRoot);
    const officialResourceTreeSha256 = hashPackageTree(official.resourcesRoot);

    const templateTree = inspectPackageTree(template.templateRoot);
    const overrideSources = new Set(template.resourceOverrides.map(
      (item) => item.sourceRelativePath.toLocaleLowerCase("en-US"),
    ));
    copyEntries(templateTree, staging, (relative) => {
      const folded = relative.toLocaleLowerCase("en-US");
      return folded !== TEMPLATE_MARKER.toLocaleLowerCase("en-US")
        && !folded.startsWith("resources/")
        && !overrideSources.has(folded)
        && !MARKERS.some((marker) => folded === marker.toLocaleLowerCase("en-US"));
    });
    const resourceTree = inspectPackageTree(official.resourcesRoot);
    copyEntries(resourceTree, path.join(staging, "resources"), () => true);

    if (beforeCommit) await beforeCommit();
    const officialAfter = await inspectOfficialCodexPackage({ inputPath, verifyAuthenticode });
    const templateAfter = await inspectGreenRuntimeTemplate({ templatePath: runtimeTemplatePath, verifyAuthenticode });
    if (officialAfter.sourceTreeSha256 !== officialTreeBefore
      || hashPackageTree(templateAfter.templateRoot) !== templateTreeBefore) {
      throw greenError("green_source_changed");
    }
    if (hashPackageTree(path.join(staging, "resources")) !== officialResourceTreeSha256) {
      throw greenError("green_copy_hash_mismatch");
    }
    applyPortablePatches(path.join(staging, "resources"), official.portablePatchIds);
    const portablePatchIds = [
      ...official.portablePatchIds,
      ...applyPortableOverrides(staging, template),
    ];
    const portableAsarHeaderSha256 = crypto.createHash("sha256")
      .update(getRawHeader(path.join(staging, "resources", "app.asar")).headerString).digest("hex");
    if (template.requiresEmbeddedAsarRebind) {
      rebindEmbeddedAsarIntegrity(
        path.join(staging, "ChatGPT.exe"),
        template.appAsarHeaderSha256,
        portableAsarHeaderSha256,
      );
      portablePatchIds.push(PORTABLE_PATCH_REBIND_ASAR_INTEGRITY);
    }
    const portableResourceTreeSha256 = hashPackageTree(path.join(staging, "resources"));

    const legacy = Object.freeze({
      schemaVersion: 1,
      componentId: "chatgpt",
      version: official.officialVersion,
    });
    writeNewJson(path.join(staging, LEGACY_MARKER), legacy);
    const contentTreeSha256 = hashPackageTree(staging, { exclude: MARKERS });
    const marker = Object.freeze({
      schemaVersion: 1,
      formatVersion: 2,
      componentId: "chatgpt",
      officialVersion: official.officialVersion,
      electronVersion: official.electronVersion,
      officialResourceTreeSha256,
      portableResourceTreeSha256,
      portablePatchIds,
      owlTemplateVersion: template.templateVersion,
      owlTemplateSha256: template.shellTreeSha256,
      contentTreeSha256,
      generatedAt: new Date(generatedAt).toISOString(),
    });
    writeNewJson(path.join(staging, GREEN_MARKER), marker);
    await verifyGreenCodexDirectory({ inputPath: staging });
    if (pathExists(output)) throw greenError("green_output_exists");
    try { fs.renameSync(staging, output); } catch (error) {
      if (pathExists(output)) throw greenError("green_output_exists", error);
      throw error;
    }
    stagingCreated = false;
    return verifyGreenCodexDirectory({ inputPath: output });
  } catch (error) {
    if (stagingCreated && pathExists(staging)) {
      removeOwnedTemporaryDirectory(staging, { parentDirectory: parent, requiredPrefix: ".codex-green-" });
    }
    throw error;
  }
}
