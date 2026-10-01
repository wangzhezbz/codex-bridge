import fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";

import networkDeadline from "../../shared/network-deadline.cjs";

const { runWithNetworkDeadline } = networkDeadline;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const PROGRESS_INTERVAL_MS = 250;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 90_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 90 * 60_000;
const DOWNLOAD_MANAGER_AUTHORITIES = new WeakMap();
const NON_RETRYABLE_SOURCE_FAILURES = new WeakSet();

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
  retryPolicy = {},
  timeoutPolicy = {},
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }

  const maxAttempts = positiveInteger(retryPolicy.maxAttempts ?? retryPolicy.maxRetries, 3);
  const delayMs = retryPolicy.delayMs ?? 100;
  const requestTimeoutMs = positiveInteger(timeoutPolicy.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const inactivityTimeoutMs = positiveInteger(timeoutPolicy.inactivityTimeoutMs, DEFAULT_INACTIVITY_TIMEOUT_MS);
  const totalTimeoutMs = positiveInteger(timeoutPolicy.totalTimeoutMs, DEFAULT_TOTAL_TIMEOUT_MS);
  const fileOps = fsApi.promises ?? fsApi;
  const streamFs = typeof fsApi.createWriteStream === "function" ? fsApi : fs;
  const receipts = new WeakMap();

  async function transfer({ asset, destination = null, partPath = null, target = null, signal, onProgress, publish }) {
    return runWithTransferDeadline(async (deadlineSignal) => {
      const originalOrigin = new URL(asset.url).origin;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          throwIfAborted(deadlineSignal);
          return await downloadOnce({
            asset,
            destination,
            partPath,
            target,
            signal: deadlineSignal,
            onProgress,
            fetchImpl,
            fileOps,
            streamFs,
            originalOrigin,
            publish,
            requestTimeoutMs,
            inactivityTimeoutMs,
          });
        } catch (error) {
          if (deadlineSignal?.aborted && !(error instanceof AggregateError)) throw abortError(deadlineSignal);
          if (attempt === maxAttempts || !isRetryableDownloadFailure(error)) throw error;
          await waitForRetry(delayMs, attempt, deadlineSignal);
        }
      }
      throw new Error("download retry budget exhausted");
    }, {
      timeoutMs: totalTimeoutMs,
      signal,
    });
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
      const targetProvided = target !== null && target !== undefined;
      const targetMode = Boolean(targetProvided && typeof target === "object"
        && ["inspect", "reset", "createWriteStream", "verify"].every((name) => typeof target[name] === "function"));
      if (pathMode === targetProvided) {
        throw new TypeError("exactly one prepared download target is required");
      }
      if (targetProvided && !targetMode) throw new TypeError("prepared download target is invalid");
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
    ? (await failFastSource(() => context.target.inspect({ signal: context.signal }))).size
    : await fileSize(context.fileOps, context.partPath);
  if (existingSize > context.asset.size) {
    throw nonRetryableError("partial package exceeds the catalog length");
  }
  if (existingSize === context.asset.size) {
    return verifyDownloaded({ ...context, receivedBytes: existingSize, resumed: existingSize > 0 });
  }

  const requestHeaders = existingSize > 0 ? { Range: `bytes=${existingSize}-` } : {};
  const response = await fetchSignedOrigin(
    context.fetchImpl,
    context.asset.url,
    requestHeaders,
    context.signal,
    context.originalOrigin,
    context.requestTimeoutMs,
  );
  let append = existingSize > 0;
  let receivedBytes = existingSize;
  let resumed = append;

  if (append && response.status === 200) {
    append = false;
    resumed = false;
    receivedBytes = 0;
    try {
      throwIfAborted(context.signal);
      if (context.target) await failFastSource(() => context.target.reset({ signal: context.signal }));
    } catch (error) {
      return failWithResponseCleanup(response, error, context);
    }
  } else if (append && response.status === 206) {
    const contentRange = response.headers.get("content-range");
    if (!new RegExp(`^bytes ${existingSize}-\\d+/(\\d+|\\*)$`, "i").test(contentRange ?? "")) {
      return failWithResponseCleanup(
        response, nonRetryableError("resumed response has an invalid Content-Range"), context,
      );
    }
  } else if (response.status !== 200 && response.status !== 206) {
    return failWithResponseCleanup(response, responseError(response), context);
  }

  if (!response.body) {
    throw retryableError("download response has no body");
  }

  const startedAt = Date.now();
  let lastProgressAt = 0;
  let progressReported = false;
  const progress = new Transform({
    transform(chunk, encoding, callback) {
      receivedBytes += chunk.length;
      if (receivedBytes > context.asset.size) {
        callback(nonRetryableError("download response exceeds the catalog length"));
        return;
      }
      refreshInactivityDeadline();
      const timestamp = Date.now();
      const completed = receivedBytes === context.asset.size;
      if (progressReported && !completed && timestamp - lastProgressAt < PROGRESS_INTERVAL_MS) {
        callback(null, chunk);
        return;
      }
      progressReported = true;
      lastProgressAt = timestamp;
      const elapsedSeconds = Math.max((timestamp - startedAt) / 1_000, 0.001);
      onProgressSafely(context.onProgress, {
        phase: "download",
        receivedBytes,
        totalBytes: context.asset.size,
        percent: context.asset.size === 0 ? 100 : Math.min(100, (receivedBytes / context.asset.size) * 100),
        bytesPerSecond: (receivedBytes - existingSize) / elapsedSeconds
      }, callback, chunk);
    }
  });
  let inactivityTimer = null;
  const refreshInactivityDeadline = () => {
    if (inactivityTimer !== null) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      progress.destroy(timeoutError("download_stalled", context.inactivityTimeoutMs, true));
    }, context.inactivityTimeoutMs);
  };
  let output;
  try {
    output = context.target
      ? await failFastSource(() => context.target.createWriteStream({
        append, maxBytes: context.asset.size, signal: context.signal,
      }))
      : failFastSourceSync(() => context.streamFs.createWriteStream(
        context.partPath, { flags: append ? "a" : "w" },
      ));
  } catch (error) {
    return failWithResponseCleanup(response, error, context);
  }

  const input = createDownloadInput(response.body, context);
  const upstreamErrors = new WeakSet();
  input.on("error", (error) => {
    if (error && (typeof error === "object" || typeof error === "function")) upstreamErrors.add(error);
  });
  output.on("error", (error) => {
    if (!upstreamErrors.has(error)) markFailFastSource(error);
  });
  try {
    refreshInactivityDeadline();
    await pipeline(input, progress, output, { signal: context.signal });
  } catch (error) {
    let destroyError = null;
    try { output.destroy(); } catch (nextError) { destroyError = nextError; markFailFastSource(nextError); }
    const primary = destroyError
      ? new AggregateError([error, destroyError], error.message, { cause: error })
      : error;
    if (context.signal?.aborted === true) {
      throw abortError(context.signal);
    }
    return failWithResponseCleanup(response, primary, context);
  } finally {
    if (inactivityTimer !== null) clearTimeout(inactivityTimer);
  }

  throwIfAborted(context.signal);
  return verifyDownloaded({ ...context, receivedBytes, resumed });
}

