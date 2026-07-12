import test from "node:test";
import assert from "node:assert/strict";

import {
  createPendingRequestGuard,
  fingerprintPendingRequest,
} from "../src/pending-request-guard.js";

function exactRequest(overrides = {}) {
  return {
    configRevision: "config-revision-1",
    requestSurface: "responses",
    route: {
      id: "route-primary",
      provider: "openai",
      api: "responses",
      model: "gpt-5.5",
      baseUrl: "https://api.example.test/v1",
      authMode: "api_key",
      apiKeyEnv: "OPENAI_API_KEY",
    },
    compactKind: "none",
    headers: {
      "x-codex-thread-id": "thread-1",
      "x-codex-window-id": "window-1",
      "x-codex-turn-state": "running",
      "x-codex-turn-metadata": JSON.stringify({ turn_id: "turn-1" }),
      "x-client-request-id": "client-request-1",
    },
    requestBody: {
      model: "gpt-5.5",
      input: [{ role: "user", content: "finish the exact task" }],
      stream: true,
    },
    ...overrides,
  };
}

function beginProtected(guard, input = exactRequest()) {
  return guard.begin(input, { enabled: true });
}

test("explicit duplicate protection creates one owner and four pending duplicates", () => {
  const guard = createPendingRequestGuard();
  const results = Array.from({ length: 5 }, () => beginProtected(guard));

  assert.equal(results.filter((result) => result.status === "owner").length, 1);
  assert.equal(results.filter((result) => result.status === "duplicate").length, 4);
  assert.equal(guard.size(), 1);

  const owner = results.find((result) => result.status === "owner");
  assert.match(owner.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(typeof owner.ownershipToken, "string");
  assert.ok(owner.ownershipToken.length > 0);

  for (const duplicate of results.filter((result) => result.status === "duplicate")) {
    assert.equal(duplicate.protected, true);
    assert.equal(duplicate.reasonCode, "request_already_pending");
    assert.equal(duplicate.fingerprint, owner.fingerprint);
    assert.equal("ownershipToken" in duplicate, false);
  }
});

test("a long-running owner never expires by wall-clock age", () => {
  let now = 1_000;
  const guard = createPendingRequestGuard({ now: () => now });
  const owner = beginProtected(guard);

  now += 24 * 60 * 60 * 1_000;

  const duplicate = beginProtected(guard);
  assert.equal(owner.status, "owner");
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.fingerprint, owner.fingerprint);
  assert.equal(guard.size(), 1);
});

test("release requires the exact ownership token and an identical manual retry owns again", () => {
  const guard = createPendingRequestGuard();
  const first = beginProtected(guard);

  assert.equal(
    guard.release({ ...first, ownershipToken: "not-the-owner-token" }),
    false,
  );
  assert.equal(beginProtected(guard).status, "duplicate");
  assert.equal(guard.release(first), true);
  assert.equal(guard.size(), 0);
  assert.equal(guard.release(first), false);

  const retry = beginProtected(guard);
  assert.equal(retry.status, "owner");
  assert.equal(retry.fingerprint, first.fingerprint);
  assert.notEqual(retry.ownershipToken, first.ownershipToken);
});

test("capacity never evicts an active owner and bypasses only a different new key", () => {
  const guard = createPendingRequestGuard({ capacity: 1 });
  const first = beginProtected(guard);
  const different = beginProtected(guard, exactRequest({
    requestBody: { input: "a different request" },
  }));

  assert.equal(first.status, "owner");
  assert.deepEqual(
    {
      status: different.status,
      protected: different.protected,
      reasonCode: different.reasonCode,
    },
    {
      status: "capacity_bypass",
      protected: false,
      reasonCode: "pending_guard_capacity",
    },
  );
  assert.equal(guard.size(), 1);
  assert.equal(beginProtected(guard).status, "duplicate");
  assert.equal(guard.release(first), true);
});

test("disabled protection bypasses without hashing, token creation, or Map writes", () => {
  let tokensCreated = 0;
  const guard = createPendingRequestGuard({
    tokenFactory: () => {
      tokensCreated += 1;
      return `token-${tokensCreated}`;
    },
  });
  const request = exactRequest({
    route: {
      get apiKey() {
        throw new Error("disabled guard must not inspect credentials");
      },
    },
  });

  const first = guard.begin(request, { enabled: false });
  const second = guard.begin(request, { enabled: false });

  assert.deepEqual(first, {
    status: "disabled",
    protected: false,
    reasonCode: "duplicate_protection_disabled",
  });
  assert.deepEqual(second, first);
  assert.equal(tokensCreated, 0);
  assert.equal(guard.size(), 0);
});

