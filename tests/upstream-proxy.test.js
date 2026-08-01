import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import {
  __resetUpstreamFailureCacheForTests,
  callJsonUpstream,
  proxyChatCompletions,
  proxyDirectChatCompletions,
  proxyResponsesApi,
  sendUpstreamError,
  UpstreamHttpError,
  UpstreamResponseTooLargeError,
} from "../src/upstream.js";
import * as upstreamModule from "../src/upstream.js";
import {
  __resetRateLimiterForTests,
  __setRateLimitClockForTests,
} from "../src/rate-limit.js";
import {
  proxySettingsForUrl,
} from "../src/proxy.js";
import {
  chatResponseToResponse,
  createChatCompletionResponsesStream,
} from "../src/chat-to-responses.js";
import { parseSseEvents } from "../src/sse.js";
import { buildToolContext } from "../src/tools.js";
import { ResponseHistory } from "../src/history.js";

test("default upstream response guards use 64 MiB and 600-second time boundaries", () => {
  assert.equal(typeof upstreamModule.upstreamTimeoutMs, "function");
  assert.equal(typeof upstreamModule.streamingProxyFetchOptions, "function");
  assert.equal(typeof upstreamModule.upstreamResponseLimitBytes, "function");
  assert.equal(typeof upstreamModule.upstreamResponseIdleTimeoutMs, "function");
  assert.equal(upstreamModule.upstreamTimeoutMs({}), 600000);
  assert.equal(
    upstreamModule.streamingProxyFetchOptions({}, { streamingResponse: true }, true).timeoutMs,
    600000,
  );
  assert.equal(upstreamModule.upstreamResponseLimitBytes({}), 64 * 1024 * 1024);
  assert.equal(upstreamModule.upstreamResponseIdleTimeoutMs({}), 600000);
});

