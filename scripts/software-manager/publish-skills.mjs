import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { compareVersions } from "../../shared/software-manager/catalog-schema.mjs";
import { replaceCatalogEntry, readCurrentCatalog, replaceSignedCatalog } from "./catalog-builder.mjs";
import { inspectPackageTree, writeImmutableStoredZip } from "./package-inspector.mjs";
import { loadPublisherConfig } from "./publisher-config.mjs";

const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const VERSION = /^\d+(?:\.\d+){0,3}$/u;

function skillError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function exactRoot(value) {
  const raw = String(value || "");
  const root = path.resolve(raw);
  if (!raw || !path.isAbsolute(raw) || path.normalize(raw) !== raw) throw skillError("publisher_skills_root_invalid");
  return root;
}

function displayName(id) {
  return id.split("-").map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ");
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function skillPackageVersion(name, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped}-(\\d+(?:\\.\\d+){0,3})\\.zip$`, "u").exec(name)?.[1] || null;
}

async function retainSkillPackages(directory, id, keepNames) {
  const candidates = (await fsPromises.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && skillPackageVersion(entry.name, id))
    .map((entry) => entry.name)
    .sort((left, right) => compareVersions(skillPackageVersion(right, id), skillPackageVersion(left, id)));
  const keep = new Set([...keepNames, ...candidates].filter(Boolean).slice(0, 2));
  for (const name of candidates) if (!keep.has(name)) await fsPromises.unlink(path.join(directory, name));
}

export async function publishSkills({
  config = loadPublisherConfig(process.env),
  inputRoot,
  version,
  publishedAt = new Date().toISOString(),
  descriptions = {},
  readDirectory = fs.readdirSync,
} = {}) {
  const root = exactRoot(inputRoot);
  if (!VERSION.test(String(version || "")) || !Number.isFinite(Date.parse(publishedAt))) {
    throw skillError("publisher_skill_version_invalid");
  }
  const direct = readDirectory(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  if (!direct.length) throw skillError("publisher_skills_empty");
  const prepared = [];
  const ids = new Set();
  for (const entry of direct) {
    if (!entry.isDirectory()) throw skillError("publisher_skill_id_invalid");
    const folded = entry.name.toLocaleLowerCase("en-US");
    if (ids.has(folded)) throw skillError("publisher_skill_id_duplicate");
    ids.add(folded);
    if (!SKILL_ID.test(entry.name)) throw skillError("publisher_skill_id_invalid");
    const tree = inspectPackageTree(path.join(root, entry.name));
    if (!tree.files.includes("SKILL.md")) throw skillError("publisher_skill_entrypoint_missing");
    prepared.push({ id: entry.name, tree });
  }

  const packageDirectory = path.join(config.publicRoot, "packages", "skills");
  const created = [];
  try {
    for (const item of prepared) {
      const packageName = `${item.id}-${version}.zip`;
      const packagePath = path.join(packageDirectory, packageName);
      await writeImmutableStoredZip({ tree: item.tree, destination: packagePath });
      created.push({ ...item, packageName, packagePath });
    }
    const current = readCurrentCatalog(config.publicRoot, { signingKeyFile: config.signingKeyFile });
    const previous = new Map(current.skills.map((item) => [item.id, path.basename(item.assetUrl)]));
    const skills = created.map((item) => ({
      id: item.id,
      name: displayName(item.id),
      description: String(descriptions[item.id] || `${displayName(item.id)} skill.`).trim(),
      version: String(version),
      assetUrl: new URL(`skills/${item.packageName}`, config.packageBaseUrl).href,
      size: fs.statSync(item.packagePath).size,
      sha256: sha256File(item.packagePath),
      files: ["SKILL.md", ...item.tree.files.filter((value) => value !== "SKILL.md")],
    }));
    const events = ["package_verified"];
    const result = await replaceSignedCatalog({
      config,
      catalog: replaceCatalogEntry(current, { skills }),
      events,
    });
    for (const item of created) {
      await retainSkillPackages(packageDirectory, item.id, [item.packageName, previous.get(item.id)]);
    }
    return Object.freeze({ ...result, packagePaths: Object.freeze(created.map((item) => item.packagePath)) });
  } catch (error) {
    for (const item of created) {
      await fsPromises.unlink(item.packagePath).catch((failure) => {
        if (failure?.code !== "ENOENT") throw failure;
      });
    }
    throw error;
  }
}

function args(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--input") result.inputRoot = values[++index];
    else if (values[index] === "--version") result.version = values[++index];
    else if (values[index] === "--published-at") result.publishedAt = values[++index];
    else throw skillError("publisher_argument_invalid");
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await publishSkills(args(process.argv.slice(2)));
  console.log(JSON.stringify({ packagePaths: result.packagePaths, catalogPath: result.catalogPath }, null, 2));
}
