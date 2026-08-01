import {
  CONTEXT_POLICY_ID,
  CONTEXT_POLICY_VERSION,
  contextPolicyForRoute as defaultContextPolicyForRoute,
} from "./context-policy.js";
import { normalizeAdapterProfile } from "./adapter-profile.js";
import { stableStringify } from "./stable-json.js";

export const ROUTE_SNAPSHOT_VERSION = 1;

const CONTEXT_POLICY_KEYS = [
  "version",
  "policyId",
  "upstreamContextWindow",
  "contextWindow",
  "inputBudget",
  "compactThreshold",
  "outputReserveTokens",
  "effectiveContextWindowPercent",
  "autoCompactPercent",
];

const COMPACT_CONTRACT_KEYS = [
  "version",
  "contractId",
  "mode",
  "strategy",
  "requiresStream",
  "retryWithStream",
  "fallback",
];
const ROUTE_SNAPSHOT_KEYS = [
  "version",
  "id",
  "provider",
  "api",
  "model",
  "baseUrl",
  "authMode",
  "apiKeyEnv",
  "contextPolicy",
  "credentialSource",
  "requiresCustomHeaders",
  "dropParams",
  "compactContract",
];

export function createRouteSnapshot(
  route = {},
  options = {},
) {
  const contextPolicy = Object.hasOwn(options, "contextPolicy")
    ? options.contextPolicy
    : route.contextPolicy || defaultContextPolicyForRoute(route);
  const compactContract = Object.hasOwn(options, "compactContract")
    ? options.compactContract
    : defaultCompactContractForRoute(route);
  return {
    version: ROUTE_SNAPSHOT_VERSION,
    id: text(route.id),
    provider: text(
      route.provider ||
        route.providerId ||
        route.providerFamily ||
        normalizeAdapterProfile(route).providerFamily,
    ),
    api: text(route.api),
    model: text(route.model),
    baseUrl: sanitizeBaseUrl(route.baseUrl),
    authMode: text(route.authMode || "api_key"),
    apiKeyEnv: text(route.apiKeyEnv || route.keyEnv),
    contextPolicy: copyContextPolicy(contextPolicy),
    credentialSource: credentialSourceForRoute(route),
    requiresCustomHeaders: hasCustomHeaders(route),
    dropParams: normalizedStringList(route.dropParams),
    compactContract: copyAllowedObject(compactContract, COMPACT_CONTRACT_KEYS),
  };
}

export function validateRouteSnapshot(snapshot) {
  if (!plainObject(snapshot)) {
    return invalid("route_snapshot_invalid");
  }
  const unexpectedSnapshotKeys = unexpectedKeys(snapshot, ROUTE_SNAPSHOT_KEYS);
  if (unexpectedSnapshotKeys.length > 0) {
    return invalid(
      unexpectedSnapshotKeys.some(isSensitiveSnapshotKey)
        ? "route_snapshot_secret_material"
        : "route_snapshot_invalid",
    );
  }
  if (snapshot.version !== ROUTE_SNAPSHOT_VERSION) {
    return invalid("route_snapshot_unknown_version");
  }
  if (baseUrlHasInlineCredentials(snapshot.baseUrl)) {
    return invalid("route_snapshot_inline_credentials");
  }
  if (
    !["id", "provider", "api", "model", "baseUrl", "authMode"].every(
      (field) => typeof snapshot[field] === "string" && snapshot[field].trim(),
    ) ||
    !["responses", "chat_completions"].includes(snapshot.api) ||
    !["api_key", "codex_openai"].includes(snapshot.authMode) ||
    !validBaseUrl(snapshot.baseUrl) ||
    !Array.isArray(snapshot.dropParams) ||
    !sameValue(snapshot.dropParams, normalizedStringList(snapshot.dropParams))
  ) {
    return invalid("route_snapshot_invalid");
  }
  const unexpectedPolicyKeys = unexpectedKeys(
    snapshot.contextPolicy,
    [...CONTEXT_POLICY_KEYS, "truncationPolicy"],
  );
  const unexpectedTruncationKeys = unexpectedKeys(
    snapshot.contextPolicy?.truncationPolicy,
    ["mode", "limit"],
  );
  const unexpectedCompactKeys = unexpectedKeys(
    snapshot.compactContract,
    COMPACT_CONTRACT_KEYS,
  );
  if (
    [...unexpectedPolicyKeys, ...unexpectedTruncationKeys, ...unexpectedCompactKeys]
      .some(isSensitiveSnapshotKey)
  ) {
    return invalid("route_snapshot_secret_material");
  }
  if (
    !plainObject(snapshot.contextPolicy) ||
    snapshot.contextPolicy.version !== CONTEXT_POLICY_VERSION ||
    snapshot.contextPolicy.policyId !== CONTEXT_POLICY_ID
  ) {
    return invalid("route_snapshot_unknown_context_policy");
  }
  if (
    unexpectedPolicyKeys.length > 0 ||
    unexpectedTruncationKeys.length > 0 ||
    !validContextPolicy(snapshot.contextPolicy)
  ) {
    return invalid("route_snapshot_invalid_context_policy");
  }
  if (
    ["inline", "url"].includes(snapshot.credentialSource) ||
    baseUrlHasInlineCredentials(snapshot.baseUrl)
  ) {
    return invalid("route_snapshot_inline_credentials");
  }
  if (snapshot.credentialSource === "unavailable") {
    return invalid("route_snapshot_credentials_unavailable");
  }
  if (!validCredentialContract(snapshot)) {
    return invalid("route_snapshot_credentials_unavailable");
  }
  if (snapshot.requiresCustomHeaders !== false) {
    return invalid("route_snapshot_custom_headers_unsupported");
  }
  if (
    unexpectedCompactKeys.length > 0 ||
    !validCompactContract(snapshot.compactContract)
  ) {
    return invalid("route_snapshot_invalid_compact_contract");
  }
  return {
    ok: true,
    snapshot,
  };
}

