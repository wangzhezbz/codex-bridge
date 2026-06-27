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

  const text = decodedBody.toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch (cause) {
    const error = new Error("Request body is not valid JSON");
    error.statusCode = 400;
    error.cause = cause;
    throw error;
  }
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
        const error = new Error("This Node runtime cannot decode zstd request bodies");
        error.statusCode = 415;
        throw error;
      }
      decoded = zlib.zstdDecompressSync(decoded);
      continue;
    }
    const error = new Error(`Unsupported request content-encoding: ${contentEncoding}`);
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
