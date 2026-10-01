import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPackage, getRawHeader } from "@electron/asar";

import {
  assertGreenRuntimeCompatible,
  collectOwlAppApiSurface,
  hashPackageTree,
  inspectGreenRuntimeTemplate,
  inspectOfficialCodexPackage,
  readGreenCodexMarker,
  resolveOfficialCodexRoot,
} from "../scripts/software-manager/chatgpt-green-metadata.mjs";

const VALID_PUBLISHER = "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B";

function tempRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `codex-green-meta-${name}-`));
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function makeAsar(parent, {
  electronVersion = "42.3.0",
  source = "electron.app.showTaskManager(); electron.app.setRuntimeFeatures();",
  appContainedCore,
} = {}) {
  const sourceRoot = path.join(parent, "asar-source");
  fs.mkdirSync(path.join(sourceRoot, ".vite", "build"), { recursive: true });
  const packageJson = {
    name: "openai-codex-electron",
    version: "26.917.71314",
    devDependencies: { electron: electronVersion },
  };
  if (appContainedCore !== undefined) packageJson.codexWindowsAppContainedCore = appContainedCore;
  fs.writeFileSync(path.join(sourceRoot, "package.json"), JSON.stringify(packageJson));
  fs.writeFileSync(path.join(sourceRoot, ".vite", "build", "bootstrap.js"), source);
  const output = path.join(parent, "app.asar");
  await createPackage(sourceRoot, output);
  return output;
}

