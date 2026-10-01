import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { runInNewContext } from "node:vm";

import {
  installCuratedCodexPluginResource,
  listCuratedCodexPluginResources,
  removeCuratedCodexPluginResource,
} from "../desktop/settings.mjs";

function fakeCodex(homeDir) {
  const cli = path.join(homeDir, "fake-codex-cli.mjs");
  const log = path.join(homeDir, "calls.jsonl");
  const state = path.join(homeDir, "plugins.json");
  const marketplaceState = path.join(homeDir, "marketplaces.json");
  const codexHome = path.join(homeDir, ".codex");
  const cowartRoot = path.join(codexHome, ".tmp", "marketplaces", "cowart-github");
  fs.writeFileSync(state, JSON.stringify([
    { id: "cowart@cowart-github", enabled: true, version: "0.1.25" },
    { id: "claude-mem@personal", enabled: true, version: "13.14.0" },
  ]), "utf8");
  fs.mkdirSync(path.join(cowartRoot, ".git"), { recursive: true });
  fs.writeFileSync(path.join(cowartRoot, ".git", "HEAD"), "6a338f016dee21fd97346c5fd8fe1bd81b1a7522\n", "utf8");
  fs.writeFileSync(marketplaceState, JSON.stringify([{
    name: "cowart-github",
    root: cowartRoot,
    marketplaceSource: { sourceType: "git", source: "https://github.com/zhongerxin/cowart.git" },
  }]), "utf8");
  fs.writeFileSync(cli, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const args = process.argv.slice(2);",
    "if (Number(process.env.CODEX_FAKE_DELAY_MS || 0) > 0) await new Promise((resolve) => setTimeout(resolve, Number(process.env.CODEX_FAKE_DELAY_MS)));",
    "fs.appendFileSync(process.env.CODEX_FAKE_LOG, JSON.stringify(args) + '\\n');",
    "const read = () => JSON.parse(fs.readFileSync(process.env.CODEX_FAKE_STATE, 'utf8'));",
    "const write = (items) => fs.writeFileSync(process.env.CODEX_FAKE_STATE, JSON.stringify(items));",
    "const readMarketplaces = () => JSON.parse(fs.readFileSync(process.env.CODEX_FAKE_MARKETPLACES, 'utf8'));",
    "const writeMarketplaces = (items) => fs.writeFileSync(process.env.CODEX_FAKE_MARKETPLACES, JSON.stringify(items));",
    "const removeCheckout = (root) => { try { fs.unlinkSync(path.join(root, '.git', 'HEAD')); } catch {} try { fs.rmdirSync(path.join(root, '.git')); } catch {} try { fs.rmdirSync(root); } catch {} };",
    "if (args.join(' ') === 'plugin marketplace list --json') { console.log(JSON.stringify({ marketplaces: readMarketplaces() })); process.exit(0); }",
    "if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'remove') { const existing = readMarketplaces(); const found = existing.find((item) => item.name === args[3]); if (found) removeCheckout(found.root); writeMarketplaces(existing.filter((item) => item.name !== args[3])); console.log(JSON.stringify({ ok: true, marketplaceName: args[3] })); process.exit(0); }",
    "if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') { const repo = args[3]; const refIndex = args.indexOf('--ref'); const commit = refIndex >= 0 ? args[refIndex + 1] : ''; const name = repo === 'thedotmack/claude-mem' ? 'claude-mem-local' : repo === 'zhongerxin/cowart' ? 'cowart-github' : ''; if (!name || !/^[a-f0-9]{40}$/.test(commit)) process.exit(8); const root = path.join(process.env.CODEX_HOME, '.tmp', 'marketplaces', name); fs.mkdirSync(path.join(root, '.git'), { recursive: true }); fs.writeFileSync(path.join(root, '.git', 'HEAD'), commit + '\\n'); writeMarketplaces([...readMarketplaces().filter((item) => item.name !== name), { name, root, marketplaceSource: { sourceType: 'git', source: 'https://github.com/' + repo + '.git' } }]); console.log(JSON.stringify({ ok: true, marketplaceName: name, installedRoot: root })); process.exit(0); }",
    "if (args.join(' ') === 'plugin list --json') { console.log(JSON.stringify(read())); process.exit(0); }",
    "if (args[0] === 'plugin' && args[1] === 'remove') { write(read().filter((item) => item.id !== args[2])); console.log(JSON.stringify({ ok: true, args })); process.exit(0); }",
    "if (args[0] === 'plugin' && args[1] === 'add') { const name = args[2].split('@')[0]; write([...read().filter((item) => item.id.split('@')[0] !== name), { id: args[2], enabled: true, version: '1.0.0' }]); console.log(JSON.stringify({ ok: true, args })); process.exit(0); }",
    "if (args[0] === 'plugin') { console.log(JSON.stringify({ ok: true, args })); process.exit(0); }",
    "process.exit(9);",
  ].join("\n"), "utf8");
  return {
    cli,
    log,
    state,
    marketplaceState,
    env: {
      CODEX_FAKE_LOG: log,
      CODEX_FAKE_STATE: state,
      CODEX_FAKE_MARKETPLACES: marketplaceState,
    },
  };
}

