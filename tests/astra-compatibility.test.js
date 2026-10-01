import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
  applyCodexConfig,
  buildRouterConfigFromSelection,
  MODE_ALL_API,
  MODE_HYBRID,
  saveSelection,
  writeRouterConfigFromSelection,
} from "../desktop/settings.mjs";
import { codexOpenAiPortableHistoryRetryPayload, filterPayloadForAdapter, normalizeAdapterProfile } from "../src/adapter-profile.js";
import { upstreamHeaders } from "../src/upstream-header-policy.js";
import { isResponseToolCallItem, isResponseToolOutputItem } from "../src/tools.js";
import { buildModelCatalog } from "../src/model-catalog.js";
import { contextPolicyForRoute } from "../src/context-policy.js";
import { createRouterServer } from "../src/server.js";
import { ResponseHistory } from "../src/history.js";

function selectedConfig(presetId, mode = MODE_HYBRID) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-astra-"));
  saveSelection(rootDir, [presetId], mode);
  return { rootDir, config: buildRouterConfigFromSelection(rootDir, mode) };
}

test("selecting Astra subscription preserves the exact model, authentication and Codex capabilities", () => {
  const { config } = selectedConfig("codex-gpt-6-astra");
  assert.equal(config.models.length, 1);
  const route = config.models[0];
  assert.equal(route.id, "cb-gpt-6-astra");
  assert.equal(route.model, "gpt-6-astra");
  assert.equal(route.authMode, "codex_openai");
  assert.equal(route.api, "responses");
  assert.equal(route.baseUrl, "https://chatgpt.com/backend-api/codex");
  const entry = buildModelCatalog(config).models[0];
  assert.deepEqual(entry.supported_reasoning_levels.map(({ effort }) => effort), [
    "low", "medium", "high", "xhigh", "max", "ultra",
  ]);
  assert.equal(entry.default_reasoning_level, "medium");
  assert.equal(entry.context_window, 272000);
  assert.equal(entry.max_context_window, 872000);
  assert.equal(contextPolicyForRoute(route).inputBudget, 258400);
  assert.equal(entry.use_responses_lite, true);
  assert.equal(entry.tool_mode, "code_mode_only");
  assert.equal(entry.multi_agent_version, "v2");
  assert.equal(entry.support_verbosity, true);
  assert.equal(entry.web_search_tool_type, "text_and_image");
  assert.deepEqual(entry.input_modalities, ["text", "image"]);
});

test("selecting Astra API uses Responses and the API limits instead of subscription limits", () => {
  const { config } = selectedConfig("openai-gpt-6-astra", MODE_ALL_API);
  assert.equal(config.models.length, 1);
  const route = config.models[0];
  assert.equal(route.id, "cb-openai-gpt-6-astra");
  assert.equal(route.model, "gpt-6-astra");
  assert.equal(route.authMode, "api_key");
  assert.equal(route.api, "responses");
  assert.equal(route.baseUrl, "https://api.openai.com/v1");
  const entry = buildModelCatalog(config).models[0];
  assert.deepEqual(entry.supported_reasoning_levels.map(({ effort }) => effort), [
    "low", "medium", "high", "xhigh", "max",
  ]);
  assert.equal(entry.context_window, 1050000);
  assert.equal(contextPolicyForRoute(route).inputBudget, 922000);
});

test("saved Sol and Terra routes retain their existing tool and verbosity capabilities too", () => {
  for (const presetId of ["codex-gpt-5-6-sol", "codex-gpt-5-6-terra"]) {
    const { config } = selectedConfig(presetId);
    const entry = buildModelCatalog(config).models[0];
    assert.equal(entry.use_responses_lite, true);
    assert.equal(entry.tool_mode, "code_mode_only");
    assert.equal(entry.multi_agent_version, "v2");
    assert.equal(entry.support_verbosity, true);
  }
});