test("missing duplicate protection enabled state bypasses fingerprinting and ownership", () => {
  let tokensCreated = 0;
  let routeReads = 0;
  const guard = createPendingRequestGuard({
    tokenFactory: () => {
      tokensCreated += 1;
      return `token-${tokensCreated}`;
    },
  });
  const request = exactRequest({
    route: new Proxy(exactRequest().route, {
      get(target, property, receiver) {
        routeReads += 1;
        return Reflect.get(target, property, receiver);
      },
    }),
  });
  const expected = {
    status: "disabled",
    protected: false,
    reasonCode: "duplicate_protection_disabled",
  };

  assert.deepEqual(guard.begin(request), expected);
  assert.deepEqual(guard.begin(request, {}), expected);
  assert.deepEqual(guard.begin(request, { enabled: false }), expected);
  assert.equal(routeReads, 0);
  assert.equal(tokensCreated, 0);
  assert.equal(guard.size(), 0);
});

test("separate guard instances never share pending ownership", () => {
  const firstGuard = createPendingRequestGuard();
  const secondGuard = createPendingRequestGuard();

  assert.equal(beginProtected(firstGuard).status, "owner");
  assert.equal(beginProtected(secondGuard).status, "owner");
  assert.equal(firstGuard.size(), 1);
  assert.equal(secondGuard.size(), 1);
});

test("fingerprints canonicalize object key order while preserving the complete body", () => {
  const first = fingerprintPendingRequest(exactRequest({
    requestBody: {
      z: true,
      input: [{ content: [{ text: "same", type: "input_text" }], role: "user" }],
      nested: { beta: 2, alpha: 1 },
    },
  }));
  const sameLogicalBody = fingerprintPendingRequest(exactRequest({
    requestBody: {
      nested: { alpha: 1, beta: 2 },
      input: [{ role: "user", content: [{ type: "input_text", text: "same" }] }],
      z: true,
    },
  }));
  const changedDeepValue = fingerprintPendingRequest(exactRequest({
    requestBody: {
      nested: { alpha: 1, beta: 3 },
      input: [{ role: "user", content: [{ type: "input_text", text: "same" }] }],
      z: true,
    },
  }));

  assert.equal(first, sameLogicalBody);
  assert.notEqual(first, changedDeepValue);
});

test("fingerprints include every non-secret route identity field, compact kind, and config revision", () => {
  const baselineRequest = exactRequest();
  const baseline = fingerprintPendingRequest(baselineRequest);
  const routeChanges = {
    id: "route-secondary",
    provider: "azure-openai",
    api: "chat_completions",
    model: "gpt-5.4",
    baseUrl: "https://second.example.test/v1",
    authMode: "codex_openai",
    apiKeyEnv: "SECOND_API_KEY",
  };

  for (const [field, value] of Object.entries(routeChanges)) {
    assert.notEqual(
      fingerprintPendingRequest(exactRequest({
        route: { ...baselineRequest.route, [field]: value },
      })),
      baseline,
      field,
    );
  }
  assert.notEqual(
    fingerprintPendingRequest(exactRequest({ compactKind: "responses-compact" })),
    baseline,
  );
  assert.notEqual(
    fingerprintPendingRequest(exactRequest({ configRevision: "config-revision-2" })),
    baseline,
  );
  assert.notEqual(
    fingerprintPendingRequest(exactRequest({ requestSurface: "chat_completions" })),
    baseline,
  );
});

test("fingerprints include relevant thread and turn headers case-insensitively", () => {
  const baseline = fingerprintPendingRequest(exactRequest());
  const upperCaseHeaders = Object.fromEntries(
    Object.entries(exactRequest().headers).map(([key, value]) => [key.toUpperCase(), value]),
  );

  assert.equal(
    fingerprintPendingRequest(exactRequest({ headers: upperCaseHeaders })),
    baseline,
  );
  assert.notEqual(
    fingerprintPendingRequest(exactRequest({
      headers: {
        ...exactRequest().headers,
        "x-codex-turn-metadata": JSON.stringify({ turn_id: "turn-2" }),
      },
    })),
    baseline,
  );
  assert.notEqual(
    fingerprintPendingRequest(exactRequest({
      headers: {
        ...exactRequest().headers,
        "x-client-request-id": "manual-retry-2",
      },
    })),
    baseline,
  );
});

test("fingerprints distinguish forwarded session and account identities", () => {
  const input = exactRequest();
  const first = fingerprintPendingRequest({
    ...input,
    headers: {
      "session-id": "session-a",
      "chatgpt-session-id": "chat-session-a",
      "chatgpt-account-id": "account-a",
    },
  });

  for (const [name, value] of [
    ["session-id", "session-b"],
    ["chatgpt-session-id", "chat-session-b"],
    ["chatgpt-account-id", "account-b"],
  ]) {
    assert.notEqual(
      first,
      fingerprintPendingRequest({
        ...input,
        headers: {
          "session-id": "session-a",
          "chatgpt-session-id": "chat-session-a",
          "chatgpt-account-id": "account-a",
          [name]: value,
        },
      }),
    );
  }
});

