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
  assert.match(packager, /codexbridge-icon\.ico/);
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
  assert.match(packager, /codexbridge-icon\.icns/);
});

test("desktop packages include native app icon assets", () => {
  const assetsDir = path.join(process.cwd(), "desktop", "assets");
  const png = fs.readFileSync(path.join(assetsDir, "codexbridge-icon.png"));
  const ico = fs.readFileSync(path.join(assetsDir, "codexbridge-icon.ico"));
  const icns = fs.readFileSync(path.join(assetsDir, "codexbridge-icon.icns"));
  const main = fs.readFileSync(path.join(process.cwd(), "desktop", "main.cjs"), "utf8");

  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
  assert.deepEqual([...ico.subarray(0, 4)], [0, 0, 1, 0]);
  assert.equal(icns.subarray(0, 4).toString("ascii"), "icns");
  assert.match(main, /codexbridge-icon\.png/);
});

test("desktop close button hides to tray instead of quitting", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "desktop", "main.cjs"), "utf8");

  assert.match(main, /\bTray\b/);
  assert.match(main, /\bMenu\b/);
  assert.match(main, /mainWindow\.on\("close"/);
  assert.match(main, /event\.preventDefault\(\)/);
  assert.match(main, /mainWindow\.hide\(\)/);
  assert.match(main, /退出 CodexBridge|Quit CodexBridge/);
});
