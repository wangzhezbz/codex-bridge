import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

import {
  assertWindowsSoftwareManagerPackagePaths,
  buildSoftwareManagerReleaseReadiness,
  shouldIgnoreWindowsPackagePath,
} from "../scripts/package-content-policy.mjs";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();

test("Windows package requires the pinned 7zip executable and its license", () => {
  const sevenZipRoot = path.dirname(require.resolve("7zip-bin"));
  const paths = [
    path.relative(repoRoot, path.join(sevenZipRoot, "win", "x64", "7za.exe")).replaceAll("\\", "/"),
    path.relative(repoRoot, path.join(sevenZipRoot, "LICENSE.txt")).replaceAll("\\", "/"),
    "desktop/software-manager/catalog-trust.mjs",
    "desktop/software-manager/runtime-factory.mjs",
    "desktop/software-manager/bundled-catalog.mjs",
    "desktop/software-manager/bundled-catalog/component-catalog.json",
    "desktop/software-manager/bundled-catalog/component-catalog.json.sig",
    "desktop/software-manager/catalog-public-key.mjs",
  ];

  assert.deepEqual(assertWindowsSoftwareManagerPackagePaths(paths), {
    checkedFiles: 8,
    requiredFiles: 8,
  });
  assert.throws(
    () => assertWindowsSoftwareManagerPackagePaths(paths.filter((value) => !value.endsWith("LICENSE.txt"))),
    (error) => error?.code === "software_manager_package_runtime_missing"
      && error.missing.includes("node_modules/7zip-bin/LICENSE.txt"),
  );
});

test("package policy rejects software-manager state, journals, partial downloads and server secrets", () => {
  const forbidden = [
    "downloads/chatgpt.zip.part",
    "software-manager/state/ownership.json",
    "software-manager/journal/task-1.json",
    "software-manager/skill-swaps/swap.json",
    "software-manager/skill-prepares/prepare.json",
    "deploy/codexbridge-installer/publisher.env",
    "deploy/codexbridge-installer/signing-private.key",
    "tests/fixtures/software-manager/catalog.json",
  ];
  for (const candidate of forbidden) {
    assert.equal(shouldIgnoreWindowsPackagePath(candidate), true, candidate);
  }
});

test("packaged runtime contains public trust code but no private key material", () => {
  const paths = [
    "desktop/software-manager/bundled-catalog.mjs",
    "desktop/software-manager/bundled-catalog/component-catalog.json",
    "desktop/software-manager/bundled-catalog/component-catalog.json.sig",
    "desktop/software-manager/catalog-trust.mjs",
    "desktop/software-manager/catalog-public-key.mjs",
    "desktop/software-manager/runtime-factory.mjs",
    "node_modules/7zip-bin/win/x64/7za.exe",
    "node_modules/7zip-bin/LICENSE.txt",
  ];
  assert.equal(paths.some((value) => /catalog-trust\.mjs$/i.test(value)), true);
  assert.equal(paths.some((value) => /\.(pem|key|p12|pfx)$/i.test(value)), false);
  assert.doesNotThrow(() => assertWindowsSoftwareManagerPackagePaths(paths));
});

test("Windows packaging and smoke both execute the software-manager package gate", () => {
  const packageSource = fs.readFileSync(path.join(repoRoot, "scripts", "package-windows.mjs"), "utf8");
  const smokeSource = fs.readFileSync(path.join(repoRoot, "scripts", "smoke-packaged-windows.mjs"), "utf8");
  assert.match(packageSource, /assertWindowsSoftwareManagerPackagePaths/);
  assert.match(smokeSource, /assertWindowsSoftwareManagerPackagePaths/);
  assert.match(smokeSource, /CODEXBRIDGE_DESKTOP_SMOKE_SOFTWARE_MANAGER:\s*"1"/u);
  assert.match(smokeSource, /Software manager smoke passed/u);
  assert.match(smokeSource, /softwareManager\.skills,\s*7/u);
  assert.match(smokeSource, /softwareManager\.expandedPluginRows,\s*2/u);
  assert.match(smokeSource, /softwareManager\.selectablePluginRows,\s*2/u);
  assert.match(smokeSource, /softwareManager\.updateHasSkills,\s*false/u);
});

test("macOS packaging removes the Windows helper and renderer exposes no usable entrypoint", () => {
  const packageSource = fs.readFileSync(path.join(repoRoot, "scripts", "package-macos.mjs"), "utf8");
  const preloadSource = fs.readFileSync(path.join(repoRoot, "desktop", "preload.cjs"), "utf8");
  const rendererSource = fs.readFileSync(path.join(repoRoot, "desktop", "renderer", "app.js"), "utf8");
  assert.match(packageSource, /node_modules\\\/7zip-bin\\\/win/);
  assert.match(preloadSource, /softwareManagerPlatform:\s*process\.platform/);
  assert.match(rendererSource, /softwareManagerPlatform\s*!==\s*["']win32["']/);
});

test("release readiness validates the provisioned catalog trust and pinned helper", () => {
  const readiness = buildSoftwareManagerReleaseReadiness({ repoRoot, env: {} });
  assert.equal(readiness.items.find((item) => item.id === "software_manager_catalog_url")?.status, "pass");
  assert.equal(readiness.items.find((item) => item.id === "software_manager_7zip")?.status, "pass");
  assert.equal(readiness.items.find((item) => item.id === "software_manager_7zip_license")?.status, "pass");
  assert.equal(readiness.items.find((item) => item.id === "software_manager_catalog_trust")?.status, "pass");
});
