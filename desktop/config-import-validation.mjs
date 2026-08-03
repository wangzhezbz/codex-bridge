const CONFIG_PACKAGE_SCHEMA = "codexbridge.config-package";
const CONFIG_PACKAGE_VERSION = 1;
const VALID_MODES = new Set(["hybrid", "all_api"]);
const VALID_MODEL_APIS = new Set(["responses", "chat_completions", "anthropic_messages"]);
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_ISSUES = 100;
const MAX_ARRAY_ITEMS = 2_000;
const MAX_MAP_ITEMS = 2_000;
const MAX_JSON_DEPTH = 24;
const MAX_TEXT_LENGTH = 1_000_000;
const MAX_EMBEDDED_LOGO_BYTES = 256 * 1024;

const SECTION_ORDER = [
  "selection",
  "desktopOptions",
  "customModels",
  "providerOverrides",
  "capabilityProviders",
  "imageProviders",
  "modelImageGeneration",
  "modelCapabilities",
  "profiles",
  "codexResources",
];

const TOP_LEVEL_KEYS = new Set([
  "schema",
  "version",
  "exportedAt",
  "includesSecrets",
  "mode",
  ...SECTION_ORDER,
  "embeddedLogoCount",
  "secretKeys",
  "requiredSecretKeys",
  "backupReason",
  "backupCreatedAt",
]);

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const CREDENTIAL_FIELD_EXACT_NAMES = new Set([
  "apikey",
  "xapikey",
  "accesskey",
  "secret",
  "clientsecret",
  "appsecret",
  "token",
  "authtoken",
  "bearer",
  "bearertoken",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authorization",
  "proxyauthorization",
  "cookie",
  "authcookie",
  "session",
  "sessioncookie",
  "setcookie",
  "password",
  "passwd",
  "credential",
  "credentials",
  "privatekey",
  "signedurl",
]);
const CREDENTIAL_FIELD_SUFFIXES = Object.freeze([
  "apikey",
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "credentials",
  "authorization",
  "privatekey",
  "signedurl",
]);
const ALLOWED_CREDENTIAL_ENV_REFERENCE_FIELDS = new Set([
  "apikeyenv",
  "keyenv",
]);
const LOCAL_PATH_KEYS = new Set([
  "path",
  "paths",
  "filepath",
  "filepaths",
  "inputpath",
  "inputpaths",
  "outputpath",
  "outputpaths",
  "outputdir",
  "outputdirectory",
  "file",
  "files",
  "directory",
  "directories",
  "dir",
  "dirs",
  "folder",
  "folders",
  "workspace",
  "workspacepath",
  "downloadpath",
  "screenshotpath",
  "historypath",
]);
const CREDENTIAL_QUERY_EXACT_NAMES = new Set([
  "key",
  "auth",
  "bearer",
  "signature",
  "sig",
  "xamzcredential",
  "xamzsignature",
  "xgoogcredential",
  "xgoogsignature",
]);

export function isCredentialFieldName(value, { allowEnvironmentReference = true } = {}) {
  const normalized = normalizedFieldName(value);
  if (!normalized) return false;
  if (allowEnvironmentReference && ALLOWED_CREDENTIAL_ENV_REFERENCE_FIELDS.has(normalized)) {
    return false;
  }
  const candidates = normalized.endsWith("env")
    ? [normalized, normalized.slice(0, -3)]
    : [normalized];
  return candidates.some((candidate) =>
    CREDENTIAL_FIELD_EXACT_NAMES.has(candidate) ||
    CREDENTIAL_FIELD_SUFFIXES.some((suffix) => candidate.endsWith(suffix)));
}

export function isCredentialUrlQueryKey(value) {
  const normalized = normalizedFieldName(value);
  return CREDENTIAL_QUERY_EXACT_NAMES.has(normalized) ||
    normalized.endsWith("signature") ||
    isCredentialFieldName(normalized, { allowEnvironmentReference: false });
}

export function isApprovedCredentialTemplate(value) {
  return /^(?:(?:Bearer|Basic)\s+)?\{\{apiKey\}\}$/i.test(String(value || "").trim());
}

const DESKTOP_OPTION_KEYS = new Set([
  "bypassSystemProxy",
  "routerPort",
  "localRateLimitEnabled",
  "duplicateRequestProtection",
  "duplicateRequestProtectionPolicyVersion",
  "interceptCodexAuxiliaryTasks",
  "codexAuxiliaryModelId",
  "autoSelectModel",
  "autoFailover",
  "smartRouting",
  "usageBudgets",
]);
const SMART_RULE_KEYS = new Set(["imageGeneration", "code", "longContext", "ordinaryChat"]);
const SMART_RULE_MODES = new Set(["auto", "route", "off"]);
const SMART_FAILOVER_MODES = new Set(["auto", "ordered", "off"]);
const BUDGET_KEYS = new Set([
  "dailyTokenLimit",
  "dailyCallLimit",
  "dailyCostLimit",
  "inputCostPerMillion",
  "cacheCostPerMillion",
  "outputCostPerMillion",
]);
const CUSTOM_MODEL_KEYS = new Set([
  "presetId",
  "providerId",
  "providerName",
  "displayName",
  "description",
  "api",
  "baseUrl",
  "model",
  "authMode",
  "apiKeyEnv",
  "keyEnv",
  "keyUrl",
  "docsUrl",
  "logoUrl",
  "contextWindow",
  "inputModalities",
  "dropParams",
  "custom",
]);
const PROVIDER_OVERRIDE_KEYS = new Set([
  "id",
  "name",
  "shortName",
  "baseUrl",
  "keyUrl",
  "docsUrl",
  "keyEnv",
  "keyLabel",
  "logoUrl",
  "api",
  "authMode",
  "custom",
  "updatedAt",
]);
const CAPABILITY_PROVIDER_KEYS = new Set([
  "id",
  "name",
  "displayName",
  "kind",
  "source",
  "capability",
  "capabilities",
  "adapter",
  "baseUrl",
  "endpoint",
  "model",
  "apiKeyEnv",
  "enabled",
  "priority",
  "maxResponseBytes",
  "maxAssetBytes",
  "defaults",
]);
const IMAGE_PROVIDER_KEYS = new Set([
  "id",
  "name",
  "adapter",
  "baseUrl",
  "endpoint",
  "model",
  "size",
  "apiKeyEnv",
  "response",
  "enabled",
  "priority",
  "maxAssetBytes",
  "defaults",
  "request",
  "headers",
]);
const IMAGE_PROVIDER_ADAPTERS = new Set([
  "openai_images",
  "siliconflow_images",
  "zai_images",
  "generic_template",
]);
const IMAGE_GENERATION_KEYS = new Set([
  "enabled",
  "mode",
  "displayName",
  "baseUrl",
  "endpoint",
  "model",
  "size",
  "apiKeyEnv",
  "providerId",
  "adapter",
  "defaults",
  "response",
  "request",
  "headers",
]);
const IMAGE_GENERATION_MODES = new Set(["off", "inherit", "provider", "custom", "official"]);
const PROFILE_KEYS = new Set([
  "id",
  "name",
  "mode",
  "selectedModelIds",
  "desktopOptions",
  "note",
  "createdAt",
  "updatedAt",
]);
const RESOURCE_MANIFEST_KEYS = new Set([
  "version",
  "portableOnly",
  "autoApply",
  "note",
  "summary",
  "readStatus",
  "mcpServers",
  "plugins",
  "skills",
  "prompts",
  "agentFiles",
]);
const RESOURCE_SUMMARY_KEYS = new Set(["mcpServers", "plugins", "skills", "prompts", "agentFiles"]);
const RESOURCE_READ_KINDS = new Set(["plugins", "mcpServers", "skills", "marketplaces"]);
const RESOURCE_READ_STATUS_KEYS = new Set(["ok", "state", "source", "code", "reason"]);
const RESOURCE_ITEM_KEYS = {
  mcpServers: new Set(["name", "description", "purpose", "source", "availability", "enabled"]),
  plugins: new Set(["id", "name", "description", "purpose", "source", "availability", "enabled", "version"]),
  skills: new Set(["name", "description", "purpose", "source", "availability", "enabled"]),
  prompts: new Set(["name", "description", "source", "availability"]),
  agentFiles: new Set(["name", "description", "source", "availability"]),
};

