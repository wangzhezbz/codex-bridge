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
