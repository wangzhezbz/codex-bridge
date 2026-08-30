import assert from "node:assert/strict";
import test from "node:test";

test("responses history payload prepends system instructions and replaces server-side history fields", async () => {
  const { inlineLocalHistoryForResponsesPayload } = await import(
    "../src/responses-history-payload.js"
  );
  const payload = {
    model: "gpt-history",
    instructions: "current request instructions",
    messages: [{ role: "user", content: "stale messages field" }],
    previous_response_id: "resp_local_parent",
    metadata: { keep: true },
  };

  inlineLocalHistoryForResponsesPayload(payload, [
    { role: "system", content: "first system instruction" },
    { role: "system", content: [{ type: "text", text: "second system instruction" }] },
    { role: "user", content: "current question" },
  ]);

  assert.deepEqual(payload, {
    model: "gpt-history",
    instructions:
      "first system instruction\n\nsecond system instruction\n\ncurrent request instructions",
    input: [{ role: "user", content: "current question" }],
    metadata: { keep: true },
  });
});

test("responses history payload does not duplicate an existing system instruction", async () => {
  const { inlineLocalHistoryForResponsesPayload } = await import(
    "../src/responses-history-payload.js"
  );
  const payload = {
    instructions: "prefix: shared system instruction :suffix",
  };

  inlineLocalHistoryForResponsesPayload(payload, [
    { role: "system", content: "shared system instruction" },
  ]);

  assert.deepEqual(payload, {
    instructions: "prefix: shared system instruction :suffix",
    input: [],
  });
});

