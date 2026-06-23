import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { loadConfig } from "../src/config.js";
import { ResponseHistory } from "../src/history.js";
import { shouldUseImageGenerationFallback } from "../src/image-generation.js";
import { createRouterServer } from "../src/server.js";
import { proxyResponsesApi } from "../src/upstream.js";

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

test("server routes Chrome plugin requests to Node REPL for chat providers", async () => {
  const chatBodies = [];
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    chatBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl_chrome_tool",
        object: "chat.completion",
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [
                {
                  id: "call_node_repl",
                  type: "function",
                  function: {
                    name: "mcp__node_repl__js",
                    arguments: JSON.stringify({
                      code: "nodeRepl.write('browser bootstrap')",
                    }),
                  },
                },
              ],
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
    defaultModel: "deepseek-v4-pro",
    models: [
      {
        id: "deepseek-v4-pro",
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
    const response = await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        input: "Chrome 打开 youtube",
        tools: [
          {
            type: "namespace",
            name: "mcp__node_repl__",
            tools: [
              {
                type: "function",
                name: "js",
                description: "Run JavaScript.",
                parameters: {
                  type: "object",
                  properties: {
                    code: { type: "string" },
                  },
                  required: ["code"],
                },
              },
            ],
          },
          {
            type: "function",
            name: "shell_command",
            description: "Run shell.",
            parameters: { type: "object", properties: {} },
          },
        ],
      }),
    });

    assert.equal(response.output[0].type, "function_call");
    assert.equal(response.output[0].name, "mcp__node_repl__js");
  } finally {
    await close(router);
    await close(upstream);
  }

  assert.equal(chatBodies.length, 1);
  assert.deepEqual(chatBodies[0].tool_choice, {
    type: "function",
    function: { name: "mcp__node_repl__js" },
  });
});

test("chat routes use OpenAI image fallback for explicit image generation prompts", async () => {
  const previousEnv = snapshotEnv([
    "OPENAI_API_KEY",
    "CODEXBRIDGE_IMAGE_BASE_URL",
    "CODEXBRIDGE_IMAGE_MODEL",
    "CODEXBRIDGE_IMAGE_SIZE",
  ]);
  let imagePayload = null;
  const imageUpstream = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/images/generations");
    assert.equal(req.headers.authorization, "Bearer image-key");

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    imagePayload = JSON.parse(Buffer.concat(chunks).toString("utf8"));

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        created: 1,
        data: [
          {
            b64_json: "base64-png-data",
            revised_prompt: "a small bridge between model nodes",
          },
        ],
        usage: {
          input_tokens: 12,
          output_tokens: 0,
          total_tokens: 12,
        },
      }),
    );
  });

  await listen(imageUpstream);
  process.env.OPENAI_API_KEY = "image-key";
  process.env.CODEXBRIDGE_IMAGE_BASE_URL = `${serverUrl(imageUpstream)}/v1`;
  process.env.CODEXBRIDGE_IMAGE_MODEL = "gpt-image-test";
  process.env.CODEXBRIDGE_IMAGE_SIZE = "512x512";

  const router = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    defaultModel: "kimi-k2-7-code",
    models: [
      {
        id: "kimi-k2-7-code",
        displayName: "Kimi K2.7 Code",
        api: "chat_completions",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "kimi-k2.7-code",
        apiKey: "kimi-key",
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
        model: "kimi-k2-7-code",
        input: "请调用 image gen 帮我生成一张图片，一座桥连接多个模型节点",
      }),
    });

    assert.equal(imagePayload.model, "gpt-image-test");
    assert.equal(imagePayload.size, "512x512");
    assert.match(imagePayload.prompt, /一座桥/);
    assert.equal(response.object, "response");
    assert.equal(response.codexbridge_image_generation.upstream_model, "gpt-image-test");
    assert.equal(
      response.output.find((item) => item.type === "image_generation_call")?.result,
      "base64-png-data",
    );
    assert.equal(response.usage.total_tokens, 12);
  } finally {
    restoreEnv(previousEnv);
    await close(router);
    await close(imageUpstream);
  }
});

