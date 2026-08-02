import zlib from "node:zlib";

export function cloneJson(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

export function tryParseJson(text, fallback = null) {
  if (typeof text !== "string" || text.trim() === "") {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function stringifyJson(value) {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value ?? "");
}

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export async function readJsonRequest(req, limitBytes = 25 * 1024 * 1024) {
  const decodedBody = await readRequestBuffer(req, limitBytes);
  const text = decodedBody.toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch (cause) {
    const error = new Error("Request body is not valid JSON");
    error.statusCode = 400;
    error.code = "invalid_json_body";
    error.cause = cause;
    throw error;
  }
}

export async function readImageEditRequest(req, limitBytes = 100 * 1024 * 1024) {
  const contentType = String(req.headers?.["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("multipart/form-data")) {
    return readJsonRequest(req, limitBytes);
  }

  const decodedBody = await readRequestBuffer(req, limitBytes);
  let form;
  try {
    const request = new Request("http://127.0.0.1/images/edits", {
      method: "POST",
      headers: { "content-type": req.headers["content-type"] },
      body: decodedBody,
    });
    form = await request.formData();
  } catch (cause) {
    const error = new Error("Request body is not valid multipart form data");
    error.statusCode = 400;
    error.code = "invalid_multipart_body";
    error.cause = cause;
    throw error;
  }

  const body = {};
  const images = [];
  for (const [rawKey, value] of form.entries()) {
    const key = rawKey === "image[]" || rawKey === "images[]" ? "image" : rawKey;
    if (isFormFile(value)) {
      const dataUrl = await formFileDataUrl(value);
      if (key === "image" || key === "images") {
        images.push({ image_url: dataUrl });
      } else if (key === "mask") {
        body.mask = { image_url: dataUrl };
      }
      continue;
    }
    if (key === "image" || key === "images") {
      images.push(...normalizeTextImageReferences(value));
      continue;
    }
    body[key] = normalizeMultipartScalar(key, value);
  }
  if (images.length) {
    body.images = images;
  }
  return body;
}

async function readRequestBuffer(req, limitBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      const error = new Error(`Request body exceeds ${limitBytes} bytes`);
      error.statusCode = 413;
      error.code = "request_body_too_large";
      error.limitBytes = limitBytes;
      error.actualBytes = size;
      throw error;
    }
    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks);
  const decodedBody = decodeRequestBody(rawBody, req.headers?.["content-encoding"]);
  if (decodedBody.length > limitBytes) {
    const error = new Error(`Request body exceeds ${limitBytes} bytes`);
    error.statusCode = 413;
    error.code = "request_body_too_large";
    error.limitBytes = limitBytes;
    error.actualBytes = decodedBody.length;
    throw error;
  }

  return decodedBody;
}

function isFormFile(value) {
  return value && typeof value === "object" && typeof value.arrayBuffer === "function";
}

async function formFileDataUrl(file) {
  const mimeType = String(file.type || "application/octet-stream");
  const bytes = Buffer.from(await file.arrayBuffer());
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function normalizeTextImageReferences(value) {
  const text = String(value || "").trim();
  if (!text) {
    return [];
  }
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // Preserve a non-JSON URL/data URL below so validation can report it consistently.
    }
  }
  return [{ image_url: text }];
}

function normalizeMultipartScalar(key, value) {
  const text = String(value ?? "");
  if (["n", "output_compression", "partial_images"].includes(key) && /^\d+$/.test(text)) {
    return Number(text);
  }
  if (key === "stream" && ["true", "false"].includes(text.toLowerCase())) {
    return text.toLowerCase() === "true";
  }
  return text;
}

function decodeRequestBody(body, contentEncoding = "") {
  const encodings = String(contentEncoding || "")
    .split(",")
    .map((encoding) => encoding.trim().toLowerCase())
    .filter(Boolean);

  let decoded = body;
  for (const encoding of encodings.reverse()) {
    if (encoding === "identity") {
      continue;
    }
    if (encoding === "gzip" || encoding === "x-gzip") {
      decoded = zlib.gunzipSync(decoded);
      continue;
    }
    if (encoding === "deflate") {
      decoded = zlib.inflateSync(decoded);
      continue;
    }
    if (encoding === "br") {
      decoded = zlib.brotliDecompressSync(decoded);
      continue;
    }
    if (encoding === "zstd") {
      if (typeof zlib.zstdDecompressSync !== "function") {
        const error = new Error("当前 Node 运行环境不能解码 zstd 请求体。");
        error.statusCode = 415;
        throw error;
      }
      decoded = zlib.zstdDecompressSync(decoded);
      continue;
    }
    const error = new Error(`不支持的请求 Content-Encoding：${contentEncoding}`);
    error.statusCode = 415;
    throw error;
  }
  return decoded;
}

export function jsonResponse(res, statusCode, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

export function openAiError(message, statusCode = 500, code = "router_error") {
  return {
    error: {
      message,
      type: statusCode >= 500 ? "server_error" : "invalid_request_error",
      param: null,
      code,
    },
  };
}
