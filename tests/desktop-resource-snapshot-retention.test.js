import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { retainCodexResourceSnapshots } = require("../desktop/resource-snapshot-retention.cjs");

const failed = (error = "temporarily unavailable") => ({
  ok: false,
  items: [],
  code: "probe_failed",
  error,
});

test("resource refresh retains the previous authoritative CLI, prompt, and app-server kinds", () => {
  const previous = {
    executable: "C:\\ChatGPT\\codex.exe",
    codexCliSnapshot: {
      executable: "C:\\ChatGPT\\codex.exe",
      plugins: { ok: true, items: [{ id: "sites@openai-bundled" }] },
      mcpServers: { ok: true, items: [{ name: "node_repl" }] },
    },
    codexPromptInputSnapshot: { ok: true, items: [{ type: "message" }] },
    codexAppServerSnapshot: {
      ok: true,
      refreshedAt: "2026-07-14T00:00:00.000Z",
      snapshotSource: "codex-app-server",
      plugins: { ok: true, items: [{ id: "sites@openai-bundled" }] },
      apps: { ok: true, items: [{ id: "sites" }] },
      skills: { ok: true, items: [{ id: "skill-one" }] },
    },
  };
  const fresh = {
    executable: "",
    codexCliSnapshot: {
      executable: "",
      plugins: failed("CLI starting"),
      mcpServers: failed("CLI starting"),
    },
    codexPromptInputSnapshot: failed("prompt starting"),
    codexAppServerSnapshot: {
      ok: false,
      refreshedAt: "2026-07-14T00:00:01.000Z",
      snapshotSource: "codex-app-server",
      plugins: failed("app-server starting"),
      apps: failed("app-server starting"),
      skills: failed("app-server starting"),
    },
  };

  const retained = retainCodexResourceSnapshots(fresh, previous);

  assert.equal(retained.executable, previous.executable);
  assert.equal(retained.codexCliSnapshot.plugins.ok, true);
  assert.equal(retained.codexCliSnapshot.plugins.stale, true);
  assert.equal(retained.codexCliSnapshot.mcpServers.ok, true);
  assert.equal(retained.codexPromptInputSnapshot.ok, true);
  assert.equal(retained.codexPromptInputSnapshot.stale, true);
  assert.deepEqual(retained.codexAppServerSnapshot.apps.items, [{ id: "sites" }]);
  assert.equal(retained.codexAppServerSnapshot.apps.stale, true);
  assert.equal(retained.codexAppServerSnapshot.snapshotSource, "last_authoritative_cache");
});

test("resource refresh replaces each authority once a fresh successful result arrives", () => {
  const previous = {
    codexCliSnapshot: { plugins: { ok: true, items: [{ id: "old" }] }, mcpServers: { ok: true, items: [] } },
    codexPromptInputSnapshot: { ok: true, items: [{ id: "old" }] },
    codexAppServerSnapshot: {
      plugins: { ok: true, items: [{ id: "old" }] },
      apps: { ok: true, items: [{ id: "old" }] },
      skills: { ok: true, items: [{ id: "old" }] },
    },
  };
  const fresh = {
    codexCliSnapshot: { plugins: { ok: true, items: [{ id: "new" }] }, mcpServers: { ok: true, items: [] } },
    codexPromptInputSnapshot: { ok: true, items: [{ id: "new" }] },
    codexAppServerSnapshot: {
      snapshotSource: "codex-app-server",
      plugins: { ok: true, items: [{ id: "new" }] },
      apps: { ok: true, items: [{ id: "new" }] },
      skills: { ok: true, items: [{ id: "new" }] },
    },
  };

  const retained = retainCodexResourceSnapshots(fresh, previous);

  assert.deepEqual(retained.codexCliSnapshot.plugins.items, [{ id: "new" }]);
  assert.deepEqual(retained.codexPromptInputSnapshot.items, [{ id: "new" }]);
  assert.deepEqual(retained.codexAppServerSnapshot.apps.items, [{ id: "new" }]);
  assert.equal(retained.codexAppServerSnapshot.snapshotSource, "codex-app-server");
});