test("reapplying managed config preserves max and ultra reasoning and the selected model", () => {
  for (const effort of ["max", "ultra"]) {
    const { rootDir } = selectedConfig("codex-gpt-6-astra");
    writeRouterConfigFromSelection(rootDir, MODE_HYBRID);
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-astra-home-"));
    fs.mkdirSync(path.join(homeDir, ".codex"));
    const configPath = path.join(homeDir, ".codex", "config.toml");
    fs.writeFileSync(configPath, [
      'model_provider = "openai"',
      'model = "cb-gpt-6-astra"',
      `model_reasoning_effort = "${effort}"`,
      '[mcp_servers.existing]',
      'command = "existing-mcp"',
    ].join("\n"));
    applyCodexConfig({ rootDir, mode: MODE_HYBRID, homeDir });
    const written = fs.readFileSync(configPath, "utf8");
    assert.match(written, /^model = "cb-gpt-6-astra"$/m);
    assert.ok(written.includes(`model_reasoning_effort = "${effort}"`));
    assert.match(written, /\[mcp_servers\.existing\]\s+command = "existing-mcp"/);
  }
});

const astraApi = {
  model: "gpt-6-astra", api: "responses", provider: "openai", authMode: "api_key",
};

test("Astra drops unsupported sampling controls without changing tools, state or valid reasoning", () => {
  const request = {
    model: "gpt-6-astra", stream: true, store: false, previous_response_id: "resp_previous",
    temperature: 0.7, top_p: 0.8, top_logprobs: 4,
    include: ["message.output_text.logprobs", "reasoning.encrypted_content"],
    reasoning: { effort: "max", summary: "auto" },
    input: [{ type: "configuration_update", reasoning: { effort: "high" } }],
    tools: [{ type: "function", name: "lookup", parameters: { type: "object" }, async: true }],
    text: { verbosity: "low" }, service_tier: "priority",
  };
  const original = structuredClone(request);
  // The normalized-profile path must behave the same as a direct route.
  const result = filterPayloadForAdapter(request, normalizeAdapterProfile(astraApi));
  assert.equal(result.temperature, undefined);
  assert.equal(result.top_p, undefined);
  assert.equal(result.top_logprobs, undefined);
  assert.deepEqual(result.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(result.reasoning, { effort: "max", summary: "auto" });
  assert.deepEqual(result.input, original.input);
  assert.deepEqual(result.tools, original.tools);
  assert.equal(result.previous_response_id, "resp_previous");
  assert.equal(result.store, false);
  assert.equal(result.service_tier, "priority");
  assert.deepEqual(request, original);
});

test("Astra adapts legacy no-reasoning controls and prompt cache settings only for that model", () => {
  for (const effort of ["none", "minimal"]) {
    const result = filterPayloadForAdapter({
      reasoning: { effort }, prompt_cache_key: "cache-key", prompt_cache_retention: "24h",
    }, astraApi);
    assert.deepEqual(result.reasoning, { effort: "low" });
    assert.equal(result.prompt_cache_key, "cache-key");
    assert.deepEqual(result.prompt_cache_options, { ttl: "30m" });
    assert.equal(result.prompt_cache_retention, undefined);
  }
  assert.deepEqual(filterPayloadForAdapter({
    prompt_cache_retention: "24h", prompt_cache_options: { ttl: "5m", extra: "preserved" },
  }, astraApi).prompt_cache_options, { ttl: "5m", extra: "preserved" });
  const other = filterPayloadForAdapter({
    temperature: 0.7, top_p: 0.8, reasoning: { effort: "none" },
    include: ["message.output_text.logprobs"],
  }, { ...astraApi, model: "gpt-4.1" });
  assert.equal(other.temperature, 0.7);
  assert.equal(other.top_p, 0.8);
  assert.deepEqual(other.reasoning, { effort: "none" });
  assert.deepEqual(other.include, ["message.output_text.logprobs"]);
});

test("Astra subscription preserves ultra and encrypted tool history without API cache fields", () => {
  const input = [
    { type: "reasoning", encrypted_content: "opaque-provider-state" },
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "done" },
  ];
  const result = filterPayloadForAdapter({
    input, reasoning: { effort: "ultra" }, store: false, prompt_cache_options: { ttl: "30m" },
  }, { ...astraApi, authMode: "codex_openai" });
  assert.deepEqual(result.input, input);
  assert.equal(result.reasoning.effort, "ultra");
  assert.equal(result.stream, true);
  assert.equal(result.store, false);
  assert.equal(result.prompt_cache_options, undefined);
});