test("responses history payload preserves tool calls and matching tool outputs", async () => {
  const { inlineLocalHistoryForResponsesPayload } = await import(
    "../src/responses-history-payload.js"
  );
  const payload = { previous_response_id: "resp_tool_parent" };

  inlineLocalHistoryForResponsesPayload(payload, [
    {
      role: "assistant",
      content: "I will run the tool.",
      tool_calls: [
        {
          id: "call_lookup",
          function: {
            name: "lookup",
            arguments: { query: "CodexBridge" },
          },
        },
        { id: "call_without_name", function: { arguments: "{}" } },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_lookup",
      content: [{ type: "text", text: "tool result" }],
    },
  ]);

  assert.deepEqual(payload, {
    input: [
      { role: "assistant", content: "I will run the tool." },
      {
        type: "function_call",
        call_id: "call_lookup",
        name: "lookup",
        arguments: '{"query":"CodexBridge"}',
      },
      {
        type: "function_call_output",
        call_id: "call_lookup",
        output: "tool result",
      },
    ],
  });
});

test("responses history payload restores assistant phase only on assistant messages", async () => {
  const { inlineLocalHistoryForResponsesPayload } = await import(
    "../src/responses-history-payload.js"
  );
  const payload = {};

  inlineLocalHistoryForResponsesPayload(payload, [
    { role: "assistant", content: "working", responses_phase: "commentary" },
    { role: "assistant", content: "done", responses_phase: "final_answer" },
    { role: "user", content: "continue", responses_phase: "commentary" },
  ]);

  assert.deepEqual(payload.input, [
    { role: "assistant", content: "working", phase: "commentary" },
    { role: "assistant", content: "done", phase: "final_answer" },
    { role: "user", content: "continue" },
  ]);
});

test("DeepSeek stateless history replays plain reasoning before its assistant tool call", async () => {
  const { inlineLocalHistoryForResponsesPayload } = await import(
    "../src/responses-history-payload.js"
  );
  const messages = [
    {
      role: "assistant",
      content: "I will inspect first.",
      reasoning_content: "inspect before editing",
      tool_calls: [{
        id: "call_inspect",
        type: "function",
        function: { name: "shell_command", arguments: '{"command":"ls"}' },
      }],
    },
    { role: "tool", tool_call_id: "call_inspect", content: "file.txt" },
  ];
  const deepseekPayload = { previous_response_id: "resp_deepseek_parent" };
  inlineLocalHistoryForResponsesPayload(deepseekPayload, messages, {
    includePlainReasoningContent: true,
  });

  assert.deepEqual(deepseekPayload.input, [
    {
      type: "reasoning",
      content: [{ type: "reasoning_text", text: "inspect before editing" }],
    },
    { role: "assistant", content: "I will inspect first." },
    {
      type: "function_call",
      call_id: "call_inspect",
      name: "shell_command",
      arguments: '{"command":"ls"}',
    },
    { type: "function_call_output", call_id: "call_inspect", output: "file.txt" },
  ]);

  const genericPayload = {};
  inlineLocalHistoryForResponsesPayload(genericPayload, messages);
  assert.equal(genericPayload.input.some((item) => item.type === "reasoning"), false);
});

test("stateless DeepSeek history excludes Chat-only guidance and removes legacy copies", async () => {
  const { responseRequestToChatSourceMessages } = await import(
    "../src/responses-to-chat.js"
  );
  const route = {
    id: "deepseek-v4-flash",
    provider: "deepseek",
    api: "responses",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    supportsResponsePreviousId: false,
  };
  const tool = {
    type: "function",
    name: "mcp__demo__lookup",
    description: "Lookup a value.",
    parameters: { type: "object", properties: { q: { type: "string" } } },
  };
  const legacyGuidance =
    "CodexBridge tool guidance: MCP namespace tools are exposed as flattened function names. " +
    "Only call tools that are present in this request's tools list. " +
    "If an MCP tool call returns unsupported call, do not retry that same tool repeatedly; " +
    "use another available tool or explain the limitation.";
  const history = {
    get() {
      return [
        { role: "system", content: legacyGuidance },
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
      ];
    },
  };

  const nativeMessages = responseRequestToChatSourceMessages(
    {
      previous_response_id: "resp_native_guidance",
      input: "second question",
      tools: [tool],
    },
    route,
    history,
  ).messages;
  assert.equal(
    nativeMessages.some((message) => String(message?.content || "").includes("CodexBridge tool guidance")),
    false,
  );

  const chatMessages = responseRequestToChatSourceMessages(
    { input: "chat question", tools: [tool] },
    { ...route, api: "chat_completions", supportsResponsePreviousId: undefined },
    null,
  ).messages;
  assert.equal(
    chatMessages.some((message) => String(message?.content || "").includes("CodexBridge tool guidance")),
    true,
  );
});

test("top-level instructions stay single across turns and the newest value replaces older history", async () => {
  const {
    responseRequestToChatSourceMessages,
  } = await import("../src/responses-to-chat.js");
  const {
    inlineLocalHistoryForResponsesPayload,
  } = await import("../src/responses-history-payload.js");
  const chatRoute = {
    id: "deepseek-chat",
    provider: "deepseek",
    api: "chat_completions",
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com/v1",
  };
  let storedMessages = [];
  let previousResponseId = "";
  for (let turn = 1; turn <= 4; turn += 1) {
    const source = responseRequestToChatSourceMessages(
      {
        instructions: "Stable instruction",
        input: `turn ${turn}`,
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
      },
      chatRoute,
      { get: () => storedMessages },
    ).messages;
    assert.equal(
      source.filter((message) =>
        message.role === "system" && message.content === "Stable instruction").length,
      1,
      `turn ${turn}`,
    );
    storedMessages = [...source, { role: "assistant", content: `answer ${turn}` }];
    previousResponseId = `resp_instruction_${turn}`;
  }

  const changed = responseRequestToChatSourceMessages(
    {
      instructions: "Replacement instruction",
      input: "use the replacement",
      previous_response_id: previousResponseId,
    },
    chatRoute,
    { get: () => storedMessages },
  ).messages;
  assert.equal(
    changed.some((message) => message.role === "system" && message.content === "Stable instruction"),
    false,
  );
  assert.equal(
    changed.filter((message) =>
      message.role === "system" && message.content === "Replacement instruction").length,
    1,
  );

  const inherited = responseRequestToChatSourceMessages(
    {
      input: "inherit only the latest instruction",
      previous_response_id: "resp_instruction_changed",
    },
    chatRoute,
    { get: () => [...changed, { role: "assistant", content: "replacement answer" }] },
  ).messages;
  assert.equal(
    inherited.filter((message) =>
      message.role === "system" && message.content === "Replacement instruction").length,
    1,
  );
  assert.equal(
    inherited.some((message) => message.role === "system" && message.content === "Stable instruction"),
    false,
  );

  const nativeRoute = {
    ...chatRoute,
    id: "deepseek-v4-flash",
    api: "responses",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    supportsResponsePreviousId: false,
  };
  const nativeSource = responseRequestToChatSourceMessages(
    {
      instructions: "Replacement instruction",
      input: "native continuation",
      previous_response_id: "resp_native_duplicate_instructions",
    },
    nativeRoute,
    {
      get: () => [
        { role: "system", content: "Replacement instruction" },
        { role: "system", content: "Replacement instruction" },
        { role: "user", content: "older native request" },
        { role: "assistant", content: "older native answer" },
      ],
    },
  ).messages;
  const nativePayload = { instructions: "Replacement instruction" };
  inlineLocalHistoryForResponsesPayload(nativePayload, nativeSource, {
    preferNativeResponsesHistoryItems: true,
  });
  assert.equal(nativePayload.instructions, "Replacement instruction");
});

test("messages-shaped chat requests preserve system and developer instructions across turns", async () => {
  const { responseRequestToChatSourceMessages } = await import(
    "../src/responses-to-chat.js"
  );
  const route = {
    id: "deepseek-v4-pro",
    provider: "deepseek",
    api: "chat_completions",
    model: "deepseek-v4-pro",
    baseUrl: "https://api.deepseek.com/v1",
  };

  const first = responseRequestToChatSourceMessages(
    {
      messages: [
        { role: "system", content: "SYSTEM_SENTINEL" },
        { role: "developer", content: "DEVELOPER_SENTINEL" },
        { role: "user", content: "first question" },
      ],
    },
    route,
    null,
  ).messages;
  assert.equal(first[0].role, "system");
  assert.equal(first[0].content, "SYSTEM_SENTINEL\n\nDEVELOPER_SENTINEL");

  const continued = responseRequestToChatSourceMessages(
    {
      previous_response_id: "resp_messages_instructions",
      messages: [
        { role: "system", content: "REPLACEMENT_SYSTEM" },
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second question" },
      ],
    },
    route,
    {
      get: () => [
        { role: "system", content: "OLD_SYSTEM" },
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
      ],
    },
  ).messages;
  assert.equal(
    continued.filter((message) =>
      message.role === "system" && message.content === "REPLACEMENT_SYSTEM").length,
    1,
  );
  assert.equal(
    continued.some((message) => message.role === "system" && message.content === "OLD_SYSTEM"),
    false,
  );
});

test("stateless native Responses history preserves distinct system and developer input items", async () => {
  const { responseRequestToChatSourceMessages } = await import(
    "../src/responses-to-chat.js"
  );
  const { inlineLocalHistoryForResponsesPayload } = await import(
    "../src/responses-history-payload.js"
  );
  const route = {
    id: "private-deepseek-responses",
    provider: "deepseek",
    api: "responses",
    model: "deepseek-v4-flash",
    baseUrl: "https://private-provider.example/v1",
    supportsResponsePreviousId: false,
  };
  const first = responseRequestToChatSourceMessages(
    {
      input: [
        { role: "system", content: "NATIVE_SYSTEM" },
        { role: "developer", content: "NATIVE_DEVELOPER" },
        { role: "user", content: "first question" },
      ],
    },
    route,
    null,
  ).messages;
  const continued = responseRequestToChatSourceMessages(
    {
      previous_response_id: "resp_native_distinct_instructions",
      input: "second question",
    },
    route,
    {
      get: () => [...first, { role: "assistant", content: "first answer" }],
    },
  ).messages;
  const payload = {
    model: route.model,
    previous_response_id: "resp_native_distinct_instructions",
    input: "second question",
  };
  inlineLocalHistoryForResponsesPayload(payload, continued, {
    preferNativeResponsesHistoryItems: true,
  });

  assert.deepEqual(payload.input.slice(0, 2), [
    { role: "system", content: "NATIVE_SYSTEM" },
    { role: "developer", content: "NATIVE_DEVELOPER" },
  ]);
});

test("Anthropic thinking history is isolated to Anthropic routes during model switches", async () => {
  const { responseRequestToChatSourceMessages } = await import(
    "../src/responses-to-chat.js"
  );
  const thinkingBlocks = [
    { type: "thinking", thinking: "private reasoning", signature: "signed-reasoning" },
    { type: "redacted_thinking", data: "encrypted-reasoning" },
  ];
  const history = {
    get: () => [{
      role: "assistant",
      content: "previous answer",
      reasoning_content: "plain reasoning for compatible routes",
      anthropic_thinking: thinkingBlocks,
    }],
  };
  const request = {
    previous_response_id: "resp_anthropic_switch",
    input: "continue on the selected model",
  };

  const deepseek = responseRequestToChatSourceMessages(request, {
    id: "deepseek-v4-pro",
    provider: "deepseek",
    api: "chat_completions",
    model: "deepseek-v4-pro",
    baseUrl: "https://api.deepseek.com/v1",
  }, history).messages;
  assert.equal(deepseek[0].reasoning_content, "plain reasoning for compatible routes");
  assert.equal(deepseek[0].anthropic_thinking, undefined);

  const anthropic = responseRequestToChatSourceMessages(request, {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    api: "anthropic_messages",
    model: "claude-sonnet-4-6",
    baseUrl: "https://api.anthropic.com/v1",
  }, history).messages;
  assert.deepEqual(anthropic[0].anthropic_thinking, thinkingBlocks);
  assert.equal(anthropic[0].reasoning_content, undefined);
});

test("chat history conversion preserves text and image input details", async () => {
  const { chatMessagesToResponsesInput } = await import(
    "../src/responses-history-payload.js"
  );

  const input = chatMessagesToResponsesInput([
    {
      role: "user",
      content: [
        "first line",
        { type: "text", text: "second line" },
        {
          type: "image_url",
          image_url: { url: "https://example.test/image.png", detail: "high" },
        },
        { type: "custom_part", value: 7 },
      ],
    },
  ]);

  assert.deepEqual(input, [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: 'first line\nsecond line\n{"type":"custom_part","value":7}',
        },
        {
          type: "input_image",
          image_url: "https://example.test/image.png",
          detail: "high",
        },
      ],
    },
  ]);
});
