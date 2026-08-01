import assert from "node:assert/strict";
import test from "node:test";

import { COMPACT_SUMMARY_PREFIX } from "../src/compact.js";

test("responses compaction payload converts bridge plaintext summaries in input and messages", async (t) => {
  const { normalizeBridgePlainCompactionPayload } = await import(
    "../src/responses-compaction-payload.js"
  );
  t.mock.method(console, "warn", () => {});
  const firstSummary = `${COMPACT_SUMMARY_PREFIX}\nSummary: preserve the active task.`;
  const secondSummary = `${COMPACT_SUMMARY_PREFIX}\nSummary: preserve tool state.`;
  const opaqueCompaction = {
    type: "compaction",
    encrypted_content: "opaque-openai-compaction-v2",
  };
  const ordinaryMessage = {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "continue" }],
  };
  const payload = {
    model: "gpt-responses",
    input: [
      { type: "compaction", encrypted_content: firstSummary },
      opaqueCompaction,
      ordinaryMessage,
    ],
    messages: [
      { type: "context_compaction", encrypted_content: secondSummary },
    ],
    metadata: { keep: true },
  };

  normalizeBridgePlainCompactionPayload(
    payload,
    { api: "responses" },
    { requestId: "req_compaction_payload" },
  );

  assert.deepEqual(payload, {
    model: "gpt-responses",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: firstSummary }],
      },
      opaqueCompaction,
      ordinaryMessage,
    ],
    messages: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: secondSummary }],
      },
    ],
    metadata: { keep: true },
  });
});

test("compaction payload normalization leaves non-Responses routes unchanged", async (t) => {
  const { normalizeBridgePlainCompactionPayload } = await import(
    "../src/responses-compaction-payload.js"
  );
  const warnings = [];
  t.mock.method(console, "warn", (message) => warnings.push(message));
  const payload = {
    input: [
      {
        type: "compaction",
        encrypted_content: `${COMPACT_SUMMARY_PREFIX}\nSummary: chat route must keep this item.`,
      },
    ],
  };
  const original = structuredClone(payload);

  normalizeBridgePlainCompactionPayload(payload, { api: "chat_completions" }, {
    requestId: "req_chat_payload",
  });

  assert.deepEqual(payload, original);
  assert.deepEqual(warnings, []);
});

test("compaction payload normalization ignores scalars and non-prefix compaction content", async (t) => {
  const { normalizeBridgePlainCompactionPayload } = await import(
    "../src/responses-compaction-payload.js"
  );
  const warnings = [];
  t.mock.method(console, "warn", (message) => warnings.push(message));
  const payload = {
    input: "plain input",
    messages: [
      {
        type: "context_compaction",
        encrypted_content: `opaque-prefix\n${COMPACT_SUMMARY_PREFIX}`,
      },
      { type: "compaction", encrypted_content: null },
    ],
  };
  const originalInput = payload.input;
  const originalMessages = payload.messages;

  normalizeBridgePlainCompactionPayload(payload, { api: "responses" });

  assert.equal(payload.input, originalInput);
  assert.equal(payload.messages, originalMessages);
  assert.deepEqual(warnings, []);
});
