import test from "node:test";
import assert from "node:assert/strict";

import {
  ROUTE_SNAPSHOT_VERSION,
  createRouteSnapshot,
  resolveRouteSnapshot,
  validateRouteSnapshot,
} from "../src/route-snapshot.js";

const CONTEXT_POLICY = Object.freeze({
  version: 1,
  policyId: "codexbridge-context-v1",
  upstreamContextWindow: 128000,
  contextWindow: 128000,
  inputBudget: 121600,
  compactThreshold: 102400,
  outputReserveTokens: 6400,
  effectiveContextWindowPercent: 95,
  autoCompactPercent: 80,
  truncationPolicy: {
    mode: "tokens",
    limit: 121600,
  },
});

const COMPACT_CONTRACT = Object.freeze({
  mode: "chat-summary",
  strategy: "chat-json",
  requiresStream: false,
  retryWithStream: false,
  fallback: "none",
});

function safeRoute(overrides = {}) {
  return {
    id: "old-route",
    provider: "deepseek",
    api: "chat_completions",
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.example/v1",
    authMode: "api_key",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    dropParams: ["parallel_tool_calls", "response_format"],
    ...overrides,
  };
}

function resolverOptions(overrides = {}) {
  return {
    contextPolicyForRoute: () => CONTEXT_POLICY,
    compactContractForRoute: () => COMPACT_CONTRACT,
    ...overrides,
  };
}

test("createRouteSnapshot creates a versioned exact route contract without credential values", () => {
  const snapshot = createRouteSnapshot(safeRoute(), {
    contextPolicy: CONTEXT_POLICY,
    compactContract: COMPACT_CONTRACT,
  });

  assert.deepEqual(snapshot, {
    version: ROUTE_SNAPSHOT_VERSION,
    id: "old-route",
    provider: "deepseek",
    api: "chat_completions",
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.example/v1",
    authMode: "api_key",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    contextPolicy: CONTEXT_POLICY,
    credentialSource: "environment",
    requiresCustomHeaders: false,
    dropParams: ["parallel_tool_calls", "response_format"],
    compactContract: COMPACT_CONTRACT,
  });
});

