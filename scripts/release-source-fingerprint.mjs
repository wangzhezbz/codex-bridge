import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { shouldIgnoreWindowsPackagePath } from "./package-content-policy.mjs";

export const WINDOWS_RELEASE_BUILD_METADATA_FILE = ".codexbridge-build.json";
export const WINDOWS_RELEASE_SOURCE_SCHEMA_VERSION = 1;

const WINDOWS_RELEASE_SOURCE_INPUTS = Object.freeze([
  "package.json",
  "package-lock.json",
  "config",
  "desktop",
  "shared",
  "src",
  "vendor/chatgpt-codex-bridge",
  "scripts/generate-catalog.js",
  "scripts/installer/windows",
  "scripts/package-content-policy.mjs",
  "scripts/package-macos.mjs",
  "scripts/package-windows.mjs",
  "scripts/package-windows-release-artifacts.mjs",
  "scripts/release-source-fingerprint.mjs",
  "scripts/release-version-policy.mjs",
  "scripts/run-installer-python-tests.mjs",
  "scripts/run-node-tests-isolated.mjs",
  "scripts/run-project-check.mjs",
  "scripts/run-syntax-checks.mjs",
  "scripts/smoke-temp-cleanup.mjs",
  "scripts/smoke-packaged-macos.mjs",
  "scripts/smoke-packaged-windows.mjs",
]);

export const DESKTOP_RELEASE_BUILD_METADATA_FILE = WINDOWS_RELEASE_BUILD_METADATA_FILE;

export function createWindowsReleaseSourceFingerprint(repoRoot = process.cwd()) {
  const root = path.resolve(repoRoot);
  const files = collectWindowsReleaseSourceFiles(root);
  const hash = crypto.createHash("sha256");
  hash.update(`codexbridge-windows-release-source-v${WINDOWS_RELEASE_SOURCE_SCHEMA_VERSION}\0`, "utf8");
  for (const relativePath of files) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const stat = fs.lstatSync(absolutePath);
    const pathBytes = Buffer.from(relativePath, "utf8");
    const content = stat.isSymbolicLink()
      ? Buffer.from(`symlink:${fs.readlinkSync(absolutePath)}`, "utf8")
      : fs.readFileSync(absolutePath);
    hash.update(String(pathBytes.length), "utf8");
    hash.update(":", "utf8");
    hash.update(pathBytes);
    hash.update(":", "utf8");
    hash.update(String(content.length), "utf8");
    hash.update(":", "utf8");
    hash.update(content);
    hash.update("\0", "utf8");
  }
  return Object.freeze({
    schemaVersion: WINDOWS_RELEASE_SOURCE_SCHEMA_VERSION,
    algorithm: "sha256",
    sourceFingerprint: hash.digest("hex"),
    sourceFileCount: files.length,
  });
}

export function collectWindowsReleaseSourceFiles(repoRoot = process.cwd()) {
  const root = path.resolve(repoRoot);
  const files = [];
  for (const input of WINDOWS_RELEASE_SOURCE_INPUTS) {
    const normalizedInput = normalizeRelativePath(input);
    const absoluteInput = path.join(root, ...normalizedInput.split("/"));
    if (!fs.existsSync(absoluteInput)) {
      throw new Error(`Windows release source input is missing: ${normalizedInput}`);
    }
    collectSourceEntry(root, absoluteInput, files);
  }
  files.sort(compareText);
  return Object.freeze(files);
}

export function buildWindowsReleaseBuildMetadata(repoRoot = process.cwd(), {
  appVersion = "",
  createdAt = new Date().toISOString(),
} = {}) {
  return Object.freeze({
    ...createWindowsReleaseSourceFingerprint(repoRoot),
    appVersion: String(appVersion || "").trim(),
    createdAt: String(createdAt || "").trim(),
  });
}

export const buildDesktopReleaseBuildMetadata = buildWindowsReleaseBuildMetadata;
export const createDesktopReleaseSourceFingerprint = createWindowsReleaseSourceFingerprint;

export function packagedSmokeSourceEvidence(report = {}, repoRoot = process.cwd()) {
  const current = createWindowsReleaseSourceFingerprint(repoRoot);
  const reportFingerprint = normalizeFingerprint(
    report?.sourceFingerprint || report?.buildMetadata?.sourceFingerprint,
  );
  const currentFingerprint = normalizeFingerprint(current.sourceFingerprint);
  const ok = Boolean(reportFingerprint) && reportFingerprint === currentFingerprint;
  return Object.freeze({
    ok,
    reportFingerprint,
    currentFingerprint,
    sourceFileCount: current.sourceFileCount,
    reason: ok
      ? "current_source_match"
      : reportFingerprint
        ? "source_fingerprint_mismatch"
        : "source_fingerprint_missing",
  });
}

function collectSourceEntry(root, absolutePath, files) {
  const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
  if (!relativePath || relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
    throw new Error(`Windows release source input escaped repository root: ${absolutePath}`);
  }
  if (shouldIgnoreWindowsPackagePath(relativePath)) {
    return;
  }
  const stat = fs.lstatSync(absolutePath);
  if (stat.isFile() || stat.isSymbolicLink()) {
    files.push(relativePath);
    return;
  }
  if (!stat.isDirectory()) {
    return;
  }
  const entries = fs.readdirSync(absolutePath, { withFileTypes: true }).sort((left, right) =>
    compareText(left.name, right.name)
  );
  for (const entry of entries) {
    collectSourceEntry(root, path.join(absolutePath, entry.name), files);
  }
}

function normalizeRelativePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//u, "").replace(/^\/+|\/+$/gu, "");
}

function normalizeFingerprint(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/u.test(normalized) ? normalized : "";
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
