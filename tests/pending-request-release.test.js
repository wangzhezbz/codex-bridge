import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRouterServer } from "../src/server.js";
import { __resetRateLimiterForTests } from "../src/rate-limit.js";

for (const statusCode of [401, 402, 429, 500]) {
  test(`pending exact protection releases after upstream HTTP ${statusCode}`, async () => {
    __resetRateLimiterForTests();
    let upstreamCalls = 0;
    const upstream = http.createServer(async (req, res) => {
      upstreamCalls += 1;
      await readJson(req);
      if (upstreamCalls === 1) {
        res.writeHead(statusCode, {
          "content-type": "application/json",
          ...(statusCode === 429 ? { "retry-after": "0.001" } : {}),
        });
        res.end(JSON.stringify({ error: { message: `provider failure ${statusCode}` } }));
        return;
      }
      sendChatSuccess(res, `recovered after ${statusCode}`);
    });

    await listen(upstream);
    const router = createRouterServer(routerConfig(upstream, {
      cooldownMs: 1,
      maxCooldownMs: 1,
      localRateLimitEnabled: false,
    }));
    await listen(router);
    const request = exactCodexRequest(`retry after ${statusCode}`);

    try {
      const first = await requestText(`${serverUrl(router)}/v1/responses`, request);
      assert.match(first.body, /response\.failed|provider failure|HTTP/);

      const second = await requestText(`${serverUrl(router)}/v1/responses`, request);
      assert.equal(second.statusCode, 200);
      assert.match(second.body, new RegExp(`recovered after ${statusCode}`));
      assert.doesNotMatch(second.body, /没有重复请求上游/);
      assert.equal(upstreamCalls, 2);
    } finally {
      await close(router);
      await close(upstream);
      __resetRateLimiterForTests();
    }
  });
}

test("pending exact protection releases after an upstream timeout", async () => {
  let upstreamCalls = 0;
  const upstream = http.createServer(async (req, res) => {
    upstreamCalls += 1;
    await readJson(req);
    if (upstreamCalls === 1) {
      return;
    }
    sendChatSuccess(res, "recovered after timeout");
  });

  await listen(upstream);
  const router = createRouterServer(routerConfig(upstream, { upstreamTimeoutMs: 25 }));
  await listen(router);
  const request = exactCodexRequest("retry after timeout");

  try {
    const first = await requestText(`${serverUrl(router)}/v1/responses`, request);
    assert.match(first.body, /超时|upstream_timeout/i);

    const second = await requestText(`${serverUrl(router)}/v1/responses`, request);
    assert.equal(second.statusCode, 200);
    assert.match(second.body, /recovered after timeout/);
    assert.doesNotMatch(second.body, /没有重复请求上游/);
    assert.equal(upstreamCalls, 2);
  } finally {
    router.closeAllConnections?.();
    upstream.closeAllConnections?.();
    await close(router);
    await close(upstream);
  }
});

test("pending exact protection releases after a local Key error", async () => {
  let upstreamCalls = 0;
  const upstream = http.createServer(async (req, res) => {
    upstreamCalls += 1;
    await readJson(req);
    sendChatSuccess(res, "recovered after local Key fix");
  });

  await listen(upstream);
  const config = routerConfig(upstream);
  delete config.models[0].apiKey;
  config.configRevision = "before-key-fix";
  const router = createRouterServer(config);
  await listen(router);
  const request = exactCodexRequest("retry after local Key fix");

  try {
    const first = await requestText(`${serverUrl(router)}/v1/responses`, request);
    assert.match(first.body, /缺少 API Key|missing_provider_api_key/);
    assert.equal(upstreamCalls, 0);

    config.models[0].apiKey = "test-upstream-key";
    config.configRevision = "after-key-fix";
    const second = await requestText(`${serverUrl(router)}/v1/responses`, request);
    assert.equal(second.statusCode, 200);
    assert.match(second.body, /recovered after local Key fix/);
    assert.doesNotMatch(second.body, /没有重复请求上游/);
    assert.equal(upstreamCalls, 1);
  } finally {
    await close(router);
    await close(upstream);
  }
});

