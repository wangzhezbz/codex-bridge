import assert from "node:assert/strict";
import test from "node:test";

test("user input signatures normalize visible and encrypted user inputs", async () => {
  const { userInputSignatures } = await import(
    "../src/responses-input-analysis.js"
  );

  assert.deepEqual(
    userInputSignatures([
      "  hello \n world  ",
      { type: "input_text", text: "  direct input  " },
      { type: "message", role: "user", content: " visible   user " },
      { type: "message", role: "user", encrypted_content: "opaque-user-token" },
      { type: "message", role: "assistant", content: "ignore assistant" },
      { type: "function_call_output", output: "ignore tool result" },
    ]),
    ["hello world", "direct input", "visible user", "opaque-user-token"],
  );
});

test("opaque input detection only counts encrypted user messages", async () => {
  const { inputHasOpaqueUserInput } = await import(
    "../src/responses-input-analysis.js"
  );

  assert.equal(
    inputHasOpaqueUserInput([
      { type: "message", role: "assistant", encrypted_content: "assistant-secret" },
      { type: "message", role: "user", content: "visible" },
    ]),
    false,
  );
  assert.equal(
    inputHasOpaqueUserInput([
      { type: "message", role: "user", encrypted_content: "encrypted-user-turn" },
    ]),
    true,
  );
});

test("tool protocol detection recognizes nested Responses and chat tool inputs", async () => {
  const { requestHasToolProtocolInput } = await import(
    "../src/responses-input-analysis.js"
  );

  assert.equal(
    requestHasToolProtocolInput({
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "function_call_output", call_id: "call-1", output: "done" },
          ],
        },
      ],
    }),
    true,
  );
  assert.equal(
    requestHasToolProtocolInput({
      messages: [
        {
          role: "assistant",
          tool_calls: [{ id: "call-2", type: "function" }],
        },
      ],
    }),
    true,
  );
  assert.equal(
    requestHasToolProtocolInput({
      input: [{ type: "message", role: "user", content: "ordinary request" }],
    }),
    false,
  );
});
