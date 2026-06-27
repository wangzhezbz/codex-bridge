import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  __resetUpstreamFailureCacheForTests,
  callJsonUpstream,
  proxyResponsesApi,
} from "../src/upstream.js";
import {
  __resetRateLimiterForTests,
  __setRateLimitClockForTests,
} from "../src/rate-limit.js";
import {
  proxySettingsForUrl,
} from "../src/proxy.js";

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

test("upstream requests retry direct when proxy network fetch fails", async () => {
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

    assert.deepEqual(calls, [true, false]);
    assert.deepEqual(response, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
    restoreProxyEnv(originalEnv);
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
      {},
    );
    await callJsonUpstream(
      "https://api.moonshot.cn/v1/chat/completions",
      route,
      { model: "kimi-k2.7-code" },
      {},
    );

    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [1000]);
  } finally {
    globalThis.fetch = originalFetch;
    __resetRateLimiterForTests();
  }
});

test("upstream 429 response fails fast during route cooldown", async () => {
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

    await assert.rejects(
      callJsonUpstream(
        "https://api.deepseek.com/v1/chat/completions",
        route,
        {
          model: "deepseek-v4-pro",
          messages: [{ role: "user", content: "next turn" }],
        },
        {},
      ),
      /Provider is temporarily rate limited/,
    );

    assert.equal(calls, 1);
    assert.deepEqual(sleeps, []);

    now = 2000;
    const response = await callJsonUpstream(
      "https://api.deepseek.com/v1/chat/completions",
      route,
      {
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "after cooldown" }],
      },
      {},
    );
    assert.equal(calls, 2);
    assert.deepEqual(response, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
    __resetRateLimiterForTests();
  }
});

test("upstream retry-after cooldown is capped to avoid long local lockouts", async () => {
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

    await assert.rejects(
      callJsonUpstream(
        "https://api.moonshot.cn/v1/chat/completions",
        route,
        {
          model: "kimi-k2.7-code",
          messages: [{ role: "user", content: "second turn" }],
        },
        {},
      ),
      /Retry after 120s/,
    );

    assert.equal(calls, 1);

    now = 120_000;
    const response = await callJsonUpstream(
      "https://api.moonshot.cn/v1/chat/completions",
      route,
      {
        model: "kimi-k2.7-code",
        messages: [{ role: "user", content: "after capped cooldown" }],
      },
      {},
    );

    assert.equal(calls, 2);
    assert.deepEqual(response, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
    __resetRateLimiterForTests();
  }
});

test("upstream 429 fail-fast cooldown is shared by routes using the same provider key", async () => {
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

    await assert.rejects(
      callJsonUpstream(
        "https://api.deepseek.com/v1/chat/completions",
        flashRoute,
        { model: "deepseek-v4-flash" },
        {},
      ),
      /Provider is temporarily rate limited/,
    );

    assert.equal(calls, 1);
    assert.deepEqual(sleeps, []);

    now = 3000;
    const response = await callJsonUpstream(
      "https://api.deepseek.com/v1/chat/completions",
      flashRoute,
      { model: "deepseek-v4-flash" },
      {},
    );
    assert.equal(calls, 2);
    assert.deepEqual(response, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
    __resetRateLimiterForTests();
  }
});

test("identical upstream failures are short-circuited without another provider call", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: "Too Many Requests" } }), {
      status: 429,
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
      /Upstream returned HTTP 429/,
    );

    await assert.rejects(
      callJsonUpstream(
        "https://api.moonshot.cn/v1/chat/completions",
        route,
        payload,
        { requestId: "req_retry" },
      ),
      /Upstream returned HTTP 429/,
    );

    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    __resetUpstreamFailureCacheForTests();
    __resetRateLimiterForTests();
  }
});

test("upstream failure cache does not block a different user turn", async () => {
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
          "chatgpt-account-id": "acct_123",
          "session-id": "sess_123",
          "thread-id": "thread_123",
          "x-codex-turn-state": "sticky_123",
          "x-codex-beta-features": "feature-a",
        },
      },
    );

    assert.equal(seenRequest.url, "/backend-api/codex/responses");
    assert.equal(seenRequest.headers.authorization, "Bearer codex-openai-token");
    assert.equal(seenRequest.headers.accept, "text/event-stream");
    assert.equal(seenRequest.headers["chatgpt-account-id"], "acct_123");
    assert.equal(seenRequest.headers["session-id"], "sess_123");
    assert.equal(seenRequest.headers["thread-id"], "thread_123");
    assert.equal(seenRequest.headers["x-codex-turn-state"], "sticky_123");
    assert.equal(seenRequest.headers["x-codex-beta-features"], "feature-a");
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
          usage: {
            input_tokens: 12,
            output_tokens: 34,
            total_tokens: 46,
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
        line.includes("req_usage <- upstream route=gpt-5.5 usage prompt=12 completion=34 total=46"),
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
