import test from "node:test";
import assert from "node:assert/strict";
import { ResponseHistory } from "../src/history.js";

test("response history trims oversized chat records by byte budget", () => {
  const history = new ResponseHistory({
    maxEntries: 10,
    maxEntryBytes: 600,
    maxTotalBytes: 2000,
  });

  history.record("resp_big", [
    { role: "user", content: "x".repeat(5000) },
    { role: "assistant", content: "finished" },
  ]);

  const stored = history.get("resp_big");
  const encoded = JSON.stringify(stored);
  assert.ok(encoded.length <= 700, encoded.length);
  assert.equal(stored.at(-1).content, "finished");
  assert.doesNotMatch(encoded, /x{1000}/);
});

test("response history evicts oldest entries by total byte budget", () => {
  const history = new ResponseHistory({
    maxEntries: 10,
    maxEntryBytes: 1000,
    maxTotalBytes: 1200,
  });

  history.record("resp_one", [{ role: "assistant", content: "a".repeat(700) }]);
  history.record("resp_two", [{ role: "assistant", content: "b".repeat(700) }]);

  assert.deepEqual(history.get("resp_one"), []);
  assert.notDeepEqual(history.get("resp_two"), []);
});

test("response history count trimming keeps unrelated chat records", () => {
  const history = new ResponseHistory({ maxEntries: 1 });

  history.record("chat_only", [{ role: "assistant", content: "keep me" }]);
  history.recordResponse({ id: "resp_one", output: [] });
  history.recordResponse({ id: "resp_two", output: [] });

  assert.equal(history.getResponse("resp_one"), null);
  assert.notEqual(history.getResponse("resp_two"), null);
  assert.deepEqual(history.get("chat_only"), [{ role: "assistant", content: "keep me" }]);
});
