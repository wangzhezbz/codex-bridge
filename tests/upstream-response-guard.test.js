import assert from "node:assert/strict";
import test from "node:test";

test("standalone upstream response guard rejects a body above the route byte limit", async () => {
  const {
    readUpstreamText,
    UpstreamResponseTooLargeError,
  } = await import("../src/upstream-response-guard.js");
  const response = new Response("12345", {
    headers: {
      "content-length": "5",
      "content-type": "text/plain; charset=utf-8",
    },
  });

  await assert.rejects(
    () => readUpstreamText(
      response,
      {},
      { id: "guard-test", maxUpstreamResponseBytes: 4 },
      "https://provider.example/v1/responses?key=secret",
    ),
    (error) => {
      assert.ok(error instanceof UpstreamResponseTooLargeError);
      assert.equal(error.code, "upstream_response_too_large");
      assert.equal(error.limitBytes, 4);
      assert.equal(error.actualBytes, 5);
      assert.equal(error.message.includes("key=secret"), false);
      return true;
    },
  );
});
