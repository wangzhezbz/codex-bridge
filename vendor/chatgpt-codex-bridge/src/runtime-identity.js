import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { versionPayload } from "./service-metadata.js";
import { ROUTER_LOCK_PROTOCOL } from "./router-lock-guard.js";
import { JSON_STATE_PROTOCOL } from "./json-state-store.js";

/** Read-only identity: a path fingerprint is diagnostic evidence, not authorization. */
export function runtimeIdentity({ storeRoot, currentCodexThreadId = null } = {}, expected = {}) {
  const configuredDataRoot = path.resolve(storeRoot);
  let dataRoot = configuredDataRoot, dataRootStatus = "resolved", dataRootId = null;
  try {
    dataRoot = realpathSync.native(configuredDataRoot);
    if (!statSync(dataRoot).isDirectory()) throw Object.assign(new Error("Not a directory"), { code: "ENOTDIR" });
    const key = process.platform === "win32" ? dataRoot.toLowerCase() : dataRoot;
    dataRootId = createHash("sha256").update(`bridge-data-root-v1\0${key}`).digest("hex");
  } catch (error) {
    dataRootStatus = ["ENOENT", "ENOTDIR"].includes(error.code) ? "missing" : "unavailable";
  }
  const identity = {
    ...versionPayload(), identityVersion: 1, routerLockProtocol: ROUTER_LOCK_PROTOCOL, stateStorageProtocol: JSON_STATE_PROTOCOL, configuredDataRoot, dataRoot, dataRootStatus, dataRootId,
    sourceRoot: fileURLToPath(new URL("../", import.meta.url)), pid: process.pid,
    currentCodexThreadId: currentCodexThreadId || null
  };
  const fields = [
    ["dataRootId", expected.expectedDataRootId],
    ["protocolVersion", expected.expectedProtocolVersion],
    ["extensionProtocolVersion", expected.expectedExtensionProtocolVersion]
  ].filter(([,value]) => value !== undefined && value !== null);
  const mismatches = fields.filter(([field, value]) => identity[field] !== value).map(([field]) => field);
  return {
    ...identity,
    comparison: {
      state: !dataRootId ? "unknown" : !fields.length ? "not_requested" : mismatches.length ? "mismatched" : "matched",
      mismatches,
      meaning: "Compares runtime configuration only; does not prove project binding or GPT connectivity."
    }
  };
}
