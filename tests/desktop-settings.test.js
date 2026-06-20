import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MODE_ALL_API,
  MODE_HYBRID,
  applyCodexConfig,
  buildCodexToml,
  detectModeFromConfig,
  ensureRouterConfig,
  saveSecrets,
  secretStatus,
} from "../desktop/settings.mjs";

test("detectModeFromConfig distinguishes all-api and hybrid", () => {
  assert.equal(detectModeFromConfig({}), MODE_ALL_API);
  assert.equal(
    detectModeFromConfig({ clientAuth: { allowOpenAiBearer: true } }),
    MODE_HYBRID,
  );
});

test("buildCodexToml uses local token in all-api mode", () => {
  const toml = buildCodexToml({
    rootDir: "F:\\game_code\\router",
    mode: MODE_ALL_API,
    port: 15722,
  });

  assert.match(toml, /experimental_bearer_token = "sk-local-codex-router"/);
  assert.doesNotMatch(toml, /requires_openai_auth/);
  assert.match(toml, /model_catalog_json = "F:\/game_code\/router\/model-catalog.json"/);
});

test("buildCodexToml uses OpenAI auth in hybrid mode", () => {
  const toml = buildCodexToml({
    rootDir: "F:\\game_code\\router",
    mode: MODE_HYBRID,
    port: 15722,
  });

  assert.match(toml, /requires_openai_auth = true/);
  assert.doesNotMatch(toml, /experimental_bearer_token/);
});

test("saveSecrets records only non-empty values", () => {
  const rootDir = makeTempProject();
  saveSecrets(rootDir, {
    FENNO_API_KEY: "  gpt-key  ",
    DEEPSEEK_API_KEY: "",
    MOONSHOT_API_KEY: "kimi-key",
  });

  assert.deepEqual(secretStatus(rootDir), {
    FENNO_API_KEY: true,
    DEEPSEEK_API_KEY: false,
    MOONSHOT_API_KEY: true,
  });

  saveSecrets(rootDir, {
    FENNO_API_KEY: "",
    DEEPSEEK_API_KEY: "deepseek-key",
    MOONSHOT_API_KEY: "",
  });

  assert.deepEqual(secretStatus(rootDir), {
    FENNO_API_KEY: true,
    DEEPSEEK_API_KEY: true,
    MOONSHOT_API_KEY: true,
  });
});

test("ensureRouterConfig copies the selected example", () => {
  const rootDir = makeTempProject();
  fs.mkdirSync(path.join(rootDir, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "config", "router.config.example.json"),
    '{"clientAuth":{"allowOpenAiBearer":false},"models":[{"id":"a"}]}',
  );
  fs.writeFileSync(
    path.join(rootDir, "config", "router.config.hybrid.example.json"),
    '{"clientAuth":{"allowOpenAiBearer":true},"models":[{"id":"b"}]}',
  );

  ensureRouterConfig(rootDir, MODE_HYBRID);
  const copied = JSON.parse(
    fs.readFileSync(path.join(rootDir, "config", "router.config.json"), "utf8"),
  );
  assert.equal(copied.clientAuth.allowOpenAiBearer, true);
});

test("ensureRouterConfig can copy bundled templates into a separate data directory", () => {
  const dataRootDir = makeTempProject();
  const templateRootDir = makeTempProject();
  fs.mkdirSync(path.join(templateRootDir, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(templateRootDir, "config", "router.config.example.json"),
    '{"clientAuth":{"allowOpenAiBearer":false},"models":[{"id":"api"}]}',
  );
  fs.writeFileSync(
    path.join(templateRootDir, "config", "router.config.hybrid.example.json"),
    '{"clientAuth":{"allowOpenAiBearer":true},"models":[{"id":"hybrid"}]}',
  );

  const target = ensureRouterConfig(dataRootDir, MODE_HYBRID, templateRootDir);
  const copied = JSON.parse(fs.readFileSync(target, "utf8"));

  assert.equal(target, path.join(dataRootDir, "config", "router.config.json"));
  assert.equal(copied.models[0].id, "hybrid");
});

test("applyCodexConfig writes config and creates backup", () => {
  const rootDir = makeTempProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const target = path.join(codexDir, "config.toml");
  fs.writeFileSync(target, 'model = "old"\n', "utf8");

  const result = applyCodexConfig({
    rootDir,
    mode: MODE_HYBRID,
    homeDir,
  });

  const written = fs.readFileSync(target, "utf8");
  assert.match(written, /requires_openai_auth = true/);
  assert.equal(result.target, target);
  assert.equal(fs.existsSync(result.backup), true);
});

function makeTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-test-"));
}
