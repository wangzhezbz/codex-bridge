import { UpstreamResponseTooLargeError } from "./upstream-response-guard.js";

const DEFAULT_MAX_SSE_EVENT_BYTES = 48 * 1024 * 1024;

export function createSseBlockAccumulator(options = {}) {
  const configuredMaxBytes = Number(options.maxBytes);
  return {
    parts: [],
    byteLength: 0,
    separatorTail: [],
    maxBytes: Number.isFinite(configuredMaxBytes) && configuredMaxBytes >= 0
      ? Math.floor(configuredMaxBytes)
      : DEFAULT_MAX_SSE_EVENT_BYTES,
  };
}

export function takeCompleteSseBlocks(state, chunk) {
  const blocks = [];
  let segmentStart = 0;
  for (let index = 0; index < chunk.length; index += 1) {
    state.separatorTail.push(chunk[index]);
    if (state.separatorTail.length > 4) {
      state.separatorTail.shift();
    }
    assertSseEventBufferSize(state, state.byteLength + index - segmentStart + 1);
    if (!sseSeparatorEndsTail(state.separatorTail)) {
      continue;
    }
    addSseAccumulatorPart(state, chunk.subarray(segmentStart, index + 1));
    blocks.push(Buffer.concat(state.parts, state.byteLength).toString("utf8"));
    state.parts = [];
    state.byteLength = 0;
    state.separatorTail = [];
    segmentStart = index + 1;
  }
  addSseAccumulatorPart(state, chunk.subarray(segmentStart));
  return blocks;
}

export function finishSseBlockAccumulator(state) {
  if (state.byteLength === 0) {
    return "";
  }
  const value = Buffer.concat(state.parts, state.byteLength).toString("utf8");
  state.parts = [];
  state.byteLength = 0;
  state.separatorTail = [];
  return value;
}

function addSseAccumulatorPart(state, part) {
  if (!part?.length) {
    return;
  }
  assertSseEventBufferSize(state, state.byteLength + part.length);
  state.parts.push(part);
  state.byteLength += part.length;
}

function assertSseEventBufferSize(state, byteLength) {
  if (byteLength > state.maxBytes) {
    throw new UpstreamResponseTooLargeError(
      state.maxBytes,
      byteLength,
      "",
    );
  }
}

function sseSeparatorEndsTail(tail) {
  const length = tail.length;
  if (
    length >= 4 &&
    tail[length - 4] === 13 &&
    tail[length - 3] === 10 &&
    tail[length - 2] === 13 &&
    tail[length - 1] === 10
  ) {
    return true;
  }
  return length >= 2 && (
    (tail[length - 2] === 10 && tail[length - 1] === 10) ||
    (tail[length - 2] === 13 && tail[length - 1] === 13)
  );
}