test("curated plugin runtime installs full pinned marketplaces and verifies the installed plugin", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "curated-plugin-home-"));
  const fixture = fakeCodex(homeDir);
  const result = await installCuratedCodexPluginResource({
    homeDir,
    id: "cowart",
    executable: process.execPath,
    codexCliArgsPrefix: [fixture.cli],
    env: fixture.env,
  });
  assert.equal(result.ok, true);
  assert.equal(result.id, "cowart");
  assert.equal(result.selector, "cowart@cowart-github");
  assert.equal(result.installed, true);
  assert.equal(fs.statSync(path.join(homeDir, ".codex")).isDirectory(), true);
  const calls = fs.readFileSync(fixture.log, "utf8").trim().split(/\r?\n/u).map(JSON.parse);
  assert.deepEqual(calls, [
    ["plugin", "list", "--json"],
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "remove", "cowart@cowart-github", "--json"],
    ["plugin", "marketplace", "remove", "cowart-github", "--json"],
    ["plugin", "marketplace", "add", "zhongerxin/cowart", "--ref", "6a338f016dee21fd97346c5fd8fe1bd81b1a7522", "--json"],
    ["plugin", "add", "cowart@cowart-github", "--json"],
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "list", "--json"],
  ]);
});

test("curated plugin runtime reports status, removes the installed selector, and force-replaces another source", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "curated-plugin-home-"));
  const fixture = fakeCodex(homeDir);
  const listed = await listCuratedCodexPluginResources({
    homeDir, executable: process.execPath, codexCliArgsPrefix: [fixture.cli], env: fixture.env,
  });
  assert.equal(listed.find(({ id }) => id === "cowart")?.installed, true);
  assert.equal(listed.find(({ id }) => id === "claude-mem")?.installed, true);
  assert.equal(listed.find(({ id }) => id === "claude-mem")?.managed, false);
  assert.equal(listed.find(({ id }) => id === "cowart")?.managed, true);

  const removed = await removeCuratedCodexPluginResource({
    homeDir, id: "cowart", executable: process.execPath, codexCliArgsPrefix: [fixture.cli], env: fixture.env,
  });
  assert.equal(removed.removed, true);
  assert.equal(removed.marketplaceRemoved, true);
  assert.equal(removed.selector, "cowart@cowart-github");
  const replaced = await installCuratedCodexPluginResource({
    homeDir, id: "claude-mem", executable: process.execPath, codexCliArgsPrefix: [fixture.cli], env: fixture.env,
  });
  assert.equal(replaced.installed, true);
  assert.equal(replaced.selector, "claude-mem@claude-mem-local");
  assert.equal(JSON.parse(fs.readFileSync(fixture.state, "utf8")).some(({ id }) => id === "claude-mem@personal"), false);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(fixture.marketplaceState, "utf8")).map(({ name }) => name),
    ["claude-mem-local"],
  );
  await assert.rejects(() => installCuratedCodexPluginResource({
    homeDir, id: "arbitrary", executable: process.execPath, codexCliArgsPrefix: [fixture.cli], env: fixture.env,
  }), /curated_plugin_not_allowed/u);
});

test("curated plugins remain visible when Codex CLI status detection is unavailable", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "curated-plugin-missing-cli-"));
  const listed = await listCuratedCodexPluginResources({
    homeDir,
    executable: path.join(homeDir, "missing-codex.exe"),
  });
  assert.deepEqual(listed.map(({ id }) => id), ["claude-mem", "cowart"]);
  assert.equal(listed.every(({ installed }) => installed === false), true);
  assert.equal(listed.every(({ detectionAvailable }) => detectionAvailable === false), true);
  assert.equal(listed.every(({ detectionError }) => typeof detectionError === "string" && detectionError.length > 0), true);
});

test("curated plugin detection never blocks the Electron event loop", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "curated-plugin-async-"));
  const fixture = fakeCodex(homeDir);
  let timerFired = false;
  setTimeout(() => { timerFired = true; }, 25);
  const listed = await listCuratedCodexPluginResources({
    homeDir,
    codexCliArgsPrefix: [fixture.cli],
    env: { ...fixture.env, CODEX_CLI_PATH: process.execPath, CODEX_FAKE_DELAY_MS: "100" },
  });
  assert.equal(timerFired, true);
  assert.equal(listed.length, 2);
});