const validatedCandidates = new WeakMap();

export class ConfigPackageValidationError extends Error {
  constructor(issues = []) {
    const safeIssues = freezeIssues(issues);
    const first = safeIssues[0];
    super(first
      ? `配置包校验失败（${first.code}，${first.path}）。`
      : "配置包校验失败。");
    this.name = "ConfigPackageValidationError";
    this.code = "CONFIG_PACKAGE_INVALID";
    this.section = first?.section || "$";
    this.path = first?.path || "$";
    this.issues = safeIssues;
  }
}

export function validateConfigPackageImport(input = {}) {
  if (input && typeof input === "object" && validatedCandidates.has(input)) {
    return Object.freeze({
      ok: true,
      candidate: input,
      issues: Object.freeze([]),
      presentSections: validatedCandidates.get(input),
    });
  }

  const context = createValidationContext();
  const parsed = parseInput(input, context);
  if (parsed === null) {
    return invalidResult(context.issues);
  }

  const candidate = validateRootPackage(parsed, context);
  if (context.issues.length) {
    return invalidResult(context.issues);
  }

  const presentSections = Object.freeze(
    SECTION_ORDER.filter((section) => Object.hasOwn(candidate, section)),
  );
  deepFreeze(candidate);
  validatedCandidates.set(candidate, presentSections);
  return Object.freeze({
    ok: true,
    candidate,
    issues: Object.freeze([]),
    presentSections,
  });
}

export function parseConfigPackageImport(input = {}) {
  const result = validateConfigPackageImport(input);
  if (!result.ok) {
    throw new ConfigPackageValidationError(result.issues);
  }
  return result.candidate;
}

function createValidationContext() {
  return {
    issues: [],
    issueKeys: new Set(),
  };
}

function parseInput(input, context) {
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) {
      addIssue(context, "input_too_large", "$", "配置包超过允许大小。");
      return null;
    }
    try {
      return JSON.parse(input);
    } catch {
      addIssue(context, "invalid_json", "$", "配置包不是有效 JSON。");
      return null;
    }
  }
  return input;
}

function validateRootPackage(value, context) {
  if (!expectPlainObject(value, "$", context)) {
    return {};
  }
  assertAllowedKeys(value, TOP_LEVEL_KEYS, "$", context);

  const candidate = {
    schema: normalizeExactString(value.schema, CONFIG_PACKAGE_SCHEMA, "$.schema", context),
    version: normalizeExactInteger(value.version, CONFIG_PACKAGE_VERSION, "$.version", context),
    includesSecrets: normalizeIncludesSecrets(value, context),
  };

  if (Object.hasOwn(value, "exportedAt")) {
    candidate.exportedAt = normalizeTimestamp(value.exportedAt, "$.exportedAt", context);
  }
  if (Object.hasOwn(value, "backupReason")) {
    candidate.backupReason = normalizeExactString(
      value.backupReason,
      "before_config_package_import",
      "$.backupReason",
      context,
    );
  }
  if (Object.hasOwn(value, "backupCreatedAt")) {
    candidate.backupCreatedAt = normalizeTimestamp(value.backupCreatedAt, "$.backupCreatedAt", context);
  }

  let declaredMode = null;
  if (Object.hasOwn(value, "mode")) {
    declaredMode = normalizeEnum(value.mode, VALID_MODES, "$.mode", context);
  }

  if (Object.hasOwn(value, "selection")) {
    candidate.selection = validateSelection(value.selection, "$.selection", context);
  }
  const selectionMode = candidate.selection?.mode || null;
  if (declaredMode && selectionMode && declaredMode !== selectionMode) {
    addIssue(context, "conflicting_mode", "$.selection.mode", "配置包模式声明互相冲突。");
  }
  if (declaredMode || selectionMode) {
    candidate.mode = declaredMode || selectionMode;
  }

  if (Object.hasOwn(value, "desktopOptions")) {
    candidate.desktopOptions = validateDesktopOptions(value.desktopOptions, "$.desktopOptions", context);
  }
  if (Object.hasOwn(value, "customModels")) {
    candidate.customModels = validateCustomModels(value.customModels, "$.customModels", context);
  }
  if (Object.hasOwn(value, "providerOverrides")) {
    candidate.providerOverrides = validateProviderOverrides(value.providerOverrides, "$.providerOverrides", context);
  }
  if (Object.hasOwn(value, "capabilityProviders")) {
    candidate.capabilityProviders = validateCapabilityProviders(
      value.capabilityProviders,
      "$.capabilityProviders",
      context,
    );
  }
  if (Object.hasOwn(value, "imageProviders")) {
    candidate.imageProviders = validateImageProviders(value.imageProviders, "$.imageProviders", context);
  }
  if (Object.hasOwn(value, "modelImageGeneration")) {
    candidate.modelImageGeneration = validateModelImageGeneration(
      value.modelImageGeneration,
      "$.modelImageGeneration",
      context,
    );
  }
  if (Object.hasOwn(value, "modelCapabilities")) {
    candidate.modelCapabilities = validateModelCapabilities(
      value.modelCapabilities,
      "$.modelCapabilities",
      context,
    );
  }
  if (Object.hasOwn(value, "profiles")) {
    candidate.profiles = validateProfiles(value.profiles, "$.profiles", context);
  }
  if (Object.hasOwn(value, "codexResources")) {
    candidate.codexResources = validateCodexResources(value.codexResources, "$.codexResources", context);
  }

  if (Object.hasOwn(value, "embeddedLogoCount")) {
    candidate.embeddedLogoCount = normalizeNonNegativeInteger(
      value.embeddedLogoCount,
      "$.embeddedLogoCount",
      context,
    );
    const actualLogoCount = countEmbeddedLogos(candidate.customModels) + countEmbeddedLogos(candidate.providerOverrides);
    if (Number.isInteger(candidate.embeddedLogoCount) && candidate.embeddedLogoCount !== actualLogoCount) {
      addIssue(context, "count_mismatch", "$.embeddedLogoCount", "内嵌 Logo 数量与配置内容不一致。");
    }
  }
  if (Object.hasOwn(value, "secretKeys")) {
    candidate.secretKeys = validateEnvironmentNameArray(value.secretKeys, "$.secretKeys", context);
  }
  if (Object.hasOwn(value, "requiredSecretKeys")) {
    candidate.requiredSecretKeys = validateEnvironmentNameArray(
      value.requiredSecretKeys,
      "$.requiredSecretKeys",
      context,
    );
  }
  validateRequiredSecretReferences(candidate, context);
  validateCrossSectionReferences(candidate, context);

  return candidate;
}

function normalizeIncludesSecrets(value, context) {
  if (!Object.hasOwn(value, "includesSecrets")) {
    addIssue(context, "missing_required_key", "$.includesSecrets", "缺少密钥安全声明。");
    return false;
  }
  if (value.includesSecrets !== false) {
    addIssue(context, "secrets_not_allowed", "$.includesSecrets", "配置包必须明确声明不包含密钥。");
  }
  return false;
}

function validateSelection(value, path, context) {
  if (!expectPlainObject(value, path, context)) return {};
  assertAllowedKeys(value, new Set(["mode", "selectedModelIds"]), path, context);
  return {
    mode: normalizeEnum(value.mode, VALID_MODES, `${path}.mode`, context),
    selectedModelIds: validateStringArray(value.selectedModelIds, `${path}.selectedModelIds`, context, {
      required: true,
      maxItems: 500,
    }),
  };
}

