import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { normalizeAdapterProfile, reasoningParamsForAdapter } from "../src/adapter-profile.js";
import { responsesToChatRequest } from "../src/responses-to-chat.js";
import { ResponseHistory } from "../src/history.js";
import { createRouterServer } from "../src/server.js";
import { MODEL_PRESETS } from "../desktop/presets.mjs";

const chatRoute = (model = "deepseek-flash", extra = {}) => ({
  id: "cb-deepseek41-test", provider: "deepseek", api: "chat_completions", model,
  baseUrl: "https://api.deepseek.com", authMode: "api_key", contextWindow: 1048576,
  ...extra,
});
const tool = { type: "function", name: "inspect", parameters: { type: "object", properties: {} } };

test("DeepSeek's current model name retains Chat thinking controls", () => {
  const profile = normalizeAdapterProfile(chatRoute());
  assert.equal(profile.capabilities.reasoning.mode, "deepseek-thinking");
  assert.deepEqual(profile.capabilities.reasoning.params, ["reasoning_effort", "thinking"]);
  assert.equal(profile.dropParams.includes("thinking"), false);
});

// Expected mappings are from the official Thinking Mode table, not the adapter.
for (const model of ["deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash"]) {
  for (const [requested, actual] of [
    ["minimal", "low"], ["low", "low"], ["medium", "high"], ["high", "high"],
    ["xhigh", "high"], ["max", "max"], ["ultra", "max"],
  ]) {
    test(`${model}: Chat maps ${requested} to official ${actual} effort`, () => {
      const request = { input: "inspect", reasoning: { effort: requested } };
      const converted = responsesToChatRequest(request, chatRoute(model), new ResponseHistory());
      assert.equal(converted.body.reasoning_effort, actual);
      assert.deepEqual(converted.body.thinking, { type: "enabled" });
      assert.equal(request.reasoning.effort, requested);
    });
  }
  test(`${model}: explicit none and disabled really turn thinking off`, () => {
    for (const request of [{ reasoning: { effort: "none" } }, { thinking: { type: "disabled" } }]) {
      const converted = responsesToChatRequest({ input: "quick reply", ...request }, chatRoute(model), new ResponseHistory());
      assert.deepEqual(converted.body.thinking, { type: "disabled" });
      assert.equal(converted.body.reasoning_effort, undefined);
    }
    assert.deepEqual(reasoningParamsForAdapter({}, chatRoute(model)), {});
  });
}

test("DeepSeek's new Chat name retains reasoning across consecutive tool turns", () => {
  const input = [{ role: "user", content: "inspect both steps" }];
  for (const index of [1, 2]) input.push(
    { type: "reasoning", content: [{ type: "reasoning_text", text: `reason-${index}` }] },
    { type: "function_call", name: "inspect", call_id: `call_${index}`, arguments: "{}" },
    { type: "function_call_output", call_id: `call_${index}`, output: `result-${index}` },
  );
  const request = { input, tools: [tool], reasoning: { effort: "high" } };
  const before = structuredClone(request);
  const result = responsesToChatRequest(request, chatRoute(), new ResponseHistory());
  const calls = result.body.messages.filter(message => message.tool_calls?.length);
  assert.deepEqual(calls.map(message => [message.tool_calls[0].id, message.reasoning_content]), [
    ["call_1", "reason-1"], ["call_2", "reason-2"],
  ]);
  assert.deepEqual(result.body.messages.filter(message => message.role === "tool").map(message => message.content), ["result-1", "result-2"]);
  assert.deepEqual(request, before);
  const generic = responsesToChatRequest(request, chatRoute("custom-model", { provider: "custom", baseUrl: "https://example.invalid" }), new ResponseHistory());
  assert.equal(generic.body.messages.some(message => "reasoning_content" in message), false);
});

test("official DeepSeek effort fixes do not alter third-party or retired model contracts", () => {
  const request = { reasoning: { effort: "xhigh" } };
  assert.deepEqual(reasoningParamsForAdapter(request, chatRoute("deepseek-ai/DeepSeek-V4-Pro", { provider: "siliconflow" })), {
    reasoning_effort: "max", thinking: { type: "enabled" },
  });
  assert.deepEqual(reasoningParamsForAdapter(request, chatRoute("deepseek-reasoner")), {});
  assert.deepEqual(reasoningParamsForAdapter(request, chatRoute("deepseek-flash-unverified")), {});
});