export function resolveRouteSnapshot(
  snapshot,
  routes = [],
  {
    contextPolicyForRoute = defaultContextPolicyForRoute,
    compactContractForRoute = defaultCompactContractForRoute,
  } = {},
) {
  const validation = validateRouteSnapshot(snapshot);
  if (!validation.ok) {
    return validation;
  }
  const matches = (Array.isArray(routes) ? routes : []).filter(
    (item) => item?.enabled !== false && text(item?.id) === snapshot.id,
  );
  if (matches.length === 0) {
    return invalid("route_snapshot_route_missing");
  }
  if (matches.length !== 1) {
    return invalid("route_snapshot_route_ambiguous");
  }
  const [route] = matches;
  let currentContextPolicy;
  let currentCompactContract;
  try {
    currentContextPolicy = contextPolicyForRoute(route);
  } catch {
    return invalid("route_snapshot_context_policy_unavailable");
  }
  try {
    currentCompactContract = compactContractForRoute(route);
  } catch {
    return invalid("route_snapshot_compact_contract_unavailable");
  }
  const currentSnapshot = createRouteSnapshot(route, {
    contextPolicy: currentContextPolicy,
    compactContract: currentCompactContract,
  });
  const currentValidation = validateRouteSnapshot(currentSnapshot);
  if (!currentValidation.ok) {
    return currentValidation;
  }
  for (const [field, code] of [
    ["id", "route_snapshot_id_changed"],
    ["provider", "route_snapshot_provider_changed"],
    ["api", "route_snapshot_api_changed"],
    ["model", "route_snapshot_model_changed"],
    ["baseUrl", "route_snapshot_base_url_changed"],
    ["authMode", "route_snapshot_auth_mode_changed"],
    ["apiKeyEnv", "route_snapshot_api_key_env_changed"],
    ["credentialSource", "route_snapshot_credential_source_changed"],
    ["contextPolicy", "route_snapshot_context_policy_changed"],
    ["dropParams", "route_snapshot_drop_params_changed"],
    ["compactContract", "route_snapshot_compact_contract_changed"],
  ]) {
    if (!sameValue(snapshot[field], currentSnapshot[field])) {
      return invalid(code);
    }
  }
  return {
    ok: true,
    route,
    snapshot,
  };
}

function defaultCompactContractForRoute(route) {
  return route?.compactContract ||
    route?.capabilities?.compact ||
    normalizeAdapterProfile(route || {}).capabilities?.compact ||
    {};
}

