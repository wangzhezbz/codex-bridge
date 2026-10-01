"use strict";

const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;

function createBoundedLineDecoder({
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  onLine = () => {},
  onError = () => {},
} = {}) {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
    throw new TypeError("maxLineBytes must be a positive safe integer");
  }
  if (typeof onLine !== "function" || typeof onError !== "function") {
    throw new TypeError("onLine and onError must be functions");
  }

  let parts = [];
  let bufferedBytes = 0;
  let stopped = false;

  function release() {
    parts = [];
    bufferedBytes = 0;
  }

  function fail(error) {
    if (stopped) return false;
    stopped = true;
    release();
    onError(error);
    return false;
  }

  function append(segment) {
    if (segment.length === 0) return true;
    if (bufferedBytes + segment.length > maxLineBytes) {
      const error = new Error(`Line exceeds the ${maxLineBytes}-byte limit.`);
      error.code = "bounded_line_too_large";
      error.limitBytes = maxLineBytes;
      return fail(error);
    }
    parts.push(segment);
    bufferedBytes += segment.length;
    return true;
  }

  function emitLine() {
    let line = bufferedBytes === 0
      ? Buffer.alloc(0)
      : parts.length === 1
        ? parts[0]
        : Buffer.concat(parts, bufferedBytes);
    release();
    if (line.length > 0 && line[line.length - 1] === 0x0d) {
      line = line.subarray(0, line.length - 1);
    }
    try {
      onLine(line.toString("utf8"));
      return !stopped;
    } catch (error) {
      return fail(error);
    }
  }

  function push(chunk) {
    if (stopped) return false;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < buffer.length) {
      const newline = buffer.indexOf(0x0a, offset);
      const end = newline === -1 ? buffer.length : newline;
      if (!append(buffer.subarray(offset, end))) return false;
      if (newline === -1) return true;
      if (!emitLine()) return false;
      offset = newline + 1;
    }
    return true;
  }

  function end() {
    if (stopped) return false;
    if (bufferedBytes === 0) {
      stopped = true;
      return true;
    }
    const emitted = emitLine();
    stopped = true;
    release();
    return emitted;
  }

  function close() {
    if (stopped) return;
    stopped = true;
    release();
  }

  return {
    push,
    end,
    close,
    get bufferedBytes() {
      return bufferedBytes;
    },
  };
}

module.exports = {
  DEFAULT_MAX_LINE_BYTES,
  createBoundedLineDecoder,
};
