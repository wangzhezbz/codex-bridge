import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const ARTIFACTS_DIR = "artifacts";
const METADATA_FILE = "metadata.json";
const CONTENT_TYPE_EXTENSIONS = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/jpg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/svg+xml", "svg"],
  ["application/pdf", "pdf"],
  ["application/zip", "zip"],
  ["application/x-zip-compressed", "zip"],
  ["text/plain", "txt"],
  ["text/markdown", "md"],
  ["text/csv", "csv"],
  ["application/json", "json"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"]
]);
const GENERIC_FILE_BASENAMES = new Set(["artifact", "blob", "content", "download", "file", "image"]);

function nowIso() {
  return new Date().toISOString();
}

function compactTimestamp(iso) {
  return iso.replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/, "");
}

function artifactIdFromDate(date = new Date()) {
  return `artifact_${compactTimestamp(date.toISOString())}_${randomBytes(3).toString("hex")}`;
}

function artifactsDir(storeRoot) {
  return path.join(storeRoot, ARTIFACTS_DIR);
}

function artifactDir(storeRoot, artifactId) {
  return path.join(artifactsDir(storeRoot), artifactId);
}

function artifactMetadataPath(storeRoot, artifactId) {
  return path.join(artifactDir(storeRoot, artifactId), METADATA_FILE);
}

