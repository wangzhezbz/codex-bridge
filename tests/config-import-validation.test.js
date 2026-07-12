import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ConfigPackageValidationError,
  parseConfigPackageImport,
  validateConfigPackageImport,
} from "../desktop/config-import-validation.mjs";
import {
  exportConfigPackage,
  saveCapabilityProvider,
  saveConfigProfile,
  saveCustomModel,
  saveImageProvider,
  saveModelCapabilityOverride,
  saveModelImageGenerationOverride,
  saveProviderOverride,
} from "../desktop/settings.mjs";

function validPackage(overrides = {}) {
  return {
    schema: "codexbridge.config-package",
    version: 1,
    exportedAt: "2026-07-11T00:00:00.000Z",
    includesSecrets: false,
    mode: "hybrid",
    selection: {
      mode: "hybrid",
      selectedModelIds: ["deepseek-v4-pro"],
    },
    desktopOptions: {
      bypassSystemProxy: false,
      routerPort: 15722,
      localRateLimitEnabled: false,
      duplicateRequestProtection: true,
      interceptCodexAuxiliaryTasks: false,
      codexAuxiliaryModelId: "",
      autoSelectModel: false,
      autoFailover: false,
      smartRouting: {
        autoSelectRules: {
          code: { mode: "route", routeId: "cb-deepseek-v4-pro" },
        },
        failover: { mode: "ordered", routeIds: ["cb-deepseek-v4-pro"] },
      },
      usageBudgets: {
        global: { dailyTokenLimit: 1000, dailyCostLimit: 2.5 },
        providers: { deepseek: { dailyCallLimit: 25 } },
      },
    },
    customModels: [{
      presetId: "custom-demo-model",
      providerId: "custom-demo",
      providerName: "Demo",
      displayName: "Demo Model",
      description: "Portable test model.",
      api: "chat_completions",
      baseUrl: "https://api.example.com/v1",
      model: "demo-model",
      authMode: "api_key",
      apiKeyEnv: "DEMO_API_KEY",
      keyEnv: "DEMO_API_KEY",
      keyUrl: "https://example.com/keys",
      docsUrl: "https://example.com/docs",
      logoUrl: "https://example.com/logo.png",
      contextWindow: 128000,
      inputModalities: ["text", "image"],
      dropParams: ["response_format"],
      custom: true,
    }],
    providerOverrides: {
      deepseek: {
        id: "deepseek",
        name: "DeepSeek Proxy",
        baseUrl: "https://proxy.example.com/v1",
        keyEnv: "DEEPSEEK_API_KEY",
        api: "chat_completions",
        authMode: "api_key",
        custom: false,
      },
    },
    capabilityProviders: {
      version: 1,
      defaults: { ocr: "paddle-ocr" },
      providers: [{
        id: "paddle-ocr",
        name: "Paddle OCR",
        displayName: "Paddle OCR",
        kind: "capability_provider",
        source: "capabilityProviders",
        capability: "ocr",
        capabilities: ["ocr"],
        adapter: "generic_http",
        baseUrl: "https://ocr.example.com/v1",
        endpoint: "/ocr",
        model: "ocr-v1",
        apiKeyEnv: "OCR_API_KEY",
        enabled: true,
        priority: 10,
        maxResponseBytes: 1048576,
        defaults: { language: "zh" },
      }],
    },
    imageProviders: {
      version: 1,
      defaultProviderId: "demo-image",
      providers: [{
        id: "demo-image",
        name: "Demo Image",
        adapter: "generic_template",
        baseUrl: "https://images.example.com/v1",
        endpoint: "/generate",
        model: "demo-image-v1",
        size: "1024x1024",
        apiKeyEnv: "IMAGE_API_KEY",
        response: {
          imageUrlPath: "data[0].url",
          imageBase64Path: "data[0].b64_json",
        },
        defaults: { quality: "standard" },
        request: { template: { prompt: "{{prompt}}" } },
      }],
    },
    modelImageGeneration: {
      "deepseek-v4-pro": {
        enabled: true,
        mode: "provider",
        providerId: "demo-image",
      },
    },
    embeddedLogoCount: 0,
    modelCapabilities: {
      imageInput: { "deepseek-v4-pro": true },
      overrides: {
        "deepseek-v4-pro": {
          inputModalities: ["text", "image"],
          contextWindow: 128000,
          reasoning: { mode: "supported", note: "portable" },
          updatedAt: "2026-07-11T00:00:00.000Z",
        },
      },
    },
    profiles: [{
      id: "daily",
      name: "Daily",
      mode: "hybrid",
      selectedModelIds: ["deepseek-v4-pro"],
      desktopOptions: { routerPort: 15722 },
      note: "Portable profile",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z",
    }],
    codexResources: {
      version: 1,
      portableOnly: true,
      autoApply: false,
      note: "Migration diagnostics only.",
      summary: { mcpServers: 1, plugins: 1, skills: 1, prompts: 1, agentFiles: 1 },
      readStatus: {
        plugins: { ok: true, state: "ok", source: "cli", code: "ok" },
      },
      mcpServers: [{ name: "demo", description: "Demo MCP", enabled: true }],
      plugins: [{ id: "demo@market", name: "Demo", enabled: true, version: "1.0.0" }],
      skills: [{ name: "demo", description: "Demo skill", enabled: true }],
      prompts: [{ name: "demo", description: "Demo prompt" }],
      agentFiles: [{ name: "AGENTS.md", description: "Rules" }],
    },
    secretKeys: ["DEEPSEEK_API_KEY", "DEMO_API_KEY", "IMAGE_API_KEY", "OCR_API_KEY"],
    requiredSecretKeys: ["DEEPSEEK_API_KEY", "DEMO_API_KEY", "IMAGE_API_KEY", "OCR_API_KEY"],
    ...overrides,
  };
}

