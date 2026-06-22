import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { loadConfig } from "../src/config.js";
import { createRouterServer } from "../src/server.js";

test("server exposes health, models, catalog, and converted responses", async () => {
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer upstream-key");

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(body.model, "deepseek-v4-pro");
    assert.equal(body.stream, false);

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl_server",
        object: "chat.completion",
        choices: [
          {
            message: {
              role: "assistant",
              content: "hello from deepseek",
            },
          },
        ],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 4,
          total_tokens: 7,
        },
      }),
    );
  });

  await listen(upstream);
  const upstreamUrl = serverUrl(upstream);

  const router = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    defaultModel: "deepseek-v4-pro",
    models: [
      {
        id: "deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        api: "chat_completions",
        baseUrl: `${upstreamUrl}/v1`,
        model: "deepseek-v4-pro",
        apiKey: "upstream-key",
        dropParams: ["parallel_tool_calls", "response_format"],
      },
    ],
  });

  await listen(router);
  const baseUrl = serverUrl(router);

  try {
    const health = await fetchJson(`${baseUrl}/health`);
    assert.equal(health.ok, true);

    const models = await fetchJson(`${baseUrl}/v1/models`);
    assert.equal(models.data[0].id, "deepseek-v4-pro");

    const catalog = await fetchJson(`${baseUrl}/model-catalog.json`);
    assert.equal(catalog.models[0].apply_patch_tool_type, "freeform");

    const response = await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        input: "hello",
      }),
    });
    assert.equal(response.object, "response");
    assert.equal(response.output_text, "hello from deepseek");
    assert.equal(response.usage.total_tokens, 7);
  } finally {
    await close(router);
    await close(upstream);
  }
});

test("server logs every incoming request before route handling", async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (line) => logs.push(String(line));

  const router = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    models: [
      {
        id: "deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        api: "chat_completions",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "deepseek-v4-pro",
        apiKey: "upstream-key",
      },
    ],
  });

  await listen(router);
  const baseUrl = serverUrl(router);

  try {
    await fetchJson(`${baseUrl}/health`);
  } finally {
    console.log = originalLog;
    await close(router);
  }

  assert.ok(logs.some((line) => /access GET \/health/.test(line)));
});

test("codex_openai routes forward incoming Codex bearer upstream", async () => {
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/responses");
    assert.equal(req.headers.authorization, "Bearer codex-openai-token");

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(body.model, "gpt-5.5");

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "resp_hybrid_gpt",
        object: "response",
        status: "completed",
        model: "gpt-5.5",
        output: [
          {
            id: "msg_hybrid_gpt",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "hello from subscription gpt",
              },
            ],
          },
        ],
        output_text: "hello from subscription gpt",
      }),
    );
  });

  await listen(upstream);
  const upstreamUrl = serverUrl(upstream);

  const router = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    clientAuth: {
      allowOpenAiBearer: true,
    },
    defaultModel: "gpt-5.5",
    models: [
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        api: "responses",
        baseUrl: `${upstreamUrl}/v1`,
        model: "gpt-5.5",
        authMode: "codex_openai",
      },
    ],
  });

  await listen(router);
  const baseUrl = serverUrl(router);

  try {
    const response = await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer codex-openai-token",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: "hello",
      }),
    });
    assert.equal(response.output_text, "hello from subscription gpt");
  } finally {
    await close(router);
    await close(upstream);
  }
});

test("codex_openai routes accept Codex bearer even when legacy config omits clientAuth flag", async () => {
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/responses");
    assert.equal(req.headers.authorization, "Bearer codex-openai-token");

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "resp_legacy_hybrid_gpt",
        object: "response",
        status: "completed",
        model: "gpt-5.5",
        output: [],
        output_text: "legacy config accepted",
      }),
    );
  });

  await listen(upstream);
  const upstreamUrl = serverUrl(upstream);

  const router = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    defaultModel: "gpt-5.5",
    models: [
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        api: "responses",
        baseUrl: `${upstreamUrl}/v1`,
        model: "gpt-5.5",
        authMode: "codex_openai",
      },
    ],
  });

  await listen(router);
  const baseUrl = serverUrl(router);

  try {
    const response = await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer codex-openai-token",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: "hello",
      }),
    });
    assert.equal(response.output_text, "legacy config accepted");
  } finally {
    await close(router);
    await close(upstream);
  }
});