test("curated plugin install shares one total deadline and reports command timeouts clearly", async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "curated-plugin-timeout-"));
  const fixture = fakeCodex(homeDir);
  await assert.rejects(
    installCuratedCodexPluginResource({
      homeDir,
      id: "claude-mem",
      executable: process.execPath,
      codexCliArgsPrefix: [fixture.cli],
      env: { ...fixture.env, CODEX_FAKE_DELAY_MS: "100" },
      timeoutMs: 10,
    }),
    /命令超时（1 秒）/u,
  );

  const sharedHome = fs.mkdtempSync(path.join(os.tmpdir(), "curated-plugin-shared-timeout-"));
  const sharedFixture = fakeCodex(sharedHome);
  let now = 1000;
  const commands = [];
  const clock = t.mock.method(Date, "now", () => now);
  const exec = t.mock.method(childProcess, "execFile", (_file, args, options, callback) => {
    const command = args.slice(1);
    commands.push({ command, timeout: options.timeout });
    now += 40;
    const result = command[1] === "list" ? { plugins: [] }
      : command[1] === "marketplace" && command[2] === "list" ? { marketplaces: [] }
        : { ok: true };
    queueMicrotask(() => callback(null, JSON.stringify(result), ""));
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      installCuratedCodexPluginResource({
        homeDir: sharedHome, id: "claude-mem", executable: process.execPath,
        codexCliArgsPrefix: [sharedFixture.cli], env: sharedFixture.env, timeoutMs: 90,
      }),
      { code: "curated_plugin_timeout" },
    );
    assert.deepEqual(commands.map(({ timeout }) => timeout), [90, 50, 10]);
    assert.deepEqual(commands.map(({ command }) => command.slice(0, 3)), [
      ["plugin", "list", "--json"],
      ["plugin", "marketplace", "list"],
      ["plugin", "marketplace", "add"],
    ]);
  } finally {
    exec.mock.restore();
    clock.mock.restore();
    syncBuiltinESMExports();
  }
});

test("curated plugin installation rejects a same-name marketplace from another repository before mutation", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "curated-plugin-collision-"));
  const fixture = fakeCodex(homeDir);
  const marketplaces = JSON.parse(fs.readFileSync(fixture.marketplaceState, "utf8"));
  marketplaces[0].marketplaceSource.source = "https://github.com/attacker/cowart.git";
  fs.writeFileSync(fixture.marketplaceState, JSON.stringify(marketplaces), "utf8");

  await assert.rejects(
    installCuratedCodexPluginResource({
      homeDir, id: "cowart", executable: process.execPath,
      codexCliArgsPrefix: [fixture.cli], env: fixture.env,
    }),
    /curated_plugin_marketplace_source_mismatch/u,
  );
  const calls = fs.readFileSync(fixture.log, "utf8").trim().split(/\r?\n/u).map(JSON.parse);
  assert.deepEqual(calls, [
    ["plugin", "list", "--json"],
    ["plugin", "marketplace", "list", "--json"],
  ]);
});

test("retired curated-plugin operations are not registered or exposed to the renderer", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const main = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(root, "desktop", "preload.cjs"), "utf8");
  const app = fs.readFileSync(path.join(root, "desktop", "renderer", "app.js"), "utf8");
  for (const route of ["curatedPlugin:list", "curatedPlugin:runTask"]) {
    assert.equal(main.includes(`ipcMain.handle("${route}"`), false);
  }
  assert.doesNotMatch(main, /ipcMain\.handle\("curatedPlugin:(?:install|remove)"/u);
  let exposed;
  runInNewContext(preload, { process: { platform: "win32" }, require: name => {
    assert.equal(name, "electron");
    return { contextBridge: { exposeInMainWorld(_name, api) { exposed = api; } }, ipcRenderer: {} };
  } });
  assert.equal(typeof exposed.startSoftwareManagerTask, "function");
  assert.equal(Object.hasOwn(exposed, "listCuratedCodexPlugins"), false);
  assert.equal(Object.hasOwn(exposed, "runCuratedCodexPluginTask"), false);
  assert.match(app, /selectedPluginIds/u);
  const softwareManagement = app.slice(app.indexOf("async function ensureSoftwareManagerLoaded"), app.indexOf("softwareManagerRoot?.addEventListener"));
  assert.ok(softwareManagement.length > 0);
  assert.doesNotMatch(softwareManagement, /api\.(?:runCuratedCodexPluginTask|listCuratedCodexPlugins)/u);
});
