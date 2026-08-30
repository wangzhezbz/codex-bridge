import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertWindowsPackageTree } from "./package-content-policy.mjs";
import {
  WINDOWS_RELEASE_BUILD_METADATA_FILE,
  packagedSmokeSourceEvidence,
} from "./release-source-fingerprint.mjs";
import { assertReleaseTagMatchesPackageVersion } from "./release-version-policy.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const args = parseArgs(process.argv.slice(2));
assertReleaseTagMatchesPackageVersion({ env: process.env, packageVersion: packageJson.version });
const distDir = path.resolve(repoRoot, args.outDir || "dist-artifacts");
const appPath = path.resolve(args.appDir || findPackagedWindowsAppDir());
const smokeReportPath = path.resolve(
  args.smokeReport || path.join(repoRoot, "release", "packaged-smoke-report.json"),
);
const portableZip = path.join(distDir, "CodexBridge-Windows-x64-Portable.zip");
const setupExe = path.join(distDir, "CodexBridge-Windows-x64-Setup.exe");
const stagingNonce = randomUUID().replaceAll("-", "");
const portableZipStaging = path.join(distDir, `.CodexBridge-Windows-x64-Portable-${stagingNonce}.part`);
const setupExeStaging = path.join(distDir, `.CodexBridge-Windows-x64-Setup-${stagingNonce}.part`);
const iconPath = path.join(repoRoot, "desktop", "assets", "codexbridge-icon.ico");
const installerScript = path.join(repoRoot, "scripts", "installer", "windows", "CodexBridge.nsi");
const makensis = args.portableOnly ? null : resolveMakensis();

const buildMetadata = assertPackagedApp(appPath);
assertMatchingPackagedSmoke({ appPath, buildMetadata, smokeReportPath });
ensureRealOutputDirectory(distDir);
assertReleaseArtifactTargetsAvailable();

const published = [];
try {
  createPortableZip({ appPath, portableZip: portableZipStaging });
  if (!args.portableOnly) {
    createWindowsInstaller({ appPath, setupExe: setupExeStaging, makensis });
  }
  fs.renameSync(portableZipStaging, portableZip);
  published.push(portableZip);
  if (!args.portableOnly) {
    fs.renameSync(setupExeStaging, setupExe);
    published.push(setupExe);
  }
} catch (error) {
  const cleanupErrors = [];
  for (const target of [portableZipStaging, setupExeStaging, ...published]) {
    try {
      removeExactArtifactFile(target);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
  }
  if (cleanupErrors.length) {
    throw new AggregateError([error, ...cleanupErrors], "Release artifact creation and exact-file cleanup both failed.");
  }
  throw error;
}

console.log("Windows release artifacts created:");
console.log(portableZip);
if (!args.portableOnly) {
  console.log(setupExe);
}

function assertReleaseArtifactTargetsAvailable() {
  const occupied = [
    portableZip,
    portableZipStaging,
    ...(args.portableOnly ? [] : [setupExe, setupExeStaging]),
  ]
    .filter((target) => fs.existsSync(target));
  if (occupied.length) {
    throw new Error(
      `Release artifact target already exists; choose an empty --out-dir so releases cannot mix: ${occupied.join(", ")}`,
    );
  }
}

function ensureRealOutputDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
  const stat = fs.lstatSync(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Release artifact output is not a real directory: ${directoryPath}`);
  }
}

function removeExactArtifactFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const resolved = path.resolve(filePath);
  if (!samePath(path.dirname(resolved), distDir)) {
    throw new Error(`Refusing release artifact cleanup outside output directory: ${resolved}`);
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw new Error(`Refusing release artifact cleanup for a non-file: ${resolved}`);
  }
  fs.unlinkSync(resolved);
}

function parseArgs(values = []) {
  const parsed = {
    appDir: "",
    outDir: "",
    smokeReport: "",
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
    } else if (value === "--smoke-report") {
      parsed.smokeReport = requireValue(values, index);
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
  const appRoot = path.join(appPath, "resources", "app");
  const required = [
    path.join(appPath, "CodexBridge.exe"),
    path.join(appRoot, "package.json"),
    path.join(appRoot, "src", "server.js"),
    path.join(appRoot, WINDOWS_RELEASE_BUILD_METADATA_FILE),
  ];
  for (const filePath of required) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Packaged Windows app is missing required file: ${filePath}`);
    }
  }
  assertWindowsPackageTree(appRoot, { requireSoftwareManager: true });
  const packagedApp = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
  const buildMetadata = JSON.parse(
    fs.readFileSync(path.join(appRoot, WINDOWS_RELEASE_BUILD_METADATA_FILE), "utf8"),
  );
  if (buildMetadata.appVersion !== packagedApp.version) {
    throw new Error("Packaged Windows app build metadata version does not match package.json.");
  }
  const sourceEvidence = packagedSmokeSourceEvidence({ buildMetadata }, repoRoot);
  if (!sourceEvidence.ok) {
    throw new Error("Packaged Windows app was built from older source. Run package:win again.");
  }
  return buildMetadata;
}

