import test from "node:test";
import assert from "node:assert/strict";

test("OpenAI-compatible chat requests convert to native Anthropic Messages", async () => {
  const {
    chatRequestToAnthropicMessages,
  } = await import("../src/anthropic-messages.js");

  const converted = chatRequestToAnthropicMessages({
    model: "claude-sonnet-4-6",
    messages: [
      { role: "system", content: "You are concise." },
      { role: "user", content: "Inspect this." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "read_file",
              arguments: "{\"path\":\"README.md\"}",
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "file contents",
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
            required: ["path"],
          },
        },
      },
    ],
    max_completion_tokens: 1234,
  });

  assert.equal(converted.model, "claude-sonnet-4-6");
  assert.equal(converted.max_tokens, 1234);
  assert.equal(converted.system, "You are concise.");
  assert.deepEqual(converted.tools, [
    {
      name: "read_file",
      description: "Read a file",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    },
  ]);
  assert.deepEqual(converted.messages, [
    {
      role: "user",
      content: [{ type: "text", text: "Inspect this." }],
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_1",
          name: "read_file",
          input: { path: "README.md" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: "file contents",
        },
      ],
    },
  ]);
});

test("Anthropic request options and signed thinking blocks survive conversion", async () => {
  const {
    chatRequestToAnthropicMessages,
  } = await import("../src/anthropic-messages.js");

  const thinkingBlocks = [
    {
      type: "thinking",
      thinking: "I should inspect the repository first.",
      signature: "signed-thinking-payload",
    },
  ];
  const converted = chatRequestToAnthropicMessages({
    model: "claude-sonnet-4-6",
    stream: true,
    thinking: {
      type: "enabled",
      budget_tokens: 2048,
    },
    metadata: {
      user_id: "codexbridge-test-user",
    },
    service_tier: "auto",
    messages: [
      { role: "user", content: "Continue." },
      {
        role: "assistant",
        content: "I will continue.",
        anthropic_thinking: thinkingBlocks,
      },
    ],
  });

  assert.equal(converted.stream, true);
  assert.deepEqual(converted.thinking, {
    type: "enabled",
    budget_tokens: 2048,
  });
  assert.deepEqual(converted.metadata, {
    user_id: "codexbridge-test-user",
  });
  assert.equal(converted.service_tier, "auto");
  assert.deepEqual(converted.messages[1].content, [
    ...thinkingBlocks,
    { type: "text", text: "I will continue." },
  ]);
});

test("Anthropic stream keep-alives and signed thinking survive the Responses bridge", async () => {
  const {
    chatRequestToAnthropicMessages,
    createAnthropicChatCompletionStreamTranslator,
  } = await import("../src/anthropic-messages.js");
  const {
    createChatCompletionResponsesStream,
  } = await import("../src/chat-to-responses.js");
  const route = {
    id: "claude-sonnet-4-6",
    api: "anthropic_messages",
    model: "claude-sonnet-4-6",
  };
  const anthropic = createAnthropicChatCompletionStreamTranslator(route);
  const responses = createChatCompletionResponsesStream("claude-sonnet-4-6");

  assert.deepEqual(anthropic.push(": keep-alive\n\n"), [": keep-alive\n\n"]);
  assert.deepEqual(
    anthropic.push('event: ping\ndata: {"type":"ping"}\n\n'),
    [": keep-alive\n\n"],
  );

  const source = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_thinking_stream","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"stop_reason":null,"usage":{"input_tokens":9,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"inspect first"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"signed-stream-thinking"}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_stream","name":"read_file","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"README.md\\"}"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":6}}\n\n',
  ];
  for (const chunk of source) {
    for (const chatEvent of anthropic.push(chunk)) {
      responses.push(chatEvent);
    }
  }

  const assistant = responses.chat.choices[0].message;
  assert.equal(assistant.reasoning_content, "inspect first");
  assert.deepEqual(assistant.anthropic_thinking, [{
    type: "thinking",
    thinking: "inspect first",
    signature: "signed-stream-thinking",
  }]);
  assert.equal(assistant.tool_calls[0].id, "toolu_stream");

  const nextTurn = chatRequestToAnthropicMessages({
    model: "claude-sonnet-4-6",
    messages: [
      { role: "user", content: "Inspect README." },
      assistant,
      { role: "tool", tool_call_id: "toolu_stream", content: "README contents" },
    ],
  });
  assert.deepEqual(nextTurn.messages[1].content[0], assistant.anthropic_thinking[0]);
  assert.equal(nextTurn.messages[1].content[1].type, "tool_use");
});

