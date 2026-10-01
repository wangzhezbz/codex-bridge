import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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
    fs.mkdirSync(path.join(fixture.codexDir, "skills"), { recursive: true });
    for (const filePath of [
      path.join(fixture.dataDir, "model-catalog.json"),
      path.join(fixture.dataDir, "config", "desktop-options.json"),
      path.join(fixture.dataDir, "config", "model-selection.json"),
      path.join(fixture.dataDir, "config", "router.config.json"),
      path.join(fixture.dataDir, "state", "response-history.sqlite3"),
      path.join(fixture.dataDir, "state", "response-history.sqlite3-shm"),
      path.join(fixture.dataDir, "state", "response-history.sqlite3-wal"),
      path.join(fixture.codexDir, "codexbridge-model-catalog.json"),
      path.join(fixture.codexDir, "config.toml"),
      path.join(fixture.codexDir, "config.codexbridge-router-original.toml"),
    ]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "", "utf8");
    }
    fs.mkdirSync(path.join(fixture.dataDir, "config", ".transactions"), { recursive: true });
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


test("software smoke waits for initialization and checks the Codex-only management tabs", () => {
  const source = fs.readFileSync(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  const smoke = source.slice(source.indexOf("let softwareManagerSmoke = null;"));
  assert.match(smoke, /softwareManagerLoaded && !softwareManagerLoading[\s\S]*?"software manager initialization"[\s\S]*?"Codex-only " \+ tab/);
  assert.match(smoke, /cardNames\.join\(","\) !== "Codex"/);
  assert.doesNotMatch(smoke, /unified Skill list|selectablePluginRows/);
});
