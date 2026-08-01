import assert from "node:assert/strict";
import test from "node:test";

test("response tool call signatures normalize Responses and chat tool schemas", async () => {
  const { responseToolCallSignatures } = await import(
    "../src/responses-tool-signatures.js"
  );
  const response = {
    output: [
      {
        type: "custom_tool_call",
        name: "omega",
        input: { b: 2, a: 1 },
      },
      {
        role: "assistant",
        tool_calls: [
          { function: { name: "beta", arguments: '{ "value": 2 }' } },
          { function: { name: "alpha", arguments: '{ "value": 1 }' } },
        ],
      },
    ],
  };

  assert.deepEqual(responseToolCallSignatures(response), [
    'chat:alpha:{"value":1}|chat:beta:{"value":2}',
    'custom_tool_call:omega:{"b":2,"a":1}',
  ]);
  assert.deepEqual(responseToolCallSignatures({ output: "not-an-array" }), []);
});

test("latest tool call signatures ignore earlier groups", async () => {
  const { latestToolCallSignaturesFromInput } = await import(
    "../src/responses-tool-signatures.js"
  );

  assert.deepEqual(
    latestToolCallSignaturesFromInput([
      { type: "function_call", name: "old", arguments: "{}" },
      { type: "message", role: "user", content: "separate groups" },
      { type: "function_call", name: "zeta", arguments: '{"n":2}' },
      { type: "custom_tool_call", name: "alpha", input: '{"n":1}' },
    ]),
    [
      'custom_tool_call:alpha:{"n":1}',
      'function_call:zeta:{"n":2}',
    ],
  );
});

test("tool result signatures expose the latest and previous adjacent groups", async () => {
  const {
    latestToolResultSignaturesFromInput,
    previousToolResultSignaturesFromInput,
  } = await import("../src/responses-tool-signatures.js");
  const input = [
    {
      type: "function_call_output",
      call_id: "call-first",
      output: '{"b":2,"a":1}',
    },
    {
      type: "custom_tool_call_output",
      call_id: "call-second",
      output: "plain result",
    },
    { type: "message", role: "user", content: "next group" },
    {
      type: "tool_result",
      call_id: "call-third",
      content: { z: 9, a: 1 },
    },
  ];

  assert.deepEqual(previousToolResultSignaturesFromInput(input), [
    "custom_tool_call_output:plain result",
    'function_call_output:{"a":1,"b":2}',
  ]);
  assert.deepEqual(latestToolResultSignaturesFromInput(input), [
    'tool_result:{"a":1,"z":9}',
  ]);
});

test("bounded signature text hashes values longer than 2000 characters", async () => {
  const { boundedSignatureText } = await import(
    "../src/responses-tool-signatures.js"
  );

  assert.equal(boundedSignatureText("x".repeat(2000)), "x".repeat(2000));
  assert.equal(
    boundedSignatureText("x".repeat(2001)),
    "2001:9f2c9dcddb048a0b2baf27b3fec5efb480c7d9500ff0c6510b78f0033683c5c5",
  );
});
