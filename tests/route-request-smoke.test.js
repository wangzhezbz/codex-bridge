import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRouterServer } from "../src/server.js";
import { runRouteRequestSmoke } from "../src/route-request-smoke.js";

test("route request smoke exercises stale model, auxiliary task, and image proxy paths", async () => {
  const upstreamRequests = [];
  const imageRequests = [];
  const logs = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => logs.push(args.join(" "));
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    const body = await readJson(req);
    upstreamRequests.push(body);
    assert.equal(body.model, "deepseek-v4-pro");

    const payloadText = JSON.stringify(body);
    let text = "stale fallback ok";
    if (payloadText.includes("auxiliary-smoke")) {
      text = "auxiliary route ok";
    } else if (payloadText.includes("chat-completions-smoke")) {
      text = "chat completions route ok";
    } else if (payloadText.includes("chat-stream-smoke")) {
      text = "chat stream route ok";
    }
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      res.end(
        `data: ${JSON.stringify(chatCompletionChunkWithText(text))}\n\n` +
          "data: [DONE]\n\n",
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(chatCompletionWithText(text)));
  });

  const imageUpstream = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/images/generations");
    imageRequests.push(await readJson(req));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      data: [{ b64_json: pngBase64 }],
      usage: { prompt_tokens: 8, completion_tokens: 0, total_tokens: 8 },
    }));
  });

  await listen(upstream);
  await listen(imageUpstream);

  const router = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    defaultModel: "cb-deepseek-v4-pro",
    smartRouting: { autoSelectModel: true, autoFailover: false },
    codexAuxiliaryTasks: {
      intercept: false,
      routeId: "cb-deepseek-v4-pro",
    },
    models: [
      {
        id: "cb-deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        provider: "deepseek",
        api: "chat_completions",
        baseUrl: `${serverUrl(upstream)}/v1`,
        model: "deepseek-v4-pro",
        authMode: "api_key",
        apiKey: "deepseek-key",
        imageGeneration: {
          enabled: true,
          mode: "custom",
          displayName: "Image Proxy",
          baseUrl: `${serverUrl(imageUpstream)}/v1`,
          endpoint: "/images/generations",
          model: "image-model",
          size: "1024x1024",
          apiKey: "image-key",
        },
      },
    ],
  });
  await listen(router);

  try {
    const report = await runRouteRequestSmoke({
      baseUrl: serverUrl(router),
      authToken: "router-token",
      userAgent: "Codex Desktop/0.142.3",
      cases: [
        {
          id: "stale-model-fallback",
          body: { model: "cb-removed-route", input: "stale-smoke" },
          expect: { outputTextIncludes: "stale fallback ok" },
        },
        {
          id: "codex-auxiliary-task",
          body: { model: "gpt-5.4-mini", input: "auxiliary-smoke" },
          expect: { outputTextIncludes: "auxiliary route ok" },
        },
        {
          id: "image-generation-proxy",
          body: { model: "cb-deepseek-v4-pro", input: "draw an image of a cat" },
          expect: {
            jsonPathEquals: {
              "codexbridge_image_generation.provider": "Image Proxy",
            },
          },
        },
        {
          id: "chat-completions-direct",
          endpointPath: "/v1/chat/completions",
          body: {
            model: "cb-deepseek-v4-pro",
            messages: [{ role: "user", content: "chat-completions-smoke" }],
          },
          expect: {
            jsonPathEquals: {
              "choices.0.message.content": "chat completions route ok",
            },
          },
        },
        {
          id: "chat-completions-direct-stream",
          endpointPath: "/v1/chat/completions",
          body: {
            model: "cb-deepseek-v4-pro",
            messages: [{ role: "user", content: "chat-stream-smoke" }],
            stream: true,
          },
          expect: {
            bodyIncludes: ["chat stream route ok", "[DONE]"],
          },
        },
      ],
    });

    assert.deepEqual(
      report.summary,
      { total: 5, passed: 5, failed: 0 },
      JSON.stringify(report.results.filter((result) => !result.ok), null, 2),
    );
    assert.equal(report.ok, true);
    assert.deepEqual(report.results.map((result) => result.id), [
      "stale-model-fallback",
      "codex-auxiliary-task",
      "image-generation-proxy",
      "chat-completions-direct",
      "chat-completions-direct-stream",
    ]);
    assert.deepEqual(upstreamRequests.map((body) => body.model), [
      "deepseek-v4-pro",
      "deepseek-v4-pro",
      "deepseek-v4-pro",
      "deepseek-v4-pro",
    ]);
    assert.equal(imageRequests.length, 1);
    assert.equal(imageRequests[0].model, "image-model");
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    await close(router);
    await close(upstream);
    await close(imageUpstream);
  }
});