function validateDesktopOptions(value, path, context) {
  if (!expectPlainObject(value, path, context)) return {};
  assertAllowedKeys(value, DESKTOP_OPTION_KEYS, path, context);
  const result = {};
  for (const key of [
    "bypassSystemProxy",
    "localRateLimitEnabled",
    "duplicateRequestProtection",
    "interceptCodexAuxiliaryTasks",
    "autoSelectModel",
    "autoFailover",
  ]) {
    if (Object.hasOwn(value, key)) {
      result[key] = normalizeBoolean(value[key], `${path}.${key}`, context);
    }
  }
  if (Object.hasOwn(value, "routerPort")) {
    result.routerPort = normalizeIntegerInRange(value.routerPort, 1024, 65535, `${path}.routerPort`, context);
  }
  if (Object.hasOwn(value, "duplicateRequestProtectionPolicyVersion")) {
    result.duplicateRequestProtectionPolicyVersion = normalizeIntegerInRange(
      value.duplicateRequestProtectionPolicyVersion,
      2,
      2,
      `${path}.duplicateRequestProtectionPolicyVersion`,
      context,
    );
  }
  if (Object.hasOwn(value, "codexAuxiliaryModelId")) {
    result.codexAuxiliaryModelId = normalizeText(value.codexAuxiliaryModelId, `${path}.codexAuxiliaryModelId`, context, {
      maxLength: 240,
      allowEmpty: true,
    });
  }
  if (Object.hasOwn(value, "smartRouting")) {
    result.smartRouting = validateSmartRouting(value.smartRouting, `${path}.smartRouting`, context);
  }
  if (Object.hasOwn(value, "usageBudgets")) {
    result.usageBudgets = validateUsageBudgets(value.usageBudgets, `${path}.usageBudgets`, context);
  }
  return result;
}

function validateSmartRouting(value, path, context) {
  if (!expectPlainObject(value, path, context)) return {};
  assertAllowedKeys(value, new Set(["autoSelectRules", "failover"]), path, context);
  const result = {};
  if (Object.hasOwn(value, "autoSelectRules")) {
    const rules = value.autoSelectRules;
    if (!expectPlainObject(rules, `${path}.autoSelectRules`, context)) {
      result.autoSelectRules = {};
    } else {
      assertAllowedKeys(rules, SMART_RULE_KEYS, `${path}.autoSelectRules`, context);
      result.autoSelectRules = {};
      for (const key of Object.keys(rules)) {
        if (!SMART_RULE_KEYS.has(key)) continue;
        const rulePath = `${path}.autoSelectRules.${key}`;
        const rule = rules[key];
        if (!expectPlainObject(rule, rulePath, context)) continue;
        assertAllowedKeys(rule, new Set(["mode", "routeId"]), rulePath, context);
        const mode = normalizeEnum(rule.mode, SMART_RULE_MODES, `${rulePath}.mode`, context);
        const routeId = normalizeText(rule.routeId, `${rulePath}.routeId`, context, {
          maxLength: 240,
          allowEmpty: true,
        });
        if (mode === "route" && !routeId) {
          addIssue(context, "missing_required_value", `${rulePath}.routeId`, "指定路由模式需要 routeId。");
        }
        result.autoSelectRules[key] = { mode, routeId };
      }
    }
  }
  if (Object.hasOwn(value, "failover")) {
    const failoverPath = `${path}.failover`;
    const failover = value.failover;
    if (expectPlainObject(failover, failoverPath, context)) {
      assertAllowedKeys(failover, new Set(["mode", "routeIds"]), failoverPath, context);
      const mode = normalizeEnum(failover.mode, SMART_FAILOVER_MODES, `${failoverPath}.mode`, context);
      const routeIds = validateStringArray(failover.routeIds, `${failoverPath}.routeIds`, context, {
        required: true,
        maxItems: 500,
      });
      if (mode === "ordered" && !routeIds.length) {
        addIssue(context, "missing_required_value", `${failoverPath}.routeIds`, "顺序故障转移需要至少一个 routeId。");
      }
      result.failover = { mode, routeIds };
    } else {
      result.failover = {};
    }
  }
  return result;
}

function validateUsageBudgets(value, path, context) {
  if (!expectPlainObject(value, path, context)) return {};
  assertAllowedKeys(value, new Set(["global", "routes", "providers"]), path, context);
  const result = {};
  if (Object.hasOwn(value, "global")) {
    result.global = validateBudgetScope(value.global, `${path}.global`, context);
  }
  for (const kind of ["routes", "providers"]) {
    if (!Object.hasOwn(value, kind)) continue;
    result[kind] = validateDynamicMap(value[kind], `${path}.${kind}`, context, (entry, entryPath) =>
      validateBudgetScope(entry, entryPath, context));
  }
  return result;
}

function validateBudgetScope(value, path, context) {
  if (!expectPlainObject(value, path, context)) return {};
  assertAllowedKeys(value, BUDGET_KEYS, path, context);
  const result = {};
  for (const key of Object.keys(value)) {
    if (!BUDGET_KEYS.has(key)) continue;
    result[key] = normalizePositiveNumber(value[key], `${path}.${key}`, context, {
      integer: key === "dailyTokenLimit" || key === "dailyCallLimit",
    });
  }
  return result;
}

function validateCustomModels(value, path, context) {
  if (!expectArray(value, path, context, 500)) return [];
  const seen = new Set();
  return value.map((model, index) => {
    const modelPath = `${path}[${index}]`;
    if (!expectPlainObject(model, modelPath, context)) return {};
    assertAllowedKeys(model, CUSTOM_MODEL_KEYS, modelPath, context);
    const result = {
      presetId: normalizeRequiredId(model.presetId, `${modelPath}.presetId`, context),
      providerId: normalizeRequiredId(model.providerId, `${modelPath}.providerId`, context),
      providerName: normalizeRequiredText(model.providerName, `${modelPath}.providerName`, context),
      displayName: normalizeRequiredText(model.displayName, `${modelPath}.displayName`, context),
      api: normalizeEnum(model.api, new Set(["responses", "chat_completions"]), `${modelPath}.api`, context),
      baseUrl: normalizeHttpUrl(model.baseUrl, `${modelPath}.baseUrl`, context),
      model: normalizeRequiredText(model.model, `${modelPath}.model`, context, 500),
      authMode: normalizeExactString(model.authMode, "api_key", `${modelPath}.authMode`, context),
      custom: normalizeExactBoolean(model.custom, true, `${modelPath}.custom`, context),
    };
    if (seen.has(result.presetId)) {
      addIssue(context, "duplicate_id", `${modelPath}.presetId`, "自定义模型 ID 重复。");
    }
    seen.add(result.presetId);
    for (const key of ["description", "keyLabel"]) {
      if (Object.hasOwn(model, key)) {
        result[key] = normalizeText(model[key], `${modelPath}.${key}`, context, { maxLength: 2_000, allowEmpty: true });
      }
    }
    for (const key of ["apiKeyEnv", "keyEnv"]) {
      if (Object.hasOwn(model, key)) {
        result[key] = normalizeEnvironmentName(model[key], `${modelPath}.${key}`, context);
      }
    }
    if (!result.apiKeyEnv && !result.keyEnv) {
      addIssue(context, "missing_required_value", `${modelPath}.apiKeyEnv`, "自定义模型需要密钥环境变量名。");
    }
    if (result.apiKeyEnv && result.keyEnv && result.apiKeyEnv !== result.keyEnv) {
      addIssue(context, "conflicting_secret_reference", `${modelPath}.keyEnv`, "密钥环境变量引用不一致。");
    }
    for (const key of ["keyUrl", "docsUrl"]) {
      if (Object.hasOwn(model, key)) {
        result[key] = normalizeOptionalHttpUrl(model[key], `${modelPath}.${key}`, context);
      }
    }
    if (Object.hasOwn(model, "logoUrl")) {
      result.logoUrl = normalizeLogoUrl(model.logoUrl, `${modelPath}.logoUrl`, context);
    }
    if (Object.hasOwn(model, "contextWindow")) {
      result.contextWindow = normalizePositiveInteger(model.contextWindow, `${modelPath}.contextWindow`, context);
    }
    if (Object.hasOwn(model, "inputModalities")) {
      result.inputModalities = validateModalities(model.inputModalities, `${modelPath}.inputModalities`, context);
    }
    if (Object.hasOwn(model, "dropParams")) {
      result.dropParams = validateStringArray(model.dropParams, `${modelPath}.dropParams`, context, {
        required: true,
        maxItems: 100,
      });
    }
    return result;
  });
}

