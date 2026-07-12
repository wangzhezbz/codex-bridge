import test from "node:test";
import assert from "node:assert/strict";

import { commitThenPublishConfigMutation } from "../desktop/config-mutation-handler.mjs";

test("a mutation publishes exactly once only after commit and success logging", async () => {
  const events = [];
  const result = await commitThenPublishConfigMutation({
    async commit() {
      events.push("commit:start");
      await Promise.resolve();
      events.push("commit:done");
      return { configRevision: "revision-1" };
    },
    async onCommitted(committed) {
      events.push(`log:${committed.configRevision}`);
    },
    async publish(committed) {
      events.push(`publish:${committed.configRevision}`);
    },
  });

  assert.deepEqual(result, { configRevision: "revision-1" });
  assert.deepEqual(events, [
    "commit:start",
    "commit:done",
    "log:revision-1",
    "publish:revision-1",
  ]);
});

test("commit rejection produces no success log or publish", async () => {
  const events = [];
  await assert.rejects(
    commitThenPublishConfigMutation({
      async commit() {
        events.push("commit:start");
        throw new Error("injected commit failure");
      },
      async onCommitted() {
        events.push("log");
      },
      async publish() {
        events.push("publish");
      },
    }),
    /injected commit failure/,
  );
  assert.deepEqual(events, ["commit:start"]);
});

test("success-hook rejection cannot suppress publication after a durable commit", async () => {
  const events = [];
  const result = await commitThenPublishConfigMutation({
    commit: async () => ({ configRevision: "revision-2" }),
    async onCommitted() {
      events.push("log:start");
      throw new Error("injected log failure");
    },
    async publish() {
      events.push("publish");
    },
    async onPostCommitError(error, phase) {
      events.push(`error:${phase}:${error.message}`);
    },
  });
  assert.deepEqual(result, { configRevision: "revision-2" });
  assert.deepEqual(events, [
    "log:start",
    "error:onCommitted:injected log failure",
    "publish",
  ]);
});

test("publish rejection cannot turn a durable commit into a retryable mutation failure", async () => {
  const events = [];
  const result = await commitThenPublishConfigMutation({
    commit: async () => ({ configRevision: "revision-3" }),
    async publish() {
      events.push("publish:start");
      throw new Error("injected publish failure");
    },
    async onPostCommitError(error, phase) {
      events.push(`error:${phase}:${error.message}`);
      throw new Error("diagnostic hook also failed");
    },
  });
  assert.deepEqual(result, { configRevision: "revision-3" });
  assert.deepEqual(events, [
    "publish:start",
    "error:publish:injected publish failure",
  ]);
});
