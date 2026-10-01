import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
  filterPayloadForAdapter,
  normalizeAdapterProfile,
  reasoningParamsForAdapter,
} from "../src/adapter-profile.js";
import { responsesToChatRequest } from "../src/responses-to-chat.js";
import { buildRouterConfigFromSelection, saveSelection, MODE_ALL_API, MODE_HYBRID } from "../desktop/settings.mjs";
import { createRouterServer } from "../src/server.js";
import { ResponseHistory } from "../src/history.js";

const MODELS = ["gpt-6-sol", "gpt-6-luna"];
const apiRoute = (model, extra = {}) => ({
  id: `cb-${model}`, model, api: "responses", provider: "openai", authMode: "api_key",
  contextWindow: 1050000, ...extra,
});
const tool = { type: "function", function: { name: "lookup", parameters: { type: "object" } } };

test("GPT-6.1 Sol Responses keeps tools while mapping unsupported none/minimal effort to low", () => {
  const route = apiRoute("gpt-6.1-sol");
  for (const effort of ["none", "minimal"]) {
    const result = filterPayloadForAdapter({
      model: "gpt-6.1-sol", reasoning: { effort }, temperature: 0.2,
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
    }, route);
    assert.equal(result.reasoning.effort, "low");
    assert.equal(result.temperature, undefined);
    assert.equal(result.tools[0].name, "lookup");
  }
});

test("GPT-6.1 Sol Chat Completions refuses tool calls because no supported no-reasoning mode exists", () => {
  const route = apiRoute("gpt-6.1-sol", { api: "chat_completions" });
  assert.equal(normalizeAdapterProfile(route).supportsTools, "none");
  assert.throws(() => filterPayloadForAdapter({
    model: "gpt-6.1-sol", reasoning_effort: "none", tools: [tool],
  }, route), { code: "gpt61_chat_tools_require_responses" });
  assert.deepEqual(reasoningParamsForAdapter({ reasoning: { effort: "minimal" } }, route), {
    reasoning_effort: "low",
  });
});

test("GPT-6.1 Sol API caps inherited Ultra at max in Responses requests and configuration updates", () => {
  const route = apiRoute("gpt-6.1-sol");
  const request = { reasoning: { effort: "ultra" }, input: [
    { type: "configuration_update", reasoning: { effort: "ultra" } },
    { role: "user", content: "continue" },
  ] };
  const before = structuredClone(request);
  const result = filterPayloadForAdapter(request, route);
  assert.equal(result.reasoning.effort, "max");
  assert.equal(result.input[0].reasoning.effort, "max");
  assert.equal(result.input[1].content, "continue");
  assert.deepEqual(request, before);
});

test("GPT-6.1 Sol subscription preserves Ultra in Responses requests and configuration updates", () => {
  const route = apiRoute("gpt-6.1-sol", { authMode: "codex_openai" });
  const result = filterPayloadForAdapter({ reasoning: { effort: "ultra" }, input: [
    { type: "configuration_update", reasoning: { effort: "ultra" } },
  ] }, route);
  assert.equal(result.reasoning.effort, "ultra");
  assert.equal(result.input[0].reasoning.effort, "ultra");
});

test("GPT-6.1 Sol API caps inherited Ultra in Chat Completions without changing subscription effort", () => {
  const api = apiRoute("gpt-6.1-sol", { api: "chat_completions" });
  const subscription = { ...api, authMode: "codex_openai" };
  assert.deepEqual(reasoningParamsForAdapter({ reasoning: { effort: "ultra" } }, api), { reasoning_effort: "max" });
  assert.equal(filterPayloadForAdapter({ reasoning_effort: "ultra" }, api).reasoning_effort, "max");
  assert.deepEqual(reasoningParamsForAdapter({ reasoning: { effort: "ultra" } }, subscription), { reasoning_effort: "ultra" });
});

test("Codex subscription turns Responses string input into the native input list", () => {
  const request = { input: "Reply exactly OK.", reasoning: { effort: "low" } };
  const result = filterPayloadForAdapter(request, apiRoute("gpt-6.1-sol", { authMode: "codex_openai" }));
  assert.deepEqual(result.input, [{ role: "user", content: [{ type: "input_text", text: "Reply exactly OK." }] }]);
  assert.equal(request.input, "Reply exactly OK.");
});

test("OpenAI API Responses keeps its supported string input shorthand", () => {
  const result = filterPayloadForAdapter({ input: "Reply exactly OK." }, apiRoute("gpt-6.1-sol"));
  assert.equal(result.input, "Reply exactly OK.");
});