function sameValue(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function invalid(code) {
  return { ok: false, code };
}

function validContextPolicy(policy) {
  const positiveIntegerFields = [
    "upstreamContextWindow",
    "contextWindow",
    "inputBudget",
    "compactThreshold",
  ];
  if (!positiveIntegerFields.every((field) => positiveSafeInteger(policy[field]))) {
    return false;
  }
  if (!nonNegativeSafeInteger(policy.outputReserveTokens)) {
    return false;
  }
  if (
    !validPercent(policy.effectiveContextWindowPercent) ||
    !validPercent(policy.autoCompactPercent) ||
    policy.contextWindow > policy.upstreamContextWindow ||
    policy.inputBudget > policy.contextWindow ||
    policy.compactThreshold > policy.inputBudget ||
    policy.outputReserveTokens !== policy.contextWindow - policy.inputBudget
  ) {
    return false;
  }
  const expectedInputBudget = boundedPercentTokens(
    policy.contextWindow,
    policy.effectiveContextWindowPercent,
  );
  if (
    !plainObject(policy.truncationPolicy) ||
    policy.truncationPolicy.mode !== "tokens" ||
    !positiveSafeInteger(policy.truncationPolicy.limit) ||
    policy.truncationPolicy.limit > expectedInputBudget ||
    policy.inputBudget !== policy.truncationPolicy.limit
  ) {
    return false;
  }
  const expectedCompactThreshold = Math.min(
    policy.inputBudget,
    boundedPercentTokens(policy.contextWindow, policy.autoCompactPercent),
  );
  return policy.compactThreshold === expectedCompactThreshold;
}

function validCompactContract(contract) {
  if (!plainObject(contract)) {
    return false;
  }
  if (!safeIdentifier(contract.mode) || !safeIdentifier(contract.strategy)) {
    return false;
  }
  if (
    typeof contract.requiresStream !== "boolean" ||
    typeof contract.retryWithStream !== "boolean"
  ) {
    return false;
  }
  if (Object.hasOwn(contract, "fallback") && !safeIdentifier(contract.fallback)) {
    return false;
  }
  if (Object.hasOwn(contract, "version") && !positiveSafeInteger(contract.version)) {
    return false;
  }
  return !Object.hasOwn(contract, "contractId") || safeIdentifier(contract.contractId);
}

function validCredentialContract(snapshot) {
  if (snapshot.credentialSource === "environment") {
    return snapshot.authMode === "api_key" &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(snapshot.apiKeyEnv);
  }
  if (snapshot.credentialSource === "codex_client_auth") {
    return snapshot.authMode === "codex_openai" && snapshot.apiKeyEnv === "";
  }
  return false;
}

function validBaseUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.hash &&
      ![...url.searchParams.keys()].some(isSensitiveName);
  } catch {
    return false;
  }
}

function unexpectedKeys(value, allowedKeys) {
  if (!plainObject(value)) {
    return [];
  }
  const allowed = new Set(allowedKeys);
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function isSensitiveSnapshotKey(value) {
  const normalized = text(value).toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized.includes("header") || isSensitiveName(value);
}

function safeIdentifier(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(value);
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validPercent(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100;
}

function boundedPercentTokens(contextWindow, percent) {
  return Math.min(
    contextWindow,
    Math.max(1, Math.floor(contextWindow * (percent / 100))),
  );
}

function copyContextPolicy(value) {
  const result = copyAllowedObject(value, CONTEXT_POLICY_KEYS);
  if (plainObject(value?.truncationPolicy)) {
    result.truncationPolicy = {
      mode: text(value.truncationPolicy.mode),
      limit: value.truncationPolicy.limit,
    };
  }
  return result;
}

function copyAllowedObject(value, keys) {
  const source = plainObject(value) ? value : {};
  const result = {};
  for (const key of keys) {
    if (Object.hasOwn(source, key)) {
      result[key] = source[key];
    }
  }
  return result;
}

function credentialSourceForRoute(route) {
  if (route.apiKey) {
    return "inline";
  }
  if (baseUrlHasInlineCredentials(route.baseUrl)) {
    return "url";
  }
  if (text(route.authMode) === "codex_openai") {
    return "codex_client_auth";
  }
  if (text(route.apiKeyEnv || route.keyEnv)) {
    return "environment";
  }
  return "unavailable";
}

function sanitizeBaseUrl(value) {
  const raw = text(value);
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveName(key)) {
        url.searchParams.delete(key);
      }
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return raw.replace(/\/\/[^/@\s]+@/, "//").split(/[?#]/, 1)[0];
  }
}

function baseUrlHasInlineCredentials(value) {
  try {
    const url = new URL(text(value));
    return Boolean(
      url.username ||
        url.password ||
        [...url.searchParams.keys()].some(isSensitiveName),
    );
  } catch {
    const raw = text(value);
    return /\/\/[^/@\s]+@/.test(raw) || /[?&][^=]*(?:key|token|secret|auth|password|credential)[^=]*=/i.test(raw);
  }
}

function isSensitiveName(value) {
  const normalized = text(value).toLowerCase().replace(/[^a-z0-9]/g, "");
  return [
    "auth",
    "authorization",
    "code",
    "credential",
    "jwt",
    "key",
    "password",
    "secret",
    "sig",
    "signature",
    "token",
  ].includes(normalized) ||
    /apikey|accesstoken|bearertoken|clientsecret|authorization|credential|password|secret|signature|token/.test(
      normalized,
    );
}

function hasCustomHeaders(route) {
  return [route.headers, route.customHeaders, route.extraHeaders].some(
    (value) => plainObject(value) && Object.keys(value).length > 0,
  );
}

function normalizedStringList(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(text).filter(Boolean))].sort();
}

function text(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