test("route request smoke classifies failure paths without blaming CodexBridge", async () => {
  const logs = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));

  const upstream = http.createServer(async (req, res) => {
    const body = await readJson(req);
    const text = JSON.stringify(body);
    if (text.includes("401-smoke")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Incorrect API key provided" } }));
      return;
    }
    if (text.includes("402-smoke")) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Insufficient Balance" } }));
      return;
    }
    if (text.includes("429-smoke")) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "3" });
      res.end(JSON.stringify({ error: { message: "Too Many Requests" } }));
      return;
    }
    if (text.includes("502-smoke")) {
      res.writeHead(502, { "content-type": "text/html" });
      res.end("<!DOCTYPE html><html><head><title>ciyuan.fast | 502: Bad gateway</title></head></html>");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(chatCompletionWithText("unexpected success")));
  });

  const slowUpstream = http.createServer(async (_req, _res) => {
    await delay(80);
  });

  await listen(upstream);
  await listen(slowUpstream);

  const baseRoute = {
    id: "cb-kimi-k2-code",
    displayName: "Kimi K2 Code",
    provider: "kimi",
    api: "chat_completions",
    baseUrl: `${serverUrl(upstream)}/v1`,
    model: "kimi-k2-code",
    authMode: "api_key",
    apiKey: "kimi-key",
  };
  const router = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    defaultModel: "cb-kimi-k2-code",
    localRateLimit: { enabled: false },
    codexAuxiliaryTasks: {
      intercept: false,
      routeId: "cb-deleted-helper",
    },
    models: [
      baseRoute,
      {
        id: "cb-image-missing-key",
        displayName: "Image Missing Key",
        provider: "deepseek",
        api: "chat_completions",
        baseUrl: `${serverUrl(upstream)}/v1`,
        model: "deepseek-v4-pro",
        apiKey: "deepseek-key",
        imageGeneration: {
          enabled: true,
          mode: "custom",
          displayName: "Image Proxy Missing Key",
          baseUrl: `${serverUrl(upstream)}/v1`,
          endpoint: "/images/generations",
          model: "image-model",
          apiKeyEnv: "",
        },
      },
      {
        ...baseRoute,
        id: "cb-timeout",
        displayName: "Timeout Model",
        baseUrl: `${serverUrl(slowUpstream)}/v1`,
        upstreamTimeoutMs: 10,
      },
    ],
  });
  await listen(router);

  try {
    const report = await runRouteRequestSmoke({
      baseUrl: serverUrl(router),
      authToken: "router-token",
      userAgent: "Codex Desktop/0.142.3",
      cases: [
        {
          id: "auxiliary-route-deleted",
          body: { model: "gpt-5.4-mini", input: "auxiliary failure smoke" },
          expect: {
            status: 200,
            outputTextIncludes: "辅助任务模型不可用",
            bodyIncludes: ["本次没有请求上游模型"],
            bodyExcludes: ["CodexBridge upstream error"],
          },
        },
        {
          id: "image-provider-missing-key",
          body: { model: "cb-image-missing-key", input: "draw an image for missing-key smoke" },
          expect: {
            status: 400,
            errorCode: "missing_provider_api_key",
            bodyIncludes: ["Image Proxy Missing Key", "缺少 API Key"],
            bodyExcludes: ["CodexBridge upstream error"],
          },
        },
        {
          id: "upstream-401",
          body: { model: "cb-kimi-k2-code", input: "401-smoke" },
          expect: {
            status: 401,
            errorCode: "upstream_authentication_error",
            bodyIncludes: ["API Key", "报错信息：HTTP 401 - Incorrect API key provided"],
            bodyExcludes: ["CodexBridge upstream error"],
          },
        },
        {
          id: "upstream-402",
          body: { model: "cb-kimi-k2-code", input: "402-smoke" },
          expect: {
            status: 402,
            errorCode: "upstream_billing_error",
            bodyIncludes: ["余额", "报错信息：HTTP 402 - Insufficient Balance"],
            bodyExcludes: ["CodexBridge upstream error"],
          },
        },
        {
          id: "upstream-429",
          body: { model: "cb-kimi-k2-code", input: "429-smoke" },
          expect: {
            status: 429,
            errorCode: "upstream_rate_limit",
            bodyIncludes: ["供应商限流", "报错信息：HTTP 429 - Too Many Requests"],
            bodyExcludes: ["CodexBridge stopped", "CodexBridge 已拦截"],
          },
        },
        {
          id: "upstream-502-html",
          body: { model: "cb-kimi-k2-code", input: "502-smoke" },
          expect: {
            status: 502,
            errorCode: "upstream_provider_unavailable",
            bodyIncludes: ["网关", "报错信息：HTTP 502 - ciyuan.fast | 502: Bad gateway"],
            bodyExcludes: ["<!DOCTYPE", "<html"],
          },
        },
        {
          id: "upstream-timeout",
          body: { model: "cb-timeout", input: "timeout-smoke" },
          expect: {
            status: 504,
            errorCode: "upstream_timeout",
            bodyIncludes: ["请求供应商超时", "报错信息"],
            bodyExcludes: ["CodexBridge stopped", "CodexBridge 已拦截"],
          },
        },
      ],
    });

    assert.deepEqual(
      report.summary,
      { total: 7, passed: 7, failed: 0 },
      JSON.stringify(report.results.filter((result) => !result.ok), null, 2),
    );
    assert.equal(report.ok, true);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    await close(router);
    await close(upstream);
    await close(slowUpstream);
  }
});