test("chat routes can use a per-route custom image generation provider", async () => {
  const previousEnv = snapshotEnv(["OPENAI_API_KEY", "CUSTOM_IMAGE_API_KEY"]);
  delete process.env.OPENAI_API_KEY;
  process.env.CUSTOM_IMAGE_API_KEY = "custom-image-key";

  let imagePayload = null;
  const imageUpstream = http.createServer(async (req, res) => {
    assert.equal(req.url, "/compatible/images/generations");
    assert.equal(req.headers.authorization, "Bearer custom-image-key");

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    imagePayload = JSON.parse(Buffer.concat(chunks).toString("utf8"));

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: [{ url: "https://images.example/custom.png" }],
        usage: { prompt_tokens: 9, completion_tokens: 0, total_tokens: 9 },
      }),
    );
  });

  await listen(imageUpstream);
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
        baseUrl: "http://127.0.0.1:1/v1",
        model: "deepseek-v4-pro",
        apiKey: "deepseek-key",
        imageGeneration: {
          enabled: true,
          mode: "custom",
          displayName: "Custom Image API",
          baseUrl: `${serverUrl(imageUpstream)}/compatible`,
          endpoint: "/images/generations",
          model: "custom-image-v1",
          size: "768x768",
          apiKeyEnv: "CUSTOM_IMAGE_API_KEY",
        },
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
        model: "deepseek-v4-pro",
        input: "generate an image of a small app icon",
      }),
    });

    assert.equal(imagePayload.model, "custom-image-v1");
    assert.equal(imagePayload.size, "768x768");
    assert.match(imagePayload.prompt, /small app icon/);
    assert.equal(response.codexbridge_image_generation.provider, "Custom Image API");
    assert.equal(response.codexbridge_image_generation.upstream_model, "custom-image-v1");
    assert.equal(response.usage.total_tokens, 9);
  } finally {
    restoreEnv(previousEnv);
    await close(router);
    await close(imageUpstream);
  }
});

test("responses routes can override native image generation with a custom provider", async () => {
  const previousEnv = snapshotEnv(["CUSTOM_IMAGE_API_KEY"]);
  process.env.CUSTOM_IMAGE_API_KEY = "custom-image-key";

  let imagePayload = null;
  const imageUpstream = http.createServer(async (req, res) => {
    assert.equal(req.url, "/custom/images/generations");
    assert.equal(req.headers.authorization, "Bearer custom-image-key");

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    imagePayload = JSON.parse(Buffer.concat(chunks).toString("utf8"));

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: [{ url: "https://images.example/responses-custom.png" }],
      }),
    );
  });

  await listen(imageUpstream);
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
        baseUrl: "http://127.0.0.1:1/v1",
        model: "gpt-5.5",
        authMode: "codex_openai",
        imageGeneration: {
          enabled: true,
          mode: "custom",
          displayName: "Custom Image API",
          baseUrl: `${serverUrl(imageUpstream)}/custom`,
          endpoint: "/images/generations",
          model: "custom-image-v1",
          apiKeyEnv: "CUSTOM_IMAGE_API_KEY",
        },
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
        model: "gpt-5.5",
        input: "generate an image of a tiny bridge icon",
        tools: [{ type: "image_generation" }],
      }),
    });

    assert.equal(imagePayload.model, "custom-image-v1");
    assert.match(imagePayload.prompt, /tiny bridge icon/);
    assert.equal(response.codexbridge_image_generation.provider, "Custom Image API");
    assert.equal(response.codexbridge_image_generation.upstream_model, "custom-image-v1");
  } finally {
    restoreEnv(previousEnv);
    await close(router);
    await close(imageUpstream);
  }
});