function validateProviderOverrides(value, path, context) {
  return validateDynamicMap(value, path, context, (override, overridePath, providerId) => {
    if (!expectPlainObject(override, overridePath, context)) return {};
    assertAllowedKeys(override, PROVIDER_OVERRIDE_KEYS, overridePath, context);
    if (!Object.keys(override).length) {
      addIssue(context, "empty_section_entry", overridePath, "供应商覆盖项不能为空。");
    }
    const result = {};
    for (const key of ["id", "name", "shortName", "keyLabel"]) {
      if (Object.hasOwn(override, key)) {
        result[key] = normalizeRequiredText(override[key], `${overridePath}.${key}`, context);
      }
    }
    if (result.id && result.id !== providerId) {
      addIssue(context, "id_mismatch", `${overridePath}.id`, "供应商对象 ID 与 map key 不一致。");
    }
    if (Object.hasOwn(override, "baseUrl")) {
      result.baseUrl = normalizeHttpUrl(override.baseUrl, `${overridePath}.baseUrl`, context);
    }
    for (const key of ["keyUrl", "docsUrl"]) {
      if (Object.hasOwn(override, key)) {
        result[key] = normalizeOptionalHttpUrl(override[key], `${overridePath}.${key}`, context);
      }
    }
    if (Object.hasOwn(override, "keyEnv")) {
      result.keyEnv = normalizeEnvironmentName(override.keyEnv, `${overridePath}.keyEnv`, context);
    }
    if (Object.hasOwn(override, "logoUrl")) {
      result.logoUrl = normalizeLogoUrl(override.logoUrl, `${overridePath}.logoUrl`, context);
    }
    if (Object.hasOwn(override, "api")) {
      result.api = normalizeEnum(override.api, new Set(["responses", "chat_completions", "anthropic_messages"]), `${overridePath}.api`, context);
    }
    if (Object.hasOwn(override, "authMode")) {
      result.authMode = normalizeEnum(override.authMode, new Set(["codex_openai", "api_key", "anthropic_api_key"]), `${overridePath}.authMode`, context);
    }
    if (Object.hasOwn(override, "custom")) {
      result.custom = normalizeBoolean(override.custom, `${overridePath}.custom`, context);
    }
    if (Object.hasOwn(override, "updatedAt")) {
      result.updatedAt = normalizeTimestamp(override.updatedAt, `${overridePath}.updatedAt`, context);
    }
    return result;
  });
}

function validateCapabilityProviders(value, path, context) {
  if (!expectPlainObject(value, path, context)) return {};
  assertAllowedKeys(value, new Set(["version", "defaults", "providers"]), path, context);
  const result = {
    version: normalizeExactInteger(value.version, 1, `${path}.version`, context),
    defaults: {},
    providers: [],
  };
  if (Object.hasOwn(value, "defaults")) {
    result.defaults = validateDynamicMap(value.defaults, `${path}.defaults`, context, (providerId, entryPath) =>
      normalizeRequiredId(providerId, entryPath, context));
  } else {
    addIssue(context, "missing_required_key", `${path}.defaults`, "缺少能力供应商默认映射。");
  }
  if (!Object.hasOwn(value, "providers") || !expectArray(value.providers, `${path}.providers`, context, 500)) {
    if (!Object.hasOwn(value, "providers")) {
      addIssue(context, "missing_required_key", `${path}.providers`, "缺少能力供应商列表。");
    }
    return result;
  }
  const ids = new Set();
  result.providers = value.providers.map((provider, index) => {
    const providerPath = `${path}.providers[${index}]`;
    if (!expectPlainObject(provider, providerPath, context)) return {};
    assertAllowedKeys(provider, CAPABILITY_PROVIDER_KEYS, providerPath, context);
    const capabilities = validateStringArray(provider.capabilities, `${providerPath}.capabilities`, context, {
      required: true,
      maxItems: 100,
    });
    if (!capabilities.length) {
      addIssue(context, "missing_required_value", `${providerPath}.capabilities`, "能力供应商至少需要一种能力。");
    }
    const resultProvider = {
      id: normalizeRequiredId(provider.id, `${providerPath}.id`, context),
      name: normalizeRequiredText(provider.name, `${providerPath}.name`, context),
      displayName: normalizeRequiredText(provider.displayName, `${providerPath}.displayName`, context),
      kind: normalizeExactString(provider.kind, "capability_provider", `${providerPath}.kind`, context),
      source: normalizeExactString(provider.source, "capabilityProviders", `${providerPath}.source`, context),
      capability: normalizeRequiredId(provider.capability, `${providerPath}.capability`, context),
      capabilities,
      adapter: normalizeRequiredId(provider.adapter, `${providerPath}.adapter`, context),
    };
    if (capabilities.length && resultProvider.capability !== capabilities[0]) {
      addIssue(context, "capability_mismatch", `${providerPath}.capability`, "主能力必须与能力列表第一项一致。");
    }
    if (ids.has(resultProvider.id)) {
      addIssue(context, "duplicate_id", `${providerPath}.id`, "能力供应商 ID 重复。");
    }
    ids.add(resultProvider.id);
    validateOptionalProviderFields(provider, resultProvider, providerPath, context, {
      allowMaxResponseBytes: true,
    });
    return resultProvider;
  });
  for (const [index, [, providerId]] of Object.entries(result.defaults).entries()) {
    if (providerId && !ids.has(providerId)) {
      addIssue(context, "dangling_reference", `${path}.defaults[${index}]`, "默认能力供应商引用不存在。");
    }
  }
  return result;
}

function validateImageProviders(value, path, context) {
  if (!expectPlainObject(value, path, context)) return {};
  assertAllowedKeys(value, new Set(["version", "defaultProviderId", "providers"]), path, context);
  const result = {
    version: normalizeExactInteger(value.version, 1, `${path}.version`, context),
    defaultProviderId: normalizeText(value.defaultProviderId, `${path}.defaultProviderId`, context, {
      maxLength: 240,
      allowEmpty: true,
    }),
    providers: [],
  };
  if (!Object.hasOwn(value, "providers") || !expectArray(value.providers, `${path}.providers`, context, 500)) {
    if (!Object.hasOwn(value, "providers")) {
      addIssue(context, "missing_required_key", `${path}.providers`, "缺少图片供应商列表。");
    }
    return result;
  }
  const ids = new Set();
  result.providers = value.providers.map((provider, index) => {
    const providerPath = `${path}.providers[${index}]`;
    if (!expectPlainObject(provider, providerPath, context)) return {};
    assertAllowedKeys(provider, IMAGE_PROVIDER_KEYS, providerPath, context);
    const resultProvider = {
      id: normalizeRequiredId(provider.id, `${providerPath}.id`, context),
      name: normalizeRequiredText(provider.name, `${providerPath}.name`, context),
      adapter: normalizeEnum(provider.adapter, IMAGE_PROVIDER_ADAPTERS, `${providerPath}.adapter`, context),
      baseUrl: normalizeHttpUrl(provider.baseUrl, `${providerPath}.baseUrl`, context),
      endpoint: normalizeEndpoint(provider.endpoint, `${providerPath}.endpoint`, context),
      model: normalizeRequiredText(provider.model, `${providerPath}.model`, context, 500),
      size: normalizeText(provider.size, `${providerPath}.size`, context, { maxLength: 100, allowEmpty: true }),
      apiKeyEnv: normalizeEnvironmentName(provider.apiKeyEnv, `${providerPath}.apiKeyEnv`, context),
      response: validateImageResponse(provider.response, `${providerPath}.response`, context),
    };
    if (ids.has(resultProvider.id)) {
      addIssue(context, "duplicate_id", `${providerPath}.id`, "图片供应商 ID 重复。");
    }
    ids.add(resultProvider.id);
    validateOptionalProviderFields(provider, resultProvider, providerPath, context, {
      allowMaxResponseBytes: false,
    });
    if (Object.hasOwn(provider, "request")) {
      resultProvider.request = validateRequestTemplate(provider.request, `${providerPath}.request`, context);
    }
    if (Object.hasOwn(provider, "headers")) {
      resultProvider.headers = clonePortableJson(provider.headers, `${providerPath}.headers`, context);
    }
    return resultProvider;
  });
  if (result.defaultProviderId && !ids.has(result.defaultProviderId)) {
    addIssue(context, "dangling_reference", `${path}.defaultProviderId`, "默认图片供应商引用不存在。");
  }
  return result;
}

