import fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const DOWNLOAD_MANAGER_AUTHORITIES = new WeakMap();

function downloadError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function consumePreparedDownloadVerification(manager, receipt, expected) {
  const authority = DOWNLOAD_MANAGER_AUTHORITIES.get(manager);
  if (!authority) throw downloadError("verification_manager_invalid");
  const verified = authority.receipts.get(receipt);
  if (!verified) throw downloadError("verification_receipt_invalid");
  if (verified.state !== "issued") throw downloadError("verification_receipt_consumed");
  verified.state = "consumed";
  const bindingKey = verified.target ? "target" : "partPath";
  if (!expected || typeof expected !== "object" || Array.isArray(expected)
    || Object.keys(expected).length !== 3
    || !Object.hasOwn(expected, bindingKey) || !Object.hasOwn(expected, "size")
    || !Object.hasOwn(expected, "sha256")
    || expected[bindingKey] !== verified[bindingKey] || expected.size !== verified.size
    || expected.sha256 !== verified.sha256) {
    throw downloadError("verification_binding_mismatch");
  }
  return Object.freeze({
    [bindingKey]: verified[bindingKey],
    size: verified.size,
    sha256: verified.sha256,
  });
}

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
  const receipts = new WeakMap();

  async function transfer({ asset, destination = null, partPath = null, target = null, signal, onProgress, publish }) {
    const originalOrigin = new URL(asset.url).origin;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        throwIfAborted(signal);
        return await downloadOnce({
          asset,
          destination,
          partPath,
          target,
          signal,
          onProgress,
          fetchImpl,
          fileOps,
          streamFs,
          originalOrigin,
          publish,
        });
      } catch (error) {
        if (signal?.aborted) throw abortError(signal);
        if (error?.retryable === false || attempt === maxAttempts) throw error;
        await waitForRetry(delayMs, attempt, signal);
      }
    }
    throw new Error("download retry budget exhausted");
  }

  const manager = Object.freeze(Object.assign(Object.create(null), {
    async download({ asset, destination, signal, onProgress = () => {} } = {}) {
      validateAsset(asset);
      if (typeof destination !== "string" || destination.length === 0) {
        throw new TypeError("destination must be a non-empty path");
      }
      if (typeof onProgress !== "function") {
        throw new TypeError("onProgress must be a function");
      }

      const partPath = `${destination}.part`;
      return transfer({ asset, destination, partPath, signal, onProgress, publish: true });
    },

    async downloadPrepared({ asset, partPath = null, target = null, signal, onProgress = () => {} } = {}) {
      validateAsset(asset);
      const pathMode = typeof partPath === "string" && partPath.length > 0;
      const targetMode = target && typeof target === "object"
        && ["inspect", "reset", "createWriteStream", "verify"].every((name) => typeof target[name] === "function");
      if (pathMode === targetMode) {
        throw new TypeError("exactly one prepared download target is required");
      }
      if (typeof onProgress !== "function") throw new TypeError("onProgress must be a function");
      const verified = await transfer({
        asset, partPath, target, signal, onProgress, publish: false,
      });
      const receipt = Object.freeze(Object.create(null));
      receipts.set(receipt, {
        state: "issued",
        ...(targetMode ? { target } : { partPath }),
        size: verified.size,
        sha256: verified.sha256,
      });
      return receipt;
    },
  }));
  DOWNLOAD_MANAGER_AUTHORITIES.set(manager, { receipts });
  return manager;
}

async function downloadOnce(context) {
  const existingSize = context.target
    ? (await context.target.inspect()).size
    : await fileSize(context.fileOps, context.partPath);
  if (existingSize > context.asset.size) {
    throw nonRetryableError("partial package exceeds the catalog length");
  }
  if (existingSize === context.asset.size) {
    return verifyDownloaded({ ...context, receivedBytes: existingSize, resumed: existingSize > 0 });
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
    if (context.target) await context.target.reset();
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
  const output = context.target
    ? await context.target.createWriteStream({ append, maxBytes: context.asset.size, signal: context.signal })
    : context.streamFs.createWriteStream(context.partPath, { flags: append ? "a" : "w" });

  try {
    await pipeline(Readable.fromWeb(response.body), progress, output, { signal: context.signal });
  } catch (error) {
    output.destroy();
    throw error;
  }

  throwIfAborted(context.signal);
  return verifyDownloaded({ ...context, receivedBytes, resumed });
}

function onProgressSafely(onProgress, event, callback, chunk) {
  try {
    onProgress(event);
    callback(null, chunk);
  } catch (error) {
    callback(error);
  }
}

async function verifyDownloaded(context) {
  throwIfAborted(context.signal);
  if (context.receivedBytes !== context.asset.size) {
    throw nonRetryableError(`download length mismatch: expected ${context.asset.size}, received ${context.receivedBytes}`);
  }
  throwIfAborted(context.signal);
  let sha256;
  if (context.target) {
    const verified = await context.target.verify({
      size: context.asset.size, sha256: context.asset.sha256.toLowerCase(), signal: context.signal,
    });
    if (!verified || verified.size !== context.asset.size
      || verified.sha256 !== context.asset.sha256.toLowerCase()) {
      throw nonRetryableError("prepared download verification is invalid");
    }
    sha256 = verified.sha256;
  } else {
    sha256 = await hashFile(context.streamFs, context.partPath);
  }
  throwIfAborted(context.signal);
  if (sha256 !== context.asset.sha256.toLowerCase()) {
    throw nonRetryableError("download SHA256 mismatch");
  }
  throwIfAborted(context.signal);
  if (context.publish) await context.fileOps.rename(context.partPath, context.destination);
  return {
    ...(context.publish ? { path: context.destination } : {}),
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