test("stateless native Responses routes replace previous_response_id with local history", async () => {
  const originalFetch = globalThis.fetch;
  const seenBodies = [];
  globalThis.fetch = async (_url, init) => {
    seenBodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      id: "resp_deepseek_flash_second",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "deepseek-v4-flash",
      output: [{
        id: "msg_second",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "second answer", annotations: [] }],
      }],
      output_text: "second answer",
      error: null,
      incomplete_details: null,
      usage: null,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const history = new ResponseHistory();
    history.recordTurn({
      responseId: "resp_deepseek_flash_first",
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
      ],
      response: {
        id: "resp_deepseek_flash_first",
        object: "response",
        status: "completed",
        output: [],
      },
      meta: { upstreamKnown: true },
    });
    const res = collectResponse();
    await proxyResponsesApi(
      {
        model: "deepseek-v4-flash",
        previous_response_id: "resp_deepseek_flash_first",
        input: "second question",
      },
      {
        id: "deepseek-v4-flash",
        displayName: "DeepSeek V4 Flash",
        provider: "deepseek",
        api: "responses",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        apiKey: "test-key",
        supportsResponsePreviousId: false,
      },
      history,
      res,
      {},
    );

    assert.equal(seenBodies.length, 1);
    assert.equal(seenBodies[0].previous_response_id, undefined);
    const input = JSON.stringify(seenBodies[0].input);
    assert.match(input, /first question/);
    assert.match(input, /first answer/);
    assert.match(input, /second question/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("callJsonUpstream rejects an upstream response body above the configured byte limit", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ value: "x".repeat(128) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  try {
    await assert.rejects(
      callJsonUpstream(
        "https://provider.example/v1/chat/completions",
        {
          id: "bounded-json",
          api: "chat_completions",
          model: "bounded-json",
          apiKey: "test-key",
          maxUpstreamResponseBytes: 64,
        },
        { model: "bounded-json" },
        {},
      ),
      (error) => {
        assert.equal(error?.code, "upstream_response_too_large");
        assert.equal(error?.statusCode, 502);
        assert.equal(error?.limitBytes, 64);
        assert.ok(error?.actualBytes > 64);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("oversized upstream responses preserve their diagnostic code for clients", () => {
  const res = collectResponse();
  sendUpstreamError(
    res,
    new UpstreamResponseTooLargeError(
      64,
      128,
      "https://provider.example/v1/chat/completions",
      { id: "bounded-json", displayName: "Bounded JSON" },
    ),
  );

  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.body()).error.code, "upstream_response_too_large");
});

test("streaming responses fail when the upstream body stalls after headers", async () => {
  const originalFetch = globalThis.fetch;
  let streamController;
  const failSafeAbort = setTimeout(() => {
    streamController?.error(new Error("test fail-safe stream error"));
  }, 250);
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
      controller.enqueue(
        new TextEncoder().encode(
          'data: {"id":"chatcmpl-stalled","choices":[{"delta":{"content":"partial"}}]}\n\n',
        ),
      );
    },
    cancel() {
      cancelled = true;
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
      proxyDirectChatCompletions(
        {
          model: "stalled-stream",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        },
        {
          id: "stalled-stream",
          api: "chat_completions",
          baseUrl: "https://provider.example/v1",
          model: "stalled-stream",
          apiKey: "test-key",
          upstreamResponseIdleTimeoutMs: 25,
        },
        res,
        {},
      ),
      (error) => {
        assert.equal(error?.code, "upstream_timeout");
        assert.equal(error?.timeoutMs, 25);
        return true;
      },
    );
    assert.equal(cancelled, true);
  } finally {
    clearTimeout(failSafeAbort);
    globalThis.fetch = originalFetch;
  }
});

test("streaming responses share the configured total byte limit", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("data: response larger than the route limit\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });

  try {
    const res = collectResponse();
    await assert.rejects(
      proxyDirectChatCompletions(
        {
          model: "bounded-stream",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        },
        {
          id: "bounded-stream",
          api: "chat_completions",
          baseUrl: "https://provider.example/v1",
          model: "bounded-stream",
          apiKey: "test-key",
          maxUpstreamResponseBytes: 16,
        },
        res,
        {},
      ),
      (error) => {
        assert.equal(error?.code, "upstream_response_too_large");
        assert.equal(error?.limitBytes, 16);
        return true;
      },
    );
    assert.equal(res.body(), "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streaming responses wait for downstream drain before writing more data", async () => {
  const originalFetch = globalThis.fetch;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: first\n\n"));
      controller.enqueue(new TextEncoder().encode("data: second\n\n"));
      controller.close();
    },
  });
  globalThis.fetch = async () =>
    new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });

  try {
    const res = backpressuredResponse();
    const proxyPromise = proxyDirectChatCompletions(
      {
        model: "slow-client",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
      {
        id: "slow-client",
        api: "chat_completions",
        baseUrl: "https://provider.example/v1",
        model: "slow-client",
        apiKey: "test-key",
      },
      res,
      {},
    );

    await waitFor(() => res.writes.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(res.writes.length, 1);

    res.emit("drain");
    await proxyPromise;
    assert.deepEqual(res.writes.map((chunk) => chunk.toString("utf8")), [
      "data: first\n\n",
      "data: second\n\n",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streaming responses cancel upstream when downstream backpressure never drains", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  let failSafeClose;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: first\n\n"));
      controller.enqueue(new TextEncoder().encode("data: second\n\n"));
    },
    cancel() {
      cancelled = true;
    },
  });
  globalThis.fetch = async () =>
    new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });

  try {
    const res = backpressuredResponse();
    failSafeClose = setTimeout(() => res.emit("close"), 250);
    await assert.rejects(
      proxyDirectChatCompletions(
        {
          model: "blocked-client",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        },
        {
          id: "blocked-client",
          api: "chat_completions",
          baseUrl: "https://provider.example/v1",
          model: "blocked-client",
          apiKey: "test-key",
        },
        res,
        { downstreamDrainTimeoutMs: 25 },
      ),
      (error) => error?.code === "client_closed_request",
    );
    assert.equal(cancelled, true);
  } finally {
    clearTimeout(failSafeClose);
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic streaming chat requests use native Messages endpoint and return compatible SSE", async () => {
  let seenPath = "";
  let seenHeaders = null;
  let seenBody = null;
  const upstream = httpServer(async (req, res) => {
    seenPath = req.url;
    seenHeaders = req.headers;
    seenBody = await readRequestJson(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"stop_reason":null,"usage":{"input_tokens":12,"output_tokens":0}}}\n\n',
    );
    res.write(
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    );
    res.write(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"native anthropic "}}\n\n',
    );
    res.write(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"reply"}}\n\n',
    );
    res.write(
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":4}}\n\n',
    );
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });

  await listen(upstream);
  try {
    const res = collectResponse();
    await proxyDirectChatCompletions(
      {
        model: "cb-claude-sonnet-4-6",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
      {
        id: "cb-claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        api: "anthropic_messages",
        baseUrl: `${serverUrl(upstream)}/v1`,
        model: "claude-sonnet-4-6",
        apiKey: "anthropic-test-key",
        authMode: "anthropic_api_key",
      },
      res,
      {},
    );

    assert.equal(seenPath, "/v1/messages");
    assert.equal(seenHeaders["x-api-key"], "anthropic-test-key");
    assert.equal(seenHeaders["anthropic-version"], "2023-06-01");
    assert.equal(seenHeaders.authorization, undefined);
    assert.equal(seenBody.model, "claude-sonnet-4-6");
    assert.equal(seenBody.stream, true);
    assert.equal(res.statusCode, 200);
    assert.match(res.body(), /chat\.completion\.chunk/);
    const streamedText = res.body()
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)))
      .map((chunk) => chunk?.choices?.[0]?.delta?.content || "")
      .join("");
    assert.equal(streamedText, "native anthropic reply");
    assert.match(res.body(), /data: \[DONE\]/);
  } finally {
    await close(upstream);
  }
});

