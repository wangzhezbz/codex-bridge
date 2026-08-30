import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  cleanupSourceDesktopSmokeFixture,
  createSourceDesktopSmokeFixture,
} from "../scripts/desktop-smoke-fixture.mjs";

test("source desktop smoke fixture isolates Codex home, app data, and resource discovery", () => {
  const fixture = createSourceDesktopSmokeFixture();
  try {
    assert.ok(fs.existsSync(fixture.homeDir));
    assert.ok(fs.existsSync(fixture.dataDir));
    assert.ok(fs.existsSync(fixture.snapshotPath));
    assert.equal(fixture.env.CODEXBRIDGE_DESKTOP_SMOKE_HOME, fixture.homeDir);
    assert.equal(fixture.env.CODEXBRIDGE_DATA_DIR, fixture.dataDir);
    assert.equal(fixture.env.CODEXBRIDGE_DESKTOP_SMOKE_RESOURCE_SNAPSHOT, fixture.snapshotPath);

    const snapshot = JSON.parse(fs.readFileSync(fixture.snapshotPath, "utf8"));
    assert.deepEqual(snapshot.codexCliSnapshot.plugins.items, []);
    assert.deepEqual(snapshot.codexCliSnapshot.mcpServers.items, []);
    assert.deepEqual(snapshot.codexPromptInputSnapshot.items, []);
    assert.deepEqual(snapshot.codexAppServerSnapshot.plugins.items, []);
    assert.deepEqual(snapshot.codexAppServerSnapshot.apps.items, []);
    assert.deepEqual(snapshot.codexAppServerSnapshot.skills.items, []);
  } finally {
    cleanupSourceDesktopSmokeFixture(fixture);
  }
  assert.equal(fs.existsSync(fixture.rootDir), false);
});

test("source desktop smoke launcher always applies and cleans the isolated fixture", () => {
  const source = fs.readFileSync(new URL("../scripts/desktop-smoke.mjs", import.meta.url), "utf8");
  assert.match(source, /createSourceDesktopSmokeFixture\(\)/);
  assert.match(source, /\.\.\.fixture\.env/);
  assert.match(source, /cleanupSourceDesktopSmokeFixture\(fixture\)/);
});