function validateOptionalProviderFields(provider, result, path, context, { allowMaxResponseBytes }) {
  if (Object.hasOwn(provider, "baseUrl") && !Object.hasOwn(result, "baseUrl")) {
    result.baseUrl = normalizeHttpUrl(provider.baseUrl, `${path}.baseUrl`, context);
  }
  for (const key of ["endpoint", "model"]) {
    if (Object.hasOwn(provider, key) && !Object.hasOwn(result, key)) {
      result[key] = key === "endpoint"
        ? normalizeEndpoint(provider[key], `${path}.${key}`, context)
        : normalizeRequiredText(provider[key], `${path}.${key}`, context, 500);
    }
  }
  if (Object.hasOwn(provider, "apiKeyEnv") && !Object.hasOwn(result, "apiKeyEnv")) {
    result.apiKeyEnv = normalizeEnvironmentName(provider.apiKeyEnv, `${path}.apiKeyEnv`, context);
  }
  if (Object.hasOwn(provider, "enabled")) {
    result.enabled = normalizeBoolean(provider.enabled, `${path}.enabled`, context);
  }
  if (Object.hasOwn(provider, "priority")) {
    result.priority = normalizeIntegerInRange(provider.priority, -1_000_000, 1_000_000, `${path}.priority`, context);
  }
  if (allowMaxResponseBytes && Object.hasOwn(provider, "maxResponseBytes")) {
    result.maxResponseBytes = normalizePositiveInteger(provider.maxResponseBytes, `${path}.maxResponseBytes`, context);
  }
  if (Object.hasOwn(provider, "maxAssetBytes")) {
    result.maxAssetBytes = normalizePositiveInteger(provider.maxAssetBytes, `${path}.maxAssetBytes`, context);
  }
  if (Object.hasOwn(provider, "defaults")) {
    result.defaults = clonePortableJson(provider.defaults, `${path}.defaults`, context);
  }
}

function validateModelImageGeneration(value, path, context) {
  return validateDynamicMap(value, path, context, (settings, settingsPath) => {
    if (!expectPlainObject(settings, settingsPath, context)) return {};
    assertAllowedKeys(settings, IMAGE_GENERATION_KEYS, settingsPath, context);
    const mode = normalizeEnum(settings.mode, IMAGE_GENERATION_MODES, `${settingsPath}.mode`, context);
    const result = {
      enabled: normalizeBoolean(settings.enabled, `${settingsPath}.enabled`, context),
      mode,
    };
    if (mode === "off" && result.enabled !== false) {
      addIssue(context, "mode_state_mismatch", `${settingsPath}.enabled`, "关闭模式必须禁用生图。");
    }
    if (mode !== "off" && result.enabled !== true) {
      addIssue(context, "mode_state_mismatch", `${settingsPath}.enabled`, "启用的生图模式必须设置 enabled=true。");
    }
    if (mode === "provider") {
      result.providerId = normalizeRequiredId(settings.providerId, `${settingsPath}.providerId`, context);
    }
    if (mode === "custom" || mode === "official") {
      result.displayName = normalizeRequiredText(settings.displayName, `${settingsPath}.displayName`, context);
      result.baseUrl = normalizeHttpUrl(settings.baseUrl, `${settingsPath}.baseUrl`, context);
      result.endpoint = normalizeEndpoint(settings.endpoint, `${settingsPath}.endpoint`, context);
      result.model = normalizeRequiredText(settings.model, `${settingsPath}.model`, context, 500);
      result.size = normalizeText(settings.size, `${settingsPath}.size`, context, { maxLength: 100, allowEmpty: true });
      result.apiKeyEnv = normalizeEnvironmentName(settings.apiKeyEnv, `${settingsPath}.apiKeyEnv`, context);
    }
    for (const key of ["displayName", "baseUrl", "endpoint", "model", "size", "apiKeyEnv", "providerId", "adapter"] ) {
      if (!Object.hasOwn(settings, key) || Object.hasOwn(result, key)) continue;
      if (key === "baseUrl") result[key] = normalizeOptionalHttpUrl(settings[key], `${settingsPath}.${key}`, context);
      else if (key === "endpoint") result[key] = normalizeEndpoint(settings[key], `${settingsPath}.${key}`, context);
      else if (key === "apiKeyEnv") result[key] = settings[key] ? normalizeEnvironmentName(settings[key], `${settingsPath}.${key}`, context) : "";
      else result[key] = normalizeText(settings[key], `${settingsPath}.${key}`, context, { maxLength: 500, allowEmpty: true });
    }
    for (const key of ["defaults", "response", "headers"]) {
      if (Object.hasOwn(settings, key)) {
        result[key] = clonePortableJson(settings[key], `${settingsPath}.${key}`, context);
      }
    }
    if (Object.hasOwn(settings, "request")) {
      result.request = validateRequestTemplate(settings.request, `${settingsPath}.request`, context);
    }
    return result;
  });
}

function validateImageResponse(value, path, context) {
  if (!expectPlainObject(value, path, context)) return {};
  assertAllowedKeys(value, new Set(["imageUrlPath", "imageBase64Path"]), path, context);
  return {
    imageUrlPath: normalizeRequiredText(value.imageUrlPath, `${path}.imageUrlPath`, context, 500),
    imageBase64Path: normalizeRequiredText(value.imageBase64Path, `${path}.imageBase64Path`, context, 500),
  };
}

function validateRequestTemplate(value, path, context) {
  if (!expectPlainObject(value, path, context)) return {};
  assertAllowedKeys(value, new Set(["template"]), path, context);
  if (!Object.hasOwn(value, "template")) {
    addIssue(context, "missing_required_key", `${path}.template`, "请求模板缺少 template。");
    return {};
  }
  return { template: clonePortableJson(value.template, `${path}.template`, context) };
}

function validateModelCapabilities(value, path, context) {
  if (!expectPlainObject(value, path, context)) return {};
  assertAllowedKeys(value, new Set(["imageInput", "overrides"]), path, context);
  const result = { imageInput: {}, overrides: {} };
  if (!Object.hasOwn(value, "imageInput")) {
    addIssue(context, "missing_required_key", `${path}.imageInput`, "缺少图片输入能力映射。");
  } else {
    result.imageInput = validateDynamicMap(value.imageInput, `${path}.imageInput`, context, (enabled, entryPath) =>
      normalizeBoolean(enabled, entryPath, context));
  }
  if (!Object.hasOwn(value, "overrides")) {
    addIssue(context, "missing_required_key", `${path}.overrides`, "缺少模型能力覆盖映射。");
  } else {
    result.overrides = validateDynamicMap(value.overrides, `${path}.overrides`, context, (override, overridePath) => {
      if (!expectPlainObject(override, overridePath, context)) return {};
      assertAllowedKeys(override, new Set(["api", "inputModalities", "contextWindow", "reasoning", "updatedAt"]), overridePath, context);
      const normalized = {};
      if (Object.hasOwn(override, "api")) {
        normalized.api = normalizeEnum(override.api, VALID_MODEL_APIS, `${overridePath}.api`, context);
      }
      if (Object.hasOwn(override, "inputModalities")) {
        normalized.inputModalities = validateModalities(override.inputModalities, `${overridePath}.inputModalities`, context);
      }
      if (Object.hasOwn(override, "contextWindow")) {
        normalized.contextWindow = normalizePositiveInteger(override.contextWindow, `${overridePath}.contextWindow`, context);
      }
      if (Object.hasOwn(override, "reasoning")) {
        normalized.reasoning = validateReasoning(override.reasoning, `${overridePath}.reasoning`, context);
      }
      if (Object.hasOwn(override, "updatedAt")) {
        normalized.updatedAt = normalizeTimestamp(override.updatedAt, `${overridePath}.updatedAt`, context);
      }
      if (!Object.keys(normalized).length) {
        addIssue(context, "empty_section_entry", overridePath, "模型能力覆盖项不能为空。");
      }
      return normalized;
    });
  }
  return result;
}

function validateReasoning(value, path, context) {
  if (!expectPlainObject(value, path, context)) return {};
  assertAllowedKeys(value, new Set(["mode", "note"]), path, context);
  const result = {
    mode: normalizeRequiredText(value.mode, `${path}.mode`, context, 100),
  };
  if (Object.hasOwn(value, "note")) {
    result.note = normalizeText(value.note, `${path}.note`, context, { maxLength: 200, allowEmpty: true });
  }
  return result;
}