test("image fallback ignores image analysis prompts", () => {
  assert.equal(
    shouldUseImageGenerationFallback(
      { input: "\u8bf7\u5206\u6790\u8fd9\u5f20\u56fe\u7247\u91cc\u7684\u753b\u9762" },
      { api: "chat_completions" },
    ),
    false,
  );
  assert.equal(
    shouldUseImageGenerationFallback(
      { input: "\u5e2e\u6211\u753b\u4e00\u5f20\u6865\u7684\u56fe\u7247" },
      { api: "chat_completions" },
    ),
    true,
  );
  assert.equal(
    shouldUseImageGenerationFallback(
      {
        input: "generate an image of a bridge",
        tools: [{ type: "image_generation" }],
      },
      {
        api: "responses",
        imageGeneration: { mode: "official" },
      },
    ),
    false,
  );
  assert.equal(
    shouldUseImageGenerationFallback(
      {
        input: "generate an image of a bridge",
        tools: [{ type: "image_generation" }],
      },
      {
        api: "responses",
        imageGeneration: {
          mode: "custom",
          baseUrl: "https://images.example/v1",
          model: "image-model",
          apiKeyEnv: "IMAGE_KEY",
        },
      },
    ),
    true,
  );
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

test("server accepts Codex Desktop response probes without an upstream call", async () => {
  let upstreamCalls = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamCalls += 1;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unexpected upstream call" }));
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
      method: "GET",
      headers: {
        authorization: "Bearer router-token",
      },
    });

    assert.equal(response.object, "list");
    assert.deepEqual(response.data, []);
    assert.equal(upstreamCalls, 0);
  } finally {
    await close(router);
    await close(upstream);
  }
});

test("server accepts Codex Desktop response item probes without an upstream call", async () => {
  let upstreamCalls = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamCalls += 1;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unexpected upstream call" }));
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
    const response = await fetchJson(`${baseUrl}/v1/responses/resp_probe`, {
      method: "GET",
      headers: {
        authorization: "Bearer router-token",
      },
    });

    assert.equal(response.id, "resp_probe");
    assert.equal(response.object, "response");
    assert.equal(response.status, "completed");
    assert.equal(upstreamCalls, 0);
  } finally {
    await close(router);
    await close(upstream);
  }
});

test("server accepts Codex Desktop response cancel probes without an upstream call", async () => {
  let upstreamCalls = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamCalls += 1;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unexpected upstream call" }));
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
    const response = await fetchJson(`${baseUrl}/v1/responses/resp_probe/cancel`, {
      method: "POST",
      headers: {
        authorization: "Bearer router-token",
      },
    });

    assert.equal(response.id, "resp_probe");
    assert.equal(response.object, "response");
    assert.equal(response.status, "cancelled");
    assert.equal(upstreamCalls, 0);
  } finally {
    await close(router);
    await close(upstream);
  }
});

test("server accepts Codex Desktop model setting updates without an upstream call", async () => {
  let upstreamCalls = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamCalls += 1;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unexpected upstream call" }));
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
    for (const method of ["PATCH", "PUT"]) {
      const response = await fetchJson(`${baseUrl}/v1/responses`, {
        method,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer codex-openai-token",
        },
        body: JSON.stringify({
          model: "gpt-5.4-mini",
          model_reasoning_effort: "high",
        }),
      });

      assert.equal(response.ok, true);
      assert.equal(response.model, "gpt-5.4-mini");
    }
    assert.equal(upstreamCalls, 0);
  } finally {
    await close(router);
    await close(upstream);
  }
});

test("server accepts Codex Desktop per-response model setting updates without an upstream call", async () => {
  let upstreamCalls = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamCalls += 1;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unexpected upstream call" }));
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
    for (const pathname of [
      "/v1/responses/resp_new_thread",
      "/responses/resp_new_thread",
      "/v1/responses/resp_new_thread/model_settings",
      "/responses/resp_new_thread/model_settings",
    ]) {
      for (const method of ["PATCH", "PUT"]) {
        const response = await fetchJson(`${baseUrl}${pathname}`, {
          method,
          headers: {
            "content-type": "application/json",
            authorization: "Bearer codex-openai-token",
          },
          body: JSON.stringify({
            model: "gpt-5.4-mini",
            reasoning_effort: "xhigh",
          }),
        });

        assert.equal(response.ok, true);
        assert.equal(response.model, "gpt-5.4-mini");
        assert.equal(response.model_reasoning_effort, "xhigh");
      }
    }
    assert.equal(upstreamCalls, 0);
  } finally {
    await close(router);
    await close(upstream);
  }
});

