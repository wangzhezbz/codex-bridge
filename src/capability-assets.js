import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const INLINE_DISPLAY_ASSET_BYTE_LIMIT = 512 * 1024;
const DEFAULT_CAPABILITY_ASSET_MAX_BYTES = 64 * 1024 * 1024;

export async function saveCapabilityAssetResult(input = {}) {
  const capability = normalizeText(input.capability);
  const source = capabilityAssetSource(capability, input.upstream);
  if (!source) {
    return null;
  }
  const outputDir = normalizeText(
    input.outputDir ||
      input.provider?.outputDir ||
      input.config?.capabilityOutputDir ||
      process.env.CODEXBRIDGE_CAPABILITY_OUTPUT_DIR,
  );
  if (!outputDir) {
    return null;
  }
  const fetchImpl = typeof input.fetchImpl === "function" ? input.fetchImpl : globalThis.fetch;
  const payload = await readCapabilityAssetPayload(source, fetchImpl, {
    maxBytes: capabilityProviderAssetMaxBytes(input.provider),
  });
  if (!payload?.bytes?.length) {
    return null;
  }
  const localPath = await writeCapabilityAsset(payload.bytes, {
    outputDir,
    capability,
    mimeType: payload.mimeType,
    sourceUrl: source.url,
  });
  if (!localPath) {
    return null;
  }
  return {
    capability,
    providerId: input.provider?.id || "",
    providerName: input.provider?.displayName || input.provider?.name || input.provider?.id || "",
    localPath,
    mimeType: payload.mimeType || defaultCapabilityMimeType(capability),
    sourceUrl: source.url || "",
    bytes: payload.bytes.length,
    ...(shouldInlineCapabilityAsset(payload.bytes, payload.mimeType || defaultCapabilityMimeType(capability))
      ? { base64: payload.bytes.toString("base64") }
      : {}),
  };
}

export function capabilityAssetSource(capability = "", upstream = {}) {
  if (!upstream || typeof upstream !== "object" || Array.isArray(upstream)) {
    return null;
  }
  const base64 = firstStringValue(upstream, capabilityAssetBase64Keys(capability));
  if (base64) {
    return { base64 };
  }
  const url = firstStringValue(upstream, capabilityAssetUrlKeys(capability));
  return url ? { url } : null;
}

function capabilityAssetUrlKeys(capability = "") {
  if (capability === "speech") {
    return ["audioUrl", "audio_url", "speechUrl", "speech_url", "url"];
  }
  if (capability === "video") {
    return ["videoUrl", "video_url", "url"];
  }
  if (capability === "webpage_screenshot" || capability === "image_generation") {
    return ["imageUrl", "image_url", "screenshotUrl", "screenshot_url", "url"];
  }
  return ["imageUrl", "image_url", "assetUrl", "asset_url"];
}

function capabilityAssetBase64Keys(capability = "") {
  if (capability === "speech") {
    return ["audioBase64", "audio_base64", "base64", "b64_json"];
  }
  if (capability === "video") {
    return ["videoBase64", "video_base64", "base64", "b64_json"];
  }
  return ["imageBase64", "image_base64", "screenshotBase64", "screenshot_base64", "base64", "b64_json"];
}

function firstStringValue(value, keys = []) {
  const wanted = new Set(keys);
  const stack = [value];
  while (stack.length) {
    const current = stack.shift();
    if (!current || typeof current !== "object") {
      continue;
    }
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    for (const [key, item] of Object.entries(current)) {
      if (wanted.has(key) && typeof item === "string" && item.trim()) {
        return item.trim();
      }
      if (item && typeof item === "object") {
        stack.push(item);
      }
    }
  }
  return "";
}

async function readCapabilityAssetPayload(source = {}, fetchImpl, options = {}) {
  const maxBytes = positiveByteLimit(options.maxBytes, DEFAULT_CAPABILITY_ASSET_MAX_BYTES);
  if (source.base64) {
    const parsed = parseCapabilityBase64(source.base64);
    const bytes = Buffer.from(parsed.base64, "base64");
    assertCapabilityAssetWithinLimit(bytes.length, maxBytes);
    return {
      bytes,
      mimeType: parsed.mimeType || "",
    };
  }
  const url = normalizeText(source.url);
  if (!url) {
    return null;
  }
  if (url.startsWith("data:")) {
    const parsed = parseCapabilityDataUrl(url);
    const bytes = Buffer.from(parsed.base64, "base64");
    assertCapabilityAssetWithinLimit(bytes.length, maxBytes);
    return {
      bytes,
      mimeType: parsed.mimeType || "",
    };
  }
  if (typeof fetchImpl !== "function") {
    return null;
  }
  let parsedUrl = null;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return null;
  }
  const response = await fetchImpl(url);
  if (!response?.ok) {
    const error = new Error(`能力结果下载失败：HTTP ${response?.status || 0}。`);
    error.code = "asset_download_failed";
    error.statusCode = Number(response?.status || 0);
    throw error;
  }
  const contentLength = Number.parseInt(responseHeader(response, "content-length"), 10);
  assertCapabilityAssetWithinLimit(contentLength, maxBytes);
  const bytes = Buffer.from(await response.arrayBuffer());
  assertCapabilityAssetWithinLimit(bytes.length, maxBytes);
  return {
    bytes,
    mimeType: responseHeader(response, "content-type").split(";")[0].trim(),
  };
}