function validateProfiles(value, path, context) {
  if (!expectArray(value, path, context, 500)) return [];
  const ids = new Set();
  return value.map((profile, index) => {
    const profilePath = `${path}[${index}]`;
    if (!expectPlainObject(profile, profilePath, context)) return {};
    assertAllowedKeys(profile, PROFILE_KEYS, profilePath, context);
    const result = {
      id: normalizeRequiredId(profile.id, `${profilePath}.id`, context),
      name: normalizeRequiredText(profile.name, `${profilePath}.name`, context),
      mode: normalizeEnum(profile.mode, VALID_MODES, `${profilePath}.mode`, context),
      selectedModelIds: validateStringArray(profile.selectedModelIds, `${profilePath}.selectedModelIds`, context, {
        required: true,
        maxItems: 500,
      }),
      desktopOptions: validateDesktopOptions(profile.desktopOptions, `${profilePath}.desktopOptions`, context),
      note: normalizeText(profile.note, `${profilePath}.note`, context, { maxLength: 240, allowEmpty: true }),
      createdAt: normalizeTimestamp(profile.createdAt, `${profilePath}.createdAt`, context),
      updatedAt: normalizeTimestamp(profile.updatedAt, `${profilePath}.updatedAt`, context),
    };
    if (ids.has(result.id)) {
      addIssue(context, "duplicate_id", `${profilePath}.id`, "配置档 ID 重复。");
    }
    ids.add(result.id);
    return result;
  });
}

function validateCodexResources(value, path, context) {
  if (!expectPlainObject(value, path, context)) return {};
  assertAllowedKeys(value, RESOURCE_MANIFEST_KEYS, path, context);
  const result = {
    version: normalizeExactInteger(value.version, 1, `${path}.version`, context),
    portableOnly: normalizeExactBoolean(value.portableOnly, true, `${path}.portableOnly`, context),
    autoApply: normalizeExactBoolean(value.autoApply, false, `${path}.autoApply`, context),
  };
  if (Object.hasOwn(value, "note")) {
    result.note = normalizeText(value.note, `${path}.note`, context, { maxLength: 2_000, allowEmpty: true });
  }
  if (Object.hasOwn(value, "summary")) {
    const summary = value.summary;
    result.summary = {};
    if (expectPlainObject(summary, `${path}.summary`, context)) {
      assertAllowedKeys(summary, RESOURCE_SUMMARY_KEYS, `${path}.summary`, context);
      for (const key of Object.keys(summary)) {
        if (!RESOURCE_SUMMARY_KEYS.has(key)) continue;
        result.summary[key] = summary[key] === null
          ? null
          : normalizeNonNegativeInteger(summary[key], `${path}.summary.${key}`, context);
      }
    }
  }
  if (Object.hasOwn(value, "readStatus")) {
    const readStatus = value.readStatus;
    result.readStatus = {};
    if (expectPlainObject(readStatus, `${path}.readStatus`, context)) {
      assertAllowedKeys(readStatus, RESOURCE_READ_KINDS, `${path}.readStatus`, context);
      for (const kind of Object.keys(readStatus)) {
        if (!RESOURCE_READ_KINDS.has(kind)) continue;
        const statusPath = `${path}.readStatus.${kind}`;
        const status = readStatus[kind];
        if (!expectPlainObject(status, statusPath, context)) continue;
        assertAllowedKeys(status, RESOURCE_READ_STATUS_KEYS, statusPath, context);
        const normalized = {
          ok: normalizeBoolean(status.ok, `${statusPath}.ok`, context),
        };
        for (const key of ["state", "source", "code", "reason"]) {
          if (Object.hasOwn(status, key)) {
            normalized[key] = normalizeText(status[key], `${statusPath}.${key}`, context, {
              maxLength: 500,
              allowEmpty: true,
            });
          }
        }
        if (normalized.ok === true && normalized.state && normalized.state !== "ok") {
          addIssue(context, "read_status_mismatch", `${statusPath}.state`, "资源读取状态互相冲突。");
        }
        result.readStatus[kind] = normalized;
      }
    }
  }
  for (const kind of Object.keys(RESOURCE_ITEM_KEYS)) {
    if (!Object.hasOwn(value, kind)) continue;
    const listPath = `${path}.${kind}`;
    const list = value[kind];
    if (!expectArray(list, listPath, context, 200)) {
      result[kind] = [];
      continue;
    }
    result[kind] = list.map((item, index) => validateResourceItem(kind, item, `${listPath}[${index}]`, context));
  }
  return result;
}

function validateResourceItem(kind, item, path, context) {
  if (!expectPlainObject(item, path, context)) return {};
  assertAllowedKeys(item, RESOURCE_ITEM_KEYS[kind], path, context);
  const identityKey = kind === "plugins" ? "id" : "name";
  const result = {
    [identityKey]: normalizeRequiredText(item[identityKey], `${path}.${identityKey}`, context, 500),
  };
  for (const key of ["name", "description", "purpose", "source", "availability", "version"]) {
    if (key === identityKey || !Object.hasOwn(item, key)) continue;
    result[key] = normalizeText(item[key], `${path}.${key}`, context, { maxLength: 500, allowEmpty: true });
  }
  if (Object.hasOwn(item, "enabled")) {
    result.enabled = normalizeBoolean(item.enabled, `${path}.enabled`, context);
  }
  return result;
}

function validateRequiredSecretReferences(candidate, context) {
  const referenced = new Set();
  for (const envName of candidate.secretKeys || []) {
    referenced.add(envName);
  }
  collectEnvironmentReferences(candidate.customModels, referenced);
  collectEnvironmentReferences(candidate.providerOverrides, referenced);
  collectEnvironmentReferences(candidate.capabilityProviders, referenced);
  collectEnvironmentReferences(candidate.imageProviders, referenced);
  collectEnvironmentReferences(candidate.modelImageGeneration, referenced);
  if (!referenced.size) return;
  if (!Object.hasOwn(candidate, "requiredSecretKeys")) {
    addIssue(context, "missing_required_key", "$.requiredSecretKeys", "存在密钥引用时必须声明 requiredSecretKeys。");
    return;
  }
  const declared = new Set(candidate.requiredSecretKeys);
  for (const envName of referenced) {
    if (!declared.has(envName)) {
      addIssue(context, "missing_secret_reference", "$.requiredSecretKeys", "requiredSecretKeys 未覆盖所有密钥引用。");
      return;
    }
  }
}

function validateCrossSectionReferences(candidate, context) {
  if (!Object.hasOwn(candidate, "imageProviders") || !Object.hasOwn(candidate, "modelImageGeneration")) {
    return;
  }
  const providerIds = new Set(
    (candidate.imageProviders?.providers || [])
      .map((provider) => provider?.id)
      .filter(Boolean),
  );
  Object.values(candidate.modelImageGeneration || {}).forEach((settings, index) => {
    if (settings?.mode === "provider" && settings.providerId && !providerIds.has(settings.providerId)) {
      addIssue(
        context,
        "dangling_reference",
        `$.modelImageGeneration[${index}].providerId`,
        "生图配置引用的图片供应商不存在于导入包中。",
      );
    }
  });
}

function collectEnvironmentReferences(value, target) {
  if (Array.isArray(value)) {
    for (const item of value) collectEnvironmentReferences(item, target);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if ((key === "apiKeyEnv" || key === "keyEnv") && typeof item === "string" && item) {
      target.add(item);
    } else {
      collectEnvironmentReferences(item, target);
    }
  }
}

function validateEnvironmentNameArray(value, path, context) {
  if (!expectArray(value, path, context, 1_000)) return [];
  const result = [];
  const seen = new Set();
  value.forEach((item, index) => {
    const normalized = normalizeEnvironmentName(item, `${path}[${index}]`, context);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  });
  return result.sort();
}

