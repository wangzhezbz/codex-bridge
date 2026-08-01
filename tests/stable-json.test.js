import assert from "node:assert/strict";
import test from "node:test";

test("stable JSON serialization sorts object keys recursively", async () => {
  const { stableStringify } = await import("../src/stable-json.js");

  assert.equal(
    stableStringify({
      z: 9,
      nested: { second: 2, first: 1 },
      list: [{ beta: true, alpha: false }, null],
      a: "start",
    }),
    '{"a":"start","list":[{"alpha":false,"beta":true},null],"nested":{"first":1,"second":2},"z":9}',
  );
});

test("stable JSON serialization preserves array order", async () => {
  const { stableStringify } = await import("../src/stable-json.js");

  assert.equal(
    stableStringify(["second", "first", { b: 2, a: 1 }]),
    '["second","first",{"a":1,"b":2}]',
  );
});

test("stable JSON serialization keeps native primitive semantics", async () => {
  const { stableStringify } = await import("../src/stable-json.js");

  assert.equal(stableStringify(null), "null");
  assert.equal(stableStringify("text"), '"text"');
  assert.equal(stableStringify(42), "42");
  assert.equal(stableStringify(true), "true");
  assert.equal(stableStringify(undefined), undefined);
});