test("direct Chat Completions protects only the concurrent exact request", async () => {
  let upstreamCalls = 0;
  const gate = deferred();
  const entered = deferred();
  const upstream = http.createServer(async (req, res) => {
    upstreamCalls += 1;
    await readJson(req);
    entered.resolve();
    await gate.promise;
    sendChatSuccess(res, `direct chat owner ${upstreamCalls}`);
  });

  await listen(upstream);
  const router = createRouterServer(routerConfig(upstream));
  await listen(router);
  const request = {
    ...exactCodexRequest("direct chat concurrent exact request"),
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      stream: false,
      messages: [{ role: "user", content: "direct chat concurrent exact request" }],
    }),
  };

  const owner = requestText(`${serverUrl(router)}/v1/chat/completions`, request);
  await entered.promise;
  const duplicate = requestText(`${serverUrl(router)}/v1/chat/completions`, request);

  try {
    const duplicateResponse = await within(duplicate);
    assert.equal(duplicateResponse.statusCode, 200);
    assert.match(duplicateResponse.body, /没有重复请求上游/);
    assert.equal(upstreamCalls, 1);

    gate.resolve();
    const ownerResponse = await owner;
    assert.match(ownerResponse.body, /direct chat owner 1/);

    const manualRetry = await requestText(
      `${serverUrl(router)}/v1/chat/completions`,
      request,
    );
    assert.match(manualRetry.body, /direct chat owner 2/);
    assert.equal(upstreamCalls, 2);
  } finally {
    gate.resolve();
    await Promise.allSettled([owner, duplicate]);
    await close(router);
    await close(upstream);
  }
});

test("explicit capability execution protects concurrent side effects and releases after finish", async () => {
  let capabilityCalls = 0;
  const gate = deferred();
  const entered = deferred();
  const capabilityUpstream = http.createServer(async (req, res) => {
    capabilityCalls += 1;
    await readJson(req);
    entered.resolve();
    await gate.promise;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ text: `capability owner ${capabilityCalls}` }));
  });

  await listen(capabilityUpstream);
  const config = routerConfig(capabilityUpstream);
  config.capabilityProviders = [
    {
      id: "search-provider",
      name: "Search Provider",
      capability: "web_search",
      adapter: "generic_http",
      baseUrl: `${serverUrl(capabilityUpstream)}/v1`,
      endpoint: "/search",
      apiKey: "test-capability-key",
      default: true,
    },
  ];
  const router = createRouterServer(config);
  await listen(router);
  const request = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer router-token",
      "user-agent": "Codex Desktop/Task5-Capability-Test",
      "x-codex-thread-id": "thread_pending_capability",
    },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      codexbridge_capability: {
        capability: "web_search",
        input: { query: "run this side effect once" },
      },
    }),
  };

  const owner = requestText(`${serverUrl(router)}/v1/responses`, request);
  await entered.promise;
  const duplicate = requestText(`${serverUrl(router)}/v1/responses`, request);

  try {
    const duplicateResponse = await within(duplicate);
    assert.equal(duplicateResponse.statusCode, 200);
    assert.match(duplicateResponse.body, /没有重复请求上游/);
    assert.equal(capabilityCalls, 1);

    gate.resolve();
    const ownerResponse = await owner;
    assert.match(ownerResponse.body, /capability owner 1/);

    const manualRetry = await requestText(`${serverUrl(router)}/v1/responses`, request);
    assert.match(manualRetry.body, /capability owner 2/);
    assert.equal(capabilityCalls, 2);
  } finally {
    gate.resolve();
    await Promise.allSettled([owner, duplicate]);
    await close(router);
    await close(capabilityUpstream);
  }
});