test("custom route headers cannot override provider authentication or Anthropic protocol version", async () => {
  let seenHeaders = null;
  const upstream = httpServer(async (req, res) => {
    seenHeaders = req.headers;
    await readRequestJson(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_auth",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });

  await listen(upstream);
  try {
    const res = collectResponse();
    await proxyDirectChatCompletions(
      {
        model: "cb-claude-sonnet-4-6",
        messages: [{ role: "user", content: "hello" }],
      },
      {
        id: "cb-claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        api: "anthropic_messages",
        baseUrl: `${serverUrl(upstream)}/v1`,
        model: "claude-sonnet-4-6",
        apiKey: "trusted-anthropic-key",
        authMode: "anthropic_api_key",
        headers: {
          "x-api-key": "attacker-key",
          authorization: "Bearer attacker-key",
          "anthropic-version": "1900-01-01",
          "x-safe-custom-header": "preserved",
        },
      },
      res,
      {},
    );

    assert.equal(seenHeaders["x-api-key"], "trusted-anthropic-key");
    assert.equal(seenHeaders.authorization, undefined);
    assert.equal(seenHeaders["anthropic-version"], "2023-06-01");
    assert.equal(seenHeaders["x-safe-custom-header"], "preserved");
  } finally {
    await close(upstream);
  }
});

test("Codex Responses requests routed to Anthropic use native Messages and return Responses SSE", async () => {
  let seenPath = "";
  let seenHeaders = null;
  let seenBody = null;
  const upstream = httpServer(async (req, res) => {
    seenPath = req.url;
    seenHeaders = req.headers;
    seenBody = await readRequestJson(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_codex_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "claude through Codex Responses" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 7, output_tokens: 5 },
    }));
  });

  await listen(upstream);
  try {
    const res = collectResponse();
    await proxyChatCompletions(
      {
        model: "cb-claude-sonnet-4-6",
        input: "hello from Codex",
        stream: true,
        max_output_tokens: 321,
      },
      {
        id: "cb-claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        api: "anthropic_messages",
        baseUrl: `${serverUrl(upstream)}/v1`,
        model: "claude-sonnet-4-6",
        apiKey: "anthropic-test-key",
        authMode: "anthropic_api_key",
      },
      null,
      res,
      {},
    );

    assert.equal(seenPath, "/v1/messages");
    assert.equal(seenHeaders["x-api-key"], "anthropic-test-key");
    assert.equal(seenHeaders["anthropic-version"], "2023-06-01");
    assert.equal(seenHeaders.authorization, undefined);
    assert.equal(seenBody.model, "claude-sonnet-4-6");
    assert.equal(seenBody.max_tokens, 321);
    assert.deepEqual(seenBody.messages, [
      {
        role: "user",
        content: [{ type: "text", text: "hello from Codex" }],
      },
    ]);
    assert.equal(res.statusCode, 200);
    assert.match(res.body(), /response\.output_text\.delta/);
    assert.match(res.body(), /claude through Codex Responses/);
    assert.match(res.body(), /response\.completed/);
    assert.match(res.body(), /data: \[DONE\]/);
  } finally {
    await close(upstream);
  }
});

