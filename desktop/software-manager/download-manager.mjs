import fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export function createDownloadManager({
  fetchImpl = globalThis.fetch,
  fsApi = fsPromises,
  retryPolicy = {}
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }

  const maxAttempts = positiveInteger(retryPolicy.maxAttempts ?? retryPolicy.maxRetries, 3);
  const delayMs = retryPolicy.delayMs ?? 100;
  const fileOps = fsApi.promises ?? fsApi;
  const streamFs = typeof fsApi.createWriteStream === "function" ? fsApi : fs;

  return {
    async download({ asset, destination, signal, onProgress = () => {} } = {}) {
      validateAsset(asset);
      if (typeof destination !== "string" || destination.length === 0) {
        throw new TypeError("destination must be a non-empty path");
      }
      if (typeof onProgress !== "function") {
        throw new TypeError("onProgress must be a function");
      }

      const partPath = `${destination}.part`;
      const originalOrigin = new URL(asset.url).origin;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          throwIfAborted(signal);
          const result = await downloadOnce({
            asset,
            destination,
            partPath,
            signal,
            onProgress,
            fetchImpl,
            fileOps,
            streamFs,
            originalOrigin
          });
          return result;
        } catch (error) {
          if (signal?.aborted) {
            throw abortError(signal);
          }
          if (error?.retryable === false || attempt === maxAttempts) {
            throw error;
          }
          await waitForRetry(delayMs, attempt, signal);
        }
      }
      throw new Error("download retry budget exhausted");
    }
  };
}

async function downloadOnce(context) {
  const existingSize = await fileSize(context.fileOps, context.partPath);
  if (existingSize > context.asset.size) {
    throw nonRetryableError("partial package exceeds the catalog length");
  }
  if (existingSize === context.asset.size) {
    return verifyAndPromote({ ...context, receivedBytes: existingSize, resumed: existingSize > 0 });
  }

  const requestHeaders = existingSize > 0 ? { Range: `bytes=${existingSize}-` } : {};
  const response = await fetchSignedOrigin(context.fetchImpl, context.asset.url, requestHeaders, context.signal, context.originalOrigin);
  let append = existingSize > 0;
  let receivedBytes = existingSize;
  let resumed = append;

  if (append && response.status === 200) {
    append = false;
    resumed = false;
    receivedBytes = 0;
  } else if (append && response.status === 206) {
    const contentRange = response.headers.get("content-range");
    if (!new RegExp(`^bytes ${existingSize}-\\d+/(\\d+|\\*)$`, "i").test(contentRange ?? "")) {
      throw nonRetryableError("resumed response has an invalid Content-Range");
    }
  } else if (response.status !== 200 && response.status !== 206) {
    throw responseError(response);
  }

  if (!response.body) {
    throw retryableError("download response has no body");
  }

  const startedAt = Date.now();
  const progress = new Transform({
    transform(chunk, encoding, callback) {
      receivedBytes += chunk.length;
      const elapsedSeconds = Math.max((Date.now() - startedAt) / 1_000, 0.001);
      onProgressSafely(context.onProgress, {
        phase: "download",
        receivedBytes,
        totalBytes: context.asset.size,
        percent: context.asset.size === 0 ? 100 : Math.min(100, (receivedBytes / context.asset.size) * 100),
        bytesPerSecond: receivedBytes / elapsedSeconds
      }, callback, chunk);
    }
  });
  const output = context.streamFs.createWriteStream(context.partPath, { flags: append ? "a" : "w" });

  try {
    await pipeline(Readable.fromWeb(response.body), progress, output, { signal: context.signal });
  } catch (error) {
    output.destroy();
    throw error;
  }

  return verifyAndPromote({ ...context, receivedBytes, resumed });
}

function onProgressSafely(onProgress, event, callback, chunk) {
  try {
    onProgress(event);
    callback(null, chunk);
  } catch (error) {
    callback(error);
  }
}

async function verifyAndPromote(context) {
  if (context.receivedBytes !== context.asset.size) {
    throw nonRetryableError(`download length mismatch: expected ${context.asset.size}, received ${context.receivedBytes}`);
  }
  const sha256 = await hashFile(context.streamFs, context.partPath);
  if (sha256 !== context.asset.sha256.toLowerCase()) {
    throw nonRetryableError("download SHA256 mismatch");
  }
  await context.fileOps.rename(context.partPath, context.destination);
  return {
    path: context.destination,
    size: context.receivedBytes,
    sha256,
    resumed: context.resumed
  };
}

async function fetchSignedOrigin(fetchImpl, signedUrl, headers, signal, originalOrigin) {
  let nextUrl = signedUrl;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetchImpl(nextUrl, { method: "GET", headers, redirect: "manual", signal });
    if (!REDIRECT_STATUS.has(response.status)) {
      return response;
    }
    const location = response.headers.get("location");
    if (!location) {
      throw nonRetryableError("download redirect is missing Location");
    }
    const redirectUrl = new URL(location, nextUrl);
    if (redirectUrl.origin !== originalOrigin) {
      throw nonRetryableError("download redirect crosses the signed asset origin");
    }
    nextUrl = redirectUrl.href;
  }
  throw nonRetryableError("download exceeded redirect limit");
}

async function fileSize(fileOps, path) {
  try {
    return (await fileOps.stat(path)).size;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

async function hashFile(streamFs, path) {
  const hash = createHash("sha256");
  for await (const chunk of streamFs.createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function validateAsset(asset) {
  if (!asset || typeof asset.url !== "string" || !Number.isSafeInteger(asset.size) || asset.size < 0 || !/^[a-f0-9]{64}$/i.test(asset.sha256 ?? "")) {
    throw new TypeError("asset must contain url, non-negative size, and sha256");
  }
  new URL(asset.url);
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function responseError(response) {
  const error = new Error(`download request failed with HTTP ${response.status}`);
  error.retryable = response.status >= 500;
  return error;
}

function retryableError(message) {
  const error = new Error(message);
  error.retryable = true;
  return error;
}

function nonRetryableError(message) {
  const error = new Error(message);
  error.retryable = false;
  return error;
}

async function waitForRetry(delayMs, attempt, signal) {
  const delay = typeof delayMs === "function" ? delayMs(attempt) : delayMs;
  if (!Number.isFinite(delay) || delay <= 0) {
    throwIfAborted(signal);
    return;
  }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delay);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortError(signal));
    }, { once: true });
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

function abortError(signal) {
  if (signal?.reason?.name === "AbortError") {
    return signal.reason;
  }
  return new DOMException("The download was aborted", "AbortError");
}