test("capability ownership survives client disconnect until the side effect settles", async () => {
  let capabilityCalls = 0;
  const gate = deferred();
  const entered = deferred();
  const capabilityUpstream = http.createServer(async (req, res) => {
    capabilityCalls += 1;
    await readJson(req);
    entered.resolve();
    await gate.promise;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ text: `disconnect owner ${capabilityCalls}` }));
  });

  await listen(capabilityUpstream);
  const config = routerConfig(capabilityUpstream);
  config.capabilityProviders = [
    {
      id: "search-provider",
      capability: "web_search",
      adapter: "generic_http",
      baseUrl: `${serverUrl(capabilityUpstream)}/v1`,
      endpoint: "/search",
      apiKey: "test-capability-key",
      default: true,
    },
  ];
  const router = createRouterServer(config);
  await listen(router);
  const request = capabilityRequest();
  const owner = startRequest(`${serverUrl(router)}/v1/responses`, request);
  await entered.promise;
  owner.abort();
  await owner.promise.catch(() => {});

  try {
    const reconnect = await within(
      requestText(`${serverUrl(router)}/v1/responses`, request),
    );
    assert.match(reconnect.body, /没有重复请求上游/);
    assert.equal(capabilityCalls, 1);

    gate.resolve();
    const manualRetry = await eventuallyRequestUpstream(
      `${serverUrl(router)}/v1/responses`,
      request,
    );
    assert.match(manualRetry.body, /disconnect owner 2/);
    assert.equal(capabilityCalls, 2);
  } finally {
    gate.resolve();
    await close(router);
    await close(capabilityUpstream);
  }
});

for (const requestSurface of ["Responses", "direct Chat"]) {
  test(`missing duplicate protection bypasses ${requestSurface} fingerprinting and ownership`, async () => {
    let upstreamCalls = 0;
    const gate = deferred();
    const bothEntered = deferred();
    const upstream = http.createServer(async (req, res) => {
      upstreamCalls += 1;
      await readJson(req);
      if (upstreamCalls === 2) {
        bothEntered.resolve();
      }
      await gate.promise;
      sendChatSuccess(res, `missing protection upstream ${upstreamCalls}`);
    });

    await listen(upstream);
    const config = routerConfig(upstream);
    delete config.duplicateRequestProtection;
    const router = createRouterServer(config);
    await listen(router);
    const directChat = requestSurface === "direct Chat";
    const request = directChat
      ? {
          ...exactCodexRequest("missing protection direct chat"),
          body: JSON.stringify({
            model: "deepseek-v4-pro",
            stream: false,
            messages: [{ role: "user", content: "missing protection direct chat" }],
          }),
        }
      : exactCodexRequest("missing protection responses");
    const endpoint = directChat ? "/v1/chat/completions" : "/v1/responses";
    const requests = [
      requestText(`${serverUrl(router)}${endpoint}`, request),
      requestText(`${serverUrl(router)}${endpoint}`, request),
    ];

    try {
      await within(bothEntered.promise);
      assert.equal(upstreamCalls, 2);
      gate.resolve();
      const responses = await Promise.all(requests);
      for (const response of responses) {
        assert.equal(response.statusCode, 200);
        assert.match(response.body, /missing protection upstream/);
        assert.doesNotMatch(response.body, /没有重复请求上游|没有再次请求上游/);
      }
    } finally {
      gate.resolve();
      await Promise.allSettled(requests);
      await close(router);
      await close(upstream);
    }
  });
}