test("the current exporter produces a package accepted by the strict validator", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-config-validator-"));
  saveCustomModel(rootDir, {
    providerName: "Demo",
    displayName: "Demo Coder",
    model: "demo-coder",
    baseUrl: "https://api.example.com/v1",
    keyEnv: "DEMO_API_KEY",
  });
  saveProviderOverride(rootDir, "deepseek", {
    name: "DeepSeek Proxy",
    baseUrl: "https://proxy.example.com/v1",
    keyEnv: "DEEPSEEK_API_KEY",
  });
  saveCapabilityProvider(rootDir, {
    id: "demo-ocr",
    name: "Demo OCR",
    capabilities: ["ocr"],
    adapter: "generic_http",
    baseUrl: "https://ocr.example.com/v1",
    endpoint: "/ocr",
    apiKeyEnv: "OCR_API_KEY",
  });
  saveImageProvider(rootDir, {
    id: "demo-image",
    name: "Demo Image",
    adapter: "generic_template",
    baseUrl: "https://image.example.com/v1",
    endpoint: "/generate",
    model: "image-v1",
    apiKeyEnv: "IMAGE_API_KEY",
  });
  saveModelImageGenerationOverride(rootDir, "deepseek-v4-pro", {
    enabled: true,
    mode: "provider",
    providerId: "demo-image",
  });
  saveModelCapabilityOverride(rootDir, "deepseek-v4-pro", {
    inputModalities: ["text", "image"],
    contextWindow: 100_000,
    reasoning: { mode: "supported" },
  });
  saveConfigProfile(rootDir, {
    name: "Daily",
    mode: "hybrid",
    selectedModelIds: ["deepseek-v4-pro"],
    desktopOptions: { routerPort: 15722 },
  });
  const exported = exportConfigPackage(rootDir, { includeCodexResources: false });

  const result = validateConfigPackageImport(JSON.stringify(exported));

  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(result.candidate.selection.selectedModelIds, exported.selection.selectedModelIds);
  assert.equal(result.candidate.includesSecrets, false);
});

test("strict config package validation returns one immutable complete candidate", () => {
  const input = validPackage({
    selection: {
      mode: "hybrid",
      selectedModelIds: [" deepseek-v4-pro ", "deepseek-v4-pro"],
    },
  });

  const result = validateConfigPackageImport(input);

  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.candidate.selection.selectedModelIds, ["deepseek-v4-pro"]);
  assert.equal(Object.isFrozen(result.candidate), true);
  assert.equal(Object.isFrozen(result.candidate.selection), true);
  assert.equal(Object.isFrozen(result.candidate.imageProviders.providers), true);
  assert.equal(result.candidate, parseConfigPackageImport(result.candidate));
  assert.deepEqual(result.presentSections, [
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
  ]);
  assert.deepEqual(input.selection.selectedModelIds, [" deepseek-v4-pro ", "deepseek-v4-pro"]);
});

