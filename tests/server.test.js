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

test("server returns a local rate-limit response without retrying the provider", async () => {
  let upstreamCalls = 0;
  const upstream = http.createServer(async (_req, res) => {
    upstreamCalls += 1;
    res.writeHead(429, {
      "content-type": "application/json",
      "retry-after": "30",
    });
    res.end(JSON.stringify({ error: { message: "Too Many Requests" } }));
  });

  await listen(upstream);
  const upstreamUrl = serverUrl(upstream);
  const router = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    defaultModel: "kimi-k2-7-code",
    models: [
      {
        id: "kimi-k2-7-code",
        displayName: "Kimi K2.7 Code",
        provider: "kimi",
        api: "chat_completions",
        baseUrl: `${upstreamUrl}/v1`,
        model: "kimi-k2.7-code",
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
        model: "kimi-k2-7-code",
        input: "Chrome \u6253\u5f00 youtube",
      }),
    });
    const second = await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "kimi-k2-7-code",
        input: "Computer Use \u6253\u5f00\u8bb0\u4e8b\u672c",
      }),
    });

    assert.match(first.output_text, /rate limited|token waste/i);
    assert.match(second.output_text, /rate limited|token waste/i);
    assert.equal(upstreamCalls, 1);
  } finally {
    await close(router);
    await close(upstream);
  }
});

test("server stops runaway chat tool loops after repeated tool continuations", async () => {
  let upstreamCalls = 0;
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    upstreamCalls += 1;

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: `chatcmpl_tool_loop_${upstreamCalls}`,
        object: "chat.completion",
        choices: [
          {
            message: {
              role: "assistant",
              content: "I will keep using tools.",
              tool_calls: [
                {
                  id: `call_loop_${upstreamCalls}`,
                  type: "function",
                  function: {
                    name: "shell_command",
                    arguments: JSON.stringify({
                      command: `echo loop ${upstreamCalls}`,
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 100 + upstreamCalls,
          completion_tokens: 10,
          total_tokens: 110 + upstreamCalls,
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
        maxToolContinuationTurns: 1,
      },
    ],
  });

  await listen(router);
  const baseUrl = serverUrl(router);
  const tools = [
    {
      type: "function",
      name: "shell_command",
      description: "Run shell.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
        },
        required: ["command"],
      },
    },
  ];

  try {
    const first = await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        input: "create a file, write a joke, then delete it",
        tools,
      }),
    });
    const firstCall = first.output.find((item) => item.type === "function_call");
    assert.ok(firstCall);

    const second = await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        previous_response_id: first.id,
        input: [
          {
            type: "function_call_output",
            call_id: firstCall.call_id,
            output: "created file",
          },
        ],
        tools,
      }),
    });
    const secondCall = second.output.find((item) => item.type === "function_call");
    assert.ok(secondCall);

    const third = await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        previous_response_id: second.id,
        input: [
          {
            type: "function_call_output",
            call_id: secondCall.call_id,
            output: "deleted file",
          },
        ],
        tools,
      }),
    });

    assert.equal(
      third.output.some((item) => item.type === "function_call"),
      false,
    );
    assert.match(third.output_text, /stopped.*tool loop/i);
    assert.equal(upstreamCalls, 3);
  } finally {
    await close(router);
    await close(upstream);
  }
});