async function ensureArtifactsDir(storeRoot) {
  await mkdir(artifactsDir(storeRoot), { recursive: true });
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sanitizeFilename(value = "") {
  const withoutPath = value.split(/[\\/]/).filter(Boolean).at(-1) || "artifact";
  const sanitized = withoutPath.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return sanitized || "artifact";
}

function extensionFromContentType(contentType = "") {
  const normalized = contentType.toLowerCase().split(";")[0].trim();
  if (CONTENT_TYPE_EXTENSIONS.has(normalized)) {
    return CONTENT_TYPE_EXTENSIONS.get(normalized);
  }

  if (normalized.startsWith("image/")) {
    const subtype = normalized.slice("image/".length).replace(/[^a-z0-9]+/g, "");
    return subtype || null;
  }

  if (normalized.startsWith("text/")) {
    return "txt";
  }

  return null;
}

function artifactFilenamePrefix(contentType = "") {
  return contentType.toLowerCase().startsWith("image/") ? "chatgpt-image" : "chatgpt-file";
}

function shortArtifactId(id = "") {
  return id.split("_").at(-1)?.slice(0, 6) || randomBytes(3).toString("hex");
}

function isOpaqueExtensionlessName(filename) {
  const parsed = path.parse(filename);
  if (parsed.ext) return false;
  const basename = parsed.name.toLowerCase();
  if (GENERIC_FILE_BASENAMES.has(basename)) return true;
  return parsed.name.length > 80;
}

function normalizeArtifactFilename(value, contentType, artifactId) {
  const filename = sanitizeFilename(value);
  const parsed = path.parse(filename);
  const inferredExtension = extensionFromContentType(contentType);

  if (isOpaqueExtensionlessName(filename) && inferredExtension) {
    return `${artifactFilenamePrefix(contentType)}-${shortArtifactId(artifactId)}.${inferredExtension}`;
  }

  if (!parsed.ext && inferredExtension) {
    return `${filename}.${inferredExtension}`;
  }

  return filename;
}

function normalizeStoredArtifact(artifact) {
  if (!artifact || typeof artifact !== "object") {
    return artifact;
  }

  const filename = normalizeArtifactFilename(artifact.filename, artifact.contentType, artifact.id);
  if (filename === artifact.filename) {
    return artifact;
  }

  return {
    ...artifact,
    filename
  };
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function uniqueDestinationPath(directory, filename) {
  const parsed = path.parse(filename);
  for (let index = 0; index < 10_000; index += 1) {
    const candidateName =
      index === 0 ? filename : `${parsed.name || "artifact"}-${index}${parsed.ext || ""}`;
    const candidatePath = path.join(directory, candidateName);
    if (!(await pathExists(candidatePath))) {
      return {
        filename: candidateName,
        filePath: candidatePath
      };
    }
  }

  throw new Error("Could not find a free artifact filename in the target project");
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function sha256Buffer(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function saveArtifactFromBase64(storeRoot, input) {
  await ensureArtifactsDir(storeRoot);
  if (!input.base64Data) {
    throw new Error("Artifact base64Data is required");
  }

  const createdAt = nowIso();
  const id = artifactIdFromDate(new Date(createdAt));
  const filename = normalizeArtifactFilename(input.filename, input.contentType, id);
  const directory = artifactDir(storeRoot, id);
  await mkdir(directory, { recursive: true });

  const bytes = Buffer.from(input.base64Data, "base64");
  const filePath = path.join(directory, filename);
  await writeFile(filePath, bytes);

  const artifact = {
    id,
    syncJobId: input.syncJobId || null,
    conversationId: input.conversationId || null,
    sourceMessageId: input.sourceMessageId || null,
    filename,
    contentType: input.contentType || "application/octet-stream",
    sizeBytes: bytes.length,
    originalUrl: input.originalUrl || null,
    filePath,
    contentHashSha256: sha256Buffer(bytes),
    createdAt
  };

  await writeJson(artifactMetadataPath(storeRoot, id), artifact);
  return artifact;
}

export async function saveArtifactFromLocalFile(storeRoot, input) {
  await ensureArtifactsDir(storeRoot);
  if (!input.localPath) {
    throw new Error("Artifact localPath is required");
  }

  const localPath = path.resolve(input.localPath);
  const stats = await stat(localPath);
  if (!stats.isFile()) {
    throw new Error("Artifact localPath must be a file");
  }

  const createdAt = nowIso();
  const id = artifactIdFromDate(new Date(createdAt));
  const filename = normalizeArtifactFilename(input.filename || path.basename(localPath), input.contentType, id);
  const directory = artifactDir(storeRoot, id);
  await mkdir(directory, { recursive: true });

  const filePath = path.join(directory, filename);
  await copyFile(localPath, filePath);

  const artifact = {
    id,
    syncJobId: input.syncJobId || null,
    conversationId: input.conversationId || null,
    sourceMessageId: input.sourceMessageId || null,
    filename,
    contentType: input.contentType || "application/octet-stream",
    sizeBytes: stats.size,
    originalUrl: input.originalUrl || null,
    filePath,
    localSourcePath: localPath,
    contentHashSha256: await sha256File(filePath),
    createdAt
  };

  await writeJson(artifactMetadataPath(storeRoot, id), artifact);
  return artifact;
}

export async function getArtifact(storeRoot, artifactId) {
  return normalizeStoredArtifact(await readJson(artifactMetadataPath(storeRoot, artifactId)));
}

export async function listArtifacts(storeRoot, options = {}) {
  await ensureArtifactsDir(storeRoot);
  const entries = await readdir(artifactsDir(storeRoot), { withFileTypes: true });
  const artifacts = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      const artifact = await getArtifact(storeRoot, entry.name);
      if (options.syncJobId && artifact.syncJobId !== options.syncJobId) {
        continue;
      }
      if (options.conversationId && artifact.conversationId !== options.conversationId) {
        continue;
      }
      artifacts.push(artifact);
    } catch {
      // Ignore incomplete artifact directories.
    }
  }

  return artifacts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function readArtifactText(storeRoot, artifactId, options = {}) {
  const artifact = await getArtifact(storeRoot, artifactId);
  const maxChars = options.maxChars || 200_000;
  const text = await readFile(artifact.filePath, "utf8");
  return {
    artifact,
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars
  };
}

export async function saveArtifactToProject(storeRoot, artifactId, targetRepo) {
  const artifact = await getArtifact(storeRoot, artifactId);
  const projectRoot = path.resolve(targetRepo || "");
  if (!targetRepo || projectRoot === path.parse(projectRoot).root) {
    throw new Error("A target project directory is required");
  }

  const destinationDir = path.join(projectRoot, "chatgpt-artifacts");
  await mkdir(destinationDir, { recursive: true });

  const preferredFilename = sanitizeFilename(artifact.filename);
  const preferredPath = path.join(destinationDir, preferredFilename);
  try {
    const preferredStats = await stat(preferredPath);
    if (
      preferredStats.isFile() &&
      artifact.contentHashSha256 &&
      (await sha256File(preferredPath)) === artifact.contentHashSha256
    ) {
      return {
        artifact,
        projectRoot,
        filename: preferredFilename,
        savedPath: preferredPath,
        relativePath: path.relative(projectRoot, preferredPath),
        savedAt: nowIso(),
        reused: true
      };
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const destination = await uniqueDestinationPath(destinationDir, preferredFilename);
  await copyFile(artifact.filePath, destination.filePath);

  return {
    artifact,
    projectRoot,
    filename: destination.filename,
    savedPath: destination.filePath,
    relativePath: path.relative(projectRoot, destination.filePath),
    savedAt: nowIso()
  };
}
