import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  __resetUpstreamFailureCacheForTests,
  callJsonUpstream,
  proxyResponsesApi,
  sendUpstreamError,
  UpstreamHttpError,
} from "../src/upstream.js";
import * as upstreamModule from "../src/upstream.js";
import {
  __resetRateLimiterForTests,
  __setRateLimitClockForTests,
} from "../src/rate-limit.js";
import {
  proxySettingsForUrl,
} from "../src/proxy.js";

test("default upstream and streaming proxy header timeouts are both 600 seconds", () => {
  assert.equal(typeof upstreamModule.upstreamTimeoutMs, "function");
  assert.equal(typeof upstreamModule.streamingProxyFetchOptions, "function");
  assert.equal(upstreamModule.upstreamTimeoutMs({}), 600000);
  assert.equal(
    upstreamModule.streamingProxyFetchOptions({}, { streamingResponse: true }, true).timeoutMs,
    600000,
  );
});

test("upstream requests use HTTPS proxy dispatcher when configured", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = snapshotProxyEnv();
  let seenInit = null;

  globalThis.fetch = async (_url, init) => {
    seenInit = init;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    clearProxyEnv();
    process.env.HTTPS_PROXY = "http://127.0.0.1:7890";

    await callJsonUpstream(
      "https://api.openai.com/v1/chat/completions",
      {
        id: "gpt-5.5",
        api: "chat_completions",
        model: "gpt-5.5",
        apiKey: "test-key",
      },
      { model: "gpt-5.5" },
      {},
    );

    assert.ok(seenInit?.dispatcher, "expected fetch init to include proxy dispatcher");
  } finally {
    globalThis.fetch = originalFetch;
    restoreProxyEnv(originalEnv);
  }
});