function onProgressSafely(onProgress, event, callback, chunk) {
  reportProgressSafely(onProgress, event);
  callback(null, chunk);
}

async function verifyDownloaded(context) {
  throwIfAborted(context.signal);
  if (context.receivedBytes !== context.asset.size) {
    throw nonRetryableError(`download length mismatch: expected ${context.asset.size}, received ${context.receivedBytes}`);
  }
  throwIfAborted(context.signal);
  reportProgressSafely(context.onProgress, {
    phase: "verify-download",
    receivedBytes: context.receivedBytes,
    totalBytes: context.asset.size,
    percent: 100,
  });
  let sha256;
  if (context.target) {
    const verified = await failFastSource(() => context.target.verify({
      size: context.asset.size, sha256: context.asset.sha256.toLowerCase(), signal: context.signal,
    }));
    if (!verified || verified.size !== context.asset.size
      || verified.sha256 !== context.asset.sha256.toLowerCase()) {
      throw nonRetryableError("prepared download verification is invalid");
    }
    sha256 = verified.sha256;
  } else {
    sha256 = await failFastSource(() => hashFile(
      context.streamFs,
      context.partPath,
      context.signal,
    ));
  }
  throwIfAborted(context.signal);
  if (sha256 !== context.asset.sha256.toLowerCase()) {
    throw nonRetryableError("download SHA256 mismatch");
  }
  throwIfAborted(context.signal);
  if (context.publish) {
    await failFastSource(() => context.fileOps.rename(context.partPath, context.destination));
  }
  return {
    ...(context.publish ? { path: context.destination } : {}),
    size: context.receivedBytes,
    sha256,
    resumed: context.resumed
  };
}

