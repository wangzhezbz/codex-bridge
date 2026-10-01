import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import yauzl from "yauzl";

import { createGreenCodexDirectory } from "./chatgpt-green-converter.mjs";
import { inspectPackageTree, writeImmutableStoredZip } from "./package-inspector.mjs";

const execFileAsync = promisify(execFile);

function cliError(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function exactAbsolute(value) {
  const raw = String(value || "");
  if (!raw || !path.isAbsolute(raw) || path.normalize(raw) !== raw) throw cliError("green_cli_path_invalid");
  return path.resolve(raw);
}

function exists(filePath) {
  try { fs.lstatSync(filePath); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function parseArguments(argv) {
  const values = Object.create(null);
  const names = new Map([
    ["--input", "inputPath"],
    ["--runtime-template", "runtimeTemplatePath"],
    ["--output-dir", "outputPath"],
    ["--zip", "zipPath"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = names.get(argv[index]);
    if (!key || Object.hasOwn(values, key) || index + 1 >= argv.length) throw cliError("green_cli_argument_invalid");
    const next = argv[++index];
    if (names.has(next)) throw cliError("green_cli_argument_invalid");
    values[key] = exactAbsolute(next);
  }
  if (!values.inputPath || !values.runtimeTemplatePath || !values.outputPath) {
    throw cliError("green_cli_argument_invalid");
  }
  if (values.zipPath && path.extname(values.zipPath).toLocaleLowerCase("en-US") !== ".zip") {
    throw cliError("green_cli_zip_invalid");
  }
  return Object.freeze(values);
}

export async function verifyAuthenticodeWindows(filePath) {
  const command = [
    "$ErrorActionPreference='Stop'",
    "$s=Get-AuthenticodeSignature -LiteralPath $env:CB_GREEN_SIGNATURE_PATH",
    "[Console]::Out.Write([string]$s.Status)",
  ].join(";");
  const powershell = path.join(
    String(process.env.SystemRoot || "C:\\Windows"),
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
  );
  const { stdout } = await execFileAsync(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command,
  ], {
    env: { CB_GREEN_SIGNATURE_PATH: filePath },
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 64 * 1024,
  });
  return String(stdout).trim();
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function verifyStoredZip(zipPath, tree) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (openError, archive) => {
      if (openError) { reject(cliError("green_cli_zip_invalid", openError)); return; }
      const expected = new Map(tree.entries.map((entry) => [entry.path, entry]));
      const seen = new Set();
      archive.once("error", (error) => reject(cliError("green_cli_zip_invalid", error)));
      archive.on("entry", (entry) => {
        const source = expected.get(entry.fileName);
        if (!source || seen.has(entry.fileName) || entry.compressionMethod !== 0
          || entry.uncompressedSize !== source.size || entry.crc32 !== source.crc32) {
          archive.close();
          reject(cliError("green_cli_zip_mismatch"));
          return;
        }
        seen.add(entry.fileName);
        archive.readEntry();
      });
      archive.once("end", () => {
        if (seen.size !== expected.size) reject(cliError("green_cli_zip_mismatch"));
        else resolve();
      });
      archive.readEntry();
    });
  });
}

export async function runCreateGreenCli({
  argv = process.argv.slice(2),
  verifyAuthenticode = verifyAuthenticodeWindows,
  writeStdout = (line) => console.log(line),
} = {}) {
  const options = parseArguments(argv);
  if (options.zipPath && exists(options.zipPath)) throw cliError("green_cli_zip_exists");
  const built = await createGreenCodexDirectory({
    inputPath: options.inputPath,
    runtimeTemplatePath: options.runtimeTemplatePath,
    outputPath: options.outputPath,
    verifyAuthenticode,
  });
  let zipSize = 0;
  let zipSha256 = null;
  if (options.zipPath) {
    const tree = inspectPackageTree(options.outputPath);
    await writeImmutableStoredZip({ tree, destination: options.zipPath });
    try {
      await verifyStoredZip(options.zipPath, tree);
      zipSize = fs.statSync(options.zipPath).size;
      zipSha256 = sha256File(options.zipPath);
    } catch (error) {
      fs.unlinkSync(options.zipPath);
      throw error;
    }
  }
  const result = Object.freeze({
    state: "verified",
    outputDirectory: options.outputPath,
    zipPath: options.zipPath ?? null,
    officialVersion: built.officialVersion,
    electronVersion: built.electronVersion,
    contentTreeSha256: built.contentTreeSha256,
    fileCount: built.fileCount,
    totalBytes: built.totalBytes,
    zipSize,
    zipSha256,
  });
  writeStdout(JSON.stringify(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCreateGreenCli();
}