function manifest(version = "26.917.9434.0", architecture = "x64") {
  return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">
  <Identity Name="OpenAI.Codex" ProcessorArchitecture="${architecture}" Version="${version}" Publisher="${VALID_PUBLISHER}" />
  <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0" /></Dependencies>
  <Applications><Application Id="App" Executable="app/ChatGPT.exe" EntryPoint="Windows.FullTrustApplication" /></Applications>
</Package>`;
}

async function makeOfficial(parent, {
  version = "26.917.9434.0",
  architecture = "x64",
  source,
  electronVersion,
} = {}) {
  const root = path.join(parent, `OpenAI.Codex_${version}_x64`);
  const resources = path.join(root, "app", "resources");
  fs.mkdirSync(path.join(resources, "app.asar.unpacked", "native"), { recursive: true });
  fs.writeFileSync(path.join(root, "AppxManifest.xml"), manifest(version, architecture));
  fs.writeFileSync(path.join(root, "AppxSignature.p7x"), "signed-package");
  fs.writeFileSync(path.join(root, "app", "ChatGPT.exe"), "chromium-version-153.0.8010.53");
  fs.writeFileSync(path.join(resources, "codex.exe"), "codex-core");
  fs.writeFileSync(path.join(resources, "app.asar.unpacked", "native", "addon.node"), "native-addon");
  const appAsar = await makeAsar(resources, { source, electronVersion, appContainedCore: "1" });
  return { root, resources, appAsar };
}

async function makeTemplate(parent, {
  supportedOwlAppApis = ["setRuntimeFeatures", "showTaskManager"],
  electronVersion = "42.3.0",
  templateVersion = "26.917.9434.0",
  includePortableOverrides = true,
  embeddedAsarIntegrity = true,
} = {}) {
  const root = path.join(parent, "green-template");
  fs.mkdirSync(path.join(root, "resources"), { recursive: true });
  fs.writeFileSync(path.join(root, "chrome.dll"), "green-chrome-runtime");
  fs.writeFileSync(path.join(root, "owl-shell-runtime.json"), JSON.stringify({ platform: "win32", arch: "x64" }));
  const baselineAsar = await makeAsar(path.join(root, "resources"), { electronVersion });
  const baselineHeaderSha256 = crypto.createHash("sha256")
    .update(getRawHeader(baselineAsar).headerString).digest("hex");
  fs.writeFileSync(path.join(root, "ChatGPT.exe"), embeddedAsarIntegrity
    ? `green-owl-shell:${baselineHeaderSha256}`
    : "green-owl-shell-without-embedded-asar-integrity");
  const overrideFiles = includePortableOverrides
    ? ["portable-overrides/windows-account.node", "portable-overrides/windows-updater.node"]
    : [];
  for (const relativePath of overrideFiles) {
    const target = path.join(root, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `portable-${path.basename(relativePath)}`);
  }
  const requiredShellFiles = ["ChatGPT.exe", "chrome.dll", "owl-shell-runtime.json", ...overrideFiles]
    .map((relativePath) => ({ relativePath, sha256: sha256(path.join(root, relativePath)) }));
  fs.writeFileSync(path.join(root, ".codexbridge-green-runtime-template.json"), JSON.stringify({
    schemaVersion: embeddedAsarIntegrity ? 2 : 3,
    templateVersion,
    architecture: "x64",
    electronVersion,
    minimumWindowsBuild: 17763,
    supportedOwlAppApis,
    requiredShellFiles,
    resourceOverrides: overrideFiles.map((sourceRelativePath) => ({
      sourceRelativePath,
      targetRelativePath: `resources/native/${path.basename(sourceRelativePath)}`,
    })),
    ...embeddedAsarIntegrity ? {} : { embeddedAsarIntegrity: false },
    acceptanceId: "green-smoke-26.901-build-17763",
  }, null, 2));
  return root;
}

test("official root resolves directly or through one wrapper and rejects ambiguity", async () => {
  const base = tempRoot("resolve");
  const direct = await makeOfficial(path.join(base, "direct"));
  const wrapper = path.join(base, "wrapper");
  const nested = await makeOfficial(wrapper);
  const ambiguous = path.join(base, "ambiguous");
  await makeOfficial(ambiguous, { version: "26.917.9434.0" });
  await makeOfficial(ambiguous, { version: "26.918.1.0" });

  assert.equal(resolveOfficialCodexRoot(direct.root), direct.root);
  assert.equal(resolveOfficialCodexRoot(wrapper), nested.root);
  assert.throws(() => resolveOfficialCodexRoot(ambiguous), /green_official_root_ambiguous/u);
});

test("official metadata uses AppX Identity.Version instead of Chromium PE version", async () => {
  const official = await makeOfficial(tempRoot("official"));
  const checked = [];
  const result = await inspectOfficialCodexPackage({
    inputPath: official.root,
    verifyAuthenticode: async (filePath) => { checked.push(filePath); return "Valid"; },
  });

  assert.equal(result.officialVersion, "26.917.9434.0");
  assert.equal(result.packageIdentity, "OpenAI.Codex");
  assert.equal(result.packagePublisher, VALID_PUBLISHER);
  assert.equal(result.architecture, "x64");
  assert.equal(result.appId, "App");
  assert.equal(result.entrypointRelative, "app/ChatGPT.exe");
  assert.equal(result.electronVersion, "42.3.0");
  assert.deepEqual(result.portablePatchIds, ["disable-app-contained-core"]);
  assert.deepEqual(result.owlAppApis, ["setRuntimeFeatures", "showTaskManager"]);
  assert.match(result.sourceTreeSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(checked.sort(), [
    path.join(official.root, "AppxSignature.p7x"),
    path.join(official.root, "app", "ChatGPT.exe"),
  ].sort());
});

test("official metadata rejects bad signatures, non-x64 input, entities, and incomplete resources", async () => {
  const badSignature = await makeOfficial(tempRoot("signature"));
  await assert.rejects(inspectOfficialCodexPackage({
    inputPath: badSignature.root,
    verifyAuthenticode: async () => "NotSigned",
  }), /green_official_signature_invalid/u);

  const wrongArch = await makeOfficial(tempRoot("arch"), { architecture: "arm64" });
  await assert.rejects(inspectOfficialCodexPackage({ inputPath: wrongArch.root, verifyAuthenticode: async () => "Valid" }), /green_official_architecture_invalid/u);

  const entity = await makeOfficial(tempRoot("entity"));
  fs.writeFileSync(path.join(entity.root, "AppxManifest.xml"), `<!DOCTYPE x [<!ENTITY y SYSTEM "file:///x">]>${manifest()}`);
  await assert.rejects(inspectOfficialCodexPackage({ inputPath: entity.root, verifyAuthenticode: async () => "Valid" }), /green_official_manifest_invalid/u);

  const missing = await makeOfficial(tempRoot("missing"));
  fs.unlinkSync(path.join(missing.resources, "codex.exe"));
  await assert.rejects(inspectOfficialCodexPackage({ inputPath: missing.root, verifyAuthenticode: async () => "Valid" }), /green_official_layout_invalid/u);
});

test("Owl API surface is stable and sorted", async () => {
  const root = tempRoot("api");
  const appAsar = await makeAsar(root, {
    source: "electron.app.showTaskManager(); electron.app.setRuntimeFeatures(); electron.app.showTaskManager();",
  });
  assert.deepEqual(collectOwlAppApiSurface(appAsar), ["setRuntimeFeatures", "showTaskManager"]);
});

test("template hashes are exact and compatibility rejects Electron or Owl drift", async () => {
  const root = tempRoot("template");
  const templatePath = await makeTemplate(root);
  const official = await makeOfficial(root);
  const verifyAuthenticode = async () => "Valid";
  const template = await inspectGreenRuntimeTemplate({ templatePath, verifyAuthenticode });
  const source = await inspectOfficialCodexPackage({ inputPath: official.root, verifyAuthenticode });
  const inspectedBaselineHeaderSha256 = crypto.createHash("sha256")
    .update(getRawHeader(path.join(templatePath, "resources", "app.asar")).headerString).digest("hex");

  assert.equal(template.templateVersion, "26.917.9434.0");
  assert.equal(template.minimumWindowsBuild, 17763);
  assert.equal(template.appAsarHeaderSha256, inspectedBaselineHeaderSha256);
  assert.deepEqual(template.resourceOverrides.map((item) => item.targetRelativePath), [
    "resources/native/windows-account.node",
    "resources/native/windows-updater.node",
  ]);
  assert.match(template.shellTreeSha256, /^[a-f0-9]{64}$/u);
  assert.doesNotThrow(() => assertGreenRuntimeCompatible(source, template));

  fs.appendFileSync(path.join(templatePath, "chrome.dll"), "tampered");
  await assert.rejects(inspectGreenRuntimeTemplate({ templatePath, verifyAuthenticode }), /green_template_hash_mismatch/u);

  const electronDrift = await makeOfficial(tempRoot("electron-drift"), { electronVersion: "43.0.0" });
  const driftMetadata = await inspectOfficialCodexPackage({ inputPath: electronDrift.root, verifyAuthenticode });
  assert.throws(() => assertGreenRuntimeCompatible(driftMetadata, template), /green_electron_version_unsupported/u);

  const apiDrift = await makeOfficial(tempRoot("api-drift"), {
    source: "electron.app.showTaskManager(); electron.app.setRuntimeFeatures(); electron.app.futureOwlApi();",
  });
  const apiMetadata = await inspectOfficialCodexPackage({ inputPath: apiDrift.root, verifyAuthenticode });
  assert.throws(() => assertGreenRuntimeCompatible(apiMetadata, template), /green_owl_api_unsupported/u);

  const missingOverrides = await makeTemplate(tempRoot("template-no-overrides"), { includePortableOverrides: false });
  const incomplete = await inspectGreenRuntimeTemplate({ templatePath: missingOverrides, verifyAuthenticode });
  assert.throws(() => assertGreenRuntimeCompatible(source, incomplete), /green_portable_override_required/u);
});

test("template descriptor must pin every copied shell file outside resources", async () => {
  const root = tempRoot("template-unpinned");
  const templatePath = await makeTemplate(root);
  fs.writeFileSync(path.join(templatePath, "unlisted-runtime.dll"), "not-pinned");
  await assert.rejects(inspectGreenRuntimeTemplate({
    templatePath,
    verifyAuthenticode: async () => "Valid",
  }), /green_template_unpinned_file/u);
});

test("new Owl shell templates can explicitly declare no embedded ASAR integrity binding", async () => {
  const templatePath = await makeTemplate(tempRoot("template-no-embedded-integrity"), {
    embeddedAsarIntegrity: false,
  });
  const template = await inspectGreenRuntimeTemplate({
    templatePath,
    verifyAuthenticode: async () => "Valid",
  });
  assert.equal(template.requiresEmbeddedAsarRebind, false);
  assert.match(template.appAsarHeaderSha256, /^[a-f0-9]{64}$/u);
});

test("conversion rejects a different release shell even when Electron and Owl app APIs match", async () => {
  const root = tempRoot("template-version-mismatch");
  const official = await makeOfficial(root);
  const templatePath = await makeTemplate(root, { templateVersion: "26.901.5280.0" });
  const verifyAuthenticode = async () => "Valid";
  const officialMetadata = await inspectOfficialCodexPackage({ inputPath: official.root, verifyAuthenticode });
  const templateMetadata = await inspectGreenRuntimeTemplate({ templatePath, verifyAuthenticode });
  assert.equal(officialMetadata.electronVersion, templateMetadata.electronVersion);
  assert.deepEqual(officialMetadata.owlAppApis, templateMetadata.supportedOwlAppApis);
  assert.throws(
    () => assertGreenRuntimeCompatible(officialMetadata, templateMetadata),
    /green_template_version_mismatch/u,
  );
});

test("green marker and tree hashing reject malformed or changed state", async () => {
  const root = tempRoot("marker");
  fs.writeFileSync(path.join(root, "payload.bin"), "payload");
  fs.writeFileSync(path.join(root, ".codexbridge-green-codex.json"), JSON.stringify({
    schemaVersion: 1,
    formatVersion: 1,
    componentId: "chatgpt",
    officialVersion: "26.917.9434.0",
    electronVersion: "42.3.0",
    officialResourceTreeSha256: "a".repeat(64),
    owlTemplateVersion: "26.901.5280.0",
    owlTemplateSha256: "b".repeat(64),
    contentTreeSha256: "c".repeat(64),
    generatedAt: "2026-09-25T00:00:00.000Z",
  }));
  assert.equal(readGreenCodexMarker(root).officialVersion, "26.917.9434.0");
  const before = hashPackageTree(root, { exclude: [".codexbridge-green-codex.json"] });
  fs.appendFileSync(path.join(root, "payload.bin"), "changed");
  assert.notEqual(hashPackageTree(root, { exclude: [".codexbridge-green-codex.json"] }), before);
  fs.writeFileSync(path.join(root, ".codexbridge-green-codex.json"), "{}");
  assert.throws(() => readGreenCodexMarker(root), /green_marker_invalid/u);
});