async function fetchSignedOrigin(fetchImpl, signedUrl, headers, signal, originalOrigin, requestTimeoutMs) {
  let nextUrl = signedUrl;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetchWithDeadline(fetchImpl, nextUrl, headers, signal, requestTimeoutMs);
    if (!REDIRECT_STATUS.has(response.status)) {
      return response;
    }
    let redirectUrl;
    try {
      const location = response.headers.get("location");
      if (!location) throw nonRetryableError("download redirect is missing Location");
      redirectUrl = new URL(location, nextUrl);
      if (redirectUrl.origin !== originalOrigin) {
        throw nonRetryableError("download redirect crosses the signed asset origin");
      }
    } catch (error) {
      return failWithResponseCleanup(response, error, { signal, requestTimeoutMs });
    }
    await cancelResponseBody(response, { signal, requestTimeoutMs });
    throwIfAborted(signal);
    nextUrl = redirectUrl.href;
  }
  throw nonRetryableError("download exceeded redirect limit");
}

async function fetchWithDeadline(fetchImpl, url, headers, signal, requestTimeoutMs) {
  return runWithDownloadNetworkDeadline(async (requestSignal) => {
    const requestController = new AbortController();
    const linkedSignals = [signal, requestSignal].filter(Boolean);
    const onAbort = (source) => {
      if (!requestController.signal.aborted) requestController.abort(abortError(source));
    };
    const listeners = [];
    for (const source of linkedSignals) {
      if (source.aborted) onAbort(source);
      else {
        const listener = () => onAbort(source);
        source.addEventListener("abort", listener, { once: true });
        listeners.push([source, listener]);
      }
    }
    try {
      const response = await fetchImpl(url, {
        method: "GET", headers, redirect: "manual", signal: requestController.signal,
      });
      if (requestController.signal.aborted) {
        return failWithResponseCleanup(response, abortError(requestController.signal), {
          signal: requestController.signal, requestTimeoutMs,
        });
      }
      return response;
    } finally {
      for (const [source, listener] of listeners) source.removeEventListener("abort", listener);
    }
  }, {
    signal,
    timeoutMs: requestTimeoutMs,
    createTimeoutError: ({ timeoutMs }) => timeoutError("download_request_timeout", timeoutMs, true),
  });
}

async function runWithDownloadNetworkDeadline(operation, options) {
  let operationFailure;
  try {
    return await runWithNetworkDeadline(async (signal) => {
      try { return await operation(signal); }
      catch (error) { operationFailure = error; throw error; }
    }, options);
  } catch (error) {
    if (options.signal?.aborted) {
      // Preserve cleanup failures already queued by a synchronous abort, without
      // waiting for an uncooperative network operation or cancel() promise.
      if (operationFailure === undefined) await new Promise((resolve) => setImmediate(resolve));
      if (operationFailure !== undefined) throw operationFailure;
    }
    throw error;
  }
}

function createDownloadInput(body, context) {
  const reader = body.getReader();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  // Native fromWeb() waits for reader.cancel() in its destroy callback. Bound
  // only that network cleanup; pipeline still owns and awaits the file writer.
  return Readable.fromWeb(new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try { await cancelDownloadBody(() => reader.cancel(reason), context); }
      finally { release(); }
    },
  }, { highWaterMark: 0 }));
}