test("responses route history is available after switching to a chat-completions model", async () => {
  const chatBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");

    if (req.url === "/v1/responses") {
      const body = JSON.parse(bodyText);
      assert.equal(body.model, "gpt-5.5");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "resp_gpt_context",
          object: "response",
          status: "completed",
          model: "gpt-5.5",
          output: [
            {
              id: "msg_gpt_context",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: "GPT critical project detail: preserve unified history.",
                  annotations: [],
                },
              ],
            },
          ],
          output_text: "GPT critical project detail: preserve unified history.",
        }),
      );
      return;
    }

    if (req.url === "/v1/chat/completions") {
      const body = JSON.parse(bodyText);
      chatBodies.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl_after_switch",
          choices: [
            {
              message: {
                role: "assistant",
                content: "chat model saw the prior detail",
              },
            },
          ],
        }),
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unexpected path" }));
  });

  await listen(upstream);
  const upstreamUrl = serverUrl(upstream);

  const router = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    defaultModel: "gpt-5.5",
    clientAuth: {
      allowOpenAiBearer: true,
    },
    models: [
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        api: "responses",
        baseUrl: `${upstreamUrl}/v1`,
        model: "gpt-5.5",
        authMode: "codex_openai",
      },
      {
        id: "deepseek-v4-pro",
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
    await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer codex-openai-token",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: "remember the project detail",
      }),
    });

    await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        previous_response_id: "resp_gpt_context",
        input: "what did GPT say?",
      }),
    });
  } finally {
    await close(router);
    await close(upstream);
  }

  assert.equal(chatBodies.length, 1);
  const chatText = JSON.stringify(chatBodies[0].messages);
  assert.match(chatText, /remember the project detail/);
  assert.match(chatText, /GPT critical project detail/);
  assert.match(chatText, /what did GPT say/);
});

test("responses route preserves GPT tool calls before switching tool output to a chat-completions model", async () => {
  const chatBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");

    if (req.url === "/v1/responses") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "resp_gpt_tool",
          object: "response",
          status: "completed",
          model: "gpt-5.5",
          output: [
            {
              id: "fc_gpt_shell",
              type: "function_call",
              call_id: "call_shell",
              name: "shell_command",
              arguments: '{"command":"pwd"}',
              status: "completed",
            },
          ],
          output_text: "",
        }),
      );
      return;
    }

    if (req.url === "/v1/chat/completions") {
      const body = JSON.parse(bodyText);
      chatBodies.push(body);
      const assistantIndex = body.messages.findIndex(
        (message) =>
          message.role === "assistant" &&
          Array.isArray(message.tool_calls) &&
          message.tool_calls.some((toolCall) => toolCall.id === "call_shell"),
      );
      const toolIndex = body.messages.findIndex(
        (message) => message.role === "tool" && message.tool_call_id === "call_shell",
      );
      if (assistantIndex < 0 || toolIndex !== assistantIndex + 1) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message:
                "assistant tool call must be followed by the matching tool output",
            },
          }),
        );
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl_tool_output",
          choices: [
            {
              message: {
                role: "assistant",
                content: "saw the shell output",
              },
            },
          ],
        }),
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unexpected path" }));
  });

  await listen(upstream);
  const upstreamUrl = serverUrl(upstream);

  const router = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    defaultModel: "gpt-5.5",
    clientAuth: {
      allowOpenAiBearer: true,
    },
    models: [
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        api: "responses",
        baseUrl: `${upstreamUrl}/v1`,
        model: "gpt-5.5",
        authMode: "codex_openai",
      },
      {
        id: "deepseek-v4-pro",
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
    await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer codex-openai-token",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: "run pwd",
        tools: [
          {
            type: "function",
            name: "shell_command",
            description: "Run command",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        ],
      }),
    });

    await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        previous_response_id: "resp_gpt_tool",
        input: [
          {
            type: "function_call_output",
            call_id: "call_shell",
            output: "F:\\game_code\\router",
          },
        ],
        tools: [
          {
            type: "function",
            name: "shell_command",
            description: "Run command",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        ],
      }),
    });
  } finally {
    await close(router);
    await close(upstream);
  }

  assert.equal(chatBodies.length, 1);
});

