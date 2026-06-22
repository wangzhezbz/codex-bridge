import { packager } from "@electron/packager";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);
const electronPackageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "node_modules", "electron", "package.json"), "utf8"),
);
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
const outDir = path.join(repoRoot, "release", `CodexBridge-Windows-x64-Portable-${safeReleaseVersion}`);
const iconPath = path.join(repoRoot, "desktop", "assets", "codexbridge-icon.ico");

fs.mkdirSync(outDir, { recursive: true });

const appPaths = await packager({
  dir: repoRoot,
  name: "CodexBridge",
  executableName: "CodexBridge",
  platform: "win32",
  arch: "x64",
  out: outDir,
  asar: false,
  prune: true,
  overwrite: false,
  appVersion: packageJson.version,
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
  ],
});

console.log("Packaged Windows app:");
for (const appPath of appPaths) {
  console.log(appPath);
}