test("server stops chat tool loops when Codex sends full input without previous_response_id", async () => {
  let upstreamCalls = 0;
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    upstreamCalls += 1;

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: `chatcmpl_no_prev_loop_${upstreamCalls}`,
        object: "chat.completion",
        choices: [
          {
            message: {
              role: "assistant",
              content: "I will keep using tools without previous_response_id.",
              tool_calls: [
                {
                  id: `call_no_prev_loop_${upstreamCalls}`,
                  type: "function",
                  function: {
                    name: "shell_command",
                    arguments: JSON.stringify({
                      command: `echo no-prev-loop ${upstreamCalls}`,
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 200 + upstreamCalls,
          completion_tokens: 10,
          total_tokens: 210 + upstreamCalls,
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
        maxToolContinuationTurns: 1,
      },
    ],
  });

  await listen(router);
  const baseUrl = serverUrl(router);
  const tools = [
    {
      type: "function",
      name: "shell_command",
      description: "Run shell.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
        },
        required: ["command"],
      },
    },
  ];
  const originalUserInput = "create a file, write a joke, then delete it";

  try {
    const first = await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        input: originalUserInput,
        tools,
      }),
    });
    const firstCall = first.output.find((item) => item.type === "function_call");
    assert.ok(firstCall);

    const second = await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        input: [
          originalUserInput,
          firstCall,
          {
            type: "function_call_output",
            call_id: firstCall.call_id,
            output: "created file",
          },
        ],
        tools,
      }),
    });
    const secondCall = second.output.find((item) => item.type === "function_call");
    assert.ok(secondCall);

    const third = await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        input: [
          originalUserInput,
          firstCall,
          {
            type: "function_call_output",
            call_id: firstCall.call_id,
            output: "created file",
          },
          secondCall,
          {
            type: "function_call_output",
            call_id: secondCall.call_id,
            output: "wrote joke",
          },
        ],
        tools,
      }),
    });

    assert.equal(
      third.output.some((item) => item.type === "function_call"),
      false,
    );
    assert.match(third.output_text, /stopped.*tool loop/i);
    assert.equal(upstreamCalls, 3);
  } finally {
    await close(router);
    await close(upstream);
  }
});

test("server aborts upstream chat request when the Codex client disconnects", async () => {
  let upstreamHitResolve;
  let upstreamClosedResolve;
  const upstreamHit = new Promise((resolve) => {
    upstreamHitResolve = resolve;
  });
  const upstreamClosed = new Promise((resolve) => {
    upstreamClosedResolve = resolve;
  });
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    upstreamHitResolve();
    res.on("close", () => upstreamClosedResolve());
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
        upstreamTimeoutMs: 5000,
      },
    ],
  });

  await listen(router);
  const baseUrl = serverUrl(router);
  const controller = new AbortController();
  const clientRequest = fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer router-token",
    },
    signal: controller.signal,
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      input: "start a slow tool-planning turn",
    }),
  }).catch((error) => error);

  try {
    await upstreamHit;
    controller.abort();
    const closed = await Promise.race([
      upstreamClosed.then(() => true),
      delay(400).then(() => false),
    ]);
    assert.equal(closed, true);
    const result = await clientRequest;
    assert.match(String(result?.name || result?.message || ""), /abort|cancel/i);
  } finally {
    router.closeAllConnections?.();
    upstream.closeAllConnections?.();
    await close(router);
    await close(upstream);
  }
});

test("server times out hung upstream chat requests", async () => {
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
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
        upstreamTimeoutMs: 30,
      },
    ],
  });

  await listen(router);
  const baseUrl = serverUrl(router);

  try {
    const result = await Promise.race([
      fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer router-token",
        },
        body: JSON.stringify({
          model: "deepseek-v4-pro",
          input: "this upstream will hang",
        }),
      }).then(async (response) => ({
        status: response.status,
        text: await response.text(),
      })),
      delay(500).then(() => null),
    ]);
    assert.ok(result, "router should return before the test timeout");
    assert.equal(result.status, 504);
    assert.match(result.text, /timed out/i);
  } finally {
    router.closeAllConnections?.();
    upstream.closeAllConnections?.();
    await close(router);
    await close(upstream);
  }
});

test("server default chat tool guard stops after three consecutive tool calls", async () => {
  let upstreamCalls = 0;
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    upstreamCalls += 1;

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: `chatcmpl_default_loop_${upstreamCalls}`,
        object: "chat.completion",
        choices: [
          {
            message: {
              role: "assistant",
              content: "I will keep using tools.",
              tool_calls: [
                {
                  id: `call_default_loop_${upstreamCalls}`,
                  type: "function",
                  function: {
                    name: "shell_command",
                    arguments: JSON.stringify({
                      command: `echo default-loop ${upstreamCalls}`,
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 300 + upstreamCalls,
          completion_tokens: 10,
          total_tokens: 310 + upstreamCalls,
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
      },
    ],
  });

  await listen(router);
  const baseUrl = serverUrl(router);
  const tools = [
    {
      type: "function",
      name: "shell_command",
      description: "Run shell.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
        },
        required: ["command"],
      },
    },
  ];

  try {
    const first = await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        input: "run a short shell sequence",
        tools,
      }),
    });
    const firstCall = first.output.find((item) => item.type === "function_call");
    assert.ok(firstCall);

    const second = await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        previous_response_id: first.id,
        input: [{ type: "function_call_output", call_id: firstCall.call_id, output: "one" }],
        tools,
      }),
    });
    const secondCall = second.output.find((item) => item.type === "function_call");
    assert.ok(secondCall);

    const third = await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        previous_response_id: second.id,
        input: [{ type: "function_call_output", call_id: secondCall.call_id, output: "two" }],
        tools,
      }),
    });
    const thirdCall = third.output.find((item) => item.type === "function_call");
    assert.ok(thirdCall);

    const fourth = await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        previous_response_id: third.id,
        input: [{ type: "function_call_output", call_id: thirdCall.call_id, output: "three" }],
        tools,
      }),
    });

    assert.equal(
      fourth.output.some((item) => item.type === "function_call"),
      false,
    );
    assert.match(fourth.output_text, /stopped.*tool loop/i);
    assert.equal(upstreamCalls, 4);
  } finally {
    await close(router);
    await close(upstream);
  }
});