test("native multi-agent options survive forwarding without enabling them implicitly", () => {
  for (const authMode of ["api_key", "codex_openai"]) {
    const route = { ...astraApi, authMode };
    const result = filterPayloadForAdapter({
      multi_agent: { enabled: true, max_concurrent_subagents: 3 },
      context_management: { compact_threshold: 200000 },
      reasoning: { effort: "max", summary: "auto" },
    }, route);
    assert.deepEqual(result.multi_agent, { enabled: true, max_concurrent_subagents: 3 });
    assert.deepEqual(result.context_management, { compact_threshold: 200000 });
    assert.deepEqual(result.reasoning, { effort: "max" });
    assert.equal(filterPayloadForAdapter({}, route).multi_agent, undefined);
    assert.deepEqual(filterPayloadForAdapter({
      multi_agent: { enabled: false }, reasoning: { effort: "high", summary: "auto" },
    }, route).reasoning, { effort: "high", summary: "auto" });
  }
});

test("native multi-agent history keeps attribution and hosted actions even in portable retry", () => {
  const input = [
    { type: "message", id: "msg_agent", role: "assistant", phase: "commentary", agent: { agent_name: "/root/reviewer" }, content: [{ type: "output_text", text: "checking", annotations: [] }] },
    { type: "multi_agent_call", id: "mac_1", call_id: "spawn_1", action: "spawn_agent", arguments: "{}", agent: { agent_name: "/root" } },
    { type: "multi_agent_call_output", id: "maco_1", call_id: "spawn_1", output: [{ type: "output_text", text: "spawned" }], agent: { agent_name: "/root" } },
    { type: "agent_message", id: "amsg_1", author: "/root/reviewer", recipient: "/root", content: [{ type: "encrypted_content", encrypted_content: "opaque" }], agent: { agent_name: "/root" } },
  ];
  const result = filterPayloadForAdapter({ input, multi_agent: { enabled: true }, store: false }, { ...astraApi, authMode: "codex_openai" });
  assert.deepEqual(result.input, input);
  assert.deepEqual(codexOpenAiPortableHistoryRetryPayload(result).input, input);
});

test("OpenAI beta flags reach the API route without forwarding client account headers or auth", () => {
  const context = { clientHeaders: { "openai-beta": "responses_multi_agent=v1", "chatgpt-account-id": "private-client-account", "openai-organization": "client-org" } };
  const headers = upstreamHeaders({ ...astraApi, apiKey: "route-key" }, context);
  assert.equal(headers["openai-beta"], "responses_multi_agent=v1");
  assert.equal(headers.authorization, "Bearer route-key");
  assert.equal(headers["chatgpt-account-id"], undefined);
  assert.equal(headers["openai-organization"], undefined);
  assert.equal(upstreamHeaders({ api: "responses", provider: "deepseek", model: "deepseek-v4-flash", apiKey: "deepseek-key" }, context)["openai-beta"], undefined);
});

test("programmatic tool continuation retains caller and program fingerprint during portable retry", () => {
  const input = [
    { type: "program", id: "prog_1", call_id: "program_1", code: "await tools.lookup({})", fingerprint: "opaque-fingerprint" },
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}", caller: { type: "program", caller_id: "program_1" } },
    { type: "function_call_output", call_id: "call_1", output: "done", caller: { type: "program", caller_id: "program_1" } },
  ];
  assert.deepEqual(codexOpenAiPortableHistoryRetryPayload({ input, store: false }).input, input);
  // Even when older program state cannot be recovered, do not silently drop
  // the tool result; let the upstream validate the native continuation.
  assert.deepEqual(codexOpenAiPortableHistoryRetryPayload({ input: [input[2]], previous_response_id: "resp_missing" }).input, [input[2]]);
});

test("Astra cache migration does not reinsert an explicitly disabled route parameter", () => {
  const result = filterPayloadForAdapter({ prompt_cache_retention: "24h" }, {
    ...astraApi, dropParams: ["prompt_cache_options"],
  });
  assert.equal(result.prompt_cache_options, undefined);
});

