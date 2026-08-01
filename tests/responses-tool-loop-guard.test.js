import assert from "node:assert/strict";
import test from "node:test";

import {
  localToolLoopGuardChat,
  maxChatToolContinuationTurns,
  repeatedNoProgressToolLoopTurns,
  repeatedToolResultHasNoProgress,
  requestHasResponseToolOutput,
  responseHasRunnableToolCall,
  responseRepeatsPreviousToolCall,
  sameStringArray,
  shouldStopChatToolContinuation,
} from "../src/responses-tool-loop-guard.js";

test("tool loop guard normalizes route continuation limits and stops only repeated runnable calls", () => {
  const response = {
    output: [
      {
        type: "function_call",
        call_id: "call-1",
        name: "lookup",
        arguments: "{}",
      },
    ],
  };

  assert.equal(maxChatToolContinuationTurns({ maxToolContinuationTurns: 2.9 }), 2);
  assert.equal(maxChatToolContinuationTurns({ max_tool_continuation_turns: 0 }), 0);
  assert.equal(maxChatToolContinuationTurns({ maxToolContinuationTurns: -1 }), 5);
  assert.equal(maxChatToolContinuationTurns({ maxToolContinuationTurns: "invalid" }), 5);
  assert.equal(responseHasRunnableToolCall(response), true);
  assert.equal(responseHasRunnableToolCall({ output: [{ type: "message" }] }), false);
  assert.equal(shouldStopChatToolContinuation(response, { maxToolContinuationTurns: 2 }, 2), true);
  assert.equal(shouldStopChatToolContinuation(response, { maxToolContinuationTurns: 2 }, 1), false);
  assert.equal(shouldStopChatToolContinuation({ output: [] }, { maxToolContinuationTurns: 1 }, 3), false);
});

test("tool loop guard detects response outputs and compares call signatures with history first", () => {
  const history = {
    getResponseMeta(responseId) {
      assert.equal(responseId, "resp-previous");
      return { toolCallSignatures: ["function_call:lookup:{}"] };
    },
  };

  assert.equal(
    requestHasResponseToolOutput({
      input: { type: "function_call_output", call_id: "call-1", output: "done" },
    }),
    true,
  );
  assert.equal(
    requestHasResponseToolOutput({ input: [{ type: "message", role: "user", content: "next" }] }),
    false,
  );
  assert.equal(
    responseRepeatsPreviousToolCall(
      ["function_call:lookup:{}"],
      { previous_response_id: "resp-previous" },
      history,
    ),
    true,
  );
  assert.equal(
    responseRepeatsPreviousToolCall(
      ["function_call:other:{}"],
      { previous_response_id: "resp-previous" },
      history,
    ),
    false,
  );
  assert.equal(responseRepeatsPreviousToolCall([], {}, history), false);
});

test("tool loop guard falls back to request signatures and accumulates no-progress turns", () => {
  const requestBody = {
    previous_response_id: "resp-previous",
    input: [
      { type: "function_call_output", call_id: "call-1", output: "same" },
      { type: "message", role: "user", content: "continue" },
      { type: "function_call_output", call_id: "call-2", output: "same" },
      { type: "message", role: "user", content: "continue again" },
      { type: "function_call_output", call_id: "call-3", output: "same" },
    ],
  };
  const historyWithSignatures = {
    getResponseMeta() {
      return { toolResultSignatures: ["function_call_output:same"] };
    },
  };

  assert.equal(
    repeatedToolResultHasNoProgress(
      ["function_call_output:same"],
      requestBody,
      historyWithSignatures,
    ),
    true,
  );
  assert.equal(
    repeatedNoProgressToolLoopTurns(
      requestBody,
      { getResponseMeta: () => ({ noProgressToolLoopTurns: 2 }) },
      true,
      true,
    ),
    3,
  );
  assert.equal(repeatedNoProgressToolLoopTurns(requestBody, null, true, true), 2);
  assert.equal(repeatedNoProgressToolLoopTurns(requestBody, null, false, true), 0);
  assert.equal(repeatedNoProgressToolLoopTurns(requestBody, null, true, false), 0);
});

test("tool loop guard returns a local assistant completion with bounded turn text", () => {
  const chat = localToolLoopGuardChat({ id: "cb-main", displayName: "Main Model" }, 3);

  assert.match(chat.id, /^chatcmpl_tool_loop_guard_[a-z0-9]+_[a-z0-9]+$/);
  assert.equal(chat.object, "chat.completion");
  assert.equal(chat.usage, null);
  assert.deepEqual(chat.choices, [
    {
      message: {
        role: "assistant",
        content: "模型一直重复调用工具，没有返回最终回答。报错信息：Main Model 连续 3 轮工具结果后仍请求新工具调用。",
      },
    },
  ]);
  assert.match(
    localToolLoopGuardChat({}, 0).choices[0].message.content,
    /当前模型 连续 1 轮/,
  );
});

test("tool loop guard exposes exact ordered signature comparison for upstream replay checks", () => {
  assert.equal(sameStringArray(["a", "b"], ["a", "b"]), true);
  assert.equal(sameStringArray(["a", "b"], ["b", "a"]), false);
  assert.equal(sameStringArray(["a"], ["a", "b"]), false);
  assert.equal(sameStringArray(null, []), false);
});