function validateModalities(value, path, context) {
  const result = validateStringArray(value, path, context, { required: true, maxItems: 4 });
  const allowed = new Set(["text", "image", "file", "audio"]);
  result.forEach((modality, index) => {
    if (!allowed.has(modality)) {
      addIssue(context, "invalid_enum", `${path}[${index}]`, "模型输入类型不受支持。");
    }
  });
  if (!result.includes("text")) {
    addIssue(context, "missing_required_value", path, "模型输入类型必须包含 text。");
  }
  return ["text", "image", "file", "audio"].filter((item) => result.includes(item));
}

function validateStringArray(value, path, context, { required = false, maxItems = MAX_ARRAY_ITEMS } = {}) {
  if (!expectArray(value, path, context, maxItems)) return [];
  if (required && value.length === 0) {
    // Empty selections are valid; callers that need one item enforce it explicitly.
  }
  const result = [];
  const seen = new Set();
  value.forEach((item, index) => {
    const normalized = normalizeRequiredText(item, `${path}[${index}]`, context, 500);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  });
  return result;
}

function validateDynamicMap(value, path, context, mapper) {
  if (!expectPlainObject(value, path, context)) return {};
  const keys = Object.keys(value);
  if (keys.length > MAX_MAP_ITEMS) {
    addIssue(context, "too_many_entries", path, "配置段条目过多。");
  }
  const result = {};
  for (const [index, rawKey] of keys.slice(0, MAX_MAP_ITEMS).entries()) {
    const keyPath = `${path}[${index}]`;
    const key = normalizeMapKey(rawKey, keyPath, context);
    if (!key) continue;
    result[key] = mapper(value[rawKey], keyPath, key);
  }
  return result;
}

function normalizeMapKey(value, path, context) {
  const key = String(value || "").trim();
  if (!key || key.length > 240 || /[\u0000-\u001f\u007f]/.test(key)) {
    addIssue(context, "invalid_map_key", path, "配置映射 key 无效。");
    return "";
  }
  if (DANGEROUS_KEYS.has(key)) {
    addIssue(context, "dangerous_key", path, "配置映射包含危险 key。");
    return "";
  }
  if (looksLikeSecretValue(key)) {
    addIssue(context, "suspected_secret_value", path, "配置映射 key 疑似包含密钥值。");
    return "";
  }
  if (looksLikeLocalPath(key)) {
    addIssue(context, "forbidden_local_path_value", path, "配置映射 key 不能包含本机绝对路径。");
    return "";
  }
  return key;
}

function clonePortableJson(value, path, context, depth = 0, seen = new WeakSet()) {
  if (depth > MAX_JSON_DEPTH) {
    addIssue(context, "value_too_deep", path, "配置值嵌套过深。");
    return null;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      addIssue(context, "invalid_number", path, "配置数字必须有限。");
      return 0;
    }
    return value;
  }
  if (typeof value === "string") {
    return normalizeText(value, path, context, { maxLength: MAX_TEXT_LENGTH, allowEmpty: true, trim: false });
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) {
      addIssue(context, "too_many_entries", path, "配置数组条目过多。");
    }
    if (seen.has(value)) {
      addIssue(context, "cyclic_value", path, "配置值不能包含循环引用。");
      return [];
    }
    seen.add(value);
    const result = value.slice(0, MAX_ARRAY_ITEMS).map((item, index) =>
      clonePortableJson(item, `${path}[${index}]`, context, depth + 1, seen));
    seen.delete(value);
    return result;
  }
  if (!expectPlainObject(value, path, context)) return null;
  if (seen.has(value)) {
    addIssue(context, "cyclic_value", path, "配置值不能包含循环引用。");
    return {};
  }
  seen.add(value);
  const result = {};
  const keys = Object.keys(value);
  if (keys.length > MAX_MAP_ITEMS) {
    addIssue(context, "too_many_entries", path, "配置对象条目过多。");
  }
  for (const [index, key] of keys.slice(0, MAX_MAP_ITEMS).entries()) {
    const itemPath = `${path}[${index}]`;
    const normalizedKey = normalizedFieldName(key);
    if (DANGEROUS_KEYS.has(key)) {
      addIssue(context, "dangerous_key", itemPath, "配置对象包含危险 key。");
      continue;
    }
    if (looksLikeSecretValue(key)) {
      addIssue(context, "suspected_secret_value", itemPath, "配置对象 key 疑似包含密钥值。");
      continue;
    }
    if (looksLikeLocalPath(key)) {
      addIssue(context, "forbidden_local_path_value", itemPath, "配置对象 key 不能包含本机绝对路径。");
      continue;
    }
    if (isCredentialFieldName(normalizedKey)) {
      if (typeof value[key] === "string" && isApprovedCredentialTemplate(value[key])) {
        result[key] = value[key].trim();
      } else {
        addIssue(context, "forbidden_sensitive_key", itemPath, "配置包不能包含密钥字段。");
      }
      continue;
    }
    if (LOCAL_PATH_KEYS.has(normalizedKey)) {
      addIssue(context, "forbidden_local_path_key", itemPath, "配置包不能包含本机路径字段。");
      continue;
    }
    result[key] = clonePortableJson(value[key], itemPath, context, depth + 1, seen);
  }
  seen.delete(value);
  return result;
}

function expectPlainObject(value, path, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    addIssue(context, "invalid_object", path, "配置段必须是普通对象。");
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    addIssue(context, "invalid_object", path, "配置段必须是普通对象。");
    return false;
  }
  return true;
}

function expectArray(value, path, context, maxItems = MAX_ARRAY_ITEMS) {
  if (!Array.isArray(value)) {
    addIssue(context, "invalid_array", path, "配置段必须是数组。");
    return false;
  }
  if (value.length > maxItems) {
    addIssue(context, "too_many_entries", path, "配置数组条目过多。");
    return false;
  }
  return true;
}

function assertAllowedKeys(value, allowed, path, context) {
  for (const [index, key] of Object.keys(value).entries()) {
    if (!allowed.has(key)) {
      addIssue(context, "unknown_key", safeFieldIssuePath(path, key, index), "配置段包含不受支持的字段。");
    }
  }
}

function normalizeText(value, path, context, {
  maxLength = 500,
  allowEmpty = false,
  trim = true,
  allowAbsolutePath = false,
} = {}) {
  if (typeof value !== "string") {
    addIssue(context, "invalid_string", path, "配置值必须是字符串。");
    return "";
  }
  const text = trim ? value.trim() : value;
  if (!allowEmpty && !text) {
    addIssue(context, "missing_required_value", path, "配置值不能为空。");
  }
  if (text.length > maxLength) {
    addIssue(context, "string_too_long", path, "配置字符串超过允许长度。");
    return text.slice(0, maxLength);
  }
  if (/\u0000/.test(text)) {
    addIssue(context, "invalid_string", path, "配置字符串包含非法字符。");
  }
  if (isHttpUrl(text)) {
    validatePortableHttpUrl(text, path, context);
  }
  if (looksLikeSecretValue(text)) {
    addIssue(context, "suspected_secret_value", path, "配置包疑似包含密钥值。");
  }
  if (!allowAbsolutePath && looksLikeLocalPath(text)) {
    addIssue(context, "forbidden_local_path_value", path, "配置包不能包含本机绝对路径。");
  }
  return text;
}

function normalizeRequiredText(value, path, context, maxLength = 500) {
  return normalizeText(value, path, context, { maxLength, allowEmpty: false });
}

function normalizeRequiredId(value, path, context) {
  const id = normalizeRequiredText(value, path, context, 240);
  if (/[\u0000-\u001f\u007f]/.test(id)) {
    addIssue(context, "invalid_id", path, "配置 ID 包含非法字符。");
  }
  return id;
}

function normalizeEnvironmentName(value, path, context) {
  const name = normalizeRequiredText(value, path, context, 128);
  if (name && !/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    addIssue(context, "invalid_environment_name", path, "密钥环境变量名格式无效。");
  }
  return name;
}

function normalizeEnum(value, allowed, path, context) {
  const normalized = normalizeRequiredText(value, path, context, 100);
  if (normalized && !allowed.has(normalized)) {
    addIssue(context, "invalid_enum", path, "配置枚举值不受支持。");
  }
  return normalized;
}

function normalizeExactString(value, expected, path, context) {
  const normalized = normalizeRequiredText(value, path, context, 200);
  if (normalized !== expected) {
    addIssue(context, "unexpected_value", path, "配置值与当前格式不匹配。");
  }
  return expected;
}

