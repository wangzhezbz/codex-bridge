"use strict";

async function readBoundedResponseBytes(response, options = {}) {
  const maxBytes = positiveByteLimit(options.maxBytes);
  const declaredBytes = responseContentLength(response);
  if (declaredBytes !== null && declaredBytes > maxBytes) {
    const error = responseBodyTooLargeError(options, maxBytes, declaredBytes);
    bestEffortCancel(response?.body, error);
    throw error;
  }

  const body = response?.body;
  if (body && typeof body.getReader === "function") {
    return readWebResponseBody(body, maxBytes, options);
  }
  if (body && typeof body[Symbol.asyncIterator] === "function") {
    return readAsyncResponseBody(body, maxBytes, options);
  }
  if (typeof response?.arrayBuffer === "function") {
    const bytes = Buffer.from(await readWithSignal(() => response.arrayBuffer(), options.signal));
    assertWithinLimit(bytes.length, maxBytes, options);
    return bytes;
  }
  if (typeof response?.text === "function") {
    const bytes = Buffer.from(String(await readWithSignal(() => response.text(), options.signal)), "utf8");
    assertWithinLimit(bytes.length, maxBytes, options);
    return bytes;
  }
  return Buffer.alloc(0);
}

async function readBoundedResponseText(response, options = {}) {
  return (await readBoundedResponseBytes(response, options)).toString("utf8");
}

function cancelResponseBody(response, reason) {
  bestEffortCancel(response?.body, reason);
}

async function readWebResponseBody(body, maxBytes, options) {
  const reader = body.getReader();
  const chunks = [];
  let totalBytes = 0;
  let completed = false;
  let cancellationRequested = false;
  try {
    while (true) {
      throwIfAborted(options.signal);
      const result = await readWithSignal(() => reader.read(), options.signal);
      throwIfAborted(options.signal);
      if (result.done) {
        completed = true;
        break;
      }
      const chunk = bufferFromChunk(result.value);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        const error = responseBodyTooLargeError(options, maxBytes, totalBytes);
        cancellationRequested = true;
        bestEffortCancel(reader, error);
        throw error;
      }
      chunks.push(chunk);
    }
  } finally {
    if (!completed && !cancellationRequested) {
      bestEffortCancel(reader, options.signal?.reason);
    }
    try {
      reader.releaseLock?.();
    } catch {
      // The bounded read has already reached its authoritative outcome.
    }
  }
  return Buffer.concat(chunks, totalBytes);
}

async function readAsyncResponseBody(body, maxBytes, options) {
  const iterator = body[Symbol.asyncIterator]();
  const chunks = [];
  let totalBytes = 0;
  let completed = false;
  let cancellationRequested = false;
  try {
    while (true) {
      throwIfAborted(options.signal);
      const result = await readWithSignal(() => iterator.next(), options.signal);
      throwIfAborted(options.signal);
      if (result.done) {
        completed = true;
        break;
      }
      const chunk = bufferFromChunk(result.value);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        const error = responseBodyTooLargeError(options, maxBytes, totalBytes);
        cancellationRequested = true;
        bestEffortDestroy(body, error);
        bestEffortReturn(iterator);
        throw error;
      }
      chunks.push(chunk);
    }
  } finally {
    if (!completed && !cancellationRequested) {
      bestEffortDestroy(body, options.signal?.reason);
      bestEffortReturn(iterator);
    }
  }
  return Buffer.concat(chunks, totalBytes);
}

function assertWithinLimit(actualBytes, maxBytes, options) {
  if (actualBytes > maxBytes) {
    throw responseBodyTooLargeError(options, maxBytes, actualBytes);
  }
}

function responseBodyTooLargeError(options, maxBytes, actualBytes) {
  if (typeof options.createTooLargeError === "function") {
    const error = options.createTooLargeError({ maxBytes, actualBytes });
    if (error instanceof Error) {
      return error;
    }
  }
  const error = new Error(`Response body is too large: ${actualBytes} bytes; limit ${maxBytes} bytes.`);
  error.code = "response_body_too_large";
  error.maxBytes = maxBytes;
  error.actualBytes = actualBytes;
  return error;
}

function positiveByteLimit(value) {
  const number = Number(value);
  const integer = Math.floor(number);
  if (!Number.isFinite(number) || integer <= 0) {
    throw new TypeError("maxBytes must be a positive finite byte limit");
  }
  return Math.min(integer, Number.MAX_SAFE_INTEGER);
}

function responseContentLength(response) {
  const headers = response?.headers;
  let value = "";
  if (typeof headers?.get === "function") {
    value = headers.get("content-length");
  } else if (headers && typeof headers === "object") {
    value = headers["content-length"] ?? headers["Content-Length"] ?? "";
  }
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function bufferFromChunk(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  return Buffer.from(value ?? "");
}

function throwIfAborted(signal) {
  if (!signal?.aborted) {
    return;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  const error = new Error("Response body read was aborted.");
  error.name = "AbortError";
  throw error;
}

async function readWithSignal(operation, signal) {
  throwIfAborted(signal);
  if (!signal) return operation();
  let abortListener = null;
  const aborted = new Promise((_resolve, reject) => {
    abortListener = () => {
      try { throwIfAborted(signal); }
      catch (error) { reject(error); }
    };
    if (signal.aborted) abortListener();
    else signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        // Recheck at dispatch: cancellation can happen after the initial check
        // but before this queued read runs. Cleanup is handled by the caller.
        throwIfAborted(signal);
        return operation();
      }),
      aborted,
    ]);
  } finally {
    signal.removeEventListener("abort", abortListener);
  }
}

function bestEffortCancel(target, reason) {
  try {
    const result = target?.cancel?.(reason);
    result?.catch?.(() => {});
  } catch {
    // The size or abort error remains authoritative.
  }
}

function bestEffortDestroy(target) {
  try {
    // Do not pass the primary error into a generic Node stream: a stream with
    // no error listener could turn cleanup into an uncaught exception.
    target?.destroy?.();
  } catch {
    // The size or abort error remains authoritative.
  }
}

function bestEffortReturn(iterator) {
  try {
    const result = iterator?.return?.();
    result?.catch?.(() => {});
  } catch {
    // The size or abort error remains authoritative.
  }
}

module.exports = {
  cancelResponseBody,
  readBoundedResponseBytes,
  readBoundedResponseText,
};