test("invalid router token response explains how to refresh CodexBridge config", async () => {
  const router = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    defaultModel: "deepseek-v4-pro",
    models: [
      {
        id: "deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        api: "chat_completions",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "deepseek-v4-pro",
        authMode: "api_key",
        apiKey: "deepseek-provider-key",
      },
    ],
  });
  await listen(router);
  const baseUrl = serverUrl(router);

  try {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer stale-or-codex-token",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        input: "hello",
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 401);
    assert.match(body.error.message, /CodexBridge/);
    assert.match(body.error.message, /Router/);
    assert.equal(body.error.code, "invalid_router_token");
  } finally {
    await close(router);
  }
});

test("missing provider API key returns a clear client configuration error", async () => {
  const originalMoonshot = process.env.MOONSHOT_API_KEY;
  delete process.env.MOONSHOT_API_KEY;

  const router = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    defaultModel: "gpt-5.2",
    models: [
      {
        id: "gpt-5.2",
        displayName: "Kimi K2.7 Code",
        api: "chat_completions",
        baseUrl: "https://api.moonshot.cn/v1",
        model: "kimi-k2.7-code",
        authMode: "api_key",
        apiKeyEnv: "MOONSHOT_API_KEY",
      },
    ],
  });
  await listen(router);
  const baseUrl = serverUrl(router);

  try {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "gpt-5.2",
        input: "hello",
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.error.code, "missing_provider_api_key");
    assert.match(body.error.message, /Kimi K2\.7 Code/);
    assert.match(body.error.message, /MOONSHOT_API_KEY/);
  } finally {
    await close(router);
    if (originalMoonshot === undefined) {
      delete process.env.MOONSHOT_API_KEY;
    } else {
      process.env.MOONSHOT_API_KEY = originalMoonshot;
    }
  }
});

test("provider API keys saved after router start are loaded from secrets file", async () => {
  const originalZhipu = process.env.ZHIPUAI_API_KEY;
  const originalSecretsFile = process.env.CODEXBRIDGE_SECRETS_FILE;
  delete process.env.ZHIPUAI_API_KEY;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-secrets-"));
  const secretsFile = path.join(tempDir, "secrets.local.json");
  process.env.CODEXBRIDGE_SECRETS_FILE = secretsFile;

  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer zhipu-provider-key");

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl_dynamic_secret",
        object: "chat.completion",
        choices: [
          {
            message: {
              role: "assistant",
              content: "dynamic secret accepted",
            },
          },
        ],
      }),
    );
  });

  await listen(upstream);
  const upstreamUrl = serverUrl(upstream);

  const router = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    defaultModel: "gpt-5.2",
    models: [
      {
        id: "gpt-5.2",
        displayName: "GLM-4.6",
        api: "chat_completions",
        baseUrl: `${upstreamUrl}/v1`,
        model: "glm-4.6",
        authMode: "api_key",
        apiKeyEnv: "ZHIPUAI_API_KEY",
      },
    ],
  });
  await listen(router);
  const baseUrl = serverUrl(router);

  fs.writeFileSync(
    secretsFile,
    JSON.stringify({ ZHIPUAI_API_KEY: "zhipu-provider-key" }),
    "utf8",
  );

  try {
    const response = await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "gpt-5.2",
        input: "hello",
      }),
    });
    assert.equal(response.output_text, "dynamic secret accepted");
  } finally {
    await close(router);
    await close(upstream);
    if (originalZhipu === undefined) {
      delete process.env.ZHIPUAI_API_KEY;
    } else {
      process.env.ZHIPUAI_API_KEY = originalZhipu;
    }
    if (originalSecretsFile === undefined) {
      delete process.env.CODEXBRIDGE_SECRETS_FILE;
    } else {
      process.env.CODEXBRIDGE_SECRETS_FILE = originalSecretsFile;
    }
  }
});

