import { packager } from "@electron/packager";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WINDOWS_PACKAGE_HARDENING_RULES,
  assertWindowsPackageFilePaths,
} from "./package-content-policy.mjs";
import {
  DESKTOP_RELEASE_BUILD_METADATA_FILE,
  buildDesktopReleaseBuildMetadata,
  createDesktopReleaseSourceFingerprint,
} from "./release-source-fingerprint.mjs";
import { removeOwnedTemporaryDirectory } from "./smoke-temp-cleanup.mjs";
import { assertReleaseTagMatchesPackageVersion } from "./release-version-policy.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);
const electronPackageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "node_modules", "electron", "package.json"), "utf8"),
);
assertReleaseTagMatchesPackageVersion({ env: process.env, packageVersion: packageJson.version });
const localStamp = new Date()
  .toISOString()
  .replaceAll(":", "")
  .replaceAll(".", "")
  .replace("T", "-")
  .replace("Z", "");
const releaseVersion =
  process.env.CODEXBRIDGE_RELEASE_VERSION ||
  process.env.GITHUB_REF_NAME ||
  `v${packageJson.version}-local-${localStamp}`;
const safeReleaseVersion = releaseVersion.replace(/[^A-Za-z0-9._-]/g, "-");
const targetArch = normalizeArch(process.env.CODEXBRIDGE_MAC_ARCH || process.arch);
const releaseRoot = path.join(repoRoot, "release");
const outDir = path.join(
  releaseRoot,
  `CodexBridge-macOS-${targetArch}-Portable-${safeReleaseVersion}`,
);
const iconPath = path.join(repoRoot, "desktop", "assets", "codexbridge-icon.icns");
const buildMetadata = buildDesktopReleaseBuildMetadata(repoRoot, {
  appVersion: packageJson.version,
});

fs.mkdirSync(releaseRoot, { recursive: true });
let ownsOutDir = false;
try {
  fs.mkdirSync(outDir);
  ownsOutDir = true;
} catch (error) {
  if (error?.code !== "EEXIST") throw error;
  throw new Error(`macOS package output already exists; choose a new release version: ${outDir}`);
}

let appPaths;
try {
appPaths = await packager({
  dir: repoRoot,
  name: "CodexBridge",
  executableName: "CodexBridge",
  platform: "darwin",
  arch: targetArch,
  out: outDir,
  asar: false,
  prune: true,
  overwrite: false,
  appVersion: packageJson.version,
  appBundleId: "com.codexbridge.app",
  electronVersion: electronPackageJson.version,
  icon: iconPath,
  appCopyright: "Copyright (c) 2026 CodexBridge contributors",
  download: {
    mirrorOptions: {
      mirror: "https://npmmirror.com/mirrors/electron/",
    },
  },
  ignore: [
    /^\/\.git(?:\/|$)/,
    /^\/\.github(?:\/|$)/,
    /^\/\.agents(?:\/|$)/,
    /^\/\.codex(?:\/|$)/,
    /^\/\.superpowers(?:\/|$)/,
    /^\/\.tmp(?:-|\/|$)/,
    /^\/\.tmp-release-/,
    /^\/\.tmp-electron-packager(?:\/|$)/,
    /^\/AGENTS\.md$/,
    /^\/Start-CodexBridge\.cmd$/,
    /^\/release(?:\/|$)/,
    /^\/dist(?:\/|$)/,
    /^\/build(?:\/|$)/,
    /^\/coverage(?:\/|$)/,
    /^\/data(?:\/|$)/,
    /^\/logs(?:\/|$)/,
    /^\/tests(?:\/|$)/,
    /^\/docs\/imported(?:\/|$)/,
    /^\/docs\/superpowers(?:\/|$)/,
    /^\/scripts\/(?!generate-catalog\.js$)/,
    /^\/research(?:\/|$)/,
    /^\/config\/router\.config\.json$/,
    /^\/config\/secrets\.local\.json$/,
    /^\/model-catalog\.json$/,
    /^\/node_modules\/7zip-bin\/win(?:\/|$)/,
    ...WINDOWS_PACKAGE_HARDENING_RULES.map((rule) => rule.pattern),
  ],
});

console.log(`Packaged macOS ${targetArch} app:`);
for (const appPath of appPaths) {
  const appRoot = path.join(appPath, "CodexBridge.app", "Contents", "Resources", "app");
  const currentSource = createDesktopReleaseSourceFingerprint(repoRoot);
  if (currentSource.sourceFingerprint !== buildMetadata.sourceFingerprint) {
    throw new Error("Desktop release source changed while the macOS package was being created. Run package:mac again.");
  }
  fs.writeFileSync(
    path.join(appRoot, DESKTOP_RELEASE_BUILD_METADATA_FILE),
    `${JSON.stringify(buildMetadata, null, 2)}\n`,
    "utf8",
  );
  assertWindowsPackageFilePaths(listRegularFilePaths(appRoot));
  console.log(appPath);
}
} catch (error) {
  if (ownsOutDir && fs.existsSync(outDir)) {
    try {
      removeOwnedTemporaryDirectory(outDir, {
        parentDirectory: releaseRoot,
        requiredPrefix: `CodexBridge-macOS-${targetArch}-Portable-`,
      });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "macOS packaging and partial-output cleanup both failed.");
    }
  }
  throw error;
}

function listRegularFilePaths(rootDir) {
  const pending = [rootDir];
  const files = [];
  while (pending.length) {
    const currentDir = pending.pop();
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile()) files.push(path.relative(rootDir, fullPath).split(path.sep).join("/"));
    }
  }
  return files.sort();
}

function normalizeArch(value) {
  if (value === "arm64" || value === "x64") {
    return value;
  }
  throw new Error(`Unsupported macOS arch: ${value}. Use x64 or arm64.`);
}
