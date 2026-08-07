import { randomUUID } from "node:crypto";

const TOKEN_PATTERN = /^root_[a-f0-9]{32}$/u;

function resolverError(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function requirePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.includes("\0")) {
    throw resolverError("install_root_path_invalid");
  }
  return value;
}

function createToken(entries) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const token = `root_${randomUUID().replaceAll("-", "")}`;
    if (!entries.has(token)) return token;
  }
  throw resolverError("install_root_token_unavailable");
}

export function createInstallRootResolver({ authorizeRoot, getPersistedRoot } = {}) {
  if (typeof authorizeRoot !== "function" || typeof getPersistedRoot !== "function") {
    throw resolverError("install_root_resolver_dependencies_invalid");
  }

  const entries = new Map();
  let currentToken = null;

  async function issue(path) {
    const capability = await authorizeRoot(requirePath(path));
    if (!capability || typeof capability !== "object") {
      throw resolverError("install_root_authority_invalid");
    }
    const token = createToken(entries);
    entries.set(token, Object.freeze({ capability, state: "candidate" }));
    return token;
  }

  function requireEntry(token) {
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token) || !entries.has(token)) {
      throw resolverError("install_root_token_invalid");
    }
    return entries.get(token);
  }

  function getCurrentToken() {
    return currentToken;
  }

  async function choose(candidate) {
    const token = await issue(candidate);
    return Object.freeze({ token });
  }

  async function resolve(token) {
    return requireEntry(token).capability;
  }

  async function adopt(token) {
    const entry = requireEntry(token);
    const prior = currentToken;
    currentToken = token;
    entries.set(token, Object.freeze({ capability: entry.capability, state: "current" }));
    if (prior !== null && prior !== token) entries.delete(prior);
    return token;
  }

  async function discard(token) {
    requireEntry(token);
    if (token !== currentToken) entries.delete(token);
  }

  async function restoreOwnedRoot(path) {
    const persistedPath = path === undefined ? await getPersistedRoot() : path;
    if (persistedPath === null || persistedPath === undefined) return null;
    const token = await issue(persistedPath);
    const prior = currentToken;
    currentToken = token;
    const entry = entries.get(token);
    entries.set(token, Object.freeze({ capability: entry.capability, state: "current" }));
    if (prior !== null && prior !== token) entries.delete(prior);
    return token;
  }

  async function clearCurrent() {
    const prior = currentToken;
    currentToken = null;
    if (prior !== null) entries.delete(prior);
  }

  return Object.freeze({
    getCurrentToken,
    choose,
    resolve,
    adopt,
    discard,
    restoreOwnedRoot,
    clearCurrent,
  });
}