test("server reloads router config file before authorizing requests", async () => {
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/responses");
    assert.equal(req.headers.authorization, "Bearer codex-openai-token");

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "resp_reloaded_config",
        object: "response",
        status: "completed",
        model: "gpt-5.5",
        output: [],
        output_text: "reloaded config accepted",
      }),
    );
  });

  await listen(upstream);
  const upstreamUrl = serverUrl(upstream);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-router-config-"));
  const configPath = path.join(tempDir, "router.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      host: "127.0.0.1",
      port: 0,
      authToken: "router-token",
      clientAuth: { allowOpenAiBearer: false },
      defaultModel: "gpt-5.5",
      models: [
        {
          id: "gpt-5.5",
          displayName: "GPT-5.5 API",
          api: "responses",
          baseUrl: "http://127.0.0.1:9/v1",
          model: "gpt-5.5",
          authMode: "api_key",
          apiKey: "stale-api-key",
        },
      ],
    }),
    "utf8",
  );

  const router = createRouterServer(loadConfig(configPath));
  await listen(router);
  const baseUrl = serverUrl(router);

  fs.writeFileSync(
    configPath,
    JSON.stringify({
      host: "127.0.0.1",
      port: 0,
      authToken: "router-token",
      clientAuth: { allowOpenAiBearer: true },
      defaultModel: "gpt-5.5",
      models: [
        {
          id: "gpt-5.5",
          displayName: "GPT-5.5",
          api: "responses",
          baseUrl: `${upstreamUrl}/v1`,
          model: "gpt-5.5",
          authMode: "codex_openai",
        },
      ],
    }),
    "utf8",
  );

  try {
    const response = await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer codex-openai-token",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: "hello",
      }),
    });
    assert.equal(response.output_text, "reloaded config accepted");
  } finally {
    await close(router);
    await close(upstream);
  }
});

test("server routes by upstream model alias instead of falling back to default", async () => {
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer zhipu-key");

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(body.model, "glm-4.6");

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl_alias",
        object: "chat.completion",
        choices: [
          {
            message: {
              role: "assistant",
              content: "glm alias hit",
            },
          },
        ],
      }),
    );
  });

  await listen(upstream);
  const upstreamUrl = serverUrl(upstream);

  const router = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    defaultModel: "gpt-5.5",
    models: [
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        api: "responses",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "gpt-5.5",
        authMode: "api_key",
        apiKey: "default-key",
      },
      {
        id: "gpt-5.2",
        displayName: "GLM-4.6",
        api: "chat_completions",
        baseUrl: `${upstreamUrl}/v1`,
        model: "glm-4.6",
        authMode: "api_key",
        apiKey: "zhipu-key",
      },
    ],
  });
  await listen(router);
  const baseUrl = serverUrl(router);

  try {
    const response = await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "glm-4.6",
        input: "hello",
      }),
    });
    assert.equal(response.output_text, "glm alias hit");
  } finally {
    await close(router);
    await close(upstream);
  }
});

test("server routes by normalized display name alias", async () => {
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(body.model, "deepseek-v4-pro");

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl_display_alias",
        object: "chat.completion",
        choices: [
          {
            message: {
              role: "assistant",
              content: "display alias hit",
            },
          },
        ],
      }),
    );
  });

  await listen(upstream);
  const upstreamUrl = serverUrl(upstream);

  const router = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    defaultModel: "gpt-5.5",
    models: [
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        api: "responses",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "gpt-5.5",
        authMode: "api_key",
        apiKey: "default-key",
      },
      {
        id: "gpt-5.4-mini",
        displayName: "DeepSeek V4 Pro",
        api: "chat_completions",
        baseUrl: `${upstreamUrl}/v1`,
        model: "deepseek-v4-pro",
        authMode: "api_key",
        apiKey: "deepseek-key",
        slotLabel: "GPT-5.4-Mini",
        sourcePresetId: "deepseek-v4-pro",
      },
    ],
  });
  await listen(router);
  const baseUrl = serverUrl(router);

  try {
    const response = await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "deepseek v4 pro",
        input: "hello",
      }),
    });
    assert.equal(response.output_text, "display alias hit");
  } finally {
    await close(router);
    await close(upstream);
  }
});

test("server rejects explicit unknown model instead of silently using default", async () => {
  const upstream = http.createServer(async (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "resp_default",
        object: "response",
        status: "completed",
        model: "gpt-5.5",
        output: [],
        output_text: "default should not be used",
      }),
    );
  });

  await listen(upstream);
  const upstreamUrl = serverUrl(upstream);

  const router = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    defaultModel: "gpt-5.5",
    models: [
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        api: "responses",
        baseUrl: `${upstreamUrl}/v1`,
        model: "gpt-5.5",
        authMode: "api_key",
        apiKey: "default-key",
      },
    ],
  });
  await listen(router);
  const baseUrl = serverUrl(router);

  try {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "not-selected-model",
        input: "hello",
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 404);
    assert.equal(body.error.code, "model_not_configured");
    assert.match(body.error.message, /not-selected-model/);
    assert.match(body.error.message, /gpt-5\.5/);
  } finally {
    await close(router);
    await close(upstream);
  }
});

