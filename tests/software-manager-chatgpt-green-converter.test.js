import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPackage, extractFile, getRawHeader } from "@electron/asar";

import {
  createGreenCodexDirectory,
  verifyGreenCodexDirectory,
} from "../scripts/software-manager/chatgpt-green-converter.mjs";
import { runCreateGreenCli } from "../scripts/software-manager/create-chatgpt-green.mjs";

const PUBLISHER = "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B";

function temporary(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `codex-green-converter-${name}-`));
}

function digest(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

async function writeAsar(resources, source = "electron.app.showTaskManager(); electron.app.setRuntimeFeatures();", {
  appContainedCore,
} = {}) {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-green-asar-source-"));
  fs.mkdirSync(path.join(sourceRoot, ".vite", "build"), { recursive: true });
  const packageJson = {
    name: "openai-codex-electron",
    devDependencies: { electron: "42.3.0" },
  };
  if (appContainedCore !== undefined) packageJson.codexWindowsAppContainedCore = appContainedCore;
  fs.writeFileSync(path.join(sourceRoot, "package.json"), JSON.stringify(packageJson, null, 2));
  fs.writeFileSync(path.join(sourceRoot, ".vite", "build", "bootstrap.js"), source);
  const output = path.join(resources, "app.asar");
  await createPackage(sourceRoot, output);
  return output;
}

async function fixture(name) {
  const root = temporary(name);
  const official = path.join(root, "OpenAI.Codex_26.917.9434.0_x64");
  const resources = path.join(official, "app", "resources");
  fs.mkdirSync(path.join(resources, "app.asar.unpacked", "native"), { recursive: true });
  fs.writeFileSync(path.join(official, "AppxManifest.xml"), `<?xml version="1.0"?>
<Package><Identity Name="OpenAI.Codex" ProcessorArchitecture="x64" Version="26.917.9434.0" Publisher="${PUBLISHER}" />
<Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" /></Dependencies>
<Applications><Application Id="App" Executable="app/ChatGPT.exe" EntryPoint="Windows.FullTrustApplication" /></Applications></Package>`);
  fs.writeFileSync(path.join(official, "AppxSignature.p7x"), "official-signature");
  fs.writeFileSync(path.join(official, "app", "ChatGPT.exe"), "official-appx-shell");
  fs.writeFileSync(path.join(resources, "codex.exe"), "official-codex-core");
  fs.mkdirSync(path.join(resources, "native"));
  fs.writeFileSync(path.join(resources, "native", "windows-account.node"), "official-windows-account");
  fs.writeFileSync(path.join(resources, "native", "windows-updater.node"), "official-windows-updater");
  fs.writeFileSync(path.join(resources, "app.asar.unpacked", "native", "addon.node"), "official-native");
  fs.writeFileSync(path.join(resources, "new-resource.txt"), "new-resource");
  await writeAsar(resources, undefined, { appContainedCore: "1" });

  const template = path.join(root, "template");
  fs.mkdirSync(path.join(template, "resources"), { recursive: true });
  fs.writeFileSync(path.join(template, "chrome.dll"), "green-chrome");
  fs.writeFileSync(path.join(template, "owl-shell-runtime.json"), "{}");
  fs.mkdirSync(path.join(template, "portable-overrides"));
  fs.writeFileSync(path.join(template, "portable-overrides", "windows-account.node"), "portable-windows-account");
  fs.writeFileSync(path.join(template, "portable-overrides", "windows-updater.node"), "portable-windows-updater");
  fs.writeFileSync(path.join(template, "resources", "old-resource.txt"), "must-not-survive");
  const baselineAsar = await writeAsar(path.join(template, "resources"));
  const baselineHeaderSha256 = crypto.createHash("sha256")
    .update(getRawHeader(baselineAsar).headerString).digest("hex");
  fs.writeFileSync(path.join(template, "ChatGPT.exe"), `green-shell:${baselineHeaderSha256}`);
  const requiredShellFiles = [
    "ChatGPT.exe", "chrome.dll", "owl-shell-runtime.json",
    "portable-overrides/windows-account.node", "portable-overrides/windows-updater.node",
  ]
    .map((relativePath) => ({ relativePath, sha256: digest(path.join(template, relativePath)) }));
  fs.writeFileSync(path.join(template, ".codexbridge-green-runtime-template.json"), JSON.stringify({
    schemaVersion: 2,
    templateVersion: "26.917.9434.0",
    architecture: "x64",
    electronVersion: "42.3.0",
    minimumWindowsBuild: 17763,
    supportedOwlAppApis: ["setRuntimeFeatures", "showTaskManager"],
    requiredShellFiles,
    resourceOverrides: [
      { sourceRelativePath: "portable-overrides/windows-account.node", targetRelativePath: "resources/native/windows-account.node" },
      { sourceRelativePath: "portable-overrides/windows-updater.node", targetRelativePath: "resources/native/windows-updater.node" },
    ],
    acceptanceId: "green-smoke-26.901-build-17763",
  }));
  return {
    root,
    official,
    resources,
    template,
    output: path.join(root, "output"),
    verifyAuthenticode: async () => "Valid",
  };
}

test("converter keeps template shell, replaces resources, and writes dual markers", async () => {
  const value = await fixture("compose");
  const built = await createGreenCodexDirectory({
    inputPath: value.official,
    runtimeTemplatePath: value.template,
    outputPath: value.output,
    verifyAuthenticode: value.verifyAuthenticode,
    generatedAt: "2026-09-25T00:00:00.000Z",
  });

  const portableHeaderSha256 = crypto.createHash("sha256")
    .update(getRawHeader(path.join(value.output, "resources", "app.asar")).headerString).digest("hex");
  const outputShell = fs.readFileSync(path.join(value.output, "ChatGPT.exe"), "utf8");
  assert.match(outputShell, /^green-shell:/u);
  assert.ok(outputShell.includes(portableHeaderSha256));
  assert.equal(fs.readFileSync(path.join(value.output, "resources", "new-resource.txt"), "utf8"), "new-resource");
  assert.equal(fs.existsSync(path.join(value.output, "resources", "old-resource.txt")), false);
  assert.equal(readJson(path.join(value.output, ".codexbridge-chatgpt-version.json")).version, "26.917.9434.0");
  const marker = readJson(path.join(value.output, ".codexbridge-green-codex.json"));
  assert.equal(marker.formatVersion, 2);
  assert.equal(marker.officialVersion, "26.917.9434.0");
  assert.deepEqual(marker.portablePatchIds, [
    "disable-app-contained-core",
    "replace-windows-account-native",
    "replace-windows-updater-native",
    "rebind-embedded-asar-integrity",
  ]);
  assert.equal(fs.readFileSync(path.join(value.output, "resources", "native", "windows-account.node"), "utf8"), "portable-windows-account");
  assert.equal(fs.readFileSync(path.join(value.output, "resources", "native", "windows-updater.node"), "utf8"), "portable-windows-updater");
  assert.equal(fs.existsSync(path.join(value.output, "portable-overrides")), false);
  assert.match(marker.portableResourceTreeSha256, /^[a-f0-9]{64}$/u);
  assert.notEqual(marker.portableResourceTreeSha256, marker.officialResourceTreeSha256);
  assert.equal(
    JSON.parse(extractFile(path.join(value.output, "resources", "app.asar"), "package.json").toString("utf8")).codexWindowsAppContainedCore,
    "0",
  );
  assert.equal(
    JSON.parse(extractFile(path.join(value.resources, "app.asar"), "package.json").toString("utf8")).codexWindowsAppContainedCore,
    "1",
  );
  assert.match(built.contentTreeSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(await verifyGreenCodexDirectory({ inputPath: value.output }), built);
});

test("converter refuses occupied output without changing it", async () => {
  const value = await fixture("collision");
  fs.mkdirSync(value.output);
  fs.writeFileSync(path.join(value.output, "owned.txt"), "keep");
  await assert.rejects(createGreenCodexDirectory({
    inputPath: value.official,
    runtimeTemplatePath: value.template,
    outputPath: value.output,
    verifyAuthenticode: value.verifyAuthenticode,
  }), /green_output_exists/u);
  assert.equal(fs.readFileSync(path.join(value.output, "owned.txt"), "utf8"), "keep");
});

test("converter rejects links and leaves no final or staging directory", async (t) => {
  const value = await fixture("link");
  const external = path.join(value.root, "external");
  fs.mkdirSync(external);
  try {
    fs.symlinkSync(external, path.join(value.template, "linked"), "junction");
  } catch (error) {
    t.skip(`junction unavailable: ${error.code}`);
    return;
  }
  await assert.rejects(createGreenCodexDirectory({
    inputPath: value.official,
    runtimeTemplatePath: value.template,
    outputPath: value.output,
    verifyAuthenticode: value.verifyAuthenticode,
  }), /publisher_package_link_rejected/u);
  assert.equal(fs.existsSync(value.output), false);
  assert.deepEqual(fs.readdirSync(value.root).filter((name) => name.startsWith(".codex-green-")), []);
});

test("source mutation during copy fails closed and removes only owned staging", async () => {
  const value = await fixture("race");
  const neighbor = path.join(value.root, ".codex-green-neighbor.part");
  fs.mkdirSync(neighbor);
  fs.writeFileSync(path.join(neighbor, "keep.txt"), "keep");
  await assert.rejects(createGreenCodexDirectory({
    inputPath: value.official,
    runtimeTemplatePath: value.template,
    outputPath: value.output,
    verifyAuthenticode: value.verifyAuthenticode,
    beforeCommit: async () => fs.appendFileSync(path.join(value.resources, "new-resource.txt"), "changed"),
  }), /green_source_changed/u);
  assert.equal(fs.existsSync(value.output), false);
  assert.equal(fs.readFileSync(path.join(neighbor, "keep.txt"), "utf8"), "keep");
  assert.deepEqual(fs.readdirSync(value.root).filter((name) => name.startsWith(".codex-green-") && name !== path.basename(neighbor)), []);
});

test("independent verification rejects raw AppX and content drift", async () => {
  const value = await fixture("verify");
  await assert.rejects(verifyGreenCodexDirectory({ inputPath: value.official }), /green_marker_missing/u);
  await createGreenCodexDirectory({
    inputPath: value.official,
    runtimeTemplatePath: value.template,
    outputPath: value.output,
    verifyAuthenticode: value.verifyAuthenticode,
  });
  fs.appendFileSync(path.join(value.output, "resources", "new-resource.txt"), "tampered");
  await assert.rejects(verifyGreenCodexDirectory({ inputPath: value.output }), /green_content_hash_mismatch/u);
});

test("local builder CLI validates arguments and emits a verified optional ZIP", async () => {
  const value = await fixture("cli");
  const zipPath = path.join(value.root, "Codex-Green.zip");
  const lines = [];
  const result = await runCreateGreenCli({
    argv: [
      "--input", value.official,
      "--runtime-template", value.template,
      "--output-dir", value.output,
      "--zip", zipPath,
    ],
    verifyAuthenticode: value.verifyAuthenticode,
    writeStdout: (line) => lines.push(line),
  });
  assert.equal(result.state, "verified");
  assert.equal(result.officialVersion, "26.917.9434.0");
  assert.equal(result.outputDirectory, value.output);
  assert.equal(result.zipPath, zipPath);
  assert.match(result.contentTreeSha256, /^[a-f0-9]{64}$/u);
  assert.ok(result.fileCount > 4);
  assert.ok(result.totalBytes > 0);
  assert.ok(result.zipSize > 0);
  assert.match(result.zipSha256, /^[a-f0-9]{64}$/u);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), result);
  assert.equal(fs.readFileSync(zipPath).subarray(0, 4).toString("hex"), "504b0304");

  await assert.rejects(runCreateGreenCli({
    argv: ["--wat"], verifyAuthenticode: value.verifyAuthenticode, writeStdout: () => {},
  }), /green_cli_argument_invalid/u);
  await assert.rejects(runCreateGreenCli({
    argv: ["--input", ".", "--runtime-template", value.template, "--output-dir", path.join(value.root, "relative")],
    verifyAuthenticode: value.verifyAuthenticode,
    writeStdout: () => {},
  }), /green_cli_path_invalid/u);
});

test("real local builder process rejects unknown and relative arguments before touching disk", () => {
  const cli = path.resolve("scripts/software-manager/create-chatgpt-green.mjs");
  const unknown = spawnSync(process.execPath, [cli, "--wat"], { encoding: "utf8", windowsHide: true });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /green_cli_argument_invalid/u);
  const relative = spawnSync(process.execPath, [
    cli, "--input", ".", "--runtime-template", ".", "--output-dir", ".\\out",
  ], { encoding: "utf8", windowsHide: true });
  assert.notEqual(relative.status, 0);
  assert.match(relative.stderr, /green_cli_path_invalid/u);
});