test("Anthropic streaming preserves redacted and multiple signed thinking blocks by index", async () => {
  const {
    chatRequestToAnthropicMessages,
    createAnthropicChatCompletionStreamTranslator,
  } = await import("../src/anthropic-messages.js");
  const {
    assistantHistoryMessageFromChat,
    chatResponseToResponse,
    createChatCompletionResponsesStream,
  } = await import("../src/chat-to-responses.js");
  const { buildToolContext } = await import("../src/tools.js");
  const anthropic = createAnthropicChatCompletionStreamTranslator({
    id: "claude-sonnet-4-6",
    api: "anthropic_messages",
    model: "claude-sonnet-4-6",
  });
  const responses = createChatCompletionResponsesStream("claude-sonnet-4-6");
  const source = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_multi_thinking","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"usage":{"input_tokens":12,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"first"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-one"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"encrypted-redacted-block"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"thinking_delta","thinking":"second"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"signature_delta","signature":"sig-two"}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":3,"content_block":{"type":"tool_use","id":"toolu_multi","name":"read_file","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":3,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"README.md\\"}"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":8}}\n\n',
  ];
  for (const chunk of source) {
    for (const chatEvent of anthropic.push(chunk)) {
      responses.push(chatEvent);
    }
  }

  const assistant = responses.chat.choices[0].message;
  assert.equal(assistant.reasoning_content, "firstsecond");
  assert.deepEqual(assistant.anthropic_thinking, [
    { type: "thinking", thinking: "first", signature: "sig-one" },
    { type: "redacted_thinking", data: "encrypted-redacted-block" },
    { type: "thinking", thinking: "second", signature: "sig-two" },
  ]);
  const persistedAssistant = assistantHistoryMessageFromChat(responses.chat);
  assert.deepEqual(persistedAssistant.anthropic_thinking, assistant.anthropic_thinking);
  const toolContext = buildToolContext([{
    type: "function",
    name: "read_file",
    parameters: { type: "object", properties: {} },
  }]);
  assert.doesNotMatch(
    JSON.stringify(chatResponseToResponse(
      responses.chat,
      "claude-sonnet-4-6",
      toolContext,
    )),
    /encrypted-redacted-block/,
  );

  const nextTurn = chatRequestToAnthropicMessages({
    model: "claude-sonnet-4-6",
    messages: [
      { role: "user", content: "Inspect README." },
      persistedAssistant,
      { role: "tool", tool_call_id: "toolu_multi", content: "README contents" },
    ],
  });
  assert.deepEqual(nextTurn.messages[1].content.slice(0, 3), persistedAssistant.anthropic_thinking);
  assert.equal(nextTurn.messages[1].content[3].type, "tool_use");
});

test("Anthropic Messages responses convert to OpenAI-compatible chat completions", async () => {
  const {
    anthropicMessageToChatCompletion,
  } = await import("../src/anthropic-messages.js");

  const converted = anthropicMessageToChatCompletion({
    id: "msg_123",
    model: "claude-sonnet-4-6",
    role: "assistant",
    content: [
      { type: "text", text: "I will inspect it." },
      {
        type: "tool_use",
        id: "toolu_1",
        name: "read_file",
        input: { path: "README.md" },
      },
    ],
    stop_reason: "tool_use",
    usage: {
      input_tokens: 11,
      output_tokens: 7,
    },
  });

  assert.equal(converted.object, "chat.completion");
  assert.equal(converted.choices[0].finish_reason, "tool_calls");
  assert.equal(converted.choices[0].message.content, "I will inspect it.");
  assert.deepEqual(converted.choices[0].message.tool_calls, [
    {
      id: "toolu_1",
      type: "function",
      function: {
        name: "read_file",
        arguments: "{\"path\":\"README.md\"}",
      },
    },
  ]);
  assert.deepEqual(converted.usage, {
    prompt_tokens: 11,
    completion_tokens: 7,
    total_tokens: 18,
  });
});

test("Anthropic signed thinking blocks remain available for the next tool turn", async () => {
  const {
    anthropicMessageToChatCompletion,
    chatRequestToAnthropicMessages,
  } = await import("../src/anthropic-messages.js");

  const thinkingBlock = {
    type: "thinking",
    thinking: "I need the file contents before answering.",
    signature: "signed-thinking-payload",
  };
  const chat = anthropicMessageToChatCompletion({
    id: "msg_thinking",
    model: "claude-sonnet-4-6",
    content: [
      thinkingBlock,
      {
        type: "tool_use",
        id: "toolu_read",
        name: "read_file",
        input: { path: "README.md" },
      },
    ],
    stop_reason: "tool_use",
    usage: {
      input_tokens: 9,
      output_tokens: 6,
    },
  });

  assert.equal(
    chat.choices[0].message.reasoning_content,
    "I need the file contents before answering.",
  );
  assert.deepEqual(chat.choices[0].message.anthropic_thinking, [thinkingBlock]);

  const nextTurn = chatRequestToAnthropicMessages({
    model: "claude-sonnet-4-6",
    messages: [
      { role: "user", content: "Inspect README." },
      chat.choices[0].message,
      {
        role: "tool",
        tool_call_id: "toolu_read",
        content: "README contents",
      },
    ],
  });

  assert.deepEqual(nextTurn.messages[1].content[0], thinkingBlock);
  assert.equal(nextTurn.messages[1].content[1].type, "tool_use");
});