test("fingerprints never inspect Key values or authorization and cookie headers", () => {
  const route = exactRequest().route;
  const guardedRoute = {
    ...route,
    get apiKey() {
      throw new Error("apiKey must not be read");
    },
  };
  const first = fingerprintPendingRequest(exactRequest({
    route: guardedRoute,
    headers: {
      ...exactRequest().headers,
      authorization: "Bearer first-secret",
      cookie: "session=first-cookie-secret",
      "x-api-key": "first-header-key",
      "user-agent": "first-client",
    },
  }));
  const second = fingerprintPendingRequest(exactRequest({
    route: { ...route, apiKey: "second-inline-secret" },
    headers: {
      ...exactRequest().headers,
      authorization: "Bearer second-secret",
      cookie: "session=second-cookie-secret",
      "x-api-key": "second-header-key",
      "user-agent": "second-client",
    },
  }));

  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  for (const secret of [
    "first-secret",
    "first-cookie-secret",
    "first-header-key",
    "second-inline-secret",
    "second-secret",
    "second-cookie-secret",
    "second-header-key",
  ]) {
    assert.equal(first.includes(secret), false, secret);
  }
});

test("base URL credential values are excluded while non-secret URL identity remains exact", () => {
  const first = fingerprintPendingRequest(exactRequest({
    route: {
      ...exactRequest().route,
      baseUrl:
        "https://first-user:first-password@api.example.test/v1" +
        "?api_key=first-key&x-api-key=first-x-key&client_secret=first-client-secret" +
        "&accessToken=first-access-token&region=cn",
    },
  }));
  const changedSecrets = fingerprintPendingRequest(exactRequest({
    route: {
      ...exactRequest().route,
      baseUrl:
        "https://second-user:second-password@api.example.test/v1" +
        "?api_key=second-key&x-api-key=second-x-key&client_secret=second-client-secret" +
        "&accessToken=second-access-token&region=cn",
    },
  }));
  const changedIdentity = fingerprintPendingRequest(exactRequest({
    route: {
      ...exactRequest().route,
      baseUrl:
        "https://api.example.test/v1?api_key=third-key&x-api-key=third-x-key" +
        "&client_secret=third-client-secret&accessToken=third-access-token&region=us",
    },
  }));

  assert.equal(first, changedSecrets);
  assert.notEqual(first, changedIdentity);
});

test("a Key fix is admitted through config revision without putting either Key in the fingerprint", () => {
  const first = fingerprintPendingRequest(exactRequest({
    route: { ...exactRequest().route, apiKey: "stale-secret" },
  }));
  const keyOnlyChange = fingerprintPendingRequest(exactRequest({
    route: { ...exactRequest().route, apiKey: "corrected-secret" },
  }));
  const committedConfigChange = fingerprintPendingRequest(exactRequest({
    configRevision: "config-revision-after-key-fix",
    route: { ...exactRequest().route, apiKey: "corrected-secret" },
  }));

  assert.equal(keyOnlyChange, first);
  assert.notEqual(committedConfigChange, first);
  assert.equal(first.includes("stale-secret"), false);
  assert.equal(committedConfigChange.includes("corrected-secret"), false);
});

test("snapshot exposes only bounded safe diagnostics and never ownership or request data", () => {
  const secretBody = "body-secret-that-must-not-be-stored";
  const secretKey = "inline-secret-that-must-not-be-stored";
  const guard = createPendingRequestGuard({ capacity: 2, now: () => 123_456 });
  const owner = beginProtected(guard, exactRequest({
    configRevision: `revision-${"r".repeat(500)}`,
    route: {
      ...exactRequest().route,
      id: `route-${"x".repeat(500)}`,
      apiKey: secretKey,
    },
    requestBody: { input: secretBody },
  }));
  const snapshot = guard.snapshot();

  assert.equal(snapshot.length, 1);
  assert.match(snapshot[0].fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(snapshot[0].startedAt, 123_456);
  assert.ok(snapshot[0].metadata.configRevision.length <= 160);
  assert.ok(snapshot[0].metadata.routeId.length <= 160);
  assert.equal("ownershipToken" in snapshot[0], false);

  const serialized = JSON.stringify({ owner, snapshot });
  assert.equal(serialized.includes(secretBody), false);
  assert.equal(serialized.includes(secretKey), false);
  assert.equal(serialized.includes("x-codex-thread-id"), false);
  assert.equal(serialized.includes("thread-1"), false);
});