test("missing duplicate protection bypasses capability fingerprinting and ownership", async () => {
  let capabilityCalls = 0;
  const gate = deferred();
  const bothEntered = deferred();
  const capabilityUpstream = http.createServer(async (req, res) => {
    capabilityCalls += 1;
    await readJson(req);
    if (capabilityCalls === 2) {
      bothEntered.resolve();
    }
    await gate.promise;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ text: `missing protection capability ${capabilityCalls}` }));
  });

  await listen(capabilityUpstream);
  const config = routerConfig(capabilityUpstream);
  delete config.duplicateRequestProtection;
  config.capabilityProviders = [
    {
      id: "search-provider",
      capability: "web_search",
      adapter: "generic_http",
      baseUrl: `${serverUrl(capabilityUpstream)}/v1`,
      endpoint: "/search",
      apiKey: "test-capability-key",
      default: true,
    },
  ];
  const router = createRouterServer(config);
  await listen(router);
  const request = capabilityRequest();
  const requests = [
    requestText(`${serverUrl(router)}/v1/responses`, request),
    requestText(`${serverUrl(router)}/v1/responses`, request),
  ];

  try {
    await within(bothEntered.promise);
    assert.equal(capabilityCalls, 2);
    gate.resolve();
    const responses = await Promise.all(requests);
    for (const response of responses) {
      assert.equal(response.statusCode, 200);
      assert.match(response.body, /missing protection capability/);
      assert.doesNotMatch(response.body, /没有重复请求上游|没有再次请求上游/);
    }
  } finally {
    gate.resolve();
    await Promise.allSettled(requests);
    await close(router);
    await close(capabilityUpstream);
  }
});

for (const requestSurface of ["responses", "chat_completions"]) {
  test(`${requestSurface} cancels a stalled upstream body and releases pending ownership`, async () => {
    let upstreamCalls = 0;
    const upstreamCancelled = deferred();
    const upstream = http.createServer(async (req, res) => {
      upstreamCalls += 1;
      await readJson(req);
      if (upstreamCalls === 1) {
        res.on("close", () => upstreamCancelled.resolve());
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        if (requestSurface === "responses") {
          res.write(
            `event: response.output_text.delta\ndata: ${JSON.stringify({
              type: "response.output_text.delta",
              delta: "partial before stalled body",
            })}\n\n`,
          );
        } else {
          res.write(
            `data: ${JSON.stringify({
              id: "chatcmpl_stalled",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { content: "partial before stall" } }],
            })}\n\n`,
          );
        }
        return;
      }
      if (requestSurface === "responses") {
        sendResponsesSuccessSse(res, "recovered responses stream");
      } else {
        sendChatSuccessSse(res, "recovered direct chat stream");
      }
    });

    await listen(upstream);
    const config = requestSurface === "responses"
      ? responsesRouterConfig(upstream)
      : routerConfig(upstream);
    const router = createRouterServer(config);
    await listen(router);
    const request = requestSurface === "responses"
      ? exactCodexRequest("retry after stalled responses body")
      : {
          ...exactCodexRequest("retry after stalled direct chat body"),
          body: JSON.stringify({
            model: "deepseek-v4-pro",
            stream: true,
            messages: [{ role: "user", content: "retry after stalled direct chat body" }],
          }),
        };
    const endpoint = requestSurface === "responses"
      ? "/v1/responses"
      : "/v1/chat/completions";
    const owner = startStreamingRequest(`${serverUrl(router)}${endpoint}`, request);

    try {
      await within(owner.started);
      owner.abort();
      await owner.promise.catch(() => {});
      await within(upstreamCancelled.promise);

      const manualRetry = await within(
        requestText(`${serverUrl(router)}${endpoint}`, request),
      );
      assert.equal(manualRetry.statusCode, 200);
      assert.match(
        manualRetry.body,
        requestSurface === "responses"
          ? /recovered responses stream/
          : /recovered direct chat stream/,
      );
      assert.doesNotMatch(manualRetry.body, /没有重复请求上游/);
      assert.equal(upstreamCalls, 2);
    } finally {
      owner.abort();
      router.closeAllConnections?.();
      upstream.closeAllConnections?.();
      await close(router);
      await close(upstream);
    }
  });
}

function routerConfig(upstream, routeOverrides = {}) {
  return {
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    configRevision: "pending-release-test",
    duplicateRequestProtection: true,
    defaultModel: "deepseek-v4-pro",
    models: [
      {
        id: "deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        provider: "deepseek",
        api: "chat_completions",
        baseUrl: `${serverUrl(upstream)}/v1`,
        model: "deepseek-v4-pro",
        apiKey: "test-upstream-key",
        ...routeOverrides,
      },
    ],
  };
}

