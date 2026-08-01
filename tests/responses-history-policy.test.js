import assert from "node:assert/strict";
import test from "node:test";
import { ResponseHistory } from "../src/history.js";

test("responses history policy requires a previous response id and metadata-capable history", async () => {
  const { shouldInlineLocalHistoryForResponses } = await import(
    "../src/responses-history-policy.js"
  );

  assert.equal(shouldInlineLocalHistoryForResponses({}, new ResponseHistory()), false);
  assert.equal(
    shouldInlineLocalHistoryForResponses(
      { previous_response_id: "resp_chatcmpl_legacy" },
      { get: () => [{ role: "assistant", content: "legacy" }] },
    ),
    false,
  );
});

test("responses history policy follows explicit upstream metadata", async () => {
  const { shouldInlineLocalHistoryForResponses } = await import(
    "../src/responses-history-policy.js"
  );
  const history = new ResponseHistory();
  history.recordTurn({
    responseId: "resp_local_meta",
    messages: [{ role: "assistant", content: "local answer" }],
    response: { id: "resp_local_meta", object: "response", output: [] },
    meta: { upstreamKnown: false },
  });
  history.recordTurn({
    responseId: "resp_upstream_meta",
    messages: [{ role: "assistant", content: "upstream answer" }],
    response: { id: "resp_upstream_meta", object: "response", output: [] },
    meta: { upstreamKnown: true },
  });

  assert.equal(
    shouldInlineLocalHistoryForResponses(
      { previous_response_id: "resp_local_meta" },
      history,
    ),
    true,
  );
  assert.equal(
    shouldInlineLocalHistoryForResponses(
      { previous_response_id: "resp_upstream_meta" },
      history,
    ),
    false,
  );
});

test("responses history policy recognizes populated legacy local chat ids", async () => {
  const { shouldInlineLocalHistoryForResponses } = await import(
    "../src/responses-history-policy.js"
  );
  const history = new ResponseHistory();
  history.record("resp_chatcmpl_legacy", [
    { role: "assistant", content: "legacy underscore answer" },
  ]);
  history.record("resp_chatcmpl-legacy", [
    { role: "assistant", content: "legacy hyphen answer" },
  ]);

  assert.equal(
    shouldInlineLocalHistoryForResponses(
      { previous_response_id: "resp_chatcmpl_legacy" },
      history,
    ),
    true,
  );
  assert.equal(
    shouldInlineLocalHistoryForResponses(
      { previous_response_id: "resp_chatcmpl-legacy" },
      history,
    ),
    true,
  );
});

test("responses history policy rejects empty or ordinary response history without metadata", async () => {
  const { shouldInlineLocalHistoryForResponses } = await import(
    "../src/responses-history-policy.js"
  );
  const history = new ResponseHistory();
  history.record("resp_ordinary_local_cache", [
    { role: "assistant", content: "must stay server-side" },
  ]);

  assert.equal(
    shouldInlineLocalHistoryForResponses(
      { previous_response_id: "resp_chatcmpl_missing" },
      history,
    ),
    false,
  );
  assert.equal(
    shouldInlineLocalHistoryForResponses(
      { previous_response_id: "resp_ordinary_local_cache" },
      history,
    ),
    false,
  );
});

test("stateless Responses routes inline provider-owned history", async () => {
  const { shouldInlineLocalHistoryForResponses } = await import(
    "../src/responses-history-policy.js"
  );
  const history = new ResponseHistory();
  history.recordTurn({
    responseId: "resp_deepseek_flash_first",
    messages: [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ],
    response: { id: "resp_deepseek_flash_first", object: "response", output: [] },
    meta: { upstreamKnown: true },
  });

  assert.equal(
    shouldInlineLocalHistoryForResponses(
      { previous_response_id: "resp_deepseek_flash_first" },
      history,
      {
        api: "responses",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        supportsResponsePreviousId: false,
      },
    ),
    true,
  );
});