test("stored agent reasoning references keep attribution while unstored unencrypted references remain rejected", () => {
  const item = { type: "reasoning", id: "rs_agent", summary: [], agent: { agent_name: "/root/reviewer" } };
  const route = { ...astraApi, authMode: "codex_openai" };
  assert.deepEqual(filterPayloadForAdapter({ input: [item], store: true }, route).input, [
    { type: "reasoning", id: "rs_agent", agent: { agent_name: "/root/reviewer" } },
  ]);
  assert.deepEqual(filterPayloadForAdapter({ input: [item], store: false }, route).input, []);
});

test("hosted multi-agent actions are not executable client tools", () => {
  assert.equal(isResponseToolCallItem({ type: "multi_agent_call", call_id: "spawn_1" }), false);
  assert.equal(isResponseToolOutputItem({ type: "multi_agent_call_output", call_id: "spawn_1" }), false);
  assert.equal(isResponseToolCallItem({ type: "function_call", name: "lookup", call_id: "client_1" }), true);
});

async function listen(t, server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("Astra reaches the selected Responses upstream and delivers a delta before completion", { timeout: 5000 }, async (t) => {
  let releaseCompletion;
  const completionGate = new Promise((resolve) => { releaseCompletion = resolve; });
  t.after(() => releaseCompletion());
  let received;
  const upstreamUrl = await listen(t, http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    received = { url: req.url, authorization: req.headers.authorization, beta: req.headers["openai-beta"], body: JSON.parse(raw) };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_astra","status":"in_progress","output":[]}}\n\n');
    res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_astra","output_index":0,"content_index":0,"delta":"Astra streaming"}\n\n');
    await completionGate;
    res.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_astra","status":"completed","output":[{"id":"msg_astra","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Astra streaming","annotations":[]}]}]}}\n\n');
  }));
  const { config } = selectedConfig("openai-gpt-6-astra", MODE_ALL_API);
  assert.equal(config.models.length, 1);
  const route = { ...config.models[0], baseUrl: `${upstreamUrl}/v1`, apiKey: "astra-fixture-key" };
  const routerUrl = await listen(t, createRouterServer({
    ...config, authTokenEnv: "", authToken: "local-astra-fixture", models: [route],
  }, { history: new ResponseHistory() }));
  const response = await fetch(`${routerUrl}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer local-astra-fixture", "openai-beta": "responses_multi_agent=v1" },
    body: JSON.stringify({ model: "cb-openai-gpt-6-astra", input: "hello", stream: true, reasoning: { effort: "high", summary: "auto" }, multi_agent: { enabled: true }, temperature: 0.5 }),
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("Astra streaming")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    text += decoder.decode(chunk.value, { stream: true });
  }
  assert.equal(text.includes("response.completed"), false);
  assert.equal(received.url, "/v1/responses");
  assert.equal(received.authorization, "Bearer astra-fixture-key");
  assert.equal(received.body.model, "gpt-6-astra");
  assert.equal(received.body.reasoning.effort, "high");
  assert.equal(received.body.reasoning.summary, undefined);
  assert.deepEqual(received.body.multi_agent, { enabled: true });
  assert.equal(received.beta, "responses_multi_agent=v1");
  assert.equal(received.body.temperature, undefined);
  releaseCompletion();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  reader.releaseLock();
  assert.match(text, /response.completed/);
});

test("Astra subscription HTTP preserves native program and agent state on a tool continuation", { timeout: 5000 }, async (t) => {
  const input = [
    { role: "user", content: "continue" },
    { type: "program", call_id: "program_1", code: "await tools.lookup({})", fingerprint: "opaque-fingerprint" },
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}", caller: { type: "program", caller_id: "program_1" } },
    { type: "function_call_output", call_id: "call_1", output: "done", caller: { type: "program", caller_id: "program_1" } },
    { type: "message", role: "assistant", phase: "commentary", agent: { agent_name: "/root/reviewer" }, content: [{ type: "output_text", text: "checked", annotations: [] }] },
  ];
  const output = [{ type: "message", role: "assistant", phase: "final_answer", agent: { agent_name: "/root" }, content: [{ type: "output_text", text: "finished", annotations: [] }] }];
  let received;
  const upstreamUrl = await listen(t, http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    received = { body: JSON.parse(raw), headers: req.headers };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_native", status: "completed", output } })}\n\n`);
  }));
  const { config } = selectedConfig("codex-gpt-6-astra");
  const route = { ...config.models[0], baseUrl: upstreamUrl };
  const routerUrl = await listen(t, createRouterServer({ ...config, models: [route] }, { history: new ResponseHistory() }));
  const response = await fetch(`${routerUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer subscription-fixture", "openai-beta": "responses_multi_agent=v1" },
    body: JSON.stringify({ model: "cb-gpt-6-astra", input, stream: true, store: false, multi_agent: { enabled: true }, reasoning: { effort: "ultra" } }),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(received.body.model, "gpt-6-astra");
  assert.deepEqual(received.body.input, input);
  assert.deepEqual(received.body.multi_agent, { enabled: true });
  assert.equal(received.body.reasoning.effort, "ultra");
  assert.equal(received.headers.authorization, "Bearer subscription-fixture");
  assert.equal(received.headers["openai-beta"], "responses_multi_agent=v1");
  const completed = text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6))).find((event) => event.type === "response.completed");
  assert.deepEqual(completed.response.output, output);
});

test("unfinished native programs and agents can resume without new input, but final answers are not replayed upstream", { timeout: 5000 }, async (t) => {
  let calls = 0;
  const seen = [];
  const upstreamUrl = await listen(t, http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.push(JSON.parse(raw));
    calls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: `resp_final_${calls}`, object: "response", status: "completed", output: [
      { type: "message", role: "assistant", phase: "final_answer", agent: { agent_name: "/root" }, content: [{ type: "output_text", text: "finished", annotations: [] }] },
    ] }));
  }));
  const route = { ...astraApi, id: "cb-astra", baseUrl: `${upstreamUrl}/v1`, apiKey: "fixture-key", contextWindow: 1050000 };
  const history = new ResponseHistory();
  history.recordTurn({ response: { id: "resp_program", status: "completed", output: [
    { type: "program_output", call_id: "program_1", result: "ready", status: "completed" },
  ] }, messages: [{ role: "user", content: "task" }], meta: { routeId: "cb-astra", api: "responses" } });
  history.recordTurn({ response: { id: "resp_agents", status: "completed", output: [
    { type: "multi_agent_call", call_id: "spawn_1", action: "spawn_agent", arguments: "{}", agent: { agent_name: "/root" } },
    { type: "multi_agent_call_output", call_id: "spawn_1", output: "spawned", agent: { agent_name: "/root" } },
    { type: "message", role: "assistant", phase: "final_answer", agent: { agent_name: "/root/reviewer" }, content: [{ type: "output_text", text: "child finished" }] },
  ] }, messages: [{ role: "user", content: "task" }], meta: { routeId: "cb-astra", api: "responses" } });
  const routerUrl = await listen(t, createRouterServer({ models: [route], defaultModel: route.id, authToken: "local-key" }, { history }));
  async function resume(previousId, extra) {
    const res = await fetch(`${routerUrl}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer local-key" },
      body: JSON.stringify({ model: "cb-astra", previous_response_id: previousId, input: [], stream: false, ...extra }),
    });
    assert.equal(res.status, 200);
    return res.json();
  }
  const programResult = await resume("resp_program", { tools: [{ type: "programmatic_tool_calling" }] });
  assert.equal(programResult.id, "resp_final_1");
  assert.equal(seen[0].previous_response_id, "resp_program");
  assert.deepEqual(seen[0].input, []);
  const agentResult = await resume("resp_agents", { multi_agent: { enabled: true } });
  assert.equal(agentResult.id, "resp_final_2");
  assert.equal((await resume("resp_final_2", { multi_agent: { enabled: true } })).id, "resp_final_2");
  assert.equal(calls, 2);
});