test("unknown top-level and closed-section keys fail closed with no candidate", () => {
  const input = validPackage({
    unexpectedTopLevel: true,
    selection: {
      mode: "hybrid",
      selectedModelIds: ["deepseek-v4-pro"],
      silentlyIgnoredBefore: true,
    },
    desktopOptions: {
      routerPort: 15722,
      codexDesktopExe: "C:\\Users\\demo\\ChatGPT.exe",
    },
  });

  const result = validateConfigPackageImport(input);

  assert.equal(result.ok, false);
  assert.equal(result.candidate, null);
  assert.deepEqual(result.presentSections, []);
  assert.deepEqual(
    result.issues.map((issue) => [issue.code, issue.path]),
    [
      ["unknown_key", "$.unexpectedTopLevel"],
      ["unknown_key", "$.selection.silentlyIgnoredBefore"],
      ["unknown_key", "$.desktopOptions.codexDesktopExe"],
    ],
  );
});

test("each importable section is validated before a candidate is released", () => {
  const invalidSections = [
    ["selection", { mode: "hybrid", selectedModelIds: [false] }],
    ["desktopOptions", { routerPort: 80 }],
    ["customModels", [{ custom: true, displayName: "missing required fields" }]],
    ["providerOverrides", { deepseek: { id: "other", name: "mismatch" } }],
    ["capabilityProviders", { version: 1, defaults: {}, providers: [{ id: "ocr", name: "OCR", capabilities: [] }] }],
    ["imageProviders", { version: 1, defaultProviderId: "missing", providers: [] }],
    ["modelImageGeneration", { model: { enabled: true, mode: "provider" } }],
    ["modelCapabilities", { imageInput: { model: "yes" }, overrides: {} }],
    ["profiles", [{ id: "missing-name" }]],
    ["codexResources", { version: 1, portableOnly: false, autoApply: false }],
    ["secretKeys", ["not-an-env-name"]],
    ["requiredSecretKeys", "DEMO_API_KEY"],
  ];

  for (const [section, value] of invalidSections) {
    const result = validateConfigPackageImport(validPackage({ [section]: value }));
    assert.equal(result.ok, false, `${section} must fail`);
    assert.equal(result.candidate, null, `${section} must not expose a partial candidate`);
    assert.equal(result.issues.some((issue) => issue.section === section), true, `${section} issue missing`);
  }
});

test("secret-bearing nested fields are rejected without reflecting secret values", () => {
  const secret = "sk-this-value-must-never-be-reflected";
  const input = validPackage({
    modelImageGeneration: {
      "deepseek-v4-pro": {
        enabled: true,
        mode: "custom",
        displayName: "Demo",
        baseUrl: "https://images.example.com/v1",
        endpoint: "/generate",
        model: "demo-image-v1",
        size: "1024x1024",
        apiKeyEnv: "IMAGE_API_KEY",
        defaults: { apiKey: secret },
      },
    },
  });

  const result = validateConfigPackageImport(input);
  assert.equal(result.ok, false);
  assert.equal(result.candidate, null);
  assert.equal(result.issues.some((issue) => issue.code === "forbidden_sensitive_key"), true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));

  assert.throws(
    () => parseConfigPackageImport(input),
    (error) => {
      assert.equal(error instanceof ConfigPackageValidationError, true);
      assert.equal(error.code, "CONFIG_PACKAGE_INVALID");
      assert.equal(Array.isArray(error.issues), true);
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.doesNotMatch(JSON.stringify(error.issues), new RegExp(secret));
      return true;
    },
  );
});

test("invalid JSON, non-plain objects, and prototype-pollution keys fail safely", () => {
  const invalidJson = validateConfigPackageImport('{"schema":');
  assert.equal(invalidJson.ok, false);
  assert.equal(invalidJson.candidate, null);
  assert.deepEqual(invalidJson.issues.map((issue) => issue.code), ["invalid_json"]);

  const polluted = validateConfigPackageImport(
    '{"schema":"codexbridge.config-package","version":1,"includesSecrets":false,"providerOverrides":{"__proto__":{"name":"bad"}}}',
  );
  assert.equal(polluted.ok, false);
  assert.equal(polluted.candidate, null);
  assert.equal(polluted.issues.some((issue) => issue.code === "dangerous_key"), true);

  const nonPlain = validPackage();
  nonPlain.selection = new (class Selection {
    constructor() {
      this.mode = "hybrid";
      this.selectedModelIds = [];
    }
  })();
  const nonPlainResult = validateConfigPackageImport(nonPlain);
  assert.equal(nonPlainResult.ok, false);
  assert.equal(nonPlainResult.candidate, null);
  assert.equal(nonPlainResult.issues.some((issue) => issue.code === "invalid_object"), true);
});