function assertMatchingPackagedSmoke({ appPath, buildMetadata, smokeReportPath }) {
  if (!fs.existsSync(smokeReportPath)) {
    throw new Error(`Packaged smoke report is missing: ${smokeReportPath}. Run package:win:smoke first.`);
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(smokeReportPath, "utf8"));
  } catch (error) {
    throw new Error(`Packaged smoke report is unreadable: ${error?.message || error}`);
  }
  const expectedExePath = path.join(appPath, "CodexBridge.exe");
  const sameBuild = report?.buildMetadata?.sourceFingerprint === buildMetadata.sourceFingerprint
    && report?.buildMetadata?.appVersion === buildMetadata.appVersion;
  const reportMatchesApp = samePath(report?.appPath, appPath)
    && samePath(report?.exePath, expectedExePath);
  const smokePassed = report?.ok === true
    && report?.embeddedBridgeSmoke?.ok === true
    && report?.desktopSmoke?.ok === true
    && report?.routerSmoke?.ok === true
    && report?.packageContent?.forbiddenFiles === 0
    && Number(report?.packageContent?.softwareManager?.requiredFiles || 0) > 0;
  const sourceEvidence = packagedSmokeSourceEvidence(report, repoRoot);
  if (!sameBuild || !reportMatchesApp || !smokePassed || !sourceEvidence.ok) {
    throw new Error(
      "Packaged smoke report does not prove this exact current app. Run package:win:smoke for the selected package before creating release artifacts.",
    );
  }
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(String(left || ""));
  const normalizedRight = path.resolve(String(right || ""));
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function createPortableZip({ appPath, portableZip }) {
  runPowerShell([
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName System.IO.Compression.FileSystem",
      `$source = [IO.Path]::GetFullPath(${psQuote(appPath)})`,
      `$destination = [IO.Path]::GetFullPath(${psQuote(portableZip)})`,
      "if (Test-Path -LiteralPath $destination) { throw 'Release staging file already exists.' }",
      "[IO.Compression.ZipFile]::CreateFromDirectory($source, $destination, [IO.Compression.CompressionLevel]::Optimal, $false)",
      "$archive = [IO.Compression.ZipFile]::Open($destination, [IO.Compression.ZipArchiveMode]::Update)",
      "try { $entry = $archive.CreateEntry('.codexbridge-portable', [IO.Compression.CompressionLevel]::NoCompression); $stream = $entry.Open(); $stream.Dispose() } finally { $archive.Dispose() }",
    ].join("; "),
  ]);
  if (!fs.existsSync(portableZip)) {
    throw new Error(`Portable zip was not created: ${portableZip}`);
  }
}

function createWindowsInstaller({ appPath, setupExe, makensis }) {
  withShortWindowsAppPath(appPath, (shortAppPath) => {
    const result = spawnSync(makensis.command, [
      ...makensis.argsPrefix,
      `/DVERSION=${packageJson.version}`,
      `/DAPP_DIR=${shortAppPath}`,
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
  });
  if (!fs.existsSync(setupExe)) {
    throw new Error(`Windows installer was not created: ${setupExe}`);
  }
}

function withShortWindowsAppPath(appPath, operation) {
  if (process.platform !== "win32") return operation(appPath);
  const systemRoot = String(process.env.SystemRoot || "");
  const subst = path.join(systemRoot, "System32", "subst.exe");
  if (!path.win32.isAbsolute(systemRoot) || !fs.existsSync(subst)) {
    throw new Error("Could not locate the trusted Windows subst.exe helper.");
  }
  const originalIdentity = fs.statSync(appPath);
  let mappedDrive = "";
  for (const letter of ["Z", "Y", "X", "W", "V", "U", "T", "S", "R"]) {
    const candidate = `${letter}:`;
    if (fs.existsSync(`${candidate}\\`)) continue;
    const result = spawnSync(subst, [candidate, appPath], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (!result.error && result.status === 0) {
      mappedDrive = candidate;
      break;
    }
  }
  if (!mappedDrive) throw new Error("Could not reserve a short Windows drive for NSIS input.");
  const mappedRoot = `${mappedDrive}\\`;
  let operationError = null;
  let operationResult;
  try {
    const mappedIdentity = fs.statSync(mappedRoot);
    if (mappedIdentity.dev !== originalIdentity.dev || mappedIdentity.ino !== originalIdentity.ino) {
      throw new Error("Short Windows NSIS drive does not reference the packaged app.");
    }
    operationResult = operation(mappedRoot);
  } catch (error) {
    operationError = error;
  }
  const cleanup = spawnSync(subst, [mappedDrive, "/D"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const cleanupError = cleanup.error || cleanup.status !== 0 || fs.existsSync(mappedRoot)
    ? new Error("Failed to release the short Windows NSIS drive.")
    : null;
  if (operationError && cleanupError) {
    throw new AggregateError([operationError, cleanupError], "NSIS build and short-drive cleanup both failed.");
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  return operationResult;
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
  node scripts/package-windows-release-artifacts.mjs --app-dir <CodexBridge-win32-x64> --smoke-report <packaged-smoke-report.json> --out-dir dist-artifacts

Creates:
  dist-artifacts/CodexBridge-Windows-x64-Portable.zip
  dist-artifacts/CodexBridge-Windows-x64-Setup.exe
`);
}
