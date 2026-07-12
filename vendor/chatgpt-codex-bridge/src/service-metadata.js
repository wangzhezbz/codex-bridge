export const SERVICE_NAME = "chatgpt-codex-bridge";
export const SERVICE_VERSION = "0.1.0";
export const SERVICE_PROTOCOL_VERSION = 1;
export const EXTENSION_PROTOCOL_VERSION = "v20260712-preference-verify";

export function healthPayload() {
  return {
    ok: true,
    service: SERVICE_NAME,
    status: "ready",
    version: SERVICE_VERSION,
    protocolVersion: SERVICE_PROTOCOL_VERSION
  };
}

export function versionPayload() {
  return {
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    protocolVersion: SERVICE_PROTOCOL_VERSION,
    extensionProtocolVersion: EXTENSION_PROTOCOL_VERSION
  };
}