test("api_key routes ignore incoming Codex bearer and use provider key", async () => {
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer deepseek-provider-key");

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(body.model, "deepseek-v4-pro");

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl_hybrid_deepseek",
        object: "chat.completion",
        choices: [
          {
            message: {
              role: "assistant",
              content: "hello from api model",
            },
          },
        ],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 6,
          total_tokens: 11,
        },
      }),
    );
  });

  await listen(upstream);
  const upstreamUrl = serverUrl(upstream);

  const router = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    clientAuth: {
      allowOpenAiBearer: true,
    },
    defaultModel: "deepseek-v4-pro",
    models: [
      {
        id: "deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        api: "chat_completions",
        baseUrl: `${upstreamUrl}/v1`,
        model: "deepseek-v4-pro",
        authMode: "api_key",
        apiKey: "deepseek-provider-key",
      },
    ],
  });

  await listen(router);
  const baseUrl = serverUrl(router);

  try {
    const response = await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer codex-openai-token",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        input: "hello",
      }),
    });
    assert.equal(response.output_text, "hello from api model");
    assert.equal(response.usage.total_tokens, 11);
  } finally {
    await close(router);
    await close(upstream);
  }
});

test("minimax routes split and hide reasoning text", async () => {
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer minimax-provider-key");

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(body.model, "MiniMax-M3");
    assert.equal(body.reasoning_split, true);

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl_minimax_reasoning",
        object: "chat.completion",
        choices: [
          {
            message: {
              role: "assistant",
              content:
                "<think>\nThis reasoning should stay hidden.\n</think>\n我是 MiniMax M3。",
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
        },
      }),
    );
  });

  await listen(upstream);
  const upstreamUrl = serverUrl(upstream);

  const router = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    defaultModel: "gpt-5.4-mini",
    models: [
      {
        id: "gpt-5.4-mini",
        displayName: "MiniMax M3",
        provider: "minimax",
        api: "chat_completions",
        baseUrl: `${upstreamUrl}/v1`,
        model: "MiniMax-M3",
        authMode: "api_key",
        apiKey: "minimax-provider-key",
      },
    ],
  });

  await listen(router);
  const baseUrl = serverUrl(router);

  try {
    const response = await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        input: "hello",
      }),
    });
    assert.equal(response.output_text, "我是 MiniMax M3。");
    assert.equal(response.usage.total_tokens, 30);
  } finally {
    await close(router);
    await close(upstream);
  }
});

test("server logs request-scoped upstream network errors", async () => {
  const router = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    clientAuth: {
      allowOpenAiBearer: true,
    },
    defaultModel: "gpt-5.5",
    models: [
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        api: "responses",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "gpt-5.5",
        authMode: "codex_openai",
      },
    ],
  });
  await listen(router);
  const baseUrl = serverUrl(router);
  const errors = [];
  const originalError = console.error;
  console.error = (message) => {
    errors.push(String(message));
  };

  try {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer codex-openai-token",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: "hello",
      }),
    });
    assert.equal(response.ok, false);
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error.code, "upstream_network_error");
    assert.match(body.error.message, /GPT-5\.5/);
    assert.match(body.error.message, /network/i);
    assert.match(
      errors.join("\n"),
      /req_[a-z0-9]+ !! upstream route=gpt-5\.5 status=502 error=CodexBridge network error/,
    );
  } finally {
    console.error = originalError;
    await close(router);
  }
});

test("subscription scope errors explain that Codex login is not an API key", async () => {
  const upstream = http.createServer(async (_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message:
            "You have insufficient permissions for this operation. Missing scopes: api.responses.write.",
          type: "invalid_request_error",
          code: "invalid_request_error",
        },
      }),
    );
  });

  await listen(upstream);
  const upstreamUrl = serverUrl(upstream);
  const router = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    clientAuth: {
      allowOpenAiBearer: true,
    },
    defaultModel: "gpt-5.5",
    models: [
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        api: "responses",
        baseUrl: `${upstreamUrl}/v1`,
        model: "gpt-5.5",
        authMode: "codex_openai",
      },
    ],
  });
  await listen(router);
  const baseUrl = serverUrl(router);

  try {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer codex-openai-token",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: "hello",
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 401);
    assert.match(body.error.message, /Codex 登录态不能作为 OpenAI API Key 使用/);
    assert.equal(body.error.code, "codex_subscription_missing_api_scope");
  } finally {
    await close(router);
    await close(upstream);
  }
});