test("server lets chat models finish tool tasks from full input without previous_response_id", async () => {
  let upstreamCalls = 0;
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    upstreamCalls += 1;
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const sawNativeToolResult = body.messages.some(
      (message) => message.role === "tool" && message.tool_call_id === "call_write_joke",
    );

    res.writeHead(200, { "content-type": "application/json" });
    if (sawNativeToolResult) {
      res.end(
        JSON.stringify({
          id: "chatcmpl_finished_tool_task",
          object: "chat.completion",
          choices: [
            {
              message: {
                role: "assistant",
                content: "文件已写入笑话并删除，任务完成。",
              },
            },
          ],
          usage: {
            prompt_tokens: 250,
            completion_tokens: 12,
            total_tokens: 262,
          },
        }),
      );
      return;
    }

    res.end(
      JSON.stringify({
        id: "chatcmpl_write_joke",
        object: "chat.completion",
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_write_joke",
                  type: "function",
                  function: {
                    name: "shell_command",
                    arguments: JSON.stringify({
                      command:
                        "Set-Content -Path joke.txt -Value '为什么程序员喜欢黑咖啡？因为它没有 Java。'; Remove-Item joke.txt",
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 220,
          completion_tokens: 20,
          total_tokens: 240,
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
      },
    ],
  });

  await listen(router);
  const baseUrl = serverUrl(router);
  const tools = [
    {
      type: "function",
      name: "shell_command",
      description: "Run shell.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
        },
        required: ["command"],
      },
    },
  ];
  const originalUserInput = "create a file, write a joke, then delete it";

  try {
    const first = await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        input: originalUserInput,
        tools,
      }),
    });
    const firstCall = first.output.find((item) => item.type === "function_call");
    assert.equal(firstCall?.call_id, "call_write_joke");

    const second = await fetchJson(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        input: [
          originalUserInput,
          firstCall,
          {
            type: "function_call_output",
            call_id: firstCall.call_id,
            output: "joke file created and deleted",
          },
        ],
        tools,
      }),
    });

    assert.equal(
      second.output.some((item) => item.type === "function_call"),
      false,
    );
    assert.match(second.output_text, /任务完成/);
    assert.equal(upstreamCalls, 2);
  } finally {
    await close(router);
    await close(upstream);
  }
});

test("server suppresses unexpected Node REPL tool calls from chat providers", async () => {
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

    assert.equal(response.output.length, 0);
    assert.equal(response.output_text, "");
    assert.doesNotMatch(JSON.stringify(response), /Node REPL/);
  } finally {
    await close(router);
    await close(upstream);
  }

  assert.equal(chatBodies.length, 1);
  assert.deepEqual(chatBodies[0].tool_choice, {
    type: "function",
    function: { name: "shell_command" },
  });
  assert.equal(
    chatBodies[0].tools.some((tool) => tool.function?.name === "mcp__node_repl__js"),
    false,
  );
});