test("upstream requests refresh a failed proxy connection before retrying direct", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = snapshotProxyEnv();
  const calls = [];

  globalThis.fetch = async (_url, init) => {
    calls.push(Boolean(init?.dispatcher));
    if (init?.dispatcher) {
      const error = new TypeError("fetch failed");
      error.cause = { code: "UND_ERR_SOCKET" };
      throw error;
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    clearProxyEnv();
    process.env.HTTPS_PROXY = "http://127.0.0.1:7890";

    const response = await callJsonUpstream(
      "https://api.deepseek.com/v1/chat/completions",
      {
        id: "deepseek-v4-flash",
        api: "chat_completions",
        model: "deepseek-v4-flash",
        apiKey: "test-key",
      },
      { model: "deepseek-v4-flash" },
      {},
    );

    assert.deepEqual(calls, [true, true, false]);
    assert.deepEqual(response, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
    restoreProxyEnv(originalEnv);
  }
});

test("streaming ChatGPT requests refresh a stalled proxy connection before the route timeout", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = snapshotProxyEnv();
  const dispatchers = [];

  globalThis.fetch = async (_url, init) => {
    dispatchers.push(init?.dispatcher || null);
    if (dispatchers.length === 1) {
      return new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    }
    return new Response(
      [
        "event: response.completed",
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_proxy_refresh",
            status: "completed",
            model: "gpt-5.6-sol",
            output: [],
          },
        })}`,
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
      {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      },
    );
  };

  try {
    clearProxyEnv();
    process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
    const res = collectResponse();

    await proxyResponsesApi(
      { model: "gpt-5.6-sol", input: "run delegated task", stream: true },
      {
        id: "cb-gpt-5-6-sol",
        displayName: "GPT-5.6-Sol",
        api: "responses",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.6-sol",
        authMode: "codex_openai",
        upstreamTimeoutMs: 200,
        proxyHeaderTimeoutMs: 20,
      },
      res,
      {
        clientAuth: { kind: "codex_openai", bearerToken: "codex-openai-token" },
      },
    );

    assert.equal(res.statusCode, 200);
    assert.match(res.body(), /resp_proxy_refresh/);
    assert.equal(dispatchers.length, 2);
    assert.ok(dispatchers[0]);
    assert.ok(dispatchers[1]);
    assert.notEqual(dispatchers[0], dispatchers[1]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreProxyEnv(originalEnv);
  }
});

test("callJsonUpstream preserves Retry-After headers on HTTP errors", async () => {
  const upstream = httpServer(async (_req, res) => {
    res.writeHead(429, {
      "content-type": "application/json",
      "retry-after": "42",
    });
    res.end(JSON.stringify({ error: { message: "Too many requests" } }));
  });

  await listen(upstream);
  try {
    await assert.rejects(
      callJsonUpstream(
        `${serverUrl(upstream)}/v1/images/generations`,
        {
          id: "image-rate-limit-retry-after",
          api: "images",
          model: "Kwai-Kolors/Kolors",
          apiKey: "test-key",
        },
        { prompt: "draw a cat" },
        {},
      ),
      (error) => {
        assert.equal(error.statusCode, 429);
        assert.equal(error.retryAfter, "42");
        return true;
      },
    );
  } finally {
    __resetRateLimiterForTests();
    __resetUpstreamFailureCacheForTests();
    await close(upstream);
  }
});

test("sendUpstreamError explains common provider HTTP failures in Chinese", () => {
  const route = {
    id: "cb-kimi-k2-code",
    displayName: "Kimi K2 Code",
    model: "kimi-k2-code",
    api: "chat_completions",
  };
  const cases = [
    {
      statusCode: 401,
      bodyText: JSON.stringify({ error: { message: "Incorrect API key provided" } }),
      code: "upstream_authentication_error",
      includes: [/Kimi K2 Code/, /API Key|认证|权限/, /报错信息：HTTP 401 - Incorrect API key provided/],
      excludes: [/CodexBridge upstream error/],
    },
    {
      statusCode: 402,
      bodyText: JSON.stringify({ error: { message: "Insufficient Balance" } }),
      code: "upstream_billing_error",
      includes: [/Kimi K2 Code/, /余额|额度|账户/, /报错信息：HTTP 402 - Insufficient Balance/],
      excludes: [/CodexBridge upstream error/],
    },
    {
      statusCode: 429,
      bodyText: JSON.stringify({ error: { message: "Too Many Requests" } }),
      code: "upstream_rate_limit",
      includes: [/Kimi K2 Code/, /供应商限流|请求过快|稍后/, /报错信息：HTTP 429 - Too Many Requests/],
      excludes: [/CodexBridge upstream error/],
    },
    {
      statusCode: 502,
      bodyText:
        "<!DOCTYPE html><html><head><title>ciyuan.fast | 502: Bad gateway</title></head></html>",
      code: "upstream_provider_unavailable",
      includes: [/Kimi K2 Code/, /供应商服务|网关|不可用/, /报错信息：HTTP 502 - ciyuan\.fast \| 502: Bad gateway/],
      excludes: [/CodexBridge upstream error/, /<html/i, /<!DOCTYPE/i],
    },
    {
      statusCode: 413,
      bodyText: JSON.stringify({ error: { message: "Payload Too Large" } }),
      code: "upstream_payload_too_large",
      includes: [/Kimi K2 Code/, /请求内容太大|上下文|压缩|新会话/, /报错信息：HTTP 413 - Payload Too Large/],
      excludes: [/CodexBridge upstream request is too large/],
    },
  ];

  for (const item of cases) {
    const res = collectResponse();
    sendUpstreamError(
      res,
      new UpstreamHttpError(
        item.statusCode,
        item.bodyText,
        "https://api.example.test/v1/chat/completions",
        route,
      ),
    );
    const body = JSON.parse(res.body());

    assert.equal(res.statusCode, item.statusCode);
    assert.equal(body.error.code, item.code);
    for (const pattern of item.includes) {
      assert.match(body.error.message, pattern);
    }
    for (const pattern of item.excludes) {
      assert.doesNotMatch(body.error.message, pattern);
    }
  }
});

test("upstream requests ignore unsupported SOCKS proxy URLs", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = snapshotProxyEnv();
  let seenInit = null;

  globalThis.fetch = async (_url, init) => {
    seenInit = init;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    clearProxyEnv();
    process.env.HTTPS_PROXY = "socks5://127.0.0.1:10808";

    await callJsonUpstream(
      "https://api.deepseek.com/v1/chat/completions",
      {
        id: "deepseek-v4-flash",
        api: "chat_completions",
        model: "deepseek-v4-flash",
        apiKey: "test-key",
      },
      { model: "deepseek-v4-flash" },
      {},
    );

    assert.equal(Boolean(seenInit?.dispatcher), false);
  } finally {
    globalThis.fetch = originalFetch;
    restoreProxyEnv(originalEnv);
  }
});

test("proxySettingsForUrl reads macOS HTTPS system proxy settings", () => {
  const result = proxySettingsForUrl(
    "https://api.openai.com/v1/responses",
    {},
    {
      platform: "darwin",
      macosProxySettings: {
        httpEnable: false,
        httpProxy: "",
        httpPort: 0,
        httpsEnable: true,
        httpsProxy: "127.0.0.1",
        httpsPort: 7890,
        exceptions: ["localhost", "127.0.0.1", "*.local"],
      },
    },
  );

  assert.deepEqual(result, {
    source: "macos",
    url: "http://127.0.0.1:7890",
  });
  assert.equal(
    proxySettingsForUrl("https://localhost/v1/responses", {}, {
      platform: "darwin",
      macosProxySettings: {
        httpsEnable: true,
        httpsProxy: "127.0.0.1",
        httpsPort: 7890,
        exceptions: ["localhost"],
      },
    }),
    null,
  );
});

test("upstream requests honor per-route rpm before calling providers", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const sleeps = [];
  const logs = [];
  let now = 0;
  let calls = 0;

  console.log = (line) => logs.push(String(line));
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  __resetRateLimiterForTests();
  __setRateLimitClockForTests({
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });

  try {
    const route = {
      id: "kimi-k2.7-code",
      api: "chat_completions",
      model: "kimi-k2.7-code",
      apiKey: "test-key",
      rpm: 60,
    };

    await callJsonUpstream(
      "https://api.moonshot.cn/v1/chat/completions",
      route,
      { model: "kimi-k2.7-code" },
      { requestId: "req_rpm_pacing" },
    );
    await callJsonUpstream(
      "https://api.moonshot.cn/v1/chat/completions",
      route,
      { model: "kimi-k2.7-code" },
      { requestId: "req_rpm_pacing" },
    );

    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [1000]);
    assert.equal(
      logs.some((line) => /rate-limit-pacing route=kimi-k2\.7-code next_after_ms=1000/.test(line)),
      true,
    );
    assert.equal(
      logs.some((line) => / rate-limit route=kimi-k2\.7-code next_after_ms=1000/.test(line)),
      false,
    );
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    __resetRateLimiterForTests();
  }
});

test("upstream requests ignore legacy default Kimi rpm throttling", async () => {
  const originalFetch = globalThis.fetch;
  const sleeps = [];
  let now = 0;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  __resetRateLimiterForTests();
  __setRateLimitClockForTests({
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });

  try {
    const legacyKimiRoute = {
      id: "cb-kimi-k2-7-code",
      provider: "kimi",
      api: "chat_completions",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "kimi-k2.7-code",
      apiKey: "test-key",
      localRateLimitEnabled: true,
      rpm: 12,
    };

    await callJsonUpstream(
      "https://api.moonshot.cn/v1/chat/completions",
      legacyKimiRoute,
      { model: "kimi-k2.7-code" },
      {},
    );
    await callJsonUpstream(
      "https://api.moonshot.cn/v1/chat/completions",
      legacyKimiRoute,
      { model: "kimi-k2.7-code" },
      {},
    );

    assert.equal(calls, 2);
    assert.deepEqual(sleeps, []);
  } finally {
    globalThis.fetch = originalFetch;
    __resetRateLimiterForTests();
  }
});

test("upstream requests still honor explicit nested Kimi rate limits", async () => {
  const originalFetch = globalThis.fetch;
  const sleeps = [];
  let now = 0;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  __resetRateLimiterForTests();
  __setRateLimitClockForTests({
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });

  try {
    const route = {
      id: "cb-kimi-k2-7-code",
      provider: "kimi",
      api: "chat_completions",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "kimi-k2.7-code",
      apiKey: "test-key",
      rateLimit: { rpm: 12 },
    };

    await callJsonUpstream(
      "https://api.moonshot.cn/v1/chat/completions",
      route,
      { model: "kimi-k2.7-code" },
      {},
    );
    await callJsonUpstream(
      "https://api.moonshot.cn/v1/chat/completions",
      route,
      { model: "kimi-k2.7-code" },
      {},
    );

    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [5000]);
  } finally {
    globalThis.fetch = originalFetch;
    __resetRateLimiterForTests();
  }
});

test("upstream 429 response waits through route cooldown when local rate limiting is enabled", async () => {
  const originalFetch = globalThis.fetch;
  const sleeps = [];
  let now = 0;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: "Too Many Requests" } }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "2",
        },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  __resetRateLimiterForTests();
  __setRateLimitClockForTests({
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });

  try {
    const route = {
      id: "deepseek-v4-pro",
      api: "chat_completions",
      model: "deepseek-v4-pro",
      apiKey: "test-key",
      localRateLimitEnabled: true,
    };

    await assert.rejects(
      callJsonUpstream(
        "https://api.deepseek.com/v1/chat/completions",
        route,
        {
          model: "deepseek-v4-pro",
          messages: [{ role: "user", content: "first turn" }],
        },
        {},
      ),
      /Upstream returned HTTP 429/,
    );

    const response = await callJsonUpstream(
      "https://api.deepseek.com/v1/chat/completions",
      route,
      {
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "next turn" }],
      },
      {},
    );

    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [2000]);
    assert.deepEqual(response, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
    __resetRateLimiterForTests();
  }
});

test("upstream 429 keeps provider cooldown while local pacing is disabled", async () => {
  const originalFetch = globalThis.fetch;
  const sleeps = [];
  let now = 0;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: "Too Many Requests" } }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "2",
        },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  __resetRateLimiterForTests();
  __setRateLimitClockForTests({
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });

  try {
    const route = {
      id: "deepseek-v4-pro",
      api: "chat_completions",
      model: "deepseek-v4-pro",
      apiKey: "test-key",
      localRateLimitEnabled: false,
      rpm: 60,
    };

    await assert.rejects(
      callJsonUpstream(
        "https://api.deepseek.com/v1/chat/completions",
        route,
        {
          model: "deepseek-v4-pro",
          messages: [{ role: "user", content: "first turn" }],
        },
        {},
      ),
      /Upstream returned HTTP 429/,
    );

    const response = await callJsonUpstream(
      "https://api.deepseek.com/v1/chat/completions",
      route,
      {
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "normal retry" }],
      },
      {},
    );

    const immediateNextResponse = await callJsonUpstream(
      "https://api.deepseek.com/v1/chat/completions",
      route,
      {
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "next request without local pacing" }],
      },
      {},
    );

    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [2000]);
    assert.deepEqual(response, { ok: true });
    assert.deepEqual(immediateNextResponse, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
    __resetRateLimiterForTests();
  }
});

test("upstream 429 waits through relaxed local cooldown when local rate limiting is enabled", async () => {
  const originalFetch = globalThis.fetch;
  const sleeps = [];
  let now = 0;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: "Too Many Requests" } }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "2",
        },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  __resetRateLimiterForTests();
  __setRateLimitClockForTests({
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });

  try {
    const route = {
      id: "deepseek-v4-pro",
      api: "chat_completions",
      model: "deepseek-v4-pro",
      apiKey: "test-key",
      localRateLimitEnabled: true,
    };

    await assert.rejects(
      callJsonUpstream(
        "https://api.deepseek.com/v1/chat/completions",
        route,
        {
          model: "deepseek-v4-pro",
          messages: [{ role: "user", content: "first turn" }],
        },
        {},
      ),
      /Upstream returned HTTP 429/,
    );

    const response = await callJsonUpstream(
      "https://api.deepseek.com/v1/chat/completions",
      route,
      {
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "normal retry" }],
      },
      {},
    );

    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [2000]);
    assert.deepEqual(response, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
    __resetRateLimiterForTests();
  }
});

test("upstream retry-after cooldown is capped to avoid long local waits", async () => {
  const originalFetch = globalThis.fetch;
  const sleeps = [];
  let now = 0;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: "Too Many Requests" } }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "36000",
        },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  __resetRateLimiterForTests();
  __setRateLimitClockForTests({
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });

  try {
    const route = {
      id: "kimi-k2.7-code",
      provider: "kimi",
      api: "chat_completions",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "kimi-k2.7-code",
      apiKey: "test-key",
      localRateLimitEnabled: true,
    };

    await assert.rejects(
      callJsonUpstream(
        "https://api.moonshot.cn/v1/chat/completions",
        route,
        {
          model: "kimi-k2.7-code",
          messages: [{ role: "user", content: "first turn" }],
        },
        {},
      ),
      /Upstream returned HTTP 429/,
    );

    const response = await callJsonUpstream(
      "https://api.moonshot.cn/v1/chat/completions",
      route,
      {
        model: "kimi-k2.7-code",
        messages: [{ role: "user", content: "second turn" }],
      },
      {},
    );

    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [120_000]);
    assert.deepEqual(response, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
    __resetRateLimiterForTests();
  }
});

test("provider cooldown does not extend Retry-After for the same payload", async () => {
  const originalFetch = globalThis.fetch;
  let now = 0;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: "Too Many Requests" } }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "2",
        },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  __resetUpstreamFailureCacheForTests();
  __resetRateLimiterForTests();
  __setRateLimitClockForTests({
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });

  try {
    const route = {
      id: "deepseek-v4-pro",
      provider: "deepseek",
      api: "chat_completions",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4-pro",
      apiKey: "test-key",
    };
    const payload = {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "same retryable turn" }],
    };

    await assert.rejects(
      callJsonUpstream(
        "https://api.deepseek.com/v1/chat/completions",
        route,
        payload,
        {},
      ),
      /Upstream returned HTTP 429/,
    );

    now = 2000;
    const response = await callJsonUpstream(
      "https://api.deepseek.com/v1/chat/completions",
      route,
      payload,
      {},
    );

    assert.equal(calls, 2);
    assert.deepEqual(response, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
    __resetUpstreamFailureCacheForTests();
    __resetRateLimiterForTests();
  }
});

test("upstream 429 cooldown waits across routes using the same provider key", async () => {
  const originalFetch = globalThis.fetch;
  const sleeps = [];
  let now = 0;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: "Too Many Requests" } }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "3",
        },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  __resetRateLimiterForTests();
  __setRateLimitClockForTests({
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });

  try {
    const shared = {
      provider: "deepseek",
      api: "chat_completions",
      baseUrl: "https://api.deepseek.com/v1",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      apiKey: "test-key",
      localRateLimitEnabled: true,
    };
    const proRoute = {
      ...shared,
      id: "deepseek-v4-pro",
      model: "deepseek-v4-pro",
    };
    const flashRoute = {
      ...shared,
      id: "deepseek-v4-flash",
      model: "deepseek-v4-flash",
    };

    await assert.rejects(
      callJsonUpstream(
        "https://api.deepseek.com/v1/chat/completions",
        proRoute,
        { model: "deepseek-v4-pro" },
        {},
      ),
      /Upstream returned HTTP 429/,
    );

    const response = await callJsonUpstream(
      "https://api.deepseek.com/v1/chat/completions",
      flashRoute,
      { model: "deepseek-v4-flash" },
      {},
    );

    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [3000]);
    assert.deepEqual(response, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
    __resetRateLimiterForTests();
  }
});

test("transient upstream 503 failures are not cached for identical retries", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: "temporary overload" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  __resetUpstreamFailureCacheForTests();
  __resetRateLimiterForTests();

  try {
    const route = {
      id: "agnes-flash",
      provider: "openrouter",
      api: "chat_completions",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "agnes-2.0-flash",
      apiKey: "test-key",
    };
    const payload = {
      model: "agnes-2.0-flash",
      messages: [{ role: "user", content: "same transient turn" }],
    };

    await assert.rejects(
      callJsonUpstream(
        "https://openrouter.ai/api/v1/chat/completions",
        route,
        payload,
        {},
      ),
      /Upstream returned HTTP 503/,
    );

    const response = await callJsonUpstream(
      "https://openrouter.ai/api/v1/chat/completions",
      route,
      payload,
      {},
    );

    assert.equal(calls, 2);
    assert.deepEqual(response, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
    __resetUpstreamFailureCacheForTests();
    __resetRateLimiterForTests();
  }
});

test("identical fatal upstream failures are retried after the first call completes", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: "invalid parameter" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  };

  __resetUpstreamFailureCacheForTests();
  __resetRateLimiterForTests();

  try {
    const route = {
      id: "kimi-k2.7-code",
      provider: "kimi",
      api: "chat_completions",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "kimi-k2.7-code",
      apiKeyEnv: "MOONSHOT_API_KEY",
      apiKey: "test-key",
    };
    const payload = {
      model: "kimi-k2.7-code",
      messages: [{ role: "user", content: "hello" }],
    };

    await assert.rejects(
      callJsonUpstream(
        "https://api.moonshot.cn/v1/chat/completions",
        route,
        payload,
        { requestId: "req_first" },
      ),
      /Upstream returned HTTP 400/,
    );

    await assert.rejects(
      callJsonUpstream(
        "https://api.moonshot.cn/v1/chat/completions",
        route,
        payload,
        { requestId: "req_retry" },
      ),
      /Upstream returned HTTP 400/,
    );

    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    __resetUpstreamFailureCacheForTests();
    __resetRateLimiterForTests();
  }
});

test("a different user turn reaches upstream after a completed failure", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: "bad request" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  __resetUpstreamFailureCacheForTests();
  __resetRateLimiterForTests();

  try {
    const route = {
      id: "kimi-k2.7-code",
      provider: "kimi",
      api: "chat_completions",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "kimi-k2.7-code",
      apiKey: "test-key",
    };

    await assert.rejects(
      callJsonUpstream(
        "https://api.moonshot.cn/v1/chat/completions",
        route,
        {
          model: "kimi-k2.7-code",
          messages: [{ role: "user", content: "bad turn" }],
        },
        {},
      ),
      /Upstream returned HTTP 400/,
    );

    const response = await callJsonUpstream(
      "https://api.moonshot.cn/v1/chat/completions",
      route,
      {
        model: "kimi-k2.7-code",
        messages: [{ role: "user", content: "next turn" }],
      },
      {},
    );

    assert.deepEqual(response, { ok: true });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    __resetUpstreamFailureCacheForTests();
    __resetRateLimiterForTests();
  }
});

test("codex_openai responses use ChatGPT Codex backend and forward Codex headers", async () => {
  const originalBackend = process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL;
  let seenRequest = null;

  const upstream = httpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    seenRequest = {
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    };
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.write("event: response.output_text.delta\n");
    res.write(
      `data: ${JSON.stringify({
        type: "response.output_text.delta",
        delta: "hello from subscription",
      })}\n\n`,
    );
    res.write("event: response.completed\n");
    res.write(
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_subscription",
          status: "completed",
          model: "gpt-5.5",
          output: [],
        },
      })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });

  try {
    await listen(upstream);
    process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL = `${serverUrl(upstream)}/backend-api/codex`;

    const res = collectResponse();
    await proxyResponsesApi(
      {
        model: "gpt-5.5",
        input: "hello",
        stream: true,
      },
      {
        id: "gpt-5.5",
        api: "responses",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.5",
        authMode: "codex_openai",
      },
      res,
      {
        clientAuth: {
          kind: "codex_openai",
          bearerToken: "codex-openai-token",
        },
        clientHeaders: {
          "user-agent": "Codex Desktop/0.142.3 (Mac OS 27.0.0; arm64)",
          "chatgpt-account-id": "acct_123",
          "chatgpt-session-id": "chatgpt_sess_123",
          "session-id": "sess_123",
          "thread-id": "thread_123",
          "x-openai-client-user-agent": "codex-desktop-test",
          "x-openai-device-id": "device_123",
          "x-oai-sentinel": "sentinel_123",
          "x-codex-turn-state": "sticky_123",
          "x-codex-beta-features": "feature-a",
          "x-codex-new-runtime-header": "runtime_123",
          "openai-sentinel-chat-requirements-token": "requirements_123",
        },
      },
    );

    assert.equal(seenRequest.url, "/backend-api/codex/responses");
    assert.equal(seenRequest.headers.authorization, "Bearer codex-openai-token");
    assert.equal(seenRequest.headers.accept, "text/event-stream");
    assert.equal(seenRequest.headers["user-agent"], "Codex Desktop/0.142.3 (Mac OS 27.0.0; arm64)");
    assert.equal(seenRequest.headers["chatgpt-account-id"], "acct_123");
    assert.equal(seenRequest.headers["chatgpt-session-id"], "chatgpt_sess_123");
    assert.equal(seenRequest.headers["session-id"], "sess_123");
    assert.equal(seenRequest.headers["thread-id"], "thread_123");
    assert.equal(seenRequest.headers["x-openai-client-user-agent"], "codex-desktop-test");
    assert.equal(seenRequest.headers["x-openai-device-id"], "device_123");
    assert.equal(seenRequest.headers["x-oai-sentinel"], "sentinel_123");
    assert.equal(seenRequest.headers["x-codex-turn-state"], "sticky_123");
    assert.equal(seenRequest.headers["x-codex-beta-features"], "feature-a");
    assert.equal(seenRequest.headers["x-codex-new-runtime-header"], "runtime_123");
    assert.equal(seenRequest.headers["openai-sentinel-chat-requirements-token"], "requirements_123");
    assert.equal(JSON.parse(seenRequest.body).model, "gpt-5.5");
    assert.match(res.body(), /hello from subscription/);
  } finally {
    if (originalBackend === undefined) {
      delete process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL;
    } else {
      process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL = originalBackend;
    }
    await close(upstream);
  }
});

test("codex_openai keeps explicit gpt-5.6-sol and surfaces account rejection without silent aliasing", async () => {
  const originalBackend = process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL;
  const seenModels = [];

  const upstream = httpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    seenModels.push(body.model);

    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({
      detail: "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
    }));
  });

  try {
    await listen(upstream);
    process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL = `${serverUrl(upstream)}/backend-api/codex`;

    await assert.rejects(
      proxyResponsesApi(
        {
          model: "gpt-5.6-sol",
          input: "hello",
          stream: true,
        },
        {
          id: "cb-gpt-5-6-sol",
          displayName: "GPT-5.6-Sol",
          api: "responses",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-5.6-sol",
          authMode: "codex_openai",
        },
        collectResponse(),
        {
          clientAuth: {
            kind: "codex_openai",
            bearerToken: "codex-openai-token",
          },
        },
      ),
      (error) => error instanceof UpstreamHttpError && error.statusCode === 400,
    );

    assert.deepEqual(seenModels, ["gpt-5.6-sol"]);
  } finally {
    await close(upstream);
    if (originalBackend === undefined) {
      delete process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL;
    } else {
      process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL = originalBackend;
    }
  }
});

test("codex_openai sends the explicitly selected generic gpt-5.6 model unchanged", async () => {
  const originalBackend = process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL;
  const seenModels = [];
  const upstream = httpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seenModels.push(JSON.parse(Buffer.concat(chunks).toString("utf8")).model);
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.write("event: response.completed\n");
    res.write(`data: ${JSON.stringify({
      type: "response.completed",
      response: { id: "resp_generic_56", status: "completed", model: "gpt-5.6", output: [] },
    })}\n\n`);
    res.end("data: [DONE]\n\n");
  });

  try {
    await listen(upstream);
    process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL = `${serverUrl(upstream)}/backend-api/codex`;
    const res = collectResponse();
    await proxyResponsesApi(
      { model: "gpt-5.6", input: "hello", stream: true },
      {
        id: "cb-gpt-5-6",
        displayName: "GPT-5.6（订阅兼容）",
        api: "responses",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.6",
        authMode: "codex_openai",
      },
      res,
      { clientAuth: { kind: "codex_openai", bearerToken: "codex-openai-token" } },
    );
    assert.deepEqual(seenModels, ["gpt-5.6"]);
    assert.equal(res.statusCode, 200);
    assert.match(res.body(), /resp_generic_56/);
  } finally {
    await close(upstream);
    if (originalBackend === undefined) delete process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL;
    else process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL = originalBackend;
  }
});

test("codex_openai does not retry unrelated gpt-5.6-sol HTTP 400 errors", async () => {
  const originalBackend = process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL;
  let requestCount = 0;
  const upstream = httpServer(async (_req, res) => {
    requestCount += 1;
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "Invalid request parameter." }));
  });

  try {
    await listen(upstream);
    process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL = `${serverUrl(upstream)}/backend-api/codex`;

    await assert.rejects(
      proxyResponsesApi(
        { model: "gpt-5.6-sol", input: "hello", stream: true },
        {
          id: "cb-gpt-5-6-sol",
          api: "responses",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-5.6-sol",
          authMode: "codex_openai",
        },
        collectResponse(),
        {
          clientAuth: {
            kind: "codex_openai",
            bearerToken: "codex-openai-token",
          },
        },
      ),
      (error) => error instanceof UpstreamHttpError && error.statusCode === 400,
    );
    assert.equal(requestCount, 1);
  } finally {
    await close(upstream);
    if (originalBackend === undefined) {
      delete process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL;
    } else {
      process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL = originalBackend;
    }
  }
});

test("API-key Responses routes never apply the ChatGPT subscription model alias", async () => {
  let requestCount = 0;
  const upstream = httpServer(async (_req, res) => {
    requestCount += 1;
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({
      detail: "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
    }));
  });

  try {
    await listen(upstream);
    await assert.rejects(
      proxyResponsesApi(
        { model: "gpt-5.6-sol", input: "hello", stream: true },
        {
          id: "custom-gpt-5-6-sol",
          api: "responses",
          baseUrl: `${serverUrl(upstream)}/v1`,
          model: "gpt-5.6-sol",
          authMode: "api_key",
          apiKey: "test-key",
        },
        collectResponse(),
        {},
      ),
      (error) => error instanceof UpstreamHttpError && error.statusCode === 400,
    );
    assert.equal(requestCount, 1);
  } finally {
    await close(upstream);
  }
});

test("responses stream logs token usage from completed SSE event", async () => {
  const originalBackend = process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL;
  const originalLog = console.log;
  const logs = [];

  const upstream = httpServer(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.write("event: response.completed\n");
    res.write(
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_with_usage",
          object: "response",
          status: "completed",
          output: [],
          usage: {
            input_tokens: 12,
            output_tokens: 34,
            total_tokens: 46,
            input_tokens_details: {
              cached_tokens: 5,
            },
          },
        },
      })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });

  try {
    await listen(upstream);
    process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL = `${serverUrl(upstream)}/backend-api/codex`;
    console.log = (line) => logs.push(String(line));

    const res = collectResponse();
    await proxyResponsesApi(
      {
        model: "gpt-5.5",
        input: "hello",
        stream: true,
      },
      {
        id: "gpt-5.5",
        api: "responses",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.5",
        authMode: "codex_openai",
      },
      res,
      {
        requestId: "req_usage",
        clientAuth: {
          kind: "codex_openai",
          bearerToken: "codex-openai-token",
        },
      },
    );

    assert.match(res.body(), /response.completed/);
    assert.ok(
      logs.some((line) =>
        line.includes("req_usage <- upstream route=gpt-5.5 usage prompt=12 cached=5 fresh=7 completion=34 total=46"),
      ),
      "expected Responses SSE usage to be logged",
    );
  } finally {
    console.log = originalLog;
    if (originalBackend === undefined) {
      delete process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL;
    } else {
      process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL = originalBackend;
    }
    await close(upstream);
  }
});

test("responses stream body errors are converted to terminal SSE for Codex clients", async () => {
  const originalFetch = globalThis.fetch;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          [
            "event: response.output_text.delta",
            `data: ${JSON.stringify({
              type: "response.output_text.delta",
              delta: "partial before socket error",
            })}`,
            "",
          ].join("\n"),
        ),
      );
      controller.error(new Error("socket closed while streaming"));
    },
  });

  globalThis.fetch = async () =>
    new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });

  try {
    const res = collectResponse();
    await assert.rejects(
      proxyResponsesApi(
        {
          model: "gpt-5.5",
          input: "hello",
          stream: true,
        },
        {
          id: "gpt-5.5",
          api: "responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          model: "gpt-5.5",
          authMode: "codex_openai",
        },
        res,
        {
          requestId: "req_body_error",
          clientAuth: {
            kind: "codex_openai",
            bearerToken: "codex-openai-token",
          },
        },
      ),
      (error) => error?.name === "UpstreamStreamError" && error?.code === "upstream_stream_error",
    );

    const text = res.body();
    assert.match(text, /response\.failed/);
    assert.match(text, /upstream_stream_truncated/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("responses stream write failures after client close are treated as client cancellation", async () => {
  const originalFetch = globalThis.fetch;
  const clientAbort = new AbortController();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          [
            "event: response.output_text.delta",
            `data: ${JSON.stringify({
              type: "response.output_text.delta",
              delta: "text the local client will not receive",
            })}`,
            "",
          ].join("\n"),
        ),
      );
      controller.close();
    },
  });

  globalThis.fetch = async () =>
    new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });

  try {
    const res = collectResponse();
    res.destroyed = false;
    res.writableEnded = false;
    res.write = () => {
      clientAbort.abort(new Error("client connection closed"));
      res.destroyed = true;
      const error = new Error("write after end");
      error.code = "ERR_STREAM_DESTROYED";
      throw error;
    };

    await assert.rejects(
      proxyResponsesApi(
        {
          model: "gpt-5.5",
          input: "hello",
          stream: true,
        },
        {
          id: "gpt-5.5",
          api: "responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          model: "gpt-5.5",
          authMode: "codex_openai",
        },
        res,
        {
          requestId: "req_client_closed",
          clientSignal: clientAbort.signal,
          clientAuth: {
            kind: "codex_openai",
            bearerToken: "codex-openai-token",
          },
        },
      ),
      (error) => error?.code === "client_closed_request",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function snapshotProxyEnv() {
  const keys = proxyEnvKeys();
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function clearProxyEnv() {
  for (const key of proxyEnvKeys()) {
    delete process.env[key];
  }
}

function restoreProxyEnv(snapshot) {
  clearProxyEnv();
  for (const [key, value] of Object.entries(snapshot)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}

function proxyEnvKeys() {
  return [
    "CODEXBRIDGE_HTTPS_PROXY",
    "CODEXBRIDGE_HTTP_PROXY",
    "CODEXBRIDGE_ALL_PROXY",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "https_proxy",
    "http_proxy",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
  ];
}

function httpServer(handler) {
  return http.createServer(handler);
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function serverUrl(server) {
  const address = server.address();
  return `http://${address.address}:${address.port}`;
}

function collectResponse() {
  const chunks = [];
  return {
    statusCode: null,
    headers: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
    },
    end(chunk) {
      if (chunk) {
        chunks.push(Buffer.from(chunk));
      }
    },
    body() {
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}