test("route request smoke covers smart failover enabled, disabled, and unavailable backups", async () => {
  const upstreamRequests = [];
  const logs = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    const body = await readJson(req);
    upstreamRequests.push(body);
    if (body.model === "qwen-plus") {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Bad gateway from primary" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(chatCompletionWithText(`fallback:${body.model}`)));
  });
  await listen(upstream);
  const upstreamUrl = `${serverUrl(upstream)}/v1`;

  const enabledRouter = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    defaultModel: "cb-primary",
    smartRouting: {
      autoSelectModel: false,
      autoFailover: true,
      failover: { mode: "ordered", routeIds: ["cb-backup"] },
    },
    models: failoverSmokeModels(upstreamUrl),
  });
  const disabledRouter = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    defaultModel: "cb-primary",
    smartRouting: { autoSelectModel: false, autoFailover: false },
    models: failoverSmokeModels(upstreamUrl),
  });
  const unavailableRouter = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    defaultModel: "cb-primary",
    smartRouting: {
      autoSelectModel: false,
      autoFailover: true,
      failover: { mode: "ordered", routeIds: ["cb-disabled-backup", "cb-missing-key-backup"] },
    },
    models: failoverSmokeModels(upstreamUrl, { unavailableBackupsOnly: true }),
  });

  await listen(enabledRouter);
  await listen(disabledRouter);
  await listen(unavailableRouter);

  try {
    const enabledReport = await runRouteRequestSmoke({
      baseUrl: serverUrl(enabledRouter),
      authToken: "router-token",
      cases: [
        {
          id: "smart-failover-enabled",
          body: { model: "cb-primary", input: "failover-enabled-smoke" },
          expect: {
            outputTextIncludes: "fallback:gpt-code",
            jsonPathEquals: {
              "codexbridge_smart_failover.fromRoute": "cb-primary",
              "codexbridge_smart_failover.toRoute": "cb-backup",
              "codexbridge_smart_failover.reason": "upstream_unavailable",
            },
          },
        },
        {
          id: "smart-failover-enabled-direct-chat",
          endpointPath: "/v1/chat/completions",
          body: {
            model: "cb-primary",
            messages: [{ role: "user", content: "failover-enabled-direct-chat-smoke" }],
          },
          expect: {
            jsonPathEquals: {
              "choices.0.message.content": "fallback:gpt-code",
            },
          },
        },
      ],
    });

    assert.equal(enabledReport.ok, true, JSON.stringify(enabledReport.results, null, 2));
    assert.deepEqual(enabledReport.results[0].smartFailover, {
      fromRoute: "cb-primary",
      fromModel: "qwen-plus",
      toRoute: "cb-backup",
      toModel: "gpt-code",
      reason: "upstream_unavailable",
    });

    const disabledReport = await runRouteRequestSmoke({
      baseUrl: serverUrl(disabledRouter),
      authToken: "router-token",
      cases: [
        {
          id: "smart-failover-disabled",
          body: { model: "cb-primary", input: "failover-disabled-smoke" },
          expect: {
            status: 502,
            errorCode: "upstream_provider_unavailable",
            bodyIncludes: ["Bad gateway from primary"],
            bodyExcludes: ["已自动切换模型", "fallback:gpt-code"],
          },
        },
      ],
    });

    assert.equal(disabledReport.ok, true, JSON.stringify(disabledReport.results, null, 2));

    const unavailableReport = await runRouteRequestSmoke({
      baseUrl: serverUrl(unavailableRouter),
      authToken: "router-token",
      cases: [
        {
          id: "smart-failover-unavailable-backups",
          body: { model: "cb-primary", input: "failover-unavailable-smoke" },
          expect: {
            status: 502,
            errorCode: "upstream_provider_unavailable",
            bodyIncludes: ["Bad gateway from primary"],
            bodyExcludes: ["已自动切换模型", "fallback:gpt-code"],
          },
        },
      ],
    });

    assert.equal(unavailableReport.ok, true, JSON.stringify(unavailableReport.results, null, 2));
    assert.deepEqual(
      upstreamRequests.map((body) => body.model),
      ["qwen-plus", "gpt-code", "qwen-plus", "gpt-code", "qwen-plus", "qwen-plus"],
    );
    assert.ok(
      logs.some((line) => /!! smart-failover .*route=cb-primary .*fallback_route=cb-backup/.test(line)),
      "expected runtime smart-failover diagnostic log",
    );
    assert.ok(
      logs.some((line) => /route_trace .*"reason":"smart_failover".*"selectedRoute":"cb-backup"/.test(line)),
      "expected smart failover route_trace decision",
    );
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    await close(enabledRouter);
    await close(disabledRouter);
    await close(unavailableRouter);
    await close(upstream);
  }
});

