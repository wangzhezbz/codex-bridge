import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPackage } from "@electron/asar";

import { createGreenCodexDirectory } from "../scripts/software-manager/chatgpt-green-converter.mjs";
import { inspectGreenRuntimeTemplate } from "../scripts/software-manager/chatgpt-green-metadata.mjs";
import { prepareGreenRuntimeTemplate } from "../scripts/software-manager/prepare-chatgpt-green-template.mjs";

async function fixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `codex-green-template-${name}-`));
  const official = path.join(root, "OpenAI.Codex_26.918.1.0_x64");
  const app = path.join(official, "app");
  const resources = path.join(app, "resources");
  const overrideRoot = path.join(root, "native-overrides");
  const asarSource = path.join(root, "asar-source");
  fs.mkdirSync(path.join(resources, "app.asar.unpacked", "native"), { recursive: true });
  fs.mkdirSync(path.join(asarSource, ".vite", "build"), { recursive: true });
  fs.mkdirSync(path.join(app, "locales"));
  fs.mkdirSync(path.join(resources, "native"));
  fs.mkdirSync(overrideRoot);
  fs.writeFileSync(path.join(official, "AppxManifest.xml"), `<?xml version="1.0"?>
<Package><Identity Name="OpenAI.Codex" ProcessorArchitecture="x64" Version="26.918.1.0" Publisher="CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B" />
<Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" /></Dependencies>
<Applications><Application Id="App" Executable="app/ChatGPT.exe" EntryPoint="Windows.FullTrustApplication" /></Applications></Package>`);
  fs.writeFileSync(path.join(official, "AppxSignature.p7x"), "signed-package");
  fs.writeFileSync(path.join(app, "ChatGPT.exe"), "same-release-owl-shell");
  fs.writeFileSync(path.join(app, "chrome.dll"), "same-release-chrome");
  fs.writeFileSync(path.join(app, "owl-shell-runtime.json"), "{}");
  fs.writeFileSync(path.join(app, "locales", "zh-CN.pak"), "locale");
  fs.writeFileSync(path.join(resources, "codex.exe"), "new-codex-core");
  fs.writeFileSync(path.join(resources, "app.asar.unpacked", "native", "addon.node"), "new-addon");
  fs.writeFileSync(path.join(resources, "native", "windows-account.node"), "official-account");
  fs.writeFileSync(path.join(resources, "native", "windows-updater.node"), "official-updater");
  fs.writeFileSync(path.join(overrideRoot, "windows-account.node"), "signed-compatible-account");
  fs.writeFileSync(path.join(overrideRoot, "windows-updater.node"), "signed-compatible-updater");
  fs.writeFileSync(path.join(asarSource, "package.json"), JSON.stringify({
    name: "openai-codex-electron",
    devDependencies: { electron: "42.3.0" },
    codexWindowsAppContainedCore: "1",
  }, null, 2));
  fs.writeFileSync(path.join(asarSource, ".vite", "build", "main.js"),
    "electron.app.showTaskManager();electron.app.setRuntimeFeatures();");
  await createPackage(asarSource, path.join(resources, "app.asar"));
  return {
    root,
    official,
    app,
    overrideRoot,
    template: path.join(root, "new-template"),
    output: path.join(root, "new-green"),
  };
}

test("prepares a same-release template from official shell and uses signed native overrides", async () => {
  const value = await fixture("prepare");
  const verifyAuthenticode = async () => "Valid";
  const prepared = await prepareGreenRuntimeTemplate({
    inputPath: value.official,
    nativeOverrideRoot: value.overrideRoot,
    outputPath: value.template,
    minimumWindowsBuild: 17763,
    verifyAuthenticode,
  });
  const descriptor = JSON.parse(fs.readFileSync(
    path.join(value.template, ".codexbridge-green-runtime-template.json"), "utf8",
  ));
  assert.equal(prepared.templateVersion, "26.918.1.0");
  assert.equal(descriptor.templateVersion, "26.918.1.0");
  assert.equal(descriptor.schemaVersion, 3);
  assert.equal(descriptor.embeddedAsarIntegrity, false);
  assert.equal(descriptor.acceptanceId, "pending-real-smoke");
  assert.ok(descriptor.requiredShellFiles.some((item) => item.relativePath === "locales/zh-CN.pak"));
  assert.equal(fs.readFileSync(path.join(value.template, "ChatGPT.exe"), "utf8"), "same-release-owl-shell");
  assert.equal(fs.readFileSync(path.join(value.template, "portable-overrides", "windows-account.node"), "utf8"), "signed-compatible-account");
  assert.equal(fs.existsSync(path.join(value.template, "resources", "codex.exe")), false);
  assert.equal((await inspectGreenRuntimeTemplate({ templatePath: value.template, verifyAuthenticode })).templateVersion,
    "26.918.1.0");

  const converted = await createGreenCodexDirectory({
    inputPath: value.official,
    runtimeTemplatePath: value.template,
    outputPath: value.output,
    verifyAuthenticode,
  });
  assert.equal(converted.officialVersion, "26.918.1.0");
  assert.equal(fs.readFileSync(path.join(value.output, "resources", "native", "windows-account.node"), "utf8"),
    "signed-compatible-account");
  assert.equal(fs.readFileSync(path.join(value.output, "resources", "codex.exe"), "utf8"), "new-codex-core");
});

test("an unsigned compatibility module cannot produce a template", async () => {
  const value = await fixture("unsigned");
  await assert.rejects(prepareGreenRuntimeTemplate({
    inputPath: value.official,
    nativeOverrideRoot: value.overrideRoot,
    outputPath: value.template,
    minimumWindowsBuild: 17763,
    verifyAuthenticode: async (filePath) => path.basename(filePath) === "windows-account.node" ? "NotSigned" : "Valid",
  }), /green_template_signature_invalid/u);
  assert.equal(fs.existsSync(value.template), false);
});

test("an existing template directory is never replaced", async () => {
  const value = await fixture("occupied");
  fs.mkdirSync(value.template);
  fs.writeFileSync(path.join(value.template, "owned.txt"), "keep");
  await assert.rejects(prepareGreenRuntimeTemplate({
    inputPath: value.official,
    nativeOverrideRoot: value.overrideRoot,
    outputPath: value.template,
    minimumWindowsBuild: 17763,
    verifyAuthenticode: async () => "Valid",
  }), /green_template_output_exists/u);
  assert.equal(fs.readFileSync(path.join(value.template, "owned.txt"), "utf8"), "keep");
});

test("template output cannot be created inside either source directory", async () => {
  const value = await fixture("overlap");
  for (const outputPath of [
    path.join(value.official, "nested-template"),
    path.join(value.overrideRoot, "nested-template"),
  ]) {
    await assert.rejects(prepareGreenRuntimeTemplate({
      inputPath: value.official,
      nativeOverrideRoot: value.overrideRoot,
      outputPath,
      minimumWindowsBuild: 17763,
      verifyAuthenticode: async () => "Valid",
    }), /green_template_output_overlap/u);
    assert.equal(fs.existsSync(outputPath), false);
  }
});