test("preview-compatible partial packages retain section presence without inventing writes", () => {
  const result = validateConfigPackageImport({
    schema: "codexbridge.config-package",
    version: 1,
    includesSecrets: false,
    selection: {
      mode: "hybrid",
      selectedModelIds: ["deepseek-v4-pro"],
    },
    desktopOptions: {
      codexAuxiliaryModelId: "cb-deepseek-v4-pro",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.candidate.mode, "hybrid");
  assert.deepEqual(result.presentSections, ["selection", "desktopOptions"]);
  assert.equal(Object.hasOwn(result.candidate, "customModels"), false);
  assert.equal(Object.hasOwn(result.candidate, "providerOverrides"), false);
});

test("backups emitted by version 1 are accepted, but ambiguous metadata is rejected", () => {
  const accepted = validateConfigPackageImport(validPackage({
    backupReason: "before_config_package_import",
    backupCreatedAt: "2026-07-11T01:02:03.000Z",
  }));
  assert.equal(accepted.ok, true, JSON.stringify(accepted.issues));

  const conflictingMode = validateConfigPackageImport(validPackage({
    mode: "all_api",
    selection: { mode: "hybrid", selectedModelIds: [] },
  }));
  assert.equal(conflictingMode.ok, false);
  assert.equal(conflictingMode.candidate, null);
  assert.equal(conflictingMode.issues.some((issue) => issue.code === "conflicting_mode"), true);

  const missingSecretDeclaration = validPackage();
  delete missingSecretDeclaration.includesSecrets;
  const missing = validateConfigPackageImport(missingSecretDeclaration);
  assert.equal(missing.ok, false);
  assert.equal(missing.issues.some((issue) => issue.path === "$.includesSecrets"), true);
});

test("requiredSecretKeys is mandatory when portable sections reference secrets and must cover every declaration", () => {
  const missingDeclaration = validPackage();
  delete missingDeclaration.requiredSecretKeys;
  const missingResult = validateConfigPackageImport(missingDeclaration);
  assert.equal(missingResult.ok, false);
  assert.equal(
    missingResult.issues.some((issue) =>
      issue.code === "missing_required_key" && issue.path === "$.requiredSecretKeys"),
    true,
  );

  const incompleteResult = validateConfigPackageImport(validPackage({
    requiredSecretKeys: ["DEMO_API_KEY"],
  }));
  assert.equal(incompleteResult.ok, false);
  assert.equal(
    incompleteResult.issues.some((issue) =>
      issue.code === "missing_secret_reference" && issue.path === "$.requiredSecretKeys"),
    true,
  );

  const secretMetadataResult = validateConfigPackageImport({
    schema: "codexbridge.config-package",
    version: 1,
    includesSecrets: false,
    secretKeys: ["PORTABLE_ONLY_API_KEY"],
    requiredSecretKeys: [],
  });
  assert.equal(secretMetadataResult.ok, false);
  assert.equal(
    secretMetadataResult.issues.some((issue) => issue.code === "missing_secret_reference"),
    true,
  );

  const completeResult = validateConfigPackageImport(validPackage({
    requiredSecretKeys: [
      "DEEPSEEK_API_KEY",
      "DEMO_API_KEY",
      "IMAGE_API_KEY",
      "OCR_API_KEY",
      "TARGET_MACHINE_ONLY_API_KEY",
    ],
  }));
  assert.equal(completeResult.ok, true, JSON.stringify(completeResult.issues));
});

test("same-package provider references fail closed while unresolved prospective-state references are deferred", () => {
  const danglingResult = validateConfigPackageImport(validPackage({
    modelImageGeneration: {
      "deepseek-v4-pro": {
        enabled: true,
        mode: "provider",
        providerId: "provider-not-in-package",
      },
    },
  }));
  assert.equal(danglingResult.ok, false);
  assert.equal(
    danglingResult.issues.some((issue) =>
      issue.code === "dangling_reference" && issue.path.endsWith(".providerId")),
    true,
  );

  const prospectiveOnly = validPackage({
    modelImageGeneration: {
      "deepseek-v4-pro": {
        enabled: true,
        mode: "provider",
        providerId: "provider-from-current-machine",
      },
    },
  });
  delete prospectiveOnly.imageProviders;
  const deferredResult = validateConfigPackageImport(prospectiveOnly);
  assert.equal(deferredResult.ok, true, JSON.stringify(deferredResult.issues));
});

test("credentialed URLs and sensitive URL queries are rejected without reflecting credentials", () => {
  const credential = "synthetic-password-value";
  const token = "synthetic-query-token-value-123456789";
  const credentialed = validateConfigPackageImport(validPackage({
    customModels: [{
      ...validPackage().customModels[0],
      baseUrl: `https://demo:${credential}@api.example.com/v1`,
    }],
  }));
  assert.equal(credentialed.ok, false);
  assert.equal(credentialed.issues.some((issue) => issue.code === "credentialed_url"), true);
  assert.doesNotMatch(JSON.stringify(credentialed), new RegExp(credential));

  const sensitiveQuery = validateConfigPackageImport(validPackage({
    providerOverrides: {
      deepseek: {
        ...validPackage().providerOverrides.deepseek,
        docsUrl: `https://example.com/docs?access_token=${token}`,
      },
    },
  }));
  assert.equal(sensitiveQuery.ok, false);
  assert.equal(sensitiveQuery.issues.some((issue) => issue.code === "sensitive_url_query"), true);
  assert.doesNotMatch(JSON.stringify(sensitiveQuery), new RegExp(token));

  const opaqueCredential = "another-synthetic-password";
  const opaqueUrl = validateConfigPackageImport(validPackage({
    imageProviders: {
      ...validPackage().imageProviders,
      providers: [{
        ...validPackage().imageProviders.providers[0],
        defaults: { callback: `https://demo:${opaqueCredential}@example.com/result` },
      }],
    },
  }));
  assert.equal(opaqueUrl.ok, false);
  assert.equal(opaqueUrl.issues.some((issue) => issue.code === "credentialed_url"), true);
  assert.doesNotMatch(JSON.stringify(opaqueUrl), new RegExp(opaqueCredential));
});

test("generalized credential fields and URL queries fail closed while explicit apiKey templates remain portable", () => {
  const fieldNames = [
    "x-auth-token",
    "vendor_secret",
    "databasePassword",
    "service-credential",
    "proxyAuthorization",
    "custom-api-key",
  ];

  for (const [index, fieldName] of fieldNames.entries()) {
    const marker = `synthetic-field-value-${index}`;
    const fieldResult = validateConfigPackageImport(validPackage({
      imageProviders: {
        ...validPackage().imageProviders,
        providers: [{
          ...validPackage().imageProviders.providers[0],
          defaults: { [fieldName]: marker },
        }],
      },
    }));
    assert.equal(fieldResult.ok, false, `${fieldName} must be classified as credential-bearing`);
    assert.equal(
      fieldResult.issues.some((issue) => issue.code === "forbidden_sensitive_key"),
      true,
      `${fieldName} must report a safe sensitive-field issue`,
    );
    assert.doesNotMatch(JSON.stringify(fieldResult), new RegExp(marker));

    const queryMarker = `synthetic-query-value-${index}`;
    const queryResult = validateConfigPackageImport(validPackage({
      providerOverrides: {
        deepseek: {
          ...validPackage().providerOverrides.deepseek,
          docsUrl: `https://example.com/docs?${encodeURIComponent(fieldName)}=${queryMarker}`,
        },
      },
    }));
    assert.equal(queryResult.ok, false, `${fieldName} must be classified in URL queries`);
    assert.equal(
      queryResult.issues.some((issue) => issue.code === "sensitive_url_query"),
      true,
      `${fieldName} query must report a safe URL issue`,
    );
    assert.doesNotMatch(JSON.stringify(queryResult), new RegExp(queryMarker));
  }

  const templateResult = validateConfigPackageImport(validPackage({
    imageProviders: {
      ...validPackage().imageProviders,
      providers: [{
        ...validPackage().imageProviders.providers[0],
        headers: {
          "x-auth-token": "{{apiKey}}",
          "x-api-key": "Bearer {{apiKey}}",
        },
      }],
    },
  }));
  assert.equal(templateResult.ok, true, JSON.stringify(templateResult.issues));
  assert.equal(
    templateResult.candidate.imageProviders.providers[0].headers["x-auth-token"],
    "{{apiKey}}",
  );
  assert.equal(
    templateResult.candidate.imageProviders.providers[0].headers["x-api-key"],
    "Bearer {{apiKey}}",
  );
});

test("dynamic credential-like Env fields cannot bypass the credential classifier", () => {
  for (const [index, fieldName] of [
    "databasePasswordEnv",
    "serviceCredentialEnv",
    "vendorSecretEnv",
    "xAuthTokenEnv",
    "customApiKeyEnv",
  ].entries()) {
    const marker = `synthetic-env-reference-${index}`;
    const result = validateConfigPackageImport(validPackage({
      imageProviders: {
        ...validPackage().imageProviders,
        providers: [{
          ...validPackage().imageProviders.providers[0],
          defaults: { [fieldName]: marker },
        }],
      },
    }));

    assert.equal(result.ok, false, `${fieldName} must not be treated as an allowed environment reference`);
    assert.equal(
      result.issues.some((issue) => issue.code === "forbidden_sensitive_key"),
      true,
      `${fieldName} must report a safe sensitive-field issue`,
    );
    assert.doesNotMatch(JSON.stringify(result), new RegExp(marker));
  }
});

test("AIza, token-like, and key-like values are rejected from opaque portable fields", () => {
  const suspiciousValues = [
    "AIzaSySyntheticOnly123456789012345",
    "github_pat_syntheticOnly12345678901234567890",
    "eyJhbGciOiJIUzI1NiJ9.syntheticPayload123.syntheticSignature456",
    "access_token=syntheticTokenValue1234567890",
    "AbCdEfGhIjKlMnOpQrStUvWxYz012345==",
  ];

  for (const suspiciousValue of suspiciousValues) {
    const result = validateConfigPackageImport(validPackage({
      imageProviders: {
        ...validPackage().imageProviders,
        providers: [{
          ...validPackage().imageProviders.providers[0],
          defaults: { quality: suspiciousValue },
        }],
      },
    }));
    assert.equal(result.ok, false, suspiciousValue);
    assert.equal(result.issues.some((issue) => issue.code === "suspected_secret_value"), true);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(suspiciousValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("Windows, UNC, file URL, and Linux absolute local paths are rejected while API endpoints remain portable", () => {
  const localPaths = [
    "C:\\Users\\demo\\secret.txt",
    "\\\\server\\share\\secret.txt",
    "file:///home/demo/secret.txt",
    "/srv/codexbridge/secret.txt",
  ];

  for (const localPath of localPaths) {
    const result = validateConfigPackageImport(validPackage({
      imageProviders: {
        ...validPackage().imageProviders,
        providers: [{
          ...validPackage().imageProviders.providers[0],
          defaults: { output: localPath },
        }],
      },
    }));
    assert.equal(result.ok, false, localPath);
    assert.equal(result.issues.some((issue) => issue.code === "forbidden_local_path_value"), true);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(localPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  const endpointResult = validateConfigPackageImport(validPackage());
  assert.equal(endpointResult.ok, true, JSON.stringify(endpointResult.issues));
  assert.equal(endpointResult.candidate.imageProviders.providers[0].endpoint, "/generate");
});

test("validation issue paths never reflect attacker-controlled dynamic map keys or secret-like field names", () => {
  const secretMapKey = "sk-synthetic-map-key-123456789012345";
  const secretFieldName = "AIzaSySyntheticFieldName1234567890123";
  const input = validPackage({
    modelImageGeneration: {
      [secretMapKey]: {
        enabled: "not-a-boolean",
        mode: "provider",
        providerId: "demo-image",
      },
    },
    desktopOptions: {
      ...validPackage().desktopOptions,
      [secretFieldName]: true,
    },
  });

  const result = validateConfigPackageImport(input);
  assert.equal(result.ok, false);
  assert.equal(result.candidate, null);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secretMapKey));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secretFieldName));
  assert.equal(result.issues.every((issue) => !issue.path.includes(secretMapKey)), true);
  assert.equal(result.issues.every((issue) => !issue.path.includes(secretFieldName)), true);

  const arbitraryMapKey = "attacker-controlled-capability-name";
  const danglingCapability = validateConfigPackageImport(validPackage({
    capabilityProviders: {
      ...validPackage().capabilityProviders,
      defaults: { [arbitraryMapKey]: "provider-not-in-package" },
    },
  }));
  assert.equal(danglingCapability.ok, false);
  assert.doesNotMatch(JSON.stringify(danglingCapability), new RegExp(arbitraryMapKey));
});