async function runWithTransferDeadline(operation, { timeoutMs, signal } = {}) {
  const controller = new AbortController();
  const abortFrom = (source) => {
    if (!controller.signal.aborted) controller.abort(abortError(source));
  };
  const parentAbort = () => abortFrom(signal);
  if (signal?.aborted) parentAbort();
  else signal?.addEventListener("abort", parentAbort, { once: true });
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(timeoutError("download_timeout", timeoutMs, false));
    }
  }, timeoutMs);
  try {
    const result = await operation(controller.signal);
    throwIfAborted(controller.signal);
    return result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", parentAbort);
  }
}

async function fileSize(fileOps, path) {
  try {
    return (await fileOps.stat(path)).size;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return 0;
    }
    markFailFastSource(error);
    throw error;
  }
}

async function hashFile(streamFs, path, signal) {
  const hash = createHash("sha256");
  const stream = streamFs.createReadStream(path);
  const onAbort = () => {
    try { stream.destroy(abortError(signal)); } catch {}
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const chunk of stream) {
      throwIfAborted(signal);
      hash.update(chunk);
    }
    throwIfAborted(signal);
    return hash.digest("hex");
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
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

function timeoutError(code, timeoutMs, retryable) {
  const error = new Error(code);
  error.code = code;
  error.timeoutMs = timeoutMs;
  error.retryable = retryable;
  return error;
}

function isRetryableDownloadFailure(error) {
  if (error?.retryable === true) return true;
  if (error?.retryable === false || error instanceof AggregateError) return false;
  const transientCodes = new Set([
    "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENETRESET", "ENETUNREACH",
    "EHOSTUNREACH", "EPIPE", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
  ]);
  const seen = new Set();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (NON_RETRYABLE_SOURCE_FAILURES.has(current)) return false;
    if (transientCodes.has(current.code)) return true;
    current = current.cause;
  }
  return false;
}

function markFailFastSource(error) {
  if (error && (typeof error === "object" || typeof error === "function")) {
    NON_RETRYABLE_SOURCE_FAILURES.add(error);
  }
}

async function failFastSource(action) {
  try { return await action(); }
  catch (error) { markFailFastSource(error); throw error; }
}

function failFastSourceSync(action) {
  try { return action(); }
  catch (error) { markFailFastSource(error); throw error; }
}

async function failWithResponseCleanup(response, primaryError, context) {
  let cleanupError = null;
  try { await cancelResponseBody(response, context); } catch (error) { cleanupError = error; }
  if (cleanupError === primaryError) throw primaryError;
  if (context?.signal?.aborted && cleanupError === abortError(context.signal)) throw primaryError;
  if (primaryError?.name === "AbortError" && cleanupError?.name === "AbortError") throw primaryError;
  if (cleanupError) {
    throw new AggregateError([primaryError, cleanupError], primaryError.message, { cause: primaryError });
  }
  throw primaryError;
}

async function cancelResponseBody(response, context) {
  try {
    await cancelDownloadBody(() => response?.body?.cancel?.(), context);
  } catch (error) {
    if (response?.body?.locked === true
      && (error?.code === "ERR_INVALID_STATE" || /ReadableStream is locked/iu.test(error?.message ?? ""))) {
      return;
    }
    throw error;
  }
}

async function cancelDownloadBody(operation, { signal, requestTimeoutMs } = {}) {
  return runWithDownloadNetworkDeadline(operation, {
    // Attempt to release the body even after cancellation. The signal still
    // bounds waiting for a cancel() implementation that does not settle.
    allowAbortedStart: true,
    signal,
    timeoutMs: requestTimeoutMs,
    createTimeoutError: ({ timeoutMs }) => timeoutError("download_cleanup_timeout", timeoutMs, false),
  });
}

async function waitForRetry(delayMs, attempt, signal) {
  const delay = typeof delayMs === "function" ? delayMs(attempt) : delayMs;
  if (!Number.isFinite(delay) || delay <= 0) {
    throwIfAborted(signal);
    return;
  }
  await new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => finish(reject, abortError(signal));
    timer = setTimeout(() => finish(resolve), delay);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function reportProgressSafely(onProgress, event) {
  try {
    const pending = onProgress(event);
    Promise.resolve(pending).catch(() => {});
  } catch {
    // Progress reporting is advisory and cannot invalidate package bytes.
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

function abortError(signal) {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  return new DOMException("The download was aborted", "AbortError");
}
