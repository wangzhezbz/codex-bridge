import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ProxyAgent } from "undici";

import { CURATED_SKILL_SOURCES, selectCuratedSourceFiles } from "./curated-sources.mjs";
import { readCurrentCatalog, replaceSignedCatalog } from "./catalog-builder.mjs";
import { publishSkills } from "./publish-skills.mjs";
import { loadPublisherConfig } from "./publisher-config.mjs";

const MAX_TOTAL_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const outboundProxy = String(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || "").trim();
const proxyDispatcher = outboundProxy ? new ProxyAgent(outboundProxy) : null;

function defaultFetch(url, options = {}) {
  const request = { ...options, signal: options.signal ?? AbortSignal.timeout(30_000) };
  return globalThis.fetch(url, proxyDispatcher ? { ...request, dispatcher: proxyDispatcher } : request);
}

function curatedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function exactNewRoot(value) {
  const raw = String(value || "");
  const root = path.resolve(raw);
  if (!raw || !path.isAbsolute(raw) || path.normalize(raw) !== raw || root === path.parse(root).root) {
    throw curatedError("curated_skill_output_root_invalid");
  }
  if (fs.existsSync(root)) throw curatedError("curated_skill_output_root_exists");
  return root;
}

function rawUrl(source, sourcePath) {
  const encodedPath = sourcePath.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${source.repo}/${source.commit}/${encodedPath}`;
}

async function responseBytes(response, expectedSize) {
  if (!response?.ok || typeof response.arrayBuffer !== "function") throw curatedError("curated_skill_file_download_failed");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== expectedSize) throw curatedError("curated_skill_file_size_mismatch");
  return bytes;
}

export async function prepareCuratedSkills({
  outputRoot,
  sources = CURATED_SKILL_SOURCES,
  fetchImpl = defaultFetch,
} = {}) {
  const root = exactNewRoot(outputRoot);
  if (typeof fetchImpl !== "function" || !Array.isArray(sources) || !sources.length
    || new Set(sources.map(({ id }) => id)).size !== sources.length) {
    throw curatedError("curated_skill_prepare_input_invalid");
  }
  const prepared = [];
  let totalBytes = 0;
  await fsPromises.mkdir(root, { recursive: false });
  try {
    for (const source of sources) {
      const treeUrl = `https://api.github.com/repos/${source.repo}/git/trees/${source.commit}?recursive=1`;
      const treeResponse = await fetchImpl(treeUrl, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "CodexBridge-curated-skill-publisher" },
      });
      if (!treeResponse?.ok || typeof treeResponse.json !== "function") throw curatedError("curated_skill_tree_download_failed");
      const payload = await treeResponse.json();
      if (payload?.truncated === true) throw curatedError("curated_skill_tree_truncated");
      const selected = selectCuratedSourceFiles(source, payload?.tree);
      const skillRoot = path.join(root, source.id);
      await fsPromises.mkdir(skillRoot, { recursive: false });
      for (const file of selected) {
        totalBytes += file.size;
        if (totalBytes > MAX_TOTAL_DOWNLOAD_BYTES) throw curatedError("curated_skill_total_size_limit");
        const destination = path.join(skillRoot, ...file.outputPath.split("/"));
        const relative = path.relative(skillRoot, destination);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw curatedError("curated_skill_path_invalid");
        await fsPromises.mkdir(path.dirname(destination), { recursive: true });
        const response = await fetchImpl(rawUrl(source, file.sourcePath), {
          headers: { "User-Agent": "CodexBridge-curated-skill-publisher" },
        });
        await fsPromises.writeFile(destination, await responseBytes(response, file.size), { flag: "wx" });
      }
      prepared.push(Object.freeze({ id: source.id, files: Object.freeze(selected.map(({ outputPath }) => outputPath)) }));
    }
    return Object.freeze(prepared);
  } catch (error) {
    await cleanupPreparedCuratedSkills(root).catch(() => {});
    throw error;
  }
}

export async function cleanupPreparedCuratedSkills(outputRoot) {
  const root = path.resolve(String(outputRoot || ""));
  if (!path.isAbsolute(String(outputRoot || "")) || root === path.parse(root).root || !fs.existsSync(root)) return;
  const files = [];
  const directories = [root];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    const stat = await fsPromises.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw curatedError("curated_skill_cleanup_root_invalid");
    for (const entry of await fsPromises.readdir(current, { withFileTypes: true })) {
      const exact = path.join(current, entry.name);
      const relative = path.relative(root, exact);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw curatedError("curated_skill_cleanup_path_invalid");
      const childStat = await fsPromises.lstat(exact);
      if (childStat.isSymbolicLink() || (!childStat.isFile() && !childStat.isDirectory())) {
        throw curatedError("curated_skill_cleanup_entry_invalid");
      }
      if (childStat.isDirectory()) {
        directories.push(exact);
        pending.push(exact);
      } else {
        files.push(exact);
      }
    }
  }
  for (const file of files) await fsPromises.unlink(file);
  directories.sort((left, right) => right.length - left.length);
  for (const directory of directories) await fsPromises.rmdir(directory);
}

export async function publishCuratedSkills({
  outputRoot, version, publishedAt, fetchImpl, config, artifactPublisher, prepared = false,
} = {}) {
  if (!prepared) await prepareCuratedSkills({ outputRoot, fetchImpl });
  try {
    const descriptions = Object.fromEntries(CURATED_SKILL_SOURCES.map(({ id, description }) => [id, description]));
    return await publishSkills({
      config,
      inputRoot: outputRoot,
      version,
      publishedAt,
      descriptions,
      replaceSkillCatalog: true,
      artifactPublisher,
    });
  } finally {
    await cleanupPreparedCuratedSkills(outputRoot);
  }
}

export async function refreshCuratedSkillDescriptions({ config = loadPublisherConfig(process.env) } = {}) {
  const current = readCurrentCatalog(config.publicRoot, { signingKeyFile: config.signingKeyFile });
  const descriptions = new Map(CURATED_SKILL_SOURCES.map(({ id, description }) => [id, description]));
  if (current.skills.length !== descriptions.size || current.skills.some(({ id }) => !descriptions.has(id))) {
    throw curatedError("curated_skill_catalog_mismatch");
  }
  return replaceSignedCatalog({
    config,
    catalog: {
      schemaVersion: 1,
      components: [...current.components],
      skills: current.skills.map((item) => ({ ...item, description: descriptions.get(item.id) })),
    },
    events: ["descriptions_updated"],
  });
}

function readArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--work") result.outputRoot = path.resolve(values[++index]);
    else if (values[index] === "--version") result.version = values[++index];
    else if (values[index] === "--published-at") result.publishedAt = values[++index];
    else if (values[index] === "--prepared") result.prepared = true;
    else if (values[index] === "--descriptions-only") result.descriptionsOnly = true;
    else throw curatedError("curated_skill_argument_invalid");
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = readArgs(process.argv.slice(2));
  const result = options.descriptionsOnly
    ? await refreshCuratedSkillDescriptions()
    : await publishCuratedSkills(options);
  console.log(JSON.stringify({ catalogPath: result.catalogPath, packagePaths: result.packagePaths ?? [] }, null, 2));
}