test("upstream HTTP errors include route and upstream message for diagnosis", async () => {
  const upstream = http.createServer(async (_req, res) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: "Unknown error",
          type: "server_error",
          code: "bad_gateway",
        },
      }),
    );
  });

  await listen(upstream);
  const upstreamUrl = serverUrl(upstream);
  const router = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    clientAuth: {
      allowOpenAiBearer: true,
    },
    defaultModel: "gpt-5.5",
    models: [
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        api: "responses",
        baseUrl: `${upstreamUrl}/v1`,
        model: "gpt-5.5",
        authMode: "codex_openai",
      },
    ],
  });
  await listen(router);
  const baseUrl = serverUrl(router);
  const errors = [];
  const originalError = console.error;
  console.error = (message) => {
    errors.push(String(message));
  };

  try {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer codex-openai-token",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: "hello",
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.match(body.error.message, /GPT-5\.5/);
    assert.match(body.error.message, /HTTP 502/);
    assert.match(body.error.message, /Unknown error/);
    assert.equal(body.error.code, "upstream_error");
    assert.match(errors.join("\n"), /body=.*Unknown error/);
  } finally {
    console.error = originalError;
    await close(router);
    await close(upstream);
  }
});

const codexRequestBodyEncodingCases = [
  {
    name: "plain",
    contentEncoding: "",
    encode: (text) => Buffer.from(text),
  },
  {
    name: "gzip",
    contentEncoding: "gzip",
    encode: (text) => zlib.gzipSync(text),
  },
  {
    name: "x-gzip",
    contentEncoding: "x-gzip",
    encode: (text) => zlib.gzipSync(text),
  },
  {
    name: "deflate",
    contentEncoding: "deflate",
    encode: (text) => zlib.deflateSync(text),
  },
  {
    name: "brotli",
    contentEncoding: "br",
    encode: (text) => zlib.brotliCompressSync(text),
  },
  {
    name: "zstd",
    contentEncoding: "zstd",
    encode: (text) => zlib.zstdCompressSync(text),
  },
  {
    name: "chained gzip and zstd",
    contentEncoding: "gzip, zstd",
    encode: (text) => zlib.zstdCompressSync(zlib.gzipSync(text)),
  },
];

for (const encodingCase of codexRequestBodyEncodingCases) {
  test(`server accepts ${encodingCase.name} encoded JSON request bodies from Codex`, async () => {
    const upstream = http.createServer(async (req, res) => {
      assert.equal(req.url, "/v1/chat/completions");

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `chatcmpl_${encodingCase.name.replaceAll(" ", "_")}`,
          object: "chat.completion",
          choices: [
            {
              message: {
                role: "assistant",
                content: `decoded ${encodingCase.name} body`,
              },
            },
          ],
        }),
      );
    });

    await listen(upstream);
    const upstreamUrl = serverUrl(upstream);

    const router = createRouterServer({
      host: "127.0.0.1",
      port: 0,
      authToken: "router-token",
      defaultModel: "gpt-5.4-mini",
      models: [
        {
          id: "gpt-5.4-mini",
          displayName: "DeepSeek V4 Pro",
          api: "chat_completions",
          baseUrl: `${upstreamUrl}/v1`,
          model: "deepseek-v4-pro",
          apiKey: "upstream-key",
        },
      ],
    });

    await listen(router);
    const baseUrl = serverUrl(router);

    try {
      const headers = {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      };
      if (encodingCase.contentEncoding) {
        headers["content-encoding"] = encodingCase.contentEncoding;
      }

      const response = await fetchJson(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers,
        body: encodingCase.encode(
          JSON.stringify({
            model: "gpt-5.4-mini",
            input: "hello",
          }),
        ),
      });
      assert.equal(response.output_text, `decoded ${encodingCase.name} body`);
    } finally {
      await close(router);
      await close(upstream);
    }
  });
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

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return JSON.parse(text);
}
