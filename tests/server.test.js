import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
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
