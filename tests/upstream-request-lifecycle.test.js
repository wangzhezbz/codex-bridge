import assert from "node:assert/strict";
import test from "node:test";

test("standalone upstream request lifecycle maps its deadline to a timeout error", async () => {
  const {
    createUpstreamRequestLifecycle,
  } = await import("../src/upstream-request-lifecycle.js");
  const lifecycle = createUpstreamRequestLifecycle(
    {},
    "https://provider.example/v1/responses?key=secret",
    { id: "lifecycle-test" },
    { timeoutMs: 10 },
  );
  let guardTimeout = null;

  try {
    await Promise.race([
      new Promise((resolve) => {
        lifecycle.init.signal.addEventListener("abort", resolve, { once: true });
      }),
      new Promise((_, reject) => {
        guardTimeout = setTimeout(
          () => reject(new Error("Lifecycle did not abort within the test deadline.")),
          250,
        );
      }),
    ]);

    const error = lifecycle.errorFor(lifecycle.init.signal.reason);
    assert.equal(error.name, "UpstreamTimeoutError");
    assert.equal(error.code, "upstream_timeout");
    assert.equal(error.timeoutMs, 10);
    assert.equal(error.message.includes("key=secret"), false);
  } finally {
    if (guardTimeout) {
      clearTimeout(guardTimeout);
    }
    lifecycle.cleanup();
  }
});