for (const model of MODELS) {
  test(`${model}: Responses none preserves supported sampling and logprob parameters`, () => {
    const input = { model, input: "hello", reasoning: { effort: "none" }, temperature: 0.2, top_p: 0.8,
      top_logprobs: 3, include: ["message.output_text.logprobs", "reasoning.encrypted_content"] };
    const before = structuredClone(input);
    const result = filterPayloadForAdapter(input, apiRoute(model));
    assert.equal(result.reasoning.effort, "none");
    assert.equal(result.temperature, 0.2);
    assert.equal(result.top_p, 0.8);
    assert.equal(result.top_logprobs, 3);
    assert.deepEqual(result.include, input.include);
    assert.deepEqual(input, before);
  });

  test(`${model}: default and enabled reasoning remove only unsupported sampling`, () => {
    for (const effort of [undefined, "minimal", "low", "medium", "high", "xhigh", "max"]) {
      const result = filterPayloadForAdapter({
        ...(effort === undefined ? {} : { reasoning: { effort, summary: "auto", mode: "standard" } }),
        temperature: 0.2, top_p: 0.8, top_logprobs: 3,
        include: ["message.output_text.logprobs", "reasoning.encrypted_content"],
        tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
      }, apiRoute(model));
      assert.equal(result.temperature, undefined);
      assert.equal(result.top_p, undefined);
      assert.equal(result.top_logprobs, undefined);
      assert.deepEqual(result.include, ["reasoning.encrypted_content"]);
      assert.equal(result.tools[0].name, "lookup");
      if (effort !== undefined) assert.equal(result.reasoning.effort, effort === "minimal" ? "low" : effort);
    }
  });

  test(`${model}: public Responses cache options survive and obsolete retention migrates`, () => {
    const route = apiRoute(model);
    assert.deepEqual(filterPayloadForAdapter({ prompt_cache_retention: "24h" }, route).prompt_cache_options, { ttl: "30m" });
    const explicit = filterPayloadForAdapter({ prompt_cache_retention: "24h", prompt_cache_options: { ttl: "5m" }, prompt_cache_key: "session-1" }, route);
    assert.deepEqual(explicit.prompt_cache_options, { ttl: "5m" });
    assert.equal(explicit.prompt_cache_retention, undefined);
    assert.equal(explicit.prompt_cache_key, "session-1");
    const dropped = filterPayloadForAdapter({ prompt_cache_retention: "24h" }, { ...route, dropParams: ["prompt_cache_options"] });
    assert.equal(dropped.prompt_cache_options, undefined);
    assert.equal(dropped.prompt_cache_retention, undefined);
  });

  test(`${model}: sampling follows conversation effort updates without rewriting the request prefix`, () => {
    for (const [initial, next] of [["none", "high"], ["high", "none"], ["none", "minimal"]]) {
      const input = [{ type: "configuration_update", reasoning: { effort: next } }, { role: "user", content: "continue" }];
      const request = { reasoning: { effort: initial }, input, temperature: 0.2, top_p: 0.8,
        top_logprobs: 2, include: ["message.output_text.logprobs", "reasoning.encrypted_content"] };
      const before = structuredClone(request);
      const result = filterPayloadForAdapter(request, apiRoute(model));
      assert.equal(result.reasoning.effort, initial, "request-level effort is part of the cache prefix");
      assert.equal(result.input[0].reasoning.effort, next === "minimal" ? "low" : next);
      assert.equal(result.input[1].content, "continue");
      assert.equal(result.temperature, next === "none" ? 0.2 : undefined);
      assert.equal(result.top_p, next === "none" ? 0.8 : undefined);
      assert.equal(result.top_logprobs, next === "none" ? 2 : undefined);
      assert.deepEqual(result.include, next === "none" ? request.include : ["reasoning.encrypted_content"]);
      assert.deepEqual(request, before);
    }
    const input = [
      { type: "configuration_update", reasoning: { effort: "high" } }, { role: "user", content: "first" },
      { type: "configuration_update", reasoning: { effort: "none" } }, { role: "user", content: "second" },
    ];
    const result = filterPayloadForAdapter({ input, reasoning: { effort: "high" }, temperature: 0.2 }, apiRoute(model));
    assert.equal(result.temperature, 0.2);
    assert.deepEqual(result.input, input, "updates remain in their original history positions");
    const quoted = filterPayloadForAdapter({ reasoning: { effort: "high" }, temperature: 0.2,
      input: [{ role: "user", content: JSON.stringify({ type: "configuration_update", reasoning: { effort: "none" } }) }],
    }, apiRoute(model));
    assert.equal(quoted.temperature, undefined, "quoted content is not a configuration update");
  });

  test(`${model}: Chat preserves selected reasoning instead of accidentally enabling it`, () => {
    const route = apiRoute(model, { api: "chat_completions" });
    for (const effort of ["none", "low", "medium", "high", "xhigh", "max"]) {
      const converted = responsesToChatRequest({ input: "hello", reasoning: { effort } }, route).body;
      assert.equal(filterPayloadForAdapter(converted, route).reasoning_effort, effort);
      assert.equal(route.api, "chat_completions");
    }
    assert.deepEqual(reasoningParamsForAdapter({ reasoning: { effort: "minimal" } }, route), { reasoning_effort: "low" });
    assert.deepEqual(reasoningParamsForAdapter({ reasoning_effort: "none", reasoning: { effort: "high" } }, route), { reasoning_effort: "none" });
  });

  test(`${model}: Chat function calls require none without rewriting the chosen protocol`, () => {
    const route = apiRoute(model, { api: "chat_completions" });
    assert.equal(normalizeAdapterProfile(route).supportsTools, "chat-functions");
    const result = filterPayloadForAdapter({ tools: [tool], tool_choice: "auto", reasoning_effort: "none",
      temperature: 0.2, top_p: 0.8, logprobs: true, top_logprobs: 2 }, route);
    assert.deepEqual(result.tools, [tool]);
    assert.equal(result.reasoning_effort, "none");
    assert.equal(result.temperature, 0.2);
    assert.equal(result.logprobs, true);
    assert.equal(result.top_logprobs, 2);
    for (const effort of [undefined, "minimal", "low", "medium", "high", "max"]) {
      assert.throws(() => filterPayloadForAdapter({ tools: [tool], ...(effort ? { reasoning_effort: effort } : {}) }, route), error => {
        assert.equal(error.statusCode, 400);
        assert.match(error.message, /Responses/);
        return true;
      });
    }
    assert.doesNotThrow(() => filterPayloadForAdapter({ tools: [tool], tool_choice: "none", reasoning_effort: "high" }, route));
    assert.throws(() => filterPayloadForAdapter({ tools: [tool], reasoning_effort: "none" }, { ...route, dropParams: ["reasoning_effort"] }), /Responses/);
    assert.equal(route.api, "chat_completions");
  });

  test(`${model}: native subscription preserves tool history and keeps API cache options separate`, () => {
    const input = [
      { role: "user", content: "continue" },
      { type: "reasoning", encrypted_content: "opaque-state" },
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}", caller: { type: "program", caller_id: "program_1" } },
      { type: "function_call_output", call_id: "call_1", output: "done", caller: { type: "program", caller_id: "program_1" } },
    ];
    const result = filterPayloadForAdapter({ input, store: false, stream: false,
      reasoning: { effort: "max" }, temperature: 0.2, prompt_cache_options: { ttl: "30m" },
    }, apiRoute(model, { authMode: "codex_openai" }));
    assert.deepEqual(result.input, input);
    assert.equal(result.reasoning.effort, "max");
    assert.equal(result.store, false);
    assert.equal(result.stream, true);
    assert.equal(result.temperature, undefined);
    assert.equal(result.prompt_cache_options, undefined);
    assert.ok(result.include.includes("reasoning.encrypted_content"));
  });
}

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

