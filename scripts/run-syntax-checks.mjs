import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = Object.freeze([
  "src",
  "desktop",
  "scripts",
  "shared",
  "tests",
  "deploy/codexbridge-installer",
  "vendor/chatgpt-codex-bridge",
]);
const syntaxExtensions = new Set([".js", ".mjs", ".cjs"]);
const files = collectSyntaxFiles();
const fileSet = new Set(files);

for (const requiredFile of process.argv.slice(2)) {
  const normalized = normalizeRelativePath(requiredFile);
  if (!fileSet.has(normalized)) {
    throw new Error(`Required syntax-check file is not covered: ${requiredFile}`);
  }
}

const failures = [];
let cursor = 0;
const workerCount = Math.max(1, Math.min(files.length, os.availableParallelism?.() || os.cpus().length || 4, 8));
await Promise.all(Array.from({ length: workerCount }, () => syntaxWorker()));

if (failures.length) {
  for (const failure of failures) {
    console.error(`Syntax check failed: ${failure.file}`);
    if (failure.stdout) console.error(failure.stdout.trimEnd());
    if (failure.stderr) console.error(failure.stderr.trimEnd());
  }
  process.exitCode = 1;
} else {
  console.log(`Syntax checks passed: ${files.length} files`);
}

async function syntaxWorker() {
  while (!failures.length) {
    const index = cursor;
    cursor += 1;
    if (index >= files.length) return;
    const file = files[index];
    try {
      await execFileAsync(process.execPath, ["--check", path.join(repoRoot, ...file.split("/"))], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
    } catch (error) {
      failures.push({
        file,
        stdout: String(error?.stdout || ""),
        stderr: String(error?.stderr || error?.message || error),
      });
    }
  }
}

function collectSyntaxFiles() {
  const collected = [];
  for (const root of sourceRoots) {
    const absoluteRoot = path.join(repoRoot, ...root.split("/"));
    if (!fs.existsSync(absoluteRoot)) {
      throw new Error(`Syntax-check source root is missing: ${root}`);
    }
    collectDirectory(absoluteRoot, collected);
  }
  collected.sort(compareText);
  return Object.freeze(collected);
}

function collectDirectory(directoryPath, collected) {
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true }).sort((left, right) =>
    compareText(left.name, right.name)
  );
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const absolutePath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      collectDirectory(absolutePath, collected);
    } else if (entry.isFile() && syntaxExtensions.has(path.extname(entry.name).toLowerCase())) {
      collected.push(normalizeRelativePath(path.relative(repoRoot, absolutePath)));
    }
  }
}

function normalizeRelativePath(value) {
  const normalized = String(value || "").replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("../") || path.isAbsolute(normalized)) {
    throw new Error(`Invalid syntax-check path: ${value}`);
  }
  return normalized;
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
