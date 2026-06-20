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
const stamp = new Date()
  .toISOString()
  .replaceAll(":", "")
  .replaceAll(".", "")
  .replace("T", "-")
  .replace("Z", "");
const outDir = path.join(repoRoot, "release", `codexbridge-${packageJson.version}-${stamp}`);

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
  appCopyright: "Copyright (c) 2026 CodexBridge contributors",
  download: {
    mirrorOptions: {
      mirror: "https://npmmirror.com/mirrors/electron/",
    },
  },
  ignore: [
    /^\/\.git(?:\/|$)/,
    /^\/\.github(?:\/|$)/,
    /^\/release(?:\/|$)/,
    /^\/dist(?:\/|$)/,
    /^\/build(?:\/|$)/,
    /^\/coverage(?:\/|$)/,
    /^\/data(?:\/|$)/,
    /^\/logs(?:\/|$)/,
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