test("responses route inlines local chat history when switching back from a chat-completions model", async () => {
  const responseBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");

    if (req.url === "/v1/chat/completions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl_local_context",
          choices: [
            {
              message: {
                role: "assistant",
                content: "DeepSeek local detail: keep this when returning to GPT.",
              },
            },
          ],
        }),
      );
      return;
    }

    if (req.url === "/v1/responses") {
      const body = JSON.parse(bodyText);
      if (body.previous_response_id) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: "unknown previous response id" },
          }),
        );
        return;
      }
      responseBodies.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "resp_gpt_after_local",
          object: "response",
          status: "completed",
          model: "gpt-5.5",
          output: [],
          output_text: "GPT saw local chat history",
        }),
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unexpected path" }));
  });

  await listen(upstream);
  const upstreamUrl = serverUrl(upstream);

  const router = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    defaultModel: "deepseek-v4-pro",
    clientAuth: {
      allowOpenAiBearer: true,
    },
    models: [
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        api: "responses",
        baseUrl: `${upstreamUrl}/v1`,
        model: "gpt-5.5",
        authMode: "codex_openai",
      },
      {
        id: "deepseek-v4-pro",
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
    const first = await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        input: "remember local detail",
      }),
    });

    await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer codex-openai-token",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        previous_response_id: first.id,
        input: "what did the local model say?",
      }),
    });
  } finally {
    await close(router);
    await close(upstream);
  }

  assert.equal(responseBodies.length, 1);
  assert.equal(responseBodies[0].previous_response_id, undefined);
  const inputText = JSON.stringify(responseBodies[0].input);
  assert.match(inputText, /remember local detail/);
  assert.match(inputText, /DeepSeek local detail/);
  assert.match(inputText, /what did the local model say/);
});

test("responses route inlines legacy chat-completions history when response meta is missing", async () => {
  const responseBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    responseBodies.push(body);
    if (body.previous_response_id) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "unknown previous response id" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "resp_gpt_after_legacy_local",
        object: "response",
        status: "completed",
        model: "gpt-5.5",
        output: [],
        output_text: "ok",
      }),
    );
  });

  await listen(upstream);
  const upstreamUrl = serverUrl(upstream);
  const history = new ResponseHistory();
  history.record("resp_chatcmpl_legacy_local", [
    { role: "user", content: "legacy local user detail" },
    { role: "assistant", content: "legacy local assistant detail" },
  ]);

  const responseChunks = [];
  const res = {
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    write(chunk) {
      responseChunks.push(Buffer.from(chunk));
    },
    end(chunk) {
      if (chunk) {
        responseChunks.push(Buffer.from(chunk));
      }
    },
  };

  try {
    await proxyResponsesApi(
      {
        model: "gpt-5.5",
        previous_response_id: "resp_chatcmpl_legacy_local",
        input: "continue with GPT",
      },
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        api: "responses",
        baseUrl: `${upstreamUrl}/v1`,
        model: "gpt-5.5",
        authMode: "codex_openai",
      },
      history,
      res,
      {
        requestId: "req_legacy_inline",
        clientAuth: {
          kind: "codex_openai",
          bearerToken: "codex-openai-token",
        },
      },
    );
  } finally {
    await close(upstream);
  }

  assert.equal(res.statusCode, 200);
  assert.equal(responseBodies.length, 1);
  assert.equal(responseBodies[0].previous_response_id, undefined);
  const inputText = JSON.stringify(responseBodies[0].input);
  assert.match(inputText, /legacy local user detail/);
  assert.match(inputText, /legacy local assistant detail/);
  assert.match(inputText, /continue with GPT/);
});