test("server does not enforce Node REPL bootstrap when chat provider answers directly", async () => {
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.deepEqual(body.tool_choice, {
      type: "function",
      function: { name: "shell_command" },
    });
    assert.equal(
      body.tools.some((tool) => tool.function?.name === "mcp__node_repl__js"),
      false,
    );

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl_chrome_ignored",
        object: "chat.completion",
        choices: [
          {
            message: {
              role: "assistant",
              content:
                "Node REPL is unavailable, so I will use PowerShell fallback.",
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

    assert.equal(response.output.length, 0);
    assert.equal(response.output_text, "");
    assert.doesNotMatch(JSON.stringify(response), /Node REPL/);
  } finally {
    await close(router);
    await close(upstream);
  }
});

test("server does not force Node REPL bootstrap for chat interactive requests", async () => {
  const chatBodies = [];
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    chatBodies.push(body);

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl_chrome_no_force",
        object: "chat.completion",
        choices: [
          {
            message: {
              role: "assistant",
              content: "Chrome tool bootstrap is not available in this chat route.",
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

    assert.equal(response.output.length, 0);
    assert.equal(response.output_text, "");
    assert.doesNotMatch(JSON.stringify(response), /bootstrap/);
  } finally {
    await close(router);
    await close(upstream);
  }

  assert.equal(chatBodies.length, 1);
  assert.deepEqual(chatBodies[0].tool_choice, {
    type: "function",
    function: { name: "shell_command" },
  });
  assert.equal(
    chatBodies[0].tools.some((tool) => tool.function?.name === "mcp__node_repl__js"),
    false,
  );
});

test("server preserves executable shell tool calls for Computer Use requests", async () => {
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl_computer_wrong_tool",
        object: "chat.completion",
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_shell",
                  type: "function",
                  function: {
                    name: "shell_command",
                    arguments: JSON.stringify({ command: "Start-Process notepad" }),
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
        input: "Computer Use 打开记事本",
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

    assert.equal(response.output.length, 1);
    assert.equal(response.output[0].type, "function_call");
    assert.equal(response.output[0].name, "shell_command");
    assert.match(response.output[0].arguments, /Start-Process notepad/);
  } finally {
    await close(router);
    await close(upstream);
  }
});

test("image generation fallback is not triggered by prompt keywords alone", () => {
  assert.equal(
    shouldUseImageGenerationFallback(
      {
        input: "请调用 image gen 帮我生成一张图片，一座桥连接多个模型节点",
      },
      {
        api: "chat_completions",
        provider: "openai",
      },
    ),
    false,
  );
  assert.equal(
    shouldUseImageGenerationFallback(
      {
        input: "请调用 image gen 帮我生成一张图片，一座桥连接多个模型节点",
      },
      {
        api: "chat_completions",
        provider: "deepseek",
        imageGeneration: {
          mode: "custom",
          baseUrl: "https://images.example/v1",
          model: "image-model",
          apiKeyEnv: "IMAGE_KEY",
        },
      },
    ),
    false,
  );
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
        tools: [{ type: "image_generation" }],
        tool_choice: { type: "image_generation" },
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
        tool_choice: { type: "image_generation" },
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
    false,
  );
  assert.equal(
    shouldUseImageGenerationFallback(
      { input: "\u8c03\u7528 image gen \u5e2e\u6211\u751f\u6210\u4e00\u5f20\u56fe\u7247" },
      { api: "chat_completions", provider: "openai" },
    ),
    false,
  );
  assert.equal(
    shouldUseImageGenerationFallback(
      { input: "\u7535\u8111 \u6253\u5f00\u8bb0\u4e8b\u672c\u5728\u91cc\u9762\u5199\u4e2a\u7b11\u8bdd" },
      { api: "chat_completions", imageGeneration: { mode: "official" } },
    ),
    false,
  );
  assert.equal(
    shouldUseImageGenerationFallback(
      { input: "Computer Use \u6253\u5f00\u753b\u56fe\u753b\u4e00\u5934\u732a" },
      { api: "chat_completions", imageGeneration: { mode: "official" } },
    ),
    false,
  );
  assert.equal(
    shouldUseImageGenerationFallback(
      { input: "Chrome \u6253\u5f00 youtube" },
      { api: "chat_completions", imageGeneration: { mode: "official" } },
    ),
    false,
  );
  assert.equal(
    shouldUseImageGenerationFallback(
      {
        input: "\u8c03\u7528 image gen \u5e2e\u6211\u751f\u6210\u4e00\u5f20\u56fe\u7247",
      },
      {
        api: "chat_completions",
        provider: "deepseek",
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
        imageGeneration: { mode: "official" },
      },
    ),
    false,
  );
  assert.equal(
    shouldUseImageGenerationFallback(
      {
        input: "generate an image of a bridge",
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
    false,
  );
  assert.equal(
    shouldUseImageGenerationFallback(
      {
        input: "write a short joke",
        tools: [{ type: "image_generation" }],
      },
      {
        api: "chat_completions",
        provider: "deepseek",
        imageGeneration: {
          mode: "custom",
          baseUrl: "https://images.example/v1",
          model: "image-model",
          apiKeyEnv: "IMAGE_KEY",
        },
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
    false,
  );
  assert.equal(
    shouldUseImageGenerationFallback(
      {
        input: "generate an image of a bridge",
        tools: [{ type: "image_generation" }],
        tool_choice: { type: "image_generation" },
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
  assert.equal(
    shouldUseImageGenerationFallback(
      {
        input: "generate an image of a bridge",
        tools: [
          {
            type: "namespace",
            name: "imagegen",
            tools: [{ type: "image_generation" }],
          },
        ],
        tool_choice: "image_generation",
      },
      {
        api: "chat_completions",
        provider: "deepseek",
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

test("custom image generation does not intercept interactive computer requests", async () => {
  const previousEnv = snapshotEnv(["CUSTOM_IMAGE_API_KEY"]);
  delete process.env.CUSTOM_IMAGE_API_KEY;
  let upstreamCalls = 0;
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    upstreamCalls += 1;
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.match(body.messages.at(-1).content, /\u8bb0\u4e8b\u672c/);

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl_computer_request",
        object: "chat.completion",
        choices: [
          {
            message: {
              role: "assistant",
              content: "I can use a shell command to open Notepad.",
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
        apiKey: "deepseek-key",
        imageGeneration: {
          enabled: true,
          mode: "custom",
          displayName: "Custom Image API",
          baseUrl: "https://images.example/v1",
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
        model: "deepseek-v4-pro",
        input: "\u7535\u8111 \u6253\u5f00\u8bb0\u4e8b\u672c\u5728\u91cc\u9762\u5199\u4e2a\u7b11\u8bdd",
        tools: [
          { type: "image_generation" },
          {
            type: "function",
            name: "shell_command",
            description: "Run shell.",
            parameters: { type: "object", properties: {} },
          },
        ],
      }),
    });

    assert.equal(response.output_text, "I can use a shell command to open Notepad.");
    assert.equal(upstreamCalls, 1);
  } finally {
    restoreEnv(previousEnv);
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

test("responses route preserves GPT tool calls before switching tool output to DeepSeek", async () => {
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
      const hasStructuredToolCalls = body.messages.some(
        (message) =>
          message.role === "assistant" &&
          Array.isArray(message.tool_calls) &&
          message.tool_calls.some((toolCall) => toolCall.id === "call_shell"),
      );
      const hasToolRoleMessage = body.messages.some(
        (message) => message.role === "tool" && message.tool_call_id === "call_shell",
      );
      const transcript = JSON.stringify(body.messages);
      if (
        !hasStructuredToolCalls ||
        !hasToolRoleMessage ||
        transcript.includes("Assistant requested tool calls") ||
        !transcript.includes("shell_command") ||
        !transcript.includes("\\\"command\\\":\\\"pwd\\\"") ||
        !transcript.includes("F:\\\\game_code\\\\router")
      ) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message:
                "GPT tool call history was not preserved for DeepSeek",
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

test("server filters unsupported chat params before chat completions upstream fetch", async () => {
  let upstreamBody;
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    upstreamBody = await readJson(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl_param_filter",
      choices: [
        {
          message: {
            role: "assistant",
            content: "ok",
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });

  await listen(upstream);
  const router = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    defaultModel: "deepseek-v4-pro",
    models: [{
      id: "deepseek-v4-pro",
      provider: "deepseek",
      displayName: "DeepSeek V4 Pro",
      api: "chat_completions",
      baseUrl: `${serverUrl(upstream)}/v1`,
      model: "deepseek-v4-pro",
      apiKey: "upstream-key",
      dropParams: ["response_format", "parallel_tool_calls"],
    }],
  });

  await listen(router);
  try {
    const response = await fetchJson(`${serverUrl(router)}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        input: "hello",
        response_format: { type: "json_object" },
        parallel_tool_calls: true,
        metadata: { unsafe: true },
        store: true,
      }),
    });

    assert.equal(response.output_text, "ok");
    assert.equal(upstreamBody.response_format, undefined);
    assert.equal(upstreamBody.parallel_tool_calls, undefined);
    assert.equal(upstreamBody.metadata, undefined);
    assert.equal(upstreamBody.store, undefined);
    assert.deepEqual(upstreamBody.messages.at(-1), { role: "user", content: "hello" });
  } finally {
    await close(router);
    await close(upstream);
  }
});

test("chat provider categories complete text requests without unsafe params", async () => {
  for (const route of [
    {
      id: "deepseek-smoke",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      dropParams: ["response_format", "parallel_tool_calls"],
    },
    {
      id: "kimi-smoke",
      provider: "kimi",
      model: "kimi-k2.7-code",
      inputModalities: ["text", "image"],
      dropParams: ["response_format", "parallel_tool_calls"],
    },
    {
      id: "minimax-smoke",
      provider: "minimax",
      model: "MiniMax-M3",
      dropParams: ["response_format", "parallel_tool_calls"],
    },
    {
      id: "doubao-smoke",
      provider: "volcengine",
      model: "doubao-seed-1-8-251228",
      dropParams: ["response_format", "parallel_tool_calls"],
    },
    {
      id: "qwen-smoke",
      provider: "qwen",
      model: "qwen3-coder-plus",
      dropParams: ["parallel_tool_calls"],
    },
    {
      id: "generic-smoke",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.5",
      dropParams: ["parallel_tool_calls"],
    },
  ]) {
    const { response, upstreamBody } = await exerciseChatRoute(route);
    assert.equal(response.output_text, "smoke ok", route.id);
    assert.equal(upstreamBody.parallel_tool_calls, undefined, route.id);
    if (route.dropParams.includes("response_format")) {
      assert.equal(upstreamBody.response_format, undefined, route.id);
    } else {
      assert.deepEqual(upstreamBody.response_format, { type: "json_object" }, route.id);
    }
  }
});

test("custom conservative chat route completes text and drops risky params", async () => {
  const { response, upstreamBody } = await exerciseChatRoute({
    id: "custom-smoke",
    provider: "custom",
    custom: true,
    model: "custom-model",
  }, {
    tools: [{ type: "function", function: { name: "lookup" } }],
    tool_choice: { type: "function", function: { name: "lookup" } },
  });

  assert.equal(response.output_text, "smoke ok");
  assert.equal(upstreamBody.response_format, undefined);
  assert.equal(upstreamBody.parallel_tool_calls, undefined);
  assert.equal(upstreamBody.tools, undefined);
  assert.equal(upstreamBody.tool_choice, undefined);
  assert.equal(upstreamBody.messages.at(-1).content, "smoke text");
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function exerciseChatRoute(routeOverrides = {}, requestOverrides = {}) {
  let upstreamBody;
  const upstream = http.createServer(async (req, res) => {
    upstreamBody = await readJson(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: `chatcmpl_${routeOverrides.provider || "generic"}_smoke`,
        object: "chat.completion",
        choices: [
          {
            message: {
              role: "assistant",
              content: "smoke ok",
            },
          },
        ],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 2,
          total_tokens: 5,
        },
      }),
    );
  });

  await listen(upstream);

  const route = {
    id: routeOverrides.id || "smoke-model",
    provider: routeOverrides.provider || "custom",
    displayName: routeOverrides.displayName || "Smoke Model",
    api: "chat_completions",
    baseUrl: `${serverUrl(upstream)}/v1`,
    model: routeOverrides.model || "smoke-model",
    apiKey: "upstream-key",
    ...routeOverrides,
  };
  const router = createRouterServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    defaultModel: route.id,
    models: [route],
  });

  await listen(router);

  try {
    const response = await fetchJson(`${serverUrl(router)}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer router-token",
      },
      body: JSON.stringify({
        model: route.id,
        input: "smoke text",
        response_format: { type: "json_object" },
        parallel_tool_calls: true,
        ...requestOverrides,
      }),
    });
    return { response, upstreamBody };
  } finally {
    await close(router);
    await close(upstream);
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