test("Codex Responses chat routes forward real upstream text chunks before completion", async () => {
  const originalFetch = globalThis.fetch;
  let seenBody = null;
  let streamController = null;
  let proxyPromise = null;
  let recordedTurn = null;
  const encoder = new TextEncoder();

  globalThis.fetch = async (_url, init) => {
    seenBody = JSON.parse(String(init?.body || "{}"));
    if (!seenBody.stream) {
      return new Response(JSON.stringify({
        id: "chatcmpl-buffered",
        object: "chat.completion",
        model: "deepseek-reasoner",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "buffered fallback" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const stream = new ReadableStream({
      start(controller) {
        streamController = controller;
        controller.enqueue(encoder.encode(
          'data: {"id":"chatcmpl-live","object":"chat.completion.chunk","model":"deepseek-reasoner","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"private reasoning"},"finish_reason":null}]}\n\n',
        ));
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
  };

  try {
    const res = collectResponse();
    proxyPromise = proxyChatCompletions(
      {
        model: "deepseek-test",
        input: "hello",
        stream: true,
      },
      {
        id: "deepseek-test",
        displayName: "DeepSeek Test",
        api: "chat_completions",
        baseUrl: "https://provider.example/v1",
        model: "deepseek-reasoner",
        apiKey: "test-key",
      },
      {
        recordTurn(turn) {
          recordedTurn = turn;
        },
      },
      res,
      {},
    );

    await waitFor(() => seenBody !== null);
    assert.equal(seenBody.stream, true);
    assert.equal(res.body(), "");
    streamController.enqueue(encoder.encode(
      'data: {"id":"chatcmpl-live","object":"chat.completion.chunk","model":"deepseek-reasoner","choices":[{"index":0,"delta":{"content":"first "},"finish_reason":null}]}\n\n',
    ));
    await waitFor(() => res.body().includes('"delta":"first "'));
    assert.match(res.body(), /"model":"deepseek-test"/);
    assert.doesNotMatch(res.body(), /response\.completed/);

    streamController.enqueue(encoder.encode(
      'data: {"id":"chatcmpl-live","object":"chat.completion.chunk","model":"deepseek-reasoner","choices":[{"index":0,"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n',
    ));
    streamController.enqueue(encoder.encode(
      'data: {"id":"chatcmpl-live","object":"chat.completion.chunk","model":"deepseek-reasoner","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
    ));
    streamController.enqueue(encoder.encode("data: [DONE]\n\n"));
    streamController.close();

    await proxyPromise;
    assert.match(res.body(), /response\.completed/);
    assert.match(res.body(), /data: \[DONE\]/);
    assert.match(res.body(), /first answer/);
    assert.doesNotMatch(res.body(), /private reasoning/);
    assert.equal(recordedTurn.messages.at(-1).reasoning_content, "private reasoning");
  } finally {
    try {
      streamController?.close();
    } catch {
      // The success path already closes the controlled stream.
    }
    await proxyPromise?.catch(() => {});
    globalThis.fetch = originalFetch;
  }
});

test("streaming chat responses keep one response identity through bridge capability continuation", async () => {
  const originalFetch = globalThis.fetch;
  const seenBodies = [];
  let fetchCount = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body || "{}"));
    seenBodies.push(body);
    fetchCount += 1;
    if (fetchCount === 1) {
      return new Response([
        'data: {"id":"chatcmpl-capability-first","object":"chat.completion.chunk","model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant","content":"I will check. "},"finish_reason":null}]}',
        "",
        'data: {"id":"chatcmpl-capability-first","object":"chat.completion.chunk","model":"deepseek-chat","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_capability","type":"function","function":{"name":"codexbridge_capability","arguments":"{\\"capability\\":\\"browser\\",\\"action\\":\\"read_url\\",\\"input\\":{\\"url\\":\\"https://example.com\\"}}"}}]},"finish_reason":"tool_calls"}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"), {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    }
    return new Response(JSON.stringify({
      id: "chatcmpl-capability-second",
      object: "chat.completion",
      model: "deepseek-chat",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "Final answer." },
        finish_reason: "stop",
      }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const res = collectResponse();
    await proxyChatCompletions(
      { model: "deepseek-test", input: "Read https://example.com", stream: true },
      {
        id: "deepseek-test",
        displayName: "DeepSeek Test",
        api: "chat_completions",
        baseUrl: "https://provider.example/v1",
        model: "deepseek-chat",
        apiKey: "test-key",
      },
      null,
      res,
      {
        capabilityProviders: [{
          id: "local-browser",
          capability: "browser",
          adapter: "local_browser",
          enabled: true,
        }],
        executeCapabilityRequest: async () => ({
          url: "https://example.com",
          text: "Example result",
        }),
      },
    );

    const payloads = parsedSsePayloads(res.body());
    const created = payloads.find((payload) => payload.type === "response.created");
    const completed = payloads.find((payload) => payload.type === "response.completed");
    const done = payloads.find((payload) => payload.type === "response.output_text.done");
    const streamedText = payloads
      .filter((payload) => payload.type === "response.output_text.delta")
      .map((payload) => payload.delta)
      .join("");

    assert.equal(fetchCount, 2);
    assert.equal(seenBodies[0].stream, true);
    assert.equal(seenBodies[1].stream, false);
    assert.equal(created.response.id, completed.response.id);
    assert.equal(streamedText, done.text);
    assert.equal(done.text, completed.response.output_text);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streaming chat responses suppress internal diagnostics without reusing output indexes", () => {
  const toolContext = buildToolContext([{
    type: "function",
    name: "lookup_weather",
    description: "Look up weather.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  }]);
  const stream = createChatCompletionResponsesStream("deepseek-test", toolContext);
  const earlyEvents = [
    ...stream.push(Buffer.from(
      'data: {"id":"chatcmpl-diagnostic","object":"chat.completion.chunk","model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant","content":"Earlier assistant tool use was summarized for provider compatibility"},"finish_reason":null}]}\n\n',
    )),
    ...stream.push(Buffer.from(
      'data: {"id":"chatcmpl-diagnostic","object":"chat.completion.chunk","model":"deepseek-chat","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_weather","type":"function","function":{"name":"lookup_weather","arguments":"{\\"city\\":\\"Beijing\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
    )),
  ];
  const response = chatResponseToResponse(stream.chat, "deepseek-test", toolContext);
  const body = earlyEvents.join("") + stream.finish(response);
  const payloads = parsedSsePayloads(body);
  const addedIndexes = payloads
    .filter((payload) => payload.type === "response.output_item.added")
    .map((payload) => payload.output_index);

  assert.doesNotMatch(body, /Earlier assistant tool use was summarized/);
  assert.equal(new Set(addedIndexes).size, addedIndexes.length);
  assert.deepEqual(
    payloads.find((payload) => payload.type === "response.completed").response.output
      .map((item) => item.type),
    ["function_call"],
  );
});

test("streaming chat responses preserve created_at from response.created to response.completed", () => {
  const originalNow = Date.now;
  try {
    Date.now = () => 1_000;
    const stream = createChatCompletionResponsesStream("deepseek-test");
    const events = stream.push(Buffer.from(
      'data: {"id":"chatcmpl-created-at","object":"chat.completion.chunk","model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant","content":"first"},"finish_reason":null}]}\n\n',
    ));
    Date.now = () => 5_000;
    events.push(...stream.push(Buffer.from(
      'data: {"id":"chatcmpl-created-at","object":"chat.completion.chunk","model":"deepseek-chat","choices":[{"index":0,"delta":{"content":" second"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    )));
    const response = chatResponseToResponse(stream.chat, "deepseek-test");
    const payloads = parsedSsePayloads(events.join("") + stream.finish(response));
    const created = payloads.find((payload) => payload.type === "response.created");
    const completed = payloads.find((payload) => payload.type === "response.completed");

    assert.equal(created.response.created_at, 1);
    assert.equal(completed.response.created_at, created.response.created_at);
  } finally {
    Date.now = originalNow;
  }
});

test("truncated Codex Responses chat streams end with response.failed and DONE", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    'data: {"id":"chatcmpl-cut","object":"chat.completion.chunk","model":"deepseek-reasoner","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
    {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    },
  );

  try {
    const res = collectResponse();
    await assert.rejects(
      proxyChatCompletions(
        { model: "deepseek-test", input: "hello", stream: true },
        {
          id: "deepseek-test",
          displayName: "DeepSeek Test",
          api: "chat_completions",
          baseUrl: "https://provider.example/v1",
          model: "deepseek-reasoner",
          apiKey: "test-key",
        },
        null,
        res,
        {},
      ),
      (error) => error?.code === "upstream_stream_truncated",
    );
    assert.match(res.body(), /response\.failed/);
    assert.match(res.body(), /"code":"upstream_stream_truncated"/);
    assert.match(res.body(), /data: \[DONE\]/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("truncated hidden reasoning leaves the downstream response available for failover", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    'data: {"id":"chatcmpl-reasoning-cut","object":"chat.completion.chunk","model":"deepseek-reasoner","choices":[{"index":0,"delta":{"reasoning_content":"private partial reasoning"},"finish_reason":null}]}\n\n',
    {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    },
  );

  try {
    const res = collectResponse();
    await assert.rejects(
      proxyChatCompletions(
        { model: "deepseek-test", input: "hello", stream: true },
        {
          id: "deepseek-test",
          displayName: "DeepSeek Test",
          api: "chat_completions",
          baseUrl: "https://provider.example/v1",
          model: "deepseek-reasoner",
          apiKey: "test-key",
        },
        null,
        res,
        {},
      ),
      (error) => error?.code === "upstream_stream_truncated",
    );
    assert.equal(res.statusCode, null);
    assert.equal(res.body(), "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mislabeled complete chat SSE still returns a completed Responses stream", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    [
      'data: {"id":"chatcmpl-mislabeled","object":"chat.completion.chunk","model":"deepseek-reasoner","choices":[{"index":0,"delta":{"content":"mislabeled reply"},"finish_reason":"stop"}]}',
      "",
      'data: {"id":"chatcmpl-mislabeled","object":"chat.completion.chunk","model":"deepseek-reasoner","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
    {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    },
  );

  try {
    const res = collectResponse();
    await proxyChatCompletions(
      { model: "deepseek-test", input: "hello", stream: true },
      {
        id: "deepseek-test",
        displayName: "DeepSeek Test",
        api: "chat_completions",
        baseUrl: "https://provider.example/v1",
        model: "deepseek-reasoner",
        apiKey: "test-key",
      },
      null,
      res,
      {},
    );
    assert.match(res.body(), /mislabeled reply/);
    assert.match(res.body(), /response\.completed/);
    assert.match(res.body(), /data: \[DONE\]/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mislabeled chat SSE forwards its first text event before the upstream closes", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  let streamController = null;
  let proxyPromise = null;
  let streamClosed = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      streamController = controller;
      controller.enqueue(encoder.encode(
        'data: {"id":"chatcmpl-mislabeled-live","object":"chat.completion.chunk","model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"first"},"finish_reason":null}]}\n\n',
      ));
    },
  }), {
    status: 200,
    headers: { "content-type": "application/octet-stream" },
  });

  try {
    const res = collectResponse();
    proxyPromise = proxyChatCompletions(
      { model: "deepseek-test", input: "hello", stream: true },
      {
        id: "deepseek-test",
        displayName: "DeepSeek Test",
        api: "chat_completions",
        baseUrl: "https://provider.example/v1",
        model: "deepseek-chat",
        apiKey: "test-key",
      },
      null,
      res,
      {},
    );

    await waitFor(() => res.body().includes('"delta":"first"'), 500);
    assert.doesNotMatch(res.body(), /response\.completed/);

    streamController.enqueue(encoder.encode(
      'data: {"id":"chatcmpl-mislabeled-live","object":"chat.completion.chunk","model":"deepseek-chat","choices":[{"index":0,"delta":{"content":" second"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    ));
    streamController.close();
    streamClosed = true;
    await proxyPromise;
    assert.match(res.body(), /response\.completed/);
  } finally {
    if (!streamClosed && streamController) {
      streamController.enqueue(encoder.encode(
        'data: {"id":"chatcmpl-mislabeled-live","object":"chat.completion.chunk","model":"deepseek-chat","choices":[{"index":0,"delta":{"content":" second"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      ));
      streamController.close();
    }
    await proxyPromise?.catch(() => {});
    globalThis.fetch = originalFetch;
  }
});

test("streaming chat compatibility does not expose provider reasoning tags", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    [
      'data: {"id":"chatcmpl-minimax","object":"chat.completion.chunk","model":"MiniMax-M2.7","choices":[{"index":0,"delta":{"content":"<think>private reasoning</think>visible answer"},"finish_reason":"stop"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
    {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    },
  );

  try {
    const res = collectResponse();
    await proxyChatCompletions(
      { model: "minimax-test", input: "hello", stream: true },
      {
        id: "minimax-test",
        displayName: "MiniMax Test",
        provider: "minimax",
        api: "chat_completions",
        baseUrl: "https://provider.example/v1",
        model: "MiniMax-M2.7",
        apiKey: "test-key",
      },
      null,
      res,
      {},
    );
    assert.doesNotMatch(res.body(), /private reasoning/);
    assert.match(res.body(), /visible answer/);
    assert.match(res.body(), /response\.completed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streaming chat compatibility reconstructs tool calls before returning them to Codex", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    [
      'data: {"id":"chatcmpl-tool","object":"chat.completion.chunk","model":"deepseek-reasoner","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_weather","type":"function","function":{"name":"lookup_weather","arguments":"{\\"city\\":"}}]},"finish_reason":null}]}',
      "",
      'data: {"id":"chatcmpl-tool","object":"chat.completion.chunk","model":"deepseek-reasoner","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Beijing\\"}"}}]},"finish_reason":"tool_calls"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
    {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    },
  );

  try {
    const res = collectResponse();
    await proxyChatCompletions(
      {
        model: "deepseek-test",
        input: "weather",
        stream: true,
        tools: [{
          type: "function",
          name: "lookup_weather",
          description: "Look up weather.",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        }],
      },
      {
        id: "deepseek-test",
        displayName: "DeepSeek Test",
        api: "chat_completions",
        baseUrl: "https://provider.example/v1",
        model: "deepseek-reasoner",
        apiKey: "test-key",
      },
      null,
      res,
      {},
    );
    assert.match(res.body(), /"type":"function_call"/);
    assert.match(res.body(), /"name":"lookup_weather"/);
    assert.match(res.body(), /"arguments":"{\\"city\\":\\"Beijing\\"}"/);
    assert.match(res.body(), /response\.function_call_arguments\.done/);
    assert.match(res.body(), /response\.completed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streaming chat SSE errors terminate as response.failed without a false completion", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    [
      "event: error",
      'data: {"error":{"message":"quota exceeded","code":"rate_limit_exceeded"}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
    {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    },
  );

  try {
    const res = collectResponse();
    await proxyChatCompletions(
      { model: "deepseek-test", input: "hello", stream: true },
      {
        id: "deepseek-test",
        displayName: "DeepSeek Test",
        api: "chat_completions",
        baseUrl: "https://provider.example/v1",
        model: "deepseek-v4-pro",
        apiKey: "test-key",
      },
      null,
      res,
      {},
    );

    const payloads = parsedSsePayloads(res.body());
    const failed = payloads.find((payload) => payload.type === "response.failed");
    assert.equal(failed?.response?.status, "failed");
    assert.equal(failed?.response?.error?.code, "rate_limit_exceeded");
    assert.equal(failed?.response?.error?.message, "quota exceeded");
    assert.equal(payloads.some((payload) => payload.type === "response.completed"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streaming chat ignores sparse tool-call holes and returns only the valid call", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    [
      'data: {"id":"chatcmpl-sparse","object":"chat.completion.chunk","model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"tool_calls":[{"index":2,"id":"call_sparse","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}]},"finish_reason":"tool_calls"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
    {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    },
  );

  try {
    const res = collectResponse();
    await proxyChatCompletions(
      {
        model: "deepseek-test",
        input: "read the file",
        stream: true,
        tools: [{
          type: "function",
          name: "read_file",
          description: "Read one file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        }],
      },
      {
        id: "deepseek-test",
        displayName: "DeepSeek Test",
        api: "chat_completions",
        baseUrl: "https://provider.example/v1",
        model: "deepseek-v4-pro",
        apiKey: "test-key",
      },
      null,
      res,
      {},
    );

    const completed = parsedSsePayloads(res.body())
      .find((payload) => payload.type === "response.completed");
    assert.deepEqual(
      completed?.response?.output.map((item) => ({
        type: item.type,
        name: item.name,
        call_id: item.call_id,
        arguments: item.arguments,
      })),
      [{
        type: "function_call",
        name: "read_file",
        call_id: "call_sparse",
        arguments: '{"path":"a.txt"}',
      }],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streaming chat drops a nameless tool call without discarding a later valid call", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    [
      'data: {"id":"chatcmpl-nameless","object":"chat.completion.chunk","model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_missing_name","type":"function","function":{"arguments":"{}"}},{"index":1,"id":"call_valid","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"b.txt\\"}"}}]},"finish_reason":"tool_calls"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
    {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    },
  );

  try {
    const res = collectResponse();
    await proxyChatCompletions(
      {
        model: "deepseek-test",
        input: "read the file",
        stream: true,
        tools: [{
          type: "function",
          name: "read_file",
          description: "Read one file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        }],
      },
      {
        id: "deepseek-test",
        displayName: "DeepSeek Test",
        api: "chat_completions",
        baseUrl: "https://provider.example/v1",
        model: "deepseek-v4-pro",
        apiKey: "test-key",
      },
      null,
      res,
      {},
    );

    const completed = parsedSsePayloads(res.body())
      .find((payload) => payload.type === "response.completed");
    assert.deepEqual(
      completed?.response?.output.map((item) => item.call_id),
      ["call_valid"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DeepSeek Pro streams reasoning events before answer text arrives", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  let streamController = null;
  let streamClosed = false;
  let proxyPromise = null;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      streamController = controller;
      controller.enqueue(encoder.encode(
        'data: {"id":"chatcmpl-reasoning-live","object":"chat.completion.chunk","model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"reasoning_content":"checking context"},"finish_reason":null}]}\n\n',
      ));
    },
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });

  try {
    const res = collectResponse();
    proxyPromise = proxyChatCompletions(
      { model: "deepseek-v4-pro", input: "solve it", stream: true },
      {
        id: "deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        provider: "deepseek",
        api: "chat_completions",
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-v4-pro",
        apiKey: "test-key",
      },
      null,
      res,
      {},
    );

    await waitFor(
      () => res.body().includes("response.reasoning_summary_text.delta"),
      500,
    );
    assert.match(res.body(), /checking context/);
    assert.doesNotMatch(res.body(), /response\.output_text\.delta/);

    streamController.enqueue(encoder.encode(
      'data: {"id":"chatcmpl-reasoning-live","object":"chat.completion.chunk","model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"content":"final answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    ));
    streamController.close();
    streamClosed = true;
    await proxyPromise;

    const payloads = parsedSsePayloads(res.body());
    const completed = payloads.find((payload) => payload.type === "response.completed");
    assert.deepEqual(
      completed?.response?.output.map((item) => item.type),
      ["reasoning", "message"],
    );
    assert.equal(completed.response.output[0].summary[0].text, "checking context");
    assert.equal(completed.response.output_text, "final answer");
  } finally {
    if (!streamClosed && streamController) {
      streamController.enqueue(encoder.encode(
        'data: {"id":"chatcmpl-reasoning-live","object":"chat.completion.chunk","model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"content":"final answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      ));
      streamController.close();
    }
    await proxyPromise?.catch(() => {});
    globalThis.fetch = originalFetch;
  }
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

test("sendUpstreamError identifies exhausted ChatGPT subscription quota", () => {
  const res = collectResponse();
  sendUpstreamError(
    res,
    new UpstreamHttpError(
      429,
      JSON.stringify({ detail: "The usage limit has been reached" }),
      "https://chatgpt.com/backend-api/codex/responses",
      {
        id: "cb-gpt-5-6-terra",
        displayName: "GPT-5.6-Terra",
        model: "gpt-5.6-terra",
        api: "responses",
        authMode: "codex_openai",
      },
    ),
  );

  const body = JSON.parse(res.body());
  assert.equal(res.statusCode, 429);
  assert.equal(body.error.code, "upstream_subscription_quota_exhausted");
  assert.match(body.error.message, /ChatGPT \/ Codex/);
  assert.match(body.error.message, /订阅额度已用完|额度重置/);
  assert.doesNotMatch(body.error.message, /供应商限流/);
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

test("codex_openai forwards GPT reasoning summaries before answer text completes", async () => {
  const originalBackend = process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL;
  let upstreamResponse = null;
  let proxyPromise = null;

  const upstream = httpServer(async (req, res) => {
    await readRequestJson(req);
    upstreamResponse = res;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.write(
      "event: response.reasoning_summary_text.delta\n" +
        `data: ${JSON.stringify({
          type: "response.reasoning_summary_text.delta",
          delta: "checking the project",
        })}\n\n`,
    );
  });

  try {
    await listen(upstream);
    process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL = `${serverUrl(upstream)}/backend-api/codex`;

    const res = collectResponse();
    proxyPromise = proxyResponsesApi(
      { model: "gpt-5.6-sol", input: "inspect it", stream: true },
      {
        id: "gpt-5.6-sol",
        api: "responses",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.6-sol",
        authMode: "codex_openai",
      },
      new ResponseHistory(),
      res,
      {
        clientAuth: {
          kind: "codex_openai",
          bearerToken: "codex-openai-token",
        },
      },
    );

    await waitFor(
      () => res.body().includes("response.reasoning_summary_text.delta"),
      500,
    );
    assert.match(res.body(), /checking the project/);
    assert.doesNotMatch(res.body(), /response\.output_text\.delta/);
    assert.doesNotMatch(res.body(), /response\.completed/);

    upstreamResponse.write(
      "event: response.output_text.delta\n" +
        `data: ${JSON.stringify({
          type: "response.output_text.delta",
          delta: "final answer",
        })}\n\n`,
    );
    upstreamResponse.write(
      "event: response.completed\n" +
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_gpt_summary_stream",
            status: "completed",
            model: "gpt-5.6-sol",
            output: [],
          },
        })}\n\n`,
    );
    upstreamResponse.end("data: [DONE]\n\n");
    await proxyPromise;

    assert.match(res.body(), /final answer/);
    assert.match(res.body(), /response\.completed/);
  } finally {
    if (originalBackend === undefined) {
      delete process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL;
    } else {
      process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL = originalBackend;
    }
    upstreamResponse?.end();
    await proxyPromise?.catch(() => {});
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

test("mislabeled Responses SSE is terminalized when upstream ends after response.created", async () => {
  const originalFetch = globalThis.fetch;
  const responseCreated = [
    "event: response.created",
    `data: ${JSON.stringify({
      type: "response.created",
      response: {
        id: "resp_sol_truncated",
        object: "response",
        status: "in_progress",
        model: "gpt-5.6-sol",
        output: [],
      },
    })}`,
    "",
    "",
  ].join("\n");

  globalThis.fetch = async () =>
    new Response(responseCreated, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });

  try {
    const res = collectResponse();
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
          baseUrl: "https://chatgpt.com/backend-api/codex",
          model: "gpt-5.6-sol",
          authMode: "codex_openai",
        },
        res,
        {
          requestId: "req_sol_mislabeled_sse",
          clientAuth: {
            kind: "codex_openai",
            bearerToken: "codex-openai-token",
          },
        },
      ),
      (error) =>
        error?.name === "UpstreamStreamError" &&
        error?.code === "upstream_stream_truncated",
    );

    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers?.["content-type"] || ""), /text\/event-stream/);
    assert.match(res.body(), /response\.created/);
    assert.match(res.body(), /response\.failed/);
    assert.match(res.body(), /upstream_stream_truncated/);
    assert.match(res.body(), /data: \[DONE\]/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mislabeled completed Responses SSE is passed through as a successful stream", async () => {
  const originalFetch = globalThis.fetch;
  const completedResponse = {
    id: "resp_mislabeled_complete",
    object: "response",
    status: "completed",
    model: "gpt-5.6-terra",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "ok" }],
      },
    ],
    usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
  };
  const responseBody = [
    "event: response.created",
    `data: ${JSON.stringify({
      type: "response.created",
      response: { ...completedResponse, status: "in_progress", output: [] },
    })}`,
    "",
    "event: response.completed",
    `data: ${JSON.stringify({
      type: "response.completed",
      response: completedResponse,
    })}`,
    "",
    "",
  ].join("\n");

  globalThis.fetch = async () =>
    new Response(responseBody, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });

  try {
    const res = collectResponse();
    await proxyResponsesApi(
      {
        model: "gpt-5.6-terra",
        input: "hello",
        stream: true,
      },
      {
        id: "cb-gpt-5-6-terra",
        displayName: "GPT-5.6-Terra",
        api: "responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        model: "gpt-5.6-terra",
        authMode: "codex_openai",
      },
      res,
      {
        requestId: "req_terra_mislabeled_sse",
        clientAuth: {
          kind: "codex_openai",
          bearerToken: "codex-openai-token",
        },
      },
    );

    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers?.["content-type"] || ""), /text\/event-stream/);
    assert.match(res.body(), /response\.completed/);
    assert.doesNotMatch(res.body(), /response\.failed/);
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

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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

function parsedSsePayloads(body) {
  return parseSseEvents(body)
    .map((event) => {
      try {
        return JSON.parse(event.data);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function backpressuredResponse() {
  const response = new EventEmitter();
  response.statusCode = null;
  response.headers = null;
  response.writes = [];
  response.destroyed = false;
  response.writableEnded = false;
  response.writeHead = (statusCode, headers) => {
    response.statusCode = statusCode;
    response.headers = headers;
  };
  response.write = (chunk) => {
    response.writes.push(Buffer.from(chunk));
    return response.writes.length !== 1;
  };
  response.end = (chunk) => {
    if (chunk) {
      response.writes.push(Buffer.from(chunk));
    }
    response.writableEnded = true;
  };
  return response;
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for test condition.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