function chatCompletionWithText(text) {
  return {
    id: `chatcmpl_${text.replace(/\W+/g, "_")}`,
    object: "chat.completion",
    choices: [
      {
        message: {
          role: "assistant",
          content: text,
        },
      },
    ],
  };
}

function chatCompletionChunkWithText(text) {
  return {
    id: `chatcmpl_chunk_${text.replace(/\W+/g, "_")}`,
    object: "chat.completion.chunk",
    choices: [
      {
        delta: {
          role: "assistant",
          content: text,
        },
      },
    ],
  };
}

function failoverSmokeModels(upstreamUrl, options = {}) {
  const primary = {
    id: "cb-primary",
    displayName: "Qwen Primary",
    provider: "qwen",
    api: "chat_completions",
    baseUrl: upstreamUrl,
    model: "qwen-plus",
    authMode: "api_key",
    apiKey: "qwen-key",
    contextWindow: 128000,
  };
  const backup = {
    id: "cb-backup",
    displayName: "GPT Code Backup",
    provider: "openai",
    api: "chat_completions",
    baseUrl: upstreamUrl,
    model: "gpt-code",
    authMode: "api_key",
    apiKey: "openai-key",
    contextWindow: 258400,
  };
  if (!options.unavailableBackupsOnly) {
    return [primary, backup];
  }
  return [
    primary,
    { ...backup, id: "cb-disabled-backup", enabled: false },
    {
      ...backup,
      id: "cb-missing-key-backup",
      displayName: "Missing Key Backup",
      apiKey: "",
      apiKeyEnv: "",
    },
  ];
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serverUrl(server) {
  const address = server.address();
  return `http://${address.address}:${address.port}`;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
