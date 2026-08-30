import assert from "node:assert/strict";
import test from "node:test";
import {
  UpstreamResponseTooLargeError,
  UpstreamTimeoutError,
} from "../src/upstream-response-guard.js";
import { parseSseEvents } from "../src/sse.js";

test("standalone upstream error presentation preserves the diagnostic code without leaking URL secrets", async () => {
  const {
    createUpstreamErrorPresentation,
  } = await import("../src/upstream-error-presentation.js");
  class TestUpstreamHttpError extends Error {}
  class TestUpstreamNetworkError extends Error {}
  class TestUpstreamStreamError extends Error {}
  const presentation = createUpstreamErrorPresentation({
    UpstreamHttpError: TestUpstreamHttpError,
    UpstreamNetworkError: TestUpstreamNetworkError,
    UpstreamStreamError: TestUpstreamStreamError,
  });
  const res = collectResponse();

  presentation.sendUpstreamError(
    res,
    new UpstreamResponseTooLargeError(
      64,
      128,
      "https://provider.example/v1/responses?api_key=secret-value",
      { id: "presentation-test" },
    ),
  );

  const body = JSON.parse(res.body());
  assert.equal(res.statusCode, 502);
  assert.equal(body.error.code, "upstream_response_too_large");
  assert.equal(body.error.message.includes("secret-value"), false);
});

test("Responses stream failures preserve their classified machine error codes", async () => {
  const {
    createUpstreamErrorPresentation,
  } = await import("../src/upstream-error-presentation.js");
  class TestUpstreamHttpError extends Error {
    constructor(statusCode, bodyText, route = {}) {
      super(`Upstream returned HTTP ${statusCode}`);
      this.statusCode = statusCode;
      this.bodyText = bodyText;
      this.route = route;
    }
  }
  class TestUpstreamNetworkError extends Error {}
  class TestUpstreamStreamError extends Error {}
  const presentation = createUpstreamErrorPresentation({
    UpstreamHttpError: TestUpstreamHttpError,
    UpstreamNetworkError: TestUpstreamNetworkError,
    UpstreamStreamError: TestUpstreamStreamError,
    UpstreamTimeoutError,
  });
  const cases = [
    {
      error: new TestUpstreamHttpError(
        400,
        JSON.stringify({ error: { message: "invalid parameter" } }),
        { id: "parameter-route" },
      ),
      code: "upstream_parameter_error",
    },
    {
      error: new TestUpstreamHttpError(
        429,
        JSON.stringify({ error: { message: "rate limit" } }),
        { id: "rate-route" },
      ),
      code: "upstream_rate_limit",
    },
    {
      error: new UpstreamTimeoutError(
        1000,
        "https://provider.example/v1",
        { id: "timeout-route" },
      ),
      code: "upstream_timeout",
    },
    {
      error: new UpstreamResponseTooLargeError(
        64,
        128,
        "https://provider.example/v1",
        { id: "large-route" },
      ),
      code: "upstream_response_too_large",
    },
  ];

  for (const item of cases) {
    const res = collectResponse();
    presentation.sendUpstreamError(res, item.error, {
      asResponsesStream: true,
      model: "test-model",
    });
    const failed = parseSseEvents(res.body()).find(
      (event) => event.event === "response.failed",
    );
    const payload = JSON.parse(failed.data);
    assert.equal(payload.response.error.code, item.code);
  }
});

test("responses stream failure message prefers the display name and sanitizes diagnostic detail", async () => {
  const { responsesStreamFailureMessage } = await import(
    "../src/upstream-error-presentation.js"
  );

  const message = responsesStreamFailureMessage(
    {
      displayName: "GPT-5.6-Sol",
      id: "sol-route",
      model: "gpt-5.6-sol",
    },
    new Error("Bearer sk-supersecretvalue\n socket closed"),
  );

  assert.equal(
    message,
    "CodexBridge upstream stream from GPT-5.6-Sol disconnected before response.completed. Bearer [REDACTED] socket closed",
  );
  assert.equal(message.includes("supersecretvalue"), false);
});

test("responses stream failure message uses the stable route label fallback order", async () => {
  const { responsesStreamFailureMessage } = await import(
    "../src/upstream-error-presentation.js"
  );

  assert.equal(
    responsesStreamFailureMessage({ id: "route-id", model: "model-id" }, "reset"),
    "CodexBridge upstream stream from route-id disconnected before response.completed. reset",
  );
  assert.equal(
    responsesStreamFailureMessage({ model: "model-id" }, "reset"),
    "CodexBridge upstream stream from model-id disconnected before response.completed. reset",
  );
  assert.equal(
    responsesStreamFailureMessage({}, null),
    "CodexBridge upstream stream from route disconnected before response.completed.",
  );
});

test("responses stream failure message limits diagnostic detail to 300 characters", async () => {
  const { responsesStreamFailureMessage } = await import(
    "../src/upstream-error-presentation.js"
  );
  const prefix = "CodexBridge upstream stream from route-id disconnected before response.completed. ";

  const message = responsesStreamFailureMessage(
    { id: "route-id" },
    new Error("x".repeat(305)),
  );

  assert.equal(message, `${prefix}${"x".repeat(300)}`);
});

function collectResponse() {
  const chunks = [];
  return {
    headersSent: false,
    writableEnded: false,
    statusCode: 0,
    writeHead(statusCode) {
      this.statusCode = statusCode;
      this.headersSent = true;
    },
    end(chunk = "") {
      chunks.push(Buffer.from(String(chunk)));
      this.writableEnded = true;
    },
    body() {
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}