for (const model of MODELS) {
  test(`${model}: Chat HTTP permits tools at none and rejects thinking tools before fetching`, { timeout: 10000 }, async (t) => {
    const seen = [];
    const upstreamUrl = await listen(t, http.createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      seen.push({ path: request.url, body: JSON.parse(raw) });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "chatcmpl_fixture", object: "chat.completion", model,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }));
    const route = apiRoute(model, { api: "chat_completions", baseUrl: `${upstreamUrl}/v1`, apiKey: "fixture-key" });
    const routerUrl = await listen(t, createRouterServer({ models: [route], defaultModel: route.id,
      authTokenEnv: "", authToken: "gpt6-local-fixture" }, { history: new ResponseHistory() }));
    const request = effort => fetch(`${routerUrl}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer gpt6-local-fixture" },
      body: JSON.stringify({ model: route.id, input: "hello", stream: false, reasoning: { effort },
        tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }] }),
    });
    const allowed = await request("none");
    assert.equal(allowed.status, 200);
    await allowed.json();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, "/v1/chat/completions");
    assert.equal(seen[0].body.model, model);
    assert.equal(seen[0].body.reasoning_effort, "none");
    assert.equal(seen[0].body.tools[0].function.name, "lookup");
    const rejected = await request("high");
    assert.equal(rejected.status, 400);
    const body = await rejected.json();
    assert.match(body.error.message, /Responses/);
    assert.equal(seen.length, 1, "invalid thinking/tool combination must not reach the upstream");
  });
}

for (const model of [...MODELS, "gpt-6.1-sol"]) {
  for (const subscription of [false, true]) {
    test(`${model}: ${subscription ? "subscription" : "API"} HTTP preserves identity, tools and incremental streaming`, { timeout: 10000 }, async (t) => {
      const completion = Promise.withResolvers();
      t.after(() => completion.resolve());
      const marker = `stream-${model}-${subscription ? "native" : "api"}`;
      let received;
      const upstreamUrl = await listen(t, http.createServer(async (request, response) => {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        received = { path: request.url, authorization: request.headers.authorization, body: JSON.parse(raw) };
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_new_model", status: "in_progress", output: [] } })}\n\n`);
        response.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_new_model", output_index: 0, content_index: 0, delta: marker })}\n\n`);
        await completion.promise;
        if (response.destroyed) return;
        response.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: {
          id: "resp_new_model", status: "completed", output: [{ id: "msg_new_model", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: marker, annotations: [] }] }],
        } })}\n\n`);
      }));
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-gpt6-http-"));
      const presetId = `${subscription ? "codex" : "openai"}-${model.replace("6.1", "6-1")}`;
      const mode = subscription ? MODE_HYBRID : MODE_ALL_API;
      saveSelection(root, [presetId], mode);
      const config = buildRouterConfigFromSelection(root, mode);
      assert.equal(config.models.length, 1);
      const route = { ...config.models[0], baseUrl: `${upstreamUrl}${subscription ? "" : "/v1"}`,
        ...(subscription ? {} : { apiKey: "upstream-api-fixture" }) };
      const routerUrl = await listen(t, createRouterServer({
        ...config, models: [route], ...(subscription ? {} : { authTokenEnv: "", authToken: "local-gpt6-fixture" }),
      }, { history: new ResponseHistory() }));
      const input = [
        ...(subscription ? [] : [{ type: "configuration_update", reasoning: { effort: "high" } }]),
        { role: "user", content: [{ type: "input_text", text: "continue" }, { type: "input_image", image_url: "https://images.example.invalid/fixture.png" }] },
        { type: "reasoning", encrypted_content: "opaque-state" },
        { type: "function_call", call_id: "previous_call", name: "lookup", arguments: "{}" },
        { type: "function_call_output", call_id: "previous_call", output: "previous-result" },
      ];
      const tools = [{ type: "function", name: "lookup", description: "fixture", parameters: { type: "object", properties: {} }, async: true }];
      const response = await fetch(`${routerUrl}/v1/responses`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${subscription ? "subscription-fixture" : "local-gpt6-fixture"}` },
        body: JSON.stringify({ model: route.id, input, tools, stream: true, store: false,
          reasoning: { effort: subscription || model === "gpt-6.1-sol" ? "high" : "none" }, temperature: 0.2, prompt_cache_options: { ttl: "30m" } }),
      });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      try {
        while (!text.includes(marker)) {
          const chunk = await reader.read();
          assert.equal(chunk.done, false);
          text += decoder.decode(chunk.value, { stream: true });
        }
        assert.equal(text.includes("response.completed"), false, "delta must arrive before upstream completion");
        assert.equal(received.path, subscription ? "/responses" : "/v1/responses");
        assert.equal(received.authorization, `Bearer ${subscription ? "subscription-fixture" : "upstream-api-fixture"}`);
        assert.equal(received.body.model, model);
        assert.equal(received.body.reasoning.effort, subscription || model === "gpt-6.1-sol" ? "high" : "none");
        assert.deepEqual(received.body.input, input);
        assert.equal(received.body.tools[0].async, true);
        assert.equal(received.body.temperature, undefined);
        assert.equal(received.body.store, false);
        assert.deepEqual(received.body.prompt_cache_options, subscription ? undefined : { ttl: "30m" });
        completion.resolve();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          text += decoder.decode(chunk.value, { stream: true });
        }
        assert.match(text, /response.completed/);
      } finally {
        completion.resolve();
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    });
  }
}
