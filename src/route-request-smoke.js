export async function runRouteRequestSmoke(options = {}) {
  const {
    baseUrl,
    authToken = "",
    userAgent = "CodexBridge route request smoke",
    cases = defaultRouteRequestSmokeCases(),
    fetchImpl = globalThis.fetch,
  } = options;

  if (!baseUrl) {
    throw new TypeError("runRouteRequestSmoke requires baseUrl");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("runRouteRequestSmoke requires a fetch implementation");
  }

  const results = [];
  for (const item of cases) {
    const endpoint = caseEndpoint(baseUrl, item);
    results.push(await runOneCase(endpoint, item, { authToken, userAgent, fetchImpl }));
  }

  const passed = results.filter((result) => result.ok).length;
  const failed = results.length - passed;
  return {
    ok: failed === 0,
    summary: {
      total: results.length,
      passed,
      failed,
    },
    results,
  };
}

export function defaultRouteRequestSmokeCases() {
  return [
    {
      id: "stale-model-fallback",
      body: { model: "cb-removed-route", input: "route smoke stale model" },
      expect: { status: 200 },
    },
    {
      id: "codex-auxiliary-task",
      body: { model: "gpt-5.4-mini", input: "route smoke auxiliary task" },
      expect: { status: 200 },
    },
    {
      id: "image-generation-proxy",
      body: { input: "帮我生成一张测试图片" },
      expect: { status: 200 },
    },
  ];
}

function caseEndpoint(baseUrl, item = {}) {
  const path = String(item.endpointPath || item.path || "/v1/responses").trim() || "/v1/responses";
  return new URL(path.startsWith("/") ? path : `/${path}`, baseUrl).toString();
}

async function runOneCase(endpoint, item = {}, context = {}) {
  const startedAt = Date.now();
  const id = String(item.id || "unnamed");
  try {
    const response = await context.fetchImpl(endpoint, {
      method: "POST",
      headers: requestHeaders(item.headers, context),
      body: JSON.stringify(item.body || {}),
    });
    const text = await response.text();
    const json = parseJson(text);
    const checks = evaluateExpectations(item.expect || {}, {
      response,
      text,
      json,
    });
    const ok = checks.every((check) => check.ok);
    return {
      id,
      ok,
      status: response.status,
      durationMs: Date.now() - startedAt,
      checks,
      outputText: json?.output_text || "",
      errorCode: json?.error?.code || "",
      smartFailover: json?.codexbridge_smart_failover || null,
    };
  } catch (error) {
    return {
      id,
      ok: false,
      status: 0,
      durationMs: Date.now() - startedAt,
      checks: [
        {
          name: "request",
          ok: false,
          message: error?.message || String(error),
        },
      ],
      outputText: "",
      errorCode: "",
    };
  }
}

function requestHeaders(extraHeaders = {}, context = {}) {
  const headers = {
    "content-type": "application/json",
    ...extraHeaders,
  };
  if (context.authToken) {
    headers.authorization = `Bearer ${context.authToken}`;
  }
  if (context.userAgent) {
    headers["user-agent"] = context.userAgent;
  }
  return headers;
}

function evaluateExpectations(expect = {}, result = {}) {
  const checks = [];
  const expectedStatus = Number(expect.status || 200);
  checks.push({
    name: "status",
    ok: result.response.status === expectedStatus,
    message: `expected HTTP ${expectedStatus}, got HTTP ${result.response.status}`,
  });

  if (expect.outputTextIncludes) {
    const outputText = String(result.json?.output_text || result.text || "");
    checks.push({
      name: "outputTextIncludes",
      ok: outputText.includes(expect.outputTextIncludes),
      message: `expected output_text to include ${expect.outputTextIncludes}`,
    });
  }

  if (expect.errorCode) {
    const actualCode = String(result.json?.error?.code || "");
    checks.push({
      name: "errorCode",
      ok: actualCode === expect.errorCode,
      message: `expected error code ${expect.errorCode}, got ${actualCode}`,
    });
  }

  for (const expectedText of stringList(expect.bodyIncludes)) {
    checks.push({
      name: `bodyIncludes:${expectedText}`,
      ok: String(result.text || "").includes(expectedText),
      message: `expected response body to include ${expectedText}`,
    });
  }

  for (const forbiddenText of stringList(expect.bodyExcludes)) {
    checks.push({
      name: `bodyExcludes:${forbiddenText}`,
      ok: !String(result.text || "").includes(forbiddenText),
      message: `expected response body not to include ${forbiddenText}`,
    });
  }

  const pathChecks = expect.jsonPathEquals && typeof expect.jsonPathEquals === "object"
    ? expect.jsonPathEquals
    : {};
  for (const [path, expected] of Object.entries(pathChecks)) {
    const actual = readJsonPath(result.json, path);
    checks.push({
      name: `jsonPathEquals:${path}`,
      ok: Object.is(actual, expected),
      message: `expected ${path} to equal ${expected}, got ${actual}`,
    });
  }

  return checks;
}

function stringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean);
  }
  if (value === undefined || value === null || value === "") {
    return [];
  }
  return [String(value)];
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readJsonPath(value, path) {
  return String(path || "")
    .split(".")
    .filter(Boolean)
    .reduce((current, key) => {
      if (!current || typeof current !== "object") {
        return undefined;
      }
      return current[key];
    }, value);
}
