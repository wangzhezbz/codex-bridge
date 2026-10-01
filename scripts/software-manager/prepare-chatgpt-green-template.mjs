import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { getRawHeader } from "@electron/asar";

import {
  assertGreenRuntimeCompatible,
  hashPackageTree,
  inspectGreenRuntimeTemplate,
  inspectOfficialCodexPackage,
} from "./chatgpt-green-metadata.mjs";
import { inspectPackageTree } from "./package-inspector.mjs";
import { verifyAuthenticodeWindows } from "./create-chatgpt-green.mjs";
import { removeOwnedTemporaryDirectory } from "../smoke-temp-cleanup.mjs";

const OVERRIDES = Object.freeze([
  "windows-account.node",
  "windows-updater.node",
]);

function templateError(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function absoluteDirectory(value, code) {
  const raw = String(value || "");
  if (!raw || !path.isAbsolute(raw) || path.normalize(raw) !== raw) throw templateError(code);
  const resolved = path.resolve(raw);
  let stat;
  try { stat = fs.lstatSync(resolved); } catch (error) { throw templateError(code, error); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw templateError(code);
  return resolved;
}

function absoluteOutput(value) {
  const raw = String(value || "");
  if (!raw || !path.isAbsolute(raw) || path.normalize(raw) !== raw) throw templateError("green_template_output_invalid");
  return path.resolve(raw);
}

function exists(value) {
  try { fs.lstatSync(value); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function isInside(target, root) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
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

function copyEntry(entry, root) {
  const destination = path.join(root, ...entry.path.split("/"));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(entry.absolute, destination, fs.constants.COPYFILE_EXCL);
  return Object.freeze({ relativePath: entry.path, sha256: sha256File(destination) });
}

function signatureStatus(value) {
  return typeof value === "string" ? value : value?.status;
}

function readShellIntegrityMode(shellPath, asarPath) {
  const digest = crypto.createHash("sha256").update(getRawHeader(asarPath).headerString).digest("hex");
  const bytes = fs.readFileSync(shellPath);
  const needle = Buffer.from(digest, "ascii");
  const at = bytes.indexOf(needle);
  if (at >= 0 && bytes.indexOf(needle, at + 1) >= 0) {
    throw templateError("green_template_integrity_binding_ambiguous");
  }
  return at >= 0;
}

export async function prepareGreenRuntimeTemplate({
  inputPath,
  nativeOverrideRoot,
  outputPath,
  minimumWindowsBuild,
  verifyAuthenticode = verifyAuthenticodeWindows,
} = {}) {
  const output = absoluteOutput(outputPath);
  if (exists(output)) throw templateError("green_template_output_exists");
  if (!Number.isSafeInteger(minimumWindowsBuild) || minimumWindowsBuild < 1) {
    throw templateError("green_template_minimum_build_invalid");
  }
  if (typeof verifyAuthenticode !== "function") throw templateError("green_signature_verifier_required");
  const official = await inspectOfficialCodexPackage({ inputPath, verifyAuthenticode });
  const overrides = absoluteDirectory(nativeOverrideRoot, "green_template_overrides_invalid");
  if (isInside(output, official.packageRoot) || isInside(output, overrides)) {
    throw templateError("green_template_output_overlap");
  }
  const overrideTree = inspectPackageTree(overrides);
  if (overrideTree.files.length !== OVERRIDES.length
    || OVERRIDES.some((name) => !overrideTree.files.includes(name))) {
    throw templateError("green_template_overrides_invalid");
  }
  for (const name of OVERRIDES) {
    if (signatureStatus(await verifyAuthenticode(path.join(overrides, name))) !== "Valid") {
      throw templateError("green_template_signature_invalid");
    }
  }
  const originalOverrideTreeSha256 = hashPackageTree(overrides);
  const officialAppRoot = path.join(official.packageRoot, "app");
  const appTree = inspectPackageTree(officialAppRoot);
  const shellEntries = appTree.entries.filter((entry) => !entry.path.toLocaleLowerCase("en-US").startsWith("resources/"));
  if (!shellEntries.some((entry) => entry.path === "ChatGPT.exe")) {
    throw templateError("green_template_shell_missing");
  }

  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true });
  absoluteDirectory(parent, "green_template_output_parent_invalid");
  const staging = path.join(parent, `.codex-green-template-${crypto.randomUUID()}.part`);
  fs.mkdirSync(staging);
  let stagingOwned = true;
  try {
    const requiredShellFiles = shellEntries.map((entry) => copyEntry(entry, staging));
    const asarTarget = path.join(staging, "resources", "app.asar");
    fs.mkdirSync(path.dirname(asarTarget), { recursive: true });
    fs.copyFileSync(official.appAsarPath, asarTarget, fs.constants.COPYFILE_EXCL);
    const resourceOverrides = [];
    for (const name of OVERRIDES) {
      const relativePath = `portable-overrides/${name}`;
      const source = path.join(overrides, name);
      const destination = path.join(staging, "portable-overrides", name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      requiredShellFiles.push(Object.freeze({ relativePath, sha256: sha256File(destination) }));
      resourceOverrides.push(Object.freeze({
        sourceRelativePath: relativePath,
        targetRelativePath: `resources/native/${name}`,
      }));
    }
    if (hashPackageTree(official.packageRoot) !== official.sourceTreeSha256
      || hashPackageTree(overrides) !== originalOverrideTreeSha256) {
      throw templateError("green_template_source_changed");
    }
    const embeddedAsarIntegrity = readShellIntegrityMode(path.join(staging, "ChatGPT.exe"), asarTarget);
    const descriptor = {
      schemaVersion: embeddedAsarIntegrity ? 2 : 3,
      templateVersion: official.officialVersion,
      architecture: official.architecture,
      electronVersion: official.electronVersion,
      minimumWindowsBuild,
      supportedOwlAppApis: [...official.owlAppApis],
      requiredShellFiles: requiredShellFiles.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en")),
      resourceOverrides,
      acceptanceId: "pending-real-smoke",
      ...embeddedAsarIntegrity ? {} : { embeddedAsarIntegrity: false },
    };
    fs.writeFileSync(path.join(staging, ".codexbridge-green-runtime-template.json"),
      `${JSON.stringify(descriptor, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    const checked = await inspectGreenRuntimeTemplate({ templatePath: staging, verifyAuthenticode });
    assertGreenRuntimeCompatible(official, checked);
    if (exists(output)) throw templateError("green_template_output_exists");
    fs.renameSync(staging, output);
    stagingOwned = false;
    return Object.freeze({
      templateRoot: output,
      templateVersion: checked.templateVersion,
      shellTreeSha256: checked.shellTreeSha256,
      fileCount: checked.requiredShellFiles.length,
      acceptanceId: checked.acceptanceId,
    });
  } finally {
    if (stagingOwned && exists(staging)) {
      removeOwnedTemporaryDirectory(staging, {
        parentDirectory: parent,
        requiredPrefix: ".codex-green-template-",
      });
    }
  }
}

function parseArguments(argv) {
  const names = new Map([
    ["--input", "inputPath"],
    ["--native-overrides", "nativeOverrideRoot"],
    ["--output-dir", "outputPath"],
    ["--minimum-windows-build", "minimumWindowsBuild"],
  ]);
  const values = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const key = names.get(argv[index]);
    if (!key || Object.hasOwn(values, key) || index + 1 >= argv.length) {
      throw templateError("green_template_argument_invalid");
    }
    values[key] = argv[++index];
  }
  if (!values.inputPath || !values.nativeOverrideRoot || !values.outputPath
    || !values.minimumWindowsBuild) throw templateError("green_template_argument_invalid");
  values.minimumWindowsBuild = Number(values.minimumWindowsBuild);
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await prepareGreenRuntimeTemplate(parseArguments(process.argv.slice(2)))));
}