test("streaming responses without object field are recorded for later chat-completions switches", async () => {
  const chatBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");

    if (req.url === "/v1/responses") {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      res.end(
        [
          "event: response.completed",
          `data: ${JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_stream_context",
              status: "completed",
              model: "gpt-5.5",
              output_text: "GPT streamed detail without object.",
            },
          })}`,
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
      );
      return;
    }

    if (req.url === "/v1/chat/completions") {
      const body = JSON.parse(bodyText);
      chatBodies.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl_after_stream",
          choices: [
            {
              message: {
                role: "assistant",
                content: "chat model saw streamed GPT history",
              },
            },
          ],
        }),
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unexpected path" }));
  });

  await listen(upstream);
  const upstreamUrl = serverUrl(upstream);

  const router = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    defaultModel: "gpt-5.5",
    clientAuth: {
      allowOpenAiBearer: true,
    },
    models: [
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        api: "responses",
        baseUrl: `${upstreamUrl}/v1`,
        model: "gpt-5.5",
        authMode: "codex_openai",
      },
      {
        id: "deepseek-v4-pro",
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
    const firstResponse = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer codex-openai-token",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        stream: true,
        input: "remember streamed detail",
      }),
    });
    const firstText = await firstResponse.text();
    assert.equal(firstResponse.ok, true, firstText);

    await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        previous_response_id: "resp_stream_context",
        input: "what did streaming GPT say?",
      }),
    });
  } finally {
    await close(router);
    await close(upstream);
  }

  assert.equal(chatBodies.length, 1);
  const chatText = JSON.stringify(chatBodies[0].messages);
  assert.match(chatText, /remember streamed detail/);
  assert.match(chatText, /GPT streamed detail/);
  assert.match(chatText, /what did streaming GPT say/);
});

test("chat route image rejection is retried without poisoning later conversation turns", async () => {
  const chatBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    chatBodies.push(body);

    if (JSON.stringify(body.messages).includes("\"image_url\"")) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "This model does not support image_url content.",
          },
        }),
      );
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: `chatcmpl_text_${chatBodies.length}`,
        choices: [
          {
            message: {
              role: "assistant",
              content: "text-only retry succeeded",
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
    defaultModel: "deepseek-v4-pro",
    models: [
      {
        id: "deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        api: "chat_completions",
        baseUrl: `${upstreamUrl}/v1`,
        model: "deepseek-v4-pro",
        apiKey: "upstream-key",
        inputModalities: ["text", "image"],
      },
    ],
  });

  await listen(router);
  const baseUrl = serverUrl(router);

  try {
    const first = await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "look at this image" },
              {
                type: "input_image",
                image_url: "data:image/png;base64,abc123",
              },
            ],
          },
        ],
      }),
    });

    await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        previous_response_id: first.id,
        input: "continue without the image",
      }),
    });
  } finally {
    await close(router);
    await close(upstream);
  }

  assert.equal(chatBodies.length, 3);
  assert.match(JSON.stringify(chatBodies[0].messages), /image_url/);
  assert.doesNotMatch(JSON.stringify(chatBodies[1].messages), /image_url/);
  assert.doesNotMatch(JSON.stringify(chatBodies[2].messages), /image_url/);
  assert.match(
    JSON.stringify(chatBodies[2].messages),
    /image input omitted because upstream rejected image content/,
  );
  assert.match(JSON.stringify(chatBodies[2].messages), /continue without the image/);
});

