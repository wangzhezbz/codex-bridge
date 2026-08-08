import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PACKAGE_PATH = "/codexbridge-test/packages/";
const PACKAGE_ORIGIN = "https://shanhaiyouling.com";

function publisherError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function exactAbsolutePath(value, code) {
  const text = String(value || "").trim();
  if (!text || !path.isAbsolute(text) || path.normalize(text) !== text || text.includes("\0")) {
    throw publisherError(code);
  }
  return text;
}

function publicRootAllowed(value) {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  return normalized !== "/opt/shanhai/codex-installer"
    && !normalized.endsWith("/opt/shanhai/codex-installer")
    && !segments.includes("install-test")
    && value !== path.parse(value).root;
}

function packageBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw publisherError("publisher_package_base_url_rejected");
  }
  if (parsed.origin !== PACKAGE_ORIGIN || parsed.pathname !== PACKAGE_PATH || parsed.search || parsed.hash) {
    throw publisherError("publisher_package_base_url_rejected");
  }
  return parsed.href;
}

export function loadPublisherConfig(env = process.env) {
  const signingKeyFile = exactAbsolutePath(env?.CBI_SIGNING_KEY_FILE, "publisher_signing_key_required");
  const publicRoot = exactAbsolutePath(env?.CBI_PUBLIC_ROOT, "publisher_public_root_required");
  if (!publicRootAllowed(publicRoot)) throw publisherError("publisher_public_root_rejected");
  const relativeKey = path.relative(publicRoot, signingKeyFile);
  if (relativeKey === "" || (!relativeKey.startsWith(`..${path.sep}`) && relativeKey !== ".." && !path.isAbsolute(relativeKey))) {
    throw publisherError("publisher_signing_key_public");
  }
  let signingKey;
  try {
    signingKey = crypto.createPrivateKey(fs.readFileSync(signingKeyFile, "utf8"));
  } catch {
    throw publisherError("publisher_signing_key_invalid");
  }
  if (signingKey.type !== "private") throw publisherError("publisher_signing_key_invalid");
  return Object.freeze({
    signingKeyFile,
    publicRoot,
    packageBaseUrl: packageBaseUrl(env?.CBI_PACKAGE_BASE_URL),
  });
}