async function listen(t, server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function send(router, route, body) {
  return fetch(`${router}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer local-deepseek41-test" },
    body: JSON.stringify({ model: route.id, ...body }),
  });
}

test("DeepSeek's current Chat name streams reasoning and text before the terminal event", { timeout: 10000 }, async t => {
  const complete = Promise.withResolvers();
  t.after(() => complete.resolve());
  let seen;
  const upstream = await listen(t, http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen = { path: req.url, body: JSON.parse(raw) };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const delta of [{ reasoning_content: "REASONING_STEP" }, { content: "VISIBLE_REPLY" }]) {
      res.write(`data: ${JSON.stringify({ id: "chatcmpl_ds41", model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    }
    await complete.promise;
    if (res.destroyed) return;
    res.end(`data: ${JSON.stringify({ id: "chatcmpl_ds41", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  }));
  const route = chatRoute("deepseek-flash", { baseUrl: upstream, apiKey: "fixture-key" });
  const router = await listen(t, createRouterServer({ models: [route], defaultModel: route.id,
    authTokenEnv: "", authToken: "local-deepseek41-test" }, { history: new ResponseHistory() }));
  const response = await send(router, route, { input: "answer briefly", stream: true, reasoning: { effort: "low" } });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (!output.includes("VISIBLE_REPLY")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, "visible text must be received before EOF");
      output += decoder.decode(chunk.value, { stream: true });
    }
    assert.match(output, /response\.reasoning_summary_text\.delta/);
    assert.match(output, /REASONING_STEP/);
    assert.doesNotMatch(output, /response\.completed/);
    assert.equal(seen.path, "/chat/completions");
    assert.equal(seen.body.reasoning_effort, "low");
    assert.deepEqual(seen.body.thinking, { type: "enabled" });
  } finally {
    complete.resolve();
    await reader.cancel();
  }
});

test("DeepSeek Responses replays full tool reasoning and image history without relying on server storage", { timeout: 10000 }, async t => {
  const seen = [];
  const image = { type: "input_image", image_url: "https://example.invalid/input.png", detail: "original" };
  const reasoning = { type: "reasoning", id: "rs_ds41", content: [{ type: "reasoning_text", text: "inspect the image" }], summary: [] };
  const call = { type: "function_call", id: "fc_ds41", name: "inspect", call_id: "call_ds41", arguments: "{}", status: "completed" };
  const upstream = await listen(t, http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.push({ path: req.url, body: JSON.parse(raw) });
    const output = seen.length === 1 ? [reasoning, call] : [{ type: "message", id: "msg_ds41", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] }];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: seen.length === 1 ? "resp_ds41_first" : "resp_ds41_second", object: "response", model: "deepseek-flash", status: "completed", store: false, output }));
  }));
  const route = chatRoute("deepseek-flash", { api: "responses", baseUrl: upstream, apiKey: "fixture-key", inputModalities: ["text", "image"], supportsResponsePreviousId: false, supportsFiles: "text-placeholder" });
  const router = await listen(t, createRouterServer({ models: [route], defaultModel: route.id,
    authTokenEnv: "", authToken: "local-deepseek41-test" }, { history: new ResponseHistory() }));
  const first = await send(router, route, { input: [{ role: "user", content: [{ type: "input_text", text: "inspect" }, image] }], tools: [tool], reasoning: { effort: "low" } });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.id, "resp_ds41_first");
  const second = await send(router, route, { previous_response_id: firstBody.id,
    input: [{ type: "function_call_output", call_id: "call_ds41", output: [{ type: "input_image", image_url: "https://example.invalid/result.png" }] }], tools: [tool], reasoning: { effort: "low" } });
  assert.equal(second.status, 200);
  await second.json();
  assert.equal(seen.length, 2);
  for (const request of seen) {
    assert.equal(request.path, "/responses");
    assert.equal(request.body.model, "deepseek-flash");
    assert.equal(request.body.reasoning.effort, "low");
    assert.equal(request.body.previous_response_id, undefined);
  }
  const input = seen[1].body.input;
  assert.ok(input.some(item => item.content?.some?.(part => part.image_url === image.image_url)));
  assert.ok(input.some(item => item.type === "reasoning" && item.content?.[0]?.text === "inspect the image"));
  assert.ok(input.some(item => item.type === "function_call" && item.call_id === "call_ds41"));
  assert.ok(input.some(item => item.type === "function_call_output" && item.call_id === "call_ds41" && item.output?.[0]?.image_url === "https://example.invalid/result.png"));
});

for (const prefix of ["", "/v1"]) {
  test(`V4.1 Flash preset streams native Responses at ${prefix || "root"} without requiring DONE`, { timeout: 10000 }, async t => {
    const complete = Promise.withResolvers();
    t.after(() => complete.resolve());
    let seen;
    const upstream = await listen(t, http.createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      seen = { path: req.url, body: JSON.parse(raw) };
      const response = { id: "resp_native_ds41", object: "response", model: "deepseek-flash", status: "in_progress", output: [] };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response })}\n\n`);
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_ds41", output_index: 0, content_index: 0, delta: "NATIVE_INCREMENT" })}\n\n`);
      await complete.promise;
      if (res.destroyed) return;
      res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: {
        ...response, status: "completed", output: [{ type: "message", id: "msg_ds41", role: "assistant", status: "completed", content: [{ type: "output_text", text: "NATIVE_INCREMENT", annotations: [] }] }],
      } })}\n\n`);
    }));
    const preset = MODEL_PRESETS.find(model => model.presetId === "deepseek-v4-1-flash");
    assert.ok(preset);
    const route = { ...preset, id: "cb-deepseek-v4-1-flash", provider: preset.providerId, baseUrl: `${upstream}${prefix}`, apiKey: "fixture-key" };
    const router = await listen(t, createRouterServer({ models: [route], defaultModel: route.id,
      authTokenEnv: "", authToken: "local-deepseek41-test" }, { history: new ResponseHistory() }));
    const image = { type: "input_image", image_url: "https://example.invalid/native.png", detail: "original" };
    const response = await send(router, route, { stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "describe" }, image] }], tools: [tool], reasoning: { effort: "none" } });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let output = "";
    try {
      while (!output.includes("NATIVE_INCREMENT")) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        output += decoder.decode(chunk.value, { stream: true });
      }
      assert.doesNotMatch(output, /response\.completed/);
      assert.equal(seen.path, `${prefix}/responses`);
      assert.equal(seen.body.model, "deepseek-flash");
      assert.equal(seen.body.stream, true);
      assert.equal(seen.body.reasoning.effort, "none");
      assert.deepEqual(seen.body.input[0].content[1], image);
      assert.deepEqual(seen.body.tools, [tool]);
      complete.resolve();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += decoder.decode(chunk.value, { stream: true });
      }
      assert.equal((output.match(/event: response\.completed/g) || []).length, 1);
      assert.doesNotMatch(output, /event: response\.failed/);
    } finally {
      complete.resolve();
      await reader.cancel();
    }
  });
}