function responsesRouterConfig(upstream) {
  return {
    host: "127.0.0.1",
    port: 0,
    authToken: "router-token",
    configRevision: "pending-responses-stream-release-test",
    duplicateRequestProtection: true,
    defaultModel: "deepseek-v4-pro",
    models: [
      {
        id: "deepseek-v4-pro",
        displayName: "Responses Test Route",
        provider: "openai-compatible",
        api: "responses",
        baseUrl: `${serverUrl(upstream)}/v1`,
        model: "deepseek-v4-pro",
        apiKey: "test-upstream-key",
      },
    ],
  };
}

function exactCodexRequest(input) {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer router-token",
      "user-agent": "Codex Desktop/Task5-Release-Test",
      "x-codex-thread-id": "thread_pending_release",
      "x-codex-turn-state": "turn_pending_release",
    },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      stream: true,
      input,
    }),
  };
}

function capabilityRequest() {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer router-token",
      "user-agent": "Codex Desktop/Task5-Capability-Disconnect-Test",
      "x-codex-thread-id": "thread_pending_capability_disconnect",
    },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      codexbridge_capability: {
        capability: "web_search",
        input: { query: "keep ownership while this side effect runs" },
      },
    }),
  };
}

function sendChatSuccess(res, content) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "chatcmpl_pending_release",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
}

function sendResponsesSuccessSse(res, content) {
  const response = {
    id: "resp_recovered_stream",
    object: "response",
    status: "completed",
    model: "deepseek-v4-pro",
    output: [
      {
        id: "msg_recovered_stream",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: content, annotations: [] }],
      },
    ],
    output_text: content,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  res.end(
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response,
    })}\n\ndata: [DONE]\n\n`,
  );
}

function sendChatSuccessSse(res, content) {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  res.end(
    `data: ${JSON.stringify({
      id: "chatcmpl_recovered_stream",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content }, finish_reason: "stop" }],
    })}\n\ndata: [DONE]\n\n`,
  );
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function serverUrl(server) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function requestText(url, init = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: init.method || "GET",
        headers: init.headers || {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode || 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (init.body) {
      req.write(init.body);
    }
    req.end();
  });
}

function startRequest(url, init = {}) {
  const target = new URL(url);
  let req;
  const promise = new Promise((resolve, reject) => {
    req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: init.method || "GET",
        headers: init.headers || {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({
          statusCode: res.statusCode || 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    req.on("error", reject);
    if (init.body) {
      req.write(init.body);
    }
    req.end();
  });
  return {
    promise,
    abort() {
      req.destroy(new Error("test client disconnected"));
    },
  };
}

function startStreamingRequest(url, init = {}) {
  const target = new URL(url);
  const started = deferred();
  let req;
  let response;
  const promise = new Promise((resolve, reject) => {
    req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: init.method || "GET",
        headers: init.headers || {},
      },
      (res) => {
        response = res;
        const chunks = [];
        res.on("data", (chunk) => {
          chunks.push(chunk);
          started.resolve();
        });
        res.on("aborted", () => reject(new Error("test response aborted")));
        res.on("error", reject);
        res.on("end", () => resolve({
          statusCode: res.statusCode || 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    req.on("error", reject);
    if (init.body) {
      req.write(init.body);
    }
    req.end();
  });
  return {
    promise,
    started: started.promise,
    abort() {
      response?.destroy();
      req.destroy(new Error("test streaming client disconnected"));
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function within(promise, timeoutMs = 500) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("pending duplicate response timed out")), timeoutMs);
    }),
  ]);
}

async function eventuallyRequestUpstream(url, init, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await requestText(url, init);
    if (!response.body.includes("没有重复请求上游")) {
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("pending capability owner did not release after execution settled");
}