test("chat route image rejection is isolated even when text-only retry fails", async () => {
  const chatBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    chatBodies.push(body);

    if (JSON.stringify(body.messages).includes("\"image_url\"")) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "image inputs are not supported by this model",
          },
        }),
      );
      return;
    }

    if (chatBodies.length === 2) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Too Many Requests" } }));
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: `chatcmpl_after_image_${chatBodies.length}`,
        choices: [
          {
            message: {
              role: "assistant",
              content: "later turn succeeded",
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
    defaultModel: "deepseek-v4-pro",
    models: [
      {
        id: "deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        api: "chat_completions",
        baseUrl: `${upstreamUrl}/v1`,
        model: "deepseek-v4-pro",
        apiKey: "upstream-key",
        inputModalities: ["text", "image"],
      },
    ],
  });

  await listen(router);
  const baseUrl = serverUrl(router);

  try {
    const first = await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "look at this image" },
              {
                type: "input_image",
                image_url: "data:image/png;base64,abc123",
              },
            ],
          },
        ],
      }),
    });

    assert.equal(first.status, "completed");
    assert.match(first.output_text, /图片|image/i);

    await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        previous_response_id: first.id,
        input: "continue after failed image turn",
      }),
    });
  } finally {
    await close(router);
    await close(upstream);
  }

  assert.equal(chatBodies.length, 3);
  assert.match(JSON.stringify(chatBodies[0].messages), /image_url/);
  assert.doesNotMatch(JSON.stringify(chatBodies[1].messages), /image_url/);
  assert.doesNotMatch(JSON.stringify(chatBodies[2].messages), /image_url/);
  assert.match(
    JSON.stringify(chatBodies[2].messages),
    /image input omitted because upstream rejected image content/,
  );
  assert.match(JSON.stringify(chatBodies[2].messages), /continue after failed image turn/);
});

test("streaming chat image rejection is isolated for later conversation turns", async () => {
  const chatBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    chatBodies.push(body);

    if (JSON.stringify(body.messages).includes("\"image_url\"")) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "vision input is unavailable" } }));
      return;
    }

    if (chatBodies.length === 2) {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "retry failed after image removal" } }));
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: `chatcmpl_stream_after_image_${chatBodies.length}`,
        choices: [
          {
            message: {
              role: "assistant",
              content: "stream later turn succeeded",
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
    defaultModel: "deepseek-v4-pro",
    models: [
      {
        id: "deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        api: "chat_completions",
        baseUrl: `${upstreamUrl}/v1`,
        model: "deepseek-v4-pro",
        apiKey: "upstream-key",
        inputModalities: ["text", "image"],
      },
    ],
  });

  await listen(router);
  const baseUrl = serverUrl(router);

  try {
    const first = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        stream: true,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "stream image request" },
              { type: "input_image", image_url: "data:image/png;base64,abc123" },
            ],
          },
        ],
      }),
    });
    const firstText = await first.text();
    assert.equal(first.ok, true, firstText);
    assert.match(firstText, /response\.completed/);
    assert.match(firstText, /image input omitted because upstream rejected image content|图片/);
    const completed = firstText.match(/event: response\.completed\ndata: ([^\n]+)/);
    assert.ok(completed, firstText);
    const firstId = JSON.parse(completed[1]).response.id;

    await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        previous_response_id: firstId,
        input: "continue after streamed image failure",
      }),
    });
  } finally {
    await close(router);
    await close(upstream);
  }

  assert.equal(chatBodies.length, 3);
  assert.match(JSON.stringify(chatBodies[0].messages), /image_url/);
  assert.doesNotMatch(JSON.stringify(chatBodies[1].messages), /image_url/);
  assert.doesNotMatch(JSON.stringify(chatBodies[2].messages), /image_url/);
  assert.match(
    JSON.stringify(chatBodies[2].messages),
    /image input omitted because upstream rejected image content/,
  );
  assert.match(JSON.stringify(chatBodies[2].messages), /continue after streamed image failure/);
});

function snapshotEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
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