function capabilityProviderAssetMaxBytes(provider = {}) {
  return positiveByteLimit(
    provider.maxAssetBytes ||
      provider.max_asset_bytes ||
      provider.assetMaxBytes ||
      provider.asset_max_bytes,
    DEFAULT_CAPABILITY_ASSET_MAX_BYTES,
  );
}

function assertCapabilityAssetWithinLimit(bytes, maxBytes) {
  if (Number.isFinite(bytes) && bytes > maxBytes) {
    const error = new Error(`Capability result asset is too large: ${bytes} bytes; limit ${maxBytes} bytes.`);
    error.code = "asset_too_large";
    throw error;
  }
}

function positiveByteLimit(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function parseCapabilityBase64(value = "") {
  const text = normalizeText(value);
  return text.startsWith("data:") ? parseCapabilityDataUrl(text) : { base64: text, mimeType: "" };
}

function parseCapabilityDataUrl(value = "") {
  const match = String(value || "").match(/^data:([^;,]+)?;base64,(.+)$/s);
  if (!match) {
    const error = new Error("Capability provider returned an invalid data URL.");
    error.code = "invalid_asset_data";
    throw error;
  }
  return {
    mimeType: match[1] || "",
    base64: match[2] || "",
  };
}

function responseHeader(response, name) {
  const headers = response?.headers;
  if (!headers) {
    return "";
  }
  if (typeof headers.get === "function") {
    return String(headers.get(name) || "");
  }
  return String(headers[name] || headers[String(name).toLowerCase()] || "");
}

async function writeCapabilityAsset(bytes, { outputDir = "", capability = "", mimeType = "", sourceUrl = "" } = {}) {
  const targetDir = normalizeText(outputDir);
  if (!targetDir || !Buffer.isBuffer(bytes) || !bytes.length) {
    return "";
  }
  const ext = capabilityAssetExtension(mimeType, sourceUrl, capability);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const prefix = normalizeText(capability || "capability")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .toLowerCase();
  const target = path.resolve(targetDir, `codexbridge-${prefix}-${Date.now()}-${hash}${ext}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
  return target;
}

function capabilityAssetExtension(mimeType = "", sourceUrl = "", capability = "") {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.includes("jpeg") || mime.includes("jpg")) {
    return ".jpg";
  }
  if (mime.includes("png")) {
    return ".png";
  }
  if (mime.includes("webp")) {
    return ".webp";
  }
  if (mime.includes("gif")) {
    return ".gif";
  }
  if (mime.includes("mpeg") || mime.includes("mp3")) {
    return ".mp3";
  }
  if (mime.includes("wav")) {
    return ".wav";
  }
  if (mime.includes("ogg")) {
    return ".ogg";
  }
  if (mime.includes("mp4")) {
    return ".mp4";
  }
  if (mime.includes("webm")) {
    return ".webm";
  }
  const fromUrl = String(sourceUrl || "").split("?")[0].match(/\.(png|jpe?g|webp|gif|mp3|wav|ogg|m4a|mp4|webm|mov)$/i)?.[0];
  if (fromUrl) {
    return fromUrl.toLowerCase().replace(".jpeg", ".jpg");
  }
  if (capability === "speech") {
    return ".mp3";
  }
  if (capability === "video") {
    return ".mp4";
  }
  return ".png";
}

function defaultCapabilityMimeType(capability = "") {
  if (capability === "speech") {
    return "audio/mpeg";
  }
  if (capability === "video") {
    return "video/mp4";
  }
  return "image/png";
}

function shouldInlineCapabilityAsset(bytes, mimeType = "") {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > INLINE_DISPLAY_ASSET_BYTE_LIMIT) {
    return false;
  }
  return String(mimeType || "").toLowerCase().startsWith("image/");
}

function normalizeText(value) {
  return String(value || "").trim();
}
