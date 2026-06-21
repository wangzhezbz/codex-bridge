import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("Windows release archive uses formal portable package naming", () => {
  const workflow = fs.readFileSync(
    path.join(process.cwd(), ".github", "workflows", "desktop-portable.yml"),
    "utf8",
  );
  const packager = fs.readFileSync(
    path.join(process.cwd(), "scripts", "package-windows.mjs"),
    "utf8",
  );

  assert.match(workflow, /CodexBridge-Windows-x64-Portable\.zip/);
  assert.match(workflow, /releases\/latest\/download\/CodexBridge-Windows-x64-Portable\.zip/);
  assert.match(workflow, /prerelease: false/);
  assert.doesNotMatch(workflow, /CodexBridge-windows-portable/);
  assert.match(packager, /CODEXBRIDGE_RELEASE_VERSION/);
  assert.match(packager, /CodexBridge-Windows-x64-Portable-/);
});

test("macOS release archives use formal x64 and arm64 package naming", () => {
  const workflow = fs.readFileSync(
    path.join(process.cwd(), ".github", "workflows", "desktop-portable.yml"),
    "utf8",
  );
  const packager = fs.readFileSync(
    path.join(process.cwd(), "scripts", "package-macos.mjs"),
    "utf8",
  );

  assert.match(workflow, /CodexBridge-macOS-arm64-Portable\.zip/);
  assert.match(workflow, /CodexBridge-macOS-x64-Portable\.zip/);
  assert.match(workflow, /macos-latest/);
  assert.match(workflow, /macos-15-intel/);
  assert.match(workflow, /runner:\s*macos-latest/);
  assert.match(workflow, /runner:\s*macos-15-intel/);
  assert.match(workflow, /CODEXBRIDGE_MAC_ARCH/);
  assert.match(workflow, /releases\/latest\/download\/CodexBridge-macOS-arm64-Portable\.zip/);
  assert.match(workflow, /releases\/latest\/download\/CodexBridge-macOS-x64-Portable\.zip/);
  assert.match(packager, /platform:\s*"darwin"/);
  assert.match(packager, /CodexBridge-macOS-\$\{targetArch\}-Portable-/);
});