test("createRouteSnapshot strips inline credentials, custom header data, and sensitive URL parts", () => {
  const snapshot = createRouteSnapshot(
    safeRoute({
      baseUrl:
        "https://url-user:url-password@api.deepseek.example/v1?access_token=url-token&sig=url-signature&region=cn#private",
      apiKey: "inline-api-key",
      headers: {
        authorization: "Bearer header-secret",
        "x-api-key": "header-api-key",
      },
    }),
    {
      contextPolicy: {
        ...CONTEXT_POLICY,
        apiKey: "policy-secret",
        authorization: "policy-authorization",
      },
      compactContract: {
        ...COMPACT_CONTRACT,
        headers: { authorization: "compact-secret" },
      },
    },
  );

  assert.equal(
    snapshot.baseUrl,
    "https://api.deepseek.example/v1?region=cn",
  );
  assert.equal(snapshot.credentialSource, "inline");
  assert.equal(snapshot.requiresCustomHeaders, true);
  assert.deepEqual(Object.keys(snapshot.contextPolicy).sort(), [
    "autoCompactPercent",
    "compactThreshold",
    "contextWindow",
    "effectiveContextWindowPercent",
    "inputBudget",
    "outputReserveTokens",
    "policyId",
    "truncationPolicy",
    "upstreamContextWindow",
    "version",
  ]);
  assert.deepEqual(Object.keys(snapshot.compactContract).sort(), [
    "fallback",
    "mode",
    "requiresStream",
    "retryWithStream",
    "strategy",
  ]);

  const serialized = JSON.stringify(snapshot);
  for (const secret of [
    "url-user",
    "url-password",
    "url-token",
    "url-signature",
    "inline-api-key",
    "header-secret",
    "header-api-key",
    "policy-secret",
    "policy-authorization",
    "compact-secret",
    "authorization",
    "x-api-key",
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test("createRouteSnapshot derives the shared context policy and compact contract from the route", () => {
  const route = safeRoute({
    provider: undefined,
    providerId: "deepseek",
    contextWindow: 128000,
  });

  const snapshot = createRouteSnapshot(route);

  assert.equal(snapshot.provider, "deepseek");
  assert.deepEqual(snapshot.contextPolicy, CONTEXT_POLICY);
  assert.equal(snapshot.compactContract.mode, "chat-summary");
  assert.equal(snapshot.compactContract.strategy, "chat-json");
  assert.equal(validateRouteSnapshot(snapshot).ok, true);
});

test("createRouteSnapshot derives a canonical provider when legacy routes omit provider fields", () => {
  const route = safeRoute({
    provider: undefined,
    providerId: undefined,
    providerFamily: undefined,
    contextWindow: 128000,
  });

  const snapshot = createRouteSnapshot(route, {
    compactContract: COMPACT_CONTRACT,
  });

  assert.equal(snapshot.provider, "deepseek");
  assert.equal(validateRouteSnapshot(snapshot).ok, true);
});

test("validateRouteSnapshot accepts a complete known-policy snapshot", () => {
  const snapshot = createRouteSnapshot(safeRoute(), {
    contextPolicy: CONTEXT_POLICY,
    compactContract: COMPACT_CONTRACT,
  });

  assert.deepEqual(validateRouteSnapshot(snapshot), {
    ok: true,
    snapshot,
  });
});

test("validateRouteSnapshot rejects unknown snapshot and context-policy versions", () => {
  const snapshot = createRouteSnapshot(safeRoute(), {
    contextPolicy: CONTEXT_POLICY,
    compactContract: COMPACT_CONTRACT,
  });

  assert.equal(
    validateRouteSnapshot({ ...snapshot, version: 999 }).code,
    "route_snapshot_unknown_version",
  );
  assert.equal(
    validateRouteSnapshot({
      ...snapshot,
      contextPolicy: {
        ...snapshot.contextPolicy,
        policyId: "future-context-policy",
      },
    }).code,
    "route_snapshot_unknown_context_policy",
  );
  assert.equal(
    validateRouteSnapshot({
      ...snapshot,
      contextPolicy: {
        ...snapshot.contextPolicy,
        version: 999,
      },
    }).code,
    "route_snapshot_unknown_context_policy",
  );
});

test("validateRouteSnapshot fails closed for inline, URL, unavailable, and custom-header credentials", () => {
  const safeSnapshot = createRouteSnapshot(safeRoute(), {
    contextPolicy: CONTEXT_POLICY,
    compactContract: COMPACT_CONTRACT,
  });

  for (const credentialSource of ["inline", "url"]) {
    assert.equal(
      validateRouteSnapshot({ ...safeSnapshot, credentialSource }).code,
      "route_snapshot_inline_credentials",
      credentialSource,
    );
  }
  assert.equal(
    validateRouteSnapshot({
      ...safeSnapshot,
      credentialSource: "unavailable",
    }).code,
    "route_snapshot_credentials_unavailable",
  );
  assert.equal(
    validateRouteSnapshot({
      ...safeSnapshot,
      requiresCustomHeaders: true,
    }).code,
    "route_snapshot_custom_headers_unsupported",
  );
});

test("validateRouteSnapshot rejects credential material injected into a stored base URL", () => {
  const snapshot = createRouteSnapshot(safeRoute(), {
    contextPolicy: CONTEXT_POLICY,
    compactContract: COMPACT_CONTRACT,
  });

  assert.equal(
    validateRouteSnapshot({
      ...snapshot,
      baseUrl: "https://user:password@api.example/v1?api_key=secret",
    }).code,
    "route_snapshot_inline_credentials",
  );
});

test("resolveRouteSnapshot returns the exact unchanged old route", () => {
  const currentRoute = safeRoute();
  const snapshot = createRouteSnapshot(currentRoute, {
    contextPolicy: CONTEXT_POLICY,
    compactContract: COMPACT_CONTRACT,
  });

  assert.deepEqual(
    resolveRouteSnapshot(
      snapshot,
      [
        safeRoute({ id: "new-default", model: "new-default-model" }),
        currentRoute,
      ],
      resolverOptions(),
    ),
    {
      ok: true,
      route: currentRoute,
      snapshot,
    },
  );
});

test("resolveRouteSnapshot rejects a deleted route without selecting a default or replacement", () => {
  const snapshot = createRouteSnapshot(safeRoute(), {
    contextPolicy: CONTEXT_POLICY,
    compactContract: COMPACT_CONTRACT,
  });

  assert.deepEqual(
    resolveRouteSnapshot(
      snapshot,
      [safeRoute({ id: "new-default", model: "new-default-model" })],
      resolverOptions(),
    ),
    {
      ok: false,
      code: "route_snapshot_route_missing",
    },
  );
});

test("resolveRouteSnapshot rejects a disabled old route", () => {
  const snapshot = createRouteSnapshot(safeRoute(), {
    contextPolicy: CONTEXT_POLICY,
    compactContract: COMPACT_CONTRACT,
  });

  assert.deepEqual(
    resolveRouteSnapshot(
      snapshot,
      [safeRoute({ enabled: false })],
      resolverOptions(),
    ),
    {
      ok: false,
      code: "route_snapshot_route_missing",
    },
  );
});

test("resolveRouteSnapshot rejects every critical old-route drift instead of reusing the same ID", async (t) => {
  const snapshot = createRouteSnapshot(safeRoute(), {
    contextPolicy: CONTEXT_POLICY,
    compactContract: COMPACT_CONTRACT,
  });
  const cases = [
    ["provider", safeRoute({ provider: "openai" }), "route_snapshot_provider_changed"],
    ["api", safeRoute({ api: "responses" }), "route_snapshot_api_changed"],
    ["model", safeRoute({ model: "deepseek-replacement" }), "route_snapshot_model_changed"],
    [
      "baseUrl",
      safeRoute({ baseUrl: "https://replacement.example/v1" }),
      "route_snapshot_base_url_changed",
    ],
    [
      "authMode",
      safeRoute({ authMode: "codex_openai", apiKeyEnv: "" }),
      "route_snapshot_auth_mode_changed",
    ],
    [
      "apiKeyEnv",
      safeRoute({ apiKeyEnv: "REPLACEMENT_API_KEY" }),
      "route_snapshot_api_key_env_changed",
    ],
    [
      "dropParams",
      safeRoute({ dropParams: ["response_format"] }),
      "route_snapshot_drop_params_changed",
    ],
  ];

  for (const [name, changedRoute, code] of cases) {
    await t.test(name, () => {
      assert.deepEqual(
        resolveRouteSnapshot(
          snapshot,
          [
            changedRoute,
            safeRoute({ id: "new-default", model: "new-default-model" }),
          ],
          resolverOptions(),
        ),
        { ok: false, code },
      );
    });
  }
});

test("resolveRouteSnapshot rejects context-policy and compact-contract drift", () => {
  const currentRoute = safeRoute();
  const snapshot = createRouteSnapshot(currentRoute, {
    contextPolicy: CONTEXT_POLICY,
    compactContract: COMPACT_CONTRACT,
  });

  assert.equal(
    resolveRouteSnapshot(
      snapshot,
      [currentRoute],
      resolverOptions({
        contextPolicyForRoute: () => ({
          ...CONTEXT_POLICY,
          inputBudget: 120320,
          outputReserveTokens: 7680,
          effectiveContextWindowPercent: 94,
          truncationPolicy: {
            ...CONTEXT_POLICY.truncationPolicy,
            limit: 120320,
          },
        }),
      }),
    ).code,
    "route_snapshot_context_policy_changed",
  );
  assert.equal(
    resolveRouteSnapshot(
      snapshot,
      [currentRoute],
      resolverOptions({
        compactContractForRoute: () => ({
          ...COMPACT_CONTRACT,
          strategy: "replacement-strategy",
        }),
      }),
    ).code,
    "route_snapshot_compact_contract_changed",
  );
});

test("resolveRouteSnapshot rejects newly introduced inline credentials or custom headers", () => {
  const snapshot = createRouteSnapshot(safeRoute(), {
    contextPolicy: CONTEXT_POLICY,
    compactContract: COMPACT_CONTRACT,
  });

  assert.equal(
    resolveRouteSnapshot(
      snapshot,
      [safeRoute({ apiKey: "new-inline-secret" })],
      resolverOptions(),
    ).code,
    "route_snapshot_inline_credentials",
  );
  assert.equal(
    resolveRouteSnapshot(
      snapshot,
      [safeRoute({ extraHeaders: { authorization: "new-header-secret" } })],
      resolverOptions(),
    ).code,
    "route_snapshot_custom_headers_unsupported",
  );
});

test("validateRouteSnapshot rejects missing route identity and injected secret fields", () => {
  const snapshot = createRouteSnapshot(safeRoute(), {
    contextPolicy: CONTEXT_POLICY,
    compactContract: COMPACT_CONTRACT,
  });

  for (const field of [
    "id",
    "provider",
    "api",
    "model",
    "baseUrl",
    "authMode",
  ]) {
    assert.equal(
      validateRouteSnapshot({ ...snapshot, [field]: "" }).code,
      "route_snapshot_invalid",
      field,
    );
  }
  assert.equal(
    validateRouteSnapshot({ ...snapshot, apiKey: "injected-secret" }).code,
    "route_snapshot_secret_material",
  );
  assert.equal(
    validateRouteSnapshot({
      ...snapshot,
      contextPolicy: {
        ...snapshot.contextPolicy,
        authorization: "injected-secret",
      },
    }).code,
    "route_snapshot_secret_material",
  );
  assert.equal(
    validateRouteSnapshot({
      ...snapshot,
      compactContract: {
        ...snapshot.compactContract,
        headers: { authorization: "injected-secret" },
      },
    }).code,
    "route_snapshot_secret_material",
  );
});

test("validateRouteSnapshot verifies policy arithmetic and compact contract shape", () => {
  const snapshot = createRouteSnapshot(safeRoute(), {
    contextPolicy: CONTEXT_POLICY,
    compactContract: COMPACT_CONTRACT,
  });

  assert.equal(
    validateRouteSnapshot({
      ...snapshot,
      contextPolicy: {
        ...snapshot.contextPolicy,
        inputBudget: snapshot.contextPolicy.contextWindow + 1,
      },
    }).code,
    "route_snapshot_invalid_context_policy",
  );
  assert.equal(
    validateRouteSnapshot({
      ...snapshot,
      contextPolicy: {
        ...snapshot.contextPolicy,
        truncationPolicy: {
          ...snapshot.contextPolicy.truncationPolicy,
          limit: snapshot.contextPolicy.inputBudget - 1,
        },
      },
    }).code,
    "route_snapshot_invalid_context_policy",
  );
  assert.equal(
    validateRouteSnapshot({
      ...snapshot,
      compactContract: {
        ...snapshot.compactContract,
        requiresStream: "yes",
      },
    }).code,
    "route_snapshot_invalid_compact_contract",
  );
});

test("route snapshots accept a legitimate stricter truncation policy across create validate and resolve", () => {
  const strictRoute = safeRoute({
    contextWindow: 10_000,
    truncationPolicy: {
      mode: "tokens",
      limit: 7_000,
    },
  });
  const snapshot = createRouteSnapshot(strictRoute, {
    compactContract: COMPACT_CONTRACT,
  });

  assert.equal(snapshot.contextPolicy.inputBudget, 7_000);
  assert.equal(snapshot.contextPolicy.compactThreshold, 7_000);
  assert.equal(snapshot.contextPolicy.outputReserveTokens, 3_000);
  assert.deepEqual(validateRouteSnapshot(snapshot), { ok: true, snapshot });
  assert.deepEqual(
    resolveRouteSnapshot(snapshot, [strictRoute], {
      compactContractForRoute: () => COMPACT_CONTRACT,
    }),
    {
      ok: true,
      route: strictRoute,
      snapshot,
    },
  );
});

test("route snapshots still reject a forged truncation budget above the effective percentage", () => {
  const route = safeRoute({ contextWindow: 10_000 });
  const snapshot = createRouteSnapshot(route, {
    compactContract: COMPACT_CONTRACT,
  });
  const forgedPolicy = {
    ...snapshot.contextPolicy,
    inputBudget: 9_600,
    compactThreshold: 8_000,
    outputReserveTokens: 400,
    truncationPolicy: {
      mode: "tokens",
      limit: 9_600,
    },
  };

  assert.equal(
    validateRouteSnapshot({
      ...snapshot,
      contextPolicy: forgedPolicy,
    }).code,
    "route_snapshot_invalid_context_policy",
  );
});

test("validateRouteSnapshot enforces credential-source and auth-mode consistency", () => {
  const snapshot = createRouteSnapshot(safeRoute(), {
    contextPolicy: CONTEXT_POLICY,
    compactContract: COMPACT_CONTRACT,
  });

  assert.equal(
    validateRouteSnapshot({
      ...snapshot,
      credentialSource: "future-secret-store",
    }).code,
    "route_snapshot_credentials_unavailable",
  );
  assert.equal(
    validateRouteSnapshot({ ...snapshot, apiKeyEnv: "" }).code,
    "route_snapshot_credentials_unavailable",
  );
  assert.equal(
    validateRouteSnapshot({
      ...snapshot,
      authMode: "codex_openai",
      credentialSource: "environment",
    }).code,
    "route_snapshot_credentials_unavailable",
  );
});

test("resolveRouteSnapshot rejects ambiguous duplicate IDs", () => {
  const currentRoute = safeRoute();
  const snapshot = createRouteSnapshot(currentRoute, {
    contextPolicy: CONTEXT_POLICY,
    compactContract: COMPACT_CONTRACT,
  });

  assert.deepEqual(
    resolveRouteSnapshot(
      snapshot,
      [currentRoute, { ...currentRoute }],
      resolverOptions(),
    ),
    {
      ok: false,
      code: "route_snapshot_route_ambiguous",
    },
  );
});
