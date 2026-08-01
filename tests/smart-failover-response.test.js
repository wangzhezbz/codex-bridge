import assert from "node:assert/strict";
import test from "node:test";

test("smart failover notice uses display labels and a localized reason", async () => {
  const { smartFailoverNotice } = await import(
    "../src/smart-failover-response.js"
  );

  assert.equal(
    smartFailoverNotice(
      {
        fromRoute: "primary",
        fromModel: "primary-model",
        toRoute: "backup",
        toModel: "backup-model",
        reason: "rate_limited",
      },
      {
        fromDisplayName: "主模型",
        toDisplayName: "备用模型",
      },
    ),
    "已自动切换模型：主模型 -> 备用模型。原因：原供应商限流。",
  );
});

test("smart failover notice falls back to route labels and raw reasons", async () => {
  const { smartFailoverNotice } = await import(
    "../src/smart-failover-response.js"
  );

  assert.equal(
    smartFailoverNotice(
      { fromRoute: "route-a", toRoute: "route-b", reason: "custom_failure" },
    ),
    "已自动切换模型：route-a -> route-b。原因：custom_failure。",
  );
});

test("prepend response output text updates the summary and first text part", async () => {
  const { prependResponseOutputText } = await import(
    "../src/smart-failover-response.js"
  );
  const response = {
    id: "resp-existing",
    output_text: "original summary",
    output: [
      {
        type: "message",
        content: [
          { type: "refusal", refusal: "not this part" },
          { type: "output_text", text: "original message", annotations: [] },
        ],
      },
    ],
  };

  prependResponseOutputText(response, "  failover notice  ");

  assert.equal(response.output_text, "failover notice\n\noriginal summary");
  assert.equal(
    response.output[0].content[1].text,
    "failover notice\n\noriginal message",
  );
});

test("prepend response output text creates a message for an empty response", async () => {
  const { prependResponseOutputText } = await import(
    "../src/smart-failover-response.js"
  );
  const response = { id: "resp-empty" };

  prependResponseOutputText(response, "failover notice");

  assert.equal(response.output_text, "failover notice");
  assert.deepEqual(response.output, [
    {
      id: "msg_resp-empty",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: "failover notice",
          annotations: [],
        },
      ],
    },
  ]);
});

test("smart failover annotation adds sanitized metadata and a visible notice", async () => {
  const { annotateSmartFailoverResponse } = await import(
    "../src/smart-failover-response.js"
  );
  const response = {
    id: "resp-failover",
    output_text: "original answer",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "original answer", annotations: [] }],
      },
    ],
  };

  const result = annotateSmartFailoverResponse(
    response,
    { id: "cb-backup", displayName: "备用模型", model: "backup\nmodel" },
    {
      failoverFromRoute: " cb-main\r\nroute ",
      failoverFromDisplayName: "主模型",
      failoverFromModel: "main\nmodel",
      smartFailoverReason: "rate_limited\n",
    },
  );

  assert.equal(result, response);
  assert.deepEqual(response.codexbridge_smart_failover, {
    fromRoute: "cb-main route",
    fromModel: "main model",
    toRoute: "cb-backup",
    toModel: "backup model",
    reason: "rate_limited",
  });
  assert.equal(
    response.output_text,
    "已自动切换模型：主模型 -> 备用模型。原因：原供应商限流。\n\noriginal answer",
  );
  assert.equal(
    response.output[0].content[0].text,
    "已自动切换模型：主模型 -> 备用模型。原因：原供应商限流。\n\noriginal answer",
  );
});

test("smart failover annotation leaves responses unchanged without both route and reason", async () => {
  const { annotateSmartFailoverResponse } = await import(
    "../src/smart-failover-response.js"
  );
  const withoutReason = { id: "resp-without-reason", output_text: "answer" };
  const withoutRoute = { id: "resp-without-route", output_text: "answer" };

  assert.equal(
    annotateSmartFailoverResponse(
      withoutReason,
      { id: "cb-backup" },
      { failoverFromRoute: "cb-main" },
    ),
    withoutReason,
  );
  assert.equal(
    annotateSmartFailoverResponse(
      withoutRoute,
      { id: "cb-backup" },
      { smartFailoverReason: "rate_limited" },
    ),
    withoutRoute,
  );
  assert.equal("codexbridge_smart_failover" in withoutReason, false);
  assert.equal("codexbridge_smart_failover" in withoutRoute, false);
});
