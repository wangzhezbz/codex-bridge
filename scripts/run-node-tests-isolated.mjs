import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { removeOwnedTemporaryDirectory } from "./smoke-temp-cleanup.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testFiles = expandTestArguments(process.argv.slice(2));
if (!testFiles.length) throw new Error("At least one test file or test glob is required.");

const inheritedTemp = inheritedProjectCheckTemp();
const ownsTemp = !inheritedTemp;
const parentTemp = ownsTemp ? path.resolve(os.tmpdir()) : "";
const testTemp = inheritedTemp || fs.mkdtempSync(path.join(parentTemp, "cbtest-"));
const childEnv = {
  ...process.env,
  TEMP: testTemp,
  TMP: testTemp,
  TMPDIR: testTemp,
  CODEXBRIDGE_ISOLATED_TEST_TEMP: testTemp,
};
let testError = null;
let cleanupError = null;

try {
  const result = spawnSync(process.execPath, ["--test", ...testFiles], {
    cwd: repoRoot,
    env: childEnv,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`Node test suite failed with exit ${result.status}.`);
    error.code = "isolated_node_test_failed";
    throw error;
  }
} catch (error) {
  testError = error;
} finally {
  if (ownsTemp) {
    try {
      removeOwnedTemporaryDirectory(testTemp, {
        parentDirectory: parentTemp,
        requiredPrefix: "cbtest-",
      });
    } catch (error) {
      cleanupError = error;
    }
  }
}

if (testError && cleanupError) {
  throw new AggregateError([testError, cleanupError], "Node tests and temporary cleanup both failed.");
}
if (testError) throw testError;
if (cleanupError) throw cleanupError;
if (ownsTemp) console.log(`Isolated Node test workspace was removed: ${testTemp}`);

function expandTestArguments(values) {
  const expanded = [];
  for (const value of values) {
    const normalized = normalizeTestPath(value);
    if (!normalized.includes("*")) {
      assertTestFile(normalized);
      expanded.push(normalized);
      continue;
    }
    const directory = path.posix.dirname(normalized);
    const basenamePattern = path.posix.basename(normalized);
    if (directory.includes("*") || basenamePattern.includes("?")) {
      throw new Error(`Unsupported test glob: ${value}`);
    }
    const absoluteDirectory = path.join(repoRoot, ...directory.split("/"));
    const matcher = new RegExp(`^${escapeRegex(basenamePattern).replaceAll("\\*", ".*")}$`, "u");
    const matches = fs.readdirSync(absoluteDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && matcher.test(entry.name))
      .map((entry) => `${directory}/${entry.name}`)
      .sort(compareText);
    if (!matches.length) throw new Error(`Test glob matched no files: ${value}`);
    for (const match of matches) assertTestFile(match);
    expanded.push(...matches);
  }
  return Object.freeze([...new Set(expanded)]);
}

function normalizeTestPath(value) {
  const normalized = String(value || "").replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized.startsWith("tests/") || normalized.includes("../") || path.isAbsolute(normalized)) {
    throw new Error(`Test path must stay inside tests/: ${value}`);
  }
  return normalized;
}

function assertTestFile(relativePath) {
  if (!relativePath.endsWith(".test.js")) {
    throw new Error(`Only .test.js files may run through the isolated test launcher: ${relativePath}`);
  }
  const absolutePath = path.join(repoRoot, ...relativePath.split("/"));
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    throw new Error(`Test file is missing: ${relativePath}`);
  }
}

function inheritedProjectCheckTemp() {
  const candidate = String(process.env.CODEXBRIDGE_PROJECT_CHECK_TEMP || "").trim();
  if (!candidate) return "";
  const resolved = path.resolve(candidate);
  if (!path.basename(resolved).startsWith("cbcheck-") || !fs.existsSync(resolved)) {
    throw new Error("Inherited project-check temporary directory is invalid.");
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Inherited project-check temporary directory is not a real directory.");
  }
  for (const key of ["TEMP", "TMP", "TMPDIR"]) {
    const value = String(process.env[key] || "").trim();
    if (value && path.resolve(value) !== resolved) {
      throw new Error(`Inherited project-check temporary directory does not match ${key}.`);
    }
  }
  return resolved;
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+*?.]/gu, "\\$&");
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
