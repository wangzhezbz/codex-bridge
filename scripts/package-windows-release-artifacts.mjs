import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const args = parseArgs(process.argv.slice(2));
const distDir = path.resolve(repoRoot, args.outDir || "dist-artifacts");
const appPath = path.resolve(args.appDir || findPackagedWindowsAppDir());
const portableZip = path.join(distDir, "CodexBridge-Windows-x64-Portable.zip");
const setupExe = path.join(distDir, "CodexBridge-Windows-x64-Setup.exe");
const iconPath = path.join(repoRoot, "desktop", "assets", "codexbridge-icon.ico");
const installerScript = path.join(repoRoot, "scripts", "installer", "windows", "CodexBridge.nsi");
const makensis = args.portableOnly ? null : resolveMakensis();

assertPackagedApp(appPath);
fs.mkdirSync(distDir, { recursive: true });

createPortableZip({ appPath, portableZip });
if (!args.portableOnly) {
  createWindowsInstaller({ appPath, setupExe, makensis });
}

console.log("Windows release artifacts created:");
console.log(portableZip);
if (!args.portableOnly) {
  console.log(setupExe);
}

function parseArgs(values = []) {
  const parsed = {
    appDir: "",
    outDir: "",
    portableOnly: false,
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--app-dir") {
      parsed.appDir = requireValue(values, index);
      index += 1;
    } else if (value === "--out-dir") {
      parsed.outDir = requireValue(values, index);
      index += 1;
    } else if (value === "--portable-only") {
      parsed.portableOnly = true;
    } else if (value === "--help" || value === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown Windows artifact option: ${value}`);
    }
  }
  return parsed;
}

function requireValue(values, index) {
  const next = values[index + 1];
  if (!next || next.startsWith("--")) {
    throw new Error(`Missing value for ${values[index]}`);
  }
  return next;
}

function findPackagedWindowsAppDir() {
  const releaseDir = path.join(repoRoot, "release");
  const candidates = [];
  visitDirectories(releaseDir, (dirPath, entry) => {
    if (entry.name !== "CodexBridge-win32-x64") {
      return;
    }
    const exePath = path.join(dirPath, "CodexBridge.exe");
    const appPackageJson = path.join(dirPath, "resources", "app", "package.json");
    if (!fs.existsSync(exePath) || !fs.existsSync(appPackageJson)) {
      return;
    }
    candidates.push({
      dirPath,
      mtimeMs: fs.statSync(dirPath).mtimeMs,
    });
  });
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (!candidates.length) {
    throw new Error("Could not find packaged CodexBridge-win32-x64 directory. Run npm run package:win first.");
  }
  return candidates[0].dirPath;
}

function visitDirectories(root, visitor) {
  if (!fs.existsSync(root)) {
    return;
  }
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dirPath = path.join(root, entry.name);
    visitor(dirPath, entry);
    visitDirectories(dirPath, visitor);
  }
}

function assertPackagedApp(appPath) {
  const required = [
    path.join(appPath, "CodexBridge.exe"),
    path.join(appPath, "resources", "app", "package.json"),
    path.join(appPath, "resources", "app", "src", "server.js"),
  ];
  for (const filePath of required) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Packaged Windows app is missing required file: ${filePath}`);
    }
  }
}

function createPortableZip({ appPath, portableZip }) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-portable-root-"));
  copyDirectoryContents(appPath, tempRoot);
  fs.writeFileSync(path.join(tempRoot, ".codexbridge-portable"), "", "utf8");
  runPowerShell([
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    [
      "$ErrorActionPreference = 'Stop'",
      `$source = Join-Path ${psQuote(tempRoot)} '*'`,
      `Compress-Archive -Path $source -DestinationPath ${psQuote(portableZip)} -Force`,
    ].join("; "),
  ]);
  if (!fs.existsSync(portableZip)) {
    throw new Error(`Portable zip was not created: ${portableZip}`);
  }
}

function createWindowsInstaller({ appPath, setupExe, makensis }) {
  const result = spawnSync(makensis.command, [
    ...makensis.argsPrefix,
    `/DVERSION=${packageJson.version}`,
    `/DAPP_DIR=${appPath}`,
    `/DOUT_FILE=${setupExe}`,
    `/DICON_PATH=${iconPath}`,
    installerScript,
  ], {
    cwd: repoRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`makensis failed with exit code ${result.status}.`);
  }
  if (!fs.existsSync(setupExe)) {
    throw new Error(`Windows installer was not created: ${setupExe}`);
  }
}

function resolveMakensis() {
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "";
  const candidates = [
    makensisCandidate(process.env.MAKENSIS_EXE, envMakensisExtraArgs()),
    makensisCandidate(programFilesX86 ? path.join(programFilesX86, "NSIS", "makensis.exe") : ""),
    makensisCandidate("makensis"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, [...candidate.argsPrefix, "/VERSION"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }
  throw new Error("Could not find makensis. Install NSIS or set MAKENSIS_EXE to makensis.exe.");
}

function makensisCandidate(command, argsPrefix = []) {
  const clean = String(command || "").trim();
  if (!clean) {
    return null;
  }
  return {
    command: clean,
    argsPrefix: Array.isArray(argsPrefix) ? argsPrefix.map(String) : [],
  };
}

function envMakensisExtraArgs() {
  const raw = String(process.env.MAKENSIS_EXTRA_ARGS || "").trim();
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map(String);
    }
  } catch {
    // Fall through to whitespace splitting for simple local overrides.
  }
  return raw.split(/\s+/).filter(Boolean);
}

function copyDirectoryContents(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryContents(source, target);
    } else if (entry.isFile()) {
      fs.copyFileSync(source, target);
    } else if (entry.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(source);
      fs.symlinkSync(linkTarget, target);
    }
  }
}

function runPowerShell(args) {
  const result = spawnSync("powershell.exe", args, {
    cwd: repoRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`PowerShell failed with exit code ${result.status}.`);
  }
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function printHelp() {
  console.log(`CodexBridge Windows release artifacts

Usage:
  npm run package:win:artifacts
  node scripts/package-windows-release-artifacts.mjs --app-dir <CodexBridge-win32-x64> --out-dir dist-artifacts
  node scripts/package-windows-release-artifacts.mjs --portable-only --app-dir <CodexBridge-win32-x64> --out-dir dist-artifacts

Creates:
  dist-artifacts/CodexBridge-Windows-x64-Portable.zip
  dist-artifacts/CodexBridge-Windows-x64-Setup.exe
`);
}