function normalizeBoolean(value, path, context) {
  if (typeof value !== "boolean") {
    addIssue(context, "invalid_boolean", path, "配置值必须是布尔值。");
    return false;
  }
  return value;
}

function normalizeExactBoolean(value, expected, path, context) {
  if (value !== expected) {
    addIssue(context, "unexpected_value", path, "配置布尔值与当前格式不匹配。");
  }
  return expected;
}

function normalizeExactInteger(value, expected, path, context) {
  if (!Number.isInteger(value) || value !== expected) {
    addIssue(context, "unexpected_version", path, "配置版本不受支持。");
  }
  return expected;
}

function normalizeIntegerInRange(value, min, max, path, context) {
  if (!Number.isInteger(value) || value < min || value > max) {
    addIssue(context, "invalid_integer", path, "配置整数超出允许范围。");
    return min;
  }
  return value;
}

function normalizePositiveInteger(value, path, context) {
  if (!Number.isInteger(value) || value <= 0) {
    addIssue(context, "invalid_positive_integer", path, "配置值必须是正整数。");
    return 0;
  }
  return value;
}

function normalizeNonNegativeInteger(value, path, context) {
  if (!Number.isInteger(value) || value < 0) {
    addIssue(context, "invalid_non_negative_integer", path, "配置值必须是非负整数。");
    return 0;
  }
  return value;
}

function normalizePositiveNumber(value, path, context, { integer = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    addIssue(context, "invalid_positive_number", path, "配置值必须是有效正数。");
    return 0;
  }
  return value;
}

function normalizeTimestamp(value, path, context) {
  const text = normalizeRequiredText(value, path, context, 100);
  if (!text || !Number.isFinite(Date.parse(text))) {
    addIssue(context, "invalid_timestamp", path, "配置时间格式无效。");
  }
  return text;
}

function normalizeHttpUrl(value, path, context) {
  const text = normalizeRequiredText(value, path, context, 4_000);
  validatePortableHttpUrl(text, path, context);
  return text.replace(/\/+$/, "");
}

function normalizeOptionalHttpUrl(value, path, context) {
  const text = normalizeText(value, path, context, { maxLength: 4_000, allowEmpty: true });
  if (text) validatePortableHttpUrl(text, path, context);
  return text;
}

function normalizeLogoUrl(value, path, context) {
  const text = normalizeText(value, path, context, {
    maxLength: Math.ceil(MAX_EMBEDDED_LOGO_BYTES * 1.5),
    allowEmpty: true,
  });
  if (!text) return "";
  if (isHttpUrl(text)) {
    validatePortableHttpUrl(text, path, context);
    return text;
  }
  const match = /^data:image\/(?:png|jpeg|jpg|webp|gif|svg\+xml|x-icon);base64,([A-Za-z0-9+/=]+)$/i.exec(text);
  if (!match) {
    addIssue(context, "invalid_logo_url", path, "Logo 必须是 http(s) URL 或受支持的 data image URL。");
    return text;
  }
  const estimatedBytes = Math.floor((match[1].length * 3) / 4);
  if (estimatedBytes <= 0 || estimatedBytes > MAX_EMBEDDED_LOGO_BYTES) {
    addIssue(context, "embedded_logo_too_large", path, "内嵌 Logo 超过允许大小。");
  }
  return text;
}

function normalizeEndpoint(value, path, context) {
  const endpoint = normalizeText(value, path, context, {
    maxLength: 1_000,
    allowEmpty: false,
    allowAbsolutePath: true,
  });
  if (endpoint && !endpoint.startsWith("/")) {
    addIssue(context, "invalid_endpoint", path, "接口路径必须以斜杠开头。");
  }
  return endpoint;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function validatePortableHttpUrl(value, path, context) {
  let url;
  try {
    url = new URL(value);
  } catch {
    addIssue(context, "invalid_url", path, "配置 URL 必须使用 http 或 https。");
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    addIssue(context, "invalid_url", path, "配置 URL 必须使用 http 或 https。");
    return;
  }
  if (url.username || url.password) {
    addIssue(context, "credentialed_url", path, "配置 URL 不能包含用户名或密码。");
  }
  for (const [key, item] of url.searchParams.entries()) {
    if (
      (isCredentialUrlQueryKey(key) && !isApprovedCredentialTemplate(item)) ||
      looksLikeSecretValue(item)
    ) {
      addIssue(context, "sensitive_url_query", path, "配置 URL 不能包含敏感查询参数。");
      break;
    }
  }
  if (url.hash && looksLikeSecretValue(url.hash.slice(1))) {
    addIssue(context, "sensitive_url_fragment", path, "配置 URL 不能在片段中包含密钥值。");
  }
}

function looksLikeSecretValue(value) {
  if (!value || value.length < 12) return false;
  const text = String(value).trim();
  if (/\bsk-[A-Za-z0-9_-]{12,}\b/.test(text)
    || /\bAIza[0-9A-Za-z_-]{16,}\b/.test(text)
    || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/i.test(text)
    || /\bgh[opusr]_[A-Za-z0-9]{20,}\b/i.test(text)
    || /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i.test(text)
    || /\bAKIA[0-9A-Z]{16}\b/.test(text)
    || /\bya29\.[A-Za-z0-9_-]{12,}\b/.test(text)
    || /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(text)
    || /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/i.test(text)
    || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)
    || /(?:^|[?&;\s])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret|password)\s*[=:]\s*[A-Za-z0-9._~+\/-]{8,}/i.test(text)) {
    return true;
  }
  if (!/^[A-Za-z0-9._~+\/=\-]{24,}$/.test(text)
    || /^[A-Z_][A-Z0-9_]*$/.test(text)
    || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(text)) {
    return false;
  }
  return /[a-z]/.test(text) && /[A-Z]/.test(text) && /\d/.test(text);
}

function looksLikeLocalPath(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z]:[\\/]/.test(text)
    || /^\\\\/.test(text)
    || /^\/\//.test(text)
    || /^\\(?!\\)/.test(text)
    || /^file:\/\//i.test(text)
    || /^\/(?!\/)/.test(text);
}

function countEmbeddedLogos(value) {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countEmbeddedLogos(item), 0);
  }
  if (!value || typeof value !== "object") return 0;
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (key === "logoUrl" && typeof item === "string" && /^data:image\//i.test(item)) {
      count += 1;
    } else {
      count += countEmbeddedLogos(item);
    }
  }
  return count;
}

function normalizedFieldName(value) {
  return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function safeFieldIssuePath(path, key, index) {
  if (/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(key)
    && !looksLikeSecretValue(key)
    && !looksLikeLocalPath(key)) {
    return `${path}.${key}`;
  }
  return `${path}[field:${index}]`;
}

function addIssue(context, code, path, message) {
  if (context.issues.length >= MAX_ISSUES) return;
  const key = `${code}\u0000${path}`;
  if (context.issueKeys.has(key)) return;
  context.issueKeys.add(key);
  context.issues.push(Object.freeze({
    code,
    section: sectionFromPath(path),
    path,
    message,
  }));
}

function sectionFromPath(path) {
  const match = /^\$\.([A-Za-z_$][A-Za-z0-9_$]*)/.exec(path);
  return match?.[1] || "$";
}

function invalidResult(issues) {
  return Object.freeze({
    ok: false,
    candidate: null,
    issues: freezeIssues(issues),
    presentSections: Object.freeze([]),
  });
}

function freezeIssues(issues) {
  return Object.freeze((Array.isArray(issues) ? issues : []).map((issue) => Object.freeze({
    code: String(issue?.code || "invalid_config_package"),
    section: String(issue?.section || "$"),
    path: String(issue?.path || "$"),
    message: String(issue?.message || "配置包校验失败。"),
  })));
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) {
    deepFreeze(item, seen);
  }
  return Object.freeze(value);
}

export const configPackageImportValidationContract = Object.freeze({
  schema: CONFIG_PACKAGE_SCHEMA,
  version: CONFIG_PACKAGE_VERSION,
  maxInputBytes: MAX_INPUT_BYTES,
  sectionOrder: Object.freeze([...SECTION_ORDER]),
});
