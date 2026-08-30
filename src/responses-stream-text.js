import { UpstreamResponseTooLargeError } from "./upstream-response-guard.js";

const DEFAULT_MAX_TERMINAL_BYTES = 48 * 1024 * 1024;
const DEFAULT_MAX_DIAGNOSTIC_CHARS = 2_000_000;

export function createTextBuffer(options = {}) {
  const configuredMaxBytes = Number(options.maxBytes);
  return {
    parts: [],
    byteLength: 0,
    maxBytes: Number.isFinite(configuredMaxBytes) && configuredMaxBytes >= 0
      ? Math.floor(configuredMaxBytes)
      : DEFAULT_MAX_TERMINAL_BYTES,
  };
}

export function appendTerminalText(state, value) {
  const byteLength = Buffer.byteLength(value, "utf8");
  if (state.byteLength + byteLength > state.maxBytes) {
    throw new UpstreamResponseTooLargeError(
      state.maxBytes,
      state.byteLength + byteLength,
      "",
    );
  }
  state.parts.push(value);
  state.byteLength += byteLength;
}

export function textBufferValue(state) {
  return state.parts.join("");
}

export function appendDiagnosticTail(current, value, options = {}) {
  const configuredMaxChars = Number(options.maxChars);
  const maxChars = Number.isFinite(configuredMaxChars) && configuredMaxChars >= 0
    ? Math.floor(configuredMaxChars)
    : DEFAULT_MAX_DIAGNOSTIC_CHARS;
  const next = `${current}${value}`;
  if (maxChars === 0) {
    return "";
  }
  return next.length > maxChars ? next.slice(-maxChars) : next;
}
